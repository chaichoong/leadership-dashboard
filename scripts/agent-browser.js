#!/usr/bin/env node
/**
 * agent-browser.js — the ONLY route from an agent to a browser.
 *
 * WHY IT IS A SCRIPT AND NOT AN MCP (27 Aug 2026)
 * ------------------------------------------------
 * Kevin's `claude-in-chrome` connector cannot serve the agents. The Chrome
 * extension talks to /Applications/Claude.app/Contents/Helpers/chrome-native-host
 * over native messaging, so it is paired to the desktop app's session. A
 * headless `claude -p` started by launchd has no route to it, and there is no
 * port to attach to. Verified by reading the native messaging host manifest and
 * by `claude mcp list` under the agents' own binary, which returns github and
 * metricool only.
 *
 * So the browser lane is Playwright (already a devDependency here, 1.60.0)
 * against a PERSISTENT profile Kevin logs into by hand, once, per site.
 *
 * THE THREE SAFETY PROPERTIES, ENFORCED IN CODE NOT IN A PROMPT
 * -------------------------------------------------------------
 * This is deliberate. On 26 Aug 2026 the "agents must write down Kevin's
 * lessons" rule lived in prose and produced zero stored lessons across 54
 * redos: nothing errored, the step was simply skippable. Anything that must
 * happen goes in the script.
 *
 * 1. NO CREDENTIALS, EVER. `fill` refuses any input of type=password, and
 *    refuses a value that looks like a secret. Kevin logs in once with
 *    `login`, which opens a headed window and hands him the keyboard; the
 *    profile keeps the session. The agent never sees or types a password,
 *    which is the "never automated" rule intact rather than reinterpreted.
 *
 * 2. PREPARE CANNOT SUBMIT. `prepare` executes every step in the plan EXCEPT
 *    the trailing submit, then screenshots. It is not that it declines to
 *    press submit; the submit step is never reachable from that code path.
 *
 * 3. COMMIT NEEDS A REAL APPROVAL. `commit` asks agent-dispatch.py for the
 *    task's live Approval Outcome and exits non-zero unless Airtable says
 *    Approved. Kevin's ruling was "no submission without screengrab approval
 *    at first" — the screenshot goes on the approval card via
 *    `agent-dispatch.py submit --attach`, and this is the half that makes the
 *    tap mean something.
 *
 * Every run appends to a JSONL ledger, so what a browser did on Kevin's behalf
 * is auditable after the fact rather than trusted at the time.
 *
 * USAGE
 *   node scripts/agent-browser.js login   --url URL [--profile NAME]
 *   node scripts/agent-browser.js read    --url URL [--shot OUT.png]
 *   node scripts/agent-browser.js prepare --plan PLAN.json --shot OUT.png
 *   node scripts/agent-browser.js commit  --plan PLAN.json --task recXXX --shot OUT.png
 *   node scripts/agent-browser.js sites
 *
 * PLAN FORMAT (the agent writes this; the script only executes it)
 *   {
 *     "site": "fylde",
 *     "steps": [
 *       {"do":"goto",   "url":"https://..."},
 *       {"do":"fill",   "selector":"#ref",  "value":"123456"},
 *       {"do":"select", "selector":"#type", "value":"arrears"},
 *       {"do":"check",  "selector":"#agree"},
 *       {"do":"upload", "selector":"#pick", "file":"~/knowledge-os/attachments/ast.pdf"},
 *       {"do":"click",  "selector":"#next"},
 *       {"do":"submit", "selector":"#submit"}      <- prepare stops before this
 *     ]
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Resolve the checkout from THIS file, never a hardcoded path. A hardcoded
// repo root made the submit gate call the MAIN checkout's agent-dispatch.py
// while the gate itself ran from a worktree, so the gate tested code that was
// not the code under test. Same shape as the preview-server trap in the
// project notes: verifying against main while believing you verified a branch.
const REPO = path.resolve(__dirname, '..');
const PROFILE_ROOT = path.join(os.homedir(), '.config', 'od', 'agent-browser');
const LEDGER = path.join(os.homedir(), 'knowledge-os', 'logs', 'agent-browser', 'runs.jsonl');
const SITES_FILE = path.join(PROFILE_ROOT, 'sites.json');

// ── The allowlist ────────────────────────────────────────────────────────────
// A browser with Kevin's live sessions is the widest capability in the estate.
// It gets an explicit list of hosts, not a deny-list: a deny-list is a promise
// you have thought of everything, and the cost of being wrong here is a logged
// -in session on a site nobody sanctioned. Add a host by editing sites.json,
// which `login` does for you when Kevin signs in.
const BUILTIN_SITES = {
  'companieshouse.gov.uk':      { label: 'Companies House',    login: false },
  'find-and-update.company-information.service.gov.uk':
                                { label: 'Companies House',    login: false },
  'gov.uk':                     { label: 'GOV.UK',             login: false },
  'tax.service.gov.uk':         { label: 'HMRC',               login: true  },
  // Adobe Acrobat Sign (28 Aug 2026). Two different jobs on two different
  // hosts, and only one of them needs Kevin's account:
  //   acrobat.adobe.com    — SENDING a document out for signature. Needs the
  //                          Agile Lets login held in the persistent profile.
  //   documents.adobe.com  — the /public/esign SIGNING pages. Needs NOTHING:
  //                          the tsid in the emailed link is the whole
  //                          credential. Proven by opening a live link in a
  //                          browser with no Adobe session and completing a
  //                          signature end to end.
  'acrobat.adobe.com':          { label: 'Adobe Acrobat Sign', login: true  },
  'documents.adobe.com':        { label: 'Adobe Sign (signing links)', login: false },
};

function loadSites() {
  let extra = {};
  try { extra = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8')); } catch { /* first run */ }
  return Object.assign({}, BUILTIN_SITES, extra);
}

