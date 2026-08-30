#!/usr/bin/env python3
"""retry-deferred.py — re-fire a scheduled job whose blocker has since cleared.

WHY THIS EXISTS (27 Aug 2026)
-----------------------------
launchd fires a job once, at its calendar time. If the machine is not ready the
queue DEFERS rather than failing, which is right — a hard failure every night
teaches everyone to ignore the alarm. But nothing ever came back. A defer was a
lost day, and `maxLateMinutes` (300 for the brain jobs) allowed five hours of
lateness that nothing could ever use, because no second attempt existed.

Measured that day: feed-brain, compound-brain, publish-brain and
knowledge-os-sort last completed on 23 Aug. Every night after:

    21:45  waiting-for-ready    google drive: cannot read founder-profile.md:
    22:30  deferred-not-ready   [Errno 11] Resource deadlock avoided

The Mac is asleep or clamshell-closed at 22:45 and Google Drive's file provider
does not serve a DarkWake launchd job, so the vault lists but will not open. By
morning the Mac is awake, Drive is fine, and the work is simply skipped. Four
days of the brain not being fed, and the same shape had already hit
masterplan-sync and daily-ops-guard.

WHAT IT DOES
------------
Hourly, for each job that OPTED IN with `"retryWhenDeferred": true`:

  1. it was due, and is still inside its own maxLateMinutes window
  2. it has not already succeeded since that due time
  3. it actually DEFERRED since that due time (not merely "has not run yet" —
     a job whose time simply has not come is not a missed job)
  4. its preconditions are met RIGHT NOW (retrying into the same wall wastes
     the attempt and produces an alarm about a machine that is merely asleep)
  5. the queue lock is free, and it has not already been retried MAX_PER_DAY times

then `launchctl kickstart` it, so launchd runs it exactly as it normally would.
Reconstructing the command here would be a second copy of every job's command
line, and a second copy is what drifts.

WHY OPT-IN
----------
Some jobs are cheap shell scripts and some are long Claude routines that spend
Kevin's allowance. Re-running the second kind unasked is not a fix, it is a
surprise bill. So a job is retried only when its schedule entry says so — and a
job that deferred WITHOUT opting in is REPORTED, never silently passed over, so
the gap stays visible instead of becoming a habit.

LABELS ARE DISCOVERED, NOT ASSUMED
----------------------------------
Most jobs are `com.kevinbrittain.<job>`; masterplan-sync is `com.od.masterplan-sync`.
Assuming the convention would mean a job that can never be re-fired while this
script reports a clean run for ever. So the label is resolved by reading the
LaunchAgents plists, and an opted-in job with no resolvable label FAILS the run.

    python3 scripts/retry-deferred.py [--dry-run] [--json]
    python3 scripts/retry-deferred.py selftest
"""

import json
import os
import plistlib
import subprocess
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "jq", os.path.join(os.path.dirname(os.path.abspath(__file__)), "job-queue.py"))
jq = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(jq)

HOME = os.path.expanduser("~")
AGENTS_DIR = os.path.join(HOME, "Library", "LaunchAgents")
STATUS_FILE = os.path.join(HOME, "knowledge-os", "logs", "job-status.jsonl")
LEDGER = os.path.join(HOME, "knowledge-os", "logs", "retry-deferred", "attempts.jsonl")
MAX_PER_DAY = 3

# Days without a completion before a MISSED job stops being "late" and starts
# being broken. Two, because every job here runs at least daily: missing two
# of its own scheduled runs cannot be bad luck.
MISSED_DAYS_ESCALATE = 2

# States that mean "the queue turned this job away because the machine was not
# ready". Kept as a named set so a rename in job-queue.py is a loud test failure
# rather than a sweep that quietly stops finding anything.
DEFER_STATES = ("deferred-not-ready", "deferred-stale-precondition")


# ---------------------------------------------------------------------------
# reading the world
# ---------------------------------------------------------------------------

