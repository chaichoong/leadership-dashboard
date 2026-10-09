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


GAP_PAUSE_FILE = os.path.expanduser("~/.config/od/content_engine_gap_days_paused")


def gaps_paused(path=None):
    """Kevin, 15 Sep 2026: "consistency first". While this file exists the night plan renders continuity days
    only; the gap list still lets those days through the scan and the publisher, it just gets no render slot.
    Delete the file to give gap days their slots back (after seven days in a row with an episode out)."""
    return os.path.exists(path or GAP_PAUSE_FILE)


PULL_HEADROOM = 5 * 1024 ** 3


def pull_needs(size):
    """Disk a clip needs before it is pulled: the copy, the render's masters, and 5 GB of headroom."""
    return size * 2 + PULL_HEADROOM


def day_fits(ledger, day, free):
    """Every waiting clip of the day fits on the disk. A gap day is an episode only if its long clip renders,
    so a day whose 18 GB recording cannot be pulled is skipped whole rather than published as a fragment."""
    clips = [v for v in ledger.values() if v.get("day") == day and v.get("status") == "new"]
    return bool(clips) and all(pull_needs(v.get("size", 0)) <= free for v in clips)


MIN_NEW = 2   # new days a night that a redo never displaces (Kevin, 2 Oct 2026: "at least two episodes every single day")


def plan(ledger, slots, gaps=None, free=None, start=None):
    """The night's order (Kevin, 8 Sep 2026): "the first one is the one that continues the continuity, and then
    the second two are the two oldest ones that are missing". Slot 1 is the oldest waiting day from the takeover
    day on; every other slot is the oldest gap day whose clips all fit on the disk. When the gap list is used up
    (or nothing fits), the slot goes to the next continuity day instead. Returns (days, notes)."""
    paused = gaps is None and gaps_paused()
    gap_list = gap_days() if gaps is None else set(gaps)   # the list itself, paused or not: a gap day is never a redo day
    if gaps is None: gaps = set() if paused else gap_days()
    free = shutil.disk_usage(WORK if os.path.isdir(WORK) else os.path.expanduser("~")).free if free is None else free
    start = start_day() if start is None else start
    waiting = sorted({v["day"] for v in ledger.values() if v.get("status") == "new"})
    # A day render.redo_day put back to 'new' carries a `reset` note: a day Kevin sent back. Kevin, 7 Oct 2026: a
    # sent-back episode is redone and put back to the FRONT of the queue, never at the cost of the new ones. So the
    # night's one redo renders first (from 2 Oct it went last, where the 04:00 last start and the 07:00 stop cut it
    # first), and the night still renders MIN_NEW new days after it. A sent-back gap day stays on the gap route (its
    # clip must fit the disk, and it waits while the gap list is paused).
    # Oldest first, but a day whose footage would not come down goes behind the others, least recently failed first
    # (Kevin, 2 Oct 2026): with one redo a night, an older day whose pull was refused every night would keep a younger
    # redo waiting for ever. `pull_failed` is stamped by pull() on every refusal and cleared when the clip arrives.
    failed_at = lambda d: max((v.get("pull_failed") or "") for v in ledger.values() if v.get("day") == d and v.get("status") == "new")
    redo = sorted((d for d in {v["day"] for v in ledger.values() if v.get("status") == "new" and v.get("reset")} - gap_list if not start or d >= start),
                  key=lambda d: (failed_at(d), d))
    cont = [d for d in waiting if d not in gaps and d not in redo and (not start or d >= start)]
    gap_ok, notes = [], []
    for d in sorted(d for d in waiting if d in gaps):
        if day_fits(ledger, d, free): gap_ok.append(d)
        else:
            biggest = max(v.get("size", 0) for v in ledger.values() if v.get("day") == d and v.get("status") == "new")
            notes.append("gap day %d skipped: its %.0f GB clip needs %.0f GB free, %.0f GB free" % (d, biggest / 1e9, pull_needs(biggest) / 1e9, free / 1e9))
    # The night never renders fewer than MIN_NEW new days. Past that, a waiting redo takes the spare slot rather than
    # going on top (Kevin, 2 Oct 2026: three a night, so a day he sends back still leaves two to publish). At three
    # slots the night is the redo and two new days: three renders, about six to seven hours, inside the nine-hour stop.
    # One redo a night, whatever the slots (Kevin, 7 Oct 2026); a second waiting redo takes the next night.
    n_redo = min(len(redo), 1) if slots > 0 else 0
    new_slots = max(min(slots, MIN_NEW), slots - n_redo)
    days = []
    for slot in range(new_slots):
        if slot == 0 and cont: days.append(cont.pop(0)); notes.append("slot 1: day %d continues the run" % days[-1]); continue
        if gap_ok: days.append(gap_ok.pop(0)); notes.append("slot %d: gap day %d (oldest missing)" % (slot + 1, days[-1])); continue
        if cont: days.append(cont.pop(0)); notes.append("slot %d: day %d %s" % (slot + 1, days[-1], "continues the run (gap days paused)" if paused else "(no gap day fits, so the run moves on)")); continue
        break
    # The redo goes FIRST (Kevin, 7 Oct 2026), oldest first. A slot no new day filled goes to a waiting redo as well
    # (review, 2 Oct 2026): with nothing new waiting, a second redo costs no new episode its place.
    if slots > 0:
        room = n_redo + (new_slots - len(days))
        front = redo[:room]
        for d in front: notes.append("redo: day %d (sent back) renders first, before the night's new episodes" % d)
        for d in redo[room:]: notes.append("redo: day %d (sent back) waits for another night: one redo a night" % d)
        days = front + days
    return days, notes


# ---------- pure helpers (selftested) ----------

