# ASCEND v3 — App Store Quality Rebuild Brief

> **How to use this file:** Open a terminal in this project's root directory and run `claude`. Then paste this entire file as your first message. Claude Code already auto-loads `CLAUDE.md` — this file layers your *intent* on top of it.

---

## 0. Mission

You are working in the **Ascend** repo (a personal habit/goal/money tracker shipped as an installable PWA). The owner's goal:

> Take this from "personal-use prototype" to **App-Store-quality polish** — a sleek, professional, deeply useful life-and-money app that anyone could install and feel proud to use. Keep it free. Keep it private. Keep it offline-first. Make it genuinely the best free finance + goals app a person could have.

You have **full autonomy**. Investigate, plan, execute, verify, commit, and deploy. Do not ask for permission between steps. Report back at the end with a summary of what changed, what you decided, and what you intentionally left for v3.1.

The owner will share the app with one other person (a roommate, also using Claude). So: solid multi-device support is welcome but not required to be elaborate.

---

## 1. READ FIRST (do these in order before writing any code)

1. Read `CLAUDE.md` end to end. It is authoritative on architecture, conventions, and constraints.
2. Read `index.html` in full. Skim where you must, but you need to actually understand the existing `DB` shape, the renderer pattern, the inline-handler pattern, and the encryption flow.
3. Read `sw.js`, `manifest.json`, and the icon list.
4. Read `backend/worker.js` and `backend/wrangler.toml`.
5. Read `DEPLOY.md`.
6. Run `git log --oneline -30` and `git status` to understand recent direction and any uncommitted work.
7. Open the app in your head: trace the user's first-run flow from cold open → unlock screen (if encrypted) → today tab → adding a habit → adding a spend → connecting a bank.

After this pass, write a short audit note to yourself (TodoWrite is fine). You're now allowed to write code.

---

## 2. HARD CONSTRAINTS — DO NOT VIOLATE

These are non-negotiable. Breaking any of them is a regression, even if the result looks nicer.

- **Frontend stays a single `index.html`** — HTML + CSS + JS all inline. No build step. No bundlers. No npm packages on the frontend. (You may use `<script src>` from a CDN only for things already there or for Plaid Link.)
- **Service worker stays `sw.js`** with cache-first + stale-while-revalidate. Bump `VERSION` (currently `"ascend-v2.0.1"`) **every time** you change `index.html` or any cached asset. Add new static assets to the `ASSETS` array.
- **All persisted state lives in `DB`** — declared with `var DB` so it's reachable on `window`. Any new persisted field MUST be added to `DEFAULT_DB` or it will not survive reloads (`load()` merges saved data over `DEFAULT_DB`).
- **Storage key stays `localStorage["ascend_v2"]`.** If you change the schema, write a migration in `load()` that detects old shapes and upgrades them in-place. Never silently drop user data.
- **Inline `onclick=`/`oninput=` handlers in rendered HTML are the binding pattern.** Any function called from rendered markup must be exposed on `window` via the `Object.assign(window, {...})` block at the bottom of `init()`. Add new handlers to that block.
- **Always `esc()` user data when interpolating into HTML strings.**
- **`save()` is async** because the encrypted path is async. Always `await save()`.
- **Backend stays a single-file Worker** in `backend/worker.js`. Same `Authorization: Bearer ${env.API_KEY}` auth model. Same KV layout (`u:<userId>:items`, `u:<userId>:item:<itemId>`).
- **Two encryption layers stay independent:**
  - Server-side: Plaid `access_token` AES-GCM encrypted with `ENCRYPTION_KEY` worker secret before KV write.
  - Client-side: optional passphrase derives an AES-GCM key via PBKDF2-SHA256 (250k iters), held in memory as `APP_KEY`, used to encrypt the entire `DB` envelope `{v:1, salt, iv, ct}`.
  - **Do not collapse them. Do not weaken either.** Forgotten passphrase = unrecoverable, by design.
