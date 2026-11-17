-- Google "Pay-per-lead leads report" (lsaImport.js, second format). Run once in the
-- Supabase SQL editor, BEFORE deploying the server that reads these columns.
--
-- Google is moving Local Services accounts into Google Ads. A migrated account's leads
-- leave the Detailed Lead Report and appear in "Pay-per-lead leads", one file per manager
-- (lsa-bot/pplBot.js → POST /lsa/import?format=ppl). That file has no account id and no
-- time of day: the campaign is the unit, and "Lead ID" is the same number the old report
-- calls "Google Ads Lead Id", so both exports land in lsa_leads on google_lead_id.
--
-- lsa_leads.account_id stays NOT NULL. A campaign's leads are stored under the account
-- its leads already sit under in the detailed report; a campaign nobody has tied yet
-- uses the pseudo-account 'C' || campaign_id (real account ids are digits only).
--
-- RLS is on with no policies and anon/authenticated have no grants, as on the other
-- lsa_ tables: only the service key reads or writes.

alter table public.lsa_leads add column if not exists campaign_id text;
alter table public.lsa_leads add column if not exists campaign_name text;
alter table public.lsa_leads add column if not exists charge_status text;                              -- Charged | Not charged | In review | Credited
alter table public.lsa_leads add column if not exists time_known boolean not null default true;        -- false: lead_created_local is a date at 00:00:00
alter table public.lsa_leads add column if not exists source_format text not null default 'detailed';  -- detailed | ppl

-- One row per Google Ads campaign seen in a pay-per-lead file.
create table if not exists public.lsa_campaigns (
  campaign_id    text primary key,
  campaign_name  text,
  manager_id     text,
  account_id     text,                     -- the lsa_leads.account_id this campaign's leads are stored under
  first_seen_at  timestamptz default now(),
  updated_at     timestamptz default now()
);

alter table public.lsa_campaigns enable row level security;
revoke all on public.lsa_campaigns from anon, authenticated;
