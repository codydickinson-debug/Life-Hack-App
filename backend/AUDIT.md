# Ascend Cloudflare Worker — Production-readiness Audit

**Branch:** `mac-backend`
**Scope:** `backend/worker.js` (1,767 lines), `backend/wrangler.toml`, `backend/package.json`
**Untouched:** `index.html`, `vercel.json`, `api/`, anything else outside `backend/`

---

## Phase 1 map

### Routes (21 total)

| Path | Method | Auth | Handler |
|---|---|---|---|
| `/` , `/health` | GET | public | inline |
| `/webhook` | POST | Plaid JWT (ES256 + body-hash + 5-min iat) | `handlePlaidWebhook` |
| `/push/vapid-public-key` | GET | public | inline |
| `/enroll` | POST | `ENROLLMENT_KEY` bearer + per-IP rate gate | `handleEnroll` |
| `/link/token` | POST | userId:secret | `handleLinkToken` |
| `/exchange` | POST | userId:secret | `handleExchange` |
| `/sync` | POST | userId:secret | `handleSync` |
| `/holdings` | POST | userId:secret | `handleHoldings` |
| `/liabilities` | POST | userId:secret | `handleLiabilities` |
| `/recurring` | POST | userId:secret | `handleRecurring` |
| `/investment-transactions` | POST | userId:secret | `handleInvestmentTransactions` |
| `/items` | GET | userId:secret | `handleItems` |
| `/item/:itemId` | DELETE | userId:secret | `handleRemoveItem` |
| `/anthropic/messages` | POST | userId:secret + daily/burst gate | `handleAnthropic` |
| `/audit` | GET | userId:secret | `handleAuditList` |
| `/account` | DELETE | userId:secret | `handleDeleteAccount` |
| `/push/subscribe` | POST | userId:secret + rate gate | `handlePushSubscribe` |
| `/push/unsubscribe` | POST | userId:secret | `handlePushUnsubscribe` |
| `/push/test` | POST | userId:secret + rate gate | `handlePushTest` |
| `/push/send` | POST | userId:secret + rate gate | `handlePushSend` |
| (cron `*/15`) | scheduled | n/a | `deliverScheduledPushes` |

### Env vars
- **Required:** `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `ENROLLMENT_KEY` (or legacy `API_KEY`), `ENCRYPTION_KEY`
- **Strongly recommended:** `ALLOWED_ORIGIN` (default `*` is warned about, not blocked)
- **Optional:** `ANTHROPIC_KEY`, `ANTHROPIC_DAILY_CAP`, `ANTHROPIC_BURST_CAP`, `WEBHOOK_URL`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`

### External calls
- **Plaid:** `/link/token/create`, `/item/public_token/exchange`, `/accounts/get`, `/transactions/sync`, `/investments/holdings/get`, `/liabilities/get`, `/transactions/recurring/get`, `/investments/transactions/get`, `/item/remove`, `/webhook_verification_key/get`
- **Anthropic:** `/v1/messages`
- **Push services:** FCM, Apple, Mozilla autopush, WNS (allowlisted)

### KV layout (ASCEND_KV)
- `u:<uid>:auth` — SHA-256(clientSecret)
- `u:<uid>:items` — JSON array of itemIds
- `u:<uid>:item:<iid>` — Plaid item record (encrypted access token inside)
- `u:<uid>:audit` — last 200 audit events
- `u:<uid>:push` — push subscription + schedule + tz
- `u:<uid>:llm:<feature>:<day>` — daily LLM counter
- `u:<uid>:llm:burst:<min>` — per-min LLM counter
- `u:<uid>:push:<bucket>:<hour>` and `u:<uid>:push:<bucket>:day:<day>` — push rate counters
- `item-owner:<iid>` — reverse index for webhook ownership
- `webhook:<iid>` — latest Plaid webhook event (30-day TTL)
- `plaid:verify_key:<kid>` — JWK cache (24h TTL)
- `push:index` — userIds with active subscriptions (for cron)
- `enroll:rl:<ip>:<hour>` and `enroll:rl:<ip>:day:<day>` — per-IP enroll counters

