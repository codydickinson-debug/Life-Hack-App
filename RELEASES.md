# Ascend — Releases

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
