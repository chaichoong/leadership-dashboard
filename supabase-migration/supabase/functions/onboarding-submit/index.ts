// onboarding-submit — Edge Function
// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC intake endpoint for the client onboarding form (onboarding.html).
// A newly signed-up client (NO login yet) POSTs their account-setup answers. This
// function, using the service-role key (bypasses RLS), does three things in Kevin's
// Runpreneur workspace:
//   1. crm_contacts  — a person record for the client
//   2. crm_deals     — a deal at the "Won" stage, linked to that contact
//   3. onboarding_submissions — the full answers, linked to both, for provisioning
//
// It then chains into the existing CRM "Create client account" button (crm-supabase.html),
// which invites the client and provisions their workspace.
//
// PUBLIC by design: deploy with `--no-verify-jwt` so anonymous clients can submit.
// Abuse controls: a honeypot field + basic validation. Per-invite token gating is a
// noted follow-up. The service-role key is auto-injected as SUPABASE_SERVICE_ROLE_KEY —
// never in the browser or repo. We never echo internal ids back to the anonymous caller.
//
// DEPLOY (Mica): supabase functions deploy onboarding-submit --no-verify-jwt
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ORG_NAME = 'Runpreneur'   // the service provider's own CRM workspace
const WON_STAGE = 'Won'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

const clean = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max)
const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const body = await req.json().catch(() => ({} as Record<string, unknown>))

    // Honeypot: real users never fill `website`. Bots do. Pretend success, write nothing.
    if (clean(body.website, 200)) return json({ ok: true })

    const email = clean(body.email, 200).toLowerCase()
    const businessName = clean(body.business_name, 300)
    const contactName = clean(body.contact_name, 200)
    const phone = clean(body.phone, 60)
    const answers = (body.answers && typeof body.answers === 'object') ? body.answers : {}

    if (!email || !isEmail(email)) return json({ error: 'A valid email is required.' }, 400)
    if (!contactName) return json({ error: 'Your name is required.' }, 400)
    if (!businessName) return json({ error: 'Your business name is required.' }, 400)

    const admin = createClient(url, service)

    // Resolve the Runpreneur workspace (same lookup as 0025_crm.sql).
    const { data: org, error: orgErr } = await admin
      .from('organizations').select('id').eq('name', ORG_NAME).order('created_at').limit(1).maybeSingle()
    if (orgErr) return json({ error: orgErr.message }, 500)
    if (!org) return json({ error: 'Onboarding workspace is not set up yet.' }, 500)
    const orgId = org.id

    // Resolve the pipeline (earliest) and its Won stage (fall back to first stage).
    const { data: pipe } = await admin
      .from('crm_pipelines').select('id').eq('org_id', orgId).order('sort_order').limit(1).maybeSingle()
    if (!pipe) return json({ error: 'No sales pipeline is configured.' }, 500)
    const pipelineId = pipe.id

    const { data: stages } = await admin
      .from('crm_stages').select('id, name, sort_order').eq('pipeline_id', pipelineId).order('sort_order')
    const wonStage = (stages || []).find(s => s.name === WON_STAGE) || (stages || [])[0]
    const stageId = wonStage?.id ?? null

    const summary = `Onboarding form submitted ${new Date().toISOString().slice(0, 10)}.`
      + (phone ? ` Phone: ${phone}.` : '')

    // 1. Contact
    const { data: contact, error: cErr } = await admin.from('crm_contacts').insert({
      org_id: orgId, name: contactName, kind: 'person', email, phone: phone || null,
      company: businessName || null, status: 'active', tags: ['onboarding'], notes: summary,
    }).select('id').single()
    if (cErr) return json({ error: cErr.message }, 500)

    // 2. Deal (Won)
    const { data: deal, error: dErr } = await admin.from('crm_deals').insert({
      org_id: orgId, pipeline_id: pipelineId, stage_id: stageId, contact_id: contact.id,
      title: `${businessName} — onboarding`, status: 'won', currency: 'GBP', notes: summary,
    }).select('id').single()
    if (dErr) return json({ error: dErr.message }, 500)

    // 3. Submission (full answers)
    const { error: sErr } = await admin.from('onboarding_submissions').insert({
      org_id: orgId, contact_id: contact.id, deal_id: deal.id,
      business_name: businessName, contact_name: contactName, email, phone: phone || null,
      answers, source: 'onboarding_form', status: 'new',
    })
    if (sErr) return json({ error: sErr.message }, 500)

    return json({ ok: true })
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500)
  }
})
