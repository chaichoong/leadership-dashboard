-- 0042_hr_reviews_dod.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- HR / Team Members page (os/team/index-supabase.html) rebuilt from the richer
-- standalone HR app (chaichoong.github.io/HR). Two Airtable tables it uses have
-- no Supabase equivalent yet; add them, plus a slot on team_members for the extra
-- (non-sensitive) HR profile fields.
--
--   performance_reviews  ← Airtable tblfsuNXU9HRN4d9f ("Performance Reviews")
--   dod                  ← Airtable tbltrOX1yyiuUuW59 ("DOD" — per-SOP training tracker)
--
-- Both read id-keyed (returnFieldsByFieldId=true), so — matching ai_brain_today /
-- objectives_strategy / content_machine — each row is a `fields` jsonb blob keyed
-- by Airtable field id; the shim returns/merges it straight through. Fully
-- multi-tenant per 0022 (org_id + org-scoped RLS).
--
-- SENSITIVE FIELDS HELD BACK (Kevin's call, 2026-07-30): pay rate + bank details
-- (hourlyRate/bankName/accountHolder/bankAcct/iban/sortCode/swift) are NOT stored
-- here. The team_members.hr_fields blob and the shim both exclude them. Revisit
-- with the GDPR pack before adding financial data to Supabase.
--
-- DEPLOY (Kevin): run this file in the Supabase SQL editor (or `supabase db push`).
-- Data is copied separately by scripts/sync-hr.py (Stage 4) — tables start empty,
-- so the Reviews/Training tabs show "nothing yet" until that runs; the Directory
-- (core team_members) already has data.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- 1. Performance Reviews ──────────────────────────────────────────────────────
create table if not exists public.performance_reviews (
  id             text primary key default public.new_id(),   -- Airtable rec id on ETL upsert
  org_id         uuid references public.organizations(id) on delete cascade,
  team_member_id text,                                  -- convenience link (from the blob's Team Member)
  fields         jsonb not null default '{}'::jsonb,    -- all review fields, keyed by Airtable field id
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 2. DOD (per-SOP training records) ───────────────────────────────────────────
create table if not exists public.dod (
  id          text primary key default public.new_id(),   -- Airtable rec id on ETL upsert
  org_id      uuid references public.organizations(id) on delete cascade,
  fields      jsonb not null default '{}'::jsonb,       -- SOP Title / Status / Video / Trained, keyed by field id
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 3. team_members: a slot for the extra NON-SENSITIVE HR profile fields ────────
-- (vision board, role/values Q&A, expected weekly, handbook link, PR rollups).
-- Merged into the id-keyed record by the shim. Bank/pay fields are never written.
alter table public.team_members
  add column if not exists hr_fields jsonb not null default '{}'::jsonb;

-- updated_at auto-touch on the two new tables (reuse the shared helper if present)
do $$ begin
  if exists (select 1 from pg_proc where proname = 'tg_set_updated_at') then
    execute 'drop trigger if exists set_updated_at on public.performance_reviews';
    execute 'create trigger set_updated_at before update on public.performance_reviews for each row execute function public.tg_set_updated_at()';
    execute 'drop trigger if exists set_updated_at on public.dod';
    execute 'create trigger set_updated_at before update on public.dod for each row execute function public.tg_set_updated_at()';
  end if;
end $$;

-- index + org_id default + org-scoped RLS + grants (matches every table since 0022)
do $$
declare t text; tbls text[] := array['performance_reviews','dod'];
begin
  foreach t in array tbls loop
    execute format('create index if not exists %I on public.%I(org_id)', 'idx_'||t||'_org', t);
    execute format('alter table public.%I alter column org_id set default coalesce(public.current_org_id(), public.bridge_default_org_id())', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists org_isolation on public.%I', t);
    execute format($f$create policy org_isolation on public.%I for all to authenticated
      using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))$f$, t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
create index if not exists idx_perf_reviews_member on public.performance_reviews(team_member_id);

commit;

-- Verify (run after commit):
--   select table_name from information_schema.tables
--    where table_name in ('performance_reviews','dod');                    -- 2 rows
--   select column_name from information_schema.columns
--    where table_name='team_members' and column_name='hr_fields';         -- 1 row
--   select polname from pg_policy
--    where polrelid in ('public.performance_reviews'::regclass,'public.dod'::regclass);  -- org_isolation x2
