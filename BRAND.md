# Brand & Positioning Brief

**Status:** Draft for Dylan + Cody to align on. Not a unilateral decision.
**Author:** Claude (acting as collab/co-pilot), working at Dylan's request.

This document is **input for a conversation**, not a decree. Read it, mark up
what you disagree with, and we lock the direction together before any
user-facing copy or branding actually changes in code.

---

## TL;DR

Three decisions that need to be made together, in this order:

1. **The name.** "Life Hack" is fine as a codename; it has real problems as a
   shipped product name (trademark, App Store search, "TikTok meme" association
   that fights finance credibility). Candidate replacements below.
2. **The one-sentence pitch.** "A money manager, financial advisor, planner,
   and brokerage" is a vision, not a pitch. Pitches are sharp. And two of those
   four words are regulated terms in the US (see *Legal Language*).
3. **The launch wedge.** Big-vision apps that win usually launch with one
   sharp wedge, then expand. Picking the wedge determines onboarding, App
   Store screenshots, and what "magic moment" we build first.

Nothing below is final. The right output of this brief is a 30-minute call
between you two where you pick.

---

## 1. The Name

### Current

**Life Hack** — "Life done on easy mode."

### What's working

- Conversational, memorable, broad enough to allow expansion.
- "Easy mode" is sticky and on-trend (gaming/Gen Z vocabulary).
- The name is already in the GitHub repo, so changing it is cheap *now* and
  expensive *later* — better to make the call before launch.

### What's working against it

| Risk | Reality |
|---|---|
| Trademark defensibility | "Life hack" is a generic English phrase; Lifehacker.com is a 20-year-old established brand (G/O Media). Even non-infringement leaves us indefensible against copycats. |
| App Store search | Search "life hack" in the App Store today — 50+ results. We'd launch buried. |
| Association | The phrase lives in the TikTok universe of "20 kitchen tricks." Not the world serious finance customers want to trust with their data. |
| Demographic ceiling | A 45-year-old high earner ($10–100/mo target subscriber) reads "Life Hack" and dismisses the app as a teen toy. We'd lose our most valuable persona. |

### Replacement candidates — researched

Names I'd seriously consider, with a 1-line read on each:

| Name | Vibe | Notes |
|---|---|---|
| **Compass** | Direction, calm, navigational | Strong contender. Lots of "Compass" in fintech adjacent, but few direct collisions. Easy logo (compass rose). |
| **Atlas** | Comprehensive, foundational | Slightly heavier than Compass. Suggests "all of your money in one place" naturally. |
| **Tally** | Quick, casual, money-coded | Already used by a UK fintech (Tally Money, gold/silver-backed). Likely conflict. **Skip.** |
| **Anchor** | Calm, grounding, opposite of crypto-volatility | Anchor (the podcast platform) is gone, name is free. Good. |
| **Tide** | Money in/out, rhythmic | Tide is a UK business-banking brand. Likely conflict. **Skip.** |
| **Foundry** | "Where you build your financial life" | Less obviously money but works metaphorically. Founder/builder energy. |
| **Spire** | Tall, aspirational, upward | Already used by Spire Health, Spire Global. Some conflict but different categories. |
| **Beacon** | Guidance, visibility | Less differentiated. Pass. |
| **Levr** | "The lever for your life" | Brandable, available, modern spelling. Risk: cute spellings age badly. |
| **Northstar** | Direction, single point of focus | A bit overused in tech (Northstar metric, etc.). Decent. |
| **Ascend** | Already used internally | Already where the app started conceptually. Good middle-ground option — finance + growth, no regulator triggers. Trademark search needed. |
| **Lumen** | Light, clarity, modern | Lumen (the metabolism breath device) is a strong existing brand. Risky. |
| **Halo** | Protective, simple, premium | Apple-adjacent associations. Available enough. |
| **Vault** | Security, encryption fits our story | "Vault" is heavily used in finance. Many small apps named Vault. App Store crowded. |

**My top three** if I had to pick today: **Compass · Atlas · Anchor**

