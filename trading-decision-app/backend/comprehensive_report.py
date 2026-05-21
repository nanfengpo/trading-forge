"""
Comprehensive Report Generator.

Aggregates ALL historical decisions for a given (user, ticker) into a single
multi-section synthesis. The frontend collects the user's decisions (which are
already RLS-scoped in Supabase), trims them, then POSTs the bundle here.

We deliberately keep the persistence layer on the frontend (Supabase + RLS) —
this module is stateless compute only.

Return contract (NEW): always a dict with either ``report`` (success) or
``error`` (failure with diagnostic). Server surfaces the error to the UI so
the user can see what went wrong instead of "unknown failure".
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Provider routing
# ---------------------------------------------------------------------------
#
# Two call shapes are supported:
#   - openai_compat: standard OpenAI Chat Completions (OpenAI itself + DeepSeek
#     + Qwen + Kimi + GLM + Google Gemini's OpenAI-compat endpoint)
#   - anthropic:     Anthropic Messages API (Claude) via the anthropic SDK
#
# Fallback order tries the user's chosen provider first, then walks down the
# priority list. Each candidate with a configured env key is attempted; if the
# LLM call or JSON parse fails, we capture the error string and move on.

_OPENAI_COMPAT: Dict[str, Dict[str, str]] = {
    "openai":    {"base_url": "https://api.openai.com/v1",                                "env": "OPENAI_API_KEY",   "default_model": "gpt-5.4-mini"},
    "deepseek":  {"base_url": "https://api.deepseek.com",                                 "env": "DEEPSEEK_API_KEY", "default_model": "deepseek-chat"},
    "qwen":      {"base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",   "env": "DASHSCOPE_API_KEY","default_model": "qwen-plus"},
    "kimi":      {"base_url": "https://api.moonshot.cn/v1",                               "env": "MOONSHOT_API_KEY", "default_model": "moonshot-v1-32k"},
    "glm":       {"base_url": "https://api.z.ai/api/paas/v4/",                            "env": "ZHIPU_API_KEY",    "default_model": "glm-4.7-flash"},
    "google":    {"base_url": "https://generativelanguage.googleapis.com/v1beta/openai/", "env": "GOOGLE_API_KEY",   "default_model": "gemini-3.1-flash"},
}

# NB: comp-report always wants the strongest available reasoning model — the
# user's decision pipeline may run on a cheap quick-LLM, but here we synthesise
# many decisions into one definitive research dossier, so we default to
# Claude Opus 4.7 (the current flagship) whenever ANTHROPIC_API_KEY is set.
_ANTHROPIC_CFG = {"env": "ANTHROPIC_API_KEY", "default_model": "claude-opus-4-7"}

_FALLBACK_ORDER = ["anthropic", "deepseek", "glm", "qwen", "google", "kimi", "openai"]

# Force anthropic to the head whenever its key is set — overrides whatever
# `llm_provider` the frontend passes (the user runs decisions on cheap models
# but wants the synthesis on Opus). Set COMPREHENSIVE_REPORT_PROVIDER=user to
# disable this behaviour and honor the user's preference instead.
_FORCE_BEST_MODEL = os.environ.get("COMPREHENSIVE_REPORT_PROVIDER", "best").lower() != "user"


def _provider_env(name: str) -> Optional[str]:
    if name == "anthropic":
        return _ANTHROPIC_CFG["env"]
    cfg = _OPENAI_COMPAT.get(name)
    return cfg["env"] if cfg else None


def _provider_default_model(name: str) -> str:
    if name == "anthropic":
        return _ANTHROPIC_CFG["default_model"]
    cfg = _OPENAI_COMPAT.get(name)
    return cfg["default_model"] if cfg else ""


def _resolve_candidates(llm_provider: str) -> List[str]:
    chosen = (llm_provider or "").lower().strip()
    candidates: List[str] = []
    # When _FORCE_BEST_MODEL is on (default) and ANTHROPIC_API_KEY is configured,
    # try Anthropic Opus first regardless of what the user picked — the comp
    # report deserves the strongest reasoning model.
    if _FORCE_BEST_MODEL and os.environ.get(_ANTHROPIC_CFG["env"]):
        candidates.append("anthropic")
    if chosen and _provider_env(chosen) and os.environ.get(_provider_env(chosen) or "") and chosen not in candidates:
        candidates.append(chosen)
    for p in _FALLBACK_ORDER:
        env = _provider_env(p)
        if p not in candidates and env and os.environ.get(env):
            candidates.append(p)
    return candidates


# ---------------------------------------------------------------------------
# Decision distillation
# ---------------------------------------------------------------------------

_MAX_DECISIONS = 12
_MAX_REPORT_CHARS = 1400
_MAX_FINAL_CHARS = 2200


def _trim(text: Optional[str], limit: int) -> str:
    if not text:
        return ""
    s = str(text).strip()
    if len(s) <= limit:
        return s
    return s[:limit].rstrip() + "…"


def _distill_decision(d: Dict[str, Any]) -> Dict[str, Any]:
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
            "fundamentals":  _trim(reports.get("fundamentals_report"),       _MAX_REPORT_CHARS),
            "news":          _trim(reports.get("news_report"),               _MAX_REPORT_CHARS),
            "market":        _trim(reports.get("market_report"),             _MAX_REPORT_CHARS),
            "sentiment":     _trim(reports.get("sentiment_report"),          _MAX_REPORT_CHARS),
            "research_plan": _trim(reports.get("investment_plan"),           _MAX_REPORT_CHARS),
            "trader_plan":   _trim(reports.get("trader_investment_plan"),    _MAX_REPORT_CHARS),
        },
        "final": {
            "rating":   final.get("rating"),
            "text":     _trim(final.get("raw_zh") or final.get("raw_en") or final.get("raw"), _MAX_FINAL_CHARS),
            "trader":   _trim(final.get("trader_plan"),   _MAX_REPORT_CHARS),
            "research": _trim(final.get("research_plan"), _MAX_REPORT_CHARS),
        },
        "horizon_plan_summary": _trim((horizon or {}).get("summary"), 400),
        "matched_strategies": [
            {"id": s.get("id"), "name": s.get("name"), "cat": s.get("cat"),
             "horizon": s.get("horizon"), "view": s.get("view"), "score": s.get("score")}
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
6. **horizons.{short|mid|long}.strategy** 必须**包含完整可执行方案**：建仓节奏（分批/价位）+ 仓位（%NAV）+ 止损价 + 减仓阶梯 + 需盯的信号。若 candidate_strategies 里有合适的策略库匹配项，把策略名 + 关键参数嵌入 strategy 字段，**不要**单独保留 strategies 字段。

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
    "news":      { 同结构 },
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
      "[5-8 条] 未来需要持续观察的清单 — 每条具体到指标 / 数据源 / 时间节点"
    ]
  },
  "horizons": {
    "short": {
      "label": "短期 (1-2 个月)",
      "trend": "bullish|bearish|neutral|range_bound",
      "target_price": "$108-$115 或 $112（用美元符号；港股 / A 股可用其他货币符号）",
      "confidence": "high|medium|low",
      "summary": "1-2 句走势预测",
      "strategy": "完整可执行方案：建仓节奏 + 仓位 + 止损 + 减仓阶梯 + 需盯的信号 + 关联的策略库方案 (3-5 句)",
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


def _build_user_payload(ticker: str, quote: Dict[str, Any], decisions: List[Dict[str, Any]]) -> Dict[str, Any]:
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
# LLM dispatch
# ---------------------------------------------------------------------------

def _strip_fence(raw: str) -> str:
    raw = (raw or "").strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", raw, flags=re.S).strip()
    return raw


def _parse_report(raw: str) -> Dict[str, Any]:
    raw = _strip_fence(raw)
    return json.loads(raw)


def _call_openai_compat(provider: str, model: str, payload: Dict[str, Any]) -> str:
    """Send the prompt via an OpenAI-compatible Chat Completions endpoint."""
    from openai import OpenAI  # type: ignore
    cfg = _OPENAI_COMPAT[provider]
    key = os.environ[cfg["env"]]
    client = OpenAI(api_key=key, base_url=cfg["base_url"])
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
    return (resp.choices[0].message.content or "").strip()


def _call_anthropic(model: str, payload: Dict[str, Any]) -> str:
    """Send the prompt via the Anthropic Messages API (Claude)."""
    try:
        import anthropic  # type: ignore
    except ImportError as e:
        raise RuntimeError("anthropic SDK not installed") from e
    key = os.environ[_ANTHROPIC_CFG["env"]]
    client = anthropic.Anthropic(api_key=key, timeout=120)
    resp = client.messages.create(
        model=model,
        max_tokens=5500,
        temperature=0.4,
        system=_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
    )
    parts: List[str] = []
    for blk in resp.content or []:
        text = getattr(blk, "text", None)
        if text:
            parts.append(text)
    return "".join(parts).strip()


def _dispatch(provider: str, model: str, payload: Dict[str, Any]) -> str:
    if provider == "anthropic":
        return _call_anthropic(model, payload)
    return _call_openai_compat(provider, model, payload)


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------

def generate(
    ticker: str,
    decisions: List[Dict[str, Any]],
    quote: Optional[Dict[str, Any]] = None,
    llm_provider: str = "",
    deep_model: str = "",
) -> Dict[str, Any]:
    """Synthesise a comprehensive report.

    Returns:
      Success: ``{"ok": True, "report": {...}, "provider": str, "model": str}``
      Failure: ``{"ok": False, "error": str, "tried": [{"provider","model","error"}, ...]}``
    """
    if os.environ.get("COMPREHENSIVE_REPORT", "1").lower() in ("0", "false", "off"):
        return {"ok": False, "error": "COMPREHENSIVE_REPORT disabled via env"}
    if not ticker:
        return {"ok": False, "error": "missing ticker"}
    if not decisions:
        return {"ok": False, "error": "no decisions provided — generate at least one decision first"}

    candidates = _resolve_candidates(llm_provider)
    if not candidates:
        return {
            "ok": False,
            "error": "no LLM provider API key configured — set ANTHROPIC_API_KEY / "
                     "DEEPSEEK_API_KEY / OPENAI_API_KEY / etc.",
        }

    if not quote:
        try:
            from quotes import fetch_quotes
            items = fetch_quotes([ticker])
            quote = items[0] if items else {}
        except Exception as e:
            logger.debug("comp-report: quote fetch failed for %s: %s", ticker, e)
            quote = {}

    payload = _build_user_payload(ticker, quote or {}, decisions)

    tried: List[Dict[str, str]] = []
    chosen = (llm_provider or "").lower().strip()
    for provider in candidates:
        # Default to the provider's flagship model — Anthropic = Opus 4.7,
        # the strongest available reasoning model. Honor user override only
        # if (a) we're not in force-best mode, OR (b) user explicitly named
        # this provider AND _FORCE_BEST_MODEL is disabled.
        force_default = _FORCE_BEST_MODEL or provider != chosen
        if force_default:
            model = _provider_default_model(provider)
        else:
            model = deep_model or _provider_default_model(provider)
        if not model:
            tried.append({"provider": provider, "model": "(unknown)", "error": "no default model"})
            continue
        try:
            raw = _dispatch(provider, model, payload)
        except Exception as e:
            msg = str(e)[:300]
            tried.append({"provider": provider, "model": model, "error": f"LLM call: {msg}"})
            logger.warning("comp-report LLM call failed (%s/%s): %s", provider, model, msg)
            continue
        try:
            report = _parse_report(raw)
        except Exception as e:
            msg = f"JSON parse: {e}; head={raw[:160]!r}"
            tried.append({"provider": provider, "model": model, "error": msg[:300]})
            logger.warning("comp-report parse failed (%s/%s): %s", provider, model, msg[:200])
            continue

        for key in ("intro", "dimensions", "scenarios", "horizons", "meta"):
            report.setdefault(key, {})
        report["_provider"] = provider
        report["_model"] = model
        return {"ok": True, "report": report, "provider": provider, "model": model}

    summary = "; ".join(f"{t['provider']}({t['model']}): {t['error']}" for t in tried) or "no providers attempted"
    return {"ok": False, "error": f"all providers failed — {summary}", "tried": tried}
