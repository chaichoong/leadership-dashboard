#!/usr/bin/env python3
"""padel-delivery.py: the padel robot's view of Messages (Kevin, 5 Nov 2026).

macOS refuses the padel robot (node) when it reads ~/Library/Messages/chat.db from its scheduled
run, however it reads it (in-process, or through sqlite3 or python3 started by node: proved by
launchd probes on 5 Nov 2026). Programs bash starts may read it. So padel-courts-run.sh runs this,
under bash, before the robot. It writes, for each player's number only, the texts Kevin sent that
number in the last 48 hours with Messages' own record of each: sent, delivered, error, iMessage or
SMS. No message text is copied. The robot reads the file to confirm delivery and to send one SMS
when an iMessage failed (scripts/padel-paid.mjs, deliveryOf and the texts follow-up).

It also writes the Padel WhatsApp group's current members (6 Nov 2026): for each, the name in Kevin's
contacts, the name the person gave WhatsApp, and the mobile. Kevin adds a new player to the group,
his contacts, the app and Splitwise himself; the robot uses this list to link the app's name to a
mobile the first time that player is on a paid booking (scripts/padel-paid.mjs, matchPlayer). No
message is read. WhatsApp is read only, never written.

Usage: python3 scripts/padel-delivery.py      writes ~/knowledge-os/logs/padel-paid/delivery.json
                                               and ~/knowledge-os/logs/padel-paid/whatsapp.json
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
WA = os.path.join(HOME, "Library/Group Containers/group.net.whatsapp.WhatsApp.shared")
WA_OUT = os.path.join(HOME, "knowledge-os/logs/padel-paid/whatsapp.json")
WA_GROUP = "Padel"
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
    write_private(out_path, {"at": int(now * 1000), "numbers": out})
    return out


def write_private(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)   # private from the first byte
    with os.fdopen(fd, "w") as fh:
        json.dump(obj, fh)
    os.chmod(tmp, 0o600)                                                # an old tmp left with wider rights
    os.replace(tmp, path)


def e164(jid):
    """'447700900002@s.whatsapp.net' -> '+447700900002'; anything else -> None."""
    m = re.fullmatch(r"(\d{8,15})@s\.whatsapp\.net", str(jid or ""))
    return f"+{m.group(1)}" if m else None


def whatsapp(wa_dir=WA, out_path=WA_OUT, group=WA_GROUP, now=None):
    """The group's members as Kevin's contacts name them: names and mobile, nothing else."""
    now = time.time() if now is None else now
    chats = sqlite3.connect(f"file:{os.path.join(wa_dir, 'ChatStorage.sqlite')}?mode=ro", uri=True)
    book = sqlite3.connect(f"file:{os.path.join(wa_dir, 'ContactsV2.sqlite')}?mode=ro", uri=True)
    try:
        sessions = chats.execute("SELECT Z_PK FROM ZWACHATSESSION WHERE ZPARTNERNAME = ? AND ZCONTACTJID LIKE '%@g.us'", (group,)).fetchall()
        if len(sessions) != 1:   # none, or two groups with one name: never guess which
            raise RuntimeError(f"{len(sessions)} WhatsApp groups are called {group}")
        # Current members only: WhatsApp keeps a row, marked inactive, for anyone who has left.
        jids = [r[0] for r in chats.execute("SELECT ZMEMBERJID FROM ZWAGROUPMEMBER WHERE ZCHATSESSION = ? AND ZMEMBERJID IS NOT NULL AND ZISACTIVE = 1", (sessions[0][0],))]
        push = dict(chats.execute("SELECT ZJID, ZPUSHNAME FROM ZWAPROFILEPUSHNAME WHERE ZJID IS NOT NULL"))
        members = []
        for jid in jids:
            # A member is listed by a private id (@lid) or by number: Kevin's contacts, as WhatsApp
            # holds them, carry both, with the name Kevin gave and the number.
            rows = book.execute("SELECT ZFULLNAME, ZWHATSAPPID FROM ZWAADDRESSBOOKCONTACT WHERE ZLID = ? OR ZWHATSAPPID = ?", (jid, jid)).fetchall()
            phones = sorted({p for p in [e164(jid)] + [e164(r[1]) for r in rows] if p})
            members.append({"contact": sorted({r[0].strip() for r in rows if r[0] and r[0].strip()}),
                            "pushname": (push.get(jid) or "").strip() or None, "phones": phones})
    finally:
        chats.close()
        book.close()
    if not members:
        raise RuntimeError(f"the {group} WhatsApp group lists no members")
    write_private(out_path, {"at": int(now * 1000), "group": group, "members": members})
    return members


if __name__ == "__main__":
    failed = False
    for name, step in (("could not read Messages", dump), ("could not read the Padel WhatsApp group", whatsapp)):
        try:
            step()
        except Exception as e:  # loud: the robot then cannot confirm a text or find a new player, and the job says why
            print(f"FAILED: padel-delivery: {name} ({type(e).__name__}: {e})", file=sys.stderr)
            failed = True
    sys.exit(1 if failed else 0)
