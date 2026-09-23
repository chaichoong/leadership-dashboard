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
 * sent multi-signer tenancy agreements this way before (AST_Jane_Testwood,
 * AST_Edna_Example and others).
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
 * And it never reports a box as assigned until the SAVED draft says so: it
 * waits for Adobe to save, reloads, and proves every signature and date box
 * from the stored copy (see judgeSavedDraft, and the 23 Sep 2026 false pass).
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
               fields: 20000, page: 9000, settle: 3000,
               // Adobe saved 8.5 and 11.2 seconds after a move went quiet on 23 Sep 2026.
               save: 45000, moved: 5000 };

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
  addSignature: '[data-testid="menu-item-signature-form-field"]',
  // One element per box, selected or not: what a click aims at, and it carries
  // the owner's colour.
  anyField: '[data-fieldid]',
  // Inside each recipient row, painted in that recipient's colour.
  recipientSwatch: '[data-testid^="recipient-item-wrapper-"]',
};

// Adobe saves the draft with a PUT to the document's asset. Seen on 23 Sep 2026
// as https://dc-api-v2.adobe.io/<n>/assets?asset_uri=... returning 204.
const SAVE_RE = /^https:\/\/dc-api[^/]*\.adobe\.io\/[^?]*\/assets\?asset_uri=/;

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
 * What kind of box a label names. ONE rule, used both to build the map and to
 * judge the saved draft, so a box the map counts as a signature can never be
 * judged as a data blank (which may go unproven).
 */
