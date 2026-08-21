#!/usr/bin/env python3
"""iMessage sweep — deterministic extraction half of the inbound-messages-sweep routine.

Reads the Mac's Messages database (~/Library/Messages/chat.db, read-only) and
prints JSON of incoming messages that MAY need a personal reply from Kevin.
Judgement (does this actually need a reply, drafting, task creation) belongs to
the Claude routine that calls this — this script only extracts and filters.

Filter rules (agreed with Kevin, 13 Aug 2026):
- Incoming AND UNREAD only (is_from_me = 0, is_read = 0), since the watermark
  (default: last 24h). Kevin's rule, 13 Aug 2026: a message he has read is his
  to deal with; the sweep exists for what he has not seen. Read state syncs
  from his iPhone via iCloud, so "read on the phone" counts as read here.
- One-to-one chats: always included.
- Group chats: included ONLY when Kevin is mentioned (an iMessage @mention of
  his handle, or his name appearing in the text). Everything else in a group
  is information, not a request.
- Obvious automation (short-code senders, OTP codes) is tagged
  likely_automated, not dropped — the routine makes the final call.

Subcommands:
  scan            (default) print candidates JSON; does NOT move the watermark.
                  Re-scans OVERLAP_HOURS behind the watermark each run because
                  iCloud can sync messages late; the routine's Airtable dedupe
                  key is what stops double-tasking inside the overlap.
  mark --upto NS  advance the watermark to NS (apple-epoch nanoseconds); the
                  routine calls this only AFTER tasks were created successfully
  sent --handle H [--contains TEXT] [--since-hours N]
                  reports whether an OUTGOING message to handle H exists in
                  the last N hours (default 48). With --contains it must
                  contain TEXT (the carry-out duplicate-send check); without,
                  ANY real outgoing message counts (the "Kevin replied
                  himself" check that closes his task). Decodes
                  attributedBody, because most sent messages have a NULL text
                  column. Tapbacks and edits never count as replies.
  selftest        run built-in unit checks (no database needed)

Control (a running job is not a working job): scan FAILS loudly (exit 2) if the
database cannot be opened or contains zero messages overall. A genuinely quiet
24h window exits 0 with candidates=[] and db_total_messages in the JSON, so a
broken read can never be mistaken for a quiet day.
"""

import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone

DB_PATH = os.path.expanduser("~/Library/Messages/chat.db")
STATE_DIR = os.path.expanduser("~/knowledge-os/logs/inbound-messages-sweep")
STATE_PATH = os.path.join(STATE_DIR, "state.json")

APPLE_EPOCH_UNIX = 978307200  # 2001-01-01 00:00:00 UTC
DEFAULT_WINDOW_HOURS = 24
MAX_WINDOW_HOURS = 7 * 24  # never sweep further back than a week, even after downtime
# Messages-in-iCloud can sync AFTER the Mac wakes, delivering messages whose
# send date is older than the newest already seen. Re-scan this far behind the
# watermark every run; the routine's Airtable dedupe key stops double-tasking.
OVERLAP_HOURS = 12
CONTEXT_MESSAGES = 10

# Kevin's own name for the group-mention rule. iMessage confirmed @mentions are
# stored in attributedBody attributes; a plain-name match covers both that and
# people typing "Kevin" without a formal mention.
MENTION_PATTERN = re.compile(r"\bkevin\b", re.IGNORECASE)

SHORTCODE_SENDER = re.compile(r"^\d{3,8}$")
OTP_TEXT = re.compile(r"\b(verification code|security code|one[- ]time|passcode|OTP)\b|\b\d{4,8}\b.*\bcode\b|\bcode\b.*\b\d{4,8}\b", re.IGNORECASE)


def apple_ns_to_iso(ns):
    return datetime.fromtimestamp(ns / 1e9 + APPLE_EPOCH_UNIX, tz=timezone.utc).isoformat()


def now_apple_ns():
    return int((time.time() - APPLE_EPOCH_UNIX) * 1e9)


