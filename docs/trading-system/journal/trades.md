# 交易日志（trades.md）

> 字段定义、期权记账约定与纪律见 [../TRADE-JOURNAL.md](../TRADE-JOURNAL.md)。
> `p_pred` / `rr_planned` 开仓前从决策卡照抄封存，事后不许改——这两列是校准的原材料。
> scratch 判定：|r_realized| ≤ 0.25R。

| id | card_id | date | symbol | playbook | direction | horizon | p_pred | rr_planned | entry | stop | size_R | exit_date | exit_price | r_realized | outcome | exit_reason | thesis_one_line | lesson |
|----|---------|------|--------|----------|-----------|---------|--------|------------|-------|------|--------|-----------|------------|------------|---------|-------------|-----------------|--------|

## WAIT 登记表

> 用户是唯一跟踪人（在 IBKR 挂价格提醒对应触发条件）；触发后必须重跑评估（快速通道：只复核 L1 与 L4）；`valid_until` 过期即作废，周检清理。

| card_id | 标的 | 触发条件 | valid_until | 状态 |
|---------|------|---------|-------------|------|
