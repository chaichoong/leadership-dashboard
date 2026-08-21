// ceo-brief-tenants — one daily CEO Brief per client workspace on the Supabase product.
//
// Per tenant, in order: read the config from app_settings, gate on the tenant's
// own timezone and send hour, skip if today's brief already exists, gather tasks
// and calendar and money, run every ENABLED board seat in parallel on the light
// model, synthesise with the CEO on the default model, STORE the row, THEN deliver.
// Store-before-deliver means a retry firing can never send the same brief twice.
//
// Secrets (wrangler secret put): SUPABASE_SERVICE_KEY, PROXY_TOKEN, TRIGGER_KEY,
// optional EMAIL_WEBHOOK_URL, and one Airtable PAT per tenant that connects
// Airtable tasks (the secret's NAME is in cfg.tasks_source.airtable_pat_ref).
// Plain vars: SUPABASE_URL, AI_MODEL_DEFAULT, AI_MODEL_LIGHT (wrangler.toml).

import { CONFIG_KEY, mergeConfig, missingForGoLive } from '../../js/ceo-brief-defaults.mjs';
import {
  localDate, localDateLabel, isSendWindow, nextWindow, skipReason, enabledSeats,
  shapeTasks, emptyTasks, parseIcsToday, moneyFromConfig,
  buildSeatPrompt, buildCeoPrompt, parseJsonReply, shapeSeatAnswer, finaliseBrief,
  buildSlackPayload, briefAsPlainText, briefRow,
} from './lib.mjs';

const SERVICE = 'ceo-brief-tenants';
const CLAUDE_PROXY = 'https://claude-proxy.kevinbrittain.workers.dev';
const MODULE_KEY = 'ceo_brief';
const ALLOWED_ORIGINS = ['https://chaichoong.github.io'];

// The ONLY place this worker logs. Server-side, never a secret or a webhook URL.
function log(orgId, msg) {
  console.log(`[${SERVICE}] ${orgId ? orgId.slice(0, 8) + ' ' : ''}${msg}`);
}

// ── Supabase REST (service role) ───────────────────────────────────────────
async function supa(env, path, init = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`supabase ${path.split('?')[0]} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  if (res.status === 204 || init.headers?.Prefer === 'return=minimal') return null;
  return res.json();
}

// Every org with a ceo_brief config, minus any that opted out through org_modules.
async function listTenants(env) {
  const [settings, optedOut] = await Promise.all([
    supa(env, `app_settings?key=eq.${CONFIG_KEY}&select=org_id,value`),
    supa(env, `org_modules?module_key=eq.${MODULE_KEY}&enabled=eq.false&select=org_id`),
  ]);
  const off = new Set((optedOut || []).map(r => r.org_id));
  const tenants = [];
  for (const row of settings || []) {
    if (off.has(row.org_id)) { tenants.push({ org_id: row.org_id, cfg: null, optedOut: true }); continue; }
    let cfg;
    try { cfg = mergeConfig(JSON.parse(row.value || '{}')); }
    catch { cfg = null; }
    tenants.push({ org_id: row.org_id, cfg, badJson: !cfg });
  }
  return tenants;
}

// Idempotency: a populated full_brief for today's LOCAL date means "sent".
// Fails OPEN on a read error, on purpose: a duplicate is a nuisance, a missing
// brief is the whole failure mode this worker exists to avoid.
async function alreadyBriefed(env, orgId, date) {
  try {
    const rows = await supa(env, `ceo_briefs?org_id=eq.${orgId}&brief_date=eq.${date}&select=id,full_brief`);
    return (rows || []).some(r => r.full_brief && Object.keys(r.full_brief).length > 0);
  } catch (err) {
    log(orgId, `idempotency read failed, proceeding: ${err.message}`);
    return false;
  }
}

async function upsertBrief(env, row) {
  await supa(env, 'ceo_briefs?on_conflict=org_id,brief_date', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
}

// ── Gather ─────────────────────────────────────────────────────────────────
async function airtableAll(pat, base, table, params) {
  const records = [];
  let offset = null;
  do {
    const url = new URL(`https://api.airtable.com/v0/${base}/${encodeURIComponent(table)}`);
    Object.entries(params).forEach(([k, v]) => {
      if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
      else url.searchParams.append(k, v);
    });
    if (offset) url.searchParams.set('offset', offset);
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(url, { headers: { Authorization: `Bearer ${pat}` } });
      if (res.status !== 429) break;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
    }
    if (!res.ok) throw new Error(`Airtable ${res.status}`);
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset || null;
  } while (offset);
  return records;
}

