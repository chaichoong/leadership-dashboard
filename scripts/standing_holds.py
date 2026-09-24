#!/usr/bin/env python3
"""Standing holds: a ruling of Kevin's that stays true only until something happens.

Kevin, 24 Sep 2026: feedback is sometimes only relevant to one time or one situation. His example
was a council's tax accounts, where everything waits on one officer's reply, and "once he responds,
that rule will no longer exist". A permanent "Lessons from Kevin" line cannot express that, because
lessons are never deleted, so a stale hold would block the work for ever. It also reached only the
agent whose card carried it: on 23 Sep 2026 the Task Board Manager raised eight cards Kevin had
already ruled on, because the ruling sat in the two inbox agents' files and not in its own.

A hold is written ONCE, for the whole team, with its end condition:

  - `match`   what it covers: every `name` pattern must hit the task NAME, every `all` pattern the
              name + description, and no `none` pattern either. The subject of a hold goes in `name`:
              a long description mentions a council tax figure in passing (a growth-plan task did, on
              the first dry run, 24 Sep 2026). Never the Notes: those carry every agent's run log (the
              alert-lane lesson, 14 Sep 2026).
  - `lift`    the event that ends it, as a Gmail query (a reply from a named sender). Found = lifted.
  - `review_by`  the date it ends anyway. A hold nobody lifts cannot hide work for ever: on that
              date its tasks come back to their owners with a note saying the reply never came.
  - `examples`   task names it must hold and names it must leave alone. Checked on every run; a
              hold whose own examples fail is BROKEN and holds nothing (a typo'd pattern would
              otherwise read as "nothing to hold" for ever).

The holds live in a private file (HOLDS_FILE), never in this public repo, because they carry
property addresses and people's names.

What a hold does to a task (`run`, every 30 minutes on the hand-back poll):
  park     Status -> Upcoming, Some Day ticked, Notes stamped HELD (<id>, was <status>). Some Day is
           the estate's existing "parked on purpose" flag: dispatch, the Task Manager's board, the
           09:00 brief, loop-health and the task-hygiene sweep all leave it alone already.
  release  when the hold is lifted or expires: Status -> Today, Some Day cleared, Notes stamped
           HOLD ENDED (<id>) with the evidence, so the owning agent picks it up and reads why.
An approval Kevin gave AFTER the hold began is his newer word on that exact task and is never held.

Usage:
  python3 scripts/standing_holds.py list [--json]
  python3 scripts/standing_holds.py run [--dry-run]
  python3 scripts/standing_holds.py match --text "task name ..."
  python3 scripts/standing_holds.py end --id ID --why "Kevin said lift it"
  python3 scripts/standing_holds.py add --id ID --title T --ruling "Kevin's words" --source recTASK \
      --name REGEX [--name ...] [--all REGEX ...] [--none REGEX ...] --review-by YYYY-MM-DD \
      [--lift-query "gmail query" --lift-label "whose reply"] \
      --held-example "task name" [...] --free-example "task name" [...] [--write]
      (without --write it is a dry run: it prints what the hold would park and saves nothing)
  python3 scripts/standing_holds.py selftest
Exit: 0 clean, 1 anything broken (unreadable file, failed control, failed write, orphaned stamp).
Auth: ~/.config/od/airtable_pat (never printed); Gmail through scripts/inbound-triage.py search.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

BASE_ID = "appnqjDpqDniH3IRl"
TASKS = "tblqB8b22hKBL4PF1"
HOLDS_FILE = Path(os.environ.get("OD_HOLDS_FILE",
                                 Path.home() / ".config/od/standing-holds.json"))
PAT_FILE = Path.home() / ".config/od/airtable_pat"
TRIAGE = Path(__file__).resolve().parent / "inbound-triage.py"
LONDON = ZoneInfo("Europe/London")
WHO = "standing-holds"

APPROVED = ("Approved as-is", "Approved with minor edits")
# The statuses a hold reads. Completed and Cancelled are finished; a parked
# (Some Day) task is already out of every lane.
HOLDABLE = ("Today", "Overdue", "Approval", "Upcoming")
HELD_MARK = "HELD ("
ENDED_MARK = "HOLD ENDED ("
RELEASE_STATUS = "Today"
# A new hold may cover at most this many open tasks. A wider one is a pattern
# that has caught more than Kevin said, not a bigger ruling.
MAX_HELD = 15
MAX_REVIEW_DAYS = 90


# ─── THE HOLDS FILE ───────────────────────────────────────────────────

def load_holds(path=None):
    """Every hold in the file. A missing file is no holds; an unreadable one raises."""
    path = Path(path or HOLDS_FILE)
    if not path.exists():
        return []
    with open(path) as fh:
        data = json.load(fh)
    holds = data.get("holds")
    if not isinstance(holds, list):
        raise ValueError(f"{path}: expected a 'holds' list")
    return holds


def save_holds(holds, path=None):
    """Temp file then os.replace: a reader can never see a half-written file."""
    path = Path(path or HOLDS_FILE)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".standing-holds.")
    with os.fdopen(fd, "w") as fh:
        json.dump({"holds": holds}, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, path)


def active(holds):
    return [h for h in holds if h.get("status") == "active"]


# ─── MATCHING ─────────────────────────────────────────────────────────

def _compiled(patterns):
    return [re.compile(p, re.I) for p in patterns or []]


def split_example(text):
    """An example is the task name, then optionally a newline and its description."""
    name, _, description = str(text or "").partition("\n")
    return name, description


def matches(hold, name, description=""):
    """Does this hold cover a task with this name and description?"""
    m = hold.get("match") or {}
    names, alls, nones = _compiled(m.get("name")), _compiled(m.get("all")), _compiled(m.get("none"))
    if not (names or alls):
        return False          # a hold with no pattern holds nothing, never everything
    name = str(name or "")
    whole = f"{name}\n{description or ''}"
    return (all(p.search(name) for p in names) and all(p.search(whole) for p in alls)
            and not any(p.search(whole) for p in nones))


def example_problems(hold):
    """Why this hold's own examples do not classify as declared, or []. A hold with no example
    of what it must hold is refused: nothing would prove its patterns can match anything."""
    m = hold.get("match") or {}
    for p in m.get("name", []) + m.get("all", []) + m.get("none", []):
        try:
            re.compile(p, re.I)
        except re.error as e:
            return [f"bad pattern {p!r}: {e}"]
    ex = hold.get("examples") or {}
    held, free = ex.get("held") or [], ex.get("free") or []
    out = []
    if not held:
        out.append("no example of a task it must hold")
    if not free:
        out.append("no example of a task it must leave alone")
    out += [f"does not hold its own example: {t!r}" for t in held if not matches(hold, *split_example(t))]
    out += [f"holds a task it must leave alone: {t!r}" for t in free if matches(hold, *split_example(t))]
    return out


def approved_after_start(task, hold):
    """Kevin approved this exact task after the hold began: his newer word wins."""
    if task.get("outcome") not in APPROVED:
        return False
    at = str(task.get("approvedAt") or "")[:10]
    return bool(at) and at > str(hold.get("created") or "")


def hold_for(task, holds):
    """The first active, sound hold covering this task (a dict with name/description/outcome/
    approvedAt), or None. The shared entry point: agent-dispatch's queue uses it too."""
    for h in active(holds):
        if example_problems(h):
            continue
        if (matches(h, task.get("name"), task.get("description"))
                and not approved_after_start(task, h)):
            return h
    return None


