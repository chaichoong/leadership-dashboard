#!/usr/bin/env python3
"""The Claude allowance guard (Kevin, 14 Sep 2026).

WHY
---
From 13:00 on Friday 11 Sep 2026 to 19:00 on Sunday 13 Sep the weekly Claude
allowance was out. Every headless run printed "You've hit your limit · resets
Sep 13 at 7pm (Europe/London)" and exited within seconds: nine triage slots,
nine board passes, 106 of 128 hand-back polls. Each of those runs still paid
the start-up cost, each slot was simply lost, and when the allowance came back
nothing re-ran the work that had been missed; the first real run was the next
scheduled slot, twelve hours later.

WHAT
----
One small state file, ~/knowledge-os/logs/allowance.json, and three commands
the runners call around every headless `claude -p`:

  mark   --job J --log PATH   after a run: if the log carries the limit line,
                              read the reset time from it and pause the estate
                              until then (the LATEST reset seen wins).
  check  --job J              before a run: exit 3 while paused (the runner
                              skips the Claude call and the slot is recorded
                              as missed); exit 0 otherwise.
  replay [--dry-run]          once the reset time has passed: start each missed
                              job once through launchd (kickstart), in the
                              order they were missed, then clear the pause.
                              Called by estate-status.py every ten minutes.
  status                      the state, for the Estate status board.

The pause is deterministic and cheap: a paused tick costs one file read. The
board shows it as an "allowance" report row, so Kevin sees "out until 19:00,
four runs will re-run at reset" instead of a column of red.

Usage: allowance.py {mark|check|replay|status|selftest} ...
"""
import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("ALLOWANCE_STATE") or os.path.expanduser("~/knowledge-os/logs/allowance.json")
SCHEDULE = os.path.join(HERE, "job-schedule.json")
LAUNCHD_PREFIX = "com.kevinbrittain."
LONDON = ZoneInfo("Europe/London")

LIMIT_RE = re.compile(r"You['’]ve hit your limit", re.I)
# "resets Sep 13 at 7pm (Europe/London)" · "resets 7pm (Europe/London)" · "resets 6:40pm"
RESET_RE = re.compile(
    r"resets\s+(?:(?P<mon>[A-Z][a-z]{2})\s+(?P<day>\d{1,2})\s+at\s+)?"
    r"(?P<hour>\d{1,2})(?::(?P<minute>\d{2}))?\s*(?P<ampm>am|pm)?"
    r"(?:\s*\((?P<tz>[A-Za-z_/]+)\))?", re.I)
MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
# Jobs that never need a replay: one runs every half hour anyway, the other is
# the board that calls replay in the first place.
NO_REPLAY = {"handback-poll", "estate-status", "retry-deferred", "mac-guard"}


def load_state():
    try:
        with open(STATE) as fh:
            d = json.load(fh)
            return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(d):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(d, fh, indent=1)
    os.replace(tmp, STATE)   # never truncate-then-write a file another tick may read


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def parse_reset(text, now):
    """The reset instant named by a limit message, or None. Times are London
    unless the message names another zone. A bare time already past today
    means tomorrow (the message is written before the reset, never after)."""
    m = RESET_RE.search(text or "")
    if not m:
        return None
    tz = LONDON
    if m.group("tz"):
        try:
            tz = ZoneInfo(m.group("tz"))
        except Exception:  # noqa: BLE001 — an unknown zone name falls back to London
            tz = LONDON
    hour = int(m.group("hour")); minute = int(m.group("minute") or 0)
    ampm = (m.group("ampm") or "").lower()
    if ampm == "pm" and hour < 12:
        hour += 12
    if ampm == "am" and hour == 12:
        hour = 0
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None   # "resets 30 min", "resets 25 Sep": not a clock time; the caller pauses an hour
    local_now = now.astimezone(tz)
    if m.group("mon") and m.group("day"):
        mon = MONTHS.get(m.group("mon").lower())
        if not mon:
            return None
        year = local_now.year
        cand = local_now.replace(year=year, month=mon, day=int(m.group("day")), hour=hour, minute=minute, second=0, microsecond=0)
        if cand < local_now - timedelta(days=180):   # a December message read in January
            cand = cand.replace(year=year + 1)
    else:
        cand = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if cand <= local_now:
            cand += timedelta(days=1)
    return cand.astimezone(timezone.utc)


