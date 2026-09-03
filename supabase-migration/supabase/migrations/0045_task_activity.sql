-- 0045_task_activity.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Task Activity — the audit trail on a task (who changed what, when). The live
-- Tasks page logs its own entries (Airtable table tbl2ZTHBDBPo681UL); the Supabase
-- Tasks page (os/tasks/index-supabase.html + supabase-shim.js) routes those here.
--
-- Forward-only, like the live one: it starts EMPTY and fills as changes are made
-- in the Supabase app. No backfill.
--
-- The page WRITES entries id-keyed (returnFieldsByFieldId=true) and READS them
-- back name-keyed, filtered by the task. So each row keeps a `fields` jsonb blob
-- keyed by Airtable field NAME (Actor, Actor Email, Field, Summary, Source, At,
-- …) plus a `task_id` column for the per-task filter/index. The shim converts the
-- incoming id-keyed write to name-keyed. Fully multi-tenant per 0022.
--
-- Unlike ceo_briefs (read-only), authenticated members may INSERT here — the page
-- is the writer, as the logged-in user, into their own org (org_id default).
--
-- DEPLOY (Kevin): run this file in the Supabase SQL editor.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.task_activity (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  task_id     text,                                  -- the task's record id (for the per-task read filter)
  fields      jsonb not null default '{}'::jsonb,    -- entry fields, keyed by Airtable field NAME
  created_at  timestamptz not null default now()
);

create index if not exists idx_task_activity_org  on public.task_activity(org_id);
create index if not exists idx_task_activity_task on public.task_activity(task_id);

alter table public.task_activity
  alter column org_id set default coalesce(public.current_org_id(), public.bridge_default_org_id());
alter table public.task_activity enable row level security;
alter table public.task_activity force row level security;
drop policy if exists org_isolation on public.task_activity;
create policy org_isolation on public.task_activity for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
grant select, insert, update, delete on public.task_activity to authenticated;

commit;

-- Verify:  select count(*) from public.task_activity;   -- 0 until the app logs something
