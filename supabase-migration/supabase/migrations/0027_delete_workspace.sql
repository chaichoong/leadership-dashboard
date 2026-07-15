-- 0027_delete_workspace.sql
-- Admin helper to fully delete a workspace (tenant) — its data across every
-- org-scoped table, the org row, and (optionally) its members' logins if they
-- belong to no other workspace. Bypasses FK ordering via session_replication_role
-- so it works regardless of inter-table dependencies.
--
-- Usage:  select public.delete_workspace('<org-uuid>');
-- Safety: this is irreversible. Only call with a workspace id you intend to wipe.

create or replace function public.delete_workspace(p_org uuid, p_delete_users boolean default true)
returns void
language plpgsql security definer set search_path = public as $$
declare
  t text;
  member_ids uuid[];
begin
  if p_org is null then raise exception 'org id required'; end if;
  select array_agg(user_id) into member_ids from public.memberships where org_id = p_org;

  set local session_replication_role = 'replica';   -- suspend FK checks for a clean wipe
  for t in
    select c.table_name from information_schema.columns c
    where c.table_schema = 'public' and c.column_name = 'org_id' and c.table_name <> 'organizations'
  loop
    execute format('delete from public.%I where org_id = $1', t) using p_org;
  end loop;
  delete from public.organizations where id = p_org;
  set local session_replication_role = 'origin';

  -- Remove members whose only workspace was this one.
  if p_delete_users and member_ids is not null then
    delete from auth.users u
    where u.id = any(member_ids)
      and not exists (select 1 from public.memberships m where m.user_id = u.id);
  end if;
end $$;

revoke all on function public.delete_workspace(uuid, boolean) from public, anon, authenticated;
