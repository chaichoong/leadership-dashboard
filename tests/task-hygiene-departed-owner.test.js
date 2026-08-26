import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP = resolve(ROOT, 'scripts/task-hygiene-sweep.py');

// Finding 20260812-task-hygiene-109 — the sweep counted someone who has LEFT as
// a valid owner.
//
// owner_kind() asked one question of the Team Member link: is this an AI agent?
// If not, and the link existed at all, the task was "human owned". Nothing ever
// read the member's Status. Team Members currently holds 18 people marked
// Offboarding or Offboarded (verified against the live base 13 Aug 2026) —
// Karlo Teves, Ollie Butler, Poppy Squires and fifteen others — and a task
// linked to any of them passed the ownership check, stayed off the unowned list,
// and was never proposed to anybody.
//
// That is the most invisible way for work to stop. Nothing errors, the task
// looks assigned on screen, and the compliance score goes UP because the
// assignee gap is satisfied. It is strictly worse than an unowned task, which at
// least gets proposed an owner every night.
//
// Latent when fixed, not live: the 3 open tasks linked to a departed member all
// carry a live Assignee as well, so today's count is 0. That is the point of
// fixing it now — the next offboarding would have rebuilt the backlog silently.
//
// The real Python is exercised, never re-implemented. A JS copy of owner_kind()
// would keep passing while the script stayed broken, which is the failure mode
// this whole test layer exists to avoid.
function py(snippet) {
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('sweep', ${JSON.stringify(SWEEP)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${snippet}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

const SRC = readFileSync(SWEEP, 'utf8');

// owner_kind is a closure inside cmd_audit and cannot be imported, so it is
// rebuilt here from the SAME source lines — extracted, not retyped, so an edit
// to the real function changes what this test runs.
// `routableAgentIds` defaults to every agent, which is what the function saw before
// the AI Agents register was joined on (finding 20260825-task-hygiene-sweep-359).
// The unbuilt-agent cases below pass it explicitly.
function ownerKindHarness(rec, { agentIds = [], departedIds = [], routableAgentIds = null } = {}) {
  const body = SRC.match(/def owner_kind\(rec\):\n([\s\S]*?)\n\n/);
  if (!body) throw new Error('owner_kind not found in task-hygiene-sweep.py');
  const src = `def owner_kind(rec):\n${body[1]}`;
  return py(`
agent_ids = set(${JSON.stringify(agentIds)})
routable_agent_ids = set(${JSON.stringify(routableAgentIds || agentIds)})
departed_ids = set(${JSON.stringify(departedIds)})
get = m.get
${src.split('\n').map((l) => l).join('\n')}
print(json.dumps(owner_kind(json.loads(${JSON.stringify(JSON.stringify(rec))}))))
`);
}

const AGENT = 'recAGENT0000000001';
const DEPARTED = 'recKARLO000000001';
const LIVE = 'recMICA0000000001';

const task = (fields) => ({ id: 'recTASK000000001', fields });
const F = {
  teamMember: 'Team Member',
  assignee: 'Assignee',
};

describe('CONTROL — the harness runs the real code', () => {
  it('extracts owner_kind from the script rather than a copy', () => {
    expect(SRC).toMatch(/def owner_kind\(rec\):/);
    // If the fix is reverted, this identifier disappears and every case below
    // fails loudly rather than testing a stale copy.
    expect(SRC, 'owner_kind no longer consults the departed roster').toContain('departed_ids');
  });

  it('an agent-owned task still reads as ai, and a live human as human', () => {
    expect(ownerKindHarness(task({ [F.teamMember]: [{ id: AGENT }] }),
      { agentIds: [AGENT], departedIds: [DEPARTED] })).toBe('ai');
    expect(ownerKindHarness(task({ [F.teamMember]: [{ id: LIVE }] }),
      { agentIds: [AGENT], departedIds: [DEPARTED] })).toBe('human');
  });
});

describe('THE REGRESSION: a departed member is not an owner', () => {
  it('a task linked only to someone who has left is not "human"', () => {
    const kind = ownerKindHarness(task({ [F.teamMember]: [{ id: DEPARTED }] }),
      { agentIds: [AGENT], departedIds: [DEPARTED] });
    expect(kind, 'an offboarded member still counts as a valid owner').not.toBe('human');
    expect(kind).toBe('departed');
  });

  it('an agent that has not been built yet is not an owner either', () => {
    // Finding 20260825-task-hygiene-sweep-359. On 26 Aug 2026, 105 of 270 live
    // tasks were held by an agent still Planned or Building on the register: an
    // owner-shaped link with nothing behind it, exactly like a departed member.
    const UNBUILT = 'recPLANNED00000001';
    const kind = ownerKindHarness(task({ [F.teamMember]: [{ id: UNBUILT }] }),
      { agentIds: [AGENT, UNBUILT], routableAgentIds: [AGENT], departedIds: [DEPARTED] });
    expect(kind, 'a Planned agent still counts as AI capacity').not.toBe('ai');
    expect(kind).toBe('ai_unbuilt');
  });

  it('plain string links are handled too, not only {id} objects', () => {
    // Airtable returns either shape depending on the read; the live base
    // returns bare strings on some tasks, which is how a naive .get(id) crashes.
    expect(ownerKindHarness(task({ [F.teamMember]: [DEPARTED] }),
      { agentIds: [AGENT], departedIds: [DEPARTED] })).toBe('departed');
  });

  it('a live Assignee alongside a stale link is still genuinely owned', () => {
    // Not over-reaching: someone IS doing this one. All 3 live cases on
    // 13 Aug 2026 were exactly this shape.
    expect(ownerKindHarness(
      task({ [F.teamMember]: [{ id: DEPARTED }], [F.assignee]: { name: 'Kevin Brittain' } }),
      { agentIds: [AGENT], departedIds: [DEPARTED] })).toBe('human');
  });

  it('one live member among several departed ones still counts as owned', () => {
    expect(ownerKindHarness(task({ [F.teamMember]: [{ id: DEPARTED }, { id: LIVE }] }),
      { agentIds: [AGENT], departedIds: [DEPARTED] })).toBe('human');
  });

  it('no link at all is still unowned, not departed', () => {
    expect(ownerKindHarness(task({}), { agentIds: [AGENT], departedIds: [DEPARTED] }))
      .toBe('unowned');
  });
});

describe('a departed owner is a GAP, and is reported separately', () => {
  it('assess() raises the assignee gap when the only owner has left', () => {
    const gaps = py(`
rec = {"id": "recX", "fields": {"Team Member": [{"id": "${DEPARTED}"}]}}
print(json.dumps(m.assess(rec, "departed")))
`);
    expect(gaps, 'a departed owner must be proposed a live one').toContain('assignee');
  });

  it('assess() does NOT raise it for a live owner', () => {
    const gaps = py(`
rec = {"id": "recX", "fields": {"Team Member": [{"id": "${LIVE}"}]}}
print(json.dumps(m.assess(rec, "human")))
`);
    expect(gaps).not.toContain('assignee');
  });

  it('the ownership report has its own bucket, never folded into human or nobody', () => {
    // Counting it inside "unowned" would hide the distinction Kevin acts on:
    // unowned needs an owner, departed needs a HANDOVER.
    // 'ai_unbuilt' joined the buckets on 26 Aug 2026 for the same reason.
    expect(SRC).toMatch(/"ai": 0, "ai_unbuilt": 0, "human": 0, "departed": 0, "unowned": 0/);
    expect(SRC).toMatch(/owned by someone who has left/);
  });
});

describe('the departed roster cannot silently read empty', () => {
  it('reference_data fails loudly when no departed member is found', () => {
    // The same silent-zero trap the agent roster already guards against: rename
    // the Status field and every member reads as current, so "0 tasks owned by
    // someone who has left" would be indistinguishable from a clean result.
    expect(SRC).toMatch(/if not departed:\s*\n\s*raise SystemExit/);
    expect(SRC).toContain('Refusing to report every owner as current');
  });

  it('both leaving states count, not just the finished one', () => {
    const departed = py('print(json.dumps(sorted(m.TM_DEPARTED)))');
    expect(departed).toEqual(['Offboarded', 'Offboarding']);
  });
});
