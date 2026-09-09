import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker, { londonNow } from '../workers/property-manager/worker.js';
import { F, REC, ROY_EMAIL } from '../workers/property-manager/fields.mjs';

// The handler end to end with Airtable stubbed: the scope guard, the status
// allow-list, the closed-task refusal, and what leaves the Worker in /data.
const ORIGIN = 'https://app.operationsdirector.co.uk';
const env = { AIRTABLE_PAT: 'pat-test', PM_PASSCODE: 'roy-pass', PM_PASSCODE_KEVIN: 'kev-pass', PM_SESSION_SECRET: 'secret-123' };
const ctx = { waitUntil: () => {} };
const req = (path, init = {}, origin = ORIGIN) => new Request('https://pm.test' + path, { ...init, headers: { Origin: origin, 'Content-Type': 'application/json', ...(init.headers || {}) } });
const call = (r) => worker.fetch(r, env, ctx);

let airtable; // table path → body, or function(url, init) → body
beforeEach(() => {
  airtable = {};
  globalThis.fetch = vi.fn(async (url, init) => {
    const u = new URL(url);
    const key = u.pathname.replace(/^\/v0\/[^/]+\//, '');
    const hit = airtable[key];
    if (!hit) return new Response(JSON.stringify({ error: 'no stub for ' + key }), { status: 404 });
    const body = typeof hit === 'function' ? hit(u, init) : hit;
    return new Response(JSON.stringify(body), { status: 200 });
  });
});

async function login(pass) {
  const r = await call(req('/login', { method: 'POST', body: JSON.stringify({ passcode: pass }) }));
  return [r.status, await r.json()];
}

describe('login and origin', () => {
  it('refuses a wrong passcode and an unknown origin', async () => {
    expect((await login('nope'))[0]).toBe(401);
    const r = await call(req('/login', { method: 'POST', body: '{}' }, 'https://evil.example'));
    expect(r.status).toBe(403);
  });
  it('issues a token naming who signed in, and /data needs it', async () => {
    const [s, body] = await login('kev-pass');
    expect(s).toBe(200);
    expect(body.who).toBe('Kevin Brittain');
    expect((await call(req('/data'))).status).toBe(401);
    expect((await call(req('/data', { headers: { Authorization: 'Bearer ' + body.token + 'x' } }))).status).toBe(401);
  });
});

describe('task writes', () => {
  let auth;
  beforeEach(async () => { auth = { Authorization: 'Bearer ' + (await login('roy-pass'))[1].token }; });
  const write = (id, body) => call(req('/task/' + id, { method: 'POST', headers: auth, body: JSON.stringify(body) }));
  const task = (fields) => ({ id: 'recAAAAAAAAAAAAAA', fields });

  it('refuses a task outside the property lane before any PATCH', async () => {
    airtable['tblqB8b22hKBL4PF1/recAAAAAAAAAAAAAA'] = task({ [F.taskStatus]: 'Today', [F.taskAssignee]: { email: 'kevin@runpreneur.org.uk' } });
    const r = await write('recAAAAAAAAAAAAAA', { note: 'hi' });
    expect(r.status).toBe(403);
    expect(globalThis.fetch.mock.calls.some(([, init]) => init && init.method === 'PATCH')).toBe(false);
  });
  it('refuses a status outside the allow-list and refuses rewriting a closed task', async () => {
    airtable['tblqB8b22hKBL4PF1/recAAAAAAAAAAAAAA'] = task({ [F.taskStatus]: 'Completed', [F.taskMaintenance]: true });
    expect((await write('recAAAAAAAAAAAAAA', { status: 'Approval' })).status).toBe(400);
    expect((await write('recAAAAAAAAAAAAAA', { status: 'Completed' })).status).toBe(409);
    expect((await write('recAAAAAAAAAAAAAA', { note: 'late note' })).status).toBe(409);
  });
  it('writes status + appended signed note, stamping Completion Date only on Completed', async () => {
    airtable['tblqB8b22hKBL4PF1/recAAAAAAAAAAAAAA'] = (u, init) => (init && init.method === 'PATCH')
      ? { id: 'recAAAAAAAAAAAAAA', fields: {} }
      : task({ [F.taskStatus]: 'Upcoming', [F.taskAssignee]: { email: ROY_EMAIL }, [F.taskNotes]: 'earlier' });
    const r = await write('recAAAAAAAAAAAAAA', { status: 'Completed', note: 'done it' });
    expect(r.status).toBe(200);
    const patch = globalThis.fetch.mock.calls.find(([, init]) => init && init.method === 'PATCH');
    const sent = JSON.parse(patch[1].body).fields;
    expect(sent[F.taskStatus]).toBe('Completed');
    expect(sent[F.taskCompletion]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(sent[F.taskNotes]).toMatch(/^earlier\n\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} Roy Lavin\] done it$/);
    expect(Object.keys(sent).sort()).toEqual([F.taskStatus, F.taskNotes, F.taskCompletion].sort());
  });
});

