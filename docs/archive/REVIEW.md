# Branch review — 2026-05-13

Review of Dylan's 9 active feature branches against `main`. Goal: surface what's
worth merging, what conflicts with recent work, and what decisions need to be
made before any of them land.

Author: Claude (acting on Cody's request).

---

## 🚨 CRITICAL — read this first

**Every one of Dylan's branches was created from a `main` that's older than
the current `main`.** That means each branch's diff shows my recent commits
as **deletions**:

- `marketing/index.html` → -577 lines (deleted)
- `marketing/README.md` → -54 lines (deleted)
- `stockanalyzer/news.py` → reverts the MarketWatch + Investing.com sources

If any of these branches is merged into `main` *without first rebasing*, my
work will silently disappear from the codebase. GitHub's "merge" button will
happily delete it.

**Fix:** before merging anything, rebase each branch onto current `main`:
```bash
git fetch origin
git checkout <branch>
git rebase origin/main
# resolve any conflicts
git push --force-with-lease
```
Then open the PR. The diff will then show only Dylan's actual changes.

If you don't want to ask Dylan to rebase, the safe path is to merge them via
GitHub's **"Rebase and merge"** button (NOT "Create a merge commit") — that
does the same thing on the server side. Avoid plain "merge commit" merges
until they're rebased.

---

## The big naming/brand decision (gate everything else on this)

Two branches stake out different positions:

- **`brand-brief`** — adds `BRAND.md`, a "draft for Dylan + Cody to align"
  that argues "Life Hack" has trademark, App Store search, and "TikTok meme"
  problems for a finance app. Suggests this needs a 30-minute call to lock
  the name before anything user-facing changes.
- **`legal-docs`, `ai-onboarding-v2`, `appstore-pwa-polish`** — already
  rebrand to **"Life Hack — Money, Habits & Goals"** with tagline
  **"Money on easy mode"**. PRIVACY.md and TERMS.md are written against the
  "Life Hack" name throughout.

**Decision needed first:** is the product called Ascend, Life Hack, or
something else (BRAND.md lists alternatives)? Every other branch's user-
facing copy depends on the answer.

My recent work uses **"Ascend · Goals made easy"**. If "Life Hack · Money on
easy mode" wins, my marketing page hero, slogan, and tagline will need a
small rewrite — straightforward (one find-and-replace pass), but worth
batching with the rest of the rebrand.

---

## Branch-by-branch

### `ai-onboarding-v2` — finance-aware AI coach (91b4d84)
**Verdict:** Strong upgrade over the v1 I just shipped. Merge after rebrand
decision.

Adds:
- Auto-launches the AI chat when backend is configured — skips the splash
  entirely. That's a better "magic moment" than my opt-in button.
- 5-7 turn conversation arc, finance-first questions (income range as a
  range, not exact; financial situation as 5 buckets; smallest weekly move).
- Plan output now includes a **budget** (income, savings target, expense
  categories with monthly amounts), not just habits + goals.
- "Money" is the default focus area, not one of six.

Trade-offs vs. my v1:
- Mine is shorter (3-7 turns) and broader (any area of life). His is more
  focused.
- Mine works as both a first-run and a "retake later" flow. His might too —
  worth verifying he kept the Settings → Retake AI setup row.

**Recommendation:** merge his version, throw mine away. It's a better fit
for the finance positioning that the rest of the work commits to. My system-
prompt-forwarding worker fix benefits his version too.

### `legal-docs` — PRIVACY.md, TERMS.md, SUPPORT.md (f5c6e38)
**Verdict:** Ready to merge after a real attorney glance.

Adds three markdown docs totaling 536 lines. Quality looks high from the
intro section: explicit TL;DR, written to be readable not evasive, calls
out exactly when data leaves the device (Plaid for bank link, Anthropic via
Cloudflare Worker for AI).

The branch's commit message itself says **"These are drafts — strongly
recommend a licensed attorney review and tailor TERMS.md (in particular
limitation-of-liability, indemnification, and governing-law sections)
before public App Store launch."** Trust that.

To use these for the App Store submission, they need to be **rendered as
HTML and hosted at a public URL** — Apple won't accept markdown links. Easy
follow-up: render to `privacy.html` / `terms.html` in the marketing folder
(or wherever you'll host the landing page) and link from there.

### `brand-brief` — BRAND.md positioning doc (a2c6f21)
**Verdict:** This is the decision artifact, not a deliverable to merge as-is.

Acts like a memo to drive a real conversation between you and Dylan about
the name, the pitch, and the launch wedge. It explicitly flags that
"financial advisor" and "brokerage" are regulated terms in the US.

**Recommendation:** read it cover-to-cover *with Dylan on a call* and decide
the three questions it raises. Once decided, the other branches' copy gets
tightened and the marketing page rewritten in one batch.

### `appstore-pwa-polish` — PWA + Capacitor scaffold (f6d0d87)
**Verdict:** Solid mechanical upgrades; merge after rebrand.

manifest.json gets:
- New name/short_name/description (depends on rebrand)
- `id`, `display_override`, `lang`, `dir`, `iarc_rating_id`, `share_target`
- More shortcuts (Today / Add spend / Goals / Money) with proper icon refs
- `screenshots` array (placeholder pointing at icon-512 — needs real
  1290×2796 screenshots before submission)
- adds `icon-180.png` to the manifest (good — my new icons are now referenced)

The branch is also called "Capacitor scaffold" — implies he's wiring up the
iOS wrapper. Worth checking if `package.json` or new dirs are added.

### `today-tab-declutter` — collapse 5 cards into one (b88d8a3)
**Verdict:** UI improvement, no obvious dependencies. Merge after rebrand.

index.html: -268 lines net, focused on the Today tab. Worth seeing
side-by-side on a phone before merging — make sure none of the collapsed
cards held information you actually want surfaced.

### `visual-refresh-v1` — premium dark-first identity (f13346b)
**Verdict:** Big visual change. Highest-risk branch to merge blindly.

330-line change to index.html, all in styles/colors. "Premium dark-first
identity" suggests the default theme flips from light to dark.

**Recommendation:** preview deploy this and look at it on a phone. Pull-to-
refresh isn't enough if the service worker cached an old shell — open
DevTools → Application → Service Workers → Unregister, then reload. Or
deploy to a separate Vercel preview URL.

### `year-review-share-card` — 1080×1920 shareable card (b4c5d32)
**Verdict:** Nice marketing feature, low risk. Merge.

241-line index.html addition (and presumably one new export function). The
PNG output gives Instagram/TikTok-ready content for organic growth — useful
ammo for the customer-discovery phase.

### `legal-copy-audit` — regulator-safe language (884a1c1)
**Verdict:** Small, important. Merge after legal-docs.

Only 15 lines in index.html. Likely tightens any place the in-app copy
says "investment advice" / "financial advisor" / "guaranteed returns" to
something an SEC reviewer wouldn't flag. Should happen *after* legal-docs
so they don't fight each other.

### `ai-proxy-on-vercel` — zero-config AI for every user (c4a4af8)
**Verdict:** Significant infrastructure shift. Discuss before merging.

This is the one that overlaps most with my recent **worker.js** hardening.
The branch's commit message ("zero-config AI for every user") implies the
Anthropic key moves from the Cloudflare Worker secret to a Vercel function,
removing the per-user backend-URL/Enrollment-Key setup step.

**Implications I just committed and would be invalidated:**
- The `system` prompt forwarding fix in `worker.js` — would need to move to
  the new Vercel function instead. Easy port, ~10 lines.
- The per-feature rate limit + burst cap — same, needs to move.
- The Plaid webhook receiver — should stay on the Cloudflare Worker
  regardless, since Plaid posts to a stable URL.

Adds `stockanalyzer/app.py` +137 lines — suggests the Vercel Flask app
gets the Anthropic proxy endpoint(s) added there.

**Recommendation:** read the diff carefully before merging. If you go this
route, my recent backend/worker.js commit needs to be cherry-picked into
the new Vercel proxy (system prompt, rate limits). The Plaid webhook can
keep running on the existing worker if you keep it for that single
purpose.

---

## Suggested merge order

Once the rebrand decision is locked:

1. `legal-docs` — has zero index.html dependency, gets the legal foundation in
2. `brand-brief` — already a doc; merging is symbolic (decisions live in your head, not the file)
3. `ai-onboarding-v2` — supersedes my v1, gets the magic-moment first run
4. `today-tab-declutter` — smaller UI change first, easier to validate
5. `visual-refresh-v1` — preview-test on a phone first; merge after the above settle
6. `year-review-share-card` — feature add, low risk
7. `appstore-pwa-polish` — picks up everything else, manifest rebrand
8. `legal-copy-audit` — final pass over user-facing copy
9. `ai-proxy-on-vercel` — biggest infra shift; decide with eyes open

`security-hardening` is already merged.
`preview-all-changes` is presumably a meta-branch combining the others —
useful for visual review, not for merging into main directly.

---

## Things missing from this set (worth knowing)

- **No screenshot prep branch** — designed 1290×2796 App Store screenshots
  are still TBD. Either Figma work (separate from code) or hand-render.
- **No domain / custom-Vercel-domain branch** — blocked on you registering
  the domain.
- **No Apple Developer enrollment / iOS build branch** — appstore-pwa-polish
  mentions a Capacitor scaffold but it's still PWA-first. The native
  wrapper, certs, and provisioning come after enrollment.
- **No PR review trail** — none of these branches have an open PR yet (the
  GitHub API returns `[]` for open PRs). When Dylan opens them, this review
  may be partly stale.
