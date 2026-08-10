import { describe, it, expect } from 'vitest';
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
