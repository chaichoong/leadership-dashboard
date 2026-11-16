// What the tenant-finding chain tells people is FREE (scripts/tenant-leads.py, FREE_NOW).
//
// Kevin corrected the number of free rooms in the mail-out four times (14 Oct, 28 Oct and 11 Nov
// 2026, property-administration lesson lines 364, 365, 388 and 400): "check the actual database for
// how many rooms we have free, as we don't have that many when you factor in the quarterly projects".
// The count came from rooms_line(), which added up every opening: rooms still in works, Growth Plan
// room moves, notices, and a room kept for one of our tenants moving house. On 16 Nov 2026 the live
// data gave "5 rooms free now" in Haverhill when no room was vacant and ready.
//
// Every email, advert and referral now counts ONLY a room vacant and ready today. These drive the
// REAL functions on fixtures shaped as Airtable returns them; every name, address, id and number in
// them is invented. Each case also runs against origin/main's copy of the script (set TL_SCRIPT to
// that copy) and fails there: see the PR for the counts.
//
// Back-tested (16 Nov 2026) by breaking each rule on a copy of the fixed script:
//   * origin/main's script                         -> all 10 cases fail
//   * move_hold() never holding a room             -> 9 of 10 fail
//   * live_tenancy() never seeing a live tenancy   -> 9 of 10 fail
//   * move_hold() reading the whole task name      -> 6 fail (a move OUT of a room held it)
//   * "mov" anywhere counting as a move ("Remove") -> 6 fail
//   * rooms_line() counting every opening again    -> 3 fail
//
// The harness cannot reach the network. One tenant-leads test once made real network calls by
// accident (tests/tenant-leads.test.js, the silent-zero control), so the block is installed before
// the script is even loaded, proved before any case runs, and the token reader is replaced so no
// case can read the Airtable token.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(root, 'scripts');
const TL_SCRIPT = process.env.TL_SCRIPT || path.join(SCRIPTS, 'tenant-leads.py');

