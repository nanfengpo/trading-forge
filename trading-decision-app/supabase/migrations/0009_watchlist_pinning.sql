-- 0009 — Watchlist: per-row pinning so the user can float favorite tickers
-- to the top regardless of the drag-and-drop sort_order assigned to the
-- "unpinned" pool below them.
--
-- Schema before: ordered by (sort_order ASC, added_at DESC)
-- Schema after:  ordered by (is_pinned DESC, sort_order ASC, added_at DESC)
--
-- This migration is idempotent — safe to re-run.

alter table public.watchlist
    add column if not exists is_pinned boolean not null default false;

-- Replace the old user index with one that includes the new sort columns
-- so the list query can use an index scan with no in-memory sort.
drop index if exists public.watchlist_user_idx;
create index if not exists watchlist_user_pinned_sort_idx
    on public.watchlist (user_id, is_pinned desc, sort_order asc, added_at desc);
