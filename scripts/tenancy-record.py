#!/usr/bin/env python3
"""tenancy-record.py: the ONE door through which an agent changes a tenancy record.

WHY THIS EXISTS (9 Oct 2026, Kevin's /fix "the cash flow voids details are not updating")
The Cash Flow Voids agent's file said "Never: ... writing to a tenancy or tenant record", and no
other agent owned the job. So every ruling Kevin gave at the approval gate that needed a record
changed went nowhere: 30 Burnbank Gardens stayed a cash flow void after "not a cash flow void, that
needs updating" (6 Oct), Duckworth Apartments 8 and 9 kept the 4th after he approved the 9th
(7 Oct), and a tenant's death (8 Oct) was on no record. Each time the agent filed a code fix, the
findings queue was over its cap, and the fix went to an overflow log nothing works.

Kevin ruled on 9 Oct 2026: the Cash Flow Voids agent OWNS tenancy-record upkeep, through one gated
door, never a card per change (memory project_cfv_owns_tenancy_records_2026-10-09). This is it.

WHAT EVERY WRITE NEEDS
  * --task: an Airtable task about this tenancy. That task is the reason, and it is cited on the
    tenancy. A comment may name the tenancy anywhere on the task.
  * A FIELD change needs Kevin's approval OF THAT CHANGE (independent review, 9 Oct 2026: an
    approval of something else, or an id the agent typed onto a task, must never be enough):
    the card he approved AS-IS (Approval Outcome exactly "Approved as-is", with the marks only a
    real approval leaves, scripts/approval_evidence.py) carries the exact line
        RECORD CHANGE: <tenancy id> <Payment Status|Due Day|Set-off> = <value>
    (a set-off's value is "YYYY-MM-DD to YYYY-MM-DD"), or for a move-in and a rent change
        RECORD CHANGE: <agreement's Gmail id> Onboard = unit <rental unit> (<its Rental Unit name>), due <N>, <type>,
            <email>[, replace <tenancy> (<its Unit Reference>)]   (one line; each name read back from its record)
        RECORD CHANGE: <old tenancy id> Rent change = <agreement's Gmail id>
    and the command's own arguments must be exactly what that line says.
    The agent proposes the change on the card, in plain words too; his approval carries it out.
    Only "as-is": `agent-dispatch.py revise` rewrites the output after an "Approved with minor
    edits", so a line there may not be the line he read, and his edit may have changed it.
    A ruling he writes in a note ("it's not a cash flow void, that needs updating") becomes a
    one-tap card stating the exact change. Reading intent out of free text was tried and
    refused in review: "he is not paying" read as a yes to In Payment.
    LIMIT, as for approval_evidence: every field is written with the token the agents hold, so a
    deliberate forgery still passes. This stops the lazy and the accidental route.
  * A tenancy proven to be in the Tenancies table (a list read by RECORD_ID, never a GET by id,
    which ignores the table in the URL).

WHAT EVERY WRITE DOES
  Writes the one field, reads it back from the table, and fails loudly if the value did not land;
  leaves a dated comment on the tenancy saying what changed, from what, and which task asked; and
  appends one line to LEDGER. A write whose comment then fails is said (exit 1), never undone.

WHAT IT NEVER DOES
  Void a unit, edit a rent (a rent change is a NEW tenancy: Kevin, 5 Oct 2026), or write any field not
  listed here. Payment Status takes only In Payment, CFV or CFV Actioned: voiding has its own
  six-question gate (airtable-tenancy-ender skill). It ends a tenancy, creates a tenancy or a tenant, or
  touches a tenant record ONLY in onboard and rent-change below.

THE MOVE-IN AND RENT-CHANGE DOORS (onboard, rent-change; Kevin's rulings of 2, 5 and 9 Oct 2026)
  Only on the `TENANCY RECORD:` task the rent check raised (scripts/rent_signed_check.py), approved by Kevin
  AS-IS with its RECORD CHANGE line, and only with the agreement's facts THE RENT CHECK read off the signed PDF
  (its cache, keyed by the task's own Gmail message id), which must equal the task's AGREEMENT lines: never a
  name, rent or start the agent typed. Both re-check that the agreement is still unrecorded before writing.
  onboard: a new tenant is onboarded once the AST is signed (9 Oct). A NEW tenant and a NEW tenancy at the
    agreement's rent and start, Payment Status CFV (2 Oct). Refuses a unit at another house, a tenant already on
    record (except the one its own earlier run created before its tenancy failed: the ledger keys it by the
    agreement), an agreement naming two people, and an occupied unit unless the Onboard line says `replace` that
    live tenancy: it is then taken off the unit and left live, and its tenant's Current Unit cleared.
  rent-change: a NEW tenancy from the agreement's start, keeping the old one's Payment Status; the old one ended
    the day before; its payments from the new start and its open tasks moved; the tenant and the unit untouched
    (5 Oct). A re-run refuses once a tenancy with that tenant, start and rent exists. An end that fails after the
    create is said (exit 1) and never creates again.
  Billing Year is set when the start's year is one of its choices, else left blank and said (no typecast).

USAGE
  tenancy-record.py show TENANCY                          the record and its comments (read only)
  tenancy-record.py comment TENANCY --task T --text "..." a dated comment (no approval needed)
  tenancy-record.py status TENANCY "In Payment" --task T  Payment Status (Unified)
  tenancy-record.py due-day TENANCY 9 --task T            Due Day of Month
  tenancy-record.py set-off TENANCY --from D --until D --task T
                                                          rent a letting agent keeps against our bill
                                                          counts as PAID for whole rent periods from D
                                                          (a due date) to D (the day before one)
  tenancy-record.py onboard --task T --unit RU --due-day N --type "Universal Credit" --email E [--replace TENANCY]
                                                          a NEW tenant from a signed agreement
  tenancy-record.py rent-change OLD --task T              a continuing tenant's new rent = a NEW tenancy
  add --dry-run to any write to see the gate's answer and change nothing.
"""
import argparse
import importlib.util
import json
import os
import re
import sys
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from approval_evidence import approval_evidence_problem  # noqa: E402

_spec = importlib.util.spec_from_file_location("rent_check_for_tenancy_record", os.path.join(HERE, "rent-check.py"))
rc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rc)

