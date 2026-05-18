/**
 * Ascend backend — Cloudflare Worker
 * Handles Plaid Link, transaction sync, Anthropic proxy, and encrypted token storage.
 *
 * Secrets required (set via `wrangler secret put NAME`):
 *   PLAID_CLIENT_ID    - from Plaid dashboard
 *   PLAID_SECRET       - from Plaid dashboard (use the one for your env: sandbox/development/production)
 *   PLAID_ENV          - "sandbox" | "development" | "production"
 *   ENROLLMENT_KEY     - random shared key new devices use ONCE to register; pick something you can paste
 *                        once during initial app setup, then forget. (Legacy name: API_KEY — still accepted.)
 *   ENCRYPTION_KEY     - base64 32-byte key for AES-GCM (run `openssl rand -base64 32`)
 *   ALLOWED_ORIGIN     - e.g. https://your-app.netlify.app (CORS origin for the PWA; "*" allowed but not recommended)
 *   ANTHROPIC_KEY      - optional; sk-ant-... key for AI insights. If unset, /anthropic/messages returns 503.
 *   ANTHROPIC_DAILY_CAP - optional; integer, max LLM calls per user per day (default 50)
 *
 * KV binding:
 *   ASCEND_KV          - the namespace this worker reads/writes
 *
 * Auth model:
 *   - Each device enrolls once: POST /enroll with `Authorization: Bearer <ENROLLMENT_KEY>` and
 *     body { userId }. The worker mints a per-device clientSecret (32 random bytes, hex) server-side,
 *     stores SHA-256 of it at u:<userId>:auth, and returns the secret in the response for the
 *     client to persist. Any clientSecret in the request body is ignored — the worker controls all
 *     issued credentials so a malicious client can't choose a low-entropy or pre-known value.
 *   - All other endpoints require `Authorization: Bearer <userId>:<clientSecret>`. Worker derives the
 *     userId from the auth header, ignoring any userId in the request body (prevents spoofing).
 *   - Audit log is written to u:<userId>:audit (capped JSON array of recent events). Audit entries
 *     include a 12-char SHA-256 prefix of the requesting IP + truncated UA so a user can spot
 *     "this didn't come from my device" without the operator storing raw PII.
 *
 * Recovery model (intentional limitation):
 *   - There is NO server-side recovery for a lost clientSecret. The worker stores only its
 *     SHA-256; it cannot regenerate the original. If a user loses the secret on every device,
 *     they re-enroll, get a new userId+secret, and the new userId has no link to the old one.
 *     The old userId's KV entries (encrypted Plaid access tokens, audit log, etc.) orphan
 *     until the operator manually cleans them up — they are NOT visible from the new account.
 *   - To rotate a compromised secret while still possessing it: call /account DELETE (revokes
 *     Plaid items + nukes KV), then /enroll again.
 *   - To migrate to a new device while keeping bank links: export the secret out-of-band (the
 *     frontend offers an "Export device key" flow under Settings → Bank sync).
 */

const PLAID_HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const AUDIT_KEEP = 200;                    // last N audit events per user
const DEFAULT_LLM_DAILY_CAP_PER_FEATURE = 50;  // calls per user per day, per `feature` tag
const DEFAULT_LLM_BURST_CAP_PER_MIN = 10;      // calls per user per minute, across all features
const WEBHOOK_KEEP_DAYS = 30;              // Plaid webhook events expire after N days

// Back-compat alias — keep until any external reference is removed.
const DEFAULT_LLM_CAP = DEFAULT_LLM_DAILY_CAP_PER_FEATURE;
const DEFAULT_LLM_BURST = DEFAULT_LLM_BURST_CAP_PER_MIN;

export default {
  // ============ Scheduled handler ============
  // Cron-triggered (see [triggers] in wrangler.toml). Runs every 15min,
  // scans every user with a push subscription + schedule, and delivers any
  // pushes whose target HH:MM has arrived in the user's local clock window.
  // Idles cheaply when nothing's due.
  async scheduled(event, env, ctx) {
    try { await deliverScheduledPushes(env); }
    catch (e) { console.error("scheduled push delivery failed:", e && e.stack || e); }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Origin handling — never fall back to wildcard. The default is the
    // production PWA URL; operators can override via ALLOWED_ORIGIN. If the
    // operator explicitly sets ALLOWED_ORIGIN="*" we honor it (e.g. for
    // sandbox / dev environments) but log a warning on every health check.
    // Browsers send Origin on cross-origin requests; same-origin or
    // non-browser clients (curl, native apps) omit it and bypass — the
    // bearer token remains the real security boundary.
    const DEFAULT_ALLOWED = "https://life-hack-app.vercel.app";
    const allowed = (env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN.trim()) || DEFAULT_ALLOWED;
    const reqOrigin = request.headers.get("Origin") || "";

    // For ACAO header purposes: if the request's Origin matches the
    // operator's allowlist (single value today; could become a Set), echo it
    // back. Otherwise echo the operator's canonical origin. Never echo a
    // foreign origin wholesale — that's what "Allow-Origin: *" used to do
    // and it's the worst of both worlds (no isolation, no auth headers).
    const respOrigin = (allowed === "*")
      ? (reqOrigin || "*")
      : (reqOrigin && reqOrigin === allowed ? allowed : allowed);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(respOrigin) });
    }

    // Origin enforcement: if a browser sends Origin and it doesn't match
    // ALLOWED_ORIGIN (and ALLOWED_ORIGIN isn't "*"), reject with 403.
    // Non-browser clients (no Origin header) bypass — bearer is the
    // security boundary there.
    if (allowed !== "*" && reqOrigin && reqOrigin !== allowed) {
      return json({ error: "origin not allowed", code: "origin_denied" }, 403, respOrigin);
    }

    // Public endpoints
    if (url.pathname === "/" || url.pathname === "/health") {
      const payload = { ok: true, service: "ascend-backend", version: "v3" };
      // Surface a warning if the operator explicitly set ALLOWED_ORIGIN to "*".
      // This is sometimes legitimate (sandbox env) but it disables the
      // CORS check so it should be intentional and visible.
      if (allowed === "*") {
        payload.warning = "ALLOWED_ORIGIN is '*' — disable in prod by setting it to your PWA URL.";
      }
      return json(payload, 200, respOrigin);
    }

    // Plaid webhook receiver — Plaid POSTs here with no auth header; it signs
    // requests via Plaid-Verification JWT. We do a structural validation (must
    // look like a Plaid webhook and reference an item_id we know about) and
    // store the latest event keyed by item_id. The client surfaces these on
    // the next /items call so the user can see "reconnect bank X" without us
    // needing a push channel. Returns 200 even on validation failure so Plaid
    // doesn't retry forever on bad data.
    if (url.pathname === "/webhook" && request.method === "POST") {
      return await handlePlaidWebhook(request, env);
    }

    // Public push-availability probe — the frontend uses this to decide
    // whether to even show the "enable background push" CTA, BEFORE the
    // user has enrolled. Returns only the public key (which is fine to
    // expose — that's literally what makes it the public key) plus a
    // boolean for whether the backend has all three VAPID secrets set.
    if (url.pathname === "/push/vapid-public-key" && request.method === "GET") {
      return json({
        ok: true,
        key: env.VAPID_PUBLIC_KEY || null,
        enabled: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT),
      }, 200, respOrigin);
    }

    // Capture request start for access-log latency. The log line is emitted
    // once per request below — success, error, or 404 — so every authed
    // request produces exactly one structured log entry.
    const _t0 = Date.now();
    let _loggedUserId = null;

    // Pre-compute the audit-meta bag for this request. IP is hashed (PII),
    // UA is truncated. Audit entries that need device-correlation get this
    // appended; entries that don't (e.g., enrollment) skip it. Computed once
    // per request to avoid hashing the same IP on every audited() call.
    const _ip = (request.headers.get("CF-Connecting-IP")
              || request.headers.get("X-Real-IP")
              || (request.headers.get("X-Forwarded-For") || "").split(",")[0]
              || "").trim().slice(0, 64);
    const _ipHash = _ip ? await sha256hex(_ip).then(h => h.slice(0, 12)).catch(() => "") : "";
    const _ua = (request.headers.get("User-Agent") || "").slice(0, 60);
    const _reqMeta = (_ipHash || _ua) ? { ipHash: _ipHash, ua: _ua } : undefined;

    // Inner dispatcher returns a Response; outer wrapper logs and returns.
    let response;
    try {
      response = await (async () => {
        const auth = await checkAuth(request, env, url);
        if (auth.error) return json({ error: auth.error, code: "unauthorized" }, auth.status || 401, respOrigin);
        if (auth.mode === "user") _loggedUserId = auth.userId;

        // Enrollment is gated by ENROLLMENT_KEY only. For consumer releases
        // that ship the key in publicly-served JS, the security boundary is
        // a per-IP rate limit — a leaked key without abuse capacity can only
        // create new isolated user records, never read existing ones.
        if (url.pathname === "/enroll" && request.method === "POST") {
          if (auth.mode !== "enrollment") return json({ error: "enrollment key required", code: "unauthorized" }, 401, respOrigin);
          const limited = await _enrollRateGate(request, env, respOrigin);
          if (limited) return limited;
          return await handleEnroll(request, env, respOrigin);
        }

        // Everything else needs a real user identity
        if (auth.mode !== "user") {
          return json({ error: "user authentication required (enroll first)", code: "unauthorized" }, 401, respOrigin);
        }
        const userId = auth.userId;

        if (url.pathname === "/link/token" && request.method === "POST") {
          return await audited(env, userId, "link_token",
            () => handleLinkToken(env, userId, respOrigin), _reqMeta);
        }
        if (url.pathname === "/exchange" && request.method === "POST") {
          return await audited(env, userId, "exchange",
            () => handleExchange(request, env, userId, respOrigin), _reqMeta);
        }
        if (url.pathname === "/sync" && request.method === "POST") {
          return await audited(env, userId, "sync",
            () => handleSync(env, userId, respOrigin), _reqMeta);
        }
        if (url.pathname === "/holdings" && request.method === "POST") {
          return await audited(env, userId, "holdings",
            () => handleHoldings(env, userId, respOrigin), _reqMeta);
        }
        if (url.pathname === "/liabilities" && request.method === "POST") {
          return await audited(env, userId, "liabilities",
            () => handleLiabilities(env, userId, respOrigin), _reqMeta);
        }
        if (url.pathname === "/recurring" && request.method === "POST") {
          return await audited(env, userId, "recurring",
            () => handleRecurring(env, userId, respOrigin), _reqMeta);
        }
        if (url.pathname === "/investment-transactions" && request.method === "POST") {
          return await audited(env, userId, "investment_transactions",
            () => handleInvestmentTransactions(request, env, userId, respOrigin), _reqMeta);
        }
        if (url.pathname === "/items" && request.method === "GET") {
          return await handleItems(env, userId, respOrigin);
        }
        if (url.pathname.startsWith("/item/") && request.method === "DELETE") {
          return await audited(env, userId, "item_remove",
            () => handleRemoveItem(url, env, userId, respOrigin), _reqMeta);
        }
        if (url.pathname === "/anthropic/messages" && request.method === "POST") {
          return await handleAnthropic(request, env, userId, respOrigin);
        }
        if (url.pathname === "/audit" && request.method === "GET") {
          return await handleAuditList(env, userId, respOrigin);
        }
        if (url.pathname === "/account" && request.method === "DELETE") {
          return await handleDeleteAccount(env, userId, respOrigin);
        }
        // ----- Push notifications -----
        // (vapid-public-key is handled above as a public endpoint so the
        // frontend can probe push availability before enrolling.)
        if (url.pathname === "/push/subscribe" && request.method === "POST") {
          return await audited(env, userId, "push_subscribe",
            () => handlePushSubscribe(request, env, userId, respOrigin), _reqMeta);
        }
        if (url.pathname === "/push/unsubscribe" && request.method === "POST") {
          return await audited(env, userId, "push_unsubscribe",
            () => handlePushUnsubscribe(env, userId, respOrigin), _reqMeta);
        }
        if (url.pathname === "/push/test" && request.method === "POST") {
          return await audited(env, userId, "push_test",
            () => handlePushTest(env, userId, respOrigin), _reqMeta);
        }
        if (url.pathname === "/push/send" && request.method === "POST") {
          return await audited(env, userId, "push_send",
            () => handlePushSend(request, env, userId, respOrigin), _reqMeta);
        }
        return json({ error: "not found", code: "not_found" }, 404, respOrigin);
      })();
    } catch (err) {
      // safeError logs the full context + stack to console.error (visible in
      // wrangler tail / dashboard) and returns a generic message to the
      // client. Never echo upstream Plaid/Anthropic messages — they leak
      // endpoint paths, request IDs, and in rare 401 variants secret tails.
      response = json(safeError(err, { route: url.pathname, method: request.method }), 500, respOrigin);
    }

    // Emit one structured access log line per request. Logging must never
    // affect the response — if it throws somehow, we still return the response.
    try {
      await _accessLog(env, {
        userId: _loggedUserId,
        route: url.pathname,
        method: request.method,
        status: response.status,
        elapsedMs: Date.now() - _t0,
      });
    } catch { /* swallow */ }
    return response;
  },
};

