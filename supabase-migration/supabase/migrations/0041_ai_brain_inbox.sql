-- 0041_ai_brain_inbox.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- AI Brain "Feed your brain" capture inbox (Add note / video / document).
--
-- The live ai-brain.html gained real capture lanes that POST to a SECOND Airtable
-- table (tbliR8KkOV4SKNiIZ) — the private inbox the nightly tidy pulls from. The
-- Supabase clone (ai-brain-supabase.html + ai-brain-shim.js v2) routes those
-- writes here instead of hitting Airtable with the dummy token, so the buttons
-- save rather than error.
--
-- Same shape as ai_brain_today (0018): a name-keyed `fields` jsonb blob
-- (Text / Kind / Submitted / Status), because the page writes by field NAME.
-- Fully multi-tenant per 0022: org_id + org-scoped RLS. Write-only for now — no
-- ETL/backfill (the inbox starts empty per workspace); there is no client-side
-- nightly processor yet, so this captures notes for later use.
--
-- DEPLOY (Kevin): run this file in the Supabase SQL editor (or `supabase db push`).
--   Until it runs, the capture buttons show a friendly "couldn't save" — never a crash.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.ai_brain_inbox (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  fields      jsonb not null default '{}'::jsonb,   -- name-keyed: Text, Kind, Submitted, Status
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- updated_at auto-touch (reuse the shared helper if present, as 0025 does)
do $$ begin
  if exists (select 1 from pg_proc where proname = 'tg_set_updated_at') then
    execute 'drop trigger if exists set_updated_at on public.ai_brain_inbox';
    execute 'create trigger set_updated_at before update on public.ai_brain_inbox for each row execute function public.tg_set_updated_at()';
  end if;
end $$;

-- index + org_id default + org-scoped RLS + grants (matches every table since 0022)
create index if not exists idx_ai_brain_inbox_org on public.ai_brain_inbox(org_id);
alter table public.ai_brain_inbox
  alter column org_id set default coalesce(public.current_org_id(), public.bridge_default_org_id());
alter table public.ai_brain_inbox enable row level security;
alter table public.ai_brain_inbox force row level security;
drop policy if exists org_isolation on public.ai_brain_inbox;
create policy org_isolation on public.ai_brain_inbox for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
grant select, insert, update, delete on public.ai_brain_inbox to authenticated;

commit;

-- Verify (run after commit):
--   select column_name from information_schema.columns
--    where table_name = 'ai_brain_inbox';                          -- id, org_id, fields, created_at, updated_at
--   select polname from pg_policy
--    where polrelid = 'public.ai_brain_inbox'::regclass;           -- org_isolation
