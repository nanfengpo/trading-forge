# 智策 · TradingForge — 项目速查手册

## 是什么

一个**多智能体投研 Web 应用**（trading-forge），对标 Bloomberg Terminal 的 AI 分析流程。

核心流程：用户输入 ticker → 12 个 AI Agent 依次/并行辩论 → 实时 SSE 流式输出 → 78 条策略匹配 → 存到数据库。

---

## 部署架构

```
[CF Pages]  静态前端 (HTML/CSS/JS)  ← git push main 自动构建
    │ /api/* 代理
    ▼
[Fly.io]    FastAPI + TradingAgents (Docker)
    │ JWT 验证
    ▼
[Supabase]  Auth + Postgres (profiles/decisions/usage_events)
```

**月成本 < $5**（Fly 约 $2-3/月，其余 free tier）

---

## 仓库布局（核心文件）

```
trading-strategy-system/
├── TradingAgents/                  ← git subtree（上游 TauricResearch，不直接改）
├── patches/                        ← 7 个本地补丁（Kimi/付费数据/并行等）
│   └── apply-patches.sh
├── trading-decision-app/
│   ├── backend/
│   │   ├── server.py               ← FastAPI 路由、JWT 验证、SSE
│   │   ├── agent_runner.py         ← TradingAgentsGraph wrapper
│   │   ├── key_injector.py         ← 多租户：每用户注入自己的 LLM key
│   │   ├── usage_logger.py         ← 颗粒度 token 追踪
│   │   ├── translator.py           ← 辩论英→中翻译（后台线程）
│   │   ├── strategy_matcher.py     ← 决策→78 策略匹配
│   │   ├── model_catalog.py        ← 7 家 LLM 模型清单
│   │   ├── symbol_search.py        ← Ticker 搜索（含 CoinGecko）
│   │   ├── comprehensive_report.py ← 综合深度研报（Opus 流式）
│   │   ├── dataflows/              ← 付费数据源（Finnhub/Polygon/AV/AkShare）
│   │   └── opportunities/          ← 24h 机会扫描（BTC插针/IV突变/社媒）
│   ├── static/
│   │   ├── index.html              ← 入口，路由控制
│   │   ├── app.js                  ← 主前端逻辑（cockpit/SSE/历史）
│   │   ├── auth.js                 ← Supabase Auth
│   │   ├── strategies.js           ← 78 条策略库
│   │   ├── comprehensive.js        ← 综合研报页
│   │   └── fundamentals.js         ← 基本面分析页
│   ├── supabase/migrations/        ← 4 个 SQL 迁移文件
│   ├── Dockerfile
│   ├── fly.toml
│   └── .env.example                ← 所有环境变量清单
├── scripts/
│   ├── dev.sh                      ← 本地启动（一条命令）
│   ├── deploy-fly.sh               ← 生产部署（含健康检查）
│   ├── setup.sh                    ← 首次安装
│   └── upgrade-tradingagents.sh    ← 拉上游 + 重放 patches
├── docs/
│   ├── ARCHITECTURE.md             ← 10 个关键设计决策
│   ├── DEPLOYMENT.md               ← 30 分钟上线完整指南
│   ├── DEVELOPMENT.md              ← 本地开发调试技巧
│   ├── UPSTREAM.md                 ← subtree 同步流程
│   └── QUICKREF.md                 ← 本文件
└── CLAUDE.md                       ← 工作流规则（直推 main / 先估时）
```

---

## 本地跑起来（最快路径）

```bash
# 1. 安装依赖
pip install -r trading-decision-app/requirements.txt
pip install -r TradingAgents/requirements.txt   # LIVE 模式才需要

# 2. 配环境（最少填一个 LLM key）
cp trading-decision-app/.env.example trading-decision-app/.env
# 填 DEEPSEEK_API_KEY=sk-... 最便宜

# 3. 启动
./scripts/dev.sh
# → http://localhost:8000
```

**0 key → DEMO 模式**（脚本化事件，~30s，0 token 消耗）

---

## 关键 .env 变量

| 变量 | 用途 | 必须？ |
|---|---|---|
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` 等 | LLM 推理（7 家任选一） | ✓ LIVE 模式必须 |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_JWT_SECRET` | Auth + DB | ✓ 多用户 |
| `FINNHUB_API_KEY` / `POLYGON_API_KEY` / `ALPHA_VANTAGE_API_KEY` | 付费数据源 | 可选 |
| `TRANSLATION_PROVIDER` | 翻译模型（默认 deepseek） | 可选 |
| `CORS_ORIGINS` | Fly 允许的前端域名 | 生产必须 |

---

## 常见操作

| 任务 | 命令 |
|---|---|
| 本地开发 | `./scripts/dev.sh` |
| 部署到生产 | `git push origin main`（CF+GH Actions 自动化）|
| 重新部署后端 | `./scripts/deploy-fly.sh --redeploy` |
| 拉 TradingAgents 上游 | `./scripts/upgrade-tradingagents.sh` |
| 诊断配置问题 | `./scripts/check-config.sh` |
| 看实时 SSE 事件流 | `curl -sN "http://localhost:8000/api/stream/$SID"` |
| 查缓存命中率 | `curl http://localhost:8000/api/dataflows/cache-stats` |

---

## SSE 事件类型

`init` → `mode` → `agent_status` → `tool_call` → `log` → `report` → `debate` → `risk_debate` → `final_decision` → `translation` → `usage_event` → `usage` → `complete` / `error`

---

## 修改 TradingAgents 的规则

只能改 4 个"插座"位置，**不能动 agents/ prompts 和 graph/**：

| 文件 | 改什么 |
|---|---|
| `llm_clients/factory.py` | 加 LLM provider |
| `llm_clients/openai_client.py` | 加 provider 配置 |
| `dataflows/interface.py` | 末尾调 `premium_bridge.register()` |
| `dataflows/premium_bridge.py` | 新文件，永不冲突 |

改完后生成 patch：`git diff TradingAgents/... > patches/000N-xxx.patch`

---

## 工作流规则（本项目固定）

1. **直推 main**：不建分支，不开 PR，改完 `git add → commit → push origin main`
2. **先估时**：每次回复第一行必须是「预估完成时间：约 N 分钟」
3. **后端改动**后需跑：`./scripts/deploy-fly.sh --redeploy`
4. **前端**：push main 后 CF Pages 自动构建，无需额外操作
