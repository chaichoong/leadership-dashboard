// NOTHING TRIAGE DECIDES STAYS IN THE INBOX (Kevin, 14 Oct 2026).
//
// "Anything I need to see should come as an approval card. But ensuring that
// feedback I give for anything I don't need to see is taken into consideration
// for the next time."
//
// Measured that day: 155 emails in the inbox, 110 of them already decided by
// the triage robot as "leave" (a person wrote it, Kevin should read it) or
// "answered" (we spoke last), the oldest from 17 Sep. `note` logged those
// decisions and changed nothing in Gmail, so every one of them stayed for ever,
// and the triage score read "0 waiting; at zero 7 of last 7 days" because left
// mail was excluded from "waiting" by design.
//
// These tests drive the REAL scripts/inbound-triage.py and the REAL
// scripts/agent-dispatch.py lesson writer, with Gmail and Airtable stubbed at
// the one function each goes through, and HOME pointed at a temp folder so
// nothing here can touch Kevin's agent files, logs or queue lock. Fixtures are
// invented: this repo is public.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const TRIAGE = resolve(SCRIPTS, 'inbound-triage.py');
const DISPATCH = resolve(SCRIPTS, 'agent-dispatch.py');
const RUNNER = resolve(SCRIPTS, 'inbound-triage-run.sh');

const RESPONSE = 'recJ8J8idWE8d97tH';   // Inbox Response, Team Members row
const READ_LABEL = '19: for Kevin to read';
const LABELS = [
  { id: 'L8', name: '8: task created' }, { id: 'L12', name: '12: kevin to respond' },
  { id: 'L13', name: '13: maintenance' }, { id: 'L19', name: READ_LABEL },
];

/** A fresh HOME (agent files, queue lock) and state folder (digests, scan cache). */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'inbox-left-home-'));
  const state = join(home, 'triage-state');
  mkdirSync(state, { recursive: true });
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  return { home, state };
}

/** Run a snippet against the real modules. `m` is inbound-triage, `ad` is
 *  agent-dispatch. Every Gmail call is recorded in CALLS and every card the
 *  gate would create in CREATED. The snippet calls out(obj) once. */
function runPy(box, snippet, setup = '') {
  const script = `
import importlib.util, json, sys, os
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
m = load('triage_under_test', ${JSON.stringify(TRIAGE)})
ad = load('dispatch_under_test', ${JSON.stringify(DISPATCH)})
m._fail_quiet["on"] = True
CALLS, CREATED = [], []
LABELS = ${JSON.stringify(LABELS)}
LISTS = {}            # gmail query fragment -> messages
def fake_worker(path, payload, sleep=None):
    CALLS.append({"path": path, "payload": payload})
    if path == "/gmail/labels":
        return {"labels": LABELS}
    if path == "/gmail/modify":
        return {"modified": len(payload.get("ids") or [])}
    if path == "/gmail/list":
        q = payload.get("q") or ""
        for frag, msgs in LISTS.items():
            if frag in q:
                return {"messages": msgs}
        return {"messages": []}
    raise AssertionError("unexpected worker call " + path)
m.worker_post = fake_worker
def fake_create(fields):
    CREATED.append(fields)
    return "recCARD%010d" % len(CREATED)
m._create_card = fake_create
def cache(entries):
    (m.base_dir() / "scan-cache.json").write_text(json.dumps(entries))
def attempt(fn):
    try:
        return fn(), None
    except SystemExit:
        return None, dict(m._last_fail)
def modifies():
    return [c["payload"] for c in CALLS if c["path"] == "/gmail/modify"]
def out(obj):
    print("RESULT " + json.dumps(obj))
${setup}
${snippet}
`;
  const stdout = execFileSync('python3', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: box.home, INBOUND_TRIAGE_DIR: box.state,
           OD_GMAIL_PACE_DIR: join(box.home, 'pace'), JOB_QUEUE_DIR: join(box.home, 'queue') },
  });
  const line = stdout.split('\n').filter((l) => l.startsWith('RESULT ')).pop();
  if (!line) throw new Error('no RESULT line:\n' + stdout);
  return JSON.parse(line.slice(7));
}

