# Privacy Policy

**Effective date:** May 13, 2026
**Last updated:** May 13, 2026

This Privacy Policy explains how the **Life Hack** app (the "App") handles
your information. We've written it to be readable, not legally evasive. If
anything is unclear, contact us at the email at the bottom.

> **TL;DR.** The App is built to keep your financial data on your phone.
> We don't sell your data, we don't show ads, we don't track you across
> apps or websites, and we don't have a server-side database of users.
> The only times anything leaves your device are: (1) if you opt in to
> connect a bank, your bank credentials go directly to Plaid (we never
> see them), and (2) if you tap "AI insights," a summary of your data is
> sent to Anthropic through a Cloudflare Worker the App's operator runs.

---

## 1. Who runs this App

The Life Hack app is operated by the developer(s) of the
**codydickinson-debug/Life-Hack-App** open-source project. Contact information
is at the bottom of this policy.

## 2. What information the App handles, and where it goes

### Stored only on your device

Almost everything you enter into the App stays in your browser's
**localStorage** on the device you're using. This includes, but isn't
limited to:

- Your name (if you provide one) and onboarding answers
- Your habits, goals, savings goals, wins, reflections, and notes
- Your manually-entered income, expenses, recurring bills, assets, and
  debts
- Your settings and preferences (theme, privacy mode, auto-lock, etc.)
- A locally-generated `userId` that identifies your device to the
  optional backend (described below). This `userId` is **not** linked to
  your name, email, phone number, or any identifier we can tie back to
  you outside the App.
- If you set a passphrase, all of the above is **encrypted at rest** in
  localStorage using AES-GCM-256 with a key derived from your passphrase
  (PBKDF2-SHA256, 600,000 iterations). We do not have a copy of your
  passphrase or your decryption key. If you lose your passphrase, your
  data is unrecoverable by anyone, including us.

This local data is **never sent to us, our servers, or any third party**
except as described below.

### Sent to Plaid (only if you choose to connect a bank)

The App optionally integrates with **Plaid Inc.** (https://plaid.com) so
you can link a bank account and have transactions auto-imported. If you
use this feature:

- Your bank login credentials go **directly to Plaid through Plaid Link**.
  They never touch our servers or our code.
- Plaid returns an "access token" representing your authorization. This
  token is held by the App's backend Cloudflare Worker (described below)
  and is encrypted at rest with a separate server-side key.
- Plaid sends back transactions, balances, holdings, and account
  metadata. These are stored on your device with the rest of your data.

Plaid's own privacy practices and data retention are governed by Plaid's
privacy policy: https://plaid.com/legal/

If you disconnect a bank from the App, the access token is destroyed on
the backend and Plaid is told to revoke access.

### Sent through the backend Cloudflare Worker (only if configured)

The App can be used **without any backend** — purely as a local-only
tracker, with no network requests except optional updates of the App's
own static files. If you (or whoever set up the App for you) configured
the optional backend Worker, the following endpoints can be called:

- `/enroll` — once per device, to register a per-device secret
- `/link-token`, `/exchange`, `/sync`, `/items`, `/remove`, `/holdings` —
  Plaid bank-data flow
- `/anthropic/messages` — proxies your "AI insights" request to Anthropic
  (described in the next section)

The Worker stores:

- A SHA-256 hash of your device's secret (so future calls can be
  authenticated; we cannot recover the secret from this hash)
- Your Plaid access tokens, AES-GCM encrypted with a server-side key
- A short audit log (last 200 events: timestamps, endpoint, status) per
  device — used for debugging and abuse detection. No transaction data,
  no balances, no personal identifiers.
- A daily counter of your AI insight requests, used to enforce a per-day
  cap on AI calls

The Worker has **no user database** in the traditional sense. Your
"account" is a randomly generated `userId` string that you generate on
your device. There is no email, no phone, no password, no account
recovery.

### Sent to Anthropic (only when you tap "AI insights")

If you use the AI Insights feature, a snapshot of your recent data
(typically: monthly spending by category, top merchants, active
subscriptions, savings goals, open goals) is sent through the backend
Worker to **Anthropic** (the maker of the Claude AI model). The Worker
attaches its own Anthropic API key — your data is **not** sent to
Anthropic from your browser directly, and your Anthropic API key (if any)
is not used or stored.

