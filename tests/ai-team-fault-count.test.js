import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// "Things needing a fix" counts each code fault ONCE (Kevin, 14 Nov 2026). On 13 Nov 2026 one
// fault held 7 blocked tasks and was counted 7 times. These tests drive the real functions in
// scripts/ai_team_health.py with a fixture blockers file and a fixture findings queue written to a
// temp folder (never ~/knowledge-os). Back-test: A.GROUP_FAULTS = False puts the old per-task
// count back, and the fault-count assertions fail against it. Names are invented: the repo is public.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = resolve(ROOT, 'scripts');

function py(code) {
  const script = `
import importlib.util, json, sys, os, tempfile
from datetime import datetime, timedelta, timezone
sys.path.insert(0, ${JSON.stringify(SCRIPTS)})
spec = importlib.util.spec_from_file_location("ath", os.path.join(${JSON.stringify(SCRIPTS)}, "ai_team_health.py"))
A = importlib.util.module_from_spec(spec); spec.loader.exec_module(A)
NOW = datetime(2026, 10, 15, 11, 0, tzinfo=timezone.utc)
iso = lambda dt: dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
CLOCK = {"SIGN-IN": 1, "TOOL": 3, "KEVIN": 3}
F7, FA, FB, FC, FD, FREP = ("20261101-agent-dispatch-007", "20261102-agent-dispatch-0a1", "20261103-agent-dispatch-0b1",
                            "20261104-agent-dispatch-0c1", "20261105-agent-dispatch-0d1", "20261106-agent-dispatch-0e1")
def wall(t, kind, finding="", days=5.0):
    return {"task": t, "name": "Invented task " + t[3:], "agent": "Agent", "kind": kind, "finding": finding,
            "findingStatus": "open" if finding else "", "days": days, "toolState": "", "tool": ""}
WALLS = ([wall("recT%d" % i, "TOOL", F7) for i in range(1, 8)]      # one fault holding 7 tasks
         + [wall("recT1", "KEVIN")]                                   # a task with two walls: still one thing
         + [wall("recA", "TOOL", FA), wall("recB", "TOOL", FB), wall("recC", "TOOL", FC)]   # faults holding 1
         + [wall("recR", "TOOL", FREP)]                               # walled on a merged repeat of FA
         + [wall("recD", "TOOL", FB), wall("recD", "TOOL", FD)]       # one task on two DIFFERENT faults
         + [wall("recNOF", "TOOL", "")]                               # a code wall naming no finding
         + [wall("recK", "KEVIN")])                                   # not a fault: counts per task
TMP = tempfile.mkdtemp()
BPATH = os.path.join(TMP, "blockers.json")
with open(BPATH, "w") as fh:
    json.dump({"readAt": iso(NOW), "openTasksRead": 1, "open": WALLS}, fh)
os.utime(BPATH, (NOW.timestamp(), NOW.timestamp()))
QPATH = os.path.join(TMP, "findings-queue.jsonl")
with open(QPATH, "w") as fh:
    for f in (F7, FA, FB, FC, FD, FREP):
        fh.write(json.dumps({"op": "add", "id": f, "routine": "agent-dispatch", "title": "x", "ts": "2026-11-01T00:00:00Z"}) + "\\n")
    fh.write(json.dumps({"op": "dupe", "id": FREP, "of": FA, "ts": "2026-11-07T00:00:00Z"}) + "\\n")
def bottleneck(roots_path=QPATH):
    roots, err = A.read_finding_roots(roots_path)
    f = A.facts_bottlenecks(A.read_blockers(NOW, BPATH), CLOCK, NOW, (), roots, err)
    return A.judge_bottlenecks(f, NOW), f
${code}
`;
  return JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], { encoding: 'utf8' }));
}

