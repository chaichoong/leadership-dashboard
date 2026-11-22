#!/usr/bin/env python3
"""mac-nudge.py: put a Mac health problem on Kevin's phone, once.

WHY (22 Nov 2026)
-----------------
The Mac froze that morning. The new memory alarm in mac-guard.sh turns its job
red, but a red job reaches nobody on its own: Slack alerts were retired on 1 Sep
and the morning digest on 15 Nov. So a problem only Kevin can fix goes in his
Apple Reminders list, the route magic-battery.py has used since 28 Sep, and his
iPhone and watch ping.

THE RULES
---------
- One open reminder per problem. It is never duplicated.
- A reminder ticked off with the problem still there comes back the next day,
  not the next hour.
- It never pings at night. A problem found from 21:00 to 08:00 pings at 08:00.
- It ticks itself off when the problem clears.
- A restart drops any job whose launchd file is broken, so while one is broken the
  reminder says to get that repaired first.

Usage:
  mac-nudge.py raise <memory|restart> "what is wrong"
  mac-nudge.py clear <memory|restart>
  mac-nudge.py again <memory|restart>   # raise the last reason again, if one is on file
"""
import datetime as dt
import fcntl
import glob
import importlib.util
import json
import os
import plistlib
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("MAC_NUDGE_STATE",
                       os.path.expanduser("~/knowledge-os/logs/mac-nudge-state.json"))
LIST_NAME = "Reminders"     # Kevin's default list. Never "Captures": that feeds the brain.
QUIET_FROM = 21
QUIET_UNTIL = 8
TITLES = {
    "memory": "Restart the Mac mini today: memory is running out",
    "restart": "Restart the Mac mini: its weekly restart did not happen",
}


def reminders():
    """The Reminders calls magic-battery.py already runs from launchd every hour."""
    spec = importlib.util.spec_from_file_location("magic_battery",
                                                  os.path.join(HERE, "magic-battery.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def marker(key):
    return "[mac-nudge %s]" % key


def alert_time(now):
    """When the phone may ping: two minutes from now, or 08:00 if that lands at night."""
    at = (now + dt.timedelta(minutes=2)).replace(second=0, microsecond=0)
    if at.hour >= QUIET_FROM:
        at += dt.timedelta(days=1)
    elif at.hour >= QUIET_UNTIL:
        return at
    return at.replace(hour=QUIET_UNTIL, minute=0)


def decide_raise(now, open_ref, last_date):
    """keep = one is already open. wait = he ticked it off today. create = make one."""
    if open_ref:
        return "keep"
    if last_date == now.date().isoformat():
        return "wait"
    return "create"


def load_state(path=None):
    path = path or STATE
    try:
        with open(path) as f:
            data = json.load(f)
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise ValueError("%s is not a JSON object" % path)
    return data


def save_state(state, path=None):
    """Write to a temp file and rename over, so a reader never sees half a file."""
    path = path or STATE
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, path)


def broken_launchd_files():
    """launchd drops a job whose file it cannot read at the next restart (22 Nov 2026)."""
    broken = []
    pattern = os.path.expanduser("~/Library/LaunchAgents/com.kevinbrittain.*.plist")
    for path in sorted(glob.glob(pattern)):
        try:
            with open(path, "rb") as fh:
                data = plistlib.load(fh)
            if not isinstance(data, dict) or not data.get("Label"):
                broken.append(os.path.basename(path))
        except Exception:
            broken.append(os.path.basename(path))
    return broken


def find_open(mb, key):
    for line in mb.osa(mb.LIST_OPEN, marker(key)).splitlines():
        if "\t" in line:
            return line.split("\t", 1)[0]
    return ""


def now_local():
    # Tests and the live proof set this, so a real reminder cannot ping anyone.
    fixed = os.environ.get("MAC_NUDGE_NOW")
    return dt.datetime.fromisoformat(fixed) if fixed else dt.datetime.now()


def cmd_raise(key, text, mb=None):
    mb = mb or reminders()
    now = now_local()
    state = load_state()
    entry = state.get(key) or {}
    broken = broken_launchd_files()
    open_ref = find_open(mb, key)
    # An open "restart" reminder is wrong the moment a launchd file breaks: obeying
    # it would switch that job off. Replace it with the "repair first" wording.
    if open_ref and broken and not entry.get("broken"):
        mb.osa(mb.COMPLETE, open_ref)
        open_ref = ""
        entry = {}
    action = decide_raise(now, open_ref, entry.get("date"))
    if action == "keep":
        # Today's date, so ticking it off this morning does not bring it back at 09:00.
        state[key] = {**entry, "date": now.date().isoformat(), "ref": open_ref, "text": text}
        save_state(state)
        print("reminder already open")
        return 0
    if action == "wait":
        print("ticked off today, back tomorrow if this is still true")
        return 0
    at = alert_time(now)
    title = TITLES[key]
    shown = text
    if broken:
        title = "Mac mini: ask Claude to repair %s, then restart" % broken[0]
        shown = "Restarting now would switch that job off for good. %s" % text
    body = "%s %s" % (shown, marker(key))
    ref = mb.osa(mb.CREATE, title, body, LIST_NAME, str(at.year), str(at.month),
                 str(at.day), str(at.hour * 3600 + at.minute * 60))
    state[key] = {"date": now.date().isoformat(), "ref": ref, "text": text, "broken": bool(broken)}
    save_state(state)
    print("reminder made, phone pings %s" % at.strftime("%a %H:%M"))
    return 0


def cmd_clear(key, mb=None):
    state = load_state()
    entry = state.get(key)
    # Nothing raised means no Reminders call at all, so an hourly healthy run costs nothing.
    if not entry or not entry.get("ref"):
        return 0
    # A repair reminder stands until the file is repaired, whatever else has cleared.
    if entry.get("broken") and broken_launchd_files():
        print("kept: a launchd file is still broken")
        return 0
    mb = mb or reminders()
    open_ref = find_open(mb, key)
    if open_ref:
        mb.osa(mb.COMPLETE, open_ref)
        print("problem cleared, reminder ticked off")
    else:
        print("problem cleared, no reminder was open")
    # The date stays, so memory hovering at the limit cannot ping again the same day.
    state[key] = {"date": entry.get("date")}
    save_state(state)
    return 0


def cmd_again(key, mb=None):
    """Bring back a reminder he ticked off with the problem still there."""
    entry = load_state().get(key) or {}
    if not entry.get("ref") or not entry.get("text"):
        return 0
    return cmd_raise(key, entry["text"], mb)


def locked(fn, *args):
    """One at a time: the guard and the restart job share the state file."""
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE + ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return fn(*args)


def main(argv):
    if len(argv) >= 2 and argv[1] in TITLES:
        if argv[0] == "raise" and len(argv) == 3 and argv[2].strip():
            return locked(cmd_raise, argv[1], argv[2])
        if argv[0] == "clear" and len(argv) == 2:
            return locked(cmd_clear, argv[1])
        if argv[0] == "again" and len(argv) == 2:
            return locked(cmd_again, argv[1])
    print(__doc__)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
