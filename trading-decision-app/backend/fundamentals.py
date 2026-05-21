"""
基本面看板 — multi-sector fundamentals + composite scoring.

Each sector has:
  * a curated US-listed ticker universe
  * a per-metric weight matrix (PE / Fwd PE / PEG-AV / PEG-Fwd /
    Revenue YoY / Earnings YoY) — weights differ by sector because
    different industries lean on different signals.

We fetch fundamentals from Alpha Vantage OVERVIEW (single REST call per
ticker, contains all 6 metrics we need + company name). 30-min TTL cache
keeps cost low.

Composite score is a sector-relative percentile blend: each metric is
percentile-ranked within the sector cohort, mapped to 0-100, weighted,
and summed. Missing metrics get their weight redistributed proportionally
so a stock with sparse data isn't penalised just for missing fields.
"""

from __future__ import annotations

import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

# yfinance is the 4th vendor in the fallback chain. Imported defensively
# so local dev (and any env where yfinance isn't installed) still works —
# the fetcher returns None and the chain falls through to the other vendors.
try:
    import yfinance as _yf   # type: ignore
    _HAS_YF = True
except Exception:
    _yf = None
    _HAS_YF = False

logger = logging.getLogger(__name__)


# ─────────────────────────── universes ───────────────────────────
# Curated tickers per sector. Keep lists ~20 names per sector so the
# percentile-rank scoring is statistically meaningful.

# SECTORS uses a sub-sector taxonomy: each sector contains an ordered list
# of sub-sectors, each with its own ticker list. This lets us:
#   - show a 子板块 column in the table
#   - rank sub-sectors by median composite score
#   - tag each row with sub_sector for filtering/scatter labels
#
# The flat ticker list (used by scoring + AV fetch) is derived at runtime
# via _flat_tickers(sector) below.

SECTORS: Dict[str, Dict[str, Any]] = {
    "ai": {
        "id": "ai",
        "name": "AI 看板",
        "icon": "🤖",
        "desc": "AI 产业链：算力芯片、服务器、光通信、HBM、散热电源、数据中心 REIT、超大规模云厂商。"
                "成长权重高、PEG 权重高、估值绝对水位次要。",
        "sub_sectors": [
            ("AI芯片",            ["NVDA", "AVGO", "AMD", "TSM", "MU", "INTC", "ARM", "QCOM", "MRVL"]),
            ("AI服务器/整机",      ["DELL", "SMCI", "HPE", "CLS"]),
            ("光模块/光通信",      ["COHR", "LITE", "CIEN", "FN"]),
            ("散热/电源/连接器",    ["VRT", "TEL", "APH"]),
            ("网络/交换",         ["ANET", "ALAB"]),
            ("数据中心REIT",      ["EQIX", "DLR"]),
            ("超大规模云厂商",      ["GOOGL", "MSFT", "META", "AMZN"]),
        ],
        # weights MUST sum to 100. Distribute across 20 metrics by sector character.
        # AI = growth-tilted: PEG-Fwd + EPS growth dominate; margins matter (gross
        # margin is the moat indicator); debt+yield deprioritized.
        "weights": {
            # Valuation (35)
            "pe": 3, "pe_fwd": 6, "peg_av": 8, "peg_fwd": 12, "ps": 3, "pb": 0, "ev_ebitda": 3,
            # Profitability (20)
            "eps": 0, "roe": 4, "roic": 4, "gross_margin": 8, "op_margin": 4,
            # Growth (25)
            "rev_growth": 11, "eps_growth": 14,
            # Cash flow (8)
            "fcf_yield": 8,
            # Leverage (4)
            "de": 2, "interest_cov": 2, "current_ratio": 0,
            # Shareholder (3)
            "div_yield": 1, "buyback_yield": 2,
            # Risk (5)
            "beta": 5,
        },
        "weight_rationale": "成长赛道，前瞻 PEG + EPS 增速最关键；毛利率反映护城河；股息/D-E 权重压低。",
    },
    "energy": {
        "id": "energy",
        "name": "能源电力",
        "icon": "⚡",
        "desc": "油气上游/油服 + 公用事业电力。成熟现金牛行业，看重估值与盈利质量。"
                "AI 数据中心电力需求催生 IPP/核电板块（VST、CEG、NEE）。",
        "sub_sectors": [
            ("油气一体化巨头",      ["XOM", "CVX"]),
            ("油气上游 E&P",       ["COP", "OXY", "EOG"]),
            ("油服 / 中游",        ["SLB", "HAL", "PSX"]),
            ("公用事业电力",        ["NEE", "DUK", "SO", "AEP", "D", "SRE", "EXC"]),
            ("IPP / 核电",         ["VST", "CEG", "TLN"]),
        ],
        # Energy/Utilities = mature cash cows: absolute valuation + cash flow +
        # dividend yield + leverage health (interest coverage) dominate.
        "weights": {
            # Valuation (32)
            "pe": 9, "pe_fwd": 8, "peg_av": 4, "peg_fwd": 3, "ps": 2, "pb": 4, "ev_ebitda": 2,
            # Profitability (15)
            "eps": 2, "roe": 4, "roic": 5, "gross_margin": 2, "op_margin": 2,
            # Growth (10)
            "rev_growth": 4, "eps_growth": 6,
            # Cash flow (15) — cash cows
            "fcf_yield": 15,
            # Leverage (12) — capital intensive
            "de": 4, "interest_cov": 6, "current_ratio": 2,
            # Shareholder (12) — payouts are part of the thesis
            "div_yield": 8, "buyback_yield": 4,
            # Risk (4)
            "beta": 4,
        },
        "weight_rationale": "成熟现金牛，绝对估值 + FCF 收益率 + 股息率是核心；杠杆与利息保障防雷。",
    },
    "materials": {
        "id": "materials",
        "name": "原材料 / 贵金属",
        "icon": "⛏️",
        "desc": "黄金、铜、铝、钢、化工。强周期，盈利波动剧烈；"
                "看 EPS 同比拐点 + 估值底部组合。",
        "sub_sectors": [
            ("贵金属 / 黄金",      ["NEM", "GOLD", "AEM", "KGC", "WPM", "FNV"]),
            ("铜 / 基本金属",      ["FCX", "SCCO"]),
            ("铝",                ["AA"]),
            ("钢铁",              ["NUE", "STLD", "X"]),
            ("矿业巨头",           ["BHP", "RIO", "VALE"]),
            ("工业气体 / 化工",    ["LIN", "APD", "SHW"]),
        ],
        # Materials = strong cycle: EPS inflection + P/B (vs replacement cost) +
        # balance sheet matters during commodity downcycles.
        "weights": {
            # Valuation (28)
            "pe": 6, "pe_fwd": 8, "peg_av": 2, "peg_fwd": 2, "ps": 2, "pb": 6, "ev_ebitda": 2,
            # Profitability (15)
            "eps": 2, "roe": 4, "roic": 5, "gross_margin": 2, "op_margin": 2,
            # Growth (22) — cycle indicator
            "rev_growth": 8, "eps_growth": 14,
            # Cash flow (12) — cushion through cycles
            "fcf_yield": 12,
            # Leverage (13) — capital intensive, balance sheet survives bottoms
            "de": 5, "interest_cov": 5, "current_ratio": 3,
            # Shareholder (6)
            "div_yield": 4, "buyback_yield": 2,
            # Risk (4)
            "beta": 4,
        },
        "weight_rationale": "强周期，EPS 同比拐点 + PB（vs 重置成本） + 资产负债表是核心；周期底部看 FCF 与利息保障。",
    },
    "financial": {
        "id": "financial",
        "name": "金融",
        "icon": "🏦",
        "desc": "大行、投行、券商、保险、支付、信用卡、加密金融。"
                "传统估值仍以 PE 为锚，但增速一致性是抗周期的护城河。",
        "sub_sectors": [
            ("大型综合银行",       ["JPM", "BAC", "WFC", "C", "USB", "PNC", "TFC"]),
            ("投行 / 投资管理",    ["GS", "MS", "BLK", "SCHW"]),
            ("支付 / 信用卡",     ["AXP", "V", "MA", "PYPL"]),
            ("保险 / 多元化",     ["BRK-B"]),
            ("加密 / 互联网券商", ["COIN", "HOOD"]),
        ],
        # Financials = P/B + ROE classic; D/E meaningless for banks (use diff
        # metric) so cap leverage weight; dividend + buyback yield big.
        "weights": {
            # Valuation (32)
            "pe": 10, "pe_fwd": 8, "peg_av": 3, "peg_fwd": 3, "ps": 0, "pb": 6, "ev_ebitda": 2,
            # Profitability (22) — ROE is the king metric for banks
            "eps": 2, "roe": 10, "roic": 4, "gross_margin": 0, "op_margin": 6,
            # Growth (12)
            "rev_growth": 4, "eps_growth": 8,
            # Cash flow (6)
            "fcf_yield": 6,
            # Leverage (8) — soft (banks are leveraged by design)
            "de": 2, "interest_cov": 4, "current_ratio": 2,
            # Shareholder (15) — payouts are core thesis
            "div_yield": 9, "buyback_yield": 6,
            # Risk (5)
            "beta": 5,
        },
        "weight_rationale": "金融股估值锚 PE × PB；ROE 是王牌；股息+回购的资本回报权重高；D/E 因为银行天然加杠杆而权重压低。",
    },
    "biotech": {
        "id": "biotech",
        "name": "生物医疗",
        "icon": "🧬",
        "desc": "大药企（GLP-1 / 肿瘤 / 罕见病）、保险 PBM、医疗器械、Biotech。"
                "管线驱动 + 创新溢价，前瞻 PEG 与 EPS 增速最关键。",
        "sub_sectors": [
            ("大药企",             ["JNJ", "PFE", "LLY", "MRK", "NVO", "ABBV", "BMY", "AZN"]),
            ("保险 / PBM",         ["UNH", "ELV", "CVS", "CI"]),
            ("医疗器械 / 诊断",     ["ABT", "TMO", "DHR", "ISRG", "MDT", "BSX"]),
            ("Biotech / 创新药",   ["REGN", "VRTX", "MRNA", "GILD", "AMGN", "BIIB"]),
        ],
        # Biotech = pipeline-driven: PEG-Fwd + gross margins (innovation premium)
        # + balance sheet (R&D runway) + EPS growth all matter.
        "weights": {
            # Valuation (28)
            "pe": 3, "pe_fwd": 6, "peg_av": 6, "peg_fwd": 10, "ps": 3, "pb": 0, "ev_ebitda": 0,
            # Profitability (22) — margins indicate moat
            "eps": 0, "roe": 4, "roic": 4, "gross_margin": 10, "op_margin": 4,
            # Growth (22)
            "rev_growth": 10, "eps_growth": 12,
            # Cash flow (10) — biotechs burn cash; FCF + cash on hand is survival
            "fcf_yield": 10,
            # Leverage (8) — R&D runway
            "de": 3, "interest_cov": 3, "current_ratio": 2,
            # Shareholder (4)
            "div_yield": 1, "buyback_yield": 3,
            # Risk (6)
            "beta": 6,
        },
        "weight_rationale": "管线驱动，前瞻 PEG + 毛利率（创新溢价）+ 现金流（R&D runway）最关键；PE 绝对值次要（很多公司研发期亏损）。",
    },
    "crypto": {
        "id": "crypto",
        "name": "加密货币",
        "icon": "₿",
        "desc": "主流公链 + 头部 L1 + 新锐：BTC / ETH 是数字货币基准，"
                "SOL / BNB / TRX 是高吞吐 L1，HYPE 是 perp-DEX 链。"
                "没有传统财务指标，看市值规模 / 流动性 / 动量 / ATH 距离。",
        "sub_sectors": [
            ("数字黄金",       ["BTC"]),
            ("智能合约 L1",     ["ETH", "SOL", "BNB", "TRX"]),
            ("新锐 / DEX",     ["HYPE"]),
        ],
        # Crypto weights apply to CRYPTO_METRICS — not the stock METRICS.
        # Heavy momentum + size + ATH discount; volatility deducts.
        "weights": {
            "market_cap":  20,
            "vol_to_mcap": 10,
            "mom_7d":      20,
            "mom_30d":     20,
            "ath_dist":    20,  # higher = further from ATH = more upside room
            "volatility":  10,
        },
        "weight_rationale": "动量 + 规模 + ATH 折扣是核心；高波动扣分；不用传统 PE/PEG（加密资产没有 earnings）。",
        # Tag: tells the scoring engine to use CRYPTO_METRICS instead of METRICS
        "metric_set": "crypto",
    },
}


