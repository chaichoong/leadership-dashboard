// The send ledger holds two kinds of email (finding 20260923-agent-dispatch-573, 25 Sep 2026).
//
// `notify` (the "a task is now yours" note to a colleague) and `send` (the approved email to
// the outside world) share sent-email.jsonl and a task id. already_sent() matched on the id
// alone, so once a task was handed to Roy its real email was refused for ever: the Manchester
// council EICR reply (recKho3l7jJKk9T0t) and the Sefton EICR booking (recPFxDmGX5pbonD2).
// And a send that died between "about to send" and "sent" left an intent row nothing could
// settle (the Dave Dangelo decline, rec9IufIUW7DpxHZy).
//
// These drive the REAL cmd_send / cmd_notify / cmd_resolve_intent with the worker, Airtable and
// the Sent-folder search replaced by fakes and the ledger pointed at a temp file.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = JSON.stringify(path.join(root, 'scripts/send-email.py'));

const EMAIL = 'TO: housing@manchester.gov.uk\nFROM: kevinbrittain@gmail.com\nSUBJECT: 1406 Oldham Road EICR\n---\n'
  + 'Hello,\n\nPlease find the update below.\n\nKind regards,\nKevin Brittain\n\n'
  + '**Carrying this out will involve:** sending the reply to Manchester City Council.';