LEDGER = os.environ.get("TENANCY_RECORD_LEDGER") or os.path.expanduser(
    "~/knowledge-os/logs/tenancy-record/ledger.jsonl")

# Tenancies fields this door may write, by field id (js/config.js F.tenPayStatus, F.tenDueDay).
PAY_STATUS, DUE_DAY = rc.TY["payStatus"], rc.TY["dueDay"]
SET_OFF_FROM, SET_OFF_UNTIL = rc.TY["setOffFrom"], rc.TY["setOffUntil"]   # js/config.js F.tenSetOffFrom / Until
STATUSES = ("In Payment", "CFV", "CFV Actioned")
REF = "fldyNVvFn4x8GY14q"            # Tenancy Reference (js/config.js F.tenRef), for the message only
# Tasks fields (scripts/agent-dispatch.py AF; scripts/approval_evidence.py).
TK = dict(rc.TK, agentOutput="fldzswp8fx6PqpLQ5", approvalOutcome="fldrHBSr6qoUfaKuZ",
          approvalFeedback="fldtI7SJI4gEohHD1", feedbackHistory="fldOzsq68lhfprKJu")
REC_RE = re.compile(r"rec[A-Za-z0-9]{14}")
# The subject of a change is a tenancy, or for Onboard the agreement's Gmail message id (16 hex characters).
CHANGE_RE = re.compile(r"^RECORD CHANGE:\s*(?P<tenancy>rec[A-Za-z0-9]{14}|[0-9a-f]{12,24})\s+"
                       r"(?P<label>Payment Status|Due Day|Set-off|Onboard|Rent change)\s*=\s*(?P<value>[^\n]+?)\s*$", re.M)
# Kept identical to scripts/agent-dispatch.py (tests/tenancy-record.test.js reads both). `block --kind KEVIN --steps`
# puts agent-written steps ON TOP of an approved card's Agent Output and keeps the approval (review round 3,
# 9 Oct 2026): only the original below the LAST divider is what Kevin approved.
YOUR_STEP_MARK = "YOUR STEP:"
YOUR_STEP_DIVIDER = "----- The agent's work, as you approved it -----"


class Refused(Exception):
    """The gate said no. Printed as {"refused": why}, exit 2: a result, never worked round."""


def _one(table, rec_id, fields=None):
    """The record, read through a list on its table, or None. A GET by id would find a record of
    another table too; a list filter on this table cannot."""
    params = {"filterByFormula": f"RECORD_ID()='{rec_id}'"}
    if fields:
        params["fields[]"] = fields
    rows = rc.fetch_all(table, params)
    return rows[0] if rows else None


def load_tenancy(tenancy_id):
    if not REC_RE.fullmatch(tenancy_id or ""):
        raise Refused(f"{tenancy_id!r} is not a record id")
    row = _one(rc.T_TENANCIES, tenancy_id)
    if not row:
        raise Refused(f"{tenancy_id} is not a tenancy (no row with that id in the Tenancies table)")
    return row


def load_task(task_id):
    if not REC_RE.fullmatch(task_id or ""):
        raise Refused(f"--task {task_id!r} is not a record id")
    row = _one(rc.T_TASKS, task_id)
    if not row:
        raise Refused(f"--task {task_id} is not a task (no row with that id in the Tasks table)")
    return row


def names_tenancy(task_fields, tenancy_id):
    """True when the task is about this tenancy, for a COMMENT: linked to it, or its id anywhere on the task."""
    if tenancy_id in (task_fields.get(TK["tenancies"]) or []):
        return True
    text = " ".join(str(task_fields.get(TK[k]) or "") for k in
                    ("name", "description", "notes", "agentOutput", "approvalFeedback", "feedbackHistory"))
    return tenancy_id in text


def approved_original(output):
    """The part of the Agent Output Kevin approved: below the last Your step divider when a YOUR STEP block sits on
    top (its steps are agent-written after his approval), and nothing at all for a block with no divider."""
    s = str(output or "")
    if not s.lstrip().startswith(YOUR_STEP_MARK):
        return s
    return s.rsplit(YOUR_STEP_DIVIDER, 1)[1] if YOUR_STEP_DIVIDER in s else ""


def change_problem(task, tenancy_id, label, value):
    """'' when Kevin approved THIS change to THIS tenancy on this task, as-is, else why not."""
    f = task.get("fields") or {}
    why = approval_problem(task)
    if why:
        return why
    outcome = rc.sel(f.get(TK["approvalOutcome"]))
    if outcome != "Approved as-is":
        return (f"task {task['id']} was {outcome}, not Approved as-is: after an edit the card may not say what he read, "
                "so put the change on a fresh card")
    for m in CHANGE_RE.finditer(approved_original(f.get(TK["agentOutput"]))):
        if m.group("tenancy") == tenancy_id and m.group("label") == label and m.group("value").strip() == str(value):
            return ""
    return (f"the card Kevin approved (task {task['id']}) has no line 'RECORD CHANGE: {tenancy_id} {label} = {value}': "
            "put the change on a card for him to approve (one tap)")


def approval_problem(task):
    """'' when Kevin approved this task for real, else why not."""
    f = task.get("fields") or {}
    outcome = rc.sel(f.get(TK["approvalOutcome"]))
    if not outcome.startswith("Approved"):
        return (f"Kevin has not approved task {task['id']} (Approval Outcome: {outcome or 'blank'}); "
                "a record change needs his approval on the task that asks for it")
    return approval_evidence_problem(f, task.get("createdTime"))


def gate(tenancy_id, task_id, change=None):
    """The tenancy and the task, or Refused. `change` is (label, value) for a field change."""
    tenancy, task = load_tenancy(tenancy_id), load_task(task_id)
    if change is None:
        if not names_tenancy(task.get("fields") or {}, tenancy_id):
            raise Refused(f"task {task_id} does not name tenancy {tenancy_id} (no Tenancies link and the id is "
                          "not written on it), so it cannot be the reason for a comment on that record")
        return tenancy, task
    why = change_problem(task, tenancy_id, *change)
    if why:
        raise Refused(why)
    return tenancy, task


def ended(tenancy):
    end = rc.parse_day((tenancy.get("fields") or {}).get(rc.TY["end"]))
    return end is not None and end < rc.today_london()


def stamp():
    return datetime.now(rc.LONDON).strftime("%d %b %Y %H:%M")


