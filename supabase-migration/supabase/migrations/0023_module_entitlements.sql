-- 0023_module_entitlements.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Per-workspace module entitlements. A workspace only "has" the modules listed
-- here (enabled=true); the shell (supabase-app.html) gates the sidebar on it.
-- This is what makes "sell the base plan, switch on paid add-ons" work.
--
-- Module keys (match the packaging decided 2026-07-14):
--   BASE (every workspace): command_centre, strategy, tasks, team,
--                           systemisation, ai_assistant, dod_queue, crm
--   ADD-ONS (£100/mo + £400 setup each): finance, inbound_comms,
--                           content_machine, personal_wealth, property
--
-- Seeds the existing Runpreneur workspace with ALL modules ON, so nothing
-- changes for Kevin. New-workspace seeding (base-only) is the next migration.
--
-- NOTE: this is a UI-level gate. Data is already isolated per-org by 0022; a
-- base-only workspace simply has no rows in the add-on tables. True per-module
-- data enforcement (if ever needed) would layer on top of this.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.org_modules (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  module_key text not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (org_id, module_key)
);

alter table public.org_modules enable row level security;
alter table public.org_modules force row level security;
drop policy if exists member_read on public.org_modules;
create policy member_read on public.org_modules
  for select to authenticated using (public.is_org_member(org_id));
grant select on public.org_modules to authenticated;

-- Seed Runpreneur (Kevin's workspace) with everything enabled.
do $$
declare
  v_org uuid;
  k text;
  base_mods  text[] := array['command_centre','strategy','tasks','team',
                             'systemisation','ai_assistant','dod_queue','crm'];
  addon_mods text[] := array['finance','inbound_comms','content_machine',
                             'personal_wealth','property'];
begin
  select id into v_org from public.organizations where name = 'Runpreneur'
  order by created_at limit 1;
  if v_org is null then raise exception 'Runpreneur workspace not found — run 0022 first.'; end if;

  foreach k in array (base_mods || addon_mods) loop
    insert into public.org_modules (org_id, module_key, enabled)
    values (v_org, k, true)
    on conflict (org_id, module_key) do nothing;
  end loop;
end $$;

commit;

-- ── VERIFY ───────────────────────────────────────────────────────────────────
-- select count(*) from public.org_modules;                    -- 13
-- select module_key, enabled from public.org_modules order by module_key;
