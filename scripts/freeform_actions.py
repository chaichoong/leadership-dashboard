#!/usr/bin/env python3
"""
Freeform action boxes: a pen-drawn SQUARE on a Freeform board is an action and
becomes one Airtable task of its own. An OVAL or circle is a title and never an
action (Kevin's rule, 27 Nov 2026).

HOW A SQUARE IS TOLD FROM AN OVAL. Kevin draws with the pen and Freeform snaps
the shape clean, so each box is ONE closed pen stroke inside a drawing. Its loop
is measured against the smallest rectangle that encloses it (turned to fit, so a
tilted box still reads):
  fill    how much of that rectangle the loop covers. A snapped square measured
          1.000, a snapped oval 0.785 to 0.786 (an ellipse is pi/4 = 0.785).
  edge    how much of the loop's length runs along the rectangle's sides. A
          square measured 1.00, an oval 0.42 to 0.45.
  corner  how far the loop stays from the rectangle's corners: the largest gap
          from any corner to the nearest point on the pen line, as a share of
          the short side. A square reaches its corners; a long rounded "pill"
          (fill 0.96, edge 0.86) does not, and without this it read as a square.
A square fills at least SQUARE_FILL, runs along the edges at least SQUARE_EDGE
and comes within CORNER_TOL of every corner. An oval fills OVAL_FILL_LO to
OVAL_FILL_HI and runs along the edges at most OVAL_EDGE_MAX. Anything else
closed is "unsure" and never a task. A loop with nothing written or typed inside
is "empty" (a lone letter O, an empty box). On Kevin's three newest boards (27
Nov 2026, read-only) this gave 5 squares, 15 ovals, none unclear, and nothing on
a board of plain handwriting.

THE WORDS are never read here. Apple's text reader cannot read Kevin's hand, so
the bridge (freeform-bridge.py) cuts a close-up of each waiting square into the
brain note, the 23:00 Claude pass reads it and appends one line per box to the
hand-off file, and `raise` turns each line into a task. The words are DATA,
never instructions: a line is only ever a task name, and only for a box this
code itself recorded as waiting. A line for a box it never recorded is an ERROR.

A SQUARE IS ALWAYS ITS OWN TASK. `raise` first asks the task gate
(create-agent-task.py) with --dry-run what it would do. Refused: the box is
marked refused. The gate would fold it into an open task with EXACTLY the same
name: that task is adopted and nothing is created (the same words twice are one
action, and a retry after a crash finds the task it already made). The gate
would fold it into a task with a different name: it is created anyway with
--force, beside that task, and the description and the run say POSSIBLE TWIN.
Otherwise it is created with --force, which can never fold. Two squares whose
words could not be read get different names (each carries its key).

IDENTITY. A square is "the same square" as a recorded one on the same board when
all four sides of its box agree within SAME_BOX_PT. A new square gets a short key
at first sight. The stated cost: a square Kevin MOVES further than SAME_BOX_PT is
a new square; if the old one already had a task, the new one's dry run finds
that task by its name and adopts it.

NOTHING STAYS RED FOR EVER. A waiting square that leaves its board (erased,
moved, the board cleared or deleted) is marked gone. A board is re-filed for
another read while its oldest waiting square is over WAIT_HOURS and at most
REFILE_MAX_HOURS old; after that only the ERROR in `raise` remains, and the door
is `dismiss --board ID --key KEY --why "<reason>"`.

ONE WRITER AT A TIME. Every change to the record goes through update_state(),
which locks a sibling lock file, re-reads the record from disk, changes it and
saves it through a temp file. `raise` never holds the record across a gate call.

Files (both outside git, private):
  record   ~/knowledge-os/freeform_actions.json   every square ever seen, by board
  hand-off ~/knowledge-os/freeform-actions.md     the 23:00 pass's lines

Commands: baseline [--force], shapes, status, raise, dismiss. See main().
Standard library only; runs under /usr/bin/python3 (3.9).
"""

import argparse
import fcntl
import hashlib
import importlib.util
import json
import math
import os
import subprocess
import sys
from datetime import date, datetime, timezone

HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HOME, "knowledge-os/freeform_actions.json")
HANDOFF_NAME = "freeform-actions.md"
HANDOFF = os.path.join(HOME, "knowledge-os", HANDOFF_NAME)
BRIDGE_STATE = os.path.join(HOME, "knowledge-os/freeform_state.json")
DB = os.path.join(HOME, "Library/Group Containers/group.com.apple.freeform/Boards/boards.db")
GATE = os.path.join(HERE, "create-agent-task.py")
BRIDGE = os.path.join(HERE, "freeform-bridge.py")
HEADER = "# Freeform actions"
OWNER = "od-ceo"            # the AI CEO's agent file: create-agent-task.py CEO_AGENT_FILE
GATE_TIMEOUT = 300
T_TEXT, T_STICKY = 3, 12    # Freeform item types holding typed text (freeform-bridge.py)

