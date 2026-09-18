-- Run this in Supabase SQL editor (Dashboard → SQL Editor → New query)

CREATE TABLE IF NOT EXISTS public.companies (
  id        uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  name      text        NOT NULL UNIQUE,
  logo_b64  text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read"    ON public.companies FOR SELECT USING (true);
CREATE POLICY "service insert" ON public.companies FOR INSERT WITH CHECK (true);
CREATE POLICY "service update" ON public.companies FOR UPDATE USING (true);

-- Seed American Fire and Flood (logo uploaded via the web UI after first run)
INSERT INTO public.companies (name) VALUES ('American Fire and Flood')
ON CONFLICT (name) DO NOTHING;
