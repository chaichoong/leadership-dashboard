// One bill, one row on the Payment Run, and a bill paid on its card leaves the
// list by itself (Kevin, 31 Oct 2026).
//
//   1. TWO CARDS, ONE BILL. A £6 ground rent bill came in on two approved cards.
//      The second card had no REFERENCE line and was named after its task, so the
//      daily job only saw a "possible twin" and listed it again with a CHECK. The
//      only way off was Mark Paid, and both rows ended up Paid for one payment.
//      Its own text carried the first row's reference: that is the evidence the
//      job now folds on.
//   2. A SHARED PAYEE AND AMOUNT ALONE IS NOT ONE BILL. A contractor charges the
//      same call-out at two houses, and two invoices of one size carry two
//      references. Those are still listed (and flagged on the page).
//   3. PAID ON THE CARD. A Your step card says "Press Pay, then write Done on this
//      card". The sweep records his Done in the task's Notes; the row now closes
//      on it. Only HIS Done, only a payment step, only after the card's approval.
//   4. AN EMAIL FOR A BILL ALREADY OWED is kept off the list as a Duplicate row,
//      so its message id holds and next Friday's scan does not add it again.
//
// Drives the real functions in scripts/payment-run.py through a Python harness,
// as tests/payment-run-watertight.test.js does. PAYMENT_RUN_PY points the cases
// at another copy of the script for a back-test. Invented names only: the repo
// is public.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.PAYMENT_RUN_PY || join(ROOT, 'scripts', 'payment-run.py');

