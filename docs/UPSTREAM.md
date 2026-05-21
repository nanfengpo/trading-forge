# TradingAgents 上游同步指南

`TradingAgents/` 子目录是从 [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) 用 `git subtree` 引入的。本指南列出常用维护操作。

## 一次性配置（克隆此仓库后）

```bash
git remote add tradingagents-upstream https://github.com/TauricResearch/TradingAgents.git
```

如果你 fork 了官方仓库（推荐，便于回贡献），同时加：

```bash
git remote add tradingagents-fork git@github.com:<your-username>/TradingAgents.git
```

## 拉上游新功能 / bug 修复

```bash
# 1) 看一眼上游有什么新东西
git fetch tradingagents-upstream
git log HEAD..tradingagents-upstream/main --oneline -- ':(exclude)*'

# 2) 合并到本仓库的 TradingAgents/ 子目录
git subtree pull --prefix=TradingAgents tradingagents-upstream main --squash

# 3) 解决冲突（如果有），跑下我们的 smoke test
cd trading-decision-app/backend
python -c "import server; print('ok')"

# 4) 提交（subtree pull 已生成一个 merge commit，但记得 push）
git push origin main
```

## 我们做了什么改动需要保护？

**当前源码改动（v6 起，跟随 upstream v0.2.5 同步后重新生成）**，全部在 `patches/` 下作为 git diff 维护：

| 文件 | 改动 | 出现在 |
|---|---|---|
| `tradingagents/llm_clients/factory.py` | `_OPENAI_COMPATIBLE` 加入 `"kimi"` | `0001-add-kimi-provider.patch` |
| `tradingagents/llm_clients/openai_client.py` | `_PROVIDER_BASE_URL` 加入 Kimi base URL（v0.2.5 后拆成 url + env 两个 dict） | `0001-add-kimi-provider.patch` |
| `tradingagents/llm_clients/api_key_env.py` | `PROVIDER_API_KEY_ENV` 加入 `"kimi": "MOONSHOT_API_KEY"` | `0001-add-kimi-provider.patch` |
| `tradingagents/dataflows/interface.py` | 末尾追加 — 自动调用 premium_bridge.register() | `0002-premium-dataflows-bridge.patch` |
| `tradingagents/dataflows/premium_bridge.py` | 新文件 — 把外部 `dataflows/` 包注册为 vendor | `0002` + `0003` |
| `tradingagents/dataflows/stockstats_utils.py` | yfinance retry / 容错增强 | `0004-yfinance-retry-broader.patch` |
| `tradingagents/agents/analysts/{fundamentals,market,news}_analyst.py` | 系统 prompt 精简（节省 token） | `0005-prompt-compaction.patch` |
| `tradingagents/agents/utils/report_schemas.py` | 新文件 — 结构化 analyst report schemas | `0006-report-schemas-foundation.patch` |
| `tradingagents/graph/parallel.py` | 新文件 — analyst 并行执行（子图隔离） | `0007-parallel-analysts.patch` |
| `tradingagents/graph/setup.py` | 增加 `parallel_mode` 分支，包裹 upstream v0.2.5 的 execution-plan 流程 | `0007-parallel-analysts.patch` |

> v0.2.5 同步注意：原 `social_media_analyst` 被上游重命名为 `sentiment_analyst`，旧文件
> 退化为 shim — 因此 `0005-prompt-compaction.patch` 删除了对 social_media_analyst 的修改
> 部分；如需对新 `sentiment_analyst.py` 做 prompt 精简，请单独追加 patch。

其他增强仍在外部：
- 翻译层 — 在我们 backend 拦截 SSE 事件
- 付费数据源 — `trading-decision-app/backend/dataflows/` 独立包，被 premium_bridge 桥接进 TradingAgents

## 上游同步工作流

每次 `git subtree pull` 时按这个顺序操作：

```bash
# 1) 拉上游
git fetch tradingagents-upstream
git subtree pull --prefix=TradingAgents tradingagents-upstream main --squash

# 2) 我们的 patches 现在可能与新上游冲突了。先看一下：
bash patches/apply-patches.sh --check
# 如果 OK → 直接：
bash patches/apply-patches.sh
git add TradingAgents/ && git commit -m "Re-apply local patches after upstream sync"
```

如果 `--check` 报冲突：

```bash
# 3) 上游改了我们碰过的同一行 → 先把 subtree pull 回滚，按手工流程：
git reset --hard HEAD~1   # 撤销 subtree pull commit
# 再次拉，但这次允许我们重新生成 patches：
git subtree pull --prefix=TradingAgents tradingagents-upstream main --squash

# 删除老 patches（已过时）
rm patches/000{1,2}-*.patch

# 重新做改动（从 README "Phase B+C" 段抄一遍）— 编辑 4 个文件
$EDITOR TradingAgents/tradingagents/llm_clients/factory.py
$EDITOR TradingAgents/tradingagents/llm_clients/openai_client.py
$EDITOR TradingAgents/tradingagents/dataflows/interface.py
# premium_bridge.py 文件直接复制旧版本即可，它和上游无冲突

# 重新生成 patches
git add TradingAgents/tradingagents/...修改的4个文件
git diff --cached -- TradingAgents/tradingagents/llm_clients/ > patches/0001-add-kimi-provider.patch
git diff --cached -- TradingAgents/tradingagents/dataflows/   > patches/0002-premium-dataflows-bridge.patch
git commit -m "Re-port local patches to new upstream"
```

## 给上游回贡献

```bash
# 假设你修了个 bug，已经在主仓库提交了
git subtree push --prefix=TradingAgents tradingagents-fork bugfix/some-thing
# 然后到 GitHub 网页用这个分支开 PR 回 TauricResearch/TradingAgents
```

## 切换到特定上游版本

```bash
git fetch tradingagents-upstream
# 查看 tags
git tag -l --sort=-version:refname | grep -i agents | head
# 切到某个 tag
git subtree pull --prefix=TradingAgents tradingagents-upstream v0.2.4 --squash
```

## 不再使用 subtree（紧急回退）

```bash
# 把 TradingAgents 目录里所有内容平铺到本仓库历史，断开 subtree 关系
git rm -rf TradingAgents
git commit -m "Drop TradingAgents subtree"
# 之后通过 pip install 或 submodule 改用其他方式
```
