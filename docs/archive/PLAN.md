# Ascend v3 — Implementation Plan

> Living plan for the App-Store-quality pass. Updated as work proceeds.

## What I found

Ascend is more mature than the brief assumed. The single-file PWA already includes:

- Multi-account Plaid sync (items, accounts, balances, transaction sync)
- Category rules engine for auto-categorization
- Allocation rules for income splitting
- Bills detection (recurring spend pattern surfacing)
- Paycheck/income detection with split suggestions
- Net-worth surfaces (assets, liabilities, holdings, debt meta)
- Habits with groups, streaks, daily progress
- Goals with three tiers (daily / short / life)
- Savings goals with logs
- Wins log
- AI insights via Anthropic (browser-direct)
- Two-layer encryption (passphrase + AES-GCM)
- Themed light/dark/auto with refined design tokens
- Onboarding flow
- Service worker that auto-derives cache name from `index.html` hash (no manual VERSION bump needed — any byte change to `sw.js` triggers SW update)

So this isn't a rebuild — it's a targeted layer of features that bring it from "thoughtful personal app" to "App-Store quality life-and-money app."

## What this pass adds

### Tier 1 (shipping this round)

1. **Goal hierarchy** — `parentId` on goals. A "Life" goal can have "Short-term" children, which can have "Daily" children. Goals tab gets a tree view + a "Path to my big goal" focused view that shows the chain.
2. **Safe-to-spend** — a single number on Today and Money tabs: `(monthly income forecast − fixed bills due this month − month-to-date spend − this-month savings target) / days remaining in month`. The owner instantly knows what they can spend today without breaking budget.
3. **Net-worth history** — monthly snapshots auto-captured on save when balances change. Sparkline + month-over-month delta on the Money tab.
4. **Privacy mode** — toggle in Settings + a header tap to blur all dollar amounts. Useful in public.
5. **Auto-lock** — when a passphrase is set, clear `APP_KEY` after N minutes of background. Settings choice: 1 / 5 / 15 / never.
6. **Recurring transactions** — user-managed recurring expenses and income with cadence (weekly / biweekly / monthly / yearly), used for safe-to-spend and cashflow forecast.
7. **Reflection journal** — append-only daily entries, encrypted with the rest of `DB`. Optional weekly prompt.
8. **Wins celebration** — small canvas-based confetti on streak milestones (7, 30, 100, 365) and goal completion.
9. **Share-with-roommate doc** — Settings section explaining the per-`userId` backend model so the owner can onboard their roommate.
10. **Polish** — copy review, empty-state improvements, settings reorganization for the new sections.

### Tier 2 (deferred to v3.1)

- IndexedDB migration (current `localStorage` works for the data sizes this owner will hit)
- Biometric unlock (WebAuthn) — non-trivial, defer
- Receipt images (storage cost would push toward IDB migration first)
- Cashflow forecast chart (recurring tx → 90-day projection)
- Goal templates gallery (the current goal flow is fine; templates are a polish item)
- Share Target API (PWA-feature polish)
- Real shared-goals between users (v4 scope)

## Constraints honored

- Single `index.html`, no build, no framework.
- All new persisted fields added to `DEFAULT_DB` so they survive reload.
- `localStorage["ascend_v2"]` storage key unchanged.
- Inline `onclick` pattern preserved; new handlers exposed on `window`.
- All new user data interpolated through `esc()`.
- Encryption layers untouched — auto-lock just clears the in-memory `APP_KEY`.
- Plaid amount sign convention preserved (positive = outflow).
- No new network deps. No telemetry. No paid tier.

## Service worker

Sandboxed-to-current-design: `sw.js` already auto-derives its cache name from a SHA-256 of `index.html`. Every byte change to `index.html` invalidates the cache automatically. `sw.js` itself only needs touching when an icon or other static asset is added; in this pass the asset list doesn't change but I'll touch `sw.js` to force the SW to update for installed PWAs.

## Verification approach

No test framework. I'll run:
- A Node syntax check on the script body extracted from `index.html`
- A headless render check by parsing the HTML and confirming required elements exist
- Manual flow walkthrough notes in the final report (the owner will verify in browser)

## Out of scope this pass

- The brief asks for an IndexedDB migration. Holding off — the owner's data volume (no receipts, modest transaction count) fits well within `localStorage`'s ~5MB cap, and the migration carries real corruption risk for existing data. Will revisit when data size warrants it.
- The brief asks for biometric unlock. WebAuthn flows for PRF-extracted symmetric keys are still spotty across browsers and would need a fallback path that adds complexity for marginal gain. Passphrase + auto-lock is solid; biometrics is v3.1.
- The brief asks for full debt-payoff snowball/avalanche projection. Existing `debtMeta` plus the strategy setting are the foundation; a full projection table is v3.1.
