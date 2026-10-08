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
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-kinds-'));
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
if a.get("approvedAt"):
    F[m.AF["approvedAt"]] = a["approvedAt"]
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
    if "subject:" not in q:
        return a.get("recipientHits", a.get("hits", []))
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
    elif cmd == "notify":
        import io, contextlib
        F[m.AF["name"]] = "NEW TENANT RENT: journal upload: Unit 9 – 1 Example Road"
        roy = next(e for e, h in m.team_roster()[0].items() if h.get("name") == "Roy Lavin")
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                m.cmd_notify(argparse.Namespace(task="recKho3l7jJKk9T0t", to=roy, reason="standing handover", dry_run=False, again_after_days=a.get("again")))
        finally:
            res["printed"] = [json.loads(l) for l in buf.getvalue().splitlines() if l.strip().startswith("{")]
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

describe('a second email on one task (finding 20261002-agent-dispatch-716, 7 Oct 2026)', () => {
  // A task approved for a second round could never send: the ledger refused any send on a task that
  // had ever sent, and its card came back after every approval. Shaped from the two stuck cards (a
  // second contractor written to on the same certificate task); names and addresses are invented.
  const FIRST = { task: 'recKho3l7jJKk9T0t', ts: '2026-09-15T12:10:14.000Z', event: 'sent', kind: 'send',
    to: ['office@first-contractor.test'], cc: [], subject: 'Gas safety certificate - 1 Example Road' };
  const SECOND = 'TO: bookings@second-contractor.test\nFROM: kevinbrittain@gmail.com\nSUBJECT: Book a gas safety check - 1 Example Road\n---\n'
    + 'Hello,\n\nPlease book the gas safety check.\n\nKind regards,\nKevin Brittain\n\n'
    + '**Carrying this out will involve:** sending the booking to the second contractor.';

  it('a different email Kevin approved after the first one went is sent, and records its body fingerprint', () => {
    const r = run({ cmd: 'send', rows: [FIRST], output: SECOND, approvedAt: '2026-10-07T19:23:10.772Z' });
    expect(r.exit).toBe(0);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].to).toBe('bookings@second-contractor.test');
    expect(r.ledger.slice(-1)[0]).toMatchObject({ event: 'sent', kind: 'send', bodyHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });

  it('with no approval since the first send, nothing goes', () => {
    const r = run({ cmd: 'send', rows: [FIRST], output: SECOND, approvedAt: '2026-09-14T08:00:00.000Z' });
    expect(r.message).toMatch(/nothing has been approved since/);
    expect(r.calls).toHaveLength(0);
  });

  it('the same email approved again (an old page tab) is never sent twice', () => {
    const same = { ...FIRST, to: ['bookings@second-contractor.test'], subject: 'Book a gas safety check - 1 Example Road' };
    const r = run({ cmd: 'send', rows: [same], output: SECOND, approvedAt: '2026-10-07T19:23:10.772Z' });
    expect(r.message).toMatch(/this email .* already went at/s);
    expect(r.calls).toHaveLength(0);
  });

  it('same people and subject with a new body goes once its fingerprint differs, and the same body never twice', () => {
    const a = run({ cmd: 'send', rows: [FIRST], output: SECOND, approvedAt: '2026-10-07T19:23:10.772Z' });
    const sentRow = a.ledger.slice(-1)[0];
    const chase = SECOND.replace('Please book the gas safety check.', 'A reminder: please book the gas safety check.');
    const b = run({ cmd: 'send', rows: a.ledger, output: chase, approvedAt: '2026-10-08T09:00:00.000Z' });
    expect(b.exit).toBe(0);
    expect(b.calls).toHaveLength(1);
    const c = run({ cmd: 'send', rows: b.ledger, output: chase, approvedAt: '2026-10-08T10:00:00.000Z' });
    expect(c.calls).toHaveLength(0);
    expect(sentRow.bodyHash).not.toBe(b.ledger.slice(-1)[0].bodyHash);
  });

  it('a second send that died mid-way is refused until it is settled, never sent twice', () => {
    const rows = [FIRST, { task: 'recKho3l7jJKk9T0t', ts: '2026-10-07T20:00:00.000Z', event: 'intent', kind: 'send',
      to: ['bookings@second-contractor.test'], cc: [], subject: 'Book a gas safety check - 1 Example Road' }];
    const r = run({ cmd: 'send', rows, output: SECOND, approvedAt: '2026-10-07T19:23:10.772Z' });
    expect(r.message).toMatch(/has an unfinished send .*resolve-intent/s);
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
    // A later intent after the `sent` is an unfinished SECOND send (716, 7 Oct 2026): resolve-intent settles
    // it from the Sent folder rather than refusing, and the second email still needs a new approval.
    const resolve = run({ cmd: 'resolve', rows: [...rows, { task: 'recKho3l7jJKk9T0t', ts: '2026-09-25T11:00:00.000Z', event: 'intent', kind: 'send', to: ['housing@manchester.gov.uk'], subject: '1406 Oldham Road EICR' }] });
    expect(resolve.message || '').not.toMatch(/no unfinished send to resolve/);
    expect(resolve.ledger.slice(-1)[0].event).toMatch(/^(intent-cleared|sent)$/);
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

  it('a long subject is searched on whole words, and a subject miss with other mail to them is refused, never cleared (third review)', () => {
    const long = 'Re: Council Tax account 60012345 - 18 Siddows Avenue Clitheroe - request for the empty property exemption from 8 May 2026';
    const rows = [{ task: 'recKho3l7jJKk9T0t', ts: '2026-09-23T15:09:00.000Z', event: 'intent', kind: 'send', from: 'kevinbrittain@gmail.com', to: ['ctax@ribblevalley.gov.uk'], subject: long }];
    const a = run({ cmd: 'resolve', rows, hits: [], recipientHits: [] });
    const q = a.searches[1][0];
    const subj = q.match(/subject:"([^"]*)"/)[1];
    expect(subj.length).toBeLessThanOrEqual(80);
    expect(long).toContain(subj);
    expect(long.slice(4)).toMatch(new RegExp('^' + subj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' '));   // ends on a whole word
    const b = run({ cmd: 'resolve', rows, hits: [], recipientHits: [{ id: 'other' }] });
    expect(b.message).toMatch(/none matched the subject .* nothing was changed/s);
    expect(b.ledger).toHaveLength(1);
  });

  it('two runs sending one task wait for each other (the lock is held from the check to the last row)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-lock-'));
    const holder = `
import fcntl, os, time, sys
os.makedirs(os.path.join(sys.argv[1], "send-locks"), exist_ok=True)
fh = open(os.path.join(sys.argv[1], "send-locks", "recKho3l7jJKk9T0t.lock"), "a")
fcntl.flock(fh, fcntl.LOCK_EX); print("held", flush=True); time.sleep(1.5)`;
    const { spawn } = require('node:child_process');
    return new Promise((resolveP) => {
      const h = spawn('python3', ['-c', holder, dir]);
      h.stdout.once('data', () => {
        const t0 = Date.now();
        const r = run({ cmd: 'send', dir });
        const waited = Date.now() - t0;
        expect(r.exit).toBe(0);
        expect(waited).toBeGreaterThan(900);
        h.on('close', () => resolveP());
      });
    });
  });

  it('resolve-intent refuses while a send of the same task holds the lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-lock-'));
    const rows = [{ task: 'recKho3l7jJKk9T0t', ts: '2026-09-23T15:09:00.000Z', event: 'intent', kind: 'send', from: 'kevinbrittain@gmail.com', to: ['housing@manchester.gov.uk'] }];
    const holder = `
import fcntl, os, time, sys
os.makedirs(os.path.join(sys.argv[1], "send-locks"), exist_ok=True)
fh = open(os.path.join(sys.argv[1], "send-locks", "recKho3l7jJKk9T0t.lock"), "a")
fcntl.flock(fh, fcntl.LOCK_EX); print("held", flush=True); time.sleep(3)`;
    const { spawn } = require('node:child_process');
    return new Promise((resolveP) => {
      const h = spawn('python3', ['-c', holder, dir]);
      h.stdout.once('data', () => {
        const r = run({ cmd: 'resolve', rows, dir, hits: [] });
        expect(r.message).toMatch(/a send of recKho3l7jJKk9T0t is running now/);
        expect(r.ledger).toHaveLength(1);
        h.kill(); h.on('close', () => resolveP());
      });
    });
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

