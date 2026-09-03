#!/usr/bin/env python3
"""Content Engine R1: the raw-footage folder watch for the Runpreneur 360 lane.

Kevin copies an SD card into the shared Drive folder once a month (~90 .insv clips, ~220 GB).
This script turns each new shooting DAY into ONE episode record (Long Form Video, New Upload) in
the Content Machine Runpreneur table and queues its clips for the render, oldest first. A day
usually holds two or three clips (the 4 June 2026 batch: 94 clips over 46 days); the AI director
(R4) decides which clip carries the talk, so the record is per episode day, not per clip.

Facts it relies on (measured 2-3 Sep 2026):
  - The Drive desktop client exposes each file's Drive id as the extended attribute
    `com.google.drivefs.item-id#S`, so the Raw File Link needs no API call.
  - Kevin's running streak started on 1 June 2020 = day 1 (Kevin, 3 Sep 2026), so the
    date-based day = (clip date - 2020-06-01) + 1: 4 Jul 2026 = 2225, which is what he says
    in that clip. He occasionally misstates the day, and after a missed day (camera flat,
    lightning) he records two episodes the next day, so render.py checks the spoken day
    against the date and applies the catch-up rule (see resolve_episode).
  - Drive streams a cold file at roughly 1 GB per 15 minutes and stalled on 2 GB+ clips, so the
    pull step copies ONE clip at a time to a local work folder and checks the byte count.
  - This Mac has ~60 GB free, so local copies are deleted after the render (R2) has its outputs.

State lives OUTSIDE the repo (the repo is public): ~/knowledge-os/logs/content-engine/ledger.json.

Usage:
  watch.py scan  [--create] [--batch NAME] [--since YYYY-MM-DD]   # find new clips, create records
  watch.py next  [--work DIR]                                      # pull the oldest queued clip
  watch.py report                                                  # one-line status for the digest
  watch.py selftest
"""
import argparse, datetime as dt, json, os, re, shutil, subprocess, sys, time, urllib.parse, urllib.request

RAW_ROOT = os.path.expanduser("~/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/Shared drives/Marketing/Runpreneur/Runpreneur - Raw Video")
LEDGER = os.path.expanduser("~/knowledge-os/logs/content-engine/ledger.json")
WORK = os.path.expanduser("~/knowledge-os/logs/content-engine/work")
PAT_FILE = os.path.expanduser("~/.config/od/airtable_pat")
BASE = "appnqjDpqDniH3IRl"
TABLE = "tblEPzZdwBZeSXFRB"
API = "https://api.airtable.com/v0/%s/%s" % (BASE, TABLE)
STREAK_START = dt.date(2020, 6, 1)      # day 1
SKIP_DIRS = ("Image", "Footage to be filed", "Time Urgency")
CLIP_RE = re.compile(r"^VID_(\d{4})(\d{2})(\d{2})_(\d{6})_00_(\d{3})\.insv$", re.I)
DEFAULT_SINCE = dt.date(2026, 6, 4)     # the batch Kevin approved the spike on; older batches are the team's


# ---------- pure helpers (selftested) ----------

def parse_clip(name):
    """VID_20260704_105737_00_064.insv -> (date, '105737', 64) or None."""
    m = CLIP_RE.match(name)
    if not m: return None
    y, mo, d, hms, seq = m.groups()
    return dt.date(int(y), int(mo), int(d)), hms, int(seq)


def streak_day(date):
    return (date - STREAK_START).days + 1


def resolve_episode(date_day, spoken_day, prev_day_has_talk=True):
    """Which episode a talk clip is. Returns (day, reason).
    - spoken == date day: normal.
    - spoken == date day - 1 and the previous day has no talk clip: a catch-up (he missed a day and
      recorded two the next day), so the clip IS the missed day's episode.
    - no spoken day: trust the date.
    - anything else: trust the date and say so; Kevin sometimes misspeaks the number."""
    if spoken_day is None: return date_day, "no spoken day, date used"
    if spoken_day == date_day: return date_day, "spoken day matches the date"
    if spoken_day == date_day - 1 and not prev_day_has_talk: return spoken_day, "catch-up for the missed previous day"
    return date_day, "spoken day %d disagrees with the date (%d); date used, flagged" % (spoken_day, date_day)


SPOKEN_DAY_RE = re.compile(r"\bday,?\s*([0-9][0-9,]{2,5})\b", re.I)


def spoken_day(transcript):
    """First 'day 2,225' / 'day 2225' in the opening of the transcript, or None."""
    m = SPOKEN_DAY_RE.search(transcript[:600])
    if not m: return None
    try: return int(m.group(1).replace(",", ""))
    except ValueError: return None


def drive_link(file_id):
    return "https://drive.google.com/file/d/%s/view" % file_id


def episode_name(day):
    return "Episode %d Full Episode" % day