def launchd_labels():
    """{job name -> launchd label}, resolved by reading the plists.

    Matches on the job name appearing as its own ProgramArguments token, which
    is how run-job.sh and job-queue.py are always invoked. Substring matching
    would pair `daily-ops` with `daily-ops-guard`.
    """
    out = {}
    if not os.path.isdir(AGENTS_DIR):
        return out
    for name in os.listdir(AGENTS_DIR):
        if not name.endswith(".plist"):
            continue
        try:
            with open(os.path.join(AGENTS_DIR, name), "rb") as fh:
                pl = plistlib.load(fh)
        except Exception:
            continue
        label = pl.get("Label")
        args = [str(a) for a in (pl.get("ProgramArguments") or [])]
        if not label:
            continue
        for tok in args:
            # A bare token, never a path or a flag: run-job.sh and job-queue.py
            # are both invoked as `... <job-name> ...`. Exact match, so
            # `daily-ops` cannot claim `daily-ops-guard`.
            if tok and not tok.startswith("/") and not tok.startswith("-"):
                out.setdefault(tok, label)
    return out


def read_status_rows():
    rows = []
    if not os.path.exists(STATUS_FILE):
        return rows
    with open(STATUS_FILE) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows


def _ts(value):
    return jq.parse_event_ts(value)


def _aware(dt):
    """Make a naive local datetime comparable with the logs' aware UTC stamps.

    job-queue's last_scheduled() returns NAIVE local time; parse_event_ts()
    returns AWARE UTC. Comparing them raises TypeError, which crashed the first
    dry run of this sweep — and would have crashed it every hour, silently, had
    it shipped. Python treats a naive datetime as local on astimezone(), which
    is exactly the intent here.
    """
    if dt is None or dt.tzinfo is not None:
        return dt
    return dt.astimezone()


def succeeded_since(job, since, status_rows, events):
    """Has `job` finished successfully since `since`?

    Reads BOTH the wrapped-job status log and the queue's own release events,
    because the two job modes leave different evidence and checking only one
    would re-fire a job that had already run.
    """
    for r in status_rows:
        if r.get("job") != job or not r.get("ok"):
            continue
        t = _ts(r.get("ts"))
        if t and t >= since:
            return True
    for e in events:
        if e.get("job") != job:
            continue
        if e.get("state") not in ("released", "finished"):
            continue
        if e.get("outcome") not in (None, "completed"):
            continue
        t = _ts(e.get("ts"))
        if t and t >= since:
            return True
    return False


def days_since_success(job, ref, status_rows, events):
    """Whole days since `job` last completed, or None if it never has here.

    WHY (finding 397, 29 Aug 2026): "MISSED" is printed identically whether a job
    lost ONE morning to a flap or has not run for two days. On 29 Aug
    compound-brain and feed-brain had last run on 27 Aug — the brain had not been
    fed, compounded or published for two days — and the only signal was hourly
    BLOCKED lines nobody reads. A day lost is noise; a job silent across two of
    its own scheduled runs is a broken system, and the two must not look the same.
    """
    ref = _aware(ref)
    last = None
    for r in status_rows:
        if r.get("job") != job or not r.get("ok"):
            continue
        t = _ts(r.get("ts"))
        if t and (last is None or t > last):
            last = t
    for e in events:
        if e.get("job") != job:
            continue
        if e.get("state") not in ("released", "finished"):
            continue
        if e.get("outcome") not in (None, "completed"):
            continue
        t = _ts(e.get("ts"))
        if t and (last is None or t > last):
            last = t
    if last is None:
        return None
    return max(0, (ref.date() - last.astimezone(jq.LONDON).date()).days)


def deferred_since(job, since, events):
    for e in events:
        if e.get("job") != job or e.get("state") not in DEFER_STATES:
            continue
        t = _ts(e.get("ts"))
        if t and t >= since:
            return e.get("reason") or "deferred"
    return None


