// Property Manager Worker — Roy Lavin's dashboard feed and task writes.
//
// WHY A WORKER: the OD app runs on Kevin's Airtable key, and an Airtable key
// cannot be scoped below the base. Roy must never hold one. This Worker holds
// the key server-side, reads only the property tables, filters transactions
// to Business = Real Estate AT THE QUERY, strips Personal costs in compute,
// and returns aggregates plus his task list. Nothing personal leaves.
//
// Endpoints (all JSON; browser origin must be on the allow-list):
//   POST /login        { passcode }            → { token, exp, who }
//   GET  /data         Bearer token            → computed dashboard (cached 10 min; ?refresh=1 bypasses)
//   GET  /tasks        Bearer token            → Roy-scope open tasks (never cached)
//   POST /task/:id     Bearer token { status?, note? } → { ok, task }
//   GET  /health                               → { ok, version }
//
// Secrets (wrangler secret put):
//   AIRTABLE_PAT        - read on the property tables + write on Tasks
//   PM_PASSCODE         - Roy's passcode
//   PM_PASSCODE_KEVIN   - Kevin's passcode for the same page (notes sign as him)
//   PM_SESSION_SECRET   - HMAC key for session tokens
// Bindings: LOGIN_LIMIT (ratelimit, optional) — 5 attempts per minute per IP.

import { computeAll, shapeTasks, isRoyScope, isTaskOpen, appendNote, buildNameMap } from './compute.mjs';
import { BASE, TABLES, F, NAMES, REAL_ESTATE_NAME, ROY_STATUS_ALLOW } from './fields.mjs';

const VERSION = '1.0';
const TOKEN_TTL_S = 12 * 60 * 60;
const DATA_TTL_MS = 10 * 60 * 1000;
// In-isolate memo. caches.default is a no-op on *.workers.dev, so the Cache API
// silently never hit; a module-level variable does hit for the life of the isolate.
let dataMemo = null; // { at: ms, body }
const ALLOWED_ORIGINS = ['https://app.operationsdirector.co.uk', 'https://chaichoong.github.io'];
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const READ_FIELDS = {
  tenancies: [F.tenPayStatus, F.tenRent, F.tenDueDay, F.tenPayFreq, F.tenSurname, F.tenUnitRef, F.tenProperty, F.tenStatus, F.tenEndDate, F.tenLinkedTenant, F.tenNextDueDate, F.tenPaidThisMonth, F.tenDaysOverdue],
  rentalUnits: [F.unitStatus, F.unitPropName, F.unitName],
  tenants: [F.tenantPayType],
  costs: [F.costName, F.costExpected, F.costPayStatus, F.costInactive, F.costBusiness, F.costSubCategory, F.costCategory],
  transactions: [F.txDate, F.txReportAmount, F.txSubCategory, F.txProperty, F.txTenancy, F.txUnit],
  subCategories: [F.subCatName],
  categories: [F.catName],
  properties: [F.propShortName, F.propName],
  tasks: [F.taskName, F.taskStatus, F.taskAssignee, F.taskTeamMember, F.taskDescription, F.taskNotes, F.taskDueDate, F.taskPriority, F.taskPriorityLvl, F.taskMaintenance, F.taskProperties, F.taskContractor],
};

// ── HTTP helpers ──
function corsHeaders(origin) {
  const ok = origin && (ALLOWED_ORIGINS.includes(origin) || DEV_ORIGIN.test(origin));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Origin' };
  if (ok) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}
const json = (body, status, origin) => new Response(JSON.stringify(body), { status, headers: corsHeaders(origin) });
const err = (msg, status, origin) => json({ ok: false, error: msg }, status, origin);

