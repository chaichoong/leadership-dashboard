#!/usr/bin/env python3
"""Serialise every scheduled job on this Mac so no two ever run at once.

WHY THIS EXISTS (6 Aug 2026)
----------------------------
Fourteen Claude routines and eleven launchd jobs share one machine and one git
checkout. Their crons are spread across the day, so on paper they never meet.
In practice the Mac sleeps, and on wake every overdue job fires at once. On
6 Aug 2026 ten routines whose crons span 02:00 to 21:30 all launched between
08:07 and 08:33, produced nine commits in twenty-eight minutes, left seven
files dirty across four unrelated features, and cost about an hour to untangle.

Nothing in the stack held a lock. run-job.sh recorded whether a job worked but
never asked whether another was already running.

TWO MODES, because two very different things need serialising
-------------------------------------------------------------
  wrapped      launchd shell jobs. We start the child, so we hold the lock for
               its lifetime and can prove the holder is alive with kill -0.

  cooperative  Claude scheduled routines. The app starts those, not us, so they
               cannot be wrapped. Their SKILL.md calls `acquire` as its first
               step and `release` as its last. The shell running `acquire`
               EXITS IMMEDIATELY, so PID liveness is meaningless for these and
               a time-based lease is the only honest check. Get this wrong and
               the lock frees itself the instant it is taken.

LOCKING PRIMITIVE
-----------------
macOS ships no flock(1). `mkdir` is atomic on every POSIX filesystem, so the
lock is a directory and the holder's details go in a file inside it.

SKIPPED IS NOT PASSED
---------------------
A job that was queued away or skipped for lateness never writes ok:true to
job-status.jsonl. It writes its own state to queue-events.jsonl, which the
morning digest reads. A quiet morning where nothing ran must read as an alarm,
never as a clean sweep.
"""

import argparse
import errno
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta

HOME = os.path.expanduser("~")
STATE_DIR = os.environ.get("JOB_QUEUE_DIR", os.path.join(HOME, "knowledge-os/logs/queue"))
SCHEDULE_FILE = os.environ.get(
    "JOB_QUEUE_SCHEDULE",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "job-schedule.json"),
)

LOCK_DIR = os.path.join(STATE_DIR, "lock")
HOLDER_FILE = os.path.join(LOCK_DIR, "holder.json")
TICKET_DIR = os.path.join(STATE_DIR, "tickets")
EVENTS = os.path.join(STATE_DIR, "queue-events.jsonl")

# Exit codes. 0 and 3 are both "nothing went wrong"; 75 is EX_TEMPFAIL.
EX_OK = 0
EX_SKIPPED = 3
EX_BUSY = 75
EX_NOTREADY = 69   # EX_UNAVAILABLE: the machine is not ready for this job yet
EX_USAGE = 64
# 70 (EX_SOFTWARE): we THOUGHT we held the lock and we do not any more. Distinct
# from EX_USAGE on purpose. Losing a lease is not a caller mistake, it is a job
# that must stop: whatever broke or stole the lock is free to be writing right
# now, and a second writer is the exact collision the queue exists to prevent.
# A caller that treats 64 as "bad arguments" would shrug this off.
EX_LOSTLOCK = 70

DEFAULT_LEASE_MIN = 45
# How long a job waits for its turn before giving up.
#
# Was 30 minutes, which sounded generous and was not. On 7 Aug 2026 queue-fixer
# held the lock for over half an hour on its first run and squeezed out
# masterplan-sync, project-status-sync and uc-notifier-watchdog, all of which
# gave up at exactly 09:11:18 without running. A Claude routine doing real work
# routinely holds the lock for 10-40 minutes, so the wait has to be longer than
# the work, not longer than a guess.
#
# The lock cannot be held for ever regardless: every holder carries a lease, so
# waiting longer risks a slower morning, never a permanent stall.
DEFAULT_TIMEOUT_MIN = 120
# How long a job waits for the network/Drive before giving up on the whole run.
#
# Was 10 minutes. On 8 Aug 2026 task-hygiene-sweep fired at 01:10, found DNS could
# not resolve api.airtable.com on a Mac that had just woken, waited its ten minutes,
# gave up at 01:20 and the run was DROPPED — not retried, not requeued. By the time
# the machine was properly awake the job was 456 minutes late and the staleness
# guard skipped it too. One transient DNS blip cost the entire day.
#
# This wait happens BEFORE the lock is taken, so a job waiting here blocks nothing
# and costs nothing when the network is fine (the first check passes instantly).
# 45 minutes still lands inside the 180-minute staleness limit, so a rescued run is
# a run that actually happens rather than one that gets skipped for lateness.
DEFAULT_READY_WAIT_MIN = 45
# Poll gently rather than hammering a half-awake interface every 15s for 45 minutes.
READY_POLL_START = 5
READY_POLL_MAX = 60