def _flat_tickers(sector: Dict[str, Any]) -> List[str]:
    """Flatten a sector's sub_sectors → flat ticker list (order preserved)."""
    out: List[str] = []
    for _, tickers in sector["sub_sectors"]:
        out.extend(tickers)
    return out


def _sub_sector_of(sector: Dict[str, Any], ticker: str) -> Optional[str]:
    """Reverse-lookup: which sub-sector does this ticker belong to?"""
    t = (ticker or "").upper()
    for name, tickers in sector["sub_sectors"]:
        if t in {x.upper() for x in tickers}:
            return name
    return None


# Direction & display config for each metric.
#   direction: "lower" = lower is better (PE / PEG / debt / Beta);
#              "higher" = higher is better (growth / margins / ROE / yields).
#   pct: True if value is shown as %.
#   group: category used for sub-score grouping in the expanded row.
#   key (optional): primary table column — only metrics with key set show in the table.

METRICS: Dict[str, Dict[str, Any]] = {
    # ── Valuation ────────────────────────────
    "pe":            {"label": "PE (TTM)",        "direction": "lower",  "pct": False, "group": "valuation"},
    "pe_fwd":        {"label": "Fwd PE",          "direction": "lower",  "pct": False, "group": "valuation"},
    "peg_av":        {"label": "PEG (AV)",        "direction": "lower",  "pct": False, "group": "valuation"},
    "peg_fwd":       {"label": "PEG (Fwd)",       "direction": "lower",  "pct": False, "group": "valuation"},
    "ps":            {"label": "P/S",             "direction": "lower",  "pct": False, "group": "valuation"},
    "pb":            {"label": "P/B",             "direction": "lower",  "pct": False, "group": "valuation"},
    "ev_ebitda":     {"label": "EV/EBITDA",       "direction": "lower",  "pct": False, "group": "valuation"},
    # ── Profitability ────────────────────────
    "eps":           {"label": "EPS",             "direction": "higher", "pct": False, "group": "profitability"},
    "roe":           {"label": "ROE",             "direction": "higher", "pct": True,  "group": "profitability"},
    "roic":          {"label": "ROIC",            "direction": "higher", "pct": True,  "group": "profitability"},
    "gross_margin":  {"label": "毛利率",          "direction": "higher", "pct": True,  "group": "profitability"},
    "op_margin":     {"label": "经营利润率",      "direction": "higher", "pct": True,  "group": "profitability"},
    # ── Growth ───────────────────────────────
    "rev_growth":    {"label": "营收 YoY",        "direction": "higher", "pct": True,  "group": "growth"},
    "eps_growth":    {"label": "利润 YoY",        "direction": "higher", "pct": True,  "group": "growth"},
    # ── Cash Flow ────────────────────────────
    "fcf_yield":     {"label": "FCF 收益率",      "direction": "higher", "pct": True,  "group": "cash_flow"},
    # ── Leverage / Liquidity ─────────────────
    "de":            {"label": "D/E",             "direction": "lower",  "pct": False, "group": "leverage"},
    "interest_cov":  {"label": "利息保障",        "direction": "higher", "pct": False, "group": "leverage"},
    "current_ratio": {"label": "流动比率",        "direction": "higher", "pct": False, "group": "leverage"},
    # ── Return to shareholders ───────────────
    "div_yield":     {"label": "股息率",          "direction": "higher", "pct": True,  "group": "shareholder"},
    "buyback_yield": {"label": "回购收益率",      "direction": "higher", "pct": True,  "group": "shareholder"},
    # ── Risk ─────────────────────────────────
    "beta":          {"label": "Beta",            "direction": "lower",  "pct": False, "group": "risk"},
}

# Crypto metrics — completely different framework. No PE / ROE / etc.
# Crypto value drivers: size + network usage + momentum + distance from ATH.
CRYPTO_METRICS: Dict[str, Dict[str, Any]] = {
    "market_cap":     {"label": "市值",          "direction": "higher", "pct": False, "group": "scale"},
    "vol_to_mcap":    {"label": "换手率 (Vol/MCap)", "direction": "higher", "pct": True, "group": "liquidity"},
    "mom_7d":         {"label": "7d 涨跌",       "direction": "higher", "pct": True,  "group": "momentum"},
    "mom_30d":        {"label": "30d 涨跌",      "direction": "higher", "pct": True,  "group": "momentum"},
    "ath_dist":       {"label": "距 ATH",        "direction": "higher", "pct": True,  "group": "drawdown"},
    "volatility":     {"label": "波动 (1y 区间)", "direction": "lower",  "pct": True,  "group": "risk"},
}

# Metric groups — used to render the expanded-row breakdown.
METRIC_GROUPS = {
    "valuation":      "估值 · VALUATION",
    "profitability":  "盈利能力 · PROFITABILITY",
    "growth":         "成长性 · GROWTH",
    "cash_flow":      "现金流 · CASH FLOW",
    "leverage":       "杠杆 / 偿债 · LEVERAGE",
    "shareholder":    "股东回报 · SHAREHOLDER",
    "risk":           "风险 · RISK",
    "scale":          "规模 · SCALE",
    "liquidity":      "流动性 · LIQUIDITY",
    "momentum":       "动量 · MOMENTUM",
    "drawdown":       "回撤 · DRAWDOWN",
}


