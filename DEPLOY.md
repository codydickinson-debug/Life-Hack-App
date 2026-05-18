# Deploy Guide — Ascend with Plaid bank sync

This is a step-by-step from zero. You'll set up two free accounts (Plaid + Cloudflare), deploy a tiny backend, and point the iPhone PWA at it. Total time: 30–45 min the first time.

If you have **Claude Code**, you can paste any of these steps to it and it'll run them in your terminal — see the "Doing this with Claude Code" notes inline.

---

## 🚀 OPERATOR PATH — Hosting Ascend so anyone can use it (no per-user setup)

> If you're shipping Ascend as a product and want anyone who opens the PWA to get bank sync **without configuring anything**, this is the path. You deploy one Worker for everyone. Per-device enrollment isolates users from each other in KV — each gets their own userId + clientSecret + encrypted Plaid tokens. You pay Plaid ($0.30/connected item/mo after the free 100) and Cloudflare (effectively free for personal-app scale).

**Do steps 1–8 of the regular guide below** (sign up for Plaid + Cloudflare, install wrangler, create KV namespace, generate keys, set secrets, `wrangler deploy`).

**Then do this once** — bake the hosted backend into the public JS so users get it zero-config:

1. Open `index.html` and find:
   ```js
   const DEFAULT_BACKEND_URL = "";
   const DEFAULT_ENROLLMENT_KEY = "";
   ```
   (Search for `DEFAULT_BACKEND_URL`.)
2. Paste in your deployed values:
   ```js
   const DEFAULT_BACKEND_URL = "https://ascend-backend.YOUR-SUBDOMAIN.workers.dev";
   const DEFAULT_ENROLLMENT_KEY = "PASTE-THE-ENROLLMENT-KEY-FROM-STEP-6";
   ```
3. Re-deploy the PWA (Vercel auto-deploys on push to `main`).

That's it. Every user who installs the PWA from your URL gets bank sync as a first-class feature, no setup. The Settings page hides the manual Backend URL / Enrollment Key rows automatically when these defaults are set. Power users can still self-host by flipping Settings → "Use a custom backend" to ON.

**Security model for this path:**
- The enrollment key now ships in publicly-served JS — that's expected. The security boundary is (a) per-device enrollment (each user's KV namespace is keyed to their own userId; one user can't read another's tokens) and (b) the per-IP rate limit on `/enroll` (5/hour, 25/day) which we ship to bound mass-enrollment abuse.
- Plaid access tokens are still AES-GCM encrypted with your worker's `ENCRYPTION_KEY` before hitting KV. A KV breach still yields useless ciphertext.
- You can rotate `ENROLLMENT_KEY` anytime: `wrangler secret put ENROLLMENT_KEY` with a new value, then update `DEFAULT_ENROLLMENT_KEY` in `index.html`, then redeploy. Existing devices are unaffected — they already have their per-device clientSecret.
- Disclose the hosted-backend architecture in your privacy policy (the shipped `privacy.html` already does).

---

## 🔧 SELF-HOST PATH — Run your own backend (no operator dependency)

This is the original guide below. For users who want their Plaid tokens on infrastructure they fully control, or for the operator's own first-time setup.

---

## What you're building

```
[ Your iPhone ]                     [ Cloudflare Worker (yours) ]                [ Plaid ]
   Ascend PWA  ── HTTPS ────────►   /link/token /exchange /sync   ── HTTPS ──►  Banks
                                         │
                                         ▼
                                    Cloudflare KV
                                  (encrypted tokens
                                   + per-user state)
```

Cost: $0/month for personal use. Plaid Dev tier free for 100 connected items, Cloudflare Workers free for 100k req/day, KV free for 1GB.

---

## Step 1 — Sign up for Plaid (5 min)