- **Plaid amount convention: positive = outflow (spend), negative = income/deposit.** This is what the rest of the code assumes.
- **Anthropic key stays client-side**, sent with `anthropic-dangerous-direct-browser-access: true`. Default model `claude-haiku-4-5-20251001`. No proxy.
- **No telemetry. No analytics. No tracking. No third-party scripts** other than Plaid Link CDN. Privacy is a feature, not a constraint.
- **Offline-first** — every core flow must work without network. Bank sync and AI insights are the only network-required features.

If a feature you want to add would violate any of these, **redesign it instead** to fit.

---

## 3. THE QUALITY BAR — what "App Store ready" means here

Concretely:

- **Visual polish** — typography hierarchy is intentional, spacing is consistent, color system is coherent in both light and dark mode, animations are <200ms and never janky, empty states are illustrated (or at least beautifully typeset), every interactive element has hover/focus/active/disabled states, every destructive action has confirmation.
- **Information density is correct** — the home screen tells the user the most important thing first. Money tab tells them what they can spend today. Goals tab tells them what to do today.
- **Onboarding** — a first-run experience that gets the user to "I see my own data" within 60 seconds. Skippable. Persistent dismissal.
- **Microinteractions** — completing a habit feels good. Hitting a goal triggers a moment. Swipe-to-complete on touch. Haptic vibration where supported.
- **Accessibility** — WCAG 2.1 AA color contrast, all interactive elements keyboard-reachable with visible focus rings, ARIA labels on icon-only buttons, prefers-reduced-motion respected, font scaling respected, screen-reader meaningful labels.
- **Performance** — first contentful paint <1s on a cold install, render after tab switch <50ms, no layout thrash, no blocking main thread >100ms.
- **Errors are humane** — no raw stack traces. Every `catch` ends in a `toast()` with a useful message and, where relevant, a recovery action.
- **Empty states sell the feature** — "no goals yet" is a chance to teach, not a void.
- **Settings are organized** — grouped, searchable if it gets long, with descriptions, not just toggles.
- **The app has a name, a personality, and an identity** — Ascend. The icon, the splash, the about page, the tone of voice in copy should all feel like the same product.

---

## 4. FEATURE SCOPE — Money / Finance

The money side should be **the most useful free personal finance app a person can install**. Build toward this list, in roughly this priority order. Skip anything that's already done well; deepen anything that's shallow.

### 4.1 Accounts & balances
- Multiple manual accounts (checking, savings, credit card, cash, investment, loan) with per-account balance, color, icon, and "include in net worth" toggle.
- Plaid-synced accounts coexist with manual accounts. Sync writes the balance back; user can override.
- **Net worth dashboard** — live total, sparkline over time, breakdown by account type, month-over-month delta.
- Net worth history is computed and stored as monthly snapshots (`DB.netWorthHistory: [{month, assets, liabilities, total}]`), backfilled on first run and updated on each balance change.

### 4.2 Spending & income
- The existing positive=outflow convention holds.
- **Categories** — user-editable, with icon and color, with parent/child support (e.g. Food → Groceries, Food → Restaurants). Seed a sensible default tree on first run.
- **Auto-categorization** for Plaid-imported transactions using a rules engine: user-defined `if name contains X then category Y`. Rules are reorderable and persist.
- Manual entry is fast: amount → category → note → date (defaults to today). Two taps for a common entry.
- **Recurring transactions** — subscriptions and bills with cadence (weekly/monthly/yearly), next-due date, and auto-projection into cashflow.
- **Receipts** — optional image attachment, stored as base64 in `DB` (or IndexedDB if it gets big — see §8 on storage migration).

### 4.3 Budgeting
- **Envelope-style budgets** — per-category monthly limit, with rollover toggle (unspent rolls forward, overspent rolls forward as debt to next month).
- **"Safe to spend today"** number on the home screen: `(monthly income projected) − (fixed bills due this month) − (already spent this month) − (savings goal target this month) / days remaining in month`. Show this big.
- Visual progress bars per category. Warn at 80%, alarm at 100%.
- Quick-budget mode: "I want to save $X this month, here's how much you can spend" — back-solve.

