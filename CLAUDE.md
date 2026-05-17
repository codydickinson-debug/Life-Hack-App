# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Ascend** — a personal habit/goal/money tracker shipped as an installable PWA. Three pieces:

- **Frontend**: a single static `index.html` (~38k lines / ~2.2 MB, HTML + CSS + JS inline) plus `sw.js`, `manifest.json`, and icons. No build step, no framework, no bundler. The size sounds large for a "static page" but the app ships ~95% of a desktop app's surface area as a PWA — every habit/goal/money/stocks/stats/calendar/settings view, the AI counselor surfaces, all the calculators, and the entire onboarding flow lives in this one file.
- **Vercel Python backend** (always on, deployed alongside the frontend): a Flask app under `stockanalyzer/` exposed at `/api/*` via `api/index.py`. Powers live stock quotes, market scans (SSE-streamed), housing/mortgage analysis, and an AI proxy for the in-app Cornileus counselor — keys live in Vercel env vars, never the browser. Standalone HTML view at `/stockanalyzer` (Flask templates + `stockanalyzer-static/`).
- **Cloudflare Worker backend** (optional, Plaid bank sync): single-file `backend/worker.js` brokers Plaid Link, transaction sync, and AES-GCM-encrypted token storage in Cloudflare KV. Only needed if the user wants auto bank import; the app works fully offline with manual entry otherwise.

## Common commands

There is no build, lint, or test setup for the frontend. To work on it:

