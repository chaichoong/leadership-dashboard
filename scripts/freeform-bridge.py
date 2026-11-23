#!/usr/bin/env python3
"""
Freeform -> AI Brain bridge.

Kevin sketches and brainstorms in Apple's Freeform app on his iPhone. Freeform has
no export door a robot can use: no AppleScript, no Shortcuts export action, and its
menus cannot be driven while the Mac's screen is locked (proved 22 Nov 2026). What it
does have is iCloud sync: every board lands on this Mac in Freeform's own database,
    ~/Library/Group Containers/group.com.apple.freeform/Boards/boards.db
and that file reads with the screen locked. This script reads it.

Each night it:
  1. opens Freeform hidden so iCloud brings the boards down, and waits for the
     database to go quiet;
  2. fingerprints every board and picks the ones that are new or changed since the
     last run;
  3. for each of those, redraws the board from the synced data (pen strokes, sticky
     notes, text boxes, pictures, connector lines), reads the handwriting on this
     Mac with the same Apple Vision helper the Notes bridge uses, and writes a
     markdown note plus its pictures into the brain _Inbox. The nightly compound
     pass files it from there.

THE CONTROL. The picture is redrawn by this script, not by Apple, so a wrong
drawing could look right. Freeform keeps its own small preview of every board in
its cache. Every export is compared with that preview; the note says whether it
matched, Freeform's own preview is saved beside it, and a board that does not match
turns the job red once. A board is never filed as "checked" on our say-so alone.

What is exact and what is drawn by us:
  - typed text (sticky notes, text boxes) is copied from the board data;
  - pen strokes are the board's own stroke points, joined up by us;
  - sticky notes, shapes, pictures and connector lines are placed where the data
    says, in a plain style. Rotated items and curved connectors are drawn straight.

Existing boards: the first run is `--baseline`, which records every board already
there WITHOUT filing it (Kevin, 22 Nov 2026: skip the old boards). A baselined board
is filed the first time it changes. A missing or unreadable state file is an error,
never a silent new baseline, because that would swallow new boards for ever.

Failure is loud: no database, zero boards, a state file that will not read, a board
that will not decode, a handwriting read that fails, or a picture that does not
match Freeform's preview all exit 1. A board that failed is not recorded, so the
next run tries it again.
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import warnings
from datetime import date, datetime, timezone

warnings.filterwarnings("ignore")

HOME = os.path.expanduser("~")
DB = os.path.join(HOME, "Library/Group Containers/group.com.apple.freeform/Boards/boards.db")
PREVIEWS = os.path.join(HOME, "Library/Containers/com.apple.freeform/Data/Library/Caches/BoardPreviewImages2")
INBOX = os.path.join(HOME, "Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/00 AI Context/_Inbox")
STATE = os.path.join(HOME, "knowledge-os/freeform_state.json")
OCR_BIN = os.path.join(HOME, "knowledge-os/bin/ocr_image")
SANDBOX = "/usr/bin/sandbox-exec"
NO_NETWORK = "(version 1)(allow default)(deny network*)"
OCR_TIMEOUT = 600

# Apple's reference date (1 Jan 2001) to Unix time.
APPLE_EPOCH = 978307200

# Freeform's item types, as stored in board_items.item_type (read off Kevin's
# boards on 22 Nov 2026 by what each one holds).
T_CONTAINER, T_TEXT, T_LINE, T_IMAGE, T_FILE, T_DRAWING, T_STICKY = 2, 3, 4, 5, 7, 10, 12
KNOWN_TYPES = {T_CONTAINER, T_TEXT, T_LINE, T_IMAGE, T_FILE, T_DRAWING, T_STICKY}

SCALE = 2.0            # pixels per board point: Notes saves Pencil pages at 2x too
MAX_SIDE = 9000        # the full drawing is scaled down to fit this many pixels (240 MB at most)
OVERVIEW_SIDE = 2400   # long side of the whole-board picture
TILE = 1800            # readable parts are cut to this size...
TILE_OVERLAP = 120     # ...overlapping, so a word on a cut line is whole in one of them
MAX_TILES = 36         # a 9,000-pixel board cuts into at most 6 x 6
MARGIN = 30
MATCH_AT = 0.60        # preview match score at or above this counts as a match
PICTURE_PIXELS = 60_000_000   # a pasted picture bigger than this is drawn as a box (180 MB decoded)
TEXT_PT = 12.0         # text size for text boxes, in board points
STICKY_PT = 20.0       # largest text size tried on a sticky note
FONTS = ["/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNS.ttf",
         "/System/Library/Fonts/Supplemental/Arial.ttf"]


class BridgeError(Exception):
    """A failure worth a plain sentence on stdout."""


# ───────────────────────── schemaless protobuf ─────────────────────────
# Freeform stores every record as b"crdt" + a version + a protobuf message.
# There is no published schema, so this reads the wire format alone.

def _varint(b, i):
    x = s = 0
    while True:
        if i >= len(b) or s > 63:
            raise ValueError("varint")
        c = b[i]
        i += 1
        x |= (c & 0x7F) << s
        s += 7
        if not c & 0x80:
            return x, i


def pb_parse(b):
    """[(field, wire type, value)] for one message. Raises ValueError when `b` is
    not a well-formed message."""
    i, out = 0, []
    while i < len(b):
        key, i = _varint(b, i)
        f, w = key >> 3, key & 7
        if f == 0:
            raise ValueError("field 0")
        if w == 0:
            v, i = _varint(b, i)
        elif w == 1:
            if i + 8 > len(b):
                raise ValueError("fixed64")
            v, i = b[i:i + 8], i + 8
        elif w == 5:
            if i + 4 > len(b):
                raise ValueError("fixed32")
            v, i = b[i:i + 4], i + 4
        elif w == 2:
            n, i = _varint(b, i)
            if i + n > len(b):
                raise ValueError("length")
            v, i = b[i:i + n], i + n
        else:
            raise ValueError("wire type")
        out.append((f, w, v))
    return out


def pb_try(b):
    """pb_parse, or None when `b` is empty or not a message."""
    if not b:
        return None
    try:
        return pb_parse(b) or None
    except ValueError:
        return None


def _f32(b):
    return struct.unpack("<f", b)[0]


MAX_DEPTH = 80   # real records nest about 20 deep; past this a record is damaged or hostile


def _finite(*xs):
    return all(x == x and abs(x) < 1e9 for x in xs)


def doc_tables(blob):
    """(uuids, strings, objects) of one crdt record. `uuids` is the record's table
    of 16-byte ids as upper-case hex; a value {6: n} elsewhere in the record points
    at uuids[n]. `strings` is its table of texts; a value {3: n} points at
    strings[n]. `objects` are the record's top-level value messages."""
    if not blob or blob[:4] != b"crdt":
        raise ValueError("not a crdt record")
    uuids, strings, objects = [], [], []
    for f, w, v in pb_parse(blob[8:]):
        if w != 2:
            continue
        if f == 6:
            for ff, ww, vv in pb_parse(v):
                if ff == 1 and ww == 2:
                    uuids = [vv[i:i + 16].hex().upper() for i in range(0, len(vv) - 15, 16)]
                elif ff == 2 and ww == 2:
                    strings.append(vv.decode("utf-8", "replace"))
        elif f in (1, 4):
            objects.append(v)
    return uuids, strings, objects


def _single(v, field, wire):
    r = pb_try(v)
    if r and len(r) == 1 and r[0][0] == field and r[0][1] == wire:
        return r[0][2]
    return None


