---
name: trade-plan
description: 单笔交易决策卡生成器——SPEC v1.1 执行器。收集 trade_request → 自动拉行情与快照 → L0 自洽预检 + 观点确认 → 五层评估 + 对抗辩论 → decision_math 算仓位四闸 → 决策卡落盘 journal。用法：/trade-plan [标的] [long|short] [day|swing|position|campaign]；周检/月检：/trade-plan review week|month
---

# /trade-plan — 单笔交易决策卡

本 skill 是 [docs/trading-system/SPEC.md](../../../docs/trading-system/SPEC.md)（v1.1）的执行器。SPEC 是唯一规范；本文件只规定执行顺序与工具用法，与 SPEC 冲突以 SPEC 为准。

## 铁律

1. 你永远不下单、不催单、不主动荐股；输出只有决策卡，执行由用户在 IBKR 手动完成。
2. 判据不过而用户坚持 → 只能改输入重跑，绝不修改输出迁就。
3. **所有算术**（Z 值、四道闸、RR、期望值、EV、EPR）**只许来自 `scripts/trading-system/decision_math.py` 的输出**（输入字段说明：`--schema`），禁止心算；卡内数字与脚本输出不一致以脚本为准。
4. 缺数据按 SPEC 各层缺省规则处理并显式标注；**行情快照非当日 → 不出卡**；禁止编造任何指标数值。
5. 每张卡结尾固定一行：「决策支持，非投资建议；执行与否由你决定。」

## 流程

### 1. 收集 trade_request（SPEC §1）

- 从命令参数解析 symbol / direction / horizon（已给则不再问）。
- 用 AskUserQuestion 一次性补齐枚举参数：direction、horizon、instrument（auto/stock/option）、conviction（1–5）。
- 请用户在对话中一次性提供：目标收益、NAV、保证金利用率、当前持仓（每行：标的/方向/数量/成本/止损）、硬约束、view（一段话：催化剂、逻辑、时间窗口、担心什么）。
- 风险参数默认值（用户可覆盖）：max_loss 0.75% NAV / 组合回撤容忍 10% / 夏普目标 1.5 / 波动容忍 20%。
- instrument 涉及期权 → IV rank（或 IV 分位）必填；脚本拉不到，向用户要。

### 2. 拉数据

- 行情：`python3 scripts/trading-system/market_snapshot.py <SYMBOL>`。脚本失败（无 yfinance / 无网）→ 请用户按 [CLAUDE-DESKTOP-PROMPT.md](../../../docs/trading-system/CLAUDE-DESKTOP-PROMPT.md) 的【市场数据】模板手贴；仍缺 → 不出卡。
- 四份知识快照（完整路径见 SPEC 附录 B）。读文件前查 mtime：超过 10 天 → 该层按 SPEC 缺省规则保守处理并在卡上标注「快照过期」：
  - 流动性：`~/Documents/Claude/Projects/宏观经济与资本市场/美元流动性/data/processed/latest.json` + `dashboard_curated.json`
  - 命题库：`~/Documents/Claude/Projects/Intelligence-dance/taxonomy.json`（「悲观路径周 Δ」需最近两周快照对比，缺一份则该项标注跳过）
  - 基本面：tradingforge `score_riskadj`（API 或周报快照；查不到 → 视同 45–55 档，Δp=0 标「无先验」）
  - 车轮（仅收租型）：`~/Documents/Claude/Projects/交易-主观交易/PutWheel量化分析/engine/current_state.json`
- `earnings_next` 与 IV rank 让用户确认（自动源不可靠）。
- 决策卡末尾附「数据时间戳表」：每层数据源 + asof 日期 + 是否过期。

### 3. L0a 目标自洽预检（SPEC §3 L0）

- 组 JSON（expected_return / horizon / sigma60 / atr14 / price）调 decision_math。
- Z > 2 或隐含 RR 上界 < 1.5 → **不进五层，先还价**：给 2–3 组修改后的可行参数（降目标 / 延长周期 / defined-risk 结构封顶亏损），等用户选择重跑；用户坚持 → 直接出 NO_GO 卡（理由：L0 不自洽）。

### 4. L0b 观点结构化确认

- 把 view 解析为 view_parsed（隐含方向 / 强度 / 时间窗 / 催化剂 / 失效条件候选 / 隐含假设）回显；与 direction 字段矛盾必须当场指出。
- 用 AskUserQuestion 让用户确认或修改失效条件——**用户认可后**才写入 `thesis_registration.invalidation`。

### 5. 五层评估 + p 打分 + 对抗辩论

- 按 SPEC §3 L1→L5 逐层，每层落一行结论，禁止跳层；p 按 §4 打分，每个 Δp 给取值与一句话理由，并给 p 区间（±8pp）。
- 对抗辩论按 §8：day 1 轮 / swing 2 轮 / position 及以上 3 轮，裁决段显式给 p / RR 修正量，无触发证据不得调整。
- event_key 去重以 `docs/trading-system/journal/cards.md` 为准：新卡 thesis_registration 列出本卡计入的 event_key 清单，与既有卡重复的事件不得再次计入。

### 6. 仓位与判据（SPEC §5 / §0.1）

- 组 JSON 调 decision_math：四道闸、加权 RR、p×RR、期望值、三情景 EV；收租型走 `income` 节（EPR 三档稳健性 + 尾部约束）。
- 卡内所有数字照抄脚本输出，包括校验行与 caps_hit。

### 7. 出卡与落盘

- 按 SPEC §2 固定 YAML 结构输出决策卡；card_id = `journal/cards.md` 现有最大流水号 + 1（DC-YYYY-NNN）。
- GO / WAIT 卡：索引表加一行 + 整卡追加进 `docs/trading-system/journal/cards.md` 正文区（只增不改）；NO_GO 只记索引行。
- WAIT 卡同时登记进 `docs/trading-system/journal/trades.md` 的 WAIT 登记表。
- 成交回报：用户回贴实际成交价 → 按 [TRADE-JOURNAL.md](../../../docs/trading-system/TRADE-JOURNAL.md) 字段生成日志行追加进 trades.md（p_pred / rr_planned 从卡照抄封存；分批成交按 SPEC §8 时点规则：首笔即落行、后续 rev 更新、过期档作废）。
- 落盘后按仓库规则提交：`git add docs/trading-system/journal && git commit && git push origin main`。

### 8. 周检 / 月检（`/trade-plan review week|month`）

- 数据底座 = `journal/trades.md` + `journal/cards.md`；另需用户贴：各标的现价一列（周检）、IBKR PortfolioAnalyst 近 3 个月摘要（月检）。
- 输出按 TRADE-JOURNAL.md §3（周五体检 5 问：open risk 距上限 / 叙事集中度 / 应移止损清单 / 事件日历对照 / 过期 WAIT 清理）与 §2（Brier、p 分桶校准表、playbook 记分牌、组合层验收、manual 占比）。
- 缺 PortfolioAnalyst 数据 → 夏普 / 回撤两项标「缺 NAV 数据未验收」跳过，禁止用逐笔 R 序列代算夏普。