const HARNESS = String.raw`
import importlib.util, json, sys
from datetime import datetime
spec = importlib.util.spec_from_file_location("pr", sys.argv[1])
pr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pr)
out = {}
def case(name, fn):
    try:
        out[name] = {"ok": True, "value": fn()}
    except Exception as exc:
        out[name] = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}

D = lambda s: datetime.fromisoformat(s).date()
def bill(i, day, amount, payee, **extra):
    return {"id": i, "fields": dict({"Status": "Unpaid", "Amount": amount, "Email Date": day,
                                     "Payee": payee}, **extra)}

# The first card's row, still owed.
first = bill("recFirst", "2026-09-24", 7, "Oakbridge Estates Limited", Reference="55120",
             Description="Ground rent, 9 Larch Street")
# The second card: no PAYEE or REFERENCE line, named after its task, the reference in its words.
SECOND = ("MARK FOR PAYMENT: Oakbridge ground rent, 9 Larch Street. Pay £7.00 online by Tuesday.\n\n"
          "KEVIN ONLY: payment: sign in with property reference 55120 and pay £7.00.\n")
def card(i="recSecond", name="INBOUND: Oakbridge ground rent arrears GBP 7.00 - 9 Larch Street",
         text=SECOND, approved="2026-10-22", created="2026-10-22"):
    return {"id": i, "name": name, "created": created, "approved": approved,
            "card": pr.parse_payment_card(text), "refused": "", "text": text}

def show(d):
    if isinstance(d, dict):
        return d["id"]
    if isinstance(d, tuple):
        return [x["id"] if isinstance(x, dict) else x for x in d]
    return d
def plan(cards, rows, today="2026-10-23"):
    return [(a, show(d)) for a, _c, d in pr.plan_tasks(cards, rows, {}, D(today))]

case("second_card_folds", lambda: plan([card()], [first]))

def second_card_writes():
    import io, contextlib
    captured = []
    pr.approved_payment_cards = lambda: [card()]
    pr.airtable_write = lambda t, m, recs, what: captured.append((m, recs))
    with contextlib.redirect_stdout(io.StringIO()):
        pr.run_tasks([first], [], True, D("2026-10-23"))
    return [(m, [(r.get("id"), r["fields"].get("Description", ""), r["fields"].get("Status")) for r in recs])
            for m, recs in captured]
case("second_card_writes", second_card_writes)

def other_house_lists():
    a = bill("recCallA", "2026-10-20", 90, "Fernway Plumbing Ltd", Description="Call-out, 4 Birch Road")
    t = "MARK FOR PAYMENT: Fernway call-out, 12 Cedar Place\nPAYEE: Fernway Plumbing Ltd\nAMOUNT: £90.00\n"
    return plan([card("recCallB", "Fernway call-out", t)], [a])
case("other_house_lists", other_house_lists)

def other_reference_lists():
    a = bill("recInvA", "2026-10-20", 72, "Kestrel Fire Ltd", Reference="40011")
    t = "MARK FOR PAYMENT: Kestrel invoice\nPAYEE: Kestrel Fire Ltd\nAMOUNT: £72.00\nREFERENCE: 40012\n"
    return plan([card("recInvB", "Kestrel invoice 40012", t)], [a])
case("other_reference_lists", other_reference_lists)

def payee_and_amount_alone_lists():
    a = bill("recNetA", "2026-10-02", 20, "Larkspur Ltd")
    t = "MARK FOR PAYMENT: Larkspur broadband\nPAYEE: Larkspur Ltd\nAMOUNT: £20.00\n"
    return plan([card("recNetB", "Larkspur broadband", t)], [a])
case("payee_and_amount_alone_lists", payee_and_amount_alone_lists)

def lane_words_never_match():
    a = bill("recGR1", "2026-10-02", 7, "INBOUND: Willowmere ground rent arrears GBP 7.00")
    return plan([card()], [a])
case("lane_words_never_match", lane_words_never_match)

DONE = "\n[31 Oct 2026 07:12 — Kevin] BLOCKER CLEARED (KEVIN payment): Kevin says the step is done: paid by card."
def listed_row(**extra):
    return bill("recListed", "2026-10-22", 7, "Oakbridge Estates Limited", Reference="55120",
                **dict({"Gmail Message ID": "task:recSecond"}, **extra))

case("done_marks_listed_row_paid", lambda: plan([card(text=SECOND + DONE)], [listed_row()]))

def done_writes_paid():
    import io, contextlib
    captured = []
    pr.approved_payment_cards = lambda: [card(text=SECOND + DONE)]
    pr.airtable_write = lambda t, m, recs, what: captured.append((m, recs))
    with contextlib.redirect_stdout(io.StringIO()):
        pr.run_tasks([listed_row()], [], True, D("2026-11-01"))
    return [(m, [(r.get("id"), r["fields"].get("Status"), r["fields"].get("Paid Date")) for r in recs])
            for m, recs in captured]
case("done_writes_paid", done_writes_paid)

case("done_before_approval_ignored", lambda: plan([card(text=SECOND + DONE, approved="2026-11-02")], [listed_row()]))
case("agent_clearing_is_not_kevins_done", lambda: plan([card(text=SECOND + DONE.replace(
    "— Kevin] BLOCKER CLEARED (KEVIN payment): Kevin says the step is done",
    "— agent] BLOCKER CLEARED (KEVIN payment): evidence: bank line seen"))], [listed_row()]))
case("signature_step_is_not_a_payment", lambda: plan([card(text=SECOND + DONE.replace("KEVIN payment", "KEVIN signature"))], [listed_row()]))
case("paid_row_stays_listed", lambda: plan([card(text=SECOND + DONE)], [listed_row(Status="Paid")]))
case("done_before_listing_adds_paid", lambda: plan([card(text=SECOND + DONE)], []))
case("done_folds_into_twin_as_paid", lambda: plan([card(text=SECOND + DONE)], [first]))

# Review, 31 Oct 2026: a card's notes name the sender's EARLIER bills, which is exactly the
# bill already on the list. Only the card's own lines are evidence.
HOLLIN = bill("recHollinA", "2026-10-20", 350, "Hollin Clearances Ltd", Reference="INV-101")
def history_names_earlier_bill():
    t = ("MARK FOR PAYMENT: Hollin garden clearance\nPAYEE: Hollin Clearances Ltd\nAMOUNT: £350.00\n"
         "\nTRACK RECORD\n- 20 Oct 2026: Hollin invoiced INV-101 £350, on the list\n")
    return plan([card("recHollinB", "Hollin clearance, second job", t)], [HOLLIN])
case("history_names_earlier_bill", history_names_earlier_bill)

def history_names_other_house():
    a = bill("recFernA", "2026-10-20", 90, "Fernway Plumbing Ltd", Description="Call-out, 9 Larch Street")
    t = ("MARK FOR PAYMENT: Fernway call-out, 12 Cedar Place\nPAYEE: Fernway Plumbing Ltd\nAMOUNT: £90.00\n"
         "\nLast paid: call-out at 9 Larch Street\n")
    return plan([card("recFernC", "Fernway call-out", t)], [a])
case("history_names_other_house", history_names_other_house)

def short_ref_inside_an_id():
    a = bill("recShort", "2026-10-20", 5, "Quillon Signs Ltd", Reference="104")
    t = "MARK FOR PAYMENT: Quillon sign\nPAYEE: Quillon Signs Ltd\nAMOUNT: £5.00\nNOTES: email #all/19a2f104bc0d1e2f\n"
    return plan([card("recShortB", "Quillon sign", t)], [a])
case("short_ref_inside_an_id", short_ref_inside_an_id)

def done_new_flags_weak_twin():
    import io, contextlib
    weak = bill("recWeakNet", "2026-10-02", 20, "Larkspur Ltd")
    t = "MARK FOR PAYMENT: Larkspur broadband\nPAYEE: Larkspur Ltd\nAMOUNT: £20.00\n" + DONE
    captured = []
    pr.approved_payment_cards = lambda: [card("recNetPaid", "Larkspur broadband", t)]
    pr.airtable_write = lambda tb, m, recs, what: captured.append((m, recs))
    with contextlib.redirect_stdout(io.StringIO()):
        pr.run_tasks([weak], [], True, D("2026-11-01"))
    return [(m, [(r.get("id"), r["fields"].get("Status"), r["fields"].get("Description", "")[:40]) for r in recs])
            for m, recs in captured]
case("done_new_flags_weak_twin", done_new_flags_weak_twin)

def email_twin_kept_off():
    import io, contextlib, tempfile, os
    captured = []
    pr.airtable_list = lambda table, params=None, what=None: [first]
    pr.airtable_write = lambda t, m, recs, what: captured.append((m, recs))
    items = [{"messageId": "19f0a0b0c0d0e0f1", "payee": "Oakbridge Estates Ltd", "amount": 7,
              "reference": "55120", "description": "Ground rent demand", "emailDate": "2026-10-28"},
             {"messageId": "19f0a0b0c0d0e0f2", "payee": "Hollin Clearances Ltd", "amount": 350,
              "reference": "INV-9001", "description": "Garden clearance", "emailDate": "2026-10-28"}]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(items, fh)
    class A: pass
    a = A(); a.items = fh.name; a.run_date = "2026-10-30"
    with contextlib.redirect_stdout(io.StringIO()):
        pr.cmd_write(a)
    os.unlink(fh.name)
    posts = [r["fields"] for m, recs in captured if m == "POST" for r in recs]
    patches = [r["id"] for m, recs in captured if m == "PATCH" for r in recs]
    return [[(p["Gmail Message ID"], p.get("Status", "")) for p in posts], patches]
case("email_twin_kept_off", email_twin_kept_off)

print(json.dumps(out))
`;