def decode_attributed_body(blob):
    """Best-effort text extraction from the typedstream attributedBody blob.

    Newer macOS versions leave message.text NULL and store the content here.
    Format: ... b"NSString" + 5 control bytes + length + utf-8 bytes. Length is
    one byte, or 0x81 followed by a little-endian uint16 for longer strings.
    Returns None when the shape is not recognised — callers fall back to text.
    """
    if not blob:
        return None
    try:
        idx = blob.find(b"NSString")
        if idx < 0:
            return None
        rest = blob[idx + len(b"NSString") + 5:]
        if not rest:
            return None
        if rest[0] == 0x81:
            length = int.from_bytes(rest[1:3], "little")
            raw = rest[3:3 + length]
        else:
            length = rest[0]
            raw = rest[1:1 + length]
        out = raw.decode("utf-8", errors="ignore").strip()
        return out or None
    except Exception:
        return None


def message_text(row_text, row_blob):
    if row_text and row_text.strip():
        return row_text.strip()
    return decode_attributed_body(row_blob)


def is_mentioned(text, blob=None):
    # A confirmed @mention renders the contact's name into the message text,
    # so the name match covers formal mentions too. The typedstream mention
    # marker is NOT checked: it fires on a mention of anyone, not just Kevin.
    return bool(text and MENTION_PATTERN.search(text))


def likely_automated(sender, text):
    if sender and SHORTCODE_SENDER.match(sender):
        return True
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
        raise RuntimeError(f"chat.db not found at {DB_PATH}")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def chat_context(conn, chat_rowid, upto_ns):
    rows = conn.execute(
        """
        SELECT m.text, m.attributedBody, m.is_from_me, m.date, h.id AS sender
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE cmj.chat_id = ? AND m.date <= ?
        ORDER BY m.date DESC LIMIT ?
        """,
        (chat_rowid, upto_ns, CONTEXT_MESSAGES),
    ).fetchall()
    out = []
    for r in reversed(rows):
        text = message_text(r["text"], r["attributedBody"])
        if not text:
            continue
        out.append({
            "from": "kevin" if r["is_from_me"] else (r["sender"] or "unknown"),
            "at": apple_ns_to_iso(r["date"]),
            "text": text[:500],
        })
    return out


def scan():
    conn = open_db()
    db_total = conn.execute("SELECT COUNT(*) FROM message").fetchone()[0]
    if db_total == 0:
        print(json.dumps({"error": "chat.db opened but holds zero messages — read is broken, not quiet"}))
        return 2

    state = read_state()
    now_ns = now_apple_ns()
    default_since = now_ns - int(DEFAULT_WINDOW_HOURS * 3600 * 1e9)
    floor_since = now_ns - int(MAX_WINDOW_HOURS * 3600 * 1e9)
    overlap_ns = int(OVERLAP_HOURS * 3600 * 1e9)
    watermark = int(state.get("last_swept_ns", default_since + overlap_ns))
    since_ns = max(watermark - overlap_ns, floor_since)

    rows = conn.execute(
        """
        SELECT m.ROWID AS mid, m.guid, m.date, m.text, m.attributedBody,
               m.item_type, m.associated_message_type,
               h.id AS sender,
               c.ROWID AS chat_rowid, c.chat_identifier, c.display_name, c.style
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.is_from_me = 0 AND m.is_read = 0 AND m.date > ?
        ORDER BY m.date ASC
        """,
        (since_ns,),
    ).fetchall()

    scanned = 0
    group_skipped = 0
    empty_skipped = 0
    candidates = []
    max_date_ns = since_ns
    seen_chat_context = {}

    for r in rows:
        scanned += 1
        max_date_ns = max(max_date_ns, r["date"])
        # item_type 0 = actual message; skip tapbacks/edits/group renames etc.
        if r["item_type"] != 0 or (r["associated_message_type"] or 0) != 0:
            continue
        text = message_text(r["text"], r["attributedBody"])
        if not text:
            empty_skipped += 1
            continue
        is_group = r["style"] == 43
        if is_group and not is_mentioned(text, r["attributedBody"]):
            group_skipped += 1
            continue
        chat_key = r["chat_rowid"]
        if chat_key not in seen_chat_context:
            seen_chat_context[chat_key] = chat_context(conn, chat_key, r["date"])
        candidates.append({
            "guid": r["guid"],
            "date_ns": r["date"],
            "at": apple_ns_to_iso(r["date"]),
            "sender": r["sender"] or "unknown",
            "chat": r["display_name"] or r["chat_identifier"],
            "is_group": bool(is_group),
            "text": text[:2000],
            "likely_automated": likely_automated(r["sender"], text),
            "context": seen_chat_context[chat_key],
        })

    conn.close()
    print(json.dumps({
        "db_total_messages": db_total,
        "window_start": apple_ns_to_iso(since_ns),
        "scanned_incoming": scanned,
        "group_skipped_no_mention": group_skipped,
        "empty_or_undecodable": empty_skipped,
        "candidates": candidates,
        "max_date_ns": max_date_ns,
    }, indent=1))
    return 0


