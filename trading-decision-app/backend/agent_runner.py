"""
Wraps TradingAgentsGraph and emits progress events for the SSE channel.

Two modes:
  - LIVE  - calls into the real TradingAgents graph (needs API keys + deps)
  - DEMO  - emits a scripted sequence of realistic events; lets the UI be
            developed and demo'd without burning LLM tokens

The mode is auto-detected: if TradingAgents and a provider key are available
the runner tries LIVE; otherwise it falls back to DEMO. The user can also pin
the mode via the `mode` field in the request body.
"""

from __future__ import annotations

import asyncio
import dataclasses
import itertools
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from translator import Translator

logger = logging.getLogger(__name__)


# NOTE: Kimi (Moonshot) is now natively supported in TradingAgents — see
# patches/0001-add-kimi-provider.patch (registered in tradingagents/
# llm_clients/factory.py and openai_client.py). The previous runtime
# monkey-patch was removed in v6.


def _premium_vendor_routing(default_vendors: Dict[str, str]) -> Dict[str, str]:
    """Build a TradingAgents data_vendors mapping that prefers our premium
    sources whenever their API keys are configured, falling back to the
    framework's defaults (yfinance / alpha_vantage) otherwise.

    The mapping uses TradingAgents' own ``"vendor1,vendor2"`` syntax so
    ``route_to_vendor()`` tries the premium one first and falls through
    to the next when it raises (e.g. when the key is invalid or the API
    is rate-limited).
    """
    out = dict(default_vendors)
    try:
        from dataflows.registry import Registry  # type: ignore
    except Exception:
        return out  # premium dataflows not loadable — keep defaults

    # Map TradingAgents category → premium dataflows category
    cat_map = {
        "news_data":          "news",
        "core_stock_apis":    "market",
        "technical_indicators":"market",
        "fundamental_data":   "fundamentals",
    }
    for ta_cat, premium_cat in cat_map.items():
        for vmeta in Registry.list_for_category(premium_cat):
            if vmeta.api_key_env and os.environ.get(vmeta.api_key_env):
                # Put the premium vendor first in the fallback chain
                existing = out.get(ta_cat, "")
                if vmeta.name not in existing:
                    out[ta_cat] = f"{vmeta.name},{existing}" if existing else vmeta.name
                break  # one premium vendor per category is enough
    return out

# Map of analyst keys -> display names (matches CLI MessageBuffer).
# Wire key stays "social" for saved-config back-compat; display is
# "Sentiment Analyst" since v0.2.5 (renamed agent now ingests news +
# StockTwits + Reddit, not just social media). See upstream #557.
ANALYST_DISPLAY = {
    "market": "Market Analyst",
    "social": "Sentiment Analyst",
    "news": "News Analyst",
    "fundamentals": "Fundamentals Analyst",
}

ANALYST_REPORT_KEY = {
    "market": "market_report",
    "social": "sentiment_report",
    "news": "news_report",
    "fundamentals": "fundamentals_report",
}

DEFAULT_ANALYSTS = ["market", "social", "news", "fundamentals"]

# Pipeline stages used to drive the progress UI.
PIPELINE_AGENTS = [
    {"id": "market", "name": "Market Analyst", "team": "Analyst Team"},
    {"id": "social", "name": "Sentiment Analyst", "team": "Analyst Team"},
    {"id": "news", "name": "News Analyst", "team": "Analyst Team"},
    {"id": "fundamentals", "name": "Fundamentals Analyst", "team": "Analyst Team"},
    {"id": "bull", "name": "Bull Researcher", "team": "Research Team"},
    {"id": "bear", "name": "Bear Researcher", "team": "Research Team"},
    {"id": "research_manager", "name": "Research Manager", "team": "Research Team"},
    {"id": "trader", "name": "Trader", "team": "Trading Team"},
    {"id": "aggressive", "name": "Aggressive Analyst", "team": "Risk Management"},
    {"id": "neutral", "name": "Neutral Analyst", "team": "Risk Management"},
    {"id": "conservative", "name": "Conservative Analyst", "team": "Risk Management"},
    {"id": "portfolio_manager", "name": "Portfolio Manager", "team": "Portfolio Management"},
]


