"""
StockAnalyzer — local web UI.

Routes:
  GET  /                — single-page dashboard
  POST /api/analyze     — analyze N user-supplied tickers (JSON)
  GET  /api/scan        — scan a market universe, stream results live (SSE)
                          ?universe=stocks|reits|crypto|international|etfs|bonds

Launch via StockAnalyzer.command — it boots this server and opens a
browser window automatically.
"""

from __future__ import annotations

import json
import os
import threading
import time
import webbrowser
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, is_dataclass
from datetime import datetime
from threading import Lock

import requests as http_requests
from flask import Flask, Response, jsonify, render_template, request

from analyzer import decide, DISCLAIMER
from universe import UNIVERSES, MARKET_META, get_universe
import housing
import mortgages
import news

app = Flask(__name__, static_url_path="/stockanalyzer-static")


def to_jsonable(obj):
    if is_dataclass(obj):
        return {k: to_jsonable(v) for k, v in asdict(obj).items()}
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, datetime):
        return obj.isoformat()
    return obj


def _markets_for_template():
    """Ordered list of market dicts the sidebar uses to render its tabs."""
    return [
        {"id": k, "size": len(UNIVERSES[k]), **MARKET_META[k]}
        for k in MARKET_META
        if k in UNIVERSES
    ]


@app.route("/stockanalyzer")
@app.route("/stockanalyzer/")
def index():
    markets = _markets_for_template()
    return render_template(
        "index.html",
        disclaimer=DISCLAIMER.strip(),
        markets=markets,
        # Back-compat for any template still referencing universe_size:
        universe_size=len(UNIVERSES["stocks"]),
    )


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    data = request.get_json() or {}
    tickers = [t.strip().upper() for t in (data.get("tickers") or "").split() if t.strip()]
    period = data.get("period", "5y")
    try:
        account = float(data.get("account", 10000))
    except (TypeError, ValueError):
        account = 10000.0

    if not tickers:
        return jsonify({"error": "no tickers"}), 400

    results = []
    for tk_ in tickers:
        try:
            d = decide(tk_, period=period, account_size=account)
            if d is None:
                results.append({"ticker": tk_, "error": "no data"})
            else:
                results.append({"ticker": tk_, "decision": to_jsonable(d)})
        except Exception as e:
            results.append({"ticker": tk_, "error": str(e)})

    return jsonify({"results": results})


