-- 0017_objectives_strategy.sql
-- Objective & Strategy module (clone of os/strategy/index.html on Supabase).
-- The Airtable table tblEBvFw8DonwxzGh is ~90 fields wide (9/3/1-year targets, 20
-- undertakings, 5 USPs, 10 method-link slots, 3 quarterly projects each with KPI/
-- DoD/owner + monthly stepping-stones). Rather than 90 columns, we keep the key/
-- filter fields as columns and stash the full field set (keyed by Airtable field
-- id, exactly as returnFieldsByFieldId=true returns them) in a `fields` jsonb blob.
-- The shim reads/writes that blob; strategy.js accesses everything by field id.
-- One row per Business x Quarter x Year. Depends on Module 1 (businesses).
create table if not exists public.objectives_strategy (
  id            text primary key default public.new_id(),
  business_id   text references public.businesses(id) on delete set null,
  business_name text,          -- mirrors the "Business Name" formula (used by the {Business Name} filter)
  quarter       text,          -- Q1..Q4
  year          text,          -- singleSelect year
  created_time  timestamptz,   -- Airtable createdTime
  fields        jsonb not null default '{}'::jsonb,   -- all field values, keyed by Airtable field id
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists objstrat_lookup_idx on public.objectives_strategy (business_name, quarter, year);
create index if not exists objstrat_business_idx on public.objectives_strategy (business_id);

drop trigger if exists set_updated_at on public.objectives_strategy;
create trigger set_updated_at before update on public.objectives_strategy
  for each row execute function public.tg_set_updated_at();

alter table public.objectives_strategy enable row level security;
alter table public.objectives_strategy force row level security;
drop policy if exists authenticated_all on public.objectives_strategy;
create policy authenticated_all on public.objectives_strategy for all to authenticated using (true) with check (true);
grant select, insert, update, delete on public.objectives_strategy to authenticated;