DAY_NAMED_RE = re.compile(r"^(\d{4})\s+(full|summary)(?:\s*-?\s*part\s*(\d))?\.insv$", re.I)
# A clip named by its day that DAY_NAMED_RE still refuses ("2066 Full-Real.insv", "2006 Full (1).insv"). Until 21 Sep
# 2026 the scan dropped these without a word: 2066's whole episode sat on Drive unseen and would have held every day
# after it. Listed by the scan, shown on the Publishing page.
DAY_LIKE_RE = re.compile(r"^\s*\d{4}\D.*\.insv$", re.I)
SKIPPED_NAMES_FILE = os.path.join(os.path.dirname(LEDGER), "skipped_names.json")


def save_skipped_names(names, path=None):
    path = path or SKIPPED_NAMES_FILE
    tmp = path + ".tmp"
    json.dump({"at": dt.datetime.now().isoformat(timespec="seconds"), "names": sorted(names)}, open(tmp, "w"), indent=1)
    os.replace(tmp, path)


# Skipped files Kevin has already ruled on, one per line: "<path as the scan lists it>  # his ruling". Left out of the
# Publishing page's skipped list (30 Sep 2026: the day-1990 extra take he ruled on 21 Sep still read as unsorted).
SKIP_RULED_FILE = os.path.expanduser("~/.config/od/content_engine_skip_ruled")


def skip_rulings(path=None):
    """{path: ruling} from SKIP_RULED_FILE; empty when there is none."""
    out = {}
    try: lines = open(path or SKIP_RULED_FILE).read().splitlines()
    except OSError: return out
    for line in lines:
        name, _, why = line.partition("#")
        if name.strip(): out[name.strip()] = why.strip()
    return out


def skipped_names(path=None, ruled=None):
    """The last whole-folder scan's unreadable day-numbered clips that Kevin has NOT ruled on, or None when no scan has
    written the list. ruled={} gives the whole list."""
    try: names = json.load(open(path or SKIPPED_NAMES_FILE)).get("names", [])
    except (OSError, ValueError): return None
    ruled = skip_rulings() if ruled is None else ruled
    return [n for n in names if n not in ruled]


def skipped_ruled(path=None, ruled=None):
    """The skipped clips Kevin HAS ruled on (still in the last scan), or None when no scan has written the list."""
    names = skipped_names(path, ruled={})
    if names is None: return None
    ruled = skip_rulings() if ruled is None else ruled
    return [n for n in names if n in ruled]


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
    """Oldest day first, then the BIGGEST clip of that day. The short teaser renders after the long clip so its
    banner carries the episode title (render.teaser_waits, 10 Sep 2026), so pulling the teaser first only parks
    it. Smallest-first jammed the night of 14 Sep 2026: the 2059 and 2060 teasers sat pulled, each waiting for its
    long clip, and the two-copy pull limit refused to fetch either long clip, so eighteen attempts rendered nothing."""
    cands = [(v["date"], -(v.get("size") or 0), v["seq"], k) for k, v in ledger.items()
             if v.get("status") == "new" and (day is None or v.get("day") == day)]
    return sorted(cands)[0][3] if cands else None


def part_no(key):
    """2 for "2071 Full Part 2.insv", 0 for a clip that is not a named part."""
    m = DAY_NAMED_RE.match((key or "").strip())
    return int(m.group(3)) if m and m.group(3) else 0


def _day_of(v):
    return v.get("day") if v.get("day") is not None else v.get("date")


def waits_for_bigger(key, ledger):
    """A pulled clip is parked while a bigger clip of the same day is still new, pulled or rendering: the long clip
    renders first. A parked clip is not in the render queue, so the pull limit never counts it. Named parts go in
    order whatever their size (24 Sep 2026): part 2 waits for part 1, and part 1 never waits for part 2, because
    render.py joins a later part onto the part before it and cannot join onto one that has not rendered."""
    e = ledger[key]; pn = part_no(key)
    for k2, v in ledger.items():
        if k2 == key or _day_of(v) != _day_of(e) or v.get("status") not in ("new", "pulled", "rendering"): continue
        p2 = part_no(k2)
        if pn and p2:
            if p2 < pn: return True
            continue
        if (v.get("size") or 0) > (e.get("size") or 0): return True
    return False


def renderable(key, ledger):
    """What render.run takes: a pulled clip whose local copy is on disk and is not parked behind its day's long clip.
    A pulled clip whose file has gone is NOT renderable: the render skips it (render.run checks the file), so counting
    it held the two-copy pull limit full and every pass of the night pulled nothing (review, 2 Oct 2026)."""
    v = ledger[key]
    return (v.get("status") == "pulled" and bool(v.get("local")) and os.path.exists(v["local"])
            and not waits_for_bigger(key, ledger))


def pulled_in_queue(ledger):
    """Local copies the render will take next: pulled, on disk, and not parked behind their day's long clip."""
    return sum(1 for k in ledger if renderable(k, ledger))


def requeue_failed(ledger, now=None):
    """A failed render gets ONE more try, the next night, with the day's smaller clips that rendered without it
    (their banner title comes from the long clip). 13-14 Sep 2026: a NameError killed the 2057 and 2058 long clips,
    the bug was fixed the next day, and both days sat 'failed' for ever because nothing looks at a failed clip.
    A second failure stays failed and is named in the morning report. Returns the keys put back."""
    now = now or dt.datetime.now().isoformat(timespec="seconds")
    back = []
    for k, e in ledger.items():
        if e.get("status") != "failed" or e.get("requeued"): continue
        e.update({"status": "new", "requeued": now, "last_error": e.pop("error", "")}); e.pop("local", None); back.append(k)
        for k2, v in ledger.items():
            # the same EPISODE, not merely the same date: 4 Jun 2026 holds 2194 and 2195, so a date match would
            # re-render 2194's published teaser when a 2195 clip failed (review, 15 Sep 2026)
            if k2 != k and v.get("date") == e.get("date") and v.get("episode") == e.get("episode") \
                    and (v.get("size") or 0) < (e.get("size") or 0) and v.get("status") == "rendered":
                v.update({"status": "new", "requeued": now, "requeue_reason": "re-rendered after %s so it carries the episode title" % k})
                v.pop("local", None); back.append(k2)
    return back


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


