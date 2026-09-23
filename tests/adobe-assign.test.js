// Guards adobe-assign.js's final check (23 Sep 2026).
//
// WHAT THIS EXISTS FOR
// On 23 Sep 2026 adobe-assign.js reported ok on a tenancy agreement whose
// landlord date box was still on the TENANT. The script had moved the box in
// the open page and read it back there, and the page was right: the box had
// moved. Adobe had not SAVED it. Adobe saves a draft once changes go quiet,
// and the old read-back clicked a box every 3 seconds straight after the last
// move, then closed the browser. Reproduced twice on a live test draft.
//
// The check now reloads the draft and reads every owner off the saved copy,
// by colour: each box carries its owner's colour (fill, and an `outline`
// attribute while unselected), and each recipient row is painted the same
// colour. These tests drive that reader against a page built to Adobe's
// measured layout, and the verdict against the 23 Sep case.
import { describe, it, expect, beforeAll } from 'vitest';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require_('playwright-core')); } catch { /* reported below */ }

let mod;
beforeAll(() => { mod = require_(join(ROOT, 'scripts/adobe-assign.js')); });

const AGILE = 'info@agilelets.co.uk';
const TENANT = 'tenant@example.com';
const SIGNERS = [AGILE, TENANT];
const SIG = (n) => `signature-form-field, Signature Field ${n}`;
const DTE = (n) => `date-of-signing-form-field, Date of Signing ${n}`;
const EXPECTED = [SIG(1), DTE(1), SIG(2), DTE(2)];
// --fields blocks:2,1 on a two-signer agreement: tenant's block first on the page.
const MAP = [2, 2, 1, 1];
const PURPLE = [126, 75, 243]; // Agile Lets, the first recipient, as measured
const GREEN = [80, 166, 94];   // the tenant, as measured
const hex = (c) => c.map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();

/**
 * A page in Adobe's measured shape: two recipient rows with their painted
 * swatch, and four boxes with data-fieldid, aria-label, an outline attribute
 * and a fill. `boxes` lists [label, colour, { selected, y }] per box.
 */
function adobePage(boxes, { rows = [[AGILE + ' (myself)', PURPLE], [TENANT, GREEN]] } = {}) {
  const rowHtml = rows.map(([text, c], i) => `
    <div data-testid="recipient-list-item-${i}">
      <div data-testid="recipient-item-wrapper-${i}" style="background: rgba(${c.join(',')}, 0.063)">${text}</div>
    </div>`).join('');
  const boxHtml = boxes.map(([label, c, opt = {}], i) => {
    const selected = !!opt.selected;
    const outline = selected ? '3px solid #2680eb' : `1px solid #${hex(c)}`;
    return `<div data-testid="${selected ? 'highlighted-' : ''}authoring-field" data-fieldid="f-${i}"
      aria-label="${label}" outline="${outline}" selectionoutline="3px solid #${selected ? '2680eb' : hex(c)}"
      style="position:absolute; left:420px; top:${opt.y ?? 300 + i * 40}px; width:240px; height:30px;
             background: rgba(${c.join(',')}, ${opt.alpha ?? 0.3})"></div>`;
  }).join('');
  return `<!doctype html><meta charset="utf-8"><div style="width:280px">${rowHtml}</div>${boxHtml}`;
}

async function readAndJudge(html) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    const saved = await page.evaluate(mod.readOwnersInPage, mod.SEL);
    return mod.judgeSavedDraft({ map: MAP, expected: EXPECTED, saved: saved.fields,
                                 recipients: saved.recipients, signers: SIGNERS });
  } finally {
    await browser.close();
  }
}

describe('judgeSavedDraft — the 23 Sep 2026 false pass', () => {
  const rows = [{ text: AGILE + ' (myself)', colour: '7e4bf3' }, { text: TENANT, colour: '50a65e' }];
  const box = (label, c) => ({ label, outline: c, fill: c });

  it('refuses the draft as Kevin found it: the landlord date box on the tenant', () => {
    const saved = [box(SIG(1), '50a65e'), box(DTE(1), '50a65e'), box(SIG(2), '7e4bf3'), box(DTE(2), '50a65e')];
    const v = mod.judgeSavedDraft({ map: MAP, expected: EXPECTED, saved, recipients: rows, signers: SIGNERS });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/field 4 \(date\) is on tenant@example\.com in the saved draft, but it belongs to info@agilelets\.co\.uk/);
  });

  it('passes the draft once the box is really on Agile Lets, and names each owner', () => {
    const saved = [box(SIG(1), '50a65e'), box(DTE(1), '50a65e'), box(SIG(2), '7e4bf3'), box(DTE(2), '7e4bf3')];
    const v = mod.judgeSavedDraft({ map: MAP, expected: EXPECTED, saved, recipients: rows, signers: SIGNERS });
    expect(v).toEqual({ ok: true, unproven: 0, owners: [TENANT, TENANT, AGILE, AGILE] });
  });

  it('never takes an unproven signature or date box as a pass', () => {
    const saved = [box(SIG(1), '50a65e'), box(DTE(1), '50a65e'), box(SIG(2), '7e4bf3'), { label: DTE(2), outline: null, fill: null }];
    const v = mod.judgeSavedDraft({ map: MAP, expected: EXPECTED, saved, recipients: rows, signers: SIGNERS });
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/field 4 \(date\) should be info@agilelets\.co\.uk's, but the saved draft does not prove who owns it/);
  });
});