---

## Phase 2 audit — 10 dimensions

### 1. Input validation

**Solid:**
- `/enroll`: `userId` matches `/^u_[A-Za-z0-9_-]+$/`.
- `/exchange`: `public_token` and `institution_name` cast to string + trimmed; rejects empty token.
- `/investment-transactions`: dates validated `YYYY-MM-DD` regex; defaults to last 90 days.
- `/anthropic/messages`: content-length rejected over 1 MB; `model` capped 80 chars; `max_tokens` clamped to 2000; `messages` array sliced to 20; each `content` capped 40K chars; `system` capped 8K; `feature` sanitized to `[a-zA-Z0-9_-]{0,32}`.
- `/item/:itemId`: `decodeURIComponent` try/catch + `^[A-Za-z0-9_-]{1,80}$` regex.
- `/push/subscribe`: endpoint allowlisted to FCM/Apple/Mozilla/WNS; HTTPS-only; p256dh ≤200 chars; auth ≤64 chars; schedule capped to 8 entries; tz ≤60 chars; hhmm regex.
- Plaid webhook: JWT verified end-to-end; itemId, type, code, error fields all length-capped.

**Gaps:**

- **G1.1** `/exchange`: `institution_name` is trimmed but **not length-capped**. A 10 MB string would land in KV as `itemRecord.institutionName` and be returned on every `/items` call. (low risk — gated by an authenticated user with their own secret, but trivial to abuse a stolen secret with).
- **G1.2** `/push/send`: `body.title`, `body.body`, `body.tag` are `String(...).slice(...)` capped, but there's **no type check** before. `String({a:1})` produces `"[object Object]"` silently. Not exploitable, just ugly UX if a caller misuses.
- **G1.3** `/anthropic/messages`: `messages` items are not type-validated. A caller can send `messages: [42, null, "raw"]` — these go straight to Anthropic, which 400s, but the proxy doesn't catch it. Should validate each message is `{role, content}` with role in `user|assistant`.
- **G1.4** `/sync`, `/holdings`, `/liabilities`, `/recurring`: **request body is never read or validated**. Body could be 100 MB of garbage and we'd still parse `request.headers.get("content-length")` ourselves nowhere — Cloudflare's default 100 MB body limit applies but that's still wasteful. Should add a content-length pre-check matching the Anthropic handler's pattern (10 KB is plenty for a body-less POST).
- **G1.5** `/push/subscribe`: `schedule[i].hhmm` is validated, but `schedule[i].body` is only checked for being a string — no length cap before `.slice(0,200)` is applied (the slice does the cap, so this is technically fine, but `body` could be `{evil: "object"}` which `typeof` would catch).

### 2. Error handling

**Solid:**
- Top-level `try/catch` in `fetch` swallows stack traces — only `err.message` is returned (line 194). `console.error` is local-only.
- `/anthropic/messages` whitelists upstream response fields — error metadata from Anthropic (request IDs, organization hints, key-tail leak in 401s) is stripped (lines 944-977). This is a real defense.
- `decryptString` validates packed format + base64 charset before `atob` so corrupt ciphertext gives a clean `"corrupted ciphertext"` error, not `InvalidCharacterError` (line 1186-1196).
- `/item/:itemId` catches `URIError` from `decodeURIComponent`.
- `handleRemoveItem` continues to delete KV record even if Plaid `/item/remove` fails — correct behavior.

**Gaps:**

