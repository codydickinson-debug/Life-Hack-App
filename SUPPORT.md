# Support

Need help with **Life Hack**? Here's how to get it.

## Quick troubleshooting

### My data disappeared after closing the app
- Open the app again — local data is stored in your browser's storage,
  not in a server. Closing the tab does **not** delete it.
- If it really is gone, the app keeps a rolling backup. On next open it
  will show a "Recovered from backup" toast if it had to fall back.
- If you went into Settings → Reset everything and confirmed, that
  permanently erased the data. There is no recovery for that.

### I forgot my passphrase
- **There is no recovery.** Your data is encrypted with a key derived
  from your passphrase. We don't have a copy of the passphrase or the
  key. Lost passphrase = data is mathematically unrecoverable.
- Your only option is to reset and start over from the lock screen.

### Plaid won't connect / "Backend not configured"
- The Plaid integration requires a backend Cloudflare Worker to be set
  up. If you don't have one, you can still use the app fully — just log
  spending manually instead.
- If you do have a backend: Settings → Backend → make sure both the
  URL and the enrollment key are filled in. Check that the URL starts
  with `https://`.

### AI Insights say "AI insights now require the backend Worker"
- Same as above. The Anthropic API key now lives on the backend, not
  your phone. Without a backend URL configured, AI Insights are
  disabled. Manual logging and all calculators still work.

### Stocks tab says "StockAnalyzer lives on the server"
- You're viewing the app from a file:// URL (local file) instead of
  from the deployed version. The Stocks tab needs the Python backend
  running. Visit https://life-hack-app.vercel.app to use Stocks.

### The app feels slow / something looks broken
- Hard refresh the browser page (Ctrl+Shift+R on Windows / Cmd+Shift+R
  on Mac) to bypass cached files. If installed as a PWA, swipe up to
  close the app and reopen.

## Contact

- **Email**: support@life-hack.app  *(domain pending — see below)*
- **GitHub Issues**: https://github.com/codydickinson-debug/Life-Hack-App/issues

Please include:
- What you were trying to do
- What happened instead
- Your device + browser (e.g. "iPhone 15, Safari" or "Pixel 9, Chrome")
- Screenshots if visual

### Security issues
If you've found a security vulnerability, please **do not** open a
public GitHub issue. Email us directly (or DM via the contact above)
so we can fix it before disclosing.

## What we don't help with

We don't provide personalized financial, investment, tax, or legal
advice. If you have a question like "should I move my 401(k)?" or
"is this stock a good buy?", we can't answer — talk to a licensed
financial advisor or CFP. See `TERMS.md` for the full disclosure.

---

*This is an early-stage app. The support email above is a planned
address. Until the domain is provisioned, please open a GitHub issue
or use whichever direct contact the App's operator has provided
through other channels.*
