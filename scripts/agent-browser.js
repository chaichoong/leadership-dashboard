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
 *   node scripts/agent-browser.js read    --url URL [--shot OUT.png] [--wait MS] [--wait-for SELECTOR]
 *   node scripts/agent-browser.js loom-search --query "..." [--limit 20]
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
 *       {"do":"press",  "selector":"#email", "key":"Enter"},
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
  // Loom (29 Aug 2026). Kevin's video archive, so an agent can search what he
  // has already recorded instead of asking him to re-explain something.
  //
  // A SINGLE video needs nothing: its transcript comes from a public GraphQL
  // endpoint, which is what scripts/agent-dispatch.py `expand_looms` uses for
  // approval feedback and what the transcript-to-brain skill uses. That path
  // is unchanged and needs no login and no allowlist entry.
  //
  // THE LIBRARY is different — it is his account. Hence login: true and the
  // one-time `login` step. Nothing here can post, share or delete: `read` and
  // `loom-search` only navigate and read text, and any form submit still goes
  // through `commit`, which refuses without an approved task.
  'loom.com':                   { label: 'Loom (video archive)', login: true  },
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
  // Prefer Kevin's installed Google Chrome over Playwright's bundled test build
  // (2 Sep 2026). The bundled Chromium announces itself as automated
  // (navigator.webdriver = true, "controlled by automated test software"),
  // and Evernote's login refused Kevin's own valid credentials in it while the
  // same credentials worked in his real Chrome. Real Chrome with the
  // automation switch off is what a person's browser looks like, and the
  // existing sessions (Loom, TopCashback) survived the switch on a copied
  // profile before this landed. Falls back to the bundled build when Chrome is
  // absent, so an unattended run never dies on a missing app.
  const launch = {
    headless: !headed,
    viewport: { width: 1280, height: 900 },
  };
  if (fs.existsSync('/Applications/Google Chrome.app')) {
    launch.channel = 'chrome';
    launch.ignoreDefaultArgs = ['--enable-automation'];
  }
  const ctx = await chromium.launchPersistentContext(dir, launch);
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
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

// A submit is only DONE when the page proves it. On 28 Aug 2026 four Adobe
// e-sign sends logged every step executed:true, ending with a click on "Send" —
// and all four agreements sat in Adobe as DRAFTS for four days. Nobody was
// emailed, nothing errored, and the tasks were completed. `executed: true`
// records that Playwright clicked an element, never that the site accepted the
// action. So a commit plan that submits must DECLARE its proof: something the
// page shows only after a successful submit. No declared proof, no run.
function assertConfirmable(plan) {
  const submits = (plan.steps || []).some((s) => s && s.do === 'submit');
  if (!submits) return;
  const c = plan.confirm;
  if (!c || typeof c.selector !== 'string' || !c.selector.trim()) {
    die('this plan submits but declares no proof of landing. Add\n' +
        '  "confirm": { "selector": "<what the page shows ONLY after a successful submit>" }\n' +
        'e.g. Adobe e-sign: "text=/[Ss]uccessfully sent/". A submit whose success cannot be\n' +
        'seen is the four-drafts failure of 28 Aug 2026 waiting to repeat.');
  }
}

