#!/usr/bin/env node
/**
 * make-document.js — render a multi-page document (a tenancy agreement, a side
 * letter, an authority) to an A4 PDF an agent can put into Adobe Sign.
 *
 * WHY THIS EXISTS (10 Sep 2026)
 * -----------------------------
 * `make-letter.js` is a LETTER generator: it demands a three-line recipient
 * address and pins it at 64mm because Pingen reads the envelope window off the
 * page. A tenancy agreement has no envelope, no address block and nineteen
 * numbered clauses over six pages, so that generator refuses it outright.
 *
 * Adobe Acrobat Sign's API is not available on Kevin's plan (see
 * project_letters_and_esignature), so documents reach Adobe as PDFs through the
 * browser. Something has to make the PDF. This does, from the Markdown
 * templates that already live in the brain vault, with no new dependency:
 * Chromium is already installed for Playwright and prints real typography.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * No signature-field placement. Adobe owns that, either from a template or from
 * Auto-place. A PDF that draws its own signature boxes just confuses it.
 *
 * SPEC (JSON, or `-` for stdin)
 *   {
 *     "title":     "Assured shorthold tenancy agreement",   // page 1 heading
 *     "reference": "6 Chedburgh Place",                     // small line under it
 *     "markdown":  "## 1. DEFINITIONS\n...",                // the body
 *     "footer":    "6 Chedburgh Place - joint tenancy",     // repeated on every page
 *     "name":      "AST_Joint_6_Chedburgh_Place"            // output filename stem
 *   }
 *
 * USAGE
 *   node scripts/make-document.js --spec doc.json [--out FILE.pdf]
 *   node scripts/make-document.js --selftest
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT_DIR = path.join(os.homedir(), 'knowledge-os', 'attachments');

function die(msg) { console.error('make-document: ' + msg); process.exit(1); }

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Inline: **bold**, _italic_, and a run of underscores as a fill-in rule.
function inline(text) {
  let s = esc(text);
  s = s.replace(/_{6,}/g, '<span class="fill"></span>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|\s)_(?!_)(.+?)_(?=\s|[.,;:!?)]|$)/g, '$1<em>$2</em>');
  return s;
}

// A deliberately small Markdown subset: the templates in the vault use headings,
// paragraphs, bullet and numbered lists, pipe tables and horizontal rules. A full
// parser would be a dependency and a liability for a document that gets signed.
function markdownToHtml(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const flushPara = (buf) => { if (buf.length) { out.push(`<p>${inline(buf.join(' '))}</p>`); buf.length = 0; } };
  const para = [];
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { flushPara(para); i++; continue; }
    if (/^---+$/.test(t)) { flushPara(para); out.push('<hr>'); i++; continue; }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara(para);
      const level = Math.min(h[1].length + 1, 4);   // "#" in a template is a section, not a page title
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++; continue;
    }
    if (t.startsWith('|')) {                         // pipe table
      flushPara(para);
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i++; }
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r));
      const head = body.shift();
      out.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
        body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>');
      continue;
    }
    const bullet = t.match(/^[-*]\s+(.*)$/);
    const numbered = t.match(/^(\d+)\.\s+(.*)$/);
    if (bullet || numbered) {
      flushPara(para);
      const tag = bullet ? 'ul' : 'ol';
      const items = [];
      while (i < lines.length) {
        const m = lines[i].trim().match(bullet ? /^[-*]\s+(.*)$/ : /^\d+\.\s+(.*)$/);
        if (!m) break;
        items.push(`<li>${inline(bullet ? m[1] : m[1])}</li>`);
        i++;
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }
    // A clause line ("4.1.3. To notify...") keeps its number and hangs its wrap.
    if (/^\d+(\.\d+)*\.\s/.test(t)) { flushPara(para); out.push(`<p class="clause">${inline(t)}</p>`); i++; continue; }
    para.push(t); i++;
  }
  flushPara(para);
  return out.join('\n');
}

function buildHtml(spec) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm 18mm 20mm 18mm; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "DM Sans", -apple-system, Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #000; }
  h1 { font-size: 15pt; margin: 0 0 2mm; }
  h2 { font-size: 11.5pt; margin: 6mm 0 2mm; page-break-after: avoid; }
  h3 { font-size: 10.5pt; margin: 4mm 0 1.5mm; page-break-after: avoid; }
  .ref { font-size: 9.5pt; color: #333; margin: 0 0 6mm; }
  p { margin: 0 0 2.4mm; }
  p.clause { padding-left: 8mm; text-indent: -8mm; }
  ul, ol { margin: 0 0 2.6mm; padding-left: 7mm; }
  li { margin: 0 0 1.2mm; }
  hr { border: 0; border-top: 1px solid #bbb; margin: 6mm 0; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 3mm; font-size: 9.5pt; }
  th, td { border: 1px solid #999; padding: 1.4mm 2mm; text-align: left; vertical-align: top; }
  th { background: #eee; }
  .fill { display: inline-block; min-width: 55mm; border-bottom: 1px solid #000; }
  strong { font-weight: 600; }
  </style></head><body>
  ${spec.title ? `<h1>${esc(spec.title)}</h1>` : ''}
  ${spec.reference ? `<div class="ref">${esc(spec.reference)}</div>` : ''}
  ${markdownToHtml(spec.markdown || '')}
  </body></html>`;
}

async function render(html, outPath, footer) {
  let chromium;
  for (const mod of ['playwright-core', '@playwright/test',
                     path.join(path.resolve(__dirname, '..'), 'node_modules', 'playwright-core')]) {
    try { ({ chromium } = require(mod)); break; } catch { /* try the next */ }
  }
  if (!chromium) die('playwright not found. Run npm install in the repo.');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.pdf({
      path: outPath, format: 'A4', printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font-size:7pt;color:#666;padding:0 18mm;display:flex;justify-content:space-between">
        <span>${esc(footer || '')}</span><span class="pageNumber"></span></div>`,
      margin: { top: '18mm', right: '18mm', bottom: '20mm', left: '18mm' },
    });
  } finally {
    await browser.close();
  }
  return outPath;
}

function validate(spec) {
  if (!spec || typeof spec !== 'object') die('spec must be a JSON object');
  if (!spec.markdown || !String(spec.markdown).trim()) die('`markdown` is required and must not be empty');
  // A document that still carries a template placeholder is a document that goes
  // out with "[Tenant Name]" on it. Refuse before anything is written.
  const holes = String(spec.markdown).match(/\[[A-Za-z][^\]\n]{2,40}\]/g);
  if (holes && !spec.allowPlaceholders) {
    die('the document still has unfilled placeholders: ' + Array.from(new Set(holes)).slice(0, 8).join(', ') +
        '\n       fill them, or pass "allowPlaceholders": true if this is a blank template for Adobe.');
  }
}

async function selftest() {
  const checks = [];
  const check = (name, fn) => { try { fn(); checks.push(['ok', name]); } catch (e) { checks.push(['FAIL', name + ': ' + e.message]); } };
  const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
  const has = (h, n, m) => { if (!String(h).includes(n)) throw new Error(`${m || ''} missing ${JSON.stringify(n)}`); };

  check('headings drop one level so "#" is a section, not a page title',
    () => has(markdownToHtml('# TITLE\n'), '<h2>TITLE</h2>'));
  check('a numbered clause keeps its number and hangs',
    () => has(markdownToHtml('4.1.3. To notify the suppliers.'), '<p class="clause">4.1.3. To notify the suppliers.</p>'));
  check('a numbered LIST is still a list',
    () => has(markdownToHtml('1. First\n2. Second'), '<ol><li>First</li><li>Second</li></ol>'));
  check('bullets become a list', () => has(markdownToHtml('- one\n- two'), '<ul><li>one</li><li>two</li></ul>'));
  check('a pipe table renders with a header row', () => {
    const h = markdownToHtml('| Method | Deemed |\n| :--- | :--- |\n| Post | Second day |');
    has(h, '<th>Method</th>'); has(h, '<td>Second day</td>');
  });
  check('a run of underscores becomes a signature rule',
    () => has(markdownToHtml('Signed: ______________________ Kevin'), '<span class="fill"></span>'));
  check('bold survives', () => has(markdownToHtml('**Council tax.** The Tenants'), '<strong>Council tax.</strong>'));
  check('html in the source is escaped, never executed',
    () => has(markdownToHtml('<script>alert(1)</script>'), '&lt;script&gt;'));
  check('unfilled placeholders are refused', () => {
    const orig = process.exit; let code = null;
    process.exit = (c) => { code = c; throw new Error('exited'); };
    try { validate({ markdown: 'To [Tenant Name] of [Property address]' }); } catch (e) { /* expected */ }
    process.exit = orig;
    eq(code, 1, 'should have exited 1');
  });
  check('a filled document passes', () => validate({ markdown: 'To Mark Peters of 6 Chedburgh Place' }));
  check('a blank template passes when asked for',
    () => validate({ markdown: 'To [Tenant Name]', allowPlaceholders: true }));

  const bad = checks.filter(([s]) => s !== 'ok');
  checks.forEach(([s, n]) => console.log(`${s === 'ok' ? '  ok  ' : ' FAIL '} ${n}`));
  console.log(`${checks.length - bad.length}/${checks.length} passed`);
  process.exit(bad.length ? 1 : 0);
}

async function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const specArg = argv[argv.indexOf('--spec') + 1];
  if (!argv.includes('--spec') || !specArg) die('usage: make-document.js --spec FILE.json|- [--out FILE.pdf]');
  const raw = specArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(specArg, 'utf8');
  let spec;
  try { spec = JSON.parse(raw); } catch (e) { die('spec is not valid JSON: ' + e.message); }
  validate(spec);
  const stem = String(spec.name || spec.title || 'document').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(OUT_DIR, stem + '.pdf');
  await render(buildHtml(spec), out, spec.footer);
  console.log(JSON.stringify({ pdf: out, bytes: fs.statSync(out).size, title: spec.title || null }));
}

main(process.argv.slice(2)).catch((e) => die(e.message));
