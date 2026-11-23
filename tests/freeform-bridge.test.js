import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = resolve(ROOT, 'scripts/freeform-bridge.py');
const FIXTURES = resolve(ROOT, 'tests/fixtures');

// ─────────────────────────────────────────────────────────────────────────────
// 22 Nov 2026. scripts/freeform-bridge.py files Kevin's Freeform boards into the
// brain by reading Freeform's own iCloud-synced database, because Freeform has no
// export a robot can use and its menus cannot be driven with the screen locked.
//
// The bridge REDRAWS each board itself, so the dangerous failure is a picture that
// looks right and is wrong. Three controls must never regress:
//   1. a redrawn picture that does not match Freeform's own preview turns the run
//      red and the note says so in capitals;
//   2. a missing or unreadable state file is an error, never a silent fresh start
//      (that would either file every old board or swallow every new one);
//   3. zero boards, a missing database or a board that will not decode is an
//      error, not a quiet "0 filed".
//
// Every board in these tests is invented (tests/fixtures/freeform_fixture.py).
// This repo is public: none of Kevin's boards, titles or words belong in it.
// ─────────────────────────────────────────────────────────────────────────────

const dirs = [];
afterAll(() => dirs.forEach(d => rmSync(d, { recursive: true, force: true })));

// Runs a python body with a made-up Freeform folder and the bridge loaded as
// `fb`. The body calls bridge(...extra args) -> (exit code, stdout) and ends by
// setting `result`, which comes back parsed.
function py(body) {
  const dir = mkdtempSync(join(tmpdir(), 'freeform-bridge-'));
  dirs.push(dir);
  const code = `
import importlib.util, sys, os, json, io, contextlib, sqlite3, time, stat
sys.path.insert(0, ${JSON.stringify(FIXTURES)})
import freeform_fixture as fx
spec = importlib.util.spec_from_file_location("fb", ${JSON.stringify(BRIDGE)})
fb = importlib.util.module_from_spec(spec); spec.loader.exec_module(fb)
D = ${JSON.stringify(dir)}
STATE, INBOX, PREVIEWS = os.path.join(D, "state.json"), os.path.join(D, "inbox"), os.path.join(D, "previews")
os.makedirs(INBOX); os.makedirs(PREVIEWS)
OCR = os.path.join(D, "ocr")
def fake_ocr(ok=True):
    with open(OCR, "w") as f:
        f.write('#!/bin/sh\\nfor p in "$@"; do echo "=== $p"; echo "machine read words"; done\\n' if ok
                else '#!/bin/sh\\necho broken >&2\\nexit 2\\n')
    os.chmod(OCR, 0o755)
fake_ocr()
def db(specs):
    return fx.build(D, specs)
def bridge(*extra, database=None):
    argv = ["--db", database or os.path.join(D, "Boards", "boards.db"), "--state", STATE, "--inbox", INBOX,
            "--previews", PREVIEWS, "--ocr-bin", OCR, "--no-sync"] + list(extra)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = fb.main(argv)
    return code, buf.getvalue()
def inbox():
    return sorted(os.listdir(INBOX))
def note(name):
    return open(os.path.join(INBOX, name)).read()
def edit(spec):
    con = sqlite3.connect(os.path.join(D, "Boards", "boards.db")); fx.put_board(con, spec); con.close()
def preview_for(spec, wrong=False):
    """Save what Freeform's own preview of a board would look like: the bridge's
    drawing of it, shrunk. wrong=True saves a preview of a DIFFERENT board."""
    other = dict(spec, stickies=[{"text": "x", "at": (900, 900)}], boxes=[], lines=[],
                 strokes=[{"at": (0, 0), "pts": [(0, 0), (900, 0)], "width": 6.0}])
    scratch = os.path.join(D, "scratch"); os.makedirs(scratch, exist_ok=True)
    p = fx.build(scratch, [other if wrong else spec])
    con = fb.connect(p)
    im, _ = fb.render(fb.read_board(con, spec["id"], os.path.join(scratch, "Boards", "Assets")))
    # As Freeform saves them: no margin round the drawing, and a see-through layer.
    # A stand-in that kept our own margin hid a wrong verdict (review 4, finding 1).
    from PIL import Image, ImageChops
    im = im.crop(ImageChops.difference(im, Image.new("RGB", im.size, "white")).getbbox()).convert("RGBA")
    im.thumbnail((400, 400))
    b = spec["id"]
    im.save(os.path.join(PREVIEWS, f"board_{b[:8]}-{b[8:12]}-{b[12:16]}-{b[16:20]}-{b[20:]}#_large_2.0_light"), "PNG")
def judge(theirs, ours):
    """The verdict on the bridge's drawing of \`ours\` against a preview of \`theirs\`."""
    preview_for(theirs)
    v = os.path.join(D, "judge")
    p = fx.build(v, [ours]); con = fb.connect(p)
    im, _ = fb.render(fb.read_board(con, ours["id"], os.path.join(v, "Boards", "Assets")))
    return fb.preview_match(im, fb.find_preview(PREVIEWS, theirs["id"]))[0]
def scribble(rnd, n, x0, y0, w, h):
    return [{"at": (x0 + rnd.random() * w, y0 + rnd.random() * h), "pts": fx.zigzag(6, 9.0, 14.0), "width": 1.2}
            for _ in range(n)]
result = None
${body}
print("\\n@@RESULT@@" + json.dumps(result))
`;
  const out = execFileSync('/usr/bin/python3', ['-c', code], { encoding: 'utf8', timeout: 120000 });
  return JSON.parse(out.split('@@RESULT@@')[1]);
}