# ─── NOTES STAMPS ─────────────────────────────────────────────────────

def stamp():
    return datetime.now(LONDON).strftime("%d %b %Y %H:%M")


def note_line(text):
    return f"[{stamp()} — {WHO}] {text}"


def append_notes(existing, line):
    return (str(existing or "").rstrip() + "\n\n" + line).strip()[-90000:]


def held_line(hold, prior_status):
    return note_line(
        f"{HELD_MARK}{hold['id']}, was {prior_status}): {hold.get('title', '')}. "
        f"Kevin: \"{hold.get('ruling', '')}\" Nobody acts on this until {hold.get('lift', {}).get('label', 'the hold ends')}, "
        f"or {hold.get('review_by', '?')} at the latest.")


def ended_line(hold, why):
    return note_line(f"{ENDED_MARK}{hold['id']}): {why} This task is yours again: read why before acting.")


def carries_open_hold(notes, hold_id):
    """The task's Notes hold a HELD stamp for this hold with no HOLD ENDED after it."""
    notes = str(notes or "")
    held = notes.rfind(f"{HELD_MARK}{hold_id},")
    return held >= 0 and notes.rfind(f"{ENDED_MARK}{hold_id})") < held


def open_hold_ids(notes):
    ids = set(re.findall(r"HELD \(([a-z0-9-]+),", str(notes or "")))
    return {i for i in ids if carries_open_hold(notes, i)}


