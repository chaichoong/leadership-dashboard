// The proof of residency step (Kevin, 8 Oct 2026): only we sign a new tenant's proof of residency, so Adobe sends the
// signed copy to info@ alone. scripts/rent_proof_of_residency.py, run by the daily rent check, sends it from info@ to
// the tenant and Roy, finding the tenant's address in Adobe's own "sent out for signature" emails for the same pack,
// and holds it for Kevin when that address is unclear. These drive the REAL module with the mailboxes, the send and
// Airtable stubbed: nothing reaches any of them. Every name, address and id is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'scripts');

const HARNESS = `
import json, sys, os, tempfile
from datetime import datetime, timedelta, timezone, date
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import rent_proof_of_residency as por
NOW = datetime(2026, 10, 20, 9, 0, tzinfo=timezone.utc)
ROY = "roy.example@example.com"
DOC = "Proof_of_Residency_Ann_Lee"
AST = "AST_Ann_Lee_9_Example_Street"
AUTH = "Authority_Ann_Lee_9_Example_Street"
PDF = b"%PDF-1.7 signed proof of residency"
ADOBE = "Adobe Acrobat Sign <adobesign@adobesign.com>"
def ms(hours_ago): return str(int((NOW - timedelta(hours=hours_ago)).timestamp() * 1000))
def signed(i, hours_ago, doc=DOC, pdf=True):
    att = [{"attachmentId": "att" + i, "filename": doc + " - signed.pdf", "mimeType": "application/pdf"}] if pdf else []
    return {"id": i, "threadId": i, "internalDate": ms(hours_ago), "attachments": att,
            "headers": {"from": ADOBE, "subject": doc + " between Roy Lavin and Roy Lavin is Signed and Filed!"}}
def other_signed(i="mOTHER", hours_ago=400):
    return {"id": i, "internalDate": ms(hours_ago), "attachments": [],
            "headers": {"from": ADOBE, "subject": "some-creditor-loa between Agile Lets and Someone is Signed and Filed!"}}
N = [0]
def sent_out(doc, to, hours_ago=30, sender=ADOBE):
    N[0] += 1
    return {"id": "o%d" % N[0], "internalDate": ms(hours_ago),
            "headers": {"from": sender, "subject": doc + " has been sent out for signature to " + to}}
def pack(to, hours_ago=30, doc=DOC, ast=AST):
    """A pack as Adobe emails it: the proof of residency out to Agile Lets, the agreement out to the tenant."""
    return [sent_out(doc, "Agile Lets", hours_ago + 0.05), sent_out(ast, to, hours_ago)]
def forward(doc, hours_ago, prefix="Fwd: "):
    return {"id": "f" + str(hours_ago), "internalDate": ms(hours_ago),
            "headers": {"subject": prefix + doc + " between Roy Lavin and Roy Lavin is Signed and Filed!"}}
class AD:
    ROY_EMAIL = ROY
    KEVIN_AIRTABLE_EMAIL = "kevin.example@example.com"
    HUMANS = {"kevin.example@example.com": {"rec": "recKEVINMEMBER001"}}
    AF = {"assignee": "fldASSIGNEE00001"}
class LB:
    def module(self, key): return AD
class RC:
    T_TASKS = "tblTASKS"
    TK = {"name": "fN", "status": "fS", "due": "fD", "teamMember": "fT", "description": "fDe", "notes": "fNo"}
    lane_b_rules = LB()
    def __init__(self, tasks=None, post_fails_for=None):
        self.tasks = tasks or {}
        self.calls = []
        self.post_fails_for = post_fails_for
    def sel(self, v): return v.get("name") if isinstance(v, dict) else v
    def fetch_all(self, table, params=None):
        self.calls.append(["LIST", table, (params or {}).get("filterByFormula")])
        return [{"id": k, "fields": dict(v)} for k, v in self.tasks.items()]
    def api(self, method, p, payload=None, params=None):
        self.calls.append([method, p])
        if method == "POST":
            f = dict(payload["records"][0]["fields"])
            if self.post_fails_for and self.post_fails_for in f["fN"]:
                raise RuntimeError("Airtable POST tasks 422: nope")
            new = "recHOLD" + str(len(self.tasks)).zfill(10)
            self.tasks[new] = f
            return {"records": [{"id": new}]}
        if method == "GET":
            tid = p.split("/")[-1]
            f = self.tasks[tid]
            return {"id": tid, "fields": dict(f) if (params or {}).get("returnFieldsByFieldId") == "true" else {"Notes": f.get("fNo")}}
        if method == "PATCH":
            r = payload["records"][0]
            self.tasks[r["id"]].update(r["fields"])
        return {}
import re as _re
def mailboxes(signed_list, sent_info=(), sent_kevin=(), sent_out_list=(), cut=None, now=None):
    """The mailboxes as Gmail answers them: a query's newer_than window is applied, so a read that is too short
    misses what it misses."""
    asked = []
    def list_mail(q, account):
        asked.append([q, account])
        if q.startswith("in:sent"):
            got = list(sent_info) if account == por.INBOX else list(sent_kevin)
        elif "sent out for signature" in q:
            got = list(sent_out_list)
        else:
            got = list(signed_list)
        w = _re.search(r"newer_than:(\\d+)d", q)
        if w:
            floor = ((now or NOW) - timedelta(days=int(w.group(1)))).timestamp() * 1000
            got = [m for m in got if int(m.get("internalDate") or 0) >= floor]
        return got, (cut is not None and cut in q)
    return list_mail, asked
def sender(answer=None):
    sent = []
    def send(payload):
        sent.append(payload)
        return answer if answer is not None else ({"id": "gSENT" + str(len(sent))}, None)
    return send, sent
FETCHED = []
def fetch(mail_id, attachment_id, account):
    assert account == por.INBOX, account
    FETCHED.append(mail_id)
    return PDF
def ledger(): return os.path.join(tempfile.mkdtemp(), "proof-of-residency.jsonl")
def rows(p):
    try:
        return [json.loads(l) for l in open(p) if l.strip()]
    except FileNotFoundError:
        return []
def key(hours_ago, doc=DOC):
    """A hold task's key: the document and the London day its pack first went into Adobe."""
    return doc.lower() + ":" + (NOW - timedelta(hours=hours_ago)).astimezone(por.LONDON).date().isoformat()
`;
function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('the proof of residency goes from info@ to the tenant and Roy, once', () => {
  it('one address in the pack\'s own emails: sent from info@ to the tenant and Roy with the signed PDF, never twice', () => {
    const r = py(`
lm, asked = mailboxes([signed("m1", 20), other_signed()],
                      sent_out_list=pack("ann.lee@example.com and Agile Lets") + [sent_out(AUTH, "Agile Lets and Ann.Lee@example.com")])
send, sent = sender()
p = ledger()
rc = RC()
first = por.run(rc, NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=p)
again = por.run(rc, NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=p)
import base64
print(json.dumps({"first": first, "again": again, "sent": [{k: v for k, v in s.items() if k != "attachment"} for s in sent],
                  "attachment": {"filename": sent[0]["attachment"]["filename"], "mime": sent[0]["attachment"]["mimeType"],
                                 "bytes": base64.b64decode(sent[0]["attachment"]["dataB64"]).decode()},
                  "events": [x["event"] for x in rows(p)], "line": por.line(first), "brief": por.brief(first),
                  "tasks": len(rc.tasks)}))`);
    expect(r.sent).toEqual([{
      to: 'ann.lee@example.com, roy.example@example.com', from: 'info@agilelets.co.uk',
      subject: 'Fwd: Proof_of_Residency_Ann_Lee between Roy Lavin and Roy Lavin is Signed and Filed!',
      text: 'Hello,\n\nPlease find attached your signed proof of residency. Upload the document to your Universal Credit '
        + 'journal along with your tenancy agreement.\n\nKind regards,\nRoy Lavin\nAgile Lets',
    }]);
    expect(r.attachment).toEqual({ filename: 'Proof_of_Residency_Ann_Lee - signed.pdf', mime: 'application/pdf',
      bytes: '%PDF-1.7 signed proof of residency' });
    expect(r.first.sent).toEqual(['Ann Lee to ann.lee@example.com, roy.example@example.com']);
    expect(r.first.failed).toBe('');
    expect(r.again.sent).toEqual([]);
    expect(r.events).toEqual(['intent', 'sent']);       // the intent row is written BEFORE the send
    expect(r.line).toBe('Proof of residency: sent from info@: Ann Lee to ann.lee@example.com, roy.example@example.com.');
    expect(r.brief).toBe('');
    expect(r.tasks).toBe(0);
  });

  it('two signed copies of one document are ONE send, in one run and the next, with the newest copy\'s PDF', () => {
    const r = py(`
lm, _ = mailboxes([signed("mFIRST", 50), signed("mSECOND", 10)], sent_out_list=pack("ann.lee@example.com", hours_ago=52))
send, sent = sender()
p = ledger()
FETCHED.clear()
first = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=p)
again = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=p)
# A forward of the first copy covers the second too.
lm2, _ = mailboxes([signed("mFIRST", 50), signed("mSECOND", 10)], sent_kevin=[forward(DOC, 49)],
                   sent_out_list=pack("ann.lee@example.com", hours_ago=52))
send2, sent2 = sender()
fwd = por.run(RC(), NOW, True, True, list_mail=lm2, fetch=fetch, send=send2, ledger=ledger())
print(json.dumps({"n": len(sent), "fetched": FETCHED, "checked": first["checked"], "again": again["sent"],
                  "afterForward": len(sent2), "fwdChecked": fwd["checked"]}))`);
    expect(r.n).toBe(1);
    expect(r.fetched).toEqual(['mSECOND']);
    expect(r.checked).toBe(1);
    expect(r.again).toEqual([]);
    expect(r.afterForward).toBe(0);
    expect(r.fwdChecked).toBe(1);
  });

  it('forwarded by hand (in either Sent) is never sent again, and a hold task for it closes itself', () => {
    const r = py(`
out = {}
for where in ("info", "kevin"):
    fw = [forward(DOC, 5)]
    lm, asked = mailboxes([signed("m1", 80)], sent_info=fw if where == "info" else [],
                          sent_kevin=fw if where == "kevin" else [], sent_out_list=pack("ann.lee@example.com", 82))
    send, sent = sender()
    rc = RC({"recHOLDTASK000001": {"fS": "Today", "fNo": por.KEY_MARK + key(82.05)}})
    res = por.run(rc, NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
    out[where] = {"sent": len(sent), "closed": res["closed"], "status": rc.tasks["recHOLDTASK000001"]["fS"],
                  "noted": "CLOSED:" in rc.tasks["recHOLDTASK000001"]["fNo"], "failed": res["failed"],
                  "accounts": sorted({a for q, a in asked if q.startswith("in:sent")})}
print(json.dumps(out))`);
    for (const where of ['info', 'kevin']) {
      expect(r[where]).toEqual({ sent: 0, closed: ['recHOLDTASK000001'], status: 'Completed', noted: true, failed: '',
        accounts: ['info@agilelets.co.uk', 'kevin@runpreneur.org.uk'] });
    }
  });

  it('only a forward counts: a "Re:" naming the document, or a forward of an earlier pack of the same name, never covers it', () => {
    const r = py(`
lm, _ = mailboxes([signed("m1", 10)], sent_kevin=[forward(DOC, 5, prefix="Re: "), forward(DOC, 24 * 12)],
                  sent_out_list=pack("ann.lee@example.com"))
send, sent = sender()
por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
print(json.dumps({"n": len(sent)}))`);
    expect(r.n).toBe(1);
  });

  it('the address comes from THIS pack only: another person\'s pack outside the window is never used', () => {
    const r = py(`
out = {}
# Ann Lee's own agreement has not gone out yet. An older pack for a different Ann Lee, and a pack for Ann Lee Smith,
# both went into Adobe weeks before: neither is this pack.
older = [sent_out("AST_Ann_Lee_77_Far_Road", "other.ann@example.com", 24 * 40), sent_out(DOC, "Agile Lets", 24 * 40 + 0.05),
         sent_out("AST_Ann_Lee_Smith_4_Other_Road", "als@example.com", 24 * 20)]
lm, _ = mailboxes([signed("m1", 3)], sent_out_list=older + [sent_out(DOC, "Agile Lets", 5)])
send, sent = sender()
early = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
out["early"] = {"n": len(sent), "waiting": early["waiting"]}
# Ann Lee Smith's pack went in the same week: her name is longer, so her pack is never Ann Lee's.
lm, _ = mailboxes([signed("m1", 3)], sent_out_list=pack("ann.lee@example.com", 6) + [sent_out("AST_Ann_Lee_Smith_4_Other_Road", "als@example.com", 20)])
send, sent = sender()
same = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
out["sameWeek"] = [s["to"] for s in sent]
# ... and while Ann Lee's own agreement names only Agile Lets, Ann Lee Smith's address is still never used.
lm, _ = mailboxes([signed("m1", 3)], sent_out_list=pack("Agile Lets", 6) + [sent_out("AST_Ann_Lee_Smith_4_Other_Road", "als@example.com", 20)])
send, sent = sender()
only = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
out["onlyOther"] = {"n": len(sent), "waiting": only["waiting"]}
# A second pack with exactly the same name went into Adobe after Ann Lee's and before info@ signed: both packs are
# read, two addresses, held.
lm, _ = mailboxes([signed("m1", 3)], sent_out_list=pack("ann.lee@example.com", 48) + pack("other.ann@example.com", 10, ast="AST_Ann_Lee_77_Far_Road"))
send, sent = sender()
twin = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
out["twinName"] = {"n": len(sent), "held": twin["held"]}
out["tenantDoc"] = [por.tenant_doc(d, "Ann_Lee") for d in ("AST_Ann_Lee", "AST_Ann_Lee_9_Example_Street",
                    "Authority_Ann_Lee_9_Example_Street", "AST_Ann_Lee_Smith_4_Other_Road", "AST_Ann_Lee_Smith",
                    "AST_Joint_9_Example_Street", "Proof_of_Residency_Ann_Lee")]
# No "sent out" email for this proof of residency at all: there is no pack to read, so after two days Kevin is asked.
lm, _ = mailboxes([signed("m1", 60)], sent_out_list=[sent_out(AST, "ann.lee@example.com", 61)])
send, sent = sender()
lost = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
out["noAnchor"] = {"n": len(sent), "held": lost["held"]}
out["exact"] = [por.names_doc("Fwd: Proof_of_Residency_Ann_Lee_Smith between", DOC),
                por.names_doc("Fwd: Proof_of_Residency_Ann_Lee between", DOC),
                por.names_doc("Proof_of_Residency_Ann_Lee - signed.pdf", DOC)]
print(json.dumps(out))`);
    expect(r.early).toEqual({ n: 0, waiting: ['Ann Lee'] });
    expect(r.sameWeek).toEqual(['ann.lee@example.com, roy.example@example.com']);
    expect(r.onlyOther).toEqual({ n: 0, waiting: ['Ann Lee'] });
    expect(r.twinName.n).toBe(0);
    expect(r.twinName.held[0]).toContain('ann.lee@example.com, other.ann@example.com');
    expect(r.tenantDoc).toEqual([true, true, true, false, false, false, false]);
    expect(r.noAnchor.n).toBe(0);
    expect(r.noAnchor.held[0]).toContain("Adobe's own email sending this proof of residency out was not found");
    expect(r.exact).toEqual([false, true, true]);
  });

  it('a pack is read whole: a copy of a pack already sent stays covered while its first copy is past 60 days', () => {
    const r = py(`
# Copy A (70 days ago) went by this lane; copy B of the same pack (58 days ago, a retried send 6 days later) is new
# enough to act on. A must still be in the read, or B would look like a pack of its own and go again.
p = ledger()
por.ledger_append(p, {"doc": DOC, "mail": "mA", "ts": (NOW - timedelta(hours=24 * 70 - 1)).strftime("%Y-%m-%dT%H:%M:%SZ"), "event": "sent"})
lm, asked = mailboxes([signed("mA", 24 * 70), signed("mB", 24 * 58)],
                      sent_out_list=pack("ann.lee@example.com", 24 * 70 + 2) + [sent_out(DOC, "Agile Lets", 24 * 64)])
send, sent = sender()
res = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=p, start=date(2026, 7, 1))
print(json.dumps({"n": len(sent), "checked": res["checked"], "line": por.line(res), "read": asked[0][0]}))`);
    expect(r.n).toBe(0);
    expect(r.checked).toBe(1);
    expect(r.line).toContain('every one sent');
    expect(r.read).toBe('from:adobesign@adobesign.com subject:"Signed and Filed" newer_than:76d');
  });

  it('a pack begun before 8 Oct 2026 is still never sent once its first copy is past 60 days', () => {
    const r = py(`
LATER = datetime(2026, 12, 6, 9, 0, tzinfo=timezone.utc)
def at(when, i): return dict(signed(i, 0), internalDate=str(int(when.timestamp() * 1000)))
a = at(datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc), "mA")
b = at(datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc), "mB")
outs = [dict(sent_out(DOC, "Agile Lets"), internalDate=str(int(datetime(2026, 10, 6, 11, 0, tzinfo=timezone.utc).timestamp() * 1000))),
        dict(sent_out(AST, "ann.lee@example.com"), internalDate=str(int(datetime(2026, 10, 6, 11, 0, tzinfo=timezone.utc).timestamp() * 1000))),
        dict(sent_out(DOC, "Agile Lets"), internalDate=str(int(datetime(2026, 10, 9, 11, 0, tzinfo=timezone.utc).timestamp() * 1000)))]
lm, _ = mailboxes([a, b], sent_out_list=outs, now=LATER)
send, sent = sender()
res = por.run(RC(), LATER, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
print(json.dumps({"n": len(sent), "checked": res["checked"]}))`);
    expect(r).toEqual({ n: 0, checked: 0 });
  });

  it('a held pack keeps one task while its first copy ages past 60 days', () => {
    const r = py(`
# No "sent out" email of its own (so held), two copies 3 days apart, and Kevin's task still open.
lm, _ = mailboxes([signed("mA", 24 * 62), signed("mB", 24 * 59)])
rc = RC({"recHOLDTASK000001": {"fS": "Today", "fNo": por.KEY_MARK + key(24 * 62)}})
res = por.run(rc, NOW, True, True, list_mail=lm, fetch=fetch, send=sender()[0], ledger=ledger(), start=date(2026, 7, 1))
print(json.dumps({"raised": res["raised"], "held": len(res["held"]), "n": len(rc.tasks)}))`);
    expect(r).toEqual({ raised: [], held: 1, n: 1 });
  });

  it('a pack that began before 8 Oct 2026 is never sent, even by a copy that came after it', () => {
    const r = py(`
# Copy A on 7 Oct, forwarded by hand that day; copy B of the same pack on 8 Oct.
lm, _ = mailboxes([signed("mA", 24 * 13), signed("mB", 24 * 12 - 2)], sent_kevin=[forward(DOC, 24 * 13 - 1)],
                  sent_out_list=pack("ann.lee@example.com", 24 * 13 + 1))
send, sent = sender()
res = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
print(json.dumps({"n": len(sent), "checked": res["checked"]}))`);
    expect(r).toEqual({ n: 0, checked: 0 });
  });

  it('a new pack for the same name more than a week later is a new document, and is sent', () => {
    const r = py(`
out = {}
p = ledger()
por.ledger_append(p, {"doc": DOC, "mail": "mOLD", "ts": (NOW - timedelta(hours=24 * 11)).strftime("%Y-%m-%dT%H:%M:%SZ"), "event": "sent"})
lm, _ = mailboxes([signed("mOLD", 24 * 11 + 1), signed("mNEW", 20)],
                  sent_out_list=pack("ann.lee@example.com", 24 * 11 + 3) + pack("ann.lee@example.com", 22, ast="AST_Ann_Lee_12_New_Street"))
send, sent = sender()
FETCHED.clear()
res = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=p)
out["plain"] = {"n": len(sent), "fetched": list(FETCHED), "checked": res["checked"]}
# Pack 1 went in 10 days ago and was retried (a second "sent out" and copy) 8 days ago, when this lane sent it.
# A corrected pack 2 went in yesterday: its reach-back takes in pack 1's retry, and still pack 1's send never covers it.
p = ledger()
por.ledger_append(p, {"doc": DOC, "mail": "m1b", "ts": (NOW - timedelta(hours=24 * 8 - 2)).strftime("%Y-%m-%dT%H:%M:%SZ"), "event": "sent"})
lm, _ = mailboxes([signed("m1a", 24 * 10 - 1), signed("m1b", 24 * 8 - 1), signed("m2", 20)],
                  sent_out_list=pack("ann.lee@example.com", 24 * 10) + [sent_out(DOC, "Agile Lets", 24 * 8)]
                                + pack("ann.lee@example.com", 24, ast="AST_Ann_Lee_12_New_Street"))
send, sent = sender()
FETCHED.clear()
res = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=p)
out["retried"] = {"n": len(sent), "fetched": list(FETCHED), "checked": res["checked"]}
print(json.dumps(out))`);
    expect(r.plain).toEqual({ n: 1, fetched: ['mNEW'], checked: 2 });
    expect(r.retried).toEqual({ n: 1, fetched: ['m2'], checked: 2 });
  });

  it('an agreement for the same name outside this pack\'s window is never this pack\'s address', () => {
    const r = py(`
# Another Ann Lee's agreement went out 12 days ago (that pack had no proof of residency). Ann Lee's own pack went in
# yesterday and her agreement still names only Agile Lets: she waits, the other address is never used.
lm, _ = mailboxes([signed("m1", 3)], sent_out_list=[sent_out("AST_Ann_Lee_77_Far_Road", "other.ann@example.com", 24 * 12)]
                                                    + pack("Agile Lets", 24))
send, sent = sender()
res = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
print(json.dumps({"n": len(sent), "waiting": res["waiting"]}))`);
    expect(r).toEqual({ n: 0, waiting: ['Ann Lee'] });
  });

  it('a pack whose newest copy is past 60 days is left alone, so a pack is never acted on in part', () => {
    const r = py(`
# Copy A (77 days ago, past the read) went by this lane; copy B of the same pack is 70 days old. Acting on B alone
# would send it again.
p = ledger()
por.ledger_append(p, {"doc": DOC, "mail": "mA", "ts": (NOW - timedelta(hours=24 * 77 - 1)).strftime("%Y-%m-%dT%H:%M:%SZ"), "event": "sent"})
lm, _ = mailboxes([signed("mA", 24 * 77), signed("mB", 24 * 70)],
                  sent_out_list=pack("ann.lee@example.com", 24 * 77 + 12) + [sent_out(DOC, "Agile Lets", 24 * 71)])
send, sent = sender()
res = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=p, start=date(2026, 7, 1))
print(json.dumps({"n": len(sent), "checked": res["checked"]}))`);
    expect(r).toEqual({ n: 0, checked: 0 });
  });

  it('a pack whose name went into Adobe earlier and was never signed is held: which person it is cannot be told', () => {
    const r = py(`
# Ann Lee's pack went in 10 days ago and was never signed; a pack for another Ann Lee went in 1 day ago; info@ signs
# a proof of residency of that name today. It may be either person's.
lm, _ = mailboxes([signed("m1", 3)], sent_out_list=pack("ann.lee@example.com", 24 * 10) + pack("other.ann@example.com", 24, ast="AST_Ann_Lee_77_Far_Road"))
send, sent = sender()
res = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
print(json.dumps({"n": len(sent), "held": res["held"]}))`);
    expect(r.n).toBe(0);
    expect(r.held[0]).toContain('never signed, so which person this is cannot be told');
  });

  it('a retried send in an earlier signed pack is accounted for: a new pack of that name is not held for it', () => {
    const r = py(`
# Pack 1 went into Adobe twice (24 and 22 days ago) and was signed once; pack 2 of the same name went in yesterday.
lm, _ = mailboxes([signed("m1", 24 * 22 - 1), signed("m2", 3)], sent_kevin=[forward(DOC, 24 * 22 - 2)],
                  sent_out_list=[sent_out(DOC, "Agile Lets", 24 * 24)] + pack("ann.lee@example.com", 24 * 22)
                                + pack("ann.lee@example.com", 24, ast="AST_Ann_Lee_12_New_Street"))
send, sent = sender()
res = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
print(json.dumps({"n": len(sent), "held": res["held"]}))`);
    expect(r).toEqual({ n: 1, held: [] });
  });

  it('a later failure is never said in an earlier failure\'s words', () => {
    const r = py(`
class FakeTriage:
    _last_fail = {"kind": "error", "message": "an OLD failure from an earlier call"}
    def worker_list(self, q=None, max_pages=None, account=None): raise SystemExit(2)
por._TRI[:] = [FakeTriage()]
res = por.run(RC(), NOW, True, True, fetch=fetch, send=sender()[0], ledger=ledger())
print(json.dumps({"failed": res["failed"]}))`);
    expect(r.failed).toBe('the proof of residency step could not run: 2');
  });

  it('two different addresses: held, one task for Kevin keyed on the document, and never a guess', () => {
    const r = py(`
lm, _ = mailboxes([signed("m1", 3)], sent_out_list=pack("ann.lee@example.com") + [sent_out(AUTH, "a.lee.two@example.com")])
send, sent = sender()
rc = RC()
first = por.run(rc, NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
again = por.run(rc, NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
t = list(rc.tasks.values())
print(json.dumps({"sent": len(sent), "raised": first["raised"], "again": again["raised"], "n": len(t),
                  "name": t[0]["fN"], "member": t[0]["fT"], "assignee": t[0]["fldASSIGNEE00001"], "notes": t[0]["fNo"],
                  "key": key(30.05), "desc": t[0]["fDe"], "brief": por.brief(first), "held": first["held"]}))`);
    expect(r.sent).toBe(0);
    expect(r.raised).toEqual(['recHOLD0000000000']);
    expect(r.again).toEqual([]);
    expect(r.n).toBe(1);
    expect(r.name).toBe('PROOF OF RESIDENCY: Proof_of_Residency_Ann_Lee, forward it to the tenant and Roy');
    expect(r.member).toEqual(['recKEVINMEMBER001']);
    expect(r.assignee).toEqual({ email: 'kevin.example@example.com' });
    expect(r.notes).toBe(`RENT CHECK KEY: residency:${r.key}`);
    expect(r.desc).toContain(`RENT CHECK KEY: residency:${r.key}`);
    expect(r.desc).toContain('a.lee.two@example.com, ann.lee@example.com');
    expect(r.desc).toContain('roy.example@example.com');
    expect(r.held[0]).toContain('more than one address');
    expect(r.brief).toBe('Proof of residency: 1 not sent to the tenant, see your task or the rent check row.');
  });

  it('a hold task whose key survives only in its Description is still found: never a twin', () => {
    const r = py(`
lm, _ = mailboxes([signed("m1", 3)], sent_out_list=pack("ann.lee@example.com") + [sent_out(AUTH, "a.lee.two@example.com")])
rc = RC({"recHOLDTASK000001": {"fS": "Today", "fNo": "edited by hand", "fDe": "...\\n" + por.KEY_MARK + key(30.05)}})
res = por.run(rc, NOW, True, True, list_mail=lm, fetch=fetch, send=sender()[0], ledger=ledger())
print(json.dumps({"raised": res["raised"], "n": len(rc.tasks), "formula": [c[2] for c in rc.calls if c[0] == "LIST"][0]}))`);
    expect(r.raised).toEqual([]);
    expect(r.n).toBe(1);
    expect(r.formula).toContain('{Description}');
  });

  it('no address yet: waits quietly, then after two days holds it for Kevin; once it goes, his task closes at once', () => {
    const r = py(`
out = {}
for hours in (20, 60):
    lm, _ = mailboxes([signed("m1", hours)], sent_out_list=[sent_out(DOC, "Agile Lets", hours + 1)])
    send, sent = sender()
    rc = RC()
    res = por.run(rc, NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
    out[str(hours)] = {"sent": len(sent), "waiting": res["waiting"], "held": res["held"], "tasks": len(rc.tasks),
                       "brief": por.brief(res)}
# The address arrives later: the send closes Kevin's open task in the same run.
lm, _ = mailboxes([signed("m1", 60)], sent_out_list=pack("ann.lee@example.com", 61))
rc = RC({"recHOLDTASK000001": {"fS": "Today", "fNo": por.KEY_MARK + key(61.05)}})
send, sent = sender()
res = por.run(rc, NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
out["later"] = {"sent": len(sent), "closed": res["closed"], "status": rc.tasks["recHOLDTASK000001"]["fS"],
                "note": rc.tasks["recHOLDTASK000001"]["fNo"].splitlines()[-1]}
print(json.dumps(out))`);
    expect(r['20']).toEqual({ sent: 0, waiting: ['Ann Lee'], held: [], tasks: 0, brief: '' });
    expect(r['60'].sent).toBe(0);
    expect(r['60'].tasks).toBe(1);
    expect(r['60'].held[0]).toContain('no tenant address');
    expect(r.later.sent).toBe(1);
    expect(r.later.closed).toEqual(['recHOLDTASK000001']);
    expect(r.later.status).toBe('Completed');
    expect(r.later.note).toContain('was sent to the tenant and Roy by the rent check');
  });

  it('our own mailboxes are never the tenant; a tenant who signs through Roy\'s address gets it through Roy alone', () => {
    const r = py(`
lm, _ = mailboxes([signed("m1", 3)], sent_out_list=pack("info@agilelets.co.uk and " + ROY) + [sent_out(AUTH, "kevinbrittain@gmail.com and Agile Lets")])
send, sent = sender()
res = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
print(json.dumps({"to": [s["to"] for s in sent], "own": [por.own(a) for a in ("info@agilelets.co.uk", "x@agilelets.co.uk",
                  "kevin@runpreneur.org.uk", "kevinbrittain@gmail.com", "kevin@operationsdirector.co.uk", ROY)]}))`);
    expect(r.to).toEqual(['roy.example@example.com']);
    expect(r.own).toEqual([true, true, true, true, true, false]);
  });

  it('an email that only looks like Adobe\'s is never a source of an address or a document', () => {
    const r = py(`
fake_signed = signed("mFAKE", 3)
fake_signed["headers"]["from"] = "someone@example.net"
lm, _ = mailboxes([fake_signed, other_signed()], sent_out_list=pack("ann.lee@example.com"))
send, sent = sender()
res = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
lm2, _ = mailboxes([signed("m1", 3)], sent_out_list=[sent_out(DOC, "Agile Lets", 5), sent_out(AST, "thief@example.net", 4, sender="x@example.net")])
send2, sent2 = sender()
res2 = por.run(RC(), NOW, True, True, list_mail=lm2, fetch=fetch, send=send2, ledger=ledger())
print(json.dumps({"fakeSigned": [len(sent), res["checked"]], "fakeAddress": [len(sent2), res2["waiting"]]}))`);
    expect(r.fakeSigned).toEqual([0, 0]);
    expect(r.fakeAddress).toEqual([0, ['Ann Lee']]);
  });

  it('only a proof of residency signed on or after 8 Oct 2026 is ever sent', () => {
    const r = py(`
old = signed("mOLD", 24 * 14)          # 6 Oct 2026
lm, asked = mailboxes([old], sent_out_list=pack("ann.lee@example.com", 24 * 14 + 2))
send, sent = sender()
res = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
print(json.dumps({"sent": len(sent), "checked": res["checked"], "reads": len(asked), "start": str(por.START),
                  "line": por.line(res)}))`);
    expect(r.start).toBe('2026-10-08');
    expect(r).toMatchObject({ sent: 0, checked: 0, reads: 1 });   // nothing new: Sent and the address emails are not read
    expect(r.line).toBe('Proof of residency: none signed and waiting.');
  });

  it('a send that may have gone is never sent twice and goes to Kevin as a task; one refused before anything left is tried again', () => {
    const r = py(`
out = {}
for answer, label in (((None, ("uncertain", "ERROR: worker call failed: timeout")), "uncertain"),
                      ((None, ("failed", "ERROR: worker 400: bad")), "failed")):
    lm, _ = mailboxes([signed("m1", 3)], sent_out_list=pack("ann.lee@example.com"))
    p = ledger()
    rc = RC()
    send, sent = sender(answer)
    first = por.run(rc, NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=p)
    send2, sent2 = sender()
    second = por.run(rc, NOW, True, True, list_mail=lm, fetch=fetch, send=send2, ledger=p)
    out[label] = {"firstFailed": first["failed"], "retried": len(sent2), "uncertain": second["uncertain"],
                  "raised": second["raised"], "brief": por.brief(second), "events": [x["event"] for x in rows(p)]}
    if label == "uncertain":
        # It had gone after all: info@'s Sent shows it, so the next run calls it sent and closes Kevin's task.
        lm3, _ = mailboxes([signed("m1", 3)], sent_info=[forward(DOC, 2)], sent_out_list=pack("ann.lee@example.com"))
        third = por.run(rc, NOW, True, True, list_mail=lm3, fetch=fetch, send=sender()[0], ledger=p)
        out["resolved"] = {"closed": third["closed"], "uncertain": third["uncertain"]}
print(json.dumps(out))`);
    expect(r.uncertain.firstFailed).toContain('Ann Lee: Proof_of_Residency_Ann_Lee was not sent (uncertain)');
    expect(r.uncertain.retried).toBe(0);
    expect(r.uncertain.uncertain[0]).toContain('never sent twice');
    expect(r.uncertain.raised).toEqual(['recHOLD0000000000']);
    expect(r.uncertain.brief).toContain('1 not sent');
    expect(r.uncertain.events).toEqual(['intent', 'uncertain']);
    expect(r.resolved).toEqual({ closed: ['recHOLD0000000000'], uncertain: [] });
    expect(r.failed.firstFailed).toContain('(failed)');
    expect(r.failed.retried).toBe(1);
    expect(r.failed.events).toEqual(['intent', 'failed', 'intent', 'sent']);
  });

  it('one document\'s failure never stops the next one going', () => {
    const r = py(`
BOB = "Proof_of_Residency_Bob_Ray"
lm, _ = mailboxes([signed("m1", 60), signed("m2", 3, doc=BOB)],
                  sent_out_list=[sent_out(DOC, "Agile Lets", 61)] + pack("bob.ray@example.com", 5, doc=BOB, ast="AST_Bob_Ray_3_Test_Lane"))
send, sent = sender()
rc = RC(post_fails_for="Ann_Lee")
res = por.run(rc, NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
print(json.dumps({"to": [s["to"] for s in sent], "failed": res["failed"]}))`);
    expect(r.to).toEqual(['bob.ray@example.com, roy.example@example.com']);
    expect(r.failed).toContain('Ann Lee: Airtable POST tasks 422: nope');
  });

  it('two runs at once: the second sends nothing while the first holds the lock', () => {
    const r = py(`
lm, _ = mailboxes([signed("m1", 3)], sent_out_list=pack("ann.lee@example.com"))
p = ledger()
held = por._lock(p)
send, sent = sender()
busy = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=p)
held.close()
free = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=p)
print(json.dumps({"busy": busy["busy"], "n": len(sent), "line": por.line(busy), "free": free["sent"]}))`);
    expect(r.busy).toBe(true);
    expect(r.line).toContain('another rent check was sending, so this run sent nothing');
    expect(r.n).toBe(1);
    expect(r.free).toEqual(['Ann Lee to ann.lee@example.com, roy.example@example.com']);
  });

  it('switched off or a dry run: nothing is sent and nothing is written', () => {
    const r = py(`
lm, asked = mailboxes([signed("m1", 3)], sent_out_list=pack("ann.lee@example.com"))
send, sent = sender()
p = ledger()
rc = RC()
off = por.run(rc, NOW, True, False, list_mail=lm, fetch=fetch, send=send, ledger=p)
reads_off = len(asked)
dry = por.run(rc, NOW, False, True, list_mail=lm, fetch=fetch, send=send, ledger=p)
print(json.dumps({"sent": len(sent), "readsOff": reads_off, "ledger": rows(p), "writes": [c for c in rc.calls if c[0] != "LIST"],
                  "lock": os.path.exists(p + ".lock"), "offLine": por.line(off), "dryLine": por.line(dry)}))`);
    expect(r.sent).toBe(0);
    expect(r.readsOff).toBe(0);
    expect(r.ledger).toEqual([]);
    expect(r.writes).toEqual([]);
    expect(r.lock).toBe(false);
    expect(r.offLine).toBe('Proof of residency: nothing sent, the Cash Flow Voids agent is switched off or unread.');
    expect(r.dryLine).toBe('Proof of residency: a real run would send: Ann Lee to ann.lee@example.com, roy.example@example.com.');
  });

  it('CONTROL: a mailbox read that finds no Adobe email at all, is cut short, or dies fails loudly, in the worker\'s words', () => {
    const r = py(`
send, sent = sender()
blind = por.run(RC(), NOW, True, True, list_mail=mailboxes([])[0], fetch=fetch, send=send, ledger=ledger())
cut = por.run(RC(), NOW, True, True, list_mail=mailboxes([signed("m1", 3)], cut="in:sent")[0], fetch=fetch, send=send, ledger=ledger())
class FakeTriage:
    _last_fail = {"kind": "error", "message": "worker /gmail/list answered 500: backend error"}
por._TRI[:] = [FakeTriage()]
def boom(q, account): raise SystemExit(2)
dead = por.run(RC(), NOW, True, True, list_mail=boom, fetch=fetch, send=send, ledger=ledger())
print(json.dumps({"sent": len(sent), "blind": blind["failed"], "cut": cut["failed"], "dead": dead["failed"],
                  "brief": por.brief(blind), "line": por.line(blind)}))`);
    expect(r.sent).toBe(0);
    expect(r.blind).toContain('control failed: no Adobe signed email reached info@agilelets.co.uk in 76 days');
    expect(r.cut).toContain('was cut short');
    expect(r.dead).toBe('the proof of residency step could not run: worker /gmail/list answered 500: backend error');
    expect(r.brief).toBe('Proof of residency step FAILED: see the rent check row.');
    expect(r.line).toContain('FAILED:');
  });

  it('a signed copy missing from Adobe\'s email, or not a PDF, is never sent', () => {
    const r = py(`
lm, _ = mailboxes([signed("m1", 3, pdf=False)], sent_out_list=pack("ann.lee@example.com"))
send, sent = sender()
nopdf = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=send, ledger=ledger())
lm2, _ = mailboxes([signed("m2", 3)], sent_out_list=pack("ann.lee@example.com"))
html = por.run(RC(), NOW, True, True, list_mail=lm2, fetch=lambda m, a, acct: b"<html>", send=send, ledger=ledger())
print(json.dumps({"sent": len(sent), "held": nopdf["held"], "html": html["failed"], "line": por.line(html)}))`);
    expect(r.sent).toBe(0);
    expect(r.held[0]).toContain('does not carry exactly one signed PDF');
    expect(r.html).toContain('is not a PDF');
    expect(r.line).toContain('not sent: Ann Lee');
  });

  it('an Adobe signed email that names a residency document in another shape is said on the row and on Home', () => {
    const r = py(`
odd = {"id": "mODD", "internalDate": ms(3), "attachments": [],
       "headers": {"from": ADOBE, "subject": "Proof of Residency - Ann Lee between Roy Lavin and Roy Lavin is Signed and Filed!"}}
lm, _ = mailboxes([odd])
res = por.run(RC(), NOW, True, True, list_mail=lm, fetch=fetch, send=sender()[0], ledger=ledger())
print(json.dumps({"unreadable": res["unreadable"], "line": por.line(res), "brief": por.brief(res)}))`);
    expect(r.unreadable).toEqual(['Proof of Residency - Ann Lee between Roy Lavin and Roy Lavin is Signed and Filed!']);
    expect(r.line).toContain('cannot read, forward by hand: Proof of Residency - Ann Lee');
    expect(r.brief).toBe('Proof of residency: 1 not sent to the tenant, see your task or the rent check row.');
  });
});
