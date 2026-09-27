import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const SCRIPT = resolve(ROOT, 'scripts/prod-walk.js');
const walk = require(SCRIPT);
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// 27 Sep 2026: prod-sweep-weekly is a headless slot, and its skill told it to use
// mcp__Claude_Browser__* and the Airtable MCP, neither of which exists in a
// headless run. The walk never ran from 13 Sep. scripts/prod-walk.js is the
// robots' route: Playwright, signed in from the token file, read-only.
const ORIGIN = 'https://app.operationsdirector.co.uk';
const SECRET = 'patAbCdEfGhIjKlMnOp.0123456789abcdef0123456789abcdef';

describe('prod-walk.js keeps the token to itself', () => {
  it('refuses to walk any site but the live app or a local copy, before it reads the token', () => {
    for (const bad of ['https://any.example/', 'https://app.operationsdirector.co.uk.evil.example/',
                       'http://app.operationsdirector.co.uk/', 'file:///etc/passwd', 'nonsense']) {
      expect(walk.allowedBase(bad), bad).toBe('');
    }
    expect(walk.allowedBase('https://app.operationsdirector.co.uk')).toBe(ORIGIN + '/');
    expect(walk.allowedBase('http://localhost:8951/x')).toBe('http://localhost:8951/');
  });
  it('exits 2 on a foreign --base, printing no token (drives the real script)', () => {
    let out = '', code = 0;
    try { out = execFileSync('node', [SCRIPT, '--base', 'https://any.example/'], { encoding: 'utf8' }); }
    catch (e) { out = e.stdout; code = e.status; }
    expect(code).toBe(2);
    expect(JSON.parse(out).reason).toMatch(/refused --base/);
  });
  it('removes every copy of the token from what it prints', () => {
    expect(walk.scrub(`a ${SECRET} b ${SECRET}`, SECRET)).toBe('a [REDACTED] b [REDACTED]');
  });
  it('scrubs before it cuts, so a cut can never leave part of the token behind', () => {
    const text = 'x'.repeat(30) + SECRET;
    const out = walk.clip(text, 50, SECRET);
    expect(out).not.toContain(SECRET.slice(0, 10));
    // BACK-TEST: the old order (cut, then scrub) leaves a prefix.
    expect(walk.scrub(text.slice(0, 50), SECRET)).toContain(SECRET.slice(0, 10));
  });
  it('never scrubs with a short or missing secret, which would shred the report', () => {
    expect(walk.scrub('the cat sat', 'at')).toBe('the cat sat');
    expect(walk.scrub('x', '')).toBe('x');
  });
});

describe('prod-walk.js classify', () => {
  const ok = { rendered: true, chars: 500, consoleErrors: [], failedRequests: [], leaks: [], softLeaks: [] };
  it('passes a rendered page with content and no errors', () => {
    expect(walk.classify(ok)).toBe('PASS');
  });
  it('fails a blank panel, an app error, a value-shaped leak, an HTTP error and a page not reached', () => {
    expect(walk.classify({ ...ok, chars: 3 })).toBe('FAIL');
    expect(walk.classify({ ...ok, rendered: false })).toBe('FAIL');
    expect(walk.classify({ ...ok, consoleErrors: ['TypeError: x is undefined'] })).toBe('FAIL');
    expect(walk.classify({ ...ok, leaks: ['Total: £NaN'] })).toBe('FAIL');
    expect(walk.classify({ ...ok, httpStatus: 404 })).toBe('FAIL');
    expect(walk.classify({ ...ok, error: 'not reached: the 8-minute budget ran out first' })).toBe('FAIL');
  });
  it('never passes a page that stopped at its gate: its data went unchecked', () => {
    expect(walk.classify({ ...ok, gate: 'asks who is viewing' })).toBe('WARN');
  });
  it('fails a broken value after a label or with a unit, which a WARN would let through unreported', () => {
    for (const t of ['Voids: NaN', 'Tenant: undefined', 'Arrears for NaN days', 'Rent = NaN']) {
      expect(walk.findLeaks(t, SECRET).hard, t).toHaveLength(1);
    }
    expect(walk.findLeaks('task: fix pnl NaN leak', SECRET).hard).toHaveLength(0);
  });
  it('warns, not fails, on a bare NaN or undefined, which can be someone\'s own words', () => {
    expect(walk.classify({ ...ok, softLeaks: ['task: fix pnl NaN leak'] })).toBe('WARN');
  });
});

describe('prod-walk.js findLeaks', () => {
  it('splits value-shaped leaks from bare words', () => {
    const l = walk.findLeaks('Balance £NaN and [object Object] here; task named undefined thing', SECRET);
    expect(l.hard).toHaveLength(2);
    expect(l.soft).toHaveLength(2);    // the NaN inside £NaN, and "undefined"
  });
  it('scrubs the snippets it returns', () => {
    const l = walk.findLeaks(`${SECRET} [object Object]`, SECRET);
    expect(l.hard.join(' ')).not.toContain(SECRET.slice(0, 10));
  });
});