# ─── AIRTABLE ─────────────────────────────────────────────────────────

def pat():
    return PAT_FILE.read_text().strip()


def airtable(method, path, token, params=None, body=None):
    url = f"https://api.airtable.com/v0/{BASE_ID}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Airtable {method} HTTP {e.code}: "
                           f"{e.read().decode('utf-8', 'replace')[:200]}") from None


FIELDS = ["Task Name", "Description", "Notes", "Status", "Some Day",
          "Approval Outcome", "Approved At"]


def query_tasks(token, formula):
    """Every page. A missed page is a task left unheld or never released."""
    out, offset = [], None
    while True:
        params = [("pageSize", "100"), ("filterByFormula", formula)]
        params += [("fields[]", f) for f in FIELDS]
        if offset:
            params.append(("offset", offset))
        body = airtable("GET", TASKS, token, params)
        out += body.get("records", [])
        offset = body.get("offset")
        if not offset:
            return out


def task_of(rec):
    f = rec.get("fields", {})
    outcome = f.get("Approval Outcome")
    return {"id": rec["id"], "name": f.get("Task Name", ""), "description": f.get("Description", ""),
            "notes": f.get("Notes", ""), "status": f.get("Status", ""), "someDay": bool(f.get("Some Day")),
            "outcome": outcome.get("name") if isinstance(outcome, dict) else (outcome or ""),
            "approvedAt": f.get("Approved At", "")}


def patch(token, rec_id, fields):
    airtable("PATCH", f"{TASKS}/{rec_id}", token, body={"fields": fields})


# ─── GMAIL (the lift) ─────────────────────────────────────────────────

def gmail_count(query, account=None):
    """How many messages the triage mailbox search finds; raises when the search itself fails,
    so a broken read is never taken for 'no reply yet'."""
    cmd = [sys.executable, str(TRIAGE), "search", "--q", query, "--limit", "5"]
    if account:
        cmd += ["--account", account]
    done = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if done.returncode != 0:
        raise RuntimeError(f"Gmail search failed: {(done.stderr or done.stdout)[-200:]}")
    body = json.loads(done.stdout)
    return int(body.get("count") or 0), body.get("messages") or []


def gmail_date(iso_day):
    return str(iso_day).replace("-", "/")


def lift_evidence(hold, search=gmail_count):
    """(lifted?, evidence). Raises on a broken read. When the dated search finds nothing, the same
    search without the date must still find the sender's past mail: that is the control proving
    the query can see his messages at all."""
    lift = hold.get("lift") or {}
    q = lift.get("gmail_query")
    if not q:
        return False, "no lift query: this hold ends on its review date only"
    since = lift.get("after") or hold.get("created")
    count, msgs = search(f"{q} after:{gmail_date(since)}", lift.get("account"))
    if count:
        m = msgs[0] if msgs else {}
        return True, (f"{lift.get('label', 'the awaited reply')} arrived {m.get('when', '')} "
                      f"(Gmail {m.get('id', '?')}: {str(m.get('snippet', ''))[:140]})")
    control, _ = search(q, lift.get("account"))
    if not control:
        raise RuntimeError(f"lift control failed for {hold['id']}: the query finds none of the "
                           "sender's past mail, so it cannot see a reply either")
    return False, f"no reply since {since} ({control} earlier message(s) prove the search works)"


