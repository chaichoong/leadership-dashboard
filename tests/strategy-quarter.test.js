import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(resolve(ROOT, 'os/strategy/strategy.js'), 'utf8');

// Quarter arithmetic behind the Objective & Strategy wizard guard.
//
// The guard exists because a founder's instinct is to open LAST quarter and run
// the wizard from there. The wizard writes into whatever record is loaded, so
// that silently overwrote the finished quarter — history that cannot be
// recovered. isPastQuarter() decides whether to warn.
//
// Both directions are failure modes, which is why this is tested rather than
// eyeballed:
//   - Too eager  → nags on every normal wizard run and gets clicked through,
//                  which trains the founder to dismiss the one that matters.
//   - Too slack  → the destructive case ships unguarded.
//
// An off-by-one in the QUARTERS index or a string/number year compare would do
// either. Q4→Q1 crosses a year boundary, so it is the case most likely to break.
//
// Parsed out of the source rather than copied, so a change to the real function
// changes what runs here. The browser code loads via global <script> tags with
// no module boundary, so there is nothing to import — same reason as
// tests/shared.test.js and tests/constant-drift.test.js.

function extractFn(name) {
    const start = SRC.indexOf(`function ${name}(`);
    if (start === -1) throw new Error(`${name}() not found in os/strategy/strategy.js`);
    let depth = 0;
    for (let i = SRC.indexOf('{', start); i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}' && --depth === 0) return SRC.slice(start, i + 1);
    }
    throw new Error(`${name}() has unbalanced braces`);
}

// Rebuild the two functions against a frozen "today" so the assertions do not
// change meaning as real time passes.
function asOf(isoNow) {
    const frozen = new Date(isoNow);
    function FakeDate() { return frozen; }
    const body = `
        const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
        ${extractFn('currentQuarterYear')}
        ${extractFn('isPastQuarter')}
        return { currentQuarterYear, isPastQuarter };
    `;
    return new Function('Date', body)(FakeDate);
}

// Every timestamp below is the date-TIME form with no trailing Z, which parses
// as LOCAL time. The date-only form ('2026-01-01') parses as UTC midnight while
// getMonth() reads local, so west of UTC it rolls back into the previous
// quarter and every quarter-start case below flips — the exact boundaries this
// table exists to pin. Local noon cannot be shifted across a month boundary by
// any real offset.
describe('currentQuarterYear', () => {
    it.each([
        ['2026-01-01T12:00:00', 'Q1'], ['2026-03-31T12:00:00', 'Q1'],
        ['2026-04-01T12:00:00', 'Q2'], ['2026-06-30T12:00:00', 'Q2'],
        ['2026-07-01T12:00:00', 'Q3'], ['2026-09-30T12:00:00', 'Q3'],
        ['2026-10-01T12:00:00', 'Q4'], ['2026-12-31T12:00:00', 'Q4'],
    ])('maps %s to %s', (iso, expected) => {
        expect(asOf(iso).currentQuarterYear().quarter).toBe(expected);
    });

    it('returns the year as a string, matching the <select> values it is compared against', () => {
        const { currentQuarterYear } = asOf('2026-07-16T12:00:00');
        expect(currentQuarterYear().year).toBe('2026');
    });
});

describe('isPastQuarter', () => {
    // Kevin's real situation on 16 Jul 2026: planning Q3, with Q2 saved.
    const { isPastQuarter } = asOf('2026-07-16T12:00:00');

    it('treats last quarter as past — the case that overwrote Q2', () => {
        expect(isPastQuarter('Q2', '2026')).toBe(true);
    });

    it('does not treat the current quarter as past — no nag on normal planning', () => {
        expect(isPastQuarter('Q3', '2026')).toBe(false);
    });

    it('does not treat a future quarter as past', () => {
        expect(isPastQuarter('Q4', '2026')).toBe(false);
        expect(isPastQuarter('Q1', '2027')).toBe(false);
    });

    it('treats any quarter of an earlier year as past, including Q4', () => {
        expect(isPastQuarter('Q4', '2025')).toBe(true);
        expect(isPastQuarter('Q1', '2025')).toBe(true);
    });

    it('compares years numerically, not as strings', () => {
        // '999' > '2026' lexically but is an earlier year.
        expect(isPastQuarter('Q1', '999')).toBe(true);
    });

    it('does not warn on a blank or unparseable year', () => {
        // openWizard() returns before the guard when the year is empty, so a
        // false here means "no spurious modal" rather than a real decision.
        expect(isPastQuarter('Q1', '')).toBe(false);
        expect(isPastQuarter('Q1', 'not-a-year')).toBe(false);
    });

    describe('across the year boundary', () => {
        // Q4→Q1 is the only rollover where the quarter index resets while the
        // year advances. A same-year-only compare would call Q4 2026 "future"
        // in January 2027 and leave it unguarded.
        const jan2027 = asOf('2027-01-15T12:00:00');

        it('treats Q4 of last year as past when standing in Q1', () => {
            expect(jan2027.isPastQuarter('Q4', '2026')).toBe(true);
        });

        it('does not treat the current Q1 as past', () => {
            expect(jan2027.isPastQuarter('Q1', '2027')).toBe(false);
        });
    });
});
