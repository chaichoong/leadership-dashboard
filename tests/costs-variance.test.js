import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// ── Costs variance: monthly-equivalent vs per-occurrence ─────────────────────
//
// The bug this guards against, in Kevin's own numbers:
//
//   Evernote is billed Annually. Its Expected Cost is stored as a MONTHLY-
//   equivalent (£6.25/mo) — that is the contract the Leadership Dashboard and the
//   cash flow forecast both rely on (both SUM Expected Cost as a monthly figure).
//   The reconciled payment, though, is the real annual charge that cleared: £104.99.
//   The old variance check compared £104.99 against £6.25 directly and reported a
//   1580% "hard" variance. Every annual, quarterly and weekly bill lit up red for a
//   reason that was pure units mismatch, drowning the genuine rate rises.
//
// The fix converts Expected Cost UP to the real per-occurrence charge before
// comparing (expectedChargePerOccurrence), so an annual bill is measured annual-to-
// annual. £104.99 vs the £75 annual equivalent is ~40%, not 1580%.
//
// Loaded against the REAL js/costs.js so a future edit that drops the conversion
// fails here. costs.js is top-level function declarations (no ES module to import),
// so we run it in a vm and hoist the pure helpers, exactly as the other suites do.

function loadCosts() {
  const sandbox = {
    window: {}, document: { getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ style: {} }) },
    console, Math, Date, Number, String, Object, Array, Set, JSON, isNaN, isFinite, parseFloat, parseInt,
  };
  vm.createContext(sandbox);
  vm.runInContext(read('js/costs.js'), sandbox);
  // Top-level `const`/`function` live in the script's lexical scope, not on the
  // context object. A follow-up script in the same context can still see them.
  vm.runInContext(`Object.assign(globalThis, {
    expectedChargePerOccurrence, monthlyEquivalent,
    VAR_TOL_ABS, VAR_TOL_PCT, VAR_HARD_PCT,
  })`, sandbox);
  return sandbox;
}

// The exact 4-line classification enrichCost runs, using the REAL constants from
// source. If the source thresholds move, these move with them.
function classify(s, reconCharge, monthlyExpected, frequency) {
  const expectedCharge = s.expectedChargePerOccurrence(monthlyExpected, frequency);
  if (reconCharge == null || !(expectedCharge > 0)) return { flag: 'unknown', pct: 0 };
  const varianceAmount = reconCharge - expectedCharge;
  const variancePct = Math.abs(varianceAmount) / expectedCharge;
  const absVar = Math.abs(varianceAmount);
  let flag;
  if (absVar <= s.VAR_TOL_ABS && variancePct <= s.VAR_TOL_PCT) flag = 'match';
  else if (variancePct > s.VAR_HARD_PCT) flag = 'hard';
  else flag = 'soft';
  return { flag, pct: variancePct };
}

describe('expectedChargePerOccurrence', () => {
  const s = loadCosts();

  it('scales a monthly-equivalent up to the real charge per frequency', () => {
    expect(s.expectedChargePerOccurrence(6.25, 'Annually')).toBeCloseTo(75, 6);
    expect(s.expectedChargePerOccurrence(30, 'Quarterly')).toBeCloseTo(90, 6);
    expect(s.expectedChargePerOccurrence(52, 'Monthly')).toBeCloseTo(52, 6);
    expect(s.expectedChargePerOccurrence(43.33, 'Weekly')).toBeCloseTo(43.33 * 12 / 52, 6);
    expect(s.expectedChargePerOccurrence(100, 'Fortnightly')).toBeCloseTo(100 * 12 / 26, 6);
  });

  it('is the inverse of monthlyEquivalent (round-trips)', () => {
    for (const f of ['Daily', 'Weekly', 'Fortnightly', '4-Weekly', 'Monthly', 'Quarterly', 'Annually']) {
      const monthly = 40;
      const charge = s.expectedChargePerOccurrence(monthly, f);
      expect(s.monthlyEquivalent(charge, f)).toBeCloseTo(monthly, 6);
    }
  });

  it('returns 0 for a zero/blank expected', () => {
    expect(s.expectedChargePerOccurrence(0, 'Annually')).toBe(0);
    expect(s.expectedChargePerOccurrence(null, 'Monthly')).toBe(0);
  });
});

describe('variance classification no longer punishes non-monthly bills', () => {
  const s = loadCosts();

  it('an annual bill never reads as a four-figure variance (Evernote regression)', () => {
    // £104.99 actual vs £6.25/mo expected. Old code: 1580% hard. Fixed: ~40%.
    const { flag, pct } = classify(s, 104.99, 6.25, 'Annually');
    expect(pct).toBeLessThan(1); // the whole point — not 15.8
    expect(pct).toBeCloseTo((104.99 - 75) / 75, 4);
    expect(flag).toBe('hard'); // still flagged, but honestly (rate genuinely up ~40%)
  });

  it('an annual bill charging exactly its expected reads as a match, not a 1100% variance', () => {
    // £75/yr actual vs £6.25/mo expected (= £75/yr). Old code: 1100% hard.
    const { flag, pct } = classify(s, 75, 6.25, 'Annually');
    expect(pct).toBeLessThan(0.02);
    expect(flag).toBe('match');
  });

  it('a weekly bill charging exactly its expected reads as a match, not a -77% variance', () => {
    // Monthly-equiv £43.33 → £10/week. Charge £10. Old code compared £10 vs £43.33 = -77% hard.
    const { flag } = classify(s, s.expectedChargePerOccurrence(43.33, 'Weekly'), 43.33, 'Weekly');
    expect(flag).toBe('match');
  });

  it('a genuine monthly overspend is still caught', () => {
    // South Staffs Water: £53.28/mo expected, £204.80 charged. Real, must stay hard.
    const { flag } = classify(s, 204.80, 53.28, 'Monthly');
    expect(flag).toBe('hard');
  });
});

describe('source is wired to the fix (guards against silent regression)', () => {
  const src = read('js/costs.js');

  it('enrichCost compares against the per-occurrence charge, not the raw monthly expected', () => {
    expect(src).toMatch(/expectedChargePerOccurrence\(expected, frequency\)/);
    expect(src).toMatch(/varianceAmount = lastReconAmountNum - expectedCharge/);
    // The old buggy direct comparison must be gone.
    expect(src).not.toMatch(/varianceAmount = lastReconAmountNum - expected;/);
  });

  it('amendExpectedCost writes a monthly-equivalent, not the raw reconciled lump', () => {
    expect(src).toMatch(/monthlyEquivalent\(reconCharge, getCostFrequency\(cost\)\)/);
    expect(src).not.toMatch(/\[F\.costExpected\]: Number\(getField\(cost, F\.costLastReconAmount\)\)/);
  });

  it('the cost statement print-out totals against the per-occurrence charge, not the monthly figure', () => {
    // totalExpected must be built from the per-occurrence charge (expectedCharge),
    // else a printed annual statement shows a monthly Expected against real lumps.
    expect(src).toMatch(/const perOccurrence = e\.expectedCharge/);
    expect(src).not.toMatch(/totalExpected = e\.expected \* monthsBetween/);
    expect(src).toMatch(/Expected per payment<\/div><div class="value">\$\{fmt\(e\.expectedCharge\)\}/);
  });
});
