# iOS / App Store Build Guide

This document walks through turning the Life Hack PWA into a native iOS
app, submitting it to TestFlight, and shipping to the App Store. **A Mac
is required** (Capacitor's iOS pipeline relies on Xcode, which only
runs on macOS).

> **Estimated time on first run:** 4–6 hours of focused work, plus a
> 1–2 week review window before the App Store approves the first
> submission. Subsequent builds take ~15 minutes.

---

## Prerequisites

- **macOS 14+** (Sonoma or newer)
- **Xcode 15+** (from the Mac App Store, free, ~10 GB download)
- **Node.js 20+** (from nodejs.org or via `brew install node`)
- **Apple Developer Program enrollment** — $99 USD/year, sign up at
  https://developer.apple.com/programs/enroll/. Requires ID
  verification; takes 1–2 business days to activate.
- **App Store Connect access** (included with Developer Program)
- **A bundle identifier** — currently `app.lifehack.ios`. Register this
  identifier under your Apple Developer account at
  https://developer.apple.com/account/resources/identifiers/list

---

## One-time setup (do this once on the Mac)

```sh
# From the project root
npm install --save-dev @capacitor/core @capacitor/cli @capacitor/ios

# Initialize the iOS platform (creates the `ios/` directory)
npx cap add ios

# Sync the web assets into the native shell
npx cap sync ios

# Open the project in Xcode
npx cap open ios
```

After `cap add ios`:

1. In Xcode, open **App > General**:
   - **Display Name**: Life Hack
   - **Bundle Identifier**: app.lifehack.ios
   - **Version**: 1.0.0
   - **Build**: 1
   - **Deployment Target**: iOS 16.0 (covers ~95% of devices)
   - **Device Orientation**: iPhone — Portrait only

2. In Xcode, open **App > Signing & Capabilities**:
   - **Team**: select your Apple Developer team
   - Xcode will auto-create a provisioning profile

3. Replace the placeholder app icons in
   `ios/App/App/Assets.xcassets/AppIcon.appiconset/` with the real
   1024×1024 (App Store) icon + sized variants. The PNGs in this repo
   root (icon-180, icon-192, icon-512) can be used as sources; you'll
   need to generate the full set with a tool like
   https://appicon.co or `npx @capacitor/assets generate`.

---

## Each subsequent build

```sh
# After any change to index.html, manifest.json, sw.js, etc:
npx cap sync ios          # copy updated web assets into the iOS shell
npx cap open ios          # open Xcode

# In Xcode:
# Product > Archive   (builds a release .ipa)
# Window > Organizer  (upload to App Store Connect)
```

---

## Submission checklist

Before clicking "Submit for Review" in App Store Connect:

### Code & build
- [ ] App icon set is complete (every required size in `AppIcon.appiconset`)
- [ ] Launch screen storyboard renders the Life Hack splash
- [ ] Build runs cleanly on a real iOS device (TestFlight first)
- [ ] No NSLog/console.log of sensitive data in release builds
- [ ] App version + build number bumped from previous submission

### App Store Connect metadata
- [ ] App name (≤ 30 chars): **"Life Hack"** (verify availability)
- [ ] Subtitle (≤ 30 chars): see APP_STORE_LISTING.md
- [ ] Promotional text (≤ 170 chars): see APP_STORE_LISTING.md
- [ ] Description: see APP_STORE_LISTING.md
- [ ] Keywords (≤ 100 chars total)
- [ ] Support URL: https://github.com/codydickinson-debug/Life-Hack-App/issues
  (or a dedicated support page once registered)
- [ ] Marketing URL (optional but recommended)
- [ ] Privacy Policy URL: must be publicly hosted PRIVACY.md
  (GitHub Pages or Vercel-deployed `/privacy.html` works)