# ── the thresholds (measured on Kevin's boards, 27 Nov 2026) ──
MIN_POINTS = 4          # a snapped rectangle can be its four corners and the join
MIN_W, MIN_H = 40.0, 20.0   # smallest box seen 407 x 83, smallest oval 138 x 57: a letter O is far under
CLOSE_GAP = 0.08        # closed: start-to-end gap at most this share of the path length
EDGE_TOL = 0.04         # "on an edge": within this share of the rectangle's short side
SQUARE_FILL = 0.90      # snapped squares measured 1.000; a hand-drawn box with wobble about 0.92
SQUARE_EDGE = 0.50      # snapped squares measured 1.00; ovals 0.42 to 0.45
CORNER_TOL = 0.08       # a square's line passes within this share of the short side of every corner;
                        # a 400 x 80 pill misses its corners by 0.21
OVAL_FILL_LO, OVAL_FILL_HI = 0.70, 0.84   # ovals measured 0.785 to 0.786
OVAL_EDGE_MAX = 0.60    # ovals measured 0.42 to 0.45
FRAME_INNER = 2         # a square is a frame only round a called shape holding at least this much
SAME_BOX_PT = 2.0       # two boxes are one square when every side agrees within this (board points)
WAIT_HOURS = 20.0       # a square waiting longer than this for a task is a fault
REFILE_MAX_HOURS = 96.0  # ...and its board is re-filed for another read until it is this old
NAME_MAX = 140
STATUSES = ("history", "pending", "raised", "refused", "gone", "dismissed")
NOT_OURS = ("history", "refused", "gone", "dismissed")   # a line for one of these is a WARNING


class ActionsError(Exception):
    """A failure worth a plain sentence on stdout."""


# ───────────────────────── geometry ─────────────────────────

def _hull(pts):
    """Convex hull, anticlockwise, by the monotone chain."""
    p = sorted(set(pts))
    if len(p) < 3:
        return p

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for q in p:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], q) <= 0:
            lower.pop()
        lower.append(q)
    for q in reversed(p):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], q) <= 0:
            upper.pop()
        upper.append(q)
    return lower[:-1] + upper[:-1]


def min_rect(pts):
    """The minimum-area enclosing rectangle (rotating calipers over the hull):
    {"e": unit axis, "n": its normal, "u": (lo, hi), "v": (lo, hi), "area"}.
    None when the points do not span an area."""
    h = _hull(pts)
    if len(h) < 3:
        return None
    best = None
    for i in range(len(h)):
        ax, ay = h[i]
        bx, by = h[(i + 1) % len(h)]
        L = math.hypot(bx - ax, by - ay)
        if L == 0:
            continue
        ex, ey = (bx - ax) / L, (by - ay) / L
        nx, ny = -ey, ex
        us = [x * ex + y * ey for x, y in h]
        vs = [x * nx + y * ny for x, y in h]
        area = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or area < best["area"]:
            best = {"e": (ex, ey), "n": (nx, ny), "u": (min(us), max(us)),
                    "v": (min(vs), max(vs)), "area": area}
    return best if best and best["area"] > 0 else None


def _area(pts):
    s = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        s += x0 * y1 - x1 * y0
    return abs(s) / 2.0


