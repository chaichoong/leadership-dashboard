#!/usr/bin/env python3
"""One message each morning covering every scheduled job on this Mac.

Replaces the scatter of per-routine Slack DMs. Says what ran, what queued, what
was skipped for being too late, what the routines found, and what needs Kevin.

THE CONTROL
-----------
A digest that reports "all clear" when nothing ran is worse than no digest, and
this codebase has been bitten by exactly that: a nightly publisher failed with a
401 for days while every log said fine. So:

  * The jobs expected in the window are DERIVED from job-schedule.json, not
    hardcoded. A job added to the schedule is watched from that moment.
  * Zero queue events in 26 hours is an ALARM, not a pass. That means the queue
    itself stopped, which is the failure mode this whole feature could
    introduce.
  * Skipped and queued-away jobs are reported as such. They never read as
    successes.

Exit code is 1 when the digest contains anything needing attention, so the
launchd wrapper records a real failure rather than a clean run.
"""

import importlib.util
import json
import os
import sys
import time
from datetime import datetime, timedelta

HOME = os.path.expanduser("~")
LOGDIR = os.environ.get("JOB_LOG_DIR", os.path.join(HOME, "knowledge-os/logs"))
QUEUE_DIR = os.environ.get("JOB_QUEUE_DIR", os.path.join(LOGDIR, "queue"))
EVENTS = os.path.join(QUEUE_DIR, "queue-events.jsonl")
STATUS = os.path.join(LOGDIR, "job-status.jsonl")
FINDINGS = os.environ.get("FINDINGS_FILE", os.path.join(LOGDIR, "findings-queue.jsonl"))
WEBHOOK_FILE = os.path.join(HOME, "knowledge-os/slack_webhook.txt")

WINDOW_HOURS = 26

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("jq", os.path.join(_here, "job-queue.py"))
jq = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(jq)


def read_jsonl(path, since_ts):
    out = []
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            # queue-events.jsonl carries milliseconds, job-status.jsonl does not.
            # Read both rather than silently dropping every line from one file,
            # which would show as a suspiciously quiet morning.
            try:
                stamp = rec["ts"].replace("Z", "").split(".")[0]
                t = time.mktime(time.strptime(stamp, "%Y-%m-%dT%H:%M:%S")) - time.timezone
            except (KeyError, ValueError):
                continue
            if t >= since_ts:
                rec["_t"] = t
                out.append(rec)
    return out


# A job due in the last few minutes may be sitting in the queue right now.
# Flagging it as missing would make the digest cry wolf every time it happened
# to run while something was still waiting its turn.
GRACE_MINUTES = float(os.environ.get("DIGEST_GRACE_MINUTES", "45"))


def expected_in_window(schedule, now_dt):
    """Jobs whose cron should have fired in the last WINDOW_HOURS."""
    start = now_dt - timedelta(hours=WINDOW_HOURS)
    cutoff = now_dt - timedelta(minutes=GRACE_MINUTES)
    expected = []
    for job, cfg in schedule.items():
        if job.startswith("_") or not isinstance(cfg, dict) or not cfg.get("cron"):
            continue
        # A task switched off in the scheduler is not a missing run.
        if cfg.get("enabled") is False:
            continue
        due = jq.last_scheduled(cfg["cron"], ref=now_dt)
        if due and start <= due <= cutoff:
            expected.append((job, due))
    return sorted(expected, key=lambda x: x[1])