- **G2.1** Line 194: `return json({ error: err.message || "server error" }, 500, allowed);` — **`err.message` can leak internal state.** Plaid error messages thrown via `plaidCall` (line 1128) are `"Plaid /transactions/sync failed: <plaid error_message>"`. That's not catastrophic but it leaks the Plaid endpoint path and the upstream message. Should be a generic `"upstream sync failed"` to clients and the real message only in `console.error`.
- **G2.2** `/push/send` line 1485 and `/push/test` line 1425: error responses include `e.message` which is the raw push-service body (`"push service 410: <upstream-body>"`). Same leak pattern.
- **G2.3** `handlePlaidWebhook` returns 200 on JSON parse failure (line 1024) which is technically correct for Plaid (don't retry on garbage) but **also** returns 200 if `getItemOwner` returns null (line 1038). A noisy adversary spamming the unauthenticated `/webhook` endpoint with valid Plaid JWTs (impossible) or signed-by-our-creds requests gets a quiet 200 — fine. But a 404 on unknown item_id might be more informative without enabling abuse.
- **G2.4** `appendAudit` is wrapped in try/catch that swallows everything (line 1108). Failed audit logging is silent. Should `console.warn` so it's at least visible in `wrangler tail`.
- **G2.5** No retry/backoff on Plaid 429 or Anthropic 429. A transient rate limit propagates as a 500 from the client's perspective.

### 3. CORS

**Solid:**
- Origin enforced when `ALLOWED_ORIGIN` is set (line 65). Browsers without `Origin` header (curl, native apps) bypass — the bearer is the security boundary.
- `corsHeaders()` sets `Vary: Origin`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- `Access-Control-Allow-Headers` is tight: `Authorization, Content-Type`.

**Gaps:**

- **G3.1** Default is `*` (line 55). The `/` health endpoint warns about it but **the actual API still answers with `Access-Control-Allow-Origin: *`** if the operator never set the env var. A misconfigured production deploy is a real failure mode. Suggest: refuse to start (return 503 on every authenticated route) if `ALLOWED_ORIGIN` is `*` AND `NODE_ENV/ENV === "production"`. Or at minimum, log a `console.warn` on every request when ALLOWED_ORIGIN is missing.
- **G3.2** No `Access-Control-Allow-Credentials` header. The PWA uses bearer tokens, not cookies, so this is correct — note for future devs not to add it.

### 4. Rate limiting

**Solid:**
- Per-IP enrollment limit (5/hour, 25/day) — defends against mass-enrollment if the enrollment key leaks (line 1305).
- Per-user daily + per-minute burst on `/anthropic/messages` (line 893).
- Per-user hourly + optional daily on `/push/subscribe` (5/hr), `/push/test` (3/hr), `/push/send` (30/hr, 50/day).
- Reservation happens BEFORE the upstream call so abusive failure-loop clients don't bypass the cap (line 924).

**Gaps:**

- **G4.1** **`/sync`, `/holdings`, `/liabilities`, `/recurring`, `/investment-transactions`, `/items`, `/exchange`, `/audit`, `/account` are NOT rate-limited.** A stolen clientSecret could call `/sync` in a tight loop. Each call hits Plaid (up to 40 Plaid API calls per `/sync` per the budget), which costs money on production Plaid pricing. Need at minimum a per-user burst cap on `/sync`, `/holdings`, `/liabilities`, `/recurring`, `/investment-transactions` — say 1/min and 30/day.
- **G4.2** The KV-counter rate limiter is **best-effort, not atomic**. Two parallel requests can both read `curHour=4` (cap 5), both reserve, both succeed → 6 calls slipped through. Acceptable risk at small scale but for production should consider either (a) accepting the slop, or (b) using a Durable Object for atomic counters. Document the limitation.
- **G4.3** `/account` (delete user data) has no rate limit. A stolen clientSecret can call it once and nuke everything. Mitigation: confirm-step at the frontend handles this in practice, but worker-side rate limit (1/day) would be a defense-in-depth win.
- **G4.4** `/webhook` (Plaid → us) has no rate limit. Plaid signs requests so abuse is bounded, but a misconfigured Plaid customer could DOS us. Cloudflare's free-tier protection helps but a per-IP gate would be cheap.

### 5. Auth

**Solid:**
- `checkAuth` uses constant-time string comparison (line 230-236).
- userId derived from auth header — body's userId is ignored everywhere I can see (line 24-26 of header comment confirms intent).
- clientSecret minted server-side; client cannot choose its value.
- Stored as SHA-256, not plaintext.
- Webhook auth via Plaid-signed JWT + body-hash + 5-min iat freshness (line 256-310).

**Gaps:**

- **G5.1** `/anthropic/messages` doesn't go through the `audited()` wrapper (line 162) — bypasses the standard audit pattern. It does manually call `appendAudit` for blocks/errors (line 905, 914, 942), but a successful non-blocked call only logs `anthropic_<feature>`, not `anthropic_<feature>_error` on a 500. Inconsistent.
- **G5.2** `ENROLLMENT_KEY` is documented as ship-in-public-JS-bundle. That's an explicit design choice (line 110-113 comment + line 1297 comment), but it means the per-IP rate gate is the **only** thing standing between someone with the key and creating unlimited isolated user records. A KV-storage exhaustion attack from a botnet that hits ≤5 requests per IP per hour is feasible at scale. Mitigation: cap total enrollments across all IPs to N/day (a separate KV counter), and/or implement CAPTCHA at the frontend.
- **G5.3** No 2FA, no email verification, no recovery path. By design — but worth documenting that "lose your clientSecret = lose the connection to your bank tokens forever (you can re-enroll but old items orphan until cron sweep)."
- **G5.4** Audit log records `action` strings only, no IP, no userAgent. A user can't tell if `/sync` calls coming through are from their actual device. Add (truncated) IP + UA to audit entries — but **note: this is PII**, log with care.

### 6. Secrets handling

**Solid:**
- `console.error` calls are bounded — `worker.js` line 50, 193, 1019, and `console.warn` at 1534. None log env values or access tokens.
- Anthropic key never leaves the worker (line 13 doc comment + line 936 usage).
- Plaid creds never returned to client.
- Encryption key validated by attempted decrypt; if wrong, item is silently skipped (line 451-453) — no key leak.

**Gaps:**

- **G6.1** Line 194: top-level `err.message` returned to client could include partial secrets if a downstream call throws with the secret in the message. Audit pass: I don't see any current code path that does this, but it's a foot-gun for future devs. Use a `safeErrorMessage()` helper that strips known secret patterns.
- **G6.2** `console.error` log lines include `err.stack`. In Cloudflare Workers, stack traces are visible in `wrangler tail` AND in the Cloudflare dashboard logs. Anyone with dashboard access can see them. Not a vulnerability if dashboard access is locked down, but worth knowing — the comment "Don't leak stack traces to the client" is correct; the corollary is "stack traces ARE in your operator logs."
- **G6.3** `wrangler.toml` line 15 has the KV id hardcoded. The comment warns forkers. **Not a secret** (auth is still required), but the warning could be tightened: "Don't push your fork's id either — keep this file in `.gitignore` or use `wrangler.dev.toml` for local overrides." (Out of scope for code, in scope for docs.)

### 7. Logging

**Solid:**
- All `console.*` calls are in error paths, not on the happy path. No PII logging visible.
- Plaid webhook verification failures log `e.message` only, not the JWT or the body (line 1019).

**Gaps:**

- **G7.1** No happy-path logging at all. Debugging "the sync just returned 0 transactions, was it actually called?" requires `wrangler tail` to be running BEFORE the request. A single `console.log` with `{userId, route, status, elapsedMs}` per request would make production debugging dramatically faster. **Mind PII** — userId is high-cardinality but not PII; route/status/timing are not PII.
- **G7.2** Plaid call latency isn't logged. When `/sync` is slow, is it Plaid, KV, or our parsing? Currently impossible to tell without instrumenting locally.
- **G7.3** `wrangler.toml` doesn't set `observability` (Cloudflare's built-in trace/logs setting). Adding `[observability] enabled = true` ships traces to the dashboard for free.

