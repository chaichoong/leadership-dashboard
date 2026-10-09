// Kevin's turn (30 Sep 2026): "Anything that I'm not needed for, you can do
// behind the scenes. Anything where I'm needed to either make payment or
// something, we need to do it via this new process." The robot opens its own
// window, does every step up to Kevin's, waits while he does his own part (a
// sign-in), hands him the window and never submits, pays or declares. These
// drive the real functions and the real `handover` command against a local page.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
// Real Chrome launches in this file. 90s, not the suite's 30s (9 Oct 2026): in the merge
// gate's throwaway tree, with the full suite running in parallel, a launch alone went past 30s
// and refused every PR that day (main a40fa493 failed here; each test passes alone).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

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
  <input type="password" id="hidden-pw" style="display:none">
  <label for="yr">What year did you buy it?</label><input id="yr">
  <label><input type="checkbox" id="wrapped"> I have read the statement of fact</label>
  <button id="b2" onclick="document.getElementById('out').textContent='SPAN-BUY'"><span id="s2">Buy policy</span></button>
  <div id="dv">Confirm order</div>
  <input type="checkbox" id="em"><label for="em">Email</label>
  <label for="mo">How would you like to pay?</label><input type="radio" name="freq" id="mo"><label for="mo" id="mo-opt">Monthly</label>
  <fieldset><legend>Do you agree with all the assumptions above?</legend><input type="radio" name="asm" id="asm-y"><label for="asm-y" id="asm-yl">Yes</label></fieldset>
  <label for="dc">I confirm the statements above are true</label><input type="checkbox" id="dc"><label for="dc" id="dc-yes">Yes</label>
  <span id="terms">I have read and understood the policy terms</span><div role="checkbox" aria-checked="false" aria-labelledby="terms" id="rc" onclick="this.setAttribute('aria-checked','true')"></div><div role="switch" aria-labelledby="terms" id="sw" onclick="this.dataset.on='1'"></div>
  <main role="main"><p>Pay monthly or yearly</p><span id="plain">Show more</span></main>
  <label for="ds">I confirm the assumptions are correct</label><select id="ds"><option value="">Select</option><option>Yes</option></select>
  <label for="bt">Property built</label><select id="bt"><option value="">Select</option><option>1970 - 1989</option></select>
  <fieldset><legend>Do you agree with the statements above?</legend><button type="button" id="tb" aria-pressed="false" onclick="this.setAttribute('aria-pressed','true')">Yes, that is right</button></fieldset>
  <fieldset><legend>I declare the details above are correct</legend><button type="button" id="tb2" onclick="document.getElementById('out').textContent='DECLARED'">Yes</button></fieldset>
  <label for="sig">Type your full name to sign</label><input id="sig">
  <label for="as">Assumptions</label><select id="as"><option value="">Select</option><option>I agree with all the assumptions</option></select>
  <div><h3>Do you agree with the statements above?</h3><button type="button" id="h3y" onclick="document.getElementById('out').textContent='H3-YES'">Yes</button><button type="button">No</button></div>
  <div><span>I declare the information I have given is true</span><input type="radio" name="sp" id="spy"><label for="spy" id="spyl">Yes</label><input type="radio" name="sp" id="spn"><label for="spn">No</label></div>
  <div><p>Is the property of standard construction? Not sure? Read our guide.</p><input type="radio" name="sc" id="scy"><label for="scy" id="scyl">Yes</label><input type="radio" name="sc" id="scn"><label for="scn">No</label></div>
  <div><div><p>Has the property flooded in the last 10 years?</p><input type="radio" name="fl" id="fln"><label for="fln" id="flnl">No</label></div><div><p>I declare the above is true</p><input type="radio" name="dt" id="dty"><label for="dty">Yes</label></div></div>
  <div><input type="email" aria-label="Email"><input type="checkbox" id="cons"><span>I agree to the terms of business</span></div>
  <div><input type="email" aria-label="Email 2"><span class="cb"><input type="checkbox" id="cons2"></span><span>I agree to the terms of business</span></div>
  <div><select aria-label="Address"></select><input type="checkbox" id="cons3"><span>I agree to the terms of business</span></div>
  <div><p>I declare that the information given is true and correct</p><div class="opts"><input type="radio" name="dd" id="ddy"><label for="ddy" id="ddyl">Yes</label><input type="radio" name="dd" id="ddn"><label for="ddn">No</label></div><label for="ddx">If no, give details</label><input id="ddx"></div>
  <div><label for="ps">Property status</label><select id="ps"><option value="">Select</option><option>Let</option><option>I agree</option></select></div>
  <div id="out"></div>
  <script>
    setTimeout(() => { const d = document.createElement('div'); d.id = 'signed-in'; d.textContent = 'My account'; document.body.appendChild(d); }, 800);
    setTimeout(() => { document.getElementById('pw').remove(); }, 2300);
    document.getElementById('dv').addEventListener('click', () => { document.getElementById('out').textContent = 'DIV-ORDER'; });
    document.getElementById('plain').addEventListener('click', () => { document.getElementById('out').textContent = 'PLAIN'; });
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
    // Enter can submit a form: a handover presses only Tab and Space.
    expect(() => b.assertHandoverPlan({ ...ok, steps: [{ do: 'press', selector: '#q', key: 'Enter' }] })).toThrow(/only Tab and Space/);
    // An arrow key picks a radio answer, so a declaration group could be answered by one (review round 4).
    expect(() => b.assertHandoverPlan({ ...ok, steps: [{ do: 'press', selector: '#q', key: 'ArrowRight' }] })).toThrow(/an arrow key picks a radio answer/);
    expect(() => b.assertHandoverPlan({ ...ok, steps: [{ do: 'press', selector: '#q', key: 'Tab' }] })).not.toThrow();
  });
  // Kevin, 7 Oct 2026: plans fill, Kevin submits. The robot had filled Agile Estates' confirmation
  // statement at 08:31; the plan for his window, written at 08:34, told him to type it all again.
  it('refuses a step of Kevin\'s that asks him for the robot\'s work: the two plans of 7 Oct, word for word', () => {
    const signIn = { do: 'kevin', say: 'Sign in to Companies House WebFiling with GOV.UK One Login', untilUrl: 'page=savedCompanies' };
    const robot = { do: 'click', selector: 'text=AGILE ESTATES LTD' };
    // recGImsRxDQ1UYBti as written on 7 Oct (its "why" and its last step).
    const agileWhy = "the robot signs you through to Agile Estates, where a part-done statement waits. Pick 'Continue with this "
      + "confirmation statement' and press SUBMIT. Then answer exactly as the screenshot on the card shows: Yes to email, office, "
      + 'officers, registers and PSCs; tick SIC, share capital (press Confirm, amount unpaid 0) and shareholders; tick the two '
      + 'confirmation boxes; press Submit and pay the 50 pound fee';
    const agileLast = { do: 'kevin', say: "Pick 'Continue with this confirmation statement', press SUBMIT, answer as the screenshot "
      + 'on the card shows, tick the two confirmation boxes, press Submit and pay the 50 pound fee', untilText: 'Thank you' };
    expect(() => b.assertHandoverPlan({ why: agileWhy, steps: [signIn, robot] })).toThrow(/"why" asks Kevin to "answer exactly"/);
    expect(() => b.assertHandoverPlan({ why: 'pay', steps: [signIn, robot, agileLast] })).toThrow(/step 3 \(kevin\) asks Kevin to "answer as"/);
    // rec9g6PKSy4nhdriO as written on 1 Oct.
    const sheWhy = "choose Continue on the saved draft, add the personal code for each director, answer each "
      + "'is this correct?' question, tick the two confirmations, submit and pay the GBP 50 fee";
    const sheLast = { do: 'kevin', say: "Pick 'Continue with this confirmation statement' and press SUBMIT (this only reopens the draft). "
      + "Then add both directors' personal codes, answer the questions, tick the two confirmations, submit and pay GBP 50.", untilText: 'Statement date' };
    expect(() => b.assertHandoverPlan({ why: sheWhy, steps: [signIn, robot] })).toThrow(/"why" asks Kevin to "answer each"/);
    expect(() => b.assertHandoverPlan({ why: 'pay', steps: [signIn, robot, sheLast] })).toThrow(/asks Kevin to "answer the"/);
    // A step of his in the middle that is not his sign-in, a code or his own statement.
    expect(() => b.assertHandoverPlan({ why: 'pay', steps: [signIn, { do: 'kevin', say: 'Pick the company and press Continue', untilText: 'x' }, robot] }))
      .toThrow(/step 2 \(kevin\) sits in the middle of the plan/);
    // The other words for the same thing.
    for (const say of ['Fill in the rest of the form', 'Re-enter the answers below', 'Type the answers from the card', 'Enter the address',
      'Tick SIC, share capital and shareholders', 'Retype each value', 'Complete the rest of the form as the card shows',
      'Select Yes for each question', 'Choose the answers shown in the screenshot', 'Type the SIC code and share capital',
      // Second review, 7 Oct 2026: the same work in other words.
      'Complete the form from the card and pay', 'Provide the details from the card', 'Put in the answers and pay',
      'Copy the answers into the form', 'Work through each page and pay', 'Decide every answer on the form', 'Type the SIC code.']) {
      expect(() => b.assertHandoverPlan({ why: 'pay', steps: [robot, { do: 'kevin', say, untilText: 'x' }] }), say).toThrow(/asks Kevin to/);
    }
    // Calling it his own statement does not make the robot's answers his (review, 7 Oct 2026).
    expect(() => b.assertHandoverPlan({ why: 'pay', steps: [robot, { do: 'kevin', say: 'This is your own statement: fill in every field from the card', untilText: 'x' }, robot] }))
      .toThrow(/step 2 \(kevin\) asks Kevin to "fill"/);
  });
  it('lets through what only Kevin can give: his sign-in, a code, card or bank details, his own statement, the declarations, submit and pay', () => {
    const robot = { do: 'click', selector: '#next' };
    const ok = (plan) => expect(() => b.assertHandoverPlan(plan), JSON.stringify(plan)).not.toThrow();
    // The two plans as rewritten on 7 Oct: his sign-in first, the robot's answers, his part in "why".
    ok({ why: 'tick the two declaration boxes at the foot of the statement, press Submit and pay the £50 fee',
         steps: [{ do: 'kevin', say: 'Sign in to Companies House WebFiling with GOV.UK One Login', untilUrl: 'page=savedCompanies' }, robot,
                  { do: 'check', selector: "label:text-is('Yes') >> nth=0" }] });
    ok({ why: "decide five answers the robot could not check: ...; then add both directors' personal codes, "
           + 'tick the two declaration boxes, press Submit and pay the £50 fee',
         steps: [{ do: 'kevin', say: 'Sign in to Companies House with GOV.UK One Login.', untilText: 'Saved companies' }, robot] });
    // The DWP form (scripts/rent_form_plan.py): his own statement and an emailed code, mid-plan; bank numbers at the end.
    ok({ why: 'choose the reason this tenant needs the rent paid direct if the form has not asked yet, type the sort code '
           + 'and account number, check every answer, and press Accept and send',
         steps: [robot, { do: 'kevin', say: 'Choose the reason this tenant needs the rent paid direct. It is your own statement to the DWP. '
                          + 'Then press Continue until the page asking for the rent opens.', untilSelector: '#f-rentAmount' },
                 robot, { do: 'kevin', say: 'Type the code the DWP has just emailed to info@agilelets.co.uk, then press Continue.', untilSelector: '#x' },
                 robot] });
    // Sign-ins as agents write them, and a last step that is his declarations.
    ok({ why: 'answer the declaration questions yourself and pay', steps: [
      { do: 'kevin', say: 'Sign in to Namecheap with your usual username and password, and any security code it asks for.', untilUrl: 'x' },
      { do: 'kevin', say: 'Click Login and sign in to AXA. Enter your email and password.', untilUrl: 'y' }, robot,
      { do: 'kevin', say: 'Tick both declarations, press Submit and pay by card', untilText: 'Thank you' }] });
    // What a sign-in or a payment really asks of him (review, 7 Oct 2026: each of these was refused).
    for (const say of ['Sign in with your password and press Enter', 'Log in and enter your memorable word',
      'Sign in: enter your National Insurance number, then answer the security questions', 'Log in and enter your credentials',
      'Enter the 6-digit code it texts you',
      // Second review, 7 Oct 2026: a code step mid-plan, however it is worded.
      'Enter the code', 'Enter the 2FA code', 'Enter the six-digit code', 'Enter the code from your phone',
      'Enter the code from the text message', 'Sign in and enter the code your bank app shows']) {
      ok({ why: 'pay', steps: [{ do: 'kevin', say, untilText: 'x' }, robot] });
    }
    for (const say of ['Fill in your card details and press Pay', 'Tick the box to agree to the terms, then press Pay',
      'Type your full name as your signature and press Sign',
      // His own final clicks and checks (second review, 7 Oct 2026).
      'Click Yes to confirm the payment', 'Choose Yes to accept the quote and pay', 'Press Pay as shown',
      'Check the page matches the screenshot on the card, tick the declaration and pay',
      'Read the question and tick the declaration, then pay', 'Check every box is right, then press Submit']) {
      ok({ why: 'pay', steps: [robot, { do: 'kevin', say, untilText: 'x' }] });
    }
    // A statement of his is his to make, but never the robot's answers over again.
    expect(() => b.assertHandoverPlan({ why: 'pay', steps: [robot, { do: 'kevin', say: 'Answer each of the questions as shown: it is your own statement', untilText: 'x' }, robot] }))
      .toThrow(/step 2 \(kevin\) asks Kevin to "the questions"/);
  });
  it('a window that stops early says everything from there is his, never only the declarations (review, 7 Oct 2026)', () => {
    const banner = b.stuckBanner({ step: 8, error: 'refused: "Continue with this confirmation statement" reads like a declaration, which is Kevin\'s' },
      'tick the two declaration boxes at the foot of the statement, press Submit and pay the £50 fee');
    expect(banner).toMatch(/^The robot stopped at step 8 \(refused: "Continue with this confirmation statement" reads like a declaration/);
    expect(banner).toMatch(/Everything from here is yours: finish by hand, or close this window\. At the end: tick the two declaration boxes/);
  });
  it('fills {{today}} with the UK date', () => {
    expect(b.fillTokens('{{today}}', new Date('2026-10-01T09:00:00Z'))).toBe('01/10/2026');
    expect(b.fillTokens('CB9 0AJ')).toBe('CB9 0AJ');
  });
});