def record_fields(day, clip_names, file_id, clip_date):
    names = [clip_names] if isinstance(clip_names, str) else list(clip_names)
    return {
        "Content Name": episode_name(day),
        "Category": "Runpreneur",
        "Content Type": "Long Form Video",
        "Record Status": "New Upload",
        "Raw File Link": drive_link(file_id),
        "Responsible": "Content Engine (AI)",
        "Feature": "360° Reframer",
        "Notes": "360 lane: shot %s, %d clip%s: %s" % (clip_date.isoformat(), len(names), "" if len(names) == 1 else "s", ", ".join(names)),
    }


def choose_next(ledger):
    """Oldest day first, then the SMALLEST clip of that day: the talk-to-camera clip is the short
    one (0.2-0.6 GB, 25-70 s) and the 4 GB ones are long run footage, so the episodes flow sooner."""
    cands = [(v["date"], v.get("size", 0), v["seq"], k) for k, v in ledger.items() if v.get("status") == "new"]
    return sorted(cands)[0][3] if cands else None


# ---------- IO ----------

def drive_id(path):
    try:
        out = subprocess.run(["xattr", "-p", "com.google.drivefs.item-id#S", path], capture_output=True, text=True)
        return out.stdout.strip() or None
    except Exception:
        return None


def load_ledger():
    if os.path.exists(LEDGER):
        return json.load(open(LEDGER))
    return {}


def save_ledger(ledger):
    os.makedirs(os.path.dirname(LEDGER), exist_ok=True)
    tmp = LEDGER + ".tmp"
    json.dump(ledger, open(tmp, "w"), indent=1, sort_keys=True)
    os.replace(tmp, LEDGER)          # atomic: a reader never sees a half-written ledger