const HARNESS = `
import socket, urllib.request

class NetworkBlocked(RuntimeError):
    pass

def _no_network(*a, **k):
    raise NetworkBlocked("a test may not reach the network")

socket.create_connection = _no_network
socket.getaddrinfo = _no_network
socket.socket.connect = _no_network
socket.socket.connect_ex = _no_network
urllib.request.urlopen = _no_network

def _network_blocked():
    try:
        urllib.request.urlopen("https://example.invalid/")
    except NetworkBlocked:
        return True
    return False

if not _network_blocked():
    raise SystemExit("the network block did not hold: refusing to run")

import importlib.util, json, sys, os
from datetime import date, timedelta
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
spec = importlib.util.spec_from_file_location("tl", ${JSON.stringify(TL_SCRIPT)})
tl = importlib.util.module_from_spec(spec); spec.loader.exec_module(tl)
tl._pat = _no_network                     # no case may read the Airtable token
L, R, U, TY, TN, P, G, TK = tl.L, tl.R, tl.U, tl.TY, tl.TN, tl.P, tl.G, tl.TK
DAY = date(2026, 11, 16)
def iso(d): return d.isoformat()
def rec(i, f, created="2026-11-01T10:00:00.000Z"): return {"id": i, "createdTime": created, "fields": f}
def unit(i, name, status, pid): return rec(i, {U["name"]: name, U["status"]: status, U["property"]: [pid]})
def mtask(i, name, status="Today", desc=""): return rec(i, {TK["name"]: name, TK["status"]: status, TK["desc"]: desc})

def world(ready=True):
    w = {
      "props": [rec("recPLARK", {P["name"]: "7 Larkspur Row", P["area"]: "Haverhill", P["strategy"]: "UC HMO", P["agent"]: "Property Portfolio"}),
                rec("recPQUIL", {P["name"]: "12 Quillon Close", P["area"]: "Haverhill", P["strategy"]: "UC HMO", P["agent"]: "Property Portfolio"}),
                rec("recPFENN", {P["name"]: "3 Fennick Way", P["area"]: "Haverhill", P["strategy"]: "UC HMO", P["agent"]: "Property Portfolio"}),
                rec("recPOSTR", {P["name"]: "9 Ostrey Lane", P["area"]: "Haverhill", P["strategy"]: "UC HMO", P["agent"]: "Fixture Lettings Ltd"})],
      "units": [unit("recU1fixture00001", "Unit 1 – 7 Larkspur Row", "Occupied", "recPLARK"),
                unit("recU2fixture00002", "Unit 2 – 7 Larkspur Row", "Void", "recPLARK"),       # ready
                unit("recU3fixture00003", "Unit 3 – 7 Larkspur Row", "Not Ready", "recPLARK"),  # in works
                unit("recU4fixture00004", "Unit 4 – 12 Quillon Close", "Void", "recPQUIL"),     # a move goes INTO it
                unit("recU5fixture00005", "Unit 5 – 12 Quillon Close", "Void", "recPQUIL"),     # a live tenancy on it
                unit("recU6fixture00006", "Unit 6 – 3 Fennick Way", "Rent Ready", "recPFENN"),  # ready
                unit("recU7fixture00007", "Unit 7 – 3 Fennick Way", "Void", "recPFENN"),        # its id in a move task
                unit("recU8fixture00008", "Unit 8 – 3 Fennick Way", "Void", "recPFENN"),        # a move goes OUT of it: ready
                unit("recU9fixture00009", "Unit 9 – 3 Fennick Way", "Void", "recPFENN"),        # only named in a question: ready
                unit("recUAfixture0000A", "Unit 10 – 3 Fennick Way", "Occupied", "recPFENN"),   # its tenant leaves soon
                unit("recUBfixture0000B", "Unit 11 – 9 Ostrey Lane", "Void", "recPOSTR")],      # an agent lets it: never ours
      "tenancies": [rec("recT1fixture00001", {TY["unit"]: ["recU1fixture00001"]}),
                    rec("recT5fixture00005", {TY["unit"]: ["recU5fixture00005"]}),
                    rec("recTAfixture0000A", {TY["unit"]: ["recUAfixture0000A"], TY["end"]: iso(DAY + timedelta(days=10))}),
                    rec("recT2fixture00002", {TY["unit"]: ["recU2fixture00002"], TY["end"]: iso(DAY - timedelta(days=30))})],
      "levers": [rec("recGfixture000001", {G["title"]: "7 Larkspur Row: 2 more rooms let to over-35 UC tenants",
                                           G["lever"]: "Room release", G["status"]: "Adopted", G["property"]: ["recPLARK"]})],
      "moves": [mtask("recMfixture000001", "Move Dana Fixture from 7 Larkspur Row Unit 1 to 12 Quillon Close Unit 4"),
                mtask("recMfixture000002", "Swap rooms: move Eli Fixture", desc="New unit recU7fixture00007 for Eli."),
                mtask("recMfixture000003", "Move Sam Fixture from 3 Fennick Way Unit 8 to 7 Larkspur Row Unit 1"),
                mtask("recMfixture000004", "Roy to confirm: is Ann Fixture moving into 7 Larkspur Row Unit 1, and has Bo Fixture (3 Fennick Way Unit 9) left?"),
                mtask("recMfixture000005", "Move Kit Fixture to 7 Larkspur Row Unit 20"),
                mtask("recMfixture000006", "Move Lee Fixture from 7 Larkspur Row Unit 1 to 3 Fennick Way Unit 6", status="Completed"),
                mtask("recMfixture000007", "Remove the old wardrobe", desc="In recU2fixture00002 and recU6fixture00006.")],
      "tenants": [rec("recNfixture000001", {TN["name"]: "Pat Fixture", TN["status"]: "Active", TN["rentType"]: "Universal Credit",
                                            TN["dob"]: "1970-03-03", TN["email"]: "pat@fixture.example", TN["unit"]: ["recU1fixture00001"],
                                            TN["referralAsk"]: "Ask"})],
      "refs": [rec("recRfixture000001", {R["org"]: "Fixture district housing team", R["area"]: "West Suffolk",
                                         R["email"]: "team@fixture-council.example", R["status"]: "Active", R["confidence"]: "High"}),
               rec("recRfixture000002", {R["org"]: "Fixture drop-in", R["area"]: "Haverhill",
                                         R["email"]: "hub@fixture-charity.example", R["status"]: "Active"})],
      "leads": [rec("recLfixture000001", {L["name"]: "Old Fixture", L["stage"]: "Past applicant", L["dob"]: "1975-05-05",
                                          L["email"]: "old@fixture.example", L["legacyRef"]: "tenant-app:2019-04-04 10:00:00",
                                          L["areas"]: ["Haverhill"]})],
      "optouts": [], "tasks": [], "docs": [], "linkLive": True,
    }
    if not ready:           # the same houses on a day with no room vacant and ready
        for u in w["units"]:
            if u["id"] in ("recU2fixture00002", "recU6fixture00006", "recU8fixture00008", "recU9fixture00009"):
                u["fields"][U["status"]] = "Occupied"
    return w

class FakeWriter(tl.Writer):
    def __init__(self):
        super().__init__(True); self.cards, self.roy = [], []
    def patch(self, table, rows, what): pass
    def raise_card(self, card): self.cards.append(card); return "recCARD%d" % len(self.cards)
    def to_roy(self, task): self.roy.append(task); return "recROY%d" % len(self.roy)
    def seen_replies(self): return set()
    def mark_replies_seen(self, ids): pass
    def roy_state(self): return {"read": {}, "unclear": {}}
    def save_roy_state(self, state): pass

def body(card): return card["output"].split("---", 1)[1].split("Kind regards")[0].strip()

scenario = json.loads(sys.stdin.read())
out = {}
exec(scenario["code"])
print("RESULT " + json.dumps(out, default=str))
`;

