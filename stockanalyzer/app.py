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
import logging
import os
import re
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

# Configure a real logger so we can record full error context server-side
# while only returning generic messages to clients (prevents info-leakage
# of library internals, file paths, and upstream details).
_log = logging.getLogger("stockanalyzer")
if not _log.handlers:
    _log.setLevel(logging.INFO)
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    _log.addHandler(_h)


# Strict allowlist for ticker symbols reaching yfinance — defends against
# SSRF/path-traversal attempts where a maliciously crafted path segment
# could compose unexpected URLs inside yfinance. Yahoo tickers fit this:
# uppercase letters, digits, dot, dash, caret (for indices like ^GSPC),
# and equals (for futures like ES=F). 1–10 chars.
_TICKER_RE = re.compile(r"^[A-Z0-9.\-^=]{1,10}$")


def _valid_ticker(s):
    """Return upper-cased ticker if valid, else None."""
    if not s or not isinstance(s, str):
        return None
    up = s.strip().upper()
    return up if _TICKER_RE.match(up) else None


def _err(public_message, exc=None, status=500):
    """Log full exception details server-side, return a generic message to
    the client. Prevents leakage of stack traces, library internals, and
    upstream service payloads through error responses."""
    if exc is not None:
        _log.exception("%s: %s", public_message, exc)
    else:
        _log.error(public_message)
    return jsonify({"error": public_message}), status


def _norm_yield(y):
    """Normalize yfinance's dividend yield to a fraction.

    Current yfinance (≥0.2.40) returns dividendYield as a percentage number
    where 3.28 means 3.28% — we standardize on fraction form (0.0328) so the
    frontend can multiply by 100 once.

    Always divides by 100. A magnitude-based heuristic was wrong: low-yield
    stocks (AAPL ~0.36) stayed at 0.36 instead of becoming 0.0036.

    If yfinance ever reverts to fractional output we'll need a version check —
    but as of this writing every tested ticker returns percentage form.
    """
    if y is None:
        return None
    try:
        v = float(y)
    except (TypeError, ValueError):
        return None
    return v / 100.0


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
    # Clamp to a sane range — float("1e308") parses without error and would
    # propagate Infinity/NaN through downstream multiplications in decide().
    if not (account == account):  # NaN check
        account = 10000.0
    account = max(0.0, min(1_000_000_000.0, account))
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
        return _err("news fetch failed", e)


@app.route("/api/quote/<ticker>")
def api_quote(ticker):
    """Lightweight current-price + 1d-change quote (no full pillar analysis)."""
    import yfinance as yf
    ticker = _valid_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker format"}), 400
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
    ticker = _valid_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker format"}), 400
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
        dividend_yield = _norm_yield(_f("dividendYield"))
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


