"""Symbol-search helper for the 自选 add-form autocomplete.

Why this module exists
----------------------
The 自选 add form used to accept any free-text string. That works for a
single canonical symbol like ``NVDA`` or ``0700.HK``, but it can't help
the user disambiguate when the same letters mean different things:

    BTC      → Grayscale Bitcoin Mini Trust ETF (NYSE Arca)
    BTC-USD  → Bitcoin spot pair on Yahoo Finance

This module merges results from up to three sources (in order):

  1. **Finnhub `/search`** — when ``FINNHUB_API_KEY`` is set. Best for US
     equities and ETFs; returns symbol + description + type + primary
     exchange.
  2. **Yahoo Finance `/v1/finance/search`** — no key required. Best for
     crypto pairs (BTC-USD), HK (.HK), CN A-shares (.SS / .SZ), futures.
  3. **Curated fallback table** — covers the most common ambiguous
     tickers (BTC, ETH, etc.) so the feature still works if both
     external endpoints are blocked / rate-limited.

We normalise everything to a flat ``{symbol, name, exchange, quote_type,
market, currency}`` shape so the frontend renders one consistent list.
"""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Small in-process TTL cache.
# ---------------------------------------------------------------------------
_CACHE: Dict[str, tuple] = {}     # key -> (expires_at, items)
_CACHE_TTL = 60.0


def _cache_get(key: str) -> Optional[List[Dict[str, Any]]]:
    hit = _CACHE.get(key)
    if not hit:
        return None
    expires_at, items = hit
    if expires_at < time.time():
        _CACHE.pop(key, None)
        return None
    return items


def _cache_put(key: str, items: List[Dict[str, Any]]) -> None:
    if len(_CACHE) > 256:
        oldest = sorted(_CACHE.items(), key=lambda kv: kv[1][0])[:128]
        for k, _ in oldest:
            _CACHE.pop(k, None)
    _CACHE[key] = (time.time() + _CACHE_TTL, items)


# ---------------------------------------------------------------------------
# quote_type / exchange → our internal "market" classifier
# (matches the same set used in app.js Watchlist._detectMarket)
# ---------------------------------------------------------------------------

_HK_EXCHANGES = {"HKG", "HKSE", "HKE"}
_CN_EXCHANGES = {"SHH", "SHG", "SHE", "SHZ", "SSE", "SZSE"}
_US_EXCHANGES = {
    "NMS", "NYQ", "PCX", "NYS", "ASE", "NGM", "PNK", "OEM", "BTS", "OTC",
    "NCM", "ARCA", "NYSE", "NASDAQ", "AMEX", "BATS",
}


def _classify_market(quote_type: str, exchange: str, symbol: str) -> str:
    qt = (quote_type or "").upper()
    ex = (exchange or "").upper()
    sym_u = (symbol or "").upper()

    if qt in ("CRYPTOCURRENCY", "CRYPTO"):
        return "crypto"
    if qt == "CURRENCY" or sym_u.endswith("=X"):
        return "forex"
    if qt == "FUTURE" or sym_u.endswith("=F"):
        return "commodity"
    if qt == "INDEX":
        return "index"

    if ex in _HK_EXCHANGES or sym_u.endswith(".HK") or sym_u.startswith(("0000", "0001", "0002")):
        return "hk"
    if ex in _CN_EXCHANGES or sym_u.endswith(".SS") or sym_u.endswith(".SZ"):
        return "cn"
    if ex in _US_EXCHANGES or qt in ("ETF", "MUTUALFUND"):
        return "us"
    if qt == "EQUITY":
        # Treat any unrecognised exchange equity as US-default.
        return "us"
    return "other"


def _row(symbol: str, name: str, exchange: str, quote_type: str,
         currency: str = "") -> Dict[str, Any]:
    return {
        "symbol":     (symbol or "").strip(),
        "name":       (name or "").strip(),
        "exchange":   (exchange or "").strip(),
        "quote_type": (quote_type or "").strip(),
        "market":     _classify_market(quote_type, exchange, symbol),
        "currency":   (currency or "").strip(),
    }


# ---------------------------------------------------------------------------
# Source 1: Finnhub /search
# ---------------------------------------------------------------------------

def _fetch_finnhub(query: str, limit: int) -> List[Dict[str, Any]]:
    key = os.environ.get("FINNHUB_API_KEY")
    if not key:
        return []
    params = {"q": query, "token": key}
    url = "https://finnhub.io/api/v1/search?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=4) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as e:
        logger.debug("symbol-search finnhub %r: %s", query, e)
        return []

    results = data.get("result") or []
    out: List[Dict[str, Any]] = []
    for r in results[:limit]:
        # Finnhub gives {description, displaySymbol, symbol, type}. The
        # 'type' is a coarse bucket ("Common Stock" / "ETP" / "Crypto" /…)
        # Symbols can be either plain ("NVDA") or composite
        # ("BINANCE:BTCUSDT", "0700.HK", "BTC-USD").
        symbol = r.get("symbol") or r.get("displaySymbol") or ""
        # Skip the BINANCE:* and OANDA:* composite IDs — they confuse the
        # downstream Yahoo-based quote fetcher.
        if ":" in symbol and not symbol.endswith(":"):
            continue
        qt_raw = (r.get("type") or "").upper()
        qt = {
            "COMMON STOCK": "EQUITY",
            "ETP": "ETF",
            "ETF": "ETF",
            "CRYPTO": "CRYPTOCURRENCY",
            "MUTUAL FUND": "MUTUALFUND",
            "WARRANT": "WARRANT",
        }.get(qt_raw, qt_raw)
        out.append(_row(
            symbol=symbol,
            name=r.get("description") or symbol,
            exchange="",     # Finnhub doesn't include exchange in search results
            quote_type=qt,
        ))
    return out