function py(code) {
  const stdout = execFileSync('python3', ['-c', HARNESS], { input: JSON.stringify({ code }), encoding: 'utf8' });
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`the harness printed no RESULT line:\n${stdout}`);
  return JSON.parse(line.slice(7));
}

describe('the number of free rooms counts only rooms vacant and ready today', () => {
  it('rooms_line counts the two Voids, the Rent Ready room and nothing in works, a room move, a notice or a move-in', () => {
    const r = py(`
o = tl.openings(world(), DAY)
out["line"] = list(tl.rooms_line(o))
`);
    // Ready: Unit 2 (Void), Unit 6 (Rent Ready), Unit 8 and Unit 9 (Void). The old count added the
    // room in works, the 2-room move, the notice and the three Voids that are not free: 11.
    expect(r.line).toEqual([4, ['Fennick Way', 'Larkspur Row'], 'free now']);
  });

  it('each opening says whether it is ready and, when not, why, with its Rental Units status', () => {
    const r = py(`
o = tl.openings(world(), DAY)
out["ready"] = {x["key"]: x.get("ready") for x in o}
out["why"] = {x["key"]: x.get("why") for x in o}
out["unit"] = {x["key"]: x.get("unit") for x in o}
`);
    expect(r.ready).toEqual({
      'unit:recU2fixture00002': true, 'unit:recU3fixture00003': false, 'unit:recU4fixture00004': false,
      'unit:recU5fixture00005': false, 'unit:recU6fixture00006': true, 'unit:recU7fixture00007': false,
      'unit:recU8fixture00008': true, 'unit:recU9fixture00009': true, 'tenancy:recTAfixture0000A': false,
      'lever:recGfixture000001': false,
    });
    expect(r.why['unit:recU3fixture00003']).toBe('Unit Status Not Ready: works not finished');
    expect(r.why['unit:recU4fixture00004']).toBe(
      'Unit Status Void, kept for a tenant moving in: Move Dana Fixture from 7 Larkspur Row Unit 1 to 12 Quillon Close Unit 4');
    expect(r.why['unit:recU5fixture00005']).toBe('Unit Status Void, but tenancy recT5fixture00005 is still live on it');
    expect(r.why['unit:recU7fixture00007']).toMatch(/^Unit Status Void, kept for a tenant moving in: Swap rooms: move Eli Fixture$/);
    expect(r.why['tenancy:recTAfixture0000A']).toBe('Unit Status Occupied, the tenant there leaves 26 Nov 2026');
    expect(r.why['lever:recGfixture000001']).toMatch(/Growth Plan room move \(Room release, Adopted\)/);
    expect(r.unit['unit:recU6fixture00006']).toBe('Unit 6 – 3 Fennick Way');
  });

  it('never holds a vacant room on a move OUT of it, a question that names it, a closed move, a removal or Unit 20 for Unit 2', () => {
    const r = py(`
o = {x["key"]: x for x in tl.openings(world(), DAY)}
out = {k: o[k].get("ready") for k in ("unit:recU2fixture00002", "unit:recU6fixture00006",
                                       "unit:recU8fixture00008", "unit:recU9fixture00009")}
`);
    expect(r).toEqual({
      'unit:recU2fixture00002': true, 'unit:recU6fixture00006': true,
      'unit:recU8fixture00008': true, 'unit:recU9fixture00009': true,
    });
  });
});

