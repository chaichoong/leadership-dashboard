-- 0021_content_machine.sql
-- Content Machine (clone of the separate github.com/chaichoong/content-machine app
-- on Supabase). It's a single-file marketing app with one Airtable table
-- (tblEPzZdwBZeSXFRB) holding content pieces + per-platform copy/links/analytics.
-- The app reads/writes by FIELD NAME (no returnFieldsByFieldId), so store each row
-- as a name-keyed `fields` jsonb blob. AI runs via BYO keys + a proxy worker
-- (untouched); only this table moves to Supabase.
create table if not exists public.content_machine (
  id          text primary key default public.new_id(),
  fields      jsonb not null default '{}'::jsonb,   -- values keyed by Airtable field NAME
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.content_machine;
create trigger set_updated_at before update on public.content_machine
  for each row execute function public.tg_set_updated_at();

alter table public.content_machine enable row level security;
alter table public.content_machine force row level security;
drop policy if exists authenticated_all on public.content_machine;
create policy authenticated_all on public.content_machine for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.content_machine to authenticated;
