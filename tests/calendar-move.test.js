import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// MOVING OR REMOVING A DIARY ENTRY THE ROBOT WROTE (Kevin, 18 Oct 2026). When an appointment
// whose entry is already in his diary moves or is cancelled, the new card names the earlier
// diary task (REPLACES: or CANCELS:), and on his approval calendar-write.py moves or removes
// THAT entry, found in its own ledger, never by searching the diary. These drive the real
// parser, the real cmd_create (Airtable and the worker faked) and the real worker fetch handler.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const OLD = 'recOldDiaryAaaaaa';
const NEW = 'recNewDiaryAaaaaa';

function py(code) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, argparse
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import agent_calendar_format as F
spec = importlib.util.spec_from_file_location("cw", ${JSON.stringify(join(SCRIPTS, 'calendar-write.py'))})
cw = importlib.util.module_from_spec(spec); spec.loader.exec_module(cw)
${code}
`], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const block = (head) => `CALENDAR:\n${head}\n---\nThe surgery moved the check-up.\n**Carrying this out will involve:** changing the entry in your diary.`;
const MOVE = block(`REPLACES: ${OLD}\nTITLE: Dentist, Example Dental\nSTART: 2099-10-31 10:00\nEND: 2099-10-31 10:30`);
const CANCEL = block(`CANCELS: ${OLD}`);

describe('the diary block shapes', () => {
  it('reads a move and a removal, and refuses a removal that carries anything else or a bad id', () => {
    const r = py(`
out = [F.parse_calendar(${JSON.stringify(MOVE)})["replaces"], F.parse_calendar(${JSON.stringify(CANCEL)})]
for bad in [${JSON.stringify(block(`CANCELS: ${OLD}\nTITLE: x`))}, ${JSON.stringify(block('REPLACES: the dentist one\nTITLE: x\nSTART: 2099-10-31 10:00\nEND: 2099-10-31 10:30'))}]:
    try:
        F.parse_calendar(bad); out.append("NOT REFUSED")
    except F.CalendarFormatError as e:
        out.append(str(e))
print(json.dumps(out))`);
    expect(r[0]).toBe(OLD);
    expect(r[1]).toEqual({ cancels: OLD, summary: 'The surgery moved the check-up.' });
    expect(r[2]).toMatch(/carries nothing else, got TITLE/);
    expect(r[3]).toMatch(/REPLACES must be the earlier diary task's record id/);
  });
});

function create(output, ledgerRows, taskId = NEW) {
  const dir = mkdtempSync(join(tmpdir(), 'calmove-'));
  const ledger = join(dir, 'calendar-created.jsonl');
  writeFileSync(ledger, ledgerRows.map((r) => JSON.stringify(r)).join('\n') + (ledgerRows.length ? '\n' : ''));
  const r = py(`
cw.LEDGER = ${JSON.stringify(ledger)}
cw.STATE_DIR = ${JSON.stringify(dir)}
IDS = dict(cw.AF, sentForApprovalBy="fld30Yw8SWYVp049g", approvedAt="fldr4Mvf2RzKvhZhi")
fields = {IDS["name"]: "CALENDAR: Dentist, Example Dental - Sat 31 Oct", IDS["approvalOutcome"]: {"name": "Approved as-is"},
          IDS["taskType"]: {"name": "Admin"}, IDS["agentOutput"]: ${JSON.stringify(output)},
          IDS["sentForApprovalBy"]: ["recAGENT000000001"], IDS["approvedAt"]: "2026-10-18T13:00:00.000Z"}
cw.get_task = lambda t: {"id": t, "createdTime": "2026-10-18T12:00:00.000Z", "fields": fields}
calls = []
def fake_worker(url, payload=None):
    calls.append({"url": url.rsplit("/", 2)[-2] + "/" + url.rsplit("/", 1)[-1], "payload": payload})
    return {"status": "ok", "id": (payload or {}).get("eventId", "evtNEW"), "htmlLink": "https://example.invalid/e"}