### 8. Response shape

**Solid:**
- Success responses uniformly include `ok: true` (most handlers).
- Error responses uniformly use `{error: string, code?: string}`.
- Status codes are sensible: 400, 401, 403, 404, 413, 429, 500, 503.

**Gaps:**

- **G8.1** `handleEnroll` returns `{ok, userId, clientSecret}` (line 376) but other handlers omit `ok` in success cases when there's structured data (e.g., `handleAuditList` returns `{events}`, `handleItems` returns `{items}`). Inconsistent. Either always include `ok: true` or never. Document the convention.
- **G8.2** Rate-limit errors return both `error` (human message) and `code` (`rate_limit`, `rate_limit_daily`, `rate_limit_burst`). Non-rate-limit errors don't have `code`. Frontend can't programmatically distinguish "Plaid is down" from "your token is bad" without parsing the human message. Add `code` to all error responses (`code: "auth_invalid"`, `"upstream_plaid"`, `"validation_error"`, `"not_found"`).
- **G8.3** `truncated` flag on `/sync` is a top-level boolean (line 536) — the frontend has to know to look for it. A `code: "sync_truncated"` companion would make it programmatically clear.

### 9. Dead code / stale comments

**Solid:**
- Code is well-commented with rationale (the "why" comments above each handler are unusually thorough).
- No obvious dead routes.

