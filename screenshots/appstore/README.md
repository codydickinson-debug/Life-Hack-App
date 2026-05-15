# App Store screenshots

Drop these in here before App Store submission. They MUST be exactly **1290 × 2796** (iPhone 6.9" — the 15/16 Pro Max base spec). App Store Connect will reject anything else.

## How to capture

Easiest path (you only need a desktop browser):

1. Open <https://life-hack-app.vercel.app> in Chrome
2. F12 → Toggle device toolbar (`Cmd+Shift+M` / `Ctrl+Shift+M`)
3. **Responsive** → Custom dimensions: **430 × 932** ← important
4. Device pixel ratio: **3.0** ← important (renders at 1290 × 2796)
5. Settings → Load demo data (so you don't capture real personal info)
6. Navigate each tab, capture full-screen, save here

Save files with these exact names — they're referenced in the iOS launch doc and the App Store Connect upload order:

| File | Tab | Should show |
|---|---|---|
| `today.png`     | Today           | Daily Pulse banner, habits with streaks, wins, week dot strip, Wealth Score card |
| `money.png`     | Money → Wealth  | Wealth Health card, net-worth chart, accounts list, debt rows with APR + due date |
| `cornileus.png` | Cornileus chat  | Mid-conversation with a meaningful answer (use the morning briefing prompt) |
| `plan.png`      | Plan            | Plan Health snapshot, plans with pace chips, linked-bucket pills |
| `stats.png`     | Stats           | Mood strip (last 30 days), insights, year heatmap |

## Status

| File | Present? |
|---|---|
| `today.png` | ❌ |
| `money.png` | ❌ |
| `cornileus.png` | ❌ |
| `plan.png` | ❌ |
| `stats.png` | ❌ |

Without these, App Store submission will be rejected before reaching review.

## After capture

In Xcode → Window → Organizer → your archive → Distribute → after upload, go to App Store Connect → your app → Version → Screenshots → upload these.

Apple keeps the screenshots forever even if you change the app, so it's worth getting the demo data juicy. Tip: before capturing, manually:
- Mark a couple habits done today (so streaks show)
- Add a recent win
- Make sure Cornileus has a chat in progress
