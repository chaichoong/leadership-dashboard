// Finding 20260925-agent-dispatch-616 (25 Sep 2026). send-email.py (22 Sep) and calendar-write.py
// (24 Sep) refuse a task whose Approval Outcome string was typed without a real approval; this
// script still trusted the string alone, so a letter could be printed and posted on a task an agent
// marked "Approved" itself. These drive the REAL load_approved() with get_task() faked; back-tested
// by removing the check (the forged case then posts).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = JSON.stringify(path.join(root, 'scripts/send-letter.py'));
const LETTER = 'POST:\nSefton Council\nLicensing\nMagdalen House\nBootle\nL20 3NJ\nDOCUMENT: ~/knowledge-os/attachments/letter.pdf\n---\nThe licence fee letter.\n\n**Carrying this out will involve:** posting the letter to Sefton Council.';

function load(extra, created = '2026-09-22T12:00:00.000Z') {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys
sys.argv = ["send-letter.py"]
spec = importlib.util.spec_from_file_location("sl", ${SCRIPT})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
a = json.loads(sys.stdin.read())
F = {m.AF["name"]: "CORRESPONDENCE: Sefton licence letter", m.AF["status"]: {"name": "Today"},
     m.AF["approvalOutcome"]: {"name": "Approved as-is"}, m.AF["taskType"]: {"name": "Correspondence"},
     m.AF["agentOutput"]: a["letter"]}
F.update(a["extra"])
m.get_task = lambda task_id: {"id": task_id, "createdTime": a["created"], "fields": F}
try:
    letter = m.load_approved("recTEST", require_approval=True)
    print(json.dumps({"posts": True, "problem": letter.get("approvalProblem")}))
except SystemExit as e:
    print(json.dumps({"posts": False, "refusal": str(e)}))
`], { input: JSON.stringify({ letter: LETTER, extra, created }), encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const GATE = 'fld30Yw8SWYVp049g';   // Sent For Approval By (scripts/approval_evidence.py)
const AT = 'fldr4Mvf2RzKvhZhi';     // Approved At

describe('a letter posts only on a real approval', () => {
  it('a real approval (through the gate, approved after it existed) posts', () => {
    const r = load({ [GATE]: ['recwWvBju2ycB63i4'], [AT]: '2026-09-23T09:00:00.000Z' });
    expect(r).toEqual({ posts: true, problem: '' });
  });

  it('the Approval Outcome string alone, no gate, no time, or a time copied from before the task, is refused', () => {
    for (const extra of [{}, { [AT]: '2026-09-23T09:00:00.000Z' }, { [GATE]: ['recwWvBju2ycB63i4'] },
      { [GATE]: ['recwWvBju2ycB63i4'], [AT]: '2026-09-20T09:00:00.000Z' }]) {
      const r = load(extra);
      expect(r.posts, JSON.stringify(extra)).toBe(false);
      expect(r.refusal).toMatch(/reads 'Approved as-is', but /);
    }
  });
});