All three:
- Are real English words (memorable, easy to say)
- Have positive emotional associations (direction, foundation, stability)
- Don't fight finance credibility
- Have available .com / app store presence we can probably win
- Survive a 45-year-old's smell test
- Survive a Gen Z user's smell test (not corporate either)

**Action:** before locking, run USPTO TESS trademark search + App Store name
search for the final pick. I can do both if you tell me which to investigate.

### What to do with "Life Hack"

Two viable paths:

**A. Keep as codename, rename for launch.** Recommended. Today the code says
"Ascend" in manifest.json and various places, "Life Hack" in the GitHub repo
name, and the deployed URL is life-hack-app.vercel.app. None of this is on the
App Store yet — we have a free window to align everything.

**B. Lean into "Life Hack" deliberately and own the TikTok finance segment.**
Brand voice becomes playful and the App Store description leans into "finance
made easy." This is also a legitimate strategy — Cleo did this for Gen Z and
built a billion-dollar business. But it forecloses the serious-finance
segment.

---

## 2. The One-Sentence Pitch

### What we have

> "A money manager, financial advisor, planner, and brokerage — anything
> related to managing your finances."

That's a feature list and a vision, not a pitch. Pitches answer:
**Who is this for, what does it do, why is it different.**

### Why it can't ship as-is

Two of those words are **regulated in the US**. We covered this in detail
earlier; short version:

- **"Financial advisor"** — using this term while giving personalized advice
  for compensation requires SEC or state RIA registration. Costs tens of
  thousands and months to obtain. App Store and FINRA actively pattern-match
  on this language.
- **"Brokerage"** — being a brokerage requires SEC broker-dealer registration,
  FINRA membership, SIPC insurance, capital requirements. Multi-million-dollar,
  multi-year process. Robinhood is a brokerage. Public is a brokerage. They
  went through this.

You can describe the app honestly without using either word:

| Don't say | Say |
|---|---|
| "Your financial advisor" | "Your personal-finance coach" / "AI insights" |
| "A brokerage" | "Link your investment accounts" / "Track your portfolios" |
| "Investment advice" | "Investment education and tools" |
| "Guaranteed return" | "No market risk" / "Locks in [X]%" |

### Candidate pitches

I drafted these so we have something to argue with:

1. **"One app for your whole financial life — track, plan, and grow your
   money in one place."**
   *Wide, honest, captures the everything-in-one ambition.*

2. **"The only finance app that builds money habits — not just tracks money."**
   *Tight wedge, unique. Habits are a thing other finance apps don't do.*

3. **"Personal finance, on easy mode."**
   *Keeps the "easy mode" energy if we don't kill the tagline.*

4. **"Your money. On autopilot. With a plan."**
   *Three-beat. Implies automation + direction.*

5. **"Adulting, automated."**
   *Punchy and Gen Z-coded. Might be too narrow if we want all ages.*

6. **"The financial life-OS."**
   *Tech-coded. "Operating system for your money." Strong with builder/founder
   demographic; might feel cold to general consumer.*

**My read:** #1 is the safest for a wide-audience launch. #2 is the most
*distinct* but commits us to leaning into habits hard (which I think is the
right move). We can lock whichever after we pick the name — name and pitch
have to work together.

---

## 3. The Launch Wedge

Big-vision apps that go viral usually launch with **one** sharp wedge, then
expand. Pick the wedge → the App Store screenshots, the home tab, the demo
video, the magic moment all flow from it.

### Candidate wedges

1. **Habits + Money** — the only finance app that builds wealth-building
   *behaviors*, not just tracks money. The app already has this; nobody else
   does. *Strongest unique angle in my opinion.*

2. **Encrypted + Private** — "Mint died and sold your data; we encrypt
   everything locally, no ads, no data sales." Differentiator vs. the
   Intuit-owned tools. Resonates strongly post-Mint shutdown.

3. **AI Coach** — "An AI that reads your spending and coaches you." Cleo
   has the chat-roast angle; we'd want a different flavor (calm coach? CFP
   personality?).

