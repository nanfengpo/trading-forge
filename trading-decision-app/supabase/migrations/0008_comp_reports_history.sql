-- 0008 — Comprehensive reports: keep history.
--
-- The 0007 migration enforced ONE row per (user, ticker) via UPSERT. The user
-- now wants each generation to be a new version they can browse. We:
--
--   1. Drop the unique constraint on (user_id, ticker)
--   2. Add an optional `is_pinned` flag so the user can star a favorite version
--   3. Add an index ordered by generated_at DESC so "latest N" queries stay fast
--
-- This migration is idempotent — safe to re-run.

-- Drop the old unique constraint (auto-named like comprehensive_reports_user_id_ticker_key).
do $$
declare
    cname text;
begin
    select conname into cname
    from pg_constraint
    where conrelid = 'public.comprehensive_reports'::regclass
      and contype = 'u'
      and array_length(conkey, 1) = 2;
    if cname is not null then
        execute format('alter table public.comprehensive_reports drop constraint %I', cname);
    end if;
end$$;

-- New "favorite version" flag — null/false for old rows, the user can toggle.
alter table public.comprehensive_reports
    add column if not exists is_pinned boolean not null default false;

-- Drop the old (user_id, ticker) two-col index and replace with one that
-- orders by generated_at so list/latest queries can use an index scan.
drop index if exists public.comp_reports_user_ticker_idx;
create index if not exists comp_reports_user_ticker_gen_idx
    on public.comprehensive_reports (user_id, ticker, generated_at desc);
