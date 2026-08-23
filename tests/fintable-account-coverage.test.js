import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'js/fintable.js'), 'utf8');

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in js/fintable.js`);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`could not parse ${name}`);
  return src.slice(start, end);
}

const classifyFintableAccount = new Function(
  `${extract('classifyFintableAccount')}; return classifyFintableAccount;`
)();

// ─────────────────────────────────────────────────────────────────────────────
// 20260815-agent-dispatch-151 — the sync monitor hid the accounts dead longest
// ─────────────────────────────────────────────────────────────────────────────
// fetchFintableAccounts filtered on IS_AFTER({**Last Successful Update}, today-183d).
// That drops exactly the accounts the page exists to report: anything silent for more
// than six months, and anything that has NEVER synced (a blank date fails IS_AFTER, so
// it is excluded rather than flagged). The monitor then read as all-clear.
describe('fetchFintableAccounts fetches every account, dead ones included', () => {
  const fetchSrc = extract('fetchFintableAccounts');

  it('carries no staleness filter at all', () => {
    expect(fetchSrc).not.toContain('IS_AFTER');
    expect(fetchSrc).not.toContain('filterByFormula');
    expect(fetchSrc).not.toMatch(/setDate\([^)]*-\s*183/);
  });

  it('still paginates — a hand-rolled Airtable read that stops at one page under-counts', () => {
    expect(fetchSrc).toContain('offset');
    expect(fetchSrc).toMatch(/while\s*\(offset\)/);
  });

  it('fails loudly on zero rows instead of rendering a clean monitor', () => {
    // A silent zero from a broken read is indistinguishable from "all feeds healthy",
    // which is the same trap that hid the dead accounts in the first place.
    expect(fetchSrc).toMatch(/allRecords\.length === 0[\s\S]{0,200}throw/);
  });
});

describe('classifyFintableAccount handles what the filter used to hide', () => {
  const at = (hoursAgo) => ({
    fields: {
      'Account Alias': 'Test Account',
      '**Last Successful Update': new Date(Date.now() - hoursAgo * 3600_000).toISOString(),
    },
  });

  it('grades a never-synced account critical, not fresh', () => {
    const r = classifyFintableAccount({ fields: { 'Account Alias': 'Never Synced' } });
    expect(r.hoursAgo).toBe(Infinity);
    expect(r.status).toBe('critical');
  });

  it('grades a feed dead for seven months critical', () => {
    expect(classifyFintableAccount(at(210 * 24)).status).toBe('critical');
  });

  it('keeps the existing thresholds for live feeds', () => {
    expect(classifyFintableAccount(at(2)).status).toBe('ok');
    expect(classifyFintableAccount(at(48)).status).toBe('warning');
    expect(classifyFintableAccount(at(100)).status).toBe('alert');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 23 Aug 2026 — "33 need reconnecting" counted feeds that can never reconnect
// ─────────────────────────────────────────────────────────────────────────────
// The Accounts table keeps every feed ever connected. Legacy Revolut / Wise / Two Chefs
// / cafe accounts with no Business link (dead 1-2.5 years) and a manual ANNA account with
// no Fintable user were all graded critical, burying the ten real dead feeds.
describe('isMonitoredFintableAccount keeps only feeds worth reconnecting', () => {
  const isMonitoredFintableAccount = new Function(
    `const FINTABLE_EXCLUDED = ['Cafe Zempler']; ${extract('isMonitoredFintableAccount')}; return isMonitoredFintableAccount;`
  )();
  const rec = (fields) => ({ fields });

  it('keeps an account linked to an active business with a Fintable user', () => {
    expect(isMonitoredFintableAccount(rec({ 'Account Alias': 'Barclaycard', '**Fintable User': 'k@x.com', 'Active? (From Business)': [1] }))).toBe(true);
  });

  it('drops a legacy feed with no Business link', () => {
    expect(isMonitoredFintableAccount(rec({ '*Name': 'KB Director Expenses', '**Fintable User': 'k@x.com' }))).toBe(false);
  });

  it('drops an account on an inactive business', () => {
    expect(isMonitoredFintableAccount(rec({ 'Account Alias': 'Old', '**Fintable User': 'k@x.com', 'Active? (From Business)': [0] }))).toBe(false);
  });

  it('drops a manual account with no Fintable connection (nothing to reconnect)', () => {
    expect(isMonitoredFintableAccount(rec({ 'Account Alias': 'Operations Director - ANNA', 'Active? (From Business)': [1] }))).toBe(false);
  });

  it('still honours the alias exclusion list', () => {
    expect(isMonitoredFintableAccount(rec({ 'Account Alias': 'Cafe Zempler', '**Fintable User': 'k@x.com', 'Active? (From Business)': [1] }))).toBe(false);
  });

  it('is what fetchFintableAccounts filters on', () => {
    expect(extract('fetchFintableAccounts')).toContain('filter(isMonitoredFintableAccount)');
  });
});