# Wrapped jobs hold a SHORT lease kept alive by a heartbeat. The Mac sleeping
# mid-job is the failure that matters: the process stays alive, so PID checks
# pass, but nothing progresses. A heartbeat stops with the process, so the lock
# frees in minutes rather than hours.
#
# This and the readiness wait above solve two different halves of the same
# sleeping-Mac problem and must both stay: the wait rescues a job whose network
# has not woken yet, the lease releases the lock when a job never wakes at all.
WRAPPED_LEASE_MIN = 5
HEARTBEAT_SECONDS = float(os.environ.get("JOB_QUEUE_HEARTBEAT", "60"))
POLL_SECONDS = float(os.environ.get("JOB_QUEUE_POLL", "2"))


# --------------------------------------------------------------------------
# state
# --------------------------------------------------------------------------

def ensure_dirs():
    os.makedirs(TICKET_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(EVENTS), exist_ok=True)


def now():
    return time.time()


def iso(ts=None):
    """Second resolution, to match job-status.jsonl so the digest can read both."""
    return datetime.utcfromtimestamp(ts if ts is not None else now()).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def iso_ms(ts=None):
    """Millisecond resolution for the queue log itself. Five jobs racing inside
    one second is the normal case here, and second-resolution timestamps made
    the ordering impossible to read back."""
    return datetime.utcfromtimestamp(ts if ts is not None else now()).strftime(
        "%Y-%m-%dT%H:%M:%S.%f"
    )[:-3] + "Z"


def event(job, state, **extra):
    """Append one line to the queue log. This file is the control: the digest
    treats an empty 26 hours as a failure, not as a quiet success."""
    ensure_dirs()
    rec = {"ts": iso_ms(), "job": job, "state": state}
    rec.update(extra)
    with open(EVENTS, "a") as f:
        f.write(json.dumps(rec) + "\n")
    return rec


