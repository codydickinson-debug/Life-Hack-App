"""
Mortgage rates + payment calculator.

Rate source: FRED (Federal Reserve Bank of St. Louis), Freddie Mac PMMS
weekly averages.
  * MORTGAGE30US — 30-year fixed
  * MORTGAGE15US — 15-year fixed
  * FEDFUNDS     — Fed funds rate (context for rate-direction reads)

Free, no API key required — we pull the public CSV endpoint and cache.
Refreshed weekly.

The rate estimator applies approximate Fannie Mae LLPA-style adjustments
to the current PMMS average — it gets you in the ballpark for a given
FICO + LTV combination but isn't a real rate quote. Real lender pricing
varies by program, point structure, lock period, occupancy, property
type, and a dozen other factors not modeled here.
"""

from __future__ import annotations

import csv
import os
import time
from dataclasses import dataclass
from typing import Optional
from urllib.request import urlopen


# ---------------------------------------------------------------------
# FRED config
# ---------------------------------------------------------------------

SERIES = {
    "30y": "MORTGAGE30US",
    "15y": "MORTGAGE15US",
    "fed": "FEDFUNDS",
}

_BUNDLED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "housing_data")
if os.environ.get("VERCEL"):
    CACHE_DIR = "/tmp/housing_data"
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
    except OSError:
        CACHE_DIR = _BUNDLED_DIR
else:
    CACHE_DIR = _BUNDLED_DIR
CACHE_MAX_AGE_SEC = 7 * 24 * 60 * 60  # 7 days


def _fred_url(series_id: str) -> str:
    return f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"


def _cache_path(name: str) -> str:
    return os.path.join(CACHE_DIR, f"mortgage_{name}.csv")


def _is_fresh(name: str) -> bool:
    p = _cache_path(name)
    if not os.path.exists(p):
        return False
    return (time.time() - os.path.getmtime(p)) < CACHE_MAX_AGE_SEC


def download(name: str) -> str:
    if name not in SERIES:
        raise ValueError(f"Unknown series: {name}")
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = _cache_path(name)
    tmp = path + ".tmp"
    with urlopen(_fred_url(SERIES[name]), timeout=30) as resp, open(tmp, "wb") as out:
        while True:
            chunk = resp.read(64 * 1024)
            if not chunk:
                break
            out.write(chunk)
    os.replace(tmp, path)
    return path


def ensure_cached(name: str, force: bool = False) -> str:
    if force or not _is_fresh(name):
        return download(name)
    return _cache_path(name)


# ---------------------------------------------------------------------
# History parsing
# ---------------------------------------------------------------------

def _read_series(name: str) -> list[tuple[str, float]]:
    """Returns [(YYYY-MM-DD, value)] in chronological order. Skips '.' rows."""
    path = ensure_cached(name)
    out: list[tuple[str, float]] = []
    with open(path, newline="") as fh:
        reader = csv.DictReader(fh)
        # FRED CSVs have columns: observation_date, <SERIES_ID>
        value_col = None
        for col in reader.fieldnames or []:
            if col != "observation_date":
                value_col = col
                break
        if value_col is None:
            return out
        for row in reader:
            d = row.get("observation_date") or ""
            v = row.get(value_col) or ""
            if not d or v in ("", "."):
                continue
            try:
                out.append((d, float(v)))
            except ValueError:
                continue
    return out


def get_current_rates() -> dict:
    """Latest 30y, 15y, fed funds with effective dates."""
    out: dict = {}
    for name in SERIES:
        series = _read_series(name)
        if series:
            d, v = series[-1]
            out[name] = {"date": d, "rate": v}
    return out


def get_history(name: str = "30y", years: int = 5) -> list[dict]:
    """Returns the last `years` of weekly observations as [{date, rate}, ...]."""
    series = _read_series(name)
    if not series:
        return []
    # Filter to last N years
    if series:
        last_date = series[-1][0]
        last_year = int(last_date[:4])
        cutoff_year = last_year - years
        cutoff_str = f"{cutoff_year:04d}-{last_date[5:]}"
        series = [(d, v) for d, v in series if d >= cutoff_str]
    return [{"date": d, "rate": v} for d, v in series]


