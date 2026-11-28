// Finding 20261118-agent-dispatch-1363 (high). The SPEND-line guard in
// scripts/agent_email_format.py is right at SUBMIT: a "SPEND:" line declares OUR money for
// Kevin's approval card and the recipient must never read it. But it also ran on the SEND
// path, days after Kevin approved, so a card approved BEFORE the rule existed could never be
// sent: `revise` only repairs a minor-edits approval, and recdD2hamAFbRmIoE (18 Nov 2026) sat
// as-is-approved and unsendable, with Kevin's approved text untouched.
//
// The send path now takes a STANDALONE SPEND line out of the body and records it, and still
// refuses when it cannot be done cleanly or when nobody really approved the card.
//
// These tests drive the REAL load_approved() and cmd_send() with get_task() and the network
// replaced, so the behaviour under test is the behaviour the send path runs. Back-tested
// against git HEAD before the fix: every assertion about a stripped line failed there with
// "a SPEND line sits inside the email".
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = JSON.stringify(process.env.SEND_EMAIL_UNDER_TEST || path.join(root, 'scripts/send-email.py'));

// An approved quote request whose SPEND line sits on its own line, above the closing line —
// the exact shape of the stranded card.
const WITH_SPEND = [
  'TO: quotes@example.com',
  'FROM: info@agilelets.co.uk',
  'SUBJECT: EICR quote',
  '---',
  'Hello,',
  '',
  'Please confirm you can attend on Thursday.',
  '',
  'SPEND: up to £1,188 from the maintenance float',
  '',
  'Many thanks,',
  'Roy',
  '',
  '**Carrying this out will involve:** sending the email above.',
].join('\n');

// The same card with the line never written: the control for byte-identity.
const WITHOUT_SPEND = WITH_SPEND.replace('SPEND: up to £1,188 from the maintenance float\n\n', '');

// The spend wording inside a sentence of the email: cutting the line would take the
// booking instruction with it, so this is still refused.
const INLINE_SPEND = WITH_SPEND.replace(
  'SPEND: up to £1,188 from the maintenance float',
  'SPEND: £80 covers the certificate. Please book the engineer for Thursday and confirm the time.');

function load(fields, { created = '2026-11-18T12:00:00.000Z', requireApproval = true } = {}) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.argv = ["send-email.py"]
spec = importlib.util.spec_from_file_location("se", ${SCRIPT})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = json.loads(sys.stdin.read())
F = {m.AF[k]: v for k, v in a["fields"].items()}
m.get_task = lambda task_id: {"id": task_id, "createdTime": a["created"], "fields": F}
try:
    mail = m.load_approved("recTEST", require_approval=a["requireApproval"])
    print(json.dumps({"sent": True, "body": mail["body"], "spendRemoved": mail.get("spendRemoved"),
                      "approvalProblem": mail.get("approvalProblem")}))
except SystemExit as e:
    print(json.dumps({"sent": False, "refusal": str(e)}))
