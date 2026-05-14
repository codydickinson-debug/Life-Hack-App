# Ascend marketing landing page

A standalone one-page site for marketing / App Store linkout. Single `index.html`
with all CSS inline. No build step.

## Local preview

```bash
cd marketing
python -m http.server 8080
# open http://localhost:8080
```

Icons are referenced via `/icon-192.png` etc. — if previewing standalone, copy
the repo-root icons into this folder or serve from the repo root.

## Deploying as a separate Vercel project

Once you've registered the domain (e.g. `lifehack.app`), this folder is meant
to be deployed as its **own** Vercel project — separate from the PWA app — so
the marketing site lives at the apex domain (`lifehack.app`) while the app
lives at a subdomain (`app.lifehack.app`).

```bash
cd marketing
vercel
# follow prompts; pick a new project name like "ascend-landing"
```

Then in the Vercel dashboard:
1. Add the apex domain (`lifehack.app`) to this landing project.
2. Add `app.lifehack.app` to the `life-hack-app` project (the PWA).
3. Update the `https://life-hack-app.vercel.app` links in this `index.html`
   to point at `https://app.lifehack.app`.

## What to update once content/screenshots are ready

- The phone-frame mockup in the hero is hand-coded HTML/CSS as a placeholder.
  Replace it with a real PNG screenshot (1290×2796) once App Store assets are
  ready — easier to swap a single `<img>` than redesign the mock.
- The `hello@ascendapp.example` mailto is a placeholder. Replace with your
  real support address once the domain is registered.
- `/privacy` and `/terms` links currently 404. Either drop in `privacy.html`
  and `terms.html` next to `index.html`, or wire them up to GitHub Pages.
- The "App Store" badge isn't here yet — add the official "Download on the
  App Store" badge SVG after submission is approved.

## What's intentionally NOT here

- No build tooling, no React, no framework. Single static file ships in
  seconds and never breaks.
- No analytics yet. Add Plausible or Vercel Web Analytics after launch when
  you actually need the numbers.
- No newsletter capture. Add when you have something to send.