describe('prod-walk.js findGate', () => {
  it('names the gates measured on 27 Sep 2026, and the pages that show their own token screen', () => {
    expect(walk.findGate('Who are you? Select your name to personalise your task view.')).toBe('asks who is viewing');
    expect(walk.findGate('Inbound Comms Tracker Sign in with your Google account to view emails')).toBe('asks for a Google sign-in');
    expect(walk.findGate('Loading... SOP generated')).toBe('still loading');
    expect(walk.findGate('Payment Run  Loading the week… ')).toBe('still loading');
    expect(walk.findGate('Property Compliance Enter your Airtable Personal Access Token to continue')).toBe('shows its own sign-in screen');
    expect(walk.findGate('CRM Sign in from the main app to see your contacts')).toBe('shows its own sign-in screen');
  });
  it('does not call a long page with sign-in words in it a gate', () => {
    expect(walk.findGate('Who are you? ' + 'real content '.repeat(200))).toBe('');
    expect(walk.findGate('Objective & Strategy Live, linked to Airtable')).toBe('');
  });
});

describe('prod-walk.js noise and app errors', () => {
  it('treats telemetry and extensions as outside noise (the three false FAILs of the first run)', () => {
    expect(walk.isNoise('https://csi.gstatic.com/csi')).toBe(true);
    expect(walk.isNoise('https://logs.browser-intake-datadoghq.com/api/v2/logs')).toBe(true);
    expect(walk.isNoise('chrome-extension://invalid/')).toBe(true);
  });
  it('charges everything else to the app, including the Google and CDN hosts it calls on purpose', () => {
    for (const u of [ORIGIN + '/js/shared.js', 'https://api.airtable.com/v0/app/tbl', 'https://www.googleapis.com/drive/v3',
                     'https://script.google.com/macros/s/x', 'https://cdn.jsdelivr.net/npm/chart.js', '']) {
      expect(walk.isNoise(u), u).toBe(false);
    }
  });
  it('is not fooled by a lookalike telemetry host', () => {
    expect(walk.isNoise('https://csi.gstatic.com.evil.example/x')).toBe(false);
  });
  it('charges an uncaught exception to the app only when its stack runs through the app', () => {
    expect(walk.isAppError(`TypeError: x\n    at render (${ORIGIN}/js/pnl.js:10:5)`, ORIGIN)).toBe(true);
    expect(walk.isAppError('Error: boom', ORIGIN)).toBe(true);
    expect(walk.isAppError('Error: x\n    at https://accounts.google.com/gsi/client:1:2', ORIGIN)).toBe(false);
    // Content Machine is a registry page on Kevin's other host: its crash is the app's.
    expect(walk.isAppError('Error: x\n    at https://chaichoong.github.io/content-machine/app.js:3:1', ORIGIN)).toBe(true);
  });
});

describe('prod-walk.js routeFor', () => {
  it('walks a panel in the shell and anything else as its own page, hash dropped', () => {
    expect(walk.routeFor({ standalone: 'index.html#cfv' }, true)).toEqual({ kind: 'shell' });
    expect(walk.routeFor({ standalone: 'compliance.html' }, false)).toEqual({ kind: 'page', file: 'compliance.html' });
    expect(walk.routeFor({ standalone: 'os/agents/index.html#ceo-brief' }, false)).toEqual({ kind: 'page', file: 'os/agents/index.html' });
    expect(walk.routeFor({ standalone: '' }, false)).toEqual({ kind: 'none' });
  });
});

describe('the weekly sweep skill gives the robot routes that work', () => {
  const skill = read('.claude/scheduled-tasks/prod-sweep-weekly/SKILL.md');
  const title = (skill.match(/`(SITE CHECK: [^`]+)`/) || [])[1];
  const status = (skill.match(/Status\s+`fldx4qCw17UfrKpaN`\s*=\s*`([^`]+)`/) || [])[1];

  it('runs the walk script with a long enough command timeout', () => {
    expect(skill).toMatch(/node scripts\/prod-walk\.js/);
    expect(skill).toMatch(/600000/);
  });

  it('names a task title and status that the real duplicate gate accepts (drives create-agent-task.py)', () => {
    expect(title, 'the skill must name one fixed SITE CHECK title').toBeTruthy();
    const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("cat", "scripts/create-agent-task.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
F = m.F
T, S = sys.argv[1], sys.argv[2]
def row(i, name): return {"id": i, "createdTime": "2026-09-01T00:00:00Z", "fields": {F["name"]: name, F["status"]: "Today"}}
others = [row("rX", "Fix compliance page auth screen"), row("rY", "Check CFV figures for Elmdon"),
          row("rZ", "E2E Sweep [CRITICAL]: hard-deadline-passed-still-open"), row("rV", "Dashboard: fix overview KPI tiles"),
          row("rA", "Fix dashboard faults"), row("rB", "Faults found on the Money dashboard"),
          row("rC", "Leadership dashboard faults on cash flow"), row("rD", "Sunday walk faults"),
          row("rE", "SITE CHECK: payments page walk")]
print(json.dumps({"statusOk": S in m.NEW_TASK_STATUSES,
                  "first": m.decide({F["name"]: T}, others)["action"],
                  "again": m.decide({F["name"]: T}, others + [row("rS", T)]).get("taskId")}))
`;
    const out = JSON.parse(execFileSync('python3', ['-c', py, title, status], { cwd: ROOT, encoding: 'utf8' }));
    expect(out.statusOk).toBe(true);           // "To do" was not a valid status
    expect(out.first).toBe('create');          // never folded into an unrelated task
    expect(out.again).toBe('rS');              // next Sunday folds into its own open task
  });
});
