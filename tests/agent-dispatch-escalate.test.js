// An escalation is a decision CARD, not a re-link (Kevin, 15 Sep 2026).
//
// Until then `escalate` set Team Member and Assignee to Kevin and nothing
// else: no Approval status, no Sent For Approval By. The gate formula on the
// AI Agents page, the Slack digest and the agent-linked dispatch filter all
// require one or the other, so the task vanished from every surface at once.
// The Task Manager then found it "stuck" next slot and escalated it again —
// recZMDlT4l2lcwMhB seven times, rec4cpT9R5Ld538C2 across 33 runs.
//
// The real cmd_escalate runs with get_task and patch_task swapped for
// recorders, so the assertions are against the payload it would really send.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');

// The brief every card needs since 2 Oct 2026, shaped from the task that showed the bug: a card asking Kevin to
// "confirm which cards and amounts to authorise" that named no amount (see the worked example below).
const BRIEF = `WHAT THIS IS:
Five credit cards each take a payment on the 5th of the month.

WHAT HAS HAPPENED:
The September statements show minimums of £31.00, £25.00, £25.00, £8.00 and £5.00, which is £94.00 in total.
Nothing has been paid for October yet. The weekly payment run lists the same five cards.

OPTIONS:
A. Pay the minimum on each card, £94.00 in total, before the 5th.
B. Leave the cards to the weekly payment run and close this task.

RECOMMENDED: B, because the weekly payment run already lists all five cards.`;
const PLAIN_TASK = 'Five credit cards each need a payment by the 5th.';
const PLAIN_APPROVE = 'The agent closes this task and leaves the cards to the weekly payment run.';
const HISTORY = { terms: ['ref AMEX'], searched: ['tasks', 'Gmail'], notes: [], entries: [
  { date: '2026-09-05', source: 'task', text: 'completed: Credit card payments September', link: 'https://airtable.com/appX/tblY/recOLDTASK0000001' },
  { date: '2026-09-12 09:30', source: 'email', text: 'Card services: Your statement is ready', link: 'https://mail.google.com/mail/u/0/#all/abc123' },
  { date: '2026-09-12', source: 'file', text: 'file on that task: statement-aug.pdf (88 KB)', task: 'recFILETASK000001', link: 'https://v5.airtableusercontent.test/signed/expires-in-two-hours' },
] };

// brief: undefined = the BRIEF above, null = no --brief-file at all (the old one-line call).
function escalate({ reason = '', status = 'Today', agentOutput = '', notes = '', teamMember = ['recAGENT'], brief,
                    plainTask = PLAIN_TASK, plainApprove = PLAIN_APPROVE, name = 'Review the lease', description = '',
                    sender = '', inboundUrl = '', files = [], outcome = '', email = null, ref = null, property = null,
                    history = HISTORY, historyFails = '', feedbackHistory = '', approvalFeedback = '' }) {
  const cfg = { reason, status, agentOutput, notes, teamMember, brief: brief === undefined ? BRIEF : brief, plainTask,
                plainApprove, name, description, sender, inboundUrl, files, outcome, email, ref, property, history,
                historyFails, feedbackHistory, approvalFeedback };
  const script = `
import importlib.util, json, sys, io, contextlib, os, tempfile
cfg = json.loads(${JSON.stringify(JSON.stringify(cfg))})
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
captured, searched = {}, {}
m.get_task = lambda tid: {"id": tid, "fields": {
    m.AF["name"]: cfg["name"],
    m.AF["description"]: cfg["description"],
    m.AF["status"]: {"name": cfg["status"]},
    m.AF["agentOutput"]: cfg["agentOutput"],
    m.AF["notes"]: cfg["notes"],
    m.AF["teamMember"]: [{"id": i} for i in cfg["teamMember"]],
    m.AF["inboundSender"]: cfg["sender"],
    m.INBOUND_URL_FIELD: cfg["inboundUrl"],
    m.AF["attachments"]: [{"filename": n, "url": "https://dl.airtable.test/" + n} for n in cfg["files"]],
    m.AF["approvalOutcome"]: {"name": cfg["outcome"]} if cfg["outcome"] else None,
    m.AF["feedbackHistory"]: cfg["feedbackHistory"],
    m.AF["approvalFeedback"]: cfg["approvalFeedback"],
}}
def fake_patch(tid, fields):
    captured['task'] = tid
    captured['fields'] = fields
    return {}
m.patch_task = fake_patch
def fake_history(**kw):
    searched.update(kw)
    if cfg["historyFails"]:
        raise RuntimeError(cfg["historyFails"])
    return cfg["history"]
m.history = fake_history
class A: pass
a = A(); a.task = 'recTEST'; a.reason = cfg["reason"]
a.plain_task, a.plain_approve = cfg["plainTask"], cfg["plainApprove"]
a.email, a.ref, a.property = cfg["email"], cfg["ref"], cfg["property"]
if cfg["brief"] is not None:
    fd, a.brief_file = tempfile.mkstemp(suffix='.txt')
    with os.fdopen(fd, 'w') as fh: fh.write(cfg["brief"])
buf, refused = io.StringIO(), ''
try:
    with contextlib.redirect_stdout(buf):
        m.cmd_escalate(a)
except SystemExit as ex:
    refused = str(ex)
printed = buf.getvalue().strip().splitlines()
print('@@@' + json.dumps({
    'captured': captured, 'printed': json.loads(printed[-1]) if printed else {}, 'refused': refused,
    'searched': searched, 'AF': m.AF, 'taskmgr': m.TASKMGR_REC_ID, 'kevin': m.KEVIN_REC_ID,
    'inboundUrlField': m.INBOUND_URL_FIELD,
}))
`;
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(out.slice(out.indexOf('@@@') + 3));
}

