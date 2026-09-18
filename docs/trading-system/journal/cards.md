# 决策卡台账（cards.md）

> SPEC §8 流程③ 的跨对话唯一台账，skill 载体自动维护。**追加式，只增不改**——
> event_key 去重、失效条件核对、周检/月检打分都以本文件为准。
> GO / WAIT 卡整卡（YAML 块）追加到「卡片正文」区末尾；NO_GO 卡只在索引记一行。

## 索引

| card_id | 日期 | 标的 | playbook | verdict | valid_until |
|---------|------|------|----------|---------|-------------|
| DC-2026-001 | 2026-07-28 | MU | 无匹配（neutral 收租型；PB-1 因 σ60 白名单禁用） | NO_GO | — |
| DC-2026-002 | 2026-09-18 | GOOG | PB-4 事件驱动（debit vertical） | WAIT | 2026-09-25 |

## 卡片正文（追加区）

### DC-2026-002 · GOOG 牛市看涨价差（WAIT）

```yaml
decision_card:
  card_id: DC-2026-002
  date: 2026-09-18
  symbol: GOOG (Alphabet Cl-C)
  direction: long
  horizon: swing（至 2026-11-20 到期，44 交易日）
  instrument: option — bull call debit spread
  conviction: 4
  verdict: WAIT
  verdict_reason: >
    结构判据未过：用户选定的 Nov20 350/390 价差 RR=2.25，p×RR=0.891 < 1（§0.1 方向性判据）。
    可由改行权价弥补（已算出三组过闸替代），故为 WAIT 而非 NO_GO。
    组合闸在用户口径 open_risk=2% 下通过（2.35% ≤ 5.0%）。

  inequality_check:
    trade_type: directional
    playbook: PB-4 事件驱动（debit 结构强制 defined-risk，跨 2026-10-28 财报）
    p_estimate: 0.396
    p_range: [0.316, 0.476]
    rr: 2.25
    p_x_rr: 0.891          # FAIL，须 > 1；本结构需 RR > 2.53
    l0_z: 0.79             # 自洽（底层需涨 11.44% 至 390，44 交易日，σ60=34.8%）
    l0_rr_max_at_min_stop: 3.43
    expectancy_R: 0.287    # 脚本口径；p×RR<1 时不构成开仓理由

  p_scoring:               # §4 四步，每项可逐条反驳
    base_rate: 0.45        # PB-4，无个人历史
    delta_regime: 0        # L1 美元流动性快照缺失 → 无先验
    delta_narrative: 0     # L2 命题库快照缺失 → 无先验
    delta_fundamental: 0   # L3 score_riskadj 查不到 → 45–55 档，Δp=0，无先验
    delta_technical: +2    # 价/MA200=1.02；RSI 52.9 非超买；IV 52周分位 16.7% 利好 debit 方
    delta_view: 0          # 用户未提供具体论点
    debate_adjudication: -3
    calibration_factor: 0.90   # journal < 20 笔
    formula: (45 + 2 - 3) × 0.90 = 39.6%

  position:                # 判据未过，仅记录不执行
    risk_amount: 6750.53   # NAV 1,939,545.09 × 0.75% × M_regime 0.75 × M_val 0.55 × M_conv 1.125
    size: 5 张
    check: "5 × $1,230 = $6,150（应 ≤ risk_amount 6,750.53）"
    caps_hit: []
    kelly_f_star: 0.1276
    kelly_risk_cap: 24739.98

  entry:
    tactic: PB-4 事件驱动 debit vertical
    structure: BUY GOOG Nov20'26 350 Call / SELL GOOG Nov20'26 390 Call
    net_debit: 12.30       # 最差成交口径（买 ask 18.10 / 卖 bid 5.80）
    max_profit: 27.70
    breakeven: 362.30      # 距现价 +3.5%
    valid_until: 2026-09-25

  stop:
    initial: 价差市值跌至成本 50%（6.15）
    basis: 结构层止损；§6.2 口径
    risk_budget_basis: 全额权利金 $1,230/张 计为 1R——跨财报跳空不保证 50% 止损能成交
    time_stop: DTE < 21 天仍未达下轨 350 → 退出

  targets:
    T1: 390（价差上轨，最大盈利 27.70/张）

  risk_report:
    scenarios:
      bear: {prob: 0.524, pnl: -6150, cond: 到期 < 350}
      base: {prob: 0.310, pnl: +1350, cond: 到期 350–390}
      bull: {prob: 0.166, pnl: +13850, cond: 到期 > 390}
    ev_dollars: -505
    ev_note: >
      三情景概率取 IV 隐含对数正态。EV 为负是结构性的——用市场自身隐含概率计价，
      任何期权结构 EV ≈ 负（差一个买卖价差）。正期望的唯一来源是 view 认为真实概率
      偏离市场定价；本卡 Δp_view = 0，故无边缘。
    portfolio_after: >
      总 open risk 2.35%（用户口径 2% + 本笔 0.32%，上限 5.0%）✓；
      AI/半导体叙事敞口 133.4% NAV（MU 51.1% + DRAM 30.1% + SMH 29.2% + CHAT 22.9%），
      §5.3 上限 30% → 超限 4.4 倍 ✗；GOOG 单标的 7.2% NAV ✓（上限 15%）；
      账户杠杆 1.49×，初始保证金/NAV 44.6%。

  thesis_registration:
    claim: >
      用户表述为「看好 GOOG」，未提供具体催化剂、逻辑或时间窗口。
      经两次询问仍未补充，按实录入——本卡不含任何 GOOG 特定信息。
    quantified_triggers: []
    invalidation:          # 用户确认（L0b）
      - 2026-10-28 财报云业务增速下滑
      - 价差市值跌至成本 50%
    invalidation_note: 用户明确去掉均线类失效条件，只保留上述两条
    implied_p: 0.396
    review_schedule: 每周五；2026-10-28 财报次日强制

  debate:                  # §8 swing = 2 轮
    rounds:
      - bull: IV 52 周分位 16.7%，debit 结构买在波动率便宜处；价在 MA200 上方 2%；RSI 52.9 中性；盘前上破 20 日高 345.71。
        bear: 市场隐含 P(到期 > 362.30) = 36.3%，卡内 p 为 39.6%——3.3pp 差额全部来自 playbook 基准率，无一来自 GOOG 本身信息。
      - bull: 已持 GOOG 400 股（成本 350.39，基本打平），本笔为既有仓位延续而非新开叙事。
        bear: 组合已 133% NAV 押注 AI/半导体单一叙事，§5.3 上限 30%，超限 4.4 倍；CHAT 本身重仓 GOOG，加仓不是分散是加倍。
    adjudication: >
      p 修正 -3pp。触发证据两条：①隐含概率交叉校验（36.3%）低于 base_rate（45%）；
      ②叙事集中度击穿 §5.3。RR 不修正——RR 由结构决定，非估计量。

  wait_triggers:           # 解除 WAIT 的条件（任一）
    - 改用 RR ≥ 2.53 的行权价组合，重跑判据：
        - Nov20 350/400：净支出 13.80，RR 2.62，p×RR 1.038，4 张（$5,520）
        - Nov20 360/390：净支出 8.20，RR 2.66，p×RR 1.053，8 张（$6,560）
        - Nov20 360/400：净支出 9.70，RR 3.12，p×RR 1.236，6 张（$5,820）
    - 提供具体可证伪的 view → Δp_view 可达 ±5pp，p 上移后 350/390 或可过线

  data_timestamps:
    GOOG 行情（market_snapshot）: 2026-09-17 收盘（asof 当日最新收盘）
    GOOG/期权报价（IBKR）: 2026-09-18 08:10 UTC 盘前 — 逐合约 IV 盘前无效，期权 last 为 09-17 收盘标记；开盘后须重新核价
    IV / HV / IV 分位（IBKR）: 2026-09-18 实时 — IV 28.58%，HV30 21.03%，IV 52周分位 16.7%
    账户 NAV / 持仓（IBKR）: 2026-09-18 实时
    L1 美元流动性快照: 缺失（不在本机）→ M_regime 按偏紧档 0.75 保守处理
    L2 命题库 taxonomy.json: 缺失 → Δp_narrative = 0，无先验；悲观路径周 Δ 跳过
    L3 tradingforge score_riskadj: 查不到 → 45–55 档，Δp = 0，M_valuation = 0.55（偏贵档缺省）
    L4 PutWheel current_state.json: 缺失（本笔非收租型，不影响）
    现有持仓未平仓风险: 用户口径估值 2% NAV（未登记止损位）

  caveats:
    - 期权报价为盘前，标的盘前 +1.83% 而期权 bid/ask 未充分重定价——所有价格开盘后必须重核
    - 三层快照缺失（L1/L2/L3），三个 Δp 全记 0，p 几乎完全由 playbook 基准率决定
    - GOOG 与 GOOGL 是不同代码（本卡为 GOOG，Cl-C）；用户既有持仓亦为 GOOG 400 股
```

决策支持，非投资建议；执行与否由你决定。

