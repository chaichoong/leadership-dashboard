#!/usr/bin/env python3
"""cost-record.py: the gated door through which an agent changes or adds a fixed cost record.

WHY THIS EXISTS (9 Oct 2026, finding 20261007-agent-dispatch-789)
Kevin approved the Loom downgrade (Business + AI to Business, from 24 Oct 2026) on 7 Oct, and the
approved card said the robot would then update the Loom cost record. No command wrote the Costs
table, a direct Airtable write is refused to the robots, so the cost record stayed at the old price
and the task sat on a TOOL wall. This is the door, modelled on scripts/tenancy-record.py.

WIDENED (Kevin, 14 Oct 2026)
Every recurring cost goes in, with its end date when it has one, and a policy that has lapsed is
marked inactive, so the reports stay true. The door could only change Expected Cost. On 3 Oct a card
he approved promised a new insurance finance line whose last payment is 28 Jun 2027, and the row that
was added carries no End Date; the same day 7 costs past their End Date were still counted in Monthly
Costs. So: an End Date write, an Inactive write, a new cost, and a read-only list of counted costs
whose End Date has passed (which agent-dispatch.py turns into one task a day).

END DATE means the date of the LAST expected payment. The Airtable field is "Last Payment Date"; the
dashboard labels it End Date (js/config.js F.costEndDate). A new recurring cost always says its end:
a date, or "no end date".

WHAT A WRITE NEEDS
  * --task: an Airtable task Kevin approved EXACTLY "Approved as-is", with the marks only a real
    approval leaves (scripts/approval_evidence.py, through tenancy-record.py approval_problem).
    "Approved with minor edits" is refused: `agent-dispatch.py revise` rewrites the output after it,
    so a line there may not be the line he read.
  * The approved Agent Output (below the last Your step divider when a YOUR STEP block sits on top,
    tenancy-record.py approved_original) carries the exact line, each on its own line:
        RECORD CHANGE: <cost id> Expected Cost = <amount>
        RECORD CHANGE: <cost id> End Date = <YYYY-MM-DD>      (or "= none" to clear it: no end any more)
        RECORD CHANGE: <cost id> Payment Status = Inactive
        RECORD NEW COST: <name> | <amount> | <frequency> | due <day> | first <YYYY-MM-DD> | ends <YYYY-MM-DD>
        RECORD NEW COST: <name> | <amount> | <frequency> | due <day> | first <YYYY-MM-DD> | no end date
    and the command's own arguments must say the same thing.
  * A cost proven to be in the Costs table (a list read by RECORD_ID, never a GET by id, which
    ignores the table in the URL). Every linked id on a new cost is proven the same way in its table.

WHAT A WRITE DOES
  Writes the field (a Number or a date string, no typecast), reads it back from the table and fails
  loudly if it did not land, leaves a dated comment on the cost (what changed, from what, which task
  asked, why), and appends one line to LEDGER. A write whose comment then fails is said (exit 1),
  never undone. `inactive` sets both status fields (the LEGACY Payment Status every report filters on,
  CLAUDE.md, and Cost Status (New)) and refuses a cost with no End Date: an ended cost says when it
  ended. `new` creates one cost, In Payment, and refuses a name the table already holds; a re-run of
  the same approved create answers with the row it made.

WHAT IT NEVER DOES
  Write any other field: never a name, a due day, a frequency or an account on an existing cost, and
  never a status other than Inactive. Never deletes a cost. Moves no money.
  LIMIT, as for approval_evidence: every field is written with the token the agents hold, so a
  deliberate forgery still passes. This stops the lazy and the accidental route.

USAGE
  cost-record.py show COST                                      the record and its comments (read only)
  cost-record.py ended [--grace 5]                              counted costs past their End Date (read only)
  cost-record.py expected COST 16.36 --task T --why "..."       Expected Cost, on an approved line
  cost-record.py end COST 2027-06-28 --task T --why "..."       End Date (or none), on an approved line
  cost-record.py inactive COST --task T --why "..."             Payment Status Inactive, on an approved line
  cost-record.py new --name "..." --expected 31.27 --frequency Monthly --due-day 28 --first-payment 2026-10-28
      (--end-date 2027-06-28 | --no-end-date) [--like COST] [--business REC] [--category REC]
      [--sub-category REC] [--property REC ...] --task T --why "..."
      --like copies Business, Category, Sub-Category and Property from the cost this one replaces;
      an explicit flag wins over it.
  add --dry-run to a write to see the gate's answer and change nothing.
"""
import argparse
import importlib.util
import json
import os
import re
import sys
from datetime import datetime
from decimal import Decimal, InvalidOperation

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# tenancy-record.py's approval gate, reused rather than copied (one rule for both doors).
_spec = importlib.util.spec_from_file_location("tenancy_record_for_cost_record", os.path.join(HERE, "tenancy-record.py"))
tr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tr)
rc = tr.rc
Refused = tr.Refused