// ============ Auth ============

async function checkAuth(request, env, url) {
  const raw = request.headers.get("Authorization") || "";
  const m = raw.match(/^Bearer\s+(.+)$/);
  if (!m) return { error: "unauthorized", status: 401 };
  const token = m[1];

  // Enrollment key. Prefer ENROLLMENT_KEY; accept legacy API_KEY as a
  // deprecated alias and warn so the operator notices and migrates.
  // (Removing API_KEY entirely would break existing deployments that
  // haven't been re-secret-set with the new name.)
  const enrollKey = env.ENROLLMENT_KEY || env.API_KEY || "";
  if (enrollKey && timingSafeEqStr(token, enrollKey)) {
    if (!env.ENROLLMENT_KEY && env.API_KEY) {
      try { console.warn("[deprecated_secret] API_KEY is deprecated — rename to ENROLLMENT_KEY"); } catch {}
    }
    return { mode: "enrollment" };
  }

  // userId:secret format
  const split = token.indexOf(":");
  if (split <= 0) return { error: "unauthorized", status: 401 };
  const userId = token.slice(0, split);
  const secret = token.slice(split + 1);
  if (!/^u_[A-Za-z0-9_-]+$/.test(userId) || !secret) {
    return { error: "unauthorized", status: 401 };
  }
  const storedHash = await env.ASCEND_KV.get(`u:${userId}:auth`);
  if (!storedHash) return { error: "user not enrolled", status: 401 };
  const presentedHash = await sha256hex(secret);
  if (!timingSafeEqStr(presentedHash, storedHash)) {
    return { error: "unauthorized", status: 401 };
  }
  return { mode: "user", userId };
}

function timingSafeEqStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ----- base64url helpers (used by JWT verification) -----
function b64urlToBytes(s) {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToText(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

// ----- Plaid webhook JWT verification -----
// Validates the Plaid-Verification JWT against Plaid's webhook signing key
// set. Returns the decoded payload on success; throws on any failure (bad
// alg, missing kid, signature mismatch, body hash mismatch, stale iat).
// JWK cache lives in KV under `plaid:verify_key:<kid>` with 24h TTL so
// most webhooks don't pay the /webhook_verification_key/get roundtrip.
async function verifyPlaidWebhookJWT(env, rawBody, jwt) {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [headerB64, payloadB64, sigB64] = parts;

  let header;
  try { header = JSON.parse(b64urlToText(headerB64)); }
  catch { throw new Error("invalid JWT header"); }
  if (header.alg !== "ES256") throw new Error("alg must be ES256, got " + header.alg);
  if (!header.kid || typeof header.kid !== "string") throw new Error("missing kid");
  // kid is used as a KV key suffix and a Plaid API parameter; sanitize defensively.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)) throw new Error("invalid kid format");

  const jwk = await getPlaidVerificationKey(env, header.kid);
  if (jwk.expired_at) throw new Error("key is expired");

  // Import the EC public key (P-256) and verify the ES256 signature over
  // `<header_b64>.<payload_b64>`. JWT ES256 sig is raw r||s (64 bytes),
  // which is exactly what crypto.subtle.verify(ECDSA, SHA-256) expects.
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, alg: "ES256", use: "sig", ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const sig = b64urlToBytes(sigB64);
  if (sig.length !== 64) throw new Error("signature wrong length");
  const signedData = new TextEncoder().encode(headerB64 + "." + payloadB64);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    sig,
    signedData
  );
  if (!ok) throw new Error("signature did not verify");

  let payload;
  try { payload = JSON.parse(b64urlToText(payloadB64)); }
  catch { throw new Error("invalid JWT payload"); }

  // Replay protection: reject anything signed more than 5 minutes ago (or
  // more than 5 minutes in the future, which would mean clock skew).
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== "number" || Math.abs(now - payload.iat) > 5 * 60) {
    throw new Error("iat outside freshness window");
  }
  // Body integrity: payload.request_body_sha256 must match the SHA-256 hex
  // of the raw request body we just received.
  const bodyHash = await sha256hex(rawBody);
  if (payload.request_body_sha256 !== bodyHash) {
    throw new Error("body hash mismatch");
  }
  return payload;
}

// Fetches a JWK from Plaid by key_id, caching the result in KV for 24h.
// Plaid rotates these keys infrequently; once a kid has been seen we avoid
// a network roundtrip on every webhook. Expired keys are never cached.
async function getPlaidVerificationKey(env, kid) {
  const cacheKey = `plaid:verify_key:${kid}`;
  try {
    const cached = await env.ASCEND_KV.get(cacheKey);
    if (cached) {
      const jwk = JSON.parse(cached);
      if (jwk && jwk.alg === "ES256" && jwk.x && jwk.y) return jwk;
    }
  } catch {}

  const host = PLAID_HOSTS[env.PLAID_ENV] || PLAID_HOSTS.sandbox;
  const r = await fetch(host + "/webhook_verification_key/get", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      key_id: kid,
    }),
  });
  if (!r.ok) throw new Error("key lookup failed: HTTP " + r.status);
  const data = await r.json();
  const jwk = data && data.key;
  if (!jwk || jwk.alg !== "ES256" || !jwk.x || !jwk.y) {
    throw new Error("malformed key response");
  }
  // Only cache when Plaid hasn't already marked the key as expired.
  if (!jwk.expired_at) {
    try {
      await env.ASCEND_KV.put(cacheKey, JSON.stringify(jwk), { expirationTtl: 60 * 60 * 24 });
    } catch {}
  }
  return jwk;
}

