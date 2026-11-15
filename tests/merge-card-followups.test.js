import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const S = (f) => resolve(ROOT, 'scripts', f);

// THE MERGE CARD ROBOT, FOLLOW-UPS TO THE PR 937 REVIEW (15 Nov 2026). The review (R1 to R11, T) and
// finding 5 of the earlier one. Each test drives the REAL functions of scripts/merge-approved.py,
// merge-pr.py, merge_card.py and fixer-merge.py. The cards live in CARDS and every write is applied
// there, so a later run reads what an earlier one wrote. NOTHING here can reach the network: sockets
// may connect to loopback only, DNS for any other host is refused, urlopen is refused, and
// subprocess.run / Popen raise, before any script is loaded. Every name, PR number, record id and
// date is invented (this repo is public).
const run = (code, env = {}) => JSON.parse(execFileSync('python3', ['-c', code], {
  encoding: 'utf8', env: { ...process.env, ...env } }).trim().split('\n').pop());
const HEAD = 'a1b2c3d4'.repeat(5);
const NEWHEAD = 'f0e1d2c3'.repeat(5);
const BUILDER = 'recQkO6BA4w5zqwZ4';
const OUTPUT = `MERGE CARD: PR #812, fix: retype\nhttps://example.test/pull/812\nTested head: ${HEAD}\n\n**Carrying this out will involve:** If you approve, the robot runs merge-pr.py and the deploy, nothing else.`;
const T0 = 1793955600; // 2026-11-06T09:00:00Z
const HOUR = 3600;
const title = (add) => add[add.indexOf('--title') + 1];
const detail = (add) => add[add.indexOf('--detail') + 1];

// The guard every Python child in this file starts with. Loopback only.
const GUARD = `
import socket, subprocess, urllib.request
_LOCAL = ("127.0.0.1", "::1", "localhost")
_rc, _ga = socket.socket.connect, socket.getaddrinfo
def _connect(self, addr):
    if not (isinstance(addr, (str, bytes)) or (isinstance(addr, tuple) and str(addr[0]) in _LOCAL)):
        raise OSError("network call in a test: %r" % (addr,))
    return _rc(self, addr)
def _getaddrinfo(host, *a, **k):
    if host is not None and str(host) not in _LOCAL:
        raise OSError("network call in a test: DNS for %r" % (host,))
    return _ga(host, *a, **k)
socket.socket.connect, socket.getaddrinfo = _connect, _getaddrinfo
def _no_network(*a, **k): raise RuntimeError("network call in a test")
urllib.request.urlopen = _no_network
def _no_proc(*a, **k): raise RuntimeError("subprocess in a test: %r" % (a[:1],))
subprocess.run = subprocess.Popen = _no_proc
`;

const drive = (prelude, dir = mkdtempSync(join(tmpdir(), 'od-ma-followups-'))) => run(GUARD + `
import importlib.util, json, sys, os, io, contextlib, argparse
sys.path.insert(0, ${JSON.stringify(S(''))})
import findings
findings.current_state = lambda *a, **k: {}
spec = importlib.util.spec_from_file_location("ma", ${JSON.stringify(S('merge-approved.py'))})
ma = importlib.util.module_from_spec(spec); spec.loader.exec_module(ma)
mspec = importlib.util.spec_from_file_location("mp", ${JSON.stringify(S('merge-pr.py'))})
mp = importlib.util.module_from_spec(mspec); mspec.loader.exec_module(mp)
MC = ma.merge_card
ma.STATE_DIR = ${JSON.stringify(dir)}
NOW = [${T0}]
ma.clock = lambda: NOW[0]
NOTES, MERGES, ADDS, COMPLETES, PATCHES = [], [], [], [], []
PENDING = []
LIST_RC, FIND_RC = [0], [0]
COMPLETE_FAIL = [0]      # the next N closes fail
GH = {}
def gh(pr):
    return GH.setdefault(int(pr), {"state": "OPEN", "mergeCommit": None, "headRefOid": "${HEAD}"})
def card(id):
    return next(c for c in CARDS if c["id"] == id)
def sh(args, timeout=120):
    if args[:3] == ["gh", "pr", "view"]:
        return subprocess.CompletedProcess(args, 0, json.dumps(dict(gh(args[3]), title="fix: retype",
                                           url="https://example.test/pull/%s" % args[3], files=[{"path": "scripts/example.py"}])), "")
    if args[:3] == ["gh", "run", "list"]:
        return subprocess.CompletedProcess(args, 0, json.dumps([{"headSha": "abc123def4567890", "status": "completed", "conclusion": "success", "createdAt": "2026-11-06T10:00:00Z"}]), "")
    return subprocess.CompletedProcess(args, 0, "", "")
def py(script, *args, timeout=300):
    if script == "agent-dispatch.py" and args[0] == "annotate":
        NOTES.append(args[3])
        c = card(args[1]); c["notes"] = (c["notes"] + "\\n" + args[3]).strip()
    if script == "agent-dispatch.py" and args[0] == "complete":
        COMPLETES.append(list(args))
        if COMPLETE_FAIL[0]:
            COMPLETE_FAIL[0] -= 1
            return subprocess.CompletedProcess([script], 1, "", "Airtable PATCH -> HTTP 503 (invented)")
        c = card(args[1])
        if c["outcome"] not in MC.APPROVED:     # agent-dispatch.py cmd_complete's own refusal
            return subprocess.CompletedProcess([script], 1, "", "ERROR: refusing to complete %s - outcome is '%s', not an approval." % (args[1], c["outcome"] or "empty"))
        c["status"] = "Completed"
        return subprocess.CompletedProcess([script], 0, "", "")
    if script == "findings.py" and args[0] == "list":
        return subprocess.CompletedProcess([script], LIST_RC[0], json.dumps(PENDING), "queue unreadable (invented)" if LIST_RC[0] else "")
    if script == "findings.py" and args[0] == "add":
        ADDS.append(list(args))
        ok = FIND_RC[0] == 0
        return subprocess.CompletedProcess([script], FIND_RC[0], "20261106-merge-approved-%03d" % len(ADDS) if ok else "", "" if ok else "queue locked")
    return subprocess.CompletedProcess([script], 0, "landed 1 finding(s)" if script == "findings.py" else "", "")
DURING = []               # callbacks run INSIDE merge-pr.py's minutes: f(pr, head, dry_run)
AFTER_CHECK = []          # callbacks run after merge-pr.py's last card read, before GitHub merges
MERGE_RESULTS = []        # per REAL run: "green", or (exit, json, stderr)
DRY = []                  # per dry run: "green", else red
CARD_ARGS = []
def merge_pr(pr, head, dry_run=False, card=None):
    """merge-pr.py as the robot sees it, with its REAL last card check (mp.card_verdict_moved)."""
    MERGES.append([pr, head[:8], "dry" if dry_run else "REAL"])
    CARD_ARGS.append(bool(card))
    for f in DURING:
        f(pr, head, dry_run)
    if dry_run:
        if DRY and DRY.pop(0) == "green":
            return subprocess.CompletedProcess(["merge-pr.py"], 0, json.dumps({"merged": False, "dryRun": True, "head": head, "why": "green"}), "")
        return subprocess.CompletedProcess(["merge-pr.py"], 1, json.dumps({"merged": False, "head": head, "why": "the test gate is RED", "vitest": {"ok": False}}), "")
    nxt = MERGE_RESULTS.pop(0) if MERGE_RESULTS else "green"
    if nxt != "green":
        return subprocess.CompletedProcess(["merge-pr.py"], nxt[0], nxt[1], nxt[2])
    if card:
        moved = mp.card_verdict_moved(card["id"], card["approvedAt"], pr)
        if moved:
            return subprocess.CompletedProcess(["merge-pr.py"], 1, json.dumps({"merged": False, "cardCheck": moved[0], "why": moved[1],
                                               "vitest": {"ok": True}, "browser": {"ok": True}}), "")
    for f in AFTER_CHECK:
        f(pr, head)
    gh(pr).update(state="MERGED", mergeCommit={"oid": "abc123def4567890"})
    return subprocess.CompletedProcess(["merge-pr.py"], 0, json.dumps({"merged": True, "why": "merged: green"}), "")
ma.sh, ma.py, ma.run_merge_pr = sh, py, merge_pr
ma.time.sleep = lambda s: None
ma.teardown_worktree = lambda pr: "no workspace (test)"
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
def apply(c, fields):
    F = MC.F
    if F["agentOutput"] in fields:
        c["agentOutput"] = fields[F["agentOutput"]]
        m = MC.HEAD_RE.search(c["agentOutput"] or "")
        c["head"] = m.group(1) if m else ""
    for key, f in (("outcome", "approvalOutcome"), ("approvedAt", "approvedAt"), ("feedback", "approvalFeedback"), ("status", "status")):
        if F[f] in fields:
            c[key] = fields[F[f]] or ""
def patch_card(task, fields):
    PATCHES.append([task, dict(fields)])
    apply(card(task), fields)
MC.patch_card = patch_card
MC.list_cards = lambda read=None: [json.loads(json.dumps(c)) for c in CARDS]
GET_FAIL = [0]            # the next N single-card reads fail (Airtable 503)
def get_card(task):
    if GET_FAIL[0]:
        GET_FAIL[0] -= 1
        raise RuntimeError("Airtable 503 (invented)")
    return json.loads(json.dumps(card(task)))
MC.get_card = get_card
def kevin(id="recCardAaaaaaaaaa", **k):
    """What the approval page writes when he decides."""
    card(id).update(k)
def cmd_run():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
        code = ma.cmd_run(argparse.Namespace(dry_run=False))
    return code, json.loads(buf.getvalue())
def detach():
    class P:
        def __init__(self, args, **k): self.pid = 99999999
    ma.subprocess.Popen = P
    ma._proc_started = lambda pid: "invented start"
    try:
        p = os.path.join(ma.STATE_DIR, ma.QUEUED_PID)
        os.path.exists(p) and os.remove(p)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            code = ma.cmd_detach(argparse.Namespace())
        return code, json.loads(buf.getvalue())
    finally:
        ma.subprocess.Popen = _no_proc
def att():
    p = os.path.join(ma.STATE_DIR, ma.ATTEMPTS)
    return json.load(open(p)) if os.path.exists(p) else {}
def at(hours):
    NOW[0] = ${T0} + hours * ${HOUR}
def real_merges():
    return [m for m in MERGES if m[2] == "REAL"]
def title(add):
    return add[add.index("--title") + 1]
def detail(add):
    return add[add.index("--detail") + 1]
${prelude}
`);

