-- 0035_cancel_workspace.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Splits the workspace lifecycle into three states (0033 had two):
--   active     — normal.
--   suspended  — TEMPORARY hold (e.g. non-payment). Login off, data kept. No CRM
--                change — they are still a live client on pause.
--   cancelled  — CHURNED. Login off, data kept. The Edge Function also marks their
--                CRM deal "Lost — Cancelled". Reversible (reactivate) or deletable.
--
-- cancel_workspace mirrors suspend_workspace (0033) but sets status='cancelled'.
-- restore_workspace (0033) already returns either state to 'active' and unbans
-- logins, so it serves as the "reactivate" for both. delete_workspace (0034) is
-- unchanged; the Edge Function now permits delete from suspended OR cancelled.
--
-- DEPLOY (Mica): run this file in the SQL editor, then redeploy manage-client.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create or replace function public.cancel_workspace(p_org uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_org is null then raise exception 'org id required'; end if;

  update public.organizations
     set status = 'cancelled', suspended_at = coalesce(suspended_at, now())
   where id = p_org;

  -- Disable login for members whose ONLY workspace is this one.
  update auth.users u
     set banned_until = 'infinity'
   where u.id in (select user_id from public.memberships where org_id = p_org)
     and not exists (
       select 1 from public.memberships m
       where m.user_id = u.id and m.org_id <> p_org
     );
end $$;

revoke all on function public.cancel_workspace(uuid) from public, anon, authenticated;

commit;

-- ── VERIFY ───────────────────────────────────────────────────────────────────
-- select proname from pg_proc where proname = 'cancel_workspace';   -- 1 row
