#!/usr/bin/env python3
"""Today's sport from Kevin's diary, for the What to wear card (Kevin, 3 Nov 2026).

WHY THIS EXISTS
The card offers Football training (the touchline) and Padel every day. On the days they are in
Kevin's calendar it should say so: "Padel 19:30". The browser cannot read his calendar (the repo
is public, so it holds no Google key), so this job reads it on the Mac and leaves ONE Estate
Status row (key sport-day) that the card reads with the Airtable token it already has.

WHAT IT READS AND WRITES
  * Reads today's events from the drive-upload worker's POST /calendar/day, for each account in
    ACCOUNTS (the read-class triage key, ~/.config/od/gmail_triage_key; titles and times only).
  * Writes the Estate Status row: the option and start time of each sport event, never the title
    (the diary stays out of Airtable). Detail is the line a person reads, e.g. "Padel 19:30".
  * Nothing else: no diary write, no email, no task.

THE RULES (classify)
  Padel             any title containing "padel" (or "paddle").
  Football training a title naming Wolves, Willingham or football; a title that is just "Training"
                    or "Training (place)"; or an age group ("U16", "Under 11s") TOGETHER with a
                    league, cup or fixture. A lone "U2" is a property unit, a lone "Cup" a coffee,
                    "Training: fire safety" a course, and "Winter Net Training" cricket nets: none count.

USAGE
  python3 scripts/sport-calendar.py run        # read today, write the row (the hourly job)
  python3 scripts/sport-calendar.py show       # read today and print, write nothing
  python3 scripts/sport-calendar.py selftest   # offline checks of the rules
Exit 1 when no account could be read: the row then says Failed, never "no sport today".
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

WORKER = "https://drive-upload.kevinbrittain.workers.dev"
SPORT_ACCOUNT = "kevin@runpreneur.org.uk"   # the padel and Wolves entries live here (read 3 Nov 2026): its read must work
ACCOUNTS = [SPORT_ACCOUNT, "kevinbrittain@gmail.com"]
BASE = "appnqjDpqDniH3IRl"
T_ESTATE = "tblZVrdzivyBueZVf"
STATUS_KEY = "sport-day"   # not the job's name: estate-status.py keeps a JOB row keyed sport-calendar
ES = {"key": "fldLO6xJqkokvVR4g", "kind": "fldfjQOn76VpgKEfZ", "label": "fldlnvvTh8l5UIih4",
      "schedule": "fldZGa0UD76lVLww7", "status": "fldhOUiva3bqPNk1c", "lastRun": "flduxV3TYwp9wQX9O",
      "lastWorked": "fldMIx3kWMM23vDBN", "detail": "fldLRFP2nJttDVQOa", "payload": "fldiqs9lvyLimoR7i",
      "updated": "fld3q8WN5XqrER92Z"}
LONDON = ZoneInfo("Europe/London")

PADEL = re.compile(r"\bpadd?el\b", re.I)
NETS = re.compile(r"\bnets?\b", re.I)
CLUB = re.compile(r"\bwolves\b|\bwillingham\b|\bfootball\b", re.I)
SESSION = re.compile(r"^\s*training\s*(\([^)]*\))?\s*$", re.I)
AGE = re.compile(r"\bu\s?\d{1,2}s?\b|\bunder[ -]?\d{1,2}s?\b", re.I)
COMPETITION = re.compile(r"\bleague\b|\bcup\b|\bfixture\b", re.I)


def classify(title):
    """The card option an event belongs to, or None."""
    t = title or ""
    if PADEL.search(t):
        return "Padel"
    if NETS.search(t):
        return None
    if CLUB.search(t) or SESSION.search(t) or (AGE.search(t) and COMPETITION.search(t)):
        return "Football training"
    return None


def sessions(events):
    """[{option, start}] for the sport events, earliest first, one per option and start time."""
    out, seen = [], set()
    for e in events:
        option = classify(e.get("title"))
        if not option:
            continue
        start = "" if e.get("allDay") else str(e.get("start") or "")[11:16]
        if (option, start) in seen:
            continue
        seen.add((option, start))
        out.append({"option": option, "start": start})
    return sorted(out, key=lambda s: (s["start"] or "99:99", s["option"]))


def line(found):
    if not found:
        return "No padel or football in the diary today."
    return "; ".join(f"{s['option']} {s['start'] or 'all day'}" for s in found)


# ─── reading and writing ────────────────────────────────────────────
def _key(name):
    with open(os.path.expanduser(f"~/.config/od/{name}")) as f:
        return f.read().strip()


def read_day(account, date):
    req = urllib.request.Request(WORKER + "/calendar/day", data=json.dumps({"date": date, "account": account}).encode(),
                                 method="POST", headers={"Authorization": "Bearer " + _key("gmail_triage_key"),
                                                         "Content-Type": "application/json", "User-Agent": "od-estate/1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["events"]


def api(method, path, payload=None, params=None):
    url = f"https://api.airtable.com/v0/{BASE}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(payload).encode() if payload is not None else None
    for attempt in range(4):
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": "Bearer " + _key("airtable_pat"), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise RuntimeError(f"Airtable {method} {path} {e.code}: {e.read().decode()[:300]}")   # never the headers


def write_row(status, text, payload, now):
    stamp = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    fields = {ES["key"]: STATUS_KEY, ES["kind"]: "report", ES["label"]: "Today's sport (What to wear)",
              ES["schedule"]: "Hourly 06:05 to 22:05", ES["status"]: status, ES["lastRun"]: stamp,
              ES["detail"]: text, ES["payload"]: json.dumps(payload), ES["updated"]: stamp}
    if status != "Failed":
        fields[ES["lastWorked"]] = stamp
    have = api("GET", T_ESTATE, params={"filterByFormula": f"{{Key}}='{STATUS_KEY}'", "pageSize": 1})
    recs = have.get("records") or []
    if recs:
        api("PATCH", T_ESTATE, {"records": [{"id": recs[0]["id"], "fields": fields}], "typecast": True})
    else:
        api("POST", T_ESTATE, {"records": [{"fields": fields}], "typecast": True})


def gather(date):
    events, read, failed = [], [], []
    for acct in ACCOUNTS:
        try:
            events += read_day(acct, date)
            read.append(acct)
        except Exception as e:   # any network, timeout or reply fault: the row must say Failed, never crash
            failed.append(f"{acct}: {type(e).__name__} {str(e)[:120]}")
    return events, read, failed


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "show"
    if cmd == "selftest":
        return selftest()
    now = datetime.now(timezone.utc)
    date = now.astimezone(LONDON).date().isoformat()
    events, read, failed = gather(date)
    found = sessions(events)
    if cmd == "show":
        print(date, line(found), "| read:", read, "| failed:", failed)
        return 0 if read else 1
    if cmd != "run":
        print(__doc__)
        return 2
    status, text, payload = outcome(date, found, read, failed)
    write_row(status, text, payload, now)
    print(status, text)
    return 1 if status == "Failed" else 0


def outcome(date, found, read, failed):
    """(status, detail, payload). The sport account unread means we cannot say there is no sport today."""
    if SPORT_ACCOUNT not in read:
        return "Failed", "Could not read the diary: " + ("; ".join(failed) or "no account read"), {"date": date, "sessions": None}
    return "Worked", line(found) + (f" (not read: {'; '.join(failed)})" if failed else ""), {"date": date, "sessions": found}


def selftest():
    cases = {
        "Padel, PDL Padel United Cambridge (Court 3)": "Padel",
        "Padel, Game4Padel St Ives Golf Club (Court 2)": "Padel",
        "Training": "Football training",
        "Training (Western Park)": "Football training",
        "U16 League Cup: Willingham Wolves v Witchford Colts Blue": "Football training",
        "Cambourne Town – Wolves": "Football training",
        "Willingham Wolves U14 Girls – Ely City Burgundy": "Football training",
        "Under 11s Black – TBC - League/Cup": "Football training",
        "Winter Net Training": None,
        "U16 football: Willingham Wolves v Cambourne Town U16 Yellow (home)": "Football training",
        "Girton U14s – Willingham Wolves U14 Girls": "Football training",
        "AI training webinar": None,
        "Viewing Dalham U2": None,
        "Inspection Flat U3": None,
        "Training: fire safety with Roy": None,
        "Cup of coffee with Simon": None,
        "Champions League final": None,
        "Paddle board hire": None,   # paddleboarding, not padel
        "Dentist": None,
        "": None,
    }
    bad = [(t, want, classify(t)) for t, want in cases.items() if classify(t) != want]
    found = sessions([{"title": "Training", "start": "2026-11-09T16:55:00+00:00"}, {"title": "Training", "start": "2026-11-09T17:00:00+00:00"},
                      {"title": "Padel, X", "start": "2026-11-09T19:30:00+00:00"}, {"title": "Dentist", "start": "2026-11-09T09:00:00+00:00"},
                      {"title": "Training", "start": "2026-11-09T16:55:00+00:00"}])
    want = [{"option": "Football training", "start": "16:55"}, {"option": "Football training", "start": "17:00"}, {"option": "Padel", "start": "19:30"}]
    if found != want:
        bad.append(("sessions", want, found))
    if line([]) != "No padel or football in the diary today." or line(want[2:]) != "Padel 19:30":
        bad.append(("line", "", line(want[2:])))
    ok_today = outcome("2026-11-09", want[2:], ACCOUNTS, [])
    if ok_today[0] != "Worked" or ok_today[2]["sessions"] != want[2:]:
        bad.append(("outcome worked", "", ok_today))
    lost = outcome("2026-11-09", [], ["kevinbrittain@gmail.com"], [SPORT_ACCOUNT + ": timeout"])
    if lost[0] != "Failed" or lost[2]["sessions"] is not None:
        bad.append(("outcome sport account unread must be Failed", "", lost))
    for b in bad:
        print("FAIL", b)
    print("selftest:", "ok" if not bad else f"{len(bad)} failed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
