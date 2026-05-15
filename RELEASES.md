# Ascend — Releases

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
