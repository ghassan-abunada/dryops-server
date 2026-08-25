-- Power BI dataset sync tables (see the pbi-sync section in server.js).
-- Run once in the Supabase SQL editor.
-- All three tables are service-role only: RLS is enabled with no policies,
-- so app clients (anon/authenticated) can neither read nor write them.

create table if not exists pbi_rows (
  dataset_id text not null,
  table_name text not null,
  row_num    integer not null,
  row        jsonb not null,
  synced_at  timestamptz not null default now(),
  primary key (dataset_id, table_name, row_num)
);
alter table pbi_rows enable row level security;

create table if not exists pbi_measures (
  dataset_id text not null,
  name       text not null,
  table_name text,
  expression text,
  synced_at  timestamptz not null default now(),
  primary key (dataset_id, name)
);
alter table pbi_measures enable row level security;

create table if not exists pbi_sync_state (
  dataset_id       text primary key,
  last_refresh_end timestamptz,
  last_synced_at   timestamptz,
  last_status      text,
  tables_synced    integer,
  rows_synced      integer
);
alter table pbi_sync_state enable row level security;

-- Example: query a synced table's jsonb rows as columns
--   select row->>'Claim Number' as claim, (row->>'Total')::numeric as total
--   from pbi_rows where table_name = 'Invoices';