def list_clips(batch=None, since=None, root=None, gaps=None, skipped=None):
    """Every clip under the raw folder, however deep: the 2026 batches sit under "2026/", the 2025 months
    under "2025/<month>/Ep NNNN - date/" (8 Sep 2026). `batch` matches the folder path relative to the root.
    Clips older than `since` are skipped unless their day is on Kevin's gap list. A day-numbered clip whose name
    parse_clip cannot read is appended to `skipped` (its path under the root), never dropped in silence."""
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
            if not p:
                if skipped is not None and DAY_LIKE_RE.match(name): skipped.append(os.path.join(rel, name))
                continue
            date, hms, seq = p
            if since and date < since and streak_day(date) not in gaps: continue
            path = os.path.join(dirpath, name)
            try: size = os.path.getsize(path)
            except OSError: continue
            out.append({"path": path, "name": name, "batch": rel, "date": date.isoformat(), "hms": hms, "seq": seq, "size": size})
    return sorted(out, key=lambda c: (c["date"], c["hms"]))


def scan(create=False, batch=None, since=None):
    ledger = load_ledger()
    why = {}
    stale = repair_stale_pulls(ledger, why=why)
    for k in stale: print("scan: %s %s" % (k, why.get(k) or "was stuck 'pulling' from a dead run; reset"))
    back = requeue_failed(ledger)
    for k in back: print("scan: %s put back in the queue for one more try (failed last time)" % k)
    if stale or back: save_ledger(ledger)
    skipped = []
    clips = list_clips(batch, since, skipped=skipped)
    if not clips:
        raise SystemExit("scan: no clips found under %s (batch=%s since=%s) - is Drive mounted?" % (RAW_ROOT, batch, since))
    if batch is None:                                        # a whole-folder walk: the list is complete, so the report may show it
        save_skipped_names(skipped)
        if skipped: print("scan: %d day-numbered clip%s skipped, the name cannot be read: %s" % (len(skipped), "" if len(skipped) == 1 else "s", "; ".join(skipped)))
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


def repair_stale_pulls(ledger, work=WORK, why=None):
    """A run that died mid-copy (4 Sep 2026, Drive's EDEADLK) leaves a clip 'pulling' for ever, and the
    chooser never looks at it again. Any 'pulling' entry with no complete local file goes back to 'new'.
    A 'pulled' entry whose local copy has gone, or is the wrong size, goes back to 'new' too (review, 2 Oct 2026;
    Kevin's approved build, task rec1KkjrSv0U9KUXZ): the render skips a clip with no file, so it would sit 'pulled'
    for ever. `why`, when given, is filled with each reset clip's reason for the night's log."""
    fixed = []
    for key, e in ledger.items():
        if e.get("status") == "pulled":
            local = e.get("local") or os.path.join(work, key)
            try:
                whole = os.path.getsize(local) == e.get("size")
            except OSError:
                whole = None
            if whole:
                continue
            e["status"] = "new"; e.pop("local", None)
            fixed.append(key)
            if why is not None:
                why[key] = "was pulled but its local copy is %s; reset to new, it is pulled again" % (
                    "gone" if whole is None else "the wrong size")
            continue
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


ATTACH_DIR = os.path.expanduser("~/knowledge-os/attachments/content-engine")   # spotify.ATTACH_DIR: the lane's upload folder
LOOSE_KEEP_DAYS = 3        # a hand-made copy in the work folder (a test, a one-off) older than this is debris
STAGED_KEEP_DAYS = 7       # an episode staged for Spotify goes once its podcast is out, or after this long


def clear_leftovers(ledger, work=WORK, attach=ATTACH_DIR, publishing=None, now=None, remove=None):
    """Delete working copies nothing will read again; returns [(path, bytes)]. 24 Sep 2026: a Learnings rebuild and the
    daytime one-offs kept their 5-9 GB raw copies and render folders, and every Spotify upload kept its staged episode,
    until 34 GB sat unused and 2072's pull was refused 1 GB short: no card, nothing to publish the next day. Only copies
    are removed: a raw clip's original is on Drive and every render output is filed there before its status is set.
      - a clip (and its render_ folder) whose ledger status is rendered or broll; never pulled/pulling/rendering/new
      - any other loose file in the work folder older than LOOSE_KEEP_DAYS (hand-made test copies, old upload shrinks)
      - a staged Spotify file once that episode's podcast is published, or older than STAGED_KEEP_DAYS"""
    import time as _t
    now = now or _t.time()
    remove = remove or (lambda p: shutil.rmtree(p) if os.path.isdir(p) else os.remove(p))
    done_keys = {k for k, v in ledger.items() if v.get("status") in ("rendered", "broll")}
    busy_keys = {k for k, v in ledger.items() if v.get("status") in ("pulled", "pulling", "rendering", "new") or v.get("keep_masters")}   # kept for the next part (render.py)
    def size(p):
        if os.path.isfile(p): return os.path.getsize(p)
        return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(p) for f in fs)
    gone = []
    def drop(p):
        n = size(p)
        try: remove(p); gone.append((p, n))
        except OSError as ex: print("leftovers: could not remove %s (%s)" % (p, ex), file=sys.stderr)
    if os.path.isdir(work):
        for name in sorted(os.listdir(work)):
            p = os.path.join(work, name)
            key = name[len("render_"):] + ".insv" if name.startswith("render_") and os.path.isdir(p) else name
            if key in busy_keys or name.endswith(".part"): continue           # the chooser's and repair_stale_pulls' business
            if key in done_keys: drop(p)
            elif os.path.isfile(p) and now - os.path.getmtime(p) > LOOSE_KEEP_DAYS * 86400: drop(p)
    if os.path.isdir(attach):
        if publishing is None:
            try: publishing = json.load(open(os.path.join(os.path.dirname(LEDGER), "publishing.json")))
            except Exception: publishing = {}
        for name in sorted(os.listdir(attach)):
            p = os.path.join(attach, name)
            if not os.path.isfile(p): continue
            m = re.match(r"(?:Episode_|Ep)(\d+)_", name)
            pod = ((publishing.get(m.group(1)) or {}).get("podcast") or {}) if m else {}
            if pod.get("status") == "published" or now - os.path.getmtime(p) > STAGED_KEEP_DAYS * 86400: drop(p)
    return gone


