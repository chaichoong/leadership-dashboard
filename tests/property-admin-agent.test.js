// Guards the Property Administration agent's dispatch wiring (build session,
// 2 Sep 2026; chain map approved by Kevin at the agent gate the same day;
// rebuilt after the independent review the same afternoon).
//
// WHAT THIS EXISTS FOR
// The agent only works if these stay true at once:
//   1. Its Team Members record is a dispatchable role agent (ROLE_AGENTS) and
//      the roster twins in follow-up.html know it owns tasks.
//   2. Compliance matters route to it deterministically — certificates,
//      licences, landlord insurance, inspections — AFTER the creditor lane
//      and BEFORE the generic Response route; repairs never do (they stay
//      Roy's same-hour lane, Kevin's ruling); the law, money owed and bare
//      words like "certificate" or "compliance" never trip it (an SSL
//      certificate and a GDPR review did, in the review pass).
//   3. The fresh lane is inbound-or-COMPLIANCE-named, like the creditor
//      lane's inbound-only floor; the steal lane reaches any strategic agent
//      as well as Response, because the Roy lane it replaced did.
//   4. While its register row is not Built/Live (Kevin's pause lever) no
//      task is marked for it AND the engine mints no task for it.
//   5. The compliance book maths: a block's EICRs count per apartment, a live
//      certificate beats a lapsed one, a held type becomes a requirement, an
//      inactive property never counts, and a renewal fires only inside the
//      window (plus a 7-day lapse grace).
//   6. The quarterly review gates on the first Monday of Jan/Apr/Jul/Oct IN
//      CODE, London time — never a cron day-of-week.
//   7. `certificate` is the ONE write path: refuses an incomplete filing,
//      checks every id, and LINKS an existing row instead of refusing it;
//      verify enforces it on engine-raised renewals only, and accepts a
//      handover in the same run.
// Each check imports or executes the real module — never a copy.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { makeRunPy } from './helpers/dispatch-py.js';

