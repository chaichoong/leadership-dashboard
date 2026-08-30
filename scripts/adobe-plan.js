#!/usr/bin/env node
/**
 * adobe-plan.js — write the browser plan that sends a document for signature.
 *
 * WHY THIS EXISTS (28 Aug 2026)
 * -----------------------------
 * agent-browser.js executes plans; it does not invent them. Every Adobe plan so
 * far was hand-written by Claude in an interactive session, which meant an agent
 * could generate a letter and then had no way to get it signed. This is the
 * missing piece between those two.
 *
 * The steps below are not a guess. Each one was driven against the live Adobe
 * account on 28 Aug 2026 and the flow reached "ready to send" with the fields
 * placed, before stopping at the gate.
 *
 * SELECTORS THAT SURVIVE A DEPLOY
 * -------------------------------
 * Adobe's card classes are hashed (Card__container___j_wff) and its field ids
 * are React-generated (react-aria543774191-:r3u:). Both change the next time
 * Adobe ships. Everything here is text-scoped or a placeholder, which is the
 * only thing about that page that has held still.
 *
 * TWO THINGS THAT LOOK OPTIONAL AND ARE NOT
 * -----------------------------------------
 * 1. The recipient only becomes a CHIP on Enter. `fill` alone leaves the address
 *    as loose text in a box, Send produces an agreement that goes to nobody, and
 *    NOTHING errors. Hence the press after every signer.
 * 2. Auto-place, not coordinate clicks. A plan addresses elements by selector
 *    and a click at (520, 545) is not a selector. Auto-place has a known bug
 *    where it assigns every field to signer 2, which cannot bite with ONE
 *    signer — so a multi-signer plan is refused here rather than sent wrong.
 *
 * THE AGREEMENT NAME
 * ------------------
 * Adobe names the agreement after the file. That is emitted as `agreement` so
 * the caller can hand the SAME string to signature-watch, which is how the
 * signed copy finds its way back to the task. Do not rename the PDF between
 * planning and sending.
 *
 * USAGE
 *   node scripts/adobe-plan.js --document ~/knowledge-os/attachments/loa.pdf \
 *                             --signers kevinbrittain@gmail.com
 *   node scripts/adobe-plan.js ... | node scripts/agent-browser.js prepare --plan - --shot s.png
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ATTACH_DIR = (() => {
  const p = path.resolve(process.env.AGENT_UPLOAD_DIR ||
    path.join(os.homedir(), 'knowledge-os', 'attachments'));
  try { return fs.realpathSync(p); } catch { return p; }
})();

const ESIGN_URL = 'https://acrobat.adobe.com/link/tools/?group=group-sign';
const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;

// Adobe's own screens, measured. These waits look generous and are not: the
// app is a heavy SPA and `read` returned a spinner at 8 seconds on the first
// live attempt. A short wait here is a plan that fails intermittently, which is
// worse than one that fails always.
const WAIT = { load: 15000, settle: 8000, upload: 12000, panel: 15000,
               afterPanel: 12000, chip: 5000, fields: 15000 };

// Refusals EXIT when this runs as a command and THROW when required as a module
// or exercised by the selftest, so a test can assert on the refusal instead of
// the runner being killed by the guard it is testing. Same shape as
// make-letter.js and agent-browser.js — three files needing it is the sign it
// should be the default, not a thing each one remembers.
let THROW_ON_REFUSE = require.main !== module;

function die(msg) {
  if (THROW_ON_REFUSE) throw new Error('PLAN REFUSED: ' + msg);
  console.error('PLAN REFUSED: ' + msg);
  process.exit(1);
}

function resolveDocument(p) {
  const abs = path.resolve(String(p || '').replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(abs)) die(`document does not exist: ${abs}`);
  const real = fs.realpathSync(abs);
  // Same fence as the upload step and the sending scripts: one directory decides
  // what an agent may send outward.
  if (!(real === ATTACH_DIR || real.startsWith(ATTACH_DIR + path.sep))) {
    die(`${real} is outside the attachments directory (${ATTACH_DIR}). ` +
        'Generate the letter with make-letter.js, which lands there by default.');
  }
  if (path.extname(real).toLowerCase() !== '.pdf') die('the document must be a PDF');
  return real;
}

function parseSigners(raw) {
  const list = String(raw || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!list.length) die('--signers is required — who has to sign it?');
  for (const s of list) if (!EMAIL_RE.test(s)) die(`not an email address: ${s}`);
  if (list.length > 1) {
    // Auto-place assigns every field to signer 2. With one signer that is
    // harmless; with several it silently gives one person all the fields and
    // the others none, and the agreement goes out wrong. Refuse rather than
    // send something Kevin would have to unpick.
    die(`${list.length} signers. Auto-place assigns every field to one recipient, so a ` +
        'multi-signer agreement would go out with the fields on the wrong person. ' +
        'Send those by hand until the plan places fields per signer.');
  }
  return list;
}

function buildPlan({ document: doc, signers }) {
  const steps = [
    { do: 'goto', url: ESIGN_URL },
    { do: 'wait', ms: WAIT.load },
    { do: 'wait', ms: WAIT.settle },
    { do: 'upload',
      selector: 'article:has-text("Request e-signatures") >> text=select a file',
      file: doc },
    { do: 'wait', ms: WAIT.upload },
    { do: 'click', selector: 'button:has-text("Continue")' },
    { do: 'wait', ms: WAIT.panel },
    { do: 'wait', ms: WAIT.afterPanel },
  ];
  for (const signer of signers) {
    steps.push({ do: 'fill', selector: 'input[placeholder="Enter email..."]', value: signer });
    // Without this the address is loose text and Send goes nowhere, silently.
    steps.push({ do: 'press', selector: 'input[placeholder="Enter email..."]', key: 'Enter' });
    steps.push({ do: 'wait', ms: WAIT.chip });
  }
  steps.push({ do: 'click', selector: 'button:has-text("Auto-place fields")' });
  steps.push({ do: 'wait', ms: WAIT.fields });
  // prepare stops here; commit presses it, and only on a live Approved verdict.
  steps.push({ do: 'submit', selector: 'button:has-text("Send")' });
  return { site: 'adobe', steps };
}

/** Adobe names the agreement after the file. Keep the two in step. */
function agreementName(doc) {
  return path.basename(doc, path.extname(doc));
}