def load_schedule():
    try:
        with open(SCHEDULE_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as e:
        # A broken config must not silently disable the staleness guard.
        print("ERROR: job-schedule.json is not valid JSON: %s" % e, file=sys.stderr)
        return {}


# --------------------------------------------------------------------------
# cron
# --------------------------------------------------------------------------

def _expand(field, lo, hi):
    """Expand one cron field into a set of ints. Supports * , - and */n."""
    out = set()
    for part in field.split(","):
        part = part.strip()
        step = 1
        if "/" in part:
            part, raw_step = part.split("/", 1)
            step = int(raw_step)
        if part in ("*", ""):
            start, end = lo, hi
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = end = int(part)
        out.update(range(start, end + 1, step))
    return {v for v in out if lo <= v <= hi}


def cron_matches(expr, dt):
    """Standard five-field cron, evaluated in LOCAL time.

    Day-of-week is the field that bites. Standard cron counts Sunday as 0 (and
    accepts 7 for Sunday too). Python's weekday() counts Monday as 0. This
    codebase has already lost a week of Friday CEO briefs to a scheduler that
    started the week on Sunday=1, so the mapping is written out explicitly and
    covered by its own test rather than inferred.
    """
    minute, hour, dom, month, dow = expr.split()

    if dt.minute not in _expand(minute, 0, 59):
        return False
    if dt.hour not in _expand(hour, 0, 23):
        return False
    if dt.month not in _expand(month, 1, 12):
        return False

    dow_set = _expand(dow, 0, 7)
    if 7 in dow_set:
        dow_set.add(0)
    cron_dow = (dt.weekday() + 1) % 7  # Mon=0..Sun=6  ->  Sun=0..Sat=6

    dom_restricted = dom.strip() != "*"
    dow_restricted = dow.strip() != "*"
    dom_hit = dt.day in _expand(dom, 1, 31)
    dow_hit = cron_dow in dow_set

    # Cron's documented oddity: when BOTH day fields are restricted they OR
    # together rather than AND.
    if dom_restricted and dow_restricted:
        return dom_hit or dow_hit
    if dom_restricted:
        return dom_hit
    if dow_restricted:
        return dow_hit
    return True


def day_matches(expr, dt):
    """Does the DATE part of this cron match, ignoring hour and minute?"""
    _, _, dom, month, dow = expr.split()
    if dt.month not in _expand(month, 1, 12):
        return False

    dow_set = _expand(dow, 0, 7)
    if 7 in dow_set:
        dow_set.add(0)
    cron_dow = (dt.weekday() + 1) % 7  # Mon=0..Sun=6  ->  Sun=0..Sat=6

    dom_restricted = dom.strip() != "*"
    dow_restricted = dow.strip() != "*"
    dom_hit = dt.day in _expand(dom, 1, 31)
    dow_hit = cron_dow in dow_set

    if dom_restricted and dow_restricted:
        return dom_hit or dow_hit
    if dom_restricted:
        return dom_hit
    if dow_restricted:
        return dow_hit
    return True


def last_scheduled(expr, ref=None, lookback_days=400):
    """Most recent moment this cron should have fired, at or before ref.

    Walks whole days and only then the matching hours and minutes. The obvious
    version steps back one minute at a time, which needs a lookback measured in
    minutes; at the 96 hours that was practical it returned None for anything
    rarer than every four days. That made the staleness guard silently inert for
    the monthly rent job and the quarterly review, and hid both from the morning
    digest, which only watches jobs it can date. 400 days covers monthly,
    quarterly and annual crons in at most 400 cheap iterations.
    """
    ref = (ref or datetime.now()).replace(second=0, microsecond=0)
    minutes = sorted(_expand(expr.split()[0], 0, 59), reverse=True)
    hours = sorted(_expand(expr.split()[1], 0, 23), reverse=True)
    if not minutes or not hours:
        return None

    day = ref
    for _ in range(lookback_days + 1):
        if day_matches(expr, day):
            for h in hours:
                for m in minutes:
                    candidate = day.replace(hour=h, minute=m)
                    if candidate <= ref:
                        return candidate
        day = (day - timedelta(days=1)).replace(hour=23, minute=59)
    return None


def staleness(job, schedule, ref=None):
    """(is_stale, minutes_late, reason). Unknown jobs are never skipped: a job
    missing from the config is a config bug, and silently dropping it would
    reproduce exactly the disappearing-evidence problem this replaces."""
    cfg = schedule.get(job)
    if not cfg or not cfg.get("cron"):
        return False, None, "no schedule configured"
    max_late = cfg.get("maxLateMinutes")
    if max_late is None:
        return False, None, "no maxLateMinutes configured"
    due = last_scheduled(cfg["cron"], ref=ref)
    if due is None:
        return False, None, "no occurrence found in lookback"
    late = ((ref or datetime.now()) - due).total_seconds() / 60.0
    if late > max_late:
        return True, round(late, 1), "due %s, %.0f min late, limit %s" % (
            due.strftime("%Y-%m-%d %H:%M"), late, max_late)
    return False, round(late, 1), "on time"


# --------------------------------------------------------------------------
# preconditions — is this Mac actually ready to run the job?
# --------------------------------------------------------------------------

def network_ready(host="api.airtable.com", port=443, timeout=4):
    """Can we resolve AND reach the internet right now?

    Resolution alone is not enough: a Mac that has just woken often answers DNS
    from cache while the interface is still coming up. So we open a socket.
    """
    import socket
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError:
        return False, "DNS cannot resolve %s" % host
    for family, socktype, proto, _, addr in infos:
        s = socket.socket(family, socktype, proto)
        s.settimeout(timeout)
        try:
            s.connect(addr)
            return True, "reachable"
        except OSError:
            continue
        finally:
            s.close()
    return False, "cannot reach %s:%s" % (host, port)


def drive_ready(path, timeout=4):
    """Is this Google Drive folder actually readable?

    The brain vault lives under ~/Library/CloudStorage. When Drive has not
    reconnected the folder still EXISTS and still LISTS, and only fails when you
    open a file inside it, with `OSError: [Errno 11] Resource deadlock avoided`.
    That is what took out publish-brain and compound-brain, and it is why this
    probe reads a byte rather than just stat-ing the directory.

    EPERM is deliberately NOT treated as "not ready". A process without the macOS
    privacy grant for CloudStorage gets Operation not permitted no matter how
    long it waits, so deferring on it would convert a loud daily failure into a
    job that silently never runs again. Waiting is only correct for conditions
    that actually pass with time.
    """
    if not os.path.isdir(path):
        return False, "%s does not exist" % path
    try:
        names = [n for n in os.listdir(path) if not n.startswith(".")]
    except PermissionError as e:
        return True, "cannot probe (%s); letting the job run and report for itself" % e
    except OSError as e:
        if e.errno == errno.EPERM:
            return True, "cannot probe (%s); letting the job run" % e
        return False, "cannot list: %s" % e
    if not names:
        return False, "folder is empty, Drive has not populated it"
    for name in names[:25]:
        full = os.path.join(path, name)
        if not os.path.isfile(full):
            continue
        try:
            with open(full, "rb") as f:
                f.read(1)
            return True, "readable"
        except PermissionError as e:
            return True, "cannot probe (%s); letting the job run" % e
        except OSError as e:
            if e.errno == errno.EPERM:
                return True, "cannot probe (%s); letting the job run" % e
            # EDEADLK (errno 11) lands here: Drive is mounted but not serving.
            return False, "cannot read %s: %s" % (name, e)
    return True, "folder lists, no plain file to probe"


def preconditions_met(cfg):
    """(ok, reason). Declared per job as `needs` in job-schedule.json."""
    for need in cfg.get("needs", []) or []:
        if need == "network":
            ok, why = network_ready()
            if not ok:
                return False, "network: %s" % why
        elif isinstance(need, dict) and need.get("drive"):
            ok, why = drive_ready(os.path.expanduser(need["drive"]))
            if not ok:
                return False, "google drive: %s" % why
        else:
            return False, "unknown precondition %r" % (need,)
    return True, "ready"


def wait_for_preconditions(job, cfg, wait_minutes, quiet=False):
    """Wait, briefly, for the machine to be ready.

    Five of the seven jobs that had been failing daily were not broken at all.
    They fired the moment the Mac woke, before the network and Google Drive were
    up, and reported a hard failure. Waiting a few minutes fixes them; failing
    after the wait is a real problem worth shouting about.
    """
    needs = cfg.get("needs") or []
    if not needs:
        return True
    started = now()
    deadline = started + wait_minutes * 60
    first = True
    backoff = READY_POLL_START
    while True:
        ok, why = preconditions_met(cfg)
        if ok:
            if not first:
                event(job, "ready", note=why,
                      waited_seconds=round(now() - started, 1))
            return True
        if now() >= deadline:
            event(job, "deferred-not-ready", reason=why,
                  waited_minutes=round((now() - started) / 60.0, 1))
            if not quiet:
                print("NOT READY %s: %s (waited %s min)" %
                      (job, why, round((now() - started) / 60.0, 1)))
            return False
        if first:
            event(job, "waiting-for-ready", reason=why,
                  will_wait_minutes=round(wait_minutes, 1))
            if not quiet:
                print("WAITING %s: %s (up to %s min)" % (job, why, wait_minutes))
            first = False
        time.sleep(max(min(backoff, deadline - now()), POLL_SECONDS))
        backoff = min(backoff * 2, READY_POLL_MAX)


# --------------------------------------------------------------------------
# lock
# --------------------------------------------------------------------------

def pid_alive(pid):
    try:
        os.kill(pid, 0)
    except OSError as e:
        return e.errno == errno.EPERM
    return True


def drop_lock():
    """Remove the lock without ever leaving it visible and ownerless.

    A plain rmtree unlinks holder.json first and the directory second, so for a
    moment the lock exists with no owner — the same half-made state that
    try_take_lock goes to such lengths to avoid. Rename it out of the way first,
    then delete at leisure.
    """
    if not os.path.isdir(LOCK_DIR):
        return
    staging = os.path.join(STATE_DIR, ".dropped-%d-%f" % (os.getpid(), now()))
    try:
        os.rename(LOCK_DIR, staging)
    except OSError:
        shutil.rmtree(LOCK_DIR, ignore_errors=True)
        return
    shutil.rmtree(staging, ignore_errors=True)


def read_holder():
    try:
        with open(HOLDER_FILE) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def break_stale_lock():
    """Release a lock whose owner cannot still be working.

    A crashed routine must never block tomorrow, so every lock carries a
    deadline. For a wrapped job we can also prove death directly; for a
    cooperative one the lease is all we have, because the shell that took the
    lock exited seconds later by design.
    """
    if not os.path.isdir(LOCK_DIR):
        return None
    holder = read_holder()
    if holder is None:
        # try_take_lock builds the lock complete and renames it into place, so a
        # lock without a readable holder should be impossible. If one appears it
        # is debris from an older version or a corrupted disk write. Clear it,
        # but say so loudly rather than silently, and age-gate it so a lock that
        # is genuinely mid-rename is never stolen.
        try:
            age = now() - os.path.getmtime(LOCK_DIR)
        except OSError:
            return None
        if age > 30:
            event("unknown", "lock-broken", reason="holder file unreadable",
                  age_seconds=round(age))
            drop_lock()
            return "unreadable holder"
        return None

    reason = None
    if now() > holder.get("lease_until", 0):
        reason = "lease expired"
    elif holder.get("mode") == "wrapped" and not pid_alive(holder.get("pid", -1)):
        reason = "holder pid %s is gone" % holder.get("pid")

    if reason:
        event(holder.get("job", "unknown"), "lock-broken", reason=reason,
              held_seconds=round(now() - holder.get("acquired_at", now())))
        drop_lock()
    return reason


def try_take_lock(job, mode, lease_minutes):
    """Build the lock complete, then move it into place in one atomic step.

    The obvious version — mkdir, then write holder.json — leaves a window where
    the lock exists but looks unowned. Every other waiter reads "held by nobody",
    and the debris rule that clears an ownerless lock then either blocks the
    queue or, worse, deletes a lock that was a millisecond old. Renaming a fully
    built directory onto a free name is atomic, so the lock is never seen
    half-made.
    """
    staging = os.path.join(STATE_DIR, ".lock-%d-%f" % (os.getpid(), now()))
    try:
        os.mkdir(staging)
        holder = {
            "job": job,
            "pid": os.getpid(),
            "mode": mode,
            "acquired_at": now(),
            "acquired_iso": iso(),
            "lease_until": now() + lease_minutes * 60,
        }
        with open(os.path.join(staging, "holder.json"), "w") as f:
            json.dump(holder, f)
            f.flush()
            os.fsync(f.fileno())
        try:
            # Fails with ENOTEMPTY / EEXIST when the lock is already held.
            os.rename(staging, LOCK_DIR)
        except OSError:
            shutil.rmtree(staging, ignore_errors=True)
            return False
        return True
    except OSError:
        shutil.rmtree(staging, ignore_errors=True)
        return False


def prune_dead_tickets():
    """A waiter that died must not hold up the head of the queue."""
    for name in os.listdir(TICKET_DIR):
        path = os.path.join(TICKET_DIR, name)
        try:
            with open(path) as f:
                t = json.load(f)
        except (OSError, json.JSONDecodeError):
            try:
                if now() - os.path.getmtime(path) > 300:
                    os.unlink(path)
            except OSError:
                pass
            continue
        if not pid_alive(t.get("pid", -1)):
            try:
                os.unlink(path)
            except OSError:
                pass


def acquire(job, mode="cooperative", lease_minutes=DEFAULT_LEASE_MIN,
            timeout_minutes=DEFAULT_TIMEOUT_MIN, check_stale=True, quiet=False,
            ready_wait_minutes=None):
    ensure_dirs()
    schedule = load_schedule()
    cfg = schedule.get(job) or {}

    if check_stale:
        stale, late, reason = staleness(job, schedule)
        if stale:
            event(job, "skipped-stale", minutes_late=late, reason=reason)
            if not quiet:
                print("SKIPPED %s: %s" % (job, reason))
            return EX_SKIPPED

    # Deliberately BEFORE the lock: a job waiting for the network must not hold
    # the queue shut while it waits.
    if ready_wait_minutes is None:
        ready_wait_minutes = cfg.get("readyWaitMinutes", DEFAULT_READY_WAIT_MIN)
    if not wait_for_preconditions(job, cfg, ready_wait_minutes, quiet=quiet):
        return EX_NOTREADY

    # Fixed-width timestamp so plain lexical sort is true arrival order.
    ticket_name = "%017.6f-%d" % (now(), os.getpid())
    ticket_path = os.path.join(TICKET_DIR, ticket_name)
    with open(ticket_path, "w") as f:
        json.dump({"job": job, "pid": os.getpid(), "at": iso()}, f)

    started = now()
    deadline = started + timeout_minutes * 60
    announced = False
    try:
        while True:
            break_stale_lock()
            prune_dead_tickets()
            waiting = sorted(os.listdir(TICKET_DIR))
            first = waiting[0] if waiting else ticket_name

            if first == ticket_name and try_take_lock(job, mode, lease_minutes):
                waited = round(now() - started, 1)
                event(job, "acquired", mode=mode, waited_seconds=waited,
                      queue_depth=len(waiting) - 1, lease_minutes=lease_minutes)
                if not quiet:
                    print("ACQUIRED %s (waited %ss, %d behind)" %
                          (job, waited, len(waiting) - 1))
                return EX_OK

            if not announced:
                holder = read_holder() or {}
                # `head` records which ticket is ahead of this one. Without it a
                # waiter that is simply not first is indistinguishable in the log
                # from one blocked by a lock, which cost real time to diagnose.
                event(job, "queued", behind=holder.get("job"), head=first,
                      mine=ticket_name, queue_depth=max(len(waiting) - 1, 0))
                if not quiet:
                    print("QUEUED %s behind %s" % (job, holder.get("job", "?")))
                announced = True

            if now() >= deadline:
                holder = read_holder() or {}
                event(job, "queue-timeout", waited_seconds=round(now() - started),
                      behind=holder.get("job"))
                if not quiet:
                    print("BUSY %s: gave up after %s min behind %s" %
                          (job, timeout_minutes, holder.get("job", "?")))
                return EX_BUSY

            time.sleep(POLL_SECONDS)
    finally:
        try:
            os.unlink(ticket_path)
        except OSError:
            pass


# Taking the lock is not the same as doing the work.
#
# On 8 Aug 2026 task-hygiene-sweep acquired the lock, found the Tasks schema had
# drifted, halted before touching anything (correctly), wrote a report saying "Did
# not run", and released. The morning digest counted it under "Worked", because
# `acquired` was the only signal it had. That was the fourth consecutive day the
# sweep did no work and nobody knew.
#
# So release carries an outcome. Absent means "completed", which keeps every
# existing caller honest by default; a routine that bailed says so.
OUTCOMES = ("completed", "halted", "partial")


def release(job, quiet=False, outcome="completed", reason=None):
    holder = read_holder()
    if holder is None:
        if os.path.isdir(LOCK_DIR):
            drop_lock()
            event(job, "released", note="no holder file", outcome=outcome)
            return EX_OK
        event(job, "release-noop", note="lock was not held")
        if not quiet:
            print("NOTE %s: lock was not held" % job)
        return EX_OK

    if holder.get("job") != job:
        # Releasing another job's lock is how one routine frees another's work
        # to be trampled. Refuse, and leave the lease to do its job.
        event(job, "release-refused", holder=holder.get("job"))
        print("REFUSED: %s does not hold the lock (%s does)" %
              (job, holder.get("job")), file=sys.stderr)
        return EX_USAGE

    held = round(now() - holder.get("acquired_at", now()), 1)
    drop_lock()
    extra = {"outcome": outcome}
    if reason:
        extra["reason"] = reason
    event(job, "released", held_seconds=held, **extra)
    if not quiet:
        print("RELEASED %s (held %ss, %s)" % (job, held, outcome))
    return EX_OK


def holds(job):
    """Do we still hold the lock? Returns (True, "") or (False, reason).

    The lease was advisory: nothing ever ASKED whether the lock was still ours.
    A job whose lease lapsed while the Mac slept, or whose lock was broken by a
    contender, carried on writing with no idea it had been replaced.
    """
    holder = read_holder()
    if holder is None:
        return False, "lock is not held by anyone"
    if holder.get("job") != job:
        return False, "lock is held by %s" % holder.get("job")
    if now() > holder.get("lease_until", 0):
        return False, "lease expired %.1f min ago" % (
            (now() - holder.get("lease_until", now())) / 60)
    return True, ""


def assert_held(job, quiet=False):
    """Fail loudly when a long-running step no longer holds the lock.

    Call this between phases. A lost lease must END the phase, not be noted in
    passing: the queue has already given the machine to somebody else.
    """
    ok, why = holds(job)
    if ok:
        if not quiet:
            print("OK %s: still holds the lock" % job)
        return EX_OK
    event(job, "lease-lost", reason=why)
    print("LOST LOCK: %s no longer holds the queue (%s). Stop this phase."
          % (job, why), file=sys.stderr)
    return EX_LOSTLOCK


def heartbeat(job, lease_minutes=DEFAULT_LEASE_MIN):
    holder = read_holder()
    if holder is None or holder.get("job") != job:
        # Not a usage error. Somebody else has the machine, and the caller is
        # mid-run believing otherwise, so give it the distinct code it must act on.
        event(job, "lease-lost", reason=(
            "lock is not held by anyone" if holder is None
            else "lock is held by %s" % holder.get("job")))
        print("LOST LOCK: %s no longer holds the queue. Stop this phase." % job,
              file=sys.stderr)
        return EX_LOSTLOCK
    holder["lease_until"] = now() + lease_minutes * 60
    with open(HOLDER_FILE, "w") as f:
        json.dump(holder, f)
    event(job, "heartbeat", lease_minutes=lease_minutes)
    return EX_OK


def run(job, cmd, lease_minutes, timeout_minutes, check_stale,
        ready_wait_minutes=None):
    """Wrapped mode: take the lock, run the command, always release.

    The lease is short and kept alive by a heartbeat thread, because the real
    enemy here is the Mac going to sleep. A suspended process is still ALIVE, so
    `kill -0` says it is fine and the lock stays held for the whole lease. On
    8 Aug 2026 drift-monitor held it for 4 hours 54 minutes while asleep and
    everything behind it was skipped for lateness.

    A heartbeat cannot be faked by a sleeping process: the thread is suspended
    too, the lease lapses within a couple of minutes, and the queue moves on.
    Long-running jobs stay safe because a job that is genuinely running keeps
    beating.
    """
    if lease_minutes == DEFAULT_LEASE_MIN:
        lease_minutes = WRAPPED_LEASE_MIN
    code = acquire(job, mode="wrapped", lease_minutes=lease_minutes,
                   timeout_minutes=timeout_minutes, check_stale=check_stale,
                   ready_wait_minutes=ready_wait_minutes)
    if code != EX_OK:
        return code

    def _passthrough(signum, _frame):
        release(job, quiet=True)
        sys.exit(128 + signum)

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, _passthrough)
        except (ValueError, OSError):
            pass

    import threading
    stop = threading.Event()
    running = {"proc": None, "lost": ""}

    def beat():
        # Re-arm well inside the lease so an ordinary scheduling hiccup does not
        # drop the lock, but a genuine suspend does.
        while not stop.wait(HEARTBEAT_SECONDS):
            holder = read_holder()
            if not holder or holder.get("job") != job:
                # Losing the lock used to be advisory: the thread returned and
                # the job carried on writing, alongside whoever now holds the
                # queue. Two writers is the collision this whole file exists to
                # prevent, so a lost lock now KILLS the run.
                running["lost"] = ("lock is not held by anyone" if not holder
                                   else "lock is held by %s" % holder.get("job"))
                event(job, "lease-lost", reason=running["lost"])
                proc = running["proc"]
                if proc is not None:
                    try:
                        proc.kill()
                    except OSError:
                        pass
                return
            holder["lease_until"] = now() + WRAPPED_LEASE_MIN * 60
            try:
                with open(HOLDER_FILE, "w") as f:
                    json.dump(holder, f)
            except OSError:
                return

    ticker = threading.Thread(target=beat, daemon=True)
    ticker.start()
    try:
        proc = subprocess.Popen(cmd)
        running["proc"] = proc
        code = proc.wait()
        if running["lost"]:
            print("LOST LOCK: %s was stopped mid-run (%s)"
                  % (job, running["lost"]), file=sys.stderr)
            event(job, "finished", exit=EX_LOSTLOCK, reason=running["lost"])
            return EX_LOSTLOCK
        event(job, "finished", exit=code)
        return code
    finally:
        stop.set()
        if not running["lost"]:
            release(job, quiet=True)


