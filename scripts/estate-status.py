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


def paused_skip(log_text):
    """True when the newest done line in a slot log is the allowance pause."""
    lines = [l for l in (log_text or "").splitlines() if l.startswith("===== done rc=")]
    return bool(lines) and "(PAUSED:" in lines[-1]


def classify(job, cfg, finishes, events, now, logs_dir=LOGS):
    """One job's row fields (by ES key name), from its finishes and queue events."""
    ev = [e for e in events if e.get("job") == job]
    ev.sort(key=lambda e: str(e.get("ts") or ""))
    if cfg.get("mode") == "cooperative":
        return cooperative_row(job, cfg, ev, now)
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
    # The wrapper stamps job-status at SECOND resolution and the queue log at
    # millisecond resolution, so a run's own 'acquired' event (05:25:05.317Z)
    # read as later than its finish (05:25:05Z) and every sub-second job sat
    # on the board as Running for eight hours (review, 14 Sep 2026). Compare on
    # whole seconds, and let a closing event end an open start.
    def newer(e):
        ets = parse_ts(e.get("ts"))
        return not last_ts or (ets is not None and ets.replace(microsecond=0) > last_ts.replace(microsecond=0))
    after = [e for e in ev if newer(e)]

    status, detail = "Idle", ""
    if last:
        if last.get("ok") and paused_skip(own_log_tail(job, logs_dir)):
            # the runner skipped the Claude call because the allowance was out (allowance.py): exit 0, but nothing ran
            status, detail = "Skipped", "Its slot came while the Claude allowance was out, so it did not start; it is queued to re-run at reset."
        elif last.get("ok"):
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
    open_start = None
    ceiling = timedelta(minutes=float(cfg.get("maxRuntimeMinutes") or _default_ceiling_min()) + 30)
    for e in after:
        st = e.get("state")
        if st in ("acquired", "ran-unlocked"):
            open_start = parse_ts(e.get("ts"))
            if open_start:
                status, detail = "Running", "Started at %s and has not finished yet." % open_start.astimezone(LONDON).strftime("%H:%M")
        elif st in ("finished", "released", "release-noop", "lease-lost", "max-runtime", "lock-broken"):
            # The queue closed the run. If the wrapper never wrote its own line
            # (the child and its wrapper were killed together), this event IS
            # the result; a death that shows as "Running" hides the death.
            if open_start is None:
                continue
            open_start = None
            code = e.get("exit")
            reason = str(e.get("reason") or "")
            outcome = str(e.get("outcome") or "")
            if st == "finished" and code not in (None, 0):
                words = blocked_reason(reason) or ("The queue stopped it: %s." % reason if reason else "It ended with exit code %s and left no report." % code)
                status, detail = ("Blocked" if blocked_reason(reason) else "Failed"), words
            elif st in ("lease-lost", "max-runtime", "lock-broken"):
                status, detail = "Blocked", blocked_reason(reason or st) or "The queue stopped it (%s)." % st
            elif st == "released" and outcome and outcome != "completed":
                # released with outcome failed / signalled / unfinished and no
                # finished line: the one death `finished` cannot record.
                status, detail = "Failed", blocked_reason(reason) or "The run ended without a report (%s%s)." % (outcome, (": " + reason) if reason else "")
            elif status == "Running":
                status, detail = "Worked", "Ran at its slot and finished cleanly."
        elif st in ("deferred-not-ready", "deferred-stale-precondition", "skipped-stale", "queue-timeout"):
            status = "Skipped"
            detail = {
                "deferred-not-ready": "Its slot came but something it needs was not ready (network or Drive), so it waited.",
                "deferred-stale-precondition": "Its slot came but what it needs stayed unavailable, so the run was deferred.",
                "skipped-stale": "Its slot was missed by more than the allowed lateness, so the run was skipped, not run late.",
                "queue-timeout": "It waited behind other jobs for the queue lock until it gave up.",
            }[st] + (" (%s)" % e.get("reason") if e.get("reason") else "")
    if open_start is not None and (now - open_start) > ceiling:
        # Past its own ceiling with no closing event: the queue's watchdog would
        # have written max-runtime long before, so the queue process itself died.
        status = "Failed"
        detail = "Started at %s and never finished; nothing closed the run and no report was written." % open_start.astimezone(LONDON).strftime("%d %b %H:%M")
    if not last and not after:
        detail = "No run recorded in the last week."

    return {
        "key": job, "kind": "job", "schedule": cfg.get("cron", ""),
        "status": status, "detail": detail,
        "lastRun": last_ts.strftime("%Y-%m-%dT%H:%M:%S.000Z") if last_ts else None,
        "lastWorked": last_worked.strftime("%Y-%m-%dT%H:%M:%S.000Z") if last_worked else None,
        "runs24h": len(runs24), "fails24h": len(fails24),
        "nextDue": next_due(cfg.get("cron", ""), now, runs_on_days=cfg.get("runsOnDays")),
    }


