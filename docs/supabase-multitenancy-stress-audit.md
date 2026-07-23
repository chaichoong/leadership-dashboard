# Supabase Multi-Tenancy Stress-Test — Findings

**Date:** 2026-07-22
**Scope:** Isolation of client-facing accounts in the Supabase project `ptkyhzlsvijcwyovgrgv.supabase.co` — i.e. can one client account see, change, or destroy another client's data?
**Method:** Static isolation audit of every migration (`0015`–`0037`), the three Edge Functions, and the client-side call sites, **plus a live two-tenant probe run against the project on 2026-07-22** (see [Live run](#live-run-2026-07-22) below). The earlier note that the probe "could not run" (no outbound network) no longer applies: a later session had egress to Supabase and ran `supabase-migration/stress-test/multitenancy-stress-test.mjs` in report-only mode. **It confirmed Finding 1's cross-tenant disclosure live** and confirmed the RLS data layer holds.

> ⚠️ **Why static isn't the whole story.** The schema spec (`docs/supabase-schema-spec.md`, Q1) records that migrations `0001`–`0014` were applied *outside* the repo (SQL editor). A table created directly in the dashboard would be invisible to this audit. The live harness is the only way to be certain. Treat this report as "confirmed from the code we can see," not "the live database is clean."

---

## Verdict

The **data layer** (Postgres row-level security) is well built and, for every table the repo can see, correctly isolates each workspace. **But the application layer above it is not.** Two Edge Functions treat "owner or admin of *any* workspace" as "platform operator" — and every client is provisioned as the **owner of their own workspace**. The result is that **any logged-in client can list, suspend, cancel, and permanently delete every other client's workspace**, and read every client's name and owner email.

This is a critical, exploitable cross-tenant breach. It is not in the RLS policies — it is in the Edge Functions that deliberately use the service-role key (which bypasses RLS) and then check the caller's permission incorrectly.

| # | Severity | Finding | Effect |
|---|----------|---------|--------|
| 1 | ✅ ~~🔴 Critical~~ **FIXED** | `manage-client` / `create-client` authorize any workspace owner/admin | Any client could delete/suspend/list **all** other tenants — **fixed & verified live 2026-07-22** (0038 + both fns deployed; probe P6 now 403) |
| 2 | ✅ ~~🟠 High~~ **FIXED (code)** | `app_settings` primary key is `(key)` not `(org_id, key)` | Second tenant's settings write collides/fails; per-tenant settings broken — **0039 + skills-shim onConflict; pending SQL run** |
| 3 | ✅ ~~🟡 Medium~~ **FIXED (code)** | `onboarding-submit` resolves the home workspace by a name the code disagrees on | Public onboarding intake may silently 500 for every client — **now resolves home org by earliest-created; pending fn redeploy** |
| 4 | 🟢 Note | Sync bridges stamp all mirrored rows with the home org | Not a leak; but client finance/AI-brain modules would receive no synced data |

The RLS foundation itself (findings below the line) **passed**: every repo-visible data table has `org_id`, `enable`+`force row level security`, an `org_isolation` policy (not `using (true)`), and all views are `security_invoker = on`.

---

## Live run (2026-07-22)

Ran `supabase-migration/stress-test/multitenancy-stress-test.mjs` against
`ptkyhzlsvijcwyovgrgv.supabase.co` in **report-only** mode with a service-role key
(used only to create two pre-confirmed throwaway tenants and to auto-delete them
afterwards — both throwaway orgs + users were removed; verified 0 residue, 1 real
org remains). The escalation half of P6 (suspend→delete) was **not** exercised, by
choice — it is still confirmed only by static reading, not live.

**Result: 20 passed, 1 FAILED.** The failure is Finding 1, reproduced live.

| Probe | Result | Detail |
|-------|--------|--------|
| Provisioning | ✅ | Two signups landed in distinct orgs (`6baff93d…`, `c315786a…`). |
| P1 baseline (11 tables) | ✅ | A fresh tenant saw **0** foreign rows across `transactions, tasks, crm_contacts, crm_deals, sops, team_members, tenancies, costs, properties, objectives_strategy, onboarding_submissions` (only its own 10 seeded SOPs + 1 team_member). |
| P2 cross-read | ✅ | B could not read A's seeded `crm_contacts` marker. |
| P3 cross-update / delete | ✅ | B's PATCH and DELETE of A's row affected **0 rows**. |
| P4 forged insert | ✅ | B inserting a row stamped with A's `org_id` was **rejected (403)** by the RLS `with check`. |
| P5 org enumeration | ✅ | B saw only its own workspace in `organizations`. |
| **P6 `manage-client` list** | ❌ | **Plain client B received the full workspace list — 2 tenants including owner emails. Cross-tenant disclosure confirmed live.** |
| Cleanup | ✅ | Both throwaway orgs + users deleted via `delete_workspace`. |

So on the live database: **the RLS row-isolation layer holds under direct attack
(P1–P5), and the `manage-client` Edge Function leaks every tenant's name + owner
email to any logged-in client (P6)** — exactly the authorization gap Finding 1
describes. The suspend/cancel/delete escalation on top of that same `list` gate
was not run live but shares the identical (missing) check.

> **Harness note:** `makeTenant()` was updated this run to create pre-confirmed
> users via the Auth **admin API** when a service-role key is present (the public
> signup path rejects the reserved `@example.com` domain with
> `email_address_invalid`, and would also stall if "Confirm email" were on). The
> `on_auth_user_created` trigger fires identically either way, so provisioning is
> unchanged.

---

## Finding 1 — 🔴 Critical: any client can destroy any other client's workspace

**Where:** `supabase-migration/supabase/functions/manage-client/index.ts`, `create-client/index.ts`
**Root cause:** the authorization check is "is the caller owner/admin of *some* workspace," but every client *is* the owner of their own.

### The chain
1. Every signup is provisioned as `role = 'owner'` of their own new workspace — `0024`/`0025`/`0028` (`provision_new_workspace`, line 38: `insert into memberships (…) values (v_org, p_user, 'owner')`).
2. There is **no** `staff` / `platform_admin` / provider-org concept anywhere in the schema (grep for `is_staff`, `platform_admin`, `staff` returns nothing).
3. `manage-client` authorizes the caller like this:
   ```ts
   const adminMems = (mems||[]).filter(m => m.role === 'owner' || m.role === 'admin')
   if (!adminMems.length) return json({ error: '…not allowed…' }, 403)   // every client passes
   ```
4. The only per-target guard is *"not your own workspace"*:
   ```ts
   if (callerOrgIds.has(orgId)) return json({ error: 'You cannot offboard your own workspace here.' }, 400)
   ```
   So a client is blocked from touching **their own** org — but explicitly *allowed* to target **any other** org id.

### What a malicious (or curious) client can do, authenticated with nothing but their normal login
- `action: 'list'` → `list_client_workspaces()` runs under the service role and returns **every** workspace's `id`, `name`, `plan`, `status`, **owner email**, and member count. The function filters out only the caller's own org, so the caller receives every *other* tenant — Kevin's included. **Cross-tenant information disclosure** (client names + owner emails of your whole book of business).
- `action: 'suspend'` / `'cancel'` on any other org id → bans that tenant's logins.
- `action: 'delete'` → only permitted when the target is `suspended`/`cancelled`, but the same caller can `suspend` it first. Chain: `list` → pick victim org id → `suspend(victim)` → `delete(victim)` = **permanent, irreversible wipe of another tenant's entire dataset and login accounts** (`delete_workspace` drops every org-scoped row and the auth users).
- `action: 'set_module'` on any other org id → turn other tenants' paid add-ons on/off.
- `create-client` (same flawed check) → any client can invite/create new accounts and trigger the GoHighLevel welcome-email webhook (spam / resource-exhaustion vector).

The database functions themselves are correctly locked (`revoke all … from public, anon, authenticated`) — they can only be reached through these Edge Functions, which run under the service role. So the Edge Function *is* the security boundary, and it is wrong.

### Fix (server-side — the real gate)
Introduce a real operator identity and check it in **both** Edge Functions.

**Option A (smallest, recommended): a `platform_admin` predicate keyed on the home/provider workspace.** The home workspace is the earliest-created org (already the convention used by `bridge_default_org_id()` in `0029`). Add a SECURITY DEFINER helper and gate on it:
```sql
create or replace function public.is_platform_admin(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = p_user
      and m.org_id = (select id from public.organizations order by created_at asc limit 1)
      and m.role in ('owner','admin')
  );
$$;
revoke all on function public.is_platform_admin(uuid) from public, anon, authenticated;
```
In `manage-client` and `create-client`, replace the `role in (owner,admin)` check with:
```ts
const { data: isAdmin } = await admin.rpc('is_platform_admin', { p_user: user.id })
if (!isAdmin) return json({ error: 'You are not allowed to manage client accounts.' }, 403)
```
Keep the `callerOrgIds.has(orgId)` guard as a nicety, but it is no longer the boundary.

**Option B (more explicit): a dedicated `platform_admins(user_id)` table** seeded with Kevin's (and Mica's) user id, checked the same way. Preferable long-term because it does not conflate "operator" with "owner of the first org," and survives the home org being renamed or re-created.

Either way: the `list` action must be behind the same operator check (it currently leaks all tenants to any owner).

### ✅ Resolution — implemented in code 2026-07-22 (Option A), pending deploy

- **`0038_platform_admin_gate.sql`** adds `is_platform_admin(uuid)` (SECURITY DEFINER, gated on owner/admin of the earliest-created / home org), revoked from `public, anon, authenticated` and granted to `service_role` — the same lock-down pattern as the lifecycle functions. Predicate verified on Postgres: home-org owner **and** admin → `true`; a client (owner of a later org) → `false`.
- **`manage-client/index.ts`** and **`create-client/index.ts`** now authorize via `admin.rpc('is_platform_admin', { p_user: user.id })` instead of the old "owner/admin of any workspace" test. `list` is behind the same gate, so it no longer leaks tenants to a client.

**✅ Deployed & verified live 2026-07-22.** Migration `0038` applied and both functions redeployed. The probe was re-run against the live project: **21 passed, 0 failed** — P6 flipped from ❌ to `✅ correctly denied (403) — operator gate is in place`. A plain client can no longer list or act on other tenants. Both throwaway test tenants were cleaned up (verified 0 residue).

---

## Finding 2 — 🟠 High: `app_settings` breaks for the second tenant onward

**Where:** `0016_app_settings.sql` (line 7) + the never-completed follow-up noted in `0022` (line 29: *"app_settings PK → (org_id, key), and update skills-shim upsert conflict target"*).

```sql
create table if not exists public.app_settings (
  key   text primary key,          -- ← global key, not per-tenant
  value text,
  …
);
```
`0022` added `org_id` and swapped this table onto the `org_isolation` policy, so **reads** are correctly isolated. But the **primary key is still `key` alone.** First consumer is the Skills Library ("active skill IDs"), which upserts on the key.

- Two workspaces cannot both hold the same key. When the *second* tenant upserts `key = 'active_skill_ids'`, the row already exists under the first tenant's `org_id` — invisible to the second under RLS — so the `on conflict (key)` upsert collides with a row it cannot see/modify and fails (or the plain insert violates the PK).
- Net effect: per-tenant app settings (Skills presets, and anything else that lands here) **silently break for every client after the first**. Not a data leak — a functional multi-tenancy failure.

### Fix (the outstanding `0022` follow-up)
```sql
alter table public.app_settings drop constraint app_settings_pkey;
alter table public.app_settings add primary key (org_id, key);
```
…and update the Skills shim's upsert `onConflict` target from `'key'` to `'org_id,key'` (`skills-shim.js`). Confirm no other writer relies on `key` being globally unique.

### ✅ Resolution — implemented in code 2026-07-22, pending SQL run

- **`0039_app_settings_per_tenant_pk.sql`**: backfills any NULL `org_id` to the home org, sets `org_id NOT NULL`, and swaps the global PK for `(org_id, key)`. Applied to a Postgres copy of the table: PK becomes `PRIMARY KEY (org_id, key)` and two orgs can then both hold `active_skill_ids` (the exact collision) — verified.
- **`skills-shim.js`**: the only `app_settings` writer; its upsert `onConflict` is now `'org_id,key'` (`org_id` fills from the column default). Cache-bust bumped to `?v=2` in `skills-supabase.html`. The existing sync-invariant test covers the Airtable settings path, not this Supabase upsert, so it is unaffected.
- **Deploy:** run `0039` in the SQL editor; the JS ships with the web app on merge to `main`. No Edge Function redeploy needed.

---

## Finding 3 — 🟡 Medium: onboarding intake may fail for every client (home-org name mismatch)

**Where:** `onboarding-submit/index.ts` line 23 vs the rest of the codebase.

`onboarding-submit` resolves the provider workspace by name:
```ts
const ORG_NAME = 'Operations Director Main'
… .from('organizations').select('id').eq('name', ORG_NAME) …
if (!org) return json({ error: 'Onboarding workspace is not set up yet.' }, 500)
```
But the home org is created as **`'Runpreneur'`** (`0022` line 113), and `0023`/`0025`/`0026` all look it up by `'Runpreneur'`. Meanwhile `0028` (line 76) and this function use `'Operations Director Main'`. **The code disagrees with itself about the home workspace's name.**

- If the live org is still named `Runpreneur`, every public onboarding submission 500s and no CRM contact/deal is created.
- If it was renamed to `Operations Director Main` in the live DB (which `0028` + this function imply), then `onboarding-submit` works but the older name references are dead — and, more importantly, **this can only be resolved by looking at the live database**, which reinforces the need for the live harness / a service-role check.

### Fix
Stop resolving the home org by a hardcoded name. Use the same convention as `bridge_default_org_id()` — the earliest-created org — or a single shared constant sourced in one place. Then verify the live org's actual name and reconcile the two spellings across the codebase.

### ✅ Resolution — implemented in code 2026-07-22, pending fn redeploy

`onboarding-submit/index.ts` now resolves the home org as the **earliest-created org** (`order('created_at', { ascending: true }).limit(1)`), the same convention as `bridge_default_org_id()` / `is_platform_admin()` — no hardcoded name, so a rename can't 500 the intake. The `ORG_NAME` constant is removed.

**Note (not blocking):** the historical *migrations* still disagree on the home org's spelling (`Runpreneur` in 0022–0026 vs `Operations Director Main` in 0028) — those are already-applied files that don't re-run, so they're left as-is; only live code paths mattered. **Deploy:** `supabase functions deploy onboarding-submit --no-verify-jwt`.

---

## Finding 4 — 🟢 Note (not a leak): sync bridges pool all mirrored data into the home org

`0029` changed `bridge_default_org_id()` to always return the home (earliest) org, so the service-role Transactions and AI-Brain sync bridges stamp every mirrored row with the home org. This is correct for *isolation* (a client never sees Kevin's synced data), and correct today (only Kevin's finance module is live). But it means that if a client ever has the Finance or AI-Brain module enabled, the bridges have no per-tenant routing and their data would not arrive. Flagging as a design follow-up for when a second tenant goes live on those modules, not a security issue.

---

## What passed (the RLS foundation is sound)

For every data table visible in the repo:

- `org_id uuid` column present, indexed, defaulted to `coalesce(current_org_id(), bridge_default_org_id())`.
- `enable row level security` **and** `force row level security` (owner is not exempt).
- Exactly one `org_isolation` policy: `using (is_org_member(org_id)) with check (is_org_member(org_id))` — the old blanket `authenticated_all using (true)` was dropped on all 32 pre-`0022` tables and never reintroduced on the newer ones (`crm_*` `0025`, `meetings` `0030`, `onboarding_submissions` `0032`).
- `is_org_member()` / `current_org_id()` are `security definer` with a pinned `search_path`, so policies don't recurse and can't be shadowed by a caller's search path.
- All views are `security_invoker = on`, so they honour the underlying table RLS rather than running as the definer.
- Workspace tables (`organizations`, `memberships`, `org_modules`) are `force`d and readable only for your own membership.
- Lifecycle SQL functions (`suspend/cancel/restore/delete_workspace`, `list_client_workspaces`, `workspace_owner_email`) all `revoke all … from public, anon, authenticated` — unreachable by a client-side key. (Their gatekeeper is the Edge Function — see Finding 1.)
- The one previously-shipped leak (`0029`: sync bridges writing `NULL` org_id → rows invisible to everyone) is already fixed and back-filled.

---

## Recommended order of work

1. **Finding 1 first** — it is a live, catastrophic breach. Add `is_platform_admin` (or a `platform_admins` table), gate both Edge Functions and the `list` action on it, redeploy.
2. Run the harness (`supabase-migration/stress-test/README.md`) from a networked machine to (a) confirm Finding 1 pre-fix, (b) confirm it's closed post-fix, and (c) surface any out-of-repo table this static audit couldn't see.
3. **Finding 2** — `app_settings` PK migration + shim conflict-target change.
4. **Finding 3** — unify home-org resolution; verify the live org name.

Remediation tasks are not slotted into `MASTER-PLAN.md` here — per the project's one-plan rule, Kevin approves them into the plan.
