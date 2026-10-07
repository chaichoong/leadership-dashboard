#!/usr/bin/env python3
"""reroute-roy-admin.py: move Roy Lavin's ADMIN tasks to the agents (Property Administration first).

WHY (Kevin, 5 Oct 2026): "Roy only gets escalations for things that we can't
physically do. Anything administrative, the AI agent can do." On 7 Oct 2026 Roy
still held 75 open tasks, most of them emails, chases, quotes and filings, and
12 of the compliance ones were 14 days old or more with nothing booked. This is
the one-off move of that backlog. The rule for NEW work is in the agent file
(~/.claude/agents/property-administration.md, step 4) and in agent-dispatch's
routing, not here.

    python3 scripts/reroute-roy-admin.py            dry run (the default): prints the list, writes nothing
    python3 scripts/reroute-roy-admin.py --apply    moves them, then reads every one back

WHAT MOVES: every open task linked to Roy (his Team Members row, or Roy as
Assignee) that is NOT one of these, each printed with the reason it stays:
  * a Maintenance Ticket (the tick): a repair, his under the standing approval;
  * a physical step, matched on words in the task NAME: visit, attend, access,
    photograph, measure, clear, repair, keys, viewings, a call, in person,
    meet, a tenant moving;
  * in the repair lane (a MAINTENANCE: name with no ticket tick), a repair on
    site named by the building's fabric (a window, a leak, a boiler, an alarm):
    Roy instructs the contractor (Kevin, 2 Sep 2026);
  * placing a tenant (sign a tenant, find tenants, let a unit): viewings, the
    right to rent check and the move-in are in person, and the Q4 plan put
    these on Roy;
  * Roy's own sign-in (sign in, passcode, password, log in): nobody else can;
  * a step another script hands Roy BY DESIGN and reads his answer from: the
    tenant chain's TENANT ...: tasks (scripts/tenant-leads.py PREFIXES), the new
    tenant rent steps (scripts/rent_new_tenant.py ROY_PREFIX) and the engine's
    weekly repairs follow-up (scripts/agent-dispatch.py ROY_FOLLOWUP_NAME). Moving
    one breaks the chain: roy-assistant.py task-update refuses to record Roy's
    reply on a task that is not his. The constants are read from those files, so
    a renamed prefix is followed, and a missing one stops the run;
  * a task in Approval (Kevin's to move), or one already moved once whose Notes
    show it was linked to Roy again since (a person put it back: left alone).
Repair-lane names (MAINTENANCE: with no ticket tick) that do move are listed in
their own group, so a person can check them before --apply.

WHICH AGENT: the one whose lane the task is in, so no agent has to send it back:
an invoice, bill, utility, council tax or premium to the Supplier and Creditor
Manager; rent and Universal Credit chasing to Cash Flow Voids; everything else
to Property Administration (the ids are read from agent-dispatch.py). The dry
run prints the agent beside each task.

HOW IT MOVES: Team Member loses Roy and gains that agent (any other link is kept),
Assignee is cleared when it is Roy, and one Notes line is added:
"[<date> — reroute] Admin moved to the agent under the 5 Oct 2026 ruling; Roy
keeps the physical step." Every read and write uses field ids. Idempotent: a
moved task is no longer linked to Roy, so a second run selects nothing new.

CONTROLS: the selection is read twice and the run stops (exit 2) if the second
read differs from the first; it prints the count it expects first. A Notes field
that reads blank is written only when the same read returned Notes on other
tasks (proof the read can see the field), never on a read that saw none, and a
task whose list read showed Notes but whose fresh read shows none is not written
at all (CLAUDE.md: a blank append target is a STOP). Every written task is read
back; a mismatch exits 1.
"""

import ast
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"
LONDON = ZoneInfo("Europe/London")
# Task field ids (js/config.js TASK_FIELDS).
F = {"name": "fldgFjGBw6bTKJFCD", "status": "fldx4qCw17UfrKpaN", "team": "flduCtmQGpOA4eWaj",
     "assignee": "fldELMncVJYPDRJNc", "maintenance": "fldSEUvVA98as1HW6", "notes": "fldR7apBzSp3oxFxz"}
