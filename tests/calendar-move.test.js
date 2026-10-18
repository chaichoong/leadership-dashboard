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
  it('cmd_submit calls it', () => {
    const src = readFileSync(join(SCRIPTS, 'agent-dispatch.py'), 'utf8');
    expect(src).toMatch(/cal_ref = calendar_ref_problem\(output\)\n\s+if cal_ref:\n\s+sys\.exit\(/);
  });
});

describe('the worker moves and removes one named entry (the real fetch handler)', () => {
  const env = { GMAIL_SEND_KEY: 'k', GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's',
                GMAIL_AUTH: { get: async () => 'refresh', list: async () => ({ keys: [] }) } };
  const google = [];
  afterEach(() => { vi.unstubAllGlobals(); google.length = 0; });
  const call = async (path, body, key = 'k', googleStatus = 200) => {
    vi.stubGlobal('fetch', async (u, init = {}) => {
      if (String(u).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'a' }));
      google.push({ url: String(u), method: init.method, body: init.body ? JSON.parse(init.body) : null });
      if (googleStatus !== 200) return new Response('{}', { status: googleStatus });
      return new Response(JSON.stringify({ id: 'evtDENTIST1', htmlLink: 'https://example.invalid/e' }));
    });
    const { default: worker } = await import('../workers/drive-upload/worker.js');
    const res = await worker.fetch(new Request('https://w.invalid' + path, { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);
    return { status: res.status, json: await res.json() };
  };

  it('update PATCHes that one event with the new time and no attendees', async () => {
    const r = await call('/calendar/update', { eventId: 'evtDENTIST1', title: 'Dentist', start: '2099-10-31T10:00:00',
      end: '2099-10-31T10:30:00', timeZone: 'Europe/London' });
    expect(r.status).toBe(200);
    expect(google).toHaveLength(1);
    expect(google[0]).toMatchObject({ method: 'PATCH', url: expect.stringMatching(/\/events\/evtDENTIST1$/) });
    expect(google[0].body.start).toEqual({ dateTime: '2099-10-31T10:00:00', timeZone: 'Europe/London' });
    expect(google[0].body.attendees).toBeUndefined();
  });

  it('delete DELETEs that one event; one already gone reads as gone, not a failure', async () => {
    expect((await call('/calendar/delete', { eventId: 'evtDENTIST1' })).json.status).toBe('deleted');
    expect(google[0]).toMatchObject({ method: 'DELETE', url: expect.stringMatching(/\/events\/evtDENTIST1$/) });
    google.length = 0;
    expect((await call('/calendar/delete', { eventId: 'evtDENTIST1' }, 'k', 410)).json.status).toBe('gone');
  });

  it('refuses a missing event id, attendees and the wrong key, touching nothing', async () => {
    expect((await call('/calendar/delete', {})).status).toBe(400);
    expect((await call('/calendar/update', { eventId: 'evtDENTIST1', title: 'x', start: 'a', end: 'b', timeZone: 'Europe/London', attendees: ['a@b.c'] })).status).toBe(400);
    expect((await call('/calendar/delete', { eventId: 'evtDENTIST1' }, 'wrong')).status).toBe(403);
    expect(google).toEqual([]);
  });
});
