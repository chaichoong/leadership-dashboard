#!/usr/bin/env python3
"""Read Kevin's WhatsApp messages straight off disk, with no screen and no clicking.

WHY THIS EXISTS
---------------
The WhatsApp half of the inbound sweep used to drive the WhatsApp app through
computer-use: take a screenshot, read the window, click about. That cannot work
in a scheduled run, and it never did. computer-use needs `request_access`, which
raises a dialog for a human to approve, and grants are session-scoped. In a
scheduled run nobody is at the keyboard, so the call returns "can't be approved
during a scheduled run" and the WhatsApp half skips. Every single day.

It skipped so quietly that WhatsApp looked like a quiet channel rather than a
dead one. On 14 Aug 2026 the app held 70,783 messages and the sweep had produced
exactly 2 tasks, both on 13 Aug.

WhatsApp keeps its messages in a local SQLite file, the same way Messages does.
So this reads that file directly, mirroring scripts/imessage-sweep.py command for
command (scan / mark / sent / selftest) so the sweep skill calls both the same way.

WHAT IS DELIBERATELY EXCLUDED
-----------------------------
Kevin's unread count is dominated by broadcast noise: on 14 Aug 2026 there were
6,160 unread messages across 33 chats, and 5,719 of them were ONE New York Times
newsletter. Status posts added 383 more. Neither is a message anyone needs to
reply to, and letting them through would bury the handful that matter.

  @newsletter  channel broadcasts (NYT and the like)  -> skipped
  @status      status/story posts                     -> skipped
  @broadcast   broadcast lists                        -> skipped

Group chats are only a candidate when Kevin is named, matching the iMessage rule.

READ-ONLY, ALWAYS
-----------------
Opened with mode=ro. This process must never write to WhatsApp's own database:
a corrupt ChatStorage.sqlite would cost Kevin his message history, and no sweep
is worth that.
"""

import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

DB_PATH = os.path.expanduser(
    "~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite"
)
STATE_DIR = os.path.expanduser("~/knowledge-os/logs/inbound-messages-sweep")
STATE_PATH = os.path.join(STATE_DIR, "state-whatsapp.json")

APPLE_EPOCH_UNIX = 978307200  # 2001-01-01 00:00:00 UTC
DEFAULT_WINDOW_HOURS = 24
MAX_WINDOW_HOURS = 7 * 24  # never sweep further back than a week, even after downtime
# Re-reading a little of what we already swept is cheap; the dedupe in the skill
# catches the repeat. Missing a message because the clock moved is not cheap.
OVERLAP_HOURS = 12
CONTEXT_MESSAGES = 10

# ZWAMESSAGE.ZMESSAGETYPE: 0 is a plain text message. Everything else is an
# image, voice note, sticker, system event and so on, none of which we can read
# as text or draft a reply to.
TEXT_MESSAGE_TYPE = 0

# JID suffixes. Group chats end @g.us and need a mention; the rest are broadcast
# surfaces with no reply expected.
GROUP_SUFFIX = "@g.us"
# Matched against the DOMAIN PART of the JID, not the whole string. A plain
# endswith("@status") misses "252514733658243@lid.status", which is a real JID
# form on this machine (a status post from a linked-identity contact) and leaked
# a status post into the candidates on the first live run.
BROADCAST_DOMAIN_MARKERS = ("status", "newsletter", "broadcast")

MENTION_PATTERN = re.compile(r"\bkevin\b", re.IGNORECASE)
OTP_TEXT = re.compile(
    r"\b(verification code|security code|one[- ]time|passcode|OTP)\b"
    r"|\b\d{4,8}\b.*\bcode\b|\bcode\b.*\b\d{4,8}\b",
    re.IGNORECASE,
)


def apple_ts_to_iso(ts):
    """WhatsApp stores Core Data timestamps: SECONDS since 2001-01-01.

    Note this differs from Messages, which uses NANOseconds. Mixing the two up
    silently puts the watermark in 1993 or in the far future, so the units are
    named in every function that touches them.
    """
    return datetime.fromtimestamp(float(ts) + APPLE_EPOCH_UNIX, tz=timezone.utc).isoformat()


def now_apple_ts():
    return datetime.now(tz=timezone.utc).timestamp() - APPLE_EPOCH_UNIX


