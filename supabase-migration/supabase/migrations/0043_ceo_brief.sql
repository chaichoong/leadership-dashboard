-- 0043_ceo_brief.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Per-tenant CEO Brief. One row per workspace per day: the "one thing", the
-- first step, what was handed off, the board's flags and the money light.
--
-- WHO WRITES IT: the Cloudflare worker `ceo-brief-tenants` (service key, which
-- bypasses RLS). Authenticated members only READ their own org's rows. There is
-- deliberately NO insert/update policy for authenticated: the page never writes
-- a brief, so a bug or a bad actor in the browser cannot forge one.
--
-- WHERE THE SETUP LIVES: app_settings, key = 'ceo_brief', value = JSON text
-- (the shape is js/ceo-brief-defaults.mjs). Members write it from the Setup tab
-- on ceo-brief-supabase.html. app_settings already carries org_isolation for
-- all operations with a per-tenant PK (org_id, key) from 0039, so no new policy
-- is needed there.
--
-- MODULE KEY: 'ceo_brief' is an OPT-OUT module (like plan_builder). No
-- org_modules row is needed to show it; a row with enabled=false hides it.
-- The shell (supabase-app.html OPT_OUT_MODULES) and the manage-client function
-- (OPTOUT_MODULES) both list it.
--
-- DEPLOY (Mica):
--   1. Run this file in the SQL editor (or `supabase db push`).
--   2. supabase functions deploy manage-client
--   3. Deploy the worker:
--        npx wrangler deploy -c workers/ceo-brief-tenants/wrangler.toml
--      then set its secrets: SUPABASE_SERVICE_KEY, PROXY_TOKEN, TRIGGER_KEY
--        npx wrangler secret put SUPABASE_SERVICE_KEY -c workers/ceo-brief-tenants/wrangler.toml
--        npx wrangler secret put PROXY_TOKEN         -c workers/ceo-brief-tenants/wrangler.toml
--        npx wrangler secret put TRIGGER_KEY         -c workers/ceo-brief-tenants/wrangler.toml
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.ceo_briefs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade
                default coalesce(public.current_org_id(), public.bridge_default_org_id()),
  brief_date    date not null,
  one_thing     text,
  first_step    text,
  why           text,
  ignore_today  text,          -- one item per line
  board_flags   text,          -- one flag per line
  handed_off    text,          -- one hand-off per line
  money_light   text,          -- green | amber | red | null
  safe_to_act   numeric,
  full_brief    jsonb,         -- the complete brief as the CEO produced it
  huddle        jsonb,         -- the board's reports that fed the brief
  fallback      boolean not null default false,   -- true = the brief failed, money message sent instead
  source_stats  jsonb,         -- what the worker read (task count, calendar events, ...)
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (org_id, brief_date)
);

-- updated_at auto-touch (reuse the shared helper if it exists, as 0025 does)
do $$ begin
  if exists (select 1 from pg_proc where proname = 'tg_set_updated_at') then
    execute 'drop trigger if exists set_updated_at on public.ceo_briefs';
    execute 'create trigger set_updated_at before update on public.ceo_briefs
             for each row execute function public.tg_set_updated_at()';
  end if;
end $$;

create index if not exists idx_ceo_briefs_org_date on public.ceo_briefs(org_id, brief_date desc);

alter table public.ceo_briefs enable row level security;
alter table public.ceo_briefs force row level security;

-- Members READ their own org's briefs. No insert/update/delete policy on purpose:
-- the service-role worker is the only writer.
drop policy if exists org_read on public.ceo_briefs;
create policy org_read on public.ceo_briefs
  for select to authenticated
  using (public.is_org_member(org_id));

grant select on public.ceo_briefs to authenticated;

commit;

-- ── VERIFY (read-only; run after commit) ─────────────────────────────────────
-- select count(*) as tbl from information_schema.tables
--   where table_schema='public' and table_name='ceo_briefs';                 -- 1
-- select polname, cmd from pg_policies
--   where schemaname='public' and tablename='ceo_briefs';                    -- org_read, SELECT only
-- select relforcerowsecurity from pg_class where relname='ceo_briefs';      -- t
-- select privilege_type from information_schema.role_table_grants
--   where table_name='ceo_briefs' and grantee='authenticated';               -- SELECT only
-- select org_id, brief_date, one_thing, fallback from public.ceo_briefs
--   order by brief_date desc limit 5;                                        -- empty until the worker runs
