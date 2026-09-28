#!/usr/bin/env python3
"""home-battery.py — tell Kevin the evening a smart-home battery runs low or a device drops off.

WHY (Kevin, 28 Sep 2026)
------------------------
The Aqara Office camera (a G2H) fell off the network at 18:32 on 28 Sep and
nobody knew until Kevin noticed. 46 devices in Apple Home run on batteries
(37 Aqara, 8 Netatmo, 1 Bosch), and nothing watched any of them. Kevin chose
all three answers: Aqara's own app alerts, this nightly watch, and Home
Assistant for the other brands. This is the watch. It extends the Magic
battery nudge (scripts/magic-battery.py) and keeps its rules: Apple Reminders'
default list, 20% or below, a 21:30 alert, one reminder per problem.

WHERE THE NUMBERS COME FROM
---------------------------
Aqara's developer service (open-ger.aqara.com for a UK account):
  query.device.info    every device, with state 0 = offline, 1 = online
  query.resource.info  a model's resources, so the battery one is FOUND by its
                       description, never hard-coded per model
  query.resource.value the current battery reading
Apple Home keeps no battery level on disk (checked 28 Sep 2026: ZLOWBATTERY
and ZLASTSEENDATE are empty for all 127 accessories), and the Aqara hubs keep
passing a dead sensor's last reading to Home, so Home cannot be the source.

ABSENCE IS REPORTED, NEVER SILENT
---------------------------------
- A device Aqara marks offline for 2 hours gets its own reminder.
- A failed read, an expired sign-in or an empty device list is not "all
  clear": 24 hours without a good read gets a "watch cannot see" reminder.
- A device list that shrinks by more than a fifth against the last good read
  gets a reminder, so a half-answered read cannot pass as a full one.
- A battery device whose model offers no percentage is listed by `read` as
  "no level", never guessed from a voltage.

ONE NUDGE PER PROBLEM PER EVENING
---------------------------------
Reminders are made on the 21:20 run with a 21:30 alert, an open one is never
doubled, and a problem is nudged at most once per day. A reminder ticks itself
off only on a fresh reading that proves the problem is gone.

SECRETS AND PRIVACY
-------------------
Keys and sign-in tokens live only in ~/.config/od/aqara.json (mode 600),
written by `setup`, which Kevin runs himself: the sign-in code Aqara emails is
his to type. Readings and state live in ~/knowledge-os/logs/home-battery/.
Nothing identifying enters this public repo.

Usage:
  home-battery.py run [--threshold N] [--force-nudge] [--dry-run]
  home-battery.py read        print what Aqara reports now, change nothing
  home-battery.py setup       Kevin's one-off sign-in (asks for keys and the emailed code)
  home-battery.py selftest    offline checks of the decision rules
"""

import datetime as dt
import getpass
import hashlib
import json
import os
import re
import secrets
import string
import subprocess
import sys
import time
import urllib.error
import urllib.request

THRESHOLD = 20                 # nudge at this level or below (Kevin, 28 Sep 2026, same as Magic devices)
NUDGE_AT = (21, 20)            # the run that creates reminders (cron :20, clear of magic-battery at :25)
ALERT_AT = (21, 30)            # when the phone and watch ping
FRESH_HOURS = 24               # a battery reading older than this does not count as current
OFFLINE_HOURS = 2              # offline this long = its own reminder
BLIND_HOURS = 24               # no good read for this long = "the watch cannot see" reminder
SHRINK = 0.8                   # a list under 80% of the last good count is a partial read
LIST_NAME = "Reminders"        # Kevin's default list. Never "Captures": that feeds the brain.
MARK = "[home-battery"         # every reminder this script owns carries this in its notes

REGIONS = {"europe": "open-ger.aqara.com", "usa": "open-usa.aqara.com",
           "china": "open-cn.aqara.com", "korea": "open-kr.aqara.com",
           "russia": "open-ru.aqara.com", "singapore": "open-sg.aqara.com"}
