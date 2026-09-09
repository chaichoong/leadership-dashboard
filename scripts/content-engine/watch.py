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
AGENT_FILE = os.path.expanduser("~/.claude/agents/content-engine.md")   # the agent's definition; lessons land in it


def kevin_lessons(path=None):
    """The '## Lessons from Kevin' section of the agent file, for every Claude call in this lane.
    A lesson written where nothing reads it is the failure the learning loop exists to fix."""
    path = path or AGENT_FILE
    if not os.path.exists(path): return ""
    text = open(path).read()
    m = re.search(r"^## Lessons from Kevin\s*\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    body = (m.group(1) if m else "").strip()
    return ("Lessons Kevin has asked you to remember (apply every one):\n" + body) if body else ""
WORK = os.path.expanduser("~/knowledge-os/logs/content-engine/work")
PAT_FILE = os.path.expanduser("~/.config/od/airtable_pat")
BASE = "appnqjDpqDniH3IRl"
TABLE = "tblEPzZdwBZeSXFRB"
API = "https://api.airtable.com/v0/%s/%s" % (BASE, TABLE)
STREAK_START = dt.date(2020, 6, 1)      # day 1
SKIP_DIRS = ("Image", "Footage to be filed", "Time Urgency")
CLIP_RE = re.compile(r"^VID_(\d{4})(\d{2})(\d{2})_(\d{6})_00_(\d{3})\.insv$", re.I)
DEFAULT_SINCE = dt.date(2026, 6, 4)     # the batch Kevin approved the spike on; older batches are the team's
START_DAY_FILE = os.path.expanduser("~/.config/od/content_engine_start_day")   # the takeover point, Kevin's (8 Sep 2026: 2054)


def start_day():
    """The first streak day the engine owns. Ericamae published up to 2053 on 8 Sep 2026; everything from
    this day onward, in order, is the engine's. Nothing older is scanned, so her work is never duplicated."""
    try: return int(open(START_DAY_FILE).read().strip())
    except (OSError, ValueError): return None


def since_for_start_day():
    d = start_day()
    return STREAK_START + dt.timedelta(days=d - 1) if d else DEFAULT_SINCE


GAP_DAYS_FILE = os.path.expanduser("~/.config/od/content_engine_gap_days")   # Kevin's catch-up list (8 Sep 2026): one day number per line


def gap_days(path=None):
    """Streak days missing from YouTube whose footage still exists on Drive (the 8 Sep 2026 audit: 1799, 1808, 1841).
    They are older than the takeover day, so the scan would never see them; this list lets them in."""
    try: return {int(t) for t in re.findall(r"\d{3,4}", open(path or GAP_DAYS_FILE).read())}
    except OSError: return set()


PULL_HEADROOM = 5 * 1024 ** 3


def pull_needs(size):
    """Disk a clip needs before it is pulled: the copy, the render's masters, and 5 GB of headroom."""
    return size * 2 + PULL_HEADROOM


def day_fits(ledger, day, free):
    """Every waiting clip of the day fits on the disk. A gap day is an episode only if its long clip renders,
    so a day whose 18 GB recording cannot be pulled is skipped whole rather than published as a fragment."""
    clips = [v for v in ledger.values() if v.get("day") == day and v.get("status") == "new"]
    return bool(clips) and all(pull_needs(v.get("size", 0)) <= free for v in clips)


def plan(ledger, slots, gaps=None, free=None, start=None):
    """The night's order (Kevin, 8 Sep 2026): "the first one is the one that continues the continuity, and then
    the second two are the two oldest ones that are missing". Slot 1 is the oldest waiting day from the takeover
    day on; every other slot is the oldest gap day whose clips all fit on the disk. When the gap list is used up
    (or nothing fits), the slot goes to the next continuity day instead. Returns (days, notes)."""
    gaps = gap_days() if gaps is None else gaps
    free = shutil.disk_usage(WORK if os.path.isdir(WORK) else os.path.expanduser("~")).free if free is None else free
    start = start_day() if start is None else start
    waiting = sorted({v["day"] for v in ledger.values() if v.get("status") == "new"})
    cont = [d for d in waiting if d not in gaps and (not start or d >= start)]
    gap_ok, notes = [], []
    for d in sorted(d for d in waiting if d in gaps):
        if day_fits(ledger, d, free): gap_ok.append(d)
        else:
            biggest = max(v.get("size", 0) for v in ledger.values() if v.get("day") == d and v.get("status") == "new")
            notes.append("gap day %d skipped: its %.0f GB clip needs %.0f GB free, %.0f GB free" % (d, biggest / 1e9, pull_needs(biggest) / 1e9, free / 1e9))
    days = []
    for slot in range(slots):
        if slot == 0 and cont: days.append(cont.pop(0)); notes.append("slot 1: day %d continues the run" % days[-1]); continue
        if gap_ok: days.append(gap_ok.pop(0)); notes.append("slot %d: gap day %d (oldest missing)" % (slot + 1, days[-1])); continue
        if cont: days.append(cont.pop(0)); notes.append("slot %d: day %d (no gap day fits, so the run moves on)" % (slot + 1, days[-1])); continue
        break
    return days, notes


# ---------- pure helpers (selftested) ----------

DAY_NAMED_RE = re.compile(r"^(\d{4})\s+(full|summary)(?:\s*-?\s*part\s*(\d))?\.insv$", re.I)


def parse_clip(name):
    """VID_20260704_105737_00_064.insv -> (date, '105737', 64) or None.
    Ericamae's Dec 2025 - Feb 2026 batches are named by streak day instead ("2053 Full.insv",
    "2053 summary.insv", "2071 Full Part 2.insv"): the day gives the date, 'full' sorts before
    'summary' the way the camera's sequence would, a part number rides along."""
    m = CLIP_RE.match(name)
    if m:
        y, mo, d, hms, seq = m.groups()
        return dt.date(int(y), int(mo), int(d)), hms, int(seq)
    m = DAY_NAMED_RE.match(name.strip())
    if not m: return None
    day, kind, part = int(m.group(1)), m.group(2).lower(), int(m.group(3) or 1)
    date = STREAK_START + dt.timedelta(days=day - 1)
    return date, ("%02d%d000" % (0 if kind == "full" else 1, part)), part


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


def choose_next(ledger, day=None):
    """Oldest day first, then the SMALLEST clip of that day: the talk-to-camera clip is the short
    one (0.2-0.6 GB, 25-70 s) and the 4 GB ones are long run footage, so the episodes flow sooner."""
    cands = [(v["date"], v.get("size", 0), v["seq"], k) for k, v in ledger.items()
             if v.get("status") == "new" and (day is None or v.get("day") == day)]
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


AIRTABLE_RETRIES, AIRTABLE_RETRY_SECONDS = 6, 30   # a DNS blip on this Mac lasts a minute or two (5 Sep 2026: it cost a finished render its record)


def _airtable(method, url, body=None, _sleep=time.sleep):
    pat = open(PAT_FILE).read().strip()
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, method=method,
                                 headers={"Authorization": "Bearer " + pat, "Content-Type": "application/json"})
    for attempt in range(AIRTABLE_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError:
            raise                                                   # a real answer from Airtable: never retried
        except (urllib.error.URLError, OSError) as ex:              # DNS, socket, timeout: the network, not the request
            if attempt == AIRTABLE_RETRIES - 1: raise
            print("airtable: %s (%s); retry %d/%d in %ds" % (method, str(ex)[:80], attempt + 1, AIRTABLE_RETRIES - 1, AIRTABLE_RETRY_SECONDS), file=sys.stderr)
            _sleep(AIRTABLE_RETRY_SECONDS)


def find_record(file_id, day):
    """Existing record for this episode: by episode NAME first, then by Drive id (Full Episode records only). Returns (id, how) or (None, None).
    A silent zero on an existence check writes the duplicate the check exists to prevent, so the
    control here is that the table itself must answer (a bad formula raises, it does not return [])."""
    # NAME FIRST. The episode number is the identity: a catch-up clip resolves to a different day
    # from the one the scan gave its shooting date, and on 3 Sep 2026 the raw-link match found the
    # "Episode 2195 Short" record (the copy step copies Raw File Link onto the clip records) and
    # wrote a whole full episode onto it. The raw-link fallback is now Full Episode records only.
    f2 = '{Content Name}="%s"' % episode_name(day)
    r = _airtable("GET", API + "?maxRecords=1&filterByFormula=" + urllib.parse.quote(f2))
    if r.get("records"): return r["records"][0]["id"], "name"
    f1 = 'AND(FIND("%s", {Raw File Link}), {Content Type}="Long Form Video")' % file_id
    r = _airtable("GET", API + "?maxRecords=1&filterByFormula=" + urllib.parse.quote(f1))
    if r.get("records"): return r["records"][0]["id"], "raw-link"
    return None, None


def list_clips(batch=None, since=None, root=None, gaps=None):
    """Every clip under the raw folder, however deep: the 2026 batches sit under "2026/", the 2025 months
    under "2025/<month>/Ep NNNN - date/" (8 Sep 2026). `batch` matches the folder path relative to the root.
    Clips older than `since` are skipped unless their day is on Kevin's gap list."""
    since = since or since_for_start_day()
    root = root or RAW_ROOT
    gaps = gap_days() if gaps is None else gaps
    out = []
    for dirpath, dirs, files in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        dirs[:] = sorted(d for d in dirs if not any(s in d for s in SKIP_DIRS))
        if rel != "." and any(s in rel for s in SKIP_DIRS): continue
        if batch and rel != batch and not rel.startswith(batch + os.sep): continue
        for name in files:
            p = parse_clip(name)
            if not p: continue
            date, hms, seq = p
            if since and date < since and streak_day(date) not in gaps: continue
            path = os.path.join(dirpath, name)
            try: size = os.path.getsize(path)
            except OSError: continue
            out.append({"path": path, "name": name, "batch": rel, "date": date.isoformat(), "hms": hms, "seq": seq, "size": size})
    return sorted(out, key=lambda c: (c["date"], c["hms"]))


def scan(create=False, batch=None, since=None):
    ledger = load_ledger()
    stale = repair_stale_pulls(ledger)
    for k in stale: print("scan: %s was stuck 'pulling' from a dead run; reset" % k)
    if stale: save_ledger(ledger)
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
DRIVE_RETRY_ERRNOS = (11, 35)   # EDEADLK / EAGAIN: Drive's file provider says "not downloaded yet, ask again"
PULL_RETRY_SECONDS = 30
PULL_MAX_MINUTES = 40           # for a clip of PULL_WINDOW_GB; bigger clips get proportionally longer
PULL_WINDOW_GB = 4              # 8 Sep 2026: Drive delivered a 4.7 GB clip in 3.7 h one night and a 2.6 GB one in 5 min; an 18 GB gap clip needs hours, not 40 min


def pull_window_minutes(size):
    """How long a pull may wait on Drive: 40 minutes per 4 GB, never less than 40. An 18 GB 2025 recording gets
    about three hours instead of being abandoned at 40 minutes every night (the capacity question, 8 Sep 2026)."""
    return max(PULL_MAX_MINUTES, int(PULL_MAX_MINUTES * size / (PULL_WINDOW_GB * 1024 ** 3)))


def copy_streaming(src, dst, chunk=8 * 1024 * 1024, max_minutes=PULL_MAX_MINUTES, sleep=time.sleep):
    """Copy a Drive file in chunks, retrying the read while Drive hydrates it. shutil.copyfile uses the
    kernel fast path, which Drive answers with EDEADLK the moment the file is not local (4 Sep 2026,
    02:09: the whole nightly run died in one second on clip 006). Returns bytes copied."""
    deadline = time.time() + max_minutes * 60
    done = 0
    with open(dst, "wb") as out:
        while True:
            try:
                with open(src, "rb") as fh:
                    fh.seek(done)
                    while True:
                        buf = fh.read(chunk)
                        if not buf: return done
                        out.write(buf); done += len(buf)
            except OSError as ex:
                if ex.errno not in DRIVE_RETRY_ERRNOS or time.time() > deadline: raise
                out.flush(); sleep(PULL_RETRY_SECONDS)


def pull_via_api(e, part):
    """Download the clip by its Drive id through the API into `part`. Returns True on success; False (with a line)
    when the API is not set up or refuses, so the mount copy takes over. The API path keeps Drive for desktop's
    cache from growing: it never sees the bytes."""
    try:
        import drive_api
        if not os.path.exists(drive_api.KEY_FILE): return False
        got = drive_api.download(e["drive_id"], part, size=e.get("size"))
        e["pulled_via"] = "api"
        return got == e.get("size")
    except Exception as ex:
        print("pull: Drive API failed for %s (%s); falling back to the mounted folder" % (e.get("name"), str(ex)[:120]), file=sys.stderr)
        if os.path.exists(part): os.remove(part)
        return False


def repair_stale_pulls(ledger, work=WORK):
    """A run that died mid-copy (4 Sep 2026, Drive's EDEADLK) leaves a clip 'pulling' for ever, and the
    chooser never looks at it again. Any 'pulling' entry with no complete local file goes back to 'new'."""
    fixed = []
    for key, e in ledger.items():
        if e.get("status") != "pulling": continue
        dest = os.path.join(work, key)
        if os.path.exists(dest) and os.path.getsize(dest) == e.get("size"):
            e["status"] = "pulled"; e["local"] = dest
        else:
            for p in (dest, dest + ".part"):
                if os.path.exists(p): os.remove(p)
            e["status"] = "new"; e.pop("local", None)
        fixed.append(key)
    return fixed


def pull(ledger, key, work=WORK):
    e = ledger[key]
    waiting = sum(1 for v in ledger.values() if v.get("status") == "pulled")
    if waiting >= MAX_PULLED:
        print("pull: %d clips already pulled and not yet rendered - not pulling more" % waiting); return None
    os.makedirs(work, exist_ok=True)
    dest = os.path.join(work, key)
    free = shutil.disk_usage(work).free
    if free < pull_needs(e["size"]):
        raise SystemExit("pull: only %.1f GB free, need %.1f GB for %s" % (free / 1e9, pull_needs(e["size"]) / 1e9, key))
    t0 = time.time()
    e["status"] = "pulling"; save_ledger(ledger)
    try:
        window = pull_window_minutes(e["size"])
        if e.get("drive_id") and pull_via_api(e, dest + ".part"):
            pass                                                    # streamed through the Drive API: nothing lands in the Mac's Drive cache (Kevin, 9 Sep 2026)
        else:
            copy_streaming(e["path"], dest + ".part", max_minutes=window)
    except OSError as ex:
        # Drive never delivered it within the window: leave it for the next night, keep the run alive
        if os.path.exists(dest + ".part"): os.remove(dest + ".part")
        e["status"] = "new"; e["pull_error"] = "%s (%s)" % (ex.strerror or ex, dt.datetime.now().isoformat(timespec="seconds")); save_ledger(ledger)
        print("pull: Drive would not deliver %s within %d min (%s) - left as new for the next run" % (key, window, ex.strerror or ex)); return None
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
    print("content-engine: " + disk_line(ledger))


def disk_line(ledger, free=None):
    """Free disk against the biggest clip still waiting, so a shortfall is read in the morning line, never
    discovered by a night that pulled nothing (Kevin, 8 Sep 2026: no capacity surprises every night)."""
    free = shutil.disk_usage(WORK if os.path.isdir(WORK) else os.path.expanduser("~")).free if free is None else free
    waiting = [v for v in ledger.values() if v.get("status") == "new"]
    if not waiting: return "%.0f GB free, nothing waiting" % (free / 1e9)
    big = max(waiting, key=lambda v: v.get("size", 0))
    need = pull_needs(big.get("size", 0))
    if need <= free: return "%.0f GB free; the biggest waiting clip (day %s, %.0f GB) fits" % (free / 1e9, big.get("day"), big.get("size", 0) / 1e9)
    return "%.0f GB free; day %s's %.0f GB clip needs %.0f GB, SHORT by %.0f GB" % (free / 1e9, big.get("day"), big.get("size", 0) / 1e9, need / 1e9, (need - free) / 1e9)


def _selftest_copy_retry():
    import tempfile
    src = os.path.join(tempfile.gettempdir(), "od-pull-src-%d" % os.getpid()); dst = src + ".dst"
    open(src, "wb").write(b"x" * 1000)
    real_open = open; calls = {"n": 0}
    class Flaky:
        """Raises EDEADLK on the first two reads of the source, like Drive before the file is local."""
        def __init__(self, fh): self.fh = fh
        def seek(self, n): self.fh.seek(n)
        def read(self, n):
            calls["n"] += 1
            if calls["n"] <= 2: raise OSError(11, "Resource deadlock avoided")
            return self.fh.read(n)
        def __enter__(self): return self
        def __exit__(self, *a): self.fh.close()
    import builtins
    def fake_open(path, mode="r", *a, **k):
        fh = real_open(path, mode, *a, **k)
        return Flaky(fh) if path == src and "r" in mode else fh
    builtins.open = fake_open
    try: n = copy_streaming(src, dst, chunk=300, sleep=lambda s: None)
    finally: builtins.open = real_open
    assert n == 1000 and real_open(dst, "rb").read() == b"x" * 1000, "resumes after Drive's deadlock errors"
    os.remove(src); os.remove(dst)


def _selftest_repair_stale():
    import tempfile
    work = tempfile.mkdtemp(prefix="od-pull-")
    led = {"a.insv": {"status": "pulling", "size": 5}, "b.insv": {"status": "pulling", "size": 3}, "c.insv": {"status": "pulled", "size": 1}}
    open(os.path.join(work, "a.insv.part"), "wb").write(b"xx")            # died mid-copy
    open(os.path.join(work, "b.insv"), "wb").write(b"yyy")                 # finished but never marked
    fixed = repair_stale_pulls(led, work)
    assert sorted(fixed) == ["a.insv", "b.insv"] and led["a.insv"]["status"] == "new" and led["b.insv"]["status"] == "pulled" and led["c.insv"]["status"] == "pulled"
    assert not os.path.exists(os.path.join(work, "a.insv.part")), "the dead part-file is removed"
    shutil.rmtree(work)


def _selftest_airtable_retry():
    calls = {"n": 0}; naps = []
    real = urllib.request.urlopen
    def flaky(req, timeout=60):
        calls["n"] += 1
        if calls["n"] < 3: raise urllib.error.URLError("nodename nor servname provided")
        import io
        class R(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): pass
        return R(b'{"ok": true}')
    urllib.request.urlopen = flaky
    try: out = _airtable("GET", "https://api.airtable.com/v0/x/y", _sleep=naps.append)
    finally: urllib.request.urlopen = real
    assert out == {"ok": True} and calls["n"] == 3 and naps == [AIRTABLE_RETRY_SECONDS, AIRTABLE_RETRY_SECONDS], "two DNS failures, then the answer"


def selftest():
    _selftest_airtable_retry()
    assert parse_clip("2053 Full.insv") == (dt.date(2026, 1, 13), "001000", 1) and parse_clip("2053 summary.insv")[0] == dt.date(2026, 1, 13)
    assert parse_clip("2071 Full Part 2.insv") == (dt.date(2026, 1, 31), "002000", 2) and parse_clip("2071 Full - Part 1.insv")[2] == 1
    globals()["START_DAY_FILE"] = "/nonexistent/od-start-day"; assert since_for_start_day() == DEFAULT_SINCE
    import tempfile; tf = os.path.join(tempfile.gettempdir(), "od-start-%d" % os.getpid()); open(tf, "w").write("2054\n"); globals()["START_DAY_FILE"] = tf
    assert start_day() == 2054 and since_for_start_day() == dt.date(2026, 1, 14), since_for_start_day(); os.remove(tf)
    import tempfile, shutil as _sh
    root = tempfile.mkdtemp(prefix="od-raw-")
    for rel in ("2026/28 December 2025 - 25 January 2026/2054 Full.insv", "2026/28 December 2025 - 25 January 2026/2054 summary.insv",
                "2025/25_05(May 2025)/Ep 1799 - May 4/VID_20250504_162936_00_022.insv", "4 June 26 - 19 July 26/VID_20260604_172435_00_001.insv", "Image/VID_20260604_000000_00_099.insv"):
        os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True); open(os.path.join(root, rel), "wb").write(b"x")
    got = list_clips(since=dt.date(2025, 1, 1), root=root)
    assert [c["name"] for c in got] == ["VID_20250504_162936_00_022.insv", "2054 Full.insv", "2054 summary.insv", "VID_20260604_172435_00_001.insv"], [c["name"] for c in got]
    assert got[1]["batch"].startswith("2026/") and "Image" not in str(got), "walks every depth, skips the Image folder"
    _sh.rmtree(root)
    assert parse_clip("notes.txt") is None and parse_clip("2053 Full.insv")[1] < parse_clip("2053 summary.insv")[1], "full sorts before summary"
    _selftest_repair_stale()
    _selftest_copy_retry()
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
    _selftest_gap_order()
    gb = 1024 ** 3
    assert pull_window_minutes(2 * gb) == 40 and pull_window_minutes(4 * gb) == 40 and pull_window_minutes(18 * gb) == 180, "40 min per 4 GB, floor 40"
    led = {"g": {"day": 1799, "size": 18 * gb, "status": "new"}, "c": {"day": 2054, "size": 4 * gb, "status": "new"}}
    assert "SHORT by" in disk_line(led, 30 * gb) and "day 1799" in disk_line(led, 30 * gb) and "fits" in disk_line(led, 60 * gb) and "nothing waiting" in disk_line({}, 60 * gb)
    print(json.dumps({"checks": 34, "failed": []}))