@dataclass
class AnalysisRequest:
    ticker: str
    trade_date: str
    analysts: List[str] = field(default_factory=lambda: list(DEFAULT_ANALYSTS))
    llm_provider: str = "openai"
    deep_think_llm: str = "gpt-4o-mini"
    quick_think_llm: str = "gpt-4o-mini"
    research_depth: int = 1
    backend_url: Optional[str] = None
    output_language: str = "Chinese"
    mode: str = "auto"
    # Multi-tenant: per-request API key overrides (passed by the frontend
    # from the signed-in user's profile). Filtered through key_injector's
    # allowlist; never persisted with the decision.
    api_keys: Dict[str, str] = field(default_factory=dict)
    # Stable user id (Supabase auth.uid()) — used by the DB-backed usage
    # logger to attribute calls. None for anonymous (single-tenant mode).
    user_id: Optional[str] = None
    # Performance toggles. Default off for safety; enable per-request or
    # via env (TRADINGAGENTS_PARALLEL_ANALYSTS=1, TRADINGAGENTS_STRUCTURED_REPORTS=1).
    parallel_analysts: bool = False
    structured_reports: bool = False

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AnalysisRequest":
        kwargs = {f.name: d[f.name] for f in dataclasses.fields(cls) if f.name in d}
        # normalise depth (accept 1-5)
        if "research_depth" in kwargs:
            try:
                kwargs["research_depth"] = max(1, min(5, int(kwargs["research_depth"])))
            except (TypeError, ValueError):
                kwargs["research_depth"] = 1
        # ensure analysts is a list
        if "analysts" in kwargs and not isinstance(kwargs["analysts"], list):
            kwargs["analysts"] = list(kwargs["analysts"])
        return cls(**kwargs)


