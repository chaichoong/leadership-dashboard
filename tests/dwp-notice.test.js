// A DWP or Universal Credit notice reaches the tenancy record in code (finding 20261118-agent-dispatch-1353).
//
// Until 19 Nov 2026 a "Universal Credit Direct Payment Arrangement started" notice and a DWP "Housing costs"
// email to info@ were filed by the triage robot as "answered" and the fact never reached the tenancy: whether
// it did depended on the agent's view of each message. Now the scan reads the tenant and the decision off the
// full body into the scan cache, and every triage act and note calls dwp_notice.record_from_triage, which posts
// ONE comment on the one matching live tenancy or raises ONE "RENT CHECK:" task, never a guess.
//
// The independent review of the first build (19 Nov 2026) found eight more ways to get it wrong; each has its
// own describe block below and fails on the code before the fix.
//
// These drive the REAL scripts/dwp_notice.py and scripts/inbound-triage.py with Airtable swapped out at the
// function level (fetch_all, _api, _get_all, create_task) over a fake board and fake tenancy comments, and
// Gmail at worker_post. Every name, address, record id and message id below is invented.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const UC = 'donotreply@universal-credit.service.gov.uk';
const AR = 'rec7aHLK1Q8fMLRXH';

const PRELUDE = `
import json, os, re, sys, io, contextlib, tempfile, importlib.util
from datetime import date
box = tempfile.mkdtemp()
os.environ["DWP_NOTICE_LEDGER"] = box + "/ledger.jsonl"
os.environ["INBOUND_TRIAGE_DIR"] = box + "/triage"
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import dwp_notice as d
rc = d._rc()
TODAY = date(2026, 11, 19)
calls = {"reads": [], "comments": [], "tasks": [], "gmail": [], "boardReads": 0, "queuedAtPost": []}
TENANCIES, TENANTS, BOARD, COMMENTS = [], [], [], {}
FAIL = {"post_before": False, "post_after": False, "create_after": False}
def tenant(tid, name):
    TENANTS.append({"id": tid, "fields": {rc.TN["name"]: name}})
def tenancy(tyid, tenant_ids, end=None, status="Active"):
    f = {rc.TY["tenants"]: tenant_ids, rc.TY["tenantStatus"]: [status]}
    if end:
        f[rc.TY["end"]] = end
    TENANCIES.append({"id": tyid, "fields": f})
for i in range(24):
    tenant("recTNFILL%08d" % i, "Pat Filler%s" % chr(65 + i))
    tenancy("recTYFILL%08d" % i, ["recTNFILL%08d" % i])
tenant("recTNALDER0000001", "Jo Alder");  tenancy("recTYALDER0000001", ["recTNALDER0000001"])
tenant("recTNBIRCH0000001", "Sam Birch"); tenancy("recTYBIRCH0000001", ["recTNBIRCH0000001"])
tenant("recTNCEDAR0000001", "Ann Cedar"); tenancy("recTYCEDAR0000001", ["recTNCEDAR0000001"])
tenant("recTNCEDAR0000002", "Ben Cedar"); tenancy("recTYCEDAR0000002", ["recTNCEDAR0000002"])
tenant("recTNELMXX0000001", "Dee Elm");   tenancy("recTYELMXX0000001", ["recTNELMXX0000001"], end="2026-10-31", status="Former")
tenant("recTNELMKIM000001", "Kim Elm");   tenancy("recTYELMKIM000001", ["recTNELMKIM000001"])
tenant("recTNMARCH0000001", "Lee March"); tenancy("recTYMARCH0000001", ["recTNMARCH0000001"])
tenant("recTNOAKXX0000001", "Ray Oak")    # a former tenant on no tenancy at all
tenant("recTNOAKYY0000002", "Vic Oak");   tenancy("recTYOAKYY0000002", ["recTNOAKYY0000002"])
def fetch_all(table, params=None):
    calls["reads"].append(table)
    if table == rc.T_TENANCIES:
        return list(TENANCIES)
    if table == rc.T_TENANTS:
        return list(TENANTS)
    raise AssertionError("unexpected table " + table)
def retry_ids():
    p = d.retry_path()
    return sorted(json.load(open(p))) if os.path.exists(p) else []
def api(method, path, payload=None, params=None):
    m = re.match(r"%s/(rec\\w+)/comments$" % rc.T_TENANCIES, path)
    if m and method == "GET":
        return {"comments": [{"text": t} for t in COMMENTS.get(m.group(1), [])]}
    if m and method == "POST":
        calls["queuedAtPost"].append(retry_ids())
        if FAIL["post_before"]:
            raise RuntimeError("Airtable POST comments 503: service unavailable")
        COMMENTS.setdefault(m.group(1), []).append(payload["text"])
        calls["comments"].append({"tenancy": m.group(1), "text": payload["text"]})
        if FAIL["post_after"]:
            raise TimeoutError("The read operation timed out")
        return {"id": "comX%d" % len(calls["comments"])}
    raise AssertionError("unexpected call " + method + " " + path)
REAL_GET_ALL, REAL_API = d._get_all, d._api
def get_all(table, params):
    if table == rc.T_TASKS:
        calls["boardReads"] += 1
        needle = re.search(r"FIND\\('([^']+)'", params["filterByFormula"]).group(1)
        return [t for t in BOARD if needle in t["fields"].get(rc.TK["notes"], "")]
    raise AssertionError("unexpected read of " + table)
def create_task(fields):
    tid = "recTASKDWP%07d" % (len(BOARD) + 1)
    BOARD.append({"id": tid, "fields": {rc.TK["notes"]: fields["fldR7apBzSp3oxFxz"]}})
    calls["tasks"].append(fields)
    if FAIL["create_after"]:
        raise RuntimeError("Airtable GET /tblqB8b22hKBL4PF1/" + tid + " -> HTTP 429: rate limited")
    return 0, {"action": "created", "taskId": tid}
d.fetch_all, d._api, d._get_all, d.create_task = fetch_all, api, get_all, create_task
def ledger():
    p = os.environ["DWP_NOTICE_LEDGER"]
    return [json.loads(l) for l in open(p).read().splitlines()] if os.path.exists(p) else []
def forget_ledger():
    p = os.environ["DWP_NOTICE_LEDGER"]
    if os.path.exists(p):
        os.remove(p)
def ctx(sender, subject, body):
    return {"sender": d.bare_email(sender), "subject": subject, "internalDate": 1763000000000,
            "dwp": d.cache_entry(subject, body, sender)}
def attempt(fn):
    try:
        return fn(), ""
    except d.RecordError as e:
        return None, str(e)
`;

