# Supabase Multi-Tenant Schema Spec

Status: authored 7 Jul 2026 (Fable session). Depends on Kevin's D1/D2/D6/D9 decisions (PRODUCTISATION.md §5). Execution tasks live in MASTER-PLAN.md §4; do not plan from this file.

## Part 1 — Mica's migration: verified current state (7 Jul 2026)

Verified from the repo (commits 3-7 Jul, author Mica A) and Slack (30 Jun status):

- Architecture: parallel shadow build. Each page has a `*-supabase.html` twin + boot/shim JS. The shim intercepts `fetch`, redirects Airtable REST calls to Supabase, and returns Airtable-shaped records (field-ID keyed), so feature JS runs unchanged. Un-migrated tables return empty rather than erroring.
- Project: `ptkyhzlsvijcwyovgrgv.supabase.co`. Frontend: `leadership-dashboard-gamma.vercel.app`, whose root serves `supabase-app.html` (Supabase Auth login + iframe router).
- 10 pages routed: dashboard, strategy, plan builder, AI brain, tasks, operations, comms, systemisation, money, skills. Finance pages (cashflow, reconciliation, invoices, P&L, transactions, AR/AP), CFV, compliance, wealth, fintable, team are NOT yet on the shell.
- Data sync: hourly Transactions mirror + nightly AI Brain mirror (GitHub Actions). Airtable remains system of record; Supabase is read-through.
- Repo has migrations 0015-0018 only (systemisation, app_settings, objectives_strategy, ai_brain).

**Judgement:** the shim approach is the right migration vehicle. It converts a 2-week rebuild into page-at-a-time cutover with zero UI rewrite. Do not redesign it. The multi-tenant layer is ADDITIVE on top.

### Questions only Mica can answer (team meeting, 8 Jul)
1. Where do migrations 0001-0014 live, and how were they applied (SQL editor vs CLI)? We need them in the repo for reproducibility.
2. Is RLS enabled on any table yet? What can the client-side anon key currently read? (If RLS is off, the anon key in the HTML exposes every mirrored row to anyone with the URL — check TODAY.)
3. Which tables have full row parity with Airtable vs partial/stale copies? Is anything besides Transactions + AI Brain auto-syncing, or were the others one-off imports?
4. Supabase Auth: which users exist; email/password only or magic link; is signup open or invite-only?
5. What is her intended next page, so the plan sequences around it rather than double-assigning?
6. What was the AI usage limit blocking her, and does she still hit it? (Affects who does which build tasks.)

## Part 2 — Target multi-tenant architecture (the decision layer)

Strategy: **mirror-first, normalise-later.** Phase M (now→launch): Kevin's tenant only, tables as Airtable-shaped mirrors, tenancy + security added NOW while tables are young. Phase N (post-launch, per module, via the queue): normalise hot tables into proper columns when a real client's usage justifies it.

### 2.1 Tenancy spine (new tables, Opus writes the SQL)
- `tenants` — id uuid pk, name, slug, plan (text: 'dod_base' | future module flags), status (trial/active/paused/churned), stripe_customer_id, created_at.
- `tenant_users` — tenant_id fk, user_id (auth.users), role ('owner'|'team'|'claude'), invited_by, created_at. Unique (tenant_id, user_id).
- `tenant_config` — tenant_id fk, key text, value jsonb. Holds everything on the de-Kevining checklist: identity, team, thresholds, AI voice (D2 mentor prompt), module toggles, label taxonomy. One row per key; this IS the onboarding wizard's write target.
- `entities` (D1) — tenant_id, id, type ('customer'|'supplier'|'partner'|'other'), name, contact jsonb, fields jsonb, created_at. The CRM spine.
- `team_members` (from parked May audit) — tenant_id, name, first_name, email, slack_user_id, type ('internal'|'contractor'), active, auto_collaborator. Replaces 6 hardcoded arrays.
- `ai_usage_log` (D9) — tenant_id, feature, model, tokens_in, tokens_out, cost_estimate, created_at.
- `agent_activity` — port of Airtable Agent Activity table when the runner moves server-side (Phase C of agent work); add tenant_id from day one.

### 2.2 Retrofit rule for existing mirror tables
Every existing table (transactions, ai_brain_today, systemisation set, objectives, app_settings, + all future mirrors):
1. Add `tenant_id uuid not null default '<kevin-tenant-uuid>'` — one ALTER per table, zero code change (shims scope by tenant via RLS, not query changes).
2. Enable RLS: `USING (tenant_id in (select tenant_id from tenant_users where user_id = auth.uid()))` for select/insert/update/delete. Service-role key (GitHub Actions mirrors) bypasses RLS by design.
3. Index (tenant_id) or extend existing pks to composite where needed.

### 2.3 Auth + access rules
- Invite-only signup (productised service — Kevin provisions tenants; no self-serve).
- Roles: owner (client founder), team (client staff), plus Kevin's operator access via a `staff` boolean on tenant_users or a dedicated operations tenant-crossing role — DECISION: simplest safe = Kevin's user gets a tenant_users row per client tenant, role 'owner'. No cross-tenant super-role in v1 (fewer RLS mistakes).
- The anon key stays client-side (normal for Supabase) — safe ONLY once RLS is on every table. This is the single most urgent schema task.

### 2.4 Derived fields (D6)
Computed values = Postgres views (e.g. `v_costs_with_totals`), never write-back columns. Shims can read views where the page expects computed fields.

### 2.5 Module gating
`tenant_config` key `modules` = jsonb {finance: bool, comms: bool, content: bool, wealth: bool, property: bool}. Shell router reads it to show/hide pages. Phase-2 pricing turns these on per Stripe webhook.

### 2.6 What does NOT change now
- No normalisation of mirror tables pre-launch.
- Airtable stays system of record until a module's page is verified on Supabase AND its write path lands (shims currently read-through; write path per-module cutover, tasks first — Mica's Tasks & Projects clone is furthest along).
- GitHub Pages app remains the live product until cutover; Vercel build is the staging/dogfood target.

### Sequencing (feeds master plan)
S1. RLS audit + enable on all existing tables (URGENT, security).
S2. Migrations 0001-0014 recovered into repo.
S3. Tenancy spine tables (2.1) + retrofit (2.2).
S4. D1 entities + D2 mentor-prompt config + wizard write target.
S5. Page-at-a-time: finish shell coverage (Finance set next) — Mica continues.
S6. Write-path cutover per module (tasks first) + parity checks.
S7. Agent runner reads Supabase (Phase C pairing).
