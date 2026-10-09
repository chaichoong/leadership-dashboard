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
//   POST /login-airtable { pat }               → { token, exp, who }  Kevin inside the OD app:
//                      the Worker asks Airtable who owns the key and signs in only
//                      when the owner is PM_KEVIN_AIRTABLE_ID. The key is never stored.
//   GET  /data         Bearer token            → computed dashboard (cached 10 min; ?refresh=1 bypasses)
//   GET  /tasks        Bearer token            → Roy-scope open tasks (never cached)
//   POST /task/:id     Bearer token { status?, note?, due?, reopen? } → { ok, task }
//                      due = YYYY-MM-DD (or "" to clear) and the status follows it the
//                      way the Tasks page does; reopen = undo a Complete within 15 min
//   GET  /health                               → { ok, version }
//
// The tenant details form (4 Oct 2026, task recrmZTcOHg8vPlZk). A tenant's link code, sent as
// `code` in the JSON body (never a header or the URL, so no request log holds it), is his pass for
// his own record and nothing else; no session needed:
//   POST /tenant-form/open   { code }          → { ok, firstName }   (never his saved answers)
//   POST /tenant-form        { code, answers } → { ok, savedAt, saved }
//   POST /tenant-form/upload { code, filename, contentType, file } → { ok }
// And, signed in (Kevin or Roy), the link itself:
//   POST /tenant-form/link     { tenantId }    → { ok, url, expires, firstName }
//   POST /tenant-form/link/off { tenantId }    → { ok }
// And the robots' own key (Cash Flow Voids lane C, 5 Oct 2026), which opens this one route and nothing else:
//   POST /tenant-form/robot-link { tenantId }  Authorization: Robot <PM_ROBOT_KEY>
//                      → { ok, url, expires, firstName }, or 409 { error, expires } while a live link stands
//                      (a robot never cuts off a link a tenant may be using; a person's button still can)
//
// Secrets (wrangler secret put):
//   AIRTABLE_PAT        - read on the property tables + write on Tasks
//   PM_PASSCODE         - Roy's passcode
//   PM_PASSCODE_KEVIN   - Kevin's passcode for the same page (notes sign as him)
//   PM_SESSION_SECRET   - HMAC key for session tokens
//   PM_KEVIN_AIRTABLE_ID - Kevin's Airtable user id (usr…), the only owner /login-airtable accepts
//   PM_ROBOT_KEY        - the robots' key for /tenant-form/robot-link only (~/.config/od/pm_robot_key on the Mac)
// Bindings: LOGIN_LIMIT (ratelimit, optional) — 5 attempts per minute per IP.
//           TENANT_LIMIT (ratelimit, optional) — the tenant form's public routes, per IP.
//           TENANT_ALL (ratelimit, optional) — the same routes, all callers together.

import { computeAll, shapeTasks, isRoyScope, isTaskOpen, appendNote, buildNameMap, statusForDue, dateKey, txWindowStart } from './compute.mjs';
import { BASE, TABLES, F, NAMES, REC, REAL_ESTATE_NAME, ROY_STATUS_ALLOW, GP, GP_TABLES, GP_TICKS, GP_UPLIFT_VALUES, GP_ROW_STATUS, GP_ROW_FIELDS, GP_TASK_FIELDS, GP_LIVE_TENANCIES, GP_COST_FILTER, GP_PM_TENANT_OMIT, GP_TENANT_FORM_FIELDS, TENANT_LINK, TENANT_ANSWERS, TENANT_ANSWERS_RETIRED } from './fields.mjs';

