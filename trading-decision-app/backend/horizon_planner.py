"""
Multi-horizon decision planner.

Takes the TradingAgents final decision + matched strategies and asks the
user-selected DEEP-thinking LLM to produce a quantitative plan split across
three horizons:

  - short  (1-2 months)
  - mid    (3-6 months)
  - long   (6+ months)

Each horizon carries:
  - target price (or band) anchored to the current quote
  - stop loss
  - expected return %
  - confidence (low/medium/high)
  - 3 scenarios (bull/base/bear) with probability + trigger + target action
  - execution playbook (entry plan, size, stop, take-profit ladder, monitors)
  - referenced strategies (by id, picked from the matched-strategies list)
  - adjustment rules (if/then conditional moves as the scenario plays out)

The planner deliberately calls the *deep* model because the prompts require
multi-step reasoning across price scenarios; cost is one extra deep-LLM call
per decision (similar order of magnitude to one analyst pass).
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Provider routing: map (llm_provider, model) → OpenAI-compatible client.
# Mirrors the routing used by translator.py / strategy_matcher.py — anything
# that speaks the OpenAI Chat Completions API can plug in here.
# ---------------------------------------------------------------------------

_PROVIDER_BASES: Dict[str, Dict[str, str]] = {
    "openai":    {"base_url": "https://api.openai.com/v1",                              "env": "OPENAI_API_KEY"},
    "deepseek":  {"base_url": "https://api.deepseek.com",                               "env": "DEEPSEEK_API_KEY"},
    "qwen":      {"base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "env": "DASHSCOPE_API_KEY"},
    "kimi":      {"base_url": "https://api.moonshot.cn/v1",                             "env": "MOONSHOT_API_KEY"},
    "glm":       {"base_url": "https://api.z.ai/api/paas/v4/",                          "env": "ZHIPU_API_KEY"},
}

# Order to try when the user-selected provider has no key set.
_FALLBACK_ORDER = ["deepseek", "qwen", "glm", "kimi", "openai"]


def _pick_client(llm_provider: str, deep_model: str):
    """Return (client, model_name, provider_used) for the deep LLM, falling
    back across OpenAI-compatible providers when the chosen one has no key.

    Anthropic / Google models can't be reached through the OpenAI SDK without
    a translation shim — we degrade to the first OpenAI-compatible provider
    that *does* have a key. The final decision text is already in hand, so
    losing the user's preferred deep model just means a different model
    summarises an already-completed analysis.
    """
    try:
        from openai import OpenAI  # type: ignore
    except ImportError:
        logger.info("openai SDK not installed — skipping horizon planner")
        return None

    candidates: List[str] = []
    chosen = (llm_provider or "").lower().strip()
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
            logger.warning("planner: failed to init %s: %s", p, e)
            continue
        # Use the user's deep model only when staying on their provider;
        # otherwise route to the provider's known-good default.
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
# Current-price anchor — lets the LLM tie targets to a real number.
# ---------------------------------------------------------------------------

def _current_quote(ticker: str) -> Dict[str, Any]:
    """Best-effort live quote for the ticker. Returns {} on any failure so
    the planner still produces a (less-grounded) plan in the worst case."""
    if not ticker:
        return {}
    try:
        from quotes import fetch_quotes  # local import keeps cold start fast
        items = fetch_quotes([ticker])
        return items[0] if items else {}
    except Exception as e:
        logger.debug("planner: quote fetch failed for %s: %s", ticker, e)
        return {}


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

_HORIZON_LABELS = {
    "short": "短期 (1-2 个月)",
    "mid":   "中期 (3-6 个月)",
    "long":  "长期 (6 个月以上)",
}


_PLANNER_SYSTEM = """你是一名顶级买方组合经理，专长是把多智能体研究结论翻译成可执行的多周期交易方案。
你的任务是基于给定的最终决策、解析信号、匹配策略与当前行情，输出三档时间周期的目标价位与执行策略。

要求：
1. **三个周期都要给出**：short (1-2 个月)、mid (3-6 个月)、long (6 个月以上)。即使观点是 Hold/Sell 也要给。
2. **目标价必须是数字**（区间用 "$108-$115" 这种字符串，单一价用 "$112"）。所有数字必须围绕当前价合理推演，不要凭空给数字。
3. **每个周期 3 个情景**：bull / base / bear。三者概率之和必须 = 1.00。每个情景要写：
     - probability（0-1 之间的浮点）
     - trigger（触发条件，要量化：价格水平、技术信号、季报、宏观事件）
     - target_price（该情景下的目标价）
     - action（该情景下应做什么：加仓 / 持有 / 减仓 / 退出 / 反手 / 对冲）
