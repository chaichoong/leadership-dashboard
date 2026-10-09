import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// THE TRIAGE HISTORY BOOK MUST BE ABLE TO FINISH (Kevin's approved build, 5 Oct 2026;
// finding 20261002-phase-2-702).
//
// The book was last rebuilt on 1 Sep 2026. Ten lanes at up to 20 pages is 101,000 Gmail quota
// units, Gmail gives 6,000 a minute, and a rebuild may take half of that — about 34 minutes of
// walking. No slot has 34 minutes. So every rebuild ran out, threw away everything it had read,
// recorded a FAILURE, and after two of those the retry stopped for good. 35 days later the inbox
// sorter was still filing mail against 1 Sep sender knowledge, with every slot reporting ok.
//
// Two of the three things Kevin asked to be proved live here:
//   2. a walk refused halfway resumes and ends with exactly the counts of one clean pass
//   3. a wall during a rebuild is not a failure
// (1. two processes sharing the pacer: tests/gmail-pacer.test.js.)
//
// Each is back-tested by removing the mechanism it guards.

const ROOT = path.resolve(__dirname, '..');

/**
 * Drives the REAL _history_build with a stubbed Gmail transport and a clock we control.
 * `budget` is the wall in seconds; `tickPerPage` is how much the clock jumps per page, so a
 * budget smaller than lanes*pages*tick forces a wall part-way.
 */