LEDGER = os.environ.get("COST_RECORD_LEDGER") or os.path.expanduser("~/knowledge-os/logs/cost-record/ledger.jsonl")

# js/config.js TABLES.costs / properties / categories / subCategories / businesses and the F.cost* field ids named
# beside each constant. tests/cost-record.test.js fails if these drift from config.js.
T_COSTS = "tblx5kvhzNEI5TFlS"
T_PROPERTIES = "tbl6f0OkAmTC2jbuG"
T_CATEGORIES = "tbleWb8ioptnEwPR8"
T_SUBCATEGORIES = "tblOTdRcPf8AgRz25"
T_BUSINESSES = "tblpqkvWJJo8Uu25q"
COST_NAME = "fldS6FYfpkhu6tJG0"              # F.costName
COST_EXPECTED = "fld9JibXkMpTeMcxw"          # F.costExpected
COST_DUE_DAY = "fld7IsfiGvKpxEwSs"           # F.costDueDay: singleSelect "1".."31", written only on a new cost
COST_PAY_STATUS = "fldXZNI96v8HgjuSh"        # F.costPayStatus: the LEGACY Payment Status every report filters on
COST_INACTIVE = "fldQJPGLFMbwVelsW"          # F.costInactive: read only
COST_END = "fldhTpqQsVAnHpTCz"               # F.costEndDate: "Last Payment Date", the dashboard's End Date
COST_STATUS_NEW = "fldWl7mp9zTC2aaaQ"        # F.costStatusNew: Cost Status (New)
COST_FREQUENCY = "fldvozTHvs5VH3lNi"         # F.costFrequency
COST_SUBCAT = "fldRO90pSCj6ahVMC"            # F.costSubCategory
COST_CATEGORY = "fldv3szZSuR2fWBFt"          # F.costCategory
COST_BUSINESS = "fldrPjvdFPCKWqeyd"          # F.costBusiness
COST_PROPERTY = "fld7nikJBPz3BoZJG"          # F.costProperty
COST_LAST_RECON = "fldeMdOxYemcJwVRD"        # F.costLastReconDate: read only, the evidence of a payment
COST_DUE_DATE = "fldmAaI8NSpBUjYQi"          # Due Date: the first payment (the airtable-cost-creator skill writes it)

# The live select options, read from the Airtable schema on 14 Oct 2026. No typecast, so a value outside these is
# refused by Airtable rather than added as a new option.
FREQUENCIES = ("Daily", "Weekly", "Monthly", "4-Weekly", "Fortnightly", "Quarterly", "Annually")
# MIRRORS isCostActive in js/shared.js: what every report counts. Inactive ticked, or any other status, is out.
ACTIVE_STATUSES = ("In Payment", "Overdue")
# A last instalment can land a few days after its End Date (a weekend, a bank holiday), so a cost is only listed as
# ended once this many days have passed.
ENDED_GRACE_DAYS = 5

