// A read path must not write.
//
// Regression origin: finding 20260820-queue-fixer-267 (20 Aug 2026).
// detectCFVs() queues tenancies back to "In Payment" in Airtable and posts an
// audit comment whenever it finds a linked payment. Two callers only wanted a
// number out of it — the sidebar badge (js/cfv.js refreshCFVSidebarBadges) and
// the AI assistant's context gather (js/ai-assistant.js) — so merely opening
// the dashboard could change a tenancy's Payment Status, and it fired twice on
// a cold load: once off the cached render, once off fresh data. The only guard
// was a localStorage flag, which another browser or a cleared cache ignores.
//
// The real source is extracted and evaluated so this cannot pass against a
// fixed copy while the shipped file regresses.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CFV = readFileSync(resolve(root, 'js/cfv.js'), 'utf8');
const AI = readFileSync(resolve(root, 'js/ai-assistant.js'), 'utf8');

function extract(src, name, file) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ${file}`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`could not parse ${name}`);
}

// One tenancy that is flagged CFV and HAS been paid — the only shape that
// reaches the auto-return queue.
const PAID_CFV = { id: 'recTen1', fields: {} };

function run(opts) {
  const returned = [];
  const scope = {
    allTenancies: [PAID_CFV],
    getPaymentStatusName: () => 'CFV',
    getField: () => null,
    getNumVal: () => 1,
    F: {},
    localStorage: { getItem: () => null, setItem: () => {} },
    isTenantStatusFormer: () => false,
    isTenantStatusActive: () => true,
    buildTenantLookup: () => ({}),
    buildTxByTenancyIndex: undefined,
    hasLinkedPaymentThisMonth: () => true,
    getTenantForTenancy: () => ({}),
    buildCFVEntry: () => ({}),
    CFV_TOLERANCE_DAYS: 2,
    cfvAutoReturnToPayment: (ids) => returned.push(...ids),
  };
  const names = Object.keys(scope);
  const fn = new Function(...names,
    `${extract(CFV, 'detectCFVs', 'js/cfv.js')}; return detectCFVs;`)(
    ...names.map((n) => scope[n]));
  const list = fn(opts);
  return { returned, list };
}

describe('detectCFVs write behaviour', () => {
  it('still auto-returns a paid tenancy by default', () => {
    // CONTROL: if this stops firing the flag has switched the feature off
    // rather than making it opt-out, and the test above proves nothing.
    expect(run(undefined).returned).toEqual(['recTen1']);
  });

  it('writes nothing when called read-only', () => {
    expect(run({ autoReturn: false }).returned).toEqual([]);
  });

  it('returns the same count either way', () => {
    expect(run({ autoReturn: false }).list.length).toBe(run(undefined).list.length);
  });
});

describe('the read-only callers actually ask for read-only', () => {
  it('the sidebar badge does', () => {
    const body = extract(CFV, 'refreshCFVSidebarBadges', 'js/cfv.js');
    expect(body).toMatch(/detectCFVs\(\s*\{\s*autoReturn:\s*false\s*\}\s*\)/);
  });

  it('the AI assistant context does', () => {
    expect(AI).toContain('detectCFVs({ autoReturn: false })');
    expect(AI, 'a bare detectCFVs() call is a write from a read path')
      .not.toMatch(/detectCFVs\(\)/);
  });
});
