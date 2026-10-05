// The text alarm (Kevin, 5 Oct 2026: "Do it now"): a rent text goes to ClickSend as an email, so a text
// ClickSend could not send shows only as an email back to info@. scripts/text_check.py reads info@ for one
// after each text and flags the card, its tenancy and Home. These drive the REAL module with the mailbox
// and Airtable stubbed: nothing reaches either. Every id and number is invented.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'scripts');

const HARNESS = `
import json, sys, os, tempfile
from datetime import datetime, timedelta, timezone
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
import text_check as tc
NOW = datetime(2026, 10, 7, 9, 0, tzinfo=timezone.utc)
CFV = "rec7aHLK1Q8fMLRXH"
def ledger(*rows, torn=False):
    p = os.path.join(tempfile.mkdtemp(), "sent-text.jsonl")
    with open(p, "w") as fh:
        for task, hours_ago, ends, event in rows:
            fh.write(json.dumps({"task": task, "ts": (NOW - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                                 "event": event, "numberEnds": ends, "messageId": "g" + task[-5:]}) + "\\n")
        if torn:
            fh.write('{"task": "recHALF\\n')
    return p
def gm(*tasks): return [{"id": "g" + t[-5:]} for t in tasks]
def mail(i, hours_ago, sender="noreply@clicksend.com", subject="Message failed", snippet="", date=True):
    m = {"id": i, "headers": {"from": sender, "subject": subject}, "snippet": snippet, "body": ""}
    if date:
        m["internalDate"] = str(int((NOW - timedelta(hours=hours_ago)).timestamp() * 1000))
    return m
class RC:
    """Airtable as it answers: fields keyed by id ONLY when asked for ids, else by name."""
    def __init__(self, notes="RENT CHECK KEY: x\\n[05 Oct] SENT: text", tenancies=("recTENANCYTEXT001",), output="", holder=CFV):
        self.fields = {tc.TK["notes"]: notes, tc.TK["tenancies"]: list(tenancies), tc.TK["output"]: output,
                       tc.TK["sentBy"]: [holder], tc.TK["name"]: "RENT LATE: Unit 9, rent due 1 Oct"}
        self.calls = []
    def api(self, method, path, payload=None, params=None):
        self.calls.append([method, path])
        if method == "GET":
            if (params or {}).get("returnFieldsByFieldId") != "true":
                return {"id": path.split("/")[-1], "fields": {"Notes": self.fields[tc.TK["notes"]]}}
            return {"id": path.split("/")[-1], "fields": dict(self.fields)}
        if method == "PATCH":
            self.fields[tc.TK["notes"]] = payload["records"][0]["fields"][tc.TK["notes"]]
        return {}
def inbox(sent, back, truncated=False):
    asked = []
    def list_mail(q):
        asked.append(q)
        return (sent, False) if q.startswith("in:sent") else (back, truncated)
    return list_mail, asked
A, B = "recTEXTCARD00001", "recTEXTCARD00002"
`;
function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('the text alarm reads info@ after every rent text and never reads blind', () => {
  it('no text in the last three days: the mailbox is not even read', () => {
    const r = py(`
lm, asked = inbox([], [])
out = tc.run(RC(), NOW, True, ledger=ledger(("recOLD00000OLD01", 80, "123", "sent"), ("recFAILED0000001", 2, "123", "failed")), list_mail=lm)
print(json.dumps({"out": out, "asked": asked, "line": tc.line(out), "brief": tc.brief(out)}))`);
    expect(r.out).toEqual({ checked: 0, flagged: [], noted: [], failed: '', torn: 0 });
    expect(r.asked).toEqual([]);
    expect(r.line).toBe('Text check: no rent text sent in the last 3 days.');
    expect(r.brief).toBe('');
  });

  it('CONTROL: a logged text info@ Sent does not hold BY ITS ID is a loud failure, even when the counts agree', () => {
    const r = py(`
p = ledger((A, 5, "123", "sent"), (B, 4, "456", "sent"))
lm, asked = inbox(gm(A) + [{"id": "aManualTestEmail"}], [])
blind = tc.run(RC(), NOW, True, ledger=p, list_mail=lm)
fresh = tc.run(RC(), NOW, True, ledger=ledger((A, 5, "123", "sent"), (B, 0.05, "456", "sent")), list_mail=inbox(gm(A), [])[0])
print(json.dumps({"blind": blind, "brief": tc.brief(blind), "line": tc.line(blind), "asked": asked, "fresh": fresh["failed"], "freshLine": tc.line(fresh)}))`);
    // Two emails in Sent, two texts logged: a count would pass. The ids do not.
    expect(r.blind.failed).toBe("control failed: 1 of 2 logged text(s) are not in info@agilelets.co.uk's Sent by their mail id (task recTEXTCARD00002): the mailbox read is blind, so no text can be called fine");
    expect(r.blind.flagged).toEqual([]);
    // Home gets the short form; the row gets the whole story.
    expect(r.brief).toBe('Text check FAILED: see the rent check row.');
    expect(r.line).toMatch(/^Text check FAILED: control failed: 1 of 2/);
    expect(r.asked).toEqual(['in:sent to:sms.clicksend.com newer_than:4d',
      '(from:clicksend.com OR (from:mailer-daemon sms.clicksend.com)) newer_than:4d']);
    // A text sent three minutes ago may not be indexed yet: not a blind read.
    expect(r.fresh).toBe('');
    expect(r.freshLine).toBe('Text check: 2 rent text(s) in the last 3 days, nothing came back from ClickSend.');
  });

  it('ClickSend writes back naming one text: that card and its tenancy say so once, Home says so every run', () => {
    const r = py(`
p = ledger((A, 6, "123", "sent"), (B, 5, "999", "sent"))
lm, _ = inbox(gm(A, B), [mail("m1", 4, snippet="Your message from 447984393339 to 447700900123 could not be delivered")])
rc = RC()
first = tc.run(rc, NOW, True, ledger=p, list_mail=lm)
again = tc.run(rc, NOW, True, ledger=p, list_mail=lm)
dry = tc.run(RC(), NOW, False, ledger=p, list_mail=lm)
print(json.dumps({"first": first, "again": again, "dry": dry, "calls": rc.calls, "notes": rc.fields[tc.TK["notes"]], "brief": tc.brief(first)}))`);
    expect(r.first).toEqual({ checked: 2, flagged: ['recTEXTCARD00001'], noted: ['recTEXTCARD00001'], failed: '', torn: 0 });
    expect(r.notes).toMatch(/TEXT CHECK: ClickSend wrote back to info@agilelets\.co\.uk after this text \("Message failed", 07 Oct 05:00 UTC, mail m1\)\. The text may not have arrived: look in ClickSend's SMS history\.$/);
    expect(r.calls).toEqual([['GET', 'tblqB8b22hKBL4PF1/recTEXTCARD00001'], ['PATCH', 'tblqB8b22hKBL4PF1'],
      ['POST', 'tblN51a88qTDB6iMH/recTENANCYTEXT001/comments'], ['GET', 'tblqB8b22hKBL4PF1/recTEXTCARD00001']]);
    expect(r.again).toEqual({ checked: 2, flagged: ['recTEXTCARD00001'], noted: [], failed: '', torn: 0 });
    expect(r.dry).toEqual({ checked: 2, flagged: ['recTEXTCARD00001'], noted: [], failed: '', torn: 0 });
    expect(r.brief).toBe("Text check: ClickSend wrote back after 1 rent text (task recTEXTCARD00001): it may not have arrived, look in ClickSend's SMS history.");
  });

  it('an email that does not name exactly one of our texts flags every text before it, as "cannot tell which"', () => {
    const r = py(`
p = ledger((A, 6, "123", "sent"), (B, 5, "999", "sent"))
cases = {
  "bounce": mail("b1", 4, sender="Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject="Delivery Status Notification (Failure)", snippet="sms.clicksend.com rejected"),
  "ownOnly": mail("o1", 4, snippet="Email to SMS from +44 7984 393339 failed: no credit"),
  "otherNumber": mail("x1", 4, snippet="Message to 07700 900456 failed"),
  "longId": mail("l1", 4, snippet="Insufficient credit. Message ID: 9907123456123001"),
  "noDate": mail("d1", 0, snippet="failed", date=False),
  "fromSmsDomain": mail("s1", 4, sender="447700900123@sms.clicksend.com", subject="Undelivered message", snippet="failed"),
}
out = {}
for k, m in cases.items():
    rc = RC()
    res = tc.run(rc, NOW, True, ledger=p, list_mail=inbox(gm(A, B), [m])[0])
    out[k] = res["flagged"]
    out[k + "Note"] = "does not name exactly one of our texts" in rc.fields[tc.TK["notes"]]
print(json.dumps(out))`);
    for (const k of ['bounce', 'ownOnly', 'otherNumber', 'longId', 'noDate']) {
      expect(r[k], k).toEqual(['recTEXTCARD00001', 'recTEXTCARD00002']);
      expect(r[k + 'Note'], k).toBe(true);
    }
    // A long id holding 07123456123 inside it is not a mobile (it would have named only the first text).
    // ClickSend's sms subdomain is read too: only a tenant's own text is skipped. This one names our first text.
    expect(r.fromSmsDomain).toEqual(['recTEXTCARD00001']);
    expect(r.fromSmsDomainNote).toBe(false);
  });

  it('two texts sharing the named ending: those two are flagged, as "cannot tell which", and the third is not', () => {
    const r = py(`
C = "recTEXTCARD00003"
p = ledger((A, 6, "123", "sent"), (B, 5, "123", "sent"), (C, 5, "999", "sent"))
rc = RC()
out = tc.run(rc, NOW, True, ledger=p, list_mail=inbox(gm(A, B, C), [mail("m1", 4, snippet="to 07700 900123 failed")])[0])
print(json.dumps({"flagged": out["flagged"], "unsure": "does not name exactly one of our texts" in rc.fields[tc.TK["notes"]]}))`);
    expect(r.flagged).toEqual(['recTEXTCARD00001', 'recTEXTCARD00002']);
    expect(r.unsure).toBe(true);
  });

  it('a tenant text or picture, or an email from before the text, is not held against it; a bounce a second early still is', () => {
    const r = py(`
p = ledger((A, 30, "123", "sent"))
early = mail("e1", 31, snippet="Message to 07700 900123 failed")
replies = [mail("r1", 2, sender="447700900123@sms.clicksend.com", subject="SMS reply from +447700900123", snippet="ok thanks"),
           mail("r2", 2, sender="447700900123@sms.clicksend.com", subject="Incoming SMS from +447700900123", snippet="paid"),
           mail("r3", 2, sender="447700900123@sms.clicksend.com", subject="MMS reply from +447700900123", snippet="photo"),
           mail("r4", 2, sender="447700900123@sms.clicksend.com", subject="Incoming MMS from +447700900123", snippet="photo")]
quiet = tc.run(RC(), NOW, True, ledger=p, list_mail=inbox(gm(A), [early] + replies)[0])
second = mail("g1", 30 + 1 / 3600, snippet="Message to 07700 900123 failed")
grace = tc.run(RC(), NOW, True, ledger=p, list_mail=inbox(gm(A), [second])[0])
print(json.dumps({"quiet": quiet["flagged"], "grace": grace["flagged"]}))`);
    expect(r.quiet).toEqual([]);
    expect(r.grace).toEqual(['recTEXTCARD00001']);
  });

  it('the Notes write keeps ids on both sides, and a card whose Notes read blank is a STOP, never a wipe', () => {
    const r = py(`
p = ledger((A, 6, "123", "sent"))
lm = inbox(gm(A), [mail("m1", 4, snippet="to 07700 900123 failed")])[0]
blank = RC(notes="")
stopped = tc.run(blank, NOW, True, ledger=p, list_mail=lm)
named = RC()
real_api = named.api
named.api = lambda method, path, payload=None, params=None: real_api(method, path, payload, None if method == "GET" else params)
byName = tc.run(named, NOW, True, ledger=p, list_mail=lm)
print(json.dumps({"stopped": stopped, "blankCalls": blank.calls, "byName": byName["failed"], "byNameCalls": named.calls}))`);
    expect(r.stopped.failed).toBe("STOP: task recTEXTCARD00001's Notes read blank, so the text-check note was not written");
    expect(r.stopped.flagged).toEqual(['recTEXTCARD00001']);
    expect(r.blankCalls).toEqual([['GET', 'tblqB8b22hKBL4PF1/recTEXTCARD00001']]);
    // A read that came back keyed by name reads blank by id: stopped, nothing patched.
    expect(r.byName).toMatch(/^STOP: /);
    expect(r.byNameCalls.map((c) => c[0])).toEqual(['GET']);
  });

  it('a plan card with no tenancy link is noted on its PLAN FOR tenancy', () => {
    const r = py(`
p = ledger((A, 6, "123", "sent"))
rc = RC(tenancies=(), output="PLAN FOR: recTENANCYPLAN001\\nPLAN: 2026-10-10 £100.00\\nTO: a@b.com\\n---\\nx")
tc.run(rc, NOW, True, ledger=p, list_mail=inbox(gm(A), [mail("m1", 4, snippet="to 07700 900123 failed")])[0])
print(json.dumps([c for c in rc.calls if c[0] == "POST"]))`);
    expect(r).toEqual([['POST', 'tblN51a88qTDB6iMH/recTENANCYPLAN001/comments']]);
  });

  it('a mailbox that cannot be read or reads cut short is a failure on the row; a torn ledger line is a note; never a raise', () => {
    const r = py(`
p = ledger((A, 6, "123", "sent"))
def down(q): raise SystemExit("worker 502")
broken = tc.run(RC(), NOW, True, ledger=p, list_mail=down)
cut = tc.run(RC(), NOW, True, ledger=p, list_mail=inbox(gm(A), [], truncated=True)[0])
torn = tc.run(RC(), NOW, True, ledger=ledger((A, 6, "123", "sent"), torn=True), list_mail=inbox(gm(A), [])[0])
print(json.dumps({"broken": broken["failed"], "cut": cut["failed"], "torn": [torn["failed"], torn["checked"], tc.line(torn), tc.brief(torn)]}))`);
    expect(r.broken).toMatch(/^the text check could not run: /);
    expect(r.cut).toBe("the read of ClickSend's emails to info@ was cut short, so the check is incomplete");
    // A torn line has no date to age out by, so it is said on the row, never red; the good lines are still checked.
    expect(r.torn).toEqual(['', 1, 'Text check: 1 rent text(s) in the last 3 days, nothing came back from ClickSend. 1 unreadable line(s) in the text ledger were skipped.', '']);
  });
});