TOKEN_VALIDITY = "30d"         # the longest Aqara allows; the refresh token lasts 30 days past it
REFRESH_DAYS = 7               # renew the token once fewer days than this remain
PAGE = 50                      # query.device.info page size (Aqara's default)
CHUNK = 50                     # devices per query.resource.value call

CONFIG = os.path.expanduser("~/.config/od/aqara.json")
LOGDIR = os.path.expanduser("~/knowledge-os/logs/home-battery")
READINGS = os.path.join(LOGDIR, "readings.jsonl")
STATE = os.path.join(LOGDIR, "state.json")


# --------------------------------------------------------------------------
# Aqara developer service
# --------------------------------------------------------------------------

class AqaraError(RuntimeError):
    pass


def sign(headers, app_key):
    """Aqara's signature: the header fields in ASCII order as k=v joined by &,
    the app key appended, all lower-cased, MD5. Accesstoken only when present."""
    keys = [k for k in ("Accesstoken", "Appid", "Keyid", "Nonce", "Time") if headers.get(k)]
    raw = "&".join("%s=%s" % (k, headers[k]) for k in keys) + app_key
    return hashlib.md5(raw.lower().encode()).hexdigest()


def call(cfg, intent, data, token=True):
    """One request. Returns `result`. Raises AqaraError on any non-zero code."""
    headers = {"Appid": cfg["appId"], "Keyid": cfg["keyId"],
               "Nonce": "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(16)),
               "Time": str(int(time.time() * 1000)), "Lang": "en"}
    if token:
        headers["Accesstoken"] = cfg["accessToken"]
    headers["Sign"] = sign(headers, cfg["appKey"])
    headers["Content-Type"] = "application/json"
    url = "https://%s/v3.0/open/api" % REGIONS[cfg.get("region", "europe")]
    req = urllib.request.Request(url, data=json.dumps({"intent": intent, "data": data}).encode(),
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.loads(r.read().decode())
    except (urllib.error.URLError, ValueError, OSError) as e:
        raise AqaraError("%s: no answer from Aqara (%s)" % (intent, e))
    if body.get("code") != 0:
        raise AqaraError("%s: Aqara said %s %s" % (intent, body.get("code"), body.get("message")))
    return body.get("result")


def load_config(path=CONFIG):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_config(cfg, path=CONFIG):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=1)
    os.replace(tmp, path)


def keep_token(cfg, result, now_ts):
    cfg["accessToken"] = result["accessToken"]
    cfg["refreshToken"] = result["refreshToken"]
    cfg["expiresAt"] = int(now_ts + int(result["expiresIn"]))


def fresh_token(cfg, now_ts=None):
    """Renew the access token when under REFRESH_DAYS remain. Saves the config."""
    now_ts = now_ts or time.time()
    if cfg.get("expiresAt", 0) - now_ts > REFRESH_DAYS * 86400:
        return cfg
    result = call(cfg, "config.auth.refreshToken", {"refreshToken": cfg["refreshToken"]}, token=False)
    keep_token(cfg, result, now_ts)
    save_config(cfg)
    return cfg


def pick_battery_resource(resources):
    """The resource that reports battery as a percentage, or None.

    Found by its description so a new model needs no code change. A voltage-only
    battery resource is NOT picked: a percentage guessed from millivolts would be
    acted on as if it were read.
    """
    best = None
    for r in resources or []:
        text = " ".join(str(r.get(k) or "") for k in ("name", "description")).lower()
        unit = str(r.get("unit") or "").strip().lower()
        if "battery" not in text or "volt" in text or unit in ("mv", "v"):
            continue
        if unit == "%" or "percent" in text or "level" in text:
            return r.get("resourceId")
        best = best or r.get("resourceId")
    return best