const TWO_IN_INBOX = `cache({
    "mA": {"sender": "friend@gmail.com", "subject": "How did the run go", "threadId": "tA",
           "internalDate": 1791800000000, "inbox": True},
    "mB": {"sender": "clerk@example-council.gov.uk", "subject": "Notice of a meeting", "threadId": "tB",
           "internalDate": 1791700000000, "inbox": True},
})`;

describe('"for Kevin to read" mail leaves the inbox and comes to him as ONE approval card', () => {
  it('leave labels it 19, archives it, and the run raises one card he can answer', () => {
    const box = sandbox();
    const r = runPy(box, `
${TWO_IN_INBOX}
m.cmd_note("mA", "leave", "A friend asking how the run went, nothing to answer")
m.cmd_note("mB", "leave", "The council confirming a meeting date, for information")
first = m.cmd_inbox_card("17:00", dispatch=ad)
second = m.cmd_inbox_card("17:00", dispatch=ad)
f = CREATED[0] if CREATED else {}
AF = ad.AF
out({"modifies": modifies(), "cards": len(CREATED),
     "name": f.get(AF["name"]), "status": f.get(AF["status"]),
     "team": f.get(AF["teamMember"]), "sentBy": f.get(AF["sentForApprovalBy"]),
     "output": f.get(AF["agentOutput"]), "plain": f.get(AF["plainSummary"]),
     "pendingLeft": m.pending_path().exists()})
`);
    // Both messages were taken out of the inbox and labelled, nothing deleted.
    expect(r.modifies).toEqual([
      { ids: ['mA'], addLabels: [READ_LABEL], removeLabels: ['INBOX'] },
      { ids: ['mB'], addLabels: [READ_LABEL], removeLabels: ['INBOX'] },
    ]);
    // ONE card for the run, and the second call (the runner's backstop) makes none.
    expect(r.cards).toBe(1);
    expect(r.pendingLeft).toBe(false);
    expect(r.name).toMatch(/^INBOX: 2 emails for you to read, \d{1,2} \w{3} 17:00$/);
    // In Kevin's approval queue: Status Approval with a sender, owned by Inbox Response.
    expect(r.status).toBe('Approval');
    expect(r.team).toEqual([RESPONSE]);
    expect(r.sentBy).toEqual([RESPONSE]);
    // Each email: sender, subject, the one-line summary and its Gmail link.
    for (const s of ['friend@gmail.com | How did the run go', 'A friend asking how the run went',
      'https://mail.google.com/mail/u/0/#all/tA', 'clerk@example-council.gov.uk | Notice of a meeting',
      'https://mail.google.com/mail/u/0/#all/tB']) {
      expect(r.output).toContain(s);
    }
    // Grouped by sender type: the person before the council.
    expect(r.output.indexOf('From people')).toBeLessThan(r.output.indexOf('From government'));
    expect(r.output).toMatch(/\*\*Carrying this out will involve:\*\* Closing this card as read\. Nothing is sent\.$/);
    expect(r.plain).toMatch(/^TASK: Read 2 emails that came in for you/);
  });

  it('a failed card keeps every email queued for the next run, never lost', () => {
    const box = sandbox();
    const r = runPy(box, `
${TWO_IN_INBOX}
m.cmd_note("mA", "leave", "A friend asking how the run went, nothing to answer")
def boom(fields):
    raise RuntimeError("gate exited 2")
m._create_card = boom
_, err = attempt(lambda: m.cmd_inbox_card("13:00", dispatch=ad))
m._create_card = fake_create
m.cmd_inbox_card("17:00", dispatch=ad)
out({"err": err, "cards": len(CREATED), "ids": CREATED[0][ad.AF["notes"]] if CREATED else ""})
`);
    expect(r.err.message).toMatch(/INBOX CARD NOT CREATED/);
    expect(r.cards).toBe(1);
    expect(r.ids).toBe('INBOX CARD MESSAGE IDS: mA');
  });

  it('without the label it refuses before moving anything', () => {
    const box = sandbox();
    const r = runPy(box, `
${TWO_IN_INBOX}
LABELS[:] = [l for l in LABELS if not l["name"].startswith("19")]
_, err = attempt(lambda: m.cmd_note("mA", "leave", "A friend asking how the run went"))
out({"err": err, "modifies": modifies(), "queued": m.pending_path().exists()})
`);
    expect(r.err.message).toMatch(/LABEL MISSING/);
    expect(r.err.message).toContain(READ_LABEL);
    expect(r.modifies).toEqual([]);
    expect(r.queued).toBe(false);
  });

  it('a leave with no summary is refused: the summary is what Kevin reads', () => {
    const box = sandbox();
    const r = runPy(box, `
${TWO_IN_INBOX}
_, err = attempt(lambda: m.cmd_note("mA", "leave", ""))
out({"err": err, "modifies": modifies()})
`);
    expect(r.err.message).toMatch(/needs --reason/);
    expect(r.modifies).toEqual([]);
  });
});