class AgentRunner:
    def __init__(self, request_data: AnalysisRequest, on_event: Callable[[Dict[str, Any]], None]):
        self.req = request_data
        self._raw_emit = on_event
        self._cancel = threading.Event()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self.translator: Optional[Translator] = None
        self._msg_id_counter = itertools.count(1)
        self._stats_handler = None         # set in _run_live
        self._granular_handler = None
        self._last_chunk = None            # captured for #10 structured extraction
        self._run_started_at = time.time()

    # public ---------------------------------------------------------------

    def cancel(self) -> None:
        self._cancel.set()
        if self.translator:
            self.translator.shutdown()

    async def run(self) -> None:
        """Entry point: emit the agent map, decide mode, drive the pipeline."""
        self._loop = asyncio.get_running_loop()
        # Kick off a translator (no-op if target is English / no key found).
        self.translator = Translator(target_lang=self.req.output_language)

        self.emit({
            "type": "init",
            "ticker": self.req.ticker,
            "trade_date": self.req.trade_date,
            "selected_analysts": self.req.analysts,
            "agents": PIPELINE_AGENTS,
            "config": {
                "llm_provider": self.req.llm_provider,
                "deep_think_llm": self.req.deep_think_llm,
                "quick_think_llm": self.req.quick_think_llm,
                "research_depth": self.req.research_depth,
                "language": self.req.output_language,
            },
            "translation": self.translator.status(),
        })

        mode = self._decide_mode()
        self.emit({"type": "mode", "mode": mode})

        try:
            if mode == "live":
                await asyncio.to_thread(self._run_live)
            else:
                await self._run_demo()
        except Exception as e:
            logger.exception("agent runner failed")
            self.emit({"type": "error", "message": str(e)})
        else:
            # Emit usage telemetry just before complete so the front-end
            # can store it with the decision (frontend listens for `usage`).
            self.emit({"type": "usage", "stats": self._collect_usage()})
            self.emit({"type": "complete"})
        finally:
            if self.translator:
                self.translator.shutdown()

    # ---- emit + translate ------------------------------------------------

    def emit(self, evt: Dict[str, Any]) -> None:
        """Emit raw, then schedule background translation for translatable events.

        Adds ``msg_id`` to every event that the front-end might want to patch.
        When translation completes, emits a ``translation`` event whose
        ``target`` points at the field to replace and ``msg_id`` to the
        original event.
        """
        evt.setdefault("msg_id", f"m{next(self._msg_id_counter)}")
        self._raw_emit(evt)

        # Translate?
        if not self.translator or not self.translator.is_available():
            return

        t = evt.get("type")
        # Skip log events — they're short status messages and would flood the
        # translation pool. The substantive output goes through report /
        # debate / risk_debate / final_decision.
        if t in ("report", "debate", "risk_debate"):
            text = evt.get("content")
            if isinstance(text, str) and text.strip():
                self._schedule_patch(evt["msg_id"], "content", text)
        elif t == "final_decision":
            dec = evt.get("decision") or {}
            for key in ("raw", "trader_plan", "research_plan"):
                text = dec.get(key)
                if isinstance(text, str) and text.strip():
                    self._schedule_patch(evt["msg_id"], f"decision.{key}", text)

    def _collect_usage(self) -> Dict[str, Any]:
        """Snapshot LLM/tool usage from StatsCallbackHandler + dataflow cache."""
        out: Dict[str, Any] = {
            "elapsed_sec": round(time.time() - self._run_started_at, 1),
            "provider": self.req.llm_provider,
            "deep_model": self.req.deep_think_llm,
            "quick_model": self.req.quick_think_llm,
        }
        if self._stats_handler is not None:
            try:
                out.update(self._stats_handler.get_stats())
            except Exception as e:
                logger.warning("collect stats failed: %s", e)
        try:
            from dataflows.cache import cache_stats as _cstats
            out["dataflow_cache"] = _cstats()
        except Exception:
            pass
        return out

    def _schedule_patch(self, msg_id: str, target: str, text: str) -> None:
        if not self.translator:
            return
        loop = self._loop

        def _on_done(translated: str) -> None:
            patch = {
                "type": "translation",
                "msg_id": msg_id,
                "target": target,
                "content": translated,
            }
            # back to the asyncio loop so the SSE queue is touched safely
            if loop and loop.is_running():
                loop.call_soon_threadsafe(self._raw_emit, patch)
            else:
                self._raw_emit(patch)

        self.translator.submit(text, _on_done)

    # mode selection -------------------------------------------------------

    def _decide_mode(self) -> str:
        if self.req.mode == "demo":
            return "demo"
        if self.req.mode == "live":
            return "live"
        # auto: live if deps + provider key are present
        try:
            from tradingagents.graph.trading_graph import TradingAgentsGraph  # noqa: F401
        except Exception:
            return "demo"
        if not self._has_provider_key():
            return "demo"
        return "live"

    def _has_provider_key(self) -> bool:
        prov = self.req.llm_provider.lower()
        env = {
            "openai": "OPENAI_API_KEY",
            "anthropic": "ANTHROPIC_API_KEY",
            "google": "GOOGLE_API_KEY",
            "deepseek": "DEEPSEEK_API_KEY",
        }.get(prov)
        if not env:
            return False
        return bool(os.environ.get(env))

    # LIVE -----------------------------------------------------------------

    def _run_live(self) -> None:
        """Run the real TradingAgentsGraph in this thread, emitting events."""
        from tradingagents.graph.trading_graph import TradingAgentsGraph
        from tradingagents.default_config import DEFAULT_CONFIG
        from cli.stats_handler import StatsCallbackHandler
        import key_injector
        from usage_logger import GranularStatsHandler

        cfg = DEFAULT_CONFIG.copy()
        cfg["llm_provider"] = self.req.llm_provider.lower()
        cfg["deep_think_llm"] = self.req.deep_think_llm
        cfg["quick_think_llm"] = self.req.quick_think_llm
        cfg["max_debate_rounds"] = self.req.research_depth
        cfg["max_risk_discuss_rounds"] = self.req.research_depth
        cfg["output_language"] = self.req.output_language
        # Resume from checkpoint when set (env: TRADINGAGENTS_CHECKPOINT=1).
        # Stored under TRADINGAGENTS_CACHE_DIR/{ticker}/checkpoint.sqlite — a
        # crash mid-stream can be resumed by re-running the same ticker+date.
        cfg["checkpoint_enabled"] = os.environ.get("TRADINGAGENTS_CHECKPOINT", "").lower() in ("1", "true", "yes")

        # Parallel analyst execution (#9) — see TradingAgents/tradingagents/
        # graph/parallel.py. Wraps each analyst as an isolated sub-graph so
        # all 4 run concurrently without scrambling AgentState.messages.
        # Halves wall-clock per LIVE decision (~3 min → ~1.5 min).
        cfg["parallel_analysts"] = bool(self.req.parallel_analysts) or \
            os.environ.get("TRADINGAGENTS_PARALLEL_ANALYSTS", "").lower() in ("1", "true", "yes")
        if self.req.backend_url:
            cfg["backend_url"] = self.req.backend_url

        # ── KEY INJECTION (multi-tenant) ─────────────────────────────
        # Per-request keys live ONLY for the duration of the construction
        # window. The `with` block holds a process-wide lock; once the
        # graph + LLM clients are constructed they've captured the keys
        # in their own state and we can safely release.
        with key_injector.inject(self.req.api_keys):
            # Auto-route data vendors to premium sources when keys are set.
            cfg["data_vendors"] = _premium_vendor_routing(cfg.get("data_vendors", {}))

            # Aggregate stats for the legacy `usage` event
            stats_handler = StatsCallbackHandler()
            # Granular per-call telemetry — emits SSE events as calls happen
            granular = GranularStatsHandler(emit=self.emit, req=self.req)

            graph = TradingAgentsGraph(
                selected_analysts=self.req.analysts,
                debug=False,
                config=cfg,
                callbacks=[stats_handler, granular],
            )
            self._stats_handler = stats_handler
            self._granular_handler = granular

            init_state = graph.propagator.create_initial_state(self.req.ticker, self.req.trade_date)
            args = graph.propagator.get_graph_args(callbacks=[stats_handler, granular])
        # ─── lock released; from here on the graph runs without env access ───

        # Emit past-context BEFORE the graph starts so the frontend can show
        # "what we knew from previous decisions" as the cockpit fills in.
        try:
            past_ctx = graph.memory_log.get_past_context(self.req.ticker)
            if past_ctx:
                self.emit({"type": "past_context", "ticker": self.req.ticker, "content": past_ctx})
        except Exception as e:
            logger.debug("past_context emit failed: %s", e)

        # mark first analyst in_progress
        if self.req.analysts:
            self._status(self.req.analysts[0], "in_progress")

        seen_msg_ids = set()
        completed_analysts: set = set()
        bull_pos = bear_pos = 0

        for chunk in graph.graph.stream(init_state, **args):
            if self._cancel.is_set():
                self.emit({"type": "log", "level": "warn", "message": "cancelled by client"})
                return

            # 1) raw messages -> "log" / "tool_call"
            for msg in chunk.get("messages", []) or []:
                mid = getattr(msg, "id", None)
                if mid is None or mid in seen_msg_ids:
                    continue
                seen_msg_ids.add(mid)
                content = _flatten_content(getattr(msg, "content", None))
                if content:
                    self.emit({
                        "type": "log",
                        "kind": _classify_msg(msg),
                        "content": content[:1200],
                        "ts": _now(),
                    })
                tcalls = getattr(msg, "tool_calls", None) or []
                for tc in tcalls:
                    if isinstance(tc, dict):
                        name, args_ = tc.get("name"), tc.get("args")
                    else:
                        name, args_ = getattr(tc, "name", None), getattr(tc, "args", None)
                    if name:
                        self.emit({"type": "tool_call", "name": name, "args": args_, "ts": _now()})

            # 2) analyst report sections
            for ak in self.req.analysts:
                rk = ANALYST_REPORT_KEY[ak]
                if chunk.get(rk) and ak not in completed_analysts:
                    self.emit({
                        "type": "report",
                        "section": rk,
                        "agent_id": ak,
                        "title": ANALYST_DISPLAY[ak],
                        "content": chunk[rk],
                    })
                    self._status(ak, "completed")
                    completed_analysts.add(ak)
                    nxt = self._next_analyst(completed_analysts)
                    if nxt:
                        self._status(nxt, "in_progress")

            # 3) investment debate
            ids = chunk.get("investment_debate_state") or {}
            bull_h = (ids.get("bull_history") or "").strip()
            bear_h = (ids.get("bear_history") or "").strip()
            judge = (ids.get("judge_decision") or "").strip()
            if bull_h or bear_h:
                self._status("bull", "in_progress")
                self._status("bear", "in_progress")
            if len(bull_h) > bull_pos:
                self.emit({"type": "debate", "side": "bull", "content": bull_h[bull_pos:], "ts": _now()})
                bull_pos = len(bull_h)
            if len(bear_h) > bear_pos:
                self.emit({"type": "debate", "side": "bear", "content": bear_h[bear_pos:], "ts": _now()})
                bear_pos = len(bear_h)
            if judge:
                self._status("bull", "completed")
                self._status("bear", "completed")
                self._status("research_manager", "completed")
                self.emit({"type": "report", "section": "investment_plan",
                           "agent_id": "research_manager", "title": "Research Manager",
                           "content": judge})

            # 4) trader plan
            if chunk.get("trader_investment_plan"):
                self._status("trader", "completed")
                self.emit({"type": "report", "section": "trader_investment_plan",
                           "agent_id": "trader", "title": "Trader",
                           "content": chunk["trader_investment_plan"]})

            # 5) risk debate
            rds = chunk.get("risk_debate_state") or {}
            for side, key, agent_id in (
                ("aggressive", "current_aggressive_response", "aggressive"),
                ("conservative", "current_conservative_response", "conservative"),
                ("neutral", "current_neutral_response", "neutral"),
            ):
                resp = (rds.get(key) or "").strip()
                if resp:
                    self._status(agent_id, "in_progress")
                    self.emit({"type": "risk_debate", "side": side, "content": resp, "ts": _now()})
            if (rds.get("judge_decision") or "").strip():
                for aid in ("aggressive", "neutral", "conservative"):
                    self._status(aid, "completed")
                self._status("portfolio_manager", "completed")

            # 6) final
            if chunk.get("final_trade_decision"):
                full = chunk["final_trade_decision"]
                rating = _extract_rating(full)
                self.emit({
                    "type": "final_decision",
                    "decision": {
                        "rating": rating,
                        "raw": full,
                        "trader_plan": chunk.get("trader_investment_plan", ""),
                        "research_plan": (chunk.get("investment_debate_state") or {}).get("judge_decision", ""),
                    },
                })

            # remember the latest chunk; we want the final one for structured extraction
            self._last_chunk = chunk

        # ── post-graph: structured extraction (#10) ──────────────────────
        # Run an extra LLM pass over each *_report markdown to produce a
        # typed Pydantic dict. Output lands in run_state.structured_reports
        # so users can SQL-query analyst signals across decisions.
        # Enabled by:
        #   - per-request: req.structured_reports=True
        #   - global env:  TRADINGAGENTS_STRUCTURED_REPORTS=1
        want_structured = bool(self.req.structured_reports) or \
            os.environ.get("TRADINGAGENTS_STRUCTURED_REPORTS", "").lower() in ("1", "true", "yes")
        if want_structured:
            try:
                from structured_extractor import extract_all as _extract_structured
                structured = _extract_structured(self._last_chunk or {}, graph.quick_thinking_llm)
                if structured:
                    self.emit({"type": "structured_reports", "reports": structured})
            except Exception as e:
                logger.warning("structured extraction failed: %s", e)

    # DEMO -----------------------------------------------------------------

    async def _run_demo(self) -> None:
        """Scripted sequence so the UI can be exercised without API keys."""
        await self._sleep(0.4)
        self.emit({"type": "log", "kind": "system",
                   "content": f"DEMO mode — emitting scripted events for {self.req.ticker}",
                   "ts": _now()})

        for ak in self.req.analysts:
            if self._cancel.is_set():
                return
            agent_name = ANALYST_DISPLAY[ak]
            self._status(ak, "in_progress")
            self.emit({"type": "log", "kind": "agent",
                       "content": f"{agent_name} starting analysis on {self.req.ticker}…",
                       "ts": _now()})
            tool = _DEMO_TOOLS.get(ak, [])
            for t in tool:
                await self._sleep(0.6)
                self.emit({"type": "tool_call", "name": t, "args": {"symbol": self.req.ticker, "date": self.req.trade_date}})
            await self._sleep(1.0)
            self.emit({
                "type": "report",
                "section": ANALYST_REPORT_KEY[ak],
                "agent_id": ak,
                "title": agent_name,
                "content": _DEMO_REPORTS[ak].format(ticker=self.req.ticker, date=self.req.trade_date),
            })
            self._status(ak, "completed")

        # investment debate
        for r in range(self.req.research_depth):
            if self._cancel.is_set():
                return
            self._status("bull", "in_progress")
            await self._sleep(0.8)
            self.emit({"type": "debate", "side": "bull", "ts": _now(),
                       "content": _DEMO_BULL[r % len(_DEMO_BULL)].format(ticker=self.req.ticker)})
            self._status("bear", "in_progress")
            await self._sleep(0.8)
            self.emit({"type": "debate", "side": "bear", "ts": _now(),
                       "content": _DEMO_BEAR[r % len(_DEMO_BEAR)].format(ticker=self.req.ticker)})
        self._status("bull", "completed")
        self._status("bear", "completed")
        await self._sleep(0.6)
        self._status("research_manager", "in_progress")
        await self._sleep(0.6)
        self.emit({"type": "report", "section": "investment_plan",
                   "agent_id": "research_manager", "title": "Research Manager",
                   "content": _DEMO_RESEARCH_PLAN.format(ticker=self.req.ticker)})
        self._status("research_manager", "completed")

        # trader
        self._status("trader", "in_progress")
        await self._sleep(0.6)
        self.emit({"type": "report", "section": "trader_investment_plan",
                   "agent_id": "trader", "title": "Trader",
                   "content": _DEMO_TRADER_PLAN.format(ticker=self.req.ticker)})
        self._status("trader", "completed")

        # risk debate
        for r in range(self.req.research_depth):
            if self._cancel.is_set():
                return
            for side, agent_id, lines in (
                ("aggressive", "aggressive", _DEMO_AGGRESSIVE),
                ("conservative", "conservative", _DEMO_CONSERVATIVE),
                ("neutral", "neutral", _DEMO_NEUTRAL),
            ):
                self._status(agent_id, "in_progress")
                await self._sleep(0.7)
                self.emit({"type": "risk_debate", "side": side, "ts": _now(),
                           "content": lines[r % len(lines)].format(ticker=self.req.ticker)})
        for aid in ("aggressive", "neutral", "conservative"):
            self._status(aid, "completed")

        self._status("portfolio_manager", "in_progress")
        await self._sleep(1.0)

        # final
        decision = {
            "rating": "Buy",
            "confidence": "Medium-High",
            "raw": _DEMO_FINAL.format(ticker=self.req.ticker),
            "trader_plan": _DEMO_TRADER_PLAN.format(ticker=self.req.ticker),
            "research_plan": _DEMO_RESEARCH_PLAN.format(ticker=self.req.ticker),
            "view": "mild_bull",
            "horizon": "swing",
            "volatility": "high_vol",
            "instrument_hint": "stock",
        }
        self.emit({"type": "final_decision", "decision": decision})
        self._status("portfolio_manager", "completed")

    # internal helpers -----------------------------------------------------

    def _status(self, agent_id: str, status: str) -> None:
        self.emit({"type": "agent_status", "agent_id": agent_id, "status": status, "ts": _now()})

    def _next_analyst(self, completed: set) -> Optional[str]:
        for a in self.req.analysts:
            if a not in completed:
                return a
        return None

    async def _sleep(self, secs: float) -> None:
        # cooperative wait that respects cancel
        end = time.time() + secs
        while not self._cancel.is_set() and time.time() < end:
            await asyncio.sleep(min(0.1, end - time.time()))


