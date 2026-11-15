import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const S = (f) => resolve(ROOT, 'scripts', f);

// THE MERGE CARD ROBOT, AFTER ITS INDEPENDENT REVIEW (15 Nov 2026). An outside review reproduced a set
// of faults in scripts/merge-approved.py on the real functions. Each test below drives the REAL plan,
// merge_one, cmd_run, cmd_detach, refresh_card and fail, with GitHub, Airtable and the sub-commands
// stubbed: the cards live in CARDS and every write to them is APPLIED there, so a later run reads what
// an earlier one wrote, the way Airtable would. The network is switched off. Every name, PR number,
// record id and date is invented (this repo is public). The numbers in the test names are the review's.
const run = (code) => JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8' }).trim().split('\n').pop());
const HEAD = 'a1b2c3d4'.repeat(5);
const NEWHEAD = 'f0e1d2c3'.repeat(5);
const BUILDER = 'recQkO6BA4w5zqwZ4';
const OUTPUT = `MERGE CARD: PR #812, fix: retype\nhttps://example.test/pull/812\nTested head: ${HEAD}\n\n**Carrying this out will involve:** If you approve, the robot runs merge-pr.py and the deploy, nothing else.`;
const T0 = 1793955600; // 2026-11-06T09:00:00Z
const HOUR = 3600;
const title = (add) => add[add.indexOf('--title') + 1];