function arg(list, name) {
  const i = list.indexOf('--' + name);
  return i >= 0 ? list[i + 1] : null;
}

function main() {
  const rest = process.argv.slice(2);
  if (rest.includes('--selftest')) return selftest();
  const doc = resolveDocument(arg(rest, 'document'));
  const signers = parseSigners(arg(rest, 'signers'));
  const plan = buildPlan({ document: doc, signers });
  const out = arg(rest, 'out');
  const text = JSON.stringify(plan, null, 2);
  if (out) {
    fs.writeFileSync(out, text);
    console.error(`plan written to ${out}`);
  } else {
    process.stdout.write(text + '\n');
  }
  // To stderr so the plan can be piped straight into agent-browser.js.
  console.error(JSON.stringify({
    agreement: agreementName(doc),
    signers,
    note: 'Register this EXACT agreement name with signature-watch, or the signed ' +
          'copy will never find its way back to the task.',
  }, null, 2));
}

function selftest() {
  THROW_ON_REFUSE = true;
  const cases = [];
  const check = (n, f) => { try { cases.push([n, !!f()]); } catch { cases.push([n, false]); } };
  const refuses = (f) => { try { f(); return false; } catch { return true; } };

  const plan = buildPlan({ document: '/x/a.pdf', signers: ['k@b.com'] });
  const dos = plan.steps.map((s) => s.do);

  check('uploads before it touches recipients',
    () => dos.indexOf('upload') < dos.indexOf('fill'));
  check('presses Enter after every signer, or the chip never forms',
    () => plan.steps.filter((s) => s.do === 'press').length ===
          plan.steps.filter((s) => s.do === 'fill').length);
  check('places fields before Send', () =>
    dos.indexOf('click') < dos.lastIndexOf('submit'));
  check('ends on submit, so prepare stops there', () => dos[dos.length - 1] === 'submit');
  check('has exactly one submit', () => dos.filter((d) => d === 'submit').length === 1);
  check('uses text-scoped selectors, never Adobe hashed classes',
    () => !JSON.stringify(plan).match(/Card__container|react-aria/));
  check('refuses more than one signer while auto-place misassigns',
    () => refuses(() => parseSigners('a@b.com, c@d.com')));
  check('refuses something that is not an email', () => refuses(() => parseSigners('nope')));
  check('refuses no signer at all', () => refuses(() => parseSigners('')));
  check('agreement name matches the filename Adobe will use',
    () => agreementName('/x/Letter_of_Authority.pdf') === 'Letter_of_Authority');

  cases.forEach(([n, ok]) => console.log((ok ? 'PASS ' : 'FAIL ') + n));
  const bad = cases.filter(([, ok]) => !ok).map(([n]) => n);
  if (bad.length) { console.error(`selftest FAILED: ${bad.join(', ')}`); process.exit(1); }
  console.log(`\n${cases.length} checks passed.`);
}

if (require.main === module) main();
module.exports = { buildPlan, parseSigners, resolveDocument, agreementName, ATTACH_DIR };