def attempts_today(job, ref):
    """How many times we already re-fired this job today.

    `ref` must be an AWARE datetime. jq.now() returns a float (time.time()),
    and passing that here crashed the first real run — but only AFTER the
    first kickstart, because the early return below hides the bug until the
    ledger file exists. A dry run cannot reach it and neither can a first
    run, which is exactly the shape that reaches production.
    """
    if not os.path.exists(LEDGER):
        return 0
    day = ref.astimezone(jq.LONDON).date()
    n = 0
    with open(LEDGER) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get("job") != job or r.get("action") != "kickstart":
                continue
            t = _ts(r.get("at"))
            if t and t.astimezone(jq.LONDON).date() == day:
                n += 1
    return n


def ledger_append(entry):
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    with open(LEDGER, "a") as fh:
        fh.write(json.dumps(dict(entry, at=jq.iso())) + "\n")


# ---------------------------------------------------------------------------
# the decision — pure, so the tests can drive every branch
# ---------------------------------------------------------------------------

def decide(job, cfg, ref, *, due, late, is_stale, opted_in, has_label,
           succeeded, defer_reason, ready, ready_why, lock_holder, attempts,
           days_silent=None):
    """(action, reason). action is 'retry' | 'skip' | 'blocked' | 'gap' | 'error'
    | 'missed' | 'missed-days'.

    No I/O in here on purpose: every branch below is a real state this has been
    in, and a decision function that needs a machine in that state to be tested
    is a decision function that never gets tested.
    """
    # THE ONLY THREE SILENCES. Each means the job has nothing outstanding: it
    # was never due, it already ran, or it never deferred. They are named
    # individually rather than sharing one "skip" so that report() can
    # allow-list silence instead of guessing at it — see SILENT_ACTIONS.
    if due is None:
        return "skip-not-due", "no scheduled occurrence in the lookback window"
    if succeeded:
        return "skip-succeeded", "already completed since %s" % due.strftime("%H:%M")
    if defer_reason is None:
        return "skip-not-deferred", "did not defer since %s — nothing to retry" % due.strftime("%H:%M")

    # From here the job DID defer and has not run. Everything below is a reason
    # we cannot help, and every one of them is reported rather than dropped.
    if not opted_in:
        return "gap", ("deferred (%s) but has no \"retryWhenDeferred\": true in "
                       "job-schedule.json, so nothing will re-run it today" % defer_reason)
    if is_stale:
        # NOT a skip. This job deferred, was never re-run, and is now past its
        # own lateness limit: it has LOST THE DAY. Filing that under "skip"
        # would have let the sweep print a clean all-clear on the very morning
        # the brain was four days unfed, which is the failure this whole job
        # exists to end.
        base = ("deferred (%s) and is now %.0f min late, past its "
                "maxLateMinutes (%s). It did not run and will not run today."
                % (defer_reason, late or 0, cfg.get("maxLateMinutes")))
        # ESCALATION, not a louder version of the same line (finding 397).
        # One lost morning is a flap. Two lost days is the brain going stale
        # with nothing telling Kevin, which is what happened 27-29 Aug 2026:
        # compound-brain and feed-brain last ran on the 27th and every hourly
        # pass printed the same MISSED line as any ordinary late job.
        if days_silent is not None and days_silent >= MISSED_DAYS_ESCALATE:
            return "missed-days", (
                "%s IT HAS NOT COMPLETED FOR %d DAYS — this is no longer a late "
                "job, it is a job that has stopped." % (base, days_silent))
        return "missed", base
    if not has_label:
        return "error", ("opted in to retry but no launchd label could be resolved; "
                         "it can never be re-fired and this run would otherwise look clean")
    # WAITING, NOT SILENCE. Both of these were "skip" until 28 Aug 2026, and
    # report() prints no line for a skip — so on a morning when the queue
    # happened to be busy, three brain jobs that had deferred overnight and
    # still had not run vanished from the report and it printed "nothing had
    # deferred — this is a real all-clear". Observed live that morning:
    # inbound-triage held the lock, feed-brain was 40 minutes from losing the
    # day, and the sweep built to prevent exactly that said everything was
    # fine. Whether we can help is not the question. Whether the job ran is.
    if attempts >= MAX_PER_DAY:
        return "waiting", ("deferred (%s) and already re-fired %d times today "
                           "(cap %d); it has still not run"
                           % (defer_reason, attempts, MAX_PER_DAY))
    if not ready:
        return "blocked", "still blocked: %s" % ready_why
    if lock_holder:
        return "waiting", ("deferred (%s); ready to re-fire but the queue lock is "
                           "held by %s, so it has still not run"
                           % (defer_reason, lock_holder))
    return "retry", "deferred (%s); blocker has cleared, re-firing" % defer_reason


