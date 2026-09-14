#!/usr/bin/env python3
"""Estate status: one Airtable row per scheduled job, kept current, read by the
Estate status tab on the AI Agents page (os/agents/index.html).

WHY THIS EXISTS (Kevin's audit, 14 Sep 2026)
--------------------------------------------
From 13:00 on Friday 11 Sep to 19:00 on Sunday 13 Sep nothing ran: the Claude
allowance had run out. Inbox triage lost nine slots, the task board pass nine,
the hand-back poll 106 of 128 ticks. Every wrapper wrote its failure line into
~/knowledge-os/logs/job-status.jsonl, the Sunday digest tried to post to Slack
and hit a DNS error, and the only surface Kevin looks at (the AI Agents page)
showed the Automations strip: a static On/Off list. "I have no clue what is
published and when, or when agents are not working and when they are."

This script is the deterministic half of the answer. It reads what already
exists (job-status.jsonl from ~/tools/run-job.sh, queue-events.jsonl from
scripts/job-queue.py, scripts/job-schedule.json, js/automations-data.js for the
plain-English names) and writes ONE row per live job to the Estate Status
table: the last run, whether it worked, why not in plain words, the next due
time and the 24-hour counts. The page reads the table live. Nothing here
decides anything; it is a mirror, and the guard that a mirror needs is at the
bottom: the page shows "the status writer itself has stopped" when the rows go
stale, because a dashboard that stops updating looks exactly like a business
where nothing is wrong.

It also writes one REPORT row, loop-health, from scripts/loop-health.py: the
tasks that are not moving, so the page's "not moving" list is the same list
daily-ops prints, not a second opinion.

Usage:
  estate-status.py refresh [--dry-run] [--no-loop-health]
  estate-status.py selftest
Auth: ~/.config/od/airtable_pat (never printed).
"""
import argparse
import importlib.util
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
LOGS = os.path.expanduser("~/knowledge-os/logs")
STATUS_LOG = os.path.join(LOGS, "job-status.jsonl")
QUEUE_LOG = os.path.join(LOGS, "queue", "queue-events.jsonl")
SCHEDULE = os.path.join(HERE, "job-schedule.json")
AUTOMATIONS = os.path.join(REPO, "js", "automations-data.js")
LONDON = ZoneInfo("Europe/London")

BASE = "appnqjDpqDniH3IRl"
TABLE = "tblZVrdzivyBueZVf"   # Estate Status
# Mirrored in os/agents/index.html (const ES). tests/estate-status.test.js
# fails if the two blocks disagree — a drift means the writer fills rows the
# page cannot see, which recreates the invisibility this table ends.
ES = {
    "key":        "fldLO6xJqkokvVR4g",
    "kind":       "fldfjQOn76VpgKEfZ",
    "label":      "fldlnvvTh8l5UIih4",
    "schedule":   "fldZGa0UD76lVLww7",
    "status":     "fldhOUiva3bqPNk1c",
    "lastRun":    "flduxV3TYwp9wQX9O",
    "lastWorked": "fldMIx3kWMM23vDBN",
    "detail":     "fldLRFP2nJttDVQOa",
    "nextDue":    "fldr5E1TQyDhZ8a79",
    "runs24h":    "fldn0sWvRqDBwbvsM",
    "fails24h":   "fldk3Qz02krXZt1w3",
    "payload":    "fldiqs9lvyLimoR7i",
    "updated":    "fld3q8WN5XqrER92Z",
}
STATUSES = ("Worked", "Failed", "Blocked", "Skipped", "Idle", "Running")