Anthropic's data-handling practices are governed by Anthropic's
commercial terms: https://www.anthropic.com/legal/commercial-terms

We do not store the AI response on any server. The response is sent back
to your device and saved to your local data only.

### Sent to the Python backend (Stock Analyzer)

The App's "Stocks / Housing / Mortgages / News" tab calls a Python
backend deployed on Vercel. This backend queries **public market and
news data sources** (e.g., Yahoo Finance, Federal Reserve Economic Data,
Realtor.com). Your queries (a stock ticker, a ZIP code) are sent to
those upstream services to fetch the data you asked for. We do not
log your queries except for short-term debugging.

## 3. What we DON'T do

To be explicit, the App and its operator do **not** do any of the
following:

- We do not display advertisements.
- We do not sell, rent, or share your data with advertisers, data
  brokers, or marketing partners.
- We do not use third-party advertising SDKs.
- We do not use analytics SDKs that track you across apps or websites
  (no Google Analytics, no Facebook Pixel, no Segment, no Mixpanel).
- We do not request location, contacts, photos, microphone, or camera
  access.
- We do not run cross-app or cross-site tracking.
- We do not collect device identifiers other than the random `userId`
  you generate locally.

Per Apple's App Tracking Transparency (ATT): **we do not track you** as
defined in Apple's framework.

## 4. Children

The App is not directed at children under 13 (U.S. COPPA) or 16 (EU
GDPR). We do not knowingly collect data from anyone under those ages.
If you believe a minor has been using the App with sensitive financial
data, contact us and we will delete any associated server-side data.

## 5. Your rights

### Local data
Because your data lives on your device, you have full control:

- **View / export**: Settings → Backup / Export. You can download a
  copy of all your local data at any time, in plaintext JSON or as an
  encrypted backup file.
- **Delete**: Settings → Reset everything. This deletes all local data
  and any cached backups on the device.
- **Move between devices**: export from one, import on the other.

### Server-side data (only if you used the optional backend)

You can request deletion of your backend records by contacting us with
your `userId` (visible in the App at Settings → Backend → Account ID, or
similar). On request, we will:

- Delete the auth hash for your device
- Delete your encrypted Plaid access tokens (and call Plaid to revoke
  them)
- Delete your audit log
- Delete your daily AI counter

Deletion is permanent. We retain no backups of server-side records
beyond standard infrastructure log retention.

### GDPR / CCPA-equivalent rights

For users in the EU/UK or California:

- **Right to access**: ask us for a copy of any data the backend holds
  about your `userId`. We will respond within 30 days.
- **Right to deletion**: see above.
- **Right to portability**: your local data export is your portable copy.
- **Right to object / restrict processing**: stop using the optional
  backend and your server-side records become unused; ask for deletion
  to make them gone.

We do not "sell" personal information under CCPA's definition. We do not
"share" personal information for cross-context behavioral advertising.

## 6. Security

- Optional client-side encryption (AES-GCM-256 with a passphrase-derived
  key, PBKDF2-SHA256 with 600,000 iterations)
- Server-side encryption of Plaid access tokens with a separate key
- Per-device authentication secrets (not a shared key) so a leaked
  device secret only impersonates one device
- Content Security Policy hardened to prevent script injection,
  clickjacking, and form exfiltration
- HTTPS required for all backend connections

No system is perfectly secure. If we become aware of a breach affecting
server-side data, we will notify affected users within 72 hours via the
contact method available to us, and publicly via the project repository.

## 7. Third-party services we may call on your behalf

- **Plaid Inc.** — bank account linking and transaction sync
- **Anthropic, PBC** — AI insights (Claude)
- **Cloudflare, Inc.** — hosting for the backend Worker
- **Vercel Inc.** — hosting for the App and the Stock Analyzer backend
- **Public market and news data providers** (e.g. Yahoo Finance,
  Federal Reserve Economic Data) — read-only queries for the Stocks tab

Each is governed by its own privacy policy.

## 8. Changes to this policy

We may update this policy. The "Last updated" date at the top reflects
the most recent change. Material changes will be highlighted in the App
or on the project repository.

## 9. Contact

For privacy questions, data access/deletion requests, or to report a
concern:

- **Email**: privacy@life-hack.app  *(once the domain is registered;
  until then, open an issue at the project repository)*
- **GitHub**: https://github.com/codydickinson-debug/Life-Hack-App/issues
