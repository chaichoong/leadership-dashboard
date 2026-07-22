-- 0038_platform_admin_gate.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY FIX — stress-test Finding 1 (🔴 Critical), confirmed live 2026-07-22.
--
-- manage-client and create-client authorized the caller as "owner/admin of SOME
-- workspace". But every client is provisioned as the OWNER of their own workspace
-- (provision_new_workspace), so that check passed for everyone. Through those two
-- service-role Edge Functions a plain client could therefore:
--   • list every tenant (names + owner emails)          ← disclosure (reproduced live)
--   • suspend / cancel / delete any other tenant         ← destruction
--   • flip any other tenant's paid modules on/off
--   • create accounts + trigger the GHL welcome webhook
--
-- Root cause is authorization, not RLS — the DB functions are correctly revoked
-- from client roles; the Edge Functions (service role) were the boundary and the
-- boundary was wrong.
--
-- The fix: a real operator predicate. The provider/home workspace is the
-- earliest-created org — the same convention bridge_default_org_id() uses (0029).
-- A platform admin is an owner/admin of THAT org. Clients own only their own,
-- later, org, so they fail the check. Both Edge Functions now gate on this.
--
-- SECURITY DEFINER + revoked from client roles (same lock-down as the workspace
-- lifecycle functions in 0027/0033/0035); the Edge Functions reach it under the
-- service role, which keeps its default execute grant.
--
-- DEPLOY (Mica):
--   1. Run this file in the SQL editor (or `supabase db push`).
--   2. Redeploy BOTH gated functions (JWT verification ON — do NOT pass
--      --no-verify-jwt):
--        supabase functions deploy manage-client
--        supabase functions deploy create-client
--   3. Confirm the fix — the probe's P6 must now DENY a plain client (403):
--        node supabase-migration/stress-test/multitenancy-stress-test.mjs
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create or replace function public.is_platform_admin(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = p_user
      and m.org_id = (select id from public.organizations order by created_at asc limit 1)
      and m.role in ('owner', 'admin')
  );
$$;

-- Client-facing roles must never call this directly; the Edge Functions invoke it
-- under the service role (which retains its execute grant, exactly like
-- delete_workspace / suspend_workspace do after the same revoke).
revoke all on function public.is_platform_admin(uuid) from public, anon, authenticated;
grant execute on function public.is_platform_admin(uuid) to service_role;

commit;

-- ── VERIFY (read-only; run after commit) ─────────────────────────────────────
-- Home-org owner/admin (Kevin, Micaa) → true; every client owner → false:
--   select u.email, public.is_platform_admin(u.id)
--     from auth.users u order by u.created_at;