cw.worker_call = fake_worker
import io, contextlib
try:
    with contextlib.redirect_stdout(io.StringIO()):
        cw.cmd_create(argparse.Namespace(task=${JSON.stringify(taskId)}))
    exit_msg = ""
except SystemExit as e:
    exit_msg = str(e)
print(json.dumps({"exit": exit_msg, "calls": calls, "ledger": F.ledger_rows(cw.LEDGER),
                  "written": F.diary_written(${JSON.stringify(taskId)}, cw.LEDGER),
                  "entryNew": F.written_entry(${JSON.stringify(taskId)}, cw.LEDGER),
                  "entryOld": F.written_entry(${JSON.stringify(OLD)}, cw.LEDGER)}))`);
  return r;
}

const WROTE_OLD = [{ task: OLD, event: 'intent' }, { task: OLD, event: 'created', id: 'evtDENTIST1' }];

describe('calendar-write moves or removes only the entry its own ledger shows it wrote', () => {
  it('a REPLACES card moves that entry: one update call, no create, and the new task now holds it', () => {
    const r = create(MOVE, WROTE_OLD);
    expect(r.exit).toBe('');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toBe('calendar/update');
    expect(r.calls[0].payload).toMatchObject({ eventId: 'evtDENTIST1', title: 'Dentist, Example Dental', start: '2099-10-31T10:00:00' });
    expect(r.ledger.at(-1)).toMatchObject({ task: NEW, event: 'moved', id: 'evtDENTIST1', from: OLD });
    expect(r.written).toBe(true);
    expect(r.entryNew[0]).toBe('evtDENTIST1');   // a later move or removal can follow it
  });

  it('a CANCELS card removes that entry, and nothing can move or remove it again', () => {
    const r = create(CANCEL, WROTE_OLD);
    expect(r.exit).toBe('');
    expect(r.calls.map((c) => c.url)).toEqual(['calendar/delete']);
    expect(r.calls[0].payload).toMatchObject({ eventId: 'evtDENTIST1' });
    expect(r.ledger.at(-1)).toMatchObject({ task: NEW, event: 'deleted', id: 'evtDENTIST1', from: OLD });
    expect(r.written).toBe(true);
    expect(r.entryOld[1]).toMatch(/already been removed/);
  });

  it('refuses, with no worker call, when the earlier task has no entry the robot wrote', () => {
    for (const rows of [[], [{ task: OLD, event: 'intent' }]]) {
      const r = create(MOVE, rows);
      expect(r.exit).toMatch(/no diary entry written for recOldDiaryAaaaaa/);
      expect(r.calls).toEqual([]);
    }
  });

  it('refuses a card that names itself, and an entry already removed', () => {
    expect(create(block(`CANCELS: ${NEW}`), WROTE_OLD).exit).toMatch(/names itself/);
    const gone = [...WROTE_OLD, { task: 'recCancelledAaaaa', event: 'deleted', id: 'evtDENTIST1' }];
    const r = create(MOVE, gone);
    expect(r.exit).toMatch(/already been removed/);
    expect(r.calls).toEqual([]);
  });

  it('CONTROL: a plain diary block still creates a new entry', () => {
    const r = create(block('TITLE: Dentist, Example Dental\nSTART: 2099-10-31 10:00\nEND: 2099-10-31 10:30'), WROTE_OLD);
    expect(r.calls.map((c) => c.url)).toEqual(['calendar/create']);
  });
});

describe('the submit gate refuses a move or removal of an entry the robot never wrote', () => {
  it('names the reason before Kevin is asked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calref-'));
    const ledger = join(dir, 'l.jsonl');
    writeFileSync(ledger, WROTE_OLD.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = py(`print(json.dumps([F.calendar_ref_problem(${JSON.stringify(MOVE)}, ${JSON.stringify(ledger)}),
  F.calendar_ref_problem(${JSON.stringify(block('REPLACES: recNeverWrittenAa\nTITLE: x\nSTART: 2099-10-31 10:00\nEND: 2099-10-31 10:30'))}, ${JSON.stringify(ledger)}),
  F.calendar_ref_problem("TO: a@b.com\\n---\\nhello", ${JSON.stringify(ledger)})]))`);
    expect(r[0]).toBe('');
    expect(r[1]).toMatch(/no diary entry written for recNeverWrittenAa/);
    expect(r[2]).toBe('');
  });

  it('the real cmd_submit refuses it and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calsub-'));
    const out = join(dir, 'out.md');
    writeFileSync(out, block('REPLACES: recNeverWrittenAa\nTITLE: Dentist\nSTART: 2099-10-31 10:00\nEND: 2099-10-31 10:30'));
    const r = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys, types, io, contextlib
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import agent_calendar_format as F
F.CALENDAR_LEDGER = ${JSON.stringify(join(dir, 'empty.jsonl'))}
spec = importlib.util.spec_from_file_location("ad", ${JSON.stringify(join(SCRIPTS, 'agent-dispatch.py'))})
ad = importlib.util.module_from_spec(spec); spec.loader.exec_module(ad)
writes = []
ad.patch_task = lambda t, f: writes.append(f) or {"id": t}
ad.get_task = lambda t: {"id": t, "createdTime": "2026-10-18T10:00:00.000Z",
                         "fields": {ad.AF["name"]: "CALENDAR: Dentist - Sat 31 Oct", ad.AF["status"]: "Today", ad.AF["notes"]: ""}}
try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        ad.cmd_submit(types.SimpleNamespace(task="recTESTMOVE000001", agent=ad.RESPONSE_REC_ID, type="Admin",
                                            output_file=${JSON.stringify(out)}, tier1=False, receipt=None,
                                            plain_task="The dentist moved the appointment to a new time.", plain_approve="The entry in your diary moves to the new time."))
    print(json.dumps({"exit": "", "writes": len(writes)}))
except SystemExit as e:
    print(json.dumps({"exit": str(e), "writes": len(writes)}))`], { encoding: 'utf8' }).trim().split('\n').pop());
    expect(r.exit).toMatch(/no diary entry written for recNeverWrittenAa/);
    expect(r.writes).toBe(0);
  });
});