async function sha256hex(s) {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// Reject oversized request bodies before parsing — protects the worker's
// CPU budget against a stolen-secret client shipping garbage MB. Routes
// that accept structured bodies set a higher ceiling (Anthropic: 1MB).
// Routes with no body or small bodies use the default 10KB.
function _bodyTooLarge(request, maxBytes = 10_000) {
  const cl = parseInt(request.headers.get("content-length") || "0", 10) || 0;
  if (cl > maxBytes) return true;
  return false;
}

// ============ Endpoint handlers ============

async function handleEnroll(request, env, origin) {
  if (_bodyTooLarge(request)) return json({ error: "request body too large", code: "payload_too_large" }, 413, origin);
  const body = await request.json().catch(() => ({}));
  const userId = String(body.userId || "").trim();
  if (!/^u_[A-Za-z0-9_-]+$/.test(userId)) return json({ error: "invalid userId", code: "validation_error" }, 400, origin);

  // Mint the per-device secret server-side so the worker (not the client)
  // controls the entropy of every issued credential. 32 bytes = 256 bits,
  // hex-encoded = 64 chars. Any clientSecret in the request body is ignored.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let clientSecret = "";
  for (let i = 0; i < bytes.length; i++) clientSecret += bytes[i].toString(16).padStart(2, "0");

  const hash = await sha256hex(clientSecret);
  await env.ASCEND_KV.put(`u:${userId}:auth`, hash);
  await appendAudit(env, userId, "enroll");
  return json({ ok: true, userId, clientSecret }, 200, origin);
}

async function handleLinkToken(env, userId, origin) {
  // /link/token is the start of a Plaid Link flow. Users rarely launch this
  // more than a couple times per session; a stolen secret looping it would
  // burn Plaid's link-creation quota.
  const limited = await _userRateGate(env, userId, "link_token", 10, origin, 30);
  if (limited) return limited;
  const params = {
    user: { client_user_id: userId },
    client_name: "Ascend",
    // `products` is required at link time and restricts institutions to those
    // that support every product. Keep this universal — transactions covers
    // every bank.
    products: ["transactions"],
    // `optional_products` get pulled when the institution supports them, but
    // don't restrict the link. Liabilities = credit card APRs, mortgage
    // terms, student loan details. Investments = brokerage holdings + trades.
    // Banks that don't support these will still link successfully.
    optional_products: ["liabilities", "investments"],
    country_codes: ["US"],
    language: "en",
  };
  // Wire Plaid up to our /webhook endpoint when WEBHOOK_URL is set. Plaid will
  // POST ITEM_ERROR / PENDING_EXPIRATION / USER_PERMISSION_REVOKED events here.
  if (env.WEBHOOK_URL) params.webhook = env.WEBHOOK_URL;
  const r = await plaidCall(env, "/link/token/create", params);
  return json({ ok: true, link_token: r.link_token, expiration: r.expiration }, 200, origin);
}

async function handleExchange(request, env, userId, origin) {
  // /exchange happens once per institution-link. 5/hour leaves room for
  // retries on flaky links without enabling a stolen-secret abuse loop.
  const limited = await _userRateGate(env, userId, "exchange", 5, origin, 20);
  if (limited) return limited;
  if (_bodyTooLarge(request)) return json({ error: "request body too large", code: "payload_too_large" }, 413, origin);
  const body = await request.json().catch(() => ({}));
  const publicToken = String(body.public_token || "").trim();
  // Cap institutionName so a stolen secret can't bloat KV (returned on every
  // /items call). Real bank names are well under 100 chars.
  const institutionName = String(body.institution_name || "Bank").trim().slice(0, 120);
  if (!publicToken) return json({ error: "public_token required", code: "validation_error" }, 400, origin);
  // Plaid public_tokens are roughly "public-<env>-<uuid>" — bound the length
  // before we ship to upstream. Generous ceiling (Plaid tokens are ~80 chars).
  if (publicToken.length > 200) return json({ error: "public_token too long", code: "validation_error" }, 400, origin);

  const r = await plaidCall(env, "/item/public_token/exchange", { public_token: publicToken });
  const accessToken = r.access_token;
  const itemId = r.item_id;

  const ciphertext = await encryptString(accessToken, env.ENCRYPTION_KEY);
  const itemRecord = {
    itemId,
    institutionName,
    accessTokenCipher: ciphertext,
    cursor: null,
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
  };
  await env.ASCEND_KV.put(itemKey(userId, itemId), JSON.stringify(itemRecord));
  await addItemToIndex(env, userId, itemId);

  return json({ ok: true, item_id: itemId, institution_name: institutionName }, 200, origin);
}

// Per-invocation Plaid-call budget. Workers free tier gives ~30s CPU; a
// user with 8 linked items × 10 cursor pages × ~200ms/Plaid call exceeds
// that. When we hit the budget, we save the cursor and let the client call
// /sync again to pick up where we left off. SYNC_TRUNCATED in the response
// tells the client there's more.
const SYNC_PLAID_CALL_BUDGET = 40;

async function handleSync(env, userId, origin) {
  // /sync is the hottest Plaid endpoint — each call can do up to 40 upstream
  // Plaid API calls (SYNC_PLAID_CALL_BUDGET) across all linked items. A
  // stolen secret looping /sync would burn the operator's Plaid quota fast.
  // 10/hour leaves slack for foreground+background refreshes; 60/day caps
  // sustained abuse. Normal users sync 1-3x per app-open.
  const limited = await _userRateGate(env, userId, "sync", 10, origin, 60);
  if (limited) return limited;
  const itemIds = await getItemIndex(env, userId);
  const allTx = [];
  const allAccounts = [];
  const removedTxIds = [];   // Plaid transaction_ids the bank now reports as removed
  const updated = [];
  let plaidCallsUsed = 0;
  let truncated = false;

  for (const itemId of itemIds) {
    if (plaidCallsUsed >= SYNC_PLAID_CALL_BUDGET) { truncated = true; break; }
    const recRaw = await env.ASCEND_KV.get(itemKey(userId, itemId));
    if (!recRaw) continue;
    const rec = JSON.parse(recRaw);
    let accessToken;
    try {
      accessToken = await decryptString(rec.accessTokenCipher, env.ENCRYPTION_KEY);
    } catch {
      continue; // skip if undecryptable (key mismatch)
    }
    // Migration: backfill the reverse index for items enrolled before the
    // item-owner record existed. Idempotent + no-op for new items.
    try {
      const existing = await env.ASCEND_KV.get(`item-owner:${itemId}`);
      if (existing !== userId) await env.ASCEND_KV.put(`item-owner:${itemId}`, userId);
    } catch {}

    // Pull accounts
    try {
      plaidCallsUsed++;
      const a = await plaidCall(env, "/accounts/get", { access_token: accessToken });
      a.accounts.forEach((acct) => {
        allAccounts.push({
          item_id: itemId,
          institution_name: rec.institutionName,
          account_id: acct.account_id,
          name: acct.name,
          official_name: acct.official_name,
          type: acct.type,
          subtype: acct.subtype,
          mask: acct.mask,
          balance_current: acct.balances.current,
          balance_available: acct.balances.available,
          iso_currency_code: acct.balances.iso_currency_code,
        });
      });
    } catch (e) { /* keep going */ }

    // Cursor-based transactions sync (Plaid /transactions/sync)
    let cursor = rec.cursor || null;
    let hasMore = true;
    let added = [], modified = [], removed = [];
    let safety = 0;
    while (hasMore && safety++ < 10 && plaidCallsUsed < SYNC_PLAID_CALL_BUDGET) {
      plaidCallsUsed++;
      const t = await plaidCall(env, "/transactions/sync", {
        access_token: accessToken,
        cursor: cursor || undefined,
        count: 250,
      });
      added = added.concat(t.added || []);
      modified = modified.concat(t.modified || []);
      removed = removed.concat(t.removed || []);
      cursor = t.next_cursor;
      hasMore = !!t.has_more;
    }
    // Mark truncated if Plaid still had more for this item but we ran out of budget.
    if (hasMore && plaidCallsUsed >= SYNC_PLAID_CALL_BUDGET) truncated = true;
    rec.cursor = cursor;
    rec.lastSyncAt = new Date().toISOString();
    await env.ASCEND_KV.put(itemKey(userId, itemId), JSON.stringify(rec));

    [...added, ...modified].forEach((tx) => {
      allTx.push({
        item_id: itemId,
        institution_name: rec.institutionName,
        transaction_id: tx.transaction_id,
        account_id: tx.account_id,
        date: tx.date,
        authorized_date: tx.authorized_date,
        name: tx.name,
        merchant_name: tx.merchant_name,
        amount: tx.amount, // positive = outflow in Plaid convention
        iso_currency_code: tx.iso_currency_code,
        category: tx.personal_finance_category?.primary || (tx.category ? tx.category[0] : null),
        category_detailed: tx.personal_finance_category?.detailed,
        pending: tx.pending,
        payment_channel: tx.payment_channel,
      });
    });

    // Forward removed transaction IDs to the client so it can delete the
    // corresponding rows from DB.spend. Without this, transactions Plaid
    // cancels/refunds stay in the local DB forever (ghost rows that no
    // longer reconcile with the bank statement).
    for (const r of removed) {
      if (r && r.transaction_id) removedTxIds.push(r.transaction_id);
    }

    updated.push({ item_id: itemId, added: added.length, modified: modified.length, removed: removed.length });
  }

  return json({ ok: true, accounts: allAccounts, transactions: allTx, removed_transaction_ids: removedTxIds, updated, truncated }, 200, origin);
}

async function handleItems(env, userId, origin) {
  // /items doesn't hit Plaid, just reads KV — cheap. But a stolen secret
  // polling it tightly would still be wasteful. 60/hour ≈ once per minute.
  const limited = await _userRateGate(env, userId, "items", 60, origin);
  if (limited) return limited;
  const itemIds = await getItemIndex(env, userId);
  const items = [];
  for (const itemId of itemIds) {
    const raw = await env.ASCEND_KV.get(itemKey(userId, itemId));
    if (!raw) continue;
    const r = JSON.parse(raw);
    // Pull the most recent Plaid webhook for this item, if any. The client
    // uses this to surface "reconnect bank" prompts when an item breaks.
    let webhook = null;
    try {
      const whRaw = await env.ASCEND_KV.get(`webhook:${itemId}`);
      if (whRaw) webhook = JSON.parse(whRaw);
    } catch { /* ignore */ }
    items.push({
      item_id: r.itemId,
      institution_name: r.institutionName,
      created_at: r.createdAt,
      last_sync_at: r.lastSyncAt,
      webhook,
    });
  }
  return json({ ok: true, items }, 200, origin);
}

async function handleRemoveItem(url, env, userId, origin) {
  // Item removal is rare (user disconnects a bank) but irreversible from the
  // backend's perspective (the encrypted access token is gone). 5/hour gives
  // slack for retries without enabling rapid-fire data loss.
  const limited = await _userRateGate(env, userId, "item_remove", 5, origin, 20);
  if (limited) return limited;
  // decodeURIComponent throws URIError on malformed escapes like "%FF" —
  // surface as a 400 instead of letting it bubble into a 500 with a
  // confusing internal message.
  let itemId;
  try { itemId = decodeURIComponent(url.pathname.split("/").pop() || ""); }
  catch { return json({ error: "malformed itemId", code: "validation_error" }, 400, origin); }
  if (!itemId) return json({ error: "itemId required", code: "validation_error" }, 400, origin);
  // Tighten to the format Plaid actually uses (the audit was right that we
  // were passing arbitrary URL fragments into KV keys).
  if (!/^[A-Za-z0-9_\-]{1,80}$/.test(itemId)) return json({ error: "invalid itemId format", code: "validation_error" }, 400, origin);

  const raw = await env.ASCEND_KV.get(itemKey(userId, itemId));
  if (raw) {
    const rec = JSON.parse(raw);
    try {
      const accessToken = await decryptString(rec.accessTokenCipher, env.ENCRYPTION_KEY);
      await plaidCall(env, "/item/remove", { access_token: accessToken });
    } catch { /* still proceed to delete */ }
    await env.ASCEND_KV.delete(itemKey(userId, itemId));
  }
  await removeItemFromIndex(env, userId, itemId);
  // Don't leave an orphan webhook record for an item the user just disconnected
  await env.ASCEND_KV.delete(`webhook:${itemId}`);
  return json({ ok: true }, 200, origin);
}

async function handleHoldings(env, userId, origin) {
  const limited = await _userRateGate(env, userId, "holdings", 10, origin, 60);
  if (limited) return limited;
  const itemIds = await getItemIndex(env, userId);
  const allHoldings = [];
  const allSecurities = {};
  // Per-invocation Plaid-call budget — mirror handleSync's pattern so a user
  // with many linked institutions can't blow the CPU budget.
  let plaidCalls = 0;
  let truncated = false;

  for (const itemId of itemIds) {
    if (plaidCalls >= SYNC_PLAID_CALL_BUDGET) { truncated = true; break; }
    const recRaw = await env.ASCEND_KV.get(itemKey(userId, itemId));
    if (!recRaw) continue;
    const rec = JSON.parse(recRaw);
    let accessToken;
    try { accessToken = await decryptString(rec.accessTokenCipher, env.ENCRYPTION_KEY); }
    catch { continue; }

    try {
      plaidCalls++;
      const r = await plaidCall(env, "/investments/holdings/get", { access_token: accessToken });
      for (const sec of (r.securities || [])) allSecurities[sec.security_id] = sec;
      for (const h of (r.holdings || [])) {
        const sec = allSecurities[h.security_id] || {};
        allHoldings.push({
          item_id: itemId,
          institution_name: rec.institutionName,
          account_id: h.account_id,
          security_id: h.security_id,
          ticker: sec.ticker_symbol || null,
          name: sec.name || null,
          type: sec.type || null,
          quantity: h.quantity,
          cost_basis: h.cost_basis,
          institution_price: h.institution_price,
          institution_value: h.institution_value,
          iso_currency_code: h.iso_currency_code,
        });
      }
    } catch (e) { continue; }
  }

  return json({ ok: true, holdings: allHoldings, truncated }, 200, origin);
}

// Liabilities — pulls credit card APRs/min payments/statement balances, plus
// mortgage and student loan terms. Banks that don't support /liabilities/get
// (or for accounts that aren't a credit/loan type) just return nothing for
// that item, no error. Frontend pre-populates DB.debtMeta so the user
// doesn't have to type APRs.
async function handleLiabilities(env, userId, origin) {
  const limited = await _userRateGate(env, userId, "liabilities", 10, origin, 60);
  if (limited) return limited;
  const itemIds = await getItemIndex(env, userId);
  const credit = [], mortgage = [], student = [];
  let plaidCalls = 0;
  let truncated = false;

  for (const itemId of itemIds) {
    if (plaidCalls >= SYNC_PLAID_CALL_BUDGET) { truncated = true; break; }
    const recRaw = await env.ASCEND_KV.get(itemKey(userId, itemId));
    if (!recRaw) continue;
    const rec = JSON.parse(recRaw);
    let accessToken;
    try { accessToken = await decryptString(rec.accessTokenCipher, env.ENCRYPTION_KEY); }
    catch { continue; }

    try {
      plaidCalls++;
      const r = await plaidCall(env, "/liabilities/get", { access_token: accessToken });
      const liab = r.liabilities || {};
      for (const c of (liab.credit || [])) {
        // APRs from Plaid come as an array of { apr_percentage, apr_type, balance_subject_to_apr }
        // Reduce to the "purchase" APR (most representative) plus the highest APR for safety.
        const aprs = Array.isArray(c.aprs) ? c.aprs : [];
        const purchaseApr = aprs.find(a => /purchase/i.test(a.apr_type || ""));
        const maxApr = aprs.reduce((m, a) => Math.max(m, +a.apr_percentage || 0), 0);
        credit.push({
          item_id: itemId,
          institution_name: rec.institutionName,
          account_id: c.account_id,
          apr_purchase: purchaseApr ? +purchaseApr.apr_percentage || null : null,
          apr_max: maxApr || null,
          aprs: aprs.map(a => ({
            type: a.apr_type,
            pct: a.apr_percentage,
            balance: a.balance_subject_to_apr,
          })),
          last_payment_amount: c.last_payment_amount,
          last_payment_date: c.last_payment_date,
          last_statement_balance: c.last_statement_balance,
          last_statement_issue_date: c.last_statement_issue_date,
          minimum_payment_amount: c.minimum_payment_amount,
          next_payment_due_date: c.next_payment_due_date,
          is_overdue: c.is_overdue,
        });
      }
      for (const m of (liab.mortgage || [])) {
        mortgage.push({
          item_id: itemId,
          institution_name: rec.institutionName,
          account_id: m.account_id,
          interest_rate_pct: m.interest_rate && m.interest_rate.percentage,
          interest_rate_type: m.interest_rate && m.interest_rate.type,
          loan_term: m.loan_term,
          loan_type_description: m.loan_type_description,
          maturity_date: m.maturity_date,
          origination_date: m.origination_date,
          origination_principal_amount: m.origination_principal_amount,
          next_monthly_payment: m.next_monthly_payment,
          next_payment_due_date: m.next_payment_due_date,
          current_late_fee: m.current_late_fee,
          escrow_balance: m.escrow_balance,
          ytd_interest_paid: m.ytd_interest_paid,
          ytd_principal_paid: m.ytd_principal_paid,
          past_due_amount: m.past_due_amount,
          has_pmi: m.has_pmi,
          property_address: m.property_address ? {
            city: m.property_address.city,
            region: m.property_address.region,
            postal_code: m.property_address.postal_code,
          } : null,
        });
      }
      for (const s of (liab.student || [])) {
        student.push({
          item_id: itemId,
          institution_name: rec.institutionName,
          account_id: s.account_id,
          interest_rate_pct: s.interest_rate_percentage,
          loan_name: s.loan_name,
          loan_status: s.loan_status && s.loan_status.type,
          end_date: s.loan_status && s.loan_status.end_date,
          minimum_payment_amount: s.minimum_payment_amount,
          next_payment_due_date: s.next_payment_due_date,
          last_payment_amount: s.last_payment_amount,
          last_payment_date: s.last_payment_date,
          last_statement_balance: s.last_statement_balance,
          last_statement_issue_date: s.last_statement_issue_date,
          outstanding_interest_amount: s.outstanding_interest_amount,
          payment_reference_number: null, // sensitive — never forward
          repayment_plan_type: s.repayment_plan && s.repayment_plan.type,
          repayment_plan_description: s.repayment_plan && s.repayment_plan.description,
          servicer_address: s.servicer_address ? {
            city: s.servicer_address.city,
            region: s.servicer_address.region,
          } : null,
          ytd_interest_paid: s.ytd_interest_paid,
          ytd_principal_paid: s.ytd_principal_paid,
        });
      }
    } catch (e) {
      // Plaid returns 400 if the item doesn't support liabilities — fine, skip.
      continue;
    }
  }

  return json({ ok: true, credit, mortgage, student, truncated }, 200, origin);
}

// Recurring transactions — Plaid's pattern-detection across the user's
// transaction history. Returns detected paychecks (inflows) and subscriptions
// (outflows) with merchant, average amount, and frequency. The frontend
// surfaces these as "Plaid spotted these — accept to add as recurring?" so
// the user doesn't have to type Netflix, Spotify, rent, paycheck, etc.
async function handleRecurring(env, userId, origin) {
  const limited = await _userRateGate(env, userId, "recurring", 10, origin, 60);
  if (limited) return limited;
  const itemIds = await getItemIndex(env, userId);
  const inflows = [], outflows = [];
  let plaidCalls = 0;
  let truncated = false;

  for (const itemId of itemIds) {
    // Each item costs 2 Plaid calls here, so check budget conservatively.
    if (plaidCalls + 2 > SYNC_PLAID_CALL_BUDGET) { truncated = true; break; }
    const recRaw = await env.ASCEND_KV.get(itemKey(userId, itemId));
    if (!recRaw) continue;
    const rec = JSON.parse(recRaw);
    let accessToken;
    try { accessToken = await decryptString(rec.accessTokenCipher, env.ENCRYPTION_KEY); }
    catch { continue; }

    // Need account_ids for /transactions/recurring/get. Pull them inline.
    let acctIds = [];
    try {
      plaidCalls++;
      const a = await plaidCall(env, "/accounts/get", { access_token: accessToken });
      acctIds = (a.accounts || []).map(x => x.account_id);
    } catch { continue; }
    if (!acctIds.length) continue;

    try {
      plaidCalls++;
      const r = await plaidCall(env, "/transactions/recurring/get", {
        access_token: accessToken,
        account_ids: acctIds,
      });
      const mapStream = (s, isInflow) => ({
        item_id: itemId,
        institution_name: rec.institutionName,
        account_id: s.account_id,
        stream_id: s.stream_id,
        description: s.description,
        merchant_name: s.merchant_name,
        category: s.personal_finance_category?.primary || (s.category ? s.category[0] : null),
        category_detailed: s.personal_finance_category?.detailed,
        first_date: s.first_date,
        last_date: s.last_date,
        frequency: s.frequency,        // 'WEEKLY' | 'BIWEEKLY' | 'SEMI_MONTHLY' | 'MONTHLY' | 'ANNUALLY' | 'UNKNOWN'
        average_amount: s.average_amount?.amount,
        last_amount: s.last_amount?.amount,
        is_active: s.is_active,
        status: s.status,              // 'MATURE' | 'EARLY_DETECTION' | 'TOMBSTONED' | 'UNKNOWN'
        is_user_modified: s.is_user_modified,
      });
      (r.inflow_streams || []).forEach(s => inflows.push(mapStream(s, true)));
      (r.outflow_streams || []).forEach(s => outflows.push(mapStream(s, false)));
    } catch (e) { continue; }
  }

  return json({ ok: true, inflows, outflows, truncated }, 200, origin);
}

// Investment transactions — buys, sells, dividends, fees. Useful for cost
// basis tracking and realized P&L. Requires start_date and end_date; we
// accept them from the request or default to the last 90 days.
async function handleInvestmentTransactions(request, env, userId, origin) {
  const limited = await _userRateGate(env, userId, "investment_transactions", 10, origin, 60);
  if (limited) return limited;
  if (_bodyTooLarge(request)) return json({ error: "request body too large", code: "payload_too_large" }, 413, origin);
  const body = await request.json().catch(() => ({}));
  const today = new Date();
  const ninetyAgo = new Date(today); ninetyAgo.setDate(today.getDate() - 90);
  const startDate = String(body.start_date || ninetyAgo.toISOString().slice(0, 10));
  const endDate = String(body.end_date || today.toISOString().slice(0, 10));
  // Validate ISO YYYY-MM-DD
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(startDate) || !dateRe.test(endDate)) {
    return json({ error: "start_date and end_date must be YYYY-MM-DD", code: "validation_error" }, 400, origin);
  }

  const itemIds = await getItemIndex(env, userId);
  const transactions = [];
  let plaidCalls = 0;
  let truncated = false;

  for (const itemId of itemIds) {
    if (plaidCalls >= SYNC_PLAID_CALL_BUDGET) { truncated = true; break; }
    const recRaw = await env.ASCEND_KV.get(itemKey(userId, itemId));
    if (!recRaw) continue;
    const rec = JSON.parse(recRaw);
    let accessToken;
    try { accessToken = await decryptString(rec.accessTokenCipher, env.ENCRYPTION_KEY); }
    catch { continue; }

    try {
      plaidCalls++;
      const r = await plaidCall(env, "/investments/transactions/get", {
        access_token: accessToken,
        start_date: startDate,
        end_date: endDate,
      });
      const securitiesById = {};
      for (const s of (r.securities || [])) securitiesById[s.security_id] = s;
      for (const t of (r.investment_transactions || [])) {
        const sec = securitiesById[t.security_id] || {};
        transactions.push({
          item_id: itemId,
          institution_name: rec.institutionName,
          investment_transaction_id: t.investment_transaction_id,
          account_id: t.account_id,
          security_id: t.security_id,
          ticker: sec.ticker_symbol || null,
          security_name: sec.name || null,
          date: t.date,
          name: t.name,
          quantity: t.quantity,
          amount: t.amount,
          price: t.price,
          fees: t.fees,
          type: t.type,                   // 'buy' | 'sell' | 'cash' | 'transfer' | 'fee' | 'cancel'
          subtype: t.subtype,             // 'buy', 'sell', 'dividend', 'merger', 'split', etc.
          iso_currency_code: t.iso_currency_code,
        });
      }
    } catch (e) { continue; }
  }

  return json({ ok: true, start_date: startDate, end_date: endDate, transactions, truncated }, 200, origin);
}

