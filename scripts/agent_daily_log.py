#!/usr/bin/env python3
"""agent_daily_log.py — THE one writer for the AI Agent Daily Log table.

Found 26 Aug 2026: the Daily Log table held 3 rows ever, written by two
agents, while four Built/Live agents (Creditor Management, Inbound Comms
Response, Prospecting, Reconciliation) had never logged a day in their
lives — their runtimes simply had no publish step, so the AI Agents page's
"Daily logs" check could only report a permanent wiring gap. This module is
that missing step, shared so no runtime grows its own drifting copy:

  * scripts/agent-dispatch.py imports it (write_register_reading publishes a
    row every time a role agent's score is computed, so Creditor Management
    and Inbound Comms Response log on every slot run);
  * the prospect-daily-run and daily-transaction-reconciler routines call
    the CLI at the end of a run:

      python3 scripts/agent_daily_log.py publish --agent-row recXXX \
          --name "Reconciliation" --summary "<one line>" \
          --decisions "<a few lines of the day's calls>"

Semantics: ONE row per agent per day, keyed on Log Day = "<name> - <date>",
upserted exactly like inbound-triage.py's publish. A failed lookup NEVER
falls through to a create (the documented silent-zero duplicate trap): the
publish raises instead, and the caller decides whether that kills the run
(the CLI exits 1; agent-dispatch prints a warning and keeps its score write,
because the page's silence alarm is the designed backstop for a broken log).
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date

BASE_ID = "appnqjDpqDniH3IRl"
DAILY_LOG_TABLE = "tbl6VQKVMnK0Q7hbJ"
# Field IDs mirror ALOG in os/agents/index.html and inbound-triage.py.
ALOG = {
    "logDay":    "fldNLubsilKUL6fyd",
    "date":      "fldr9ktRlG8e93AMN",
    "agent":     "fld8OSVSzfXcDjDIl",   # link to AI Agents register rows
    "summary":   "fld0vrdlfSiZjR6wg",
    "decisions": "fldTwM2eJvNyUibi4",
}


def _pat():
    with open(os.path.expanduser("~/.config/od/airtable_pat")) as fh:
        return fh.read().strip()


def _request(method, path, body=None):
    url = f"https://api.airtable.com/v0/{BASE_ID}/{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {_pat()}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"Airtable {method} {path} -> HTTP {e.code}: "
            f"{e.read().decode('utf-8', 'replace')[:300]}") from None


def build_fields(agent_row, agent_name, summary, decisions, today=None):
    """Pure: the row an upsert writes. Kept separate so tests exercise the
    real shape without network."""
    today = today or date.today().isoformat()
    log_day = f"{agent_name} - {today}"
    return log_day, {
        ALOG["logDay"]: log_day,
        ALOG["date"]: today,
        ALOG["agent"]: [agent_row],
        ALOG["summary"]: str(summary or "").strip()[:5000],
        ALOG["decisions"]: str(decisions or "").strip()[:20000],
    }


def publish(agent_row, agent_name, summary, decisions, today=None):
    """Upsert the agent's row for the day. Raises on any Airtable failure —
    a failed LOOKUP must never fall through to a create."""
    if not str(agent_row).startswith("rec"):
        raise ValueError(f"agent_row must be an AI Agents record id, got {agent_row!r}")
    if not str(agent_name).strip():
        raise ValueError("agent_name is required — it keys the Log Day upsert")
    log_day, fields = build_fields(agent_row, agent_name, summary, decisions, today)
    formula = urllib.parse.quote("{Log Day}='%s'" % log_day.replace("'", "\\'"))
    found = _request("GET", f"{DAILY_LOG_TABLE}?filterByFormula={formula}&maxRecords=2")
    recs = found.get("records", [])
    if recs:
        # No typecast on purpose: with it, a wrong record id in the agent
        # link is "helpfully" turned into a brand-new phantom register row
        # and the publish exits green while the real agent stays invisible.
        # Without it, a bad id 422s loudly, which is the guard we want.
        _request("PATCH", f"{DAILY_LOG_TABLE}/{recs[0]['id']}",
                 {"fields": fields})
        return {"published": "updated", "log_day": log_day}
    _request("POST", DAILY_LOG_TABLE, {"records": [{"fields": fields}]})
    return {"published": "created", "log_day": log_day}


def selftest():
    checks = []

    def check(label, cond):
        checks.append((label, bool(cond)))

    log_day, f = build_fields("recABC123", "Reconciliation", " ran fine ",
                              "matched 12\nheld 2", today="2026-08-26")
    check("log day keys name and date", log_day == "Reconciliation - 2026-08-26")
    check("agent link carries the register row", f[ALOG["agent"]] == ["recABC123"])
    check("summary is trimmed", f[ALOG["summary"]] == "ran fine")
    check("date field matches the key", f[ALOG["date"]] == "2026-08-26")
    long = build_fields("recABC123", "X", "s", "d" * 30000, today="2026-08-26")[1]
    check("decisions capped under Airtable's long-text ceiling",
          len(long[ALOG["decisions"]]) == 20000)
    try:
        publish("not-a-rec", "X", "s", "d")
        check("bad agent row rejected", False)
    except ValueError:
        check("bad agent row rejected", True)
    try:
        publish("recABC123", "  ", "s", "d")
        check("blank name rejected", False)
    except ValueError:
        check("blank name rejected", True)

    failed = [label for label, ok in checks if not ok]
    print(json.dumps({"checks": len(checks), "failed": failed}))
    return 1 if failed else 0


def main(argv):
    if argv and argv[0] == "selftest":
        return selftest()
    if not argv or argv[0] != "publish":
        print(__doc__)
        return 1
    args = {}
    i = 1
    while i < len(argv):
        if not argv[i].startswith("--"):
            print(f"unknown argument {argv[i]}", file=sys.stderr)
            return 1
        if i + 1 >= len(argv):
            print(f"{argv[i]} is missing its value", file=sys.stderr)
            return 1
        args[argv[i][2:]] = argv[i + 1]
        i += 2
    missing = [k for k in ("agent-row", "name", "summary") if not args.get(k)]
    if missing:
        print("publish needs --agent-row, --name, --summary "
              f"(missing: {', '.join(missing)}); --decisions optional",
              file=sys.stderr)
        return 1
    try:
        out = publish(args["agent-row"], args["name"], args["summary"],
                      args.get("decisions", ""))
    except Exception as e:  # surfaced to the caller, never swallowed
        print(f"DAILY LOG PUBLISH FAILED: {e}", file=sys.stderr)
        return 1
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
