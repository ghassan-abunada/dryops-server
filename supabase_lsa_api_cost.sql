-- Campaign cost and performance per day from the Google Ads API (lsaApiSync.js, the cost
-- pass). Run once in the Supabase SQL editor, after supabase_lsa_api_sync.sql. The lead
-- sync keeps working without it; it then skips the cost pass.
--
-- RLS is on with no policies and anon/authenticated have no grants, as on the other
-- lsa_ tables: only the service key reads or writes.

-- One row per client account, campaign and day that had activity, every channel
-- (LOCAL_SERVICES, PERFORMANCE_MAX, SEARCH, ...). account_id is the Google Ads customer id,
-- the same id as lsa_leads.account_id. cost_micros is millionths of currency_code
-- (1933480000 = 1,933.48). The two impression shares are fractions from 0 to 1, null when
-- Google gave none. A re-run overwrites the days in its window, so late adjustments land.
create table if not exists public.lsa_campaign_daily (
  account_id      text not null,
  campaign_id     text not null,
  day             date not null,
  campaign_name   text,
  channel_type    text,
  campaign_status text,
  cost_micros     bigint not null default 0,
  impressions     bigint not null default 0,
  clicks          bigint not null default 0,
  conversions     numeric not null default 0,
  top_impression_pct          numeric,
  abs_top_impression_pct      numeric,
  currency_code   text,
  updated_at      timestamptz not null default now(),
  primary key (account_id, campaign_id, day)
);
create index if not exists idx_lsa_campaign_daily_day on public.lsa_campaign_daily (day);
alter table public.lsa_campaign_daily enable row level security;
revoke all on public.lsa_campaign_daily from anon, authenticated;

-- When the cost pass last read this account. A pass cut short by the request budget
-- starts with the accounts read longest ago.
alter table public.lsa_api_accounts add column if not exists last_cost_at timestamptz;
