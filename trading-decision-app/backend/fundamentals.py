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

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

import requests

logger = logging.getLogger(__name__)


# ─────────────────────────── universes ───────────────────────────
# Curated tickers per sector. Keep lists ~20 names per sector so the
# percentile-rank scoring is statistically meaningful.

SECTORS: Dict[str, Dict[str, Any]] = {
    "ai": {
        "id": "ai",
        "name": "AI 看板",
        "icon": "🤖",
        "desc": "AI 产业链：算力芯片、服务器、光通信、HBM、散热电源、数据中心 REIT、超大规模云厂商。"
                "成长权重高、PEG 权重高、估值绝对水位次要。",
        "tickers": [
            "NVDA", "AVGO", "AMD", "TSM", "MU", "INTC", "ARM", "QCOM", "MRVL",
            "DELL", "SMCI", "HPE", "CLS",
            "COHR", "LITE", "CIEN", "FN",
            "VRT", "TEL", "APH",
            "ANET", "ALAB",
            "EQIX", "DLR",
            "GOOGL", "MSFT", "META", "AMZN",
        ],
        # weights MUST sum to 100
        "weights": {
            "pe":            10,
            "pe_fwd":        15,
            "peg_av":        20,
            "peg_fwd":       25,
            "rev_growth":    15,
            "eps_growth":    15,
        },
        "weight_rationale": "成长赛道，前瞻 PEG 与 EPS 增速最关键；PE 绝对值次要。",
    },
    "energy": {
        "id": "energy",
        "name": "能源电力",
        "icon": "⚡",
        "desc": "油气上游/油服 + 公用事业电力。成熟现金牛行业，看重估值与盈利质量。"
                "AI 数据中心电力需求催生 IPP/核电板块（VST、CEG、NEE）。",
        "tickers": [
            "XOM", "CVX", "COP", "OXY", "EOG", "SLB", "HAL", "PSX",
            "NEE", "DUK", "SO", "AEP", "D", "SRE", "EXC",
            "VST", "CEG", "TLN",
        ],
        "weights": {
            "pe":            25,
            "pe_fwd":        25,
            "peg_av":        15,
            "peg_fwd":       10,
            "rev_growth":    10,
            "eps_growth":    15,
        },
        "weight_rationale": "成熟行业，绝对估值（PE / Fwd PE）是核心；增长次要但盈利改善要看。",
    },
    "materials": {
        "id": "materials",
        "name": "原材料 / 贵金属",
        "icon": "⛏️",
        "desc": "黄金、铜、铝、钢、化工。强周期，盈利波动剧烈；"
                "看 EPS 同比拐点 + 估值底部组合。",
        "tickers": [
            "NEM", "GOLD", "AEM", "KGC", "WPM", "FNV",
            "FCX", "SCCO",
            "AA",
            "NUE", "STLD", "X",
            "BHP", "RIO", "VALE",
            "LIN", "APD", "SHW",
        ],
        "weights": {
            "pe":            20,
            "pe_fwd":        20,
            "peg_av":        10,
            "peg_fwd":       10,
            "rev_growth":    15,
            "eps_growth":    25,
        },
        "weight_rationale": "强周期股，EPS 同比拐点最关键；PEG 噪声大，权重压低。",
    },
    "financial": {
        "id": "financial",
        "name": "金融",
        "icon": "🏦",
        "desc": "大行、投行、券商、保险、支付、信用卡、加密金融。"
                "传统估值仍以 PE 为锚，但增速一致性是抗周期的护城河。",
        "tickers": [
            "JPM", "BAC", "WFC", "C", "USB", "PNC", "TFC",
            "GS", "MS",
            "BLK", "SCHW",
            "AXP", "V", "MA", "PYPL",
            "BRK-B",
            "COIN", "HOOD",
        ],
        "weights": {
            "pe":            25,
            "pe_fwd":        20,
            "peg_av":        15,
            "peg_fwd":       15,
            "rev_growth":    10,
            "eps_growth":    15,
        },
        "weight_rationale": "金融股估值锚是 PE / Fwd PE；增长权重适中；前瞻 PEG 看穿周期。",
    },
    "biotech": {
        "id": "biotech",
        "name": "生物医疗",
        "icon": "🧬",
        "desc": "大药企（GLP-1 / 肿瘤 / 罕见病）、保险 PBM、医疗器械、Biotech。"
                "管线驱动 + 创新溢价，前瞻 PEG 与 EPS 增速最关键。",
        "tickers": [
            "JNJ", "PFE", "LLY", "MRK", "NVO", "ABBV", "BMY", "AZN",
            "UNH", "ELV", "CVS", "CI",
            "ABT", "TMO", "DHR", "ISRG", "MDT", "BSX",
            "REGN", "VRTX", "MRNA", "GILD", "AMGN", "BIIB",
        ],
        "weights": {
            "pe":            10,
            "pe_fwd":        15,
            "peg_av":        20,
            "peg_fwd":       25,
            "rev_growth":    15,
            "eps_growth":    15,
        },
        "weight_rationale": "创新管线赛道，前瞻 PEG 与增速最关键；PE 绝对值次要（很多公司处于研发期亏损）。",
    },
}