async function handleAnthropic(request, env, userId, origin) {
  if (!env.ANTHROPIC_KEY) {
    return json({ error: "AI insights not configured on this backend", code: "ai_disabled" }, 503, origin);
  }

  // Reject oversized request bodies before parsing — protects the worker's
  // CPU budget against an attacker who can ship 100MB JSON to one POST.
  // 200KB is comfortably above the messages-array clamp below (20 msgs × 40KB).
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > 1_000_000) {
    return json({ error: "request body too large", code: "payload_too_large" }, 413, origin);
  }

  const body = await request.json().catch(() => ({}));
  // Validate + clamp the request to prevent abuse
  const model = String(body.model || "claude-haiku-4-5-20251001").slice(0, 80);
  const maxTokens = Math.min(parseInt(body.max_tokens, 10) || 800, 2000);
  // Validate each message is a {role, content} object with role in
  // {user, assistant}. A raw "messages: [42, null, 'oops']" would otherwise
  // pass through to Anthropic and 400 there with a less helpful error.
  const rawMsgs = Array.isArray(body.messages) ? body.messages.slice(0, 20) : [];
  const messages = [];
  for (const m of rawMsgs) {
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : null;
    if (!role) continue;
    // content can be string OR Anthropic's structured-content array. Validate both shapes.
    let content;
    if (typeof m.content === "string") content = m.content;
    else if (Array.isArray(m.content)) content = m.content;
    else continue;
    messages.push({ role, content });
  }
  if (!messages.length) return json({ error: "messages required", code: "validation_error" }, 400, origin);
  // Optional system prompt — Anthropic accepts a top-level `system` string.
  // Forwarded only if the caller provided one (the AI onboarding flow does;
  // the insights flow does not). Capped to keep costs predictable.
  const systemPrompt = typeof body.system === "string" ? body.system.slice(0, 8000) : null;
  // Optional feature tag — lets a single client distinguish e.g. "insights"
  // from "onboarding" so we can rate-limit them independently. Defaults to
  // "default" so unknown callers share one bucket.
  const feature = String(body.feature || "default").slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, "") || "default";
  // Trim any single message to a reasonable size to bound cost
  for (const m of messages) {
    if (typeof m.content === "string" && m.content.length > 40000) {
      m.content = m.content.slice(0, 40000);
    }
  }

  // ---- Rate limiting: per-feature daily cap + global per-minute burst ----
  // The daily cap protects against quiet long-tail abuse; the burst cap stops
  // a runaway client from emptying the daily quota in seconds.
  const dailyCap = parseInt(env.ANTHROPIC_DAILY_CAP || `${DEFAULT_LLM_CAP}`, 10) || DEFAULT_LLM_CAP;
  const burstCap = parseInt(env.ANTHROPIC_BURST_CAP || `${DEFAULT_LLM_BURST}`, 10) || DEFAULT_LLM_BURST;
  const day = new Date().toISOString().slice(0, 10);
  const min = new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
  const dailyKey = `u:${userId}:llm:${feature}:${day}`;
  const burstKey = `u:${userId}:llm:burst:${min}`;

  const [curDaily, curBurst] = await Promise.all([
    env.ASCEND_KV.get(dailyKey).then(v => parseInt(v || "0", 10) || 0),
    env.ASCEND_KV.get(burstKey).then(v => parseInt(v || "0", 10) || 0),
  ]);
  if (curDaily >= dailyCap) {
    await appendAudit(env, userId, `anthropic_blocked_daily_${feature}`);
    return json({
      error: `daily AI limit reached (${dailyCap}/day for "${feature}"). Resets at UTC midnight.`,
      code: "rate_limit_daily",
      feature,
      resetAt: day + "T00:00:00Z (next day)",
    }, 429, origin);
  }
  if (curBurst >= burstCap) {
    await appendAudit(env, userId, "anthropic_blocked_burst");
    return json({
      error: `Too many AI requests in the last minute (${burstCap}/min). Wait a moment and try again.`,
      code: "rate_limit_burst",
    }, 429, origin);
  }

  // Reserve the slot BEFORE calling Anthropic to narrow the race window.
  // We don't refund on failure — abusive clients that always error out would
  // otherwise bypass the cap entirely.
  await Promise.all([
    env.ASCEND_KV.put(dailyKey, String(curDaily + 1), { expirationTtl: 60 * 60 * 36 }),
    env.ASCEND_KV.put(burstKey, String(curBurst + 1), { expirationTtl: 90 }),
  ]);

  const payload = { model, max_tokens: maxTokens, messages };
  if (systemPrompt) payload.system = systemPrompt;

  // Single retry on transient Anthropic errors. Don't retry on 4xx (user
  // error — same input will get the same error). On 429 from Anthropic we
  // back off briefly — our own per-user burst cap should rarely let us hit
  // this. On 5xx we retry once.
  let r;
  for (let attempt = 0; attempt < 2; attempt++) {
    r = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
    if (r.ok) break;
    if (attempt === 0 && (r.status === 429 || r.status >= 500)) {
      await _sleep(r.status === 429 ? 500 : 250);
      continue;
    }
    break;
  }

  await appendAudit(env, userId, r.ok ? `anthropic_${feature}` : `anthropic_${feature}_error`);

  // Whitelist the fields we forward to the client so upstream error metadata
  // (model_id, internal request ids, organization hints, and in rare 401
  // variants the obfuscated tail of the API key) never reaches the browser.
  // On success: forward {id, type, role, model, content, stop_reason, stop_sequence, usage}.
  // On error: forward {error: {type, message}} with the message trimmed.
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  let safe;
  if (r.ok && parsed && typeof parsed === "object") {
    safe = {
      id: typeof parsed.id === "string" ? parsed.id.slice(0, 120) : undefined,
      type: typeof parsed.type === "string" ? parsed.type.slice(0, 40) : undefined,
      role: typeof parsed.role === "string" ? parsed.role.slice(0, 40) : undefined,
      model: typeof parsed.model === "string" ? parsed.model.slice(0, 80) : undefined,
      content: Array.isArray(parsed.content) ? parsed.content : undefined,
      stop_reason: parsed.stop_reason || undefined,
      stop_sequence: parsed.stop_sequence || undefined,
      usage: parsed.usage && typeof parsed.usage === "object" ? {
        input_tokens: +parsed.usage.input_tokens || 0,
        output_tokens: +parsed.usage.output_tokens || 0,
      } : undefined,
    };
  } else if (parsed && parsed.error && typeof parsed.error === "object") {
    safe = {
      error: {
        type: typeof parsed.error.type === "string" ? parsed.error.type.slice(0, 64) : "upstream_error",
        message: typeof parsed.error.message === "string" ? parsed.error.message.slice(0, 300) : "Upstream AI service returned an error.",
      },
    };
  } else {
    // Couldn't parse — generic message, don't leak the raw upstream body.
    safe = { error: { type: "upstream_error", message: r.ok ? "Empty response from AI" : `Upstream returned HTTP ${r.status}` } };
  }
  return new Response(JSON.stringify(safe), {
    status: r.status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function handleAuditList(env, userId, origin) {
  // Cheap KV read but worth bounding — frontend doesn't need to poll this.
  const limited = await _userRateGate(env, userId, "audit", 30, origin);
  if (limited) return limited;
  const raw = await env.ASCEND_KV.get(`u:${userId}:audit`);
  const events = raw ? JSON.parse(raw) : [];
  return json({ ok: true, events }, 200, origin);
}

// ============ Plaid webhook receiver ============
// Plaid POSTs notification events here when an item breaks (re-auth required,
// permission revoked, etc.). We record the latest event per item_id with a
// 30-day TTL; /items surfaces it so the client can show a "reconnect bank"
// prompt without us needing a push channel.
//
// Security: every webhook is signed by Plaid (Plaid-Verification: <JWT>).
// We verify the ES256 signature, that the body SHA-256 matches the signed
// `request_body_sha256` claim, and that `iat` is within a 5-minute window
// (anti-replay). Spec: https://plaid.com/docs/api/webhooks/webhook-verification/
// We fail closed — a forged "reconnect bank X" event would phish users into
// believing their connection broke. Plaid's retry strategy on 401 is to back
// off and ultimately drop, which is the correct outcome for an unverified
// payload. JWKs are cached in KV by `kid` for 24h to amortize the
// /webhook_verification_key/get lookup.
async function handlePlaidWebhook(request, env) {
  const rawBody = await request.text();

  // Verify the Plaid-Verification JWT before touching the payload. If we
  // can't verify (missing creds, network failure, bad signature, stale iat,
  // body hash mismatch), reject — never persist unverified events.
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) {
    return new Response("plaid creds unset", { status: 503 });
  }
  const jwt = request.headers.get("Plaid-Verification") || "";
  if (!jwt) return new Response("missing Plaid-Verification", { status: 401 });
  try {
    await verifyPlaidWebhookJWT(env, rawBody, jwt);
  } catch (e) {
    console.error("plaid webhook verification failed:", e && e.message);
    return new Response("invalid signature", { status: 401 });
  }

  let body;
  try { body = JSON.parse(rawBody); } catch { return new Response("", { status: 200 }); }

  const itemId = String(body.item_id || "").slice(0, 100);
  const type = String(body.webhook_type || "").toUpperCase().slice(0, 40);
  const code = String(body.webhook_code || "").toUpperCase().slice(0, 60);
  if (!itemId || !type) return new Response("", { status: 200 });

  // Ownership check — Plaid signature only proves "Plaid sent this", not
  // that this item belongs to one of our enrolled users. Without this,
  // an item_id from a different Plaid customer (or a fabricated one) would
  // create a `webhook:<itemId>` record we'd waste KV storage on, and
  // could surface to a future user that happens to enroll with that same
  // (impossible-but-defense-in-depth) item_id. Silently drop unknowns.
  const owner = await getItemOwner(env, itemId);
  if (!owner) return new Response("", { status: 200 });

  // Events worth surfacing to the user — anything that requires their action
  const actionableCodes = new Set([
    "ERROR",                        // ITEM
    "PENDING_EXPIRATION",           // ITEM
    "USER_PERMISSION_REVOKED",      // ITEM
    "USER_ACCOUNT_REVOKED",         // ITEM
    "LOGIN_REPAIRED",               // ITEM — recovery info
    "NEW_ACCOUNTS_AVAILABLE",       // ITEM
  ]);
  if (!actionableCodes.has(code)) return new Response("", { status: 200 });

  // Defensively cap the error payload size
  const err = body.error && typeof body.error === "object" ? {
    error_code: String(body.error.error_code || "").slice(0, 60),
    error_message: String(body.error.error_message || "").slice(0, 400),
    error_type: String(body.error.error_type || "").slice(0, 60),
  } : null;

  await env.ASCEND_KV.put(`webhook:${itemId}`, JSON.stringify({
    t: new Date().toISOString(),
    type, code, error: err,
  }), { expirationTtl: 60 * 60 * 24 * WEBHOOK_KEEP_DAYS });

  return new Response("", { status: 200 });
}

async function handleDeleteAccount(env, userId, origin) {
  // Destructive + irreversible. Frontend already has a confirm flow, but a
  // stolen clientSecret could call this directly. Tight cap (2/hour, 3/day)
  // — a real user deletes at most once. If they hit the cap they can wait or
  // contact the operator out-of-band.
  const limited = await _userRateGate(env, userId, "account_delete", 2, origin, 3);
  if (limited) return limited;
  // Best-effort: revoke each Plaid item, then nuke all KV records under u:userId:*
  const itemIds = await getItemIndex(env, userId);
  for (const itemId of itemIds) {
    const raw = await env.ASCEND_KV.get(itemKey(userId, itemId));
    if (raw) {
      try {
        const rec = JSON.parse(raw);
        const at = await decryptString(rec.accessTokenCipher, env.ENCRYPTION_KEY);
        await plaidCall(env, "/item/remove", { access_token: at });
      } catch {}
      await env.ASCEND_KV.delete(itemKey(userId, itemId));
    }
    await env.ASCEND_KV.delete(`webhook:${itemId}`);
  }
  await env.ASCEND_KV.delete(indexKey(userId));
  await env.ASCEND_KV.delete(`u:${userId}:auth`);
  await env.ASCEND_KV.delete(`u:${userId}:audit`);
  // LLM counters expire on their own (TTL).
  return json({ ok: true }, 200, origin);
}

// ============ Audit log ============

async function audited(env, userId, action, fn, meta) {
  const res = await fn();
  // fn() always returns a Response, which always has .status. Tag as
  // *_error for any non-2xx so the audit log distinguishes successful
  // actions from rate-limited / validation-failed / 5xx attempts.
  const tag = res.status < 400 ? action : action + "_error";
  try { await appendAudit(env, userId, tag, meta); }
  catch (e) { try { console.warn(`[audit_tag_failed] uid=${userId} tag=${tag}`); } catch {} }
  return res;
}

async function appendAudit(env, userId, action, meta) {
  // meta is an optional small object — { ipHash?, ua? } — already truncated/
  // hashed by the caller. We never store raw IPs (PII / GDPR) — only a
  // 12-char SHA-256 prefix that a user can compare against their other audit
  // entries to spot "this came from a different device than mine" without
  // letting an audit-log reader fingerprint individuals.
  try {
    const key = `u:${userId}:audit`;
    const raw = await env.ASCEND_KV.get(key);
    const arr = raw ? JSON.parse(raw) : [];
    const entry = { t: new Date().toISOString(), a: action };
    if (meta && typeof meta === "object") {
      if (typeof meta.ipHash === "string") entry.ip = meta.ipHash.slice(0, 12);
      if (typeof meta.ua === "string") entry.ua = meta.ua.slice(0, 60);
    }
    arr.unshift(entry);
    if (arr.length > AUDIT_KEEP) arr.length = AUDIT_KEEP;
    await env.ASCEND_KV.put(key, JSON.stringify(arr));
  } catch (e) {
    // Audit-log write failures are not user-blocking but they ARE a signal
    // that KV is under stress or the user's audit blob is corrupted. Surface
    // to wrangler tail so the operator notices without spamming the client.
    try { console.warn(`[audit_write_failed] uid=${userId} action=${action}: ${e && e.message}`); } catch {}
  }
}

// ============ Plaid client (no SDK) ============

// Wait `ms` milliseconds. Workers' setTimeout is available since
// compat_date 2022-11-30; we're well past that.
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function plaidCall(env, path, body) {
  const host = PLAID_HOSTS[env.PLAID_ENV] || PLAID_HOSTS.sandbox;
  // Single retry with backoff on transient Plaid errors (429, 5xx).
  // Bounded so we don't blow the CPU budget on a misbehaving upstream.
  // 429 backoff: 300ms (conservative — Plaid's docs say retry after a
  // short delay; the rate-limit headers vary by endpoint). 5xx: 200ms.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(host + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.PLAID_CLIENT_ID,
        secret: env.PLAID_SECRET,
        ...body,
      }),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (r.ok) return data;
    // Retry once on transient upstream failures
    if (attempt === 0 && (r.status === 429 || r.status >= 500)) {
      const wait = r.status === 429 ? 300 : 200;
      await _sleep(wait);
      continue;
    }
    const err = new Error(`Plaid ${path} failed: ${data.error_message || data.error_code || r.status}`);
    err.plaid = data;
    err.status = r.status;
    throw err;
  }
  throw lastErr || new Error(`Plaid ${path} failed after retry`);
}

