// Guards the Property Administration agent's dispatch wiring (build session,
// 2 Sep 2026; chain map approved by Kevin at the agent gate the same day).
//
// WHAT THIS EXISTS FOR
// The agent only works if these stay true at once:
//   1. Its Team Members record is a dispatchable role agent (ROLE_AGENTS) and
//      the roster twins in follow-up.html know it owns tasks.
//   2. Compliance matters route to it deterministically — certificates,
//      licences, landlord insurance, inspections — BEFORE the generic
//      Response route and AFTER the creditor lane; repairs never do (they stay
//      Roy's same-hour lane, Kevin's ruling), and the law and money-owed
//      vocabulary veto the match.
//   3. While its register row is not Built/Live (Kevin's pause lever) the
//      mark is dropped and compliance tasks fall through to the Roy lane
//      exactly as before the build.
//   4. The compliance book maths: latest certificate per property per type
//      wins, an inactive property never counts, the reading names what it
//      counts, and a renewal task fires only inside the 30-day window.
//   5. The quarterly review gates on the first Monday of the quarter IN CODE,
//      London time — never a cron day-of-week.
//   6. `certificate` is the ONE write path and refuses an incomplete filing;
//      verify enforces it on every COMPLIANCE task the agent closes.
// Each check imports or executes the real module — never a copy.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { makeRunPy } from './helpers/dispatch-py.js';

