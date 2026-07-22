-- 0034_fix_delete_workspace.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Fixes delete_workspace() (0027). The original disabled FK checks with
--   set local session_replication_role = 'replica'
-- which Supabase does NOT allow — it's a superuser-only GUC, so the wipe failed
-- with: "permission denied to set parameter session_replication_role".
--
-- New approach needs no elevated privilege: delete the org's rows across every
-- org-scoped table in FK-safe order, discovered by a fixpoint loop. Each pass
-- deletes the tables whose child rows are already gone and retries the rest;
-- it converges for any FK DAG. A per-table sub-block catches foreign_key_violation
-- so a not-yet-deletable table is simply retried next pass. If a pass makes no
-- progress while rows remain (a genuine FK cycle/block), it raises rather than
-- silently leaving data behind.
--
-- DEPLOY (Mica): run this file in the SQL editor. No function redeploy — the
-- manage-client Edge Function calls delete_workspace() by name, so the new body
-- takes effect immediately.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create or replace function public.delete_workspace(p_org uuid, p_delete_users boolean default true)
returns void
language plpgsql security definer set search_path = public as $$
declare
  member_ids uuid[];
  remaining  text[];
  still      text[];
  t          text;
  progressed boolean;
  passes     int := 0;
begin
  if p_org is null then raise exception 'org id required'; end if;

  select array_agg(user_id) into member_ids from public.memberships where org_id = p_org;

  -- Every base table carrying an org_id (except organizations itself).
  select array_agg(c.table_name) into remaining
  from information_schema.columns c
  join information_schema.tables tt
    on tt.table_schema = c.table_schema and tt.table_name = c.table_name
   and tt.table_type = 'BASE TABLE'
  where c.table_schema = 'public'
    and c.column_name  = 'org_id'
    and c.table_name  <> 'organizations';

  -- Fixpoint delete: FK-safe order without disabling triggers.
  while remaining is not null and array_length(remaining, 1) > 0 and passes < 100 loop
    passes := passes + 1;
    progressed := false;
    still := '{}';
    foreach t in array remaining loop
      begin
        execute format('delete from public.%I where org_id = $1', t) using p_org;
        progressed := true;                         -- this table cleared this pass
      exception when foreign_key_violation then
        still := array_append(still, t);            -- children remain; retry next pass
      end;
    end loop;
    remaining := still;
    exit when not progressed;                        -- stuck → stop and report below
  end loop;

  if remaining is not null and array_length(remaining, 1) > 0 then
    raise exception 'delete_workspace: FK cycle or block, could not clear: %',
      array_to_string(remaining, ', ');
  end if;

  delete from public.organizations where id = p_org;

  -- Remove members whose only workspace was this one.
  if p_delete_users and member_ids is not null then
    delete from auth.users u
    where u.id = any(member_ids)
      and not exists (select 1 from public.memberships m where m.user_id = u.id);
  end if;
end $$;

revoke all on function public.delete_workspace(uuid, boolean) from public, anon, authenticated;

commit;