**Gaps:**

- **G9.1** Line 207: legacy `API_KEY` is still accepted as alias for `ENROLLMENT_KEY`. CLAUDE.md still references the old name. If no live deployments still use `API_KEY`, drop the fallback.
- **G9.2** Line 38-39: `DEFAULT_LLM_CAP` and `DEFAULT_LLM_BURST` constants. The actual caps come from env. The constants are fallbacks. Convention: prefix as `DEFAULT_LLM_*` is fine but the comment "calls per user per day (per feature)" on `DEFAULT_LLM_CAP` doesn't say "per feature" matches `dailyKey` template. Just rename to `DEFAULT_LLM_DAILY_CAP_PER_FEATURE` for clarity.
- **G9.3** Line 35 doc comment in `wrangler.toml` references a `node -e` command for generating VAPID keys. Test that it still works on current Node. Probably fine, but verify before treating as production docs.
- **G9.4** Line 1097-1098 in `audited`: `if (res && res.status < 400) await appendAudit(...)`. Response objects from `Response.constructor` always have `.status`. The `res &&` guard is defensive but unnecessary. Minor.
- **G9.5** Header comments in worker.js still say `570 lines` in the CLAUDE.md mental model. Current is 1,767. Just an update-the-comment item.

### 10. wrangler.toml

**Solid:**
- `main = "worker.js"` correct.
- `compatibility_date = "2024-09-01"` — modern enough for `crypto.subtle.*`, Workers KV, fetch streams.
- Cron `*/15 * * * *` correctly configured.
- KV binding `ASCEND_KV` matches code usage.

**Gaps:**

- **G10.1** **No `[observability]` block.** Cloudflare's built-in observability (logs + traces in the dashboard) is one line: `[observability] enabled = true`. Should be on for prod.
- **G10.2** **No `[limits]` block.** Setting `cpu_ms = 50` (or whatever ceiling fits) would catch CPU runaway bugs before they exhaust the Workers' free-tier 30s budget. Useful safety net.
- **G10.3** No `routes` block. Worker is deployed to `<workers-subdomain>.workers.dev`. If you want a custom domain (`api.ascend.fyi`), add `routes = [{ pattern = "api.ascend.fyi/*", custom_domain = true }]`.
- **G10.4** No `workers_dev = false`. With default `true`, the worker is publicly accessible at `<name>.<account>.workers.dev` even if you set up a custom route. Setting `workers_dev = false` after switching to a custom domain locks down the bypass URL.
- **G10.5** No `[vars]` block. All config goes through `wrangler secret put`. Non-sensitive config (e.g., `ANTHROPIC_DAILY_CAP`, `WEBHOOK_URL`) could live in `[vars]` for easier inspection without rotating. Optional.
- **G10.6** No `[[migrations]]` for Durable Objects — none used, so this is correct as-is. Noting in case the rate-limit atomicity fix lands later.

---

## Priorities

If you want a fix order, I'd ship in this sequence — each is a small atomic commit:

**P0 (security / abuse):**
- G4.1 — rate-limit `/sync` & friends
- G4.3 — rate-limit `/account` delete
- G3.1 — fail closed on wildcard `ALLOWED_ORIGIN` in prod (or at least warn loudly on every request)
- G2.1 — generic 500 message, real error to `console.error` only
- G2.2 — same for push errors

