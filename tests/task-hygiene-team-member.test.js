import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP = resolve(ROOT, 'scripts/task-hygiene-sweep.py');
const SKILL = resolve(homedir(), '.claude/scheduled-tasks/task-hygiene-sweep/SKILL.md');

// Finding 20260811-task-hygiene-081.
//
// The sweep's own rule is AI FIRST: route unowned work to an AI agent through the
// Team Member field, and name a human only when a person is genuinely required.
// The script READ Team Member but could not WRITE it — WRITABLE listed only
// timeEstimate, business, dueDate, assignee, project and recurring, and validate()
// rejected anything else. So the only owner it could ever propose was a human, and
// a human write also fires a Slack DM. Every night the north-star rule was silently
// downgraded into a permanent human assignment nobody unwinds, while the compliance
// score went up. On 11 Aug 2026 od-ceo had to overrule two proposals and leave a
// tenant leak and a council EICR chase unowned rather than write Mica.
//
// The real functions are exercised, not re-implemented: a copy of validate() in JS
// would pass while the script stayed broken.
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

const AGENT = 'recAGENT0000000001';

describe('task-hygiene sweep can express AI-first ownership', () => {
  it('Team Member is writable, at the tier Kevin still approves', () => {
    const writable = py("print(json.dumps(m.WRITABLE))");
    expect(writable.teamMember,
      'Team Member is not writable — the sweep can only ever propose a human owner').toBe('pending');
    // Never auto: an owner is a judgement, and a wrong one is a Slack DM.
    expect(writable.teamMember).not.toBe('auto');
  });

  it('accepts an AI agent record ID and writes it as a link', () => {
    const r = py(`
d = {"field": "teamMember", "value": "${AGENT}"}
print(json.dumps({
    "err": m.validate(d, set(), set(), {"${AGENT}"}),
    "payload": m.to_payload("teamMember", "${AGENT}"),
}))`);
    expect(r.err).toBeNull();
    expect(r.payload, 'a link field must be written as a list of record IDs')
      .toEqual([AGENT]);
  });

  it('refuses an agent record ID that is not on the live roster', () => {
    const r = py(`
d = {"field": "teamMember", "value": "recNOTANAGENT00001"}
print(json.dumps({"err": m.validate(d, set(), set(), {"${AGENT}"})}))`);
    expect(r.err, 'an unknown Team Member ID was accepted').toBeTruthy();
    expect(r.err).toMatch(/unknown AI agent/);
  });

  it('refuses an agent NAME — that would create a new Team Member record', () => {
    const r = py(`
d = {"field": "teamMember", "value": "AI Operations Director"}
print(json.dumps({"err": m.validate(d, set(), set(), {"${AGENT}"})}))`);
    expect(r.err).toBeTruthy();
  });

  it('the reference block offers the agent roster, not only the human team', () => {
    const src = readFileSync(SWEEP, 'utf8');
    expect(src, 'the work-list gives the deciding agent no AI owners to choose from')
      .toMatch(/"aiAgents": agents/);
    // An empty roster is a broken read, not a business with no agents. It must
    // fail loudly rather than read as "no AI owner was suitable".
    expect(src).toMatch(/zero AI agents found/);
  });

  it('the skill still states the AI-first rule the code now supports', () => {
    const skill = readFileSync(SKILL, 'utf8');
    expect(skill.toLowerCase()).toMatch(/team member/);
  });
});