4. **execution（执行计划）必须可下单**：entry / size / stop / take_profit_ladder / monitors。
     - entry 要写价位和分批方法（"现价 + 回调 -3% 各 50%"）
     - size 用"组合 N%"或"风险预算的 N%"
     - stop 是绝对价 + 触发条件
     - take_profit_ladder 是 2-4 级（["$110: 减 1/3", "$120: 减 1/3", "余下移动止损"]）
     - monitors 是 2-4 条需要盯的信号
5. **strategies**：从输入的 candidate_strategies 里挑 1-3 个 id（不要发明新策略，也不要重复匹配器已挑过但与本周期不符的项）。
6. **adjustments**：3-5 条 if-then 规则，覆盖最常见的偏离场景，要量化条件。
7. **confidence**：low / medium / high，反映你对该周期目标价的把握度（中期把握往往最高）。
8. 严禁返回任何 markdown 围栏。仅 JSON，结构如下：
{
  "summary": "一句话总览（中文，≤60 字）",
  "horizons": {
    "short": {
      "target_price": "...",
      "expected_return_pct": 0.0,
      "stop_loss": "...",
      "confidence": "high/medium/low",
      "scenarios": [
        {"name": "bull", "probability": 0.45, "trigger": "...", "target_price": "...", "action": "..."},
        {"name": "base", "probability": 0.35, "trigger": "...", "target_price": "...", "action": "..."},
        {"name": "bear", "probability": 0.20, "trigger": "...", "target_price": "...", "action": "..."}
      ],
      "execution": {
        "entry": "...", "size": "...", "stop": "...",
        "take_profit_ladder": ["..."],
        "monitors": ["..."]
      },
      "strategies": ["s_id_1"],
      "adjustments": [
        {"if": "...", "then": "..."}
      ]
    },
    "mid":  { ... 同结构 ... },
    "long": { ... 同结构 ... }
  }
}
"""


def _build_user_payload(
    decision: Dict[str, Any],
    parsed: Dict[str, Any],
    params: Dict[str, Any],
    matched_strategies: List[Dict[str, Any]],
    quote: Dict[str, Any],
) -> Dict[str, Any]:
    rating = decision.get("rating") or "Hold"
    # Trim verbose fields so the prompt stays under provider context limits
    # even for max-depth runs that produce very long decision texts.
    raw_text = (decision.get("raw") or "")[:5000]
    trader_plan = (decision.get("trader_plan") or "")[:2000]
    research_plan = (decision.get("research_plan") or "")[:1500]

    return {
        "ticker": params.get("ticker") or decision.get("ticker") or "未知",
        "trade_date": params.get("trade_date") or "",
        "rating": rating,
        "risk_tolerance": params.get("risk_tolerance") or 3,
        "parsed_signals": {
            "view":       parsed.get("view"),
            "horizon":    parsed.get("horizon"),
            "volatility": parsed.get("volatility"),
        },
        "current_quote": {
            "price":       quote.get("price"),
            "change_pct":  quote.get("change_pct"),
            "open":        quote.get("open"),
            "high":        quote.get("high"),
            "low":         quote.get("low"),
            "prev_close":  quote.get("prev_close"),
            "market_cap":  quote.get("market_cap"),
            "pe_ratio":    quote.get("pe_ratio"),
            "source":      quote.get("source"),
        },
        "horizon_labels": _HORIZON_LABELS,
        "final_decision_text":   raw_text,
        "trader_plan_text":      trader_plan,
        "research_plan_text":    research_plan,
        "candidate_strategies": [
            {
                "id":         s.get("id"),
                "name":       s.get("name"),
                "cat":        s.get("cat"),
                "horizon":    s.get("horizon"),
                "view":       s.get("view"),
                "risk":       s.get("risk"),
                "desc":       (s.get("desc") or "")[:200],
            }
            for s in (matched_strategies or [])
        ],
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def build_plan(
    decision: Dict[str, Any],
    matched_strategies_payload: Dict[str, Any],
    params: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Build the multi-horizon plan.

    Args:
        decision:                   the ``decision`` dict from a final_decision SSE event.
        matched_strategies_payload: the dict returned by ``match_strategies``
                                    (has ``items`` and ``parsed`` keys).
        params:                     the request params (ticker, llm_provider, deep_think_llm, ...).

    Returns:
        The validated plan dict or None on any failure. Callers should be
        prepared for None and degrade gracefully (the UI shows a fallback).
    """
    if os.environ.get("HORIZON_PLANNER", "1").lower() in ("0", "false", "off"):
        return None

    picked = _pick_client(params.get("llm_provider", ""), params.get("deep_think_llm", ""))
    if not picked:
        logger.info("planner: no usable OpenAI-compatible provider key in env")
        return None
    client, model, provider_used = picked

    parsed = (matched_strategies_payload or {}).get("parsed") or {}
    matched = (matched_strategies_payload or {}).get("items") or []
    ticker = params.get("ticker") or decision.get("ticker") or ""
    quote = _current_quote(ticker)

    payload = _build_user_payload(decision, parsed, params, matched, quote)

    try:
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _PLANNER_SYSTEM},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
            temperature=0.4,
            max_tokens=4500,
            timeout=90,
        )
        raw = (resp.choices[0].message.content or "").strip()
    except Exception as e:
        logger.warning("planner LLM call failed (%s/%s): %s", provider_used, model, e)
        return None

    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", raw).strip()

    try:
        plan = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.warning("planner: invalid JSON (%s); first 200: %s", e, raw[:200])
        return None

    plan = _validate(plan)
    plan["current_price"] = quote.get("price")
    plan["quote_source"] = quote.get("source")
    plan["ticker"] = ticker
    plan["model"] = model
    plan["provider"] = provider_used
    plan["labels"] = _HORIZON_LABELS
    return plan