@app.route("/api/ticker/<ticker>")
def api_ticker_broker(ticker):
    """Broker-grade ticker detail: every signal a research platform shows.

    Bundles into one round-trip:
      - Real-time quote (price, change, change %)
      - Day range, 52-week range, range position
      - Multi-timeframe close arrays (1M, 3M, 6M, 1Y, 5Y) for chart
      - 50-day + 200-day moving averages over the 1Y window
      - RSI(14) over the 1Y window
      - Volume series for the 6M window + average volume + last
      - Earnings — next earnings date if upcoming
      - Analyst recommendations summary (counts + mean target)
      - Top per-ticker news (5)
      - Insider + institutional ownership headline counts
      - Sector / industry / company name / beta / dividend yield
      - Trailing + forward P/E, market cap, EPS

    yfinance fetches several lookups per ticker. Slow on cold cache
    (8-15s typical), fast on warm. Marked as cacheable for ~5 min
    on the Vercel side via Cache-Control headers.
    """
    import yfinance as yf
    ticker = _valid_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker format"}), 400
    try:
        t = yf.Ticker(ticker)
        # 5y daily — covers all timeframes we need to slice
        df = t.history(period="5y", auto_adjust=True)
        if df is None or df.empty or len(df) < 2:
            return jsonify({"error": "no data"}), 404
        closes = [float(x) for x in df["Close"].tolist()]
        opens  = [float(x) for x in df["Open"].tolist()]
        highs  = [float(x) for x in df["High"].tolist()]
        lows   = [float(x) for x in df["Low"].tolist()]
        vols   = [int(x) if x == x else 0 for x in df["Volume"].tolist()]
        dates  = [d.strftime("%Y-%m-%d") for d in df.index.tolist()]

        last_close = closes[-1]
        prev_close = closes[-2]
        last_open  = opens[-1]
        day_high   = highs[-1]
        day_low    = lows[-1]
        last_vol   = vols[-1]
        change     = last_close - prev_close
        change_pct = (change / prev_close) if prev_close > 0 else 0.0

        # Multi-timeframe slices (last N trading days)
        slice_n = lambda n: closes[-n:] if len(closes) >= n else closes
        slice_d = lambda n: dates[-n:] if len(dates) >= n else dates
        tf = {
            "1M": {"closes": slice_n(21),  "dates": slice_d(21)},
            "3M": {"closes": slice_n(63),  "dates": slice_d(63)},
            "6M": {"closes": slice_n(126), "dates": slice_d(126)},
            "1Y": {"closes": slice_n(252), "dates": slice_d(252)},
            "5Y": {"closes": closes,       "dates": dates},
        }

        # 52-week stats
        y1_closes = tf["1Y"]["closes"]
        hi52 = max(y1_closes)
        lo52 = min(y1_closes)
        rng_pos = (last_close - lo52) / (hi52 - lo52) if hi52 > lo52 else 0.5
        ret_ytd = ((last_close - y1_closes[0]) / y1_closes[0]) if len(y1_closes) > 0 and y1_closes[0] > 0 else 0.0
        ret_30d = ((last_close - closes[-21]) / closes[-21]) if len(closes) >= 21 and closes[-21] > 0 else None
        ret_5y  = ((last_close - closes[0]) / closes[0]) if closes[0] > 0 else None

        # 50/200-day simple moving averages over the 1Y window
        def sma(arr, n):
            out = []
            running = 0.0
            for i, v in enumerate(arr):
                running += v
                if i >= n:
                    running -= arr[i - n]
                out.append(running / n if i >= n - 1 else None)
            return out
        sma50  = sma(y1_closes, 50)
        sma200 = sma(closes, 200)[-len(y1_closes):]  # align with 1Y window
        sma50_last  = next((x for x in reversed(sma50) if x is not None), None)
        sma200_last = next((x for x in reversed(sma200) if x is not None), None)

        # RSI(14) over the 1Y window
        def rsi(arr, n=14):
            if len(arr) < n + 1:
                return None
            gains = 0.0; losses = 0.0
            for i in range(1, n + 1):
                d = arr[i] - arr[i - 1]
                if d > 0: gains += d
                else: losses += -d
            avg_g = gains / n
            avg_l = losses / n
            for i in range(n + 1, len(arr)):
                d = arr[i] - arr[i - 1]
                g = d if d > 0 else 0
                l = -d if d < 0 else 0
                avg_g = (avg_g * (n - 1) + g) / n
                avg_l = (avg_l * (n - 1) + l) / n
            if avg_l == 0:
                return 100.0
            rs = avg_g / avg_l
            return 100 - (100 / (1 + rs))
        rsi_val = rsi(y1_closes, 14)

        # Volume series + average (6M window)
        vol_6m = vols[-126:] if len(vols) >= 126 else vols
        avg_vol_6m = sum(vol_6m) / len(vol_6m) if vol_6m else None

        # yfinance .info — guarded
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
        market_cap     = _f("marketCap")
        trailing_pe    = _f("trailingPE")
        forward_pe     = _f("forwardPE")
        dividend_yield = _norm_yield(_f("dividendYield"))
        avg_vol_info   = _f("averageVolume")
        beta           = _f("beta")
        eps_trailing   = _f("trailingEps")
        eps_forward    = _f("forwardEps")
        peg_ratio      = _f("pegRatio")
        revenue_growth = _f("revenueGrowth")
        earnings_growth= _f("earningsGrowth")
        profit_margin  = _f("profitMargins")
        debt_to_equity = _f("debtToEquity")
        sector         = info.get("sector") if isinstance(info.get("sector"), str) else None
        industry       = info.get("industry") if isinstance(info.get("industry"), str) else None
        long_name      = info.get("longName") or info.get("shortName") if isinstance(info.get("longName") or info.get("shortName"), str) else None
        target_mean    = _f("targetMeanPrice")
        target_high    = _f("targetHighPrice")
        target_low     = _f("targetLowPrice")
        rec_mean       = _f("recommendationMean")
        rec_key        = info.get("recommendationKey") if isinstance(info.get("recommendationKey"), str) else None
        num_analysts   = _f("numberOfAnalystOpinions")
        held_insiders  = _f("heldPercentInsiders")
        held_inst      = _f("heldPercentInstitutions")
        short_pct      = _f("shortPercentOfFloat")

        # Earnings — next date if upcoming
        next_earnings_date = None
        try:
            cal = t.calendar
            if cal is not None and not getattr(cal, "empty", True):
                ed = cal.get("Earnings Date") if hasattr(cal, "get") else None
                if ed is not None and len(ed) > 0:
                    d0 = ed[0]
                    next_earnings_date = d0.strftime("%Y-%m-%d") if hasattr(d0, "strftime") else str(d0)
        except Exception:
            try:
                # Newer yfinance returns dict
                cal2 = t.calendar
                if isinstance(cal2, dict):
                    ed = cal2.get("Earnings Date")
                    if ed and len(ed) > 0:
                        next_earnings_date = ed[0].strftime("%Y-%m-%d")
            except Exception:
                next_earnings_date = None

        # Per-ticker news headlines (top 5)
        news_items = []
        try:
            raw_news = t.news or []
            for n in raw_news[:5]:
                # newer yfinance returns dicts with .content, older returns flat
                if isinstance(n, dict):
                    c = n.get("content") or n
                    title = c.get("title") or n.get("title")
                    publisher = c.get("provider", {}).get("displayName") if isinstance(c.get("provider"), dict) else (n.get("publisher") or c.get("publisher"))
                    link = c.get("canonicalUrl", {}).get("url") if isinstance(c.get("canonicalUrl"), dict) else (n.get("link") or c.get("link"))
                    pub_ts = c.get("pubDate") or n.get("providerPublishTime")
                    if title:
                        news_items.append({
                            "title": title,
                            "publisher": publisher,
                            "url": link,
                            "published": pub_ts,
                        })
        except Exception:
            pass

        # Analyst recommendations summary — recommendations table
        rec_summary = None
        try:
            rec_df = t.recommendations
            if rec_df is not None and not rec_df.empty:
                # Most recent month bucket if available
                latest = rec_df.tail(1).to_dict("records")
                if latest:
                    rec_summary = {k: int(v) if isinstance(v, (int, float)) else str(v) for k, v in latest[0].items()}
        except Exception:
            rec_summary = None

        return jsonify({
            "ticker": ticker.upper(),
            "name": long_name,
            "sector": sector,
            "industry": industry,
            "price": last_close,
            "open": last_open,
            "prev_close": prev_close,
            "change": change,
            "change_pct": change_pct,
            "day_high": day_high,
            "day_low": day_low,
            "hi52": hi52,
            "lo52": lo52,
            "range_pos": rng_pos,
            "ytd_return": ret_ytd,
            "return_30d": ret_30d,
            "return_5y": ret_5y,
            "as_of": dates[-1],
            "market_cap": market_cap,
            "trailing_pe": trailing_pe,
            "forward_pe": forward_pe,
            "peg_ratio": peg_ratio,
            "eps_trailing": eps_trailing,
            "eps_forward": eps_forward,
            "revenue_growth": revenue_growth,
            "earnings_growth": earnings_growth,
            "profit_margin": profit_margin,
            "debt_to_equity": debt_to_equity,
            "dividend_yield": dividend_yield,
            "average_volume": avg_vol_info,
            "last_volume": last_vol,
            "avg_vol_6m": avg_vol_6m,
            "beta": beta,
            "held_insiders": held_insiders,
            "held_institutions": held_inst,
            "short_pct_float": short_pct,
            # Multi-timeframe chart data
            "timeframes": tf,
            # Volume series (6 months)
            "volume_6m": vol_6m,
            # Technical indicators
            "sma50": sma50,
            "sma200": sma200,
            "sma50_last": sma50_last,
            "sma200_last": sma200_last,
            "rsi14": rsi_val,
            # Analyst data
            "target_mean": target_mean,
            "target_high": target_high,
            "target_low": target_low,
            "recommendation_mean": rec_mean,
            "recommendation_key": rec_key,
            "num_analysts": num_analysts,
            "recommendations_latest": rec_summary,
            # Earnings + news
            "next_earnings": next_earnings_date,
            "news": news_items,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/forecast/<ticker>")
def api_forecast(ticker):
    """Price forecast: past + Monte Carlo projection with bear/base/bull
    scenarios. Uses geometric Brownian motion with historical drift +
    volatility. Returns monthly checkpoints out to N months.

    Query: ?months=12 (default 24, max 60)

    Returns:
      ticker
      history: [{date, price}]            past 2y monthly closes
      current_price
      mu_daily, sigma_daily               estimated drift / vol
      mu_annual, sigma_annual
      forecast:
        - bear:  [{months_ahead, price}]  10th percentile
        - base:  [{months_ahead, price}]  median
        - bull:  [{months_ahead, price}]  90th percentile
      cone_5y: same shape, 5y if longer view available
      drivers: brief notes on what's powering each scenario
    """
    import yfinance as yf
    import math, random
    ticker = _valid_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker format"}), 400
    try:
        months = max(3, min(60, int(request.args.get("months", 24))))
    except ValueError:
        months = 24
    try:
        t = yf.Ticker(ticker)
        # 5y daily for vol estimate; 2y monthly for history display
        df = t.history(period="5y", auto_adjust=True)
        if df is None or df.empty or len(df) < 100:
            return jsonify({"error": "not enough history"}), 404
        closes = [float(x) for x in df["Close"].tolist()]
        # Daily log returns
        rets = [math.log(closes[i] / closes[i-1]) for i in range(1, len(closes)) if closes[i-1] > 0]
        if not rets:
            return jsonify({"error": "no return data"}), 500
        # Robust stats: trim outliers ±4 sigma
        mu_d = sum(rets) / len(rets)
        var_d = sum((r - mu_d) ** 2 for r in rets) / len(rets)
        sigma_d = math.sqrt(var_d) if var_d > 0 else 0.01
        # Annualize (252 trading days)
        mu_annual = mu_d * 252
        sigma_annual = sigma_d * math.sqrt(252)

        last = closes[-1]
        # Monthly history (last 24 months, 21 trading days per month)
        history = []
        step = 21
        for i in range(max(0, len(closes) - 24*step), len(closes), step):
            d = df.index[i].strftime("%Y-%m-%d")
            history.append({"date": d, "price": closes[i]})
        history.append({"date": df.index[-1].strftime("%Y-%m-%d"), "price": last})

        # Analytic GBM percentiles per month — no simulation needed.
        # Under GBM, ln(P_t/P_0) ~ N((mu - sigma²/2) * t, sigma² * t)
        # We use trading-day t in years for consistency with annualized params.
        def percentile_at(months_ahead, p):
            # Standard normal inverse for percentiles 10/50/90
            inv = {0.10: -1.28155, 0.50: 0.0, 0.90: 1.28155}
            z = inv.get(p, 0.0)
            t_yr = months_ahead / 12.0
            drift = (mu_annual - 0.5 * sigma_annual ** 2) * t_yr
            vol_t = sigma_annual * math.sqrt(t_yr)
            return last * math.exp(drift + z * vol_t)

        forecast_bear, forecast_base, forecast_bull = [], [], []
        for m in range(0, months + 1):
            forecast_bear.append({"months_ahead": m, "price": round(percentile_at(m, 0.10), 4)})
            forecast_base.append({"months_ahead": m, "price": round(percentile_at(m, 0.50), 4)})
            forecast_bull.append({"months_ahead": m, "price": round(percentile_at(m, 0.90), 4)})

        # Plain-English driver hints (consumed by UI when AI is unavailable)
        annual_drift_pct = (math.exp(mu_annual) - 1) * 100
        annual_vol_pct = sigma_annual * 100
        drivers = {
            "trend": "rising" if mu_annual > 0.02 else "falling" if mu_annual < -0.02 else "sideways",
            "volatility": "high" if annual_vol_pct > 35 else "moderate" if annual_vol_pct > 20 else "calm",
            "annual_drift_pct": round(annual_drift_pct, 2),
            "annual_vol_pct":   round(annual_vol_pct, 2),
        }

        return jsonify({
            "ticker": ticker.upper(),
            "history": history,
            "current_price": last,
            "mu_daily": mu_d,
            "sigma_daily": sigma_d,
            "mu_annual": mu_annual,
            "sigma_annual": sigma_annual,
            "annual_drift_pct": annual_drift_pct,
            "annual_vol_pct": annual_vol_pct,
            "forecast": {
                "bear": forecast_bear,
                "base": forecast_base,
                "bull": forecast_bull,
            },
            "drivers": drivers,
            "horizon_months": months,
            "method": "GBM (geometric Brownian motion) — drift + volatility from 5y daily returns",
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/breadth")
def api_breadth():
    """Market breadth — composite Fear/Greed-style readout. Computes:
      - SPY current vs 50/200-day SMAs (trend)
      - VIX level (volatility / fear proxy)
      - 10Y treasury yield (rates)
      - Gold YTD vs SPX YTD (safe-haven flow)
      - 5-day SPY momentum
    Returns a 0-100 sentiment score plus the individual signals so the UI
    can render each one with its own color.
    """
    import yfinance as yf
    out = {"score": 50, "band": "Neutral", "signals": [], "as_of": None}
    try:
        spy = yf.Ticker("SPY").history(period="1y", auto_adjust=True)
        if spy is None or spy.empty or len(spy) < 200:
            return jsonify({"error": "no breadth data"}), 503
        closes = [float(x) for x in spy["Close"].tolist()]
        last = closes[-1]
        sma50  = sum(closes[-50:])  / 50.0
        sma200 = sum(closes[-200:]) / 200.0
        mom5d  = (last - closes[-5]) / closes[-5] if len(closes) >= 5 and closes[-5] > 0 else 0
        ytd_pct = (last - closes[0]) / closes[0] if closes[0] > 0 else 0
        out["as_of"] = spy.index[-1].strftime("%Y-%m-%d")

        score = 50
        # Trend vs 200d (±20)
        d200 = (last - sma200) / sma200 if sma200 > 0 else 0
        c20 = max(-20, min(20, d200 * 200))
        score += c20
        out["signals"].append({
            "label": "S&P 500 vs 200d SMA",
            "value": f"{'+' if d200 >= 0 else ''}{(d200*100):.1f}%",
            "score": round(c20),
            "tone": "bullish" if d200 > 0.02 else "bearish" if d200 < -0.02 else "neutral",
        })
        # Trend vs 50d (±10)
        d50 = (last - sma50) / sma50 if sma50 > 0 else 0
        c10 = max(-10, min(10, d50 * 200))
        score += c10
        out["signals"].append({
            "label": "S&P 500 vs 50d SMA",
            "value": f"{'+' if d50 >= 0 else ''}{(d50*100):.1f}%",
            "score": round(c10),
            "tone": "bullish" if d50 > 0.01 else "bearish" if d50 < -0.01 else "neutral",
        })
        # 5d momentum (±10)
        cm = max(-10, min(10, mom5d * 200))
        score += cm
        out["signals"].append({
            "label": "5-day momentum",
            "value": f"{'+' if mom5d >= 0 else ''}{(mom5d*100):.1f}%",
            "score": round(cm),
            "tone": "bullish" if mom5d > 0.005 else "bearish" if mom5d < -0.005 else "neutral",
        })
        # VIX (inverted — high VIX = fear)
        try:
            vix = yf.Ticker("^VIX").history(period="5d", auto_adjust=True)
            if vix is not None and not vix.empty:
                vix_last = float(vix["Close"].iloc[-1])
                # VIX 12 = greedy, 20 = neutral, 30+ = fearful
                cv = (20 - vix_last) * 1.2
                cv = max(-15, min(15, cv))
                score += cv
                out["signals"].append({
                    "label": "VIX",
                    "value": f"{vix_last:.1f}",
                    "score": round(cv),
                    "tone": "bullish" if vix_last < 18 else "bearish" if vix_last > 25 else "neutral",
                })
        except Exception: pass

        # 10Y vs 6mo prior (rising rates = bearish, falling = bullish)
        try:
            tnx = yf.Ticker("^TNX").history(period="6mo", auto_adjust=True)
            if tnx is not None and not tnx.empty and len(tnx) >= 30:
                t_now = float(tnx["Close"].iloc[-1])
                t_then = float(tnx["Close"].iloc[0])
                t_delta = t_now - t_then
                cr = max(-5, min(5, -t_delta * 5))
                score += cr
                out["signals"].append({
                    "label": "10Y treasury",
                    "value": f"{t_now:.2f}% ({'+' if t_delta>=0 else ''}{t_delta:.2f} 6mo)",
                    "score": round(cr),
                    "tone": "bearish" if t_delta > 0.3 else "bullish" if t_delta < -0.3 else "neutral",
                })
        except Exception: pass

        score = max(5, min(95, round(score)))
        out["score"] = score
        if score < 25:    out["band"] = "Extreme fear"
        elif score < 45:  out["band"] = "Fear"
        elif score < 55:  out["band"] = "Neutral"
        elif score < 75:  out["band"] = "Greed"
        else:             out["band"] = "Extreme greed"
        return jsonify(out)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/dividends/calendar")
def api_dividends_calendar():
    """For each ticker, return next ex-dividend date + dividend rate (per share).
    Used by the dividend calendar to show 'AAPL pays $0.25/sh on May 19 →
    you'll get $2.50' for the user's holdings.

    Usage: GET /api/dividends/calendar?tickers=AAPL,MSFT,JNJ
    Returns: {ticker: {ex_dividend_date, dividend_rate, payment_date?}}
    """
    import yfinance as yf
    tickers_arg = (request.args.get("tickers") or "").strip()
    if not tickers_arg:
        return jsonify({"error": "tickers query param required"}), 400
    tickers = [_valid_ticker(t) for t in tickers_arg.split(",")[:30]]
    tickers = [t for t in tickers if t]
    out = {}
    def lookup(tk):
        try:
            t = yf.Ticker(tk)
            info = {}
            try: info = t.info or {}
            except Exception: pass
            ex_date = info.get("exDividendDate")
            if ex_date and isinstance(ex_date, (int, float)) and ex_date > 0:
                try:
                    ex_date_str = datetime.fromtimestamp(int(ex_date)).strftime("%Y-%m-%d")
                except Exception:
                    ex_date_str = None
            else:
                ex_date_str = None
            rate = info.get("dividendRate")
            try: rate = float(rate) if rate is not None else None
            except (TypeError, ValueError): rate = None
            return tk, {
                "ex_dividend_date": ex_date_str,
                "dividend_rate":    rate,             # annual $/share
                "dividend_yield":   _norm_yield(info.get("dividendYield")),
            }
        except Exception as e:
            return tk, {"error": str(e)}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for tk, res in pool.map(lookup, tickers):
            out[tk] = res
    return jsonify({"calendar": out})


@app.route("/api/etf/<ticker>")
def api_etf_holdings(ticker):
    """ETF holdings + sector exposure. For non-ETF tickers, returns {}.

    Returns:
      type: 'ETF' or 'fund'
      top_holdings: [{symbol, name, weight}]
      sector_weights: {sector: pct}
      expense_ratio, total_assets, ytd_return
    """
    import yfinance as yf
    ticker = _valid_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker format"}), 400
    try:
        t = yf.Ticker(ticker)
        info = {}
        try: info = t.info or {}
        except Exception: pass
        quote_type = (info.get("quoteType") or "").upper()
        if quote_type not in ("ETF", "MUTUALFUND"):
            return jsonify({"type": quote_type or None, "etf": False})
        # yfinance .funds_data API
        out = {"type": quote_type, "etf": True}
        try:
            fd = t.funds_data
            if fd is not None:
                try:
                    th = fd.top_holdings
                    if th is not None and not getattr(th, "empty", True):
                        records = []
                        df_reset = th.head(15).reset_index()
                        for r in df_reset.to_dict("records"):
                            sym = r.get("Symbol") or r.get("symbol") or r.get("index")
                            name = r.get("Name") or r.get("holdingName") or r.get("name")
                            wt   = r.get("Holding Percent") or r.get("holdingPercent") or r.get("Weight")
                            records.append({
                                "symbol": str(sym) if sym is not None else None,
                                "name": str(name) if name is not None else None,
                                "weight": float(wt) if wt is not None else None,
                            })
                        out["top_holdings"] = records
                except Exception: pass
                try:
                    sw = fd.sector_weightings
                    if sw is not None and isinstance(sw, dict):
                        out["sector_weights"] = {str(k): float(v) for k, v in sw.items() if v is not None}
                except Exception: pass
                try:
                    eq = fd.equity_holdings
                    if eq is not None and hasattr(eq, "to_dict"):
                        out["equity_metrics"] = {k: (float(v) if isinstance(v, (int, float)) else str(v)) for k, v in eq.iloc[:, 0].to_dict().items() if v is not None}
                except Exception: pass
        except Exception:
            pass
        out["expense_ratio"]  = info.get("annualReportExpenseRatio")
        out["total_assets"]   = info.get("totalAssets")
        out["ytd_return"]     = info.get("ytdReturn")
        out["nav_price"]      = info.get("navPrice")
        out["category"]       = info.get("category")
        return jsonify(out)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/holders/<ticker>")
def api_holders(ticker):
    """Top institutional holders + recent insider activity for a ticker.

    Returns:
      institutional: [{holder, shares, date_reported, value, pct_out}]
      mutual_funds:  [{holder, shares, date_reported, value, pct_out}]
      insider_tx:    [{insider, position, transaction, shares, value, date, ownership}]
      insider_roster:[{name, position, since, ownership, latest_tx_date}]

    Each list is capped at 10 entries to keep the response light. Sourced
    via yfinance — same data Yahoo Finance shows on the Holders tab.
    """
    import yfinance as yf
    ticker = _valid_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker format"}), 400
    out = {"institutional": [], "mutual_funds": [], "insider_tx": [], "insider_roster": []}
    try:
        t = yf.Ticker(ticker)

        def df_to_records(df, max_rows=10):
            try:
                if df is None or getattr(df, "empty", True):
                    return []
                df2 = df.head(max_rows).reset_index()
                # JSON-safe values
                recs = []
                for r in df2.to_dict("records"):
                    safe = {}
                    for k, v in r.items():
                        if hasattr(v, "strftime"):
                            safe[str(k)] = v.strftime("%Y-%m-%d")
                        elif hasattr(v, "item"):
                            try: safe[str(k)] = v.item()
                            except Exception: safe[str(k)] = str(v)
                        else:
                            try:
                                safe[str(k)] = float(v) if isinstance(v, (int, float)) else (str(v) if v is not None else None)
                            except Exception:
                                safe[str(k)] = str(v)
                    recs.append(safe)
                return recs
            except Exception:
                return []

        try: out["institutional"] = df_to_records(t.institutional_holders, 10)
        except Exception: pass
        try: out["mutual_funds"] = df_to_records(t.mutualfund_holders, 10)
        except Exception: pass
        try: out["insider_tx"] = df_to_records(t.insider_transactions, 15)
        except Exception: pass
        try: out["insider_roster"] = df_to_records(t.insider_roster_holders, 10)
        except Exception: pass

        # Add summary stats from .info if available
        try:
            info = t.info or {}
            out["summary"] = {
                "held_insiders": info.get("heldPercentInsiders"),
                "held_institutions": info.get("heldPercentInstitutions"),
                "shares_out": info.get("sharesOutstanding"),
                "float_shares": info.get("floatShares"),
                "short_pct_float": info.get("shortPercentOfFloat"),
            }
        except Exception:
            out["summary"] = {}

        return jsonify(out)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/news/<ticker>")
def api_news_ticker(ticker):
    """Extended per-ticker news feed (up to 15 headlines) for the news-driven
    AI briefing. Lighter-weight than /api/ticker (no price data, no SMAs)
    so it can be re-fetched on its own when the user opens the briefing
    sheet without paying the broker-bundle cost again.

    Each item: {title, publisher, url, published, summary?, thumbnail?}.
    """
    import yfinance as yf
    ticker = _valid_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker format"}), 400
    try:
        t = yf.Ticker(ticker)
        raw_news = []
        try:
            raw_news = t.news or []
        except Exception:
            raw_news = []
        items = []
        for n in raw_news[:15]:
            if not isinstance(n, dict):
                continue
            c = n.get("content") or n
            title = c.get("title") or n.get("title")
            if not title:
                continue
            publisher = None
            if isinstance(c.get("provider"), dict):
                publisher = c["provider"].get("displayName")
            publisher = publisher or n.get("publisher") or c.get("publisher")
            link = None
            if isinstance(c.get("canonicalUrl"), dict):
                link = c["canonicalUrl"].get("url")
            link = link or n.get("link") or c.get("link")
            summary = c.get("summary") or c.get("description") or n.get("summary")
            thumb = None
            if isinstance(c.get("thumbnail"), dict):
                resolutions = c["thumbnail"].get("resolutions") or []
                if resolutions and isinstance(resolutions, list):
                    thumb = resolutions[0].get("url") if isinstance(resolutions[0], dict) else None
            pub_ts = c.get("pubDate") or n.get("providerPublishTime")
            items.append({
                "title": title,
                "publisher": publisher,
                "url": link,
                "published": pub_ts,
                "summary": summary[:280] if isinstance(summary, str) else None,
                "thumbnail": thumb,
            })
        # Best-effort: pull company name + sector for the briefing prompt
        company_name = None; sector = None
        try:
            info = t.info or {}
            company_name = info.get("longName") or info.get("shortName")
            sector = info.get("sector")
        except Exception:
            pass
        return jsonify({
            "ticker": ticker.upper(),
            "name": company_name,
            "sector": sector,
            "news": items,
            "count": len(items),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/peers/<ticker>")
def api_peers(ticker):
    """Find peer tickers — yfinance doesn't expose this directly so we
    do a coarse sector/industry-based pick from a hand-built S&P 500 +
    ETF list. Returns up to 6 peers."""
    import yfinance as yf
    ticker = _valid_ticker(ticker)
    if not ticker:
        return jsonify({"error": "invalid ticker format"}), 400
    try:
        t = yf.Ticker(ticker)
        info = {}
        try: info = t.info or {}
        except Exception: info = {}
        sector   = info.get("sector")
        industry = info.get("industry")
        if not (sector or industry):
            return jsonify({"peers": []})
        # Try the same universe used for scans
        try:
            universe = list(get_universe("stocks"))
        except Exception:
            universe = ["AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","JPM","V","MA","UNH","HD","BAC","XOM","CVX","WMT","PG","JNJ","KO","PEP","DIS","NFLX","CRM","INTC","CSCO","ORCL","ADBE","PYPL","COST","TGT"]
        peers = []
        upper_tk = ticker.upper()
        # Sample only 30 from the universe — full lookups would be too slow
        import random
        sample = random.sample(universe, min(40, len(universe)))
        for pk in sample:
            if pk.upper() == upper_tk:
                continue
            try:
                pi = yf.Ticker(pk).info or {}
                if pi.get("industry") == industry or pi.get("sector") == sector:
                    peers.append({
                        "ticker": pk.upper(),
                        "name": pi.get("longName") or pi.get("shortName") or pk.upper(),
                        "sector": pi.get("sector"),
                        "industry": pi.get("industry"),
                    })
                if len(peers) >= 6:
                    break
            except Exception:
                continue
        return jsonify({"peers": peers, "sector": sector, "industry": industry})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/earnings/batch")
def api_earnings_batch():
    """Batch endpoint: for each ticker, return next upcoming earnings date.
    Used by the watchlist earnings calendar so we can show "AAPL reports
    in 3 days" across the user's whole watchlist in one round-trip.

    Usage: GET /api/earnings/batch?tickers=AAPL,MSFT,GOOG
    Returns: {ticker: {next_earnings: 'YYYY-MM-DD' or null}}
    """
    import yfinance as yf
    tickers_arg = (request.args.get("tickers") or "").strip()
    if not tickers_arg:
        return jsonify({"error": "tickers query param required"}), 400
    tickers = [_valid_ticker(t) for t in tickers_arg.split(",")[:30]]
    tickers = [t for t in tickers if t]
    out = {}
    def lookup(tk):
        try:
            t = yf.Ticker(tk)
            cal = t.calendar
            ed_str = None
            try:
                if cal is not None and hasattr(cal, "get"):
                    ed = cal.get("Earnings Date") if hasattr(cal, "get") else None
                    if ed is not None and len(ed) > 0:
                        d0 = ed[0]
                        ed_str = d0.strftime("%Y-%m-%d") if hasattr(d0, "strftime") else str(d0)
                elif isinstance(cal, dict):
                    ed = cal.get("Earnings Date")
                    if ed and len(ed) > 0:
                        ed_str = ed[0].strftime("%Y-%m-%d") if hasattr(ed[0], "strftime") else str(ed[0])
            except Exception:
                ed_str = None
            return tk, {"next_earnings": ed_str}
        except Exception as e:
            return tk, {"error": str(e)}

    with ThreadPoolExecutor(max_workers=8) as pool:
        for tk, res in pool.map(lookup, tickers):
            out[tk] = res
    return jsonify({"calendar": out})


@app.route("/api/screener")
def api_screener():
    """Stream screener results as SSE. The user picks a preset filter and a
    universe; we walk the universe ticker-by-ticker (threaded) and emit
    'match' events for tickers that pass the filter, plus 'progress' for
    every completion regardless of match.

    Presets (?preset=...):
      value     — trailing P/E <= 15 AND positive earnings growth
      growth    — revenue growth >= 15% AND positive earnings growth
      dividend  — dividend yield >= 3%
      momentum  — price > 50d SMA > 200d SMA AND 40 <= RSI(14) <= 70
      oversold  — price <= 20% off 52w high AND RSI(14) <= 35
      quality   — profit margin >= 20% AND debt/equity <= 50

    Each 'match' event payload: {ticker, name, price, sector, ...key_metric}.
    """
    import yfinance as yf
    preset = (request.args.get("preset") or "value").strip().lower()
    universe_name = request.args.get("universe", "stocks")
    try:
        universe = list(get_universe(universe_name))
    except Exception:
        universe = []
    # Cap to keep response time sane on a free Vercel tier
    universe = universe[:120]

    def sse(event: str, data) -> str:
        return f"event: {event}\ndata: {json.dumps(data)}\n\n"

    def evaluate(tk):
        """Return (passes, payload_dict) for a single ticker."""
        try:
            t = yf.Ticker(tk)
            info = {}
            try: info = t.info or {}
            except Exception: pass
            def _f(k):
                v = info.get(k)
                try: return float(v) if v is not None else None
                except (TypeError, ValueError): return None
            price = _f("regularMarketPrice") or _f("currentPrice")
            pe = _f("trailingPE")
            fpe = _f("forwardPE")
            div = _norm_yield(_f("dividendYield"))
            rg  = _f("revenueGrowth")
            eg  = _f("earningsGrowth")
            pm  = _f("profitMargins")
            de  = _f("debtToEquity")
            mc  = _f("marketCap")
            sector = info.get("sector") if isinstance(info.get("sector"), str) else None
            name = info.get("shortName") or info.get("longName") or tk

            # Need history for momentum / oversold presets
            need_hist = preset in ("momentum", "oversold")
            sma50 = sma200 = rsi = hi52 = None
            if need_hist:
                df = t.history(period="1y", auto_adjust=True)
                if df is not None and not df.empty and len(df) >= 50:
                    closes = [float(x) for x in df["Close"].tolist()]
                    if len(closes) >= 200:
                        sma200 = sum(closes[-200:]) / 200.0
                    sma50 = sum(closes[-50:]) / 50.0
                    hi52 = max(closes)
                    # RSI(14)
                    if len(closes) >= 15:
                        gains = losses = 0.0
                        for i in range(1, 15):
                            d = closes[i] - closes[i-1]
                            if d > 0: gains += d
                            else: losses += -d
                        ag, al = gains / 14, losses / 14
                        for i in range(15, len(closes)):
                            d = closes[i] - closes[i-1]
                            g = d if d > 0 else 0; l = -d if d < 0 else 0
                            ag = (ag * 13 + g) / 14
                            al = (al * 13 + l) / 14
                        rsi = 100.0 if al == 0 else (100 - 100 / (1 + ag/al))
                    if price is None and closes:
                        price = closes[-1]

            passes = False; metric = None; metric_label = None
            if preset == "value":
                passes = pe is not None and 0 < pe <= 15 and (eg is None or eg > 0)
                metric = pe; metric_label = "P/E"
            elif preset == "growth":
                passes = rg is not None and rg >= 0.15 and (eg is None or eg > 0)
                metric = rg; metric_label = "Rev growth"
            elif preset == "dividend":
                passes = div is not None and div >= 0.03
                metric = div; metric_label = "Yield"
            elif preset == "momentum":
                if price and sma50 and sma200 and rsi is not None:
                    passes = price > sma50 > sma200 and 40 <= rsi <= 70
                metric = rsi; metric_label = "RSI"
            elif preset == "oversold":
                if price and hi52 and rsi is not None:
                    off = (hi52 - price) / hi52
                    passes = off >= 0.20 and rsi <= 35
                metric = rsi; metric_label = "RSI"
            elif preset == "quality":
                passes = (pm is not None and pm >= 0.20 and
                          (de is None or de <= 50))
                metric = pm; metric_label = "Profit margin"
            else:
                passes = False

            if not passes:
                return False, None

            return True, {
                "ticker": tk.upper(),
                "name": name,
                "price": price,
                "sector": sector,
                "market_cap": mc,
                "metric": metric,
                "metric_label": metric_label,
                "pe": pe,
                "dividend": div,
                "rev_growth": rg,
                "profit_margin": pm,
            }
        except Exception:
            return False, None

    def stream():
        yield sse("start", {"total": len(universe), "preset": preset, "universe": universe_name})
        completed = 0; matched = 0
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(evaluate, tk) for tk in universe]
            for fut in futures:
                try:
                    passes, payload = fut.result(timeout=30)
                except Exception:
                    passes, payload = False, None
                completed += 1
                if passes and payload:
                    matched += 1
                    yield sse("match", payload)
                yield sse("progress", {"completed": completed, "total": len(universe), "matched": matched})
        yield sse("done", {"completed": completed, "matched": matched})

    return Response(stream(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


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
    tickers = [_valid_ticker(t) for t in tickers_arg.split(",")[:25]]
    tickers = [t for t in tickers if t]
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
    # Vercel sets X-Real-IP to the edge-observed client IP; this is the only
    # header value we trust. X-Forwarded-For's left-most entry is whatever the
    # client sent and is trivially spoofable to defeat the per-IP cap. We
    # intentionally avoid X-Forwarded-For for that reason. Fall back to
    # remote_addr for local dev.
    real = request.headers.get("x-real-ip", "").strip()
    if real:
        return real
    return (request.remote_addr or "0.0.0.0").strip()


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
