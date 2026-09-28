#!/usr/bin/env python3
"""magic-battery.py — tell Kevin to charge a Magic device the evening it runs low.

WHY (Kevin, 28 Sep 2026)
------------------------
The Mac mini runs a Magic Keyboard, Magic Trackpad and Magic Mouse, all on
built-in batteries over Bluetooth. They ran out mid-work with no warning worth
having. This reads every device's level each hour and, at 21:25, puts one
reminder per low device in Kevin's Apple Reminders list with a 21:30 alert, so
his iPhone and watch ping in time to plug it in overnight. The reminder ticks
itself off once that device reads above the threshold again.

The mouse matters most: its charging port is underneath, so it cannot be used
while it charges. Overnight is the only painless time to do it.

BLUETOOTH SETTINGS IS NOT A FULL SOURCE (measured 28 Sep 2026)
--------------------------------------------------------------
`system_profiler SPBluetoothDataType` (what the Bluetooth settings pane shows)
gave the keyboard's and trackpad's levels and NO level for the mouse. The IO
registry (`ioreg -r -k BatteryPercent`) had all three. So the level always
comes from ioreg. The NAME comes from system_profiler, matched on device
address, because ioreg's own name for the keyboard is its owner string
("System Administrator's Keyboard"), not "Magic Keyboard".

ABSENCE IS REPORTED, NEVER SILENT
---------------------------------
A device that stops reporting is not a device that is fine. A switched-off or
dead device simply vanishes from ioreg, so "no low readings" would read as all
clear on exactly the night it has already run out. Any device seen in the last
30 days and not seen for 48 hours gets its own "not seen" reminder. A reading
with no usable level is not recorded at all, so it can never pass as a number.

ONE NUDGE PER DEVICE PER EVENING
--------------------------------
An open reminder is never duplicated, and a device is nudged at most once per
day (state.json), so ticking a reminder off without charging does not bring it
straight back the same evening. It comes back the next evening, which is the
point: the obligation is the charge, not the reminder.

Nothing identifying (device addresses, serials) lives in this repo. They exist
only in the private log under ~/knowledge-os/logs/magic-battery/.

Usage:
  magic-battery.py run [--threshold N] [--force-nudge] [--dry-run]
  magic-battery.py read        print what the Mac sees now, change nothing
  magic-battery.py selftest    offline checks of the decision rules
"""

import datetime as dt
import json
import os
import plistlib
import re
import subprocess
import sys

THRESHOLD = 20                 # nudge at this level or below (Kevin, 28 Sep 2026)
NUDGE_AT = (21, 25)            # the run that creates reminders
ALERT_AT = (21, 30)            # when the phone and watch ping (Kevin, 28 Sep 2026)
FRESH_HOURS = 24               # a reading older than this does not count as the current level
MISSING_HOURS = 48             # not seen this long = its own reminder
FORGET_DAYS = 30               # a device unseen this long is no longer expected
LIST_NAME = "Reminders"        # Kevin's default list. Never "Captures": that feeds the brain.
MARK = "[magic-battery"        # every reminder this script owns carries this in its notes

LOGDIR = os.path.expanduser("~/knowledge-os/logs/magic-battery")
READINGS = os.path.join(LOGDIR, "readings.jsonl")
STATE = os.path.join(LOGDIR, "state.json")


# --------------------------------------------------------------------------
# Reading the devices
# --------------------------------------------------------------------------

def norm_addr(addr):
    """ioreg writes 68-fe-f7-..., system_profiler writes 68:FE:F7:... ."""
    return (addr or "").replace("-", ":").upper()


def short_id(addr):
    """Last four hex digits: enough to tell three devices apart in a reminder note."""
    return norm_addr(addr).replace(":", "")[-4:].lower()


def display_name(name):
    """'Magic Mouse 2' -> 'Magic Mouse'. The generation number is noise on a phone."""
    return re.sub(r"\s+\d+$", "", (name or "").strip()) or "Bluetooth device"


