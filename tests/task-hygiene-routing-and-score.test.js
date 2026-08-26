import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

// Two bugs in scripts/task-hygiene-sweep.py, both found by the sweep itself.
//
// 1. (20260825-task-hygiene-sweep-359) Routing targets came from 'Is AI Agent' on
//    Team Members, which says a record REPRESENTS an agent and nothing about whether
//    that agent exists yet. On 26 Aug 2026 seven of the fifteen register rows were
//    still Planned and two Building, and all of them were offered as owners — so a
//    task could be stamped owned by an agent that would never run. Measured after
//    the join: 105 of 270 live tasks were held by an unbuilt agent.
//
// 2. (20260816-task-hygiene-sweep-183) The compliance score is compliant/openTasks
//    and 'Approval' is not open work, so moving a batch to Approval RAISES the
//    percentage while nothing is fixed. The sweep reported that as improvement on
//    14 and 16 Aug 2026.
//
// Both are tested against the REAL functions, loaded out of the script.

const SCRIPT = resolve(__dirname, '../scripts/task-hygiene-sweep.py');

function py(body) {
  const out = execFileSync('python3', ['-c', `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("sweep", ${JSON.stringify(SCRIPT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
${body}
`], { encoding: 'utf8' });
  return JSON.parse(out);
}

// A stand-in for fetch_all that serves canned rows per table id.
const FAKE_FETCH = `
def make_fetch(members, register, businesses=None, projects=None):
    def fetch_all(token, table, fields=None, formula=None):
        if table == mod.TEAM_MEMBERS_TBL: return members
        if table == mod.AI_AGENTS_TBL: return register
        if table == mod.BUSINESSES: return businesses or [{"id":"recB","fields":{"Business Name":"OD","Active":True}}]
        if table == mod.PROJECTS: return projects or [{"id":"recP","fields":{"Project Name":"Launch","Project Status":"Active"}}]
        raise AssertionError("unexpected table " + str(table))
    return fetch_all

MEMBERS = [
    {"id":"recLive","fields":{"Name":"Task Manager","Is AI Agent":True}},
    {"id":"recPlanned","fields":{"Name":"Sales Progressor","Is AI Agent":True}},
    {"id":"recBuilding","fields":{"Name":"Cash Flow Voids","Is AI Agent":True}},
    {"id":"recUnreg","fields":{"Name":"Ghost Agent","Is AI Agent":True}},
    {"id":"recGone","fields":{"Name":"Karlo","Status":"Offboarded"}},
    {"id":"recPerson","fields":{"Name":"Mica","Status":"Active"}},
]
REGISTER = [
    {"id":"recR1","fields":{"Name":"Task Manager","Status":"Live","Team Member":[{"id":"recLive"}]}},
    {"id":"recR2","fields":{"Name":"Sales Progressor","Status":"Planned","Team Member":[{"id":"recPlanned"}]}},
    {"id":"recR3","fields":{"Name":"Cash Flow Voids","Status":"Building","Team Member":[{"id":"recBuilding"}]}},
]
`;

