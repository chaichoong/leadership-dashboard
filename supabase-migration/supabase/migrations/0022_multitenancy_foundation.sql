-- 0022_multitenancy_foundation.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Turns the single-tenant Operations Director Supabase project into a MULTI-TENANT
-- one, and closes the live security hole (today every table's policy is
-- `authenticated_all USING (true)`, so any 2nd login sees ALL data).
--
-- What it does:
--   1. Workspace model: organizations + memberships (user↔workspace).
--   2. SECURITY DEFINER helpers used by policies (bypass RLS → no recursion).
--   3. Adds org_id to all 32 data tables (+ index + insert default).
--   4. Backfill: creates the "Runpreneur" workspace, makes Kevin owner and Micaa
--      admin (both are existing auth users — neither is locked out), stamps every
--      existing row with that org_id.
--   5. Replaces `authenticated_all` with org-scoped RLS on all 32 tables.
--   6. RLS on organizations + memberships.
--   7. security_invoker = on for all 9 views (else they bypass table RLS).
--
-- Non-breaking by design:
--   • The front-end shims never pass org_id — the column DEFAULT fills it from the
--     caller's membership, so no page code changes.
--   • The two service-role sync bridges (sync-ai-brain, sync-transactions) have no
--     auth.uid(); the DEFAULT falls back to the sole org while only one exists, so
--     their inserts keep landing correctly. (Once a 2nd org exists the fallback
--     returns NULL and those bridges must pass org_id explicitly — see FOLLOW-UPS.)
--
-- Idempotent-ish and transaction-wrapped: any failure rolls the whole thing back.
--
-- FOLLOW-UPS (NOT in this migration, needed before onboarding client #2):
--   • app_settings PK → (org_id, key), and update skills-shim upsert conflict target.
--   • Update sync-ai-brain / sync-transactions to set org_id explicitly.
--   • Set org_id NOT NULL once all writers stamp it.
--   • Module-entitlements (org_modules) + base-only signup seed (next migration).
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create extension if not exists pgcrypto;

-- 1. WORKSPACE MODEL ──────────────────────────────────────────────────────────
create table if not exists public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  plan       text not null default 'base',
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  org_id     uuid not null references public.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member',      -- owner | admin | member
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists idx_memberships_user on public.memberships(user_id);

-- 2. HELPERS (SECURITY DEFINER so policies don't recurse through memberships RLS)─
create or replace function public.is_org_member(o uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships
    where org_id = o and user_id = auth.uid()
  );
$$;

create or replace function public.current_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select org_id from public.memberships
  where user_id = auth.uid()
  order by created_at
  limit 1;
$$;

-- Single-tenant fallback: returns the only org while exactly one exists, else NULL.
-- Lets the service-role sync bridges (no auth.uid()) keep stamping org_id for now.
create or replace function public.bridge_default_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select case when (select count(*) from public.organizations) = 1
              then (select id from public.organizations)
         end;
$$;

-- 3–5. Everything that iterates the 32 data tables, in one block so the new
-- org id stays in scope for the backfill. ─────────────────────────────────────
do $$
declare
  t       text;
  v_org   uuid;
  v_kevin uuid;
  v_micaa uuid;
  tbls text[] := array[
    'accounts','achievements','ai_brain_today','app_settings','businesses',
    'coa_categories','coa_sub_categories','content_machine','costs','departments',
    'income_buckets','main_methods','net_worth_by_month','objectives_strategy',
    'personal_budgets','projects','properties','property_valuations','rental_units',
    'roles','sop_queue','sops','sys_workflows','task_attachments','task_comments',
    'task_completions','tasks','team_members','tenancies','tenants','transactions',
    'workflow_steps'
  ];
begin
  -- 3. add org_id + index to every data table
  foreach t in array tbls loop
    execute format('alter table public.%I add column if not exists org_id uuid references public.organizations(id)', t);
    execute format('create index if not exists %I on public.%I(org_id)', 'idx_'||t||'_org', t);
  end loop;

  -- 4. backfill workspace + memberships
  select id into v_kevin from auth.users where email = 'kevin@operationsdirector.co.uk';
  select id into v_micaa from auth.users where email = 'micaa.work@gmail.com';
  if v_kevin is null then
    raise exception 'Owner auth user kevin@operationsdirector.co.uk not found — aborting.';
  end if;

  insert into public.organizations (name, plan) values ('Runpreneur', 'base')
  returning id into v_org;
  insert into public.memberships (org_id, user_id, role) values (v_org, v_kevin, 'owner');
  if v_micaa is not null then
    insert into public.memberships (org_id, user_id, role) values (v_org, v_micaa, 'admin');
  end if;

  -- stamp all existing rows + set insert default (org from caller, else sole org)
  foreach t in array tbls loop
    execute format('update public.%I set org_id = %L where org_id is null', t, v_org);
    execute format('alter table public.%I alter column org_id set default coalesce(public.current_org_id(), public.bridge_default_org_id())', t);
  end loop;

  -- 5. swap blanket policy → org-scoped isolation on every data table
  foreach t in array tbls loop
    execute format('drop policy if exists authenticated_all on public.%I', t);
    execute format($f$create policy org_isolation on public.%I
                      for all to authenticated
                      using (public.is_org_member(org_id))
                      with check (public.is_org_member(org_id))$f$, t);
  end loop;

  -- 7. views must run as the caller so underlying table RLS applies
  for t in
    select table_name from information_schema.views where table_schema = 'public'
  loop
    execute format('alter view public.%I set (security_invoker = on)', t);
  end loop;
end $$;

-- 6. RLS on the workspace tables themselves ───────────────────────────────────
alter table public.organizations enable row level security;
alter table public.organizations force row level security;
drop policy if exists member_read on public.organizations;
create policy member_read on public.organizations
  for select to authenticated using (public.is_org_member(id));

alter table public.memberships enable row level security;
alter table public.memberships force row level security;
drop policy if exists self_read on public.memberships;
create policy self_read on public.memberships
  for select to authenticated using (user_id = auth.uid());

-- 8. grants (writes to these two happen via migration / definer functions only)
grant select on public.organizations to authenticated;
grant select on public.memberships  to authenticated;

commit;

-- ── VERIFY (read-only; run after commit) ─────────────────────────────────────
-- select count(*) as orgs from public.organizations;                      -- 1
-- select role, count(*) from public.memberships group by role;            -- owner 1, admin 1
-- select count(*) as tables_with_org_id from information_schema.columns
--   where table_schema='public' and column_name='org_id';                 -- 32
-- select count(*) as blanket_policies_left from pg_policies
--   where schemaname='public' and policyname='authenticated_all';         -- 0
-- select count(*) as views_leaking from pg_views v
--   join pg_class c on c.relname=v.viewname
--   where v.schemaname='public'
--     and 'security_invoker=on' <> all (coalesce(c.reloptions,'{}'));      -- 0