def task_label(task):
    return " ".join(str((task.get("fields") or {}).get(TK["name"]) or "").split())[:90]


def post_comment(tenancy_id, text):
    return rc.api("POST", f"{rc.T_TENANCIES}/{tenancy_id}/comments", {"text": text})


def ledger(row):
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    with open(LEDGER, "a") as fh:
        fh.write(json.dumps(dict(row, at=datetime.now(rc.LONDON).isoformat(timespec="seconds"))) + "\n")


def write_field(tenancy_id, field, value, label, task, why, dry_run):
    """Write one field, prove it landed, comment, log. Returns the result dict."""
    before = (load_tenancy(tenancy_id).get("fields") or {}).get(field)
    shown_before = rc.sel(before) if before not in (None, "") else "blank"
    if rc.sel(before) == str(value):
        return {"tenancy": tenancy_id, "field": label, "unchanged": str(value),
                "note": f"{label} already reads {value}; nothing written"}
    if dry_run:
        return {"tenancy": tenancy_id, "field": label, "from": shown_before, "to": str(value), "dryRun": True}
    # No typecast: a renamed choice must fail here, never be created quietly and read back as a pass.
    rc.api("PATCH", f"{rc.T_TENANCIES}/{tenancy_id}", {"fields": {field: value}})
    after = (load_tenancy(tenancy_id).get("fields") or {}).get(field)
    if rc.sel(after) != str(value):
        ledger({"kind": "unlanded", "tenancy": tenancy_id, "field": label, "to": str(value), "task": task["id"]})
        raise RuntimeError(f"{label} on {tenancy_id} reads {rc.sel(after)!r} after writing {value!r}: the write did not land")
    text = (f"{stamp()}: {label} changed from {shown_before} to {value} by the Cash Flow Voids agent, on the "
            f"RECORD CHANGE line of the card Kevin approved, task {task['id']} ({task_label(task)}). Why: {why}")
    out = {"tenancy": tenancy_id, "field": label, "from": shown_before, "to": str(value), "task": task["id"]}
    ledger(dict(out, kind="write", why=why))
    try:
        post_comment(tenancy_id, text)
        out["commented"] = True
    except Exception as e:                                   # noqa: BLE001 — the write stands; said loudly
        out["commentProblem"] = f"the field was written but the tenancy comment failed: {str(e)[:200]}"
    return out


# ─── commands ────────────────────────────────────────────────────────
def cmd_show(a):
    t = load_tenancy(a.tenancy)
    comments = rc.api("GET", f"{rc.T_TENANCIES}/{a.tenancy}/comments", params={"pageSize": 100}).get("comments") or []
    f = t.get("fields") or {}
    return {"tenancy": a.tenancy, "reference": f.get(REF), "paymentStatus": rc.sel(f.get(PAY_STATUS)),
            "dueDay": rc.sel(f.get(DUE_DAY)), "rent": f.get(rc.TY["rent"]), "start": f.get(rc.TY["start"]),
            "end": f.get(rc.TY["end"]),
            "comments": [{"at": c.get("createdTime"), "text": c.get("text")} for c in comments]}


def cmd_comment(a):
    text = " ".join(str(a.text or "").split())
    if len(text) < 15:
        raise Refused("a comment needs the fact itself (at least a sentence), not a placeholder")
    _, task = gate(a.tenancy, a.task)
    body = f"{stamp()}: {text} (task {task['id']}: {task_label(task)})"
    if a.dry_run:
        return {"tenancy": a.tenancy, "comment": body, "dryRun": True}
    c = post_comment(a.tenancy, body)
    ledger({"kind": "comment", "tenancy": a.tenancy, "task": task["id"], "comment": c.get("id")})
    return {"tenancy": a.tenancy, "commented": c.get("id")}


def cmd_status(a):
    if a.value not in STATUSES:
        raise Refused(f"Payment Status may only be set to {', '.join(STATUSES)} here; {a.value!r} is refused "
                      "(a Void goes through the six-question gate in the airtable-tenancy-ender skill)")
    tenancy, task = gate(a.tenancy, a.task, ("Payment Status", a.value))
    if ended(tenancy):
        raise Refused(f"tenancy {a.tenancy} has ended; its payment status is not changed")
    return write_field(a.tenancy, PAY_STATUS, a.value, "Payment Status", task, a.why, a.dry_run)


def cmd_due_day(a):
    if not (1 <= a.day <= 31):
        raise Refused(f"a due day is 1 to 31, not {a.day}")
    tenancy, task = gate(a.tenancy, a.task, ("Due Day", str(a.day)))
    if ended(tenancy):
        raise Refused(f"tenancy {a.tenancy} has ended; its due day is not changed")
    return write_field(a.tenancy, DUE_DAY, str(a.day), "Due Day of Month", task, a.why, a.dry_run)


