import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// A STATUS-ONLY UPDATE FILES ITSELF, A NO-OP CARD IS REFUSED (Kevin, 14 Nov 2026, "Handled list,
// no card"). In 30 days he gave 64 verdicts on cards whose own plain line said "IF YOU APPROVE:
// Nothing happens", most of them creditor chase updates. The informational filing never takes a
// tier-1 or creditor task, so each became a card he approved to make it go away.
//
// The real cmd_submit, cmd_escalate, decision_level, status_rest, action_landed and an offline
// build_queue run here with Airtable swapped for an in-memory task. Fixtures are invented. Dates
// are worked out from today in the script, because NEXT CHECK must lie in the next seven days.
function run({ op = 'submit', output, plainTask = TASK, plainApprove = STATUS_APPROVE, stored = {},
               tier1 = false, creditor = false, type = 'Research', attach = null, certOwed = false }) {
  const script = `
import importlib.util, json, sys, tempfile, os, types, io, contextlib
from datetime import datetime, timedelta
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
p = json.loads(sys.argv[1])
today = datetime.now(m.LONDON).date()
def fill(s):
    return (s.replace('{NEXT}', (today + timedelta(days=3)).isoformat())
             .replace('{FAR}', (today + timedelta(days=20)).isoformat())
             .replace('{TODAY}', today.strftime('%d %b %Y'))
             .replace('{LASTWEEK}', (today - timedelta(days=9)).strftime('%d %b %Y')))
agent = m.CREDITOR_REC_ID if p['creditor'] else sorted(m.AGENTS)[0]
fields = {m.AF[k]: v for k, v in p['stored'].items()}
fields.setdefault(m.AF['teamMember'], [agent])
fields.setdefault(m.AF['status'], 'Today')
created = (datetime.now(m.LONDON) - timedelta(days=5)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
captured, ledger = {}, []
def fake_patch(task, f):
    captured.setdefault('fields', {}).update(f)
    fields.update(f)
    return {'id': task}
m.patch_task = fake_patch
m.get_task = lambda task: {'id': task, 'createdTime': created, 'fields': json.loads(json.dumps(fields))}
m.ledger_append = lambda task, event: ledger.append(event)
m.ledger_last_events = lambda: {}
m.finding_details = lambda: {}
uploads = []
m.upload_attachment = lambda task, path: (uploads.append(path), os.path.basename(path))[1]
m.supersede_attachments = lambda *a, **k: []
m.task_fields_owe_certificate = lambda *a, **k: (['a gas safety record arrived'] if p['certOwed'] else [])
m.task_owes_cost = lambda *a, **k: []
m.BROWSER_LEDGER = '/nonexistent/od-test-browser-ledger.jsonl'
m.HANDOVER_DIR = tempfile.mkdtemp()
fh = tempfile.NamedTemporaryFile('w', suffix='.md', delete=False)
fh.write(fill(p['output'])); fh.close()
attach = None
if p['attach']:
    af = tempfile.NamedTemporaryFile('w', suffix='.pdf', delete=False); af.write('x'); af.close(); attach = [af.name]
out = {'fieldMap': m.AF}
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        if p['op'] == 'escalate':
            m.history = lambda **kw: {'terms': [], 'searched': ['tasks'], 'entries': [], 'notes': []}
            bh = tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False)
            bh.write('WHAT THIS IS:\\nThe phone contract ends at the end of the month.\\n\\n'
                     'WHAT HAS HAPPENED:\\nThe supplier wrote on 1 Nov 2026 offering the same terms again.\\n\\n'
                     'OPTIONS:\\nA. Renew it for another year.\\nB. Let it end.\\n\\n'
                     'RECOMMENDED: B, because the line is unused.')
            bh.close()
            m.cmd_escalate(types.SimpleNamespace(task='recTESTTESTTEST01', reason='Renew the phone contract or let it end?',
                                                 brief_file=bh.name, plain_task=p['plainTask'], plain_approve=p['plainApprove']))
        else:
            m.cmd_submit(types.SimpleNamespace(task='recTESTTESTTEST01', agent=agent, type=p['type'],
                                               output_file=fh.name, tier1=p['tier1'], attach=attach,
                                               plain_task=p['plainTask'], plain_approve=p['plainApprove']))
    out['refused'] = False
except SystemExit as exc:
    out['refused'] = True
    out['error'] = str(exc)
finally:
    os.unlink(fh.name)
out['captured'] = captured
out['ledger'] = ledger
out['uploads'] = uploads
out['stdout'] = buf.getvalue()
print('---JSON---')
print(json.dumps(out))
`;
  const raw = execFileSync('python3', ['-c', script, JSON.stringify({ op, output, plainTask, plainApprove, stored, tier1, creditor, type, attach, certOwed })],
    { encoding: 'utf8', env: { ...process.env, SIGNIN_SKIP_WALK: '1' } });
  return JSON.parse(raw.split('---JSON---')[1]);
}