def jid_is_group(jid):
    return bool(jid) and jid.endswith(GROUP_SUFFIX)


def jid_is_broadcast(jid):
    """True for status posts, channel newsletters and broadcast lists.

    Checks the domain part (everything after the first @) for a marker, so both
    "...@status" and "...@lid.status" are caught. Kevin's unread count is mostly
    these: 5,719 of 6,160 unread on 14 Aug 2026 were one newsletter.
    """
    if not jid or "@" not in jid:
        return False
    domain = jid.split("@", 1)[1].lower()
    return any(m in domain.split(".") for m in BROADCAST_DOMAIN_MARKERS)


def is_mentioned(text):
    return bool(text and MENTION_PATTERN.search(text))


def likely_automated(sender, text):
    if sender and re.search(r"no-?reply|donotreply", sender, re.IGNORECASE):
        return True
    if text and OTP_TEXT.search(text):
        return True
    return False


def read_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, STATE_PATH)


def open_db():
    if not os.path.exists(DB_PATH):
        raise RuntimeError(f"WhatsApp ChatStorage.sqlite not found at {DB_PATH}")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def sender_identity(row):
    """Work out who actually sent a message.

    Three columns look like they answer this and two of them lie:

      ZPUSHNAME  is NOT a display name in this WhatsApp build. It holds an
                 opaque base64 token (e.g. "CPPq+NMGIABIAZABAPABAtgC..."). Using
                 it puts gibberish in the task's sender field.
      ZFROMJID   is a "@lid" linked-identity (e.g. "82338818043926@lid"), not a
                 phone number. You cannot reply to it and it does not match the
                 chat JID, so sent_check would never find the outgoing message.

    What is actually reliable:
      1:1   the CHAT's ZCONTACTJID / ZPARTNERNAME  ("447881924047@s.whatsapp.net", "Roy Lavin")
      group the GROUP MEMBER's ZMEMBERJID / ZCONTACTNAME

    Verified against the live database on 14 Aug 2026.
    """
    if jid_is_group(row["chat_jid"]):
        return (row["member_jid"] or row["chat_jid"] or "unknown",
                row["member_name"] or "")
    return (row["chat_jid"] or "unknown", row["chat_name"] or "")


def chat_context(conn, session_pk, upto_ts):
    rows = conn.execute(
        """
        SELECT m.ZTEXT AS text, m.ZISFROMME AS from_me, m.ZMESSAGEDATE AS date,
               gm.ZCONTACTNAME AS member_name, gm.ZMEMBERJID AS member_jid,
               s.ZCONTACTJID AS chat_jid, s.ZPARTNERNAME AS chat_name
        FROM ZWAMESSAGE m
        JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
        LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
        WHERE m.ZCHATSESSION = ? AND m.ZMESSAGEDATE <= ?
        ORDER BY m.ZMESSAGEDATE DESC LIMIT ?
        """,
        (session_pk, upto_ts, CONTEXT_MESSAGES),
    ).fetchall()
    out = []
    for r in reversed(rows):
        if not r["text"]:
            continue
        if r["from_me"]:
            who = "kevin"
        else:
            jid, name = sender_identity(r)
            who = name or jid
        out.append({"from": who, "at": apple_ts_to_iso(r["date"]), "text": r["text"][:500]})
    return out


