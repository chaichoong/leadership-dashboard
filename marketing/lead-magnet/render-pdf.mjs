// Wraps the rendered PNG in a single A4 page PDF. The canvas is 1240x1754 px, which is the A4 ratio (1:1.414),
// so the picture fills the page edge to edge with no scaling artefacts.
// Usage: node render-pdf.mjs from-12-staff-to-0.png from-12-staff-to-0.pdf
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [png, pdf] = process.argv.slice(2);
if (!png || !pdf) { console.error('Usage: node render-pdf.mjs input.png output.pdf'); process.exit(1); }
const data = readFileSync(resolve(png)).toString('base64');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; }
  img { display: block; width: 210mm; height: 297mm; }
</style></head><body><img src="data:image/png;base64,${data}"></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.pdf({ path: resolve(pdf), format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
await browser.close();
console.log('wrote', pdf);
