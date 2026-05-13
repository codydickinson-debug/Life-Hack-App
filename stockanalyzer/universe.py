"""
Curated scan universes across asset classes.

Sized to stay fast on yfinance and useful for scanning. Each universe
focuses on liquid, well-known names so the analysis engine has data to
work with. Quality and Value pillars are sparse for crypto and bond
ETFs — there Trend and Momentum carry more weight in the composite.
"""

# ---------------------------------------------------------------------
# Universes
# ---------------------------------------------------------------------

_UNIVERSES_RAW = {
    "stocks": [
        # Mega-cap tech / comm
        "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "AVGO", "ORCL",
        "ADBE", "CRM", "CSCO", "INTC", "AMD", "QCOM", "TXN", "IBM",
        "NFLX", "DIS", "CMCSA", "TMUS", "VZ", "T",
        # Software & cloud
        "NOW", "INTU", "AMAT", "PYPL", "PLTR", "UBER",
        # Consumer
        "WMT", "COST", "HD", "LOW", "TGT", "MCD", "SBUX", "NKE", "TJX",
        "PG", "KO", "PEP", "MDLZ", "CL", "MO", "PM",
        # Healthcare
        "UNH", "JNJ", "LLY", "MRK", "ABBV", "PFE", "TMO", "ABT", "DHR",
        "AMGN", "GILD", "BMY", "ISRG", "VRTX", "ELV", "CI", "MDT",
        # Financials
        "JPM", "V", "MA", "BAC", "WFC", "GS", "MS", "C", "BLK", "SCHW",
        "AXP", "SPGI", "ICE", "CME", "CB",
        # Industrials & energy
        "CAT", "GE", "HON", "RTX", "BA", "DE", "UPS", "FDX", "LMT", "UNP",
        "XOM", "CVX", "COP",
        # Auto / EV
        "TSLA", "F", "GM",
    ],

    "reits": [
        # Broad REIT ETFs
        "VNQ", "IYR", "SCHH", "REZ",
        # Industrial / logistics
        "PLD", "STAG", "REXR",
        # Self-storage
        "PSA", "EXR",
        # Cell towers / data centers
        "AMT", "CCI", "SBAC", "EQIX", "DLR",
        # Residential
        "AVB", "EQR", "ESS", "MAA", "CPT", "INVH",
        # Retail / mall
        "SPG", "KIM", "REG", "FRT", "O",
        # Healthcare
        "WELL", "VTR", "DOC",
        # Office / specialty
        "BXP", "ARE", "IRM",
    ],

    "crypto": [
        # Top market cap (yfinance format)
        "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "ADA-USD",
        "AVAX-USD", "DOT-USD", "LINK-USD", "DOGE-USD", "MATIC-USD",
        "LTC-USD", "BCH-USD", "NEAR-USD", "ATOM-USD", "ICP-USD",
        "ARB-USD", "OP-USD", "INJ-USD", "RNDR-USD", "UNI-USD",
        "AAVE-USD", "TIA-USD", "FIL-USD",
    ],

    "international": [
        # Broad international ETFs
        "VEA", "VWO", "EFA", "EEM", "VXUS", "IEMG",
        # Country ETFs
        "EWJ", "FXI", "MCHI", "EWG", "EWU", "INDA", "EWZ",
        "EWC", "EWA", "EWY", "EWT", "EWW", "EZA",
        # Major foreign ADRs
        "BABA", "TSM", "ASML", "NVO", "TM", "SAP",
        "TCEHY", "HSBC", "SHEL", "BP", "AZN", "BHP", "RIO",
    ],

    "etfs": [
        # Broad market
        "SPY", "VOO", "VTI", "QQQ", "QQQM", "DIA", "IWM", "ITOT",
        # Dividend / value
        "VYM", "SCHD", "VIG", "DGRO", "JEPI", "JEPQ", "VTV",
        # Growth
        "VUG", "IWF",
        # Sector SPDRs (full set)
        "XLK", "XLF", "XLV", "XLE", "XLI",
        "XLP", "XLY", "XLU", "XLB", "XLC", "XLRE",
        # Themes / specialty
        "ARKK", "SOXX", "SMH", "IBIT", "GLD", "SLV", "USO",
    ],

    "bonds": [
        # US Treasuries (laddered by duration)
        "BIL", "SHY", "IEF", "TLT", "GOVT",
        # Aggregate / total
        "BND", "AGG",
        # Corporates
        "LQD", "VCIT", "VCSH",
        # High yield
        "HYG", "JNK",
        # Inflation-linked
        "TIP", "VTIP",
        # Munis
        "MUB", "VTEB",
        # International / EM bonds
        "BNDX", "EMB",
    ],
}