# Why a run did not work, in Kevin's words. Matched against the wrapper's
# reason and the last 600 characters the job printed. Order matters: the first
# match wins, and the allowance line is the one that explained the weekend.
BLOCKED_MARKERS = (
    (re.compile(r"hit your limit", re.I),
     "The Claude allowance ran out{reset}. The job did no work; it runs again at its next slot."),
    (re.compile(r"DNS cannot resolve|nodename nor servname|Network is unreachable|Temporary failure in name resolution", re.I),
     "No network when it ran."),
    (re.compile(r"Resource deadlock avoided|cannot read founder-profile", re.I),
     "Google Drive was not readable when it ran."),
    (re.compile(r"OAuth.*expired|Invalid authentication token|Unauthorized", re.I),
     "A sign-in has expired. Kevin needs to sign the robot in again."),
    (re.compile(r"GMAIL RATE METRIC|Quota exceeded for quota metric", re.I),
     "Gmail's per-minute limit was full. No mail is lost; the next slot picks up where this one stopped."),
    (re.compile(r"LOST LOCK|was stopped mid-run", re.I),
     "Another job took the queue lock while this one ran, so it was stopped part way."),
    (re.compile(r"MAX RUNTIME|ran past its .* ceiling|signal 9", re.I),
     "It ran too long and was stopped."),
)
RESET_RE = re.compile(r"resets\s+([^\n(·]+?)(?:\s*\(|\s*$|\s+[A-Z])")
STALE_HOURS = 168          # no run recorded in a week reads as Idle
RUNNING_GRACE_MIN = 5      # an acquired job with no finish yet is Running


# ─── reads ────────────────────────────────────────────────────────────
def load_schedule():
    with open(SCHEDULE) as fh:
        d = json.load(fh)
    live = {}
    for k, v in d.items():
        if not isinstance(v, dict) or not v.get("cron"):
            continue
        note = str(v.get("note") or "")
        if "RETIRED" in note or "ABSORBED" in note:
            continue
        live[k] = v
    return live


def load_labels():
    """Plain-English names from js/automations-data.js, key -> (name, what)."""
    out = {}
    try:
        src = open(AUTOMATIONS).read()
    except OSError:
        return out
    for m in re.finditer(r"key:\s*'([^']+)',\s*name:\s*'((?:[^'\\]|\\.)*)'", src):
        out[m.group(1)] = m.group(2).replace("\\'", "'")
    return out


def read_jsonl(path, since=None):
    rows = []
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(rec, dict):
                    continue
                if since and str(rec.get("ts") or "") < since:
                    continue
                rows.append(rec)
    except FileNotFoundError:
        return None
    return rows


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None


# ─── the judgement, all deterministic ─────────────────────────────────
def blocked_reason(text):
    """Plain-words reason if the text carries a known blocker, else ''."""
    text = text or ""
    for rx, words in BLOCKED_MARKERS:
        if rx.search(text):
            reset = ""
            m = RESET_RE.search(text)
            if m and "{reset}" in words:
                reset = " (it comes back " + m.group(1).strip() + ")"
            return words.replace("{reset}", reset)
    return ""