`], { input: JSON.stringify({ fields, created, requireApproval }), encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

// The real cmd_send, with the worker and Airtable replaced: what left, and what was written.
function send(fields) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, io, argparse, contextlib
sys.argv = ["send-email.py"]
spec = importlib.util.spec_from_file_location("se", ${SCRIPT})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = json.loads(sys.stdin.read())
F = {m.AF[k]: v for k, v in a["fields"].items()}
m.get_task = lambda task_id: {"id": task_id, "createdTime": "2026-11-18T12:00:00.000Z", "fields": F}
m.already_sent = lambda *x, **y: None
m.send_lock = lambda *x, **y: None
m.rent_landed_refusal = lambda *x, **y: ""
m.note_tenancies = lambda *x, **y: (0, "")
m.ledger_append = lambda row: None
seen = {"payload": None, "patch": []}
def worker(url, payload=None):
    seen["payload"] = payload
    return {"id": "msg-1", "threadId": "thr-1"}
m.worker_call = worker
def api(method, url, payload=None):
    seen["patch"].append(payload)
    return {}
m.api = api
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        m.cmd_send(argparse.Namespace(task="recTEST", dry_run=False, rule=None))
    exit_msg = ""
except SystemExit as e:
    exit_msg = str(e)
print(json.dumps({"payload": seen["payload"], "patch": seen["patch"], "exit": exit_msg}))
`], { input: JSON.stringify({ fields }), encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const card = (output) => ({
  name: 'CORRESPONDENCE: EICR quote request',
  approvalOutcome: { name: 'Approved as-is' },
  taskType: { name: 'Correspondence' },
  agentOutput: output,
  sentForApprovalBy: ['recAGENT000000001'],
  approvedAt: '2026-11-18T13:00:00.000Z',
});

const SPEND_REFUSAL = /a SPEND line sits inside the email: it declares our money for the approval card and the recipient must never read it/;

describe('an approved card whose SPEND line sits inside the body still sends', () => {
  it('previews, with the line out of the body and reported', () => {
    const r = load(card(WITH_SPEND), { requireApproval: false });
    expect(r.sent).toBe(true);
    expect(r.body).not.toMatch(/SPEND/i);
    expect(r.spendRemoved).toBe('SPEND: up to £1,188 from the maintenance float');
  });

  it('the body is otherwise byte-identical to the same email written without the line', () => {
    const stripped = load(card(WITH_SPEND));
    const control = load(card(WITHOUT_SPEND));
    expect(control.sent).toBe(true);
    expect(stripped.sent).toBe(true);
    expect(stripped.body).toBe(control.body);
    expect(stripped.body).toContain('Please confirm you can attend on Thursday.');
    expect(stripped.body).toContain('Many thanks,\nRoy');
  });

  it('sends: the email that leaves holds no SPEND line, and the declaration is recorded', () => {
    const r = send(card(WITH_SPEND));
    expect(r.exit).toBe('');
    expect(r.payload.text).not.toMatch(/SPEND/i);
    expect(r.payload.subject).toBe('EICR quote');
    const notes = r.patch.map((p) => Object.values(p.fields)[0]).join('\n');
    expect(notes).toMatch(/SPEND DECLARATION KEPT OUT OF THE EMAIL/);
    expect(notes).toContain('SPEND: up to £1,188 from the maintenance float');
    expect(notes).toMatch(/^\[\d{2} \w{3} \d{4} \d{2}:\d{2} — send-email\]/m);
  });

  it('a card with no SPEND line is untouched', () => {
    const r = load(card(WITHOUT_SPEND));
    expect(r.sent).toBe(true);
    expect(r.spendRemoved).toBe('');
  });
});

describe('the leak guard is not weakened', () => {
  it('spend wording inline inside an email sentence still refuses, with the same message', () => {
    const r = load(card(INLINE_SPEND));
    expect(r.sent).toBe(false);
    expect(r.refusal).toMatch(SPEND_REFUSAL);
  });

  it('no approval evidence: the preview still refuses the SPEND line', () => {
    const bare = { ...card(WITH_SPEND), sentForApprovalBy: undefined, approvedAt: undefined };
    const r = load(bare, { requireApproval: false });
    expect(r.sent).toBe(false);
    expect(r.refusal).toMatch(SPEND_REFUSAL);
  });

  it('no approval evidence: the send refuses the card itself', () => {
    const bare = { ...card(WITH_SPEND), sentForApprovalBy: undefined, approvedAt: undefined };
    const r = load(bare);
    expect(r.sent).toBe(false);
    expect(r.refusal).toMatch(/never went through the approval gate/);
  });

  it('an approval dated before the task was created keeps its own refusal', () => {
    const r = load({ ...card(WITH_SPEND), approvedAt: '2026-11-18T11:00:00.000Z' });
    expect(r.sent).toBe(false);
    expect(r.refusal).toMatch(/earlier than the task itself/);
  });

  it('a KEVIN ONLY line is not covered by this door and still refuses', () => {
    const kevinOnly = WITH_SPEND.replace('SPEND: up to £1,188 from the maintenance float',
      'KEVIN ONLY: pay £1,188 to the contractor, reference EICR');
    const r = load(card(kevinOnly), { requireApproval: false });
    expect(r.sent).toBe(false);
    expect(r.refusal).toMatch(/a KEVIN ONLY line sits inside the email/);
  });
});