# One line each: [ \t] never crosses a line break, so a value can never be read off the next line (review, 14 Oct
# 2026: "End Date =" then "none" on its own line would otherwise clear a date).
CHANGE_RE = re.compile(r"^RECORD CHANGE:[ \t]*(?P<cost>rec[A-Za-z0-9]{14})[ \t]+"
                       r"(?P<label>Expected Cost|End Date|Payment Status)[ \t]*=[ \t]*(?P<value>[^\n]+?)[ \t]*$", re.M)
NEW_RE = re.compile(r"^RECORD NEW COST:[ \t]*(?P<body>[^\n]+?)[ \t]*$", re.M)
# Up to £9,999,999.99, with or without thousands commas; a leading zero group ("0,500") is not an amount.
AMOUNT_RE = re.compile(r"^(?:£|GBP)?\s*((?:[1-9]\d{0,2},\d{3}|[1-9],\d{3},\d{3}|\d{1,7})(?:\.\d{1,2})?)$", re.I)
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def amount(text):
    """A pounds amount as a Decimal to the penny, or None: '16.36', '£16.36', '£ 16.36' and 'GBP 16.36' read the
    same, and '£1,234.50' is 1234.50 (an annual premium is written with its comma)."""
    m = AMOUNT_RE.match(" ".join(str(text or "").split()))
    if not m:
        return None
    try:
        return Decimal(m.group(1).replace(",", "")).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None


def day(text):
    """A YYYY-MM-DD string for a real calendar date, or None."""
    t = str(text or "").strip()
    return t if DAY_RE.match(t) and rc.parse_day(t) else None


def squash(text):
    return " ".join(str(text or "").split())


def name_key(text):
    """Two cost names are the same cost when they match ignoring case and spacing."""
    return squash(text).casefold()


def load_cost(cost_id):
    if not tr.REC_RE.fullmatch(cost_id or ""):
        raise Refused(f"{cost_id!r} is not a record id")
    row = tr._one(T_COSTS, cost_id)
    if not row:
        raise Refused(f"{cost_id} is not a cost (no row with that id in the Costs table)")
    return row


def approved_lines(task):
    """The approved card's text, or Refused: Kevin approved this task for real, and approved it as-is."""
    f = task.get("fields") or {}
    why = tr.approval_problem(task)
    if why:
        raise Refused(why)
    outcome = rc.sel(f.get(tr.TK["approvalOutcome"]))
    if outcome != "Approved as-is":
        raise Refused(f"task {task['id']} was {outcome}, not Approved as-is: after an edit the card may not say what "
                      "he read, so put the change on a fresh card")
    return tr.approved_original(f.get(tr.TK["agentOutput"]))


def same_value(label, card_value, value):
    if label == "Expected Cost":
        return amount(card_value) == value
    if label == "End Date":
        return (day(card_value) or ("none" if squash(card_value).casefold() == "none" else None)) == value
    return squash(card_value) == value


def change_problem(task, cost_id, label, value):
    """'' when Kevin approved THIS change to THIS cost on this task, as-is, else why not."""
    try:
        text = approved_lines(task)
    except Refused as e:
        return str(e)
    for m in CHANGE_RE.finditer(text):
        if m.group("cost") == cost_id and m.group("label") == label and same_value(label, m.group("value"), value):
            return ""
    return (f"the card Kevin approved (task {task['id']}) has no line 'RECORD CHANGE: {cost_id} {label} = {value}': "
            "put the change on a card for him to approve (one tap)")


def parse_new_line(body):
    """The six parts of a RECORD NEW COST line as a dict, or None when the line is not that shape."""
    parts = [squash(p) for p in body.split("|")]
    if len(parts) != 6 or not parts[0]:
        return None
    freq = next((f for f in FREQUENCIES if f.casefold() == parts[2].casefold()), None)
    due = re.fullmatch(r"due (\d{1,2})", parts[3], re.I)
    first = re.fullmatch(r"first (\S+)", parts[4], re.I)
    if parts[5].casefold() == "no end date":
        end = ""
    else:
        m = re.fullmatch(r"ends (\S+)", parts[5], re.I)
        end = day(m.group(1)) if m else None
    if amount(parts[1]) is None or not freq or not due or not first or not day(first.group(1)) or end is None:
        return None
    return {"name": parts[0], "expected": amount(parts[1]), "frequency": freq, "dueDay": int(due.group(1)),
            "first": day(first.group(1)), "end": end}


