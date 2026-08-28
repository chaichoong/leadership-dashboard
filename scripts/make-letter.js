#!/usr/bin/env node
/**
 * make-letter.js — turn a letter spec into a PDF an agent can actually post.
 *
 * WHY THIS EXISTS (28 Aug 2026)
 * -----------------------------
 * Stage one of the pipeline Kevin asked for: an agent creates a PDF, gets it
 * signed in Adobe, then posts it via Pingen or emails it. Nothing here could
 * make a PDF at all, and the old tenant-doc generator points at files that no
 * longer exist on this machine.
 *
 * WHY CHROMIUM AND NOT A PDF LIBRARY
 * ----------------------------------
 * reportlab and fpdf are not installed and this Mac has no Homebrew, so adding
 * a native dependency for a headless launchd job is a liability. Playwright is
 * ALREADY a dependency and already proven headless here, and Chromium prints
 * PDFs with real typography, real word wrapping and exact millimetre geometry.
 * Zero new dependencies, and the layout is CSS rather than hand-computed text
 * positions.
 *
 * THE 64mm IS LOAD-BEARING — DO NOT "TIDY" IT
 * -------------------------------------------
 * Pingen has NO address parameter. It reads the recipient off the PDF, out of
 * the envelope window, so where the address sits IS the address. Measured
 * against the live API by uploading one block at three heights:
 *
 *   57mm from the top  -> address truncated to 3 of 4 lines, action_required
 *   64mm from the top  -> all 4 lines read, graded "valid"          <- this one
 *   71mm from the top  -> all 4 lines read, STILL action_required
 *
 * Six HMRC letters were returned "Not at this address" in 2025 and charged for.
 * That is what an address block in the wrong place costs. The block is pinned
 * absolutely at 64mm/25mm and send-letter.py re-checks what Pingen actually
 * read before anything is printed.
 *
 * USAGE
 *   node scripts/make-letter.js --spec letter.json [--out FILE.pdf]
 *   node scripts/make-letter.js --selftest
 *
 * SPEC
 *   {
 *     "from":      "agile-lets",              // key in ~/.config/od/letterheads.json
 *     "to":        ["Corporation Tax", "HM Revenue and Customs",
 *                   "BX9 1AX", "United Kingdom"],
 *     "date":      "28 August 2026",          // optional, caller supplies
 *     "ref":       "Ref: Self Assessment UTR 1234567890",
 *     "salutation":"Dear Sir or Madam",
 *     "body":      ["First paragraph.", "Second paragraph."],
 *     "signoff":   "Yours faithfully",        // optional
 *     "signatory": "Kevin Brittain",          // optional, defaults from letterhead
 *     "title":     "Director"                 // optional, defaults from letterhead
 *   }
 *
 * The `to` block is what send-letter.py compares against Pingen's own reading,
 * so it must be the address EXACTLY as it should appear on the envelope.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT_DIR = path.join(os.homedir(), 'knowledge-os', 'attachments');
const LETTERHEADS = path.join(os.homedir(), '.config', 'od', 'letterheads.json');

// Geometry, in millimetres. The address values are measured, not chosen.
const ADDRESS_TOP_MM = 64;
const ADDRESS_LEFT_MM = 25;

// Refusals EXIT when this runs as a command and THROW when required as a
// module or exercised by the selftest, so a test can assert on the refusal
// instead of the runner being killed by the guard it is testing.
let THROW_ON_REFUSE = require.main !== module;

function die(msg) {
  if (THROW_ON_REFUSE) throw new Error('LETTER REFUSED: ' + msg);
  console.error('LETTER REFUSED: ' + msg);
  process.exit(1);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadLetterheads() {
  try { return JSON.parse(fs.readFileSync(LETTERHEADS, 'utf8')); }
  catch { return {}; }
}

// Validation is strict because the output gets printed and posted at about
// £2.50 a go, and a letter with a two-line address is a letter that comes back.
function validate(spec) {
  if (!spec || typeof spec !== 'object') die('spec must be an object');
  const to = spec.to;
  if (!Array.isArray(to) || to.filter((l) => String(l || '').trim()).length < 3) {
    die('`to` needs at least 3 non-empty address lines (name, street or office, postcode). ' +
        'Pingen reads this off the page; a short address is an undeliverable letter.');
  }
  if (to.some((l) => /^\s*to:\s*$/i.test(String(l)))) {
    die('`to` contains a bare "To:" line. That exact defect put six HMRC letters ' +
        'in the returned pile — the address block must hold ONLY the address.');
  }
  const body = spec.body;
  if (!Array.isArray(body) || !body.filter((p) => String(p || '').trim()).length) {
    die('`body` must be a non-empty array of paragraphs');
  }
  const heads = loadLetterheads();
  if (spec.from && !heads[spec.from]) {
    die(`unknown letterhead "${spec.from}". Known: ${Object.keys(heads).join(', ') || '(none configured)'}`);
  }
  return true;
}

function buildHtml(spec) {
  const heads = loadLetterheads();
  const head = (spec.from && heads[spec.from]) || {};
  const to = spec.to.map((l) => String(l).trim()).filter(Boolean);
  const signatory = spec.signatory || head.signatory || '';
  const title = spec.title || head.title || '';

  return `<!doctype html><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 11pt;
         line-height: 1.45; color: #000; }
  /* Absolute, because Pingen reads the recipient out of the envelope window
     and this position is measured against the live API. See the header. */
  .to { position: absolute; top: ${ADDRESS_TOP_MM}mm; left: ${ADDRESS_LEFT_MM}mm;
        white-space: pre-line; line-height: 1.35; }
  .sender { position: absolute; top: 20mm; right: 25mm; text-align: right;
            font-size: 10pt; }
  .main { padding: 105mm 25mm 30mm 25mm; }
  .date { text-align: right; margin-bottom: 10mm; }
  .ref  { font-weight: bold; margin-bottom: 6mm; }
  p { margin: 0 0 4.5mm 0; }
  .sig { margin-top: 14mm; }
  .sig .name { margin-top: 16mm; }
  .foot { position: fixed; bottom: 12mm; left: 25mm; right: 25mm;
          text-align: center; font-size: 8pt; color: #444;
          border-top: 0.4pt solid #999; padding-top: 2mm; }
  </style>
  ${head.name ? `<div class="sender">${esc(head.name)}</div>` : ''}
  <div class="to">${to.map(esc).join('\n')}</div>
  <div class="main">
    ${spec.date ? `<div class="date">${esc(spec.date)}</div>` : ''}
    ${spec.ref ? `<div class="ref">${esc(spec.ref)}</div>` : ''}
    ${spec.salutation ? `<p>${esc(spec.salutation)}</p>` : ''}
    ${spec.body.map((p) => `<p>${esc(p)}</p>`).join('\n    ')}
    <div class="sig">
      ${spec.signoff ? `<p>${esc(spec.signoff)}</p>` : ''}
      ${signatory ? `<p class="name">${esc(signatory)}</p>` : ''}
      ${title ? `<p>${esc(title)}</p>` : ''}
    </div>
  </div>
  ${head.footer ? `<div class="foot">${esc(head.footer)}</div>` : ''}`;
}

async function render(html, outPath) {
  let chromium;
  for (const mod of ['playwright-core', '@playwright/test',
                     path.join(path.resolve(__dirname, '..'), 'node_modules', 'playwright-core')]) {
    try { ({ chromium } = require(mod)); break; } catch { /* next */ }
  }
  if (!chromium) die('playwright not found. Run npm install in the repo.');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // printBackground off: this is a letter, not a web page.
    await page.pdf({ path: outPath, format: 'A4', printBackground: false,
                     margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  } finally {
    await browser.close();
  }
  return outPath;
}

function outputPath(spec, explicit) {
  if (explicit) return path.resolve(explicit.replace(/^~(?=$|\/)/, os.homedir()));
  // Default INTO the attachments directory, because that is the only place
  // send-letter.py and agent-browser.js will send a file from. A generator
  // that writes somewhere else just moves the problem.
  const slug = String(spec.name || spec.ref || spec.to[0] || 'letter')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'letter';
  return path.join(OUT_DIR, `${slug}.pdf`);
}

function selftest() {
  THROW_ON_REFUSE = true;
  const cases = [];
  const check = (name, fn) => {
    try { cases.push([name, !!fn()]); } catch { cases.push([name, false]); }
  };
  const refuses = (spec) => {
    try { validate(spec); return false; } catch { return true; }
  };
  const ok = { from: 'agile-lets', to: ['Corporation Tax', 'HM Revenue and Customs', 'BX9 1AX'],
               body: ['Hello.'] };

  check('accepts a well-formed spec', () => validate(ok));
  check('refuses a two-line address', () => refuses({ ...ok, to: ['A', 'B'] }));
  check('refuses an empty body', () => refuses({ ...ok, body: [] }));
  check('refuses an unknown letterhead', () => refuses({ ...ok, from: 'nope' }));
  // The exact defect that cost six HMRC letters.
  check('refuses a bare "To:" line in the address',
    () => refuses({ ...ok, to: ['To:', 'Corporation Tax', 'HM Revenue and Customs', 'BX9 1AX'] }));

  const html = buildHtml(ok);
  check('address block is pinned at the measured 64mm',
    () => /top:\s*64mm/.test(html) && /left:\s*25mm/.test(html));
  check('address block holds only the address',
    () => /<div class="to">Corporation Tax\nHM Revenue and Customs\nBX9 1AX<\/div>/.test(html));
  check('escapes HTML in caller-supplied text',
    () => !buildHtml({ ...ok, body: ['<script>x</script>'] }).includes('<script>x'));
  check('default output lands in the attachments directory',
    () => outputPath(ok).startsWith(OUT_DIR + path.sep));

  cases.forEach(([n, pass]) => console.log((pass ? 'PASS ' : 'FAIL ') + n));
  const bad = cases.filter(([, p]) => !p).map(([n]) => n);
  if (bad.length) { console.error(`selftest FAILED: ${bad.join(', ')}`); process.exit(1); }
  console.log(`\n${cases.length} checks passed.`);
}

function arg(list, name) {
  const i = list.indexOf('--' + name);
  return i >= 0 ? list[i + 1] : null;
}

async function main() {
  const rest = process.argv.slice(2);
  if (rest.includes('--selftest')) return selftest();
  const specPath = arg(rest, 'spec');
  if (!specPath) die('--spec FILE.json is required (or --selftest)');
  let spec;
  try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
  catch (e) { die(`could not read ${specPath}: ${e.message}`); }
  validate(spec);
  const out = outputPath(spec, arg(rest, 'out'));
  await render(buildHtml(spec), out);
  console.log(JSON.stringify({
    pdf: out, bytes: fs.statSync(out).size,
    to: spec.to, addressTopMm: ADDRESS_TOP_MM, addressLeftMm: ADDRESS_LEFT_MM,
    next: `python3 scripts/send-letter.py prepare <taskId>  (checks what Pingen actually reads)`,
  }, null, 2));
}

if (require.main === module) main().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
module.exports = { buildHtml, validate, outputPath, ADDRESS_TOP_MM, ADDRESS_LEFT_MM, OUT_DIR };