// Runs PRELUDE + body; the body sets `result`. Returns the parsed result.
function py(body) {
  const r = spawnSync('python3', ['-c', `${PRELUDE}\n${body}\nprint("@@RESULT@@" + json.dumps(result))`],
    { encoding: 'utf8', cwd: ROOT });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@RESULT@@'));
  if (!line) throw new Error(`python failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice('@@RESULT@@'.length));
}

// The two notices in the finding, in their real shape (read from the mailbox on 19 Nov 2026), names invented.
const DIRECT = 'Reference: Direct rent payments\\n\\nDear Kevin Brittain\\n\\nPayment reference: Alder\\n\\n'
  + 'We received your application for direct rent payments for Jo Alder.\\n\\n'
  + 'Your application has been approved and your payment is being set up.\\n\\nThe amount we pay you could vary.\\n\\n'
  + "If your tenant moves out of the property or is no longer receiving Universal Credit, we'll stop making payments "
  + 'to you.\\n\\nThis email address cannot accept replies.';
const HOUSING = 'Hi\\n\\nRegarding housing costs request for Sam Birch. This has been referred to our decision makers. '
  + 'Once we get a response, we will be able to update you further.\\n\\nRegards\\nUniversal Credit\\n\\n'
  + 'This document is strictly confidential and is intended only for use by the addressee.';
const DIRECT_SUMMARY = 'Universal Credit Direct Payment Arrangement started: '
  + 'Your application has been approved and your payment is being set up.';
const SUBJ = 'Universal Credit Direct Payment Arrangement started';

describe('who counts as DWP', () => {
  it('dwp.gov.uk, universal-credit.service.gov.uk and their subdomains, never a look-alike', () => {
    const r = py(`result = [d.is_dwp_notice(s) for s in [
        "${UC}", "Universal Credit <DoNotReply@Universal-Credit.Service.Gov.UK>",
        "EXAMPLETOWN.HOUSING@dwp.gov.uk", "case.team@region.dwp.gov.uk",
        "someone@dwp.gov.uk.example.com", "someone@evil-dwp.gov.uk", "someone@fakedwp.gov.uk",
        "${UC}.example.com", "@dwp.gov.uk", "a@b@dwp.gov.uk", "landlord@example.com", ""]]`);
    expect(r).toEqual([true, true, true, true, false, false, false, false, false, false, false, false]);
  });

  // Review minor 8: any address at the Universal Credit service, not only donotreply@.
  it('any address at universal-credit.service.gov.uk or a subdomain counts', () => {
    const r = py(`result = [d.is_dwp_notice(s) for s in [
        "noreply@universal-credit.service.gov.uk", "alerts@mail.universal-credit.service.gov.uk",
        "x@universal-credit.service.gov.uk.example.com", "x@evil-universal-credit.service.gov.uk"]]`);
    expect(r).toEqual([true, true, false, false]);
  });

  // Review minor 5: the address in the display name never counts.
  it('the sender is read off the raw From header, so a display-name address is refused', () => {
    const r = py(`result = [d.is_dwp_notice(s) for s in [
        "${UC} <evil@example.com", "Universal Credit ${UC} via evil@example.com",
        '"${UC}" <evil@example.com>']]`);
    expect(r).toEqual([false, false, false]);
  });
});

describe('what a notice says', () => {
  it('reads the tenant from the reference, the direct-payment line, a request line, and a Re: or Dear line not to us', () => {
    const r = py(`result = [d.tenant_name(s, b) for s, b in [
        ("${SUBJ}", "${DIRECT}"),
        ("Housing costs", "${HOUSING}"),
        ("x", "Payment reference: Alder\\nYour arrangement has stopped."),
        ("x", "We have approved direct rent payments for Sam O'Neil-Hart at 12 Example Road."),
        ("Underpayment for Kim Ash", "Please see the attached letter."),
        ("x", "Dear Agile Lets,\\n\\nRe: Sam Birch\\n\\nThe claim has been approved."),
        ("x", "Dear Mr J. Birch,\\nYour claim was approved."),
        ("x", "Payment reference: BIRCH J, approved"),
        ("RE: 12 Example Road", "Dear Kevin,\\nThanks, noted."),
        ("x", "Dear Sir/Madam,\\nRe: Housing costs\\nWe have approved direct rent payments for the property."),
        ("x", "Dear Agile Lets,\\nYour request for the property was returned."),
        ("x", "Payment reference: AB123456C"),
    ]]`);
    expect(r).toEqual(['Jo Alder', 'Sam Birch', 'Alder', "Sam O'Neil-Hart", 'Kim Ash', 'Sam Birch', 'J Birch',
      'BIRCH J', '', '', '', '']);
  });

  it('the summary is the subject and the first decision sentence, at most 300 characters', () => {
    const r = py(`result = [d.summary("Housing costs", "${HOUSING}"),
                            d.summary("${SUBJ}", "${DIRECT}"),
                            len(d.summary("S" * 60, "Your request was approved " + "x" * 500)),
                            d.summary("Nothing decided", "Hello. Thank you for your email.")]`);
    expect(r[0]).toBe('Housing costs: This has been referred to our decision makers.');
    expect(r[1]).toBe(DIRECT_SUMMARY);
    expect(r[2]).toBe(300);
    expect(r[3]).toBe('Nothing decided');
  });

  // Review fix 2: two different names in one notice, or a name the cleaner drops, is never read as one tenant.
  it('every name is read: two people, or a name it cannot read cleanly, is unsure, never part of a name', () => {
    const r = py(`result = [d.read_names(s, b) for s, b in [
        ("RE: Housing costs request for Jo Alder", "Regarding housing costs request for Sam Birch. This has been referred to our decision makers."),
        ("${SUBJ}", "Payment reference: Alder\\nWe received your application for direct rent payments for Sam Birch."),
        ("${SUBJ}", "Payment reference: Alder\\nWe received your application for direct rent payments for Will Alder."),
        ("${SUBJ}", "Payment reference: Alder\\nWe received your application for direct rent payments for Kevin Alder."),
        ("x", "We have approved direct rent payments for Jo Alder and Sam Birch."),
        ("x", "Payment reference: Alder\\nWe received your application for direct rent payments for Sam Alder.\\nDear Jo Alder"),
    ]]`);
    expect(r.map((x) => x.tenant)).toEqual(['', '', '', '', '', '']);
    expect(r[0].unsure).toMatch(/more than one person \(Jo Alder, Sam Birch\)/);
    expect(r[1].unsure).toMatch(/more than one person \(Alder, Sam Birch\)/);
    expect(r[2].unsure).toMatch(/"Will Alder", which the robot could not read/);
    expect(r[3].unsure).toMatch(/"Kevin Alder"/);
    expect(r[4].unsure).toMatch(/"Jo Alder and Sam Birch"/);
    expect(r[5].unsure).toMatch(/more than one person/);
  });

  // Review minor 7: a month or a weekday is never a surname.
  it('a month or weekday is never read as a surname', () => {
    const r = py(`result = [d.read_names(s, b) for s, b in [
        ("x", "Payment reference: March"),
        ("x", "We have approved direct rent payments for Monday 3 November."),
        ("x", "We have approved direct rent payments for Jo March."),
    ]]`);
    expect(r[0]).toMatchObject({ tenant: '', unsure: '' });
    expect(r[1]).toMatchObject({ tenant: '', unsure: '' });
    expect(r[2].tenant).toBe('');
    expect(r[2].unsure).toMatch(/"Jo March"/);
  });
});

describe('record: one comment on the one live tenancy, else one task', () => {
  it('a Payment reference direct-payment notice comments on the one matching live tenancy', () => {
    const r = py(`
out = d.record("m1", ctx("${UC}", "${SUBJ}", "${DIRECT}"), TODAY)
result = {"out": out, "calls": calls, "ledger": ledger()}`);
    expect(r.out.done).toBe('commented');
    expect(r.calls.tasks).toEqual([]);
    expect(r.calls.comments).toHaveLength(1);
    expect(r.calls.comments[0].tenancy).toBe('recTYALDER0000001');
    expect(r.calls.comments[0].text).toMatch(new RegExp(
      '^\\d{2} [A-Z][a-z]{2} \\d{4} \\d{2}:\\d{2}: DWP to info@ \\(donotreply@universal-credit\\.service\\.gov\\.uk\\), '
      + 'Universal Credit Direct Payment Arrangement started: Your application has been approved and your payment '
      + 'is being set up\\. Gmail m1\\.$'));
    expect(r.ledger.map((x) => [x.id, x.kind, x.tenancy])).toEqual([['m1', 'comment', 'recTYALDER0000001']]);
  });

  it('a DWP "Housing costs" email naming a tenant comments on that tenancy', () => {
    const r = py(`
out = d.record("m2", ctx("EXAMPLETOWN.HOUSING@dwp.gov.uk", "Housing costs", "${HOUSING}"), TODAY)
result = {"out": out, "calls": calls}`);
    expect(r.out.done).toBe('commented');
    expect(r.calls.comments.map((c) => c.tenancy)).toEqual(['recTYBIRCH0000001']);
    expect(r.calls.comments[0].text).toMatch(/\(exampletown\.housing@dwp\.gov\.uk\), Housing costs: This has been referred to our decision makers\. Gmail m2\.$/);
    expect(r.calls.tasks).toEqual([]);
  });

  it('a surname two live tenancies share makes one task, carrying the message key, and no comment', () => {
    const r = py(`
out = d.record("m3", ctx("${UC}", "${SUBJ}", "Your landlord direct payment arrangement has started.\\nPayment reference: CEDAR"), TODAY)
result = {"out": out, "calls": calls, "ledger": ledger()}`);
    expect(r.out.done).toBe('task');
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks).toHaveLength(1);
    const f = r.calls.tasks[0];
    expect(f.fldgFjGBw6bTKJFCD).toBe('RENT CHECK: DWP notice names CEDAR, match it to a tenancy');
    expect(f.flduCtmQGpOA4eWaj).toEqual([AR]);
    expect(f.fldx4qCw17UfrKpaN).toBe('Today');
    expect(f.fldRGhBQViKZKtkQ6).toMatch(/recTYCEDAR0000001, recTYCEDAR0000002/);
    expect(f.fldRGhBQViKZKtkQ6).toMatch(/2 live tenancies have a tenant with that surname/);
    expect(f.fldRGhBQViKZKtkQ6).toMatch(/Gmail message id: m3/);
    expect(f.fldR7apBzSp3oxFxz).toMatch(/^DWP NOTICE KEY: m3\n/);
    expect(r.ledger.map((x) => [x.id, x.kind, x.task])).toEqual([['m3', 'task', 'recTASKDWP0000001']]);
  });

  it('a full name breaks the tie between two tenants who share a surname', () => {
    const r = py(`
a = d.record("m4", ctx("case.team@region.dwp.gov.uk", "Housing costs", "Dear Agile Lets,\\nRe: Ben Cedar\\nThe claim was approved."), TODAY)
b = d.record("m11", ctx("${UC}", "${SUBJ}", "${DIRECT}".replace("Alder", "Cedar").replace("Jo Cedar", "Ann Cedar")), TODAY)
result = {"done": [a["done"], b["done"]], "calls": calls}`);
    expect(r.done).toEqual(['commented', 'commented']);
    expect(r.calls.comments.map((c) => c.tenancy)).toEqual(['recTYCEDAR0000002', 'recTYCEDAR0000001']);
  });

  it('a notice with no name makes one task, and reads no tenancy', () => {
    const r = py(`
out = d.record("m5", ctx("${UC}", "Universal Credit payment update", "Dear Sir/Madam,\\nYour direct payment arrangement has stopped."), TODAY)
result = {"out": out, "calls": calls}`);
    expect(r.out.done).toBe('task');
    expect(r.calls.reads).toEqual([]);
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks.map((f) => f.fldgFjGBw6bTKJFCD)).toEqual(['RENT CHECK: DWP notice names no tenant, match it to a tenancy']);
  });

  it('a first name the one surname match contradicts is a task, never a guess', () => {
    const r = py(`
b = d.record("m7", ctx("someone@dwp.gov.uk", "Housing costs", "Re: Kim Alder\\nThe claim was approved."), TODAY)
result = {"b": b, "calls": calls}`);
    expect(r.b.done).toBe('task');
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks[0].fldRGhBQViKZKtkQ6).toMatch(/no tenant there has the first name on the notice/);
  });

  it('the same message twice comments once', () => {
    const r = py(`
c = ctx("${UC}", "${SUBJ}", "${DIRECT}")
first = d.record("m1", c, TODAY)
second = d.record("m1", c, TODAY)
result = {"first": first, "second": second, "calls": calls, "ledger": ledger()}`);
    expect(r.first.done).toBe('commented');
    expect(r.second.done).toBe('already');
    expect(r.calls.comments).toHaveLength(1);
    expect(r.ledger).toHaveLength(1);
  });

  it('a non-DWP sender and a look-alike domain do nothing', () => {
    const r = py(`
a = d.record("m8", ctx("landlord.news@example.com", "Universal Credit changes", "Payment reference: ALDER"), TODAY)
b = d.record("m9", ctx("${UC}.example.com", "${SUBJ}", "${DIRECT}"), TODAY)
c = d.record("m10", ctx("housing@dwp.gov.uk.example.com", "Housing costs", "${HOUSING}"), TODAY)
result = {"done": [a["done"], b["done"], c["done"]], "calls": calls, "ledger": ledger()}`);
    expect(r.done).toEqual(['skip', 'skip', 'skip']);
    expect([r.calls.reads, r.calls.comments, r.calls.tasks, r.calls.boardReads]).toEqual([[], [], [], 0]);
    expect(r.ledger).toEqual([]);
  });

  it('a broken Airtable read is NOT CHECKED: no comment, no task, no ledger line', () => {
    const r = py(`
d.fetch_all = lambda table, params=None: TENANTS[:3] if table == rc.T_TENANTS else list(TENANCIES)
out, err = attempt(lambda: d.record("m1", ctx("${UC}", "${SUBJ}", "${DIRECT}"), TODAY))
result = {"out": out, "err": err, "calls": calls, "ledger": ledger()}`);
    expect(r.out).toBeNull();
    expect(r.err).toMatch(/NOT CHECKED: the tenants read returned 3 rows \(expected 20\+\)/);
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks).toEqual([]);
    expect(r.ledger).toEqual([]);
  });

  it('the task goes through the creation gate in process, word fold off, track record bounded, nothing on stdout', () => {
    const r = py(`
import types
seen = {}
fake = types.SimpleNamespace()
def track_record_for(fields, task_id=None, runner=None):
    seen["runner"] = runner is not None
    return "TRACK RECORD: none"
def cmd_create(fields, force=False, dry_run=False, parent=None, owner=None):
    seen.update(force=force, name=fields["fldgFjGBw6bTKJFCD"])
    fake.track_record_for(fields, "recTASKGATE000001")
    print(json.dumps({"action": "created", "taskId": "recTASKGATE000001"}))
    return 0
fake.cmd_create, fake.track_record_for = cmd_create, track_record_for
buf = io.StringIO()
# A fresh copy of the module: the shared one has create_task stubbed by the prelude.
spec = importlib.util.spec_from_file_location("dwp_fresh", ${JSON.stringify(resolve(SCRIPTS, 'dwp_notice.py'))})
fresh = importlib.util.module_from_spec(spec); spec.loader.exec_module(fresh)
fresh._mods["od_catask_for_dwp_notice"] = fake
with contextlib.redirect_stdout(buf):
    code, out = fresh.create_task({"fldgFjGBw6bTKJFCD": "RENT CHECK: DWP notice names no tenant, match it to a tenancy"})
result = {"code": code, "out": out, "seen": seen, "leaked": buf.getvalue(), "timeout": fresh.TRACK_RECORD_TIMEOUT}`);
    expect(r.code).toBe(0);
    expect(r.out.taskId).toBe('recTASKGATE000001');
    expect(r.seen.force).toBe(true);
    expect(r.seen.runner).toBe(true);
    expect(r.timeout).toBeLessThanOrEqual(30);
    expect(r.leaked).toBe('');
  });

  it('why the word fold is off: the gate would fold one tenant\'s DWP task into another\'s', () => {
    const r = py(`
g = d._load("od_catask_for_dwp_notice", "create-agent-task.py")
F = g.F
other = {"id": "recA", "createdTime": "2026-11-01T00:00:00.000Z", "fields": {
    F["name"]: "RENT CHECK: DWP notice names Birch, match it to a tenancy", F["status"]: "Today",
    F["team"]: ["${AR}"], F["inboundSender"]: "${UC}"}}
result = g.decide({F["name"]: "RENT CHECK: DWP notice names Alder, match it to a tenancy", F["team"]: ["${AR}"],
                   F["inboundSender"]: "${UC}"}, [other])["action"]`);
    // If this ever reads "create", the gate tells two tenants apart and dwp_notice.create_task can drop force.
    expect(r).toBe('update');
  });
});

// Review fix 1: a surname-only notice where a tenant on no live tenancy shares the surname is a task.
describe('a former tenant with the same name', () => {
  it('a surname-only notice is a task when a former tenant shares the surname, ended tenancy or none', () => {
    const r = py(`
a = d.record("m20", ctx("${UC}", "Payment stopped", "Payment reference: ELM\\nThe arrangement has stopped."), TODAY)
b = d.record("m21", ctx("${UC}", "Payment stopped", "Payment reference: OAK\\nThe arrangement has stopped."), TODAY)
result = {"done": [a["done"], b["done"]], "calls": calls}`);
    expect(r.done).toEqual(['task', 'task']);
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks[0].fldRGhBQViKZKtkQ6).toMatch(/1 tenant on no live tenancy \(a former tenant\) fits it too/);
    expect(r.calls.tasks[0].fldRGhBQViKZKtkQ6).toMatch(/recTYELMKIM000001/);
  });

  it('a full name the former tenant does not share still comments on the live tenancy', () => {
    const r = py(`
out = d.record("m22", ctx("someone@dwp.gov.uk", "Housing costs", "Re: Kim Elm\\nThe claim was approved."), TODAY)
result = {"out": out, "calls": calls}`);
    expect(r.out.done).toBe('commented');
    expect(r.calls.comments.map((c) => c.tenancy)).toEqual(['recTYELMKIM000001']);
  });
});

describe('two names in one notice make a task', () => {
  it('a subject naming one tenant and a body naming another, a reference against a full name, a name it drops', () => {
    const r = py(`
out = [d.record("m30", ctx("someone@dwp.gov.uk", "RE: Housing costs request for Jo Alder",
                          "Regarding housing costs request for Sam Birch. This has been referred to our decision makers."), TODAY),
       d.record("m31", ctx("${UC}", "${SUBJ}", "Payment reference: Alder\\nWe received your application for direct rent payments for Sam Birch.\\nYour application has been approved."), TODAY),
       d.record("m32", ctx("${UC}", "${SUBJ}", "Payment reference: Alder\\nWe received your application for direct rent payments for Will Alder.\\nYour application has been approved."), TODAY)]
result = {"done": [o["done"] for o in out], "calls": calls}`);
    expect(r.done).toEqual(['task', 'task', 'task']);
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks.map((f) => f.fldgFjGBw6bTKJFCD)).toEqual([
      'RENT CHECK: DWP notice names Jo Alder or Sam Birch, match it to a tenancy',
      'RENT CHECK: DWP notice names Alder or Sam Birch, match it to a tenancy',
      'RENT CHECK: DWP notice names Alder or Will Alder, match it to a tenancy']);
  });
});

// Review fix 3: a call that fails after its write landed never makes a second record.
describe('one record per message, whatever fails', () => {
  it('a task the gate raised before it errored is found by its key, and never raised twice', () => {
    const r = py(`
FAIL["create_after"] = True
c = ctx("${UC}", "${SUBJ}", "Payment reference: CEDAR\\nThe arrangement has started.")
first = d.record("m40", c, TODAY)
forget_ledger()
FAIL["create_after"] = False
second = d.record("m40", c, TODAY)
result = {"first": first, "second": second, "board": len(BOARD), "tasks": len(calls["tasks"]), "ledger": ledger()}`);
    expect(r.first).toMatchObject({ done: 'task', task: 'recTASKDWP0000001' });
    expect(r.first.note).toMatch(/reported an error but the task landed/);
    expect(r.second).toMatchObject({ done: 'task', task: 'recTASKDWP0000001' });
    expect(r.second.note).toMatch(/already on the board/);
    expect([r.board, r.tasks]).toEqual([1, 1]);
    expect(r.ledger.map((x) => x.task)).toEqual(['recTASKDWP0000001']);
  });

  it('a comment whose post timed out after landing is found on the tenancy, and never posted twice', () => {
    const r = py(`
FAIL["post_after"] = True
c = ctx("${UC}", "${SUBJ}", "${DIRECT}")
first = d.record("m41", c, TODAY)
forget_ledger()
FAIL["post_after"] = False
second = d.record("m41", c, TODAY)
result = {"first": first, "second": second, "posts": len(calls["comments"]), "onTenancy": len(COMMENTS["recTYALDER0000001"])}`);
    expect(r.first.done).toBe('commented');
    expect(r.first.note).toMatch(/reported an error but it landed/);
    expect(r.second.note).toMatch(/already on the tenancy/);
    expect([r.posts, r.onTenancy]).toEqual([1, 1]);
  });

  it('a ledger that cannot be written is said, and the next attempt still finds the comment', () => {
    const r = py(`
os.environ["DWP_NOTICE_LEDGER"] = "/dev/null/ledger.jsonl"
os.environ["DWP_NOTICE_RETRY"] = box + "/retry.json"
os.environ["DWP_NOTICE_LOCKS"] = box + "/locks"
c = ctx("${UC}", "${SUBJ}", "${DIRECT}")
first = d.record("m42", c, TODAY)
second = d.record("m42", c, TODAY)
result = {"first": first, "second": second, "posts": len(calls["comments"])}`);
    expect(r.first.ledgerProblem).toMatch(/could not be written/);
    expect(r.second.note).toMatch(/already on the tenancy/);
    expect(r.posts).toBe(1);
  });

  it('the board search: a reply with no records list is an error, and m1 never matches a task keyed m10', () => {
    const r = py(`
d._get_all = REAL_GET_ALL
d._api = lambda method, path, payload=None, params=None: {"error": "NOT_FOUND"}
_, err = attempt(lambda: d.keyed_tasks("m1"))
d._api = lambda method, path, payload=None, params=None: {"records": [
    {"id": "recTASKAAAAAAAAA1", "fields": {rc.TK["notes"]: "DWP NOTICE KEY: m10\\nraised"}},
    {"id": "recTASKAAAAAAAAA2", "fields": {rc.TK["notes"]: "DWP NOTICE KEY: m1\\nraised"}}]}
found = d.keyed_tasks("m1")
_, bad = attempt(lambda: d.keyed_tasks("m1') OR TRUE() OR ('"))
result = {"err": err, "found": found, "bad": bad}`);
    expect(r.err).toMatch(/NOT CHECKED: the tblqB8b22hKBL4PF1 read came back with no records list/);
    expect(r.found).toEqual(['recTASKAAAAAAAAA2']);
    expect(r.bad).toMatch(/is not a Gmail message id/);
  });

  it('no new write starts once the triage time budget is spent', () => {
    const r = py(`
out, err = attempt(lambda: d.record("m43", ctx("${UC}", "${SUBJ}", "${DIRECT}"), TODAY, budget=-1))
result = {"err": err, "posts": len(calls["comments"])}`);
    expect(r.err).toMatch(/out of time before reading the tenancy's comments/);
    expect(r.posts).toBe(0);
  });
});

describe('the triage hook', () => {
  const TRIAGE = `
spec = importlib.util.spec_from_file_location("triage_t", ${JSON.stringify(resolve(SCRIPTS, 'inbound-triage.py'))})
t = importlib.util.module_from_spec(spec); sys.modules["triage_t"] = t; spec.loader.exec_module(t)
assert t.dwp_notice is d, "the triage script must use the same dwp_notice module"
t.worker_post = lambda path, body: (calls["gmail"].append([path, body]) or {"modified": 1})
import time
def msg(mid, sender, subject, body, auto_reply=None):
    return {"id": mid, "threadId": "th" + mid, "internalDate": str(int(time.time() * 1000)), "labelIds": ["INBOX"],
            "headers": {"from": sender, "subject": subject}, "body": body, "auto_reply": auto_reply, "reply_state": ""}
def run(fn):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = fn()
    return {"code": code, "stdout": out.getvalue(), "stderr": err.getvalue()}
def digest():
    p = os.path.join(os.environ["INBOUND_TRIAGE_DIR"], "digest-%s.jsonl" % date.today().isoformat())
    return [json.loads(l) for l in open(p).read().splitlines()] if os.path.exists(p) else []
`;

  it('the scan caches the DWP reading off the full body, and only for a DWP sender', () => {
    const r = py(`${TRIAGE}
t.write_scan_cache([msg("m1", "Universal Credit <${UC}>", "${SUBJ}", "${DIRECT}"),
                    msg("m2", "<${UC}.example.com>", "${SUBJ}", "${DIRECT}"),
                    msg("m3", "Landlord News <news@example.com>", "Rent update", "Payment reference: ALDER")])
cache = t.read_scan_cache()
result = {"m1": cache["m1"].get("dwp"), "others": ["dwp" in cache["m2"], "dwp" in cache["m3"]],
          "kept": sorted(cache["m3"])}`);
    expect(r.m1).toEqual({ tenant: 'Jo Alder', summary: DIRECT_SUMMARY, from: UC, decided: true });
    expect(r.others).toEqual([false, false]);
    // No other cache change: a non-DWP entry carries exactly the keys it always did.
    expect(r.kept).toEqual(['ask', 'auto_reply', 'deadline', 'inbox', 'internalDate', 'reply_state', 'sender',
      'subject', 'threadId']);
  });

  // Review minors 5 and 6: a display-name address and a real automatic reply with nothing decided get no
  // DWP reading.
  it('a display-name address and an automatic reply with nothing decided get no DWP reading in the scan', () => {
    const r = py(`${TRIAGE}
ack = "Thank you for your email. We aim to reply within 10 working days."
t.write_scan_cache([msg("m5", "${UC} <evil@example.com", "${SUBJ}", "${DIRECT}"),
                    msg("m6", "Universal Credit ${UC} via evil@example.com", "${SUBJ}", "${DIRECT}"),
                    msg("m7", "Universal Credit <${UC}>", "We have your email", ack, auto_reply="header auto-submitted: auto-replied"),
                    msg("m8", "Universal Credit <${UC}>", "Automatic reply: Housing costs", ack, auto_reply="subject: Automatic reply: Housing costs")])
cache = t.read_scan_cache()
skip = d.plan("m7", dict(ctx("${UC}", "We have your email", ack), auto_reply="header auto-submitted: auto-replied"), TODAY)
result = {"dwp": ["dwp" in cache[k] for k in ("m5", "m6", "m7", "m8")], "plan": skip}`);
    expect(r.dwp).toEqual([false, false, false, false]);
    expect(r.plan).toMatchObject({ do: 'skip' });
    expect(r.plan.why).toMatch(/automatic reply with nothing decided/);
  });

  // Review round 2, fix 1: the scan's receipt-phrase reading ("Thank you for contacting Universal Credit.") must
  // never drop a decision, and a decision sentence keeps even a header-flagged reply.
  it('a decision that opens with a receipt phrase is read, recorded on act, and planned by the back-fill', () => {
    const r = py(`${TRIAGE}
body = "Thank you for contacting Universal Credit. Regarding housing costs request for Sam Birch. This has been approved."
t.write_scan_cache([msg("m9", "Universal Credit <${UC}>", "Housing costs", body, auto_reply="body: thank you for contacting"),
                    msg("m10", "Universal Credit <${UC}>", "Housing costs", body, auto_reply="header auto-submitted: auto-replied")])
cache = t.read_scan_cache()
acted = run(lambda: t.main(["act", "--id", "m9", "--do", "archive", "--reason", "filed"]))
planned = d.plan("m10", cache["m10"], TODAY)
result = {"dwp": ["dwp" in cache[k] for k in ("m9", "m10")], "acted": acted, "comments": calls["comments"], "planned": planned["do"]}`);
    expect(r.dwp).toEqual([true, true]);
    expect(r.acted.code).toBe(0);
    expect(JSON.parse(r.acted.stdout.trim()).dwp).toMatchObject({ done: 'commented', tenancy: 'recTYBIRCH0000001' });
    expect(r.comments.map((c) => c.tenancy)).toEqual(['recTYBIRCH0000001']);
    expect(r.planned).toBe('comment');
  });

  // Review round 4: a receipt phrase above a fact the decision list does not word ("Rent will now be paid to you
  // directly") named a tenant, yet it was skipped as an automatic reply. A body-flagged message that names someone
  // is read and recorded; the header and subject flags still skip when nothing is decided.
  it('a body-flagged receipt that names a tenant is read and recorded, whatever words state the fact', () => {
    const r = py(`${TRIAGE}
body = "We have received your request for Jo Alder. Rent will now be paid to you directly from the next assessment period."
t.write_scan_cache([msg("m81", "Universal Credit <${UC}>", "Managed payment", body, auto_reply="body: we have received your"),
                    msg("m82", "Universal Credit <${UC}>", "Managed payment", body, auto_reply="header auto-submitted: auto-replied")])
cache = t.read_scan_cache()
acted = run(lambda: t.main(["act", "--id", "m81", "--do", "archive", "--reason", "filed"]))
result = {"dwp": ["dwp" in cache[k] for k in ("m81", "m82")], "acted": acted["code"],
          "comments": [c["tenancy"] for c in calls["comments"]],
          "skips": [d.auto_reply_skips("body: we have received your", False, named=False),
                    d.auto_reply_skips("body: we have received your", False, named=True),
                    d.auto_reply_skips("header auto-submitted: auto-replied", False, named=True)]}`);
    expect(r.dwp).toEqual([true, false]);
    expect(r.acted).toBe(0);
    expect(r.comments).toEqual(['recTYALDER0000001']);
    expect(r.skips).toEqual([false, false, true]);
  });

  it('note --do answered on a cached DWP message still files it AND records it; act then note records once', () => {
    const r = py(`${TRIAGE}
t.write_scan_cache([msg("m1", "Universal Credit <${UC}>", "${SUBJ}", "${DIRECT}")])
noted = run(lambda: t.main(["note", "--id", "m1", "--do", "answered", "--reason", "matter already handled: an earlier task"]))
acted = run(lambda: t.main(["act", "--id", "m1", "--do", "archive", "--reason", "filed"]))
result = {"noted": noted, "acted": acted, "calls": calls, "digest": [[x["id"], x["do"]] for x in digest()],
          "ledger": ledger(), "retry": retry_ids()}`);
    expect(r.noted.code).toBe(0);
    const noted = JSON.parse(r.noted.stdout.trim());
    expect(noted).toMatchObject({ noted: 'answered', id: 'm1', filedOutOfInbox: true, dwp: { done: 'commented', tenancy: 'recTYALDER0000001' } });
    expect(r.calls.comments.map((c) => c.tenancy)).toEqual(['recTYALDER0000001']);
    expect(r.calls.gmail[0]).toEqual(['/gmail/modify', { ids: ['m1'], removeLabels: ['INBOX'] }]);
    expect(r.acted.code).toBe(0);
    expect(JSON.parse(r.acted.stdout.trim()).dwp.done).toBe('already');
    expect(r.digest).toEqual([['m1', 'answered'], ['m1', 'archive']]);
    expect(r.ledger).toHaveLength(1);
    expect(r.retry).toEqual([]);
  });

  it('a look-alike sender passes through triage untouched by the DWP step', () => {
    const r = py(`${TRIAGE}
t.write_scan_cache([msg("m2", "<${UC}.example.com>", "${SUBJ}", "${DIRECT}")])
noted = run(lambda: t.main(["note", "--id", "m2", "--do", "answered", "--reason", "x"]))
result = {"noted": noted, "calls": calls}`);
    expect(r.noted.code).toBe(0);
    expect(JSON.parse(r.noted.stdout.trim()).dwp).toBeUndefined();
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks).toEqual([]);
  });

  it('a record that fails: the decision and digest line stand, stderr says so, exit 5', () => {
    const r = py(`${TRIAGE}
FAIL["post_before"] = True
t.write_scan_cache([msg("m1", "Universal Credit <${UC}>", "${SUBJ}", "${DIRECT}")])
noted = run(lambda: t.main(["note", "--id", "m1", "--do", "answered", "--reason", "matter already handled"]))
result = {"noted": noted, "calls": calls, "digest": [[x["id"], x["do"]] for x in digest()], "ledger": ledger()}`);
    expect(r.noted.code).toBe(5);
    const out = JSON.parse(r.noted.stdout.trim());
    expect(out).toMatchObject({ noted: 'answered', id: 'm1', filedOutOfInbox: true });
    expect(out.dwpProblem).toMatch(/comment on tenancy recTYALDER0000001 failed: Airtable POST comments 503/);
    expect(out.dwpProblem).toMatch(/Queued for `python3 scripts\/dwp_notice\.py retry`/);
    expect(r.noted.stderr).toMatch(/DWP NOTICE NOT RECORDED for m1/);
    expect(r.digest).toEqual([['m1', 'answered']]);
    expect(r.calls.gmail).toHaveLength(1);
    expect(r.ledger).toEqual([]);
  });
});

// Review fix 4: a failed record waits in a retry file that `retry` and `backfill` replay.
describe('the retry file', () => {
  const TRIAGE = `
spec = importlib.util.spec_from_file_location("triage_t", ${JSON.stringify(resolve(SCRIPTS, 'inbound-triage.py'))})
t = importlib.util.module_from_spec(spec); sys.modules["triage_t"] = t; spec.loader.exec_module(t)
t.worker_post = lambda path, body: (calls["gmail"].append([path, body]) or {"modified": 1})
import time
t.write_scan_cache([{"id": "m1", "threadId": "th1", "internalDate": str(int(time.time() * 1000)), "labelIds": ["INBOX"],
                     "headers": {"from": "Universal Credit <${UC}>", "subject": "${SUBJ}"}, "body": "${DIRECT}",
                     "auto_reply": None, "reply_state": ""}])
def quiet(fn):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return fn()
`;

  it('the message is queued before the attempt; a failure stays queued; retry replays it and clears it', () => {
    const r = py(`${TRIAGE}
FAIL["post_before"] = True
code = quiet(lambda: t.main(["note", "--id", "m1", "--do", "answered", "--reason", "matter already handled"]))
queued = json.load(open(d.retry_path()))
FAIL["post_before"] = False
dry = d.retry(dry_run=True, today=TODAY)
after_dry = retry_ids()
out = d.retry(today=TODAY)
result = {"code": code, "queuedAtPost": calls["queuedAtPost"], "entry": queued.get("m1"), "dry": dry,
          "afterDry": after_dry, "out": out, "after": retry_ids(), "posts": len(calls["comments"]), "ledger": ledger()}`);
    expect(r.code).toBe(5);
    expect(r.queuedAtPost[0]).toEqual(['m1']);                  // in the file BEFORE the write was tried
    expect(r.entry.ctx.dwp.tenant).toBe('Jo Alder');
    expect(r.entry.error).toMatch(/Airtable POST comments 503/);
    expect(r.dry.rows.map((x) => [x.id, x.do, x.tenancy])).toEqual([['m1', 'comment', 'recTYALDER0000001']]);
    expect(r.afterDry).toEqual(['m1']);
    expect(r.out.rows.map((x) => [x.id, x.done])).toEqual([['m1', 'commented']]);
    expect(r.after).toEqual([]);
    expect(r.posts).toBe(1);
    expect(r.ledger.map((x) => x.id)).toEqual(['m1']);
  });

  it('backfill replays the retry file even once the scan cache has forgotten the message', () => {
    const r = py(`${TRIAGE}
FAIL["post_before"] = True
quiet(lambda: t.main(["note", "--id", "m1", "--do", "answered", "--reason", "matter already handled"]))
FAIL["post_before"] = False
open(os.path.join(os.environ["INBOUND_TRIAGE_DIR"], "scan-cache.json"), "w").write("{}")
out = d.backfill(dry_run=False, today=TODAY)
result = {"rows": [[x["id"], x.get("done") or x.get("do")] for x in out["rows"]], "after": retry_ids(), "posts": len(calls["comments"])}`);
    expect(r.rows).toEqual([['m1', 'commented']]);
    expect(r.after).toEqual([]);
    expect(r.posts).toBe(1);
  });

  it('the command line: retry --dry-run lists, and exits 1 while one cannot be recorded', () => {
    const r = py(`${TRIAGE}
FAIL["post_before"] = True
quiet(lambda: t.main(["note", "--id", "m1", "--do", "answered", "--reason", "matter already handled"]))
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    dry = d.main(["retry", "--dry-run"])
    live = d.main(["retry"])
result = {"dry": dry, "live": live, "after": retry_ids()}`);
    expect(r.dry).toBe(0);
    expect(r.live).toBe(1);
    expect(r.after).toEqual(['m1']);
  });
});

describe('the back-fill dry run', () => {
  it('lists what it would do from the scan cache and writes nothing', () => {
    const r = py(`
os.makedirs(os.environ["INBOUND_TRIAGE_DIR"])
cache = {
  "m1": ctx("${UC}", "${SUBJ}", "${DIRECT}"),
  "m2": {"sender": "exampletown.housing@dwp.gov.uk", "subject": "Housing costs", "internalDate": 1763000001000},
  "m3": {"sender": "news@example.com", "subject": "Rent update", "internalDate": 1763000002000},
  "m4": ctx("${UC}", "Universal Credit payment update", "Your direct payment arrangement has stopped."),
}
open(os.path.join(os.environ["INBOUND_TRIAGE_DIR"], "scan-cache.json"), "w").write(json.dumps(cache))
out = d.backfill(dry_run=True, today=TODAY)
result = {"out": out, "calls": calls, "ledger": ledger(), "retry": retry_ids()}`);
    expect(r.out.dryRun).toBe(true);
    expect(r.out.rows.map((x) => [x.id, x.do])).toEqual([['m1', 'comment'], ['m4', 'task'], ['m2', 'not read']]);
    expect(r.out.rows[0].tenancy).toBe('recTYALDER0000001');
    expect(r.out.rows[1].task).toBe('RENT CHECK: DWP notice names no tenant, match it to a tenancy');
    expect(r.out.rows[2].why).toMatch(/add --reread/);
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks).toEqual([]);
    expect(r.ledger).toEqual([]);
    expect(r.retry).toEqual([]);
  });
});

// Review round 2 (934488c1): one regression (fix 1, in the triage hook block above) and four minors.
describe('review round 2', () => {
  // Fix 2: a POST answered 5xx may have landed; it is never sent again, the record is read back instead.
  it('a comment POST answered 504 after it landed is read back, never posted twice; a GET 503 and a 429 retry once', () => {
    const r = py(`
import urllib.error, urllib.parse
d._api = REAL_API
rc._pat = lambda: "test-token"
d.time.sleep = lambda s: None
sent = []
class Reply:
    def __init__(self, body): self.body = body
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return json.dumps(self.body).encode()
def err(url, code):
    return urllib.error.HTTPError(url, code, "x", {}, io.BytesIO(b'{"error": "x"}'))
script = {"get503": 0, "post429": 0}
def urlopen(req, timeout=None):
    method, url = req.get_method(), req.full_url
    sent.append(method + " " + urllib.parse.urlparse(url).path.split("/", 3)[-1])
    path = urllib.parse.urlparse(url).path
    if path.endswith("/comments") and method == "GET":
        if script["get503"] == 1:
            script["get503"] = 2
            raise err(url, 503)
        return Reply({"comments": [{"text": t} for t in COMMENTS.get(path.split("/")[-2], [])]})
    if path.endswith("/comments") and method == "POST":
        if script["post429"] == 1:
            script["post429"] = 2
            raise err(url, 429)
        COMMENTS.setdefault(path.split("/")[-2], []).append(json.loads(req.data)["text"])
        if script["post429"] == 0:
            raise err(url, 504)
        return Reply({"id": "comY"})
    raise AssertionError(method + " " + url)
d.urllib.request.urlopen = urlopen
first = d.record("m60", ctx("${UC}", "${SUBJ}", "${DIRECT}"), TODAY)
posts_after_504 = len([s for s in sent if s.startswith("POST")])
script["get503"], script["post429"] = 1, 1
forget_ledger()
COMMENTS.clear()
second = d.record("m61", ctx("${UC}", "${SUBJ}", "${DIRECT}"), TODAY)
result = {"first": first, "posts504": posts_after_504, "onTenancy": COMMENTS, "sent": sent, "second": second["done"]}`);
    expect(r.first.done).toBe('commented');
    expect(r.first.note).toMatch(/reported an error but it landed/);
    expect(r.posts504).toBe(1);
    expect(r.second).toBe('commented');
    expect(r.onTenancy).toEqual({ recTYALDER0000001: [expect.stringMatching(/Gmail m61\.$/)] });
    // m60: read, POST (504), read back. m61: read (503), read again, POST (429), POST.
    expect(r.sent.map((s) => s.split(' ')[0])).toEqual(['GET', 'POST', 'GET', 'GET', 'GET', 'POST', 'POST']);
  });

  // Fix 3: a Re: or Dear line naming someone beside one of our own words is unkeepable, never skipped whole.
  it('"Re: Roy Alder" beside a surname reference is unsure, so it is a task, not a comment on the one live Alder', () => {
    const r = py(`
reading = d.read_names("${SUBJ}", "Payment reference: ALDER\\nRe: Roy Alder\\nYour application has been approved.")
out = d.record("m62", ctx("${UC}", "${SUBJ}", "Payment reference: ALDER\\nRe: Roy Alder\\nYour application has been approved."), TODAY)
still = d.read_names("${SUBJ}", "Dear Kevin Brittain\\nDear Roy\\nDear Agile Lets Team\\nPayment reference: Alder\\nIt was approved.")
result = {"reading": reading, "out": out["done"], "comments": calls["comments"], "still": still["tenant"]}`);
    expect(r.reading.tenant).toBe('');
    expect(r.reading.unsure).toMatch(/"Roy Alder"/);
    expect(r.out).toBe('task');
    expect(r.comments).toEqual([]);
    expect(r.still).toBe('Alder');
  });

  // Fix 4: gate exit 4 (created, a field did not stick) is a failure: exit 5 and a retry entry, never a quiet 0.
  it('a task created with a field that did not stick fails loudly, is queued, and is never raised twice', () => {
    const r = py(`
spec = importlib.util.spec_from_file_location("triage_t", ${JSON.stringify(resolve(SCRIPTS, 'inbound-triage.py'))})
t = importlib.util.module_from_spec(spec); sys.modules["triage_t"] = t; spec.loader.exec_module(t)
t.worker_post = lambda path, body: (calls["gmail"].append([path, body]) or {"modified": 1})
def incomplete(fields):
    tid = "recTASKDWP%07d" % (len(BOARD) + 1)
    BOARD.append({"id": tid, "fields": {rc.TK["notes"]: fields["fldR7apBzSp3oxFxz"]}})
    calls["tasks"].append(fields)
    return 4, {"action": "created", "taskId": tid, "fieldsNotWritten": ["Team Member"]}
d.create_task = incomplete
import time
t.write_scan_cache([{"id": "m63", "threadId": "th63", "internalDate": str(int(time.time() * 1000)), "labelIds": ["INBOX"],
                     "headers": {"from": "Universal Credit <${UC}>", "subject": "${SUBJ}"},
                     "body": "Payment reference: CEDAR\\nYour application has been approved.", "auto_reply": None, "reply_state": ""}])
def run(args):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = t.main(args)
    return {"code": code, "json": json.loads(out.getvalue().strip()), "stderr": err.getvalue()}
first = run(["note", "--id", "m63", "--do", "answered", "--reason", "x"])
result = {"first": first, "retry": retry_ids(), "ledger": ledger(), "tasks": len(calls["tasks"])}`);
    expect(r.first.code).toBe(5);
    expect(r.first.json.dwpProblem).toMatch(/recTASKDWP0000001 was raised but some fields did not stick \(Team Member\)/);
    expect(r.first.stderr).toMatch(/DWP NOTICE NOT RECORDED for m63/);
    expect(r.retry).toEqual(['m63']);
    expect(r.ledger.map((x) => [x.task, x.fieldsNotWritten])).toEqual([['recTASKDWP0000001', 'Team Member']]);
    expect(r.tasks).toBe(1);
  });

  // Fix 5: one run per message at a time, so triage and a scheduled retry never both write.
  it('a second run on a message another run holds writes nothing, and goes ahead once the lock is free', () => {
    const r = py(`
import fcntl
d.LOCK_WAIT = 1
os.makedirs(d.locks_dir(), exist_ok=True)
held = open(os.path.join(d.locks_dir(), "m64.lock"), "a")
fcntl.flock(held, fcntl.LOCK_EX)
c = ctx("${UC}", "${SUBJ}", "${DIRECT}")
_, err = attempt(lambda: d.record("m64", c, TODAY))
posts_while_held = len(calls["comments"])
fcntl.flock(held, fcntl.LOCK_UN); held.close()
out = d.record("m64", c, TODAY)
result = {"err": err, "postsWhileHeld": posts_while_held, "out": out["done"], "posts": len(calls["comments"])}`);
    expect(r.err).toMatch(/another run is recording message m64 right now/);
    expect(r.postsWhileHeld).toBe(0);
    expect(r.out).toBe('commented');
    expect(r.posts).toBe(1);
  });
});

// Review round 3 (e76246f6): two minors.
describe('review round 3', () => {
  const TRIAGE = `
spec = importlib.util.spec_from_file_location("triage_t", ${JSON.stringify(resolve(SCRIPTS, 'inbound-triage.py'))})
t = importlib.util.module_from_spec(spec); sys.modules["triage_t"] = t; spec.loader.exec_module(t)
t.worker_post = lambda path, body: (calls["gmail"].append([path, body]) or {"modified": 1})
import time
def msg(mid, subject, body, auto_reply=None):
    return {"id": mid, "threadId": "th" + mid, "internalDate": str(int(time.time() * 1000)), "labelIds": ["INBOX"],
            "headers": {"from": "Universal Credit <${UC}>", "subject": subject}, "body": body,
            "auto_reply": auto_reply, "reply_state": ""}
def run(args):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = (t.main if args[0] in ("note", "act") else d.main)(args)
    text = out.getvalue().strip()
    return {"code": code, "json": json.loads(text) if text.startswith("{") else text, "stderr": err.getvalue()}
`;

  // Fix 1: the exit-4 warning is never worn away: every later pass exits 5, naming the task and the missing
  // fields, and keeps the retry entry, until a person clears it with what they fixed.
  it('a task with a field that did not stick keeps failing until `clear <id> --why` says what was fixed', () => {
    const r = py(`${TRIAGE}
def incomplete(fields):
    tid = "recTASKDWP%07d" % (len(BOARD) + 1)
    BOARD.append({"id": tid, "fields": {rc.TK["notes"]: fields["fldR7apBzSp3oxFxz"]}})
    calls["tasks"].append(fields)
    return 4, {"action": "created", "taskId": tid, "fieldsNotWritten": ["Team Member"]}
d.create_task = incomplete
t.write_scan_cache([msg("m70", "${SUBJ}", "Payment reference: CEDAR\\nYour application has been approved.")])
acted = run(["act", "--id", "m70", "--do", "archive", "--reason", "filed"])
noted = run(["note", "--id", "m70", "--do", "answered", "--reason", "x"])
replay = d.retry(today=TODAY)
no_why = run(["clear", "m70"])
nothing = run(["clear", "m99", "--why", "nothing was wrong with this one"])
cleared = run(["clear", "m70", "--why", "Team Member set to the Accounts Receivable agent by hand"])
after = run(["note", "--id", "m70", "--do", "answered", "--reason", "x"])
result = {"acted": acted, "noted": noted, "replay": replay["rows"], "noWhy": no_why, "nothing": nothing,
          "cleared": cleared, "after": after, "retry": retry_ids(), "tasks": len(calls["tasks"]),
          "ledger": [[x["kind"], x.get("why", "") if x["kind"] == "cleared" else x.get("fieldsNotWritten")] for x in ledger()]}`);
    expect(r.acted.code).toBe(5);
    expect(r.noted.code).toBe(5);
    expect(r.noted.stderr).toMatch(/DWP NOTICE NOT RECORDED for m70: task recTASKDWP0000001 was raised but some fields did not stick \(Team Member\)/);
    expect(r.noted.stderr).toMatch(/dwp_notice\.py clear m70 --why/);
    expect(r.replay.map((x) => [x.id, x.do])).toEqual([['m70', 'error']]);
    expect(r.noWhy.code).toBe(2);
    expect(r.noWhy.json.error).toMatch(/clear needs --why/);
    expect(r.nothing.code).toBe(2);
    expect(r.nothing.json.error).toMatch(/nothing to clear/);
    expect(r.cleared.code).toBe(0);
    expect(r.cleared.json).toMatchObject({ cleared: 'm70', task: 'recTASKDWP0000001', fields: 'Team Member' });
    expect(r.after.code).toBe(0);
    expect(r.after.json.dwp.done).toBe('already');
    expect(r.retry).toEqual([]);
    expect(r.tasks).toBe(1);
    expect(r.ledger).toEqual([['task', 'Team Member'], ['cleared', 'Team Member set to the Accounts Receivable agent by hand']]);
  });

  // Fix 2: any scan-flagged automatic reply with nothing decided is skipped, the receipt-phrase reading included.
  // Review round 5: a reply flagged only by a receipt phrase in its body is never skipped, because a fact can follow
  // the receipt in words no list holds. The stated cost: a pure receipt naming nobody becomes one task, no comment.
  it('a receipt flagged only by its body is read, not skipped: naming nobody, it becomes one task', () => {
    const r = py(`${TRIAGE}
ack = "Thank you for contacting Universal Credit. We will reply within 10 working days."
t.write_scan_cache([msg("m71", "Your message", ack, auto_reply="body: thank you for contacting")])
cache = t.read_scan_cache()
acted = run(["act", "--id", "m71", "--do", "archive", "--reason", "filed"])
planned = d.plan("m71", dict(ctx("${UC}", "Your message", ack), auto_reply="body: thank you for contacting",
                             dwp=cache["m71"].get("dwp")), TODAY)
result = {"dwp": "dwp" in cache["m71"], "acted": acted["code"], "comments": calls["comments"], "tasks": len(calls["tasks"]),
          "plan": planned["do"]}`);
    expect(r.dwp).toBe(true);
    expect(r.acted).toBe(0);
    expect(r.comments).toEqual([]);
    expect(r.tasks).toBe(1);
  });

  // Fix 2: a sentence that begins "If" is boilerplate, never the decision that keeps a flagged reply.
  it('an "If ..." sentence is never a decision, so a flagged reply holding only one is still skipped', () => {
    const r = py(`${TRIAGE}
body = "Thank you for contacting Universal Credit. If your payment has been suspended please call us. We will reply soon."
t.write_scan_cache([msg("m72", "Your message", body, auto_reply="header auto-submitted: auto-replied")])
result = {"dwp": "dwp" in t.read_scan_cache()["m72"], "sentence": d.decision_sentence(body),
          "summary": d.summary("Your message", body),
          "kept": d.decision_sentence("If you have questions, call us. Your claim has been approved.")}`);
    expect(r.dwp).toBe(false);
    expect(r.sentence).toBe('');
    expect(r.summary).toBe('Your message');
    expect(r.kept).toBe('Your claim has been approved.');
  });
});

// Review minor 7, end to end: a live tenant surnamed like a month is never matched on a month.
describe('a month is not a surname', () => {
  it('"Payment reference: March" with a live tenant named March is a task, not a comment', () => {
    const r = py(`
out = d.record("m50", ctx("${UC}", "${SUBJ}", "Payment reference: March\\nYour application has been approved."), TODAY)
result = {"out": out, "calls": calls}`);
    expect(r.out.done).toBe('task');
    expect(r.calls.comments).toEqual([]);
  });
});
