# App Store Listing — Draft

This is the exact copy that gets pasted into App Store Connect fields.
Each field has a hard character limit; counts shown beside each.

> **Status:** Draft. The brand name is **"Life Hack"** here per the
> current direction in `BRAND.md`. If you and Cody decide to rename
> before submission, search-and-replace "Life Hack" across this file
> first.

---

## App Name (30 chars max)

```
Life Hack
```
*9 / 30 chars. Leaves headroom; if needed, expand to "Life Hack: Money" (16 chars).*

**Important:** App Name must be unique on the App Store. Verify
availability at https://apps.apple.com before locking — search "life
hack" and see if there's a collision in the Finance category.

---

## Subtitle (30 chars max)

```
Money on easy mode
```
*18 / 30 chars.*

Alternatives if "Life Hack" is taken:
- "Personal finance, simplified"
- "Your whole financial life"
- "Money. Made simple."

---

## Promotional Text (170 chars max, editable post-launch without re-review)

```
Track every dollar, build money habits, plan retirement, link your bank — all encrypted on-device. No ads. No data sales. Just your finances, finally simple.
```
*162 / 170 chars.*

Promotional text shows above the description and is the most-read copy
on the App Store page. Update seasonally (e.g., "New: AI-coached year
in review").

---

## Description (4000 chars max)

```
Life Hack is the personal-finance app that treats your money like a habit, not a chore.

Build the money habits that actually move the needle — daily check-offs, weekly streaks, monthly goals — all alongside the dashboard you'd expect: spending, savings, retirement, debt, investments.

Then, optionally, link a bank account and watch transactions auto-categorize, bills predict themselves, and your net worth update in real time.

Designed for people who want their financial life to be simple, private, and consistent — not gamified, not preached at, not data-mined.

— WHAT'S INSIDE —

Daily money habits
• Track habits like "Log savings," "Check accounts," "No-spend day"
• Streaks, day chips, and weekly review
• Wins journal — capture small financial victories

Budgeting & spending
• Manual or auto-import (Plaid)
• Smart category rules learn from how you label
• Safe-to-spend calculator — what you can spend today without breaking the month
• Subscription audit — every recurring charge, sortable by waste

Savings & goals
• Multiple savings goals with progress bars and projections
• Sinking funds (one fund per future expense — car, vacation, holidays)
• Auto-allocation rules — split each deposit across goals automatically

Net worth & investments
• Manual or auto-linked accounts, including investments
• Net worth chart with milestone tracking
• Asset allocation by type
• Real estate property analyzer (cap rate, cash-on-cash)

Retirement & planning
• Compound-interest projections with adjustable assumptions
• FIRE calculator
• Roth vs. Traditional IRA explainer
• 529 college planner
• Insurance, estate, and tax-planning checklists

Smart Plays
• Rule-based "what should I do next?" recommendations
• Pyramid of financial priorities (emergency fund → 401k match → debt → IRA → max retirement → taxable)
• Wealth Health score — see your weakest dimension

Calculators
• Mortgage payment, refinance break-even, debt avalanche/snowball
• Inflation projector, purchase-decision framework
• Charitable giving, rental property
• 12+ tools, all free

AI Insights
• Optional. Tap once a month, get a sharp, personalized summary of your spending and a couple of next steps
• Your data never leaves the proxy. The API key is on our backend, never your phone

Stocks, housing, mortgages, news
• Live market data, mortgage rate trackers, housing market snapshots, financial news headlines
• Read-only — we're not a brokerage and we're not pretending to be

— PRIVACY-FIRST BY DESIGN —

• Everything stored locally on your device
• Optional AES-GCM-256 encryption with a passphrase you set (we don't have it; lose it, lose your data)
• No ads, no analytics SDKs, no data sales
• No cross-app tracking (we comply with Apple's App Tracking Transparency by not tracking)
• Open source — every line of code is public

— ABOUT THIS APP —

Life Hack is an educational personal-finance and habit-tracking tool. It is not a registered investment advisor, broker-dealer, or licensed financial planner. Calculators, insights, and lessons are educational illustrations only — not personalized investment, tax, legal, or financial advice. Consult a qualified professional before making significant financial decisions.

Privacy Policy: [URL]
Terms of Service: [URL]
Support: [URL]
```
*~3,400 / 4,000 chars. Headroom for additional features added post-launch.*

---

## Keywords (100 chars max, comma-separated)

```
budget,money,finance,habits,savings,goals,net worth,retirement,wealth,encrypted,private,plaid
```
*92 / 100 chars.*

**Notes on choice:**
- "budget", "money", "finance" — high-volume baseline terms
- "habits", "savings", "goals" — match the differentiating wedge
- "net worth", "retirement", "wealth" — affluent-user search terms
- "encrypted", "private" — privacy-conscious-user search terms
- "plaid" — discovery via brand association

Avoid: words already in the app name/subtitle (Apple double-counts those),
generic phrases like "personal" or "tracker", competitor brand names
(rejection risk).

---

## Support URL

Must be a publicly-reachable page. Options:

- GitHub Issues page (works for v1): `https://github.com/codydickinson-debug/Life-Hack-App/issues`
- Dedicated support page on Vercel: `https://life-hack-app.vercel.app/support` (would need a static `/support.html`)
- Custom domain once registered: `https://support.life-hack.app`

For first submission, the GitHub issues URL is the path of least
resistance and Apple accepts it.

---

## Marketing URL (optional)

Recommended. Options:
- `https://life-hack-app.vercel.app` (current Vercel)
- Custom domain when registered

---

## Privacy Policy URL

**Required.** Must be publicly hosted.

Once `PRIVACY.md` is rendered as a public page (GitHub Pages, Vercel
route, or hosted HTML), the URL goes here. Examples:

- `https://life-hack-app.vercel.app/privacy.html`
- `https://codydickinson-debug.github.io/Life-Hack-App/PRIVACY.html`

**Action item:** convert `PRIVACY.md` → publicly accessible HTML.

---

## Category

- **Primary:** Finance
- **Secondary:** Productivity

---

## Age Rating

**4+**

When the App Store Connect age-rating questionnaire asks:
- Cartoon/Fantasy Violence: None
- Realistic Violence: None
- Sexual Content / Nudity: None
- Profanity / Crude Humor: None
- Alcohol/Tobacco/Drug References: None
- Mature/Suggestive Themes: None
- Horror/Fear Themes: None
- Medical/Treatment Information: None
- Gambling: None
- Contests: None
- Web Access: **Unrestricted** (the app can call out to Plaid, Anthropic, etc.)
- User-Generated Content: **No**

---

## Pricing

**Free.** No In-App Purchases for v1.

Future monetization (subscription, IAP for premium calculators, etc.)
is a separate decision and can be added in a v2 submission without
changing this listing.

---

## App Review — Notes to Reviewer

Paste this in the "App Review Information > Notes" field:

```
Life Hack is a personal-finance and habit-tracking app. All sensitive
data is stored locally on the user's device, optionally encrypted with
AES-GCM-256 using a user-chosen passphrase.

REVIEWER TESTING:
To test full functionality without connecting a real bank account, use
Settings → "Load demo data". This populates the app with realistic
transactions, accounts, savings goals, and habits. No real account
required.

KEY FEATURES TO TEST:
- Onboarding (auto-runs on first launch)
- Today tab: tap habits to check off, view Safe-to-spend
- Money tab: log a manual spend, view recent transactions
- Goals tab: add a goal, mark a step as done
- Stats tab: view net worth chart, year heatmap
- Settings: try the Encryption setting (set a passphrase)
- Year-in-Review (Settings → Year review): see the shareable card

OPTIONAL INTEGRATIONS:
- Plaid for bank linking. Plaid Link handles credentials directly;
  we never see bank logins. Plaid sandbox credentials work for testing.
- Anthropic Claude for AI insights, proxied through a Cloudflare Worker
  so the API key never reaches the client.

LEGAL POSITIONING:
Life Hack is NOT a registered investment advisor, broker-dealer, or
financial planner. All in-app content is educational. This is disclosed
in Settings → About and reinforced in our Terms of Service.

PRIVACY:
- Encrypted local storage (AES-GCM 256, PBKDF2 600k iterations)
- No advertising SDKs, no third-party analytics
- App Tracking Transparency: Does Not Track
- Full disclosure in our Privacy Policy

SUPPORT CONTACT:
GitHub Issues, monitored: https://github.com/codydickinson-debug/Life-Hack-App/issues
```

---

## Screenshots (required)

Apple requires 3–10 screenshots per device size.

### 6.7" iPhone (iPhone 15 Pro Max, 1290×2796) — REQUIRED
1. **Today tab** — habits + safe-to-spend + insight pills (the hero shot)
2. **Money tab** — spending categories + recent transactions
3. **Goals tab** — savings goals with progress bars
4. **Smart Plays sheet** — "what should I do next?" recommendations
5. **Net worth chart** — Stats tab with milestone markers
6. **Year-in-Review shareable card** — the viral moment
7. **Encryption setup** — privacy/security as differentiator
8. **AI Insights** — the magic moment

### 6.5" iPhone (1242×2688 or 1284×2778) — REQUIRED
Reuse the same shots scaled / reframed.

### 5.5" iPhone (1242×2208) — Optional but recommended
Reuse.

### iPad (optional)
Skip for v1 unless you actively want iPad support — opens up a whole
secondary review surface.

**Production note:** screenshots should include caption overlays
("Track every dollar", "Build money habits", etc.) — increases install
conversion 2–3x vs. raw screenshots. Tools like Screenshot Builder
(https://screenshots.pro) or Figma templates make this easy.

---

## App Preview Video (optional, recommended)

15–30 second video showing the app in motion. High impact for
conversion. Tools: QuickTime + iOS Simulator, or third-party
(Rotato, App Mockup).

A simple flow:
1. App opens to Today (1s)
2. Tap a habit to check it off (2s)
3. Swipe to Money tab (1s)
4. Scroll through spending categories (3s)
5. Tap a Smart Play (2s)
6. Tap AI Insights, see Claude's response load (4s)
7. Open Year-in-Review, show the shareable card (4s)
8. Closing brand frame (3s)
