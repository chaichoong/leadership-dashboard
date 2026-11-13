// Content Engine R9: one approval card per finished episode, in Kevin's ordinary queue
// (scripts/content-engine/approval.py). The pure parts (card text, readiness, verdict mapping)
// run through the script's selftest; the checks below pin the wiring that makes the card
// reach Kevin and makes his verdict reach the agent — each one a way this loop has broken
// before for another agent.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'scripts', 'content-engine');
const APPROVAL = path.join(DIR, 'approval.py');
const DISPATCH = path.join(ROOT, 'scripts', 'agent-dispatch.py');
const CONTENT_TM = 'recRcy1Edas6rGaaF';

function py(code) {
  const script = `
import importlib.util, json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'scripts'))})
spec = importlib.util.spec_from_file_location("ad", ${JSON.stringify(DISPATCH)})
ad = importlib.util.module_from_spec(spec); spec.loader.exec_module(ad)
${code}
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

describe('content-engine approval card', () => {
  it('passes its own selftest (ask first, links, copy, closing line, readiness, verdicts)', () => {
    const out = JSON.parse(execFileSync('python3', [APPROVAL, 'selftest'], { encoding: 'utf8', cwd: DIR }));
    const qa = JSON.parse(execFileSync('python3', [path.join(DIR, 'qa.py'), 'selftest'], { encoding: 'utf8', cwd: DIR }));
    expect(qa.failed).toEqual([]);   // the output gate (10 Sep 2026): no card until the files prove themselves
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(14);
  }, 30000);

  it('is a role agent the dispatcher knows, never handed work by the CEO pass, so submit and lessons both work', () => {
    const r = py(`
e = ad.ROLE_AGENTS.get(${JSON.stringify(CONTENT_TM)}, {})
print(json.dumps({"agent": e.get("agent"), "dispatch": e.get("dispatch", True), "register": e.get("registerRow"), "inAll": ${JSON.stringify(CONTENT_TM)} in ad.ALL_AGENTS}))
`);
    expect(r.agent).toBe('content-engine');
    expect(r.dispatch).toBe(false);
    expect(r.register).toBe('recNaC0N5KiTGBPNy');
    expect(r.inAll).toBe(true);
  });

  it('can hand in its own work while never being handed work: submit passes on Built, dispatch still refuses', () => {
    const r = py(`
ad.fetch_role_roster = lambda: {${JSON.stringify(CONTENT_TM)}: {"name": "AI Content Producer", "status": "Built", "dispatchable": False}}
out = {}
for verb in ("submit", "dispatch"):
    try:
        ad.require_role_agent_live(${JSON.stringify(CONTENT_TM)}, verb); out[verb] = "ok"
    except SystemExit as e:
        out[verb] = "refused"
ad.fetch_role_roster = lambda: {${JSON.stringify(CONTENT_TM)}: {"name": "AI Content Producer", "status": "Paused", "dispatchable": False}}
try:
    ad.require_role_agent_live(${JSON.stringify(CONTENT_TM)}, "submit"); out["paused"] = "ok"
except SystemExit:
    out["paused"] = "refused"
print(json.dumps(out))
`);
    expect(r.submit).toBe('ok');
    expect(r.dispatch).toBe('refused');
    expect(r.paused).toBe('refused');
  });

  it('uses the same gate and the same submit as every other agent, with --force explained by the numbers-stripping key', () => {
    const src = readFileSync(APPROVAL, 'utf8');
    expect(src).toContain('GATE, "create", "--force"');
    expect(src).toContain('DISPATCH, "submit", tid, "--agent", AGENT_TM, "--type", TASK_TYPE');
    expect(src).toMatch(/def existing_task/);
    expect(src).toContain('CONTROL failed');
    expect(src).toContain('TASK_TYPE = "Drafting"');
  });

  it('runs nightly after the copy step: sync the verdicts first, then raise cards', () => {
    const sh = readFileSync(path.join(ROOT, 'scripts', 'content-engine-run.sh'), 'utf8');
    const sync = sh.indexOf('approval.py sync');
    const run = sh.indexOf('approval.py run --pending');
    const copy = sh.indexOf('platform_copy.py run --pending');
    expect(sync).toBeGreaterThan(copy);
    expect(run).toBeGreaterThan(sync);
    expect(sh).toContain('approval.py report');
  });

  it("both Claude calls in the lane read Kevin's lessons from the agent file, so 'reject and remember' changes the next episode", () => {
    expect(readFileSync(path.join(DIR, 'platform_copy.py'), 'utf8')).toContain('lessons = watch.kevin_lessons()');
    const thumb = readFileSync(path.join(DIR, 'thumbnail.py'), 'utf8');
    expect(thumb).toContain('lessons = watch.kevin_lessons()');
    expect(thumb).toContain('"--system-prompt", system,');
    const watch = readFileSync(path.join(DIR, 'watch.py'), 'utf8');
    expect(watch).toContain('AGENT_FILE = os.path.expanduser("~/.claude/agents/content-engine.md")');
    const agentFile = path.join(homedir(), '.claude', 'agents', 'content-engine.md');
    if (existsSync(agentFile)) {
      expect(readFileSync(agentFile, 'utf8')).toContain('## Lessons from Kevin');
    }
  });

  it('the approvals page turns the links in the work into links Kevin can open (escaped first)', () => {
    const html = readFileSync(path.join(ROOT, 'os', 'agents', 'index.html'), 'utf8');
    // Match the element that carries the work, not its classes, which have
    // changed before (23 and 24 Sep 2026).
    expect(html).toMatch(/<div class="apv-body[^"]*" data-apv-work>\$\{apvLinkify\(work\)\}<\/div>/);
    const start = html.indexOf('function apvLinkify(');
    const end = html.indexOf('function apvCardHtml(', start);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const linkify = new Function('esc', `${html.slice(start, end)}; return apvLinkify;`)(esc);
    const out = linkify('Watch: https://drive.google.com/file/d/abc/view <b>x</b>');
    expect(out).toContain('<a href="https://drive.google.com/file/d/abc/view"');
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(out).not.toContain('<b>');
  });

  it("a card Kevin sent back is resubmitted with a receipt and its old verdict is forgotten, so his re-approval is read (9 Sep 2026)", () => {
    const a = readFileSync(path.join(DIR, 'approval.py'), 'utf8');
    expect(a).toContain('def refresh_card(day, receipt=None)');
    expect(a).toContain('if receipt: cmd += ["--receipt", receipt]');
    expect(a).toContain('for k in ("verdict", "outcome", "synced", "feedback"): e.pop(k, None)');
  });
});

// A blocked day's clock must survive the next read (finding 20261110-phase-3-1259). Day 2144 was blocked on
// 'episode rendered: no long clip rendered for this day' from 2026-10-29 to 2026-11-10 with no card, no receipt and
// no list naming it: every read rewrote `at`, so 12 days read exactly like last night, and pending() only sorts a
// blocked day to the back. Days 2137 and 2138 went the same way on 9 Nov. Re-running a render cannot change that
// verdict, so a night is not the answer.
describe('a day blocked on the same failure says how long for', () => {
  function gate(before, failures) {
    const code = `
import sys, json, io, contextlib, datetime as dt
sys.path.insert(0, ${JSON.stringify(DIR)})
import approval, qa, platform_copy
qa.gate = lambda day, ledger: (False, [tuple(f) for f in ${JSON.stringify(failures)}], [])
qa.is_wait = lambda fs: False
platform_copy.session_leak = lambda recs: []
STATE = json.loads(${JSON.stringify(JSON.stringify(before))})
approval.save_state = lambda s: None          # output_gate mutates the state it is handed; the real save would write ~/.config
out = io.StringIO()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
    approval.output_gate(2144, {}, STATE, None)
print(json.dumps({"state": STATE, "out": out.getvalue()}))
`;
    return JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8', timeout: 60000 }).trim());
  }
  const FAIL = [['episode rendered', 'no long clip rendered for this day']];
  const OLD = { '2144': { qa_blocked: { at: '2026-11-09T04:13:43', since: '2026-10-29T04:13:43', reads: 11,
    failures: ['episode rendered: no long clip rendered for this day'] } } };

  it('keeps the start of the block and counts the reads while the failure text is the same', () => {
    const r = gate(OLD, FAIL);
    const b = r.state['2144'].qa_blocked;
    expect(b.since).toBe('2026-10-29T04:13:43');     // not today, which is what every read used to write
    expect(b.reads).toBe(12);
    expect(b.at > '2026-11-09').toBe(true);          // the latest read is still recorded
  });

  it('a DIFFERENT failure starts the clock again: that is a new block, not the old one', () => {
    const r = gate(OLD, [['copy missing', 'Short Form Video has its clip but no copy yet']]);
    const b = r.state['2144'].qa_blocked;
    expect(b.reads).toBe(1);
    expect(b.since).toBe(b.at);
  });

  it('the report names it as STUCK and needing a person, with its age', () => {
    // The ages are built from today, never written in. Pinned to 12 Nov 2026 (the day this case was
    // written) 2150 read as blocked tonight for one day and as blocked 1 night from 13 Nov on, so
    // the case passed once and failed every morning after, with main red and every PR's gate with it.
    // Local time on both sides: approval.py measures the age with datetime.now(), which is local,
    // so a UTC fixture would read a day older than it is wherever the offset is behind UTC.
    const iso = (daysBack) => {
      const d = new Date(Date.now() - daysBack * 86400000);
      const p2 = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    };
    const code = `
import sys, json, io, contextlib, datetime as dt
sys.path.insert(0, ${JSON.stringify(DIR)})
import approval
approval.load_state = lambda: json.loads(${JSON.stringify(JSON.stringify({
      2144: { qa_blocked: { at: iso(1), since: iso(15), reads: 11, failures: ['episode rendered: no long clip rendered for this day'] } },
      2150: { qa_blocked: { at: iso(0), since: iso(0), reads: 1, failures: ['copy missing: no copy yet'] } },
    }))})
out = io.StringIO()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
    approval.report()
print(json.dumps({"out": out.getvalue()}))
`;
    const r = JSON.parse(execFileSync('python3', ['-c', code], { encoding: 'utf8', timeout: 60000 }).trim());
    expect(r.out).toContain('content output gate STUCK: 1 episode blocked on the SAME failure');
    expect(r.out).toContain('needs a person');
    expect(r.out).toContain('2144');
    expect(r.out).toContain('2150 (copy missing: no copy yet), blocked tonight');   // one night is not a stall
    expect(r.out).not.toMatch(/STUCK[^\n]*2150/);
    expect(r.out).toMatch(/2144 \(episode rendered[^)]*\), blocked \d+ night\(s\) on this/);
  });
});
