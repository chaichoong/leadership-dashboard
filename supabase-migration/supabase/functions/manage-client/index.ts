// manage-client — Edge Function
// ─────────────────────────────────────────────────────────────────────────────
// Admin-only client offboarding for the CRM "Clients" tab. The caller must be an
// owner/admin (same check as create-client). Uses the service-role key so it can
// see/act across client workspaces that RLS would otherwise hide from the caller.
//
// Actions (body.action):
//   list     → every client workspace (all orgs except the caller's own) + status,
//              owner email, member count.
//   suspend  → suspend_workspace() (access off, data kept) AND mark the client's
//              CRM deal "Lost — Cancelled" + archive the contact.
//   restore  → restore_workspace() AND re-open the CRM deal (Won) + un-archive.
//   delete   → PERMANENT: only if the workspace is already suspended, calls
//              delete_workspace(). The CRM deal stays Lost/Cancelled (history).
//
// The CRM writes target the CALLER'S own workspace (their sales pipeline), matched
// to the client by the workspace owner's email. Never echoes another workspace's
// internal ids beyond what the admin already governs.
//
// DEPLOY (Mica):  supabase functions deploy manage-client   (JWT verification ON —
// the caller is an authenticated admin, so do NOT pass --no-verify-jwt)
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CANCELLED_TAG = 'Cancelled'
// The £100/mo bolt-on packs (pricing page) — map 1:1 to org_modules add-on keys.
const ADDON_MODULES = ['finance', 'inbound_comms', 'content_machine', 'personal_wealth', 'property']

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