def parse_ioreg(raw):
    """Battery levels from `ioreg -r -k BatteryPercent -a` (a plist array).

    Returns {address: {"level": int|None, "product": str}}. A level that is not
    a whole number from 0 to 100 becomes None, never a guess.
    """
    out = {}
    for entry in plistlib.loads(raw) if raw else []:
        addr = norm_addr(entry.get("DeviceAddress"))
        if not addr or entry.get("Built-In") is True:
            continue
        level = entry.get("BatteryPercent")
        if isinstance(level, bool) or not isinstance(level, int) or not 0 <= level <= 100:
            level = None
        out[addr] = {"level": level, "product": entry.get("Product") or ""}
    return out


def parse_profiler(data):
    """Device names by address from `system_profiler -json SPBluetoothDataType`."""
    names = {}
    for ctrl in (data or {}).get("SPBluetoothDataType", []):
        for group in ("device_connected", "device_not_connected"):
            for dev in ctrl.get(group, []) or []:
                for name, info in dev.items():
                    addr = norm_addr((info or {}).get("device_address"))
                    if addr:
                        names[addr] = name
    return names


def read_devices():
    """What the Mac sees now: [{"id", "name", "level"}]. Raises if ioreg itself fails."""
    p = subprocess.run(["/usr/sbin/ioreg", "-r", "-k", "BatteryPercent", "-a"],
                       capture_output=True, timeout=60)
    if p.returncode != 0:
        raise RuntimeError("ioreg failed: %s" % p.stderr.decode(errors="replace").strip())
    levels = parse_ioreg(p.stdout)
    names = {}
    try:
        sp = subprocess.run(["/usr/sbin/system_profiler", "-json", "SPBluetoothDataType"],
                            capture_output=True, text=True, timeout=120)
        names = parse_profiler(json.loads(sp.stdout or "{}"))
    except (subprocess.SubprocessError, ValueError) as e:
        # Names are cosmetic; the level is what matters. Say so and carry on.
        print("WARN: could not read Bluetooth names (%s); using registry names" % e)
    return [{"id": addr, "name": names.get(addr) or info["product"], "level": info["level"]}
            for addr, info in sorted(levels.items())]


# --------------------------------------------------------------------------
# History and state (private, outside the repo)
# --------------------------------------------------------------------------

def load_history(path=READINGS):
    """{id: {"name", "last_seen": datetime, "level", "level_at": datetime}}."""
    hist = {}
    if not os.path.exists(path):
        return hist
    with open(path) as f:
        for line in f:
            try:
                rec = json.loads(line)
                ts = dt.datetime.fromisoformat(rec["ts"])
            except (ValueError, KeyError):
                continue
            for d in rec.get("devices", []):
                if d.get("level") is None:
                    continue
                hist[d["id"]] = {"name": d.get("name") or "", "last_seen": ts,
                                 "level": d["level"], "level_at": ts}
    return hist


def append_reading(now, devices, path=READINGS):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    rec = {"ts": now.isoformat(timespec="seconds"),
           "devices": [d for d in devices if d["level"] is not None]}
    with open(path, "a") as f:
        f.write(json.dumps(rec) + "\n")


def load_state(path=STATE):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"nudged": {}}


