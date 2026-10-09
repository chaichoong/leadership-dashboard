#!/usr/bin/env python3
"""cost-record.py: the gated door through which an agent changes a fixed cost's Expected Cost.

WHY THIS EXISTS (9 Oct 2026, finding 20261007-agent-dispatch-789)
Kevin approved the Loom downgrade (Business + AI to Business, from 24 Oct 2026) on 7 Oct, and the
approved card said the robot would then update the Loom cost record. No command wrote the Costs
table, a direct Airtable write is refused to the robots, so the cost record stayed at the old price
and the task sat on a TOOL wall. This is the door, modelled on scripts/tenancy-record.py.

WHAT A WRITE NEEDS
  * --task: an Airtable task Kevin approved EXACTLY "Approved as-is", with the marks only a real
    approval leaves (scripts/approval_evidence.py, through tenancy-record.py approval_problem).
    "Approved with minor edits" is refused: `agent-dispatch.py revise` rewrites the output after it,
    so a line there may not be the line he read.
  * The approved Agent Output (below the last Your step divider when a YOUR STEP block sits on top,
    tenancy-record.py approved_original) carries the exact line
        RECORD CHANGE: <cost record id> Expected Cost = <amount>
    and the command's own arguments must say the same cost and the same amount.
  * A cost proven to be in the Costs table (a list read by RECORD_ID, never a GET by id, which
    ignores the table in the URL).

WHAT A WRITE DOES
  Writes Expected Cost (a Number, no typecast), reads it back from the table and fails loudly if it
  did not land, leaves a dated comment on the cost (what changed, from what, which task asked, why),
  and appends one line to LEDGER. A write whose comment then fails is said (exit 1), never undone.

WHAT IT NEVER DOES
  Write any other field: never a Payment Status (the LEGACY one is the live rule, CLAUDE.md), never
  Inactive, a name, a due day or an account. Never creates or deletes a cost. Moves no money.
  LIMIT, as for approval_evidence: every field is written with the token the agents hold, so a
  deliberate forgery still passes. This stops the lazy and the accidental route.

USAGE
  cost-record.py show COST                                      the record and its comments (read only)
  cost-record.py expected COST 16.36 --task T --why "..."       Expected Cost, on an approved line
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

# js/config.js TABLES.costs and F.costName / F.costExpected / F.costDueDay / F.costPayStatus / F.costInactive.
# tests/cost-record.test.js fails if these drift from config.js.
T_COSTS = "tblx5kvhzNEI5TFlS"
COST_NAME = "fldS6FYfpkhu6tJG0"
COST_EXPECTED = "fld9JibXkMpTeMcxw"
COST_DUE_DAY = "fld7IsfiGvKpxEwSs"           # read only, for show
COST_PAY_STATUS = "fldXZNI96v8HgjuSh"        # read only, for show (the LEGACY Payment Status)
COST_INACTIVE = "fldQJPGLFMbwVelsW"          # read only, for show

CHANGE_RE = re.compile(r"^RECORD CHANGE:\s*(?P<cost>rec[A-Za-z0-9]{14})\s+(?P<label>Expected Cost)\s*=\s*"
                       r"(?P<value>[^\n]+?)\s*$", re.M)
AMOUNT_RE = re.compile(r"^(?:£|GBP\s*)?(\d{1,7}(?:\.\d{1,2})?)$", re.I)


def amount(text):
    """A pounds amount as a Decimal to the penny, or None: '16.36', '£16.36' and 'GBP 16.36' read the same."""
    m = AMOUNT_RE.match(" ".join(str(text or "").split()))
    if not m:
        return None
    try:
        return Decimal(m.group(1)).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None


def load_cost(cost_id):
    if not tr.REC_RE.fullmatch(cost_id or ""):
        raise Refused(f"{cost_id!r} is not a record id")
    row = tr._one(T_COSTS, cost_id)
    if not row:
        raise Refused(f"{cost_id} is not a cost (no row with that id in the Costs table)")
    return row


def change_problem(task, cost_id, value):
    """'' when Kevin approved THIS Expected Cost for THIS cost on this task, as-is, else why not."""
    f = task.get("fields") or {}
    why = tr.approval_problem(task)
    if why:
        return why
    outcome = rc.sel(f.get(tr.TK["approvalOutcome"]))
    if outcome != "Approved as-is":
        return (f"task {task['id']} was {outcome}, not Approved as-is: after an edit the card may not say what he read, "
                "so put the change on a fresh card")
    for m in CHANGE_RE.finditer(tr.approved_original(f.get(tr.TK["agentOutput"]))):
        if m.group("cost") == cost_id and amount(m.group("value")) == value:
            return ""
    return (f"the card Kevin approved (task {task['id']}) has no line 'RECORD CHANGE: {cost_id} Expected Cost = {value}': "
            "put the change on a card for him to approve (one tap)")


def stamp():
    return datetime.now(rc.LONDON).strftime("%d %b %Y %H:%M")


def money(v):
    return "blank" if v in (None, "") else f"£{Decimal(str(v)).quantize(Decimal('0.01'))}"


def ledger(row):
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    with open(LEDGER, "a") as fh:
        fh.write(json.dumps(dict(row, at=datetime.now(rc.LONDON).isoformat(timespec="seconds"))) + "\n")


# ─── commands ────────────────────────────────────────────────────────
def cmd_show(a):
    c = load_cost(a.cost)
    f = c.get("fields") or {}
    comments = rc.api("GET", f"{T_COSTS}/{a.cost}/comments", params={"pageSize": 100}).get("comments") or []
    return {"cost": a.cost, "name": f.get(COST_NAME), "expectedCost": f.get(COST_EXPECTED),
            "dueDay": rc.sel(f.get(COST_DUE_DAY)), "paymentStatus": rc.sel(f.get(COST_PAY_STATUS)),
            "inactive": bool(f.get(COST_INACTIVE)),
            "comments": [{"at": x.get("createdTime"), "text": x.get("text")} for x in comments]}


def cmd_expected(a):
    value = amount(a.value)
    if value is None or value <= 0:
        raise Refused(f"Expected Cost must be a pounds amount above zero, like 16.36, not {a.value!r}")
    cost, task = load_cost(a.cost), tr.load_task(a.task)
    why = change_problem(task, a.cost, value)
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
    text = (f"{stamp()}: Expected Cost changed from {money(before)} to {money(value)} by an agent, on the RECORD CHANGE "
            f"line of the card Kevin approved, task {task['id']} ({tr.task_label(task)}). Why: {' '.join(a.why.split())}")
    try:
        rc.api("POST", f"{T_COSTS}/{a.cost}/comments", {"text": text})
        out["commented"] = True
    except Exception as e:                                   # noqa: BLE001 — the write stands; said loudly
        out["commentProblem"] = f"Expected Cost was written but the cost comment failed: {str(e)[:200]}"
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("show")
    s.add_argument("cost")
    e = sub.add_parser("expected")
    e.add_argument("cost")
    e.add_argument("value")
    e.add_argument("--task", required=True)
    e.add_argument("--why", required=True, help="Kevin's words, or the fact from the task, in one sentence")
    e.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if getattr(a, "why", None) is not None and len(" ".join(a.why.split())) < 10:
        print(json.dumps({"refused": "--why needs the reason in a sentence"}))
        return 2
    try:
        out = {"show": cmd_show, "expected": cmd_expected}[a.cmd](a)
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
