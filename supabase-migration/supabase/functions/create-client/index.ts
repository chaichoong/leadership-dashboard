// create-client — Edge Function
// ─────────────────────────────────────────────────────────────────────────────
// Onboards a new CLIENT from the CRM. Platform-admin only (owner/admin of the home
// org, via is_platform_admin() — see migration 0038).
//   1. Creates the client's account via generateLink(type:'invite') — this fires
//      the on_auth_user_created trigger that provisions their base-plan workspace,
//      and returns a secure set-password link WITHOUT Supabase sending any email.
//   2. POSTs { email, company, name, set_password_link } to a GoHighLevel inbound
//      webhook, so the client welcome email is sent (and tracked) from GHL.
//
// The service-role key is auto-injected as SUPABASE_SERVICE_ROLE_KEY — never in
// the browser or repo. The GHL webhook URL only lives here server-side.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GHL_WEBHOOK = 'https://services.leadconnectorhq.com/hooks/dgsHwbYbp6xrhRGZr9ik/webhook-trigger/35dced58-d0b6-4b97-8f8f-71a97693407b'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
    if (!jwt) return json({ error: 'Not authenticated' }, 401)

    // Identify the caller.
    const asCaller = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${jwt}` } } })
    const { data: { user }, error: uErr } = await asCaller.auth.getUser()
    if (uErr || !user) return json({ error: 'Not authenticated' }, 401)
    const admin = createClient(url, service)
    // Authorize: PLATFORM ADMIN only (owner/admin of the home org). The old check
    // ("owner/admin of any workspace") passed for every client, since each client
    // owns their own workspace — Finding 1. See migration 0038.
    const { data: isAdmin, error: aErr } = await admin.rpc('is_platform_admin', { p_user: user.id })
    if (aErr) return json({ error: aErr.message }, 500)
    if (!isAdmin) return json({ error: 'You are not allowed to create client accounts.' }, 403)

    const body = await req.json().catch(() => ({}))
    const email = String(body.email || '').trim().toLowerCase()
    const orgName = String(body.org_name || '').trim()
    const name = String(body.name || '').trim()
    const redirectTo = String(body.redirect_to || 'https://chaichoong.github.io/leadership-dashboard/set-password.html')
    if (!email) return json({ error: 'A client email is required.' }, 400)

    // 1. Create the account + get the secure set-password link (no email sent).
    // Store BOTH the company (org_name — used for the sidebar/workspace label) and
    // the person's name (full_name — used for the "who am I" pill and the client's
    // own team-member row) so each surface can show the right one.
    const { data: link, error: lErr } = await admin.auth.admin.generateLink({
      type: 'invite', email,
      options: {
        data: { ...(orgName ? { org_name: orgName } : {}), ...(name ? { full_name: name } : {}) },
        redirectTo,
      },
    })
    if (lErr) {
      const msg = /already|registered|exists/i.test(lErr.message) ? 'That email already has an account.' : lErr.message
      return json({ error: msg }, 400)
    }
    const setPasswordLink = link?.properties?.action_link

    // 2. Hand it to GoHighLevel to send the branded welcome email.
    let emailed = false
    try {
      const r = await fetch(GHL_WEBHOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: name || orgName, company: orgName, set_password_link: setPasswordLink }),
      })
      emailed = r.ok
    } catch (_e) { emailed = false }

    return json({ ok: true, invited: true, emailed, user_id: link?.user?.id, email })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
