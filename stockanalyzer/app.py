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
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, is_dataclass
from datetime import datetime

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