4. **The Money Pyramid** — gamified financial-priority order (already
   exists in the app). "Level up your money." Duolingo-style progression.

5. **Comprehensive everything** — "your whole financial life in one app."
   The actual vision but the weakest pitch (Mint tried this and burned out).

**My recommendation:** lead with **wedge #1 (habits + money)** in
positioning + App Store. Use **wedge #2 (privacy)** as the differentiator
when comparing to Mint/competitors. Use **wedge #3 (AI Coach)** as the
viral moment / TikTok demo. Wedge #5 (comprehensive) is the *long-term
vision* but not the launch story.

---

## 4. Legal Language — Standardize Now

Adopt these as house style across all copy (app, App Store, marketing,
social):

| Always say | Never say |
|---|---|
| Personal-finance coach / AI insights | Financial advisor / investment advisor |
| Educational / illustrative | Recommendation / professional advice |
| Track / link your investment accounts | Brokerage account (when describing us) |
| No market risk / locks in [X]% | Guaranteed return / risk-free return |
| Possible / typical / historical | Will / promises / always |
| Consult a licensed professional | Trust our advice |

The legal-copy-audit PR (#2) already fixes the violations of the right
column inside the codebase. This table is for ongoing discipline.

---

## 5. App Store Listing — Draft Bones

Once we lock the name + pitch, the App Store listing has a tight format.
Drafting the structure now so it's easy to fill in:

```
Name: [TBD — locked from §1]
Subtitle (30 chars): [punchy version of the pitch]
Promotional text (170 chars): [the one paragraph that sells it]

Description:
  Hook (1 sentence)
  3 short paragraphs covering: habits angle, money angle, privacy angle
  Feature bullets (10–15 items)
  Disclaimer paragraph (educational tool, not advice)

Keywords (100 chars total): personal finance, budget, savings, habits,
  money, goals, retirement, wealth, debt, networth, plaid, encrypted

Screenshots (8 total):
  1. Today tab (the hero — needs to be perfect)
  2. Habits view
  3. Net worth chart
  4. Smart Plays (the "AI coach" moment)
  5. Encryption / privacy
  6. Year-in-review shareable card
  7. Calculators sampler
  8. Onboarding screen
```

We can draft real copy for each of these after the name + pitch are locked.

---

## 6. What I'm asking you and Cody to decide

In rough order of priority:

1. **Name direction.** Keep "Life Hack" (with a TikTok-segment commitment),
   or rename. If renaming, which 1–2 candidates from §1 do we trademark-search?
2. **Pitch sentence.** Pick one or write your own. Whatever it is, it's the
   answer to "what's this app?" when a friend asks.
3. **Launch wedge.** Which is the front door — habits, privacy, AI, pyramid,
   or comprehensive?
4. **Should I do trademark research** on the top 2–3 name candidates? (I can
   check USPTO TESS + App Store + .com + Instagram handle availability.)

Once you two have ~30 minutes to agree, the rest of the work cascades:
- Updating manifest.json, README, deployed URL, App Store description, etc.
- App Store screenshots
- Today tab redesign (locked once we know the wedge)
- Onboarding flow (locked once we know the pitch)

Until then, I'll keep working on changes that don't depend on the name —
the legal copy audit is already done as a separate PR. Today-tab
decluttering and the shareable Year-in-Review card are next; both are
brand-neutral until we re-skin them.

---

## 7. My honest opinion (you didn't ask for this but here it is)

If I were sitting in a room with you two:

- **Name:** *Compass.* It's calm, directional, professional, brandable, and
  it does the work of selling "we help you find your way." A compass rose
  is also a beautiful logo that scales from app icon to favicon to physical
  swag.
- **Pitch:** *"One app for your whole financial life — track your money,
  build the habits, and grow it on autopilot."*
- **Wedge:** *Habits + Money fusion.* Lead with it. It's the only
  truly-unique-to-us angle. Everyone else has the dashboard; nobody else
  pairs it with daily action.
- **Tagline:** *"Money. Made simple. Done daily."*

If you hate any of this, that's the most useful response. We refine.

---

*End of brief.*