const VERSION = '1.2';
const TOKEN_TTL_S = 12 * 60 * 60;
const DATA_TTL_MS = 10 * 60 * 1000;
// In-isolate memo. caches.default is a no-op on *.workers.dev, so the Cache API
// silently never hit; a module-level variable does hit for the life of the isolate.
let dataMemo = null; // { at: ms, body }
const ALLOWED_ORIGINS = ['https://app.operationsdirector.co.uk', 'https://chaichoong.github.io'];
const DEV_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const READ_FIELDS = {
  tenancies: [F.tenPayStatus, F.tenRent, F.tenDueDay, F.tenPayFreq, F.tenSurname, F.tenUnitRef, F.tenProperty, F.tenStatus, F.tenEndDate, F.tenLinkedTenant, F.tenUnit, F.tenNextDueDate, F.tenDaysOverdue, F.tenStartDate],
  rentalUnits: [F.unitStatus, F.unitPropName, F.unitName, F.unitType],
  tenants: [F.tenantPayType, F.tenantName, F.tenantPhone, F.tenantEmail, F.tenantStatus],
  costs: [F.costName, F.costExpected, F.costPayStatus, F.costInactive, F.costBusiness, F.costSubCategory, F.costCategory],
  transactions: [F.txDate, F.txReportAmount, F.txSubCategory, F.txProperty, F.txTenancy, F.txUnit, F.txName, F.txVendor],
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
async function airtableRequest(env, path, init = {}, attempt = 0, retries = 5) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 429 && attempt < retries) {
    await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
    return airtableRequest(env, path, init, attempt + 1, retries);
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
// Starts the day before the oldest whole month the 12-month average needs, so
// the window is stated exactly rather than inferred from "13 months ago".
const txFilter = (today) => `AND(ARRAYJOIN({${NAMES.txBusiness}})='${REAL_ESTATE_NAME}', IS_AFTER({${NAMES.txDate}}, DATETIME_PARSE('${txWindowStart(today)}', 'YYYY-MM-DD')))`;
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
  const transactions = await fetchAll(env, TABLES.transactions, READ_FIELDS.transactions, txFilter(londonNow()));
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
  if (await rateLimited(request, env)) return err('Too many attempts. Wait a minute and try again.', 429, origin);
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

async function rateLimited(request, env) {
  if (!env.LOGIN_LIMIT) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const { success } = await env.LOGIN_LIMIT.limit({ key: ip });
  return !success;
}

// Kevin inside the OD app already holds an Airtable key. Airtable says whose
// key it is; only Kevin's user id is accepted. A key for any other account,
// a revoked key, or an Airtable outage all fall back to the passcode screen.
async function handleLoginAirtable(request, env, origin) {
  if (await rateLimited(request, env)) return err('Too many attempts. Wait a minute and try again.', 429, origin);
  let body;
  try { body = await request.json(); } catch { return err('Bad request', 400, origin); }
  const pat = String(body && body.pat || '').trim();
  if (!pat || !env.PM_SESSION_SECRET || !env.PM_KEVIN_AIRTABLE_ID) return err('Sign in needed', 401, origin);
  let owner = '';
  try {
    const res = await fetch('https://api.airtable.com/v0/meta/whoami', { headers: { Authorization: `Bearer ${pat}` } });
    if (res.ok) owner = String((await res.json()).id || '');
  } catch { owner = ''; }
  if (!owner || !timingSafeEqual(owner, env.PM_KEVIN_AIRTABLE_ID)) return err('That key does not belong to an allowed account.', 401, origin);
  // Owning a key is not enough: a narrow-scope key of Kevin's with no access to
  // this base must not open a session with write access to tasks (review, 13 Sep 2026).
  let reachesBase = false;
  try {
    const probe = await fetch(`https://api.airtable.com/v0/${BASE}/${TABLES.tasks}?maxRecords=1&fields%5B%5D=${F.taskName}`, { headers: { Authorization: `Bearer ${pat}` } });
    reachesBase = probe.ok;
  } catch { reachesBase = false; }
  if (!reachesBase) return err('That key cannot read the property base.', 401, origin);
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_S;
  const token = await signToken({ who: 'Kevin Brittain', exp }, env.PM_SESSION_SECRET);
  return json({ ok: true, token, exp, who: 'Kevin Brittain' }, 200, origin);
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
  // Edge cache (works only on the custom domain). Memo above covers the isolate;
  // this covers every isolate in the colo for DATA_TTL_MS.
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request('https://pm.operationsdirector.co.uk/__cache/data');
  if (!refresh && cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.json();
      dataMemo = { at: Date.now(), body };
      return json({ ...body, cached: true }, 200, origin);
    }
  }
  const data = await loadData(env);
  // CONTROL: the transaction filter matches a display name ("Real Estate"). A
  // rename returns zero rows with 200 OK, and a dashboard of zeros looks like a
  // quiet month. Refuse to serve it.
  if (!data.transactions.length) throw new Error('Transaction read returned zero rows: check the Real Estate business name in TX_FILTER');
  const computed = computeAll(data, londonNow(), new Date().toISOString());
  computed.version = VERSION;
  dataMemo = { at: Date.now(), body: computed };
  if (cache) ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(computed), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `s-maxage=${Math.floor(DATA_TTL_MS / 1000)}` } })));
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
  let status = body && body.status != null ? String(body.status) : '';
  const note = body && body.note != null ? String(body.note).trim() : '';
  const hasDue = body && body.due !== undefined;
  const due = hasDue ? String(body.due || '') : null;
  const reopen = !!(body && body.reopen);
  if (!status && !note && !hasDue) return err('Nothing to save', 400, origin);
  if (status && !ROY_STATUS_ALLOW.includes(status)) return err(`Status must be one of ${ROY_STATUS_ALLOW.join(', ')}`, 400, origin);
  if (hasDue && due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return err('Due date must be YYYY-MM-DD', 400, origin);
  if (note.length > 2000) return err('Note is too long (2,000 characters max)', 400, origin);

  // Scope guard: read the task first; refuse anything outside Roy's lane.
  const task = await airtableRequest(env, `${TABLES.tasks}/${taskId}?returnFieldsByFieldId=true`);
  if (!isRoyScope(task)) return err('That task is not on the property lane.', 403, origin);
  const now = londonNow();
  const todayKey = dateKey(now);
  const stored = String(task.fields[F.taskStatus] || '');
  // A closed task is never rewritten: re-completing would overwrite the original
  // Completion Date the AI-share KPI is time-weighted on. The one exception is
  // an undo: a Complete from this page can be taken back within 15 minutes.
  if (!isTaskOpen(task)) {
    const completedAt = Date.parse(task.fields[F.taskCompletion] || '');
    const recent = Number.isFinite(completedAt) && Date.now() - completedAt < 15 * 60 * 1000;
    if (!(reopen && stored === 'Completed' && recent && status && status !== 'Completed')) return err('That task is already closed.', 409, origin);
  }

  const fields = {};
  if (hasDue) {
    fields[F.taskDueDate] = due || null;
    // Status follows the date, exactly as the Tasks page does; an explicit
    // Completed in the same save still wins.
    if (status !== 'Completed') status = statusForDue(due, stored, todayKey);
  }
  if (reopen && !hasDue) {
    // Undo of a Complete: the task goes back to where its date puts it
    // (Overdue if the date has passed), never to a status it did not have.
    status = statusForDue(String(task.fields[F.taskDueDate] || '').slice(0, 10), '', todayKey);
  }
  if (status) {
    fields[F.taskStatus] = status;
    if (status === 'Completed') fields[F.taskCompletion] = now.toISOString();
    else if (reopen) fields[F.taskCompletion] = null;
  }
  if (note) fields[F.taskNotes] = appendNote(task.fields[F.taskNotes], note, who, now);
  // Airtable keys a PATCH response by field NAME whatever the query says, so
  // the reply is built from what was written, not read back off the response.
  await airtableRequest(env, `${TABLES.tasks}/${taskId}`, { method: 'PATCH', body: JSON.stringify({ fields, typecast: false }) });
  // Audit line, deliberate (decision 8 Sep 2026): every write Roy's page makes
  // is visible in the Worker logs. Carries the task id and the signer, no secret.
  console.log(JSON.stringify({ event: 'task-write', taskId, who, status: status || undefined, due: hasDue ? (due || 'cleared') : undefined, reopen: reopen || undefined, noteChars: note.length || undefined }));
  return json({ ok: true, task: { id: taskId, status: status || stored, due: hasDue ? due : String(task.fields[F.taskDueDate] || '').slice(0, 10), notes: fields[F.taskNotes] != null ? fields[F.taskNotes] : String(task.fields[F.taskNotes] || '') } }, 200, origin);
}