describe('agent-dispatch escalate makes a decision card', () => {
  it('puts the task at Approval, sent by the Task Manager, with a DECIDE: ask from the reason', () => {
    const r = escalate({ reason: 'Sell 12 Viola Street or keep it as an HMO?' });
    const f = r.captured.fields;
    expect(f[r.AF.status]).toBe('Approval');
    expect(f[r.AF.sentForApprovalBy]).toEqual([r.taskmgr]);
    expect(f[r.AF.agentOutput]).toMatch(/^DECIDE: Sell 12 Viola Street or keep it as an HMO\?/);
    expect(r.printed.card).toBe(true);
    expect(r.printed.escalated).toBe('recTEST');
  });

  it('keeps Team Member as it was: a question about the work is not a change of holder', () => {
    const r = escalate({ reason: 'x' });
    expect(Object.keys(r.captured.fields)).not.toContain(r.AF.teamMember);
    expect(r.captured.fields[r.AF.sentForApprovalBy]).not.toContain(r.kevin);
  });

  it('is idempotent: a task already at Approval with a briefed DECIDE: card is reported, not rewritten', () => {
    const r = escalate({ status: 'Approval', agentOutput: 'DECIDE: sell or keep?\n\n' + BRIEF + '\n\nEarlier output:\ndraft', reason: 'again' });
    expect(r.captured).toEqual({});
    expect(r.printed.alreadyEscalated).toBe('recTEST');
    expect(r.printed.ask).toContain('DECIDE: sell or keep?');
  });

  it('a task at Approval WITHOUT a DECIDE: ask is still escalated (an old draft card is not a decision)', () => {
    const r = escalate({ status: 'Approval', agentOutput: 'Draft reply to the council', reason: 'Pay the £1,234.56 or dispute it?' });
    expect(r.captured.fields[r.AF.agentOutput]).toMatch(/^DECIDE: Pay the £1,234.56 or dispute it\?/);
    expect(r.captured.fields[r.AF.agentOutput]).toContain('Earlier output:\n> Draft reply to the council');
  });

  it('never doubles the prefix, and an empty reason is refused: it is the thinnest ask of all', () => {
    const doubled = escalate({ reason: 'DECIDE: keep or sell?' });
    expect(doubled.captured.fields[doubled.AF.agentOutput].split('\n')[0]).toBe('DECIDE: keep or sell?');
    const empty = escalate({ reason: '  \n ' });
    expect(empty.refused).toContain('has no ask');
    expect(empty.captured).toEqual({});
  });

  it('writes no Assignee: the card is the surface, and Assignee fires the assignment DM', () => {
    const r = escalate({ reason: 'x' });
    expect(Object.keys(r.captured.fields)).not.toContain(r.AF.assignee);
  });

  it('clears a standing verdict and stamps Notes, appending rather than overwriting', () => {
    const r = escalate({ reason: 'x', notes: 'Kevin wrote this.' });
    expect(r.captured.fields).toHaveProperty(r.AF.approvalOutcome, null);
    expect(r.captured.fields).toHaveProperty(r.AF.approvedAt, null);
    expect(r.captured.fields[r.AF.notes]).toContain('Kevin wrote this.');
    expect(r.captured.fields[r.AF.notes]).toMatch(/Escalated to Kevin as a decision card \(holder [^)]+\): DECIDE: x/);
  });

  it('would actually appear in the gate: the formula requires Approval plus a sender', () => {
    const page = require('node:fs').readFileSync(resolve(ROOT, 'os/agents/index.html'), 'utf8');
    const formula = page.match(/const APV_QUEUE_FORMULA = "([^"]+)"/)[1];
    expect(formula).toContain("{Status}='Approval'");
    expect(formula).toContain('{Sent For Approval By}');
    const r = escalate({ reason: 'x' });
    expect(r.captured.fields[r.AF.status]).toBe('Approval');
    expect(r.captured.fields[r.AF.sentForApprovalBy]).toHaveLength(1);
  });
});