# ─────────────────────────── data fetching ───────────────────────────
#
# Multi-source layering — each layer is best-effort, gaps fall through:
#   1. Alpha Vantage OVERVIEW   → PE / Fwd PE / PEG-AV / Quarterly YoY +
#                                  company name, sector, industry, mkt cap,
#                                  analyst target. (Single REST call per ticker.)
#   2. Polygon.io previous-day  → live last price + day change %.
#                                  Used to refresh the price column even
#                                  when AV OVERVIEW is cached.
#   3. Finnhub /stock/metric    → revenueGrowthTTMYoy, epsGrowthTTMYoy as
#                                  cross-checks; falls back when AV
#                                  Quarterly YoY is missing.
#
# ─── Cache hierarchy ─────────────────────────────────────────────────
#
# Fundamentals are daily-changing (10-K filings drop quarterly; ratios drift
# slowly between earnings) so we cache aggressively. Three layers:
#
#   1. _FUND_CACHE — in-memory per-ticker row, 12h TTL.
#   2. Disk JSON  — same shape, persisted under _DISK_CACHE_DIR so a server
#                    restart doesn't dump a hot cache. 24h TTL.
#   3. _PAYLOAD_CACHE — fully-scored sector payload, 10min TTL (cheaper
#                       than re-scoring the same 28 rows).
#
# Per-ticker fetch fans out to 4 vendors in parallel and merges with
# explicit per-metric fallback (Finnhub primary, yfinance secondary, AV
# for PEG-AV only, Polygon for live price). Negative cache marks fully-
# unfetchable tickers (e.g. delisted) so we don't re-hammer.
_FUND_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_FUND_TTL_SEC = 12 * 3600   # 12h — fundamentals change quarterly, ratios drift slowly

_NEG_CACHE: Dict[str, float] = {}   # ticker → expiry epoch
_NEG_TTL_SEC = 30 * 60    # 30 min back-off on full-fail tickers

_PAYLOAD_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_PAYLOAD_TTL_SEC = 10 * 60   # 10 min — re-score within window is wasted work

# Disk cache location — defaults to ~/.fund-cache but FUND_CACHE_DIR env
# var lets the deployer point at e.g. /data on Fly.
_DISK_CACHE_DIR = Path(os.environ.get("FUND_CACHE_DIR") or
                       (Path.home() / ".fund-cache"))
_DISK_TTL_SEC = 24 * 3600   # 24h
try:
    _DISK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
except Exception as _e:
    logger.warning("could not create fund cache dir %s: %s", _DISK_CACHE_DIR, _e)


_AV_BASE = "https://www.alphavantage.co/query"
_POLY_BASE = "https://api.polygon.io"
_FH_BASE = "https://finnhub.io/api/v1"
_CG_BASE = "https://api.coingecko.com/api/v3"


def _disk_cache_path(ticker: str) -> Path:
    # Use uppercase + replace dots / dashes so filenames are safe.
    safe = ticker.upper().replace("/", "_").replace("\\", "_")
    return _DISK_CACHE_DIR / f"{safe}.json"


def _disk_cache_read(ticker: str) -> Optional[Dict[str, Any]]:
    """Return cached row if disk entry exists and is within TTL, else None."""
    p = _disk_cache_path(ticker)
    if not p.exists():
        return None
    try:
        with p.open("r") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            return None
        ts = d.get("_cached_at")
        if not ts or (time.time() - float(ts)) > _DISK_TTL_SEC:
            return None
        # Strip cache-only fields when returning to caller
        out = {k: v for k, v in d.items() if k != "_cached_at"}
        return out
    except Exception as e:
        logger.debug("disk cache read %s failed: %s", ticker, e)
        return None


def _disk_cache_write(ticker: str, row: Dict[str, Any]) -> None:
    """Persist a fetched row to disk for cross-restart survival."""
    if not row or row.get("_no_data"):
        return
    p = _disk_cache_path(ticker)
    try:
        payload = dict(row)
        payload["_cached_at"] = time.time()
        with p.open("w") as f:
            json.dump(payload, f, default=str)
    except Exception as e:
        logger.debug("disk cache write %s failed: %s", ticker, e)


def _env(*names: str) -> Optional[str]:
    """First env var that has a value. Accepts both `_API_KEY` and `_KEY`
    suffixes so the same code works with either of the two .env files in
    the repo.
    """
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return None


def _av_key() -> Optional[str]:
    return _env("ALPHA_VANTAGE_API_KEY", "ALPHA_VANTAGE_KEY")


def _polygon_key() -> Optional[str]:
    return _env("POLYGON_API_KEY", "POLYGON_KEY")


def _finnhub_key() -> Optional[str]:
    return _env("FINNHUB_API_KEY", "FINNHUB_KEY")


def _safe_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    s = str(v).strip()
    if s in ("", "-", "None", "NaN"):
        return None
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def _fetch_av_overview(ticker: str) -> Optional[Dict[str, Any]]:
    """Single Alpha Vantage OVERVIEW call. Returns the raw dict or None."""
    key = _av_key()
    if not key:
        return None
    try:
        r = requests.get(
            _AV_BASE,
            params={"function": "OVERVIEW", "symbol": ticker, "apikey": key},
            timeout=8,
        )
        r.raise_for_status()
        j = r.json() or {}
        if "Symbol" not in j:
            logger.debug("av OVERVIEW %s returned no Symbol: %s",
                         ticker, j.get("Note") or j.get("Information"))
            return None
        return j
    except Exception as e:
        logger.warning("av OVERVIEW %s: %s", ticker, e)
        return None


def _fetch_polygon_quote(ticker: str) -> Optional[Dict[str, Any]]:
    """Polygon previous-day aggregate — returns latest close + day change %.
    Independent of AV's stale OVERVIEW data. Returns {price, change_pct,
    market_cap?}. Polygon endpoint is /v2/aggs/ticker/{T}/prev.
    """
    key = _polygon_key()
    if not key:
        return None
    # Polygon uses dot-separated symbols (BRK.B not BRK-B).
    poly_t = ticker.replace("-", ".")
    try:
        r = requests.get(
            f"{_POLY_BASE}/v2/aggs/ticker/{poly_t}/prev",
            params={"adjusted": "true", "apiKey": key},
            timeout=6,
        )
        if r.status_code != 200:
            return None
        j = r.json() or {}
        results = j.get("results") or []
        if not results:
            return None
        bar = results[0]
        close = _safe_float(bar.get("c"))
        open_ = _safe_float(bar.get("o"))
        if close is None:
            return None
        change_pct = None
        if open_ and open_ > 0:
            change_pct = (close - open_) / open_ * 100
        return {"price": close, "change_pct": change_pct, "polygon_ts": bar.get("t")}
    except Exception as e:
        logger.debug("polygon prev %s: %s", ticker, e)
        return None