describe('AI agents must be BUILT before the sweep will route work to them', () => {
  it('flags Planned, Building and unregistered agents as not routable', () => {
    const agents = py(`${FAKE_FETCH}
mod.fetch_all = make_fetch(MEMBERS, REGISTER)
_b, _p, agents, departed = mod.reference_data("t")
print(json.dumps({"agents": agents, "departed": sorted(departed)}))
`);
    const byId = Object.fromEntries(agents.agents.map((a) => [a.id, a]));
    expect(byId.recLive.routable).toBe(true);
    expect(byId.recLive.buildStatus).toBe('Live');
    expect(byId.recPlanned.routable).toBe(false);
    expect(byId.recBuilding.routable).toBe(false);
    // An agent with no register row has been through no build gate at all.
    expect(byId.recUnreg.routable).toBe(false);
    expect(byId.recUnreg.buildStatus).toBe('not in register');
    expect(agents.departed).toEqual(['recGone']);
  });

  it('validate() refuses a write that would hand a task to an unbuilt agent', () => {
    const res = py(`${FAKE_FETCH}
mod.fetch_all = make_fetch(MEMBERS, REGISTER)
_b, _p, agents, _d = mod.reference_data("t")
routable = {a["id"] for a in agents if a["routable"]}
ok = mod.validate({"field":"teamMember","value":["recLive"]}, {"recB"}, {"recP"}, routable)
planned = mod.validate({"field":"teamMember","value":["recPlanned"]}, {"recB"}, {"recP"}, routable)
ghost = mod.validate({"field":"teamMember","value":["recUnreg"]}, {"recB"}, {"recP"}, routable)
print(json.dumps({"ok": ok, "planned": planned, "ghost": ghost}))
`);
    expect(res.ok).toBeNull();
    expect(res.planned).toMatch(/not-yet-built/);
    expect(res.ghost).toMatch(/not-yet-built/);
  });

  it('a task owned by an unbuilt agent counts as unowned, not as AI capacity', () => {
    const res = py(`
rec = {"fields": {"Name":"x","Team Member":[{"id":"recPlanned"}],"Due Date":"2026-08-01",
                  "Time Estimate":"15 min","Priority":"Urgent","Business":[{"id":"recB"}],
                  "Project":[{"id":"recP"}]}}
print(json.dumps({
  "unbuilt": mod.assess(rec, "ai_unbuilt"),
  "built": mod.assess(rec, "ai"),
}))
`);
    expect(res.unbuilt).toContain('assignee');   // needs re-owning
    expect(res.built).not.toContain('assignee'); // a live agent really does own it
  });

  it('fails loudly rather than routing to nothing when the register read breaks', () => {
    const res = py(`${FAKE_FETCH}
out = {}
mod.fetch_all = make_fetch(MEMBERS, [])
try:
    mod.reference_data("t"); out["emptyRegister"] = "NO FAILURE"
except SystemExit as e: out["emptyRegister"] = str(e)
# Link field renamed: rows parse, nothing links.
mod.fetch_all = make_fetch(MEMBERS, [{"id":"recR1","fields":{"Name":"x","Status":"Live"}}])
try:
    mod.reference_data("t"); out["noLinks"] = "NO FAILURE"
except SystemExit as e: out["noLinks"] = str(e)
# Every agent unbuilt: nothing is routable.
mod.fetch_all = make_fetch(MEMBERS, [r for r in REGISTER if r["fields"]["Status"] != "Live"])
try:
    mod.reference_data("t"); out["noneRoutable"] = "NO FAILURE"
except SystemExit as e: out["noneRoutable"] = str(e)
print(json.dumps(out))
`);
    expect(res.emptyRegister).toMatch(/FAIL: control check/);
    expect(res.noLinks).toMatch(/FAIL: control check/);
    expect(res.noneRoutable).toMatch(/FAIL: control check/);
  });
});

describe('compliance score is not comparable when the denominator shrank unexplained', () => {
  it('calls a shrink that completions do not explain what it is', () => {
    const res = py(`
print(json.dumps({
  "approvalShuffle": mod.assess_denominator(326, 270, 3),
  "realProgress":    mod.assess_denominator(326, 270, 60),
  "noise":           mod.assess_denominator(326, 320, 0),
  "grew":            mod.assess_denominator(270, 326, 0),
  "firstRun":        mod.assess_denominator(0, 270, 0),
}))
`);
    // 56 tasks left live work, 3 were finished — the other 53 just moved.
    expect(res.approvalShuffle[0]).toBe(false);
    expect(res.approvalShuffle[1]).toMatch(/arithmetic, not progress/);
    expect(res.realProgress[0]).toBe(true);
    expect(res.noise[0]).toBe(true);      // under the 10% threshold
    expect(res.grew[0]).toBe(true);       // a growing denominator cannot flatter
    expect(res.firstRun[0]).toBe(true);   // nothing to compare against
  });

  it('finds the most recent previous worklist and ignores today\'s own file', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'hygiene-'));
    writeFileSync(resolve(dir, 'task-sweep-worklist-2026-08-14.json'), JSON.stringify({ openTasks: 326, compliancePct: 40.0 }));
    writeFileSync(resolve(dir, 'task-sweep-worklist-2026-08-16.json'), JSON.stringify({ openTasks: 300, compliancePct: 45.0 }));
    writeFileSync(resolve(dir, 'task-sweep-worklist-2026-08-26.json'), JSON.stringify({ openTasks: 270, compliancePct: 54.4 }));
    const res = py(`
mod.MONITORING = ${JSON.stringify(dir)}
import datetime
prev = mod.previous_worklist(datetime.date(2026, 8, 26))
print(json.dumps({"date": prev["_date"], "openTasks": prev["openTasks"]}))
`);
    expect(res.date).toBe('2026-08-16');
    expect(res.openTasks).toBe(300);
  });
});
