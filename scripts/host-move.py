#!/usr/bin/env python3
"""Move the scheduled-job estate from one Mac to another without a double-fire.

WHY THIS EXISTS (Kevin, 24 Sep 2026)
------------------------------------
The estate moves from the MacBook Air to a new Mac mini by Migration Assistant.
Migration Assistant copies ~/Library/LaunchAgents with everything else, and
job-queue.py's lock lives on ONE machine, so the two Macs cannot see each other.
Copy the estate while it is live and every job fires twice: two Airtable writes,
two Slack messages, two approval cards, two publishes. estate-status fires every
10 minutes, so the doubling would start within minutes of the copy finishing.

The copy would also start the jobs on the mini at its first login, before Google
Drive, the Claude sign-in and the privacy permissions exist there, so every job
would fail and file a finding while the Air carried on as if nothing had moved.

So the estate is PAUSED on the old Mac before the copy and RESUMED on the new
one after it:

  pause   (old Mac, before Migration Assistant) unloads every estate job and
          moves its plist into ~/Library/LaunchAgents.host-move-paused/, with a
          manifest naming this Mac's serial number. The copy then carries the
          jobs across switched OFF, so nothing fires on either Mac.
  resume  (new Mac, after sign-ins and permissions) moves them back and loads
          them. It REFUSES on the Mac named in the manifest, so the paused copy
          left on the old Mac cannot be switched back on by mistake. --rollback
          overrides that, for putting the jobs back on the old Mac on purpose.
  plan    read-only preview of what pause would move and what would block it.
  verify  read-only health check of the new host after resume.

The one Claude routine, daily-ops, is not a launchd job: the Claude desktop app
schedules it, and its scheduler no longer writes a file this script can edit
(see check-routines.py). pause and resume print the manual switch for it.

Usage:
  host-move.py plan
  host-move.py pause [--wait-minutes N]
  host-move.py resume [--rollback]
  host-move.py verify
  host-move.py selftest
Exit: 0 done/clean, 1 refused or a check failed, 2 cannot verify.
"""
import argparse
import glob
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
AGENTS_DIR = os.path.join(HOME, "Library", "LaunchAgents")
PAUSED_DIR = os.path.join(HOME, "Library", "LaunchAgents.host-move-paused")
SCHEDULE_FILE = os.environ.get(
    "JOB_QUEUE_SCHEDULE",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "job-schedule.json"),
)
EVENTS = os.path.join(
    os.environ.get("JOB_QUEUE_DIR", os.path.join(HOME, "knowledge-os/logs/queue")),
    "queue-events.jsonl",
)
PAT_FILE = os.path.join(HOME, ".config/od/airtable_pat")
RUNJOB = os.path.join(HOME, "tools/run-job.sh")
LOGS_DIR = os.path.join(HOME, "knowledge-os/logs")
DRIVE_GLOB = os.path.join(HOME, "Library/CloudStorage/GoogleDrive-*")

# Every estate job is com.kevinbrittain.<job>, except masterplan-sync, which is
# com.od.masterplan-sync (retry-deferred.py resolves labels for the same reason).
ESTATE_PREFIXES = ("com.kevinbrittain.", "com.od.")

MANIFEST_NAME = "manifest.json"

# A new host that has not written a queue event for this long after resume is
# not proven to be running jobs yet. estate-status alone fires every 10 minutes.
EVENT_FRESH_MINUTES = 20

ROUTINE_NOTE = (
    "The Claude routine daily-ops is scheduled by the Claude desktop app, not by "
    "launchd. Switch it %s in the Claude app on THIS Mac: Scheduled, daily-ops."
)


def manifest_path():
    return os.path.join(PAUSED_DIR, MANIFEST_NAME)


# ─── the world, through two seams the selftest replaces ─────────────────