def plain_tail(tail, limit=220):
    """The last thing the job said, trimmed and stripped of paths and ids."""
    t = re.sub(r"/Users/[^\s]+", "", str(tail or ""))
    t = re.sub(r"\b(?:rec|fld|tbl)[A-Za-z0-9]{14}\b", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[-limit:] if len(t) > limit else t


def own_log_tail(job, logs_dir=LOGS, limit=4000):
    """What the job itself printed most recently: the wrapper's copy of its
    output (<job>.last.log) and, for an agent slot, its runs.log. The wrapper
    keeps only the last 600 characters of stdout in job-status.jsonl, and for a
    slot those are the runner's own FAIL lines; the line that explains them
    ("You've hit your limit") sits further up, in runs.log."""
    out = []
    for path in (os.path.join(logs_dir, job + ".last.log"), os.path.join(logs_dir, job, "runs.log")):
        try:
            with open(path, "rb") as fh:
                fh.seek(0, 2)
                size = fh.tell()
                fh.seek(max(0, size - limit))
                out.append(fh.read().decode("utf-8", "replace"))
        except OSError:
            continue
    return "\n".join(out)


def classify(job, cfg, finishes, events, now, logs_dir=LOGS):
    """One job's row fields (by ES key name), from its finishes and queue events."""
    mine = [r for r in finishes if r.get("job") == job]
    mine.sort(key=lambda r: str(r.get("ts") or ""))
    last = mine[-1] if mine else None
    last_ts = parse_ts(last.get("ts")) if last else None
    day_ago = (now - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    runs24 = [r for r in mine if str(r.get("ts") or "") >= day_ago]
    fails24 = [r for r in runs24 if not r.get("ok")]
    worked = [r for r in mine if r.get("ok")]
    last_worked = parse_ts(worked[-1].get("ts")) if worked else None

    # Queue events newer than the last finish say what the job is doing NOW.
    ev = [e for e in events if e.get("job") == job]
    ev.sort(key=lambda e: str(e.get("ts") or ""))
    after = [e for e in ev if not last_ts or (parse_ts(e.get("ts")) or now) > last_ts]

    status, detail = "Idle", ""
    if last:
        if last.get("ok"):
            status, detail = "Worked", "Ran at its slot and finished cleanly."
        else:
            why = blocked_reason((last.get("reason") or "") + " " + (last.get("tail") or ""))
            if not why:
                why = blocked_reason(own_log_tail(job, logs_dir))
            if why:
                status, detail = "Blocked", why
            else:
                status = "Failed"
                detail = "%s. Last thing it said: %s" % (
                    str(last.get("reason") or "it failed").rstrip("."), plain_tail(last.get("tail")) or "(nothing)")
    for e in after:
        st = e.get("state")
        if st in ("acquired", "ran-unlocked"):
            ets = parse_ts(e.get("ts"))
            if ets and (now - ets) < timedelta(hours=8):
                status, detail = "Running", "Started at %s and has not finished yet." % ets.astimezone(LONDON).strftime("%H:%M")
        elif st in ("deferred-not-ready", "deferred-stale-precondition", "skipped-stale", "queue-timeout"):
            status = "Skipped"
            detail = {
                "deferred-not-ready": "Its slot came but something it needs was not ready (network or Drive), so it waited.",
                "deferred-stale-precondition": "Its slot came but what it needs stayed unavailable, so the run was deferred.",
                "skipped-stale": "Its slot was missed by more than the allowed lateness, so the run was skipped, not run late.",
                "queue-timeout": "It waited behind other jobs for the queue lock until it gave up.",
            }[st] + (" (%s)" % e.get("reason") if e.get("reason") else "")
    if not last and not after:
        detail = "No run recorded in the last week."
    elif last_ts and (now - last_ts) > timedelta(hours=STALE_HOURS) and status in ("Worked", "Failed"):
        detail += " No run recorded for over a week."

    return {
        "key": job, "kind": "job", "schedule": cfg.get("cron", ""),
        "status": status, "detail": detail,
        "lastRun": last_ts.strftime("%Y-%m-%dT%H:%M:%S.000Z") if last_ts else None,
        "lastWorked": last_worked.strftime("%Y-%m-%dT%H:%M:%S.000Z") if last_worked else None,
        "runs24h": len(runs24), "fails24h": len(fails24),
        "nextDue": next_due(cfg.get("cron", ""), now),
    }


def next_due(cron, now, horizon_days=8):
    """Next London-time firing of a five-field cron, ISO UTC, or None."""
    if not cron:
        return None
    jq = _job_queue()
    if not jq:
        return None
    t = now.astimezone(LONDON).replace(second=0, microsecond=0) + timedelta(minutes=1)
    end = t + timedelta(days=horizon_days)
    while t < end:
        if jq.cron_matches(cron, t):
            return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        t += timedelta(minutes=1)
    return None


_JQ = None


def _job_queue():
    """scripts/job-queue.py as a module (hyphen in the name), for cron_matches."""
    global _JQ
    if _JQ is None:
        spec = importlib.util.spec_from_file_location("job_queue", os.path.join(HERE, "job-queue.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _JQ = mod
    return _JQ


def loop_health_row(now):
    """The loop-health report as one row; a failed control is a Failed row, never a blank."""
    spec = importlib.util.spec_from_file_location("loop_health", os.path.join(HERE, "loop-health.py"))
    lh = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lh)
    try:
        res = lh.report()
    except Exception as exc:  # noqa: BLE001 — the row must say WHY, whatever went wrong
        return {"key": "loop-health", "kind": "report", "label": "Tasks not moving", "status": "Failed",
                "detail": "The not-moving check could not run: %s" % str(exc)[:300], "payload": "",
                "lastRun": now.strftime("%Y-%m-%dT%H:%M:%S.000Z")}
    stalled = res.get("stalled") or []
    slim = [{"name": s.get("name", "")[:90], "why": s.get("why", "")[:160], "days": s.get("days"), "rule": s.get("rule")}
            for s in stalled][:40]
    return {"key": "loop-health", "kind": "report", "label": "Tasks not moving", "status": "Worked",
            "detail": "%d not moving, %d need Kevin, %d done in the last 7 days (%d tasks read)." % (
                len(stalled), len(res.get("needsYou") or []), len(res.get("done") or []),
                (res.get("control") or {}).get("tasksRead", 0)),
            "payload": json.dumps({"stalled": slim, "needsYou": len(res.get("needsYou") or []),
                                   "done7d": len(res.get("done") or [])}),
            "lastRun": now.strftime("%Y-%m-%dT%H:%M:%S.000Z"), "lastWorked": now.strftime("%Y-%m-%dT%H:%M:%S.000Z")}


# ─── Airtable ─────────────────────────────────────────────────────────
def pat():
    with open(os.path.expanduser("~/.config/od/airtable_pat")) as fh:
        return fh.read().strip()


def _request(method, path, body=None):
    req = urllib.request.Request("https://api.airtable.com/v0/%s/%s" % (BASE, path), method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + pat(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def existing_rows():
    out, offset = {}, ""
    while True:
        q = {"returnFieldsByFieldId": "true", "pageSize": "100", "fields[]": ES["key"]}
        if offset:
            q["offset"] = offset
        d = _request("GET", TABLE + "?" + urllib.parse.urlencode(q))
        for r in d.get("records", []):
            out[(r.get("fields") or {}).get(ES["key"], "")] = r["id"]
        offset = d.get("offset")
        if not offset:
            return out


def to_fields(row, now):
    f = {ES["key"]: row["key"], ES["kind"]: row["kind"], ES["status"]: row["status"],
         ES["detail"]: row.get("detail", ""), ES["updated"]: now.strftime("%Y-%m-%dT%H:%M:%S.000Z")}
    for k in ("label", "schedule", "payload"):
        if row.get(k) is not None:
            f[ES[k]] = row[k]
    for k in ("lastRun", "lastWorked", "nextDue"):
        f[ES[k]] = row.get(k)
    for k in ("runs24h", "fails24h"):
        if k in row:
            f[ES[k]] = int(row[k])
    return f


def upsert(rows, now, dry_run=False):
    have = {} if dry_run else existing_rows()
    creates, updates = [], []
    for row in rows:
        f = to_fields(row, now)
        rid = have.get(row["key"])
        (updates if rid else creates).append({"id": rid, "fields": f} if rid else {"fields": f})
    if dry_run:
        return {"create": len(creates), "update": len(updates)}
    for i in range(0, len(updates), 10):
        _request("PATCH", TABLE, {"records": updates[i:i + 10], "typecast": True})
    for i in range(0, len(creates), 10):
        _request("POST", TABLE, {"records": creates[i:i + 10], "typecast": True})
    return {"create": len(creates), "update": len(updates)}


# ─── commands ─────────────────────────────────────────────────────────
def build_rows(now, with_loop_health=True):
    sched = load_schedule()
    if not sched:
        raise SystemExit("ERROR: no live jobs in scripts/job-schedule.json — refusing to write an empty board")
    since = (now - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    finishes = read_jsonl(STATUS_LOG, since)
    if finishes is None:
        raise SystemExit("ERROR: %s is missing — the wrappers write it on every run, so this is not an empty week" % STATUS_LOG)
    events = read_jsonl(QUEUE_LOG, since) or []
    labels = load_labels()
    rows = []
    for job, cfg in sorted(sched.items()):
        row = classify(job, cfg, finishes, events, now)
        row["label"] = labels.get(job, job)
        rows.append(row)
    if with_loop_health:
        rows.append(loop_health_row(now))
    return rows


def cmd_refresh(args):
    now = datetime.now(timezone.utc)
    rows = build_rows(now, with_loop_health=not args.no_loop_health)
    counts = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    res = upsert(rows, now, dry_run=args.dry_run)
    print(json.dumps({"rows": len(rows), "byStatus": counts, "written": res, "dryRun": bool(args.dry_run),
                      "attention": [r["key"] + ": " + r["status"] for r in rows if r["status"] in ("Failed", "Blocked")]}))


def selftest():
    now = datetime(2026, 9, 14, 7, 30, tzinfo=timezone.utc)   # 08:30 London
    checks = 0
    def ok(cond, what):
        nonlocal checks
        checks += 1
        if not cond:
            raise AssertionError(what)
    # 1. the allowance line is Blocked, with the reset time in plain words
    r = classify("task-manager", {"cron": "0 9,13,17 * * *"},
                 [{"ts": "2026-09-13T16:00:08Z", "job": "task-manager", "ok": False, "exit": 1, "reason": "exit code 1",
                   "tail": "You've hit your limit · resets 7pm (Europe/London) TASK-MANAGER VERIFY FAIL"}], [], now)
    ok(r["status"] == "Blocked" and "allowance ran out" in r["detail"] and "7pm" in r["detail"], "allowance -> Blocked: %r" % r)
    ok(r["nextDue"] == "2026-09-14T08:00:00.000Z", "next due 09:00 London = 08:00Z: %r" % r["nextDue"])
    ok(next_due("0 22 * * *", now) == "2026-09-14T21:00:00.000Z", "22:00 London in BST = 21:00Z")
    ok(r["runs24h"] == 1 and r["fails24h"] == 1, "24h counts")
    # 1b. the wrapper keeps 600 chars of the RUNNER's output; the allowance line is in the slot's runs.log
    import tempfile
    tmp = tempfile.mkdtemp()
    os.makedirs(os.path.join(tmp, "task-manager"))
    with open(os.path.join(tmp, "task-manager", "runs.log"), "w") as fh:
        fh.write("===== task-manager run [13:00 slot] =====\nYou've hit your limit · resets Sep 13 at 7pm (Europe/London)\nTASK-MANAGER VERIFY FAIL\n")
    r = classify("task-manager", {"cron": "0 9,13,17 * * *"},
                 [{"ts": "2026-09-13T12:00:46Z", "job": "task-manager", "ok": False, "exit": 1, "reason": "exit code 1",
                   "tail": "TASK-MANAGER VERIFY FAIL: verify never ran this slot task-manager run FAILED (rc=1)"}], [], now, logs_dir=tmp)
    ok(r["status"] == "Blocked" and "Sep 13 at 7pm" in r["detail"], "allowance found in runs.log: %r" % r)
    r = classify("task-manager", {"cron": "0 9,13,17 * * *"},
                 [{"ts": "2026-09-13T12:00:46Z", "job": "task-manager", "ok": False, "exit": 1, "reason": "exit code 1", "tail": "VERIFY FAIL"}], [], now, logs_dir=tempfile.mkdtemp())
    ok(r["status"] == "Failed", "no log, no allowance line -> Failed")
    # 2. a clean run is Worked, and a later 'acquired' with no finish is Running
    fin = [{"ts": "2026-09-14T06:38:58Z", "job": "handback-poll", "ok": True, "exit": 0, "reason": "", "tail": "run OK"}]
    r = classify("handback-poll", {"cron": "*/30 * * * *"}, fin, [], now)
    ok(r["status"] == "Worked" and r["lastWorked"] == "2026-09-14T06:38:58.000Z", "worked: %r" % r)
    r = classify("handback-poll", {"cron": "*/30 * * * *"}, fin,
                 [{"ts": "2026-09-14T07:30:05.121Z", "job": "handback-poll", "state": "acquired"}], now)
    ok(r["status"] == "Running", "acquired after finish -> Running: %r" % r["status"])
    # 3. a plain failure names what it said, without paths or record ids
    r = classify("x", {"cron": "0 7 * * *"}, [{"ts": "2026-09-14T06:00:00Z", "job": "x", "ok": False, "exit": 1,
                                             "reason": "exit code 1", "tail": "wrote /Users/kevinbrittain/a.log then rec1234567890ABCD broke"}], [], now)
    ok(r["status"] == "Failed" and "/Users" not in r["detail"] and "rec1234567890ABCD" not in r["detail"], "failed detail: %r" % r["detail"])
    # 4. a deferral after the last finish reads Skipped, not Worked
    r = classify("content-engine", {"cron": "0 22 * * *"}, fin[:0] + [{"ts": "2026-09-12T22:30:00Z", "job": "content-engine", "ok": True, "exit": 0, "reason": "", "tail": ""}],
                 [{"ts": "2026-09-13T21:00:00Z", "job": "content-engine", "state": "deferred-not-ready", "reason": "network"}], now)
    ok(r["status"] == "Skipped" and "not ready" in r["detail"], "deferred -> Skipped: %r" % r)
    # 5. nothing at all is Idle with a plain line
    r = classify("y", {"cron": "0 11 * * 0"}, [], [], now)
    ok(r["status"] == "Idle" and "No run recorded" in r["detail"], "idle: %r" % r)
    # 6. the schedule filter drops retired and absorbed entries and keeps the live ones
    sched = load_schedule()
    ok("handback-poll" in sched and "ceo-huddle" not in sched and "uc-check" not in sched, "schedule filter")
    ok("estate-status" in sched, "this job is registered in job-schedule.json")
    # 7. plain names come from the automations list Kevin already approved
    labels = load_labels()
    ok(labels.get("estate-drift", "").startswith("CEO and Board"), "labels parsed: %r" % labels.get("estate-drift"))
    # 8. the blocked words
    ok(blocked_reason("GMAIL RATE METRIC STILL FULL after 585s").startswith("Gmail's per-minute limit"), "gmail words")
    ok(blocked_reason("LOST LOCK: task-manager was stopped mid-run").startswith("Another job took"), "lock words")
    ok(blocked_reason("all fine") == "", "no false blocker")
    # 9. field map is complete and every status is a table choice
    ok(set(ES) == {"key", "kind", "label", "schedule", "status", "lastRun", "lastWorked", "detail", "nextDue", "runs24h", "fails24h", "payload", "updated"}, "ES keys")
    ok(all(v.startswith("fld") and len(v) == 17 for v in ES.values()), "ES ids")
    return {"checks": checks, "failed": []}


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("refresh")
    r.add_argument("--dry-run", action="store_true")
    r.add_argument("--no-loop-health", action="store_true")
    sub.add_parser("selftest")
    args = ap.parse_args(argv)
    if args.cmd == "selftest":
        try:
            print(json.dumps(selftest()))
        except AssertionError as exc:
            print(json.dumps({"checks": 0, "failed": [str(exc)]}))
            return 1
        return 0
    cmd_refresh(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
