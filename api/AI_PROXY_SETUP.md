# AI Proxy Setup — Vercel Environment Variables

The AI features (insights + AI onboarding) call `/api/ai/messages`, which
is implemented in `stockanalyzer/app.py`. That endpoint proxies to
Anthropic so the API key never ships to the browser.

For AI to work in production, set the following environment variables in
the **Vercel project settings** (Project → Settings → Environment
Variables):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | — | Server-side Anthropic API key (`sk-ant-...`). Get one at https://console.anthropic.com/ |
| `ANTHROPIC_DAILY_CAP` | No | `50` | Per-IP per-day request cap. Soft cost guard. |
| `AI_MODEL_ALLOWLIST` | No | (any) | Comma-separated list of allowed model strings. If set, clients can only request these models. Example: `claude-haiku-4-5-20251001,claude-sonnet-4-5-20250929` |

After saving, **redeploy** for the env vars to take effect.

## Quick verify

After deploying, you can test the proxy with curl:

```sh
curl -X POST https://life-hack-app.vercel.app/api/ai/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 30,
    "messages": [{"role": "user", "content": "Say hello in 5 words."}]
  }'
```

A successful response looks like:

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [{"type": "text", "text": "Hello..."}],
  ...
}
```

Common error responses:

| Status | Body | Cause | Fix |
|---|---|---|---|
| 503 | `{"error": "AI is not configured on this deployment."}` | `ANTHROPIC_API_KEY` env var not set | Set it in Vercel project settings, redeploy |
| 400 | `{"error": "messages[] is required"}` | Bad request body | Frontend bug — file an issue |
| 401 | (Anthropic's error shape) | Invalid API key | Re-issue the key, update env var |
| 429 | `{"error": "Daily AI cap reached (50/50)..."}` | Hit the per-IP daily cap | Bump `ANTHROPIC_DAILY_CAP` or wait until tomorrow |
| 502 | `{"error": "Upstream Anthropic request failed: ..."}` | Network error reaching Anthropic | Usually transient — retry |

## Production hardening (later)

The current `/api/ai/messages` implementation has a per-IP soft cap but
no per-user auth. For App Store launch with paid users, add one of:

1. **Signed Vercel JWT** — frontend acquires a short-lived signed token
   from a `/api/auth` endpoint, sends it on every AI call. Backend
   validates the JWT before calling Anthropic.
2. **Same-device secret** (mirror the Cloudflare Worker pattern) —
   frontend enrolls a per-device secret with an `/api/enroll` endpoint;
   subsequent AI calls send it as a Bearer token.
3. **Cloudflare Turnstile** in front of the AI route for bot defense
   without account auth.

The cap-by-IP today catches casual abuse but won't stop a determined
attacker rotating IPs. Track usage on Anthropic's dashboard and watch
spend — cap there as a backstop.
