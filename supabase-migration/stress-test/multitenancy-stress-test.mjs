#!/usr/bin/env node
// multitenancy-stress-test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Live two-tenant isolation probe for the Operations Director Supabase project.
// Proves whether one client-facing account can see, change, or destroy another's
// data. Read supabase-migration/stress-test/README.md before running.
//
// SAFE BY DEFAULT:
//   • Creates TWO throwaway tenants (A and B) and probes only those two against
//     each other. It never suspends/cancels/deletes a real workspace.
//   • The destructive escalation probes (suspend/delete via the manage-client
//     Edge Function) target ONLY throwaway tenant A, called BY throwaway tenant B.
//     They are gated behind --run-destructive; without it they run in report-only
//     mode (they call `list` and report what leaks, but perform no suspend/delete).
//   • Cleanup deletes only the two throwaway orgs — and only if you pass a
//     service-role key (--service-key or SB_SERVICE_KEY). With just the anon key
//     it prints the two org ids and the manual cleanup SQL instead.
//
// Zero dependencies — Node 18+ (global fetch). If Node < 18, use --node-fetch.
//
// Usage:
//   node multitenancy-stress-test.mjs \
//     [--url https://<ref>.supabase.co] [--anon <anon-key>] \
//     [--service-key <service-role-key>]        # only for full auto-cleanup
//     [--run-destructive]                        # actually exercise suspend/delete on tenant A
//     [--keep]                                   # skip cleanup (inspect the tenants after)
//
// Defaults read the anon key + url from ../../supabase-app.html if not supplied.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

// ── resolve URL + anon key (from flags, env, or the committed app shell) ───────
function fromAppShell() {
  try {
    const html = readFileSync(resolve(__dirname, '../../supabase-app.html'), 'utf8')
    const url = html.match(/SUPABASE_URL\s*=\s*'([^']+)'/)?.[1]
    const anon = html.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/)?.[1]
    return { url, anon }
  } catch { return {} }
}
const shell = fromAppShell()
const URL = opt('--url', process.env.SB_URL || shell.url)
const ANON = opt('--anon', process.env.SB_ANON_KEY || shell.anon)
const SERVICE = opt('--service-key', process.env.SB_SERVICE_KEY || null)
const RUN_DESTRUCTIVE = flag('--run-destructive')
const KEEP = flag('--keep')

if (!URL || !ANON) {
  console.error('✖ Could not resolve Supabase URL / anon key. Pass --url and --anon.')
  process.exit(2)
}

// ── tiny PostgREST / GoTrue client over fetch ─────────────────────────────────
const stamp = Date.now()
const results = []
const pass = (name, detail = '') => { results.push({ ok: true, name, detail }); console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`) }
const fail = (name, detail = '') => { results.push({ ok: false, name, detail }); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
const warn = (name, detail = '') => { results.push({ ok: null, name, detail }); console.log(`  ⚠️  ${name}${detail ? ' — ' + detail : ''}`) }

async function rest(path, { token, method = 'GET', body, prefer } = {}) {
  const headers = { apikey: ANON, Authorization: `Bearer ${token || ANON}`, 'Content-Type': 'application/json' }
  if (prefer) headers.Prefer = prefer
  const res = await fetch(`${URL}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null; try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, json }
}