// ============ KV index helpers ============

const itemKey = (uid, iid) => `u:${uid}:item:${iid}`;
const indexKey = (uid) => `u:${uid}:items`;

async function getItemIndex(env, userId) {
  const raw = await env.ASCEND_KV.get(indexKey(userId));
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}
async function addItemToIndex(env, userId, itemId) {
  const arr = await getItemIndex(env, userId);
  if (!arr.includes(itemId)) arr.push(itemId);
  await env.ASCEND_KV.put(indexKey(userId), JSON.stringify(arr));
  // Reverse index — lets handlePlaidWebhook verify that an incoming
  // webhook's item_id actually belongs to one of our enrolled users
  // before we persist anything. Without this, a verified-but-foreign
  // Plaid item_id (e.g. another customer's, or a bug-induced fabrication)
  // would create an orphaned webhook record we'd waste KV storage on
  // and could in theory surface to a future user with a colliding id.
  await env.ASCEND_KV.put(`item-owner:${itemId}`, userId);
}
async function removeItemFromIndex(env, userId, itemId) {
  const arr = await getItemIndex(env, userId);
  const next = arr.filter((x) => x !== itemId);
  await env.ASCEND_KV.put(indexKey(userId), JSON.stringify(next));
  // Drop the reverse-index entry too so a webhook arriving after a
  // disconnect doesn't re-create a stale ownership record.
  await env.ASCEND_KV.delete(`item-owner:${itemId}`);
}
async function getItemOwner(env, itemId) {
  return await env.ASCEND_KV.get(`item-owner:${itemId}`);
}

