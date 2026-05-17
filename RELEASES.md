# Ascend — Releases

## v3.8 — 2026-05-17

Polish + security-hardening round. 23 frontend QoL features plus a
comprehensive audit pass across the whole stack.

### Frontend features

- **Cornileus voice mode** — tap the speaker chip in chat to have replies
  read aloud (Web Speech API, best system voice picker, stops on close).
- **Split transactions** — one Walmart charge → groceries + home + gift;
  parent gets `_split:true`, children get `_splitParentId`, filters skip
  the parent to avoid double-counting.
- **Portfolio vs S&P 500** — YTD comparison line on the Stocks portfolio
  hero with a "Beating/Trailing by Xpp" verdict. SPY YTD fetched from
  /api/quote/SPY/full, cached 12h.
- **US federal holidays on Calendar** — all 10 holidays marked, with
  weekend-observed shifts. Toggle off in Settings for non-US users.
- **Year-in-review shareable PNG** — 1080×1920 portrait image via Canvas,
  Web Share API on mobile / download fallback on desktop.
- **Streak freeze** — 1 free skip per habit per calendar month. Frozen
  days are treated like paused days in streak math.
- **30-day cash flow forecast** — projects bank balance forward from
  recurring bills + paychecks. Flags overdraft risk.
- **Spending heatmap** — 7×24 day-of-week × hour-of-day grid on Stats.
- **Next milestone projection** — least-squares regression on net-worth
  history → "At this rate, $100k in 14 months".
- **Daily spend cap** — Today progress bar + push at 90% usage.
- **Plaid reconnect** — red banner on Money + push when a bank stops syncing.
- **Bills-due-today push** — 9am notification for the day's bills.
- **Onboarding celebration** — confetti + recap at end of setup.
- **Compact Settings** — collapsible sections with persisted open state.
- **Swipe-between-tabs** — horizontal swipe gesture (disabled on Stocks
  to avoid conflict with carousels).
- **Skeleton loaders** — pulsing shimmer for AI replies-in-flight + sync.
- **prefers-reduced-motion** — animations honored OS-level setting.
- **Receipt scanning** — Anthropic Vision API extracts transactions from
  receipt photos.

### Code quality + correctness

- **Memoize hot helpers** — detectSubscriptions + upcomingBills now cache
  per render pass (Money tab called them 11+ times each). Biggest single
  render-cost win.
- **Memory caps on unbounded DB arrays** — spend (10k), realizedPL (500),
  wishlist/lifeEvents/careerHistory/paperTrades/purchaseRegrets (200),
  dismissedRecurring (500), pendingDeposits (200), stocks.alerts prune
  triggered >30d old.
- **Stocks cache invalidation** — removing a watchlist ticker now also
  purges dividend/earnings/exDiv/ytd caches (when ticker isn't still
  held). Heavy-churn users had these growing forever.
- **9 audit-found bug fixes** — null deref on missing t.date, div-by-zero
  in inheritance + skill tree + tutorial progress, NaN from blank
  parseInt at 5 calc sites, heatmap mood empty rows, AI confidence parse.
- **Stale memo prevention** — _renderActive flag stops cached values from
  leaking into out-of-render contexts (push scheduler, snapshotNetWorth).
- **TZ-safe date diffs** at the user-visible sites.
- **pinQuoteToToday** rolls back in-memory mutation on save failure.

### Security hardening

- **Frontend** — `_decodePairingToken` + Cornileus action dispatcher both
  switched from raw JSON.parse to safeJsonParse (proto-pollution gap).
  Encryption lockout counter mirrored to sessionStorage so a quota-failed
  write doesn't reset the brute-force rate limit.
