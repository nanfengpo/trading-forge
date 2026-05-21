"""
Opportunity detectors — v2.5 (2026-05-22).

Big rewrite: the previous demo + BTC-wick set produced opportunities the
user called "基本都不可用". This module replaces them with five categories
that surface things actually worth reacting to:

  MacroSnapshotDetector    宏观    VIX/10Y/DXY/Gold/Oil/SPY/QQQ daily ∆ + regime
  WatchlistNewsDetector    新闻    headlines per自选 ticker (yfinance + Finnhub)
  EarningsCalendarDetector 财报    upcoming earnings for自选 tickers, 7d window
  TrendSignalDetector      技术    MA20/MA50 cross + RSI extremes on watchlist
  CryptoPulseDetector      加密    BTC/ETH/SOL 24h price + change (CoinGecko)

Every Opportunity carries:
  category:        macro|news|earnings|signal|crypto
  trend:           bullish|bearish|neutral  (data-derived, no LLM)
  strategy_note:   1–2 短句 "怎么看 / 怎么做"
  url:             source link when news has one

Watchlist source: env OPPS_WATCHLIST first, else Supabase public.watchlist
(via service-role key) — see scanner.watchlist_tickers().

All detectors degrade gracefully: if yfinance/requests/Supabase aren't
available, they return [] rather than crashing the scanner thread.
"""

from __future__ import annotations

import hashlib
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from .scanner import BaseDetector, Opportunity, watchlist_tickers

logger = logging.getLogger(__name__)


# ----- helpers ----------------------------------------------------------

