-- 0039_app_settings_per_tenant_pk.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY/CORRECTNESS FIX — stress-test Finding 2 (🟠 High). The outstanding
-- 0022 follow-up ("app_settings PK → (org_id, key)").
--
-- 0016 created app_settings with `key` as the SOLE primary key. 0022 added org_id
-- and put the table on org_isolation RLS, so READS are per-tenant — but the PK is
-- still global. So the first tenant to write `key = 'active_skill_ids'` owns that
-- key for the whole database: when the SECOND tenant upserts the same key, its
-- row already exists under the first tenant's org_id (invisible to it under RLS),
-- and the insert collides with the global PK. Per-tenant app settings therefore
-- break silently for every client after the first.
--
-- Fix: make the key per-tenant — PK (org_id, key). The Skills shim's upsert
-- conflict target is updated to 'org_id,key' in the same change (skills-shim.js).
--
-- Safe: only one org exists today and 0029 already backfilled org_id, so no
-- (org_id, key) collisions exist. We still backfill + NOT NULL defensively.
--
-- DEPLOY (Mica): run this file in the SQL editor (or `supabase db push`). No
-- function redeploy needed; the skills-shim.js change ships with the web app.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- Any stray NULL org_id → home org (matches bridge_default_org_id / 0029 backfill).
update public.app_settings
   set org_id = public.bridge_default_org_id()
 where org_id is null;

alter table public.app_settings alter column org_id set not null;

-- Swap the global PK for a per-tenant one. Drop whatever the current PK is named,
-- then add (org_id, key).
do $$
declare pk text;
begin
  select conname into pk from pg_constraint
   where conrelid = 'public.app_settings'::regclass and contype = 'p';
  if pk is not null then
    execute format('alter table public.app_settings drop constraint %I', pk);
  end if;
end $$;

alter table public.app_settings add constraint app_settings_pkey primary key (org_id, key);

commit;

-- ── VERIFY (read-only; run after commit) ─────────────────────────────────────
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.app_settings'::regclass and contype = 'p';   -- PK (org_id, key)
