-- 0015_systemisation.sql
-- Systemisation module (clone of os/systemisation/index.html on Supabase).
-- Depends on Module 1 (businesses already exist) and the Tasks module (tasks).
-- The Objective & Strategy table (Airtable tblEBvFw8DonwxzGh) is NOT migrated yet
-- (that's the separate "Objective & Strategy" module) → the shim stubs it empty, so
-- the strategy-based grouping of methods-by-business is deferred. Workflows, steps,
-- and methods are fully migrated here.

-- ============================ Main Methods ============================
-- Airtable tbl065D58MBEJhjlp. "business" field actually links to Objective/Strategy
-- (tblEBvFw8DonwxzGh), stored here as jsonb ids (unresolved until that module lands).
create table if not exists public.main_methods (
  id            text primary key default public.new_id(),
  name          text,
  description   text,
  objstrat_ids  jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================ Systemisation Workflows ============================
-- Airtable tblLPoRHFBl0vqR24.
create table if not exists public.sys_workflows (
  id                text primary key default public.new_id(),
  name              text,
  description       text,
  fulfil_stage      text,          -- singleSelect: "F - Find & Grab Attention" … "L - Loyalty Programme"
  department        text,          -- singleSelect: Marketing / Sales / Operations / Finance / Admin / HR
  status            text,          -- singleSelect: Not Started / In Progress / Complete
  sort_order        numeric,
  main_method_ids   jsonb not null default '[]'::jsonb,  -- link → main_methods (multi)
  business_ids      jsonb not null default '[]'::jsonb,  -- link → businesses (multi)
  skill_definition  text,
  drive_url         text,
  drive_doc_url     text,
  sop_document      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ============================ Workflow Steps ============================
-- Airtable tblTadoyWXFHbmYxm. Each step belongs to one workflow.
create table if not exists public.workflow_steps (
  id            text primary key default public.new_id(),
  name          text,
  description   text,
  workflow_id   text references public.sys_workflows(id) on delete cascade,
  step_type     text,          -- singleSelect: AI Skill / Staff Task / Both
  sop_content   text,
  sop_status    text,          -- singleSelect: Not Created / Draft / Complete
  sort_order    numeric,
  skill_id      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists workflow_steps_workflow_id_idx on public.workflow_steps (workflow_id);
create index if not exists sys_workflows_sort_idx on public.sys_workflows (sort_order);

-- updated_at triggers (helper defined in 0001)
drop trigger if exists set_updated_at on public.main_methods;
create trigger set_updated_at before update on public.main_methods
  for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.sys_workflows;
create trigger set_updated_at before update on public.sys_workflows
  for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.workflow_steps;
create trigger set_updated_at before update on public.workflow_steps
  for each row execute function public.tg_set_updated_at();

-- ============================ RLS (parity model) ============================
do $$
declare t text;
begin
  foreach t in array array['main_methods','sys_workflows','workflow_steps'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('alter table public.%I force row level security;', t);
    execute format('drop policy if exists authenticated_all on public.%I;', t);
    execute format($p$
      create policy authenticated_all on public.%I
        for all to authenticated using (true) with check (true);
    $p$, t);
    execute format('grant select, insert, update, delete on public.%I to authenticated;', t);
  end loop;
end $$;
