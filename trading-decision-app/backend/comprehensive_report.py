"""
Comprehensive Report Generator.

Aggregates ALL historical decisions for a given (user, ticker) into a single
multi-section synthesis. The frontend collects the user's decisions (which are
already RLS-scoped in Supabase), trims them, then POSTs the bundle here.

We deliberately keep the persistence layer on the frontend (Supabase + RLS) —
this module is stateless compute only. Same pattern as horizon_planner.py.

Sections produced:

  intro       — basic介绍 + 最新资讯 (1-2 paragraphs)
  dimensions  — { fundamentals, news, technical, sentiment } each with
                summary text + key bullet insights + signal (bullish/bearish/neutral)
  scenarios   — { base, bull, bear } each with probability + 可证伪预测 + 失效条件,
                plus a top-level checklist[] of observation items
  horizons    — { short (1-2m), mid (3-6m), long (6m+) } each with
                trend + target_price + confidence + strategy + key_risks
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Provider routing — mirrors horizon_planner.py so we stay consistent.
# ---------------------------------------------------------------------------

_PROVIDER_BASES: Dict[str, Dict[str, str]] = {
    "openai":    {"base_url": "https://api.openai.com/v1",                              "env": "OPENAI_API_KEY"},
    "deepseek":  {"base_url": "https://api.deepseek.com",                               "env": "DEEPSEEK_API_KEY"},
    "qwen":      {"base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "env": "DASHSCOPE_API_KEY"},
    "kimi":      {"base_url": "https://api.moonshot.cn/v1",                             "env": "MOONSHOT_API_KEY"},
    "glm":       {"base_url": "https://api.z.ai/api/paas/v4/",                          "env": "ZHIPU_API_KEY"},
}

_FALLBACK_ORDER = ["deepseek", "glm", "qwen", "kimi", "openai"]


def _pick_client(llm_provider: str, deep_model: str):
    try:
        from openai import OpenAI  # type: ignore
    except ImportError:
        logger.info("openai SDK not installed — comprehensive report unavailable")
        return None

    chosen = (llm_provider or "").lower().strip()
    candidates: List[str] = []
    if chosen in _PROVIDER_BASES:
        candidates.append(chosen)
    for p in _FALLBACK_ORDER:
        if p not in candidates:
            candidates.append(p)

    for p in candidates:
        cfg = _PROVIDER_BASES[p]
        key = os.environ.get(cfg["env"])
        if not key:
            continue
        try:
            client = OpenAI(api_key=key, base_url=cfg["base_url"])
        except Exception as e:
            logger.warning("comp-report: failed to init %s: %s", p, e)
            continue
        if p == chosen and deep_model:
            model = deep_model
        else:
            model = {
                "openai":   "gpt-5.4-mini",
                "deepseek": "deepseek-chat",
                "qwen":     "qwen-plus",
                "kimi":     "moonshot-v1-32k",
                "glm":      "glm-4.7-flash",
            }.get(p, deep_model or "")
        if not model:
            continue
        return client, model, p
    return None


# ---------------------------------------------------------------------------
# Decision distillation — collapse run_state into a compact text snapshot.
# ---------------------------------------------------------------------------

_MAX_DECISIONS = 12          # cap so the prompt stays within context window
_MAX_REPORT_CHARS = 1400      # per-section trim
_MAX_FINAL_CHARS = 2200       # final decision text — keep a bit more


def _trim(text: Optional[str], limit: int) -> str:
    if not text:
        return ""
    s = str(text).strip()
    if len(s) <= limit:
        return s
    return s[:limit].rstrip() + "…"


def _distill_decision(d: Dict[str, Any]) -> Dict[str, Any]:
    """Pull the substantive fields out of a single decision payload.

    The frontend sends each decision as `{id, ticker, trade_date, rating,
    completedAt, runState: {...}, params: {...}}`. We pluck only the
    high-signal markdown blobs so the LLM has enough context without us
    overloading it with metadata.
    """
    rs = d.get("runState") or d.get("run_state") or {}
    reports = rs.get("reports") or {}
    final = rs.get("finalDecision") or {}
    horizon = rs.get("horizon_plan") or {}
    matched = rs.get("matched_strategies") or {}

    return {
        "id": d.get("id"),
        "trade_date": d.get("trade_date") or d.get("tradeDate"),
        "completed_at": d.get("completedAt") or d.get("completed_at"),
        "rating": d.get("rating") or final.get("rating"),
        "params": {
            "research_depth": (d.get("params") or {}).get("research_depth"),
            "llm_provider":   (d.get("params") or {}).get("llm_provider"),
        },
        "reports": {
            "fundamentals": _trim(reports.get("fundamentals_report"), _MAX_REPORT_CHARS),
            "news":         _trim(reports.get("news_report"),         _MAX_REPORT_CHARS),
            "market":       _trim(reports.get("market_report"),       _MAX_REPORT_CHARS),
            "sentiment":    _trim(reports.get("sentiment_report"),    _MAX_REPORT_CHARS),
            "research_plan":      _trim(reports.get("investment_plan"),         _MAX_REPORT_CHARS),
            "trader_plan":        _trim(reports.get("trader_investment_plan"),  _MAX_REPORT_CHARS),
        },
        "final": {
            "rating":  final.get("rating"),
            "text":    _trim(final.get("raw_zh") or final.get("raw_en") or final.get("raw"), _MAX_FINAL_CHARS),
            "trader":  _trim(final.get("trader_plan"),  _MAX_REPORT_CHARS),
            "research":_trim(final.get("research_plan"), _MAX_REPORT_CHARS),
        },
        "horizon_plan_summary": _trim((horizon or {}).get("summary"), 400),
        "matched_strategies": [
            {"id": s.get("id"), "name": s.get("name"), "cat": s.get("cat")}
            for s in (matched.get("items") or [])[:5]
        ],
    }


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """你是一位顶级买方组合经理与卖方首席研究员的复合体，擅长把多智能体辩论的"流程数据"凝练为"基金经理可直接用"的综合研究档案。

