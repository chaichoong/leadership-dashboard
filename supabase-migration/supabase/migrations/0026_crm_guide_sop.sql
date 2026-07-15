-- 0026_crm_guide_sop.sql
-- Adds a "How to use the CRM" starter SOP that links the illustrated guide
-- (crm-guide.html) via sop_video. Extends provision_new_workspace so every new
-- signup gets it, and backfills it for the existing Runpreneur workspace.

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

  foreach ttl in array starter_sops loop
    insert into public.sops (id, title, sop_status, sop_type, is_trained, org_id)
    values (public.new_id(), ttl, 'Live', 'Getting Started', false, v_org);
  end loop;
  -- Module guide SOP with a link to the illustrated guide.
  insert into public.sops (id, title, sop_status, sop_type, sop_video, is_trained, org_id)
  values (public.new_id(), 'How to use the CRM', 'Live', 'Getting Started', guide_url, false, v_org);

  perform public.seed_default_pipeline(v_org);
  return v_org;
end $$;

-- Backfill the CRM guide SOP for the existing Runpreneur workspace (once).
do $$
declare v_org uuid;
  guide_url text := 'https://chaichoong.github.io/leadership-dashboard/crm-guide.html';
begin
  select id into v_org from public.organizations where name = 'Runpreneur' order by created_at limit 1;
  if v_org is not null and not exists (
       select 1 from public.sops where org_id = v_org and title = 'How to use the CRM') then
    insert into public.sops (id, title, sop_status, sop_type, sop_video, is_trained, org_id)
    values (public.new_id(), 'How to use the CRM', 'Live', 'Getting Started', guide_url, false, v_org);
  end if;
end $$;

commit;
