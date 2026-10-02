// VERIFY REJECTED A CORRECT CLOSE (finding 20260929-task-manager-board-663).
//
// There are TWO legitimate ways a task the foreman closed ends up closed:
//
//   1. THE CARD. The Task Manager submits it through the approval gate, so
//      `Sent For Approval By` holds the Task Manager and Kevin decides.
//   2. THE LEVEL A CARRY-OUT. agent-dispatch.py's handle_without_kevin()
//      completes it without Kevin under his 7 Sep 2026 ruling. That path sets
//      Status = Completed, deliberately CLEARS `Sent For Approval By`, and
//      stamps "HANDLED WITHOUT YOU" into Notes.
//
// cmd_verify demanded the card on both, so a correct, evidence-cited Level A
// close was reported as a problem and failed the whole slot — the foreman was
// marked wrong for doing exactly what the ruling says.
//
// These drive the REAL cmd_verify with only the Airtable read stubbed, so the
// two branches are exercised rather than read.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TM = join(root, 'scripts/task-manager.py');
const src = readFileSync(TM, 'utf8');

// The marker the two scripts must agree on, read from agent-dispatch.py rather
// than copied: a rename there must fail here, not go quietly out of step.
const dispatchMark = readFileSync(join(root, 'scripts/agent-dispatch.py'), 'utf8')
  .match(/^HANDLED_MARK = "([^"]+)"/m);

describe('the two scripts agree on the marker', () => {
  it('task-manager.py reads agent-dispatch.py\'s own HANDLED_MARK text', () => {
    expect(dispatchMark).toBeTruthy();
    expect(src).toMatch(new RegExp(`HANDLED_NOTE_MARK = "${dispatchMark[1]}"`));
  });
});

/**
 * Drives cmd_verify over ONE claimed action against ONE live task record.
 * `fields` is what Airtable hands back for that record.
 */
function verifyClose(move, fields) {
  const scratch = mkdtempSync(join(tmpdir(), 'tm-levelA-'));
  const start = Math.floor(Date.now() / 1000);
  writeFileSync(join(scratch, 'board.json'), JSON.stringify({ counts: { openTasksRead: 7 } }));
  writeFileSync(join(scratch, 'gate.json'), '{"lane": []}');
  const report = join(scratch, 'report.json');
  writeFileSync(report, JSON.stringify({
    board: { openTasksRead: 7, stuck: 0 },
    actions: [{ move, task: 'recLEVELA0000001', ok: true }],
    scoreWritten: true,
  }));
  const out = execFileSync('python3', ['-c', `
import json, importlib.util, sys, datetime
spec = importlib.util.spec_from_file_location("tm", ${JSON.stringify(TM)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.read_state = lambda: {"history": {datetime.date.today().isoformat(): {}}}
m.query_all = lambda *a, **k: [{"id": "recLEVELA0000001", "fields": ${JSON.stringify(fields)}}]
try:
    m.cmd_verify(sys.argv[1]); code = 0
except SystemExit as e:
    code = e.code
print(json.dumps({"code": code}))
`, report], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TASK_MANAGER_SCRATCH: scratch, TASK_MANAGER_RUN_START: String(start - 60) } });
  const verdict = JSON.parse(readFileSync(join(scratch, 'verify-result.json'), 'utf8'));
  return { code: JSON.parse(out.trim().split('\n').pop()).code, verdict,
           text: (verdict.problems || []).join(' ') };
}

const TASKMGR = (src.match(/^TASKMGR_TEAM_REC = "([^"]+)"/m) || [])[1];
const NOTE = '[29 Sep 2026 — agent-dispatch] HANDLED WITHOUT YOU (admin): '
           + 'the certificate was already on file. Level A, Kevin\'s ruling 7 Sep 2026.';

describe('cmd_verify accepts both close paths', () => {
  it('accepts the card path: Sent For Approval By holds the Task Manager', () => {
    expect(TASKMGR).toBeTruthy();
    const r = verifyClose('close', { Status: 'Approval', 'Sent For Approval By': [TASKMGR] });
    expect(r.code).toBe(0);
    expect(r.verdict.verified).toBe(true);
    expect(r.verdict.actionsChecked).toBe(1);
  });

  it('accepts the Level A carry-out: Completed, no card, HANDLED WITHOUT YOU in Notes', () => {
    // THE BUG, in one case. Before the fix this was a problem and failed the slot.
    const r = verifyClose('close', { Status: 'Completed', 'Sent For Approval By': [], Notes: NOTE });
    expect(r.code).toBe(0);
    expect(r.verdict.verified).toBe(true);
    expect(r.verdict.actionsChecked).toBe(1);
  });

  it('accepts a Level A finish the same way as a Level A close', () => {
    const r = verifyClose('finish', { Status: 'Completed', 'Sent For Approval By': [], Notes: NOTE });
    expect(r.code).toBe(0);
    expect(r.verdict.verified).toBe(true);
  });
});

describe('it still refuses a close that proves neither path', () => {
  // The control. A branch that accepts everything is not a fix, it is a hole:
  // these are the cases the check exists for and they must still fail.
  it('refuses Completed with no card AND no marker in Notes', () => {
    const r = verifyClose('close', { Status: 'Completed', 'Sent For Approval By': [] });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/neither path is proven/);
    expect(r.text).toMatch(/HANDLED WITHOUT YOU/);
  });

  it('refuses a marker in Notes while the task is NOT completed', () => {
    const r = verifyClose('close', { Status: 'Approval', 'Sent For Approval By': [], Notes: NOTE });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/neither path is proven/);
  });

  it('refuses a card held by somebody who is not the Task Manager', () => {
    const r = verifyClose('close', { Status: 'Approval', 'Sent For Approval By': ['recSOMEONEELSE1'] });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/neither path is proven/);
  });

  it('still refuses a close on a task that never reached the gate at all', () => {
    const r = verifyClose('close', { Status: 'Today', 'Sent For Approval By': [] });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/never reached the gate/);
  });
});

// 2 Oct 2026: a decision card needs a brief, and `escalate` refuses without one. A refused escalate recorded
// `ok: true` leaves the old thin card (or none) behind, so verify reads the card, not the claim.
describe('cmd_verify reads the decision card, not the claim', () => {
  const BRIEFED = 'DECIDE: sell or keep?\n\nWHAT THIS IS:\nA house.\n\nOPTIONS:\nA. Sell\nB. Keep\n\nRECOMMENDED: B, keep it.\n\nLINKS AND FILES:\n- x';
  it('fails a claimed escalate whose card is still the one-line ask', () => {
    const r = verifyClose('escalate', { Status: 'Approval', 'Sent For Approval By': [TASKMGR], 'Agent Output': 'DECIDE: sell or keep?' });
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('carries no brief');
  });
  it('accepts a briefed card, and one Kevin answered that was carried out in the same slot', () => {
    expect(verifyClose('escalate', { Status: 'Approval', 'Sent For Approval By': [TASKMGR], 'Agent Output': BRIEFED }).code).toBe(0);
    const carried = verifyClose('escalate', { Status: 'Today', 'Sent For Approval By': [TASKMGR],
      'Agent Output': 'DECIDED (Kevin, 02 Oct 2026): Approved as-is\n\n' + BRIEFED });
    expect(carried.text).not.toContain('carries no brief');
  });
});