# ---------------------------------------------------------------------------
# Light validation — keep the UI safe from malformed LLM output.
# ---------------------------------------------------------------------------

def _validate(plan: Any) -> Dict[str, Any]:
    """Normalise the plan dict so all fields the UI expects are present."""
    if not isinstance(plan, dict):
        return {"summary": "", "horizons": {}}
    horizons = plan.get("horizons") or {}
    if not isinstance(horizons, dict):
        horizons = {}

    cleaned_horizons: Dict[str, Dict[str, Any]] = {}
    for key in ("short", "mid", "long"):
        h = horizons.get(key) if isinstance(horizons.get(key), dict) else {}
        cleaned_horizons[key] = {
            "target_price":        _as_str(h.get("target_price")),
            "expected_return_pct": _as_num(h.get("expected_return_pct")),
            "stop_loss":           _as_str(h.get("stop_loss")),
            "confidence":          _as_confidence(h.get("confidence")),
            "scenarios":           _clean_scenarios(h.get("scenarios")),
            "execution":           _clean_execution(h.get("execution")),
            "strategies":          [s for s in (h.get("strategies") or []) if isinstance(s, str)][:3],
            "adjustments":         _clean_adjustments(h.get("adjustments")),
        }

    return {
        "summary":  _as_str(plan.get("summary"))[:280],
        "horizons": cleaned_horizons,
    }


def _as_str(v: Any) -> str:
    if v is None:
        return ""
    return str(v)


def _as_num(v: Any) -> Optional[float]:
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _as_confidence(v: Any) -> str:
    s = (str(v or "")).lower().strip()
    return s if s in ("low", "medium", "high") else "medium"


def _clean_scenarios(scs: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not isinstance(scs, list):
        return out
    for s in scs:
        if not isinstance(s, dict):
            continue
        name = str(s.get("name") or "").lower()
        if name not in ("bull", "base", "bear"):
            continue
        out.append({
            "name":         name,
            "probability":  max(0.0, min(1.0, _as_num(s.get("probability")) or 0.0)),
            "trigger":      _as_str(s.get("trigger")),
            "target_price": _as_str(s.get("target_price")),
            "action":       _as_str(s.get("action")),
        })
    # Sort so bull / base / bear always render in that order
    order = {"bull": 0, "base": 1, "bear": 2}
    out.sort(key=lambda x: order.get(x["name"], 99))
    return out


def _clean_execution(ex: Any) -> Dict[str, Any]:
    if not isinstance(ex, dict):
        return {}
    ladder = ex.get("take_profit_ladder")
    monitors = ex.get("monitors")
    return {
        "entry":              _as_str(ex.get("entry")),
        "size":               _as_str(ex.get("size")),
        "stop":               _as_str(ex.get("stop")),
        "take_profit_ladder": [str(x) for x in ladder if isinstance(x, (str, int, float))][:6] if isinstance(ladder, list) else [],
        "monitors":           [str(x) for x in monitors if isinstance(x, (str, int, float))][:6] if isinstance(monitors, list) else [],
    }


def _clean_adjustments(adj: Any) -> List[Dict[str, str]]:
    if not isinstance(adj, list):
        return []
    out = []
    for a in adj:
        if not isinstance(a, dict):
            continue
        out.append({
            "if":   _as_str(a.get("if")),
            "then": _as_str(a.get("then")),
        })
    return out[:6]