// ── The tenant details form (Kevin approved the plan on 1 Oct 2026, task recrmZTcOHg8vPlZk) ──
// A public page writing a date of birth and a National Insurance number to a live record with no
// login: the code in the tenant's link is the only key, so everything here is about that code.
//   * 16 random bytes and an 8-byte HMAC tag over them (PM_SESSION_SECRET), base64url: 32
//     characters. The tag is checked first, with no read at all, so a made-up code never reaches
//     Airtable, from any number of addresses or locations (review, 4 Oct 2026). The record keeps
//     only the code's SHA-256, so reading the base never gives anyone a working link. A new link
//     replaces the hash (the old one dies); "off" blanks it. A blank expiry is off too. The link
//     lives LINK_DAYS days. Changing PM_SESSION_SECRET ends every link, as it ends every session.
//   * Bad shape, no match, two matches, expired, switched off: one answer, the same words, so a
//     guesser learns nothing. The code is checked against CODE_RE and HASHED before it goes near a
//     formula, so nothing a visitor typed is ever placed in a filterByFormula.
//   * He may write TENANT_ANSWERS and nothing else: one unknown key refuses the whole save. A
//     blank answer is dropped, never written, so the form cannot wipe what is on the record.
//     typecast is OFF, so a stranger cannot add a choice to a dropdown.
//   * The page gets his first name and never his saved answers: a leaked link shows a first name
//     and an empty form. Logs carry the record id and counts, never a value; the code travels in the
//     JSON body, so no request log keeps it either.
//   * Every public request costs one Airtable read, and the base allows 5 a second for the whole
//     estate. So two rate limits sit in front of it (per caller, IPv6 by its /64, and all callers
//     together), and a public route never retries a refused Airtable call (review, 4 Oct 2026).
const LINK_DAYS = 14;
const CODE_RE = /^[A-Za-z0-9_-]{32}$/;
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf'];
// Airtable's upload takes 5MB a request, and base64 grows a file by a third: the same ceiling
// as growth-plan.html's own upload.
const UPLOAD_LIMIT = Math.floor(3.7 * 1024 * 1024);
const UPLOAD_MAX_FILES = 10;     // on the record in total, so one link cannot fill it
const TENANT_PAGE = 'https://app.operationsdirector.co.uk/tenant-details.html';
const PUBLIC_RETRIES = 0;
// What the first bytes of each allowed type look like, so a file is what it says it is.
const MAGIC = {
  'image/jpeg': b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF,
  'image/png': b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47,
  'application/pdf': b => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46,
  // HEIC and HEIF are ISO boxes: "ftyp" at byte 4.
  'image/heic': b => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
  'image/heif': b => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70,
};
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf', 'image/heic': 'heic', 'image/heif': 'heif' };
const LINK_GONE = 'This link is not working. Reply to the email or text we sent you and we will send you a new one.';

function validDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Pure, so the tests drive it. { fields } keyed by field id, or { error } in words for the tenant.
export function cleanTenantAnswers(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Nothing was filled in.' };
  const fields = {};
  for (const [key, raw] of Object.entries(input)) {
    // A question the form asked until 6 Oct 2026 (a page left open from before): dropped, never written.
    if (TENANT_ANSWERS_RETIRED.includes(key)) continue;
    const spec = Object.prototype.hasOwnProperty.call(TENANT_ANSWERS, key) ? TENANT_ANSWERS[key] : null;
    // Refused, not trimmed: a form sending a field it does not show has been tampered with.
    if (!spec) return { error: 'That form has a question we do not recognise. Reload the page and try again.' };
    if (raw != null && typeof raw === 'object') return { error: 'One answer is not in a form we can save.' };
    const s = String(raw == null ? '' : raw).trim();
    if (!s) continue;
    if (spec.kind === 'text') {
      if (s.length > spec.max) return { error: 'One answer is too long.' };
      fields[spec.id] = s;
    } else if (spec.kind === 'phone') {
      if (!/^[\d\s()+-]{7,25}$/.test(s) || s.replace(/\D/g, '').length < 10) return { error: 'That mobile number does not look right.' };
      fields[spec.id] = s;
    } else if (spec.kind === 'email') {
      if (s.length > spec.max || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return { error: 'That email address does not look right.' };
      fields[spec.id] = s;
    } else if (spec.kind === 'dob') {
      const y = Number(s.slice(0, 4));
      if (!validDay(s) || y < 1920 || y > 2010) return { error: 'That date of birth does not look right.' };
      fields[spec.id] = s;
    } else if (spec.kind === 'ni') {
      const ni = s.replace(/\s+/g, '').toUpperCase();
      if (!/^[A-Z]{2}\d{6}[A-D]$/.test(ni)) return { error: 'A National Insurance number looks like AB 12 34 56 C.' };
      fields[spec.id] = ni;
    } else if (spec.kind === 'day') {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 1 || n > 31) return { error: 'The payment day is a number from 1 to 31.' };
      fields[spec.id] = n;
    } else if (spec.kind === 'money') {
      const n = Number(s.replace(/[£,\s]/g, ''));
      if (!Number.isFinite(n) || n < 0 || n > 5000) return { error: 'A weekly amount is a number of pounds from 0 to 5,000.' };
      fields[spec.id] = Math.round(n * 100) / 100;
    } else if (spec.kind === 'choice') {
      if (!spec.choices.includes(s)) return { error: 'Pick one of the choices on the form.' };
      fields[spec.id] = s;
    }
  }
  if (!Object.keys(fields).length) return { error: 'Nothing was filled in.' };
  return { fields };
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(String(s)));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// The tag a link code carries: the first 8 bytes of an HMAC over its 16 random bytes.
async function linkTag(env, nonce) {
  const msg = new Uint8Array([...enc.encode('tenant-link:'), ...nonce]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env.PM_SESSION_SECRET), msg)).slice(0, 8);
}
async function makeLinkCode(env) {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  return b64u(new Uint8Array([...nonce, ...(await linkTag(env, nonce))]));
}
// True only for a code this Worker made: checked with no read, so a guess costs nothing.
export async function codeIsOurs(env, code) {
  if (!CODE_RE.test(String(code || '')) || !env.PM_SESSION_SECRET) return false;
  let raw;
  try { raw = unb64u(String(code)); } catch { return false; }
  if (raw.length !== 24) return false;
  const tag = await linkTag(env, raw.slice(0, 16));
  let diff = 0;
  for (let i = 0; i < 8; i++) diff |= tag[i] ^ raw[16 + i];
  return diff === 0;
}