// ============ Crypto (AES-GCM) ============

async function importKeyB64(b64) {
  const raw = b64ToBytes(b64);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encryptString(plain, keyB64) {
  const key = await importKeyB64(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plain);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc));
  return bytesToB64(iv) + ":" + bytesToB64(ct);
}
async function decryptString(packed, keyB64) {
  // Validate the packed format ("<ivB64>:<ctB64>") before parsing — a
  // malformed entry would otherwise throw an "InvalidCharacterError" from
  // atob(undefined), which bubbles into a 500 with an internal-state-y
  // message. Better to surface a clean "corrupted ciphertext" error.
  const s = String(packed || "");
  const parts = s.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("corrupted ciphertext: bad packed format");
  }
  const [ivB64, ctB64] = parts;
  // base64 sanity check before atob — atob throws cryptically on non-base64.
  if (!/^[A-Za-z0-9+/=]+$/.test(ivB64) || !/^[A-Za-z0-9+/=]+$/.test(ctB64)) {
    throw new Error("corrupted ciphertext: non-base64 segment");
  }
  const key = await importKeyB64(keyB64);
  const iv = b64ToBytes(ivB64);
  const ct = b64ToBytes(ctB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ============ HTTP helpers ============

// Hash a userId to a 12-char prefix so logs can correlate requests from the
// same device without leaking the actual userId (which is high-cardinality
// but stable and would let a log reader fingerprint individual users). SHA-256
// hex is overkill for size; truncate to 12 chars (~48 bits) — enough to
// distinguish among the operator's expected user base, not enough to brute-
// force back to a userId.
async function _hashUid(uid) {
  if (!uid) return "none";
  try {
    const h = await sha256hex(uid);
    return h.slice(0, 12);
  } catch { return "err"; }
}

// One structured log line per authenticated request — captured by
// wrangler tail and Cloudflare's observability pipeline. Format chosen to
// be greppable AND parseable. Never include:
//   - raw userId (use _hashUid)
//   - any Authorization header content
//   - request body
//   - Plaid response data
//   - access tokens, ciphertext
// `outcome` is "ok" | "client_error" | "server_error" | "rate_limited" |
// "unauthorized" — bucketed for SLO dashboards.
async function _accessLog(env, { userId, route, method, status, elapsedMs, code }) {
  try {
    const uidHash = await _hashUid(userId);
    const outcome = status < 400 ? "ok"
                  : status === 401 || status === 403 ? "unauthorized"
                  : status === 429 ? "rate_limited"
                  : status < 500 ? "client_error"
                  : "server_error";
    // One-line JSON keeps wrangler tail readable AND lets log-shippers parse.
    console.log(JSON.stringify({
      t: new Date().toISOString(),
      uid: uidHash,
      route, method, status, outcome,
      ms: elapsedMs,
      ...(code ? { code } : {}),
    }));
  } catch { /* logging must never throw */ }
}

// Log a server-side error with full context, return a sanitized client-safe
// payload. Use everywhere an upstream/internal error could otherwise leak
// (Plaid endpoint paths, Anthropic response bodies, stack traces, secret tails
// in 401s, etc.). The `code` is a stable token the frontend can switch on; the
// `clientMessage` is a generic human-readable string. The real error goes to
// `console.error` so `wrangler tail` and the Cloudflare dashboard still see it.
function safeError(err, context, code = "server_error", clientMessage = "Something went wrong. Try again or contact support if it persists.") {
  try {
    const ctxStr = typeof context === "string" ? context : JSON.stringify(context);
    const errStr = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
    console.error(`[${code}] ${ctxStr} :: ${errStr}`);
  } catch {
    // Even logging shouldn't throw. Worst case: drop the log and still return safe payload.
  }
  return { error: clientMessage, code };
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}
function json(obj, status = 200, origin = "*") {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

// ============================================================================
// WEB PUSH (VAPID + RFC 8291 aes128gcm payload encryption)
//
// Endpoints:
//   POST /push/subscribe   body {subscription, schedule, tz}   — store subscription + schedule
//   POST /push/unsubscribe                                     — remove
//   POST /push/test                                            — fire a test push now
//   POST /push/send        body {title, body, url?, tag?}      — fire an immediate push
//   scheduled cron */15 *  scans all subscriptions, delivers any whose
//                          schedule time has arrived in the user's tz
//
// KV layout:
//   u:<userId>:push  →  { subscription, schedule:[{hhmm, body, lastFiredKey}], tz, createdAt }
//   push:index       →  array of userIds with active subscriptions (for cron scan)
// ============================================================================

function pushKey(uid) { return `u:${uid}:push`; }
const PUSH_INDEX_KEY = "push:index";

async function _getPushIndex(env) {
  const raw = await env.ASCEND_KV.get(PUSH_INDEX_KEY);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
async function _addToPushIndex(env, userId) {
  const arr = await _getPushIndex(env);
  if (!arr.includes(userId)) {
    arr.push(userId);
    await env.ASCEND_KV.put(PUSH_INDEX_KEY, JSON.stringify(arr));
  }
}
async function _removeFromPushIndex(env, userId) {
  const arr = await _getPushIndex(env);
  const next = arr.filter(x => x !== userId);
  await env.ASCEND_KV.put(PUSH_INDEX_KEY, JSON.stringify(next));
}

// Push services we'll deliver to. Without an allowlist, an enrolled user
// could pass any URL as `subscription.endpoint` and turn the Worker (which
// signs with our VAPID key) into an authenticated outbound-request engine
// — SSRF + abuse vector. These four hosts cover every browser/OS that
// implements Web Push today (Chrome/Edge/Android via FCM, Safari/iOS via
// Apple's push gateway, Firefox via Mozilla's autopush, Windows via WNS).
const ALLOWED_PUSH_HOSTS = [
  /^https:\/\/(fcm|android|gcm-http)\.googleapis\.com\//i,
  /^https:\/\/[a-z0-9-]+\.push\.apple\.com\//i,
  /^https:\/\/(updates|autopush)\.push\.services\.mozilla\.com\//i,
  /^https:\/\/[a-z0-9.-]+\.notify\.windows\.com\//i,
];
function _isAllowedPushEndpoint(url) {
  if (typeof url !== "string" || url.length > 500) return false;
  try { if (new URL(url).protocol !== "https:") return false; } catch { return false; }
  return ALLOWED_PUSH_HOSTS.some(rx => rx.test(url));
}

// Per-user rate limit for the push endpoints. Cheap KV counter — the burst
// cap stops a runaway client from cycling subscriptions / spamming /push/test
// before any daily cap kicks in. If `perDayCap` is provided, also enforce a
// per-UTC-day cap so an attacker can't sustain the hourly rate for 24h.
// Returns a 429 Response if either cap is hit, else null.
// Per-IP rate limit on /enroll. The enrollment key ships in the consumer JS
// bundle and is functionally public; this gate is the actual security
// boundary against mass-enrollment abuse. Caps:
//   - 5 enrollments per IP per hour (normal users enroll once per device)
//   - 25 per IP per day (covers device upgrades, family/friend testing, etc.)
//   - GLOBAL cap of 500 enrollments per UTC day across all IPs — a
//     defense-in-depth against a botnet that stays under the per-IP cap.
//     Tuned for a single-operator app (you, your friends, ~handful of beta
//     users); bump if your install base outgrows it.
// Source IP is taken from CF-Connecting-IP (Cloudflare-set), falling back to
// X-Real-IP, then the leftmost X-Forwarded-For — Cloudflare overwrites this
// header at the edge, so it can't be spoofed by the client.
async function _enrollRateGate(request, env, origin) {
  const ip = (request.headers.get("CF-Connecting-IP")
            || request.headers.get("X-Real-IP")
            || (request.headers.get("X-Forwarded-For") || "").split(",")[0]
            || "unknown").trim().slice(0, 64);
  // Use a sanitized IP fragment as the KV key suffix — IPv4/IPv6 chars only.
  const ipKey = ip.replace(/[^A-Za-z0-9:.\-]/g, "_") || "unknown";
  const iso = new Date().toISOString();
  const hourKey = `enroll:rl:${ipKey}:${iso.slice(0, 13)}`;
  const dayKey  = `enroll:rl:${ipKey}:day:${iso.slice(0, 10)}`;
  const globalKey = `enroll:rl:global:day:${iso.slice(0, 10)}`;
  const HOUR_CAP = 5;
  const DAY_CAP  = 25;
  const GLOBAL_DAY_CAP = parseInt(env.ENROLL_GLOBAL_DAY_CAP || "500", 10) || 500;

  // Global cap first — cheap KV read; protects against the botnet case.
  const curGlobal = parseInt(await env.ASCEND_KV.get(globalKey) || "0", 10) || 0;
  if (curGlobal >= GLOBAL_DAY_CAP) {
    try { console.warn(`[enroll_global_cap_hit] day_count=${curGlobal}`); } catch {}
    return json({ error: `Enrollment temporarily unavailable. Try again tomorrow.`, code: "rate_limit_global" }, 429, origin);
  }
  const curHour = parseInt(await env.ASCEND_KV.get(hourKey) || "0", 10) || 0;
  if (curHour >= HOUR_CAP) {
    return json({ error: `Too many enrollments from this network. Try again in an hour.`, code: "rate_limit" }, 429, origin);
  }
  const curDay = parseInt(await env.ASCEND_KV.get(dayKey) || "0", 10) || 0;
  if (curDay >= DAY_CAP) {
    return json({ error: `Daily enrollment limit reached from this network. Try again tomorrow.`, code: "rate_limit_daily" }, 429, origin);
  }
  // Reserve before doing the work; TTLs cover clock skew (~70 min / ~26 h).
  await env.ASCEND_KV.put(hourKey,   String(curHour + 1),   { expirationTtl: 70 * 60 });
  await env.ASCEND_KV.put(dayKey,    String(curDay + 1),    { expirationTtl: 26 * 60 * 60 });
  await env.ASCEND_KV.put(globalKey, String(curGlobal + 1), { expirationTtl: 26 * 60 * 60 });
  return null;
}

// Generic per-user rate gate. Bucket is a short string (e.g. "sync", "test",
// "send") so different routes get isolated counters. Caller picks an hourly
// cap; the daily cap is optional and stacked on top.
//
// KV writes are sloppy / racy by design — two parallel requests can both read
// curHour=N (cap N+1), both reserve, both succeed. Acceptable at this app's
// scale; documented here so a future contributor doesn't "fix" it by reaching
// for Durable Objects without first measuring the slop. If the slop ever
// matters: move counters to a Durable Object keyed by userId.
async function _userRateGate(env, userId, bucket, perHourCap, origin, perDayCap) {
  const iso = new Date().toISOString();
  const hourKey = `u:${userId}:rl:${bucket}:${iso.slice(0, 13)}`; // YYYY-MM-DDTHH
  const curHour = parseInt(await env.ASCEND_KV.get(hourKey) || "0", 10) || 0;
  if (curHour >= perHourCap) {
    return json({ error: `Rate limit: ${perHourCap}/hour for ${bucket}. Slow down.`, code: "rate_limit" }, 429, origin);
  }
  if (perDayCap) {
    const dayKey = `u:${userId}:rl:${bucket}:day:${iso.slice(0, 10)}`;
    const curDay = parseInt(await env.ASCEND_KV.get(dayKey) || "0", 10) || 0;
    if (curDay >= perDayCap) {
      return json({ error: `Daily limit: ${perDayCap}/day for ${bucket}. Try again tomorrow.`, code: "rate_limit_daily" }, 429, origin);
    }
    await env.ASCEND_KV.put(dayKey, String(curDay + 1), { expirationTtl: 26 * 60 * 60 });
  }
  // Reserve before doing the work; TTL ~70 min covers any clock skew.
  await env.ASCEND_KV.put(hourKey, String(curHour + 1), { expirationTtl: 70 * 60 });
  return null;
}

async function handlePushSubscribe(request, env, userId, origin) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    return json({ error: "Push not configured on this backend (missing VAPID_*)", code: "push_disabled" }, 503, origin);
  }
  // Subscribe is effectively a one-time user action (rotated when the SW
  // push subscription expires or the user re-grants permission). 5/hour
  // gives slack for the rare permission-flip cycle without enabling a
  // misbehaving client to churn KV records.
  const limited = await _userRateGate(env, userId, "subscribe", 5, origin);
  if (limited) return limited;
  // 20KB ceiling — a schedule with 8 slots × 200-char bodies plus subscription
  // keys (~100 bytes each) is well under 5KB. 20KB leaves headroom.
  if (_bodyTooLarge(request, 20_000)) return json({ error: "request body too large", code: "payload_too_large" }, 413, origin);
  const body = await request.json().catch(() => ({}));
  const sub = body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return json({ error: "invalid subscription", code: "validation_error" }, 400, origin);
  }
  // Endpoint must be a known push service — no SSRF target of operator's choosing.
  if (!_isAllowedPushEndpoint(sub.endpoint)) {
    return json({ error: "subscription endpoint not on push-service allowlist", code: "validation_error" }, 400, origin);
  }
  // Cap key/secret sizes so an enrolled attacker can't bloat KV records.
  // Real p256dh is 65 bytes (88 b64), auth is 16 bytes (24 b64). 200 / 64
  // are generous ceilings that still constrain memory.
  if (typeof sub.keys.p256dh !== "string" || sub.keys.p256dh.length > 200) {
    return json({ error: "p256dh too long", code: "validation_error" }, 400, origin);
  }
  if (typeof sub.keys.auth !== "string" || sub.keys.auth.length > 64) {
    return json({ error: "auth too long", code: "validation_error" }, 400, origin);
  }
  // schedule = [{ hhmm: "08:00", body: "Optional body" }] — sent by frontend
  // when reminderTimes change. Body is optional; backend uses a generic
  // "Time for your daily check-in" if absent.
  const schedule = Array.isArray(body.schedule)
    ? body.schedule.filter(s => /^\d{2}:\d{2}$/.test(s.hhmm)).slice(0, 8).map(s => ({
        hhmm: s.hhmm,
        body: typeof s.body === "string" ? s.body.slice(0, 200) : "",
        lastFiredKey: "",
      }))
    : [];
  // tz = IANA timezone (e.g. "America/New_York"). Defaults to UTC if missing.
  const tz = (typeof body.tz === "string" && body.tz.length < 60) ? body.tz : "UTC";
  await env.ASCEND_KV.put(pushKey(userId), JSON.stringify({
    subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
    schedule,
    tz,
    createdAt: new Date().toISOString(),
  }));
  await _addToPushIndex(env, userId);
  return json({ ok: true }, 200, origin);
}

