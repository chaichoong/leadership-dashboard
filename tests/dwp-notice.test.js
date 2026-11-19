// A DWP or Universal Credit notice reaches the tenancy record in code (finding 20261118-agent-dispatch-1353).
//
// Until 19 Nov 2026 a "Universal Credit Direct Payment Arrangement started" notice and a DWP "Housing costs"
// email to info@ were filed by the triage robot as "answered" and the fact never reached the tenancy: whether
// it did depended on the agent's view of each message. Now the scan reads the tenant and the decision off the
// full body into the scan cache, and every triage act and note calls dwp_notice.record, which posts ONE comment
// on the one matching live tenancy or raises ONE "RENT CHECK:" task, never a guess.
//
// These drive the REAL scripts/dwp_notice.py and scripts/inbound-triage.py with Airtable swapped out at the
// function level (fetch_all, post_comment, create_task) and Gmail at worker_post. Every name, address, record
// id and message id below is invented.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');
const UC = 'donotreply@universal-credit.service.gov.uk';
const AR = 'rec7aHLK1Q8fMLRXH';

const PRELUDE = `
import json, os, sys, io, contextlib, tempfile, importlib.util
from datetime import date
box = tempfile.mkdtemp()
os.environ["DWP_NOTICE_LEDGER"] = box + "/ledger.jsonl"
os.environ["INBOUND_TRIAGE_DIR"] = box + "/triage"
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import dwp_notice as d
rc = d._rc()
TODAY = date(2026, 11, 19)
calls = {"reads": [], "comments": [], "tasks": [], "gmail": []}
TENANCIES, TENANTS = [], []
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
tenant("recTNELMXX0000001", "Dee Elm");   tenancy("recTYELMXX0000001", ["recTNELMXX0000001"], end="2020-01-31", status="Former")
def fetch_all(table, params=None):
    calls["reads"].append(table)
    if table == rc.T_TENANCIES:
        return list(TENANCIES)
    if table == rc.T_TENANTS:
        return list(TENANTS)
    raise AssertionError("unexpected table " + table)
def post_comment(tid, text):
    calls["comments"].append({"tenancy": tid, "text": text})
    return {"id": "comX%d" % len(calls["comments"])}
def create_task(fields):
    calls["tasks"].append(fields)
    return 0, {"action": "created", "taskId": "recTASKDWP%07d" % len(calls["tasks"])}
d.fetch_all, d.post_comment, d.create_task = fetch_all, post_comment, create_task
def ledger():
    p = os.environ["DWP_NOTICE_LEDGER"]
    return [json.loads(l) for l in open(p).read().splitlines()] if os.path.exists(p) else []
def ctx(sender, subject, body):
    return {"sender": sender, "subject": subject, "internalDate": 1763000000000,
            "dwp": d.cache_entry(subject, body)}
def attempt(fn):
    try:
        return fn(), ""
    except d.RecordError as e:
        return None, str(e)
`;

// Runs PRELUDE + body; the body sets `result`. Returns the parsed result plus the process's own output.
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

describe('who counts as DWP', () => {
  it('the Universal Credit no-reply address and dwp.gov.uk with its subdomains, never a look-alike', () => {
    const r = py(`result = [d.is_dwp_notice(s) for s in [
        "${UC}", "Universal Credit <DoNotReply@Universal-Credit.Service.Gov.UK>",
        "EXAMPLETOWN.HOUSING@dwp.gov.uk", "case.team@region.dwp.gov.uk",
        "someone@dwp.gov.uk.example.com", "someone@evil-dwp.gov.uk", "someone@fakedwp.gov.uk",
        "${UC}.example.com", "@dwp.gov.uk", "a@b@dwp.gov.uk", "landlord@example.com", ""]]`);
    expect(r).toEqual([true, true, true, true, false, false, false, false, false, false, false, false]);
  });
});

describe('what a notice says', () => {
  it('reads the tenant from the reference, the direct-payment line, a request line, and a Re: or Dear line not to us', () => {
    const r = py(`result = [d.tenant_name(s, b) for s, b in [
        ("Universal Credit Direct Payment Arrangement started", "${DIRECT}"),
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
                            d.summary("Universal Credit Direct Payment Arrangement started", "${DIRECT}"),
                            len(d.summary("S" * 60, "Your request was approved " + "x" * 500)),
                            d.summary("Nothing decided", "Hello. Thank you for your email.")]`);
    expect(r[0]).toBe('Housing costs: This has been referred to our decision makers.');
    expect(r[1]).toBe(DIRECT_SUMMARY);
    expect(r[2]).toBe(300);
    expect(r[3]).toBe('Nothing decided');
  });
});

