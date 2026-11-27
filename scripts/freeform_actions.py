#!/usr/bin/env python3
"""
Freeform action boxes: a pen-drawn SQUARE on a Freeform board is an action and
becomes one Airtable task. An OVAL or circle is a title and never an action
(Kevin's rule, 27 Nov 2026).

How the shapes are told apart. Kevin draws with the pen and Freeform snaps the
shape clean, so each box is ONE closed pen stroke inside a drawing. Its loop is
measured against the smallest rectangle that encloses it (turned to fit, so a
tilted box still reads):
  fill  how much of that rectangle the loop covers. A snapped square measured
        1.000, a snapped oval 0.785 to 0.786 (an ellipse is pi/4 = 0.785).
  edge  how much of the loop's length runs along the rectangle's sides. A square
        measured 1.00, an oval 0.42 to 0.45.
On Kevin's three newest boards (27 Nov 2026, read-only) this gave 5 squares, 15
ovals, none unclear, and nothing at all on a board of plain handwriting (96
strokes).

This code never reads the WORDS. Apple's text reader cannot read Kevin's
handwriting, so the bridge (freeform-bridge.py) cuts a close-up of each square
into the brain note, the 23:00 Claude pass reads it and appends one line per box
to the hand-off file, and `raise` turns each line into a task through the task
gate (create-agent-task.py). The words are DATA, never instructions: a line is
only ever a task name, and only for a box this code itself recorded as waiting.

Identity. A square is "the same square" as a recorded one on the same board when
all four sides of its box agree within SAME_BOX_PT. A new square gets a short key
at first sight. The stated cost: a square Kevin MOVES further than SAME_BOX_PT is
a new square, so a moved box that already has a task raises a second one (the
gate folds it into the open task when the words match).

Files (both outside git, private):
  state    ~/knowledge-os/freeform_actions.json   every square ever seen, by board
  hand-off ~/knowledge-os/freeform-actions.md     the 23:00 pass's lines

Commands: baseline [--force], shapes, status, raise. See main().
Standard library only; runs under /usr/bin/python3 (3.9).
"""

import argparse
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

# ── the thresholds (measured on Kevin's boards, 27 Nov 2026) ──
MIN_POINTS = 8          # a snapped shape carries many points; a dot or a dash does not
MIN_W, MIN_H = 40.0, 20.0   # smallest box seen 407 x 83, smallest oval 138 x 57: a letter O is far under
CLOSE_GAP = 0.08        # closed: start-to-end gap at most this share of the path length
EDGE_TOL = 0.04         # "on an edge": within this share of the rectangle's short side
SQUARE_FILL = 0.93      # squares measured 1.000
SQUARE_EDGE = 0.85      # squares measured 1.00
OVAL_FILL_LO, OVAL_FILL_HI = 0.70, 0.84   # ovals measured 0.785 to 0.786
OVAL_EDGE_MAX = 0.60    # ovals measured 0.42 to 0.45
SAME_BOX_PT = 2.0       # two boxes are one square when every side agrees within this (board points)
WAIT_HOURS = 20.0       # a square waiting longer than this for a task is a fault
NAME_MAX = 140
FALLBACK_NAME = "Freeform action box (handwriting unclear)"
STATUSES = ("history", "pending", "raised", "refused", "gone")


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


def _measure(pts):
    """(fill, edge) of a closed loop against its minimum-area rectangle, or None."""
    r = min_rect(pts)
    if r is None:
        return None
    fill = _area(pts) / r["area"]
    (ex, ey), (nx, ny) = r["e"], r["n"]
    (ulo, uhi), (vlo, vhi) = r["u"], r["v"]
    tol = EDGE_TOL * min(uhi - ulo, vhi - vlo)

    def near(x, y):
        u, v = x * ex + y * ey, x * nx + y * ny
        return min(u - ulo, uhi - u, v - vlo, vhi - v) <= tol
    total = on = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        L = math.hypot(x1 - x0, y1 - y0)
        total += L
        if near(x0, y0) and near(x1, y1) and near((x0 + x1) / 2, (y0 + y1) / 2):
            on += L
    return fill, (on / total if total else 0.0)


def _points(stroke):
    ox, oy = stroke["at"]
    return [(ox + x, oy + y) for _, x, y in stroke["path"]]