// The one tenant this code belongs to, or null for every way it can fail.
async function tenantForCode(env, code) {
  if (!(await codeIsOurs(env, code))) return null;
  const hash = await sha256Hex(code);                       // hex only: safe inside the formula
  const p = new URLSearchParams();
  p.set('returnFieldsByFieldId', 'true');
  p.set('maxRecords', '2');
  p.set('filterByFormula', `{${TENANT_LINK.codeHashName}}='${hash}'`);
  for (const f of [GP.tenant.name, GP.tenant.notes, GP.tenant.documents, TENANT_LINK.codeHash, TENANT_LINK.codeExpires]) p.append('fields[]', f);
  const rows = (await airtableRequest(env, `${TABLES.tenants}?${p.toString()}`, {}, 0, PUBLIC_RETRIES)).records || [];
  if (rows.length !== 1) return null;                       // exactly one, or refuse
  const row = rows[0];
  // The formula matched by NAME; the hash is proved again by field ID, so a renamed field can never
  // let a row through that does not carry this code.
  if (!timingSafeEqual(String(row.fields[TENANT_LINK.codeHash] || ''), hash)) return null;
  const exp = String(row.fields[TENANT_LINK.codeExpires] || '').slice(0, 10);
  if (!exp || exp < dateKey(londonNow())) return null;      // no expiry = switched off
  return row;
}

// IPv6 hands out whole blocks, so a caller is counted by its /64, not by one address. The address
// is expanded first ("2001:db8::1" and "2001:db8::2" are one /64), and an IPv4 address written as
// IPv6 ("::ffff:1.2.3.4") counts as that IPv4 address.
export function callerKey(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return 'unknown';
  if (!s.includes(':')) return s;
  const v4 = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  const halves = s.split('::');
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  return groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':') + '::/64';
}
// Two limits, in this order inside handleTenantForm: the caller's own first; then the code's tag;
// then the limit everyone shares. So neither a refused caller nor a made-up code ever uses up a
// slot a real tenant needs (reviews, 4 Oct 2026).
async function callerLimited(request, env) {
  return !!env.TENANT_LIMIT && !(await env.TENANT_LIMIT.limit({ key: callerKey(request.headers.get('CF-Connecting-IP')) })).success;
}
async function allLimited(env) {
  return !!env.TENANT_ALL && !(await env.TENANT_ALL.limit({ key: 'tenant-form' })).success;
}

