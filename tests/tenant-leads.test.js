// The tenant-finding chain (Kevin, 25 Sep 2026): scripts/tenant-leads.py.
//
// These drive the REAL rules with fixture records shaped exactly as Airtable returns them
// (returnFieldsByFieldId, selects as strings, links as id arrays). Every card the chain drafts is
// pushed through the REAL submit gates in agent-dispatch.py and agent_email_format.py, and the
// in-process calls the Writer makes are checked against the attributes the real commands read,
// so a card or a handover that would be refused fails here first, not on the morning run.
//
// Back-tested (25 Sep 2026) by breaking the rule under test and watching its case fail:
//   * NOTICE_WINDOW_DAYS = 999            -> "a tenancy ending in 90 days is not an opening" fails
//   * dropping the age check in screen()   -> "a 30-year-old waits for their 35th birthday" fails
//   * due_again() always due               -> "a second run the same day raises nothing new" fails
//   * monitor() without the SENT check     -> "an approved card with no SENT stamp is a failure" fails
//   * keepwarm_leads() without is_legacy() -> "a past applicant is never on an email list" fails
//   * bonus_row() stamping Run Date again   -> "never stamps Run Date" fails
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(root, 'scripts');

const HARNESS = `
import importlib.util, json, sys, os, re
from datetime import date, timedelta
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
def load_mod(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(${JSON.stringify(SCRIPTS)}, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
tl = load_mod("tl", "tenant-leads.py")
L, R, U, TY, TN, P, G, TK, O = tl.L, tl.R, tl.U, tl.TY, tl.TN, tl.P, tl.G, tl.TK, tl.O
DAY = date(2026, 9, 25)
def iso(d): return d.isoformat()
def rec(i, f, created="2026-09-01T10:00:00.000Z"): return {"id": i, "createdTime": created, "fields": f}

def world():
    return {
      "props": [rec("recP1", {P["name"]: "5 Dalham Place", P["area"]: "Haverhill", P["strategy"]: "UC HMO", P["agent"]: "Property Portfolio"}),
                rec("recP2", {P["name"]: "18 Siddows Avenue", P["area"]: "Clitheroe", P["strategy"]: "Single let", P["agent"]: "Property Portfolio"}),
                rec("recP3", {P["name"]: "9 Agent Road", P["area"]: "Haverhill", P["agent"]: "Roc Immo"}),
                rec("recP4", {P["name"]: "18 Northfield Park", P["area"]: "Soham", P["strategy"]: "UC HMO", P["agent"]: "Property Portfolio"})],
      "units": [rec("recU1", {U["name"]: "Room 1", U["status"]: "Occupied", U["property"]: ["recP1"]}),
                rec("recU2", {U["name"]: "Unit 1", U["status"]: "Void", U["property"]: ["recP2"]}),
                rec("recU3", {U["name"]: "Room 3", U["status"]: "Void", U["property"]: ["recP1"]}),
                rec("recU4", {U["name"]: "Agent room", U["status"]: "Void", U["property"]: ["recP3"]}),
                rec("recU5", {U["name"]: "Room 5", U["status"]: "Not Ready", U["growth"]: "Leave as is", U["property"]: ["recP1"]}),
                rec("recU6", {U["name"]: "Soham room", U["status"]: "Occupied", U["property"]: ["recP4"]})],
      "tenancies": [rec("recT1", {TY["end"]: iso(DAY + timedelta(days=10)), TY["unit"]: ["recU1"]}),
                    rec("recT2", {TY["end"]: iso(DAY + timedelta(days=90)), TY["unit"]: ["recU1"]}),
                    rec("recT3", {TY["unit"]: ["recU1"], TY["firstPayment"]: ["2026-09-20"]})],
      "levers": [rec("recG1", {G["title"]: "5 Dalham Place: 2 more rooms let to over-35 UC tenants", G["lever"]: "Room release", G["status"]: "Adopted", G["property"]: ["recP1"]}),
                 rec("recG2", {G["title"]: "5 Dalham Place: 1 more room", G["lever"]: "Room release", G["status"]: "Dropped", G["property"]: ["recP1"]}),
                 rec("recG3", {G["title"]: "Take back", G["lever"]: "Take-back", G["status"]: "Adopted", G["property"]: ["recP1"]})],
      "tenants": [rec("recN1", {TN["name"]: "Alan Tenant", TN["status"]: "Active", TN["rentType"]: "Universal Credit", TN["dob"]: "1970-01-01", TN["email"]: "alan@example.com", TN["unit"]: ["recU1"]}),
                  rec("recN2", {TN["name"]: "Young Tenant", TN["status"]: "Active", TN["rentType"]: "Universal Credit", TN["dob"]: "2000-01-01", TN["email"]: "young@example.com", TN["unit"]: ["recU1"]}),
                  rec("recN3", {TN["name"]: "New Person", TN["status"]: "Active", TN["phone"]: "07111 222333", TN["tenancies"]: ["recT3"]}, created="2026-09-20T10:00:00.000Z"),
                  rec("recN4", {TN["name"]: "Stopped Tenant", TN["status"]: "Active", TN["rentType"]: "Universal Credit", TN["dob"]: "1960-01-01", TN["email"]: "stopped@example.com", TN["unit"]: ["recU1"]})],
      "refs": [rec("recR1", {R["org"]: "West Suffolk housing options", R["area"]: "West Suffolk", R["email"]: "housing@westsuffolk.gov.uk", R["status"]: "Active", R["confidence"]: "High"}),
               rec("recR2", {R["org"]: "Jimmy's", R["area"]: "Cambridge", R["email"]: "moveon@jimmys.org.uk", R["status"]: "Active"}),
               rec("recR3", {R["org"]: "Opted out org", R["area"]: "Haverhill", R["email"]: "no@x.org", R["status"]: "Opted out"}),
               rec("recR4", {R["org"]: "Far away", R["area"]: "Hull", R["email"]: "hull@x.org", R["status"]: "Active"}),
               rec("recR5", {R["org"]: "Soham only", R["area"]: "Soham", R["email"]: "soham@x.org", R["status"]: "Active"})],
      "optouts": [rec("recO1", {O["email"]: "stopped@example.com"})],
      "leads": [], "tasks": [],
    }

def lead(i, **kw):
    f = {L["name"]: kw.get("name", "Test Person"), L["consent"]: kw.get("consent", True), L["uc"]: kw.get("uc", "Yes"),
         L["single"]: kw.get("single", "Yes"), L["areas"]: kw.get("areas", ["Haverhill"])}
    if kw.get("dob", "1980-01-01"): f[L["dob"]] = kw.get("dob", "1980-01-01")
    for k in ("stage", "phone", "email", "legacyRef", "referredTenant", "tenant", "bonus", "lastContacted", "referredName", "royTask", "heardFrom"):
        if k in kw: f[L[k]] = kw[k]
    return rec(i, f, created=kw.get("created", "2026-09-24T10:00:00.000Z"))

class FakeWriter(tl.Writer):
    def __init__(self):
        super().__init__(True); self.cards, self.roy, self.added, self.patches, self.bonuses, self.optouts = [], [], [], [], [], []
    def patch(self, table, rows, what): self.patches += [dict(r, table=table) for r in rows]
    def raise_card(self, card): self.cards.append(card); return "recCARD%d" % len(self.cards)
    def to_roy(self, task): self.roy.append(task); return "recROY%d" % len(self.roy)
    def add_to_roy_task(self, task, extra, day): self.added.append((task["id"], extra)); return task["id"]
    def bonus_row(self, *a): self.bonuses.append(a[1:3])
    def opt_out(self, email, who, how, day, decision="Opted out"): self.optouts.append((email, who) if decision == "Opted out" else (email, who, decision))
    def set_decision(self, email, decision, data): self.optouts.append((email, "decision", decision))
    def seen_replies(self): return set(getattr(self, "seen", set()))
    def mark_replies_seen(self, ids): self.seen = set(ids)
    def roy_state(self): return getattr(self, "rs", {"read": {}, "unclear": {}})
    def save_roy_state(self, state): self.rs = state

def task(name, status="Approval", created="2026-09-25T08:00:00.000Z", **f):
    fields = {TK["name"]: name, TK["status"]: status}
    for k, v in f.items(): fields[TK[k]] = v
    return rec("recTASK" + str(abs(hash(name)) % 100000), fields, created=created)

def stages(fw): return {p["id"]: p["fields"].get(L["stage"]) for p in fw.patches if L["stage"] in p["fields"]}

scenario = json.loads(sys.stdin.read())
out = {}
exec(scenario["code"])
print("RESULT " + json.dumps(out, default=str))
`;

