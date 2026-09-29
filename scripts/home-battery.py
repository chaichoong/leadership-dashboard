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
  query.resource.info  a model's resources, so the battery ones are FOUND by
                       their description, never hard-coded per model
  query.resource.value the current reading, with Aqara's own timestamp
Apple Home keeps no battery level on disk (checked 28 Sep 2026: ZLOWBATTERY
and ZLASTSEENDATE are empty for all 127 accessories), and the Aqara hubs keep
passing a dead sensor's last reading to Home, so Home cannot be the source.

A battery is read as a percentage, or failing that as Aqara's own low-battery
flag. A model that offers neither, or that Aqara will not describe, is still
watched for offline and named in one "no battery level" reminder, never
treated as mains and never given a level guessed from a voltage. A reading
counts while Aqara says the device is online, whatever its date (a battery
sitting at 15% may simply not have changed); for a device in any other state
only a reading Aqara dated within 24 hours counts. A pre-2020 date is a unit
mix-up and counts as undated.

ABSENCE IS REPORTED, NEVER SILENT (review of 28 Sep 2026 found each gap)
-------------------------------------------------------------------------
- A device Aqara marks offline for 2 hours gets its own reminder.
- A device that drops out of Aqara's list for 24 hours gets a "missing" one,
  again for each new disappearance.
- One model Aqara will not describe leaves the rest of the read intact, and a
  model described before keeps its last description through a one-off refusal.
- A battery level Aqara has not updated for over 7 days, or gave no date for, is still used, but is
  named in the "check these in the Aqara app" reminder rather than trusted
  silently. That reminder is made once per list; if a blip changes the list
  and closes it, the list is forgotten so it can be raised again.
- A read is only good when every page arrived (ids counted against Aqara's
  totalCount) and the list is at least 80% of the last good count.
- A failed read, an expired sign-in, or any reply in a shape this script does
  not expect is recorded as an error, never a crash: 12 hours without a good
  read gets a "watch cannot see" reminder. A failed evening read still nudges
  from the last good read if it is under 6 hours old.
- The hourly clock is allowed 15 minutes of slack, so a job that starts a few
  seconds late does not push a reminder to the next evening.

ONE NUDGE PER PROBLEM PER EVENING
---------------------------------
Reminders are made from the 21:20 run on, with a 21:30 alert. An open one is
never doubled, a problem is nudged at most once per day ("missing" only ever
once), and a reminder ticks itself off only on a fresh read that proves the
problem is gone.

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
import http.client
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
NUDGE_AT = (21, 20)            # reminders from this run on (cron :20, clear of magic-battery at :25)
ALERT_AT = (21, 30)            # when the phone and watch ping
SLACK_HOURS = 0.25             # an hourly job starting late must not miss a limit by seconds
FRESH_HOURS = 24               # a reading older than this (by Aqara's timestamp) is not current
OFFLINE_HOURS = 2              # offline this long = its own reminder
MISSING_HOURS = 24             # gone from Aqara's list this long = its own reminder
FORGET_DAYS = 30               # a device gone this long is no longer expected
BLIND_HOURS = 12               # no good read for this long = "the watch cannot see" reminder
FALLBACK_HOURS = 6             # a failed evening read nudges from a good read this recent
SHRINK = 0.8                   # a list under 80% of the last good count is a partial read
RESOURCE_DAYS = 1              # re-check each model's resource list this often
ONCE = ("missing", "nolevel")  # reminders made once, not every evening
LIST_NAME = "Reminders"        # Kevin's default list. Never "Captures": that feeds the brain.
MARK = "[home-battery"         # every reminder this script owns carries this in its notes

REGIONS = {"europe": "open-ger.aqara.com", "usa": "open-usa.aqara.com",
           "china": "open-cn.aqara.com", "korea": "open-kr.aqara.com",
           "russia": "open-ru.aqara.com", "singapore": "open-sg.aqara.com"}
TOKEN_VALIDITY = "30d"         # the longest Aqara allows; the refresh token lasts 30 days past it
REFRESH_DAYS = 7               # renew the token once fewer days than this remain
PAGE = 50                      # query.device.info page size (Aqara's default)
MAX_PAGES = 40                 # 2,000 devices: a loop past this is a broken reply, not a house
CHUNK = 50                     # devices per query.resource.value call

CONFIG = os.path.expanduser("~/.config/od/aqara.json")
HA_URL = "http://homeassistant.local"   # Home Assistant OS on the Mac mini serves on port 80
HA_TOKEN = os.path.expanduser("~/.config/od/homeassistant_token")   # "Home Assistant key.command"
NAMES = os.path.expanduser("~/.config/od/home-battery-names.json")  # private: serial -> "En Suite radiator valve"

# The two places the watch reads. Each has its own "cannot see" reminder, its own
# history and count control, and a reminder is only ever closed by its own source.
SOURCES = {
    "aq": {"label": "Aqara", "app": "the Aqara app",
           "fix": "double-click Aqara sign-in on the Mac mini desktop"},
    "ha": {"label": "Home Assistant", "app": "Home Assistant or the device's own app",
           "fix": "check Home Assistant is running on the Mac mini (homeassistant.local) and its key is saved"},
}
LOGDIR = os.path.expanduser("~/knowledge-os/logs/home-battery")
READINGS = os.path.join(LOGDIR, "readings.jsonl")
STATE = os.path.join(LOGDIR, "state.json")


# --------------------------------------------------------------------------
# Aqara developer service
# --------------------------------------------------------------------------

class ReadError(RuntimeError):
    pass


class AqaraError(ReadError):
    pass


def sign(headers, app_key):
    """Aqara's signature: the header fields in ASCII order as k=v joined by &,
    the app key appended, all lower-cased, MD5. Accesstoken only when present."""
    keys = [k for k in ("Accesstoken", "Appid", "Keyid", "Nonce", "Time") if headers.get(k)]
    raw = "&".join("%s=%s" % (k, headers[k]) for k in keys) + app_key
    return hashlib.md5(raw.lower().encode()).hexdigest()


def call(cfg, intent, data, token=True):
    """One request. Returns `result`. Raises AqaraError on any failure or odd reply."""
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
    except (urllib.error.URLError, http.client.HTTPException, ValueError, OSError) as e:
        raise AqaraError("%s: no usable answer from Aqara (%s)" % (intent, e))
    if not isinstance(body, dict):
        raise AqaraError("%s: Aqara replied with %s, not an object" % (intent, type(body).__name__))
    if body.get("code") != 0:
        raise AqaraError("%s: Aqara said %s %s" % (intent, body.get("code"), body.get("message")))
    return body.get("result")


def as_list(result, intent):
    """Aqara lists come bare or as {"data": [...]}. Anything else is an error, not empty."""
    if isinstance(result, list):
        return result
    if isinstance(result, dict) and isinstance(result.get("data"), list):
        return result["data"]
    raise AqaraError("%s: expected a list, got %s" % (intent, type(result).__name__))


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
    try:
        access, refresh, expires = result["accessToken"], result["refreshToken"], int(result["expiresIn"])
    except (TypeError, KeyError, ValueError):
        raise AqaraError("sign-in reply had no usable token: run the Aqara sign-in again")
    cfg["accessToken"], cfg["refreshToken"] = access, refresh
    cfg["expiresAt"] = int(now_ts + expires)


