import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const GATE = resolve(ROOT, 'scripts/create-agent-task.py');

// A STATUS-ONLY UPDATE FILES ITSELF, A NO-OP CARD IS REFUSED (Kevin, 14 Nov 2026, "Handled list,
// no card"). In 30 days he gave 64 verdicts on cards whose own plain line said "IF YOU APPROVE:
// Nothing happens", most of them creditor chase updates. The informational filing never takes a
// tier-1 or creditor task, so each became a card he approved to make it go away.
//
// The real cmd_submit, cmd_escalate, decision_level, status_rest, action_landed and an offline
// build_queue run here with Airtable swapped for an in-memory task. Fixtures are invented. Dates
// are worked out from today in the script, because NEXT CHECK must lie in the next seven days.
function run({ op = 'submit', output, plainTask = TASK, plainApprove = STATUS_APPROVE, stored = {},
               tier1 = false, creditor = false, type = 'Research', attach = null, certOwed = false, hist = 'quiet',
               done = null }) {
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
# The last look: a card stamped five days ago (creation is not a look, 15 Nov 2026).
LOOK = (datetime.now(m.LONDON) - timedelta(days=5)).strftime('%d %b %Y') + ' 09:00'
fields.setdefault(m.AF['notes'], '[' + LOOK + ' — agent-dispatch] SUBMITTED (round 1) as Research with no new file')
fields.setdefault(m.AF['teamMember'], [agent])
# A ledger of this run of its own (a done event after Kevin's approval when the case says it was carried out).
m.STATE_DIR = tempfile.mkdtemp()
m.INTENT_LEDGER = os.path.join(m.STATE_DIR, 'carryout-intent.jsonl')
if p['done']:
    with open(m.INTENT_LEDGER, 'w') as fh:
        fh.write(json.dumps({'task': 'recTESTTESTTEST01', 'ts': p['done'], 'event': 'done'}) + '\\n')
fields.setdefault(m.AF['status'], 'Today')
created = (datetime.now(m.LONDON) - timedelta(days=5)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
captured, ledger = {}, []
def fake_patch(task, f):
    captured.setdefault('fields', {}).update(f)
    fields.update(f)
    return {'id': task}
m.patch_task = fake_patch
m.get_task = lambda task: {'id': task, 'createdTime': created, 'fields': json.loads(json.dumps(fields))}
m.ledger_append = lambda task, event, *a, **k: ledger.append(event)
m.ledger_last_events = lambda: {}
m.finding_details = lambda: {}
uploads = []
m.upload_attachment = lambda task, path: (uploads.append(path), os.path.basename(path))[1]
m.supersede_attachments = lambda *a, **k: []
m.task_fields_owe_certificate = lambda *a, **k: (['a gas safety record arrived'] if p['certOwed'] else [])
m.task_owes_cost = lambda *a, **k: []
m.BROWSER_LEDGER = '/nonexistent/od-test-browser-ledger.jsonl'
m.HANDOVER_DIR = tempfile.mkdtemp()
searched = []
def fake_history(emails=(), refs=(), properties=(), days=730, exclude_task=None, gmail=True, gmail_accounts=None):
    searched.append({'emails': list(emails), 'refs': list(refs), 'gmail': gmail})
    mode = p['hist']
    if mode == 'raise':
        raise RuntimeError('worker 503')
    base = {'terms': ['email %s' % e for e in emails] + ['ref %s' % r for r in refs],
            'searched': ['tasks', 'Gmail'], 'entries': [], 'notes': []}
    if mode == 'nogmail':
        base['notes'] = ['Gmail not searched (worker 503)']
    if mode == 'reply':
        when = datetime.now(m.LONDON).strftime('%Y-%m-%d %H:%M')
        base['entries'] = [{'date': when, 'source': 'email', 'text': 'Example Phones <billing@example-phones.test>: Re: your refund'}]
    if mode == 'old':
        base['entries'] = [{'date': (datetime.now(m.LONDON) - timedelta(days=9)).strftime('%Y-%m-%d %H:%M'),
                            'source': 'email', 'text': 'Example Phones <billing@example-phones.test>: Re: your refund'}]
    if mode == 'ours':
        base['entries'] = [{'date': datetime.now(m.LONDON).strftime('%Y-%m-%d %H:%M'), 'source': 'email',
                            'text': 'Kevin Brittain <kevinbrittain@gmail.com>: Re: your refund'}]
    return base
m.history = fake_history
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
out['searched'] = searched
out['stdout'] = buf.getvalue()
print('---JSON---')
print(json.dumps(out))
`;
  const raw = execFileSync('python3', ['-c', script, JSON.stringify({ op, output, plainTask, plainApprove, stored, tier1, creditor, type, attach, certOwed, hist, done })],
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
const CHASE = { name: 'Chase: Example Phones - await the refund reply', description: 'CREDITOR MATTER — chase raised automatically. Contact: billing@example-phones.test' };

describe('a status-only update on a creditor task files itself', () => {
  it('a tier-1 creditor chase update makes no card: one Notes line, nothing else written', () => {
    const r = run({ output: status(QUIET), tier1: true, creditor: true, stored: CHASE });
    expect(r.refused, r.error).toBe(false);
    expect(Object.keys(r.captured.fields)).toEqual([r.fieldMap.notes]);
    const notes = r.captured.fields[r.fieldMap.notes];
    expect(notes).toMatch(/— agent-dispatch\] HANDLED WITHOUT YOU \(status update\): The phone company has not replied yet/);
    expect(notes).toMatch(/the task stays Today, its card and Kevin's verdict are untouched, and it rests until \d{4}-\d{2}-\d{2}\./);
    expect(notes).toMatch(/Level A, Kevin's ruling 14 Nov 2026\. Holder: rec[A-Za-z0-9]{14}\./);
    expect(r.ledger).toEqual(['status']);
    const said = JSON.parse(r.stdout.trim().split('\n').pop());
    expect(said).toMatchObject({ handled: true, card: false, level: 'A', category: 'status update', status: 'Today' });
  });

  it("the task's status, verdict, card lines and output stay exactly as they were", () => {
    const stored = { ...CHASE, status: 'Today', approvalOutcome: 'Approved as-is', approvedAt: '2026-11-01T09:00:00.000Z',
      agentOutput: 'The approved chase card.', plainSummary: 'TASK: x\nIF YOU APPROVE: the chase goes.',
      sentForApprovalBy: ['recAgentAaaaaaaaa'] };
    const r = run({ output: status(QUIET), tier1: true, creditor: true, stored, done: '2026-11-02T09:00:00.000Z' });
    expect(r.refused, r.error).toBe(false);
    for (const k of ['status', 'approvalOutcome', 'approvedAt', 'agentOutput', 'plainSummary', 'sentForApprovalBy',
                     'teamMember', 'assignee', 'dueDate', 'completion', 'approvalFeedback']) {
      expect(r.captured.fields, k).not.toHaveProperty(r.fieldMap[k]);
    }
  });

  it('decision_level puts it at Level A on a tier-1 name, before the tier check', () => {
    const d = py(`
out = m.TIER1_BANNER + "\\n\\nSTATUS ONLY: No reply yet and nothing new has arrived.\\nNEXT CHECK: " + (today + timedelta(days=2)).isoformat() + "\\n\\n**Carrying this out will involve:** Nothing. Information only."
rec = {'id': 'recTHIS0000000001', 'createdTime': '2026-11-01T10:00:00.000Z', 'fields': {m.AF['name']: 'INBOUND: bailiff notice of enforcement', m.AF['description']: 'From enforcement@example-bailiffs.test', m.AF['notes']: '[02 Nov 2026 09:00 — agent-dispatch] SUBMITTED (round 1) as Research with no new file'}}
m.history = lambda **kw: {'terms': ['email x'], 'searched': ['tasks', 'Gmail'], 'entries': [], 'notes': []}
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

  it('a reply that arrived since the last look is a card, found by the code\'s own history read, not the pasted block', () => {
    // The agent's output carries no email line at all: the read finds the reply anyway.
    const r = run({ output: status(QUIET), tier1: true, creditor: true, stored: CHASE, hist: 'reply' });
    expect(r.refused).toBe(true);
    expect(r.error).toMatch(/an email from billing@example-phones\.test arrived .* after this task was last looked at/);
    expect(r.searched[0].emails).toContain('billing@example-phones.test');
    expect(r.searched[0].gmail).toBe(true);
    expect(r.captured.fields).toBeUndefined();
  });

  it('an email from before the last look, or one we sent, is not a reply', () => {
    for (const hist of ['old', 'ours']) {
      const r = run({ output: status(QUIET), tier1: true, creditor: true, stored: CHASE, hist });
      expect(r.refused, `${hist}: ${r.error}`).toBe(false);
    }
  });

  it('a history read that fails, skips Gmail or has nothing to search refuses the filing: never filed on an unread history', () => {
    const failed = run({ output: status(QUIET), creditor: true, stored: CHASE, hist: 'raise' });
    expect(failed.error).toMatch(/history could not be read to check for a reply \(worker 503\)/);
    const nogmail = run({ output: status(QUIET), creditor: true, stored: CHASE, hist: 'nogmail' });
    expect(nogmail.error).toMatch(/Gmail could not be searched for a reply/);
    const nothing = run({ output: status(QUIET), stored: { name: 'Check the hall light timer', description: '' } });
    expect(nothing.error).toMatch(/no address or reference on the task or in the output to search/);
    for (const r of [failed, nogmail, nothing]) {
      expect(r.refused).toBe(true);
      expect(r.captured.fields).toBeUndefined();
    }
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
  // Shrunk 15 Nov 2026 (finding 11): only a line that, taken whole, says nothing happens. Longer lines
  // pass, because a wrongly refused card stops real work. The fourteen real cards are in
  // tests/agent-dispatch-rest-fingerprint.test.js.
  const REPORT = 'The account was checked line by line against the bank feed for October. '.repeat(4) + '\n\n' + RECORD + '\n\n' + CLOSING;
  it.each([
    'Nothing happens.',
    'Nothing. Information only.',
    'Nothing happens. Information only.',
  ])('refuses %s on a tier-1 card', (line) => {
    const r = run({ output: REPORT, plainApprove: line, tier1: true, creditor: true, stored: CHASE });
    expect(r.refused).toBe(true);
    expect(r.error).toContain('says Approve runs nothing');
    expect(r.error).toContain('STATUS ONLY update');
    expect(r.error).toContain('say what in --plain-approve');
    expect(r.captured.fields).toBeUndefined();
  });

  it('the first look refuses before any file is uploaded', () => {
    const r = run({ output: REPORT, plainApprove: 'Nothing happens.',
      tier1: true, creditor: true, stored: CHASE, attach: true });
    expect(r.refused).toBe(true);
    expect(r.error).toContain('says Approve runs nothing');
    expect(r.uploads).toEqual([]);
  });

  it('the last look refuses a report that would have filed itself but becomes a card (a certificate owed)', () => {
    const r = run({ output: REPORT, plainApprove: 'Nothing. Information only.',
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
    const r = run({ output: REPORT, plainApprove: 'Nothing. Information only.', type: 'Analysis' });
    expect(r.refused, r.error).toBe(false);
    expect(r.captured.fields[r.fieldMap.status]).toBe('Completed');
  });

  it('escalate refuses a decision card whose Approve runs nothing', () => {
    const r = run({ op: 'escalate', output: '', plainTask: 'The phone contract ends at the end of the month.',
      plainApprove: 'Nothing happens.' });
    expect(r.refused).toBe(true);
    expect(r.error).toContain('says Approve runs nothing');
  });
});

describe('a filed task rests until its NEXT CHECK and counts as the run\'s outcome', () => {
  it('status_rest holds only while the task is exactly as the filing left it, and only until NEXT CHECK', () => {
    const r = py(`
d = lambda n: (today + timedelta(days=n)).isoformat()
stamp = today.strftime('%d %b %Y') + ' 09:00'
line = lambda until, holder='recHOLDERaaaaaaaa': f"[{stamp} — agent-dispatch] HANDLED WITHOUT YOU (status update): No reply. Nothing to approve: the task stays Today, its card and Kevin's verdict are untouched, and it rests until {until}. Level A, Kevin's ruling 14 Nov 2026. Holder: {holder}."
ts = datetime.now(m.LONDON).replace(hour=9, minute=0).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
later = datetime.now(m.LONDON).replace(hour=9, minute=30).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
ev = ("status", ts)
t = lambda **kw: dict({"outcome": "", "notes": line(d(3)), "approvedAt": "", "description": "Chase the refund.", "dueDate": "", "teamMemberIds": ["recHOLDERaaaaaaaa"]}, **kw)
FP = m.rest_fingerprint(t())
rs = lambda task, e=ev, fp=FP: m.status_rest(task, e, fingerprint=fp)
print(json.dumps([
  rs(t()),
  rs(t(notes=line(d(0))), fp=m.rest_fingerprint(t(notes=line(d(0))))),
  rs(t(approvedAt=later)),
  rs(t(outcome="Changes requested")),
  rs(t(), ("parked", ts)),
  rs(t(), fp=""),
  rs(t(description="Chase the refund.\\n\\nUPDATE " + d(0) + ": new item folded in by the duplicate gate (one subject = one open task).")),
  rs(t(description="Chase the refund.\\n\\nNEW MESSAGE " + d(0) + ": they replied.")),
  rs(t(teamMemberIds=["recSOMEONEELSEaa"])),
  rs(t(teamMemberIds=[])),
  rs(t(notes=line(d(3)) + "\\n\\n[x — agent] looked.")),
  rs(t(description="Chase the refund.  \\r\\n")),
]))`);
    expect(r[0]).toMatch(/^status update filed at .* with nothing to approve; rests until \d{4}-\d{2}-\d{2}/);
    // ends on: next check reached, a newer verdict, changes requested, a newer step, no fingerprint, a
    // fold block, a reply line, a new holder, the holder removed, a note
    expect(r.slice(1, 11)).toEqual(['', '', '', '', '', '', '', '', '', '']);
    // line ends and trailing spaces are not a change
    expect(r[11]).toMatch(/rests until/);
  });

  it('a fold is not a step in the task\'s own life: other rests, prints and open carry-out intents read as before', () => {
    const dir = mkdtempSync(tmpdir() + '/od-status-fold-ledger-');
    const r = py(`
import os
m.STATE_DIR = ${JSON.stringify(dir)}
m.INTENT_LEDGER = os.path.join(${JSON.stringify(dir)}, 'carryout-intent.jsonl')
with open(m.INTENT_LEDGER, 'w') as fh:
    for task, ev, ts in (('recDoneAaaaaaaaaa', 'done', '2026-11-14T08:00:00.000Z'), ('recDoneAaaaaaaaaa', 'folded', '2026-11-14T09:00:00.000Z'),
                         ('recIntentAaaaaaaa', 'intent', '2026-11-14T08:00:00.000Z'), ('recIntentAaaaaaaa', 'folded', '2026-11-14T09:00:00.000Z')):
        row = {'task': task, 'ts': ts, 'event': ev}
        if ev == 'done': row['fp'] = 'v1|x=1'
        fh.write(json.dumps(row) + '\\n')
print(json.dumps([m.ledger_last_events().get('recDoneAaaaaaaaaa'), sorted(m.open_intents()), m.ledger_rest_prints()]))`);
    expect(r[0]).toEqual(['done', '2026-11-14T08:00:00.000Z']);
    expect(r[1]).toEqual(['recIntentAaaaaaaa']);
    expect(r[2]).toEqual({ recDoneAaaaaaaaaa: 'v1|x=1', recIntentAaaaaaaa: '' });
  });

  it('THE REAL GATE: a new item folded into a resting task ends its rest in the real build_queue, with no ledger write', () => {
    const dir = mkdtempSync(tmpdir() + '/od-status-fold-');
    const res = py(`
import os, io, contextlib
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
gspec = importlib.util.spec_from_file_location('gate', ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(gspec); gspec.loader.exec_module(g)
TID = 'recRestedAaaaaaaa'
ANALYST = 'recqmKBmq8ZGkxVH9'
stamp = today.strftime('%d %b %Y') + ' 09:00'
until = (today + timedelta(days=3)).isoformat()
filed = f"[{stamp} — agent-dispatch] HANDLED WITHOUT YOU (status update): No reply. Nothing to approve: the task stays Today, its card and Kevin's verdict are untouched, and it rests until {until}. Level A, Kevin's ruling 14 Nov 2026. Holder: {ANALYST}."
NAME = 'Chase: Example Phones refund reply ref EXP-55102'
live = {g.F['name']: NAME, g.F['status']: {'name': 'Today'}, g.F['due']: today.isoformat(),
        g.F['team']: [ANALYST], g.F['desc']: 'CREDITOR MATTER', g.F['notes']: filed}
def req(method, path, body=None):
    if method == 'GET' and TID in path:
        return {'id': TID, 'fields': dict(live)}
    if method == 'PATCH':
        live.update(body['fields']); return {'id': TID}
    if method == 'POST' and path.endswith('/comments'):
        return {}
    raise RuntimeError('unexpected ' + method + ' ' + path)
g._request = req
d = g._dispatch()
d.STATE_DIR = ${JSON.stringify(dir)}
d.INTENT_LEDGER = os.path.join(${JSON.stringify(dir)}, 'carryout-intent.jsonl')
A = d.AF
def row():
    return {'id': TID, 'fields': {A['name']: live[g.F['name']], A['status']: {'name': 'Today'}, A['dueDate']: live[g.F['due']],
            A['teamMember']: live[g.F['team']], A['notes']: live[g.F['notes']], A['description']: live[g.F['desc']]}}
ts = (datetime.now(timezone.utc) - timedelta(minutes=30)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
with open(d.INTENT_LEDGER, 'w') as fh:
    fh.write(json.dumps({'task': TID, 'ts': ts, 'event': 'status', 'fp': d.rest_fingerprint(d.rest_view(row()))}) + '\\n')
g.fetch_open_tasks = lambda: [{'id': TID, 'fields': dict(live)}]
g.settle_owner = lambda fields, owner, day: (fields, None, [])
g.load_scan_cache = lambda: {}
g.write_track_record = lambda *a, **k: None
g.auto_reply_refusal = lambda *a, **k: ''
g.never_a_card_refusal = lambda *a, **k: ''
def queue():
    d.query_tasks = lambda formula, **kw: [row()] if formula == d.QUEUE_FORMULA else []
    d.fetch_role_roster = lambda: {}
    d.fetch_ai_agents = lambda: {ANALYST: 'AI Worker — Analyst'}
    d.rent_reply_senders = lambda *a, **k: set()
    d.compliance_book_pages = lambda *a, **k: []
    d.fetch_plans = lambda: []
    q = d.build_queue()
    return {'idle': [t['id'] for t in q['idleHandbacks']], 'work': [t['id'] for t in q['worklist'] + q['reserve']]}
before = queue()
out = io.StringIO()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
    code = g.cmd_create({g.F['name']: NAME + ' (follow-up)', g.F['desc']: 'They replied: the refund is refused.',
                         g.F['status']: 'Today', g.F['team']: [ANALYST]}, force=False)
print(json.dumps({'before': before, 'after': queue(), 'code': code, 'gate': out.getvalue().strip().splitlines()[0],
                  'ledger': [json.loads(l)['event'] for l in open(d.INTENT_LEDGER)]}))`);
    expect(res.gate).toContain('"action": "updated"');
    expect(res.ledger).toEqual(['status']);
    expect(res.before.idle).toEqual(['recRestedAaaaaaaa']);
    expect(res.after.idle).toEqual([]);
    expect(res.after.work).toEqual(['recRestedAaaaaaaa']);
  });

  // A FOLD WRITES NOTHING TO THE CARRY-OUT LEDGER (15 Nov 2026). The create gate used to record a
  // `folded` event there (record_fold); the rest fingerprint made it redundant, because a fold
  // changes the Description and that alone ends any rest. HOME is a temp folder here, so "the real
  // path" is one this test can look at without touching his.
  it('a real fold writes no ledger line, under AGENT_DISPATCH_DIR or on the default path', () => {
    const fold = (env) => {
      const script = `
import importlib.util, json, io, contextlib
from datetime import date
def boom(*a, **k): raise RuntimeError("network call in a test")
import urllib.request; urllib.request.urlopen = boom
gspec = importlib.util.spec_from_file_location('gate', ${JSON.stringify(GATE)})
g = importlib.util.module_from_spec(gspec); gspec.loader.exec_module(g)
TID, ANALYST = 'recRestedAaaaaaaa', 'recqmKBmq8ZGkxVH9'
NAME = 'Chase: Example Phones refund reply ref EXP-55102'
live = {g.F['name']: NAME, g.F['status']: {'name': 'Today'}, g.F['due']: date.today().isoformat(),
        g.F['team']: [ANALYST], g.F['desc']: 'CREDITOR MATTER', g.F['notes']: ''}
def req(method, path, body=None):
    if method == 'GET' and TID in path:
        return {'id': TID, 'fields': dict(live)}
    if method in ('PATCH', 'POST'):
        return {'id': TID}
    raise RuntimeError('unexpected ' + method + ' ' + path)
g._request = req
g.fetch_open_tasks = lambda: [{'id': TID, 'fields': dict(live)}]
g.settle_owner = lambda fields, owner, day: (fields, None, [])
g.load_scan_cache = lambda: {}
g.write_track_record = lambda *a, **k: None
g.auto_reply_refusal = lambda *a, **k: ''
g.never_a_card_refusal = lambda *a, **k: ''
out = io.StringIO()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
    g.cmd_create({g.F['name']: NAME + ' (follow-up)', g.F['desc']: 'They replied.', g.F['status']: 'Today',
                  g.F['team']: [ANALYST]}, force=False)
print(json.dumps({'gate': out.getvalue().strip().splitlines()[0]}))`;
      return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8', env }).trim().split('\n').pop());
    };
    const home = mkdtempSync(tmpdir() + '/od-fold-home-');
    const dir = mkdtempSync(tmpdir() + '/od-fold-ledger-');
    const real = `${home}/knowledge-os/logs/agent-dispatch/carryout-intent.jsonl`;
    const r = fold({ ...process.env, HOME: home, AGENT_DISPATCH_DIR: dir });
    expect(r.gate).toContain('"action": "updated"');
    expect(existsSync(`${dir}/carryout-intent.jsonl`)).toBe(false);
    const env = { ...process.env, HOME: home };
    delete env.AGENT_DISPATCH_DIR;
    const c = fold(env);
    expect(c.gate).toContain('"action": "updated"');
    expect(existsSync(real)).toBe(false);
  });

  it('every vitest file runs with AGENT_DISPATCH_DIR and MERGE_APPROVED_DIR on temp folders (tests/setup-state-dirs.js)', () => {
    const r = py(`print(json.dumps({'dir': m.STATE_DIR, 'ledger': m.INTENT_LEDGER, 'merge': m.MERGE_ATTEMPTS_FILE}))`);
    const home = process.env.HOME;
    expect(r.dir).toBe(process.env.AGENT_DISPATCH_DIR);
    expect(r.dir.startsWith(`${home}/knowledge-os`)).toBe(false);
    expect(r.ledger.startsWith(r.dir)).toBe(true);
    expect(r.merge.startsWith(`${home}/knowledge-os`)).toBe(false);
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
    fh.write(json.dumps({"task": "recRestedAaaaaaaa", "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                         "event": "status", "fp": m.rest_fingerprint(m.task_view(rows[0]))}) + "\\n")
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
