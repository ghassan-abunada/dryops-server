-- WIP sales-rep links: /wip/rep/<token> shows one person's in-progress jobs
-- (jobs.sales_rep, the JobNimbus sales rep) across the locations listed, so
-- reps fill in job values for the jobs they sold. Run once in the SQL editor;
-- it prints the links at the end. Safe to re-run.

create extension if not exists pgcrypto;

create table if not exists public.wip_rep_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique default translate(encode(gen_random_bytes(18), 'base64'), '/+', '_-'),
  rep_name text not null unique,          -- must match jobs.sales_rep (case-insensitive)
  location_ids uuid[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_opened_at timestamptz
);
alter table public.wip_rep_links enable row level security; -- server (service key) only

-- A1 Dallas, One Stop Dallas, AFF Dallas, 24 HR Dallas
insert into public.wip_rep_links (rep_name, location_ids)
select r.name, array[
  'a222e189-2444-42d3-a214-5242248fba9a',
  'ce1131b7-4b5f-4fb2-8e47-4090a8c1c752',
  'a9af3819-a638-4a26-b690-12b791405343',
  'c4fbcdcb-befb-4224-b0f3-715d8d1aa153']::uuid[]
from (values ('Tarik Sabbah'), ('Colt Smith'), ('Ali Zayyad'), ('Gus Abunada')) r(name)
on conflict (rep_name) do nothing;

-- The links to send:
select rep_name, 'https://dryops-server-production.up.railway.app/wip/rep/' || token as link
from public.wip_rep_links where active order by rep_name;
