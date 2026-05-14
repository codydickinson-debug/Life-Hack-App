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
 *     body { userId, clientSecret }. Worker stores SHA-256 of clientSecret at u:<userId>:auth.
 *   - All other endpoints require `Authorization: Bearer <userId>:<clientSecret>`. Worker derives the
 *     userId from the auth header, ignoring any userId in the request body (prevents spoofing).
 *   - Audit log is written to u:<userId>:audit (capped JSON array of recent events).
 */

const PLAID_HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com",
};

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const AUDIT_KEEP = 200;          // last N audit events per user
const DEFAULT_LLM_CAP = 50;      // calls per user per day (per feature)
const DEFAULT_LLM_BURST = 10;    // calls per user per minute (global across features)
const WEBHOOK_KEEP_DAYS = 30;    // Plaid webhook events expire after N days

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const allowed = env.ALLOWED_ORIGIN || "*";
    const reqOrigin = request.headers.get("Origin") || "";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(allowed) });
    }

    // Origin enforcement: if a browser sends Origin and it doesn't match ALLOWED_ORIGIN
    // (and ALLOWED_ORIGIN isn't "*"), reject. Non-browser clients (no Origin header) bypass.
    if (allowed !== "*" && reqOrigin && reqOrigin !== allowed) {
      return json({ error: "origin not allowed" }, 403, allowed);
    }

    // Public endpoints
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "ascend-backend", version: "v3" }, 200, allowed);
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

    try {
      const auth = await checkAuth(request, env, url);
      if (auth.error) return json({ error: auth.error }, auth.status || 401, allowed);

      // Enrollment is gated by ENROLLMENT_KEY only
      if (url.pathname === "/enroll" && request.method === "POST") {
        if (auth.mode !== "enrollment") return json({ error: "enrollment key required" }, 401, allowed);
        return await handleEnroll(request, env, allowed);
      }

      // Everything else needs a real user identity
      if (auth.mode !== "user") {
        return json({ error: "user authentication required (enroll first)" }, 401, allowed);
      }
      const userId = auth.userId;

      if (url.pathname === "/link/token" && request.method === "POST") {
        return await audited(env, userId, "link_token",
          () => handleLinkToken(env, userId, allowed));
      }
      if (url.pathname === "/exchange" && request.method === "POST") {
        return await audited(env, userId, "exchange",
          () => handleExchange(request, env, userId, allowed));
      }
      if (url.pathname === "/sync" && request.method === "POST") {
        return await audited(env, userId, "sync",
          () => handleSync(env, userId, allowed));
      }
      if (url.pathname === "/holdings" && request.method === "POST") {
        return await audited(env, userId, "holdings",
          () => handleHoldings(env, userId, allowed));
      }
      if (url.pathname === "/items" && request.method === "GET") {
        return await handleItems(env, userId, allowed);
      }
      if (url.pathname.startsWith("/item/") && request.method === "DELETE") {
        return await audited(env, userId, "item_remove",
          () => handleRemoveItem(url, env, userId, allowed));
      }
      if (url.pathname === "/anthropic/messages" && request.method === "POST") {
        return await handleAnthropic(request, env, userId, allowed);
      }
      if (url.pathname === "/audit" && request.method === "GET") {
        return await handleAuditList(env, userId, allowed);
      }
      if (url.pathname === "/account" && request.method === "DELETE") {
        return await handleDeleteAccount(env, userId, allowed);
      }
      return json({ error: "not found" }, 404, allowed);
    } catch (err) {
      // Don't leak stack traces to the client
      console.error("worker error", err && err.stack || err);
      return json({ error: err.message || "server error" }, 500, allowed);
    }
  },
};

// ============ Auth ============

