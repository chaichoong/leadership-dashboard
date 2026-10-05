// A tenant's reply to the rent chase goes to the Cash Flow Voids agent (step 3b; Kevin approved "Build
// as-is" on 4 Oct 2026), and only once its trial has ended: until then Inbox Response answers him, so no
// tenant waits on a draft that cannot be sent. Drives the REAL build_queue with Airtable stubbed; every
// id, name, email and number is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const CFV = 'rec7aHLK1Q8fMLRXH';
const RESPONSE = 'recJ8J8idWE8d97tH';
const CEO = 'reciHUAEcEkbctnZ6';

function queue({ ended = false, tasks, chased = [{ tenants: ['recTENANTREPLY01'] }], tenants = { recTENANTREPLY01: { email: 'Sam@Example.com', phone: '07700 900123' } }, fail = false, plans = [] }) {
  const out = execFileSync('python3', ['-c', `
import importlib.util, json, sys, urllib.request
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
import agent_email_format as aef
a = json.loads(sys.stdin.read())
if a["ended"]:
    aef.TRIAL_ENDED["${CFV}"] = "2026-11-24T09:00:00Z"
    aef.TRIAL_AGENTS.clear()
else:
    # The trial ended on 5 Oct 2026; "during the trial" puts the agent back on trial in this process.
    aef.TRIAL_AGENTS["${CFV}"] = "the Cash Flow Voids agent is on its trial run"
    aef.TRIAL_ENDED.pop("${CFV}", None)
AF = m.AF
recs = []
for t in a["tasks"]:
    f = {AF["name"]: t["name"], AF["status"]: {"name": "Today"}, AF["teamMember"]: [t["holder"]], AF["notes"]: "",
         AF["inboundTask"]: t.get("inbound", True), AF["inboundSender"]: t["sender"]}
    recs.append({"id": t["id"], "fields": f})
m.query_tasks = lambda formula, **kw: recs
reads = []
def records(table, formula=None, fields=None, max_records=None):
    # Only the reply lane's own two reads are answered here; any other lane's read is not this test's.
    if formula == m.RUNNING_PLAN_FORMULA:
        reads.append("plans")
        return [{"id": "recPC%02d" % i, "fields": {m.AF["agentOutput"]: "PLAN FOR: " + p["tenancy"] + "\\nPLAN: 2026-12-10 £100.00\\nTO: a@b.com\\n---\\nx"}}
                for i, p in enumerate(a["plans"])]
    if table == m.TENANCIES_TABLE:
        reads.append("tenancies")
        return [{"id": p["tenancy"], "fields": {m.TENANCY_TENANTS: p["tenants"]}} for p in a["plans"]]
    if not (formula == m.RENT_REPLY_FORMULA or table == m.TENANTS_TABLE):
        return []
    reads.append(table)
    if a["fail"]:
        raise RuntimeError("Airtable 500")
    if table == m.TASKS:
        from datetime import datetime, timedelta
        out = []
        for i, c in enumerate(a["chased"]):
            f = {m.TASK_TENANTS: c.get("tenants", []), m.AF["name"]: c.get("name", "RENT LATE: Unit 9, rent due 1 Oct (reminder)"),
                 m.AF["agentOutput"]: c.get("output", ""), m.AF["notes"]: c.get("notes", "")}
            if "status" in c:
                f[m.AF["status"]] = {"name": c["status"]}
            if c.get("sentDaysAgo") is not None:
                f[m.AF["notes"]] += "\\n[%s 10:00 — send-email] SENT: email to x" % (datetime.now() - timedelta(days=c["sentDaysAgo"])).strftime("%d %b %Y")
            out.append({"id": "recRL%02d" % i, "fields": f})
        return out
    return [{"id": k, "fields": {m.TENANT_EMAIL: v.get("email"), m.TENANT_PHONE: v.get("phone")}} for k, v in a["tenants"].items()]
m.query_records = records
m.fetch_role_roster = lambda: {k: {"dispatchable": True} for k in ("${CFV}", "${RESPONSE}", m.CREDITOR_REC_ID, m.PROPERTY_REC_ID)}
import io, contextlib
err = io.StringIO()
with contextlib.redirect_stderr(err):
    q = m.build_queue()
targets = {x["id"]: x.get("autoTarget") for x in q["routingNeeded"]}
print(json.dumps({"targets": targets, "reads": reads, "error": q.get("rentReplyError", "")}))`],
    { input: JSON.stringify({ ended, tasks, chased, tenants, fail, plans }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json') } });
  return JSON.parse(out.trim().split('\n').pop());
}

const INBOX = (id, sender, extra = {}) => ({ id, name: 'INBOUND: a message about the rent', holder: CEO, sender, ...extra });

describe('a tenant\'s reply to the rent chase', () => {
  it('during the trial: Inbox Response answers him, and nothing is even read', () => {
    const r = queue({ tasks: [INBOX('recReplyEmail001', 'sam@example.com')] });
    expect(r.targets).toEqual({ recReplyEmail001: RESPONSE });
    expect(r.reads).toEqual([]);
  });

  it('after the trial: the Cash Flow Voids agent gets it, by email in any case or by mobile in any spelling', () => {
    const r = queue({ ended: true, tasks: [
      INBOX('recReplyEmail001', 'Sam Example <SAM@example.com>'),
      INBOX('recReplyText0001', '+447700900123'),
      INBOX('recReplyText0002', '0044 7700 900123'),
      INBOX('recStranger00001', 'someone@example.com'),
      // Not an inbound message: the reply lane is for inbound only.
      INBOX('recNotInbound001', 'sam@example.com', { inbound: false, name: 'Write to Sam about his rent' }),
    ] });
    expect(r.targets.recReplyEmail001).toBe(CFV);
    expect(r.targets.recReplyText0001).toBe(CFV);
    expect(r.targets.recReplyText0002).toBe(CFV);
    expect(r.targets.recStranger00001).toBe(RESPONSE);
    expect(r.targets.recNotInbound001 === CFV).toBe(false);
  });

  it('after the trial: a reply Inbox Response already holds moves to the Cash Flow Voids agent; work that is not a message stays', () => {
    const r = queue({ ended: true, tasks: [
      { ...INBOX('recHeldByInbox01', 'sam@example.com'), holder: RESPONSE },
      { ...INBOX('recHeldNotInbox1', 'sam@example.com', { inbound: false, name: 'Look up a lease clause' }), holder: RESPONSE },
    ] });
    expect(r.targets).toEqual({ recHeldByInbox01: CFV });
  });

  it('a tenant with no open chase is not routed to it, and a failed read leaves his message with Inbox Response and says so', () => {
    const none = queue({ ended: true, chased: [], tasks: [INBOX('recReplyEmail001', 'sam@example.com')] });
    expect(none.targets).toEqual({ recReplyEmail001: RESPONSE });
    const broken = queue({ ended: true, fail: true, tasks: [INBOX('recReplyEmail001', 'sam@example.com')] });
    expect(broken.targets).toEqual({ recReplyEmail001: RESPONSE });
    expect(broken.error).toMatch(/Airtable 500/);
  });
});

describe('a reply after the card went (Kevin, 5 Oct 2026: "Do it now"): a card closes when its email goes', () => {
  it('a card sent in the last 14 days still routes the reply; one closed unsent, or sent 15 days ago, does not', () => {
    const sent = queue({ ended: true, chased: [{ tenants: ['recTENANTREPLY01'], status: 'Completed', sentDaysAgo: 3 }],
      tasks: [INBOX('recReplyEmail001', 'sam@example.com')] });
    expect(sent.targets).toEqual({ recReplyEmail001: CFV });
    const unsent = queue({ ended: true, chased: [{ tenants: ['recTENANTREPLY01'], status: 'Completed' }],
      tasks: [INBOX('recReplyEmail001', 'sam@example.com')] });
    expect(unsent.targets).toEqual({ recReplyEmail001: RESPONSE });
    const old = queue({ ended: true, chased: [{ tenants: ['recTENANTREPLY01'], status: 'Completed', sentDaysAgo: 15 }],
      tasks: [INBOX('recReplyEmail001', 'sam@example.com')] });
    expect(old.targets).toEqual({ recReplyEmail001: RESPONSE });
  });

  it('a details-form reminder routes its tenant\'s reply too', () => {
    const r = queue({ ended: true, chased: [{ tenants: ['recTENANTREPLY01'], name: 'RENT DETAILS: Unit 9, reminder 1 to fill in the details form',
      status: 'Completed', sentDaysAgo: 1 }], tasks: [INBOX('recReplyEmail001', 'sam@example.com')] });
    expect(r.targets).toEqual({ recReplyEmail001: CFV });
  });

  it('the letting agent\'s reply to an AGENT RENT LATE email reaches the agent; the tenant there, never written to, is not routed', () => {
    const r = queue({ ended: true,
      chased: [{ tenants: ['recTENANTREPLY01'], name: 'AGENT RENT LATE: Unit 1 – 1 Example Road, rent due 1 Oct', status: 'Completed', sentDaysAgo: 2,
        output: 'TO: Accounts@Letting.example\nFROM: kevinbrittain@gmail.com\nSUBJECT: Re: 1 Example Road\n---\nHello,\n\nWhen will the rent be paid?\n\nKevin Brittain' }],
      tasks: [INBOX('recAgentReply001', 'Accounts Payable <accounts@letting.example>'), INBOX('recTenantMsg0001', 'sam@example.com')] });
    expect(r.targets.recAgentReply001).toBe(CFV);
    expect(r.targets.recTenantMsg0001).toBe(RESPONSE);
  });
});

describe('a tenant on a running payment plan', () => {
  it('his messages reach the Cash Flow Voids agent too, though no late-rent task is open (the plan pauses the chase)', () => {
    const r = queue({ ended: true, chased: [], plans: [{ tenancy: 'recTENANCYREPLY01', tenants: ['recTENANTREPLY01'] }],
      tasks: [INBOX('recPlanReply0001', 'sam@example.com')] });
    expect(r.targets).toEqual({ recPlanReply0001: CFV });
    expect(r.reads).toEqual(expect.arrayContaining(['plans', 'tenancies']));
  });
});

describe('one spelling for a sender', () => {
  it('emails in lower case, UK numbers as +44', () => {
    const out = execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(DISPATCH)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.sender_key(x) for x in ("Sam <Sam@Example.COM>", "07700 900123", "+44 7700 900123", "447700900123", "0044 7700 900123", "+44 (0)7700 900123", "", None)]))`], { encoding: 'utf8' });
    expect(JSON.parse(out.trim().split('\n').pop())).toEqual(['sam@example.com', '+447700900123', '+447700900123', '+447700900123', '+447700900123', '+447700900123', '', '']);
  });
});