function py(snippet) {
  const script = `
import importlib.util, json, sys
from datetime import datetime, timezone, timedelta
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
today = datetime.now(m.LONDON).date()
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

const TASK = 'Check whether the phone company has answered about the refund it promised.';
const STATUS_APPROVE = 'Nothing to approve. The update is listed under Handled without you.';
const CLOSING = '**Carrying this out will involve:** Nothing. Information only.';
const RECORD = 'TRACK RECORD: (record book page and earlier cards)\n- {LASTWEEK}: Kevin approved the first written chase, sent by email.';
const status = (line, extra = '') =>
  `STATUS ONLY: ${line}\nNEXT CHECK: {NEXT}\n\nWhat I checked: both inboxes for the company's name since the chase went.${extra}\n\n${RECORD}\n\n${CLOSING}`;
const QUIET = 'The phone company has not replied yet and nothing new has arrived, so I look again in three days.';
const CHASE = { name: 'Chase: Example Phones - await the refund reply', description: 'CREDITOR MATTER — chase raised automatically.' };

describe('a status-only update on a creditor task files itself', () => {
  it('a tier-1 creditor chase update makes no card: one Notes line, nothing else written', () => {
    const r = run({ output: status(QUIET), tier1: true, creditor: true, stored: CHASE });
    expect(r.refused, r.error).toBe(false);
    expect(Object.keys(r.captured.fields)).toEqual([r.fieldMap.notes]);
    const notes = r.captured.fields[r.fieldMap.notes];
    expect(notes).toMatch(/— agent-dispatch\] HANDLED WITHOUT YOU \(status update\): The phone company has not replied yet/);
    expect(notes).toMatch(/the task stays Today, its card and Kevin's verdict are untouched, and it rests until \d{4}-\d{2}-\d{2}\./);
    expect(r.ledger).toEqual(['status']);
    const said = JSON.parse(r.stdout.trim().split('\n').pop());
    expect(said).toMatchObject({ handled: true, card: false, level: 'A', category: 'status update', status: 'Today' });
  });

  it("the task's status, verdict, card lines and output stay exactly as they were", () => {
    const stored = { ...CHASE, status: 'Today', approvalOutcome: 'Approved as-is', approvedAt: '2026-11-01T09:00:00.000Z',
      agentOutput: 'The approved chase card.', plainSummary: 'TASK: x\nIF YOU APPROVE: the chase goes.',
      sentForApprovalBy: ['recAgentAaaaaaaaa'] };
    const r = run({ output: status(QUIET), tier1: true, creditor: true, stored });
    expect(r.refused, r.error).toBe(false);
    for (const k of ['status', 'approvalOutcome', 'approvedAt', 'agentOutput', 'plainSummary', 'sentForApprovalBy',
                     'teamMember', 'assignee', 'dueDate', 'completion', 'approvalFeedback']) {
      expect(r.captured.fields, k).not.toHaveProperty(r.fieldMap[k]);
    }
  });

  it('decision_level puts it at Level A on a tier-1 name, before the tier check', () => {
    const d = py(`
out = m.TIER1_BANNER + "\\n\\nSTATUS ONLY: No reply yet and nothing new has arrived.\\nNEXT CHECK: " + (today + timedelta(days=2)).isoformat() + "\\n\\n**Carrying this out will involve:** Nothing. Information only."
rec = {'id': 'recTHIS0000000001', 'createdTime': '2026-11-01T10:00:00.000Z', 'fields': {m.AF['name']: 'INBOUND: bailiff notice of enforcement', m.AF['notes']: ''}}
lv = m.decision_level(out, 'Research', rec, fetch=lambda i: {})
print(json.dumps([lv['level'], lv['category'], lv['carry'], lv.get('restUntil')]))`);
    expect(d.slice(0, 3)).toEqual(['A', 'status update', 'status']);
    expect(d[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('anything with an ask, a reply or something to carry out is refused back as a card', () => {
  it.each([
    ['money due', 'They have not replied, but the £120 payment is due by Friday.', 'carry an ask'],
    ['a demand to act', 'No refund yet. Please confirm the account details again.', 'carry an ask'],
    ['a decision', 'No reply. Do you want me to escalate it to the ombudsman?', 'carry an ask'],
  ])('%s in its own words', (_, line, why) => {
    const r = run({ output: status(line), tier1: true, creditor: true, stored: CHASE });
    expect(r.refused).toBe(true);
    expect(r.error).toContain(why);
    expect(r.error).toContain('this is a card');
    expect(r.captured.fields).toBeUndefined();
  });

  it('an ask below the status line counts too, while the TRACK RECORD history does not', () => {
    const asked = run({ output: status(QUIET, '\nThe final notice says the court claim starts unless they hear by 20 November.'),
      tier1: true, creditor: true, stored: CHASE });
    expect(asked.refused).toBe(true);
    expect(asked.error).toMatch(/a deadline/);
    const quoted = run({ output: status(QUIET).replace('sent by email.', 'sent by email: "please pay the overdue invoice".'),
      tier1: true, creditor: true, stored: CHASE });
    expect(quoted.refused, quoted.error).toBe(false);
  });

  it('a reply that arrived since the last look is a change, so it is a card', () => {
    const out = status(QUIET).replace(RECORD, RECORD + '\n- {TODAY} 10:12 — email: Example Phones <billing@example-phones.test>: Re: your refund');
    const r = run({ output: out, tier1: true, creditor: true, stored: CHASE });
    expect(r.refused).toBe(true);
    expect(r.error).toMatch(/shows a reply since the last look \(.* from billing@example-phones\.test\)/);
  });

  it.each([
    ['an email', 'TO: billing@example-phones.test\nSUBJECT: Refund', 'carries a TO line'],
    ['a spend', 'SPEND: £20', 'carries a SPEND line'],
    ['a decision line', 'DECIDE: chase again or wait?', 'carries a DECIDE line'],
    ['a payment', 'MARK FOR PAYMENT: £20 to Example Phones', 'carries a MARK FOR PAYMENT line'],
    ['a step of Kevin\'s', 'KEVIN ONLY: payment: pay the £20', 'KEVIN ONLY'],
    ['a close', 'CLOSE PROPOSAL: already handled — see recDONE0000000001', 'carries a CLOSE PROPOSAL line'],
  ])('a status update carrying %s is refused', (_, line, why) => {
    const r = run({ output: status(QUIET, '\n' + line), tier1: true, creditor: true, stored: CHASE });
    expect(r.refused).toBe(true);
    expect(r.error).toContain(why);
    expect(r.captured.fields).toBeUndefined();
  });

  it('it needs a NEXT CHECK within seven days, the declared closing line, and no file', () => {
    const noNext = run({ output: status(QUIET).replace(/NEXT CHECK: \{NEXT\}\n/, ''), creditor: true, stored: CHASE });
    expect(noNext.error).toMatch(/no NEXT CHECK/);
    const far = run({ output: status(QUIET).replace('{NEXT}', '{FAR}'), creditor: true, stored: CHASE });
    expect(far.error).toMatch(/at most 7 days ahead/);
    const close = run({ output: status(QUIET).replace(CLOSING, '**Carrying this out will involve:** The agent chases them again.'),
      creditor: true, stored: CHASE });
    expect(close.error).toMatch(/closing line must be the declared form/);
    const file = run({ output: status(QUIET), creditor: true, stored: CHASE, attach: true });
    expect(file.error).toMatch(/attaches a file/);
    for (const r of [noNext, far, close, file]) expect(r.captured.fields).toBeUndefined();
  });

  it('Changes requested is owed a new card, never a status update', () => {
    const r = run({ output: status(QUIET), creditor: true,
      stored: { ...CHASE, approvalOutcome: 'Changes requested', approvalFeedback: 'Chase them again, firmly.' } });
    expect(r.refused).toBe(true);
    expect(r.error).toMatch(/asked for changes/);
  });
});

describe('a card whose Approve runs nothing is refused, with the two honest routes', () => {
  const REPORT = 'The account was checked line by line against the bank feed for October. '.repeat(4) + '\n\n' + RECORD + '\n\n' + CLOSING;
  it.each([
    'Nothing happens. This only tells you no reply has come yet and the next check is on 2 November.',
    'Nothing is sent. We already froze this debt on 10 Sep and are waiting on them.',
    'Nothing happens. It stays parked until January, as already agreed.',
  ])('refuses %s on a tier-1 card', (line) => {
    const r = run({ output: REPORT, plainApprove: line, tier1: true, creditor: true, stored: CHASE });
    expect(r.refused).toBe(true);
    expect(r.error).toContain('says Approve runs nothing');
    expect(r.error).toContain('STATUS ONLY update');
    expect(r.error).toContain('say what in --plain-approve');
    expect(r.captured.fields).toBeUndefined();
  });

  it('the first look refuses before any file is uploaded', () => {
    const r = run({ output: REPORT, plainApprove: 'Nothing happens. This only tells you no reply has come yet.',
      tier1: true, creditor: true, stored: CHASE, attach: true });
    expect(r.refused).toBe(true);
    expect(r.error).toContain('says Approve runs nothing');
    expect(r.uploads).toEqual([]);
  });

  it('the last look refuses a report that would have filed itself but becomes a card (a certificate owed)', () => {
    const r = run({ output: REPORT, plainApprove: 'Nothing happens. This is information only, for your records.',
      type: 'Analysis', certOwed: true });
    expect(r.refused).toBe(true);
    expect(r.error).toContain('it would be a card');
    expect(r.captured.fields).toBeUndefined();
  });

  it('a line that says what Approve sets going passes, even with "nothing is sent" in it', () => {
    const r = run({ output: REPORT, plainApprove: 'This reminder closes. Nothing is sent or paid.', tier1: true, creditor: true, stored: CHASE });
    expect(r.refused, r.error).toBe(false);
    expect(r.captured.fields[r.fieldMap.status]).toBe('Approval');
  });

  it('a report that files itself keeps its Nothing line: there is no card to refuse', () => {
    const r = run({ output: REPORT, plainApprove: 'Nothing happens. This is information only, for your records.', type: 'Analysis' });
    expect(r.refused, r.error).toBe(false);
    expect(r.captured.fields[r.fieldMap.status]).toBe('Completed');
  });

  it('escalate refuses a decision card whose Approve runs nothing', () => {
    const r = run({ op: 'escalate', output: '', plainTask: 'The phone contract ends at the end of the month.',
      plainApprove: 'Nothing happens. This only tells you the contract ends soon.' });
    expect(r.refused).toBe(true);
    expect(r.error).toContain('says Approve runs nothing');
  });

  it('the backstop reads the stored lines the back-test read (60 days to 14 Nov 2026) the same way', () => {
    const lines = py(`print(json.dumps({l: bool(m.approve_line_noop(l)) for l in [
  "Nothing happens. This only tells you no reply has come yet and the next check is on 2 November.",
  "Nothing is sent. The matter is checked again on 6 November and a chase comes to you then if needed.",
  "Nothing to do — checked live, the pattern doesn't exist anymore. The code issue is already logged for a future build session.",
  "Nothing changes. The notice is filed as covered by the agreed 20 pounds a month plan.",
  "Nothing happens - this just closes the task, no action needed.",
  "Nothing happens — the task closes, no purchase made",
  "Nothing changes in Google. The plan stays the same, this 25.50 pound a month saving is closed as not now, and the bill stays at 135.50 pounds.",
  "Nothing runs yet - Kevin is only approving the plan to stop that check from being skipped.",
  "Nothing changes now. A later session fixes today's files, then rewrites history on route A.",
  "The card closes as read. Nothing is sent.",
  "If you approve, the robot runs merge-pr.py and the deploy, nothing else.",
  "Nothing is written. Use Request changes to give one line of real context and the post is written from it.",
]}))`);
    expect(Object.entries(lines).filter(([, v]) => v).map(([k]) => k)).toEqual([
      'Nothing happens. This only tells you no reply has come yet and the next check is on 2 November.',
      'Nothing is sent. The matter is checked again on 6 November and a chase comes to you then if needed.',
      "Nothing to do — checked live, the pattern doesn't exist anymore. The code issue is already logged for a future build session.",
    ]);
  });
});

describe('a filed task rests until its NEXT CHECK and counts as the run\'s outcome', () => {
  it('status_rest reads the stamped line and the status event; Kevin moving his verdict wakes it', () => {
    const r = py(`
d = lambda n: (today + timedelta(days=n)).isoformat()
stamp = today.strftime('%d %b %Y') + ' 09:00'
line = lambda until: f"[{stamp} — agent-dispatch] HANDLED WITHOUT YOU (status update): No reply. Nothing to approve: the task stays Today, its card and Kevin's verdict are untouched, and it rests until {until}. Level A, Kevin's ruling 14 Nov 2026."
ev = ("status", "2026-11-14T09:00:00.000Z")
t = lambda **kw: dict({"outcome": "", "notes": line(d(3)), "approvedAt": ""}, **kw)
print(json.dumps([
  m.status_rest(t(), ev),
  m.status_rest(t(notes=line(d(0))), ev),
  m.status_rest(t(approvedAt="2026-11-14T10:00:00.000Z"), ev),
  m.status_rest(t(outcome="Changes requested"), ev),
  m.status_rest(t(), ("handled", "2026-11-14T09:00:00.000Z")),
  m.status_rest(t(notes="[" + stamp + " — agent] HANDLED WITHOUT YOU (status update): typed. rests until " + d(3) + "."), ev),
]))`);
    expect(r[0]).toMatch(/^status update filed at 2026-11-14T09:00 with nothing to approve; rests until \d{4}-\d{2}-\d{2}/);
    expect(r.slice(1)).toEqual(['', '', '', '', '']);
  });

  it('the offline build_queue lists a rested task under idleHandbacks and keeps the others in the worklist', () => {
    const dir = mkdtempSync(tmpdir() + '/od-status-rest-');
    const q = py(`
import os
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
m.STATE_DIR = ${JSON.stringify(dir)}
m.INTENT_LEDGER = os.path.join(${JSON.stringify(dir)}, "carryout-intent.jsonl")
stamp = today.strftime('%d %b %Y') + ' 09:00'
until = (today + timedelta(days=3)).isoformat()
filed = f"[{stamp} — agent-dispatch] HANDLED WITHOUT YOU (status update): No reply. Nothing to approve: the task stays Today, its card and Kevin's verdict are untouched, and it rests until {until}. Level A, Kevin's ruling 14 Nov 2026."
A = m.AF
ANALYST = 'recqmKBmq8ZGkxVH9'
def rec(i, notes):
    return {"id": i, "fields": {A["name"]: "Draft the refund chase " + i, A["status"]: {"name": "Today"},
            A["dueDate"]: today.isoformat(), A["teamMember"]: [ANALYST], A["notes"]: notes}}
rows = [rec("recRestedAaaaaaaa", filed), rec("recFreshAaaaaaaaa", ""), rec("recNoEventAaaaaaa", filed)]
with open(m.INTENT_LEDGER, "w") as fh:
    fh.write(json.dumps({"task": "recRestedAaaaaaaa", "ts": "2026-11-14T09:00:00.000Z", "event": "status"}) + "\\n")
m.query_tasks = lambda formula, **kw: rows if formula == m.QUEUE_FORMULA else []
m.fetch_role_roster = lambda: {}
m.fetch_ai_agents = lambda: {ANALYST: "AI Worker — Analyst"}
m.rent_reply_senders = lambda *a, **k: set()
m.compliance_book_pages = lambda *a, **k: []
m.fetch_plans = lambda: []
q = m.build_queue()
print(json.dumps({"idle": {t["id"]: t.get("idleReason", "") for t in q["idleHandbacks"]},
                  "work": sorted(t["id"] for t in q["worklist"] + q["reserve"])}))`);
    expect(Object.keys(q.idle)).toEqual(['recRestedAaaaaaaa']);
    expect(q.idle.recRestedAaaaaaaa).toMatch(/status update filed .* rests until/);
    // a stamped line with no status event in the ledger rests nothing: the clock is the ledger's
    expect(q.work).toEqual(['recFreshAaaaaaaaa', 'recNoEventAaaaaaa']);
  });

  it('verify reads a filed status update as the submit landing, and a typed marker is refused', () => {
    const r = py(`
stamp = today.strftime('%d %b %Y') + ' 09:00'
filed = f"[{stamp} — agent-dispatch] HANDLED WITHOUT YOU (status update): No reply. Nothing to approve: the task stays Today, its card and Kevin's verdict are untouched, and it rests until 2099-01-01. Level A, Kevin's ruling 14 Nov 2026."
old = filed.replace(stamp, (today - timedelta(days=5)).strftime('%d %b %Y') + ' 09:00')
t = lambda notes: {"status": "Today", "notes": notes, "teamMemberIds": []}
a = {"kind": "submit", "task": "recX"}
import types
try:
    m.get_task = lambda i: {"id": i, "fields": {}}
    m.cmd_annotate(types.SimpleNamespace(task="recX", note="HANDLED WITHOUT YOU (status update): typed by hand"))
    typed = "accepted"
except SystemExit as e:
    typed = str(e)
print(json.dumps([m.action_landed(a, t(filed), today), m.action_landed(a, t(old), today), m.action_landed(a, t(""), today), typed]))`);
    expect(r.slice(0, 3)).toEqual([true, false, false]);
    expect(r[3]).toMatch(/refusing a note .* HANDLED WITHOUT YOU marker/);
  });
});
