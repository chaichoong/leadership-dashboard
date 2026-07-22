-- 0033_client_offboarding.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Two-stage client offboarding for the CRM "Clients" tab:
--   Stage 1  SUSPEND  — access off, data kept, reversible (client cancels).
--   Stage 2  DELETE   — permanent wipe via the existing delete_workspace() (0027).
--
-- Adds a lifecycle status to organizations and the suspend/restore functions.
-- Suspending disables the workspace members' LOGINS (auth.users.banned_until),
-- but only for members whose sole workspace is this one — so a shared operator
-- (e.g. Kevin, who is never a member of a client org anyway) can never be locked
-- out. Restore reverses it. All three functions are service-role only (called by
-- the manage-client Edge Function after an admin check); execute is revoked from
-- anon/authenticated so a client-side key can't touch them.
--
-- DEPLOY (Mica):
--   1. Run this file in the SQL editor (or supabase db push).
--   2. Deploy the function:  supabase functions deploy manage-client
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- 1. Lifecycle status on the workspace ────────────────────────────────────────
alter table public.organizations
  add column if not exists status       text not null default 'active',   -- active | suspended
  add column if not exists suspended_at  timestamptz;

-- 2. SUSPEND — flag the org + ban its single-org members' logins ──────────────
create or replace function public.suspend_workspace(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_org is null then raise exception 'org id required'; end if;

  update public.organizations
     set status = 'suspended', suspended_at = now()
   where id = p_org;

  -- Disable login for members whose ONLY membership is this workspace.
  update auth.users u
     set banned_until = 'infinity'
   where u.id in (select user_id from public.memberships where org_id = p_org)
     and not exists (
       select 1 from public.memberships m
       where m.user_id = u.id and m.org_id <> p_org
     );
end $$;

-- 3. RESTORE — re-activate the org + lift the login ban ───────────────────────
create or replace function public.restore_workspace(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_org is null then raise exception 'org id required'; end if;

  update public.organizations
     set status = 'active', suspended_at = null
   where id = p_org;

  -- Lift the ban only for members of this org (leave any other-org bans alone).
  update auth.users u
     set banned_until = null
   where u.id in (select user_id from public.memberships where org_id = p_org)
     and u.banned_until is not null;
end $$;

-- 4. LIST — every workspace with owner email + member count (one round-trip) ──
-- The Edge Function filters out the caller's own workspace(s) in JS; whatever
-- remains is a client workspace.
create or replace function public.list_client_workspaces()
returns table(id uuid, name text, plan text, status text, created_at timestamptz,
              suspended_at timestamptz, owner_email text, member_count int)
language sql security definer set search_path = public, auth as $$
  select o.id, o.name, o.plan, coalesce(o.status,'active') as status,
         o.created_at, o.suspended_at,
         (select u.email from public.memberships m
            join auth.users u on u.id = m.user_id
           where m.org_id = o.id and m.role = 'owner'
           order by m.created_at limit 1) as owner_email,
         (select count(*)::int from public.memberships m where m.org_id = o.id) as member_count
  from public.organizations o
  order by o.created_at;
$$;

-- Owner email for a single workspace (used to link the CRM deal/contact).
create or replace function public.workspace_owner_email(p_org uuid)
returns text language sql security definer set search_path = public, auth as $$
  select u.email from public.memberships m
    join auth.users u on u.id = m.user_id
   where m.org_id = p_org and m.role = 'owner'
   order by m.created_at limit 1;
$$;

-- 5. Lock down — service-role / definer only (never a client-side key) ─────────
revoke all on function public.suspend_workspace(uuid) from public, anon, authenticated;
revoke all on function public.restore_workspace(uuid) from public, anon, authenticated;
revoke all on function public.list_client_workspaces() from public, anon, authenticated;
revoke all on function public.workspace_owner_email(uuid) from public, anon, authenticated;

commit;

-- ── VERIFY (read-only; run after commit) ─────────────────────────────────────
-- select column_name from information_schema.columns
--   where table_schema='public' and table_name='organizations'
--     and column_name in ('status','suspended_at');                       -- 2 rows
-- select proname from pg_proc where proname in
--   ('suspend_workspace','restore_workspace','delete_workspace');         -- 3 rows