// Reviewer finding, 15 Sep 2026: without this, an answered card kept its
// outcome and its DECIDE: line, so it was filed as `decided` on every run,
// routed again every slot, and re-escalated with the same question after
// seven days.
describe('carrying out an answered decision closes the card', () => {
  const carryOut = (cmd, extra) => {
    const script = `
import importlib.util, json, io, contextlib
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
captured = {}
rec = {"id": "recTEST", "fields": {
    m.AF["agentOutput"]: "DECIDE: sell or keep?\\n\\nEarlier output: draft",
    m.AF["approvalOutcome"]: {"name": "Approved as-is"},
    m.AF["approvalFeedback"]: "Sell it.",
    m.AF["teamMember"]: [{"id": m.TASKMGR_REC_ID}],
    m.AF["sentForApprovalBy"]: [{"id": m.TASKMGR_REC_ID}],
    m.AF["notes"]: "[10 Sep 2026 — agent-dispatch] Escalated to Kevin as a decision card (holder recAGENT): DECIDE: sell or keep?",
}}
m.get_task = lambda tid: rec
m.patch_task = lambda tid, fields: captured.update(fields) or {}
m.require_role_agent_live = lambda *a, **k: None
m.subprocess.run = lambda *a, **k: type('R', (), {'returncode': 0})()
class A: pass
a = A(); a.task = 'recTEST'; ${extra}
with contextlib.redirect_stdout(io.StringIO()):
    m.${cmd}(a)
out = captured.get(m.AF["agentOutput"], rec["fields"][m.AF["agentOutput"]])
print('@@@' + json.dumps({'still_card': m.is_decide_card(out), 'output': out,
    'outcome': captured.get(m.AF["approvalOutcome"], 'untouched'),
    'sender': captured.get(m.AF["sentForApprovalBy"], 'untouched'),
    'notes': captured.get(m.AF["notes"], '')}))
`;
    const out = execFileSync('python3', ['-c', script], { encoding: 'utf8' });
    return JSON.parse(out.slice(out.indexOf('@@@') + 3));
  };

  it('route after the answer clears the outcome and the DECIDE: line, keeping the verdict on the task', () => {
    const r = carryOut('cmd_route', `a.to = 'recQkO6BA4w5zqwZ4'`);
    expect(r.still_card).toBe(false);
    expect(r.output).toMatch(/^DECIDED \(Kevin, \d{1,2} \w{3} \d{4}\): Approved as-is — Sell it\./);
    expect(r.output).toContain('DECIDE: sell or keep?');
    expect(r.outcome).toBeNull();
    expect(r.sender).toEqual([]);
    expect(r.notes).toContain('Decision carried out: Approved as-is — Sell it.');
  });

  it('handover after the answer does the same', () => {
    const r = carryOut('cmd_handover', `a.to = 'roy.lavin1978@gmail.com'; a.reason = 'Kevin said sell'`);
    expect(r.still_card).toBe(false);
    expect(r.outcome).toBeNull();
    expect(r.notes).toContain('Decision carried out');
    expect(r.notes).toContain('Handed over to Roy Lavin');
  });

  it('the escalation stamp records the holder, so the board can restore it after the gate re-links', () => {
    const r = escalate({ reason: 'x', teamMember: ['recHOLDER'] });
    expect(r.captured.fields[r.AF.notes]).toContain('(holder recHOLDER): DECIDE: x');
  });
});

