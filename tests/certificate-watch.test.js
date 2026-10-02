import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

// A certificate that was paid for must reach the compliance book, and must never be
// bought twice (Kevin, 2 Oct 2026).
//
// Two were missed. A gas safety record came in on 16 Sep on a task named for its
// INVOICE: the agent checked the payment three times, wrote "no certificate filed" in
// its own output and closed the task. An electrical report came in on 24 Aug and Inbox
// Triage filed it under a label with no task; the book later got a 753-byte placeholder
// that counted as a document. The book read "missing" for 18 days after a paid visit.
//
// These drive the REAL functions in scripts/agent-dispatch.py, scripts/inbound-triage.py
// and scripts/certificate_watch.py, with the Airtable calls stubbed. Each was back-tested
// by removing the mechanism it guards. Fixtures are shaped from the two real cases with
// generic names: this repo is public.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const TRIAGE = resolve(ROOT, 'scripts/inbound-triage.py');
const WATCH = resolve(ROOT, 'scripts/certificate_watch.py');
const STATE = mkdtempSync(join(tmpdir(), 'cert-watch-'));

// Runs a snippet inside the real dispatch module. `m` is the module; print one JSON line.
function py(snippet) {
  const script = `
import importlib.util, json, sys, types
sys.argv = ['agent-dispatch.py']
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.STATE_DIR = ${JSON.stringify(STATE)}
AF = m.AF

def task(name, desc='', notes='', attachments=None, outcome='Approved as-is'):
    return {'id': 'recTASK0000000001', 'fields': {
        AF['name']: name, AF['description']: desc, AF['notes']: notes,
        AF['approvalOutcome']: outcome,
        AF['attachments']: attachments or []}}

def run(fn):
    """(exit message or None, patches made)"""
    patches = []
    m.patch_task = lambda tid, fields: patches.append(fields)
    m.ledger_append = lambda *a, **k: None
    try:
        fn()
        return None, patches
    except SystemExit as e:
        return str(e), patches

def complete_args(**kw):
    return types.SimpleNamespace(task='recTASK0000000001', keep_open=False, note='',
                                 no_certificate=kw.get('no_certificate', ''))
${snippet}
`;
  // The command under test prints its own line too: the snippet's answer is the last one.
  const lines = execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

const INVOICE_TASK = `task('INBOUND: process LGSR invoice', 'Gas safety record and invoice attached.', attachments=[{'filename': 'house.jpeg', 'url': 'https://example.invalid/a'}])`;

describe('the rules module', () => {
  it('its own selftest passes', () => {
    const out = execFileSync('python3', [WATCH, 'selftest'], { encoding: 'utf8' });
    expect(out).toMatch(/selftest: \d+ checks passed/);
  });
});

describe('a task that received a certificate cannot close until it is filed', () => {
  it('the 16 Sep shape is refused: an invoice task, a file attached, nothing in the book', () => {
    const r = py(`
m.get_task = lambda tid: ${INVOICE_TASK}
m.fetch_certificates = lambda refresh=False: []
err, patches = run(lambda: m.cmd_complete(complete_args()))
print(json.dumps({'err': err, 'closed': any(p.get(AF['status']) == 'Completed' for p in patches)}))`);
    expect(r.err).toContain('names a certificate');
    expect(r.err).toContain('agent-dispatch.py certificate');
    expect(r.closed).toBe(false);
  });

  it('control: the same task closes once its certificate, with a real file, is linked', () => {
    const r = py(`
m.get_task = lambda tid: ${INVOICE_TASK}
m.fetch_certificates = lambda refresh=False: [{'taskIds': ['recTASK0000000001'], 'hasFile': True}]
err, patches = run(lambda: m.cmd_complete(complete_args()))
print(json.dumps({'err': err, 'closed': any(p.get(AF['status']) == 'Completed' for p in patches)}))`);
    expect(r.err).toBe(null);
    expect(r.closed).toBe(true);
  });

  it('a linked row holding only a placeholder does not count', () => {
    const r = py(`
m.get_task = lambda tid: ${INVOICE_TASK}
row = m.cert_view({'id': 'recC', 'createdTime': '2026-09-03T10:00:00.000Z', 'fields': {
    m.CERT_FIELDS['attachments']: [{'filename': 'House-EICR-PLACEHOLDER.pdf', 'size': 753}],
    m.CERT_FIELDS['tasks']: ['recTASK0000000001']}})
m.fetch_certificates = lambda refresh=False: [row]
err, patches = run(lambda: m.cmd_complete(complete_args()))
print(json.dumps({'err': err, 'hasFile': row['hasFile'], 'created': row['created']}))`);
    expect(r.hasFile).toBe(false);
    expect(r.created).toBe('2026-09-03');
    expect(r.err).toContain('names a certificate');
  });

  it('a declared reason closes it, and the reason is written to the task', () => {
    const r = py(`
m.get_task = lambda tid: ${INVOICE_TASK}
m.fetch_certificates = lambda refresh=False: []
err, patches = run(lambda: m.cmd_complete(complete_args(no_certificate='it is a quote, not a certificate')))
notes = ' '.join(str(p.get(AF['notes'], '')) for p in patches)
print(json.dumps({'err': err, 'notes': notes, 'closed': any(p.get(AF['status']) == 'Completed' for p in patches)}))`);
    expect(r.err).toBe(null);
    expect(r.notes).toContain('NO CERTIFICATE TO FILE: it is a quote, not a certificate');
    expect(r.closed).toBe(true);
  });

  it('an unreadable book refuses rather than reading as nothing owed', () => {
    const r = py(`
m.get_task = lambda tid: ${INVOICE_TASK}
def boom(refresh=False): raise RuntimeError('Airtable 503')
m.fetch_certificates = boom
err, patches = run(lambda: m.cmd_complete(complete_args()))
print(json.dumps({'err': err, 'closed': any(p.get(AF['status']) == 'Completed' for p in patches)}))`);
    expect(r.err).toContain('could not be read');
    expect(r.closed).toBe(false);
  });

  it('control: an ordinary task with an attachment and no certificate words closes untouched', () => {
    const r = py(`
m.get_task = lambda tid: task('INBOUND: reply about the boiler repair', 'Photo attached.', attachments=[{'filename': 'p.jpg', 'url': 'x'}])
m.fetch_certificates = lambda refresh=False: []
err, patches = run(lambda: m.cmd_complete(complete_args()))
print(json.dumps({'err': err, 'closed': any(p.get(AF['status']) == 'Completed' for p in patches)}))`);
    expect(r.err).toBe(null);
    expect(r.closed).toBe(true);
  });
});

const BOOK = `
m.fetch_properties = lambda refresh=False: [{'id': 'pA', 'short': '9 Test Place'}, {'id': 'pB', 'short': '4 Other Road'}]
m.property_agent_paused = lambda: False
PAY = {'id': 'recTX000000000009', 'date': '2026-09-21', 'amount': -90.0, 'name': 'Gas visit 9 Test', 'costIds': [], 'propertyIds': ['pA']}
CERT = {'id': 'c1', 'propertyIds': ['pA'], 'type': 'GSC', 'hasFile': True, 'created': '2026-09-16', 'renewalDate': '2027-09-14', 'status': 'Active', 'taskIds': []}
m.today_london = lambda: '2026-10-02'
m.query_records = lambda *a, **k: [{'id': 'any'}]
SEEN = {}
m.filing_tasks_by_transaction = lambda: SEEN
`;

describe('a compliance payment with no certificate filed raises a filing task', () => {
  it('the 21 Sep shape: paid, nothing in the book, one task raised, and only once', () => {
    const r = py(`${BOOK}
m.fetch_compliance_payments = lambda: [PAY]
m.fetch_certificates = lambda refresh=False: [dict(CERT, propertyIds=['pB'])]
raised = []
def raise_it(name, team, est, desc, **k):
    raised.append({'name': name, 'team': team, 'desc': desc})
    # What the next run reads back from Airtable: the transaction id, parsed from
    # the description the way the engine itself parses it.
    SEEN[m.FILING_TX_RE.search(desc).group(1)] = 'raised'
m.raise_engine_task = raise_it
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    m.ensure_paid_certificates_filed()
    first = len(raised)
    m.ensure_paid_certificates_filed()
print(json.dumps({'first': first, 'total': len(raised), 'name': raised[0]['name'], 'team': raised[0]['team'] == m.PROPERTY_REC_ID,
                  'marked': m.ENGINE_FILING_MARK in raised[0]['desc']}))`);
    expect(r.first).toBe(1);
    expect(r.total).toBe(1);
    expect(r.name).toBe('COMPLIANCE: file the certificate paid for on 2026-09-21 - 9 Test Place');
    expect(r.team).toBe(true);
    expect(r.marked).toBe(true);
  });

  it('control: a certificate filed around the payment raises nothing', () => {
    const r = py(`${BOOK}
m.fetch_compliance_payments = lambda: [PAY]
m.fetch_certificates = lambda refresh=False: [CERT]
raised = []
m.raise_engine_task = lambda *a, **k: raised.append(a)
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    m.ensure_paid_certificates_filed()
print(json.dumps({'raised': len(raised)}))`);
    expect(r.raised).toBe(0);
  });

  it('a payment with no property on it gets a task too, never a silent skip', () => {
    const r = py(`${BOOK}
m.fetch_compliance_payments = lambda: [dict(PAY, id='recTX000000000008', propertyIds=[])]
m.fetch_certificates = lambda refresh=False: [CERT]
raised = []
m.raise_engine_task = lambda name, *a, **k: raised.append(name)
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    m.ensure_paid_certificates_filed()
print(json.dumps({'raised': raised}))`);
    expect(r.raised).toHaveLength(1);
    expect(r.raised[0]).toContain('property not recorded');
  });

  it('the filing tasks are the record: one answered "not a certificate" stops being raised or held against the house', () => {
    const r = py(`${BOOK}
rows = [
  {'id': 't1', 'fields': {AF['description']: 'x ' + m.ENGINE_FILING_MARK + ' y (transaction recTX000000000001), z', AF['notes']: 'n\\n' + m.certificate_watch.NO_CERTIFICATE_MARK + ' it was a repair'}},
  {'id': 't2', 'fields': {AF['description']: m.ENGINE_FILING_MARK + ' (transaction recTX000000000002)', AF['notes']: ''}},
  {'id': 't3', 'fields': {AF['description']: 'no transaction named', AF['notes']: ''}},
]
m.query_records = lambda *a, **k: rows
import importlib
state = importlib.util.spec_from_file_location  # keep the real function: undo the stub
spec2 = importlib.util.spec_from_file_location('d2', ${JSON.stringify(DISPATCH)})
real = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(real)
real.query_records = lambda *a, **k: rows
by_tx = real.filing_tasks_by_transaction()
m.fetch_compliance_payments = lambda: [dict(PAY, id='recTX000000000001'), dict(PAY, id='recTX000000000002')]
m.fetch_certificates = lambda refresh=False: [dict(CERT, propertyIds=['pB'])]
unfiled, unplaced, read = m.paid_certificate_gaps(by_tx)
print(json.dumps({'by_tx': by_tx, 'unfiled': [p['id'] for p in unfiled]}))`);
    expect(r.by_tx).toEqual({ recTX000000000001: 'resolved', recTX000000000002: 'raised' });
    expect(r.unfiled).toEqual(['recTX000000000002']);
  });

  it('fails loudly when the compliance sub-category matches nothing at all', () => {
    const r = py(`${BOOK}
m.fetch_compliance_payments = lambda: []
m.query_records = lambda *a, **k: []
m.fetch_certificates = lambda refresh=False: [CERT]
err, _ = run(lambda: m.paid_certificate_gaps())
print(json.dumps({'err': err}))`);
    expect(r.err).toContain('control failed');
  });

  it('verify holds an engine-raised filing task to the certificate gate, and excuses one closed on the record', () => {
    // Structural, like the existing renewal-mark test: cmd_verify needs a whole run report to drive.
    const src = execFileSync('cat', [DISPATCH], { encoding: 'utf8' });
    const gate = src.slice(src.indexOf('compliance_closes = []'), src.indexOf('if kind == "carry_out":'));
    expect(gate).toMatch(/ENGINE_FILING_MARK in str\(live\["description"\]/);
    expect(gate).toMatch(/NO_CERTIFICATE_MARK in str\(live\["notes"\]/);
  });
});

describe('the other ways a task closes are held to the same rule', () => {
  it("triage's CERTIFICATE ATTACHED marker makes an invoice task owe the filing", () => {
    const r = py(`
m.fetch_certificates = lambda refresh=False: []
tf = {AF['name']: 'INBOUND: pay invoice 1042 - heating engineer', AF['description']: 'CERTIFICATE ATTACHED. Invoice for the annual gas safety check.', AF['notes']: '', AF['attachments']: []}
other = {AF['name']: 'COMPLIANCE: file certificate - EICR - house', AF['description']: 'CERTIFICATE MENTIONED, NO ATTACHMENT. Roy says it was done.', AF['notes']: '', AF['attachments']: []}
print(json.dumps({'owed': m.task_fields_owe_certificate('recT', tf), 'mentioned': m.task_fields_owe_certificate('recT', other)}))`);
    expect(r.owed).toContain('names a certificate');
    expect(r.mentioned).toBe('');
  });

  it('a filing task the engine raised cannot close as "nothing to decide"', () => {
    // Second review, 2 Oct 2026: its own wording names no document type, so it slipped the gate,
    // stayed "raised" for ever, and the payment went on blocking purchases for that house.
    const r = py(`
ENGINE = task('COMPLIANCE: file the certificate paid for on 2026-09-21 - 9 Test Place', 'PROPERTY COMPLIANCE — ' + m.ENGINE_FILING_MARK + '. A payment left the bank (transaction recTX000000000009).')
m.get_task = lambda tid: ENGINE
m.fetch_certificates = lambda refresh=False: []
err, patches = run(lambda: m.cmd_complete(complete_args()))
m.fetch_certificates = lambda refresh=False: [{'taskIds': ['recTASK0000000001'], 'hasFile': True}]
err2, patches2 = run(lambda: m.cmd_complete(complete_args()))
print(json.dumps({'err': err, 'err2': err2, 'owedOnSubmit': m.task_fields_owe_certificate('recTASK0000000001', ENGINE['fields']) == ''}))`);
    expect(r.err).toContain('no certificate');
    expect(r.err2).toBe(null);
    expect(r.owedOnSubmit).toBe(true); // settled once the certificate is linked
  });

  it('--no-certificate with --keep-open is refused, never silently dropped', () => {
    const r = py(`
m.get_task = lambda tid: ${INVOICE_TASK}
args = types.SimpleNamespace(task='recTASK0000000001', keep_open=True, note='x', no_certificate='it is a quote')
err, patches = run(lambda: m.cmd_complete(args))
print(json.dumps({'err': err, 'patches': len(patches)}))`);
    expect(r.err).toContain('Use one');
    expect(r.patches).toBe(0);
  });

  it('a filing task closed WITH its certificate resolves the payment, whatever the row is dated or typed', () => {
    const r = py(`${BOOK}
rows = [{'id': 'recFILINGTASK00001', 'fields': {AF['description']: m.ENGINE_FILING_MARK + ' (transaction recTX000000000009)', AF['notes']: ''}}]
import importlib
spec2 = importlib.util.spec_from_file_location('d2', ${JSON.stringify(DISPATCH)})
real = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(real)
real.query_records = lambda *a, **k: rows
# An OLD twin row of another type, which date-and-type matching alone would never accept.
old_row = dict(CERT, type='Fire Alarm Cert', created='2025-01-01', taskIds=['recFILINGTASK00001'])
real.fetch_certificates = lambda refresh=False: [old_row]
by_tx = real.filing_tasks_by_transaction()
m.fetch_compliance_payments = lambda: [dict(PAY, name='ABC Gas and Fire')]
m.fetch_certificates = lambda refresh=False: [old_row]
unfiled, _u, _r = m.paid_certificate_gaps(by_tx)
print(json.dumps({'by_tx': by_tx, 'unfiled': len(unfiled)}))`);
    expect(r.by_tx).toEqual({ recTX000000000009: 'resolved' });
    expect(r.unfiled).toBe(0);
  });

  it('an ordinary close never reads the compliance book', () => {
    const r = py(`
calls = []
def book(refresh=False):
    calls.append(1); return []
m.fetch_certificates = book
m.get_task = lambda tid: task('INBOUND: reply about the boiler repair', 'Photo attached.', attachments=[{'filename': 'p.jpg', 'url': 'x'}])
err, patches = run(lambda: m.cmd_complete(complete_args()))
print(json.dumps({'err': err, 'bookReads': len(calls)}))`);
    expect(r.err).toBe(null);
    expect(r.bookReads).toBe(0);
  });

  it('a report that files itself, and a Level A close, both stand down when a filing is owed', () => {
    const src = execFileSync('cat', [DISPATCH], { encoding: 'utf8' });
    const submit = src.slice(src.indexOf('def cmd_submit(args):'), src.indexOf('def cmd_complete(args):'));
    expect(submit).toMatch(/cert_owed = task_fields_owe_certificate\(args\.task, tf\)\s+if cert_owed:\s+files_itself = False/);
    // Any Level A carry-out that would end the task Completed is demoted to a card.
    expect(submit).toMatch(/if cert_owed and level\["level"\] == AUTONOMY_ACT and level\.get\("carry"\) != "roy"[\s\S]{0,400}level = dict\(level, level=AUTONOMY_APPROVE/);
    // Roy's word does not close a task that owes a filing either.
    const roy = execFileSync('cat', [resolve(ROOT, 'scripts/roy-assistant.py')], { encoding: 'utf8' });
    expect(roy).toMatch(/owed = ad\.task_fields_owe_certificate\(args\.target, tf\)\s+if owed:[\s\S]{0,200}sys\.exit/);
    expect(roy).toMatch(/"maintenanceTicket",\s+"attachments"\)/); // the gate must see the file on Roy's task
    // And triage's own "Kevin replied himself" close skips a certificate task.
    const skill = execFileSync('cat', [resolve(ROOT, '.claude/scheduled-tasks/inbound-email-triage/SKILL.md')], { encoding: 'utf8' });
    expect(skill).toMatch(/NEVER close a task whose Description carries `CERTIFICATE ATTACHED`/);
  });

  it('the write path refuses a placeholder file', () => {
    const r = py(`
import os, tempfile
d = tempfile.mkdtemp(); small = os.path.join(d, 'House-EICR.pdf'); open(small, 'w').write('x' * 700)
args = types.SimpleNamespace(task='recTASK0000000001', type='EICR', renewal='2031-08-15', file=small, property='pA', unit=None, note=None)
err, _ = run(lambda: m.cmd_certificate(args))
print(json.dumps({'err': err}))`);
    expect(r.err).toContain('placeholder');
  });
});

describe('a quote or booking is refused when the certificate is already held or already paid for', () => {
  const judge = (cert, pays, name, output, subject = '') => py(`${BOOK}
m.fetch_compliance_payments = lambda: ${pays}
m.fetch_certificates = lambda refresh=False: ${cert}
print(json.dumps({'why': m.certificate_purchase_problem(${JSON.stringify(name)}, ${JSON.stringify(output)}, ${JSON.stringify(subject)})}))`);

  it('held and in date: a gas booking through Roy is refused', () => {
    const r = judge('[CERT]', '[]', 'COMPLIANCE: GSC renewal - 9 Test Place', 'PASS TO ROY: book the gas safety check');
    expect(r.why).toContain('already holds this certificate');
  });
  it('paid for and not filed: a quote request for the same house is refused', () => {
    const r = judge('[dict(CERT, propertyIds=["pB"])]', '[PAY]', 'COMPLIANCE: EICR quote - 9 Test Place', 'TO: a@b.co\nSUBJECT: Quote request', 'Quote request: EICR');
    expect(r.why).toContain('has no certificate filed against it');
  });
  it('a tier-1 banner above the booking line does not hide it', () => {
    const r = judge('[CERT]', '[]', 'COMPLIANCE: GSC renewal - 9 Test Place', 'TIER 1 BANNER\n\nPASS TO ROY: book the gas safety check');
    expect(r.why).toContain('already holds this certificate');
  });
  it('a block with per-apartment reports is never told it already holds one', () => {
    const r = judge('[dict(CERT, type="EICR", unitIds=["u1"]), dict(CERT, type="EICR", unitIds=["u2"], renewalDate="2026-10-10")]', '[]',
      'COMPLIANCE: EICR renewal - 9 Test Place (Unit 2)', 'PASS TO ROY: book the EICR');
    expect(r.why).toBe('');
  });
  it("the engine's own filing task can be handed to Roy to ask for the copy", () => {
    // Third review: its own unfiled payment blocked the hand-over that resolves it.
    const r = py(`${BOOK}
m.fetch_compliance_payments = lambda: [PAY]
m.fetch_certificates = lambda refresh=False: [dict(CERT, propertyIds=['pB'])]
name = 'COMPLIANCE: file the certificate paid for on 2026-09-21 - 9 Test Place'
print(json.dumps({'own': m.certificate_purchase_problem(name, 'PASS TO ROY: ask the engineer for the copy', '', 'x ' + m.ENGINE_FILING_MARK + ' (transaction recTX000000000009)'),
                  'other': m.certificate_purchase_problem('COMPLIANCE: EICR quote - 9 Test Place', 'PASS TO ROY: book it', '', 'an ordinary renewal')}))`);
    expect(r.own).toBe('');
    expect(r.other).toContain('has no certificate filed against it');
  });
  it('control: inside the renewal window a booking goes through', () => {
    const r = judge('[dict(CERT, renewalDate="2026-10-20")]', '[]', 'COMPLIANCE: GSC renewal - 9 Test Place', 'PASS TO ROY: book the gas safety check');
    expect(r.why).toBe('');
  });
  it('control: work that is not a purchase step is never judged', () => {
    const r = judge('[CERT]', '[PAY]', 'COMPLIANCE: GSC renewal - 9 Test Place', 'The certificate is filed.');
    expect(r.why).toBe('');
  });
});

describe('Inbox Triage never files certificate mail without a task', () => {
  it('act --do file --label-num 10 is refused with no task id', () => {
    const r = spawnSync('python3', [TRIAGE, 'act', '--id', 'msg1', '--do', 'file', '--label-num', '10', '--reason', 'certificate'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('never filed without a task');
  });
  it('a task name in place of an id is refused too', () => {
    const r = spawnSync('python3', [TRIAGE, 'act', '--id', 'msg1', '--do', 'file', '--label-num', '10', '--task', 'COMPLIANCE: file certificate', '--reason', 'x'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('never filed without a task');
  });
  it('the live instructions no longer call label 10 a file-only lane', () => {
    const skill = execFileSync('cat', [resolve(ROOT, '.claude/scheduled-tasks/inbound-email-triage/SKILL.md')], { encoding: 'utf8' });
    expect(skill).toContain('Step 4c');
    expect(skill).not.toContain('its own\n  agent is being built');
  });
});