def _fetch_finnhub_metrics(ticker: str) -> Optional[Dict[str, Any]]:
    """Finnhub /stock/metric — primary source for the 20-metric stock framework.

    One REST call returns ~80 fundamental fields. We pull what we need
    and let _normalise_row pick the best of (Finnhub, AV OVERVIEW) for
    each metric.
    """
    key = _finnhub_key()
    if not key:
        return None
    try:
        r = requests.get(
            f"{_FH_BASE}/stock/metric",
            params={"symbol": ticker, "metric": "all", "token": key},
            timeout=6,
        )
        if r.status_code != 200:
            return None
        m = (r.json() or {}).get("metric") or {}

        # Finnhub returns most ratios as native values, percents as raw
        # (e.g. 23.5 for 23.5%). Compute FCF yield from FCF / market cap
        # ourselves since Finnhub doesn't expose it directly.
        fcf = _safe_float(m.get("freeCashFlowTTM"))
        mcap = _safe_float(m.get("marketCapitalization"))   # in millions
        fcf_yield = None
        if fcf is not None and mcap is not None and mcap > 0:
            # Both in $millions → FCF / MCap × 100 = yield %
            fcf_yield = round(fcf / mcap * 100, 2)

        # Note on Finnhub naming (verified against a live JPM /metric dump):
        # - ROIC: only `roiTTM` / `roiAnnual` exist (NOT `roicTTM`). Treat
        #   roi as roic proxy — for non-leveraged firms it's equivalent.
        # - D/E: lives at `totalDebt/totalEquityQuarterly` (literal slash
        #   in the key). Python dict access tolerates that fine.
        # - Interest coverage: `netInterestCoverageAnnual` / `...TTM`. For
        #   banks this isn't meaningful but the field still appears.
        # - EV/EBITDA: `evEbitdaTTM` is the canonical key (other variants
        #   in older docs).
        return {
            # Valuation
            "fh_pe":            _safe_float(m.get("peTTM") or m.get("peExclExtraTTM")
                                            or m.get("peBasicExclExtraTTM") or m.get("peAnnual")),
            "fh_pe_fwd":        _safe_float(m.get("forwardPE")),
            "fh_peg_fwd":       _safe_float(m.get("forwardPEG") or m.get("pegTTM")),
            "fh_ps":            _safe_float(m.get("psTTM") or m.get("psAnnual")),
            "fh_pb":            _safe_float(m.get("pbQuarterly") or m.get("pbAnnual")
                                            or m.get("pb")),
            "fh_ev_ebitda":     _safe_float(m.get("evEbitdaTTM") or m.get("currentEv/EbitdaTTM")),
            # Profitability
            "fh_eps":           _safe_float(m.get("epsBasicExclExtraItemsTTM")
                                            or m.get("epsTTM") or m.get("epsAnnual")),
            "fh_roe":           _safe_float(m.get("roeTTM") or m.get("roeRfy") or m.get("roe5Y")),
            "fh_roic":          _safe_float(m.get("roiTTM") or m.get("roiAnnual") or m.get("roi5Y")),
            "fh_gross_margin":  _safe_float(m.get("grossMarginTTM") or m.get("grossMarginAnnual")
                                            or m.get("grossMargin5Y")),
            "fh_op_margin":     _safe_float(m.get("operatingMarginTTM") or m.get("operatingMarginAnnual")
                                            or m.get("operatingMargin5Y")),
            # Growth
            "fh_rev_growth":    _safe_float(m.get("revenueGrowthTTMYoy") or
                                            m.get("revenueGrowthQuarterlyYoy")),
            "fh_eps_growth":    _safe_float(m.get("epsGrowthTTMYoy") or
                                            m.get("epsGrowthQuarterlyYoy")),
            "fh_eps_growth_5y": _safe_float(m.get("epsGrowth5Y")),
            # Cash flow
            "fh_fcf_yield":     fcf_yield,
            # Leverage / Liquidity
            "fh_de":            _safe_float(m.get("totalDebt/totalEquityQuarterly")
                                            or m.get("totalDebt/totalEquityAnnual")
                                            or m.get("longTermDebt/equityQuarterly")
                                            or m.get("longTermDebt/equityAnnual")),
            "fh_interest_cov":  _safe_float(m.get("netInterestCoverageTTM") or
                                            m.get("netInterestCoverageAnnual")),
            "fh_current_ratio": _safe_float(m.get("currentRatioQuarterly") or
                                            m.get("currentRatioAnnual")),
            # Shareholder
            "fh_div_yield":     _safe_float(m.get("currentDividendYieldTTM")
                                            or m.get("dividendYieldIndicatedAnnual")),
            # Risk
            "fh_beta":          _safe_float(m.get("beta")),
        }
    except Exception as e:
        logger.debug("finnhub metric %s: %s", ticker, e)
        return None


# ───────────────────────── yfinance fallback ──────────────────────────

def _fetch_yfinance_metrics(ticker: str) -> Optional[Dict[str, Any]]:
    """yfinance.Ticker(t).info — broadest free coverage; backfills the
    metrics Finnhub / AV miss. Slower per-ticker (~1-2s) so we only call
    it as a fallback — but for banks / biotechs it's often the ONLY
    source for D/E, current ratio, FCF, share-count, etc.

    Returns None if yfinance isn't installed or the call fails.
    """
    if not _HAS_YF:
        return None
    try:
        t = _yf.Ticker(ticker)
        info = t.info or {}
    except Exception as e:
        logger.debug("yfinance info %s: %s", ticker, e)
        return None
    if not info:
        return None

    # yfinance percentages are usually returned as decimals (0.23 = 23%);
    # ratios (PE, P/B, P/S, etc.) are native. Normalise to % when relevant.
    def _pct(v: Any) -> Optional[float]:
        f = _safe_float(v)
        return f * 100 if f is not None else None

    fcf = _safe_float(info.get("freeCashflow"))
    mcap = _safe_float(info.get("marketCap"))
    fcf_yield = None
    if fcf is not None and mcap is not None and mcap > 0:
        fcf_yield = round(fcf / mcap * 100, 2)

    # Buyback yield: derive from share count change YoY when both fields
    # are present. yfinance exposes `sharesOutstanding` (current) and
    # `floatShares`; the historical share count comes from `t.shares`
    # (slow) so we skip the derivation when it would require extra calls.
    buyback_yield = None
    # Lightweight derivation: prefer info field if present (rare).
    if info.get("buybackYield") is not None:
        buyback_yield = _pct(info.get("buybackYield"))

    return {
        "yf_pe":            _safe_float(info.get("trailingPE")),
        "yf_pe_fwd":        _safe_float(info.get("forwardPE")),
        "yf_ps":            _safe_float(info.get("priceToSalesTrailing12Months")),
        "yf_pb":            _safe_float(info.get("priceToBook")),
        "yf_ev_ebitda":     _safe_float(info.get("enterpriseToEbitda")),
        "yf_eps":           _safe_float(info.get("trailingEps")),
        "yf_roe":           _pct(info.get("returnOnEquity")),
        # yfinance has no direct ROIC; use ROA as a conservative proxy
        # (banks / biotechs ROIC is messy anyway). Better than nothing.
        "yf_roic":          _pct(info.get("returnOnAssets")),
        "yf_gross_margin":  _pct(info.get("grossMargins")),
        "yf_op_margin":     _pct(info.get("operatingMargins")),
        "yf_rev_growth":    _pct(info.get("revenueGrowth")),
        "yf_eps_growth":    _pct(info.get("earningsGrowth") or info.get("earningsQuarterlyGrowth")),
        "yf_fcf_yield":     fcf_yield,
        # debtToEquity arrives as % (e.g. 88.3 means D/E = 0.883) — yfinance
        # quirk. We divide by 100 to get the ratio form everyone uses.
        "yf_de":            (lambda d: d / 100 if isinstance(d, (int, float)) else None)(
                                _safe_float(info.get("debtToEquity"))),
        "yf_current_ratio": _safe_float(info.get("currentRatio")),
        "yf_quick_ratio":   _safe_float(info.get("quickRatio")),
        # dividendYield arrives as decimal — convert to %
        "yf_div_yield":     _pct(info.get("dividendYield")),
        "yf_buyback_yield": buyback_yield,
        "yf_beta":          _safe_float(info.get("beta")),
        # Display-only
        "yf_name":          info.get("shortName") or info.get("longName"),
        "yf_sector":        info.get("sector"),
        "yf_industry":      info.get("industry"),
        "yf_market_cap":    mcap,
        "yf_analyst_target":_safe_float(info.get("targetMeanPrice") or
                                        info.get("targetMedianPrice")),
    }


# ─────────────────────── CoinGecko (crypto sector) ────────────────────

# Map our shorthand ticker → CoinGecko coin id. CoinGecko's /coins/markets
# takes a comma-separated `ids` param and returns all coins in ONE request,
# so the entire crypto sector fetches in a single HTTP call. No API key
# needed for basic /coins/markets endpoint.
_CG_ID_MAP = {
    "BTC":  "bitcoin",
    "ETH":  "ethereum",
    "SOL":  "solana",
    "BNB":  "binancecoin",
    "TRX":  "tron",
    "HYPE": "hyperliquid",
}


