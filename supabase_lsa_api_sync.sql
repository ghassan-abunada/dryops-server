-- Google Ads API sync for Local Services leads (lsaApiSync.js). Run once in the Supabase
-- SQL editor. The sync loads leads without it; it then skips conversations and asks
-- Google about every enabled account on every run.
--
-- RLS is on with no policies and anon/authenticated have no grants, as on the other
-- lsa_ tables: only the service key reads or writes.

-- What was said on a lead, from local_services_lead_conversation:
-- [{ at, channel, from, seconds?, has_recording?, text? }], oldest first. Recording links
-- are short-lived signed URLs and are not stored.
alter table public.lsa_leads add column if not exists conversations jsonb;

-- The sync's own memory, one row per Google Ads client account it has asked about.
-- lead_count = leads in the last window asked for; an account at 0 is only asked again
-- once a week, which is what keeps the daily run inside Google's request allowance.
create table if not exists public.lsa_api_accounts (
  customer_id      text primary key,
  manager_id       text,
  name             text,
  time_zone        text,
  status           text,
  lead_count       int not null default 0,
  last_lead_local  timestamp,
  last_checked_at  timestamptz,
  last_error       text
);

alter table public.lsa_api_accounts enable row level security;
revoke all on public.lsa_api_accounts from anon, authenticated;