describe('A (R1): Kevin changes his verdict while merge-pr.py is testing', () => {
  for (const [label, change] of [
    ['rejects it', 'kevin(status="Completed", outcome="Rejected")'],
    ['undoes his approval', 'kevin(status="Approval", outcome="", approvedAt="")'],
    ['asks for a change', 'kevin(outcome="Changes requested", feedback="Rename the invented helper first.")'],
  ]) {
    it(`he ${label} during the gate: nothing merges, it is not a red or a counted failure, and his card says so`, () => {
      const r = drive(`
DURING.append(lambda pr, head, dry: ${change})
code, out = cmd_run()
DURING[:] = []
att1 = att()
at(0.5)
code2, out2 = cmd_run()
print(json.dumps({"code": code, "done": out["done"][0], "code2": code2, "done2": out2["done"][0], "real": real_merges(),
                  "gh": gh(812)["state"], "att": att1, "notes": NOTES, "adds": ADDS, "cardArgs": CARD_ARGS}))`);
      expect(r.cardArgs[0]).toBe(true);                        // the robot asks merge-pr.py to re-read the card
      expect(r.gh).toBe('OPEN');                               // nothing merged
      expect(r.done).toMatchObject({ result: 'skip', verdictChanged: true });
      expect(r.done.why).toMatch(/^Kevin's verdict changed during the tests, so nothing was merged: MERGE card recCardAaaaaaaaaa changed while the gate ran/);
      expect(r.code).toBe(0);
      expect(r.att).toEqual({});                               // no red, no counted error
      expect(r.notes[0]).toMatch(/^MERGE NOT DONE: Kevin's verdict on this card changed while merge-pr\.py was testing PR #812, so nothing was merged/);
      expect(r.notes.join(' ')).not.toMatch(/approval stands/);
    });
  }

  it('the next run follows his newer verdict: a rejection is noted as left open, a change request is filed', () => {
    const r = drive(`
DURING.append(lambda pr, head, dry: kevin(status="Completed", outcome="Rejected"))
cmd_run(); DURING[:] = []
at(0.5); _, rej = cmd_run()
CARDS[:] = [C(id="recCardBbbbbbbbbb")]
NOTES[:] = []
DURING.append(lambda pr, head, dry: kevin(id="recCardBbbbbbbbbb", outcome="Changes requested", approvedAt="2026-11-06T09:10:00.000Z", feedback="Rename it."))
at(1); cmd_run(); DURING[:] = []
at(1.5); _, edit = cmd_run()
print(json.dumps({"rej": rej["done"][0]["action"], "edit": edit["done"][0]["action"], "adds": [title(a) for a in ADDS], "real": real_merges()}))`);
    expect(r.rej).toBe('note-rejected');
    expect(r.edit).toBe('note-edit');
    expect(r.adds).toEqual(['Kevin asked for a change to PR #812']);
    expect(r.real.every((m) => m[0] === 812)).toBe(true);
  });

  it('control: an unchanged card merges, and merge-pr.py is given the card and its Approved At (real run_merge_pr argv)', () => {
    const r = drive(`
code, out = cmd_run()
# The REAL run_merge_pr builds merge-pr.py's arguments: --card only on a real run, never a dry run.
ARGV = []
class FakeProc:
    def __init__(self, args, **k): ARGV.append(args); self.pid = 1; self.returncode = 0
    def communicate(self, timeout=None): return ('{"merged": false}', "")
fspec = importlib.util.spec_from_file_location("ma2", ${JSON.stringify(S('merge-approved.py'))})
fresh = importlib.util.module_from_spec(fspec); fspec.loader.exec_module(fresh)
fresh.subprocess.Popen = FakeProc       # the real run_merge_pr, with no process started
fresh.run_merge_pr(812, "${HEAD}", card=C())
fresh.run_merge_pr(812, "${HEAD}", dry_run=True, card=C())
fresh.run_merge_pr(812, "${HEAD}")
print(json.dumps({"code": code, "done": out["done"][0], "argv": [a[2:] for a in ARGV]}))`);
    expect(r.done).toMatchObject({ result: 'merged' });
    expect(r.argv[0]).toEqual(['--pr', '812', '--expect-head', HEAD, '--card', 'recCardAaaaaaaaaa', '--card-approved-at', '2026-11-06T08:30:00.000Z']);
    expect(r.argv[1]).toEqual(['--pr', '812', '--expect-head', HEAD, '--dry-run']);
    expect(r.argv[2]).toEqual(['--pr', '812', '--expect-head', HEAD]);
  });

  it('the remaining window: he rejects after merge-pr.py\'s last read, as GitHub merges. The words say "merged before your change was seen", never "approval stands" or "nothing was merged"', () => {
    const r = drive(`
AFTER_CHECK.append(lambda pr, head: kevin(status="Completed", outcome="Rejected"))
code, out = cmd_run()
AFTER_CHECK[:] = []
at(0.5)
code2, out2 = cmd_run()
print(json.dumps({"code": code, "done": out["done"][0], "done2": out2["done"][0], "notes": NOTES, "att": att()["812"], "adds": len(ADDS)}))`);
    expect(r.done).toMatchObject({ result: 'merged-before-change', sha: 'abc123def4567890' });
    expect(r.code).toBe(0);
    expect(r.notes[0]).toMatch(/^MERGED BEFORE YOUR CHANGE WAS SEEN: PR #812 merged as abc123def456\. merge-pr\.py read this card just before its merge call and it was still approved; then the card's status changed \(Today, now Completed\), while GitHub was merging/);
    expect(r.att).toMatchObject({ result: 'merged', sha: 'abc123def4567890', verdictMovedFirst: true });
    expect(r.done2.action).toBe('note-rejected');
    expect(r.notes[1]).toBe('MERGE CARD REJECTED: Kevin rejected the merge card, but PR #812 had already merged as abc123def456 before the rejection was seen. Nothing more runs.');
    const all = r.notes.join(' ');
    expect(all).not.toMatch(/approval stands/);
    expect(all).not.toMatch(/nothing was merged/);
    expect(r.adds).toBe(0);
  });

  it('a card merge-pr.py cannot read just before the merge: nothing merges, counted as a failed card read, retried on the next run', () => {
    const r = drive(`
DURING.append(lambda pr, head, dry: GET_FAIL.__setitem__(0, 1))   # the read inside merge-pr.py fails once
code, out = cmd_run()
DURING[:] = []
at(0.5)
code2, out2 = cmd_run()
print(json.dumps({"code": code, "done": out["done"][0], "done2": out2["done"][0], "real": real_merges(), "gh": gh(812)["state"]}))`);
    expect(r.done).toMatchObject({ result: 'error', kind: 'card-unreadable' });
    expect(r.done.why).toMatch(/could not read the card for PR #812 just before its merge call, so nothing was merged/);
    expect(r.done2).toMatchObject({ action: 'merge', result: 'merged' });   // the next run, not six hours later
    expect(r.gh).toBe('MERGED');
  });
});

describe('B (R2): the refresh of a moved card re-reads the card first', () => {
  for (const [label, change, then] of [
    ['rejects it', 'kevin(status="Completed", outcome="Rejected")', 'note-rejected'],
    ['asks for a change', 'kevin(outcome="Changes requested", approvedAt="2026-11-06T09:20:00.000Z", feedback="Rename the invented helper.")', 'note-edit'],
  ]) {
    it(`he ${label} during the dry run: the refresh does not wipe it, and the next run acts on it`, () => {
      const r = drive(`
gh(812).update(headRefOid="${NEWHEAD}")
DRY[:] = ["green"]
DURING.append(lambda pr, head, dry: ${change})
code, out = cmd_run()
DURING[:] = []
after = dict(card("recCardAaaaaaaaaa"))
at(0.5)
_, out2 = cmd_run()
print(json.dumps({"code": code, "done": out["done"][0], "patches": PATCHES[:1], "after": [after["head"][:8], after["outcome"]],
                  "next": out2["done"][0]["action"], "adds": [title(a) for a in ADDS], "real": real_merges()}))`);
      expect(r.done.result).toBe('skip');
      expect(r.done.why).toMatch(/since this run read it, so the card was not refreshed and nothing was merged/);
      expect(r.patches.filter((p) => p[0] === 'recCardAaaaaaaaaa' && 'fldzswp8fx6PqpLQ5' in p[1])).toEqual([]);   // no refresh write
      expect(r.after[0]).toBe(HEAD.slice(0, 8));
      expect(r.after[1]).not.toBe('');                                           // his verdict stands
      expect(r.next).toBe(then);
      if (then === 'note-edit') expect(r.adds).toEqual(['Kevin asked for a change to PR #812']);
      expect(r.real).toEqual([]);
    });
  }

  it('control: nothing changed during the dry run, so the card is refreshed and sent back', () => {
    const r = drive(`
gh(812).update(headRefOid="${NEWHEAD}")
DRY[:] = ["green"]
code, out = cmd_run()
print(json.dumps({"done": out["done"][0], "card": [card("recCardAaaaaaaaaa")["head"][:8], card("recCardAaaaaaaaaa")["outcome"]]}))`);
    expect(r.done).toMatchObject({ result: 'refreshed', backToKevin: true });
    expect(r.card).toEqual([NEWHEAD.slice(0, 8), '']);
  });
});

describe('C (R3): one cap per card and approval across every kind of failure', () => {
  it('two kinds taking turns reach the 4-try stop with ONE finding quoting the last error of each', () => {
    const r = drive(`
GATE = (1, json.dumps({"merged": False, "why": "cannot judge: a busy gate (invented)", "vitest": None}), "")
log = []
for i, h in enumerate((0, 6.5, 13, 19.5, 26, 32.5)):
    at(h)
    if i % 2 == 0:
        MERGE_RESULTS[:] = [GATE]
    else:
        GET_FAIL[0] = 1      # the re-read before the gate fails
    code, out = cmd_run()
    d = out["done"][0]
    e = att().get("812", {})
    log.append([h, d.get("result", d.get("action")), e.get("errKind"), e.get("errTries"), code])
print(json.dumps({"log": log, "adds": ADDS, "notes": len(NOTES), "gates": len(real_merges())}))`);
    expect(r.log.slice(0, 4).map((x) => x[3])).toEqual([1, 2, 3, 4]);
    expect(r.log[3][1]).toBe('error');
    expect(r.adds).toHaveLength(1);
    expect(title(r.adds[0])).toBe("PR #812's MERGE card: the merge run failed 4 times (gate-refused, card-unreadable); the robot stopped");
    expect(detail(r.adds[0])).toMatch(/gate-refused: merge-pr\.py did not merge PR #812[\s\S]*\ncard-unreadable: the card for PR #812 could not be read again/);
    expect(r.log.slice(4).map((x) => x[1])).toEqual(['skip', 'skip']);         // resting after the stop
    expect(r.gates).toBe(2);                                                   // the two gate-refused tries only
    expect(r.notes).toBe(3);                                                   // each kind once, then the stop
    expect(r.log.every((x) => x[4] === 0)).toBe(true);
  });
});

describe('N2 (I2): after a merge has landed, closing the card never shares a count with anything before it', () => {
  it('three gate refusals, then a merge whose close fails once: the close is try 1 of its own, rests, and the card closes', () => {
    const r = drive(`
GATE = (1, json.dumps({"merged": False, "why": "cannot judge: a busy gate (invented)", "vitest": None}), "")
log = []
for h in (0, 6.5, 13):
    at(h); MERGE_RESULTS[:] = [GATE]; cmd_run()
at(19.5); COMPLETE_FAIL[0] = 1
code, out = cmd_run()
d = out["done"][0]
e = att()["812"]
log.append([d["result"], d.get("kind"), bool(d.get("stopped")), e.get("errTries"), sorted(e.get("lastErrors", {}))])
at(25.6)
code2, out2 = cmd_run()
print(json.dumps({"log": log, "code": code, "done2": out2["done"][0], "status": card("recCardAaaaaaaaaa")["status"], "adds": [title(a) for a in ADDS]}))`);
    expect(r.log[0]).toEqual(['merged-open', 'card-not-closed', false, 1, ['card-not-closed']]);
    expect(r.code).toBe(0);
    expect(r.done2).toMatchObject({ action: 'merge', result: 'merged' });
    expect(r.status).toBe('Completed');
    expect(r.adds).toEqual([]);                             // no stop finding of any kind
  });

  it('four refusals (stopped, finding 001), then merged by hand and the close fails once: never borrows finding 001, closes 6 hours later', () => {
    const r = drive(`
GATE = (1, json.dumps({"merged": False, "why": "cannot judge: a busy gate (invented)", "vitest": None}), "")
for h in (0, 6.5, 13, 19.5):
    at(h); MERGE_RESULTS[:] = [GATE]; cmd_run()
stopped = att()["812"]
gh(812).update(state="MERGED", mergeCommit={"oid": "abc123def4567890"})
at(20); COMPLETE_FAIL[0] = 1
_, out = cmd_run()
after = att()["812"]
at(26.1)
_, out2 = cmd_run()
print(json.dumps({"stopped": stopped.get("finding"), "done": out["done"][0], "after": after, "done2": out2["done"][0],
                  "status": card("recCardAaaaaaaaaa")["status"], "adds": [title(a) for a in ADDS]}))`);
    expect(r.stopped).toBe('20261106-merge-approved-001');
    expect(r.done).toMatchObject({ result: 'merged-open', kind: 'card-not-closed' });
    expect(r.done.stopped).toBeUndefined();
    expect(r.after.finding).toBeUndefined();               // finding 001 is about gate refusals, never this
    expect(r.after).toMatchObject({ errKind: 'card-not-closed', errTries: 1 });
    expect(r.done2).toMatchObject({ action: 'merge', result: 'merged' });
    expect(r.status).toBe('Completed');
    expect(r.adds).toHaveLength(1);
  });
});

describe('D (R4, R5): a held card rests and stops like any failure, and never makes a merge more likely', () => {
  it('a bad attempts record on the only approved card: queued, noted once, rests, ONE stop finding, exit 0 after the first try', () => {
    const r = drive(`
ma.save_attempts({"812": "red"})
log = []
for h in (0, 0.5, 1, 6.6, 7, 12.7, 13, 30):
    at(h)
    dc, d = detach()
    code, out = cmd_run()
    log.append([h, dc, d["todo"], code, out["done"][0].get("action"), out["done"][0].get("tries")])
print(json.dumps({"log": log, "adds": ADDS, "notes": NOTES, "record": att()["812"], "real": real_merges(), "card": card("recCardAaaaaaaaaa")["outcome"]}))`);
    expect(r.log.map((x) => x[1])).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);        // detach never exits 1
    expect(r.log[0]).toEqual([0, 0, [812], 1, 'bad-record', 1]);               // the first sight is loud once
    expect(r.log[1]).toEqual([0.5, 0, [812], 0, 'bad-record', 2]);             // retried on the next run
    expect(r.log[2]).toEqual([1, 0, [], 0, 'skip', null]);                     // then rests
    expect(r.log[3]).toEqual([6.6, 0, [812], 0, 'bad-record', 3]);
    expect(r.log[5]).toEqual([12.7, 0, [812], 0, 'bad-record', 4]);
    expect(r.log[7]).toEqual([30, 0, [], 0, 'skip', null]);
    expect(r.adds).toHaveLength(1);
    expect(title(r.adds[0])).toBe("PR #812's MERGE card is held: its merge-approved record cannot be read (seen 4 times)");
    expect(r.adds[0][r.adds[0].indexOf('--fix') + 1]).toMatch(/fix or delete the key "812"/);
    expect(r.notes).toHaveLength(2);                                           // the first try and the stop
    expect(r.notes[0]).toMatch(/^MERGE CARD HELD: its record in attempts\.json is not an object/);
    expect(r.record).toBe('red');                                              // the bad record is kept as it is
    expect(r.real).toEqual([]);
  });

  it('a closed PR whose findings list never reads: exit 1 once, then rests, ONE stop finding, quiet', () => {
    const r = drive(`
CARDS[:] = [C(findings=["20261101-invented-001"])]
gh(812).update(state="CLOSED")
PENDING[:] = [{"id": "20261101-invented-001", "status": "pending", "pr": "812"}]
LIST_RC[0] = 1
log = []
for h in (0, 0.5, 1, 6.6, 12.7, 13, 30):
    at(h)
    dc, d = detach()
    code, out = cmd_run()
    log.append([h, dc, d["todo"], code, out["done"][0].get("action")])
print(json.dumps({"log": log, "adds": ADDS}))`);
    expect(r.log.map((x) => x[3])).toEqual([1, 0, 0, 0, 0, 0, 0]);
    expect(r.log[1][4]).toBe('reopen-owed');                                    // the next run tries again
    expect(r.log[2]).toEqual([1, 0, [], 0, 'skip']);                           // then rests
    expect(r.log[4][4]).toBe('reopen-owed');                                    // the 4th try files the stop
    expect(r.log.slice(5).map((x) => [x[2], x[4]])).toEqual([[[], 'skip'], [[], 'skip']]);
    expect(r.adds).toHaveLength(1);
    expect(title(r.adds[0])).toBe('PR #812 was closed unmerged and its pending findings could not be put back (4 tries)');
  });
});

describe('N3 (I3): a held card at its cap writes ONE stop line, however often its finding fails to file', () => {
  it('a bad record whose stop finding will not file: one first-try line, one stop line, silent retries, exit 0, then filed once', () => {
    const r = drive(`
ma.save_attempts({"812": "red"})
FIND_RC[0] = 1
codes = []
for h in (0, 0.5, 6.6, 12.7, 13.2, 13.7, 14.2, 14.7):
    at(h); codes.append(cmd_run()[0])
held_lines = [n for n in NOTES if n.startswith("MERGE CARD HELD:")]
tries = att()["held"]["812"]["tries"]
FIND_RC[0] = 0
at(15.2); codes.append(cmd_run()[0])
at(15.7); last = cmd_run()[1]["done"][0]
print(json.dumps({"codes": codes, "held_lines": len(held_lines), "after": len([n for n in NOTES if n.startswith("MERGE CARD HELD:")]),
                  "tries": tries, "adds": len(ADDS), "filed": att()["held"]["812"].get("finding"), "last": last["action"]}))`);
    expect(r.codes).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(r.held_lines).toBe(2);                           // the first try and the stop, never one per run
    expect(r.after).toBe(2);                                // filing it later writes no more lines
    expect(r.tries).toBe(8);
    expect(r.adds).toBe(6);                                 // five silent refusals, then filed
    expect(r.filed).toBe('20261106-merge-approved-006');
    expect(r.last).toBe('skip');
  });

  it('a closed PR whose findings list and findings add both fail: one stop line in all, exit 0 while it rests', () => {
    const r = drive(`
CARDS[:] = [C(findings=["20261101-invented-001"])]
gh(812).update(state="CLOSED")
PENDING[:] = [{"id": "20261101-invented-001", "status": "pending", "pr": "812"}]
LIST_RC[0] = 1; FIND_RC[0] = 1
codes = []
for h in (0, 0.5, 6.6, 12.7, 13.2, 13.7, 14.2, 20.3):
    at(h); codes.append(cmd_run()[0])
print(json.dumps({"codes": codes, "held": len([n for n in NOTES if n.startswith("MERGE CARD HELD:")])}))`);
    expect(r.codes).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(r.held).toBe(1);                                 // the close's own note says try 1; then the stop, once
  });
});

describe('E (finding 5): a PR closed and then reopened gets a MERGE card again', () => {
  const fixer = (prelude) => run(GUARD + `
import importlib.util, json, sys, io, contextlib, argparse
sys.path.insert(0, ${JSON.stringify(S(''))})
spec = importlib.util.spec_from_file_location("fm", ${JSON.stringify(S('fixer-merge.py'))})
fm = importlib.util.module_from_spec(spec); spec.loader.exec_module(fm)
import merge_card, findings
CREATED, PATCHED, GATES = [], [], []
fm.decide = lambda pr: {"pr": pr, "files": 2, "protected": [{"file": "scripts/agent-dispatch.py", "rule": "scripts/agent-dispatch.py"}], "mayAutoMerge": False}
fm.build_merge_result = lambda pr: ("/tmp/od-fm-tree-invented", None)
fm.destroy_merge_result = lambda p: None
fm.tests_cannot_run = lambda tree: None
fm.tested_head = lambda pr: "${NEWHEAD}"
fm.run_gate = lambda cwd: (GATES.append(cwd), (True, {"testedTree": cwd, "vitest": {"ok": True, "tail": "ok"}, "browser": {"ok": True, "tail": "ok"}}))[1]
fm.pr_facts = lambda pr: ("fix: retype", "https://example.test/pull/%d" % pr, ["scripts/agent-dispatch.py"], "${NEWHEAD}")
merge_card.create_card = lambda fields, run=None: (CREATED.append(fields), "recNewCardAaaaaa")[1]
merge_card.patch_card = lambda task, fields: PATCHED.append([task, fields])
findings.current_state = lambda: {}
F = merge_card.F
def rec(id, status, outcome="", notes="", head="${HEAD}"):
    return {"id": id, "createdTime": "2026-11-06T08:00:00.000Z", "fields": {F["name"]: "MERGE: PR #812 — fix", F["status"]: status,
            F["approvalOutcome"]: outcome, F["notes"]: notes,
            F["agentOutput"]: "MERGE CARD: PR #812, fix\\nTested head: %s\\n" % head}}
ROWS = []
merge_card.read_tasks = lambda formula, fields=None, max_records=None: ROWS
import os, tempfile
os.environ["MERGE_APPROVED_DIR"] = tempfile.mkdtemp(prefix="od-fm-att-")
def robot_closed(*ids):
    """merge-approved.py's own record: the cards it closed because PR 812 was closed unmerged."""
    with open(os.path.join(os.environ["MERGE_APPROVED_DIR"], "attempts.json"), "w") as fh:
        json.dump({"812": {"result": "closed-unmerged", "at": "2026-11-06T09:00:00Z", "tasks": list(ids), "reopened": []}}, fh)
GH_STATE = ["OPEN"]       # what GitHub says PR 812 is now; None = the read fails
GH_READS = []
def sh(args, cwd=None, timeout=1800):
    if args[:3] == ["gh", "pr", "view"] and "state" in args:
        GH_READS.append(args[3])
        if GH_STATE[0] is None:
            return subprocess.CompletedProcess(args, 1, "", "HTTP 502: invented outage")
        return subprocess.CompletedProcess(args, 0, json.dumps({"state": GH_STATE[0]}), "")
    raise RuntimeError("unexpected command in a test: %r" % (args,))
fm.sh = sh
ERR = io.StringIO()
def merge():
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(ERR):
        code = fm.cmd_merge(argparse.Namespace(pr=812))
    return code, json.loads(buf.getvalue())
${prelude}
`);

  // I1 (review N1, N5): a card the ROBOT closed (it is in its own record's `tasks`) is no decision only
  // while GitHub says the PR is OPEN now. Its Notes line plays no part: here it is deliberately absent.
  it('reopened: the robot closed the card (its record says so, no Notes line), GitHub says OPEN: ONE new card for the current head; the old one is left closed', () => {
    const r = fixer(`
robot_closed("recOldCardAaaaaa")
ROWS[:] = [rec("recOldCardAaaaaa", "Completed", "Approved as-is")]
code, out = merge()
print(json.dumps({"code": code, "card": out["mergeCard"], "created": len(CREATED), "head": "Tested head: ${NEWHEAD}" in CREATED[0][F["agentOutput"]] if CREATED else None,
                  "patched": PATCHED, "gates": len(GATES), "reads": GH_READS}))`);
    expect(r.gates).toBe(1);
    expect(r.card).toMatchObject({ task: 'recNewCardAaaaaa', already: false });
    expect(r.created).toBe(1);
    expect(r.head).toBe(true);
    expect(r.patched).toEqual([]);                         // the old closed card is not touched
    expect(r.reads.length).toBeGreaterThan(0);              // GitHub's state was asked
  });

  for (const state of ['CLOSED', 'MERGED']) {
    it(`still ${state}: the robot-closed card keeps answering, so no card, no gate, and no daily loop of cards`, () => {
      const r = fixer(`
robot_closed("recOldCardAaaaaa")
ROWS[:] = [rec("recOldCardAaaaaa", "Completed", "Approved as-is")]
GH_STATE[0] = "${state}"
runs = [merge() for _ in range(3)]
print(json.dumps({"cards": [o["mergeCard"] for _, o in runs], "created": len(CREATED), "gates": len(GATES)}))`);
      expect(r.created).toBe(0);
      expect(r.gates).toBe(0);
      expect(r.cards).toEqual([0, 1, 2].map(() => ({ task: 'recOldCardAaaaaa', already: true })));
    });
  }

  it('a closed card NOT in the robot\'s record (closed some other way) stands, even with the robot\'s words in its Notes', () => {
    const r = fixer(`
robot_closed("recSomeOtherCard")
ROWS[:] = [rec("recOldCardAaaaaa", "Completed", "Approved as-is", "PR CLOSED, NOT MERGED: copied words (invented)")]
code, out = merge()
print(json.dumps({"card": out["mergeCard"], "created": len(CREATED)}))`);
    expect(r.card).toEqual({ task: 'recOldCardAaaaaa', already: true });
    expect(r.created).toBe(0);
  });

  it('the robot\'s record unreadable, or GitHub\'s state unreadable: the old card keeps blocking (the safe side) and says so', () => {
    const r = fixer(`
ROWS[:] = [rec("recOldCardAaaaaa", "Completed", "Approved as-is")]
open(os.path.join(os.environ["MERGE_APPROVED_DIR"], "attempts.json"), "w").write("{ truncated")
_, a = merge()
said_a = ERR.getvalue(); ERR.seek(0); ERR.truncate()
robot_closed("recOldCardAaaaaa")
GH_STATE[0] = None
_, b = merge()
print(json.dumps({"a": a["mergeCard"], "b": b["mergeCard"], "said_a": said_a, "said_b": ERR.getvalue(), "created": len(CREATED)}))`);
    expect(r.a).toEqual({ task: 'recOldCardAaaaaa', already: true });
    expect(r.b).toEqual({ task: 'recOldCardAaaaaa', already: true });
    expect(r.created).toBe(0);
    expect(r.said_a).toMatch(/attempts\.json unreadable .*, so a card the robot closed is treated as standing/);
    expect(r.said_b).toMatch(/the robot closed card recOldCardAaaaaa, and PR #812's state could not be read/);
  });

  it('never two open cards: with a new open card beside the old robot-closed one, that open card is the one used', () => {
    const r = fixer(`
robot_closed("recOldCardAaaaaa")
ROWS[:] = [rec("recOldCardAaaaaa", "Completed", ""), rec("recNewCardBbbbbb", "Approval", "", "", "${NEWHEAD}")]
code, out = merge()
print(json.dumps({"card": out["mergeCard"], "created": len(CREATED), "gates": len(GATES)}))`);
    expect(r.card).toEqual({ task: 'recNewCardBbbbbb', already: true });
    expect(r.created).toBe(0);
    expect(r.gates).toBe(0);
  });

  it('a card Kevin rejected always answers: no new card, even listed in the robot\'s record and with the PR open', () => {
    const r = fixer(`
robot_closed("recOldCardAaaaaa", "recRejectedAaaaa")
ROWS[:] = [rec("recOldCardAaaaaa", "Completed", ""), rec("recRejectedAaaaa", "Completed", "Rejected")]
code, out = merge()
print(json.dumps({"card": out["mergeCard"], "created": len(CREATED)}))`);
    expect(r.card).toEqual({ task: 'recRejectedAaaaa', already: true });
    expect(r.created).toBe(0);
  });

  it('the robot then works the new card and leaves the old closed one alone', () => {
    const r = drive(`
ma.save_attempts({"812": {"result": "closed-unmerged", "head": "${HEAD}", "approvedAt": "", "at": "2026-11-06T09:00:00Z", "tasks": ["recOldCardAaaaaa"], "reopened": []}})
CARDS[:] = [C(id="recOldCardAaaaaa", status="Completed", notes="PR CLOSED, NOT MERGED: invented"),
            C(id="recNewCardBbbbbb", approvedAt="2026-11-07T08:00:00.000Z", createdTime="2026-11-07T07:00:00.000Z")]
at(24)
code, out = cmd_run()
print(json.dumps({"done": [[d["task"], d.get("action"), d.get("result")] for d in out["done"]], "real": real_merges()}))`);
    expect(r.done).toEqual([['recOldCardAaaaaa', 'skip', null], ['recNewCardBbbbbb', 'merge', 'merged']]);
    expect(r.real).toEqual([[812, HEAD.slice(0, 8), 'REAL']]);
  });
});

describe('F (R6, R7, R9)', () => {
  it('R6: a card with no tested head keeps its re-test count through a failed GitHub read when its rest ends', () => {
    const r = drive(`
NOHEAD = BASE["agentOutput"].replace("Tested head: ${HEAD}\\n", "")
CARDS[:] = [C(head="", agentOutput=NOHEAD)]
gh(812).update(headRefOid="${NEWHEAD}")
real_state = ma.pr_state
log = []
for h, down in ((0, 0), (6.5, 0), (13, 0), (19.5, 1), (20, 0), (26, 0)):
    at(h)
    if down:
        def bad(pr): raise RuntimeError("gh cannot read PR #812: HTTP 502 (invented)")
        ma.pr_state = bad
    else:
        ma.pr_state = real_state
    cmd_run()
    e = att()["812"]
    log.append([h, e.get("result"), e.get("movedTries")])
print(json.dumps({"log": log, "adds": [title(a) for a in ADDS]}))`);
    expect(r.log[3]).toEqual([19.5, 'error', 3]);           // the blip keeps the count
    expect(r.log[4]).toEqual([20, 'error', 3]);             // the blip's own rest
    expect(r.log[5]).toEqual([26, 'moved', 4]);             // so the next try is 4 of 4, never 1 again
    expect(r.adds).toEqual(["PR #812's MERGE card had no tested head and its code failed 4 re-tests; the robot stopped"]);
  });

  it('R7 and the classifier rows: only a gate that ran and failed is a red', () => {
    const r = drive(`
rows = {
  "vitest red": (1, {"vitest": {"ok": False}}),
  "browser red again on the retry": (1, {"vitest": {"ok": True}, "browser": {"ok": False, "okAfterRetry": False, "retry": {"retried": 2, "why": "red again on the retry"}}}),
  "browser killed at 30 minutes (no retry)": (1, {"vitest": {"ok": True}, "browser": {"ok": False, "timedOut": True}}),
  "page walk new failure": (1, {"vitest": {"ok": True}, "browser": {"ok": True}, "walk": {"newFailures": ["pnl"]}}),
  "browser died with no failing test (web server)": (1, {"vitest": {"ok": True}, "browser": {"ok": False, "okAfterRetry": False, "retry": {"why": "the browser run failed with no failing test recorded (a setup or server failure), so there is nothing to retry"}}}),
  "flaky then green, then a later refusal": (1, {"vitest": {"ok": True}, "browser": {"ok": False, "okAfterRetry": True, "retry": {"retried": 1}}, "walk": None}),
  "exit 2 with a red vitest field": (2, {"vitest": {"ok": False}}),
  "our 124 kill with a red vitest field": (124, {"vitest": {"ok": False}}),
}
print(json.dumps({k: ma.gate_failed(c, res) for k, (c, res) in rows.items()}))`);
    expect(r).toEqual({
      'vitest red': true,
      'browser red again on the retry': true,
      'browser killed at 30 minutes (no retry)': true,
      'page walk new failure': true,
      'browser died with no failing test (web server)': false,
      'flaky then green, then a later refusal': false,
      'exit 2 with a red vitest field': false,
      'our 124 kill with a red vitest field': false,
    });
  });

  it('R9: one failed card re-read is retried on the next run, not six hours later', () => {
    const r = drive(`
GET_FAIL[0] = 1
code, out = cmd_run()
at(0.5)
code2, out2 = cmd_run()
print(json.dumps({"done": out["done"][0], "done2": out2["done"][0]}))`);
    expect(r.done).toMatchObject({ result: 'error', kind: 'card-unreadable', retryAt: '2026-11-06T09:00:00Z' });
    expect(r.done.why).toMatch(/tries again by itself on its next run \(try 1 of 4/);
    expect(r.done2).toMatchObject({ action: 'merge', result: 'merged' });
  });
});

describe('G (R8, R10): the edit path and the words', () => {
  it('R8: the same words asked again with a new verdict are filed again, and the card says so truthfully', () => {
    const r = drive(`
CARDS[:] = [C(outcome="Changes requested", feedback="Rename the invented helper.")]
cmd_run()
first = len(ADDS)
kevin(outcome="Changes requested", approvedAt="2026-11-07T09:00:00.000Z", feedback="Rename the invented helper.", status="Today")
at(24)
code, out = cmd_run()
print(json.dumps({"first": first, "second": len(ADDS), "code": code, "notes": NOTES}))`);
    expect(r.first).toBe(1);
    expect(r.second).toBe(2);
    expect(r.notes.filter((n) => n.startsWith('MERGE CARD NOT MERGED:'))).toHaveLength(2);
    expect(r.notes[1]).toMatch(/It went to the fixer \(20261106-merge-approved-002\)/);
  });

  it('R8: the finding files but the Notes write fails: the next run writes the note and files nothing more', () => {
    const r = drive(`
CARDS[:] = [C(outcome="Changes requested", feedback="Rename the invented helper.")]
real_py = ma.py
def flaky(script, *args, **k):
    if script == "agent-dispatch.py" and args[0] == "annotate" and FLAKY[0]:
        FLAKY[0] -= 1
        return subprocess.CompletedProcess([script], 1, "", "Airtable 503 (invented)")
    return real_py(script, *args, **k)
FLAKY = [2]
ma.py = flaky
codes = []
for h in (0, 0.5, 1, 1.5):
    at(h); codes.append(cmd_run()[0])
print(json.dumps({"codes": codes, "adds": len(ADDS), "notes": NOTES, "card": [card("recCardAaaaaaaaaa")["status"], card("recCardAaaaaaaaaa")["outcome"]]}))`);
    expect(r.adds).toBe(1);                                  // ONE finding for ONE request
    expect(r.codes.slice(0, 2)).toEqual([1, 1]);
    expect(r.codes[2]).toBe(0);
    expect(r.notes.filter((n) => n.includes('20261106-merge-approved-001'))).toHaveLength(1);
    expect(r.card).toEqual(['Approval', '']);
  });

  it('R10: a changed status reads "the card\'s status changed", never "the card\'s its status"', () => {
    const r = drive(`
probe = C()
kevin(status="Completed")
print(json.dumps({"why": ma.card_moved_on(probe)}))`);
    expect(r.why).toBe("the card's status changed (Today, now Completed)");
  });
});

describe('H (T): the eight breaks the review found no test for', () => {
  it('B2: the re-read sees a changed STATUS alone (verdict, Approved At and head the same): nothing merges', () => {
    const r = drive(`
probe = C()
kevin(status="Approval")
moved = ma.card_moved_on(probe)
# Through the robot: the run read status Today; Airtable holds Approval by the time of the merge.
MC.list_cards = lambda read=None: [C(status="Today")]
CARDS[:] = [C(status="Approval")]
code, out = cmd_run()
print(json.dumps({"moved": moved, "done": out["done"][0], "real": real_merges()}))`);
    expect(r.moved).toBe("the card's status changed (Today, now Approval)");
    expect(r.done.result).toBe('skip');
    expect(r.real).toEqual([]);
  });

  it('B6: the re-read refuses a card whose body is no longer the MERGE card (approve line gone), all else the same', () => {
    const r = drive(`
probe = C()
card("recCardAaaaaaaaaa")["agentOutput"] = BASE["agentOutput"].replace("If you approve, the robot runs merge-pr.py and the deploy, nothing else.", "DECIDE: something else")
print(json.dumps({"moved": ma.card_moved_on(probe)}))`);
    expect(r.moved).toBe('the card is not a MERGE card any more (its work no longer carries the line Kevin approved)');
  });

  it('B8: the REAL get_card, through the REAL Airtable client, against a fake Airtable over local HTTP', () => {
    const home = mkdtempSync(join(tmpdir(), 'od-ma-home-'));
    mkdirSync(join(home, '.config', 'od'), { recursive: true });
    writeFileSync(join(home, '.config', 'od', 'airtable_pat'), 'invented-token\n');
    const r = run(GUARD + `
import importlib.util, json, sys, threading, http.server, urllib.parse
sys.path.insert(0, ${JSON.stringify(S(''))})
import urllib.request as UR
import merge_card as MC
spec = importlib.util.spec_from_file_location("ma", ${JSON.stringify(S('merge-approved.py'))})
ma = importlib.util.module_from_spec(spec); spec.loader.exec_module(ma)
F = MC.F
REC = {"id": "recCardAaaaaaaaaa", "createdTime": "2026-11-06T08:00:00.000Z", "fields": {
    F["name"]: "MERGE: PR #812 — fix", F["status"]: "Today", F["approvalOutcome"]: "Approved as-is",
    F["approvedAt"]: "2026-11-06T08:30:00.000Z", F["agentOutput"]: ${JSON.stringify(OUTPUT)}, F["sentForApprovalBy"]: ["${BUILDER}"]}}
NAMES = {F["name"]: "Task Name", F["status"]: "Status", F["approvalOutcome"]: "Approval Outcome",
         F["approvedAt"]: "Approved At", F["agentOutput"]: "Agent Output", F["sentForApprovalBy"]: "Sent For Approval By"}
SEEN = []
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        SEEN.append([u.path, u.query, self.headers.get("Authorization")])
        if u.path != "/v0/appnqjDpqDniH3IRl/tblqB8b22hKBL4PF1/recCardAaaaaaaaaa":
            self.send_response(404); self.end_headers(); self.wfile.write(b'{"error": "NOT_FOUND"}'); return
        byid = "returnFieldsByFieldId=true" in u.query
        body = dict(REC, fields=REC["fields"] if byid else {NAMES[k]: v for k, v in REC["fields"].items()})
        out = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(out)
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
OPEN = UR.build_opener(UR.ProxyHandler({}))
def local_only(req, timeout=None):
    url = req.full_url
    assert url.startswith("https://api.airtable.com/"), url
    req.full_url = url.replace("https://api.airtable.com", "http://127.0.0.1:%d" % srv.server_port)
    return OPEN.open(req, timeout=timeout)
UR.urlopen = local_only
probe = {"id": "recCardAaaaaaaaaa", "pr": 812, "status": "Today", "outcome": "Approved as-is",
         "approvedAt": "2026-11-06T08:30:00.000Z", "head": "${HEAD}"}
got = MC.get_card("recCardAaaaaaaaaa")
same = ma.card_moved_on(probe)
REC["fields"][F["approvalOutcome"]] = "Rejected"
changed = ma.card_moved_on(probe)
try:
    MC.get_card("recMissingAaaaaaa"); missing = "read"
except RuntimeError as e:
    missing = str(e)
srv.shutdown()
print(json.dumps({"got": [got["pr"], got["status"], got["outcome"], got["approvedAt"], got["head"]], "same": same,
                  "changed": changed, "missing": missing, "seen": SEEN}))`, { HOME: home });
    expect(r.got).toEqual([812, 'Today', 'Approved as-is', '2026-11-06T08:30:00.000Z', HEAD]);
    expect(r.same).toBe('');                                  // a live card reads as unchanged, so cards can merge
    expect(r.changed).toBe("the card's verdict changed (Approved as-is, now Rejected)");
    expect(r.missing).toMatch(/^Airtable GET \/tblqB8b22hKBL4PF1\/recMissingAaaaaaa -> HTTP 404/);
    expect(r.seen[0]).toEqual(['/v0/appnqjDpqDniH3IRl/tblqB8b22hKBL4PF1/recCardAaaaaaaaaa', 'returnFieldsByFieldId=true', 'Bearer invented-token']);
  });

  it('C1, C3, C4: a flaky-then-green browser, exit 2 and our 124 kill are never reds, even with a red vitest field', () => {
    const r = drive(`
print(json.dumps([
  ma.gate_failed(1, {"vitest": {"ok": True}, "browser": {"ok": False, "okAfterRetry": True, "retry": {"retried": 1}}}),
  ma.gate_failed(2, {"vitest": {"ok": False}}),
  ma.gate_failed(124, {"vitest": {"ok": False}}),
  ma.gate_failed(1, {"vitest": {"ok": False}}),
]))`);
    expect(r).toEqual([false, false, false, true]);
  });

  it('D1: --detach with ONLY a bad record queues a run and exits 0 (it used to exit 1 every poll and do nothing)', () => {
    const r = drive(`
ma.save_attempts({"812": ["red"]})
print(json.dumps(list(detach())))`);
    expect(r[0]).toBe(0);
    expect(r[1].todo).toEqual([812]);
    expect(r[1].badRecords[0].why).toMatch(/is not an object/);
  });

  it('E2: a moved stop never reuses an error stop\'s finding, even when the error record kept the moved count', () => {
    const r = drive(`
gh(812).update(headRefOid="${NEWHEAD}")
ma.save_attempts({"812": {"result": "error", "errKind": "pr-unreadable", "errTries": 4, "finding": "20261101-merge-approved-900",
                          "head": "${HEAD}", "newHead": "${NEWHEAD}", "movedTries": 3, "lastMovedAt": "2026-11-06T02:00:00Z",
                          "approvedAt": "2026-11-06T08:30:00.000Z", "at": "2026-11-06T02:00:00Z", "lastErrAt": "2026-11-06T02:00:00Z", "reds": 0}})
code, out = cmd_run()
print(json.dumps({"done": out["done"][0], "att": att()["812"], "adds": [title(a) for a in ADDS]}))`);
    expect(r.att).toMatchObject({ result: 'moved', movedTries: 4, finding: '20261106-merge-approved-001' });
    expect(r.adds).toEqual(["PR #812's new code failed 4 re-tests after its MERGE card; the robot stopped"]);
  });
});