# ---- helpers ---------------------------------------------------------------

def _now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def _flatten_content(content: Any) -> str:
    if not content:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        out = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                out.append(str(item.get("text", "")))
            elif isinstance(item, str):
                out.append(item)
        return " ".join(p.strip() for p in out if p).strip()
    if isinstance(content, dict):
        return str(content.get("text", "")).strip()
    return str(content).strip()


def _classify_msg(msg: Any) -> str:
    cls = type(msg).__name__
    if "Tool" in cls:
        return "tool"
    if "Human" in cls:
        return "user"
    if "AI" in cls:
        return "agent"
    return "system"


def _extract_rating(text: str) -> str:
    """Extract the 5-tier rating from a Portfolio Manager decision text.

    The PM uses Pydantic-typed structured output (PortfolioDecision schema),
    so the rendered markdown ALWAYS carries a clean ``**Rating**: X`` line.
    We delegate to TradingAgents' canonical ``parse_rating`` which already
    handles markdown bold, colons/hyphens, and falls back to first-word scan.
    """
    if not text:
        return "Hold"
    try:
        from tradingagents.agents.utils.rating import parse_rating  # type: ignore
        return parse_rating(text, default="Hold")
    except Exception:
        # Pure-fallback path for environments without TradingAgents
        # (DEMO mode without LIVE deps installed).
        upper = (text or "").upper()
        for word in ("BUY", "OVERWEIGHT", "HOLD", "UNDERWEIGHT", "SELL"):
            if f"RATING: {word}" in upper or f"**RATING:** {word}" in upper or f"RATING - {word}" in upper:
                return word.title()
        for word in ("Overweight", "Underweight", "Buy", "Sell", "Hold"):
            if word.lower() in (text or "").lower():
                return word
        return "Hold"