def scan():
    conn = open_db()
    db_total = conn.execute("SELECT COUNT(*) FROM ZWAMESSAGE").fetchone()[0]
    if db_total == 0:
        print(json.dumps({
            "error": "ChatStorage.sqlite opened but holds zero messages — read is broken, not quiet"
        }))
        return 2

    state = read_state()
    now_ts = now_apple_ts()
    default_since = now_ts - DEFAULT_WINDOW_HOURS * 3600
    floor_since = now_ts - MAX_WINDOW_HOURS * 3600
    overlap = OVERLAP_HOURS * 3600
    watermark = float(state.get("last_swept_ts", default_since + overlap))
    since_ts = max(watermark - overlap, floor_since)

    rows = conn.execute(
        """
        SELECT m.Z_PK AS mid, m.ZSTANZAID AS stanza, m.ZMESSAGEDATE AS date,
               m.ZTEXT AS text, m.ZMESSAGETYPE AS msg_type,
               gm.ZCONTACTNAME AS member_name, gm.ZMEMBERJID AS member_jid,
               s.Z_PK AS session_pk, s.ZCONTACTJID AS chat_jid,
               s.ZPARTNERNAME AS chat_name
        FROM ZWAMESSAGE m
        JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
        LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
        WHERE m.ZISFROMME = 0 AND m.ZMESSAGEDATE > ?
        ORDER BY m.ZMESSAGEDATE ASC
        """,
        (since_ts,),
    ).fetchall()

    scanned = 0
    broadcast_skipped = 0
    group_skipped = 0
    non_text_skipped = 0
    empty_skipped = 0
    candidates = []
    max_date_ts = since_ts
    seen_chat_context = {}

    for r in rows:
        scanned += 1
        max_date_ts = max(max_date_ts, float(r["date"]))

        if jid_is_broadcast(r["chat_jid"]):
            broadcast_skipped += 1
            continue
        if r["msg_type"] != TEXT_MESSAGE_TYPE:
            non_text_skipped += 1
            continue
        text = (r["text"] or "").strip()
        if not text:
            empty_skipped += 1
            continue
        is_group = jid_is_group(r["chat_jid"])
        if is_group and not is_mentioned(text):
            group_skipped += 1
            continue

        session_pk = r["session_pk"]
        if session_pk not in seen_chat_context:
            seen_chat_context[session_pk] = chat_context(conn, session_pk, r["date"])
        sender_jid, sender_name = sender_identity(r)
        candidates.append({
            # Mirrors the iMessage script's "guid": the dedupe key the skill stores.
            "guid": r["stanza"] or f"zpk:{r['mid']}",
            "date_ts": float(r["date"]),
            "at": apple_ts_to_iso(r["date"]),
            "sender": sender_jid,
            "sender_name": sender_name,
            "chat": r["chat_name"] or r["chat_jid"],
            "chat_jid": r["chat_jid"],
            "is_group": bool(is_group),
            "text": text[:2000],
            "likely_automated": likely_automated(sender_jid, text),
            "context": seen_chat_context[session_pk],
        })

    conn.close()
    print(json.dumps({
        "db_total_messages": db_total,
        "window_start": apple_ts_to_iso(since_ts),
        "scanned_incoming": scanned,
        "broadcast_skipped": broadcast_skipped,
        "group_skipped_no_mention": group_skipped,
        "non_text_skipped": non_text_skipped,
        "empty_or_undecodable": empty_skipped,
        "candidates": candidates,
        "max_date_ts": max_date_ts,
    }, indent=1))
    return 0


def mark(upto_ts):
    state = read_state()
    prev = float(state.get("last_swept_ts", 0))
    state["last_swept_ts"] = max(prev, float(upto_ts))
    state["marked_at"] = datetime.now(tz=timezone.utc).isoformat()
    write_state(state)
    print(json.dumps({"ok": True, "last_swept_ts": state["last_swept_ts"]}))
    return 0


def sent_check(jid, contains, since_hours):
    """Has an outgoing WhatsApp message containing `contains` gone to `jid` recently?

    Same job as the iMessage version: the carry-out step verifies before it
    re-sends, so a crash between send and complete can never double-message
    somebody. Matched on ZTEXT, which WhatsApp populates directly (unlike
    Messages, where the text usually hides in attributedBody).
    """
    conn = open_db()
    since_ts = now_apple_ts() - since_hours * 3600
    needle = re.sub(r"\s+", " ", contains).strip().lower()[:200] if contains else None
    rows = conn.execute(
        """
        SELECT m.ZTEXT AS text, m.ZMESSAGEDATE AS date
        FROM ZWAMESSAGE m
        JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
        WHERE m.ZISFROMME = 1 AND m.ZMESSAGEDATE > ?
          AND s.ZCONTACTJID = ? AND m.ZMESSAGETYPE = ?
        ORDER BY m.ZMESSAGEDATE DESC
        """,
        (since_ts, jid, TEXT_MESSAGE_TYPE),
    ).fetchall()
    matches = []
    for r in rows:
        text = (r["text"] or "").strip()
        if needle is None:
            if text:
                matches.append(apple_ts_to_iso(r["date"]))
        elif text and needle in re.sub(r"\s+", " ", text).strip().lower():
            matches.append(apple_ts_to_iso(r["date"]))
    conn.close()
    print(json.dumps({"found": bool(matches), "count": len(matches),
                      "outgoing_checked": len(rows), "match_times": matches[:5]}))
    return 0