# Direction & display config for each metric.
#   direction: "lower" = lower is better (PE / PEG);
#              "higher" = higher is better (growth metrics).
#   pct: True if value is shown as %.

METRICS: Dict[str, Dict[str, Any]] = {
    "pe":         {"label": "PE (TTM)",  "direction": "lower",  "pct": False},
    "pe_fwd":     {"label": "Fwd PE",    "direction": "lower",  "pct": False},
    "peg_av":     {"label": "PEG (AV)",  "direction": "lower",  "pct": False},
    "peg_fwd":    {"label": "PEG (Fwd)", "direction": "lower",  "pct": False},
    "rev_growth": {"label": "营收 YoY",  "direction": "higher", "pct": True},
    "eps_growth": {"label": "利润 YoY",  "direction": "higher", "pct": True},
}


# ─────────────────────────── data fetching ───────────────────────────

# Lightweight in-process TTL cache (independent of dataflows.cache so we
# don't accidentally evict TradingAgents lookups). Keyed by ticker.
_FUND_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_FUND_TTL_SEC = 30 * 60   # 30 min
_AV_BASE = "https://www.alphavantage.co/query"


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
    key = os.environ.get("ALPHA_VANTAGE_API_KEY")
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


def _normalise_row(ticker: str, ov: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Flatten an OVERVIEW dict into the 6-metric row our UI needs.

    AV returns growth ratios as decimals (e.g. 0.234 → 23.4%). We
    multiply by 100 so the scoring step and the UI see a consistent
    percent number.
    """
    if not ov:
        return {
            "ticker": ticker, "name": ticker, "sector": None,
            "pe": None, "pe_fwd": None, "peg_av": None, "peg_fwd": None,
            "rev_growth": None, "eps_growth": None,
            "market_cap": None, "analyst_target": None,
        }

    pe       = _safe_float(ov.get("PERatio"))
    pe_fwd   = _safe_float(ov.get("ForwardPE"))
    peg_av   = _safe_float(ov.get("PEGRatio"))
    rev_g    = _safe_float(ov.get("QuarterlyRevenueGrowthYOY"))
    eps_g    = _safe_float(ov.get("QuarterlyEarningsGrowthYOY"))

    # AV returns ratios as decimals — convert to percent.
    if rev_g is not None: rev_g *= 100
    if eps_g is not None: eps_g *= 100

    # Compute forward PEG = Fwd PE / EPS YoY %. Only meaningful when
    # growth is positive — negative-growth PEG is misleading.
    peg_fwd = None
    if pe_fwd is not None and eps_g is not None and eps_g > 0:
        peg_fwd = round(pe_fwd / eps_g, 2)

    return {
        "ticker": ticker,
        "name": (ov.get("Name") or ticker)[:40],
        "sector": ov.get("Sector") or None,
        "industry": ov.get("Industry") or None,
        "pe": pe,
        "pe_fwd": pe_fwd,
        "peg_av": peg_av,
        "peg_fwd": peg_fwd,
        "rev_growth": rev_g,
        "eps_growth": eps_g,
        "market_cap": _safe_float(ov.get("MarketCapitalization")),
        "analyst_target": _safe_float(ov.get("AnalystTargetPrice")),
        "profit_margin": _safe_float(ov.get("ProfitMargin")),
        "dividend_yield": _safe_float(ov.get("DividendYield")),
        "as_of": ov.get("LatestQuarter"),
    }


def _fetch_one(ticker: str) -> Dict[str, Any]:
    """Cached single-ticker fetch — uses _FUND_CACHE first."""
    now = time.time()
    cached = _FUND_CACHE.get(ticker.upper())
    if cached and (now - cached[0]) < _FUND_TTL_SEC:
        return cached[1]

    ov = _fetch_av_overview(ticker)
    row = _normalise_row(ticker, ov)
    # Only cache when we got real data, so transient failures retry.
    if ov is not None:
        _FUND_CACHE[ticker.upper()] = (now, row)
    return row


def fetch_sector_rows(sector_id: str) -> List[Dict[str, Any]]:
    """Parallel fetch every ticker in the sector. Returns list of rows."""
    s = SECTORS.get(sector_id)
    if not s:
        return []
    tickers = s["tickers"]
    rows: List[Dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=8, thread_name_prefix="fund") as pool:
        for r in pool.map(_fetch_one, tickers):
            rows.append(r)
    return rows


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


def score_rows(rows: List[Dict[str, Any]], weights: Dict[str, int]) -> List[Dict[str, Any]]:
    """Annotate each row with sub-scores per metric + composite score.

    sub_score = percentile * 100 for "higher-is-better" metrics,
                (1 - percentile) * 100 for "lower-is-better" metrics.
    Missing metrics: that metric's weight is redistributed across the
    present ones so we don't penalise sparse rows.
    """
    cohort: Dict[str, List[Optional[float]]] = {m: [r.get(m) for r in rows] for m in METRICS}

    out: List[Dict[str, Any]] = []
    for r in rows:
        sub: Dict[str, Optional[float]] = {}
        present_weights: Dict[str, int] = {}
        for m, cfg in METRICS.items():
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


# ─────────────────────────── public payload ───────────────────────────

def build_sector_payload(sector_id: str) -> Dict[str, Any]:
    """Top-level entry: returns the full payload the frontend needs."""
    sector = SECTORS.get(sector_id)
    if not sector:
        return {"error": f"unknown sector: {sector_id}"}

    raw_rows = fetch_sector_rows(sector_id)
    scored = score_rows(raw_rows, sector["weights"])

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

    # Top / bottom picks.
    top_picks = ranked[:5]
    bottom_picks = list(reversed(with_score))[:5]

    return {
        "sector": {
            "id": sector["id"],
            "name": sector["name"],
            "icon": sector["icon"],
            "desc": sector["desc"],
            "weight_rationale": sector["weight_rationale"],
            "weights": sector["weights"],
            "ticker_count": len(sector["tickers"]),
        },
        "metrics_meta": METRICS,
        "rows": ranked,
        "top_picks": top_picks,
        "bottom_picks": bottom_picks,
        "stats": {
            "total": len(scored),
            "with_score": len(with_score),
            "median_score": median_score,
            "good": good,
            "mid": mid,
            "high": high,
        },
        "generated_at": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
        "data_source": "alpha_vantage_overview" if os.environ.get("ALPHA_VANTAGE_API_KEY") else "no_api_key",
    }


def list_sectors() -> Dict[str, Any]:
    """Lightweight sector index for the sub-tab strip."""
    return {
        "sectors": [
            {
                "id": s["id"], "name": s["name"], "icon": s["icon"],
                "desc": s["desc"], "ticker_count": len(s["tickers"]),
            }
            for s in SECTORS.values()
        ],
        "metrics_meta": METRICS,
    }