const drive = (prelude, dir = mkdtempSync(join(tmpdir(), 'od-ma-review-'))) => run(`
import importlib.util, json, sys, os, io, contextlib, argparse, subprocess, urllib.request
def _no_network(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = _no_network
sys.path.insert(0, ${JSON.stringify(S(''))})
import findings
findings.current_state = lambda *a, **k: {}
spec = importlib.util.spec_from_file_location("ma", ${JSON.stringify(S('merge-approved.py'))})
ma = importlib.util.module_from_spec(spec); spec.loader.exec_module(ma)
MC = ma.merge_card
ma.STATE_DIR = ${JSON.stringify(dir)}
NOW = [${T0}]
ma.clock = lambda: NOW[0]
NOTES, MERGES, ADDS, COMPLETES, REOPENS, WRITES = [], [], [], [], [], []
PENDING = []
LIST_RC = [0]
FIND_RC = [0]
COMPLETE_RC = [0]
GH_DOWN = [False]
GH = {}                   # per PR: state, head, mergeCommit
def gh(pr):
    return GH.setdefault(int(pr), {"state": "OPEN", "mergeCommit": None, "headRefOid": "${HEAD}"})
def sh(args, timeout=120):
    if args[:3] == ["gh", "pr", "view"]:
        if GH_DOWN[0]:
            return subprocess.CompletedProcess(args, 1, "", "HTTP 502: invented outage")
        return subprocess.CompletedProcess(args, 0, json.dumps(dict(gh(args[3]), title="fix: retype",
                                           url="https://example.test/pull/%s" % args[3], files=[{"path": "scripts/example.py"}])), "")
    if args[:3] == ["gh", "run", "list"]:
        return subprocess.CompletedProcess(args, 0, json.dumps([{"headSha": "abc123def4567890", "status": "completed", "conclusion": "success", "createdAt": "2026-11-06T10:00:00Z"}]), "")
    return subprocess.CompletedProcess(args, 0, "", "")
def py(script, *args, timeout=300):
    if script == "agent-dispatch.py" and args[0] == "annotate":
        if KILL["at"] == 0:
            raise SystemExit("killed before the first write (invented)")
        NOTES.append(args[3])
        after_write("annotate")
    if script == "agent-dispatch.py" and args[0] == "complete":
        COMPLETES.append(list(args))
        return subprocess.CompletedProcess([script], COMPLETE_RC[0], "", "refused (invented)" if COMPLETE_RC[0] else "")
    if script == "findings.py" and args[0] == "list":
        return subprocess.CompletedProcess([script], LIST_RC[0], json.dumps(PENDING), "queue unreadable (invented)" if LIST_RC[0] else "")
    if script == "findings.py" and args[0] == "reopen":
        REOPENS.append(args[1])
        PENDING[:] = [p for p in PENDING if p["id"] != args[1]]
        return subprocess.CompletedProcess([script], 0, "reopened " + args[1], "")
    if script == "findings.py" and args[0] == "add":
        ADDS.append(list(args))
        ok = FIND_RC[0] == 0
        return subprocess.CompletedProcess([script], FIND_RC[0], "20261106-merge-approved-%03d" % len(ADDS) if ok else "", "" if ok else "queue locked")
    return subprocess.CompletedProcess([script], 0, "landed 1 finding(s)" if script == "findings.py" else "", "")
MERGE_RESULTS = []        # per REAL merge-pr.py run: "green", or (exit, json, stderr)
DRY = []                  # per dry run: "green", else red
def merge_pr(pr, head, dry_run=False):
    MERGES.append([pr, head[:8], "dry" if dry_run else "REAL"])
    if dry_run:
        if DRY and DRY.pop(0) == "green":
            return subprocess.CompletedProcess(["merge-pr.py"], 0, json.dumps({"merged": False, "dryRun": True, "head": head, "why": "green"}), "")
        return subprocess.CompletedProcess(["merge-pr.py"], 1, json.dumps({"merged": False, "head": head, "why": "the test gate is RED", "vitest": {"ok": False}}), "")
    nxt = MERGE_RESULTS.pop(0) if MERGE_RESULTS else "green"
    if nxt == "green":
        gh(pr).update(state="MERGED", mergeCommit={"oid": "abc123def4567890"})
        return subprocess.CompletedProcess(["merge-pr.py"], 0, json.dumps({"merged": True, "why": "merged: green"}), "")
    return subprocess.CompletedProcess(["merge-pr.py"], nxt[0], nxt[1], nxt[2])
ma.sh, ma.py, ma.run_merge_pr = sh, py, merge_pr
ma.time.sleep = lambda s: None
MC.read_tasks = lambda *a, **k: [{"id": "ctl", "fields": {}}]
BASE = ${JSON.stringify({ name: 'MERGE: PR #812 — fix', pr: 812, status: 'Today', outcome: 'Approved as-is',
    approvedAt: '2026-11-06T08:30:00.000Z', feedback: '', notes: '', agentOutput: OUTPUT, head: HEAD, findings: [],
    fields: { fld30Yw8SWYVp049g: [BUILDER], fldr4Mvf2RzKvhZhi: '2026-11-06T08:30:00.000Z' },
    createdTime: '2026-11-06T08:00:00.000Z' })}
def C(id="recCardAaaaaaaaaa", pr=812, **k):
    c = json.loads(json.dumps(BASE))
    c.update(id=id, pr=pr, name="MERGE: PR #%d — fix" % pr, agentOutput=BASE["agentOutput"].replace("#812", "#%d" % pr))
    c.update(k)
    if "approvedAt" in k:
        c["fields"]["fldr4Mvf2RzKvhZhi"] = k["approvedAt"]
    return c
CARDS = [C()]
KILL = {"at": None}       # kill the run (SystemExit) right AFTER write number N lands; 0 = before the first
def after_write(kind):
    WRITES.append(kind)
    if KILL["at"] is not None and len(WRITES) >= KILL["at"]:
        raise SystemExit("killed after write %d, %s (invented)" % (len(WRITES), kind))
def apply(card, fields):
    F = MC.F
    if F["agentOutput"] in fields:
        card["agentOutput"] = fields[F["agentOutput"]]
        m = MC.HEAD_RE.search(card["agentOutput"] or "")
        card["head"] = m.group(1) if m else ""
    if F["approvalOutcome"] in fields:
        card["outcome"] = fields[F["approvalOutcome"]] or ""
    if F["approvedAt"] in fields:
        card["approvedAt"] = fields[F["approvedAt"]] or ""
        card["fields"]["fldr4Mvf2RzKvhZhi"] = fields[F["approvedAt"]]
    if F["approvalFeedback"] in fields:
        card["feedback"] = fields[F["approvalFeedback"]] or ""
    if F["status"] in fields:
        card["status"] = fields[F["status"]]
PATCH_FAIL = [None]      # the Nth card write of the run fails (Airtable 503); True = every one
PATCH_N = [0]
PATCHES = []
def patch_card(task, fields):
    if KILL["at"] == 0:
        raise SystemExit("killed before the first write (invented)")
    PATCH_N[0] += 1
    if PATCH_FAIL[0] is True or PATCH_FAIL[0] == PATCH_N[0]:
        raise RuntimeError("Airtable 503 (invented)")
    PATCHES.append([task, dict(fields)])
    for c in CARDS:
        if c["id"] == task:
            apply(c, fields)
    after_write("patch")
MC.patch_card = patch_card
REAL_SAVE = ma.save_attempts
def save_attempts(att):
    if KILL["at"] == 0:
        raise SystemExit("killed before the first write (invented)")
    REAL_SAVE(att)
    after_write("attempts")
ma.save_attempts = save_attempts
MC.list_cards = lambda read=None: [json.loads(json.dumps(c)) for c in CARDS]
def get_card(task):
    for c in CARDS:
        if c["id"] == task:
            return json.loads(json.dumps(c))
    raise RuntimeError("Airtable 404 (invented)")
MC.get_card = get_card
def cmd_run():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
        code = ma.cmd_run(argparse.Namespace(dry_run=False))
    return code, json.loads(buf.getvalue())
def detach():
    class P:
        def __init__(self, args, **k): self.pid = 99999999
    real = ma.subprocess.Popen
    ma.subprocess.Popen = P
    try:
        p = os.path.join(ma.STATE_DIR, ma.QUEUED_PID)
        os.path.exists(p) and os.remove(p)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            code = ma.cmd_detach(argparse.Namespace())
        return code, json.loads(buf.getvalue())
    finally:
        ma.subprocess.Popen = real
def att():
    p = os.path.join(ma.STATE_DIR, ma.ATTEMPTS)
    return json.load(open(p)) if os.path.exists(p) else {}
def at(hours):
    NOW[0] = ${T0} + hours * ${HOUR}
def real_merges(head=None):
    return [m for m in MERGES if m[2] == "REAL" and (head is None or m[1] == head[:8])]
def title(add):
    return add[add.index("--title") + 1]
${prelude}
`);