def selftest():
    failures = []

    def check(name, cond):
        if not cond:
            failures.append(name)

    check("group jid", jid_is_group("120363047228879289@g.us"))
    check("individual not group", not jid_is_group("447775404207@s.whatsapp.net"))
    check("newsletter is broadcast", jid_is_broadcast("120363169319669622@newsletter"))
    check("status is broadcast", jid_is_broadcast("447957869197@status"))
    # Real JID form seen live: a status post from a linked-identity contact.
    # endswith("@status") does NOT catch this, and it leaked one through.
    check("lid.status is broadcast", jid_is_broadcast("252514733658243@lid.status"))
    check("individual not broadcast", not jid_is_broadcast("447775404207@s.whatsapp.net"))
    check("group not broadcast", not jid_is_broadcast("120363047228879289@g.us"))
    check("plain lid not broadcast", not jid_is_broadcast("252514733658243@lid"))
    check("none jid safe", not jid_is_group(None) and not jid_is_broadcast(None))
    check("malformed jid safe", not jid_is_broadcast("nonsense-no-at-sign"))

    check("mention name", is_mentioned("are you free Kevin?"))
    check("mention case", is_mentioned("KEVIN call me"))
    check("mention at-tag", is_mentioned("@Kevin can you confirm?"))
    check("no mention", not is_mentioned("anyone fancy lunch?"))
    check("no substring mention", not is_mentioned("ask kevinson"))

    # Sender identity. These use the real column values seen on 14 Aug 2026: a
    # @lid ZFROMJID and an opaque base64 ZPUSHNAME, neither of which may leak
    # into the sender fields. If someone "simplifies" sender_identity back to
    # ZFROMJID/ZPUSHNAME, these fail.
    one_to_one = {"chat_jid": "447881924047@s.whatsapp.net", "chat_name": "Roy Lavin",
                  "member_jid": None, "member_name": None}
    jid, name = sender_identity(one_to_one)
    check("1:1 sender is phone jid", jid == "447881924047@s.whatsapp.net")
    check("1:1 sender name", name == "Roy Lavin")
    check("1:1 sender not lid", "@lid" not in jid)

    group = {"chat_jid": "120363047228879289@g.us", "chat_name": "Any excuse",
             "member_jid": "447900000002@s.whatsapp.net", "member_name": "Sam Atherton"}
    jid, name = sender_identity(group)
    check("group sender is member", jid == "447900000002@s.whatsapp.net")
    check("group sender name", name == "Sam Atherton")

    unknown = {"chat_jid": None, "chat_name": None, "member_jid": None, "member_name": None}
    check("missing jid degrades safely", sender_identity(unknown) == ("unknown", ""))

    check("otp automated", likely_automated("447900000001@s.whatsapp.net",
                                            "Your verification code is 482913"))
    check("normal not automated", not likely_automated("447900000001@s.whatsapp.net",
                                                       "Hi Kevin, are we still on for Friday?"))

    # Units: WhatsApp is SECONDS since 2001-01-01, not nanoseconds. Getting this
    # wrong puts the watermark decades out and silently sweeps nothing or everything.
    check("epoch seconds", apple_ts_to_iso(0).startswith("2001-01-01"))
    check("epoch not nanos", apple_ts_to_iso(776000000).startswith("2025-"))

    if failures:
        print("SELFTEST FAIL: " + ", ".join(failures))
        return 1
    print("selftest ok")
    return 0


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "scan"
    if cmd == "scan":
        return scan()

    def opt(flag, default=None):
        if flag in argv:
            idx = argv.index(flag)
            if idx + 1 < len(argv):
                return argv[idx + 1]
        return default

    if cmd == "mark":
        upto = opt("--upto")
        if upto is None:
            print("mark requires --upto <apple_epoch_seconds>", file=sys.stderr)
            return 2
        return mark(float(upto))
    if cmd == "sent":
        jid = opt("--jid")
        if not jid:
            print("sent requires --jid", file=sys.stderr)
            return 2
        return sent_check(jid, opt("--contains"), float(opt("--since-hours", "48")))
    if cmd == "selftest":
        return selftest()
    print(f"unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv))
    except (RuntimeError, sqlite3.OperationalError) as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(2)