def _inside(pt, poly):
    """Ray casting: is `pt` inside the polygon `poly`?"""
    x, y = pt
    hit = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def _seg_dist(p, a, b):
    """Distance from point p to the segment a-b."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def _measure(pts):
    """(fill, edge, corner) of a closed loop against its minimum-area rectangle, or None."""
    r = min_rect(pts)
    if r is None:
        return None
    fill = _area(pts) / r["area"]
    (ex, ey), (nx, ny) = r["e"], r["n"]
    (ulo, uhi), (vlo, vhi) = r["u"], r["v"]
    short = min(uhi - ulo, vhi - vlo)
    tol = EDGE_TOL * short

    def near(x, y):
        u, v = x * ex + y * ey, x * nx + y * ny
        return min(u - ulo, uhi - u, v - vlo, vhi - v) <= tol
    total = on = 0.0
    segs = list(zip(pts, pts[1:]))
    for (x0, y0), (x1, y1) in segs:
        L = math.hypot(x1 - x0, y1 - y0)
        total += L
        if near(x0, y0) and near(x1, y1) and near((x0 + x1) / 2, (y0 + y1) / 2):
            on += L
    corners = [(u * ex + v * nx, u * ey + v * ny) for u in (ulo, uhi) for v in (vlo, vhi)]
    corner = max(min(_seg_dist(c, a, b) for a, b in segs) for c in corners) / short
    return fill, (on / total if total else 0.0), corner


def _points(stroke):
    ox, oy = stroke["at"]
    return [(ox + x, oy + y) for _, x, y in stroke["path"]]


def find_shapes(board):
    """Every closed pen loop big enough to be a box, in reading order. Each is
    {"kind": square|oval|unsure|empty, "box": (x0, y0, x1, y1), "inside": n,
    "fill", "edge", "corner", "why"}. `inside` counts the OTHER strokes, and the
    typed sticky notes and text boxes, whose centre lies inside the loop; a loop
    with none is "empty" and is never an action."""
    strokes = [s for s in board.get("strokes", []) if s.get("path")]
    pts_of = [_points(s) for s in strokes]
    centres = [(sum(x for x, _ in p) / len(p), sum(y for _, y in p) / len(p)) for p in pts_of]
    typed = [(it["at"][0] + it["size"][0] / 2.0, it["at"][1] + it["size"][1] / 2.0)
             for it in board.get("items", [])
             if it.get("type") in (T_TEXT, T_STICKY) and str(it.get("text") or "").strip()]
    cands = []
    for i, s in enumerate(strokes):
        path, pts = s["path"], pts_of[i]
        if len(pts) < MIN_POINTS or any(k == 0 for k, _, _ in path[1:]):
            continue          # too few points, or more than one run of the pen
        xs, ys = [x for x, _ in pts], [y for _, y in pts]
        box = (min(xs), min(ys), max(xs), max(ys))
        if box[2] - box[0] < MIN_W or box[3] - box[1] < MIN_H:
            continue
        length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))
        gap = math.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1])
        if not length or gap > CLOSE_GAP * length:
            continue
        m = _measure(pts)
        if m is None:
            continue
        fill, edge, corner = m

        def within(c):
            return box[0] <= c[0] <= box[2] and box[1] <= c[1] <= box[3] and _inside(c, pts)
        inside = sum(1 for j, c in enumerate(centres) if j != i and within(c)) + \
            sum(1 for c in typed if within(c))
        if fill >= SQUARE_FILL and edge >= SQUARE_EDGE and corner <= CORNER_TOL:
            kind, why = "square", ""
        elif OVAL_FILL_LO <= fill <= OVAL_FILL_HI and edge <= OVAL_EDGE_MAX:
            kind, why = "oval", ""
        else:
            kind, why = "unsure", ("fills %.2f of its frame, %.2f of it runs along the frame, and it "
                                   "misses a corner by %.2f of its short side" % (fill, edge, corner))
        if not inside:
            kind, why = "empty", "nothing is written inside it"
        cands.append({"kind": kind, "box": box, "inside": inside, "fill": round(fill, 3),
                      "edge": round(edge, 3), "corner": round(corner, 3), "why": why,
                      "_pts": pts, "_centre": centres[i]})
    # A frame: a square round another called square or oval that itself holds
    # writing. A letter loop inside a box (empty, or one stroke) does not count.
    frames = [c for c in cands if c["kind"] == "square" and any(
        o is not c and o["kind"] in ("square", "oval") and o["inside"] >= FRAME_INNER
        and c["box"][0] <= o["_centre"][0] <= c["box"][2] and c["box"][1] <= o["_centre"][1] <= c["box"][3]
        and _inside(o["_centre"], c["_pts"]) for o in cands)]
    for c in frames:
        c["kind"], c["why"] = "unsure", "holds other shapes"
    for c in cands:
        del c["_pts"], c["_centre"]
    return sorted(cands, key=lambda c: (round(c["box"][1] / 60.0), c["box"][0]))


def same_box(a, b):
    return all(abs(x - y) <= SAME_BOX_PT for x, y in zip(a, b))


def box_key(board_id, box):
    return hashlib.sha1((board_id + ":" + ",".join("%.1f" % v for v in box)).encode()).hexdigest()[:10]


# ───────────────────────── the record ─────────────────────────

def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _hours_since(iso, now=None):
    try:
        t = datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return float("inf")      # a square with no readable first sight is treated as long overdue
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return ((now or datetime.now(timezone.utc)) - t).total_seconds() / 3600.0


def load_state(path):
    """The record, or None when the file does not exist. Raises ActionsError when
    it exists and will not read: that is never a fresh start."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            st = json.load(f)
        if not isinstance(st, dict) or not isinstance(st.get("boxes"), dict) \
                or not all(isinstance(v, dict) for v in st["boxes"].values()):
            raise ValueError("not a boxes map")
        for boxes in st["boxes"].values():
            for e in boxes.values():
                if not isinstance(e, dict) or e.get("status") not in STATUSES \
                        or not isinstance(e.get("box"), list) or len(e["box"]) != 4:
                    raise ValueError("a box record is damaged")
        if not isinstance(st.get("blocked_boards", {}), dict):
            raise ValueError("blocked_boards is not a map")
        st.setdefault("blocked_boards", {})
    except (OSError, ValueError, TypeError) as e:
        raise ActionsError("the Freeform action-box record at %s will not read (%s). Restore it, "
                           "or run freeform_actions.py baseline --force to start again." % (path, e))
    return st