# ─── RUN ──────────────────────────────────────────────────────────────

def today_london():
    return datetime.now(LONDON).date().isoformat()


def open_formula():
    statuses = ",".join(f"{{Status}}='{s}'" for s in HOLDABLE)
    return f"AND(OR({statuses}),NOT({{Some Day}}))"


def parked_formula():
    return "AND({Some Day},FIND('" + HELD_MARK + "',{Notes}&''))"


def run(token, holds, dry_run=False, search=gmail_count, today=None, write=None):
    """One pass: end what has ended, release its tasks, park what an active hold covers.
    Returns the report; report['errors'] non-empty means exit 1."""
    today = today or today_london()
    write = write or (lambda rec_id, fields: patch(token, rec_id, fields))
    report = {"today": today, "dryRun": dry_run, "holds": [], "orphans": [], "errors": []}
    changed = False

    # 1. End holds whose event has happened or whose review date has passed.
    for h in active(holds):
        row = {"id": h["id"], "title": h.get("title", "")}
        problems = example_problems(h)
        if problems:
            report["errors"].append(f"hold {h['id']} is BROKEN and holds nothing: " + "; ".join(problems))
            row["broken"] = problems
            report["holds"].append(row)
            continue
        try:
            lifted, evidence = lift_evidence(h, search)
        except Exception as e:  # noqa: BLE001 — a failed read is NOT CHECKED, never "no reply"
            report["errors"].append(f"hold {h['id']}: lift NOT CHECKED — {str(e)[:200]}")
            lifted, evidence = False, "NOT CHECKED"
        row["lift"] = evidence
        if lifted:
            h.update(status="lifted", ended={"at": today, "why": evidence})
        elif str(h.get("review_by") or "9999") < today:
            h.update(status="expired", ended={"at": today, "why": (
                f"review date {h.get('review_by')} passed and {h.get('lift', {}).get('label', 'the awaited event')} "
                "never came. Chase it, or ask Kevin whether the hold still stands.")})
        if h.get("status") != "active":
            changed = True
            row["ended"] = h["status"]
        report["holds"].append(row)

    by_id = {h["id"]: h for h in holds}

    # 2. Release every task still stamped by a hold that is no longer active; flag unknown stamps.
    parked = [task_of(r) for r in query_tasks(token, parked_formula())]
    for t in parked:
        for hid in open_hold_ids(t["notes"]):
            h = by_id.get(hid)
            if h is None:
                report["orphans"].append({"task": t["id"], "hold": hid, "name": t["name"]})
                continue
            if h.get("status") == "active":
                continue
            why = f"{h['status'].upper()}: {h.get('ended', {}).get('why', '')}"
            _row(report, hid)["released"].append(t["id"])
            if not dry_run:
                try:
                    write(t["id"], {"Status": RELEASE_STATUS, "Some Day": False,
                                    "Notes": append_notes(t["notes"], ended_line(h, why))})
                except Exception as e:  # noqa: BLE001
                    report["errors"].append(f"release {t['id']} failed: {str(e)[:200]}")
    if report["orphans"]:
        report["errors"].append(f"{len(report['orphans'])} task(s) parked by a hold the file does "
                                "not know: they will never be released until someone looks")

    # 3. Park every open task an active hold covers. The read has a control: an empty open board
    #    is a broken read, not a quiet one.
    live = [h for h in active(holds) if not example_problems(h)]
    if live:
        open_tasks = [task_of(r) for r in query_tasks(token, open_formula())]
        if not open_tasks:
            report["errors"].append("control failed: zero open tasks read — the read is broken, "
                                    "not the board empty")
        for t in open_tasks:
            h = hold_for(t, live)
            if not h:
                continue
            _row(report, h["id"])["parked"].append({"id": t["id"], "name": t["name"][:80],
                                                   "was": t["status"]})
            if not dry_run:
                try:
                    write(t["id"], {"Status": "Upcoming", "Some Day": True,
                                    "Notes": append_notes(t["notes"], held_line(h, t["status"]))})
                except Exception as e:  # noqa: BLE001
                    report["errors"].append(f"park {t['id']} failed: {str(e)[:200]}")

    if changed and not dry_run:
        save_holds(holds)
    return report


