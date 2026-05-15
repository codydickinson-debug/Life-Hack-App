# Ascend

A focused habit, goal, and money tracker. Single-file PWA — installs on your iPhone home screen and works offline. Optional bank sync (Plaid), live stocks research, and an in-app financial counselor (Cornileus).

## What's in this folder

```
Life-Hack-App/
├── index.html              ← the whole app (HTML + CSS + JS in one file, ~20k lines)
├── manifest.json           ← PWA manifest (Add to Home Screen)
├── sw.js                   ← service worker (offline + caching)
├── icon-*.png              ← app icons (180/192/512/maskable + iOS sizes)
├── stockanalyzer/          ← Python Flask app for live stocks (served at /stockanalyzer + /api/*)
├── api/index.py            ← Vercel WSGI shim that mounts the Flask app
├── backend/                ← optional Cloudflare Worker for Plaid bank sync
├── docs/archive/           ← older planning + review docs (kept for history)
├── CLAUDE.md               ← architecture notes for Claude / future maintainers
├── DEPLOY.md               ← first-time setup walkthrough (Plaid, Cloudflare, AI proxy)
└── README.md               ← this file
```

## Try it locally

```bash
npx -y serve .
```
Open `http://localhost:3000`. The app works fully — only Stocks needs the deployed Python backend.

Or just double-click `index.html`. Everything except the service worker (offline support) and Stocks tab works on `file://`.

## Deploy

The repo is wired to Vercel. Push to `main` on `codydickinson-debug/Life-Hack-App` → Vercel auto-deploys both the static site and the `/api/*` Python backend. Live at https://life-hack-app.vercel.app.

For first-time deploy from scratch (Plaid keys, Anthropic key, Cloudflare Worker, etc.), see `DEPLOY.md`.

## Install on iPhone

1. Open https://life-hack-app.vercel.app in **Safari**
2. Share → **Add to Home Screen**
3. Confirm — opens fullscreen, behaves like a native app

## How the app is laid out

Seven bottom tabs:

| Tab | What it's for |
|-----|---------------|
| **☀︎ Today** | Daily home — habits, wins, mood, Daily Pulse, Smart Plays preview, week strip |
| **▤ Calendar** | Habits + wins + mood + bills by day. Year heatmap toggle for 12-month view |
| **◎ Goals** | Daily / short-term / life goal tiers with sub-step ladders |
| **✦ Plan** | Plan Health snapshot, what-if simulator, Smart Plays, credit card matches, plans by tier |
| **$ Money** | Sub-tabs: Savings, Wealth, Forecast, Budget, Spend. Plus Money Health snapshot + cashflow forecast |
| **↗ Stocks** | Live quotes, market scans, housing/mortgage analyzers (powered by the Python backend) |
| **▦ Stats** | Your Journey lifetime totals, 12-week heatmap, streak insights, year review |

Plus:
- **✨ Cornileus FAB** (bottom-right) — your in-app financial counselor. CFP-level planning, knows your numbers, available from any tab.
- **➕ Quick-add FAB** — log spend/wins/habits from anywhere
- **⚙ Settings** (top-right gear) — name, theme, accent color, encryption, customize tabs/sections, take the tour, export/import
- **👁 Privacy mode** (top-right eye) — blurs every dollar amount across the app for screen-sharing

## Tour

First-time users get a 12-step interactive walkthrough that loads demo data temporarily so every tab shows up populated. Replay any time from **Settings → 🧭 Take the tour**. Demo data is in-memory only — your real data is restored on tour exit.

## Data & privacy

Everything lives in `localStorage` on your device (`ascend_v2` key). Nothing leaves the device unless you opt in to bank sync or AI features.

**Optional client-side encryption**: set a passphrase in Settings → Encryption. The whole DB is AES-GCM encrypted at rest using a PBKDF2-derived key (600k iterations, current envelope). Forgotten passphrase = unrecoverable by design.

**Bank sync (Plaid)**: optional. Plaid access tokens are AES-GCM encrypted server-side in Cloudflare KV before storage. Read-only — Ascend never moves money.

**AI (Cornileus)**: routed through a backend proxy (Vercel Python or Cloudflare Worker). The Anthropic API key never touches the browser. Per-user daily call cap enforced server-side.

Use **Settings → Export data** to back up regularly. **Reset everything** wipes all local data.

## Iterating

Open `index.html` — everything's there. Top of the `<script>` block has a curated table of contents pointing at the major sections. Edit, save, refresh.

Working with Claude Code? Run `claude` in this folder. `CLAUDE.md` auto-loads as context. Commits push to `main` and Vercel auto-deploys in ~30 seconds.

## Roadmap

Open ideas (ask if you want any of these):
- Apple Health integration (auto-check workout/water habits)
- Real push notifications when app is closed (needs server piece)
- Recurring-deposit auto-allocation across savings buckets
- Family / shared accounts
- Charting library upgrade (current charts are SVG-by-hand)
- Light-mode polish pass