const whoName = v => {
  if (!v) return 'unassigned';
  if (Array.isArray(v)) return v.map(whoName).join(', ');
  if (typeof v === 'object') return v.name || v.email || 'unassigned';
  return String(v);
};

async function gatherTasks(env, cfg, todayISO) {
  const src = cfg.tasks_source || {};
  if (src.kind === 'airtable') {
    const pat = src.airtable_pat_ref ? env[src.airtable_pat_ref] : '';
    if (!pat || !src.airtable_base || !src.airtable_table) return emptyTasks('(tasks not connected: Airtable details incomplete)');
    try {
      const rows = await airtableAll(pat, src.airtable_base, src.airtable_table, {
        filterByFormula: `AND({Task Name}!='',NOT({Status}='Completed'),NOT({Status}='Cancelled'))`,
        'fields[]': ['Task Name', 'Assignee', 'Due Date', 'Status', 'Priority', 'Task Type'],
      });
      return shapeTasks(rows.map(r => ({
        name: r.fields['Task Name'], who: whoName(r.fields['Assignee']), due: r.fields['Due Date'],
        status: r.fields['Status'], priority: r.fields['Priority'], type: r.fields['Task Type'],
      })), todayISO, cfg);
    } catch (err) {
      return emptyTasks(`(tasks could not be read today: ${String(err.message).slice(0, 80)})`);
    }
  }
  // 'supabase' is reserved for the in-app Tasks module; 'none' is the default.
  return emptyTasks(src.kind === 'supabase' ? '(tasks not connected: in-app tasks source coming soon)' : '(tasks not connected)');
}

async function gatherCalendar(cfg, todayISO) {
  if (!cfg.calendar_ics_url) return { connected: false, today: '' };
  try {
    const res = await fetch(cfg.calendar_ics_url);
    if (!res.ok) throw new Error('ICS fetch ' + res.status);
    return { connected: true, today: parseIcsToday(await res.text(), todayISO, cfg.timezone) || '(no events today)' };
  } catch (err) {
    return { connected: true, today: `(calendar could not be read today: ${String(err.message).slice(0, 80)})` };
  }
}

// ── AI through the proxy (service binding) ─────────────────────────────────
async function ask(env, model, prompt, maxTokens) {
  const res = await env.PROXY.fetch(CLAUDE_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.PROXY_TOKEN}`, 'User-Agent': `${SERVICE}/1.0` },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] }),
  });
  if (!res.ok) throw new Error(`proxy error ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  return { text: data.content?.[0]?.text || '', stop: data.stop_reason || '?' };
}

async function runBoard(env, cfg, tasks, calendar, todayISO) {
  const seats = enabledSeats(cfg);
  const results = await Promise.allSettled(seats.map(async seat => {
    const { text } = await ask(env, env.AI_MODEL_LIGHT, buildSeatPrompt(seat, cfg, tasks, calendar, todayISO), 600);
    const raw = parseJsonReply(text);
    if (!raw) throw new Error('seat returned no JSON');
    return shapeSeatAnswer(seat, raw);
  }));
  const huddle = { seats: [], errors: [] };
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') huddle.seats.push(r.value);
    else huddle.errors.push({ seat: seats[i].seat, error: String(r.reason && r.reason.message || r.reason).slice(0, 120) });
  });
  return huddle;
}

