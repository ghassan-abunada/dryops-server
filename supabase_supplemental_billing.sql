-- Supplemental storage billing run log. One row per billing pass (scheduled or
-- manual, dryrun or live). Written only by the server with the service key;
-- RLS is enabled with no policies so anon/authenticated clients cannot read
-- billing data (service role bypasses RLS).
create table if not exists public.supplemental_billing_runs (
  id uuid primary key default gen_random_uuid(),
  month text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'), -- billing month 'YYYY-MM'
  mode text not null check (mode in ('dryrun', 'live')),
  trigger text not null check ("trigger" in ('schedule', 'manual')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  eligible_count integer,
  created_count integer,
  skipped_count integer,
  error_count integer,
  report jsonb
);

-- The scheduler's "has this month already run in this mode?" lookup.
create index if not exists supplemental_billing_runs_month_mode_idx
  on public.supplemental_billing_runs (month, mode);

alter table public.supplemental_billing_runs enable row level security;

-- 2026-08-26: allow pre-billing reminder stages in the run log.
alter table public.supplemental_billing_runs
  drop constraint if exists supplemental_billing_runs_mode_check;
alter table public.supplemental_billing_runs
  add constraint supplemental_billing_runs_mode_check
  check (mode in ('dryrun', 'live') or mode ~ '^reminder-[0-9]+d$');