describe('review round 1 (18 Oct 2026): the writer passes the stamp, refuses stale cards and fails safe', () => {
  it('a create carries the task for the stamp; a move and a removal carry the creating task', () => {
    const plain = create(block('TITLE: Dentist\nSTART: 2099-10-31 10:00\nEND: 2099-10-31 10:30'), []);
    expect(plain.calls[0].payload.task).toBe(NEW);
    expect(create(MOVE, WROTE_OLD).calls[0].payload.createdBy).toBe(OLD);
    expect(create(CANCEL, WROTE_OLD).calls[0].payload.createdBy).toBe(OLD);
    // A chain: OLD created it, MID moved it; a card naming MID still carries OLD, the creator.
    const MID = 'recMidDiaryAaaaaa';
    const chain = [...WROTE_OLD, { task: MID, event: 'moved', id: 'evtDENTIST1', from: OLD }];
    expect(create(block(`CANCELS: ${MID}`), chain).calls[0].payload.createdBy).toBe(OLD);
  });

  it('a card naming an earlier task that a later card already moved is refused, naming the newer one', () => {
    const MID = 'recMidDiaryAaaaaa';
    const r = create(MOVE, [...WROTE_OLD, { task: MID, event: 'moved', id: 'evtDENTIST1', from: OLD }]);
    expect(r.exit).toMatch(/changed since by recMidDiaryAaaaaa; name recMidDiaryAaaaaa instead/);
    expect(r.calls).toEqual([]);
  });

  it('a half-written or run-together ledger line naming this task still refuses a second write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calraw-'));
    const ledger = join(dir, 'calendar-created.jsonl');
    writeFileSync(ledger, JSON.stringify(WROTE_OLD[1]) + '\n' + `{"task": "${NEW}", "event": "int\n`);
    const r = py(`
cw.LEDGER = ${JSON.stringify(ledger)}
cw.STATE_DIR = ${JSON.stringify(dir)}
IDS = dict(cw.AF, sentForApprovalBy="fld30Yw8SWYVp049g", approvedAt="fldr4Mvf2RzKvhZhi")
fields = {IDS["name"]: "CALENDAR: x", IDS["approvalOutcome"]: {"name": "Approved as-is"}, IDS["taskType"]: {"name": "Admin"},
          IDS["agentOutput"]: ${JSON.stringify(MOVE)}, IDS["sentForApprovalBy"]: ["recAGENT000000001"], IDS["approvedAt"]: "2026-10-18T13:00:00.000Z"}
cw.get_task = lambda t: {"id": t, "createdTime": "2026-10-18T12:00:00.000Z", "fields": fields}
calls = []
cw.worker_call = lambda u, p=None: calls.append(u) or {}
try:
    cw.cmd_create(argparse.Namespace(task=${JSON.stringify(NEW)})); print(json.dumps({"exit": "", "calls": calls}))
except SystemExit as e:
    print(json.dumps({"exit": str(e), "calls": calls}))`);
    expect(r.exit).toMatch(/already in the ledger/);
    expect(r.calls).toEqual([]);
  });

  it('an entry whose created row is missing is refused before any intent is written', () => {
    const r = create(MOVE, [{ task: OLD, event: 'moved', id: 'evtDENTIST1', from: 'recGoneAaaaaaaaaa' }]);
    expect(r.exit).toMatch(/cannot prove it made it/);
    expect(r.calls).toEqual([]);
    expect(r.ledger.filter((x) => x.task === NEW)).toEqual([]);
  });

  it('a move to a time already past is refused', () => {
    const r = create(block(`REPLACES: ${OLD}\nTITLE: Dentist\nSTART: 2020-01-05 10:00\nEND: 2020-01-05 10:30`), WROTE_OLD);
    expect(r.exit).toMatch(/in the past/);
    expect(r.calls).toEqual([]);
  });
});