def _row(report, hold_id):
    for r in report["holds"]:
        if r["id"] == hold_id:
            r.setdefault("parked", [])
            r.setdefault("released", [])
            return r
    r = {"id": hold_id, "parked": [], "released": []}
    report["holds"].append(r)
    return r


# ─── COMMANDS ─────────────────────────────────────────────────────────

def cmd_list(as_json):
    holds = load_holds()
    if as_json:
        print(json.dumps({"file": str(HOLDS_FILE), "holds": holds}, indent=2, ensure_ascii=False))
        return 0
    if not holds:
        print(f"No standing holds ({HOLDS_FILE}).")
        return 0
    for h in holds:
        print(f"{h['id']}  [{h.get('status')}]  {h.get('title', '')}")
        print(f"   Kevin: \"{h.get('ruling', '')}\"")
        print(f"   ends when: {h.get('lift', {}).get('label', '(review date only)')}; "
              f"review by {h.get('review_by', '?')}")
        if h.get("ended"):
            print(f"   ended {h['ended'].get('at')}: {h['ended'].get('why')}")
        for p in example_problems(h):
            print(f"   BROKEN: {p}")
    return 0


def cmd_run(dry_run):
    report = run(pat(), load_holds(), dry_run=dry_run)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 1 if report["errors"] else 0


def cmd_match(text):
    holds = load_holds()
    h = hold_for({"name": text}, holds)
    print(json.dumps({"text": text, "hold": h["id"] if h else None}))
    return 0


def cmd_end(hold_id, why):
    holds = load_holds()
    h = next((x for x in holds if x.get("id") == hold_id), None)
    if not h:
        print(f"ERROR: no hold {hold_id!r} in {HOLDS_FILE}", file=sys.stderr)
        return 1
    if h.get("status") != "active":
        print(f"ERROR: hold {hold_id} is already {h.get('status')}", file=sys.stderr)
        return 1
    h.update(status="lifted", ended={"at": today_london(), "why": why})
    save_holds(holds)
    print(f"Hold {hold_id} lifted. Its tasks return to their owners on the next run.")
    return 0


def add_problems(hold, holds, today):
    """Why this new hold must not be saved, or []. Pure: no network."""
    out = []
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", str(hold.get("id") or "")):
        out.append("--id must be lower-case words joined by hyphens")
    if any(h.get("id") == hold.get("id") for h in holds):
        out.append(f"a hold called {hold.get('id')!r} already exists")
    if not str(hold.get("ruling") or "").strip():
        out.append("--ruling must carry Kevin's own words")
    if not re.search(r"\brec[A-Za-z0-9]{14}\b", str(hold.get("source") or "")):
        out.append("--source must name the task where Kevin said it (a rec id)")
    if not (hold.get("match") or {}).get("name"):
        out.append("--name is required: the subject of the hold must be in the task name")
    try:
        days = (date.fromisoformat(str(hold.get("review_by"))) - date.fromisoformat(today)).days
        if not 1 <= days <= MAX_REVIEW_DAYS:
            out.append(f"--review-by must be 1 to {MAX_REVIEW_DAYS} days away")
    except ValueError:
        out.append("--review-by must be a date, YYYY-MM-DD")
    lift = hold.get("lift") or {}
    if bool(lift.get("gmail_query")) != bool(lift.get("label")):
        out.append("--lift-query and --lift-label go together")
    return out + example_problems(hold)


