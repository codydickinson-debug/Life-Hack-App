# AI Proxy Setup — Vercel Environment Variables

All AI features (Financial Counselor chat, monthly insight, AI onboarding)
hit `/api/ai/messages`, implemented in `stockanalyzer/app.py`. That route
proxies the request to Anthropic so the API key never ships to the browser.

For AI to work in production, set these env vars in the **Vercel project
settings** (Project → Settings → Environment Variables):

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | **Yes** | — | Server-side Anthropic API key (`sk-ant-...`). Get one at https://console.anthropic.com/ |
| `ANTHROPIC_DAILY_CAP` | No | `50` | Per-IP per-day request cap. Soft cost guard. |
| `AI_MODEL_ALLOWLIST` | No | (any) | Comma-separated allowed model IDs. Example: `claude-haiku-4-5-20251001,claude-sonnet-4-6` |

After saving, **redeploy** for the env vars to take effect.

## Quick verify

After deploying, curl the proxy:

```sh
curl -X POST https://life-hack-app.vercel.app/api/ai/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-haiku-4-5-20251001",
    "max_tokens": 30,
    "messages": [{"role": "user", "content": "Say hello in 5 words."}]
  }'
```

A healthy response looks like:

```json
{
  "id": "msg_...",
  "type": "message",
  "role": "assistant",
  "content": [{"type": "text", "text": "Hello..."}]
}
```

There's also a no-key health endpoint:

```sh
curl https://life-hack-app.vercel.app/api/ai/health
# → {"configured": true, "daily_cap": 50, "allowlist_count": 0}
```

## Error responses

| Status | Body | Cause | Fix |
|---|---|---|---|
| 503 | `{"error": "AI is not configured on this deployment."}` | `ANTHROPIC_API_KEY` env var not set | Set it in Vercel project settings, redeploy |
| 400 | `{"error": "messages[] is required"}` | Bad request body | Frontend bug — file an issue |
| 401 | (Anthropic's error shape) | Invalid API key | Re-issue the key, update env var |
| 429 | `{"error": "Daily AI cap reached (N/M)..."}` | Hit the per-IP daily cap | Bump `ANTHROPIC_DAILY_CAP` or wait until tomorrow |
| 502 | `{"error": "Upstream Anthropic request failed: ..."}` | Network error reaching Anthropic | Usually transient — retry |

## Production hardening (later)

The current `/api/ai/messages` route has a per-IP soft cap but no per-user
auth. For App Store launch with paid users, add one of:

1. **Signed Vercel JWT** — frontend acquires a short-lived signed token
   from a `/api/auth` endpoint, sends it on every AI call.
2. **Per-device enrollment** (mirror the Cloudflare Worker pattern) —
   frontend enrolls a per-device secret with an `/api/enroll` endpoint;
   subsequent AI calls send it as a Bearer token.
3. **Cloudflare Turnstile** in front of the AI route for bot defense
   without account auth.

The cap-by-IP today catches casual abuse but won't stop a determined
attacker rotating IPs. Track usage on Anthropic's dashboard and watch
spend — cap there as a backstop.

## Why same-origin instead of Cloudflare Worker?

The Cloudflare Worker path (`backend/worker.js`) is still supported —
power users can configure their own Worker URL in Settings for full
privacy + custom rate limits. But for the App Store launch we wanted
AI to "just work" with zero per-user setup, so the default flow is the
same-origin Vercel proxy.

Frontend behavior: `aiApi()` calls `/api/ai/messages` first. If that
returns 503 ("not configured") AND the user has their own Worker URL,
it falls back to the Worker's `/anthropic/messages` endpoint.