def fresh_token(cfg, now_ts=None):
    """Renew the access token when under REFRESH_DAYS remain. Saves the config."""
    now_ts = now_ts or time.time()
    if cfg.get("expiresAt", 0) - now_ts > REFRESH_DAYS * 86400:
        return cfg
    result = call(cfg, "config.auth.refreshToken", {"refreshToken": cfg.get("refreshToken", "")}, token=False)
    keep_token(cfg, result, now_ts)
    save_config(cfg)
    return cfg


def classify(resources):
    """What a model reports about its battery: {"battery", "pct", "flag"}.

    pct   a resource giving the battery as a percentage (unit % or "percent")
    flag  Aqara's own low-battery yes/no, used only when there is no percentage
    battery  True when ANY resource mentions a battery, even voltage only, so a
          battery device is never mistaken for a mains one
    Found by description, so a new model needs no code change. Nothing else is
    ever read as a level: a voltage or an alarm flag is not a percentage.
    """
    out = {"battery": False, "pct": None, "flag": None}
    for r in resources:
        if not isinstance(r, dict):
            continue
        text = " ".join(str(r.get(k) or "") for k in ("name", "description")).lower()
        unit = str(r.get("unit") or "").strip().lower()
        if "battery" not in text:
            continue
        out["battery"] = True
        if "volt" in text or unit in ("mv", "v"):
            continue
        if out["pct"] is None and (unit == "%" or "percent" in text):
            out["pct"] = r.get("resourceId")
        elif out["flag"] is None and "low" in text:
            out["flag"] = r.get("resourceId")
    return out


def model_info(cfg, model, cache, now):
    """classify() for a model, from a cache refreshed every RESOURCE_DAYS."""
    c = cache.get(model)
    if isinstance(c, dict) and c.get("at"):
        age = (now - dt.datetime.fromisoformat(c["at"])).total_seconds() / 86400
        if age < RESOURCE_DAYS:
            return c
    try:
        info = as_list(call(cfg, "query.resource.info", {"model": model}), "query.resource.info")
    except AqaraError as e:
        # One model Aqara will not describe must not blind the whole watch. A
        # model described before keeps its last description (a one-off refusal
        # must not flip it to unknown for a run); a model never described is
        # "battery unknown": still watched for offline, and named. Not cached,
        # so the next run asks again.
        if isinstance(c, dict) and "battery" in c:
            return c
        return {"battery": None, "pct": None, "flag": None, "error": str(e)}
    c = classify(info)
    c["at"] = now.isoformat(timespec="seconds")
    cache[model] = c
    return c


def read_aqara(cfg, cache, now):
    """Every device Aqara knows: [{"id","name","model","online","battery",
    "level","level_at","low_flag","flag_at"}]. Raises AqaraError on any failed
    call, a missing page, or a row with no id."""
    rows, page, total = [], 1, 0
    while True:
        res = call(cfg, "query.device.info", {"pageNum": page, "pageSize": PAGE})
        if not isinstance(res, dict):
            raise AqaraError("query.device.info: expected an object, got %s" % type(res).__name__)
        batch = as_list(res.get("data") if res.get("data") is not None else [], "query.device.info")
        total = int(res.get("totalCount") or 0)
        rows.extend(batch)
        # With a total, page until it is reached; without one, until a short page.
        done = len(rows) >= total if total else len(batch) < PAGE
        if not batch or done:
            break
        if page >= MAX_PAGES:
            raise AqaraError("query.device.info: still paging after %d pages" % MAX_PAGES)
        page += 1
    if any(not isinstance(d, dict) or not d.get("did") for d in rows):
        raise AqaraError("query.device.info: a device came back with no id")
    ids = {d["did"] for d in rows}
    if total and len(ids) != total:
        raise AqaraError("query.device.info: %d of %d devices arrived" % (len(ids), total))

    info = {d["did"]: model_info(cfg, d.get("model") or "", cache, now) if d.get("model") else
            {"battery": False, "pct": None, "flag": None} for d in rows}
    wanted = [{"subjectId": did, "resourceIds": [r for r in (i["pct"], i["flag"]) if r]}
              for did, i in info.items() if i["pct"] or i["flag"]]
    values = {}
    for n in range(0, len(wanted), CHUNK):
        for v in as_list(call(cfg, "query.resource.value", {"resources": wanted[n:n + CHUNK]}),
                         "query.resource.value"):
            if isinstance(v, dict):
                values[(v.get("subjectId"), v.get("resourceId"))] = (v.get("value"), v.get("timeStamp"))
    out = []
    for d in rows:
        i = info[d["did"]]
        level, level_at = values.get((d["did"], i["pct"]), (None, None)) if i["pct"] else (None, None)
        flag, flag_at = values.get((d["did"], i["flag"]), (None, None)) if i["flag"] else (None, None)
        out.append({"id": "aqara:" + d["did"], "name": d.get("deviceName") or d.get("model") or "Aqara device",
                    "model": d.get("model") or "", "online": parse_state(d.get("state")),
                    "battery": None if i["battery"] is None else bool(i["battery"]),
                    "level": parse_level(level), "level_at": stamp(level_at, now),
                    "low_flag": parse_flag(flag), "flag_at": stamp(flag_at, now)})
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


def parse_flag(value):
    """Aqara's low-battery flag: 1 low, 0 fine, anything else unknown."""
    return {"1": True, "0": False}.get(str(value).strip()) if value is not None else None


def stamp(ms, now):
    """Aqara's millisecond timestamp as local iso, or None (undated).

    A date before 2020 is a unit mix-up (seconds sent as milliseconds reads as
    1970), not a real reading date, so it counts as undated. Never 'now' by default.
    """
    try:
        t = dt.datetime.fromtimestamp(int(ms) / 1000)
    except (TypeError, ValueError, OverflowError, OSError):
        return None
    if t.year < 2020:
        return None
    return min(t, now).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# Home Assistant (local, on the Mac mini): tado, Yale, Bosch, Sonos and the rest
# --------------------------------------------------------------------------

class HAError(ReadError):
    pass


# One row per entity Home Assistant marks as a battery (device_class battery),
# with its device's name and every connectivity reading on the same device.
# Asked through /api/template because the plain REST API has no device links.
HA_TEMPLATE = r"""[{%- for s in states if s.attributes.device_class == 'battery' -%}
{%- set d = device_id(s.entity_id) -%}
{%- set conn = (device_entities(d) if d else []) | select('is_state_attr', 'device_class', 'connectivity') | map('states') | list -%}
{{ {"entity": s.entity_id, "device": ((device_attr(d, 'name_by_user') or device_attr(d, 'name')) if d else s.name) | default(s.name, true),
    "model": (device_attr(d, 'model') if d else '') | default('', true), "state": s.state,
    "unit": s.attributes.get('unit_of_measurement', ''), "changed": s.last_changed.isoformat(), "conn": conn} | to_json }}
{%- if not loop.last %},{% endif -%}
{%- endfor -%}]"""


