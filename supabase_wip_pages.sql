-- WIP (work-in-progress) report pages.
--
-- Owners get a per-location link (https://<server>/wip/<token>) where they set
-- an estimated value per job, choose which jobs count as "In Progress" or
-- "Collecting" this week, and add jobs the sync doesn't know about. A master
-- link (/wip/master/<master_token>) shows every pooled location's WIP, adds or
-- removes locations from the pool, and generates the combined report text.
--
-- Written only by the server with the service key; RLS is enabled with no
-- policies so anon/authenticated clients cannot read amounts or tokens.

create extension if not exists pgcrypto;

-- Single-row config: the master token IS the credential for the master page.
create table if not exists public.wip_config (
  id integer primary key default 1 check (id = 1),
  master_token text not null unique
    default translate(encode(gen_random_bytes(18), 'base64'), '/+', '_-'),
  created_at timestamptz not null default now()
);
insert into public.wip_config (id) values (1) on conflict (id) do nothing;

-- Locations in the WIP pool. One row per location; the token is the owner link.
create table if not exists public.wip_pool (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null unique references public.locations(id) on delete cascade,
  token text not null unique
    default translate(encode(gen_random_bytes(18), 'base64'), '/+', '_-'),
  -- Short heading used in the report ("A1 DALLAS"); defaults to the location name.
  label text,
  sort_order integer not null default 100,
  added_at timestamptz not null default now()
);

-- One row per (location, job-or-custom entry). `key` is the jobs.id for synced
-- jobs or 'custom:<uuid>' for owner-added lines. `category` null = excluded.
create table if not exists public.wip_entries (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  key text not null,
  custom_name text,
  category text check (category in ('in_progress', 'collecting')),
  amount numeric(12,2),
  note text,
  updated_by text,
  updated_at timestamptz not null default now(),
  unique (location_id, key)
);
create index if not exists wip_entries_location_idx on public.wip_entries (location_id);

-- Generated report text, kept so the master page can show "last generated".
create table if not exists public.wip_snapshots (
  id uuid primary key default gen_random_uuid(),
  location_id uuid references public.locations(id) on delete cascade, -- null = combined
  generated_at timestamptz not null default now(),
  in_progress_total numeric(12,2),
  collecting_total numeric(12,2),
  body text not null
);
create index if not exists wip_snapshots_location_idx on public.wip_snapshots (location_id, generated_at desc);

-- One row per "Review AR notes" run (per location): what Claude decided, so the
-- master page can show when a location was last reviewed and audit changes.
create table if not exists public.wip_reviews (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  reviewed_at timestamptz not null default now(),
  model text,
  jobs_reviewed integer,
  applied integer,
  result jsonb not null
);
create index if not exists wip_reviews_location_idx on public.wip_reviews (location_id, reviewed_at desc);
alter table public.wip_reviews   enable row level security;

alter table public.wip_config    enable row level security;
alter table public.wip_pool      enable row level security;
alter table public.wip_entries   enable row level security;
alter table public.wip_snapshots enable row level security;
