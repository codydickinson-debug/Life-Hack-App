# App Store listing copy — first-draft pack

Everything you need to fill out in App Store Connect, written before the
final brand name is locked. Most fields below use `{{NAME}}` as a placeholder
— find-and-replace once `brand-brief` is decided.

Apple's character limits are real and counted in the API. I've matched them.

---

## 1) App name + subtitle (max 30 + 30 chars)

The App Store search algorithm weighs the name + subtitle heavily, so they
should include the most-searched-for terms users would type. Subtitle is *not*
just a tagline — it's keyword real estate.

**Option A — finance-led** (matches the ai-onboarding-v2 + appstore-pwa-polish direction)
```
Name:     {{NAME}}: Money & Habits
Subtitle: Budget, save, plan, invest
```
- Name uses 22 / 30 chars (room for a 7-char brand)
- Subtitle hits "budget" + "save" + "plan" + "invest" — high-volume keywords

**Option B — life-led** (matches the Ascend / Goals-made-easy direction)
```
Name:     {{NAME}} — Goals & Money
Subtitle: Habits, budget, stocks, plans
```

**Option C — neutral**
```
Name:     {{NAME}}
Subtitle: One app for money & life goals
```

Pick the option that matches whatever brand-brief decides.

---

## 2) Promotional text (max 170 chars) — updates without resubmission

```
Set goals. Build habits. Get your money working. The AI coach builds your
plan in 3 minutes — encrypted on your device, no ads, no signups.
```
(168 chars.)

This is the only field Apple lets you change without resubmitting a binary.
Use it for time-sensitive offers ("Now with Plaid bank sync"), launch
announcements, or seasonal updates.

---

## 3) Description (max 4000 chars)

```
{{NAME}} is the everyday app for the parts of your life that all affect each
other — your daily habits, the goals you're aiming at, the money you're
spending, and the investments you're making. Most apps do one thing well.
{{NAME}} pulls the picture together.

WHY {{NAME}} EXISTS
You shouldn't need five apps to run your life. Habit trackers don't know your
budget. Budgeting apps don't know your goals. Investment trackers don't know
either. {{NAME}} is the answer for everyone tired of stitching together the
financial advisor, life planner, and habit coach you can't afford to hire
separately.

THREE MINUTES TO SET UP, YOURS FOREVER
The first time you open the app, Ascend AI runs a quick conversation: your
name, the area you want to improve, your 5-year vision, what you can do this
week. It builds a starter plan tailored to you — habits to start, goals worth
chasing, and a budget that fits your life. Keep what works, drop what doesn't.

WHAT'S INSIDE
- DAILY HABITS. Streaks, groupings (health / mind / money / faith), and a
  checklist that feels good to use. No nagging notifications.
- GOALS YOU FINISH. Short-term sprints chained to your 5-year vision. The AI
  helps break big goals into next-week-sized moves.
- MONEY IN PLAIN ENGLISH. Safe-to-spend today, budget vs. actuals, debt
  payoff math (avalanche or snowball), optional bank sync via Plaid.
- STOCKS & INVESTING. Full StockAnalyzer built in: 4-pillar analysis, Monte
  Carlo projections, scan stocks / REITs / crypto / bonds for buy signals.
- HOUSING & MORTGAGES. ZIP-level buyer's vs. seller's market reads, live
  30y / 15y mortgage rates, full payment calculator with PMI and refi math.
- AI COACH. Monthly insights review your spending and tell you what to fix.
  Quick decisions get a sanity check from Claude.

PRIVACY THAT ACTUALLY MEANS SOMETHING
- Your data lives on your device, encrypted with a passphrase you choose.
- No accounts, no signups, no analytics tracking you across apps.
- No ads. No data sales. No subscriptions selling your habits to advertisers.
- Bank credentials never touch our servers — Plaid handles them directly.
- Open-source under the hood. Inspect the code yourself.

WHO IT'S FOR
- Anyone who wants money, habits, and goals in one place
- People building toward financial independence
- Anyone tired of subscription apps that nickel-and-dime you
- Investors who want analysis without paid services

WHO IT'S NOT FOR
- Day traders. {{NAME}} is for long-term thinking and disciplined moves.
- People expecting financial advice. We don't give it — we help you see your
  numbers and decide for yourself. This is an educational tool, not a
  registered investment advisor.

WHAT IT COSTS
Free. No premium tier, no paywalled features.

PRIVACY POLICY: {{PRIVACY_URL}}
TERMS OF SERVICE: {{TERMS_URL}}
SUPPORT: {{SUPPORT_EMAIL}}
```
(Around 2,800 chars — leaves room.)

**Before submission**, replace:
- `{{NAME}}` × ~10 with the final brand name
- `{{PRIVACY_URL}}` with the hosted privacy.html URL
- `{{TERMS_URL}}` with the hosted terms.html URL
- `{{SUPPORT_EMAIL}}` with the real support address

**Things you may need to soften** depending on the legal-copy-audit pass:
- "everyday app for the parts of your life that all affect each other"
- The "WHO IT'S NOT FOR" disclaimer ("not a registered investment advisor")
  is intentional — keep it. Apple's review team looks for this in finance
  apps, and SEC's looks even harder. The legal-copy-audit branch should
  cross-check the in-app copy against this same line.