def read_aqara(cfg, resource_cache):
    """Every device Aqara knows: [{"id","name","model","online","level","battery"}].

    resource_cache {model: resourceId or ""} is filled in place, so each model's
    resource list is fetched once. Raises AqaraError on any failed call.
    """
    devices, page = [], 1
    while True:
        res = call(cfg, "query.device.info", {"pageNum": page, "pageSize": PAGE}) or {}
        rows = res.get("data") or []
        devices.extend(rows)
        total = int(res.get("totalCount") or 0)
        if not rows or len(devices) >= total:
            break
        page += 1
    for d in devices:
        m = d.get("model") or ""
        if m and m not in resource_cache:
            info = call(cfg, "query.resource.info", {"model": m}) or []
            resource_cache[m] = pick_battery_resource(info if isinstance(info, list) else []) or ""
    wanted = [{"subjectId": d["did"], "resourceIds": [resource_cache[d["model"]]]}
              for d in devices if resource_cache.get(d.get("model") or "")]
    values = {}
    for i in range(0, len(wanted), CHUNK):
        for v in call(cfg, "query.resource.value", {"resources": wanted[i:i + CHUNK]}) or []:
            values[v.get("subjectId")] = v.get("value")
    out = []
    for d in devices:
        battery = bool(resource_cache.get(d.get("model") or ""))
        out.append({"id": "aqara:" + d["did"], "name": d.get("deviceName") or d.get("model") or "Aqara device",
                    "model": d.get("model") or "", "online": parse_state(d.get("state")),
                    "battery": battery, "level": parse_level(values.get(d["did"])) if battery else None})
    return out


def parse_state(state):
    """1 online, 0 offline, anything else unknown (None), never assumed online."""
    try:
        return {1: True, 0: False}.get(int(state))
    except (TypeError, ValueError):
        return None


def parse_level(value):
    """A whole number 0-100 or None. Aqara sends values as strings."""
    try:
        level = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return level if 0 <= level <= 100 else None


# --------------------------------------------------------------------------
# History and state (private, outside the repo)
# --------------------------------------------------------------------------