describe('answered and duplicate mail is filed out of the inbox, with no card', () => {
  it('answered: archived (INBOX removed, no label added), nothing queued', () => {
    const box = sandbox();
    const r = runPy(box, `
${TWO_IN_INBOX}
m.cmd_note("mA", "answered", "we replied on this thread after it arrived")
card = m.cmd_inbox_card("09:00", dispatch=ad)
out({"modifies": modifies(), "cards": len(CREATED)})
`);
    expect(r.modifies).toEqual([{ ids: ['mA'], removeLabels: ['INBOX'] }]);
    expect(r.cards).toBe(0);
  });

  it('duplicate: archived the same way', () => {
    const box = sandbox();
    const r = runPy(box, `
${TWO_IN_INBOX}
m.cmd_note("mB", "duplicate", "thread already has a completed task")
out({"modifies": modifies(), "cards": len(CREATED)})
`);
    expect(r.modifies).toEqual([{ ids: ['mB'], removeLabels: ['INBOX'] }]);
    expect(r.cards).toBe(0);
  });

  it('a message the scan saw outside the inbox costs no Gmail call', () => {
    const box = sandbox();
    const r = runPy(box, `
cache({"mC": {"sender": "x@example.com", "subject": "s", "threadId": "tC", "inbox": False}})
m.cmd_note("mC", "duplicate", "labelled lane mail, already handled")
out({"modifies": modifies()})
`);
    expect(r.modifies).toEqual([]);
  });
});

describe('the score counts inbox mail older than 2 days, so it cannot read 0 over a full inbox', () => {
  // Drives the real scan (Gmail lists stubbed) into the real score: three old
  // emails in the inbox, the run files one, two are still there.
  const SCAN_THEN_SCORE = `
OLD = [{"id": i, "threadId": "t" + i, "labelIds": ["INBOX"], "internalDate": 1791000000000,
        "headers": {"from": "p@example.com", "subject": "old " + i}, "body": ""}
       for i in ("s1", "s2", "s3")]
LISTS["older_than:2d"] = OLD
m.lookup_thread_tasks = lambda ids, fetch=None: {}
written = []
m.airtable_patch_metric = lambda text: written.append(text)
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    m.cmd_scan(12)
m.cmd_note("s1", "leave", "A neighbour asking about the bins, nothing to answer")
`;

  it('three old emails, one filed: the score is 2, not 0', () => {
    const box = sandbox();
    const r = runPy(box, SCAN_THEN_SCORE + `
m.cmd_score(0)
st = m.read_state()
out({"metric": written[-1], "today": st["history"][m.date.today().isoformat()],
     "detail": st["history_detail"][m.date.today().isoformat()]})
`);
    expect(r.metric).toMatch(/^2 waiting; at zero 0 of last 7 days$/);
    expect(r.today).toBe(2);
    expect(r.detail).toEqual({ agent: 0, inbox_over_2_days: 2, inbox_listing_truncated: false });
  });

  it("the agent's own count is added, never replaced", () => {
    const box = sandbox();
    const r = runPy(box, SCAN_THEN_SCORE + `
m.cmd_score(3)
out({"metric": written[-1]})
`);
    expect(r.metric).toMatch(/^5 waiting;/);
  });

  it('no scan this run: the score refuses rather than write a guess', () => {
    const box = sandbox();
    const r = runPy(box, `
written = []
m.airtable_patch_metric = lambda text: written.append(text)
_, err = attempt(lambda: m.cmd_score(0))
out({"err": err, "written": written})
`);
    expect(r.err.message).toMatch(/SCORE REFUSED/);
    expect(r.written).toEqual([]);
  });
});