// 2 Oct 2026 (independent review of the rent check's lane B): `notify` wrote its intent row and,
// when the worker failed, nothing else. Every later call then read that lone intent as "already
// emailed", exited 0, and the colleague was never told. Back-tested: with the failed/uncertain
// row removed from cmd_notify the first case fails (the second run makes no worker call).
describe('a notify that dies is recorded, as a send is', () => {
  it('a worker refusal before anything left is `failed`, and the next call emails the task', () => {
    const a = run({ cmd: 'notify', failWith: 'ERROR: worker 500: Gmail send failed: quota' });
    expect(a.exit).not.toBe(0);
    expect(a.ledger.map((x) => [x.kind, x.event])).toEqual([['notify', 'intent'], ['notify', 'failed']]);
    const b = run({ cmd: 'notify', rows: a.ledger });
    expect(b.exit).toBe(0);
    expect(b.calls).toHaveLength(1);
    expect(b.printed[0].notified).toBe('recKho3l7jJKk9T0t');
    expect(b.ledger.slice(-1)[0]).toMatchObject({ kind: 'notify', event: 'sent' });
  });

  it('an unknown failure is `uncertain`: never sent twice, and the skip says so instead of "sent"', () => {
    const a = run({ cmd: 'notify', failWith: 'ERROR: worker call failed: TimeoutError: timed out' });
    expect(a.ledger.map((x) => x.event)).toEqual(['intent', 'uncertain']);
    const b = run({ cmd: 'notify', rows: a.ledger });
    expect(b.exit).toBe(0);
    expect(b.calls).toHaveLength(0);
    expect(b.printed[0]).toMatchObject({ skipped: 'recKho3l7jJKk9T0t', event: 'uncertain' });
  });

  it('a notify that went is skipped as sent, and a run that died before the worker answered as intent', () => {
    const sent = run({ cmd: 'notify' });
    expect(sent.printed[0].notified).toBe('recKho3l7jJKk9T0t');
    const again = run({ cmd: 'notify', rows: sent.ledger });
    expect(again.calls).toHaveLength(0);
    expect(again.printed[0]).toMatchObject({ skipped: 'recKho3l7jJKk9T0t', event: 'sent' });
    const died = run({ cmd: 'notify', rows: [sent.ledger[0]] });
    expect(died.printed[0]).toMatchObject({ skipped: 'recKho3l7jJKk9T0t', event: 'intent' });
  });
});

