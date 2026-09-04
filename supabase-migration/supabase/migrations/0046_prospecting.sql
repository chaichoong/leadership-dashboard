-- 0046_prospecting.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- PROSPECTING (cold outbound pipeline) → Supabase. Two Airtable tables:
--   • Prospects        (tbljHVGJoKJf8acy3)  → public.prospects
--   • Prospect Keywords(tblB5tZrXNaKFe02j)  → public.prospect_keywords
-- Backs the Prospecting twin (prospecting-supabase.html + prospecting-shim.js):
-- funnel, review queue, pipeline table, keyword manager.
--
-- Prospecting is a PAID ADD-ON (module_key 'prospecting'), NOT part of the base
-- plan — same packaging as content_machine / inbound_comms. Seeded OFF for every
-- client; ON only for the system-owner workspace (any org that already has
-- content_machine enabled). New signups get it OFF (added to addon_mods below).
--
-- Rows store a `fields` jsonb keyed by Airtable field NAME (the twin reads by
-- name; the shim maps incoming id-keyed writes → names). Org-scoped RLS per 0022,
-- so a client only ever sees their own prospects. Table starts EMPTY — no data is
-- seeded (this repo is public; prospects carry names + contact emails). The daily
-- prospecting agent still writes to Airtable; a copy job can be added later if
-- Kevin wants his existing prospects on Supabase too.
--
-- DEPLOY (Kevin): run THIS ONE FILE in the Supabase SQL editor. That is the only
-- step — the twin degrades gracefully (empty pipeline) until it runs, and turns
-- fully live the moment it does.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── Tables ───────────────────────────────────────────────────────────────────
create table if not exists public.prospects (
  id          text primary key default public.new_id(),
  org_id      uuid references public.organizations(id) on delete cascade,
  fields      jsonb not null default '{}'::jsonb,   -- prospect fields, keyed by Airtable field NAME
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.prospect_keywords (
  id          text primary key default public.new_id(),
  org_id      uuid references public.organizations(id) on delete cascade,
  fields      jsonb not null default '{}'::jsonb,   -- keyword fields, keyed by Airtable field NAME
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- updated_at trigger (mirrors debt_terms/task_activity)
do $$ begin
  if exists (select 1 from pg_proc where proname = 'tg_set_updated_at') then
    execute 'drop trigger if exists set_updated_at on public.prospects';
    execute 'create trigger set_updated_at before update on public.prospects for each row execute function public.tg_set_updated_at()';
    execute 'drop trigger if exists set_updated_at on public.prospect_keywords';
    execute 'create trigger set_updated_at before update on public.prospect_keywords for each row execute function public.tg_set_updated_at()';
  end if;
end $$;

-- ── Org scoping + RLS (identical idiom to 0044) ──────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['prospects','prospect_keywords'] loop
    execute format('create index if not exists idx_%s_org on public.%s(org_id)', t, t);
    execute format('alter table public.%s alter column org_id set default coalesce(public.current_org_id(), public.bridge_default_org_id())', t);
    execute format('alter table public.%s enable row level security', t);
    execute format('alter table public.%s force row level security', t);
    execute format('drop policy if exists org_isolation on public.%s', t);
    execute format('create policy org_isolation on public.%s for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))', t);
    execute format('grant select, insert, update, delete on public.%s to authenticated', t);
  end loop;
end $$;

-- ── Entitlement: seed the 'prospecting' add-on for EXISTING orgs ──────────────
-- ON for the owner workspace (any org with content_machine already enabled),
-- OFF for every client. Absence of the flip in new provisioning is covered below.
insert into public.org_modules (org_id, module_key, enabled)
select o.id, 'prospecting',
       coalesce(
         (select cm.enabled from public.org_modules cm
          where cm.org_id = o.id and cm.module_key = 'content_machine'),
         false)
from public.organizations o
on conflict (org_id, module_key) do nothing;

commit;

-- ── New-signup default: prospecting is an OFF-by-default add-on ───────────────
-- Redefine provision_new_workspace with 'prospecting' added to addon_mods.
-- Body is identical to 0040 apart from that one array entry.
begin;

create or replace function public.provision_new_workspace(
  p_user uuid, p_email text, p_org_name text default null, p_member_name text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org  uuid;
  v_name text;
  v_member text;
  k      text;
  ttl    text;
  guide_url text := 'https://chaichoong.github.io/leadership-dashboard/crm-guide.html';
  base_mods  text[] := array['strategy','tasks','team',
                             'systemisation','ai_assistant','dod_queue','crm'];
  addon_mods text[] := array['finance','inbound_comms','content_machine',
                             'personal_wealth','property','prospecting'];
  -- Base features that ship OFF for new clients but can be toggled on per client.
  optout_mods text[] := array['plan_builder','command_centre'];
  starter_sops text[] := array[
    'Welcome — set up your Business profile',
    'Getting Started — the Command Centre (your dashboard & KPIs)',
    'How to use Objective & Strategy',
    'How to plan & run Tasks & Projects',
    'Build your Team directory',
    'Systemisation — build AI skills & recurring tasks (your automation engine)',
    'Using the AI Assistant',
    'Request an improvement — the DOD queue (one request at a time)',
    'Add-ons — turn on Finance, Comms, Content or Property'
  ];
begin
  v_name   := coalesce(nullif(p_org_name, ''), split_part(p_email, '@', 1) || '''s Workspace');
  v_member := coalesce(nullif(p_member_name, ''), v_name);

  insert into public.organizations (name, plan) values (v_name, 'base') returning id into v_org;
  insert into public.memberships (org_id, user_id, role) values (v_org, p_user, 'owner');

  foreach k in array base_mods loop
    insert into public.org_modules (org_id, module_key, enabled) values (v_org, k, true)
    on conflict (org_id, module_key) do nothing;
  end loop;
  foreach k in array addon_mods loop
    insert into public.org_modules (org_id, module_key, enabled) values (v_org, k, false)
    on conflict (org_id, module_key) do nothing;
  end loop;
  foreach k in array optout_mods loop
    insert into public.org_modules (org_id, module_key, enabled) values (v_org, k, false)
    on conflict (org_id, module_key) do nothing;
  end loop;

  foreach ttl in array starter_sops loop
    insert into public.sops (id, title, sop_status, sop_type, is_trained, org_id)
    values (public.new_id(), ttl, 'Live', 'Getting Started', false, v_org);
  end loop;
  insert into public.sops (id, title, sop_status, sop_type, sop_video, is_trained, org_id)
  values (public.new_id(), 'How to use the CRM', 'Live', 'Getting Started', guide_url, false, v_org);

  insert into public.team_members (id, org_id, member, member_email, work_email, active, status, weekly_capacity)
  values (public.new_id(), v_org, v_member, lower(p_email), lower(p_email), true, 'Active', 40);

  perform public.seed_default_pipeline(v_org);
  return v_org;
end $$;

commit;

-- ── VERIFY ───────────────────────────────────────────────────────────────────
--   select count(*) from public.prospects;          -- 0 until data is added
--   select o.name, m.enabled
--   from public.org_modules m join public.organizations o on o.id = m.org_id
--   where m.module_key = 'prospecting' order by m.enabled desc;
--   -- Operations Director Main → true; every client → false
