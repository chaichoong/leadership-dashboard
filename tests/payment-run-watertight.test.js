// The four ways the Friday payment list went wrong, found by the 25 Sep 2026
// audit after Kevin said paid bills were not clearing and bills were missing.
//
//   1. PAID, NEVER CLEARED. `check` found the payment and only PRINTED it. A
//      £90 gas certificate paid on 21 Sep, the bank line naming the engineer's
//      company, was still listed as owed four days later.
//   2. APPROVED CARDS NEVER LISTED. The skill told the model to add approved
//      MARK FOR PAYMENT cards, no code did, and it named the wrong field. Two
//      approved cards had been promised a place on the list and never had one.
//   3. MONEY OUT, NO BILL. 30+ contractor payments left the business account
//      from 1 Aug with no email anywhere, so no scan could see them. Nothing
//      reported what was missing.
//   4. A MISSED FRIDAY WAS LOST. The scan never looked back further than seven
//      days, and its one scheduled run read the wrong week.
//
// Plus the independent review's findings on the first fix: the wrong one of
// two same-size bills closed, "city" matched inside "electricity", a card
// read an amount from above its heading, a card and its own email listed
// twice, and a card listed on a Friday fell into next week's section.
//
// Each case drives the real functions in scripts/payment-run.py through a
// small Python harness. PAYMENT_RUN_PY points the same cases at another copy
// of the script, which is how they were back-tested against the pre-fix file:
// every case below fails there. Invented names only: the repo is public.
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
def txn(i, day, gbp, name, **extra):
    return {"id": i, "fields": dict({"**Date": day, "**GBP": gbp, "*Name": name}, **extra)}

gas_tx = txn("txGas", "2026-09-21", -90, "Brightwater Gas Ltd 5 Mill Lane")
gas = bill("recGas", "2026-09-16", 90, "Brightwater Gas Ltd", Description="LGSR, 5 Mill Lane")

def paid_row_clears():
    paid, probable = pr.plan_settle([gas], pr.index_by_amount([gas_tx]))
    ups = pr.settle_updates(paid, probable)
    return [(u["id"], u["fields"].get("Status"), u["fields"].get("Matched Transaction")) for u in ups]
case("paid_row_clears", paid_row_clears)

def one_payment_one_bill():
    paid, _ = pr.plan_settle([dict(gas, id="recA"), dict(gas, id="recB")], pr.index_by_amount([gas_tx]))
    return len(paid)
case("one_payment_one_bill", one_payment_one_bill)

def named_house_is_settled():
    a = bill("recA", "2026-09-10", 90, "Brightwater Gas Ltd", Description="LGSR, 22 Oak Road")
    b = bill("recB", "2026-09-16", 90, "Brightwater Gas Ltd", Description="LGSR, 5 Mill Lane")
    return [r["id"] for r, _t in pr.plan_settle([a, b], pr.index_by_amount([gas_tx]))[0]]
case("named_house_is_settled", named_house_is_settled)

def whole_words_only():
    council = bill("recC", "2026-09-01", 150, "Coventry City Council")
    dd = txn("txDD", "2026-09-05", -150, "DD:OCTOPUS ELECTRICITY")
    return len(pr.plan_settle([council], pr.index_by_amount([dd]))[0])
case("whole_words_only", whole_words_only)

CARD = ("MARK FOR PAYMENT: Oakfield ground rent\n\nPAYEE: Oakfield Ground Rents Limited\n"
        "AMOUNT: £2.22 (£1.11 ground rent + £1.11 arrears)\nREFERENCE: GR-4471\nDUE DATE: 2026-10-24\n")
def task(**extra):
    base = {"id": "recCard", "name": "Oakfield ground rent", "created": "2026-09-25",
            "card": pr.parse_payment_card(CARD), "refused": "", "text": CARD}
    base.update(extra)
    return base

def card_lists_on_friday_before():
    before = pr.plan_tasks([task()], [], {}, D("2026-10-22"))[0][0]
    on = pr.plan_tasks([task()], [], {}, D("2026-10-23"))[0][0]
    return [before, on]
case("card_lists_on_friday_before", card_lists_on_friday_before)

def card_on_friday_is_in_run_to_pay():
    this_start, last_start = pr.week_buckets(datetime(2026, 10, 23, 21, 5, tzinfo=pr.LONDON))
    row = {"id": "c", "fields": {"Email Date": pr.task_row_fields(task(), D("2026-10-23"))["Email Date"]}}
    return [r["id"] for r in pr.bucket_rows([row], this_start, last_start)[1]]
case("card_on_friday_is_in_run_to_pay", card_on_friday_is_in_run_to_pay)

