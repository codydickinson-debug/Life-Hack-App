# Plaid Production Application — Pre-Written Answers

This file is **internal**. It collects the copy you'll paste into Plaid's
production-access application + likely follow-up emails, so you can move
through the review without composing on the fly. None of this is deployed
as a public page.

Replace placeholders in `{{double braces}}` before pasting:
- `{{your_state}}` — the US state you legally reside in
- `{{user_count_estimate}}` — rough first-year user count
- `{{webhook_url}}` — your Cloudflare Worker webhook URL (see §6)

---

## 1. Use-case description (300 words)

> **Field on Plaid form:** "Describe your use case"

Ascend is a personal-finance and habit-tracking app (PWA) that gives
individuals one place to track their habits, goals, plans, savings,
spend, debts, and investments. Plaid integration is the connective
tissue: it replaces hours of manual transaction entry per month and
makes balances, payroll, debt APRs, and portfolio holdings live instead
of stale.

Specifically, Ascend uses Plaid's read-only flows to:

- **Transactions** — populate the user's spend timeline and category
  breakdown, detect anomalies, and surface "where is your money leaking"
  insights. Used in the Money tab.
- **Auth** — display the user's connected accounts and balances on the
  Net Worth and Money Health cards. We never call any money-movement
  endpoint; Auth is read-only here.
- **Identity** — match deposits to paychecks so the app can prompt the
  user to allocate the pay across their savings buckets (Money tab →
  pending paychecks).
- **Liabilities** — read credit-card APRs, student-loan balances, and
  mortgage details to power the debt payoff planner (Money tab → Plays
  → Debt).
- **Investments (Holdings + Investment Transactions)** — display the
  user's brokerage portfolio alongside the manually tracked holdings in
  the Stocks tab.

Ascend never initiates transfers, payments, or any write to the user's
bank. The app is read-only against Plaid. Bank credentials are entered
into Plaid Link and are never seen by Ascend's frontend or backend; we
only ever hold the encrypted Plaid access token in Cloudflare KV.

We expect approximately {{user_count_estimate}} users in the first
year, with the operator personally as an early test user.

---

## 2. Products requested

Check all of these on the Plaid application form:

- ✅ **Transactions**
- ✅ **Auth**
- ✅ **Identity**
- ✅ **Liabilities**
- ✅ **Investments** (both Holdings and Investment Transactions)

Do **not** check:

- ❌ Transfer (we never move money)
- ❌ Income (we use Identity + Transactions for paycheck detection,
  not Plaid's Income product)
- ❌ Assets (we don't generate Asset Reports)
- ❌ Signal (no payment risk-scoring)

---

## 3. Volume estimate

> **Field on Plaid form:** "Estimated linked items in first 12 months"

Conservative: {{user_count_estimate}} items. Each user typically links
1–3 accounts (a primary checking, optionally a credit card, optionally
a brokerage), so total linked items in year one ≈ 1.5× user count.

---

## 4. Required URLs

Paste these directly into the form fields:

| Field | Value |
| --- | --- |
| Application URL | `https://life-hack-app.vercel.app` |
| Privacy Policy URL | `https://life-hack-app.vercel.app/privacy` |
| Terms of Service URL | `https://life-hack-app.vercel.app/terms` |
| Security Overview URL | `https://life-hack-app.vercel.app/security` |
| Support contact email | `codydickinson@autopalsusa.com` |
| Webhook URL (for item updates) | `{{webhook_url}}` |

For the webhook URL: this is your Cloudflare Worker's webhook endpoint.
Confirm with `grep -nE "webhook" backend/worker.js | head` — it's the
route that handles Plaid item events. If the Worker is at
`https://ascend-backend.acend.workers.dev`, the webhook URL is likely
`https://ascend-backend.acend.workers.dev/plaid/webhook` (verify in
worker.js).

---

## 5. Pre-written answers to common Plaid follow-ups

Reviewers often email these. Answers are ready to paste verbatim.

### Q: How do you store Plaid access tokens?

> Access tokens are AES-GCM encrypted with a server-side key
> (`ENCRYPTION_KEY` — a Cloudflare Worker secret) before being written
> to Cloudflare KV. The KV record is keyed by a per-device user
> identifier. A KV breach would yield ciphertext that is useless
> without the encryption key, which is never written to source, logs,
> or any HTTP-accessible path. Detail in
> https://life-hack-app.vercel.app/security §1.2.

### Q: How do users authenticate to your backend?

> Per-device enrollment. On first use, the device calls `POST /enroll`
> with a shared enrollment key; the backend mints a per-device
> `clientSecret`, stores `SHA-256(clientSecret)` in KV, and returns
> the secret to the device. All subsequent requests carry the
> device's own `Authorization: Bearer <clientSecret>`. A leaked
> per-device secret only impersonates one device. Detail at
> https://life-hack-app.vercel.app/security §3.1.

### Q: Do you verify Plaid webhook signatures?

> Yes. Every Plaid webhook is verified against Plaid's published JWK
> set using ES256. The backend validates the JWT signature, confirms
> the body hash matches the signed claim, and enforces a 5-minute
> replay window. Unverified or replayed webhooks are rejected before
> any state mutation. Implementation lives in `backend/worker.js`
> (search for `verifyPlaidWebhook`).

### Q: What happens to user data on disconnect / account deletion?

> Disconnect: the encrypted access token is removed from KV within
> minutes; we call Plaid's `/item/remove` to revoke the underlying
> item upstream. Account deletion: all KV records keyed to the
> device's user ID are deleted; we also call Plaid `/item/remove` for
> every still-active item. Local device data is wiped via Settings →
> Reset everything. Detail at https://life-hack-app.vercel.app/privacy §2.1
> (Data retention paragraph) and §6 (Right to deletion).

### Q: Is bank sync read-only?

> Yes. Ascend never invokes any Plaid endpoint that would move money
> (no Transfer, no Payment Initiation, no Auth-write flows). All bank
> sync code paths are reads only: `/transactions/sync`,
> `/accounts/balance/get`, `/identity/get`, `/liabilities/get`,
> `/investments/holdings/get`, `/investments/transactions/get`.

### Q: Do you log any user financial data?

> No. Structured per-request access logs include route, status code,
> latency, hashed user ID (first 12 hex chars of `SHA-256(userId)`),
> and hashed IP. No transaction amounts, account numbers, account
> names, balances, or institution names are ever written to logs.
> Detail at https://life-hack-app.vercel.app/security §5.

### Q: Who has access to your production backend?

> Ascend is operated by a single individual (Cody Dickinson). The
> Cloudflare account that hosts the Worker is protected with 2FA. KV
> is only reachable from inside the Worker — there is no admin UI
> exposed to the public internet. Source code is public on GitHub; no
> production secrets exist in source.

### Q: What is your incident response process?

> See https://life-hack-app.vercel.app/security §9. Summary: disable
> affected code path or revoke affected credentials within hours of
> confirmation; notify affected users within 72 hours via in-app
> "What's new" and email where applicable; publish post-incident
> write-up in SECURITY.md; rotate all relevant secrets.

### Q: Are you SOC 2 / ISO 27001 / PCI-DSS certified?

> No. We're transparent about this on
> https://life-hack-app.vercel.app/security §10. The vendors that
> handle the highest-risk data (Plaid for bank credentials, Cloudflare
> for token storage, Anthropic for AI) carry their own SOC 2 Type II
> certifications, which transitively cover the riskiest parts of the
> stack. The operator runs the security mitigations described in the
> Security Overview but does not hold formal certifications.

### Q: What's your data retention policy?

> Encrypted access tokens are retained in Cloudflare KV for as long
> as the user has an active bank connection. On disconnect, the
> encrypted token is removed from KV within minutes and the upstream
> Plaid item is revoked. Devices with no activity for 12 consecutive
> months have their enrollment records auto-purged; the user can
> re-enroll at any time. Transaction data lives only on the user's
> device — clearing browser data, uninstalling, or "Reset everything"
> in Settings erases it locally with no server-side copy.

---

## 6. Webhook URL — verify before submitting

The form needs your live webhook URL. To confirm the route:

```bash
grep -nE "plaid/webhook|handlePlaidWebhook|/webhook" backend/worker.js | head
```

If the route is `/plaid/webhook`, your webhook URL is:
`https://ascend-backend.acend.workers.dev/plaid/webhook`

Test the route is reachable (it should accept POST and reject GET):

```bash
curl -i https://ascend-backend.acend.workers.dev/plaid/webhook
```

Expected: 405 Method Not Allowed or 401 Unauthorized (not 404).

---

## 7. After Plaid approves you

Once you have the production keys from the Plaid dashboard:

```bash
cd backend
npx wrangler secret put PLAID_CLIENT_ID    # paste production client_id
npx wrangler secret put PLAID_SECRET       # paste production secret
npx wrangler secret put PLAID_ENV          # type: production
npm run ship                                # deploys + smoke-tests
```

Smoke-test with a real bank by going through the same Connect-a-bank
flow you already know works in sandbox.

---

## 8. Things that may slow review

- **Domain split** — app on `life-hack-app.vercel.app`, backend on
  `acend.workers.dev`. If reviewers ask, explain: app is static-served
  on Vercel; backend is a Cloudflare Worker for low-cost, low-latency
  Plaid + token-encryption work. Both are operated by the same
  individual.
- **Open source** — code is public on GitHub
  (`codydickinson-debug/Life-Hack-App`). Plaid is fine with this in
  general; just be ready to explain that the production deployment is
  controlled by the operator named in the Privacy Policy, not by every
  GitHub contributor.
- **Single-operator** — Plaid sometimes asks for org-chart info. Be
  ready to say "individual operator; this is a personal-finance
  project I run". They don't reject for this; they just want to know
  who's accountable.

---

## 9. Optional next steps before submitting

- Name a specific governing-law state in `terms.html` §9 (currently
  generic).
- Confirm `codydickinson@autopalsusa.com` actively receives mail.
- Verify the webhook URL with the curl probe above.
- Consider registering a custom domain (`ascend.app` or similar) so
  the app + backend can share a brand. Not required for Plaid
  approval, but reduces reviewer questions about the domain split.
