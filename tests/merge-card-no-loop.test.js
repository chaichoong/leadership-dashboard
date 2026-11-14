import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const S = (f) => resolve(ROOT, 'scripts', f);

// A MERGE CARD IS NEVER AN APPROVE THAT DOES NOTHING (13 Nov 2026). The MERGE card for one PR was
// approved 33 times in a week and nothing ran: a red gate sent it back to Kevin's queue, and after
// two reds every later approval was sent back with "nothing runs". Both reds were tests the PR never
// touched, so no fix on its own branch could ever arrive. Now his approval of a tested head stands:
// the robot retries by itself on a clock (6 hours apart, at most 4 reds on one head), then files ONE
// finding and the card rests out of his queue until the head changes. These tests drive the real
// plan, fail, merge_one, cmd_run and cmd_detach with GitHub and Airtable stubbed, and the real
// dispatcher's build_queue, held_card_problem and cmd_complete offline. Every name and PR number is
// invented (this repo is public).
const run = (code) => JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8' }).trim().split('\n').pop());
const HEAD = 'a1b2c3d4'.repeat(5);
const NEWHEAD = 'f0e1d2c3'.repeat(5);
const BUILDER = 'recQkO6BA4w5zqwZ4';
const OUTPUT = `MERGE CARD: PR #812, fix: retype\nhttps://example.test/pull/812\nTested head: ${HEAD}\n\n**Carrying this out will involve:** If you approve, the robot runs merge-pr.py and the deploy, nothing else.`;
const T0 = 1793955600; // 2026-11-06T09:00:00Z
const HOUR = 3600;
const card = (over = {}) => JSON.stringify(Object.assign({
  id: 'recCardAaaaaaaaaa', name: 'MERGE: PR #812 — fix', pr: 812, status: 'Today', outcome: 'Approved as-is',
  approvedAt: '2026-11-06T08:30:00.000Z', feedback: '', notes: '', agentOutput: OUTPUT, head: HEAD, findings: [],
  fields: { fld30Yw8SWYVp049g: [BUILDER], fldr4Mvf2RzKvhZhi: '2026-11-06T08:30:00.000Z' },
  createdTime: '2026-11-06T08:00:00.000Z',
}, over));
const RED_TAIL = 'FAIL tests/sync-invariants/example-page.spec.js:486 the header shows\\nFAIL tests/example-slowdown.test.js';