def ha_time(iso):
    """HA's UTC timestamp as local naive iso, or None."""
    try:
        return dt.datetime.fromisoformat(iso).astimezone().replace(tzinfo=None).isoformat(timespec="seconds")
    except (TypeError, ValueError):
        return None


def ha_devices(rows, names):
    """HA template rows as watch devices. Pure, so the selftest can drive it.

    A % sensor gives a level, a battery binary sensor gives the low flag
    (on = low). Online comes from the device's connectivity sensor: any 'on'
    is online, all 'off' is offline, none is unknown. An unavailable battery
    reading is a battery with no level, never a guess. names maps a device
    name (tado serial) or entity id to a room name; two devices left with the
    same name get their entity added so a reminder never points at the wrong one.
    """
    if not isinstance(rows, list):
        raise HAError("Home Assistant: expected a list, got %s" % type(rows).__name__)
    out = []
    for r in rows:
        if not isinstance(r, dict) or not r.get("entity"):
            raise HAError("Home Assistant: a battery row came back with no entity")
        conn = [c for c in (r.get("conn") or []) if c in ("on", "off")]
        online = True if "on" in conn else (False if conn else None)
        state, entity = str(r.get("state")), r["entity"]
        level = flag = None
        if entity.startswith("binary_sensor."):
            flag = {"on": True, "off": False}.get(state)
        else:
            level = parse_level(state)
        at = ha_time(r.get("changed"))
        name = names.get(entity) or names.get(r.get("device") or "") or r.get("device") or entity
        out.append({"id": "ha:" + entity, "name": name, "model": r.get("model") or entity.split(".")[0],
                    "online": online, "battery": True,
                    "level": level, "level_at": at if level is not None else None,
                    "low_flag": flag, "flag_at": at if flag is not None else None})
    counts = {}
    for d in out:
        counts[d["name"]] = counts.get(d["name"], 0) + 1
    for d in out:
        if counts[d["name"]] > 1:
            d["name"] = "%s (%s)" % (d["name"], d["id"].split(".", 1)[-1])
    return out


def load_names(path=NAMES):
    try:
        with open(path) as f:
            n = json.load(f)
        return n if isinstance(n, dict) else {}
    except (OSError, ValueError):
        return {}


