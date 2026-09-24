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
daily-ops prints, not a second opinion. And one more, daily-ops-needs-you
(23 Sep 2026): the NEEDS YOU block of today's 07:00 report, which the 09:00 CEO
brief reads, because the report itself only ever lands in a file.

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
# Rows this writer must never mark "No longer scheduled". content-publishing is written by
# scripts/content-engine/content_report.py (Kevin's publishing report, 15 Sep 2026); without it here the
# 10-minute refresh would overwrite the report's headline with an Idle line.
REPORT_ROWS_OWNED_ELSEWHERE = ("loop-health", "allowance", "content-publishing")

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


# ─── the 07:00 check's NEEDS YOU list, for the 09:00 brief ────────────
# Kevin, 23 Sep 2026 ("build it"). daily-ops writes its report to one file and nowhere else (its
# Slack DM was retired on 1 Sep 2026). That morning its NEEDS YOU block named a legal deadline due
# the same day, and the line reached nobody. This lifts the block out of today's report
# into one REPORT row; the 09:00 brief (scripts/slack-automation/money-daily-worker.js,
# needsYouText) reads it and says in words when the row is from an earlier day. The date in the
# payload is the report's own date, so yesterday's list can never pass for today's.
#
# The report lives OUTSIDE the repo (Kevin, 24 Sep 2026). It names properties, sums and his legal
# and financial matters, and the repo is public: 29 reports sat in it until PR #531. They were
# gitignored first, then moved here, so no checkout, worktree or `git add -f` can reach them. The
# selftest fails if this path is ever pointed back inside the repo.
NEEDS_YOU_KEY = "daily-ops-needs-you"
DAILY_OPS_REPORTS = os.path.join(LOGS, "daily-ops")
_REPORT_NAME = re.compile(r"^daily-ops-(\d{4}-\d{2}-\d{2})\.md$")
_ITEM = re.compile(r"^\s*(?:\d+[.)]|[•-])\s+(.*\S)")
# A heading is a WHOLE bold line led by a capital word ("*STUCK: 17*"). A wrapped line that only starts in bold
# ("*HMRC* letter today.") continues the item above it (second review, 24 Sep 2026).
_HEADING = re.compile(r"^\*{1,2}[A-Z]{3,}\b[^*]*\*{1,2}:?\s*$")
# Slack strikethrough at the start of an item ("~Old item~ ..."). A lone "~" means "about"
# ("~£4,500 of costs") and keeps the item.
_STRUCK = re.compile(r"^~~?[^~\s](?:[^~]*[^~\s])?~~?(?:\s|$)")
_NEEDS_HEAD = re.compile(r"^\*{1,2}\s*needs you\b[^*]*\*{1,2}:?\s*$", re.I)


def parse_needs_you(text):
    """The daily-ops summary block's NEEDS YOU items, or None when the block cannot be trusted.

    Only the summary is read: from the first line starting `*Daily Ops` (an intro paragraph may sit
    above it, as on 2, 4 and 7 Sep 2026) to the first `*STUCK` heading after it, so the detail
    sections further down can never be mistaken for it. The routine leaves the heading out when
    nothing needs Kevin, so a summary with no mention of it is []. Anything that mentions "needs
    you" in a shape this reader does not recognise is None, never [], because [] prints "nothing
    needs you" (review finding, 24 Sep 2026). Blank lines between items are allowed; a line that is
    not an item continues the one above; an item struck out or marked WITHDRAWN is dropped."""
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines) if l.startswith("*Daily Ops")), None)
    if start is None:
        return None
    stop = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("*STUCK")), None)
    if stop is None:
        return None
    region = lines[start + 1:stop]
    head = next((i for i, l in enumerate(region) if _NEEDS_HEAD.match(l.strip())), None)
    if head is None:
        # No heading in the summary. A mention anywhere in it, or in a NEEDS YOU block that drifted
        # below *STUCK (before the detail starts), is unreadable, never "nothing needs you".
        tail = []
        for l in lines[stop:]:
            if l.startswith("#") or l.startswith("---"):
                break
            tail.append(l)
        return None if any(re.search(r"\bneeds? you\b", l, re.I) for l in region + tail) else []
    items = []
    for line in region[head + 1:]:
        st = line.strip()
        if not st:
            continue
        if _HEADING.match(st) or st.startswith("#") or st.startswith("---"):
            break
        m = _ITEM.match(line)
        if m:
            items.append(m.group(1))
        elif items:
            items[-1] += " " + st
        else:
            return None   # something unrecognised sits under the heading: not a list we can trust
    return [x for x in items if not _STRUCK.match(x) and not re.search(r"\bWITHDRAWN\b", x)]