async function runCeo(env, cfg, tasks, calendar, money, huddle, todayISO, dateLabel) {
  const prompt = buildCeoPrompt(cfg, tasks, calendar, money, huddle, todayISO, dateLabel);
  const once = async p => {
    const { text, stop } = await ask(env, env.AI_MODEL_DEFAULT, p, 3000);
    const raw = parseJsonReply(text);
    if (!raw) throw new Error(`CEO returned no JSON (stop=${stop}, ${text.length} chars)`);
    return finaliseBrief(raw, tasks, cfg);
  };
  try {
    return await once(prompt);
  } catch (err) {
    // A proxy outage fails the same way twice; a cut-off reply is worth one terse retry.
    if (String(err.message).startsWith('proxy error')) throw err;
    return once({
      system: prompt.system,
      user: prompt.user + '\n\nYOUR LAST REPLY WAS CUT OFF OR INVALID. Answer again, much shorter: one sentence per field, at most 2 ignore items, at most 3 handed_off items, at most 1 flag. Close the JSON.',
    });
  }
}

// ── Deliver ────────────────────────────────────────────────────────────────
async function deliver(env, cfg, brief, money, dateLabel) {
  const ch = cfg.delivery.channel;
  if (ch === 'slack_webhook') {
    if (!cfg.delivery.slack_webhook_url) return { channel: ch, ok: false, reason: 'no webhook address' };
    const res = await fetch(cfg.delivery.slack_webhook_url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSlackPayload(brief, money, dateLabel, cfg.send_hour)),
    });
    if (!res.ok) throw new Error(`Slack webhook ${res.status}`);
    return { channel: ch, ok: true };
  }
  if (ch === 'email') {
    if (!env.EMAIL_WEBHOOK_URL) return { channel: 'page_only', ok: true, reason: 'no email sender configured' };
    const res = await fetch(env.EMAIL_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: cfg.delivery.email, subject: `CEO brief for ${dateLabel}`, text: briefAsPlainText(brief, money, dateLabel) }),
    });
    if (!res.ok) throw new Error(`email webhook ${res.status}`);
    return { channel: ch, ok: true };
  }
  return { channel: 'page_only', ok: true };
}

// ── One tenant, start to finish ────────────────────────────────────────────
// opts: { store, deliver, ignoreWindow, force, now }
async function runTenant(env, tenant, opts) {
  const { org_id: orgId, cfg } = tenant;
  const now = opts.now || new Date();
  if (tenant.optedOut) return { org_id: orgId, skipped: 'module switched off' };
  if (!cfg) return { org_id: orgId, skipped: 'config is not valid JSON' };
  const reason = skipReason(cfg);
  if (reason) return { org_id: orgId, skipped: reason };
  const today = localDate(cfg.timezone, now);
  const window = isSendWindow(cfg, now);
  if (!opts.ignoreWindow && !window) return { org_id: orgId, skipped: 'outside the send window', window: false };
  if (opts.store && !opts.force && await alreadyBriefed(env, orgId, today)) return { org_id: orgId, skipped: 'already briefed today', date: today };

  const dateLabel = localDateLabel(cfg.timezone, now);
  const [tasks, calendar] = await Promise.all([gatherTasks(env, cfg, today), gatherCalendar(cfg, today)]);
  const money = moneyFromConfig(cfg);
  const huddle = await runBoard(env, cfg, tasks, calendar, today);
  const brief = await runCeo(env, cfg, tasks, calendar, money, huddle, today, dateLabel);
  const stats = {
    tasks: { connected: tasks.connected, ...tasks.counts },
    calendar: calendar.connected, money: money.connected,
    seats_answered: huddle.seats.length, seats_failed: huddle.errors.length,
    ran_at: now.toISOString(),
  };
  const out = { org_id: orgId, date: today, window, brief, huddle, stats };
  if (!opts.store) return out;

  // STORE FIRST. Once the row carries full_brief, a second firing sees it and stops.
  await upsertBrief(env, briefRow(orgId, today, brief, money, huddle, stats));
  log(orgId, `stored ${today}: ${huddle.seats.length} seats, ${huddle.errors.length} failed`);
  if (!opts.deliver) return { ...out, stored: true };
  try {
    stats.delivery = await deliver(env, cfg, brief, money, dateLabel);
    await upsertBrief(env, briefRow(orgId, today, brief, money, huddle, stats));
    log(orgId, `delivered via ${stats.delivery.channel}`);
    return { ...out, stored: true, delivery: stats.delivery };
  } catch (err) {
    stats.delivery = { channel: cfg.delivery.channel, ok: false, reason: String(err.message).slice(0, 160) };
    await upsertBrief(env, briefRow(orgId, today, { ...brief, fallback_reason: `delivery failed: ${stats.delivery.reason}` }, money, huddle, stats, true))
      .catch(e => log(orgId, `fallback write failed: ${e.message}`));
    log(orgId, `delivery failed: ${stats.delivery.reason}`);
    return { ...out, stored: true, delivery: stats.delivery };
  }
}