def read_ha(now):
    """(devices, error), or None when Home Assistant is not set up (no key file).
    Never raises: a failure is data for the 'cannot see' reminder."""
    try:
        with open(HA_TOKEN) as f:
            token = f.read().strip()
    except OSError:
        return None
    if not token:
        return [], "the Home Assistant key file is empty: run Home Assistant key on the desktop again"
    req = urllib.request.Request(HA_URL + "/api/template", data=json.dumps({"template": HA_TEMPLATE}).encode(),
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            rows = json.loads(r.read().decode())
        return ha_devices(rows, load_names()), ""
    except urllib.error.HTTPError as e:
        why = "the key was refused: make a new one and run Home Assistant key" if e.code == 401 else "HTTP %s" % e.code
        return [], "Home Assistant: %s" % why
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as e:
        return [], "Home Assistant: no usable answer (%s)" % e
    except HAError as e:
        return [], str(e)
    except Exception as e:  # an unexpected shape: recorded and reminded about, never a crash
        return [], "unexpected reply from Home Assistant (%s: %s)" % (type(e).__name__, e)


# --------------------------------------------------------------------------
# History and state (private, outside the repo)
# --------------------------------------------------------------------------

def load_state(path=STATE):
    try:
        with open(path) as f:
            s = json.load(f)
        return migrate(s if isinstance(s, dict) else {})
    except (OSError, ValueError):
        return migrate({})


def migrate(s):
    """{"nudged", "sources": {"aq": {...}, "ha": {...}}}. The one-source layout
    of 28 Sep 2026 (everything at the top) moves under "aq" unchanged."""
    if "sources" in s:
        s.setdefault("nudged", {})
        return s
    old = {k: v for k, v in s.items() if k != "nudged"}
    return {"nudged": s.get("nudged") or {}, "sources": {"aq": old} if old else {}}


def save_state(state, path=STATE):
    """Temp file then rename, so a reader never sees a half-written file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, path)


def append_reading(now, devices, error, src="aq", path=READINGS):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    rec = {"ts": now.isoformat(timespec="seconds"), "source": src, "error": error, "devices": devices}
    with open(path, "a") as f:
        f.write(json.dumps(rec) + "\n")


def track(now, devices, state):
    """Fold a GOOD read into state. Returns a new state; the input is unchanged.

    state["devices"][id] = {"name", "battery", "online", "last_seen", "offline_since",
                            "level", "level_at", "low_flag", "flag_at"}
    offline_since keeps the FIRST time the device was seen offline. A level is
    kept even when Aqara gave no usable date (level_at None). A device seen
    again loses its "missing" nudge, so a second disappearance is reported.
    """
    st = {k: dict(v) for k, v in (state.get("devices") or {}).items()}
    iso = now.isoformat(timespec="seconds")
    for d in devices:
        s = st.setdefault(d["id"], {})
        s["name"], s["battery"], s["online"], s["last_seen"] = d["name"], d["battery"], d["online"], iso
        if d["online"] is False:
            s["offline_since"] = s.get("offline_since") or iso
        elif d["online"] is True:
            s.pop("offline_since", None)
        if d.get("level") is not None:
            s["level"], s["level_at"] = d["level"], d.get("level_at")
        if d.get("low_flag") is not None:
            s["low_flag"], s["flag_at"] = d["low_flag"], d.get("flag_at")
    new = dict(state)
    new["devices"] = st
    nudged = dict(state.get("nudged") or {})
    for d in devices:
        nudged.pop("missing:%s" % d["id"], None)
    new["nudged"] = nudged
    return new


def from_state(state):
    """The last good read, rebuilt for a failed evening read to nudge from.

    Only devices IN that read: one that left Aqara's list weeks ago keeps its
    old offline time for ever and must not be nudged as offline again."""
    out = []
    for i, s in (state.get("devices") or {}).items():
        if not state.get("last_ok") or s.get("last_seen") != state["last_ok"]:
            continue
        out.append({"id": i, "name": s.get("name") or "Aqara device", "battery": s.get("battery"),
                    "online": False if s.get("offline_since") else None,
                    "level": None, "low_flag": None})
    return out


# --------------------------------------------------------------------------
# The decision (pure: no clock, no disk, no Reminders)
# --------------------------------------------------------------------------

def short_id(dev_id):
    return hashlib.sha1(dev_id.encode()).hexdigest()[:6]


def marker(kind, dev_id, tag="aq"):
    return "%s %s %s %s]" % (MARK, kind, short_id(dev_id), tag)


def hours(now, iso):
    return (now - dt.datetime.fromisoformat(iso)).total_seconds() / 3600


def current(t, key, at_key, now):
    """Is the tracked reading usable? Yes while Aqara says the device is online,
    whatever the reading's date: a battery that sits at 15% may simply not have
    changed (review of 28 Sep 2026). Otherwise only when Aqara dated it fresh."""
    if t.get(key) is None:
        return False
    if t.get("online") is True:
        return True
    return bool(t.get(at_key)) and hours(now, t[at_key]) <= FRESH_HOURS


def is_low(t, now, threshold):
    """(known?, low?, text) from the tracked state."""
    if current(t, "level", "level_at", now):
        return True, t["level"] <= threshold, "%d%%" % t["level"]
    if current(t, "low_flag", "flag_at", now):
        return True, bool(t["low_flag"]), "low"
    return False, False, ""


STALE_DAYS = 7                 # a level Aqara has not updated this long is named, not only trusted


def no_level(devices, now=None):
    """Battery devices the watch cannot vouch for: a model Aqara would not
    describe, no readable level or flag, or (with now) a level Aqara dated over
    STALE_DAYS ago. Named in one reminder, never passed over as mains."""
    def stale(d):
        # Undated counts as stale: a level Aqara gives no date for cannot be
        # shown to be current, so it is named rather than trusted (review 4).
        return now is not None and d.get("level") is not None and \
            (not d.get("level_at") or hours(now, d["level_at"]) > STALE_DAYS * 24)
    return [d for d in devices if d["battery"] is None or
            (d["battery"] and ((d.get("level") is None and d.get("low_flag") is None) or stale(d)))]


def forget(state, kind, sid):
    """Drop the 'already reminded' mark for a closed once-only reminder, so the
    same list can be raised again if it comes back (review of 28 Sep 2026)."""
    nudged = state.get("nudged") or {}
    for k in [k for k in nudged if k.startswith(kind + ":") and short_id(k[len(kind) + 1:]) == sid]:
        del nudged[k]


def set_id(devices):
    return "set:" + ",".join(sorted(d["id"] for d in devices))


def decide(now, read_ok, devices, state, open_reminders, nudged, threshold=THRESHOLD,
           force_nudge=False, src="aq"):
    """Return this run's actions.

    now             local datetime
    read_ok         True when this run's read succeeded and passed the count checks
    devices         this run's devices; when the read failed, from_state() of a
                    recent good read, or empty
    state           track() output (including this run's read when good), plus
                    "last_ok" (iso) and "last_error" (text)
    open_reminders  [{"key": "<marker>", "ref": <opaque>}] this script owns
    nudged          {"<kind>:<id>": "YYYY-MM-DD"}
    src             the source this read came from ("aq" or "ha"): only its own
                    reminders are ever closed, and its texts name it
    Actions: {"do": "create", "kind", "id", "key", "title", "body"} or
             {"do": "complete", "ref", "why"}.
    """
    actions = []
    S = SOURCES[src]
    open_reminders = [r for r in open_reminders if r["key"].endswith(" %s]" % src)]
    open_keys = {r["key"] for r in open_reminders}
    today = now.date().isoformat()
    tracked = state.get("devices") or {}
    seen_now = {short_id(d["id"]): d for d in devices} if read_ok else {}
    unread = no_level(devices, now) if read_ok else []

    # 1. Close what a fresh, good read proves is no longer true.
    for r in open_reminders:
        m = re.match(re.escape(MARK) + r" (low|offline|missing|blind|nolevel) ([0-9a-f]{6}) [a-z]{2}\]", r["key"])
        if not m or not read_ok:
            continue
        kind, sid = m.groups()
        if kind == "blind":
            actions.append({"do": "complete", "ref": r["ref"], "why": "%s answering again" % S["label"]})
            continue
        if kind == "nolevel":
            if not unread or sid != short_id(set_id(unread)):
                actions.append({"do": "complete", "ref": r["ref"], "why": "the no-level list changed",
                                "forget": ("nolevel", sid)})
            continue
        d = seen_now.get(sid)
        if d is None:
            continue
        t = tracked.get(d["id"]) or {}
        known, low, _ = is_low(t, now, threshold)
        if kind == "missing":
            actions.append({"do": "complete", "ref": r["ref"], "why": "back in %s's list" % S["label"]})
        elif kind == "offline" and d["online"] is True:
            actions.append({"do": "complete", "ref": r["ref"], "why": "back online"})
        elif kind == "low" and known and not low:
            actions.append({"do": "complete", "ref": r["ref"], "why": "battery fine again"})

    # 2. Nudge, once per problem per evening, from the evening run on.
    if not force_nudge and (now.hour, now.minute) < NUDGE_AT:
        return actions
    wanted = []
    last_ok = state.get("last_ok")
    if not read_ok and (last_ok is None or hours(now, last_ok) >= BLIND_HOURS - SLACK_HOURS):
        gap = "since it was set up" if last_ok is None else "for %d hours" % hours(now, last_ok)
        wanted.append(("blind", "watch:" + src, "The home battery watch cannot see %s" % S["label"],
                       "No good read %s. Last error: %s. To fix: %s. Until this ticks off, no "
                       "battery or offline device from %s can be flagged."
                       % (gap, state.get("last_error") or "none", S["fix"], S["label"])))
    for d in devices:
        t = tracked.get(d["id"]) or {}
        since = t.get("offline_since")
        if d["online"] is False and since and hours(now, since) >= OFFLINE_HOURS - SLACK_HOURS:
            wanted.append(("offline", d["id"], "%s is offline" % d["name"],
                           "%s has not heard from it since about %s. Check its power, then "
                           "re-pair it in %s if it stays off. This ticks itself off once it is "
                           "back online." % (S["label"], dt.datetime.fromisoformat(since).strftime("%a %d %b %H:%M"),
                                              S["app"])))
            continue
        _, low, text = is_low(t, now, threshold) if d["battery"] else (False, False, "")
        if low:
            wanted.append(("low", d["id"], "Battery low: %s (%s)" % (d["name"], text),
                           "Change or charge its battery. This ticks itself off once %s "
                           "reports it fine again." % S["label"]))
    if read_ok:
        present = {d["id"] for d in devices}
        for i, t in sorted(tracked.items()):
            if i in present or not t.get("last_seen"):
                continue
            gone = hours(now, t["last_seen"])
            if MISSING_HOURS - SLACK_HOURS <= gone <= FORGET_DAYS * 24:
                wanted.append(("missing", i, "%s has vanished from %s" % (t.get("name") or "A device", S["label"]),
                               "%s stopped listing it %s. If you removed it on purpose, tick this "
                               "off; it will not come back. If not, re-add it in %s."
                               % (S["label"], dt.datetime.fromisoformat(t["last_seen"]).strftime("%a %d %b %H:%M"),
                                  S["app"])))
    if unread:
        names = ", ".join(sorted(d["name"] for d in unread)[:15]) + (" and more" if len(unread) > 15 else "")
        wanted.append(("nolevel", set_id(unread),
                       "Check %d battery device%s in %s" % (len(unread), "" if len(unread) == 1 else "s", S["app"]),
                       "%s gives no current battery level for these, so the watch can flag them "
                       "going offline but not running low: %s. This ticks itself off when the list "
                       "changes." % (S["label"], names)))
    for kind, dev_id, title, body in wanted:
        key = marker(kind, dev_id, src)
        if key in open_keys:
            continue
        done = nudged.get("%s:%s" % (kind, dev_id))
        if not force_nudge and (done == today or (kind in ONCE and done)):
            continue
        actions.append({"do": "create", "kind": kind, "id": dev_id, "key": key,
                        "title": title, "body": body + " " + key})
    return actions


def count_ok(devices, last_count, label="Aqara"):
    """(ok, why). Zero devices, or under SHRINK of the last good count, is a partial read."""
    if not devices:
        return False, "%s returned no devices" % label
    if last_count and len(devices) < SHRINK * last_count:
        return False, "%s listed %d devices, %d last time" % (label, len(devices), last_count)
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
        m = re.search(re.escape(MARK) + r" [a-z]+ [0-9a-f]{6} [a-z]{2}\]", body)
        if m:
            rows.append({"key": m.group(0), "ref": rid})
    return rows


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def describe(d, now):
    state = {True: "online", False: "OFFLINE", None: "state unknown"}[d["online"]]
    if d["battery"] is None:
        level = "battery unknown (Aqara would not describe this model)"
    elif not d["battery"]:
        level = "mains"
    elif d["level"] is not None:
        level = "%d%%" % d["level"]
        if d.get("level_at") and hours(now, d["level_at"]) > FRESH_HOURS:
            level += " (old reading, %s)" % d["level_at"][:10]
    elif d.get("low_flag") is not None:
        level = "battery LOW" if d["low_flag"] else "battery ok"
    else:
        level = "battery, no level"
    return "%-38s %-14s %s" % (d["name"][:38], state, level)


def read_once(state, now):
    """(devices, error). Never raises for an Aqara, config or reply-shape problem:
    those are data, and a crash would stop the evening 'cannot see' reminder."""
    cfg = load_config()
    if not cfg or not cfg.get("accessToken"):
        return [], "not set up: double-click Aqara sign-in on the Mac mini desktop"
    try:
        cfg = fresh_token(cfg)
        cache = state.setdefault("resources", {})
        return read_aqara(cfg, cache, now), ""
    except AqaraError as e:
        return [], str(e)
    except Exception as e:  # an unexpected reply shape: recorded, reminded about, never a crash
        return [], "unexpected reply from Aqara (%s: %s)" % (type(e).__name__, e)


def read_source(tag, sstate, now):
    """(devices, error) for one source, or None when that source is not set up."""
    if tag == "aq":
        return read_once(sstate, now)
    return read_ha(now)


def cmd_read():
    now = dt.datetime.now()
    state, bad = load_state(), 0
    for tag, S in SOURCES.items():
        got = read_source(tag, state["sources"].setdefault(tag, {}), now)
        if got is None:
            print("== %s: not set up" % S["label"])
            continue
        devices, error = got
        if error:
            print("== %s: ERROR: %s" % (S["label"], error))
            bad += 1
            continue
        batt = [d for d in devices if d["battery"]]
        print("== %s: %d devices, %d with a battery, %d offline, %d battery devices give no level" %
              (S["label"], len(devices), len(batt), sum(1 for d in devices if d["online"] is False),
               len(no_level(devices, now))))
        for d in sorted(devices, key=lambda x: (x["online"] is not False, not x["battery"], x["name"])):
            print(describe(d, now))
    return 1 if bad else 0


def cmd_run(argv):
    threshold = THRESHOLD
    if "--threshold" in argv:
        threshold = int(argv[argv.index("--threshold") + 1])
    force = "--force-nudge" in argv
    dry = "--dry-run" in argv

    now = dt.datetime.now()
    state = load_state()
    reminders = open_reminders()
    did = 0
    for tag, S in SOURCES.items():
        sstate = state["sources"].setdefault(tag, {})
        got = read_source(tag, sstate, now)
        if got is None:
            print("%s: not set up, skipped" % S["label"])
            continue
        devices, error = got
        read_ok = not error
        if read_ok:
            read_ok, error = count_ok(devices, sstate.get("last_count"), S["label"])
        if read_ok:
            merged = track(now, devices, dict(sstate, nudged=state["nudged"]))
            state["nudged"] = merged.pop("nudged")
            sstate = merged
            sstate["last_ok"] = now.isoformat(timespec="seconds")
            sstate["last_count"] = len(devices)
            sstate.pop("last_error", None)
            print("%s: read %d devices, %d offline, %d battery readings, %d battery devices give no level" %
                  (S["label"], len(devices), sum(1 for d in devices if d["online"] is False),
                   sum(1 for d in devices if d["level"] is not None or d.get("low_flag") is not None),
                   len(no_level(devices, now))))
            for d in no_level(devices, now):
                print("      no level: %s (%s)" % (d["name"], d["model"]))
        else:
            sstate["last_error"] = error
            # A failed read is reported, and the job still exits 0 so the evening
            # reminder is what raises it, not a launchd failure nobody reads.
            print("WARN: %s read failed: %s" % (S["label"], error))
            recent = sstate.get("last_ok") and hours(now, sstate["last_ok"]) < FALLBACK_HOURS
            devices = from_state(sstate) if recent else []
        state["sources"][tag] = sstate
        if not dry:
            append_reading(now, devices if read_ok else [], error, tag)
        actions = decide(now, read_ok, devices, sstate, reminders, state["nudged"],
                         threshold=threshold, force_nudge=force, src=tag)
        apply(actions, state, now, dry, force)
        did += len(actions)
    if not did:
        print("nothing to do")
    if not dry and not force:
        save_state(state)
    return 0


def apply(actions, state, now, dry, force, run=None):
    """Carry out decide()'s actions in Apple Reminders and record them in state.

    run is osa() in production; the selftest passes a fake to prove the state
    bookkeeping (nudged marks, forgetting a closed list) without Reminders.
    """
    run = run or osa
    at = alert_time(now)
    when = [str(at.year), str(at.month), str(at.day), str(at.hour * 3600 + at.minute * 60)]
    for a in actions:
        if a["do"] == "complete":
            print("%s ticked off a reminder (%s)" % ("WOULD" if dry else "DONE ", a["why"]))
            if not dry:
                run(COMPLETE, a["ref"])
                if a.get("forget"):
                    forget(state, *a["forget"])
            continue
        title = ("TEST: " + a["title"]) if force else a["title"]
        print("%s reminder: %s" % ("WOULD" if dry else "MADE ", title))
        if not dry:
            run(CREATE, title, a["body"], LIST_NAME, *when)
            if not force:
                state.setdefault("nudged", {})["%s:%s" % (a["kind"], a["id"])] = now.date().isoformat()


def cmd_setup():
    """Kevin's one-off sign-in. Asks for the developer keys and the emailed code."""
    print("Aqara sign-in for the home battery watch.\n")
    cfg = load_config() or {}
    if not (cfg.get("appId") and input("Keys already saved. Keep them? [Y/n] ").strip().lower() in ("", "y", "yes")):
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
        keep_token(cfg, result, time.time())
    except AqaraError as e:
        print("ERROR: %s\nNothing saved. Check the keys and try again." % e)
        return 1
    save_config(cfg)
    devices, error = read_once(load_state(), dt.datetime.now())
    if error:
        print("Signed in, but the first read failed: %s" % error)
        return 1
    print("\nDone. Aqara lists %d devices, %d with a battery. You can close this window."
          % (len(devices), sum(1 for d in devices if d["battery"])))
    return 0


def fake_read(now, n, total, bad_row=False, wrap=False, junk=False, refuse=None, cache=None):
    """read_aqara() against a fake Aqara, for the selftest and the vitest file.

    Devices cycle through three models: v = voltage-only sensor, p = percentage
    sensor at 15% read an hour ago, c = camera (no battery, offline).
    """
    global call
    kinds = ["v", "p", "c"]
    rows = [{"did": "%s%d" % (kinds[i % 3], i), "deviceName": "Device %d" % i, "model": "m." + kinds[i % 3],
             "state": 0 if kinds[i % 3] == "c" else 1} for i in range(n)]
    if bad_row:
        rows[0] = {"deviceName": "no id"}
    info = {"m.v": [{"resourceId": "8.0.2008", "name": "battery voltage", "unit": "mV"}],
            "m.p": [{"resourceId": "8.0.2001", "name": "battery", "description": "Battery percentage", "unit": "%"}],
            "m.c": [{"resourceId": "2.1.1", "name": "video"}]}
    ts = int((now - dt.timedelta(hours=1)).timestamp() * 1000)

    def fake(cfg, intent, data, token=True):
        if intent == "query.device.info":
            start = (data["pageNum"] - 1) * data["pageSize"]
            page = rows[start:start + data["pageSize"]] if (total is None or start < 50) else []
            return {"data": page, "totalCount": total} if total is not None else {"data": page}
        if intent == "query.resource.info":
            if data["model"] == refuse:
                raise AqaraError("query.resource.info: Aqara said 302 model not supported")
            return info[data["model"]]
        if intent == "query.resource.value":
            if junk:
                return "not a list"
            vals = [{"subjectId": r["subjectId"], "resourceId": rid, "value": "15", "timeStamp": ts}
                    for r in data["resources"] for rid in r["resourceIds"]]
            return {"data": vals} if wrap else vals
        raise AqaraError("unexpected intent %s" % intent)

    real, call = call, fake
    try:
        return read_aqara({}, cache if cache is not None else {}, now)
    finally:
        call = real


def selftest():
    now = dt.datetime(2026, 9, 28, 21, 20)
    iso = lambda t: t.isoformat(timespec="seconds")
    fails = []

    def check(label, got, want):
        if got != want:
            fails.append("%s: got %r want %r" % (label, got, want))

    def creates(actions):
        return sorted((a["kind"], a["id"]) for a in actions if a["do"] == "create")

    def dev(i, online=True, level=None, battery=True, name=None, flag=None, at=None):
        return {"id": i, "name": name or i, "model": "m", "online": online, "battery": battery,
                "level": level, "level_at": iso(at or now) if level is not None else None,
                "low_flag": flag, "flag_at": iso(at or now) if flag is not None else None}

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

    # Low battery, by percentage or by Aqara's flag, only on a fresh Aqara timestamp.
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
    mains = [dev("cam", battery=False)]
    check("a mains device is never 'low'", creates(decide(now, True, mains, st(mains), [], {})), [])
    flagged = [dev("f", flag=True, name="Door")]
    check("Aqara's low flag nudges when there is no percentage",
          [a["title"] for a in decide(now, True, flagged, st(flagged), [], {}) if a["do"] == "create"], ["Battery low: Door (low)"])
    old = [dev("o", level=5, at=now - dt.timedelta(hours=30))]
    check("an ONLINE device's old-dated level still counts (it may not have changed)",
          creates(decide(now, True, old, st(old), [], {})), [("low", "o")])
    unknown_old = [dev("u", online=None, level=5, at=now - dt.timedelta(hours=30))]
    check("an old level on a device of unknown state does not count",
          creates(decide(now, True, unknown_old, st(unknown_old), [], {})), [])
    undated = [dict(dev("n", level=9), level_at=None)]
    check("an undated level on an online device counts (and is also named)",
          creates(decide(now, True, undated, st(undated), [], {})), [("low", "n"), ("nolevel", "set:n")])
    check("a 1970 timestamp is undated, not a date", stamp(1790640000, now), None)

    # Offline, with slack for a late start.
    cam = [dev("cam", online=False, battery=False, name="Office Camera")]
    check("offline 90 minutes waits", creates(decide(now, True, cam, st(cam, now - dt.timedelta(minutes=90)), [], {})), [])
    late = now + dt.timedelta(seconds=5)
    check("offline 2 hours less a few seconds still counts",
          creates(decide(late, True, cam, st(cam, now - dt.timedelta(hours=2) + dt.timedelta(seconds=30)), [], {})), [("offline", "cam")])
    acts = decide(now, True, cam, st(cam, now - dt.timedelta(hours=3)), [], {})
    check("offline title is plain", [a["title"] for a in acts], ["Office Camera is offline"])
    unk = [dev("x", online=None, battery=False)]
    check("state unknown is not offline", creates(decide(now, True, unk, st(unk), [], {})), [])
    s = track(now - dt.timedelta(hours=3), cam, {})
    s = track(now, cam, s)
    check("offline_since keeps the FIRST offline time", s["devices"]["cam"]["offline_since"], iso(now - dt.timedelta(hours=3)))
    check("coming back online clears offline_since",
          "offline_since" in track(now, [dev("cam", battery=False)], s)["devices"]["cam"], False)

    # A failed evening read nudges from a recent good read, and closes nothing.
    s = track(now - dt.timedelta(hours=4), cam, {})
    s = track(now - dt.timedelta(hours=1), cam, s)
    s["last_ok"] = iso(now - dt.timedelta(hours=1))
    check("failed evening read still nudges a known-offline device",
          creates(decide(now, False, from_state(s), s, [], {})), [("offline", "cam")])
    openr = [{"key": marker("offline", "cam"), "ref": "r1"}]
    check("a failed read closes nothing", [a for a in decide(now.replace(hour=9), False, from_state(s), s, openr, {}) if a["do"] == "complete"], [])

    # Closing only on a fresh read that proves it.
    back = [dev("cam", battery=False)]
    check("back online ticks it off", [(a["do"], a["ref"]) for a in decide(now.replace(hour=9), True, back, st(back), openr, {})],
          [("complete", "r1")])
    lowr = [{"key": marker("low", "a"), "ref": "r2"}]
    check("a charged battery ticks it off",
          [a["ref"] for a in decide(now.replace(hour=9), True, [dev("a", level=90)], st([dev("a", level=90)]), lowr, {}) if a["do"] == "complete"], ["r2"])
    check("a blank level closes nothing",
          decide(now.replace(hour=9), True, [dev("a", level=None)], st([dev("a", level=None)]), lowr, {}), [])

    # Missing from Aqara's list.
    here = [dev("x", level=80)]
    s = st([dev("gone", name="Loft Motion", level=80)])
    s["devices"]["gone"]["last_seen"] = iso(now - dt.timedelta(hours=25))
    check("gone from the list 24 hours+ gets one reminder", creates(decide(now, True, here, s, [], {})), [("missing", "gone")])
    check("'missing' is only ever nudged once", creates(decide(now, True, here, s, [], {"missing:gone": "2026-09-01"})), [])
    back_again = track(now, [dev("gone", level=80)], dict(s, nudged={"missing:gone": "2026-09-01"}))
    check("a device seen again can be reported missing again", "missing:gone" in back_again["nudged"], False)
    s2 = dict(s, last_ok=iso(now - dt.timedelta(hours=1)))
    s2["devices"] = dict(s2["devices"], old={"name": "Old Cam", "battery": False, "offline_since": iso(now - dt.timedelta(days=20)),
                                              "last_seen": iso(now - dt.timedelta(days=20))})
    check("the fallback leaves out a device gone from the last good read", [d["id"] for d in from_state(s2)], [])

    # Battery devices Aqara gives no level for: one reminder per list, closed when it changes.
    nolev = [dev("v1", name="Blind"), dev("v2", name="Switch"), dev("p", level=80)]
    acts = decide(now, True, nolev, st(nolev), [], {})
    check("no-level battery devices get one reminder naming them",
          [(a["kind"], a["title"]) for a in acts if a["do"] == "create"], [("nolevel", "Check 2 battery devices in the Aqara app")])
    check("the no-level reminder is made once per list", creates(decide(now, True, nolev, st(nolev), [], {"nolevel:" + set_id(nolev[:2]): "2026-09-01"})), [])
    nolr = [{"key": marker("nolevel", set_id(nolev[:2])), "ref": "r5"}]
    fixed = [dev("v1", level=70), dev("v2", level=70)]
    check("the no-level reminder ticks off when the list changes",
          [a["ref"] for a in decide(now.replace(hour=9), True, fixed, st(fixed), nolr, {}) if a["do"] == "complete"], ["r5"])
    blip = [dict(dev("c9", battery=None))] + nolev
    closed = [a for a in decide(now.replace(hour=3), True, blip, st(blip), nolr, {}) if a["do"] == "complete"]
    check("a list change closes the reminder and forgets that list", [a.get("forget") for a in closed],
          [("nolevel", short_id(set_id(nolev[:2])))])
    calls, bk = [], {"nudged": {"nolevel:" + set_id(nolev[:2]): "2026-09-28"}}
    apply(closed, bk, now, False, False, run=lambda *a: calls.append(a[1:2]))
    check("closing a changed list in Reminders also forgets it", (calls, bk["nudged"]), ([("r5",)], {}))
    stt = {"nudged": {"nolevel:" + set_id(nolev[:2]): "2026-09-28", "low:a": "2026-09-28"}}
    forget(stt, "nolevel", short_id(set_id(nolev[:2])))
    check("forget drops only that list's mark", stt["nudged"], {"low:a": "2026-09-28"})
    check("after a blip the list can be raised again",
          creates(decide(now, True, nolev, st(nolev), [], stt["nudged"])), [("nolevel", set_id(nolev[:2]))])
    stale = [dev("s", level=60, at=now - dt.timedelta(days=8))]
    check("a level Aqara has not updated for a week is named", [d["id"] for d in no_level(stale, now)], ["s"])
    check("a level from yesterday is not", no_level([dev("s", level=60, at=now - dt.timedelta(days=1))], now), [])
    check("an undated level is named, not trusted silently",
          [d["id"] for d in no_level([dict(dev("nd", level=35), level_at=None)], now)], ["nd"])
    check("a model Aqara will not describe is listed, not passed as mains",
          [d["id"] for d in no_level([dict(dev("q"), battery=None)])], ["q"])
    check("a failed read never reports missing", [a["kind"] for a in decide(now, False, [], dict(s, last_ok=iso(now)), [], {}) if a["do"] == "create"], [])

    # Blind: the watch cannot see.
    acts = decide(now, False, [], {"last_ok": iso(now - dt.timedelta(hours=12) + dt.timedelta(seconds=40)), "last_error": "x"}, [], {})
    check("12 hours (less a late start) without a good read raises its own reminder", creates(acts), [("blind", "watch:aq")])
    check("blind text reads plainly", "No good read for 11 hours." in (acts[0]["body"] if acts else ""), True)
    check("a short outage waits", creates(decide(now, False, [], {"last_ok": iso(now - dt.timedelta(hours=3))}, [], {})), [])
    never = decide(now, False, [], {}, [], {})
    check("never set up is blind at once", creates(never), [("blind", "watch:aq")])
    check("never-set-up text reads plainly", "No good read since it was set up." in (never[0]["body"] if never else ""), True)
    blindr = [{"key": marker("blind", "watch"), "ref": "r3"}]
    check("a good read ticks the blind reminder off",
          [a["ref"] for a in decide(now.replace(hour=9), True, back, st(back), blindr, {}) if a["do"] == "complete"], ["r3"])

    # The count control.
    check("zero devices is a failed read", count_ok([], 60)[0], False)
    check("a list under 80% of last time is a failed read", count_ok([dev(str(i)) for i in range(40)], 60)[0], False)
    check("a normal list passes", count_ok([dev(str(i)) for i in range(59)], 60)[0], True)
    check("first ever read passes", count_ok([dev("a")], None)[0], True)

    # Parsers and the resource classifier.
    check("state 1/0/other", [parse_state(1), parse_state("0"), parse_state(None), parse_state("x")], [True, False, None, None])
    check("level from a string", [parse_level("87"), parse_level(101), parse_level(""), parse_level(None)], [87, None, None, None])
    check("flag 1/0/other", [parse_flag("1"), parse_flag(0), parse_flag("x"), parse_flag(None)], [True, False, None, None])
    res = [{"resourceId": "8.0.2008", "name": "battery voltage", "unit": "mV"},
           {"resourceId": "8.0.2001", "name": "battery", "description": "Battery level percentage", "unit": "%"},
           {"resourceId": "3.1.85", "name": "motion"}]
    check("picks the percentage, not the voltage", classify(res), {"battery": True, "pct": "8.0.2001", "flag": None})
    check("voltage only is still a battery device, with no level",
          classify(res[:1]), {"battery": True, "pct": None, "flag": None})
    check("a low-battery alarm is a flag, never a percentage",
          classify([{"resourceId": "13.1.85", "name": "low battery alarm"}]), {"battery": True, "pct": None, "flag": "13.1.85"})
    check("no battery resource at all is mains", classify(res[2:]), {"battery": False, "pct": None, "flag": None})
    check("list replies come bare or wrapped", [as_list([1], "x"), as_list({"data": [2]}, "x")], [[1], [2]])
    try:
        as_list("oops", "x")
        fails.append("a non-list reply must raise")
    except AqaraError:
        pass
    check("Aqara's timestamp dates the reading", stamp(1790640000000, now), iso(min(dt.datetime.fromtimestamp(1790640000), now)))
    check("no timestamp means no date, not now", stamp(None, now), None)
    check("alert at 21:30 from the evening run", alert_time(now), dt.datetime(2026, 9, 28, 21, 30))

    # The reader against a fake Aqara: every reply shape the 28 Sep review named.
    for label, want, kw in [
        ("a missing page is an error, never a short list", "50 of 62 devices arrived", {"n": 50, "total": 62}),
        ("no totalCount pages until a short page", 60, {"n": 60, "total": None}),
        ("a device row with no id is an error", "no id", {"n": 3, "total": 3, "bad_row": True}),
        ("a resource value reply wrapped in data is read", 3, {"n": 3, "total": 3, "wrap": True}),
        ("a resource value reply that is not a list is an error", "expected a list", {"n": 3, "total": 3, "junk": True}),
    ]:
        try:
            got = len(fake_read(now, **kw))
        except AqaraError as e:
            got = str(e)
        ok = got == want if isinstance(want, int) else isinstance(got, str) and want in got
        if not ok:
            fails.append("%s: got %r want %r" % (label, got, want))
    devs = {d["id"]: d for d in fake_read(now, n=3, total=3)}
    check("a voltage-only model is a battery device with no level",
          (devs["aqara:v0"]["battery"], devs["aqara:v0"]["level"]), (True, None))
    check("a percentage model reads its level and Aqara's date",
          (devs["aqara:p1"]["level"], devs["aqara:p1"]["level_at"]), (15, iso(now - dt.timedelta(hours=1))))
    check("a camera is mains and offline", (devs["aqara:c2"]["battery"], devs["aqara:c2"]["online"]), (False, False))
    try:
        devs = {d["id"]: d for d in fake_read(now, n=3, total=3, refuse="m.c")}
        got = (len(devs), devs["aqara:c2"]["battery"], devs["aqara:c2"]["online"], devs["aqara:p1"]["level"])
    except AqaraError as e:
        got = str(e)
    check("one model Aqara will not describe does not blind the read", got, (3, None, False, 15))
    cache = {}
    fake_read(now, n=3, total=3, cache=cache)
    cache["m.v"]["at"] = iso(now - dt.timedelta(days=2))
    devs = {d["id"]: d for d in fake_read(now, n=3, total=3, refuse="m.v", cache=cache)}
    check("a model described before keeps its description when refused once", devs["aqara:v0"]["battery"], True)

    # Home Assistant rows (shape read live from HA 2026.9.4 on 29 Sep 2026).
    rows = [
        {"entity": "binary_sensor.va1_battery", "device": "VA1", "model": "VA02", "state": "on", "unit": "",
         "changed": "2026-09-29T07:23:15.935505+00:00", "conn": ["on"]},
        {"entity": "binary_sensor.va2_battery", "device": "VA2", "model": "VA02", "state": "off", "unit": "",
         "changed": "2026-09-29T07:23:15+00:00", "conn": ["off"]},
        {"entity": "sensor.sonos_move_battery", "device": "Sonos Move", "model": "Move", "state": "100", "unit": "%",
         "changed": "2026-09-28T23:15:25+00:00", "conn": []},
        {"entity": "sensor.sonos_move_battery_2", "device": "Sonos Move", "model": "Move", "state": "unavailable",
         "unit": "%", "changed": "2026-09-28T23:15:25+00:00", "conn": []},
    ]
    ha = {d["id"]: d for d in ha_devices(rows, {"VA1": "En Suite radiator valve"})}
    check("a tado low flag reads as low, named by the private map, online by its connection",
          (ha["ha:binary_sensor.va1_battery"]["name"], ha["ha:binary_sensor.va1_battery"]["low_flag"],
           ha["ha:binary_sensor.va1_battery"]["online"]), ("En Suite radiator valve", True, True))
    check("a connection sensor reading off is offline", ha["ha:binary_sensor.va2_battery"]["online"], False)
    check("a percentage sensor reads its level, state unknown with no connection sensor",
          (ha["ha:sensor.sonos_move_battery"]["level"], ha["ha:sensor.sonos_move_battery"]["online"]), (100, None))
    check("unavailable is a battery with no level, never a guess",
          (ha["ha:sensor.sonos_move_battery_2"]["level"], ha["ha:sensor.sonos_move_battery_2"]["battery"]), (None, True))
    check("two devices with one name are told apart",
          sorted(d["name"] for d in ha.values() if d["name"].startswith("Sonos")),
          ["Sonos Move (sonos_move_battery)", "Sonos Move (sonos_move_battery_2)"])
    check("HA's UTC time becomes local", ha_time("2026-09-29T07:23:15+00:00"),
          dt.datetime(2026, 9, 29, 7, 23, 15, tzinfo=dt.timezone.utc).astimezone().replace(tzinfo=None).isoformat(timespec="seconds"))
    for label, bad in [("a non-list HA reply is an error", {"message": "x"}), ("an HA row with no entity is an error", [{"state": "on"}])]:
        try:
            ha_devices(bad, {})
            fails.append(label)
        except HAError:
            pass

    # Two sources never touch each other's reminders.
    va1 = [dict(dev("ha:binary_sensor.va1_battery", battery=True), low_flag=False, flag_at=iso(now))]
    other = [{"key": marker("blind", "watch:aq", "aq"), "ref": "aq-blind"},
             {"key": marker("low", "ha:binary_sensor.va1_battery", "ha"), "ref": "ha-low"},
             {"key": marker("blind", "watch:ha", "ha"), "ref": "ha-blind"}]
    closed = sorted(a["ref"] for a in decide(now.replace(hour=9), True, va1, st(va1), other, {}, src="ha") if a["do"] == "complete")
    check("an HA read closes only HA reminders", closed, ["ha-blind", "ha-low"])
    check("an Aqara read closes only Aqara reminders",
          sorted(a["ref"] for a in decide(now.replace(hour=9), True, back, st(back), other, {}, src="aq") if a["do"] == "complete"),
          ["aq-blind"])
    hb = decide(now, False, [], {}, [], {}, src="ha")
    check("each source has its own blind reminder", [(a["id"], a["title"]) for a in hb if a["do"] == "create"],
          [("watch:ha", "The home battery watch cannot see Home Assistant")])
    check("markers carry their source", marker("low", "x", "ha").endswith(" ha]"), True)

    # The 28 Sep one-source state moves under "aq" unchanged.
    old = {"last_ok": "2026-09-28T23:20:10", "resources": {"m": 1}, "nudged": {"low:a": "2026-09-28"}}
    check("old state migrates under aq", migrate(dict(old)),
          {"nudged": {"low:a": "2026-09-28"}, "sources": {"aq": {"last_ok": "2026-09-28T23:20:10", "resources": {"m": 1}}}})
    check("an empty state migrates cleanly", migrate({}), {"nudged": {}, "sources": {}})

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