def cmd_add(argv):
    def many(flag):
        return [argv[i + 1] for i, a in enumerate(argv[:-1]) if a == flag]

    def one(flag):
        vals = many(flag)
        return vals[-1] if vals else ""

    today = today_london()
    hold = {"id": one("--id"), "title": one("--title"), "status": "active",
            "ruling": one("--ruling"), "source": one("--source"), "created": today,
            "review_by": one("--review-by"),
            "match": {"name": many("--name"), "all": many("--all"), "none": many("--none")},
            "examples": {"held": many("--held-example"), "free": many("--free-example")}}
    if one("--lift-query") or one("--lift-label"):
        hold["lift"] = {"gmail_query": one("--lift-query"), "after": today,
                        "label": one("--lift-label")}
    holds = load_holds()
    problems = add_problems(hold, holds, today)
    if problems:
        print(json.dumps({"saved": False, "problems": problems}, indent=2, ensure_ascii=False))
        return 1
    token = pat()
    would = [t for t in (task_of(r) for r in query_tasks(token, open_formula()))
             if hold_for(t, [hold])]
    report = {"hold": hold, "wouldPark": [{"id": t["id"], "name": t["name"][:80]} for t in would]}
    if len(would) > MAX_HELD:
        report.update(saved=False, problems=[f"it would park {len(would)} open tasks (limit {MAX_HELD}): "
                                             "the patterns catch more than Kevin said"])
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 1
    if "--write" in argv:
        save_holds(holds + [hold])
        report["saved"] = True
    else:
        report["saved"] = False
        report["dryRun"] = "nothing saved: add --write to save it"
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


# ─── SELFTEST ─────────────────────────────────────────────────────────

SAMPLE = {
    "id": "sample-council-tax", "title": "Sample council tax hold", "status": "active",
    "ruling": "Nothing on Sampletown council tax until the officer replies.",
    "created": "2026-09-23", "review_by": "2026-10-23",
    "match": {"name": [r"council\s*tax|standing order|(?-i:\bSO\b)"],
              "all": [r"sampletown|maple|(?-i:\b\d+\s?MP\b)"],
              "none": [r"\bwater\b"]},
    "lift": {"gmail_query": "from:council.example Officer", "label": "the officer's reply"},
    "examples": {"held": ["Update SO amount - 5 Maple - £129 per month"],
                 "free": ["Council Tax 18 Other Road enforcement reply",
                          "Growth plan: collect dates of birth\nNote: council tax figures per house in Sampletown",
                          "Set up Standing Order - water payment plan - 3 MP",
                          "COMPLIANCE: EICR quote for both Sampletown properties so we can book"]},
}