def find_shapes(board):
    """Every closed pen loop big enough to be a box, in reading order. Each is
    {"kind": square|oval|unsure|empty, "box": (x0, y0, x1, y1), "inside": n,
    "fill", "edge", "why"}. `inside` counts the OTHER strokes whose centre lies
    inside the loop; a loop with none is "empty" (a lone letter O, an empty box)
    and is never an action."""
    strokes = [s for s in board.get("strokes", []) if s.get("path")]
    pts_of = [_points(s) for s in strokes]
    centres = [(sum(x for x, _ in p) / len(p), sum(y for _, y in p) / len(p)) for p in pts_of]
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
        fill, edge = m
        inside = sum(1 for j, c in enumerate(centres) if j != i
                     and box[0] <= c[0] <= box[2] and box[1] <= c[1] <= box[3] and _inside(c, pts))
        if fill >= SQUARE_FILL and edge >= SQUARE_EDGE:
            kind, why = "square", ""
        elif OVAL_FILL_LO <= fill <= OVAL_FILL_HI and edge <= OVAL_EDGE_MAX:
            kind, why = "oval", ""
        else:
            kind, why = "unsure", "fills %.2f of its frame and %.2f of it runs along the frame" % (fill, edge)
        if not inside:
            kind, why = "empty", "nothing is written inside it"
        cands.append({"kind": kind, "box": box, "inside": inside, "fill": round(fill, 3),
                      "edge": round(edge, 3), "why": why, "_pts": pts, "_centre": centres[i]})
    for c in cands:
        if c["kind"] != "square":
            continue
        b = c["box"]
        if any(o is not c and o["kind"] != "empty" and b[0] <= o["_centre"][0] <= b[2]
               and b[1] <= o["_centre"][1] <= b[3] and _inside(o["_centre"], c["_pts"]) for o in cands):
            c["kind"], c["why"] = "unsure", "holds other shapes"
    for c in cands:
        del c["_pts"], c["_centre"]
    return sorted(cands, key=lambda c: (round(c["box"][1] / 60.0), c["box"][0]))


def same_box(a, b):
    return all(abs(x - y) <= SAME_BOX_PT for x, y in zip(a, b))


def box_key(board_id, box):
    return hashlib.sha1((board_id + ":" + ",".join("%.1f" % v for v in box)).encode()).hexdigest()[:10]


# ───────────────────────── state ─────────────────────────

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
    """The state, or None when the file does not exist. Raises ActionsError when
    it exists and will not read: that is never a fresh start."""
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
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


