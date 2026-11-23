"""Builds a small, made-up Freeform database for tests/freeform-bridge.test.js.

Nothing here is Kevin's: every board, title, word and stroke is invented. The
records are encoded the way Freeform's real ones were read on 22 Nov 2026 (the
shapes are described in scripts/freeform-bridge.py), so the bridge's decoder runs
against the same structure it meets in production.

A board spec is a dict:
    {"id": 32 hex chars, "name": str, "tombstoned": 0/1, "changed": apple seconds,
     "stickies": [{"text": str, "at": (x, y), "rgb": (r, g, b)}],
     "boxes":    [{"text": str, "at": (x, y), "size": (w, h), "fill": rgb|None, "edge": rgb|None,
                   "angle": degrees, "auto_height": bool}],
                 # size (length, 0) with no text is a straight line; auto_height marks the
                 # height as not set, as Freeform does for a text box that sizes itself
     "strokes":  [{"at": (x, y), "pts": [(x, y), ...], "rgb": (r, g, b), "width": w}],
     "lines":    [(sticky index, sticky index)],
     "pictures": [{"at": (x, y), "size": (w, h), "name": str}]}   # see asset_path() for its file
"""
import os
import sqlite3
import struct
import uuid

HEADER = b"crdt\x06\x00\x00\x00"


def vi(n):
    out = b""
    while True:
        b7 = n & 0x7F
        n >>= 7
        out += bytes([b7 | (0x80 if n else 0)])
        if not n:
            return out


def fld(field, wire, payload):
    key = vi((field << 3) | wire)
    if wire == 2:
        return key + vi(len(payload)) + payload
    if wire == 0:
        return key + vi(payload)
    return key + payload


def v_int(n):
    return fld(5, 0, n)


def v_float(x):
    return fld(15, 5, struct.pack("<f", x))


def v_vec(x, y):
    return fld(4, 2, fld(1, 5, struct.pack("<f", x)) + fld(2, 5, struct.pack("<f", y)))


def v_key(n):
    return fld(6, 0, n)


def v_str(n):
    return fld(3, 0, n)


def v_struct(vals, present=None):
    inner = (fld(1, 2, bytes(present)) if present is not None else b"") + b"".join(fld(2, 2, v) for v in vals)
    return fld(14, 2, inner)


def members(pairs):
    """A struct value {4: {1: member numbers, 2: member, ...}}."""
    return fld(4, 2, fld(1, 2, bytes(n for n, _ in pairs)) + b"".join(fld(2, 2, m) for _, m in pairs))


def table(uuids, strings=()):
    return fld(6, 2, fld(1, 2, b"".join(bytes.fromhex(u) for u in uuids)) +
               b"".join(fld(2, 2, s.encode()) for s in strings))


def geometry(pos, size, angle=0.0, auto_height=False):
    return v_struct([v_vec(*pos), v_vec(*size), v_float(angle), v_int(2), v_int(0 if auto_height else 2),
                     v_int(0), v_int(0)])


def colour(rgb):
    return v_struct([v_int(0), v_float(rgb[0]), v_float(rgb[1]), v_float(rgb[2])])


def register(value):
    """An optional, set value: {1: {1: clock, 2: {9: {1: value}}}}."""
    return fld(1, 2, fld(1, 2, b"") + fld(2, 2, fld(9, 2, fld(1, 2, value))))


def unset():
    return fld(1, 2, fld(1, 2, b"") + fld(2, 2, fld(9, 2, b"")))


def text_value(text):
    return fld(5, 2, fld(1, 2, text.encode()) + fld(3, 2, fld(1, 2, fld(1, 0, 1)) + fld(4, 2, b"\x01")))


def common(self_id, parent_id, pos, size, angle=0.0, auto_height=False):
    uuids = [uuid.uuid4().hex.upper(), self_id, uuid.uuid4().hex.upper(), parent_id]
    obj = fld(4, 2, fld(2, 2, v_struct([v_key(3), geometry(pos, size, angle, auto_height)])))
    return HEADER + fld(1, 2, obj) + table(uuids, ["a", "b"])


def container_common(self_id):
    obj = fld(4, 2, fld(2, 2, v_struct([geometry((0, 0), (100, 100))], present=[1])))
    return HEADER + fld(1, 2, obj) + table([uuid.uuid4().hex.upper(), self_id], ["a", "b"])


