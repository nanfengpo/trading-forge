#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""个股行情快照——产出 SPEC 输入模板【市场数据】块所需字段（JSON）。

依赖 yfinance（pip install yfinance）。拿不到的字段输出 null 并附 note：
- iv_rank：免费源拿不到 → 从 IBKR/TWS 期权页手抄（做期权必填）。
- earnings_next：来源不可靠，下单前必须人工核对。

用法: python3 market_snapshot.py NVDA
"""
import json
import math
import sys


def main():
    if len(sys.argv) < 2 or sys.argv[1].startswith("-"):
        print(__doc__)
        sys.exit(0)
    symbol = sys.argv[1].upper()
    try:
        import logging

        import pandas as pd
        import yfinance as yf

        logging.getLogger("yfinance").setLevel(logging.CRITICAL)
    except ImportError:
        print(
            "缺依赖：pip install yfinance\n"
            "或按 docs/trading-system/CLAUDE-DESKTOP-PROMPT.md 的【市场数据】模板手工提供。",
            file=sys.stderr,
        )
        sys.exit(2)

    t = yf.Ticker(symbol)
    h = t.history(period="5y", auto_adjust=False)
    if h is None or h.empty:
        print(f"{symbol}: 拉不到行情数据（代码错误或无网络）", file=sys.stderr)
        sys.exit(1)

    c, hi, lo = h["Close"], h["High"], h["Low"]
    prev = c.shift(1)
    tr = pd.concat([hi - lo, (hi - prev).abs(), (lo - prev).abs()], axis=1).max(axis=1)
    atr14 = float(tr.ewm(alpha=1 / 14, adjust=False).mean().iloc[-1])  # Wilder ATR
    delta = c.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    loss = (-delta).clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    rsi14 = float((100 - 100 / (1 + gain / loss)).iloc[-1])
    price = float(c.iloc[-1])
    ma200 = float(c.rolling(200).mean().iloc[-1]) if len(c) >= 200 else None
    lr = (c / prev).dropna().apply(math.log)
    sigma60 = float(lr.tail(60).std(ddof=1) * math.sqrt(252)) if len(lr) >= 60 else None
    high5y = float(c.max())

    out = {
        "symbol": symbol,
        "asof": str(h.index[-1].date()),
        "price": round(price, 2),
        "atr14": round(atr14, 2),
        "rsi14": round(rsi14, 1),
        "ma200": round(ma200, 2) if ma200 else None,
        "price_over_ma200": round(price / ma200, 2) if ma200 else None,  # >1.45 = 抛物线警戒
        "high20": round(float(c.tail(20).max()), 2),
        "low20": round(float(c.tail(20).min()), 2),
        "sigma60_annualized": round(sigma60, 4) if sigma60 else None,
        "high_5y": round(high5y, 2),
        "drawdown_from_5y_high": round(price / high5y - 1, 4),
        "iv_rank": None,
        "earnings_next": None,
        "notes": [
            "iv_rank 需从 IBKR/TWS 期权页手抄（做期权必填）",
            "earnings_next 来源不可靠，下单前人工核对",
            "关键支撑阻力位不自动给出——结构位判断属 L4 人工/AI 评估",
        ],
    }
    try:
        cal = t.calendar
        ed = None
        if isinstance(cal, dict):
            v = cal.get("Earnings Date")
            if v:
                ed = str(v[0])
        elif cal is not None and hasattr(cal, "loc") and "Earnings Date" in getattr(cal, "index", []):
            ed = str(cal.loc["Earnings Date"][0])
        if ed:
            out["earnings_next"] = ed
    except Exception:
        pass

    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