def selftest():
    failed = []

    def check(name, cond):
        print(("PASS " if cond else "FAIL ") + name)
        if not cond:
            failed.append(name)

    h = json.loads(json.dumps(SAMPLE))
    check("sample hold is sound", example_problems(h) == [])
    check("lowercase 'so' alone is not a topic", not matches(h, "Sampletown EICR so we can book"))
    check("a name that matches its place and topic is held", matches(h, "Pay council tax for 3 MP"))
    check("the place may sit in the description", matches(h, "Council tax overdue", "Letter from Sampletown"))
    check("the topic may NOT sit only in the description",
          not matches(h, "Growth plan", "council tax figures per house in Sampletown"))
    check("excluded word wins", not matches(h, "Sampletown council tax water bill"))
    bad = json.loads(json.dumps(SAMPLE))
    bad["match"]["all"][0] = "sampeltown"
    check("a typo'd pattern is BROKEN, not silent", any("does not hold" in p for p in example_problems(bad)))
    bad_re = json.loads(json.dumps(SAMPLE))
    bad_re["match"]["name"] = ["council (tax"]
    try:
        check("an invalid pattern is BROKEN, not a crash", any("bad pattern" in p or "does not hold" in p
                                                           for p in example_problems(bad_re)))
    except re.error:
        check("an invalid pattern is BROKEN, not a crash", False)
    none_ex = json.loads(json.dumps(SAMPLE))
    none_ex["examples"] = {}
    check("a hold with no examples is refused", len(example_problems(none_ex)) == 2)
    check("no patterns holds nothing", not matches({"match": {"all": [], "name": []}}, "anything at all"))

    new = json.loads(json.dumps(SAMPLE))
    new.update(id="new-hold", source="Kevin on recABCDEFGHIJKLMN, 24 Sep 2026", review_by="2026-10-20")
    check("a sound new hold passes the add gate", add_problems(new, [h], "2026-09-24") == [])
    check("add refuses a duplicate id", add_problems(dict(new, id=h["id"]), [h], "2026-09-24") != [])
    check("add refuses a hold with no source task", add_problems(dict(new, source="Kevin said"), [], "2026-09-24") != [])
    check("add refuses a review date too far out", add_problems(dict(new, review_by="2027-06-01"), [], "2026-09-24") != [])
    check("add refuses a hold with no name pattern",
          add_problems(dict(new, match={"all": new["match"]["all"]}), [], "2026-09-24") != [])

    task = {"name": "Update SO amount - 5 Maple", "outcome": "Approved as-is", "approvedAt": "2026-09-24T10:00:00Z"}
    check("an approval after the hold began wins", hold_for(task, [h]) is None)
    task["approvedAt"] = "2026-09-23T12:54:00Z"
    check("an approval on or before the start is still held", hold_for(task, [h]) is not None)

    notes = note_line("HELD (sample-council-tax, was Today): x")
    check("an open stamp is found", open_hold_ids(notes) == {"sample-council-tax"})
    check("an ended stamp closes it", open_hold_ids(notes + "\n" + ended_line(h, "done")) == set())

    # The lift: found, not found with a working control, and a broken query.
    check("lift when the reply is found",
          lift_evidence(h, lambda q, a: (1, [{"when": "2026-09-30", "id": "m1", "snippet": "Dear"}]))[0])
    check("no lift when only older mail exists",
          lift_evidence(h, lambda q, a: (0, []) if "after:" in q else (3, []))[0] is False)
    try:
        lift_evidence(h, lambda q, a: (0, []))
        check("a query that sees no mail at all fails loudly", False)
    except RuntimeError:
        check("a query that sees no mail at all fails loudly", True)

    # run(): park, lift, release, orphan, all through a fake board.
    board = {
        "recHELD": {"Task Name": "Update SO amount - 5 Maple", "Status": "Today", "Notes": ""},
        "recFREE": {"Task Name": "Council Tax 18 Other Road", "Status": "Today", "Notes": ""},
    }
    writes = []

    def fake_query(_token, formula):
        rows = []
        for rid, f in board.items():
            parked = bool(f.get("Some Day"))
            if ("Some Day},FIND" in formula) == parked:
                if parked and HELD_MARK not in (f.get("Notes") or ""):
                    continue
                rows.append({"id": rid, "fields": dict(f)})
        return rows

    def fake_write(rid, fields):
        writes.append((rid, fields))
        board[rid].update(fields)

    real_query = globals()["query_tasks"]
    globals()["query_tasks"] = fake_query
    tmpdir = tempfile.mkdtemp()
    real_file = globals()["HOLDS_FILE"]
    globals()["HOLDS_FILE"] = Path(tmpdir) / "holds.json"
    try:
        no_reply = lambda q, a: (0, []) if "after:" in q else (2, [])  # noqa: E731
        holds = [json.loads(json.dumps(SAMPLE))]
        rep = run("t", holds, search=no_reply, today="2026-09-24", write=fake_write)
        check("run parks the covered task", board["recHELD"]["Some Day"] is True
              and board["recHELD"]["Status"] == "Upcoming" and "HELD (sample-council-tax, was Today)" in board["recHELD"]["Notes"])
        check("run leaves the other council alone", "Some Day" not in board["recFREE"])
        check("a clean run reports no errors", rep["errors"] == [])
        n = len(writes)
        run("t", holds, search=no_reply, today="2026-09-24", write=fake_write)
        check("a second run writes nothing (parked tasks are out of the read)", len(writes) == n)
        replied = lambda q, a: (1, [{"when": "2026-10-02", "id": "m9", "snippet": "Dear Mr"}])  # noqa: E731
        rep = run("t", holds, search=replied, today="2026-10-02", write=fake_write)
        check("the reply lifts the hold", holds[0]["status"] == "lifted")
        check("the lift releases the task to Today", board["recHELD"]["Status"] == "Today"
              and board["recHELD"]["Some Day"] is False and "HOLD ENDED (sample-council-tax)" in board["recHELD"]["Notes"])
        check("the lifted hold is saved", json.loads(Path(globals()["HOLDS_FILE"]).read_text())["holds"][0]["status"] == "lifted")
        # Expiry: a fresh hold whose review date passes with no reply.
        board["recHELD"].update({"Status": "Today", "Some Day": False, "Notes": ""})
        holds = [json.loads(json.dumps(SAMPLE))]
        run("t", holds, search=no_reply, today="2026-09-24", write=fake_write)
        rep = run("t", holds, search=no_reply, today="2026-10-24", write=fake_write)
        check("a passed review date expires the hold", holds[0]["status"] == "expired")
        check("expiry releases the task with the reason", board["recHELD"]["Status"] == "Today"
              and "never came" in board["recHELD"]["Notes"])
        # Orphan: a stamp for a hold the file does not know.
        board["recHELD"].update({"Some Day": True, "Status": "Upcoming",
                                 "Notes": note_line("HELD (ghost-hold, was Today): x")})
        rep = run("t", holds, search=no_reply, today="2026-10-25", write=fake_write)
        check("an orphaned stamp fails the run", rep["orphans"] and rep["errors"])
        # A broken hold holds nothing and fails the run.
        board["recHELD"].update({"Some Day": False, "Status": "Today", "Notes": ""})
        broken = json.loads(json.dumps(SAMPLE))
        broken["match"]["all"][0] = "sampeltown"
        rep = run("t", [broken], search=no_reply, today="2026-09-24", write=fake_write)
        check("a broken hold parks nothing", board["recHELD"].get("Some Day") is False)
        check("a broken hold fails the run", any("BROKEN" in e for e in rep["errors"]))
        # Dry run writes nothing.
        n = len(writes)
        run("t", [json.loads(json.dumps(SAMPLE))], dry_run=True, search=no_reply, today="2026-09-24",
            write=fake_write)
        check("a dry run writes nothing", len(writes) == n)
    finally:
        globals()["query_tasks"] = real_query
        globals()["HOLDS_FILE"] = real_file

    print(f"\n{'ALL PASS' if not failed else str(len(failed)) + ' FAILED'}")
    return 0 if not failed else 1


def main(argv):
    def opt(flag, default=None):
        return argv[argv.index(flag) + 1] if flag in argv and argv.index(flag) + 1 < len(argv) else default

    cmd = argv[0] if argv else ""
    try:
        if cmd == "list":
            return cmd_list("--json" in argv)
        if cmd == "run":
            return cmd_run("--dry-run" in argv)
        if cmd == "match" and opt("--text"):
            return cmd_match(opt("--text"))
        if cmd == "end" and opt("--id") and opt("--why"):
            return cmd_end(opt("--id"), opt("--why"))
        if cmd == "add":
            return cmd_add(argv)
        if cmd == "selftest":
            return selftest()
    except Exception as e:  # noqa: BLE001 — the caller must see a broken run, never a quiet one
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
