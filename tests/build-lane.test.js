import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LANE = resolve(ROOT, 'scripts/build-lane.py');
const FINDINGS = resolve(ROOT, 'scripts/findings.py');

// AN APPROVED BUILD GETS BUILT (Kevin, 20 Nov 2026). Approving a Build card built nothing: the
// hand-back run filed a finding and kept the task open, and the fault fixer (2 closed that day,
// 391 open) never reached one. Ten approved builds were open, the oldest from 30 Sep; one ranked
// 347th of 378. These tests drive the real build-lane.py and findings.py against a temp findings
// queue, with the task reads, the dispatcher's CLI and GitHub stubbed: every dispatcher call lands
// in CALLS, every task read comes from TASKS.
function lane(snippet, queue = '') {
  const dir = mkdtempSync(join(tmpdir(), 'build-lane-'));
  const file = join(dir, 'findings.jsonl');
  writeFileSync(file, queue);
  const script = `
import importlib.util, json, sys, io, contextlib
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location('bl', ${JSON.stringify(LANE)})
bl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bl)
m = bl.ad()
AF = m.AF
TASKS, CALLS, PRS = {}, [], {}
def task(i, name="BUILD: a thing", ttype="Build", outcome="Approved as-is", status="Today",
         approved="2026-11-18T10:00:00.000Z", created="2026-09-01T09:00:00.000Z", sent=True, hard=False, notes=""):
    f = {AF["name"]: name, AF["status"]: status, AF["approvalOutcome"]: outcome, AF["approvedAt"]: approved,
         AF["notes"]: notes, AF["agentOutput"]: "PLAN for " + i}
    if ttype: f[AF["taskType"]] = ttype
    if sent: f[AF["sentForApprovalBy"]] = ["recAgentAaaaaaaaa"]
    if hard: f[m.HARD_DEADLINE_FIELD] = True
    TASKS[i] = {"id": i, "createdTime": created, "fields": f}
def _read(i):
    if i not in TASKS: raise RuntimeError("Airtable GET -> HTTP 404")
    return json.loads(json.dumps(TASKS[i]))
def _dispatch(args):
    CALLS.append(list(args))
    if args[0] == "complete": TASKS[args[1]]["fields"][AF["status"]] = "Completed"
    return 0, "{}", ""
bl.read_task = _read
bl.dispatch_cli = _dispatch
bl.github_pr = lambda n: PRS[n]
class A:
    def __init__(self, **kw): self.__dict__.update(kw)
def run(fn, **kw):
    out, err = io.StringIO(), None
    try:
        with contextlib.redirect_stdout(out):
            fn(A(**kw))
    except SystemExit as e:
        err = str(e)
    return {"out": out.getvalue(), "err": err}
def state(): return bl.findings.current_state()
def lane_rows(): return [dict(id=r["id"], task=r.get("build_task"), status=r.get("status")) for r in bl.lane(state())]
${snippet}
`;
  const out = execFileSync('python3', ['-c', script], {
    encoding: 'utf8', env: { ...process.env, FINDINGS_FILE: file, FINDINGS_OVERFLOW_FILE: join(dir, 'ofl.jsonl') },
  });
  return { ...JSON.parse(out.trim().split('\n').pop()), file, dir };
}

function line(rec) { return JSON.stringify(rec) + '\n'; }