def find_limit(text, now):
    """(matched, reset_or_None): whether the text carries the limit line, and the reset it names."""
    if not text or not LIMIT_RE.search(text):
        return False, None
    # the reset phrase sits on the same line as the limit phrase; read that line first
    # The reset is read from the SAME line as the limit phrase, never from the
    # rest of the log: an agent quoting "the counter resets 5 times" must not
    # set the pause. No reset on the line means the one-hour pause.
    for line in text.splitlines():
        if LIMIT_RE.search(line):
            try:
                r = parse_reset(line, now)
            except ValueError:
                r = None
            if r:
                return True, r
    return True, None


def log_tail(path, since_line=0, limit_bytes=200000):
    """Only THIS run's lines: everything after since_line (the line count the
    runner took before it started), capped at limit_bytes from the end. The
    first version applied the line offset only while the whole file fitted the
    cap, so a 200KB runs.log re-marked the pause from last week's limit lines
    on every clean run (review, 14 Sep 2026)."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return ""
    lines = raw.split(b"\n")
    text = b"\n".join(lines[since_line:]) if since_line else raw
    return text[-limit_bytes:].decode("utf-8", "replace")


def live_jobs():
    try:
        with open(SCHEDULE) as fh:
            d = json.load(fh)
    except (OSError, ValueError):
        return set()
    return {k for k, v in d.items() if isinstance(v, dict) and v.get("cron")
            and not any(w in str(v.get("note") or "") for w in ("RETIRED", "ABSORBED"))}


# ─── commands ─────────────────────────────────────────────────────────
def cmd_mark(job, log, since_line=0, now=None, text=None):
    now = now or datetime.now(timezone.utc)
    text = text if text is not None else log_tail(log, since_line)
    hit, reset = find_limit(text, now)
    if not hit:
        return {"marked": False, "reason": "no limit line in the log"}
    if reset is None:
        reset = now + timedelta(hours=1)   # the line names no time: pause an hour and look again
        note = "limit line carried no reset time; paused one hour"
    else:
        note = "reset read from the run log"
    st = load_state()
    prev = parse_iso(st.get("paused_until"))
    if prev and prev > reset:
        reset = prev   # the latest reset seen wins
    st.update({"paused_until": iso(reset), "seen_at": iso(now), "job": job, "note": note})
    st.setdefault("missed", [])
    if job and job not in NO_REPLAY and not any(m.get("job") == job and m.get("at", "")[:13] == iso(now)[:13] for m in st["missed"]):
        st["missed"].append({"job": job, "at": iso(now), "how": "died on the limit"})
    save_state(st)
    return {"marked": True, "paused_until": st["paused_until"], "job": job, "note": note}


def cmd_check(job, now=None):
    now = now or datetime.now(timezone.utc)
    st = load_state()
    until = parse_iso(st.get("paused_until"))
    if not until or now >= until:
        return {"paused": False}, 0
    if job and job not in NO_REPLAY:
        st.setdefault("missed", [])
        if not any(m.get("job") == job and m.get("at", "")[:16] == iso(now)[:16] for m in st["missed"]):
            st["missed"].append({"job": job, "at": iso(now), "how": "skipped while paused"})
            save_state(st)
    return {"paused": True, "paused_until": st["paused_until"],
            "reason": "The Claude allowance is out until %s London. This run did not start; it is queued to re-run at reset."
                      % until.astimezone(LONDON).strftime("%a %H:%M")}, 3


def kickstart(job):
    label = "gui/%d/%s%s" % (os.getuid(), LAUNCHD_PREFIX, job)
    plist = os.path.expanduser("~/Library/LaunchAgents/%s%s.plist" % (LAUNCHD_PREFIX, job))
    if not os.path.exists(plist):
        return "no plist"
    r = subprocess.run(["launchctl", "kickstart", label], capture_output=True, text=True, timeout=30)
    return "started" if r.returncode == 0 else ("launchctl: " + (r.stderr or r.stdout).strip()[:120])


def cmd_replay(dry_run=False, now=None, starter=kickstart, jobs=None):
    now = now or datetime.now(timezone.utc)
    st = load_state()
    until = parse_iso(st.get("paused_until"))
    if not until:
        return {"replayed": [], "reason": "not paused"}
    if now < until:
        return {"replayed": [], "reason": "still paused until %s" % st["paused_until"]}
    live = jobs if jobs is not None else live_jobs()
    order, seen = [], set()
    for m in st.get("missed", []):
        j = m.get("job")
        if j and j in live and j not in NO_REPLAY and j not in seen:
            seen.add(j); order.append(j)
    results = []
    for j in order:
        results.append({"job": j, "result": "dry run" if dry_run else starter(j)})
    if not dry_run:
        st["last_outage"] = {"paused_until": st["paused_until"], "seen_at": st.get("seen_at"), "missed": st.get("missed", []),
                             "replayed": results, "replayed_at": iso(now)}
        for k in ("paused_until", "seen_at", "job", "note", "missed"):
            st.pop(k, None)
        save_state(st)
    return {"replayed": results, "reason": "reset passed at %s" % iso(until)}


def run_guarded(job, cmd, **kw):
    """subprocess.run for a headless `claude -p` inside a Python step (the Content
    Engine's copy and thumbnail steps): refuse to start while the allowance is
    out (SystemExit with the plain reason, so the step is skipped and the run
    log says why), and mark the pause from the call's own output afterwards.
    Output is captured so the limit line can be read; callers that need it get
    it back on the returned CompletedProcess as before."""
    out, rc = cmd_check(job)
    if rc == 3:
        raise SystemExit("PAUSED: " + out["reason"])
    kw.setdefault("capture_output", True); kw.setdefault("text", True)
    r = subprocess.run(cmd, **kw)
    try:
        cmd_mark(job, None, text=(r.stdout or "") + "\n" + (r.stderr or ""))
    except Exception:  # noqa: BLE001 — the guard must never turn a good render into a failure
        pass
    return r


def cmd_status(now=None):
    now = now or datetime.now(timezone.utc)
    st = load_state()
    until = parse_iso(st.get("paused_until"))
    paused = bool(until and now < until)
    return {"paused": paused, "paused_until": st.get("paused_until"), "seen_at": st.get("seen_at"),
            "missed": st.get("missed", []), "last_outage": st.get("last_outage")}


# ─── selftest ─────────────────────────────────────────────────────────
def selftest():
    import tempfile
    global STATE
    STATE = os.path.join(tempfile.mkdtemp(), "allowance.json")
    checks = 0
    def ok(c, what):
        nonlocal checks
        checks += 1
        if not c:
            raise AssertionError(what)
    now = datetime(2026, 9, 12, 8, 0, tzinfo=timezone.utc)   # Sat 09:00 London
    # 1. the three message shapes seen in the logs
    r = parse_reset("You've hit your limit · resets Sep 13 at 7pm (Europe/London)", now)
    ok(iso(r) == "2026-09-13T18:00:00Z", "dated reset: %s" % iso(r))
    r = parse_reset("You've hit your limit · resets 7pm (Europe/London)", now)
    ok(iso(r) == "2026-09-12T18:00:00Z", "bare time later today: %s" % iso(r))
    r = parse_reset("You've hit your limit · resets 6:40pm (Europe/London)", datetime(2026, 9, 12, 18, 0, tzinfo=timezone.utc))  # 19:00 London
    ok(iso(r) == "2026-09-13T17:40:00Z", "bare time already past -> tomorrow: %s" % iso(r))
    ok(parse_reset("all fine", now) is None, "no reset phrase")
    # 2. mark pauses the estate and records the missed job; the latest reset wins
    res = cmd_mark("task-manager", None, now=now, text="===== run =====\nYou've hit your limit · resets 7pm (Europe/London)\nVERIFY FAIL\n")
    ok(res["marked"] and res["paused_until"] == "2026-09-12T18:00:00Z", "mark: %r" % res)
    res = cmd_mark("inbound-triage", None, now=now + timedelta(hours=1), text="You've hit your limit · resets Sep 13 at 7pm (Europe/London)")
    ok(res["paused_until"] == "2026-09-13T18:00:00Z", "latest reset wins: %r" % res)
    res = cmd_mark("prospecting", None, now=now, text="worked fine")
    ok(not res["marked"], "no limit line -> not marked")
    # 3. check skips while paused and records the miss; runs once the reset has passed
    out, rc = cmd_check("prospecting", now=now + timedelta(hours=2))
    ok(rc == 3 and out["paused"] and "Sun 19:00" in out["reason"], "paused check: %r" % out)
    out, rc = cmd_check("prospecting", now=datetime(2026, 9, 13, 18, 1, tzinfo=timezone.utc))
    ok(rc == 0 and not out["paused"], "after reset check runs")
    st = load_state()
    ok([m["job"] for m in st["missed"]] == ["task-manager", "inbound-triage", "prospecting"], "missed list: %r" % st["missed"])
    # 4. replay waits for the reset, then starts each missed job once, in order, and clears the pause
    res = cmd_replay(now=now + timedelta(hours=3), starter=lambda j: "started", jobs={"task-manager", "inbound-triage", "prospecting"})
    ok(res["replayed"] == [] and "still paused" in res["reason"], "replay waits: %r" % res)
    started = []
    res = cmd_replay(now=datetime(2026, 9, 13, 18, 5, tzinfo=timezone.utc), starter=lambda j: (started.append(j), "started")[1],
                     jobs={"task-manager", "inbound-triage", "prospecting"})
    ok(started == ["task-manager", "inbound-triage", "prospecting"], "replay order: %r" % started)
    st = load_state()
    ok("paused_until" not in st and st["last_outage"]["replayed"][0]["job"] == "task-manager", "cleared and remembered: %r" % st)
    out, rc = cmd_check("task-manager", now=datetime(2026, 9, 13, 18, 6, tzinfo=timezone.utc))
    ok(rc == 0, "not paused after replay")
    # 4b. REVIEW 14 Sep 2026: only this run's lines are read, whatever the file size
    import tempfile as _tf
    big = os.path.join(_tf.mkdtemp(), "runs.log")
    with open(big, "w") as fh:
        fh.write("You've hit your limit · resets 7pm (Europe/London)\n" * 5000)   # 250KB of last week's lines
        fh.write("===== run =====\nworked fine\n===== done rc=0 =====\n")
    save_state({})
    res = cmd_mark("task-manager", big, since_line=5000, now=now)
    ok(not res["marked"], "old limit lines above since_line do not re-mark: %r" % res)
    res = cmd_mark("task-manager", big, since_line=0, now=now)
    ok(res["marked"], "and the same lines inside the window do mark")
    save_state({})
    # 4c. a limit line with a non-time after "resets" pauses one hour instead of crashing
    res = cmd_mark("task-manager", None, now=now, text="You've hit your limit · resets 30 min")
    ok(res["marked"] and res["paused_until"] == iso(now + timedelta(hours=1)), "unparseable reset -> one hour: %r" % res)
    res = cmd_mark("task-manager", None, now=now, text="You've hit your limit\nthe counter resets 9pm every day")
    ok(res["paused_until"] == iso(now + timedelta(hours=1)), "a reset on another line is never used: %r" % res)
    save_state({})
    # 4d. run_guarded: a Python step's claude call is refused while paused, and marks the pause from its output
    save_state({})
    r = run_guarded("content-engine", [sys.executable, "-c", "print(\"You've hit your limit \u00b7 resets 7pm (Europe/London)\")"])
    ok(r.returncode == 0 and load_state().get("paused_until"), "run_guarded marks from stdout: %r" % load_state())
    try:
        run_guarded("content-engine", [sys.executable, "-c", "print('never runs')"])
        ok(False, "run_guarded must refuse while paused")
    except SystemExit as exc:
        ok(str(exc).startswith("PAUSED:"), "refusal names the pause: %r" % str(exc))
    save_state({})
    r = run_guarded("content-engine", [sys.executable, "-c", "print('LINE1: HELLO')"])
    ok(r.stdout.strip() == "LINE1: HELLO" and not load_state().get("paused_until"), "clean output passes through unmarked")
    # 5. the poll and the board never queue a replay of themselves
    cmd_mark("handback-poll", None, now=now, text="You've hit your limit · resets 7pm (Europe/London)")
    ok(all(m["job"] != "handback-poll" for m in load_state().get("missed", [])), "handback-poll is never replayed")
    res = cmd_replay(dry_run=True, now=datetime(2026, 9, 12, 19, 0, tzinfo=timezone.utc), jobs={"handback-poll"})
    ok(res["replayed"] == [], "nothing to replay for the poll alone")
    return {"checks": checks, "failed": []}


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("mark"); m.add_argument("--job", required=True); m.add_argument("--log", required=True); m.add_argument("--since-line", type=int, default=0)
    c = sub.add_parser("check"); c.add_argument("--job", default="")
    r = sub.add_parser("replay"); r.add_argument("--dry-run", action="store_true")
    sub.add_parser("status"); sub.add_parser("selftest")
    a = ap.parse_args(argv)
    if a.cmd == "selftest":
        try:
            print(json.dumps(selftest())); return 0
        except AssertionError as exc:
            print(json.dumps({"checks": 0, "failed": [str(exc)]})); return 1
    if a.cmd == "mark":
        out = cmd_mark(a.job, a.log, a.since_line); print(json.dumps(out)); return 0 if out["marked"] else 1
    if a.cmd == "check":
        out, rc = cmd_check(a.job); print(json.dumps(out)); return rc
    if a.cmd == "replay":
        print(json.dumps(cmd_replay(dry_run=a.dry_run))); return 0
    print(json.dumps(cmd_status())); return 0


if __name__ == "__main__":
    sys.exit(main())