def status():
    ensure_dirs()
    break_stale_lock()
    holder = read_holder()
    waiting = sorted(os.listdir(TICKET_DIR))
    if holder:
        print("HELD by %s (%s, since %s, lease %.0f min left)" % (
            holder.get("job"), holder.get("mode"), holder.get("acquired_iso"),
            (holder.get("lease_until", now()) - now()) / 60))
    else:
        print("FREE")
    print("Waiting: %d" % len(waiting))
    for name in waiting:
        try:
            with open(os.path.join(TICKET_DIR, name)) as f:
                print("  %s" % json.load(f).get("job"))
        except (OSError, json.JSONDecodeError):
            print("  (unreadable ticket %s)" % name)
    return EX_OK


def main(argv=None):
    p = argparse.ArgumentParser(description="Serialise scheduled jobs.")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("job")
        sp.add_argument("--lease", type=float, default=DEFAULT_LEASE_MIN,
                        help="minutes before the lock frees itself")
        sp.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_MIN,
                        help="minutes to wait for the queue before giving up")
        sp.add_argument("--no-stale-check", action="store_true")
        sp.add_argument("--ready-wait", type=float, default=None,
                        help="minutes to wait for network/Drive before deferring")
        sp.add_argument("--quiet", action="store_true")

    common(sub.add_parser("acquire"))
    sp = sub.add_parser("run")
    common(sp)
    # NOT argparse.REMAINDER. It silently swallowed the whole command when it
    # followed an optional flag, so `run <job> --no-stale-check -- cmd...`
    # parsed to an empty command and every wrapped job exited 64 without ever
    # running. Splitting on `--` before argparse sees it is unambiguous.
    sp.add_argument("cmd_args", nargs="*")

    sp = sub.add_parser("release")
    sp.add_argument("job")
    sp.add_argument("--quiet", action="store_true")
    sp.add_argument("--outcome", choices=OUTCOMES, default="completed",
                    help="did the job actually do its work? halted/partial keep it "
                         "out of the digest's 'Worked' list")
    sp.add_argument("--reason", help="one line, required in spirit when not completed")

    sp = sub.add_parser("heartbeat")
    sp.add_argument("job")
    sp.add_argument("--lease", type=float, default=DEFAULT_LEASE_MIN)

    # Long phases call this between steps. Exit 70 means the lock is gone and
    # the phase must stop; 0 means carry on.
    sp = sub.add_parser("assert-held")
    sp.add_argument("job")
    sp.add_argument("--quiet", action="store_true")

    sub.add_parser("status")

    sp = sub.add_parser("ready")
    sp.add_argument("job")

    sp = sub.add_parser("due")
    sp.add_argument("job")

    # For a job that must leave PROOF IT RAN without taking the lock. daily-ops
    # is the case: it holds the machine for an hour or two, so taking the lock
    # would block every short shell job behind it — but check-routines.py needs
    # evidence it ran, and "no evidence" is indistinguishable from "never
    # started". Writes one event, touches no lock state.
    sp = sub.add_parser("mark")
    sp.add_argument("job")
    sp.add_argument("--note", default="")

    argv = list(sys.argv[1:] if argv is None else argv)
    trailing = []
    if "--" in argv:
        cut = argv.index("--")
        argv, trailing = argv[:cut], argv[cut + 1:]

    a = p.parse_args(argv)

    if a.cmd == "acquire":
        return acquire(a.job, mode="cooperative", lease_minutes=a.lease,
                       timeout_minutes=a.timeout,
                       check_stale=not a.no_stale_check, quiet=a.quiet,
                       ready_wait_minutes=a.ready_wait)
    if a.cmd == "run":
        cmd = a.cmd_args + trailing
        if not cmd:
            print("ERROR: no command given for job %s" % a.job, file=sys.stderr)
            return EX_USAGE
        return run(a.job, cmd, a.lease, a.timeout, not a.no_stale_check,
                   ready_wait_minutes=a.ready_wait)
    if a.cmd == "release":
        return release(a.job, quiet=a.quiet, outcome=a.outcome, reason=a.reason)
    if a.cmd == "heartbeat":
        return heartbeat(a.job, a.lease)
    if a.cmd == "assert-held":
        return assert_held(a.job, quiet=a.quiet)
    if a.cmd == "status":
        return status()
    if a.cmd == "ready":
        cfg = load_schedule().get(a.job) or {}
        ok, why = preconditions_met(cfg)
        print("%s: %s (%s)" % (a.job, "ready" if ok else "NOT READY", why))
        return EX_OK if ok else EX_NOTREADY
    if a.cmd == "due":
        stale, late, reason = staleness(a.job, load_schedule())
        print("%s: %s (%s)" % (a.job, "STALE" if stale else "fresh", reason))
        return EX_SKIPPED if stale else EX_OK
    if a.cmd == "mark":
        rec = event(a.job, "mark", note=a.note)
        print("%s: marked as running at %s" % (a.job, rec["ts"]))
        return EX_OK
    return EX_USAGE


if __name__ == "__main__":
    sys.exit(main())
