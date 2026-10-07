import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const S = (f) => resolve(ROOT, 'scripts', f);

// A PROTECTED-PATH FIX GETS A MERGE CARD, NOT A DEAD END (Kevin, 7 Oct 2026; PR 2 of 5).
// 19 tasks sat on TOOL walls whose fixes needed a protected file: the fixer could write them,
// fixer-merge.py would never merge them, and none of the 18 findings was ever claimed. Now a
// green protected PR raises ONE card in Kevin's queue, and scripts/merge-approved.py (no model)
// merges exactly the head he approved, lands its findings, and the sweep wakes the walls. Every
// network call is stubbed; every name is invented (this repo is public).
const run = (code, env = {}) => JSON.parse(execFileSync('python3', ['-c', code], {
  encoding: 'utf8', env: { ...process.env, ...env } }).trim().split('\n').pop());
const load = (name, file) => `
import importlib.util, json, sys, os, io, contextlib, argparse, subprocess
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location(${JSON.stringify(name)}, ${JSON.stringify(S(file))})
${name} = importlib.util.module_from_spec(spec); spec.loader.exec_module(${name})
`;
const HEAD = 'a1b2c3d4'.repeat(5);
const NEWHEAD = 'f0e1d2c3'.repeat(5);
const BUILDER = 'recQkO6BA4w5zqwZ4';
const OUTPUT = `MERGE CARD: PR #812, fix: retype\nhttps://example.test/pull/812\nTested head: ${HEAD}\n\nFindings it closes:\n- 20261001-agent-dispatch-901: Agent blocked: retype\n\n**Carrying this out will involve:** If you approve, the robot runs merge-pr.py and the deploy, nothing else.`;