def load_state(path=STATE):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state, path=STATE):
    """Temp file then rename, so a reader never sees a half-written file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, path)


def append_reading(now, devices, error, path=READINGS):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    rec = {"ts": now.isoformat(timespec="seconds"), "error": error, "devices": devices}
    with open(path, "a") as f:
        f.write(json.dumps(rec) + "\n")


def track(now, devices, state):
    """Fold this read into state: when each device went offline, its last level.

    state["devices"][id] = {"name", "offline_since", "level", "level_at"}.
    Returns the updated state (a new dict; the input is not changed).
    """
    st = {k: dict(v) for k, v in (state.get("devices") or {}).items()}
    iso = now.isoformat(timespec="seconds")
    for d in devices:
        s = st.setdefault(d["id"], {})
        s["name"] = d["name"]
        if d["online"] is False:
            s["offline_since"] = s.get("offline_since") or iso
        elif d["online"] is True:
            s.pop("offline_since", None)
        if d["level"] is not None:
            s["level"], s["level_at"] = d["level"], iso
    new = dict(state)
    new["devices"] = st
    return new


# --------------------------------------------------------------------------
# The decision (pure: no clock, no disk, no Reminders)
# --------------------------------------------------------------------------

def short_id(dev_id):
    return hashlib.sha1(dev_id.encode()).hexdigest()[:6]


def marker(kind, dev_id):
    return "%s %s %s]" % (MARK, kind, short_id(dev_id))


def decide(now, read_ok, devices, state, open_reminders, nudged, threshold=THRESHOLD,
           force_nudge=False):
    """Return this run's actions.

    now             local datetime
    read_ok         True when this run's read succeeded and passed the count check
    devices         this run's devices (empty when read_ok is False)
    state           track() output INCLUDING this run's read, plus
                    "last_ok" (iso) and "last_error" (text)
    open_reminders  [{"key": "<marker>", "ref": <opaque>}] this script owns
    nudged          {"<kind>:<id>": "YYYY-MM-DD"}
    Actions: {"do": "create", "kind", "id", "key", "title", "body"} or
             {"do": "complete", "ref", "why"}.
    """
    actions = []
    open_keys = {r["key"]: r["ref"] for r in open_reminders}
    today = now.date().isoformat()
    tracked = state.get("devices") or {}
    by_sid = {short_id(d["id"]): d for d in devices}

    # 1. Close what a fresh read proves is no longer true.
    for r in open_reminders:
        m = re.match(re.escape(MARK) + r" (low|offline|blind) ([0-9a-f]{6})\]", r["key"])
        if not m:
            continue
        kind, sid = m.groups()
        if kind == "blind":
            if read_ok:
                actions.append({"do": "complete", "ref": r["ref"], "why": "Aqara answering again"})
            continue
        d = by_sid.get(sid) if read_ok else None
        if d is None:
            continue
        if kind == "offline" and d["online"] is True:
            actions.append({"do": "complete", "ref": r["ref"], "why": "back online"})
        elif kind == "low" and d["level"] is not None and d["level"] > threshold:
            actions.append({"do": "complete", "ref": r["ref"], "why": "now %d%%" % d["level"]})

    # 2. Nudge, once per problem per evening, only in the evening window.
    if not force_nudge and (now.hour, now.minute) < NUDGE_AT:
        return actions
    wanted = []
    last_ok = state.get("last_ok")
    blind_h = None if not last_ok else (now - dt.datetime.fromisoformat(last_ok)).total_seconds() / 3600
    if not read_ok and (blind_h is None or blind_h >= BLIND_HOURS):
        since = "it was set up" if blind_h is None else "%d hours" % blind_h
        wanted.append(("blind", "watch", "The home battery watch cannot see Aqara",
                       "No good read for %s. Last error: %s. If it says sign-in, run the Aqara "
                       "sign-in on the Mac mini desktop. Until this ticks off, no battery or "
                       "offline device can be flagged." % (since, state.get("last_error") or "none")))
    for d in devices:
        t = tracked.get(d["id"]) or {}
        name = d["name"]
        since = t.get("offline_since")
        if d["online"] is False and since:
            gone = dt.datetime.fromisoformat(since)
            if (now - gone).total_seconds() / 3600 >= OFFLINE_HOURS:
                wanted.append(("offline", d["id"], "%s is offline" % name,
                               "Aqara has not heard from it since %s. Check its power, then "
                               "re-pair it in the Aqara app if it stays off. This ticks itself "
                               "off once it is back online." % gone.strftime("%a %d %b %H:%M")))
                continue
        lv, at = t.get("level"), t.get("level_at")
        if d["battery"] and lv is not None and at and lv <= threshold and \
                (now - dt.datetime.fromisoformat(at)).total_seconds() / 3600 <= FRESH_HOURS:
            wanted.append(("low", d["id"], "Battery low: %s (%d%%)" % (name, lv),
                           "Change or charge its battery. This ticks itself off once it "
                           "reads above %d%%." % threshold))
    for kind, dev_id, title, body in wanted:
        key = marker(kind, dev_id)
        if key in open_keys:
            continue
        if not force_nudge and nudged.get("%s:%s" % (kind, dev_id)) == today:
            continue
        actions.append({"do": "create", "kind": kind, "id": dev_id, "key": key,
                        "title": title, "body": body + " " + key})
    return actions


def count_ok(devices, last_count):
    """(ok, why). Zero devices, or under SHRINK of the last good count, is a partial read."""
    if not devices:
        return False, "Aqara returned no devices"
    if last_count and len(devices) < SHRINK * last_count:
        return False, "Aqara listed %d devices, %d last time" % (len(devices), last_count)
    return True, ""


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
  -- An exact local time, built field by field so no date string is parsed.
  -- Day 1 first, so moving the month never overflows.
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
  -- Straight to the reminder by id; a "whose id is" search took about 40 s each.
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
        m = re.search(re.escape(MARK) + r" [a-z]+ [0-9a-f]{6}\]", body)
        if m:
            rows.append({"key": m.group(0), "ref": rid})
    return rows


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def describe(d):
    state = {True: "online", False: "OFFLINE", None: "state unknown"}[d["online"]]
    if not d["battery"]:
        level = "mains or no battery"
    else:
        level = "no level" if d["level"] is None else "%d%%" % d["level"]
    return "%-38s %-14s %s" % (d["name"][:38], state, level)


def read_once(state):
    """(devices, error). Never raises for an Aqara or config problem: it is data."""
    cfg = load_config()
    if not cfg or not cfg.get("accessToken"):
        return [], "not set up: run the Aqara sign-in on the Mac mini desktop"
    try:
        cfg = fresh_token(cfg)
        cache = state.setdefault("resources", {})
        return read_aqara(cfg, cache), ""
    except AqaraError as e:
        return [], str(e)


def cmd_read():
    devices, error = read_once(load_state())
    if error:
        print("ERROR: %s" % error)
        return 1
    batt = [d for d in devices if d["battery"]]
    print("%d devices, %d with a battery, %d offline" %
          (len(devices), len(batt), sum(1 for d in devices if d["online"] is False)))
    for d in sorted(devices, key=lambda x: (x["online"] is not False, not x["battery"], x["name"])):
        print(describe(d))
    return 0


def cmd_run(argv):
    threshold = THRESHOLD
    if "--threshold" in argv:
        threshold = int(argv[argv.index("--threshold") + 1])
    force = "--force-nudge" in argv
    dry = "--dry-run" in argv

    now = dt.datetime.now()
    state = load_state()
    devices, error = read_once(state)
    read_ok = not error
    if read_ok:
        read_ok, error = count_ok(devices, state.get("last_count"))
    if read_ok:
        state = track(now, devices, state)
        state["last_ok"] = now.isoformat(timespec="seconds")
        state["last_count"] = len(devices)
        state.pop("last_error", None)
        print("read  %d devices, %d offline, %d battery readings" %
              (len(devices), sum(1 for d in devices if d["online"] is False),
               sum(1 for d in devices if d["level"] is not None)))
    else:
        state["last_error"] = error
        devices = []
        # A failed read is reported, and the job still exits 0 so the evening
        # reminder is what raises it, not a launchd failure nobody reads.
        print("WARN: read failed: %s" % error)
    if not dry:
        append_reading(now, devices, error)

    actions = decide(now, read_ok, devices, state, open_reminders(), state.get("nudged", {}),
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


def cmd_setup():
    """Kevin's one-off sign-in. Asks for the developer keys and the emailed code."""
    print("Aqara sign-in for the home battery watch.\n")
    cfg = load_config() or {}
    if cfg.get("appId") and input("Keys already saved. Keep them? [Y/n] ").strip().lower() in ("", "y", "yes"):
        pass
    else:
        cfg["appId"] = input("App ID (from developer.aqara.com, your project): ").strip()
        cfg["keyId"] = input("Key ID: ").strip()
        cfg["appKey"] = getpass.getpass("App Key (hidden as you paste): ").strip()
    cfg["region"] = cfg.get("region") or "europe"
    cfg["account"] = input("Your Aqara account email [%s]: " % (cfg.get("account") or "")).strip() \
        or cfg.get("account", "")
    if not all(cfg.get(k) for k in ("appId", "keyId", "appKey", "account")):
        print("ERROR: something was left blank. Nothing saved.")
        return 1
    try:
        call(cfg, "config.auth.getAuthCode",
             {"account": cfg["account"], "accountType": 0, "accessTokenValidity": TOKEN_VALIDITY}, token=False)
        print("\nAqara has sent a code to %s. It lasts 10 minutes." % cfg["account"])
        code = input("Type the code here: ").strip()
        result = call(cfg, "config.auth.getToken",
                      {"authCode": code, "account": cfg["account"], "accountType": 0}, token=False)
    except AqaraError as e:
        print("ERROR: %s\nNothing saved. Check the keys and try again." % e)
        return 1
    keep_token(cfg, result, time.time())
    save_config(cfg)
    devices, error = read_once(load_state())
    if error:
        print("Signed in, but the first read failed: %s" % error)
        return 1
    print("\nDone. Aqara lists %d devices, %d with a battery. You can close this window."
          % (len(devices), sum(1 for d in devices if d["battery"])))
    return 0


