#!/usr/bin/env node
/**
 * adobe-assign.js — put a MULTI-SIGNER agreement into Adobe with every
 * signature box on the right person, and stop before Send.
 *
 * WHY THIS EXISTS (Kevin, 10 Sep 2026)
 * ------------------------------------
 * adobe-plan.js refuses more than one signer, and the refusal is correct:
 * Adobe's Auto-place gives EVERY field to the last recipient. Measured again
 * on 10 Sep 2026 with a real tenancy agreement, Adobe said so itself, and the
 * tenant was left with nothing to sign. 27 of the 39 tenancy documents need
 * two or three signatures, so that refusal blocked the whole job.
 *
 * A plan is a list of selectors and cannot express "read the fields, work out
 * which belongs to whom, then click each one", so this is a script rather than
 * a plan. It is the automation of a process Kevin already ran by hand: the
 * adobe-sign-field-setup skill describes the same clicks, and his account has
 * sent multi-signer tenancy agreements this way before (AST_Daniel_Gathercole,
 * AST_Nathan_Ingerson and others).
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It never presses Send. It stops with the agreement built and screenshotted,
 * exactly like `agent-browser.js prepare`, so a person decides.
 *
 * It also refuses to finish if any signer ends up with no field. That is the
 * failure Adobe itself only catches at Send time with a "Signature field
 * missing" dialog, and the whole point of this script is that nobody should
 * find out that late.
 *
 * THE THREE THINGS THAT LOOK OPTIONAL AND ARE NOT
 * -----------------------------------------------
 * 1. THE RECIPIENT BOX IS MATCHED ON THE ATTRIBUTE, NOT THE TEXT. Adobe's
 *    placeholder renders as "Enter email…" with a Unicode ellipsis, and the
 *    visible string is not the attribute value, so any selector quoting it
 *    matches nothing. See adobe-plan.js, same bug, fixed the same day.
 * 2. FIELDS ARE ORDERED BY POSITION, NEVER BY ADOBE'S LABEL. On a two-party
 *    agreement Adobe numbered the date fields against their visual order:
 *    "Date of Signing 1" sat BELOW "Date of Signing 2". Trusting the number
 *    would have handed the landlord's date to the tenant.
 * 3. ESCAPE, NOT A CLICK ON BLANK PAPER. Auto-place leaves every field
 *    selected as one group, so reassigning without clearing it moves them all
 *    together. Clicking blank paper clears it but also removes the highlight
 *    wrapper from the DOM, so the fields become unfindable. Escape does not.
 *
 * USAGE
 *   node scripts/adobe-assign.js --document ~/knowledge-os/attachments/AST.pdf \
 *        --signers tenant@x.com,kevin@runpreneur.org.uk \
 *        --fields 1,1,2,2 [--page 6] [--shot out.png] [--dry]
 *
 *   --fields is the signer number for each field READ DOWN THE PAGE, so
 *   "1,1,2,2" means the top two boxes belong to signer 1 and the next two to
 *   signer 2. Pass --fields auto to let it pair each signature with the date
 *   below it and split the pairs evenly between the signers in order.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROFILE = path.join(os.homedir(), '.config', 'od', 'agent-browser', 'default');
const ATTACH_DIR = (() => {
  const p = path.resolve(process.env.AGENT_UPLOAD_DIR ||
    path.join(os.homedir(), 'knowledge-os', 'attachments'));
  try { return fs.realpathSync(p); } catch { return p; }
})();
const ESIGN_URL = 'https://acrobat.adobe.com/link/tools/?group=group-sign';
const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;

// Adobe's screens, measured. These look generous and are not: the app is a
// heavy SPA and the recipients panel took 25 seconds to paint on a cold run.
const WAIT = { load: 20000, upload: 14000, panel: 25000, chip: 4500, menu: 2500,
               fields: 20000, page: 9000, settle: 3000 };

const SEL = {
  filePick: 'article:has-text("Request e-signatures") >> text=select a file',
  fileInput: 'input[type=file]',
  continue: 'button:has-text("Continue")',
  // Attribute presence only — never the visible placeholder text.
  recipientBox: 'input[placeholder]',
  recipientMenu: '[data-testid="recipient-action-menu-button"]',
  addRecipient: '[data-testid="recipient-action-menu-addRecipient"]',
  recipientRow: '[data-testid^="recipient-list-item-"]',
  autoPlace: '[data-testid="auto-place-ffd-button"]',
  pageBox: '#PageNumberUIModern',
  pageTotal: '[data-testid="Total number of pages in this PDF."]',
  field: '[data-testid="highlighted-authoring-field"]',
  changeRecipients: '[data-testid="change-recipients-label"]',
  recipientOption: '[data-testid="ctx-recipient-option"]',
  send: '[data-testid="review-send-button"]',
  selectionCount: '[data-testid="num-fields-selected"]',
  toastClose: '[data-testid="rsp-Toast-closeButton"]',
  // The highlight wrapper exists ONLY while its field is selected. These inner
  // elements are in the page the whole time, so they are what a click aims at.
  fieldBody: '[data-testid$="-form-field"], [data-testid$="-field"]',
  addSignature: '[data-testid="menu-item-signature-form-field"]',
};

let THROW_ON_REFUSE = require.main !== module;
function die(msg) {
  if (THROW_ON_REFUSE) throw new Error('ASSIGN REFUSED: ' + msg);
  console.error('ASSIGN REFUSED: ' + msg);
  process.exit(1);
}

function resolveDocument(p) {
  const abs = path.resolve(String(p || '').replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(abs)) die(`document does not exist: ${abs}`);
  const real = fs.realpathSync(abs);
  // Same fence as every other outward-facing script: one directory decides
  // what an agent may put in front of someone else.
  if (!(real === ATTACH_DIR || real.startsWith(ATTACH_DIR + path.sep))) {
    die(`${real} is outside the attachments directory (${ATTACH_DIR}).`);
  }
  if (path.extname(real).toLowerCase() !== '.pdf') die('the document must be a PDF');
  return real;
}

function parseSigners(raw) {
  const list = String(raw || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!list.length) die('--signers is required — who has to sign it, in signing order?');
  for (const s of list) if (!EMAIL_RE.test(s)) die(`not an email address: ${s}`);
  if (new Set(list).size !== list.length) die('the same address appears twice in --signers');
  return list;
}

/**
 * Which signer each field belongs to, reading DOWN THE PAGE.
 *
 * "blocks" (the default) reads the shape of a signature block rather than
 * counting. Each SIGNATURE goes to the next signer in order, each DATE belongs
 * to the signature above it, and any other detected box is a data blank that
 * belongs to the first signer, who is the tenant and the person who fills it.
 *
 * Counting was the obvious rule and it is wrong. The authority to act carries
 * blanks for date of birth, National Insurance number and council tax account,
 * and Adobe detects an empty line as a field exactly like a signature line. We
 * hold those details for some tenants and not others, so the SAME template
 * produces a different number of fields per tenant, and an even split would
 * quietly hand one person's signature box to another.
 *
 * "auto" keeps the old even split for a document known to have nothing but
 * signature lines. An explicit list always wins.
 */
