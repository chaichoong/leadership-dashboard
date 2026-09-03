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
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(14);
  });

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
ad.fetch_role_roster = lambda: {${JSON.stringify(CONTENT_TM)}: {"name": "AI Content Engine", "status": "Built", "dispatchable": False}}
out = {}
for verb in ("submit", "dispatch"):
    try:
        ad.require_role_agent_live(${JSON.stringify(CONTENT_TM)}, verb); out[verb] = "ok"
    except SystemExit as e:
        out[verb] = "refused"
ad.fetch_role_roster = lambda: {${JSON.stringify(CONTENT_TM)}: {"name": "AI Content Engine", "status": "Paused", "dispatchable": False}}
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
    expect(html).toContain('<div class="apv-body">${apvLinkify(work)}</div>');
    const start = html.indexOf('function apvLinkify(');
    const end = html.indexOf('function apvCardHtml(', start);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const linkify = new Function('esc', `${html.slice(start, end)}; return apvLinkify;`)(esc);
    const out = linkify('Watch: https://drive.google.com/file/d/abc/view <b>x</b>');
    expect(out).toContain('<a href="https://drive.google.com/file/d/abc/view"');
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(out).not.toContain('<b>');
  });
});
