#!/usr/bin/env python3
"""padel-delivery.py: the padel robot's view of Messages (Kevin, 5 Nov 2026).

macOS refuses the padel robot (node) when it reads ~/Library/Messages/chat.db from its scheduled
run, however it reads it (in-process, or through sqlite3 or python3 started by node: proved by
launchd probes on 5 Nov 2026). Programs bash starts may read it. So padel-courts-run.sh runs this,
under bash, before the robot. It writes, for each player's number only, the texts Kevin sent that
number in the last 48 hours with Messages' own record of each: sent, delivered, error, iMessage or
SMS. No message text is copied. The robot reads the file to confirm delivery and to send one SMS
when an iMessage failed (scripts/padel-paid.mjs, deliveryOf and the texts follow-up).

Usage: python3 scripts/padel-delivery.py      writes ~/knowledge-os/logs/padel-paid/delivery.json
"""
import json
import os
import re
import sqlite3
import sys
import time

HOME = os.path.expanduser("~")
PLAYERS = os.path.join(HOME, "Projects/kevin-hq/padel/players.json")   # private: never in this repo
DB = os.path.join(HOME, "Library/Messages/chat.db")
OUT = os.path.join(HOME, "knowledge-os/logs/padel-paid/delivery.json")
APPLE_EPOCH = 978307200       # Messages counts nanoseconds from 1 Jan 2001
WINDOW_HOURS = 48


def digits(number):
    """The last ten digits: how a number is matched whatever its prefix or spacing."""
    return re.sub(r"\D", "", str(number))[-10:]


def dump(players_path=PLAYERS, db_path=DB, out_path=OUT, now=None):
    now = time.time() if now is None else now
    with open(players_path) as fh:
        who = json.load(fh)["players"]
    numbers = {digits(n) for p in who.values() if not p.get("self") for n in (p.get("phones") or []) if digits(n)}
    since = int((now - WINDOW_HOURS * 3600 - APPLE_EPOCH) * 1e9)
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT h.id, m.date, m.service, m.is_sent, m.is_delivered, m.error FROM message m "
            "JOIN handle h ON h.ROWID = m.handle_id WHERE m.is_from_me = 1 AND m.date >= ?", (since,)).fetchall()
    finally:
        con.close()
    out = {d: [] for d in sorted(numbers)}
    for handle, date, service, sent, delivered, error in rows:
        d = digits(handle)
        if d in out:
            out[d].append({"at": int((date / 1e9 + APPLE_EPOCH) * 1000), "service": service,
                           "sent": bool(sent), "delivered": bool(delivered), "error": int(error or 0)})
    for msgs in out.values():
        msgs.sort(key=lambda m: m["at"])
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump({"at": int(now * 1000), "numbers": out}, fh)
    os.chmod(tmp, 0o600)
    os.replace(tmp, out_path)
    return out


if __name__ == "__main__":
    try:
        dump()
    except Exception as e:  # loud: the robot then cannot confirm a text, and the job says why
        print(f"FAILED: padel-delivery: could not read Messages ({type(e).__name__}: {e})", file=sys.stderr)
        sys.exit(1)