def pull(ledger, key, work=WORK):
    e = ledger[key]
    waiting = pulled_in_queue(ledger)
    if waiting >= MAX_PULLED:
        print("pull: %d clips already pulled and not yet rendered - not pulling more" % waiting); return None
    os.makedirs(work, exist_ok=True)
    dest = os.path.join(work, key)
    free = shutil.disk_usage(work).free
    if free < pull_needs(e["size"]):
        gone = clear_leftovers(ledger, work)
        if gone: print("pull: cleared %d leftover working copies (%.1f GB) to make room" % (len(gone), sum(n for _, n in gone) / 1e9))
        free = shutil.disk_usage(work).free
    if free < pull_needs(e["size"]):
        e["pull_failed"] = dt.datetime.now().isoformat(timespec="seconds"); save_ledger(ledger)
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
        e["status"] = "new"; e["pull_error"] = "%s (%s)" % (ex.strerror or ex, dt.datetime.now().isoformat(timespec="seconds"))
        e["pull_failed"] = dt.datetime.now().isoformat(timespec="seconds"); save_ledger(ledger)
        print("pull: Drive would not deliver %s within %d min (%s) - left as new for the next run" % (key, window, ex.strerror or ex)); return None
    got = os.path.getsize(dest + ".part")
    if got != e["size"]:
        os.remove(dest + ".part"); e["status"] = "new"; e["pull_failed"] = dt.datetime.now().isoformat(timespec="seconds"); save_ledger(ledger)
        raise SystemExit("pull: %s arrived with %d bytes, expected %d - left as new for the next run" % (key, got, e["size"]))
    os.replace(dest + ".part", dest)
    e["status"] = "pulled"; e["local"] = dest; e["pulled"] = dt.datetime.now().isoformat(timespec="seconds"); e.pop("pull_failed", None)
    e["pull_seconds"] = round(time.time() - t0)
    save_ledger(ledger)
    print("pull: %s (%.2f GB) in %d s -> %s" % (key, e["size"] / 1e9, e["pull_seconds"], dest))
    return dest


NEXT_DAY_DONE, NEXT_NOT_DELIVERED = 3, 4


def next_exit(ledger, day, work, pull_fn=None):
    """The exit code of `watch.py next`: 0 a clip is down and ready to render; 3 nothing of that day is waiting (the
    day is done); 4 Drive did not deliver the clip. The night's loop renders after a 0 and moves to the next day on
    anything else. Until 2 Oct 2026 an undelivered pull also exited 0, so the loop asked for the same clip up to six
    times: a 5 GB clip Drive would not serve held the night for five hours, to the 07:00 stop, and the copy, cards
    and publishing steps after the loop never ran (review, 2 Oct 2026). Clips already pulled and waiting to render
    stay a 0: the render that follows is the only thing that drains them, and a 4 there would stop every day at its
    first step, night after night (second review)."""
    key = choose_next(ledger, day)
    if not key:
        # The day is done only when none of its clips is still waiting to render either. The render takes the OLDEST
        # pulled clip first, so a day's last clip pulled behind an older stale one was left pulled when the next pass
        # said "done", and a one-clip day last in the night rendered a night late (review, 2 Oct 2026; Kevin's
        # approved build, task rec1KkjrSv0U9KUXZ). The loop's six-pass cap still bounds it.
        if day and any(v.get("day") == day and renderable(k, ledger) for k, v in ledger.items()):
            print("next: day %d has a clip pulled and still waiting to render; the render takes it" % day); return 0
        print("next: nothing waiting" + (" for day %d" % day if day else "")); return NEXT_DAY_DONE if day else 0
    if pulled_in_queue(ledger) >= MAX_PULLED:
        print("pull: %d clips already pulled and not yet rendered - not pulling more; the render takes one" % pulled_in_queue(ledger)); return 0
    return 0 if (pull_fn or pull)(ledger, key, work) else NEXT_NOT_DELIVERED


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
    c = os.path.join(work, "c.insv")
    led = {"a.insv": {"status": "pulling", "size": 5}, "b.insv": {"status": "pulling", "size": 3}, "c.insv": {"status": "pulled", "size": 1, "local": c}}
    open(os.path.join(work, "a.insv.part"), "wb").write(b"xx")            # died mid-copy
    open(os.path.join(work, "b.insv"), "wb").write(b"yyy")                 # finished but never marked
    open(c, "wb").write(b"z")                                              # pulled, on disk, whole: left alone
    fixed = repair_stale_pulls(led, work)
    assert sorted(fixed) == ["a.insv", "b.insv"] and led["a.insv"]["status"] == "new" and led["b.insv"]["status"] == "pulled" and led["c.insv"]["status"] == "pulled"
    assert not os.path.exists(os.path.join(work, "a.insv.part")), "the dead part-file is removed"
    # A pulled clip whose local copy has gone (or is the wrong size) goes back to new (review, 2 Oct 2026): two of them
    # held the two-copy pull limit full, so every pass pulled nothing and the render skipped both, night after night.
    open(os.path.join(work, "short.insv"), "wb").write(b"q")
    led = {"gone1.insv": {"day": 2090, "date": "2026-03-01", "seq": 1, "size": 7, "status": "pulled", "local": os.path.join(work, "gone1.insv")},
           "gone2.insv": {"day": 2091, "date": "2026-03-02", "seq": 1, "size": 7, "status": "pulled"},
           "short.insv": {"day": 2092, "date": "2026-03-03", "seq": 1, "size": 7, "status": "pulled", "local": os.path.join(work, "short.insv")},
           "today.insv": {"day": 2093, "date": "2026-03-04", "seq": 1, "size": 7, "status": "new"}}
    assert pulled_in_queue(led) == 1, "a pulled clip with no file on disk is not in the render queue"
    why = {}
    assert sorted(repair_stale_pulls(led, work, why=why)) == ["gone1.insv", "gone2.insv", "short.insv"]
    assert all(led[k]["status"] == "new" and "local" not in led[k] for k in ("gone1.insv", "gone2.insv", "short.insv"))
    assert "gone" in why["gone1.insv"] and "wrong size" in why["short.insv"], why
    asked = []
    import io as _io, contextlib as _cl
    with _cl.redirect_stdout(_io.StringIO()):
        assert pulled_in_queue(led) == 0 and next_exit(led, 2093, work, pull_fn=lambda l, key, w: asked.append(key) or "/x") == 0 and asked == ["today.insv"], \
            "the next pass pulls the day's clip"
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