function hostAllowed(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return Object.keys(loadSites()).some(d => h === d || h.endsWith('.' + d));
}

// A refusal exits the process when run as a command, and THROWS when required
// as a module, so a test can assert on the refusal instead of having the test
// runner killed by the guard it is testing. Same message either way.
function die(msg, code = 1) {
  if (require.main !== module) throw new Error('BROWSER REFUSED: ' + msg);
  console.error('BROWSER REFUSED: ' + msg);
  process.exit(code);
}

function ledger(entry) {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n');
  } catch (e) {
    // A ledger that cannot be written is a real problem, not a nicety: it is
    // the only record of what a browser did with Kevin's sessions.
    console.error('WARNING: browser ledger not written: ' + e.message);
  }
}

// ── Credential guard ─────────────────────────────────────────────────────────
// Two independent checks, because either alone has a hole: a site can render a
// password box as type=text, and a value can be a secret on a field that looks
// innocent.
const SECRET_NAME_RE = /pass(word|code)|secret|otp|2fa|mfa|cvv|card.?number|sort.?code|security.?(code|answer)|token|api.?key/i;

async function assertNotCredential(page, selector, value) {
  const kind = await page.$eval(selector, el => ({
    type: (el.getAttribute('type') || '').toLowerCase(),
    name: [el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('autocomplete'),
           el.getAttribute('aria-label')].filter(Boolean).join(' '),
  })).catch(() => null);
  if (!kind) die(`selector ${selector} matched nothing on the page`);
  if (kind.type === 'password') {
    die(`${selector} is a password field. Credentials are never automated at any trust level. ` +
        `Run: node scripts/agent-browser.js login --url <site>  and let Kevin sign in.`);
  }
  if (SECRET_NAME_RE.test(kind.name)) {
    die(`${selector} looks like a credential or payment field (${kind.name.trim()}). Refusing.`);
  }
  if (SECRET_NAME_RE.test(String(value))) {
    die(`the value for ${selector} looks like a secret. Refusing.`);
  }
}

