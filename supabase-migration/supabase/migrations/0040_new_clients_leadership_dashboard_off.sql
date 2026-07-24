-- 0040_new_clients_leadership_dashboard_off.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- The Leadership Dashboard (command_centre) becomes an opt-out feature, like
-- Plan Builder: NOT part of the base plan for brand-new clients, but toggleable
-- on per client from the CRM client screen.
--
-- Mechanism (identical to plan_builder): the shell treats command_centre as
-- "on unless an org_modules row says enabled=false". So we seed each NEW workspace
-- with command_centre=false. Absence of a row still means ON, so:
--   • EXISTING clients (seeded command_centre=true by earlier provisioning) keep
--     the Leadership Dashboard — unchanged.
--   • The system-owner workspace "Operations Director Main" keeps it (it has a
--     command_centre=true row and is never seeded off / never togglable as a
--     client).
--   • NEW clients get command_centre=false → hidden until an admin ticks it on.
--
-- Only redefines provision_new_workspace (same body as 0037; command_centre moves
-- from the base seed to the opt-out seed). Provisions nobody; takes effect on the
-- next signup.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create or replace function public.provision_new_workspace(
  p_user uuid, p_email text, p_org_name text default null, p_member_name text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org  uuid;
  v_name text;
  v_member text;
  k      text;
  ttl    text;
  guide_url text := 'https://chaichoong.github.io/leadership-dashboard/crm-guide.html';
  base_mods  text[] := array['strategy','tasks','team',
                             'systemisation','ai_assistant','dod_queue','crm'];
  addon_mods text[] := array['finance','inbound_comms','content_machine',
                             'personal_wealth','property'];
  -- Base features that ship OFF for new clients but can be toggled on per client.
  optout_mods text[] := array['plan_builder','command_centre'];
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
  v_name   := coalesce(nullif(p_org_name, ''), split_part(p_email, '@', 1) || '''s Workspace');
  -- The self team-member is the PERSON; fall back to the company name if unknown.
  v_member := coalesce(nullif(p_member_name, ''), v_name);

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
  -- assigned to them). Display name is the person; they can edit it in Team Members.
  insert into public.team_members (id, org_id, member, member_email, work_email, active, status, weekly_capacity)
  values (public.new_id(), v_org, v_member, lower(p_email), lower(p_email), true, 'Active', 40);

  perform public.seed_default_pipeline(v_org);
  return v_org;
end $$;

commit;

-- ── VERIFY ───────────────────────────────────────────────────────────────────
-- After the next signup the new org should have command_centre disabled, while
-- existing clients and 'Operations Director Main' keep their command_centre=true:
--   select o.name, m.enabled
--   from public.org_modules m join public.organizations o on o.id = m.org_id
--   where m.module_key = 'command_centre' order by o.created_at desc limit 5;