@app.route("/api/scan")
def api_scan():
    """Stream scan results as Server-Sent Events.

    Each ticker is analyzed in a background worker pool; as each
    completes, an SSE 'result' event is emitted. A 'progress' event
    fires after every completion. A final 'done' event closes the
    stream.
    """
    try:
        account = float(request.args.get("account", 10000))
    except ValueError:
        account = 10000.0
    period = request.args.get("period", "5y")
    universe_name = request.args.get("universe", "stocks")
    universe = list(get_universe(universe_name))

    def sse(event: str, data) -> str:
        return f"event: {event}\ndata: {json.dumps(data)}\n\n"

    def stream():
        yield sse("start", {"total": len(universe), "universe": universe_name})
        completed = 0

        def work(tk_):
            try:
                d = decide(tk_, period=period, account_size=account)
                if d is None:
                    return tk_, {"ticker": tk_, "error": "no data"}
                return tk_, {"ticker": tk_, "decision": to_jsonable(d)}
            except Exception as e:
                return tk_, {"ticker": tk_, "error": str(e)}

        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(work, tk_) for tk_ in universe]
            for fut in futures:
                try:
                    tk_, payload = fut.result(timeout=60)
                except Exception as e:
                    completed += 1
                    yield sse("result", {"ticker": "?", "error": str(e)})
                    yield sse("progress", {"completed": completed, "total": len(universe)})
                    continue
                completed += 1
                yield sse("result", payload)
                yield sse("progress", {"completed": completed, "total": len(universe)})

        yield sse("done", {"completed": completed, "total": len(universe)})

    return Response(stream(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


@app.route("/api/news")
def api_news():
    """Aggregated financial news from major publications. Cached server-side for ~5 min."""
    sources_arg = request.args.get("sources", "").strip()
    source_ids = [s.strip() for s in sources_arg.split(",") if s.strip()] or None
    try:
        limit = max(1, min(200, int(request.args.get("limit", 50))))
    except ValueError:
        limit = 50
    force = request.args.get("refresh") in ("1", "true", "yes")
    try:
        return jsonify(news.get_news(source_ids=source_ids, limit=limit, force_refresh=force))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/quote/<ticker>")
def api_quote(ticker):
    """Lightweight current-price + 1d-change quote (no full pillar analysis)."""
    import yfinance as yf
    try:
        t = yf.Ticker(ticker)
        df = t.history(period="5d", auto_adjust=True)
        if df is None or df.empty or len(df) < 1:
            return jsonify({"error": "no data"}), 404
        last = float(df["Close"].iloc[-1])
        prev = float(df["Close"].iloc[-2]) if len(df) >= 2 else last
        change = last - prev
        change_pct = (change / prev) if prev > 0 else 0.0
        return jsonify({
            "ticker": ticker.upper(),
            "price": last,
            "prev_close": prev,
            "change": change,
            "change_pct": change_pct,
            "as_of": df.index[-1].strftime("%Y-%m-%d"),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/quote/<ticker>/full")
def api_quote_full(ticker):
    """Rich quote — current price + 30-day sparkline + 52-week range +
    volume + market cap + P/E. Designed for a native stocks watchlist UI.
    Cached by yfinance so repeat calls within a few minutes are fast.
    """
    import yfinance as yf
    try:
        t = yf.Ticker(ticker)
        # 1-year history (used for 52-week range + 30-day sparkline + 1y chart)
        df = t.history(period="1y", auto_adjust=True)
        if df is None or df.empty or len(df) < 2:
            return jsonify({"error": "no data"}), 404

        closes = [float(x) for x in df["Close"].tolist()]
        dates = [d.strftime("%Y-%m-%d") for d in df.index.tolist()]
        last = closes[-1]
        prev = closes[-2]
        change = last - prev
        change_pct = (change / prev) if prev > 0 else 0.0

        # 52-week high/low (anywhere in the 1y window)
        hi52 = max(closes)
        lo52 = min(closes)
        # Where is the current price between the two? (0 = at low, 1 = at high)
        rng_pos = (last - lo52) / (hi52 - lo52) if hi52 > lo52 else 0.5

        # 30-day sparkline data
        spark = closes[-30:] if len(closes) >= 30 else closes
        # Daily-change list for the recent month (used by clients for volatility)
        # YTD-style return: last vs first close
        ytd_ret = ((last - closes[0]) / closes[0]) if closes[0] > 0 else 0.0
        # 30-day return
        ret30 = ((last - closes[-30]) / closes[-30]) if len(closes) >= 30 and closes[-30] > 0 else None

        # Extra info from yfinance .info (may be slow / partial — guard each field)
        info = {}
        try:
            info = t.info or {}
        except Exception:
            info = {}
        def _f(k):
            v = info.get(k)
            try:
                return float(v) if v is not None else None
            except (TypeError, ValueError):
                return None
        market_cap = _f("marketCap")
        trailing_pe = _f("trailingPE")
        forward_pe = _f("forwardPE")
        dividend_yield = _f("dividendYield")
        avg_vol = _f("averageVolume")
        last_vol = _f("regularMarketVolume") or _f("volume")
        sector = info.get("sector") if isinstance(info.get("sector"), str) else None
        industry = info.get("industry") if isinstance(info.get("industry"), str) else None
        long_name = info.get("longName") or info.get("shortName") if isinstance(info.get("longName") or info.get("shortName"), str) else None
        beta = _f("beta")

        return jsonify({
            "ticker": ticker.upper(),
            "name": long_name,
            "sector": sector,
            "industry": industry,
            "price": last,
            "prev_close": prev,
            "change": change,
            "change_pct": change_pct,
            "as_of": df.index[-1].strftime("%Y-%m-%d"),
            "hi52": hi52,
            "lo52": lo52,
            "range_pos": rng_pos,
            "ytd_return": ytd_ret,
            "return_30d": ret30,
            "market_cap": market_cap,
            "trailing_pe": trailing_pe,
            "forward_pe": forward_pe,
            "dividend_yield": dividend_yield,
            "average_volume": avg_vol,
            "last_volume": last_vol,
            "beta": beta,
            "spark_30d": spark,
            "history_1y_dates": dates[-252:] if len(dates) > 252 else dates,
            "history_1y_closes": closes[-252:] if len(closes) > 252 else closes,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/quote/batch")
def api_quote_batch():
    """Batch quote endpoint — returns lightweight quotes for multiple
    tickers in one round-trip. Used by the watchlist to refresh all rows.
    Usage: GET /api/quote/batch?tickers=AAPL,GOOG,MSFT
    """
    import yfinance as yf
    tickers_arg = (request.args.get("tickers") or "").strip()
    if not tickers_arg:
        return jsonify({"error": "tickers query param required"}), 400
    tickers = [t.strip().upper() for t in tickers_arg.split(",") if t.strip()][:25]
    out = {}
    for tk in tickers:
        try:
            t = yf.Ticker(tk)
            df = t.history(period="30d", auto_adjust=True)
            if df is None or df.empty or len(df) < 2:
                out[tk] = {"error": "no data"}
                continue
            closes = [float(x) for x in df["Close"].tolist()]
            last = closes[-1]
            prev = closes[-2]
            change = last - prev
            change_pct = (change / prev) if prev > 0 else 0.0
            out[tk] = {
                "price": last,
                "change": change,
                "change_pct": change_pct,
                "spark_30d": closes[-30:] if len(closes) >= 30 else closes,
            }
        except Exception as e:
            out[tk] = {"error": str(e)}
    return jsonify({"quotes": out})


@app.route("/api/housing/status")
def api_housing_status():
    return jsonify(housing.status())


@app.route("/api/housing/national")
def api_housing_national():
    try:
        snap = housing.get_national()
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if snap is None:
        return jsonify({"error": "no national data"}), 404
    return jsonify(housing.snapshot_to_dict(snap))


@app.route("/api/housing/zip/<zip_code>")
def api_housing_zip(zip_code: str):
    try:
        snap = housing.get_zip(zip_code)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    if snap is None:
        return jsonify({"error": f"no data for ZIP {zip_code}"}), 404
    return jsonify(housing.snapshot_to_dict(snap))


@app.route("/api/housing/metros")
def api_housing_metros():
    """Return scored metros, sorted by verdict score (hot=+, cold=-)."""
    try:
        metros = housing.get_metros()
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    sort = request.args.get("sort", "hot")
    metros.sort(key=lambda m: m.verdict.score, reverse=(sort == "hot"))
    limit = max(1, min(50, int(request.args.get("limit", 10))))
    return jsonify({
        "sort": sort,
        "metros": [housing.snapshot_to_dict(m) for m in metros[:limit]],
    })


def warm_housing_cache():
    """Pre-fetch housing + mortgage CSVs in background so first request is instant."""
    try:
        for name in housing.SOURCES:
            housing.ensure_cached(name)
    except Exception as e:
        print(f"  (housing cache warm failed: {e})")
    try:
        for name in mortgages.SERIES:
            mortgages.ensure_cached(name)
    except Exception as e:
        print(f"  (mortgage cache warm failed: {e})")
    try:
        news.get_news(limit=1)  # populates the in-memory cache
    except Exception as e:
        print(f"  (news cache warm failed: {e})")


@app.route("/api/mortgage/current")
def api_mortgage_current():
    try:
        return jsonify(mortgages.get_current_rates())
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/mortgage/history")
def api_mortgage_history():
    try:
        years = max(1, min(50, int(request.args.get("years", 5))))
    except ValueError:
        years = 5
    name = request.args.get("series", "30y")
    try:
        return jsonify({
            "series": name,
            "years": years,
            "data": mortgages.get_history(name, years=years),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/mortgage/calculate", methods=["POST"])
def api_mortgage_calculate():
    data = request.get_json() or {}
    try:
        result = mortgages.compute_payment(
            home_price=float(data.get("home_price", 0)),
            down_payment=float(data.get("down_payment", 0)),
            fico=int(data.get("fico", 740)),
            term=int(data.get("term", 30)),
            property_tax_pct=float(data.get("property_tax_pct", 1.1)),
            insurance_pct=float(data.get("insurance_pct", 0.5)),
            hoa_monthly=float(data.get("hoa_monthly", 0)),
        )
        return jsonify(result)
    except (TypeError, ValueError) as e:
        return jsonify({"error": f"bad input: {e}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ----------------------------------------------------------------------
# AI proxy — /api/ai/messages
# ----------------------------------------------------------------------
# Proxies frontend AI calls (Financial Counselor chat, monthly insights,
# AI onboarding) to Anthropic so the API key never reaches the browser.
# Co-located with this backend so the frontend hits the same origin and
# the user needs zero per-device configuration.
#
# Environment variables (set in the Vercel project settings):
#   ANTHROPIC_API_KEY        required — sk-ant-... server-side key
#   ANTHROPIC_DAILY_CAP      optional, default 50 (per-IP daily request cap)
#   AI_MODEL_ALLOWLIST       optional comma-separated list; if set, only
#                            these model strings are accepted from clients
#
# Notes:
#  - The key lives only in the runtime env. Never logged, never returned,
#    never injected into client code.
#  - The per-IP daily cap is a soft cost guard, not abuse-grade security.
#    For App Store launch, add proper auth (signed JWT or per-device
#    enrollment) on top of this — see AI_PROXY_SETUP.md.
#  - Upstream Anthropic status + body are mirrored verbatim on non-2xx so
#    the frontend's existing error handling keeps working unchanged.

_AI_COUNTERS = defaultdict(lambda: {"day": "", "count": 0})
_AI_COUNTERS_LOCK = Lock()

_AI_DEFAULT_MODEL = "claude-haiku-4-5-20251001"
_AI_MAX_TOKENS_CAP = 4000  # client may request less; never more
_AI_REQUEST_TIMEOUT_S = 60
_ANTHROPIC_VERSION = "2023-06-01"


def _ai_today_key() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _ai_client_ip() -> str:
    # Vercel sets x-forwarded-for; trust the first hop (the Vercel edge).
    fwd = request.headers.get("x-forwarded-for", "")
    return (fwd.split(",")[0] or request.remote_addr or "0.0.0.0").strip()


def _ai_check_quota(ip: str):
    """Returns (allowed, used_today, daily_cap)."""
    try:
        cap = int(os.environ.get("ANTHROPIC_DAILY_CAP", "50"))
    except (TypeError, ValueError):
        cap = 50
    today = _ai_today_key()
    with _AI_COUNTERS_LOCK:
        entry = _AI_COUNTERS[ip]
        if entry["day"] != today:
            entry["day"] = today
            entry["count"] = 0
        if entry["count"] >= cap:
            return False, entry["count"], cap
        entry["count"] += 1
        return True, entry["count"], cap


def _ai_api_key() -> str:
    """Resolve the Anthropic key from any of the conventional env var names.
    Accepts ANTHROPIC_API_KEY (preferred) or ANTHROPIC_KEY (Cloudflare Worker
    naming) so operators don't have to think about which one we expect."""
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_KEY"):
        v = os.environ.get(name, "").strip()
        if v:
            return v
    return ""


@app.route("/api/ai/messages", methods=["POST"])
def api_ai_messages():
    api_key = _ai_api_key()
    if not api_key:
        return jsonify({"error": "AI is not configured on this deployment."}), 503

    body = request.get_json(silent=True) or {}
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return jsonify({"error": "messages[] is required"}), 400

    # Model allowlist (optional). Defends against a compromised client
    # asking for a more expensive model than the operator intends to pay for.
    allowlist = [m.strip() for m in os.environ.get("AI_MODEL_ALLOWLIST", "").split(",") if m.strip()]
    model = (body.get("model") or _AI_DEFAULT_MODEL).strip()
    if allowlist and model not in allowlist:
        return jsonify({"error": f"model '{model}' not allowed"}), 400

    # Clamp max_tokens to prevent runaway responses.
    try:
        max_tokens = int(body.get("max_tokens", 800))
    except (TypeError, ValueError):
        max_tokens = 800
    max_tokens = max(1, min(_AI_MAX_TOKENS_CAP, max_tokens))

    # Per-IP daily cap. Soft guard against casual abuse / runaway cost.
    ip = _ai_client_ip()
    allowed, used, cap = _ai_check_quota(ip)
    if not allowed:
        return jsonify({
            "error": f"Daily AI cap reached ({used}/{cap}). Try again tomorrow.",
        }), 429

    payload = {"model": model, "max_tokens": max_tokens, "messages": messages}
    if isinstance(body.get("system"), str) and body["system"]:
        # Cap system prompt size as a defense against client-side runaway, but
        # set it high enough to fit the full counselor system + snapshot JSON
        # (currently ~16 kB). Anthropic accepts vastly more than this.
        payload["system"] = body["system"][:32000]
    if isinstance(body.get("temperature"), (int, float)):
        payload["temperature"] = float(body["temperature"])

    try:
        r = http_requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": _ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            data=json.dumps(payload),
            timeout=_AI_REQUEST_TIMEOUT_S,
        )
    except http_requests.RequestException as e:
        return jsonify({"error": f"Upstream Anthropic request failed: {e.__class__.__name__}"}), 502

    try:
        resp_body = r.json()
    except ValueError:
        resp_body = {"error": "Upstream returned non-JSON response"}
    return jsonify(resp_body), r.status_code


@app.route("/api/ai/health")
def api_ai_health():
    """Public health check — does NOT reveal the key itself, only which env var
    name is providing it (helps the operator diagnose name mismatches)."""
    key_source = None
    for name in ("ANTHROPIC_API_KEY", "ANTHROPIC_KEY"):
        if os.environ.get(name, "").strip():
            key_source = name
            break
    return jsonify({
        "configured": key_source is not None,
        "key_source": key_source,
        "daily_cap": int(os.environ.get("ANTHROPIC_DAILY_CAP", "50") or "50"),
        "allowlist_count": len([m for m in os.environ.get("AI_MODEL_ALLOWLIST", "").split(",") if m.strip()]),
    })


def open_browser():
    time.sleep(1.2)
    webbrowser.open("http://127.0.0.1:5555/")


def main():
    threading.Thread(target=open_browser, daemon=True).start()
    threading.Thread(target=warm_housing_cache, daemon=True).start()
    print("\n  StockAnalyzer running at http://127.0.0.1:5555/")
    print("  Press Ctrl+C in this window to quit.\n")
    app.run(host="127.0.0.1", port=5555, debug=False, use_reloader=False, threaded=True)


if __name__ == "__main__":
    main()