任务：对于给定的某个资产标的，基于过去 N 次（N 可能为 1-12）多智能体决策的完整原始资料（基本面 / 新闻 / 市场技术 / 情绪 4 大分析报告、看多看空辩论、研究主管裁决、Trader 计划、风险三方辩论、组合经理终审、多周期执行方案），产出一份**综合研究报告**。

强制要求：
1. **严禁返回任何 markdown 围栏** — 只返回 JSON，且 JSON 必须能被严格解析。
2. **中文写作**，专业、克制、不堆形容词。引用具体数字、价位、时间窗口。
3. **要做时间序列推演** — 多次决策按时间排序，关注观点演化（强化 / 反转 / 漂移），在 intro 和 dimensions 里都要体现"上一次怎么看 / 这次怎么看 / 变化驱动"。
4. **可证伪** — 所有预测必须可证伪：写明价格水平、时间窗口、关键数据节点（财报、宏观、催化事件）。
5. **不要堆数据** — 同类信号合并为 1-2 条；优先输出"反直觉"或"分歧点"。

输出 JSON 结构（所有字段都必须存在；为空时填 "" 或 []）：

{
  "intro": {
    "name_zh": "中文公司名/资产名",
    "what_is_it": "1-2 句话说明这是什么（行业、商业模式 / 主要应用、规模感）",
    "latest_news": "最近 1-3 条最重要的资讯，2-3 句话总结",
    "narrative_shift": "纵观历次决策，主导叙事的变化（≤80 字）。若只有 1 次决策，写本次叙事核心"
  },
  "dimensions": {
    "fundamentals": {
      "signal": "bullish|bearish|neutral|mixed",
      "summary": "2-3 句基本面综合判断",
      "highlights": ["3-5 条要点，含具体数字"],
      "evolution": "历次决策中基本面判断的演化（≤60 字）"
    },
    "news": { 同结构 },
    "technical": { 同结构 — 这里说 'market technicals' 即价格 / 量能 / 指标 / 趋势 },
    "sentiment": { 同结构 — 情绪 / 社交 / 资金面 / 期权偏度 }
  },
  "scenarios": {
    "base": {
      "probability": 0.45,
      "narrative": "2-3 句基准情景叙事",
      "falsifiable_predictions": [
        "[3-5 条] 必须含价格 + 时间窗口 + 触发条件，如 '若 8 周内不能站稳 $120 则基准失效'"
      ],
      "invalidation": "什么数据 / 事件出现就推翻该情景（1 句）"
    },
    "bull": { 同结构 },
    "bear": { 同结构 },
    "checklist": [
      "[5-8 条] 未来需要持续观察的清单 — 每条具体到指标 / 数据源 / 时间节点，例如 '下一季度 cloud 收入 yoy > 35%' 或 'CPI 6 月读数低于 3.2%'"
    ]
  },
  "horizons": {
    "short": {
      "label": "短期 (1-2 个月)",
      "trend": "bullish|bearish|neutral|range_bound",
      "target_price": "$108-$115 或 $112（用美元符号；港股 / A 股可用其他货币符号）",
      "confidence": "high|medium|low",
      "summary": "1-2 句走势预测",
      "strategy": "1-3 句执行策略（建仓节奏 / 仓位 / 止损 / 减仓位置）",
      "key_risks": ["2-3 条该周期内最关键的风险"]
    },
    "mid":  { 同结构, label="中期 (3-6 个月)" },
    "long": { 同结构, label="长期 (6 个月以上)" }
  },
  "meta": {
    "headline": "≤30 字的一句话总览（基金经理日报标题风格）",
    "conviction": "high|medium|low — 整份报告的总体把握度",
    "key_debate": "≤60 字 — 多空之间最核心的分歧点"
  }
}
"""


def _build_user_payload(
    ticker: str,
    quote: Dict[str, Any],
    decisions: List[Dict[str, Any]],
) -> Dict[str, Any]:
    sorted_decisions = sorted(
        decisions,
        key=lambda d: d.get("completed_at") or d.get("completedAt") or "",
        reverse=True,
    )[:_MAX_DECISIONS]

    return {
        "ticker": ticker,
        "now_quote": {
            "price":       quote.get("price"),
            "change_pct":  quote.get("change_pct"),
            "open":        quote.get("open"),
            "high":        quote.get("high"),
            "low":         quote.get("low"),
            "prev_close":  quote.get("prev_close"),
            "market_cap":  quote.get("market_cap"),
            "pe_ratio":    quote.get("pe_ratio"),
            "name":        quote.get("name"),
            "source":      quote.get("source"),
        },
        "decision_count": len(sorted_decisions),
        "decisions_newest_first": [_distill_decision(d) for d in sorted_decisions],
    }


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------

def generate(
    ticker: str,
    decisions: List[Dict[str, Any]],
    quote: Optional[Dict[str, Any]] = None,
    llm_provider: str = "",
    deep_model: str = "",
) -> Optional[Dict[str, Any]]:
    """Synthesise a comprehensive report.

    Returns the structured dict on success, ``None`` on any failure. Callers
    are expected to degrade gracefully (the UI shows a fallback message).
    """
    if os.environ.get("COMPREHENSIVE_REPORT", "1").lower() in ("0", "false", "off"):
        return None
    if not ticker or not decisions:
        return None

    picked = _pick_client(llm_provider, deep_model)
    if not picked:
        logger.info("comp-report: no usable provider key in env")
        return None
    client, model, provider_used = picked

    if not quote:
        try:
            from quotes import fetch_quotes
            items = fetch_quotes([ticker])
            quote = items[0] if items else {}
        except Exception as e:
            logger.debug("comp-report: quote fetch failed for %s: %s", ticker, e)
            quote = {}

    payload = _build_user_payload(ticker, quote or {}, decisions)

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user",   "content": json.dumps(payload, ensure_ascii=False)},
            ],
            temperature=0.4,
            max_tokens=5500,
            timeout=120,
        )
        raw = (resp.choices[0].message.content or "").strip()
    except Exception as e:
        logger.warning("comp-report LLM call failed (%s/%s): %s", provider_used, model, e)
        return None

    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", raw, flags=re.S).strip()

    try:
        report = json.loads(raw)
    except Exception as e:
        logger.warning("comp-report JSON parse failed: %s; raw[:200]=%s", e, raw[:200])
        return None

    for key in ("intro", "dimensions", "scenarios", "horizons", "meta"):
        report.setdefault(key, {})
    report.setdefault("_provider", provider_used)
    report.setdefault("_model", model)
    return report