describe('request: an approved Build card goes in the lane and rests on its wall', () => {
  it('files one build finding that names the task, and walls the task on it', () => {
    const r = lane(`
task("recBuildAaaaaaaaa")
res = run(bl.cmd_request, task="recBuildAaaaaaaaa", finding="")
print(json.dumps({"res": res, "lane": lane_rows(), "calls": CALLS}))`);
    expect(r.res.err).toBeNull();
    expect(r.lane).toHaveLength(1);
    expect(r.lane[0]).toMatchObject({ task: 'recBuildAaaaaaaaa', status: 'open' });
    const block = r.calls.find(c => c[0] === 'block');
    expect(block).toEqual(['block', 'recBuildAaaaaaaaa', '--kind', 'TOOL', '--subject', 'approved build',
      '--why', expect.stringContaining('Kevin approved this build on 2026-11-18'), '--finding', r.lane[0].id]);
    expect(JSON.parse(r.res.out)).toMatchObject({ queued: true, finding: r.lane[0].id });
  });

  it('a name that starts BUILD: counts whatever the Task Type, and asking twice files nothing new', () => {
    const r = lane(`
task("recBuildAaaaaaaaa", name="BUILD: weekly swaps", ttype="Analysis")
a = run(bl.cmd_request, task="recBuildAaaaaaaaa", finding="")
b = run(bl.cmd_request, task="recBuildAaaaaaaaa", finding="")
print(json.dumps({"a": a, "b": b, "lane": lane_rows()}))`);
    expect(r.a.err).toBeNull();
    expect(r.b.err).toBeNull();
    expect(r.lane).toHaveLength(1);
    expect(JSON.parse(r.b.out).reused).toBe(true);
  });

  it('refuses work Kevin has not approved, a forged approval, a non-build, a MERGE card and a closed task', () => {
    const r = lane(`
task("recNotApprovedaaa", outcome="")
task("recForgedaaaaaaaa", sent=False)
task("recCopiedaaaaaaaa", approved="2026-08-01T00:00:00.000Z")
task("recAnalysisaaaaaa", name="Look at the rent", ttype="Analysis")
task("recMergeCardaaaaa", name="MERGE: PR #12 — Queue fixer")
task("recClosedaaaaaaaa", status="Completed")
out = {i: run(bl.cmd_request, task=i, finding="")["err"] for i in TASKS}
print(json.dumps({"out": out, "lane": lane_rows(), "calls": CALLS}))`);
    expect(r.out.recNotApprovedaaa).toMatch(/Kevin has not approved it/);
    expect(r.out.recForgedaaaaaaaa).toMatch(/not a real one: it never went through the approval gate/);
    expect(r.out.recCopiedaaaaaaaa).toMatch(/earlier than the task itself/);
    expect(r.out.recAnalysisaaaaaa).toMatch(/not a Build card/);
    expect(r.out.recMergeCardaaaaa).toMatch(/MERGE card/);
    expect(r.out.recClosedaaaaaaaa).toMatch(/Completed/);
    expect(r.lane).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
  });

  it('adopts the finding an older carry-out filed, and a fault-fixer deferral comes back open', () => {
    const q = line({ op: 'add', id: '20261116-agent-dispatch-1331', ts: '2026-11-16T16:35:51Z', routine: 'agent-dispatch',
      severity: 'medium', title: 'Build approved twice: eBay search', where: 'scripts/ebay-search.py', touches_code: true })
      + line({ op: 'close', id: '20261116-agent-dispatch-1331', ts: '2026-11-17T07:00:00Z', outcome: 'deferred', note: 'too big' });
    const r = lane(`
task("recDPkv36UXe8QDD9")
res = run(bl.cmd_request, task="recDPkv36UXe8QDD9", finding="20261116-agent-dispatch-1331")
print(json.dumps({"res": res, "lane": lane_rows(), "calls": CALLS}))`, q);
    expect(r.res.err).toBeNull();
    expect(r.lane).toEqual([{ id: '20261116-agent-dispatch-1331', task: 'recDPkv36UXe8QDD9', status: 'open' }]);
    expect(r.calls[0]).toContain('20261116-agent-dispatch-1331');
  });

  it('after the slot could not build it, asks for a revised card; a new approval queues it again', () => {
    const q = line({ op: 'add', id: '20261120-build-lane-1', ts: '2026-11-19T00:00:00Z', routine: 'build-lane',
      severity: 'high', title: 'Approved build: x', where: 'the plan Kevin approved on task recBuildAaaaaaaaa',
      touches_code: true, build_task: 'recBuildAaaaaaaaa' })
      + line({ op: 'close', id: '20261120-build-lane-1', ts: '2026-11-20T08:00:00Z', outcome: 'rejected',
        note: 'CANNOT BUILD AS APPROVED: the plan needs a paid API key' });
    const r = lane(`
task("recBuildAaaaaaaaa", approved="2026-11-18T10:00:00.000Z")
before = run(bl.cmd_request, task="recBuildAaaaaaaaa", finding="")
TASKS["recBuildAaaaaaaaa"]["fields"][AF["approvedAt"]] = "2026-11-21T10:00:00.000Z"
after = run(bl.cmd_request, task="recBuildAaaaaaaaa", finding="")
print(json.dumps({"before": before, "after": after, "lane": lane_rows()}))`, q);
    expect(r.before.err).toMatch(/could not build it as approved.*paid API key.*revised plan card/);
    expect(r.after.err).toBeNull();
    expect(r.lane.filter(x => x.status === 'open')).toHaveLength(1);
  });
});