describe('1: a moved card is refreshed and sent back in ONE write, so no crash merges the new head on the old approval', () => {
  it('a kill after every write, a failed write, and an unreadable attempts.json: the new head never merges until Kevin approves it', () => {
    const r = drive(`
out = {}
for kill in (0, 1, 2, 3, None):
    for corrupt in (False, True):
        for fail_write in ((None, 1, 2) if kill is None else (None,)):
            import tempfile
            ma.STATE_DIR = tempfile.mkdtemp(prefix="od-ma-review-kill-")
            CARDS[:] = [C()]
            GH.clear(); gh(812).update(headRefOid="${NEWHEAD}")   # he approved HEAD; the PR moved to NEWHEAD
            MERGES[:] = []; WRITES[:] = []; DRY[:] = ["green"] * 10; MERGE_RESULTS[:] = []; PATCH_N[0] = 0
            KILL["at"] = kill; PATCH_FAIL[0] = fail_write
            at(0)
            try:
                cmd_run()
            except SystemExit:
                pass
            KILL["at"] = None; PATCH_FAIL[0] = None
            for i in range(1, 5):          # later runs, each past any rest
                if corrupt:
                    open(os.path.join(ma.STATE_DIR, ma.ATTEMPTS), "w").write("{ truncated")
                at(i * 7)
                cmd_run()
            key = "kill=%s corrupt=%s failwrite=%s" % (kill, corrupt, fail_write)
            out[key] = {"newHeadMerged": len(real_merges("${NEWHEAD}")), "card": [CARDS[0]["head"][:8], CARDS[0]["outcome"], CARDS[0]["approvedAt"]]}
# THE CONTROL: the harness CAN merge the new head, once Kevin approves the card that shows it.
CARDS[0].update(outcome="Approved as-is", approvedAt="2026-11-07T12:00:00.000Z", status="Today")
CARDS[0]["fields"]["fldr4Mvf2RzKvhZhi"] = "2026-11-07T12:00:00.000Z"
at(40)
cmd_run()
print(json.dumps({"runs": out, "control": len(real_merges("${NEWHEAD}"))}))`);
    const merged = Object.entries(r.runs).filter(([, v]) => v.newHeadMerged).map(([k]) => k);
    expect(merged).toEqual([]);                               // no ordering merges the new head on the old approval
    for (const [key, v] of Object.entries(r.runs)) {
      // the card shows either the old head WITH his approval, or the new head with NO verdict
      if (v.card[0] === NEWHEAD.slice(0, 8)) expect([v.card[1], v.card[2]], key).toEqual(['', '']);
      else expect(v.card, key).toEqual([HEAD.slice(0, 8), 'Approved as-is', '2026-11-06T08:30:00.000Z']);
    }
    expect(Object.keys(r.runs)).toHaveLength(14);
    expect(r.control).toBe(1);
  });

  it('the REAL refresh_card writes the new body, plain lines, cleared verdict, cleared Approved At and Status Approval in one PATCH', () => {
    const r = drive(`
gh(812).update(headRefOid="${NEWHEAD}")
DRY[:] = ["green"]
code, out = cmd_run()
print(json.dumps({"code": code, "done": out["done"][0], "patches": PATCHES, "card": CARDS[0], "att": att()["812"],
                  "problem": MC.card_body_problem(CARDS[0])}))`);
    expect(r.code).toBe(0);
    expect(r.done).toMatchObject({ action: 'merge', result: 'refreshed', backToKevin: true });
    expect(r.patches).toHaveLength(1);
    const f = r.patches[0][1];
    expect(Object.keys(f).sort()).toEqual(['fld3PrM8AJcnWHemG', 'fldr4Mvf2RzKvhZhi', 'fldrHBSr6qoUfaKuZ', 'fldx4qCw17UfrKpaN', 'fldzswp8fx6PqpLQ5'].sort());
    expect(f).toMatchObject({ fldx4qCw17UfrKpaN: 'Approval', fldrHBSr6qoUfaKuZ: null, fldr4Mvf2RzKvhZhi: null });
    expect(f.fldzswp8fx6PqpLQ5).toContain(`Tested head: ${NEWHEAD}`);
    expect(f.fld3PrM8AJcnWHemG).toMatch(/IF YOU APPROVE: the robot runs merge-pr\.py on PR #812 at head f0e1d2c3f0e1/);
    expect(r.problem).toBe('');                               // still a whole MERGE card
    expect(r.att).toMatchObject({ result: 'refreshed', head: NEWHEAD, back: true });
  });
});

describe('2: the card is re-read just before the real merge, so a verdict changed during an earlier gate is seen', () => {
  const twoCards = (change) => drive(`
CARDS[:] = [C(id="recCardAaaaaaaaaa", pr=811), C(id="recCardBbbbbbbbbb", pr=812)]
real = ma.run_merge_pr
def merge_pr(pr, head, dry_run=False):
    if pr == 811:
        ${change}
    return real(pr, head, dry_run)
ma.run_merge_pr = merge_pr
code, out = cmd_run()
print(json.dumps({"code": code, "done": out["done"], "real": [m[0] for m in real_merges()], "att": att()}))`);

  for (const [label, change] of [
    ['he rejects it', 'CARDS[1]["outcome"] = "Rejected"'],
    ['he undoes his approval', 'CARDS[1].update(outcome="", approvedAt="")'],
    ['he approves again (a new Approved At)', 'CARDS[1]["approvedAt"] = "2026-11-06T09:30:00.000Z"'],
    ['the card is refreshed to a new head', `CARDS[1].update(agentOutput=CARDS[1]["agentOutput"].replace("${HEAD}", "${NEWHEAD}"), head="${NEWHEAD}")`],
  ]) {
    it(`${label} while PR 811's gate runs: PR 812 is not merged and the run says why`, () => {
      const r = twoCards(change);
      expect(r.real).toEqual([811]);
      const b = r.done.find((d) => d.pr === 812);
      expect(b).toMatchObject({ action: 'merge', result: 'skip' });
      expect(b.why).toMatch(/changed .* since this run read it, so nothing was merged; the next run decides afresh/);
      expect(r.att['812']).toBeUndefined();                    // nothing recorded: the next run decides afresh
      expect(r.code).toBe(0);
    });
  }

  it('THE CONTROL: nothing changed, both merge; a card that cannot be re-read merges nothing and is counted as an error kind', () => {
    const r = twoCards('pass');
    expect(r.real).toEqual([811, 812]);
    const u = drive(`
def bad(task): raise RuntimeError("Airtable 503 (invented)")
MC.get_card = bad
code, out = cmd_run()
print(json.dumps({"done": out["done"][0], "real": real_merges(), "att": att()["812"]}))`);
    expect(u.real).toEqual([]);
    expect(u.done).toMatchObject({ result: 'error', kind: 'card-unreadable' });
    expect(u.att).toMatchObject({ result: 'error', errKind: 'card-unreadable', errTries: 1, reds: 0 });
  });
});

// merge-pr.py's real exit codes and JSON shapes (scripts/merge-pr.py gate() and main()).
const REFUSALS = {
  'our 45-minute kill while it waited for the gate ahead': `(124, "", "[merge-pr] waiting for the gate ahead to finish\\nstopped after 45 minutes")`,
  'tests could not run': `(1, json.dumps({"merged": False, "testsRan": False, "vitest": None, "why": "tests could not run: node_modules is missing"}), "")`,
  'could not build the merge result': `(1, json.dumps({"merged": False, "vitest": None, "why": "could not build the merge result: CONFLICT (content) in scripts/example.py"}), "")`,
  'cannot judge (a lagging ref)': `(1, json.dumps({"merged": False, "vitest": None, "why": "cannot judge: GitHub's refs/pull/812/head is aaaa, not the PR head bbbb. run it again"}), "")`,
  'a draft PR': `(1, json.dumps({"merged": False, "vitest": None, "why": "PR #812 is a draft; mark it ready first"}), "")`,
  'a private-name refusal': `(1, json.dumps({"merged": False, "vitest": None, "why": "PR #812 names a person on the private roster in: title"}), "")`,
  'the gate itself broke (exit 2)': `(2, json.dumps({"merged": False, "why": "the gate itself broke: OSError: invented"}), "")`,
  'tests green, then main changed the same files': `(1, json.dumps({"merged": False, "vitest": {"ok": True}, "browser": {"ok": True}, "walk": {"newFailures": []}, "why": "main changed the same files during the gate, run it again: scripts/example.py"}), "")`,
};
const REDS = {
  'vitest failed': `(1, json.dumps({"merged": False, "vitest": {"ok": False, "failed": ["tests/example.test.js"]}, "why": "the test gate is RED"}), "")`,
  'the browser suite failed after its retry': `(1, json.dumps({"merged": False, "vitest": {"ok": True}, "browser": {"ok": False, "okAfterRetry": False}, "why": "the test gate is RED"}), "")`,
  'the page walk found a new failure': `(1, json.dumps({"merged": False, "vitest": {"ok": True}, "browser": {"ok": True}, "walk": {"newFailures": ["example-page"]}, "why": "the merge result shows 1 new failure(s)"}), "")`,
};

describe('3: only a gate that ran and failed is a red; a refusal that ran no failing test is its own error kind', () => {
  for (const [label, rc] of Object.entries(REFUSALS)) {
    it(`${label}: counted as gate-refused, never a red, and worded as what stopped it`, () => {
      const r = drive(`
MERGE_RESULTS[:] = [${rc}]
code, out = cmd_run()
print(json.dumps({"code": code, "done": out["done"][0], "att": att()["812"], "note": NOTES[0]}))`);
      expect(r.done).toMatchObject({ result: 'error', kind: 'gate-refused' });
      expect(r.att).toMatchObject({ result: 'error', errKind: 'gate-refused', errTries: 1, reds: 0 });
      expect(r.note).toMatch(/and no test failed/);
      expect(r.code).toBe(0);
    });
  }
  for (const [label, rc] of Object.entries(REDS)) {
    it(`THE CONTROL, ${label}: a red`, () => {
      const r = drive(`
MERGE_RESULTS[:] = [${rc}]
code, out = cmd_run()
print(json.dumps({"done": out["done"][0], "att": att()["812"]}))`);
      expect(r.done.result).toBe('red');
      expect(r.att).toMatchObject({ result: 'red', reds: 1 });
    });
  }

  it('four refusals in a mix: ONE stop finding that does not say the gate failed, and a new approval starts again', () => {
    const r = drive(`
MERGE_RESULTS[:] = [${Object.values(REFUSALS).slice(0, 4).join(', ')}]
for i in range(4):
    at(i * 6.5)
    cmd_run()
stopped = att()["812"]
at(30)
rest = cmd_run()[1]["done"][0]
CARDS[0].update(approvedAt="2026-11-08T09:00:00.000Z")
CARDS[0]["fields"]["fldr4Mvf2RzKvhZhi"] = "2026-11-08T09:00:00.000Z"
at(60)
again = cmd_run()[1]["done"][0]
print(json.dumps({"stopped": stopped, "adds": ADDS, "rest": rest, "again": again, "real": len(real_merges())}))`);
    expect(r.stopped).toMatchObject({ result: 'error', errKind: 'gate-refused', errTries: 4, reds: 0, finding: '20261106-merge-approved-001' });
    expect(r.adds).toHaveLength(1);
    expect(title(r.adds[0])).toBe("PR #812's MERGE card: the merge run failed 4 times (gate-refused); the robot stopped");
    expect(title(r.adds[0])).not.toMatch(/failed its gate/);
    const detail = r.adds[0][r.adds[0].indexOf('--detail') + 1];
    expect(detail).toMatch(/refused each time without a failing test/);
    expect(r.rest.action).toBe('skip');
    expect(r.again).toMatchObject({ action: 'merge', result: 'merged' });   // his new approval runs at once
    expect(r.real).toBe(5);
  });
});

describe('4: an edit request is never said to have gone to the fixer until its finding is filed', () => {
  it('the finding fails to file: no Notes line, no send-back, his note kept, exit 1; the next run files it and only then moves the card', () => {
    const r = drive(`
CARDS[:] = [C(outcome="Changes requested", feedback="Please rename the invented helper first.")]
FIND_RC[0] = 1
c1, o1 = cmd_run()
after1 = dict(CARDS[0]); notes1 = list(NOTES); patches1 = len(PATCHES)
FIND_RC[0] = 0
at(0.5)
c2, o2 = cmd_run()
print(json.dumps({"c1": c1, "o1": o1["done"][0], "after1": [after1["status"], after1["outcome"], after1["feedback"]],
                  "notes1": notes1, "patches1": patches1, "c2": c2, "o2": o2["done"][0], "adds": len(ADDS),
                  "after2": [CARDS[0]["status"], CARDS[0]["outcome"], CARDS[0]["feedback"]], "notes": NOTES}))`);
    expect(r.c1).toBe(1);
    expect(r.o1).toMatchObject({ action: 'note-edit' });
    expect(r.o1.error).toMatch(/was not filed as a finding, so his note stays on the card and the next run tries again/);
    expect(r.notes1).toEqual([]);
    expect(r.patches1).toBe(0);
    expect(r.after1).toEqual(['Today', 'Changes requested', 'Please rename the invented helper first.']);
    expect(r.c2).toBe(0);
    expect(r.adds).toBe(2);
    expect(r.notes[0]).toMatch(/It went to the fixer \(20261106-merge-approved-002\)/);
    expect(r.after2).toEqual(['Approval', '', '']);
  });
});

describe('6: a closed PR whose findings read failed at the close keeps owing the reopen until it lands', () => {
  it('the list fails once: the card closes, the record owes the reopen, the next run reopens, and then it is quiet', () => {
    const r = drive(`
CARDS[:] = [C(findings=["20261101-invented-001"])]
gh(812).update(state="CLOSED")
PENDING[:] = [{"id": "20261101-invented-001", "status": "pending", "pr": "812"}]
LIST_RC[0] = 1
c1, o1 = cmd_run()
a1 = att()["812"]
dc1, d1 = detach()
LIST_RC[0] = 0
at(0.5)
c2, o2 = cmd_run()
at(1)
c3, o3 = cmd_run()
print(json.dumps({"c1": c1, "o1": o1["done"][0], "a1": a1, "d1": d1, "c2": c2, "o2": o2["done"][0], "c3": c3, "o3": o3["done"][0],
                  "reopens": REOPENS, "a3": att()["812"], "status": CARDS[0]["status"]}))`);
    expect(r.o1).toMatchObject({ result: 'closed-unmerged', reopenOwed: true });
    expect(r.c1).toBe(1);                                      // loud, never a quiet exit 0
    expect(r.status).toBe('Completed');
    expect(r.a1).toMatchObject({ result: 'closed-unmerged', reopenOwed: true });
    expect(r.d1.todo).toEqual([812]);                          // the poll queues the retry
    expect(r.o2).toMatchObject({ action: 'reopen-owed', result: 'reopened', reopened: ['20261101-invented-001'] });
    expect(r.c2).toBe(0);
    expect(r.reopens).toEqual(['20261101-invented-001']);
    expect(r.o3).toMatchObject({ action: 'skip', why: 'closed' });
    expect(r.a3.reopenOwed).toBeUndefined();
    expect(r.a3.reopened).toEqual(['20261101-invented-001']);
  });
});

describe('7: one failed GitHub read during a moved-head rest neither breaks the rest nor restarts its count', () => {
  it('a blip mid-rest keeps the rest; the count reaches 4 and files ONE stop finding', () => {
    const r = drive(`
gh(812).update(headRefOid="${NEWHEAD}")      # every dry run is red
log = []
def step(h, down=False):
    at(h); GH_DOWN[0] = down
    code, out = cmd_run()
    e = att().get("812", {})
    log.append([h, out["done"][0]["action"], out["done"][0].get("result", "-"), e.get("movedTries"), e.get("errTries")])
for h, down in ((0, 0), (6.5, 0), (13, 0), (13.5, 1), (14, 0), (19.5, 0), (26, 0)):
    step(h, bool(down))
print(json.dumps({"log": log, "dry": len([m for m in MERGES if m[2] == "dry"]), "adds": ADDS, "att": att()["812"]}))`);
    expect(r.log[3]).toEqual([13.5, 'skip', '-', 3, null]);   // the blip: still resting, count kept
    expect(r.log[4]).toEqual([14, 'skip', '-', 3, null]);
    expect(r.log[5].slice(0, 4)).toEqual([19.5, 'merge', 'moved', 4]);
    expect(r.log[6][1]).toBe('skip');
    expect(r.dry).toBe(4);
    expect(r.adds).toHaveLength(1);
    expect(title(r.adds[0])).toMatch(/^PR #812's new code failed 4 re-tests/);
  });

  it('a read that fails exactly when the rest ends is an error that keeps the count, so the next try is 4 of 4', () => {
    const r = drive(`
gh(812).update(headRefOid="${NEWHEAD}")
for h in (0, 6.5, 13):
    at(h); cmd_run()
at(19.5); GH_DOWN[0] = True; cmd_run()
blip = att()["812"]
at(20); GH_DOWN[0] = False; cmd_run()
print(json.dumps({"blip": blip, "att": att()["812"], "adds": len(ADDS)}))`);
    expect(r.blip).toMatchObject({ result: 'error', errKind: 'pr-unreadable', movedTries: 3, newHead: NEWHEAD });
    expect(r.att).toMatchObject({ result: 'moved', movedTries: 4 });
    expect(r.adds).toBe(1);
  });
});

describe('10: a merged PR whose card will not close rests and stops like every other failure', () => {
  it('four polls in two hours try the close once; four tries six hours apart, then ONE stop finding and quiet', () => {
    const r = drive(`
gh(812).update(state="MERGED", mergeCommit={"oid": "abc123def4567890"})
COMPLETE_RC[0] = 1
codes = []
for h in (0, 0.5, 1, 1.5):
    at(h); codes.append(cmd_run()[0])
early = [len(COMPLETES), len(NOTES)]
for h in (6.1, 12.2, 18.3, 24.4, 30.5):
    at(h); codes.append(cmd_run()[0])
print(json.dumps({"codes": codes, "early": early, "completes": len(COMPLETES), "notes": NOTES, "adds": ADDS, "att": att()["812"]}))`);
    expect(r.early).toEqual([1, 1]);
    expect(r.completes).toBe(4);
    expect(r.notes).toHaveLength(2);                          // the first try and the stop
    expect(r.notes[0]).toMatch(/^MERGED, CARD NOT CLOSED: PR #812 merged as abc123def456/);
    expect(r.adds).toHaveLength(1);
    expect(title(r.adds[0])).toBe('PR #812 merged but its MERGE card would not close 4 times; the robot stopped');
    expect(r.att).toMatchObject({ result: 'error', errKind: 'card-not-closed', errTries: 4 });
    expect(r.codes.every((c) => c === 0)).toBe(true);         // a rest on the clock is a normal outcome
  });
});

describe('11: the 4th red after an error stop files a red stop finding of its own', () => {
  it('three reds, an error stop with its own finding, a new approval, a red: a NEW red stop finding is filed', () => {
    const r = drive(`
ma.save_attempts({"812": {"result": "error", "errKind": "pr-unreadable", "errTries": 4, "head": "${HEAD}", "reds": 3,
                          "approvedAt": "2026-11-06T08:30:00.000Z", "at": "2026-11-06T09:00:00Z", "lastErrAt": "2026-11-06T09:00:00Z",
                          "finding": "20261106-merge-approved-900", "back": False}})
CARDS[0].update(approvedAt="2026-11-07T09:00:00.000Z"); CARDS[0]["fields"]["fldr4Mvf2RzKvhZhi"] = "2026-11-07T09:00:00.000Z"
MERGE_RESULTS[:] = [${REDS['vitest failed']}]
at(30)
cmd_run()
print(json.dumps({"att": att()["812"], "adds": ADDS}))`);
    expect(r.adds).toHaveLength(1);
    expect(title(r.adds[0])).toBe('PR #812 failed its gate 4 times on its MERGE card; the robot stopped retrying');
    expect(r.att).toMatchObject({ result: 'red', reds: 4, finding: '20261106-merge-approved-001' });
  });
});

describe('12: every open card for a closed PR is closed, not only the first', () => {
  it('two open cards for one closed PR: both closed, the findings reopened once, then both quiet', () => {
    const r = drive(`
CARDS[:] = [C(id="recCardAaaaaaaaaa", status="Approval", outcome=""), C(id="recCardBbbbbbbbbb", status="Approval", outcome="")]
gh(812).update(state="CLOSED")
PENDING[:] = [{"id": "20261101-invented-001", "status": "pending", "pr": "812"}]
c1, o1 = cmd_run()
at(0.5)
c2, o2 = cmd_run()
print(json.dumps({"o1": [[d["task"], d.get("result")] for d in o1["done"]], "o2": [d["action"] for d in o2["done"]],
                  "status": [c["status"] for c in CARDS], "reopens": REOPENS, "att": att()["812"]}))`);
    expect(r.o1).toEqual([['recCardAaaaaaaaaa', 'closed-unmerged'], ['recCardBbbbbbbbbb', 'closed-unmerged']]);
    expect(r.status).toEqual(['Completed', 'Completed']);
    expect(r.o2).toEqual(['skip', 'skip']);
    expect(r.reopens).toEqual(['20261101-invented-001']);
    expect(r.att.tasks).toEqual(['recCardAaaaaaaaaa', 'recCardBbbbbbbbbb']);
  });
});

describe('15: an attempts entry that is not an object costs only its own PR and never makes a merge more likely', () => {
  for (const bad of ['"red"', '["red"]', '3']) {
    it(`entry ${bad}: that PR is held and said loudly; another card still merges`, () => {
      const r = drive(`
CARDS[:] = [C(id="recCardAaaaaaaaaa", pr=811), C(id="recCardBbbbbbbbbb", pr=812)]
ma.save_attempts({"812": ${bad}})
dc, d = detach()
code, out = cmd_run()
print(json.dumps({"detach": d, "dcode": dc, "code": code, "done": out["done"], "real": [m[0] for m in real_merges()]}))`);
      expect(r.real).toEqual([811]);
      const b = r.done.find((x) => x.pr === 812);
      expect(b).toMatchObject({ action: 'bad-record', result: 'error' });
      expect(b.why).toMatch(/is not an object/);
      expect(r.code).toBe(1);
      expect(r.detach.todo).toEqual([811]);
    });
  }
});

describe('T1: reds are counted per head', () => {
  it('a red stop on ANOTHER head never rests the card, and a head change starts the red count again', () => {
    const r = drive(`
stopped = {"812": {"result": "red", "head": "${HEAD}", "reds": 4, "finding": "20261106-merge-approved-001",
                   "approvedAt": "2026-11-06T08:30:00.000Z", "at": "2026-11-06T09:00:00Z", "lastRedAt": "2026-11-06T09:00:00Z"}}
newcard = C(head="${NEWHEAD}", agentOutput=BASE["agentOutput"].replace("${HEAD}", "${NEWHEAD}"), prState="OPEN", prHead="${NEWHEAD}")
p_new = ma.plan(newcard, stopped)
p_old = ma.plan(C(prState="OPEN", prHead="${HEAD}"), stopped)
three = {"812": dict(stopped["812"], reds=3)}
del three["812"]["finding"]
res = ma.fail(newcard, three, "red", "the test gate is RED")
print(json.dumps({"p_new": p_new, "p_old": p_old[0], "res": res, "att": att()["812"], "adds": len(ADDS)}))`);
    expect(r.p_new).toEqual(['merge', 'approved']);
    expect(r.p_old).toBe('skip');
    expect(r.att).toMatchObject({ result: 'red', reds: 1, head: NEWHEAD });
    expect(r.res.stopped).toBeUndefined();
    expect(r.adds).toBe(0);
  });
});
