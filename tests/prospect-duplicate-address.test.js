// One address, one opener.
//
// Regression origin: finding 20260824-prospect-daily-run-342 (24 Aug 2026).
// Two Airtable Prospects rows can carry the same Contact Email — five such
// pairs existed that day — and approveAndSendProspect posted straight to GHL
// with no per-address check. Tom Hooper at admin@noblepaintingdecorating.co.uk
// got two different cold openers, 14 Aug 07:56 and 16 Aug 15:42, both
// delivered. Kevin had rejected the other four twins by hand, which is the only
// reason it happened once rather than five times.
//
// The real function is extracted from js/prospecting.js so this cannot pass
// against a fixed copy while the shipped file regresses.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(resolve(root, 'js/prospecting.js'), 'utf8');

function extract(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in js/prospecting.js`);
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`could not parse ${name}`);
}

const STATUSES = (() => {
  const m = SRC.match(/const PROS_EMAILED_STATUSES = (\[[^\]]*\])/);
  if (!m) throw new Error('PROS_EMAILED_STATUSES not found');
  return JSON.parse(m[1].replace(/'/g, '"'));
})();

function load(cache) {
  const scope = {
    prospectsCache: cache,
    PROS_EMAILED_STATUSES: STATUSES,
    prosField: (r, f) => (r.fields || {})[f],
    prosStatus: (r) => (r.fields || {}).Status || 'Found',
  };
  const names = Object.keys(scope);
  return new Function(...names,
    `${extract('alreadyEmailedAddress')}; return alreadyEmailedAddress;`)(
    ...names.map((n) => scope[n]));
}

const row = (id, email, status) => ({ id, fields: { 'Contact Email': email, Status: status } });

describe('alreadyEmailedAddress', () => {
  it('blocks a second opener to an address another record already emailed', () => {
    const twin = row('recA', 'admin@noblepaintingdecorating.co.uk', 'Contacted (1:1)');
    const mine = row('recB', 'admin@noblepaintingdecorating.co.uk', 'Approved');
    expect(load([twin, mine])(mine)).toBe(true);
  });

  it('ignores case and surrounding spaces', () => {
    const twin = row('recA', '  Admin@Noble.CO.UK ', 'Replied');
    const mine = row('recB', 'admin@noble.co.uk', 'Approved');
    expect(load([twin, mine])(mine)).toBe(true);
  });

  // CONTROL: a guard that blocks everything is as useless as one that blocks
  // nothing, and would make the test above pass for the wrong reason.
  it('lets a genuinely new address through', () => {
    const other = row('recA', 'someone@else.co.uk', 'Contacted (1:1)');
    const mine = row('recB', 'admin@noble.co.uk', 'Approved');
    expect(load([other, mine])(mine)).toBe(false);
  });

  it('does not block on a twin that has NOT been emailed yet', () => {
    const twin = row('recA', 'admin@noble.co.uk', 'Ready for Review');
    const mine = row('recB', 'admin@noble.co.uk', 'Approved');
    expect(load([twin, mine])(mine)).toBe(false);
  });

  it('never blocks a record on its own row', () => {
    const mine = row('recB', 'admin@noble.co.uk', 'Contacted (1:1)');
    expect(load([mine])(mine)).toBe(false);
  });

  it('a blank address is not a match against every other blank', () => {
    const blank = row('recA', '', 'Contacted (1:1)');
    const mine = row('recB', '', 'Approved');
    expect(load([blank, mine])(mine)).toBe(false);
  });
});

describe('the send path uses the guard', () => {
  it('refuses before the GHL POST, not after it', () => {
    const body = extract('sendProspectEmailViaGHL');
    const guard = body.indexOf('alreadyEmailedAddress(rec)');
    const post = body.indexOf('conversations/messages');
    expect(guard, 'the guard is not called from the send path').toBeGreaterThan(-1);
    expect(guard, 'the guard runs after the email has already gone').toBeLessThan(post);
  });
});