// The merger with every outside call stubbed. NOW moves the clock; MERGE_RESULTS is the gate's
// answer per run (red or green); every write lands in PATCHES, NOTES or ADDS.
const drive = (prelude, dir = mkdtempSync(join(tmpdir(), 'od-ma-loop-'))) => run(`
import importlib.util, json, sys, os, io, contextlib, argparse, subprocess
sys.path.insert(0, ${JSON.stringify(S(''))})
spec = importlib.util.spec_from_file_location("ma", ${JSON.stringify(S('merge-approved.py'))})
ma = importlib.util.module_from_spec(spec); spec.loader.exec_module(ma)
ma.STATE_DIR = ${JSON.stringify(dir)}
NOW = [${T0}]
ma.clock = lambda: NOW[0]
CALLS, NOTES, PATCHES, MERGES, ADDS, COMPLETES, REOPENS = [], [], [], [], [], [], []
PENDING = []          # what findings.py list --status pending --json returns
DRY = []              # the dry run's answer per run ("green"); empty means red
GH = {"view": json.dumps({"state": "OPEN", "mergeCommit": None, "headRefOid": "${HEAD}"})}
FIND_RC = [0]
COMPLETE = {"rc": 0, "err": ""}
def sh(args, timeout=120):
    CALLS.append(" ".join(args[:4]))
    if args[:3] == ["gh", "pr", "view"]:
        return subprocess.CompletedProcess(args, 0, GH["view"], "")
    if args[:3] == ["gh", "run", "list"]:
        return subprocess.CompletedProcess(args, 0, json.dumps([{"headSha": "abc123def4567890", "status": "completed", "conclusion": "success", "createdAt": "2026-11-06T10:00:00Z"}]), "")
    return subprocess.CompletedProcess(args, 0, "", "")
def py(script, *args, timeout=300):
    CALLS.append(script + " " + " ".join(args[:2]))
    if script == "agent-dispatch.py" and args[0] == "annotate":
        NOTES.append(args[3])
    if script == "agent-dispatch.py" and args[0] == "complete":
        COMPLETES.append(list(args))
        return subprocess.CompletedProcess([script], COMPLETE["rc"], "", COMPLETE["err"])
    if script == "findings.py" and args[0] == "list":
        return subprocess.CompletedProcess([script], 0, json.dumps(PENDING), "")
    if script == "findings.py" and args[0] == "reopen":
        REOPENS.append(list(args))
        return subprocess.CompletedProcess([script], 0, "reopened " + args[1], "")
    if script == "findings.py" and args[0] == "add":
        ADDS.append(list(args))
        return subprocess.CompletedProcess([script], FIND_RC[0], "20261106-merge-approved-%d" % len(ADDS) if FIND_RC[0] == 0 else "", "queue locked" if FIND_RC[0] else "")
    return subprocess.CompletedProcess([script], 0, "landed 1 finding(s) from PR #812" if script == "findings.py" else "", "")
MERGE_RESULTS = []
def merge_pr(pr, head, dry_run=False):
    MERGES.append([pr, head, dry_run])
    if dry_run:
        if DRY and DRY.pop(0) == "green":
            return subprocess.CompletedProcess(["merge-pr.py"], 0, json.dumps({"merged": False, "dryRun": True, "head": head, "why": "green"}), "")
        return subprocess.CompletedProcess(["merge-pr.py"], 1, json.dumps({"merged": False, "head": head, "why": "the gate is RED"}), "")
    if MERGE_RESULTS and MERGE_RESULTS.pop(0) == "green":
        GH["view"] = json.dumps({"state": "MERGED", "mergeCommit": {"oid": "abc123def4567890"}, "headRefOid": head})
        return subprocess.CompletedProcess(["merge-pr.py"], 0, json.dumps({"merged": True, "why": "merged: green"}), "")
    return subprocess.CompletedProcess(["merge-pr.py"], 1, json.dumps({"merged": False, "why": "the gate is RED"}), "${RED_TAIL}")
ma.sh, ma.py, ma.run_merge_pr = sh, py, merge_pr
REFRESH = {"fail": False, "calls": 0}
def refresh_card(card, head, res):
    REFRESH["calls"] += 1
    if REFRESH["fail"]:
        raise RuntimeError("Airtable 503")
ma.refresh_card = refresh_card
ma.merge_card.patch_card = lambda task, fields: PATCHES.append([task, fields])
ma.merge_card.read_tasks = lambda *a, **k: [{"id": "ctl", "fields": {}}]
ma.time.sleep = lambda s: None
C = lambda **k: dict(json.loads(${JSON.stringify(card())}), **k)
CARDS = [C()]
ma.merge_card.list_cards = lambda read=None: [dict(c) for c in CARDS]
def cmd_run():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = ma.cmd_run(argparse.Namespace(dry_run=False))
    return code, json.loads(buf.getvalue())
def detach_todo():
    STARTED = []
    class P:
        def __init__(self, args, **k): STARTED.append(args); self.pid = 99999999
    real = ma.subprocess.Popen
    ma.subprocess.Popen = P
    try:
        os.path.exists(os.path.join(ma.STATE_DIR, ma.QUEUED_PID)) and os.remove(os.path.join(ma.STATE_DIR, ma.QUEUED_PID))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            ma.cmd_detach(argparse.Namespace())
        return json.loads(buf.getvalue()).get("todo")
    finally:
        ma.subprocess.Popen = real
def att():
    return json.load(open(os.path.join(ma.STATE_DIR, ma.ATTEMPTS)))
def verdict_writes():
    # Any write that moves the card back to his queue or touches his verdict.
    return [f for _, f in PATCHES if set(f) & {"fldx4qCw17UfrKpaN", "fldrHBSr6qoUfaKuZ", "fldr4Mvf2RzKvhZhi"}]
def sent_back():
    # Writes that put the card back in his Approval lane.
    return [f for _, f in PATCHES if f.get("fldx4qCw17UfrKpaN") == "Approval"]
def nothing_runs_lines():
    return [x for x in [json.dumps(p) for p in PATCHES] + NOTES if "nothing runs" in x.lower()]
${prelude}
`);

