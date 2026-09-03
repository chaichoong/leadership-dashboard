// Guards the Creditor Management agent's dispatch wiring (25 Aug 2026).
//
// WHAT THIS EXISTS FOR
// The Creditor Management agent only works if six pieces stay true at once:
//   1. Its Team Members record is a dispatchable role agent (ROLE_AGENTS).
//   2. Inbound creditor tasks auto-route to it deterministically, AHEAD of
//      the generic inbound Response route — and ONLY inbound tasks: the
//      floor patterns are too loose for arbitrary CEO-lane text.
//   3. The routing floor catches creditor vocabulary but a receivable veto
//      stops money owed TO Kevin (tenant rent, client invoices, UC) — the
//      25 Aug 2026 review proved "chase the payment from the client" matched
//      the raw patterns, so the veto is what holds the direction invariant.
//   4. Creditor work is ALWAYS tier-1 (Kevin's ruling): the queue forces the
//      banner even where the tier-1 keyword list would miss (statutory
//      demand, letter of claim were tier-2-only vocabulary).
//   5. The old tier-2 park survives ONLY as the fallback while the agent's
//      register row is not dispatchable — Kevin's pause lever re-parks the
//      lane — and the dispatch skill's report spec carries skippedTier2 so
//      verify's park alarm is not dead code.
//   6. The two register metrics stay honest: prepared-coverage never counts
//      Kevin's approval queue against the agent, and the fixed-cost rule
//      mirrors isCostActive in js/shared.js.
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

const CREDITOR_TM = 'recjh6mmaF8KJW8t3';
const CREDITOR_ROW = 'recDvxwDGcC3pFbPa';

const pyEval = makeRunPy(DISPATCH);

// Synthetic task/roster shapes for the AUTO_ROUTES helpers — the keys the
// predicates read, nothing more.
const T = (over) => ({ creditor: false, inboundTask: false,
                       tier2Correspondence: false, ...over });
const LIVE_ROSTER = {
  [CREDITOR_TM]: { dispatchable: true },
  recJ8J8idWE8d97tH: { dispatchable: true },
};
const route = (fn, ...args) => pyEval(`mod.${fn}(*arg)`, args);

describe('roster wiring', () => {
  it('the Creditor agent is a dispatchable role agent with the right identities', () => {
    const out = pyEval(`{
      "inRole": ${JSON.stringify(CREDITOR_TM)} in mod.ROLE_AGENTS,
      "inAll": ${JSON.stringify(CREDITOR_TM)} in mod.ALL_AGENTS,
      "agent": mod.ROLE_AGENTS.get(${JSON.stringify(CREDITOR_TM)}, {}).get("agent"),
      "credRec": mod.CREDITOR_REC_ID,
      "credRow": mod.CREDITOR_REGISTER_ROW,
      "costsTable": mod.COSTS_TABLE,
      "strategic17": len(mod.AGENTS)}`);
    expect(out.inRole).toBe(true);
    expect(out.inAll).toBe(true);
    expect(out.agent).toBe('creditor-management');
    expect(out.credRec).toBe(CREDITOR_TM);
    expect(out.credRow).toBe(CREDITOR_ROW);
    expect(out.costsTable).toBe('tblx5kvhzNEI5TFlS');
    // ROLE_AGENTS extends the 17, never replaces them
    expect(out.strategic17).toBe(17);
  });
});

