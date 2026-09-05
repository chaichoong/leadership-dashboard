// Wraps one or more rendered PNGs into an A4 PDF, one page per image, in the order given. Each canvas is
// 1240x1754 px, the A4 ratio (1:1.414), so every picture fills its page edge to edge with no scaling artefacts.
// Usage: node render-pdf.mjs output.pdf page1.png [page2.png ...]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [pdf, ...pngs] = process.argv.slice(2);
if (!pdf || !pngs.length) { console.error('Usage: node render-pdf.mjs output.pdf page1.png [page2.png ...]'); process.exit(1); }
const pages = pngs.map((p) => {
  const data = readFileSync(resolve(p)).toString('base64');
  return `<div class="page"><img src="data:image/png;base64,${data}"></div>`;
}).join('');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; }
  .page { width: 210mm; height: 297mm; page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  img { display: block; width: 210mm; height: 297mm; }
</style></head><body>${pages}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.pdf({ path: resolve(pdf), format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
await browser.close();
console.log('wrote', pdf, 'with', pngs.length, 'page(s)');