describe('a red gate never sends an approved MERGE card back, and the robot retries by itself', () => {
  it('THE REGRESSION: two reds on one head, an approval-free retry after the wait, then green merges and closes', () => {
    const r = drive(`
MERGE_RESULTS[:] = ["red", "red", "green"]
steps = []
def step(label, hours):
    NOW[0] = ${T0} + hours * ${HOUR}
    todo = detach_todo()
    code, out = cmd_run()
    steps.append({"label": label, "todo": todo, "code": code, "done": out["done"], "merges": len([m for m in MERGES if not m[2]])})
step("approved", 0)            # red 1
step("half an hour on", 0.5)   # resting
step("six hours on", 6.1)      # red 2, with no new approval
step("seven hours on", 7)      # resting
step("twelve hours on", 12.2)  # green
print(json.dumps({"steps": steps, "completes": COMPLETES, "verdict": verdict_writes(), "nothingRuns": nothing_runs_lines(),
                  "notes": NOTES, "att": att()["812"], "adds": len(ADDS)}))`);
    const [first, rest1, second, rest2, last] = r.steps;
    expect(first.done[0]).toMatchObject({ action: 'merge', result: 'red', retryAt: '2026-11-06T15:00:00Z' });
    expect(first.done[0].backToKevin).toBeUndefined();
    expect(rest1.todo).toEqual([]);                                       // the poll queues nothing while it rests
    expect(rest1.done[0].action).toBe('skip');
    expect(rest1.done[0].why).toMatch(/red 1 of 4 on a1b2c3d4a1b2; his approval stands and the robot tries again by itself after 2026-11-06T15:00:00Z/);
    expect(second.todo).toEqual([812]);                                   // the clock alone queues the retry
    expect(second.done[0]).toMatchObject({ action: 'merge', result: 'red' });
    expect(second.merges).toBe(2);
    expect(rest2.done[0].action).toBe('skip');
    expect(last.done[0]).toMatchObject({ action: 'merge', result: 'merged', sha: 'abc123def4567890' });
    expect(last.merges).toBe(3);
    expect(r.completes).toHaveLength(1);
    expect(r.completes[0][3]).toMatch(/^PR #812 merged as abc123def456/);
    expect(r.verdict).toEqual([]);                                        // never sent back, his verdict never cleared
    expect(r.nothingRuns).toEqual([]);
    expect(r.adds).toBe(0);
    expect(r.notes[0]).toMatch(/^MERGE NOT DONE: merge-pr\.py did not merge PR #812 .*example-page\.spec\.js:486/s);
    expect(r.att.result).toBe('merged');
  });

  it('a newer press of Approve runs at once, within the cap', () => {
    const r = drive(`
a = {"812": {"result": "red", "head": "${HEAD}", "reds": 1, "approvedAt": "2026-11-06T08:30:00.000Z", "at": "2026-11-06T09:00:00Z", "lastRedAt": "2026-11-06T09:00:00Z"}}
NOW[0] = ${T0} + 1800
again = C(approvedAt="2026-11-06T09:20:00.000Z", fields={"fld30Yw8SWYVp049g": ["${BUILDER}"], "fldr4Mvf2RzKvhZhi": "2026-11-06T09:20:00.000Z"})
print(json.dumps([ma.plan(C(), a)[0], ma.plan(again, a)[0]]))`);
    expect(r).toEqual(['skip', 'merge']);
  });

  it('four reds on one head: it stops, files ONE finding that quotes the gate and does not blame the PR, and rests out of his queue', () => {
    const r = drive(`
MERGE_RESULTS[:] = []
for i in range(6):
    NOW[0] = ${T0} + i * 6.5 * ${HOUR}
    cmd_run()
rest = ma.plan(C(), att())
todo = detach_todo()
print(json.dumps({"gates": len(MERGES), "adds": ADDS, "att": att()["812"], "rest": rest, "todo": todo,
                  "verdict": verdict_writes(), "nothingRuns": nothing_runs_lines(), "last": NOTES[-1]}))`);
    expect(r.gates).toBe(4);                                              // the 5th and 6th runs ran no gate
    expect(r.adds).toHaveLength(1);
    const detail = r.adds[0][r.adds[0].indexOf('--detail') + 1];
    const fix = r.adds[0][r.adds[0].indexOf('--fix') + 1];
    expect(detail).toContain('example-page.spec.js:486');                 // the failing gate lines
    expect(detail).toMatch(/is not known here: read the gate lines/);
    expect(fix).toMatch(/If they are tests the PR does not touch, fix main/);
    expect(r.adds[0].slice(r.adds[0].indexOf('--holds-merge-pr'), r.adds[0].indexOf('--holds-merge-pr') + 2)).toEqual(['--holds-merge-pr', '812']);
    expect(r.att).toMatchObject({ result: 'red', reds: 4, head: HEAD, finding: '20261106-merge-approved-1' });
    expect(r.rest[0]).toBe('skip');
    expect(r.rest[1]).toMatch(/^resting: the gate failed 4 times on a1b2c3d4a1b2/);
    expect(r.todo).toEqual([]);
    expect(r.verdict).toEqual([]);
    expect(r.nothingRuns).toEqual([]);
    expect(r.last).toMatch(/stopped retrying it \(20261106-merge-approved-1\)\. The card rests out of Kevin's queue until the PR's head changes/);
  });

  it('a finding that would not file at the 4th red is filed by the next run, once', () => {
    const r = drive(`
FIND_RC[0] = 1
for i in range(4):
    NOW[0] = ${T0} + i * 6.5 * ${HOUR}
    cmd_run()
p1 = ma.plan(C(), att())[0]
FIND_RC[0] = 0
_, out = cmd_run()
_, out2 = cmd_run()
print(json.dumps({"p1": p1, "act": out["done"][0], "again": out2["done"][0]["action"], "adds": len(ADDS), "gates": len(MERGES)}))`);
    expect(r.p1).toBe('file-finding');
    expect(r.act).toMatchObject({ action: 'file-finding', result: 'finding-filed' });
    expect(r.again).toBe('skip');
    expect(r.adds).toBe(2);                                               // the failed try, then the one that filed
    expect(r.gates).toBe(4);
  });

  it('a resting card whose PR moved goes through changed(): new code re-tested GREEN and refreshed goes back to Kevin for it', () => {
    const r = drive(`
a = {"812": {"result": "red", "head": "${HEAD}", "reds": 4, "finding": "20261106-merge-approved-1", "approvedAt": "2026-11-06T08:30:00.000Z", "at": "2026-11-06T09:00:00Z"}}
ma.save_attempts(a)
GH["view"] = json.dumps({"state": "OPEN", "mergeCommit": None, "headRefOid": "${NEWHEAD}"})
DRY[:] = ["green"]
_, out = cmd_run()
print(json.dumps({"done": out["done"][0], "merges": MERGES, "back": [f for _, f in PATCHES if "fldx4qCw17UfrKpaN" in f]}))`);
    expect(r.merges).toEqual([[812, NEWHEAD, true]]);
    expect(r.done.result).toBe('error');
    expect(r.back[0]).toMatchObject({ fldx4qCw17UfrKpaN: 'Approval', fldrHBSr6qoUfaKuZ: null });
  });
});

const NEWHEAD2 = '9a8b7c6d'.repeat(5);

describe('a moved PR whose new code is not a green, refreshed card is never sent back (14 Nov 2026)', () => {
  it('THE LOOP: a red dry run on the new head rests, re-tests by itself 6 hours apart, stops after 4 with ONE finding, and a further push starts again', () => {
    const r = drive(`
GH["view"] = json.dumps({"state": "OPEN", "mergeCommit": None, "headRefOid": "${NEWHEAD}"})
steps = []
def step(label, hours):
    NOW[0] = ${T0} + hours * ${HOUR}
    todo = detach_todo()
    code, out = cmd_run()
    steps.append({"label": label, "todo": todo, "done": out["done"][0], "dry": len([m for m in MERGES if m[2]])})
step("approved, PR moved", 0)      # try 1
step("half an hour on", 0.5)       # resting
step("six hours on", 6.1)          # try 2
step("twelve hours on", 12.2)      # try 3
step("eighteen hours on", 18.3)    # try 4: stop finding
step("a day on", 24.4)             # rests: no 5th re-test
a4 = att()["812"]
GH["view"] = json.dumps({"state": "OPEN", "mergeCommit": None, "headRefOid": "${NEWHEAD2}"})
step("pushed again", 24.9)         # a new head: re-tested at once, count starts again
print(json.dumps({"steps": steps, "sentBack": sent_back(), "verdict": verdict_writes(), "adds": ADDS, "a4": a4,
                  "att": att()["812"], "notes": NOTES, "merges": [m for m in MERGES if not m[2]]}))`);
    const [s1, rest, s2, s3, s4, rest2, s5] = r.steps;
    expect(s1.done).toMatchObject({ action: 'merge', result: 'moved', retryAt: '2026-11-06T15:00:00Z' });
    expect(s1.done.backToKevin).toBeUndefined();
    expect(rest.todo).toEqual([]);
    expect(rest.done.action).toBe('skip');
    expect(rest.done.why).toMatch(/moved to f0e1d2c3f0e1 .* re-test 1 of 4 .* re-tests by itself after 2026-11-06T15:00:00Z/);
    expect(s2.todo).toEqual([812]);
    expect([s2.dry, s3.dry, s4.dry]).toEqual([2, 3, 4]);
    expect(s4.done.stopped).toBe(true);
    expect(rest2.todo).toEqual([]);
    expect(rest2.done.why).toMatch(/^resting: the PR moved to f0e1d2c3f0e1 and that code failed 4 re-tests/);
    expect(rest2.dry).toBe(4);                                            // no 5th re-test
    expect(r.adds).toHaveLength(1);                                       // ONE stop finding
    const a = r.adds[0];
    expect(a[a.indexOf('--title') + 1]).toMatch(/^PR #812's new code failed 4 re-tests/);
    expect(a[a.indexOf('--detail') + 1]).toMatch(/new code \(head f0e1d2c3f0e1\)/);
    expect(a.slice(a.indexOf('--holds-merge-pr'), a.indexOf('--holds-merge-pr') + 2)).toEqual(['--holds-merge-pr', '812']);
    expect(r.a4).toMatchObject({ result: 'moved', newHead: NEWHEAD, movedTries: 4, finding: '20261106-merge-approved-1' });
    expect(s5.done).toMatchObject({ result: 'moved' });
    expect(s5.dry).toBe(5);
    expect(r.att).toMatchObject({ newHead: NEWHEAD2, movedTries: 1 });
    expect(r.att.finding).toBeUndefined();
    expect(r.sentBack).toEqual([]);                                       // never back in his lane
    expect(r.verdict).toEqual([]);
    expect(r.merges).toEqual([]);                                         // nothing merged on an old approval
    expect(r.notes[0]).toMatch(/^MERGE NOT DONE: PR #812 changed .* is not green.* the card is not sent back .* \(try 1 of 4/s);
  });

  it('green but the card refresh failed rests too; an unreadable head rests on the same clock', () => {
    const r = drive(`
GH["view"] = json.dumps({"state": "OPEN", "mergeCommit": None, "headRefOid": "${NEWHEAD}"})
DRY[:] = ["green"]
REFRESH["fail"] = True
_, out = cmd_run()
NOW[0] = ${T0} + 1800
p_rest = ma.plan(dict(C(), prState="OPEN", prHead="${NEWHEAD}"), att())
# An unreadable head (the merge-time read gave none): a moved try keyed on "", never sent back.
import tempfile
ma.STATE_DIR = tempfile.mkdtemp()
GH["view"] = json.dumps({"state": "OPEN", "mergeCommit": None, "headRefOid": ""})
res = ma.merge_one(C(), {})
p2 = ma.plan(dict(C(), prReadError="gh down"), att())
print(json.dumps({"done": out["done"][0], "refresh": REFRESH["calls"], "rest": p_rest, "unread": res, "p2": p2,
                  "sentBack": sent_back(), "att": att()["812"]}))`);
    expect(r.refresh).toBe(1);
    expect(r.done).toMatchObject({ result: 'moved' });
    expect(r.done.why).toMatch(/Re-tested green, but the card could not be refreshed: Airtable 503/);
    expect(r.rest[0]).toBe('skip');
    expect(r.unread).toMatchObject({ result: 'moved' });
    expect(r.unread.why).toMatch(/The new head could not be read/);
    expect(r.att).toMatchObject({ newHead: '', movedTries: 1 });
    expect(r.p2[0]).toBe('skip');                                         // rests on the clock, not every half hour
    expect(r.sentBack).toEqual([]);
  });

  it('once the card carries the new head, its own verdict decides (the moved record no longer rests it)', () => {
    const r = drive(`
a = {"812": {"result": "moved", "head": "${HEAD}", "newHead": "${NEWHEAD}", "movedTries": 4, "finding": "f1", "lastMovedAt": "2026-11-06T09:00:00Z", "at": "2026-11-06T09:00:00Z", "approvedAt": "2026-11-06T08:30:00.000Z"}}
refreshed = C(head="${NEWHEAD}", agentOutput=${JSON.stringify(OUTPUT)}.replace("${HEAD}", "${NEWHEAD}"), prState="OPEN", prHead="${NEWHEAD}")
print(json.dumps(ma.plan(refreshed, a)))`);
    expect(r).toEqual(['merge', 'approved']);
  });
});

describe('a card whose PR was closed without merging is closed by the robot, once, never sent back (14 Nov 2026)', () => {
  const closedRun = (cardOver) => drive(`
CARDS[:] = [C(${cardOver})]
GH["view"] = json.dumps({"state": "CLOSED", "mergeCommit": None, "headRefOid": "${HEAD}"})
PENDING[:] = [{"id": "20261101-agent-dispatch-901", "status": "pending", "pr": "812"},
              {"id": "20261101-agent-dispatch-902", "status": "pending", "pr": "799"}]
todo1 = detach_todo()
code, out = cmd_run()
todo2 = detach_todo()
_, out2 = cmd_run()
print(json.dumps({"todo1": todo1, "todo2": todo2, "code": code, "done": out["done"][0], "again": out2["done"][0],
                  "patches": PATCHES, "notes": NOTES, "reopens": REOPENS, "att": att()["812"], "merges": MERGES,
                  "completes": COMPLETES, "sentBack": sent_back()}))`);

  for (const [label, over] of [['approved', ''], ['waiting for Kevin', 'status="Approval", outcome="", approvedAt=""']]) {
    it(`${label}: the card is closed with a plain dated note, its pending findings go back to the queue, and nothing is sent back`, () => {
      const r = closedRun(over);
      expect(r.todo1).toEqual([812]);
      expect(r.done).toMatchObject({ action: 'close-unmerged', result: 'closed-unmerged', reopened: ['20261101-agent-dispatch-901'] });
      expect(r.code).toBe(0);
      expect(r.patches).toHaveLength(1);
      const f = r.patches[0][1];
      expect(f.fldx4qCw17UfrKpaN).toBe('Completed');
      expect(f.fldFOi1SwEKuJRmdN).toMatch(/^2026-11-06T09:00:00Z$/);
      expect(Object.keys(f).sort()).toEqual(['fldFOi1SwEKuJRmdN', 'fldx4qCw17UfrKpaN']);   // no verdict, no Approved At
      expect(r.sentBack).toEqual([]);
      expect(r.completes).toEqual([]);                                    // no forged merge evidence
      expect(r.merges).toEqual([]);
      expect(r.reopens).toEqual([['reopen', '20261101-agent-dispatch-901', '--force', '--note',
        'PR #812 was closed on GitHub without merging, so this fix never landed; back in the queue.']]);
      expect(r.notes).toEqual(['PR CLOSED, NOT MERGED: PR #812 was closed on GitHub without merging, so nothing was merged. '
        + 'The robot closed this card; there is nothing to approve. Its pending finding(s) went back to the fixer\'s queue: 20261101-agent-dispatch-901.']);
      expect(r.att).toMatchObject({ result: 'closed-unmerged', head: HEAD, reopened: ['20261101-agent-dispatch-901'] });
      expect(r.todo2).toEqual([]);                                        // once
      expect(r.again.action).toBe('skip');
    });
  }

  it('a PR closed between the live read and the merge is closed the same way, never failed back to Kevin', () => {
    const r = drive(`
GH["view"] = json.dumps({"state": "CLOSED", "mergeCommit": None, "headRefOid": "${HEAD}"})
res = ma.merge_one(C(), {})
def bad_patch(task, fields): raise RuntimeError("Airtable 503")
ma.merge_card.patch_card = bad_patch
res2 = ma.merge_one(C(), {})
print(json.dumps({"res": res, "res2": res2, "sentBack": sent_back(), "merges": MERGES}))`);
    expect(r.res.result).toBe('closed-unmerged');
    expect(r.res2).toMatchObject({ result: 'error' });
    expect(r.res2.backToKevin).toBeUndefined();                          // a failed close never tries a send-back
    expect(r.sentBack).toEqual([]);
    expect(r.merges).toEqual([]);
  });

  it('a card close that fails is not recorded, so the next run tries again; findings already reopened are not reopened twice', () => {
    const r = drive(`
GH["view"] = json.dumps({"state": "CLOSED", "mergeCommit": None, "headRefOid": "${HEAD}"})
PENDING[:] = [{"id": "20261101-agent-dispatch-901", "status": "pending", "pr": "812"}]
def bad_patch(task, fields): raise RuntimeError("Airtable 503")
good = ma.merge_card.patch_card
ma.merge_card.patch_card = bad_patch
_, out = cmd_run()
p = ma.plan(dict(C(), prState="CLOSED", prHead="${HEAD}"), json.load(open(os.path.join(ma.STATE_DIR, ma.ATTEMPTS))) if os.path.exists(os.path.join(ma.STATE_DIR, ma.ATTEMPTS)) else {})
ma.merge_card.patch_card = good
PENDING[:] = []
_, out2 = cmd_run()
print(json.dumps({"first": out["done"][0], "plan": p[0], "second": out2["done"][0], "reopens": len(REOPENS)}))`);
    expect(r.first).toMatchObject({ result: 'error' });
    expect(r.plan).toBe('close-unmerged');
    expect(r.second).toMatchObject({ result: 'closed-unmerged', reopened: [] });
    expect(r.reopens).toBe(1);
  });
});

describe('a card whose PR is already merged never waits on Kevin for a merge', () => {
  it('no verdict: findings land, the real close is tried, and when complete refuses, the card says Approve only closes it, once', () => {
    const r = drive(`
CARDS[:] = [C(status="Approval", outcome="", approvedAt="", fields={"fld30Yw8SWYVp049g": ["${BUILDER}"]})]
GH["view"] = json.dumps({"state": "MERGED", "mergeCommit": {"oid": "abc123def4567890"}, "headRefOid": "${HEAD}"})
COMPLETE.update(rc=1, err="ERROR: refusing to complete recCardAaaaaaaaaa — outcome is 'empty', not an approval.")
todo1 = detach_todo()
_, out = cmd_run()
todo2 = detach_todo()
_, out2 = cmd_run()
lands = [c for c in CALLS if c.startswith("findings.py land")]
# Kevin approves: the run closes it with the merge commit.
CARDS[:] = [C(approvedAt="2026-11-06T10:00:00.000Z", fields={"fld30Yw8SWYVp049g": ["${BUILDER}"], "fldr4Mvf2RzKvhZhi": "2026-11-06T10:00:00.000Z"})]
COMPLETE.update(rc=0, err="")
_, out3 = cmd_run()
print(json.dumps({"todo1": todo1, "todo2": todo2, "done": out["done"][0], "again": out2["done"][0], "lands": len(lands),
                  "patches": PATCHES, "verdict": verdict_writes(), "notes": NOTES, "completes": COMPLETES,
                  "closed": out3["done"][0], "merges": MERGES}))`);
    expect(r.todo1).toEqual([812]);
    expect(r.done).toMatchObject({ action: 'close-merged', result: 'merged-noted', sha: 'abc123def4567890' });
    expect(r.completes[0][3]).toMatch(/^PR #812 merged as abc123def456 \(already merged on GitHub/);
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0][1].fld3PrM8AJcnWHemG).toMatch(/IF YOU APPROVE: the robot closes this card with the merge commit\. Nothing is merged or run\./);
    expect(r.verdict).toEqual([]);                                        // never writes a verdict or Approved At
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^MERGED OUTSIDE THIS CARD: PR #812 is merged on GitHub as abc123def456/);
    expect(r.todo2).toEqual([]);                                          // noted once: nothing more queued
    expect(r.again.action).toBe('skip');
    expect(r.closed).toMatchObject({ action: 'merge', result: 'merged' });
    expect(r.completes).toHaveLength(2);
    expect(r.merges).toEqual([]);                                         // merge-pr.py never runs on a merged PR
  });

  it('if complete accepts the merge evidence, the card closes with no Kevin step at all', () => {
    const r = drive(`
CARDS[:] = [C(status="Approval", outcome="", approvedAt="")]
GH["view"] = json.dumps({"state": "MERGED", "mergeCommit": {"oid": "abc123def4567890"}, "headRefOid": "${HEAD}"})
_, out = cmd_run()
print(json.dumps({"done": out["done"][0], "patches": PATCHES, "att": att()["812"]}))`);
    expect(r.done.result).toBe('merged');
    expect(r.patches).toEqual([]);
    expect(r.att.result).toBe('merged');
  });

  it('the REAL agent-dispatch.py complete refuses an unapproved MERGE card even with merge evidence (so it is noted, never forged)', () => {
    const r = run(`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("d", ${JSON.stringify(S('agent-dispatch.py'))})
d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
AF = d.AF
rec = {"id": "recCardAaaaaaaaaa", "createdTime": "2026-11-06T08:00:00.000Z", "fields": {AF["name"]: "MERGE: PR #812 — fix", AF["status"]: "Approval", AF["agentOutput"]: ${JSON.stringify(OUTPUT)}}}
d.get_task = lambda i: rec
W = []
d.patch_task = lambda i, f: W.append(f)
class A:
    task = "recCardAaaaaaaaaa"; evidence = "PR #812 merged as abc123def4567890 (already merged on GitHub)."; keep_open = False; note = ""
try:
    d.cmd_complete(A()); err = None
except SystemExit as e:
    err = str(e)
print(json.dumps({"err": err, "writes": W}))`);
    expect(r.err).toMatch(/refusing to complete recCardAaaaaaaaaa — outcome is 'empty', not an approval/);
    expect(r.writes).toEqual([]);
  });
});

describe('attempts.json from before 13 Nov 2026 reads sensibly', () => {
  it('the live shape (red, reds 2, back true) never re-sends the card back, and his next approval runs at once', () => {
    const r = drive(`
legacy = {"812": {"result": "red", "approvedAt": "2026-11-06T08:30:00.000Z", "at": "2026-11-12T09:00:00Z", "back": True, "head": "${HEAD}", "reds": 2},
          "700": {"result": "red", "approvedAt": "2026-10-07T09:00:00.000Z", "at": "x", "back": True},
          "701": {"result": "merged", "sha": "abc", "approvedAt": "y", "at": "z"},
          "702": {"result": "red", "reds": "two", "head": "${HEAD}", "at": None}}
ma.save_attempts(legacy)
NOW[0] = ${T0} + 7 * 24 * ${HOUR}
waiting = C(status="Approval", outcome="", approvedAt="")
CARDS[:] = [waiting]
_, out = cmd_run()
plans = [ma.plan(C(pr=700, name="MERGE: PR #700 — x", agentOutput=${JSON.stringify(OUTPUT)}.replace("#812", "#700")), legacy)[0],
         ma.plan(C(pr=701, name="MERGE: PR #701 — x", agentOutput=${JSON.stringify(OUTPUT)}.replace("#812", "#701")), legacy)[0],
         ma.plan(C(pr=702, name="MERGE: PR #702 — x", agentOutput=${JSON.stringify(OUTPUT)}.replace("#812", "#702")), legacy)[0]]
# He approves again (the 34th press): it runs now, red 3 of 4, and stays approved.
CARDS[:] = [C(approvedAt="2026-11-13T09:00:00.000Z", fields={"fld30Yw8SWYVp049g": ["${BUILDER}"], "fldr4Mvf2RzKvhZhi": "2026-11-13T09:00:00.000Z"})]
_, out2 = cmd_run()
print(json.dumps({"waiting": out["done"][0], "plans": plans, "run": out2["done"][0], "verdict": verdict_writes(),
                  "att": att()["812"], "nothingRuns": nothing_runs_lines()}))`);
    expect(r.waiting).toMatchObject({ action: 'skip', why: 'waiting for Kevin' });
    expect(r.plans).toEqual(['merge', 'merge', 'merge']);                 // no head, a merged record, unreadable reds: no crash, no send-back
    expect(r.run).toMatchObject({ action: 'merge', result: 'red' });
    expect(r.att).toMatchObject({ reds: 3, head: HEAD, back: false });
    expect(r.verdict).toEqual([]);
    expect(r.nothingRuns).toEqual([]);
  });

  it('the needs-session action and its "nothing runs" line are gone', () => {
    const r = drive(`print(json.dumps([hasattr(ma, n) for n in ("SESSION_APPROVE", "SESSION_TASK", "RED_LIMIT")]))`);
    expect(r).toEqual([false, false, false]);
  });
});

describe('the dispatcher leaves an approved MERGE card at Today alone for days', () => {
  it('the real build_queue lists it under mergeCards, never as agent work or an idle hand-back, and held_card_problem names it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-ma-q-'));
    const r = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json, sys, os, urllib.request
def boom(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = boom
spec = importlib.util.spec_from_file_location('d', ${JSON.stringify(S('agent-dispatch.py'))})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.STATE_DIR = ${JSON.stringify(dir)}
m.INTENT_LEDGER = os.path.join(${JSON.stringify(dir)}, "carryout-intent.jsonl")
AF = m.AF
f = {AF["name"]: "MERGE: PR #812 — fix: retype", AF["status"]: {"name": "Today"}, AF["teamMember"]: ["${BUILDER}"],
     AF["sentForApprovalBy"]: ["${BUILDER}"], AF["approvalOutcome"]: {"name": "Approved as-is"},
     AF["approvedAt"]: "2026-11-06T08:30:00.000Z", AF["agentOutput"]: ${JSON.stringify(OUTPUT)},
     AF["notes"]: "[x — merge-approved] MERGE NOT DONE: red 3 of 4."}
TASKS = [{"id": "recCardAaaaaaaaaa", "fields": f}]
m.query_tasks = lambda formula, **kw: list(TASKS)
m.fetch_role_roster = lambda: {}
m.ledger_append("recCardAaaaaaaaaa", "parked")
q = m.build_queue()
lists = {k: [t["id"] for t in v] for k, v in q.items() if isinstance(v, list) and v and isinstance(v[0], dict) and "id" in v[0]}
print(json.dumps({"lists": lists, "held": m.held_card_problem(f)}))`], { encoding: 'utf8',
      env: { ...process.env, OD_HOLDS_FILE: resolve(ROOT, 'tests/does-not-exist-holds.json') } }).trim().split('\n').pop());
    expect(r.lists).toEqual({ mergeCards: ['recCardAaaaaaaaaa'] });
    expect(r.held).toMatch(/it is a MERGE card/);
  });
});