describe('the dispatch window takes a due Upcoming task', () => {
  const py = (code) => execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
${code}`], { encoding: 'utf8' }).trim();

  it('the queue formula decides on the date field, never a bare string compare', () => {
    const formula = py('print(m.QUEUE_FORMULA)');
    expect(formula).toContain("{Status}='Today'");
    expect(formula).toContain("{Status}='Overdue'");
    expect(formula).toContain("IS_SAME({Due Date},TODAY(),'day')");
    expect(formula).toContain('IS_BEFORE({Due Date},TODAY())');
    expect(formula).not.toMatch(/\{Due Date\}\s*<=?\s*'/);
    // build_queue reads through it: the string literal is not left behind.
    const src = require('node:fs').readFileSync(DISPATCH, 'utf8');
    const start = src.indexOf('def build_queue');
    const bq = src.slice(start, src.indexOf('\ndef ', start + 1));
    expect(bq).toContain('query_tasks(QUEUE_FORMULA)');
    expect(bq).not.toContain(`"OR({Status}='Today',{Status}='Overdue')"`);
    // A blank date is never due and a Some Day task is parked, not late.
    expect(formula).toContain('{Due Date},NOT({Some Day})');
  });

  // Kevin's answer to a DECIDE: card is a ruling for the Task Manager's board,
  // never an approved hand-back for dispatch to "carry out" as if the question
  // were a draft. Reviewer finding, 15 Sep 2026.
  it('an answered DECIDE: card is a decided ruling, never a carry-out', () => {
    expect(JSON.parse(py(`print(json.dumps([m.is_decide_card('DECIDE: sell?'), m.is_decide_card('  decide: x'), m.is_decide_card('Draft: DECIDE later'), m.is_decide_card('')]))`)))
      .toEqual([true, true, false, false]);
    const src = require('node:fs').readFileSync(DISPATCH, 'utf8');
    const start = src.indexOf('def build_queue');
    const bq = src.slice(start, src.indexOf('\ndef ', start + 1));
    const decidedAt = bq.indexOf('is_decide_card(t["agentOutput"])');
    const approvedAt = bq.indexOf('approved_hb.append(t)');
    expect(decidedAt).toBeGreaterThan(0);
    expect(decidedAt, 'the decided check must run before the approved hand-back split').toBeLessThan(approvedAt);
    expect(bq).toContain('"decided": decided');
  });

  it('in_dispatch_window mirrors the formula for a record in hand', () => {
    const out = py(`print(json.dumps([
  m.in_dispatch_window('Today', '', '2026-09-15'),
  m.in_dispatch_window('Overdue', '2026-12-01', '2026-09-15'),
  m.in_dispatch_window('Upcoming', '2026-09-15', '2026-09-15'),
  m.in_dispatch_window('Upcoming', '2026-09-01', '2026-09-15'),
  m.in_dispatch_window('Upcoming', '2026-09-16', '2026-09-15'),
  m.in_dispatch_window('Upcoming', '', '2026-09-15'),
  m.in_dispatch_window('Approval', '2026-09-01', '2026-09-15'),
]))`);
    expect(JSON.parse(out)).toEqual([true, true, true, true, false, false, false]);
  });

  // The same clause, in the script that flips the stored status each slot,
  // must not drift from the queue's: two windows would be two boards.
  it('flip-due in task-hygiene-sweep.py uses the identical Upcoming clause', () => {
    const sweep = require('node:fs').readFileSync(resolve(ROOT, 'scripts/task-hygiene-sweep.py'), 'utf8');
    const flip = execFileSync('python3', ['-c', `
import importlib.util
spec = importlib.util.spec_from_file_location('ths', ${JSON.stringify(resolve(ROOT, 'scripts/task-hygiene-sweep.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.DUE_UPCOMING_FORMULA)`], { encoding: 'utf8' }).trim();
    expect(flip).toBe(py('print(m.DUE_UPCOMING_CLAUSE)'));
    expect(sweep).toContain('"typecast": False');
    const runner = require('node:fs').readFileSync(resolve(ROOT, 'scripts/task-manager-run.sh'), 'utf8');
    expect(runner).toMatch(/task-hygiene-sweep\.py" flip-due/);
  });
});

// 30 Sep 2026: the Task Manager escalated Content Engine episode 2059 as "approved but unpublished" when it had been
// live on every channel since 17 Sep. An episode card closes itself once the episode is out, so it is never a decision
// for Kevin, whoever holds it. Drives the real cmd_escalate with get_task and patch_task swapped for recorders.
describe('escalate refuses a Content Engine episode card', () => {
  function tryEscalate(name, teamMember) {
    return JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, io, contextlib, os, tempfile
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
patched = []
m.get_task = lambda tid: {"id": tid, "fields": {m.AF["name"]: ${JSON.stringify(name)}, m.AF["status"]: {"name": "Today"},
    m.AF["agentOutput"]: "Publish Episode 2059", m.AF["notes"]: "", m.AF["teamMember"]: [{"id": i} for i in ${JSON.stringify(teamMember)}]}}
m.patch_task = lambda tid, fields: patched.append(tid) or {}
m.history = lambda **kw: {"terms": [], "searched": ["tasks"], "entries": [], "notes": []}
class A: pass
a = A(); a.task = 'recmxqJdhLA5mZXpB'; a.reason = '9 episodes approved but unpublished'
fd, a.brief_file = tempfile.mkstemp(suffix='.txt')
with os.fdopen(fd, 'w') as fh: fh.write(${JSON.stringify(BRIEF)})
a.plain_task, a.plain_approve = ${JSON.stringify(PLAIN_TASK)}, ${JSON.stringify(PLAIN_APPROVE)}
refused = ''
try:
    with contextlib.redirect_stdout(io.StringIO()): m.cmd_escalate(a)
except SystemExit as ex:
    refused = str(ex)
print(json.dumps({"refused": refused, "patched": patched}))`], { encoding: 'utf8' }).trim().split('\n').pop());
  }
  const EP = 'CONTENT: Publish Episode 2059 of Diary of a Runpreneur - STOP OVEREATING / ONE SIMPLE HACK';

  it('refuses an episode card and writes nothing, whoever holds it', () => {
    for (const holder of [['recRcy1Edas6rGaaF'], ['rec1hYELb4zS8pjjO'], []]) {
      const r = tryEscalate(EP, holder);
      expect(r.refused).toMatch(/^REFUSED: recmxqJdhLA5mZXpB is a Content Engine episode card/);
      expect(r.patched).toEqual([]);
    }
  });

  it("still escalates the engine's other cards and any other agent's card", () => {
    for (const [name, holder] of [['CONTENT: Performance read for 9 August to 7 September', ['recRcy1Edas6rGaaF']],
                                  ['Renew the EICR at 12 Viola Street', ['recAGENT']]]) {
      const r = tryEscalate(name, holder);
      expect(r.refused).toBe('');
      expect(r.patched).toEqual(['recmxqJdhLA5mZXpB']);
    }
  });
});

// THE DECISION BRIEF (Kevin, 2 Oct 2026): "doesn't include all the required information to be able to make
// decisions. It needs to have the full history, like all of the other approval cards. Any relevant links and
// attachments all need to be included." The live queue that day held three decision cards of 250 to 285 characters:
// one DECIDE: line, no plain lines, no TRACK RECORD, no figure. The worked example is the credit card task
// (rec23ZucTYlQexhqT): it asked him to "confirm which cards and amounts to authorise" and named no amount. Each test
// drives the real cmd_escalate; back-tested by taking the brief check out, which fails the first four.
describe('a decision card carries a brief, its history, its links and its files', () => {
  const CARDS = {
    name: 'Credit Card Payments - payments due 5th of the month',
    description: '- Card one\n- Card two\n- Card three\n- Card four\n- Card five',
    reason: 'Credit card payments due 5th - pay the minimums now, or leave them to the weekly payment run?',
  };
  const THIN = 'DECIDE: Credit card payments due 5th - confirm which cards and amounts to authorise, or confirm this is '
    + 'already covered by the weekly Payment Run process and can be closed.\n\nEarlier output:\nDECIDE: Credit card '
    + 'payments due 5th of month - approve and authorise payments';

  it('refuses the one-line escalation that made the thin cards, and writes nothing', () => {
    const r = escalate({ ...CARDS, brief: null });
    expect(r.refused).toMatch(/^REFUSED: recTEST was escalated with one line and no brief/);
    expect(r.refused).toContain('WHAT HAS HAPPENED:');   // the refusal teaches the format
    expect(r.captured).toEqual({});
  });

  it('refuses a brief with a section missing, or with fewer than two options', () => {
    const noHistory = escalate({ ...CARDS, brief: BRIEF.replace(/WHAT HAS HAPPENED:[\s\S]*?\n\nOPTIONS:/, 'OPTIONS:') });
    expect(noHistory.refused).toContain("no 'WHAT HAS HAPPENED:' section");
    const oneOption = escalate({ ...CARDS, brief: BRIEF.replace(/^B\. .*\n/m, '') });
    expect(oneOption.refused).toContain('fewer than two choices');
    const noRec = escalate({ ...CARDS, brief: BRIEF.replace(/RECOMMENDED:.*$/, 'RECOMMENDED: B') });
    expect(noRec.refused).toContain("'RECOMMENDED:' section is 1 characters");
    for (const r of [noHistory, oneOption, noRec]) expect(r.captured).toEqual({});
  });

  it('refuses a money question with no figure, unless the brief says where the figure was looked for', () => {
    const noFigure = BRIEF.replace(/£[\d.,]+/g, 'an amount');
    const r = escalate({ ...CARDS, brief: noFigure });
    expect(r.refused).toContain('the ask is about money and the brief gives no figure');
    expect(r.captured).toEqual({});
    const looked = escalate({ ...CARDS, brief: noFigure + '\nAMOUNT NOT KNOWN: the statements are behind a bank sign-in the robot does not hold.' });
    expect(looked.refused).toBe('');
    // not a money question: no figure is asked for
    const lease = escalate({ name: 'Review the lease', reason: 'Renew the lease or let it lapse?', brief: noFigure });
    expect(lease.refused).toBe('');
  });

  it('refuses a card without the two plain lines every other card opens with', () => {
    const r = escalate({ ...CARDS, plainApprove: '' });
    expect(r.refused).toContain('--plain-approve is empty');
    expect(r.captured).toEqual({});
  });

  it('writes the ask first, then the brief, the links and files, and the dated history with its links', () => {
    const r = escalate({ ...CARDS, sender: 'Card Services <statements@cards.example>', files: ['statement-sep.pdf'],
      inboundUrl: 'https://mail.google.com/mail/u/0/#all/19f370255f2aa650 imessage:GUID https://mail.google.com/mail/u/0/#all/19f370255f2aa650' });
    expect(r.refused).toBe('');
    const out = r.captured.fields[r.AF.agentOutput];
    expect(out.split('\n')[0]).toBe('DECIDE: ' + CARDS.reason);
    for (const heading of ['WHAT THIS IS:', 'WHAT HAS HAPPENED:', 'OPTIONS:', 'RECOMMENDED:']) expect(out).toContain(heading);
    expect(out).toContain('£94.00');
    expect(out).toContain('LINKS AND FILES:\n- The original email: https://mail.google.com/mail/u/0/#all/19f370255f2aa650\n'
      + '- File on this task: statement-sep.pdf (opens from the story so far, below)\n'
      + '- This task in Airtable: https://airtable.com/');
    expect(out.match(/The original email:/g)).toHaveLength(1);   // the duplicate and the imessage key are dropped
    expect(out).not.toContain('dl.airtable.test');               // a file link dies within hours; the card opens files itself
    expect(out).toContain('TRACK RECORD: (searched tasks + Gmail for ref AMEX)');
    expect(out).toContain('- 05 Sep 2026 — task: completed: Credit card payments September (https://airtable.com/appX/tblY/recOLDTASK0000001)');
    expect(out).toContain('- 12 Sep 2026 09:30 — email: Card services: Your statement is ready (https://mail.google.com/mail/u/0/#all/abc123)');
    // a file on another task links to that task: the signed file link would be dead by the time he reads the card
    expect(out).toMatch(/- 12 Sep 2026 — file: file on that task: statement-aug\.pdf \(88 KB\) \(https:\/\/airtable\.com\/\w+\/\w+\/recFILETASK000001\)/);
    expect(out).not.toContain('airtableusercontent');
    expect(out.indexOf('RECOMMENDED:')).toBeLessThan(out.indexOf('LINKS AND FILES:'));
    expect(out.indexOf('LINKS AND FILES:')).toBeLessThan(out.indexOf('TRACK RECORD:'));
    expect(r.captured.fields[r.AF.plainSummary]).toBe(`TASK: ${PLAIN_TASK}\nIF YOU APPROVE: ${PLAIN_APPROVE}`);
    expect(r.printed.trackRecord).toContain('TRACK RECORD:');
  });

  it('searches the history on the sender, the references on the task and whatever the agent names', () => {
    const r = escalate({ ...CARDS, description: 'Account ref AB12345 on the statement', sender: 'Card Services <statements@cards.example>',
      email: ['help@bank.example'], ref: ['Amex'], property: ['12 Viola Street'] });
    expect(r.searched.emails).toEqual(['help@bank.example', 'statements@cards.example']);
    expect(r.searched.refs).toEqual(['Amex', 'AB12345']);
    expect(r.searched.properties).toEqual(['12 Viola Street']);
    expect(r.searched.exclude_task).toBe('recTEST');
  });

  it('a history search that fails says so on the card and never loses the escalation', () => {
    const r = escalate({ ...CARDS, historyFails: 'Airtable 503' });
    expect(r.refused).toBe('');
    expect(r.captured.fields[r.AF.agentOutput]).toContain('TRACK RECORD: not built (Airtable 503)');
  });

  it('rebuilds a thin card already in the queue once, without a second escalation stamp', () => {
    const notes = '[30 Sep 2026 — agent-dispatch] Escalated to Kevin as a decision card (holder recHOLDER): DECIDE: old';
    const r = escalate({ ...CARDS, status: 'Approval', agentOutput: THIN, notes });
    expect(r.refused).toBe('');
    expect(r.printed.rebuilt).toBe(true);
    const out = r.captured.fields[r.AF.agentOutput];
    expect(out.split('\n')[0]).toBe('DECIDE: ' + CARDS.reason);
    expect(out).not.toContain('confirm which cards and amounts');   // the thin asks are not carried under the new card
    expect(out).not.toContain('Earlier output:');
    const written = r.captured.fields[r.AF.notes];
    // stamped as an escalation, so the board dates his answer from it, with the holder the FIRST one recorded
    // (the gate re-links the task to the Task Manager, so today's holder is the wrong one to restore)
    expect(written).toContain('Escalated to Kevin as a decision card (holder recHOLDER), rebuilt with a full brief: DECIDE: ' + CARDS.reason);
    // ...and the rebuilt card is then left alone
    const again = escalate({ ...CARDS, status: 'Approval', agentOutput: out, notes: written });
    expect(again.captured).toEqual({});
    expect(again.printed.alreadyEscalated).toBe('recTEST');
  });

  it('never rewrites a card Kevin has answered, at any status, and tells the caller to carry his answer out', () => {
    // The page moves a task to Today the moment he decides, so that is the state an answered card is really in.
    for (const status of ['Today', 'Approval', 'Overdue']) {
      const thin = escalate({ ...CARDS, status, agentOutput: THIN, outcome: 'Approved as-is', approvalFeedback: 'Leave it to the payment run.' });
      expect(thin.captured).toEqual({});
      expect(thin.refused).toMatch(/^REFUSED: Kevin has ANSWERED the decision card on recTEST \(Approved as-is: "Leave it to the payment run\."\)/);
    }
    // a briefed card approved with an empty box: his answer is the recommendation, and the refusal says which
    const briefed = escalate({ ...CARDS, status: 'Today', outcome: 'Approved as-is',
      agentOutput: 'DECIDE: x?\n\n' + BRIEF + '\n\nLINKS AND FILES:\n- y' });
    expect(briefed.captured).toEqual({});
    expect(briefed.refused).toContain("he took the card's recommendation: B, because the weekly payment run already lists all five cards.");
  });

  it('archives an earlier answer and clears it, so an approval with an empty box is not read as the old words', () => {
    const r = escalate({ ...CARDS, approvalFeedback: 'Leave it until November.',
      feedbackHistory: '[2026-09-01 09:00] An older note.',
      brief: BRIEF + '\n\nSINCE YOU LAST ANSWERED: it is now November, the month you said to bring it back.' });
    expect(r.refused).toBe('');
    expect(r.captured.fields).toHaveProperty(r.AF.approvalFeedback, null);
    expect(r.captured.fields[r.AF.feedbackHistory]).toMatch(/^\[2026-09-01 09:00\] An older note\.\n\n\[\d{4}-\d\d-\d\d \d\d:\d\d\] Leave it until November\.$/);
    expect(r.captured.fields[r.AF.agentOutput]).toContain('- latest: Leave it until November.');
    // already archived by the page: cleared, never written twice
    const again = escalate({ ...CARDS, approvalFeedback: 'Leave it until November.',
      feedbackHistory: '[2026-09-23 14:06] Leave it until November.',
      brief: BRIEF + '\n\nSINCE YOU LAST ANSWERED: it is now November, the month you said to bring it back.' });
    expect(again.captured.fields).toHaveProperty(again.AF.approvalFeedback, null);
    expect(Object.keys(again.captured.fields)).not.toContain(again.AF.feedbackHistory);
  });

  it('refuses a brief line the page or a sign-in command would read as something else', () => {
    for (const line of ['SIGN-IN NEEDED: the bank site (https://bank.example/login)', 'TO: bank@example.com', 'SUBJECT: Payment',
                        '**Carrying this out will involve:** paying £94.00', 'CHECKED: handled=no; trigger=money', 'TRACK RECORD: none found (searched nothing)']) {
      const r = escalate({ ...CARDS, brief: BRIEF.replace('OPTIONS:', line + '\n\nOPTIONS:') });
      expect(r.refused, line).toContain('a line the card reads as something else');
      expect(r.captured).toEqual({});
    }
  });

  it('measures the recommendation as the board reads it: its first paragraph', () => {
    const r = escalate({ ...CARDS, brief: BRIEF.replace(/RECOMMENDED:.*$/, 'RECOMMENDED: B.\n\nBecause the weekly payment run already lists all five cards.') });
    expect(r.refused).toContain("'RECOMMENDED:' section is 2 characters");
    // an AMOUNT NOT KNOWN line inside a section does not cut that section short
    const amount = escalate({ ...CARDS, brief: BRIEF.replace(/£[\d.,]+/g, 'an amount')
      .replace('OPTIONS:', 'AMOUNT NOT KNOWN: the statements are behind a bank sign-in the robot does not hold.\n\nOPTIONS:') });
    expect(amount.refused).toBe('');
  });

  it('a money question worded as a quote or a cost needs a figure too, and pounds or GBP count as one', () => {
    const noFigure = BRIEF.replace(/£[\d.,]+/g, 'an amount');
    expect(escalate({ name: 'Boiler repair', reason: 'Which quote do you want?', brief: noFigure }).refused).toContain('gives no figure');
    expect(escalate({ name: 'Boiler repair', reason: 'Which quote do you want?', brief: noFigure.replace('an amount', '94 pounds') }).refused).toBe('');
    expect(escalate({ name: 'Boiler repair', reason: 'Which quote do you want?', brief: noFigure.replace('an amount', 'GBP 94.00') }).refused).toBe('');
  });

  it('a brief file that cannot be read is a refusal the agent can act on, not a traceback', () => {
    const script = `
import importlib.util, json
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.get_task = lambda tid: {"id": tid, "fields": {m.AF["name"]: "Review the lease", m.AF["status"]: {"name": "Today"}}}
written = []
m.patch_task = lambda tid, fields: written.append(tid) or {}
class A: pass
out = []
for path in ('/nonexistent/od-test-brief.txt', '/tmp'):
    a = A(); a.task = 'recTEST'; a.reason = 'Renew or not?'; a.brief_file = path
    try: m.cmd_escalate(a); out.append('accepted')
    except SystemExit as ex: out.append(str(ex)[:80])
    except Exception as ex: out.append('TRACEBACK ' + type(ex).__name__)
print(json.dumps({"out": out, "written": written}))`;
    const r = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n').pop());
    for (const line of r.out) expect(line).toMatch(/^REFUSED: the brief file for recTEST could not be read/);
    expect(r.written).toEqual([]);
  });

  it('marks a decision on the private matter the way every other card on it is marked, under the ask', () => {
    const r = escalate({ name: 'Statutory demand received: reply due', reason: 'Send the reply as drafted, or hold it?' });
    const out = r.captured.fields[r.AF.agentOutput];
    expect(out.split('\n')[0]).toBe('DECIDE: Send the reply as drafted, or hold it?');   // still a decision card
    expect(out).toMatch(/TIER 1\./);
    expect(out.indexOf('TIER 1.')).toBeLessThan(out.indexOf('WHAT THIS IS:'));
    expect(escalate({ ...CARDS }).captured.fields[r.AF.agentOutput]).not.toMatch(/TIER 1\./);
  });

  it('keeps the whole card when a long earlier draft pushes the output past the field limit', () => {
    const r = escalate({ ...CARDS, agentOutput: 'An old report line that goes on.\n'.repeat(4000) });
    const out = r.captured.fields[r.AF.agentOutput];
    expect(out.length).toBe(95000);
    for (const block of ['DECIDE:', 'RECOMMENDED:', 'LINKS AND FILES:', 'TRACK RECORD:']) {
      expect(out.indexOf(block)).toBeGreaterThan(-1);
      expect(out.indexOf(block)).toBeLessThan(out.indexOf('Earlier output:'));
    }
  });

  it('the command line carries every flag the manuals tell an agent to pass', () => {
    const help = execFileSync('python3', [DISPATCH, 'escalate', '--help'], { encoding: 'utf8' });
    const manuals = ['task-manager-board', 'agent-dispatch'].map((n) =>
      require('node:fs').readFileSync(resolve(ROOT, `.claude/scheduled-tasks/${n}/SKILL.md`), 'utf8'));
    for (const flag of ['--reason', '--brief-file', '--plain-task', '--plain-approve', '--email', '--ref', '--property']) {
      expect(help).toContain(flag);
      expect(manuals[0]).toContain(flag);
    }
    for (const flag of ['--brief-file', '--plain-task', '--plain-approve']) expect(manuals[1]).toContain(flag);
  });

  it('the page reads the new card the right way: the ask is the DECIDE line, nothing in it is an action or a sign-in', () => {
    const page = require('node:fs').readFileSync(resolve(ROOT, 'os/agents/index.html'), 'utf8');
    const apvSummary = new Function(page.match(/const APV_SUMMARY_IS_ACTION[\s\S]*?\n\}/)[0] + '; return apvSummary;')();
    const draft = 'TO: bank@example.com\nSUBJECT: Payment plan\n\nDear Sir\n\nSIGN-IN NEEDED: Pingen (https://app.pingen.com/)\n\n'
      + 'CHECKED: handled=no; trigger=money\n\n**Carrying this out will involve:** emailing the bank.';
    const r = escalate({ ...CARDS, agentOutput: draft, feedbackHistory: '[2026-09-30 22:24] Knocked back to 2026-10-05' });
    const out = r.captured.fields[r.AF.agentOutput];
    expect(out.length).toBeGreaterThan(280);                       // long enough for the page to summarise
    expect(apvSummary(out)).toBe('DECIDE: ' + CARDS.reason);       // not "Send an email to bank@...", not an action
    expect(out).not.toMatch(/^\s*SIGN-IN NEEDED:/m);               // SIGNIN_LINE_RE and the page both anchor on the line start
    expect(out).not.toMatch(/^(TO|SUBJECT|CHECKED):/m);
    expect(out).toContain('> SIGN-IN NEEDED: Pingen');             // still there to read, quoted
  });

  // Both live cards had been answered on 23 Sep and came back on 30 Sep as "prior escalation had no recorded answer".
  const SAID = '[2026-09-23 13:27] This isn\'t due until the 5th of the month, so why are you bringing it to my attention\nfor now?\n\n[2026-09-30 22:24] Knocked back to 2026-10-05';

  it('refuses to ask again a question Kevin has already answered, and quotes his answer back', () => {
    const r = escalate({ ...CARDS, feedbackHistory: SAID });
    expect(r.refused).toContain('Kevin has already answered on this task, and the brief does not say what has changed');
    expect(r.refused).toContain("- 23 Sep 2026: This isn't due until the 5th of the month, so why are you bringing it to my attention for now?");
    expect(r.refused).not.toContain('Knocked back');   // a knock-back is a date, not an answer
    expect(r.captured).toEqual({});
    // a live Approval Feedback not yet archived counts too
    const live = escalate({ ...CARDS, approvalFeedback: 'Leave it until November.' });
    expect(live.refused).toContain('- latest: Leave it until November.');
  });

  it('puts his own dated words straight under the ask once the brief says what has changed', () => {
    const r = escalate({ ...CARDS, feedbackHistory: SAID,
      brief: BRIEF + '\n\nSINCE YOU LAST ANSWERED: it is now the 5th, the date you said to bring it back.' });
    expect(r.refused).toBe('');
    const out = r.captured.fields[r.AF.agentOutput];
    expect(out).toContain('WHAT YOU HAVE ALREADY SAID:\n'
      + "- 23 Sep 2026: This isn't due until the 5th of the month, so why are you bringing it to my attention for now?\n"
      + '- 30 Sep 2026: Knocked back to 2026-10-05');
    expect(out.indexOf('DECIDE:')).toBeLessThan(out.indexOf('WHAT YOU HAVE ALREADY SAID:'));
    expect(out.indexOf('WHAT YOU HAVE ALREADY SAID:')).toBeLessThan(out.indexOf('WHAT THIS IS:'));
    // a knock-back alone is not an answer: no extra section is asked for, and the date still shows
    const knocked = escalate({ ...CARDS, feedbackHistory: '[2026-09-30 22:24] Knocked back to 2026-10-05' });
    expect(knocked.refused).toBe('');
    expect(knocked.captured.fields[knocked.AF.agentOutput]).toContain('- 30 Sep 2026: Knocked back to 2026-10-05');
  });

  it("an earlier draft kept under the card cannot pose as the card's own action or brief", () => {
    const draft = 'Draft reply to the bank.\n\nRECOMMENDED: an old line\n\n**Carrying this out will involve:** emailing the bank.';
    const r = escalate({ ...CARDS, agentOutput: draft });
    const out = r.captured.fields[r.AF.agentOutput];
    expect(out).toContain('Earlier output:\n> Draft reply to the bank.');
    expect(out).toContain('> RECOMMENDED: an old line');           // quoted, so it is not a section of this card
    // the page reads the LAST carry-out line in the output as what approving does
    expect(out).not.toMatch(/carrying this out will involve/i);
    expect(out).toContain('The earlier draft would have involved: emailing the bank.');
  });

  it('the board reads the recommendation off the card the escalation wrote, not off an earlier draft', () => {
    const r = escalate({ ...CARDS, agentOutput: 'Old draft.\n\nRECOMMENDED: an old line' });
    const out = r.captured.fields[r.AF.agentOutput];
    const rec = execFileSync('python3', ['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('tm', ${JSON.stringify(resolve(ROOT, 'scripts/task-manager.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.card_recommended(sys.stdin.read()))`], { encoding: 'utf8', input: out }).trim();
    expect(rec).toBe('B, because the weekly payment run already lists all five cards.');
  });

  it('reads the email link from the same field the page and the create gate use', () => {
    const page = require('node:fs').readFileSync(resolve(ROOT, 'os/agents/index.html'), 'utf8');
    const gate = require('node:fs').readFileSync(resolve(ROOT, 'scripts/create-agent-task.py'), 'utf8');
    const r = escalate({ ...CARDS });
    expect(r.inboundUrlField).toBe(page.match(/inboundUrl:\s*'(fld\w+)'/)[1]);
    expect(r.inboundUrlField).toBe(gate.match(/"inboundUrl":\s*"(fld\w+)"/)[1]);
  });
});
