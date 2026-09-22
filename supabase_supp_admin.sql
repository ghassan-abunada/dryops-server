-- Supplemental billing admin dashboard (applied 2026-09-22).
create table if not exists public.supp_config (
  id integer primary key default 1 check (id = 1),
  master_token text not null unique
    default translate(encode(gen_random_bytes(18), 'base64'), '/+', '_-'),
  created_at timestamptz not null default now()
);
insert into public.supp_config (id) values (1) on conflict (id) do nothing;
alter table public.supp_config enable row level security;

-- Per-location recipient for supplemental emails (post-run notifications AND
-- 7d/2d prep reminders). A row REPLACES the auto-resolved reps for that
-- location; no row = auto-detection. DB rows take precedence over the
-- SUPP_NOTIFY_OVERRIDES env fallback.
create table if not exists public.supp_email_overrides (
  jn_location_id integer primary key,
  email text not null,
  updated_at timestamptz not null default now()
);
alter table public.supp_email_overrides enable row level security;

insert into public.supp_email_overrides (jn_location_id, email) values
  (33,'antonio@primepackouts.com'), (273,'ethan@americanpackout.com'),
  (114,'ethan@americanpackout.com'), (233,'ethan@americanpackout.com')
on conflict (jn_location_id) do nothing;
