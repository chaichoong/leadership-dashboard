// The dropdown step chooses by what the page SHOWS (25 Sep 2026). The 6
// Chedburgh Place agent got AXA's quote form one field short: it wrote
// "Terraced" and then "House" for the property type, Playwright wanted the
// option's exact value code or exact label, and the step failed with no clue
// which options existed. Drives the real runSteps against a real Chromium page.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require_('playwright-core')); } catch { /* reported below */ }
const mod = require_(join(ROOT, 'scripts/agent-browser.js'));

let dir, pagePath;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-select-'));
  pagePath = join(dir, 'form.html');
  // The shape of an insurer's form: a placeholder, value codes that are not the words.
  writeFileSync(pagePath, `<!doctype html><html><body>
    <label for="type">What type of property is it?</label>
    <select id="type"><option value="">Please select</option>
      <option value="PT01">Terraced house</option><option value="PT02">Semi-detached  house</option>
      <option value="PT03">Detached house</option><option value="PT04">Flat</option></select>
    <div id="fancy" role="combobox">Choose…</div>
  </body></html>`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('pickOption', () => {
  const opts = [{ value: '', label: 'Please select' }, { value: 'PT01', label: 'Terraced house' },
    { value: 'PT02', label: 'Semi-detached house' }, { value: 'PT04', label: 'Flat' }];
  it('takes the value code, the label in any case, or the one label containing the words', () => {
    expect(mod.pickOption(opts, 'PT02').option.value).toBe('PT02');
    expect(mod.pickOption(opts, 'flat').option.value).toBe('PT04');
    expect(mod.pickOption(opts, 'Terraced').option.value).toBe('PT01');   // the agent's own word on 25 Sep
  });
  it('never guesses between two matches, and says when nothing matches', () => {
    expect(mod.pickOption(opts, 'house')).toMatchObject({ option: null, why: '"house" matches 2 options; name one exactly.' });
    expect(mod.pickOption(opts, 'Bungalow')).toMatchObject({ option: null, why: 'no option matches "Bungalow".' });
  });
});

describe('select step (real Playwright)', () => {
  it('chooses by the label shown, and a miss lists every option', async () => {
    expect(chromium, 'playwright-core is not installed').toBeTruthy();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto('file://' + pagePath);
      await mod.runSteps(page, [{ do: 'select', selector: '#type', value: 'Terraced' }], false);
      expect(await page.locator('#type').inputValue()).toBe('PT01');
      await mod.runSteps(page, [{ do: 'select', selector: '#type', label: 'semi-detached house' }], false);
      expect(await page.locator('#type').inputValue()).toBe('PT02');
      const miss = await mod.runSteps(page, [{ do: 'select', selector: '#type', value: 'House' }], false).catch(e => e);
      expect(String(miss.message)).toMatch(/"House" matches 3 options; name one exactly\. Options: "Please select" \[\] \| "Terraced house" \[PT01\]/);
      const fancy = await mod.runSteps(page, [{ do: 'select', selector: '#fancy', value: 'Flat' }], false).catch(e => e);
      expect(String(fancy.message)).toMatch(/is not a <select> but a styled dropdown/);
    } finally {
      await browser.close();
    }
  }, 60000);
});
