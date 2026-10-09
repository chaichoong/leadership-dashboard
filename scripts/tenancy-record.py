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
        RECORD CHANGE: <tenancy id> <Payment Status|Due Day> = <value>
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
  Void a unit, end a tenancy, edit a rent (a rent change is a NEW tenancy: Kevin, 5 Oct 2026), touch
  a tenant record, or write any field not listed below. Payment Status takes only In Payment, CFV or
  CFV Actioned: voiding has its own six-question gate (airtable-tenancy-ender skill).

USAGE
  tenancy-record.py show TENANCY                          the record and its comments (read only)
  tenancy-record.py comment TENANCY --task T --text "..." a dated comment (no approval needed)
  tenancy-record.py status TENANCY "In Payment" --task T  Payment Status (Unified)
  tenancy-record.py due-day TENANCY 9 --task T            Due Day of Month
  add --dry-run to any write to see the gate's answer and change nothing.
"""
import argparse
import importlib.util
import json
import os
import re
import sys
from datetime import datetime

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
STATUSES = ("In Payment", "CFV", "CFV Actioned")
REF = "fldyNVvFn4x8GY14q"            # Tenancy Reference (js/config.js F.tenRef), for the message only
# Tasks fields (scripts/agent-dispatch.py AF; scripts/approval_evidence.py).
TK = dict(rc.TK, agentOutput="fldzswp8fx6PqpLQ5", approvalOutcome="fldrHBSr6qoUfaKuZ",
          approvalFeedback="fldtI7SJI4gEohHD1", feedbackHistory="fldOzsq68lhfprKJu")
REC_RE = re.compile(r"rec[A-Za-z0-9]{14}")
CHANGE_RE = re.compile(r"^RECORD CHANGE:\s*(?P<tenancy>rec[A-Za-z0-9]{14})\s+(?P<label>Payment Status|Due Day)\s*=\s*"
                       r"(?P<value>[^\n]+?)\s*$", re.M)
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
    a = ap.parse_args(argv)
    if getattr(a, "why", None) is not None and len(" ".join(a.why.split())) < 10:
        print(json.dumps({"refused": "--why needs the reason in a sentence"}))
        return 2
    try:
        out = {"show": cmd_show, "comment": cmd_comment, "status": cmd_status, "due-day": cmd_due_day}[a.cmd](a)
    except Refused as e:
        print(json.dumps({"refused": str(e)}))
        return 2
    except RuntimeError as e:
        print(json.dumps({"failed": str(e)[:400]}))
        return 1
    print(json.dumps(out, indent=2))
    return 1 if out.get("commentProblem") else 0


if __name__ == "__main__":
    sys.exit(main())