# ---------------------------------------------------------------------------
# the sweep
# ---------------------------------------------------------------------------

def sweep(dry_run=False, ref=None):
    ref = ref or datetime.now()
    schedule = jq.load_schedule()
    if not schedule:
        raise SystemExit("BROKEN: job-schedule.json is empty or unreadable — a sweep "
                         "that cannot read the schedule must not report a clean run")
    # LIST, not the generator jq.read_events() returns. Consumed once, it is
    # empty for every later caller, so the first job checked would read
    # correctly and every job after it would see zero events and report
    # "did not defer" — a broken read wearing the face of an all-clear. Caught
    # in this sweep's own first dry run; guarded by tests/retry-deferred.test.js.
    events = list(jq.read_events())
    labels = launchd_labels()
    status_rows = read_status_rows()
    holder = None
    try:
        h = jq.read_holder()
        holder = (h or {}).get("job")
    except Exception:
        holder = None

    results = []
    for job, cfg in sorted(schedule.items()):
        if job.startswith("_") or not isinstance(cfg, dict) or not cfg.get("cron"):
            continue
        if cfg.get("enabled") is False:
            continue
        due = jq.last_scheduled(cfg["cron"], ref=ref)
        is_stale, late, _ = jq.staleness(job, schedule, ref=ref)
        ready, ready_why = (True, "no preconditions")
        if cfg.get("needs"):
            try:
                ready, ready_why = jq.preconditions_met(cfg)
            except Exception as e:
                ready, ready_why = False, "precondition probe failed: %s" % e
        action, reason = decide(
            job, cfg, ref,
            due=due, late=late, is_stale=is_stale,
            opted_in=bool(cfg.get("retryWhenDeferred")),
            has_label=job in labels,
            succeeded=succeeded_since(job, _aware(due), status_rows, events) if due else False,
            defer_reason=deferred_since(job, _aware(due), events) if due else None,
            ready=ready, ready_why=ready_why,
            lock_holder=holder if holder and holder != job else None,
            attempts=attempts_today(job, datetime.now().astimezone()),
            days_silent=days_since_success(job, ref, status_rows, events),
        )
        row = {"job": job, "action": action, "reason": reason,
               "due": due.strftime("%Y-%m-%d %H:%M") if due else None}
        if action == "retry" and not dry_run:
            label = labels[job]
            cmd = ["launchctl", "kickstart", "gui/%d/%s" % (os.getuid(), label)]
            p = subprocess.run(cmd, capture_output=True, text=True)
            row["label"] = label
            row["ok"] = p.returncode == 0
            if p.returncode != 0:
                row["action"] = "error"
                row["reason"] = "launchctl kickstart failed (rc=%d): %s" % (
                    p.returncode, (p.stderr or p.stdout).strip()[:200])
            ledger_append({"job": job, "action": "kickstart", "label": label,
                           "ok": row["ok"], "reason": reason})
        elif action == "retry" and dry_run:
            row["label"] = labels.get(job)
        results.append(row)
    return results