function run(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-kinds-'));
  const ledger = path.join(dir, 'sent-email.jsonl');
  if (opts.rows) fs.writeFileSync(ledger, opts.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, argparse
sys.argv = ["send-email.py"]
spec = importlib.util.spec_from_file_location("se", ${SCRIPT})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = json.loads(sys.stdin.read())
m.SENT_LEDGER = a["ledger"]; m.STATE_DIR = a["dir"]
calls, searches = [], []
F = {m.AF["name"]: "INBOUND: Manchester City Council EICR", m.AF["agentOutput"]: a["output"],
     m.AF["taskType"]: {"name": "Correspondence"}, m.AF["status"]: {"name": "Today"},
     m.AF["approvalOutcome"]: {"name": "Approved as-is"}}
def _get(tid):
    if a.get("airtableDown"):
        sys.exit("ERROR: Airtable GET 503: unavailable")
    return {"id": tid, "createdTime": "2026-08-30T09:00:00.000Z", "fields": F}
m.get_task = _get
m.load_approved.__globals__["approval_evidence_problem"] = lambda f, created: ""
def fake_worker(url, payload=None):
    calls.append(payload)
    if a.get("failWith"):
        sys.exit(a["failWith"])
    return {"id": "msg-%d" % len(calls)}
m.worker_call = fake_worker
m.api = lambda method, url, payload=None: {}
def fake_search(q, account):
    searches.append([q, account])
    if "newer_than:30d" in q:
        return a.get("control", [{"id": "c1"}])
    return a.get("hits", [])
m.sent_folder_search = fake_search
res = {"calls": calls, "searches": searches}
try:
    cmd = a["cmd"]
    if cmd == "send":
        m.cmd_send(argparse.Namespace(task="recKho3l7jJKk9T0t", dry_run=False, rule=None))
    elif cmd == "resolve":
        m.cmd_resolve_intent(argparse.Namespace(task="recKho3l7jJKk9T0t"))
    elif cmd == "sent?":
        res["prior"] = m.already_sent("recKho3l7jJKk9T0t", a.get("kind", "send"))
    res["exit"] = 0
except SystemExit as e:
    res["exit"] = e.code if isinstance(e.code, int) else 1
    res["message"] = str(e)
try:
    res["ledger"] = [json.loads(l) for l in open(a["ledger"]) if l.strip()]
except FileNotFoundError:
    res["ledger"] = []
print("---JSON---"); print(json.dumps(res))
`], { input: JSON.stringify({ output: EMAIL, ...opts, ledger, dir }), encoding: 'utf8' });
  return JSON.parse(out.split('---JSON---')[1]);
}

// The real shape of the rows that blocked recKho3l7jJKk9T0t: a notify from 31 Aug, no kind.
const OLD_NOTIFY = [
  { task: 'recKho3l7jJKk9T0t', ts: '2026-08-31T09:09:22.000Z', event: 'intent', to: ['roy.lavin1978@gmail.com'], cc: [], subject: 'Operations Director: a task is now yours' },
  { task: 'recKho3l7jJKk9T0t', ts: '2026-08-31T09:09:22.000Z', event: 'sent', to: ['roy.lavin1978@gmail.com'], cc: [], subject: 'Operations Director: a task is now yours' },
];

describe('the send ledger keeps notify and send apart', () => {
  it("a task handed to Roy can still send its approved email (the 31 Aug rows no longer block it)", () => {
    const r = run({ cmd: 'send', rows: OLD_NOTIFY });
    expect(r.exit).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].to).toBe('housing@manchester.gov.uk');
    expect(r.ledger.slice(-1)[0]).toMatchObject({ event: 'sent', kind: 'send' });
  });

  it('the old notify rows still count as a notify (no second "task is yours" email)', () => {
    const r = run({ cmd: 'sent?', kind: 'notify', rows: OLD_NOTIFY });
    expect(r.prior).toMatchObject({ event: 'sent', subject: 'Operations Director: a task is now yours' });
  });

  it('a real send is still never sent twice', () => {
    const rows = [{ task: 'recKho3l7jJKk9T0t', ts: '2026-09-25T10:00:00.000Z', event: 'sent', kind: 'send', to: ['housing@manchester.gov.uk'] }];
    const r = run({ cmd: 'send', rows });
    expect(r.message).toMatch(/was already sent at 2026-09-25T10:00:00.000Z/);
    expect(r.calls).toHaveLength(0);
  });
});

describe('a send that dies is recorded, and an unfinished one is settled from the Sent folder', () => {
  it('a worker refusal before anything left is `failed`, and the next run may send', () => {
    const a = run({ cmd: 'send', failWith: 'ERROR: worker 429: slow down' });
    expect(a.exit).not.toBe(0);
    expect(a.ledger.map((x) => x.event)).toEqual(['intent', 'failed']);
    const b = run({ cmd: 'send', rows: a.ledger });
    expect(b.exit).toBe(0);
    expect(b.calls).toHaveLength(1);
  });

  it('an unknown failure is `uncertain` and is never retried by itself', () => {
    const a = run({ cmd: 'send', failWith: 'ERROR: worker call failed: TimeoutError: timed out' });
    expect(a.ledger.map((x) => x.event)).toEqual(['intent', 'uncertain']);
    const b = run({ cmd: 'send', rows: a.ledger });
    expect(b.message).toMatch(/has an unfinished send .*resolve-intent/s);
    expect(b.calls).toHaveLength(0);
  });

  it('a `sent` row refuses for ever: the losing run of two overlapping sends cannot free it (second review)', () => {
    const rows = ['intent', 'intent', 'sent', 'failed'].map((event, i) => ({
      task: 'recKho3l7jJKk9T0t', ts: `2026-09-25T10:00:0${i}.000Z`, event, kind: 'send', to: ['housing@manchester.gov.uk'] }));
    const r = run({ cmd: 'send', rows });
    expect(r.message).toMatch(/was already sent/);
    expect(r.calls).toHaveLength(0);
    const legacy = run({ cmd: 'send', rows: [{ task: 'recKho3l7jJKk9T0t', ts: '2026-09-01T10:00:00.000Z', event: 'sent', to: ['housing@manchester.gov.uk'], subject: '1406 Oldham Road EICR' },
      { task: 'recKho3l7jJKk9T0t', ts: '2026-09-02T10:00:00.000Z', event: 'failed' }] });
    expect(legacy.message).toMatch(/was already sent/);
    const resolve = run({ cmd: 'resolve', rows: [...rows, { task: 'recKho3l7jJKk9T0t', ts: '2026-09-25T11:00:00.000Z', event: 'intent', kind: 'send', to: ['housing@manchester.gov.uk'] }] });
    expect(resolve.message).toMatch(/no unfinished send to resolve/);
  });

  it('resolve-intent reads the mailbox the row says it went from (an alias maps to its account) and matches the subject', () => {
    const rows = [{ task: 'recKho3l7jJKk9T0t', ts: '2026-09-23T15:09:00.000Z', event: 'intent', kind: 'send',
      from: 'kevin@operationsdirector.co.uk', to: ['dave@example.com'], subject: 'Re: Hey Kevin, about "Operations Director"' }];
    const r = run({ cmd: 'resolve', rows, hits: [] });
    expect(r.searches[1]).toEqual(['in:sent to:dave@example.com after:2026/09/22 subject:"Hey Kevin, about  Operations Director"', 'kevin@runpreneur.org.uk']);
  });

  it('resolve-intent refuses, and changes nothing, when an old row names no mailbox and the task cannot be read', () => {
    const rows = [{ task: 'recKho3l7jJKk9T0t', ts: '2026-09-23T15:09:00.000Z', event: 'intent', to: ['housing@manchester.gov.uk'] }];
    const r = run({ cmd: 'resolve', rows, airtableDown: true });
    expect(r.message).toMatch(/could not read recKho3l7jJKk9T0t to learn which mailbox sent it/);
    expect(r.ledger).toHaveLength(1);
    expect(r.searches).toHaveLength(0);
  });

  it('an `uncertain` send can be settled from the Sent folder too', () => {
    const rows = [{ task: 'recKho3l7jJKk9T0t', ts: '2026-09-23T15:09:00.000Z', event: 'intent', kind: 'send', from: 'kevinbrittain@gmail.com', to: ['housing@manchester.gov.uk'] },
      { task: 'recKho3l7jJKk9T0t', ts: '2026-09-23T15:09:30.000Z', event: 'uncertain', kind: 'send', error: 'timed out' }];
    const r = run({ cmd: 'resolve', rows, hits: [{ id: 'gm-9' }] });
    expect(r.ledger.slice(-1)[0]).toMatchObject({ event: 'sent', recovered: true });
  });

  it('an intent with nothing after it is refused with the way out, not "already sent"', () => {
    const rows = [{ task: 'recKho3l7jJKk9T0t', ts: '2026-09-23T15:09:00.000Z', event: 'intent', to: ['housing@manchester.gov.uk'] }];
    const r = run({ cmd: 'send', rows });
    expect(r.message).toMatch(/has an unfinished send .*resolve-intent recKho3l7jJKk9T0t/s);
    expect(r.calls).toHaveLength(0);
  });

  it('resolve-intent: nothing in the Sent folder clears it and the send may run; the sending mailbox is the one read', () => {
    const rows = [{ task: 'recKho3l7jJKk9T0t', ts: '2026-09-23T15:09:00.000Z', event: 'intent', to: ['housing@manchester.gov.uk'] }];
    const a = run({ cmd: 'resolve', rows, hits: [] });
    expect(a.exit).toBe(0);
    expect(a.searches).toEqual([
      ['in:sent newer_than:30d', 'kevinbrittain@gmail.com'],
      ['in:sent to:housing@manchester.gov.uk after:2026/09/22', 'kevinbrittain@gmail.com'],
    ]);
    expect(a.ledger.slice(-1)[0]).toMatchObject({ event: 'intent-cleared', kind: 'send' });
    const b = run({ cmd: 'send', rows: a.ledger });
    expect(b.exit).toBe(0);
    expect(b.calls).toHaveLength(1);
  });

  it('resolve-intent: the email found in Sent is recorded as sent, so it is never sent twice', () => {
    const rows = [{ task: 'recKho3l7jJKk9T0t', ts: '2026-09-23T15:09:00.000Z', event: 'intent', to: ['housing@manchester.gov.uk'] }];
    const a = run({ cmd: 'resolve', rows, hits: [{ id: 'gm-1' }] });
    expect(a.ledger.slice(-1)[0]).toMatchObject({ event: 'sent', recovered: true, messageId: 'gm-1' });
    const b = run({ cmd: 'send', rows: a.ledger });
    expect(b.message).toMatch(/already sent/);
    expect(b.calls).toHaveLength(0);
  });

  it('resolve-intent refuses a blind read (a Sent folder showing nothing in 30 days) and changes nothing', () => {
    const rows = [{ task: 'recKho3l7jJKk9T0t', ts: '2026-09-23T15:09:00.000Z', event: 'intent', to: ['housing@manchester.gov.uk'] }];
    const r = run({ cmd: 'resolve', rows, control: [] });
    expect(r.message).toMatch(/this read is blind/);
    expect(r.ledger).toHaveLength(1);
  });
});
