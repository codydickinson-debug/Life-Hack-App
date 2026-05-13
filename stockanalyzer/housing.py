"""
Housing-market data + buyer/seller scoring.

Source: Realtor.com Research Data (https://www.realtor.com/research/data/).
Free, public CSVs published monthly. We pull three:

  * National-level snapshot (~1 KB)
  * Metro-level snapshot   (~300 KB)
  * ZIP-level snapshot     (~7 MB, ~28k ZIPs)

Cached to disk under `housing_data/` and refreshed when older than 7
days. Each file's columns include built-in YoY and MoM percent changes
so we don't need our own time-series store.

The verdict combines five signals, each scored -2 .. +2 toward a
seller's-market reading:

  * Pending ratio          — buyers actively transacting?
  * Days on market YoY     — homes selling faster or lingering?
  * Price-reduced share    — sellers cutting prices to move inventory?
  * Price-increased share  — sellers confident enough to raise?
  * Inventory YoY          — supply tightening or piling up?

NOT FINANCIAL ADVICE. Listing data lags actual contracts, doesn't
include off-MLS deals, and varies in quality by ZIP (`quality_flag`).
"""

from __future__ import annotations

import csv
import os
import time
from dataclasses import dataclass, field, asdict
from typing import Optional
from urllib.request import urlopen


# ---------------------------------------------------------------------
# Source URLs and cache config
# ---------------------------------------------------------------------

SOURCES = {
    "zip": "https://econdata.s3-us-west-2.amazonaws.com/Reports/Core/RDC_Inventory_Core_Metrics_Zip.csv",
    "metro": "https://econdata.s3-us-west-2.amazonaws.com/Reports/Core/RDC_Inventory_Core_Metrics_Metro.csv",
    "national": "https://econdata.s3-us-west-2.amazonaws.com/Reports/Core/RDC_Inventory_Core_Metrics_Country.csv",
}

_BUNDLED_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "housing_data")
if os.environ.get("VERCEL"):
    # Vercel filesystem is read-only except /tmp. Seed /tmp from the bundled
    # CSVs once per cold start so refreshes can write back.
    CACHE_DIR = "/tmp/housing_data"
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        import shutil as _shutil
        for _fn in os.listdir(_BUNDLED_DIR):
            _src, _dst = os.path.join(_BUNDLED_DIR, _fn), os.path.join(CACHE_DIR, _fn)
            if not os.path.exists(_dst):
                try: _shutil.copy2(_src, _dst)
                except OSError: pass
    except OSError:
        CACHE_DIR = _BUNDLED_DIR  # read-only fallback
else:
    CACHE_DIR = _BUNDLED_DIR
CACHE_MAX_AGE_SEC = 7 * 24 * 60 * 60  # 7 days


# ---------------------------------------------------------------------
# Cache management
# ---------------------------------------------------------------------

def _cache_path(name: str) -> str:
    return os.path.join(CACHE_DIR, f"{name}.csv")


def is_cached(name: str) -> bool:
    return os.path.exists(_cache_path(name))


def cache_age_sec(name: str) -> Optional[float]:
    p = _cache_path(name)
    if not os.path.exists(p):
        return None
    return time.time() - os.path.getmtime(p)


def is_fresh(name: str) -> bool:
    age = cache_age_sec(name)
    return age is not None and age < CACHE_MAX_AGE_SEC


def download(name: str) -> str:
    """Download a single CSV to cache. Returns the local path."""
    if name not in SOURCES:
        raise ValueError(f"Unknown source: {name}")
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = _cache_path(name)
    tmp = path + ".tmp"
    with urlopen(SOURCES[name], timeout=60) as resp, open(tmp, "wb") as out:
        while True:
            chunk = resp.read(64 * 1024)
            if not chunk:
                break
            out.write(chunk)
    os.replace(tmp, path)
    return path


def ensure_cached(name: str, force: bool = False) -> str:
    """Download if missing or stale (or if force=True)."""
    if force or not is_fresh(name):
        return download(name)
    return _cache_path(name)


# ---------------------------------------------------------------------
# CSV parsing
# ---------------------------------------------------------------------

