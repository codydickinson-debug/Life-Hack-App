"""
Stock decision engine.

Combines four pillars to make a decision that's actually backed:

  1. QUALITY   — fundamentals (margins, ROE, debt, growth, free cash flow)
  2. VALUE     — current valuation vs. own 5y history and analyst target
  3. TREND     — long-term regime (price vs. 200-day SMA, RS vs SPY) gates everything
  4. MOMENTUM  — short-term entry/exit timing (RSI, MACD, Bollinger, volume)

A buy is only issued when the trend regime is up, the business is at
least decent quality, valuation is not absurd, no earnings within 7
days, and the expected reward-to-risk ratio is >= 1.5:1.

Backtest reports return, Sharpe (excess of risk-free), max drawdown,
win rate, and time in market — flat periods earn the configured RF
rate so cash isn't unfairly counted as 0%.

Usage:
    python analyzer.py AAPL
    python analyzer.py AAPL MSFT NVDA --account 25000
    python analyzer.py AAPL --period 5y --rf 0.045
    python analyzer.py AAPL MSFT GOOGL AMZN NVDA --json out.json --quiet
"""

from __future__ import annotations

import argparse
import json
import sys
import warnings
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from typing import Optional

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import yfinance as yf


# =====================================================================
# Indicators
# =====================================================================

def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    d = s.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def macd(s: pd.Series, fast: int = 12, slow: int = 26, sig: int = 9):
    line = ema(s, fast) - ema(s, slow)
    signal = ema(line, sig)
    return line, signal, line - signal