// Runs plan steps. `allowSubmit` false means the submit step is unreachable —
// the loop returns before it, it does not skip past it. `confirm` is the
// declared proof of landing; checked after the final step whenever a submit
// actually executed.
async function runSteps(page, steps, allowSubmit, confirm) {
  const done = [];
  let submitted = false;
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
        if (s.do === 'submit') submitted = true;
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
      case 'press':
        // Some fields only COMMIT on Enter — Adobe's recipient box turns typed
        // text into a recipient chip that way, and without it the email is
        // still just text in a box when Send is pressed. Same credential guard
        // as fill: a key sequence into a password box is still typing into a
        // password box.
        await assertNotCredential(page, s.selector, '');
        await page.press(s.selector, String(s.key || 'Enter'), { timeout: 20000 });
        break;
      case 'wait':
        await page.waitForTimeout(Math.min(Number(s.ms) || 1000, 15000));
        break;
      default:
        die(`unknown step "${s.do}"`);
    }
    done.push({ do: s.do, executed: true, selector: s.selector || null, url: s.url || null });
  }
  if (submitted && confirm && confirm.selector) {
    const timeout = Math.min(Number(confirm.timeoutMs) || 30000, 120000);
    try {
      await page.waitForSelector(confirm.selector, { timeout });
    } catch {
      throw new Error(
        `SUBMIT NOT CONFIRMED: pressed submit but the page never showed the declared proof ` +
        `(${confirm.selector}) within ${timeout}ms. Treat this action as NOT DONE — do not ` +
        `complete the task. On Adobe, check the Drafts list for a stranded copy before retrying.`);
    }
    done.push({ do: 'confirm', executed: true, selector: confirm.selector });
  }
  return { done, stoppedBeforeSubmit: false };
}