describe('the handover guard on a confirmation statement (real Chromium, 7 Oct 2026)', () => {
  // The session lead's ruling on PR #719: submit, pay, order, send, file, sign and complete are always
  // Kevin's. Confirm, declare, agree, accept, statement, correct and true are his unless the control
  // also says it moves on (Continue, Next) and is not the last step before one of those, or it is an
  // answer the plan names in "answers" and quotes in its "sources". A first-person declaration is his.
  const PAGE_CS01 = `<form id="resume"><p>Would you like to:</p>
      <label><input type="radio" name="r" id="cont"> Continue with this confirmation statement</label>
      <label><input type="radio" name="r"> Delete this confirmation statement and go to your company overview</label>
      <input type="submit" value="SUBMIT" onclick="event.preventDefault();document.getElementById('out').textContent='SUBMITTED'"></form>
    <fieldset><legend>Is the registered office address correct?</legend>
      <label><input type="radio" name="ro" id="roy"> Yes, the registered office is correct</label>
      <label><input type="radio" name="ro"> No</label></fieldset>
    <label><input type="checkbox" id="sic"> The Standard Industrial Classification (SIC) information is correct</label>
    <label><input type="checkbox" id="decl"> I confirm that the information is correct</label>
    <button type="button" id="order" onclick="document.getElementById('out').textContent='ORDERED'">Confirm order</button>
    <button type="button" id="cpay" onclick="document.getElementById('out').textContent='PAID'">Confirm and pay</button>
    <button type="button" id="next" onclick="document.getElementById('out').textContent='NEXT'">Confirm and continue</button>
    <button type="button" id="pay" onclick="document.getElementById('out').textContent='PAID'">Pay now</button>
    <div id="out"></div>`;
  const SOURCES = 'Register read 7 Oct: office matches, so "Yes, the registered office is correct"; '
    + 'SIC 68100 matches, so "The Standard Industrial Classification (SIC) information is correct".';
  const NAMED = ['Yes, the registered office is correct', 'The Standard Industrial Classification (SIC) information is correct'];
  let browser, page;
  const fresh = async () => { await page.setContent(PAGE_CS01); };
  const run1 = (steps, answers) => b.runHandover(page, { why: 'pay', sources: SOURCES, answers, steps: steps.map(x => ({ timeout: 2000, ...x })) }, { quiet: true });
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); page = await browser.newPage(); });
  afterAll(async () => { await browser.close(); });

  it('"Continue with this confirmation statement" is the robot\'s: it moves on', async () => {
    await fresh();
    const r = await run1([{ do: 'check', selector: 'text=Continue with this confirmation statement' }]);
    expect(r.stuck).toBeNull();
    expect(await page.isChecked('#cont')).toBe(true);
  });
  it('...but not as the last step before the SUBMIT on its page, whoever presses it', async () => {
    await fresh();
    const robot = await run1([{ do: 'check', selector: 'text=Continue with this confirmation statement' }, { do: 'click', selector: '#resume [type=submit]' }]);
    expect(robot.stuck).toMatchObject({ step: 1 });
    expect(robot.stuck.error).toMatch(/last step before a submit, pay or send/);
    expect(await page.isChecked('#cont')).toBe(false);
    const his = await run1([{ do: 'check', selector: 'text=Continue with this confirmation statement' }, { do: 'kevin', say: 'Press SUBMIT', untilText: 'x' }]);
    expect(his.stuck).toMatchObject({ step: 1 });
    expect(await page.isChecked('#cont')).toBe(false);
  });
  it('a SUBMIT, a "Confirm order" and a "Confirm and pay" are always Kevin\'s; "Confirm and continue" is not', async () => {
    await fresh();
    for (const sel of ['#resume [type=submit]', '#order', '#cpay']) {
      const r = await run1([{ do: 'click', selector: sel }]);
      expect(r.stuck && r.stuck.error, sel).toMatch(/final action/);
    }
    expect(await page.locator('#out').textContent()).toBe('');
    const next = await run1([{ do: 'click', selector: '#next' }]);
    expect(next.stuck).toBeNull();
    expect(await page.locator('#out').textContent()).toBe('NEXT');
    // ...unless it is the last step before one of his.
    await fresh();
    const before = await run1([{ do: 'click', selector: '#next' }, { do: 'click', selector: '#pay' }]);
    expect(before.stuck.error).toMatch(/last step before a submit, pay or send/);
    expect(await page.locator('#out').textContent()).toBe('');
  });
  it('"Yes, the registered office is correct" is the robot\'s when the plan names it and its sources quote it; not otherwise', async () => {
    await fresh();
    const unnamed = await run1([{ do: 'check', selector: '#roy' }]);
    expect(unnamed.stuck.error).toMatch(/reads like a declaration/);
    expect(await page.isChecked('#roy')).toBe(false);
    const named = await run1([{ do: 'check', selector: '#roy' }, { do: 'check', selector: '#sic' }], NAMED);
    expect(named.stuck).toBeNull();
    expect(await page.isChecked('#roy')).toBe(true);
    expect(await page.isChecked('#sic')).toBe(true);
    expect(() => b.assertHandoverPlan({ why: 'pay', sources: SOURCES, answers: NAMED, steps: [{ do: 'check', selector: '#roy' }] })).not.toThrow();
    // Named but never quoted in the sources: refused before any window opens.
    expect(() => b.assertHandoverPlan({ why: 'pay', sources: 'the register', answers: NAMED, steps: [{ do: 'check', selector: '#roy' }] }))
      .toThrow(/never quote it/);
  });
  it('"I confirm that the information is correct" is Kevin\'s even when a plan tries to name it', async () => {
    await fresh();
    const r = await run1([{ do: 'check', selector: '#decl' }], ['I confirm that the information is correct']);
    expect(r.stuck.error).toMatch(/reads like a declaration/);
    expect(await page.isChecked('#decl')).toBe(false);
    for (const a of ['I confirm that the information is correct', 'Confirm and pay']) {
      expect(() => b.assertHandoverPlan({ why: 'pay', sources: a, answers: [a], steps: [{ do: 'wait', ms: 1 }] }), a).toThrow(/never a named answer/);
    }
  });
  it('a mid-plan step of Kevin\'s that presses a SUBMIT only he may press is allowed', () => {
    expect(() => b.assertHandoverPlan({ why: 'pay', steps: [
      { do: 'kevin', say: "Pick 'Continue with this confirmation statement' and press SUBMIT: it only reopens the saved draft.", untilText: 'Statement date' },
      { do: 'check', selector: '#roy' }] })).not.toThrow();
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
      // It waited for the password box to go (2.3 s), not just for the words (0.8 s), and a
      // hidden one (a signed-in page's change-password form) never holds it up.
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
      expect(decl.stuck.error).toMatch(/final action|reads like a declaration/);
      expect(await page.locator('#decl').isChecked()).toBe(false);
      // A text box is not a Buy button, whatever its question says (AXA's "What year did you buy it?").
      const year = await b.runHandover(page, { why: 'pay', steps: [
        { do: 'fill', selector: '#yr', value: '2009' }, { do: 'press', selector: '#yr', key: 'Tab' }, { do: 'click', selector: '#yr' } ] });
      expect(year.stuck).toBeNull();
      // Review round 2: a span inside a Buy button, a plain div with a listener, a tick box
      // its label wraps, and an address worded like the last step are all his.
      for (const [sel, what] of [['#s2', 'span'], ['#dv', 'div'], ['#wrapped', 'wrapped']]) {
        const r2 = await b.runHandover(page, { why: 'pay', steps: [{ do: sel === '#wrapped' ? 'check' : 'click', selector: sel }] });
        expect(r2.stuck && r2.stuck.error, what).toMatch(/refused/);
      }
      expect(await page.locator('#out').textContent()).not.toMatch(/SPAN-BUY|DIV-ORDER/);
      expect(await page.locator('#wrapped').isChecked()).toBe(false);
      const url = await b.runHandover(page, { why: 'pay', steps: [{ do: 'goto', url: base + 'checkout/confirm' }] });
      expect(url.stuck.error).toMatch(/looks like the final step/);
      // A tick box that is only a contact preference is the robot's to tick.
      const em = await b.runHandover(page, { why: 'pay', steps: [{ do: 'press', selector: '#em', key: 'Space' }] });
      expect(em.stuck).toBeNull();
      expect(await page.locator('#em').isChecked()).toBe(true);
      // Clicking an option's own label reads the option, not the question AXA also points at it.
      const mo = await b.runHandover(page, { why: 'pay', steps: [{ do: 'click', selector: '#mo-opt' }] });
      expect(mo.stuck).toBeNull();
      expect(await page.locator('#mo').isChecked()).toBe(true);
      // Review round 3: a declaration answered by a "Yes" label, a radio in a fieldset whose
      // legend asks it, or an ARIA tick box is his; a click inside a region is not read as the region.
      for (const sel of ['#asm-yl', '#asm-y', '#dc-yes', '#rc', '#sw']) {
        const r3 = await b.runHandover(page, { why: 'pay', steps: [{ do: 'click', selector: sel }] });
        expect(r3.stuck && r3.stuck.error, sel).toMatch(/reads like a declaration|final action/);
      }
      expect(await page.locator('#asm-y').isChecked()).toBe(false);
      expect(await page.locator('#dc').isChecked()).toBe(false);
      expect(await page.locator('#rc').getAttribute('aria-checked')).toBe('false');
      const plain = await b.runHandover(page, { why: 'pay', steps: [{ do: 'click', selector: '#plain' }] });
      expect(plain.stuck).toBeNull();
      expect(await page.locator('#out').textContent()).toBe('PLAIN');
      // Review round 4: a dropdown or a Yes button answering a declaration, and a name typed as a
      // signature, are his; an ordinary dropdown is the robot's.
      for (const st of [{ do: 'select', selector: '#ds', value: 'Yes' }, { do: 'click', selector: '#tb' }, { do: 'click', selector: '#tb2' }, { do: 'fill', selector: '#sig', value: 'Kevin Brittain' },
                        { do: 'select', selector: '#as', value: 'I agree with all the assumptions' }, { do: 'click', selector: '#h3y' }, { do: 'click', selector: '#spyl' },
                        { do: 'check', selector: '#cons' }, { do: 'check', selector: '#cons2' }, { do: 'check', selector: '#cons3' },
                        { do: 'click', selector: '#ddyl' }]) {
        const r4 = await b.runHandover(page, { why: 'pay', steps: [st] });
        expect(r4.stuck && r4.stuck.error, st.selector).toMatch(/reads like a declaration|looks like a signature/);
      }
      expect(await page.locator('#ds').inputValue()).toBe('');
      expect(await page.locator('#tb').getAttribute('aria-pressed')).toBe('false');
      expect(await page.locator('#out').textContent()).not.toBe('DECLARED');
      expect(await page.locator('#sig').inputValue()).toBe('');
      // Round 5: the option picked can be the declaration, and a question can sit in plain text.
      expect(await page.locator('#as').inputValue()).toBe('');
      expect(await page.locator('#spy').isChecked()).toBe(false);
      expect(await page.locator('#cons').isChecked()).toBe(false);
      expect(await page.locator('#cons2').isChecked()).toBe(false);
      expect(await page.locator('#cons3').isChecked()).toBe(false);
      expect(await page.locator('#ddy').isChecked()).toBe(false);
      expect(await page.locator('#out').textContent()).not.toBe('H3-YES');
      // Round 6: help text, the next question's declaration and a dropdown's other options are not
      // this answer's question.
      for (const st of [{ do: 'click', selector: '#scyl' }, { do: 'click', selector: '#flnl' }, { do: 'select', selector: '#ps', value: 'Let' }]) {
        const r6 = await b.runHandover(page, { why: 'pay', steps: [st] });
        expect(r6.stuck, st.selector).toBeNull();
      }
      expect(await page.locator('#scy').isChecked()).toBe(true);
      expect(await page.locator('#fln').isChecked()).toBe(true);
      expect(await page.locator('#ps').inputValue()).toBe('Let');
      const built = await b.runHandover(page, { why: 'pay', steps: [{ do: 'select', selector: '#bt', value: '1970 - 1989' }] });
      expect(built.stuck).toBeNull();
      const stuck = await b.runHandover(page, { why: 'pay', steps: [{ do: 'click', selector: '#not-there', timeout: 1000 }] }, {});
      expect(stuck.stuck).toMatchObject({ step: 1, do: 'click' });
      expect(stuck.stuck.error).toMatch(/could not read what/);     // unreadable: not touched, his window
      const late = await b.runHandover(page, { why: 'pay', steps: [{ do: 'kevin', say: 'Sign in', untilSelector: '#never' }] }, { kevinMs: 1500 });
      // A dry run's screenshot is the page, without the green bar.
      const fresh = await browser.newPage();
      await fresh.goto(base);
      await b.runHandover(fresh, { why: 'pay', steps: [{ do: 'fill', selector: '#date', value: '01/10/2026' }] }, { quiet: true });
      expect(await fresh.locator('#od-your-turn').count()).toBe(0);
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

  it("--dry-run proves a plan before the card reaches Kevin: same guard, his steps skipped, no approval read, no hold", async () => {
    const x = home('Changes requested');
    writeFileSync(join(x.plans, TASK + '.json'), JSON.stringify({ why: 'pay', steps: [
      { do: 'kevin', say: 'Sign in', goto: base, untilSelector: '#never' },
      { do: 'goto', url: base },
      { do: 'fill', selector: '#date', value: '{{today}}' },
      { do: 'click', selector: '#buy' },
    ] }));
    const shot = join(x.h, 'dry.png');
    const r = await run(envFor(x), ['handover', '--task', TASK, '--dry-run', '--shot', shot]);
    expect(r.code, r.err).toBe(3);
    const last = JSON.parse(r.out.trim().split('\n').pop());
    // The step number is the plan file's own: Kevin's skipped step still counts (7 Oct 2026).
    expect(last).toMatchObject({ mode: 'handover-dry-run', steps: 2, stuck: { step: 4, do: 'click' } });
    expect(last.stuck.error).toMatch(/final action/);
    expect(existsSync(shot)).toBe(true);
    expect(existsSync(join(x.h, 'asked'))).toBe(false);
    expect(existsSync(x.dir + '.signin-hold')).toBe(false);
  }, 60000);
});