describe("Kevin's notes on INBOX cards reach the TRIAGE agent before its next run", () => {
  const TRIAGE_FILE = `---
name: inbound-comms-triage
---

You decide what reaches Kevin.

## Lessons from Kevin

Standing rules.

- 2026-09-01: INBOUND: an older lesson — keep this

## Never

Send anything.
`;
  const RESPONSE_FILE = `---
name: inbound-comms-response
---

You answer mail.

## Lessons from Kevin

Standing rules.
`;
  const WORDS = 'Never show me newsletters from the running club, archive them';
  const CARD = `CARD = {"id": "recCARD0000000001", "fields": {
    ad.AF["name"]: "INBOX: 2 emails for you to read, 15 Oct 09:00",
    ad.AF["approvalFeedback"]: ${JSON.stringify(WORDS)},
    ad.AF["rememberThis"]: True,
    ad.AF["approvalOutcome"]: "Approved as-is",
    ad.AF["approvedAt"]: "2026-10-15T09:30:00.000Z",
    ad.AF["sentForApprovalBy"]: [${JSON.stringify(RESPONSE)}],
    ad.AF["teamMember"]: [${JSON.stringify(RESPONSE)}],
}}
ad.query_tasks = lambda formula, max_records=None, minimal=False: [CARD]
ad.patch_task = lambda tid, fields: None
ad.mirror_lesson_to_register = lambda row, line: True
import io, contextlib
`;

  function agentFiles(box) {
    writeFileSync(join(box.home, '.claude/agents/inbound-comms-triage.md'), TRIAGE_FILE);
    writeFileSync(join(box.home, '.claude/agents/inbound-comms-response.md'), RESPONSE_FILE);
  }

  it('the dispatcher alone files it with Inbox Response; inbox-lessons puts it in triage, inside its lessons', () => {
    const box = sandbox();
    agentFiles(box);
    const r = runPy(box, CARD + `
with contextlib.redirect_stdout(io.StringIO()):
    ad.cmd_lessons(None)
before = open(os.path.join(ad.AGENT_DIR, "inbound-comms-triage.md")).read()
m.cmd_inbox_lessons(dispatch=ad)
m.cmd_inbox_lessons(dispatch=ad)
out({"agentDir": ad.AGENT_DIR, "triageBefore": before,
     "triage": open(os.path.join(ad.AGENT_DIR, "inbound-comms-triage.md")).read(),
     "response": open(os.path.join(ad.AGENT_DIR, "inbound-comms-response.md")).read()})
`);
    // The sandbox, never Kevin's real agent files.
    expect(r.agentDir.startsWith(box.home)).toBe(true);
    // The gap this closes: the dispatcher's writer reaches Inbox Response only.
    expect(r.response).toContain(WORDS);
    expect(r.triageBefore).not.toContain(WORDS);
    // After the pre-read, the triage agent holds it, once, inside its section.
    const t = r.triage;
    expect(t.split(WORDS).length - 1).toBe(1);
    expect(t).toContain('- 2026-10-15: INBOX: 2 emails for you to read, 15 Oct 09:00 — ' + WORDS);
    expect(t.indexOf(WORDS)).toBeGreaterThan(t.indexOf('## Lessons from Kevin'));
    expect(t.indexOf(WORDS)).toBeLessThan(t.indexOf('## Never'));
    expect(t).toContain('an older lesson — keep this');
  });

  it("a note the dispatcher already rerouted to triage (with its stamp) is not written twice", () => {
    const box = sandbox();
    writeFileSync(join(box.home, '.claude/agents/inbound-comms-triage.md'),
      TRIAGE_FILE.replace('- 2026-09-01', `- 2026-10-15: INBOX: 2 emails for you to read, 15 Oct 09:00 — [2026-10-15 09:30] ${WORDS}\n- 2026-09-01`));
    const r = runPy(box, CARD + `
m.cmd_inbox_lessons(dispatch=ad)
out({"triage": open(os.path.join(ad.AGENT_DIR, "inbound-comms-triage.md")).read()})
`);
    expect(r.triage.split(WORDS).length - 1).toBe(1);
  });

  it('a failed Tasks read is NOT CHECKED, never "no lessons"', () => {
    const box = sandbox();
    agentFiles(box);
    const r = runPy(box, `
def broken(formula, max_records=None, minimal=False):
    raise RuntimeError("Airtable 422 unknown field")
ad.query_tasks = broken
_, err = attempt(lambda: m.cmd_inbox_lessons(dispatch=ad))
out({"err": err})
`);
    expect(r.err.message).toMatch(/INBOX LESSONS NOT CHECKED/);
  });

  it('the runner copies the lessons BEFORE the agent starts and raises the card AFTER it', () => {
    // Shell ordering cannot be driven without running the slot; the copy itself
    // is driven above. This pins only where the two calls sit in the runner.
    const runner = readFileSync(RUNNER, 'utf8');
    const lessons = runner.indexOf('inbound-triage.py" inbox-lessons');
    const agent = runner.indexOf('"$CLAUDE" -p');
    const card = runner.indexOf('inbound-triage.py" inbox-card');
    expect(lessons).toBeGreaterThan(-1);
    expect(lessons).toBeLessThan(agent);
    expect(card).toBeGreaterThan(agent);
    expect(runner).toContain('.claude/agents/inbound-comms-triage.md');
  });
});

