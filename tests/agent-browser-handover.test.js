// Kevin's turn (30 Sep 2026): "Anything that I'm not needed for, you can do
// behind the scenes. Anything where I'm needed to either make payment or
// something, we need to do it via this new process." The robot opens its own
// window, does every step up to Kevin's, waits while he does his own part (a
// sign-in), hands him the window and never submits, pays or declares. These
// drive the real functions and the real `handover` command against a local page.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';

const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'agent-browser.js');
const b = require_(SCRIPT);
let chromium;
try { ({ chromium } = require_('playwright-core')); } catch { /* reported below */ }

const TASK = 'recPYIC5nn7v2bh8e';
const made = [];
let server, base;
// A two-step form: a date box, a Next button, and a "signed in" marker that
// appears a moment after load (standing in for Kevin finishing his sign-in).
// Also a password box that stays 1.5 s after the "signed in" words appear (a sign-in
// page can carry them), a Buy button and a declarations tick box: the robot must
// wait for the box to go, and never press either of the last two.
const PAGE = `<!doctype html><html><body>
  <input id="date" placeholder="DD/MM/YYYY"><button id="next" onclick="document.getElementById('out').textContent='NEXT:'+document.getElementById('date').value">Next</button>
  <button id="buy" onclick="document.getElementById('out').textContent='BOUGHT'">Buy policy</button>
  <input type="checkbox" id="decl"><label for="decl">I confirm the declarations are true</label>
  <input type="password" id="pw">
  <label for="yr">What year did you buy it?</label><input id="yr">
  <div id="out"></div>
  <script>
    setTimeout(() => { const d = document.createElement('div'); d.id = 'signed-in'; d.textContent = 'My account'; document.body.appendChild(d); }, 800);
    setTimeout(() => { document.getElementById('pw').remove(); }, 2300);
  </script>
</body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
});
afterAll(() => { server.close(); for (const d of made) rmSync(d, { recursive: true, force: true }); });

function home(outcome) {
  const h = mkdtempSync(join(tmpdir(), 'od-turn-'));
  made.push(h);
  const root = join(h, '.config', 'od', 'agent-browser');
  mkdirSync(join(root, 'default'), { recursive: true });
  const sites = join(root, 'sites.json');
  writeFileSync(sites, JSON.stringify({ '127.0.0.1': { label: 'Test site', login: false } }));
  const plans = join(h, 'handover');
  mkdirSync(plans, { recursive: true });
  // The approval read, stubbed: prints the outcome and leaves a mark that it was asked.
  const outcomeScript = join(h, 'outcome.py');
  writeFileSync(outcomeScript, `import json, sys, pathlib\npathlib.Path(${JSON.stringify(join(h, 'asked'))}).write_text('1')\nprint(json.dumps({"outcome": ${JSON.stringify(outcome)}}))\n`);
  return { h, dir: join(root, 'default'), sites, plans, outcomeScript };
}
function run(env, args, ms = 60000) {
  return new Promise(res => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { err += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), ms);
    c.on('exit', code => { clearTimeout(t); res({ code, out, err }); });
  });
}
const envFor = (x) => ({ HOME: x.h, AGENT_BROWSER_SITES_FILE: x.sites, AGENT_HANDOVER_DIR: x.plans,
                         AGENT_OUTCOME_SCRIPT: x.outcomeScript, AGENT_HANDOVER_HEADLESS: '1', AGENT_HANDOVER_WAIT_MS: '1500',
                         AGENT_HANDOVER_PAUSE_MS: '100' });

describe('a handover plan never submits, pays or uploads', () => {
  it('refuses a submit or upload step, an unknown step, a plan with no "why", and a Kevin step with no end', () => {
    const ok = { why: 'answer the declarations and pay', steps: [{ do: 'click', selector: '#next' }] };
    expect(() => b.assertHandoverPlan(ok)).not.toThrow();
    expect(() => b.assertHandoverPlan({ ...ok, steps: [{ do: 'submit', selector: '#buy' }] })).toThrow(/never submits, pays or uploads/);
    expect(() => b.assertHandoverPlan({ ...ok, steps: [{ do: 'upload', selector: '#f', file: 'x.pdf' }] })).toThrow(/never submits, pays or uploads/);
    expect(() => b.assertHandoverPlan({ ...ok, steps: [{ do: 'evaluate' }] })).toThrow(/never submits/);
    expect(() => b.assertHandoverPlan({ steps: ok.steps })).toThrow(/needs "why"/);
    expect(() => b.assertHandoverPlan({ ...ok, steps: [{ do: 'kevin', say: 'Sign in' }] })).toThrow(/untilUrl, untilSelector, untilText/);
    expect(() => b.assertHandoverPlan({ ...ok, steps: [{ do: 'kevin', say: 'Sign in', untilText: 'My account' }] })).not.toThrow();
    // Enter can submit a form: a handover presses only keys that move or tick.
    expect(() => b.assertHandoverPlan({ ...ok, steps: [{ do: 'press', selector: '#q', key: 'Enter' }] })).toThrow(/only Tab, Space and the arrow keys/);
    expect(() => b.assertHandoverPlan({ ...ok, steps: [{ do: 'press', selector: '#q', key: 'Tab' }] })).not.toThrow();
  });
  it('fills {{today}} with the UK date', () => {
    expect(b.fillTokens('{{today}}', new Date('2026-10-01T09:00:00Z'))).toBe('01/10/2026');
    expect(b.fillTokens('CB9 0AJ')).toBe('CB9 0AJ');
  });
});

describe('the robot does every step up to Kevin, waits for his part, and hands over (real Chromium)', () => {
  it('waits for Kevin, fills the rest, and reports a stuck step instead of throwing', async () => {
    expect(chromium, 'playwright-core is not installed').toBeTruthy();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(base);
      const t0 = Date.now();
      const r = await b.runHandover(page, { why: 'pay', steps: [
        { do: 'kevin', say: 'Sign in', untilSelector: '#signed-in' },
        { do: 'fill', selector: '#date', value: '{{today}}' },
        { do: 'click', selector: '#next' },
      ] });
      expect(r.stuck).toBeNull();
      // It waited for the password box to go (2.3 s), not just for the words (0.8 s).
      expect(Date.now() - t0).toBeGreaterThanOrEqual(2200);
      expect(await page.locator('#pw').count()).toBe(0);
      expect(r.done.map(d => d.do)).toEqual(['kevin', 'fill', 'click']);
      expect(await page.locator('#out').textContent()).toBe('NEXT:' + b.fillTokens('{{today}}'));
      // The green bar tells him it is his turn.
      expect(await page.locator('#od-your-turn').count()).toBe(1);
      // The final click is Kevin's: a Buy button and a declarations tick are refused, untouched.
      const buy = await b.runHandover(page, { why: 'pay', steps: [{ do: 'click', selector: '#buy' }] });
      expect(buy.stuck.error).toMatch(/looks like the final action, which is Kevin's/);
      expect(await page.locator('#out').textContent()).not.toBe('BOUGHT');
      const decl = await b.runHandover(page, { why: 'pay', steps: [{ do: 'check', selector: '#decl' }] });
      expect(decl.stuck.error).toMatch(/final action/);
      expect(await page.locator('#decl').isChecked()).toBe(false);
      // A text box is not a Buy button, whatever its question says (AXA's "What year did you buy it?").
      const year = await b.runHandover(page, { why: 'pay', steps: [
        { do: 'fill', selector: '#yr', value: '2009' }, { do: 'press', selector: '#yr', key: 'Tab' }, { do: 'click', selector: '#yr' } ] });
      expect(year.stuck).toBeNull();
      const stuck = await b.runHandover(page, { why: 'pay', steps: [{ do: 'click', selector: '#not-there', timeout: 1000 }] }, {});
      expect(stuck.stuck).toMatchObject({ step: 1, do: 'click' });
      expect(stuck.stuck.error).toMatch(/could not read what/);     // unreadable: not touched, his window
      const late = await b.runHandover(page, { why: 'pay', steps: [{ do: 'kevin', say: 'Sign in', untilSelector: '#never' }] }, { kevinMs: 1500 });
      expect(late.stuck.error).toMatch(/not done in time: Sign in/);
    } finally {
      await browser.close();
    }
  }, 60000);
});

describe("Kevin's window is his until he closes it", () => {
  it('the wait ends when he closes the window, and not before', async () => {
    const x = home('Approved as-is');
    const ctx = await chromium.launchPersistentContext(join(x.h, 'p'), { headless: true });
    const page = await ctx.newPage();
    const t0 = Date.now();
    setTimeout(() => { for (const p of ctx.pages()) p.close(); }, 600);
    await b.waitForWindowClose(ctx, 10000);
    const took = Date.now() - t0;
    await ctx.close();
    expect(took).toBeGreaterThanOrEqual(500);
    expect(took).toBeLessThan(5000);                 // his close ended it, not the 10 s cap
  }, 30000);
});

describe('the handover command', () => {
  it('refuses a task Kevin has not approved, before any window opens, and leaves no hold', async () => {
    const x = home('Changes requested');
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify({ why: 'pay', steps: [{ do: 'goto', url: base }] }));
    const r = await run(envFor(x), ['handover', '--task', TASK]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/is not approved/);
    expect(spawnSync('pgrep', ['-f', `user-data-dir=${x.dir}`]).status).not.toBe(0);
    expect(existsSync(x.dir + '.signin-hold')).toBe(false);
  }, 30000);

  it('refuses a plan with a submit step without even asking whether it is approved', async () => {
    const x = home('Approved as-is');
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify({ why: 'pay', steps: [{ do: 'submit', selector: '#buy' }] }));
    const r = await run(envFor(x), ['handover', '--task', TASK]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/never submits, pays or uploads/);
    expect(existsSync(join(x.h, 'asked'))).toBe(false);
  }, 30000);

  it('a stuck step still hands him the window, exits 3 and names the step', async () => {
    const x = home('Approved as-is');
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify({ why: 'pay', steps: [
      { do: 'goto', url: base }, { do: 'click', selector: '#not-there', timeout: 1000 } ] }));
    const r = await run(envFor(x), ['handover', '--task', TASK]);
    expect(r.code).toBe(3);
    const last = JSON.parse(r.out.trim().split('\n').pop());
    expect(last).toMatchObject({ handedOver: false, stuck: { step: 2, do: 'click' } });
    expect(r.out).toMatch(/"phase":"your-turn"/);     // the window was still his
    expect(existsSync(x.dir + '.signin-hold')).toBe(false);
  }, 60000);

  it('runs an approved plan, hands the window over, logs it and releases the hold when the window ends', async () => {
    const x = home('Approved as-is');
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify({ why: 'answer the declarations and pay', site: 'test', steps: [
      { do: 'goto', url: base },
      { do: 'fill', selector: '#date', value: '{{today}}' },
      { do: 'click', selector: '#next' },
    ] }));
    const r = await run(envFor(x), ['handover', '--task', TASK]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/"phase":"your-turn"/);
    const last = JSON.parse(r.out.trim().split('\n').pop());
    expect(last).toMatchObject({ mode: 'handover', task: TASK, handedOver: true, stuck: null, steps: 3 });
    expect(existsSync(last.screenshot)).toBe(true);
    const ledger = readFileSync(join(x.h, 'knowledge-os', 'logs', 'agent-browser', 'runs.jsonl'), 'utf8');
    expect(ledger).toMatch(/"cmd":"handover","task":"recPYIC5nn7v2bh8e"/);
    expect(existsSync(x.dir + '.signin-hold')).toBe(false);
    expect(readdirSync(join(x.plans, 'shots')).length).toBe(1);
  }, 60000);
});
