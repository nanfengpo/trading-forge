"""
24h opportunities scanner.

Lightweight detector framework that wakes up every N seconds, runs a list
of detectors, and writes findings to:
  1. `_FEED` (in-memory ring buffer)         — served at /api/opportunities
  2. Supabase `opportunities` table (if SUPABASE_SERVICE_ROLE_KEY is set)
                                              — survives restarts, cross-host

Each detector implements one ``BaseDetector`` and returns 0..N
``Opportunity`` records. Detectors are intentionally cheap (a single
HTTP call or two); when in doubt, ship a heuristic and refine later.
"""

from .scanner import (
    Opportunity,
    BaseDetector,
    Scanner,
    get_feed,
    start_scanner,
    stop_scanner,
    watchlist_tickers,
)

__all__ = [
    "Opportunity",
    "BaseDetector",
    "Scanner",
    "get_feed",
    "start_scanner",
    "stop_scanner",
    "watchlist_tickers",
]
