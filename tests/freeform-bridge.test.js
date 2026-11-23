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
    im.thumbnail((400, 400))
    b = spec["id"]
    im.save(os.path.join(PREVIEWS, f"board_{b[:8]}-{b[8:12]}-{b[12:16]}-{b[16:20]}-{b[20:]}#_large_2.0_light"), "PNG")
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

  it('with no preview, or one drawn before the change arrived, the note says NOT CHECKED', () => {
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
    expect(r.none_out).toContain('WARNING: 1 filed board(s) had no current Freeform preview');
    expect(r.none_note).toContain('Picture check: NOT CHECKED');
    expect(r.stale_code).toBe(0);
    expect(r.stale_note).toContain('has not redrawn its preview since this board changed');
    expect(r.files.join()).not.toContain('(2) - Freeform preview');
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
    expect(r.note).toContain('NOTHING. Kevin has cleared this board');
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

  it('a board that will not decode is skipped loudly and the others still file', () => {
    const r = py(`
db([fx.sample(), fx.sample("B" * 32, "Good board")])
bridge("--baseline")
good = fx.sample("B" * 32, "Good board", note="Changed")
edit(good); preview_for(good)
edit(fx.sample(note="Changed too"))
con = sqlite3.connect(os.path.join(D, "Boards", "boards.db"))
con.execute("update freehand_drawing_buckets set bucket_data = x'63726474060000000AFF' where board_indentifier = ?",
            (bytes.fromhex("A" * 32),))
con.commit(); con.close()
code, out = bridge()
state = json.load(open(STATE))
result = {"code": code, "out": out, "inbox": inbox(), "bad_filed": state["boards"]["A" * 32]["filed_at"]}
`);
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
`;

  it('gives up loudly when the database never goes quiet, and still closes Freeform', () => {
    const r = py(harness.replace('RUNNING_AT_START', 'False') + `
n = [0]
def changing(db):
    n[0] += 1; return n[0]
fb._snapshot = changing
try:
    fb.sync("x", sleep=nap); err = None
except fb.BridgeError as e:
    err = str(e)
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
    n[0] += 1; return min(n[0], 20)      # changes for 20 reads (100 s), then holds still
fb._snapshot = settles
waited, changed_at = fb.sync("x", sleep=nap)
result = {"waited": waited, "changed": changed_at > 0, "opened": len(opened), "killed": killed}
`);
    expect(r.waited).toBeGreaterThanOrEqual(130);   // about 95 s of change + 40 s of quiet
    expect(r.waited).toBeLessThan(200);
    expect(r.changed).toBe(true);
    expect(r.opened).toBe(0);
    expect(r.killed).toEqual([]);
  });

  it('an unreadable database is never mistaken for a quiet one', () => {
    const r = py(harness.replace('RUNNING_AT_START', 'False') + `
fb._snapshot = lambda db: None
try:
    fb.sync("x", sleep=nap); err = None
except fb.BridgeError as e:
    err = str(e)
result = {"err": err}
`);
    expect(r.err).toContain('still changing after 600 seconds');
  });
});
