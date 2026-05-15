# Screenshots

Drop the App Store + PWA install screenshots here. The manifest.json references five mobile shots — the iOS App Store wants a different (larger) set.

## What the manifest needs

5 narrow (mobile) shots, **1170 × 2532 PNG** (iPhone 15 Pro / 14 Pro at 3x). Names matter — they're hard-coded in `../manifest.json`:

| File | Tab / context | Should show |
|---|---|---|
| `today.png` | Today tab populated | Habits with streaks, Daily Pulse, week strip, Wealth Score card |
| `calendar.png` | Calendar tab | Year heatmap OR month with mood emojis on cells |
| `plan.png` | Plan tab | Plan Health snapshot, plans with pace chips, what-if simulator |
| `money.png` | Money / Wealth sub-tab | Net worth chart, accounts, holdings |
| `cornileus.png` | Cornileus chat sheet | Mid-conversation with a recommendation |

Take these from a real iPhone with demo data loaded (Settings → Load demo data) so the screenshots don't reveal personal numbers.

## What the App Store needs (separate set)

Apple requires these sizes in App Store Connect:

| Size | Device | Required? | Count |
|---|---|---|---|
| 1290 × 2796 | iPhone 6.9" (15 Pro Max, 16 Pro Max) | **Yes** | 3-10 |
| 1320 × 2868 | iPhone 6.7" (alt) | Optional | 0-10 |
| 1242 × 2688 | iPhone 6.5" (Plus) | Optional but recommended | 0-10 |
| 2048 × 2732 | iPad Pro 12.9" | Required if iPad supported | 3-10 |

For the App Store, design polished marketing-style frames (you can use the actual screen as the centerpiece with branded headline copy above/below). Tools:
- [Screenshots.pro](https://screenshots.pro)
- [Mockuphone](https://mockuphone.com)
- [AppLaunchpad](https://theapplaunchpad.com)
- Or Figma with an iPhone frame template

## Quick how-to (PWA shots only)

1. Open https://life-hack-app.vercel.app on an iPhone in Safari
2. Settings → Reset everything → confirm (cleans your real data)
3. Settings → Load demo data
4. Take screenshots of each tab listed above (cmd-shift-3 in iOS Simulator, or volume + side button on real device)
5. Crop to the screen bounds (no status bar, no Safari chrome — full-bleed)
6. Save here with the exact filenames above
7. Commit + push. The manifest will pick them up immediately.

## Status

| File | Present? |
|---|---|
| `today.png` | ❌ |
| `calendar.png` | ❌ |
| `plan.png` | ❌ |
| `money.png` | ❌ |
| `cornileus.png` | ❌ |

Until the files exist, the manifest's `screenshots` array references will 404 silently — Chrome's install prompt will just not show screenshots. iOS doesn't use them.