def _as_vec(v):
    """{4: {1: x, 2: y}} as (x, y). An empty {4: b""} is (0, 0)."""
    r = pb_try(v)
    if not r or len(r) != 1 or r[0][0] != 4 or r[0][1] != 2:
        return None
    if r[0][2] == b"":
        return (0.0, 0.0)
    s = pb_try(r[0][2])
    if s is None or any(w != 5 or f not in (1, 2) for f, w, _ in s):
        return None
    d = {f: _f32(val) for f, w, val in s}
    x, y = d.get(1, 0.0), d.get(2, 0.0)
    return (x, y) if _finite(x, y) else None


def _as_float(v):
    x = _single(v, 15, 5)
    if x is None or not _finite(_f32(x)):
        return None
    return _f32(x)


def _as_int(v):
    return _single(v, 5, 0)


def _as_key(v):
    return _single(v, 6, 0)


def walk(b, ev, depth=0):
    """Append what a record holds to `ev`, in document order:
      ("parent", n)                    a pointer into the record's uuid table
      ("geom", pos, size, angle, flags) an item's place on the board
      ("rgb", (r, g, b))               a colour
      ("f", x)                         a bare number (a stroke's width follows its colour)
      ("path", [(kind, x, y), ...])    a pen path; kind 0 starts a new line
      ("ref", n)                       an optional pointer (a connector's two ends)
      ("str", n)                       a pointer into the record's table of texts
    Raises ValueError on a record nested deeper than MAX_DEPTH, so a damaged
    record is a decode failure and never a RecursionError.
    """
    if depth > MAX_DEPTH:
        raise ValueError("record nested too deep")
    r = pb_try(b)
    if r is None:
        return
    if len(r) == 1 and r[0][0] == 3 and r[0][1] == 0:
        ev.append(("str", r[0][2]))
        return
    pts, n1 = [], 0
    for f, w, v in r:
        if f == 1 and w == 2:
            n1 += 1
            s = pb_try(v)
            if s:
                d = {ff: (ww, vv) for ff, ww, vv in s}
                if 2 in d and d[2][0] == 2 and len(d[2][1]) == 8:
                    x, y = struct.unpack("<ff", d[2][1])
                    kind = d[1][1] if 1 in d and d[1][0] == 0 else 0
                    if not _finite(x, y):
                        raise ValueError("a pen point is not a number")
                    pts.append((kind, x, y))
    if pts and n1 and len(pts) >= n1 * 0.5 and all(f == 1 for f, _, _ in r):
        ev.append(("path", pts))
        return
    kids = [v for f, w, v in r if f == 2 and w == 2]
    if len(kids) >= 3:
        a, c = _as_vec(kids[0]), _as_vec(kids[1])
        if a is not None and c is not None:
            ev.append(("geom", a, c, _as_float(kids[2]) or 0.0, [_as_int(k) for k in kids[3:7]]))
        if len(kids) in (4, 5) and _as_int(kids[0]) is not None \
                and all(_as_float(k) is not None for k in kids[1:]):
            ev.append(("rgb", tuple(_as_float(k) for k in kids[1:4])))
    if len(kids) == 2 and _as_key(kids[0]) is not None and _single(kids[1], 14, 2) is not None:
        ev.append(("parent", _as_key(kids[0])))
    for f, w, v in r:
        if w == 2 and len(v) > 1:
            if f == 9:
                inner = _single(v, 1, 2)
                k = _as_key(inner) if inner is not None else None
                if k is not None:
                    ev.append(("ref", k))
                    continue
            walk(v, ev, depth + 1)
        elif w == 5 and f == 15:
            ev.append(("f", _f32(v)))


def mergeable_strings(b, out=None, depth=0):
    """Every text a record holds, in order. Freeform keeps text as a mergeable
    string: {1: the text as it reads now, 3: one entry per run of typing}."""
    out = [] if out is None else out
    if depth > MAX_DEPTH:
        raise ValueError("record nested too deep")
    r = pb_try(b)
    if r is None:
        return out
    fields = [f for f, _, _ in r]
    if 1 in fields and 3 in fields and r[0][0] == 1 and r[0][1] == 2 \
            and all(w == 2 for f, w, _ in r if f == 3):
        try:
            out.append(r[0][2].decode("utf-8"))
            return out
        except UnicodeDecodeError:
            pass
    for f, w, v in r:
        if w == 2 and len(v) > 1:
            mergeable_strings(v, out, depth + 1)
    return out


# ───────────────────────── reading a board ─────────────────────────

def connect(db):
    if not os.path.exists(db):
        raise BridgeError(f"Freeform's database is not at {db}. Has Freeform ever been opened on this Mac?")
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=30)
        con.execute("select count(*) from boards").fetchone()
    except sqlite3.Error as e:
        raise BridgeError(f"Freeform's database will not open: {e}")
    return con


def board_name(data):
    """The board's title: the first text the board's own record points at."""
    try:
        _, strings, objects = doc_tables(data)
        ev = []
        for o in objects:
            walk(o, ev)
    except (ValueError, IndexError, struct.error, RecursionError):
        return ""       # a damaged title record: the board is still listed, as Untitled
    for e in ev:
        if e[0] == "str" and e[1] < len(strings) and strings[e[1]].strip():
            return " ".join(strings[e[1]].split())      # one line: it becomes a heading
    return ""


def list_boards(con):
    """Live boards as dicts, newest change first."""
    rows = con.execute(
        "select hex(board_identifier), data, last_activity_time from boards "
        "where tombstoned = 0 order by last_activity_time desc").fetchall()
    return [{"id": bid, "name": board_name(data) or "Untitled", "changed": t or 0.0}
            for bid, data, t in rows]


def fingerprint(con, bid, name):
    """A hash of everything on the board that Kevin can change: its title, every
    item and every bucket of pen strokes. Sync bookkeeping columns are left out,
    so a board that only synced does not read as changed."""
    h = hashlib.sha256(name.encode("utf-8"))
    for row in con.execute(
            "select hex(item_uuid), tombstoned, common_data, specific_data from board_items "
            "where hex(board_identifier) = ? order by item_uuid", (bid,)):
        h.update(row[0].encode())
        h.update(str(row[1]).encode())
        h.update(hashlib.sha256(row[2] or b"").digest())
        h.update(hashlib.sha256(row[3] or b"").digest())
    for idx, data in con.execute(
            "select bucket_index, bucket_data from freehand_drawing_buckets "
            "where hex(board_indentifier) = ? order by bucket_index", (bid,)):
        h.update(str(idx).encode())
        h.update(hashlib.sha256(data or b"").digest())
    return h.hexdigest()


def _events(blob):
    ev = []
    if blob and blob[:4] == b"crdt":
        uuids, _, objects = doc_tables(blob)
        for o in objects:
            walk(o, ev)
        return uuids, objects, ev
    return [], [], ev


def _first(ev, kind):
    for e in ev:
        if e[0] == kind:
            return e
    return None


