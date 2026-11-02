-- WIP dashboard, managers and estimate tracking — run in the Supabase SQL editor.
-- Pairs with dryops-server wip.js (admin portal /wip/admin/<admin_token>,
-- per-manager master pages /wip/master/<manager token>, estimate accuracy).
-- Safe to re-run.

create extension if not exists pgcrypto;

-- 1. Admin link (yours): mints managers and assigns them locations. The old
--    master_token keeps working as the all-locations "super master" page.
alter table public.wip_config
  add column if not exists admin_token text unique
    default translate(encode(gen_random_bytes(18), 'base64'), '/+', '_-');
update public.wip_config
   set admin_token = translate(encode(gen_random_bytes(18), 'base64'), '/+', '_-')
 where admin_token is null;

-- 2. Managers: each gets a master link scoped to the locations assigned here.
create table if not exists public.wip_managers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  token text not null unique
    default translate(encode(gen_random_bytes(18), 'base64'), '/+', '_-'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_opened_at timestamptz
);
alter table public.wip_managers enable row level security;

-- wip_pool stays the per-location config (owner link, label, bank balance);
-- a manager sees the pool rows linked here. Many-to-many on purpose.
create table if not exists public.wip_manager_locations (
  manager_id uuid not null references public.wip_managers(id) on delete cascade,
  pool_id uuid not null references public.wip_pool(id) on delete cascade,
  sort_order integer not null default 100,
  primary key (manager_id, pool_id)
);
alter table public.wip_manager_locations enable row level security;

-- 3. Owner estimates, append-only. wip_entries is overwritten weekly (and the
--    row is reused once the job is invoiced), so the "what is this job worth"
--    guesses are kept here to compare against what was invoiced / collected.
create table if not exists public.wip_job_estimates (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  job_id uuid not null,                  -- jobs.id (= wip_entries.key for JN jobs)
  amount numeric(12,2) not null,
  entered_by text,
  entered_at timestamptz not null default now()
);
create index if not exists wip_job_estimates_job_idx
  on public.wip_job_estimates (location_id, job_id, entered_at desc);
alter table public.wip_job_estimates enable row level security;

-- Seed from today's entries so the accuracy panel is not empty on day one.
insert into public.wip_job_estimates (location_id, job_id, amount, entered_by, entered_at)
select e.location_id, e.key::uuid, e.amount, e.updated_by, e.updated_at
  from public.wip_entries e
 where e.category = 'in_progress' and e.amount is not null
   and e.key ~ '^[0-9a-f-]{36}$'
   and not exists (select 1 from public.wip_job_estimates x
                    where x.location_id = e.location_id and x.job_id = e.key::uuid);

-- 4. Snapshots remember which manager generated a combined report and who sent it.
alter table public.wip_snapshots
  add column if not exists manager_id uuid references public.wip_managers(id) on delete set null,
  add column if not exists generated_by text;

-- 5. Owner form v2: an In Progress job can also be "paying this week"
--    (out-of-pocket) without leaving In Progress, and the Saturday review
--    keeps what it found in its own columns instead of the owner's note.
alter table public.wip_entries
  add column if not exists collect_amount numeric(12,2),
  add column if not exists ai_decision text check (ai_decision in ('collecting', 'not_yet', 'received')),
  add column if not exists ai_amount numeric(12,2),
  add column if not exists ai_reason text,
  add column if not exists ai_at timestamptz;

-- Your admin link:
select 'https://dryops-server-production.up.railway.app/wip/admin/' || admin_token as admin_link
  from public.wip_config where id = 1;