def _selftest_gap_order():
    """Kevin's night order (8 Sep 2026): slot 1 continues the run, the other slots take the oldest missing days."""
    import tempfile
    gb = 1024 ** 3
    led = {"a": {"day": 2054, "date": "2026-01-14", "seq": 1, "size": 1 * gb, "status": "new"},
           "b": {"day": 2054, "date": "2026-01-14", "seq": 2, "size": 4 * gb, "status": "new"},
           "c": {"day": 2055, "date": "2026-01-15", "seq": 1, "size": 1 * gb, "status": "new"},
           "d": {"day": 2056, "date": "2026-01-16", "seq": 1, "size": 1 * gb, "status": "new"},
           "g1": {"day": 1799, "date": "2025-05-04", "seq": 1, "size": 18 * gb, "status": "new"},
           "g1s": {"day": 1799, "date": "2025-05-04", "seq": 2, "size": 1 * gb, "status": "new"},
           "g2": {"day": 1808, "date": "2025-05-13", "seq": 1, "size": 18 * gb, "status": "new"},
           "g3": {"day": 1841, "date": "2025-06-15", "seq": 1, "size": 10 * gb, "status": "new"},
           "old": {"day": 2053, "date": "2026-01-13", "seq": 1, "size": 1 * gb, "status": "new"}}
    gaps = {1799, 1808, 1841}
    days, notes = plan(led, 3, gaps=gaps, free=100 * gb, start=2054)
    assert days == [2054, 1799, 1808], days
    days, _ = plan(led, 3, gaps=gaps, free=33 * gb, start=2054)
    assert days == [2054, 1841, 2055], "18 GB clips need 41 GB free: those days wait whole, the slot moves on"
    assert any("1799 skipped" in n for n in _), _
    days, _ = plan(led, 3, gaps=set(), free=100 * gb, start=2054)
    assert days == [2054, 2055, 2056], "no gap list: three continuity days"
    assert 2053 not in plan(led, 9, gaps=gaps, free=100 * gb, start=2054)[0], "nothing older than the takeover day is a continuity day"
    assert choose_next(led, day=2054) == "a" and choose_next(led, day=1808) == "g2" and choose_next(led, day=1900) is None
    assert not day_fits(led, 1799, 33 * gb) and day_fits(led, 1841, 33 * gb) and not day_fits(led, 1900, 100 * gb)
    tf = os.path.join(tempfile.gettempdir(), "od-gaps-%d" % os.getpid()); open(tf, "w").write("1799\n1808 1841\n")
    assert gap_days(tf) == gaps; os.remove(tf); assert gap_days("/nonexistent/od-gaps") == set()
    # the scan lets a gap day through the since filter, and only that day
    import shutil as _sh
    root = tempfile.mkdtemp(prefix="od-raw-")
    for rel in ("2025/25_05(May 2025)/Ep 1799 - May 4/VID_20250504_162936_00_022.insv", "2025/25_05(May 2025)/Ep 1800 - May 5/VID_20250505_162936_00_024.insv",
                "2026/28 December 2025 - 25 January 2026/2054 full.insv"):
        os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True); open(os.path.join(root, rel), "wb").write(b"x")
    got = [c["name"] for c in list_clips(since=dt.date(2026, 1, 14), root=root, gaps={1799})]
    assert got == ["VID_20250504_162936_00_022.insv", "2054 full.insv"], got
    assert [c["name"] for c in list_clips(since=dt.date(2026, 1, 14), root=root, gaps=set())] == ["2054 full.insv"]
    _sh.rmtree(root)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("--create", action="store_true"); ap.add_argument("--batch", default=None)
    ap.add_argument("--since", default=None, help="scan: clips from this date (default: the takeover day, plus the gap list)")
    ap.add_argument("--work", default=WORK)
    ap.add_argument("--day", type=int, default=None, help="next: pull the next waiting clip of this day only (exit 3 when the day is done)")
    ap.add_argument("--slots", type=int, default=1, help="plan: how many days tonight")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "scan": scan(a.create, a.batch, dt.date.fromisoformat(a.since) if a.since else None)
    elif a.mode == "plan":
        days, notes = plan(load_ledger(), a.slots)
        for n in notes: print("plan: " + n, file=sys.stderr)
        print(" ".join(str(d) for d in days))
    elif a.mode == "next":
        ledger = load_ledger(); key = choose_next(ledger, a.day)
        if not key: print("next: nothing waiting" + (" for day %d" % a.day if a.day else "")); sys.exit(3 if a.day else 0)
        pull(ledger, key, a.work)
    elif a.mode == "report": report()
    else: raise SystemExit("unknown mode")