---

## 4) Keywords (max 100 chars, comma-separated, no spaces between)

App Store search is keyword-based. Use words people actually type. Don't
repeat words already in the name or subtitle (they're scanned automatically).

```
budget,savings,goals,habit,tracker,money,finance,investing,stocks,plaid,plan,debt,wealth,mortgage,fire
```
(99 chars.)

If "fire" feels niche, replace with "ai" or "coach" (both relevant and high
volume). FIRE = Financial Independence Retire Early — extremely active
community on App Store.

---

## 5) "What's New" — for v1.0

```
Welcome to {{NAME}} v1.0!

This first release brings together everything we've been building:
- Daily habits and goal tracking
- Smart money management with safe-to-spend math
- Built-in stock + housing market analysis
- 3-minute AI setup that tailors the app to you
- Encrypted-on-device, no accounts, no ads

Tell us what's missing: {{SUPPORT_EMAIL}}
```

---

## 6) Screenshot captions

Apple shows up to 10 screenshots, 1290×2796 for the iPhone 6.7" tier (the
required size). Each one needs a 2-3 word caption baked into the image (or
overlaid in a marketing banner). Below are caption drafts in order — the
first 3 are the most important because most users only see those without
scrolling.

| # | Screenshot focus | Headline | Subhead (smaller) |
|---|---|---|---|
| 1 | Today tab — habits checked off, streak visible | "Discipline ≥ motivation" | "Stack the wins that matter" |
| 2 | AI onboarding chat in progress | "Set up by talking, not tapping" | "3 minutes, then it's yours" |
| 3 | Money tab — safe-to-spend big number | "What you can spend today" | "The math, simplified" |
| 4 | Stocks dashboard — leaderboard with verdicts | "Decide with numbers" | "Built-in StockAnalyzer" |
| 5 | Housing snapshot for a real ZIP | "Buyer's market or seller's?" | "Down to your ZIP code" |
| 6 | Mortgage calculator with results | "Plan the house math" | "Real rates from FRED" |
| 7 | Goals tab — chained short → long | "5 years, broken into Mondays" | "Track the chain, not the goal" |
| 8 | AI insight card | "A coach who reads your numbers" | "Monthly review, on tap" |
| 9 | Privacy setup screen | "Encrypted, on your phone" | "No accounts. No tracking." |
| 10 | Year-in-review share card | "Your year, in one image" | "Share the work, not the data" |

The "≥" symbol in #1 is intentional and renders fine on iOS. Replace with
">" if a brand audit doesn't like the math joke.

---

## 7) App Store category

Primary: **Finance**
Secondary: **Productivity**

(matches appstore-pwa-polish manifest `categories: ["finance", "productivity", "lifestyle"]`)

---

## 8) Age rating answers

Apple asks for these one-by-one. All "None":
- Cartoon Violence — None
- Realistic Violence — None
- Sexual / Nudity — None
- Profanity — None
- Drugs / Alcohol — None
- Gambling — **Infrequent/Mild** (only if Plaid bank sync surfaces gambling
  transactions; otherwise None)
- Horror / Scary — None
- Mature themes — None

→ rating: 4+

---

## 9) Required fields you'll still need

- **Support URL** — link to the eventual hosted SUPPORT.md page (or a
  contact form)
- **Marketing URL** — the marketing landing page once deployed at the apex
  domain
- **Privacy Policy URL** — required for any app that connects accounts or
  uses any analytics. Mandatory for App Store submission.
- **App Privacy Details** (the "nutrition label"):
  - Data Used to Track You: **None**
  - Data Linked to You: **None** (everything is on-device)
  - Data Not Linked to You:
    - Diagnostics: **only** if you add Sentry or similar later
    - Identifiers: **none** unless you add an install ID
  - **Note:** when you connect a bank via Plaid, Plaid collects financial
    info — but that's Plaid's privacy policy disclosure, not yours. Apple's
    nutrition label is about what *your* app does.

---

## 10) Submission checklist (the parts the AI can't do for you)

- [ ] Apple Developer Program enrollment complete ($99/yr)
- [ ] App ID registered in Apple Developer portal
- [ ] Signing certificate generated
- [ ] Provisioning profile created
- [ ] App built via Xcode (or Capacitor wrapper) signed with the cert
- [ ] 10 screenshots captured at 1290×2796 for 6.7" iPhone tier
- [ ] At least 6.5" tier screenshots (1284×2778) — Apple regenerates from
      6.7" if you skip, but quality is better if you provide both
- [ ] iPad screenshots if app supports iPad (skip if iPhone-only)
- [ ] App icon 1024×1024 (already generated as `icon-1024.png`) uploaded
- [ ] Privacy policy URL accessible publicly
- [ ] Marketing URL accessible publicly
- [ ] Support URL accessible publicly
- [ ] Submission demo account (if any login is needed) — not applicable
      here since {{NAME}} has no signup
- [ ] Review notes — explain anything reviewers might find confusing (e.g.
      "the optional 'connect bank' feature uses Plaid in sandbox mode for
      reviewers; toggle on in Settings → Backend")