// ── Session tokens: base64url(payload).base64url(hmac) ──
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function signToken(payload, secret) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64u(sig)}`;
}
async function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64u(sig), enc.encode(body)); } catch { ok = false; }
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(unb64u(body))); } catch { return null; }
  if (!payload || !payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload;
}
function timingSafeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ── Airtable ──
async function airtableRequest(env, path, init = {}, attempt = 0) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 429 && attempt < 5) {
    await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    return airtableRequest(env, path, init, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Airtable ${res.status} on ${path.split('?')[0]}: ${text.slice(0, 200)}`);
  }
  return res.json();
}
async function fetchAll(env, table, fields, filterByFormula) {
  const out = [];
  let offset = '';
  do {
    const p = new URLSearchParams();
    p.set('returnFieldsByFieldId', 'true');
    p.set('pageSize', '100');
    for (const f of fields) p.append('fields[]', f);
    if (filterByFormula) p.set('filterByFormula', filterByFormula);
    if (offset) p.set('offset', offset);
    const page = await airtableRequest(env, `${table}?${p.toString()}`);
    out.push(...(page.records || []));
    offset = page.offset || '';
  } while (offset);
  return out;
}
const TX_FILTER = `AND(ARRAYJOIN({${NAMES.txBusiness}})='${REAL_ESTATE_NAME}', IS_AFTER({${NAMES.txDate}}, DATEADD(TODAY(), -13, 'month')))`;
const OPEN_TASK_FILTER = `AND({${NAMES.taskStatus}}!='Completed',{${NAMES.taskStatus}}!='Cancelled')`;

async function loadData(env) {
  const [tenancies, rentalUnits, tenants, costs, subCategories, categories, properties] = await Promise.all([
    fetchAll(env, TABLES.tenancies, READ_FIELDS.tenancies),
    fetchAll(env, TABLES.rentalUnits, READ_FIELDS.rentalUnits),
    fetchAll(env, TABLES.tenants, READ_FIELDS.tenants),
    fetchAll(env, TABLES.costs, READ_FIELDS.costs),
    fetchAll(env, TABLES.subCategories, READ_FIELDS.subCategories),
    fetchAll(env, TABLES.categories, READ_FIELDS.categories),
    fetchAll(env, TABLES.properties, READ_FIELDS.properties),
  ]);
  const transactions = await fetchAll(env, TABLES.transactions, READ_FIELDS.transactions, TX_FILTER);
  return { tenancies, rentalUnits, tenants, costs, subCategories, categories, properties, transactions };
}
async function loadTasks(env) {
  const [tasks, properties] = await Promise.all([
    fetchAll(env, TABLES.tasks, READ_FIELDS.tasks, OPEN_TASK_FILTER),
    fetchAll(env, TABLES.properties, READ_FIELDS.properties),
  ]);
  const propNames = buildNameMap(properties, F.propShortName);
  return shapeTasks(tasks, propNames, londonNow());
}

// ── Handlers ──
async function handleLogin(request, env, origin) {
  if (env.LOGIN_LIMIT) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.LOGIN_LIMIT.limit({ key: ip });
    if (!success) return err('Too many attempts. Wait a minute and try again.', 429, origin);
  }
  let body;
  try { body = await request.json(); } catch { return err('Bad request', 400, origin); }
  const pass = String(body && body.passcode || '');
  if (!pass || !env.PM_SESSION_SECRET) return err('Passcode required', 401, origin);
  let who = '';
  if (env.PM_PASSCODE && timingSafeEqual(pass, env.PM_PASSCODE)) who = 'Roy Lavin';
  else if (env.PM_PASSCODE_KEVIN && timingSafeEqual(pass, env.PM_PASSCODE_KEVIN)) who = 'Kevin Brittain';
  if (!who) return err('That passcode is not recognised.', 401, origin);
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  const token = await signToken({ who, exp }, env.PM_SESSION_SECRET);
  return json({ ok: true, token, exp, who }, 200, origin);
}

async function requireAuth(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return verifyToken(token, env.PM_SESSION_SECRET);
}