async function handlePushUnsubscribe(env, userId, origin) {
  await env.ASCEND_KV.delete(pushKey(userId));
  await _removeFromPushIndex(env, userId);
  return json({ ok: true }, 200, origin);
}

async function handlePushTest(env, userId, origin) {
  // Test is user-initiated ("send me a test push to verify delivery"). A
  // healthy user taps it once. Tightened from 10/hour to 3/hour — a stolen
  // device-secret can't use this to spam the device.
  const limited = await _userRateGate(env, userId, "test", 3, origin);
  if (limited) return limited;
  const raw = await env.ASCEND_KV.get(pushKey(userId));
  if (!raw) return json({ error: "not subscribed", code: "not_subscribed" }, 400, origin);
  const rec = JSON.parse(raw);
  try {
    await sendWebPush(env, rec.subscription, {
      title: "Ascend test",
      body: "Background push is working 🎉",
      tag: "ascend-test",
      url: "/",
    });
    return json({ ok: true }, 200, origin);
  } catch (e) {
    return json(safeError(e, { route: "/push/test", userId, pushStatus: e.status }, "push_failed", "Could not send test push. Check your subscription and try again."), 500, origin);
  }
}

// Sanitize a push `url` field to a same-origin relative path. The SW already
// re-validates, but stripping at the boundary keeps malicious payloads out
// of KV (so an old stored push doesn't leak past a future SW that's less
// strict). Returns "/" for anything unsafe.
// Allowlist of pathname prefixes the service worker is permitted to
// navigate to when the user taps a notification. Any other path falls
// through to "/". Defends against a compromised push payload pointing the
// PWA at a destructive route like /?action=delete-everything or sending
// the user to a tab that auto-performs a side effect.
const _ALLOWED_PUSH_PATHS = [
  "/", "/?", "/?tab=today", "/?tab=money", "/?tab=stocks", "/?tab=goals",
  "/?tab=stats", "/?tab=calendar", "/?tab=planning", "/?tab=settings",
];
function _safePushUrl(raw) {
  if (typeof raw !== "string" || raw.length > 200) return "/";
  // Reject absolute URLs (including data:, javascript:, etc.) and
  // protocol-relative paths.
  if (!/^\//.test(raw) || /^\/\//.test(raw)) return "/";
  // Parse to separate path from query/fragment, drop the fragment, and
  // verify the path+query starts with an allowlisted prefix.
  try {
    const u = new URL(raw, "https://placeholder.local");
    const pathPlusQuery = u.pathname + u.search;
    for (const ok of _ALLOWED_PUSH_PATHS) {
      if (pathPlusQuery === ok || pathPlusQuery.startsWith(ok)) return pathPlusQuery;
    }
  } catch {}
  return "/";
}

async function handlePushSend(request, env, userId, origin) {
  // /push/send is the milestone-alert path (e.g. "you crossed $100k"). The
  // frontend calls it sparingly, but a compromised clientSecret could spam
  // the device. Hourly cap bounds burst; daily cap (50/day, matching the
  // Anthropic proxy cap) bounds sustained abuse over 24h.
  const limited = await _userRateGate(env, userId, "send", 30, origin, 50);
  if (limited) return limited;
  if (_bodyTooLarge(request, 5_000)) return json({ error: "request body too large", code: "payload_too_large" }, 413, origin);
  const raw = await env.ASCEND_KV.get(pushKey(userId));
  if (!raw) return json({ error: "not subscribed", code: "not_subscribed" }, 400, origin);
  const body = await request.json().catch(() => ({}));
  const rec = JSON.parse(raw);
  // Type-check each field so a non-string (e.g. {a:1}) doesn't slide through
  // String(...) as the literal "[object Object]". Fall through to defaults.
  const payload = {
    title: (typeof body.title === "string" ? body.title : "Ascend").slice(0, 100),
    body:  (typeof body.body  === "string" ? body.body  : "").slice(0, 400),
    tag:   (typeof body.tag   === "string" ? body.tag   : "ascend").slice(0, 60),
    url:   _safePushUrl(typeof body.url === "string" ? body.url : "/"),
  };
  try {
    await sendWebPush(env, rec.subscription, payload);
    return json({ ok: true }, 200, origin);
  } catch (e) {
    // 404/410 means the subscription is dead — clean it up so we stop trying.
    const dead = (e.status === 404 || e.status === 410);
    if (dead) {
      await env.ASCEND_KV.delete(pushKey(userId));
      await _removeFromPushIndex(env, userId);
    }
    const code = dead ? "push_subscription_expired" : "push_failed";
    const msg  = dead
      ? "Your push subscription has expired. Re-enable notifications to fix it."
      : "Could not deliver push. Try again or re-subscribe.";
    return json(safeError(e, { route: "/push/send", userId, pushStatus: e.status }, code, msg), 500, origin);
  }
}

// ----- Scheduled delivery -----
async function deliverScheduledPushes(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return;
  const userIds = await _getPushIndex(env);
  if (!userIds.length) return;
  const now = new Date();
  const nowMs = now.getTime();
  const deadSubs = [];

  for (const userId of userIds) {
    try {
      const raw = await env.ASCEND_KV.get(pushKey(userId));
      if (!raw) { deadSubs.push(userId); continue; }
      const rec = JSON.parse(raw);
      const tz = rec.tz || "UTC";
      // Compute the user's local HH:MM and YYYY-MM-DD for matching + dedup.
      const local = _formatInTimeZone(now, tz);
      let modified = false;
      for (const slot of (rec.schedule || [])) {
        // Match the local hour:minute exactly, plus a 15-min forward window
        // since cron fires every 15min — without the window, anything not
        // hitting exactly :00, :15, :30, :45 in the user's local time would
        // be missed forever.
        if (!_withinWindow(local.hhmm, slot.hhmm, 15)) continue;
        // Dedup: only fire once per local-day per slot
        const fireKey = local.dateKey + "|" + slot.hhmm;
        if (slot.lastFiredKey === fireKey) continue;
        try {
          await sendWebPush(env, rec.subscription, {
            title: "Ascend",
            body: slot.body || "Time for your daily check-in",
            tag: "scheduled-" + slot.hhmm,
            url: "/",
          });
          slot.lastFiredKey = fireKey;
          modified = true;
        } catch (e) {
          if (e.status === 404 || e.status === 410) { deadSubs.push(userId); break; }
          // Other errors: leave lastFiredKey untouched so next cron retries.
        }
      }
      if (modified) {
        await env.ASCEND_KV.put(pushKey(userId), JSON.stringify(rec));
      }
    } catch (e) {
      console.warn("deliver failed for", userId, e && e.message);
    }
  }
  // Reap dead subscriptions
  for (const u of deadSubs) {
    await env.ASCEND_KV.delete(pushKey(u));
    await _removeFromPushIndex(env, u);
  }
}

// HH:MM in the user's local timezone is within `windowMin` minutes of slot.
// Both inputs are "HH:MM" strings.
function _withinWindow(currentHHMM, slotHHMM, windowMin) {
  const [ch, cm] = currentHHMM.split(":").map(Number);
  const [sh, sm] = slotHHMM.split(":").map(Number);
  const cMin = ch * 60 + cm;
  const sMin = sh * 60 + sm;
  // Match if slot time is in the closed interval [current, current+window]
  // — i.e. we fire AT slot time or up to `windowMin` after, so cron firings
  // that land on :00/:15/:30/:45 catch slots set to any minute.
  return sMin >= cMin && sMin < cMin + windowMin;
}

// Format a Date in a given IANA timezone, returning {hhmm, dateKey} where
// dateKey is YYYY-MM-DD for that tz. Uses Intl which is available in Workers.
function _formatInTimeZone(date, tz) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).formatToParts(date);
    const get = (t) => (parts.find(p => p.type === t) || {}).value || "00";
    return { hhmm: `${get("hour")}:${get("minute")}`, dateKey: `${get("year")}-${get("month")}-${get("day")}` };
  } catch {
    const iso = date.toISOString();
    return { hhmm: iso.slice(11, 16), dateKey: iso.slice(0, 10) };
  }
}