# ---------------------------------------------------------------------
# Rate estimation (LLPA-style adjustments to the PMMS base)
# ---------------------------------------------------------------------

def estimate_rate(base_rate: float, fico: int, ltv: float, term: int = 30) -> dict:
    """Apply approximate Fannie Mae LLPA adjustments to a PMMS base rate.

    Returns {"rate": <%>, "adjustments": [(label, bps)]} so the UI can
    explain where each adjustment came from.

    NOT a real lender quote. Real pricing depends on hundreds of factors;
    this just lands you in the right neighborhood for "what should I
    expect at my FICO + down payment?"
    """
    adj: list[tuple[str, float]] = []

    # Credit score (rough approximation of LLPA grid)
    if fico >= 780:
        bps = -0.125; adj.append(("FICO 780+ (top tier)", bps))
    elif fico >= 740:
        bps = 0.0
    elif fico >= 720:
        bps = 0.125; adj.append(("FICO 720-739", bps))
    elif fico >= 700:
        bps = 0.250; adj.append(("FICO 700-719", bps))
    elif fico >= 680:
        bps = 0.500; adj.append(("FICO 680-699", bps))
    elif fico >= 660:
        bps = 1.000; adj.append(("FICO 660-679", bps))
    elif fico >= 640:
        bps = 1.500; adj.append(("FICO 640-659", bps))
    elif fico >= 620:
        bps = 2.000; adj.append(("FICO 620-639", bps))
    else:
        bps = 3.000; adj.append(("FICO <620 (likely non-conforming)", bps))
    rate = base_rate + bps

    # LTV
    if ltv <= 0.60:
        ltv_bps = 0.0
    elif ltv <= 0.70:
        ltv_bps = 0.125; adj.append(("LTV 60-70%", ltv_bps))
    elif ltv <= 0.75:
        ltv_bps = 0.250; adj.append(("LTV 70-75%", ltv_bps))
    elif ltv <= 0.80:
        ltv_bps = 0.375; adj.append(("LTV 75-80%", ltv_bps))
    elif ltv <= 0.85:
        ltv_bps = 0.625; adj.append(("LTV 80-85% (PMI required)", ltv_bps))
    elif ltv <= 0.90:
        ltv_bps = 0.875; adj.append(("LTV 85-90% (PMI required)", ltv_bps))
    elif ltv <= 0.95:
        ltv_bps = 1.125; adj.append(("LTV 90-95% (PMI required)", ltv_bps))
    else:
        ltv_bps = 1.500; adj.append(("LTV 95%+ (high PMI)", ltv_bps))
    rate += ltv_bps

    # Term — 15y typically prices ~50-75bps below 30y
    if term == 15:
        adj.append(("15-year term", -0.625))
        rate -= 0.625

    # Floor at something defensible
    rate = max(2.0, rate)

    return {
        "rate": round(rate, 3),
        "base_rate": round(base_rate, 3),
        "term": term,
        "adjustments": [{"label": l, "bps": b} for l, b in adj],
    }


# ---------------------------------------------------------------------
# Payment math
# ---------------------------------------------------------------------

def amortized_pi(principal: float, annual_rate_pct: float, years: int) -> float:
    """Standard amortizing payment formula."""
    if principal <= 0:
        return 0.0
    if annual_rate_pct <= 0:
        return principal / (years * 12)
    r = annual_rate_pct / 100 / 12
    n = years * 12
    return principal * (r * (1 + r) ** n) / ((1 + r) ** n - 1)


