-- 0028_provision_self_team_member.sql
-- A new signup should be a team member of their own workspace, so tasks can be
-- assigned to them (incl. self-assignment). Adds a team_members row for the new
-- user in provision_new_workspace, and backfills existing client workspaces that
-- are missing their owner as a member.

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

-- Backfill: add the owner as a team member for any CLIENT workspace that doesn't
-- already have them (excludes the home/owner workspace, which manages its own team).
do $$
declare r record;
begin
  for r in
    select o.id as org_id, o.name as org_name, u.email as email
    from public.organizations o
    join public.memberships m on m.org_id = o.id and m.role = 'owner'
    join auth.users u on u.id = m.user_id
    where o.name <> 'Operations Director Main'
      and not exists (
        select 1 from public.team_members t
        where t.org_id = o.id and lower(t.member_email) = lower(u.email))
  loop
    insert into public.team_members (id, org_id, member, member_email, work_email, active, status, weekly_capacity)
    values (public.new_id(), r.org_id, r.org_name, lower(r.email), lower(r.email), true, 'Active', 40);
  end loop;
end $$;

commit;