# The ONLY actions that may pass without a line in the report. Each means the
# job has nothing outstanding. Every other action — including one added to
# decide() later — is printed, because a job that deferred and has not run must
# never be represented by silence. Inverting this was the 28 Aug 2026 fix:
# "queue lock is busy" used to be a bare "skip", and a skip printed nothing.
SILENT_ACTIONS = ("skip-not-due", "skip-succeeded", "skip-not-deferred")

ACTION_LABELS = {
    "retry": "RE-FIRED",
    "missed": "MISSED",
    "missed-days": "STOPPED",
    "blocked": "BLOCKED",
    "waiting": "WAITING",
    "gap": "NOT WIRED",
    "error": "ERROR",
}


def report(results, as_json=False):
    if as_json:
        print(json.dumps(results, indent=2))
    counts = {}
    for r in results:
        counts[r["action"]] = counts.get(r["action"], 0) + 1
    retried = [r for r in results if r["action"] == "retry"]
    blocked = [r for r in results if r["action"] == "blocked"]
    gaps = [r for r in results if r["action"] == "gap"]
    missed = [r for r in results if r["action"] == "missed"]
    stopped = [r for r in results if r["action"] == "missed-days"]
    waiting = [r for r in results if r["action"] == "waiting"]
    errors = [r for r in results if r["action"] == "error"]
    # Anything this run did not recognise. An action added to decide() without
    # a line here would otherwise be as invisible as the old silent skip was.
    known = SILENT_ACTIONS + tuple(ACTION_LABELS)
    unknown = [r for r in results if r["action"] not in known]

    if not as_json:
        # ABSENCE, NOT SUCCESSES. A list of what ran cannot tell you what did
        # not, and what did not is the whole point of this job.
        print("retry-deferred: %d re-fired, %d lost the day, %d STOPPED, "
              "%d still blocked, %d waiting, %d not opted in, %d error(s)"
              % (len(retried), len(missed), len(stopped), len(blocked),
                 len(waiting), len(gaps), len(errors)))
        # NAMED ON ITS OWN LINE, at the top, so daily-ops can lift it straight
        # onto the BROKEN line. A job buried thirty lines down among BLOCKED
        # noise is a job nobody reads — that is exactly how the brain went two
        # days unfed while every pass printed something.
        if stopped:
            print("  ESCALATE: %s have not completed for %d+ days"
                  % (", ".join(sorted(r["job"] for r in stopped)),
                     MISSED_DAYS_ESCALATE))
        # SILENCE IS THE ALLOW-LIST, not the default. Every result whose action
        # is not one of the three "nothing outstanding" states gets a line,
        # including one this function has never heard of.
        for r in results:
            if r["action"] in SILENT_ACTIONS:
                continue
            print("  %-9s %-20s %s"
                  % (ACTION_LABELS.get(r["action"], r["action"].upper()),
                     r["job"], r["reason"]))
        if not any(r["action"] not in SILENT_ACTIONS for r in results):
            print("  nothing had deferred — this is a real all-clear, "
                  "read from %d schedule entries" % len(results))
    # A job that has stopped is a failure of this sweep's whole purpose, so the
    # exit code says so. MISSED for one day does not — that is the flap case,
    # and alarming on it daily is what teaches people to ignore the alarm.
    return 1 if (errors or unknown or stopped) else 0


# ---------------------------------------------------------------------------
# selftest — the control
# ---------------------------------------------------------------------------