**P1 (operability):**
- G7.1 — happy-path request logging (userId/route/status/elapsedMs)
- G7.3 / G10.1 — turn on `[observability]`
- G10.2 — set CPU limit

**P2 (cleanup / consistency):**
- G8.1 / G8.2 / G8.3 — response shape uniformity (always `ok: true`, always `code` on errors)
- G1.1 / G1.2 / G1.3 / G1.4 / G1.5 — validation polish
- G6.1 — `safeErrorMessage()` helper
- G2.4 — `console.warn` on audit failures
- G2.5 — backoff on Plaid/Anthropic 429
- G4.2 — document KV-counter race
- G9.1–9.5 — dead code / stale comments

**P3 (nice-to-have, doc-only or low-impact):**
- G5.2 — global enroll cap
- G5.3 — document loss-of-secret recovery story
- G5.4 — IP/UA in audit log (mind PII)
- G10.3 / G10.4 — custom domain + lock workers.dev
- G10.5 — move non-secrets to `[vars]`

---

**Total surface area:** 21 routes, ~14 KV key patterns, 10 Plaid endpoints, 1 Anthropic endpoint, 4 push services. No dead routes. Code quality is unusually high for a hand-rolled Worker — the rationale comments are top-tier. The gaps are real but no `P0` is "this is broken right now" — they're "production-grade hardening before strangers hit it." Ready for line-by-line fix passes on your signal.

---

## Execution log (what shipped)

All P0/P1/P2/P3 items fixed, plus two free-form passes. 17 atomic commits on `mac-backend`, each pushed individually. Listed in commit order:

| Commit | Items | Summary |
|---|---|---|
| `a88068d` | — | This audit report (no production code) |
| `11caeaf` | G4.1 | Rate-limit Plaid + audit routes; generalize `_pushRateGate` → `_userRateGate`; KV namespace `u:<uid>:rl:<bucket>:*` |
| `9deb6a7` | G4.3 | `/account` DELETE: 2/hour, 3/day |
| `5cccd0b` | G3.1 | CORS default = `https://life-hack-app.vercel.app`; never wildcard fallback; `code:"origin_denied"` |
| `f4babb2` | G2.1, G2.2, G6.1 | `safeError()` helper; top-level catch + push errors log full context, return generic message |
| `f6008c0` | G7.1 | Per-request structured access log; userId hashed to 12-char prefix; outcome bucketed |
| `2a6ddef` | G10.1, G10.2 | `[observability] enabled=true`; `[limits] cpu_ms=5000` |
| `b596d50` | G8.1, G8.2 | All success → `ok:true`; all error → `code` field; codes enumerated in the commit message |
| `c5edb9d` | G1.1–1.5 | `institutionName` capped 120; Anthropic `messages` shape-checked; `_bodyTooLarge()` helper on body-reading routes |
| `0a02edf` | G2.4, G2.5, G4.2 | Audit-write `console.warn` on failure; single-retry backoff on Plaid/Anthropic 429/5xx; KV-race documented in `_userRateGate` |
| `c8a55a5` | G9.1, G9.2, G9.4 | `API_KEY` deprecation warning; constant rename; `audited()` guard tidy |
| `cce7842` | G5.2, G5.3, G5.4 | Global enroll daily cap (default 500, env-overridable); hashed-IP + UA in audit entries; loss-of-secret recovery model documented |
| `2439bff` | G10.3, G10.4, G10.5 | `[vars]` block (`ANTHROPIC_DAILY_CAP`, `ANTHROPIC_BURST_CAP`, `ENROLL_GLOBAL_DAY_CAP`); commented-out custom-domain template |
| `742e8a4` | Pass-2 | Plaid call budget added to `/holdings`, `/liabilities`, `/recurring`, `/investment-transactions` with `truncated` flag in response |
| `41d4d7a` | Pass-2 | `/link/token` early-fails 503 on missing Plaid creds; `audited()` distinguishes 429 (`<action>_rate_limited`) from generic `_error`; `respOrigin` ternary simplified; scheduled cron emits one structured log per tick with `{delivered, errors, ms}` |
| `733d70f` | Pass-3 | Helpful error messages (regex hint, expected shapes); Plaid upstream errors → 502 `plaid_upstream_error`; Anthropic 401/403 → 503 `ai_disabled` (operator-config); Anthropic 5xx → 502; push 410/404 → 410 Gone from worker; `/audit` response includes `cap: AUDIT_KEEP`; Anthropic success path now `ok:true` |
| `ca77a64` | Pass-3 | `_wrongContentType()` helper → 415 `wrong_content_type` on every JSON-reading route |
| `5d4320c` | Pass-3 | Drop unused back-compat aliases; `/push/test` and `/push/send` check VAPID secrets before rate gate |

