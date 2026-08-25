// Guards the Creditor Management agent's dispatch wiring (25 Aug 2026).
//
// WHAT THIS EXISTS FOR
// The Creditor Management agent only works if five pieces stay true at once:
//   1. Its Team Members record is a dispatchable role agent (ROLE_AGENTS).
//   2. Creditor-lane tasks auto-route to it deterministically, AHEAD of the
//      generic inbound Response route (a creditor email is inbound too).
//   3. The routing floor (CREDITOR_PATTERNS) catches the triage marker and
//      creditor vocabulary, and NEVER matches money owed TO Kevin (tenant
//      arrears, UC chasing) — misrouting tenant work would be the quiet bug.
//   4. The old tier-2 park survives ONLY as the fallback: creditor
//      correspondence parks when the agent's register row is not Built/Live,
//      and flows to the agent when it is. Kevin's pause lever must actually
//      re-park the lane.
//   5. Its ledger score maths stay honest (real function, seeded records) and
//      the write is change-gated to its own register row.
// Each check imports or executes the real module — never a copy.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const ROOT = resolve(__dirname, '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const src = readFileSync(DISPATCH, 'utf8');

const CREDITOR_TM = 'recjh6mmaF8KJW8t3';
const CREDITOR_ROW = 'recDvxwDGcC3pFbPa';