// Wraps runTenant so a thrown error becomes a fallback row plus a result, never
// an exception that stops the loop for the other tenants.
async function runTenantSafe(env, tenant, opts) {
  try {
    return await runTenant(env, tenant, opts);
  } catch (err) {
    const reason = String(err && err.message || err).slice(0, 300);
    log(tenant.org_id, `FAILED: ${reason}`);
    if (opts.store && tenant.cfg) {
      const today = localDate(tenant.cfg.timezone, opts.now || new Date());
      const marker = {
        one_thing: 'Your CEO brief could not be written today.',
        first_step: 'Open your CEO Brief page later today. We have been alerted and are looking at it.',
        why: '', ignore: [], handed_off: [], flags: [], headline: 'Brief failed today', fallback_reason: reason,
      };
      await upsertBrief(env, briefRow(tenant.org_id, today, marker, moneyFromConfig(tenant.cfg), { seats: [], errors: [] }, { failed: true }, true))
        .catch(e => log(tenant.org_id, `fallback write failed: ${e.message}`));
    }
    return { org_id: tenant.org_id, error: reason };
  }
}

async function runAll(env, opts) {
  const tenants = await listTenants(env);
  const results = [];
  for (const t of tenants) results.push(await runTenantSafe(env, t, opts));
  const sent = results.filter(r => r.stored).length;
  log('', `run complete: ${tenants.length} tenants, ${sent} briefed, ${results.filter(r => r.error).length} failed`);
  return results;
}

function cors(request) {
  const origin = request.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAll(env, { store: true, deliver: true, now: new Date(event.scheduledTime) }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(request);
    if (url.pathname === '/health') return Response.json({ ok: true, service: SERVICE }, { headers });
    if (!env.TRIGGER_KEY || url.searchParams.get('key') !== env.TRIGGER_KEY) return new Response('Forbidden', { status: 403, headers });
    const mode = url.searchParams.get('mode');
    const orgId = url.searchParams.get('org') || '';
    try {
      if (mode === 'tenants') {
        const list = (await listTenants(env)).map(t => ({
          org_id: t.org_id,
          enabled: Boolean(t.cfg && t.cfg.enabled && !t.optedOut),
          missing: t.cfg ? missingForGoLive(t.cfg) : ['config is not valid JSON'],
          opted_out: Boolean(t.optedOut),
          next_window: t.cfg ? nextWindow(t.cfg) : null,
        }));
        return Response.json({ ok: true, tenants: list }, { headers });
      }
      if (mode === 'brief' || mode === 'send') {
        if (!/^[0-9a-f-]{36}$/i.test(orgId)) return Response.json({ ok: false, error: 'org must be a uuid' }, { status: 400, headers });
        const tenant = (await listTenants(env)).find(t => t.org_id === orgId);
        if (!tenant) return Response.json({ ok: false, error: 'no ceo_brief config for that org' }, { status: 404, headers });
        const r = mode === 'brief'
          ? await runTenant(env, tenant, { store: false, deliver: false, ignoreWindow: true })
          : await runTenantSafe(env, tenant, { store: true, deliver: true, ignoreWindow: true, force: url.searchParams.get('force') === '1' });
        if (r.skipped) return Response.json({ ok: false, skipped: r.skipped, missing: tenant.cfg ? missingForGoLive(tenant.cfg) : [] }, { headers });
        if (r.error) return Response.json({ ok: false, error: r.error }, { status: 500, headers });
        return Response.json({ ok: true, ...r, missing: [] }, { headers });
      }
      return Response.json({ ok: false, error: 'mode must be tenants, brief or send' }, { status: 400, headers });
    } catch (err) {
      return Response.json({ ok: false, error: String(err && err.message || err) }, { status: 500, headers });
    }
  },
};