function py(code) {
  const stdout = execFileSync('python3', ['-c', HARNESS], { input: JSON.stringify({ code }), encoding: 'utf8' });
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
  return JSON.parse(line.slice(7));
}

describe('what is ours, and the openings', () => {
  const r = py(`
w = world()
o = tl.openings(w, DAY)
out["keys"] = [x["key"] for x in o]
out["rooms"] = {x["key"]: x["rooms"] for x in o}
out["scope"] = sorted(tl.scope(w))
out["towns"] = sorted(tl.let_towns(w))
w2 = world(); w2["props"] = [p for p in w2["props"] if p["fields"].get(P["agent"]) != "Property Portfolio"]
try:
    tl.scope(w2); out["control"] = False
except RuntimeError as e:
    out["control"] = "control failed" in str(e)
`);
  it('the property strategy decides (the unit fields are blank), and an agent-run property is never ours', () => {
    expect(r.scope).toEqual(['recU1', 'recU3', 'recU5', 'recU6']);
    expect(r.keys).not.toContain('unit:recU4');
  });
  it('counts a UC void, a room being readied, a notice inside 60 days and an adopted room move', () => {
    expect(r.keys.sort()).toEqual(['lever:recG1', 'tenancy:recT1', 'unit:recU3', 'unit:recU5']);
    expect(r.rooms['lever:recG1']).toBe(2);
  });
  it('leaves out a single-let void (the family let), a dropped move and a take-back not in progress', () => {
    expect(r.keys).not.toContain('unit:recU2');
    expect(r.keys).not.toContain('lever:recG2');
    expect(r.keys).not.toContain('lever:recG3');
  });
  it('a tenancy ending in 90 days is not an opening yet', () => {
    expect(r.keys).not.toContain('tenancy:recT2');
  });
  it('every town we let UC rooms in counts, openings or not', () => {
    expect(r.towns).toEqual(['Haverhill', 'Soham']);
  });
  it('no self-managed UC unit at all fails loudly instead of reporting no openings', () => {
    expect(r.control).toBe(true);
  });
});

describe('screening', () => {
  const r = py(`
lt = {"Haverhill", "Soham"}
cases = {
  "fits": lead("a")["fields"], "thirty": lead("b", dob="1996-06-01")["fields"],
  "noUC": lead("c", uc="No")["fields"], "couple": lead("d", single="No")["fields"],
  "elsewhere": lead("e", areas=["Other"])["fields"], "cambridge": lead("f", areas=["Cambridge"])["fields"],
  "noConsent": lead("g", consent=False)["fields"], "noDob": lead("h", dob=None)["fields"],
  "applying": lead("i", uc="Applying")["fields"], "soham": lead("j", areas=["Soham"])["fields"],
}
out = {k: list(tl.screen(v, DAY, lt)[:2]) for k, v in cases.items()}
out["thirtyTurns"] = tl.screen(cases["thirty"], DAY, lt)[2].get(L["turns35"])
w = world()
w["tenants"].append(rec("recN9", {TN["name"]: "Alan Tenant", TN["status"]: "Former"}))
out["nameOne"] = tl.match_tenant_by_name(w, "my friend alan tenant from Dalham")
w["tenants"].append(rec("recN8", {TN["name"]: "Alan Tenant", TN["status"]: "Active"}))
out["nameTwo"] = tl.match_tenant_by_name(w, "Alan Tenant")
`);
  it('35+, on UC, alone, a town we let in = Qualified, including Soham on a day with no Soham opening', () => {
    expect(r.fits[0]).toBe('Qualified');
    expect(r.cambridge[0]).toBe('Qualified');
    expect(r.soham[0]).toBe('Qualified');
    expect(r.applying[1]).toMatch(/check at the viewing/);
  });
  it('a 30-year-old waits for their 35th birthday, with the date stored', () => {
    expect(r.thirty[0]).toBe('Waiting to turn 35');
    expect(r.thirtyTurns).toBe('2031-06-01');
  });
  it.each([['noUC', /Universal Credit/], ['couple', /own/], ['elsewhere', /no rooms there/], ['noConsent', /consent/]])(
    '%s is Not suitable with the reason', (k, why) => {
      expect(r[k][0]).toBe('Not suitable');
      expect(r[k][1]).toMatch(why);
    });
  it('no date of birth stays New with a note to ask', () => {
    expect(r.noDob).toEqual(['New', 'no date of birth: ask at the first call']);
  });
  it('a referrer name links only when exactly one ACTIVE tenant matches', () => {
    expect(r.nameOne).toBe('recN1');
    expect(r.nameTwo).toBeNull();
  });
});