def new_line(spec):
    """The card line that approves `spec`, written the way Kevin reads it."""
    end = f"ends {spec['end']}" if spec["end"] else "no end date"
    return (f"RECORD NEW COST: {spec['name']} | {spec['expected']} | {spec['frequency']} | due {spec['dueDay']} | "
            f"first {spec['first']} | {end}")


def new_problem(task, spec):
    """'' when Kevin approved THIS new cost on this task, as-is, else why not."""
    try:
        text = approved_lines(task)
    except Refused as e:
        return str(e)
    for m in NEW_RE.finditer(text):
        card = parse_new_line(m.group("body"))
        if card and name_key(card["name"]) == name_key(spec["name"]) and all(
                card[k] == spec[k] for k in ("expected", "frequency", "dueDay", "first", "end")):
            return ""
    return (f"the card Kevin approved (task {task['id']}) has no line '{new_line(spec)}': put the new cost on a card "
            "for him to approve (one tap)")


def is_active(fields):
    """MIRRORS isCostActive in js/shared.js: Inactive unticked and Payment Status In Payment or Overdue."""
    return not fields.get(COST_INACTIVE) and rc.sel(fields.get(COST_PAY_STATUS)) in ACTIVE_STATUSES


def ended_costs(rows, today, grace=ENDED_GRACE_DAYS):
    """The costs every report still counts whose End Date passed more than `grace` days before `today`.

    Listed for a person or an agent to judge, never dropped by rule: a payment after the End Date usually means the
    cost renewed and its End Date is stale (3 of the 7 found on 14 Oct 2026 were still being paid). A payment inside
    the grace is the last instalment landing late, not a renewal (4 of the 7 were paid a day after their End Date)."""
    out = []
    for r in rows:
        f = r.get("fields") or {}
        end = rc.parse_day(f.get(COST_END))
        if not is_active(f) or end is None or (today - end).days <= grace:
            continue
        last = rc.parse_day(f.get(COST_LAST_RECON))
        out.append({"cost": r["id"], "name": squash(f.get(COST_NAME)), "expectedCost": f.get(COST_EXPECTED),
                    "paymentStatus": rc.sel(f.get(COST_PAY_STATUS)), "endDate": end.isoformat(),
                    "lastPayment": last.isoformat() if last else None,
                    "paidAfterEnd": bool(last and (last - end).days > grace)})
    return sorted(out, key=lambda x: (x["endDate"], x["name"]))


def stamp():
    return datetime.now(rc.LONDON).strftime("%d %b %Y %H:%M")


def money(v):
    return "blank" if v in (None, "") else f"£{Decimal(str(v)).quantize(Decimal('0.01'))}"


def ledger(row):
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    with open(LEDGER, "a") as fh:
        fh.write(json.dumps(dict(row, at=datetime.now(rc.LONDON).isoformat(timespec="seconds"))) + "\n")


def comment(cost_id, text, out):
    """The dated comment on the cost. The write stands if it fails; the failure is said (exit 1)."""
    try:
        rc.api("POST", f"{T_COSTS}/{cost_id}/comments", {"text": text})
        out["commented"] = True
    except Exception as e:                                   # noqa: BLE001 — the write stands; said loudly
        out["commentProblem"] = f"the cost was written but its comment failed: {str(e)[:200]}"
    return out


def why_text(a):
    return " ".join(a.why.split())


