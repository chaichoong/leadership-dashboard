#!/usr/bin/env python3
"""uk-gigs.py — email Kevin when an artist he listens to announces UK dates.

WHY (Kevin, 28 Sep 2026)
------------------------
"I always seem to miss some of the best artists because I'm not aware that
they're actually touring." This reads the artists in his Apple Music library,
looks up each one's UK dates on Ticketmaster once a week, and emails him the
new ones with the date, venue, city and booking link. No calendar entries and
no reminders: he asked for something that does not block his diary out.

WHICH ARTISTS
-------------
Music's scripting dictionary has no artist object, so the artists he has
favourited cannot be read. Kevin's choice: every library artist with at least
MIN_SONGS songs. A track counts for its album artist (its track artist when the
album artist is blank or "Various Artists"), with any "feat." part dropped. A
joint credit ("Bruce Springsteen & The E Street Band") also counts for each
name in it that is already an artist in its own right, so a band's live album
adds to the band, while "Crosby, Stills & Nash" is never split into "Crosby".

MATCHING IS BY IDENTITY, NEVER BY KEYWORD
-----------------------------------------
A keyword search for "Queen" returns every tribute act with Queen in its name.
So an artist is matched only to a Ticketmaster attraction whose NAME is the
same once case, punctuation and a leading "The" are ignored, and gigs are then
fetched by that attraction's id. A tribute band has its own id and never
appears. An artist with no exact match is listed at the foot of every email as
"not found on Ticketmaster", so a gap is visible rather than read as "not
touring".

TRIBUTE SHOWS (Kevin, 28 Sep 2026)
----------------------------------
For favourite bands that can no longer tour, the best UK tribute acts, chosen
once by research, live in the private ~/knowledge-os/logs/uk-gigs/tributes.json
({band: [act, ...]}). Each act is matched and looked up exactly like an artist,
and its gigs go in their own section headed "<band>, played by <act>
(tribute)", capped at the next TRIBUTE_SHOWN dates plus a link to the rest. A
tribute show is never listed under the band's own name.

ABSENCE IS REPORTED
-------------------
A job that stops working looks exactly like a quiet month. So a month with no
new gigs still gets one email saying what was checked, the run FAILS (and
run-job.sh raises it) when Ticketmaster resolves almost none of the artists,
and the library read fails loudly on zero tracks.

WEEKLY, FROM A DAILY TRIGGER
----------------------------
launchd fires this daily; the check itself runs once 7 calendar days have
passed since the last good one. A Monday the Mac slept through is caught up on
Tuesday instead of lost for a week, and no weekday ever sits in a schedule.

Nothing personal lives in this repo. The artist list, the gigs already told
and the run log are private, in ~/knowledge-os/logs/uk-gigs/. The Ticketmaster
key is read from ~/.config/od/ticketmaster_api_key and never printed.

Usage:
  uk-gigs.py run                  the daily trigger: checks only when one is due
  uk-gigs.py check [--dry-run]    check now; --dry-run prints the email, sends
                                  nothing and changes no state
  uk-gigs.py library [--min N]    the artist list from Music, and its size at
                                  3, 5 and 10 songs
  uk-gigs.py selftest             offline checks of the rules
"""

import collections
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

MIN_SONGS = 5                  # Kevin, 28 Sep 2026: 114 artists on the day
CHECK_EVERY_DAYS = 7           # weekly (Kevin, 28 Sep 2026)
COUNTRY = "GB"
MIN_RESOLVED_SHARE = 0.3       # below this, the lookup is broken, not the artists
TOLD_KEEP_DAYS = 400           # forget a told gig this long after first seeing it

API = "https://app.ticketmaster.com/discovery/v2"
KEY_PATH = os.path.expanduser("~/.config/od/ticketmaster_api_key")
LOGDIR = os.path.expanduser("~/knowledge-os/logs/uk-gigs")
STATE = os.path.join(LOGDIR, "state.json")
RUNS = os.path.join(LOGDIR, "runs.jsonl")
LATEST = os.path.join(LOGDIR, "latest.json")
TRIBUTES = os.path.join(LOGDIR, "tributes.json")
TRIBUTE_SHOWN = 5              # next dates listed per tribute act; the rest are one link
SEND_EMAIL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "send-email.py")
SUBJECT_PREFIX = "UK gigs:"    # registered in send-email.py SELF_NOTE_PREFIXES

