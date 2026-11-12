-- Google Local Services Ads leads (lsaImport.js). Run once in the Supabase SQL editor.
--
-- One row per Google lead, fed by the LSA export bot (lsa-bot/) posting each manager
-- account's "Detailed Lead Report" to POST /lsa/import. The same lead is reported by
-- every manager that shares its location, so the key is Google's own lead id and
-- manager_ids collects who reported it.
--
-- Timestamps are stored exactly as Google prints them ("10/31/26 10:08:57"), as
-- timestamp WITHOUT time zone: the report does not say which zone they are in.
--
-- RLS is on with no policies and anon/authenticated have no grants: only the service
-- key reads or writes these until we decide who should see them in the app.

create table if not exists public.lsa_leads (
  google_lead_id        text primary key,
  external_lead_id      text,
  account_id            text not null,            -- the location's LSA account ("Account ID")
  business_name         text,
  geo                   text,                     -- "City,State,Country" of that account
  lead_created_local    timestamp,
  lead_type             text,                     -- PHONE_CALL | MESSAGE | BOOKING
  lead_category         text,
  job_type              text,
  customer_name         text,
  customer_phone        text,                     -- number without the extension
  customer_phone_ext    text,
  customer_phone_norm   text generated always as (public.phone_norm(customer_phone)) stored,
  customer_email        text,
  booking_local         timestamp,
  zipcode               text,
  charged               boolean,
  charged_call_local    timestamp,
  charged_call_seconds  integer,
  dispute_status        text,
  manager_ids           text[] not null default '{}',
  row_hash              text not null,            -- hash of the fields above; a different hash = Google changed the lead
  raw                   jsonb not null,           -- the CSV row as received
  first_seen_at         timestamptz not null default now(),
  changed_at            timestamptz
);
create index if not exists idx_lsa_leads_created on public.lsa_leads (lead_created_local);
create index if not exists idx_lsa_leads_account on public.lsa_leads (account_id, lead_created_local);
create index if not exists idx_lsa_leads_phone on public.lsa_leads (customer_phone_norm);

-- Every field Google changed on a lead after we first saw it (charged flipping to
-- false is how a credit shows up in this report).
create table if not exists public.lsa_lead_changes (
  id              bigint generated always as identity primary key,
  google_lead_id  text not null references public.lsa_leads (google_lead_id) on delete cascade,
  field           text not null,
  old_value       text,
  new_value       text,
  import_id       uuid,
  changed_at      timestamptz not null default now()
);
create index if not exists idx_lsa_lead_changes_lead on public.lsa_lead_changes (google_lead_id);
create index if not exists idx_lsa_lead_changes_at on public.lsa_lead_changes (changed_at);

-- One row per file received, including refused ones (error set).
create table if not exists public.lsa_imports (
  id             uuid primary key default gen_random_uuid(),
  manager_id     text,
  range_from     date,
  range_to       date,
  filename       text,
  sha256         text,
  source         text not null default 'bot',
  row_count      integer not null default 0,
  new_count      integer not null default 0,
  changed_count  integer not null default 0,
  same_count     integer not null default 0,
  rejected_count integer not null default 0,
  error          text,
  received_at    timestamptz not null default now()
);
create index if not exists idx_lsa_imports_received on public.lsa_imports (received_at desc);
create index if not exists idx_lsa_imports_file on public.lsa_imports (manager_id, range_from, range_to, received_at desc);

alter table public.lsa_leads enable row level security;
alter table public.lsa_lead_changes enable row level security;
alter table public.lsa_imports enable row level security;
revoke all on public.lsa_leads, public.lsa_lead_changes, public.lsa_imports from anon, authenticated;
