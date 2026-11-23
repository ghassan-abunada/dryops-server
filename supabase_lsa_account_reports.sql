-- Google Local Services profiles, one row per account per day (lsaProfileSync.js).
-- Run once in the Supabase SQL editor. Safe to re-run. The server stores nothing until
-- this exists; the lead and cost syncs do not depend on it.
--
-- Google's account report gives the review count and star rating printed on the ad as
-- they stand today and keeps no history, so these daily rows ARE the history: reviews
-- gained over a period is the difference between two days here.
--
-- account_id is the Google Ads customer id, the same id as lsa_leads.account_id and
-- lsa_account_numbers.account_id. The period columns cover `period_days` full days
-- ending the day before `day`; the prev_ columns cover the same length before that.
-- cost is in currency_code units (dollars, not micros). phone_responsiveness is Google's
-- own score, stored as sent.
--
-- RLS is on with no policies and anon/authenticated have no grants, as on the other
-- lsa_ tables: only the service key reads or writes. The app reads through the
-- google_profiles RPC (DryOps repo, supabase/add_google_profiles.sql).

create table if not exists public.lsa_account_reports (
  account_id            text not null,
  day                   date not null,
  business_name         text,
  total_reviews         integer,
  avg_rating            numeric,
  weekly_budget         numeric,
  phone_responsiveness  numeric,
  period_days           integer not null default 30,
  charged_leads         integer,
  prev_charged_leads    integer,
  cost                  numeric,
  prev_cost             numeric,
  phone_calls           integer,
  prev_phone_calls      integer,
  connected_calls       integer,
  prev_connected_calls  integer,
  impressions_2d        bigint,
  currency_code         text,
  manager_ids           text[] not null default '{}',
  updated_at            timestamptz not null default now(),
  primary key (account_id, day)
);
create index if not exists idx_lsa_account_reports_day on public.lsa_account_reports (day);
alter table public.lsa_account_reports enable row level security;
revoke all on public.lsa_account_reports from anon, authenticated;
