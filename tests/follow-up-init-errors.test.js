// Inbound Comms startup must never lose a failure to an unhandled rejection.
//
// Regression origin: 9 Aug 2026. showApp() called fetchLabels(), fetchSendAsAliases(),
// syncFromCloud(), refreshAccuracyFromCloud() and purgeOldAccuracyRecords() bare, and
// scheduleLabelCountRefresh() called refreshLabelCounts() bare inside a setTimeout.
// Every one is `async`, so a rejection had nowhere to go: no toast, no error state,
// and a page that renders with no labels or a stale accuracy figure while looking
// perfectly healthy. CLAUDE.md forbids a catch that swallows an error; a MISSING
// catch is the same defect with no message at all.
//
// Two halves, because either alone would pass through the bug:
//   1. bg() really does catch — both a rejected promise and a synchronous throw.
//   2. showApp() actually routes the async jobs through it.
//
// The real source is extracted and evaluated (the tests/prospect-email.test.js
// pattern) so this can never pass against a stale copy.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../follow-up.html'), 'utf8');

function extract(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in follow-up.html`);
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`could not parse ${name}`);
}

// The async startup jobs. Each one is fire-and-forget, so each one needs a catch.
const ASYNC_INIT = [
  'fetchLabels',
  'fetchSendAsAliases',
  'syncFromCloud',
  'refreshAccuracyFromCloud',
  'purgeOldAccuracyRecords',
];

function loadBg() {
  const errors = [];
  // eslint-disable-next-line no-new-func
  const factory = new Function('showError', `${extract('bg')}; return bg;`);
  return { bg: factory((m) => errors.push(m)), errors };
}

describe('follow-up.html bg()', () => {
  it('reports a rejected promise instead of leaving it unhandled', async () => {
    const { bg, errors } = loadBg();
    bg('Loading labels', () => Promise.reject(new Error('gapi 401')));
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Loading labels');
    expect(errors[0]).toContain('gapi 401');
  });

  it('reports a synchronous throw too', () => {
    const { bg, errors } = loadBg();
    bg('Cloud sync', () => { throw new Error('boom'); });
    expect(errors[0]).toContain('Cloud sync');
    expect(errors[0]).toContain('boom');
  });

  it('stays silent on success', async () => {
    const { bg, errors } = loadBg();
    bg('Loading labels', () => Promise.resolve('ok'));
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual([]);
  });

  it('tolerates a non-promise return (a job that was never async)', () => {
    const { bg, errors } = loadBg();
    expect(() => bg('Sync thing', () => 42)).not.toThrow();
    expect(errors).toEqual([]);
  });
});

describe('follow-up.html startup wiring', () => {
  const showApp = extract('showApp');

  for (const fn of ASYNC_INIT) {
    it(`showApp routes ${fn} through bg()`, () => {
      expect(showApp).toContain(`bg('`);
      // A bare `fetchLabels();` call is the exact bug. Only the bg(...) reference
      // may name it.
      expect(showApp).not.toMatch(new RegExp(`(^|[^.\\w])${fn}\\s*\\(`, 'm'));
      expect(showApp).toMatch(new RegExp(`bg\\('[^']+',\\s*${fn}\\s*\\)`));
    });
  }

  it('the debounced label-count refresh is caught as well', () => {
    const scheduler = extract('scheduleLabelCountRefresh');
    expect(scheduler).toMatch(/bg\('[^']+',\s*refreshLabelCounts\s*\)/);
    expect(scheduler).not.toMatch(/(^|[^.\w'])refreshLabelCounts\s*\(\s*\)/m);
  });
});
