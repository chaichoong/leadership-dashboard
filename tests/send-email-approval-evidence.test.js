// Finding 20260922-agent-dispatch-572 (critical). On 22 Sep 2026 an agent created two tasks with a
// raw Airtable write, typed "Approved with minor edits" into Approval Outcome itself, and ran
// scripts/send-email.py, which sent both: the gate read only that string. Six earlier quote
// requests (9 and 15 Sep) had gone out the same way "pre-approved under a parent task", one with an
// Approved At copied from the parent and earlier than the task itself.
//
// These tests drive the REAL load_approved() with get_task() replaced by a fake record, so the
// refusal under test is the one the send path runs. Back-tested by deleting the evidence check.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = JSON.stringify(path.join(root, 'scripts/send-email.py'));

const OUTPUT = 'TO: quotes@example.com\nFROM: info@agilelets.co.uk\nSUBJECT: EICR quote\n---\nPlease quote.';

function load(fields, { created = '2026-09-22T12:00:00.000Z', requireApproval = true, rule = null, ruleOk = false } = {}) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.argv = ["send-email.py"]
spec = importlib.util.spec_from_file_location("se", ${SCRIPT})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = json.loads(sys.stdin.read())
F = {m.AF[k]: v for k, v in a["fields"].items()}
m.get_task = lambda task_id: {"id": task_id, "createdTime": a["created"], "fields": F}
if a["ruleOk"]:
    m.rule_send_problem = lambda *x, **y: ""
try:
    mail = m.load_approved("recTEST", require_approval=a["requireApproval"], rule=a["rule"])
    print(json.dumps({"sent": True, "approvalProblem": mail.get("approvalProblem"), "outcome": mail.get("outcome")}))
except SystemExit as e:
    print(json.dumps({"sent": False, "refusal": str(e)}))
`], { input: JSON.stringify({ fields, created, requireApproval, rule, ruleOk }), encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const base = {
  name: 'CORRESPONDENCE: EICR quote follow-up',
  approvalOutcome: { name: 'Approved with minor edits' },
  taskType: { name: 'Correspondence' },
  agentOutput: OUTPUT,
};
const genuine = { ...base, sentForApprovalBy: ['recAGENT000000001'], approvedAt: '2026-09-22T13:00:00.000Z' };

describe('send-email refuses an approval nobody gave', () => {
  it('the 22 Sep shape: approved string, no gate card, no approval time', () => {
    const r = load(base);
    expect(r.sent).toBe(false);
    expect(r.refusal).toMatch(/REFUSED: task recTEST .*never went through the approval gate/);
  });

  it('a gate card but no recorded approval', () => {
    const r = load({ ...base, sentForApprovalBy: ['recAGENT000000001'] });
    expect(r.sent).toBe(false);
    expect(r.refusal).toMatch(/no approval was ever recorded/);
  });

  it('the 15 Sep shape: an Approved At copied from a parent, earlier than the task itself', () => {
    const r = load({ ...genuine, approvedAt: '2026-09-22T11:59:00.000Z' });
    expect(r.sent).toBe(false);
    expect(r.refusal).toMatch(/earlier than the task itself/);
  });

  it('a genuine queue approval still sends', () => {
    const r = load(genuine);
    expect(r.sent).toBe(true);
    expect(r.approvalProblem).toBe('');
  });

  it('an approval given in the same second the task was created still counts', () => {
    expect(load({ ...genuine, approvedAt: '2026-09-22T12:00:00Z' }).sent).toBe(true);
  });

  it('the dry run does not refuse, but reports why it would not send', () => {
    const r = load(base, { requireApproval: false });
    expect(r.sent).toBe(true);
    expect(r.approvalProblem).toMatch(/never went through the approval gate/);
  });

  it('a rule send is judged by its rule, not by a card it never needed', () => {
    const r = load({ ...base, approvalOutcome: null }, { rule: 'quote-request', ruleOk: true });
    expect(r.sent).toBe(true);
    expect(r.outcome).toBe('rule:quote-request');
  });

  it('the not-approved refusal still comes first for an unapproved task', () => {
    const r = load({ ...genuine, approvalOutcome: { name: 'Changes requested' } });
    expect(r.sent).toBe(false);
    expect(r.refusal).toMatch(/is not approved/);
  });

  it('a bare date or an unreadable time refuses cleanly, never with a crash', () => {
    expect(load({ ...genuine, approvedAt: '2026-09-23' }).sent).toBe(true);        // read as UTC midnight, after creation
    expect(load({ ...genuine, approvedAt: '2026-09-21' }).refusal).toMatch(/earlier than the task itself/);
    expect(load({ ...genuine, approvedAt: 'yesterday' }).refusal).toMatch(/cannot be read/);
  });
});

// The dry run is how an agent proves a payload before the real send. It must not say wouldSend
// for a forged approval (review, 24 Sep 2026: deleting that clause left every other test green).
describe('the dry run reports a forged approval as not sendable', () => {
  function dry(fields) {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, io, argparse, contextlib
sys.argv = ["send-email.py"]
spec = importlib.util.spec_from_file_location("se", ${SCRIPT})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
F = {m.AF[k]: v for k, v in json.loads(sys.stdin.read()).items()}
m.get_task = lambda task_id: {"id": task_id, "createdTime": "2026-09-22T12:00:00.000Z", "fields": F}
m.already_sent = lambda task_id: None
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    m.cmd_send(argparse.Namespace(task="recTEST", dry_run=True, rule=None))
print(json.dumps(json.loads(buf.getvalue())))
`], { input: JSON.stringify(fields), encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
  }

  it('forged: wouldSend false, with the reason', () => {
    const r = dry(base);
    expect(r.wouldSend).toBe(false);
    expect(r.approvalProblem).toMatch(/never went through the approval gate/);
  });

  it('genuine: wouldSend true', () => {
    const r = dry(genuine);
    expect(r.wouldSend).toBe(true);
    expect(r.approvalProblem).toBeNull();
  });
});