async function handleData(request, env, ctx, origin) {
  const url = new URL(request.url);
  const refresh = url.searchParams.get('refresh') === '1';
  if (!refresh && dataMemo && Date.now() - dataMemo.at < DATA_TTL_MS) {
    return json({ ...dataMemo.body, cached: true }, 200, origin);
  }
  const data = await loadData(env);
  // CONTROL: the transaction filter matches a display name ("Real Estate"). A
  // rename returns zero rows with 200 OK, and a dashboard of zeros looks like a
  // quiet month. Refuse to serve it.
  if (!data.transactions.length) throw new Error('Transaction read returned zero rows: check the Real Estate business name in TX_FILTER');
  const computed = computeAll(data, londonNow());
  computed.version = VERSION;
  dataMemo = { at: Date.now(), body: computed };
  return json({ ...computed, cached: false }, 200, origin);
}

// The Worker clock is UTC. Every window, stamp and "overdue" here is a London
// question, so build a Date whose LOCAL getters read London wall-clock time.
export function londonNow(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
}

async function handleTaskWrite(request, env, origin, taskId, who) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(taskId)) return err('Bad task id', 400, origin);
  let body;
  try { body = await request.json(); } catch { return err('Bad request', 400, origin); }
  const status = body && body.status != null ? String(body.status) : '';
  const note = body && body.note != null ? String(body.note).trim() : '';
  if (!status && !note) return err('Nothing to save', 400, origin);
  if (status && !ROY_STATUS_ALLOW.includes(status)) return err(`Status must be one of ${ROY_STATUS_ALLOW.join(', ')}`, 400, origin);
  if (note.length > 2000) return err('Note is too long (2,000 characters max)', 400, origin);

  // Scope guard: read the task first; refuse anything outside Roy's lane.
  const task = await airtableRequest(env, `${TABLES.tasks}/${taskId}?returnFieldsByFieldId=true`);
  if (!isRoyScope(task)) return err('That task is not on the property lane.', 403, origin);
  // A closed task is never rewritten: re-completing would overwrite the original
  // Completion Date the AI-share KPI is time-weighted on.
  if (!isTaskOpen(task)) return err('That task is already closed.', 409, origin);

  const fields = {};
  const now = londonNow();
  if (status) {
    fields[F.taskStatus] = status;
    if (status === 'Completed') fields[F.taskCompletion] = now.toISOString();
  }
  if (note) fields[F.taskNotes] = appendNote(task.fields[F.taskNotes], note, who, now);
  // Airtable keys a PATCH response by field NAME whatever the query says, so
  // the reply is built from what was written, not read back off the response.
  await airtableRequest(env, `${TABLES.tasks}/${taskId}`, { method: 'PATCH', body: JSON.stringify({ fields, typecast: false }) });
  // Audit line, deliberate (decision 8 Sep 2026): every write Roy's page makes
  // is visible in the Worker logs. Carries the task id and the signer, no secret.
  console.log(JSON.stringify({ event: 'task-write', taskId, who, status: status || undefined, noteChars: note.length || undefined }));
  return json({ ok: true, task: { id: taskId, status: status || String(task.fields[F.taskStatus] || ''), notes: fields[F.taskNotes] != null ? fields[F.taskNotes] : String(task.fields[F.taskNotes] || '') } }, 200, origin);
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (origin && !corsHeaders(origin)['Access-Control-Allow-Origin']) return err('Origin not allowed', 403, '');

    try {
      if (path === '/health' && request.method === 'GET') return json({ ok: true, version: VERSION }, 200, origin);
      if (path === '/login' && request.method === 'POST') return await handleLogin(request, env, origin);

      const session = await requireAuth(request, env);
      if (!session) return err('Sign in needed', 401, origin);

      if (path === '/data' && request.method === 'GET') return await handleData(request, env, ctx, origin);
      if (path === '/tasks' && request.method === 'GET') return json({ ok: true, who: session.who, tasks: await loadTasks(env) }, 200, origin);
      const m = path.match(/^\/task\/(rec[A-Za-z0-9]+)$/);
      if (m && request.method === 'POST') return await handleTaskWrite(request, env, origin, m[1], session.who);
      return err('Not found', 404, origin);
    } catch (e) {
      console.error(JSON.stringify({ event: 'error', path, message: String(e && e.message || e) }));
      return err('Something went wrong reading the data. Try again in a minute.', 502, origin);
    }
  },
};