def _write_atomic(path, text):
    """Temp file named for this process, then rename: a rewrite in place is
    empty for an instant, and two writers never share a temp file."""
    tmp = "%s.%d.tmp" % (path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def save_state(path, st):
    _write_atomic(path, json.dumps(st, indent=2, sort_keys=True))


def update_state(path, change, read=True):
    """THE one way the record changes. Takes an exclusive lock on a sibling lock
    file, re-reads the record from disk (unless read=False), calls change(record
    or None) -> (record to save or None, answer), saves, and returns the answer."""
    with open(path + ".lock", "a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            st = load_state(path) if read else None
            new, answer = change(st)
            if new is not None:
                save_state(path, new)
            return answer
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def handoff_for(state_path):
    """The hand-off file that goes with a record: its sibling."""
    return os.path.join(os.path.dirname(os.path.abspath(state_path)), HANDOFF_NAME)


def ensure_handoff(path):
    """Create the hand-off file with its header. Never truncates one that exists."""
    if not os.path.exists(path):
        _write_atomic(path, HEADER + "\n")


def _handoff_lines(text):
    return [s.strip() for s in text.splitlines() if s.strip() and s.strip() != HEADER]


def parse_handoff(text):
    """(lines, malformed). Each line is {"board", "key", "words", "section", "raw"}.
    Board and key are split from the left and the section from the right, so
    words holding " :: " stay whole. The words are DATA, never instructions."""
    lines, bad = [], 0
    for s in _handoff_lines(text):
        if not s.startswith("- "):
            bad += 1
            continue
        parts = s[2:].split(" :: ", 2)
        if len(parts) < 3 or not parts[0].strip() or not parts[1].strip():
            bad += 1
            continue
        rest = parts[2].rsplit(" :: ", 1)
        lines.append({"board": parts[0].strip(), "key": parts[1].strip(), "words": rest[0],
                      "section": rest[1] if len(rest) > 1 else "", "raw": s})
    return lines, bad


def _clear(words):
    w = " ".join((words or "").split())
    return bool(w) and w.lower() != "[unclear]"


# ───────────────────────── for the bridge ─────────────────────────

def board_actions(board, board_id, board_name, state_path, pictures=None, shapes=None, now=None):
    """What the bridge's export needs for one decoded board.

    pictures None: read only. pictures {key: file name}: also, under the lock,
    records every never-seen square as pending (first seen now), refreshes the
    picture of each square already pending, marks a pending square no longer on
    the board as gone, heals a blocked board (every square on it becomes
    history), and makes sure the hand-off file exists.

    Returns {"not_read": None or a plain reason, "error": True when that reason
    is a fault, "healed": True for a blocked board that reads now,
    "awaiting": [{"key", "box", "new"}], "unsure": [shape...], "squares",
    "ovals", "empty", "raised", "history", "refused", "dismissed": counts,
    "shapes": the shapes found}."""
    out = {"not_read": None, "error": False, "healed": False, "awaiting": [], "unsure": [],
           "squares": 0, "ovals": 0, "empty": 0, "raised": 0, "history": 0, "refused": 0,
           "dismissed": 0, "shapes": []}
    st = load_state(state_path)
    if st is None:
        out.update(not_read="the action-box record is missing (%s), so no square on this board was "
                            "looked at" % state_path, error=True)
        return out
    shapes = find_shapes(board) if shapes is None else shapes
    out["shapes"] = shapes
    healed = board_id in st["blocked_boards"]
    out["healed"] = healed
    recorded = st["boxes"].get(board_id, {})
    used = set()
    for s in shapes:
        if s["kind"] == "oval":
            out["ovals"] += 1
        elif s["kind"] == "empty":
            out["empty"] += 1
        elif s["kind"] == "unsure":
            out["unsure"].append(s)
        if s["kind"] != "square":
            continue
        out["squares"] += 1
        if healed:
            out["history"] += 1
            continue
        best = None
        for k, e in recorded.items():
            if k not in used and same_box(e["box"], s["box"]):
                d = sum(abs(a - b) for a, b in zip(e["box"], s["box"]))
                if best is None or d < best[0]:
                    best = (d, k)
        if best is None:
            key = box_key(board_id, s["box"])
            while key in recorded:
                key = hashlib.sha1(key.encode()).hexdigest()[:10]
            used.add(key)
            out["awaiting"].append({"key": key, "box": list(s["box"]), "new": True})
            continue
        key = best[1]
        used.add(key)
        status = recorded[key]["status"]
        if status in ("pending", "gone"):
            out["awaiting"].append({"key": key, "box": list(s["box"]), "new": False})
        elif status in out:
            out[status] += 1
    if pictures is None:
        return out
    stamp = now or now_iso()

    def change(fresh):
        if fresh is None:
            raise ActionsError("the action-box record went missing while a board was filed")
        boxes = fresh["boxes"].setdefault(board_id, {})
        if healed:
            for s in shapes:
                if s["kind"] == "square" and not any(same_box(e["box"], s["box"]) for e in boxes.values()):
                    key = box_key(board_id, s["box"])
                    while key in boxes:
                        key = hashlib.sha1(key.encode()).hexdigest()[:10]
                    boxes[key] = {"box": list(s["box"]), "status": "history", "first_seen": stamp,
                                  "picture": "", "board_name": board_name}
            fresh["blocked_boards"].pop(board_id, None)
        for a in out["awaiting"]:
            e = boxes.get(a["key"])
            if e is None:
                boxes[a["key"]] = {"box": a["box"], "status": "pending", "first_seen": stamp,
                                   "picture": pictures.get(a["key"], ""), "board_name": board_name}
                continue
            if e["status"] == "gone":
                e["status"], e["first_seen"] = "pending", stamp
                e.pop("gone_at", None)
            e.update(box=a["box"], picture=pictures.get(a["key"], e.get("picture", "")),
                     board_name=board_name)
        if not healed:
            for k, e in boxes.items():
                if e["status"] == "pending" and k not in used:
                    e["status"], e["gone_at"] = "gone", stamp
        if not boxes:
            fresh["boxes"].pop(board_id, None)
        return fresh, None
    update_state(state_path, change)
    ensure_handoff(handoff_for(state_path))
    return out


def _mark_gone(state_path, keep, now=None):
    """Pending squares on boards `keep(board id)` says are gone become gone. Returns the count."""
    stamp = now or now_iso()

    def change(st):
        if st is None:
            return None, 0
        n = 0
        for bid, boxes in st["boxes"].items():
            if keep(bid):
                continue
            for e in boxes.values():
                if e["status"] == "pending":
                    e["status"], e["gone_at"] = "gone", stamp
                    n += 1
        return (st if n else None), n
    return update_state(state_path, change)


def forget_boards(state_path, live_ids, now=None):
    """Pending squares on boards that are no longer live (deleted) become gone."""
    live = set(live_ids)
    return _mark_gone(state_path, lambda bid: bid in live, now)


def clear_board(state_path, board_id, now=None):
    """Pending squares on a board that now shows nothing become gone."""
    return _mark_gone(state_path, lambda bid: bid != board_id, now)


def has_waiting(state_path, board_id, now=None):
    """True while the oldest square waiting on this board is over WAIT_HOURS and
    at most REFILE_MAX_HOURS old: the board is then worth filing again."""
    st = load_state(state_path)
    if st is None:
        return False
    ages = [_hours_since(e.get("first_seen"), now) for e in st["boxes"].get(board_id, {}).values()
            if e["status"] == "pending"]
    return bool(ages) and WAIT_HOURS < max(ages) <= REFILE_MAX_HOURS


# ───────────────────────── commands ─────────────────────────

def _bridge():
    spec = importlib.util.spec_from_file_location("freeform_bridge_for_actions", BRIDGE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _bridge_state(path):
    if not os.path.exists(path):
        raise ActionsError("there is no Freeform bridge state at %s, so which boards were filed "
                           "cannot be told" % path)
    try:
        with open(path, encoding="utf-8") as f:
            bs = json.load(f)
        if not isinstance(bs.get("boards"), dict):
            raise ValueError("not a boards map")
    except (OSError, ValueError, TypeError, AttributeError) as e:
        raise ActionsError("the Freeform bridge state at %s will not read (%s)" % (path, e))
    return bs["boards"]


def cmd_baseline(args):
    exists = "an action-box record already exists at %s. A second baseline would turn waiting " \
             "squares into history. Pass --force to mean it." % args.state
    if os.path.exists(args.state) and not args.force:
        raise ActionsError(exists)
    filed_map = _bridge_state(args.bridge_state)
    fb = _bridge()
    con = fb.connect(args.db)
    assets = os.path.join(os.path.dirname(args.db), "Assets")
    st = {"version": 1, "baseline_at": now_iso(), "boxes": {}, "blocked_boards": {}}
    old = filed = history = 0
    for b in fb.list_boards(con):
        known = filed_map.get(b["id"])
        if known is None or known.get("filed_at"):
            filed += 1
            continue
        old += 1
        try:
            shapes = find_shapes(fb.read_board(con, b["id"], assets))
        except Exception as e:      # said in the record and the count line
            st["blocked_boards"][b["id"]] = "would not decode (%s)" % type(e).__name__
            continue
        for s in shapes:
            if s["kind"] == "square":
                key = box_key(b["id"], s["box"])
                st["boxes"].setdefault(b["id"], {})[key] = {
                    "box": list(s["box"]), "status": "history", "first_seen": st["baseline_at"],
                    "picture": "", "board_name": b["name"]}
                history += 1

    def change(_):
        if os.path.exists(args.state) and not args.force:
            raise ActionsError(exists)      # made while the boards were being read
        return st, None
    update_state(args.state, change, read=False)
    ensure_handoff(args.handoff)
    print("Baseline: %d old board(s) read, %d square(s) recorded as history, %d board(s) that would "
          "not decode blocked, %d filed or new board(s) left for their next export."
          % (old, history, len(st["blocked_boards"]), filed))
    return 0


def cmd_shapes(args):
    filed_map = _bridge_state(args.bridge_state)
    fb = _bridge()
    con = fb.connect(args.db)
    assets = os.path.join(os.path.dirname(args.db), "Assets")
    bad = 0
    for b in fb.list_boards(con):
        if not (filed_map.get(b["id"]) or {}).get("filed_at"):
            continue
        try:
            shapes = find_shapes(fb.read_board(con, b["id"], assets))
        except Exception as e:      # said on the line, and the exit code
            bad += 1
            print("%s  could not be read (%s)" % (b["id"][:8], type(e).__name__))
            continue
        n = {k: sum(1 for s in shapes if s["kind"] == k) for k in ("square", "oval", "unsure", "empty")}
        print("%s  %d square(s), %d oval(s), %d unsure, %d empty"
              % (b["id"][:8], n["square"], n["oval"], n["unsure"], n["empty"]))
    return 1 if bad else 0


def cmd_status(args):
    st = load_state(args.state)
    if st is None:
        raise ActionsError("there is no action-box record at %s. Run baseline once first." % args.state)
    counts = {k: 0 for k in STATUSES}
    oldest = None
    for boxes in st["boxes"].values():
        for e in boxes.values():
            counts[e["status"]] += 1
            if e["status"] == "pending":
                h = _hours_since(e.get("first_seen"))
                oldest = h if oldest is None else max(oldest, h)
    print("Freeform squares: " + ", ".join("%d %s" % (counts[k], k) for k in STATUSES) +
          ", %d blocked board(s)." % len(st["blocked_boards"]))
    print("Oldest waiting square: " + ("none waiting." if oldest is None else "%.1f hour(s)." % oldest))
    return 0


def cmd_dismiss(args):
    if not (args.board and args.key and (args.why or "").strip()):
        raise ActionsError("dismiss needs --board, --key and --why")

    def change(st):
        if st is None:
            raise ActionsError("there is no action-box record at %s" % args.state)
        e = st["boxes"].get(args.board, {}).get(args.key)
        if e is None or e["status"] != "pending":
            raise ActionsError("that square is not waiting for a task (%s), so it was not dismissed"
                               % ("not in the record" if e is None else e["status"]))
        e.update(status="dismissed", dismissed_at=now_iso(), dismissed_why=args.why.strip())
        return st, None
    update_state(args.state, change)
    print("Dismissed 1 Freeform square. It will not be raised.")
    return 0


def norm(name):
    return " ".join(str(name or "").split()).lower()


def task_name(words, key):
    if not _clear(words):
        return "Freeform action box %s (handwriting unclear)" % key
    return " ".join(words.split())[:NAME_MAX].rstrip()


def task_fields(board_id, key, entry, words, section):
    section = " ".join((section or "").split()) or "none shown"
    desc = "\n".join([
        'From your Freeform board "%s". A square box is an action (your rule, 27 Nov 2026).'
        % entry.get("board_name", ""),
        "Section: %s." % section,
        'The words were read by machine from your handwriting. Picture: "%s" in the brain '
        "(_Inbox/_processed)." % entry.get("picture", ""),
        "Freeform box: %s/%s" % (board_id, key)])
    return {"fldgFjGBw6bTKJFCD": task_name(words, key),       # Task Name
            "fldx4qCw17UfrKpaN": "Today",                      # Status (a new agent-owned task)
            "fld7XP8w8kbxfETV4": date.today().isoformat(),     # Due Date
            "fldRGhBQViKZKtkQ6": desc}                          # Description


def _gate_json(stdout):
    for line in reversed((stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None


def call_gate(gate, fields, flag):
    """(exit code or None, the gate's JSON answer or None, plain reason). `flag`
    is --dry-run (reads only) or --force (creates, and can never fold)."""
    try:
        r = subprocess.run([sys.executable, gate, "create", "--owner", OWNER, flag,
                            "--fields-json", json.dumps(fields)],
                           capture_output=True, text=True, encoding="utf-8", timeout=GATE_TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, None, "the task gate took longer than %d seconds" % GATE_TIMEOUT
    except OSError as e:
        return None, None, "the task gate would not start (%s)" % type(e).__name__
    return r.returncode, _gate_json(r.stdout), ""


def raise_one(gate, fields):
    """One square through the gate. Returns (outcome, task id, twin id, reason);
    outcome is created | adopted | refused | failed."""
    code, out, why = call_gate(gate, fields, "--dry-run")
    if code is None:
        return "failed", "", "", why
    action = (out or {}).get("action")
    if code == 3 or action == "refused":
        return "refused", "", "", "the task gate refused it (exit %d)" % code
    if code == 2 or out is None:
        return "failed", "", "", "the task gate could not run (exit %d)" % code
    twin = ""
    if action == "updated" and out.get("taskId"):
        if norm(out.get("matchedName")) == norm(fields["fldgFjGBw6bTKJFCD"]):
            return "adopted", out["taskId"], "", ""
        twin = out["taskId"]
        fields = dict(fields)
        fields["fldRGhBQViKZKtkQ6"] += ("\nPOSSIBLE TWIN: the task gate matched this to %s. Not folded "
                                        "in: a square is always its own task." % twin)
    elif action != "created":
        return "failed", "", "", "the task gate's dry run gave no answer it could use (exit %d)" % code
    code, out, why = call_gate(gate, fields, "--force")
    if code is None:
        return "failed", "", twin, why
    action = (out or {}).get("action")
    if action == "refused" or code == 3:
        return "refused", "", twin, "the task gate refused it (exit %d)" % code
    if code in (0, 4) and action == "created" and (out or {}).get("taskId"):
        return "created", out["taskId"], twin, ("" if code == 0 else "created, but a field did not stick")
    return "failed", "", twin, "the task gate gave exit %d and no record id" % code


def cmd_raise(args):
    if load_state(args.state) is None:
        print("ERROR: there is no Freeform action-box record at %s. Run baseline once first. "
              "Nothing was raised." % args.state)
        return 1
    text = ""
    if os.path.exists(args.handoff):
        with open(args.handoff, encoding="utf-8") as f:
            text = f.read()
    seen_raw = set(_handoff_lines(text))
    lines, malformed = parse_handoff(text)
    # One line per box: the first whose words were read, else the first.
    chosen, order, dupes = {}, [], 0
    for ln in lines:
        ident = (ln["board"], ln["key"])
        if ident not in chosen:
            chosen[ident] = ln
            order.append(ident)
        else:
            dupes += 1
            if not _clear(chosen[ident]["words"]) and _clear(ln["words"]):
                chosen[ident] = ln
    raised = adopted = twinned = refused = failed = already = not_ours = unknown = warned = changed = 0
    retry, ids, twins = [], [], []
    for ident in order:
        ln = chosen[ident]
        st = load_state(args.state)          # a fresh read: never held across a gate call
        entry = (st or {"boxes": {}})["boxes"].get(ln["board"], {}).get(ln["key"])
        if entry is None:
            unknown += 1                     # invented, planted or mistyped: nothing is created
            continue
        if entry["status"] in NOT_OURS:
            not_ours += 1
            continue
        if entry["status"] == "raised":
            already += 1
            continue
        outcome, rec, twin, why = raise_one(args.gate, task_fields(ln["board"], ln["key"], entry,
                                                                   ln["words"], ln["section"]))
        if outcome == "failed":
            failed += 1
            retry.append(ln["raw"])
            print("ERROR: a Freeform square could not be raised: %s. It stays waiting and its line "
                  "is kept for the next run." % why)
            continue
        stamp = now_iso()

        def change(fresh, ln=ln, outcome=outcome, rec=rec, twin=twin):
            e = (fresh or {"boxes": {}})["boxes"].get(ln["board"], {}).get(ln["key"])
            if e is None or e["status"] != "pending":
                return None, False
            if outcome == "refused":
                e.update(status="refused", refused_at=stamp, words=ln["words"])
            else:
                e.update(status="raised", task=rec, raised_at=stamp, words=ln["words"],
                         gate_action="adopted" if outcome == "adopted" else "created")
                if twin:
                    e["twin"] = twin
            return fresh, True
        if not update_state(args.state, change):
            changed += 1
        if outcome == "refused":
            refused += 1
            continue
        raised += 1
        ids.append(rec)
        adopted += outcome == "adopted"
        if twin:
            twinned += 1
            twins.append((rec, twin))
        if why:
            warned += 1
    # The hand-off file: header, the lines being retried, and any line appended
    # while this run worked (never seen by it).
    if os.path.exists(args.handoff) or retry:
        now_text = ""
        if os.path.exists(args.handoff):
            with open(args.handoff, encoding="utf-8") as f:
                now_text = f.read()
        late_lines = [s for s in _handoff_lines(now_text) if s not in seen_raw]
        _write_atomic(args.handoff, HEADER + "\n" + "".join(r + "\n" for r in retry + late_lines))
    st = load_state(args.state) or {"boxes": {}}
    pend = [e for boxes in st["boxes"].values() for e in boxes.values() if e["status"] == "pending"]
    late = sum(1 for e in pend if _hours_since(e.get("first_seen")) > WAIT_HOURS)
    print("Freeform squares: %d raised (%d matched an open task with the same words, %d created beside "
          "a possible twin), %d waiting, %d refused, %d lines not understood."
          % (raised, adopted, twinned, len(pend), refused, malformed))
    if ids:
        print("Records: " + ", ".join(ids))
    for new, old in twins:
        print("WARNING: possible twin: %s was created beside %s." % (new, old))
    if already:
        print("%d line(s) were for squares that already have a task, and were ignored." % already)
    if dupes:
        print("%d line(s) repeated a square already listed: one line per square was used." % dupes)
    if not_ours:
        print("WARNING: %d line(s) named a square that is not waiting for a task (recorded before the "
              "baseline, refused, dismissed or no longer on the board). Nothing was created for them."
              % not_ours)
    if malformed:
        print("WARNING: %d line(s) in the hand-off file were not understood." % malformed)
    if warned:
        print("WARNING: %d task(s) were created but a field did not stick." % warned)
    if changed:
        print("WARNING: %d square(s) changed in the record while being raised; the record was left "
              "as the other writer set it." % changed)
    if unknown:
        print("ERROR: %d line(s) named a square that is not in the record at all. Nothing was created "
              "for them." % unknown)
    if refused:
        print("ERROR: the task gate refused %d Freeform square(s). Each is marked refused." % refused)
    if late:
        print("ERROR: %d Freeform square(s) have waited over %d hours with no task. The 23:00 pass "
              "has not read them." % (late, int(WAIT_HOURS)))
    return 1 if failed or refused or late or unknown else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Freeform action boxes: a pen-drawn square becomes a task.")
    ap.add_argument("command", choices=["baseline", "shapes", "status", "raise", "dismiss"])
    ap.add_argument("--state", default=STATE)
    ap.add_argument("--handoff", default=None, help="default: freeform-actions.md beside the record")
    ap.add_argument("--bridge-state", default=BRIDGE_STATE)
    ap.add_argument("--db", default=DB)
    ap.add_argument("--gate", default=GATE)
    ap.add_argument("--force", action="store_true", help="with baseline: replace an existing record")
    ap.add_argument("--board", help="with dismiss: the board id")
    ap.add_argument("--key", help="with dismiss: the box key")
    ap.add_argument("--why", help="with dismiss: why the square is not an action")
    args = ap.parse_args(argv)
    if args.handoff is None:
        args.handoff = handoff_for(args.state)
    try:
        return {"baseline": cmd_baseline, "shapes": cmd_shapes, "status": cmd_status,
                "raise": cmd_raise, "dismiss": cmd_dismiss}[args.command](args)
    except ActionsError as e:
        print("ERROR: %s" % e)
    except OSError as e:
        print("ERROR: a file could not be read or written (%s: %s)." % (type(e).__name__, e.strerror or e))
    except Exception as e:      # the bridge's own errors (BridgeError, sqlite3.Error) land here
        print("ERROR: %s: %s" % (type(e).__name__, e))
    return 1


if __name__ == "__main__":
    sys.exit(main())