def build(now_dt=None):
    now_dt = now_dt or datetime.now()
    since = time.time() - WINDOW_HOURS * 3600

    schedule = jq.load_schedule()
    events = read_jsonl(EVENTS, since)
    statuses = read_jsonl(STATUS, since)

    by_job = {}
    for e in events:
        by_job.setdefault(e["job"], []).append(e)

    last_status = {}
    for s in statuses:
        last_status[s["job"]] = s

    ran, failed, skipped, timed_out, never = [], [], [], [], []

    for job, due in expected_in_window(schedule, now_dt):
        states = [e["state"] for e in by_job.get(job, [])]
        st = last_status.get(job)

        if "skipped-stale" in states and "acquired" not in states:
            ev = [e for e in by_job[job] if e["state"] == "skipped-stale"][-1]
            skipped.append((job, ev.get("reason", "too late")))
        elif "queue-timeout" in states and "acquired" not in states:
            ev = [e for e in by_job[job] if e["state"] == "queue-timeout"][-1]
            timed_out.append((job, ev.get("behind") or "another job"))
        elif "acquired" in states:
            if st and not st.get("ok", True):
                failed.append((job, st.get("reason", "reported a failure")))
            else:
                ran.append(job)
        elif st is not None:
            # Ran without touching the queue. Expected for the jobs marked
            # queued:false (they report on or clean up after the queue); a
            # wiring gap for anything else. Either way it ran, so grade it on
            # what run-job.sh recorded.
            if st.get("ok"):
                ran.append(job)
            else:
                failed.append((job, st.get("reason", "failed")))
        else:
            never.append(job)

    # Findings
    open_findings = []
    if os.path.exists(FINDINGS):
        os.environ["FINDINGS_FILE"] = FINDINGS
        spec = importlib.util.spec_from_file_location(
            "fnd", os.path.join(_here, "findings.py"))
        fnd = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fnd)
        open_findings = [r for r in fnd.current_state().values()
                         if r["status"] in ("open", "claimed")]

    lines = []
    alarm = False

    # The control fires first and loudest.
    if not events:
        alarm = True
        lines.append(":rotating_light: *The job queue recorded nothing in %d hours.*"
                     % WINDOW_HOURS)
        lines.append("Nothing below can be trusted. Check job-queue.py and launchd.")
    else:
        headline = "%d ran" % len(ran)
        for label, group in (("failed", failed), ("skipped", skipped),
                             ("queued out", timed_out), ("no record", never)):
            if group:
                headline += ", %d %s" % (len(group), label)
        icon = ":white_check_mark:" if not (failed or never or timed_out) else ":warning:"
        lines.append("%s Scheduled jobs: %s." % (icon, headline))

    for job, reason in failed:
        alarm = True
        lines.append(":x: *%s* — %s" % (job, reason))
    for job in never:
        alarm = True
        lines.append(":grey_question: *%s* — was due, no run recorded." % job)
    for job, behind in timed_out:
        alarm = True
        lines.append(":hourglass: *%s* — gave up waiting behind %s." % (job, behind))
    for job, reason in skipped:
        lines.append(":fast_forward: %s — skipped, %s" % (job, reason))
    if ran:
        lines.append("Worked: " + ", ".join(sorted(ran)))

    if open_findings:
        crit = [f for f in open_findings if f.get("severity") in ("critical", "high")]
        lines.append("")
        lines.append("*Findings waiting for the fixer: %d* (%d high or critical)"
                     % (len(open_findings), len(crit)))
        for f in crit[:5]:
            lines.append("  • [%s] %s — %s" % (f.get("severity"), f["routine"], f["title"]))
        if len(open_findings) > len(crit):
            lines.append("  • plus %d medium or low" % (len(open_findings) - len(crit)))
        alarm = alarm or bool(crit)

    return "\n".join(lines), alarm


def post_to_slack(msg):
    if not os.path.exists(WEBHOOK_FILE):
        return
    url = open(WEBHOOK_FILE).read().strip()
    if not url.startswith("https://hooks.slack.com/"):
        return
    import urllib.request
    req = urllib.request.Request(
        url, data=json.dumps({"text": msg}).encode(),
        headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=15)
    except Exception as e:  # a failed post must not hide the digest itself
        print("WARNING: could not post to Slack: %s" % e, file=sys.stderr)


def main():
    msg, alarm = build()
    print(msg)
    if "--no-post" not in sys.argv:
        post_to_slack(msg)
        if alarm:
            os.system('/usr/bin/osascript -e \'display notification '
                      '"Scheduled jobs need a look." with title "Morning digest"\' '
                      '>/dev/null 2>&1')
    return 1 if alarm else 0


if __name__ == "__main__":
    sys.exit(main())