describe('Things needing a fix counts each code fault once', () => {
  it('groups blocked tasks by the fault their code wall names; a repeat counts toward its survivor', () => {
    const out = py(`
l, f = bottleneck()
print(json.dumps({"count": l["count"], "faults": [[x["finding"], x["count"]] for x in l["faults"]],
                  "held": f["heldByFaults"], "blocked": len(f["blocked"]), "perTask": l["_perTask"][0],
                  "extra": l["extra"], "byWallId": f["byWallId"]}))`);
    // 14 blocked tasks. 5 faults (F7 holds 7, FA holds recA and the repeat's recR, FB holds recB and
    // recD, FC, FD) plus the no-finding wall and the KEVIN wall, each by itself: 7 things to fix.
    expect(out.blocked).toBe(14);
    expect(out.perTask).toBe(14);
    expect(out.count).toBe(7);
    expect(out.faults).toEqual([
      ['20261101-agent-dispatch-007', 7], ['20261102-agent-dispatch-0a1', 2], ['20261103-agent-dispatch-0b1', 2],
      ['20261104-agent-dispatch-0c1', 1], ['20261105-agent-dispatch-0d1', 1]]);
    expect(out.held).toBe(12);
    expect(out.byWallId).toBe(false);
    // The line names the fault and how many tasks it holds, with the task names reachable.
    const big = out.extra.find(e => e[0] === 'Fault 20261101-agent-dispatch-007');
    expect(big[1]).toMatch(/^holds 7 tasks: Invented task T1, Invented task T2/);
    expect(out.extra).toContainEqual(['Things to fix here (each code fault once, every other blocked task once)', '7']);
  });

  it('back-test: with the grouping switched off the line counts every blocked task, as before', () => {
    const out = py(`
A.GROUP_FAULTS = False
l, f = bottleneck()
print(json.dumps({"count": l["count"], "faults": l["faults"]}))`);
    expect(out.count).toBe(14);
    expect(out.faults).toEqual([]);
  });

  it('a findings queue that cannot be read groups by the id on each wall and says so, never crashes', () => {
    const out = py(`
l, f = bottleneck(os.path.join(TMP, "no-such-queue.jsonl"))
print(json.dumps({"count": l["count"], "byWallId": f["byWallId"], "note": [e for e in l["extra"] if e[0] == "Note"]}))`);
    // The repeat is not merged: FREP is its own fault, one more than with the queue read.
    expect(out.count).toBe(8);
    expect(out.byWallId).toBe(true);
    expect(out.note[0][1]).toMatch(/repeats of one fault were not merged: the findings queue has no file/);
  });

  it('the one number: a task another line also counts merges with its fault; the old count is kept beside it', () => {
    const out = py(`
l, f = bottleneck()
other = A.line("responses", "amber", "x", 2, count=2, keys=["task:recA", "task:recZ"])
lines = [A.line(d["key"], "green", "a", 0, count=0 if d["key"] in A.HEADLINE_LINES else None) for d in A.LINES]
lines = [l if x["key"] == "bottlenecks" else other if x["key"] == "responses" else x for x in lines]
print(json.dumps({"new": A.headline(lines)["number"], "old": A.headline(lines, per_task=True)["number"]}))`);
    expect(out.new).toBe(8);      // 7 things + 2 drafts, recA is one of FA's tasks: counted once
    expect(out.old).toBe(15);     // 14 tasks + 2 drafts - recA once
  });

  it('the trend stays honest: the old count is stored, the panel says so, and last week (per task) is compared per task', () => {
    const out = py(`
l, f = bottleneck()
lines = [A.line(d["key"], "green", "a", 0, count=0 if d["key"] in A.HEADLINE_LINES else None) for d in A.LINES]
lines = [l if x["key"] == "bottlenecks" else x for x in lines]
lights = {"flow": "red", "broken": "green", "keep": "green"}
hist = {"2026-10-11": {A.HEAD_KEY: [12, False], A.LIGHTS_KEY: lights}}       # last week, counted per task
p = A.build_payload(lines, hist, NOW)
print(json.dumps({"number": p["headline"]["number"], "perTask": p["headline"]["perTask"], "method": p["headline"]["method"],
                  "weeks": [[w["number"], w["perFault"], w["perTask"]] for w in p["weeks"]],
                  "stored": p["history"]["2026-10-15"], "verdict": p["verdict"],
                  "detail": A.headline_text(p["headline"], p["lastWeek"]),
                  "keys": sorted(k for k in p["lines"][3] if k.startswith("_"))}))`);
    expect(out.number).toBe(7);
    expect(out.perTask).toBe(14);
    expect(out.method).toEqual({ since: '2026-10-15', perTask: 14, text: 'Counted per fault since 15 Oct 2026. By the old count: 14' });
    expect(out.weeks).toEqual([[12, false, 12], [7, true, 14]]);
    expect(out.stored._h).toEqual([7, false]);
    expect(out.stored._hp).toEqual([14, false]);
    // 7 against last week's 12 would read "Getting better" with nothing fixed. Compared like with
    // like (14 against 12, both per task) it is more, so the answer is "Getting worse".
    expect([out.verdict.colour, out.verdict.text]).toEqual(['red', 'Getting worse']);
    expect(out.verdict.comparedPerTask).toBe(true);
    expect(out.verdict.reason).toMatch(/both weeks counted the old way/);
    expect(out.detail).toBe('7 things need a fix (12 last week, old count)');
    expect(out.keys).toEqual([]);                                  // nothing private-only reaches Airtable
  });
});