// ----- Web Push delivery: VAPID JWT + aes128gcm payload encryption -----
//
// RFC 8291 (Message Encryption for Web Push, aes128gcm scheme):
//   1. Generate ephemeral P-256 keypair
//   2. ECDH(privEphemeral, pubSubscriber.p256dh) → ikm
//   3. HKDF-Expand(salt=random16, IKM=combine(ikm, auth), info=...) → CEK + nonce
//   4. AES-128-GCM(CEK, nonce, padded plaintext) → ciphertext
//   5. POST to subscription.endpoint with:
//        headers: Authorization: vapid t=<JWT>, k=<vapidPublic>
//                 Encryption: salt=<base64url>
//                 Crypto-Key: p256ecdsa=<vapidPublic>
//                 Content-Encoding: aes128gcm
//                 Content-Type: application/octet-stream
//                 TTL: <seconds>
//        body: salt(16) || rs(4) || idlen(1) || ephemeralPub(idlen) || ciphertext
//
// VAPID JWT (RFC 8292): header {alg:ES256,typ:JWT}, claims {aud:endpointOrigin,
// exp:nowInSec+12h, sub:VAPID_SUBJECT}, signed ES256 with the VAPID private key.

async function sendWebPush(env, subscription, payload) {
  const endpoint = subscription.endpoint;
  if (!endpoint) throw withStatus(new Error("no endpoint"), 400);
  const aud = new URL(endpoint).origin;

  // 1. VAPID JWT
  const jwt = await _vapidJwt(env, aud);

  // 2. Encrypt payload
  const body = await _encryptAes128gcm(JSON.stringify(payload), subscription.keys);

  const ttl = 60 * 60 * 24; // 24h — push services drop if undeliverable longer
  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": String(ttl),
      "Urgency": "normal",
    },
    body,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw withStatus(new Error(`push service ${r.status}: ${txt.slice(0,200)}`), r.status);
  }
}

function withStatus(err, status) { err.status = status; return err; }

// VAPID JWT — ES256 signature with the VAPID private key
async function _vapidJwt(env, audience) {
  const header = { alg: "ES256", typ: "JWT" };
  const claims = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT,
  };
  const headerB64 = _b64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const claimsB64 = _b64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${claimsB64}`;
  const key = await _vapidSigningKey(env);
  const sigBuf = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const sigB64 = _b64urlEncode(new Uint8Array(sigBuf));
  return `${signingInput}.${sigB64}`;
}

// Import the raw 32-byte VAPID private key as an ECDSA signing key. The
// public key is the base64url-encoded uncompressed P-256 point (0x04 || X || Y).
async function _vapidSigningKey(env) {
  const priv = _b64urlDecode(env.VAPID_PRIVATE_KEY);   // 32 bytes
  const pubRaw = _b64urlDecode(env.VAPID_PUBLIC_KEY);  // 65 bytes (0x04||X||Y)
  if (pubRaw.length !== 65 || pubRaw[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point in base64url");
  }
  const x = pubRaw.slice(1, 33), y = pubRaw.slice(33, 65);
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC", crv: "P-256",
      x: _b64urlEncode(x), y: _b64urlEncode(y),
      d: _b64urlEncode(priv),
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

// aes128gcm encryption per RFC 8291
async function _encryptAes128gcm(plaintext, subKeys) {
  const ptBytes = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext;
  const subPubRaw = _b64urlDecode(subKeys.p256dh);  // 65 bytes (0x04||X||Y)
  const authSecret = _b64urlDecode(subKeys.auth);   // 16 bytes

  // 1) Ephemeral ECDH keypair
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  // 2) Import subscriber's public key for ECDH
  const subPubKey = await crypto.subtle.importKey(
    "raw", subPubRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false, [],
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: subPubKey },
    ephemeral.privateKey,
    256,
  ));

  // 3) HKDF chain per RFC 8291
  // PRK_key   = HKDF(salt=auth, IKM=ecdhSecret, info="WebPush: info\0"||subPub||ephPub, len=32)
  // salt      = random 16 bytes
  // IKM       = HKDF(salt=auth_above, IKM=PRK_key, info="Content-Encoding: aes128gcm\0", len=32)  -- (uses Web Push spec variant)
  // Actually RFC 8291 §3.4:
  //   PRK_key = HMAC-SHA-256(auth_secret, ecdhSecret)
  //   key_info = "WebPush: info" || 0x00 || ua_public || as_public
  //   IKM = HMAC-SHA-256(PRK_key, key_info || 0x01)
  //   salt = random 16 bytes
  //   PRK = HMAC-SHA-256(salt, IKM)
  //   cek_info = "Content-Encoding: aes128gcm" || 0x00
  //   CEK = HMAC-SHA-256(PRK, cek_info || 0x01)[:16]
  //   nonce_info = "Content-Encoding: nonce" || 0x00
  //   nonce = HMAC-SHA-256(PRK, nonce_info || 0x01)[:12]
  const prkKey = await _hmacSha256(authSecret, ecdhSecret);
  const keyInfo = _concat(
    new TextEncoder().encode("WebPush: info\0"),
    subPubRaw, ephPubRaw,
    new Uint8Array([0x01]),
  );
  const ikm = await _hmacSha256(prkKey, keyInfo);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await _hmacSha256(salt, ikm);
  const cekInfo = _concat(new TextEncoder().encode("Content-Encoding: aes128gcm\0"), new Uint8Array([0x01]));
  const cek = (await _hmacSha256(prk, cekInfo)).slice(0, 16);
  const nonceInfo = _concat(new TextEncoder().encode("Content-Encoding: nonce\0"), new Uint8Array([0x01]));
  const nonce = (await _hmacSha256(prk, nonceInfo)).slice(0, 12);

  // 4) AES-128-GCM: pad plaintext with 0x02 || 0x00 padding terminator,
  //    then encrypt with CEK and nonce.
  const padded = _concat(ptBytes, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    aesKey, padded,
  ));

  // 5) Assemble RFC 8188 binary header: salt(16) || rs(4 BE) || idlen(1) || keyid(idlen)
  const rs = new Uint8Array([0x00, 0x00, 0x10, 0x00]); // record size 4096
  const idLen = new Uint8Array([ephPubRaw.length]);   // 65 for P-256 uncompressed
  return _concat(salt, rs, idLen, ephPubRaw, ciphertext).buffer;
}

async function _hmacSha256(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

function _concat(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.byteLength; }
  return out;
}

function _b64urlEncode(bytes) {
  let bin = "";
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function _b64urlDecode(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