def _fetch_crypto_batch() -> Optional[List[Dict[str, Any]]]:
    """Single CoinGecko call for all crypto tickers. Returns normalised rows."""
    ids = ",".join(_CG_ID_MAP.values())
    try:
        r = requests.get(
            f"{_CG_BASE}/coins/markets",
            params={
                "vs_currency": "usd",
                "ids": ids,
                "order": "market_cap_desc",
                "price_change_percentage": "7d,30d,1y",
            },
            timeout=8,
        )
        if r.status_code != 200:
            logger.warning("coingecko markets http %s", r.status_code)
            return None
        data = r.json() or []
        # Build by-id lookup so we keep our canonical ticker order.
        by_id = {x.get("id"): x for x in data}
        out: List[Dict[str, Any]] = []
        for sym, cg_id in _CG_ID_MAP.items():
            d = by_id.get(cg_id)
            if not d:
                # Coin not in response (rare; e.g. HYPE if CoinGecko id changes)
                out.append({"ticker": sym, "name": sym, "_no_data": True})
                continue
            price = _safe_float(d.get("current_price"))
            ath   = _safe_float(d.get("ath"))
            mom7  = _safe_float(d.get("price_change_percentage_7d_in_currency"))
            mom30 = _safe_float(d.get("price_change_percentage_30d_in_currency"))
            mom1y = _safe_float(d.get("price_change_percentage_1y_in_currency"))
            day_chg = _safe_float(d.get("price_change_percentage_24h"))
            mcap  = _safe_float(d.get("market_cap"))
            vol24 = _safe_float(d.get("total_volume"))
            ath_chg = _safe_float(d.get("ath_change_percentage"))   # negative when below ATH
            # ath_dist = -ath_change_percentage so "higher = further from ATH" (more upside)
            # e.g. ATH down -50% → ath_dist = 50 (50% room to recover)
            ath_dist = abs(ath_chg) if (ath_chg is not None and ath_chg < 0) else 0
            # vol/mcap = liquidity proxy (already %)
            vol_to_mcap = (vol24 / mcap * 100) if (vol24 and mcap and mcap > 0) else None
            # Volatility proxy: use abs(1y change) — wide swings = more vol
            volatility = abs(mom1y) if isNum(mom1y) else None
            out.append({
                "ticker":     sym,
                "name":       (d.get("name") or sym)[:40],
                "sector":     "Cryptocurrency",
                "industry":   None,
                # crypto metric set
                "market_cap":  mcap,
                "vol_to_mcap": vol_to_mcap,
                "mom_7d":      mom7,
                "mom_30d":     mom30,
                "ath_dist":    ath_dist,
                "volatility":  volatility,
                # display
                "price":       price,
                "change_pct":  day_chg,
                "analyst_target": ath,   # repurposed: show ATH instead of analyst target
                "as_of":       d.get("last_updated"),
            })
        return out
    except Exception as e:
        logger.warning("coingecko fetch failed: %s", e)
        return None


# Tiny helper to keep _fetch_crypto_batch self-contained
def isNum(v):  # noqa: N802  (mirrors JS naming for grep)
    return v is not None and not (isinstance(v, float) and (v != v))


def _pick_first(*vals):
    """Return the first non-None value (used to layer vendor results)."""
    for v in vals:
        if v is not None:
            return v
    return None