describe('freeform-bridge: what gets filed', () => {
  it('the baseline records every board and files none', () => {
    const r = py(`
db([fx.sample(), fx.sample("B" * 32, "Second board")])
code, out = bridge("--baseline")
state = json.load(open(STATE))
result = {"code": code, "out": out, "inbox": inbox(), "boards": len(state["boards"]),
          "filed": [b["filed_at"] for b in state["boards"].values()]}
`);
    expect(r.code).toBe(0);
    expect(r.inbox).toEqual([]);
    expect(r.boards).toBe(2);
    expect(r.filed).toEqual([null, null]);
    expect(r.out).toContain('2 existing board(s) recorded. None filed.');
  });

  it('a second baseline is refused, because it would hide every board changed since', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
edit(fx.sample(note="A new line"))
code, out = bridge("--baseline")
forced, _ = bridge("--baseline", "--force")
result = {"code": code, "out": out, "forced": forced}
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('already exists');
    expect(r.forced).toBe(0);
  });

  it('with no state file it refuses to run rather than file every old board as new', () => {
    const r = py(`
db([fx.sample()])
code, out = bridge()
result = {"code": code, "out": out, "inbox": inbox()}
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Run --baseline once');
    expect(r.inbox).toEqual([]);
  });

  it('files a changed board once, with its title, typed words, joins and board id', () => {
    const r = py(`
spec = fx.sample()
db([spec, fx.sample("B" * 32, "Untouched board")])
bridge("--baseline")
quiet, quiet_out = bridge()
edit(fx.sample(note="Buy eight fence posts"))
preview_for(fx.sample(note="Buy eight fence posts"))
code, out = bridge()
files = inbox()
again, again_out = bridge()
result = {"quiet": quiet, "quiet_out": quiet_out, "code": code, "out": out, "files": files,
          "note": note("Garden plan (Freeform board).md"), "again": again, "again_files": inbox()}
`);
    expect(r.quiet).toBe(0);
    expect(r.quiet_out).toContain('0 new or changed board(s) filed');
    expect(r.code).toBe(0);
    expect(r.out).toContain('1 new or changed board(s) filed');
    expect(r.files).toEqual([
      'Garden plan (Freeform board) - Freeform preview.png',
      'Garden plan (Freeform board) - handwriting 1.png',
      'Garden plan (Freeform board).md',
    ]);
    expect(r.note).toContain('# Garden plan (Freeform board)');
    expect(r.note).toContain('Freeform board id: ' + 'A'.repeat(32));
    expect(r.note).toContain('- Buy eight fence posts');
    expect(r.note).toContain('- Things to do before spring');
    expect(r.note).toContain('"Buy eight fence posts" is joined to "Ask the neighbour first"');
    expect(r.note).toContain('2 pen stroke(s) in 1 drawing(s)');
    expect(r.note).toContain("matches Freeform's own preview");
    expect(r.note).toContain('machine read words');
    expect(r.note).toContain('first time this board has been filed');
    // The untouched board never appears, and a second run files nothing more.
    expect(r.files.join()).not.toContain('Untouched');
    expect(r.again).toBe(0);
    expect(r.again_files).toEqual(r.files);
  });

  it('files a board made after the baseline, and marks a later change as an update', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
new = fx.sample("C" * 32, "Brand new board", note="First thought")
edit(new); preview_for(new)
first, _ = bridge()
first_note = note("Brand new board (Freeform board).md")
changed = fx.sample("C" * 32, "Brand new board", note="Second thought")
edit(changed); preview_for(changed)
second, _ = bridge()
result = {"first": first, "second": second, "first_note": first_note,
          "second_note": note("Brand new board (Freeform board) (2).md")}
`);
    expect(r.first).toBe(0);
    expect(r.second).toBe(0);
    expect(r.first_note).toContain('first time this board has been filed');
    expect(r.second_note).toContain('filed before and has changed');
    expect(r.second_note).toContain('do not make a second note');
    expect(r.second_note).toContain('- Second thought');
  });

  it('does not re-file a board when only sync bookkeeping changed', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
con = sqlite3.connect(os.path.join(D, "Boards", "boards.db"))
con.execute("update board_items set sync_data = x'DEADBEEF'")
con.execute("update freehand_drawing_buckets set sync_data = x'DEADBEEF'")
con.execute("update boards set last_activity_time = last_activity_time + 500")
con.commit(); con.close()
code, out = bridge()
result = {"code": code, "out": out, "inbox": inbox()}
`);
    expect(r.code).toBe(0);
    expect(r.inbox).toEqual([]);
  });

  it('ignores a deleted board and remembers an empty one without filing it', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
edit(dict(fx.sample("D" * 32, "Deleted board"), tombstoned=1))
edit({"id": "E" * 32, "name": "Untitled"})
code, out = bridge()
state = json.load(open(STATE))
result = {"code": code, "out": out, "inbox": inbox(), "empty": state["boards"].get("E" * 32),
          "deleted": "D" * 32 in state["boards"]}
`);
    expect(r.code).toBe(0);
    expect(r.inbox).toEqual([]);
    expect(r.deleted).toBe(false);
    expect(r.empty.filed_at).toBe(null);
  });

  it('says so in the note when a board holds a kind of item it cannot draw', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
odd = dict(fx.sample("F" * 32, "Odd board"), unknown_items=[8, 8])
edit(odd); preview_for(odd)
code, out = bridge()
result = {"code": code, "note": note("Odd board (Freeform board).md")}
`);
    expect(r.code).toBe(0);
    expect(r.note).toContain('2 item(s) of a kind this bridge cannot draw (Freeform type 8)');
    expect(r.note).toContain('NOT in the picture');
  });
});

describe('freeform-bridge: the picture is checked against Freeform\'s own preview', () => {
  it('a picture that does not match turns the run red and the note says so', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
spec = fx.sample(note="Changed")
edit(spec); preview_for(spec, wrong=True)
code, out = bridge()
state = json.load(open(STATE))
again, _ = bridge()
result = {"code": code, "out": out, "note": note("Garden plan (Freeform board).md"), "again": again,
          "filed": state["boards"]["A" * 32]["filed_at"] is not None}
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("do not match Freeform's own preview");
    expect(r.note).toContain("THE REDRAWN BOARD DOES NOT MATCH FREEFORM'S OWN PREVIEW");
    // Red once: the board is on file with its warning, so the next run is quiet.
    expect(r.filed).toBe(true);
    expect(r.again).toBe(0);
  });

  it('a drawing with its handwriting missing never passes, wherever the ink sits (review 3, finding 1)', () => {
    const r = py(`
import random
random.seed(7)
def scribble(n, x0, y0, w, h):
    out = []
    for i in range(n):
        x, y = x0 + random.random() * w, y0 + random.random() * h
        out.append({"at": (x, y), "pts": fx.zigzag(6, 9.0, 14.0), "width": 1.2})
    return out
def verdict(full, ours):
    preview_for(full)
    p = fx.build(os.path.join(D, "v"), [ours]); con = fb.connect(p)
    im, _ = fb.render(fb.read_board(con, ours["id"], os.path.join(D, "v", "Boards", "Assets")))
    return fb.preview_match(im, os.path.join(PREVIEWS, os.listdir(PREVIEWS)[0]))[0]
box = {"text": None, "at": (0, 0), "size": (600, 400), "fill": (0.2, 0.4, 0.8), "edge": None}
inside = {"id": "A" * 32, "name": "Box", "boxes": [box], "drawing_at": (0, 0), "strokes": scribble(30, 40, 40, 480, 300)}
ink = {"id": "A" * 32, "name": "Ink", "drawing_at": (0, 0), "strokes": scribble(60, 0, 0, 700, 400)}
half = dict(ink, strokes=[s for s in ink["strokes"] if s["at"][1] < 200] + [ink["strokes"][0]])
moved = dict(ink, strokes=[dict(s, at=(700 - s["at"][0], s["at"][1])) for s in ink["strokes"]])
result = {"same": verdict(inside, inside), "ink_gone_from_box": verdict(inside, dict(inside, strokes=inside["strokes"][:1])),
          "ink_same": verdict(ink, ink), "half_the_ink": verdict(ink, half), "ink_mirrored": verdict(ink, moved)}
`);
    expect(r.same).toBe('agrees');
    expect(r.ink_same).toBe('agrees');
    expect(r.ink_gone_from_box).not.toBe('agrees');
    expect(r.half_the_ink).toBe('differs');
    expect(r.ink_mirrored).not.toBe('agrees');
  });

  it('a board mostly covered by one colour is judged on its drawing, not its margin (review 4, finding 1)', () => {
    const r = py(`
import random
A = "A" * 32
one = {"id": A, "name": "One", "stickies": [{"text": "Call the roofer", "at": (0, 0)}]}
four = {"id": A, "name": "Four", "stickies": [{"text": t, "at": at} for t, at in
        (("North", (0, 0)), ("East", (200, 0)), ("South", (0, 200)), ("West", (200, 200)))]}
out = {"one_sticky": judge(one, one), "four_stickies": judge(four, four), "same": [], "half_gone": [], "dark": []}
for seed in range(6):
    rnd = random.Random(seed)
    for key, fill in (("same", (0.2, 0.4, 0.8)), ("dark", (0.15, 0.15, 0.15))):
        ink = scribble(rnd, 40, 30, 30, 500, 320)
        if key == "dark":
            ink = [dict(s, rgb=(1.0, 1.0, 1.0)) for s in ink]
        box = {"id": A, "name": "Box", "drawing_at": (0, 0), "strokes": ink,
               "boxes": [{"text": None, "at": (0, 0), "size": (600, 400), "fill": fill, "edge": None}]}
        half = dict(box, strokes=[s for s in ink if s["at"][1] < 190])
        if key == "same":
            out["same"].append(judge(box, box))
            out["half_gone"].append(judge(box, half))
        else:
            out["dark"].append([judge(box, box), judge(box, half)])
sticky_ink = dict(one, drawing_at=(0, 0), strokes=scribble(random.Random(9), 12, 10, 60, 120, 110))
out["sticky_with_ink"] = judge(sticky_ink, sticky_ink)
out["sticky_ink_gone"] = judge(sticky_ink, one)
result = out
`);
    expect(r.one_sticky).toBe('agrees');
    expect(r.four_stickies).toBe('agrees');
    expect(r.sticky_with_ink).toBe('agrees');
    expect(r.sticky_ink_gone).not.toBe('agrees');
    expect(r.same).toEqual(Array(6).fill('agrees'));
    expect(r.half_gone).not.toContain('agrees');
    // Pale ink on a dark fill: the fill must not read as solid black and swallow the ink.
    expect(r.dark.map(d => d[0])).toEqual(Array(6).fill('agrees'));
    expect(r.dark.map(d => d[1])).not.toContain('agrees');
  });

  it('a right drawing of an odd-shaped board is not called wrong: one straight line, a tall thin board (review 4, finding 2)', () => {
    const r = py(`
A = "A" * 32
line = {"id": A, "name": "Line", "drawing_at": (0, 0), "strokes": [{"at": (0, 0), "pts": [(0, 0), (600, 0)], "width": 2.0}]}
upright = {"id": A, "name": "Upright", "drawing_at": (0, 0), "strokes": [{"at": (0, 0), "pts": [(0, 0), (0, 600)], "width": 2.0}]}
tall = {"id": A, "name": "Tall", "drawing_at": (0, 0),
        "strokes": [{"at": (0, 0), "pts": [(0 if i % 2 else 8, i * 30.0) for i in range(60)], "width": 1.5}]}
squat = dict(tall, strokes=[dict(tall["strokes"][0], pts=tall["strokes"][0]["pts"][:8])])
result = {"line": judge(line, line), "tall": judge(tall, tall), "line_turned": judge(line, upright), "tall_cut_short": judge(tall, squat)}
`);
    expect(r.line).toBe('agrees');
    expect(r.tall).toBe('agrees');
    expect(r.line_turned).toBe('differs');
    expect(r.tall_cut_short).toBe('differs');
  });

  it('one whole sticky note missing from a busy board is not a clean match (review 5, finding 1)', () => {
    const r = py(`
A = "A" * 32
def grid(n, drop=None, extra=False):
    notes = [{"text": f"note {i}", "at": (300 * (i % n), 300 * (i // n))} for i in range(n * n) if i != drop]
    if extra:
        notes.append({"text": "one more", "at": (300 * n, 300 * (n // 2))})
    return {"id": A, "name": "Grid", "stickies": notes}
out = {"same": [judge(grid(n), grid(n)) for n in (4, 5, 6)], "one_missing": [], "one_too_many": judge(grid(4), grid(4, extra=True))}
for n, drop in ((4, 5), (4, 0), (5, 12), (5, 24), (6, 14), (6, 5)):
    out["one_missing"].append(judge(grid(n), grid(n, drop)))
result = out
`);
    expect(r.same).toEqual(['agrees', 'agrees', 'agrees']);
    expect(r.one_missing).not.toContain('agrees');
    expect(r.one_too_many).not.toBe('agrees');
  });

  it('a drawing that came out blank against a preview with something in it is a mismatch, not "not checked" (review 5, finding 2)', () => {
    const r = py(`
A = "A" * 32
box = lambda fill: {"id": A, "name": "Box", "boxes": [{"text": None, "at": (0, 0), "size": (300, 200), "fill": fill, "edge": None}]}
dark, pale = box((0.1, 0.1, 0.1)), box((1.0, 1.0, 0.6))     # the pale one is too near white to count as drawn
def both(theirs, ours):
    preview_for(theirs)
    pv = fb.find_preview(PREVIEWS, A)
    v = os.path.join(D, "v"); con = fb.connect(fx.build(v, [ours]))
    im, _ = fb.render(fb.read_board(con, A, os.path.join(v, "Boards", "Assets")))
    t = os.path.getmtime(pv)
    return [fb.preview_match(im, pv)[0], fb.check_picture(im, pv, t - 10)["kind"], fb.check_picture(im, pv, t + 10)["kind"]]
result = {"ours_blank": both(dark, pale), "theirs_blank": both(pale, dark), "both_blank": both(pale, pale)}
`);
    expect(r.ours_blank).toEqual(['differs', 'mismatch', 'unchecked']);
    expect(r.theirs_blank).toEqual(['differs', 'mismatch', 'unchecked']);
    expect(r.both_blank).toEqual([null, 'unchecked', 'unchecked']);
  });

  it('a straight line made with the line tool is drawn, turned the way Freeform turns it', () => {
    const r = py(`
import math
A = "A" * 32
def drawn(angle, edge=None):
    spec = {"id": A, "name": "Line", "boxes": [{"text": None, "at": (100, 100), "size": (200, 0), "fill": None, "edge": edge, "angle": angle}]}
    v = os.path.join(D, "v"); con = fb.connect(fx.build(v, [spec]))
    board = fb.read_board(con, A, os.path.join(v, "Boards", "Assets"))
    im, scale = fb.render(board)
    x0, y0, x1, y1 = fb.bounds(board)
    def ink(x, y):                                           # darkest pixel within 2 of a board point
        px, py = int((x - x0) * scale + fb.MARGIN), int((y - y0) * scale + fb.MARGIN)
        return min(sum(im.getpixel((min(max(px + i, 0), im.size[0] - 1), min(max(py + j, 0), im.size[1] - 1))))
                   for i in range(-2, 3) for j in range(-2, 3)) < 300
    up, across = 90 * math.sin(math.radians(30)), 90 * math.cos(math.radians(30))
    return {"content": fb.has_content(board), "size": [round(x1 - x0), round(y1 - y0)],
            "right_end_up": ink(200 + across, 100 - up), "left_end_down": ink(200 - across, 100 + up),
            "mirror": ink(200 + across, 100 + up), "level": ink(200 + 90, 100)}
result = {"turned": drawn(30.0), "flat": drawn(0.0), "coloured": drawn(30.0, edge=(0.8, 0.1, 0.1))}
`);
    // Turned 30 degrees anticlockwise about its middle: 200 long, so 173 across and 100 up.
    expect(r.turned).toEqual({ content: true, size: [173, 100], right_end_up: true, left_end_down: true, mirror: false, level: false });
    expect(r.flat).toMatchObject({ size: [200, 0], level: true, right_end_up: false });
    expect(r.coloured).toMatchObject({ right_end_up: true, mirror: false });
  });

  it('a whole sticky note missing from a tight cluster is caught wherever it sits on the grid (reviews 6 and 7)', () => {
    const r = py(`
A = "A" * 32
def board(gap, far, drop=None):
    notes = [{"text": f"note {i}", "at": (gap * (i % 3), gap * (i // 3))} for i in range(9) if i != drop]
    notes += [{"text": "far", "at": at} for at in ((far, 0), (0, far), (far, far), (far, far // 2), (far // 2, far))]
    return {"id": A, "name": "Cluster", "stickies": notes}
out = {"same": [], "one_gone": [], "one_added": []}
# The far notes set how big the board is, and so where the cluster falls on the
# grid. At 1300 a first fix missed the middle note; at 1400 it missed five of nine.
for far in (1200, 1300, 1400, 1600):
    for gap in (205, 230):
        out["same"].append(judge(board(gap, far), board(gap, far)))
        out["one_gone"] += [judge(board(gap, far), board(gap, far, d)) for d in range(9)]
        out["one_added"].append(judge(board(gap, far, 4), board(gap, far)))
result = out
`);
    expect(r.same).toEqual(Array(8).fill('agrees'));
    expect(r.one_gone).toHaveLength(72);
    expect(r.one_gone).not.toContain('agrees');
    expect(r.one_added).not.toContain('agrees');
  });

  it('a thin straight line that Freeform\'s preview does not hold never turns a right drawing red (review 6, finding 1)', () => {
    const r = py(`
from PIL import Image
A = "A" * 32
line = lambda at, length, angle=0.0: {"text": None, "at": at, "size": (length, 0), "fill": None, "edge": None, "angle": angle}
memo = {"id": A, "name": "Note", "stickies": [{"text": "Call the roofer", "at": (0, 0)}]}
divided = dict(memo, boxes=[line((0, 260), 600)])
framed = dict(memo, boxes=[line((-50, -50), 300), line((-50, 250), 300), line((-200, 100), 300, 90.0), line((100, 100), 300, 90.0)])
only = {"id": A, "name": "Lines", "boxes": [line((0, 0), 400), line((0, 80), 400)]}
def check(shown, board):
    """The check on the drawing of \`board\` when Freeform's preview shows \`shown\` (None: a blank preview)."""
    if shown is None:
        pv = os.path.join(PREVIEWS, f"board_{A[:8]}-{A[8:12]}-{A[12:16]}-{A[16:20]}-{A[20:]}#_large_2.0_light")
        Image.new("RGBA", (400, 300), (255, 255, 255, 0)).save(pv, "PNG")
    else:
        preview_for(shown)
        pv = fb.find_preview(PREVIEWS, A)
    v = os.path.join(D, "v"); con = fb.connect(fx.build(v, [board]))
    b = fb.read_board(con, A, os.path.join(v, "Boards", "Assets"))
    im, _ = fb.render(b)
    c = fb.check_picture(im, pv, os.path.getmtime(pv) - 10, lambda: fb.render(b, without_lines=True)[0])
    return [fb.preview_match(im, pv)[0], c["kind"], c["lines_left_out"]]
result = {"divider_not_shown": check(memo, divided), "frame_not_shown": check(memo, framed),
          "lines_only_blank_preview": check(None, only),
          "divider_shown": check(divided, divided),
          "note_gone_too": check(memo, dict(divided, stickies=[{"text": "x", "at": (900, 900)}]))}
# End to end: the run files the board, says the lines were left out of the check, and is not red.
db([fx.sample()]); bridge("--baseline")
edit(divided); preview_for(memo)
code, out = bridge()
text = next(note(f) for f in inbox() if f.endswith(".md"))
result["run"] = [code, "1 straight line(s)" in text, "left out of this check" in text, "DOES NOT MATCH" in text]
# A board of lines only, with a blank preview: the note must not say our picture is blank.
for f in inbox(): os.remove(os.path.join(INBOX, f))
edit(only)
Image.new("RGBA", (400, 300), (255, 255, 255, 0)).save(fb.find_preview(PREVIEWS, A), "PNG")
code, out = bridge()
text = next(note(f) for f in inbox() if f.endswith(".md"))
result["lines_only_run"] = [code, "2 straight line(s)" in text, "holds only straight lines" in text, "both pictures are blank" in text]
# With no preview to compare with, the second drawing is not made at all.
calls = []
bad = os.path.join(D, "not-a-picture"); open(bad, "w").write("x")
fb.check_picture(fb.render(fb.read_board(fb.connect(os.path.join(D, "Boards", "boards.db")), A, ""))[0], bad, 0, lambda: calls.append(1))
result["no_preview_no_second_drawing"] = calls
# A BIG board, end to end. Its second drawing must be the same weight as the first:
# drawn smaller, its pen strokes and borders came out heavier (nothing is drawn under
# a pixel wide) and right drawings went red (review 8).
import random
result["big"] = []
for seed in (0, 9):
    rnd = random.Random(seed); S = 6000
    st = [{"text": "note", "at": (rnd.randint(0, S), rnd.randint(0, S))} for _ in range(rnd.randint(1, 6))]
    bx = [{"text": None, "at": (rnd.randint(0, S), rnd.randint(0, S)), "size": (rnd.randint(200, 900), rnd.randint(200, 900)),
           "fill": None, "edge": (0, 0, 0)} for _ in range(rnd.randint(1, 5))]
    sk = [{"at": (rnd.randint(0, S), rnd.randint(0, S)), "pts": fx.zigzag(rnd.randint(4, 30), 14.0, 22.0), "width": rnd.choice([0.8, 1.0, 1.5])}
          for _ in range(rnd.randint(10, 40))]
    base = {"id": A, "name": "Big", "drawing_at": (0, 0), "stickies": st, "boxes": bx, "strokes": sk}
    lined = dict(base, boxes=bx + [line((0, rnd.randint(0, S)), S), line((rnd.randint(0, S), 0), S, 90.0)])
    for f in inbox(): os.remove(os.path.join(INBOX, f))
    edit(lined); preview_for(base)
    code, out = bridge()
    text = next(note(f) for f in inbox() if f.endswith(".md"))
    result["big"].append([code, "matches Freeform's own preview" in text, "left out of this check" in text])
`);
    // The full drawing, lines and all, plainly differs from a preview without them...
    expect(r.divider_not_shown).toEqual(['differs', 'match', true]);
    expect(r.frame_not_shown).toEqual(['differs', 'match', true]);
    // ...and a board of lines only, against a blank preview, is "not checked", not a mismatch.
    expect(r.lines_only_blank_preview).toEqual(['differs', 'unchecked', true]);
    // A preview that does show the line is matched on the full drawing: no second look.
    expect(r.divider_shown).toEqual(['agrees', 'match', false]);
    // The second look forgives the lines and nothing else.
    expect(r.note_gone_too[1]).toBe('mismatch');
    expect(r.run).toEqual([0, true, true, false]);
    expect(r.lines_only_run).toEqual([0, true, true, false]);
    expect(r.no_preview_no_second_drawing).toEqual([]);
    expect(r.big).toEqual([[0, true, true], [0, true, true]]);
  });

  it('a text box left empty or holding only spaces is not drawn as a line (review 6, finding 3)', () => {
    const r = py(`
A = "A" * 32
def is_line(box):
    spec = {"id": A, "name": "B", "stickies": [{"text": "x", "at": (0, 300)}], "boxes": [dict({"at": (0, 0), "fill": None, "edge": None}, **box)]}
    v = os.path.join(D, "v"); con = fb.connect(fx.build(v, [spec]))
    it = next(i for i in fb.read_board(con, A, os.path.join(v, "Boards", "Assets"))["items"] if i["type"] == fb.T_TEXT)
    return bool(it.get("line"))
result = {"line": is_line({"text": None, "size": (300, 0)}),
          "upright_line": is_line({"text": None, "size": (0, 300)}),
          "emptied_text_box": is_line({"text": None, "size": (300, 0), "auto_height": True}),
          "box_of_spaces": is_line({"text": "   ", "size": (300, 0)}),
          "box_of_spaces_auto": is_line({"text": "   ", "size": (300, 0), "auto_height": True}),
          "text_box": is_line({"text": "hello", "size": (300, 0), "auto_height": True})}
`);
    expect(r).toEqual({ line: true, upright_line: true, emptied_text_box: false, box_of_spaces: false,
                        box_of_spaces_auto: false, text_box: false });
  });

  it('a see-through preview is read on white, and a dark-mode preview is not used at all', () => {
    const r = py(`
from PIL import Image
spec = fx.sample()
preview_for(spec)
light = fb.find_preview(PREVIEWS, spec["id"])
im = Image.open(light).convert("RGB")
clear = Image.new("RGBA", im.size, (0, 0, 0, 0))            # clear pixels are BLACK underneath
clear.paste(im, mask=im.convert("L").point(lambda v: 0 if v > 250 else 255))
clear.save(light, "PNG")
p = db([spec]); con = fb.connect(p)
ours, _ = fb.render(fb.read_board(con, spec["id"], os.path.join(D, "Boards", "Assets")))
seen = fb.preview_match(ours, light)[0]
os.rename(light, light.replace("_light", "_dark"))
result = {"see_through": seen, "dark_only": fb.find_preview(PREVIEWS, spec["id"])}
`);
    expect(r.see_through).toBe('agrees');
    expect(r.dark_only).toBe(null);
  });

  it('a shape\'s border is drawn one board point wide, so it survives being shrunk to preview size', () => {
    const r = py(`
spec = {"id": "A" * 32, "name": "Framed", "boxes": [{"text": None, "at": (0, 0), "size": (300, 200), "fill": None, "edge": (0.0, 0.0, 0.0)}]}
p = db([spec]); con = fb.connect(p)
im, scale = fb.render(fb.read_board(con, spec["id"], os.path.join(D, "Boards", "Assets")))
row = [im.getpixel((fb.MARGIN + 100, y))[0] for y in range(fb.MARGIN - 4, fb.MARGIN + 12)]
result = {"scale": scale, "border_rows": sum(1 for v in row if v < 128)}
`);
    expect(r.scale).toBe(2);
    expect(r.border_rows).toBe(2);
  });

  it('agreement is never thrown away for timing; timing only sorts a plain disagreement', () => {
    const r = py(`
spec = fx.sample()
p = db([spec]); con = fb.connect(p)
im, _ = fb.render(fb.read_board(con, spec["id"], os.path.join(D, "Boards", "Assets")))
preview_for(spec)
good = os.path.join(PREVIEWS, os.listdir(PREVIEWS)[0])
t = os.path.getmtime(good)
pick = lambda c: [c["kind"], c["fresh"], c["preview"] is not None]
out = {"agrees_after": pick(fb.check_picture(im, good, t - 10)), "agrees_before": pick(fb.check_picture(im, good, t + 10))}
preview_for(spec, wrong=True)
t = os.path.getmtime(good)
out["differs_after"] = pick(fb.check_picture(im, good, t - 10))
out["differs_before"] = pick(fb.check_picture(im, good, t + 10))
out["none"] = pick(fb.check_picture(im, None, 0))
result = out
`);
    expect(r).toEqual({ agrees_after: ['match', true, true], agrees_before: ['match', false, true],
                        differs_after: ['mismatch', true, true], differs_before: ['unchecked', false, false],
                        none: ['unchecked', false, false] });
  });

  it('with no preview, or a wrong one drawn before the change, the note says NOT CHECKED', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
edit(fx.sample(note="Changed"))
none_code, none_out = bridge()
none_note = note("Garden plan (Freeform board).md")
spec2 = fx.sample(note="Changed again")
edit(spec2); preview_for(spec2, wrong=True)   # a preview from BEFORE the last run must not cry wolf
for f in os.listdir(PREVIEWS):
    os.utime(os.path.join(PREVIEWS, f), (time.time() - 86400, time.time() - 86400))
stale_code, stale_out = bridge()
result = {"none_code": none_code, "none_out": none_out, "none_note": none_note, "stale_code": stale_code,
          "stale_note": note("Garden plan (Freeform board) (2).md"), "files": inbox()}
`);
    expect(r.none_code).toBe(0);
    expect(r.none_out).toContain('WARNING: 1 filed board(s) had no preview drawn since the change');
    expect(r.none_note).toContain('Picture check: NOT CHECKED');
    expect(r.stale_code).toBe(0);
    expect(r.stale_note).toContain('has not redrawn its preview since this board changed');
    expect(r.files.join()).not.toContain('(2) - Freeform preview');
  });

  it('an old preview that still agrees is filed as speaking for the layout only', () => {
    const r = py(`
db([fx.sample()])
preview_for(fx.sample())                       # drawn before the baseline: shows the old board
time.sleep(1.1)
bridge("--baseline")
edit(fx.sample(note="Buy seven fence posts"))  # one word differs: too small to see at preview size
code, out = bridge()
result = {"code": code, "out": out, "note": note("Garden plan (Freeform board).md"), "files": inbox()}
`);
    expect(r.code).toBe(0);
    expect(r.note).toContain('Freeform drew that preview before this change reached the Mac');
    expect(r.note).toContain('not for the newest marks');
    expect(r.out).toContain('WARNING: 1 filed board(s) had no preview drawn since the change');
    expect(r.files).toContain('Garden plan (Freeform board) - Freeform preview.png');
  });

  it('each board is judged on when ITS data arrived, and one not seen arriving trusts no preview', () => {
    const r = py(`
a, b = fx.sample("A" * 32, "Board A"), fx.sample("B" * 32, "Board B")
db([a, b])
bridge("--baseline")
a2, b2 = fx.sample("A" * 32, "Board A", note="A changed"), fx.sample("B" * 32, "Board B", note="B changed")
edit(a2); edit(b2); preview_for(a2); preview_for(b2)
drawn = max(os.path.getmtime(os.path.join(PREVIEWS, f)) for f in os.listdir(PREVIEWS))
# A's data arrived before the previews were drawn; B's arrived 30 s after them.
fake = {"waited": 100, "arrivals": {"A" * 32: drawn - 20, "B" * 32: drawn + 30}, "ended": drawn + 80, "opened": True}
fb.sync = lambda db: fake
argv = ["--db", os.path.join(D, "Boards", "boards.db"), "--state", STATE, "--inbox", INBOX,
        "--previews", PREVIEWS, "--ocr-bin", OCR]
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = fb.main(argv)
c2 = fx.sample("C" * 32, "Board C"); edit(c2); preview_for(c2)
fake["arrivals"] = {}                           # C changed, and no arrival was seen for it
buf2 = io.StringIO()
with contextlib.redirect_stdout(buf2):
    fb.main(argv)
old = "before this change reached the Mac"
result = {"code": code, "out": buf.getvalue(), "a_old": old in note("Board A (Freeform board).md"),
          "b_old": old in note("Board B (Freeform board).md"), "c_old": old in note("Board C (Freeform board).md")}
`);
    expect(r.code).toBe(0);
    expect(r.out).toContain('New board data arrived from iCloud');
    expect(r.a_old).toBe(false);     // drawn after A arrived: a fresh check
    expect(r.b_old).toBe(true);      // drawn before B arrived: layout only
    expect(r.c_old).toBe(true);      // arrival never seen: no preview is trusted as fresh
  });

  it('three filings in a row with no fresh check turn the run red, once per filing night, and a fresh check heals it', () => {
    const r = py(`
db([fx.sample()])
preview_for(fx.sample())
for f in os.listdir(PREVIEWS):
    os.utime(os.path.join(PREVIEWS, f), (time.time() - 86400, time.time() - 86400))
bridge("--baseline")
codes = []
for i in range(3):                             # an OLD preview that still agrees is not a fresh check
    edit(fx.sample(note="Change %d" % i))
    codes.append(bridge()[0])
idle, idle_out = bridge()                      # nothing filed tonight: not red again
streak = json.load(open(STATE))["unchecked_streak"]
spec = fx.sample(note="Checked at last"); edit(spec); preview_for(spec)
healed, _ = bridge()
result = {"codes": codes, "idle": idle, "idle_out": idle_out, "streak": streak, "healed": healed,
          "after": json.load(open(STATE))["unchecked_streak"]}
`);
    expect(r.codes).toEqual([0, 0, 1]);
    expect(r.idle).toBe(0);
    expect(r.idle_out).not.toContain('ERROR');
    expect(r.streak).toBe(3);
    expect(r.healed).toBe(0);
    expect(r.after).toBe(0);
  });

  it('a text box with a border and no fill is not painted solid (the 22 Nov 2026 black box)', () => {
    const r = py(`
frame = {"id": "A" * 32, "name": "Framed",
         "boxes": [{"text": None, "at": (0, 0), "size": (300, 200), "fill": None, "edge": (0, 0, 0)},
                   {"text": None, "at": (400, 0), "size": (300, 200), "fill": (0, 0, 0), "edge": None}],
         "strokes": [{"at": (0, 0), "pts": fx.zigzag(6), "width": 1.0}]}
p = db([frame])
con = fb.connect(p)
board = fb.read_board(con, "A" * 32, os.path.join(D, "Boards", "Assets"))
im, scale = fb.render(board)
x0 = min(it["at"][0] for it in board["items"] if it["type"] == 3)
inside = lambda bx: im.getpixel((int((bx - x0 + 150) * scale) + fb.MARGIN, int(150 * scale) + fb.MARGIN))
result = {"outlined": inside(0), "filled": inside(400),
          "looks": [[it["rgb"], it["edge"]] for it in board["items"] if it["type"] == 3]}
`);
    expect(r.outlined).toEqual([255, 255, 255]);
    expect(r.filled).toEqual([0, 0, 0]);
    expect(r.looks).toEqual([[null, [0, 0, 0]], [[0, 0, 0], null]]);
  });
});

describe('freeform-bridge: failure is loud', () => {
  it('zero boards is a fault, not an empty week', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
con = sqlite3.connect(os.path.join(D, "Boards", "boards.db")); con.execute("delete from boards"); con.commit(); con.close()
code, out = bridge()
result = {"code": code, "out": out}
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('holds no boards at all');
  });

  it('a missing database is an error', () => {
    const r = py(`
code, out = bridge(database=os.path.join(D, "nowhere", "boards.db"))
result = {"code": code, "out": out}
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Freeform's database is not at");
  });

  it('an unreadable state file stops the run and is left as it was', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
open(STATE, "w").write("{ not json")
edit(fx.sample(note="Changed"))
code, out = bridge()
result = {"code": code, "out": out, "inbox": inbox(), "state": open(STATE).read()}
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('will not read');
    expect(r.inbox).toEqual([]);
    expect(r.state).toBe('{ not json');
  });

  it('a failed handwriting read leaves nothing in the inbox and retries the board next run', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
spec = fx.sample(note="Changed")
edit(spec); preview_for(spec)
fake_ocr(ok=False)
code, out = bridge()
left = inbox()
fake_ocr(ok=True)
retry, retry_out = bridge()
result = {"code": code, "out": out, "left": left, "retry": retry, "after": inbox()}
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('could not file a Freeform board: the text reader failed');
    expect(r.out).toContain('1 board(s) could not be filed');
    expect(r.left).toEqual([]);
    expect(r.retry).toBe(0);
    expect(r.after).toContain('Garden plan (Freeform board).md');
  });

  it('a pen stroke that will not read is counted in the note and turns the run red', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
spec = fx.sample(note="Changed")
edit(spec); preview_for(spec)
real = fb._strokes_in
calls = [0]
def loses_second(ev, uuids):                             # the decoder reads the first stroke only
    calls[0] += 1
    return real(ev, uuids) if calls[0] == 1 else []
fb._strokes_in = loses_second
code, out = bridge()
result = {"code": code, "out": out, "note": note("Garden plan (Freeform board).md")}
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('hold pen strokes the bridge could not read');
    expect(r.note).toContain('1 PEN STROKE(S) COULD NOT BE READ');
  });

  it('a missing inbox stops the run: no look-alike folder, nothing recorded (review finding 1)', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
edit(fx.sample(note="Changed"))
before = json.load(open(STATE))["boards"]["A" * 32]["fingerprint"]
os.rmdir(INBOX)
code, out = bridge()
result = {"code": code, "out": out, "made": os.path.exists(INBOX),
          "same": json.load(open(STATE))["boards"]["A" * 32]["fingerprint"] == before}
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('the brain inbox is not there');
    expect(r.made).toBe(false);
    expect(r.same).toBe(true);
  });

  it('ink whose drawing is missing is counted as lost; ink Kevin deleted is not (review finding 2)', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
spec = fx.sample(note="Changed")
edit(spec); preview_for(spec)
path = os.path.join(D, "Boards", "boards.db")
con = sqlite3.connect(path); con.execute("delete from board_items where item_type = 10"); con.commit(); con.close()
missing, missing_out = bridge()
missing_note = note("Garden plan (Freeform board).md")
edit(fx.sample(note="Changed once more"))
con = sqlite3.connect(path); con.execute("update board_items set tombstoned = 1 where item_type = 10"); con.commit(); con.close()
deleted, deleted_out = bridge()
result = {"missing": missing, "missing_out": missing_out, "missing_note": missing_note, "deleted": deleted,
          "deleted_note": note("Garden plan (Freeform board) (2).md")}
`);
    expect(r.missing).toBe(1);
    expect(r.missing_out).toContain('hold pen strokes the bridge could not read');
    expect(r.missing_note).toContain('2 PEN STROKE(S) COULD NOT BE READ');
    expect(r.deleted_note).not.toContain('COULD NOT BE READ');
    expect(r.deleted_note).toContain('0 pen stroke(s)');
  });

  it('a board holding only an erased drawing is an empty board, not a nightly failure (review finding 3)', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
erased = {"id": "E" * 32, "name": "Erased", "strokes": [{"at": (0, 0), "pts": fx.zigzag(4)}]}
edit(erased)
con = sqlite3.connect(os.path.join(D, "Boards", "boards.db"))
con.execute("delete from freehand_drawing_buckets where board_indentifier = ?", (bytes.fromhex("E" * 32),))
con.commit(); con.close()
one, _ = bridge()
two, _ = bridge()
result = {"one": one, "two": two, "inbox": inbox()}
`);
    expect(r.one).toBe(0);
    expect(r.two).toBe(0);
    expect(r.inbox).toEqual([]);
  });

  it('a board that was filed and is then cleared gets a note saying so (review finding 7)', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
spec = fx.sample(note="Changed")
edit(spec); preview_for(spec)
bridge()
edit({"id": "A" * 32, "name": "Garden plan"})
code, out = bridge()
again, _ = bridge()
result = {"code": code, "out": out, "note": note("Garden plan (Freeform board) (2).md"), "again": again,
          "count": len(inbox())}
`);
    expect(r.code).toBe(0);
    expect(r.note).toContain('NOTHING is on the board now. Either Kevin cleared it, or its ink has not reached this Mac yet');
    expect(r.note).toContain('Keep everything in the brain note');
    expect(r.note).toContain('Freeform board id: ' + 'A'.repeat(32));
    expect(r.again).toBe(0);
    expect(r.count).toBe(4);
  });

  it('a record nested absurdly deep is a decode failure for that board, never a crash (review finding 5)', () => {
    const r = py(`
deep = b""
for _ in range(1500):
    deep = fx.fld(2, 2, deep or b"\\x08\\x01")
db([fx.sample(), fx.sample("B" * 32, "Good board")])
bridge("--baseline")
good = fx.sample("B" * 32, "Good board", note="Changed")
edit(good); preview_for(good)
con = sqlite3.connect(os.path.join(D, "Boards", "boards.db"))
con.execute("update boards set data = ? where board_identifier = ?", (fx.HEADER + fx.fld(1, 2, deep), bytes.fromhex("A" * 32)))
con.execute("update board_items set specific_data = ? where board_identifier = ? and item_type = 12",
            (fx.HEADER + fx.fld(1, 2, deep), bytes.fromhex("A" * 32)))
con.commit(); con.close()
listed, list_out = bridge("--list")
code, out = bridge()
result = {"listed": listed, "list_out": list_out, "code": code, "out": out, "inbox": inbox()}
`);
    expect(r.listed).toBe(0);
    expect(r.list_out).toContain('Untitled');
    expect(r.code).toBe(1);
    expect(r.out).toContain('would not decode');
    expect(r.out).not.toContain('Traceback');
    expect(r.inbox).toContain('Good board (Freeform board).md');
  });

  it('a title with a line break in it stays one heading (review finding 8)', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
odd = fx.sample("C" * 32, "Plan\\n# not a heading")
edit(odd); preview_for(odd)
code, out = bridge()
name = [f for f in inbox() if f.endswith(".md")][0]
result = {"code": code, "name": name, "first": note(name).split("\\n")[0]}
`);
    expect(r.code).toBe(0);
    expect(r.first).toBe('# Plan # not a heading (Freeform board)');
    expect(r.name).toBe('Plan _ not a heading (Freeform board).md');
  });

  it('no inked part of a huge board is dropped when it is cut up (review finding 4)', () => {
    const r = py(`
from PIL import Image
im = Image.new("RGB", (9000, 9000), "black")
parts = fb.tiles(im)
small = fb.tiles(Image.new("RGB", (2000, 1200), "black"))
blank = fb.tiles(Image.new("RGB", (9000, 9000), "white"))
result = {"parts": len(parts), "cap": fb.MAX_TILES, "small": len(small), "blank": len(blank),
          "labels": len(set(l for l, _ in parts))}
`);
    expect(r.parts).toBe(36);
    expect(r.parts).toBeLessThanOrEqual(r.cap);
    expect(r.labels).toBe(36);
    expect(r.small).toBe(0);
    expect(r.blank).toBe(0);
  });

  it('a board with only unplaceable ink is filed once with a warning, then goes quiet (review 2, finding 5)', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
ink = {"id": "D" * 32, "name": "Ink only", "strokes": [{"at": (0, 0), "pts": fx.zigzag(5)}]}
edit(ink)
con = sqlite3.connect(os.path.join(D, "Boards", "boards.db"))
con.execute("delete from board_items where item_type = 10 and board_identifier = ?", (bytes.fromhex("D" * 32),))
con.commit(); con.close()
codes = [bridge()[0], bridge()[0], bridge()[0]]
result = {"codes": codes, "note": note("Ink only (Freeform board).md"), "files": inbox()}
`);
    expect(r.codes).toEqual([1, 0, 0]);
    expect(r.note).toContain('1 PEN STROKE(S) COULD NOT BE READ and nothing else is on the board');
    expect(r.files).toEqual(['Ink only (Freeform board).md']);
  });

  it('a picture that is missing or too big to decode is drawn as a box and the note says so (review 2, findings 3 and 10)', () => {
    const r = py(`
from PIL import Image
db([fx.sample()])
bridge("--baseline")
spec = dict(fx.sample("C" * 32, "With photo"), pictures=[{"at": (600, 0), "size": (200, 150)}])
edit(spec)
missing_code, _ = bridge()
missing_note = note("With photo (Freeform board).md")
Image.new("RGB", (400, 300), (200, 30, 30)).save(fx.asset_path(D, "C" * 32))
spec = dict(spec, name="With photo two"); edit(spec)
bridge()
drawn_note = note("With photo two (Freeform board).md")
fb.PICTURE_PIXELS = 1000                       # the same file, now over the size limit
spec = dict(spec, name="With photo three"); edit(spec)
bridge()
result = {"missing_code": missing_code, "missing": missing_note, "drawn": drawn_note,
          "too_big": note("With photo three (Freeform board).md")}
`);
    expect(r.missing_code).toBe(0);
    expect(r.missing).toContain('1 picture(s) on the board could not be drawn');
    expect(r.drawn).not.toContain('could not be drawn');
    expect(r.too_big).toContain('1 picture(s) on the board could not be drawn');
  });

  it('numbers that are not numbers: a bad colour is dropped, a bad pen point fails that board (review 2, finding 6)', () => {
    const r = py(`
nan = float("nan")
db([fx.sample()])
bridge("--baseline")
spec = fx.sample(note="Changed")
spec["stickies"][0]["rgb"] = (nan, 0.5, 0.5)
edit(spec); preview_for(fx.sample(note="Changed"))
colour_code, colour_out = bridge()
spec = fx.sample("B" * 32, "Bad ink"); spec["strokes"][0]["pts"][3] = (nan, 1.0)
edit(spec)
ink_code, ink_out = bridge()
result = {"colour_code": colour_code, "colour_out": colour_out, "ink_code": ink_code, "ink_out": ink_out}
`);
    expect(r.colour_out).toContain('1 new or changed board(s) filed');
    expect(r.colour_out).not.toContain('could not file');
    expect(r.ink_code).toBe(1);
    expect(r.ink_out).toContain('would not decode');
  });

  it('a record nested past the limit is refused by the decoder itself (review 2: the limit had no test)', () => {
    const r = py(`
deep = b"\\x08\\x01"
for _ in range(200):                           # deeper than MAX_DEPTH, far inside Python's own limit
    deep = fx.fld(2, 2, deep)
errors = {}
for name, call in (("walk", lambda: fb.walk(deep, [])), ("strings", lambda: fb.mergeable_strings(deep)),
                   ("plain", lambda: fb._plain_strings(deep))):
    try:
        call(); errors[name] = None
    except ValueError as e:
        errors[name] = str(e)
shallow = b"\\x08\\x01"
for _ in range(30):
    shallow = fx.fld(2, 2, shallow)
fb.walk(shallow, [])
result = errors
`);
    expect(r).toEqual({ walk: 'record nested too deep', strings: 'record nested too deep', plain: 'record nested too deep' });
  });

  it('a state file that cannot be saved takes the note back out and stops, with no traceback (review 2, finding 7)', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
spec = fx.sample(note="Changed"); edit(spec); preview_for(spec)
real = fb.save_state
def refuse(path, state): raise OSError(28, "No space left on device")
fb.save_state = refuse
code, out = bridge()
left = inbox()
fb.save_state = real
retry, _ = bridge()
result = {"code": code, "out": out, "left": left, "retry": retry, "notes": [f for f in inbox() if f.endswith(".md")]}
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('state file could not be saved');
    expect(r.left).toEqual([]);
    expect(r.retry).toBe(0);
    expect(r.notes).toEqual(['Garden plan (Freeform board).md']);
  });

  it('when the note cannot be taken back out either, the error says it will be filed twice (review 4: no test)', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
spec = fx.sample(note="Changed"); edit(spec); preview_for(spec)
real_save, real_remove = fb.save_state, os.remove
def refuse(path, state): raise OSError(28, "No space left on device")
def stuck(path, *a, **k):
    if str(path).startswith(INBOX): raise PermissionError(13, "Permission denied")
    return real_remove(path, *a, **k)
fb.save_state = refuse; os.remove = stuck
code, out = bridge()
fb.save_state = real_save; os.remove = real_remove
result = {"code": code, "out": out, "left": len(inbox())}
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('could NOT be taken back out');
    expect(r.out).toContain('filed twice');
    expect(r.out).not.toContain('was taken back out');
    expect(r.left).toBeGreaterThan(0);
  });

  it('--baseline --force is the way out of a state file that will not read, as the error says (review 4, finding 3)', () => {
    const r = py(`
db([fx.sample()])
open(STATE, "w").write("[]")
stopped, said = bridge()
plain, _ = bridge("--baseline")
forced, forced_out = bridge("--baseline", "--force")
after, _ = bridge()
result = {"stopped": stopped, "said": said, "plain": plain, "forced": forced, "forced_out": forced_out, "after": after,
          "boards": len(json.load(open(STATE))["boards"])}
`);
    expect(r.stopped).toBe(1);
    expect(r.said).toContain('--baseline --force');
    expect(r.plain).toBe(1);                  // without --force a broken file is still never replaced
    expect(r.forced).toBe(0);
    expect(r.forced_out).toContain('Baseline: 1 existing board(s) recorded');
    expect(r.after).toBe(0);
    expect(r.boards).toBe(1);
  });

  it('a database that errors part-way is an ERROR line, not a traceback (review 2, finding 8)', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
con = sqlite3.connect(os.path.join(D, "Boards", "boards.db")); con.execute("drop table freehand_drawing_buckets"); con.commit(); con.close()
code, out = bridge()
listed, list_out = bridge("--list")
result = {"code": code, "out": out, "listed": listed, "list_out": list_out}
`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("ERROR: Freeform's database could not be read");
    expect(r.listed).toBe(1);
    expect(r.list_out).toContain("ERROR: Freeform's database could not be read");
  });

  it('a board too big for the tile cap is shrunk and cut again, never trimmed (review 2: halving had no test)', () => {
    const r = py(`
from PIL import Image
fb.TILE, fb.TILE_OVERLAP, fb.MAX_TILES, fb.OVERVIEW_SIDE = 300, 20, 4, 200
parts = fb.tiles(Image.new("RGB", (1000, 1000), "black"))
result = {"parts": len(parts), "labels": sorted(l for l, _ in parts)}
`);
    // A 1000-pixel picture cuts 4 x 4 at this tile size. Four parts labelled 2 x 2 means it
    // was halved and cut again; four parts of a 4 x 4 grid would mean twelve were thrown away.
    expect(r.parts).toBe(4);
    expect(r.labels).toEqual(['row 1 of 2, column 1 of 2', 'row 1 of 2, column 2 of 2',
                              'row 2 of 2, column 1 of 2', 'row 2 of 2, column 2 of 2']);
  });

  it('a state file of the wrong shape is refused with an ERROR, not a traceback (review 3, finding 9)', () => {
    const r = py(`
db([fx.sample()])
outs = []
for bad in ("[]", '{"boards": []}', '{"boards": {"x": 1}}', '{"boards": {}, "unchecked_streak": "many"}'):
    open(STATE, "w").write(bad)
    outs.append(bridge())
open(STATE, "w").write('{"boards": {}, "unchecked_streak": null}')
ok, ok_out = bridge("--no-ocr")
result = {"codes": [c for c, _ in outs], "all_say": all("will not read" in o for _, o in outs), "null_streak": ok}
`);
    expect(r.codes).toEqual([1, 1, 1, 1]);
    expect(r.all_say).toBe(true);
    expect(r.null_streak).toBe(0);
  });

  it('a note with no pictures is written whole or not at all (review 3, finding 6)', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
spec = fx.sample(note="Changed"); edit(spec); preview_for(spec)
bridge()
edit({"id": "A" * 32, "name": "Garden plan"})    # cleared: the next note is a plain one
real = fb.os.replace
def refuse(a, b):
    if a.endswith(".part"): raise OSError(5, "Input/output error")
    return real(a, b)
fb.os.replace = refuse
before = inbox()
code, out = bridge()
left = inbox()
fb.os.replace = real
retry, _ = bridge()
result = {"code": code, "same": left == before, "retry": retry, "added": [f for f in inbox() if f not in before]}
`);
    expect(r.code).toBe(1);
    expect(r.same).toBe(true);
    expect(r.retry).toBe(0);
    expect(r.added).toEqual(['Garden plan (Freeform board) (2).md']);
  });

  it('an unchanged board has its last-seen time moved on each run', () => {
    const r = py(`
db([fx.sample()])
bridge("--baseline")
first = json.load(open(STATE))["boards"]["A" * 32]["seen_at"]
time.sleep(1.2)
bridge()
result = {"moved": json.load(open(STATE))["boards"]["A" * 32]["seen_at"] > first}
`);
    expect(r.moved).toBe(true);
  });

  it('a board that will not decode is skipped loudly and the others still file', () => {
    const r = py(`
db([fx.sample(), fx.sample("B" * 32, "Good board")])
bridge("--baseline")
before = json.load(open(STATE))["boards"]["A" * 32]["fingerprint"]
good = fx.sample("B" * 32, "Good board", note="Changed")
edit(good); preview_for(good)
edit(fx.sample(note="Changed too"))
con = sqlite3.connect(os.path.join(D, "Boards", "boards.db"))
con.execute("update freehand_drawing_buckets set bucket_data = x'63726474060000000AFF' where board_indentifier = ?",
            (bytes.fromhex("A" * 32),))
con.commit(); con.close()
code, out = bridge()
state = json.load(open(STATE))
result = {"code": code, "out": out, "inbox": inbox(), "bad_filed": state["boards"]["A" * 32]["filed_at"],
          "kept": state["boards"]["A" * 32]["fingerprint"] == before}
`);
    expect(r.kept).toBe(true);     // a failed board keeps its old entry, so the next run tries it again
    expect(r.code).toBe(1);
    expect(r.out).toContain('would not decode');
    expect(r.inbox).toContain('Good board (Freeform board).md');
    expect(r.inbox.join()).not.toContain('Garden plan');
    expect(r.bad_filed).toBe(null);
  });
});

describe('freeform-bridge: waiting for iCloud', () => {
  // sync() is driven with a fake clock and a fake Freeform, so the test takes no
  // real time and never opens the real app.
  const harness = `
clock = [1000.0]
fb.time.time = lambda: clock[0]
def nap(s): clock[0] += s
running = [RUNNING_AT_START]
opened, killed = [], []
fb._freeform_pids = lambda: [4242] if running[0] else []
class R: returncode = 0; stderr = ""; stdout = ""
def fake_run(cmd, **kw):
    opened.append(cmd); running[0] = True; return R()
fb.subprocess.run = fake_run
fb.os.kill = lambda pid, sig: killed.append(pid)
def trying():
    try:
        return fb.sync("x", sleep=nap), None
    except fb.BridgeError as e:
        return None, str(e)
`;

  it('gives up loudly when the database never goes quiet, and still closes Freeform', () => {
    const r = py(harness.replace('RUNNING_AT_START', 'False') + `
n = [0]
def changing(db):
    n[0] += 1; return {"A": (n[0],)}
fb._snapshot = changing
got, err = trying()
result = {"err": err, "opened": len(opened), "killed": killed}
`);
    expect(r.err).toContain('still changing after 600 seconds');
    expect(r.opened).toBe(1);
    expect(r.killed).toEqual([4242]);
  });

  it('waits for a quiet database, and leaves Freeform open when Kevin already had it open', () => {
    const r = py(harness.replace('RUNNING_AT_START', 'True') + `
n = [0]
def settles(db):
    n[0] += 1; return {"A": (min(n[0], 20),)}     # changes for 20 reads, then holds still
fb._snapshot = settles
got, err = trying()
result = {"waited": got["waited"], "arrived": sorted(got["arrivals"]), "opened_app": got["opened"],
          "opened": len(opened), "killed": killed}
`);
    expect(r.waited).toBeGreaterThanOrEqual(130);   // about 95 s of change + 40 s of quiet
    expect(r.waited).toBeLessThan(200);
    expect(r.arrived).toEqual(['A']);
    expect(r.opened_app).toBe(false);
    expect(r.opened).toBe(0);
    expect(r.killed).toEqual([]);
  });

  it('a database quiet from the start is still given 90 seconds for iCloud to begin', () => {
    const r = py(harness.replace('RUNNING_AT_START', 'False') + `
fb._snapshot = lambda db: {"A": (1,)}
got, err = trying()
result = {"waited": got["waited"], "arrivals": got["arrivals"], "ended": got["ended"] >= 1090}
`);
    expect(r.waited).toBeGreaterThanOrEqual(90);
    expect(r.waited).toBeLessThan(110);
    expect(r.arrivals).toEqual({});
    expect(r.ended).toBe(true);
  });

  it('records when each board\'s own data arrived, including a board seen for the first time', () => {
    const r = py(harness.replace('RUNNING_AT_START', 'False') + `
n = [0]
def snap(db):
    n[0] += 1
    out = {"A": (1,) if n[0] < 4 else (2,)}      # board A changes at the 4th read
    if n[0] >= 10:
        out["B"] = (1,)                          # board B appears at the 10th, 30 s later
    return out
fb._snapshot = snap
got, err = trying()
result = {"gap": got["arrivals"]["B"] - got["arrivals"]["A"], "boards": sorted(got["arrivals"])}
`);
    expect(r.boards).toEqual(['A', 'B']);
    expect(r.gap).toBe(30);
  });

  it('one unreadable read mid-wait does not lose the arrival of a board that changed across it (review 3, finding 8)', () => {
    const r = py(harness.replace('RUNNING_AT_START', 'False') + `
n = [0]
def snap(db):
    n[0] += 1
    if n[0] == 5: return None
    return {"A": (1,) if n[0] < 5 else (2,)}
fb._snapshot = snap
got, err = trying()
result = {"boards": sorted(got["arrivals"]), "err": err}
`);
    expect(r.err).toBe(null);
    expect(r.boards).toEqual(['A']);
  });

  it('the picture of the database ignores its log file\'s timestamp and sees a real change (review 3, finding 7: no test)', () => {
    const r = py(`
p = db([fx.sample()])
wal = p + "-wal"
open(wal, "ab").close(); os.utime(wal, (5, 5)); os.utime(p, (5, 5))
a = fb._snapshot(p)
os.utime(wal, (99999, 99999)); os.utime(p, (99999, 99999))
b = fb._snapshot(p)
edit(fx.sample(note="Changed, and longer than it was before"))
c = fb._snapshot(p)
result = {"read": a is not None, "same": a == b, "changed": a != c}
`);
    expect(r.read).toBe(true);
    expect(r.same).toBe(true);
    expect(r.changed).toBe(true);
  });

  it('an unreadable database is never mistaken for a quiet one', () => {
    const r = py(harness.replace('RUNNING_AT_START', 'False') + `
fb._snapshot = lambda db: None
got, err = trying()
result = {"err": err}
`);
    expect(r.err).toContain('still changing after 600 seconds');
  });
});