def save_state(state, path=STATE):
    """Write to a temp file and rename over, so a reader never sees a half-written file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, path)


# --------------------------------------------------------------------------
# The decision (pure: no clock, no disk, no Reminders)
# --------------------------------------------------------------------------

def marker(kind, dev_id):
    return "%s %s %s]" % (MARK, kind, short_id(dev_id))


def decide(now, current, history, open_reminders, nudged, threshold=THRESHOLD,
           force_nudge=False):
    """Return the actions for this run.

    now             local datetime
    current         [{"id", "name", "level"}] read this run (level may be None)
    history         load_history() output BEFORE this run's reading is added
    open_reminders  [{"key": "<marker text>", "ref": <opaque>}] this script owns
    nudged          {"<kind>:<id>": "YYYY-MM-DD"} from state.json
    Actions: {"do": "create", "kind", "id", "key", "title", "body"} or
             {"do": "complete", "ref", "why"}.
    """
    actions = []
    open_keys = {r["key"] for r in open_reminders}
    today = now.date().isoformat()

    # Merge this run's readings over history: freshest known level per device.
    known = {k: dict(v) for k, v in history.items()}
    for d in current:
        if d["level"] is None:
            continue
        known[d["id"]] = {"name": d["name"], "last_seen": now, "level": d["level"], "level_at": now}
    read_now = {d["id"] for d in current if d["level"] is not None}

    # 1. Close what is no longer true. Only on a reading taken THIS run, so a
    #    silent device never closes its own reminder.
    for r in open_reminders:
        m = re.match(re.escape(MARK) + r" (low|missing) ([0-9a-f]{4})\]", r["key"])
        if not m:
            continue
        kind, sid = m.groups()
        dev = next((i for i in read_now if short_id(i) == sid), None)
        if dev is None:
            continue
        if kind == "missing":
            actions.append({"do": "complete", "ref": r["ref"], "why": "seen again"})
        elif known[dev]["level"] > threshold:
            actions.append({"do": "complete", "ref": r["ref"],
                            "why": "now %d%%" % known[dev]["level"]})

    # 2. Nudge, once per device per evening, only in the evening window.
    if not force_nudge and (now.hour, now.minute) < NUDGE_AT:
        return actions
    for dev_id, k in sorted(known.items()):
        age_h = (now - k["last_seen"]).total_seconds() / 3600
        name = display_name(k["name"])
        if age_h > FORGET_DAYS * 24:
            continue
        if age_h >= MISSING_HOURS:
            kind = "missing"
            title = "Check the %s: not seen for %d days" % (name, int(age_h // 24))
            body = ("The Mac mini has not heard from it since %s. Switch it on or "
                    "charge it. This ticks itself off once it is seen again."
                    % k["last_seen"].strftime("%a %d %b %H:%M"))
        elif (now - k["level_at"]).total_seconds() / 3600 <= FRESH_HOURS and k["level"] <= threshold:
            kind = "low"
            title = "Charge the %s tonight (%d%%)" % (name, k["level"])
            body = ("Plug it in overnight. This ticks itself off once it reads above %d%%."
                    % threshold)
        else:
            continue
        key = marker(kind, dev_id)
        if key in open_keys:
            continue
        if not force_nudge and nudged.get("%s:%s" % (kind, dev_id)) == today:
            continue
        actions.append({"do": "create", "kind": kind, "id": dev_id, "key": key,
                        "title": title, "body": body + " " + key})
    return actions


def alert_time(now):
    """The 21:30 alert; two minutes from now if 21:30 is under a minute away or past."""
    at = now.replace(hour=ALERT_AT[0], minute=ALERT_AT[1], second=0, microsecond=0)
    if (at - now).total_seconds() < 60:
        at = (now + dt.timedelta(minutes=2)).replace(second=0, microsecond=0)
    return at


# --------------------------------------------------------------------------
# Apple Reminders (osascript; values passed as arguments, never spliced in)
# --------------------------------------------------------------------------

LIST_OPEN = r'''
on run argv
  set mk to item 1 of argv
  set out to {}
  tell application "Reminders"
    repeat with r in (reminders whose completed is false and body contains mk)
      set end of out to (id of r) & tab & (body of r)
    end repeat
  end tell
  set AppleScript's text item delimiters to linefeed
  return out as text
end run
'''

CREATE = r'''
on run argv
  set t to item 1 of argv
  set b to item 2 of argv
  set ln to item 3 of argv
  -- An exact local time, built field by field so no date string is parsed
  -- (date strings follow the Mac's language settings). Day 1 first, so moving
  -- the month never overflows (31 Oct -> "31 Nov" would roll into December).
  set d to current date
  set day of d to 1
  set year of d to (item 4 of argv) as integer
  set month of d to (item 5 of argv) as integer
  set day of d to (item 6 of argv) as integer
  set time of d to (item 7 of argv) as integer
  tell application "Reminders"
    set r to make new reminder at end of list ln with properties {name:t, body:b, due date:d, remind me date:d}
    return id of r
  end tell
end run
'''

COMPLETE = r'''
on run argv
  -- Straight to the reminder by id. A "whose id is" search walks every
  -- reminder in every list and took about 40 seconds each (28 Sep 2026).
  tell application "Reminders"
    set completed of reminder id (item 1 of argv) to true
  end tell
end run
'''


def osa(script, *args):
    p = subprocess.run(["/usr/bin/osascript", "-e", script, *args],
                       capture_output=True, text=True, timeout=120)
    if p.returncode != 0:
        raise RuntimeError("Reminders: %s" % p.stderr.strip())
    return p.stdout.strip()


def open_reminders():
    rows = []
    for line in osa(LIST_OPEN, MARK).splitlines():
        if "\t" not in line:
            continue
        rid, body = line.split("\t", 1)
        m = re.search(re.escape(MARK) + r" [a-z]+ [0-9a-f]{4}\]", body)
        if m:
            rows.append({"key": m.group(0), "ref": rid})
    return rows


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def cmd_read():
    devices = read_devices()
    if not devices:
        print("No Bluetooth devices with a battery are reporting right now.")
    for d in devices:
        level = "no reading" if d["level"] is None else "%d%%" % d["level"]
        print("%-20s %s" % (display_name(d["name"]), level))
    return 0


def cmd_run(argv):
    threshold = THRESHOLD
    if "--threshold" in argv:
        threshold = int(argv[argv.index("--threshold") + 1])
    force = "--force-nudge" in argv
    dry = "--dry-run" in argv

    now = dt.datetime.now()
    devices = read_devices()
    history = load_history()
    for d in devices:
        level = "no reading" if d["level"] is None else "%d%%" % d["level"]
        print("read  %-20s %s" % (display_name(d["name"]), level))
    if not devices:
        print("read  no Bluetooth devices with a battery are reporting")
    if not dry:
        append_reading(now, devices)

    state = load_state()
    actions = decide(now, devices, history, open_reminders(), state.get("nudged", {}),
                     threshold=threshold, force_nudge=force)
    at = alert_time(now)
    when = [str(at.year), str(at.month), str(at.day), str(at.hour * 3600 + at.minute * 60)]
    for a in actions:
        if a["do"] == "complete":
            print("%s ticked off a reminder (%s)" % ("WOULD" if dry else "DONE ", a["why"]))
            if not dry:
                osa(COMPLETE, a["ref"])
            continue
        title = ("TEST: " + a["title"]) if force else a["title"]
        print("%s reminder: %s" % ("WOULD" if dry else "MADE ", title))
        if not dry:
            osa(CREATE, title, a["body"], LIST_NAME, *when)
            if not force:
                state.setdefault("nudged", {})["%s:%s" % (a["kind"], a["id"])] = now.date().isoformat()
    if not actions:
        print("nothing to do")
    if not dry and not force:
        save_state(state)
    return 0


def selftest():
    now = dt.datetime(2026, 9, 28, 21, 25)
    K, M, T = "68:FE:F7:00:7D:04", "90:9C:4A:00:F9:1F", "20:3C:AE:00:B4:54"
    fails = []

    def check(label, got, want):
        if got != want:
            fails.append("%s: got %r want %r" % (label, got, want))

    def creates(actions):
        return sorted((a["kind"], a["id"]) for a in actions if a["do"] == "create")

    cur = [{"id": K, "name": "Magic Keyboard 2", "level": 100},
           {"id": M, "name": "Magic Mouse 2", "level": 18},
           {"id": T, "name": "Magic Trackpad 2", "level": 21}]
    check("low device at 21:25 gets one reminder", creates(decide(now, cur, {}, [], {})), [("low", M)])
    check("20% exactly counts as low",
          creates(decide(now, [{"id": M, "name": "Magic Mouse 2", "level": 20}], {}, [], {})), [("low", M)])
    check("nothing before 21:25", creates(decide(now.replace(hour=14), cur, {}, [], {})), [])
    check("force-nudge ignores the clock", creates(decide(now.replace(hour=14), cur, {}, [], {}, force_nudge=True)), [("low", M)])
    title = [a["title"] for a in decide(now, cur, {}, [], {}) if a["do"] == "create"]
    check("title is plain", title, ["Charge the Magic Mouse tonight (18%)"])

    openr = [{"key": marker("low", M), "ref": "r1"}]
    check("an open reminder is never duplicated", creates(decide(now, cur, {}, openr, {})), [])
    check("one nudge per device per evening",
          creates(decide(now, cur, {}, [], {"low:" + M: "2026-09-28"})), [])
    check("yesterday's nudge does not block tonight",
          creates(decide(now, cur, {}, [], {"low:" + M: "2026-09-27"})), [("low", M)])

    charged = [{"id": M, "name": "Magic Mouse 2", "level": 64}]
    acts = decide(now.replace(hour=9), charged, {}, openr, {})
    check("charged device ticks its reminder off", [(a["do"], a["ref"]) for a in acts], [("complete", "r1")])
    check("still low keeps its reminder",
          [a for a in decide(now.replace(hour=9), [{"id": M, "name": "x", "level": 19}], {}, openr, {})
           if a["do"] == "complete"], [])

    # A device that says nothing must never read as fine or close its reminder.
    silent = [{"id": M, "name": "Magic Mouse 2", "level": None}]
    check("blank reading closes nothing", decide(now.replace(hour=9), silent, {}, openr, {}), [])
    hist = {M: {"name": "Magic Mouse 2", "last_seen": now - dt.timedelta(hours=50),
                "level": 60, "level_at": now - dt.timedelta(hours=50)}}
    check("unseen 48h+ gets a not-seen reminder", creates(decide(now, silent, hist, [], {})), [("missing", M)])
    hist_old = {M: dict(hist[M], last_seen=now - dt.timedelta(days=31), level_at=now - dt.timedelta(days=31))}
    check("unseen 30 days is forgotten", creates(decide(now, [], hist_old, [], {})), [])
    missing_open = [{"key": marker("missing", M), "ref": "r2"}]
    acts = decide(now.replace(hour=9), charged, hist, missing_open, {})
    check("seen again ticks the not-seen reminder off", [(a["do"], a["ref"]) for a in acts], [("complete", "r2")])

    # Asleep at 21:25 but low an hour ago: still nudged off the last fresh reading.
    hist_low = {M: {"name": "Magic Mouse 2", "last_seen": now - dt.timedelta(hours=1),
                    "level": 15, "level_at": now - dt.timedelta(hours=1)}}
    check("recent low reading still nudges when asleep", creates(decide(now, [], hist_low, [], {})), [("low", M)])
    hist_stale = {M: dict(hist_low[M], last_seen=now - dt.timedelta(hours=30), level_at=now - dt.timedelta(hours=30))}
    check("a 30-hour-old low reading does not nudge as low", creates(decide(now, [], hist_stale, [], {})), [])

    # Parsers.
    raw = plistlib.dumps([
        {"DeviceAddress": "68-fe-f7-00-7d-04", "Product": "Someone's Keyboard", "BatteryPercent": 100, "Built-In": False},
        {"DeviceAddress": "90-9c-4a-00-f9-1f", "Product": "Magic Mouse 2", "BatteryPercent": "97", "Built-In": False},
        {"DeviceAddress": "aa-bb-cc-00-00-01", "Product": "Internal", "BatteryPercent": 50, "Built-In": True},
    ])
    levels = parse_ioreg(raw)
    check("ioreg keeps external devices only", sorted(levels), [K, M])
    check("a non-number level is None, not a guess", levels[M]["level"], None)
    names = parse_profiler({"SPBluetoothDataType": [{"device_connected": [
        {"Magic Keyboard 2": {"device_address": K}}]}]})
    check("profiler name by address", names, {K: "Magic Keyboard 2"})
    check("display name drops the generation", display_name("Magic Trackpad 2"), "Magic Trackpad")
    check("alert at 21:30 from the 21:25 run", alert_time(now), dt.datetime(2026, 9, 28, 21, 30))
    check("alert in two minutes once 21:30 has passed", alert_time(now.replace(hour=22, minute=5)),
          dt.datetime(2026, 9, 28, 22, 7))

    if fails:
        print("selftest FAILED")
        for f in fails:
            print("  " + f)
        return 1
    print("selftest OK")
    return 0


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd == "run":
        return cmd_run(sys.argv[2:])
    if cmd == "read":
        return cmd_read()
    if cmd == "selftest":
        return selftest()
    print(__doc__)
    return 64


if __name__ == "__main__":
    sys.exit(main())