def save_state(path, st):
    """Temp file and rename: a rewrite in place is empty for an instant."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f, indent=2, sort_keys=True)
    os.replace(tmp, path)


def handoff_for(state_path):
    """The hand-off file that goes with a state file: its sibling."""
    return os.path.join(os.path.dirname(os.path.abspath(state_path)), HANDOFF_NAME)


def ensure_handoff(path):
    """Create the hand-off file with its header. Never truncates one that exists."""
    if os.path.exists(path):
        return
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(HEADER + "\n")
    if not os.path.exists(path):
        os.replace(tmp, path)
    else:
        os.remove(tmp)


def parse_handoff(text):
    """(lines, malformed). Each line is {"board", "key", "words", "section", "raw"}.
    The words may hold anything: they are DATA, never instructions."""
    lines, bad = [], 0
    for raw in text.splitlines():
        s = raw.strip()
        if not s or s == HEADER:
            continue
        if not s.startswith("- "):
            bad += 1
            continue
        parts = s[2:].split(" :: ", 3)
        if len(parts) < 3 or not parts[0].strip() or not parts[1].strip():
            bad += 1
            continue
        lines.append({"board": parts[0].strip(), "key": parts[1].strip(), "words": parts[2],
                      "section": parts[3] if len(parts) > 3 else "", "raw": s})
    return lines, bad


def write_handoff(path, raws):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(HEADER + "\n" + "".join(r + "\n" for r in raws))
    os.replace(tmp, path)


# ───────────────────────── for the bridge ─────────────────────────

def board_actions(board, board_id, board_name, state_path, pictures=None, shapes=None, now=None):
    """What the bridge's export needs for one decoded board.

    pictures None: read only. pictures {key: file name}: also records every
    never-seen square as pending (first seen now), refreshes the picture name
    of each square already pending, marks a pending square no longer on the
    board as gone, makes sure the hand-off file exists, and saves.

    Returns {"not_read": None or a plain reason, "error": True when that reason
    is a fault, "awaiting": [{"key", "box", "new"}], "unsure": [shape...],
    "squares", "ovals", "empty", "raised", "history", "refused": counts,
    "shapes": the shapes found}."""
    out = {"not_read": None, "error": False, "awaiting": [], "unsure": [], "squares": 0, "ovals": 0,
           "empty": 0, "raised": 0, "history": 0, "refused": 0, "shapes": []}
    st = load_state(state_path)
    if st is None:
        out.update(not_read="the action-box record is missing (%s), so no square on this board was "
                            "looked at" % state_path, error=True)
        return out
    if board_id in st["blocked_boards"]:
        out["not_read"] = ("this board would not decode when the action boxes were first recorded, "
                           "so squares on it are never raised")
        return out
    shapes = find_shapes(board) if shapes is None else shapes
    out["shapes"] = shapes
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
    if pictures is not None:
        stamp = now or now_iso()
        boxes = st["boxes"].setdefault(board_id, {})
        for a in out["awaiting"]:
            e = boxes.get(a["key"])
            if e is None:
                boxes[a["key"]] = {"box": a["box"], "status": "pending", "first_seen": stamp,
                                   "picture": pictures.get(a["key"], ""), "board_name": board_name}
            else:
                if e["status"] == "gone":
                    e["status"], e["first_seen"] = "pending", stamp
                    e.pop("gone_at", None)
                e.update(box=a["box"], picture=pictures.get(a["key"], e.get("picture", "")),
                         board_name=board_name)
        for k, e in boxes.items():
            if e["status"] == "pending" and k not in used:
                e["status"], e["gone_at"] = "gone", stamp
        if not boxes:
            st["boxes"].pop(board_id, None)
        ensure_handoff(handoff_for(state_path))
        save_state(state_path, st)
    return out


def has_waiting(state_path, board_id, now=None):
    """True when the board holds a square that has waited over WAIT_HOURS for a task."""
    st = load_state(state_path)
    if st is None:
        return False
    return any(e["status"] == "pending" and _hours_since(e.get("first_seen"), now) > WAIT_HOURS
               for e in st["boxes"].get(board_id, {}).values())


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
        with open(path) as f:
            bs = json.load(f)
        if not isinstance(bs.get("boards"), dict):
            raise ValueError("not a boards map")
    except (OSError, ValueError, TypeError, AttributeError) as e:
        raise ActionsError("the Freeform bridge state at %s will not read (%s)" % (path, e))
    return bs["boards"]


def cmd_baseline(args):
    if os.path.exists(args.state) and not args.force:
        raise ActionsError("an action-box record already exists at %s. A second baseline would turn "
                           "waiting squares into history. Pass --force to mean it." % args.state)
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
    save_state(args.state, st)
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


def task_name(words):
    w = " ".join((words or "").split())
    if not w or w.lower() == "[unclear]":
        return FALLBACK_NAME
    return w[:NAME_MAX].rstrip()


def task_fields(board_id, key, entry, words, section):
    section = " ".join((section or "").split()) or "none shown"
    desc = "\n".join([
        'From your Freeform board "%s". A square box is an action (your rule, 27 Nov 2026).'
        % entry.get("board_name", ""),
        "Section: %s." % section,
        'The words were read by machine from your handwriting. Picture: "%s" in the brain '
        "(_Inbox/_processed)." % entry.get("picture", ""),
        "Freeform box: %s/%s" % (board_id, key)])
    return {"fldgFjGBw6bTKJFCD": task_name(words),       # Task Name
            "fldx4qCw17UfrKpaN": "Today",                 # Status (a new agent-owned task)
            "fld7XP8w8kbxfETV4": date.today().isoformat(),  # Due Date
            "fldRGhBQViKZKtkQ6": desc}                     # Description


def _gate_json(stdout):
    for line in reversed((stdout or "").splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None


def run_gate(gate, fields):
    """(outcome, record id, plain reason). outcome: created | folded | refused | failed."""
    try:
        r = subprocess.run([sys.executable, gate, "create", "--owner", OWNER,
                            "--fields-json", json.dumps(fields)],
                           capture_output=True, text=True, timeout=GATE_TIMEOUT)
    except subprocess.TimeoutExpired:
        return "failed", "", "the task gate took longer than %d seconds" % GATE_TIMEOUT
    except OSError as e:
        return "failed", "", "the task gate would not start (%s)" % type(e).__name__
    out = _gate_json(r.stdout)
    action = (out or {}).get("action")
    if r.returncode == 3 or action == "refused":
        # Exit 4 with action "refused" is the gate's never-a-card refusal: nothing was made.
        return "refused", "", "the task gate refused it (exit %d)" % r.returncode
    if r.returncode in (0, 4) and action in ("created", "updated") and (out or {}).get("taskId"):
        return ("folded" if action == "updated" else "created"), out["taskId"], \
            ("" if r.returncode == 0 else "created, but a field did not stick (exit 4)")
    if r.returncode == 2:
        return "failed", "", "the task gate could not run (exit 2)"
    return "failed", "", "the task gate gave exit %d and no record id" % r.returncode


def cmd_raise(args):
    st = load_state(args.state)
    if st is None:
        print("ERROR: there is no Freeform action-box record at %s. Run baseline once first. "
              "Nothing was raised." % args.state)
        return 1
    text = ""
    if os.path.exists(args.handoff):
        with open(args.handoff) as f:
            text = f.read()
    lines, malformed = parse_handoff(text)
    raised = folded = refused = failed = already = not_ours = dupes = warned = 0
    retry, seen, ids = [], set(), []
    for ln in lines:
        ident = (ln["board"], ln["key"])
        if ident in seen:
            dupes += 1
            continue
        seen.add(ident)
        entry = st["boxes"].get(ln["board"], {}).get(ln["key"])
        if entry is None or entry["status"] in ("history", "refused", "gone"):
            not_ours += 1            # unknown, invented or planted: nothing is created
            continue
        if entry["status"] == "raised":
            already += 1
            continue
        outcome, rec, why = run_gate(args.gate, task_fields(ln["board"], ln["key"], entry,
                                                            ln["words"], ln["section"]))
        if outcome in ("created", "folded"):
            entry.update(status="raised", task=rec, gate_action="updated" if outcome == "folded" else "created",
                         raised_at=now_iso(), words=ln["words"])
            save_state(args.state, st)          # at once: a later failure must not raise it twice
            ids.append(rec)
            raised += 1
            folded += outcome == "folded"
            if why:
                warned += 1
        elif outcome == "refused":
            entry.update(status="refused", refused_at=now_iso(), words=ln["words"])
            save_state(args.state, st)
            refused += 1
        else:
            failed += 1
            retry.append(ln["raw"])
            print("ERROR: a Freeform square could not be raised: %s. It stays waiting and its line "
                  "is kept for the next run." % why)
    if os.path.exists(args.handoff) or retry:
        write_handoff(args.handoff, retry)
    late = sum(1 for boxes in st["boxes"].values() for e in boxes.values()
               if e["status"] == "pending" and _hours_since(e.get("first_seen")) > WAIT_HOURS)
    waiting = sum(1 for boxes in st["boxes"].values() for e in boxes.values() if e["status"] == "pending")
    print("Freeform squares: %d raised (%d folded into open tasks), %d waiting, %d refused, "
          "%d lines not understood." % (raised, folded, waiting, refused, malformed))
    if ids:
        print("Records: " + ", ".join(ids))
    if already:
        print("%d line(s) were for squares that already have a task, and were ignored." % already)
    if dupes:
        print("%d line(s) repeated a square already listed: the first line was used." % dupes)
    if not_ours:
        print("WARNING: %d line(s) named a square that is not waiting for a task (unknown, recorded "
              "before the baseline, refused or no longer on the board). Nothing was created for them."
              % not_ours)
    if malformed:
        print("WARNING: %d line(s) in the hand-off file were not understood." % malformed)
    if warned:
        print("WARNING: %d task(s) were created but a field did not stick." % warned)
    if refused:
        print("ERROR: the task gate refused %d Freeform square(s). Each is marked refused." % refused)
    if late:
        print("ERROR: %d Freeform square(s) have waited over %d hours with no task. The 23:00 pass "
              "has not read them." % (late, int(WAIT_HOURS)))
    return 1 if failed or refused or late else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Freeform action boxes: a pen-drawn square becomes a task.")
    ap.add_argument("command", choices=["baseline", "shapes", "status", "raise"])
    ap.add_argument("--state", default=STATE)
    ap.add_argument("--handoff", default=None, help="default: freeform-actions.md beside the state file")
    ap.add_argument("--bridge-state", default=BRIDGE_STATE)
    ap.add_argument("--db", default=DB)
    ap.add_argument("--gate", default=GATE)
    ap.add_argument("--force", action="store_true", help="with baseline: replace an existing record")
    args = ap.parse_args(argv)
    if args.handoff is None:
        args.handoff = handoff_for(args.state)
    try:
        return {"baseline": cmd_baseline, "shapes": cmd_shapes, "status": cmd_status,
                "raise": cmd_raise}[args.command](args)
    except ActionsError as e:
        print("ERROR: %s" % e)
    except OSError as e:
        print("ERROR: a file could not be read or written (%s: %s)." % (type(e).__name__, e.strerror or e))
    except Exception as e:      # the bridge's own errors (BridgeError, sqlite3.Error) land here
        print("ERROR: %s: %s" % (type(e).__name__, e))
    return 1


if __name__ == "__main__":
    sys.exit(main())