function pyEval(expr) {
  const script = `
import json, importlib.util
spec = importlib.util.spec_from_file_location("dispatch", ${JSON.stringify(DISPATCH)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(json.dumps(${expr}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

describe('roster wiring', () => {
  it('the Creditor agent is a dispatchable role agent with the right identities', () => {
    const out = pyEval(`{
      "inRole": ${JSON.stringify(CREDITOR_TM)} in mod.ROLE_AGENTS,
      "inAll": ${JSON.stringify(CREDITOR_TM)} in mod.ALL_AGENTS,
      "agent": mod.ROLE_AGENTS.get(${JSON.stringify(CREDITOR_TM)}, {}).get("agent"),
      "credRec": mod.CREDITOR_REC_ID,
      "credRow": mod.CREDITOR_REGISTER_ROW,
      "ledger": mod.CREDITOR_PLANS_TABLE,
      "strategic17": len(mod.AGENTS)}`);
    expect(out.inRole).toBe(true);
    expect(out.inAll).toBe(true);
    expect(out.agent).toBe('creditor-management');
    expect(out.credRec).toBe(CREDITOR_TM);
    expect(out.credRow).toBe(CREDITOR_ROW);
    expect(out.ledger).toBe('tbljyVlkq1BXzny2G');
    // ROLE_AGENTS extends the 17, never replaces them
    expect(out.strategic17).toBe(17);
  });
});

describe('the routing floor (real CREDITOR_PATTERNS)', () => {
  const matches = (text) => pyEval(
    `bool(mod.tier_match(mod.CREDITOR_PATTERNS, ${JSON.stringify(text)}, "", ""))`);

  it('catches the triage marker and creditor vocabulary', () => {
    expect(matches('CREDITOR MATTER\nCollections firm chasing the balance')).toBe(true);
    expect(matches('Reply to the statutory demand')).toBe(true);
    expect(matches('Final notice from the energy supplier')).toBe(true);
    expect(matches('They are chasing payment on the account')).toBe(true);
    expect(matches('Agree a payment plan with the supplier')).toBe(true);
    expect(matches('Letter before action received')).toBe(true);
    expect(matches('Bounce back loan repayment demand')).toBe(true);
  });

  it('never matches money owed TO Kevin — tenant and client work stays out', () => {
    // "arrears" is deliberately absent from the floor: tenant rent arrears
    // and UC chasing are the Cash Flow Voids / UC lanes, not this agent's.
    expect(matches('Chase the rent arrears on the rental unit')).toBe(false);
    expect(matches('UC verification for the new tenancy')).toBe(false);
    expect(matches('Send the client the invoice for onboarding')).toBe(false);
    expect(matches('Weekly reconciliation of transactions')).toBe(false);
  });
});

describe('queue routing and the pause lever', () => {
  const queue = src.slice(src.indexOf('def cmd_queue'), src.indexOf('# ─── WRITES'));

  it('creditor beats the generic inbound Response route', () => {
    // The creditor stamp must come FIRST in the CEO-lane branch: an
    // elif-ordered Response stamp on a creditor email would send it to the
    // generalist. Assert the order in the real source.
    const ceoBranch = queue.slice(queue.indexOf('if tm == CEO_REC_ID:'),
                                  queue.indexOf('elif tm in ALL_AGENTS:'));
    const credAt = ceoBranch.indexOf('t["creditor"] and creditor_ok');
    const respAt = ceoBranch.indexOf('RESPONSE_REC_ID');
    expect(credAt).toBeGreaterThan(-1);
    expect(respAt).toBeGreaterThan(-1);
    expect(credAt).toBeLessThan(respAt);
    expect(ceoBranch).toMatch(/t\["autoTarget"\] = CREDITOR_REC_ID/);
  });

  it('the tier-2 park survives ONLY while the agent is not dispatchable', () => {
    // The park must be gated on creditor_ok, and creditor_ok must come from
    // the LIVE register roster (Kevin's pause lever). Removing either gate
    // silently revives the parked-for-ever lane or ignores the lever.
    expect(queue).toMatch(/if hit2 and out2 and not creditor_ok:/);
    expect(queue).toMatch(
      /creditor_ok = bool\(role_roster\.get\(CREDITOR_REC_ID, \{\}\)\.get\("dispatchable"\)\)/);
  });

  it('reroutes off the WRONG agent narrowly: Response or parked correspondence only', () => {
    // A dept head ANALYSING a payment question keeps its task — the reroute
    // is only for the generalist Response agent and formerly-parked
    // correspondence. Widening this steals the CEO's routing decisions.
    const agentBranch = queue.slice(queue.indexOf('elif tm in ALL_AGENTS:'),
                                    queue.indexOf('unclassified.append'));
    expect(agentBranch).toMatch(/tm == RESPONSE_REC_ID/);
    expect(agentBranch).toMatch(/t\["tier2Correspondence"\]/);
    expect(agentBranch).toMatch(/tm != CREDITOR_REC_ID/);
  });

  it('the queue JSON carries the creditor visibility counters', () => {
    expect(queue).toMatch(/"creditorMatters"/);
    expect(queue).toMatch(/t\["creditorPattern"\] = hitc or ""/);
  });
});

describe('ledger score maths', () => {
  it('the offline selftests pass against the real functions (both agents)', () => {
    const out = execFileSync('python3', [DISPATCH, 'score', '--selftest'],
      { encoding: 'utf8' });
    expect(out).toContain('selftest-score: all checks passed');
    expect(out).toContain('selftest-creditor-score: all checks passed');
  });

  it('one broken score cannot silently stop the other, and both write change-gated', () => {
    const score = src.slice(src.indexOf('def cmd_score'), src.indexOf('def response_score('));
    // Each agent's reading runs in its own try — a creditor table outage must
    // not stop the response score, and vice versa — and failures still exit
    // non-zero so the job alarm sees them.
    expect(score).toMatch(/for label, fn in \(\("response", response_score\),\s*\n?\s*\("creditor", creditor_score\)\)/);
    expect(score).toMatch(/sys\.exit\("ERROR: score failed/);
    const cred = src.slice(src.indexOf('def creditor_score('), src.indexOf('def creditor_score_selftest'));
    expect(cred).toMatch(/CREDITOR_REGISTER_ROW/);
    expect(cred).toMatch(/reading == prev/);
    // The ledger read must go through the ONE paginated helper — a hand-rolled
    // fetch is how the recon accuracy card scored only its first page.
    expect(cred).toMatch(/query_records\(CREDITOR_PLANS_TABLE/);
  });

  it('an unknown ledger status counts as OPEN, never vanishes from the reading', () => {
    const out = pyEval(`mod.creditor_score_reading([
      {"fields": {mod.CREDITOR_PLANS_FIELDS["status"]: {"name": "Renamed Later"}}}])[1]`);
    expect(out.open).toBe(1);
  });
});

describe('skills and agent definitions stay in step (local machine only)', () => {
  const skill = resolve(homedir(), '.claude/scheduled-tasks/agent-dispatch/SKILL.md');
  const triage = resolve(homedir(), '.claude/scheduled-tasks/inbound-email-triage/SKILL.md');
  const sweep = resolve(homedir(), '.claude/scheduled-tasks/inbound-messages-sweep/SKILL.md');
  const agentDef = resolve(homedir(), '.claude/agents/creditor-management.md');
  const responseDef = resolve(homedir(), '.claude/agents/inbound-comms-response.md');
  // These live outside the repo, so skip cleanly anywhere they do not exist
  // (a fresh clone, CI). On Kevin's Mac they must all hold.

  it.skipIf(!existsSync(skill))('the dispatch skill knows the creditor lane', () => {
    const s = readFileSync(skill, 'utf8');
    expect(s).toMatch(/Creditor Management agent/);
    expect(s).toMatch(/creditor: true/);
    // Money owed TO Kevin is explicitly out of the lane in the judgement rule
    expect(s).toMatch(/never money owed TO Kevin/);
  });

  it.skipIf(!existsSync(triage))('triage stamps the CREDITOR MATTER marker on label-18 tasks', () => {
    expect(readFileSync(triage, 'utf8')).toMatch(/CREDITOR MATTER/);
  });

  it.skipIf(!existsSync(sweep))('the iMessage sweep stamps the same marker', () => {
    expect(readFileSync(sweep, 'utf8')).toMatch(/CREDITOR MATTER/);
  });

  it.skipIf(!existsSync(agentDef))('the local agent definition exists and holds the hard lines', () => {
    const a = readFileSync(agentDef, 'utf8');
    expect(a).toMatch(/name: creditor-management/);
    expect(a).toMatch(/tier-1/);
    expect(a).toMatch(/NEVER cite the restraint order for a live\s+supply/);
    expect(a).toMatch(/enforcement\s+agents or bailiffs/);
    expect(a).toMatch(/Never draft the response/);
    expect(a).toMatch(/contractors always get paid/i);
    expect(a).toMatch(/tbljyVlkq1BXzny2G/);
  });

  it.skipIf(!existsSync(responseDef))('the Response agent hands creditor matters to the specialist', () => {
    expect(readFileSync(responseDef, 'utf8')).toMatch(/Creditor Management agent/);
  });
});
