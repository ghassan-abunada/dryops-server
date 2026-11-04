-- One-time NetSuite credential drop (netsuiteIntake.js). Run once in the Supabase SQL editor.
-- A single row: id is pinned to 1, so a second submission cannot replace the first.
-- `secrets` is AES-256-GCM ciphertext (key = NETSUITE_ENC_KEY on Railway, never in the database).
-- RLS is on with no policies, and anon/authenticated have no grants: only the service key reads it.
create table if not exists public.netsuite_credentials (
  id              int primary key default 1 check (id = 1),
  method          text not null check (method in ('oauth2_m2m', 'tba')),
  account_id      text not null,
  secrets         text not null,
  expense_tagging text,
  notes           text,
  submitted_at    timestamptz not null default now()
);
alter table public.netsuite_credentials enable row level security;
revoke all on public.netsuite_credentials from anon, authenticated;