def selftest():
    now = dt.datetime(2026, 9, 28, 21, 25)
    iso = lambda t: t.isoformat(timespec="seconds")
    fails = []

    def check(label, got, want):
        if got != want:
            fails.append("%s: got %r want %r" % (label, got, want))

    def creates(actions):
        return sorted((a["kind"], a["id"]) for a in actions if a["do"] == "create")

    def dev(i, online=True, level=None, battery=True, name=None):
        return {"id": i, "name": name or i, "model": "m", "online": online, "battery": battery, "level": level}

    def st(devs, offline_since=None, last_ok=None):
        s = track(now, devs, {})
        for d in devs:
            if offline_since and d["online"] is False:
                s["devices"][d["id"]]["offline_since"] = iso(offline_since)
        s["last_ok"] = iso(last_ok or now)
        return s

    # Signature: Aqara's own worked example (signGenerationRules, read 28 Sep 2026).
    # Its printed hash comes from the page's Java demo inputs, whose Keyid has no
    # "k." prefix; the prose example's "k." Keyid does not produce that hash.
    h = {"Accesstoken": "532cad73c5493193d63d367016b98b27", "Appid": "4e693d54d75db580a56d1263",
         "Keyid": "78784564654feda454557", "Nonce": "C6wuzd0Qguxzelhb", "Time": "1618914078668"}
    check("signature matches Aqara's example", sign(h, "gU7Qtxi4dWnYAdmudyxni52bWZ58b8uN"),
          "bfd8dd0e7c108353e6740d81e05982d8")
    no_tok = dict(h, Accesstoken="")
    check("no token means no Accesstoken in the signature", sign(no_tok, "k"),
          hashlib.md5(("Appid=%s&Keyid=%s&Nonce=%s&Time=%sk" % (h["Appid"], h["Keyid"], h["Nonce"], h["Time"])).lower().encode()).hexdigest())

    # Low battery.
    devs = [dev("a", level=12, name="Utility Motion"), dev("b", level=21), dev("c", level=20)]
    check("20% and below nudges, 21% does not", creates(decide(now, True, devs, st(devs), [], {})),
          [("low", "a"), ("low", "c")])
    check("title is plain", [a["title"] for a in decide(now, True, devs[:1], st(devs[:1]), [], {}) if a["do"] == "create"],
          ["Battery low: Utility Motion (12%)"])
    check("nothing before 21:20", creates(decide(now.replace(hour=14), True, devs, st(devs), [], {})), [])
    check("force-nudge ignores the clock", creates(decide(now.replace(hour=14), True, devs[:1], st(devs[:1]), [], {}, force_nudge=True)), [("low", "a")])
    check("an open reminder is never doubled",
          creates(decide(now, True, devs[:1], st(devs[:1]), [{"key": marker("low", "a"), "ref": "r"}], {})), [])
    check("one nudge per problem per evening",
          creates(decide(now, True, devs[:1], st(devs[:1]), [], {"low:a": "2026-09-28"})), [])
    mains = [dev("cam", level=None, battery=False)]
    check("a mains device is never 'low'", creates(decide(now, True, mains, st(mains), [], {})), [])

    # Offline.
    cam = [dev("cam", online=False, battery=False, name="Office Camera")]
    check("offline under 2 hours waits", creates(decide(now, True, cam, st(cam, now - dt.timedelta(minutes=90)), [], {})), [])
    acts = decide(now, True, cam, st(cam, now - dt.timedelta(hours=3)), [], {})
    check("offline 2 hours+ gets its own reminder", creates(acts), [("offline", "cam")])
    check("offline title is plain", [a["title"] for a in acts], ["Office Camera is offline"])
    check("state unknown is not offline", creates(decide(now, True, [dev("x", online=None)], st([dev("x", online=None)]), [], {})), [])
    s = track(now - dt.timedelta(hours=3), cam, {})
    s = track(now, cam, s)
    check("offline_since keeps the FIRST offline time",
          s["devices"]["cam"]["offline_since"], iso(now - dt.timedelta(hours=3)))
    check("coming back online clears offline_since",
          "offline_since" in track(now, [dev("cam", battery=False)], s)["devices"]["cam"], False)

    # Closing only on a fresh read that proves it.
    back = [dev("cam", battery=False)]
    openr = [{"key": marker("offline", "cam"), "ref": "r1"}]
    check("back online ticks it off", [(a["do"], a["ref"]) for a in decide(now.replace(hour=9), True, back, st(back), openr, {})],
          [("complete", "r1")])
    check("a failed read closes nothing device-level",
          [a for a in decide(now.replace(hour=9), False, [], {"last_ok": iso(now)}, openr, {}) if a["do"] == "complete"], [])
    lowr = [{"key": marker("low", "a"), "ref": "r2"}]
    check("a charged battery ticks it off",
          [a["ref"] for a in decide(now.replace(hour=9), True, [dev("a", level=90)], st([dev("a", level=90)]), lowr, {}) if a["do"] == "complete"], ["r2"])
    check("a blank level closes nothing",
          decide(now.replace(hour=9), True, [dev("a", level=None)], st([dev("a", level=None)]), lowr, {}), [])

    # Blind: the watch cannot see.
    acts = decide(now, False, [], {"last_ok": iso(now - dt.timedelta(hours=25)), "last_error": "x"}, [], {})
    check("25 hours without a good read raises its own reminder", creates(acts), [("blind", "watch")])
    check("a short outage waits", creates(decide(now, False, [], {"last_ok": iso(now - dt.timedelta(hours=3))}, [], {})), [])
    check("never set up is blind at once", creates(decide(now, False, [], {}, [], {})), [("blind", "watch")])
    blindr = [{"key": marker("blind", "watch"), "ref": "r3"}]
    check("a good read ticks the blind reminder off",
          [a["ref"] for a in decide(now.replace(hour=9), True, back, st(back), blindr, {}) if a["do"] == "complete"], ["r3"])

    # The count control.
    check("zero devices is a failed read", count_ok([], 60)[0], False)
    check("a list under 80% of last time is a failed read", count_ok([dev(str(i)) for i in range(40)], 60)[0], False)
    check("a normal list passes", count_ok([dev(str(i)) for i in range(59)], 60)[0], True)
    check("first ever read passes", count_ok([dev("a")], None)[0], True)

    # Parsers and the resource picker.
    check("state 1/0/other", [parse_state(1), parse_state("0"), parse_state(None), parse_state("x")], [True, False, None, None])
    check("level from a string", [parse_level("87"), parse_level(101), parse_level(""), parse_level(None)], [87, None, None, None])
    res = [{"resourceId": "8.0.2008", "name": "battery voltage", "unit": "mV"},
           {"resourceId": "8.0.2001", "name": "battery", "description": "Battery level percentage", "unit": "%"},
           {"resourceId": "3.1.85", "name": "motion"}]
    check("picks the percentage, not the voltage", pick_battery_resource(res), "8.0.2001")
    check("voltage only means no level, never a guess", pick_battery_resource(res[:1]), None)
    check("no battery resource at all", pick_battery_resource(res[2:]), None)
    check("alert at 21:30 from the evening run", alert_time(now), dt.datetime(2026, 9, 28, 21, 30))

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
    if cmd == "setup":
        return cmd_setup()
    if cmd == "selftest":
        return selftest()
    print(__doc__)
    return 64


if __name__ == "__main__":
    sys.exit(main())
