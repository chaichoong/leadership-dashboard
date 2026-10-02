#!/usr/bin/env node
// RENDER STRATEGY PLAN — one Objective & Strategy record as a PDF, in the
// app's own export layout.
//
// WHY THIS EXISTS. The first strategy session run in chat (Q4 2026) wrote the
// plan to Airtable and ended. Kevin never saw the finished plan: the page's
// "Export PDF" button needs a signed-in browser, and the browser on the
// robots' Mac was not reachable. This renders the same layout without one.
//
// It does NOT carry its own layout. It lifts buildPrintableDocument out of
// os/strategy/strategy.js and runs it, so the page and this PDF cannot drift
// (tests/strategy-session-skill.test.js drives it against a fixture).
//
// USAGE
//   node scripts/render-strategy-plan.cjs --record <recId> --out "<folder>"
//
// The output folder must be OUTSIDE this repo: the repo is public and the plan
// names tenants and money. Reads the PAT from ~/.config/od/airtable_pat.

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const os = require('os');

const REPO = path.resolve(__dirname, '..');
const BASE_ID = 'appnqjDpqDniH3IRl';
const OBJSTRAT_TABLE = 'tblEBvFw8DonwxzGh';

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Runs the page's own export function. `fieldsById` is the record's fields
// keyed by field id (returnFieldsByFieldId=true), the same shape the page
// reads off its form.
function renderPlanHtml(fieldsById, businessName, quarter, year) {
    const src = fs.readFileSync(path.join(REPO, 'os/strategy/strategy.js'), 'utf8');
    const start = src.indexOf('function buildPrintableDocument');
    const end = src.indexOf('\n}\n', start);
    if (start < 0 || end < 0) throw new Error('buildPrintableDocument not found in os/strategy/strategy.js');
    const ctx = { document: { createElement: () => ({}) }, console, escapeHtml,
        localStorage: { getItem: () => null }, navigator: {}, location: { hostname: '', search: '' } };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(REPO, 'js/config.js'), 'utf8'), ctx);
    vm.runInContext(src.slice(start, end + 3) + '\nthis.__build = buildPrintableDocument;', ctx);
    const root = ctx.__build(fieldsById, businessName, quarter, String(year));
    const title = escapeHtml(`${businessName} ${quarter} ${year} objective and strategy plan`);
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>`
        + '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">'
        + '<style>body{margin:0;background:#fff;color:#1C2422;font-family:"DM Sans",system-ui,sans-serif}.wrap{max-width:794px;margin:0 auto}</style>'
        + `</head><body><div class="wrap"><div class="pdf-root">${root.innerHTML}</div></div></body></html>`;
}

async function airtableGet(pat, query) {
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${OBJSTRAT_TABLE}/${query}`, { headers: { Authorization: `Bearer ${pat}` } });
    if (!res.ok) throw new Error(`Airtable read failed: ${res.status}`);
    return res.json();
}

async function main(argv) {
    const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
    const recId = arg('--record');
    const outDir = arg('--out');
    if (!recId || !outDir) { console.error('usage: render-strategy-plan.cjs --record <recId> --out "<folder outside the repo>"'); return 1; }
    const outAbs = path.resolve(outDir);
    if (outAbs === REPO || outAbs.startsWith(REPO + path.sep)) {
        console.error('REFUSED: the output folder is inside the public repo. Use the business\'s private project folder.');
        return 1;
    }
    if (!fs.existsSync(outAbs)) { console.error(`output folder does not exist: ${outAbs}`); return 1; }

    const pat = fs.readFileSync(path.join(os.homedir(), '.config/od/airtable_pat'), 'utf8').trim();
    // Two reads, one key style each: ids for the layout, names for the title.
    const byId = await airtableGet(pat, `${recId}?returnFieldsByFieldId=true`);
    const byName = (await airtableGet(pat, recId)).fields;
    const business = byName['Business Name'], quarter = byName['Quarter'], year = byName['Year'];
    if (!business || !quarter || !year) { console.error('record has no Business Name, Quarter or Year: is this an Objective and Strategy record?'); return 1; }

    const html = renderPlanHtml(byId.fields, business, quarter, year);
    const sections = (html.match(/<h2>[^<]+/g) || []).map(s => s.slice(4));
    if (!sections.includes('Quarterly Priority Projects')) { console.error('REFUSED: the plan has no quarterly projects, so there is nothing finished to show.'); return 1; }

    const base = path.join(outAbs, `${business} ${quarter} ${year} objective and strategy plan`);
    fs.writeFileSync(base + '.html', html);
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.goto('file://' + base + '.html', { waitUntil: 'networkidle' });
        await page.pdf({ path: base + '.pdf', format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '18mm', left: '14mm', right: '14mm' } });
    } finally { await browser.close(); }
    console.log(JSON.stringify({ pdf: base + '.pdf', sections }));
    return 0;
}

module.exports = { renderPlanHtml };
if (require.main === module) main(process.argv.slice(2)).then(c => process.exit(c), e => { console.error(e.message); process.exit(1); });