def selftest():
    now = datetime(2026, 8, 27, 8, 0)
    due = now - timedelta(hours=9)
    cfg = {"cron": "45 22 * * *", "maxLateMinutes": 300, "retryWhenDeferred": True}
    base = dict(due=due, late=540.0, is_stale=False, opted_in=True, has_label=True,
                succeeded=False, defer_reason="google drive: cannot read", ready=True,
                ready_why="ready", lock_holder=None, attempts=0, days_silent=0)

    def d(**over):
        return decide("feed-brain", cfg, now, **dict(base, **over))[0]

    cases = [
        ("deferred, clear, in window -> retry", d(), "retry"),
        ("already succeeded -> silent",         d(succeeded=True), "skip-succeeded"),
        ("never deferred -> silent",            d(defer_reason=None), "skip-not-deferred"),
        ("not opted in -> gap (reported)",      d(opted_in=False), "gap"),
        ("past its window -> missed (NOT a clean skip)", d(is_stale=True), "missed"),
        # Finding 397: one lost morning and a job that has stopped for two days
        # printed the SAME line, so the second was invisible inside the first.
        ("stale + 2 days silent -> missed-days (escalated)",
         d(is_stale=True, days_silent=MISSED_DAYS_ESCALATE), "missed-days"),
        ("stale + 1 day silent -> plain missed, not escalated",
         d(is_stale=True, days_silent=1), "missed"),
        ("stale + never seen here -> plain missed, not a fake escalation",
         d(is_stale=True, days_silent=None), "missed"),
        ("2 days silent but NOT stale -> still retryable, not escalated",
         d(days_silent=5), "retry"),
        ("no launchd label -> error",           d(has_label=False), "error"),
        # These two were "skip" until 28 Aug 2026, and report() prints nothing
        # for a skip. Both mean the job deferred and has STILL NOT RUN, so both
        # must be visible or the sweep prints an all-clear over an unfed brain.
        ("cap reached -> waiting (reported)",   d(attempts=MAX_PER_DAY), "waiting"),
        ("still blocked -> blocked",            d(ready=False, ready_why="drive down"), "blocked"),
        ("lock held -> waiting (reported)",     d(lock_holder="daily-ops"), "waiting"),
        ("no occurrence -> silent",             d(due=None), "skip-not-due"),
        # Order matters: a job that never deferred must not be reported as a gap
        # just because it is not opted in, or every job on the Mac becomes noise.
        ("no defer + not opted in -> silent",   d(defer_reason=None, opted_in=False),
         "skip-not-deferred"),
    ]
    failed = [(n, got, want) for n, got, want in cases if got != want]
    for n, got, want in cases:
        print("%-4s %s (got %s)" % ("PASS" if got == want else "FAIL", n, got))

    # THE INVARIANT, not just the table. Once a job has deferred and has not
    # succeeded, NO combination of the remaining inputs may return a silent
    # action — that is what "queue lock held" quietly did for three brain jobs
    # on 28 Aug 2026. Enumerated rather than listed, so a branch added later
    # is covered by a case nobody remembered to write.
    silent_leaks = []
    for over in ({}, {"opted_in": False}, {"is_stale": True}, {"has_label": False},
                 {"attempts": MAX_PER_DAY}, {"ready": False, "ready_why": "drive down"},
                 {"lock_holder": "daily-ops"},
                 {"attempts": MAX_PER_DAY, "lock_holder": "daily-ops"},
                 {"is_stale": True, "lock_holder": "daily-ops"},
                 {"is_stale": True, "days_silent": 3},
                 {"ready": False, "ready_why": "x", "lock_holder": "daily-ops"}):
        got = d(**over)
        if got in SILENT_ACTIONS:
            silent_leaks.append((over, got))
    for over, got in silent_leaks:
        print("FAIL a deferred job went SILENT as %s with %s" % (got, over))
    print("%-4s a job that deferred is never silent (%d input combinations)"
          % ("FAIL" if silent_leaks else "PASS", 11))

    print("\n%d/%d decision cases pass." % (len(cases) - len(failed), len(cases)))
    return 1 if (failed or silent_leaks) else 0


def main():
    argv = sys.argv[1:]
    if "selftest" in argv:
        return selftest()
    results = sweep(dry_run="--dry-run" in argv)
    return report(results, as_json="--json" in argv)


if __name__ == "__main__":
    sys.exit(main())
