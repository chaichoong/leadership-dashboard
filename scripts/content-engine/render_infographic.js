// render_infographic.js — HTML -> PNG (and optional multi-page PDF) with the repo's Playwright Chromium.
// Usage: node render_infographic.js IN.html OUT.png [--pdf OUT.pdf] [--width 1200 --height 1500]
// Resolves playwright from this repo's node_modules even when run from a worktree (NODE_PATH fallback).
const path = require('path');
const fs = require('fs');
function req(name) {
  try { return require(name); } catch (e) {
    const candidates = [path.resolve(__dirname, '..', '..', 'node_modules', name), '/Users/kevinbrittain/Projects/leadership-dashboard/node_modules/' + name];
    for (const c of candidates) { if (fs.existsSync(c)) return require(c); }
    throw e;
  }
}
const { chromium } = req('playwright');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [input, output] = args;
if (!input || !output) { console.error('usage: render_infographic.js IN.html OUT.png [--pdf OUT.pdf] [--width W --height H]'); process.exit(2); }
const width = Number(flag('--width', 1200)), height = Number(flag('--height', 1500)), pdf = flag('--pdf', null);
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve(input), { waitUntil: 'load' });
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch {}
  await page.waitForTimeout(800);
  await page.screenshot({ path: output, fullPage: false });
  if (pdf) await page.pdf({ path: pdf, width: width + 'px', height: height + 'px', printBackground: true, preferCSSPageSize: false });
  await browser.close();
  console.log(JSON.stringify({ png: output, pdf: pdf || null, width, height }));
})().catch((e) => { console.error(e.message); process.exit(1); });
