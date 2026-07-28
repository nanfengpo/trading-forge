#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""决策算术引擎——SPEC v1.1 的唯一算术实现（§3 L0a / §0.1 判据 / §5 四道仓位闸门 / 三情景 EV）。

设计原则：LLM 建议、代码守门。决策卡里出现的每一个数字都必须来自本脚本的输出，
禁止任何一方（人或 AI）心算。V2 服务端复算同样调用本脚本，不一致以脚本为准。

用法:
    python3 decision_math.py --json request.json     # 从文件读输入
    cat request.json | python3 decision_math.py      # 从 stdin 读输入
    python3 decision_math.py --selftest              # 用 SPEC 内置示例自检
    python3 decision_math.py --schema                # 打印输入字段说明

输入为一个 JSON 对象，比率一律用小数（15% → 0.15）。按提供的字段计算对应分节，
缺哪节的字段就跳过哪节（输出里不出现该节）。
"""
import argparse
import json
import math
import sys

HORIZON_DAYS = {"day": 1, "swing": 25, "position": 85, "campaign": 160}
HARD_CAP_PCT = 0.012  # §5.1：任何乘数组合都不能让单笔风险超过 1.2% NAV

SCHEMA = """输入字段（全部可选，按需组合；比率用小数）：
  # L0 目标自洽预检（§3 L0a）
  expected_return   本笔目标收益（占用资金口径）
  horizon           day|swing|position|campaign（或直接给 horizon_days）
  sigma60           60 日年化波动
  price / atr14     现价与 ATR14（隐含 RR 上界检查用）

  # 方向性仓位（§5.1–5.4）
  nav               账户净值（美元）
  max_loss_pct      单笔最大亏损占 NAV（默认 0.0075）
  m_regime          L1 乘数（默认 1.0）
  m_valuation       L3 乘数（默认 1.0）
  conviction        1–5（默认 3 → M_conviction=1.0）
  direction         long|short（默认 long）
  entry / stop      入场价与初始止损
  targets           [[价格, 比例], ...]（加权 RR；T3 保守取 T2 同值由调用方决定）
  rr                直接给盈亏比（有 targets 时以 targets 为准）
  p                 校准折减后的成功概率（1/10 Kelly 与判据用）
  option_max_loss_per_contract   期权类：每张最大亏损（给出则按张数出仓位）
  vol_tolerance / n_eff          波动预算（§5.4；n_eff 含本笔、按叙事合并）

  # 组合闸（§5.3）
  max_drawdown      组合回撤容忍
  open_risk_pct     现有总未平仓风险占 NAV

  # 三情景 EV（§2 risk_report）
  scenarios         [[概率, 美元盈亏], ...]，概率和须 = 1

  # 收租型（§0.1）
  income: {p, w, l, l_tail, notional, risk_budget}
        p=逐笔回测胜率  w=平均盈利率  l=平均亏损率
        l_tail=尾部亏损率（历史最差与压力情景更差者） notional=名义 risk_budget=该笔风险预算（美元）