def cmd_set_off(a):
    """Rent paid by set-off from one day to another, both inclusive. Kevin, 6 Oct 2026 (30 Burnbank Gardens): a
    letting agent keeping the rent against a bill we owe them means the rent is paid, "so it's not a cash flow
    void". The rent check, the Cash Flow Voids page and the rent statement count those days as paid."""
    start, until = rc.parse_day(a.start), rc.parse_day(a.until)
    if not start or not until:
        raise Refused("--from and --until are dates, YYYY-MM-DD")
    if until < start:
        raise Refused(f"the set-off ends ({until}) before it starts ({start})")
    if (until - start).days > 3 * 366:
        raise Refused("a set-off longer than three years is not a set-off; ask Kevin")
    tenancy = load_tenancy(a.tenancy)
    if ended(tenancy):
        raise Refused(f"tenancy {a.tenancy} has ended; no set-off is written")
    # Whole rent periods only (independent review, 9 Oct 2026): a window ending mid-period would read a whole month as
    # paid in the rent check and a few days in the rent statement. From is a due date; Until is the day before one.
    try:
        due_day = int(rc.sel((tenancy.get("fields") or {}).get(DUE_DAY)))
    except ValueError:
        raise Refused(f"tenancy {a.tenancy} has no due day, so a set-off cannot be lined up with its rent")
    after = until + timedelta(days=1)
    if rc.due_on(start.year, start.month, due_day) != start or rc.due_on(after.year, after.month, due_day) != after:
        raise Refused(f"a set-off covers whole rent periods: --from must be a due date (the {due_day}th) and --until "
                      "the day before one")
    tenancy, task = gate(a.tenancy, a.task, ("Set-off", f"{start.isoformat()} to {until.isoformat()}"))
    f = tenancy.get("fields") or {}
    before = (f.get(SET_OFF_FROM) or "blank", f.get(SET_OFF_UNTIL) or "blank")
    want = (start.isoformat(), until.isoformat())
    if before == want:
        return {"tenancy": a.tenancy, "unchanged": f"{want[0]} to {want[1]}"}
    if a.dry_run:
        return {"tenancy": a.tenancy, "field": "Rent Set-off", "from": f"{before[0]} to {before[1]}",
                "to": f"{want[0]} to {want[1]}", "dryRun": True}
    rc.api("PATCH", f"{rc.T_TENANCIES}/{a.tenancy}", {"fields": {SET_OFF_FROM: want[0], SET_OFF_UNTIL: want[1]}})
    g = load_tenancy(a.tenancy).get("fields") or {}
    if (g.get(SET_OFF_FROM), g.get(SET_OFF_UNTIL)) != want:
        ledger({"kind": "unlanded", "tenancy": a.tenancy, "field": "Rent Set-off", "to": f"{want[0]} to {want[1]}",
                "task": task["id"]})
        raise RuntimeError(f"the set-off on {a.tenancy} reads {g.get(SET_OFF_FROM)!r} to {g.get(SET_OFF_UNTIL)!r} "
                           f"after writing {want[0]} to {want[1]}: the write did not land")
    out = {"tenancy": a.tenancy, "field": "Rent Set-off", "from": f"{before[0]} to {before[1]}",
           "to": f"{want[0]} to {want[1]}", "task": task["id"]}
    ledger(dict(out, kind="write", why=a.why))
    authority = f"the RECORD CHANGE line of the card Kevin approved, task {task['id']}"
    text = (f"{stamp()}: rent paid by set-off from {start.strftime('%-d %b %Y')} to {until.strftime('%-d %b %Y')} "
            f"(was {before[0]} to {before[1]}), counted as paid, by the Cash Flow Voids agent on {authority} "
            f"({task_label(task)}). Why: {a.why}")
    try:
        post_comment(a.tenancy, text)
        out["commented"] = True
    except Exception as e:                                   # noqa: BLE001 — the write stands; said loudly
        out["commentProblem"] = f"the set-off was written but the tenancy comment failed: {str(e)[:200]}"
    return out


# ─── move-in and rent change ─────────────────────────────────────────
T_UNITS = "tblM3mZCR5kiEdWMj"
UNIT_NAME = "fldr8sliyu8h2jw9t"         # Rental Units: Rental Unit (the primary field, "Unit 1 – 18 Example Road")
UNIT_REF = rc.TY["unitRef"]             # Tenancies: Unit Reference (lookup of that name)
TEN = {"name": "fldxBKW7QnujSDWqA", "status": "fldAXzP9SGIHiAhrv", "payType": "fldZbrk8Xw5Dcwxhi",
       "unit": "fldeLsZYqbKS77S2V", "email": "fldybEduFY3DWWTfT", "dueDay": "fldWjCUbAOQmTKfFP",
       "agreement": "fldCqe5vCXSPDbGev"}
TY_IN = {"customers": rc.TY["tenants"], "unit": "fld7cjLLEHKAx49OK", "frequency": "fld5O24mC8vOezjXK",
         "dueDay": DUE_DAY, "deposit": "fldVMMm4Cs1JaT6b9", "metrics": "fldtuYDCmzfO7EB8a",
         "fixedCost": "fldah9Aw21NniH2z7", "maintenance": "fldx64wdvjgI1xfi7", "cashflow": "fldoJHQv6KJCb8fNE",
         "tenantsCopy": "fld82PCRs75UeYfSA", "start": rc.TY["start"], "end": rc.TY["end"],
         "rent": rc.TY["rent"], "initialDue": "fldlZKHKwmEUl7YPm", "nextDue": "fldXwCxcyiBDD6qQN",
         "billingYear": "fldhnwX4fCmr0jU71", "payStatus": PAY_STATUS, "docLinks": "fldaJGnXuCOLTqAs1",
         "agreementUrl": "fldolJbKTPDSF9RwU"}
# The links a unit carries on each of its tenancies (the 5 Oct 2026 rent-change recipe): copied, never invented.
UNIT_LINKS = ("metrics", "fixedCost", "maintenance", "cashflow")
TX_TENANCY, TX_DATE = rc.TX["tenancy"], rc.TX["date"]
PAY_TYPES = ("Universal Credit", "Working", "Agent-Managed")
EMAIL_RE = re.compile(r"[\w.+'-]+@[\w-]+(?:\.[\w-]+)+")
AGREEMENT_LINE_RE = re.compile(r"^(AGREEMENT (?:NAME|RENT|START|HOUSE)):[ \t]*(.*?)[ \t]*$", re.M)


def _rsc():
    import rent_signed_check
    return rent_signed_check


def agreement_of(task):
    """(Gmail id, agreement) for a TENANCY RECORD task the rent check raised: the agreement as the rent check read it
    (its cache, keyed by the task's own Gmail id), refused unless the task's AGREEMENT lines say exactly the same."""
    rsc = _rsc()
    f = task.get("fields") or {}
    desc = str(f.get(TK["description"]) or "")
    keys = set(re.findall(re.escape(rsc.KEY_MARK) + r"(\S+)", f"{f.get(TK['notes']) or ''}\n{desc}"))
    if not str(f.get(TK["name"]) or "").startswith(rsc.PREFIX) or len(keys) != 1:
        raise Refused(f"task {task['id']} is not a TENANCY RECORD task the rent check raised (its name and one "
                      f"'{rsc.KEY_MARK.strip()}' line)")
    mail = keys.pop()
    a = rsc.read_cache(rsc.CACHE).get(mail)
    if not a:
        raise Refused(f"the rent check has no reading of agreement {mail} (its cache {rsc.CACHE}); run the rent check")
    if a.get("rent") is None or not a.get("start") or not a.get("name") or not a.get("house"):
        raise Refused("the rent check could not read this agreement's rent, start date, tenant or house: it is Kevin's, "
                      "put it on a card with what the PDF says")
    if rsc.stale(a):
        raise Refused(f"the rent check's reading of agreement {mail} is from an older reader: run the rent check, "
                      "which reads it again")
    want = {"AGREEMENT NAME": str(a["name"]), "AGREEMENT RENT": f"{float(a['rent']):.2f}",
            "AGREEMENT START": str(a["start"]), "AGREEMENT HOUSE": str(a.get("house") or a.get("doc") or "")}
    said = {}
    for k, v in AGREEMENT_LINE_RE.findall(desc):
        said.setdefault(k, set()).add(v)
    for k, v in want.items():
        got = said.get(k) or set()
        if k == "AGREEMENT RENT":
            same = len(got) == 1 and _money(next(iter(got))) is not None and abs(_money(next(iter(got))) - float(a["rent"])) < 0.005
        else:
            same = got == {v}
        if not same:
            shown = " / ".join(sorted(got)) or "missing"
            raise Refused(f"task {task['id']}'s {k} line reads '{shown}' but the rent check read '{v}' off the agreement: "
                          "the task and the agreement disagree, so nothing is written (a fresh reading needs a fresh task)")
    return mail, a


