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

# How many scheduled days a job may miss in a row before the digest shouts.
#
# WHY THIS EXISTS (8 Aug 2026)
# ----------------------------
# task-hygiene-sweep did no work for four days straight and every morning read as
# normal. Each single day had an innocent explanation the digest reported quietly:
# 6 Aug halted on schema drift, 7 Aug skipped-stale after the Mac woke late, 8 Aug
# deferred on a wake-up DNS drop, then skipped-stale, then acquired the lock and
# halted on the same schema drift again. A skip is a shrug; four skips is an
# outage. Only the RUN of days makes it visible, and nothing was counting the run.
MISS_ALARM_DAYS = int(os.environ.get("DIGEST_MISS_ALARM_DAYS", "3"))
MISS_LOOKBACK_DAYS = 21


def read_jsonl_all(path):
    """Whole file, no window. The consecutive-miss count needs history the 26-hour
    window deliberately throws away."""
    out = []
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def _local_day(rec):
    """The local calendar day a log line belongs to, or None if unparseable.

    Both logs stamp UTC. The crons fire in local time, so comparing a UTC day
    against a cron day would misfile every job either side of midnight.
    """
    try:
        stamp = rec["ts"].replace("Z", "").split(".")[0]
        t = time.mktime(time.strptime(stamp, "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except (KeyError, ValueError):
        return None
    return datetime.fromtimestamp(t).date()


def good_days(job, all_events, all_statuses):
    """Local days on which this job actually finished its work.

    Taking the lock is NOT finishing the work. `released` now carries an outcome;
    a line without one predates the change and is read as completed, so old history
    stays honest rather than retroactively alarming.
    """
    days = set()
    for rec in all_events:
        if rec.get("job") != job or rec.get("state") != "released":
            continue
        if rec.get("outcome", "completed") != "completed":
            continue
        d = _local_day(rec)
        if d:
            days.add(d)
    for rec in all_statuses:
        if rec.get("job") != job or not rec.get("ok"):
            continue
        d = _local_day(rec)
        if d:
            days.add(d)
    return days


def first_seen(job, all_events, all_statuses):
    """The earliest day either log mentions this job at all.

    Before that day we have NO EVIDENCE, and no evidence is not evidence of
    failure. The queue log only begins 2026-08-06; without this floor a job with a
    two-day history was reported as having missed 21 straight days, which is the
    silent-zero trap running backwards — a wrong number that reads as an emergency.
    """
    days = []
    for rec in list(all_events) + list(all_statuses):
        if rec.get("job") != job:
            continue
        d = _local_day(rec)
        if d:
            days.append(d)
    return min(days) if days else None


def consecutive_misses(cfg, done, now_dt, floor=None):
    """How many scheduled days in a row this job was due and did not complete.

    Counting starts YESTERDAY. Today's occurrence may still be queued behind
    another job, and a digest that cries wolf gets muted, which costs more than
    the day of latency.

    Returns 0 when the logs do not reach back far enough to prove a run of misses.
    An unprovable alarm is worse than a late one: it trains Kevin to ignore the line.
    """
    cron = cfg.get("cron")
    if not cron:
        return 0
    if floor is None:
        # Neither log has ever mentioned this job. That may be a wiring gap, which
        # the "was due, no run recorded" line already reports; it is not a run of
        # failures, and claiming 21 missed days would be inventing history.
        return 0
    if now_dt.date() in done:
        # It completed today. Whatever happened before, the run is broken and the
        # alarm would be stale noise.
        return 0
    misses = 0
    for back in range(1, MISS_LOOKBACK_DAYS + 1):
        day = now_dt - timedelta(days=back)
        if day.date() < floor:
            # Ran out of history before reaching the alarm threshold. Say nothing.
            return 0
        if not jq.day_matches(cron, day):
            continue
        if day.date() in done:
            break
        misses += 1
    return misses


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
    halted = []

    # Run-of-days check, over the whole log rather than the 26-hour window. This is
    # the part that turns four innocent-looking mornings into one alarm.
    all_events = read_jsonl_all(EVENTS)
    all_statuses = read_jsonl_all(STATUS)
    stalled = []
    for job, cfg in schedule.items():
        if job.startswith("_") or not isinstance(cfg, dict) or not cfg.get("cron"):
            continue
        if cfg.get("enabled") is False:
            continue
        misses = consecutive_misses(
            cfg,
            good_days(job, all_events, all_statuses),
            now_dt,
            floor=first_seen(job, all_events, all_statuses),
        )
        if misses >= MISS_ALARM_DAYS:
            stalled.append((job, misses))
    stalled.sort(key=lambda x: -x[1])

    for job, due in expected_in_window(schedule, now_dt):
        states = [e["state"] for e in by_job.get(job, [])]
        st = last_status.get(job)

        # Held the lock but did not finish. Neither of these may read as a success.
        #
        #   released with outcome != completed  the routine itself said it bailed
        #   acquired, then lock-broken          the lease expired and it never
        #                                       released — it died mid-run
        #
        # On 8 Aug 2026 masterplan-sync and drift-monitor both had their locks
        # broken on lease expiry and both appeared under "Worked", because
        # `acquired` was the only thing being checked.
        lifecycle = [e for e in by_job.get(job, [])
                     if e["state"] in ("acquired", "released", "lock-broken")]
        last_life = lifecycle[-1] if lifecycle else None
        bailed = None
        if last_life and last_life["state"] == "released":
            if last_life.get("outcome", "completed") != "completed":
                bailed = last_life.get("reason") or last_life["outcome"]
        elif last_life and last_life["state"] in ("lock-broken", "acquired"):
            # A wrapped job that ran long has its lock broken by the next waiter,
            # then finds its own release refused — so lock-broken is its last
            # lifecycle event even though it finished fine. run-job.sh recorded the
            # truth in job-status.jsonl, so believe that over the lock when it exists.
            # Without this, compound-brain (exit 0 at 07:51) was reported as having
            # done no work.
            if not (st and st.get("ok")):
                bailed = (last_life.get("reason")
                          or "took the lock and never released it")

        if bailed:
            halted.append((job, bailed))
        elif "skipped-stale" in states and "acquired" not in states:
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

    # Routine stacking check. Deliberately duplicated here as well as in the
    # routine's own phase 1: if daily-ops does not run at all, its self-check
    # does not run either, and a second routine quietly firing every morning is
    # exactly the situation where that happens.
    #
    # Gated on daily-ops being IN THE SCHEDULE THIS DIGEST WATCHES, and pointed
    # at THIS DIGEST'S events file. Before 15 Aug 2026 it read the production
    # log unconditionally, so every fixture test of the digest was secretly
    # asserting the health of the real machine: the suite went red the morning
    # the real daily-ops failed to start, on tests that had nothing to do with
    # it — pass/fail tracking live state is theatre in both directions.
    stacking = None
    if "daily-ops" in schedule:
        try:
            os.environ["JOB_QUEUE_EVENTS"] = EVENTS
            spec = importlib.util.spec_from_file_location(
                "cr", os.path.join(_here, "check-routines.py"))
            cr = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cr)
            code, res = cr.check()
            if code != 0:
                stacking = res.get("reason")
        except Exception as e:        # never let the check take the digest down
            stacking = "could not verify the routine list: %s" % e

    lines = []
    alarm = False

    if stacking:
        alarm = True
        lines.append(":rotating_light: *Routine stacking* — %s" % stacking)
        lines.append("")

    # The control fires first and loudest.
    if not events:
        alarm = True
        lines.append(":rotating_light: *The job queue recorded nothing in %d hours.*"
                     % WINDOW_HOURS)
        lines.append("Nothing below can be trusted. Check job-queue.py and launchd.")
    else:
        headline = "%d ran" % len(ran)
        for label, group in (("failed", failed), ("halted", halted),
                             ("skipped", skipped),
                             ("queued out", timed_out), ("no record", never)):
            if group:
                headline += ", %d %s" % (len(group), label)
        icon = (":white_check_mark:"
                if not (failed or never or timed_out or halted or stalled)
                else ":warning:")
        lines.append("%s Scheduled jobs: %s." % (icon, headline))

    # Loudest after the queue-silence control: a job that has been quietly failing
    # to do its work for days. Each individual morning had an innocent reason.
    for job, misses in stalled:
        alarm = True
        lines.append(":no_entry: *%s* — no completed run in %d scheduled days. "
                     "Each day looked like a normal skip; the run is the problem."
                     % (job, misses))

    for job, reason in halted:
        alarm = True
        lines.append(":octagonal_sign: *%s* — took the lock but did not complete (%s)."
                     % (job, reason))

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


def guard(now_dt=None):
    """--guard mode: has daily-ops actually STARTED today? Early and loud.

    Exists because of 15 Aug 2026: the scheduler stamped lastRunAt at 06:20 and
    delivered the run to no session at all — no transcript, no phase-1 mark, no
    reports. The full digest caught it, but not until its own run time, and
    Kevin noticed first. This is the same check pulled forward: silent when the
    mark exists, one loud message when it does not.

    The scheduler's lastRunAt is deliberately NOT consulted. It was stamped that
    morning while nothing ran, which makes it an assertion by the component
    being checked. The phase-1 queue mark is written by the run itself doing
    work, so its absence is the ground truth.

    Gated on LONDON time in code, not in the launchd hour: the Mac's local
    timezone moves with Kevin (France now, UK later), and the Cloudflare cron
    incident already proved schedule-time day/hour maths silently drifts.
    Returns an exit code.
    """
    from zoneinfo import ZoneInfo
    now_ldn = (now_dt or datetime.now(ZoneInfo("Europe/London")))
    if now_ldn.tzinfo is None:
        now_ldn = now_ldn.replace(tzinfo=ZoneInfo("Europe/London"))
    # The run fires at 06:05 London and marks within minutes. 08:00 leaves room
    # for a slow wake without letting a dead morning go unreported for hours.
    if now_ldn.hour < 8:
        print("guard: before 08:00 London, too early to judge")
        return 0

    today = now_ldn.strftime("%Y-%m-%d")
    started = False
    for rec in read_jsonl_all(EVENTS):
        if rec.get("job") != "daily-ops":
            continue
        # "state", not "event" — job-queue.py:153 writes {"ts","job","state"}
        # and check-routines.py reads the same key. The first cut of this guard
        # read "event", which matches NOTHING, so it would have alarmed every
        # single morning including healthy ones. It passed a live dry-run only
        # because that morning genuinely had no mark: right answer, wrong
        # reason. Caught when the fixtures were corrected to the real shape.
        if rec.get("state") not in ("acquired", "started", "mark"):
            continue
        ts = rec.get("ts", "")
        try:
            when = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            local_day = when.astimezone(ZoneInfo("Europe/London")).strftime("%Y-%m-%d")
        except ValueError:
            continue
        if local_day == today:
            started = True
            break

    if started:
        print("guard: daily-ops marked today, healthy")
        return 0

    msg = (":rotating_light: *daily-ops has not started today* (%s, checked %s London).\n"
           "The scheduler may claim it ran — its stamp is not evidence, the phase-1 "
           "mark is, and there is none. Nothing has swept, dispatched or reported "
           "today. Open Claude Code in the dashboard repo and say *run daily ops*, "
           "or it next fires tomorrow at 06:05."
           % (today, now_ldn.strftime("%H:%M")))
    print(msg)
    post_to_slack(msg)
    # run-job.sh shouts lines starting ERROR:, giving a second alert path.
    print("\nERROR: daily-ops left no mark by %s London on %s"
          % (now_ldn.strftime("%H:%M"), today))
    return 1


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
    if "--guard" in sys.argv:
        return guard()
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