def _selftest_jam_and_retry():
    """The 14 Sep 2026 night, reproduced: two teasers pulled and parked, both long clips new, 2057/2058 failed."""
    import tempfile
    gb = 1024 ** 3
    led = {"2059 Summary.insv": {"day": 2059, "date": "2026-01-19", "seq": 2, "size": 0.4 * gb, "status": "pulled"},
           "2060 summary.insv": {"day": 2060, "date": "2026-01-20", "seq": 2, "size": 0.5 * gb, "status": "pulled"},
           "2059 Full.insv": {"day": 2059, "date": "2026-01-19", "seq": 1, "size": 6.4 * gb, "status": "new"},
           "2060 Full.insv": {"day": 2060, "date": "2026-01-20", "seq": 1, "size": 5.0 * gb, "status": "new"}}
    disk = tempfile.mkdtemp(prefix="od-jam-")
    for k in led:                                    # every copy on disk, so only the parking keeps the teasers out
        led[k]["local"] = os.path.join(disk, k); open(led[k]["local"], "wb").close()
    assert waits_for_bigger("2059 Summary.insv", led) and not waits_for_bigger("2059 Full.insv", led)
    assert choose_next(led, day=2059) == "2059 Full.insv", "the long clip is the next pull, never the teaser"
    assert pulled_in_queue(led) == 0 < MAX_PULLED, "the two parked teasers do not count against the pull limit (it read 2 and refused)"
    led["2059 Full.insv"]["status"] = "pulled"
    assert pulled_in_queue(led) == 1 and not waits_for_bigger("2060 summary.insv", {**led, "2060 Full.insv": {**led["2060 Full.insv"], "status": "rendered"}})
    shutil.rmtree(disk)
    led = {"2057 Full.insv": {"date": "2026-01-17", "episode": 2057, "size": 5.9 * gb, "status": "failed", "error": "name 'INTRO_LOCAL' is not defined", "local": "/w/2057 Full.insv"},
           "2057 Summary.insv": {"date": "2026-01-17", "episode": 2057, "size": 0.46 * gb, "status": "rendered", "local": "/w/2057 Summary.insv"},
           "VID_2194_teaser": {"date": "2026-01-17", "episode": 2194, "size": 0.3 * gb, "status": "rendered"},
           "2056 Summary.insv": {"date": "2026-01-16", "size": 0.4 * gb, "status": "rendered"},
           "2055 Full.insv": {"date": "2026-01-15", "size": 3 * gb, "status": "failed", "requeued": "2026-09-14T22:00:00"}}
    back = requeue_failed(led, now="2026-09-15T22:00:00")
    assert sorted(back) == ["2057 Full.insv", "2057 Summary.insv"], back
    assert led["2057 Full.insv"]["status"] == "new" and led["2057 Full.insv"]["last_error"].startswith("name") and "local" not in led["2057 Full.insv"]
    assert led["2057 Summary.insv"]["status"] == "new", "the teaser re-renders after its long clip so it carries the episode title"
    assert led["2056 Summary.insv"]["status"] == "rendered", "another day's clips are untouched"
    assert led["VID_2194_teaser"]["status"] == "rendered", "another episode recorded the same date is untouched (4 Jun 2026 holds 2194 and 2195)"
    assert led["2055 Full.insv"]["status"] == "failed", "a second failure stays failed (one retry only)"
    assert requeue_failed(led) == [], "nothing is put back twice"


def _selftest_part_order():
    led = {"2071 Full - Part 1.insv": {"day": 2071, "status": "new", "size": 1e9}, "2071 Full Part 2.insv": {"day": 2071, "status": "pulled", "size": 6e9},
           "013.insv": {"day": 2071, "date": "2026-02-01", "status": "pulled", "size": 5.6e8}, "014.insv": {"day": 2072, "date": "2026-02-01", "status": "new", "size": 6e9}}
    assert waits_for_bigger("2071 Full Part 2.insv", led), "part 2 waits for part 1 even when it is the bigger file"
    led["2071 Full - Part 1.insv"]["status"] = "pulled"
    assert not waits_for_bigger("2071 Full - Part 1.insv", led), "part 1 never waits for part 2"
    assert waits_for_bigger("013.insv", led), "the teaser waits for its own day's long clips"
    for k in ("2071 Full - Part 1.insv", "2071 Full Part 2.insv"): led[k]["status"] = "rendered"
    assert not waits_for_bigger("013.insv", led), "...and not for the next day's clip recorded the same morning"
    assert waits_for_bigger("b", {"a": {"date": "d", "status": "new", "size": 9}, "b": {"date": "d", "status": "pulled", "size": 1}}), "no day field: the date decides, as before"