function run({ home, budget, tickPerPage, pagesPerLane = 2, resume = true, clearProgress = false }) {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'hist-')), 'drive.py');
  writeFileSync(f, `
import importlib.util, json, os, sys
sys.path.insert(0, "scripts")
spec = importlib.util.spec_from_file_location("it", "scripts/inbound-triage.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

LANES = sorted(m.HISTORY_LANE_MAP, key=int)
PAGES = ${pagesPerLane}

# Gmail, stubbed: every lane has PAGES pages of 25 messages, each from a distinct sender, so a
# complete walk must count exactly LANES*PAGES*25 messages across that many senders.
calls = {"n": 0}
def fake_worker_post(path_, payload, sleep=None):
    assert path_ == "/gmail/list", path_
    calls["n"] += 1
    label = payload["labelIds"][0]
    page = int((payload.get("pageToken") or "p0")[1:])
    msgs = [{
        "id": "m-%s-%d-%d" % (label, page, i),
        "headers": {"from": "s%s-%d-%d@example.com" % (label, page, i)},
        "internalDate": str(1_700_000_000_000 + i),
    } for i in range(25)]
    out = {"messages": msgs}
    if page + 1 < PAGES:
        out["nextPageToken"] = "p%d" % (page + 1)
    return out

m.worker_post = fake_worker_post
m.worker_labels = lambda: [{"id": "L%s" % p, "name": "%s Something" % p} for p in LANES]
m.collect_agent_ids = lambda *a, **k: set()
m.find_label = lambda labels, prefix: next((l for l in labels if l["id"] == "L%s" % prefix), None)
m.classify_era = lambda *a, **k: "human-era"

# Airtable and state, stubbed: we assert on what the walk COUNTED, not on the network.
wrote = {"batches": 0, "records": 0}
book = {}
def fake_airtable(method, table, payload=None, what=""):
    # The re-stamp reads the book back after the upsert (finding 793): serve what was written.
    if method == "GET":
        return {"records": [{"id": "rec%014d" % i, "fields": {m.HB["sender"]: s, m.HB["lastBuilt"]: b}}
                            for i, (s, b) in enumerate(sorted(book.items()))]}
    for r in payload.get("records") or []:
        f = r.get("fields") or {}
        if m.HB["sender"] in f:
            book[f[m.HB["sender"]]] = f.get(m.HB["lastBuilt"])
    wrote["batches"] += 1
    wrote["records"] += len(payload.get("records") or [])
    return {}
m.airtable_request = fake_airtable
m.read_state = lambda: {}
m.write_state = lambda st: None
m.write_fail_state = lambda st: None
m.read_fail_state = lambda: {}
m.progress = lambda *a, **k: None

CLOCK = [1_000_000.0]
def clock():
    return CLOCK[0]
_real = fake_worker_post
def ticking(path_, payload, sleep=None):
    CLOCK[0] += ${tickPerPage}
    return _real(path_, payload, sleep)
m.worker_post = ticking

if ${clearProgress ? 'True' : 'False'}:
    m.history_progress_clear()

result = {"walls": 0, "finished": False, "senders": 0, "messages": 0, "pages": 0}
for attempt in range(40):
    try:
        m._history_build(PAGES, budget=${budget}, now=clock)
        result["finished"] = True
        break
    except m.HistoryWall as w:
        result["walls"] += 1
        CLOCK[0] += 1          # a new run starts with a fresh budget
        if not ${resume ? 'True' : 'False'}:
            m.history_progress_clear()     # the pre-fix behaviour: throw the work away
    except SystemExit as e:
        result["systemExit"] = str(e)
        break

prog = m.history_progress_read()
result["pages"] = calls["n"]
result["airtableBatches"] = wrote["batches"]
result["airtableRecords"] = wrote["records"]
result["progressLeftBehind"] = bool(prog)
print(json.dumps(result))
`);
  const out = execFileSync('python3', [f], {
    encoding: 'utf8', cwd: ROOT, timeout: 120000,
    env: { ...process.env, HOME: home },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const sandbox = () => mkdtempSync(path.join(tmpdir(), 'hist-home-'));

// 10 lanes x 2 pages = 20 pages, 500 messages, 500 distinct senders.
const CLEAN_PAGES = 20;
const CLEAN_RECORDS = 500;

describe('the triage history rebuild', () => {
  it('walks the whole book in one pass when it has the time', () => {
    const r = run({ home: sandbox(), budget: 10_000, tickPerPage: 1 });
    expect(r.finished).toBe(true);
    expect(r.walls).toBe(0);
    expect(r.pages).toBe(CLEAN_PAGES);
    expect(r.airtableRecords).toBe(CLEAN_RECORDS);
    expect(r.progressLeftBehind).toBe(false);   // the saved place is spent on success
  });

  // ── 2. refused halfway, resumes, same counts ───────────────────────────────
  it('resumes after a wall and ends with exactly the counts of one clean pass', () => {
    const r = run({ home: sandbox(), budget: 3, tickPerPage: 1 });
    expect(r.walls).toBeGreaterThan(0);          // it really did hit the wall, repeatedly
    expect(r.finished).toBe(true);               // and still finished
    expect(r.pages).toBe(CLEAN_PAGES);           // paying for each page exactly ONCE
    expect(r.airtableRecords).toBe(CLEAN_RECORDS);
    expect(r.progressLeftBehind).toBe(false);
  });

  it('writes NOTHING to the book until every lane is walked', () => {
    const r = run({ home: sandbox(), budget: 3, tickPerPage: 1 });
    // One write phase at the end, never a lane at a time: a book half old and half new is
    // the failure finding 20260930-phase-2-611 recorded.
    expect(r.airtableBatches).toBe(Math.ceil(CLEAN_RECORDS / 10));
    expect(r.finished).toBe(true);
  });

  it('BACK-TEST: throwing the saved place away makes every run start again and never finish', () => {
    const r = run({ home: sandbox(), budget: 3, tickPerPage: 1, resume: false });
    expect(r.finished).toBe(false);              // 40 attempts, still not done
    expect(r.walls).toBe(40);
    expect(r.pages).toBeGreaterThan(CLEAN_PAGES);  // the same pages paid for again and again
    expect(r.airtableRecords).toBe(0);           // the book was never written
  });

  // ── 3. a wall is not a failure ─────────────────────────────────────────────
  it('raises a wall that is a pause, not an error, and keeps the place', () => {
    const home = sandbox();
    const f = path.join(mkdtempSync(path.join(tmpdir(), 'wall-')), 'drive.py');
    writeFileSync(f, `
import importlib.util, json, sys
sys.path.insert(0, "scripts")
spec = importlib.util.spec_from_file_location("it", "scripts/inbound-triage.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

seen = {"failWritten": False}
m.read_fail_state = lambda: {}
def fake_write_fail(st):
    # The give-up counter and the cooldown live here. A wall must NOT touch them.
    if st: seen["failWritten"] = True
m.write_fail_state = fake_write_fail
m.history_progress_write({"stats": {}, "lanes": {"6": {"done": False, "token": "p1", "pages": 1}}})

def walls(pages, budget=None):
    raise m.HistoryWall(3, 10, 42.0)
m._history_build = walls

out = m.cmd_history_build(2, budget=5)
print(json.dumps({
    "returned": out,
    "failStateWritten": seen["failWritten"],
    "placeKept": bool(m.history_progress_read()),
}))
`);
    const r = JSON.parse(execFileSync('python3', [f], {
      encoding: 'utf8', cwd: ROOT, timeout: 60000, env: { ...process.env, HOME: home },
    }).trim().split('\n').pop());
    expect(r.returned).toBe(null);          // no exception escaped, so the slot is not red
    expect(r.failStateWritten).toBe(false); // the give-up counter did not move
    expect(r.placeKept).toBe(true);         // and the next run can carry on
  });

  it('a GENUINE failure still records itself, so a broken rebuild is still reported broken', () => {
    const home = sandbox();
    const f = path.join(mkdtempSync(path.join(tmpdir(), 'broken-')), 'drive.py');
    writeFileSync(f, `
import importlib.util, json, sys
sys.path.insert(0, "scripts")
spec = importlib.util.spec_from_file_location("it", "scripts/inbound-triage.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
written = {}
m.read_fail_state = lambda: {}
m.write_fail_state = lambda st: written.update(st)
def broken(pages, budget=None):
    raise RuntimeError("the listing is broken")
m._history_build = broken
try:
    m.cmd_history_build(2, budget=5)
    raised = False
except RuntimeError:
    raised = True
print(json.dumps({"raised": raised, "failCount": written.get("history_build_fail_count"),
                  "kind": written.get("history_build_fail_kind")}))
`);
    const r = JSON.parse(execFileSync('python3', [f], {
      encoding: 'utf8', cwd: ROOT, timeout: 60000, env: { ...process.env, HOME: home },
    }).trim().split('\n').pop());
    expect(r.raised).toBe(true);        // a real fault still fails the run
    expect(r.failCount).toBe(1);        // and still moves the give-up counter
    expect(r.kind).toBe('other');
  });
});
