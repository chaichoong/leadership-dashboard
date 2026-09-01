import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The auto tier's safe gate and the audit slice stamp share ONE function pair
// (isAutoApprovable + reconSlice). If they drifted apart, the measured "auto-slice"
// score would stop describing what the auto tier actually does — and the guardrail
// flip decision keys on that score (Agent Gate, 1 Sep 2026). So, as with
// recon-vendor-key.test.js, extract the REAL functions from js/reconciliation.js
// rather than testing a copy that can rot.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'js/reconciliation.js'), 'utf8');

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in js/reconciliation.js`);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`could not parse ${name}`);
  return src.slice(start, end);
}

// The thresholds come from the source too, so a threshold change fails loudly here
// instead of silently invalidating every expectation below.
function constLine(name) {
  const m = src.match(new RegExp(`const ${name} = [^;]+;`));
  if (!m) throw new Error(`const ${name} not found in js/reconciliation.js`);
  return m[0];
}

// isAutoApprovable reads the module-level suppression set; bind it per test so both
// the loaded and the failed-to-load states are exercised.
function buildGate(suppressSet) {
  const code = `
    ${constLine('AUTO_MIN_SCORE')}
    ${constLine('AUTO_MIN_COMPOSITE_COUNT')}
    ${extract('reconVendorKey')}
    ${extract('autoMatchCount')}
    ${extract('autoVendorKey')}
    ${extract('isAutoApprovable')}
    ${extract('reconSlice')}
    return { isAutoApprovable, reconSlice };
  `;
  return new Function('_autoSuppressSet', code)(suppressSet);
}

const goodRow = (over = {}) => ({
  status: 'suggestion', txAmount: -42.5, tenancyId: '',
  categoryId: 'catRec', subCatId: 'subRec',
  score: 9, matchType: 'Knowledge Base', txVendor: 'ONE STOP 1036',
  ...over,
});

describe('auto-tier safe gate + slice stamp (real functions from js/reconciliation.js)', () => {
  it('approves a confident outgoing Knowledge Base match, and stamps it auto-eligible', () => {
    const g = buildGate(new Set());
    expect(g.isAutoApprovable(goodRow())).toBe(true);
    expect(g.reconSlice(goodRow())).toBe('auto-eligible');
  });

  // Stress input (chain map, 1 Sep 2026): store down mid-run. A suppression list that
  // could not be read means NOTHING is auto-approvable, and the stamp under-counts
  // ('other') rather than over-claiming eligibility.
  it('fails closed when the suppression store is not loaded', () => {
    const g = buildGate(null);
    expect(g.isAutoApprovable(goodRow())).toBe(false);
    expect(g.reconSlice(goodRow())).toBe('other');
  });

  // Stress input: a direct debit reversal is a POSITIVE amount on a cost vendor.
  // Money coming in must never auto-reconcile, whatever the matcher's confidence.
  it('never auto-approves incoming money (direct debit reversal)', () => {
    const g = buildGate(new Set());
    const reversal = goodRow({ txAmount: 42.5 });
    expect(g.isAutoApprovable(reversal)).toBe(false);
    expect(g.reconSlice(reversal)).toBe('income-tenancy');
  });

  it('never auto-approves anything linked to a tenancy (rent stays manual by design)', () => {
    const g = buildGate(new Set());
    const rent = goodRow({ tenancyId: 'tenRec' });
    expect(g.isAutoApprovable(rent)).toBe(false);
    expect(g.reconSlice(rent)).toBe('income-tenancy');
  });

  // Stress input: a descriptor of pure digits produces no trusted match. Untrusted
  // matchers land the row in Kevin's pile, stamped 'other'.
  it('refuses a row with no trusted matcher (e.g. a pure-digit descriptor)', () => {
    const g = buildGate(new Set());
    const noMatch = goodRow({ matchType: '', score: 0, txVendor: '1252 2366 1148' });
    expect(g.isAutoApprovable(noMatch)).toBe(false);
    expect(g.reconSlice(noMatch)).toBe('other');
  });

  it('suppression uses the SAME vendor key as the knowledge base, so an undone vendor stays barred', () => {
    // 'ONE STOP 1036' normalises to 'one stop' (store number stripped) — the suppression
    // entry written at undo time must match the key computed at approval time.
    const g = buildGate(new Set(['one stop']));
    expect(g.isAutoApprovable(goodRow())).toBe(false);
    const other = buildGate(new Set(['some other vendor']));
    expect(other.isAutoApprovable(goodRow())).toBe(true);
  });

  it('requires a strong composite (3x+), a clearing score, and complete categorisation', () => {
    const g = buildGate(new Set());
    expect(g.isAutoApprovable(goodRow({ matchType: 'Composite (2x)' }))).toBe(false);
    expect(g.isAutoApprovable(goodRow({ matchType: 'Composite (3x)' }))).toBe(true);
    expect(g.isAutoApprovable(goodRow({ score: 7 }))).toBe(false);
    expect(g.isAutoApprovable(goodRow({ subCatId: '' }))).toBe(false);
    expect(g.isAutoApprovable(goodRow({ status: 'approved' }))).toBe(false);
  });
});