def shape_specific(text, fill, edge, extra_uuids=()):
    look_parts = []
    look_parts.append((0, register(v_struct([v_int(0), v_struct([colour(fill)], present=[1])])) if fill else unset()))
    if edge is not None:
        look_parts.append((1, register(v_struct([v_int(0), v_struct([colour(edge)], present=[1]), v_float(1.0)]))))
    top = [(0, members([(0, members(look_parts))]))]
    if text is not None:
        top.append((2, members([(0, text_value(text))])))
    return HEADER + fld(1, 2, members(top)) + table(list(extra_uuids) or [uuid.uuid4().hex.upper()], ["a"])


def line_specific(end_a, end_b):
    uuids = [uuid.uuid4().hex.upper(), end_a, end_b]
    ends = b"".join(fld(2, 2, fld(1, 2, fld(1, 2, fld(1, 0, i)) + fld(2, 2, fld(9, 2, fld(1, 2, v_key(i))))))
                    for i in (1, 2))
    obj = fld(4, 2, fld(2, 2, v_struct([v_int(0), v_struct([colour((0, 0, 0))], present=[1]), v_float(1.0)])) + ends)
    return HEADER + fld(1, 2, obj) + table(uuids, ["simple arrow"])


def bucket(drawing_id, strokes):
    uuids = [uuid.uuid4().hex.upper(), drawing_id]
    objs = b""
    for s in strokes:
        xs, ys = [p[0] for p in s["pts"]], [p[1] for p in s["pts"]]
        path = b"".join(fld(1, 2, (fld(1, 0, 2) if i else b"") + fld(2, 2, struct.pack("<ff", x, y)))
                        for i, (x, y) in enumerate(s["pts"]))
        size = (max(xs) - min(xs), max(ys) - min(ys))
        shape = v_struct([v_struct([v_key(1), geometry(s["at"], size)]),
                          v_struct([v_int(0), v_struct([fld(4, 2, path), v_vec(*size)])])])
        style = v_struct([v_int(0), v_struct([colour(s.get("rgb", (0, 0, 0)))], present=[1]),
                          v_float(s.get("width", 1.0)), v_int(2), v_int(2), v_float(4.0)])
        objs += fld(4, 2, fld(4, 2, shape + fld(2, 2, style)))
    return HEADER + objs + table(uuids, ["a", "com.apple.ink.pen"])


SCHEMA = """
CREATE TABLE boards (board_identifier BLOB PRIMARY KEY NOT NULL, owner_name TEXT NOT NULL DEFAULT '',
  data BLOB, last_activity_time REAL, tombstoned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE board_items (item_uuid BLOB NOT NULL, parent_uuid BLOB, board_identifier BLOB NOT NULL,
  item_type INTEGER NOT NULL, common_data BLOB, specific_data BLOB, tombstoned INTEGER NOT NULL DEFAULT 0,
  sync_data BLOB, PRIMARY KEY (item_uuid, board_identifier));
CREATE TABLE freehand_drawing_buckets (board_indentifier BLOB NOT NULL, bucket_index INTEGER NOT NULL,
  bucket_data BLOB NOT NULL, sync_data BLOB, UNIQUE(board_indentifier, bucket_index));
CREATE TABLE assets (asset_uuid BLOB PRIMARY KEY NOT NULL, extension TEXT, tombstone_date REAL NOT NULL DEFAULT 0);
"""


def board_data(name):
    obj = fld(4, 2, fld(2, 2, fld(1, 2, fld(1, 2, fld(1, 0, 6)) + fld(2, 2, v_str(2)))))
    return HEADER + fld(1, 2, obj) + table([uuid.uuid4().hex.upper()], ["a", "b", name])