function parseFieldMap(raw, fields, signerCount) {
  const fieldCount = Array.isArray(fields) ? fields.length : fields;
  const kinds = Array.isArray(fields) ? fields.map((f) => String(f.label || '')) : null;
  const mode = String(raw || 'blocks');

  if (mode === 'blocks') {
    if (!kinds) die('the blocks rule needs the field labels, not just a count');
    const map = [];
    let signer = 0;
    for (const k of kinds) {
      if (/signature/i.test(k)) { signer += 1; map.push(Math.min(signer, signerCount)); }
      else if (/date-of-signing/i.test(k)) { map.push(Math.min(Math.max(signer, 1), signerCount)); }
      else map.push(1);
    }
    if (signer > signerCount) {
      die(`the document has ${signer} signature lines but only ${signerCount} signers ` +
          'were given. Nothing has been sent.');
    }
    if (signer < signerCount) {
      die(`${signerCount} signers were given but the document has only ${signer} ` +
          'signature lines, so somebody would have nothing to sign. Nothing has been sent.');
    }
    return map;
  }

  if (mode === 'auto') {
    if (fieldCount % signerCount !== 0) {
      die(`${fieldCount} fields do not divide evenly between ${signerCount} signers, ` +
          'so --fields auto cannot tell which belongs to whom. Pass the map ' +
          'explicitly, e.g. --fields 1,1,2,2');
    }
    const per = fieldCount / signerCount;
    return Array.from({ length: fieldCount }, (_, i) => Math.floor(i / per) + 1);
  }

  const map = String(raw).split(/[,\s]+/).filter(Boolean).map(Number);
  if (map.length !== fieldCount) {
    die(`--fields lists ${map.length} entries but the document has ${fieldCount} fields`);
  }
  for (const n of map) {
    if (!Number.isInteger(n) || n < 1 || n > signerCount) {
      die(`--fields entry ${n} is not a signer number between 1 and ${signerCount}`);
    }
  }
  return map;
}