describe('worklist: approved builds are the build slot\'s, never in the fault sections', () => {
  it('lists a build under APPROVED BUILDS even when it sits on a TOOL wall, and leaves it out of BLOCKING and THE REST', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-lane-wl-'));
    const q = join(dir, 'q.jsonl');
    writeFileSync(q,
      line({ op: 'add', id: 'b-1', ts: '2026-11-19T00:00:00Z', routine: 'build-lane', severity: 'high',
        title: 'Approved build: eBay search', where: 'task recDPkv36UXe8QDD9', touches_code: true, build_task: 'recDPkv36UXe8QDD9' })
      + line({ op: 'add', id: 'f-1', ts: '2026-11-19T00:00:00Z', routine: 'agent-dispatch', severity: 'high',
        title: 'Agent blocked: a fault', where: 'x', touches_code: true })
      + line({ op: 'add', id: 'f-2', ts: '2026-11-19T00:00:00Z', routine: 'agent-dispatch', severity: 'low',
        title: 'Some other fault', where: 'y', touches_code: true }));
    const blockers = join(dir, 'blockers.json');
    writeFileSync(blockers, JSON.stringify({ openTasksRead: true, readAt: '2026-11-20T08:00:00Z', open: [
      { kind: 'TOOL', task: 'recDPkv36UXe8QDD9', finding: 'b-1', days: 2 },
      { kind: 'TOOL', task: 'recOtherTaskaaaaa', finding: 'f-1', days: 1 }] }));
    const env = { ...process.env, FINDINGS_FILE: q, FINDINGS_OVERFLOW_FILE: join(dir, 'o.jsonl') };
    const text = execFileSync('python3', [FINDINGS, 'worklist', '--blockers', blockers], { encoding: 'utf8', env });
    const json = JSON.parse(execFileSync('python3', [FINDINGS, 'worklist', '--blockers', blockers, '--json'], { encoding: 'utf8', env }));
    expect(text.split('\n')[0]).toMatch(/^BLOCKING: 1 finding/);   // the first line the fixer reads is unchanged
    expect(text).toMatch(/APPROVED BUILDS: 1 build\(s\)[^\n]*\n  b-1  task recDPkv36UXe8QDD9/);
    expect(json.builds.map(b => [b.finding, b.task])).toEqual([['b-1', 'recDPkv36UXe8QDD9']]);
    expect(json.blocking.map(b => b.finding)).toEqual(['f-1']);
    expect(json.rest.map(r => r.id)).toEqual(['f-2']);
  });

  it('build-tag adopts a finding once, and refuses a second task or a closed finding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'build-lane-tag-'));
    const q = join(dir, 'q.jsonl');
    writeFileSync(q, line({ op: 'add', id: 'f-1', ts: '2026-11-19T00:00:00Z', routine: 'agent-dispatch', severity: 'high', title: 't', where: 'w' })
      + line({ op: 'add', id: 'f-2', ts: '2026-11-19T00:00:00Z', routine: 'agent-dispatch', severity: 'high', title: 't2', where: 'w2' })
      + line({ op: 'close', id: 'f-2', ts: '2026-11-19T01:00:00Z', outcome: 'fixed', evidence: 'abc' }));
    const env = { ...process.env, FINDINGS_FILE: q };
    const tag = (...a) => { try { execFileSync('python3', [FINDINGS, 'build-tag', ...a], { encoding: 'utf8', env, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
    expect(tag('f-1', '--task', 'recBuildAaaaaaaaa')).toBe(0);
    expect(tag('f-1', '--task', 'recBuildAaaaaaaaa')).toBe(0);     // asking again is a no-op
    expect(tag('f-1', '--task', 'recOtherTaskaaaaa')).toBe(2);     // one finding builds one task
    expect(tag('f-2', '--task', 'recOtherTaskaaaaa')).toBe(2);     // a landed fix is not a build waiting
    expect(readFileSync(q, 'utf8').split('\n').filter(l => l.includes('"op": "build"'))).toHaveLength(1);
  });
});

describe('next: one build at a time, deadline first, then the oldest approval', () => {
  const q = ['A', 'B', 'C', 'D'].map((x, n) => line({ op: 'add', id: `b-${x}`, ts: `2026-11-1${n}T00:00:00Z`, routine: 'build-lane',
    severity: 'high', title: `Approved build ${x}`, where: `task ${x}`, touches_code: true, build_task: `recBuild${x}aaaaaaaa` })).join('');

  it('takes the Hard Deadline build first, then the oldest approval; drops a closed task; says what it could not read', () => {
    const r = lane(`
task("recBuildAaaaaaaaa", approved="2026-10-01T00:00:00.000Z")
task("recBuildBaaaaaaaa", approved="2026-11-18T00:00:00.000Z", hard=True)
task("recBuildCaaaaaaaa", status="Completed")
out = bl.plan_next(state(), lambda i: bl.view(bl.read_task(i)))
print(json.dumps(out))`, q);
    expect(r.take.task).toBe('recBuildBaaaaaaaa');
    expect(r.queue.map(x => x.task)).toEqual(['recBuildBaaaaaaaa', 'recBuildAaaaaaaaa']);
    expect(r.drop.map(x => x.task)).toEqual(['recBuildCaaaaaaaa']);
    expect(r.unread.map(x => x.task)).toEqual(['recBuildDaaaaaaaa']);
    expect(r.orderChecked).toBe(false);
  });

  it('takes nothing new while a build is being worked', () => {
    const claimed = q + line({ op: 'claim', id: 'b-C', ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), by: 'build-slot' });
    const r = lane(`
for x in "ABCD": task("recBuild%saaaaaaaa" % x)
print(json.dumps(bl.plan_next(state(), lambda i: bl.view(bl.read_task(i)))))`, claimed);
    expect(r.take).toBeNull();
    expect(r.inProgress.map(x => x.finding)).toEqual(['b-C']);
  });
});

describe('finish: the task closes only on a merged PR, with the PR as proof', () => {
  const add = line({ op: 'add', id: 'b-1', ts: '2026-11-19T00:00:00Z', routine: 'build-lane', severity: 'high',
    title: 'Approved build', where: 'task', touches_code: true, build_task: 'recBuildAaaaaaaaa' });

  it('writes BUILT with the PR and merge commit, then completes', () => {
    const q = add + line({ op: 'close', id: 'b-1', ts: '2026-11-20T08:00:00Z', outcome: 'pending', pr: '1001' })
      + line({ op: 'land', id: 'b-1', ts: '2026-11-20T08:30:00Z', pr: '1001' });
    const r = lane(`
task("recBuildAaaaaaaaa")
PRS[1001] = {"merged": True, "mergeCommit": "abcdef1234567890", "url": "https://github.com/x/y/pull/1001", "state": "closed"}
res = run(bl.cmd_finish, task="recBuildAaaaaaaaa", changed="")
print(json.dumps({"res": res, "calls": CALLS}))`, q);
    expect(r.res.err).toBeNull();
    expect(r.calls[0][0]).toBe('annotate');
    expect(r.calls[0][3]).toMatch(/^BUILT: PR #1001 merged, commit abcdef123456 \(https:\/\/github.com\/x\/y\/pull\/1001\)/);
    expect(r.calls[1]).toEqual(['complete', 'recBuildAaaaaaaaa']);
  });

  it('refuses while the PR waits, when GitHub says it did not merge, and after the slot sent it back', () => {
    const pending = add + line({ op: 'close', id: 'b-1', ts: '2026-11-20T08:00:00Z', outcome: 'pending', pr: '1002' });
    const notMerged = add + line({ op: 'land', id: 'b-1', ts: '2026-11-20T08:30:00Z', pr: '1003' });
    const rejected = add + line({ op: 'close', id: 'b-1', ts: '2026-11-20T08:00:00Z', outcome: 'rejected', note: 'CANNOT BUILD AS APPROVED: needs a key' });
    const snippet = `
task("recBuildAaaaaaaaa")
PRS[1003] = {"merged": False, "mergeCommit": "", "url": "", "state": "closed"}
res = run(bl.cmd_finish, task="recBuildAaaaaaaaa", changed="")
print(json.dumps({"res": res, "calls": CALLS}))`;
    const a = lane(snippet, pending);
    const b = lane(snippet, notMerged);
    const c = lane(snippet, rejected);
    expect(a.res.err).toMatch(/waits on PR #1002/);
    expect(b.res.err).toMatch(/PR #1003 is closed on GitHub/);
    expect(c.res.err).toMatch(/needs a key.*revised plan card/);
    for (const x of [a, b, c]) expect(x.calls).toEqual([]);
  });
});

describe('the skills that run the lane say so', () => {
  const skill = (n) => readFileSync(resolve(ROOT, '.claude/scheduled-tasks', n, 'SKILL.md'), 'utf8');
  it('the dispatcher carries an approved Build out through the lane and closes it with finish', () => {
    const s = skill('agent-dispatch');
    expect(s).toMatch(/build-lane\.py request TASKID/);
    expect(s).toMatch(/build-lane\.py finish TASKID/);
  });
  it('daily-ops runs one build after the report, and the fixer has the build slot', () => {
    expect(skill('daily-ops')).toMatch(/## Phase 6 — Build/);
    expect(skill('daily-ops')).toMatch(/build-lane\.py next/);
    expect(skill('queue-fixer')).toMatch(/## BUILD SLOT/);
  });
  it('the lane script exists where the skills call it', () => {
    expect(existsSync(LANE)).toBe(true);
  });
});
