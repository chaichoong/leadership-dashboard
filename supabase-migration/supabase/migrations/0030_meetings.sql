-- 0030_meetings.sql
-- The Tasks page "Meetings" tab read the Airtable Meetings table
-- (tblNodbh9B3WLzCIK) directly — never migrated, so on Supabase it fell through
-- to Airtable and failed ("Auth failed"). Add a Supabase meetings table so the
-- tab routes through the shim like everything else. Multi-tenant + RLS.

begin;

create table if not exists public.meetings (
  id            text primary key default public.new_id(),
  org_id        uuid references public.organizations(id) on delete cascade,
  name          text,
  date          date,
  status        text,
  attendees     jsonb not null default '[]'::jsonb,   -- team_member ids
  ext_attendees text,
  summary       text,
  action_points text,
  tasks         jsonb not null default '[]'::jsonb,   -- task ids
  recording     text,
  source        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_meetings_org on public.meetings(org_id);
alter table public.meetings alter column org_id set default coalesce(public.current_org_id(), public.bridge_default_org_id());
alter table public.meetings enable row level security;
alter table public.meetings force row level security;
drop policy if exists org_isolation on public.meetings;
create policy org_isolation on public.meetings for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
grant select, insert, update, delete on public.meetings to authenticated;

drop trigger if exists set_updated_at on public.meetings;
create trigger set_updated_at before update on public.meetings
  for each row execute function public.tg_set_updated_at();

commit;