/** Every signer must end up with something to sign. */
function checkEverySignerHasAField(map, signerCount, signers) {
  const missing = [];
  for (let i = 1; i <= signerCount; i++) if (!map.includes(i)) missing.push(signers[i - 1]);
  if (missing.length) {
    die(`${missing.join(' and ')} would receive an agreement with nothing to sign. ` +
        'Adobe only reports this at Send time; the map is wrong.');
  }
}

/**
 * The clickable field bodies, ordered DOWN THE PAGE. Adobe's DOM order does not
 * follow the visual order, so position decides, the same rule the map uses.
 */
async function orderedFieldHandles(page) {
  const all = await page.locator(SEL.fieldBody).elementHandles();
  const withBoxes = [];
  for (const h of all) {
    const b = await h.boundingBox();
    // Skip the panel's own buttons on the left and anything with no size.
    if (!b || b.width < 20 || b.height < 8 || b.x < 300) continue;
    withBoxes.push({ h, y: b.y, x: b.x, w: b.width, h2: b.height });
  }
  // A field paints several nested elements at the same spot; keep the outermost
  // one per position so a click is not aimed at a label inside a field.
  const seen = [];
  const kept = [];
  for (const f of withBoxes.sort((a, b) => a.y - b.y || b.w - a.w)) {
    if (seen.some((s) => Math.abs(s.y - f.y) < 6 && Math.abs(s.x - f.x) < 40)) continue;
    seen.push(f);
    kept.push(f.h);
  }
  return kept;
}