"""


def _r(x, n=4):
    return None if x is None else round(x, n)


def l0(d):
    """§3 L0a：目标自洽 Z 值 + 隐含 RR 上界。"""
    out = {}
    er = d.get("expected_return")
    sig = d.get("sigma60")
    days = d.get("horizon_days") or HORIZON_DAYS.get(d.get("horizon", ""))
    price = d.get("price") or d.get("entry")
    atr = d.get("atr14")
    if er and sig and days:
        z = er / (sig * math.sqrt(days / 252))
        out["z"] = _r(z, 2)
        out["z_days_used"] = days
        out["z_verdict"] = (
            "自洽" if z <= 1.0
            else "偏紧（1–2σ，达成依赖强催化剂）" if z <= 2.0
            else "不自洽 → 还价，不进五层"
        )
    if er and atr and price:
        rr_max = er * price / (1.5 * atr)
        out["rr_max_at_min_stop"] = _r(rr_max, 2)
        if rr_max < 1.5:
            out["rr_max_verdict"] = "目标与波动结构不匹配（最紧合规止损下 RR 上界 <1.5）→ 还价"
    return out or None


def directional(d):
    """§5.1 风险预算 → §5.2 1/10 Kelly → 股数/张数 → §5.4 波动预算。"""
    if not all(k in d for k in ("nav", "entry", "stop")):
        return None, None
    nav, entry, stop = d["nav"], d["entry"], d["stop"]
    direction = d.get("direction", "long")
    dist = abs(entry - stop)
    if dist <= 0:
        raise ValueError("entry 与 stop 不能相等")
    mc = 0.75 + 0.125 * (max(1, min(5, int(d.get("conviction", 3)))) - 1)
    m_regime = d.get("m_regime", 1.0)
    m_val = d.get("m_valuation", 1.0)
    caps = []
    risk = nav * d.get("max_loss_pct", 0.0075) * m_regime * m_val * mc
    if risk > HARD_CAP_PCT * nav:
        risk = HARD_CAP_PCT * nav
        caps.append("1.2% NAV 硬顶")

    rr = d.get("rr")
    tgt = d.get("targets")
    if tgt:
        sgn = -1 if direction == "short" else 1
        rr = sum(f * (sgn * (t - entry)) / dist for t, f in tgt)

    p = d.get("p")
    kelly = None
    if p is not None and rr:
        f_star = p - (1 - p) / rr
        kelly = {"f_star": _r(f_star), "risk_cap_kelly10": _r(max(f_star, 0) / 10 * nav, 2)}
        if f_star <= 0:
            caps.append("f*≤0：判据未过，不可开仓")
            risk = 0
        elif f_star / 10 * nav < risk:
            risk = f_star / 10 * nav
            caps.append("1/10 Kelly")

    out = {
        "m_conviction": mc, "m_regime": m_regime, "m_valuation": m_val,
        "risk_amount": _r(risk, 2), "stop_distance": _r(dist), "caps_hit": caps,
    }
    opt_ml = d.get("option_max_loss_per_contract")
    if opt_ml:
        n = int(risk // opt_ml)
        out["contracts"] = n
        out["check"] = f"{n} 张 × ${opt_ml} = ${_r(n * opt_ml, 2)}（应 ≤ risk_amount {_r(risk, 2)}）"
    else:
        shares = int(risk // dist)
        nominal = shares * entry
        vt, sig, neff = d.get("vol_tolerance"), d.get("sigma60"), d.get("n_eff")
        if vt and sig and neff:
            cap_nom = nav * vt / (sig * math.sqrt(neff))
            out["vol_budget_nominal_cap"] = _r(cap_nom, 2)
            if nominal > cap_nom:
                shares = int(cap_nom // entry)
                nominal = shares * entry
                caps.append("波动预算 §5.4")
        out["shares"] = shares
        out["nominal"] = _r(nominal, 2)
        out["nominal_pct_nav"] = _r(nominal / nav * 100, 2)
        out["check"] = f"{shares} × {_r(dist, 2)} ≈ ${_r(shares * dist, 2)}（应 ≤ risk_amount {_r(risk, 2)}）"
    if kelly:
        out["kelly"] = kelly

    ineq = {}
    if rr:
        ineq["rr_weighted"] = _r(rr, 2)
    if p is not None and rr:
        ineq.update({
            "p": p,
            "p_x_rr": _r(p * rr, 3),
            "expectancy_R": _r(p * rr - (1 - p), 3),
            "verdict": "PASS（p×RR>1）" if p * rr > 1 else "FAIL（p×RR≤1 → 最多 WAIT）",
        })
    return out, (ineq or None)


def portfolio(d, risk_amount):
    """§5.3：总未平仓风险 ≤ max_drawdown / 2。"""
    md, orp, nav = d.get("max_drawdown"), d.get("open_risk_pct"), d.get("nav")
    if md is None or orp is None or not nav or risk_amount is None:
        return None
    after = orp + risk_amount / nav
    lim = md / 2
    return {
        "open_risk_after_pct": _r(after * 100, 2),
        "limit_pct": _r(lim * 100, 2),
        "verdict": "PASS" if after <= lim else "FAIL（总未平仓风险超 max_drawdown/2）",
    }


def scenarios(d):
    """§2 risk_report：三情景 EV，概率和须 = 1。"""
    sc = d.get("scenarios")
    if not sc:
        return None
    psum = sum(s[0] for s in sc)
    out = {"prob_sum": _r(psum, 3), "ev_dollars": _r(sum(s[0] * s[1] for s in sc), 2)}
    if abs(psum - 1) > 0.001:
        out["warning"] = "三情景概率和 ≠ 1，须修正"
    return out


def income(d):
    """§0.1 收租型：EPR + 三档稳健性 + 尾部约束。"""
    inc = d.get("income")
    if not inc:
        return None
    p, w, l = inc["p"], inc["w"], inc["l"]

    def epr(pp):
        return pp * w / ((1 - pp) * l)

    e0, e2 = epr(p), epr(p - 0.02)
    tier = (
        "全仓：可用 playbook 预设档位全额" if e2 >= 1.5
        else "半仓档：该 playbook 全部仓位预设与 §5.5 闸门按 50% 执行" if e2 >= 1.3
        else "禁用该参数组合"
    )
    out = {"epr": _r(e0, 2), "epr_p_minus_2pp": _r(e2, 2), "robustness_tier": tier}
    lt, no, rb = inc.get("l_tail"), inc.get("notional"), inc.get("risk_budget")
    if lt and no and rb:
        tail = lt * no
        out["tail_loss"] = _r(tail, 2)
        out["tail_gate"] = "PASS" if tail <= 1.2 * rb else f"FAIL（{_r(tail, 2)} > 1.2 × {rb}）"
    return out


def compute(d):
    res = {}
    x = l0(d)
    if x:
        res["l0"] = x
    pos, ineq = directional(d)
    if pos:
        res["position"] = pos
        if ineq:
            res["inequality"] = ineq
        pf = portfolio(d, pos["risk_amount"])
        if pf:
            res["portfolio"] = pf
    sc = scenarios(d)
    if sc:
        res["scenarios"] = sc
    inc = income(d)
    if inc:
        res["income"] = inc
    return res


def selftest():
    ok = True

    def chk(name, got, want, tol=0.011):
        nonlocal ok
        good = abs(got - want) <= tol if isinstance(want, (int, float)) and not isinstance(want, bool) else got == want
        print(f"{'PASS' if good else 'FAIL'}  {name}: got={got} want={want}")
        ok = ok and good

    # SPEC §2 示例（NVDA，NAV=$100k）
    d = {
        "nav": 100_000, "max_loss_pct": 0.0075, "m_regime": 1.0, "m_valuation": 1.0,
        "conviction": 3, "entry": 181.0, "stop": 171.8, "p": 0.46, "rr": 2.8,
        "max_drawdown": 0.10, "open_risk_pct": 0.0215,
        "scenarios": [[0.30, 2600], [0.45, 900], [0.25, -750]],
    }
    pos, ineq = directional(d)
    chk("§2 risk_amount", pos["risk_amount"], 750)
    chk("§2 shares", pos["shares"], 81, 0)
    chk("§2 p×RR", ineq["p_x_rr"], 1.288)
    chk("§2 expectancy_R", ineq["expectancy_R"], 0.748)
    chk("§5.2 kelly f*", pos["kelly"]["f_star"], 0.2671)
    chk("§2 EV", scenarios(d)["ev_dollars"], 997.5)
    chk("§5.3 portfolio", portfolio(d, pos["risk_amount"])["verdict"], "PASS")
    # PB-1 QQQ 车轮（§0.1 三档稳健性）
    q = {"income": {"p": 0.966, "w": 0.0044, "l": 0.0578, "l_tail": 0.13, "notional": 6000, "risk_budget": 750}}
    inc = income(q)
    chk("PB-1 EPR", inc["epr"], 2.16)
    chk("PB-1 EPR(p−2pp)", inc["epr_p_minus_2pp"], 1.33)
    chk("PB-1 三档=半仓", inc["robustness_tier"].startswith("半仓档"), True)
    chk("PB-1 尾部约束", inc["tail_gate"], "PASS")
    # L0（swing 25 交易日，σ60=40%）
    l = l0({"expected_return": 0.15, "sigma60": 0.40, "horizon": "swing", "price": 181.0, "atr14": 4.9})
    chk("L0 Z", l["z"], 1.19)
    chk("L0 RR 上界", l["rr_max_at_min_stop"], 3.69)
    print("SELFTEST", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


def main():
    ap = argparse.ArgumentParser(description="决策算术引擎（SPEC v1.1）", add_help=True)
    ap.add_argument("--json", help="输入 JSON 文件路径（缺省读 stdin）")
    ap.add_argument("--selftest", action="store_true", help="用 SPEC 内置示例自检")
    ap.add_argument("--schema", action="store_true", help="打印输入字段说明")
    a = ap.parse_args()
    if a.selftest:
        selftest()
    if a.schema:
        print(SCHEMA)
        return
    raw = open(a.json, encoding="utf-8").read() if a.json else sys.stdin.read()
    print(json.dumps(compute(json.loads(raw)), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