// ── Upload guard ─────────────────────────────────────────────────────────────
// An agent that can put ANY file from this Mac onto ANY allowlisted website is
// a data-exfiltration route wearing a productivity costume. The allowlist stops
// it reaching a bad site; this stops it sending a bad file to a good one.
//
// One directory, the same one send-email.py and send-letter.py post from, so
// there is a single place where "a file an agent may send outward" is decided.
// BOTH sides of the comparison must be realpath'd. On macOS /var/folders is a
// symlink to /private/var/folders, so realpath'ing only the FILE resolves it to
// /private/... while the directory stays /var/..., the prefix check fails, and a
// perfectly legitimate upload is refused. Caught by the test on the first run;
// send-email.py already did this correctly and this file did not.
function realpathOrResolve(p) {
  const abs = path.resolve(String(p).replace(/^~(?=$|\/)/, os.homedir()));
  try { return fs.realpathSync(abs); } catch { return abs; }
}

const UPLOAD_DIR = realpathOrResolve(process.env.AGENT_UPLOAD_DIR ||
  path.join(os.homedir(), 'knowledge-os', 'attachments'));
const UPLOAD_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

function assertUploadable(files) {
  const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!list.length) die('upload step needs a `file` (or `files`) path');
  return list.map((f) => {
    const abs = path.resolve(String(f).replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(abs)) die(`upload file does not exist: ${abs}`);
    const resolved = fs.realpathSync(abs);
    if (!(resolved === UPLOAD_DIR || resolved.startsWith(UPLOAD_DIR + path.sep))) {
      die(`${resolved} is outside the attachments directory (${UPLOAD_DIR}). ` +
          'Agents upload only from there — write the file to it first.');
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!UPLOAD_EXTENSIONS.has(ext)) {
      die(`upload type ${ext || '(none)'} is not allowed. Allowed: ` +
          `${[...UPLOAD_EXTENSIONS].sort().join(', ')}`);
    }
    const size = fs.statSync(resolved).size;
    if (size > UPLOAD_MAX_BYTES) die(`${path.basename(resolved)} is ${size} bytes — over the ${UPLOAD_MAX_BYTES} cap`);
    return resolved;
  });
}

// ── Approval gate ────────────────────────────────────────────────────────────
// Asks the same script every other Airtable read goes through, so this gate and
// the approval loop can never disagree about what "Approved" means.
function assertApproved(taskId) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(taskId || '')) die(`--task must be an Airtable record id, got "${taskId}"`);
  let out;
  try {
    out = execFileSync('python3', [path.join(REPO, 'scripts', 'agent-dispatch.py'), 'outcome', taskId],
                       { encoding: 'utf8', timeout: 60000 });
  } catch (e) {
    die(`could not read the approval state for ${taskId}: ${(e.stderr || e.message || '').toString().trim()}`);
  }
  let state;
  try { state = JSON.parse(out); } catch { die(`unreadable approval state for ${taskId}: ${out.slice(0, 200)}`); }
  const outcome = String(state.outcome || '');
  if (!/^Approved/.test(outcome)) {
    die(`task ${taskId} is not approved (Approval Outcome: ${outcome || 'not set'}). ` +
        `A form is submitted only after Kevin has seen the screenshot and tapped approve.`);
  }
  return state;
}

// ── Browser ──────────────────────────────────────────────────────────────────
async function withPage(profile, headed, fn) {
  // Resolution chain rather than one hardcoded path: node walks parent
  // directories, so a worktree under .claude/worktrees/ finds the main
  // checkout's node_modules without the script having to know it is in one.
  let chromium;
  const tried = [];
  for (const mod of ['playwright-core', '@playwright/test',
                     path.join(REPO, 'node_modules', 'playwright-core')]) {
    try { ({ chromium } = require(mod)); break; } catch (e) { tried.push(mod); }
  }
  if (!chromium) die(`playwright not found (tried: ${tried.join(', ')}). Run npm install in ${REPO}.`);
  const dir = path.join(PROFILE_ROOT, profile || 'default');
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: !headed,
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    return await fn(page, ctx);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function shoot(page, out) {
  if (!out) return null;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: true });
  return out;
}