NOT_AN_ARTIST = {"various artists", "various", "va", "unknown artist", "soundtrack"}
FEAT = re.compile(r"\s*[\(\[]?\s*\b(feat\.?|ft\.?|featuring)\s.*$", re.I)
JOINT = re.compile(r"\s*(?:,|&|\band\b|\bx\b|\+|\bwith\b)\s*", re.I)

STATUS_WORDS = {"onsale": "on sale", "offsale": "sold out or off sale",
                "rescheduled": "rescheduled", "postponed": "postponed"}

READ_LIBRARY = r'''
set wasRunning to application "Music" is running
with timeout of 300 seconds
	tell application "Music"
		set a to artist of every track of library playlist 1
		set b to album artist of every track of library playlist 1
	end tell
end timeout
set out to {}
repeat with i from 1 to count of a
	set end of out to ((item i of a) as text) & tab & ((item i of b) as text)
end repeat
if not wasRunning then tell application "Music" to quit
set AppleScript's text item delimiters to linefeed
return out as text
'''


# --------------------------------------------------------------------------
# Library: which artists count (pure apart from read_library)
# --------------------------------------------------------------------------

def read_library():
    """[(artist, album_artist)] for every track in the Music library."""
    p = subprocess.run(["/usr/bin/osascript"], input=READ_LIBRARY, capture_output=True,
                       text=True, timeout=360)
    if p.returncode != 0:
        raise RuntimeError("could not read the Music library: %s" % p.stderr.strip())
    rows = []
    for line in p.stdout.splitlines():
        if line.strip():
            artist, _, album_artist = line.partition("\t")
            rows.append((artist, album_artist))
    return rows


def primary_name(artist, album_artist):
    """The name a track counts for: album artist, else track artist, minus 'feat.'."""
    name = (album_artist or "").strip()
    if not name or name.lower() in NOT_AN_ARTIST:
        name = (artist or "").strip()
    return FEAT.sub("", name).strip()


def count_artists(rows):
    """Counter of songs per artist, joint credits added to their standalone names."""
    whole = collections.Counter()
    for artist, album_artist in rows:
        name = primary_name(artist, album_artist)
        if name and name.lower() not in NOT_AN_ARTIST:
            whole[name] += 1
    counts = collections.Counter(whole)
    solo = {norm(n): n for n in whole}
    for name, n in whole.items():
        parts = [p for p in JOINT.split(name) if p.strip()]
        if len(parts) < 2:
            continue
        owners = {solo[norm(p)] for p in parts if norm(p) in solo and solo[norm(p)] != name}
        for own in owners:
            counts[own] += n
        if owners:
            # "Sting & The Police" is The Police and Sting, already checked by
            # name; kept as well, it would be a third lookup for the same people.
            del counts[name]
    return counts


def pick_artists(counts, min_songs=MIN_SONGS):
    return sorted((n for n, c in counts.items() if c >= min_songs), key=str.lower)


# --------------------------------------------------------------------------
# Matching a library name to a Ticketmaster attraction
# --------------------------------------------------------------------------