COOP_GRACE_MIN = 60   # daily-ops-guard alarms 60 minutes after the slot; the board agrees with it
END_NOTE_RE = re.compile(r"^(?:end|finished|complete|done)\b|\b(?:finished|complete|completed)\b", re.I)


def last_due(cron, now, back_days=3):
    """The most recent London-time firing of a five-field cron at or before now, or None."""
    jq = _job_queue()
    if not cron or not jq:
        return None
    t = now.astimezone(LONDON).replace(second=0, microsecond=0)
    stop = t - timedelta(days=back_days)
    while t > stop:
        if jq.cron_matches(cron, t):
            return t.astimezone(timezone.utc)
        t -= timedelta(minutes=1)
    return None


def cooperative_row(job, cfg, ev, now):
    """A cooperative job (daily-ops) runs inside a Claude session and leaves no
    wrapper line, only 'mark' events: a bare one at its start and one whose note
    opens end / finished / complete when it is done. Judged against its own
    slot, not a rolling day (review, 14 Sep 2026): before the slot plus the
    guard's grace the last completed run stands; after it, no start is Failed."""
    marks = [e for e in ev if e.get("state") == "mark"]
    is_end = lambda e: bool(END_NOTE_RE.search(str(e.get("note") or "")))
    is_start = lambda e: not str(e.get("note") or "").strip()
    starts = [e for e in marks if is_start(e)]
    ends = [e for e in marks if is_end(e)]
    due = last_due(cfg.get("cron", ""), now)
    grace_over = bool(due) and now >= due + timedelta(minutes=COOP_GRACE_MIN)
    since_due = lambda e: due is None or (parse_ts(e.get("ts")) or due) >= due
    start_today = [e for e in starts if since_due(e)]
    end_today = [e for e in ends if since_due(e)]
    last_end = parse_ts(ends[-1].get("ts")) if ends else None
    ceiling = timedelta(minutes=float(cfg.get("maxRuntimeMinutes") or _default_ceiling_min()) + 30)
    if end_today:
        t = parse_ts(end_today[-1].get("ts"))
        status, detail = "Worked", "Ran through its Claude session and finished at %s." % t.astimezone(LONDON).strftime("%H:%M")
    elif start_today:
        t = parse_ts(start_today[-1].get("ts"))
        if (now - t) <= ceiling:
            status, detail = "Running", "Started at %s and has not written its end mark yet." % t.astimezone(LONDON).strftime("%H:%M")
        else:
            status, detail = "Failed", "Started at %s and never wrote its end mark." % t.astimezone(LONDON).strftime("%H:%M")
    elif not grace_over and last_end:
        status, detail = "Worked", "Last ran %s; next slot %s." % (
            last_end.astimezone(LONDON).strftime("%a %H:%M"), due.astimezone(LONDON).strftime("%H:%M") if due else "unknown")
    elif not grace_over and not last_end:
        status, detail = "Idle", "No run recorded in the last week; its slot today has not passed yet."
    else:
        status, detail = "Failed", "Due at %s and no start mark %d minutes later. It runs through a Claude session; nothing has swept, dispatched or reported." % (
            due.astimezone(LONDON).strftime("%H:%M"), int((now - due).total_seconds() // 60))
    day = now - timedelta(hours=24)
    starts24 = [e for e in starts if (parse_ts(e.get("ts")) or day) > day]
    last_mark = parse_ts(marks[-1].get("ts")) if marks else None
    return {
        "key": job, "kind": "job", "schedule": cfg.get("cron", ""), "status": status, "detail": detail,
        "lastRun": last_mark.strftime("%Y-%m-%dT%H:%M:%S.000Z") if last_mark else None,
        "lastWorked": last_end.strftime("%Y-%m-%dT%H:%M:%S.000Z") if last_end else None,
        "runs24h": len(starts24), "fails24h": 1 if status == "Failed" else 0,
        "nextDue": next_due(cfg.get("cron", ""), now, runs_on_days=cfg.get("runsOnDays")),
    }


def next_due(cron, now, horizon_days=8, runs_on_days=None):
    """Next London-time firing of a five-field cron, ISO UTC, or None.
    runs_on_days is job-schedule.json's ISO weekday list (Mon=1..Sun=7): a job
    whose cron is daily on purpose but which only works on Sundays is next due
    on Sunday, not tomorrow."""
    if not cron:
        return None
    jq = _job_queue()
    if not jq:
        return None
    days = {int(d) for d in (runs_on_days or [])}
    t = now.astimezone(LONDON).replace(second=0, microsecond=0) + timedelta(minutes=1)
    end = t + timedelta(days=horizon_days)
    while t < end:
        if days and t.isoweekday() not in days:
            t = (t + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if jq.cron_matches(cron, t):
            return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        t += timedelta(minutes=1)
    return None


_JQ = None


def _default_ceiling_min():
    jq = _job_queue()
    return float(getattr(jq, "DEFAULT_MAX_RUNTIME_MIN", 480) or 480)


def _job_queue():
    """scripts/job-queue.py as a module (hyphen in the name), for cron_matches."""
    global _JQ
    if _JQ is None:
        spec = importlib.util.spec_from_file_location("job_queue", os.path.join(HERE, "job-queue.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _JQ = mod
    return _JQ


def allowance_row(now):
    """The Claude allowance as one report row: Blocked while paused (with the
    reset time and the runs queued to re-run), Worked otherwise. Also the
    moment the missed runs are re-started: replay() is called here because
    this job is the ten-minute heartbeat the estate already has."""
    spec = importlib.util.spec_from_file_location("allowance", os.path.join(HERE, "allowance.py"))
    al = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(al)
        replayed = al.cmd_replay(now=now)
        st = al.cmd_status(now=now)
    except Exception as exc:  # noqa: BLE001 — the row must say why, whatever broke
        return {"key": "allowance", "kind": "report", "label": "Claude allowance", "status": "Failed",
                "detail": "The allowance guard could not run: %s" % str(exc)[:300], "lastRun": now.strftime("%Y-%m-%dT%H:%M:%S.000Z")}
    row = {"key": "allowance", "kind": "report", "label": "Claude allowance", "lastRun": now.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
           "payload": json.dumps({"missed": st.get("missed") or [], "lastOutage": st.get("last_outage"), "replayed": replayed.get("replayed")})}
    if st.get("paused"):
        until = parse_ts(st.get("paused_until"))
        jobs = sorted({m.get("job") for m in (st.get("missed") or []) if m.get("job")})
        row.update({"status": "Blocked", "nextDue": st.get("paused_until"),
                    "detail": "The Claude allowance ran out (seen %s). It comes back at %s London. Agent runs are paused until then; %d job%s will re-run once at reset%s." % (
                        (parse_ts(st.get("seen_at")) or now).astimezone(LONDON).strftime("%a %H:%M"),
                        until.astimezone(LONDON).strftime("%a %H:%M") if until else "?", len(jobs), "" if len(jobs) == 1 else "s",
                        (": " + ", ".join(jobs)) if jobs else "")})
    else:
        last = st.get("last_outage") or {}
        if replayed.get("replayed"):
            row.update({"status": "Worked", "detail": "Allowance back. Re-started %d missed job%s just now: %s." % (
                len(replayed["replayed"]), "" if len(replayed["replayed"]) == 1 else "s",
                ", ".join("%s (%s)" % (r["job"], r["result"]) for r in replayed["replayed"]))})
        elif last:
            row.update({"status": "Worked", "detail": "Allowance available. Last outage ended %s London; %d run%s re-started then." % (
                (parse_ts(last.get("paused_until")) or now).astimezone(LONDON).strftime("%a %d %b %H:%M"),
                len(last.get("replayed") or []), "" if len(last.get("replayed") or []) == 1 else "s")})
        else:
            row.update({"status": "Worked", "detail": "Allowance available. No outage recorded since the guard was built (14 Sep 2026)."})
    if row["status"] == "Worked":
        row["lastWorked"] = row["lastRun"]
    return row


def loop_health_row(now):
    """The loop-health report as one row; a failed control is a Failed row, never a blank."""
    try:
        spec = importlib.util.spec_from_file_location("loop_health", os.path.join(HERE, "loop-health.py"))
        lh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(lh)
        res = lh.report()
    except Exception as exc:  # noqa: BLE001 — the row must say WHY, whatever went wrong
        return {"key": "loop-health", "kind": "report", "label": "Tasks not moving", "status": "Failed",
                "detail": "The not-moving check could not run: %s" % str(exc)[:300],
                "lastRun": now.strftime("%Y-%m-%dT%H:%M:%S.000Z")}   # payload and lastWorked left as they were
    stalled = res.get("stalled") or []
    slim = [{"name": s.get("name", "")[:90], "why": s.get("why", "")[:160], "days": s.get("days"),
             "rule": s.get("rule"), "lane": s.get("lane")}
            for s in stalled][:40]
    lanes = res.get("lanes") or {}
    return {"key": "loop-health", "kind": "report", "label": "Tasks not moving", "status": "Worked",
            "detail": "%d not moving, %d need Kevin, %d done in the last 7 days (%d tasks read)." % (
                len(stalled), len(res.get("needsYou") or []), len(res.get("done") or []),
                (res.get("control") or {}).get("tasksRead", 0)),
            "payload": json.dumps({"stalled": slim, "needsYou": len(res.get("needsYou") or []),
                                   "done7d": len(res.get("done") or []), "lanes": lanes}),
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
        if k in row:
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
    gone = [k for k in have if k and k not in {r["key"] for r in rows} and k not in ("loop-health", "allowance")]
    for k in gone:
        updates.append({"id": have[k], "fields": {ES["status"]: "Idle", ES["nextDue"]: None,
                        ES["detail"]: "No longer scheduled: this job has left job-schedule.json (retired or renamed).",
                        ES["updated"]: now.strftime("%Y-%m-%dT%H:%M:%S.000Z")}})
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
    rows.append(allowance_row(now))
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
    ok(next_due("0 11 * * *", now, runs_on_days=[7]) == "2026-09-20T10:00:00.000Z", "Sundays-only job is next due on Sunday 20 Sep: %r" % next_due("0 11 * * *", now, runs_on_days=[7]))
    r_late = classify("daily-ops", {"cron": "0 7 * * *", "mode": "cooperative"}, [],
                      [{"ts": "2026-09-13T18:00:00.000Z", "job": "daily-ops", "state": "mark", "note": ""},
                       {"ts": "2026-09-13T18:21:46.493Z", "job": "daily-ops", "state": "mark", "note": "end: late run 19:06-19:20, usage cap until 19:00"}],
                      datetime(2026, 9, 14, 5, 0, tzinfo=timezone.utc))   # 06:00 London, before today's slot
    ok(r_late["status"] == "Worked" and "19:21" in r_late["detail"], "an end mark with a note still ends the run: %r" % r_late)
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
    # 1c. a slot the runner skipped while the allowance was out is Skipped, not Worked (exit 0 notwithstanding)
    tmp2 = tempfile.mkdtemp(); os.makedirs(os.path.join(tmp2, "prospecting"))
    with open(os.path.join(tmp2, "prospecting", "runs.log"), "w") as fh:
        fh.write("===== prospecting slot run =====\nPAUSED: {...}\n===== done rc=0 (PAUSED: the Claude allowance is out; queued to re-run at reset) Mon =====\n")
    r = classify("prospecting", {"cron": "15 9 * * *"},
                 [{"ts": "2026-09-14T07:15:10Z", "job": "prospecting", "ok": True, "exit": 0, "reason": "", "tail": "prospecting slot skipped: the Claude allowance is out"}], [], now, logs_dir=tmp2)
    ok(r["status"] == "Skipped" and "allowance was out" in r["detail"], "paused skip -> Skipped: %r" % r)
    # 2. a clean run is Worked, and a later 'acquired' with no finish is Running
    fin = [{"ts": "2026-09-14T06:38:58Z", "job": "handback-poll", "ok": True, "exit": 0, "reason": "", "tail": "run OK"}]
    r = classify("handback-poll", {"cron": "*/30 * * * *"}, fin, [], now)
    ok(r["status"] == "Worked" and r["lastWorked"] == "2026-09-14T06:38:58.000Z", "worked: %r" % r)
    r = classify("handback-poll", {"cron": "*/30 * * * *"}, fin,
                 [{"ts": "2026-09-14T07:30:05.121Z", "job": "handback-poll", "state": "acquired"}], now)
    ok(r["status"] == "Running", "acquired after finish -> Running: %r" % r["status"])
    # 2b. REVIEW 14 Sep 2026: a sub-second run's own 'acquired' (millis) is not "after" its finish (seconds)
    r = classify("estate-drift", {"cron": "25 6 * * *"},
                 [{"ts": "2026-09-14T05:25:05Z", "job": "estate-drift", "ok": True, "exit": 0, "reason": "", "tail": "ok"}],
                 [{"ts": "2026-09-14T05:25:05.317Z", "job": "estate-drift", "state": "ran-unlocked"},
                  {"ts": "2026-09-14T05:25:05.504Z", "job": "estate-drift", "state": "finished", "exit": 0}], now)
    ok(r["status"] == "Worked", "same-second start is not Running: %r" % r["status"])
    # 2c. the queue killed the run and the wrapper never wrote a line: the death shows
    r = classify("task-manager", {"cron": "0 9,13,17 * * *"},
                 [{"ts": "2026-09-13T12:00:46Z", "job": "task-manager", "ok": True, "exit": 0, "reason": "", "tail": "ok"}],
                 [{"ts": "2026-09-13T16:00:08.100Z", "job": "task-manager", "state": "acquired"},
                  {"ts": "2026-09-13T16:20:08.100Z", "job": "task-manager", "state": "finished", "exit": 70, "reason": "LOST LOCK: lock is held by prospecting"}], now)
    ok(r["status"] == "Blocked" and "Another job took the queue lock" in r["detail"], "queue death shows: %r" % r)
    # 2d. a cooperative job reads its marks, judged against its 07:00 slot (now = 08:30 London)
    coop = {"cron": "0 7 * * *", "mode": "cooperative"}
    r = classify("daily-ops", coop, [],
                 [{"ts": "2026-09-14T06:06:35.714Z", "job": "daily-ops", "state": "mark", "note": ""},
                  {"ts": "2026-09-14T06:48:27.733Z", "job": "daily-ops", "state": "mark", "note": "end"}], now)
    ok(r["status"] == "Worked" and "07:48" in r["detail"], "cooperative worked: %r" % r)
    r = classify("daily-ops", coop, [], [], now)
    ok(r["status"] == "Failed" and "Due at 07:00" in r["detail"], "cooperative silent past grace -> Failed: %r" % r)
    yesterday = [{"ts": "2026-09-13T06:06:00.000Z", "job": "daily-ops", "state": "mark", "note": ""},
                 {"ts": "2026-09-13T06:48:00.000Z", "job": "daily-ops", "state": "mark", "note": "end"}]
    early = datetime(2026, 9, 14, 5, 0, tzinfo=timezone.utc)   # 06:00 London, not yet due
    r = classify("daily-ops", coop, [], yesterday, early)
    ok(r["status"] == "Worked" and "07:48" in r["detail"], "not yet due -> yesterday's completed slot stands: %r" % r)
    # a run that predates the last due slot, inside the grace, still stands and names the slot
    r = classify("daily-ops", coop, [], yesterday, datetime(2026, 9, 14, 6, 20, tzinfo=timezone.utc))   # 07:20 London
    ok(r["status"] == "Worked" and "next slot 07:00" in r["detail"], "inside grace names the slot: %r" % r["detail"])
    r = classify("daily-ops", coop, [], yesterday, datetime(2026, 9, 14, 6, 50, tzinfo=timezone.utc))   # 07:50, inside grace
    ok(r["status"] == "Worked", "inside the 60-minute grace it is not Failed: %r" % r["status"])
    r = classify("daily-ops", coop, [], yesterday + [{"ts": "2026-09-14T06:05:00.000Z", "job": "daily-ops", "state": "mark", "note": "phase 1, run"}], now)
    ok(r["runs24h"] == 0 and r["status"] == "Failed", "a mid-run note is not a start: %r" % r)
    # 2e. released without a finished line: the outcome is the result
    r = classify("handback-poll", {"cron": "*/30 * * * *"}, fin,
                 [{"ts": "2026-09-14T07:00:05.000Z", "job": "handback-poll", "state": "acquired"},
                  {"ts": "2026-09-14T07:20:05.000Z", "job": "handback-poll", "state": "released", "outcome": "unfinished", "reason": "child exit unknown"}], now)
    ok(r["status"] == "Failed" and "without a report" in r["detail"], "released unfinished -> Failed: %r" % r)
    r = classify("handback-poll", {"cron": "*/30 * * * *"}, fin,
                 [{"ts": "2026-09-14T07:00:05.000Z", "job": "handback-poll", "state": "acquired"},
                  {"ts": "2026-09-14T07:05:05.000Z", "job": "handback-poll", "state": "released", "outcome": "completed"}], now)
    ok(r["status"] == "Worked", "released completed -> Worked: %r" % r["status"])
    # 2f. a start that nothing ever closes, past its ceiling, is a death not a run
    # (ceiling = maxRuntimeMinutes + 30 min margin; the start must be newer than the last finish at 06:38:58Z)
    r = classify("handback-poll", {"cron": "*/30 * * * *", "maxRuntimeMinutes": 10}, fin,
                 [{"ts": "2026-09-14T06:45:05.000Z", "job": "handback-poll", "state": "acquired"}], now)   # 45 min open, ceiling 40
    ok(r["status"] == "Failed" and "never finished" in r["detail"], "open start past ceiling -> Failed: %r" % r)
    r = classify("handback-poll", {"cron": "*/30 * * * *", "maxRuntimeMinutes": 10}, fin,
                 [{"ts": "2026-09-14T07:10:05.000Z", "job": "handback-poll", "state": "acquired"}], now)   # 20 min open
    ok(r["status"] == "Running", "open start inside ceiling -> Running: %r" % r["status"])
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