describe('the routing floor (real creditor_match, one batched python call)', () => {
  // One interpreter spawn for the whole matrix — the per-call pattern made
  // this the slowest file in the suite (review finding, 25 Aug 2026).
  const CASES = [
    // must match: the triage marker and true creditor vocabulary
    ['CREDITOR MATTER\nCollections firm chasing the balance', true],
    ['Reply to the statutory demand', true],
    ['Final notice from the energy supplier', true],
    ['They are chasing payment on the account', true],
    ['Agree a payment plan with the supplier', true],
    ['Letter before action received', true],
    ['Bounce back loan repayment demand', true],
    // must NOT match: money owed TO Kevin. The first five contain phrases
    // that DO match the raw patterns — the receivable veto is what holds
    // (verified matching before the veto existed: review, 25 Aug 2026).
    ['Chase the payment from the client for the July invoice', false],
    ['Set up a payment plan for the tenant arrears', false],
    ['Tenant reports their outstanding balance looks wrong', false],
    ['Chasing payment: tenancy rent for August', false],
    ['Final notice: client onboarding invoice unpaid', false],
    ['Chase the rent arrears on the rental unit', false],
    ['UC verification for the new tenancy', false],
    ['Weekly reconciliation of transactions', false],
  ];
  it('matches creditor vocabulary and vetoes receivables', () => {
    const results = pyEval(
      `[bool(mod.creditor_match(t, "", "")) for t in ${JSON.stringify(CASES.map(c => c[0]))}]`);
    CASES.forEach(([text, expected], i) => {
      expect(results[i], text).toBe(expected);
    });
  });
});

describe('queue routing and the pause lever', () => {
  const queue = src.slice(src.indexOf('def build_queue'), src.indexOf('# ─── WRITES'));

  it('the deterministic creditor lane is inbound-only and beats the Response route (real AUTO_ROUTES)', () => {
    // Behavioural, through the real table — never source offsets.
    // Creditor beats Response: a creditor email is an inbound task too.
    expect(route('auto_route_fresh',
      T({ creditor: true, inboundTask: true }), LIVE_ROSTER)).toBe(CREDITOR_TM);
    // A plain inbound task goes to the generalist.
    expect(route('auto_route_fresh',
      T({ inboundTask: true }), LIVE_ROSTER)).toBe('recJ8J8idWE8d97tH');
    // Inbound-only: creditor-flavoured CEO-lane text that is NOT inbound
    // goes to the CEO judgement pass, not the keyword floor.
    expect(route('auto_route_fresh',
      T({ creditor: true }), LIVE_ROSTER)).toBeNull();
    // Kevin's pause lever: creditor row not dispatchable → the inbound task
    // still flows, to the Response agent.
    expect(route('auto_route_fresh', T({ creditor: true, inboundTask: true }),
      { recJ8J8idWE8d97tH: { dispatchable: true } })).toBe('recJ8J8idWE8d97tH');
    // Both paused (or the roster read failed) → CEO lane keeps it.
    expect(route('auto_route_fresh',
      T({ creditor: true, inboundTask: true }), {})).toBeNull();
  });

  it('creditor work is forced tier-1 in the queue, and the tier-1 keywords carry the tier-2 vocabulary', () => {
    // Kevin's ruling: creditor mail is always tier-1. "Statutory demand" and
    // "letter of claim" were tier-2-only words, so an unparked task would
    // have reached Kevin unbannered (review finding, 25 Aug 2026).
    expect(queue).toMatch(/if t\["creditor"\] and not t\["tier1"\]:/);
    const out = pyEval(`{
      "sd": bool(mod.tier_match(mod.TIER1_PATTERNS, "Reply to the statutory demand", "", "")),
      "loc": bool(mod.tier_match(mod.TIER1_PATTERNS, "Letter of claim received", "", "")),
      "bbl": bool(mod.tier_match(mod.TIER1_PATTERNS, "Bounce back loan demand", "", ""))}`);
    expect(out.sd).toBe(true);
    expect(out.loc).toBe(true);
    expect(out.bbl).toBe(true);
  });

  it('the tier-2 park survives ONLY while the agent is not dispatchable', () => {
    expect(queue).toMatch(/if hit2 and out2 and not creditor_ok:/);
    expect(queue).toMatch(
      /creditor_ok = bool\(role_roster\.get\(CREDITOR_REC_ID, \{\}\)\.get\("dispatchable"\)\)/);
  });

  it('reroutes off the WRONG agent narrowly: Response or parked correspondence only (real AUTO_ROUTES)', () => {
    const RESPONSE = 'recJ8J8idWE8d97tH';
    // An inbound creditor thread sitting with the generalist moves over.
    expect(route('auto_route_steal',
      T({ creditor: true }), RESPONSE, LIVE_ROSTER)).toBe(CREDITOR_TM);
    // Formerly-parked creditor correspondence moves whoever holds it.
    expect(route('auto_route_steal',
      T({ creditor: true, tier2Correspondence: true }), 'recSomeDeptHead00',
      LIVE_ROSTER)).toBe(CREDITOR_TM);
    // A dept head ANALYSING a creditor-flavoured question keeps its task —
    // the CEO's explicit routing decision is not silently overridden.
    expect(route('auto_route_steal',
      T({ creditor: true }), 'recSomeDeptHead00', LIVE_ROSTER)).toBeNull();
    // Already with the specialist: nothing to move.
    expect(route('auto_route_steal',
      T({ creditor: true }), CREDITOR_TM, LIVE_ROSTER)).toBeNull();
    // Pause lever: creditor row not dispatchable → no move.
    expect(route('auto_route_steal', T({ creditor: true }), RESPONSE,
      { [RESPONSE]: { dispatchable: true } })).toBeNull();
  });

  it('the queue JSON carries the creditor visibility counter', () => {
    expect(queue).toMatch(/"creditorMatters": creditor_count/);
  });
});