def _money(text):
    try:
        return float(str(text).replace("£", "").replace(",", "").strip())
    except ValueError:
        return None


def first_due(start, due_day):
    """The first due date on or after the start."""
    d = rc.due_on(start.year, start.month, due_day)
    return d if d >= start else rc.next_due(d, due_day)


def next_due_from(start, due_day, today):
    """(the first due date, the next due date on or after today)."""
    due = nxt = first_due(start, due_day)
    while nxt < today:
        nxt = rc.next_due(nxt, due_day)
    return due, nxt


def read_records():
    """(tenancies in rent_signed_check.on_record's shape, {tenant id: (name, email)}): a fresh read of both tables.
    Zero rows from either is a broken read, never an empty business."""
    tys = []
    for t in rc.fetch_all(rc.T_TENANCIES, {"fields[]": [TY_IN["start"], TY_IN["rent"], TY_IN["customers"], UNIT_REF,
                                                        TY_IN["end"], TY_IN["unit"]]}):
        f = t.get("fields") or {}
        tys.append({"id": t["id"], "fields": {"start": f.get(TY_IN["start"]), "rent": f.get(TY_IN["rent"]),
                                              "tenants": f.get(TY_IN["customers"]) or [], "unit": f.get(UNIT_REF) or [],
                                              "unitIds": f.get(TY_IN["unit"]) or [], "end": f.get(TY_IN["end"])}})
    people = {}
    for t in rc.fetch_all(rc.T_TENANTS, {"fields[]": [TEN["name"], TEN["email"]]}):
        f = t.get("fields") or {}
        people[t["id"]] = (str(f.get(TEN["name"]) or ""), str(f.get(TEN["email"]) or ""))
    if not tys or not people:
        raise RuntimeError(f"control failed: read {len(tys)} tenancies and {len(people)} tenants; the read is broken")
    return tys, people


def still_unrecorded(mail, ag, tys, people, today):
    rec = _rsc().on_record(ag, tys, {k: v[0] for k, v in people.items()}, today)
    if rec:
        raise Refused(f"agreement {mail} is on record already: tenancy {rec[0]}"
                      + (" carries it as a renewal at the same rent" if rec[1] else " starts with it")
                      + "; nothing is created twice")


def live_on_unit(unit_id, tys, today):
    out = []
    for t in tys:
        f = t["fields"]
        end = rc.parse_day(f.get("end"))
        if unit_id in (f.get("unitIds") or []) and (end is None or end >= today):
            out.append(t["id"])
    return out


def copy_unit_links(unit_id):
    """The unit-level links from the newest tenancy on this unit, so a new tenancy reports where its unit does."""
    rows = [t for t in rc.fetch_all(rc.T_TENANCIES, {"fields[]": [TY_IN["unit"], TY_IN["start"]] + [TY_IN[k] for k in UNIT_LINKS]})
            if unit_id in ((t.get("fields") or {}).get(TY_IN["unit"]) or [])]
    rows.sort(key=lambda t: str((t.get("fields") or {}).get(TY_IN["start"]) or ""))
    f = (rows[-1].get("fields") or {}) if rows else {}
    return {TY_IN[k]: f[TY_IN[k]] for k in UNIT_LINKS if f.get(TY_IN[k])}


def billing_year(start):
    """({Billing Year: year} or {}, what to say). The year is written only when it is already a choice: no typecast,
    so a missing year is said, never created quietly (independent review, 9 Oct 2026)."""
    choices = rc.field_choices(rc.T_TENANCIES, TY_IN["billingYear"])
    if str(start.year) in choices:
        return {TY_IN["billingYear"]: str(start.year)}, ""
    return {}, (f"Billing Year left blank: {start.year} is not one of its choices ({', '.join(c for c in choices if c)}); "
                "set it once the choice exists")


def create(table, fields):
    return rc.api("POST", table, {"records": [{"fields": fields}]})["records"][0]["id"]


def comment_or_say(out, tenancy_id, text):
    try:
        post_comment(tenancy_id, text)
    except Exception as e:                                   # noqa: BLE001 — the write stands; said loudly
        out.setdefault("commentProblems", []).append(f"{tenancy_id}: {str(e)[:150]}")


def ledger_rows():
    """Every row of the ledger, in order. A torn line is skipped."""
    out = []
    try:
        with open(LEDGER) as fh:
            for ln in fh:
                try:
                    row = json.loads(ln) if ln.strip() else None
                except ValueError:
                    continue
                if isinstance(row, dict):
                    out.append(row)
    except FileNotFoundError:
        pass
    return out


def onboard_value(unit, unit_name, due_day, kind, email, replace=None, replace_name=None):
    """The value of the Onboard line these arguments must match, word for word. Each id carries its record's own name
    in brackets (independent review, 9 Oct 2026: an id alone tells Kevin nothing), read here from the records, so a
    line that names another room is not this line."""
    return (f"unit {unit} ({unit_name}), due {due_day}, {kind}, {email}"
            + (f", replace {replace} ({replace_name})" if replace else ""))


