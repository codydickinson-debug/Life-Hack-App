# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Ascend** — a personal habit/goal/money tracker shipped as an installable PWA. Two pieces:

- **Frontend**: a single static `index.html` (~5,200 lines, HTML + CSS + JS inline) plus `sw.js`, `manifest.json`, and icons. No build step, no framework, no bundler.
- **Backend** (optional, only for Plaid bank sync + AI insights): a single-file Cloudflare Worker in `backend/worker.js` (~570 lines) that brokers Plaid Link, transaction sync, AES-GCM-encrypted token storage in Cloudflare KV, and proxies Anthropic AI calls.

The app works fully offline with manual entry; the backend only enables automatic bank-account/transaction import and AI insights.

## Common commands

There is no build, lint, or test setup for the frontend. To work on it:

- **Run locally**: open `index.html` in a browser (double-click). The service worker won't register on `file://` — that's expected; everything else works.
- **Local dev with SW + HTTPS**: serve over a local HTTPS dev server if you need to test offline/install behavior (`npx serve` won't be HTTPS; use Netlify/Vercel deploy or `wrangler pages dev`).

Backend (`backend/`):

```bash
cd backend
npm install                       # installs wrangler
wrangler dev                      # local worker on http://127.0.0.1:8787
wrangler deploy                   # ships to Cloudflare (requires `wrangler login`)
wrangler tail                     # stream live production logs
wrangler kv namespace create ASCEND_KV    # one-time KV setup; paste id into wrangler.toml
wrangler secret put <NAME>        # set each of: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV, API_KEY, ENCRYPTION_KEY, ALLOWED_ORIGIN
```

Full first-time deploy walkthrough is in `DEPLOY.md`.

## Architecture

### Frontend: one file, one global, inline handlers

`index.html` is structured top-to-bottom as: design tokens → CSS → DOM skeleton → `<script>` containing the entire app.

- **State lives in a single `DB` object** declared with `var DB` (so it's reachable on `window` for debugging). Shape is defined by `DEFAULT_DB` near the top of the script. **Adding any new persisted field requires adding it to `DEFAULT_DB`** — `load()` merges saved data over `DEFAULT_DB`, so a missing default means the field won't survive reloads cleanly.
- **Persistence**: `localStorage["ascend_v2"]`. Every mutation should call `save()` (which is overwritten after declaration to encrypt-if-unlocked). Use `await save()` because the encrypted path is async — especially in handlers that may navigate, close a sheet, or `render()` immediately after, since fire-and-forget saves can lose changes if the user closes the tab during the encryption window. The codebase has many legacy non-`await`ed call sites; new code should use `await`.
- **Inline `onclick=`/`oninput=` handlers in rendered HTML** are the primary event-binding pattern. Any function called from rendered markup must be exposed on `window` via the big `Object.assign(window, {...})` block at the bottom of `init()`. Adding a new handler? Add it to that list.
- **When interpolating an untrusted string as a JS argument inside an inline handler, use `jsAttr(value)` — not `'${esc(value)}'`.** `esc()` is correct for HTML *text*, but inside an `onclick=` attribute the browser decodes entities *before* JS parses, so `'${esc("McDonald's")}'` produces broken JS. `jsAttr()` JSON-encodes the value (escaping `'`, `"`, `\`, newlines) and HTML-escapes the result, so `onclick="foo(${jsAttr(s)})"` is safe for any string. Use this for: merchant names, institution names, Plaid IDs, anything from outside the app.
- **Render model**: tab-scoped renderers (`renderToday`, `renderGoals`, `renderMoney`, `renderStats`, `renderSettings`) each replace the full `innerHTML` of their `<div class="page">`. The dispatcher is `render()`, called by `showTab()` and after every mutation. There's no diffing — re-render is cheap because pages are small.
- **`esc()` everywhere** when interpolating user data into HTML strings (the renderers build raw HTML with template literals).

### Frontend ↔ backend

- `api(path, opts)` in the script is the single fetch wrapper. It reads `DB.settings.backendUrl` and `DB.settings.apiKey` and sends `Authorization: Bearer <apiKey>`. If either is unset, calls throw — callers should `try`/`catch` and `toast()` the error.
- `ensureUserId()` lazily generates a per-device `DB.user.userId` and persists it (using the unencrypted `_origSave` to avoid recursion). Every backend call is keyed by this id.
- Plaid amount convention: **positive amount = outflow** (spend), negative = income/deposit. This is used directly throughout `DB.spend` and is what `processSyncedDeposits` and the spend UI assume.
- Plaid Link is loaded from CDN via `<script src="https://cdn.plaid.com/...">`; `connectBank()` calls the backend for a `link_token`, then opens `window.Plaid.create({...}).open()`.

### Two layers of encryption

1. **Server-side**: Plaid `access_token` values are AES-GCM encrypted with `ENCRYPTION_KEY` (a worker secret) before being written to KV. See `encryptString`/`decryptString` in `backend/worker.js`. A KV breach yields useless ciphertext without the key.
2. **Client-side (optional)**: if the user sets a passphrase, all of `DB` is AES-GCM encrypted before being written to `localStorage`. Key is derived via PBKDF2-SHA256 (250k iterations) and held only in memory as `APP_KEY`. On cold start, `load()` detects an encrypted envelope (`{v:1, salt, iv, ct}`) and `init()` shows `showLockScreen()` to prompt for the passphrase. **Forgotten passphrase = unrecoverable** by design — the only escape is `localStorage.clear()`.

The two layers use independent keys with different blast radius — do not collapse them.

### Service worker / cache versioning

`sw.js`:
- **Navigations + same-origin GETs (index.html, manifest.json, etc.) → network-first**, with cache fallback so the PWA still works offline. This means a fresh `index.html` is fetched on every load when online — no stale UI after deploy.
- **Icons → cache-first**, precached on install.
- **Cross-origin (Plaid CDN, etc.) → passthrough**, not intercepted by the worker.

Cache name is derived from a **SHA-256 hash of `index.html`** (first 4 bytes, hex). So when you ship a change to `index.html`, the cache name changes automatically and the old cache is purged on the next service-worker activation — no manual version bumping for normal iteration.

**Caveat**: icons are cache-first, so changing an icon file *alone* won't trigger an update on installed PWAs. To force-update icons, edit any byte of `sw.js` (the browser only re-checks the SW when its bytes change). New static files must be added to `STATIC_ASSETS`.

### Backend: single Worker, KV-backed

`backend/worker.js` is one ES module (~570 lines, no SDK). All Plaid calls go through `plaidCall(env, path, body)` which posts to `PLAID_HOSTS[env.PLAID_ENV]` with credentials.

- **Auth (per-device enrollment, not a shared key)**: every endpoint except `/`, `/health`, and `/enroll` requires `Authorization: Bearer <clientSecret>`. The first call from a new device hits `/enroll` with the operator's `ENROLLMENT_KEY` (legacy name: `API_KEY`); the worker mints a per-device `clientSecret`, stores `SHA-256(secret)` keyed to the device's `userId` in KV, and returns the secret to the client. After enrollment, the device sends its own secret on every call — the enrollment key is no longer used. A leaked per-device secret only impersonates one device.
- **CORS**: `ALLOWED_ORIGIN` secret should be the deployed PWA URL. The check is skipped when there's no `Origin` header (e.g. curl), so the security boundary is the bearer token, not CORS. Set `ALLOWED_ORIGIN` to `*` only temporarily.
- **KV layout**: per-user item index at `u:<userId>:items` (JSON array of itemIds), each item record at `u:<userId>:item:<itemId>` (`{itemId, institutionName, accessTokenCipher, cursor, ...}`). Update both when adding/removing items (helpers: `addItemToIndex`, `removeItemFromIndex`). Per-user secret hash at `u:<userId>:auth`. Per-user audit log at `u:<userId>:audit` (last 200 events).
- **Transactions sync** uses Plaid's cursor-based `/transactions/sync` endpoint with a 10-iteration safety cap; the cursor is persisted in the item record so resumes are incremental.
- **Anthropic proxy** (`POST /anthropic/messages`): the worker forwards browser requests to Anthropic using its own `ANTHROPIC_KEY` secret — the AI key never leaves the worker. Per-user daily cap (`ANTHROPIC_DAILY_CAP`, default 50) is enforced via KV counters. Upstream errors (including 401 from a bad ANTHROPIC_KEY) are returned with the upstream status code, so the frontend must distinguish worker auth-failures from Anthropic auth-failures before clearing the device enrollment.

### Other things worth knowing

- The `loadDemoData()` path overwrites `DB` but **carries over** `backendUrl`, `apiKey`, `anthropicKey`, `anthropicModel`, `theme`, and `userId` so demo mode doesn't kick the user out of their backend.
- AI insights (`fetchInsight`, `getMonthlyInsight`) call the Anthropic API **through the Cloudflare Worker proxy** (`POST {backendUrl}/anthropic/messages`). The Anthropic API key lives only as the worker's `ANTHROPIC_KEY` secret — it never touches the browser. The default model is `claude-haiku-4-5-20251001`. The worker enforces a per-user daily call cap (default 50) to bound runaway spend.
- Notifications use the in-page `Notification` API and a `setTimeout`-based `scheduleReminder` chain. **This only fires while the app/PWA is open** — true scheduled push when closed would require a server.