function readPlan(p) {
  // `--plan -` reads STDIN. On 28 Aug 2026 an agent could not write to its own
  // scratch dir and fell back to /tmp world-readable; a plan names the document
  // and the signer, so it gets the same treatment as the letter spec. Piping
  // adobe-plan.js straight in means the whole signing path writes no temp file.
  if (!p) die('--plan FILE.json or --plan - (stdin) is required');
  let raw;
  try {
    raw = p === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(p, 'utf8');
  } catch (e) { die(`could not read ${p === '-' ? 'stdin' : p}: ${e.message}`); }
  let plan;
  try { plan = JSON.parse(raw); } catch (e) { die(`plan is not valid JSON: ${e.message}`); }
  if (!plan || !Array.isArray(plan.steps)) die('plan has no steps array');
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
    // TWO TRAPS, both paid for on 2 Sep 2026 (Evernote):
    //
    // 1. A login window driven by Playwright is still an automated browser,
    //    whatever flags are hidden, and Evernote answered a CORRECT password
    //    with "the password entered is incorrect" three times in a row. So
    //    the sign-in window is a PLAIN Chrome process on the profile, with
    //    nothing attached to it, which Evernote accepted first time.
    //
    // 2. Plain Chrome encrypts cookies with the Mac keychain; Playwright
    //    launches Chrome with --use-mock-keychain. Opening the profile in
    //    bare Chrome wiped the TopCashback and Loom sessions (undecryptable
    //    cookies are dropped) and saved Evernote's in a form the agent could
    //    not read. The plain window MUST carry --use-mock-keychain so every
    //    cookie Kevin creates is readable by the agent's launch.
    //
    // Falls back to the Playwright-driven window only when Chrome is absent.
    const dir = path.join(PROFILE_ROOT, profile || 'default');
    if (fs.existsSync('/Applications/Google Chrome.app')) {
      fs.mkdirSync(dir, { recursive: true });
      const { spawnSync, spawn } = require('child_process');
      const busy = spawnSync('pgrep', ['-f', `user-data-dir=${dir}`]).status === 0;
      if (busy) die(`the profile at ${dir} is already open in another Chrome. Quit it (Cmd+Q) first.`);
      spawn('open', ['-na', 'Google Chrome', '--args', `--user-data-dir=${dir}`,
        '--use-mock-keychain', '--no-first-run', url], { stdio: 'ignore' }).unref();
      console.log(`Plain Chrome window open for ${host} (no automation attached). Log in, then Cmd+Q that window.`);
      const deadline = Date.now() + 15 * 60 * 1000;
      let seen = false;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        const running = spawnSync('pgrep', ['-f', `user-data-dir=${dir}`]).status === 0;
        if (running) seen = true;
        else if (seen) break;
      }
      ledger({ cmd: 'login', host, profile, mode: 'plain-chrome-mock-keychain' });
      return;
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
      // Single-page apps (Spotify for Creators, Strava's dashboard) paint nothing at
      // domcontentloaded; --wait gives them time and --wait-for waits for a selector.
      const waitMs = Number(arg(rest, 'wait', '0')) || 0;
      if (waitMs) await page.waitForTimeout(Math.min(waitMs, 60000));
      const waitFor = arg(rest, 'wait-for');
      if (waitFor) await page.waitForSelector(waitFor, { timeout: 60000 }).catch(() => {});
      const text = await page.evaluate(() => document.body.innerText.slice(0, 20000));
      const png = await shoot(page, shot);
      return { title: await page.title(), text, screenshot: png };
    });
    ledger({ cmd: 'read', url, profile, screenshot: res.screenshot });
    console.log(JSON.stringify(res));
    return;
  }

  // ── loom-search ────────────────────────────────────────────────────────────
  // "Search my Loom library" — Kevin's ask, 29 Aug 2026. Returns the videos
  // matching a phrase, each with the share URL, so the caller can then pull a
  // transcript with the existing public-endpoint fetcher and read what he
  // actually said. Two steps on purpose: the library needs his session, the
  // transcript does not.
  // ── loom-search ────────────────────────────────────────────────────────────
  // "Search my Loom library" — Kevin's ask, 29 Aug 2026, against 2,255 videos.
  //
  // IT READS THE SEARCH RESPONSE, NOT THE PAGE. Two earlier attempts failed in
  // ways worth recording, because both LOOKED like they worked:
  //
  //   1. `?search=` in the URL is IGNORED by Loom. It returned the same library
  //      for every query — proven by running two unrelated queries and getting
  //      byte-identical ids back. "Here are your matches" that is really "here
  //      are your newest videos" is worse than an error.
  //   2. Typing into the box DOES search, but the results render in a typeahead
  //      listbox that contains NO links and no video id anywhere in the DOM,
  //      while the library grid behind it never changes. Scraping the page
  //      therefore returns the grid, i.e. the same bug as (1).
  //
  // The typeahead calls loom.com/graphql, and that response carries exactly
  // what is needed: id, name, share URI, duration, date, and `matchedFields`
  // saying whether the hit was in the TITLE or the TRANSCRIPT. Loom indexes
  // transcripts, which is the thing that makes this worth having at all.
  if (cmd === 'loom-search') {
    const query = arg(rest, 'query');
    if (!query) die('--query is required');
    const limit = Number(arg(rest, 'limit', '20')) || 20;
    const shot = arg(rest, 'shot');
    const LIB = 'https://www.loom.com/looms/videos';
    if (!hostAllowed(LIB)) die('loom.com is not on the allowlist.');

    const res = await withPage(profile, false, async (page) => {
      const hits = [];
      page.on('response', async (r) => {
        if (!/\/graphql/.test(r.url()) || r.request().method() !== 'POST') return;
        try {
          const j = await r.json();
          const nodes = j?.data?.videos?.videoResults?.nodes;
          if (Array.isArray(nodes) && nodes.length) hits.push(nodes);
        } catch { /* not JSON, or a response we do not care about */ }
      });

      await page.goto(LIB, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('a[href*="/share/"]', { timeout: 20000 })
        .catch(() => {});

      // Signed out is decided by whether the LIBRARY rendered, not by hunting
      // for the words "log in": Loom's marketing pages carry /share/ links, so
      // a text test alone reads the login page as a full library.
      const signedOut = await page.evaluate(() =>
        /\/login/.test(location.pathname) ||
        !document.querySelector('a[href*="/share/"]'));
      if (signedOut) return { signedOut: true, videos: [], count: 0 };

      const box = page.locator('input[aria-label*="Search for people"]').first();
      await box.waitFor({ timeout: 15000 });
      await box.click();
      await box.fill(query);

      // Wait for the SEARCH RESPONSE, not for a length of time. A sleep a shade
      // too short falls back to whatever was on screen, which is the unfiltered
      // library — the exact failure this command already had twice.
      await page.waitForFunction(() => true, null, { timeout: 1 }).catch(() => {});
      const deadline = Date.now() + 20000;
      while (!hits.length && Date.now() < deadline) await page.waitForTimeout(250);

      const png = await shoot(page, shot);
      if (!hits.length) return { signedOut: false, noResponse: true, videos: [], count: 0, screenshot: png };

      const nodes = hits[hits.length - 1].slice(0, limit);
      const videos = nodes.map((n) => {
        const v = n.video || {};
        const matched = (n.matchedFields || []).map((f) => f.fieldName);
        const secs = Number(v.playable_duration) || 0;
        return {
          id: v.id,
          title: v.name || '',
          url: (v.sharePageUri || ('https://loom.com/share/' + v.id))
                 .replace('https://loom.com', 'https://www.loom.com'),
          recorded: (v.createdAt || '').slice(0, 10),
          duration: secs >= 60 ? `${Math.round(secs / 60)} min` : `${Math.round(secs)} sec`,
          // The useful part: a transcript hit means he SAID it, even though the
          // title never mentions it.
          matchedTranscript: matched.includes('transcriptText'),
          matchedTitle: matched.includes('name'),
        };
      }).filter((v) => v.id);
      return { signedOut: false, count: videos.length, videos, screenshot: png };
    });

    if (res.signedOut) {
      console.log(JSON.stringify({
        query, error: 'NOT SIGNED IN to Loom in the agent profile. '
          + 'This is a one-time human step, and no password ever reaches an agent:'
          + '\n  node scripts/agent-browser.js login --url https://www.loom.com/looms/videos'
          + '\nA browser opens, Kevin signs in, the profile keeps the session.',
        videos: [] }, null, 2));
      ledger({ cmd: 'loom-search', query, profile, error: 'not signed in' });
      return;
    }
    if (res.noResponse) {
      // NEVER report this as "no matches". An empty answer and a search that
      // never ran look identical to a caller and mean opposite things.
      console.log(JSON.stringify({
        query, error: 'Loom returned no search response within 20s. This is NOT '
          + '"no matches" — the search did not run. Retry; if it persists the '
          + 'typeahead has changed and loom-search needs re-pointing.',
        videos: [] }, null, 2));
      ledger({ cmd: 'loom-search', query, profile, error: 'no search response' });
      return;
    }
    ledger({ cmd: 'loom-search', query, profile, count: res.count,
             screenshot: res.screenshot });
    console.log(JSON.stringify(Object.assign({ query }, res), null, 2));
    return;
  }

  if (cmd === 'prepare' || cmd === 'commit') {
    const plan = readPlan(arg(rest, 'plan'));
    const shot = arg(rest, 'shot');
    if (!shot) die('--shot is required: the screenshot IS the thing Kevin approves');
    // Checked BEFORE the approval read and the browser launch: a plan that
    // cannot prove its submit landed is refused while it is still cheap.
    if (cmd === 'commit') assertConfirmable(plan);
    let approval = null;
    if (cmd === 'commit') approval = assertApproved(arg(rest, 'task'));

    const res = await withPage(profile, false, async (page) => {
      let r;
      try {
        r = await runSteps(page, plan.steps, cmd === 'commit', plan.confirm);
      } catch (e) {
        // The failure screenshot IS the diagnosis: without it, an unconfirmed
        // submit says only "the proof never appeared" and nobody can see the
        // modal or error the page actually showed.
        const failShot = await shoot(page, shot).catch(() => null);
        if (failShot) e.message += ` Failure screenshot: ${failShot}`;
        throw e;
      }
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
                   assertUploadable, assertConfirmable, UPLOAD_DIR, UPLOAD_EXTENSIONS };
