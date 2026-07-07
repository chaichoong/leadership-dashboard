-- 0018_ai_brain.sql
-- AI Brain "Today" feed (clone of ai-brain.html on Supabase).
-- Airtable table tblZ75JgE1wzDP0ps is a nightly-generated feed the page reads by
-- FIELD NAME (Kind, Category, Value, DocName, Item, DocLink, Text, Status,
-- SortOrder, Date) — no returnFieldsByFieldId. So we store each row's values as a
-- name-keyed `fields` jsonb blob; the shim returns/merges that directly.
-- NOTE: the source table is populated by external nightly automation into Airtable;
-- this Supabase copy is a snapshot and needs a sync bridge to stay current (follow-up).
create table if not exists public.ai_brain_today (
  id          text primary key default public.new_id(),
  fields      jsonb not null default '{}'::jsonb,   -- all field values, keyed by Airtable field NAME
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.ai_brain_today;
create trigger set_updated_at before update on public.ai_brain_today
  for each row execute function public.tg_set_updated_at();

alter table public.ai_brain_today enable row level security;
alter table public.ai_brain_today force row level security;
drop policy if exists authenticated_all on public.ai_brain_today;
create policy authenticated_all on public.ai_brain_today for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.ai_brain_today to authenticated;