const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const SAVED_NOTE = "Tenant details form saved from the tenant's own link";
async function handleTenantForm(request, env, origin, path) {
  if (request.method !== 'POST') return err('Not found', 404, origin);
  const busy = 'Too many tries. Wait a minute and try again.';
  if (await callerLimited(request, env)) return err(busy, 429, origin);
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > 6 * 1024 * 1024) return err('That file is too big. The most is 3.7MB.', 413, origin);
  let body;
  try { body = await request.json(); } catch { return err('Bad request', 400, origin); }
  if (!(await codeIsOurs(env, body && body.code))) return err(LINK_GONE, 404, origin);
  if (await allLimited(env)) return err(busy, 429, origin);
  const row = await tenantForCode(env, body.code);
  if (!row) return err(LINK_GONE, 404, origin);
  if (path === '/tenant-form/open') {
    return json({ ok: true, firstName: firstNameOf(row.fields[GP.tenant.name]) }, 200, origin);
  }
  const now = londonNow();
  if (path === '/tenant-form') {
    const clean = cleanTenantAnswers(body.answers);
    if (clean.error) return err(clean.error, 400, origin);
    const n = Object.keys(clean.fields).length;
    const fields = { ...clean.fields, [GP.tenant.formLastSaved]: new Date().toISOString() };
    // One Notes line a day, naming the answers (never their values), so repeated saves cannot fill
    // the field; Tenant Form Last Saved carries the latest time. Notes is read and written by field
    // id in the same request (CLAUDE.md, 28 Sep 2026).
    const notes = String(row.fields[GP.tenant.notes] || '');
    const today = `[${dateKey(now)} `;
    if (!notes.split('\n').some(l => l.startsWith(today) && l.includes(SAVED_NOTE))) {
      const names = Object.keys(body.answers).filter(k => Object.prototype.hasOwnProperty.call(TENANT_ANSWERS, k)
        && clean.fields[TENANT_ANSWERS[k].id] !== undefined).map(k => TENANT_ANSWERS[k].label);
      fields[GP.tenant.notes] = appendNote(notes, `${SAVED_NOTE}: ${names.join(', ')}.`, 'tenant link', now);
    }
    await airtableRequest(env, `${TABLES.tenants}/${row.id}`, { method: 'PATCH', body: JSON.stringify({ fields, typecast: false }) }, 0, PUBLIC_RETRIES);
    console.log(JSON.stringify({ event: 'tenant-form-save', tenantId: row.id, answers: n }));
    return json({ ok: true, saved: n, savedAt: hhmm(now) }, 200, origin);
  }
  if (path === '/tenant-form/upload') {
    const type = String(body.contentType || '').toLowerCase();
    const file = String(body.file || '');
    if (!UPLOAD_TYPES.includes(type)) return err('Send a photo (JPEG, PNG or HEIC) or a PDF.', 400, origin);
    if (!file || !/^[A-Za-z0-9+/]+={0,2}$/.test(file)) return err('That file could not be read. Try again.', 400, origin);
    // The bytes must be what the type says: a page cannot be stored by calling it a photo.
    let head;
    try { head = Uint8Array.from(atob(file.slice(0, 16)), c => c.charCodeAt(0)); } catch { head = new Uint8Array(0); }
    if (!MAGIC[type](head)) return err('That file is not a photo or a PDF we can read. Try another.', 400, origin);
    const bytes = Math.floor(file.length * 3 / 4) - (file.endsWith('==') ? 2 : file.endsWith('=') ? 1 : 0);
    if (bytes > UPLOAD_LIMIT) return err('That file is too big. The most is 3.7MB: take the photo again a little further away.', 413, origin);
    const held = Array.isArray(row.fields[GP.tenant.documents]) ? row.fields[GP.tenant.documents].length : 0;
    if (held >= UPLOAD_MAX_FILES) return err('We have enough files for now. Reply to our message if you need to send more.', 409, origin);
    const base = String(body.filename || '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'statement';
    const filename = `Tenant upload ${dateKey(now)} ${base}.${EXT[type]}`;
    const res = await fetch(`https://content.airtable.com/v0/${BASE}/${row.id}/${GP.tenant.documents}/uploadAttachment`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: type, file, filename }),
    });
    if (!res.ok) throw new Error(`Airtable upload ${res.status}`);
    console.log(JSON.stringify({ event: 'tenant-form-upload', tenantId: row.id, bytes, type }));
    return json({ ok: true }, 200, origin);
  }
  return err('Not found', 404, origin);
}

// Signed in: Kevin or Roy makes a tenant's link, or switches it off. The record is found by
// LISTING the tenants table (a GET by id would answer for a record in any table).
async function tenantById(env, id) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(id || ''))) return null;
  const p = new URLSearchParams();
  p.set('returnFieldsByFieldId', 'true');
  p.set('maxRecords', '1');
  p.set('filterByFormula', `RECORD_ID()='${id}'`);
  for (const f of [GP.tenant.name, TENANT_LINK.codeHash, TENANT_LINK.codeExpires]) p.append('fields[]', f);
  const rows = (await airtableRequest(env, `${TABLES.tenants}?${p.toString()}`)).records || [];
  return rows.length === 1 && rows[0].id === id ? rows[0] : null;
}

// The robots' key: one route, compared in constant time, and nothing at all while the secret is unset.
export function isRobot(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return !!env.PM_ROBOT_KEY && auth.startsWith('Robot ') && timingSafeEqual(auth.slice(6), env.PM_ROBOT_KEY);
}