# ─── commands ────────────────────────────────────────────────────────
def cmd_show(a):
    c = load_cost(a.cost)
    f = c.get("fields") or {}
    comments = rc.api("GET", f"{T_COSTS}/{a.cost}/comments", params={"pageSize": 100}).get("comments") or []
    return {"cost": a.cost, "name": f.get(COST_NAME), "expectedCost": f.get(COST_EXPECTED),
            "dueDay": rc.sel(f.get(COST_DUE_DAY)), "paymentStatus": rc.sel(f.get(COST_PAY_STATUS)),
            "inactive": bool(f.get(COST_INACTIVE)), "endDate": f.get(COST_END),
            "lastPayment": f.get(COST_LAST_RECON), "frequency": rc.sel(f.get(COST_FREQUENCY)),
            "businessIds": f.get(COST_BUSINESS) or [], "categoryIds": f.get(COST_CATEGORY) or [],
            "subCategoryIds": f.get(COST_SUBCAT) or [], "propertyIds": f.get(COST_PROPERTY) or [],
            "comments": [{"at": x.get("createdTime"), "text": x.get("text")} for x in comments]}


def cmd_ended(a):
    rows = rc.fetch_all(T_COSTS, {"fields[]": [COST_NAME, COST_EXPECTED, COST_PAY_STATUS, COST_INACTIVE, COST_END,
                                               COST_LAST_RECON]})
    active = sum(1 for r in rows if is_active(r.get("fields") or {}))
    if not active:
        # 91 were counted on 14 Oct 2026. Zero is a broken read or a renamed status, never an empty business.
        raise RuntimeError(f"control failed: {len(rows)} costs read and none counted as active; the read or the "
                           "active rule is broken, so nothing can be said about ended costs")
    found = ended_costs(rows, rc.today_london(), a.grace)
    return {"activeCosts": active, "graceDays": a.grace, "ended": found,
            "monthlyStillCounted": float(sum(Decimal(str(x["expectedCost"] or 0)) for x in found))}


def cmd_expected(a):
    value = amount(a.value)
    if value is None or value <= 0:
        raise Refused(f"Expected Cost must be a pounds amount above zero, like 16.36, not {a.value!r}")
    cost, task = load_cost(a.cost), tr.load_task(a.task)
    why = change_problem(task, a.cost, "Expected Cost", value)
    if why:
        raise Refused(why)
    before = (cost.get("fields") or {}).get(COST_EXPECTED)
    out = {"cost": a.cost, "name": (cost.get("fields") or {}).get(COST_NAME), "field": "Expected Cost",
           "from": money(before), "to": money(value), "task": task["id"]}
    if before not in (None, "") and Decimal(str(before)).quantize(Decimal("0.01")) == value:
        return dict(out, unchanged=True, note=f"Expected Cost already reads {money(value)}; nothing written")
    if a.dry_run:
        return dict(out, dryRun=True)
    # A Number, never a string, and no typecast (CLAUDE.md: PATCH typecast lesson).
    rc.api("PATCH", f"{T_COSTS}/{a.cost}", {"fields": {COST_EXPECTED: float(value)}})
    after = (load_cost(a.cost).get("fields") or {}).get(COST_EXPECTED)
    if after in (None, "") or Decimal(str(after)).quantize(Decimal("0.01")) != value:
        ledger(dict(out, kind="unlanded"))
        raise RuntimeError(f"Expected Cost on {a.cost} reads {after!r} after writing {value}: the write did not land")
    ledger(dict(out, kind="write", why=a.why))
    return comment(a.cost, f"{stamp()}: Expected Cost changed from {money(before)} to {money(value)} by an agent, on "
                           f"the RECORD CHANGE line of the card Kevin approved, task {task['id']} "
                           f"({tr.task_label(task)}). Why: {why_text(a)}", out)