def card_reads_below_its_heading():
    return pr.parse_payment_card("Arrears summary\nAMOUNT: £3,000.00\n\nMARK FOR PAYMENT\n"
                                 "PAYEE: Oakfield Roofing\nAMOUNT: £100.00")["amount"]
case("card_reads_below_its_heading", card_reads_below_its_heading)

def card_and_its_email_are_one_bill():
    row = bill("recMail", "2026-09-21", 2.22, "Oakfield Ground Rents Ltd",
               **{"Gmail Message ID": "18a0f00dcafe0001"})
    t = task(created="2026-09-22", text=CARD + "\n- email: #all/18a0f00dcafe0001")
    return pr.plan_tasks([t], [row], {}, D("2026-10-23"))[0][0]
case("card_and_its_email_are_one_bill", card_and_its_email_are_one_bill)

def freeform_card_is_listed():
    card = pr.parse_payment_card("Six reminders.\n\nMARK FOR PAYMENT — £330.00 total (two invoices)\n")
    t = {"id": "recFF", "name": "Oakfield Alarms Ltd - 2 Ash Court", "created": "2026-02-18",
         "card": card, "refused": "", "text": ""}
    action, c, _ = pr.plan_tasks([t], [], {}, D("2026-09-25"))[0]
    return [action, c["card"]["payee"], c["card"]["amount"]]
case("freeform_card_is_listed", freeform_card_is_listed)

def forged_approval_refused():
    return pr.plan_tasks([task(refused="no approval was ever recorded (Approved At is empty)")],
                         [], {}, D("2026-10-23"))[0][0]
case("forged_approval_refused", forged_approval_refused)

def unlisted_transfer_reported():
    zem = lambda i, name, gbp=-80: {"id": i, "fields": {
        "Account Alias (from **Account)": ["TNT Mgt Zempler"], "**GBP": gbp, "*Name": name,
        "**Date": "2026-09-20"}}
    txs = [zem("t1", "Oakfield Roofing 3 Ash Road"), zem("t2", "Fin: AMZNMktplace"),
           zem("t3", "DD:LOAN CO 1234"), zem("t4", "Brightwater Gas Ltd 5 Mill Lane", -90)]
    rows = [bill("rOpen", "2026-09-16", 90, "Brightwater Gas Ltd")]
    return sorted(t["id"] for t in pr.unlisted_transfers(txs, rows))
case("unlisted_transfer_reported", unlisted_transfer_reported)

def hand_paid_never_takes_open_bills_payment():
    acme = bill("recAcme", "2026-09-10", 90, "Acme Roofing", Status="Paid", **{"Paid Date": "2026-09-21"})
    links, paid, _p = pr.plan_all([acme, gas], pr.index_by_amount([gas_tx]), "2026-09-01")
    return [[r["id"] for r, _t in links], [r["id"] for r, _t in paid]]
case("hand_paid_never_takes_open_bills_payment", hand_paid_never_takes_open_bills_payment)

def same_day_payments_are_two():
    zem = lambda i, gbp: {"id": i, "fields": {"Account Alias (from **Account)": ["TNT Mgt Zempler"],
        "**GBP": gbp, "*Name": "Oakfield Roofing 3 Ash Road", "**Date": "2026-09-20"}}
    rows = [{"id": "r", "fields": {"Matched Transaction": ["s1"]}}]
    return [t["id"] for t in pr.unlisted_transfers([zem("s1", -80), zem("s2", -100)], rows)]
case("same_day_payments_are_two", same_day_payments_are_two)

def card_never_assumed_paid():
    early = txn("txEarly", "2026-10-01", -2.22, "Oakfield Ground Rents GR4471")
    action, c, d = pr.plan_tasks([task()], [], pr.index_by_amount([early]), D("2026-10-23"))[0]
    return [action, pr.task_row_fields(c, D("2026-10-23"), maybe_paid=d)["Status"]]
case("card_never_assumed_paid", card_never_assumed_paid)

def open_bill_named_by_house_wins():
    h = bill("recH", "2026-09-16", 90, "Brightwater Gas Ltd", Status="Paid",
             Description="LGSR, 22 Oak Road", **{"Paid Date": "2026-09-22"})
    links, paid, _p = pr.plan_all([h, gas], pr.index_by_amount([gas_tx]), "2026-09-01")
    return [[r["id"] for r, _t in links], [r["id"] for r, _t in paid]]
case("open_bill_named_by_house_wins", open_bill_named_by_house_wins)

def amount_line_beats_heading_part():
    return pr.parse_payment_card("MARK FOR PAYMENT: ground rent £1.11 + arrears £1.11\nAMOUNT: £2.22")["amount"]
case("amount_line_beats_heading_part", amount_line_beats_heading_part)