const R = JSON.parse(execFileSync('python3', ['-c', HARNESS, PY], { encoding: 'utf8' }));
const value = (name) => {
  expect(R[name].ok, `${name} raised: ${R[name].error}`).toBe(true);
  return R[name].value;
};

describe('payment run: one bill, one row', () => {
  it('a second card whose words carry the open row\'s reference folds into it, not listed again', () => {
    expect(value('second_card_folds')).toEqual([['fold', 'recFirst']]);
  });
  it('folding adds nothing to the list and tells Kevin on the kept row', () => {
    const writes = value('second_card_writes');
    expect(writes.map(w => w[0])).toEqual(['PATCH']);
    const [id, description] = writes[0][1][0];
    expect(id).toBe('recFirst');
    expect(description).toContain('Second card for this bill');
    expect(description).toContain('recSecond');
  });
  it('the same payee and fee at a different house is listed', () => {
    expect(value('other_house_lists')[0][0]).toBe('check');
  });
  it('the same payee and amount with a different reference is listed', () => {
    expect(value('other_reference_lists')[0][0]).not.toBe('fold');
  });
  it('a shared payee and amount with nothing else agreeing is listed with a CHECK, never folded', () => {
    expect(value('payee_and_amount_alone_lists')[0][0]).toBe('check');
  });
  it('two cards named after their tasks never match on lane words like "ground rent arrears"', () => {
    expect(value('lane_words_never_match')[0][0]).not.toBe('fold');
  });
});

