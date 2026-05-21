"""
Trading Decision Web App - FastAPI server.

Serves the static front-end and exposes a Server-Sent-Events endpoint that
streams TradingAgents progress in real time.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import uuid
from pathlib import Path
from typing import AsyncGenerator, Dict, Any, Optional

from fastapi import FastAPI, Request, HTTPException, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

# Make the sibling TradingAgents package importable.
ROOT = Path(__file__).resolve().parent.parent.parent
TRADING_AGENTS_DIR = ROOT / "TradingAgents"
if TRADING_AGENTS_DIR.exists() and str(TRADING_AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(TRADING_AGENTS_DIR))

# Load .env (project root, then app folder, then cwd) so OPENAI_API_KEY,
# DEEPSEEK_API_KEY, default model overrides, etc. are picked up before any
# downstream module imports.
try:
    from dotenv import load_dotenv  # type: ignore
    for env_path in (
        ROOT / ".env",
        ROOT / "trading-decision-app" / ".env",
        Path.cwd() / ".env",
    ):
        if env_path.exists():
            load_dotenv(env_path, override=False)
except ImportError:  # python-dotenv missing — fall back to OS env
    pass

# Local imports.
sys.path.insert(0, str(Path(__file__).parent))
from agent_runner import AgentRunner, AnalysisRequest  # noqa: E402
from strategy_matcher import match_strategies  # noqa: E402
from horizon_planner import build_plan as build_horizon_plan  # noqa: E402
from model_catalog import serialize as serialize_catalog, PROVIDER_KEY_ENV  # noqa: E402
from dataflows.factory import list_categories as dataflows_list  # noqa: E402
from opportunities import get_feed, start_scanner, stop_scanner  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("trading-decision-app")

STATIC_DIR = ROOT / "trading-decision-app" / "static"

app = FastAPI(title="Trading Decision App", version="2.0.0")

# CORS — comma-separated list in CORS_ORIGINS, default "*" for dev.
# In prod set CORS_ORIGINS to your Cloudflare Pages origin, e.g.
#   CORS_ORIGINS=https://trading-decision.pages.dev,https://yourdomain.com
_cors_raw = os.environ.get("CORS_ORIGINS", "*").strip()
_cors_origins = [o.strip() for o in _cors_raw.split(",") if o.strip()] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- optional Supabase JWT verification --------------------------------
# When SUPABASE_JWT_SECRET (legacy HS256) or SUPABASE_URL (new asymmetric
# signing keys via JWKS) is set, /api/analyze requires a valid JWT in the
# Authorization: Bearer <token> header. This stops random scrapers from
# burning your LLM tokens. When neither is set we leave the endpoint open
# (useful for local dev / DEMO mode).
#
# Supabase migrated all projects to asymmetric JWT signing keys (ES256 /
# RS256) in 2024. The JWKS endpoint at <SUPABASE_URL>/auth/v1/.well-known/jwks.json
# publishes the rotating public keys. We cache the fetched JWKS for 5min.

_BEARER = HTTPBearer(auto_error=False)
_JWKS_CACHE: Dict[str, Any] = {"keys": None, "fetched_at": 0.0}
_JWKS_TTL_SEC = 300


def _fetch_jwks() -> Optional[list]:
    import time
    base = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    if not base:
        return None
    now = time.time()
    if _JWKS_CACHE["keys"] is not None and (now - _JWKS_CACHE["fetched_at"]) < _JWKS_TTL_SEC:
        return _JWKS_CACHE["keys"]
    try:
        import urllib.request
        with urllib.request.urlopen(f"{base}/auth/v1/.well-known/jwks.json", timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        _JWKS_CACHE["keys"] = data.get("keys") or []
        _JWKS_CACHE["fetched_at"] = now
        return _JWKS_CACHE["keys"]
    except Exception as e:
        logger.warning("JWKS fetch failed: %s", e)
        return None


def _verify_jwt(creds: Optional[HTTPAuthorizationCredentials]) -> Optional[Dict[str, Any]]:
    secret = os.environ.get("SUPABASE_JWT_SECRET")
    supabase_url = os.environ.get("SUPABASE_URL")
    if not secret and not supabase_url:
        return None  # auth disabled
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="missing bearer token")
    try:
        import jwt  # type: ignore
        from jwt import PyJWKClient  # noqa: F401  # ensure jwks support is available
    except ImportError:
        logger.warning("PyJWT not installed but SUPABASE auth env set — auth disabled")
        return None

    token = creds.credentials
    try:
        header = jwt.get_unverified_header(token)
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"invalid token: {e}")
    alg = (header.get("alg") or "").upper()

    last_err: Optional[str] = None

    # Path 1: asymmetric signing (ES256 / RS256) via JWKS — current Supabase default.
    if alg in ("ES256", "RS256", "EDDSA"):
        keys = _fetch_jwks() or []
        kid = header.get("kid")
        matching = [k for k in keys if not kid or k.get("kid") == kid]
        for jwk_entry in matching or keys:
            try:
                key_obj = jwt.PyJWK(jwk_entry).key
                payload = jwt.decode(
                    token, key_obj,
                    algorithms=[alg], audience="authenticated",
                    options={"verify_aud": True},
                )
                return payload
            except Exception as e:
                last_err = str(e)
                continue

    # Path 2: legacy HS256 with shared secret.
    if alg == "HS256" and secret:
        try:
            payload = jwt.decode(
                token, secret,
                algorithms=["HS256"], audience="authenticated",
                options={"verify_aud": True},
            )
            return payload
        except Exception as e:
            last_err = str(e)

    raise HTTPException(status_code=401, detail=f"invalid token: {last_err or alg + ' not supported'}")


async def maybe_user(request: Request) -> Optional[Dict[str, Any]]:
    """Return JWT claims if SUPABASE_JWT_SECRET set & token valid, else None."""
    auth = request.headers.get("authorization")
    if not auth:
        return _verify_jwt(None)
    parts = auth.split(None, 1)
    if len(parts) != 2:
        return _verify_jwt(None)
    creds = HTTPAuthorizationCredentials(scheme=parts[0], credentials=parts[1])
    return _verify_jwt(creds)


# ---------- session registry --------------------------------------------------

class Session:
    """Container for a single analysis run shared between the launcher and SSE stream."""

    def __init__(self, sid: str, params: Dict[str, Any]):
        self.id = sid
        self.params = params
        self.queue: asyncio.Queue = asyncio.Queue()
        self.done = False
        self.cancelled = False


SESSIONS: Dict[str, Session] = {}


# ---------- routes ------------------------------------------------------------

@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.post("/api/analyze")
async def start_analysis(
    payload: Dict[str, Any],
    user: Optional[Dict[str, Any]] = Depends(maybe_user),
) -> JSONResponse:
    """Register a new analysis session and return its id.

    The actual run is launched lazily when the client connects to the
    `/api/stream/{sid}` SSE endpoint, so we don't waste an LLM call if the
    client never subscribes.

    Auth: when SUPABASE_JWT_SECRET is set, a valid Supabase JWT is required
    in the Authorization: Bearer header. Otherwise the endpoint is open
    (suitable for local dev or self-hosted single-user deployments).
    """
    required = ["ticker", "trade_date"]
    missing = [k for k in required if not payload.get(k)]
    if missing:
        return JSONResponse({"error": f"missing: {missing}"}, status_code=400)

    sid = uuid.uuid4().hex[:12]
    SESSIONS[sid] = Session(sid, payload)
    user_tag = (user or {}).get("sub", "anon")[:8]
    logger.info("session %s registered (user=%s) for %s @ %s",
                sid, user_tag, payload.get("ticker"), payload.get("trade_date"))
    return JSONResponse({"session_id": sid})


@app.get("/api/stream/{sid}")
async def stream(sid: str, request: Request) -> StreamingResponse:
    """SSE endpoint that pushes agent events to the browser."""
    session = SESSIONS.get(sid)
    if not session:
        return JSONResponse({"error": "unknown session"}, status_code=404)

    async def event_source() -> AsyncGenerator[bytes, None]:
        # Kick off the runner the first time the client subscribes.
        runner = AgentRunner(
            request_data=AnalysisRequest.from_dict(session.params),
            on_event=lambda evt: session.queue.put_nowait(evt),
        )
        runner_task = asyncio.create_task(runner.run())

        try:
            yield _sse({"type": "ready", "session_id": sid})
            while True:
                if await request.is_disconnected():
                    logger.info("client disconnected from %s", sid)
                    session.cancelled = True
                    runner.cancel()
                    break
                try:
                    evt = await asyncio.wait_for(session.queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    # heartbeat to keep the proxy from closing the connection
                    yield b": ping\n\n"
                    continue

                # Augment the final decision with library-strategy matches
                # and a multi-horizon execution plan (short / mid / long term).
                if evt.get("type") == "final_decision":
                    matches = match_strategies(evt.get("decision", {}), session.params)
                    evt["matched_strategies"] = matches
                    try:
                        plan = await asyncio.to_thread(
                            build_horizon_plan,
                            evt.get("decision", {}),
                            matches,
                            session.params,
                        )
                        if plan:
                            evt["horizon_plan"] = plan
                    except Exception as e:  # pragma: no cover — defensive
                        logger.warning("horizon planner crashed: %s", e)

                yield _sse(evt)

                if evt.get("type") in ("complete", "error"):
                    session.done = True
                    break
        finally:
            runner.cancel()
            try:
                await asyncio.wait_for(runner_task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
            SESSIONS.pop(sid, None)

    headers = {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return StreamingResponse(event_source(), media_type="text/event-stream", headers=headers)


# ---- opportunities feed -------------------------------------------------

@app.get("/api/opportunities")
async def opportunities(
    severity: Optional[str] = None,
    ticker: Optional[str] = None,
    limit: int = 50,
) -> JSONResponse:
    """Return the current 24h opportunities feed (in-memory ring buffer)."""
    return JSONResponse({"items": get_feed(severity=severity, ticker=ticker, limit=limit)})


# ---- batch quotes (used by 自选 page) ----------------------------------

@app.get("/api/quotes")
async def quotes(tickers: str = "") -> JSONResponse:
    """Comma-separated tickers → list of unified quote dicts.

    Routes per-market: crypto → Binance, US → Finnhub Pro / yfinance,
    HK / A股 / 期货 → yfinance. Missing fields are null. ~1-2s for 20
    symbols thanks to ThreadPoolExecutor parallelism.
    """
    from quotes import fetch_quotes
    items = [t.strip() for t in (tickers or "").split(",") if t.strip()]
    if not items:
        return JSONResponse({"items": []})
    if len(items) > 100:
        return JSONResponse({"error": "too many tickers (max 100)"}, status_code=400)
    return JSONResponse({"items": fetch_quotes(items)})


# ---- fundamentals dashboard (基本面看板) -------------------------------

@app.get("/api/fundamentals")
async def fundamentals_index() -> JSONResponse:
    """Sector index for the 基本面看板 sub-tabs (id/name/icon/desc + count)."""
    from fundamentals import list_sectors
    return JSONResponse(list_sectors())


@app.get("/api/fundamentals/_overview")
async def fundamentals_overview(force: bool = False) -> JSONResponse:
    """Cross-sector macro snapshot for the top strip — all 5 sectors at once.

    Heavy on first call (parallel fetch of ~100 unique tickers), near-
    instant once the per-ticker AV cache warms (30-min TTL).

    `?force=true` bypasses the per-ticker cache so a manual refresh always
    pulls fresh data from Alpha Vantage / Polygon / Finnhub.
    """
    from fundamentals import build_overview
    payload = await asyncio.to_thread(build_overview, force)
    return JSONResponse(payload)


@app.get("/api/fundamentals/{sector_id}")
async def fundamentals_sector(sector_id: str, force: bool = False) -> JSONResponse:
    """Full payload for one sector: scored rows, KPIs, top/bottom picks,
    sub-sector aggregates, and `核心结论与解读` commentary.

    Fetches Alpha Vantage OVERVIEW + Polygon prev-day + Finnhub metric
    for every ticker (30-min TTL cache), then computes a sector-relative
    percentile composite score using the sector-specific weight matrix.

    `?force=true` bypasses the per-ticker cache so a manual refresh always
    pulls live data.
    """
    from fundamentals import build_sector_payload, SECTORS
    if sector_id not in SECTORS:
        return JSONResponse({"error": f"unknown sector: {sector_id}"}, status_code=404)
    payload = await asyncio.to_thread(build_sector_payload, sector_id, force)
    return JSONResponse(payload)


# ---- dataflows diagnostics (used by Profile page) -----------------------

@app.get("/api/dataflows")
async def dataflows() -> JSONResponse:
    return JSONResponse(dataflows_list())


@app.get("/api/dataflows/cache-stats")
async def dataflows_cache_stats() -> JSONResponse:
    from dataflows import cache_stats
    return JSONResponse(cache_stats())


# ---- comprehensive report (自选 page 综合报告) -------------------------

@app.post("/api/comprehensive-report/generate")
async def comprehensive_report_generate(
    payload: Dict[str, Any],
    user: Optional[Dict[str, Any]] = Depends(maybe_user),
) -> JSONResponse:
    """Aggregate the user's historical decisions for one ticker into a single
    multi-section synthesis. Stateless compute — the frontend persists the
    result to Supabase (`comprehensive_reports` table, RLS-scoped).

    Body:
      {
        "ticker": "NVDA",
        "decisions": [ { id, ticker, trade_date, rating, completedAt,
                         runState, params }, ... ],
        "quote": { price, change_pct, ... }   # optional; backend fetches if missing
        "llm_provider": "anthropic",          # optional preference
        "deep_model": "claude-opus-4-7"       # optional preference
      }
    """
    from comprehensive_report import generate as _generate

    ticker = (payload.get("ticker") or "").strip().upper()
    decisions = payload.get("decisions") or []
    if not ticker:
        return JSONResponse({"error": "missing ticker"}, status_code=400)
    if not isinstance(decisions, list) or not decisions:
        return JSONResponse({"error": "decisions must be a non-empty list"}, status_code=400)
    if len(decisions) > 50:
        return JSONResponse({"error": "too many decisions (max 50)"}, status_code=400)

    quote = payload.get("quote") or None
    llm_provider = payload.get("llm_provider") or ""
    deep_model = payload.get("deep_model") or ""

    result = await asyncio.to_thread(
        _generate, ticker, decisions, quote, llm_provider, deep_model,
    )
    # comprehensive_report.generate now always returns a dict:
    #   success: {"ok": True, "report": {...}, "provider": ..., "model": ...}
    #   failure: {"ok": False, "error": "...", "tried": [...]}
    if not result or not result.get("ok"):
        err = (result or {}).get("error") or "unknown generation failure"
        return JSONResponse(
            {"error": err, "tried": (result or {}).get("tried", [])},
            status_code=502,
        )
    return JSONResponse({
        "ticker": ticker,
        "report": result["report"],
        "provider": result.get("provider"),
        "model": result.get("model"),
    })


# ---- reflections / memory log ------------------------------------------

@app.get("/api/reflections")
async def reflections_list(
    ticker: Optional[str] = None,
    only_resolved: bool = False,
    limit: int = 50,
) -> JSONResponse:
    """Return TradingAgents' memory-log entries with reflections.

    Each entry: ticker / trade_date / rating / pending / raw_return /
    alpha_return / holding_days / decision / reflection.
    """
    from reflections import list_entries
    return JSONResponse({
        "items": list_entries(ticker=ticker, only_resolved=only_resolved, limit=limit),
    })


@app.get("/api/reflections/stats")
async def reflections_stats() -> JSONResponse:
    """Aggregate stats across all memory-log entries (for Profile page)."""
    from reflections import stats
    return JSONResponse(stats())


@app.get("/api/cost-table")
async def cost_table_endpoint() -> JSONResponse:
    """Front-end calls this to render its own per-model dollar costs.
    Returns {provider: [{model, input_per_1m_usd, output_per_1m_usd}, ...]}
    """
    from cost_table import PRICE_TABLE
    out: dict = {}
    for (provider, model), (inp, outp) in PRICE_TABLE.items():
        out.setdefault(provider, []).append({
            "model": model,
            "input_per_1m_usd": inp,
            "output_per_1m_usd": outp,
        })
    return JSONResponse(out)


@app.on_event("startup")
async def _startup_scanner() -> None:
    """Kick off the opportunities scanner unless explicitly disabled."""
    try:
        start_scanner()
    except Exception as e:
        logger.warning("scanner failed to start: %s", e)


@app.on_event("startup")
async def _startup_fundamentals_warmup() -> None:
    """Background-warm the per-sector payload cache so the first user hit
    after a cold start is fast. Fire-and-forget — never blocks startup.
    """
    try:
        from fundamentals import warm_up_async
        warm_up_async()
    except Exception as e:
        logger.warning("fundamentals warm-up failed to launch: %s", e)


@app.on_event("shutdown")
async def _shutdown_scanner() -> None:
    try:
        stop_scanner()
    except Exception:
        pass


@app.get("/api/runtime-config.js")
async def runtime_config_js() -> Response:
    """Emit window.APP_CONFIG = {...} as a JS file for the frontend.

    Public, safe-to-expose values only:
      - SUPABASE_URL, SUPABASE_ANON_KEY (anon key is designed for browsers)
      - API_BASE_URL (where the SSE backend lives — useful when frontend is
        on Cloudflare Pages and backend is on a different host)
    """
    cfg = {
        "SUPABASE_URL": os.environ.get("SUPABASE_URL", ""),
        "SUPABASE_ANON_KEY": os.environ.get("SUPABASE_ANON_KEY", ""),
        "API_BASE_URL": os.environ.get("PUBLIC_API_BASE_URL", ""),
        "AUTH_REQUIRED": bool(os.environ.get("SUPABASE_JWT_SECRET")),
    }
    body = f"window.APP_CONFIG = {json.dumps(cfg)};\n"
    return Response(content=body, media_type="application/javascript",
                    headers={"Cache-Control": "no-store"})


@app.get("/api/strategies-meta")
async def strategies_meta() -> JSONResponse:
    """Lightweight metadata so the front-end matcher can show readable names."""
    return JSONResponse({
        "categories": {
            "entry": "建仓", "sizing": "仓位管理", "hedge": "对冲",
            "income": "收益增强", "directional": "方向性",
            "arbitrage": "套利", "exit": "退出",
        }
    })


@app.get("/api/config")
async def get_config() -> JSONResponse:
    """Front-end calls this once on page load to populate dropdowns and
    pre-fill the form from .env defaults.

    Surfaces:
      - per-provider model lists (deep / quick) from the shared catalog
      - which providers have an API key in env (drives badges/warnings)
      - user-overridable defaults via env vars:
          * DEFAULT_LLM_PROVIDER (openai|anthropic|google|deepseek)
          * DEFAULT_DEEP_LLM, DEFAULT_QUICK_LLM
          * DEFAULT_RESEARCH_DEPTH (1..5)
          * DEFAULT_OUTPUT_LANGUAGE (Chinese|English)
          * DEFAULT_TICKER, DEFAULT_INSTRUMENT, DEFAULT_RISK_TOLERANCE
    """
    cat = serialize_catalog()
    providers_with_keys = [p["id"] for p in cat["providers"] if p["key_present"]]

    # Pick a sensible default provider:
    #   1) DEFAULT_LLM_PROVIDER env if set and valid
    #   2) anthropic if it has a key (canonical default — Opus 4.7 / Sonnet 4.6)
    #   3) the first provider that has a key
    #   4) anthropic (even without key, so the UI shows the recommended default)
    valid_ids = {p["id"] for p in cat["providers"]}
    env_provider = (os.environ.get("DEFAULT_LLM_PROVIDER") or "").strip().lower()
    if env_provider and env_provider in valid_ids:
        default_provider = env_provider
    elif "anthropic" in providers_with_keys:
        default_provider = "anthropic"
    elif providers_with_keys:
        default_provider = providers_with_keys[0]
    else:
        default_provider = "anthropic"

    # Find the provider's model lists for default selection
    provider_obj = next((p for p in cat["providers"] if p["id"] == default_provider), None)
    deep_models = (provider_obj or {}).get("models", {}).get("deep", [])
    quick_models = (provider_obj or {}).get("models", {}).get("quick", [])

    # For anthropic prefer Opus 4.7 (deep) + Sonnet 4.6 (quick) when available;
    # otherwise fall back to the first listed model.
    def _pick(models, preferred):
        for m in models:
            if m.get("value") == preferred:
                return preferred
        return models[0]["value"] if models else ""

    if default_provider == "anthropic":
        fallback_deep = _pick(deep_models, "claude-opus-4-7")
        fallback_quick = _pick(quick_models, "claude-sonnet-4-6")
    else:
        fallback_deep = deep_models[0]["value"] if deep_models else ""
        fallback_quick = quick_models[0]["value"] if quick_models else ""

    default_deep = os.environ.get("DEFAULT_DEEP_LLM") or fallback_deep
    default_quick = os.environ.get("DEFAULT_QUICK_LLM") or fallback_quick

    return JSONResponse({
        "providers": cat["providers"],
        "defaults": {
            "llm_provider": default_provider,
            "deep_think_llm": default_deep,
            "quick_think_llm": default_quick,
            "research_depth": int(os.environ.get("DEFAULT_RESEARCH_DEPTH", "2") or 2),
            "output_language": os.environ.get("DEFAULT_OUTPUT_LANGUAGE", "Chinese"),
            "ticker": os.environ.get("DEFAULT_TICKER", "NVDA"),
            "instrument_hint": os.environ.get("DEFAULT_INSTRUMENT", ""),
            "risk_tolerance": int(os.environ.get("DEFAULT_RISK_TOLERANCE", "3") or 3),
        },
        "providers_with_keys": providers_with_keys,
    })


# Mount static last so /api/* routes win.
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    # Convenience: also expose strategies.js at root for the index page.
    @app.get("/strategies.js")
    async def strategies_js() -> FileResponse:
        return FileResponse(STATIC_DIR / "strategies.js", media_type="application/javascript")
    @app.get("/app.js")
    async def app_js() -> FileResponse:
        return FileResponse(STATIC_DIR / "app.js", media_type="application/javascript")
    @app.get("/fundamentals.js")
    async def fundamentals_js() -> FileResponse:
        return FileResponse(STATIC_DIR / "fundamentals.js", media_type="application/javascript")
    @app.get("/comprehensive.js")
    async def comprehensive_js() -> FileResponse:
        return FileResponse(STATIC_DIR / "comprehensive.js", media_type="application/javascript")
    @app.get("/auth.js")
    async def auth_js() -> FileResponse:
        return FileResponse(STATIC_DIR / "auth.js", media_type="application/javascript")
    @app.get("/styles.css")
    async def styles_css() -> FileResponse:
        return FileResponse(STATIC_DIR / "styles.css", media_type="text/css")
    @app.get("/logo.svg")
    async def logo_svg() -> FileResponse:
        return FileResponse(STATIC_DIR / "logo.svg", media_type="image/svg+xml")
    @app.get("/favicon.svg")
    async def favicon_svg() -> FileResponse:
        return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")


# ---------- helpers -----------------------------------------------------------

def _sse(payload: Dict[str, Any]) -> bytes:
    """Format a payload as a single SSE message."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=port,
        reload=os.environ.get("RELOAD", "false").lower() == "true",
    )
