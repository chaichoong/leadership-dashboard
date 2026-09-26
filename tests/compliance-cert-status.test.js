import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Finding 20260810-drift-056: a certificate with no Renewal Date was counted as
// ACTIVE (green) on the compliance KPI bar, while the very cell beside it showed a
// grey "No date". Unknown is not the same as in date. Nothing errored, and a
// summary bar that disagrees with the grid under it cannot be acted on.
//
// Finding 20260810-drift-057: block apartment rows went red from the BUILDING
// insurance certificate, which those rows never displayed, so the colour had no
// visible cause on screen.
//
// One function, certStatus(), now decides what a certificate's status is, and the
// cell, the KPI tiles and the block-insurance cell all read from it. The real
// function is pulled out of compliance.html rather than copied here, so this test
// cannot drift away from the code it guards.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'compliance.html'), 'utf8');

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in compliance.html`);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`could not parse ${name}`);
  return src.slice(start, end);
}

const certStatus = new Function(
  `${extract('daysUntil')}; ${extract('certStatus')}; return certStatus;`
)();

const daysUntil = new Function(`${extract('daysUntil')}; return daysUntil;`)();

const iso = (offsetDays) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

describe('certStatus', () => {
  it('is the real function from compliance.html', () => {
    expect(typeof certStatus).toBe('function');
  });

  it('calls a certificate with no renewal date "No date", never Active', () => {
    // The bug in one line. Before the fix this fell through to the Active branch.
    expect(certStatus({ s: 'Active', d: null }).label).toBe('No date');
    expect(certStatus({ s: 'Active', d: '' }).label).toBe('No date');
    expect(certStatus({ s: 'Active', d: undefined }).label).toBe('No date');
  });

  it('still classifies real dates correctly', () => {
    // Control. Without these the case above could pass by labelling everything
    // "No date", which would be just as wrong and just as quiet.
    expect(certStatus({ s: 'Active', d: iso(-1) }).label).toBe('Expired');
    expect(certStatus({ s: 'Active', d: iso(10) }).label).toBe('Expiring');
    expect(certStatus({ s: 'Active', d: iso(30) }).label).toBe('Expiring');
    expect(certStatus({ s: 'Active', d: iso(120) }).label).toBe('Active');
  });

  it('honours an explicit Expired status even with a future date', () => {
    expect(certStatus({ s: 'Expired', d: iso(200) }).label).toBe('Expired');
  });
});

describe('the KPI bar agrees with the grid', () => {
  it('counts a blank renewal date in its own bucket, not in Active', () => {
    // countCert is a closure inside loadData(), so assert on the shipped source:
    // it must classify through certStatus and have a "No date" branch.
    const block = src.slice(src.indexOf('const countCert'), src.indexOf('for (const row of selfStd)'));
    expect(block).toContain('certStatus(c).label');
    expect(block).toMatch(/label === 'No date'\)?\s*noDate\+\+/);
    expect(block).not.toMatch(/else active\+\+;[\s\S]*days === null/);
  });

  it('shows a No Date tile, so the count is visible rather than merely correct', () => {
    const bar = src.slice(src.indexOf("getElementById('summaryBar')"));
    expect(bar.slice(0, 900)).toContain('No Date');
    expect(bar.slice(0, 900)).toContain('${noDate}');
  });
});

describe('block apartment rows explain their own colour', () => {
  it('the insurance cell reports the building policy status, not just "See building"', () => {
    // rowClass() includes row.ins for block units, so an expired building policy
    // reddens every apartment. The cell must say so.
    expect(src).toContain('function buildingInsCell(');
    const fn = extract('buildingInsCell');
    expect(fn).toContain('certStatus(ins)');
    expect(fn).toContain('See building');
    // The old markup was a bare N/A tag with no status at all.
    const rowsFn = src.slice(src.indexOf('const renderRows ='));
    expect(rowsFn.slice(0, 2000)).toContain('buildingInsCell(row.ins)');
  });
});

// Finding 20260818-drift-monitor-189: every certificate whose Status was 'Expired'
// was dropped before it could be attached to a grid row, so no cert object in the
// grid could ever carry that status. The cell fell through to the grey dash and the
// KPI counted it as missing++ — a GSC that lapsed in 2018 and six EICRs that lapsed
// in March 2026 all reported as "no certificate on file" rather than Expired.
// Nothing errored, and the red tile under-read on a legal-obligation surface.
// Verified against Property Certificates tbl35rf9qtmq0P87r on 21 Aug 2026: 83 rows,
// 15 with Status='Expired', every one of them dated in the past or not at all.
describe('an expired certificate reaches the grid', () => {
  it('is not dropped before it can be attached to a row', () => {
    // The skip sat in the loop that attaches certs to rows. Assert on the shipped
    // source: any re-introduction of a Status-based skip fails here.
    expect(src).not.toMatch(/c\.s === 'Expired'\)\s*continue/);
    expect(src).not.toMatch(/skip expired certs/);
  });

  it('a lapsed certificate never displaces a live one, whatever the dates say', () => {
    // Keeping expired records means isNewer now has to choose between them. Today
    // no live record is an Expired-status row with a future date, but the moment one
    // exists, a naive date comparison would hide a valid certificate behind it and
    // turn a compliant row red.
    const isNewer = new Function(
      `${extract('daysUntil')}; ${extract('certStatus')}; ${extract('isNewer')}; return isNewer;`
    )();
    const live = { s: 'Active', d: iso(200) };
    const lapsed = { s: 'Expired', d: iso(400) };   // later date, still lapsed
    const older = { s: 'Active', d: iso(30) };

    expect(isNewer(null, lapsed)).toBe(true);        // something beats nothing
    expect(isNewer(live, lapsed)).toBe(false);       // lapsed must not win on date
    expect(isNewer(lapsed, live)).toBe(true);        // live displaces lapsed
    expect(isNewer(older, live)).toBe(true);         // among live certs, latest wins
    expect(isNewer(live, older)).toBe(false);
    expect(isNewer(live, { s: 'Active', d: null })).toBe(false);  // a date beats none
  });
});

// Finding 20260818-drift-monitor-196: a PAT that Airtable rejected with 401/403 was
// removed from sessionStorage only. init() reads localStorage FIRST, so reloading the
// page re-loaded the dead token, failed again, and left the operator on the auth
// screen with no explanation and no way out except clearing site data by hand.
describe('a rejected PAT is cleared from every store it was written to', () => {
  it('clears localStorage as well as sessionStorage on 401/403', () => {
    const writes = src.slice(src.indexOf('function authenticate('), src.indexOf('(function init('));
    // Both stores are written on login...
    expect(writes).toContain("sessionStorage.setItem('_dlr_pat'");
    expect(writes).toContain("localStorage.setItem('airtable_pat'");

    // ...so both must be cleared on rejection, inside the same branch.
    const fetchFn = src.slice(src.indexOf('async function airtableFetch('));
    const branch = fetchFn.slice(fetchFn.indexOf('resp.status === 401'),
                                 fetchFn.indexOf("throw new Error('Auth failed')"));
    expect(branch).toContain("sessionStorage.removeItem('_dlr_pat')");
    expect(branch).toContain("localStorage.removeItem('airtable_pat')");
  });

  it('still prefers localStorage on load, so the clear is what breaks the loop', () => {
    // Control: if the read order ever changes, the reasoning above stops applying
    // and this test should be revisited rather than quietly still passing.
    const init = src.slice(src.indexOf('(function init('), src.indexOf('async function airtableFetch('));
    expect(init).toMatch(/localStorage\.getItem\('airtable_pat'\)\s*\|\|\s*sessionStorage\.getItem\('_dlr_pat'\)/);
  });
});

// THE CLOCK CHANGE MUST NOT MOVE A RENEWAL DATE (finding 20260926-queue-fixer-629).
//
// daysUntil used to difference two LOCAL midnights and ceil the result. Across a
// clock change that difference is 30 days plus (or minus) an hour, so a renewal
// exactly 30 days out counted as 31 and certStatus's `days <= 30` branch was
// missed: the cell read Active, with no colour, one month before renewal. It hid
// for about a month before each change, in both directions, and it took the whole
// vitest gate going red on 26 Sep 2026 to find it.
//
// The dates are PINNED rather than computed from today, so this keeps testing the
// boundary on every day of the year instead of only in late September.
describe('daysUntil counts calendar days across a clock change', () => {
  afterEach(() => { vi.useRealTimers(); });

  const at = (ymd) => { vi.useFakeTimers(); vi.setSystemTime(new Date(`${ymd}T09:00:00`)); };

  it('BST to GMT: 30 days is 30, not 31', () => {
    at('2026-09-26');                       // BST; +30 days lands after the change
    expect(daysUntil('2026-10-26')).toBe(30);
    expect(certStatus({ s: 'Active', d: '2026-10-26' }).label).toBe('Expiring');
  });

  it('GMT to BST: 30 days is still 30, not 29', () => {
    at('2026-03-15');                       // GMT; +30 days lands after the change
    expect(daysUntil('2026-04-14')).toBe(30);
    expect(certStatus({ s: 'Active', d: '2026-04-14' }).label).toBe('Expiring');
  });

  it('the ordinary cases are unchanged', () => {
    at('2026-06-10');
    expect(daysUntil('2026-06-10')).toBe(0);
    expect(daysUntil('2026-06-09')).toBe(-1);
    expect(daysUntil('2026-06-11')).toBe(1);
    expect(daysUntil('2026-10-08')).toBe(120);
    expect(daysUntil('')).toBeNull();
  });
});
