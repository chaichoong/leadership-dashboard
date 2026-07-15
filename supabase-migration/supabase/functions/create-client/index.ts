// create-client — Edge Function
// ─────────────────────────────────────────────────────────────────────────────
// Creates a new CLIENT login (auth user), which the on_auth_user_created trigger
// then auto-provisions into its own base-plan workspace (modules + starter SOPs +
// pipeline). Admin-only: the caller must be an owner/admin of a workspace.
//
// The Supabase service-role key is injected automatically as
// SUPABASE_SERVICE_ROLE_KEY — it never touches the browser or the repo.
//
// Deploy: Supabase dashboard → Edge Functions → create "create-client" → paste →
// Deploy. (Leave "Verify JWT" on.) No secrets to set.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const jwt = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim()
    if (!jwt) return json({ error: 'Not authenticated' }, 401)

    // 1. Validate the caller's identity from their JWT.
    const asCaller = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${jwt}` } } })
    const { data: { user }, error: uErr } = await asCaller.auth.getUser()
    if (uErr || !user) return json({ error: 'Not authenticated' }, 401)

    const admin = createClient(url, service)

    // 2. Authorize: the caller must be an owner/admin of some workspace.
    const { data: mem } = await admin.from('memberships')
      .select('role').eq('user_id', user.id).in('role', ['owner', 'admin']).limit(1)
    if (!mem || !mem.length) return json({ error: 'You are not allowed to create client accounts.' }, 403)

    // 3. Create the client login → the signup trigger provisions their workspace.
    const body = await req.json().catch(() => ({}))
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const orgName = String(body.org_name || '').trim()
    if (!email || !password) return json({ error: 'Email and password are required.' }, 400)
    if (password.length < 8) return json({ error: 'Password must be at least 8 characters.' }, 400)

    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email, password, email_confirm: true,
      user_metadata: orgName ? { org_name: orgName } : {},
    })
    if (cErr) {
      const msg = /already/i.test(cErr.message) ? 'That email already has an account.' : cErr.message
      return json({ error: msg }, 400)
    }
    return json({ ok: true, user_id: created.user?.id, email })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
