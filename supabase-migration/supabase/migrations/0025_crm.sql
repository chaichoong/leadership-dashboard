-- 0025_crm.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Generic CRM = the base-plan "Operations" module: contacts (entity records) +
-- pipelines (kanban of deals). Net-new (no Airtable origin). Fully multi-tenant:
-- org_id + org-scoped RLS matching 0022, gated in the shell by the 'crm' module.
--
-- Tables: crm_contacts, crm_pipelines, crm_stages, crm_deals.
-- Also seeds a default "Sales Pipeline" (Lead→…→Won/Lost) for the Runpreneur
-- workspace and every future signup (via provision_new_workspace).
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.crm_contacts (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid references public.organizations(id) on delete cascade,
  name       text not null,
  kind       text not null default 'person',        -- person | company
  email      text,
  phone      text,
  company    text,
  job_title  text,
  owner_member_id text,                              -- loose link to a team member
  tags       jsonb not null default '[]'::jsonb,
  status     text default 'active',
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.crm_pipelines (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid references public.organizations(id) on delete cascade,
  name       text not null,
  sort_order numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.crm_stages (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  pipeline_id uuid references public.crm_pipelines(id) on delete cascade,
  name        text not null,
  sort_order  numeric not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.crm_deals (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references public.organizations(id) on delete cascade,
  pipeline_id uuid references public.crm_pipelines(id) on delete cascade,
  stage_id    uuid references public.crm_stages(id) on delete set null,
  contact_id  uuid references public.crm_contacts(id) on delete set null,
  title       text not null,
  value       numeric,
  currency    text default 'GBP',
  owner_member_id text,
  status      text default 'open',                  -- open | won | lost
  notes       text,
  sort_order  numeric not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- updated_at auto-touch (reuse existing helper if present)
do $$ begin
  if exists (select 1 from pg_proc where proname = 'tg_set_updated_at') then
    execute 'drop trigger if exists set_updated_at on public.crm_contacts';
    execute 'create trigger set_updated_at before update on public.crm_contacts for each row execute function public.tg_set_updated_at()';
    execute 'drop trigger if exists set_updated_at on public.crm_deals';
    execute 'create trigger set_updated_at before update on public.crm_deals for each row execute function public.tg_set_updated_at()';
  end if;
end $$;

-- index + org_id default + org-scoped RLS + grants on all four
do $$
declare t text; tbls text[] := array['crm_contacts','crm_pipelines','crm_stages','crm_deals'];
begin
  foreach t in array tbls loop
    execute format('create index if not exists %I on public.%I(org_id)', 'idx_'||t||'_org', t);
    execute format('alter table public.%I alter column org_id set default coalesce(public.current_org_id(), public.bridge_default_org_id())', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists org_isolation on public.%I', t);
    execute format($f$create policy org_isolation on public.%I for all to authenticated
      using (public.is_org_member(org_id)) with check (public.is_org_member(org_id))$f$, t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
create index if not exists idx_crm_deals_stage on public.crm_deals(stage_id);
create index if not exists idx_crm_stages_pipeline on public.crm_stages(pipeline_id);

-- Seed a default pipeline + stages for an org (idempotent — skips if one exists).
create or replace function public.seed_default_pipeline(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_pipe uuid; s text; i int := 0;
  stages text[] := array['Lead','Contacted','Qualified','Proposal','Won','Lost'];
begin
  if exists (select 1 from public.crm_pipelines where org_id = p_org) then return; end if;
  insert into public.crm_pipelines (org_id, name, sort_order) values (p_org, 'Sales Pipeline', 0)
  returning id into v_pipe;
  foreach s in array stages loop
    i := i + 1;
    insert into public.crm_stages (org_id, pipeline_id, name, sort_order) values (p_org, v_pipe, s, i);
  end loop;
end $$;

-- Backfill the existing Runpreneur workspace.
do $$ declare v_org uuid; begin
  select id into v_org from public.organizations where name = 'Runpreneur' order by created_at limit 1;
  if v_org is not null then perform public.seed_default_pipeline(v_org); end if;
end $$;

-- New signups also get a default pipeline (extend the provisioning function).
create or replace function public.provision_new_workspace(
  p_user uuid, p_email text, p_org_name text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org  uuid;
  v_name text;
  k      text;
  ttl    text;
  base_mods  text[] := array['command_centre','strategy','tasks','team',
                             'systemisation','ai_assistant','dod_queue','crm'];
  addon_mods text[] := array['finance','inbound_comms','content_machine',
                             'personal_wealth','property'];
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
  v_name := coalesce(nullif(p_org_name, ''), split_part(p_email, '@', 1) || '''s Workspace');

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

  foreach ttl in array starter_sops loop
    insert into public.sops (id, title, sop_status, sop_type, is_trained, org_id)
    values (public.new_id(), ttl, 'Live', 'Getting Started', false, v_org);
  end loop;

  perform public.seed_default_pipeline(v_org);
  return v_org;
end $$;

commit;
