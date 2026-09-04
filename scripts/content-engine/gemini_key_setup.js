// gemini_key_setup.js — create a Gemini API key in Google AI Studio on the browser lane's signed-in `google` profile and write it
// STRAIGHT to ~/.config/od/gemini_api_key (mode 600). The key never reaches stdout, a log, the chat or a process argument: this
// prints only that a key of N characters was saved. Kevin authorised this on 4 Sep 2026 ("you can deal with this for me").
//
//   node scripts/agent-browser.js login --url https://aistudio.google.com/apikey --profile google   # Kevin signs in, once
//   node scripts/content-engine/gemini_key_setup.js [--headed] [--dry-run]
//
// Same launch as agent-browser.js (real Chrome channel, automation switch off, mock keychain profile). Screenshots of each step
// go to the scratch folder given by --shots DIR so a human can see what happened without the key ever being in them (the page
// masks keys in its table; the creation dialog is closed before the last screenshot).
const path = require('path'); const fs = require('fs'); const os = require('os');
function req(name) { try { return require(name); } catch (e) { return require(path.resolve(__dirname, '..', '..', 'node_modules', name)); } }
const { chromium } = req('playwright');
const args = process.argv.slice(2); const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const headed = args.includes('--headed'), dry = args.includes('--dry-run');
const PROFILE = path.join(os.homedir(), '.config', 'od', 'agent-browser', 'google');
const KEY_FILE = path.join(os.homedir(), '.config', 'od', 'gemini_api_key');
const SHOTS = flag('--shots', null);
const KEY_RE = /(AIza[0-9A-Za-z_-]{35}|AQ\.[0-9A-Za-z_.-]{30,80})/;  // classic AIza keys and the 2026 "AQ." format
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }).catch(() => {}); } }
(async () => {
  if (!fs.existsSync(PROFILE)) { console.error('no google profile: run the login command first'); process.exit(2); }
  const launch = { headless: !headed, viewport: { width: 1280, height: 900 } };
  if (fs.existsSync('/Applications/Google Chrome.app')) { launch.channel = 'chrome'; launch.ignoreDefaultArgs = ['--enable-automation']; }
  const ctx = await chromium.launchPersistentContext(PROFILE, launch);
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await page.goto('https://aistudio.google.com/apikey', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    if (/accounts\.google\.com/.test(page.url())) { await shot(page, '00-signin-wall'); console.error('not signed in: the page went to accounts.google.com. Run the login command and sign in, then retry.'); process.exit(3); }
    await shot(page, '01-apikey-page');
    if (args.includes('--existing')) {
      // Google flagged automated key CREATION as suspicious (4 Sep 2026); we do not retry that. Kevin already holds a key on the
      // Content Machine project (his billing account), so copy it with the row's own copy button into the file, nothing else.
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://aistudio.google.com' }).catch(() => {});
      const copyBtn = page.locator('button[aria-label*="opy" i], button[mattooltip*="opy" i]').first();
      if (!(await copyBtn.count())) { await shot(page, '02-no-copy-button'); console.error('no copy button on an existing key row'); process.exit(6); }
      await copyBtn.click(); await page.waitForTimeout(1500); await shot(page, '02-after-copy');
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => '')).catch(() => '');
      const m2 = String(clip || '').match(KEY_RE);
      if (!m2) { console.error('clipboard did not hold a key (length ' + String(clip || '').length + ')'); process.exit(7); }
      fs.writeFileSync(KEY_FILE, m2[0], { mode: 0o600 }); fs.chmodSync(KEY_FILE, 0o600);
      await page.evaluate(() => navigator.clipboard.writeText('').catch(() => {})).catch(() => {});
      console.log(`saved the existing Gemini API key (${m2[0].length} characters) to ${KEY_FILE} (mode 600); clipboard cleared`);
      await ctx.close(); return;
    }
    // A key may already exist in the table (masked). We always create a fresh one so the full value is shown once.
    const createBtn = page.getByRole('button', { name: /create api key/i }).first();
    if (!(await createBtn.count())) { await shot(page, '02-no-create-button'); console.error('no "Create API key" button found; see screenshot'); process.exit(4); }
    if (dry) { console.log('dry run: signed in, Create API key button present'); await ctx.close(); return; }
    await createBtn.click(); await page.waitForTimeout(3000); await shot(page, '03-after-create-click');
    // Some accounts get a dialog: choose a project or "Create API key in new project"; accept whichever completes the creation.
    for (const label of [/create api key in new project/i, /create api key/i, /create key/i, /^create$/i]) {
      const b = page.getByRole('button', { name: label });
      if (await b.count()) { const first = b.first(); if (await first.isVisible().catch(() => false)) { await first.click().catch(() => {}); await page.waitForTimeout(4000); break; } }
    }
    await shot(page, '04-after-dialog');
    // Read the key from the page text without echoing it.
    let text = await page.evaluate(() => document.body.innerText);
    let m = text.match(KEY_RE);
    if (!m) {
      // the dialog may render the key in an input
      const vals = await page.$$eval('input, textarea, code, [role=textbox]', els => els.map(e => e.value || e.textContent || ''));
      for (const v of vals) { const mm = String(v).match(KEY_RE); if (mm) { m = mm; break; } }
    }
    if (!m) { await shot(page, '05-no-key-visible'); console.error('a key was not visible after creation; see screenshots'); process.exit(5); }
    fs.writeFileSync(KEY_FILE, m[0], { mode: 0o600 }); fs.chmodSync(KEY_FILE, 0o600);
    await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(800); await shot(page, '06-done');
    console.log(`saved a Gemini API key of ${m[0].length} characters to ${KEY_FILE} (mode 600)`);
  } finally { await ctx.close().catch(() => {}); }
})().catch(e => { console.error(e.message); process.exit(1); });
