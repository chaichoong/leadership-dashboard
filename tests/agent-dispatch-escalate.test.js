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

function escalate({ reason = '', status = 'Today', agentOutput = '', notes = '', teamMember = ['recAGENT'] }) {
  const script = `
import importlib.util, json, sys, io, contextlib
spec = importlib.util.spec_from_file_location('ad', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
captured = {}
m.get_task = lambda tid: {"id": tid, "fields": {
    m.AF["status"]: {"name": ${JSON.stringify(status)}},
    m.AF["agentOutput"]: ${JSON.stringify(agentOutput)},
    m.AF["notes"]: ${JSON.stringify(notes)},
    m.AF["teamMember"]: [{"id": i} for i in ${JSON.stringify(teamMember)}],
}}
def fake_patch(tid, fields):
    captured['task'] = tid
    captured['fields'] = fields
    return {}
m.patch_task = fake_patch
class A: pass
a = A(); a.task = 'recTEST'; a.reason = ${JSON.stringify(reason)}
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m.cmd_escalate(a)
print('@@@' + json.dumps({
    'captured': captured, 'printed': json.loads(buf.getvalue().strip().splitlines()[-1]),
    'AF': m.AF, 'taskmgr': m.TASKMGR_REC_ID, 'kevin': m.KEVIN_REC_ID,
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

  it('is idempotent: a task already at Approval with a DECIDE: line is reported, not rewritten', () => {
    const r = escalate({ status: 'Approval', agentOutput: 'DECIDE: sell or keep?\n\nEarlier output: draft', reason: 'again' });
    expect(r.captured).toEqual({});
    expect(r.printed.alreadyEscalated).toBe('recTEST');
    expect(r.printed.ask).toContain('DECIDE: sell or keep?');
  });

  it('a task at Approval WITHOUT a DECIDE: ask is still escalated (an old draft card is not a decision)', () => {
    const r = escalate({ status: 'Approval', agentOutput: 'Draft reply to the council', reason: 'Pay the £1,234.56 or dispute it?' });
    expect(r.captured.fields[r.AF.agentOutput]).toMatch(/^DECIDE: Pay the £1,234.56 or dispute it\?/);
    expect(r.captured.fields[r.AF.agentOutput]).toContain('Earlier output:\nDraft reply to the council');
  });

  it('never doubles the prefix, and an empty reason still yields a line Kevin can answer', () => {
    const doubled = escalate({ reason: 'DECIDE: keep or sell?' });
    expect(doubled.captured.fields[doubled.AF.agentOutput]).toBe('DECIDE: keep or sell?');
    const empty = escalate({ reason: '' });
    expect(empty.captured.fields[empty.AF.agentOutput]).toMatch(/^DECIDE: \S/);
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