def _selftest_leftovers():
    """24 Sep 2026: 34 GB of finished working copies refused 2072's pull. Driven on a temp folder."""
    import tempfile
    root = tempfile.mkdtemp(); work = os.path.join(root, "work"); att = os.path.join(root, "att")
    os.makedirs(os.path.join(work, "render_2060 Full")); os.makedirs(att)
    old = time.time() - 5 * 86400
    files = {"2060 Full.insv": 0, "2072 full.insv": 0, "2073 x.insv.part": old, "Ep2057_Summary_local.mp4": old,
             "upload_Ep2071_LFMD.mp4": 0, "VID_20260201_092348_00_013.insv": old}
    for n, t in files.items():
        f = os.path.join(work, n); open(f, "w").write("x" * 10)
        if t: os.utime(f, (t, t))
    open(os.path.join(work, "render_2060 Full", "master.mp4"), "w").write("x" * 5)
    stale = time.time() - 10 * 86400
    for n, t in {"Episode_2069_Full_Episode.mp4": 0, "Episode_2070_Full_Episode.mp4": old, "Episode_2054_Thumbnail.png": stale, "full": stale}.items():
        f = os.path.join(att, n); open(f, "w").write("y")
        if t: os.utime(f, (t, t))
    os.makedirs(os.path.join(work, "render_2071 Full - Part 1"))
    ledger = {"2060 Full.insv": {"status": "rendered"}, "2072 full.insv": {"status": "pulled"}, "VID_20260201_092348_00_013.insv": {"status": "new"},
              "2071 Full - Part 1.insv": {"status": "rendered", "keep_masters": os.path.join(work, "render_2071 Full - Part 1")}}
    pub = {"2069": {"podcast": {"status": "published"}}, "2070": {"podcast": {"status": "uploading"}}}
    gone = sorted(os.path.relpath(p, root) for p, _ in clear_leftovers(ledger, work, att, pub))
    assert gone == ["att/Episode_2054_Thumbnail.png", "att/Episode_2069_Full_Episode.mp4", "att/full", "work/2060 Full.insv",
                    "work/Ep2057_Summary_local.mp4", "work/render_2060 Full"], gone
    left = sorted(os.listdir(work))
    assert left == ["2072 full.insv", "2073 x.insv.part", "VID_20260201_092348_00_013.insv", "render_2071 Full - Part 1", "upload_Ep2071_LFMD.mp4"], \
        "a clip waiting to render, a pull in flight, part 1's kept masters and a fresh file stay: %s" % left
    assert os.listdir(att) == ["Episode_2070_Full_Episode.mp4"], "a podcast not out yet keeps its staged file"
    assert clear_leftovers(ledger, work, att, pub) == [], "nothing twice"
    shutil.rmtree(root)