- **Cloudflare Worker** — Anthropic upstream response whitelisted to
  {id, type, content, stop_reason, usage, error.type, error.message}
  before forwarding (no more leaked Anthropic error metadata).
  decryptString validates packed format before atob. handleSync has a
  40-call per-invocation Plaid budget with `truncated:true` continuation.
  handleRemoveItem hardened with regex validation + try/catch on
  decodeURIComponent. Reverse `item-owner:<itemId>` index added so
  webhooks refuse events for unowned items. _safePushUrl + sw.js
  notificationclick now path-allowlist nav targets.
- **Python backend** — strict ticker regex (`^[A-Z0-9.\-^=]{1,10}$`)
  validates every yfinance-routed path param (SSRF defense). `_err()`
  helper replaces 15+ `str(e)` error responses (info-leakage). RSS image
  URLs now require https + an allowlisted news-CDN host. defusedxml
  replaces stdlib ElementTree for RSS parsing (billion-laughs defense).
- **Vercel headers** — Strict-Transport-Security preload, COOP, CORP,
  Permissions-Policy `interest-cohort=()`, per-route cache headers for
  cacheable Python endpoints (quote/full, news, housing, mortgage).
- **Frontend dead code removed** — 3 unreferenced helpers (_memoize,
  fmtHours, saveNow) + 5 unused CSS classes deleted.

### Infra polish

- .gitignore: __pycache__, .venv, dist/build/logs, iOS Pods.
- pyproject.toml: Python ~=3.13 → >=3.12 (matches Vercel runtime),
  added defusedxml.
- README + CLAUDE.md line counts updated.

---

## v3.2 — 2026-05-15

Major round between v3.1 and a future App Store submission. New tabs, new AI persona, new visual hero, App Store paperwork.

### New tabs

- **Plan tab** — Plan Health snapshot (aggregate $ saved + % progress + Next Up plan), per-plan pace chips ("On track" / "↑ 2w ahead" / "↓ 1w behind"), what-if simulator, savings opportunities engine, three-tier plan organization (short / mid / long).
- **Calendar tab** — month + year heatmap toggle, mood emoji on every day, per-day journal notes, retroactive habit backfill from any past day, jump-to-day from Today's week strip.
- **Stocks tab** — native rebuild (no iframe). Live quotes, watchlist with sparklines, market scans across S&P 500 / REITs / crypto / ETFs / bonds, predictions, housing/mortgage analyzers.

### Cornileus (was Cylan) — AI counselor

- Renamed across every surface — code, copy, FAB, manifest shortcuts, share cards.
- 12-step interactive guided tour walks new users through every tab with live demo data, then restores their real data on exit.
- Mid-flight cancellation guard — closing the chat sheet drops any in-flight reply so it can't ghost-message later.
- Per-step "Ask Cornileus" handoffs from the tour with context-aware seed prompts.
- Saved insights — pin any reply so it survives auto-clear; reachable from a dedicated sheet.
- Action emission — Cornileus can add plans, log spend, deposit to savings, mark goals complete via `<ACTION>{...}</ACTION>` blocks in its replies. Confirmed back as chips under the message.

### Wealth Score hero

- Top-of-Money card with circular SVG gauge (0-100), color-coded band, 7-day delta, top-gap suggestion.
- 30-day score sparkline.
- Tangible "you'll cross $X by [date]" projection at current pace.
- 1080×1080 shareable card via Web Share API or download.
- "Ask Cornileus how to raise this" CTA wired with the score + biggest gap.

### Today refresh

- **Daily Pulse** — single contextual nudge at the top of Today rotating across plan deadlines, net-worth growth, win streaks, mood check-ins, and stale-backup reminders.
- "On this day" history (1 week / 1 month / 3 months / 6 months / 1 year ago).
- Streak milestone banner ("X days from a Y-day streak").
- "What's new in v3.2" sheet auto-surfaces on first launch after upgrade.
- Customize Today: hide any of 14 sections via Settings.

### Money / Stats / Goals

- Money Health snapshot card.
- Achievements system — 22 milestones with unlock toasts and a "Next up" progress card.
- Year review + share streak card.
- Net worth milestones with milestone-crossing toasts.

