// Every class of robot wall in the "Robots blocked" Detail names who clears it.
//
// Regression origin: finding 20261008-auditor-797. On 8 Oct 2026 the Detail read
// "3 tasks: no fixer can reach it (protected file: ...). 12 tasks: no fixer has
// taken the fix in 3 days or more." Neither sentence said who clears those 15.
// OWNER_NAMED_RE still matched, because "Kevin" appears elsewhere in the same
// Detail, so red_rows_pass filed the row under "owned" and no RED task was
// raised. The row had been red since 7 Oct with 15 walls and nobody on them.
//
// These tests drive the real blockers_summary. Back-tested: dropping the
// per-state owner loop, or the unclaimed sentence's owner clause, turns them red.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/estate-status.py');

function py(code) {
  return execFileSync('python3', ['-c', code], { encoding: 'utf8', timeout: 30000 });
}

const LOAD = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("es", ${JSON.stringify(SCRIPT)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# The 8 Oct 2026 shape: three protected-file walls no fixer took, twelve unclaimed.
def wall(i, state, tool, finding=""):
    return {"task": "rec%05d" % i, "name": "a blocked task", "agent": "AI Worker — Builder",
            "kind": "TOOL", "subject": "s%d" % i, "toolState": state, "tool": tool,
            "finding": finding, "findingStatus": "open", "days": 5.0}

walls = [wall(1, "no-fixer", "no fixer can take it (protected file: os/agents/index.html)", "20261001-x-1"),
         wall(2, "no-fixer", "no fixer can take it (protected file: scripts/send-email.py)", "20261001-x-2"),
         wall(3, "no-finding", "nothing filed", "")]
walls += [wall(10 + i, "unclaimed", "no fixer has taken it in 3 days", "20261002-y-%d" % i)
          for i in range(12)]
report = {"openTasksRead": 300, "open": walls, "stale": [], "closedWhileBlocked": []}
`;

describe('estate-status blockers: every wall class names an owner', () => {
  it('names who clears each no-fixer state', () => {
    const out = py(`${LOAD}
status, detail, payload = m.blockers_summary(report)
print(detail)
`);
    expect(out).toContain('protected file: os/agents/index.html, scripts/send-email.py');
    // the two no-fixer walls
    expect(out).toContain('merge card');
    // the one with nothing filed
    expect(out).toContain('must file it before it can be worked');
  });

  it('names the owner and the finding ids on unclaimed walls', () => {
    const out = py(`${LOAD}
status, detail, payload = m.blockers_summary(report)
print(detail)
`);
    expect(out).toContain('no fixer has taken the fix in 3 days or more');
    expect(out).toContain('The daily robot fix owns it');
    expect(out).toContain('20261002-y-0');
    expect(out).toContain('nothing is needed from you');
  });

  it('every no-fixer state in NO_FIXER_STATES has an owner sentence', () => {
    const out = py(`${LOAD}
missing = [s for s in m.NO_FIXER_STATES if s not in m.NO_FIXER_OWNER]
print("MISSING", json.dumps(missing))
`);
    expect(out).toContain('MISSING []');
  });

  it('an unknown state falls back to a loud no-owner line, never silence', () => {
    const out = py(`${LOAD}
m.NO_FIXER_STATES = m.NO_FIXER_STATES + ("brand-new-state",)
w = wall(99, "brand-new-state", "something new", "20261003-z-1")
status, detail, payload = m.blockers_summary({"openTasksRead": 300, "open": [w],
                                              "stale": [], "closedWhileBlocked": []})
print(detail)
`);
    expect(out).toContain('no owner yet');
  });
});
