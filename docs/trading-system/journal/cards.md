# 决策卡台账（cards.md）

> SPEC §8 流程③ 的跨对话唯一台账，skill 载体自动维护。**追加式，只增不改**——
> event_key 去重、失效条件核对、周检/月检打分都以本文件为准。
> GO / WAIT 卡整卡（YAML 块）追加到「卡片正文」区末尾；NO_GO 卡只在索引记一行。

## 索引

| card_id | 日期 | 标的 | playbook | verdict | valid_until |
|---------|------|------|----------|---------|-------------|
| DC-2026-001 | 2026-07-28 | MU | 无匹配（neutral 收租型；PB-1 因 σ60 白名单禁用） | NO_GO | — |
| DC-2026-002 | 2026-09-18 | GOOG | PB-4 事件驱动（debit vertical） | WAIT | 2026-09-25 |
| DC-2026-003 | 2026-09-18 | GOOG | PB-4 事件驱动（debit vertical） | GO | 2026-09-25 |

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

### DC-2026-003 · GOOG 牛市看涨价差 350/400（GO）

> 本卡为 DC-2026-002（WAIT）补齐 view 后的重跑，取代之。

```yaml
decision_card:
  card_id: DC-2026-003
  date: 2026-09-18
  supersedes: DC-2026-002
  symbol: GOOG (Alphabet Cl-C)
  direction: long
  horizon: swing（至 2026-11-20 到期，44 交易日）
  instrument: option — bull call debit spread
  conviction: 4
  verdict: GO
  verdict_reason: >
    判据通过（p×RR = 1.038 > 1），四道闸全过。结构上轨 400 与用户 view 的目标价一致。
    相对 DC-2026-002 的两处变化：①行权价由 350/390 改为 350/400，RR 2.25 → 2.62；
    ②M_valuation 由缺省 0.55 上修至 0.85（实测 fwdPE 23.15 落合理档），风险预算随之放大。

  inequality_check:
    trade_type: directional
    playbook: PB-4 事件驱动（debit 结构，跨 2026-10-28 财报）
    p_estimate: 0.396
    p_range: [0.316, 0.476]
    rr: 2.62
    p_x_rr: 1.038          # PASS
    l0_z: 0.98             # 自洽（目标 400 = +14.29%，44 交易日，σ60 34.8%）
    l0_rr_max_at_min_stop: 4.29
    expectancy_R: 0.434

  p_scoring:
    base_rate: 0.45        # PB-4，无个人历史
    delta_regime: 0        # L1 快照缺失 → 无先验
    delta_narrative: 0     # L2 命题库缺失 → 无先验（催化剂信息计入 Δp_view，避免重复计数）
    delta_technical: +2    # 价/MA200 = 1.02；RSI 52.9 非超买；IV 52 周分位 16.7% 利好 debit 方
    delta_fundamental: 0   # 无 score_riskadj；估值走 M_valuation，不在此重复计
    delta_view: 0          # 见下「view 事实核验」——催化剂为公开传闻且前提部分证伪，不给正分
    debate_adjudication: -3
    calibration_factor: 0.90
    formula: (45 + 2 - 3) × 0.90 = 39.6%

  view_fact_check:         # 用户 view 的可核验部分，逐条对证
    claim_1:
      user: "上一次 Gemini 3.5 发布已过去三个多月"
      finding: 部分证伪 — Gemini 3.5 **Pro 从未发布**；2026-05-19 发布的是 3.5 **Flash**（4 个月前）
    claim_2:
      user: "Gemini 3 已经过去一年多"
      finding: 高估 — Gemini 3 Pro 发布于 2025-11-18，距今 10 个月
    claim_3:
      user: "Gemini 4 Pro 即将发布（推特消息）"
      finding: >
        无一手来源可证。Wikipedia 版本时间线完全未提及 Gemini 4；
        「2026 年 10 月发布」仅见于二三线传闻站。按 evidence-first 分级属最低档。
    claim_4:
      user: "Google 本身估值不高"
      finding: >
        **证实** — fwdPE 23.15 / trailingPE 17.04 / PEG 1.21 / P/B 6.75，
        同时营收增速 24.2%、净利率 54.8%、ROE 48.7%。落 SPEC L3「合理」档。
        → M_valuation 由缺省 0.55 上修至 0.85（标注：yfinance 口径，非 tradingforge score_riskadj）
    pro_line_cadence:      # 对「该发新 Pro 了」这一推论的实证检验
      timeline: [Gemini 3 Pro 2025-11-18, Gemini 3.1 Pro 2026-02-19, "（Pro 线自此停滞）"]
      flash_line: [3.5 Flash 2026-05-19, 3.6 Flash 2026-07-21, 3.7 Flash 2026-08-13, 3.8 Flash 2026-09-02]
      reading: >
        Pro 线已停滞 7 个月，Flash 线每 4–6 周一发。这个分叉同时支持两种读法：
        ①Pro 确实「憋着大的」，发布临近（利多）；②大模型训练受阻，3.5 Pro 已被放弃重做（利空）。
        证据不足以在两者间定调 → Δp_view 记 0，不给正分也不额外扣分。

  position:
    risk_amount: 10432.63  # NAV 1,939,545.09 × 0.75% × M_regime 0.75 × M_val 0.85 × M_conv 1.125
    size: 7 张
    check: "7 × $1,380 = $9,660（应 ≤ risk_amount 10,432.63）"
    caps_hit: []
    kelly_f_star: 0.1655
    kelly_risk_cap: 32092.81
    delta_adj_nominal: 95484      # 净 delta 0.390/张
    vol_budget_cap: 643561        # §5.4，N_eff = 3，未构成约束

  entry:
    tactic: PB-4 事件驱动 debit vertical
    structure: BUY GOOG Nov20'26 350 Call / SELL GOOG Nov20'26 400 Call
    net_debit: 13.80       # 最差成交口径（买 ask 18.10 / 卖 bid 4.30）；限价单建议挂中价 13.62 附近
    max_profit: 36.20
    breakeven: 363.80      # +3.9%
    total_cost: 9660
    trigger: 开盘后重核报价——本卡定价取自盘前，标的盘前 +1.83% 而期权 bid/ask 未充分重定价
    valid_until: 2026-09-25

  stop:
    initial: 价差市值跌至成本 50%（6.90）
    basis: 结构层止损，§6.2 口径；用户 L0b 确认
    risk_budget_basis: 全额权利金 $1,380/张 计为 1R——跨财报跳空不保证 50% 止损能成交
    time_stop: DTE < 21 天（约 2026-10-30）仍未站上 350 → 退出

  targets:
    T1: 400（价差上轨，最大盈利 36.20/张 = $25,340 总计）

  risk_report:
    scenarios:             # 蒙特卡洛 40 万次，IV 隐含对数正态
      bear: {prob: 0.523, pnl: -9660,  cond: 到期 < 350}
      base: {prob: 0.359, pnl: +5503,  cond: 到期 350–400（条件均值）}
      bull: {prob: 0.118, pnl: +25340, cond: 到期 > 400}
    ev_dollars: -86.48
    ev_note: >
      EV ≈ 0 是用市场自身隐含概率计价的必然结果（差一个买卖价差）。
      相比 DC-2026-002 的 350/390（EV −505），本结构因卖出腿更价外、定价更接近公允而改善。
      正期望的唯一来源是 view 认为真实概率偏离市场定价——本卡 Δp_view = 0，故不主张有边缘。
    portfolio_after: >
      总 open risk 2.54%（用户口径 2% + 本笔 0.50%，上限 5.0%）✓；
      GOOG 单标的敞口 235,508（现货 140,024 + 价差 delta 名义 95,484）= 12.1% NAV ✓（上限 15%）；
      叙事闸 ✓ — 实测 60 日相关性 GOOG–MU −0.207 / GOOG–SMH 0.039 / GOOG–CHAT 0.121 /
      GOOG–DRAM −0.082，全部 < 0.7，GOOG 构成独立叙事，不并入既有 AI/半导体敞口。

  portfolio_warning:       # 非本笔问题，但记入台账
    existing_concentration: >
      MU 51.1% + DRAM 30.1% + SMH 29.2% + CHAT 22.9% = 133.4% NAV 集中于单一叙事
      （内部相关性 0.80–0.95，实测确认为同一注），§5.3 上限 30% → 超限 4.4 倍。
      账户杠杆 1.49×，初始保证金/NAV 44.6%。
      本笔 GOOG 是组合中唯一与该叙事负相关/零相关的头寸，方向上减轻而非加剧集中度。
    earnings_cluster: GOOG 财报 2026-10-28 在持仓期内；须核对 MU 事件日历，§5.3 限「财报周内暴露于事件的持仓 ≤ 2 个」

  thesis_registration:
    claim: >
      Gemini 4 Pro 若在 1–2 个月内发布且超出预期，将催化市场重估 Google 的 AI 价值；
      叠加 GOOG 自身估值不贵（fwdPE 23.15），目标 1–2 个月内站上 400 美元。
    quantified_triggers:
      - Gemini 4 Pro 在 2026-11-20 前正式发布（非 checkpoint / 非预览）
      - 发布后市场评价超预期（基准测试领先同期竞品）
      - GOOG 站上 363.80（价差盈亏平衡点）
    invalidation:          # 用户 L0b 确认，明确去掉均线类条件
      - 2026-10-28 财报云业务增速下滑
      - 价差市值跌至成本 50%
    implied_p: 0.396
    review_schedule: 每周五；2026-10-28 财报次日强制；Gemini 4 发布当日强制

  debate:                  # §8 swing = 2 轮
    rounds:
      - bull: >
          催化剂具体且落在到期窗口内（Gemini 4 Pro 传闻指向 10 月，到期 11/20）；
          估值经核验确实不贵（fwdPE 23.15、PEG 1.21，配 24.2% 营收增速）；
          IV 52 周分位 16.7%，debit 结构买在波动率便宜处；结构上轨 400 与论点目标价一致。
        bear: >
          市场隐含 P(到期 > 363.80) ≈ 34%，低于 base_rate 45%；
          催化剂全部依赖公开传闻，无一手来源，Wikipedia 版本时间线完全未提及 Gemini 4；
          且论点是复合条件（发布 AND 超预期 AND 市场买账 AND 63 天内），每一环都可能断。
      - bull: >
          Pro 线已停滞 7 个月（3.1 Pro 后无新 Pro），积压越久发布冲击越大；
          已持 GOOG 400 股且基本打平，本笔是既有论点的延续而非新开叙事；
          实测相关性证明 GOOG 是组合中唯一的分散化头寸。
        bear: >
          同一段历史的反面读法更有力：Gemini 3.5 Pro 三次跳票后被放弃重做，
          「Pro 线停滞」是执行受阻的证据而非蓄力的证据。对 63 天定期结构而言，
          时间风险即全损风险——方向对、时间错 = 归零。
    adjudication: >
      p 修正 -3pp。触发证据两条：①隐含概率交叉校验（~34%）低于 base_rate（45%）；
      ②催化剂无一手来源且论点为复合条件。
      RR 不修正——RR 由行权价结构决定，非估计量。
      Δp_view 记 0 而非正分：用户 view 中唯一经证实的部分（估值不贵）已通过
      M_valuation 0.55 → 0.85 全额体现，不在 p 侧重复计入；催化剂部分证据不足以给分。

  data_timestamps:
    GOOG 行情（market_snapshot）: 2026-09-17 收盘
    GOOG/期权报价（IBKR）: 2026-09-18 08:10 UTC 盘前 — 逐合约 IV 盘前无效，期权 last 为 09-17 收盘标记；**开盘后须重核**
    IV / HV / IV 分位（IBKR）: 2026-09-18 实时 — IV 28.58%，HV30 21.03%，IV 52 周分位 16.7%
    账户 NAV / 持仓（IBKR）: 2026-09-18 实时
    估值（yfinance）: 2026-09-18 — fwdPE 23.15 / trailingPE 17.04 / PEG 1.21 / P/B 6.75
    相关性（yfinance 60 日对数收益）: 2026-09-18
    Gemini 版本时间线: en.wikipedia.org/wiki/Gemini_(language_model)，2026-09-18 取
    L1 美元流动性快照: 缺失 → M_regime 按偏紧档 0.75 保守处理
    L2 命题库 taxonomy.json: 缺失 → Δp_narrative = 0，无先验
    L3 tradingforge score_riskadj: 查不到 → Δp_fundamental = 0；M_valuation 改用 yfinance fwdPE 归档
    现有持仓未平仓风险: 用户口径估值 2% NAV（未登记止损位）

  caveats:
    - 期权报价为盘前，标的盘前 +1.83% 而 bid/ask 未充分重定价——下单前必须重核，价差可能已变
    - 催化剂（Gemini 4 Pro）无确认发布日期；若发布晚于 2026-11-20，本结构无论方向对错均归零
    - L1/L2 快照缺失，Δp_regime 与 Δp_narrative 均记 0，p 主要由 playbook 基准率决定
    - GOOG 与 GOOGL 是不同代码；本卡为 GOOG（Cl-C），与既有 400 股持仓一致
```

决策支持，非投资建议；执行与否由你决定。

