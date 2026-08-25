import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// The CEO Brief render lives on the AI Agents page (os/agents/index.html),
// which cannot load js/config.js and so carries its own copy of the CEO
// Briefs table and field IDs (the CEOB block). config.js stays the drift
// monitor's source of truth. If the two copies disagree, the agents page
// reads the wrong fields while the monitor watches the right ones — the
// silent-rename failure the 2026-07-29 field-ID migration exists to prevent.

const CONFIG = read('js/config.js');
const AGENTS_PAGE = read('os/agents/index.html');

function configId(key) {
  const m = CONFIG.match(new RegExp(`${key}:\\s*'(fld[A-Za-z0-9]+)'`));
  if (!m) throw new Error(`${key} not found in js/config.js`);
  return m[1];
}

function ceobBlock() {
  const m = AGENTS_PAGE.match(/const CEOB = \{([\s\S]*?)\};/);
  if (!m) throw new Error('CEOB block not found in os/agents/index.html');
  return m[1];
}

function ceobId(key) {
  const m = ceobBlock().match(new RegExp(`${key}:\\s*'(fld[A-Za-z0-9]+)'`));
  if (!m) throw new Error(`CEOB.${key} not found in os/agents/index.html`);
  return m[1];
}

describe('CEO Brief IDs on the agents page match js/config.js', () => {
  it('table id matches TABLES.ceoBriefs', () => {
    const cfg = CONFIG.match(/ceoBriefs:\s*'(tbl[A-Za-z0-9]+)'/);
    const page = AGENTS_PAGE.match(/const CEOB_TBL = '(tbl[A-Za-z0-9]+)'/);
    expect(cfg, 'TABLES.ceoBriefs in config.js (control)').not.toBeNull();
    expect(page, 'CEOB_TBL on the agents page (control)').not.toBeNull();
    expect(page[1]).toBe(cfg[1]);
  });

  const PAIRS = [
    ['date', 'ceoDate'],
    ['oneThing', 'ceoOneThing'],
    ['firstStep', 'ceoFirstStep'],
    ['why', 'ceoWhy'],
    ['ignoreToday', 'ceoIgnoreToday'],
    ['boardFlags', 'ceoBoardFlags'],
    ['handedOff', 'ceoHandedOff'],
    ['moneyLight', 'ceoMoneyLight'],
    ['safeToAct', 'ceoSafeToAct'],
    ['fullBrief', 'ceoFullBrief'],
  ];

  it.each(PAIRS)('CEOB.%s matches F.%s', (pageKey, configKey) => {
    expect(ceobId(pageKey)).toBe(configId(configKey));
  });

  it('the Playwright fixture helper carries the same ids', () => {
    // agents-page.helpers.js feeds the render specs; a stale fixture key
    // would let the tab regress while the specs stay green.
    const helper = read('tests/sync-invariants/agents-page.helpers.js');
    // Scope to the CEO block — a bare key search would hit ALOG.date first.
    const block = helper.match(/const CEO = \{([\s\S]*?)\};/);
    expect(block, 'CEO block in agents-page.helpers.js (control)').not.toBeNull();
    for (const [pageKey, configKey] of PAIRS) {
      const m = block[1].match(new RegExp(`${pageKey}:\\s*'(fld[A-Za-z0-9]+)'`));
      expect(m, `CEO.${pageKey} in agents-page.helpers.js`).not.toBeNull();
      expect(m[1]).toBe(configId(configKey));
    }
  });
});