def _airtable(method, url, body=None):
    pat = open(PAT_FILE).read().strip()
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, method=method,
                                 headers={"Authorization": "Bearer " + pat, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def find_record(file_id, day):
    """Existing record for this clip: by Drive id first, then by episode name. Returns (id, how) or (None, None).
    A silent zero on an existence check writes the duplicate the check exists to prevent, so the
    control here is that the table itself must answer (a bad formula raises, it does not return [])."""
    f1 = 'FIND("%s", {Raw File Link})' % file_id
    r = _airtable("GET", API + "?maxRecords=1&filterByFormula=" + urllib.parse.quote(f1))
    if r.get("records"): return r["records"][0]["id"], "raw-link"
    f2 = '{Content Name}="%s"' % episode_name(day)
    r = _airtable("GET", API + "?maxRecords=1&filterByFormula=" + urllib.parse.quote(f2))
    if r.get("records"): return r["records"][0]["id"], "name"
    return None, None


def list_clips(batch=None, since=DEFAULT_SINCE):
    out = []
    for folder in sorted(os.listdir(RAW_ROOT)):
        fp = os.path.join(RAW_ROOT, folder)
        if not os.path.isdir(fp) or any(s in folder for s in SKIP_DIRS): continue
        if batch and folder != batch: continue
        for name in os.listdir(fp):
            p = parse_clip(name)
            if not p: continue
            date, hms, seq = p
            if since and date < since: continue
            path = os.path.join(fp, name)
            try: size = os.path.getsize(path)
            except OSError: continue
            out.append({"path": path, "name": name, "batch": folder, "date": date.isoformat(), "hms": hms, "seq": seq, "size": size})
    return sorted(out, key=lambda c: (c["date"], c["hms"]))


def scan(create=False, batch=None, since=DEFAULT_SINCE):
    ledger = load_ledger()
    clips = list_clips(batch, since)
    if not clips:
        raise SystemExit("scan: no clips found under %s (batch=%s since=%s) - is Drive mounted?" % (RAW_ROOT, batch, since))
    added = created = linked = 0
    for c in clips:
        key = c["name"]
        if key not in ledger:
            ledger[key] = {**c, "day": streak_day(dt.date.fromisoformat(c["date"])), "status": "new",
                           "seen": dt.datetime.now().isoformat(timespec="seconds")}
            added += 1
        e = ledger[key]
        if "drive_id" not in e:
            e["drive_id"] = drive_id(c["path"])
    if create:
        # one record per shooting day; every clip of that day carries the same record id
        by_day = {}
        for k, e in ledger.items():
            by_day.setdefault(e["day"], []).append(k)
        for day, keys in sorted(by_day.items()):
            keys = sorted(keys, key=lambda k: ledger[k]["hms"])
            have = [ledger[k].get("record_id") for k in keys if ledger[k].get("record_id")]
            if have:
                for k in keys: ledger[k].setdefault("record_id", have[0])
                continue
            first = ledger[keys[0]]
            if not first.get("drive_id"): continue
            rid, how = find_record(first["drive_id"], day)
            if rid: linked += 1
            else:
                r = _airtable("POST", API, {"fields": record_fields(day, keys, first["drive_id"], dt.date.fromisoformat(first["date"]))})
                rid, how = r["id"], "created"; created += 1
            for k in keys: ledger[k]["record_id"] = rid; ledger[k]["record_how"] = how
    save_ledger(ledger)
    waiting = sum(1 for v in ledger.values() if v.get("status") == "new")
    print("scan: %d clips seen, %d new, %d records created, %d linked to existing, %d waiting to pull" % (len(clips), added, created, linked, waiting))
    return ledger


MAX_PULLED = 2   # local copies waiting for the render; each is 0.3-5 GB and the disk has ~60 GB


def pull(ledger, key, work=WORK):
    e = ledger[key]
    waiting = sum(1 for v in ledger.values() if v.get("status") == "pulled")
    if waiting >= MAX_PULLED:
        print("pull: %d clips already pulled and not yet rendered - not pulling more" % waiting); return None
    os.makedirs(work, exist_ok=True)
    dest = os.path.join(work, key)
    free = shutil.disk_usage(work).free
    if free < e["size"] * 2 + 5 * 1024 ** 3:
        raise SystemExit("pull: only %.1f GB free, need %.1f GB for %s" % (free / 1e9, (e["size"] * 2 + 5e9) / 1e9, key))
    t0 = time.time()
    e["status"] = "pulling"; save_ledger(ledger)
    shutil.copyfile(e["path"], dest + ".part")
    got = os.path.getsize(dest + ".part")
    if got != e["size"]:
        os.remove(dest + ".part"); e["status"] = "new"; save_ledger(ledger)
        raise SystemExit("pull: %s arrived with %d bytes, expected %d - left as new for the next run" % (key, got, e["size"]))
    os.replace(dest + ".part", dest)
    e["status"] = "pulled"; e["local"] = dest; e["pulled"] = dt.datetime.now().isoformat(timespec="seconds")
    e["pull_seconds"] = round(time.time() - t0)
    save_ledger(ledger)
    print("pull: %s (%.2f GB) in %d s -> %s" % (key, e["size"] / 1e9, e["pull_seconds"], dest))
    return dest


def report():
    ledger = load_ledger()
    counts = {}
    for v in ledger.values(): counts[v.get("status", "?")] = counts.get(v.get("status", "?"), 0) + 1
    print("content-engine: " + ", ".join("%d %s" % (n, s) for s, n in sorted(counts.items())) if counts else "content-engine: ledger empty")


def selftest():
    assert parse_clip("VID_20260704_105737_00_064.insv") == (dt.date(2026, 7, 4), "105737", 64)
    assert parse_clip("VID_20260704_105737_00_064.lrv") is None and parse_clip("random.insv") is None
    assert streak_day(dt.date(2020, 6, 1)) == 1 and streak_day(dt.date(2026, 7, 4)) == 2225
    assert streak_day(dt.date(2026, 7, 14)) == 2235 and streak_day(dt.date(2026, 6, 8)) == 2199
    assert spoken_day("So consecutive day, 2,225 of a diary of a Runpreneur") == 2225
    assert spoken_day("So consecutive day 2199 of a diary") == 2199 and spoken_day("no number here") is None
    assert resolve_episode(2225, 2225)[0] == 2225
    assert resolve_episode(2225, 2224, prev_day_has_talk=False) == (2224, "catch-up for the missed previous day")
    assert resolve_episode(2225, 2224, prev_day_has_talk=True)[0] == 2225
    assert resolve_episode(2225, 2200)[0] == 2225 and "flagged" in resolve_episode(2225, 2200)[1]
    assert resolve_episode(2225, None)[0] == 2225
    assert drive_link("abc") == "https://drive.google.com/file/d/abc/view"
    f = record_fields(2225, ["VID_a.insv", "VID_b.insv"], "abc", dt.date(2026, 7, 4))
    assert f["Content Name"] == "Episode 2225 Full Episode" and f["Record Status"] == "New Upload"
    assert "2 clips" in f["Notes"] and "VID_b.insv" in f["Notes"]
    assert f["Category"] == "Runpreneur" and f["Content Type"] == "Long Form Video"
    led = {"b": {"date": "2026-07-04", "seq": 2, "size": 400, "status": "new"}, "a": {"date": "2026-06-08", "seq": 9, "status": "pulled"},
           "c": {"date": "2026-07-04", "seq": 1, "size": 4000, "status": "new"}}
    assert choose_next(led) == "b", "oldest date then smallest clip"
    assert choose_next({"x": {"date": "2026-01-01", "seq": 1, "status": "pulled"}}) is None
    print(json.dumps({"checks": 18, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("--create", action="store_true"); ap.add_argument("--batch", default=None)
    ap.add_argument("--since", default=DEFAULT_SINCE.isoformat()); ap.add_argument("--work", default=WORK)
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "scan": scan(a.create, a.batch, dt.date.fromisoformat(a.since))
    elif a.mode == "next":
        ledger = load_ledger(); key = choose_next(ledger)
        if not key: print("next: nothing waiting"); sys.exit(0)
        pull(ledger, key, a.work)
    elif a.mode == "report": report()
    else: raise SystemExit("unknown mode")