const today = () => new Date().toISOString().slice(0, 10)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
    if (!jwt) return json({ error: 'Not authenticated' }, 401)

    // Authorize the caller — must be an owner/admin somewhere.
    const asCaller = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${jwt}` } } })
    const { data: { user }, error: uErr } = await asCaller.auth.getUser()
    if (uErr || !user) return json({ error: 'Not authenticated' }, 401)

    const admin = createClient(url, service)
    const { data: mems } = await admin.from('memberships')
      .select('org_id, role').eq('user_id', user.id)
    const adminMems = (mems || []).filter(m => m.role === 'owner' || m.role === 'admin')
    if (!adminMems.length) return json({ error: 'You are not allowed to manage client accounts.' }, 403)
    const callerOrgIds = new Set((mems || []).map(m => m.org_id))
    const adminOrgId = adminMems[0].org_id   // the caller's sales-CRM workspace

    const body = await req.json().catch(() => ({} as Record<string, unknown>))
    const action = String(body.action || '')
    const orgId = String(body.org_id || '')

    // ── list ────────────────────────────────────────────────────────────────
    if (action === 'list') {
      const { data: rows, error } = await admin.rpc('list_client_workspaces')
      if (error) return json({ error: error.message }, 500)
      const clients = (rows || []).filter((r: { id: string }) => !callerOrgIds.has(r.id))
      return json({ ok: true, clients })
    }

    if (!orgId) return json({ error: 'A workspace id is required.' }, 400)
    if (callerOrgIds.has(orgId)) return json({ error: 'You cannot offboard your own workspace here.' }, 400)

    // Helpers to touch the caller's CRM deal/contact for this client (matched by email).
    const ownerEmailOf = async () => {
      const { data } = await admin.rpc('workspace_owner_email', { p_org: orgId })
      return (typeof data === 'string' ? data : '').toLowerCase()
    }
    const stageId = async (name: string) => {
      const { data: pipe } = await admin.from('crm_pipelines')
        .select('id').eq('org_id', adminOrgId).order('sort_order').limit(1).maybeSingle()
      if (!pipe) return { pipelineId: null as string | null, id: null as string | null }
      const { data: stages } = await admin.from('crm_stages')
        .select('id, name, sort_order').eq('pipeline_id', pipe.id).order('sort_order')
      const s = (stages || []).find(x => x.name === name)
      return { pipelineId: pipe.id, id: s?.id ?? null }
    }

    // ── suspend — TEMPORARY hold. Login off, data kept, NO CRM change ──────────
    if (action === 'suspend') {
      const { error } = await admin.rpc('suspend_workspace', { p_org: orgId })
      if (error) return json({ error: error.message }, 500)
      return json({ ok: true })
    }

    // ── cancel — CHURNED. Login off, data kept, deal → Lost — Cancelled ─────────
    if (action === 'cancel') {
      const { error } = await admin.rpc('cancel_workspace', { p_org: orgId })
      if (error) return json({ error: error.message }, 500)

      const email = await ownerEmailOf()
      if (email) {
        const { data: contacts } = await admin.from('crm_contacts')
          .select('id, tags').eq('org_id', adminOrgId).eq('email', email)
        for (const c of contacts || []) {
          const tags = Array.isArray(c.tags) ? c.tags : []
          if (!tags.includes('churned')) tags.push('churned')
          await admin.from('crm_contacts').update({ status: 'archived', tags }).eq('id', c.id)
        }
        const ids = (contacts || []).map(c => c.id)
        if (ids.length) {
          const { id: lostId } = await stageId('Lost')
          const { data: deals } = await admin.from('crm_deals')
            .select('id, title, notes, status').eq('org_id', adminOrgId).in('contact_id', ids)
          for (const d of deals || []) {
            const title = /—\s*Cancelled$/i.test(d.title || '') ? d.title : `${d.title} — ${CANCELLED_TAG}`
            const note = `[${CANCELLED_TAG} ${today()}]`
            const notes = d.notes ? `${d.notes}\n${note}` : note
            await admin.from('crm_deals').update({
              status: 'lost', ...(lostId ? { stage_id: lostId } : {}), title, notes,
            }).eq('id', d.id)
          }
        }
      }
      return json({ ok: true })
    }

    // ── restore / reactivate — back to active, lift ban, re-open the deal ───────
    if (action === 'restore') {
      const { error } = await admin.rpc('restore_workspace', { p_org: orgId })
      if (error) return json({ error: error.message }, 500)

      // CRM: re-open the deal (Won) + un-archive the contact.
      const email = await ownerEmailOf()
      if (email) {
        const { data: contacts } = await admin.from('crm_contacts')
          .select('id, tags').eq('org_id', adminOrgId).eq('email', email)
        for (const c of contacts || []) {
          const tags = (Array.isArray(c.tags) ? c.tags : []).filter((t: string) => t !== 'churned')
          await admin.from('crm_contacts').update({ status: 'active', tags }).eq('id', c.id)
        }
        const ids = (contacts || []).map(c => c.id)
        if (ids.length) {
          const { id: wonId } = await stageId('Won')
          const { data: deals } = await admin.from('crm_deals')
            .select('id, title, notes').eq('org_id', adminOrgId).in('contact_id', ids)
          for (const d of deals || []) {
            const title = (d.title || '').replace(/\s*—\s*Cancelled$/i, '')
            const notes = (d.notes || '').replace(/\n?\[Cancelled \d{4}-\d{2}-\d{2}\]/gi, '').trim() || null
            await admin.from('crm_deals').update({
              status: 'won', ...(wonId ? { stage_id: wonId } : {}), title, notes,
            }).eq('id', d.id)
          }
        }
      }
      return json({ ok: true })
    }

    // ── delete (permanent) ──────────────────────────────────────────────────────
    if (action === 'delete') {
      // Safety: only a SUSPENDED workspace can be permanently deleted.
      const { data: org } = await admin.from('organizations')
        .select('status').eq('id', orgId).maybeSingle()
      if (!org) return json({ error: 'Workspace not found.' }, 404)
      if (org.status !== 'suspended' && org.status !== 'cancelled') {
        return json({ error: 'Suspend or cancel the client first — an active workspace cannot be permanently deleted.' }, 400)
      }
      const { error } = await admin.rpc('delete_workspace', { p_org: orgId, p_delete_users: true })
      if (error) return json({ error: error.message }, 500)
      // CRM deal stays Lost/Cancelled as history — intentionally not deleted.
      return json({ ok: true })
    }

    // ── get_modules — the client's bolt-on pack entitlements ──────────────────
    if (action === 'get_modules') {
      const { data, error } = await admin.from('org_modules')
        .select('module_key, enabled').eq('org_id', orgId)
      if (error) return json({ error: error.message }, 500)
      return json({ ok: true, modules: data || [] })
    }

    // ── set_module — turn a bolt-on pack on/off for the client ────────────────
    if (action === 'set_module') {
      const moduleKey = String(body.module_key || '')
      const enabled = body.enabled === true
      if (!ADDON_MODULES.includes(moduleKey)) return json({ error: 'Unknown bolt-on pack.' }, 400)
      const { error } = await admin.from('org_modules')
        .upsert({ org_id: orgId, module_key: moduleKey, enabled }, { onConflict: 'org_id,module_key' })
      if (error) return json({ error: error.message }, 500)
      return json({ ok: true })
    }

    return json({ error: 'Unknown action.' }, 400)
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
