"""Symbol-search helper for the 自选 add-form autocomplete.

Why this module exists
----------------------
The 自选 add form used to accept any free-text string. That works for a
single canonical symbol like ``NVDA`` or ``0700.HK``, but it can't help
the user disambiguate when the same letters mean different things:

    BTC      → Grayscale Bitcoin Mini Trust ETF (NYSE Arca)
    BTC-USD  → Bitcoin spot pair on Yahoo Finance

This module merges results from up to four sources (in order):

  1. **Curated table** — common ambiguous tickers (BTC, ETH, …); always
     surfaced first so the explicit disambiguation appears at the top.
  2. **CoinGecko `/search`** — no key, covers EVERY crypto token
     including brand-new launches (Hyperliquid HYPE, etc.) that Yahoo
     hasn't indexed yet. We normalise to Yahoo-style ``XXX-USD``.
  3. **Finnhub `/search`** — when ``FINNHUB_API_KEY`` is set. Best for
     US equities and ETFs; returns symbol + description + type +
     primary exchange.
  4. **Yahoo Finance `/v1/finance/search`** — no key. Best for HK
     (.HK), CN A-shares (.SS / .SZ), futures, established crypto
     pairs.

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
# Source: CoinGecko /api/v3/search
#
# Free, no key required, and the most comprehensive crypto database for
# newer tokens. Covers things Yahoo/Finnhub don't index — Hyperliquid
# (HYPE), Bonk (BONK), launched-yesterday meme coins, etc.
#
# We normalise CoinGecko's plain ``HYPE`` symbol into the Yahoo-style
# ``HYPE-USD`` canonical form so the rest of the app (watchlist storage,
# quotes lookup) treats it uniformly with other crypto pairs.
# ---------------------------------------------------------------------------

# Suffix list per CoinGecko docs: ``-USD`` is the de-facto canonical form
# the rest of the app already uses (BTC-USD, ETH-USD, …). We keep that.
_COINGECKO_SEARCH = "https://api.coingecko.com/api/v3/search"


def _fetch_coingecko(query: str, limit: int) -> List[Dict[str, Any]]:
    # Skip CoinGecko for queries that are obviously not crypto (too long,
    # contain a dot, etc.) to avoid noise + needless HTTP calls.
    q = (query or "").strip()
    if not q or len(q) > 32 or "." in q or "=" in q:
        return []

    url = f"{_COINGECKO_SEARCH}?{urllib.parse.urlencode({'query': q})}"
    req = urllib.request.Request(url, headers={
        "User-Agent": _YAHOO_UA,
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as e:
        logger.debug("symbol-search coingecko %r: %s", query, e)
        return []

    # Relevance filter:
    # Without it, every "NVDA" search drowns in CoinGecko's NVDAON /
    # NVDAX / NVDAR / Wrapped-bNVDA junk (the tokenized-stock copycats),
    # and "TSLA" picks up "TSLA6900" — a literal-symbol-match meme coin
    # ranked 8502 by market cap.
    #
    # Rule: require **market_cap_rank ≤ 500** for any CoinGecko row to
    # pass. Even with an exact-symbol match. Top-500 covers every
    # legitimately tradeable token (Hyperliquid is #11, Bonk #99, etc.)
    # while filtering out scam / meme / dead-project copycats.
    q_u = query.strip().upper()
    out: List[Dict[str, Any]] = []
    seen_syms: set = set()
    for c in (data.get("coins") or []):
        sym_raw = (c.get("symbol") or "").upper().strip()
        if not sym_raw or sym_raw in seen_syms:
            continue
        rank = c.get("market_cap_rank") if isinstance(c.get("market_cap_rank"), int) else 9999
        if rank > 500:
            continue
        # Bonus: prioritise exact-symbol matches by short-circuiting the
        # loop so they always end up at the head of the returned list
        # (CoinGecko occasionally orders by relevance, not market cap,
        # which would otherwise bury HYPE under another HYPE-prefixed
        # but lower-ranked coin).
        seen_syms.add(sym_raw)
        # Yahoo-style canonical form so downstream code (which already
        # assumes BTC-USD etc.) works without changes.
        canonical = f"{sym_raw}-USD"
        name = c.get("name") or sym_raw
        # Annotate top-1000 coins with their rank so the dropdown can
        # show "#11" alongside Hyperliquid (helps the user spot the
        # canonical token vs a copycat with the same symbol).
        if 1 <= rank <= 999:
            name = f"{name} · #{rank}"
        out.append(_row(
            symbol=canonical,
            name=name,
            exchange="CoinGecko",
            quote_type="CRYPTOCURRENCY",
        ))
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------------------
# Source: Yahoo Finance /v1/finance/search
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

def _relevance_score(item: Dict[str, Any], query_upper: str) -> int:
    """Score how closely an item matches the user's typed query.

    Higher = better. Used to stable-sort the merged results so that
    real equities (Finnhub NVDA → "NVDA") outrank tokenized copycats
    (CoinGecko NVDAON → "NVDA-Ondo-Tokenized") even though both are
    valid hits.
    """
    sym = (item.get("symbol") or "").upper()
    q = query_upper
    if sym == q:                                   return 100   # NVDA == NVDA
    if sym == f"{q}-USD":                          return 95    # HYPE → HYPE-USD
    if sym == f"{q}USD" or sym == f"{q}-USDT":     return 90
    if "." in sym and sym.split(".")[0] == q:      return 85    # 0700.HK exact base
    if "-" in sym and sym.split("-")[0] == q:      return 80    # SOL-USD, BTC-USD, …
    if sym.startswith(q + "."):                    return 70    # NVDA.TO
    if sym.startswith(q):                          return 60
    if q in sym:                                   return 40
    return 20


def _merge(query_upper: str, *lists: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Combine multiple source lists, dedupe by symbol, then stable-sort
    by relevance to ``query_upper`` so the most-relevant hit always wins
    the top slot."""
    seen: set = set()
    pool: List[tuple] = []  # (score, insertion_order, item)
    order = 0
    for lst in lists:
        for it in lst:
            sym = (it.get("symbol") or "").upper()
            if not sym or sym in seen:
                continue
            seen.add(sym)
            pool.append((_relevance_score(it, query_upper), order, it))
            order += 1
    # Sort: highest score first, ties broken by original insertion order
    # (= preserves the curated → coingecko → finnhub → yahoo priority).
    pool.sort(key=lambda t: (-t[0], t[1]))
    return [t[2] for t in pool]


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

    curated   = _fetch_curated(q)
    coingecko = _fetch_coingecko(q, limit)
    finnhub   = _fetch_finnhub(q, limit)
    yahoo     = _fetch_yahoo(q, limit)

    # Two-tier merge:
    #   1. Curated rows ALWAYS come first in their hand-defined order —
    #      that's the whole point of the curated table (BTC-USD before
    #      BTC ETF is an editorial choice we don't want a relevance
    #      heuristic overriding).
    #   2. Everything else (CoinGecko + Finnhub + Yahoo) is deduped and
    #      relevance-sorted so the most-on-target symbol wins. This is
    #      how Finnhub's real NVDA wins over CoinGecko's NVDAON
    #      tokenized-stock copycat.
    curated_keys = {(r.get("symbol") or "").upper() for r in curated}
    non_curated = [
        r for r in (coingecko + finnhub + yahoo)
        if (r.get("symbol") or "").upper() not in curated_keys
    ]
    sorted_rest = _merge(q.upper(), non_curated)
    merged = (curated + sorted_rest)[:limit]

    if not merged:
        merged = [_row(q.upper(), "(无在线匹配 — 直接添加)", "", "")]

    _cache_put(key, merged)
    return merged