async function run({ document: doc, signers, fields, page: pageNo, shot }) {
  const { chromium } = require('playwright');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, viewport: { width: 1280, height: 900 },
    channel: fs.existsSync('/Applications/Google Chrome.app') ? 'chrome' : undefined,
    ignoreDefaultArgs: fs.existsSync('/Applications/Google Chrome.app') ? ['--enable-automation'] : undefined,
  });
  const log = (m) => console.error(new Date().toISOString().slice(11, 19) + ' ' + m);
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(ESIGN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(WAIT.load);

    // Adobe CREATES a hidden file input on click and never fires a chooser.
    const before = await page.locator(SEL.fileInput).count();
    const appears = page.waitForFunction(
      ([sel, n]) => document.querySelectorAll(sel).length > n,
      [SEL.fileInput, before], { timeout: 30000 });
    await page.locator(SEL.filePick).click();
    await appears;
    await page.locator(SEL.fileInput).last().setInputFiles(doc);
    await page.waitForTimeout(WAIT.upload);
    await page.locator(SEL.continue).click();
    await page.waitForTimeout(WAIT.panel);
    log('uploaded ' + path.basename(doc));

    for (let i = 0; i < signers.length; i++) {
      if (i > 0) {
        await page.locator(SEL.recipientMenu).click();
        await page.waitForTimeout(WAIT.menu);
        await page.locator(SEL.addRecipient).click();
        await page.waitForTimeout(WAIT.menu);
      }
      await page.locator(SEL.recipientBox).fill(signers[i]);
      // Without this the address stays loose text and Send goes nowhere, silently.
      await page.locator(SEL.recipientBox).press('Enter');
      await page.waitForTimeout(WAIT.chip);
    }
    const rows = await page.locator(SEL.recipientRow).count();
    if (rows !== signers.length) {
      die(`${signers.length} signers were given but Adobe shows ${rows} on the agreement`);
    }
    log(`${rows} recipients on the agreement`);

    // Auto-place only appears when Adobe detected something to place. A
    // document whose signature line it does not recognise offers no button at
    // all, and the run should say that plainly rather than time out.
    if (await page.locator(SEL.autoPlace).count()) {
      await page.locator(SEL.autoPlace).click();
      await page.waitForTimeout(WAIT.fields);
    } else if (signers.length === 1) {
      // Auto-place only appears when Adobe recognised something to place. The
      // proof of residency draws its signature line as a rule rather than a
      // run of underscores, so Adobe sees nothing and offers no button. With a
      // single signer there is nothing to assign anyway: place one signature
      // field and it belongs to the only recipient.
      log('no Auto-place offered; placing one signature field for the sole signer');
      await page.locator(SEL.addSignature).click();
      await page.waitForTimeout(WAIT.fields);
    } else {
      die('Adobe offered no Auto-place on this document, so it detected no ' +
          'fields to assign, and there is more than one signer to assign them ' +
          'to. Nothing has been sent. The signature line needs to be one Adobe ' +
          'recognises; that is a fix in how the PDF is generated.');
    }

    // CLOSE THE NOTIFICATION BANNERS FIRST. Adobe stacks two toasts across the
    // bottom of the viewer after Auto-place ("Form fields are detected" and
    // "Fields automatically added and assigned to ..."). On a one-page document
    // the signature block sits exactly there, so a click aimed at a field lands
    // on the banner instead and no menu opens. Measured on a real authority to
    // act: field 5 of 7 failed three times running, and the retry could not
    // help because nothing about waiting moves a banner.
    const toasts = await page.locator(SEL.toastClose).count();
    for (let i = 0; i < toasts; i++) {
      await page.locator(SEL.toastClose).first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
    if (toasts) log(`closed ${toasts} notification banner(s) covering the page`);

    // The signature block lives on the last page of these documents.
    const total = Number(await page.locator(SEL.pageTotal).innerText().catch(() => '0')) || 0;
    const target = pageNo || total;
    if (!target) die('could not read how many pages the document has');
    await page.locator(SEL.pageBox).click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.type(String(target));
    await page.keyboard.press('Enter');
    await page.waitForTimeout(WAIT.page);
    log('on page ' + target + ' of ' + total);

    const read = () => page.evaluate((sel) => {
      const out = [];
      // THE SIGNER COLOUR IS NOT ON THE WRAPPER. Reading the wrapper's own
      // background returns transparent once the field is deselected, so all
      // four fields look identical and a correct assignment reads as a failed
      // one. That false refusal cost a live run on 10 Sep 2026: the screenshot
      // showed two purple fields and two green ones while the check said one
      // colour. Walk into the field and take the first painted background.
      const painted = (el) => {
        const seen = [el, ...el.querySelectorAll('*')];
        for (const n of seen) {
          const c = getComputedStyle(n).backgroundColor;
          if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
        }
        return 'none';
      };
      document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0) return;
        out.push({ label: el.getAttribute('aria-label') || '',
                   bg: painted(el),
                   x: Math.round(r.x), y: Math.round(r.y),
                   w: Math.round(r.width), h: Math.round(r.height) });
      });
      // DOWN THE PAGE. Adobe's own numbering does not follow the visual order.
      return out.sort((a, b) => a.y - b.y || a.x - b.x);
    }, SEL.field);

    let found = await read();
    if (!found.length) die('Auto-place placed no fields on page ' + target);
    const map = parseFieldMap(fields, found, signers.length);
    checkEverySignerHasAField(map, signers.length, signers);
    log(`${found.length} fields, map ${map.join(',')}`);

    // Auto-place leaves them selected as one group; Escape drops that without
    // removing the highlight wrapper the fields are addressed by.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(WAIT.settle);

    const before2 = found.map((f) => f.bg);
    for (let i = 0; i < found.length; i++) {
      const want = signers[map[i] - 1];
      const f = found[i];
      // AIM AT THE FIELD, NOT AT A REMEMBERED POINT ON THE SCREEN. Coordinates
      // are read once, before anything moves; reassigning a field can resize it
      // and shift the ones below, so a later click lands on the wrong thing or
      // on nothing. On a real authority to act, field 5 of 7 failed three times
      // running that way while fields 1 to 4 had gone through cleanly. Handles
      // are resolved fresh each time and Playwright scrolls them into view.
      let opened = false;
      for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
        const handles = await orderedFieldHandles(page);
        const h = handles[i];
        if (h) {
          await h.click({ timeout: 10000 }).catch(async () => {
            await page.mouse.click(f.x + f.w / 2, f.y + f.h / 2);
          });
        } else {
          await page.mouse.click(f.x + f.w / 2, f.y + f.h / 2);
        }
        await page.waitForTimeout(WAIT.settle);
        opened = await page.locator(SEL.changeRecipients)
          .waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false);
        if (!opened) {
          log(`field ${i + 1}: no menu on attempt ${attempt}, retrying`);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(2000);
        }
      }
      if (!opened) {
        const png = shot || path.join(os.tmpdir(), path.basename(doc, '.pdf') + '-stuck.png');
        await page.screenshot({ path: png });
        die(`field ${i + 1} would not open its menu after three tries. ` +
            `Nothing has been sent. See ${png}.`);
      }
      // Adobe can re-select the whole auto-placed group on a click. Reassigning
      // then moves EVERY field, and the last write wins, which looks exactly
      // like nothing having happened. Insist on one field before touching the
      // menu; the counter only renders when more than one is selected.
      const selText = await page.locator(SEL.selectionCount).innerText().catch(() => '');
      if (/\d+\s+fields selected/i.test(selText)) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(1500);
        await page.mouse.click(f.x + f.w / 2, f.y + f.h / 2);
        await page.waitForTimeout(WAIT.settle);
        const again = await page.locator(SEL.selectionCount).innerText().catch(() => '');
        if (/\d+\s+fields selected/i.test(again)) {
          die(`field ${i + 1} will not select on its own (${again.trim()}), so a ` +
              'reassignment would move every field at once. Nothing has been sent.');
        }
      }
      await page.locator(SEL.changeRecipients).click();
      await page.waitForTimeout(WAIT.menu);
      const option = page.locator(SEL.recipientOption).filter({ hasText: want }).first();
      if (!(await option.count())) die(`no recipient option for ${want} on field ${i + 1}`);
      await option.click();
      await page.waitForTimeout(WAIT.settle);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      log(`field ${i + 1} (${f.label.split(',')[0]}) -> signer ${map[i]} ${want}`);
    }

    // VERIFY BY SELECTING EACH FIELD IN TURN, NOT BY READING THE PAGE ONCE.
    // The highlight wrapper these fields are addressed by exists ONLY while
    // that field is selected. Reading the page after the loop therefore
    // returns the single field left selected, whose colour is whatever it was
    // assigned, and one colour reads as "nothing moved". Two live runs on
    // 10 Sep 2026 were refused that way while the screenshot showed a
    // perfectly correct split. Click each field, read the one wrapper that
    // exists, move on.
    const colours = [];
    for (let i = 0; i < found.length; i++) {
      const f = found[i];
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1200);
      await page.mouse.click(f.x + f.w / 2, f.y + f.h / 2);
      await page.waitForTimeout(1800);
      const c = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backgroundColor : 'none';
      }, SEL.field);
      colours.push(c);
      log(`field ${i + 1} reads ${c}`);
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);

    const png = shot || path.join(os.tmpdir(), path.basename(doc, '.pdf') + '.png');
    await page.screenshot({ path: png });
    log('screenshot ' + png);
    // One colour per signer. If every field still shares one colour and more
    // than one signer was asked for, nothing actually moved.
    // Adobe gives each signer their own colour, so the colours must group the
    // same way the map does: every field on signer N shares one colour, and no
    // two signers share it. That proves the assignment matches what was asked
    // for, rather than merely that something changed.
    const byS = new Map();
    for (let i = 0; i < colours.length; i++) {
      const sN = map[i];
      if (!byS.has(sN)) byS.set(sN, new Set());
      byS.get(sN).add(colours[i]);
    }
    for (const [sN, set] of byS) {
      if (set.size !== 1) {
        die(`the fields for signer ${sN} (${signers[sN - 1]}) came out in ` +
            `${set.size} different colours (${[...set].join(', ')}), so at least ` +
            `one did not move. Nothing has been sent. See ${png}.`);
      }
    }
    const perSigner = [...byS.values()].map((set) => [...set][0]);
    if (new Set(perSigner).size !== byS.size) {
      die(`two signers ended up sharing a colour (${perSigner.join(', ')}), which ` +
          'means their fields are on the same person. Nothing has been sent. ' +
          `See ${png}.`);
    }
    return { document: doc, agreement: path.basename(doc, path.extname(doc)),
             signers, fields: found.length, map, coloursBefore: before2, coloursAfter: colours,
             screenshot: png, sent: false,
             note: 'Built and NOT sent. Adobe holds it as a draft until a person presses Send.' };
  } finally {
    await ctx.close();
  }
}

