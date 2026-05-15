# iOS App Store launch checklist

Step-by-step from "PWA on Vercel" to "live on the iOS App Store."

This whole flow needs a Mac at some point (Xcode is Mac-only). Everything up to that point can be done on Windows.

---

## Phase 0: Things you can do anywhere

### 1. Apple Developer Program ($99/year)

Go to <https://developer.apple.com/programs/enroll/>. You need:
- An Apple ID
- ~24-48 hours for enrollment review
- A US tax ID (SSN or EIN if you have an LLC)
- A D-U-N-S number ONLY if enrolling as a company (free, takes a few days from <https://developer.apple.com/enroll/duns-lookup/>)

Personal/sole-prop enrollment is faster and totally fine. You can convert to an organization later.

### 2. Decide your bundle identifier

This is a reverse-DNS string that uniquely identifies your app on Apple's systems. Used in code-signing and in the App Store URL. Pick once and never change it.

Recommended for Ascend:
```
com.codydickinson.ascend
```
or
```
com.lifehackapp.ascend
```

If you have your own domain, use that. The TLD doesn't matter functionally but should look professional.

### 3. App name and tagline (App Store-facing)

These are separate from your PWA's `name`:
- **App Name** (max 30 chars, no marketing copy in the name itself per Apple): `Ascend — Money & Habits`
- **Subtitle** (max 30 chars, shown on the search results card): `Goals made easy`
- **Promotional Text** (max 170 chars, editable any time without resubmission): `Track habits, money, and goals with an AI counselor that actually knows your numbers. Local-first, encrypted, no tracking.`
- **Description** (max 4000 chars): see `docs/APP_STORE_PRIVACY.md` for the long copy.

---

## Phase 1: Wrap the PWA with Capacitor (Mac required from here)

Capacitor is the modern way to ship a PWA as a native iOS app. It bridges your existing HTML/JS to a `WKWebView` and gives you access to native APIs (push, biometric, etc.) when you need them.

### Setup on the Mac

```bash
# Clone the repo
git clone https://github.com/codydickinson-debug/Life-Hack-App.git
cd Life-Hack-App

# Install Capacitor
npm init -y    # if you don't already have a package.json at the root
npm install @capacitor/core @capacitor/cli @capacitor/ios
npx cap init "Ascend" "com.codydickinson.ascend" --web-dir=.

# Add the iOS platform
npx cap add ios

# Open the Xcode project
npx cap open ios
```

The Capacitor config file `capacitor.config.json` has been pre-committed at the repo root with sensible defaults. Adjust the `bundleId` if you picked a different one.

### Things to configure in Xcode

1. **Signing & Capabilities** → Team: select your Apple Developer team. Capacitor sets a default bundle ID; verify it matches the one you chose.
2. **Capabilities** to enable:
   - Push Notifications (required for VAPID push to work via APNs)
   - Background Modes → Remote Notifications
3. **Info.plist additions**:
   - `NSMicrophoneUsageDescription`: "Used for voice input when adding wins or notes." (you already have voice-to-text in the PWA)
   - No camera/location permissions needed.
4. **Min iOS deployment target**: 16.4 (lowest version that supports Web Push in standalone PWAs — keeps the PWA fallback path intact)

### Native push (APNs) for actual iOS notifications

Apple's APNs handles push for native iOS apps. Capacitor's `@capacitor/push-notifications` plugin gives you:
- An APNs device token on first launch
- A `pushNotificationReceived` event when notifications arrive

For the simplest setup:
1. Generate an APNs auth key in the Apple Developer portal (one-time)
2. Add the auth key to your Cloudflare Worker as a new secret (`APNS_AUTH_KEY`)
3. Modify the Worker's push handler to forward to APNs (Token-based JWT, not certificate-based)

OR — if you want to keep using VAPID (which works for the PWA path), Capacitor has a `webpush` plugin that surfaces Web Push to the native shell. Simpler, but a longer code path.

I recommend starting with APNs (~50 lines on the Worker side); we can wire that as a follow-up if you want.

---

## Phase 2: Screenshots (required for submission)

Apple needs at least these sizes:

| Size | Device | Required? | How many |
|---|---|---|---|
| 1290 × 2796 | iPhone 6.9" (15/16 Pro Max) | **Yes** | 3-10 |
| 1242 × 2688 | iPhone 6.5" (Plus models) | Strongly recommended | 0-10 |
| 2048 × 2732 | iPad Pro 12.9" | Required only if iPad supported | 3-10 |

Decision: declare iPhone-only initially. Reduces required asset count and simplifies review.

### How to capture

Easiest path:
1. Open <https://life-hack-app.vercel.app> in Chrome on a Mac
2. DevTools → Toggle device toolbar → Custom → 430 × 932 (the iPhone 15 Pro Max base resolution)
3. Set device pixel ratio to 3 (so screenshots come out 1290 × 2796)
4. Capture each of the 5 tabs

Save them to `screenshots/appstore/` (a folder I've added) with the names below. Then in Xcode → App Store Connect, upload via the screenshot manager.

| File | Tab | Show |
|---|---|---|
| `appstore/today.png` | Today | Daily Pulse, habits with streaks, wins, week strip |
| `appstore/money.png` | Money → Wealth | Wealth Health card, net-worth chart, accounts |
| `appstore/cornileus.png` | Cornileus chat | Mid-conversation with a useful answer |
| `appstore/plan.png` | Plan | Plan Health card, plans with pace chips |
| `appstore/stats.png` | Stats | Mood strip, insights, year heatmap |

Use the demo data (Settings → Load demo data) so the screenshots don't reveal anything personal.

---

## Phase 3: App Store Connect setup

1. Go to <https://appstoreconnect.apple.com>
2. **Apps → +** → New iOS App
3. Bundle ID: pick the one you registered
4. SKU: any unique string (e.g., `ascend-001`)
5. Primary language: English (U.S.)
6. Pricing: Free
7. Availability: select countries (start with United States only, expand later)

### App Information (left sidebar)

- **Category**: Primary = Finance, Secondary = Productivity
- **Content Rights**: Yes, contains, or has access to third-party content (Anthropic AI, Plaid)
- **Age Rating**: walk through Apple's questionnaire. Answers:
  - Realistic violence: None
  - Sexual content: None
  - Profanity: None
  - Alcohol/Tobacco/Drugs: None
  - Mature themes: None
  - Gambling: None
  - Horror: None
  - Medical info: None
  - Unrestricted Web Access: **Yes** (Plaid Link is a third-party WebView)
  - Result: 4+

### Privacy

Apple now requires a "Data Collected" / "Data Tracked" / "Data Linked to You" declaration. The honest answer for Ascend:

- **Data Collected from this app**: Yes
  - Financial Info (bank balances, transactions) → linked to user, used for App Functionality only
  - User Content (notes, reflections) → linked to user, App Functionality only
  - Usage Data (Cornileus chats) → linked to user, App Functionality only
- **Data NOT used to track you across other apps/sites**: confirm checked
- **No advertising identifiers, no third-party SDKs that track**

(`docs/APP_STORE_PRIVACY.md` has the pre-written nutrition label — copy that into App Store Connect's privacy questionnaire.)

### App Review Information

- **Sign-in required for review?**: No — anonymous PWA with demo data
- **Notes for reviewer**: "This app is local-first. No user account required. Reviewers can tap Settings → Load demo data to see every feature populated. The optional bank-sync feature uses Plaid; reviewers can skip it. The AI counselor (Cornileus) uses Anthropic via a Cloudflare Worker proxy — Anthropic's privacy policy: https://www.anthropic.com/legal/privacy"

---

## Phase 4: Build, upload, submit

In Xcode:

```
Product → Archive → wait ~2-3 minutes → Distribute App → App Store Connect → Upload
```

After upload (5-15 min processing):

In App Store Connect → your app → Version → Build → select the uploaded build → fill in remaining metadata → Submit for Review.

**Review time**: usually 24-48 hours. First submission sometimes takes 3-5 days.

**Common rejection reasons for finance apps**:
- Missing privacy policy URL (you have one at /privacy ✓)
- Missing support URL (you have one at /support ✓)
- Account-deletion requirement: the in-app "Reset everything" + the `/account` backend endpoint satisfy this ✓
- Plaid Link in WebView without disclosure: mentioned in reviewer notes ✓

---

## Phase 5: After launch

- **Crash reports**: Xcode → Window → Organizer → Crashes. Apple aggregates these from real devices.
- **App analytics**: App Store Connect → Analytics. Free.
- **Updates**: any code change → bump version in Xcode (Settings → Build Settings → Version) → re-archive → re-upload. Usually no re-review for bug-fix-only updates.

---

## What I've pre-committed for you

- `capacitor.config.json` at repo root with sensible defaults
- This doc (`docs/IOS_LAUNCH.md`)
- `screenshots/appstore/` directory placeholder
- Updated `docs/APP_STORE_PRIVACY.md` (existing file kept current with current data flows)

## What still requires a Mac

- `npx cap add ios` and everything after (Capacitor's iOS bootstrap)
- Opening / editing `ios/App.xcworkspace` in Xcode
- Code-signing
- Archive + upload

If you don't have a Mac, [MacInCloud](https://www.macincloud.com) rents one for ~$30/month — enough for one submission cycle.