describe('the card itself (scripts/merge_card.py)', () => {
  it('names the PR exactly, records the tested head, and lists only the findings under its own heading', () => {
    const r = run(load('mc', 'merge_card.py') + `
gate = {"vitest": {"ok": True, "tail": "Tests 1900 passed"}, "browser": {"ok": True, "tail": "512 passed"}}
f = mc.card_fields(712, "fix: the runner allows osascript", "https://example.test/pull/712",
                   [("20261001-agent-dispatch-901", "Agent blocked: osascript denied")],
                   ["scripts/agent-settings.json", "tests/x.test.js"], ["scripts/agent-settings.json"], gate, "2026-10-07", "${HEAD}")
out = f[mc.F["agentOutput"]]
v = mc.card_view({"id": "recX", "fields": {mc.F["name"]: f[mc.F["name"]], mc.F["agentOutput"]: out}})
print(json.dumps({"name": f[mc.F["name"]], "status": f[mc.F["status"]], "sent": f[mc.F["sentForApprovalBy"]],
                  "team": f[mc.F["teamMember"]], "out": out, "findings": mc.card_findings(out + "\\nTest tail mentions 20260101-other-999"),
                  "pr": [mc.pr_number(f[mc.F["name"]]), mc.pr_number("MERGE: PR #71 — x"), mc.pr_number("Re: MERGE: PR #712"), mc.pr_number("MERGE: PR #7123x")],
                  "plain": f[mc.PLAIN_SUMMARY], "head": v["head"]}))`);
    expect(r.name).toBe('MERGE: PR #712 — fix: the runner allows osascript');
    expect(r.status).toBe('Approval');
    expect(r.sent).toEqual([BUILDER]);
    expect(r.team).toEqual([BUILDER]);
    expect(r.out).toContain('https://example.test/pull/712');
    expect(r.out).toContain(`Tested head: ${HEAD}`);
    expect(r.head).toBe(HEAD);
    expect(r.out).toContain('- 20261001-agent-dispatch-901: Agent blocked: osascript denied');
    expect(r.out).toContain('- scripts/agent-settings.json (protected)');
    expect(r.out).toContain('Test result: GREEN on origin/main with this PR merged in. vitest: Tests 1900 passed. Browser suite: 512 passed.');
    expect(r.out).toMatch(/\*\*Carrying this out will involve:\*\* If you approve, the robot runs merge-pr\.py and the deploy, nothing else\.$/);
    expect(r.findings).toEqual(['20261001-agent-dispatch-901']);
    expect(r.pr).toEqual([712, 71, null, null]);
    expect(r.plain).toMatch(/^TASK: Merge the robot's fix in PR #712 .*\nIF YOU APPROVE: If you approve, the robot runs merge-pr\.py/);
  });

  it('its field ids match js/config.js TASK_FIELDS and its Builder is the dispatch roster\'s worker-builder', () => {
    const cfg = readFileSync(resolve(ROOT, 'js/config.js'), 'utf8');
    const block = cfg.match(/const TASK_FIELDS = \{([\s\S]*?)\n\s*\};/)[1];
    const ids = Object.fromEntries([...block.matchAll(/(\w+):\s*'(fld\w+)'/g)].map((m) => [m[1], m[2]]));
    const r = run(load('mc', 'merge_card.py') + load('d', 'agent-dispatch.py') + `
print(json.dumps({"F": mc.F, "builder": [k for k, v in d.ALL_AGENTS.items() if v.get("agent") == "worker-builder"],
                  "mine": mc.BUILDER_TM, "plain": mc.PLAIN_SUMMARY == d.AF["plainSummary"]}))`);
    let overlap = 0;
    for (const [k, id] of Object.entries(r.F)) {
      if (!(k in ids)) continue;
      overlap += 1;
      expect(id, `merge_card.F.${k}`).toBe(ids[k]);
    }
    expect(overlap).toBeGreaterThanOrEqual(12);
    expect(r.builder).toEqual([r.mine]);
    expect(r.plain).toBe(true);
  });

  it('a card whose body was replaced (a DECIDE:, a CLOSE PROPOSAL), lost its head, or was sent by another agent is not a card', () => {
    const r = run(load('mc', 'merge_card.py') + `
base = {"pr": 812, "agentOutput": ${JSON.stringify(OUTPUT)}, "head": "${HEAD}", "fields": {mc.F["sentForApprovalBy"]: ["${BUILDER}"]}}
print(json.dumps([mc.card_body_problem(base),
  mc.card_body_problem(dict(base, agentOutput="DECIDE: close PR #812?\\n\\nEARLIER:\\n" + base["agentOutput"])),
  mc.card_body_problem(dict(base, agentOutput="CLOSE PROPOSAL: not needed")),
  mc.card_body_problem(dict(base, pr=813)),
  mc.card_body_problem(dict(base, agentOutput=base["agentOutput"].replace("nothing else.", ""))),
  mc.card_body_problem(dict(base, head="")),
  mc.card_body_problem(dict(base, fields={mc.F["sentForApprovalBy"]: ["recOtherAgentAaaa"]}))]))`);
    expect(r[0]).toBe('');
    expect(r[1]).toMatch(/does not open with the MERGE CARD line/);
    expect(r[2]).toMatch(/does not open with the MERGE CARD line/);
    expect(r[3]).toMatch(/for PR #813/);
    expect(r[4]).toMatch(/no longer carries the line Kevin approved/);
    expect(r[5]).toMatch(/does not record the PR head/);
    expect(r[6]).toMatch(/not sent for approval by the Builder/);
  });

  it('finds an existing card for the exact PR at any status, and reads the protected list from fixer-merge.py itself', () => {
    const r = run(load('mc', 'merge_card.py') + `
rows = [{"id": "recA", "fields": {mc.F["name"]: "MERGE: PR #712 — x", mc.F["status"]: "Completed"}},
        {"id": "recB", "fields": {mc.F["name"]: "MERGE: PR #7120 — y"}}]
calls = []
def read(formula, fields=None): calls.append(formula); return rows
print(json.dumps({"hit": (mc.existing_card(712, read=read) or {}).get("id"), "miss": mc.existing_card(71, read=read),
                  "formula": calls[0], "named": [mc.protected_named("node missing; edit agent-dispatch.py"),
                  mc.protected_named("vitest.config.js is fine"), mc.protected_named("the slack worker scripts/slack-automation/approvals.js"),
                  mc.protected_named("os/tasks/index.html broke"), mc.protected_named("workers/x/config.js"),
                  mc.protected_named("the index.html page"), mc.protected_named("nothing protected here")]}))`);
    expect(r.hit).toBe('recA');
    expect(r.miss).toBeNull();
    expect(r.formula).toBe("FIND('MERGE: PR #712 ', {Task Name})=1");
    expect(r.named).toEqual(['scripts/agent-dispatch.py', '', 'scripts/slack-automation/', '', '', '', '']);
  });
});

describe('fixer-merge.py: a green protected PR raises ONE card and never merges', () => {
  const drive = (prelude) => run(load('fm', 'fixer-merge.py') + `
import merge_card, findings
CREATED, SH, PATCHED, GATES = [], [], [], []
fm.decide = lambda pr: {"pr": pr, "files": 2, "protected": [{"file": "scripts/agent-dispatch.py", "rule": "scripts/agent-dispatch.py"}], "mayAutoMerge": False}
fm.build_merge_result = lambda pr: ("/tmp/od-fm-tree", None)
fm.destroy_merge_result = lambda p: None
fm.tests_cannot_run = lambda tree: None
fm.tested_head = lambda pr: "${HEAD}"
def gate(cwd):
    GATES.append(cwd)
    return True, {"testedTree": cwd, "vitest": {"ok": True, "tail": "ok 10"}, "browser": {"ok": True, "tail": "ok 5"}}
fm.run_gate = gate
fm.pr_facts = lambda pr: ("fix: retype an approved task", "https://example.test/pull/%d" % pr, ["scripts/agent-dispatch.py", "tests/a.test.js"], "${HEAD}")
merge_card.existing_card = lambda pr, read=None: None
merge_card.create_card = lambda fields, run=None: (CREATED.append(fields), "recNewCardAaaaaa")[1]
merge_card.patch_card = lambda task, fields: PATCHED.append([task, fields])
findings.current_state = lambda: {"20261001-agent-dispatch-901": {"id": "20261001-agent-dispatch-901", "status": "pending", "pr": "812", "title": "Agent blocked: retype"},
                                  "20261001-agent-dispatch-902": {"id": "20261001-agent-dispatch-902", "status": "pending", "pr": "999", "title": "other"}}
def sh(args, cwd=None, timeout=1800):
    SH.append(" ".join(args)); return subprocess.CompletedProcess(args, 0, '{"state": "OPEN"}', "")
fm.sh = sh
OLD = {"id": "recOldCardAaaaaa", "status": "Approval", "head": "${HEAD}", "notes": "", "agentOutput": ""}
${prelude}
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = fm.cmd_merge(argparse.Namespace(pr=812))
out = json.loads(buf.getvalue())
print(json.dumps({"code": code, "out": out, "created": CREATED, "patched": PATCHED, "gates": len(GATES),
                  "merged": any(s.startswith("gh pr merge") for s in SH)}))`);

  it('green: one card with the findings pending on THIS PR, the files, the result and the tested head; no merge call', () => {
    const r = drive('');
    expect(r.code).toBe(0);
    expect(r.merged).toBe(false);
    expect(r.out.merged).toBe(false);
    expect(r.out.mergeCard).toEqual({ task: 'recNewCardAaaaaa', already: false, findings: ['20261001-agent-dispatch-901'] });
    expect(r.created).toHaveLength(1);
    const out = r.created[0]['fldzswp8fx6PqpLQ5'];
    expect(out).toContain('- 20261001-agent-dispatch-901: Agent blocked: retype');
    expect(out).not.toContain('20261001-agent-dispatch-902');
    expect(out).toContain('- scripts/agent-dispatch.py (protected)');
    expect(out).toContain(`Tested head: ${HEAD}`);
    expect(r.created[0]['fldgFjGBw6bTKJFCD']).toBe('MERGE: PR #812 — fix: retype an approved task');
  });

  it('a card that already stands for this head (approved twice, refused twice) is returned with no second gate and no second card', () => {
    const r = drive('merge_card.existing_card = lambda pr, read=None: OLD');
    expect(r.created).toHaveLength(0);
    expect(r.gates).toBe(0);
    expect(r.out.mergeCard).toEqual({ task: 'recOldCardAaaaaa', already: true });
  });

  it('raise_merge_card itself returns a card that stands for the tested head, or a closed one, and never writes', () => {
    const r = run(load('fm', 'fixer-merge.py') + `
import merge_card, findings
W = []
fm.pr_facts = lambda pr: ("t", "u", [], "${NEWHEAD}")
merge_card.create_card = lambda fields, run=None: W.append("create")
merge_card.patch_card = lambda task, fields: W.append("patch")
findings.current_state = lambda: {}
d = {"protected": [{"file": "scripts/agent-dispatch.py"}]}
merge_card.existing_card = lambda pr, read=None: {"id": "recOld", "status": "Approval", "head": "${HEAD}", "notes": ""}
same = fm.raise_merge_card(812, d, {"head": "${HEAD}"})
merge_card.existing_card = lambda pr, read=None: {"id": "recOld", "status": "Completed", "head": "x", "notes": ""}
closed = fm.raise_merge_card(812, d, {"head": "${HEAD}"})
print(json.dumps({"same": same, "closed": closed, "writes": W}))`);
    expect(r.same).toEqual({ task: 'recOld', already: true });
    expect(r.closed).toEqual({ task: 'recOld', already: true });
    expect(r.writes).toEqual([]);
  });

  it('a rejected card is never raised again', () => {
    const r = drive('merge_card.existing_card = lambda pr, read=None: dict(OLD, status="Completed", head="x")');
    expect(r.created).toHaveLength(0);
    expect(r.patched).toHaveLength(0);
    expect(r.out.mergeCard.already).toBe(true);
  });

  it('a PR that moved since its card refreshes the SAME card for the new head and asks Kevin again', () => {
    const r = drive(`merge_card.existing_card = lambda pr, read=None: dict(OLD, head="${NEWHEAD}")`);
    expect(r.created).toHaveLength(0);
    expect(r.gates).toBe(1);
    expect(r.patched).toHaveLength(1);
    const [task, f] = r.patched[0];
    expect(task).toBe('recOldCardAaaaaa');
    expect(f.fldrHBSr6qoUfaKuZ).toBeNull();                      // his old approval is cleared
    expect(f.fldx4qCw17UfrKpaN).toBe('Approval');
    expect(f.fldzswp8fx6PqpLQ5).toContain(`Tested head: ${HEAD}`);
    expect(f.fldR7apBzSp3oxFxz).toMatch(/MERGE CARD REFRESHED: PR #812 changed/);
    expect(r.out.mergeCard.refreshed).toBe(true);
  });

  it('red: no card at all, and the PR is left open', () => {
    const r = drive('fm.run_gate = lambda cwd: (False, {"testedTree": cwd, "vitest": {"ok": False, "tail": "1 failed"}})');
    expect(r.created).toHaveLength(0);
    expect(r.out.why).toMatch(/the gate is RED/);
    expect(r.merged).toBe(false);
  });

  it('a card that cannot be written exits 1 and says why, so the fixer puts it on NEEDS YOU', () => {
    const r = drive('def bad(fields, run=None): raise RuntimeError("create-agent-task.py exited 2: GATE COULD NOT RUN")\nmerge_card.create_card = bad');
    expect(r.code).toBe(1);
    expect(r.out.mergeCard.error).toMatch(/GATE COULD NOT RUN/);
    expect(r.merged).toBe(false);
  });

  it('an unprotected green PR still merges itself, with no card', () => {
    const r = drive('fm.decide = lambda pr: {"pr": pr, "files": 1, "protected": [], "mayAutoMerge": True}\nfm.sh = lambda args, cwd=None, timeout=1800: (SH.append(" ".join(args)), subprocess.CompletedProcess(args, 0, \'{"state": "MERGED"}\', ""))[1]');
    expect(r.created).toHaveLength(0);
    expect(r.merged).toBe(true);
    expect(r.out.merged).toBe(true);
  });

  it('the MERGE card and its merger are themselves protected, so a fix to them can never merge itself', () => {
    const r = run(load('fm', 'fixer-merge.py') + `print(json.dumps(list(fm.PROTECTED)))`);
    for (const f of ['scripts/merge_card.py', 'scripts/merge-approved.py', 'scripts/merge-pr.py', 'scripts/approval_evidence.py',
                     'scripts/fixer-merge.py', 'scripts/agent-dispatch.py']) {
      expect(r, f).toContain(f);
    }
  });
});

describe('merge-approved.py: merges what Kevin approved, once, and only that head', () => {
  const card = (over = {}) => JSON.stringify(Object.assign({
    id: 'recCardAaaaaaaaaa', name: 'MERGE: PR #812 — fix', pr: 812, status: 'Today', outcome: 'Approved as-is',
    approvedAt: '2026-10-07T09:00:00.000Z', feedback: '', notes: '', agentOutput: OUTPUT, head: HEAD,
    findings: ['20261001-agent-dispatch-901'],
    fields: { fld30Yw8SWYVp049g: [BUILDER], fldr4Mvf2RzKvhZhi: '2026-10-07T09:00:00.000Z' },
    createdTime: '2026-10-07T08:00:00.000Z',
  }, over));
  const drive = (prelude, dir) => run(load('ma', 'merge-approved.py') + `
ma.STATE_DIR = ${JSON.stringify(dir)}
CALLS, NOTES, PATCHES, MERGES = [], [], [], []
GH = {"view": json.dumps({"state": "OPEN", "mergeCommit": None, "headRefOid": "${HEAD}"})}
def sh(args, timeout=120):
    CALLS.append(" ".join(args[:4]))
    if args[:3] == ["gh", "pr", "view"]:
        return subprocess.CompletedProcess(args, 0 if GH["view"] else 1, GH["view"] or "", "" if GH["view"] else "no pull requests found")
    if args[:3] == ["gh", "run", "list"]:
        return subprocess.CompletedProcess(args, 0, json.dumps([{"headSha": "abc123def4567890", "status": "completed", "conclusion": GH.get("deploy", "success"), "createdAt": "2026-10-07T10:00:00Z"}]), "")
    return subprocess.CompletedProcess(args, 0, "", "")
def py(script, *args, timeout=300):
    CALLS.append(script + " " + " ".join(args[:2]))
    if script == "agent-dispatch.py" and args[0] == "annotate":
        NOTES.append(args[3])
    return subprocess.CompletedProcess([script], 0, "landed 1 finding(s) from PR #812" if script == "findings.py" else "", "")
def merge_pr(pr, head, dry_run=False):
    MERGES.append([pr, head])
    GH["view"] = json.dumps({"state": "MERGED", "mergeCommit": {"oid": "abc123def4567890"}, "headRefOid": head})
    return subprocess.CompletedProcess(["merge-pr.py"], 0, json.dumps({"merged": True, "why": "merged: green"}), "progress")
ma.sh, ma.py, ma.run_merge_pr = sh, py, merge_pr
ma.merge_card.patch_card = lambda task, fields: PATCHES.append([task, fields])
ma.time.sleep = lambda s: None
C = lambda **k: dict(json.loads(${JSON.stringify(card())}), **k)
${prelude}
`);
  const tmpd = () => mkdtempSync(join(tmpdir(), 'od-ma-'));

  it('plan(): approved merges; rejected, an edit asked for, a replaced body, no real approval and a red retry each say why', () => {
    const r = drive(`
att = {"812": {"result": "red", "approvedAt": "2026-10-07T09:00:00.000Z", "at": "x", "back": True}}
unsent = {"812": {"result": "red", "approvedAt": "2026-10-07T09:00:00.000Z", "at": "x", "back": False}}
print(json.dumps([ma.plan(C(), {}), ma.plan(C(), att)[0], ma.plan(C(approvedAt="2026-10-07T11:00:00.000Z", fields={"fld30Yw8SWYVp049g": ["${BUILDER}"], "fldr4Mvf2RzKvhZhi": "2026-10-07T11:00:00.000Z"}), att)[0],
  ma.plan(C(status="Completed", outcome="Rejected"), {})[0], ma.plan(C(status="Completed", outcome="Rejected", notes=ma.REJECTED_MARK), {})[0],
  ma.plan(C(outcome="Approved with minor edits", feedback="hold till Friday"), {})[0], ma.plan(C(outcome="Changes requested"), {})[0],
  ma.plan(C(outcome=""), {})[0], ma.plan(C(fields={}), {}),
  ma.plan(C(fields={"fld30Yw8SWYVp049g": ["${BUILDER}"], "fldr4Mvf2RzKvhZhi": "2026-10-01T09:00:00.000Z"}), {})[1],
  ma.plan(C(agentOutput="DECIDE: close PR #812?\\n\\n" + ${JSON.stringify(OUTPUT)}), {}),
  ma.plan(C(), unsent)[0], ma.plan(C(head="", agentOutput=${JSON.stringify(OUTPUT)}.replace("Tested head: ${HEAD}", "Tested head: not recorded")), {})[0]]))`, tmpd());
    expect(r[0]).toEqual(['merge', 'approved']);
    expect(r[1]).toBe('skip');            // red on this approval: not re-run every half hour
    expect(r[2]).toBe('merge');           // approved again: tried once more
    expect(r[3]).toBe('note-rejected');
    expect(r[4]).toBe('skip');            // told once
    expect(r[5]).toBe('note-edit');
    expect(r[6]).toBe('note-edit');
    expect(r[7]).toBe('skip');
    expect(r[8][0]).toBe('skip');
    expect(r[8][1]).toMatch(/not .*(Builder|approval gate)/);
    expect(r[9]).toMatch(/Approved At is earlier than the task itself/);
    expect(r[10]).toEqual(['skip', 'not a MERGE card any more: its work does not open with the MERGE CARD line for PR #812']);
    expect(r[11]).toBe('send-back');     // tried, but never got back to his queue: sent back now
    expect(r[12]).toBe('send-back');     // no tested head: never merged, sent back saying so
  });

  it('green: merge-pr.py once at the approved head, findings landed, deploy watched, the card completed with the merge commit', () => {
    const r = drive(`
res = ma.merge_one(C(), {})
print(json.dumps({"res": res, "calls": CALLS, "merges": MERGES, "att": json.load(open(os.path.join(ma.STATE_DIR, ma.ATTEMPTS)))}))`, tmpd());
    expect(r.res).toMatchObject({ result: 'merged', sha: 'abc123def4567890', deploy: 'live' });
    expect(r.merges).toEqual([[812, HEAD]]);
    expect(r.calls).toContain('findings.py land --pr');
    expect(r.calls).toContain('agent-dispatch.py complete recCardAaaaaaaaaa');
    expect(r.att['812'].result).toBe('merged');
  });

  it('a push after the card was raised: nothing merges; the new code is re-tested by a merge-pr.py DRY RUN at that head (never fixer-merge), the card is rebuilt for it and goes back', () => {
    const r = drive(`
GH["view"] = json.dumps({"state": "OPEN", "mergeCommit": None, "headRefOid": "${NEWHEAD}", "title": "fix: retype", "url": "u", "files": [{"path": "scripts/agent-dispatch.py"}, {"path": "scripts/send-email.py"}]})
CALLED = []
def merge_pr(pr, head, dry_run=False):
    CALLED.append([pr, head, dry_run])
    return subprocess.CompletedProcess(["merge-pr.py"], 0, json.dumps({"merged": False, "head": head, "why": "DRY RUN, nothing merged: green"}), "")
ma.run_merge_pr = merge_pr
ma.findings = None
import findings as F_
F_.current_state = lambda: {}
REAL_SUB = ma.subprocess.run
def guard(args, *a, **k):
    if any("fixer-merge.py" in str(x) for x in args): raise AssertionError("fixer-merge.py was called")
    return REAL_SUB(args, *a, **k)
ma.subprocess.run = guard
res = ma.merge_one(C(), {})
print(json.dumps({"res": res, "called": CALLED, "patches": PATCHES, "notes": NOTES}))`, tmpd());
    expect(r.called).toEqual([[812, NEWHEAD, true]]);            // the gate alone, at the new head
    expect(r.res.result).toBe('error');
    expect(r.notes[0]).toMatch(/^MERGE NOT DONE: PR #812 changed after this card was raised .*Re-tested green on the new code; the card now shows it\./);
    const body = r.patches.find(([, f]) => 'fldzswp8fx6PqpLQ5' in f);
    expect(body[1].fldzswp8fx6PqpLQ5).toContain(`Tested head: ${NEWHEAD}`);
    expect(body[1].fldzswp8fx6PqpLQ5).toContain('- scripts/send-email.py (protected)');   // the new file is listed
    const back = r.patches.find(([, f]) => f.fldx4qCw17UfrKpaN);
    expect(back[1]).toMatchObject({ fldx4qCw17UfrKpaN: 'Approval', fldrHBSr6qoUfaKuZ: null });
  });

  it('a moved head that is red on the dry run keeps the OLD tested head, so nothing untested can merge', () => {
    const r = drive(`
GH["view"] = json.dumps({"state": "OPEN", "mergeCommit": None, "headRefOid": "${NEWHEAD}"})
def merge_pr(pr, head, dry_run=False):
    return subprocess.CompletedProcess(["merge-pr.py"], 1, json.dumps({"merged": False, "head": head, "why": "the gate is RED"}), "")
ma.run_merge_pr = merge_pr
res = ma.merge_one(C(), {})
print(json.dumps({"res": res, "patches": PATCHES, "notes": NOTES}))`, tmpd());
    expect(r.patches.some(([, f]) => 'fldzswp8fx6PqpLQ5' in f)).toBe(false);
    expect(r.notes[0]).toMatch(/The new code was re-tested and is not green/);
  });

  it('two red gates on the same code: the second says it needs a working session and files a finding; a re-approval runs no gate', () => {
    const dir = tmpd();
    const r = drive(`
def merge_pr(pr, head, dry_run=False):
    MERGES.append([pr, head])
    return subprocess.CompletedProcess(["merge-pr.py"], 1, json.dumps({"merged": False, "why": "RED"}), "")
ma.run_merge_pr = merge_pr
att = {}
first = ma.merge_one(C(), att)
second = ma.merge_one(C(approvedAt="2026-10-07T11:00:00.000Z"), att)
third_plan = ma.plan(C(approvedAt="2026-10-07T12:00:00.000Z"), att)
newhead_plan = ma.plan(C(approvedAt="2026-10-07T12:00:00.000Z", head="${NEWHEAD}",
                         agentOutput=${JSON.stringify(OUTPUT)}.replace("${HEAD}", "${NEWHEAD}")), att)
print(json.dumps({"first": first, "second": second, "third": third_plan, "newhead": newhead_plan, "merges": len(MERGES),
                  "calls": CALLS, "last": PATCHES[-1][1]}))`, dir);
    expect(r.first.needsSession).toBeUndefined();
    expect(r.second.needsSession).toBe(true);
    expect(r.second.why).toMatch(/failed 2 times on this code, so the robot will not run it again: PR #812 needs a fix in a working session/);
    expect(r.calls.filter((c) => c.startsWith('findings.py add'))).toHaveLength(1);
    expect(r.last.fld3PrM8AJcnWHemG).toMatch(/^TASK: PR #812 failed its gate twice on this code/);
    expect(r.third[0]).toBe('needs-session');
    expect(r.merges).toBe(2);                     // no third gate
    expect(r.newhead[0]).toBe('merge');           // the fix pushed and the card refreshed: the count starts again
  });

  it('the poll queues the run through job-queue.py (lease 60), never two at once, and never runs it detached on its own', () => {
    const dir = tmpd();
    const r = drive(`
STARTED = []
class P:
    def __init__(self, args, **k): STARTED.append(args); self.pid = os.getpid()
ma.subprocess.Popen = P
ma.merge_card.read_tasks = lambda *a, **k: [{"id": "ctl", "fields": {}}]
ma.merge_card.list_cards = lambda read=None: [C()]
b1, b2 = io.StringIO(), io.StringIO()
with contextlib.redirect_stdout(b1):
    ma.cmd_detach(argparse.Namespace())
with contextlib.redirect_stdout(b2):
    ma.cmd_detach(argparse.Namespace())      # queued.pid names a live process (this one): nothing more
print(json.dumps({"started": STARTED, "first": json.loads(b1.getvalue()), "second": json.loads(b2.getvalue())}))`, dir);
    expect(r.started).toHaveLength(1);
    const a = r.started[0];
    expect(a.slice(1, 6)).toEqual([join(ROOT, 'scripts', 'job-queue.py'), 'run', 'merge-approved', '--lease', '60']);
    expect(a.slice(-2)).toEqual([S('merge-approved.py'), 'run']);
    expect(r.second.busy).toBe(true);
  });

  it('a note that fails to write never strands the card: it goes back first, and a send-back that failed is retried', () => {
    const r = drive(`
def bad_annotate(task, note): raise RuntimeError("Airtable 503")
ma.annotate = bad_annotate
def merge_pr(pr, head, dry_run=False):
    return subprocess.CompletedProcess(["merge-pr.py"], 1, json.dumps({"merged": False, "why": "RED"}), "")
ma.run_merge_pr = merge_pr
res = ma.merge_one(C(), {})
att = json.load(open(os.path.join(ma.STATE_DIR, ma.ATTEMPTS)))
def bad_patch(task, fields): raise RuntimeError("Airtable 503")
ma.merge_card.patch_card = bad_patch
res2 = ma.merge_one(C(), {})
att2 = json.load(open(os.path.join(ma.STATE_DIR, ma.ATTEMPTS)))
print(json.dumps({"res": res, "back": PATCHES[0][1].get("fldx4qCw17UfrKpaN") if PATCHES else None, "att": att["812"],
                  "res2": res2, "plan2": ma.plan(C(), att2)}))`, tmpd());
    expect(r.res.annotateError).toMatch(/Airtable 503/);
    expect(r.res.backToKevin).toBe(true);
    expect(r.back).toBe('Approval');
    expect(r.att.back).toBe(true);
    expect(r.res2.backToKevin).toBe(false);
    expect(r.plan2[0]).toBe('send-back');
  });

  it('red: the gate\'s last lines go on the card, the card goes back to his queue, and nothing is completed or landed', () => {
    const r = drive(`
def merge_pr(pr, head, dry_run=False):
    MERGES.append([pr, head])
    return subprocess.CompletedProcess(["merge-pr.py"], 1, json.dumps({"merged": False, "why": "the gate is RED: 2 tests failed"}), "\\n".join("progress %d" % i for i in range(30)))
ma.run_merge_pr = merge_pr
res = ma.merge_one(C(), {})
print(json.dumps({"res": res, "calls": CALLS, "notes": NOTES, "patches": PATCHES}))`, tmpd());
    expect(r.res.result).toBe('red');
    expect(r.res.backToKevin).toBe(true);
    expect(r.calls.some((c) => c.startsWith('agent-dispatch.py complete'))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('findings.py'))).toBe(false);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/^MERGE NOT DONE: merge-pr\.py did not merge PR #812 \(exit 1\)/);
    expect(r.notes[0]).toContain('why: the gate is RED: 2 tests failed');
    expect(r.notes[0]).toContain('progress 29');
    expect(r.notes[0]).not.toContain('progress 9\n');            // the last 20 lines, not the whole run
    expect(r.patches).toEqual([['recCardAaaaaaaaaa', { fldx4qCw17UfrKpaN: 'Approval', fldrHBSr6qoUfaKuZ: null,
      fld3PrM8AJcnWHemG: 'TASK: The merge of PR #812 did not go through: merge-pr.py did not merge PR #812 (exit 1). Its last lines:\nIF YOU APPROVE: the robot tries merge-pr.py on PR #812 once more, and the deploy. Reject leaves the PR open.' }]]);
  });

  it('a merge that landed just before merge-pr.py was stopped is a merge, never "left open"', () => {
    const r = drive(`
def merge_pr(pr, head, dry_run=False):
    GH["view"] = json.dumps({"state": "MERGED", "mergeCommit": {"oid": "abc123def4567890"}, "headRefOid": head})
    return subprocess.CompletedProcess(["merge-pr.py"], 124, "", "stopped after 45 minutes")
ma.run_merge_pr = merge_pr
res = ma.merge_one(C(), {})
print(json.dumps({"res": res, "calls": CALLS, "patches": PATCHES}))`, tmpd());
    expect(r.res.result).toBe('merged');
    expect(r.patches).toEqual([]);
    expect(r.calls).toContain('agent-dispatch.py complete recCardAaaaaaaaaa');
  });

  it('merged but the card would not close: said truly, not sent back, and the next run closes it', () => {
    const dir = tmpd();
    const r = drive(`
def py(script, *args, timeout=300):
    CALLS.append(script + " " + " ".join(args[:2]))
    if script == "agent-dispatch.py" and args[0] == "annotate":
        NOTES.append(args[3])
    if script == "agent-dispatch.py" and args[0] == "complete":
        return subprocess.CompletedProcess([script], 1, "", "Airtable 503")
    return subprocess.CompletedProcess([script], 0, "", "")
ma.py = py
first = ma.merge_one(C(), {})
att = json.load(open(os.path.join(ma.STATE_DIR, ma.ATTEMPTS)))
print(json.dumps({"first": first, "notes": NOTES, "patches": PATCHES, "again": ma.plan(C(), att)[0]}))`, dir);
    expect(r.first.result).toBe('merged-open');
    expect(r.notes[0]).toMatch(/^MERGED, CARD NOT CLOSED: PR #812 merged as abc123def456/);
    expect(r.notes[0]).not.toMatch(/left open/);
    expect(r.patches).toEqual([]);
    expect(r.again).toBe('merge');      // the next run reads MERGED and goes straight to complete
  });

  it('a failed Pages deploy still closes the card (the merge is done) and files a HIGH finding', () => {
    const r = drive(`
GH["deploy"] = "failure"
res = ma.merge_one(C(), {})
print(json.dumps({"res": res, "calls": CALLS}))`, tmpd());
    expect(r.res.deploy).toBe('failed (failure)');
    expect(r.calls).toContain('findings.py add --routine');
    expect(r.calls).toContain('agent-dispatch.py complete recCardAaaaaaaaaa');
  });

  it('a PR number that does not exist is written on the card, the card goes back, and merge-pr.py never runs', () => {
    const r = drive(`
GH["view"] = ""
res = ma.merge_one(C(), {})
print(json.dumps({"res": res, "merges": MERGES, "notes": NOTES, "patches": len(PATCHES)}))`, tmpd());
    expect(r.res.result).toBe('error');
    expect(r.notes[0]).toMatch(/PR #812 could not be read, so nothing was merged: gh cannot read PR #812: no pull requests found/);
    expect(r.merges).toEqual([]);
    expect(r.patches).toBe(1);
  });

  it('a PR already merged by hand is completed without a second merge', () => {
    const r = drive(`
GH["view"] = json.dumps({"state": "MERGED", "mergeCommit": {"oid": "abc123def4567890"}, "headRefOid": "${HEAD}"})
res = ma.merge_one(C(), {})
print(json.dumps({"res": res, "merges": MERGES, "calls": CALLS}))`, tmpd());
    expect(r.res.result).toBe('merged');
    expect(r.merges).toEqual([]);
    expect(r.calls).toContain('agent-dispatch.py complete recCardAaaaaaaaaa');
  });

  it('an edit asked for: nothing merges, the change goes to the fixer as a finding, and the card goes back to Kevin', () => {
    const r = drive(`
ma.merge_card.read_tasks = lambda *a, **k: [{"id": "ctl", "fields": {}}]
ma.merge_card.list_cards = lambda read=None: [C(outcome="Changes requested", feedback="Use the shorter wording")]
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = ma.cmd_run(argparse.Namespace(dry_run=False))
print(json.dumps({"code": code, "merges": MERGES, "calls": CALLS, "notes": NOTES, "patches": PATCHES}))`, tmpd());
    expect(r.code).toBe(0);
    expect(r.merges).toEqual([]);
    expect(r.calls).toContain('findings.py add --routine');
    expect(r.notes[0]).toMatch(/^MERGE CARD NOT MERGED: Kevin's note asks for a change \(Changes requested\).*Note: Use the shorter wording$/);
    expect(r.patches[0][1].fld3PrM8AJcnWHemG).toMatch(/^TASK: You asked for a change to PR #812/);
    expect(r.patches[0][1].fldtI7SJI4gEohHD1).toBeNull();   // passed on: his next plain approval is not an edit
    expect(r.calls.find((c) => c.startsWith('findings.py add'))).toBeTruthy();
  });

  it('one PR is never merged twice at once: a held PR lock is "busy"; a held run lock starts nothing', () => {
    const r = drive(`
hold = ma.Lock("pr-812.lock")
res = ma.merge_one(C(), {})
run_hold = ma.Lock("run.lock")
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = ma.cmd_run(argparse.Namespace(dry_run=False))
print(json.dumps({"res": res, "calls": CALLS, "run": json.loads(buf.getvalue()), "code": code}))`, tmpd());
    expect(r.res.result).toBe('busy');
    expect(r.calls).toEqual([]);
    expect(r.run).toEqual({ busy: true, why: 'another merge-approved run is working' });
    expect(r.code).toBe(0);
  });

  it('a card read that fails, or a control read that finds nothing, is NOT CHECKED (exit 2), never "no cards"', () => {
    const r = drive(`
def boom(*a, **k): raise RuntimeError("HTTP 401")
ma.merge_card.read_tasks = boom
b1 = io.StringIO()
with contextlib.redirect_stdout(b1):
    c1 = ma.cmd_run(argparse.Namespace(dry_run=False))
ma.merge_card.read_tasks = lambda *a, **k: []
b2 = io.StringIO()
with contextlib.redirect_stdout(b2):
    c2 = ma.cmd_run(argparse.Namespace(dry_run=False))
b3 = io.StringIO()
with contextlib.redirect_stdout(b3):
    c3 = ma.cmd_detach(argparse.Namespace())
print(json.dumps([c1, json.loads(b1.getvalue())["error"], c2, json.loads(b2.getvalue())["error"], c3]))`, tmpd());
    expect(r[0]).toBe(2);
    expect(r[1]).toMatch(/^NOT CHECKED: the MERGE card read failed: HTTP 401/);
    expect(r[2]).toBe(2);
    expect(r[3]).toMatch(/^NOT CHECKED: the control read found no open task/);
    expect(r[4]).toBe(2);
  });

  it('cmd_run: a rejected card is noted once and its PR left alone; an approved one is merged', () => {
    const r = drive(`
ma.merge_card.read_tasks = lambda *a, **k: [{"id": "ctl", "fields": {}}]
ma.merge_card.list_cards = lambda read=None: [C(), C(id="recRejectedAaaaaa", pr=700, status="Completed", outcome="Rejected")]
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = ma.cmd_run(argparse.Namespace(dry_run=False))
print(json.dumps({"code": code, "out": json.loads(buf.getvalue()), "notes": NOTES, "merges": MERGES}))`, tmpd());
    expect(r.code).toBe(0);
    expect(r.merges).toEqual([[812, HEAD]]);
    expect(r.notes).toEqual(['MERGE CARD REJECTED: Kevin rejected the merge card, so PR #700 is left open and nothing was merged.']);
  });
});

describe('a TOOL wall clears through the existing path when its PR lands', () => {
  it('findings pending on the PR flip to fixed on `land`, and the sweep wakes the wall', () => {
    const dir = mkdtempSync(join(tmpdir(), 'od-land-'));
    const env = { FINDINGS_FILE: join(dir, 'q.jsonl'), FINDINGS_OVERFLOW_FILE: join(dir, 'o.jsonl') };
    const add = execFileSync('python3', [S('findings.py'), 'add', '--routine', 'agent-dispatch', '--severity', 'high',
      '--title', 'Agent blocked: retype', '--where', 'scripts/agent-dispatch.py'], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
    execFileSync('python3', [S('findings.py'), 'close', add, '--outcome', 'pending', '--pr', '812', '--note', 'in the PR'], { env: { ...process.env, ...env } });
    const r = run(load('d', 'agent-dispatch.py') + `
AF = d.AF
TASKS, WRITES = {}, []
TASKS["t1"] = {"id": "t1", "fields": {AF["notes"]: "[x — agent] BLOCKER OPEN (TOOL retype): why Fix: f [since 2026-10-01T09:00:00.000Z] [finding ${add}]",
                                       AF["status"]: "Today", AF["name"]: "Example task", AF["approvalOutcome"]: "", AF["agentOutput"]: ""}}
d.get_task = lambda i: json.loads(json.dumps(TASKS[i]))
def patch(i, f): WRITES.append(i); TASKS[i]["fields"].update(f)
d.patch_task = patch
d.ledger_append = lambda t, e: None
d.load_login_sites = lambda: {}
def q(formula, max_records=None, minimal=False):
    if formula.startswith("NOT("): return [{"id": "ctl", "fields": {}}]
    if formula.startswith("AND({Status}='Completed'") or formula.startswith("LEFT("): return []
    return [json.loads(json.dumps(t)) for t in TASKS.values()]
d.query_tasks = q
before = d.blockers_scan(sweep=True)
subprocess.run([sys.executable, ${JSON.stringify(S('findings.py'))}, "land", "--pr", "812"], check=True, capture_output=True)
after = d.blockers_scan(sweep=True)
print(json.dumps({"before": [w["task"] for w in before["woken"]], "state": [w.get("toolState") for w in before["open"]],
                  "after": [w["reason"] for w in after["woken"]]}))`, env);
    expect(r.before).toEqual([]);
    expect(r.state).toEqual(['pending']);
    expect(r.after).toEqual([`the fix landed (finding ${add})`]);
  });
});

describe('the hand-back poll starts it, with no model', () => {
  it('handback-poll-run.sh runs merge-approved.py run --detach after the blocker sweep and before the queue read', () => {
    const sh = readFileSync(S('handback-poll-run.sh'), 'utf8');
    const sweep = sh.indexOf('agent-dispatch.py" blockers --sweep');
    const merge = sh.indexOf('merge-approved.py" run --detach');
    const queue = sh.indexOf('agent-dispatch.py" queue >');
    expect(sweep).toBeGreaterThan(-1);
    expect(merge).toBeGreaterThan(sweep);
    expect(queue).toBeGreaterThan(merge);
    // Free half: never inside the Claude call.
    expect(merge).toBeLessThan(sh.indexOf('"$CLAUDE" -p'));
  });
});
