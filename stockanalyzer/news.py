"""
News aggregator — pulls RSS feeds from major financial publications,
merges them into a single time-sorted stream.

Sources (all public RSS, no API keys, no scraping):
  * Yahoo Finance     — finance.yahoo.com/news/rssindex
  * WSJ Markets       — feeds.content.dowjones.io/public/rss/RSSMarketsMain
  * CNBC Top News     — cnbc.com/id/100003114/device/rss/rss.html
  * NYT Business      — rss.nytimes.com/services/xml/rss/nyt/Business.xml
  * Bloomberg Markets — feeds.bloomberg.com/markets/news.rss
  * MarketWatch       — feeds.marketwatch.com/marketwatch/topstories
  * Barron's          — barrons.com/feed/rssheadlines
  * Investing.com     — investing.com/rss/news.rss

Cached in-memory for 5 minutes to keep the UI responsive without
hammering the publishers. A failing feed degrades gracefully — the
error is captured in the response so the UI can disclose it, but
the rest of the sources still merge cleanly.
"""

from __future__ import annotations

import html
import re
import threading
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from email.utils import parsedate_to_datetime
from urllib.request import Request, urlopen


# ---------------------------------------------------------------------
# Source registry
# ---------------------------------------------------------------------

SOURCES = [
    {"id": "yahoo",       "name": "Yahoo Finance",     "url": "https://finance.yahoo.com/news/rssindex",                       "color": "#7e22ce"},
    {"id": "wsj",         "name": "WSJ Markets",       "url": "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain",  "color": "#000000"},
    {"id": "cnbc",        "name": "CNBC",              "url": "https://www.cnbc.com/id/100003114/device/rss/rss.html",        "color": "#cc0000"},
    {"id": "nyt",         "name": "NYT Business",      "url": "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml",    "color": "#1a1a1a"},
    {"id": "bloomberg",   "name": "Bloomberg Markets", "url": "https://feeds.bloomberg.com/markets/news.rss",                 "color": "#ff5500"},
    {"id": "marketwatch", "name": "MarketWatch",       "url": "http://feeds.marketwatch.com/marketwatch/topstories",          "color": "#0067a5"},
    {"id": "barrons",     "name": "Barron's",          "url": "https://www.barrons.com/feed/rssheadlines",                    "color": "#005ea2"},
    {"id": "investing",   "name": "Investing.com",     "url": "https://www.investing.com/rss/news.rss",                       "color": "#e93f33"},
]

CACHE_TTL_SEC = 300  # 5 minutes
USER_AGENT = "Mozilla/5.0 (compatible; StockAnalyzer/1.0)"


# ---------------------------------------------------------------------
# Cleaning helpers
# ---------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _clean(s: str | None, max_len: int = 280) -> str:
    if not s:
        return ""
    s = _TAG_RE.sub(" ", s)
    s = html.unescape(s)
    s = _WS_RE.sub(" ", s).strip()
    if len(s) > max_len:
        s = s[: max_len - 1].rstrip() + "…"
    return s


def _parse_pubdate(s: str | None) -> float:
    if not s:
        return 0.0
    try:
        return parsedate_to_datetime(s).timestamp()
    except (TypeError, ValueError):
        return 0.0


# ---------------------------------------------------------------------
# Fetch + parse one feed
# ---------------------------------------------------------------------

def _local_name(tag: str) -> str:
    """Strip XML namespace from a tag name."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find_image(item: ET.Element) -> str | None:
    """Best-effort image extraction. Tries media:thumbnail, media:content, enclosure."""
    for el in item:
        ln = _local_name(el.tag)
        if ln in ("thumbnail", "content"):
            url = el.attrib.get("url")
            if url and url.startswith(("http://", "https://")):
                return url
        if ln == "enclosure":
            url = el.attrib.get("url")
            t = el.attrib.get("type", "")
            if url and t.startswith("image/"):
                return url
    return None


def _fetch_one(source: dict, timeout: int = 10) -> list[dict]:
    """Fetch + parse a single source. Returns list of normalized item dicts."""
    req = Request(source["url"], headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/xml, text/xml, */*"})
    with urlopen(req, timeout=timeout) as r:
        data = r.read()

    root = ET.fromstring(data)
    items: list[dict] = []

    # Try RSS 2.0 first
    for item in root.iter("item"):
        title = _clean(item.findtext("title"), max_len=240)
        link = (item.findtext("link") or "").strip()
        desc = _clean(item.findtext("description"))
        pub = item.findtext("pubDate") or ""
        ts = _parse_pubdate(pub)
        if not title or not link:
            continue
        items.append({
            "title": title,
            "link": link,
            "summary": desc,
            "published": pub,
            "timestamp": ts,
            "source_id": source["id"],
            "source_name": source["name"],
            "source_color": source["color"],
            "image": _find_image(item),
        })

    # Atom fallback
    if not items:
        atom_ns = "{http://www.w3.org/2005/Atom}"
        for entry in root.iter(f"{atom_ns}entry"):
            title = _clean(entry.findtext(f"{atom_ns}title"), max_len=240)
            link_el = entry.find(f"{atom_ns}link")
            link = link_el.attrib.get("href") if link_el is not None else ""
            summary = _clean(entry.findtext(f"{atom_ns}summary") or entry.findtext(f"{atom_ns}content"))
            pub = entry.findtext(f"{atom_ns}updated") or entry.findtext(f"{atom_ns}published") or ""
            ts = _parse_pubdate(pub)
            if not title or not link:
                continue
            items.append({
                "title": title,
                "link": link,
                "summary": summary,
                "published": pub,
                "timestamp": ts,
                "source_id": source["id"],
                "source_name": source["name"],
                "source_color": source["color"],
                "image": None,
            })

    return items


# ---------------------------------------------------------------------
# Cache + public API
# ---------------------------------------------------------------------

_CACHE: dict = {"fetched_at": 0.0, "items": [], "errors": []}
_LOCK = threading.Lock()


def _refresh_locked() -> None:
    """Refetch all sources concurrently. Caller holds the lock."""
    items: list[dict] = []
    errors: list[dict] = []
    with ThreadPoolExecutor(max_workers=len(SOURCES)) as ex:
        futures = {ex.submit(_fetch_one, src): src for src in SOURCES}
        for fut, src in futures.items():
            try:
                items.extend(fut.result(timeout=15))
            except Exception as e:
                errors.append({"source_id": src["id"], "source_name": src["name"], "error": str(e)})
    items.sort(key=lambda it: it["timestamp"], reverse=True)
    _CACHE["fetched_at"] = time.time()
    _CACHE["items"] = items
    _CACHE["errors"] = errors


def get_news(source_ids: list[str] | None = None, limit: int = 50,
             force_refresh: bool = False) -> dict:
    """Get merged + sorted news. Refreshes from network if cache is stale."""
    with _LOCK:
        age = time.time() - _CACHE["fetched_at"]
        if force_refresh or age > CACHE_TTL_SEC or not _CACHE["items"]:
            _refresh_locked()
        items = _CACHE["items"]
        errors = _CACHE["errors"]
        fetched_at = _CACHE["fetched_at"]

    if source_ids:
        wanted = set(source_ids)
        items = [it for it in items if it["source_id"] in wanted]

    return {
        "items": items[:max(1, min(200, limit))],
        "errors": errors,
        "fetched_at": fetched_at,
        "ttl_sec": CACHE_TTL_SEC,
        "sources": [{"id": s["id"], "name": s["name"], "color": s["color"]} for s in SOURCES],
    }