def run(cmd):
    """(rc, stdout, stderr). A missing binary is rc 127, never an exception."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        return p.returncode, p.stdout, p.stderr
    except FileNotFoundError:
        return 127, "", "not found: %s" % cmd[0]
    except subprocess.TimeoutExpired:
        return 124, "", "timed out: %s" % " ".join(cmd)


def machine_serial():
    """This Mac's hardware serial. Migration Assistant never copies it, which is
    what makes it the proof of WHICH Mac a manifest was written on."""
    rc, out, _ = run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
    if rc == 0:
        m = re.search(r'"IOPlatformSerialNumber"\s*=\s*"([^"]+)"', out)
        if m:
            return m.group(1)
    rc, out, _ = run(["system_profiler", "SPHardwareDataType"])
    if rc == 0:
        m = re.search(r"Serial Number \(system\):\s*(\S+)", out)
        if m:
            return m.group(1)
    return None


def machine_name():
    rc, out, _ = run(["scutil", "--get", "ComputerName"])
    return out.strip() if rc == 0 and out.strip() else "this Mac"


# ─── reading the estate ──────────────────────────────────────────────────

def registered_jobs():
    """{job name -> config} from job-schedule.json. None if unreadable."""
    try:
        with open(SCHEDULE_FILE) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return {k: v for k, v in data.items() if not k.startswith("_") and isinstance(v, dict)}


def live_wrapped_jobs(jobs):
    """The jobs launchd is supposed to run: wrapped and not switched off."""
    return sorted(k for k, v in (jobs or {}).items()
                  if v.get("mode") == "wrapped" and v.get("enabled", True) is not False)


def _job_token(args, jobs):
    """The job name a plist runs, by exact bare-token match. Exact on purpose:
    `daily-ops` must never claim a plist that runs `daily-ops-guard`."""
    for tok in args:
        if tok and not tok.startswith("/") and not tok.startswith("-") and tok in jobs:
            return tok
    return None


def estate_plists(directory, jobs):
    """Every estate LaunchAgent in `directory`, as dicts. A plist is estate when
    its label carries an estate prefix OR it runs a registered job by name."""
    found = []
    if not os.path.isdir(directory):
        return found
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".plist"):
            continue
        path = os.path.join(directory, name)
        try:
            with open(path, "rb") as fh:
                pl = plistlib.load(fh)
        except Exception:
            continue
        label = pl.get("Label")
        if not label:
            continue
        args = [str(a) for a in (pl.get("ProgramArguments") or [])]
        job = _job_token(args, jobs or {})
        if not (label.startswith(ESTATE_PREFIXES) or job):
            continue
        found.append({
            "label": label,
            "file": name,
            "path": path,
            "job": job,
            "keepalive": bool(pl.get("KeepAlive")),
            "abs_paths": [a for a in args if a.startswith("/")],
        })
    return found


def launchctl_pids():
    """{label -> pid or None} for everything launchd has loaded for this user.
    None means loaded but not running. A failed read is None overall."""
    rc, out, _ = run(["launchctl", "list"])
    if rc != 0:
        return None
    loaded = {}
    for line in out.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) < 3:
            parts = line.split()
        if len(parts) < 3:
            continue
        pid, label = parts[0].strip(), parts[-1].strip()
        loaded[label] = int(pid) if pid.isdigit() else None
    return loaded


def git_state(repo):
    """(dirty worktrees, unpushed commit count). Read-only."""
    rc, out, _ = run(["git", "-C", repo, "worktree", "list", "--porcelain"])
    trees = [l.split(" ", 1)[1] for l in out.splitlines() if l.startswith("worktree ")] if rc == 0 else [repo]
    dirty = []
    for t in trees:
        rc, out, _ = run(["git", "-C", t, "status", "--porcelain"])
        if rc == 0 and out.strip():
            dirty.append(t)
    rc, out, _ = run(["git", "-C", repo, "log", "--branches", "--not", "--remotes", "--oneline"])
    unpushed = len([l for l in out.splitlines() if l.strip()]) if rc == 0 else None
    return dirty, unpushed


def write_json_atomic(path, data):
    """Temp file + os.replace. A manifest truncated mid-write would read as
    'nothing paused' and let resume load nothing (python-scripts rule 1)."""
    tmp = "%s.tmp-%d" % (path, os.getpid())
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


def read_manifest():
    try:
        with open(manifest_path()) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def uid():
    return os.getuid()


# ─── plan ────────────────────────────────────────────────────────────────

def cmd_plan():
    jobs = registered_jobs()
    blockers, warnings, lines = [], [], []
    if jobs is None:
        return {"ok": False, "blockers": ["cannot read %s" % SCHEDULE_FILE]}, 2
    plists = estate_plists(AGENTS_DIR, jobs)
    wrapped = live_wrapped_jobs(jobs)
    # CONTROL: a matcher that finds nothing reads as "nothing to move" for ever.
    if not plists:
        blockers.append("found 0 estate jobs in %s; expected about %d. Nothing would be "
                        "paused, so the copy would carry live jobs." % (AGENTS_DIR, len(wrapped)))
    covered = {p["job"] for p in plists if p["job"]}
    missing = [j for j in wrapped if j not in covered]
    if missing:
        warnings.append("registered jobs with no plist on this Mac (not installed, or "
                        "retired): %s" % ", ".join(missing))
    pids = launchctl_pids()
    running = []
    if pids is None:
        warnings.append("could not read `launchctl list`")
    else:
        running = [p["label"] for p in plists
                   if pids.get(p["label"]) and not p["keepalive"]]
    if running:
        warnings.append("running now (pause waits for these): %s" % ", ".join(running))
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dirty, unpushed = git_state(repo)
    if dirty:
        warnings.append("uncommitted work in: %s. It will be copied to the new Mac AND "
                        "left here; commit and push it first so the two copies cannot "
                        "drift apart." % ", ".join(dirty))
    if unpushed:
        warnings.append("%d local commit(s) not on GitHub. Push them first." % unpushed)
    if read_manifest():
        warnings.append("already paused: a manifest exists in %s" % PAUSED_DIR)
    rc, out, _ = run(["df", "-k", HOME])
    used = None
    if rc == 0 and len(out.splitlines()) > 1:
        cols = out.splitlines()[1].split()
        if len(cols) > 2 and cols[2].isdigit():
            used = round(int(cols[2]) / 1024 / 1024, 1)
    for p in plists:
        lines.append("%s%s" % (p["label"], "  (keepalive)" if p["keepalive"] else ""))
    report = {
        "ok": not blockers,
        "machine": machine_name(),
        "serial": machine_serial(),
        "estate_jobs": len(plists),
        "registered_wrapped_jobs": len(wrapped),
        "would_pause": lines,
        "disk_used_gb": used,
        "blockers": blockers,
        "warnings": warnings,
        "routine": ROUTINE_NOTE % "OFF before the copy",
    }
    return report, (0 if not blockers else 1)


# ─── pause ───────────────────────────────────────────────────────────────

def cmd_pause(wait_minutes=15, sleep=time.sleep, clock=time.time):
    jobs = registered_jobs()
    if jobs is None:
        return {"ok": False, "error": "cannot read %s" % SCHEDULE_FILE}, 2
    if read_manifest():
        return {"ok": True, "already": True,
                "note": "already paused; nothing moved. Manifest: %s" % manifest_path()}, 0
    plists = estate_plists(AGENTS_DIR, jobs)
    if not plists:
        return {"ok": False, "error": "found 0 estate jobs in %s. Refusing: an empty pause "
                "would let the copy carry live jobs." % AGENTS_DIR}, 1
    serial = machine_serial()
    if not serial:
        return {"ok": False, "error": "could not read this Mac's serial number, so resume "
                "could not tell the two Macs apart. Refusing."}, 2

    # Never pull a job out from under itself: wait for running ones to finish.
    deadline = clock() + wait_minutes * 60
    while True:
        pids = launchctl_pids()
        if pids is None:
            return {"ok": False, "error": "could not read `launchctl list`"}, 2
        running = [p["label"] for p in plists if pids.get(p["label"]) and not p["keepalive"]]
        if not running:
            break
        if clock() >= deadline:
            return {"ok": False, "running": running,
                    "error": "these jobs are still running after %d minute(s); try again "
                    "in a few minutes: %s" % (wait_minutes, ", ".join(running))}, 1
        sleep(20)

    os.makedirs(PAUSED_DIR, exist_ok=True)
    moved, failed = [], []
    for p in plists:
        run(["launchctl", "bootout", "gui/%d/%s" % (uid(), p["label"])])  # not-loaded is fine
        try:
            shutil.move(p["path"], os.path.join(PAUSED_DIR, p["file"]))
            moved.append({"label": p["label"], "file": p["file"], "job": p["job"]})
        except OSError as e:
            failed.append("%s: %s" % (p["file"], e))

    write_json_atomic(manifest_path(), {
        "version": 1,
        "paused_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_serial": serial,
        "source_name": machine_name(),
        "labels": moved,
    })

    # Prove it: nothing from the estate may still be loaded.
    pids = launchctl_pids() or {}
    still = [m["label"] for m in moved if m["label"] in pids]
    ok = not failed and not still and len(moved) == len(plists)
    return {"ok": ok, "paused": len(moved), "expected": len(plists),
            "move_failures": failed, "still_loaded": still,
            "manifest": manifest_path(),
            "next": ROUTINE_NOTE % "OFF now, before Migration Assistant"}, (0 if ok else 1)


# ─── resume ──────────────────────────────────────────────────────────────

def cmd_resume(rollback=False):
    m = read_manifest()
    if not m:
        return {"ok": False, "error": "no manifest in %s. Nothing was paused on the old "
                "Mac, or the copy has not carried it across yet." % PAUSED_DIR}, 1
    serial = machine_serial()
    if not serial:
        return {"ok": False, "error": "could not read this Mac's serial number; cannot prove "
                "this is the new Mac. Refusing."}, 2
    if serial == m.get("source_serial") and not rollback:
        return {"ok": False, "error": "this is the Mac the jobs were paused ON (%s). Resuming "
                "here would run them on both Macs. Run resume on the NEW Mac, or pass "
                "--rollback to deliberately put them back here." % m.get("source_name")}, 1

    # Every absolute path a job runs must exist here. A new account with a
    # different username breaks every one of them, silently, at 2am.
    blockers = []
    entries = []
    for e in m.get("labels", []):
        # A resume that failed part-way has already moved some plists back. Read
        # them where they now are, so a second run retries instead of refusing.
        src = os.path.join(PAUSED_DIR, e["file"])
        if not os.path.exists(src):
            src = os.path.join(AGENTS_DIR, e["file"])
        try:
            with open(src, "rb") as fh:
                pl = plistlib.load(fh)
        except Exception as ex:
            blockers.append("cannot read %s: %s" % (e["file"], ex))
            continue
        args = [str(a) for a in (pl.get("ProgramArguments") or [])]
        for a in args:
            if a.startswith("/") and not os.path.exists(a):
                blockers.append("%s needs %s, which does not exist on this Mac" % (e["label"], a))
                break
        entries.append((e, src))
    for need, what in ((RUNJOB, "the job wrapper"), (LOGS_DIR, "the logs folder"),
                       (PAT_FILE, "the Airtable token file")):
        if not os.path.exists(need):
            blockers.append("missing %s: %s" % (what, need))
    if blockers:
        return {"ok": False, "blockers": blockers,
                "note": "Nothing was loaded. Fix these and run resume again."}, 1

    os.makedirs(AGENTS_DIR, exist_ok=True)
    loaded, failed = [], []
    for e, src in entries:
        dst = os.path.join(AGENTS_DIR, e["file"])
        if src != dst:
            try:
                shutil.move(src, dst)
            except OSError as ex:
                failed.append("%s: move failed: %s" % (e["file"], ex))
                continue
        rc, _, err = run(["launchctl", "bootstrap", "gui/%d" % uid(), dst])
        if rc != 0 and "already" not in (err or "").lower():
            failed.append("%s: bootstrap rc=%d %s" % (e["label"], rc, (err or "").strip()))
        loaded.append(e["label"])

    pids = launchctl_pids() or {}
    not_loaded = [l for l in loaded if l not in pids]
    ok = not failed and not not_loaded and len(loaded) == len(m.get("labels", []))
    if ok:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        os.replace(manifest_path(), os.path.join(PAUSED_DIR, "manifest.resumed-%s.json" % stamp))
    return {"ok": ok, "resumed": len(loaded) - len(not_loaded),
            "expected": len(m.get("labels", [])), "failures": failed,
            "not_loaded": not_loaded,
            "next": ROUTINE_NOTE % "ON now"}, (0 if ok else 1)


# ─── verify ──────────────────────────────────────────────────────────────

def parse_pmset(text):
    """{'sleep': 0, 'autorestart': 1, ...} from `pmset -g`."""
    out = {}
    for line in text.splitlines():
        mm = re.match(r"^\s*([A-Za-z]+)\s+(\d+)\b", line)
        if mm:
            out[mm.group(1)] = int(mm.group(2))
    return out


def hardware_ports(text):
    """{'Ethernet': 'en0', 'Wi-Fi': 'en1'} from `networksetup -listallhardwareports`."""
    ports, cur = {}, None
    for line in text.splitlines():
        if line.startswith("Hardware Port:"):
            cur = line.split(":", 1)[1].strip()
        elif line.startswith("Device:") and cur:
            ports[cur] = line.split(":", 1)[1].strip()
            cur = None
    return ports


def last_event_age_minutes(now=None):
    try:
        with open(EVENTS, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 8192))
            tail = f.read().decode("utf-8", "replace").strip().splitlines()
    except OSError:
        return None
    for line in reversed(tail):
        try:
            ts = json.loads(line).get("ts", "")
            dt = datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
            now = now or datetime.now(timezone.utc)
            return round((now - dt).total_seconds() / 60, 1)
        except (ValueError, AttributeError):
            continue
    return None


def cmd_verify():
    checks = []

    def add(name, status, detail, fix=""):
        checks.append({"check": name, "status": status, "detail": detail, "fix": fix})

    jobs = registered_jobs()
    if jobs is None:
        add("schedule", "UNVERIFIED", "cannot read %s" % SCHEDULE_FILE)
        jobs = {}
    if read_manifest():
        add("not paused here", "FAIL", "a pause manifest is still waiting in %s" % PAUSED_DIR,
            "run resume on this Mac")
    plists = estate_plists(AGENTS_DIR, jobs)
    pids = launchctl_pids()
    if pids is None:
        add("jobs loaded", "UNVERIFIED", "could not read `launchctl list`")
    elif not plists:
        add("jobs loaded", "FAIL", "0 estate jobs installed on this Mac", "run resume")
    else:
        unloaded = [p["label"] for p in plists if p["label"] not in pids]
        add("jobs loaded", "FAIL" if unloaded else "PASS",
            "%d of %d loaded%s" % (len(plists) - len(unloaded), len(plists),
                                   ("; not loaded: " + ", ".join(unloaded)) if unloaded else ""))

    rc, out, _ = run(["pmset", "-g"])
    pm = parse_pmset(out) if rc == 0 else {}
    for key, want, fix in (
        ("sleep", 0, "System Settings, Energy: Prevent automatic sleeping when the display is off"),
        ("autorestart", 1, "System Settings, Energy: Start up automatically after a power failure"),
        ("womp", 1, "System Settings, Energy: Wake for network access"),
    ):
        if key not in pm:
            add("energy: %s" % key, "UNVERIFIED", "not reported by pmset", fix)
        else:
            add("energy: %s" % key, "PASS" if pm[key] == want else "FAIL",
                "%s is %d, want %d" % (key, pm[key], want), fix)

    rc, out, _ = run(["networksetup", "-listallhardwareports"])
    ports = hardware_ports(out) if rc == 0 else {}
    eth = next((d for p, d in ports.items() if p.lower().startswith("ethernet")), None)
    wifi = ports.get("Wi-Fi")
    if eth:
        rc, ip, _ = run(["ipconfig", "getifaddr", eth])
        add("ethernet", "PASS" if rc == 0 and ip.strip() else "FAIL",
            "%s %s" % (eth, ip.strip() or "has no address"), "plug in the network cable")
    else:
        add("ethernet", "UNVERIFIED", "no Ethernet port reported")
    if wifi:
        rc, out, _ = run(["networksetup", "-getairportpower", wifi])
        on = rc == 0 and out.strip().endswith("On")
        add("wi-fi switched on", "PASS" if on else "FAIL",
            out.strip() or "unknown",
            "keep Wi-Fi ON: Universal Control and AirDrop need it even when the cable is in")

    drives = glob.glob(DRIVE_GLOB)
    readable = any(os.path.isdir(d) and os.listdir(d) for d in drives) if drives else False
    add("google drive", "PASS" if readable else "FAIL",
        ", ".join(os.path.basename(d) for d in drives) or "not mounted",
        "open Google Drive for desktop and sign in")
    for need, what in ((PAT_FILE, "airtable token"), (RUNJOB, "job wrapper"), (LOGS_DIR, "logs folder")):
        add(what, "PASS" if os.path.exists(need) else "FAIL", need)
    rc, _, _ = run(["gh", "auth", "status"])
    add("github cli", "PASS" if rc == 0 else "FAIL", "gh auth status rc=%d" % rc, "gh auth login")

    age = last_event_age_minutes()
    if age is None:
        add("jobs running", "UNVERIFIED", "no queue events readable yet")
    elif age <= EVENT_FRESH_MINUTES:
        add("jobs running", "PASS", "last queue event %.0f min ago" % age)
    else:
        add("jobs running", "WAITING", "last queue event %.0f min ago" % age,
            "re-run verify in 10 minutes; estate-status fires every 10")

    fails = [c for c in checks if c["status"] == "FAIL"]
    unverified = [c for c in checks if c["status"] in ("UNVERIFIED", "WAITING")]
    rc = 1 if fails else (2 if unverified else 0)
    return {"ok": not fails, "checks": checks,
            "routine": "Confirm daily-ops is switched ON in the Claude app on this Mac."}, rc


# ─── selftest ────────────────────────────────────────────────────────────

def selftest():
    import tempfile
    global HOME, AGENTS_DIR, PAUSED_DIR, SCHEDULE_FILE, EVENTS, PAT_FILE, RUNJOB, LOGS_DIR
    global run, machine_serial, machine_name
    real = (HOME, AGENTS_DIR, PAUSED_DIR, SCHEDULE_FILE, EVENTS, PAT_FILE, RUNJOB, LOGS_DIR,
            run, machine_serial, machine_name)
    checks, failed = 0, []

    def ok(cond, what):
        nonlocal checks
        checks += 1
        if not cond:
            failed.append(what)

    root = tempfile.mkdtemp(prefix="host-move-")
    HOME = root
    AGENTS_DIR = os.path.join(root, "LaunchAgents")
    PAUSED_DIR = os.path.join(root, "LaunchAgents.host-move-paused")
    SCHEDULE_FILE = os.path.join(root, "job-schedule.json")
    EVENTS = os.path.join(root, "queue-events.jsonl")
    PAT_FILE = os.path.join(root, "airtable_pat")
    RUNJOB = os.path.join(root, "run-job.sh")
    LOGS_DIR = os.path.join(root, "logs")
    for p in (PAT_FILE, RUNJOB):
        open(p, "w").write("x")
    os.makedirs(LOGS_DIR)
    os.makedirs(AGENTS_DIR)
    json.dump({"_comment": ["x"],
               "estate-status": {"mode": "wrapped"},
               "daily-ops": {"mode": "cooperative"},
               "daily-ops-guard": {"mode": "wrapped"},
               "masterplan-sync": {"mode": "wrapped"},
               "uc-check": {"mode": "wrapped", "enabled": False}},
              open(SCHEDULE_FILE, "w"))

    def plist(fname, label, args, keepalive=False):
        body = {"Label": label, "ProgramArguments": args}
        if keepalive:
            body["KeepAlive"] = True
        with open(os.path.join(AGENTS_DIR, fname), "wb") as fh:
            plistlib.dump(body, fh)

    queue = os.path.join(root, "job-queue.py")
    open(queue, "w").write("x")
    plist("com.kevinbrittain.estate-status.plist", "com.kevinbrittain.estate-status",
          ["/usr/bin/python3", queue, "run", "estate-status", "--", RUNJOB, "estate-status"])
    plist("com.kevinbrittain.daily-ops-guard.plist", "com.kevinbrittain.daily-ops-guard",
          ["/bin/bash", RUNJOB, "daily-ops-guard"])
    plist("com.od.masterplan-sync.plist", "com.od.masterplan-sync",
          ["/usr/bin/python3", queue, "run", "masterplan-sync"])
    plist("com.kevinbrittain.watcher.plist", "com.kevinbrittain.watcher", ["/bin/bash", RUNJOB], keepalive=True)
    plist("com.google.keystone.agent.plist", "com.google.keystone.agent", ["/opt/google/ks"])

    state = {"loaded": {"com.kevinbrittain.estate-status": None,
                        "com.kevinbrittain.daily-ops-guard": None,
                        "com.od.masterplan-sync": None,
                        "com.kevinbrittain.watcher": 4242,
                        "com.google.keystone.agent": 99},
             "calls": [], "serial": "AIR-SERIAL", "bootstrap_rc": 0}

    def fake_run(cmd):
        state["calls"].append(cmd)
        if cmd[:2] == ["launchctl", "list"]:
            rows = ["PID\tStatus\tLabel"] + ["%s\t0\t%s" % (p if p else "-", l)
                                             for l, p in state["loaded"].items()]
            return 0, "\n".join(rows) + "\n", ""
        if cmd[:2] == ["launchctl", "bootout"]:
            label = cmd[2].split("/", 2)[2]
            if label in state["loaded"]:
                del state["loaded"][label]
                return 0, "", ""
            return 3, "", "Boot-out failed: 3: No such process"
        if cmd[:2] == ["launchctl", "bootstrap"]:
            if state["bootstrap_rc"] == 0:
                with open(cmd[3], "rb") as fh:
                    state["loaded"][plistlib.load(fh)["Label"]] = None
            return state["bootstrap_rc"], "", "" if state["bootstrap_rc"] == 0 else "Bootstrap failed: 5"
        if cmd[0] == "pmset":
            return 0, "System-wide power settings:\n Currently in use:\n sleep                0\n autorestart          1\n womp                 1\n", ""
        return 1, "", ""

    run = fake_run
    machine_serial = lambda: state["serial"]
    machine_name = lambda: "Test Mac"
    try:
        jobs = registered_jobs()
        # 1. discovery: prefix OR registered token; third-party plists ignored
        found = {p["label"] for p in estate_plists(AGENTS_DIR, jobs)}
        ok(found == {"com.kevinbrittain.estate-status", "com.kevinbrittain.daily-ops-guard",
                     "com.od.masterplan-sync", "com.kevinbrittain.watcher"},
           "discovery: %r" % sorted(found))
        # 2. exact token: daily-ops-guard's plist belongs to daily-ops-guard, never daily-ops
        guard = [p for p in estate_plists(AGENTS_DIR, jobs) if p["label"].endswith("daily-ops-guard")][0]
        ok(guard["job"] == "daily-ops-guard", "exact token match: %r" % guard["job"])
        # 3. control: an empty agents dir is a blocker, never "nothing to do"
        empty = os.path.join(root, "empty")
        os.makedirs(empty)
        ok(estate_plists(empty, jobs) == [], "empty dir finds nothing")
        saved, AGENTS_DIR = AGENTS_DIR, empty
        rep, rc = cmd_plan()
        ok(rc == 1 and any("found 0" in b for b in rep.get("blockers", [])), "plan control: %r" % rep)
        res, rc = cmd_pause(wait_minutes=0)
        ok(rc == 1 and not os.path.exists(os.path.join(PAUSED_DIR, MANIFEST_NAME)),
           "pause refuses an empty estate: %r" % res)
        AGENTS_DIR = saved
        # 4. pause waits for a running non-keepalive job, then refuses at the deadline
        state["loaded"]["com.kevinbrittain.estate-status"] = 555
        t = [0.0]
        res, rc = cmd_pause(wait_minutes=1, sleep=lambda s: t.__setitem__(0, t[0] + s), clock=lambda: t[0])
        ok(rc == 1 and res.get("running") == ["com.kevinbrittain.estate-status"],
           "pause refuses while a job runs: %r" % res)
        ok(os.listdir(AGENTS_DIR) and not os.path.isdir(PAUSED_DIR), "nothing moved while refused")
        state["loaded"]["com.kevinbrittain.estate-status"] = None
        # 5. pause: 4 moved, keepalive not waited for, third party untouched, manifest atomic
        res, rc = cmd_pause(wait_minutes=0)
        ok(rc == 0 and res.get("paused") == 4, "pause: %r" % res)
        ok(sorted(os.listdir(AGENTS_DIR)) == ["com.google.keystone.agent.plist"],
           "only third party left: %r" % os.listdir(AGENTS_DIR))
        m = read_manifest()
        ok(m and m["source_serial"] == "AIR-SERIAL" and len(m["labels"]) == 4, "manifest: %r" % m)
        ok(not [f for f in os.listdir(PAUSED_DIR) if ".tmp-" in f], "no temp file left")
        ok("com.google.keystone.agent" in state["loaded"], "third party still loaded")
        # 6. a second pause is a no-op, not a second move
        res, rc = cmd_pause(wait_minutes=0)
        ok(rc == 0 and res.get("already"), "pause is idempotent: %r" % res)
        # 7. resume on the SAME Mac refuses without --rollback
        res, rc = cmd_resume()
        ok(rc == 1 and "paused ON" in res.get("error", ""), "same Mac refused: %r" % res)
        # 8. resume on a new Mac with a missing path refuses and loads nothing (username change)
        state["serial"] = "MINI-SERIAL"
        os.rename(queue, queue + ".gone")
        res, rc = cmd_resume()
        ok(rc == 1 and any("does not exist" in b for b in res.get("blockers", [])), "missing path: %r" % res)
        ok(len(os.listdir(PAUSED_DIR)) == 5, "nothing moved on refusal")
        os.rename(queue + ".gone", queue)
        # 9. resume on the new Mac: all 4 back and loaded, manifest archived
        res, rc = cmd_resume()
        ok(rc == 0 and res.get("resumed") == 4, "resume: %r" % res)
        ok(read_manifest() is None and any(f.startswith("manifest.resumed-") for f in os.listdir(PAUSED_DIR)),
           "manifest archived")
        ok(len([f for f in os.listdir(AGENTS_DIR) if f.endswith(".plist")]) == 5, "plists back")
        # 10. rollback: the old Mac may take them back on purpose
        state["serial"] = "AIR-SERIAL"
        res, rc = cmd_pause(wait_minutes=0)
        res, rc = cmd_resume(rollback=True)
        ok(rc == 0 and res.get("resumed") == 4, "rollback: %r" % res)
        # 11. a failed bootstrap is reported, never passed
        state["serial"] = "AIR-SERIAL"
        cmd_pause(wait_minutes=0)
        state["serial"] = "MINI-SERIAL"
        state["bootstrap_rc"] = 5
        res, rc = cmd_resume()
        ok(rc == 1 and res.get("failures", []) and read_manifest() is not None,
           "bootstrap failure kept the manifest: %r" % res)
        # 11b. once the fault clears, the same resume retries and completes
        state["bootstrap_rc"] = 0
        res, rc = cmd_resume()
        ok(rc == 0 and res.get("resumed") == 4 and read_manifest() is None,
           "retry after a part-failed resume: %r" % res)
        # 12. parsers
        ok(parse_pmset(" sleep 1\n autorestart   0\n womp 1\n") == {"sleep": 1, "autorestart": 0, "womp": 1},
           "pmset parse")
        ok(hardware_ports("Hardware Port: Ethernet\nDevice: en0\n\nHardware Port: Wi-Fi\nDevice: en1\n")
           == {"Ethernet": "en0", "Wi-Fi": "en1"}, "ports parse")
        with open(EVENTS, "w") as f:
            f.write(json.dumps({"ts": "2026-09-27T10:00:00.000Z", "job": "x", "state": "acquired"}) + "\n")
        age = last_event_age_minutes(datetime(2026, 9, 27, 10, 12, tzinfo=timezone.utc))
        ok(age == 12.0, "event age: %r" % age)
        ok(live_wrapped_jobs(jobs) == ["daily-ops-guard", "estate-status", "masterplan-sync"],
           "retired uc-check excluded: %r" % live_wrapped_jobs(jobs))
    finally:
        (HOME, AGENTS_DIR, PAUSED_DIR, SCHEDULE_FILE, EVENTS, PAT_FILE, RUNJOB, LOGS_DIR,
         run, machine_serial, machine_name) = real
        shutil.rmtree(root, ignore_errors=True)
    return {"checks": checks, "failed": failed}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("plan")
    p = sub.add_parser("pause")
    p.add_argument("--wait-minutes", type=int, default=15)
    r = sub.add_parser("resume")
    r.add_argument("--rollback", action="store_true")
    sub.add_parser("verify")
    sub.add_parser("selftest")
    a = ap.parse_args()
    if a.cmd == "selftest":
        out = selftest()
        print(json.dumps(out))
        return 0 if not out["failed"] else 1
    if sys.platform != "darwin":
        print(json.dumps({"ok": False, "error": "this runs on the Macs only"}))
        return 2
    if a.cmd == "plan":
        out, rc = cmd_plan()
    elif a.cmd == "pause":
        out, rc = cmd_pause(a.wait_minutes)
    elif a.cmd == "resume":
        out, rc = cmd_resume(a.rollback)
    else:
        out, rc = cmd_verify()
    print(json.dumps(out, indent=2))
    return rc


if __name__ == "__main__":
    sys.exit(main())
