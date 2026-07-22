-- 0037_provision_person_name.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- When a client is created (deal → Won → create-client), two names matter:
--   • the COMPANY name (org_name) — the workspace label shown in the sidebar,
--   • the PERSON's name (full_name) — the human, shown on the "who am I" pill and
--     used for the client's own team-member row so tasks read as their name, not
--     the business.
--
-- Until now provision_new_workspace only received the company name and used it for
-- BOTH the org and the self team-member. create-client now also stores full_name
-- in user metadata; this migration threads it through so the self team-member gets
-- the person's name (falling back to the company name when no person name exists).
--
-- Changes:
--   • provision_new_workspace gains a p_member_name arg; team_members.member uses
--     it (fallback = org/company name). Everything else is unchanged from 0036.
--   • handle_new_user passes raw_user_meta_data->>'full_name' through.
--
-- Existing clients are unaffected (function change only; provisions nobody). It
-- takes effect on the next client creation.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- Drop the old 3-arg version so only the name-aware signature remains.
drop function if exists public.provision_new_workspace(uuid, text, text);

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

-- Thin trigger: now also passes the person's name (full_name) through.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.raw_user_meta_data->>'skip_provision', 'false') = 'true' then
    return new;
  end if;
  perform public.provision_new_workspace(
    new.id, new.email,
    new.raw_user_meta_data->>'org_name',
    new.raw_user_meta_data->>'full_name'
  );
  return new;
end $$;

commit;

-- ── VERIFY ───────────────────────────────────────────────────────────────────
-- After the next client creation, the self team-member should carry the person's
-- name while the organization keeps the company name:
--   select o.name as company, t.member as person
--   from public.team_members t join public.organizations o on o.id = t.org_id
--   order by t.created_at desc limit 5;