def _hid(*parts: str) -> str:
    raw = "|".join(str(p) for p in parts)
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _hour_bucket(hours: int = 1) -> int:
    return int(time.time() // (3600 * hours))


def _strats_for(category: str, trend: str, ticker: Optional[str] = None) -> List[str]:
    """Pick 2–3 strategy IDs from static/strategies.js by (category, trend)."""
    if category == "macro":
        return {
            "bearish": ["protective_put", "vix_hedge", "barbell"],
            "bullish": ["trend_following", "momentum", "leveraged_etf_trend"],
        }.get(trend, ["dca", "cash_reserve"])
    if category == "signal":
        return {
            "bullish": ["trend_following", "breakout", "momentum"],
            "bearish": ["fixed_stop", "scaled_tp", "covered_call"],
        }.get(trend, ["mean_reversion", "grid"])
    if category == "earnings":
        return ["iv_crush", "iron_condor", "long_straddle"]
    if category == "crypto":
        return {
            "bearish": ["dca", "grid", "mean_reversion"],
            "bullish": ["trend_following", "momentum", "scaled_tp"],
        }.get(trend, ["dca", "grid"])
    return ["event_driven", "scaled_tp", "fixed_stop"]


def _infer_trend_from_pct(pct: float) -> str:
    if pct >= 1.0: return "bullish"
    if pct <= -1.0: return "bearish"
    return "neutral"


_BEARISH_WORDS = ("downgrade", "miss", "lawsuit", "probe", "fraud", "warn", "guide down",
                  "降级", "下调", "诉讼", "调查", "亏损", "暴跌", "崩盘", "裁员")
_BULLISH_WORDS = ("upgrade", "beat", "raises", "approved", "blowout", "guide up",
                  "升级", "上调", "批准", "超预期", "暴涨", "大涨", "签约")


def _classify_news(title: str) -> str:
    s = title.lower()
    bear = any(w in s for w in _BEARISH_WORDS)
    bull = any(w in s for w in _BULLISH_WORDS)
    if bear and not bull: return "bearish"
    if bull and not bear: return "bullish"
    return "neutral"


# ============================================================ Macro snapshot

class MacroSnapshotDetector(BaseDetector):
    """Pulls a basket of macro instruments via yfinance, emits one
    'opportunity' per instrument when |1d Δ%| ≥ 0.5% (severity scales).
    """

    name = "macro_snapshot"
    interval_sec = 1800  # 30 min

    _SYMBOLS: List[Tuple[str, str, str]] = [
        ("^VIX",       "VIX 恐慌指数",     "macro_vix"),
        ("^TNX",       "美 10Y 国债收益率", "macro_yield"),
        ("DX-Y.NYB",   "美元指数 DXY",     "macro_dxy"),
        ("GC=F",       "COMEX 黄金",       "macro_gold"),
        ("CL=F",       "WTI 原油",         "macro_oil"),
        ("SPY",        "标普 500 (SPY)",   "macro_spy"),
        ("QQQ",        "纳斯达克 100 (QQQ)", "macro_qqq"),
    ]

    def run(self) -> List[Opportunity]:
        try:
            import yfinance as yf  # type: ignore
        except Exception:
            return []
        out: List[Opportunity] = []
        bucket = _hour_bucket(2)
        for sym, zh, slug in self._SYMBOLS:
            try:
                hist = yf.Ticker(sym).history(period="5d", interval="1d", auto_adjust=False)
                if hist is None or len(hist) < 2:
                    continue
                last = float(hist["Close"].iloc[-1])
                prev = float(hist["Close"].iloc[-2])
                if prev <= 0:
                    continue
                pct = (last - prev) / prev * 100
            except Exception as e:
                logger.debug("macro_snapshot %s failed: %s", sym, e)
                continue

            abs_pct = abs(pct)
            if abs_pct < 0.5:
                continue

            severity = "high" if abs_pct >= 3 else ("watch" if abs_pct >= 1.5 else "info")
            arrow = "📈" if pct >= 0 else "📉"
            trend = self._trend_for(sym, pct)
            note = self._note_for(sym, pct)

            out.append(Opportunity(
                id=_hid("macro", slug, str(bucket)),
                source=self.name,
                type=slug,
                ticker=sym,
                severity=severity,
                category="macro",
                trend=trend,
                headline=f"{arrow} {zh} {pct:+.2f}% (现价 {last:,.2f})",
                body=f"24h 变动 {pct:+.2f}%；当前 {last:,.2f}，前日 {prev:,.2f}。",
                strategy_note=note,
                payload={"symbol": sym, "last": last, "prev": prev, "pct": pct},
                suggested_strategies=_strats_for("macro", trend),
                expires_at=(datetime.now(timezone.utc) + timedelta(hours=6)).isoformat(),
            ))
        return out

    def _trend_for(self, symbol: str, pct: float) -> str:
        # VIX up → risk-off → bearish for stocks
        if symbol == "^VIX": return "bearish" if pct >= 1 else ("bullish" if pct <= -1 else "neutral")
        # Rates up → bearish for growth
        if symbol == "^TNX": return "bearish" if pct >= 1 else ("bullish" if pct <= -1 else "neutral")
        # DXY up → bearish for risk + commodities
        if symbol == "DX-Y.NYB": return "bearish" if pct >= 0.5 else ("bullish" if pct <= -0.5 else "neutral")
        # Gold up sharply → flight-to-safety → bearish for risk
        if symbol == "GC=F": return "bearish" if pct >= 1.5 else "neutral"
        # Oil ±3% → inflation pressure → bearish for growth on the upside
        if symbol == "CL=F" and pct >= 3: return "bearish"
        if symbol == "CL=F" and pct <= -3: return "bullish"
        # SPY/QQQ — direct
        return _infer_trend_from_pct(pct)

    def _note_for(self, symbol: str, pct: float) -> str:
        if symbol == "^VIX" and pct >= 5:
            return "VIX 跳升 = 风险偏好回落。短期可减少高 beta 仓位 / 加 put 保护；中期等 VIX 回到 20 以下再加仓。"
        if symbol == "^VIX" and pct <= -5:
            return "VIX 显著回落 = 风险偏好回暖。短期可考虑卖出之前的对冲、加仓优质 beta。"
        if symbol == "^TNX" and pct >= 2:
            return "10Y 利率快速上行，高估值成长股承压；可考虑减仓长久期科技、加现金 / 短债。"
        if symbol == "DX-Y.NYB" and pct >= 0.5:
            return "美元走强：商品、新兴市场、海外营收占比高的科技股短期承压。"
        if symbol in ("SPY", "QQQ") and pct >= 1.5:
            return "宽基指数强势上行，趋势跟随策略可加仓；带紧 trailing stop。"
        if symbol in ("SPY", "QQQ") and pct <= -1.5:
            return "宽基快速下杀，先看 VIX / 利率背景再判断是急跌买入还是趋势反转。"
        if symbol == "CL=F" and abs(pct) >= 3:
            return "原油单日 ±3% 以上波动，留意能源股 / 通胀预期联动；不轻易接刀子。"
        return "属于日常宏观波动，观察即可，不必动仓。"


# ============================================================ Watchlist news

class WatchlistNewsDetector(BaseDetector):
    """For each watchlist ticker, fetch fresh news headlines via yfinance
    (always) and Finnhub (when FINNHUB_API_KEY set). Dedup by URL.
    """

    name = "watchlist_news"
    interval_sec = 900  # 15 min

    _seen_urls: set = set()

    def run(self) -> List[Opportunity]:
        tickers = watchlist_tickers(limit=20)
        if not tickers:
            return []
        try:
            import yfinance as yf  # type: ignore
        except Exception:
            yf = None
        finnhub_key = os.environ.get("FINNHUB_API_KEY")

        out: List[Opportunity] = []
        cutoff_ts = (datetime.now(timezone.utc) - timedelta(hours=6)).timestamp()

        for t in tickers:
            items: List[Dict[str, Any]] = []
            # ---- yfinance news ----
            if yf is not None:
                try:
                    for n in (yf.Ticker(t).news or [])[:8]:
                        content = n.get("content") or n
                        title = (content.get("title") or "").strip()
                        url_raw = None
                        if isinstance(content.get("canonicalUrl"), dict):
                            url_raw = content["canonicalUrl"].get("url")
                        url_raw = url_raw or content.get("link")
                        publisher = None
                        if isinstance(content.get("provider"), dict):
                            publisher = content["provider"].get("displayName")
                        publisher = publisher or content.get("publisher")
                        ts_raw = content.get("pubDate") or content.get("providerPublishTime")
                        try:
                            if isinstance(ts_raw, (int, float)):
                                pub_ts = float(ts_raw)
                            elif isinstance(ts_raw, str):
                                pub_ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00")).timestamp()
                            else:
                                pub_ts = time.time()
                        except Exception:
                            pub_ts = time.time()
                        if title and url_raw and pub_ts >= cutoff_ts:
                            items.append({"title": title, "url": url_raw, "publisher": publisher, "ts": pub_ts})
                except Exception as e:
                    logger.debug("wl_news yfinance %s failed: %s", t, e)

            # ---- Finnhub news ----
            if finnhub_key:
                try:
                    import requests
                    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
                    week_ago = (datetime.now(timezone.utc) - timedelta(days=2)).strftime("%Y-%m-%d")
                    r = requests.get(
                        "https://finnhub.io/api/v1/company-news",
                        params={"symbol": t, "from": week_ago, "to": today, "token": finnhub_key},
                        timeout=6,
                    )
                    if r.ok:
                        for n in (r.json() or [])[:8]:
                            title = (n.get("headline") or "").strip()
                            url_raw = n.get("url") or ""
                            pub_ts = float(n.get("datetime") or 0)
                            if title and url_raw and pub_ts >= cutoff_ts:
                                items.append({
                                    "title": title, "url": url_raw,
                                    "publisher": n.get("source") or "Finnhub",
                                    "ts": pub_ts,
                                })
                except Exception as e:
                    logger.debug("wl_news finnhub %s failed: %s", t, e)

            seen_in_run = set()
            for it in items:
                url_raw = it["url"]
                if not url_raw or url_raw in seen_in_run or url_raw in self._seen_urls:
                    continue
                seen_in_run.add(url_raw)
                self._seen_urls.add(url_raw)
                if len(self._seen_urls) > 2000:
                    self._seen_urls = set(list(self._seen_urls)[-1500:])

                trend = _classify_news(it["title"])
                severity = self._severity_for(it["title"])
                note = self._note_for(trend)
                age_min = int((time.time() - it["ts"]) / 60)
                age_str = f"{age_min}m 前" if age_min < 60 else f"{age_min // 60}h 前"
                pub = it.get("publisher") or "新闻"
                out.append(Opportunity(
                    id=_hid("news", t, url_raw),
                    source=self.name,
                    type="company_news",
                    ticker=t,
                    severity=severity,
                    category="news",
                    trend=trend,
                    headline=f"📰 {t} · {it['title'][:120]}",
                    body=f"{pub} · {age_str}",
                    url=url_raw,
                    strategy_note=note,
                    payload={"title": it["title"], "publisher": pub, "ts": it["ts"]},
                    suggested_strategies=_strats_for("news", trend, t),
                    expires_at=(datetime.now(timezone.utc) + timedelta(hours=12)).isoformat(),
                ))
        return out

    def _severity_for(self, title: str) -> str:
        s = title.lower()
        if any(w in s for w in ("lawsuit", "fraud", "probe", "subpoena", "诉讼", "调查", "造假", "崩盘")):
            return "critical"
        if any(w in s for w in ("downgrade", "miss", "guide down", "降级", "下调", "亏损")):
            return "high"
        if any(w in s for w in ("upgrade", "beat", "raises", "升级", "上调", "超预期")):
            return "watch"
        return "info"

    def _note_for(self, trend: str) -> str:
        if trend == "bearish":
            return "利空催化剂。短期: 减仓 / 观望，确认 EPS/营收影响后再判断中长期。"
        if trend == "bullish":
            return "利好催化剂。短期可顺势加仓但留好 trailing stop；避免在 PR 顶点追高。"
        return "中性新闻。先看市场反应（成交量、隔夜盘）再决定是否动仓。"


# ============================================================ Earnings calendar

class EarningsCalendarDetector(BaseDetector):
    """Pull earnings calendar for the next 7d via Finnhub; filter to
    watchlist tickers. Needs FINNHUB_API_KEY (silent no-op otherwise).
    """

    name = "earnings_calendar"
    interval_sec = 3600

    def run(self) -> List[Opportunity]:
        tickers = set(watchlist_tickers(limit=30))
        if not tickers:
            return []
        finnhub_key = os.environ.get("FINNHUB_API_KEY")
        if not finnhub_key:
            return []
        try:
            import requests
            now = datetime.now(timezone.utc)
            r = requests.get(
                "https://finnhub.io/api/v1/calendar/earnings",
                params={
                    "from": now.strftime("%Y-%m-%d"),
                    "to": (now + timedelta(days=7)).strftime("%Y-%m-%d"),
                    "token": finnhub_key,
                },
                timeout=6,
            )
            if not r.ok:
                return []
            rows = (r.json() or {}).get("earningsCalendar") or []
        except Exception as e:
            logger.debug("earnings_cal failed: %s", e)
            return []

        out: List[Opportunity] = []
        bucket = _hour_bucket(24)
        now = datetime.now(timezone.utc)
        for row in rows:
            tkr = (row.get("symbol") or "").upper()
            if tkr not in tickers:
                continue
            date = row.get("date")
            hour = row.get("hour") or ""
            eps_est = row.get("epsEstimate")
            rev_est = row.get("revenueEstimate")
            when = "盘后" if hour == "amc" else ("盘前" if hour == "bmo" else "盘中")
            try:
                days_until = max(0, (datetime.fromisoformat(date).date() - now.date()).days)
            except Exception:
                days_until = 7
            severity = "high" if days_until <= 1 else "watch"
            note = self._note_for(days_until)
            try:
                expires = (datetime.fromisoformat(date).replace(tzinfo=timezone.utc) + timedelta(days=2)).isoformat()
            except Exception:
                expires = None
            out.append(Opportunity(
                id=_hid("earnings", tkr, date or "", str(bucket)),
                source=self.name,
                type="earnings",
                ticker=tkr,
                severity=severity,
                category="earnings",
                trend="neutral",
                headline=f"📅 {tkr} 财报 · {date} {when} · 距 {days_until} 天",
                body=f"EPS 预期: {eps_est or '—'} · 营收预期: {rev_est or '—'}。",
                strategy_note=note,
                payload={"date": date, "hour": hour, "eps_est": eps_est, "rev_est": rev_est},
                suggested_strategies=_strats_for("earnings", "neutral"),
                expires_at=expires,
            ))
        return out

    def _note_for(self, days_until: int) -> str:
        if days_until <= 1:
            return "财报即将公布。IV 通常已经高估，期权裸卖风险大；可考虑 iron condor 收割 IV crush。"
        if days_until <= 3:
            return "财报前 1-3 天，仓位先调整到 risk-defined。等业绩出来后再判断方向。"
        return "财报临近，本周关注会议时间 + 关键指标预期。"


# ============================================================ Trend signal

class TrendSignalDetector(BaseDetector):
    """Per watchlist ticker: MA20/MA50 cross, RSI(14) extremes, 5d momentum."""

    name = "trend_signal"
    interval_sec = 3600

    def run(self) -> List[Opportunity]:
        tickers = watchlist_tickers(limit=20)
        if not tickers:
            return []
        try:
            import yfinance as yf  # type: ignore
        except Exception:
            return []

        out: List[Opportunity] = []
        bucket = _hour_bucket(24)
        for t in tickers:
            try:
                hist = yf.Ticker(t).history(period="90d", interval="1d", auto_adjust=False)
                if hist is None or len(hist) < 60:
                    continue
                closes = hist["Close"].astype(float)
                last_close = float(closes.iloc[-1])
                ma20 = float(closes.iloc[-20:].mean())
                ma50 = float(closes.iloc[-50:].mean())
                rsi = self._rsi([float(x) for x in closes.values], period=14)
                mom_5d = (last_close / float(closes.iloc[-6]) - 1) * 100 if len(closes) >= 6 else 0.0
                ma20_y = float(closes.iloc[-21:-1].mean())
                ma50_y = float(closes.iloc[-51:-1].mean())
            except Exception as e:
                logger.debug("trend_signal %s failed: %s", t, e)
                continue

            events: List[Tuple[str, str, str, str, str]] = []

            if ma20_y < ma50_y and ma20 > ma50:
                events.append((
                    f"⚡ {t} 日线金叉 (MA20 上穿 MA50)",
                    "golden_cross", "high", "bullish",
                    "趋势转多。中期可加仓；若已在仓位中，trailing stop 收紧到 MA20。",
                ))
            elif ma20_y > ma50_y and ma20 < ma50:
                events.append((
                    f"⚠ {t} 日线死叉 (MA20 下穿 MA50)",
                    "death_cross", "high", "bearish",
                    "趋势转空。中期减仓 / 加对冲；强势反弹视为反弹做空机会。",
                ))

            if rsi >= 75:
                events.append((
                    f"🔥 {t} RSI {rsi:.0f} · 严重超买",
                    "rsi_overbought", "watch", "bearish",
                    "短线超买，分批 take-profit；不要追高加仓。",
                ))
            elif rsi <= 28:
                events.append((
                    f"🧊 {t} RSI {rsi:.0f} · 严重超卖",
                    "rsi_oversold", "watch", "bullish",
                    "短线超卖，分批左侧 DCA 入场；不要梭哈。",
                ))

            if mom_5d >= 12:
                events.append((
                    f"🚀 {t} 5 日动量 +{mom_5d:.1f}%",
                    "momentum_up", "watch", "bullish",
                    "短期动量明显，趋势跟随策略适用；带紧 stop。",
                ))
            elif mom_5d <= -12:
                events.append((
                    f"📉 {t} 5 日动量 {mom_5d:.1f}%",
                    "momentum_down", "watch", "bearish",
                    "急跌中，先确认基本面无重大变化再决定是否抄底。",
                ))

            for headline, slug, sev, trend, note in events:
                out.append(Opportunity(
                    id=_hid("signal", t, slug, str(bucket)),
                    source=self.name,
                    type=slug,
                    ticker=t,
                    severity=sev,
                    category="signal",
                    trend=trend,
                    headline=headline,
                    body=f"现价 {last_close:.2f} · MA20 {ma20:.2f} · MA50 {ma50:.2f} · RSI {rsi:.1f} · 5d {mom_5d:+.1f}%",
                    strategy_note=note,
                    payload={"last": last_close, "ma20": ma20, "ma50": ma50, "rsi": rsi, "mom_5d": mom_5d},
                    suggested_strategies=_strats_for("signal", trend, t),
                    expires_at=(datetime.now(timezone.utc) + timedelta(hours=24)).isoformat(),
                ))
        return out

    @staticmethod
    def _rsi(values: List[float], period: int = 14) -> float:
        if len(values) < period + 1:
            return 50.0
        deltas = [values[i] - values[i - 1] for i in range(1, len(values))]
        gains = [d if d > 0 else 0.0 for d in deltas]
        losses = [-d if d < 0 else 0.0 for d in deltas]
        avg_g = sum(gains[:period]) / period
        avg_l = sum(losses[:period]) / period
        for i in range(period, len(deltas)):
            avg_g = (avg_g * (period - 1) + gains[i]) / period
            avg_l = (avg_l * (period - 1) + losses[i]) / period
        if avg_l == 0:
            return 100.0
        rs = avg_g / avg_l
        return 100 - (100 / (1 + rs))


# ============================================================ Crypto pulse

class CryptoPulseDetector(BaseDetector):
    """BTC + ETH + SOL spot from CoinGecko, 30-min cadence."""

    name = "crypto_pulse"
    interval_sec = 1800

    _COINS = [
        ("bitcoin",  "BTC-USD", "比特币 BTC"),
        ("ethereum", "ETH-USD", "以太坊 ETH"),
        ("solana",   "SOL-USD", "Solana SOL"),
    ]

    def run(self) -> List[Opportunity]:
        try:
            import requests
        except Exception:
            return []
        try:
            r = requests.get(
                "https://api.coingecko.com/api/v3/coins/markets",
                params={
                    "vs_currency": "usd",
                    "ids": "bitcoin,ethereum,solana",
                    "price_change_percentage": "24h",
                },
                timeout=6,
            )
            r.raise_for_status()
            data = {x["id"]: x for x in (r.json() or [])}
        except Exception as e:
            logger.debug("crypto_pulse coingecko failed: %s", e)
            return []
        out: List[Opportunity] = []
        bucket = _hour_bucket(1)
        for cid, ticker, zh in self._COINS:
            d = data.get(cid)
            if not d:
                continue
            price = float(d.get("current_price") or 0)
            pct = float(d.get("price_change_percentage_24h") or 0)
            vol = float(d.get("total_volume") or 0)
            if price <= 0:
                continue
            arrow = "📈" if pct >= 0 else "📉"
            severity = "high" if abs(pct) >= 6 else ("watch" if abs(pct) >= 3 else "info")
            trend = _infer_trend_from_pct(pct)
            note = (
                "波动放大，趋势跟随策略适用；带紧 stop。" if pct >= 4 else
                "急跌，先看资金费率和持仓量再判断是否抄底。" if pct <= -4 else
                "正常波动，DCA / 网格策略适用。"
            )
            out.append(Opportunity(
                id=_hid("crypto", cid, str(bucket)),
                source=self.name,
                type="crypto_snapshot",
                ticker=ticker,
                severity=severity,
                category="crypto",
                trend=trend,
                headline=f"{arrow} {zh} ${price:,.0f} · 24h {pct:+.2f}%",
                body=f"24h 成交额 ${vol/1e9:.2f}B。来源：CoinGecko。",
                strategy_note=note,
                payload={"price": price, "pct_24h": pct, "volume_24h": vol},
                suggested_strategies=_strats_for("crypto", trend, ticker),
                expires_at=(datetime.now(timezone.utc) + timedelta(hours=2)).isoformat(),
            ))
        return out


# ============================================================ default set

def default_detectors() -> List[BaseDetector]:
    """Default set for v2.5+. Env override `OPPS_DETECTORS=macro,news,...`."""
    enabled = os.environ.get("OPPS_DETECTORS",
                             "macro,news,earnings,signal,crypto").lower()
    enabled_set = {x.strip() for x in enabled.split(",") if x.strip()}
    out: List[BaseDetector] = []
    if "macro" in enabled_set:    out.append(MacroSnapshotDetector())
    if "news" in enabled_set:     out.append(WatchlistNewsDetector())
    if "earnings" in enabled_set: out.append(EarningsCalendarDetector())
    if "signal" in enabled_set:   out.append(TrendSignalDetector())
    if "crypto" in enabled_set:   out.append(CryptoPulseDetector())
    return out