### 4.4 Goals (financial)
- **Savings goals** with target amount, target date, optional linked account, automatic monthly required-contribution calc.
- **Debt payoff** with snowball and avalanche modes, projected payoff date, total interest saved comparison between methods.
- Goals appear as cards with progress ring, ETA, and "on/off track" status.

### 4.5 Insights
- Monthly insight (already exists via Anthropic) — keep, polish the prompt, render results beautifully.
- Add **trend insights**: top categories MoM, biggest changes, anomaly callouts (e.g. "Restaurants up 60% vs your 3-month average").
- **Cashflow forecast** — 30/60/90 day projection using recurring transactions and average discretionary spend. Render as a simple SVG line chart.

### 4.6 Bank connection
- Plaid Link works as today.
- Add a **connection health view** in Settings: per-item institution name, last sync time, last sync status, manual "Sync now" button, "Disconnect" button.
- Surface re-auth prompts gracefully when Plaid returns `ITEM_LOGIN_REQUIRED`.

### 4.7 Privacy / safety
- **"Privacy mode"** toggle that blurs all dollar amounts in the UI (`filter: blur(8px)` on `.amount`). Tap to reveal. Useful in public.
- **Auto-lock** after N minutes of background (when passphrase is set) — clears `APP_KEY` from memory.
- **Biometric unlock** via WebAuthn platform authenticator if available — wrapping `APP_KEY` so the user can re-derive it without re-typing the passphrase. Falls back to passphrase if unsupported. (This is non-trivial — design carefully or defer to v3.1 with a clear note.)

### 4.8 Export / backup
- Export entire `DB` as encrypted JSON (already encrypted with passphrase if set, otherwise plain JSON with a clear warning).
- Export transactions as CSV.
- Import re-merges (with conflict resolution: prefer newer `updatedAt` timestamps).

---

## 5. FEATURE SCOPE — Goals / Life

Build a hierarchy:

- **Big goals** — yearly or multi-year ("Save $20k", "Run a half-marathon", "Learn Spanish"). Each has: title, why, target date, success criteria, optional metric (number + unit), optional linked savings goal, optional vision-board image.
- **Monthly targets** — children of big goals. "This month: save $1,500", "This month: run 60km". Each has progress (auto-rolled-up from daily logs where possible, manual otherwise).
- **Weekly review** — a guided 5-minute prompt at end of week: what worked, what didn't, what's next.
- **Daily habits / actions** — children of monthly targets (or standalone). Checkable, with streaks. Optional time-of-day reminder.

UI:

- **Today tab** is the home. It shows: safe-to-spend, top 3 daily actions, current streak count, today's calendar of reminders, and one "moment" card (a streak hit, a goal milestone, an insight).
- **Goals tab** shows the hierarchy as a tree with progress rings. Tapping a big goal expands it.
- **Stats tab** shows habit consistency heatmap (GitHub-style), category spending sparklines, net worth chart, streak histories.
- **Reflection journal** — append-only daily entries, optional, encrypted with the rest of `DB`. Prompted weekly. AI-summarized monthly (with a clear opt-in because it sends content to Anthropic).

Templates:

- Seed a "Goal Templates" gallery (Fitness, Save for X, Read more, Learn a skill, Pay off debt, Build a habit). Each template prefills a big goal + suggested monthly target + suggested daily actions. Templates are JSON in code, not loaded from network.

Celebrations:

- Streak milestones (7, 30, 100, 365 days), goal completions, big goal hits → confetti via canvas (no library) + a nicely-typeset moment card stored in a "Wins" log the user can scroll back through.

---

## 6. UI / UX SPEC

### Color system
- Single source of truth: CSS custom properties at `:root` and `[data-theme="dark"]`. Use HSL or OKLCH. Define semantic tokens (`--surface`, `--surface-elevated`, `--text`, `--text-muted`, `--accent`, `--success`, `--warn`, `--danger`, `--border`) — never hardcode hex inside components.
- Three themes: System (auto), Light, Dark. System uses `prefers-color-scheme`.
- Optional: an "Accent color" picker so the user can theme their accent.

