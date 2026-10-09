import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A FINISHED REBUILD LEAVES NO STALE ROW (finding 20261008-agent-dispatch-793, approved 9 Oct 2026).
//
// The paced rebuild finished at 07:43 on 8 Oct 2026, but it upserts only the senders it walked:
// 130 of 281 Triage History Book rows read that morning and 151 still read 1 Sep. The daily
// triage-history-book-is-current invariant flags any row older than 14 days, so it stayed red on a
// book that had just been rebuilt, and two tasks stayed blocked on it.
//
// The walk reads only the newest pages of each lane, so a sender whose filings have scrolled past
// that window is not walked again. Its counts are still the best evidence the book has, so the row
// is KEPT, and a finished build stamps it with the build's time. Last Seen keeps its old date.
//
// Drives the REAL _history_build with Gmail and Airtable stubbed. Invented senders only.

const ROOT = path.resolve(__dirname, '..');

function run({ readBack = 'all', restamp = true } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'stamp-home-'));
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'stamp-')), 'drive.py');
  writeFileSync(f, `
import importlib.util, json, sys
from datetime import datetime, timedelta
sys.path.insert(0, "scripts")
spec = importlib.util.spec_from_file_location("it", "scripts/inbound-triage.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
HB = m.HB
LANES = sorted(m.HISTORY_LANE_MAP, key=int)

# Gmail: each lane has one page of 25 messages from 25 distinct, invented senders.
def fake_worker_post(path_, payload, sleep=None):
    label = payload["labelIds"][0]
    return {"messages": [{"id": "m-%s-%d" % (label, i),
                          "headers": {"from": "walked-%s-%d@example.test" % (label, i)},
                          "internalDate": str(1_790_000_000_000 + i)} for i in range(25)]}
m.worker_post = fake_worker_post
m.worker_labels = lambda: [{"id": "L%s" % p, "name": "%s Lane" % p} for p in LANES]
m.find_label = lambda labels, prefix: next((l for l in labels if l["id"] == "L%s" % prefix), None)
m.collect_agent_ids = lambda *a, **k: set()
m.classify_era = lambda *a, **k: "human-era"

# The book as it stood: one walked sender, three the walk no longer reaches, and a junk row with
# no sender. All carry the 1 Sep build stamp.
OLD = "2026-09-01T12:50:09"
book = {
  "recBOOK00000000001": {HB["sender"]: "walked-l6-0@example.test", HB["lastBuilt"]: OLD, HB["counts"]: '{"6": 9}', HB["lastSeen"]: "2026-08-20"},
  "recBOOK00000000002": {HB["sender"]: "old-sender-a@example.test", HB["lastBuilt"]: OLD, HB["counts"]: '{"10": 7}', HB["lastSeen"]: "2026-06-02"},
  "recBOOK00000000003": {HB["sender"]: "old-sender-b@example.test", HB["lastBuilt"]: OLD, HB["counts"]: '{"13": 4}', HB["lastSeen"]: "2026-05-11"},
  "recBOOK00000000004": {HB["sender"]: "old-sender-c@example.test", HB["lastBuilt"]: OLD, HB["counts"]: '{"8": 3}', HB["lastSeen"]: "2026-04-30"},
  "recBOOK00000000005": {HB["lastBuilt"]: OLD},
}
patches = []
def fake_airtable(method, table, payload=None, what=""):
    if method == "GET":
        if "${readBack}" == "none":
            return {"records": []}
        return {"records": [{"id": rid, "fields": {k: v for k, v in fl.items() if k in (HB["sender"], HB["lastBuilt"])}}
                            for rid, fl in sorted(book.items())]}
    patches.append(payload)
    for r in payload.get("records") or []:
        fl = r.get("fields") or {}
        if "id" in r:
            book[r["id"]].update(fl)
            continue
        hit = next((rid for rid, x in book.items() if x.get(HB["sender"]) == fl.get(HB["sender"])), None)
        if hit:
            book[hit].update(fl)
        else:
            book["recNEW%012d" % len(book)] = dict(fl)
    return {}
m.airtable_request = fake_airtable
state = {}
m.read_state = lambda: dict(state)
m.write_state = lambda st: state.update(st)
m.write_fail_state = lambda st: None
m.progress = lambda *a, **k: None
if not ${restamp ? 'True' : 'False'}:
    m.history_restamp_unseen = lambda seen, now_iso: 0      # the pre-fix behaviour

out = {"exit": None}
try:
    m._history_build(1, budget=10_000)
except SystemExit as e:
    out["exit"] = str(e)
built = state.get("history_built_ms")
stamps = {rid: fl.get(HB["lastBuilt"]) for rid, fl in book.items()}
newest = max(v for v in stamps.values() if v)
cutoff = (datetime.fromisoformat(newest) - timedelta(days=14)).isoformat(timespec="seconds")
out.update({
  "builtMoved": bool(built),
  "stamps": stamps,
  "newest": newest,
  # The invariant, applied here: a row with a sender and a stamp older than 14 days.
  "staleWithSender": sorted(rid for rid, fl in book.items() if fl.get(HB["sender"]) and fl.get(HB["lastBuilt"]) < cutoff),
  "oldCounts": book["recBOOK00000000002"].get(HB["counts"]),
  "oldLastSeen": book["recBOOK00000000002"].get(HB["lastSeen"]),
  "restampPatches": [p for p in patches if any("id" in r for r in p.get("records") or [])],
  "progressKept": bool(m.history_progress_read()),
})
print(json.dumps(out))
`);
  const res = execFileSync('python3', [f], { encoding: 'utf8', cwd: ROOT, timeout: 60000, env: { ...process.env, HOME: home } });
  return JSON.parse(res.trim().split('\n').pop());
}