# ---- demo content (intentionally short) ------------------------------------

_DEMO_TOOLS = {
    "market": ["get_stock_data", "get_indicators"],
    "social": ["get_news"],
    "news": ["get_global_news", "get_news"],
    "fundamentals": ["get_fundamentals", "get_balance_sheet", "get_cashflow", "get_income_statement"],
}

_DEMO_REPORTS = {
    "market": (
        "## Market Analysis — {ticker} ({date})\n\n"
        "- 50/200 SMA 呈金叉，趋势中期偏多\n"
        "- RSI(14) = 58，未超买；MACD 柱状图持续向上\n"
        "- ATR 显示波动率回升，建议止损 ATR×2\n"
        "- VWMA 与价格同步上行，量价配合健康\n\n"
        "| 指标 | 当前值 | 信号 |\n|---|---|---|\n"
        "| RSI(14) | 58 | 中性偏多 |\n| MACD | +0.42 | 多头 |\n| ATR(14) | 3.8 | 高 |\n"
    ),
    "social": (
        "## Sentiment — {ticker}\n\n"
        "- 过去 7 天 X/Reddit 提及量上升 32%，正面占比 64%\n"
        "- 散户情绪指数从 55 → 71（贪婪区）\n"
        "- 机构论坛对下季指引偏乐观\n"
    ),
    "news": (
        "## News — {ticker} (week ending {date})\n\n"
        "- 公司公告：与大客户签订 12 亿美元长期合同\n"
        "- 行业新闻：监管对该赛道整体宽松\n"
        "- 宏观：美联储 Q3 大概率维持利率，对成长股估值利好\n"
    ),
    "fundamentals": (
        "## Fundamentals — {ticker}\n\n"
        "- 最新季度营收同比 +18%，毛利率 53.4%\n"
        "- 自由现金流 +$2.1B，净现金充裕\n"
        "- 负债权益比 0.34，财务结构稳健\n"
        "- 估值：远期 P/E 24，处于行业中位\n"
    ),
}