def cmd_end(a):
    # "none" clears the date: a contract that rolls on after its minimum term, or a cost Kevin keeps, would
    # otherwise sit on the daily ended-costs list for ever (review, 14 Oct 2026).
    value = "none" if squash(a.value).casefold() == "none" else day(a.value)
    if not value:
        raise Refused(f"End Date must be a real date written YYYY-MM-DD (the date of the last payment), or none, "
                      f"not {a.value!r}")
    cost, task = load_cost(a.cost), tr.load_task(a.task)
    why = change_problem(task, a.cost, "End Date", value)
    if why:
        raise Refused(why)
    before = (cost.get("fields") or {}).get(COST_END) or None
    out = {"cost": a.cost, "name": (cost.get("fields") or {}).get(COST_NAME), "field": "End Date",
           "from": before or "blank", "to": value, "task": task["id"]}
    if (before or "none") == value:
        return dict(out, unchanged=True, note=f"End Date already reads {value}; nothing written")
    if a.dry_run:
        return dict(out, dryRun=True)
    rc.api("PATCH", f"{T_COSTS}/{a.cost}", {"fields": {COST_END: None if value == "none" else value}})
    after = (load_cost(a.cost).get("fields") or {}).get(COST_END) or "none"
    if after != value:
        ledger(dict(out, kind="unlanded"))
        raise RuntimeError(f"End Date on {a.cost} reads {after!r} after writing {value}: the write did not land")
    ledger(dict(out, kind="write", why=a.why))
    return comment(a.cost, f"{stamp()}: End Date (the last payment) changed from {before or 'blank'} to "
                           f"{'blank (no end date)' if value == 'none' else value} by an "
                           f"agent, on the RECORD CHANGE line of the card Kevin approved, task {task['id']} "
                           f"({tr.task_label(task)}). Why: {why_text(a)}", out)


def cmd_inactive(a):
    cost, task = load_cost(a.cost), tr.load_task(a.task)
    why = change_problem(task, a.cost, "Payment Status", "Inactive")
    if why:
        raise Refused(why)
    f = cost.get("fields") or {}
    before = (rc.sel(f.get(COST_PAY_STATUS)) or "blank", rc.sel(f.get(COST_STATUS_NEW)) or "blank")
    out = {"cost": a.cost, "name": f.get(COST_NAME), "field": "Payment Status", "from": before[0], "to": "Inactive",
           "task": task["id"]}
    if before == ("Inactive", "Inactive"):
        return dict(out, unchanged=True, note="Payment Status already reads Inactive; nothing written")
    if not f.get(COST_END):
        raise Refused(f"{a.cost} has no End Date: an ended cost says when its last payment was. Put "
                      f"'RECORD CHANGE: {a.cost} End Date = YYYY-MM-DD' on the card and run `end` first")
    if a.dry_run:
        return dict(out, dryRun=True)
    rc.api("PATCH", f"{T_COSTS}/{a.cost}", {"fields": {COST_PAY_STATUS: "Inactive", COST_STATUS_NEW: "Inactive"}})
    g = load_cost(a.cost).get("fields") or {}
    after = (rc.sel(g.get(COST_PAY_STATUS)), rc.sel(g.get(COST_STATUS_NEW)))
    if after != ("Inactive", "Inactive"):
        ledger(dict(out, kind="unlanded"))
        raise RuntimeError(f"{a.cost} reads Payment Status {after[0]!r}, Cost Status (New) {after[1]!r} after writing "
                           "Inactive: the write did not land")
    ledger(dict(out, kind="write", why=a.why))
    return comment(a.cost, f"{stamp()}: marked Inactive (was {before[0]}; last payment {f.get(COST_END)}) by an "
                           f"agent, on the RECORD CHANGE line of the card Kevin approved, task {task['id']} "
                           f"({tr.task_label(task)}). Why: {why_text(a)}", out)


def proven_links(table, ids, label):
    """The ids, each proven to be a record of `table`, or Refused."""
    for rid in ids:
        if not tr.REC_RE.fullmatch(rid or "") or not tr._one(table, rid):
            raise Refused(f"--{label} {rid!r} is not a record in its table ({table})")
    return list(ids)