const kindOf = (label) => (/signature/i.test(label) ? 'signature'
  : /date-of-signing/i.test(label) ? 'date' : 'other');

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

  if (mode === 'blocks' || /^blocks:/.test(mode)) {
    if (!kinds) die('the blocks rule needs the field labels, not just a count');
    // THE ORDER ON THE PAGE IS NOT THE ORDER OF THE SIGNERS. Kevin's rule from
    // 10 Sep 2026: info@agilelets.co.uk must always be the FIRST recipient, so
    // it signs before the tenant. The tenant's signature block is still printed
    // first on the page, so the two orders differ and mapping them positionally
    // would put the tenant's box on Agile Lets. "blocks:2,1" says the first
    // block on the page belongs to signer 2 and the second to signer 1.
    const order = /^blocks:/.test(mode)
      ? mode.slice(7).split(/[,\s]+/).filter(Boolean).map(Number)
      : null;
    const map = [];
    let block = 0;
    const forBlock = (b) => {
      if (!order) return Math.min(b, signerCount);
      if (b > order.length) die(`the document has more signature blocks than --fields lists`);
      return order[b - 1];
    };
    for (const k of kinds) {
      if (kindOf(k) === 'signature') { block += 1; map.push(forBlock(block)); }
      else if (kindOf(k) === 'date') { map.push(forBlock(Math.max(block, 1))); }
      // A data blank belongs to whoever owns the FIRST block, which is the
      // tenant on every one of these templates: they are the details the tenant
      // fills in.
      else map.push(forBlock(1));
    }
    if (order && order.length !== block) {
      die(`--fields lists ${order.length} signature blocks but the document has ${block}. ` +
          'Nothing has been sent.');
    }
    // Without an explicit order, one block per signer. WITH one, more blocks
    // than signers is legitimate: two brothers sharing one address sign one
    // block each from the same inbox (Kevin, 10 Sep 2026), and Adobe will not
    // take the same address twice as separate recipients.
    if (!order && block > signerCount) {
      die(`the document has ${block} signature blocks but only ${signerCount} signers ` +
          'were given. Nothing has been sent.');
    }
    if (order) {
      for (const n of order) {
        if (!Number.isInteger(n) || n < 1 || n > signerCount) {
          die(`--fields block entry ${n} is not a signer between 1 and ${signerCount}`);
        }
      }
    }
    for (let n = 1; n <= signerCount; n++) {
      if (!map.includes(n)) {
        die(`signer ${n} would have nothing to sign. Nothing has been sent.`);
      }
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

/**
 * Read every box on the page and every recipient's colour, WITHOUT CLICKING.
 * Runs inside the page (page.evaluate), so it may use only the DOM.
 *
 * WHO OWNS A BOX IS WRITTEN ON THE BOX. Measured on a live draft, 23 Sep 2026:
 * each box is one element carrying `data-fieldid`, its fill is its owner's
 * colour, and while it is not selected its `outline` attribute names the same
 * colour ("1px solid #7E4BF3"). Each recipient in the left panel is painted in
 * that colour too. So a box's owner is read by matching colours, with nothing
 * selected, rather than by re-selecting the box, which is what failed before.
 * A selected box has a blue selection outline, so its outline and fill
 * disagree and it reads as unproven, never as somebody's.
 */
function readOwnersInPage(sel) {
  // A fully transparent paint is no colour, not black.
  const rgbHex = (s) => {
    const m = String(s || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null;
    return m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  };
  const attrHex = (s) => {
    const m = String(s || '').match(/#([0-9a-f]{6})\b/i);
    return m ? m[1].toLowerCase() : null;
  };
  const recipients = [...document.querySelectorAll(sel.recipientRow)].map((r) => {
    const swatch = r.querySelector(sel.recipientSwatch);
    return { text: r.innerText.trim(), colour: rgbHex(swatch && getComputedStyle(swatch).backgroundColor) };
  });
  const fields = [...document.querySelectorAll(sel.anyField)].map((e) => {
    const r = e.getBoundingClientRect();
    return { id: e.getAttribute('data-fieldid'), label: e.getAttribute('aria-label') || '',
             outline: attrHex(e.getAttribute('outline')),
             fill: rgbHex(getComputedStyle(e).backgroundColor),
             x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }).filter((f) => f.w > 0)
    // DOWN THE PAGE, the same order the map was built in.
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return { recipients, fields };
}

/**
 * Which signer owns each box, from the colours readOwnersInPage returned.
 * Returns one { owner, why } per box: owner is the signer number, or 0 with
 * the reason it could not be proven. Never guesses: a colour that matches no
 * recipient, or two recipients sharing one colour, proves nothing.
 */
function ownersFromReads({ recipients, fields, signers }) {
  const colourOf = new Map();
  for (let n = 1; n <= signers.length; n++) {
    const email = signers[n - 1].toLowerCase();
    // Match the address as a whole word: the row reads "info@agilelets.co.uk (myself)".
    const rows = recipients.filter((r) =>
      String(r.text || '').toLowerCase().split(/[\s()<>,;]+/).includes(email));
    if (rows.length !== 1 || !rows[0].colour) {
      return { ok: false, why: `Adobe's recipient list does not show one colour for ${signers[n - 1]}, ` +
                               'so no box can be traced to them' };
    }
    colourOf.set(n, rows[0].colour);
  }
  const used = [...colourOf.values()];
  if (new Set(used).size !== used.length) {
    return { ok: false, why: 'two recipients share one colour, so a box cannot be traced to one person' };
  }
  const owners = fields.map((f) => {
    if (!f.outline || !f.fill) return { owner: 0, why: 'the box carries no owner colour' };
    if (f.outline !== f.fill) {
      return { owner: 0, why: `its outline (#${f.outline}) and fill (#${f.fill}) disagree, so it is still selected or misread` };
    }
    const hit = [...colourOf].filter(([, c]) => c === f.outline).map(([n]) => n);
    if (hit.length !== 1) return { owner: 0, why: `its colour #${f.outline} belongs to no recipient` };
    return { owner: hit[0] };
  });
  return { ok: true, owners };
}

/**
 * Does the SAVED draft give every box to the signer the map says?
 *
 * WHY THE SAVED DRAFT AND NOT THE OPEN PAGE (23 Sep 2026). A tenancy
 * agreement passed this check with the landlord's date box on the tenant. The
 * old check re-selected each box in the open page and read its colour, and the
 * page was telling the truth: the box HAD moved there. Adobe had not saved it.
 * Adobe saves a draft about 8 to 11 seconds after changes go quiet, and the
 * old read-back clicked a box every 3 seconds straight after the last move,
 * then closed the browser. Reproduced twice on a test draft: the page showed
 * the date box on Agile Lets, the reopened draft showed it on the tenant.
 *
 * So this judges what Adobe HOLDS, read after a reload, and it refuses on
 * silence for the signature block: a signature or date box whose owner cannot
 * be proven is a refusal, not a pass. A data blank (date of birth and the
 * like) that cannot be proven is counted and reported; one proven to sit on
 * the wrong person is still a refusal.
 */
function judgeSavedDraft({ map, expected, saved, recipients, signers }) {
  // `expected` is the boxes as assigned: labels, or reads with a position.
  expected = expected.map((e) => (typeof e === 'string' ? { label: e } : e));
  if (saved.length !== expected.length) {
    return { ok: false, why: `the saved draft shows ${saved.length} boxes on the page where ` +
                             `${expected.length} were assigned, so they cannot be lined up.` };
  }
  for (let i = 0; i < saved.length; i++) {
    if (kindOf(saved[i].label) !== kindOf(expected[i].label)) {
      return { ok: false, why: `box ${i + 1} is a ${kindOf(saved[i].label)} box in the saved draft but ` +
                               `was assigned as a ${kindOf(expected[i].label)} box, so they do not line up.` };
    }
    // SAME KIND IS NOT SAME BOX. Two boxes of one kind side by side can swap
    // places in the order when the page scrolls by a fraction of a pixel. Where
    // is each box relative to the first? Scrolling moves them all together, so
    // that must match what was assigned, or the boxes have been mixed up.
    const at = (list, k) => [list[k].x - list[0].x, list[k].y - list[0].y];
    if ([saved[i], saved[0], expected[i], expected[0]].every((b) => Number.isFinite(b.x) && Number.isFinite(b.y))) {
      const [sx, sy] = at(saved, i);
      const [ex, ey] = at(expected, i);
      if (Math.abs(sx - ex) > 6 || Math.abs(sy - ey) > 6) {
        return { ok: false, why: `box ${i + 1} sits in a different place in the saved draft from the box ` +
                                 'that was assigned, so they do not line up.' };
      }
    }
  }
  // ONE RECIPIENT CANNOT HAVE A BOX ON THE WRONG PERSON: Adobe gives every box
  // a recipient and there is only one. So a proof of residency is judged on the
  // boxes lining up above, not on a colour read, which the sending account's
  // own hand-placed box has failed to give before.
  if (signers.length === 1) return { ok: true, unproven: 0, owners: saved.map(() => signers[0]) };
  const read = ownersFromReads({ recipients, fields: saved, signers });
  if (!read.ok) return { ok: false, why: read.why + '.' };
  let unproven = 0;
  const owners = [];
  for (let i = 0; i < map.length; i++) {
    const { owner, why } = read.owners[i];
    const want = map[i];
    const name = `field ${i + 1} (${kindOf(expected[i].label)})`;
    if (!owner) {
      if (kindOf(expected[i].label) !== 'other') {
        return { ok: false, why: `${name} should be ${signers[want - 1]}'s, but the saved draft does ` +
                                 `not prove who owns it: ${why}.` };
      }
      unproven += 1;
      owners.push(null);
      continue;
    }
    if (owner !== want) {
      return { ok: false, why: `${name} is on ${signers[owner - 1]} in the saved draft, but it ` +
                               `belongs to ${signers[want - 1]}.` };
    }
    owners.push(signers[owner - 1]);
  }
  for (const who of signers) {
    if (!owners.includes(who)) return { ok: false, why: `${who} has no box proven as theirs in the saved draft.` };
  }
  return { ok: true, unproven, owners };
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
 * The box Adobe placed with this id, or null.
 *
 * AIM AT THE BOX BY ADOBE'S OWN ID FOR IT (23 Sep 2026). This used to collect
 * every element whose test id ended in "-field", order them down the page and
 * click the i-th. On an authority to act Adobe also draws a "detected-field"
 * hint at exactly the same spot as each placed box, earlier in the page and
 * underneath it, so the hint was the one clicked: the click timed out behind
 * the real box, the fallback aimed below the fold, and the landlord's date box
 * "would not open its menu" three times. The i-th element was also never
 * checked against the box the map meant. The placed box is the one element
 * carrying data-fieldid, selected or not, and the id stays the same while the
 * page is open (it changes only on a reload). Clicking it opened the menu
 * first time (measured, 236 ms).
 */
async function boxHandle(page, id) {
  if (!/^[\w-]+$/.test(String(id || ''))) die(`a box has an id that cannot be addressed safely: ${id}`);
  return page.$(`${SEL.anyField}[data-fieldid="${id}"]`);
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
    // EVERY SAVE ADOBE MAKES, and when the last change was made, so the check
    // at the end can wait for the save that carries that change.
    const saves = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT' && SAVE_RE.test(r.url())) saves.push({ req: r, at: Date.now() });
    });
    let lastChange = 0;
    await page.goto(ESIGN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(WAIT.load);

    // Adobe CREATES a hidden file input on click and never fires a chooser.
    // A STUCK UPLOAD MUST REFUSE, NOT CRASH. The wait for the file input was
    // started before the click and awaited after it. When the click itself got
    // stuck, the wait expired with nobody listening, and Node killed the run
    // with a raw stack instead of a refusal. That happened to all six attempts
    // in one job on 11 Sep 2026, each logged with an empty reason, so the cause
    // was invisible. The wait now always settles to true or false, the click
    // has its own limit, and either failure refuses with a screenshot.
    const before = await page.locator(SEL.fileInput).count();
    const appears = page.waitForFunction(
      ([sel, n]) => document.querySelectorAll(sel).length > n,
      [SEL.fileInput, before], { timeout: 30000 }).then(() => true).catch(() => false);
    const shotOn = async (tag) => {
      const png = shot || path.join(os.tmpdir(), path.basename(doc, '.pdf') + '-' + tag + '.png');
      await page.screenshot({ path: png }).catch(() => {});
      return png;
    };
    const clicked = await page.locator(SEL.filePick).click({ timeout: 25000 })
      .then(() => true).catch(() => false);
    if (!clicked) {
      const png = await shotOn('upload');
      die('could not click "select a file" on the e-sign page. Adobe may have signed the ' +
          `robot out, or a dialog is covering the page. Nothing has been sent. See ${png}.`);
    }
    if (!(await appears)) {
      const png = await shotOn('upload');
      die('clicking "select a file" produced no file input within 30 seconds. ' +
          `Nothing has been sent. See ${png}.`);
    }
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
      lastChange = Date.now();
      await page.waitForTimeout(WAIT.fields);
    } else if (signers.length === 1) {
      // Auto-place only appears when Adobe recognised something to place. The
      // proof of residency draws its signature line as a rule rather than a
      // run of underscores, so Adobe sees nothing and offers no button. With a
      // single signer there is nothing to assign anyway: place one signature
      // field and it belongs to the only recipient.
      // PLACE THE FIELD ON THE SIGNATURE LINE, ANCHORED TO THE SIGNER'S NAME.
      // Choosing the signature tool puts Adobe into a place-the-field mode: the
      // field follows the pointer and the NEXT click drops it. The first attempt
      // clicked the tool and then tried to click a field, and an overlay
      // intercepted it. So choose the tool, then click on the line itself. The
      // line sits directly above the signer's printed name ("Roy Lavin" on the
      // proof of residency), which is text on the page and does not move, so
      // it is a far steadier anchor than a remembered coordinate.
      const anchorText = process.env.ASSIGN_ANCHOR || 'Roy Lavin';
      log(`no Auto-place offered; placing one signature field above "${anchorText}"`);
      // FIND THE NAME AS TEXT, AT ANY SPLIT. An exact match on "Roy Lavin"
      // timed out on a real proof: Adobe's viewer lays the PDF's words out as
      // separate pieces of text, so no single element ever holds the whole
      // name. Walk the text in the document pane, find the last piece that
      // contains the SURNAME, and measure the text itself with a Range, which
      // works however the words were split and whether or not the text layer
      // is painted. The last match is the signature name: on these letters the
      // signer's name is printed once, under the rule.
      const surname = anchorText.trim().split(/\s+/).pop();
      const ab = await page.evaluate((needle) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let best = null;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const at = n.textContent.indexOf(needle);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(n, at);
          range.setEnd(n, at + needle.length);
          const r = range.getBoundingClientRect();
          // The document pane only; the left panel lists recipient names too.
          if (!r || r.width === 0 || r.x < 300) continue;
          if (!best || r.y > best.y) best = { x: r.x, y: r.y, width: r.width, height: r.height };
        }
        return best;
      }, surname);
      if (!ab) {
        const png = shot || path.join(os.tmpdir(), path.basename(doc, '.pdf') + '-anchor.png');
        await page.screenshot({ path: png });
        die(`could not find "${surname}" in the document to place the signature above. ` +
            `Nothing has been sent. See ${png}.`);
      }
      log(`found "${surname}" at ${Math.round(ab.x)},${Math.round(ab.y)}`);
      await page.locator(SEL.addSignature).click();
      await page.waitForTimeout(2500);
      // The rule is one line above the name. Aim at its middle, a little up.
      // The rule starts at the left margin, level with the name's first word.
      // The surname is to the right of that, so aim back and up onto the rule.
      await page.mouse.click(Math.max(ab.x - 20, 360), ab.y - 18);
      lastChange = Date.now();
      await page.waitForTimeout(WAIT.fields);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1500);
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
    const closeToasts = async () => {
      const toasts = await page.locator(SEL.toastClose).count();
      for (let i = 0; i < toasts; i++) {
        await page.locator(SEL.toastClose).first().click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1200);
      }
      if (toasts) log(`closed ${toasts} notification banner(s) covering the page`);
    };
    await closeToasts();

    // The signature block lives on the last page of these documents.
    const total = Number(await page.locator(SEL.pageTotal).innerText().catch(() => '0')) || 0;
    const target = pageNo || total;
    if (!target) die('could not read how many pages the document has');
    const goToPage = async (n) => {
      await page.locator(SEL.pageBox).click();
      await page.keyboard.press('Meta+A');
      await page.keyboard.type(String(n));
      await page.keyboard.press('Enter');
      await page.waitForTimeout(WAIT.page);
    };
    await goToPage(target);
    log('on page ' + target + ' of ' + total);

    // The same reader the final check uses, so the boxes assigned here and the
    // boxes proven there are counted and ordered by one rule.
    const found = (await page.evaluate(readOwnersInPage, SEL)).fields;
    if (!found.length) die('Auto-place placed no fields on page ' + target);
    const map = parseFieldMap(fields, found, signers.length);
    checkEverySignerHasAField(map, signers.length, signers);
    log(`${found.length} fields, map ${map.join(',')}`);

    // Auto-place leaves them selected as one group; Escape drops that without
    // removing the highlight wrapper the fields are addressed by.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(WAIT.settle);

    // TOUCH ONLY WHAT IS WRONG. Auto-place gives every field to the LAST
    // recipient. With Agile Lets first (Kevin's rule), the last recipient is
    // the tenant, so every tenant field is already right and only the Agile
    // Lets boxes need moving. Reassigning a field that is already correct is
    // not just wasted: on the authority to act it failed outright, because
    // the tenant's data blanks sit at the top of the letter, scrolled off the
    // page by the time the loop reaches them, and their menu will not open.
    // The Agile Lets boxes are at the foot of the page, on screen. If the
    // assumption about Auto-place is ever wrong, the saved-draft check below
    // catches it: that box reads as the wrong person's and the run is refused.
    const autoOwner = signers.length;
    // Who owns one box right now, by Adobe's id for it, read off the open page.
    const ownerNow = async (id) => {
      const now = await page.evaluate(readOwnersInPage, SEL);
      const box = now.fields.filter((x) => x.id === id);
      if (box.length !== 1) return { owner: 0, why: 'the box is no longer on the page' };
      const r = ownersFromReads({ recipients: now.recipients, fields: box, signers });
      return r.ok ? r.owners[0] : { owner: 0, why: r.why };
    };
    for (let i = 0; i < found.length; i++) {
      if (map[i] === autoOwner) {
        log(`field ${i + 1} (${found[i].label.split(',')[0]}) already on signer ${autoOwner}, left alone`);
        continue;
      }
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
        const h = await boxHandle(page, f.id);
        // NEVER FALL BACK TO A REMEMBERED POINT. Coordinates were read at one
        // scroll position and the viewer scrolls as it works, so a stale click
        // lands on blank paper and the failure looks like the field refusing to
        // open. That masked the real error for several runs on the authority to
        // act, where the fallback fired and hit nothing. Ask the element where
        // it is NOW, and if even that fails, say why instead of guessing.
        if (!h) die(`field ${i + 1} has no clickable body on the page. Nothing has been sent.`);
        try {
          await h.click({ timeout: 10000 });
        } catch (e) {
          await h.scrollIntoViewIfNeeded().catch(() => {});
          const box = await h.boundingBox();
          if (!box) {
            log(`field ${i + 1}: no box after scrolling (${String(e.message).slice(0, 60)})`);
          } else {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          }
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
        const alone = await boxHandle(page, f.id);
        if (alone) await alone.click({ timeout: 10000 }).catch((e) => log(`field ${i + 1}: ${e.message.split('\n')[0]}`));
        await page.waitForTimeout(WAIT.settle);
        const again = await page.locator(SEL.selectionCount).innerText().catch(() => '');
        if (/\d+\s+fields selected/i.test(again)) {
          die(`field ${i + 1} will not select on its own (${again.trim()}), so a ` +
              'reassignment would move every field at once. Nothing has been sent.');
        }
      }
      // Which box is selected, by Adobe's own id, so the move is checked on
      // that box and no other.
      const selected = await page.$$eval(SEL.field, (els) => els.map((e) => e.getAttribute('data-fieldid')));
      if (selected.length !== 1 || selected[0] !== f.id) {
        die(`field ${i + 1}: the selected box is not the one being moved (${selected.length} selected), ` +
            'so a reassignment would move the wrong box. Nothing has been sent.');
      }
      await page.locator(SEL.changeRecipients).click();
      await page.waitForTimeout(WAIT.menu);
      const option = page.locator(SEL.recipientOption).filter({ hasText: want }).first();
      if (!(await option.count())) die(`no recipient option for ${want} on field ${i + 1}`);
      await option.click();
      lastChange = Date.now();
      await page.waitForTimeout(WAIT.settle);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      // CONFIRM THE MOVE ON THE BOX ITSELF. Adobe repaints a box in its new
      // owner's colour the moment the recipient is picked (measured 23 Sep 2026),
      // so a box still in the old colour after that did not move.
      let now = await ownerNow(selected[0]);
      for (const until = Date.now() + WAIT.moved; now.owner !== map[i] && Date.now() < until;) {
        await page.waitForTimeout(250);
        now = await ownerNow(selected[0]);
      }
      if (now.owner !== map[i]) {
        die(`field ${i + 1} did not move to ${want}: ` +
            (now.owner ? `it is still on ${signers[now.owner - 1]}` : now.why) + '. Nothing has been sent.');
      }
      log(`field ${i + 1} (${f.label.split(',')[0]}) -> signer ${map[i]} ${want}`);
    }

    // PROVE IT FROM WHAT ADOBE SAVED, NOT FROM THE OPEN PAGE (23 Sep 2026).
    // The open page shows a move the instant it is made; Adobe saves the draft
    // only once changes go quiet. So let the page sit untouched until the save
    // that follows the last change lands, then reload and read every owner off
    // the saved draft. The old check clicked through the boxes here instead,
    // which kept the save from firing, and passed a date box Adobe never kept.
    await page.keyboard.press('Escape');
    // Wait for a save after the last change, then 3 quiet seconds so a second
    // save still in flight is not cut off, all inside WAIT.save.
    let saveStatus = null;
    const saveBy = Date.now() + WAIT.save;
    while (Date.now() < saveBy) {
      const after = saves.filter((x) => x.at > lastChange);
      const latest = after[after.length - 1];
      if (latest && Date.now() - latest.at >= 3000) {
        const resp = await Promise.race([
          latest.req.response().catch(() => null),
          page.waitForTimeout(Math.max(saveBy - Date.now(), 1000)).then(() => null),
        ]);
        saveStatus = resp ? resp.status() : 0;
        break;
      }
      await page.waitForTimeout(500);
    }
    log(saveStatus === null
      ? `no save seen within ${WAIT.save / 1000}s of the last change; reloading to read what Adobe holds`
      : `Adobe saved the draft (HTTP ${saveStatus}); reloading it to prove every box`);
    // A "leave this page?" prompt means Adobe still held an unsaved change.
    // Leave anyway: the saved draft read below is what decides.
    let unsaved = false;
    page.on('dialog', (d) => {
      unsaved = true;
      d.accept().catch((e) => log(`could not answer Adobe's leave-page prompt: ${e.message}`));
    });
    // ADOBE CAN ANSWER A RELOAD WITH "Something went wrong". Seen once, on a
    // proof reloaded 40 seconds after its upload (23 Sep 2026); the drafts that
    // reopened were a couple of minutes old. So try again, twice, 15 seconds
    // apart, opening the draft's own address without the upload's session id.
    const draftUrl = page.url().replace(/([?&])transientId=[^&]*&?/, '$1').replace(/[?&]$/, '');
    let reopened = false;
    for (let attempt = 1; attempt <= 3 && !reopened; attempt++) {
      if (attempt > 1) {
        log(`the draft did not reopen (try ${attempt - 1} of 3); waiting 15s and opening it again`);
        await page.waitForTimeout(15000);
      }
      const nav = attempt === 1
        ? page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
        : page.goto(draftUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await nav.catch((e) => log(`opening the draft: ${e.message.split('\n')[0]}`));
      reopened = await page.locator(SEL.send)
        .waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
    }
    if (!reopened) {
      const png = await shotOn('reload');
      die(`the draft did not reopen after saving, so no box can be proven. Nothing has been sent. See ${png}.`);
    }
    if (unsaved) log('Adobe warned of an unsaved change on reload; the saved draft decides');
    await page.waitForTimeout(WAIT.settle);
    await closeToasts();
    await goToPage(target);
    await page.keyboard.press('Escape');
    // The recipients panel took 25 seconds to paint on a cold run. Read until
    // every recipient shows a colour and every assigned box is back, or time
    // runs out, and judge the last read either way.
    let saved = await page.evaluate(readOwnersInPage, SEL);
    for (const until = Date.now() + WAIT.panel; Date.now() < until;) {
      const painted = saved.recipients.length === signers.length && saved.recipients.every((r) => r.colour);
      if (painted && saved.fields.length === found.length) break;
      await page.waitForTimeout(1000);
      saved = await page.evaluate(readOwnersInPage, SEL);
    }

    const png = shot || path.join(os.tmpdir(), path.basename(doc, '.pdf') + '.png');
    // Show the signature block, which sits at the foot of a one-page letter.
    const lowest = saved.fields.length ? await boxHandle(page, saved.fields[saved.fields.length - 1].id) : null;
    if (lowest) {
      await lowest.scrollIntoViewIfNeeded()
        .catch((e) => log(`could not scroll the signature block into the screenshot: ${e.message}`));
    }
    await page.screenshot({ path: png });
    log('screenshot ' + png);
    const verdict = judgeSavedDraft({ map, expected: found, saved: saved.fields,
                                      recipients: saved.recipients, signers });
    if (!verdict.ok) die(verdict.why + ` Nothing has been sent. See ${png}.`);
    verdict.owners.forEach((o, i) => log(`saved draft: field ${i + 1} (${kindOf(found[i].label)}) is ${o || 'unproven'}`));
    if (verdict.unproven) log(`${verdict.unproven} data blank(s) could not be proven; see ${png}`);

    return { document: doc, agreement: path.basename(doc, path.extname(doc)),
             signers, fields: found.length, map, owners: verdict.owners, proven: 'saved draft',
             screenshot: png, sent: false, unproven: verdict.unproven,
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
  // Kevin's rule: info@agilelets.co.uk signs FIRST, while its signature block is
  // printed SECOND. The two orders differ and the map has to say so.
  check('blocks:2,1 gives the page-first block to the second signer',
    () => parseFieldMap('blocks:2,1', F(SIG, DTE, SIG, DTE), 2).join(',') === '2,2,1,1');
  check('blocks:2,3,1 handles a joint agreement with Agile Lets signing first',
    () => parseFieldMap('blocks:2,3,1', F(SIG, SIG, SIG), 3).join(',') === '2,3,1');
  check('blocks:2,1 puts the tenant data blanks on the tenant, not on Agile Lets',
    () => parseFieldMap('blocks:2,1', F(TXT, TXT, SIG, DTE, SIG, DTE), 2).join(',')
          === '2,2,2,2,1,1');
  check('blocks:2,2,1 lets two tenants sharing an address sign one block each',
    () => parseFieldMap('blocks:2,2,1', F(SIG, SIG, SIG), 2).join(',') === '2,2,1');
  check('a blocks list that does not match the document is refused',
    () => refuses(() => parseFieldMap('blocks:2,1', F(SIG, SIG, SIG), 2)));
  check('a blocks list leaving a signer with nothing is refused',
    () => refuses(() => parseFieldMap('blocks:2,2', F(SIG, SIG), 2)));
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
  // The saved-draft verdict, fed the reads measured on a live draft, 23 Sep 2026.
  const S2 = ['info@agilelets.co.uk', 'tenant@x.com'];
  const PURPLE = '7e4bf3';
  const GREEN = '50a65e';
  const ROWS = [{ text: 'info@agilelets.co.uk (myself)', colour: PURPLE }, { text: 'tenant@x.com', colour: GREEN }];
  const box = (label, c, fill = c) => ({ label, outline: c, fill });
  const AST = [SIG, DTE, SIG, DTE];
  const V = (saved, { map = [2, 2, 1, 1], expected = AST, recipients = ROWS, signers = S2 } = {}) =>
    judgeSavedDraft({ map, expected, saved, recipients, signers });
  check('a saved draft with every box on its signer passes',
    () => V([box(SIG, GREEN), box(DTE, GREEN), box(SIG, PURPLE), box(DTE, PURPLE)]).ok);
  // THE 23 SEP 2026 FALSE PASS. The open page read the landlord's date box as
  // purple; the saved draft had it on the tenant. judgeColours passed it.
  check('23 Sep: the landlord date box left on the tenant in the saved draft is refused',
    () => /field 4 \(date\) is on tenant@x\.com in the saved draft, but it belongs to info@agilelets\.co\.uk/
      .test(V([box(SIG, GREEN), box(DTE, GREEN), box(SIG, PURPLE), box(DTE, GREEN)]).why));
  check('a box still selected (blue outline) proves nothing and is refused',
    () => /does not prove who owns it/.test(V([box(SIG, GREEN), box(DTE, GREEN), box(SIG, PURPLE),
                                                box(DTE, '2680eb', PURPLE)]).why));
  check('a signature box with no owner colour at all is refused',
    () => !V([box(SIG, GREEN), box(DTE, GREEN), box(SIG, null, null), box(DTE, PURPLE)]).ok);
  check('a colour no recipient has is refused',
    () => /belongs to no recipient/.test(V([box(SIG, GREEN), box(DTE, GREEN), box(SIG, 'aaaaaa'), box(DTE, PURPLE)]).why));
  check('two recipients sharing one colour prove nothing',
    () => !V([box(SIG, GREEN), box(DTE, GREEN), box(SIG, GREEN), box(DTE, GREEN)],
             { recipients: [{ text: 'info@agilelets.co.uk (myself)', colour: GREEN }, ROWS[1]] }).ok);
  check('a recipient missing from the list is refused, not guessed',
    () => /does not show one colour for tenant@x\.com/.test(V([box(SIG, GREEN), box(DTE, GREEN), box(SIG, PURPLE), box(DTE, PURPLE)],
             { recipients: [ROWS[0]] }).why));
  check('an address is matched whole, never as part of a longer one',
    () => !V([box(SIG, GREEN), box(DTE, GREEN), box(SIG, PURPLE), box(DTE, PURPLE)],
             { recipients: [ROWS[0], { text: 'xtenant@x.com', colour: GREEN }] }).ok);
  check('a saved draft with a different number of boxes is refused',
    () => /cannot be lined up/.test(V([box(SIG, GREEN), box(DTE, GREEN), box(SIG, PURPLE)]).why));
  check('a saved draft whose boxes are in a different order is refused',
    () => /do not line up/.test(V([box(DTE, GREEN), box(SIG, GREEN), box(SIG, PURPLE), box(DTE, PURPLE)]).why));
  check('a data blank that cannot be proven is counted, not refused',
    () => V([box(TXT, null, null), box(SIG, GREEN), box(DTE, GREEN), box(SIG, PURPLE), box(DTE, PURPLE)],
            { map: [2, 2, 2, 1, 1], expected: [TXT, ...AST] }).unproven === 1);
  check('a data blank proven to be on the wrong person is refused',
    () => !V([box(TXT, PURPLE), box(SIG, GREEN), box(DTE, GREEN), box(SIG, PURPLE), box(DTE, PURPLE)],
             { map: [2, 2, 2, 1, 1], expected: [TXT, ...AST] }).ok);
  // From the independent review, 23 Sep 2026.
  check('any label naming a signature is judged as a signature, so it must be proven',
    () => !V([box(SIG, GREEN), box(DTE, GREEN), box('signature-block-form-field, Sig', null, null), box(DTE, PURPLE)],
             { expected: [SIG, DTE, 'signature-block-form-field, Sig', DTE] }).ok);
  const placed = (label, c, x, y) => ({ ...box(label, c), x, y });
  const SIDE = [placed(SIG, GREEN, 400, 300), placed(SIG, PURPLE, 700, 300)];
  // The dangerous swap: the loop moved the wrong one of two side-by-side boxes
  // and the saved read lists them in the other order, so kind and owner both
  // line up. Only where each box sits gives it away.
  check('two boxes side by side read back in swapped order are refused',
    () => /different place/.test(V([placed(SIG, GREEN, 700, 900), placed(SIG, PURPLE, 400, 900)],
                                   { map: [2, 1], expected: SIDE }).why));
  check('the same two boxes after a scroll, in place, pass',
    () => V([placed(SIG, GREEN, 400, 900), placed(SIG, PURPLE, 700, 900)], { map: [2, 1], expected: SIDE }).ok);
  check('a signer with no proven box of their own is refused',
    () => /info@agilelets\.co\.uk has no box proven/.test(V([box(TXT, GREEN), box(SIG, GREEN), box(TXT, null, null)],
             { map: [2, 2, 1], expected: [TXT, SIG, TXT] }).why));
  check('a proof of residency whose one box reads no colour still passes: nobody else could own it',
    () => V([box(SIG, null, null)], { map: [1], expected: [SIG], recipients: [], signers: [S2[0]] }).ok);
  check('a proof of residency whose saved draft lost its box is still refused',
    () => !V([], { map: [1], expected: [SIG], recipients: [ROWS[0]], signers: [S2[0]] }).ok);
  check('a proof of residency: one Agile Lets box passes',
    () => V([box(SIG, PURPLE)], { map: [1], expected: [SIG], recipients: [ROWS[0]], signers: [S2[0]] }).ok);
  check('the recipient box is never matched on its visible placeholder text',
    () => !JSON.stringify(SEL).match(/placeholder[*^$~|]?="Enter email/));
  check('nothing in the selectors relies on an Adobe hashed class',
    () => !JSON.stringify(SEL).match(/Card__container|react-aria|sc-[a-zA-Z]{6}/));

  cases.forEach(([n, ok]) => console.log((ok ? 'PASS ' : 'FAIL ') + n));
  const bad = cases.filter(([, ok]) => !ok).map(([n]) => n);
  if (bad.length) { console.error(`selftest FAILED: ${bad.join(', ')}`); process.exit(1); }
  console.log(`\n${cases.length} checks passed.`);
}

if (require.main === module) {
  // An unhandled rejection anywhere must still end as a REFUSED line with its
  // reason, never as a bare stack the batch logs as an empty refusal.
  process.on('unhandledRejection', (e) => die(String((e && e.message) || e)));
  main().catch((e) => die(e.message));
}
module.exports = { parseFieldMap, checkEverySignerHasAField, parseSigners, readOwnersInPage,
                   ownersFromReads, judgeSavedDraft, boxHandle, SEL, SAVE_RE };