def mark(upto_ns):
    state = read_state()
    prev = int(state.get("last_swept_ns", 0))
    state["last_swept_ns"] = max(prev, int(upto_ns))
    state["marked_at"] = datetime.now(tz=timezone.utc).isoformat()
    write_state(state)
    print(json.dumps({"ok": True, "last_swept_ns": state["last_swept_ns"]}))
    return 0


def sent_check(handle, contains, since_hours):
    """Has an outgoing message containing `contains` gone to `handle` recently?

    Used by the agent-dispatch carry-out's verify-first step after a crash
    between send and complete. Matches on decoded content because 90%+ of sent
    messages store their text in attributedBody with a NULL text column.
    """
    conn = open_db()
    since_ns = now_apple_ns() - int(since_hours * 3600 * 1e9)
    needle = re.sub(r"\s+", " ", contains).strip().lower()[:200] if contains else None
    rows = conn.execute(
        """
        SELECT m.text, m.attributedBody, m.date
        FROM message m
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.is_from_me = 1 AND m.date > ? AND h.id = ?
          AND m.item_type = 0 AND COALESCE(m.associated_message_type, 0) = 0
        ORDER BY m.date DESC
        """,
        (since_ns, handle),
    ).fetchall()
    matches = []
    for r in rows:
        text = message_text(r["text"], r["attributedBody"])
        if needle is None:
            if text:
                matches.append(apple_ns_to_iso(r["date"]))
        elif text and needle in re.sub(r"\s+", " ", text).strip().lower():
            matches.append(apple_ns_to_iso(r["date"]))
    conn.close()
    print(json.dumps({"found": bool(matches), "count": len(matches),
                      "outgoing_checked": len(rows), "match_times": matches[:5]}))
    return 0


def selftest():
    failures = []

    def check(name, cond):
        if not cond:
            failures.append(name)

    # attributedBody decode: short-form length byte
    blob = b"junkNSString\x01\x94\x84\x01+\x05Hello\x86tail"
    check("decode short", decode_attributed_body(blob) == "Hello")
    # long-form length (0x81 + uint16)
    long_text = b"A" * 300
    blob_long = b"xNSString\x01\x94\x84\x01+\x81" + (300).to_bytes(2, "little") + long_text
    check("decode long", decode_attributed_body(blob_long) == "A" * 300)
    check("decode none", decode_attributed_body(None) is None)
    check("decode garbage", decode_attributed_body(b"\x00\x01\x02") is None)

    check("mention name", is_mentioned("are you free Kevin?"))
    check("mention case", is_mentioned("KEVIN call me"))
    check("mention at-tag", is_mentioned("@Kevin can you confirm?"))
    check("no mention", not is_mentioned("anyone fancy lunch?"))
    check("no substring mention", not is_mentioned("ask kevinson"))

    check("shortcode automated", likely_automated("62884", "Your delivery is on its way"))
    check("otp automated", likely_automated("+447900000001", "Your verification code is 482913"))
    check("normal not automated", not likely_automated("+447900000001", "Hi Kevin, are we still on for Friday?"))

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
            print("mark requires --upto <apple_epoch_ns>", file=sys.stderr)
            return 2
        return mark(int(upto))
    if cmd == "sent":
        handle = opt("--handle")
        if not handle:
            print("sent requires --handle", file=sys.stderr)
            return 2
        return sent_check(handle, opt("--contains"), float(opt("--since-hours", "48")))
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