- **Run locally**: `npx -y serve .` (or open `index.html` in a browser by double-click — SW won't register on `file://` but everything else works).
- **Deploy**: push to `main` on `codydickinson-debug/Life-Hack-App`; Vercel auto-deploys both the static site and the Python `/api/*` backend.

Python backend (`api/` + `stockanalyzer/`):

```bash
cd stockanalyzer
pip install -r requirements.txt
python app.py           # local Flask server on http://127.0.0.1:5000
```

Cloudflare Worker (`backend/`, optional):

```bash
cd backend
npm install                       # installs wrangler
wrangler dev                      # local worker on http://127.0.0.1:8787
wrangler deploy                   # ships to Cloudflare (requires `wrangler login`)
wrangler tail                     # stream live production logs
wrangler kv namespace create ASCEND_KV    # one-time KV setup; paste id into wrangler.toml
wrangler secret put <NAME>        # set each of: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV, API_KEY, ENCRYPTION_KEY, ALLOWED_ORIGIN
```

Full first-time deploy walkthrough is in `DEPLOY.md`. AI proxy setup notes are in `api/AI_PROXY_SETUP.md`.

## Architecture

### Frontend: one file, one global, inline handlers

`index.html` is structured top-to-bottom as: design tokens → CSS → DOM skeleton → `<script>` containing the entire app.

- **State lives in a single `DB` object** declared with `var DB` (so it's reachable on `window` for debugging). Shape is defined by `DEFAULT_DB` near the top of the script. **Adding any new persisted field requires adding it to `DEFAULT_DB`** — `load()` merges saved data over `DEFAULT_DB`, so a missing default means the field won't survive reloads cleanly.
- **Persistence**: `localStorage["ascend_v2"]`. Every mutation should call `save()` (which is overwritten after declaration to encrypt-if-unlocked). Use `await save()` because the encrypted path is async — especially in handlers that may navigate, close a sheet, or `render()` immediately after, since fire-and-forget saves can lose changes if the user closes the tab during the encryption window. The codebase has many legacy non-`await`ed call sites; new code should use `await`.
- **Inline `onclick=`/`oninput=` handlers in rendered HTML** are the primary event-binding pattern. Any function called from rendered markup must be exposed on `window` via the big `Object.assign(window, {...})` block at the bottom of `init()`. Adding a new handler? Add it to that list.
- **When interpolating an untrusted string as a JS argument inside an inline handler, use `jsAttr(value)` — not `'${esc(value)}'`.** `esc()` is correct for HTML *text*, but inside an `onclick=` attribute the browser decodes entities *before* JS parses, so `'${esc("McDonald's")}'` produces broken JS. `jsAttr()` JSON-encodes the value (escaping `'`, `"`, `\`, newlines) and HTML-escapes the result, so `onclick="foo(${jsAttr(s)})"` is safe for any string. Use this for: merchant names, institution names, Plaid IDs, anything from outside the app.
- **Tabs**: seven primary tabs — Today, Calendar, Goals, Plan, Money, Stocks, Stats — each with its own `renderXxx()` function plus `renderSettings()`. The dispatcher is `render()`, called by `showTab()` and after every mutation. Each renderer replaces the full `innerHTML` of its `<div class="page">`. There's no diffing — re-render is cheap because pages are small.
- **`esc()` everywhere** when interpolating user data into HTML strings (the renderers build raw HTML with template literals).
- **`emptyStateHtml({emoji, title, sub, primary, secondary, pad})` helper** for any "no X yet" placeholder. Used in 13+ places. New empty states should call this instead of hand-rolling `<div class="empty">...` so tone/spacing/CTA sizing stay consistent.
- **Privacy-mode (`👁` eye icon in the topbar) blurs every dollar amount.** It works by targeting `[data-priv="amount"]` in CSS. **Every user-visible `${fmt$0(...)}` in HTML must be wrapped in a `<span data-priv="amount">…</span>`** (or use `data-priv="amount"` on the parent if it contains nothing else). Skip only for non-rendered contexts: toast strings, Cornileus seed prompts, AI message bodies. Coverage audit script: `grep -c 'data-priv="amount"' index.html` should track close to the count of user-visible `fmt$0(` callsites.
- **Snapshot card pattern.** Tabs that aggregate a lot of numbers (Plan Health, Money Health, Today Daily Pulse, Stats "Your Journey") share a similar card shape: small uppercase eyebrow label, big primary number, sub line, optional NEXT-UP row with one-tap drill-in. They're hand-rolled today, not extracted into a helper, because each card has subtly different layout requirements (grid vs hero vs split).
- **Top-of-script table of contents.** The first ~85 lines inside `<script>` are a curated comment block listing every major section with its approximate line number, grouped (PLATFORM / DOMAIN MODELS / RENDER / FLOWS / FEATURES / BOOT). Update when adding a new top-level section banner.

### Onboarding and tutorial

- **First-run onboarding**: `runOnboarding()` triggers when `DB.user.onboardedAt === 0`. The user picks between **Cornileus (AI, ~3 min)** — a conversational setup that calls the Anthropic proxy (`aiOnboardingStart` → `aiOnbAcceptPlan` finalizes) — or **Quick setup (manual, 4 steps)** — `onboardingStep1..4` → `finishOnboarding`. Both paths land on the same final state and call `maybeStartTutorial()`.
- **Tutorial**: a **12-step interactive walkthrough** (`TUTORIAL_STEPS` → `startTutorial` → `_tourGo` → `_tourRender` + `_tourPosition`). Each step optionally specifies (a) a `tab` to switch to and (b) a `target` CSS selector for a spotlight. Steps with a target attach a one-time capture-phase click listener so tapping the highlighted element auto-advances after 320ms. Steps without a target dock the tooltip at the bottom-center over a soft dim overlay so the populated tab is fully visible behind the card.
- **Demo data overlay during the tour**: `_enterTourMode()` clones the live DB into `_tourBackup`, swaps in the rich `_buildDemoData(currentDB)` snapshot (8 habits with deterministic 14-day streak on h2 "Read Bible", 12 wins, 21 mood entries, 6 calendar notes, 7 plans across tiers, 90 days of net worth, 75 days of spend, etc.), and monkey-patches `save()` to a no-op so the demo never persists. `_exitTourMode()` restores. Triggered by `tutorialFinish()` and `tutorialAsk()`.
- **Auto-fires once via `DB.user.tutorialSeenAt` flag**; replayable from Settings → "🧭 Take the tour" any time.
- **Polish layer**: tooltip fades + spring-scales in, content crossfades on step change, progress bar at the bottom of the card, pointer triangle anchoring to spotlight, keyboard shortcuts (`→`/`Enter`/`Space` advance, `←` back, `Esc` skip), resize listener repositions on viewport change, confetti burst on completion (respects `celebrationsEnabled` and `prefers-reduced-motion`).
- **What's New sheet**: `WHATS_NEW_KEY` constant + `maybeShowWhatsNew()`. Bump the key when shipping enough features to be worth re-surfacing; existing users with a different `DB.lastSeenWhatsNew` will get the sheet on next visit. Demo data loader pre-syncs the key so new users aren't pestered.

### Frontend ↔ backend

- `api(path, opts)` in the script is the single fetch wrapper for the Cloudflare Worker. It reads `DB.settings.backendUrl` and `DB.settings.apiKey` and sends `Authorization: Bearer <apiKey>`. If either is unset, calls throw — callers should `try`/`catch` and `toast()` the error.
- `aiApi(...)` wraps calls to the Anthropic proxy. Routing is automatic: if `DB.settings.backendUrl` is set it goes through the Cloudflare Worker; otherwise it falls back to the Vercel Python `/api/*` proxy (zero-config — works for every user without bank-sync setup).
- `ensureUserId()` lazily generates a per-device `DB.user.userId` and persists it (using the unencrypted `_origSave` to avoid recursion). Every Worker backend call is keyed by this id.
- Plaid amount convention: **positive amount = outflow** (spend), negative = income/deposit. This is used directly throughout `DB.spend` and is what `processSyncedDeposits` and the spend UI assume.
- Plaid Link is loaded from CDN via `<script src="https://cdn.plaid.com/...">`; `connectBank()` calls the Worker for a `link_token`, then opens `window.Plaid.create({...}).open()`.

### Two layers of encryption

1. **Server-side**: Plaid `access_token` values are AES-GCM encrypted with `ENCRYPTION_KEY` (a worker secret) before being written to KV. See `encryptString`/`decryptString` in `backend/worker.js`. A KV breach yields useless ciphertext without the key.
2. **Client-side (optional)**: if the user sets a passphrase, all of `DB` is AES-GCM encrypted before being written to `localStorage`. Key is derived via PBKDF2-SHA256 (current envelope: 600k iterations; older v:1 envelopes use 250k and are upgraded on next save). Held only in memory as `APP_KEY`. On cold start, `load()` detects an encrypted envelope (`{v, salt, iv, ct}`) and `init()` shows `showLockScreen()` to prompt for the passphrase. **Forgotten passphrase = unrecoverable** by design — the only escape is `localStorage.clear()`.

The two layers use independent keys with different blast radius — do not collapse them.

### Service worker / cache versioning

`sw.js`:
- **Navigations + same-origin GETs (index.html, manifest.json, etc.) → network-first**, with cache fallback so the PWA still works offline. This means a fresh `index.html` is fetched on every load when online — no stale UI after deploy.
- **Icons → cache-first**, precached on install.
- **`/api/*` → passthrough** (never cache). Stock quotes go stale; SSE streams would break under caching.
- **Cross-origin (Plaid CDN, etc.) → passthrough**, not intercepted by the worker.

Cache name is derived from a **SHA-256 hash of `index.html`** (first 4 bytes, hex). So when you ship a change to `index.html`, the cache name changes automatically and the old cache is purged on the next service-worker activation — no manual version bumping for normal iteration. The same 8-hex-char hash is surfaced in the app as the build ID (Settings → About → Build).

**Caveat**: icons are cache-first, so changing an icon file *alone* won't trigger an update on installed PWAs. To force-update icons, edit any byte of `sw.js` (the browser only re-checks the SW when its bytes change). New static files must be added to `STATIC_ASSETS`.

### Cloudflare Worker backend (optional, Plaid)

`backend/worker.js` is one ES module (~570 lines, no SDK). All Plaid calls go through `plaidCall(env, path, body)` which posts to `PLAID_HOSTS[env.PLAID_ENV]` with credentials.

- **Auth (per-device enrollment, not a shared key)**: every endpoint except `/`, `/health`, and `/enroll` requires `Authorization: Bearer <clientSecret>`. The first call from a new device hits `/enroll` with the operator's `ENROLLMENT_KEY` (legacy name: `API_KEY`); the worker mints a per-device `clientSecret`, stores `SHA-256(secret)` keyed to the device's `userId` in KV, and returns the secret to the client. After enrollment, the device sends its own secret on every call — the enrollment key is no longer used. A leaked per-device secret only impersonates one device.
- **CORS**: `ALLOWED_ORIGIN` secret should be the deployed PWA URL. The check is skipped when there's no `Origin` header (e.g. curl), so the security boundary is the bearer token, not CORS. Set `ALLOWED_ORIGIN` to `*` only temporarily.
- **KV layout**: per-user item index at `u:<userId>:items` (JSON array of itemIds), each item record at `u:<userId>:item:<itemId>` (`{itemId, institutionName, accessTokenCipher, cursor, ...}`). Update both when adding/removing items (helpers: `addItemToIndex`, `removeItemFromIndex`). Per-user secret hash at `u:<userId>:auth`. Per-user audit log at `u:<userId>:audit` (last 200 events).
- **Transactions sync** uses Plaid's cursor-based `/transactions/sync` endpoint with a 10-iteration safety cap; the cursor is persisted in the item record so resumes are incremental.
- **Anthropic proxy** (`POST /anthropic/messages`): the worker forwards browser requests to Anthropic using its own `ANTHROPIC_KEY` secret — the AI key never leaves the worker. Per-user daily cap (`ANTHROPIC_DAILY_CAP`, default 50) is enforced via KV counters. Upstream errors (including 401 from a bad ANTHROPIC_KEY) are returned with the upstream status code, so the frontend must distinguish worker auth-failures from Anthropic auth-failures before clearing the device enrollment.

### Vercel Python backend (always on)

`stockanalyzer/app.py` is a Flask app served by Vercel via the WSGI shim in `api/index.py`. Modules:

- `analyzer.py` — scoring/analysis for individual tickers.
- `universe.py` — market universes (S&P 500, REITs, crypto, etc.) for streamed scans.
- `housing.py` / `mortgages.py` — home affordability + mortgage math.
- `news.py` — fetches relevant headlines per ticker.
- Templates and CSS/JS for the standalone `/stockanalyzer` page live in `stockanalyzer/templates/` and `stockanalyzer-static/`.

The AI proxy route forwards messages to Anthropic using the `ANTHROPIC_API_KEY` Vercel env var. See `api/AI_PROXY_SETUP.md`.

### Other things worth knowing

- The AI (whether AI proxy on Vercel or via the Cloudflare Worker) is branded as **Cornileus** in user-facing copy — onboarding coach + ongoing financial counselor. Default Anthropic model is `claude-haiku-4-5-20251001`.
- The `loadDemoData()` path overwrites `DB` but **carries over** `backendUrl`, `apiKey`, `anthropicKey`, `anthropicModel`, `theme`, and `userId` so demo mode doesn't kick the user out of their backend.
- Notifications use the in-page `Notification` API and a `setTimeout`-based `scheduleReminder` chain. **This only fires while the app/PWA is open** — true scheduled push when closed would require a server.
- Build identification: an async IIFE near the top of the script computes SHA-256 of `index.html` (first 4 bytes) into `BUILD_ID` and sets `BUILD_DATE` from `document.lastModified`. Surfaced in Settings → About to let users confirm which version is loaded — useful with multiple machines deploying.
