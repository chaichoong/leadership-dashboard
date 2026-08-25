// The dispatch queue's own control must be able to FAIL.
//
// THE BUG THIS EXISTS FOR (finding 20260825-agent-dispatch-360)
// cmd_queue guards itself with "zero agent-linked tasks AND zero tasks carrying
// an approval outcome => the read is broken". The second half ran against the
// WHOLE Tasks table — 7,400 rows, thousands of them approvals closed months
// ago — so it matched something whatever the live queue looked like, and the
// `and` could never be false. The guard read as verified while covering
// nothing: a broken open-task read would have reported an empty queue for ever,
// silently, every morning.
//
// Two claims here, and they are different: the DECISION (a pure function, run
// against fixtures) and the QUERY that feeds it (asserted against source,
// because a formula spanning the whole table is the actual defect).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const src = readFileSync(DISPATCH, 'utf8');

function control(openTasks, agentLinked, handback) {
  const script = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("dispatch", ${JSON.stringify(DISPATCH)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
a = json.loads(sys.argv[1])
mk = lambda n: [{"id": "rec%d" % i} for i in range(n)]
print(json.dumps(mod.queue_control_failure(mk(a["open"]), mk(a["linked"]), mk(a["handback"]))))
`;
  return JSON.parse(execFileSync('python3', ['-c', script,
    JSON.stringify({ open: openTasks, linked: agentLinked, handback })], { encoding: 'utf8' }));
}

describe('agent-dispatch queue control', () => {
  it('passes a normal morning', () => {
    expect(control(40, 18, 1)).toBe('');
  });

  it('FAILS when the open-task read returns nothing at all', () => {
    // The formula-typo case. Previously indistinguishable from a clear desk.
    const why = control(0, 0, 1);
    expect(why).not.toBe('');
    expect(why).toMatch(/zero rows/);
  });

  it('FAILS when there is live work but nothing agent-shaped in it', () => {
    // The agent-link logic or a field name has moved. 17 live agents carry
    // task links, so this is never a real state.
    const why = control(40, 0, 0);
    expect(why).not.toBe('');
    expect(why).toMatch(/40 open tasks/);
  });

  it('is satisfied by a live hand-back even with no agent-linked task', () => {
    // Not every morning has agent-linked work; a live approval outcome is
    // independent evidence the read is sound.
    expect(control(40, 0, 1)).toBe('');
  });

  it('scopes the hand-back probe to the live window, not the whole table', () => {
    // This is the actual defect. Across all 7,400 rows the probe always matches,
    // so the control can never fire however broken the read is.
    const probe = src.slice(src.indexOf('handback_population = query_tasks'));
    expect(probe.slice(0, 300)).toContain("{Status}='Approval'");
    expect(probe.slice(0, 300)).toMatch(/OR\(\{Status\}='Today',\{Status\}='Overdue'/);
    // The unbounded form must not come back.
    expect(src).not.toMatch(/query_tasks\("LEN\(\{Approval Outcome\}&''\)>0",/);
  });

  it('exits non-zero rather than reporting an empty queue', () => {
    const guard = src.slice(src.indexOf('failure = queue_control_failure'));
    expect(guard.slice(0, 200)).toContain('sys.exit(1)');
  });
});