### Typography
- One typeface family loaded as a system stack: `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif`. Optionally pre-cache an "Inter" subset (woff2) in the SW for consistency, but only if it doesn't blow the install size budget.
- Type scale: 12 / 14 / 16 / 20 / 28 / 40. Line heights: 1.4 body, 1.2 display. Tabular numerals for amounts (`font-variant-numeric: tabular-nums`).

### Layout
- Mobile-first (375px baseline). Fluid up to 720px max content width. Above that, compose into multi-column layouts.
- Bottom tab bar on mobile. Side rail on >720px.
- Safe-area insets respected (`env(safe-area-inset-*)`).

### Motion
- Respect `prefers-reduced-motion: reduce` — skip transitions, use opacity-only transitions.
- Otherwise: 150-200ms cubic-bezier for everything. Tab switches, modals, list inserts.
- No bouncy springs unless celebrating.

### Components to standardize
- Card, Stat card, List row, Empty state, Modal, Sheet (bottom sheet on mobile, dialog on desktop), Toast, Confirm dialog, Form field, Segmented control, Tab bar, Progress ring, Sparkline, Bar chart, Heatmap.
- Each as a small JS factory that returns an HTML string (or a reusable render helper) — consistent with the existing style. No framework.

### Iconography
- One icon set, inline SVG, sized via `currentColor`. Pick a set with permissive license (e.g. Lucide / Phosphor — copy the SVGs into the file, do **not** load from CDN).

### Sounds & haptics
- Optional. `navigator.vibrate(10)` on a habit complete if supported. Single subtle "ding" on goal completion (use Web Audio API to synthesize, do not ship audio files).

---

## 7. SECURITY HARDENING

- Audit all `innerHTML` interpolations for unescaped user input. `esc()` everything.
- Add a Content-Security-Policy `<meta http-equiv>` with `default-src 'self'`, allow `'unsafe-inline'` for the inline scripts (we have to), allow `https://cdn.plaid.com` for Plaid Link, allow `https://api.anthropic.com` for AI calls, allow the user's configured backend URL via runtime injection.
- Backend: rate-limit per `userId` for `/transactions/sync` and `/link/token/create` to prevent abuse if the API key leaks.
- Backend: validate `userId` shape (uuid-like, ≤64 chars) on every request.
- Backend: never log Plaid access tokens or user PII. Audit `console.log` calls.
- Add a "Security" section in Settings explaining the encryption model in plain language, with a "Rotate passphrase" flow that re-encrypts `DB` under a new key.
- Add **integrity check** on cold start: if encrypted envelope decryption fails, distinguish "wrong passphrase" from "corrupted blob" and offer a download-the-blob escape hatch before giving up.

---

## 8. STORAGE & PERFORMANCE

- The current `localStorage["ascend_v2"]` approach has a ~5MB cap and synchronous reads. With receipts and long histories, this will hurt.
- **Migrate to IndexedDB** for `DB` storage, keeping the same in-memory `DB` object as the source of truth. Wrap the storage in a small abstraction `storage.read()` / `storage.write(db)` so the rest of the app doesn't change. Keep `localStorage` as a fallback for browsers without IDB.
- Migration path on first load: if `localStorage["ascend_v2"]` exists and IDB is empty, copy it across, leave `localStorage` for one version cycle, then clear it in the version after.
- Debounce `save()` writes to ~250ms while keeping the in-memory `DB` immediately consistent.
- Keep the encryption envelope shape `{v:1, salt, iv, ct}` — bump `v` to `2` when introducing IDB if useful for future migrations.

---

## 9. PWA POLISH