def cmd_new(a):
    expected = amount(a.expected)
    if expected is None or expected <= 0:
        raise Refused(f"--expected must be a pounds amount above zero, like 31.27, not {a.expected!r}")
    freq = next((f for f in FREQUENCIES if f.casefold() == str(a.frequency).casefold()), None)
    if not freq:
        raise Refused(f"--frequency must be one of {', '.join(FREQUENCIES)}, not {a.frequency!r}")
    if not 1 <= a.due_day <= 31:
        raise Refused(f"--due-day must be a day of the month, 1 to 31, not {a.due_day}")
    first = day(a.first_payment)
    if not first:
        raise Refused(f"--first-payment must be a real date written YYYY-MM-DD, not {a.first_payment!r}")
    if a.no_end_date == bool(a.end_date):
        raise Refused("say how the cost ends: --end-date YYYY-MM-DD (the last payment) or --no-end-date, one of them")
    end = "" if a.no_end_date else day(a.end_date)
    if end is None:
        raise Refused(f"--end-date must be a real date written YYYY-MM-DD, not {a.end_date!r}")
    if end and end < first:
        raise Refused(f"the last payment ({end}) is before the first ({first})")
    name = squash(a.name)
    if not name or "|" in name:
        raise Refused("--name must be the cost's name, without a '|'")
    spec = {"name": name, "expected": expected, "frequency": freq, "dueDay": a.due_day, "first": first, "end": end}
    task = tr.load_task(a.task)
    why = new_problem(task, spec)
    if why:
        raise Refused(why)
    like = (load_cost(a.like).get("fields") or {}) if a.like else {}
    links = {
        COST_BUSINESS: proven_links(T_BUSINESSES, [a.business] if a.business else like.get(COST_BUSINESS) or [],
                                    "business"),
        COST_CATEGORY: proven_links(T_CATEGORIES, [a.category] if a.category else like.get(COST_CATEGORY) or [],
                                    "category"),
        COST_SUBCAT: proven_links(T_SUBCATEGORIES,
                                  [a.sub_category] if a.sub_category else like.get(COST_SUBCAT) or [], "sub-category"),
        COST_PROPERTY: proven_links(T_PROPERTIES, a.property or like.get(COST_PROPERTY) or [], "property"),
    }
    missing = [n for n, k in (("business", COST_BUSINESS), ("category", COST_CATEGORY),
                              ("sub-category", COST_SUBCAT)) if not links[k]]
    if missing:
        raise Refused(f"a new cost needs its {', '.join(missing)} (every report groups by them): pass the flag, or "
                      "--like the cost this one replaces")
    out = {"name": name, "expectedCost": money(expected), "frequency": freq, "dueDay": a.due_day,
           "firstPayment": first, "endDate": end or "no end date", "task": task["id"],
           "links": {"business": links[COST_BUSINESS], "category": links[COST_CATEGORY],
                     "subCategory": links[COST_SUBCAT], "property": links[COST_PROPERTY]}}
    # A re-run of a create that landed answers with the row it made, even if that row was renamed since: the
    # ledger is read before the names (review, 14 Oct 2026).
    rows = rc.fetch_all(T_COSTS, {"fields[]": [COST_NAME]})
    ids = {r["id"] for r in rows}
    made = [x for x in read_ledger() if x.get("kind") == "create" and x.get("task") == task["id"]
            and name_key(x.get("name")) == name_key(name) and x.get("cost") in ids]
    if made:
        spec_keys = ("expectedCost", "frequency", "dueDay", "firstPayment", "endDate")
        if all(made[-1].get(k) == out[k] for k in spec_keys):
            return dict(out, cost=made[-1]["cost"], unchanged=True,
                        note=f"this card's cost already exists as {made[-1]['cost']}")
        # A second approval on the same task for different terms is a change to the row already made, never a
        # silent "unchanged" (review round 2, 14 Oct 2026).
        raise Refused(f"this task already created {made[-1]['cost']} as "
                      f"{', '.join(str(made[-1].get(k)) for k in spec_keys)}: a different amount, day or end is a "
                      f"RECORD CHANGE line for {made[-1]['cost']}, not a second create")
    same = [r for r in rows if name_key((r.get("fields") or {}).get(COST_NAME)) == name_key(name)]
    if same:
        raise Refused(f"a cost named {name!r} already exists ({', '.join(r['id'] for r in same)}): change that "
                      "record instead, or give the new one its own name (a policy number tells two apart)")
    if a.dry_run:
        return dict(out, dryRun=True)
    fields = {COST_NAME: name, COST_EXPECTED: float(expected), COST_FREQUENCY: freq, COST_DUE_DAY: str(a.due_day),
              COST_DUE_DATE: first, COST_PAY_STATUS: "In Payment", COST_STATUS_NEW: "In Payment",
              **{k: v for k, v in links.items() if v}}
    if end:
        fields[COST_END] = end
    made = rc.api("POST", T_COSTS, {"fields": fields})
    cost_id = made.get("id") or ""
    if not tr.REC_RE.fullmatch(cost_id):
        ledger(dict(out, kind="unlanded"))
        raise RuntimeError(f"the create returned no record id ({str(made)[:200]}): the cost may not exist")
    out["cost"] = cost_id
    g = (tr._one(T_COSTS, cost_id) or {}).get("fields") or {}
    read = (squash(g.get(COST_NAME)), amount(g.get(COST_EXPECTED)), rc.sel(g.get(COST_FREQUENCY)),
            rc.sel(g.get(COST_DUE_DAY)), g.get(COST_END) or "", rc.sel(g.get(COST_PAY_STATUS)))
    if read != (name, expected, freq, str(a.due_day), end, "In Payment"):
        ledger(dict(out, kind="unlanded"))
        raise RuntimeError(f"{cost_id} reads {read!r} after the create: the write did not land as approved")
    ledger(dict(out, kind="create", why=a.why))
    return comment(cost_id, f"{stamp()}: created by an agent ({money(expected)} {freq}, due {a.due_day}, first payment "
                            f"{first}, last payment {end or 'none set: no end date'}), on the RECORD NEW COST line of "
                            f"the card Kevin approved, task {task['id']} ({tr.task_label(task)}). Why: {why_text(a)}",
                   out)