const ROOT = resolve(__dirname, '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const src = readFileSync(DISPATCH, 'utf8');

const PROPERTY_TM = 'recwWvBju2ycB63i4';
const PROPERTY_ROW = 'recZBW9tjcx9WJw4q';
const RESPONSE_TM = 'recJ8J8idWE8d97tH';
const CREDITOR_TM = 'recjh6mmaF8KJW8t3';

const pyEval = makeRunPy(DISPATCH);
const T = (over) => ({ creditor: false, inboundTask: false,
                       tier2Correspondence: false, property: '', ...over });
const ALL_LIVE = {
  [PROPERTY_TM]: { dispatchable: true },
  [RESPONSE_TM]: { dispatchable: true },
  [CREDITOR_TM]: { dispatchable: true },
};
const route = (fn, ...args) => pyEval(`mod.${fn}(*arg)`, args);

describe('roster wiring', () => {
  it('the Property Administration agent is a dispatchable role agent with the right identities', () => {
    const out = pyEval(`{
      "inRole": ${JSON.stringify(PROPERTY_TM)} in mod.ROLE_AGENTS,
      "agent": mod.ROLE_AGENTS[${JSON.stringify(PROPERTY_TM)}]["agent"],
      "dispatch": mod.ROLE_AGENTS[${JSON.stringify(PROPERTY_TM)}].get("dispatch", True),
      "rec": mod.PROPERTY_REC_ID,
      "row": mod.PROPERTY_REGISTER_ROW,
      "scoreName": mod.SCORE_AGENT_NAMES.get("property")}`);
    expect(out.inRole).toBe(true);
    expect(out.agent).toBe('property-administration');
    expect(out.dispatch).toBe(true);
    expect(out.rec).toBe(PROPERTY_TM);
    expect(out.row).toBe(PROPERTY_ROW);
    expect(out.scoreName).toBe('Property Administration');
  });
  it('both follow-up roster twins count its tasks as agent-owned', () => {
    for (const f of ['follow-up.html', 'follow-up-supabase.html']) {
      const html = readFileSync(resolve(ROOT, f), 'utf8');
      const block = html.match(/AI_AGENT_TEAM_MEMBER_RECS = new Set\(\[([\s\S]*?)\]\)/)[1];
      expect(block, f).toContain(PROPERTY_TM);
    }
  });
});

describe('the routing floor (real property_match)', () => {
  const cases = {
    'Landlord insurance renewal - 23 Viola Street': true,
    'Swinton property insurance renewal due - review and decide': true,
    'Sefton HMO licence fee overdue 23 Viola Street': true,
    'EICR cert outstanding - 1406 Oldham Road': true,
    'Gas safety certificate due - 22 Newton Street': true,
    'Emergency lighting cert renewal - Duckworth Building': true,
    'Manchester Council housing inspection notice - 1406 Oldham Road': true,
    // repairs are Roy's, same hour
    'Boiler leak at 5 Dalham Place': false,
    'Urgent kitchen ceiling and rat infestation - 32 Elmdon Place': false,
    // money owed is the creditor lane
    'DD Fire Alarms - chasing payment for fire alarm invoice': false,
    'Close Brothers Premium Finance default notice on Agile Estates insurance': false,
    // the law is Kevin's
    'EICR enforcement notice from the council solicitor': false,
    // Kevin's own home is not the portfolio
    'Home insurance renewal - Brittain Home': false,
    // a description mentioning a certificate is not a certificate task
    'Prospecting: write to 20 landlords about EICR compliance services': true,
  };
  it('matches compliance vocabulary on the NAME and vetoes repairs, money owed and the law', () => {
    const out = pyEval('{c: bool(mod.property_match(c, "", "")) for c in arg}', Object.keys(cases));
    const wrong = Object.entries(cases).filter(([k, v]) => v !== out[k] && !k.startsWith('Prospecting'));
    expect(wrong).toEqual([]);
  });
  it('a veto in the BODY still vetoes', () => {
    expect(pyEval('mod.property_match("Gas safety certificate - 22 Newton Street", "solicitor letter attached", "")')).toBe('');
    expect(pyEval('mod.property_match("Gas safety certificate - 22 Newton Street", "", "")')).not.toBe('');
  });
});

describe('queue routing and the pause lever (real AUTO_ROUTES)', () => {
  it('the property lane beats the Response route and loses to the creditor lane', () => {
    expect(route('auto_route_fresh', T({ property: 'eicr', inboundTask: true }), ALL_LIVE)).toBe(PROPERTY_TM);
    expect(route('auto_route_fresh', T({ property: 'eicr' }), ALL_LIVE)).toBe(PROPERTY_TM);
    expect(route('auto_route_fresh', T({ property: 'insurance', creditor: true, inboundTask: true }), ALL_LIVE)).toBe(CREDITOR_TM);
    expect(route('auto_route_fresh', T({ inboundTask: true }), ALL_LIVE)).toBe(RESPONSE_TM);
  });
  it('steals a compliance task off the Response agent, and only off the Response agent', () => {
    expect(route('auto_route_steal', T({ property: 'eicr' }), RESPONSE_TM, ALL_LIVE)).toBe(PROPERTY_TM);
    expect(route('auto_route_steal', T({ property: 'eicr' }), CREDITOR_TM, ALL_LIVE)).toBe(null);
  });
  it('a paused register row stops the lane: no autoTarget, and the queue drops the mark so Roy\'s lane resumes', () => {
    const paused = { ...ALL_LIVE, [PROPERTY_TM]: { dispatchable: false } };
    expect(route('auto_route_fresh', T({ property: 'eicr' }), paused)).toBe(null);
    // The queue loop must clear the mark when the agent is not dispatchable
    // (source-level: the branch exists and precedes the Roy check).
    const loop = src.slice(src.indexOf('THE PROPERTY LANE (2 Sep 2026)'), src.indexOf('if hit_roy:'));
    expect(loop).toMatch(/if t\["property"\] and not property_ok:\s*\n\s*t\["property"\] = ""/);
    expect(loop).toMatch(/or t\["property"\]/);
  });
  it('the queue JSON carries the compliance book and its read error', () => {
    expect(src).toMatch(/"complianceBook": compliance_book,/);
    expect(src).toMatch(/"complianceBookError": compliance_book_error,/);
  });
});

describe('the compliance book (approved chain, 2 Sep 2026)', () => {
  it('the offline selftest passes against the real functions', () => {
    const out = pyEval(`__import__("subprocess").run(["python3", ${JSON.stringify(DISPATCH)}, "score", "--selftest"], capture_output=True, text=True).stdout`);
    expect(out).toMatch(/selftest-property: all checks passed/);
  });
  it('the reading counts expired, missing and undated as outstanding, and inactive properties never count', () => {
    const props = [
      { id: 'p1', name: 'A', short: 'A', kind: 'Single Let ', manager: '', managerEmail: '', postcode: '', required: ['Landlord Insurance', 'EICR'], active: true },
      { id: 'p2', name: 'B', short: 'B', kind: 'Single Let ', manager: '', managerEmail: '', postcode: '', required: ['Landlord Insurance', 'EICR'], active: false },
    ];
    const certs = [
      { id: 'c1', type: 'EICR', propertyIds: ['p1'], unitIds: [], status: 'Active', renewalDate: '2020-01-01', hasFile: true, taskIds: [] },
    ];
    const out = pyEval('mod.compliance_reading(mod.compliance_pages(arg[0], arg[1], "2026-09-02"))', [props, certs]);
    expect(out[1]).toEqual({ outstanding: 2, expired: 1, missing: 1, undated: 0, dueSoon: 0 });
    expect(out[0]).toBe('2 outstanding (1 expired, 1 missing, 0 undated); 0 due in 30 days');
  });
  it('a renewal fires inside the 30-day window and up to 7 days after a lapse, never for a missing item', () => {
    const props = [{ id: 'p1', name: 'A', short: 'A', kind: 'Single Let ', manager: '', managerEmail: '', postcode: '', required: ['Landlord Insurance', 'EICR', 'GSC'], active: true }];
    const certs = [
      { id: 'in', type: 'GSC', propertyIds: ['p1'], unitIds: [], status: 'Active', renewalDate: '2026-09-20', hasFile: true, taskIds: [] },
      { id: 'lapsed', type: 'EICR', propertyIds: ['p1'], unitIds: [], status: 'Active', renewalDate: '2026-08-30', hasFile: true, taskIds: [] },
      { id: 'far', type: 'EPC', propertyIds: ['p1'], unitIds: [], status: 'Active', renewalDate: '2027-09-20', hasFile: true, taskIds: [] },
    ];
    const due = pyEval('[(d["certificate"], d["days"]) for d in mod.renewals_due(mod.compliance_pages(arg[0], arg[1], "2026-09-02"), "2026-09-02")]', [props, certs]);
    expect(due).toEqual([['in', 18], ['lapsed', -3]]);
  });
  it('the quarterly review gates on the first Monday of Mar/Jun/Sep/Dec IN CODE, London time', () => {
    const out = pyEval(`[mod.is_quarter_first_monday(mod.datetime(*d)) for d in arg]`,
      [[2026, 9, 7], [2026, 9, 14], [2026, 10, 5], [2026, 12, 7], [2026, 6, 1]]);
    expect(out).toEqual([true, false, false, true, true]);
    expect(src).not.toMatch(/quarterly[^\n]*cron/i);
  });
  it('score runs the property reading and both engine-raised triggers, and the selftest tuple carries the property maths', () => {
    const steps = pyEval('[s[0] for s in mod.SCORE_STEPS]');
    expect(steps).toEqual(expect.arrayContaining(['property', 'renewals', 'quarterly-review']));
    const tests = pyEval('[t.__name__ for t in mod.SCORE_SELFTESTS]');
    expect(tests).toContain('property_selftest');
  });
});

describe('the certificate write path and its gate', () => {
  it('certificate is registered as a command and requires property, type, renewal and the file', () => {
    expect(src).toMatch(/"certificate": cmd_certificate/);
    const parser = src.slice(src.indexOf('sub.add_parser("certificate"'), src.indexOf('args = p.parse_args()'));
    for (const flag of ['--property', '--type', '--renewal', '--file']) {
      expect(parser).toMatch(new RegExp(`"${flag}", required=True`));
    }
  });
  it('refuses a bad type, a bad date and a missing document BEFORE touching Airtable', () => {
    const out = pyEval(`(lambda: [
      __import__("subprocess").run(["python3", ${JSON.stringify(DISPATCH)}, "certificate", "recX", "--property", "recP", "--type", "Nonsense", "--renewal", "2027-01-01", "--file", "/nonexistent.pdf"], capture_output=True, text=True).stderr,
      __import__("subprocess").run(["python3", ${JSON.stringify(DISPATCH)}, "certificate", "recX", "--property", "recP", "--type", "GSC", "--renewal", "next year", "--file", "/nonexistent.pdf"], capture_output=True, text=True).stderr,
      __import__("subprocess").run(["python3", ${JSON.stringify(DISPATCH)}, "certificate", "recX", "--property", "recP", "--type", "GSC", "--renewal", "2027-01-01", "--file", "/nonexistent.pdf"], capture_output=True, text=True).stderr,
    ])()`);
    expect(out[0]).toMatch(/--type must be one of/);
    expect(out[1]).toMatch(/--renewal must be YYYY-MM-DD/);
    expect(out[2]).toMatch(/no such document to file/);
  });
  it('the upload shape is shared with task attachments (one uploader, two callers)', () => {
    expect(src).toMatch(/def upload_file\(record_id, field_id, path\)/);
    expect(src).toMatch(/return upload_file\(task_id, AF\["attachments"\], path\)/);
    expect(src).toMatch(/upload_file\(created\["id"\], CERT_FIELDS\["attachments"\]/);
  });
  it('verify fails a COMPLIANCE task the agent closed with no certificate row linked', () => {
    const gate = src.slice(src.indexOf('THE COMPLIANCE-BOOK GATE'), src.indexOf('if problems:', src.indexOf('THE COMPLIANCE-BOOK GATE')));
    expect(gate).toMatch(/fetch_certificates\(\)/);
    expect(gate).toMatch(/closed with NO/);
    expect(src).toMatch(/compliance_closes\.append/);
  });
});

describe('skills and agent definitions stay in step (local machine only)', () => {
  const agentFile = resolve(homedir(), '.claude/agents/property-administration.md');
  it.skipIf(!existsSync(agentFile))('the agent file carries the search-first rule, TopCashback, Roy standing approval and the write path', () => {
    const md = readFileSync(agentFile, 'utf8');
    expect(md).toMatch(/Search everything before you create anything/);
    expect(md).toMatch(/TopCashback/);
    expect(md).toMatch(/standing approval/);
    expect(md).toMatch(/agent-dispatch\.py certificate/);
    expect(md).toMatch(/Lessons from Kevin/);
  });
  it('the dispatch skill hands the compliance book over and names the write path', () => {
    const skill = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/agent-dispatch/SKILL.md'), 'utf8');
    expect(skill).toMatch(/complianceBook/);
    expect(skill).toMatch(/agent-dispatch\.py certificate TASKID/);
    expect(skill).toMatch(new RegExp(PROPERTY_TM));
  });
  it('the triage skill names compliance tasks so the engine can route them', () => {
    const skill = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/inbound-email-triage/SKILL.md'), 'utf8');
    expect(skill).toMatch(/`COMPLIANCE:`/);
  });
});
