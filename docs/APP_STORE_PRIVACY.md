# Apple App Store — Privacy Nutrition Label cheat sheet

Pre-written answers for App Store Connect's Privacy questionnaire so you can fill it in 5 minutes instead of 45. These reflect the app's actual behavior as of 2026-05-15.

If you change anything that affects data flow (add a third-party SDK, add tracking, etc.), update this file and the App Store listing.

---

## Top-level question: "Does this app collect data?"

**Answer: Yes** — even though everything is local-first, the App Store treats "data sent over the network in any feature" as collection. The optional Plaid + AI flows count.

---

## Data Types collected (only the optional ones)

For each of the following, App Store Connect asks four sub-questions. Answers below.

### 1. Financial Info → Other Financial Info

**Linked to user identity:** No
**Used for tracking:** No
**Purpose:** App Functionality
**Reason:** Optional Plaid bank sync. Account balances and transactions sync to the user's own Cloudflare Worker backend. The app has no central database; each user's data goes to the user's own backend deployment. Plaid access tokens are AES-GCM encrypted server-side before storage.

### 2. User Content → Other User Content

**Linked to user identity:** No
**Used for tracking:** No
**Purpose:** App Functionality
**Reason:** When the user sends a message to the in-app AI counselor (Cornileus), the message + a snapshot of their financial situation is forwarded to Anthropic's API via a backend proxy. No user identity is attached. Anthropic's API terms specify inputs aren't used to train.

### 3. Identifiers → Device ID

**Linked to user identity:** No
**Used for tracking:** No
**Purpose:** App Functionality
**Reason:** Each install generates a random per-device user ID stored locally and sent to the user's optional backend (Cloudflare Worker) on every authenticated call. Used only to scope per-device data on that backend. Not advertising-related.

---

## Data Types NOT collected (most of them)

Mark these as **NOT collected** in the questionnaire:

- Contact Info (name, email, phone, address) — stored locally only
- Health & Fitness — N/A
- Sensitive Info — N/A
- Contacts — never accessed
- Location — never accessed
- Search History — stored locally only (no analytics)
- Browsing History — N/A
- Identifiers → User ID, Advertising — neither
- Purchases — N/A (no in-app purchases)
- Usage Data → Product Interaction, Advertising Data, Other Usage Data — none collected
- Diagnostics → Crash Data, Performance, Other Diagnostic — none collected
- Audio Data — only via Web Speech for voice notes; processed by the browser, never sent to a server
- Photos / Videos — N/A
- Other Data — N/A

---

## Tracking question

**"Does this app use data for tracking purposes?"** → **No**

The app uses **zero** third-party SDKs that fingerprint users across apps/sites. No Google Analytics, Mixpanel, PostHog, Sentry, Meta Pixel, TikTok Pixel, Adjust, Branch, AppsFlyer, etc.

---

## Privacy Policy URL

```
https://life-hack-app.vercel.app/privacy
```

The policy lines up with these answers — keep both files in sync if either changes.

---

## App Privacy Report (iOS 15.2+)

Apple's automated weekly privacy summary will surface:

- **Domains contacted:** `life-hack-app.vercel.app` (own backend), and (if user opts in) `cdn.plaid.com`, `*.plaid.com`, the user's configured Cloudflare Worker domain, and the Anthropic API domain reached via the proxy.
- **Sensors accessed:** None.
- **Photos / contacts / location:** Never requested.

---

## Common reviewer rejections to avoid

1. **"App provides financial advice without disclaimer"** — already handled. Cornileus' system prompt always closes recommendations with `Educational guidance — not licensed financial advice.` and the Terms of Use page repeats it. Keep this stance — don't let a future copy edit drop the disclaimer.
2. **"Account deletion is hidden / unclear"** — covered by Settings → Data → "Reset everything". The Apple guideline (5.1.1(v)) requires it to be reachable and effective; ours is.
3. **"Asks for review too aggressively"** — we don't have a review prompt at all. Don't add one without read-through of guideline 1.6.
4. **"Mentions other platforms"** — marketing.html and Settings should not say "available on Android" / "Try our web version" as a CTA. Currently safe.
5. **"Beta or non-finished"** — submit only when polished; Apple rejects "Coming soon" copy.
6. **"In-app purchases not via Apple IAP"** — we have none. If you ever charge for a feature, must use IAP for digital goods (15-30% cut). Bank fees / subscriptions to *external* services don't trigger this.

---

## Things to do BEFORE you click Submit for Review

- [ ] Privacy Policy URL set to `https://life-hack-app.vercel.app/privacy`
- [ ] App Privacy questionnaire filled per this doc
- [ ] Age rating set: 4+ should fit (no objectionable content)
- [ ] Category: Finance (primary), Productivity (secondary)
- [ ] Screenshots uploaded (see `screenshots/README.md` for spec)
- [ ] App Preview video uploaded (optional but recommended)
- [ ] Build uploaded via Xcode/Transporter, processing complete
- [ ] What's New text written (use the in-app `whatsNewSheet` content as a starting point)
- [ ] Promotional text (170 chars) written
- [ ] Description (4000 chars) written
- [ ] Keywords (100 chars total, comma-separated, no spaces wasted)
- [ ] Support URL → GitHub repo or a /support page
- [ ] Marketing URL → `https://life-hack-app.vercel.app/marketing`
- [ ] Test on a real device with a fresh install (not just simulator)
- [ ] Test the Plaid + Cornileus flows on TestFlight before submitting