def read_ledger():
    try:
        with open(LEDGER) as fh:
            return [json.loads(ln) for ln in fh if ln.strip()]
    except (OSError, ValueError):
        return []


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("show")
    s.add_argument("cost")
    n = sub.add_parser("ended")
    n.add_argument("--grace", type=int, default=ENDED_GRACE_DAYS)

    def write(name, *positional):
        p = sub.add_parser(name)
        for arg in positional:
            p.add_argument(arg)
        p.add_argument("--task", required=True)
        p.add_argument("--why", required=True, help="Kevin's words, or the fact from the task, in one sentence")
        p.add_argument("--dry-run", action="store_true")
        return p

    write("expected", "cost", "value")
    write("end", "cost", "value")
    write("inactive", "cost")
    w = write("new")
    w.add_argument("--name", required=True)
    w.add_argument("--expected", required=True)
    w.add_argument("--frequency", required=True)
    w.add_argument("--due-day", type=int, required=True)
    w.add_argument("--first-payment", required=True)
    w.add_argument("--end-date")
    w.add_argument("--no-end-date", action="store_true")
    w.add_argument("--like")
    w.add_argument("--business")
    w.add_argument("--category")
    w.add_argument("--sub-category")
    w.add_argument("--property", action="append")
    a = ap.parse_args(argv)
    if getattr(a, "why", None) is not None and len(" ".join(a.why.split())) < 10:
        print(json.dumps({"refused": "--why needs the reason in a sentence"}))
        return 2
    try:
        out = {"show": cmd_show, "ended": cmd_ended, "expected": cmd_expected, "end": cmd_end,
               "inactive": cmd_inactive, "new": cmd_new}[a.cmd](a)
    except Refused as e:
        print(json.dumps({"refused": str(e)}))
        return 2
    except RuntimeError as e:
        print(json.dumps({"failed": str(e)[:400]}))
        return 1
    print(json.dumps(out, indent=2, default=str))
    return 1 if out.get("commentProblem") else 0


if __name__ == "__main__":
    sys.exit(main())
