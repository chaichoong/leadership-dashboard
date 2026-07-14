-- 0024_signup_provisioning.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Self-serve signup: when a new Supabase Auth user is created, automatically
-- provision their workspace so they land on a working BASE plan (not a blank DB):
--   • create their organization (name from signup metadata, else "<email>'s Workspace")
--   • add them as owner
--   • enable the 8 BASE modules, leave the 5 ADD-ONS off (bought later)
--   • seed starter "how to use the system" SOPs (a Getting-Started onboarding set;
--     each doubles as a checklist via the is_trained toggle)
--
-- Existing users (Kevin, Micaa) are unaffected — the trigger only fires on NEW
-- auth.users inserts.
--
-- Applying this migration only creates the function + trigger; it provisions
-- nobody. It takes effect on the next signup.
--
-- FOLLOW-UP: team invitations need their own token-based flow (a signup that
-- JOINS an existing org rather than creating one). Not handled here — a signup
-- with raw_user_meta_data.skip_provision='true' is left un-provisioned so an
-- invite flow can attach the membership itself.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- Provisioning logic, callable + testable independently of the auth trigger.
create or replace function public.provision_new_workspace(
  p_user uuid, p_email text, p_org_name text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_org  uuid;
  v_name text;
  k      text;
  ttl    text;
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

  return v_org;
end $$;

-- Thin trigger: fire provisioning on new signups (skippable for invite flows).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.raw_user_meta_data->>'skip_provision', 'false') = 'true' then
    return new;
  end if;
  perform public.provision_new_workspace(new.id, new.email, new.raw_user_meta_data->>'org_name');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

commit;