describe('the referrer mail-out', () => {
  it('names only the ready rooms, and the card lists every room with its status, counted or not', () => {
    const r = py(`
w = world()
cards = tl.mailout_cards(w, tl.by_town(tl.openings(w, DAY)), DAY)
out["names"] = [c["name"] for c in cards]
out["body"] = body(cards[0])
out["desc"] = cards[0]["description"]
out["plain"] = cards[0]["plainTask"]
`);
    expect(r.names).toEqual(['TENANT MAILOUT: Haverhill rooms 16 Nov 2026']);
    expect(r.body).toMatch(/^- Haverhill: 4 rooms free now, in shared houses on Fennick Way, Larkspur Row\.$/m);
    expect(r.body).not.toMatch(/Quillon/);
    expect(r.plain).toMatch(/we have 4 rooms free/);
    expect(r.desc).toMatch(/Rooms counted as free, vacant and ready today \(read from Rental Units\): 4\n/);
    expect(r.desc).toMatch(/- Unit 2 – 7 Larkspur Row \(Unit Status Void, no live tenancy, no move into it\)/);
    expect(r.desc).toMatch(/- Unit 6 – 3 Fennick Way \(Unit Status Rent Ready, no live tenancy, no move into it\)/);
    expect(r.desc).toMatch(/Not counted, so never in the email:/);
    expect(r.desc).toMatch(/- Unit 4 – 12 Quillon Close \(Unit Status Void, kept for a tenant moving in: Move Dana Fixture/);
    expect(r.desc).toMatch(/- Unit 3 – 7 Larkspur Row \(Unit Status Not Ready: works not finished\)/);
    expect(r.desc).not.toMatch(/Ostrey/);
  });

  it('with no room ready, it is the register-now email: no number, and only every 28 days', () => {
    const r = py(`
w = world(ready=False)
w["refs"][0]["fields"][R["lastEmailed"]] = iso(DAY - timedelta(days=20))   # 20 days ago: not due on 28
cards = tl.mailout_cards(w, tl.by_town(tl.openings(w, DAY)), DAY)
out["names"] = [c["name"] for c in cards]
out["to"] = [c["emails"] for c in cards]
out["body"] = body(cards[0])
out["plain"] = cards[0]["plainTask"]
out["desc"] = cards[0]["description"]
`);
    expect(r.names).toEqual(['TENANT MAILOUT: Haverhill register now 16 Nov 2026']);
    expect(r.to).toEqual([['hub@fixture-charity.example']]);
    expect(r.body).toMatch(/register now/);
    expect(r.body).not.toMatch(/\d+ rooms?\b/);
    expect(r.plain).toMatch(/No room is free today, so the email gives no number/);
    expect(r.desc).toMatch(/vacant and ready today \(read from Rental Units\): 0\n/);
  });

  it('the register-now card clears every real submit gate', () => {
    const r = py(`
spec2 = importlib.util.spec_from_file_location("ad", os.path.join(${JSON.stringify(SCRIPTS)}, "agent-dispatch.py"))
ad = importlib.util.module_from_spec(spec2); spec2.loader.exec_module(ad)
from agent_email_format import validate_submission_any
w = world(ready=False)
c = tl.mailout_cards(w, tl.by_town(tl.openings(w, DAY)), DAY)[0]
parsed = validate_submission_any(c["output"])
out["name"] = c["name"]
out["toEach"] = parsed["toEach"]
out["gates"] = [ad.carry_out_problem(c["output"]), ad.track_record_problem(c["output"], True),
                ad.plain_summary_problem(c["plainTask"], c["plainApprove"]),
                ad.handback_problem(c["output"], "Correspondence") or "",
                ad.tier_match(ad.TIER1_PATTERNS, c["name"], c["description"], c["output"]) or ""]
`);
    expect(r.name).toMatch(/register now/);
    expect(r.toEach.sort()).toEqual(['hub@fixture-charity.example', 'team@fixture-council.example']);
    expect(r.gates).toEqual(['', '', '', '', '']);
  });
});

describe('past applicants, the referral bonus and the adverts wait for a ready room', () => {
  it('with no room ready, no past-applicant or referral email is drafted, by the card or by the daily run', () => {
    const r = py(`
w = world(ready=False)
towns = tl.by_town(tl.openings(w, DAY))
out["pastCard"] = tl.pastmail_card(w, "Haverhill", towns["Haverhill"], DAY)
out["refCard"] = tl.referral_card(w, "Haverhill", towns["Haverhill"], DAY)
fw = FakeWriter()
tl.run(w, DAY, fw, only="past-mail", replies=lambda: [])
tl.run(w, DAY, fw, only="referral", replies=lambda: [])
out["raised"] = [c["kind"] for c in fw.cards]
out["roy"] = [t["kind"] for t in fw.roy]
`);
    expect(r.pastCard).toBeNull();
    expect(r.refCard).toBeNull();
    expect(r.raised).toEqual([]);
    expect(r.roy).toEqual([]);
  });

  it('with rooms ready, both go out and say the ready number only', () => {
    const r = py(`
w = world()
fw = FakeWriter()
tl.run(w, DAY, fw, only="past-mail", replies=lambda: [])
tl.run(w, DAY, fw, only="referral", replies=lambda: [])
out = {c["kind"]: body(c) for c in fw.cards}
`);
    expect(r.pastmail).toMatch(/We have 4 rooms free now in Haverhill, in shared houses on Fennick Way and Larkspur Row,/);
    expect(r.referral).toMatch(/^Hello,\n\nWe have 4 rooms free in Haverhill\./);
  });

  it('advert copy is only made for ready rooms, and lists only those', () => {
    const r = py(`
w = world(); o = tl.by_town(tl.openings(w, DAY))["Haverhill"]
t = tl.adverts_task("Haverhill", o, DAY)
out["fill"] = t["description"].split("\\n")[0]
w0 = world(ready=False)
out["none"] = tl.adverts_task("Haverhill", tl.by_town(tl.openings(w0, DAY))["Haverhill"], DAY)
`);
    expect(r.fill).toBe('Rooms to fill: 3 Fennick Way: a room free now; 3 Fennick Way: a room free now; '
      + '3 Fennick Way: a room free now; 7 Larkspur Row: a room free now.');
    expect(r.none).toBeNull();
  });
});

describe('the monitor', () => {
  it('does not demand adverts for rooms that are not ready, and says what it left out', () => {
    const r = py(`
w = world(ready=False)
m = {x["key"]: x for x in tl.monitor(w, DAY, tl.openings(w, DAY), [])["steps"]}
out["adverts"] = m["adverts"]["state"]
out["openings"] = m["openings"]["note"]
w1 = world()
m1 = {x["key"]: x for x in tl.monitor(w1, DAY, tl.openings(w1, DAY), [])["steps"]}
out["advertsReady"] = m1["adverts"]["state"]
`);
    expect(r.adverts).toBe('idle');
    expect(r.openings).toMatch(/^0 room\(s\) free to tell people about\. Not counted in any email: /);
    expect(r.openings).toMatch(/12 Quillon Close: a room kept for a move, not free/);
    expect(r.advertsReady).toBe('fail');
  });

  it('keeps watching the home town\'s register-now mail-out on a day with no room ready (review of PR 951)', () => {
    // The register-now mail-out goes to the home towns every 28 days whatever the room count. The first
    // version watched only towns with a ready room, so on a day with none (16 Nov 2026) nothing was
    // watched and a stopped mail-out read as fine.
    const r = py(`
w = world(ready=False)
def mail(w):
    m = {x["key"]: x for x in tl.monitor(w, DAY, tl.openings(w, DAY), [])["steps"]}
    return [m["mailout"]["state"], m["mailout"]["note"]]
out["never"] = mail(w)                        # no referrer near Haverhill has ever been emailed
for r_ in w["refs"]: r_["fields"][R["lastEmailed"]] = iso(DAY - timedelta(days=20))
out["twenty"] = mail(w)                       # 20 days ago: inside the 28-day register-now clock
for r_ in w["refs"]: r_["fields"][R["lastEmailed"]] = iso(DAY - timedelta(days=40))
out["forty"] = mail(w)                        # 40 days ago: the register-now mail-out has stopped
`);
    expect(r.never[0]).toBe('fail');
    expect(r.never[1]).toMatch(/Haverhill: no referrer near it emailed in 30 days/);
    expect(r.twenty[0]).not.toBe('fail');
    expect(r.forty[0]).toBe('fail');
    expect(r.forty[1]).toMatch(/Haverhill: no referrer near it emailed in 30 days/);
  });
});

// Review of PR 951 (16 Nov 2026), F9: move_hold held rooms it should not and missed moves written other ways.
// A false hold makes the count too LOW (a free room goes untold); a miss makes it too HIGH, the direction Kevin
// corrected four times. Back-tested read-only on 16 Nov 2026: the two rooms held today are the same on the old
// and new code, and none of the 159 move, relocate, transfer or swap tasks on the board (any status, each
// treated as open) holds a different in-scope room.
describe('a room kept for a move: what holds it and what does not (review of PR 951, F9)', () => {
  const held = (tasks) => py(`
w = world()
tasks = ${JSON.stringify(tasks)}
w["moves"] = [mtask("recMreview%07d" % i, t[0], desc=t[1] if len(t) > 1 else "") for i, t in enumerate(tasks)]
names = {u["id"]: u["fields"][U["name"]] for u in w["units"]}
props = {"recPLARK": "7 Larkspur Row", "recPQUIL": "12 Quillon Close", "recPFENN": "3 Fennick Way"}
out["held"] = sorted(names[u["id"]] for u in w["units"]
                     if u["fields"][U["property"]][0] in props
                     and tl.move_hold(w, u["id"], names[u["id"]], props[u["fields"][U["property"]][0]]))
`).held;

  it('never holds the room a tenant moved OUT of when the description names it by record id', () => {
    expect(held([['Move Sam Fixture from 3 Fennick Way Unit 8 to 12 Quillon Close Unit 4',
      'Old unit recU8fixture00008. New unit recU4fixture00004.']])).toEqual(['Unit 4 – 12 Quillon Close']);
    expect(held([['Swap rooms: move Sam Fixture', 'Moved out of recU8fixture00008 into recU6fixture00006.']]))
      .toEqual(['Unit 6 – 3 Fennick Way']);
    // Control: a record id with nothing saying it is the room being left still holds it, as on the live board.
    expect(held([['Swap rooms: move Eli Fixture', 'New unit recU7fixture00007 for Eli.']])).toEqual(['Unit 7 – 3 Fennick Way']);
  });

  it('never holds a room for furniture or money; control: the tenant moving there holds it', () => {
    expect(held([['MAINTENANCE: move the spare wardrobe to Unit 4 - 12 Quillon Close']])).toEqual([]);
    expect(held([['Transfer £500 to the account for 12 Quillon Close Unit 4']])).toEqual([]);
    expect(held([['Move the tenant from Unit 8 to Unit 4 - 12 Quillon Close']])).toEqual(['Unit 4 – 12 Quillon Close']);
  });

  it('holds a move written with "at", the street\'s name alone, or "transfers" in a room swap', () => {
    expect(held([['Move Dana Fixture from Unit 1 to Unit 4 at 12 Quillon Close']])).toEqual(['Unit 4 – 12 Quillon Close']);
    expect(held([['Dana Fixture moving to Quillon Unit 4 next week']])).toEqual(['Unit 4 – 12 Quillon Close']);
    expect(held([['Room swap: Dana Fixture transfers from 7 Larkspur Row Unit 1 to 12 Quillon Close Unit 4']]))
      .toEqual(['Unit 4 – 12 Quillon Close']);
    // Controls: Unit 20 is not Unit 2, and another house's Unit 4 is not this one.
    expect(held([['Move Kit Fixture to Larkspur Unit 20']])).toEqual([]);
    expect(held([['Move Kit Fixture to Fennick Unit 4']])).toEqual([]);
  });

  it('the read fetches every task name the matcher accepts', () => {
    const r = py(`
seen = {}
class Stop(Exception):
    pass
def fake_fetch(table, params=None):
    seen[len(seen)] = dict(params or {})
    return [rec("recFILL%010d" % i, {}) for i in range(200)]
tl.fetch_all = fake_fetch
def stop(*a, **k):
    raise Stop()
tl.sent_threads = stop
try:
    tl.load(DAY)
except Stop:
    pass
formula = next(p["filterByFormula"] for p in seen.values() if "mov" in str(p.get("filterByFormula", "")))
import re
words = re.findall(r"FIND\\('([a-z]+)', LOWER\\(\\{Task Name\\}\\)\\)", formula)
names = ["Move X to 12 Quillon Close Unit 4", "Relocate X to 12 Quillon Close Unit 4",
         "Room swap: X transfers to 12 Quillon Close Unit 4", "Swap rooms with Y", "X moving into Quillon Unit 4"]
out["accepted"] = [n for n in names if tl.is_move_task(n)]
out["missed"] = [n for n in out["accepted"] if not any(w in n.lower() for w in words)]
`);
    expect(r.accepted.length).toBe(5);
    expect(r.missed).toEqual([]);
  });
});
