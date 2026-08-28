// Guards the Inbound Comms Response agent's dispatch wiring (24 Aug 2026).
//
// WHAT THIS EXISTS FOR
// The Response agent only works if four pieces stay true at once:
//   1. Its Team Members record is a dispatchable agent (ROLE_AGENTS), so its
//      tasks are picked up, attributed, and its learning log fed.
//   2. Inbound reply tasks on the AI CEO auto-route to it deterministically
//      (Kevin's ruling, 24 Aug 2026) — no od-ceo judgement per routine reply.
//   3. route/submit accept role agents (ALL_AGENTS, not the 17-only AGENTS) —
//      reverting either to AGENTS silently strands every routed inbound task.
//   4. Its 24h metric maths stay honest — the score selftest runs the REAL
//      function with seeded records (unstamped completions count as misses,
//      still-open young tasks are not judged, the empty read fails the
//      control rather than publishing "no inbound").
// Each check imports or executes the real module — never a copy.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { makeRunPy } from './helpers/dispatch-py.js';

const ROOT = resolve(__dirname, '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const src = readFileSync(DISPATCH, 'utf8');

const RESPONSE_TM = 'recJ8J8idWE8d97tH';
const RESPONSE_ROW = 'recHfhVDb6BfQYco5';

const pyEval = makeRunPy(DISPATCH);

describe('roster wiring', () => {
  it('the Response agent is a dispatchable role agent with the right identities', () => {
    const out = pyEval(`{
      "inRole": ${JSON.stringify(RESPONSE_TM)} in mod.ROLE_AGENTS,
      "inAll": ${JSON.stringify(RESPONSE_TM)} in mod.ALL_AGENTS,
      "agent": mod.ROLE_AGENTS.get(${JSON.stringify(RESPONSE_TM)}, {}).get("agent"),
      "respRec": mod.RESPONSE_REC_ID,
      "respRow": mod.RESPONSE_REGISTER_ROW,
      "strategic17": len(mod.AGENTS)}`);
    expect(out.inRole).toBe(true);
    expect(out.inAll).toBe(true);
    expect(out.agent).toBe('inbound-comms-response');
    expect(out.respRec).toBe(RESPONSE_TM);
    expect(out.respRow).toBe(RESPONSE_ROW);
    // ROLE_AGENTS extends the 17, never replaces them
    expect(out.strategic17).toBe(17);
  });

  it('route and submit validate against ALL_AGENTS, not the 17-only map', () => {
    const route = src.slice(src.indexOf('def cmd_route'), src.indexOf('def cmd_escalate'));
    const submit = src.slice(src.indexOf('def cmd_submit'), src.indexOf('def cmd_annotate'));
    expect(route).toMatch(/args\.to not in ALL_AGENTS/);
    expect(submit).toMatch(/args\.agent not in ALL_AGENTS/);
    // The regression to fear: a tidy-up "restoring" the old check
    expect(route).not.toMatch(/args\.to not in AGENTS\b/);
    expect(submit).not.toMatch(/args\.agent not in AGENTS\b/);
  });

  it('inbound CEO tasks get the deterministic autoTarget, gated on the LIVE register', () => {
    const queue = src.slice(src.indexOf('def build_queue'), src.indexOf('# ─── WRITES'));
    // Behavioural, through the real AUTO_ROUTES table: a plain inbound task
    // routes to the Response agent when its register row is dispatchable,
    // and stays in the CEO lane when it is not (Kevin's pause lever) or the
    // roster read failed (review finding, 24 Aug 2026).
    const T = { creditor: false, inboundTask: true, tier2Correspondence: false };
    expect(pyEval('mod.auto_route_fresh(*arg)',
      [T, { [RESPONSE_TM]: { dispatchable: true } }])).toBe(RESPONSE_TM);
    expect(pyEval('mod.auto_route_fresh(*arg)',
      [T, { [RESPONSE_TM]: { dispatchable: false } }])).toBeNull();
    expect(pyEval('mod.auto_route_fresh(*arg)', [T, {}])).toBeNull();
    expect(src).toMatch(/"inboundTask":\s*"fldueazD67F7fUGee"/);
    // The queue JSON must expose the register roster AND its read failure —
    // a silently missing roster starves role agents run after run.
    expect(queue).toMatch(/"roleAgents": role_roster/);
    expect(queue).toMatch(/"roleAgentsError": role_roster_error/);
  });

  it('the register pause lever is enforced on every write path, and verify sees the loop\'s controls', () => {
    // route and submit re-check the LIVE register for role agents
    const route = src.slice(src.indexOf('def cmd_route'), src.indexOf('def cmd_escalate'));
    const submit = src.slice(src.indexOf('def cmd_submit'), src.indexOf('def cmd_annotate'));
    expect(route).toMatch(/require_role_agent_live\(args\.to/);
    expect(submit).toMatch(/require_role_agent_live\(args\.agent/);
    // verify fails on a broken roster read and on a skipped CEO review pass
    const verify = src.slice(src.indexOf('def cmd_verify'), src.indexOf('# ─── SCORE'));
    expect(verify).toMatch(/roleAgentsError/);
    expect(verify).toMatch(/ceoReview/);
  });
});

describe('24h score maths', () => {
  it('the offline selftest passes against the real function', () => {
    const out = execFileSync('python3', [DISPATCH, 'score', '--selftest'],
      { encoding: 'utf8' });
    expect(out).toContain('selftest-score: all checks passed');
  });

  it('cmd_score has a loud control on the ambiguous zero, and excludes Cancelled', () => {
    const score = src.slice(src.indexOf('def cmd_score'), src.indexOf('def response_score_selftest'));
    // Control ON ZERO: only an empty main read triggers the all-time
    // existence check, and a broken read exits rather than publishing.
    expect(score).toMatch(/if not records and not query_tasks\("\{Inbound Communication Task\}"/);
    expect(score).toMatch(/control failed/);
    // Cancelled tasks are nobody-wants-it-answered — excluded at the query
    // (review finding, 24 Aug 2026: junk inbound dragged the score for ever)
    expect(score).toMatch(/\{Status\}!='Cancelled'/);
    // And the write targets the register row's Metric Score, change-gated
    expect(score).toMatch(/REGISTER_METRIC_SCORE/);
    expect(score).toMatch(/reading == prev/);
  });
});

describe('dispatch skill stays in step with the script (local machine only)', () => {
  const skill = resolve(homedir(), '.claude/scheduled-tasks/agent-dispatch/SKILL.md');
  const agentDef = resolve(homedir(), '.claude/agents/inbound-comms-response.md');
  const guardrails = resolve(homedir(), '.claude/agents/GUARDRAILS.md');
  // These live outside the repo, so skip cleanly anywhere they do not exist
  // (a fresh clone, CI). On Kevin's Mac they must all hold.
  it.skipIf(!existsSync(skill))('the skill routes autoTarget deterministically and runs score', () => {
    const s = readFileSync(skill, 'utf8');
    expect(s).toMatch(/autoTarget/);
    expect(s).toMatch(/agent-dispatch\.py score/);
    expect(s).toMatch(/CEO REVIEW PASS/);
    expect(s).toMatch(/NEVER rewrites a draft/);
  });
  it.skipIf(!existsSync(skill))('Kevin\'s feedback reaches every agent kind — no silent skip', () => {
    const s = readFileSync(skill, 'utf8');
    // The regression to fear: restoring "no register row = skip silently",
    // which dropped every lesson aimed at the 17 strategic agents.
    expect(s).not.toMatch(/No matching register row[^.]*skip silently/);
    expect(s).toMatch(/## Lessons from Kevin/);
    expect(s).toMatch(/LESSONS FROM KEVIN \(apply every one\)/);
    expect(s).toMatch(/roleAgents\.learningLog/);
  });
  it.skipIf(!existsSync(agentDef))('the local agent definition exists and is prepare-only', () => {
    const a = readFileSync(agentDef, 'utf8');
    expect(a).toMatch(/name: inbound-comms-response/);
    expect(a).toMatch(/Approval required/);
    expect(a).toMatch(RESPONSE_ROW);
  });
  it.skipIf(!existsSync(guardrails))('the shared guardrails carry the AI-brain contract', () => {
    const g = readFileSync(guardrails, 'utf8');
    expect(g).toMatch(/00 AI Context/);
    expect(g).toMatch(/kevin-voice-profile\.md/);
  });
});