def cmd_onboard(a):
    rsc = _rsc()
    if a.type not in PAY_TYPES:
        raise Refused(f"--type is one of {', '.join(PAY_TYPES)}")
    if not (1 <= a.due_day <= 31):
        raise Refused(f"a due day is 1 to 31, not {a.due_day}")
    email = str(a.email or "").strip()
    if not EMAIL_RE.fullmatch(email):
        raise Refused(f"--email {email!r} is not an email address")
    if not REC_RE.fullmatch(a.unit or ""):
        raise Refused(f"--unit {a.unit!r} is not a record id")
    if a.replace and not REC_RE.fullmatch(a.replace):
        raise Refused(f"--replace {a.replace!r} is not a record id")
    task = load_task(a.task)
    mail, ag = agreement_of(task)
    unit = _one(T_UNITS, a.unit)
    if not unit:
        raise Refused(f"{a.unit} is not a rental unit")
    unit_name = " ".join(str((unit.get("fields") or {}).get(UNIT_NAME) or "").split())   # "Unit 1 – 18 Example Road"
    if not unit_name:
        raise Refused(f"rental unit {a.unit} has no name, so the line Kevin approves cannot say which room it is")
    tys, people = read_records()
    replace_name = None
    if a.replace:
        old = next((t for t in tys if t["id"] == a.replace), None)
        if not old:
            raise Refused(f"--replace {a.replace} is not a tenancy")
        refs = [" ".join(str(u).split()) for u in (old["fields"].get("unit") or [])]
        if refs != [unit_name] or a.unit not in (old["fields"].get("unitIds") or []):
            raise Refused(f"tenancy {a.replace}'s Unit Reference is '{', '.join(refs) or 'blank'}', not this unit "
                          f"'{unit_name}': it is not the tenancy on unit {a.unit}")
        replace_name = refs[0]
    line = onboard_value(a.unit, unit_name, a.due_day, a.type, email, a.replace, replace_name)
    why = change_problem(task, mail, "Onboard", line)
    if why:
        raise Refused(f"{why}. The line, exactly: RECORD CHANGE: {mail} Onboard = {line}")
    if ag.get("several"):
        raise Refused(f"the agreement names more than one person ({ag.get('name') or ', '.join(ag.get('signers') or [])}): "
                      "a joint tenancy or a guarantor is never onboarded as one person; it is Kevin's, on a card")
    start = date.fromisoformat(ag["start"])
    if not ag.get("house") or not rsc.same_house(ag["house"], unit_name):
        raise Refused(f"unit {a.unit} ({unit_name or 'no name'}) is not at {ag.get('house') or 'the agreement house'}")
    today = rc.today_london()
    rows = ledger_rows()
    done = [r for r in rows if r.get("kind") == "onboard" and r.get("mail") == mail]
    if done:
        raise Refused(f"agreement {mail} was onboarded already: tenant {done[-1].get('tenantId')}, tenancy "
                      f"{done[-1].get('tenancy')}")
    still_unrecorded(mail, ag, tys, people, today)
    # A tenant this door created for THIS agreement whose tenancy then failed is the same person: reused, never
    # refused as "already on record" and never created twice (independent review, 9 Oct 2026).
    made = [r.get("tenantId") for r in rows if r.get("kind") == "tenant-created" and r.get("mail") == mail]
    reuse = next((t for t in reversed(made) if t in people), None)
    for tid, (tname, temail) in people.items():
        if tid == reuse:
            continue
        if (temail and temail.lower() == email.lower()) or rsc.same_person(tname, ag["name"]):
            raise Refused(f"tenant {tid} ({tname}) is already on record: a returning tenant or a rent change is not "
                          "an onboarding (rent-change, or a card for Kevin)")
    others = live_on_unit(a.unit, tys, today)
    if others:
        if a.replace not in others or len(others) > 1:
            raise Refused(f"unit {a.unit} has live tenancy {', '.join(others)}: the Onboard line Kevin approves names it "
                          "with ', replace <that tenancy>'")
    elif a.replace:
        raise Refused(f"--replace {a.replace} is not a live tenancy on unit {a.unit}")
    name = " ".join(w[:1].upper() + w[1:] for w in ag["name"].split())
    due, nxt = next_due_from(start, a.due_day, today)
    year, year_note = billing_year(start)
    plan = {"tenant": name, "unit": a.unit, "unitName": unit_name, "start": ag["start"], "rent": ag["rent"],
            "dueDay": a.due_day, "status": "CFV", "replace": a.replace or None,
            "reuseTenant": reuse, **({"billingYear": year_note} if year_note else {})}
    if a.dry_run:
        return dict(plan, dryRun=True)
    out = dict(plan, task=task["id"], mail=mail)
    if reuse:
        tenant_id = reuse
    else:
        tf = {TEN["name"]: name, TEN["status"]: "Active", TEN["payType"]: a.type, TEN["unit"]: [a.unit],
              TEN["email"]: email, TEN["dueDay"]: str(a.due_day), TEN["agreement"]: True}
        tenant_id = create(rc.T_TENANTS, tf)
        ledger({"kind": "tenant-created", "mail": mail, "tenantId": tenant_id, "task": task["id"]})
    out["tenantId"] = tenant_id
    yf = dict({TY_IN["customers"]: [tenant_id], TY_IN["unit"]: [a.unit], TY_IN["start"]: ag["start"],
               TY_IN["frequency"]: "Monthly", TY_IN["rent"]: ag["rent"], TY_IN["dueDay"]: str(a.due_day),
               TY_IN["initialDue"]: due.isoformat(), TY_IN["nextDue"]: nxt.isoformat(), TY_IN["payStatus"]: "CFV",
               TY_IN["deposit"]: 0, TY_IN["agreementUrl"]: f"https://mail.google.com/mail/u/0/#all/{mail}",
               TY_IN["docLinks"]: f"AST signed {ag.get('signed')} (Adobe '{ag.get('subject')}'): £{ag['rent']:.2f} a month "
                                  f"from {start.strftime('%-d %B %Y')}. Onboarded by the Cash Flow Voids agent from task {task['id']}."},
              **copy_unit_links(a.unit), **year)
    tenancy_id = create(rc.T_TENANCIES, yf)
    out["tenancy"] = tenancy_id
    back = load_tenancy(tenancy_id).get("fields") or {}
    if (back.get(TY_IN["start"]), float(back.get(TY_IN["rent"]) or 0), rc.sel(back.get(PAY_STATUS))) != (ag["start"], float(ag["rent"]), "CFV"):
        ledger(dict(out, kind="unlanded"))
        raise RuntimeError(f"the new tenancy {tenancy_id} does not read back as written: {back}")
    if a.replace:
        rc.api("PATCH", f"{rc.T_TENANCIES}/{a.replace}", {"fields": {TY_IN["unit"]: []}})
        old = load_tenancy(a.replace).get("fields") or {}
        for t in old.get(TY_IN["customers"]) or []:
            tt = _one(rc.T_TENANTS, t, [TEN["unit"]])
            if tt and a.unit in ((tt.get("fields") or {}).get(TEN["unit"]) or []):
                rc.api("PATCH", f"{rc.T_TENANTS}/{t}", {"fields": {TEN["unit"]: []}})
        comment_or_say(out, a.replace, f"{stamp()}: taken off unit {unit_name} and left live, unlinked, on the card Kevin "
                                       f"approved (task {task['id']}). {name}'s tenancy {tenancy_id} replaces it on the unit.")
    ledger(dict(out, kind="onboard"))
    comment_or_say(out, tenancy_id, f"{stamp()}: onboarded from the signed agreement ({ag.get('signed')}): £{ag['rent']:.2f} a "
                                    f"month from {start.strftime('%-d %b %Y')}, due on the {a.due_day}, starts as a cash flow "
                                    f"void. By the Cash Flow Voids agent on the card Kevin approved, task {task['id']}. "
                                    f"Why: {a.why}")
    return out