- [ ] Screenshots:
  - 6.7" iPhone (iPhone 15 Pro Max, 1290×2796): 3–10 required
  - 6.5" iPhone (1242×2688 or 1284×2778): 3–10 required
  - 5.5" iPhone (1242×2208): optional but recommended for older devices
- [ ] App preview video (optional, 15–30s) — high impact for conversion
- [ ] Age rating: **4+** (no objectionable content, but reviewer will
      ask about financial info — see below)
- [ ] Category: Primary = **Finance**, Secondary = **Productivity**
- [ ] Pricing: **Free** (no In-App Purchases for v1)

### Privacy
- [ ] **Privacy Nutrition Label** completed in App Store Connect (see
  the "Data Types" section below for what to declare)
- [ ] **App Tracking Transparency**: declare **Does Not Track**
- [ ] PRIVACY.md and TERMS.md publicly hosted and linked

### Compliance & legal
- [ ] **Export Compliance**: the app uses standard browser crypto
  (Web Crypto API for AES-GCM + PBKDF2). Declare:
  - "Does your app use encryption?" → Yes
  - "Does it qualify for exemption?" → Yes (uses standard crypto
    accessible via OS-provided libraries; falls under
    Note 4 of category 5A002 exception)
- [ ] **Content Rights**: confirm no third-party content needs licensing
- [ ] **Advertising Identifier**: app does NOT use IDFA

### Demo account / testing
- [ ] If the reviewer requires a way to test bank-linking: the app's
      Settings → "Load demo data" already populates Plaid-style fake
      data, so reviewers don't need real bank credentials. Mention
      this in App Review Notes.
- [ ] Provide step-by-step instructions in the App Review Notes field
      so the reviewer doesn't get stuck on first-launch onboarding

---

## Apple's Privacy Nutrition Label

For App Store Connect's "App Privacy" section, declare these data
types based on what Life Hack actually collects:

### Data Linked to You
**None.** The App does not link any collected data to your identity.

### Data Not Linked to You
- **Identifiers > User ID**: We generate a random `userId` on your
  device. Used for: App Functionality (authenticating your device to
  the optional backend). Not linked to your real identity, not used
  for tracking.
- **Financial Info > Other Financial Info**: If you connect a bank
  via Plaid, transaction data is fetched. Used for: App Functionality
  (showing your transactions). Stored on your device. Not used for
  tracking.
- **Usage Data > Product Interaction**: The optional backend keeps a
  short audit log (last 200 events: timestamps, endpoints) per device
  for debugging and abuse detection. Used for: App Functionality and
  Analytics.

### Data Used to Track You
**None.** The App does not track users across other companies' apps
or websites.

---

## App Review red-flag items to address proactively

In the "App Review Information > Notes" field, write something like:

> Life Hack is a personal-finance and habit-tracking app. All sensitive
> data is stored locally on the user's device, optionally encrypted with
> AES-GCM-256 using a user-chosen passphrase.
>
> To test full functionality without a real bank account, please use
> **Settings → "Load demo data"**, which populates the app with
> realistic transactions, accounts, and goals using Plaid sandbox data.
>
> Optional integrations:
> - **Plaid** (https://plaid.com) for bank-account linking. Plaid Link
>   handles credential entry directly; we never see bank logins.
> - **Anthropic Claude** for AI insights, proxied through a Cloudflare
>   Worker so the API key never enters the client.
>
> Both integrations are clearly disclosed in PRIVACY.md (linked from
> the app's Settings).
>
> The app is NOT a registered investment advisor, broker-dealer, or
> financial planner — all in-app content is educational. This is
> disclosed in Settings > About and reinforced in our Terms.

This pre-empts the questions reviewers ask 90% of the time for finance
apps.

---

## Resources

- Capacitor docs: https://capacitorjs.com/docs/ios
- App Store Connect: https://appstoreconnect.apple.com/
- Apple Developer Program: https://developer.apple.com/programs/
- Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines/
- App Store Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- App Privacy Details: https://developer.apple.com/app-store/app-privacy-details/