def const(path, name):
    """A constant, read from another script's own source (never a copy of it). A
    missing one stops the run: the list it feeds cannot be built."""
    tree = ast.parse(open(os.path.join(HERE, path)).read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", "") == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise SystemExit("ERROR: %s no longer defines %s. Nothing moved." % (path, name))


ROY_REC = "reclbdjfVev3bqNHS"                              # Team Members: Roy Lavin (Active, human)
ROY_EMAIL = const("agent-dispatch.py", "ROY_EMAIL")       # his Member collaborator's email
# The agent each moved task goes to: the lane it belongs in, so no agent has to
# send it back. Rent and Universal Credit chasing is the Cash Flow Voids agent's;
# an invoice, a bill or a payment set-up is the Supplier and Creditor Manager's
# (the Property Administration file sends money owed back to it); the rest is
# Property Administration's.
AGENT_REC = const("agent-dispatch.py", "PROPERTY_REC_ID")      # AI Property Administration
RENT_AGENT_REC = const("agent-dispatch.py", "RENT_REC_ID")     # AI Cash Flow Voids
MONEY_AGENT_REC = const("agent-dispatch.py", "CREDITOR_REC_ID")  # AI Supplier and Creditor Manager
AGENT_NAMES = {AGENT_REC: "Property Administration", RENT_AGENT_REC: "Cash Flow Voids",
               MONEY_AGENT_REC: "Supplier and Creditor Manager"}
# Money owed or a payment set up comes first: "council tax arrears" and "water
# bill arrears" are the creditor agent's, not rent. A licence fee is not here: a
# licence is Property Administration's whole lane, fee and all.
MONEY_LANE_RE = re.compile(r"\binvoice\w*|\bauto ?pay\b|direct debit|\bbills?\b|council tax|\bwater\b|"
                           r"\butilit(?:y|ies)\b|\bpremium\b|premium credit|\bfinance agreement\b|"
                           r"\benergy\b(?! performance)|\belectricity\b|gas supply|\bsuppl(?:y|ier)\b", re.I)
RENT_LANE_RE = re.compile(r"universal credit|\bUC\d*\b|\brent\b|housing costs|\barrears\b", re.I)
# Placing a tenant: viewings, the right to rent check and the move-in are done in
# person, and the Q4 plan's Project 1 put these on Roy (2 Oct 2026).
TENANT_PLACEMENT_RE = re.compile(
    r"\bsign (?:a |the )?(?:new )?tenants?\b|\bfind (?:a |new |the )?(?:new )?tenants?\b|"
    r"\blet (?:unit|room|flat)\b|\btenant into payment\b", re.I)
NOTE_TEXT = "Admin moved to the agent under the 5 Oct 2026 ruling; Roy keeps the physical step."

PHYSICAL_RE = re.compile(
    r"\b(?:visit(?:s|ed|ing)?|attend(?:s|ed|ing|ance)?|access|photo(?:s|graph\w*)?|pictures?|"
    r"measur\w*|clear(?:s|ed|ing|ance)?|repair\w*|keys?|viewings?|call(?:s|ed|ing)?|phone\w*|"
    r"in person|meet(?:s|ing)?|mov(?:e|es|ed|ing))\b", re.I)
SIGN_IN_RE = re.compile(r"\bsign(?:ed)?[- ]?in\b|\bpasscode\b|\bpassword\b|\blog(?:ged)?[- ]?in\b", re.I)
REPAIR_LANE_RE = re.compile(r"^\s*MAINTENANCE\s*:", re.I)
# In the repair lane (a MAINTENANCE: name), the fabric of the building means a
# repair a contractor does on site, which Roy instructs: Kevin's build-time ruling
# of 2 Sep 2026 sends reactive repairs to Roy the same hour, and the agent's own
# file says repairs are not its to book. The same words as the building part of
# agent-dispatch.py ROY_PATTERNS, plus the fittings tenants report. Only read on
# a MAINTENANCE: name: on a COMPLIANCE name "fire alarm" is a certificate.
REPAIR_WORDS_RE = re.compile(
    r"\b(?:replac\w*|fix\w*|broken|not working|leak\w*|beeping|damp|mould|ceiling|infestation|"
    r"pest|vermin|rats?|mice|drains?|window|door|light|lights|aerial|thermostat|boiler|heating|"
    r"plumb\w*|roof|gutter\w*|alarms?|smoke|carpets?|blinds|curtains|hinge|pipework|garden|fence|"
    r"washing machine|bins|hot water|electrics)\b", re.I)


def target_agent(name):
    """The Team Members id of the agent whose lane a moved task is in."""
    if MONEY_LANE_RE.search(str(name or "")):
        return MONEY_AGENT_REC
    if RENT_LANE_RE.search(str(name or "")):
        return RENT_AGENT_REC
    return AGENT_REC


def chain_names():
    """(prefixes, exact names) of the tasks other scripts hand Roy by design, read
    from those scripts' own constants. A missing constant stops the run."""
    prefixes = [p.strip() for p in const("tenant-leads.py", "PREFIXES").values()]
    prefixes.append(const("rent_new_tenant.py", "ROY_PREFIX").strip())
    return prefixes, [const("agent-dispatch.py", "ROY_FOLLOWUP_NAME")]


def _sel(v):
    return v.get("name", "") if isinstance(v, dict) else str(v or "")


def roy_linked(fields):
    """Why the task is Roy's ("team member" / "assignee"), or ""."""
    if ROY_REC in (fields.get(F["team"]) or []):
        return "team member"
    if str((fields.get(F["assignee"]) or {}).get("email") or "").lower() == ROY_EMAIL:
        return "assignee"
    return ""


def classify(rec, chain=((), ())):
    """(verdict, why): verdict "move" or "keep". Pure."""
    f = rec.get("fields", {}) or {}
    name = str(f.get(F["name"]) or "")
    prefixes, exact = chain
    if _sel(f.get(F["status"])) == "Approval":
        return "keep", "in Approval: Kevin's to move"
    if f.get(F["maintenance"]):
        return "keep", "Maintenance Ticket: a repair, Roy's under the standing approval"
    if NOTE_TEXT in str(f.get(F["notes"]) or ""):
        return "keep", "moved once already and linked to Roy again since: a person put it back"
    m = SIGN_IN_RE.search(name)
    if m:
        return "keep", "Roy's own sign-in (%r)" % m.group(0)
    for p in prefixes:
        if name.upper().startswith(p.upper()):
            return "keep", "handed to Roy by design and his answer is read from it (%s)" % p
    if name in exact:
        return "keep", "the engine's weekly follow-up of Roy's repairs"
    m = PHYSICAL_RE.search(name)
    if m:
        return "keep", "physical step (%r)" % m.group(0)
    m = TENANT_PLACEMENT_RE.search(name)
    if m:
        return "keep", "placing a tenant: viewings and the move-in are in person (%r)" % m.group(0)
    if REPAIR_LANE_RE.search(name):
        m = REPAIR_WORDS_RE.search(name)
        if m:
            return "keep", "a repair on site, Roy instructs it (%r)" % m.group(0)
        return "move", "repair-lane name with no ticket tick and no repair word: check before --apply"
    return "move", "admin"


def new_fields(fields, stamp):
    """The PATCH for one task (field ids). Pure. Notes gains one line; Team Member
    loses Roy and gains the agent whose lane the task is in (target_agent); any
    other link is kept; Assignee is cleared only when it is Roy."""
    agent = target_agent(fields.get(F["name"]))
    team = [x for x in (fields.get(F["team"]) or []) if x != ROY_REC]
    if agent not in team:
        team.append(agent)
    notes = str(fields.get(F["notes"]) or "").rstrip()
    line = "[%s — reroute] %s" % (stamp, NOTE_TEXT)
    out = {F["team"]: team, F["notes"]: (notes + "\n\n" + line) if notes else line}
    if str((fields.get(F["assignee"]) or {}).get("email") or "").lower() == ROY_EMAIL:
        out[F["assignee"]] = None
    return out


# ── network ──────────────────────────────────────────────────────────────

def pat():
    with open(os.path.expanduser("~/.config/od/airtable_pat")) as fh:
        return fh.read().strip()


def request(method, path, body=None):
    req = urllib.request.Request(
        "https://api.airtable.com/v0/%s%s" % (BASE_ID, path), method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + pat(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError("Airtable %s %s -> HTTP %s: %s" % (
            method, path.split("?")[0], e.code, e.read().decode("utf-8", "replace")[:300])) from None


def open_tasks():
    """Every open task, paginated, keyed by field id."""
    out, offset = [], None
    while True:
        params = [("pageSize", "100"), ("returnFieldsByFieldId", "true"),
                  ("filterByFormula", "AND({Status}!='Completed', {Status}!='Cancelled')")]
        params += [("fields[]", fid) for fid in F.values()]
        if offset:
            params.append(("offset", offset))
        body = request("GET", "/%s?%s" % (TASKS, urllib.parse.urlencode(params)))
        out += body.get("records", [])
        offset = body.get("offset")
        if not offset:
            return out


def select(rows, chain):
    """{task id: (verdict, why, record)} for every open task linked to Roy."""
    return {r["id"]: classify(r, chain) + (r,) for r in rows if roy_linked(r.get("fields", {}) or {})}


def main(argv):
    apply = "--apply" in argv
    if [a for a in argv if a != "--apply"]:
        sys.exit("usage: reroute-roy-admin.py [--apply]")
    chain = chain_names()
    rows = open_tasks()
    if len(rows) < 50:
        sys.exit("ERROR: control failed: the open-task read returned %d rows (225 on 7 Oct 2026). "
                 "Nothing moved." % len(rows))
    first = select(rows, chain)
    moving = sorted(t for t, v in first.items() if v[0] == "move")
    print("EXPECT: %d open tasks linked to Roy; %d to move to an agent, %d stay with Roy."
          % (len(first), len(moving), len(first) - len(moving)))
    second = select(open_tasks(), chain)
    again = sorted(t for t, v in second.items() if v[0] == "move")
    if again != moving or set(second) != set(first):
        print("STOP: the second read differs from the first (%d to move then, %d now; %d linked "
              "to Roy then, %d now). The board moved while this ran. Nothing moved." % (
                  len(moving), len(again), len(first), len(second)))
        return 2
    seen_notes = sum(1 for _, _, r in second.values() if str((r.get("fields") or {}).get(F["notes"]) or "").strip())
    groups = {"move: admin": [], "move: repair-lane name, check": [], "stay with Roy": []}
    for tid in sorted(second, key=lambda t: str((second[t][2].get("fields") or {}).get(F["name"]) or "")):
        verdict, why, rec = second[tid]
        line = {"id": tid, "name": str((rec.get("fields") or {}).get(F["name"]) or "")[:100], "why": why}
        if verdict == "keep":
            groups["stay with Roy"].append(line)
        elif why == "admin":
            groups["move: admin"].append(line)
        else:
            groups["move: repair-lane name, check"].append(line)
    for g, lines in groups.items():
        print("\n== %s (%d)" % (g, len(lines)))
        for ln in lines:
            to = "" if g == "stay with Roy" else "  -> %s" % AGENT_NAMES[target_agent(ln["name"])]
            print("  %s  %s%s%s" % (ln["id"], ln["name"], to, "" if g == "move: admin" else "   [%s]" % ln["why"]))
    if not apply:
        print("\nDRY RUN: nothing written. %d would move. Run with --apply to move them." % len(again))
        return 0
    if again and not seen_notes:
        print("STOP: no task linked to Roy came back with any Notes, so the read may not see the "
              "field; appending to a blank read could wipe Notes. Nothing moved.")
        return 2
    stamp = datetime.now(LONDON).strftime("%d %b %Y")
    problems = []
    for tid in again:
        # A fresh read of the one task, so a note written since the list read is kept.
        live = request("GET", "/%s/%s?returnFieldsByFieldId=true" % (TASKS, tid)).get("fields", {}) or {}
        if not roy_linked(live):
            problems.append("%s: no longer linked to Roy at write time; left alone" % tid)
            continue
        listed = str((second[tid][2].get("fields") or {}).get(F["notes"]) or "").strip()
        if listed and not str(live.get(F["notes"]) or "").strip():
            # CLAUDE.md: a field about to be appended to that reads blank is a STOP.
            # The list read saw Notes here and the fresh read did not: something is wrong.
            problems.append("%s: Notes read blank on the fresh read but not on the list read; "
                            "not written" % tid)
            continue
        patch = new_fields(live, stamp)
        agent = target_agent(live.get(F["name"]))
        request("PATCH", "/%s/%s" % (TASKS, tid), {"fields": patch, "typecast": False})
        back = request("GET", "/%s/%s?returnFieldsByFieldId=true" % (TASKS, tid)).get("fields", {}) or {}
        team = back.get(F["team"]) or []
        if ROY_REC in team or agent not in team or roy_linked(back) \
                or not str(back.get(F["notes"]) or "").endswith(patch[F["notes"]][-120:]):
            problems.append("%s: read back does not show the move (team %s)" % (tid, team))
    print("\nMOVED: %d of %d." % (len(again) - len(problems), len(again)))
    for p in problems:
        print("PROBLEM: " + p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