def read_board(con, bid, assets_dir):
    """Everything on one board, with positions worked out in board points.

    Returns {"items": [...], "strokes": [...], "unknown": {type: count}}.
    Raises BridgeError when a record will not decode: a board half read is not
    a board to file."""
    asset_ext = {r[0]: r[1] for r in con.execute("select hex(asset_uuid), extension from assets")}
    items, order, deleted = {}, [], set()
    try:
        for uid, parent, kind, common, specific, tomb in con.execute(
                "select hex(item_uuid), hex(parent_uuid), item_type, common_data, specific_data, "
                "tombstoned from board_items where hex(board_identifier) = ?", (bid,)):
            if tomb:
                deleted.add(uid)
                continue
            _, _, cev = _events(common)
            suuids, sobjects, sev = _events(specific)
            g = _first(cev, "geom")
            it = {"id": uid, "parent": parent or None, "type": kind,
                  "pos": g[1] if g else (0.0, 0.0), "size": g[2] if g else (0.0, 0.0),
                  "angle": g[3] if g else 0.0, "flags": g[4] if g else [],
                  "text": "", "rgb": None, "edge": None, "asset": None, "file": "", "ends": []}
            if kind in (T_TEXT, T_STICKY):
                texts = []
                for o in sobjects:
                    mergeable_strings(o, texts)
                it["text"] = next((t for t in texts if t.strip()), "").strip()
            if kind in (T_TEXT, T_STICKY):
                it["rgb"], it["edge"] = _fill_and_edge(sobjects)
                if kind == T_TEXT and not it["text"] and not it["rgb"] and not it["edge"] \
                        and min(it["size"]) > 0:
                    # A plain shape with nothing set keeps Freeform's default look,
                    # which draws its outline (the frames on one of the first boards read).
                    it["edge"] = (0.6, 0.6, 0.6)
            else:
                c = _first(sev, "rgb")
                it["rgb"] = c[1] if c else None
            if kind in (T_IMAGE, T_FILE):
                found = [u for u in suuids if u in asset_ext]
                it["asset"] = _asset_file(assets_dir, found, asset_ext)
                names = [s for o in sobjects for s in _plain_strings(o) if "." in s]
                it["file"] = names[0] if names else ""
            if kind == T_LINE:
                it["ends"] = [suuids[e[1]] for e in sev if e[0] == "ref" and e[1] < len(suuids)][:2]
            items[uid] = it
            order.append(uid)
        strokes, lost = [], 0
        for (data,) in con.execute(
                "select bucket_data from freehand_drawing_buckets where hex(board_indentifier) = ? "
                "order by bucket_index", (bid,)):
            uuids, objects, _ = _events(data)
            for o in objects:
                ev = []
                walk(o, ev)
                found = _strokes_in(ev, uuids)
                # Every stroke record points at its drawing. One that points and
                # yields no stroke is a stroke we failed to read: count it, so
                # the note and the job say so (0 of 31,400 on 23 Nov 2026).
                lost += sum(1 for e in ev if e[0] == "parent") - len(found)
                strokes.extend(found)
    except (ValueError, IndexError, struct.error, RecursionError, OverflowError) as e:
        raise BridgeError(f"a record on this board would not decode ({type(e).__name__}: {e})")

    def origin(uid, seen=()):
        """Where an item's own corner sits on the board: its place plus its parents'."""
        it = items.get(uid)
        if it is None or uid in seen:
            return (0.0, 0.0)
        px, py = origin(it["parent"], seen + (uid,)) if it["parent"] else (0.0, 0.0)
        return (px + it["pos"][0], py + it["pos"][1])

    out_items = []
    for uid in order:
        it = items[uid]
        it["at"] = origin(uid)
        if it["type"] != T_CONTAINER:
            out_items.append(it)
    live = []
    for s in strokes:
        parent = items.get(s["parent"])
        if parent is None:
            # A stroke whose drawing Kevin deleted is not on the board he sees. A
            # stroke whose drawing is simply not there (not synced yet, or a pointer
            # we misread) is ink we cannot place: that is counted as lost, never
            # dropped without a word.
            if s["parent"] not in deleted:
                lost += 1
            continue
        ox, oy = parent["at"]
        s["at"] = (ox + s["pos"][0], oy + s["pos"][1])
        live.append(s)
    unknown = {}
    for it in out_items:
        if it["type"] not in KNOWN_TYPES:
            unknown[it["type"]] = unknown.get(it["type"], 0) + 1
    return {"items": out_items, "strokes": live, "unknown": unknown, "lost_strokes": lost}


def _members(v):
    """A struct value {4: {1: which members are present, 2: member, 2: member...}}
    as {member number: member}. Anything else is {}."""
    inner = _single(v, 4, 2)
    r = pb_try(inner) if inner else None
    if not r or r[0][0] != 1 or r[0][1] != 2:
        return {}
    return dict(zip(r[0][2], [val for f, w, val in r[1:] if f == 2 and w == 2]))


def _rgb_in(member):
    ev = []
    if member:
        walk(member, ev)
    c = _first(ev, "rgb")
    return c[1] if c else None


def _fill_and_edge(objects):
    """(fill colour, border colour) of a sticky note, text box or shape; None for
    one that is not set. The item's record is a struct whose member 0 is its
    look, and the look's member 0 is the fill and member 1 the border. A text box
    with no fill has an EMPTY member 0: reading "the first colour in the record"
    instead painted a bordered box solid black over the handwriting inside it
    (22 Nov 2026, on the first boards read; caught by the preview check)."""
    for o in objects:
        look = _members(_members(o).get(0, b"")).get(0)
        if look:
            parts = _members(look)
            return _rgb_in(parts.get(0)), _rgb_in(parts.get(1))
    return None, None


def _plain_strings(b, out=None, depth=0):
    out = [] if out is None else out
    if depth > MAX_DEPTH:
        raise ValueError("record nested too deep")
    r = pb_try(b)
    if r is None:
        return out
    for f, w, v in r:
        if w != 2 or not v:
            continue
        try:
            t = v.decode("utf-8")
        except UnicodeDecodeError:
            t = None
        if t is not None and len(t) > 3 and t.isprintable():
            out.append(t)
        else:
            _plain_strings(v, out, depth + 1)
    return out


def _asset_file(assets_dir, found, asset_ext):
    """The first of an item's stored files that exists on disk, biggest last so
    the small preview Freeform keeps is tried after the full picture."""
    paths = []
    for u in found:
        dashed = f"{u[:8]}-{u[8:12]}-{u[12:16]}-{u[16:20]}-{u[20:]}"
        ext = asset_ext.get(u)
        p = os.path.join(assets_dir, dashed + ("." + ext if ext else ""))
        if os.path.exists(p):
            paths.append(p)
    return paths


def _strokes_in(ev, uuids):
    """Pen strokes in one record's events. A stroke is a parent pointer, a place,
    a path, then its colour and width."""
    out, cur = [], None
    i = 0
    while i < len(ev):
        e = ev[i]
        if e[0] == "parent":
            cur = {"parent": uuids[e[1]] if e[1] < len(uuids) else None,
                   "pos": None, "size": None, "path": None, "rgb": (0.0, 0.0, 0.0), "width": 1.0}
        elif cur is not None and e[0] == "geom" and cur["pos"] is None:
            cur["pos"], cur["size"], cur["flags"] = e[1], e[2], e[4]
        elif cur is not None and e[0] == "path" and cur["path"] is None and cur["pos"] is not None:
            cur["path"] = e[1]
            out.append(cur)
        elif cur is not None and e[0] == "rgb" and cur["path"] is not None:
            cur["rgb"] = e[1]
            floats = [x[1] for x in ev[i + 1:i + 6] if x[0] == "f"]
            if len(floats) >= 4 and 0 < floats[3] < 200:
                cur["width"] = floats[3]
            cur = None
        i += 1
    return out


# ───────────────────────── drawing ─────────────────────────