async function checkAuth(request, env, url) {
  const raw = request.headers.get("Authorization") || "";
  const m = raw.match(/^Bearer\s+(.+)$/);
  if (!m) return { error: "unauthorized", status: 401 };
  const token = m[1];

  // Enrollment key (back-compat: accept either ENROLLMENT_KEY or legacy API_KEY)
  const enrollKey = env.ENROLLMENT_KEY || env.API_KEY || "";
  if (enrollKey && timingSafeEqStr(token, enrollKey)) {
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

async function sha256hex(s) {
  const data = new TextEncoder().encode(s);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// ============ Endpoint handlers ============

async function handleEnroll(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const userId = String(body.userId || "").trim();
  const clientSecret = String(body.clientSecret || "").trim();
  if (!/^u_[A-Za-z0-9_-]+$/.test(userId)) return json({ error: "invalid userId" }, 400, origin);
  if (clientSecret.length < 32) return json({ error: "clientSecret too short (min 32 chars)" }, 400, origin);

  const hash = await sha256hex(clientSecret);
  await env.ASCEND_KV.put(`u:${userId}:auth`, hash);
  await appendAudit(env, userId, "enroll");
  return json({ ok: true, userId }, 200, origin);
}

async function handleLinkToken(env, userId, origin) {
  const params = {
    user: { client_user_id: userId },
    client_name: "Ascend",
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
  };
  // Wire Plaid up to our /webhook endpoint when WEBHOOK_URL is set. Plaid will
  // POST ITEM_ERROR / PENDING_EXPIRATION / USER_PERMISSION_REVOKED events here.
  if (env.WEBHOOK_URL) params.webhook = env.WEBHOOK_URL;
  const r = await plaidCall(env, "/link/token/create", params);
  return json({ link_token: r.link_token, expiration: r.expiration }, 200, origin);
}

async function handleExchange(request, env, userId, origin) {
  const body = await request.json().catch(() => ({}));
  const publicToken = String(body.public_token || "").trim();
  const institutionName = String(body.institution_name || "Bank").trim();
  if (!publicToken) return json({ error: "public_token required" }, 400, origin);

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

async function handleSync(env, userId, origin) {
  const itemIds = await getItemIndex(env, userId);
  const allTx = [];
  const allAccounts = [];
  const updated = [];

  for (const itemId of itemIds) {
    const recRaw = await env.ASCEND_KV.get(itemKey(userId, itemId));
    if (!recRaw) continue;
    const rec = JSON.parse(recRaw);
    let accessToken;
    try {
      accessToken = await decryptString(rec.accessTokenCipher, env.ENCRYPTION_KEY);
    } catch {
      continue; // skip if undecryptable (key mismatch)
    }

    // Pull accounts
    try {
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
    while (hasMore && safety++ < 10) {
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

    updated.push({ item_id: itemId, added: added.length, modified: modified.length, removed: removed.length });
  }

  return json({ ok: true, accounts: allAccounts, transactions: allTx, updated }, 200, origin);
}

async function handleItems(env, userId, origin) {
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
  return json({ items }, 200, origin);
}

async function handleRemoveItem(url, env, userId, origin) {
  const itemId = decodeURIComponent(url.pathname.split("/").pop() || "");
  if (!itemId) return json({ error: "itemId required" }, 400, origin);

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
  const itemIds = await getItemIndex(env, userId);
  const allHoldings = [];
  const allSecurities = {};

  for (const itemId of itemIds) {
    const recRaw = await env.ASCEND_KV.get(itemKey(userId, itemId));
    if (!recRaw) continue;
    const rec = JSON.parse(recRaw);
    let accessToken;
    try { accessToken = await decryptString(rec.accessTokenCipher, env.ENCRYPTION_KEY); }
    catch { continue; }

    try {
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

  return json({ ok: true, holdings: allHoldings }, 200, origin);
}

async function handleAnthropic(request, env, userId, origin) {
  if (!env.ANTHROPIC_KEY) {
    return json({ error: "AI insights not configured on this backend" }, 503, origin);
  }

  const body = await request.json().catch(() => ({}));
  // Validate + clamp the request to prevent abuse
  const model = String(body.model || "claude-haiku-4-5-20251001").slice(0, 80);
  const maxTokens = Math.min(parseInt(body.max_tokens, 10) || 800, 2000);
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, 20) : [];
  if (!messages.length) return json({ error: "messages required" }, 400, origin);
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

  const r = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });

  await appendAudit(env, userId, r.ok ? `anthropic_${feature}` : `anthropic_${feature}_error`);

  const text = await r.text();
  // Pass through whatever Anthropic returned, but never the API key
  return new Response(text, {
    status: r.status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

async function handleAuditList(env, userId, origin) {
  const raw = await env.ASCEND_KV.get(`u:${userId}:audit`);
  const events = raw ? JSON.parse(raw) : [];
  return json({ events }, 200, origin);
}

// ============ Plaid webhook receiver ============
// Plaid POSTs notification events here when an item breaks (re-auth required,
// permission revoked, etc.). We record the latest event per item_id with a
// 30-day TTL; /items surfaces it so the client can show a "reconnect bank"
// prompt without us needing a push channel.
//
// Security note: this endpoint is unauthenticated by design — Plaid won't
// have our enrollment key. For production, verify the Plaid-Verification JWT
// header against Plaid's JWK set (https://plaid.com/docs/api/webhooks/webhook-verification/).
// v1 takes a lighter approach: we always return 200 (so Plaid doesn't retry
// floods), but we only persist events that structurally look like Plaid
// webhooks and reference an actionable webhook_code.
async function handlePlaidWebhook(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response("", { status: 200 }); }

  const itemId = String(body.item_id || "").slice(0, 100);
  const type = String(body.webhook_type || "").toUpperCase().slice(0, 40);
  const code = String(body.webhook_code || "").toUpperCase().slice(0, 60);
  if (!itemId || !type) return new Response("", { status: 200 });

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

async function audited(env, userId, action, fn) {
  const res = await fn();
  // Only log if response looks successful
  try {
    if (res && res.status < 400) await appendAudit(env, userId, action);
    else await appendAudit(env, userId, action + "_error");
  } catch {}
  return res;
}

async function appendAudit(env, userId, action) {
  try {
    const key = `u:${userId}:audit`;
    const raw = await env.ASCEND_KV.get(key);
    const arr = raw ? JSON.parse(raw) : [];
    arr.unshift({ t: new Date().toISOString(), a: action });
    if (arr.length > AUDIT_KEEP) arr.length = AUDIT_KEEP;
    await env.ASCEND_KV.put(key, JSON.stringify(arr));
  } catch {}
}

// ============ Plaid client (no SDK) ============

async function plaidCall(env, path, body) {
  const host = PLAID_HOSTS[env.PLAID_ENV] || PLAID_HOSTS.sandbox;
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
  if (!r.ok) {
    const err = new Error(`Plaid ${path} failed: ${data.error_message || data.error_code || r.status}`);
    err.plaid = data;
    throw err;
  }
  return data;
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
}
async function removeItemFromIndex(env, userId, itemId) {
  const arr = await getItemIndex(env, userId);
  const next = arr.filter((x) => x !== itemId);
  await env.ASCEND_KV.put(indexKey(userId), JSON.stringify(next));
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
  const [ivB64, ctB64] = String(packed).split(":");
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