function arg(list, name, dflt) {
  const i = list.indexOf('--' + name);
  return i >= 0 ? list[i + 1] : dflt;
}

async function main() {
  const rest = process.argv.slice(2);
  if (rest.includes('--selftest')) return selftest();
  const doc = resolveDocument(arg(rest, 'document'));
  const signers = parseSigners(arg(rest, 'signers'));
  const fields = arg(rest, 'fields', 'blocks');
  const pageNo = Number(arg(rest, 'page', 0)) || 0;
  const shot = arg(rest, 'shot');
  if (rest.includes('--dry')) {
    console.log(JSON.stringify({ document: doc, signers, fields, page: pageNo || 'last', dry: true }, null, 2));
    return;
  }
  const res = await run({ document: doc, signers, fields, page: pageNo, shot });
  console.log(JSON.stringify(res, null, 2));
}

function selftest() {
  THROW_ON_REFUSE = true;
  const cases = [];
  const check = (n, f) => { try { cases.push([n, !!f()]); } catch (e) { cases.push([n, false]); } };
  const refuses = (f) => { try { f(); return false; } catch { return true; } };

  const F = (...labels) => labels.map((label) => ({ label }));
  const SIG = 'signature-form-field, Signature Field';
  const DTE = 'date-of-signing-form-field, Date of Signing';
  const TXT = 'text-form-field, Text Field';

  check('blocks: signature then date, twice, splits between two signers',
    () => parseFieldMap('blocks', F(SIG, DTE, SIG, DTE), 2).join(',') === '1,1,2,2');
  check('blocks: three signature-and-date pairs split between three signers',
    () => parseFieldMap('blocks', F(SIG, DTE, SIG, DTE, SIG, DTE), 3).join(',') === '1,1,2,2,3,3');
  check('blocks: bare signatures with no dates still go one per signer',
    () => parseFieldMap('blocks', F(SIG, SIG, SIG), 3).join(',') === '1,2,3');
  // The authority carries blanks for date of birth and National Insurance
  // number. Adobe detects an empty line as a field, so the count varies per
  // tenant and an even split would move somebody's signature to the wrong person.
  check('blocks: data blanks above the signatures go to the tenant, not by count',
    () => parseFieldMap('blocks', F(TXT, TXT, SIG, DTE, SIG, DTE, SIG, DTE), 3).join(',')
          === '1,1,1,1,2,2,3,3');
  check('blocks refuses a document with fewer signature lines than signers',
    () => refuses(() => parseFieldMap('blocks', F(SIG, DTE), 2)));
  check('blocks refuses a document with more signature lines than signers',
    () => refuses(() => parseFieldMap('blocks', F(SIG, SIG, SIG), 2)));
  check('auto splits four fields evenly between two signers',
    () => parseFieldMap('auto', 4, 2).join(',') === '1,1,2,2');
  check('auto refuses when the fields do not divide evenly',
    () => refuses(() => parseFieldMap('auto', 5, 2)));
  check('an explicit map is taken as given',
    () => parseFieldMap('1,2,1,2', 4, 2).join(',') === '1,2,1,2');
  check('a map of the wrong length is refused',
    () => refuses(() => parseFieldMap('1,1', 4, 2)));
  check('a signer number nobody has is refused',
    () => refuses(() => parseFieldMap('1,1,3,3', 4, 2)));
  check('a signer with no field at all is refused',
    () => refuses(() => checkEverySignerHasAField([1, 1, 1, 1], 2, ['a@b.com', 'c@d.com'])));
  check('a map that covers every signer passes',
    () => { checkEverySignerHasAField([1, 1, 2, 2], 2, ['a@b.com', 'c@d.com']); return true; });
  check('three signers each need a field',
    () => refuses(() => checkEverySignerHasAField([1, 2, 1, 2], 3, ['a@b.com', 'c@d.com', 'e@f.com'])));
  check('signers must be email addresses', () => refuses(() => parseSigners('nope')));
  check('the same signer twice is refused', () => refuses(() => parseSigners('a@b.com,a@b.com')));
  check('no signer at all is refused', () => refuses(() => parseSigners('')));
  check('more than one signer is ALLOWED here, unlike adobe-plan',
    () => parseSigners('a@b.com,c@d.com').length === 2);
  check('the recipient box is never matched on its visible placeholder text',
    () => !JSON.stringify(SEL).match(/placeholder[*^$~|]?="Enter email/));
  check('nothing in the selectors relies on an Adobe hashed class',
    () => !JSON.stringify(SEL).match(/Card__container|react-aria|sc-[a-zA-Z]{6}/));

  cases.forEach(([n, ok]) => console.log((ok ? 'PASS ' : 'FAIL ') + n));
  const bad = cases.filter(([, ok]) => !ok).map(([n]) => n);
  if (bad.length) { console.error(`selftest FAILED: ${bad.join(', ')}`); process.exit(1); }
  console.log(`\n${cases.length} checks passed.`);
}

if (require.main === module) main().catch((e) => die(e.message));
module.exports = { parseFieldMap, checkEverySignerHasAField, parseSigners, SEL };