def _pmi_annual_pct(fico: int, ltv: float) -> float:
    """Approximate annual PMI cost as % of loan amount.

    PMI is typically required when LTV > 80% on conventional loans and is
    canceled at 78% LTV automatically. Real rates depend on the PMI insurer
    and are often quoted in fractions of a basis point. This is a
    consensus middle-of-road table.
    """
    if ltv <= 0.80:
        return 0.0
    if fico >= 760:
        return 0.30 if ltv <= 0.85 else 0.45 if ltv <= 0.90 else 0.55 if ltv <= 0.95 else 0.85
    if fico >= 720:
        return 0.40 if ltv <= 0.85 else 0.55 if ltv <= 0.90 else 0.75 if ltv <= 0.95 else 1.05
    if fico >= 680:
        return 0.55 if ltv <= 0.85 else 0.75 if ltv <= 0.90 else 1.05 if ltv <= 0.95 else 1.45
    return 0.85 if ltv <= 0.85 else 1.10 if ltv <= 0.90 else 1.50


def compute_payment(home_price: float, down_payment: float, fico: int,
                     term: int = 30,
                     property_tax_pct: float = 1.1,
                     insurance_pct: float = 0.5,
                     hoa_monthly: float = 0.0,
                     base_rate: Optional[float] = None) -> dict:
    """Full monthly housing payment breakdown.

    `base_rate`: if provided, used as the PMMS-equivalent input. Otherwise
    fetched from FRED (latest cached value).
    """
    home_price = max(0.0, float(home_price))
    down_payment = max(0.0, min(home_price, float(down_payment)))
    loan = home_price - down_payment
    ltv = loan / home_price if home_price > 0 else 0.0

    if base_rate is None:
        rates = get_current_rates()
        base_rate = rates.get("30y" if term != 15 else "15y", {}).get("rate")
        if base_rate is None:
            base_rate = 7.0  # Conservative fallback if FRED unreachable
    base_rate = float(base_rate)

    # If user picked 15y, base_rate should be the 15y PMMS — pull it specifically
    if term == 15:
        rates = get_current_rates()
        if "15y" in rates:
            base_rate = rates["15y"]["rate"]

    est = estimate_rate(base_rate, fico, ltv, term)
    rate = est["rate"]

    # Monthly components
    pi = amortized_pi(loan, rate, term)
    tax_monthly = home_price * (property_tax_pct / 100) / 12
    insurance_monthly = home_price * (insurance_pct / 100) / 12
    pmi_pct = _pmi_annual_pct(fico, ltv)
    pmi_monthly = loan * (pmi_pct / 100) / 12
    total = pi + tax_monthly + insurance_monthly + pmi_monthly + hoa_monthly

    n_months = term * 12
    total_paid = pi * n_months
    total_interest = total_paid - loan

    # Affordability quick-look: most lenders cap "PITI / income" at 28-36%
    # so we can surface a "this payment requires X gross income" estimate.
    income_28 = total * 12 / 0.28  # PITI is 28% of gross
    income_36 = total * 12 / 0.36

    return {
        "inputs": {
            "home_price": home_price,
            "down_payment": down_payment,
            "down_payment_pct": (down_payment / home_price) if home_price else 0,
            "fico": fico,
            "term": term,
            "property_tax_pct": property_tax_pct,
            "insurance_pct": insurance_pct,
            "hoa_monthly": hoa_monthly,
        },
        "loan_amount": loan,
        "ltv": ltv,
        "rate": rate,
        "rate_estimate": est,
        "monthly": {
            "principal_interest": pi,
            "property_tax": tax_monthly,
            "insurance": insurance_monthly,
            "pmi": pmi_monthly,
            "hoa": hoa_monthly,
            "total": total,
        },
        "lifetime": {
            "total_paid": total_paid,
            "total_interest": total_interest,
            "n_months": n_months,
        },
        "affordability": {
            "gross_income_at_28": income_28,
            "gross_income_at_36": income_36,
        },
        "pmi_drops_at_loan_balance": loan * 0.78 if pmi_monthly > 0 else None,
    }