def _pil():
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        raise BridgeError("the Pillow library is missing for this python; nothing can be drawn")
    # Pillow's own size guard is switched off: it also fires on pictures this
    # script makes itself (a 9,000-pixel board, even a line of text), and it only
    # refuses a file at twice its figure. render() checks each pasted picture's
    # size against PICTURE_PIXELS before decoding it, which is exact.
    Image.MAX_IMAGE_PIXELS = None
    return Image, ImageDraw, ImageFont


def _font(size):
    _, _, ImageFont = _pil()
    for path in FONTS:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, max(9, int(size)))
            except OSError:
                continue
    return ImageFont.load_default()


def _text_width(font, text):
    """Width of `text`. Helvetica at very small sizes raises "division by zero"
    inside FreeType (seen at 7 px on a 500-note board); estimate instead."""
    try:
        return font.getlength(text)
    except OSError:
        return len(text) * getattr(font, "size", 10) * 0.5


def _draw_text(d, xy, text, fill, font):
    try:
        d.text(xy, text, fill=fill, font=font)
    except OSError:
        pass        # the words are still in the note as typed text


def _wrap(text, font, width):
    lines = []
    for para in text.split("\n"):
        line = ""
        for word in para.split(" "):
            trial = (line + " " + word).strip()
            if line and _text_width(font, trial) > width:
                lines.append(line)
                line = word
            else:
                line = trial
        lines.append(line)
    return lines


def _colour(rgb, fallback=(0, 0, 0)):
    if not rgb:
        return fallback
    return tuple(max(0, min(255, int(round(c * 255)))) for c in rgb)