# ---------------------------------------------------------------------------
# Source 2: Yahoo Finance /v1/finance/search
# ---------------------------------------------------------------------------

_YAHOO_SEARCH = "https://query2.finance.yahoo.com/v1/finance/search"
_YAHOO_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)


def _fetch_yahoo(query: str, limit: int) -> List[Dict[str, Any]]:
    params = {
        "q": query,
        "lang": "en-US",
        "region": "US",
        "quotesCount": min(max(limit, 1), 20),
        "newsCount": 0,
    }
    url = f"{_YAHOO_SEARCH}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={
        "User-Agent": _YAHOO_UA,
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as e:
        logger.debug("symbol-search yahoo %r: %s", query, e)
        return []

    out: List[Dict[str, Any]] = []
    for r in (data.get("quotes") or [])[:limit]:
        symbol = (r.get("symbol") or "").strip()
        if not symbol:
            continue
        out.append(_row(
            symbol=symbol,
            name=r.get("shortname") or r.get("longname") or symbol,
            exchange=r.get("exchange") or r.get("exchDisp") or "",
            quote_type=r.get("quoteType") or r.get("typeDisp") or "",
        ))
    return out


# ---------------------------------------------------------------------------
# Source 3: Curated fallback for common ambiguous tickers.
#
# Used ONLY when both Finnhub and Yahoo return nothing — covers the cases
# the user is most likely to hit (BTC, ETH, …). Keeps the autocomplete
# useful even when both upstream search endpoints are blocked/down.
# ---------------------------------------------------------------------------

_AMBIGUOUS_TICKERS: Dict[str, List[Dict[str, Any]]] = {
    "BTC": [
        _row("BTC-USD", "Bitcoin USD",                          "CCC",  "CRYPTOCURRENCY"),
        _row("BTC",     "Grayscale Bitcoin Mini Trust ETF",     "PCX",  "ETF"),
    ],
    "ETH": [
        _row("ETH-USD", "Ethereum USD",                          "CCC",  "CRYPTOCURRENCY"),
        _row("ETH",     "Grayscale Ethereum Mini Trust ETF",     "PCX",  "ETF"),
    ],
    "SOL": [
        _row("SOL-USD", "Solana USD",                            "CCC",  "CRYPTOCURRENCY"),
    ],
    "XRP": [
        _row("XRP-USD", "XRP USD",                               "CCC",  "CRYPTOCURRENCY"),
    ],
    "DOGE": [
        _row("DOGE-USD", "Dogecoin USD",                         "CCC",  "CRYPTOCURRENCY"),
    ],
    "ADA": [
        _row("ADA-USD",  "Cardano USD",                          "CCC",  "CRYPTOCURRENCY"),
    ],
    "BNB": [
        _row("BNB-USD",  "BNB USD",                              "CCC",  "CRYPTOCURRENCY"),
    ],
    "AVAX": [
        _row("AVAX-USD", "Avalanche USD",                        "CCC",  "CRYPTOCURRENCY"),
    ],
    "LINK": [
        _row("LINK-USD", "Chainlink USD",                        "CCC",  "CRYPTOCURRENCY"),
        _row("LINK",     "LINK (NYSE — discontinued ticker)",    "NYS",  "EQUITY"),
    ],
}


def _fetch_curated(query: str) -> List[Dict[str, Any]]:
    q = query.strip().upper()
    return list(_AMBIGUOUS_TICKERS.get(q, []))


# ---------------------------------------------------------------------------
# Merge + dedupe
# ---------------------------------------------------------------------------

def _merge(*lists: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Combine multiple source lists, dedupe by symbol, preserve order."""
    seen: set = set()
    out: List[Dict[str, Any]] = []
    for lst in lists:
        for it in lst:
            sym = (it.get("symbol") or "").upper()
            if not sym or sym in seen:
                continue
            seen.add(sym)
            out.append(it)
    return out


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------

def search(query: str, limit: int = 8) -> List[Dict[str, Any]]:
    """Return up to `limit` candidate symbols matching `query`.

    Tries Finnhub, then Yahoo Finance, then a curated fallback. If all
    three turn up nothing, returns a single literal-echo row so the
    user can still add their typed symbol.
    """
    q = (query or "").strip()
    if not q:
        return []

    key = f"{q.lower()}#{limit}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    finnhub = _fetch_finnhub(q, limit)
    yahoo   = _fetch_yahoo(q, limit)
    curated = _fetch_curated(q)

    # Curated rows for common ambiguous tickers are surfaced FIRST so the
    # user always sees the explicit choice (e.g. BTC-USD crypto vs BTC ETF)
    # at the top of the dropdown.
    merged = _merge(curated, finnhub, yahoo)[:limit]

    if not merged:
        merged = [_row(q.upper(), "(无在线匹配 — 直接添加)", "", "")]

    _cache_put(key, merged)
    return merged