def bollinger(s: pd.Series, n: int = 20, k: float = 2.0):
    mid = sma(s, n)
    sd = s.rolling(n).std()
    return mid - k * sd, mid, mid + k * sd


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    h, l, c = df["High"], df["Low"], df["Close"]
    pc = c.shift(1)
    tr = pd.concat([(h - l), (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


# =====================================================================
# Fundamentals
# =====================================================================

@dataclass
class Fundamentals:
    pe: Optional[float] = None
    forward_pe: Optional[float] = None
    peg: Optional[float] = None
    pb: Optional[float] = None
    profit_margin: Optional[float] = None
    roe: Optional[float] = None
    debt_to_equity: Optional[float] = None
    revenue_growth: Optional[float] = None
    earnings_growth: Optional[float] = None
    free_cashflow: Optional[float] = None
    market_cap: Optional[float] = None
    analyst_target: Optional[float] = None
    analyst_rec: Optional[float] = None        # 1=strong buy, 5=strong sell
    next_earnings: Optional[datetime] = None
    last_earnings: Optional[datetime] = None
    sector: Optional[str] = None


def fetch_fundamentals(t: yf.Ticker) -> Fundamentals:
    info = {}
    try:
        info = t.info or {}
    except Exception:
        pass

    f = Fundamentals(
        pe=info.get("trailingPE"),
        forward_pe=info.get("forwardPE"),
        peg=info.get("pegRatio"),
        pb=info.get("priceToBook"),
        profit_margin=info.get("profitMargins"),
        roe=info.get("returnOnEquity"),
        debt_to_equity=info.get("debtToEquity"),
        revenue_growth=info.get("revenueGrowth"),
        earnings_growth=info.get("earningsGrowth"),
        free_cashflow=info.get("freeCashflow"),
        market_cap=info.get("marketCap"),
        analyst_target=info.get("targetMeanPrice"),
        analyst_rec=info.get("recommendationMean"),
        sector=info.get("sector"),
    )

    # PEG fallback when yfinance returns null but we have the inputs.
    if f.peg is None and f.forward_pe and f.earnings_growth and f.earnings_growth > 0:
        f.peg = f.forward_pe / (f.earnings_growth * 100)

    try:
        cal = t.calendar
        if cal is not None and isinstance(cal, dict):
            ed = cal.get("Earnings Date")
            if ed:
                dt = pd.Timestamp(ed[0] if isinstance(ed, (list, tuple)) else ed).to_pydatetime()
                if dt > datetime.now():
                    f.next_earnings = dt
                else:
                    f.last_earnings = dt
    except Exception:
        pass
    return f


# =====================================================================
# Pillar scoring
# =====================================================================

@dataclass
class PillarScores:
    quality: int = 0          # -3 .. +3
    value: int = 0            # -3 .. +3
    trend: int = 0            # -3 .. +3
    momentum: int = 0         # -3 .. +3
    quality_notes: list = field(default_factory=list)
    value_notes: list = field(default_factory=list)
    trend_notes: list = field(default_factory=list)
    momentum_notes: list = field(default_factory=list)
    warnings: list = field(default_factory=list)


def score_quality(f: Fundamentals) -> tuple[int, list[str]]:
    s = 0
    notes = []
    if f.profit_margin is not None:
        if f.profit_margin > 0.20:
            s += 1; notes.append(f"Profit margin {f.profit_margin*100:.1f}% — excellent")
        elif f.profit_margin > 0.10:
            notes.append(f"Profit margin {f.profit_margin*100:.1f}% — solid")
        elif f.profit_margin > 0:
            notes.append(f"Profit margin {f.profit_margin*100:.1f}% — thin")
        else:
            s -= 1; notes.append(f"Profit margin {f.profit_margin*100:.1f}% — unprofitable")

    if f.roe is not None:
        if f.roe > 0.80:
            s += 1; notes.append(f"ROE {f.roe*100:.0f}% — extremely high (likely buyback/leverage distorted; treat as 'excellent')")
        elif f.roe > 0.20:
            s += 1; notes.append(f"ROE {f.roe*100:.1f}% — high return on capital")
        elif f.roe > 0.10:
            notes.append(f"ROE {f.roe*100:.1f}% — adequate")
        elif f.roe < 0:
            s -= 1; notes.append(f"ROE {f.roe*100:.1f}% — destroying capital")

    if f.debt_to_equity is not None:
        de = f.debt_to_equity / 100  # yfinance returns percentage form
        if de < 0.5:
            s += 1; notes.append(f"D/E {de:.2f} — clean balance sheet")
        elif de > 2.0:
            s -= 1; notes.append(f"D/E {de:.2f} — heavily leveraged")

    if f.revenue_growth is not None:
        if f.revenue_growth > 0.15:
            s += 1; notes.append(f"Revenue growth {f.revenue_growth*100:.1f}% YoY — fast growing")
        elif f.revenue_growth < 0:
            s -= 1; notes.append(f"Revenue growth {f.revenue_growth*100:.1f}% YoY — shrinking")

    if f.free_cashflow is not None and f.market_cap is not None and f.market_cap > 0:
        fcf_yield = f.free_cashflow / f.market_cap
        if fcf_yield > 0.05:
            s += 1; notes.append(f"FCF yield {fcf_yield*100:.1f}% — cash machine")
        elif fcf_yield < 0:
            s -= 1; notes.append(f"FCF yield {fcf_yield*100:.1f}% — burns cash")

    if not notes:
        notes.append("No fundamentals available — quality unknown")
    return int(np.clip(s, -3, 3)), notes


def score_value(f: Fundamentals, price: float, hist: pd.Series) -> tuple[int, list[str]]:
    s = 0
    notes = []

    if f.forward_pe is not None and f.forward_pe > 0:
        if f.forward_pe < 15:
            s += 1; notes.append(f"Forward P/E {f.forward_pe:.1f} — cheap")
        elif f.forward_pe < 25:
            notes.append(f"Forward P/E {f.forward_pe:.1f} — fair")
        elif f.forward_pe < 40:
            s -= 1; notes.append(f"Forward P/E {f.forward_pe:.1f} — expensive")
        else:
            s -= 2; notes.append(f"Forward P/E {f.forward_pe:.1f} — extremely expensive")

    if f.peg is not None and f.peg > 0:
        if f.peg < 1.0:
            s += 1; notes.append(f"PEG {f.peg:.2f} — growth not priced in")
        elif f.peg > 2.5:
            s -= 1; notes.append(f"PEG {f.peg:.2f} — paying steep premium for growth")

    if f.analyst_target is not None and f.analyst_target > 0:
        upside = (f.analyst_target - price) / price
        if upside > 0.20:
            s += 1; notes.append(f"Analyst target ${f.analyst_target:.2f} — {upside*100:+.1f}% upside")
        elif upside < -0.10:
            s -= 1; notes.append(f"Analyst target ${f.analyst_target:.2f} — {upside*100:+.1f}% (overshot)")
        else:
            notes.append(f"Analyst target ${f.analyst_target:.2f} — {upside*100:+.1f}%")

    if f.analyst_rec is not None:
        if f.analyst_rec <= 2.0:
            s += 1; notes.append(f"Analyst consensus {f.analyst_rec:.1f}/5 — buy")
        elif f.analyst_rec >= 3.5:
            s -= 1; notes.append(f"Analyst consensus {f.analyst_rec:.1f}/5 — sell")

    if len(hist) > 250:
        pct = float((hist <= price).mean())
        if pct < 0.25:
            s += 1; notes.append(f"Price at {pct*100:.0f}th percentile of 5y range — historically cheap")
        elif pct > 0.90:
            s -= 1; notes.append(f"Price at {pct*100:.0f}th percentile of 5y range — near 5y highs")

    if not notes:
        notes.append("No valuation data available")
    return int(np.clip(s, -3, 3)), notes


def score_trend(df: pd.DataFrame,
                spy_3mo: Optional[float] = None,
                stock_3mo: Optional[float] = None) -> tuple[int, list[str]]:
    s = 0
    notes = []
    last = df.iloc[-1]
    price = float(last["Close"])

    sma50 = float(last["sma50"]) if not np.isnan(last["sma50"]) else None
    sma200 = float(last["sma200"]) if "sma200" in df.columns and not np.isnan(last["sma200"]) else None

    if sma200 is not None:
        if price > sma200:
            s += 2; notes.append(f"Price ${price:.2f} above 200d SMA ${sma200:.2f} — long-term UPTREND")
        else:
            s -= 2; notes.append(f"Price ${price:.2f} below 200d SMA ${sma200:.2f} — long-term DOWNTREND (bear regime)")
        if len(df) > 21:
            sma200_slope = (df["sma200"].iloc[-1] - df["sma200"].iloc[-21]) / df["sma200"].iloc[-21]
            if sma200_slope > 0.01:
                s += 1; notes.append(f"200d SMA rising {sma200_slope*100:+.1f}% over last month")
            elif sma200_slope < -0.01:
                s -= 1; notes.append(f"200d SMA falling {sma200_slope*100:+.1f}% over last month")
        if sma50 is not None:
            if sma50 > sma200:
                notes.append(f"50d SMA ${sma50:.2f} above 200d — golden-cross territory")
            else:
                notes.append(f"50d SMA ${sma50:.2f} below 200d — death-cross territory")
    elif sma50 is not None:
        # Short-timeframe fallback when 200d SMA isn't available (1y window etc.)
        notes.append("(short window — 200d SMA unavailable; using 50d as trend proxy)")
        if price > sma50:
            s += 2; notes.append(f"Price ${price:.2f} above 50d SMA ${sma50:.2f} — short-term UPTREND")
        else:
            s -= 2; notes.append(f"Price ${price:.2f} below 50d SMA ${sma50:.2f} — short-term DOWNTREND")
        if len(df) > 21:
            sma50_slope = (df["sma50"].iloc[-1] - df["sma50"].iloc[-21]) / df["sma50"].iloc[-21]
            if sma50_slope > 0.02:
                s += 1; notes.append(f"50d SMA rising {sma50_slope*100:+.1f}%/month")
            elif sma50_slope < -0.02:
                s -= 1; notes.append(f"50d SMA falling {sma50_slope*100:+.1f}%/month")

    # Relative strength vs SPY (3-month) — leadership signal.
    if spy_3mo is not None and stock_3mo is not None:
        rs = stock_3mo - spy_3mo
        if rs > 0.05:
            s += 1; notes.append(f"3mo return {stock_3mo*100:+.1f}% vs SPY {spy_3mo*100:+.1f}% — leading market")
        elif rs < -0.05:
            s -= 1; notes.append(f"3mo return {stock_3mo*100:+.1f}% vs SPY {spy_3mo*100:+.1f}% — lagging market")

    return int(np.clip(s, -3, 3)), notes


def score_momentum(df: pd.DataFrame) -> tuple[int, list[str]]:
    s = 0
    notes = []
    last = df.iloc[-1]
    prev = df.iloc[-2]
    price = float(last["Close"])

    rsi_v = float(last["rsi"])
    if rsi_v < 30:
        s += 2; notes.append(f"RSI {rsi_v:.1f} — oversold bounce setup")
    elif rsi_v < 45:
        s += 1; notes.append(f"RSI {rsi_v:.1f} — leaning oversold")
    elif rsi_v > 75:
        s -= 2; notes.append(f"RSI {rsi_v:.1f} — extremely overbought")
    elif rsi_v > 60:
        s -= 1; notes.append(f"RSI {rsi_v:.1f} — overbought")
    else:
        notes.append(f"RSI {rsi_v:.1f} — neutral")

    cu = prev["macd"] <= prev["macd_sig"] and last["macd"] > last["macd_sig"]
    cd = prev["macd"] >= prev["macd_sig"] and last["macd"] < last["macd_sig"]
    if cu:
        s += 2; notes.append("MACD just crossed ABOVE signal — fresh bullish momentum")
    elif cd:
        s -= 2; notes.append("MACD just crossed BELOW signal — fresh bearish momentum")
    elif last["macd"] > last["macd_sig"]:
        s += 1; notes.append("MACD above signal — momentum positive")
    else:
        s -= 1; notes.append("MACD below signal — momentum negative")

    if price < last["bb_lo"]:
        s += 1; notes.append(f"Below lower Bollinger ${last['bb_lo']:.2f} — stretched")
    elif price > last["bb_hi"]:
        s -= 1; notes.append(f"Above upper Bollinger ${last['bb_hi']:.2f} — stretched")

    # 5-day average vs 50-day — robust to intraday partial bars (today's
    # bar would otherwise read as low volume just because the day isn't done).
    if len(df) >= 50:
        vol_5d = float(df["Volume"].iloc[-5:].mean())
        vol_50d = float(df["Volume"].iloc[-50:].mean())
        if vol_50d > 0:
            vol_ratio = vol_5d / vol_50d
            if vol_ratio > 1.5:
                s += 1; notes.append(f"5d avg volume {vol_ratio:.1f}x 50d avg — strong participation")
            elif vol_ratio < 0.6:
                notes.append(f"5d avg volume {vol_ratio:.1f}x 50d avg — thin participation")

    return int(np.clip(s, -3, 3)), notes


# =====================================================================
# Decision engine
# =====================================================================

@dataclass
class Decision:
    ticker: str
    price: float
    verdict: str
    composite: int
    pillars: PillarScores
    fundamentals: Fundamentals
    entry_zone: tuple[float, float]
    stop_loss: float
    take_profit: float
    risk_reward: float
    shares_to_buy: int
    dollar_risk: float
    backtest: dict
    why: str = ""
    chart: dict = field(default_factory=dict)
    projections: dict = field(default_factory=dict)


def compute_drift_vol(close: pd.Series, lookback: int = 60) -> tuple[float, float]:
    """Daily log-return drift (μ) and stdev (σ) over the last `lookback` bars."""
    log_ret = np.log(close / close.shift(1)).dropna().tail(lookback)
    if len(log_ret) >= 5:
        return float(log_ret.mean()), float(log_ret.std() or 0.01)
    return 0.0, 0.01


def compute_projections(price: float, shares: int, mu: float, sigma: float,
                          stop_loss: float, take_profit: float,
                          horizons: tuple = (30, 60, 90, 180),
                          n_sims: int = 3000, seed: int = 42) -> dict:
    """P&L projections at multiple horizons under GBM.

    Returns per-horizon dict with: median dollar P&L, 50% / 80% ranges in
    dollars, probability of profit, and Monte Carlo first-passage
    probabilities (P(TP first), P(SL first), P(neither) within horizon).
    """
    from math import erf, sqrt
    if shares < 1:
        # Use 1 share so projection still shows directional dollar values
        shares = 1
    if sigma <= 0:
        sigma = 0.01

    rng = np.random.default_rng(seed)
    max_h = max(horizons)
    increments = rng.normal(mu, sigma, size=(n_sims, max_h))
    log_paths = np.log(price) + np.cumsum(increments, axis=1)

    log_tp = np.log(max(take_profit, 1e-3))
    log_sl = np.log(max(stop_loss, 1e-3))

    # SL must be below entry, TP above for a long. If reversed (sell-side),
    # swap so the math still works but flip semantics in label.
    is_long = take_profit > stop_loss

    if is_long:
        first_tp = np.where((log_paths >= log_tp).any(axis=1),
                            (log_paths >= log_tp).argmax(axis=1), max_h + 1)
        first_sl = np.where((log_paths <= log_sl).any(axis=1),
                            (log_paths <= log_sl).argmax(axis=1), max_h + 1)
    else:
        first_tp = np.where((log_paths <= log_tp).any(axis=1),
                            (log_paths <= log_tp).argmax(axis=1), max_h + 1)
        first_sl = np.where((log_paths >= log_sl).any(axis=1),
                            (log_paths >= log_sl).argmax(axis=1), max_h + 1)

    out = {}
    for h in horizons:
        sd = sigma * np.sqrt(h)
        median_price = price * np.exp(mu * h)
        lo80_p = price * np.exp(mu * h - 1.28 * sd)
        hi80_p = price * np.exp(mu * h + 1.28 * sd)
        lo50_p = price * np.exp(mu * h - 0.67 * sd)
        hi50_p = price * np.exp(mu * h + 0.67 * sd)

        tp_first = ((first_tp < first_sl) & (first_tp < h)).sum()
        sl_first = ((first_sl < first_tp) & (first_sl < h)).sum()
        neither = ((first_tp >= h) & (first_sl >= h)).sum()

        # P(profit at horizon h): P(price > current) under GBM with drift mu
        z = (mu * h) / sd if sd > 0 else 0.0
        p_profit = 0.5 * (1 + erf(z / sqrt(2)))

        out[f"{h}d"] = {
            "horizon_days": h,
            "median_price": float(median_price),
            "median_pnl": float((median_price - price) * shares),
            "median_pnl_pct": float((median_price / price - 1) * 100),
            "lo50_pnl": float((lo50_p - price) * shares),
            "hi50_pnl": float((hi50_p - price) * shares),
            "lo80_pnl": float((lo80_p - price) * shares),
            "hi80_pnl": float((hi80_p - price) * shares),
            "lo50_price": float(lo50_p),
            "hi50_price": float(hi50_p),
            "lo80_price": float(lo80_p),
            "hi80_price": float(hi80_p),
            "p_profit": float(p_profit),
            "p_hit_tp_first": float(tp_first / n_sims),
            "p_hit_sl_first": float(sl_first / n_sims),
            "p_neither": float(neither / n_sims),
            "investment": float(shares * price),
            "shares": int(shares),
            "is_long": bool(is_long),
        }
    return out


def build_chart_data(df: pd.DataFrame, stop_loss: float, take_profit: float,
                      entry_zone: tuple[float, float], shares: int) -> dict:
    """Last 252 trading days of history + 60-day GBM projection cone.

    The projection is geometric Brownian motion using the last 60 days'
    log-return mean (drift) and stdev (volatility). Two confidence
    bands: 50% (±0.67σ√t) inner, 80% (±1.28σ√t) outer.

    This is NOT a forecast — it's a probabilistic range based on recent
    behavior. Honest visualization, no fake AI predictions.
    """
    n = min(252, len(df))
    tail = df.iloc[-n:].copy()

    def col(name):
        return [None if pd.isna(v) else float(v) for v in tail[name]]

    dates = [d.strftime("%Y-%m-%d") for d in tail.index]

    # Projection (60 calendar days, daily granularity)
    last_close = float(tail["Close"].iloc[-1])
    log_ret = np.log(tail["Close"] / tail["Close"].shift(1)).dropna().tail(60)
    if len(log_ret) >= 5:
        mu = float(log_ret.mean())
        sigma = float(log_ret.std())
    else:
        mu, sigma = 0.0, 0.01

    n_proj = 60
    last_date = tail.index[-1]
    proj_dates, proj_mid, proj_lo80, proj_hi80, proj_lo50, proj_hi50 = [], [], [], [], [], []
    for i in range(1, n_proj + 1):
        # Approximate trading-day step (skip weekends): ~5/7 calendar days
        step_days = int(round(i * 7 / 5))
        d = last_date + pd.Timedelta(days=step_days)
        proj_dates.append(d.strftime("%Y-%m-%d"))
        sd = sigma * np.sqrt(i)
        proj_mid.append(float(last_close * np.exp(mu * i)))
        proj_hi80.append(float(last_close * np.exp(mu * i + 1.28 * sd)))
        proj_lo80.append(float(last_close * np.exp(mu * i - 1.28 * sd)))
        proj_hi50.append(float(last_close * np.exp(mu * i + 0.67 * sd)))
        proj_lo50.append(float(last_close * np.exp(mu * i - 0.67 * sd)))

    # Annualized expected return / volatility for label
    ann_drift = mu * 252
    ann_vol = sigma * np.sqrt(252)

    return {
        "dates": dates,
        "close": col("Close"),
        "sma20": col("sma20"),
        "sma50": col("sma50"),
        "sma200": col("sma200") if "sma200" in tail.columns else [None] * len(dates),
        "proj_dates": proj_dates,
        "proj_mid": proj_mid,
        "proj_lo80": proj_lo80,
        "proj_hi80": proj_hi80,
        "proj_lo50": proj_lo50,
        "proj_hi50": proj_hi50,
        "stop_loss": stop_loss,
        "take_profit": take_profit,
        "entry_lo": entry_zone[0],
        "entry_hi": entry_zone[1],
        "shares": shares,
        "annual_drift_pct": ann_drift * 100,
        "annual_vol_pct": ann_vol * 100,
    }


YF_PERIODS = {"1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"}


def _fetch_history(t: yf.Ticker, period: str) -> pd.DataFrame:
    """Fetch history. yfinance only supports a fixed set of period strings;
    translate anything else (e.g. '3y', '7y') into an explicit start date."""
    if period in YF_PERIODS:
        return t.history(period=period, auto_adjust=True)
    import re
    m = re.fullmatch(r"(\d+)y", period)
    if m:
        years = int(m.group(1))
        start = datetime.now() - timedelta(days=int(365.25 * years))
        return t.history(start=start.strftime("%Y-%m-%d"), auto_adjust=True)
    m = re.fullmatch(r"(\d+)mo", period)
    if m:
        months = int(m.group(1))
        start = datetime.now() - timedelta(days=int(30.5 * months))
        return t.history(start=start.strftime("%Y-%m-%d"), auto_adjust=True)
    return t.history(period="5y", auto_adjust=True)


# Cache SPY 3-month return once per process so concurrent decide() calls
# don't each hit the network.
_SPY_3MO: Optional[float] = None


def get_spy_3mo() -> Optional[float]:
    global _SPY_3MO
    if _SPY_3MO is not None:
        return _SPY_3MO
    try:
        spy = yf.Ticker("SPY").history(period="6mo", auto_adjust=True)
        if isinstance(spy.columns, pd.MultiIndex):
            spy.columns = spy.columns.get_level_values(0)
        if len(spy) >= 63:
            _SPY_3MO = float(spy["Close"].iloc[-1] / spy["Close"].iloc[-63] - 1)
    except Exception:
        pass
    return _SPY_3MO


def summarize_why(verdict: str, p: PillarScores) -> str:
    """One-line summary of the strongest drivers behind the verdict."""
    drivers: list[str] = []
    if verdict in ("STRONG BUY", "BUY"):
        if p.trend >= 2:
            drivers.append("uptrend regime")
        if p.quality >= 2:
            drivers.append("strong fundamentals")
        if p.value >= 1:
            drivers.append("reasonable valuation")
        if p.momentum >= 2:
            drivers.append("fresh momentum")
        if not drivers:
            drivers.append("composite tipped positive")
    elif verdict in ("STRONG SELL", "SELL"):
        if p.trend <= -2:
            drivers.append("downtrend regime")
        if p.quality <= -1:
            drivers.append("weak fundamentals")
        if p.momentum <= -2:
            drivers.append("breaking momentum")
        if p.value <= -2:
            drivers.append("priced for perfection")
        if not drivers:
            drivers.append("multiple negative pillars")
    else:  # HOLD
        # Suppression-driven HOLDs are the most informative — surface those first.
        for w in p.warnings:
            if "R:R only" in w:
                return "long signal suppressed — risk:reward too tight (price near analyst target)"
            if "trend is down" in w:
                return "long signal suppressed — long-term trend is down"
        if p.trend < 0 and p.value > 0:
            drivers.append("cheap but bear regime — wait for trend to turn")
        elif p.trend < 0:
            drivers.append("trend gate (price below 200d)")
        elif p.momentum > 0 and p.value < 0:
            drivers.append("good momentum but stretched valuation")
        elif p.quality > 0 and p.trend > 0 and p.value < 0:
            drivers.append("good company but stretched price — wait for pullback")
        else:
            drivers.append("no edge — pillars mixed")
    return " + ".join(drivers)


def decide(ticker: str, period: str = "5y", account_size: float = 10000.0,
           rf_annual: float = 0.045) -> Optional[Decision]:
    t = yf.Ticker(ticker)
    df = _fetch_history(t, period)
    if df is None or df.empty or len(df) < 60:
        return None
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    close = df["Close"].astype(float)

    df["sma20"] = sma(close, 20)
    df["sma50"] = sma(close, 50)
    df["sma200"] = sma(close, 200)
    df["rsi"] = rsi(close)
    df["macd"], df["macd_sig"], df["macd_hist"] = macd(close)
    df["bb_lo"], df["bb_mid"], df["bb_hi"] = bollinger(close)
    df["atr"] = atr(df)

    f = fetch_fundamentals(t)
    price = float(close.iloc[-1])

    # 3-month relative strength vs SPY for the trend pillar.
    spy_3mo = get_spy_3mo()
    stock_3mo = float(close.iloc[-1] / close.iloc[-63] - 1) if len(close) >= 63 else None

    p = PillarScores()
    p.quality, p.quality_notes = score_quality(f)
    p.value, p.value_notes = score_value(f, price, close)
    p.trend, p.trend_notes = score_trend(df, spy_3mo, stock_3mo)
    p.momentum, p.momentum_notes = score_momentum(df)

    # Earnings-proximity guard
    if f.next_earnings:
        days = (f.next_earnings - datetime.now()).days
        if 0 <= days <= 7:
            p.warnings.append(f"Earnings in {days} days ({f.next_earnings:%Y-%m-%d}) — binary event risk")
    if f.last_earnings:
        days = (datetime.now() - f.last_earnings).days
        if 0 <= days <= 3:
            p.warnings.append(f"Earnings posted {days} days ago ({f.last_earnings:%Y-%m-%d}) — news flow may still move price")

    # Weighted composite. Trend dominates because regime > all.
    composite = (
        p.quality * 1.0
        + p.value * 1.2
        + p.trend * 1.5
        + p.momentum * 0.8
    )

    in_uptrend = p.trend > 0
    has_warning = any("Earnings in" in w for w in p.warnings)

    # ATR-based stop. TP candidate is the closer of (4*ATR target, analyst target)
    # so that R:R reflects reality instead of being tautologically 2:1.
    last_atr = float(df["atr"].iloc[-1])
    stop_dist = 2.0 * last_atr
    atr_target = price + 4.0 * last_atr
    if f.analyst_target and f.analyst_target > price:
        take_profit = min(atr_target, f.analyst_target)
    else:
        take_profit = atr_target
    target_dist = take_profit - price
    stop_loss = price - stop_dist
    risk_reward = (target_dist / stop_dist) if stop_dist > 0 else 0.0

    # Verdict logic — gated, not just score-based
    if composite >= 5 and in_uptrend and not has_warning and p.quality >= 0:
        verdict = "STRONG BUY"
    elif composite >= 2.5 and in_uptrend and p.quality >= -1:
        verdict = "BUY"
    elif composite <= -5:
        verdict = "STRONG SELL"
    elif composite <= -2.5:
        verdict = "SELL"
    else:
        verdict = "HOLD"

    # Trend regime is a HARD GATE for longs.
    if verdict in ("BUY", "STRONG BUY") and not in_uptrend:
        verdict = "HOLD"
        p.warnings.append("Long signal suppressed: long-term trend is down. Wait for price to reclaim 200d SMA.")

    # R:R gate — don't fire BUY when reward isn't worth the risk.
    if verdict in ("BUY", "STRONG BUY") and risk_reward < 1.5:
        verdict = "HOLD"
        p.warnings.append(
            f"Long signal suppressed: R:R only {risk_reward:.1f}:1 (need >= 1.5). "
            "Either price is near analyst target or ATR is elevated."
        )

    if verdict in ("SELL", "STRONG SELL"):
        stop_loss = price + stop_dist
        take_profit = price - 4.0 * last_atr
        target_dist = price - take_profit
        risk_reward = (target_dist / stop_dist) if stop_dist > 0 else 0.0

    # Position sizing: risk 1% of account on the trade
    risk_per_share = abs(price - stop_loss)
    dollar_risk = account_size * 0.01
    shares = int(dollar_risk / risk_per_share) if risk_per_share > 0 else 0
    if shares * price > account_size * 0.25:  # cap any single position at 25% of account
        shares = int((account_size * 0.25) / price)

    # Anchor BUY zone to 20d SMA when it's within 3% of price (real support);
    # otherwise default to a 1% pullback band.
    sma20_v = float(df["sma20"].iloc[-1]) if not np.isnan(df["sma20"].iloc[-1]) else price
    if verdict in ("BUY", "STRONG BUY"):
        if sma20_v < price and (price - sma20_v) / price < 0.03:
            lower = sma20_v
        else:
            lower = price * 0.99
        entry_zone = (lower, price * 1.005)
    elif verdict in ("SELL", "STRONG SELL"):
        entry_zone = (price * 0.995, price * 1.01)
    else:
        entry_zone = (price * 0.97, price * 1.03)

    bt = backtest(df, rf_annual=rf_annual)
    chart = build_chart_data(df, stop_loss, take_profit, entry_zone, shares)
    mu, sigma = compute_drift_vol(close)
    projections = compute_projections(price, shares, mu, sigma, stop_loss, take_profit)
    why = summarize_why(verdict, p)

    return Decision(
        ticker=ticker.upper(),
        price=price,
        verdict=verdict,
        composite=int(round(composite)),
        pillars=p,
        fundamentals=f,
        entry_zone=entry_zone,
        stop_loss=stop_loss,
        take_profit=take_profit,
        risk_reward=risk_reward,
        shares_to_buy=shares,
        dollar_risk=shares * risk_per_share,
        backtest=bt,
        why=why,
        chart=chart,
        projections=projections,
    )


# =====================================================================
# Backtest with costs and risk metrics
# =====================================================================

def backtest(df: pd.DataFrame, cost_bps: float = 10.0, rf_annual: float = 0.045) -> dict:
    """
    Trend-following strategy:
      LONG when price > 200d SMA AND SMA20 > SMA50 AND MACD > signal AND RSI < 70.
      Falls back to (price > SMA50) when 200d SMA isn't available (short windows).
      Otherwise CASH earning the risk-free rate (so flat periods aren't 0%).
      cost_bps round-trip cost on each entry/exit.
    Reports total return, annualized Sharpe (excess of RF), max drawdown,
    win rate, time in market, and edge vs. buy-and-hold.
    """
    has_200 = df["sma200"].notna().any()
    cols = ["sma20", "sma50", "macd", "macd_sig", "rsi"] + (["sma200"] if has_200 else [])
    d = df.dropna(subset=cols).copy()
    if d.empty or len(d) < 30:
        return {"error": "insufficient data"}

    if has_200:
        regime = d["Close"] > d["sma200"]
    else:
        regime = d["Close"] > d["sma50"]
    long_ = (
        regime
        & (d["sma20"] > d["sma50"])
        & (d["macd"] > d["macd_sig"])
        & (d["rsi"] < 70)
    )
    pos = long_.shift(1).fillna(False).astype(int)
    ret = d["Close"].pct_change().fillna(0)

    cost = cost_bps / 10000.0
    rf_daily = (1 + rf_annual) ** (1.0 / 252.0) - 1.0
    trades = pos.diff().abs().fillna(pos.iloc[0])
    # Long: stock return. Flat: RF. Pay cost on transitions.
    strat_ret = pos * ret + (1 - pos) * rf_daily - trades * cost

    equity = (1 + strat_ret).cumprod()
    bh_equity = (1 + ret).cumprod()

    total_ret = float(equity.iloc[-1] - 1)
    bh_ret = float(bh_equity.iloc[-1] - 1)

    if strat_ret.std() > 0:
        sharpe = float((strat_ret.mean() - rf_daily) / strat_ret.std() * np.sqrt(252))
    else:
        sharpe = 0.0

    peak = equity.cummax()
    dd = (equity / peak - 1).min()

    trade_starts = pos.diff() == 1
    trade_ends = pos.diff() == -1
    starts = d.index[trade_starts]
    ends = d.index[trade_ends]
    if len(ends) < len(starts):
        ends = list(ends) + [d.index[-1]]
    trades_pnl = []
    for s_, e_ in zip(starts, ends):
        if s_ in d.index and e_ in d.index:
            trades_pnl.append(d.loc[e_, "Close"] / d.loc[s_, "Close"] - 1)
    win_rate = float(np.mean([1 if x > 0 else 0 for x in trades_pnl])) if trades_pnl else 0.0

    return {
        "strategy_return": total_ret,
        "buyhold_return": bh_ret,
        "sharpe": sharpe,
        "max_drawdown": float(dd),
        "win_rate": win_rate,
        "num_trades": len(trades_pnl),
        "years": len(d) / 252,
        "pct_in_market": float(pos.mean()),
    }


# =====================================================================
# Render
# =====================================================================

C = {
    "STRONG BUY":  "\033[92m\033[1m",
    "BUY":         "\033[92m",
    "HOLD":        "\033[93m",
    "SELL":        "\033[91m",
    "STRONG SELL": "\033[91m\033[1m",
}
R = "\033[0m"
DIM = "\033[2m"


def bar(score: int) -> str:
    """Visual bar for -3..+3 score."""
    if score > 0:
        return DIM + "·" * 3 + R + "│" + "█" * score + " " * (3 - score)
    if score < 0:
        return " " * (3 + score) + "█" * (-score) + "│" + DIM + "·" * 3 + R
    return DIM + "·" * 3 + R + "│" + DIM + "·" * 3 + R


def render(d: Decision, rf_annual: float = 0.045) -> str:
    color = C.get(d.verdict, "")
    o = []
    o.append("=" * 70)
    o.append(f"  {d.ticker}  —  ${d.price:,.2f}" + (f"   [{d.fundamentals.sector}]" if d.fundamentals.sector else ""))
    o.append("=" * 70)
    o.append(f"  VERDICT: {color}{d.verdict}{R}    composite {d.composite:+d}")
    if d.why:
        o.append(f"  Why: {d.why}")
    o.append("")
    o.append("  Pillars     [-3 ◄────►  +3]")
    o.append(f"    Quality   {bar(d.pillars.quality)}  ({d.pillars.quality:+d})")
    o.append(f"    Value     {bar(d.pillars.value)}  ({d.pillars.value:+d})")
    o.append(f"    Trend     {bar(d.pillars.trend)}  ({d.pillars.trend:+d})")
    o.append(f"    Momentum  {bar(d.pillars.momentum)}  ({d.pillars.momentum:+d})")
    o.append("")

    def section(title, notes):
        o.append(f"  {title}:")
        for n in notes:
            o.append(f"    • {n}")

    section("Quality (the business)", d.pillars.quality_notes)
    section("Value (the price)", d.pillars.value_notes)
    section("Trend (the regime)", d.pillars.trend_notes)
    section("Momentum (the timing)", d.pillars.momentum_notes)
    o.append("")

    if d.pillars.warnings:
        o.append("  ⚠ Warnings:")
        for w in d.pillars.warnings:
            o.append(f"    • {w}")
        o.append("")

    o.append("  Action plan:")
    if d.verdict in ("BUY", "STRONG BUY"):
        o.append(f"    BUY zone:    ${d.entry_zone[0]:,.2f} – ${d.entry_zone[1]:,.2f}")
        o.append(f"    Stop loss:   ${d.stop_loss:,.2f}   ({(d.stop_loss/d.price-1)*100:+.1f}%)  ← exit if hit")
        o.append(f"    Take profit: ${d.take_profit:,.2f}   ({(d.take_profit/d.price-1)*100:+.1f}%)")
        o.append(f"    Reward:Risk  {d.risk_reward:.1f}:1")
        o.append(f"    Position:    {d.shares_to_buy} shares (~${d.shares_to_buy*d.price:,.0f}, risking ${d.dollar_risk:,.0f} = 1% of account)")
        o.append("    SELL when:   stop hit, MACD crosses below signal, RSI > 75, OR price closes below 50d SMA")
    elif d.verdict in ("SELL", "STRONG SELL"):
        o.append(f"    EXIT now if holding. Zone: ${d.entry_zone[0]:,.2f} – ${d.entry_zone[1]:,.2f}")
        o.append(f"    Re-enter long when: price reclaims 200d SMA AND MACD crosses up AND RSI 30–55")
    else:
        o.append("    HOLD / wait. No edge right now.")
        o.append("    BUY when: trend score turns +, MACD crosses up, RSI 30–55")
        o.append("    SELL when: trend score turns -, MACD crosses down, RSI > 70")
    o.append("")

    bt = d.backtest
    if "error" not in bt:
        o.append(f"  Backtest ({bt['years']:.1f}y, after 10bps costs + {rf_annual*100:.1f}% RF on cash):")
        o.append(f"    Strategy return:  {bt['strategy_return']*100:+.1f}%")
        o.append(f"    Buy & hold:       {bt['buyhold_return']*100:+.1f}%")
        o.append(f"    Sharpe (excess):  {bt['sharpe']:.2f}    {'(good)' if bt['sharpe']>1 else '(weak)' if bt['sharpe']<0.5 else '(ok)'}")
        o.append(f"    Max drawdown:     {bt['max_drawdown']*100:.1f}%")
        o.append(f"    Win rate:         {bt['win_rate']*100:.0f}%  ({bt['num_trades']} trades)")
        if "pct_in_market" in bt:
            o.append(f"    Time in market:   {bt['pct_in_market']*100:.0f}%   (rest earned RF in cash)")
        delta = bt['strategy_return'] - bt['buyhold_return']
        o.append(f"    Edge vs B&H:      {delta*100:+.1f} pts  {'✓ strategy adds value here' if delta > 0 else '✗ buy-and-hold beats it on this name'}")
    o.append("=" * 70)
    return "\n".join(o)


def render_leaderboard(decisions: list[Decision]) -> str:
    """Compact ranked summary across all tickers."""
    decisions = [d for d in decisions if d is not None]
    if not decisions:
        return ""
    decisions = sorted(decisions, key=lambda d: d.composite, reverse=True)
    o = []
    o.append("=" * 92)
    o.append("  RANKED  (composite descending)")
    o.append("=" * 92)
    o.append(f"  {'TICKER':<7} {'PRICE':>10}  {'VERDICT':<11}  {'CMP':>4}  {'Q':>3} {'V':>3} {'T':>3} {'M':>3}  WHY")
    o.append("  " + "-" * 88)
    for d in decisions:
        color = C.get(d.verdict, "")
        verdict_padded = f"{d.verdict:<11}"
        o.append(
            f"  {d.ticker:<7} ${d.price:>9,.2f}  {color}{verdict_padded}{R}  "
            f"{d.composite:>+4d}  "
            f"{d.pillars.quality:>+3d} {d.pillars.value:>+3d} {d.pillars.trend:>+3d} {d.pillars.momentum:>+3d}  "
            f"{d.why}"
        )
    o.append("=" * 92)
    return "\n".join(o)


# =====================================================================
# Serialization (CLI --json export; Flask uses asdict() directly)
# =====================================================================

def decision_to_dict(d: Decision) -> dict:
    """JSON-serializable representation of a Decision (CLI export only)."""
    fund = asdict(d.fundamentals)
    fund["next_earnings"] = d.fundamentals.next_earnings.isoformat() if d.fundamentals.next_earnings else None
    fund["last_earnings"] = d.fundamentals.last_earnings.isoformat() if d.fundamentals.last_earnings else None
    return {
        "ticker": d.ticker,
        "price": d.price,
        "verdict": d.verdict,
        "composite": d.composite,
        "why": d.why,
        "pillars": {
            "quality": d.pillars.quality,
            "value": d.pillars.value,
            "trend": d.pillars.trend,
            "momentum": d.pillars.momentum,
            "quality_notes": d.pillars.quality_notes,
            "value_notes": d.pillars.value_notes,
            "trend_notes": d.pillars.trend_notes,
            "momentum_notes": d.pillars.momentum_notes,
            "warnings": d.pillars.warnings,
        },
        "fundamentals": fund,
        "entry_zone": list(d.entry_zone),
        "stop_loss": d.stop_loss,
        "take_profit": d.take_profit,
        "risk_reward": d.risk_reward,
        "shares_to_buy": d.shares_to_buy,
        "dollar_risk": d.dollar_risk,
        "backtest": d.backtest,
        # chart and projections excluded — large and meant for the web UI
        "as_of": datetime.now().isoformat(),
    }


DISCLAIMER = """
  ⚠  EDUCATIONAL TOOL — NOT FINANCIAL ADVICE
  --------------------------------------------------------------------
  This tool combines public technical and fundamental data. It does
  not have insider info, news flow, or macro models. The trend-regime
  filter and risk-sizing make decisions more disciplined, but markets
  surprise. Never risk what you can't afford to lose. Diversify.
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="Stock decision engine.")
    ap.add_argument("tickers", nargs="+")
    ap.add_argument("--period", default="5y", help="History window (e.g. 1y, 2y, 5y, 10y)")
    ap.add_argument("--account", type=float, default=10000.0, help="Account size in USD for position sizing")
    ap.add_argument("--rf", type=float, default=0.045, help="Annual risk-free rate for backtest cash periods (default 0.045 = 4.5%%)")
    ap.add_argument("--json", dest="json_out", default=None, help="Write JSON output to this file path")
    ap.add_argument("--no-disclaimer", action="store_true")
    ap.add_argument("--no-leaderboard", action="store_true")
    ap.add_argument("--quiet", action="store_true", help="Skip per-ticker detail; only print leaderboard")
    args = ap.parse_args()

    print()

    def _safe_decide(tk: str) -> tuple[str, Optional[Decision], Optional[str]]:
        try:
            return (tk, decide(tk, period=args.period, account_size=args.account, rf_annual=args.rf), None)
        except Exception as e:
            return (tk, None, str(e))

    # Concurrent fetches — yfinance is I/O bound so this scales nicely.
    if len(args.tickers) > 1:
        with ThreadPoolExecutor(max_workers=min(8, len(args.tickers))) as ex:
            results = list(ex.map(_safe_decide, args.tickers))
    else:
        results = [_safe_decide(args.tickers[0])]

    decisions: list[Decision] = []
    for tk, d, err in results:
        if err:
            print(f"  {tk}: error — {err}\n")
            continue
        if d is None:
            print(f"  {tk}: no data\n")
            continue
        decisions.append(d)
        if not args.quiet:
            print(render(d, rf_annual=args.rf))
            print()

    if len(decisions) > 1 and not args.no_leaderboard:
        print(render_leaderboard(decisions))
        print()

    if args.json_out:
        with open(args.json_out, "w") as fh:
            json.dump([decision_to_dict(d) for d in decisions], fh, indent=2, default=str)
        print(f"  Wrote JSON for {len(decisions)} ticker(s) to {args.json_out}\n")

    if not args.no_disclaimer:
        print(DISCLAIMER)
    return 0


if __name__ == "__main__":
    sys.exit(main())
