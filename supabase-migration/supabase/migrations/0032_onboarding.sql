-- 0032_onboarding.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Client onboarding intake. A newly signed-up client fills the PUBLIC form
-- (onboarding.html) with the facts needed to stand up their account. Their
-- answers land here, and the `onboarding-submit` Edge Function (service role)
-- also creates a CRM contact + a Won-stage deal in Kevin's Runpreneur workspace,
-- so it chains straight into the existing "Create client account" button.
--
-- This table is written ONLY by the service-role Edge Function (which bypasses
-- RLS). There is deliberately NO anon/public policy — the anonymous form never
-- touches the table directly. Authenticated org members (Kevin/Mica) can read
-- and manage their org's submissions via the org-scoped policy below, exactly
-- like every table in 0025_crm.sql.
--
-- DEPLOY (Mica):
--   1. supabase db push   (or run this file in the SQL editor)
--   2. supabase functions deploy onboarding-submit --no-verify-jwt
--   3. Confirm the "Runpreneur" org + a pipeline with a "Won" stage exist
--      (both seeded by 0025_crm.sql).
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.onboarding_submissions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid references public.organizations(id) on delete cascade,
  contact_id    uuid references public.crm_contacts(id) on delete set null,
  deal_id       uuid references public.crm_deals(id) on delete set null,
  business_name text,
  contact_name  text,
  email         text,
  phone         text,
  answers       jsonb not null default '{}'::jsonb,   -- full structured payload
  source        text not null default 'onboarding_form',
  status        text not null default 'new',          -- new | reviewed | provisioned
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- updated_at auto-touch (reuse the shared helper if it exists, as 0025 does)
do $$ begin
  if exists (select 1 from pg_proc where proname = 'tg_set_updated_at') then
    execute 'drop trigger if exists set_updated_at on public.onboarding_submissions';
    execute 'create trigger set_updated_at before update on public.onboarding_submissions
             for each row execute function public.tg_set_updated_at()';
  end if;
end $$;

-- index + org_id default + org-scoped RLS + grants (same shape as 0025_crm.sql)
create index if not exists idx_onboarding_submissions_org on public.onboarding_submissions(org_id);
create index if not exists idx_onboarding_submissions_created on public.onboarding_submissions(created_at desc);

alter table public.onboarding_submissions
  alter column org_id set default coalesce(public.current_org_id(), public.bridge_default_org_id());

alter table public.onboarding_submissions enable row level security;
alter table public.onboarding_submissions force row level security;
drop policy if exists org_isolation on public.onboarding_submissions;
create policy org_isolation on public.onboarding_submissions
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

grant select, insert, update, delete on public.onboarding_submissions to authenticated;

commit;

-- ── VERIFY (read-only; run after commit) ─────────────────────────────────────
-- select count(*) as tbl from information_schema.tables
--   where table_schema='public' and table_name='onboarding_submissions';        -- 1
-- select polname from pg_policies
--   where schemaname='public' and tablename='onboarding_submissions';           -- org_isolation
-- select relforcerowsecurity from pg_class where relname='onboarding_submissions'; -- t