describe('record: one comment on the one live tenancy, else one task', () => {
  it('a Payment reference direct-payment notice comments on the one matching live tenancy', () => {
    const r = py(`
out = d.record("m1", ctx("${UC}", "Universal Credit Direct Payment Arrangement started", "${DIRECT}"), TODAY)
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

  it('a surname two live tenancies share makes one task and no comment', () => {
    const r = py(`
out = d.record("m3", ctx("${UC}", "Universal Credit Direct Payment Arrangement started",
                         "Your landlord direct payment arrangement has started.\\nPayment reference: CEDAR"), TODAY)
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
    expect(f.fldR7apBzSp3oxFxz).toMatch(/^DWP NOTICE KEY: m3/);
    expect(r.ledger.map((x) => [x.id, x.kind, x.task])).toEqual([['m3', 'task', 'recTASKDWP0000001']]);
  });

  it('a full name breaks the tie between two tenants who share a surname', () => {
    const r = py(`
a = d.record("m4", ctx("case.team@region.dwp.gov.uk", "Housing costs",
                       "Dear Agile Lets,\\nRe: Ben Cedar\\nThe claim was approved."), TODAY)
b = d.record("m11", ctx("${UC}", "Universal Credit Direct Payment Arrangement started",
                        "${DIRECT}".replace("Alder", "Cedar").replace("Jo Cedar", "Ann Cedar")), TODAY)
result = {"done": [a["done"], b["done"]], "calls": calls}`);
    expect(r.done).toEqual(['commented', 'commented']);
    expect(r.calls.comments.map((c) => c.tenancy)).toEqual(['recTYCEDAR0000002', 'recTYCEDAR0000001']);
  });

  it('a notice with no name makes one task, and reads nothing from Airtable', () => {
    const r = py(`
out = d.record("m5", ctx("${UC}", "Universal Credit payment update",
                         "Dear Sir/Madam,\\nYour direct payment arrangement has stopped."), TODAY)
result = {"out": out, "calls": calls}`);
    expect(r.out.done).toBe('task');
    expect(r.calls.reads).toEqual([]);
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks.map((f) => f.fldgFjGBw6bTKJFCD))
      .toEqual(['RENT CHECK: DWP notice names no tenant, match it to a tenancy']);
  });

  it('a former tenant, or a first name the one surname match contradicts, is a task, never a guess', () => {
    const r = py(`
a = d.record("m6", ctx("${UC}", "Payment stopped", "Payment reference: ELM\\nThe arrangement has stopped."), TODAY)
b = d.record("m7", ctx("someone@dwp.gov.uk", "Housing costs", "Re: Kim Alder\\nThe claim was approved."), TODAY)
result = {"a": a, "b": b, "calls": calls}`);
    expect(r.a.done).toBe('task');
    expect(r.b.done).toBe('task');
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks.map((f) => f.fldgFjGBw6bTKJFCD)).toEqual([
      'RENT CHECK: DWP notice names ELM, match it to a tenancy',
      'RENT CHECK: DWP notice names Kim Alder, match it to a tenancy']);
    expect(r.calls.tasks[1].fldRGhBQViKZKtkQ6).toMatch(/no tenant there has the first name on the notice/);
  });

  it('the same message twice comments once', () => {
    const r = py(`
c = ctx("${UC}", "Universal Credit Direct Payment Arrangement started", "${DIRECT}")
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
b = d.record("m9", ctx("${UC}.example.com", "Universal Credit Direct Payment Arrangement started", "${DIRECT}"), TODAY)
c = d.record("m10", ctx("housing@dwp.gov.uk.example.com", "Housing costs", "${HOUSING}"), TODAY)
result = {"done": [a["done"], b["done"], c["done"]], "calls": calls, "ledger": ledger()}`);
    expect(r.done).toEqual(['skip', 'skip', 'skip']);
    expect(r.calls).toEqual({ reads: [], comments: [], tasks: [], gmail: [] });
    expect(r.ledger).toEqual([]);
  });

  it('a broken Airtable read is NOT CHECKED: no comment, no task, no ledger line', () => {
    const r = py(`
d.fetch_all = lambda table, params=None: TENANTS[:3] if table == rc.T_TENANTS else list(TENANCIES)
out, err = attempt(lambda: d.record("m1", ctx("${UC}", "Universal Credit Direct Payment Arrangement started", "${DIRECT}"), TODAY))
result = {"out": out, "err": err, "calls": calls, "ledger": ledger()}`);
    expect(r.out).toBeNull();
    expect(r.err).toMatch(/NOT CHECKED: the tenants read returned 3 rows \(expected 20\+\)/);
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks).toEqual([]);
    expect(r.ledger).toEqual([]);
  });

  it('the task goes through the creation gate in process, with the word fold off, and nothing on stdout', () => {
    const r = py(`
import types
seen = {}
fake = types.SimpleNamespace()
def cmd_create(fields, force=False, dry_run=False, parent=None, owner=None):
    seen.update(force=force, name=fields["fldgFjGBw6bTKJFCD"])
    print(json.dumps({"action": "created", "taskId": "recTASKGATE000001"}))
    return 0
fake.cmd_create = cmd_create
buf = io.StringIO()
# A fresh copy of the module: the shared one has create_task stubbed by the prelude.
spec = importlib.util.spec_from_file_location("dwp_fresh", ${JSON.stringify(resolve(SCRIPTS, 'dwp_notice.py'))})
fresh = importlib.util.module_from_spec(spec); spec.loader.exec_module(fresh)
fresh._mods["od_catask_for_dwp_notice"] = fake
with contextlib.redirect_stdout(buf):
    code, out = fresh.create_task({"fldgFjGBw6bTKJFCD": "RENT CHECK: DWP notice names no tenant, match it to a tenancy"})
result = {"code": code, "out": out, "seen": seen, "leaked": buf.getvalue()}`);
    expect(r.code).toBe(0);
    expect(r.out.taskId).toBe('recTASKGATE000001');
    expect(r.seen.force).toBe(true);
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

describe('the triage hook', () => {
  const TRIAGE = `
spec = importlib.util.spec_from_file_location("triage_t", ${JSON.stringify(resolve(SCRIPTS, 'inbound-triage.py'))})
t = importlib.util.module_from_spec(spec); sys.modules["triage_t"] = t; spec.loader.exec_module(t)
assert t.dwp_notice is d, "the triage script must use the same dwp_notice module"
t.worker_post = lambda path, body: (calls["gmail"].append([path, body]) or {"modified": 1})
import time
def msg(mid, sender, subject, body):
    return {"id": mid, "threadId": "th" + mid, "internalDate": str(int(time.time() * 1000)), "labelIds": ["INBOX"],
            "headers": {"from": sender, "subject": subject}, "body": body, "auto_reply": None, "reply_state": ""}
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
t.write_scan_cache([msg("m1", "Universal Credit <${UC}>", "Universal Credit Direct Payment Arrangement started", "${DIRECT}"),
                    msg("m2", "<${UC}.example.com>", "Universal Credit Direct Payment Arrangement started", "${DIRECT}"),
                    msg("m3", "Landlord News <news@example.com>", "Rent update", "Payment reference: ALDER")])
cache = t.read_scan_cache()
result = {"m1": cache["m1"].get("dwp"), "others": ["dwp" in cache["m2"], "dwp" in cache["m3"]],
          "kept": sorted(cache["m3"])}`);
    expect(r.m1).toEqual({ tenant: 'Jo Alder', summary: DIRECT_SUMMARY });
    expect(r.others).toEqual([false, false]);
    // No other cache change: a non-DWP entry carries exactly the keys it always did.
    expect(r.kept).toEqual(['ask', 'auto_reply', 'deadline', 'inbox', 'internalDate', 'reply_state', 'sender',
      'subject', 'threadId']);
  });

  it('note --do answered on a cached DWP message still files it AND records it; act then note records once', () => {
    const r = py(`${TRIAGE}
t.write_scan_cache([msg("m1", "Universal Credit <${UC}>", "Universal Credit Direct Payment Arrangement started", "${DIRECT}")])
noted = run(lambda: t.main(["note", "--id", "m1", "--do", "answered", "--reason", "matter already handled: an earlier task"]))
acted = run(lambda: t.main(["act", "--id", "m1", "--do", "archive", "--reason", "filed"]))
result = {"noted": noted, "acted": acted, "calls": calls, "digest": [[x["id"], x["do"]] for x in digest()], "ledger": ledger()}`);
    expect(r.noted.code).toBe(0);
    const noted = JSON.parse(r.noted.stdout.trim());
    expect(noted).toMatchObject({ noted: 'answered', id: 'm1', filedOutOfInbox: true, dwp: { done: 'commented', tenancy: 'recTYALDER0000001' } });
    expect(r.calls.comments.map((c) => c.tenancy)).toEqual(['recTYALDER0000001']);
    expect(r.calls.gmail[0]).toEqual(['/gmail/modify', { ids: ['m1'], removeLabels: ['INBOX'] }]);
    expect(r.acted.code).toBe(0);
    expect(JSON.parse(r.acted.stdout.trim()).dwp.done).toBe('already');
    expect(r.digest).toEqual([['m1', 'answered'], ['m1', 'archive']]);
    expect(r.ledger).toHaveLength(1);
  });

  it('a look-alike sender passes through triage untouched by the DWP step', () => {
    const r = py(`${TRIAGE}
t.write_scan_cache([msg("m2", "<${UC}.example.com>", "Universal Credit Direct Payment Arrangement started", "${DIRECT}")])
noted = run(lambda: t.main(["note", "--id", "m2", "--do", "answered", "--reason", "x"]))
result = {"noted": noted, "calls": calls}`);
    expect(r.noted.code).toBe(0);
    expect(JSON.parse(r.noted.stdout.trim()).dwp).toBeUndefined();
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks).toEqual([]);
  });

  it('a record that fails: the decision and digest line stand, stderr says so, exit 5', () => {
    const r = py(`${TRIAGE}
def broken(tid, text):
    raise RuntimeError("Airtable POST comments 503: service unavailable")
d.post_comment = broken
t.write_scan_cache([msg("m1", "Universal Credit <${UC}>", "Universal Credit Direct Payment Arrangement started", "${DIRECT}")])
noted = run(lambda: t.main(["note", "--id", "m1", "--do", "answered", "--reason", "matter already handled"]))
result = {"noted": noted, "calls": calls, "digest": [[x["id"], x["do"]] for x in digest()], "ledger": ledger()}`);
    expect(r.noted.code).toBe(5);
    const out = JSON.parse(r.noted.stdout.trim());
    expect(out).toMatchObject({ noted: 'answered', id: 'm1', filedOutOfInbox: true });
    expect(out.dwpProblem).toMatch(/comment on tenancy recTYALDER0000001 failed: Airtable POST comments 503/);
    expect(r.noted.stderr).toMatch(/DWP NOTICE NOT RECORDED for m1/);
    expect(r.digest).toEqual([['m1', 'answered']]);
    expect(r.calls.gmail).toHaveLength(1);
    expect(r.ledger).toEqual([]);
  });
});

