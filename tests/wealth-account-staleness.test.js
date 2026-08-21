import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'js/wealth.js'), 'utf8');
const fintableSrc = readFileSync(resolve(root, 'js/fintable.js'), 'utf8');

function extract(text, name, file) {
  const start = text.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ${file}`);
  let i = text.indexOf('{', start), depth = 0, end = -1;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`could not parse ${name}`);
  return text.slice(start, end);
}

// getField and F are globals from shared.js / config.js; stub the two this needs.
const F = { accLastUpdate: 'lastUpdate' };
const getField = (rec, field) => rec.fields[field];

const accountFeedAgeHours = new Function('F', 'getField',
  `${extract(src, 'accountFeedAgeHours', 'js/wealth.js')}; return accountFeedAgeHours;`)(F, getField);
const accountStaleNote = new Function(
  `${extract(src, 'accountStaleNote', 'js/wealth.js')}; return accountStaleNote;`)();

// ─────────────────────────────────────────────────────────────────────────────
// 20260815-agent-dispatch-152 — net worth counted balances the monitor ignores
// ─────────────────────────────────────────────────────────────────────────────
// The Fintable monitor deliberately skips some feeds (FINTABLE_EXCLUDED), but the Cash
// line on the Wealth tab counts every account ticked "Cash" regardless. A balance last
// updated months ago was therefore added to today's net worth with nothing saying it
// was old. The balance is still the best figure available — it just must not read live.
describe('accountFeedAgeHours', () => {
  const now = Date.parse('2026-08-16T09:00:00Z');

  it('returns Infinity for a never-synced account — the worst case, not the best', () => {
    expect(accountFeedAgeHours({ fields: {} }, now)).toBe(Infinity);
    expect(accountFeedAgeHours({ fields: { lastUpdate: '' } }, now)).toBe(Infinity);
    expect(accountFeedAgeHours({ fields: { lastUpdate: 'not a date' } }, now)).toBe(Infinity);
  });

  it('measures the gap in hours', () => {
    expect(accountFeedAgeHours({ fields: { lastUpdate: '2026-08-16T06:00:00Z' } }, now)).toBe(3);
    expect(accountFeedAgeHours({ fields: { lastUpdate: '2026-08-06T09:00:00Z' } }, now)).toBe(240);
  });
});

describe('accountStaleNote uses the same thresholds as the sync monitor', () => {
  it('says nothing while the feed is inside the monitor\'s healthy window', () => {
    expect(accountStaleNote(2)).toBe('');
    expect(accountStaleNote(48)).toBe('');
    expect(accountStaleNote(72)).toBe('');
  });

  it('marks a feed the monitor would call alert or critical', () => {
    expect(accountStaleNote(96)).toBe(' — 4d stale');
    expect(accountStaleNote(24 * 190)).toBe(' — 190d stale');
  });

  it('calls a never-synced account out separately', () => {
    expect(accountStaleNote(Infinity)).toBe(' — no feed');
  });

  it('matches the 72-hour boundary fintable.js uses for "not reporting"', () => {
    // classifyFintableAccount: ok <= 24, warning <= 72, alert <= 168, critical beyond.
    expect(fintableSrc).toContain('hoursAgo <= 72');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The regression this fix could easily have caused
// ─────────────────────────────────────────────────────────────────────────────
// creditCardItems() decides whether a Debt Terms card already has a live account by
// comparing NAMES. Decorating `name` with the staleness note would miss that match and
// count the same card twice — once from the account, once from Debt Terms. The note
// therefore lives on `displayName`, and `name` stays exactly the account alias.
describe('the staleness note never leaks into name-matching', () => {
  const netWorthAccounts = extract(src, 'netWorthAccounts', 'js/wealth.js');

  it('keeps name as the bare account alias', () => {
    expect(netWorthAccounts).toMatch(/name,\s*$/m);
    expect(netWorthAccounts).toContain('displayName: name + accountStaleNote(hoursAgo)');
    // The decorated string must not be assigned to `name`.
    expect(netWorthAccounts).not.toMatch(/name:\s*\(getField[^)]*\)[^,]*accountStaleNote/);
  });

  it('creditCardItems still matches on the undecorated name', () => {
    const cards = extract(src, 'creditCardItems', 'js/wealth.js');
    expect(cards).toContain('live.map(a => String(a.name || \'\')');
    expect(cards).not.toContain('displayName');
  });

  it('the monthly snapshot roll-forward writes the undecorated name', () => {
    // A decorated name would be frozen into the snapshot and never match again.
    expect(src).toContain("out.push({ name: it.name, amount: Number(it.amount) || 0, type: cls })");
  });

  it('the assets/liabilities matrix shows the decorated label', () => {
    expect(src).toContain('label: it.displayName || it.name');
  });
});