async function handleTenantLink(request, env, origin, off, who, robot = false) {
  let body;
  try { body = await request.json(); } catch { return err('Bad request', 400, origin); }
  const row = await tenantById(env, body && body.tenantId);
  if (!row) return err('That is not a tenant', 400, origin);
  const live = String(row.fields[TENANT_LINK.codeExpires] || '').slice(0, 10);
  if (robot && row.fields[TENANT_LINK.codeHash] && live && live >= dateKey(londonNow())) {
    // A new link ends the old one. A robot never does that to a tenant who may be using it.
    return json({ ok: false, error: 'This tenant already has a live form link', expires: live }, 409, origin);
  }
  if (off) {
    await airtableRequest(env, `${TABLES.tenants}/${row.id}`, { method: 'PATCH', body: JSON.stringify({ fields: { [TENANT_LINK.codeHash]: null, [TENANT_LINK.codeExpires]: null }, typecast: false }) });
    console.log(JSON.stringify({ event: 'tenant-link-off', tenantId: row.id, who }));
    return json({ ok: true }, 200, origin);
  }
  const code = await makeLinkCode(env);
  const until = londonNow();
  until.setDate(until.getDate() + LINK_DAYS);
  const expires = dateKey(until);
  await airtableRequest(env, `${TABLES.tenants}/${row.id}`, { method: 'PATCH', body: JSON.stringify({ fields: { [TENANT_LINK.codeHash]: await sha256Hex(code), [TENANT_LINK.codeExpires]: expires }, typecast: false }) });
  console.log(JSON.stringify({ event: 'tenant-link', tenantId: row.id, who, expires }));
  // After the #, the code is never sent to the web host or kept in its logs.
  return json({ ok: true, url: `${TENANT_PAGE}#c=${code}`, expires, firstName: firstNameOf(row.fields[GP.tenant.name]) }, 200, origin);
}

// ── Growth Plan (Kevin, 18 Sep 2026) ────────────────────────────────────────
// Roy's Growth Plan tab runs the SAME page as Kevin's. This hands back the same seven
// table reads, raw and by field ID, so the page normalises and prices them with
// js/growth-plan-model.js exactly as it does for Kevin: one page, one set of maths, one
// Airtable. Never cached: a tick has to show the moment it is made.
async function loadGrowthPlan(env) {
  const [props, units, tenants, tenancies, costs, planRows, settingRows] = await Promise.all([
    fetchAll(env, TABLES.properties, Object.values(GP.prop)),
    fetchAll(env, TABLES.rentalUnits, Object.values(GP.unit)),
    fetchAll(env, TABLES.tenants, Object.values(GP.tenant).filter(id => !GP_PM_TENANT_OMIT.includes(id))),
    fetchAll(env, TABLES.tenancies, Object.values(GP.tenancy), GP_LIVE_TENANCIES),
    fetchAll(env, TABLES.costs, Object.values(GP.cost), GP_COST_FILTER),
    fetchAll(env, GP_TABLES.growthPlan, Object.values(GP.plan)),
    fetchAll(env, GP_TABLES.growthPlanSettings, Object.values(GP.settings)),
  ]);
  return { props, units, tenants, tenancies, costs, planRows, settingRows };
}