def _normalise_row(ticker: str, ov: Optional[Dict[str, Any]],
                   poly: Optional[Dict[str, Any]] = None,
                   fh: Optional[Dict[str, Any]] = None,
                   yf: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Merge AV + Polygon + Finnhub + yfinance → 20-metric row.

    Per-metric fallback order (first non-None wins):
      * Most metrics: Finnhub → yfinance → AV
      * PEG-AV: only AV (historical 5y PEG)
      * Live price: Polygon → AV-derived → None
      * Source-of-truth for each metric is recorded in `_sources` for QA.
    """
    ov = ov or {}
    fh = fh or {}
    yf = yf or {}
    poly = poly or {}

    # Track which vendor supplied each metric — exposed in `_sources` for
    # diagnostics (the frontend can surface this if we ever want to).
    src: Dict[str, str] = {}

    def _layer(metric_name: str, *layers):
        """Pick first non-None across layers, remember which source provided it.
        Each layer is a (source_label, value) tuple OR a bare value.
        """
        for L in layers:
            if isinstance(L, tuple):
                lab, v = L
            else:
                lab, v = "?", L
            if v is not None:
                src[metric_name] = lab
                return v
        return None

    # AV percent conversion helper — AV returns most ratios as decimals.
    def _av_pct(v):
        f = _safe_float(v)
        return f * 100 if f is not None else None

    # ── Valuation ────────────────────────────
    pe = _layer("pe",
                ("fh", fh.get("fh_pe")),
                ("yf", yf.get("yf_pe")),
                ("av", _safe_float(ov.get("PERatio"))))
    pe_fwd = _layer("pe_fwd",
                    ("fh", fh.get("fh_pe_fwd")),
                    ("yf", yf.get("yf_pe_fwd")),
                    ("av", _safe_float(ov.get("ForwardPE"))))
    peg_av = _layer("peg_av",
                    ("av", _safe_float(ov.get("PEGRatio"))))   # only AV has 5y PEG
    ps = _layer("ps",
                ("fh", fh.get("fh_ps")),
                ("yf", yf.get("yf_ps")),
                ("av", _safe_float(ov.get("PriceToSalesRatioTTM"))))
    pb = _layer("pb",
                ("fh", fh.get("fh_pb")),
                ("yf", yf.get("yf_pb")),
                ("av", _safe_float(ov.get("PriceToBookRatio"))))
    ev_ebitda = _layer("ev_ebitda",
                       ("fh", fh.get("fh_ev_ebitda")),
                       ("yf", yf.get("yf_ev_ebitda")),
                       ("av", _safe_float(ov.get("EVToEBITDA"))))

    # ── Profitability ────────────────────────
    eps = _layer("eps",
                 ("fh", fh.get("fh_eps")),
                 ("yf", yf.get("yf_eps")),
                 ("av", _safe_float(ov.get("EPS"))))
    roe = _layer("roe",
                 ("fh", fh.get("fh_roe")),
                 ("yf", yf.get("yf_roe")),
                 ("av", _av_pct(ov.get("ReturnOnEquityTTM"))))
    roic = _layer("roic",
                  ("fh", fh.get("fh_roic")),
                  ("yf", yf.get("yf_roic")))
    # AV has GrossProfit + Revenue — compute gross margin if neither
    # Finnhub nor yfinance had it.
    gm_av = None
    gp = _safe_float(ov.get("GrossProfitTTM"))
    rev = _safe_float(ov.get("RevenueTTM"))
    if gp and rev and rev > 0:
        gm_av = round(gp / rev * 100, 2)
    gross_margin = _layer("gross_margin",
                          ("fh", fh.get("fh_gross_margin")),
                          ("yf", yf.get("yf_gross_margin")),
                          ("av", gm_av))
    op_margin = _layer("op_margin",
                       ("fh", fh.get("fh_op_margin")),
                       ("yf", yf.get("yf_op_margin")),
                       ("av", _av_pct(ov.get("OperatingMarginTTM"))))

    # ── Growth ───────────────────────────────
    rev_g = _layer("rev_growth",
                   ("fh", fh.get("fh_rev_growth")),
                   ("yf", yf.get("yf_rev_growth")),
                   ("av", _av_pct(ov.get("QuarterlyRevenueGrowthYOY"))))
    eps_g = _layer("eps_growth",
                   ("fh", fh.get("fh_eps_growth")),
                   ("yf", yf.get("yf_eps_growth")),
                   ("av", _av_pct(ov.get("QuarterlyEarningsGrowthYOY"))))

    # Forward PEG = Fwd PE / EPS YoY %. Only meaningful when growth > 0.
    # Prefer Finnhub's published forwardPEG when it disagrees with our
    # derivation (catches edge cases where EPS growth = positive but
    # Finnhub uses 3y/5y avg).
    peg_fwd = None
    if fh.get("fh_peg_fwd") is not None:
        peg_fwd = fh.get("fh_peg_fwd")
        src["peg_fwd"] = "fh"
    elif pe_fwd is not None and eps_g is not None and eps_g > 0:
        peg_fwd = round(pe_fwd / eps_g, 2)
        src["peg_fwd"] = "derived"

    # ── Cash Flow ────────────────────────────
    fcf_yield = _layer("fcf_yield",
                       ("fh", fh.get("fh_fcf_yield")),
                       ("yf", yf.get("yf_fcf_yield")))

    # ── Leverage / Liquidity ─────────────────
    de = _layer("de",
                ("fh", fh.get("fh_de")),
                ("yf", yf.get("yf_de")))
    interest_cov = _layer("interest_cov",
                          ("fh", fh.get("fh_interest_cov")))
    current_ratio = _layer("current_ratio",
                           ("fh", fh.get("fh_current_ratio")),
                           ("yf", yf.get("yf_current_ratio")))

    # ── Shareholder ──────────────────────────
    div_yield = _layer("div_yield",
                       ("fh", fh.get("fh_div_yield")),
                       ("yf", yf.get("yf_div_yield")),
                       ("av", _av_pct(ov.get("DividendYield"))))
    buyback_yield = _layer("buyback_yield",
                           ("yf", yf.get("yf_buyback_yield")))

    # ── Risk ─────────────────────────────────
    beta = _layer("beta",
                  ("fh", fh.get("fh_beta")),
                  ("yf", yf.get("yf_beta")),
                  ("av", _safe_float(ov.get("Beta"))))

    # Sanity-check: did we get anything at all?
    metric_vals = (pe, pe_fwd, peg_av, peg_fwd, ps, pb, ev_ebitda, eps,
                   roe, roic, gross_margin, op_margin, rev_g, eps_g,
                   fcf_yield, de, interest_cov, current_ratio,
                   div_yield, buyback_yield, beta)
    has_any = any(v is not None for v in metric_vals)
    if not has_any and not poly:
        return {
            "ticker": ticker, "name": ticker, "sector": None,
            "_no_data": True,
            "price": None, "change_pct": None,
        }

    # Name: prefer yfinance (cleaner), AV, then ticker.
    name = (yf.get("yf_name") or ov.get("Name") or "")[:40] or ticker
    sector_label = yf.get("yf_sector") or ov.get("Sector")
    industry_label = yf.get("yf_industry") or ov.get("Industry")
    market_cap = _layer("market_cap",
                        ("yf", yf.get("yf_market_cap")),
                        ("av", _safe_float(ov.get("MarketCapitalization"))))
    analyst_target = _layer("analyst_target",
                            ("yf", yf.get("yf_analyst_target")),
                            ("av", _safe_float(ov.get("AnalystTargetPrice"))))

    return {
        "ticker": ticker,
        "name": name,
        "sector": sector_label,
        "industry": industry_label,
        # Live price layer (Polygon)
        "price": poly.get("price"),
        "change_pct": poly.get("change_pct"),
        # 21-metric set ──
        "pe": pe, "pe_fwd": pe_fwd, "peg_av": peg_av, "peg_fwd": peg_fwd,
        "ps": ps, "pb": pb, "ev_ebitda": ev_ebitda,
        "eps": eps, "roe": roe, "roic": roic,
        "gross_margin": gross_margin, "op_margin": op_margin,
        "rev_growth": rev_g, "eps_growth": eps_g,
        "fcf_yield": fcf_yield,
        "de": de, "interest_cov": interest_cov, "current_ratio": current_ratio,
        "div_yield": div_yield, "buyback_yield": buyback_yield,
        "beta": beta,
        # Misc display
        "market_cap": market_cap,
        "analyst_target": analyst_target,
        "as_of": ov.get("LatestQuarter"),
        # Diagnostics — which source filled each metric
        "_sources": src,
    }


def _fetch_one(ticker: str, force: bool = False) -> Dict[str, Any]:
    """Cached single-ticker fetch — runs AV + Polygon + Finnhub + yfinance
    in parallel and merges with explicit per-metric fallback chain.

    Cache layers checked in order: in-memory → disk (24h) → vendors.
    `force=True` bypasses both memory and disk caches so a manual refresh
    always pulls live data.
    """
    t_up = ticker.upper()
    now = time.time()

    if not force:
        # 1. In-memory cache (12h TTL)
        cached = _FUND_CACHE.get(t_up)
        if cached and (now - cached[0]) < _FUND_TTL_SEC:
            return cached[1]
        # 2. Disk cache (24h TTL) — survives restarts
        disk_row = _disk_cache_read(ticker)
        if disk_row is not None and not disk_row.get("_no_data"):
            _FUND_CACHE[t_up] = (now, disk_row)
            return disk_row
        # 3. Negative cache — recent failure → placeholder, skip vendors
        neg = _NEG_CACHE.get(t_up)
        if neg and neg > now:
            return {
                "ticker": ticker, "name": ticker, "sector": None,
                "_no_data": True, "_neg_cached": True,
                "price": None, "change_pct": None,
            }

    # Four vendors in parallel. yfinance is slower (~1-2s) but pulls the
    # metrics the others miss; running it concurrently keeps total wall
    # time at max(vendor_latency), not sum.
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="fund-vendor") as pool:
        f_ov   = pool.submit(_fetch_av_overview, ticker)
        f_poly = pool.submit(_fetch_polygon_quote, ticker)
        f_fh   = pool.submit(_fetch_finnhub_metrics, ticker)
        f_yf   = pool.submit(_fetch_yfinance_metrics, ticker)
        ov   = f_ov.result()
        poly = f_poly.result()
        fh   = f_fh.result()
        yf   = f_yf.result()

    row = _normalise_row(ticker, ov, poly, fh, yf)
    if row.get("_no_data"):
        _NEG_CACHE[t_up] = now + _NEG_TTL_SEC
        return row

    # Persist to in-memory + disk caches.
    _FUND_CACHE[t_up] = (now, row)
    _disk_cache_write(ticker, row)
    return row


def fetch_sector_rows(sector_id: str, force: bool = False) -> List[Dict[str, Any]]:
    """Parallel fetch every ticker in the sector + stamp sub_sector.

    For crypto sector: uses CoinGecko batch endpoint (single HTTP).
    For stock sectors: parallel per-ticker AV + Polygon + Finnhub.

    `force=True` skips the per-ticker TTL cache so a manual refresh always
    pulls live data.
    """
    s = SECTORS.get(sector_id)
    if not s:
        return []

    # ── Crypto path: one CoinGecko call for all coins. ──
    if s.get("metric_set") == "crypto":
        # For crypto we don't currently per-ticker-cache (the batch endpoint
        # is fast enough). `force` is a no-op since we always re-fetch.
        rows = _fetch_crypto_batch() or []
        for r in rows:
            r["sub_sector"] = _sub_sector_of(s, r["ticker"])
        return rows

    # ── Stock path: bumped worker count from 8 → 16 (latency dominated). ──
    tickers = _flat_tickers(s)

    def _wrapped(t: str) -> Dict[str, Any]:
        row = _fetch_one(t, force=force)
        row["sub_sector"] = _sub_sector_of(s, t)
        return row

    rows: List[Dict[str, Any]] = []
    # 24 workers — yfinance dominates the latency budget (1-2s per ticker)
    # so more parallelism is the main lever. Disk + memory caches absorb
    # the load on subsequent fetches.
    with ThreadPoolExecutor(max_workers=24, thread_name_prefix="fund") as pool:
        for r in pool.map(_wrapped, tickers):
            rows.append(r)
    return rows


def _metric_set_for(sector: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """Returns the metric definition dict for this sector."""
    return CRYPTO_METRICS if sector.get("metric_set") == "crypto" else METRICS


# ─────────────────────────── scoring ───────────────────────────

def _percentile_rank(values: List[Optional[float]], value: Optional[float]) -> Optional[float]:
    """Returns 0..1 = fraction of cohort that `value` is ≥. None values are skipped.

    Stable, tolerates ties by averaging. If value itself is None, returns None.
    """
    if value is None:
        return None
    clean = [v for v in values if v is not None]
    n = len(clean)
    if n == 0:
        return None
    below = sum(1 for v in clean if v < value)
    equal = sum(1 for v in clean if v == value)
    return (below + 0.5 * equal) / n


def score_rows(rows: List[Dict[str, Any]],
               weights: Dict[str, int],
               metric_set: Dict[str, Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Annotate each row with sub-scores per metric + composite score.

    sub_score = percentile * 100 for "higher-is-better" metrics,
                (1 - percentile) * 100 for "lower-is-better" metrics.
    Missing metrics: that metric's weight is redistributed across the
    present ones so we don't penalise sparse rows.

    `metric_set`: defaults to the global METRICS (stocks). Pass
    CRYPTO_METRICS for the crypto sector.
    """
    if metric_set is None:
        metric_set = METRICS

    cohort: Dict[str, List[Optional[float]]] = {
        m: [r.get(m) for r in rows] for m in metric_set
    }

    out: List[Dict[str, Any]] = []
    for r in rows:
        sub: Dict[str, Optional[float]] = {}
        present_weights: Dict[str, int] = {}
        for m, cfg in metric_set.items():
            v = r.get(m)
            pct = _percentile_rank(cohort[m], v)
            if pct is None:
                sub[m] = None
                continue
            s = pct * 100 if cfg["direction"] == "higher" else (1 - pct) * 100
            # Lower-is-better metric with negative or zero value
            # (e.g. negative PE = unprofitable, negative PEG) → score 0.
            if cfg["direction"] == "lower" and v is not None and v <= 0:
                s = 0.0
            sub[m] = round(s, 1)
            present_weights[m] = weights.get(m, 0)

        total_w = sum(present_weights.values())
        if total_w == 0:
            composite = None
        else:
            composite = sum(sub[m] * present_weights[m] for m in present_weights) / total_w
            composite = round(composite, 1)

        annotated = dict(r)
        annotated["sub_scores"] = sub
        annotated["score"] = composite
        annotated["score_class"] = _score_class(composite)
        out.append(annotated)
    return out


def _score_class(s: Optional[float]) -> str:
    if s is None:
        return "na"
    if s >= 70:
        return "good"
    if s >= 45:
        return "mid"
    return "high"   # "high" = expensive / weak — keeps CSS vocab (good/mid/high) consistent


# ─────────────────────────── sub-sector aggregation ───────────────────────────

def _sub_sector_stats(sector: Dict[str, Any], scored: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """For each sub-sector in `sector`, compute median composite score +
    count breakdown. Returns list in the sub-sector display order.
    """
    by_sub: Dict[str, List[Dict[str, Any]]] = {}
    for r in scored:
        sub = r.get("sub_sector") or "其他"
        by_sub.setdefault(sub, []).append(r)

    out: List[Dict[str, Any]] = []
    for name, tickers in sector["sub_sectors"]:
        rows = by_sub.get(name, [])
        scores = [r["score"] for r in rows if r.get("score") is not None]
        med = round(sorted(scores)[len(scores) // 2], 1) if scores else None
        out.append({
            "name": name,
            "ticker_count": len(tickers),
            "with_score": len(scores),
            "median_score": med,
            "good": sum(1 for r in rows if r.get("score_class") == "good"),
            "mid":  sum(1 for r in rows if r.get("score_class") == "mid"),
            "high": sum(1 for r in rows if r.get("score_class") == "high"),
        })
    return out


# ─────────────────────────── 核心结论与解读 ───────────────────────────

def _format_score(s: Optional[float]) -> str:
    return f"{s:.1f}" if s is not None else "—"


def _format_pct(v: Optional[float]) -> str:
    return f"{v:.1f}%" if v is not None else "—"


def build_commentary(sector: Dict[str, Any],
                     scored: List[Dict[str, Any]],
                     stats: Dict[str, Any],
                     sub_stats: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """Generate "核心结论与解读" paragraphs from the scored cohort.

    Returns a list of {title, body} dicts ready to render. Four sections,
    inspired by the original PEG dashboard:
      1) 整体估值水位       — composite-score distribution summary
      2) 子板块分化         — which sub-sectors are cheapest / most expensive
      3) 周期拐点信号       — PEG-AV vs PEG-Fwd divergence (业绩拐点)
      4) 关注度优先级       — top-3 picks by Fwd-PEG ascending
    """
    sector_name = sector["name"]
    with_score = [r for r in scored if r.get("score") is not None]
    n_total = len(scored)
    n_scored = len(with_score)
    median = stats.get("median_score")
    good = stats.get("good", 0)
    mid = stats.get("mid", 0)
    high = stats.get("high", 0)

    paragraphs: List[Dict[str, str]] = []
    is_crypto = sector.get("metric_set") == "crypto"
    unit_word = "币种" if is_crypto else "股票"
    metric_set = _metric_set_for(sector)

    # ── 1. 整体估值水位 ──
    median_str = _format_score(median)
    judge = "偏低" if (median is not None and median < 45) else \
            "中性" if (median is not None and median < 60) else \
            "中性偏强" if (median is not None and median < 70) else "偏强"
    # Build a top-3-weight summary from whatever weights are defined in this sector.
    top_w = sorted(sector["weights"].items(), key=lambda kv: kv[1], reverse=True)[:3]
    weights_str = " · ".join(
        f"{metric_set.get(k, {}).get('label', k)} {v}%" for k, v in top_w
    )
    quality_word = "综合质地" if is_crypto else "整体估值"
    paragraphs.append({
        "title": "整体水位",
        "body": (
            f"<strong>{sector_name}</strong> 覆盖 <strong>{n_total}</strong> 只{unit_word}，有评分的 "
            f"<strong>{n_scored}</strong> 只，板块综合分中位数 <strong>{median_str}</strong>，"
            f"{quality_word}<strong>{judge}</strong>。"
            f"分级分布：优秀 (≥70) <strong>{good}</strong> 只，中性 (45–70) <strong>{mid}</strong> 只，"
            f"弱势 (&lt;45) <strong>{high}</strong> 只。"
            f"评分权重主要落在 <em>{weights_str}</em> — 这是本板块的核心信号。"
        ),
    })

    # ── 2. 子板块分化 ──
    sub_with_score = [s for s in sub_stats if s.get("median_score") is not None]
    if len(sub_with_score) >= 2:
        sorted_subs = sorted(sub_with_score, key=lambda s: s["median_score"], reverse=True)
        top3 = sorted_subs[:3]
        bot3 = list(reversed(sorted_subs[-3:]))
        spread = sorted_subs[0]["median_score"] - sorted_subs[-1]["median_score"]
        top_str = "、".join(f"<strong>{s['name']}</strong>（{s['median_score']:.0f}）" for s in top3)
        bot_str = "、".join(f"<strong>{s['name']}</strong>（{s['median_score']:.0f}）" for s in bot3)
        paragraphs.append({
            "title": "子板块分化",
            "body": (
                f"按子板块中位综合分排序，<strong>最具吸引力</strong>的是 {top_str}；"
                f"<strong>估值最贵</strong>的是 {bot_str}。"
                f"子板块间最大分差约 <strong>{spread:.0f}</strong> 分，说明 {sector_name} 内部已经分化，"
                f"资金未平均铺开 — 同板块内可以横向对照，避开拥挤交易。"
            ),
        })
    else:
        paragraphs.append({
            "title": "子板块分化",
            "body": "子板块评分数据不足，无法横向对比。请刷新或稍后重试。",
        })

    # ── 3. 周期/动量信号 ──
    if is_crypto:
        # Crypto: surface ATH discount + recent momentum split
        momentum = sorted(
            [r for r in with_score if r.get("mom_30d") is not None],
            key=lambda r: r["mom_30d"], reverse=True,
        )
        if momentum:
            top_mom = momentum[0]
            tail_mom = momentum[-1]
            ath_leader = max(
                (r for r in with_score if r.get("ath_dist") is not None),
                key=lambda r: r["ath_dist"], default=None,
            )
            ath_str = (f"<strong>{ath_leader['ticker']}</strong>"
                       f"（距 ATH {ath_leader['ath_dist']:.0f}%）" if ath_leader else "无")
            paragraphs.append({
                "title": "动量与 ATH 信号",
                "body": (
                    f"近 30 天动量分化明显：领涨 <strong>{top_mom['ticker']}</strong>"
                    f"（30d {top_mom['mom_30d']:+.1f}%），落后 <strong>{tail_mom['ticker']}</strong>"
                    f"（30d {tail_mom['mom_30d']:+.1f}%）。距 ATH 折价最大的是 {ath_str} — "
                    f"折价高意味着潜在上行空间大，但<em>不代表必然反弹</em>。"
                ),
            })
        else:
            paragraphs.append({
                "title": "动量与 ATH 信号",
                "body": "暂无足够的动量数据。",
            })
    else:
        inflection = []
        for r in with_score:
            peg_av = r.get("peg_av")
            peg_fwd = r.get("peg_fwd")
            if peg_av is None or peg_fwd is None or peg_fwd <= 0:
                continue
            # 历史 PEG 远高于前瞻 PEG 且前瞻 PEG < 0.8 → 业绩拐点信号
            if peg_av >= 1.2 * peg_fwd and peg_fwd < 0.8 and peg_av > 0.8:
                inflection.append((r, peg_av / peg_fwd))
        inflection.sort(key=lambda x: x[1], reverse=True)
        if inflection:
            top = inflection[:5]
            names = "、".join(
                f"<strong>{r[0]['ticker']}</strong>（{r[0]['peg_av']:.2f} vs {r[0]['peg_fwd']:.2f}）"
                for r in top
            )
            paragraphs.append({
                "title": "周期拐点信号",
                "body": (
                    f"部分标的 PEG (AV，历史口径) <strong>显著高于</strong> PEG (Forward，前瞻口径) — "
                    f"这通常意味着公司刚走出业绩低谷、增速正在加速，而 5 年历史 PEG 还没追上 TTM 增速。"
                    f"典型代表：{names}。这是值得深挖的 <em>业绩拐点</em> 信号，"
                    f"但还需要核对业绩可持续性、行业景气节奏、个股催化。"
                ),
            })
        else:
            paragraphs.append({
                "title": "周期拐点信号",
                "body": (
                    f"当前 {sector_name} 没有出现明显的 PEG-AV ≫ PEG-Fwd 背离信号 — "
                    f"前瞻 PEG 与历史 PEG 总体一致，意味着市场已经把增速变化定价。"
                    f"想要捕捉拐点机会，建议关注下一份财报后的口径切换。"
                ),
            })

    # ── 4. 关注度优先级 ──
    if is_crypto:
        # Crypto: rank by composite score (with positive 30d momentum bonus)
        fallback = sorted(with_score, key=lambda r: r.get("score") or 0, reverse=True)[:3]
        if fallback:
            items = "、".join(
                f"<strong>{r['ticker']}</strong>（综合分 {_format_score(r.get('score'))}，"
                f"30d {_format_pct(r.get('mom_30d'))}）"
                for r in fallback
            )
            paragraphs.append({
                "title": "关注度优先级",
                "body": (
                    f"按综合分排序，本期值得重点观察：{items}。"
                    f"<em>提示</em>：加密资产无内生现金流，定价主要由叙事 + 流动性驱动，"
                    f"请结合更宽时间窗的链上数据和市场情绪二次判断。"
                ),
            })
        else:
            paragraphs.append({
                "title": "关注度优先级",
                "body": "暂无可用打分数据，请刷新或稍后重试。",
            })
        return paragraphs

    eligible = [r for r in with_score
                if r.get("peg_fwd") is not None and r["peg_fwd"] > 0]
    eligible.sort(key=lambda r: r["peg_fwd"])
    top_picks = eligible[:3]
    if top_picks:
        items = []
        for r in top_picks:
            eps_str = _format_pct(r.get("eps_growth"))
            items.append(
                f"<strong>{r['ticker']}</strong>（PEG-Fwd {r['peg_fwd']:.2f}，"
                f"EPS YoY {eps_str}，综合分 {_format_score(r.get('score'))}）"
            )
        paragraphs.append({
            "title": "关注度优先级",
            "body": (
                f"按 PEG-Forward 升序，赔率最高的三个标的为 {'、'.join(items)}。"
                f"<em>提示</em>：这只是估值角度的便宜信号，必须结合业绩可持续性、"
                f"行业景气节奏、个股催化做二次筛选。下方表格支持按任意列排序 + 子板块过滤。"
            ),
        })
    else:
        # No positive-growth picks — describe top by composite score instead.
        fallback = sorted(with_score, key=lambda r: r["score"], reverse=True)[:3]
        if fallback:
            items = "、".join(
                f"<strong>{r['ticker']}</strong>（综合分 {_format_score(r.get('score'))}）"
                for r in fallback
            )
            paragraphs.append({
                "title": "关注度优先级",
                "body": (
                    f"本板块缺少正向 EPS 增长的标的，PEG-Fwd 信号缺失。"
                    f"退一步按综合分挑选：{items}。表格支持按任意列排序 + 子板块过滤。"
                ),
            })
        else:
            paragraphs.append({
                "title": "关注度优先级",
                "body": "暂无可用打分数据，请刷新或稍后重试。",
            })

    return paragraphs


# ─────────────────────────── public payload ───────────────────────────

def _data_source_label() -> str:
    """One-line description of which vendors are wired up."""
    parts = []
    if _finnhub_key():  parts.append("finnhub")
    if _HAS_YF:         parts.append("yfinance")
    if _av_key():       parts.append("alpha_vantage")
    if _polygon_key():  parts.append("polygon")
    return "+".join(parts) if parts else "no_api_key"


def build_sector_payload(sector_id: str, force: bool = False) -> Dict[str, Any]:
    """Top-level entry: returns the full payload the frontend needs.

    `force=True` bypasses both the per-ticker TTL cache AND the
    payload-level cache so a manual refresh always pulls fresh data
    from the vendors and re-scores from scratch.
    """
    sector = SECTORS.get(sector_id)
    if not sector:
        return {"error": f"unknown sector: {sector_id}"}

    # Payload-level cache check.
    now = time.time()
    if not force:
        cached = _PAYLOAD_CACHE.get(sector_id)
        if cached and (now - cached[0]) < _PAYLOAD_TTL_SEC:
            return cached[1]

    metric_set = _metric_set_for(sector)
    raw_rows = fetch_sector_rows(sector_id, force=force)
    scored = score_rows(raw_rows, sector["weights"], metric_set)

    # Rank by composite score (descending).
    with_score = [r for r in scored if r.get("score") is not None]
    without_score = [r for r in scored if r.get("score") is None]
    with_score.sort(key=lambda r: r["score"], reverse=True)
    ranked = with_score + without_score
    for i, r in enumerate(ranked):
        r["rank"] = i + 1

    # KPIs.
    scores = [r["score"] for r in with_score]
    median_score = round(sorted(scores)[len(scores) // 2], 1) if scores else None
    good = sum(1 for r in with_score if r["score_class"] == "good")
    mid  = sum(1 for r in with_score if r["score_class"] == "mid")
    high = sum(1 for r in with_score if r["score_class"] == "high")

    stats = {
        "total": len(scored),
        "with_score": len(with_score),
        "median_score": median_score,
        "good": good, "mid": mid, "high": high,
    }

    # Sub-sector aggregates + commentary.
    sub_stats = _sub_sector_stats(sector, ranked)
    commentary = build_commentary(sector, ranked, stats, sub_stats)

    # Top / bottom picks.
    top_picks = ranked[:5]
    bottom_picks = list(reversed(with_score))[:5]

    payload = {
        "sector": {
            "id": sector["id"],
            "name": sector["name"],
            "icon": sector["icon"],
            "desc": sector["desc"],
            "weight_rationale": sector["weight_rationale"],
            "weights": sector["weights"],
            "ticker_count": len(_flat_tickers(sector)),
            "sub_sectors": [name for name, _ in sector["sub_sectors"]],
            "metric_set": sector.get("metric_set", "stock"),
        },
        "metrics_meta": metric_set,
        "metric_groups": METRIC_GROUPS,
        "rows": ranked,
        "top_picks": top_picks,
        "bottom_picks": bottom_picks,
        "stats": stats,
        "sub_sector_stats": sub_stats,
        "commentary": commentary,
        "generated_at": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
        "data_source": _data_source_label() if sector.get("metric_set") != "crypto" else "coingecko",
    }

    # Cache the fully-scored payload (5-min TTL).
    _PAYLOAD_CACHE[sector_id] = (now, payload)
    return payload


def build_overview(force: bool = False) -> Dict[str, Any]:
    """Cross-sector macro view — runs all sectors in parallel and returns
    aggregate stats for the top strip. Heavy on first call (~5-10s for
    ~100 tickers); near-instant once the per-ticker AV cache warms.

    `force=True` propagates to per-ticker fetchers so a manual refresh
    really hits the vendors.
    """
    results: Dict[str, Dict[str, Any]] = {}
    with ThreadPoolExecutor(max_workers=5, thread_name_prefix="fund-ovr") as pool:
        future_to_id = {
            pool.submit(build_sector_payload, sid, force): sid
            for sid in SECTORS
        }
        for fut in future_to_id:
            sid = future_to_id[fut]
            try:
                results[sid] = fut.result()
            except Exception as e:
                logger.warning("overview sector %s failed: %s", sid, e)
                results[sid] = {"error": str(e)}

    out = []
    for sid, sector in SECTORS.items():
        p = results.get(sid) or {}
        stats = p.get("stats") or {}
        picks_top = p.get("top_picks") or []
        picks_bot = p.get("bottom_picks") or []
        top1 = picks_top[0] if picks_top else None
        bottom1 = picks_bot[0] if picks_bot else None
        out.append({
            "id": sid,
            "name": sector["name"],
            "icon": sector["icon"],
            "ticker_count": len(_flat_tickers(sector)),
            "median_score": stats.get("median_score"),
            "with_score":   stats.get("with_score", 0),
            "good":         stats.get("good", 0),
            "mid":          stats.get("mid", 0),
            "high":         stats.get("high", 0),
            "top_ticker":   (top1 or {}).get("ticker") if top1 else None,
            "top_score":    (top1 or {}).get("score")  if top1 else None,
            "bottom_ticker":(bottom1 or {}).get("ticker") if bottom1 else None,
            "bottom_score": (bottom1 or {}).get("score") if bottom1 else None,
        })

    return {
        "sectors": out,
        "generated_at": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
        "data_source": _data_source_label(),
    }


def list_sectors() -> Dict[str, Any]:
    """Lightweight sector index for the sub-tab strip."""
    return {
        "sectors": [
            {
                "id": s["id"], "name": s["name"], "icon": s["icon"],
                "desc": s["desc"],
                "ticker_count": len(_flat_tickers(s)),
                "sub_sectors": [name for name, _ in s["sub_sectors"]],
                "metric_set": s.get("metric_set", "stock"),
            }
            for s in SECTORS.values()
        ],
        "metrics_meta": METRICS,
    }


# ─────────────────────────── startup warm-up ───────────────────────────

def warm_up_async() -> None:
    """Fire-and-forget background warm-up of all sector payloads.

    Run at FastAPI startup so the first user to hit /api/fundamentals
    after a cold start gets a hot cache. Logs the time + result; never
    raises (we don't want startup to fail).
    """
    import threading

    def _runner():
        start = time.time()
        logger.info("fundamentals warm-up: starting %d sectors", len(SECTORS))
        for sid in SECTORS:
            try:
                t0 = time.time()
                p = build_sector_payload(sid)
                rows = p.get("rows") or []
                scored = sum(1 for r in rows if r.get("score") is not None)
                logger.info("  ✓ %s warmed in %.1fs (%d/%d scored)",
                            sid, time.time() - t0, scored, len(rows))
            except Exception as e:
                logger.warning("  ✗ %s warm-up failed: %s", sid, e)
        logger.info("fundamentals warm-up: done in %.1fs", time.time() - start)

    t = threading.Thread(target=_runner, name="fund-warmup", daemon=True)
    t.start()
