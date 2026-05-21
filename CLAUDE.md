# Workflow rule — direct push to main

For this repository (`trading-strategy-system`, deployed as `trading-forge`), every change goes **directly to the `main` branch**.

## What to do

```
edit files → git add → git commit -m "..." → git push origin main
```

If the change touches backend / Dockerfile / requirements / SQL, then also:

```
./scripts/deploy-fly.sh --redeploy
```

CF Pages auto-picks up the frontend on every `main` push, so no extra step is needed there.

## What NOT to do

- **Do not** create feature branches (`fix/...`, `feat/...`, `chore/...`).
- **Do not** open pull requests (`gh pr create`).
- **Do not** auto-merge PRs (`gh pr merge`).
- **Do not** work in `.claude/worktrees/` for normal commits — those are for exploratory work that may be discarded.

## Why

User explicitly reversed the prior branch + PR workflow on 2026-05-21. Velocity matters more than the audit trail for this solo project, and `main` is the deploy branch for both Cloudflare Pages (frontend) and Fly (backend). Quote:

> 以后不要开新分支，而是直接修改 main 并推送。把这条规则在本项目全局固定下来，确保未来所有会话都遵守这个规则。

## Scope

This rule applies to **this repo only**. Other projects keep their default branch + PR workflow unless they have their own override.

---

# Workflow rule — estimate first, then work

For every user request in this repo, **before touching any tool other than a quick read/grep**, do a brief assessment and give the user a **one-line estimated completion time**.

## What to do

Open the reply with one line in the form:

> 预估完成时间：**约 N 分钟**（一句话说明这 N 分钟里要做什么）。

Then proceed with the work. The estimate is a budget, not a contract — if scope grows mid-task, send a one-line update with the revised estimate, don't silently drift.

## Granularity

- Trivial edits (one file, no verification needed) → "约 1 分钟"
- Single feature touching a few files + preview check → "约 3–5 分钟"
- Multi-file refactor or new module + verification → give a real range, e.g. "约 10–15 分钟"
- Investigation-only ("why does X break?") → estimate the *investigation* itself, not a hypothetical fix

If the request is genuinely too vague to estimate, say so in that same opening line and ask one clarifying question — don't skip the estimate.

## What NOT to do

- Don't bury the estimate inside a longer paragraph or after the first tool call — it must be the **first line** of the reply.
- Don't pad with hedge words ("可能 / 大概 / 也许"). Pick a number; you can revise it later.
- Don't estimate every internal step — one number for the whole turn is enough.

## Why

User asked for this on 2026-05-22 so they can decide whether to wait or context-switch:

> 以后所有的工作都先简单评估后给一个预估的完成时间。把这条规则在本项目全局固定下来，确保未来所有会话都遵守这个规则。

## Scope

This rule applies to **this repo only**, same as the direct-push rule above.