def _parse_float(v: str) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _parse_int(v: str) -> Optional[int]:
    f = _parse_float(v)
    return int(f) if f is not None else None


def _row_to_metrics(row: dict) -> dict:
    """Coerce a raw CSV row to a typed metrics dict."""
    return {
        "month": row.get("month_date_yyyymm"),
        "median_listing_price": _parse_int(row.get("median_listing_price")),
        "median_listing_price_yy": _parse_float(row.get("median_listing_price_yy")),
        "median_listing_price_mm": _parse_float(row.get("median_listing_price_mm")),
        "median_ppsf": _parse_float(row.get("median_listing_price_per_square_foot")),
        "median_ppsf_yy": _parse_float(row.get("median_listing_price_per_square_foot_yy")),
        "median_dom": _parse_float(row.get("median_days_on_market")),
        "median_dom_yy": _parse_float(row.get("median_days_on_market_yy")),
        "active_listings": _parse_int(row.get("active_listing_count")),
        "active_listings_yy": _parse_float(row.get("active_listing_count_yy")),
        "new_listings": _parse_int(row.get("new_listing_count")),
        "pending_listings": _parse_int(row.get("pending_listing_count")),
        "pending_ratio": _parse_float(row.get("pending_ratio")),
        "price_increased_share": _parse_float(row.get("price_increased_share")),
        "price_reduced_share": _parse_float(row.get("price_reduced_share")),
        "median_sqft": _parse_float(row.get("median_square_feet")),
        "quality_flag": _parse_int(row.get("quality_flag")),
    }


# ---------------------------------------------------------------------
# Verdict scoring
# ---------------------------------------------------------------------

@dataclass
class HousingVerdict:
    label: str                     # "STRONG SELLER" | "SELLER" | "BALANCED" | "BUYER" | "STRONG BUYER"
    score: int                     # -6 .. +6 (positive = seller's market)
    reasons: list[str] = field(default_factory=list)


def score_market(m: dict) -> HousingVerdict:
    """Score a market snapshot. Positive = seller's, negative = buyer's."""
    s = 0
    notes: list[str] = []

    pr = m.get("pending_ratio")
    if pr is not None:
        if pr >= 0.55:
            s += 2; notes.append(f"Pending ratio {pr*100:.0f}% — buyers actively transacting")
        elif pr >= 0.35:
            s += 1; notes.append(f"Pending ratio {pr*100:.0f}% — healthy buyer activity")
        elif pr <= 0.10:
            s -= 2; notes.append(f"Pending ratio {pr*100:.0f}% — very slow conversion")
        elif pr <= 0.20:
            s -= 1; notes.append(f"Pending ratio {pr*100:.0f}% — slow conversion")

    dom_yy = m.get("median_dom_yy")
    if dom_yy is not None:
        if dom_yy <= -0.20:
            s += 1; notes.append(f"Days on market down {abs(dom_yy)*100:.0f}% YoY — homes selling faster")
        elif dom_yy >= 0.20:
            s -= 1; notes.append(f"Days on market up {dom_yy*100:.0f}% YoY — homes lingering")

    prs = m.get("price_reduced_share")
    if prs is not None:
        if prs >= 0.45:
            s -= 2; notes.append(f"{prs*100:.0f}% of listings cut prices — sellers under pressure")
        elif prs >= 0.32:
            s -= 1; notes.append(f"{prs*100:.0f}% of listings cut prices — softening")
        elif prs <= 0.10:
            s += 1; notes.append(f"Only {prs*100:.0f}% of listings cut prices — sellers holding firm")

    pis = m.get("price_increased_share")
    if pis is not None:
        if pis >= 0.10:
            s += 1; notes.append(f"{pis*100:.0f}% of listings raised prices — strong demand")

    inv_yy = m.get("active_listings_yy")
    if inv_yy is not None:
        if inv_yy >= 0.30:
            s -= 1; notes.append(f"Inventory up {inv_yy*100:.0f}% YoY — supply building")
        elif inv_yy <= -0.15:
            s += 1; notes.append(f"Inventory down {abs(inv_yy)*100:.0f}% YoY — supply tightening")

    if s >= 4:
        label = "STRONG SELLER"
    elif s >= 2:
        label = "SELLER"
    elif s <= -4:
        label = "STRONG BUYER"
    elif s <= -2:
        label = "BUYER"
    else:
        label = "BALANCED"

    if not notes:
        notes.append("Insufficient data for confident read")

    return HousingVerdict(label=label, score=s, reasons=notes)