describe('the worker moves and removes only an entry the robot created (the real fetch handler)', () => {
  const env = { GMAIL_SEND_KEY: 'k', GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's',
                GMAIL_AUTH: { get: async () => 'refresh', list: async () => ({ keys: [] }) } };
  const google = [];
  afterEach(() => { vi.unstubAllGlobals(); google.length = 0; });
  // existing: what a GET of the entry returns ({ stamp, status } or { http: 404 }).
  const call = async (path, body, { key = 'k', existing = { stamp: OLD, status: 'confirmed' }, writeStatus = 200 } = {}) => {
    vi.stubGlobal('fetch', async (u, init = {}) => {
      if (String(u).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'a' }));
      const method = init.method || 'GET';
      google.push({ url: String(u), method, body: init.body ? JSON.parse(init.body) : null });
      if (method === 'GET') {
        if (existing.http) return new Response('{}', { status: existing.http });
        return new Response(JSON.stringify({ id: 'evtDENTIST1', status: existing.status,
          extendedProperties: existing.stamp ? { private: { odTask: existing.stamp } } : undefined }));
      }
      if (writeStatus !== 200) return new Response('{}', { status: writeStatus });
      return new Response(JSON.stringify({ id: 'evtDENTIST1', status: 'confirmed', htmlLink: 'https://example.invalid/e' }));
    });
    const { default: worker } = await import('../workers/drive-upload/worker.js');
    const res = await worker.fetch(new Request('https://w.invalid' + path, { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
    return { status: res.status, json: await res.json() };
  };
  const writes = () => google.filter((g) => g.method !== 'GET');
  const MOVE_BODY = { eventId: 'evtDENTIST1', createdBy: OLD, title: 'Dentist', start: '2099-10-31T10:00:00',
                      end: '2099-10-31T10:30:00', timeZone: 'Europe/London', description: 'not sent' };

  it('create stamps the entry with the task that created it', async () => {
    await call('/calendar/create', { title: 'Dentist', start: '2099-10-27T10:00:00', end: '2099-10-27T10:30:00',
      timeZone: 'Europe/London', task: OLD });
    expect(google[0].method).toBe('POST');
    expect(google[0].body.extendedProperties).toEqual({ private: { odTask: OLD } });
  });

  it('update reads the entry, then PATCHes title and time only, emailing nobody', async () => {
    const r = await call('/calendar/update', MOVE_BODY);
    expect(r.status).toBe(200);
    expect(google.map((g) => g.method)).toEqual(['GET', 'PATCH']);
    expect(writes()[0].url).toMatch(/\/events\/evtDENTIST1\?sendUpdates=none$/);
    expect(writes()[0].body).toEqual({ summary: 'Dentist', start: { dateTime: '2099-10-31T10:00:00', timeZone: 'Europe/London' },
                                       end: { dateTime: '2099-10-31T10:30:00', timeZone: 'Europe/London' } });
  });

  it('refuses an entry the robot did not create, or created for another task: nothing is written', async () => {
    expect((await call('/calendar/delete', { eventId: 'evtDENTIST1', createdBy: OLD }, { existing: { status: 'confirmed' } })).status).toBe(403);
    expect((await call('/calendar/update', MOVE_BODY, { existing: { stamp: 'recSomeoneElseAaa', status: 'confirmed' } })).status).toBe(403);
    expect((await call('/calendar/delete', { eventId: 'evtDENTIST1' })).status).toBe(400);
    expect(writes()).toEqual([]);
  });

  it('an entry Kevin deleted by hand: a move fails loudly, a removal reads as gone', async () => {
    expect((await call('/calendar/update', MOVE_BODY, { existing: { stamp: OLD, status: 'cancelled' } })).status).toBe(409);
    expect((await call('/calendar/update', MOVE_BODY, { existing: { http: 404 } })).status).toBe(409);
    expect((await call('/calendar/delete', { eventId: 'evtDENTIST1', createdBy: OLD }, { existing: { stamp: OLD, status: 'cancelled' } })).json.status).toBe('gone');
    // Google may drop the stamp on an entry in the bin: a removal still reads as gone.
    expect((await call('/calendar/delete', { eventId: 'evtDENTIST1', createdBy: OLD }, { existing: { status: 'cancelled' } })).json.status).toBe('gone');
    expect(writes()).toEqual([]);
  });

  it('delete removes that one entry, emailing nobody; a 410 on the delete reads as gone', async () => {
    expect((await call('/calendar/delete', { eventId: 'evtDENTIST1', createdBy: OLD })).json.status).toBe('deleted');
    expect(writes()[0]).toMatchObject({ method: 'DELETE', url: expect.stringMatching(/\/events\/evtDENTIST1\?sendUpdates=none$/) });
    google.length = 0;
    expect((await call('/calendar/delete', { eventId: 'evtDENTIST1', createdBy: OLD }, { writeStatus: 410 })).json.status).toBe('gone');
  });

  it('refuses a missing event id, attendees and the wrong key, touching nothing', async () => {
    expect((await call('/calendar/delete', { createdBy: OLD })).status).toBe(400);
    expect((await call('/calendar/update', { ...MOVE_BODY, attendees: ['a@b.c'] })).status).toBe(400);
    expect((await call('/calendar/delete', { eventId: 'evtDENTIST1', createdBy: OLD }, { key: 'wrong' })).status).toBe(403);
    expect(google).toEqual([]);
  });
});