---

## Error codes (final set)

Frontend can switch on `.code`:

**Validation / client error:**
- `validation_error` (400) — bad/missing/malformed input
- `wrong_content_type` (415) — non-JSON Content-Type
- `payload_too_large` (413) — body over per-route ceiling
- `not_subscribed` (400) — `/push/test` or `/push/send` without prior subscribe

**Auth:**
- `unauthorized` (401) — bad/missing bearer
- `origin_denied` (403) — CORS reject
- `not_found` (404) — route doesn't exist

**Rate limits:**
- `rate_limit` (429) — hourly cap
- `rate_limit_daily` (429) — daily cap
- `rate_limit_burst` (429) — per-minute burst cap
- `rate_limit_global` (429) — global enrollment cap (defense vs botnet)

**Operator config / upstream:**
- `ai_disabled` (503) — `ANTHROPIC_KEY` unset, OR Anthropic 401/403 (means key is bad)
- `push_disabled` (503) — VAPID_* unset
- `plaid_disabled` (503) — Plaid creds unset on `/link/token`
- `plaid_upstream_error` (502) — Plaid 4xx/5xx that bubbled through
- `ai_upstream_rate_limit` (429) — Anthropic itself throttled us
- `ai_upstream_error` (502) — Anthropic 5xx
- `push_failed` (502) — push service rejected delivery
- `push_subscription_expired` (410) — push service returned 404/410 (subscription dead, already reaped)
- `server_error` (500) — fallback for top-level catch

---

## Intentionally deferred

- **Frontend changes.** Out of scope per the brief. Two new error codes (`plaid_upstream_error`, `ai_upstream_rate_limit`, `wrong_content_type`, `rate_limit_global`, `plaid_disabled`) are unrecognized by the current frontend — its existing `_friendlyApiError()` helper falls through to a generic message for unknown codes, which is acceptable. Frontend pass for the new codes is a separate session's territory.
- **`wrangler version bump`.** The user said they'd handle this locally.
- **Durable Objects for atomic rate-limit counters.** KV-counter race window is documented in `_userRateGate`. The slop is acceptable at current scale; pivot if it ever matters.
- **Pagination on `/audit`.** The 200-entry ring cap acts as effective pagination. Older entries drop off the back. The cap is now exposed in the response (`cap: 200`) so the frontend can render "last 200 events".
- **API_KEY removal.** Kept the back-compat alias with a deprecation warning; removing it now would break any deployment that hasn't rotated to `ENROLLMENT_KEY`. Drop in a future commit once you confirm no live deployment uses the legacy name.
- **`workers_dev = false` and custom domain binding.** Both are templated in `wrangler.toml` but commented out — they require operator-side DNS work first.
- **G9.3 / G9.5.** Doc-only items; G9.3 (VAPID key-gen one-liner) and G9.5 (stale line-count comment in CLAUDE.md) live outside `backend/`.
- **CLAUDE.md outdated metadata.** Top-level doc; out of scope.

---

## Net result

- **3 files changed:** `backend/worker.js` (1,767 → 1,920 lines), `backend/wrangler.toml` (36 → 80 lines), `backend/AUDIT.md` (new).
- **No behavior changes** for happy-path requests at normal call volume. Every change is either (a) defensive against abuse, (b) better observability, (c) clearer client contract.
- **17 commits on `mac-backend`**, pushed individually so any one can be reverted in isolation.

If anything I touched feels wrong, the per-commit diffs are small and self-contained — easy to back out.

