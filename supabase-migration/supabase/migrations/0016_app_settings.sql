-- 0016_app_settings.sql
-- Generic key/value settings store for the Supabase build. First consumer: the
-- Skills Library "active presets" (which skills the user has toggled active) —
-- previously a single Airtable settings record (tblHGNzDmOs59r9QD/recqbcIz2R2griDn3,
-- field "Active Skill IDs", a JSON-string). Reusable for other small app settings.
create table if not exists public.app_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.app_settings;
create trigger set_updated_at before update on public.app_settings
  for each row execute function public.tg_set_updated_at();

alter table public.app_settings enable row level security;
alter table public.app_settings force row level security;
drop policy if exists authenticated_all on public.app_settings;
create policy authenticated_all on public.app_settings for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.app_settings to authenticated;
