-- 0029_fix_bridge_default_org.sql
-- BUG: bridge_default_org_id() only returned an org when exactly ONE org existed.
-- Once a client workspace was created (2+ orgs) it returned NULL, so the Fintable
-- and AI-Brain sync bridges (which run without a user session and rely on the
-- org_id column default) inserted rows with org_id = NULL — invisible under RLS
-- to everyone, including the owner. Fix: always return the HOME (owner) org — the
-- earliest-created organization — and backfill the orphaned rows.

begin;

create or replace function public.bridge_default_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.organizations order by created_at asc limit 1;
$$;

-- Backfill every org-scoped table's NULL org_id rows to the home org.
do $$
declare v_home uuid; t text;
begin
  select id into v_home from public.organizations order by created_at asc limit 1;
  for t in
    select table_name from information_schema.columns
    where table_schema='public' and column_name='org_id'
      and table_name not in ('memberships','organizations')
  loop
    execute format('update public.%I set org_id = $1 where org_id is null', t) using v_home;
  end loop;
end $$;

commit;