- `manifest.json`: name, short_name, description, theme_color, background_color, display: `standalone`, orientation: `portrait`, icons (192, 512, maskable 512), screenshots (provide stub data so the install prompt looks nice), categories: `["finance", "productivity", "lifestyle"]`, `shortcuts` for "Add spend", "Today", "Goals".
- Splash screen via `apple-touch-startup-image` for iOS — generate at common sizes.
- Install prompt: detect `beforeinstallprompt`, surface a tasteful "Install Ascend" button in Settings (and a one-time toast on the third visit if not installed). Never nag.
- Share Target API: register so the user can share a screenshot/text into Ascend as a quick note (defer to v3.1 if it's complex).

---

## 10. MULTI-DEVICE / SHARING

The owner will share with one roommate. Two paths — pick one and ship it; do not build both.

- **Path A (preferred for v3):** the existing backend already has per-user `userId`. Add a "Sync" feature that pushes the encrypted `DB` envelope to `u:<userId>:db` in KV every save (debounced to 5s) and pulls on cold start with a simple last-write-wins merge by `updatedAt`. Each user has their own `userId`. The roommate runs his own instance pointed at his own `userId` — there is no shared data, just multi-device sync per user. Document this clearly in Settings.
- **Path B (defer):** shared goals between two users. Real conflict resolution. Real auth. This is a v4 problem.

---

## 11. EXECUTION PLAN

Work in this order. Commit at the end of every phase with a descriptive message. Do not batch all changes into one commit.

1. **Audit + plan** (no code) — write a `PLAN.md` at the repo root with: what you found, what you'll change, what order, what you're explicitly deferring. Commit it.
2. **Foundation** — design tokens, typography, layout primitives, dark/light theming, icon set, base components. Refactor existing renderers to use the new primitives. The app should look noticeably better with no new features yet.
3. **Storage migration** — IDB-backed storage with the abstraction in §8.
4. **Money core** — accounts, categories, recurring, budgets, safe-to-spend, net worth. Polish existing spend flow into the new system.
5. **Goals core** — hierarchy (big → monthly → daily), templates, streaks, wins log.
6. **Insights & charts** — sparklines, net worth chart, heatmap, cashflow forecast, polished AI insight rendering.
7. **PWA polish** — manifest, splash, install prompt, shortcuts, SW improvements.
8. **Security hardening** — CSP, audit `innerHTML`, biometric unlock if feasible, settings security section.
9. **Onboarding** — first-run flow, empty states, help/about.
10. **Multi-device sync** (Path A).
11. **Final QA pass** — accessibility, perf, error paths, copy review.
12. **Deploy.**

If you discover the scope is too large for one pass, **ship phases 1-6 + 11 + 12** and clearly mark 7-10 as v3.1 in `PLAN.md`. Better a polished half than a janky whole.

---

## 12. QUALITY GATES

There are no automated tests in this repo. You must self-verify. For each phase:

- Open the app via a local HTTPS dev server (use `npx http-server -S -C cert.pem` or Wrangler Pages) and click through every flow you touched.
- Test the cold-start path: clear `localStorage` and IDB, reload, walk through onboarding.
- Test the encrypted path: set a passphrase, reload, unlock, verify all data is intact.
- Test the migration path: paste an old-shape `localStorage["ascend_v2"]` value (sample one before you start), reload, verify upgrade.
- Test offline: in DevTools, set Offline, reload, verify the app still loads from SW cache and core flows work.
- Test on a 375×812 viewport (iPhone-ish) and on a 1440px desktop. Bottom tab bar on mobile, side rail on desktop.
- Check Lighthouse: PWA installable ✓, Accessibility ≥95, Best Practices ≥95, Performance ≥90 on mobile throttled.
- Backend: `cd backend && wrangler dev`, then hit `/health` from the frontend, then run a Plaid sandbox link end-to-end (use Plaid's `user_good` / `pass_good` credentials).

If any gate fails, fix before moving to the next phase. Do not paper over.

---

## 13. DEPLOY

When all phases (or the agreed-upon subset) pass quality gates:

1. **Frontend SW version** — bump `VERSION` in `sw.js`. Update the `ASSETS` array if you added or renamed any cached file. Commit as `chore(sw): bump cache to vX.Y.Z`.
2. **Frontend deploy** — the existing pattern (per `DEPLOY.md`) is presumably Cloudflare Pages or static hosting. Run whatever the documented command is. If it's Pages: `wrangler pages deploy . --project-name=<name>`. If `DEPLOY.md` differs, follow it.
3. **Backend deploy** — only if `backend/worker.js` or `backend/wrangler.toml` changed:
   - `cd backend`
   - `npm install` (if needed)
   - `wrangler deploy`
   - `wrangler tail` in a side terminal to watch the first few production requests.
4. **Smoke test prod** — open the deployed URL on phone and desktop, install as PWA on both, verify cold start, verify Plaid sandbox link, verify a manual spend entry persists across reload.
5. **Tag the release** — `git tag v3.0.0 && git push --tags`. Write a `RELEASES.md` entry summarizing what shipped.

If anything looks wrong in prod, **roll back immediately**: `wrangler rollback` for the worker, redeploy the previous Pages commit. Then debug locally.

---

## 14. REPORTING BACK

When you're done, post a single summary message containing:

1. **What shipped** — bulleted list of features actually live in prod, grouped by Money / Goals / UI / Security / PWA / Sync.
2. **What I deferred and why** — anything from this brief that did not ship, with one-sentence reasoning each.
3. **Decisions I made on your behalf** — anywhere this brief was ambiguous and you chose a path.
4. **Migration warnings** — anything an existing user (i.e. the owner) needs to know on first load of v3 (e.g. "your old categories were upgraded to the new tree; review them in Settings → Categories").
5. **What v3.1 should tackle** — your prioritized backlog of the next round.
6. **The deployed URLs** — frontend and backend.
7. **Total token spend** if you can see it. (Optional.)

Keep the report tight. The owner reads diffs; the report is for context.

---

## 15. THINGS TO BE CAREFUL OF

- The `loadDemoData()` path overwrites `DB` but **preserves** `backendUrl`, `apiKey`, `anthropicKey`, `anthropicModel`, `theme`, and `userId`. Maintain this carry-over list as you add new "should survive demo reload" settings.
- Encrypted save/load is async. If you forget to `await save()`, you will hit race conditions where the next read sees a stale envelope.
- The Anthropic browser-direct call uses the user's own key. Never log it. Never send it anywhere except `api.anthropic.com`.
- Plaid sandbox vs production — you are almost certainly in sandbox unless `PLAID_ENV=production` is set as a worker secret. Do not switch to production without explicit owner approval.
- Service worker stale caches are the #1 cause of "I shipped a fix and the user doesn't see it." If you change `index.html`, you bump `VERSION`. Always.
- The owner specified: **app stays free.** Do not add any paid tier, paywall, or upsell. Do not integrate any service that would later require payment from the owner at scale.

---

## 16. STYLE OF WORK

- Be terse in commit messages but use them. Conventional commits welcome (`feat:`, `fix:`, `chore:`, `refactor:`, `style:`).
- Comment intent, not mechanics. `// debounce save() to avoid thrashing localStorage on rapid edits` good. `// loop through array` bad.
- Prefer small, well-named functions over big render blocks. The existing code leans monolithic; you may break it into clearly-delineated sections within the single file using fold-friendly comment banners (`// ─── MONEY ───────────────────────────────────────────`).
- Where you introduce a new pattern (e.g. a Sheet component), document it once at the top of that section. Future-you will thank you.
- If you discover a pre-existing bug while working, fix it inline if cheap; otherwise note it in `PLAN.md` under "Found while working".

---

## 17. PERMISSION TO MAKE JUDGMENT CALLS

You have it. The owner trusts you to make reasonable decisions on:

- Visual design specifics (color palette, exact spacing, motion curves) — pick something tasteful and consistent.
- Which charting approach (inline SVG vs. canvas) — pick simpler.
- Library choices for non-network features — there should be very few; prefer hand-rolled.
- The exact UX of new flows — design something a tasteful designer would approve of, then build it.
- Order of phases if you find a more efficient path — fine, just note it in `PLAN.md`.

You do **not** have permission to:

- Delete the user's existing data without a migration.
- Change the encryption model.
- Add network dependencies for offline-required features.
- Add telemetry or analytics.
- Switch Plaid to production.
- Take the app paid in any way.

---

## 18. FINAL NOTE

This is a personal app the owner uses every day and will share with one friend. It does not need 10,000 users. It needs to be **lovely** and **trustworthy**. Optimize for the feeling the owner has when they open it on a Tuesday morning to log a coffee and check their goals — quiet, fast, beautiful, in control.

Ship it.