describe('a finished history rebuild stamps the whole book (finding 793)', () => {
  const r = run();

  it('every row with a sender carries the new build stamp, so the 14-day check passes', () => {
    expect(r.exit).toBeNull();
    expect(r.builtMoved).toBe(true);
    expect(r.staleWithSender).toEqual([]);
    for (const id of ['recBOOK00000000001', 'recBOOK00000000002', 'recBOOK00000000003', 'recBOOK00000000004']) {
      expect(r.stamps[id], id).toBe(r.newest);
    }
  });
  it('a sender the walk no longer reaches keeps its counts and its Last Seen; only the stamp moves', () => {
    expect(r.oldCounts).toBe('{"10": 7}');
    expect(r.oldLastSeen).toBe('2026-06-02');
    const fieldsTouched = new Set(r.restampPatches.flatMap((p) => p.records.flatMap((x) => Object.keys(x.fields))));
    expect([...fieldsTouched]).toEqual(['fldA7wfceYI28zIwC']);   // Last Built, nothing else
    const ids = r.restampPatches.flatMap((p) => p.records.map((x) => x.id)).sort();
    expect(ids).toEqual(['recBOOK00000000002', 'recBOOK00000000003', 'recBOOK00000000004']);
  });
  it('a row with no sender is not stamped (it is not a sender the book knows)', () => {
    expect(r.stamps.recBOOK00000000005).toBe('2026-09-01T12:50:09');
  });
  it('a read-back that misses the senders just written fails the run, stamps nothing and keeps the place', () => {
    const broken = run({ readBack: 'none' });
    expect(broken.exit).toBe('2');
    expect(broken.restampPatches).toEqual([]);
    expect(broken.builtMoved).toBe(false);
    expect(broken.progressKept).toBe(true);
  });
  it('BACK-TEST: without the re-stamp, the three unwalked rows stay stale and the check stays red', () => {
    const old = run({ restamp: false });
    expect(old.exit).toBeNull();
    expect(old.staleWithSender).toEqual(['recBOOK00000000002', 'recBOOK00000000003', 'recBOOK00000000004']);
  });
});