describe('the one-off backlog', () => {
  const INBOX = `
def msg(i, frm, subj):
    return {"id": i, "threadId": "t" + i, "labelIds": ["INBOX"], "internalDate": 1789600000000,
            "headers": {"from": frm, "subject": subj}, "body": ""}
LISTS["in:inbox"] = [msg("d1", "Pat <pat@gmail.com>", "Holiday photos"),
                     msg("d2", "agent@example.co.uk", "Re: viewing"),
                     msg("d3", "noreply@example.com", "Your statement"),
                     msg("d4", "x@example.com", "Lane mail still here"),
                     msg("d5", "y@example.com", "Never decided")]
(m.base_dir() / "digest-2026-09-20.jsonl").write_text("\\n".join(json.dumps(r) for r in [
    {"id": "d1", "do": "leave", "reason": "Photos from a friend, nothing to answer", "ts": "2026-09-20T09:00:00"},
    {"id": "d2", "do": "answered", "ts": "2026-09-20T09:01:00"},
    {"id": "d3", "do": "duplicate", "ts": "2026-09-20T09:02:00"},
    {"id": "d4", "do": "label12", "ts": "2026-09-20T09:03:00"},
]) + "\\n")
DIGESTS = lambda: sorted(p.name + ":" + str(len(p.read_text().splitlines())) for p in m.base_dir().glob("digest-*.jsonl"))
`;

  it('--dry-run reads the inbox and the digests and writes nothing to Gmail or Airtable', () => {
    const box = sandbox();
    const r = runPy(box, INBOX + `
before = DIGESTS()
import io, contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m.cmd_backlog(apply=False, dispatch=ad, holder_path=os.path.join(${JSON.stringify(box.home)}, "no-lock"))
res = json.loads(buf.getvalue().strip().splitlines()[-1])
out({"res": res, "paths": sorted(set(c["path"] for c in CALLS)), "created": len(CREATED),
     "digestsSame": before == DIGESTS(), "ledger": m.ledger_path().exists(),
     "preview": open(res["preview_file"]).read()})
`);
    expect(r.paths).toEqual(['/gmail/list']);
    expect(r.created).toBe(0);
    expect(r.digestsSame).toBe(true);
    expect(r.ledger).toBe(false);
    expect(r.res).toMatchObject({
      mode: 'dry-run', leave_to_card: 1, answered_to_file: 1, duplicate_to_file: 1,
      decided_otherwise_still_in_inbox: { label12: 1 }, no_recorded_decision_in_inbox: 1,
      card_groups: { person: 1 }, gmail_writes: 0, airtable_writes: 0,
    });
    // The preview is the card itself, kept in the private state folder.
    expect(r.res.preview_file.startsWith(box.state)).toBe(true);
    expect(r.preview).toContain('pat@gmail.com | Holiday photos');
    expect(r.preview).toContain('Photos from a friend, nothing to answer');
  });

  it('--apply makes one card, labels and archives the leave mail, files the rest, and a re-run cards nothing twice', () => {
    const box = sandbox();
    const r = runPy(box, INBOX + `
import io, contextlib
lock = os.path.join(${JSON.stringify(box.home)}, "no-lock")
with contextlib.redirect_stdout(io.StringIO()):
    m.cmd_backlog(apply=True, dispatch=ad, holder_path=lock)
    first = len(CREATED)
    m.cmd_backlog(apply=True, dispatch=ad, holder_path=lock)
out({"first": first, "second": len(CREATED) - first, "modifies": modifies(),
     "name": CREATED[0][ad.AF["name"]]})
`);
    expect(r.first).toBe(1);
    expect(r.second).toBe(0);
    expect(r.name).toMatch(/^INBOX BACKLOG: 1 email waiting in your inbox since \d{1,2} \w{3}, for you to read$/);
    // First run: label + archive the leave mail, archive answered and duplicate.
    expect(r.modifies.slice(0, 2)).toEqual([
      { ids: ['d1'], addLabels: [READ_LABEL], removeLabels: ['INBOX'] },
      { ids: ['d2', 'd3'], removeLabels: ['INBOX'] },
    ]);
    // Never touches lane mail or undecided mail.
    for (const p of r.modifies) {
      expect(p.ids).not.toContain('d4');
      expect(p.ids).not.toContain('d5');
    }
  });

  it('refuses while a triage slot holds the queue lock, before any Gmail call', () => {
    const box = sandbox();
    const lock = join(box.home, 'holder.json');
    writeFileSync(lock, JSON.stringify({ job: 'inbound-triage', acquired_iso: '2026-10-14T16:00:06Z' }));
    const r = runPy(box, INBOX + `
_, err = attempt(lambda: m.cmd_backlog(apply=False, dispatch=ad, holder_path=${JSON.stringify(lock)}))
out({"err": err, "calls": len(CALLS)})
`);
    expect(r.err.message).toMatch(/BACKLOG REFUSED: the inbound-triage slot holds the queue lock/);
    expect(r.calls).toBe(0);
  });
});

describe('the sandbox held', () => {
  it('no test above wrote into the repo', () => {
    // A stray preview or digest in the working tree would be private mail in a public repo.
    const strays = readdirSync(SCRIPTS).filter((f) => /backlog-preview|inbox-card|digest-/.test(f));
    expect(strays).toEqual([]);
    expect(existsSync(join(ROOT, 'backlog-preview.txt'))).toBe(false);
  });
});
