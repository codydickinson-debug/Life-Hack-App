# Security Policy

## Reporting a vulnerability

If you've found something, please report it privately first.

**Preferred:** [Open a private security advisory](https://github.com/codydickinson-debug/Life-Hack-App/security/advisories/new) on GitHub. This stays private until we've had a chance to respond.

**Fallback:** Open a regular issue prefixed with `[security]` and mention you'd like to coordinate disclosure. We'll move the conversation private.

## What's in scope

- The web app at https://life-hack-app.vercel.app
- The Python backend (`api/index.py` + `stockanalyzer/`)
- The optional Cloudflare Worker (`backend/worker.js`) if reachable from a deployed install

## What's out of scope

- **Self-XSS** via paste-into-console / DevTools manipulation. The app's threat model assumes the user controls their own browser.
- **Bugs in third-party services we proxy** (Plaid, Anthropic, Yahoo Finance). Report those upstream.
- **Rate limiting** tighter than what's documented. The per-user daily AI cap (default 50) is intentional, not a defect.
- **localStorage being readable by browser extensions / device-access** — the app already warns users in Settings that local storage is plaintext unless they set a passphrase.

## Response expectations

- We'll acknowledge within 7 days.
- For confirmed issues, we aim to ship a fix within 30 days for medium severity, 7 days for high.
- We'll credit reporters in the commit message and release notes unless you'd rather stay anonymous.

## Known design choices that might look suspicious

These are intentional, not bugs — please don't report them as such:

| Behavior | Why |
|---|---|
| Inline `<script>` and `style=` everywhere | Single-file PWA, no build step. CSP is set to `'unsafe-inline'` accordingly. |
| Forgotten passphrase = data loss | Zero-knowledge by design. There's no recovery key on the server because there's no server account. |
| The `?` keyboard shortcut works on the body | Power-user shortcut. Ignored when focus is in an input. |
| The Anthropic API key isn't in the client bundle | Correct — it lives only on the backend AI proxy. |
| `connect-src` allows arbitrary `https:` | Users configure their own optional Cloudflare Worker URL; we can't whitelist it statically. |

## Coordinated disclosure

If your finding is non-trivial, we'd appreciate ~60 days before public disclosure. We'll work with you on a timeline.

## Recent hardening (v3.8 — 2026-05-17)

Cross-stack audit + fix pass. Highlights:

- **Worker**: Anthropic upstream responses are field-whitelisted before forwarding (no leaked Anthropic error metadata / model ids). Plaid webhooks now verify item ownership against a reverse `item-owner:<itemId>` index. `decryptString` rejects malformed packed ciphertext. `handleSync` has a 40-call per-invocation budget with `truncated:true` continuation. Push payload `url` field is path-allowlisted (defends against destructive deep links via a crafted push).
- **Frontend**: `_decodePairingToken` + Cornileus action JSON parsing routed through `safeJsonParse` (proto-pollution defense). Encryption-lockout brute-force counter mirrors to sessionStorage so a `QuotaExceededError` doesn't reset the rate limit.
- **Python**: every yfinance-routed path parameter validated by strict regex (`^[A-Z0-9.\-^=]{1,10}$`) — SSRF/path-traversal defense. RSS image URLs require HTTPS + an allowlisted news-CDN host (defeats third-party-tracker amplification via a compromised feed). `defusedxml` replaces stdlib ElementTree for RSS parsing.
- **Service worker**: `notificationclick` path-allowlists nav targets the same way the worker does.
- **Vercel headers**: HSTS preload, Cross-Origin-Opener-Policy, Cross-Origin-Resource-Policy. Per-route edge cache on the actually-cacheable Python endpoints.

Full per-commit detail in `RELEASES.md`.

Thanks for keeping Ascend safer.