def bounds(board):
    xs, ys = [], []
    for it in board["items"]:
        x, y = it["at"]
        w, h = it["size"]
        if it["type"] == T_TEXT and it["text"] and (w <= 0 or h <= 0):
            # A text box that sizes itself stores no size (or a width alone, and
            # wraps to it). Estimate the rest from the words, at Freeform's
            # default text size, so the board's outline comes out the right shape.
            paras = it["text"].split("\n")
            if w <= 0:
                w = TEXT_PT * 0.55 * max(len(p) for p in paras) + 12
            per_line = max(1, int((w - 12) / (TEXT_PT * 0.5)))
            lines = sum(max(1, -(-len(p) // per_line)) for p in paras)
            h = max(h, lines * TEXT_PT * 1.2 + 12)
            it["size"] = (w, h)
        if it["type"] == T_DRAWING:
            continue
        xs += [x, x + w]
        ys += [y, y + h]
    for s in board["strokes"]:
        x, y = s["at"]
        for _, px, py in s["path"]:
            xs.append(x + px)
            ys.append(y + py)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def render(board):
    """The whole board as one picture. Returns (image, pixels per board point)."""
    Image, ImageDraw, _ = _pil()
    box = bounds(board)
    if box is None:
        raise BridgeError("nothing on this board has a place to draw")
    x0, y0, x1, y1 = box
    scale = min(SCALE, (MAX_SIDE - 2 * MARGIN) / max(x1 - x0, y1 - y0, 1.0))
    W, H = int((x1 - x0) * scale) + 2 * MARGIN, int((y1 - y0) * scale) + 2 * MARGIN
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)

    def px(x, y):
        return ((x - x0) * scale + MARGIN, (y - y0) * scale + MARGIN)

    by_id = {it["id"]: it for it in board["items"]}

    def rect(it):
        ax, ay = px(*it["at"])
        return [ax, ay, ax + max(it["size"][0], 1) * scale, ay + max(it["size"][1], 1) * scale]

    for it in board["items"]:                       # pictures and files, underneath
        if it["type"] not in (T_IMAGE, T_FILE):
            continue
        r = rect(it)
        w, h = max(2, int(r[2] - r[0])), max(2, int(r[3] - r[1]))
        pasted = False
        for p in it["asset"] or []:
            try:
                with Image.open(p) as src:
                    if src.size[0] * src.size[1] > PICTURE_PIXELS:
                        continue                        # too big to decode on this Mac
                    src.draft("RGB", (w, h))            # JPEGs decode small from the start
                    src.thumbnail((max(w, 64) * 2, max(h, 64) * 2))
                    im.paste(src.convert("RGB").resize((w, h)), (int(r[0]), int(r[1])))
                pasted = True
                break
            except Exception:
                continue
        if not pasted:
            if it["type"] == T_IMAGE:
                board["undrawn_pictures"] = board.get("undrawn_pictures", 0) + 1
            d.rectangle(r, outline=(120, 120, 120), width=2)
            label = it["file"] or ("picture" if it["type"] == T_IMAGE else "file")
            _draw_text(d, (r[0] + 6, r[1] + 6), label[:60], (90, 90, 90), _font(11 * scale))
    for it in board["items"]:                       # sticky notes and filled shapes
        if it["type"] == T_STICKY:
            d.rectangle(rect(it), fill=_colour(it["rgb"], (255, 229, 120)))
        elif it["type"] == T_TEXT and (it["rgb"] or it["edge"]) and min(it["size"]) > 0:
            d.rectangle(rect(it), fill=_colour(it["rgb"]) if it["rgb"] else None,
                        outline=_colour(it["edge"]) if it["edge"] else None, width=1)
    for it in board["items"]:                       # connector lines
        if it["type"] != T_LINE:
            continue
        ends = [by_id[e] for e in it["ends"] if e in by_id]
        if len(ends) == 2:
            a, b = [((r[0] + r[2]) / 2, (r[1] + r[3]) / 2) for r in (rect(ends[0]), rect(ends[1]))]
        else:
            r = rect(it)
            flip_x = len(it["flags"]) > 2 and it["flags"][2]
            flip_y = len(it["flags"]) > 3 and it["flags"][3]
            a = (r[2] if flip_x else r[0], r[3] if flip_y else r[1])
            b = (r[0] if flip_x else r[2], r[1] if flip_y else r[3])
        d.line([a, b], fill=_colour(it["rgb"]), width=max(1, int(1.5 * scale)))
    for it in board["items"]:                       # typed text, on top of its box
        if it["type"] not in (T_TEXT, T_STICKY) or not it["text"]:
            continue
        r = rect(it)
        width = max(40.0, r[2] - r[0] - 12)
        size = TEXT_PT * scale
        if it["type"] == T_STICKY:
            size = STICKY_PT * scale
            while size > 5 * scale:
                font = _font(size)
                lines = _wrap(it["text"], font, width)
                if len(lines) * size * 1.2 <= (r[3] - r[1] - 12):
                    break
                size -= scale
        font = _font(size)
        lines = _wrap(it["text"], font, width)
        dark = it["type"] == T_STICKY or not it["rgb"] or sum(it["rgb"]) > 1.2
        y = r[1] + 6
        for line in lines:
            _draw_text(d, (r[0] + 6, y), line, (20, 20, 20) if dark else (255, 255, 255), font)
            y += size * 1.2
    for s in board["strokes"]:                      # pen strokes, on top of everything
        ox, oy = s["at"]
        col = _colour(s["rgb"])
        width = max(1, int(round(max(s["width"], 0.8) * scale)))
        line = []
        for kind, x, y in s["path"]:
            if kind == 0 and line:
                _stroke(d, line, col, width)
                line = []
            line.append(px(ox + x, oy + y))
        _stroke(d, line, col, width)
    return im, scale


def _stroke(d, pts, col, width):
    if len(pts) >= 2:
        d.line(pts, fill=col, width=width, joint="curve")
    if pts:
        r = width / 2.0
        for x, y in (pts[0], pts[-1]):
            d.ellipse([x - r, y - r, x + r, y + r], fill=col)


def shrunk(im, side):
    """`im` scaled down so its long side is at most `side`, without first copying
    the full-size picture (a 9,000-pixel board is 200 MB a copy, on a Mac that
    froze for lack of memory on 22 Nov 2026)."""
    Image, _, _ = _pil()
    k = side / float(max(im.size))
    if k >= 1:
        return im.copy()
    return im.resize((max(1, int(im.size[0] * k)), max(1, int(im.size[1] * k))), Image.LANCZOS)


def ink_map(im, n=40):
    """An n x n grid of how dark each part of the picture's inked area is, for
    comparing two pictures of the same board. Darkness is measured against the
    picture's own background and kept as a shade, not on/off: a pen line in a
    400-pixel preview is a faint grey that an on/off cut throws away."""
    Image, _, _ = _pil()
    g = im.convert("L")
    bg = max(g.getcolors(g.size[0] * g.size[1]), key=lambda c: c[0])[1]
    dark = g.point(lambda v: min(255, abs(v - bg) * 3))
    box = dark.point(lambda v: 255 if v > 45 else 0).getbbox()
    if box is None:
        return None, 0.0
    cropped = dark.crop(box)
    aspect = cropped.size[0] / max(1, cropped.size[1])
    return list(cropped.resize((n, n), Image.BOX).getdata()), aspect


def preview_match(im, preview_path):
    """How well our drawing agrees with Freeform's own preview of the board:
    (score 0..1, plain reason). The score is None when there is no preview to
    compare. Our picture is first shrunk to the preview's size, so both have
    been through the same blurring."""
    Image, _, _ = _pil()
    if not preview_path or not os.path.exists(preview_path):
        return None, "Freeform has no preview of this board on this Mac"
    try:
        with Image.open(preview_path) as p:
            theirs_im = p.convert("RGB")
    except Exception as e:
        return None, f"Freeform's preview would not open ({type(e).__name__})"
    small = shrunk(im, max(theirs_im.size))
    theirs, their_aspect = ink_map(theirs_im)
    ours, our_aspect = ink_map(small)
    if theirs is None or ours is None:
        return None, "one of the two pictures is blank"
    n = len(ours)
    ma, mb = sum(ours) / n, sum(theirs) / n
    cov = sum((a - ma) * (b - mb) for a, b in zip(ours, theirs))
    va = sum((a - ma) ** 2 for a in ours)
    vb = sum((b - mb) ** 2 for b in theirs)
    corr = cov / ((va * vb) ** 0.5) if va and vb else 0.0
    shape = min(our_aspect, their_aspect) / max(our_aspect, their_aspect) if our_aspect and their_aspect else 0.0
    score = max(0.0, corr) * shape
    return score, f"ink pattern {corr:.2f}, outline shape {shape:.2f}"


def find_preview(previews, bid):
    """Freeform's newest light preview of a board, or None."""
    dashed = f"{bid[:8]}-{bid[8:12]}-{bid[12:16]}-{bid[16:20]}-{bid[20:]}"
    best = None
    for suffix in ("#_large_2.0_light", "#_large_1.0_light", "#_large_2.0_dark", "#_large_1.0_dark"):
        p = os.path.join(previews, f"board_{dashed}{suffix}")
        if os.path.exists(p):
            best = p
            break
    return best


def tiles(im):
    """The picture cut into readable, overlapping parts, blank parts left out.
    Returns [(label, image)]; [] for a picture small enough to read whole. No
    inked part is ever dropped: a board that would need more than MAX_TILES parts
    is halved in size and cut again."""
    Image, _, _ = _pil()
    if max(im.size) <= OVERVIEW_SIDE:
        return []
    step = TILE - TILE_OVERLAP
    while True:
        W, H = im.size
        cols = max(1, -(-(W - TILE_OVERLAP) // step))
        rows = max(1, -(-(H - TILE_OVERLAP) // step))
        out = []
        for r in range(rows):
            for c in range(cols):
                part = im.crop((c * step, r * step, min(W, c * step + TILE), min(H, r * step + TILE)))
                if part.convert("L").point(lambda v: 255 if v < 200 else 0).getbbox() is None:
                    continue
                out.append((f"row {r + 1} of {rows}, column {c + 1} of {cols}", part))
        if len(out) <= MAX_TILES:
            return out
        im = im.resize((max(1, W // 2), max(1, H // 2)), Image.LANCZOS)


# ───────────────────────── reading the handwriting ─────────────────────────

def read_images(paths, ocr_bin=OCR_BIN):
    """Words in each image, read on this Mac. {path: text}. Raises on failure."""
    if not os.path.exists(ocr_bin):
        raise BridgeError(f"the text reader is missing at {ocr_bin}")
    cmd = [ocr_bin] + paths
    if os.path.exists(SANDBOX):
        cmd = [SANDBOX, "-p", NO_NETWORK] + cmd
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=OCR_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise BridgeError(f"the text reader took longer than {OCR_TIMEOUT} seconds")
    if r.returncode != 0:
        raise BridgeError("the text reader failed: " + (r.stderr.strip()[-300:] or f"exit {r.returncode}"))
    found, cur = {}, None
    for line in r.stdout.splitlines():
        if line.startswith("=== ") and line[4:] in paths:
            cur = line[4:]
            found[cur] = []
        elif cur is not None:
            found[cur].append(line)
    if any(p not in found for p in paths):
        raise BridgeError("the text reader returned nothing for one or more pictures")
    return {p: "\n".join(found[p]).strip() for p in paths}


# ───────────────────────── writing the note ─────────────────────────

def safe_name(t):
    t = re.sub(r"[^0-9A-Za-z _-]", "_", t).strip()
    return (t or "board")[:50]


def free_stem(inbox, name, n_pictures):
    """A file stem that clashes with nothing in the inbox. Names are checked one
    by one, never os.listdir: under launchd python may open a known name in the
    Drive inbox but is refused a listing of it (seen 18 Nov 2026)."""
    i = 1
    while True:
        stem = f"{safe_name(name)} (Freeform board)" + ("" if i == 1 else f" ({i})")
        taken = [stem + ".md", f"{stem} - Freeform preview.png"] + \
                [f"{stem} - handwriting {n}.png" for n in range(1, n_pictures + 11)]
        if not any(os.path.exists(os.path.join(inbox, t)) for t in taken):
            return stem
        i += 1


def when(apple_seconds):
    if not apple_seconds:
        return "an unknown date"
    return datetime.fromtimestamp(apple_seconds + APPLE_EPOCH).strftime("%-d %b %Y at %H:%M")


def reading_order(items):
    return sorted(items, key=lambda it: (round(it["at"][1] / 60.0), it["at"][0]))


def note_text(b, board, stem, pictures, words, check, first_time):
    """The markdown for one board. `pictures` is [(file name, label)], the whole
    board first; `words` maps a file name to its machine-read words."""
    items = board["items"]
    count = lambda t: sum(1 for it in items if it["type"] == t)
    kind, score, reason = check["kind"], check["score"], check["why"]
    out = [f"# {b['name']} (Freeform board)", "",
           f"_From Freeform on Kevin's iPhone, by iCloud. Board last changed {when(b['changed'])}. "
           f"Read from the synced board on this Mac on {date.today().strftime('%-d %b %Y')}._", "",
           f"Freeform board id: {b['id']}", "",
           ("_This is the first time this board has been filed._" if first_time else
            "_This board was filed before and has changed. Update the brain note that carries "
            "this board id; do not make a second note._"), "",
           "## What is on the board", "",
           f"- {len(board['strokes'])} pen stroke(s) in {count(T_DRAWING)} drawing(s)",
           f"- {count(T_STICKY)} sticky note(s), {count(T_TEXT)} text box(es) or shape(s), "
           f"{count(T_LINE)} connector line(s)",
           f"- {count(T_IMAGE)} picture(s), {count(T_FILE)} attached file(s) or link(s)"]
    for t, n in sorted(board["unknown"].items()):
        out.append(f"- {n} item(s) of a kind this bridge cannot draw (Freeform type {t}). "
                   f"They are NOT in the picture. Open the board in Freeform to see them.")
    if board.get("lost_strokes"):
        out.append(f"- {board['lost_strokes']} PEN STROKE(S) COULD NOT BE READ and are missing from "
                   f"the picture. Open the board in Freeform to see them.")
    if board.get("undrawn_pictures"):
        out.append(f"- {board['undrawn_pictures']} picture(s) on the board could not be drawn and "
                   f"show as empty grey boxes. Open the board in Freeform to see them.")
    if kind == "match":
        out.append(f"- Picture check: the redrawn board matches Freeform's own preview "
                   f"(score {score:.2f}: {reason}).")
    elif kind == "match_old":
        out.append(f"- Picture check: the redrawn board matches Freeform's own preview (score "
                   f"{score:.2f}: {reason}), but Freeform drew that preview before this change "
                   f"reached the Mac. It confirms the board's layout, not the newest marks.")
    elif kind == "mismatch":
        out.append(f"- Picture check: THE REDRAWN BOARD DOES NOT MATCH FREEFORM'S OWN PREVIEW "
                   f"(score {score:.2f}: {reason}). Trust the Freeform preview and the typed "
                   f"text, not the redrawn picture, and open the board in Freeform before acting.")
    else:
        out.append(f"- Picture check: NOT CHECKED. {reason}. Treat the picture as unconfirmed.")
    out.append("")
    stickies = [it for it in reading_order(items) if it["type"] == T_STICKY and it["text"]]
    boxes = [it for it in reading_order(items) if it["type"] == T_TEXT and it["text"]]
    if stickies or boxes:
        out += ["## Typed text (copied from the board, top to bottom)", ""]
        for title, group in (("Sticky notes", stickies), ("Text boxes", boxes)):
            if group:
                out += [f"### {title}", ""]
                out += ["- " + it["text"].replace("\n", "\n  ") for it in group]
                out.append("")
    by_id = {it["id"]: it for it in items}
    links = []
    for it in items:
        if it["type"] == T_LINE and len(it["ends"]) == 2:
            a, c = by_id.get(it["ends"][0]), by_id.get(it["ends"][1])
            if a and c and (a["text"] or c["text"]):
                label = lambda x: '"' + (x["text"].split("\n")[0][:80] or "an item with no text") + '"'
                links.append(f"- {label(a)} is joined to {label(c)}")
    if links:
        out += ["## Connector lines (which items are joined)", "",
                "_The data says which two items a line joins. The direction of the arrow is "
                "not read: check the picture._", ""] + sorted(set(links)) + [""]
    files = sorted({it["file"] for it in items if it["type"] in (T_IMAGE, T_FILE) and it["file"]})
    if files:
        out += ["## Pictures and files on the board", ""] + [f"- {f}" for f in files] + [""]
    out += ["## Handwriting (machine-read)", "",
            f"_The pictures below were redrawn from the board's own data. The words under each "
            f"were read by Apple's text recognition, on this Mac, on "
            f"{date.today().strftime('%-d %b %Y')}. Machine-read handwriting holds wrong words: "
            f"check the picture before acting on any name, number or date. The image files belong "
            f"to this note: move them to _processed with it and do not make a separate note from "
            f"them._", ""]
    for n, (fname, label) in enumerate(pictures, 1):
        out += [f"### Picture {n}: {label}", "", f"![[{fname}]]", "", f"Image file: {fname}", ""]
        if fname in words:
            w = words[fname]
            out += (["```text", w.replace("```", "'''"), "```", ""] if w else
                    ["(No words found in this picture.)", ""])
    return "\n".join(out).rstrip("\n") + "\n"


def has_content(board):
    """True when the board shows anything. A drawing with no strokes left (all
    erased, or its ink not synced yet) shows nothing."""
    return bool(board["strokes"]) or any(it["type"] != T_DRAWING for it in board["items"])


def check_picture(im, preview, floor):
    """Our drawing against Freeform's own preview of the board.

    `floor` is the latest moment (Unix time) at which this Mac is KNOWN to have
    still held the board as it was: the last run that saw it unchanged, or the
    moment this run watched its new data arrive. A preview drawn after the floor
    may show the new board; one drawn before it certainly shows the old one.

    Returns {"kind", "score", "why", "preview"}; kind is one of
      match      agrees with a preview drawn after the floor
      match_old  agrees with a preview drawn before it: the layout is confirmed,
                 the newest marks are not (the note says exactly that)
      mismatch   disagrees with a preview drawn after the floor: the run goes red
      unchecked  no usable preview, or disagrees with a preview from before the
                 floor (a picture of the old board is SUPPOSED to differ)
    Timing decides only which kind of "disagrees" it is. Agreement is never thrown
    away for timing: an earlier rule did that and the control stopped running
    whenever another board synced a few seconds later (review, 23 Nov 2026)."""
    out = {"kind": "unchecked", "score": None, "why": "", "preview": None}
    if not preview:
        out["why"] = "Freeform has no preview of this board on this Mac"
        return out
    score, why = preview_match(im, preview)
    if score is None:
        out["why"] = why
        return out
    after = os.path.getmtime(preview) > floor
    out.update(score=score, why=why, preview=preview)
    if score >= MATCH_AT:
        out["kind"] = "match" if after else "match_old"
    elif after:
        out["kind"] = "mismatch"
    else:
        out.update(kind="unchecked", preview=None,
                   why="Freeform has not redrawn its preview since this board changed")
    return out


def plain_note(inbox, b, first_time, lines):
    """A note with no pictures, for a board there is nothing to draw of."""
    stem = free_stem(inbox, b["name"], 0)
    path = os.path.join(inbox, stem + ".md")
    with open(path, "w") as f:
        f.write(f"# {b['name']} (Freeform board)\n\n_From Freeform on Kevin's iPhone, by iCloud. Read "
                f"from the synced board on this Mac on {date.today().strftime('%-d %b %Y')}._\n\n"
                f"Freeform board id: {b['id']}\n\n" +
                ("_This is the first time this board has been filed._" if first_time else
                 "_This board was filed before and has changed. Update the brain note that carries "
                 "this board id; do not make a second note._") +
                "\n\n## What is on the board\n\n" + "\n".join("- " + l for l in lines) + "\n")
    return stem, path


def export_board(con, b, inbox, previews, assets_dir, first_time, do_ocr=True, ocr_bin=OCR_BIN,
                 floor=0.0):
    """File one board into `inbox`. Returns None for a board with nothing on it
    that was never filed, else {"stem", "pictures", "check", "lost", "written"}.
    Everything is built in a scratch folder first; on any failure nothing is left
    in the inbox, so the board is tried again next run."""
    Image, _, _ = _pil()
    board = read_board(con, b["id"], assets_dir)
    unchecked = {"kind": "unchecked", "score": None, "why": "there is no picture to check", "preview": None}
    if not has_content(board):
        if board["lost_strokes"]:
            # Ink we cannot place and nothing else: say so ONCE and record the
            # board. Raising here made it fail every night for ever.
            stem, path = plain_note(inbox, b, first_time, [
                f"{board['lost_strokes']} PEN STROKE(S) COULD NOT BE READ and nothing else is on "
                f"the board, so there is no picture. Open the board in Freeform to see it."])
            return {"stem": stem, "pictures": 0, "check": unchecked, "lost": board["lost_strokes"],
                    "written": [path]}
        if first_time:
            return None
        # Filed before, shows nothing now. That is either Kevin clearing it or its
        # ink not having reached this Mac yet, and the data cannot say which.
        stem, path = plain_note(inbox, b, first_time, [
            "NOTHING is on the board now. Either Kevin cleared it, or its ink has not reached this "
            "Mac yet (it is filed again if ink arrives). Keep everything in the brain note and add "
            "one dated line saying the board read as empty."])
        return {"stem": stem, "pictures": 0, "check": unchecked, "lost": 0, "written": [path],
                "emptied": True}
    im, _ = render(board)
    check = check_picture(im, find_preview(previews, b["id"]), floor)
    preview = check["preview"]
    whole = shrunk(im, OVERVIEW_SIDE)
    parts = tiles(im)
    scratch = tempfile.mkdtemp(prefix="freeform-")
    try:
        # Scratch names carry no title: an error message may quote a path.
        local = [("page-0.png", "the whole board", whole)] + \
                [(f"page-{i}.png", f"a closer part ({label})", part) for i, (label, part) in enumerate(parts, 1)]
        for fname, _, img in local:
            img.save(os.path.join(scratch, fname), optimize=True)
        to_read = [os.path.join(scratch, f) for f, _, _ in (local[1:] if parts else local)]
        read = read_images(to_read, ocr_bin) if do_ocr else {}
        stem = free_stem(inbox, b["name"], len(local))
        names = [f"{stem} - handwriting {n}.png" for n in range(1, len(local) + 1)]
        words = {names[i]: read[os.path.join(scratch, local[i][0])]
                 for i in range(len(local)) if os.path.join(scratch, local[i][0]) in read}
        pictures = [(names[i], local[i][1]) for i in range(len(local))]
        text = note_text(b, board, stem, pictures, words, check, first_time)
        if preview:
            text += (f"\n## Freeform's own preview\n\n_Apple's small picture of the whole board, "
                     f"kept as the check on the redrawn pictures above._\n\n"
                     f"![[{stem} - Freeform preview.png]]\n\nImage file: {stem} - Freeform preview.png\n")
        written = []
        try:
            for i, (fname, _, _) in enumerate(local):
                written.append(os.path.join(inbox, names[i]))
                shutil.copyfile(os.path.join(scratch, fname), written[-1])
            if preview:
                written.append(os.path.join(inbox, f"{stem} - Freeform preview.png"))
                with Image.open(preview) as p:
                    p.convert("RGB").save(written[-1])
            written.append(os.path.join(inbox, stem + ".md"))
            with open(written[-1], "w") as f:
                f.write(text)
        except BaseException:
            _remove(written)
            raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return {"stem": stem, "pictures": len(local), "check": check, "lost": board["lost_strokes"],
            "written": written}


def _remove(paths):
    for w in paths:
        try:
            os.remove(w)
        except OSError:
            pass


def _epoch(iso):
    try:
        return datetime.fromisoformat(iso).timestamp()
    except (TypeError, ValueError):
        return 0.0


# ───────────────────────── state ─────────────────────────

def load_state(path):
    """The state file, or None when it does not exist. Raises when it exists and
    will not read: an unreadable state is never treated as a fresh start."""
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            state = json.load(f)
        if not isinstance(state.get("boards"), dict):
            raise ValueError("no boards map")
    except (OSError, ValueError) as e:
        raise BridgeError(f"the Freeform state file at {path} will not read ({e}). "
                          f"Nothing was exported. Restore it or run --baseline again on purpose.")
    return state


def save_state(path, state):
    """Write to a temp file and rename: a rewrite in place is empty for an
    instant, and an empty state reads as broken."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)
    os.replace(tmp, path)


# ───────────────────────── sync ─────────────────────────

def _freeform_pids():
    r = subprocess.run(["/usr/bin/pgrep", "-x", "Freeform"], capture_output=True, text=True, timeout=30)
    return [int(p) for p in r.stdout.split() if p.isdigit()]


def _snapshot(db):
    """A cheap picture of the database: for every board, how many items and
    stroke buckets it has, their newest row and their total size, plus when the
    write-ahead log last moved. None when the database will not read."""
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=10)
        try:
            per = {}
            for bid, n, size, tomb in con.execute(
                    "select hex(board_identifier), 1, length(data), tombstoned from boards"):
                per[bid] = [(n, size, tomb)]
            for sql in ("select hex(board_identifier), count(*), max(rowid), "
                        "sum(length(common_data)) + sum(length(specific_data)) from board_items group by 1",
                        "select hex(board_indentifier), count(*), max(rowid), sum(length(bucket_data)) "
                        "from freehand_drawing_buckets group by 1"):
                for row in con.execute(sql):
                    per.setdefault(row[0], []).append(tuple(row[1:]))
        finally:
            con.close()
    except sqlite3.Error:
        return None
    wal = db + "-wal"
    return {k: tuple(v) for k, v in per.items()}, (os.path.getmtime(wal) if os.path.exists(wal) else 0)


def _boards_changed(a, b):
    """Ids of the boards that differ between two snapshots."""
    if not (isinstance(a, tuple) and isinstance(b, tuple) and isinstance(a[0], dict) and isinstance(b[0], dict)):
        return set()
    return {k for k in set(a[0]) | set(b[0]) if a[0].get(k) != b[0].get(k)}


def sync(db, min_wait=90, quiet=40, max_wait=600, sleep=time.sleep):
    """Open Freeform hidden so iCloud brings the boards down, wait until the
    database has been quiet for `quiet` seconds, then close Freeform again if this
    run opened it. Freeform is opened with `open`, never an Apple Event: an Apple
    Event from a night job raises a permission pop-up nobody can see (the 18 Nov
    2026 Reminders freeze). Returns (seconds waited, {board id: Unix time its data
    was last seen arriving during the wait}, whether anything changed at all).

    Nothing here can prove iCloud delivered: a quiet database is also what a sync
    that never started looks like. So a quiet night is reported as "nothing
    arrived", and a change that lands after this run is not lost: the board still
    differs from the state file and is filed by the next run."""
    was_running = bool(_freeform_pids())
    if not was_running:
        r = subprocess.run(["/usr/bin/open", "-gj", "-a", "Freeform"], capture_output=True, text=True,
                           timeout=60)
        if r.returncode != 0:
            raise BridgeError("Freeform would not open: " + (r.stderr.strip() or f"exit {r.returncode}"))
    start = time.time()
    first = _snapshot(db)
    last, still_since, arrivals, any_change = first, start, {}, False
    try:
        while True:
            sleep(5)
            now = time.time()
            snap = _snapshot(db)
            if snap != last:
                for bid in _boards_changed(last, snap):
                    arrivals[bid] = now
                last, still_since = snap, now
                any_change = any_change or snap != first
            if now - start >= min_wait and snap is not None and now - still_since >= quiet:
                break
            if now - start >= max_wait:
                raise BridgeError(f"Freeform's database was still changing after {max_wait} seconds. "
                                  f"Nothing was exported; the next run tries again.")
        if not _freeform_pids():
            raise BridgeError("Freeform is not running after being opened, so nothing can have synced.")
    finally:
        if not was_running:
            for pid in _freeform_pids():
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
    return int(time.time() - start), arrivals, any_change


# ───────────────────────── the run ─────────────────────────

UNCHECKED_LIMIT = 3     # this many filings in a row with no preview check turns the job red


def run(args):
    arrivals = {}
    if not args.no_sync:
        waited, arrivals, any_change = sync(args.db)
        print(f"Freeform was open for {waited} s. " +
              ("New board data arrived from iCloud." if any_change else "Nothing arrived from iCloud."))
    con = connect(args.db)
    boards = list_boards(con)
    if not boards:
        raise BridgeError("Freeform's database holds no boards at all. Kevin has boards, so this is "
                          "a sync or sign-in fault on this Mac, not an empty week.")
    for b in boards:
        b["fingerprint"] = fingerprint(con, b["id"], b["name"])
    assets_dir = os.path.join(os.path.dirname(args.db), "Assets")

    if args.list:
        for b in boards:
            print(f"{b['id']}  {when(b['changed'])}  {b['name']}")
        return 0

    state = load_state(args.state)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if args.baseline:
        if state is not None and not args.force:
            raise BridgeError(f"a state file already exists at {args.state}. A second baseline would "
                              f"hide every board changed since the first. Pass --force to mean it.")
        state = {"version": 1, "baseline_at": now, "boards": {
            b["id"]: {"fingerprint": b["fingerprint"], "filed_at": None, "seen_at": now} for b in boards}}
        save_state(args.state, state)
        print(f"Baseline: {len(boards)} existing board(s) recorded. None filed. "
              f"A board is filed the first time it changes.")
        return 0
    if state is None:
        raise BridgeError(f"there is no Freeform state file at {args.state}. Run --baseline once "
                          f"first, so the boards already there are not all filed as new.")

    if not os.path.isdir(args.inbox):
        # Never create it: when Google Drive is not mounted, making the folder
        # builds a local look-alike, the notes land nowhere and are marked filed.
        raise BridgeError(f"the brain inbox is not there ({args.inbox}). Google Drive is not "
                          f"mounted, so nothing was filed and nothing was recorded.")
    filed = failed = unmatched = partial = checked = unchecked = 0
    for b in boards:
        known = state["boards"].get(b["id"])
        if known and known.get("fingerprint") == b["fingerprint"]:
            known["seen_at"] = now          # still as recorded: the floor for its next change
            continue
        # The latest moment this Mac is known to have held the board as it WAS.
        floor = max(_epoch(known.get("seen_at")) if known else 0.0,
                    arrivals[b["id"]] - 6 if b["id"] in arrivals else 0.0)   # 6 s: one poll, and a bit
        first_time = not (known and known.get("filed_at"))
        try:
            done = export_board(con, b, args.inbox, args.previews, assets_dir, first_time,
                                do_ocr=not args.no_ocr, ocr_bin=args.ocr_bin, floor=floor)
        except Exception as e:
            failed += 1
            # The title and the full error go to the log only (the wrapper filters
            # "Skipped:" from stdout): a title is free text and could trip the job
            # runner's failure markers. A failed board keeps its old state entry,
            # floor included, so the retry judges its preview on the same terms.
            print(f"Skipped: {b['name']} ({e})")
            print(f"ERROR: could not file a Freeform board: "
                  f"{e if isinstance(e, BridgeError) else type(e).__name__}")
            continue
        entry = {"fingerprint": b["fingerprint"], "seen_at": now,
                 "filed_at": known.get("filed_at") if known else None}
        if done is not None:
            entry["filed_at"] = now
        state["boards"][b["id"]] = entry
        try:
            save_state(args.state, state)   # after every board: a later failure must not lose it
        except OSError as e:
            # The note is in the inbox and the state cannot record it. Take the
            # note back out, or tomorrow files the same board a second time.
            _remove(done["written"] if done else [])
            raise BridgeError(f"the Freeform state file could not be saved ({e}). The board just "
                              f"filed was taken back out of the inbox; nothing further was done.")
        if done is None:                      # an empty board never filed: remembered, nothing to say
            continue
        filed += 1
        partial += 1 if done["lost"] else 0
        kind = done["check"]["kind"]
        if kind == "mismatch":
            unmatched += 1
        if done["pictures"]:
            if kind == "unchecked":
                unchecked += 1
            else:
                checked += 1
        print(f"Exported: {done['stem']}.md (+{done['pictures']} picture(s))")
    # The check on the check: a preview comparison that never runs is no control.
    streak = 0 if checked else int(state.get("unchecked_streak", 0)) + unchecked
    state["unchecked_streak"] = streak
    save_state(args.state, state)
    newest = max(b["changed"] for b in boards)
    print(f"Done. {len(boards)} board(s) seen, newest change {when(newest)}. "
          f"{filed} new or changed board(s) filed in the brain inbox.")
    if unchecked:
        print(f"WARNING: {unchecked} filed board(s) had no current Freeform preview to check the "
              f"picture against. Each note says NOT CHECKED.")
    if streak >= UNCHECKED_LIMIT:
        print(f"ERROR: the last {streak} Freeform boards filed had no preview to check the picture "
              f"against, so the picture check is not running. Freeform may have stopped drawing "
              f"previews when opened hidden.")
    if unmatched:
        print(f"ERROR: {unmatched} filed board(s) do not match Freeform's own preview. Each note "
              f"says so. Open the board in Freeform to check it.")
    if partial:
        print(f"ERROR: {partial} filed board(s) hold pen strokes the bridge could not read. Each "
              f"note says how many.")
    if failed:
        print(f"ERROR: {failed} board(s) could not be filed. They stay queued for the next run.")
    return 1 if failed or unmatched or partial or streak >= UNCHECKED_LIMIT else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="File new and changed Freeform boards into the brain inbox.")
    ap.add_argument("--db", default=DB)
    ap.add_argument("--state", default=STATE)
    ap.add_argument("--inbox", default=INBOX)
    ap.add_argument("--previews", default=PREVIEWS)
    ap.add_argument("--ocr-bin", default=OCR_BIN)
    ap.add_argument("--baseline", action="store_true",
                    help="record every board now on this Mac without filing any")
    ap.add_argument("--force", action="store_true", help="with --baseline: replace an existing state file")
    ap.add_argument("--list", action="store_true", help="print the boards and stop")
    ap.add_argument("--no-sync", action="store_true", help="read the database as it is; do not open Freeform")
    ap.add_argument("--no-ocr", action="store_true", help="skip the handwriting read (tests only)")
    args = ap.parse_args(argv)
    try:
        return run(args)
    except BridgeError as e:
        print(f"ERROR: {e}")
    except sqlite3.Error as e:
        print(f"ERROR: Freeform's database could not be read ({type(e).__name__}: {e}). Nothing was filed.")
    except OSError as e:
        print(f"ERROR: a file could not be read or written ({type(e).__name__}: {e.strerror or e}).")
    except subprocess.TimeoutExpired:
        print("ERROR: Freeform did not answer in time. Nothing was filed.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