describe('due date and undo', () => {
  let auth;
  beforeEach(async () => { auth = { Authorization: 'Bearer ' + (await login('roy-pass'))[1].token }; });
  const write = (id, body) => call(req('/task/' + id, { method: 'POST', headers: auth, body: JSON.stringify(body) }));
  const stub = (fields) => { airtable['tblqB8b22hKBL4PF1/recAAAAAAAAAAAAAA'] = (u, init) => (init && init.method === 'PATCH') ? { id: 'recAAAAAAAAAAAAAA', fields: {} } : { id: 'recAAAAAAAAAAAAAA', fields }; };
  const sentFields = () => JSON.parse(globalThis.fetch.mock.calls.find(([, init]) => init && init.method === 'PATCH')[1].body).fields;

  it('a new due date sets the status the way the Tasks page does', async () => {
    stub({ [F.taskStatus]: 'Today', [F.taskMaintenance]: true, [F.taskDueDate]: '2026-09-08' });
    const r = await write('recAAAAAAAAAAAAAA', { due: '2099-01-01' });
    expect(r.status).toBe(200);
    expect(sentFields()).toMatchObject({ [F.taskDueDate]: '2099-01-01', [F.taskStatus]: 'Upcoming' });
    expect((await r.json()).task).toMatchObject({ status: 'Upcoming', due: '2099-01-01' });
  });
  it('a past due date becomes Overdue; Approval stays Approval; a bad date is refused', async () => {
    stub({ [F.taskStatus]: 'Upcoming', [F.taskMaintenance]: true });
    await write('recAAAAAAAAAAAAAA', { due: '2020-01-01' });
    expect(sentFields()[F.taskStatus]).toBe('Overdue');
    globalThis.fetch.mockClear();
    stub({ [F.taskStatus]: 'Approval', [F.taskMaintenance]: true });
    await write('recAAAAAAAAAAAAAA', { due: '2020-01-01' });
    expect(sentFields()[F.taskStatus]).toBe('Approval');
    expect((await write('recAAAAAAAAAAAAAA', { due: '01/02/2026' })).status).toBe(400);
  });
  it('undo reopens a task completed in the last 15 minutes and clears its Completion Date, nothing older', async () => {
    stub({ [F.taskStatus]: 'Completed', [F.taskMaintenance]: true, [F.taskDueDate]: '2020-01-01', [F.taskCompletion]: new Date(Date.now() - 60 * 1000).toISOString() });
    const r = await write('recAAAAAAAAAAAAAA', { status: 'Today', reopen: true });
    expect(r.status).toBe(200);
    // Back to where its date puts it, not to the status the page guessed.
    expect(sentFields()).toEqual({ [F.taskStatus]: 'Overdue', [F.taskCompletion]: null });
    stub({ [F.taskStatus]: 'Completed', [F.taskMaintenance]: true, [F.taskCompletion]: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
    expect((await write('recAAAAAAAAAAAAAA', { status: 'Today', reopen: true })).status).toBe(409);
  });
});

describe('/data boundary', () => {
  it('fails loudly on zero transactions and never ships personal £ totals', async () => {
    const auth = { Authorization: 'Bearer ' + (await login('roy-pass'))[1].token };
    const empty = { records: [] };
    for (const t of ['tblN51a88qTDB6iMH', 'tblM3mZCR5kiEdWMj', 'tblX4elTuu01gwBYh', 'tblOTdRcPf8AgRz25', 'tbleWb8ioptnEwPR8', 'tbl6f0OkAmTC2jbuG']) airtable[t] = empty;
    airtable['tblx5kvhzNEI5TFlS'] = { records: [{ id: 'c1', fields: { [F.costPayStatus]: 'In Payment', [F.costExpected]: 999, [F.costBusiness]: [REC.bizPersonal] } }] };
    airtable['tbln0gzhCAorFc3zB'] = empty;
    let r = await call(req('/data', { headers: auth }));
    expect(r.status).toBe(502); // control: a broken filter must not render as a quiet month
    airtable['tbln0gzhCAorFc3zB'] = { records: [{ id: 'x', fields: { [F.txDate]: '2026-09-01', [F.txReportAmount]: 10, [F.txSubCategory]: [REC.subRentalInc] } }] };
    r = await call(req('/data?refresh=1', { headers: auth }));
    expect(r.status).toBe(200);
    const body = await r.json();
    // Running costs are the FULL fixed-cost total (Kevin, 9 Sep 2026): the £ is
    // in, the personal row itself is not.
    expect(body.planned.runningCosts).toBe(999);
    expect(body.planned.nonPropertyCount).toBe(1);
    expect(JSON.stringify(body)).not.toContain(REC.bizPersonal);
    expect(JSON.stringify(body)).not.toContain('"c1"');
  });
});

describe('londonNow', () => {
  it('reads London wall-clock time off a UTC instant', () => {
    const d = londonNow(new Date('2026-07-01T23:30:00Z')); // BST
    expect([d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]).toEqual([7, 2, 0, 30]);
    const w = londonNow(new Date('2026-01-15T23:30:00Z')); // GMT
    expect([w.getDate(), w.getHours()]).toEqual([15, 23]);
  });
});