1. Go to **https://dashboard.plaid.com/signup**
2. Sign up with your email (no card needed).
3. Confirm the email Plaid sends you.
4. You'll land in the dashboard. Pick **United States** as the country and skip any "what are you building" prompts (you can fill them later — defaults are fine for dev).
5. Go to **Team Settings → Keys** in the left nav (or `https://dashboard.plaid.com/developers/keys`).
6. Plaid (as of late 2024) ships new accounts with two environments:
   - **Sandbox**: fake banks for testing — use this for the first run-through. The Sandbox secret is visible immediately on signup.
   - **Production**: real banks. Gated behind a one-time security questionnaire — click "Apply for Production access" or "Request Production access" in the dashboard. Approval is usually same-day for personal-finance apps. Once approved, a Production secret appears in the dashboard. Free up to 100 connected items.
   (Plaid used to have a "Development" middle tier; it's been retired for new accounts. You go straight from Sandbox to Production.)
7. Copy these two values into a safe note:
   - `client_id`
   - `Sandbox secret` (you'll start here)
   - Later, `Production secret` once Plaid approves your application

> **Tip**: Always use Sandbox first. Connect a fake bank (First Platypus, Tartan Bank, etc.) with credentials `user_good` / `pass_good`, see your transactions populate, confirm everything works. Then swap the secret to Production once Plaid approves real-bank access.

---

## Step 2 — Sign up for Cloudflare (5 min)

1. Go to **https://dash.cloudflare.com/sign-up**
2. Sign up with email + password. Free tier — no card.
3. Confirm the email they send you.
4. Once in, you can ignore the "Add your domain" prompt — we don't need it.

That's it. Workers and KV are accessible from this account.

---

## Step 3 — Install Wrangler CLI (one-time, 5 min)

Wrangler is Cloudflare's command-line tool to deploy Workers. You'll run it from a terminal on your computer.

```bash
# Need Node.js installed first. Check:
node --version
# If you don't have it, install from https://nodejs.org (LTS version)

# Then:
npm install -g wrangler

# Verify:
wrangler --version
```

**Doing this with Claude Code:** open a terminal in the `goals app/backend/` folder and tell Claude Code: *"Install Node if needed, then install wrangler CLI."* It'll handle the install and verify.

---

## Step 4 — Log Wrangler into your Cloudflare account

```bash
cd "C:\Users\dblak\Documents\Claude\Projects\goals app\backend"
wrangler login
```

This opens a browser window. Approve. Done.

---

## Step 5 — Create the KV namespace (where your data lives)

```bash
wrangler kv namespace create ASCEND_KV
```

It'll print something like:
```
[[kv_namespaces]]
binding = "ASCEND_KV"
id = "abc123def456..."
```

Copy that **id** value. Open `wrangler.toml` in this folder and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with it.

**Claude Code:** *"Run `wrangler kv namespace create ASCEND_KV` and update wrangler.toml with the returned ID."*

---

## Step 6 — Generate your encryption key + enrollment key

The **encryption key** wraps Plaid access tokens before they go into KV.

The **enrollment key** is a one-time-use shared secret. The first time each device opens the app and configures the backend, it sends this key to register itself. The Worker generates a per-device record; from that point on the device authenticates with its own random secret, not the enrollment key. (Older versions called this `API_KEY` — that name still works for back-compat.)

```bash
# Generate the encryption key (32-byte random, base64)
openssl rand -base64 32
# copy this output — call it ENCRYPTION_KEY

# Generate an enrollment key (any random string, 32+ chars)
openssl rand -hex 32
# copy this output — call it ENROLLMENT_KEY
```

Save both somewhere safe (a password manager works). You'll paste the enrollment key into the iPhone app **once**.

**On Windows without openssl:** use PowerShell:
```powershell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

### Optional — Anthropic API key (for AI insights)

If you want the in-app "Run insight now" feature to work, generate a Claude API key at **https://console.anthropic.com/settings/keys** (set a low monthly spend limit while you're there). You'll set this as a Worker secret in Step 7. The key never reaches the browser.

---

## Step 7 — Set the secrets on the Worker

You'll run six commands, one per secret. Each one prompts you to paste the value (it won't echo what you type — that's normal).

```bash
wrangler secret put PLAID_CLIENT_ID
# paste your Plaid client_id

wrangler secret put PLAID_SECRET
# paste your Plaid Sandbox secret (or Production later)

wrangler secret put PLAID_ENV
# type: sandbox    (or "production" later, once Plaid approves real-bank access)

wrangler secret put ENROLLMENT_KEY
# paste the ENROLLMENT_KEY you generated in Step 6
# (Older docs called this API_KEY — both names still work as the secret name.)

wrangler secret put ENCRYPTION_KEY
# paste the ENCRYPTION_KEY you generated in Step 6

wrangler secret put ALLOWED_ORIGIN
# paste your deployed PWA URL, e.g. https://ascend-yourname.netlify.app
# Use a real origin in production — "*" disables the Origin enforcement check.

# Optional — only if you want AI insights:
wrangler secret put ANTHROPIC_KEY
# paste your sk-ant-... key from console.anthropic.com

# Optional — daily per-user cap on AI calls (default 50)
wrangler secret put ANTHROPIC_DAILY_CAP
# type: 30        (or whatever you want)
```

**Claude Code:** *"Set up the wrangler secrets — prompt me for each one and paste my values."*

---

## Step 8 — Deploy the Worker

```bash
wrangler deploy
```

It prints a URL, something like:
```
https://ascend-backend.YOUR-SUBDOMAIN.workers.dev
```

Copy this URL. Test it:
```bash
curl https://ascend-backend.YOUR-SUBDOMAIN.workers.dev/health
# Should return: {"ok":true,"service":"ascend-backend"}
```

If you got `{"ok":true,...}`, the backend is live. 🎉

---

## Step 9 — Deploy the PWA (iPhone-installable)

If you already deployed it earlier, skip to Step 10. Otherwise:

**Easiest:** drag the `goals app` folder (the parent of `backend/`) onto **https://app.netlify.com/drop**. You get a `*.netlify.app` URL.

Now go back and update the `ALLOWED_ORIGIN` secret on the Worker to match the Netlify URL — re-run `wrangler secret put ALLOWED_ORIGIN` with the new value, then `wrangler deploy` again.

---

## Step 10 — Configure the app on your iPhone

1. Open the deployed PWA URL in **Safari** on your iPhone.
2. Share button → Add to Home Screen → Add. Tap the icon to launch it.
3. Tap the gear icon (top-right) → scroll to **Bank sync (Plaid)**.
4. Paste in:
   - **Backend URL**: your `https://ascend-backend.....workers.dev` from Step 8
   - **Enrollment Key**: the `ENROLLMENT_KEY` value from Step 6 (the same one you set as a worker secret). The first backend call this device makes will use it once to enroll, then switch to a per-device secret automatically. After enrollment the field shows ✓ and the key is no longer used.
5. Toggle **Auto-sync on open** if you want.
6. Tap **Connect a bank**.
7. Plaid Link opens. Pick a bank.
   - In **Sandbox**: any of the listed banks. Use username `user_good`, password `pass_good` (Plaid's test creds).
   - In **Production**: log in with your real bank credentials. Plaid handles the OAuth — your password goes straight to your bank, never to Ascend or the backend.
8. After auth, Plaid closes. Toast says "Synced X transactions". Go to **Money → Spend** to see them.

---

## Step 11 — Set the encryption passphrase (recommended)

In the app: **Settings → Privacy & encryption → Set a passphrase**.

This wraps your local data with AES-GCM. After enabling, every cold open of the app prompts for the passphrase. **There is no recovery — if you forget it, your local data is wiped.** Pick something memorable, store it in your password manager.

(Plaid access tokens in the Worker are *also* encrypted, with a separate server-side key. Two layers, different blast radius.)

---

## Switching from Sandbox → Production (real banks)

Once you've confirmed the flow works with fake banks AND Plaid has approved your Production access (you'll see a Production row appear in the dashboard):

1. In Plaid dashboard, reveal + copy your **Production** secret.
2. Run:
   ```bash
   wrangler secret put PLAID_SECRET
   # paste Production secret
   wrangler secret put PLAID_ENV
   # type: production
   wrangler deploy
   ```
3. In the app: **Settings → Bank sync** → disconnect any sandbox bank connections (their access tokens are environment-specific and won't work after the swap).
4. Tap **Connect a bank** again. This time use real bank credentials — Plaid's OAuth flow handles them, your password never reaches us.

> Plaid retired the "Development" middle tier. Sandbox and Production are the only two environments for new accounts; the Production application is gated behind a one-time security questionnaire (~5 min, usually approved same-day for personal apps).

---

## Day-to-day use

- Open the app — auto-syncs new transactions.
- See balances + recent activity in **Money → Spend**.
- Tap **Sync transactions now** in Settings if you want to force a refresh.
- Disconnect a bank: **Settings → Connected institutions → ×**.

---

## Troubleshooting

**"unauthorized" error in app**: either the Enrollment Key in app settings doesn't match the Worker's `ENROLLMENT_KEY` (or `API_KEY` legacy name), or this device's per-device secret was rejected (e.g., you wiped KV). The app will silently re-enroll on the next call — if it doesn't, paste the enrollment key again. Leading/trailing spaces will break it.

**"daily AI limit reached"**: the per-user daily cap on AI insights was hit. Default is 50/day. Override with `wrangler secret put ANTHROPIC_DAILY_CAP` and redeploy.

**"AI insights not configured"**: the `ANTHROPIC_KEY` Worker secret isn't set. Run `wrangler secret put ANTHROPIC_KEY` and redeploy.

**"Plaid /link/token/create failed"**: usually missing PLAID_CLIENT_ID or wrong PLAID_ENV. Check `wrangler secret list`.

**Transactions don't appear**: Plaid's sandbox sometimes returns empty transactions for new test accounts. Use Plaid's [Sandbox Override](https://plaid.com/docs/sandbox/test-credentials/) to seed transactions, or switch to Production with a real bank once Plaid approves your access.

**App freezes on the lock screen**: type your passphrase. If you forgot it, tap "Reset and start over" — wipes the encrypted blob, app comes back empty.

**Worker logs**: `wrangler tail` streams live logs from the deployed Worker. Useful for debugging.

---

## Security recap

- **Bank password**: never touches your Worker. Plaid's UI handles it; for major banks it's full OAuth (your password is only ever entered on the bank's website).
- **Plaid access token**: stored AES-GCM encrypted with `ENCRYPTION_KEY` in Cloudflare KV. Useless without the key.
- **Local data on phone**: encrypted with your passphrase. AES-GCM, key derived via PBKDF2 (250k iterations).
- **Per-device backend auth**: each device has its own random 32-byte secret enrolled with the Worker. SHA-256 of the secret is stored in KV; the secret itself never leaves the device. A leaked secret only impersonates one device, not the whole account.
- **Anthropic key**: lives only as a Worker secret (`ANTHROPIC_KEY`). The browser sends prompts to your Worker, which forwards to Anthropic — the key never touches the device. Per-user daily cap (default 50 calls/day) protects against runaway spend if a per-device secret leaks.
- **CORS / Origin**: set `ALLOWED_ORIGIN` to your real PWA URL — the Worker rejects browser requests from any other origin.
- **In transit**: HTTPS everywhere — Cloudflare ↔ phone, Cloudflare ↔ Plaid, Cloudflare ↔ Anthropic.
- **2FA**: turn it on for Plaid, Cloudflare, and Anthropic accounts. Takes 60 seconds each, biggest single security win.
- **Worst case if Cloudflare is breached**: attacker gets encrypted tokens (need ENCRYPTION_KEY) + per-user secret hashes (one-way) + encrypted local-state blob (need passphrase). Money is never at risk because Plaid tokens are read-only.
- **Audit log**: each privileged endpoint writes to `u:<userId>:audit` (last 200 events). Reachable via `GET /audit` from the device.

---

## What's next

- **Subscriptions detection**: the data is in `DB.spend` — we can scan for monthly recurring merchants.
- **Custom categories**: rule-based ("starts with STARBUCKS" → "Coffee") on top of Plaid's auto-categorization.
- **Net worth chart**: aggregate balances over time.
- **Goal-based saving**: auto-allocate a % of paycheck deposits to savings goals.
- **Bill-due reminders**: detect recurring outflows, notify before next predicted date.

Tell me which of these you want and I'll wire them up.
