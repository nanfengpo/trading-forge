-- 0007 — Comprehensive Report per (user, ticker).
--
-- One row per (user, ticker). The `sections` JSONB stores the structured
-- AI-generated comprehensive report — produced by aggregating ALL historical
-- decisions for that ticker (reports / debates / final_decision / horizon plan
-- / risk discussions) into a single coherent multi-section synthesis.
--
-- Trigger: regenerated in the background by the frontend right after a new
-- decision for the ticker reaches "complete".

create table if not exists public.comprehensive_reports (
    id              uuid primary key default gen_random_uuid(),
    user_id         uuid not null references auth.users(id) on delete cascade,
    ticker          text not null,
    sections        jsonb not null default '{}'::jsonb,
    model           text,                            -- which LLM produced this
    decision_ids    jsonb not null default '[]'::jsonb, -- ids of decisions synthesised
    decisions_count int  not null default 0,
    quote_snapshot  jsonb not null default '{}'::jsonb, -- price/cap at gen time
    status          text not null default 'ready',   -- ready | generating | error
    error_message   text,
    generated_at    timestamptz default now(),
    updated_at      timestamptz default now(),
    unique (user_id, ticker)
);

alter table public.comprehensive_reports enable row level security;

drop policy if exists "comp_reports_owner_read"   on public.comprehensive_reports;
drop policy if exists "comp_reports_owner_insert" on public.comprehensive_reports;
drop policy if exists "comp_reports_owner_update" on public.comprehensive_reports;
drop policy if exists "comp_reports_owner_delete" on public.comprehensive_reports;

create policy "comp_reports_owner_read"
    on public.comprehensive_reports for select using (auth.uid() = user_id);
create policy "comp_reports_owner_insert"
    on public.comprehensive_reports for insert with check (auth.uid() = user_id);
create policy "comp_reports_owner_update"
    on public.comprehensive_reports for update using (auth.uid() = user_id);
create policy "comp_reports_owner_delete"
    on public.comprehensive_reports for delete using (auth.uid() = user_id);

create index if not exists comp_reports_user_ticker_idx
    on public.comprehensive_reports (user_id, ticker);

-- updated_at maintenance — reuse touch_updated_at() from schema.sql
drop trigger if exists comp_reports_touch_updated_at on public.comprehensive_reports;
create trigger comp_reports_touch_updated_at
    before update on public.comprehensive_reports
    for each row execute function public.touch_updated_at();