describe('the back-fill dry run', () => {
  it('lists what it would do from the scan cache and writes nothing', () => {
    const r = py(`
os.makedirs(os.environ["INBOUND_TRIAGE_DIR"])
cache = {
  "m1": ctx("${UC}", "Universal Credit Direct Payment Arrangement started", "${DIRECT}"),
  "m2": {"sender": "exampletown.housing@dwp.gov.uk", "subject": "Housing costs", "internalDate": 1763000001000},
  "m3": {"sender": "news@example.com", "subject": "Rent update", "internalDate": 1763000002000},
  "m4": ctx("${UC}", "Universal Credit payment update", "Your direct payment arrangement has stopped."),
}
open(os.path.join(os.environ["INBOUND_TRIAGE_DIR"], "scan-cache.json"), "w").write(json.dumps(cache))
out = d.backfill(dry_run=True, today=TODAY)
result = {"out": out, "calls": calls, "ledger": ledger()}`);
    expect(r.out.dryRun).toBe(true);
    expect(r.out.rows.map((x) => [x.id, x.do])).toEqual([['m1', 'comment'], ['m4', 'task'], ['m2', 'not read']]);
    expect(r.out.rows[0].tenancy).toBe('recTYALDER0000001');
    expect(r.out.rows[1].task).toBe('RENT CHECK: DWP notice names no tenant, match it to a tenancy');
    expect(r.out.rows[2].why).toMatch(/add --reread/);
    expect(r.calls.comments).toEqual([]);
    expect(r.calls.tasks).toEqual([]);
    expect(r.ledger).toEqual([]);
  });
});