# ---------------------------------------------------------------------
# Per-market metadata for the UI
# ---------------------------------------------------------------------

MARKET_META = {
    "stocks": {
        "label": "Stocks",
        "icon": "📈",
        "accent": "#4f8dff",
        "default_period": "5y",
        "lede": "Large-cap US equities across every major sector — tech, healthcare, financials, industrials, consumer, energy, autos. The decision engine runs at full strength here: fundamentals, valuation, trend regime, and momentum each contribute to the composite.",
        "tagline": "Best setups score +5 or higher with R:R ≥ 2:1 and no earnings inside 7 days. The R:R gate alone catches names trading at or above analyst targets.",
    },
    "reits": {
        "label": "Real Estate",
        "icon": "🏢",
        "accent": "#f4a261",
        "default_period": "10y",
        "lede": "REITs and REIT ETFs spanning industrial / logistics, residential, retail, healthcare, data centers, cell towers, and self-storage. Most distribute 90%+ of taxable income — yield is half the return story. A 10-year window captures full interest-rate cycles.",
        "tagline": "The engine reads price only. FFO, occupancy, and dividend yield aren't scored — verify income coverage separately before buying. Valuation pillar is biased here (REITs use FFO, not P/E).",
    },
    "crypto": {
        "label": "Crypto",
        "icon": "₿",
        "accent": "#f7931a",
        "default_period": "2y",
        "lede": "Major spot cryptocurrencies via yfinance USD pairs — BTC, ETH, SOL, plus 20 more across L1s, DeFi, infrastructure, and high-cap memes. Markets are 24/7 with no earnings, balance sheets, or analyst coverage.",
        "tagline": "Quality and Value pillars read empty by design. Treat verdicts as trend-only signals. ATR stops adapt to higher vol but tail risk is real — size positions much smaller than equity ones.",
    },
    "international": {
        "label": "International",
        "icon": "🌍",
        "accent": "#06b6a4",
        "default_period": "5y",
        "lede": "Foreign companies via US-listed ADRs (BABA, TSM, ASML, TM, SAP, NVO) plus single-country ETFs (EWJ, FXI, INDA, EWG, EWZ) and broad international wrappers (VEA, VWO, VXUS). Covers developed and emerging markets.",
        "tagline": "Currency exposure is baked into USD prices — a winning local stock can lose money in dollars when the dollar strengthens. Country ETFs avoid single-stock risk; ADRs preserve upside but inherit governance differences.",
    },
    "etfs": {
        "label": "Index / ETFs",
        "icon": "📊",
        "accent": "#9b6dff",
        "default_period": "10y",
        "lede": "Broad-market trackers (SPY, VTI, QQQ, IWM), the eleven Sector SPDRs, dividend and growth tilts (SCHD, VYM, VUG), plus theme funds (ARKK, SOXX, IBIT, GLD). Use these for rotation or as a default exposure sleeve.",
        "tagline": "Diversified wrappers dilute single-stock fundamentals — trend and momentum dominate. The Sector SPDRs are the cleanest read on where market leadership is rotating.",
    },
    "bonds": {
        "label": "Bonds",
        "icon": "🏦",
        "accent": "#22c55e",
        "default_period": "10y",
        "lede": "Treasury ETFs laddered by duration (BIL → SHY → IEF → TLT), aggregate trackers (BND, AGG), investment-grade (LQD, VCIT) and high-yield (HYG, JNK) corporates, inflation-linked TIPS, munis, and international bonds.",
        "tagline": "Bond prices move inversely to rates. The engine reads price action — a 'downtrend' here usually just means rates are rising, not that the asset is bad. For total return, add coupon income to the price chart in your head.",
    },
}


# ---------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------

UNIVERSES = {
    name: sorted(set(t.strip().upper() for t in tickers if t.strip()))
    for name, tickers in _UNIVERSES_RAW.items()
}


def get_universe(name: str) -> list[str]:
    """Return the ticker list for a market, falling back to stocks if unknown."""
    return UNIVERSES.get((name or "stocks").lower(), UNIVERSES["stocks"])


# Back-compat: callers that imported `UNIVERSE` get the stocks list.
UNIVERSE = UNIVERSES["stocks"]