def needs_you_row(now, reports=DAILY_OPS_REPORTS):
    """One REPORT row carrying today's NEEDS YOU items; a Failed row says why, never a blank."""
    today = now.astimezone(LONDON).strftime("%Y-%m-%d")
    stamp = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    row = {"key": NEEDS_YOU_KEY, "kind": "report", "label": "07:00 check: needs Kevin", "lastRun": stamp}
    try:
        dates = sorted(m.group(1) for m in (_REPORT_NAME.match(f) for f in os.listdir(reports)) if m)
        if today not in dates:
            last = dates[-1] if dates else None
            return dict(row, status="Idle", payload=json.dumps({"date": last, "items": None}),
                        detail="No 07:00 report for today yet%s." % ((". The last one is from %s" % last) if last else ""))
        with open(os.path.join(reports, "daily-ops-%s.md" % today), encoding="utf-8") as fh:
            items = parse_needs_you(fh.read())
    except Exception as exc:  # noqa: BLE001 — the row must say WHY, whatever went wrong
        return dict(row, status="Failed", payload=json.dumps({"date": today, "unreadable": True}),
                    detail="Could not read today's 07:00 report: %s" % str(exc)[:300])
    if items is None:
        return dict(row, status="Failed", payload=json.dumps({"date": today, "unreadable": True}),
                    detail="Today's 07:00 report has no summary block this reader recognises.")
    return dict(row, status="Worked", lastWorked=stamp, payload=json.dumps({"date": today, "items": items}),
                detail=("%d thing%s need%s Kevin: %s" % (len(items), "" if len(items) == 1 else "s",
                                                           "s" if len(items) == 1 else "", items[0][:200]))
                if items else "Nothing needs Kevin today.")


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
    gone = [k for k in have if k and k not in {r["key"] for r in rows} and k not in REPORT_ROWS_OWNED_ELSEWHERE]
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
    rows.append(needs_you_row(now))
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
    # 8b. the 07:00 NEEDS YOU block reaches the brief (23 Sep 2026)
    report = ("*Daily Ops, Wednesday 23 September.* 7 things broke.\n\n*NEEDS YOU*\n"
              "1. A legal deadline is TODAY.\n2. A repair waits for your yes.\n"
              "It touches the send path.\n3. Thirteen things are past a hard deadline.\n\n"
              "*STUCK: 17*\n• Court order response\n")
    ok(parse_needs_you(report) == ["A legal deadline is TODAY.",
                                   "A repair waits for your yes. It touches the send path.",
                                   "Thirteen things are past a hard deadline."], "needs-you items: %r" % parse_needs_you(report))
    ok(parse_needs_you("*Daily Ops, Thursday.* Ran fine.\n\n*STUCK: nothing has stalled*\n") == [], "no heading = nothing needs Kevin")
    ok(parse_needs_you("# half a report\n1. something\n") is None, "no summary block = unreadable, never []")
    ok(parse_needs_you("*Daily Ops, x.*\n*NEEDS YOU*\nsee below\n*STUCK: 1*\n") is None, "unrecognised lines under the heading = unreadable")
    # review findings, 24 Sep 2026: every shape below was read wrongly by the first version
    ok(parse_needs_you("Late run after the allowance reset.\nPhases 1-3 ran.\n\n" + report) == parse_needs_you(report),
       "an intro paragraph above the summary (2, 4, 7 Sep reports)")
    for head in ("*NEEDS YOU (2)*", "*NEEDS YOU:*", "**NEEDS YOU**", "*Needs you*"):
        ok(parse_needs_you("*Daily Ops, x.*\n\n%s\n1. First.\n2. Second.\n\n*STUCK: 1*\n" % head) == ["First.", "Second."],
           "heading variant %s" % head)
    ok(parse_needs_you("*Daily Ops, x.*\n*NEEDS YOU*\n1. First.\n\n2. Second.\n\n*STUCK: 1*\n") == ["First.", "Second."],
       "a blank line between items keeps both")
    ok(parse_needs_you("*Daily Ops, x.*\n*NEEDS YOU*\n1. First, see the\n*Court* hearing notes.\n*STUCK: 1*\n") == ["First, see the *Court* hearing notes."],
       "a wrapped line starting in bold continues the item")
    ok(parse_needs_you("*Daily Ops, x.*\n*NEEDS YOU*\n1. Keep.\n2. ~Old item~ WITHDRAWN, handled.\n*STUCK: 1*\n") == ["Keep."],
       "a withdrawn item is dropped")
    ok(parse_needs_you("*Daily Ops, x.*\nThree things need you, below.\n*STUCK: 1*\n") is None,
       "a mention in an unknown shape is unreadable, never 'nothing needs you'")
    ok(parse_needs_you("*Daily Ops, x.* Ran fine.\n\n*STUCK: 1*\n\n## Detail\n*NEEDS YOU*\n1. Detail item.\n") == [],
       "the detail section below STUCK is never read as the summary")
    # second review, 24 Sep 2026
    ok(parse_needs_you("*Daily Ops, x.*\n*NEEDS YOU*\n1. Reply to the\n*TAX* letter today.\n2. Sign the deed.\n*STUCK: 1*\n")
       == ["Reply to the *TAX* letter today.", "Sign the deed."], "a wrapped line led by a bold capital word continues the item")
    ok(parse_needs_you("*Daily Ops, x.*\n*NEEDS YOU*\n1. ~£4,500 of costs is due today.\n*STUCK: 1*\n") == ["~£4,500 of costs is due today."],
       "a lone ~ means 'about' and keeps the item")
    ok(parse_needs_you("*Daily Ops, x.*\n*NEEDS YOU*\n1. ~Old~ gone.\n2. Keep.\n*STUCK: 1*\n") == ["Keep."], "a struck item is dropped")
    ok(parse_needs_you("*Daily Ops, x.*\n*NEEDS YOU*\n1. ~~Old item~~ gone now.\n2. Keep.\n*STUCK: 1*\n") == ["Keep."], "a double-tilde strike is dropped")
    ok(parse_needs_you("*Daily Ops, x.*\n*NEEDS YOU*\n1. ~£4,500 or ~ £5k due.\n*STUCK: 1*\n") == ["~£4,500 or ~ £5k due."], "two 'about' tildes keep the item")
    ok(parse_needs_you("*Daily Ops, x.*\n*NEEDS YOU*\n1. Pay the court\n*by Friday at noon.*\n2. Sign.\n*STUCK: 1*\n")
       == ["Pay the court *by Friday at noon.*", "Sign."], "a fully bold lower-case wrapped line continues the item")
    ok(parse_needs_you("*Daily Ops, x.*\n\n*STUCK: 1*\n\n*NEEDS YOU*\n1. Drifted below.\n\n---\n## Detail\n") is None,
       "a NEEDS YOU block drifted below STUCK is unreadable, never 'nothing needs you'")
    tmp3 = tempfile.mkdtemp()
    at = datetime(2026, 9, 23, 8, 0, tzinfo=timezone.utc)   # 09:00 London
    row = needs_you_row(at, reports=tmp3)
    ok(row["status"] == "Idle" and json.loads(row["payload"]) == {"date": None, "items": None}, "no reports at all: %r" % row)
    with open(os.path.join(tmp3, "daily-ops-2026-09-22.md"), "w") as fh:
        fh.write(report)
    with open(os.path.join(tmp3, "daily-ops-2026-09-23-1300.md"), "w") as fh:
        fh.write(report)
    row = needs_you_row(at, reports=tmp3)
    ok(json.loads(row["payload"])["date"] == "2026-09-22" and "2026-09-22" in row["detail"],
       "yesterday's report is never today's, and a -1300 rerun is not the day's report: %r" % row)
    with open(os.path.join(tmp3, "daily-ops-2026-09-23.md"), "w") as fh:
        fh.write(report)
    row = needs_you_row(at, reports=tmp3)
    p = json.loads(row["payload"])
    ok(row["status"] == "Worked" and p["date"] == "2026-09-23" and len(p["items"]) == 3 and row["key"] == NEEDS_YOU_KEY,
       "today's report -> Worked with its items: %r" % row)
    ok(needs_you_row(datetime(2026, 9, 23, 23, 30, tzinfo=timezone.utc), reports=tmp3)["status"] == "Idle",
       "00:30 London on the 24th reads the 24th, not the 23rd")
    ok(needs_you_row(at, reports=os.path.join(tmp3, "missing"))["status"] == "Failed", "unreadable folder -> Failed")
    # The report names Kevin's legal and financial matters and the repo is public (24 Sep 2026).
    ok(not (os.path.realpath(DAILY_OPS_REPORTS) + os.sep).startswith(os.path.realpath(REPO) + os.sep),
       "the daily-ops report folder is outside the repo: %s" % DAILY_OPS_REPORTS)
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