def selftest():
    _selftest_airtable_retry()
    _selftest_jam_and_retry()
    _selftest_leftovers()
    _selftest_part_order()
    assert parse_clip("2053 Full.insv") == (dt.date(2026, 1, 13), "001000", 1) and parse_clip("2053 summary.insv")[0] == dt.date(2026, 1, 13)
    assert parse_clip("2071 Full Part 2.insv") == (dt.date(2026, 1, 31), "002000", 2) and parse_clip("2071 Full - Part 1.insv")[2] == 1
    globals()["START_DAY_FILE"] = "/nonexistent/od-start-day"; assert since_for_start_day() == DEFAULT_SINCE
    import tempfile; tf = os.path.join(tempfile.gettempdir(), "od-start-%d" % os.getpid()); open(tf, "w").write("2054\n"); globals()["START_DAY_FILE"] = tf
    assert start_day() == 2054 and since_for_start_day() == dt.date(2026, 1, 14), since_for_start_day(); os.remove(tf)
    import tempfile, shutil as _sh
    root = tempfile.mkdtemp(prefix="od-raw-")
    for rel in ("2026/28 December 2025 - 25 January 2026/2054 Full.insv", "2026/28 December 2025 - 25 January 2026/2054 summary.insv",
                "2025/25_05(May 2025)/Ep 1799 - May 4/VID_20250504_162936_00_022.insv", "4 June 26 - 19 July 26/VID_20260604_172435_00_001.insv", "Image/VID_20260604_000000_00_099.insv",
                "2026/26 Jan 26 - 1 Mar 26/2066 Full-Real.insv", "2026/26 Jan 26 - 1 Mar 26/2066 Full not.lrv", "2021/Trailer/VID_20210525_091635_10_038.insv"):
        os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True); open(os.path.join(root, rel), "wb").write(b"x")
    skipped = []
    got = list_clips(since=dt.date(2025, 1, 1), root=root, skipped=skipped)
    assert [c["name"] for c in got] == ["VID_20250504_162936_00_022.insv", "2054 Full.insv", "2054 summary.insv", "VID_20260604_172435_00_001.insv"], [c["name"] for c in got]
    assert got[1]["batch"].startswith("2026/") and "Image" not in str(got), "walks every depth, skips the Image folder"
    # 21 Sep 2026: "2066 Full-Real.insv" is listed, not dropped; a second-lens file and a proxy are not day clips
    assert skipped == [os.path.join("2026", "26 Jan 26 - 1 Mar 26", "2066 Full-Real.insv")], skipped
    sf = os.path.join(root, "skipped.json"); save_skipped_names(skipped, sf)
    assert skipped_names(sf, ruled={}) == skipped and skipped_names(os.path.join(root, "none.json")) is None
    rf = os.path.join(root, "ruled"); open(rf, "w").write("%s  # extra take, Kevin 21 Sep\n\n# a comment line\n" % skipped[0])
    rl = skip_rulings(rf)
    assert rl == {skipped[0]: "extra take, Kevin 21 Sep"}, rl
    assert skipped_names(sf, ruled=rl) == skipped[1:] and skipped_ruled(sf, ruled=rl) == [skipped[0]], "a file Kevin ruled on leaves the list, and is counted"
    assert skip_rulings(os.path.join(root, "absent")) == {} and skipped_ruled(os.path.join(root, "none.json"), ruled=rl) is None
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
    assert choose_next(led) == "c", "oldest date then the biggest clip (the long clip renders before its teaser)"
    assert choose_next({"x": {"date": "2026-01-01", "seq": 1, "status": "pulled"}}) is None
    _selftest_gap_order()
    gb = 1024 ** 3
    assert pull_window_minutes(2 * gb) == 40 and pull_window_minutes(4 * gb) == 40 and pull_window_minutes(18 * gb) == 180, "40 min per 4 GB, floor 40"
    led = {"g": {"day": 1799, "size": 18 * gb, "status": "new"}, "c": {"day": 2054, "size": 4 * gb, "status": "new"}}
    assert "SHORT by" in disk_line(led, 30 * gb) and "day 1799" in disk_line(led, 30 * gb) and "fits" in disk_line(led, 60 * gb) and "nothing waiting" in disk_line({}, 60 * gb)
    print(json.dumps({"checks": 55, "failed": []}))


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
    # 2 Oct 2026, the real night: 2081 sent back and set to re-render (render.redo_day stamps `reset`), 2084 and 2085 new.
    # It took slot 1 and 2085 lost its place. Kevin, 7 Oct 2026: the redo goes FIRST, and the new days still all render.
    rd = {"r1": {"day": 2081, "date": "2026-02-10", "seq": 1, "size": 1 * gb, "status": "new", "reset": "2 Oct 2026: Learnings cut from the wrong section"},
          "r2": {"day": 2081, "date": "2026-02-10", "seq": 2, "size": 1 * gb, "status": "new", "reset": "2 Oct 2026: Learnings cut from the wrong section"},
          "n1": {"day": 2084, "date": "2026-02-13", "seq": 1, "size": 1 * gb, "status": "new"}, "n2": {"day": 2085, "date": "2026-02-14", "seq": 1, "size": 1 * gb, "status": "new"},
          "n3": {"day": 2086, "date": "2026-02-15", "seq": 1, "size": 1 * gb, "status": "new"}}
    days, notes = plan(rd, 2, gaps=set(), free=100 * gb, start=2054)
    assert days == [2081, 2084, 2085], "a sent-back day renders first, never instead of a new one: %s" % days
    assert any("redo: day 2081" in n for n in notes), notes
    assert plan({k: v for k, v in rd.items() if k[0] == "r"}, 2, gaps=set(), free=100 * gb, start=2054)[0] == [2081], "with nothing new waiting the redo still renders"
    assert 2081 in plan(rd, 10 ** 6, gaps=set(), free=100 * gb, start=2054)[0], "the night still reaches it (content_report.stuck_sent_back asks this way)"
    assert plan(dict(rd, r1=dict(rd["r1"], status="rendered"), r2=dict(rd["r2"], status="rendered")), 2, gaps=set(), free=100 * gb, start=2054)[0] == [2084, 2085], "once re-rendered it is no longer waiting"
    # review, 2 Oct 2026: five sent-back days must not make a seven-render night; a sent-back gap day stays a gap day
    five = dict(rd, **{"x%d" % d: {"day": d, "date": "2026-02-01", "seq": 1, "size": 1 * gb, "status": "new", "reset": "x"} for d in (2075, 2077, 2079, 2080)})
    days, notes = plan(five, 2, gaps=set(), free=100 * gb, start=2054)
    assert days == [2075, 2084, 2085], "one redo a night at two slots, the oldest first: %s" % days
    assert sum("waits for another night" in n for n in notes) == 4, notes
    assert set(plan(five, 10 ** 6, gaps=set(), free=100 * gb, start=2054)[0]) >= {2075, 2077, 2079, 2080, 2081}, "every redo day is still reachable"
    only_redo = {k: v for k, v in five.items() if v.get("reset")}
    assert plan(only_redo, 2, gaps=set(), free=100 * gb, start=2054)[0] == [2075, 2077, 2079], "slots no new day filled go to waiting redo days"
    # Kevin, 2 Oct 2026: three a night. With a redo waiting it takes the spare slot (two new and the redo, three renders);
    # with none, three new days. Never fewer than two new.
    assert plan(rd, 3, gaps=set(), free=100 * gb, start=2054)[0] == [2081, 2084, 2085], "at three slots the redo takes the spare, first: %s" % plan(rd, 3, gaps=set(), free=100 * gb, start=2054)[0]
    assert plan({k: v for k, v in rd.items() if k[0] == "n"}, 3, gaps=set(), free=100 * gb, start=2054)[0] == [2084, 2085, 2086], "no redo waiting: three new days"
    assert plan(five, 3, gaps=set(), free=100 * gb, start=2054)[0] == [2075, 2084, 2085] and plan(five, 4, gaps=set(), free=100 * gb, start=2054)[0] == [2075, 2084, 2085, 2086], \
        "one redo a night at any slot count: %s" % plan(five, 4, gaps=set(), free=100 * gb, start=2054)[0]
    assert plan(rd, 1, gaps=set(), free=100 * gb, start=2054)[0] == [2081, 2084]
    # an older redo whose footage would not come down goes behind a younger one; two that both failed take turns
    stuck = dict(five, x2075=dict(five["x2075"], pull_failed="2026-10-01T23:10:00"))
    assert plan(stuck, 2, gaps=set(), free=100 * gb, start=2054)[0] == [2077, 2084, 2085], "the younger redo passes the one whose pull failed"
    both = dict(stuck, x2077=dict(five["x2077"], pull_failed="2026-10-02T23:10:00"), x2079=dict(five["x2079"], pull_failed="2026-09-30T23:10:00"),
                x2080=dict(five["x2080"], pull_failed="2026-10-02T23:20:00"), r1=dict(rd["r1"], pull_failed="2026-10-02T23:30:00"))
    assert plan(both, 2, gaps=set(), free=100 * gb, start=2054)[0] == [2079, 2084, 2085], "all failed: the least recently failed goes first"
    import tempfile as _tf
    wk = _tf.mkdtemp(); lp = {"c": {"day": 2081, "size": 10 ** 15, "status": "new", "reset": "x"}}
    # save_ledger and clear_leftovers are faked: unfaked, a short disk makes pull() run the REAL clean-up, which empties
    # the lane's staged-upload folder (2 Oct 2026: this check did exactly that on its first run, 25 files, 7.3 GB)
    real_save, real_clear = globals()["save_ledger"], globals()["clear_leftovers"]
    cleared = []
    globals()["save_ledger"] = lambda led: None; globals()["clear_leftovers"] = lambda ledger, work=None, **k: cleared.append(work) or []
    try:
        try: pull(lp, "c", wk); raise AssertionError("a clip bigger than the disk must be refused")
        except SystemExit: pass
        assert lp["c"].get("pull_failed") and lp["c"]["status"] == "new", "a refused pull is stamped, so the plan can let another redo pass: %s" % lp["c"]
        assert cleared == [wk], "the clean-up ran on the test's own folder only: %s" % cleared
    finally: globals()["save_ledger"], globals()["clear_leftovers"] = real_save, real_clear
    # the night's loop moves on when a clip does not come down, instead of asking for it six times (review, 2 Oct 2026)
    assert next_exit(rd, 2081, wk, pull_fn=lambda led, key, work: None) == NEXT_NOT_DELIVERED == 4, "an undelivered pull is not a success"
    assert next_exit(rd, 2081, wk, pull_fn=lambda led, key, work: "/tmp/clip") == 0
    import io as _io, contextlib as _cl
    with _cl.redirect_stdout(_io.StringIO()):                # the command's own lines, not the selftest's
        assert next_exit(rd, 1900, wk, pull_fn=lambda led, key, work: "/tmp/clip") == NEXT_DAY_DONE == 3 and next_exit({}, 0, wk) == 0
        # two clips already pulled (two rebuilds that failed after their pull): still 0, so the render drains them
        for p in ("p1", "p2"): open(os.path.join(wk, p), "wb").close()
        full = dict(rd, p1={"day": 2060, "date": "2026-01-20", "seq": 1, "size": gb, "status": "pulled", "local": os.path.join(wk, "p1")},
                    p2={"day": 2062, "date": "2026-01-22", "seq": 1, "size": gb, "status": "pulled", "local": os.path.join(wk, "p2")})
        asked = []
        assert pulled_in_queue(full) >= MAX_PULLED and next_exit(full, 2084, wk, pull_fn=lambda led, key, work: asked.append(key)) == 0 and asked == [], \
            "a full pull queue is a 0 with nothing pulled: the render that follows drains it"
        # A day whose only clip is pulled and still waiting is NOT done: the render has not taken it yet (review, 2 Oct
        # 2026: behind an older pulled clip, a one-clip day last in the night rendered a night late). Done once rendered.
        open(os.path.join(wk, "one"), "wb").close()
        oneday = {"older": dict(full["p1"]), "one": {"day": 2095, "date": "2026-03-06", "seq": 1, "size": gb, "status": "pulled", "local": os.path.join(wk, "one")}}
        assert next_exit(oneday, 2095, wk, pull_fn=lambda led, key, work: asked.append(key)) == 0 and asked == [], "its clip still waits: render it"
        oneday["one"]["status"] = "rendered"
        assert next_exit(oneday, 2095, wk, pull_fn=lambda led, key, work: asked.append(key)) == NEXT_DAY_DONE, "rendered: the day is done"
        oneday["one"].update(status="pulled", local=os.path.join(wk, "gone"))
        assert next_exit(oneday, 2095, wk) == NEXT_DAY_DONE, "a pulled clip with no file is not waiting (the scan's repair puts it back to new)"
    gapredo = dict(rd, g={"day": 1808, "date": "2025-05-13", "seq": 1, "size": 18 * gb, "status": "new", "reset": "x"})
    assert plan(gapredo, 2, gaps={1799, 1808}, free=100 * gb, start=2054)[0] == [2081, 2084, 1808], "a sent-back gap day takes its gap slot, as any gap day"
    assert plan(gapredo, 2, gaps={1799, 1808}, free=20 * gb, start=2054)[0] == [2081, 2084, 2085], "and still waits whole when its clip does not fit the disk"
    assert choose_next(led, day=2054) == "b" and choose_next(led, day=1808) == "g2" and choose_next(led, day=1900) is None
    pf = os.path.join(tempfile.gettempdir(), "od-gap-pause-%d" % os.getpid())
    assert not gaps_paused(pf); open(pf, "w").write("Kevin 15 Sep 2026\n"); assert gaps_paused(pf); os.remove(pf)
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
        sys.exit(next_exit(load_ledger(), a.day, a.work))
    elif a.mode == "report": report()
    else: raise SystemExit("unknown mode")