def norm(name):
    """'The Pretenders' == 'Pretenders', 'R.E.M.' == 'REM', 'Rag’n’Bone Man' == "Rag'n'Bone Man"."""
    s = re.sub(r"[.'’‘`]", "", name or "")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " and ").replace("+", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    s = re.sub(r"^the ", "", s)
    return re.sub(r"\s+", " ", s).strip()


def is_music(obj):
    for c in obj.get("classifications") or []:
        if ((c.get("segment") or {}).get("name") or "").lower() == "music":
            return True
    return False


def exact_attractions(name, attractions):
    """The attractions that ARE this artist: same normalised name, music segment."""
    want = norm(name)
    return [a for a in attractions if want and norm(a.get("name")) == want and is_music(a)]


def gig_from_event(ev, artist):
    """One gig line from a Discovery API event, or None when it is not a gig to show."""
    if not is_music(ev):
        return None                       # parking, hotel and other add-on listings
    dates = ev.get("dates") or {}
    status = ((dates.get("status") or {}).get("code") or "").lower()
    if status == "cancelled":
        return None
    start = dates.get("start") or {}
    venue = ((ev.get("_embedded") or {}).get("venues") or [{}])[0]
    return {
        "id": ev.get("id"),
        "artist": artist,
        "name": ev.get("name") or "",
        "date": start.get("localDate") or "",
        "time": (start.get("localTime") or "")[:5],
        "venue": venue.get("name") or "",
        "city": (venue.get("city") or {}).get("name") or "",
        "status": status,
        "onsale": ((ev.get("sales") or {}).get("public") or {}).get("startDateTime") or "",
        "url": ev.get("url") or "",
    }


# --------------------------------------------------------------------------
# Ticketmaster
# --------------------------------------------------------------------------

def read_key(path=KEY_PATH):
    try:
        with open(path) as fh:
            key = fh.read().strip()
    except FileNotFoundError:
        raise SystemExit("ERROR: no Ticketmaster key at %s" % path)
    if not re.fullmatch(r"[A-Za-z0-9]{16,64}", key):
        raise SystemExit("ERROR: the file at %s does not hold a Ticketmaster key" % path)
    return key


class Ticketmaster:
    def __init__(self, key, pause=0.25):
        self.key = key
        self.pause = pause                # the API allows 5 calls a second
        self.calls = 0

    def get(self, path, **params):
        shown = "%s?%s" % (path, urllib.parse.urlencode(params))   # never the key
        url = "%s/%s?%s" % (API, path, urllib.parse.urlencode(dict(params, apikey=self.key)))
        req = urllib.request.Request(url, headers={"User-Agent": "kb-uk-gigs/1.0",
                                                   "Accept": "application/json"})
        for attempt in range(4):
            time.sleep(self.pause)
            self.calls += 1
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return json.loads(r.read())
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 3:
                    time.sleep(2 * (attempt + 1))
                    continue
                if e.code in (401, 403):
                    raise SystemExit("ERROR: Ticketmaster refused the key (%s) on %s"
                                     % (e.code, shown))
                raise RuntimeError("Ticketmaster %s on %s" % (e.code, shown))
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt < 3:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise RuntimeError("Ticketmaster unreachable on %s: %s" % (shown, e))
        raise RuntimeError("Ticketmaster kept rate-limiting %s" % shown)

    def attractions(self, name):
        data = self.get("attractions.json", keyword=name, size=100, locale="*")
        return (data.get("_embedded") or {}).get("attractions") or []

    def events(self, attraction_id):
        """Every UK event for one attraction, following every page."""
        out, page = [], 0
        while True:
            data = self.get("events.json", attractionId=attraction_id, countryCode=COUNTRY,
                            size=200, page=page, sort="date,asc", locale="*")
            out += (data.get("_embedded") or {}).get("events") or []
            pages = (data.get("page") or {}).get("totalPages") or 0
            page += 1
            if page >= pages:
                return out
            if page >= 5:
                raise RuntimeError("more than 1,000 UK events for attraction %s" % attraction_id)


def look_up(artists, tm, today):
    """{artist: {"ids": [...], "gigs": [...]}} plus the artists with no exact match."""
    found, missing, errors = {}, [], []
    for artist in artists:
        try:
            matches = exact_attractions(artist, tm.attractions(artist))
        except RuntimeError as e:
            errors.append("%s: %s" % (artist, e))
            continue
        if not matches:
            missing.append(artist)
            continue
        gigs, seen = [], set()
        for a in matches:
            upcoming = (a.get("upcomingEvents") or {}).get("_total")
            if upcoming == 0:
                continue
            try:
                events = tm.events(a["id"])
            except RuntimeError as e:
                errors.append("%s: %s" % (artist, e))
                continue
            for ev in events:
                g = gig_from_event(ev, artist)
                if g and g["id"] not in seen and g["date"] >= today.isoformat():
                    seen.add(g["id"])
                    gigs.append(g)
        found[artist] = {"ids": [a["id"] for a in matches],
                         "url": next((a.get("url") for a in matches if a.get("url")), ""),
                         "gigs": sorted(gigs, key=lambda g: (g["date"], g["time"]))}
    return found, missing, errors


def load_tributes(path=TRIBUTES):
    """{band: [tribute act, ...]}: private, chosen once by research (Kevin, 28 Sep 2026)."""
    try:
        with open(path) as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    return {band: [a for a in acts if a] for band, acts in data.items() if not band.startswith("_")}


def tribute_gigs(found, acts):
    """Tag each tribute act's gigs with the band it plays, so they never pass as the band."""
    out = []
    for act, v in found.items():
        for g in v["gigs"]:
            out.append(dict(g, tribute_to=acts[act], act_url=v.get("url") or ""))
    return out


# --------------------------------------------------------------------------
# The decision and the email (pure: no clock, no disk, no network)
# --------------------------------------------------------------------------

def check_due(state, today):
    last = state.get("last_good_check")
    if not last:
        return True
    return (today - dt.date.fromisoformat(last)).days >= CHECK_EVERY_DAYS


def decide(state, gigs, today):
    """Which email this check sends: {"kind": starting|new|heartbeat|None, "new": [...]}."""
    told = state.get("told") or {}
    new = [g for g in gigs if g["id"] not in told]
    if not state.get("last_good_check"):
        return {"kind": "starting", "new": new}
    if new:
        return {"kind": "new", "new": new}
    if state.get("last_email_month") != today.strftime("%Y-%m"):
        return {"kind": "heartbeat", "new": []}
    return {"kind": None, "new": []}


def after_check(state, gigs, today, emailed):
    """The state to save once a check has worked (and its email, if any, went)."""
    told = dict(state.get("told") or {})
    for g in gigs:
        told.setdefault(g["id"], today.isoformat())
    cutoff = (today - dt.timedelta(days=TOLD_KEEP_DAYS)).isoformat()
    told = {k: v for k, v in told.items() if v >= cutoff}
    out = dict(state, told=told, last_good_check=today.isoformat())
    if emailed:
        out["last_email_month"] = today.strftime("%Y-%m")
    return out


def nice_date(iso):
    try:
        d = dt.date.fromisoformat(iso)
    except ValueError:
        return iso or "date to be announced"
    return "%s %d %s %d" % (d.strftime("%a"), d.day, d.strftime("%b"), d.year)


def status_words(g, today):
    onsale = (g.get("onsale") or "")[:10]
    if onsale and onsale > today.isoformat() and g["status"] in ("onsale", "offsale", ""):
        return "on sale from %s" % nice_date(onsale)
    return STATUS_WORDS.get(g["status"], g["status"] or "status not given")


def heading(g):
    """A tribute show always names the band it plays AND the act, never the band alone."""
    if g.get("tribute_to"):
        return "%s, played by %s (tribute)" % (g["tribute_to"], g["artist"])
    return g["artist"]


def gig_lines(gigs, today, cap=None):
    """Gigs grouped under their heading. With `cap`, each group lists its next `cap`
    dates and points to the act's own page for the rest."""
    groups = collections.OrderedDict()
    for g in sorted(gigs, key=lambda g: (heading(g).lower(), g["date"], g["time"])):
        groups.setdefault(heading(g), []).append(g)
    lines = []
    for head, group in groups.items():
        lines += ["", head]
        shown = group[:cap] if cap else group
        for g in shown:
            when = nice_date(g["date"]) + (", " + g["time"] if g["time"] else "")
            place = ", ".join(p for p in (g["venue"], g["city"]) if p)
            lines.append("  %s - %s - %s" % (when, place, status_words(g, today)))
            if g["url"]:
                lines.append("  Book: %s" % g["url"])
        rest = len(group) - len(shown)
        if rest:
            more = group[0].get("act_url")
            lines.append("  and %d more UK date%s%s" % (rest, "" if rest == 1 else "s",
                                                        ": " + more if more else ""))
    return lines


def compose(kind, new, gigs, summary, today):
    """(subject, body) for one email. Plain text: the worker sends text."""
    real = [g for g in gigs if not g.get("tribute_to")]
    trib = [g for g in gigs if g.get("tribute_to")]
    new_real = [g for g in new if not g.get("tribute_to")]
    new_trib = [g for g in new if g.get("tribute_to")]
    artists_with = sorted({g["artist"] for g in real}, key=str.lower)
    if kind == "starting":
        subject = "%s starting list, %d dates from %d artists" % (
            SUBJECT_PREFIX, len(real), len(artists_with))
        if trib:
            subject += ", %d tribute shows" % len(trib)
    elif kind == "new":
        if new_real:
            names = sorted({g["artist"] for g in new_real}, key=str.lower)
            subject = "%s %d new (%s)" % (SUBJECT_PREFIX, len(new_real),
                                          ", ".join(names[:3]) + (" and more" if len(names) > 3 else ""))
            if new_trib:
                subject += " + %d tribute show%s" % (len(new_trib), "" if len(new_trib) == 1 else "s")
        else:
            bands = sorted({g["tribute_to"] for g in new_trib}, key=str.lower)
            subject = "%s %d new tribute show%s (%s)" % (
                SUBJECT_PREFIX, len(new_trib), "" if len(new_trib) == 1 else "s", ", ".join(bands[:3]))
    else:
        subject = "%s nothing new this month, %d dates still ahead" % (SUBJECT_PREFIX, len(gigs))

    body = []
    if kind == "new":
        if new_real:
            body += ["NEW UK GIGS SINCE THE LAST CHECK (%d)" % len(new_real)]
            body += gig_lines(new_real, today) + ["", ""]
        if new_trib:
            body += ["NEW TRIBUTE SHOWS (%d)" % len(new_trib)]
            body += gig_lines(new_trib, today) + ["", ""]
    elif kind == "heartbeat":
        body += ["No new UK dates since the last check. The job is working: "
                 "what it checked is at the bottom.", "", ""]
    if real:
        body += ["ALL UPCOMING UK GIGS (%d dates, %d artists)" % (len(real), len(artists_with))]
        body += gig_lines(real, today)
    else:
        body += ["No UK dates found for any of your artists right now."]
    if trib:
        body += ["", "", "TRIBUTE SHOWS FOR BANDS THAT NO LONGER TOUR (%d dates)" % len(trib)]
        body += gig_lines(trib, today, cap=TRIBUTE_SHOWN)
    missing = summary["missing"]
    body += ["", "", "WHAT WAS CHECKED",
             "%d artists with %d or more songs in your Apple Music library."
             % (summary["artists"], summary["min_songs"]),
             "%d found on Ticketmaster, %d of them with UK dates."
             % (summary["found"], len(artists_with))]
    if missing:
        body.append("Not found on Ticketmaster (%d): %s." % (len(missing), ", ".join(missing)))
    if summary.get("tribute_acts"):
        body.append("Tribute acts checked: %d." % summary["tribute_acts"])
    if summary.get("tribute_missing"):
        body.append("Tribute acts not found on Ticketmaster: %s."
                    % ", ".join(summary["tribute_missing"]))
    if summary.get("errors"):
        body.append("Lookup failed for %d, tried again next week: %s."
                    % (len(summary["errors"]), ", ".join(e.split(":")[0] for e in summary["errors"])))
    body += ["Ticketmaster only: gigs sold only through See Tickets, DICE, AXS or Skiddle "
             "are not in this list.",
             "Next check: %s." % nice_date((today + dt.timedelta(days=CHECK_EVERY_DAYS)).isoformat())]
    return subject, "\n".join(body).strip() + "\n"


# --------------------------------------------------------------------------
# State (private, outside the repo)
# --------------------------------------------------------------------------

def load_state(path=STATE):
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {}


def save_json(obj, path):
    """Temp file then rename, so a reader never sees a half-written file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh, indent=1)
    os.replace(tmp, path)


def send(subject, body, key):
    """Hand the email to send-email.py self-note, which can only mail Kevin."""
    p = subprocess.run([sys.executable, SEND_EMAIL, "self-note", "--key", key,
                        "--subject", subject], input=body, capture_output=True, text=True,
                       timeout=120)
    if p.returncode != 0:
        raise RuntimeError("email not sent: %s" % (p.stderr.strip() or p.stdout.strip()))
    return json.loads(p.stdout.strip().splitlines()[-1])


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def do_check(today, dry_run=False):
    rows = read_library()
    if not rows:
        raise SystemExit("ERROR: the Music library read returned no tracks")
    counts = count_artists(rows)
    artists = pick_artists(counts)
    if not artists:
        raise SystemExit("ERROR: no artist has %d or more songs; the read is wrong" % MIN_SONGS)
    tm = Ticketmaster(read_key())
    found, missing, errors = look_up(artists, tm, today)
    checked = len(found) + len(missing)
    if checked == 0 or len(found) < MIN_RESOLVED_SHARE * len(artists):
        raise SystemExit("ERROR: Ticketmaster matched %d of %d artists (%d lookups failed). "
                         "That is the lookup breaking, not the artists." %
                         (len(found), len(artists), len(errors)))
    gigs = [g for v in found.values() for g in v["gigs"]]
    acts = {act: band for band, names in load_tributes().items() for act in names}
    t_found, t_missing, t_errors = look_up(sorted(acts), tm, today) if acts else ({}, [], [])
    t_gigs = tribute_gigs(t_found, acts)
    summary = {"artists": len(artists), "min_songs": MIN_SONGS, "found": len(found),
               "missing": missing, "errors": errors + t_errors,
               "tribute_acts": len(acts), "tribute_missing": t_missing}
    state = load_state()
    choice = decide(state, gigs + t_gigs, today)
    print("checked %d artists (%d tracks): %d on Ticketmaster, %d with UK dates, %d dates, "
          "%d tribute dates from %d acts, %d new, %d not found, %d failed, %d API calls"
          % (len(artists), len(rows), len(found), len({g["artist"] for g in gigs}), len(gigs),
             len(t_gigs), len(acts), len(choice["new"]), len(missing), len(errors) + len(t_errors),
             tm.calls))
    gigs = gigs + t_gigs
    emailed = False
    if choice["kind"]:
        subject, body = compose(choice["kind"], choice["new"], gigs, summary, today)
        if dry_run:
            print("\nWOULD EMAIL: %s\n\n%s" % (subject, body))
        else:
            result = send(subject, body, "uk-gigs:%s" % today.isoformat())
            print("emailed: %s (%s)" % (subject, result.get("messageId") or result.get("skipped")))
            emailed = True
    else:
        print("no email: nothing new and this month's email has gone")
    if dry_run:
        return 0
    save_json(after_check(state, gigs, today, emailed), STATE)
    save_json({"checked": today.isoformat(), "artists": artists, "found": found,
               "missing": missing, "errors": errors, "tributes": t_found,
               "tribute_missing": t_missing, "tribute_errors": t_errors}, LATEST)
    os.makedirs(LOGDIR, exist_ok=True)
    with open(RUNS, "a") as fh:
        fh.write(json.dumps({"ts": dt.datetime.now().isoformat(timespec="seconds"),
                             "artists": len(artists), "found": len(found), "gigs": len(gigs),
                             "tribute_gigs": len(t_gigs), "new": len(choice["new"]),
                             "email": choice["kind"], "missing": len(missing),
                             "errors": len(errors) + len(t_errors), "calls": tm.calls}) + "\n")
    return 0


def cmd_run(today):
    if not check_due(load_state(), today):
        print("not due: last good check %s" % load_state().get("last_good_check"))
        return 0
    return do_check(today)


def cmd_library(min_songs):
    rows = read_library()
    counts = count_artists(rows)
    print("%d tracks, %d artists" % (len(rows), len(counts)))
    for t in (3, 5, 10):
        print("  %2d or more songs: %d artists" % (t, len(pick_artists(counts, t))))
    for name in pick_artists(counts, min_songs):
        print("  %4d  %s" % (counts[name], name))
    return 0


def selftest():
    today = dt.date(2026, 9, 28)
    fails = []

    def check(label, got, want):
        if got != want:
            fails.append("%s: got %r want %r" % (label, got, want))

    check("album artist wins", primary_name("Stevie Nicks", "Fleetwood Mac"), "Fleetwood Mac")
    check("various artists falls back", primary_name("Oasis", "Various Artists"), "Oasis")
    check("feat. dropped", primary_name("Calvin Harris feat. Rihanna", ""), "Calvin Harris")
    rows = ([("Bruce Springsteen", "")] * 3 + [("Bruce Springsteen & The E Street Band", "")] * 2
            + [("Crosby, Stills & Nash", "")] * 5 + [("x", "Various Artists")])
    c = count_artists(rows)
    check("joint credit adds to the solo artist", c["Bruce Springsteen"], 5)
    check("a group is never split into parts", c.get("Crosby", 0), 0)
    check("threshold", pick_artists(c, 5), ["Bruce Springsteen", "Crosby, Stills & Nash"])
    check("a joint credit folded into its solo artist is not looked up twice",
          "Bruce Springsteen & The E Street Band" in c, False)
    check("the / punctuation ignored", norm("The Pretenders") == norm("Pretenders"), True)
    check("REM", norm("R.E.M.") == norm("REM"), True)
    check("curly apostrophe", norm("Rag’n’Bone Man") == norm("Rag'n'Bone Man"), True)
    music = [{"segment": {"name": "Music"}}]
    atts = [{"id": "t1", "name": "Bohemian Rhapsody - A Tribute to Queen", "classifications": music},
            {"id": "q1", "name": "Queen", "classifications": music},
            {"id": "q2", "name": "Queen", "classifications": [{"segment": {"name": "Film"}}]}]
    check("tribute acts and non-music never match", [a["id"] for a in exact_attractions("Queen", atts)], ["q1"])

    g1 = {"id": "e1", "artist": "Queen", "date": "2027-03-14", "time": "19:30", "venue": "The O2",
          "city": "London", "status": "onsale", "onsale": "", "url": "https://t/e1"}
    g2 = dict(g1, id="e2", date="2027-03-15")
    check("first check sends the starting list", decide({}, [g1], today)["kind"], "starting")
    st = after_check({}, [g1], today, True)
    check("told after a check", sorted(st["told"]), ["e1"])
    later = today + dt.timedelta(days=7)
    check("only the new gig is new", [g["id"] for g in decide(st, [g1, g2], later)["new"]], ["e2"])
    check("nothing new in the same month sends nothing",
          decide(st, [g1], dt.date(2026, 9, 30))["kind"], None)
    check("nothing new in a new month sends the heartbeat",
          decide(st, [g1], dt.date(2026, 10, 5))["kind"], "heartbeat")
    check("not due inside 7 days", check_due(st, today + dt.timedelta(days=6)), False)
    check("due on day 7", check_due(st, later), True)
    check("never checked is due", check_due({}, today), True)

    ev = {"id": "e9", "name": "Queen", "classifications": music,
          "dates": {"start": {"localDate": "2027-01-02", "localTime": "19:00:00"},
                    "status": {"code": "onsale"}},
          "_embedded": {"venues": [{"name": "AO Arena", "city": {"name": "Manchester"}}]},
          "sales": {"public": {"startDateTime": "2026-10-02T09:00:00Z"}}, "url": "https://t/e9"}
    g = gig_from_event(ev, "Queen")
    check("event parsed", (g["venue"], g["city"], g["time"]), ("AO Arena", "Manchester", "19:00"))
    check("future on-sale date shown", status_words(g, today), "on sale from Fri 2 Oct 2026")
    check("parking listing dropped",
          gig_from_event(dict(ev, classifications=[{"segment": {"name": "Miscellaneous"}}]), "Queen"), None)
    check("cancelled dropped",
          gig_from_event(dict(ev, dates=dict(ev["dates"], status={"code": "cancelled"})), "Queen"), None)

    summary = {"artists": 2, "min_songs": 5, "found": 1, "missing": ["Nobody"], "errors": []}
    subject, body = compose("new", [g2], [g1, g2], summary, later)
    check("subject names the artist", subject, "UK gigs: 1 new (Queen)")
    check("body says who was not found", "Not found on Ticketmaster (1): Nobody." in body, True)
    check("body carries the booking link", "Book: https://t/e1" in body, True)
    check("subject prefix is the registered one", subject.startswith(SUBJECT_PREFIX), True)

    # Tribute shows: own section, always named as tribute, never in the real list.
    t = [dict(g1, id="t%d" % i, artist="Rumours of Fleetwood Mac", tribute_to="Fleetwood Mac",
              date="2027-04-%02d" % (i + 1), act_url="https://t/rofm") for i in range(7)]
    subject, body = compose("new", t[:1], [g1] + t, summary, later)
    check("tribute-only subject", subject, "UK gigs: 1 new tribute show (Fleetwood Mac)")
    real_part = body.split("TRIBUTE SHOWS FOR BANDS")[0].split("ALL UPCOMING UK GIGS")[1]
    check("tribute never in the real list", "Rumours" in real_part, False)
    check("tribute heading names band and act",
          "Fleetwood Mac, played by Rumours of Fleetwood Mac (tribute)" in body, True)
    check("tribute list capped with a link to the rest",
          "and 2 more UK dates: https://t/rofm" in body, True)

    if fails:
        print("selftest FAILED")
        for f in fails:
            print("  " + f)
        return 1
    print("selftest OK")
    return 0


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "run"
    today = dt.date.today()
    if cmd == "run":
        return cmd_run(today)
    if cmd == "check":
        return do_check(today, dry_run="--dry-run" in args)
    if cmd == "library":
        n = MIN_SONGS
        if "--min" in args:
            n = int(args[args.index("--min") + 1])
        return cmd_library(n)
    if cmd == "selftest":
        return selftest()
    print(__doc__)
    return 64


if __name__ == "__main__":
    sys.exit(main())
