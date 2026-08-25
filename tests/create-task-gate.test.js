import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeRunPy } from './helpers/dispatch-py.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = resolve(ROOT, 'scripts/create-agent-task.py');
const runPy = makeRunPy(GATE);

// The create-time duplicate gate (Kevin's rule, 25 Aug 2026: one subject =
// one open task; chasers fold into the existing task). The decision logic is
// pure (decide/build_update take data, return data), so it is exercised here
// through the real module — no copied logic, no network.

describe('the gate script', () => {
  it('passes its own selftest (17 behavioural checks)', () => {
    const out = JSON.parse(execFileSync('python3', [GATE, 'selftest'], { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(17);
  });

  it('never folds across counterparties: a matching subject with a different sender creates, with a note', () => {
    // Two creditors can both send "Outstanding invoices". Folding one
    // creditor's tier-1 letter into another creditor's task would be far
    // worse than a duplicate — the gate must refuse and say why.
    const F = runPy('mod.F');
    const verdict = runPy(`mod.decide(
      {mod.F["name"]: "INBOUND: Outstanding invoices", mod.F["inboundSender"]: "a@creditor-one.co.uk"},
      [{"id": "recX", "createdTime": "2026-08-01T00:00:00.000Z", "fields": {
        mod.F["name"]: "INBOUND: Outstanding invoices",
        mod.F["status"]: {"name": "Today"},
        mod.F["inboundSender"]: "b@creditor-two.co.uk"}}])`);
    expect(verdict.action).toBe('create');
    expect(verdict.note).toContain('different sender');
    expect(F.name).toBe('fldgFjGBw6bTKJFCD'); // write-side id sanity
  });

  it('a task sitting at Approval keeps its status and soft due — the fold never pulls it out of the queue', () => {
    // The PATCH itself bumps Last Modified Time, so the Slack stale-approval
    // guard will make Kevin re-read before approving — intended: new material
    // on a matter he is signing off MUST force a re-read. What the fold must
    // never do is move the task out of Approval or drag its dates around on
    // a soft chaser.
    const patch = runPy(`mod.build_update(
      {mod.F["desc"]: "With Kevin.", mod.F["status"]: {"name": "Approval"},
       mod.F["due"]: "2026-08-28", mod.F["priority"]: {"name": "Urgent"}},
      {mod.F["name"]: "INBOUND: chaser", mod.F["desc"]: "Third chaser arrived.",
       mod.F["status"]: "Today", mod.F["due"]: "2026-08-25", mod.F["priority"]: "High"},
      "2026-08-25")`);
    const F = runPy('mod.F');
    expect(patch[F.desc]).toContain('Third chaser arrived.');
    expect(patch[F.desc]).toContain('UPDATE 2026-08-25');
    expect(patch[F.status]).toBeUndefined();
    expect(patch[F.due]).toBeUndefined();
    expect(patch[F.priority]).toBeUndefined();
  });

  it('write-side field ids match the triage create spec in agent-dispatch.py', () => {
    // agent-dispatch.py REVIEW_TASK_FIELDS mirrors the same spec; a drifted
    // id here would silently read/write the wrong field.
    const dispatch = readFileSync(resolve(ROOT, 'scripts/agent-dispatch.py'), 'utf8');
    const block = dispatch.match(/REVIEW_TASK_FIELDS = \{([\s\S]*?)\}/);
    expect(block, 'REVIEW_TASK_FIELDS in agent-dispatch.py (control)').not.toBeNull();
    const F = runPy('mod.F');
    for (const key of ['name', 'status', 'due', 'team', 'priority', 'desc']) {
      const m = block[1].match(new RegExp(`"${key}":\\s*"(fld[A-Za-z0-9]+)"`));
      expect(m, `${key} in REVIEW_TASK_FIELDS`).not.toBeNull();
      expect(F[key], `field id for ${key}`).toBe(m[1]);
    }
  });

  it('the ids REVIEW_TASK_FIELDS lacks are pinned against the triage skill field list', () => {
    // inboundSender gates the never-fold-across-counterparties rule; a wrong
    // id there reads every sender as blank and folds anything with a matching
    // key. inboundUrl carries the fold trace that stops the stranded-sweep
    // refold loop. hardDeadline protects real-world dates. None appear in
    // agent-dispatch.py, so pin them to the skill's own field list.
    const skill = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/inbound-email-triage/SKILL.md'), 'utf8');
    const F = runPy('mod.F');
    const PINS = [
      ['inboundSender', 'Inbound Sender'],
      ['inboundUrl', 'Inbound Note URL Link'],
      ['hardDeadline', 'Hard Deadline'],
    ];
    for (const [key, label] of PINS) {
      const m = skill.match(new RegExp('`(fld[A-Za-z0-9]+)`[^\\n]*' + label));
      expect(m, `${label} id in the triage skill (control)`).not.toBeNull();
      expect(F[key], `field id for ${key}`).toBe(m[1]);
    }
  });
});

describe('the skills actually route creates through the gate', () => {
  // A gate nobody is told to use prevents nothing. Both task-creating
  // inbound skills must name the script in their create steps — this is the
  // same skill-vs-code drift guard pattern as agent-dispatch-tier1.
  const SKILLS = [
    '.claude/scheduled-tasks/inbound-email-triage/SKILL.md',
    '.claude/scheduled-tasks/inbound-messages-sweep/SKILL.md',
  ];
  for (const rel of SKILLS) {
    it(`${rel} calls scripts/create-agent-task.py`, () => {
      const text = readFileSync(resolve(ROOT, rel), 'utf8');
      expect(text).toContain('scripts/create-agent-task.py');
      expect(text).toMatch(/create --fields-json/);
    });
  }
});
