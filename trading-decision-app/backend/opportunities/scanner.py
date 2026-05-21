"""
Detector framework + scheduler.

Detectors run on a thread-pool every ``SCAN_INTERVAL_SEC`` seconds. Each
returns a list of ``Opportunity`` records. The scanner deduplicates by id,
keeps the most recent N in memory, and pushes new ones to Supabase.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


# ----- shared utilities --------------------------------------------------

def watchlist_tickers(limit: int = 30) -> List[str]:
    """Return the tickers to scan, in priority order:
      1. OPPS_WATCHLIST env (comma-separated) — explicit override
      2. Supabase public.watchlist (when SUPABASE_SERVICE_ROLE_KEY is set)
      3. Empty list — caller's detector should no-op rather than spam.
    """
    env_raw = os.environ.get("OPPS_WATCHLIST", "")
    if env_raw.strip():
        return [t.strip().upper() for t in env_raw.split(",") if t.strip()][:limit]

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        return []
    try:
        import requests
        r = requests.get(
            f"{url}/rest/v1/watchlist",
            params={"select": "ticker", "limit": str(limit)},
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=5,
        )
        if r.status_code >= 400:
            logger.debug("supabase watchlist fetch %s: %s", r.status_code, r.text[:200])
            return []
        rows = r.json() or []
        seen, out = set(), []
        for row in rows:
            t = str(row.get("ticker") or "").upper().strip()
            if t and t not in seen:
                seen.add(t)
                out.append(t)
        return out[:limit]
    except Exception as e:
        logger.debug("supabase watchlist fetch crashed: %s", e)
        return []


# ----- core types ---------------------------------------------------------

@dataclass
class Opportunity:
    """One detected event."""
    id: str
    source: str                                          # detector name
    type: str                                            # short slug
    headline: str
    severity: str = "info"                               # info|watch|high|critical
    ticker: Optional[str] = None
    body: Optional[str] = None
    payload: Dict[str, Any] = field(default_factory=dict)
    suggested_strategies: List[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    expires_at: Optional[str] = None
    # v2.5 additions (2026-05): high-level grouping + LLM-free takeaway
    category: str = "other"                              # macro|news|earnings|signal|crypto|other
    trend: str = "neutral"                               # bullish|bearish|neutral
    strategy_note: Optional[str] = None                  # 1–2 sentence "怎么看 / 怎么做"
    url: Optional[str] = None                            # source link (news headlines)

    def to_json(self) -> dict:
        return asdict(self)


class BaseDetector:
    """One signal detector. Subclasses implement ``run`` and return Opps."""

    name: str = "unnamed"
    interval_sec: int = 300        # default cadence; scanner enforces lower bound

    def run(self) -> List[Opportunity]:
        raise NotImplementedError


# ----- in-memory feed -----------------------------------------------------

_MAX_FEED = 200
_FEED: deque = deque(maxlen=_MAX_FEED)
_SEEN_IDS: set = set()
_FEED_LOCK = threading.Lock()


def get_feed(severity: Optional[str] = None,
             ticker: Optional[str] = None,
             limit: int = 100) -> List[dict]:
    """Read-only snapshot of the current feed for the API endpoint."""
    with _FEED_LOCK:
        items = list(_FEED)
    items.reverse()  # newest first
    if severity:
        items = [o for o in items if o.severity == severity]
    if ticker:
        t = ticker.upper()
        items = [o for o in items if (o.ticker or "").upper() == t]
    return [o.to_json() for o in items[:limit]]


def _push(opp: Opportunity) -> bool:
    """Add to feed if not seen. Returns True if it was new."""
    with _FEED_LOCK:
        if opp.id in _SEEN_IDS:
            return False
        _FEED.append(opp)
        _SEEN_IDS.add(opp.id)
        # bound the seen-set by trimming alongside the deque
        if len(_SEEN_IDS) > _MAX_FEED * 2:
            _SEEN_IDS.intersection_update({o.id for o in _FEED})
    _maybe_persist(opp)
    return True


# ----- optional Supabase persistence --------------------------------------

def _maybe_persist(opp: Opportunity) -> None:
    """Push to public.opportunities when we have a service role key."""
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        return
    try:
        import requests  # local import to avoid hard dep
        r = requests.post(
            f"{url}/rest/v1/opportunities",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Prefer": "resolution=ignore-duplicates",
            },
            json={
                "id": opp.id,
                "source": opp.source,
                "type": opp.type,
                "ticker": opp.ticker,
                "severity": opp.severity,
                "headline": opp.headline,
                "body": opp.body,
                "payload": opp.payload,
                "suggested_strategies": opp.suggested_strategies,
                "expires_at": opp.expires_at,
            },
            timeout=4,
        )
        if r.status_code >= 400:
            logger.debug("supabase opportunities POST %s: %s", r.status_code, r.text[:200])
    except Exception as e:
        logger.debug("supabase persist skipped: %s", e)


# ----- the scanner --------------------------------------------------------

class Scanner:
    def __init__(self, detectors: List[BaseDetector], interval_sec: Optional[int] = None):
        self.detectors = detectors
        self.interval_sec = max(30, int(interval_sec or os.environ.get("SCAN_INTERVAL_SEC", "120")))
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="opps-scanner", daemon=True)
        self._thread.start()
        logger.info("opportunities scanner started (interval=%ds, detectors=%d)",
                    self.interval_sec, len(self.detectors))

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _loop(self) -> None:
        # Run once immediately, then every interval_sec.
        while not self._stop.is_set():
            self._tick()
            self._stop.wait(self.interval_sec)

    def _tick(self) -> None:
        for det in self.detectors:
            try:
                t0 = time.time()
                results = det.run() or []
                added = sum(1 for o in results if _push(o))
                logger.debug("detector %s: %d results, %d new (%.2fs)",
                             det.name, len(results), added, time.time() - t0)
            except Exception as e:
                logger.warning("detector %s crashed: %s", det.name, e)


# ----- module-level singleton --------------------------------------------

_SCANNER: Optional[Scanner] = None


def start_scanner() -> Scanner:
    global _SCANNER
    if _SCANNER:
        return _SCANNER
    # Build detectors lazily so we don't pay the import cost when disabled.
    from .detectors import default_detectors
    _SCANNER = Scanner(default_detectors())
    if os.environ.get("OPPORTUNITIES_SCANNER", "auto").lower() not in ("off", "false", "0"):
        _SCANNER.start()
    return _SCANNER


def stop_scanner() -> None:
    global _SCANNER
    if _SCANNER:
        _SCANNER.stop()
        _SCANNER = None
