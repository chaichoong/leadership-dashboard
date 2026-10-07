import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Compliance runs as a book (Kevin, 7 Oct 2026; PR 4 of 5 of the agent estate audit fix).
//
// On 7 Oct 2026 the compliance book held 20 lapsed certificates and 40 required items with
// no record at all, many with no open task anywhere, so nothing was ever going to happen to
// them; 10 rows read "Active" with a renewal date in the past; three insurance policies
// renewed with no replacement quote; and Roy held the admin of 75 tasks the 5 Oct ruling
// gives to the agent. These drive the REAL functions in scripts/certificate_watch.py,
// scripts/agent-dispatch.py (the book, the KEVIN ONLY reader) and scripts/reroute-roy-admin.py,
// with every Airtable call stubbed. Every house, person and id here is invented: this repo is
// public. Each mechanism was back-tested by removing it and watching its test fail.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = resolve(ROOT, 'scripts/certificate_watch.py');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const REROUTE = resolve(ROOT, 'scripts/reroute-roy-admin.py');

// Runs a snippet with `cw` (certificate_watch), `ad` (agent-dispatch, only when asked) and
// `rr` (reroute-roy-admin) loaded. The snippet prints one JSON line; that line is returned.
function py(snippet, { dispatch = false } = {}) {
  const script = `
import importlib.util, json, sys, types
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m
cw = load('cw_under_test', ${JSON.stringify(WATCH)})
rr = load('rr_under_test', ${JSON.stringify(REROUTE)})
${dispatch ? `sys.argv = ['agent-dispatch.py']\nad = load('ad_under_test', ${JSON.stringify(DISPATCH)})` : ''}
TODAY = '2026-10-07'
PROPS = [
    {'id': 'recPROPALDER00009', 'short': '9 Alder Row', 'name': '9 Alder Row, Exampletown'},
    {'id': 'recPROPALDER00019', 'short': '19 Alder Row', 'name': '19 Alder Row, Exampletown'},
    {'id': 'recPROPBIRCH00003', 'short': '3 Birch Lane', 'name': '3 Birch Lane, Sampleford'},
    {'id': 'recPROPLARCHMONT0', 'short': 'Larchmont House', 'name': 'Larchmont House, Sampleford'},
]
A, A19, B, L = (p['id'] for p in PROPS)
def page(pid, issues=(), holds=None, active=True, manager='Property Portfolio'):
    short = next(p['short'] for p in PROPS if p['id'] == pid)
    return {'id': pid, 'short': short, 'name': short, 'manager': manager, 'active': active,
            'issues': list(issues), 'holds': holds or {}, 'units': {}, 'required': []}
def item(pid, cert_type, states=('expired',), manager='Property Portfolio'):
    short = next(p['short'] for p in PROPS if p['id'] == pid)
    return {'propertyId': pid, 'property': short, 'manager': manager, 'type': cert_type,
            'states': list(states), 'label': '/'.join(states), 'units': [], 'renewalDate': ''}
def task(name, desc='', props=(), status='Today', created='2026-10-01', completed=''):
    return {'id': 'recTASK' + str(abs(hash(name)))[:10].ljust(10, '0'), 'name': name, 'description': desc,
            'propertyIds': list(props), 'status': status, 'created': created, 'completed': completed}
KEYS = cw.property_keys(PROPS)
def covers(t, it):
    return cw.task_covers(t, it, KEYS.get(it['propertyId']), KEYS)
${snippet}
`;
  const lines = execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

describe('the watch reads the date, not the Status field', () => {
  // The derivation is agent-dispatch's item_state (the book), which the watch reads. The 10
  // rows of 7 Oct read "Active" with a past date; the book must call them expired.
  const book = (rows) => py(`
props = [{'id': A, 'name': '9 Alder Row', 'short': '9 Alder Row', 'kind': 'Single Let', 'manager': 'Property Portfolio',
          'managerEmail': '', 'postcode': '', 'required': ['Landlord Insurance', 'EICR', 'EPC', 'GSC'], 'units': [], 'active': True}]
certs = [dict({'id': 'recCERT0000000001', 'propertyIds': [A], 'unitIds': [], 'hasFile': True, 'taskIds': [],
               'created': '2025-01-01'}, **r) for r in ${JSON.stringify(rows)}]
pages = ad.compliance_pages(props, certs, TODAY)
items, inactive = cw.missed_items(pages)
print(json.dumps({i['type']: i['label'] for i in items}))`, { dispatch: true });

  it('a row marked Active with a renewal date in the past is missed as expired', () => {
    const r = book([{ type: 'GSC', status: 'Active', renewalDate: '2026-08-13' }]);
    expect(r.GSC).toBe('expired');
  });
  it('the same for Valid', () => {
    expect(book([{ type: 'GSC', status: 'Valid', renewalDate: '2026-09-08' }]).GSC).toBe('expired');
  });
  it('control: an Active row in date is not missed', () => {
    expect(book([{ type: 'GSC', status: 'Active', renewalDate: '2027-09-08' }]).GSC).toBeUndefined();
  });
  it('a row with a blank date is missed as undated, not dropped', () => {
    expect(book([{ type: 'EPC', status: 'Active', renewalDate: '' }]).EPC).toBe('undated');
  });
  it('a hand-set Expired still counts with a future date (a cancelled policy keeps its old date)', () => {
    expect(book([{ type: 'Landlord Insurance', status: 'Expired', renewalDate: '2027-03-02' }])['Landlord Insurance']).toBe('expired');
  });
  it('a required type with no row at all is missed as missing', () => {
    expect(book([]).EICR).toBe('missing');
  });
});

describe('the keys survive the rich-text Description', () => {
  // Airtable hands a rich text field back with "_" as "\\_" and "*" as "\\*". A key
  // with either would never read back, and every check that reads a key would miss.
  it('no key carries a character rich text escapes', () => {
    const r = py(`print(json.dumps([cw.MISSED_KEY, cw.INSURANCE_KEY, cw.PREMIUM_KEY, cw.KEY_PREFIX]))`);
    for (const k of r) expect(k).not.toMatch(/[_*`\\[\]|]/);
  });
  it('a description read back with escapes is matched as written: hold-back, block list and control all see it', () => {
    const r = py(`
fake = types.SimpleNamespace(AF={'name': 'fN', 'description': 'fD', 'status': 'fS', 'completion': 'fC'},
                             links=lambda v: list(v or []))
key = cw.MISSED_KEY % (L, 'EICR')
escaped = 'Apartments: Unit 2 \\\\- Larchmont House (end of list). house\\\\_name ' + key.replace('-', '\\\\-')
rec = {'id': 'recT', 'createdTime': '2026-09-01T00:00:00.000Z',
       'fields': {'fN': 'COMPLIANCE: EICR expired - Larchmont House', 'fD': escaped, 'fS': {'name': 'Completed'},
                  'fC': '2026-10-06T10:00:00.000Z'}}
v = cw._task_view(fake, rec)
it = dict(item(L, 'EICR', ('expired', 'missing')), units=['Unit 1 - Larchmont House', 'Unit 2 - Larchmont House'])
open_v = dict(v, status='Today')
print(json.dumps({'desc': v['description'], 'held': bool(cw.recently_closed(item(L, 'EICR'), [v], TODAY)),
                  'left': cw.uncovered_units(it, [open_v], KEYS[L], KEYS)}))`);
    expect(r.desc).toBe('Apartments: Unit 2 - Larchmont House (end of list). house_name CERTWATCH-MISSED recPROPLARCHMONT0 EICR');
    expect(r.held).toBe(true);
    expect(r.left).toEqual(['Unit 1 - Larchmont House']);
  });
});

describe('missed_items', () => {
  it('one item per property and type; a block lists its apartments in one item; due is not missed', () => {
    const r = py(`
pages = [page(L, [{'type': 'EICR', 'state': 'expired', 'unit': 'recU1', 'unitName': 'Flat 1', 'renewalDate': '2026-03-08'},
                  {'type': 'EICR', 'state': 'missing', 'unit': 'recU2', 'unitName': 'Flat 2'},
                  {'type': 'EPC', 'state': 'due', 'renewalDate': '2026-10-20', 'days': 13}])]
items, inactive = cw.missed_items(pages)
print(json.dumps(items))`);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ type: 'EICR', label: 'expired/missing', units: ['Flat 1', 'Flat 2'], renewalDate: '2026-03-08' });
  });
  it('an inactive property is counted, never silently dropped', () => {
    const r = py(`
items, inactive = cw.missed_items([page(A, [{'type': 'GSC', 'state': 'expired'}], active=False)])
print(json.dumps({'items': len(items), 'inactive': inactive}))`);
    expect(r).toEqual({ items: 0, inactive: 1 });
  });
  it('a page with no issues gives nothing, and a page with no issues key does not crash', () => {
    const r = py(`
p = page(A); del p['issues']
print(json.dumps(cw.missed_items([page(B), p])))`);
    expect(r).toEqual([[], 0]);
  });
});

describe('the exists-check: an open task covers a missed item only when it is about that house AND that type', () => {
  const cover = (t) => py(`print(json.dumps(covers(${t}, item(A, 'GSC'))))`);

  it('a task whose name names the property but not the type covers nothing (a repair is not a certificate)', () => {
    expect(cover(`task('MAINTENANCE: 9 Alder Row - boiler pressure low')`)).toBe(false);
    expect(cover(`task("MAINTENANCE: 9 Alder Row - move the CO alarm (gas engineer's note)")`)).toBe(false);
  });
  it('control: the type in the name and the house in the name covers it', () => {
    expect(cover(`task('COMPLIANCE: GSC quote request - Example Plumbing - 9 Alder Row')`)).toBe(true);
    expect(cover(`task('Gas safety certificates, urgent: 9 Alder Row and 3 Birch Lane')`)).toBe(true);
  });
  it('a bare "gas" counts only on a COMPLIANCE: name', () => {
    expect(cover(`task('COMPLIANCE: gas booking - 9 Alder Row')`)).toBe(true);
    expect(cover(`task('British Gas bill - 9 Alder Row')`)).toBe(false);
  });
  it('the property link counts, and the house number is matched whole ("19 Alder" is not "9 Alder")', () => {
    expect(cover(`task('COMPLIANCE: GSC renewal', props=[A])`)).toBe(true);
    expect(cover(`task('COMPLIANCE: GSC renewal due - 19 Alder Row')`)).toBe(false);
    expect(cover(`task('COMPLIANCE: GSC renewal due - 9 Alder Rd')`)).toBe(true);
  });
  it('a bucket whose name names no house covers the houses its description lists', () => {
    expect(cover(`task('Gas safety certificates, the ones with no record', desc='Plan: 9 Alder Row, 3 Birch Lane.')`)).toBe(true);
  });
  it("the description of a task named for ANOTHER house never counts (folded updates mention every house)", () => {
    expect(cover(`task('3 Birch Lane: confirm the gas safety certificate', desc='Compare 9 Alder Row.')`)).toBe(false);
    expect(cover(`task('Gas safety certificates', desc='9 Alder Row', props=[B])`)).toBe(false);
  });
  it('a task carrying the item key covers it whatever its name (a task the gate folded it into)', () => {
    expect(cover(`task('Something else entirely', desc='x ' + cw.MISSED_KEY % (A, 'GSC'))`)).toBe(true);
    expect(cover(`task('Something else entirely', desc='x ' + cw.MISSED_KEY % (A, 'EICR'))`)).toBe(false);
  });
  it('a portfolio bucket covers every house, a self-managed bucket only the self-managed ones', () => {
    const r = py(`
t = task('File the insurance document and expiry for every self-managed property with none on record')
print(json.dumps([covers(t, item(A, 'Landlord Insurance')),
                  covers(t, item(B, 'Landlord Insurance', manager='Example Lettings')),
                  covers(task('Landlord insurance for every property'), item(B, 'Landlord Insurance', manager='Example Lettings')),
                  covers(t, item(A, 'GSC'))]))`);
    expect(r).toEqual([true, false, true, false]);
  });
  it('a repair word never names a certificate: "fire alarm still beeping" is not the fire alarm certificate', () => {
    const r = py(`
print(json.dumps([cw.type_named('MAINTENANCE: hallway fire alarm still beeping - Larchmont House', 'Fire Alarm Cert'),
                  cw.type_named('COMPLIANCE: Fire Alarm Cert renewal due 2026-10-21 - Larchmont House', 'Fire Alarm Cert'),
                  cw.type_named('MAINTENANCE: kitchen electrics - 9 Alder Row', 'EICR'),
                  cw.type_named('Electrical inspections, October: 9 Alder Row', 'EICR')]))`);
    expect(r).toEqual([false, true, false, true]);
  });
  it('a Gas Safe engineer repairing a boiler is not the gas certificate; a claim or rent guarantee is not the landlord policy', () => {
    const r = py(`
print(json.dumps([cw.type_named('Book a Gas Safe engineer to repair the boiler - 9 Alder Row', 'GSC'),
                  cw.type_named('Insurance claim for the water leak - 9 Alder Row', 'Landlord Insurance'),
                  cw.type_named('Rent guarantee insurance claim - 9 Alder Row', 'Landlord Insurance'),
                  cw.type_named('Gas safety check - 9 Alder Row', 'GSC'),
                  cw.type_named('INSURANCE: replacement quote via TopCashback before 2026-10-21 - 9 Alder Row', 'Landlord Insurance')]))`);
    expect(r).toEqual([false, false, false, true, true]);
  });
  it('a key two properties share is dropped rather than let one house cover the other', () => {
    const r = py(`
keys = cw.property_keys([{'id': 'p1', 'short': '5 Oak Street'}, {'id': 'p2', 'short': '5 Oak Close'}])
print(json.dumps([cw.names_property('COMPLIANCE: GSC - 5 Oak', keys['p1']),
                  cw.names_property('COMPLIANCE: GSC - 5 Oak Close', keys['p2']),
                  cw.names_property('COMPLIANCE: GSC - 5 Oak Close', keys['p1'])]))`);
    expect(r).toEqual([false, true, false]);
  });
});

describe('a block: each apartment needs a task that carries it', () => {
  const left = (tasks) => py(`
it = dict(item(L, 'EICR', ('expired', 'missing')), units=['Unit 1 - Larchmont House', 'Unit 2 - Larchmont House'])
print(json.dumps(cw.uncovered_units(it, ${tasks}, KEYS[L], KEYS)))`);

  it("one flat's renewal task carries that flat only; the other is still raised", () => {
    expect(left("[task('COMPLIANCE: EICR renewal due 2026-10-11 - Larchmont House (Unit 1 - Larchmont House)')]"))
      .toEqual(['Unit 2 - Larchmont House']);
  });
  it('a task for the block that names no flat carries them all; no task carries none', () => {
    expect(left("[task('Electrical inspections: Larchmont House')]")).toEqual([]);
    expect(left('[]')).toEqual(['Unit 1 - Larchmont House', 'Unit 2 - Larchmont House']);
  });
  it("the watch's own block task carries only the flats it lists, not a flat whose own task closed later", () => {
    expect(left(`[task('COMPLIANCE: EICR expired - Larchmont House',
                       desc='Apartments: Unit 2 - Larchmont House (end of list). ' + cw.MISSED_KEY % (L, 'EICR'))]`))
      .toEqual(['Unit 1 - Larchmont House']);
    expect(left(`[task('COMPLIANCE: GSC expired - Larchmont House', desc='no list ' + cw.MISSED_KEY % (L, 'EICR'))]`))
      .toEqual([]);
  });
  it('the list the watch writes reads back whole, whatever the flat names hold ("Apt. 1", a name ending inside another)', () => {
    const r = py(`
out = []
for units in (['Apt. 1', 'Apt. 2'], ['Apartment 1', 'Apartment 10', 'Apartment 2'], ['Garden Flat', 'Top Flat, rear']):
    it = dict(item(L, 'EICR', ('expired',)), units=units)
    f = cw.missed_task_fields(it, 1, 1, '', TODAY)
    own = task(f[cw.TF['name']], desc=f[cw.TF['desc']])
    out.append(cw.uncovered_units(it, [own], KEYS[L], KEYS))
it = dict(item(L, 'EICR', ('expired',)), units=['Apartment 1', 'Apartment 10', 'Apartment 2'])
f = cw.missed_task_fields(dict(it, units=['Apartment 10']), 1, 1, '', TODAY)
out.append(cw.uncovered_units(it, [task(f[cw.TF['name']], desc=f[cw.TF['desc']])], KEYS[L], KEYS))
print(json.dumps(out))`);
    expect(r).toEqual([[], [], [], ['Apartment 1', 'Apartment 2']]);
  });
  it("a flat's own task names it by number or by its whole name; either way it carries that flat only", () => {
    const r = py(`
it = dict(item(L, 'EICR', ('expired',)), units=['Penthouse', 'Apartment 3'], allUnits=['Penthouse', 'Apartment 3'])
print(json.dumps(cw.uncovered_units(it, [task('COMPLIANCE: EICR renewal due 2026-10-11 - Larchmont House (Penthouse)')], KEYS[L], KEYS)))`);
    expect(r).toEqual(['Apartment 3']);
  });
  it("one certificate filed for the whole block: the engine's single task (named after the first flat) carries every flat", () => {
    const r = py(`
units = ['Unit 1 - Larchmont House', 'Unit 2 - Larchmont House', 'Unit 3 - Larchmont House']
it = dict(item(L, 'EICR', ('expired',)), units=units, allUnits=units, unitCerts={u: 'recBLOCKWIDE00001' for u in units})
own = dict(it, unitCerts={units[0]: 'recFLAT1', units[1]: 'recFLAT2', units[2]: 'recFLAT3'})
t = [task('COMPLIANCE: EICR renewal due 2026-10-11 - Larchmont House (Unit 1 - Larchmont House)')]
print(json.dumps([cw.uncovered_units(it, t, KEYS[L], KEYS), cw.uncovered_units(own, t, KEYS[L], KEYS)]))`);
    expect(r).toEqual([[], ['Unit 2 - Larchmont House', 'Unit 3 - Larchmont House']]);
  });
  it('a flat name holding "; " still reads back from the list', () => {
    const r = py(`
it = dict(item(L, 'EICR', ('expired',)), units=['Garden Flat; rear', 'Top Flat'])
f = cw.missed_task_fields(it, 1, 1, '', TODAY)
print(json.dumps(cw.uncovered_units(it, [task(f[cw.TF['name']], desc=f[cw.TF['desc']])], KEYS[L], KEYS)))`);
    expect(r).toEqual([]);
  });
  it('missed_items carries every flat name and the certificate each missed flat holds', () => {
    const r = py(`
p = page(L, [{'type': 'EICR', 'state': 'expired', 'unit': 'u1', 'unitName': 'Unit 1 - Larchmont House', 'renewalDate': '2026-03-08'},
             {'type': 'EICR', 'state': 'missing', 'unit': 'u2', 'unitName': 'Unit 2 - Larchmont House'}])
p['units'] = {'u1': {'name': 'Unit 1 - Larchmont House', 'EICR': {'certificate': 'recC1'}},
              'u2': {'name': 'Unit 2 - Larchmont House'}, 'u3': {'name': 'Unit 3 - Larchmont House', 'EICR': {'certificate': 'recC3'}}}
items, _ = cw.missed_items([p])
print(json.dumps([items[0]['allUnits'], items[0]['unitCerts']]))`);
    expect(r).toEqual([['Unit 1 - Larchmont House', 'Unit 2 - Larchmont House', 'Unit 3 - Larchmont House'],
      { 'Unit 1 - Larchmont House': 'recC1' }]);
  });
  it('reads the plural forms tasks use for several flats, and never reads a house number as a flat', () => {
    const r = py(`print(json.dumps([sorted(cw.unit_numbers(t), key=lambda x: (len(x), x)) for t in (
        'EPC (Flats 1-2) and Flats 3-9', 'Units 3 to 5', 'EICR for Flats 2 and 3', 'Apartments 1, 4 & 6',
        'MAINTENANCE: Flat 2 - 3 Birch Lane', 'Unit 8 – Larchmont House', 'Lytham flats 1-9 supply')]))`);
    expect(r).toEqual([['1', '2', '3', '4', '5', '6', '7', '8', '9'], ['3', '4', '5'], ['2', '3'], ['1', '4', '6'],
      ['2'], ['8'], ['1', '2', '3', '4', '5', '6', '7', '8', '9']]);
  });
  it('a task for "Flats 2 and 3" carries those two flats, not the block', () => {
    const r = py(`
units = ['Unit %d - Larchmont House' % n for n in range(1, 10)]
it = dict(item(L, 'EICR', ('expired',)), units=units, allUnits=units)
print(json.dumps(cw.uncovered_units(it, [task('EICR for Flats 2 and 3 - Larchmont House')], KEYS[L], KEYS)))`);
    expect(r).toEqual(['Unit 1 - Larchmont House', 'Unit 4 - Larchmont House', 'Unit 5 - Larchmont House',
      'Unit 6 - Larchmont House', 'Unit 7 - Larchmont House', 'Unit 8 - Larchmont House', 'Unit 9 - Larchmont House']);
  });
  it('a short flat name inside a longer one is not that flat ("Penthouse" in "Penthouse 2", a flat named after the block)', () => {
    const r = py(`
a = dict(item(L, 'EICR', ('expired',)), units=['Penthouse', 'Penthouse 2'], allUnits=['Penthouse', 'Penthouse 2'])
b = dict(item(L, 'EICR', ('expired',)), units=['Garden Flat', 'Garden Flat Rear'], allUnits=['Garden Flat', 'Garden Flat Rear'])
fb = cw.missed_task_fields(dict(b, units=['Garden Flat Rear']), 1, 1, '', TODAY)
c = dict(item(L, 'EICR', ('expired',)), units=['Larchmont', 'Mews'], allUnits=['Larchmont', 'Mews'])
print(json.dumps([cw.uncovered_units(a, [task('COMPLIANCE: EICR renewal due 2026-10-11 - Larchmont House (Penthouse 2)')], KEYS[L], KEYS),
                  cw.uncovered_units(b, [task(fb[cw.TF['name']], desc=fb[cw.TF['desc']])], KEYS[L], KEYS),
                  cw.uncovered_units(c, [task('Electrical inspection: Larchmont House')], KEYS[L], KEYS)]))`);
    expect(r).toEqual([['Penthouse'], ['Garden Flat'], []]);
  });
  it('a closed watch task holds back only the flats it listed; a flat it never named is raised now', () => {
    const r = py(`
units = ['Unit 2 - Larchmont House', 'Unit 3 - Larchmont House']
it = dict(item(L, 'EICR', ('expired',)), units=units, allUnits=units)
f = cw.missed_task_fields(dict(it, units=units[:1]), 1, 1, '', TODAY)
closed = task(f[cw.TF['name']], desc=f[cw.TF['desc']], status='Cancelled', created='2026-09-01')
closed['modified'] = '2026-10-06'
cov, held, found = cw.judge_missed([it], [], [closed], KEYS, TODAY)
print(json.dumps({'held': [h.get('units') for h in held], 'found': [x['units'] for x in found]}))`);
    expect(r).toEqual({ held: [['Unit 2 - Larchmont House']], found: [['Unit 3 - Larchmont House']] });
  });
  it('every recently closed watch task holds back its own flats; one that listed none holds back nothing', () => {
    const r = py(`
it = dict(item(L, 'EICR', ('expired',)), units=['Garden Flat', 'Top Flat', 'Mews'])
def closed(units, day):
    f = cw.missed_task_fields(dict(it, units=units), 1, 1, '', TODAY)
    t = task(f[cw.TF['name']] + day, desc=f[cw.TF['desc']], status='Completed', completed=day)
    return t
cov, held, found = cw.judge_missed([it], [], [closed(['Garden Flat'], '2026-10-01'), closed(['Top Flat'], '2026-10-05')], KEYS, TODAY)
cov2, held2, found2 = cw.judge_missed([dict(it, units=['Garden Flat', 'Top Flat'])], [], [closed(['Garden Flat Rear'], '2026-10-06')], KEYS, TODAY)
print(json.dumps({'held': sorted(u for h in held for u in h['units']), 'found': [x['units'] for x in found],
                  'held2': held2, 'found2': [x['units'] for x in found2]}))`);
    expect(r).toEqual({ held: ['Garden Flat', 'Top Flat'], found: [['Mews']], held2: [], found2: [['Garden Flat', 'Top Flat']] });
  });
  it('judge_missed raises the block item with only the flats left', () => {
    const r = py(`
it = dict(item(L, 'EICR', ('expired', 'missing')), units=['Unit 1 - Larchmont House', 'Unit 2 - Larchmont House'])
cov, held, found = cw.judge_missed([it], [task('COMPLIANCE: EICR renewal due 2026-10-11 - Larchmont House (Unit 1)')], [], KEYS, TODAY)
print(json.dumps([f['units'] for f in found]))`);
    expect(r).toEqual([['Unit 2 - Larchmont House']]);
  });
});

describe('a missed-item task closed with the item still missing', () => {
  it('a task cancelled yesterday is held back even though it was raised weeks ago (no Completion Date on a cancel)', () => {
    const r = py(`
key = cw.MISSED_KEY % (A, 'GSC')
t = task('COMPLIANCE: GSC expired - 9 Alder Row', desc=key, status='Cancelled', created='2026-09-01')
t['modified'] = '2026-10-06'
cov, held, found = cw.judge_missed([item(A, 'GSC')], [], [t], KEYS, TODAY)
print(json.dumps({'held': bool(cw.recently_closed(item(A, 'GSC'), [t], TODAY)), 'comesBack': held[0]['comesBack']}))`);
    expect(r).toEqual({ held: true, comesBack: '2026-10-21' });
  });
  it('is held back for 14 days, then raised again', () => {
    const r = py(`
key = cw.MISSED_KEY % (A, 'GSC')
it = item(A, 'GSC')
recent = task('COMPLIANCE: GSC expired - 9 Alder Row', desc=key, status='Completed', completed='2026-09-30')
old = task('COMPLIANCE: GSC expired - 9 Alder Row', desc=key, status='Cancelled', created='2026-09-01')
open_ = task('COMPLIANCE: GSC expired - 9 Alder Row', desc=key, status='Today')
print(json.dumps([bool(cw.recently_closed(it, [recent], TODAY)), bool(cw.recently_closed(it, [old], TODAY)),
                  bool(cw.recently_closed(it, [open_], TODAY)),
                  bool(cw.recently_closed(item(A, 'EICR'), [recent], TODAY))]))`);
    expect(r).toEqual([true, false, false, false]);
  });
});

describe('the order of work: lapsed first, then the quarter plan, then soonest expiry', () => {
  it('reads the plan sentences by type and ranks the houses in the order named', () => {
    const r = py(`
texts = ['Buy every gas certificate, lapsed ones first: 3 Birch Lane, 9 Alder Row. Two electrical inspections: 9 Alder Row, Larchmont House.', 'Four electrical inspections.']
print(json.dumps(cw._plan_order_list(texts, PROPS)))`);
    expect(r).toEqual([
      ['recPROPALDER00009', 'EICR', 0], ['recPROPALDER00009', 'GSC', 1],
      ['recPROPBIRCH00003', 'GSC', 0], ['recPROPLARCHMONT0', 'EICR', 1]]);
  });
  it('sorts expired before no-date items, the plan order before the rest, then the earliest date', () => {
    const r = py(`
rank = cw.plan_order(['Gas certificates: 3 Birch Lane, then 9 Alder Row.'], PROPS)
its = [dict(item(L, 'EICR', ('missing',))),
       dict(item(A, 'GSC'), renewalDate='2026-09-08'),
       dict(item(A19, 'GSC'), renewalDate='2026-04-24'),
       dict(item(B, 'GSC'), renewalDate='2026-09-30')]
its.sort(key=lambda i: cw.order_key(i, rank))
print(json.dumps([i['property'] + ' ' + i['type'] for i in its]))`);
    expect(r).toEqual(['3 Birch Lane GSC', '9 Alder Row GSC', '19 Alder Row GSC', 'Larchmont House EICR']);
  });
  it("on a tie, Kevin's 2 Sep order: insurance, then gas safety, then the rest", () => {
    const r = py(`
its = [item(A, 'EICR', ('missing',)), item(A, 'GSC', ('missing',)), item(A, 'Landlord Insurance', ('missing',))]
its.sort(key=lambda i: cw.order_key(i, {}))
print(json.dumps([i['type'] for i in its]))`);
    expect(r).toEqual(['Landlord Insurance', 'GSC', 'EICR']);
  });
  it('lapsed comes before the plan: an expired item the plan does not name beats a missing one it does', () => {
    const r = py(`
rank = cw.plan_order(['Two electrical inspections: Larchmont House, 3 Birch Lane.'], PROPS)
its = [dict(item(L, 'EICR', ('missing',))), dict(item(A19, 'GSC'), renewalDate='2026-04-24')]
its.sort(key=lambda i: cw.order_key(i, rank))
print(json.dumps([i['property'] for i in its]))`);
    expect(r).toEqual(['19 Alder Row', 'Larchmont House']);
  });
});

describe('insurance: two checkpoints before renewal, then an alarm when it passes', () => {
  const acts = (renewal, { open = '[]', keyed = '[]' } = {}) => py(`
pages = [page(A, holds={'Landlord Insurance': {'renewalDate': '${renewal}', 'certificate': 'recCERTINS0000001'}})]
print(json.dumps([[a['kind'], a['checkpoint']] for a in cw._insurance_with_keys(pages, ${open}, ${keyed}, PROPS, TODAY)]))`);

  it('30 and 15 days out raise the first quote task; 31 days out nothing yet', () => {
    expect(acts('2026-11-06')).toEqual([['quote', '30']]);
    expect(acts('2026-10-22')).toEqual([['quote', '30']]);
    expect(acts('2026-11-07')).toEqual([]);
  });
  it('a dateless insurance task stands the checkpoint down only if raised in the 90 days before the renewal', () => {
    expect(acts('2026-11-05', { open: "[task('INSURANCE: landlord insurance via TopCashback - 9 Alder Row', created='2026-09-01')]" }))
      .toEqual([]);
    expect(acts('2026-11-05', { open: "[task('INSURANCE: landlord insurance via TopCashback - 9 Alder Row', created='2025-09-01')]" }))
      .toEqual([['quote', '30']]);
  });
  it('dates written 30/10/2025 or Oct 2025 are read, so last year\'s task is not this year\'s', () => {
    const r = py(`print(json.dumps([[d.isoformat(), t] for d, t in cw.dates_named('renew 30/10/2025, then Oct 2026, 3 Nov 2026')]))`);
    expect(r).toEqual([['2026-11-03', 0], ['2025-10-30', 0], ['2026-10-15', 20]]);
    // A place that starts with a month is not a date.
    expect(py(`print(json.dumps(cw.dates_named('INSURANCE: Mayfield 2026 quote, Octavia 2027')))`)).toEqual([]);
    expect(acts('2026-11-05', { open: "[task('INSURANCE: renewal before 30/10/2025 - 9 Alder Row')]" })).toEqual([['quote', '30']]);
    expect(acts('2026-11-05', { open: "[task('INSURANCE: renewal Oct 2025 - 9 Alder Row')]" })).toEqual([['quote', '30']]);
    expect(acts('2026-11-05', { open: "[task('INSURANCE: renewal Nov 2026 - 9 Alder Row')]" })).toEqual([]);
  });
  it('"no claims" and a claims history are the policy; a claim, rent guarantee or medical cover are not', () => {
    const r = py(`print(json.dumps([cw.type_named(n, 'Landlord Insurance') for n in (
        'INSURANCE: quote with 5-year no claims - 9 Alder Row', 'INSURANCE: declare the claims history - 9 Alder Row',
        'Insurance claim for the water leak - 9 Alder Row', 'Private Medical Insurance renewal',
        'Chase insurance claims for 9 Alder Row', 'INSURANCE: insurance claims history for the form - 9 Alder Row',
        'Insurance claims - 9 Alder Row')]))`);
    expect(r).toEqual([true, true, false, false, false, true, false]);
  });
  it('a portfolio bucket or last year\'s open task does not stand the checkpoints down', () => {
    expect(acts('2026-11-05', { open: "[task('File the insurance document and expiry for every self-managed property with none on record')]" }))
      .toEqual([['quote', '30']]);
    expect(acts('2026-11-05', { open: "[task('INSURANCE: replacement cover before 3 Oct 2025 - 9 Alder Row')]" }))
      .toEqual([['quote', '30']]);
    expect(acts('2026-11-05', { open: "[task('COMPLIANCE: Landlord Insurance renewal due 2026-11-05 - 9 Alder Row')]" }))
      .toEqual([]);
  });
  it('14 days out and on the day raise the second', () => {
    expect(acts('2026-10-21')).toEqual([['quote', '14']]);
    expect(acts('2026-10-07')).toEqual([['quote', '14']]);
  });
  it('a renewal that passed in the last 14 days with nothing open raises the alarm; older does not', () => {
    expect(acts('2026-10-04')).toEqual([['passed', 'passed']]);
    expect(acts('2026-09-22')).toEqual([]);
  });
  it('an open insurance task for the house stands both down', () => {
    expect(acts('2026-10-21', { open: "[task('COMPLIANCE: Landlord Insurance renewal due 2026-10-21 - 9 Alder Row')]" })).toEqual([]);
    expect(acts('2026-10-04', { open: "[task('INSURANCE: quotes - 9 Alder Row')]" })).toEqual([]);
  });
  it('a checkpoint fires once (its key on any task, open or closed); the second still fires', () => {
    const k30 = "cw.INSURANCE_KEY % (A, '2026-10-21', '30')";
    const k14 = "cw.INSURANCE_KEY % (A, '2026-10-21', '14')";
    expect(acts('2026-10-21', { keyed: `[task('x', desc=${k14}, status='Completed')]` })).toEqual([]);
    expect(acts('2026-10-21', { keyed: `[task('x', desc=${k30}, status='Completed')]` })).toEqual([['quote', '14']]);
  });
  it('a policy with no renewal date is left to the missed-item pass', () => {
    expect(acts('')).toEqual([]);
  });
});

describe('premium rises', () => {
  const rises = (oldNote, newNote, keyed = '[]') => py(`
rows = [{'id': 'recOLD', 'propertyIds': [A], 'renewalDate': '2026-09-26', 'notes': ${JSON.stringify(oldNote)}},
        {'id': 'recNEW', 'propertyIds': [A], 'renewalDate': '2027-09-26', 'notes': ${JSON.stringify(newNote)}}]
r, nc = cw.premium_rises(rows, ${keyed}, TODAY)
print(json.dumps({'rises': [[x['old'], x['new'], x['rise']] for x in r], 'notChecked': nc}))`);

  it('reads yearly and monthly premiums from the Notes', () => {
    const r = py(`print(json.dumps([cw.parse_premium('Example Insurer, premium £416.60/yr'), cw.parse_premium('premium of £51.80 a month'),
                                   cw.parse_premium('Broker fee £60.00'), cw.parse_premium('')]))`);
    expect(r).toEqual([416.6, 621.6, null, null]);
  });
  it('every common way of writing a monthly premium is read as monthly (a monthly figure read as yearly hides a rise)', () => {
    const r = py(`print(json.dumps([cw.parse_premium(t) for t in (
        'premium £34.50 pcm', 'premium £34.50 p/m', 'premium £34.50 per calendar month', 'premium £34.50/m',
        'premium £34.50 monthly', 'monthly premium £34.50', 'premium £34.50/month', 'premium £414 a year',
        'premium £414 (£34.50 a month by instalments)')]))`);
    expect(r).toEqual([414, 414, 414, 414, 414, 414, 414, 414, 414]);
  });
  it('a rise over 10% fires; a rise under it does not', () => {
    expect(rises('premium £201.58/yr', 'premium £621.60/yr').rises).toEqual([[201.58, 621.6, 208.4]]);
    expect(rises('premium £400/yr', 'premium £420/yr').rises).toEqual([]);
  });
  it('a policy with no premium recorded is counted as not checked, never as no rise', () => {
    expect(rises('', 'premium £420/yr')).toEqual({ rises: [], notChecked: 1 });
  });
  it('fires once per new policy row', () => {
    expect(rises('premium £201.58/yr', 'premium £621.60/yr', "[task('x', desc=cw.PREMIUM_KEY % 'recNEW')]").rises).toEqual([]);
  });
});

describe('the tasks the watch raises', () => {
  it('a missed-item task is for the agent, due today, linked to the house, and covers its own item', () => {
    const r = py(`
it = dict(item(A, 'GSC'), label='expired', renewalDate='2026-08-13')
f = cw.missed_task_fields(it, 1, 3, '9 Alder Row GSC', TODAY)
t = task(f[cw.TF['name']], desc=f[cw.TF['desc']])
print(json.dumps({'name': f[cw.TF['name']], 'team': f[cw.TF['team']], 'due': f[cw.TF['due']],
                  'props': f[cw.TF['properties']], 'covers': covers(t, it), 'order': cw.ORDER_RULE in f[cw.TF['desc']]}))`);
    expect(r).toEqual({ name: 'COMPLIANCE: GSC expired - 9 Alder Row', team: ['recwWvBju2ycB63i4'], due: '2026-10-07',
      props: ['recPROPALDER00009'], covers: true, order: true });
  });
  it('an insurance task carries the Hard Deadline tick, the rule, and a KEVIN ONLY line the dispatch gate reads as a purchase', () => {
    const r = py(`
act = {'kind': 'quote', 'checkpoint': '14', 'key': cw.INSURANCE_KEY % (A, '2026-10-21', '14'), 'propertyId': A,
       'property': '9 Alder Row', 'manager': '', 'renewalDate': '2026-10-21', 'days': 14}
f = cw.insurance_task_fields(act, TODAY)
step = ad.kevin_only_step(f[cw.TF['desc']])
alarm = cw.insurance_task_fields(dict(act, kind='passed', renewalDate='2026-10-04'), TODAY)
print(json.dumps({'name': f[cw.TF['name']], 'hard': f[cw.TF['hardDeadline']], 'due': f[cw.TF['due']],
                  'step': step, 'emailOnly': 'EMAIL ONLY' in f[cw.TF['desc']], 'monthly': 'monthly instalments' in f[cw.TF['desc']],
                  'alarmName': alarm[cw.TF['name']], 'alarmHard': alarm[cw.TF['hardDeadline']], 'alarmDue': alarm[cw.TF['due']]}))`,
    { dispatch: true });
    expect(r.name).toBe('INSURANCE: replacement quote via TopCashback before 2026-10-21 - 9 Alder Row');
    expect(r.hard).toBe(true);
    expect(r.due).toBe('2026-10-21');
    expect(r.step.reason).toBe('purchase');
    expect(r.step.invalid).toBeUndefined();
    expect(r.emailOnly && r.monthly).toBe(true);
    expect(r.alarmName).toBe('INSURANCE: 9 Alder Row renewed on 2026-10-04 with no replacement quote open');
    expect(r.alarmHard).toBe(true);
    expect(r.alarmDue).toBe('2026-10-07');
  });
  it("the 30-day task carries agent-dispatch's renewal mark, so verify refuses a close with no policy filed; the others do not", () => {
    const r = py(`
act = {'kind': 'quote', 'checkpoint': '30', 'key': 'k', 'propertyId': A, 'property': '9 Alder Row', 'manager': '',
       'renewalDate': '2026-11-06', 'days': 30}
d30 = cw.insurance_task_fields(act, TODAY)[cw.TF['desc']]
d14 = cw.insurance_task_fields(dict(act, checkpoint='14'), TODAY)[cw.TF['desc']]
miss = cw.missed_task_fields(dict(item(A, 'GSC'), label='expired'), 1, 1, '', TODAY)[cw.TF['desc']]
print(json.dumps([ad.ENGINE_RENEWAL_MARK == cw.ENGINE_RENEWAL_MARK, ad.ENGINE_RENEWAL_MARK in d30,
                  ad.ENGINE_RENEWAL_MARK in d14, ad.ENGINE_RENEWAL_MARK in miss]))`, { dispatch: true });
    expect(r).toEqual([true, true, false, false]);
  });
  it("the alarm's text states no later date, so the create gate cannot move its due date off today", () => {
    const r = py(`
ct = load('ct_under_test', ${JSON.stringify(resolve(ROOT, 'scripts/create-agent-task.py'))})
import datetime
act = {'kind': 'passed', 'checkpoint': 'passed', 'key': 'k', 'propertyId': A, 'property': '9 Alder Row', 'manager': '',
       'renewalDate': '2026-10-04', 'days': -3}
f = cw.insurance_task_fields(act, TODAY)
print(json.dumps(ct.hard_deadline_correction(f, datetime.date(2026, 10, 7))))`);
    expect(r).toBe(null);
  });
});

describe('the gate never folds a watch task into another task', () => {
  it('a fold verdict is refused and the task is created on its own; a create verdict creates normally', () => {
    const r = py(`
calls = []
def fake(fields, flags):
    calls.append(flags)
    if '--dry-run' in flags:
        return True, {'action': 'updated', 'taskId': 'recOTHER', 'matchedName': 'COMPLIANCE: EPC quote - Larchmont House'}
    return True, {'action': 'created', 'taskId': 'recNEW'}
cw._gate = fake
ok, out = cw.gate_create({'x': 1}, True)
first = list(calls); calls.clear()
cw._gate = lambda fields, flags: (calls.append(flags) or (True, {'action': 'created', 'taskId': '(dry run)' if '--dry-run' in flags else 'recNEW2'}))
ok2, out2 = cw.gate_create({'x': 1}, True)
print(json.dumps({'first': first, 'out': out, 'second': calls, 'out2': out2}))`);
    expect(r.first).toEqual([['--dry-run'], ['--force']]);
    expect(r.out.gateWouldFold).toContain('EPC quote');
    // Forced on a create verdict too: a fold decided between the two calls would
    // otherwise put the key in another task for good.
    expect(r.second).toEqual([['--dry-run'], ['--force']]);
    expect(r.out2.taskId).toBe('recNEW2');
  });
  it('a refusal on the dry run stops there: nothing is forced through', () => {
    const r = py(`
calls = []
cw._gate = lambda fields, flags: (calls.append(flags) or (False, {'action': 'refused', 'why': 'auto-reply'}))
ok, out = cw.gate_create({'x': 1}, True)
print(json.dumps({'ok': ok, 'calls': calls}))`);
    expect(r).toEqual({ ok: false, calls: [['--dry-run']] });
  });
  it('a dry run writes nothing: only the --dry-run call is made', () => {
    const r = py(`
calls = []
cw._gate = lambda fields, flags: (calls.append(flags) or (True, {'action': 'updated', 'matchedName': 'x'}))
ok, out = cw.gate_create({'x': 1}, False)
print(json.dumps({'calls': calls, 'out': out}))`);
    expect(r.calls).toEqual([['--dry-run']]);
    expect(r.out.action).toBe('created');
  });
});

// The whole daily pass, with the book, the reads and the gate stubbed.
function daily({ apply = true, paused = false, openTasks = null, pages = null, gate = null } = {}) {
  return py(`
import io, contextlib
fake = types.SimpleNamespace()
fake.AF = {'name': 'fN', 'description': 'fD', 'status': 'fS', 'completion': 'fC'}
fake.CERT_FIELDS = {'type': 'cT', 'property': 'cP', 'renewal': 'cR', 'notes': 'cN'}
fake.TASKS = 'tblTASKS'; fake.CERTIFICATES_TABLE = 'tblCERTS'
fake.links = lambda v: list(v or [])
fake.today_london = lambda: TODAY
fake.fetch_properties = lambda: [dict(p, kind='Single Let', manager='Property Portfolio') for p in PROPS]
fake.fetch_certificates = lambda: [{'id': 'recC'}]
PAGES = ${pages || `[page(A, [{'type': 'GSC', 'state': 'expired', 'renewalDate': '2026-08-13'},
                    {'type': 'Landlord Insurance', 'state': 'expired', 'renewalDate': '2026-10-04'}],
                 holds={'Landlord Insurance': {'renewalDate': '2026-10-04', 'certificate': 'recCI'}}),
               page(B, [{'type': 'EICR', 'state': 'missing'}])]`}
fake.compliance_book_pages = lambda: PAGES
OPEN = ${openTasks || `[{'id': 'recFILL%03d' % i, 'fields': {'fN': 'filler %d' % i}} for i in range(60)]`}
def qr(table, formula=None, fields=None, max_records=None):
    if table == 'tblTASKS' and formula.startswith('AND({Status}'):
        return OPEN
    if table == 'tblTASKS':
        return []
    if table == 'tblCERTS':
        return [{'id': 'recCI', 'fields': {'cP': [A], 'cR': '2026-10-04', 'cN': ''}}]
    return []
fake.query_records = qr
fake.property_agent_paused = lambda: ${paused ? 'True' : 'False'}
cw._AD['m'] = fake
cw.plan_texts = lambda ad, today: (['Gas certificates: 9 Alder Row.'], '')
made = []
def gate(fields, apply):
    made.append(fields[cw.TF['name']])
    ${gate || "return True, {'action': 'created', 'taskId': 'recNEW%02d' % len(made)}"}
cw.gate_create = gate
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = cw.cmd_daily(${apply ? 'True' : 'False'})
out = buf.getvalue().strip().split('\\n')
print(json.dumps({'code': code, 'made': made, 'last': out[-1]}))`);
}

describe('the daily pass', () => {
  it('raises insurance first, so the expired policy is one task, not two; exits 1 so the count is seen', () => {
    const r = daily();
    expect(r.made).toEqual([
      'INSURANCE: 9 Alder Row renewed on 2026-10-04 with no replacement quote open',
      'COMPLIANCE: GSC expired - 9 Alder Row',
      'COMPLIANCE: EICR missing - 3 Birch Lane']);
    expect(r.code).toBe(1);
    expect(r.last).toMatch(/^COMPLIANCE: 2 required items had no open task; 2 raised, 0 still without one; insurance: 1 raised/);
    expect(r.last.length).toBeLessThanOrEqual(220);
  });
  it('control: with everything covered it raises nothing and exits 0', () => {
    const r = daily({ openTasks: `[{'id': 'recFILL%03d' % i, 'fields': {'fN': 'filler %d' % i}} for i in range(60)] + [
        {'id': 'recCOV1', 'fields': {'fN': 'COMPLIANCE: GSC quote - 9 Alder Row'}},
        {'id': 'recCOV2', 'createdTime': '2026-09-20T09:00:00.000Z', 'fields': {'fN': 'INSURANCE: renewal - 9 Alder Row'}},
        {'id': 'recCOV3', 'fields': {'fN': 'Electrical inspections: 3 Birch Lane'}}]` });
    expect(r.made).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.last).toMatch(/^COMPLIANCE: 0 required items had no open task/);
  });
  it('a paused agent gets nothing raised, and the run says so and exits 1', () => {
    const r = daily({ paused: true });
    expect(r.made).toEqual([]);
    expect(r.code).toBe(1);
    expect(r.last).toContain('paused');
    // Three, not two: with nothing raised for the renewal that passed, the expired policy is missed too.
    expect(r.last).toMatch(/^COMPLIANCE: 3 required items had no open task; 0 raised, 3 still without one/);
  });
  it('a keyed read that misses an open keyed task fails the run: the record of what fired cannot be trusted', () => {
    const r = daily({ openTasks: `[{'id': 'recFILL%03d' % i, 'fields': {'fN': 'filler %d' % i}} for i in range(60)] + [
        {'id': 'recKEYED1', 'fields': {'fN': 'COMPLIANCE: GSC expired - 9 Alder Row', 'fD': cw.MISSED_KEY % (A, 'GSC')}}]` });
    expect(r.made).toEqual([]);
    expect(r.code).toBe(1);
    expect(r.last).toContain('keyed read did not return them');
  });
  it('a broken open-task read raises nothing (a broken exists-check mints duplicates)', () => {
    const r = daily({ openTasks: '[]' });
    expect(r.made).toEqual([]);
    expect(r.code).toBe(1);
    expect(r.last).toContain('control failed');
  });
  it('a refused create is a failure the summary counts as still without a task', () => {
    const r = daily({ gate: "return False, {'action': 'refused', 'why': 'test refusal'}" });
    expect(r.code).toBe(1);
    expect(r.last).toContain('0 raised, 3 still without one');
  });
  it('a dry run says it wrote nothing', () => {
    const r = daily({ apply: false });
    expect(r.last).toContain('would be raised (dry run)');
  });
  it('the last line keeps the count inside the 220 characters the Estate Status row shows, at its longest', () => {
    const r = py(`print(json.dumps([cw.watch_summary(60, 0, 60, 3, 0, 12, paused=True),
                                   cw.watch_summary(160, 160, 0, 30, 12, 26, dry_run=True),
                                   cw.watch_summary(1000, 1000, 1000, 1000, 100, 100, paused=True, dry_run=True)]))`);
    for (const line of r) {
      expect(line.length).toBeLessThanOrEqual(220);
    }
    expect(r[0]).toMatch(/^COMPLIANCE: 60 required items had no open task; 0 raised, 60 still without one/);
    expect(r[1]).toMatch(/^COMPLIANCE: 160 required items had no open task; 160 would be raised \(dry run\)/);
  });
});

describe("the first insurance checkpoint and the renewal engine never both raise a task", () => {
  it("the engine finds the watch's task by its exact name and raises nothing of its own", () => {
    const r = py(`
act = {'kind': 'quote', 'checkpoint': '30', 'key': 'k', 'propertyId': A, 'property': '9 Alder Row', 'manager': '',
       'renewalDate': '2026-11-06', 'days': 30}
mine = cw.insurance_task_fields(act, TODAY)[cw.TF['name']]
raised = []
ad.property_agent_paused = lambda: False
ad.today_london = lambda: TODAY
ad.compliance_book_pages = lambda: [{'id': A, 'short': '9 Alder Row', 'active': True, 'manager': '',
    'holds': {'Landlord Insurance': {'certificate': 'recCI', 'renewalDate': '2026-11-06', 'days': 30, 'state': 'in date', 'hasFile': True}},
    'units': {}, 'issues': []}]
ad.load_score_state = lambda path: {}
ad.save_state = lambda path, obj: None
ad.raise_engine_task = lambda *a, **k: raised.append(a[0])
ad.query_tasks = lambda formula, max_records=None, minimal=False: [{'fields': {ad.AF['name']: mine}}]
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    ad.ensure_renewal_tasks()
ad.query_tasks = lambda formula, max_records=None, minimal=False: []
with contextlib.redirect_stdout(io.StringIO()):
    ad.ensure_renewal_tasks()
print(json.dumps({'mine': mine, 'raised': raised}))`, { dispatch: true });
    expect(r.mine).toBe('COMPLIANCE: Landlord Insurance renewal due 2026-11-06 - 9 Alder Row');
    // First call: the watch's task is there, so nothing. Control: without it, the engine raises its own, same name.
    expect(r.raised).toEqual([r.mine]);
  });
});

describe('reroute-roy-admin: what moves to the agent and what stays with Roy', () => {
  const cls = (name, extra = '') => py(`
f = {rr.F['name']: ${JSON.stringify(name)}, rr.F['team']: [rr.ROY_REC]${extra}}
print(json.dumps(rr.classify({'id': 'recT', 'fields': f}, rr.chain_names())))`);

  it('admin moves', () => {
    expect(cls('COMPLIANCE: GSC quote request - Example Plumbing - 9 Alder Row')).toEqual(['move', 'admin']);
    expect(cls('Sam Example: chase the Universal Credit claim in writing')).toEqual(['move', 'admin']);
  });
  it('each moved task goes to the agent whose lane it is in, ids read from agent-dispatch.py', () => {
    const r = py(`
print(json.dumps({'ids': [rr.AGENT_REC, rr.RENT_AGENT_REC, rr.MONEY_AGENT_REC],
                  'to': [rr.AGENT_NAMES[rr.target_agent(n)] for n in (
                      'Sam Example: chase the Universal Credit claim in writing',
                      'Sam Example: confirm his first rent payment has landed',
                      'Fwd: Invoice 0549 from Example Heating Ltd',
                      'Switch on Auto Pay for Flat 1 electricity',
                      'COMPLIANCE: GSC quote request - 9 Alder Row',
                      'Collect dates of birth for the tenants',
                      'Sam Example: UC47 form for Room 2',
                      'Council tax arrears - 9 Alder Row',
                      'Pay the HMO licence fee - 9 Alder Row',
                      'Insurance premium payment failed - 9 Alder Row',
                      'MAINTENANCE: Larchmont flats Example Energy landlord supply',
                      'COMPLIANCE: energy performance certificate - 9 Alder Row')]}))`, { dispatch: true });
    expect(r.ids).toEqual(['recwWvBju2ycB63i4', 'rec7aHLK1Q8fMLRXH', 'recjh6mmaF8KJW8t3']);
    expect(r.to).toEqual(['Cash Flow Voids', 'Cash Flow Voids', 'Supplier and Creditor Manager',
      'Supplier and Creditor Manager', 'Property Administration', 'Property Administration', 'Cash Flow Voids',
      'Supplier and Creditor Manager', 'Property Administration', 'Supplier and Creditor Manager',
      'Supplier and Creditor Manager', 'Property Administration']);
  });
  it('placing a tenant stays with Roy: viewings and the move-in are in person', () => {
    for (const n of ['Room 2: sign a tenant', 'Find tenants for Room 3 if confirmed empty', 'Let Unit 1 and get the tenant into payment',
      'Find a tenant for Room 4', 'Find new tenants for the house', 'Sign the new tenant for Room 5']) {
      expect(cls(n)[0], n).toBe('keep');
    }
  });
  it('a Maintenance Ticket stays, whatever its name', () => {
    expect(cls('Send the invoice', ", rr.F['maintenance']: True")[0]).toBe('keep');
  });
  it('a physical step stays: visit, access, photograph, measure, clear, repair, keys, viewings, a call', () => {
    for (const n of ['Visit 9 Alder Row to photograph the consumer unit', 'Give access for the gas engineer',
      'Measure the bedrooms', 'Clear the garden', 'Repair the fence', 'Collect the keys', 'Book viewings for Room 2',
      'Exampletown people to call']) {
      expect(cls(n)[0], n).toBe('keep');
    }
  });
  it("Roy's own sign-in stays", () => {
    expect(cls('Open your dashboard and sign in')[0]).toBe('keep');
  });
  it('a step another script hands Roy by design stays (read from that script, not a copy)', () => {
    const r = py(`print(json.dumps(rr.chain_names()))`);
    expect(r[0]).toContain('TENANT VIEWINGS:');
    expect(r[0]).toContain('NEW TENANT RENT:');
    expect(cls('TENANT REFERRAL CHECK: Exampletown tenants to ask')[0]).toBe('keep');
  });
  it('a repair-lane name with a repair word stays; one without moves, flagged for a check', () => {
    expect(cls('MAINTENANCE: hallway fire alarm still beeping')[0]).toBe('keep');
    expect(cls('MAINTENANCE: supplier invoice raised - review and advise')).toEqual(
      ['move', 'repair-lane name with no ticket tick and no repair word: check before --apply']);
  });
  it('Approval stays (Kevin moves it); a task put back to Roy after a move stays', () => {
    expect(cls('Quote from Example Plumbing', ", rr.F['status']: 'Approval'")[0]).toBe('keep');
    expect(cls('Quote from Example Plumbing', `, rr.F['notes']: 'x ' + rr.NOTE_TEXT`)[0]).toBe('keep');
  });
  it('the move: Roy out, the agent in, other links kept, Assignee cleared only when it is Roy, one Notes line', () => {
    const r = py(`
roy = {rr.F['team']: [rr.ROY_REC, 'recOTHER'], rr.F['assignee']: {'email': rr.ROY_EMAIL}, rr.F['notes']: 'old note'}
kev = {rr.F['team']: [rr.ROY_REC], rr.F['assignee']: {'email': 'someone@example.com'}, rr.F['notes']: ''}
a, b = rr.new_fields(roy, '07 Oct 2026'), rr.new_fields(kev, '07 Oct 2026')
print(json.dumps({'a': a, 'b': b}))`);
    expect(r.a.flduCtmQGpOA4eWaj).toEqual(['recOTHER', 'recwWvBju2ycB63i4']);
    expect(r.a).toHaveProperty('fldELMncVJYPDRJNc', null);
    expect(r.a.fldR7apBzSp3oxFxz).toBe('old note\n\n[07 Oct 2026 — reroute] Admin moved to the agent under the 5 Oct 2026 ruling; Roy keeps the physical step.');
    expect(r.b).not.toHaveProperty('fldELMncVJYPDRJNc');
    expect(r.b.fldR7apBzSp3oxFxz).toMatch(/^\[07 Oct 2026 — reroute\]/);
  });
});

function reroute({ apply = false, second = null, notes = "'a note'", fresh = '' } = {}) {
  return py(`
import io, contextlib
def rows(extra=()):
    base = [{'id': 'recFILL%03d' % i, 'fields': {rr.F['name']: 'filler %d' % i}} for i in range(60)]
    base += [{'id': 'recADMIN00000001', 'fields': {rr.F['name']: 'COMPLIANCE: GSC quote reply - 9 Alder Row', rr.F['team']: [rr.ROY_REC],
                                                 rr.F['assignee']: {'email': rr.ROY_EMAIL}, rr.F['notes']: ${notes}}},
             {'id': 'recREPAIR0000001', 'fields': {rr.F['name']: 'Fix the gate', rr.F['team']: [rr.ROY_REC], rr.F['maintenance']: True}}]
    return base + list(extra)
reads = [rows(), ${second || 'rows()'}]
patches, gets = [], []
store = {r['id']: dict(r['fields']) for r in rows()}
${fresh}
def request(method, path, body=None):
    if method == 'GET' and '?' in path and 'filterByFormula' in path:
        return {'records': reads.pop(0) if reads else rows()}
    tid = path.split('/')[2].split('?')[0]
    if method == 'GET':
        gets.append(tid)
        return {'fields': store[tid]}
    patches.append((tid, body))
    store[tid].update({k: v for k, v in body['fields'].items() if v is not None})
    if body['fields'].get(rr.F['assignee'], 1) is None:
        store[tid].pop(rr.F['assignee'], None)
    return {'id': tid}
rr.request = request
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = rr.main(${apply ? "['--apply']" : '[]'})
print(json.dumps({'code': code, 'patched': [p[0] for p in patches], 'out': buf.getvalue()}))`);
}

describe('reroute-roy-admin: the run', () => {
  it('a dry run prints the expected count and the list, and writes nothing', () => {
    const r = reroute();
    expect(r.code).toBe(0);
    expect(r.patched).toEqual([]);
    expect(r.out).toMatch(/^EXPECT: 2 open tasks linked to Roy; 1 to move to an agent, 1 stay with Roy\./);
    expect(r.out).toContain('recADMIN00000001');
    expect(r.out).toContain('DRY RUN: nothing written');
  });
  it('a second read that differs stops the run with nothing written', () => {
    const r = reroute({ apply: true, second: "rows([{'id': 'recNEW0000000001', 'fields': {rr.F['name']: 'COMPLIANCE: new', rr.F['team']: [rr.ROY_REC]}}])" });
    expect(r.code).toBe(2);
    expect(r.patched).toEqual([]);
    expect(r.out).toContain('STOP: the second read differs');
  });
  it('--apply moves only the admin task and reads it back', () => {
    const r = reroute({ apply: true });
    expect(r.code).toBe(0);
    expect(r.patched).toEqual(['recADMIN00000001']);
    expect(r.out).toContain('MOVED: 1 of 1.');
  });
  it('when no task linked to Roy came back with any Notes, the read may be blind: stop rather than append', () => {
    const r = reroute({ apply: true, notes: "''" });
    expect(r.code).toBe(2);
    expect(r.patched).toEqual([]);
    expect(r.out).toContain('could wipe Notes');
  });
  it('a task whose list read had Notes but whose fresh read is blank is not written', () => {
    const r = reroute({ apply: true, fresh: "store['recADMIN00000001'][rr.F['notes']] = ''" });
    expect(r.code).toBe(1);
    expect(r.patched).toEqual([]);
    expect(r.out).toContain('Notes read blank on the fresh read');
  });
});