// The Task Board Manager's clock (7 Oct 2026) nudges Roy once a week on a physical task he has held
// seven days with no movement. notify sent once per task for ever, so the handover's own notify
// refused every reminder; --again-after-days lets one through once the last went N days ago, and
// never over a send that was cut off. Back-tested: dropping the age check sends inside the week.
describe('a reminder notify goes once the last one is old enough, never twice over a cut-off send', () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const sentRow = (n) => ({ task: 'recKho3l7jJKk9T0t', ts: day(n), event: 'sent', kind: 'notify', to: ['info@agilelets.co.uk'] });
  it('sent 8 days ago: the reminder goes', () => {
    const r = run({ cmd: 'notify', rows: [sentRow(8)], again: 7 });
    expect(r.calls).toHaveLength(1);
    expect(r.ledger.slice(-1)[0]).toMatchObject({ kind: 'notify', event: 'sent' });
  });
  it('sent 2 days ago: skipped as before', () => {
    const r = run({ cmd: 'notify', rows: [sentRow(2)], again: 7 });
    expect(r.calls).toHaveLength(0);
    expect(r.printed[0]).toMatchObject({ event: 'sent' });
  });
  it('a reminder that was cut off (intent after the last sent) is never sent again', () => {
    const cut = { task: 'recKho3l7jJKk9T0t', ts: day(1), event: 'intent', kind: 'notify' };
    expect(run({ cmd: 'notify', rows: [sentRow(8), cut], again: 7 }).calls).toHaveLength(0);
  });
  it('without the flag a sent notify still refuses for ever', () => {
    expect(run({ cmd: 'notify', rows: [sentRow(30)] }).calls).toHaveLength(0);
  });
});