_DEMO_BULL = [
    "{ticker} 增长动能未减：客户合同放量 + 新品周期临近，远期 P/E 24 在行业属合理偏低。下行已被强 FCF 与回购计划部分对冲。",
    "对手方过度强调短期估值压力，但 12 个月前瞻自由现金流 yield ≥ 4.2%，这正好提供了护城河。",
]
_DEMO_BEAR = [
    "RSI 已升至 58，量能在最近两个交易日没有跟上，技术面有 5–8% 回调风险；估值若叠加宏观利率反弹将受压。",
    "营收指引上修被市场已大幅 priced-in；Sentiment 71 处于贪婪区，是反向指标。",
]
_DEMO_AGGRESSIVE = [
    "应顺势加仓 1.5x，杠杆 ETF 或近月 OTM call 都是高效工具，错过启动段的机会成本远大于 5% 回撤。",
]
_DEMO_CONSERVATIVE = [
    "考虑到 ATR 已抬升、估值不再便宜，应配 protective put 或先 collar 锁定区间，避免黑天鹅。",
]
_DEMO_NEUTRAL = [
    "可分批加仓 + bull call spread 限定下行，同时设 ATR×2 移动止损；不必满仓也不必清仓。",
]

_DEMO_RESEARCH_PLAN = (
    "## Research Plan — {ticker}\n\n"
    "**Recommendation: Overweight**\n\n"
    "- 多头论证（基本面 + 趋势）整体优于空头（估值 + sentiment 反指）\n"
    "- 建议增加 5–8% 仓位敞口，分 2 批入场\n"
    "- 关键监控：下季营收指引、ATR 是否继续抬升\n"
)

_DEMO_TRADER_PLAN = (
    "## Trader Proposal — {ticker}\n\n"
    "- 行动：BUY，分 2 批（5% + 3%）\n"
    "- 入场：现价及回调 -3% 处\n"
    "- 止损：入场均价下方 ATR×2（约 −7%）\n"
    "- 止盈：分 3 批，+10% / +20% / 移动止损\n"
    "- 增收：持仓 30 天后卖 OTM call 月供 1–1.5% 权利金\n"
)

_DEMO_FINAL = (
    "## Portfolio Decision — {ticker}\n\n"
    "**Rating: Buy**  Confidence: Medium-High\n\n"
    "综合多智能体辩论与风险讨论，给出 Buy 评级：\n"
    "1. 基本面与趋势论证占优\n"
    "2. 用 protective put 控制下行尾部，为加仓换得心理空间\n"
    "3. 持仓后 covered call 持续生息\n"
    "4. 严格执行 ATR×2 移动止损\n"
)