### Mainstream + accessibility

- Eight empty states refreshed with action-led copy.
- A11y pass: aria-labels on FABs, role="button" + tabindex on tappable rows, swipe gestures between tabs.
- Keyboard shortcuts: ⌘K global search, ? overlay, T/C/G/P/M/S/A single-key tab switches.
- Reduced-motion respected across animations.
- Marketing landing page at `/marketing`.
- Privacy and Terms pages at `/privacy` and `/terms`.
- robots.txt + sitemap.xml + .well-known/security.txt.
- Open Graph + Twitter cards on index.html and marketing.html.

### Safety

- Dropped dead settings (`hideLauncher` was unwired, `weekStartsOn` unused).
- `safeUrl()` blocks `javascript:` / `data:` / etc. on news headline links.
- `sanitizeBackendUrl()` requires http(s) on the Settings backend URL.
- Vercel security headers (XCTO, XFO, Referrer-Policy, Permissions-Policy).
- `save()` quota-exceeded toast — silent loss eliminated.
- recentSearches now sanitized.
- Counselor mid-flight cancellation guard.
- Reset Everything: type-DELETE confirmation + backup-first prompt (Apple guideline 5.1.1(v) ready).
- PWA shortcuts in manifest now actually parsed (URL params with whitelist).

### App Store readiness

- `docs/APP_STORE_PRIVACY.md` — pre-written nutrition-label answers.
- `screenshots/` placeholder + README with sizes for both manifest and App Store.
- `SECURITY.md` + `.well-known/security.txt` for responsible disclosure.
- Manifest extended with id, lang, dir, display_override, screenshots[], launch_handler, prefer_related_applications.
- Privacy Policy + Terms of Use pages live and linked from marketing footer.

### Architecture

- Top-of-script table of contents in index.html (~85 lines, hand-curated, navigable by line number).
- `emptyStateHtml({...})` shared helper for 13+ callsites.
- Plan/Money/Stats/Pulse snapshot card pattern documented in CLAUDE.md.
- index.html grew from ~16k to ~23k lines; same single-file architecture.

### Migration

- Existing DBs continue to work — every new field merges over `DEFAULT_DB`.
- `lastExportAt` defaults to 0; backup nudge waits 30 days from onboarding before firing.
- Demo-data factory (`_buildDemoData`) refactored into a reusable function used by both the tour overlay and Settings → Load demo data.

---

## v3.1 — 2026-05-01 (same-day follow-up)

A follow-up pass adding eight requested features on top of v3.0. Same architectural constraints honored.

### What shipped

**Quick add**
- **Floating + button (FAB)** in the lower-right, always visible. One tap opens a streamlined spend sheet (amount → category → note → date) with the amount field auto-focused.

**Money**
- **90-day cashflow forecast** at the top of the Money tab. Inline SVG chart projecting your balance forward using starting balance + recurring income/expenses + average daily discretionary spend (last 30 days). Shows trend direction and ending balance.

**Goals**
- **Goal templates gallery** — six pre-built trees that seed a life goal + monthly milestone + daily actions in one tap, all linked via `parentId`. Templates: Save for vehicle / Get in shape / Read more / Pay off debt / Build emergency fund / Learn a skill.
- **Daily action context badge** — daily goals show "toward [bigger goal]" inline so you see why each daily action matters.

**Stats**
- **Year heatmap** — 365 days of habit completions in a GitHub-style grid. 4-level intensity based on % of habits done that day.

**Today**
- **Weekly review banner** — appears Sundays (and any day after 7+ days without reflection). Opens a guided 5-minute review sheet with summary stats and three short prompts. Saves as a `kind: "weekly"` reflection.
- **What's new in v3 sheet** — one-time reveal for existing users on their first open after upgrading.

**Privacy**
- **44 privacy hooks** now spread across Today / Money / Stats / Bills / Recurring / Reflections so privacy mode actually hides the numbers it should.

