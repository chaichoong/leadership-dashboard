#!/usr/bin/env python3
"""Nightly task hygiene sweep — the deterministic half.

WHAT THIS IS
------------
Kevin's seven rules say every open task must carry an assignee, a due date, a time
estimate, a priority, a business, a project (if it is project-based), and a recurring
value (if it repeats). Nothing enforced them, so on 2026-07-30 the 279 open tasks were
missing 53 assignees, 82 time estimates, 72 businesses and 31 due dates.

This script does the parts a machine can be trusted with: read the open tasks, apply
the rules, emit a work-list, apply a decision file, and undo any night's writes. The
judgement (what time estimate, which business, is this project-based, does it repeat)
is made by the Claude agent in ~/.claude/scheduled-tasks/task-hygiene-sweep/, which
calls this script either side of its thinking.

TIERS
-----
auto     Time Estimate, Business, Due Date — written the same night, no approval.
pending  Assignee, Projects, Recurring — held until Kevin approves. Recurring is held
         because a value there makes Airtable clone the task on its next due date, so a
         wrong guess creates real work.

The guard rail lives in the agent's SKILL.md, not here. This script applies whatever
tier it is told to.

CONTROL CHECK
-------------
Same discipline as check-data-invariants.py: a filter with a typo'd field name returns
zero rows and reads as "all tasks compliant" forever. If the open-task query returns
nothing, or an expected field name is missing from the live schema, the run FAILS. A
sweep that silently audits nothing is worse than no sweep.

EXEMPTIONS (assumed 2026-07-30, Kevin can overturn)
---------------------------------------------------
  Some Day            exempt from the due-date rule (deliberately undated)
  Maintenance Ticket  owner comes from the Contractor field; exempt from the project rule

Usage:
  python3 scripts/task-hygiene-sweep.py audit [--out FILE]
  python3 scripts/task-hygiene-sweep.py apply --decisions FILE [--tier auto|all] [--dry-run]
  python3 scripts/task-hygiene-sweep.py undo --applied FILE [--dry-run]

Exit: 0 = fine, 1 = control failure, violation of a safety rule, or a write error.
Auth: ~/.config/od/airtable_pat (never printed).
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"
BUSINESSES = "tblpqkvWJJo8Uu25q"
PROJECTS = "tblHrpTMd5LNYn8v1"

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MONITORING = os.path.join(REPO, "monitoring")

# Field names as the rest of the codebase uses them (config.js reads by name, not ID).
# The ID is recorded alongside so a rename upstream is caught by the schema check.
FIELDS = {
    "name": ("Task Name", "fldgFjGBw6bTKJFCD"),
    "status": ("Status", "fldx4qCw17UfrKpaN"),
    "assignee": ("Assignee", "fldELMncVJYPDRJNc"),
    "dueDate": ("Due Date", "fld7XP8w8kbxfETV4"),
    "timeEstimate": ("Time Estimate", "fld10VzzbiNNgRmIi"),
    "priority": ("Priority", "fldS21RwmwOqt71LI"),
    "business": ("Business", "fldLu1Y4GzyWcDoxr"),
    "project": ("Projects", "fldBg0rQy0FrOAkRN"),
    "recurring": ("Recurring", "fldNhDWBX5gQm2p6b"),
    "description": ("Description", "fldRGhBQViKZKtkQ6"),
    "notes": ("Notes", "fldR7apBzSp3oxFxz"),
    "someDay": ("Some Day", "fldmhkeRaDkiL3Ga4"),
    "maintenance": ("Maintenance Ticket", "fldSEUvVA98as1HW6"),
    "contractor": ("Contractor", "fldgmzcr3jHALsdYD"),
    "createdTime": ("Created Time", "fldlhVrnsE0cAbm7T"),
}

# Writable fields, by tier. Nothing outside this map can ever be written by the sweep.
WRITABLE = {
    "timeEstimate": "auto",
    "business": "auto",
    "dueDate": "auto",
    "assignee": "pending",
    "project": "pending",
    "recurring": "pending",
}

# Valid select choices, read from the live schema at run time and checked against these.
# A drifted option list should fail loudly rather than write a value Airtable rejects.
EXPECTED_CHOICES = {
    "timeEstimate": ["15 min", "30 min", "45 min", "1 hr", "2 hr", "3 hr", "4 hr", "8 hr"],
    "recurring": ["Daily", "Weekly", "Fortnightly", "Monthly", "Quarterly",
                  "Bi-Annually", "Annually", "None"],
}

# Assignee must be one of these. Writing a collaborator field with an unknown email
# silently no-ops in Airtable, which would read as a successful fix.
TEAM = {
    "kevin@runpreneur.org.uk": "Kevin Brittain",
    "micaa.work@gmail.com": "Mica Albovias",
    "atentaerica@gmail.com": "Ericamae Atenta",
    "gkm.property.maintenance@outlook.com": "Gary Marsh",
    "rjm320@hotmail.com": "Rob Jackson",
    "roy.lavin1978@gmail.com": "Roy Lavin",
}

DUE_DATE_MAX_HORIZON_DAYS = 90  # a proposed due date beyond this is rejected as a guess


def pat():
    path = os.path.expanduser("~/.config/od/airtable_pat")
    with open(path) as fh:
        return fh.read().strip()


def api(method, path, token, params=None, payload=None):
    url = f"https://api.airtable.com/v0/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            body = exc.read().decode()[:400]
            raise SystemExit(f"FAIL: Airtable {method} {path} returned {exc.code}: {body}")
        except urllib.error.URLError as exc:
            if attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise SystemExit(f"FAIL: cannot reach Airtable: {exc.reason}")
    raise SystemExit("FAIL: Airtable request exhausted retries")


def fetch_all(token, table, fields=None, formula=None):
    records, offset = [], None
    while True:
        params = {"pageSize": 100}
        if fields:
            params["fields[]"] = fields
        if formula:
            params["filterByFormula"] = formula
        if offset:
            params["offset"] = offset
        page = api("GET", f"{BASE_ID}/{table}", token, params=params)
        records += page["records"]
        offset = page.get("offset")
        if not offset:
            return records


def load_schema(token):
    """Fetch the Tasks schema and prove every field this script relies on still exists."""
    meta = api("GET", f"meta/bases/{BASE_ID}/tables", token)
    table = next((t for t in meta["tables"] if t["id"] == TASKS), None)
    if not table:
        raise SystemExit(f"FAIL: Tasks table {TASKS} not found in base {BASE_ID}")
    by_name = {f["name"]: f for f in table["fields"]}
    problems = []
    for key, (name, fid) in FIELDS.items():
        field = by_name.get(name)
        if not field:
            problems.append(f"field '{name}' ({key}) missing from Tasks")
        elif field["id"] != fid:
            problems.append(f"field '{name}' is {field['id']}, expected {fid} — renamed or replaced")
    for key, expected in EXPECTED_CHOICES.items():
        field = by_name.get(FIELDS[key][0])
        if field and field.get("type") == "singleSelect":
            live = [c["name"] for c in field["options"]["choices"]]
            if set(live) != set(expected):
                problems.append(f"'{FIELDS[key][0]}' options changed: live={live} expected={expected}")
    if problems:
        for p in problems:
            print(f"  SCHEMA DRIFT: {p}")
        raise SystemExit("FAIL: schema drift — fix FIELDS/EXPECTED_CHOICES before sweeping")
    return by_name


def fname(key):
    return FIELDS[key][0]


def get(rec, key, default=None):
    return rec["fields"].get(fname(key), default)


def reference_data(token):
    """Businesses (active only) and projects (not completed) the agent may link to."""
    businesses = []
    for rec in fetch_all(token, BUSINESSES, fields=["Business Name", "Active"]):
        if rec["fields"].get("Active"):
            businesses.append({"id": rec["id"], "name": rec["fields"].get("Business Name")})
    projects = []
    for rec in fetch_all(token, PROJECTS, fields=["Project Name", "Project Status"]):
        status = rec["fields"].get("Project Status")
        if status not in ("Completed", "Complete", "Archived"):
            projects.append({"id": rec["id"], "name": rec["fields"].get("Project Name"),
                             "status": status})
    return businesses, projects


def strip_html(text):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text or "")).strip()


def assess(rec):
    """Return the list of rule gaps on one open task, with exemptions applied."""
    gaps = []
    some_day = bool(get(rec, "someDay"))
    maintenance = bool(get(rec, "maintenance"))

    if not get(rec, "assignee") and not (maintenance and get(rec, "contractor")):
        gaps.append("assignee")
    if not get(rec, "dueDate") and not some_day:
        gaps.append("dueDate")
    if not get(rec, "timeEstimate"):
        gaps.append("timeEstimate")
    if not get(rec, "priority"):
        gaps.append("priority")
    if not get(rec, "business"):
        gaps.append("business")
    # Project? checkbox is ticked on zero records and Task Category is dead, so there is
    # no field that says "this is project-based". The agent judges it from content; the
    # script only reports which tasks carry no project link for it to judge.
    if not get(rec, "project") and not maintenance:
        gaps.append("project")
    if not get(rec, "recurring"):
        gaps.append("recurring")
    return gaps


def cmd_audit(args):
    token = pat()
    load_schema(token)

    wanted = [fname(k) for k in FIELDS]
    records = fetch_all(token, TASKS, fields=wanted)
    open_tasks = [r for r in records if get(r, "status") != "Completed"]

    # CONTROL CHECK — a broken filter or field rename must fail, never read as all-clean.
    if not records:
        raise SystemExit("FAIL: control check — Tasks table returned zero records")
    if not open_tasks:
        raise SystemExit(
            "FAIL: control check — zero open tasks found. Either every task really is "
            "Completed (verify by hand) or the Status read is broken. Not reporting a pass."
        )

    businesses, projects = reference_data(token)

    items, counts = [], {}
    for rec in open_tasks:
        gaps = assess(rec)
        for gap in gaps:
            counts[gap] = counts.get(gap, 0) + 1
        if not gaps:
            continue
        items.append({
            "recordId": rec["id"],
            "name": get(rec, "name") or "(no name)",
            "status": get(rec, "status"),
            "gaps": gaps,
            "context": {
                "description": strip_html(get(rec, "description"))[:600],
                "notes": strip_html(get(rec, "notes"))[:400],
                "dueDate": get(rec, "dueDate"),
                "priority": get(rec, "priority"),
                "timeEstimate": get(rec, "timeEstimate"),
                "assignee": (get(rec, "assignee") or {}).get("name"),
                "businessLinked": bool(get(rec, "business")),
                "projectLinked": bool(get(rec, "project")),
                "someDay": bool(get(rec, "someDay")),
                "maintenanceTicket": bool(get(rec, "maintenance")),
                "contractor": get(rec, "contractor"),
                "createdTime": get(rec, "createdTime"),
            },
        })

    clean = len(open_tasks) - len(items)
    out = {
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "openTasks": len(open_tasks),
        "compliant": clean,
        "compliancePct": round(100 * clean / len(open_tasks), 1),
        "gapCounts": counts,
        "reference": {
            "businesses": businesses,
            "projects": projects,
            "team": [{"email": e, "name": n} for e, n in TEAM.items()],
            "timeEstimateOptions": EXPECTED_CHOICES["timeEstimate"],
            "recurringOptions": EXPECTED_CHOICES["recurring"],
            "tiers": WRITABLE,
        },
        "tasks": items,
    }

    os.makedirs(MONITORING, exist_ok=True)
    path = args.out or os.path.join(MONITORING, f"task-sweep-worklist-{date.today()}.json")
    with open(path, "w") as fh:
        json.dump(out, fh, indent=2)

    print(f"Open tasks: {len(open_tasks)}   compliant: {clean} ({out['compliancePct']}%)")
    for gap, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  missing {gap}: {n}")
    print(f"Work-list: {path}")
    return 0


def validate(decision, ref_business_ids, ref_project_ids):
    """Reject anything unsafe BEFORE it reaches Airtable. Returns an error string or None."""
    field, value = decision.get("field"), decision.get("value")
    if field not in WRITABLE:
        return f"field '{field}' is not writable by the sweep"
    if value in (None, "", []):
        return "empty value"
    if field == "timeEstimate" and value not in EXPECTED_CHOICES["timeEstimate"]:
        return f"'{value}' is not a Time Estimate option"
    if field == "recurring" and value not in EXPECTED_CHOICES["recurring"]:
        return f"'{value}' is not a Recurring option"
    if field == "assignee":
        if value not in TEAM:
            return f"'{value}' is not a known team email"
    if field == "business":
        ids = value if isinstance(value, list) else [value]
        bad = [i for i in ids if i not in ref_business_ids]
        if bad:
            return f"unknown or inactive business record(s): {bad}"
    if field == "project":
        ids = value if isinstance(value, list) else [value]
        bad = [i for i in ids if i not in ref_project_ids]
        if bad:
            return f"unknown or completed project record(s): {bad}"
    if field == "dueDate":
        try:
            when = datetime.strptime(value, "%Y-%m-%d").date()
        except (TypeError, ValueError):
            return f"due date '{value}' is not YYYY-MM-DD"
        today = date.today()
        if when < today:
            return f"due date {value} is in the past — would show as Overdue immediately"
        if when > today + timedelta(days=DUE_DATE_MAX_HORIZON_DAYS):
            return f"due date {value} is more than {DUE_DATE_MAX_HORIZON_DAYS} days out"
    return None


def to_payload(field, value):
    if field == "assignee":
        return {"email": value}
    if field in ("business", "project"):
        return value if isinstance(value, list) else [value]
    return value


def cmd_apply(args):
    token = pat()
    load_schema(token)

    with open(args.decisions) as fh:
        doc = json.load(fh)
    decisions = doc["decisions"] if isinstance(doc, dict) else doc

    if args.tier == "auto":
        decisions = [d for d in decisions if WRITABLE.get(d.get("field")) == "auto"]
    print(f"{len(decisions)} decision(s) in scope (tier={args.tier})")
    if not decisions:
        print("Nothing to apply.")
        return 0

    businesses, projects = reference_data(token)
    b_ids = {b["id"] for b in businesses}
    p_ids = {p["id"] for p in projects}

    rejected = []
    for d in decisions:
        err = validate(d, b_ids, p_ids)
        if err:
            rejected.append((d, err))
    if rejected:
        print(f"\nREJECTED {len(rejected)} unsafe decision(s) — nothing was written:")
        for d, err in rejected:
            print(f"  {d.get('recordId')} {d.get('field')}={d.get('value')!r}: {err}")
        return 1

    # Read current values first so every write is reversible.
    ids = sorted({d["recordId"] for d in decisions})
    current = {}
    for rid in ids:
        rec = api("GET", f"{BASE_ID}/{TASKS}/{rid}", token)
        current[rid] = rec["fields"]

    applied, skipped = [], []
    by_record = {}
    for d in decisions:
        rid, field, value = d["recordId"], d["field"], d["value"]
        existing = current.get(rid, {}).get(fname(field))
        if existing not in (None, "", []):
            skipped.append((rid, field, "already populated — not overwriting"))
            continue
        by_record.setdefault(rid, {"fields": {}, "log": []})
        by_record[rid]["fields"][fname(field)] = to_payload(field, value)
        by_record[rid]["log"].append({
            "recordId": rid,
            "taskName": current.get(rid, {}).get(fname("name")),
            "field": field,
            "fieldName": fname(field),
            "previous": existing,
            "new": value,
            "tier": WRITABLE[field],
            "reason": d.get("reason", ""),
        })

    for rid, chunk in by_record.items():
        if args.dry_run:
            print(f"  DRY RUN {rid}: {chunk['fields']}")
        else:
            api("PATCH", f"{BASE_ID}/{TASKS}/{rid}", token, payload={"fields": chunk["fields"],
                                                                     "typecast": False})
        applied += chunk["log"]

    for rid, field, why in skipped:
        print(f"  SKIP {rid} {field}: {why}")

    if args.dry_run:
        print(f"\nDRY RUN — {len(applied)} write(s) would have been made, none were.")
        return 0

    os.makedirs(MONITORING, exist_ok=True)
    log_path = os.path.join(MONITORING, f"task-sweep-applied-{date.today()}.json")
    existing_log = []
    if os.path.exists(log_path):
        with open(log_path) as fh:
            existing_log = json.load(fh).get("writes", [])
    with open(log_path, "w") as fh:
        json.dump({"date": str(date.today()),
                   "lastRun": datetime.now().isoformat(timespec="seconds"),
                   "writes": existing_log + applied}, fh, indent=2)

    print(f"\nApplied {len(applied)} write(s) across {len(by_record)} task(s).")
    print(f"Undo log: {log_path}")
    print(f"Undo with: python3 scripts/task-hygiene-sweep.py undo --applied {log_path}")
    return 0


def cmd_undo(args):
    token = pat()
    with open(args.applied) as fh:
        writes = json.load(fh)["writes"]
    if not writes:
        print("Nothing to undo.")
        return 0

    by_record = {}
    for w in writes:
        by_record.setdefault(w["recordId"], {})[w["fieldName"]] = w["previous"]

    for rid, fields in by_record.items():
        # A previous value of None clears the field back to blank.
        payload = {k: (v if v not in (None, "") else None) for k, v in fields.items()}
        if args.dry_run:
            print(f"  DRY RUN restore {rid}: {payload}")
        else:
            api("PATCH", f"{BASE_ID}/{TASKS}/{rid}", token, payload={"fields": payload})
            print(f"  restored {rid}: {list(payload)}")

    verb = "would be restored" if args.dry_run else "restored"
    print(f"\n{len(writes)} field value(s) {verb} across {len(by_record)} task(s).")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_audit = sub.add_parser("audit", help="assess open tasks, write the work-list")
    p_audit.add_argument("--out")
    p_audit.set_defaults(func=cmd_audit)

    p_apply = sub.add_parser("apply", help="apply a decision file")
    p_apply.add_argument("--decisions", required=True)
    p_apply.add_argument("--tier", choices=["auto", "all"], default="auto")
    p_apply.add_argument("--dry-run", action="store_true")
    p_apply.set_defaults(func=cmd_apply)

    p_undo = sub.add_parser("undo", help="restore every value a run changed")
    p_undo.add_argument("--applied", required=True)
    p_undo.add_argument("--dry-run", action="store_true")
    p_undo.set_defaults(func=cmd_undo)

    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
