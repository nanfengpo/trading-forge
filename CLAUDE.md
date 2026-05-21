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