// Runs plan steps. `allowSubmit` false means the submit step is unreachable —
// the loop returns before it, it does not skip past it.
async function runSteps(page, steps, allowSubmit) {
  const done = [];
  for (const s of steps) {
    if (s.do === 'submit' && !allowSubmit) {
      done.push({ do: 'submit', executed: false, reason: 'prepare mode stops here' });
      return { done, stoppedBeforeSubmit: true };
    }
    switch (s.do) {
      case 'goto':
        if (!hostAllowed(s.url)) die(`${s.url} is not on the allowlist. Add it with \`login\` or edit ${SITES_FILE}.`);
        await page.goto(s.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        break;
      case 'fill':
        await assertNotCredential(page, s.selector, s.value);
        await page.fill(s.selector, String(s.value), { timeout: 20000 });
        break;
      case 'select':
        await page.selectOption(s.selector, String(s.value), { timeout: 20000 });
        break;
      case 'check':
        await page.check(s.selector, { timeout: 20000 });
        break;
      case 'click':
      case 'submit':
        await page.click(s.selector, { timeout: 20000 });
        break;
      case 'upload': {
        // TWO patterns exist and a site tells you which only by behaving.
        // Handling one of them is how this step failed against the real Adobe
        // on its first live run.
        //
        //  (a) NATIVE DIALOG. The page clicks a file input itself, the OS
        //      dialog opens, and nothing in the DOM can be targeted.
        //      Playwright intercepts the chooser in-process.
        //  (b) INPUT APPEARS. The click CREATES a hidden <input type=file> and
        //      leaves it alone, waiting for a real user's dialog. No chooser
        //      event ever fires. This is what Adobe Acrobat does — measured
        //      28 Aug 2026: zero file inputs before the click, exactly one
        //      after, and `filechooser` never fired in 30 seconds.
        //
        // So: arm the chooser, click, then race the chooser against an input
        // appearing. Arm BEFORE the click or pattern (a) races and the dialog
        // wins. `s.input` overrides the input selector for a page with several.
        const files = assertUploadable(s.files || s.file);
        const inputSel = s.input || 'input[type=file]';
        const before = await page.locator(inputSel).count();
        const upWait = Math.min(Number(s.timeoutMs) || 30000, 60000);
        const chooserP = page.waitForEvent('filechooser', { timeout: upWait })
          .then((c) => ({ chooser: c })).catch(() => null);
        const inputP = page.waitForFunction(
          ([sel, n]) => document.querySelectorAll(sel).length > n,
          [inputSel, before], { timeout: upWait },
        ).then(() => ({ input: true })).catch(() => null);

        await page.click(s.selector, { timeout: 20000 });

        const winner = await Promise.race([chooserP, inputP]);
        if (winner && winner.chooser) {
          await winner.chooser.setFiles(files);
        } else if (winner && winner.input) {
          // Hidden is fine: setInputFiles does not require visibility.
          await page.locator(inputSel).last().setInputFiles(files);
        } else {
          die(`upload: clicking ${s.selector} produced neither a file dialog ` +
              `nor a new ${inputSel}. The selector probably missed.`);
        }
        break;
      }
      case 'wait':
        await page.waitForTimeout(Math.min(Number(s.ms) || 1000, 15000));
        break;
      default:
        die(`unknown step "${s.do}"`);
    }
    done.push({ do: s.do, executed: true, selector: s.selector || null, url: s.url || null });
  }
  return { done, stoppedBeforeSubmit: false };
}

function readPlan(p) {
  if (!p) die('--plan is required');
  let plan;
  try { plan = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { die(`unreadable plan ${p}: ${e.message}`); }
  if (!Array.isArray(plan.steps) || !plan.steps.length) die('the plan has no steps');
  return plan;
}

function arg(argv, name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const profile = arg(rest, 'profile', 'default');

  if (cmd === 'sites') {
    console.log(JSON.stringify(loadSites(), null, 2));
    return;
  }

  if (cmd === 'login') {
    // The one-time human step. Headed on purpose: Kevin signs in himself, the
    // profile keeps the cookie, and no password ever reaches an agent.
    const url = arg(rest, 'url');
    if (!url) die('--url is required');
    const host = new URL(url).hostname.toLowerCase();
    const sites = loadSites();
    if (!hostAllowed(url)) {
      sites[host] = { label: arg(rest, 'label', host), login: true };
      fs.mkdirSync(path.dirname(SITES_FILE), { recursive: true });
      fs.writeFileSync(SITES_FILE, JSON.stringify(sites, null, 2));
      console.log(`Added ${host} to the allowlist.`);
    }
    await withPage(profile, true, async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      console.log(`Signed-in window open for ${host}. Log in, then close the window.`);
      await page.waitForEvent('close', { timeout: 15 * 60 * 1000 }).catch(() => {});
    });
    ledger({ cmd: 'login', host, profile });
    return;
  }

  if (cmd === 'read') {
    const url = arg(rest, 'url');
    if (!url) die('--url is required');
    if (!hostAllowed(url)) die(`${url} is not on the allowlist.`);
    const shot = arg(rest, 'shot');
    const res = await withPage(profile, false, async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const text = await page.evaluate(() => document.body.innerText.slice(0, 20000));
      const png = await shoot(page, shot);
      return { title: await page.title(), text, screenshot: png };
    });
    ledger({ cmd: 'read', url, profile, screenshot: res.screenshot });
    console.log(JSON.stringify(res));
    return;
  }

  if (cmd === 'prepare' || cmd === 'commit') {
    const plan = readPlan(arg(rest, 'plan'));
    const shot = arg(rest, 'shot');
    if (!shot) die('--shot is required: the screenshot IS the thing Kevin approves');
    let approval = null;
    if (cmd === 'commit') approval = assertApproved(arg(rest, 'task'));

    const res = await withPage(profile, false, async (page) => {
      const r = await runSteps(page, plan.steps, cmd === 'commit');
      const png = await shoot(page, shot);
      return Object.assign(r, { screenshot: png, url: page.url(), title: await page.title() });
    });

    ledger({
      cmd, profile, site: plan.site || null, task: arg(rest, 'task', null),
      steps: res.done, screenshot: res.screenshot, url: res.url,
      approvedOutcome: approval ? approval.outcome : null,
    });
    console.log(JSON.stringify({
      mode: cmd,
      stoppedBeforeSubmit: res.stoppedBeforeSubmit,
      screenshot: res.screenshot,
      url: res.url,
      title: res.title,
      steps: res.done,
      note: cmd === 'prepare'
        ? 'Form filled, NOT submitted. Attach the screenshot to the approval with `agent-dispatch.py submit --attach`.'
        : 'Submitted after an approved verdict.',
    }, null, 2));
    return;
  }

  console.error(fs.readFileSync(__filename, 'utf8').split('\n').slice(38, 52).join('\n'));
  process.exit(2);
}

// Run only when invoked directly. Required as a module, it exports the guards
// so tests can drive them against many field shapes rather than hoping a live
// page happens to contain one — the guard is the thing that must not regress,
// and a guard proved by a single lucky page is proved by nothing.
if (require.main === module) {
  main().catch(e => { console.error('BROWSER ERROR: ' + (e && e.stack || e)); process.exit(1); });
}

module.exports = { hostAllowed, runSteps, assertNotCredential, assertApproved, SECRET_NAME_RE, loadSites,
                   assertUploadable, UPLOAD_DIR, UPLOAD_EXTENSIONS };
