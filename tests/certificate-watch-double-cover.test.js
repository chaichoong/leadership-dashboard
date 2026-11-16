import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Two live landlord policies on one house (Kevin, 3 Nov 2026): cancel the duplicate and keep
// the cheapest, on every house with a duplicate, not only the one in hand. He named three
// houses; on 16 Nov 2026 the book still held two in-date policies on each of the three.
//
// These drive the REAL functions in scripts/certificate_watch.py (insurance_doubles,
// judge_doubles, double_task_fields, insurance_cost_rows, cmd_daily) and the REAL live rule in
// scripts/cost-record.py. Every Airtable read and the task gate are stubbed, and the network
// and subprocesses are blocked before anything loads, so no test can reach Airtable. Every
// house, insurer, policy number and amount here is invented: this repo is public.
//
// CERT_WATCH_SCRIPTS points the suite at another copy of certificate_watch.py (default: this
// repo's scripts folder), so the suite can be run against origin/main's copy to prove each
// test fails there. cost-record.py is always this repo's: it is not under test.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const WATCH_DIR = process.env.CERT_WATCH_SCRIPTS ? resolve(process.env.CERT_WATCH_SCRIPTS) : SCRIPTS;
const WATCH = resolve(WATCH_DIR, 'certificate_watch.py');
const COST_RECORD = resolve(SCRIPTS, 'cost-record.py');