def cmd_rent_change(a):
    rsc = _rsc()
    task = load_task(a.task)
    mail, ag = agreement_of(task)
    why = change_problem(task, a.tenancy, "Rent change", mail)
    if why:
        raise Refused(why)
    start = date.fromisoformat(ag["start"])
    old = load_tenancy(a.tenancy)
    f = old.get("fields") or {}
    today = rc.today_london()
    tys, people = read_records()
    # A re-run, or a rent change recorded another way since the task was raised, writes nothing twice.
    mine = set(f.get(TY_IN["customers"]) or [])
    for t in tys:
        g = t["fields"]
        if (t["id"] != a.tenancy and mine & set(g["tenants"]) and str(g.get("start") or "")[:10] == ag["start"]
                and abs(float(g.get("rent") or 0) - float(ag["rent"])) <= 0.01):
            left = "" if f.get(TY_IN["end"]) else f"; tenancy {a.tenancy} still has no end date, so end it on a card"
            raise Refused(f"tenancy {t['id']} already records this agreement (the same tenant, start and rent): nothing "
                          f"is created twice{left}")
    still_unrecorded(mail, ag, tys, people, today)
    if ended(old) or f.get(TY_IN["end"]):
        raise Refused(f"tenancy {a.tenancy} already has an end date; a rent change starts from a live tenancy")
    status = rc.sel(f.get(PAY_STATUS))
    if status not in STATUSES:
        raise Refused(f"tenancy {a.tenancy}'s Payment Status is '{status or 'blank'}', not one of {', '.join(STATUSES)}: "
                      "the new tenancy keeps the old one's, so this is Kevin's, on a card")
    old_start = rc.parse_day(f.get(TY_IN["start"]))
    if not old_start or start <= old_start:
        raise Refused(f"the agreement starts {start}, not after tenancy {a.tenancy} began ({old_start})")
    if abs(float(f.get(TY_IN["rent"]) or 0) - float(ag["rent"])) <= 0.01:
        raise Refused(f"tenancy {a.tenancy} already carries £{ag['rent']:.2f}: there is no rent change")
    names = [people.get(t, ("", ""))[0] for t in f.get(TY_IN["customers"]) or []]
    if not any(rsc.same_person(n, ag["name"]) for n in names):
        raise Refused(f"tenancy {a.tenancy}'s tenant ({', '.join(n for n in names if n) or 'none'}) is not {ag['name']}")
    units = f.get(UNIT_REF) or []
    units = units if isinstance(units, list) else [units]
    if not ag.get("house") or not any(rsc.same_house(ag["house"], u) for u in units):
        raise Refused(f"tenancy {a.tenancy} ({', '.join(str(u) for u in units) or 'no unit'}) is not at "
                      f"{ag.get('house') or 'the agreement house'}")
    try:
        due_day = int(rc.sel(f.get(TY_IN["dueDay"])))
    except ValueError:
        raise Refused(f"tenancy {a.tenancy} has no due day to carry over")
    due, nxt = next_due_from(start, due_day, today)
    year, year_note = billing_year(start)
    plan = {"from": a.tenancy, "start": ag["start"], "rent": ag["rent"], "status": status,
            "oldEnds": (start - timedelta(days=1)).isoformat(), **({"billingYear": year_note} if year_note else {})}
    if a.dry_run:
        return dict(plan, dryRun=True)
    keep = ("customers", "unit", "frequency", "dueDay", "deposit", "tenantsCopy") + UNIT_LINKS
    yf = {TY_IN[k]: f[TY_IN[k]] for k in keep if f.get(TY_IN[k]) not in (None, [], "")}
    for k in ("frequency", "dueDay"):
        if TY_IN[k] in yf:
            yf[TY_IN[k]] = rc.sel(yf[TY_IN[k]])
    yf.update({TY_IN["start"]: ag["start"], TY_IN["rent"]: ag["rent"], TY_IN["initialDue"]: due.isoformat(),
               TY_IN["nextDue"]: nxt.isoformat(), TY_IN["payStatus"]: status,
               TY_IN["agreementUrl"]: f"https://mail.google.com/mail/u/0/#all/{mail}",
               TY_IN["docLinks"]: f"New AST signed {ag.get('signed')}: £{ag['rent']:.2f} a month from {start.strftime('%-d %B %Y')}. "
                                  f"Replaces tenancy {a.tenancy}, ended the day before (rent change = new tenancy, Kevin 5 Oct 2026)."},
              **year)
    new_id = create(rc.T_TENANCIES, yf)
    out = dict(plan, tenancy=new_id, task=task["id"], mail=mail, movedPayments=[], movedTasks=[])
    back_new = load_tenancy(new_id).get("fields") or {}
    if (back_new.get(TY_IN["start"]), rc.sel(back_new.get(PAY_STATUS))) != (ag["start"], status):
        ledger(dict(out, kind="unlanded"))
        raise RuntimeError(f"the new tenancy {new_id} does not read back as written (start {back_new.get(TY_IN['start'])}, "
                           f"status {rc.sel(back_new.get(PAY_STATUS)) or 'blank'}); tenancy {a.tenancy} was NOT ended")
    # The old one ends the day before. If that fails the new tenancy stands and is never created again (a re-run
    # refuses): said loudly, with what is left to do.
    try:
        rc.api("PATCH", f"{rc.T_TENANCIES}/{a.tenancy}", {"fields": {TY_IN["end"]: plan["oldEnds"], PAY_STATUS: None}})
        back_old = load_tenancy(a.tenancy).get("fields") or {}
        if back_old.get(TY_IN["end"]) != plan["oldEnds"]:
            raise RuntimeError(f"it reads {back_old.get(TY_IN['end'])!r} after writing {plan['oldEnds']}")
    except Exception as e:                                   # noqa: BLE001 — said loudly, never retried here
        ledger(dict(out, kind="partial", problem=f"ending {a.tenancy} failed: {str(e)[:200]}"))
        raise RuntimeError(f"new tenancy {new_id} was created, but ending tenancy {a.tenancy} on {plan['oldEnds']} "
                           f"failed: {str(e)[:200]}. Nothing is created twice (a re-run refuses): end {a.tenancy} on "
                           f"{plan['oldEnds']} and move its payments and open tasks to {new_id}, on a card for Kevin")
    # The payments dated from the new start, and the open tasks, follow the tenancy (the 5 Oct 2026 recipe).
    try:
        for tx in rc.fetch_all(rc.T_TX, {"fields[]": [TX_TENANCY, TX_DATE],
                                         "filterByFormula": f"IS_AFTER({{**Date}}, '{(start - timedelta(days=1)).isoformat()}')"}):
            links = list((tx.get("fields") or {}).get(TX_TENANCY) or [])
            if a.tenancy in links:
                rc.api("PATCH", f"{rc.T_TX}/{tx['id']}", {"fields": {TX_TENANCY: [new_id if x == a.tenancy else x for x in links]}})
                out["movedPayments"].append(tx["id"])
        for t in rc.fetch_all(rc.T_TASKS, {"fields[]": [TK["tenancies"], TK["status"]],
                                           "filterByFormula": "AND({Status}!='Completed', {Status}!='Cancelled')"}):
            links = list((t.get("fields") or {}).get(TK["tenancies"]) or [])
            if a.tenancy in links:
                rc.api("PATCH", f"{rc.T_TASKS}/{t['id']}", {"fields": {TK["tenancies"]: [new_id if x == a.tenancy else x for x in links]}})
                out["movedTasks"].append(t["id"])
    except Exception as e:                                   # noqa: BLE001 — said loudly with what moved
        ledger(dict(out, kind="partial", problem=f"moving payments or tasks failed: {str(e)[:200]}"))
        raise RuntimeError(f"new tenancy {new_id} created and {a.tenancy} ended, but moving its payments and open tasks "
                           f"failed after {len(out['movedPayments'])} payment(s) and {len(out['movedTasks'])} task(s): "
                           f"{str(e)[:200]}")
    ledger(dict(out, kind="rent-change"))
    comment_or_say(out, a.tenancy, f"{stamp()}: ended {plan['oldEnds']}: the tenant signed a new agreement at £{ag['rent']:.2f} "
                                   f"from {start.strftime('%-d %b %Y')}; new tenancy {new_id}. Tenant and unit unchanged. "
                                   f"By the Cash Flow Voids agent on the card Kevin approved, task {task['id']}.")
    comment_or_say(out, new_id, f"{stamp()}: created from the signed agreement ({ag.get('signed')}): £{ag['rent']:.2f} a month from "
                                f"{start.strftime('%-d %b %Y')}, Payment Status {status} as before. Replaces {a.tenancy}. Moved "
                                f"{len(out['movedPayments'])} payment(s) and {len(out['movedTasks'])} open task(s). Why: {a.why}")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("show")
    s.add_argument("tenancy")
    c = sub.add_parser("comment")
    c.add_argument("tenancy")
    c.add_argument("--task", required=True)
    c.add_argument("--text", required=True)
    c.add_argument("--dry-run", action="store_true")
    st = sub.add_parser("status")
    st.add_argument("tenancy")
    st.add_argument("value")
    st.add_argument("--task", required=True)
    st.add_argument("--why", required=True, help="Kevin's words, or the fact from the task, in one sentence")
    st.add_argument("--dry-run", action="store_true")
    dd = sub.add_parser("due-day")
    dd.add_argument("tenancy")
    dd.add_argument("day", type=int)
    dd.add_argument("--task", required=True)
    dd.add_argument("--why", required=True)
    dd.add_argument("--dry-run", action="store_true")
    so = sub.add_parser("set-off")
    so.add_argument("tenancy")
    so.add_argument("--from", dest="start", required=True)
    so.add_argument("--until", required=True)
    so.add_argument("--task", required=True)
    so.add_argument("--why", required=True)
    so.add_argument("--dry-run", action="store_true")
    ob = sub.add_parser("onboard")
    ob.add_argument("--task", required=True)
    ob.add_argument("--unit", required=True)
    ob.add_argument("--due-day", dest="due_day", type=int, required=True)
    ob.add_argument("--type", required=True)
    ob.add_argument("--email", required=True)
    ob.add_argument("--replace")
    ob.add_argument("--why", required=True)
    ob.add_argument("--dry-run", action="store_true")
    rcg = sub.add_parser("rent-change")
    rcg.add_argument("tenancy")
    rcg.add_argument("--task", required=True)
    rcg.add_argument("--why", required=True)
    rcg.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if getattr(a, "why", None) is not None and len(" ".join(a.why.split())) < 10:
        print(json.dumps({"refused": "--why needs the reason in a sentence"}))
        return 2
    try:
        out = {"show": cmd_show, "comment": cmd_comment, "status": cmd_status, "due-day": cmd_due_day,
               "set-off": cmd_set_off, "onboard": cmd_onboard, "rent-change": cmd_rent_change}[a.cmd](a)
    except Refused as e:
        print(json.dumps({"refused": str(e)}))
        return 2
    except RuntimeError as e:
        print(json.dumps({"failed": str(e)[:400]}))
        return 1
    print(json.dumps(out, indent=2))
    return 1 if out.get("commentProblem") or out.get("commentProblems") else 0


if __name__ == "__main__":
    sys.exit(main())