# ---------------------------------------------------------------------
# Public queries
# ---------------------------------------------------------------------

@dataclass
class HousingSnapshot:
    region: str                  # "ZIP 90210" | "Beverly Hills, CA" | "United States"
    region_name: Optional[str]   # "Beverly Hills, CA" (for ZIPs)
    region_type: str             # "zip" | "metro" | "national"
    metrics: dict
    verdict: HousingVerdict
    as_of: Optional[str] = None  # YYYY-MM


def get_zip(zip_code: str) -> Optional[HousingSnapshot]:
    """Look up a single ZIP. Returns None if not in dataset."""
    zip_code = (zip_code or "").strip().zfill(5)
    if not zip_code.isdigit() or len(zip_code) != 5:
        return None
    path = ensure_cached("zip")
    best: Optional[dict] = None
    best_quality = -1
    with open(path, newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            if row.get("postal_code", "").strip().zfill(5) != zip_code:
                continue
            q = _parse_int(row.get("quality_flag")) or 0
            if q > best_quality:
                best = row
                best_quality = q
    if best is None:
        return None
    metrics = _row_to_metrics(best)
    name = best.get("zip_name") or ""
    return HousingSnapshot(
        region=f"ZIP {zip_code}",
        region_name=name.title() if name else None,
        region_type="zip",
        metrics=metrics,
        verdict=score_market(metrics),
        as_of=metrics.get("month"),
    )


def get_national() -> Optional[HousingSnapshot]:
    """National monthly snapshot."""
    path = ensure_cached("national")
    rows: list[dict] = []
    with open(path, newline="") as fh:
        reader = csv.DictReader(fh)
        rows = list(reader)
    if not rows:
        return None
    # Most recent month
    rows.sort(key=lambda r: r.get("month_date_yyyymm", ""), reverse=True)
    row = rows[0]
    metrics = _row_to_metrics(row)
    return HousingSnapshot(
        region="United States",
        region_name="National",
        region_type="national",
        metrics=metrics,
        verdict=score_market(metrics),
        as_of=metrics.get("month"),
    )


def get_metros(top_n: int = 50) -> list[HousingSnapshot]:
    """All metro-level snapshots, scored. Caller can sort/filter."""
    path = ensure_cached("metro")
    out: list[HousingSnapshot] = []
    with open(path, newline="") as fh:
        reader = csv.DictReader(fh)
        # Take the most recent month available per metro
        latest: dict[str, dict] = {}
        for row in reader:
            cbsa = row.get("cbsa_title") or row.get("cbsa_code") or ""
            month = row.get("month_date_yyyymm") or ""
            existing = latest.get(cbsa)
            if existing is None or month > existing.get("month_date_yyyymm", ""):
                latest[cbsa] = row
    for cbsa, row in latest.items():
        metrics = _row_to_metrics(row)
        out.append(HousingSnapshot(
            region=cbsa,
            region_name=cbsa,
            region_type="metro",
            metrics=metrics,
            verdict=score_market(metrics),
            as_of=metrics.get("month"),
        ))
    return out


# ---------------------------------------------------------------------
# Status (used by frontend during cold-start)
# ---------------------------------------------------------------------

def status() -> dict:
    """Report cache state for each dataset."""
    out = {}
    for name in SOURCES:
        out[name] = {
            "cached": is_cached(name),
            "fresh": is_fresh(name),
            "age_sec": cache_age_sec(name),
        }
    out["cache_dir"] = CACHE_DIR
    return out


def snapshot_to_dict(s: HousingSnapshot) -> dict:
    """JSON-serializable representation."""
    return {
        "region": s.region,
        "region_name": s.region_name,
        "region_type": s.region_type,
        "metrics": s.metrics,
        "verdict": asdict(s.verdict),
        "as_of": s.as_of,
    }