// Every growth plan write passes through here. The rule is Kevin's (18 Sep 2026): Roy works
// the checklist. A property, a rental unit, a strategy, a council tax band and a frozen
// starting figure have no route at all, so there is nothing to get past.
async function handleGrowthPlanWrite(request, env, origin, what, who) {
  const body = await request.json().catch(() => ({}));
  if (what === 'tick') {
    const fieldId = GP_TICKS[String(body.field || '')];
    const id = String(body.tenantId || '');
    if (!fieldId || !/^rec[A-Za-z0-9]+$/.test(id)) return err('That is not a checklist tick', 400, origin);
    const value = body.field === 'rentUplift'
      ? (GP_UPLIFT_VALUES.includes(body.value) ? body.value : null)
      : (typeof body.value === 'boolean' ? body.value : null);
    if (value === null) return err('That tick value is not allowed', 400, origin);
    await airtableRequest(env, `${TABLES.tenants}/${id}`, { method: 'PATCH', body: JSON.stringify({ fields: { [fieldId]: value }, typecast: true }) });
    console.log(JSON.stringify({ event: 'growth-tick', tenantId: id, field: body.field, who }));
    return json({ ok: true, records: [{ id, fields: { [fieldId]: value } }] }, 200, origin);
  }
  if (what === 'tenant') {
    const id = String(body.tenantId || '');
    if (!/^rec[A-Za-z0-9]+$/.test(id)) return err('That is not a tenant', 400, origin);
    const fields = {};
    for (const [k, v] of Object.entries(body.fields || {})) if (GP_TENANT_FORM_FIELDS.includes(k)) fields[k] = v;
    if (!Object.keys(fields).length) return err('Nothing on that form belongs to Roy', 400, origin);
    await airtableRequest(env, TABLES.tenants, { method: 'PATCH', body: JSON.stringify({ records: [{ id, fields }], typecast: true }) });
    console.log(JSON.stringify({ event: 'growth-tenant-form', tenantId: id, fields: Object.keys(fields).length, who }));
    return json({ ok: true, records: [{ id, fields }] }, 200, origin);
  }
  if (what === 'row') {
    const fields = {};
    for (const [k, v] of Object.entries(body.fields || {})) if (GP_ROW_FIELDS.includes(k)) fields[k] = v;
    const status = fields[GP.plan.status];
    if (status != null && !GP_ROW_STATUS.includes(status)) return err('That move status is not allowed', 400, origin);
    if (!Object.keys(fields).length) return err('Nothing to save on that move', 400, origin);
    // Both go to the COLLECTION: a single-record URL takes {fields}, not {records:[…]},
    // and the page needs records[0] back either way.
    const id = String(body.id || '');
    const res = await airtableRequest(env, GP_TABLES.growthPlan, {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify({ records: [id ? { id, fields } : { fields }], typecast: true, returnFieldsByFieldId: true }),
    });
    console.log(JSON.stringify({ event: 'growth-row', id: id || 'new', status, who }));
    return json({ ok: true, records: res.records || [res] }, 200, origin);
  }
  if (what === 'task') {
    const fields = {};
    for (const [k, v] of Object.entries(body.fields || {})) if (GP_TASK_FIELDS.includes(k)) fields[k] = v;
    if (!fields[F.taskName]) return err('A task needs a name', 400, origin);
    fields[F.taskBusiness] = [REC.bizRealEstate];   // property work only, whatever was asked for
    const res = await airtableRequest(env, TABLES.tasks, { method: 'POST', body: JSON.stringify({ records: [{ fields }], typecast: true }) });
    console.log(JSON.stringify({ event: 'growth-task', name: String(fields[F.taskName]).slice(0, 80), who }));
    return json({ ok: true, records: res.records }, 200, origin);
  }
  return err('Not found', 404, origin);
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
      if (path === '/login-airtable' && request.method === 'POST') return await handleLoginAirtable(request, env, origin);
      // The tenant's own routes: his link code is his pass, so they sit before the sign-in.
      if (path === '/tenant-form' || path === '/tenant-form/open' || path === '/tenant-form/upload') return await handleTenantForm(request, env, origin, path);
      // The robots' key opens this route and no other: it is not a session token, so every route below refuses it.
      if (path === '/tenant-form/robot-link' && request.method === 'POST') {
        // The limit first, so wrong keys are counted too: a guess costs a slot like any other try.
        if (await callerLimited(request, env)) return err('Too many tries. Wait a minute and try again.', 429, origin);
        if (!isRobot(request, env)) return err('Sign in needed', 401, origin);
        return await handleTenantLink(request, env, origin, false, 'robot', true);
      }

      const session = await requireAuth(request, env);
      if (!session) return err('Sign in needed', 401, origin);

      if (path === '/data' && request.method === 'GET') return await handleData(request, env, ctx, origin);
      if (path === '/tasks' && request.method === 'GET') return json({ ok: true, who: session.who, tasks: await loadTasks(env) }, 200, origin);
      if (path === '/growth-plan' && request.method === 'GET') return json({ ok: true, who: session.who, generatedAt: new Date().toISOString(), ...(await loadGrowthPlan(env)) }, 200, origin);
      const g = path.match(/^\/growth-plan\/(tick|tenant|row|task)$/);
      if (g && request.method === 'POST') return await handleGrowthPlanWrite(request, env, origin, g[1], session.who);
      if ((path === '/tenant-form/link' || path === '/tenant-form/link/off') && request.method === 'POST') return await handleTenantLink(request, env, origin, path.endsWith('/off'), session.who);
      const m = path.match(/^\/task\/(rec[A-Za-z0-9]+)$/);
      if (m && request.method === 'POST') return await handleTaskWrite(request, env, origin, m[1], session.who);
      return err('Not found', 404, origin);
    } catch (e) {
      console.error(JSON.stringify({ event: 'error', path, message: String(e && e.message || e) }));
      return err('Something went wrong reading the data. Try again in a minute.', 502, origin);
    }
  },
};