def put_board(con, spec):
    """Insert or replace one board and everything on it."""
    bid = bytes.fromhex(spec["id"])
    con.execute("delete from boards where board_identifier = ?", (bid,))
    con.execute("delete from board_items where board_identifier = ?", (bid,))
    con.execute("delete from freehand_drawing_buckets where board_indentifier = ?", (bid,))
    con.execute("insert into boards (board_identifier, data, last_activity_time, tombstoned) values (?,?,?,?)",
                (bid, board_data(spec["name"]), spec.get("changed", 700000000.0), spec.get("tombstoned", 0)))
    root = uuid.uuid5(uuid.NAMESPACE_OID, spec["id"] + "root").hex.upper()
    item = lambda uid, parent, kind, c, s: con.execute(
        "insert into board_items (item_uuid, parent_uuid, board_identifier, item_type, common_data, specific_data) "
        "values (?,?,?,?,?,?)", (bytes.fromhex(uid), bytes.fromhex(parent) if parent else None, bid, kind, c, s))
    item(root, None, 2, container_common(root), HEADER + fld(1, 2, fld(4, 2, b"")))
    sticky_ids = []
    for i, st in enumerate(spec.get("stickies", [])):
        uid = uuid.uuid5(uuid.NAMESPACE_OID, f"{spec['id']}sticky{i}").hex.upper()
        sticky_ids.append(uid)
        item(uid, root, 12, common(uid, root, st["at"], (200, 200)),
             shape_specific(st["text"], st.get("rgb", (1.0, 0.9, 0.4)), None))
    for i, bx in enumerate(spec.get("boxes", [])):
        uid = uuid.uuid5(uuid.NAMESPACE_OID, f"{spec['id']}box{i}").hex.upper()
        item(uid, root, 3, common(uid, root, bx["at"], bx.get("size", (0, 0)), bx.get("angle", 0.0),
                                  bx.get("auto_height", False)),
             shape_specific(bx.get("text"), bx.get("fill"), bx.get("edge")))
    for i, (a, b) in enumerate(spec.get("lines", [])):
        uid = uuid.uuid5(uuid.NAMESPACE_OID, f"{spec['id']}line{i}").hex.upper()
        item(uid, root, 4, common(uid, root, (0, 0), (10, 10)), line_specific(sticky_ids[a], sticky_ids[b]))
    if spec.get("strokes"):
        drawing = uuid.uuid5(uuid.NAMESPACE_OID, spec["id"] + "drawing").hex.upper()
        item(drawing, root, 10, common(drawing, root, spec.get("drawing_at", (50, 50)), (1, 1)),
             HEADER + fld(1, 2, fld(4, 2, b"")))
        con.execute("insert into freehand_drawing_buckets (board_indentifier, bucket_index, bucket_data) values (?,?,?)",
                    (bid, 0, bucket(drawing, spec["strokes"])))
    for i, pic in enumerate(spec.get("pictures", [])):
        uid = uuid.uuid5(uuid.NAMESPACE_OID, f"{spec['id']}pic{i}").hex.upper()
        asset = uuid.uuid5(uuid.NAMESPACE_OID, f"{spec['id']}asset{i}").hex.upper()
        con.execute("insert or replace into assets (asset_uuid, extension) values (?, ?)", (bytes.fromhex(asset), "png"))
        item(uid, root, 5, common(uid, root, pic["at"], pic["size"]),
             HEADER + fld(1, 2, fld(4, 2, fld(2, 2, fld(1, 2, pic.get("name", "photo.png").encode())))) +
             table([uuid.uuid4().hex.upper(), asset], ["a"]))
    for i, n in enumerate(spec.get("unknown_items", [])):
        uid = uuid.uuid5(uuid.NAMESPACE_OID, f"{spec['id']}odd{i}").hex.upper()
        item(uid, root, n, common(uid, root, (400, 400), (50, 50)), HEADER + fld(1, 2, fld(4, 2, b"")))
    con.commit()


def build(folder, specs):
    """A fresh database at <folder>/Boards/boards.db holding `specs`. Returns its path."""
    os.makedirs(os.path.join(folder, "Boards", "Assets"), exist_ok=True)
    path = os.path.join(folder, "Boards", "boards.db")
    if os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path)
    con.executescript(SCHEMA)
    for spec in specs:
        put_board(con, spec)
    con.close()
    return path


def zigzag(n=12, step=14.0, height=22.0):
    """A pen line that goes up and down n times, as a stand-in for a written word."""
    return [(i * step, 0.0 if i % 2 == 0 else height) for i in range(n)]


def sample(bid="A" * 32, name="Garden plan", note="Buy six fence posts"):
    return {"id": bid, "name": name,
            "stickies": [{"text": note, "at": (0, 0)}, {"text": "Ask the neighbour first", "at": (320, 0)}],
            "boxes": [{"text": "Things to do before spring", "at": (0, 260)}],
            "lines": [(0, 1)],
            "strokes": [{"at": (0, 320), "pts": zigzag(), "rgb": (0.0, 0.0, 0.8), "width": 1.5},
                        {"at": (220, 320), "pts": zigzag(8), "rgb": (0.0, 0.0, 0.0), "width": 1.0}]}


def asset_path(folder, board_id, index=0):
    """Where the bridge will look for picture `index` of a board built in `folder`."""
    u = uuid.uuid5(uuid.NAMESPACE_OID, f"{board_id}asset{index}").hex.upper()
    return os.path.join(folder, "Boards", "Assets", f"{u[:8]}-{u[8:12]}-{u[12:16]}-{u[16:20]}-{u[20:]}.png")
