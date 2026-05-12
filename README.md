# Ascend

A focused habit, goal, and money tracker. Single-file PWA — installs on your iPhone home screen and works offline.

## What's in this folder

```
goals app/
├── index.html          ← the whole app (HTML + CSS + JS in one file)
├── manifest.json       ← PWA manifest (Add to Home Screen)
├── sw.js               ← service worker (offline + caching)
├── icon-180.png        ← Apple touch icon
├── icon-192.png        ← PWA icon
├── icon-512.png        ← PWA icon (large)
├── icon-512-maskable.png
└── README.md           ← this file
```

## Try it locally first (quick sanity check)

Just open `index.html` in a browser by double-clicking. The app works fully — only the **service worker** (offline support) and **Add to Home Screen install** require HTTPS, which is the next step.

## Deploy it so you can install on your iPhone

For iOS to treat it as a real app (icon on home screen, fullscreen, no browser chrome), it has to be served over HTTPS. Three easy options, pick one.

### Option 1 — Netlify drag-and-drop (easiest, ~60 seconds)
1. Go to https://app.netlify.com/drop
2. Sign up (free) if you don't have an account
3. Drag this entire `goals app` folder onto the drop zone
4. You'll get a URL like `https://something-random.netlify.app`
5. Open that URL on your iPhone in **Safari** (must be Safari, not Chrome) and continue to "Install on iPhone" below

### Option 2 — Vercel CLI (good if you'll iterate)
```bash
npm i -g vercel
cd "C:\Users\dblak\Documents\Claude\Projects\goals app"
vercel --prod
```
Follow the prompts. You'll get a `*.vercel.app` URL.

### Option 3 — Use Claude Code to deploy
Since you have Claude Code, you can hand off deployment. Open Claude Code in this folder and ask:

> "Deploy this PWA to Vercel and give me the URL."

Claude Code will run the CLI for you, push it up, and report the URL. After that, the install steps below are the same.

## Install on iPhone (Add to Home Screen)

1. Open your deployed URL in **Safari** on the iPhone
2. Tap the **Share** button (square with up arrow)
3. Scroll down → **Add to Home Screen**
4. Confirm — done. You'll have an Ascend icon on your home screen
5. Tap it: opens fullscreen, no browser bar, behaves like a native app

> Note: must be Safari for the install. After installed, opening the icon launches it in standalone mode.

## How the app works

### Today tab
- Daily focus card shows today's habit progress
- A 7-day mini calendar (this week) — green dot = all habits done that day
- Tap the circle next to a habit to check it off (or count up if it's a counter)
- Long-press the `⋯` to edit/delete a habit
- Wins log — capture little victories as they happen
- Daily quote rotates through 8 quotes by date

### Goals tab
- Three tiers: **Daily** (recurring focuses), **Short-term** (this month/quarter), **Life** (the big ones)
- Each goal has optional sub-steps; checking off all sub-steps auto-completes the goal
- Tap title to edit, `⋯` for full edit/delete

### Money tab
Three sub-tabs:
- **Savings** — buckets like Emergency Fund, Truck, Roth IRA. Each has current/target. Hit "Log" to add or subtract money with a note
- **Budget** — monthly income + expense categories. Auto-calculates leftover (positive = green, negative = red)
- **Spend** — log a transaction (amount, category, note). Recent list + month total

### Stats tab
- 4 KPI cards: habits today, top streak, goals done, savings %
- 12-week heatmap of habit completion (greener = more done that day)
- Top 5 streaks
- Wins + spend this month

### Settings (gear icon, top-right)
- Your name (greeting + home title)
- Theme: Auto / Light / Dark
- Daily reminder time + toggle (works while app is open or installed; for true scheduled push when closed, you'd need a server backend — not built yet)
- Export / Import JSON backup
- Reset everything

## Data & privacy

Everything is stored in your phone's `localStorage` for the app's domain. Nothing leaves your device. Use **Export data** in Settings regularly to back up — clearing Safari data or uninstalling the home-screen app would wipe it.

If you want sync across devices later, the cleanest path is to add a tiny backend (Cloudflare Workers + D1, Supabase, or Firebase). Let me know and I'll wire it up.

## Iterating

Want to change the design, add a feature, or tweak behavior? Edit `index.html` — everything's in there. Open it in your browser as you go to preview. When you're ready, redeploy (drag again on Netlify, or `vercel --prod` again).

If you have Claude Code, just open it in this folder and say what you want changed. It can edit the file, test locally, and push the redeploy in one go.

## Bank sync (Plaid) — Rocket Money style

The app supports **automatic bank account + transaction sync** via Plaid, with end-to-end encryption. It's optional — the manual logging path works without it.

When enabled:
- Real account balances appear in **Money → Spend**
- Transactions auto-import on app open
- Plaid access tokens are AES-GCM encrypted server-side
- Your local data can be wrapped with a passphrase (zero-knowledge)

**To set this up**, follow `DEPLOY.md` — it walks through Plaid signup, Cloudflare Worker deploy, and configuring the iPhone app. Free tier covers personal use indefinitely.

Files involved:
- `backend/worker.js` — the Cloudflare Worker (~280 lines)
- `backend/wrangler.toml` — config (you edit the KV id after creating it)
- `backend/package.json` — for `wrangler` CLI

## Roadmap ideas (ask if you want any of these)

- Subscription detection (recurring transactions → cancel reminders)
- Custom category rules on top of Plaid's auto-categorization
- Net worth chart across all connected accounts over time
- Auto-allocate paycheck deposits to savings goals
- Bill-due predictions + reminders
- Apple Health integration (auto-check workout/water habits)
- Real push notifications (needs the same backend, easy to add)
