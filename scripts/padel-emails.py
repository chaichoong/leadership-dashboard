#!/usr/bin/env python3
"""padel-emails.py: the padel robot reads the venues' booking emails (Kevin, 8 Nov 2026).

Kevin's words: "We get a booking confirmation email immediately so why do you not use that for the
information", and "do it all from the booking confirmation email and the information on the app at
that time". A court booked on 7 Nov at 20:41 sat all night with no price, so no Splitwise entry and no
texts, because the price was a second button nobody pressed.

So every 15 minutes padel-courts-run.sh runs this, before the robot. It asks the drive-upload
Worker (the one headless way into Gmail, with the read-only triage key) for the last two days of
booking emails from the venues, in kevin@runpreneur.org.uk, where Kevin's Gmail lands. For each it
writes what the email says: the venue, the date, the start, the length, and the total paid when the
email has one. The robot (scripts/padel-paid.mjs, emailStep) marks the hour booked from it and, with
a price, hands it to Splitwise and the texts, players taken from the app at that time.

What each venue's email carries (read 8 Nov 2026):
  * Matchi (PDL until 30 Nov, St Ives): "Booking confirmation", "Date: 2026-11-08", "Time:
    16:00-17:00". NO PRICE: Kevin's phone asks him for it (the price box opens by itself).
  * Nettla (Pulse Padel): "Court booking confirmed", "Tue 10 Nov, 19:30 - 20:30", "Total £34.60".
    "Public match confirmed" or "cancelled" is Kevin's own place in someone else's game: skipped.
  * Playtomic (PDL from 1 Dec): no email seen yet. One is listed under "unread" with its subject, so
    the first one shows in the log and its format gets added; it is never guessed.
No name, address or message text is copied: only the fields above and the email's id.

Usage: python3 scripts/padel-emails.py      writes ~/knowledge-os/logs/padel-paid/emails.json
Exit 1 with a line starting "FAILED:" when Gmail could not be read; the robot then uses nothing
older than an hour.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gmail_pacer import gmail_pace  # noqa: E402

HOME = os.path.expanduser("~")
OUT = os.path.join(HOME, "knowledge-os/logs/padel-paid/emails.json")
KEY_FILE = os.path.join(HOME, ".config/od/gmail_triage_key")
WORKER_URL = "https://drive-upload.kevinbrittain.workers.dev"
ACCOUNT = "kevin@runpreneur.org.uk"
# Booking emails only: Nettla's login codes and a club's news would otherwise fill the page.
QUERY = ('{(from:matchi.se subject:"booking confirmation") (from:nettla.co subject:"court booking") '
         'from:playtomic.io from:playtomic.com} newer_than:2d')
MAX_RESULTS = 25            # one page; more than this in two days is not believable, so it fails loudly
MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def write_private(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)   # private from the first byte
    with os.fdopen(fd, "w") as fh:
        json.dump(obj, fh)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def text_of(body):
    """The email as one line of plain words: tags out, entities and runs of space folded."""
    t = re.sub(r"<[^>]+>", " ", str(body or ""))
    t = t.replace("&nbsp;", " ").replace("&#x27;", "'").replace("&#39;", "'").replace("&amp;", "&").replace("&pound;", "£")
    return re.sub(r"\s+", " ", t).strip()


def header(msg, name):
    h = msg.get("headers") or {}
    if isinstance(h, dict):
        return str(h.get(name.lower()) or h.get(name) or "")
    for x in h:
        if str(x.get("name", "")).lower() == name.lower():
            return str(x.get("value") or "")
    return ""


def length(start, end):
    """'19:30', '20:30' -> 60; None when the end is not after the start."""
    a = int(start[:2]) * 60 + int(start[3:])
    b = int(end[:2]) * 60 + int(end[3:])
    return b - a if b > a else None


def pounds(text):
    m = re.search(r"\bTotal\s*£\s*(\d{1,4}(?:\.\d{1,2})?)\b", text)
    return (round(float(m.group(1)) * 100) or None) if m else None     # £0.00 (paid with credit): no price, Kevin types it


def nettla_date(day_word, day_num, month_word, sent):
    """'Tue', '10', 'Nov' in an email sent at `sent` (a London date) -> the date it means, or None.
    The year is the one that puts the game on or after the day the email was sent; the weekday must agree."""
    month = MONTHS.get(month_word[:3].lower())
    if not month:
        return None
    for year in (sent.year, sent.year + 1):
        try:
            d = date(year, month, int(day_num))
        except ValueError:
            return None
        if d >= sent - timedelta(days=1):
            return d if DAYS[d.weekday()] == day_word[:3].lower() else None
    return None


def parse(msg):
    """One email -> a booking {id, at, venue, date, start, minutes, price_pence} or {id, at, skip: why}."""
    mid = str(msg.get("id") or "")
    at = int(msg.get("internalDate") or 0)
    sender = header(msg, "From").lower()
    subject = header(msg, "Subject")
    text = text_of(msg.get("body"))
    out = {"id": mid, "at": at}
    sent = datetime.fromtimestamp(at / 1000, timezone.utc).date() if at else date.today()
    if "matchi" in sender:
        if not re.search(r"booking confirmation", subject, re.I):
            return {**out, "skip": "not a booking confirmation"}
        venue = "pdl" if re.search(r"\bPDL\b|Padel United", text, re.I) else "si" if re.search(r"St Ives", text, re.I) else None
        d = re.search(r"\bDate:\s*(\d{4}-\d\d-\d\d)\b", text)
        t = re.search(r"\bTime:\s*(\d\d:\d\d)\s*-\s*(\d\d:\d\d)\b", text)
        if not (d and t):
            return {**out, "skip": "Matchi email not read (date or time missing)"}
        if not venue:
            return {**out, "skip": "a Matchi club that is not ours"}
        mins = length(t.group(1), t.group(2))
        return {**out, "venue": venue, "date": d.group(1), "start": t.group(1), "minutes": mins, "price_pence": None} if mins else {**out, "skip": "Matchi times not read"}
    if "nettla" in sender:
        if re.search(r"public match", subject, re.I):
            return {**out, "skip": "a public match (Kevin's own place)"}
        if not re.search(r"court booking confirmed", subject, re.I):
            return {**out, "skip": "not a court booking"}
        if not re.search(r"Pulse Padel", text, re.I):
            return {**out, "skip": "a Nettla club that is not Pulse Padel"}
        m = re.search(r"\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w* (\d{1,2}) ([A-Z][a-z]{2})\w*, (\d\d:\d\d) - (\d\d:\d\d)\b", text)
        d = nettla_date(m.group(1), m.group(2), m.group(3), sent) if m else None
        mins = length(m.group(4), m.group(5)) if m else None
        if not (d and mins):
            return {**out, "skip": "Nettla email not read (date or time missing, or the weekday disagrees)"}
        return {**out, "venue": "pp", "date": d.isoformat(), "start": m.group(4), "minutes": mins, "price_pence": pounds(text)}
    if "playtomic" in sender:
        return {**out, "skip": "unread: Playtomic's format is not known yet", "subject": subject[:80]}
    return {**out, "skip": "not a venue"}


def gmail_list(query=QUERY, key_file=KEY_FILE, opener=urllib.request.urlopen, pace=gmail_pace):
    with open(key_file) as fh:
        key = fh.read().strip()
    if not key:
        raise RuntimeError(f"the Gmail triage key at {key_file} is empty")
    payload = {"q": query, "maxResults": MAX_RESULTS, "account": ACCOUNT}
    pace("/gmail/list", payload, account=ACCOUNT)
    req = urllib.request.Request(WORKER_URL + "/gmail/list", data=json.dumps(payload).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                                          "User-Agent": "od-padel-emails/1.0"})
    with opener(req, timeout=60) as res:
        data = json.loads(res.read().decode())
    msgs = data.get("messages")
    if not isinstance(msgs, list):
        raise RuntimeError("Gmail answered with no message list")
    if data.get("nextPageToken"):
        raise RuntimeError(f"more than {MAX_RESULTS} venue emails in two days: the search needs narrowing")
    return msgs


def run(out_path=OUT, now=None, lister=gmail_list):
    now = time.time() if now is None else now
    found = [parse(m) for m in lister()]
    write_private(out_path, {"at": int(now * 1000),
                             "bookings": [f for f in found if "skip" not in f],
                             "skipped": [f for f in found if "skip" in f]})
    return found


def main(out_path=OUT, lister=gmail_list):
    """One run: 0 when every booking email was read, 1 (a line starting FAILED:) when Gmail could not be
    read or a booking email could not be."""
    try:
        got = run(out_path=out_path, lister=lister)
    except (OSError, RuntimeError, ValueError, urllib.error.URLError) as exc:
        print(f"FAILED: padel-emails: Gmail could not be read ({type(exc).__name__}: {str(exc)[:160]})")
        return 1
    unread = [g for g in got if str(g.get("skip", "")).startswith("unread")]
    if unread:
        print(f"padel-emails: {len(unread)} venue email(s) in a format not read yet: {'; '.join(g.get('subject', '') for g in unread)}")
    # A booking email the parser could not read means a venue changed its email: loud, every run, until fixed.
    broken = [g for g in got if "not read" in str(g.get("skip", ""))]
    if broken:
        print(f"FAILED: padel-emails: {len(broken)} booking email(s) not read ({'; '.join(sorted({g['skip'] for g in broken}))}). A venue may have changed its email.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