function py(snippet) {
  const script = `
import socket, subprocess, urllib.request
def _blocked(*a, **k):
    raise RuntimeError('network and subprocesses are blocked in this test')
urllib.request.urlopen = _blocked
socket.create_connection = _blocked
socket.socket.connect = _blocked
subprocess.run = subprocess.Popen = subprocess.call = subprocess.check_output = _blocked
import importlib.util, json, sys, types, io, contextlib
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m
cw = load('cw_double_cover', ${JSON.stringify(WATCH)})
CR = load('cr_double_cover', ${JSON.stringify(COST_RECORD)})
TODAY = '2026-11-16'
A, B, C, D = 'recPROPEXAMPLE007', 'recPROPSAMPLE0012', 'recPROPTESTMEWS03', 'recPROPMAPLECOURT'
PAGES = [{'id': A, 'short': '7 Example Road', 'name': '7 Example Road', 'active': True},
         {'id': B, 'short': '12 Sample Street', 'name': '12 Sample Street', 'active': True},
         {'id': C, 'short': '3 Test Mews', 'name': '3 Test Mews', 'active': True},
         {'id': D, 'short': 'Maple Court', 'name': 'Maple Court', 'active': True}]
INS, PERSONAL, OTHER = 'recSUBINSURANCE01', 'recSUBPERSONALINS', 'recSUBCOMPLIANCE1'
def pol(rid, pid, renewal, notes='', status='Active', units=()):
    return {'id': rid, 'type': 'Landlord Insurance', 'propertyIds': [pid], 'unitIds': list(units), 'status': status,
            'renewalDate': renewal, 'notes': notes, 'hasFile': True, 'taskIds': [], 'created': '2026-10-01'}
def cost(cid, name, props, expected=15.0, active=True, sub=INS, end='2027-09-30', status='In Payment', first=''):
    return {'id': cid, 'name': name, 'expected': expected, 'frequency': 'Monthly', 'payStatus': status,
            'active': active, 'propertyIds': list(props), 'subCategoryIds': [sub], 'endDate': end, 'firstDate': first}
def doubles(policies, costs=None, today=TODAY):
    ds, counts = cw.insurance_doubles(PAGES, policies, costs, [INS], today)
    return ds, counts
def houses(policies, costs=None, today=TODAY):
    return [d['property'] for d in doubles(policies, costs, today)[0]]
${snippet}
`;
  const lines = execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

describe('a house covered by two live landlord policies at once is found', () => {
  it('two in-date book rows on one house are one double, each named with its premium', () => {
    const r = py(`
ds, counts = doubles([pol('recROWACME0000001', A, '2027-07-16', 'Acme Insurance, policy EX-100200, premium £210.40/yr'),
                      pol('recROWMUTUAL00002', A, '2027-10-04', 'Example Mutual, policy MU-55, premium £175.10/yr'),
                      pol('recROWSAMPLE0003', B, '2027-03-02', 'Sample Underwriting, premium £120/yr')])
print(json.dumps({'ds': ds, 'counts': counts}))`);
    expect(r.ds.map((d) => d.property)).toEqual(['7 Example Road']);
    expect(r.ds[0]).toMatchObject({ bookDouble: true, costDouble: false, key: 'CERTWATCH-DOUBLE recPROPEXAMPLE007' });
    expect(r.ds[0].policies.map((p) => [p.id, p.premium])).toEqual([['recROWACME0000001', 210.4], ['recROWMUTUAL00002', 175.1]]);
    expect(r.ds[0].policies[0].note).toContain('Acme Insurance');
    expect(r.counts).toMatchObject({ insuredHouses: 2, policiesInForce: 3, costsRead: false });
  });

  it('two live insurance costs on one house are a double, each named with its Expected Cost', () => {
    const r = py(`
ds, counts = doubles([pol('recROWACME0000001', A, '2027-07-16')],
                     [cost('recCOSTACME000001', 'Acme Insurance - EX-100200 - 7 Example Road', [A], expected=17.25, end='2027-06-16'),
                      cost('recCOSTMUTUAL0002', 'Example Mutual - MU-55 - 7 Example Road', [A], expected=13.10, end='2027-09-30')])
print(json.dumps({'ds': ds, 'counts': counts}))`);
    expect(r.ds.map((d) => [d.property, d.bookDouble, d.costDouble])).toEqual([['7 Example Road', false, true]]);
    expect(r.ds[0].costs.map((c) => [c.id, c.expected, c.frequency])).toEqual([
      ['recCOSTACME000001', 17.25, 'Monthly'], ['recCOSTMUTUAL0002', 13.1, 'Monthly']]);
    expect(r.counts.liveInsuranceCosts).toBe(2);
  });
});

describe('what is not a second policy', () => {
  it('a block policy is one policy on each house: one cost on three houses and one book row per house', () => {
    const r = py(`
block = [pol('recROWBLOCK00000' + str(i), pid, '2027-08-26', 'Block policy BL-9, premium £60/yr for this house')
         for i, pid in enumerate((A, B, C))]
print(json.dumps(houses(block, [cost('recCOSTBLOCK00001', 'Premium finance - BL-9', [A, B, C], expected=48.0)])))`);
    expect(r).toEqual([]);
  });

  it("a block policy with one house's old single policy still live is a double on that house only", () => {
    const r = py(`
block = [cost('recCOSTBLOCK00001', 'Premium finance - BL-9', [A, B, C], expected=48.0, end='2027-08-26'),
         cost('recCOSTOLDSINGLE1', 'Acme Insurance - old single policy - 12 Sample Street', [B], expected=19.0, end='2027-02-02')]
print(json.dumps(houses([], block)))`);
    expect(r).toEqual(['12 Sample Street']);
  });

  it('a renewal filed before the old renewal date passes is not a double; control: overlapping covers are', () => {
    const r = py(`
renewal = [pol('recROWOLD00000001', A, '2026-11-20', 'premium £100/yr'), pol('recROWNEW00000002', A, '2027-11-19', 'premium £104/yr')]
overlap = [pol('recROWOLD00000001', A, '2026-11-20'), pol('recROWNEW00000002', A, '2027-06-30')]
print(json.dumps({'renewal': houses(renewal), 'overlap': houses(overlap)}))`);
    expect(r.renewal).toEqual([]);
    expect(r.overlap).toEqual(['7 Example Road']);
  });

  it('an expired row, or one marked Expired by hand (a cancelled policy keeps its old date), is not live', () => {
    const r = py(`
live = pol('recROWLIVE0000001', A, '2027-07-16')
print(json.dumps({'pastDate': houses([live, pol('recROWPAST0000002', A, '2026-10-27')]),
                  'markedExpired': houses([live, pol('recROWCANC0000003', A, '2027-10-04', status='Expired')]),
                  'control': houses([live, pol('recROWLIVE0000004', A, '2027-10-04')])}))`);
    expect(r).toEqual({ pastDate: [], markedExpired: [], control: ['7 Example Road'] });
  });

  it("per-apartment rows are compared only with their own apartment's", () => {
    const r = py(`
print(json.dumps({'twoFlats': houses([pol('recROWFLAT1000001', D, '2027-09-11', units=['recUNITFLAT000001']),
                                      pol('recROWFLAT2000002', D, '2027-10-01', units=['recUNITFLAT000002'])]),
                  'oneFlatTwice': houses([pol('recROWFLAT1000001', D, '2027-09-11', units=['recUNITFLAT000001']),
                                          pol('recROWFLAT1000003', D, '2027-10-01', units=['recUNITFLAT000001'])])}))`);
    expect(r).toEqual({ twoFlats: [], oneFlatTwice: ['Maple Court'] });
  });

  it('a cost that is not live, is past its End Date, is outside the Insurance sub-category or is car insurance is no second landlord policy', () => {
    const r = py(`
keep = cost('recCOSTKEEP000001', 'Acme Insurance - 7 Example Road', [A], end='2027-09-30')
cases = {
  'inactive': cost('recCOSTGONE000002', 'Old insurer - 7 Example Road', [A], active=False),
  'pastEndDate': cost('recCOSTENDED00003', 'Old insurer - 7 Example Road', [A], end='2026-10-01'),
  'otherSubCategory': cost('recCOSTGAS0000004', 'Gas safety plan - 7 Example Road', [A], sub=OTHER),
  'personalSubCategory': cost('recCOSTHOME000005', 'Home insurance - 7 Example Road', [A], sub=PERSONAL),
  'carInsurance': cost('recCOSTCAR0000006', 'Car insurance - 7 Example Road', [A]),
}
out = {k: houses([], [keep, c]) for k, c in cases.items()}
out['control'] = houses([], [keep, cost('recCOSTLIVE000007', 'Example Mutual - 7 Example Road', [A], end='2027-06-30')])
ds, counts = doubles([], [keep, cases['pastEndDate'], cases['carInsurance']])
out['listed'] = [counts['endedCostsLeftToEndedCheck'], counts['notLandlordInsurance']]
print(json.dumps(out))`);
    expect(r.inactive).toEqual([]);
    expect(r.pastEndDate).toEqual([]);
    expect(r.otherSubCategory).toEqual([]);
    expect(r.personalSubCategory).toEqual([]);
    expect(r.carInsurance).toEqual([]);
    expect(r.control).toEqual(['7 Example Road']);
    // Left out, never dropped: each is listed in the run's output.
    expect(r.listed).toEqual([['recCOSTENDED00003'], ['Car insurance - 7 Example Road']]);
  });
});

// Costs rows as the API returns them by field id, using cost-record.py's own ids.
const COST_ROWS = `
def crow(cid, name, props, status='In Payment', inactive=False, sub=INS, expected=15.0, end='2027-09-30'):
    f = {CR.COST_NAME: name, CR.COST_EXPECTED: expected, CR.COST_FREQUENCY: 'Monthly', CR.COST_PAY_STATUS: status,
         CR.COST_PROPERTY: list(props), CR.COST_SUBCAT: [sub], CR.COST_END: end}
    if inactive:
        f[CR.COST_INACTIVE] = True
    return {'id': cid, 'fields': f}
SUBCAT_NAME = 'fldO4BTJhFv5EsN6i'   # js/config.js SUBCAT.name
SUBS = [{'id': INS, 'fields': {SUBCAT_NAME: 'Insurance'}}, {'id': PERSONAL, 'fields': {SUBCAT_NAME: 'Personal Insurance'}},
        {'id': OTHER, 'fields': {SUBCAT_NAME: 'COGS Property Compliance'}}]
`;

describe("the Costs read uses cost-record.py's live rule and the sub-category NAMED Insurance", () => {
  const read = (subs, costs) => py(`${COST_ROWS}
SERVE = {CR.T_SUBCATEGORIES: ${subs}, CR.T_COSTS: ${costs}}
fake = types.SimpleNamespace(links=lambda v: list(v or []), _cost_record=lambda: CR,
                             query_records=lambda table, formula=None, fields=None, max_records=None: SERVE[table])
try:
    costs, ids = cw.insurance_cost_rows(fake)
    print(json.dumps({'live': {c['id']: c['active'] for c in costs}, 'ids': sorted(ids)}))
except RuntimeError as exc:
    print(json.dumps({'err': str(exc)}))`);

  it('In Payment and Overdue are live (isCostActive); Paused and a ticked Inactive are not; only "Insurance" is the sub-category', () => {
    const r = read('SUBS', `[crow('recCOSTPAYING0001', 'a', [A]), crow('recCOSTOVERDUE002', 'b', [A], status='Overdue'),
                             crow('recCOSTPAUSED0003', 'c', [A], status='Paused'),
                             crow('recCOSTTICKED0004', 'd', [A], inactive=True)]`);
    expect(r.live).toEqual({ recCOSTPAYING0001: true, recCOSTOVERDUE002: true, recCOSTPAUSED0003: false, recCOSTTICKED0004: false });
    expect(r.ids).toEqual(['recSUBINSURANCE01']);
  });
  it('a renamed sub-category is NOT CHECKED, never zero doubles', () => {
    const r = read(`[dict(s, fields={SUBCAT_NAME: 'Insurance (business)'}) if s['id'] == INS else s for s in SUBS]`, `[crow('recCOSTPAYING0001', 'a', [A])]`);
    expect(r.err).toContain("are named 'Insurance' (exactly 1 expected)");
  });
  it('an empty sub-category read and a Costs read with nothing live are NOT CHECKED', () => {
    expect(read('[]', `[crow('recCOSTPAYING0001', 'a', [A])]`).err).toContain('sub-category read returned no rows');
    expect(read('SUBS', '[]').err).toContain('0 costs read and none is live');
  });
});

describe('one open task at a time, per house', () => {
  it('an open task carrying the house key covers it; a task closed inside 14 days holds it back; after that it comes back', () => {
    const r = py(`
ds, _ = doubles([pol('recROWACME0000001', A, '2027-07-16'), pol('recROWMUTUAL00002', A, '2027-10-04')])
key = cw.DOUBLE_KEY % A
open_t = {'id': 'recTASKOPEN000001', 'name': 'INSURANCE: two live policies on 7 Example Road - keep the cheapest',
          'description': 'x\\n' + key, 'status': 'Today'}
other = dict(open_t, id='recTASKOTHER00002', description='x\\n' + cw.DOUBLE_KEY % B)
closed = dict(open_t, status='Completed', completed='2026-11-10')
old = dict(closed, completed='2026-10-20')
out = {}
for label, opens, keyed in (('open', [open_t], [open_t]), ('otherHouseOpen', [other], [other]),
                            ('closedRecently', [], [closed]), ('closedLongAgo', [], [old])):
    cov, held, found = cw.judge_doubles(ds, opens, keyed, TODAY)
    out[label] = {'covered': len(cov), 'held': [h['comesBack'] for h in held], 'found': len(found)}
print(json.dumps(out))`);
    expect(r.open).toEqual({ covered: 1, held: [], found: 0 });
    expect(r.otherHouseOpen).toEqual({ covered: 0, held: [], found: 1 });
    expect(r.closedRecently).toEqual({ covered: 0, held: ['2026-11-25'], found: 0 });
    expect(r.closedLongAgo).toEqual({ covered: 0, held: [], found: 1 });
  });
});

describe('the task it raises', () => {
  it('asks for ONE card proposing which to cancel, never cancels, names both policies and premiums, and carries every house key', () => {
    const r = py(`
ds, counts = doubles([pol('recROWACME0000001', A, '2027-07-16', 'Acme Insurance, premium £210.40/yr'),
                      pol('recROWMUTUAL00002', A, '2027-10-04', 'Example Mutual, premium £175.10/yr')],
                     [cost('recCOSTB1000000001', 'Acme Insurance - 12 Sample Street', [B], expected=16.0, end='2027-06-16'),
                      cost('recCOSTB2000000002', 'Example Mutual - 12 Sample Street', [B], expected=12.5, end='2027-09-30')])
f = cw.double_task_fields(ds, TODAY, ['Premium finance with no house'])
print(json.dumps({'name': f[cw.TF['name']], 'desc': f[cw.TF['desc']], 'props': f[cw.TF['properties']],
                  'team': f[cw.TF['team']], 'status': f[cw.TF['status']]}))`);
    expect(r.name).toBe('INSURANCE: two live policies on 2 houses - keep the cheapest');
    expect(r.props).toEqual(['recPROPSAMPLE0012', 'recPROPEXAMPLE007']);
    expect(r.team).toEqual(['recwWvBju2ycB63i4']);
    expect(r.status).toBe('Today');
    for (const s of ['row recROWACME0000001', 'premium £210.40/yr', 'row recROWMUTUAL00002', 'premium £175.10/yr',
      'cost recCOSTB1000000001', 'Expected Cost £16.00 Monthly', 'Expected Cost £12.50 Monthly',
      'Put ONE card to Kevin', 'the cheapest', "Cancelling is Kevin's (Level C)",
      'Nothing is cancelled, and no cancellation goes to an insurer, until he approves that card',
      'Premium finance with no house',
      'CERTWATCH-DOUBLE recPROPSAMPLE0012', 'CERTWATCH-DOUBLE recPROPEXAMPLE007']) {
      expect(r.desc).toContain(s);
    }
  });
});

// The whole daily pass, with the book, the reads and the gate stubbed. ROWS are what each
// table returns; the created task is fed back in on the second run.
const DAILY = `${COST_ROWS}
def run_daily(open_extra=(), costs_rows=None, subs=None, paused=False, apply=True, costs_raise=None):
    fake = types.SimpleNamespace()
    fake.AF = {'name': 'fN', 'description': 'fD', 'status': 'fS', 'completion': 'fC'}
    fake.CERT_FIELDS = {'type': 'cT', 'property': 'cP', 'renewal': 'cR', 'notes': 'cN'}
    fake.TASKS, fake.CERTIFICATES_TABLE = 'tblTASKS', 'tblCERTS'
    fake.links = lambda v: list(v or [])
    fake.today_london = lambda: TODAY
    fake.fetch_properties = lambda: [dict(p, kind='Single Let', manager='Property Portfolio') for p in PAGES]
    BOOK = [pol('recROWACME0000001', A, '2027-07-16'), pol('recROWMUTUAL00002', A, '2027-10-04'),
            pol('recROWSAMPLE00003', B, '2027-08-26'), pol('recROWTEST000004', C, '2027-08-26')]
    fake.fetch_certificates = lambda: BOOK
    holds = {'Landlord Insurance': {'renewalDate': '2027-07-16', 'certificate': 'recROWACME0000001'}}
    fake.compliance_book_pages = lambda: [dict(p, manager='Property Portfolio', issues=[], holds=holds, units={}, required=[])
                                          for p in PAGES]
    NOTES = {'recROWACME0000001': 'Acme Insurance, premium £210.40/yr', 'recROWMUTUAL00002': 'Example Mutual, premium £175.10/yr'}
    CERT_ROWS = [{'id': c['id'], 'fields': {'cT': 'Landlord Insurance', 'cP': c['propertyIds'], 'cR': c['renewalDate'],
                                            'cN': NOTES.get(c['id'], '')}} for c in BOOK]
    FILL = [{'id': 'recFILL%010d' % i, 'fields': {'fN': 'filler %d' % i}} for i in range(60)]
    OPEN = FILL + list(open_extra)
    KEYED = [r for r in OPEN if 'CERTWATCH-' in str(r['fields'].get('fD') or '')]
    COSTS = costs_rows if costs_rows is not None else [
        crow('recCOSTBLOCK00001', 'Premium finance - BL-9', [B, C], expected=48.0, end='2027-08-26'),
        crow('recCOSTACME000001', 'Acme Insurance - 7 Example Road', [A], expected=17.25, end='2027-06-16'),
        crow('recCOSTMUTUAL0002', 'Example Mutual - 7 Example Road', [A], status='Overdue', expected=13.10, end='2027-09-30')]
    SERVE = {'tblCERTS': CERT_ROWS, CR.T_SUBCATEGORIES: SUBS if subs is None else subs, CR.T_COSTS: COSTS}
    def qr(table, formula=None, fields=None, max_records=None):
        if table == 'tblTASKS':
            return OPEN if formula.startswith('AND({Status}') else KEYED
        if costs_raise is not None and table == CR.T_COSTS:
            raise costs_raise
        return SERVE.get(table, [])
    fake.query_records = qr
    fake.property_agent_paused = lambda: paused
    fake._cost_record = lambda: CR
    cw._AD['m'] = fake
    cw.plan_texts = lambda ad, today: ([], 'stubbed')
    made = []
    def gate(fields, apply):
        made.append(fields)
        return True, {'action': 'created', 'taskId': 'recNEWTASK%07d' % len(made)}
    cw.gate_create = gate
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = cw.cmd_daily(apply)
    out = buf.getvalue().strip().split('\\n')
    return code, made, json.loads('\\n'.join(out[:-1])), out[-1]
`;

describe('the daily run', () => {
  it('raises ONE task through the gate for the doubled house, and the next run, with it open, raises none', () => {
    const r = py(`${DAILY}
code1, made1, out1, last1 = run_daily()
task = made1[0]
row = {'id': 'recNEWTASK0000001', 'fields': {'fN': task[cw.TF['name']], 'fD': task[cw.TF['desc']], 'fS': 'Today',
                                            cw.TF['properties']: task[cw.TF['properties']]}}
code2, made2, out2, last2 = run_daily(open_extra=[row])
print(json.dumps({'code1': code1, 'names1': [m[cw.TF['name']] for m in made1], 'last1': last1,
                  'dc1': out1['doubleCover'], 'code2': code2, 'made2': len(made2), 'last2': last2,
                  'covered2': out2['doubleCover']['covered']}))`);
    expect(r.names1).toEqual(['INSURANCE: two live policies on 7 Example Road - keep the cheapest']);
    expect(r.code1).toBe(1);
    expect(r.dc1).toMatchObject({ houses: 1, insuredHouses: 3, policiesInForce: 4, liveInsuranceCosts: 3 });
    expect(r.dc1.withNoTask[0]).toMatchObject({ property: '7 Example Road', bookDouble: true, costDouble: true });
    expect(r.last1).toMatch(/^COMPLIANCE: 0 of 0 required items/);
    expect(r.last1).toContain('covered twice: 1 of 3 insured houses, 1 raised');
    expect(r.last1.length).toBeLessThanOrEqual(220);
    expect(r.made2).toBe(0);
    expect(r.covered2).toEqual([{ property: '7 Example Road', task: 'recNEWTASK0000001' }]);
    expect(r.code2).toBe(0);
    expect(r.last2).toContain('covered twice: 1 of 3 insured houses');
  });

  it('an empty Costs read while the book holds a policy in force is NOT CHECKED: exit 1, said in the last line, and the book side still raises', () => {
    const r = py(`${DAILY}
code, made, out, last = run_daily(costs_rows=[])
print(json.dumps({'code': code, 'names': [m[cw.TF['name']] for m in made], 'last': last,
                  'why': out['doubleCover'].get('costsNotChecked'), 'failures': [f['what'] for f in out['failures']]}))`);
    expect(r.code).toBe(1);
    expect(r.names).toEqual(['INSURANCE: two live policies on 7 Example Road - keep the cheapest']);
    expect(r.why).toContain('0 costs read and none is live');
    expect(r.failures).toEqual(['double cover']);
    expect(r.last).toContain('double cover: Costs NOT CHECKED');
  });

  it('a renamed Insurance sub-category is NOT CHECKED in the daily run too', () => {
    const r = py(`${DAILY}
code, made, out, last = run_daily(subs=[s for s in SUBS if s['id'] != INS])
print(json.dumps({'code': code, 'why': out['doubleCover'].get('costsNotChecked'), 'last': last}))`);
    expect(r.code).toBe(1);
    expect(r.why).toContain("0 of 2 sub-categories are named 'Insurance'");
    expect(r.last).toContain('Costs NOT CHECKED');
  });

  it('a paused agent gets nothing raised, and the run still exits 1 so the double is seen', () => {
    const r = py(`${DAILY}
code, made, out, last = run_daily(paused=True)
print(json.dumps({'code': code, 'made': len(made), 'task': out['doubleCover']['task']}))`);
    expect(r.made).toBe(0);
    expect(r.code).toBe(1);
    expect(r.task.gate).toContain('paused');
  });
});

describe('the last line', () => {
  it('keeps the double-cover part inside the 220 characters the Estate Status row shows, NOT CHECKED first', () => {
    const r = py(`
print(json.dumps([cw.watch_summary(1000, 1000, 1000, 1000, 100, 100, paused=True, dry_run=True, missed_total=10000,
                                   doubles={'houses': 30, 'insured': 300, 'raised': 30, 'notChecked': True}),
                  cw.watch_summary(2, 2, 0, 0, 1, 0, missed_total=50,
                                   doubles={'houses': 3, 'insured': 24, 'raised': 3, 'notChecked': False})]))`);
    expect(r[0].length).toBeLessThanOrEqual(220);
    expect(r[0]).toContain('double cover: Costs NOT CHECKED');
    expect(r[1]).toContain('covered twice: 3 of 24 insured houses, 3 raised');
    expect(r[1].length).toBeLessThanOrEqual(220);
  });
});

// Review of PR 951 (16 Nov 2026). F10: a renewal recorded the way cost-record.py records it (old cost End Date =
// its last payment, new cost Due Date = its first) read as a double, because the first payment was never read.
// Back-tested read-only on the live Costs table on 16 Nov 2026: 11 of the 12 live insurance costs carry a first
// payment date, and the cost side flags exactly the same one house as before (a true double: two policies paid over the same months).
describe('a correctly recorded renewal is not a double (review of PR 951, F10)', () => {
  it('the old cost ends at its last payment and the new one starts after it: clear, with or without an End Date', () => {
    const r = py(`
old = cost('recCOSTOLDPOLICY1', 'Acme Insurance - old year - 7 Example Road', [A], end='2026-11-20', first='2025-12-20')
print(json.dumps({
  'openEnded': houses([], [old, cost('recCOSTNEWPOLICY2', 'Example Mutual - new year - 7 Example Road', [A], end='', first='2026-12-20')]),
  'tenInstalments': houses([], [old, cost('recCOSTNEWPOLICY2', 'Example Mutual - 10 instalments - 7 Example Road', [A], end='2027-09-20', first='2026-12-20')]),
  'controlOverlap': houses([], [old, cost('recCOSTNEWPOLICY2', 'Example Mutual - 7 Example Road', [A], end='', first='2026-09-20')]),
  'controlNoFirstDate': houses([], [old, cost('recCOSTNEWPOLICY2', 'Example Mutual - 7 Example Road', [A], end='')]),
}))`);
    expect(r.openEnded).toEqual([]);
    expect(r.tenInstalments).toEqual([]);
    // Two covers paid over the same months are still a double, and a date nobody recorded is never read as clear.
    expect(r.controlOverlap).toEqual(['7 Example Road']);
    expect(r.controlNoFirstDate).toEqual(['7 Example Road']);
  });

  it("the Costs read takes each cost's first payment from cost-record.py's Due Date", () => {
    const r = py(`${COST_ROWS}
row = crow('recCOSTPAYING0001', 'a', [A])
row['fields'][CR.COST_DUE_DATE] = '2026-12-20'
SERVE = {CR.T_SUBCATEGORIES: SUBS, CR.T_COSTS: [row]}
asked = []
def qr(table, formula=None, fields=None, max_records=None):
    asked.append(list(fields or []))
    return SERVE[table]
fake = types.SimpleNamespace(links=lambda v: list(v or []), _cost_record=lambda: CR, query_records=qr)
costs, ids = cw.insurance_cost_rows(fake)
print(json.dumps({'first': costs[0].get('firstDate'), 'asked': CR.COST_DUE_DATE in asked[-1]}))`);
    expect(r).toEqual({ first: '2026-12-20', asked: true });
  });
});

// F12: a timeout or a dropped connection is not a RuntimeError, so it escaped, and the daily run crashed after
// steps 1 and 2 had raised their tasks, printing neither its JSON nor its last line.
describe('a network error in the double-cover step never loses the run\'s report (review of PR 951, F12)', () => {
  it('a timeout reading Costs is NOT CHECKED: the JSON and the last line still print, and the book side still raises', () => {
    const r = py(`${DAILY}
import urllib.error
code, made, out, last = run_daily(costs_raise=urllib.error.URLError('timed out'))
print(json.dumps({'code': code, 'names': [m[cw.TF['name']] for m in made], 'last': last,
                  'why': out['doubleCover'].get('costsNotChecked'), 'failures': [f['what'] for f in out['failures']]}))`);
    expect(r.code).toBe(1);
    expect(r.names).toEqual(['INSURANCE: two live policies on 7 Example Road - keep the cheapest']);
    expect(r.why).toContain('URLError');
    expect(r.failures).toEqual(['double cover']);
    expect(r.last).toContain('double cover: Costs NOT CHECKED');
  });

  it('a failure anywhere in the step is NOT CHECKED for the whole step, and the rest of the report stands', () => {
    const r = py(`${DAILY}
def broken(*a, **k):
    raise TimeoutError('the read timed out')
cw.double_cover_check = broken
code, made, out, last = run_daily()
print(json.dumps({'code': code, 'last': last, 'why': out['doubleCover'].get('costsNotChecked'),
                  'failures': [f['what'] for f in out['failures']], 'missedItems': out['missedItems']}))`);
    expect(r.code).toBe(1);
    expect(r.why).toMatch(/^the double-cover check could not run: TimeoutError/);
    expect(r.failures).toEqual(['double cover']);
    expect(r.last).toMatch(/^COMPLIANCE: /);
    expect(r.last).toContain('double cover NOT CHECKED');
    expect(r.last.length).toBeLessThanOrEqual(220);
  });
});