def late_approved_card_links_to_reminder():
    row = bill("recRem", "2026-09-20", 330, "Oakfield Alarms Ltd", **{"Gmail Message ID": "18a0f00dcafe0330"})
    t = {"id": "recFeb", "name": "Oakfield Alarms Ltd - 2 Ash Court", "created": "2026-02-18",
         "approved": "2026-09-25", "card": pr.parse_payment_card("MARK FOR PAYMENT — £330.00"),
         "refused": "", "text": "- email: #all/18a0f00dcafe0330"}
    return pr.plan_tasks([t], [row], {}, D("2026-09-25"))[0][0]
case("late_approved_card_links_to_reminder", late_approved_card_links_to_reminder)

def missed_friday_is_read():
    tz = pr.LONDON
    start, _ = pr.scan_range(datetime(2026, 9, 25, 21, 0, tzinfo=tz), 1,
                             datetime(2026, 9, 11, 21, 0, tzinfo=tz))
    return start.isoformat()
case("missed_friday_is_read", missed_friday_is_read)

print(json.dumps(out))
`;

function run() {
  const out = execFileSync('python3', ['-c', HARNESS, PY], { encoding: 'utf8' });
  return JSON.parse(out);
}

const R = run();
const value = (name) => {
  expect(R[name].ok, `${name} raised: ${R[name].error}`).toBe(true);
  return R[name].value;
};

describe('payment run: a paid bill leaves the list by itself (cause 1)', () => {
  it('a payee-corroborated payment marks the row Paid and links the transaction', () => {
    expect(value('paid_row_clears')).toEqual([['recGas', 'Paid', ['txGas']]]);
  });
  it('one bank payment settles one bill, never two of the same size', () => {
    expect(value('one_payment_one_bill')).toBe(1);
  });
  it('of two same-size bills from one payee, the one whose house the bank line names is paid', () => {
    expect(value('named_house_is_settled')).toEqual(['recB']);
  });
  it('a payee word inside another word ("city" in "electricity") never closes a bill', () => {
    expect(value('whole_words_only')).toBe(0);
  });
  it('a payment naming an open bill\'s house settles that bill, not a hand-paid twin', () => {
    expect(value('open_bill_named_by_house_wins')).toEqual([[], ['recGas']]);
  });
  it('a row marked paid by hand never takes a payment that names an open bill', () => {
    expect(value('hand_paid_never_takes_open_bills_payment')).toEqual([[], ['recGas']]);
  });
});

describe('payment run: approved payment cards reach the list (cause 2)', () => {
  it('a card waits, then lists on the Friday before it is due', () => {
    expect(value('card_lists_on_friday_before')).toEqual(['wait', 'create']);
  });
  it('a card listed on a Friday sits in the run to pay after the 9pm cutoff', () => {
    expect(value('card_on_friday_is_in_run_to_pay')).toEqual(['c']);
  });
  it('a card is read from its heading down, never from a summary above it', () => {
    expect(value('card_reads_below_its_heading')).toBe(100);
  });
  it('a card and the email it came from are one bill, not two', () => {
    expect(value('card_and_its_email_are_one_bill')).toBe('link');
  });
  it('a free-form card is listed, named after its task, amount from its heading', () => {
    expect(value('freeform_card_is_listed')).toEqual(['create', 'Oakfield Alarms Ltd', 330]);
  });
  it('the AMOUNT line\'s total beats a part named in the heading', () => {
    expect(value('amount_line_beats_heading_part')).toBe(2.22);
  });
  it('a card raised months ago but approved now links to this month\'s reminder email', () => {
    expect(value('late_approved_card_links_to_reminder')).toBe('link');
  });
  it('a card is never assumed paid: a possible payment is named on it, and it stays Unpaid', () => {
    expect(value('card_never_assumed_paid')).toEqual(['check_paid', 'Unpaid']);
  });
  it('a card without a real approval is refused', () => {
    expect(value('forged_approval_refused')).toBe('refused');
  });
});

describe('payment run: money out with no bill is reported (cause 3)', () => {
  it('reports an unlisted hand-made transfer, not card spends, debits or a bill about to settle', () => {
    expect(value('unlisted_transfer_reported')).toEqual(['t1']);
  });
  it('two same-day payments to one firm are two payments, not one split', () => {
    expect(value('same_day_payments_are_two')).toEqual(['s2']);
  });
});

describe('payment run: a missed Friday is read by the next one (cause 4)', () => {
  it('the scan starts from the last good run, less a day of overlap', () => {
    expect(value('missed_friday_is_read')).toBe('2026-09-10T21:00:00+01:00');
  });
});

describe('payment run selftest', () => {
  it('every offline check in the script passes', () => {
    const out = execFileSync('python3', [PY, 'selftest'], { encoding: 'utf8' });
    expect(out).toContain('all checks pass');
  });
});
