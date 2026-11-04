import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEND_LETTER = resolve(ROOT, 'scripts/send-letter.py');

// ─── A LETTER PINGEN NEVER PRINTED MUST NOT READ AS POSTED ───────────────────
//
// Finding 20261015-agent-dispatch-916. On 15 Oct 2026 letter 62f2f949 for task
// recW1SunBsFaWc9FA went into the ledger as sent and onto the task as
// "SENT: ... posted via Pingen". Pingen was holding it at `awaiting_credits`:
// the account had no credit, so nothing was printed and nothing was posted. The
// script exited 0, the task read as done, and nobody was told for weeks.
//
// Read off the real ledger: the send PATCH answers `submitted` with no price,
// and a letter that is really going becomes `processing` with a price seconds
// later. So the status the PATCH returns proves nothing, and the only honest
// test is what Pingen settles on.
//
// These drive the real cmd_send with Pingen stubbed at each of the three
// answers. Back-tested by taking the posted/blocked branches back out: the
// awaiting_credits case then exits 0 and stamps SENT, as it did on 15 Oct.
function drive(finalStatus, price) {
  const script = `
import importlib.util, json, sys, types, contextlib, io
spec = importlib.util.spec_from_file_location('s', ${JSON.stringify(SEND_LETTER)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

FINAL = ${JSON.stringify(finalStatus)}
PRICE = ${price === null ? "None" : JSON.stringify(price)}
calls = {"patched": False}
rows = []
written = {}

def fake_pingen(method, path, token, body=None):
    if method == "PATCH" and path.endswith("/send"):
        calls["patched"] = True
        return {"data": {"id": "62f2f949", "type": "letters", "attributes": {"status": "submitted"}}}
    # Every GET after the send answers the settled status. Before it, 'valid'.
    status = FINAL if calls["patched"] else "valid"
    return {"data": {"id": "62f2f949", "attributes": {
        "status": status, "address": "HM Revenue and Customs, BX9 1AS",
        "price_currency": "GBP", "price_value": PRICE}}}

m.pingen = fake_pingen
m.pingen_token = lambda: "tok"
m.org_id = lambda: "org"
m.already_sent = lambda task: None
m.last_prepared = lambda task: {"letter": "62f2f949"}
m.load_approved = lambda task, require_approval=True: {
    "address": ["HM Revenue and Customs, BX9 1AS"], "delivery": "royalmail_secondclass",
    "taskName": "HMRC reply", "outcome": "Approved as-is"}
m.address_mismatch = lambda declared, parsed: ""
m.ledger_append = lambda row: rows.append(row)
m.get_task = lambda task: {"id": task, "fields": {m.AF["notes"]: "an earlier note"}}
m.airtable = lambda method, url, body=None: written.update(body.get("fields", {}))

args = types.SimpleNamespace(task="recW1SunBsFaWc9FA")
code = 0
try:
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        m.cmd_send(args)
except SystemExit as e:
    code = e.code if isinstance(e.code, int) else 1
row = rows[-1] if rows else {}
notes = written.get(m.AF["notes"], "")
print(json.dumps({"exit": code, "posted": row.get("posted"), "status": row.get("status"),
                  "saysSent": "SENT: letter" in notes, "saysNotPosted": "NOT POSTED:" in notes,
                  "saysUnconfirmed": "POSTING NOT CONFIRMED:" in notes}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

describe('send-letter: Pingen holding a letter is not a post (916)', () => {
  it('THE REGRESSION: awaiting_credits is recorded as NOT posted and exits non-zero', () => {
    const r = drive('awaiting_credits', null);
    expect(r.exit, 'a letter nobody printed must not exit 0').not.toBe(0);
    expect(r.posted).toBe(false);
    expect(r.status).toBe('awaiting_credits');
    expect(r.saysSent, 'the task must never be stamped SENT for an unprinted letter').toBe(false);
    expect(r.saysNotPosted, 'the task says what happened, and that credit is needed').toBe(true);
  });

  it('CONTROL — a letter that really goes still posts and exits 0', () => {
    // Without this, a change that failed every send would pass the test above.
    const r = drive('processing', '1.22');
    expect(r.exit).toBe(0);
    expect(r.posted).toBe(true);
    expect(r.saysSent).toBe(true);
    expect(r.saysNotPosted).toBe(false);
  });

  it('a status that is neither says so, rather than guessing a post', () => {
    const r = drive('some_status_pingen_added_later', null);
    expect(r.exit).not.toBe(0);
    expect(r.posted).toBe(false);
    expect(r.saysUnconfirmed).toBe(true);
    expect(r.saysSent).toBe(false);
  });

  it('a send that posted NOTHING can be retried, a real post still cannot', () => {
    // already_sent is the "a letter cannot be unposted" guard. It has to let the
    // awaiting_credits attempt through once the account is topped up, and it must
    // keep refusing a second post of a letter that went.
    const script = `
import importlib.util, json, types
spec = importlib.util.spec_from_file_location('s', ${JSON.stringify(SEND_LETTER)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
cases = {}
m.ledger_rows = lambda t: [{"cmd": "send", "letter": "a", "posted": False}]
cases["blockedAttempt"] = m.already_sent("recX") is not None
m.ledger_rows = lambda t: [{"cmd": "send", "letter": "b", "posted": True}]
cases["realPost"] = m.already_sent("recX") is not None
m.ledger_rows = lambda t: [{"cmd": "send", "letter": "c"}]      # rows written before 4 Nov 2026
cases["olderRow"] = m.already_sent("recX") is not None
print(json.dumps(cases))
`;
    const r = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
    expect(r.blockedAttempt, 'an attempt that printed nothing must not block the retry').toBe(false);
    expect(r.realPost, 'a letter that posted can never be posted twice').toBe(true);
    expect(r.olderRow, 'a ledger row with no posted key predates this and counts as a post').toBe(true);
  });
});
