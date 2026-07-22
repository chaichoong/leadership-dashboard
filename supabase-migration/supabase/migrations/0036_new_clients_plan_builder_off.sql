-- 0036_new_clients_plan_builder_off.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Plan Builder should NOT ship in the base plan for brand-new clients: a new
-- signup starts with it switched OFF, and it can be turned back on per client
-- from the CRM client screen (the plan_builder opt-out toggle).
--
-- Mechanism: the shell (supabase-app.html) treats plan_builder as "on unless an
-- org_modules row says enabled=false". So we seed each NEW workspace with a
-- plan_builder row set to false. Absence of a row still means ON, so:
--   • EXISTING clients (no row) keep Plan Builder — unchanged.
--   • The system-owner workspace "Operations Director Main" is NOT created via
--     this signup path, so it is never seeded off and always keeps Plan Builder
--     (and every other feature).
--   • NEW clients get plan_builder=false → hidden until an admin ticks it on.
--
-- This only redefines provision_new_workspace (same body as 0028 plus the one
-- opt-out seed). It provisions nobody; it takes effect on the next signup.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create or replace function public.provision_new_workspace(
  p_user uuid, p_email text, p_org_name text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org  uuid;
  v_name text;
  k      text;
  ttl    text;
  guide_url text := 'https://chaichoong.github.io/leadership-dashboard/crm-guide.html';
  base_mods  text[] := array['command_centre','strategy','tasks','team',
                             'systemisation','ai_assistant','dod_queue','crm'];
  addon_mods text[] := array['finance','inbound_comms','content_machine',
                             'personal_wealth','property'];
  -- Base features that ship OFF for new clients but can be toggled on per client.
  optout_mods text[] := array['plan_builder'];
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
  foreach k in array optout_mods loop
    insert into public.org_modules (org_id, module_key, enabled) values (v_org, k, false)
    on conflict (org_id, module_key) do nothing;
  end loop;

  foreach ttl in array starter_sops loop
    insert into public.sops (id, title, sop_status, sop_type, is_trained, org_id)
    values (public.new_id(), ttl, 'Live', 'Getting Started', false, v_org);
  end loop;
  insert into public.sops (id, title, sop_status, sop_type, sop_video, is_trained, org_id)
  values (public.new_id(), 'How to use the CRM', 'Live', 'Getting Started', guide_url, false, v_org);

  -- The new user is the first member of their own workspace (so tasks can be
  -- assigned to them). Their display name defaults to the workspace name; they
  -- can edit it in Team Members.
  insert into public.team_members (id, org_id, member, member_email, work_email, active, status, weekly_capacity)
  values (public.new_id(), v_org, v_name, lower(p_email), lower(p_email), true, 'Active', 40);

  perform public.seed_default_pipeline(v_org);
  return v_org;
end $$;

commit;

-- ── VERIFY ───────────────────────────────────────────────────────────────────
-- After the next signup, the new org should have plan_builder disabled:
--   select o.name, m.enabled
--   from public.org_modules m join public.organizations o on o.id = m.org_id
--   where m.module_key = 'plan_builder' order by o.created_at desc limit 5;
-- Existing clients (and 'Operations Director Main') have NO plan_builder row → on.