const ROOT = resolve(__dirname, '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const src = readFileSync(DISPATCH, 'utf8');

const PROPERTY_TM = 'recwWvBju2ycB63i4';
const PROPERTY_ROW = 'recZBW9tjcx9WJw4q';
const RESPONSE_TM = 'recJ8J8idWE8d97tH';
const CREDITOR_TM = 'recjh6mmaF8KJW8t3';
const OPERATIONS_TM = 'recRStFWWEyHgOD6t';   // a strategic agent

const pyEval = makeRunPy(DISPATCH);
const T = (over) => ({ creditor: false, inboundTask: false, name: 'x',
                       tier2Correspondence: false, property: '', ...over });
const ALL_LIVE = {
  [PROPERTY_TM]: { dispatchable: true },
  [RESPONSE_TM]: { dispatchable: true },
  [CREDITOR_TM]: { dispatchable: true },
};
const route = (fn, ...args) => pyEval(`mod.${fn}(*arg)`, args);
const cli = (...args) => {
  try {
    return execFileSync('python3', [DISPATCH, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return String(e.stderr || e.stdout); }
};
const P = (over) => ({ managerEmail: '', postcode: '', manager: '', units: [], active: true, ...over });
const C = (over) => ({ unitIds: [], status: 'Active', hasFile: true, taskIds: [], ...over });

describe('roster wiring', () => {
  it('the Property Administration agent is a dispatchable role agent with the right identities', () => {
    const out = pyEval(`{
      "inRole": ${JSON.stringify(PROPERTY_TM)} in mod.ROLE_AGENTS,
      "agent": mod.ROLE_AGENTS[${JSON.stringify(PROPERTY_TM)}]["agent"],
      "dispatch": mod.ROLE_AGENTS[${JSON.stringify(PROPERTY_TM)}].get("dispatch", True),
      "rec": mod.PROPERTY_REC_ID,
      "row": mod.PROPERTY_REGISTER_ROW,
      "scoreName": mod.SCORE_AGENT_NAMES.get("property")}`);
    expect(out).toEqual({ inRole: true, agent: 'property-administration', dispatch: true,
                          rec: PROPERTY_TM, row: PROPERTY_ROW, scoreName: 'Property Administration' });
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
    'COMPLIANCE: EPC renewal due 2026-10-01 - 18 Siddows Avenue': true,
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
    // bare words are not the lane (review finding: these were routed here)
    'Renew SSL certificate for runpreneur.org.uk within 30 days': false,
    'GDPR compliance review for OD client onboarding': false,
    'Professional indemnity insurance quote for Operations Director': false,
    'Certificate of incorporation for OD Ltd': false,
  };
  it('matches the NAMED compliance items and vetoes repairs, money owed, the law and bare words', () => {
    const out = pyEval('{c: bool(mod.property_match(c, "", "")) for c in arg}', Object.keys(cases));
    const wrong = Object.entries(cases).filter(([k, v]) => v !== out[k]).map(([k]) => k);
    expect(wrong).toEqual([]);
  });
  it('a veto in the BODY still vetoes, and both lanes share one matcher', () => {
    expect(pyEval('mod.property_match("Gas safety certificate - 22 Newton Street", "solicitor letter attached", "")')).toBe('');
    expect(pyEval('mod.property_match("Gas safety certificate - 22 Newton Street", "", "")')).not.toBe('');
    expect(pyEval('[mod.roy_match.__code__.co_names, mod.property_match.__code__.co_names]').flat()).toContain('lane_match');
  });
});

describe('queue routing and the pause lever (real AUTO_ROUTES)', () => {
  it('fresh: inbound or COMPLIANCE-named compliance tasks go to the agent; other CEO-lane text waits for judgement', () => {
    expect(route('auto_route_fresh', T({ property: 'eicr', inboundTask: true }), ALL_LIVE)).toBe(PROPERTY_TM);
    expect(route('auto_route_fresh', T({ property: 'eicr', name: 'COMPLIANCE: EICR renewal due 2026-10-01 - X' }), ALL_LIVE)).toBe(PROPERTY_TM);
    expect(route('auto_route_fresh', T({ property: 'eicr', name: 'Plan the EICR programme for Q4' }), ALL_LIVE)).toBe(null);
  });
  it('the property lane beats the Response route and loses to the creditor lane', () => {
    expect(route('auto_route_fresh', T({ property: 'insurance', creditor: true, inboundTask: true }), ALL_LIVE)).toBe(CREDITOR_TM);
    expect(route('auto_route_fresh', T({ inboundTask: true }), ALL_LIVE)).toBe(RESPONSE_TM);
  });
  it('steals a compliance task off the Response agent AND off a strategic agent, never off another role agent', () => {
    expect(route('auto_route_steal', T({ property: 'eicr' }), RESPONSE_TM, ALL_LIVE)).toBe(PROPERTY_TM);
    expect(route('auto_route_steal', T({ property: 'eicr' }), OPERATIONS_TM, ALL_LIVE)).toBe(PROPERTY_TM);
    expect(route('auto_route_steal', T({ property: 'eicr' }), CREDITOR_TM, ALL_LIVE)).toBe(null);
  });
  it('a paused register row stops the lane: no autoTarget, and the queue never marks a task while the agent is paused', () => {
    const paused = { ...ALL_LIVE, [PROPERTY_TM]: { dispatchable: false } };
    // An inbound compliance task falls through to the generalist Response
    // lane exactly as before the agent existed; a non-inbound one waits for
    // the CEO's judgement.
    expect(route('auto_route_fresh', T({ property: 'eicr', inboundTask: true }), paused)).toBe(RESPONSE_TM);
    expect(route('auto_route_fresh', T({ property: 'eicr', name: 'COMPLIANCE: EICR renewal due 2026-10-01 - X' }), paused)).toBe(null);
    // build_queue needs Airtable, so the mark rule is pinned at source: the
    // mark is only ever computed when property_ok, and property_ok also
    // requires the book to have been read.
    expect(src).toMatch(/t\["property"\] = \(""\s+if \(t\["tier1"\] or t\["creditor"\] or not property_ok\)/);
    expect(src).toMatch(/compliance_book_error = str\(e\)\[:200\]\s+property_ok = False/);
    expect(src).toMatch(/or t\["property"\]\)\s+else roy_match/);
  });
  it('the engine mints no task for a paused agent (renewals and the quarterly review both check the lever)', () => {
    const out = pyEval(`__import__("subprocess").run(["python3", "-c", arg], capture_output=True, text=True).stdout`, `
import importlib.util, json, io, contextlib
spec = importlib.util.spec_from_file_location("d", ${JSON.stringify(DISPATCH)}); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
props = [{"id":"p1","name":"A","short":"A","kind":"Single Let ","manager":"","managerEmail":"","postcode":"","required":["EICR"],"units":[],"active":True}]
certs = [{"id":"c1","type":"EICR","propertyIds":["p1"],"unitIds":[],"status":"Active","renewalDate":"2026-09-20","hasFile":True,"taskIds":[]}]
m.compliance_book_pages = lambda refresh=False: m.compliance_pages(props, certs, "2026-09-02")
m.today_london = lambda: "2026-09-02"
m.fetch_role_roster = lambda: {m.PROPERTY_REC_ID: {"dispatchable": False}}
m.load_score_state = lambda path: {}      # never read this Mac's real state files
posted = []
m._request = lambda *a, **k: posted.append(a) or {}
m.query_tasks = lambda *a, **k: []
buf = io.StringIO()
with contextlib.redirect_stdout(buf): m.ensure_renewal_tasks()
m.datetime = type("D", (), {"now": staticmethod(lambda tz=None: __import__("datetime").datetime(2026, 10, 5, 8, 0, tzinfo=tz)), "strptime": __import__("datetime").datetime.strptime})
with contextlib.redirect_stdout(buf): m.ensure_quarterly_review()
print(json.dumps({"posted": len(posted), "out": buf.getvalue()}))
`);
    const parsed = JSON.parse(out);
    expect(parsed.posted).toBe(0);
    expect(parsed.out).toMatch(/"paused": true/);
    expect(parsed.out).toMatch(/"quarterlyReview": "2026-Q4"/);
  });
  it('the queue JSON carries the compliance book and its read error, and verify alarms on the error', () => {
    expect(src).toMatch(/"complianceBook": compliance_book,/);
    expect(src).toMatch(/"complianceBookError": compliance_book_error,/);
    expect(src).toMatch(/report\.get\("complianceBookError"\)/);
  });
});

describe('the compliance book (approved chain, 2 Sep 2026)', () => {
  it('the offline selftest passes against the real functions', () => {
    expect(cli('score', '--selftest')).toMatch(/selftest-property: all checks passed/);
  });
  it('a block counts its EICRs per apartment, a live certificate beats a lapsed one, a block-wide certificate covers every apartment, and a held type becomes required', () => {
    const props = [P({ id: 'd', name: 'D', short: 'D', kind: 'Block', units: ['u1', 'u2', 'u3'],
                       required: ['Landlord Insurance', 'EICR', 'EPC', 'Fire Alarm Cert', 'Emergency Lighting'] })];
    const certs = [
      C({ id: 'live', type: 'EICR', propertyIds: ['d'], unitIds: ['u1'], renewalDate: '2027-03-08' }),
      C({ id: 'lapsed-later', type: 'EICR', propertyIds: ['d'], unitIds: ['u2'], status: 'Expired', renewalDate: '2026-12-01' }),
      C({ id: 'live-earlier', type: 'EICR', propertyIds: ['d'], unitIds: ['u2'], renewalDate: '2026-11-01' }),
      C({ id: 'ins', type: 'Landlord Insurance', propertyIds: ['d'], renewalDate: '2027-01-01' }),
      C({ id: 'gsc-old', type: 'GSC', propertyIds: ['d'], unitIds: ['u1'], renewalDate: '2025-01-01' }),
      C({ id: 'epc-wide', type: 'EPC', propertyIds: ['d'], renewalDate: '2030-01-01' }),
      C({ id: 'fa-undated', type: 'Fire Alarm Cert', propertyIds: ['d'], status: 'Expired', renewalDate: '' }),
    ];
    const out = pyEval('(lambda pages: [pages[0]["units"], sorted((i["type"], i.get("unit"), i["state"]) for i in pages[0]["issues"]), pages[0]["required"], pages[0]["holds"]])(mod.compliance_pages(arg[0], arg[1], "2026-09-02", {"u1": "Unit 1 – D"}))', [props, certs]);
    expect(out[0].u2.EICR.certificate).toBe('live-earlier');
    expect(out[0].u1.EICR.state).toBe('in date');
    expect(out[0].u1.name).toBe('Unit 1 – D');
    expect(out[0].u3.EPC.certificate).toBe('epc-wide');
    expect(out[3]['Fire Alarm Cert'].state).toBe('expired');
    expect(out[1]).toEqual([
      ['EICR', 'u3', 'missing'], ['Emergency Lighting', null, 'missing'], ['Fire Alarm Cert', null, 'expired'],
      ['GSC', 'u1', 'expired'], ['GSC', 'u2', 'missing'], ['GSC', 'u3', 'missing'],
    ]);
    expect(out[2]).toContain('GSC');
  });
  it('a non-block property carries no per-unit slots, and its unit-linked certificates fold into the property', () => {
    const props = [P({ id: 'h', name: 'H', short: 'H', kind: 'HMO', units: ['u1', 'u2'], required: ['EICR'] })];
    const certs = [C({ id: 'e', type: 'EICR', propertyIds: ['h'], unitIds: ['u1'], renewalDate: '2030-01-01' })];
    const out = pyEval('(lambda p: [p["units"], p["holds"]["EICR"]["certificate"]])(mod.compliance_pages(arg[0], arg[1], "2026-09-02")[0])', [props, certs]);
    expect(out).toEqual([{}, 'e']);
  });
  it('the reading counts expired, missing and undated as outstanding, and inactive properties never count', () => {
    const props = [
      P({ id: 'p1', name: 'A', short: 'A', kind: 'Single Let ', required: ['Landlord Insurance', 'EICR'] }),
      P({ id: 'p2', name: 'B', short: 'B', kind: 'Single Let ', required: ['Landlord Insurance', 'EICR'], active: false }),
    ];
    const certs = [C({ id: 'c1', type: 'EICR', propertyIds: ['p1'], renewalDate: '2020-01-01' })];
    const out = pyEval('mod.compliance_reading(mod.compliance_pages(arg[0], arg[1], "2026-09-02"))', [props, certs]);
    expect(out[1]).toEqual({ outstanding: 2, expired: 1, missing: 1, undated: 0, dueSoon: 0 });
    expect(out[0]).toBe('2 outstanding (1 expired, 1 missing, 0 undated); 0 due in 30 days');
  });
  it('a renewal fires inside the 30-day window and up to 7 days after a lapse, per apartment in a block, never for a missing item', () => {
    const props = [P({ id: 'p1', name: 'A', short: 'A', kind: 'Block', units: ['u1'], required: ['EICR', 'GSC'] })];
    const certs = [
      C({ id: 'in', type: 'GSC', propertyIds: ['p1'], unitIds: ['u1'], renewalDate: '2026-09-20' }),
      C({ id: 'lapsed', type: 'EICR', propertyIds: ['p1'], unitIds: ['u1'], renewalDate: '2026-08-30' }),
      C({ id: 'old', type: 'Landlord Insurance', propertyIds: ['p1'], renewalDate: '2026-08-01' }),
      C({ id: 'far', type: 'EPC', propertyIds: ['p1'], renewalDate: '2027-09-20' }),
    ];
    const due = pyEval('[(d["certificate"], d["unit"], d["days"]) for d in mod.renewals_due(mod.compliance_pages(arg[0], arg[1], "2026-09-02"), "2026-09-02")]', [props, certs]);
    expect(due).toEqual([['lapsed', 'u1', -3], ['in', 'u1', 18]]);
  });
  it('a block-wide certificate covering many apartments is ONE renewal, named for the block', () => {
    const props = [P({ id: 'p1', name: 'A', short: 'A', kind: 'Block', units: ['u1', 'u2', 'u3'], required: ['EICR'] })];
    const certs = [C({ id: 'wide', type: 'EICR', propertyIds: ['p1'], renewalDate: '2026-09-20' })];
    const due = pyEval('[(d["certificate"], d["unit"], d["days"]) for d in mod.renewals_due(mod.compliance_pages(arg[0], arg[1], "2026-09-02"), "2026-09-02")]', [props, certs]);
    expect(due).toEqual([['wide', 'u1', 18]]);
  });
  it('the quarterly review gates on the first Monday of Jan/Apr/Jul/Oct IN CODE, London time', () => {
    const out = pyEval(`[mod.is_quarter_first_monday(mod.datetime(*d)) for d in arg]`,
      [[2026, 10, 5], [2026, 10, 12], [2026, 9, 7], [2027, 1, 4], [2026, 7, 6], [2026, 4, 6]]);
    expect(out).toEqual([true, false, false, true, true, true]);
    expect(pyEval('mod.quarter_label(mod.datetime(2026, 10, 5))')).toBe('2026-Q4');
    expect(src).not.toMatch(/quarterly[^\n]*cron/i);
  });
  it('score runs the property reading and both engine-raised triggers, and the selftest tuple carries the property maths', () => {
    const steps = pyEval('[s[0] for s in mod.SCORE_STEPS]');
    expect(steps).toEqual(expect.arrayContaining(['property', 'renewals', 'quarterly-review']));
    expect(pyEval('[t.__name__ for t in mod.SCORE_SELFTESTS]')).toContain('property_selftest');
  });
  it('every engine-raised task goes through the one raise_engine_task shape', () => {
    const body = src.slice(src.indexOf('def ensure_weekly_review'), src.indexOf('SCORE_STEPS = ('));
    expect(body).not.toMatch(/_request\("POST", f"\/\{TASKS\}"/);
    expect((body.match(/raise_engine_task\(/g) || []).length).toBeGreaterThanOrEqual(5);
  });
});

describe('the certificate write path and its gate', () => {
  it('refuses a missing flag, a bad type, a bad date and a missing document BEFORE touching Airtable', () => {
    expect(cli('certificate', 'recX', '--property', 'recP', '--type', 'GSC', '--renewal', '2027-01-01')).toMatch(/required: --file/);
    expect(cli('certificate', 'recX', '--property', 'recP', '--type', 'Nonsense', '--renewal', '2027-01-01', '--file', '/nonexistent.pdf')).toMatch(/--type must be one of/);
    expect(cli('certificate', 'recX', '--property', 'recP', '--type', 'GSC', '--renewal', 'next year', '--file', '/nonexistent.pdf')).toMatch(/--renewal must be YYYY-MM-DD/);
    expect(cli('certificate', 'recX', '--property', 'recP', '--type', 'GSC', '--renewal', '2027-01-01', '--file', '/nonexistent.pdf')).toMatch(/no such document to file/);
  });
  it('checks the task, the property and the unit are real records before any write (typecast would mint phantoms)', () => {
    const body = src.slice(src.indexOf('def cmd_certificate'), src.indexOf('def property_selftest'));
    expect(body.indexOf('get_task(args.task)')).toBeGreaterThan(-1);
    expect(body.indexOf('get_task(args.task)')).toBeLessThan(body.indexOf('_request("POST"'));
    expect(body).toMatch(/args\.unit not in props\[args\.property\]\["units"\]/);
  });
  it('an existing row is LINKED, not refused, and the twin key respects the unit', () => {
    const certs = [
      C({ id: 'd1', type: 'EICR', propertyIds: ['pD'], unitIds: ['u1'], renewalDate: '2027-03-08' }),
      C({ id: 'p0', type: 'EPC', propertyIds: ['pD'], renewalDate: '2030-01-01' }),
    ];
    const out = pyEval(`[
      (mod.find_certificate_twin(arg, "pD", "EICR", "2027-03-08", "u1") or {}).get("id"),
      mod.find_certificate_twin(arg, "pD", "EICR", "2027-03-08", "u2"),
      mod.find_certificate_twin(arg, "pD", "EICR", "2027-03-08", None),
      (mod.find_certificate_twin(arg, "pD", "EPC", "2030-01-01", None) or {}).get("id")]`, certs);
    expect(out).toEqual(['d1', null, null, 'p0']);
    const body = src.slice(src.indexOf('def cmd_certificate'), src.indexOf('def property_selftest'));
    // the file goes on BEFORE the task link, and notes append rather than replace
    const twinPath = body.slice(body.indexOf('if twin:'), body.indexOf('else:', body.indexOf('if twin:')));
    expect(twinPath.indexOf('upload_file(twin["id"]')).toBeLessThan(twinPath.indexOf('_request("PATCH"'));
    expect(twinPath).toMatch(/\(prior \+ "\\n" \+ line\) if prior else line/);
  });
  it('a failed rollback delete is NAMED, never swallowed', () => {
    const body = src.slice(src.indexOf('def cmd_certificate'), src.indexOf('def property_selftest'));
    expect(body).toMatch(/upload failed AND the rollback delete failed/);
  });
  it('the upload shape is shared with task attachments (one uploader, two callers)', () => {
    expect(src).toMatch(/def upload_file\(record_id, field_id, path\)/);
    expect(src).toMatch(/return upload_file\(task_id, AF\["attachments"\], path\)/);
    expect(src).toMatch(/upload_file\(row_id, CERT_FIELDS\["attachments"\]/);
  });
  it('verify gates ENGINE-RAISED renewals only (the description mark, not the name prefix), and only a row WITH its document counts', () => {
    const gate = src.slice(src.indexOf('compliance_closes = []'), src.indexOf('if problems:', src.indexOf('THE COMPLIANCE-BOOK GATE')));
    expect(gate).toMatch(/ENGINE_RENEWAL_MARK in str\(live\["description"\]/);
    expect(gate).not.toMatch(/startswith\(COMPLIANCE_TASK_PREFIX\)/);
    expect(gate).toMatch(/if c\["hasFile"\] for tid in c\["taskIds"\]/);
    expect(gate).not.toMatch(/handed = \{/);
    // and the engine stamps the mark on every renewal it raises
    expect(src).toMatch(/f"PROPERTY COMPLIANCE — \{ENGINE_RENEWAL_MARK\}/);
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
    expect(md).toMatch(/January, April, July, October/);
    expect(md).toMatch(/Lessons from Kevin/);
  });
  it('the dispatch skill hands the compliance book over, names the write path, and copies the book error into the report', () => {
    const skill = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/agent-dispatch/SKILL.md'), 'utf8');
    expect(skill).toMatch(/complianceBook/);
    expect(skill).toMatch(/agent-dispatch\.py certificate TASKID/);
    expect(skill).toMatch(/"complianceBookError": <copied VERBATIM/);
    expect(skill).toMatch(new RegExp(PROPERTY_TM));
    expect(skill).toMatch(/Property Administration agent's outstanding-issues reading/);
  });
  it('the triage skill names compliance tasks so the engine can route them', () => {
    const skill = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/inbound-email-triage/SKILL.md'), 'utf8');
    expect(skill).toMatch(/`COMPLIANCE:`/);
  });
});