describe('register metrics (Kevin\'s two, 25 Aug 2026)', () => {
  it('the offline selftests pass against the real functions (both agents)', () => {
    const out = execFileSync('python3', [DISPATCH, 'score', '--selftest'],
      { encoding: 'utf8' });
    expect(out).toContain('selftest-score: all checks passed');
    expect(out).toContain('selftest-creditor-score: all checks passed');
    expect(out).toContain('selftest-creditor-ledger: all checks passed');
  });

  it('prepared-coverage NEVER counts Kevin\'s approval queue against the agent', () => {
    // A task sitting at Status Approval is PREPARED work waiting on Kevin —
    // his bottleneck, reported separately, never a miss for the agent.
    const out = pyEval(`mod.creditor_coverage([
      {"fields": {mod.AF["status"]: {"name": "Approval"},
                  mod.AF["teamMember"]: ["${CREDITOR_TM}"]}},
      {"fields": {mod.AF["status"]: {"name": "Today"},
                  mod.AF["teamMember"]: ["${CREDITOR_TM}"]}}])`);
    expect(out[1]).toEqual({ creditorTasks: 2, prepared: 1, withKevin: 1 });
    expect(out[0]).toBe('creditor inbound: 1/2 prepared, 1 with Kevin');
  });

  it('the fixed-cost rule mirrors isCostActive in js/shared.js', () => {
    // Same rule, both sides, or the register and the dashboard disagree.
    const shared = readFileSync(resolve(ROOT, 'js/shared.js'), 'utf8');
    const isActive = shared.slice(shared.indexOf('function isCostActive'),
                                  shared.indexOf('}', shared.indexOf('function isCostActive') + 400));
    expect(isActive).toContain("'In Payment'");
    expect(isActive).toContain("'Overdue'");
    const cred = src.slice(src.indexOf('def fixed_costs_reading'),
                           src.indexOf('def creditor_score('));
    expect(cred).toMatch(/"In Payment",?\s*\n?\s*"Overdue"/);
    expect(cred).toMatch(/COST_FIELDS\["inactive"\]/);
  });

  it('one broken score cannot silently stop the other, and the shared write is change-gated', () => {
    const score = src.slice(src.indexOf('def cmd_score'), src.indexOf('def response_score_selftest'));
    // The steps are a table now — assert its CONTENT through the module, so
    // a new agent's build session adds an entry and this stays true.
    expect(pyEval('[label for label, fn in mod.SCORE_STEPS]'))
      .toEqual(['response', 'creditor', 'weekly-review', 'monthly-review',
                'chase', 'property', 'renewals', 'quarterly-review']);
    expect(score).toMatch(/for label, fn in SCORE_STEPS/);
    expect(score).toMatch(/sys\.exit\("ERROR: score failed/);
    // The one shared register write: change-gated, per-agent state file.
    expect(score).toMatch(/def write_register_reading/);
    expect(score).toMatch(/REGISTER_METRIC_SCORE/);
    expect(score).toMatch(/reading == prev/);
    // Controls on both creditor reads: broken-read exits, never a quiet zero.
    const cred = src.slice(src.indexOf('def creditor_score('), src.indexOf('def creditor_score_selftest'));
    expect(cred).toMatch(/control failed — the open\/recent task read/);
    expect(cred).toMatch(/control failed — zero ACTIVE costs/);
    // Both reads go through the ONE paginated helper.
    expect(cred).toMatch(/query_records\(COSTS_TABLE/);
    expect(cred).toMatch(/query_tasks\(/);
  });
});

describe('the creditor record book (revamp, Kevin-approved chain, 1 Sep 2026)', () => {
  // Approved chain links 2, 9 and 10 — history read-back, enforced ledger
  // write, chase-only-what-we-are-owed. Behavioural through the real
  // functions wherever they are pure; source contracts where the behaviour
  // needs Airtable.
  const PAGE = (over) => ({
    id: 'recP', createdTime: '2026-09-01T00:00:00.000Z', creditor: 'HMRC',
    status: 'Awaiting response', monthlyAmount: null, entity: '', lane: '',
    lastContact: '', nextStep: '', nextStepDate: '', taskIds: [], notes: '',
    ...over,
  });

  it('postures count frozen, on-plan £/mo and awaiting — a blank amount counts £0', () => {
    const out = pyEval('mod.ledger_postures(arg)', [
      PAGE({ status: 'Frozen' }),
      PAGE({ status: 'Plan agreed', monthlyAmount: 100 }),
      PAGE({ status: 'Plan agreed' }),       // blank amount → £0, still on-plan
      PAGE({ status: 'Awaiting response' }),
    ]);
    expect(out[0]).toBe('ledger: 1 frozen, 2 on plans £100.00/mo, 1 awaiting');
    expect(out[1]).toEqual({ frozen: 1, onPlans: 2, plansMonthly: 100,
                             awaiting: 1 });
  });

  it('find_plan: task link beats name, names match case-insensitively, the OLDEST twin wins', () => {
    const old = PAGE({ id: 'recOld', createdTime: '2026-08-01T00:00:00.000Z',
                       creditor: 'Fylde Council' });
    const dupe = PAGE({ id: 'recNew', createdTime: '2026-08-20T00:00:00.000Z',
                        creditor: 'FYLDE COUNCIL' });
    const linked = PAGE({ id: 'recL', creditor: 'Other',
                          taskIds: ['recTask9'] });
    let [hit, twins] = pyEval('mod.find_plan(arg, "recTask9", "fylde council")',
      [dupe, old, linked]);
    expect(hit.id).toBe('recL');
    [hit, twins] = pyEval('mod.find_plan(arg, "", "fylde council")',
      [dupe, old]);
    expect(hit.id).toBe('recOld');           // a twin can never hijack history
    expect(twins.map((t) => t.id)).toEqual(['recNew']);
  });

  it('chase_due fires on or after the date, and can never chase a freeze request (no date = no chase)', () => {
    const due = pyEval('[p["id"] for p in mod.chase_due(arg, "2026-09-01")]', [
      PAGE({ id: 'a', nextStep: 'Chase LOA', nextStepDate: '2026-09-01' }),
      PAGE({ id: 'b', nextStep: 'Chase refund', nextStepDate: '2026-08-25' }),
      PAGE({ id: 'c', nextStep: 'Early', nextStepDate: '2026-09-03' }),
      PAGE({ id: 'd', nextStep: 'Freeze letter sent, no chase' }), // no date
      PAGE({ id: 'e', nextStep: 'x', nextStepDate: '2026-09-01',
             status: 'Settled' }),
    ]);
    expect(due).toEqual(['a', 'b']);
  });

  it('the monthly deep dive gates on the first Monday IN CODE, London time — never a cron day-of-week', () => {
    const out = pyEval(`{
      "firstMon": mod.is_first_monday(mod.datetime(2026, 9, 7)),
      "laterMon": mod.is_first_monday(mod.datetime(2026, 9, 14)),
      "tue": mod.is_first_monday(mod.datetime(2026, 9, 1))}`);
    expect(out).toEqual({ firstMon: true, laterMon: false, tue: false });
    const monthly = src.slice(src.indexOf('def ensure_monthly_review'),
                              src.indexOf('CHASE_STATE ='));
    expect(monthly).toMatch(/datetime\.now\(LONDON\)/);
    expect(monthly).toMatch(/is_first_monday/);
    expect(monthly).toMatch(/MONTHLY_REVIEW_STATE/);   // once per month, state-gated
  });

  it('verify enforces the record-book write on every creditor submit, read from the LIVE table', () => {
    const verify = src.slice(src.indexOf('def cmd_verify'),
                             src.indexOf('# ─── ENTRY'));
    // The gate collects creditor redo/new submits (cost reviews exempt by
    // the shared name prefix) and fails on a missing page, an empty Next
    // Step, or an unreachable book — drafting blind is refused.
    expect(verify).toMatch(/CREDITOR_REC_ID in live\["teamMemberIds"\]/);
    expect(verify).toMatch(/REVIEW_TASK_PREFIX/);
    expect(verify).toMatch(/submitted with NO/);
    expect(verify).toMatch(/record-book update/);
    expect(verify).toMatch(/empty Next Step/);
    expect(verify).toMatch(/record book unreachable/);
    expect(pyEval('mod.REVIEW_TASK_PREFIX')).toBe('Fixed cost');
    // Both engine-raised review names share the exempting prefix.
    expect(pyEval('mod.REVIEW_TASK_NAME.startswith(mod.REVIEW_TASK_PREFIX)')).toBe(true);
    expect(pyEval('mod.MONTHLY_REVIEW_NAME.startswith(mod.REVIEW_TASK_PREFIX)')).toBe(true);
  });

  it('the queue hands the record book to the drafting agent, and carries a read failure instead of hiding it', () => {
    const queue = src.slice(src.indexOf('def build_queue'), src.indexOf('# ─── WRITES'));
    expect(queue).toMatch(/"creditorLedger": creditor_ledger/);
    expect(queue).toMatch(/"creditorLedgerError": creditor_ledger_error/);
    expect(queue).toMatch(/plan_digest\(p\) for p in fetch_plans\(\)/);
  });

  it('the ledger command is registered as the ONE write path, and a chase date needs a step', () => {
    expect(src).toMatch(/"ledger": cmd_ledger/);
    const ledger = src.slice(src.indexOf('def cmd_ledger'),
                             src.indexOf('MONTHLY_REVIEW_STATE ='));
    expect(ledger).toMatch(/alarm with no\s+"?\s*"?message/);
    expect(ledger).toMatch(/lastContact"\]: today_london\(\)/);
    // The score's third reading has its control: an empty book read is a
    // broken read, never a quiet zero.
    const score = src.slice(src.indexOf('def creditor_score('),
                            src.indexOf('def creditor_score_selftest'));
    expect(score).toMatch(/zero pages read from the Creditor/);
    expect(score).toMatch(/ledger_postures\(plans\)/);
  });

  it('chase tasks are routed to the creditor agent and marked CREDITOR MATTER', () => {
    const chase = src.slice(src.indexOf('def ensure_chase_tasks'),
                            src.indexOf('def creditor_score_selftest'));
    expect(chase).toMatch(/CREDITOR MATTER/);
    expect(chase).toMatch(/raise_engine_task\(\s*name, CREDITOR_REC_ID/);
    expect(chase).toMatch(/CHASE_STATE/);      // one chase per page per date
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

  it.skipIf(!existsSync(skill))('the dispatch skill keys creditor dispatch on the ROUTED agent, not the flag', () => {
    const s = readFileSync(skill, 'utf8');
    expect(s).toMatch(/Creditor Management agent/);
    // The flag stays true while the pause lever is on; dispatching on it
    // alone bypasses the lever or fails the submit (review, 25 Aug 2026).
    expect(s).toMatch(/ROUTED agent/);
    expect(s).toMatch(/never on the `creditor: true` flag alone/);
    expect(s).toMatch(/never money owed TO Kevin/);
    // verify's park alarm reads report.skippedTier2 — the spec must tell the
    // dispatcher to copy it, or the alarm is dead code again.
    expect(s).toMatch(/"skippedTier2"/);
    // The record book (revamp, 1 Sep 2026): history handed to every creditor
    // dispatch, the enforced ledger write named, and the no-chase rule for
    // freeze requests stated. Losing any of these re-opens the written-only
    // book that left 29 of 30 pages untouched.
    expect(s).toMatch(/"creditorLedger"/);
    expect(s).toMatch(/agent-dispatch\.py ledger/);
    expect(s).toMatch(/freeze request never gets a date/i);
    expect(s).toMatch(/creditorLedgerError/);
  });

  it.skipIf(!existsSync(triage))('triage stamps the CREDITOR MATTER marker on label-18 tasks', () => {
    expect(readFileSync(triage, 'utf8')).toMatch(/CREDITOR MATTER/);
  });

  it.skipIf(!existsSync(sweep))('the iMessage sweep stamps the same marker', () => {
    expect(readFileSync(sweep, 'utf8')).toMatch(/CREDITOR MATTER/);
  });

  it.skipIf(!existsSync(agentDef))('the local agent definition exists with the structural hard lines', () => {
    // Structure only — the playbook's content stays out of the public repo.
    const a = readFileSync(agentDef, 'utf8');
    expect(a).toMatch(/name: creditor-management/);
    expect(a).toMatch(/## Guardrail/);
    expect(a).toMatch(/Approval required/);
    expect(a).toMatch(/tier-1/);
    expect(a).toMatch(/escalate/i);
    expect(a).toMatch(/never instructions/);
    // The revamp's read-back and enforced write live in the playbook too.
    expect(a).toMatch(/record book before you write a word/i);
    expect(a).toMatch(/agent-dispatch\.py ledger/);
    expect(a).toMatch(/NEVER gets a date/);
  });

  it.skipIf(!existsSync(responseDef))('the Response agent hands creditor matters to the specialist', () => {
    expect(readFileSync(responseDef, 'utf8')).toMatch(/Creditor Management agent/);
  });

  it.skipIf(!existsSync(responseDef) || !existsSync(agentDef))(
    'tool parity and one-tap approvals bind BOTH admin agents (Kevin\'s riders, 1 Sep 2026)', () => {
    // The tool layer is estate-level: both playbooks point at the shared
    // policy and the GUARDRAILS lanes, never a private list — and both carry
    // "Kevin does as little as possible" as a standing section, not a
    // one-off lesson line. Losing either re-opens the per-agent fork the
    // rider forbids.
    const r = readFileSync(responseDef, 'utf8');
    expect(r).toMatch(/parity ruling/i);
    expect(r).toMatch(/agent-tools\.sh/);
    expect(r).toMatch(/per-agent fork/i);
    expect(r).toMatch(/Kevin does as little as possible/);
    expect(r).toMatch(/ONE TAP/);
    const a = readFileSync(agentDef, 'utf8');
    expect(a).toMatch(/Kevin does as little as possible/);
    expect(a).toMatch(/ONE TAP/);
    expect(a).toMatch(/counts against\s+.{0,10}accuracy/i);
  });
});