async function authFetch(path, body) {
  const res = await fetch(`${URL}/auth/v1/${path}`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

async function invoke(fnName, token, body) {
  const res = await fetch(`${URL}/functions/v1/${fnName}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

// Admin create a pre-confirmed user (service-role only). Bypasses both email
// confirmation AND the public-signup domain block (some projects reject
// @example.com). The on_auth_user_created trigger still fires, so the tenant is
// provisioned identically to a real signup.
async function adminCreateUser(email, password, orgName) {
  const res = await fetch(`${URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { org_name: orgName } }),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}

// ── sign up (or log in) a throwaway tenant ────────────────────────────────────
async function makeTenant(label) {
  // Real signups reject the reserved @example.com domain on some projects; use a
  // domain the admin path accepts and that still looks obviously throwaway.
  const email = `mt-stress-${label}-${stamp}@mt-stress.dev`
  const password = `Stress!${stamp}${label}`
  const orgName = `MT Stress ${label} ${stamp}`

  let userId
  if (SERVICE) {
    // Preferred path: admin-create a confirmed user, then password-grant a session.
    const created = await adminCreateUser(email, password, orgName)
    if (created.status >= 400) throw new Error(`admin create for ${label} failed (${created.status}): ${JSON.stringify(created.json)}`)
    userId = created.json?.id
  } else {
    const { status, json } = await authFetch('signup', { email, password, data: { org_name: orgName } })
    if (status >= 400) throw new Error(`signup for ${label} failed (${status}): ${JSON.stringify(json)}`)
    userId = json.user?.id || json.id
  }

  // Log in for a client (anon-scoped) session token to probe with.
  let token
  const login = await authFetch('token?grant_type=password', { email, password })
  token = login.json.access_token
  if (!token) {
    throw new Error(
      `No session for ${label}. Email confirmation is probably ON. Either disable ` +
      `"Confirm email" in Supabase Auth for the test, or provide a service-role key ` +
      `(--service-key / SB_SERVICE_KEY) so the harness can create confirmed users. ` +
      `(user id: ${userId || 'unknown'})`)
  }

  // Discover the org this tenant was provisioned into.
  const mem = await rest('memberships?select=org_id,role', { token })
  const orgId = mem.json?.[0]?.org_id
  return { label, email, password, token, orgId, userId }
}

// ── the org-scoped tables we assert isolation on ──────────────────────────────
const SCOPED_TABLES = [
  'transactions', 'tasks', 'crm_contacts', 'crm_deals', 'sops', 'team_members',
  'tenancies', 'costs', 'properties', 'objectives_strategy', 'onboarding_submissions',
]

async function main() {
  console.log(`\n▶ Multi-tenancy stress test against ${URL}`)
  console.log(`  mode: ${RUN_DESTRUCTIVE ? 'DESTRUCTIVE (will suspend/delete throwaway tenant A)' : 'report-only'}; cleanup: ${SERVICE ? 'auto' : KEEP ? 'kept' : 'manual'}\n`)

  console.log('① Provisioning two throwaway tenants…')
  const A = await makeTenant('a')
  const B = await makeTenant('b')
  if (!A.orgId || !B.orgId) throw new Error(`Could not resolve org ids (A=${A.orgId}, B=${B.orgId}).`)
  if (A.orgId === B.orgId) return fail('provisioning', 'both tenants landed in the SAME org — provisioning is broken')
  pass('provisioning', `A=${A.orgId.slice(0, 8)} B=${B.orgId.slice(0, 8)} (distinct orgs)`)

  // ── P1 Baseline: a fresh tenant must NOT see anyone else's rows ─────────────
  console.log('\n② P1 — baseline: does a fresh client see foreign rows (esp. the operator\'s real data)?')
  for (const tbl of SCOPED_TABLES) {
    const r = await rest(`${tbl}?select=org_id`, { token: A.token })
    if (r.status >= 400) { warn(`read ${tbl}`, `status ${r.status} (table may not exist / no grant)`); continue }
    const rows = Array.isArray(r.json) ? r.json : []
    const foreign = rows.filter(x => x.org_id && x.org_id !== A.orgId)
    if (foreign.length) fail(`isolation:${tbl}`, `tenant A sees ${foreign.length} row(s) from other orgs — LEAK`)
    else pass(`isolation:${tbl}`, `${rows.length} row(s), all own-org`)
  }

  // ── P2/P3 Cross-tenant read + write on a real row ──────────────────────────
  console.log('\n③ P2/P3 — A seeds a marker; B tries to read / modify / delete it')
  const seed = await rest('crm_contacts', {
    token: A.token, method: 'POST', prefer: 'return=representation',
    body: { name: `MARKER ${stamp}`, kind: 'person', email: `marker-${stamp}@example.com` },
  })
  const marker = Array.isArray(seed.json) ? seed.json[0] : seed.json
  if (!marker?.id) { warn('seed marker', `could not insert (status ${seed.status}) — skipping P2/P3`) }
  else {
    pass('seed marker', `A created crm_contacts ${marker.id.slice(0, 8)} in org ${marker.org_id?.slice(0, 8)}`)

    const bRead = await rest(`crm_contacts?id=eq.${marker.id}&select=id`, { token: B.token })
    if ((bRead.json || []).length) fail('P2 cross-read', 'B can READ A\'s contact — LEAK')
    else pass('P2 cross-read', 'B sees nothing (RLS blocks)')

    const bUpd = await rest(`crm_contacts?id=eq.${marker.id}`, {
      token: B.token, method: 'PATCH', prefer: 'return=representation', body: { name: 'HIJACKED' },
    })
    if ((bUpd.json || []).length) fail('P3 cross-update', 'B UPDATED A\'s contact — LEAK')
    else pass('P3 cross-update', '0 rows affected (RLS blocks)')

    const bDel = await rest(`crm_contacts?id=eq.${marker.id}`, {
      token: B.token, method: 'DELETE', prefer: 'return=representation',
    })
    if ((bDel.json || []).length) fail('P3 cross-delete', 'B DELETED A\'s contact — LEAK')
    else pass('P3 cross-delete', '0 rows affected (RLS blocks)')
  }

  // ── P4 Forged org_id insert (with-check must reject) ───────────────────────
  console.log('\n④ P4 — B inserts a row stamped with A\'s org_id (RLS with-check must reject)')
  const forged = await rest('crm_contacts', {
    token: B.token, method: 'POST', prefer: 'return=representation',
    body: { org_id: A.orgId, name: `FORGED ${stamp}`, kind: 'person' },
  })
  const forgedRow = Array.isArray(forged.json) ? forged.json[0] : forged.json
  if (forged.status < 300 && forgedRow?.org_id === A.orgId) fail('P4 forged insert', 'B wrote a row into A\'s org — LEAK')
  else pass('P4 forged insert', `rejected (status ${forged.status})`)

  // ── P5 Enumerate orgs / memberships ────────────────────────────────────────
  console.log('\n⑤ P5 — can B enumerate other workspaces / memberships directly?')
  const bOrgs = await rest('organizations?select=id,name', { token: B.token })
  const foreignOrgs = (bOrgs.json || []).filter(o => o.id !== B.orgId)
  if (foreignOrgs.length) fail('P5 org enum', `B sees ${foreignOrgs.length} other workspace(s) via table read — LEAK`)
  else pass('P5 org enum', 'B sees only its own workspace')

  // ── P6 THE BIG ONE: Edge-Function privilege (Finding 1) ────────────────────
  console.log('\n⑥ P6 — manage-client Edge Function: can a plain client act as platform operator?')
  const list = await invoke('manage-client', B.token, { action: 'list' })
  if (list.status === 403) {
    pass('P6 manage-client/list', 'correctly denied (403) — operator gate is in place')
  } else if (list.status === 200 && Array.isArray(list.json?.clients)) {
    const n = list.json.clients.length
    fail('P6 manage-client/list',
      `client B got the full workspace list (${n} tenants incl. owner emails) — CROSS-TENANT DISCLOSURE`)
    // Escalation probes — only ever target throwaway tenant A, and only with --run-destructive.
    if (RUN_DESTRUCTIVE) {
      const susp = await invoke('manage-client', B.token, { action: 'suspend', org_id: A.orgId })
      if (susp.status === 200) {
        fail('P6 manage-client/suspend', 'client B SUSPENDED throwaway tenant A — PRIVILEGE ESCALATION CONFIRMED')
        const del = await invoke('manage-client', B.token, { action: 'delete', org_id: A.orgId })
        if (del.status === 200) fail('P6 manage-client/delete', 'client B DELETED throwaway tenant A — FULL TENANT DESTRUCTION CONFIRMED')
        else pass('P6 manage-client/delete', `delete denied (status ${del.status})`)
      } else {
        pass('P6 manage-client/suspend', `suspend denied (status ${susp.status})`)
      }
    } else {
      warn('P6 escalation', 'skipped suspend/delete (report-only). Re-run with --run-destructive to confirm the full chain against throwaway tenant A.')
    }
  } else {
    warn('P6 manage-client/list', `unexpected response (status ${list.status}): ${JSON.stringify(list.json).slice(0, 200)}`)
  }

  // ── cleanup ────────────────────────────────────────────────────────────────
  console.log('\n⑦ Cleanup')
  await cleanup(A, B)

  // ── summary ─────────────────────────────────────────────────────────────────
  const failed = results.filter(r => r.ok === false)
  const warned = results.filter(r => r.ok === null)
  console.log(`\n──────── SUMMARY ────────`)
  console.log(`  ${results.filter(r => r.ok === true).length} passed, ${failed.length} FAILED, ${warned.length} warnings`)
  if (failed.length) {
    console.log(`\n  ❌ Isolation failures:`)
    failed.forEach(f => console.log(`     • ${f.name} — ${f.detail}`))
  }
  process.exit(failed.length ? 1 : 0)
}

async function cleanup(A, B) {
  if (KEEP) { warn('cleanup', `--keep set. Throwaway orgs left in place: A=${A.orgId} B=${B.orgId}`); return }
  if (SERVICE) {
    for (const t of [A, B]) {
      const res = await fetch(`${URL}/rest/v1/rpc/delete_workspace`, {
        method: 'POST',
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_org: t.orgId, p_delete_users: true }),
      })
      if (res.ok) pass(`cleanup:${t.label}`, `deleted org ${t.orgId.slice(0, 8)} + user`)
      else fail(`cleanup:${t.label}`, `delete_workspace failed (status ${res.status}) — clean up ${t.orgId} manually`)
    }
  } else {
    warn('cleanup', 'no service-role key — cannot auto-delete. Run this in the SQL editor:')
    console.log(`     select public.delete_workspace('${A.orgId}');`)
    console.log(`     select public.delete_workspace('${B.orgId}');`)
  }
}

main().catch(e => { console.error(`\n✖ Harness error: ${e.message}`); process.exit(2) })