describe.skipIf(!chromium)('readOwnersInPage on a page shaped like Adobe', () => {
  it('reads a correct draft as correct', async () => {
    const v = await readAndJudge(adobePage([[SIG(1), GREEN], [DTE(1), GREEN], [SIG(2), PURPLE], [DTE(2), PURPLE]]));
    expect(v).toEqual({ ok: true, unproven: 0, owners: [TENANT, TENANT, AGILE, AGILE] });
  });

  it('refuses the 23 Sep draft: landlord date box painted in the tenant colour', async () => {
    const v = await readAndJudge(adobePage([[SIG(1), GREEN], [DTE(1), GREEN], [SIG(2), PURPLE], [DTE(2), GREEN]]));
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/field 4 \(date\) is on tenant@example\.com/);
  });

  it('ignores the fill strength: 0.06 and 0.3 of one colour are the same owner', async () => {
    // Adobe paints the active recipient's boxes at 0.3 and the others at 0.06.
    // The old check read those tints; the owner is the colour, not the strength.
    const v = await readAndJudge(adobePage([[SIG(1), GREEN, { alpha: 0.06 }], [DTE(1), GREEN, { alpha: 0.06 }],
                                            [SIG(2), PURPLE], [DTE(2), PURPLE]]));
    expect(v.ok).toBe(true);
  });

  it('refuses a box that is still selected rather than reading the selection tint', async () => {
    const v = await readAndJudge(adobePage([[SIG(1), GREEN], [DTE(1), GREEN], [SIG(2), PURPLE],
                                            [DTE(2), PURPLE, { selected: true }]]));
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/field 4 \(date\) .*does not prove who owns it/);
  });

  it('orders boxes down the page, not in DOM order', async () => {
    // Adobe numbered date boxes against their visual order once. Put the
    // landlord's boxes FIRST in the DOM but lowest on the page.
    const v = await readAndJudge(adobePage([
      [SIG(2), PURPLE, { y: 420 }], [DTE(2), PURPLE, { y: 460 }],
      [SIG(1), GREEN, { y: 300 }], [DTE(1), GREEN, { y: 340 }],
    ]));
    expect(v.ok).toBe(true);
  });

  it('refuses when the recipient list carries no colour to trace a box to', async () => {
    const html = adobePage([[SIG(1), GREEN], [DTE(1), GREEN], [SIG(2), PURPLE], [DTE(2), PURPLE]])
      .replace(/data-testid="recipient-item-wrapper-1" style="[^"]*"/, 'data-testid="recipient-item-wrapper-1"');
    const v = await readAndJudge(html);
    expect(v.ok).toBe(false);
    expect(v.why).toMatch(/does not show one colour for tenant@example\.com/);
  });
});

describe.skipIf(!chromium)('boxHandle aims at the placed box, not Adobe\'s hint', () => {
  // 23 Sep 2026, authority to act: Adobe draws a "detected-field" hint at the
  // same spot as each placed box, earlier in the page and underneath it. The
  // old finder clicked the i-th element ending "-field", which was the hint;
  // the click timed out and the landlord's date box "would not open its menu".
  it('finds each box by its id and a click lands on it, even below the fold', async () => {
    const tops = [300, 700, 740, 830, 870];
    const at = (y) => `position:absolute; left:420px; top:${y}px; width:240px; height:30px;`;
    const hints = tops.map((y) => `<div data-testid="detected-field" style="${at(y)} z-index:1"></div>`).join('');
    const boxes = tops.map((y, i) => `<div data-testid="authoring-field" data-fieldid="f-${i}"
      style="${at(y)} z-index:2" onclick="window.hits.push('f-${i}')">
      <div data-testid="date-of-signing-field" style="width:100%;height:100%"></div></div>`).join('');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.setContent(`<!doctype html><script>window.hits=[]</script><div style="height:1400px">${hints}${boxes}</div>`);
      const h = await mod.boxHandle(page, 'f-4');
      expect(await h.getAttribute('data-testid')).toBe('authoring-field');
      await h.click({ timeout: 3000 });
      expect(await page.evaluate(() => window.hits)).toEqual(['f-4']);
      expect(await mod.boxHandle(page, 'f-9')).toBeNull();
    } finally {
      await browser.close();
    }
  });

  it('refuses an id it cannot put in a selector safely', async () => {
    await expect(mod.boxHandle(null, 'x"] , [onclick')).rejects.toThrow(/ASSIGN REFUSED: .*cannot be addressed safely/);
  });
});

describe('the save Adobe makes is recognised', () => {
  it('matches the PUT seen on 23 Sep 2026 and nothing on another host', () => {
    expect(mod.SAVE_RE.test('https://dc-api-v2.adobe.io/1790816280/assets?asset_uri=https%3A%2F%2Fdc-api-v2.adobe.io')).toBe(true);
    // Adobe polls the asset's metadata around a save; that is not the save.
    expect(mod.SAVE_RE.test('https://dc-api-v2.adobe.io/1790816280/assets/urn:aaid:sc:EU:66d8/metadata')).toBe(false);
    expect(mod.SAVE_RE.test('https://evil.example.com/dc-api.adobe.io/x/assets')).toBe(false);
  });
});