describe('cards pass the real submit gates, and the Writer feeds the real commands', () => {
  const r = py(`
import inspect
ad = load_mod("ad", "agent-dispatch.py")
from agent_email_format import validate_submission_any
w = world(); o = tl.openings(w, DAY); towns = tl.by_town(o)
w["leads"] = [lead("recL1", stage="Qualified", email="p@example.com", lastContacted="2026-07-01"),
              lead("recL2", stage="Qualified", email="legacy@example.com", lastContacted="2026-07-01", legacyRef="tenant-app:2019-01-01 10:00:00")]
cards = [tl.mailout_cards(w, towns, DAY)[0], tl.mailout_cards(w, {}, DAY)[0],
         tl.referral_card(w, "Haverhill", towns["Haverhill"], DAY), tl.keepwarm_card(w, DAY)]
res = []
for c in cards:
    parsed = validate_submission_any(c["output"])
    res.append({"kind": c["kind"], "toEach": parsed["toEach"], "from": parsed["from"], "name": c["name"],
                "gates": [ad.carry_out_problem(c["output"]), ad.track_record_problem(c["output"], True),
                          ad.plain_summary_problem(c["plainTask"], c["plainApprove"]),
                          ad.handback_problem(c["output"], "Correspondence") or "",
                          ad.tier_match(ad.TIER1_PATTERNS, c["name"], c["description"], c["output"]) or ""],
                "body": parsed["body"]})
out["cards"] = res
# the in-process calls: every args.X the real command reads is on the Namespace the Writer builds
src = open(os.path.join(${JSON.stringify(SCRIPTS)}, "tenant-leads.py")).read()
def ns_fields(call):
    m = re.search(re.escape(call) + r",\\s*argparse\\.Namespace\\((.*?)\\)\\)", src, re.S)
    return set(re.findall(r"(\\w+)=", m.group(1)))
def reads(fn):
    s = inspect.getsource(fn)
    return set(re.findall(r"args\\.(\\w+)", s)) - {"get"}
out["missingSubmit"] = sorted(reads(ad.cmd_submit) - ns_fields("ad.cmd_submit"))
out["missingHandover"] = sorted(reads(ad.cmd_handover) - ns_fields("ad.cmd_handover"))
out["royInRoster"] = ad.ROY_EMAIL in ad.HUMANS
out["propertyIsRoleAgent"] = ad.PROPERTY_REC_ID in ad.ROLE_AGENTS
# the duplicate gate's keys: no two kinds of chain task can fold into each other
ct = load_mod("ct", "create-agent-task.py")
names = [tl.PREFIXES[k] + "Haverhill rooms 25 Sep 2026" for k in tl.PREFIXES] + [tl.PREFIXES["mailout"] + "Soham rooms 25 Sep 2026"]
out["keys"] = [ct.dupe_task_key(n) for n in names]
`);
  it('every card clears carry-out, track record, plain summary, hand-back and tier-1 checks', () => {
    for (const c of r.cards) expect(c.gates, c.kind).toEqual(['', '', '', '', '']);
  });
  it('the mail-out goes to active referrers near Haverhill only, from info@, street not door', () => {
    const m = r.cards[0];
    expect(m.from).toBe('info@agilelets.co.uk');
    expect(m.toEach.sort()).toEqual(['housing@westsuffolk.gov.uk', 'moveon@jimmys.org.uk']);
    expect(m.body).toMatch(/Dalham Place/);
    expect(m.body).not.toMatch(/\b5 Dalham/);
    expect(m.body).toMatch(/prefill_How\+They\+Heard=Referrer/);
    expect(m.body).toMatch(/reply STOP/);
  });
  it('the referral email reaches UC tenants aged 35+ only, and never an address that opted out', () => {
    const t = r.cards[2];
    expect(t.toEach).toEqual(['alan@example.com']);
    expect(t.body).toMatch(/£50 once their first month's rent has been paid/);
  });
  it('a past applicant is never on an email list, even marked Qualified', () => {
    expect(r.cards[3].toEach).toEqual(['p@example.com']);
  });
  it('the Writer hands submit and handover every argument they read', () => {
    expect(r.missingSubmit).toEqual([]);
    expect(r.missingHandover).toEqual([]);
    expect(r.royInRoster).toBe(true);
    expect(r.propertyIsRoleAgent).toBe(true);
  });
  it('each kind of chain task, and each town, has its own duplicate key', () => {
    expect(new Set(r.keys).size).toBe(r.keys.length);
  });
});

describe('advert copy', () => {
  const r = py(`
w = world(); o = tl.openings(w, DAY)
t = tl.adverts_task("Haverhill", tl.by_town(o)["Haverhill"], DAY)
blocks = t["description"].split("\\n\\n")
out["facebook"] = [b for b in blocks if b.startswith("Facebook")][0]
out["spareroom"] = [b for b in blocks if b.startswith("SpareRoom")][0]
out["all"] = t["description"]
`);
  it('the Facebook version carries no age preference (Meta Commerce Policy)', () => {
    expect(r.facebook).not.toMatch(/35/);
    expect(r.facebook).toMatch(/Universal Credit welcome/);
  });
  it('other sites say 35+ positively, and nothing says "no children" (Renters\' Rights Act s.33)', () => {
    expect(r.spareroom).toMatch(/aged 35/);
    expect(r.all).not.toMatch(/children/i);
    expect(r.all).toMatch(/prefill_How\+They\+Heard=SpareRoom/);
  });
});

describe('the daily run', () => {
  const r = py(`
w = world()
w["leads"] = [lead("recL1"), lead("recL2", dob="1999-01-01"),
              lead("recL3", stage="Past applicant", phone="07000000001", legacyRef="tenant-app:2019-05-01 10:00:00"),
              lead("recL4", stage="Waiting to turn 35", dob="1991-09-20", consent=False, legacyRef="tenant-app:2018-01-01 10:00:00"),
              lead("recL5", stage="With Roy", phone="07111222333", referredTenant=["recN1"], created="2026-09-10T10:00:00.000Z"),
              lead("recL6", stage="Waiting to turn 35", dob="1991-09-21", legacyRef="tenant-app:2018-02-01 10:00:00", consent=True),
              lead("recL7", areas=["Cambridge"])]
w["leads"][3]["fields"][L["turns35"]] = "2026-09-20"
w["leads"][5]["fields"][L["turns35"]] = "2026-09-21"
fw = FakeWriter()
opens, notes, fails = tl.run(w, DAY, fw, replies=lambda: [])
out["cards"] = [c["kind"] for c in fw.cards]
out["roy"] = [t["kind"] for t in fw.roy]
v = fw.roy[[t["kind"] for t in fw.roy].index("viewings")]
out["viewingLeads"] = v["leadIds"]
out["stages"] = stages(fw)
out["bonuses"] = fw.bonuses
out["fails"] = fails
# the same day again, after a reload: the first run's writes are on the leads and its tasks on the board
byid = {l["id"]: l for l in w["leads"]}
for p in fw.patches:
    if p["id"] in byid: byid[p["id"]]["fields"].update(p["fields"])
for c in fw.cards: w["tasks"].append(task(c["name"], notes="TENANT CHAIN IDS: " + ",".join(c.get("ids") or [])))
for t in fw.roy: w["tasks"].append(task(t["name"], status="Today"))
fw2 = FakeWriter()
tl.run(w, DAY, fw2, replies=lambda: [])
out["second"] = {"cards": [c["kind"] for c in fw2.cards], "roy": [t["kind"] for t in fw2.roy]}
# a new qualified sign-up the next day, while Roy still holds yesterday's list: a new list of just them
w["leads"].append(lead("recL8", created="2026-09-26T09:00:00.000Z"))
fw3 = FakeWriter()
tl.run(w, DAY + timedelta(days=1), fw3, replies=lambda: [])
out["third"] = {"roy": [t["kind"] for t in fw3.roy], "leads": [t.get("leadIds") for t in fw3.roy], "stages": stages(fw3)}
`);
  it('raises the mail-out and referral cards and hands adverts and viewings to Roy', () => {
    expect(r.cards.sort()).toEqual(['mailout', 'referral']);
    expect(r.roy.sort()).toEqual(['adverts', 'viewings']);
    expect(r.fails).toEqual([]);
  });
  it('screens new sign-ups to Qualified and sends them to Roy with a past applicant to phone', () => {
    expect(r.stages.recL1).toBe('With Roy');
    expect(r.stages.recL7).toBe('With Roy');
    expect(r.stages.recL2).toBe('Waiting to turn 35');
    expect(r.viewingLeads).toEqual(['recL1', 'recL7', 'recL3']);
  });
  it('a past applicant who turns 35 stays phone-only, even with a consent tick', () => {
    expect(r.stages.recL4).toBe('Past applicant');
    expect(r.stages.recL6).toBe('Past applicant');
  });
  it('a lead whose phone matches a new tenant becomes a tenant and, referred by a tenant, its bonus is listed', () => {
    expect(r.stages.recL5).toBe('Became tenant');
    expect(r.bonuses).toEqual([['Alan Tenant', 'New Person']]);
  });
  it('a second run the same day raises nothing new', () => {
    expect(r.second).toEqual({ cards: [], roy: [] });
  });
  it('a new sign-up the next day goes to Roy on a new list of just that person', () => {
    expect(r.third.roy).toEqual(['viewings']);
    expect(r.third.leads).toEqual([['recL8']]);
    expect(r.third.stages.recL8).toBe('With Roy');
  });
});

describe('replies', () => {
  // Messages in the SHAPE the Gmail worker returns (/gmail/list): from and subject sit under headers.
  const r = py(`
w = world()
w["leads"] = [lead("recL1", stage="With Roy", email="lead@example.com"),
              lead("recL2", stage="With Roy", email="yes@example.com"),
              lead("recL3", stage="Qualified", email="stopper@example.com"),
              lead("recL4", stage="Became tenant", email="tenant@example.com", referredTenant=["recN1"])]
def msg(i, frm, subject, body, **h):
    return {"id": i, "threadId": "t" + i, "headers": dict({"from": frm, "subject": subject, "date": "Thu, 24 Sep 2026"}, **h), "body": body}
msgs = [
  msg("m1", "Housing <housing@westsuffolk.gov.uk>", "Re: Rooms in Haverhill for single adults", "Please STOP emailing us.\\n\\nOn Tue, Roy wrote:\\n> Hello"),
  msg("m2", "lead@example.com", "Re: Are you still looking for a room?", "No\\n\\n> You registered"),
  msg("m3", "yes@example.com", "Re: Are you still looking for a room?", "Yes please!"),
  msg("m4", "stopper@example.com", "Re: Are you still looking for a room?", "unsubscribe"),
  msg("m5", "tenant@example.com", "Re: £50 for you when a friend moves in", "Stop"),
  msg("m6", "ooo@council.gov.uk", "Automatic reply: Rooms in Haverhill", "Stop", **{"auto-submitted": "auto-replied"}),
]
fw = FakeWriter()
tl.run(w, DAY, fw, only="replies", replies=lambda: msgs)
out["optouts"] = sorted(fw.optouts)
out["stages"] = stages(fw)
out["heard"] = {p["id"]: p["fields"].get(L["heardFrom"]) for p in fw.patches if L["heardFrom"] in p["fields"]}
out["refStatus"] = [p["fields"].get(R["status"]) for p in fw.patches if p["table"] == tl.T_REFS]
out["seen"] = sorted(fw.seen)
# the same messages the next day: already handled, nothing acts again (a manual correction stands)
fw2 = FakeWriter(); fw2.seen = fw.seen
tl.run(w, DAY, fw2, only="replies", replies=lambda: msgs)
out["again"] = [len(fw2.optouts), len(fw2.patches)]
maybe = ["Haverhill One Stop Shop\\nThe Council", "is there a bus stop near Dalham Place?", "Please don't stop sending these",
         "Can you refer to the Stop Smoking service?"]
out["maybe"] = [tl.classify_reply("Re: Rooms in Haverhill", b) for b in maybe]
out["none"] = [tl.classify_reply("Re: Are you still looking for a room?", b) for b in
               ["No luck so far, please keep me on the list", "No, not found anywhere yet. Still looking!"]]
stops = ["Please remove us from your mailing list.", "Please remove me from your list, thank you", "Remove me from this list",
         "Unsubscribe me please", "Please stop emailing us, thanks", "Please stop sending these emails.",
         "Hi Roy,\\n\\nPlease take us off your list."]
out["stops"] = [tl.classify_reply("Re: Rooms in Haverhill", b) for b in stops]
out["greetings"] = [tl.classify_reply("Re: Rooms in Haverhill", b) for b in
                    ["Hi, please stop", "Hello - STOP", "Hi, please remove us from your list", "Hello please unsubscribe us", "Hi Roy stop emailing me"]]
out["yeses"] = [tl.classify_reply("Re: Are you still looking for a room?", b) for b in ["Yes still looking", "Yes, still looking thanks", "Yes I found somewhere"]]
fw3 = FakeWriter()
tl.run(w, DAY, fw3, only="replies", replies=lambda: [msg("m9", "sig@council.gov.uk", "Re: Rooms in Haverhill", "Thanks\\n\\nHaverhill One Stop Shop")])
out["flaggedOptouts"] = fw3.optouts
w["optouts"].append({"id": "recOchk", "fields": {O["email"]: "sig@council.gov.uk", O["decision"]: "Check needed"}})
fw4 = FakeWriter()
tl.run(w, DAY, fw4, only="replies", replies=lambda: [msg("m10", "sig@council.gov.uk", "Re: Rooms in Haverhill", "Unsubscribe")])
out["checkThenStop"] = fw4.optouts
# both in one run, newest first as Gmail lists them: the STOP (newer) must win
w9 = world()
fw9 = FakeWriter()
both = [dict(msg("s1", "x@y.org", "Re: Rooms in Haverhill", "Please stop"), internalDate=2000),
        dict(msg("c1", "x@y.org", "Re: Rooms in Haverhill", "Thanks. See you at the One Stop Shop"), internalDate=1000)]
tl.run(w9, DAY, fw9, only="replies", replies=lambda: both)
out["bothInOneRun"] = fw9.optouts
out["quoted"] = tl.classify_reply("Re: Rooms", "Thanks, will pass it on.\\n\\nOn Mon Roy wrote:\\n> reply STOP to be removed")
`);
  it('STOP opts the sender out for good, whoever they are, from the header sender', () => {
    expect(r.optouts).toEqual([['housing@westsuffolk.gov.uk', 'Referrer'], ['stopper@example.com', 'Lead'], ['tenant@example.com', 'Lead']]);
    expect(r.refStatus).toEqual(['Opted out']);
    expect(r.stages.recL3).toBe('Opted out');
  });
  it('a tenant who opts out keeps Became tenant, so the referral bonus stands', () => {
    expect(r.stages.recL4).toBeUndefined();
  });
  it('NO alone marks the lead Not looking; YES keeps them on the list', () => {
    expect(r.stages.recL1).toBe('Not looking');
    expect(r.heard.recL2).toBe('2026-09-25');
    expect(r.stages.recL2).toBeUndefined();
  });
  it('an auto-reply is never an opt-out', () => {
    expect(r.optouts.map((o) => o[0])).not.toContain('ooo@council.gov.uk');
  });
  it('signatures and questions that mention stop are flagged for a person, never acted on', () => {
    expect(r.maybe).toEqual(['check', 'check', 'check', 'check']);
    expect(r.flaggedOptouts).toEqual([['sig@council.gov.uk', 'Other', 'Check needed']]);
    expect(r.none).toEqual([null, null]);
    expect(r.quoted).toBeNull();
  });
  it('ordinary ways of asking to stop are honoured, including after a greeting', () => {
    expect(r.stops).toEqual(['stop', 'stop', 'stop', 'stop', 'stop', 'stop', 'stop']);
  });
  it('a clear STOP from a sender waiting on a check turns the check into an opt-out', () => {
    expect(r.checkThenStop).toEqual([['sig@council.gov.uk', 'decision', 'Opted out']]);
  });
  it('an unclear reply then a clear STOP in the same run ends Opted out', () => {
    expect(r.bothInOneRun).toEqual([['x@y.org', 'Other', 'Check needed'], ['x@y.org', 'decision', 'Opted out']]);
  });
  it('a one-line opt-out that starts with a greeting is honoured', () => {
    expect(r.greetings).toEqual(['stop', 'stop', 'stop', 'stop', 'stop']);
  });
  it('a yes with a few more words still counts, and "yes I found somewhere" does not', () => {
    expect(r.yeses).toEqual(['yes', 'yes', null]);
  });
  it('each message is acted on once, so a daily re-read cannot undo a correction', () => {
    expect(r.seen).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(r.again).toEqual([0, 0]);
  });
});

describe('the Writer against the real command outputs', () => {
  const r = py(`
import types
calls = []
def cmd_handover(args):
    calls.append(("handover", args.task, args.to))
    print(json.dumps({"handedOver": args.task, "to": args.to, "name": "Roy Lavin", "reason": args.reason, "emailed": True, "NOT EMAILED": None}))
def cmd_submit(args):
    calls.append(("submit", args.task)); sys.exit("ERROR: refusing to submit recNEW1 - test refusal")
ad = types.SimpleNamespace(cmd_handover=cmd_handover, cmd_submit=cmd_submit, ROY_EMAIL="roy@example.com", PROPERTY_REC_ID="recPA")
tl._MODS.update({"ad": ad})
patched = []
def fake_api(method, path, payload=None, params=None):
    patched.append((method, path, payload))
    return {"records": [{"id": "recNEW1"}]} if method == "POST" else {}
tl.api = fake_api
w = tl.Writer(False)
out["handover"] = w.to_roy({"name": "TENANT ADVERTS: Haverhill advert copy", "description": "x", "kind": "adverts", "town": "Haverhill"})
def not_emailed(args):
    print(json.dumps({"handedOver": args.task, "emailed": False, "NOT EMAILED": "worker down"}))
ad.cmd_handover = not_emailed
try:
    w.to_roy({"name": "TENANT ADVERTS: x", "description": "x", "kind": "adverts", "town": "Haverhill"}); out["loud"] = False
except RuntimeError as e:
    out["loud"] = "NOT emailed" in str(e)
try:
    w.raise_card({"name": "TENANT MAILOUT: x", "description": "x", "output": "x", "ids": [], "kind": "mailout", "town": "Haverhill", "plainTask": "a", "plainApprove": "b"})
    out["refused"] = False
except RuntimeError:
    out["refused"] = True
out["cancelled"] = any(p[0] == "PATCH" and p[2]["records"][0]["fields"].get(tl.TK["status"]) == "Cancelled" for p in patched)
posts = [p for p in patched if p[0] == "POST" and p[1] == tl.T_TASKS]
out["direct"] = bool(posts) and all("Notes" not in json.dumps(p[2]) or "TRACK RECORD" not in json.dumps(p[2]) for p in posts)
out["noCreateGate"] = "ct" not in tl._MODS
`);
  it('a normal handover (its NOT EMAILED key is null) is a success', () => {
    expect(r.handover).toBe('recNEW1');
  });
  it('a handover that did not email Roy is a loud failure', () => {
    expect(r.loud).toBe(true);
  });
  it('a card the submit gate refuses is cancelled, so it cannot block the next mail-out', () => {
    expect(r.refused).toBe(true);
    expect(r.cancelled).toBe(true);
  });
  it('chain tasks are created directly: no inbox-task word matcher, no track-record search in their notes', () => {
    expect(r.direct).toBe(true);
    expect(r.noCreateGate).toBe(true);
  });
});

describe('the referral bonus row', () => {
  // Run Date is the Friday scan's proof of life: js/invoices.js lastPaymentRunDate() takes the newest
  // one on any row. The field id is read from js/config.js, the page's own source, not copied here.
  const runDateId = (readFileSync(path.join(root, 'js', 'config.js'), 'utf8').match(/runDate:\s*'(fld\w+)'/) || [])[1];
  const r = py(`
posted = []
def fake_api(method, path, payload=None, params=None):
    if method == "POST":
        posted.append((path, payload))
    return {"records": []}
tl.api = fake_api
tl.Writer(False).bonus_row({"id": "recLEAD1"}, "Alan Tenant", "New Person", DAY, DAY)
out["posts"] = [(p, [r["fields"] for r in body["records"]]) for p, body in posted]
out["invoices"] = tl.T_INVOICES
`);
  const fields = r.posts.length === 1 ? r.posts[0][1][0] : {};
  it('writes one unpaid £50 row to the Payment Run for the referrer', () => {
    expect(r.posts.length).toBe(1);
    expect(r.posts[0][0]).toBe(r.invoices);
    expect(Object.values(fields)).toEqual(expect.arrayContaining(['Alan Tenant', 50, 'Unpaid', 'Tenant referral']));
  });
  it('never stamps Run Date, so a weekday bonus cannot make a dead Friday scan read as current', () => {
    expect(runDateId).toMatch(/^fld/);
    expect(Object.keys(fields).length).toBeGreaterThan(0);
    expect(Object.keys(fields)).not.toContain(runDateId);
    expect(Object.keys(fields)).not.toContain('Run Date');
  });
});

describe('who gets the next mail-out', () => {
  const r = py(`
w = world()
w["tasks"] = [task("TENANT MAILOUT: Soham rooms 24 Sep 2026", status="Approval", created="2026-09-24T08:00:00.000Z", notes="TENANT CHAIN IDS: recR2")]
w["refs"][0]["fields"][R["lastEmailed"]] = "2026-09-20"
fw = FakeWriter()
tl.run(w, DAY, fw, only="mail-out", replies=lambda: [])
out["to"] = [c["emails"] for c in fw.cards]
w2 = world()
w2["levers"].append(rec("recG9", {G["title"]: "Take back", G["lever"]: "Take-back", G["status"]: "In progress", G["property"]: ["recP9"]}))
w2["props"].append(rec("recP9", {P["name"]: "7 Test Lane", P["area"]: "Hull", P["agent"]: "Head Lease Ltd"}))
w2["leads"] = [lead("recH1", areas=["Hull"])]
fw2 = FakeWriter()
tl.run(w2, DAY, fw2, only="screen", replies=lambda: [])
out["hull"] = stages(fw2).get("recH1")
w3 = world()
w3["units"][5]["fields"][U["status"]] = "Void"
c3 = tl.mailout_cards(w3, tl.by_town(tl.openings(w3, DAY)), DAY)
out["twoTowns"] = [c["towns"] for c in c3]
out["twoTownsTo"] = [sorted(c["emails"]) for c in c3]
out["twoTownsBody"] = c3[0]["output"]
w4 = world()
w4["tasks"] = [task("TENANT REFERRAL: Haverhill friends 25 Sep 2026", status="Cancelled", notes="TENANT CHAIN REFUSED: the submit gate refused this card")]
out["afterRefusal"] = tl.due_again(tl.chain_tasks(w4, "referral", "Haverhill"), 28, DAY)[0]
w6 = world()
w6["tasks"] = [task("TENANT MAILOUT: Haverhill rooms 24 Sep 2026", status="Completed", created="2026-09-24T08:00:00.000Z",
                    outcome="Rejected", notes="TENANT CHAIN IDS: recR1,recR2")]
o6 = tl.by_town(tl.openings(w6, DAY))
out["rejectedNextDay"] = len(tl.mailout_cards(w6, o6, DAY))
out["rejected15Days"] = len(tl.mailout_cards(w6, o6, DAY + timedelta(days=15)))
w7 = world(); w7["optouts"].append(rec("recO2", {O["email"]: "housing@westsuffolk.gov.uk", O["decision"]: "Check needed"}))
out["flaggedHeld"] = [c["emails"] for c in tl.mailout_cards(w7, tl.by_town(tl.openings(w7, DAY)), DAY)]
w7["optouts"][-1]["fields"][O["decision"]] = "Not an opt-out"
out["clearedBack"] = sorted(tl.mailout_cards(w7, tl.by_town(tl.openings(w7, DAY)), DAY)[0]["emails"])
w8 = world()
w8["tasks"] = [task("TENANT MAILOUT: Haverhill rooms 20 Sep 2026", status="Completed", created="2026-09-20T08:00:00.000Z",
                    outcome="Rejected", notes="TENANT CHAIN IDS: recR1,recR2")]
m8 = {x["key"]: (x["state"], x["note"]) for x in tl.monitor(w8, DAY, tl.openings(w8, DAY), [])["steps"]}
out["rejectedMonitor"] = m8["mailout"]
w10 = world(); w10["leads"] = [lead("recQ1", stage="Qualified", email="held@example.com"), lead("recQ2", stage="Qualified")]
w10["optouts"].append(rec("recO3", {O["email"]: "held@example.com", O["decision"]: "Check needed"}))
fw10 = FakeWriter()
tl.run(w10, DAY, fw10, only="viewings", replies=lambda: [])
out["heldNotCalled"] = [t["leadIds"] for t in fw10.roy]
w5 = world(); w5["props"] = [p for p in w5["props"] if p["fields"].get(P["agent"]) != "Property Portfolio"]
w5["leads"] = [lead("recS1", areas=["Soham"])]
fw5 = FakeWriter()
_, n5, f5 = tl.run(w5, DAY, fw5, replies=lambda: [])
out["scopeFail"] = {"screened": stages(fw5).get("recS1"), "failed": any(x.startswith("openings:") for x in f5),
                    "note": any("skipped" in x for x in n5)}
`);
  it('a referrer on a waiting card, or emailed in the last 14 days, is not emailed again', () => {
    expect(r.to).toEqual([]);
  });
  it('with Haverhill and Soham both open, every referrer is told once, about every open town near them', () => {
    expect(r.twoTowns).toEqual([['Haverhill', 'Soham'], ['Soham']]);
    expect(r.twoTownsTo).toEqual([['housing@westsuffolk.gov.uk', 'moveon@jimmys.org.uk'], ['soham@x.org']]);
    expect(r.twoTownsBody).toMatch(/- Haverhill: .*\n- Soham: /);
  });
  it('when the property read fails, sign-ups are left unscreened (not rejected) and the failure is recorded', () => {
    expect(r.scopeFail).toEqual({ screened: null, failed: true, note: true });
  });
  it('a mail-out Kevin rejects holds its referrers for 14 days, not until the next morning', () => {
    expect(r.rejectedNextDay).toBe(0);
    expect(r.rejected15Days).toBe(1);
  });
  it('a sender waiting on an opt-out check is held off until a person decides, and back once cleared', () => {
    expect(r.flaggedHeld).toEqual([['moveon@jimmys.org.uk']]);
    expect(r.clearedBack).toEqual(['housing@westsuffolk.gov.uk', 'moveon@jimmys.org.uk']);
  });
  it('a rejected, unsent mail-out does not count as telling anyone', () => {
    expect(r.rejectedMonitor[0]).toBe('fail');
    expect(r.rejectedMonitor[1]).toMatch(/closed without sending/);
  });
  it('a lead held by an opt-out check is not put on Roy\'s call list', () => {
    expect(r.heldNotCalled[0]).not.toContain('recQ1');
    expect(r.heldNotCalled[0]).toContain('recQ2');
  });
  it('a card the gate refused does not hold the next attempt back', () => {
    expect(r.afterRefusal).toBe(true);
  });
  it('a sign-up for a take-back town with a room in progress is not turned away', () => {
    expect(r.hull).toBe('Qualified');
  });
});

describe("Roy's replies, colleagues' STOPs and people who sign up again", () => {
  const r = py(`
w = world()
vt = task("TENANT VIEWINGS: Haverhill people to call 25 Sep 2026", status="Today",
          notes="[25 Sep 2026 14:02 Roy Lavin via his assistant, recREQ1] Booked John Smith for Tuesday. Jane no answer, Dave Brown not interested\\nMary Past is interested")
w["tasks"] = [vt]
w["leads"] = [lead("recJ", name="John Smith", stage="With Roy", royTask=[vt["id"]]),
              lead("recJa", name="Jane Doe", stage="With Roy", royTask=[vt["id"]]),
              lead("recD", name="Dave Brown", stage="With Roy", royTask=[vt["id"]]),
              lead("recM", name="Mary Past", stage="Past applicant", legacyRef="tenant-app:2019-01-01 10:00:00", royTask=[vt["id"]])]
fw = FakeWriter()
tl.run(w, DAY, fw, only="roy", replies=lambda: [])
got = {p["id"]: p["fields"] for p in fw.patches}
out["roy"] = {k: (v.get(L["stage"]), v.get(L["screening"])) for k, v in got.items()}
# Kevin corrects John by hand; the next run must not re-apply the old line over it.
[l for l in w["leads"] if l["id"] == "recJ"][0]["fields"][L["stage"]] = "With Roy"
fw_again = FakeWriter(); fw_again.rs = fw.rs
tl.run(w, DAY + tl.timedelta(days=1), fw_again, only="roy", replies=lambda: [])
out["again"] = fw_again.patches
# A NEW line from Roy is still read.
vt["fields"][TK["notes"]] += "\\n\\n[26 Sep 2026 09:10 Roy Lavin via his assistant, recREQ2] John Smith viewing on Friday at 2pm"
fw_new = FakeWriter(); fw_new.rs = fw_again.rs
tl.run(w, DAY + tl.timedelta(days=1), fw_new, only="roy", replies=lambda: [])
out["newLine"] = stages(fw_new)

def says(words, names):
    t = task("TENANT VIEWINGS: Soham x " + words[:20], status="Today",
             notes="[25 Sep 2026 15:00 Roy Lavin via his assistant, recREQ9] " + words)
    wx = world(); wx["tasks"] = [t]
    wx["leads"] = [lead("rec%d" % i, name=n, stage="With Roy", royTask=[t["id"]]) for i, n in enumerate(names)]
    f = FakeWriter(); tl.run(wx, DAY, f, only="roy", replies=lambda: [])
    st = stages(f)
    return [st.get("rec%d" % i) for i in range(len(names))], f.rs["unclear"]
out["twoInOne"] = says("John Smith booked and Jane Doe no answer", ["John Smith", "Jane Doe"])[0]
out["shared"] = says("Booked John Smith and Dave Brown for Tuesday", ["John Smith", "Dave Brown"])[0]
out["mixed"] = says("Dave Brown not interested and wants the room", ["Dave Brown"])[0]
out["negated"] = says("Dave Brown isn't interested. Jane Doe cancelled the viewing on Tuesday", ["Dave Brown", "Jane Doe"])[0]
out["bareViewing"] = says("John Smith viewing", ["John Smith"])
out["willCome"] = says("Will come round and look at the boiler, booked the plumber", ["Will Jones"])
out["surname"] = says("Lee booked for Monday", ["Lee Grant", "Mary Lee"])
out["lowercase"] = says("john booked for monday", ["John Smith"])
out["andJoin"] = says("Booked Mary and John Smith", ["John Smith", "Mary Smith", "Mary Jones"])[0]

w2 = world(); w2["tasks"] = [task("TENANT VIEWINGS: Haverhill x", status="Today", notes="[25 Sep 2026 14:02 Roy Lavin via his assistant, recREQ1] all done, thanks")]
w2["leads"] = [lead("recZ", name="Zed Person", stage="With Roy", royTask=[w2["tasks"][0]["id"]])]
fw2 = FakeWriter()
tl.run(w2, DAY, fw2, only="roy", replies=lambda: [])
out["unclear"] = [v["task"] for v in fw2.rs["unclear"].values()]
m2 = tl.monitor(w2, DAY, [], [])
out["unclearMonitor"] = next(s for s in m2["steps"] if s["key"] == "roy")
w2["royState"] = fw2.rs
m2b = tl.monitor(w2, DAY, [], [])
out["unclearMonitorState"] = next(s for s in m2b["steps"] if s["key"] == "roy")
out["unclearLater"] = next(s for s in tl.monitor(w2, DAY + tl.timedelta(days=8), [], [])["steps"] if s["key"] == "roy")["state"]
w5 = world(); w5["tasks"] = [task("TENANT VIEWINGS: Haverhill quiet", status="Today", created="2026-09-10T08:00:00.000Z")]
out["quiet"] = next(s for s in tl.monitor(w5, DAY, [], [])["steps"] if s["key"] == "roy")

w3 = world(); w3["sentThreads"] = {"t9": "housing@westsuffolk.gov.uk"}
fw3 = FakeWriter()
tl.run(w3, DAY, fw3, only="replies", replies=lambda: [{"id": "q1", "threadId": "t9",
    "headers": {"from": "Jane Smith <jane.smith@westsuffolk.gov.uk>", "subject": "RE: Rooms in Haverhill"}, "body": "Please stop"}])
out["colleague"] = sorted(fw3.optouts)
out["colleagueRefs"] = [p for p in fw3.patches if p.get("table") == tl.T_REFS]

def resign(old_kw, new_kw):
    w4 = world()
    w4["leads"] = [lead("recOld", stage="Past applicant", legacyRef="tenant-app:2018-01-01 10:00:00", **old_kw),
                   lead("recNew", **new_kw)]
    f4 = FakeWriter(); tl.run(w4, DAY, f4, only="screen", replies=lambda: [])
    return stages(f4)
out["reregistered"] = resign(dict(name="Pat Old", phone="07123456789"), dict(name="Pat Old", phone="07123 456789"))
out["phoneOnly"] = resign(dict(name="Pat Old", phone="07123456789"), dict(name="Sam New", phone="07123 456789"))
out["noConsent"] = resign(dict(name="Pat Old", phone="07123456789"), dict(name="Pat Old", phone="07123 456789", consent=False))
`);
  it("Roy's words move each named person: booked, not interested, and a first name alone when it is unique", () => {
    expect(r.roy.recJ[0]).toBe('Viewing booked');
    expect(r.roy.recD[0]).toBe('Not looking');
    expect(r.roy.recJa[0]).toBeNull();
    expect(r.roy.recJa[1]).toMatch(/no answer/);
  });
  it('a past applicant Roy says is interested stays phone-only, with a note to get them on the form', () => {
    expect(r.roy.recM[0]).toBeNull();
    expect(r.roy.recM[1]).toMatch(/fill in the form/);
  });
  it("each of Roy's lines is read once: a hand correction is never undone, and a new line still counts", () => {
    expect(r.again).toEqual([]);
    expect(r.newLine).toEqual({ recJ: 'Viewing booked' });
  });
  it('one sentence about two people gives each their own words, and shared words to both', () => {
    expect(r.twoInOne).toEqual(['Viewing booked', null]);
    expect(r.shared).toEqual(['Viewing booked', 'Viewing booked']);
  });
  it('a negation or a mixed message moves nobody', () => {
    expect(r.mixed).toEqual([null]);
    expect(r.negated).toEqual(['Not looking', null]);
    expect(r.bareViewing[0]).toEqual([null]);
    expect(Object.keys(r.bareViewing[1])).toHaveLength(1);
  });
  it("a first name alone never matches an everyday word, someone else's surname, or lower case", () => {
    expect(r.willCome[0]).toEqual([null]);
    expect(r.surname[0]).toEqual([null, null]);
    expect(r.lowercase[0]).toEqual([null]);
    // "Mary ... Smith" across two people is not Mary Smith, and two Marys make "Mary" alone nobody.
    expect(r.andJoin).toEqual(['Viewing booked', null, null]);
  });
  it("a reply from Roy that moves nobody shows on the monitor for a week, and a silent list warns", () => {
    expect(r.unclear).toEqual(['TENANT VIEWINGS: Haverhill x']);
    expect(r.unclearMonitorState.state).toBe('warn');
    expect(r.unclearMonitorState.note).toMatch(/moved nobody/);
    expect(r.unclearMonitorState.last).toBe('2026-09-25');
    expect(r.unclearLater).toBe('ok');
    expect(r.quiet.state).toBe('warn');
    expect(r.quiet.note).toMatch(/no word from Roy on 1 list/);
  });
  it("a colleague's STOP in our thread puts the team inbox on Check needed, never a straight opt-out", () => {
    expect(r.colleague).toEqual([['housing@westsuffolk.gov.uk', 'Referrer', 'Check needed'], ['jane.smith@westsuffolk.gov.uk', 'Other']]);
    expect(r.colleagueRefs).toEqual([]);
  });
  it('a past applicant who signs up again WITH consent has the old row retired; a shared phone alone does not', () => {
    expect(r.reregistered.recOld).toBe('Archived');
    expect(r.reregistered.recNew).toBe('Qualified');
    expect(r.phoneOnly.recOld).toBeUndefined();
    expect(r.noConsent.recOld).toBeUndefined();
  });
});

describe('the monitor reports what did NOT happen', () => {
  const r = py(`
w = world()
o = tl.openings(w, DAY)
m1 = tl.monitor(w, DAY, o, [])
w["tasks"] = [task("TENANT MAILOUT: Haverhill rooms 20 Sep 2026", status="Completed", created="2026-09-20T08:00:00.000Z",
                   outcome="Approved as-is", approvedAt="2026-09-21T09:00:00.000Z", notes="")]
w["leads"] = [lead("recNEW", stage="New", dob=None, created="2026-09-20T08:00:00.000Z")]
m2 = tl.monitor(w, DAY, o, [])
w["tasks"][0]["fields"][TK["notes"]] = "[21 Sep 2026 09:05 — send-email] PARTIAL: mail-out \\"x\\" to 1 address(es)"
m3 = tl.monitor(w, DAY, o, [])
w["tasks"][0]["fields"][TK["notes"]] += "\\n[22 Sep 2026 09:05 — send-email] SENT: mail-out \\"x\\" to 1 address(es)"
m4 = tl.monitor(w, DAY, o, [])
s = lambda m: {x["key"]: x["state"] for x in m["steps"]}
wv = world()
wv["tasks"] = [task("TENANT VIEWINGS: Haverhill people to call 25 Sep 2026", status="Today")]
vid = wv["tasks"][0]["id"]
wv["leads"] = [lead("recP1x", stage="Past applicant", legacyRef="tenant-app:2019-01-01 10:00:00", royTask=[vid]),
               lead("recW1", stage="With Roy")]
viewNote = [x["note"] for x in tl.monitor(wv, DAY, o, [])["steps"] if x["key"] == "viewings"][0]
big = dict(m1, run=["x" * 1000] * 200)
out = {"none": s(m1), "unsent": s(m2), "partial": s(m3), "sent": s(m4), "worst1": m1["worst"], "viewNote": viewNote,
       "payloadParses": bool(json.loads(tl.payload_json(big, limit=5000)))}
`);
  it('open rooms and no mail-out or adverts is a failure; no sign-ups before the first mail-out is not', () => {
    expect(r.none.mailout).toBe('fail');
    expect(r.none.adverts).toBe('fail');
    expect(r.none.leads).toBe('idle');
    expect(r.worst1).toBe('fail');
  });
  it('an approved card with no SENT stamp a day later is a failure, and so is a PARTIAL one', () => {
    expect(r.unsent.sent).toBe('fail');
    expect(r.partial.sent).toBe('fail');
    expect(r.sent.sent).toBe('ok');
  });
  it('a sign-up with no date of birth is flagged to watch, not a broken chain', () => {
    expect(r.unsent.screening).toBe('warn');
  });
  it("the viewings note counts past applicants on Roy's open list, not only sign-ups", () => {
    expect(r.viewNote).toBe('Roy has 1 sign-up(s) and 1 past applicant(s) to call');
  });
  it('an oversized report is trimmed and still parses', () => {
    expect(r.payloadParses).toBe(true);
  });
});

describe('the silent-zero control', () => {
  it('refuses to run on an empty read', () => {
    const r = py(`
tl.fetch_all = lambda table, params=None: []
try:
    tl.load(DAY); out["raised"] = False
except RuntimeError as e:
    out["raised"] = True; out["msg"] = str(e)
`);
    expect(r.raised).toBe(true);
    expect(r.msg).toMatch(/control failed/);
  });
});