**Demo data**
- Now seeds `recurring`, `reflections`, `monthlySavingsTarget`, links two daily goals to the life goal so the chain renders, and marks the "what's new" sheet as already seen.

### Files touched

- `index.html` — net additions only; CSS for FAB / cashflow / heatmap / templates / weekly-review banner; new feature code; renderer wiring; demo data; window-expose updates.
- No backend changes.
- `sw.js` was already updated in v3.0.

### Verification

- `node --check` on the extracted inline script passes.
- JSDOM smoke test: all four tabs render after `loadDemoData()`. Cashflow card present on Money. Year heatmap present on Stats. Templates button on Goals + 6 template cards in the sheet. FAB element present in DOM. 44 `data-priv` hooks rendered in the live HTML.

### Known follow-ups for v3.2

1. **Action-context** currently matches by `goal.title === habit.name`. A more robust pattern would be an explicit "ladders to" pointer on habits. Easy follow-up.
2. **Cashflow** uses simple constant daily rates. A more accurate model would post recurring tx on their actual due dates and project discretionary by weekday. Defer until you have ≥60 days of data.
3. **Weekly review** prompt fires only on Sundays / 7d gap. Could add settings to choose your review day.

---

## v3.0 — 2026-05-01

A focused enhancement pass that brings Ascend toward "App-Store-quality life-and-money app." Architecture, encryption model, design tokens, and existing money/goals/habits flows are all preserved. New features layer on top.

### What shipped

**Money**
- **Safe-to-spend** — a single number on the Today tab telling you what you can spend today without breaking budget. Computed from monthly income (budget + recurring), fixed monthly outflows (recurring + budget categories), monthly savings target, and month-to-date spend.
- **Recurring transactions** — user-managed expenses and income with weekly/biweekly/monthly/yearly cadence. Feeds safe-to-spend. Distinct from auto-detected subscriptions.
- **Monthly savings target** — a single setting that reserves savings before computing safe-to-spend.

**Goals**
- **Goal hierarchy** — any goal can now have a `parentId` linking it to a bigger goal. Daily action → monthly milestone → life ambition. The Goals tab shows the chain as a breadcrumb on linked goals.
- **Confetti celebrations** — canvas-based, no library. Fires on streak milestones (7/30/100/365 days) and goal completion. Honors `prefers-reduced-motion` and a Settings toggle.

**Privacy & security**
- **Privacy mode** — a new eye icon in the topbar that toggles a CSS class that blurs every dollar amount in the UI. Tap any blurred amount to peek. Useful in public.
- **Auto-lock** — when a passphrase is set, optionally clears the in-memory `APP_KEY` after N minutes of background (1/5/15/60). Re-prompts on next visibility.

**Reflection journal**
- Append-only daily entries, encrypted with the rest of `DB`. Settings shows the most recent three; full management via the +Add sheet.

**Sharing**
- **Share with a friend** sheet — explains the per-`userId` backend model so you can onboard your roommate to your Worker safely.

**Polish**
- Updated `manifest.json` with richer description, app shortcuts, and v3 description.
- Settings reorganized.
- About line bumped to v3.0.

### What I deferred at the time (and where they landed)

- IndexedDB migration — still deferred (storage fits comfortably).
- Biometric unlock — still deferred (passphrase + auto-lock is solid).
- Receipt images — still deferred (needs IDB).
- Cashflow forecast chart — **shipped in v3.1**.
- Goal templates — **shipped in v3.1**.
- Year heatmap — **shipped in v3.1**.
- Weekly review prompt — **shipped in v3.1**.

### Migration warnings

- Existing data is preserved. `DEFAULT_DB` was extended; `load()` merges saved data over `DEFAULT_DB` so existing users see safe defaults.
- No schema migration required. Goals optionally gain a `parentId`; old goals just have it as `undefined`.