describe('payment run: a card\'s history is never evidence (review, 31 Oct 2026)', () => {
  it('a second bill whose track record names the first bill\'s reference is listed, not folded', () => {
    expect(value('history_names_earlier_bill')[0][0]).toBe('check');
  });
  it('a call-out at another house is listed even when the notes name the first house', () => {
    expect(value('history_names_other_house')[0][0]).toBe('check');
  });
  it('a short reference inside a Gmail id is not the reference', () => {
    expect(value('short_ref_inside_an_id')[0][0]).not.toBe('fold');
  });
});

describe('payment run: Done on a Your step payment card clears the row', () => {
  it('Kevin\'s Done marks the card\'s own row paid, on the day he pressed it', () => {
    expect(value('done_marks_listed_row_paid')).toEqual([['done', ['recListed', '2026-10-31']]]);
  });
  it('the write sets Status Paid and the Paid Date', () => {
    expect(value('done_writes_paid')).toEqual([['PATCH', [['recListed', 'Paid', '2026-10-31']]]]);
  });
  it('a Done from before the card was approved was a different step', () => {
    expect(value('done_before_approval_ignored')[0][0]).toBe('listed');
  });
  it('an agent clearing the wall is not Kevin paying', () => {
    expect(value('agent_clearing_is_not_kevins_done')[0][0]).toBe('listed');
  });
  it('a Done on a signature step is not a payment', () => {
    expect(value('signature_step_is_not_a_payment')[0][0]).toBe('listed');
  });
  it('a row already Paid is left alone', () => {
    expect(value('paid_row_stays_listed')[0][0]).toBe('listed');
  });
  it('paid on the card before it reached the list: added once, already Paid', () => {
    expect(value('done_before_listing_adds_paid')).toEqual([['done_new', ['2026-10-31', null]]]);
  });
  it('paid on the card with a look-alike row still owed: the look-alike is told to check, never left silent', () => {
    const writes = value('done_new_flags_weak_twin');
    expect(writes.find(w => w[0] === 'POST')[1][0][1]).toBe('Paid');
    expect(writes.find(w => w[0] === 'PATCH')[1]).toEqual([['recWeakNet', null, 'CHECK: a card for the same payee and amo']]);
  });
  it('paid on a second card for a bill already owed: the owed row is marked Paid', () => {
    expect(value('done_folds_into_twin_as_paid')).toEqual([['done', ['recFirst', '2026-10-31']]]);
  });
});

describe('payment run: the Friday scan keeps an already-owed bill off the list', () => {
  it('an email for a bill already owed is written as a Duplicate row; a new bill is written Unpaid', () => {
    const [posts, patches] = value('email_twin_kept_off');
    expect(posts).toEqual([['19f0a0b0c0d0e0f1', 'Duplicate'], ['19f0a0b0c0d0e0f2', '']]);
    expect(patches).toEqual(['recFirst']);
  });
});
