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
def ledger(*rows):
    p = os.path.join(tempfile.mkdtemp(), "sent-text.jsonl")
    with open(p, "w") as fh:
        for task, hours_ago, ends, event in rows:
            fh.write(json.dumps({"task": task, "ts": (NOW - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                                 "event": event, "numberEnds": ends}) + "\\n")
    return p
def mail(i, hours_ago, sender="noreply@clicksend.com", subject="Message failed", snippet=""):
    return {"id": i, "internalDate": str(int((NOW - timedelta(hours=hours_ago)).timestamp() * 1000)),
            "headers": {"from": sender, "subject": subject}, "snippet": snippet, "body": ""}
class RC:
    def __init__(self, notes="RENT CHECK KEY: x", tenancies=("recTENANCYTXT001",)):
        self.notes, self.tenancies, self.calls = notes, list(tenancies), []
    def api(self, method, path, payload=None, params=None):
        self.calls.append([method, path])
        if method == "GET":
            return {"id": path.split("/")[-1], "fields": {tc.TASK_NOTES: self.notes, tc.TASK_TENANCIES: self.tenancies}}
        if method == "PATCH":
            self.notes = payload["records"][0]["fields"][tc.TASK_NOTES]
        return {}
def inbox(sent, back, truncated=False):
    asked = []
    def list_mail(q):
        asked.append(q)
        return (sent, False) if q.startswith("in:sent") else (back, truncated)
    return list_mail, asked
`;
function py(body) {
  const out = execFileSync('python3', ['-c', HARNESS + body], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

describe('the text alarm reads info@ after every rent text and never reads blind', () => {
  it('no text in the last three days: the mailbox is not even read', () => {
    const r = py(`
lm, asked = inbox([], [])
out = tc.run(RC(), NOW, True, ledger=ledger(("recOLD", 80, "123", "sent"), ("recFAIL", 2, "123", "failed")), list_mail=lm)
print(json.dumps({"out": out, "asked": asked, "line": tc.line(out), "brief": tc.brief(out)}))`);
    expect(r.out).toEqual({ checked: 0, flagged: [], noted: [], failed: '' });
    expect(r.asked).toEqual([]);
    expect(r.line).toBe('Text check: no rent text sent in the last 3 days.');
    expect(r.brief).toBe('');
  });

  it('CONTROL: a text the ledger says went but info@ Sent cannot show is a loud failure, never "nothing came back"', () => {
    const r = py(`
p = ledger(("recA", 5, "123", "sent"), ("recB", 4, "456", "sent"))
lm, asked = inbox([mail("s1", 5)], [])
blind = tc.run(RC(), NOW, True, ledger=p, list_mail=lm)
fresh = tc.run(RC(), NOW, True, ledger=ledger(("recA", 5, "123", "sent"), ("recNEW", 0.05, "456", "sent")), list_mail=inbox([mail("s1", 5)], [])[0])
print(json.dumps({"blind": blind, "brief": tc.brief(blind), "asked": asked, "fresh": fresh["failed"], "freshLine": tc.line(fresh)}))`);
    expect(r.blind.failed).toMatch(/^control failed: the ledger says 2 text\(s\) went in the last 3 days but info@agilelets\.co\.uk's Sent shows 1/);
    expect(r.blind.flagged).toEqual([]);
    expect(r.brief).toMatch(/^Text check FAILED: control failed/);
    // The two reads: info@'s Sent, then ClickSend's emails back (a tenant's reply from sms.clicksend.com is not one).
    expect(r.asked).toEqual(['in:sent to:sms.clicksend.com newer_than:4d',
      '((from:clicksend.com -from:sms.clicksend.com) OR (from:mailer-daemon sms.clicksend.com)) newer_than:4d']);
    // A text sent three minutes ago may not be indexed yet: not a blind read.
    expect(r.fresh).toBe('');
    expect(r.freshLine).toBe('Text check: 2 rent text(s) in the last 3 days, nothing came back from ClickSend.');
  });

  it('ClickSend writes back after a text: the card and its tenancy say so once, Home says so every run', () => {
    const r = py(`
p = ledger(("recTEXTCARD00001", 6, "123", "sent"), ("recTEXTCARD00002", 5, "999", "sent"))
lm, _ = inbox([mail("s1", 6), mail("s2", 5)], [mail("m1", 4, snippet="Your message from 447984393339 to 447700900123 could not be delivered")])
rc = RC()
first = tc.run(rc, NOW, True, ledger=p, list_mail=lm)
again = tc.run(rc, NOW, True, ledger=p, list_mail=lm)
dry = tc.run(RC(), NOW, False, ledger=p, list_mail=lm)
print(json.dumps({"first": first, "again": again, "dry": dry, "calls": rc.calls, "notes": rc.notes, "brief": tc.brief(first)}))`);
    // It names the number ending 123, so only that text is flagged.
    expect(r.first).toEqual({ checked: 2, flagged: ['recTEXTCARD00001'], noted: ['recTEXTCARD00001'], failed: '' });
    expect(r.notes).toMatch(/TEXT CHECK: ClickSend wrote back to info@agilelets\.co\.uk after this text \("Message failed", 07 Oct 05:00 UTC, mail m1\)\. The text may not have arrived: look in ClickSend's SMS history\.$/);
    expect(r.calls).toEqual([['GET', 'tblqB8b22hKBL4PF1/recTEXTCARD00001'], ['PATCH', 'tblqB8b22hKBL4PF1'],
      ['POST', 'tblN51a88qTDB6iMH/recTENANCYTXT001/comments'], ['GET', 'tblqB8b22hKBL4PF1/recTEXTCARD00001']]);
    // Written once; still flagged on Home while it is inside the window.
    expect(r.again).toEqual({ checked: 2, flagged: ['recTEXTCARD00001'], noted: [], failed: '' });
    // A dry run flags and writes nothing.
    expect(r.dry).toEqual({ checked: 2, flagged: ['recTEXTCARD00001'], noted: [], failed: '' });
    expect(r.brief).toBe("Text check: ClickSend wrote back after 1 rent text (task recTEXTCARD00001): it may not have arrived, look in ClickSend's SMS history.");
  });

  it('an email back that names no number flags every text before it, and says it cannot tell which', () => {
    const r = py(`
p = ledger(("recTEXTCARD00001", 6, "123", "sent"), ("recTEXTCARD00002", 5, "999", "sent"))
lm, _ = inbox([mail("s1", 6), mail("s2", 5)], [mail("b1", 4, sender="Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
                                                     subject="Delivery Status Notification (Failure)", snippet="sms.clicksend.com rejected")])
rc = RC()
out = tc.run(rc, NOW, True, ledger=p, list_mail=lm)
ours = tc.run(RC(), NOW, True, ledger=p, list_mail=inbox([mail("s1", 6), mail("s2", 5)],
                                                          [mail("o1", 4, snippet="Email to SMS from +44 7984 393339 failed: no credit")])[0])
print(json.dumps({"out": out, "notes": rc.notes, "ours": ours["flagged"]}))`);
    expect(r.out.flagged).toEqual(['recTEXTCARD00001', 'recTEXTCARD00002']);
    expect(r.notes).toMatch(/It names no number, so every text sent before it is flagged; check which\.$/);
    // Our own sending number is never a tenant's: an email naming only it still flags every text before it.
    expect(r.ours).toEqual(['recTEXTCARD00001', 'recTEXTCARD00002']);
  });

  it('an email back from before the text, or naming another number, is not held against it', () => {
    const r = py(`
p = ledger(("recTEXTCARD00001", 30, "123", "sent"))
lm, _ = inbox([mail("s1", 30)], [mail("early", 31, snippet="07700 900123"), mail("other", 1, snippet="07700 900456")])
out = tc.run(RC(), NOW, True, ledger=p, list_mail=lm)
print(json.dumps({"out": out["flagged"], "checked": out["checked"]}))`);
    // Before it: not about it. After it but naming another number: not about it.
    expect(r.out).toEqual([]);
    expect(r.checked).toBe(1);
  });

  it('a mailbox that cannot be read, or reads cut short, is a failure said on the row, never a raise', () => {
    const r = py(`
p = ledger(("recTEXTCARD00001", 6, "123", "sent"))
def down(q): raise SystemExit("worker 502")
broken = tc.run(RC(), NOW, True, ledger=p, list_mail=down)
cut = tc.run(RC(), NOW, True, ledger=p, list_mail=inbox([mail("s1", 6)], [], truncated=True)[0])
print(json.dumps({"broken": broken["failed"], "cut": cut["failed"]}))`);
    expect(r.broken).toMatch(/^the text check could not run: /);
    expect(r.cut).toBe("the read of ClickSend's emails to info@ was cut short, so the check is incomplete");
  });
});
