import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// js/ files load as plain <script> tags, so there is nothing to import. Pull the
// real function text out of the source and evaluate it, rather than pasting a
// copy that would drift silently. Same approach as recon-vendor-key.test.js.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configSrc = readFileSync(resolve(root, 'js/config.js'), 'utf8');
const reconSrc = readFileSync(resolve(root, 'js/reconciliation.js'), 'utf8');

function extract(src, name, file) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in ${file}`);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) throw new Error(`could not parse ${name}`);
  return src.slice(start, end);
}

const isPersonalCoaName = new Function(
  `${extract(configSrc, 'isPersonalCoaName', 'js/config.js')}; return isPersonalCoaName;`
)();

// The live Chart of Accounts, read from Airtable on 2026-08-18.
// Categories: tbleWb8ioptnEwPR8 (10 rows). Sub-categories: tblOTdRcPf8AgRz25 (49 rows).
const CATEGORIES = [
  'Capital Expenditure', 'Personal Expense Not Deductible', 'Operating Expenses',
  'Cost of Goods Sold', 'Loan Receipt', 'Balance Sheet', 'Personal Income',
  'Revenue', 'Personal Expense Tax Deductible', 'Transfer',
];
const SUB_CATEGORIES = [
  'Bank Transaction Fees', 'COGS Commission', 'COGS Delivery Costs', 'COGS Labour',
  'COGS Product Costs', 'COGS Property Compliance', 'COGS Property Council Tax',
  'COGS Property Reactive Maintenance', 'COGS Property Utilities', 'COGS Sales Fees',
  'Capex - Property Renovations', 'Charity', 'Director Discretionary Expenses',
  'Fixed Income', 'Insurance', 'Loan Capital Repayment', 'Loan Interest',
  'Loan Receipt', 'Marketing', 'Mortgage Capital Repayment', 'Mortgage Interest',
  'Operational Supplies', 'Opex Labour', 'Personal Banking Fees',
  'Personal Credit Card Transfer', 'Personal Discretionary Food & Drink',
  'Personal Discretionary Lifestyle', 'Personal Health', 'Personal Household Essentials',
  'Personal Income Drawings', 'Personal Income Other', 'Personal Insurance',
  'Personal Investment', 'Personal Loan Capital Repayment', 'Personal Loan Interest',
  'Personal Maintenance', 'Personal Professional Fees', 'Personal Tax',
  'Personal Transport', 'Personal Travel', 'Premises / Overheads', 'Professional Fees',
  'Rental Income', 'Software & Subscriptions', 'Subsistence', 'Tax', 'Transfer',
  'Travel & Training', 'Variable Income',
];

describe('isPersonalCoaName', () => {
  it('is the real function from js/config.js', () => {
    expect(typeof isPersonalCoaName).toBe('function');
  });

  it('flags exactly the 3 personal categories in the live Chart of Accounts', () => {
    const hits = CATEGORIES.filter(isPersonalCoaName);
    expect(hits.sort()).toEqual([
      'Personal Expense Not Deductible',
      'Personal Expense Tax Deductible',
      'Personal Income',
    ]);
  });

  it('flags exactly the 17 personal sub-categories in the live Chart of Accounts', () => {
    const hits = SUB_CATEGORIES.filter(isPersonalCoaName);
    expect(hits).toHaveLength(17);
    expect(hits.every(n => n.startsWith('Personal'))).toBe(true);
  });

  // The whole rule rests on no business-side entry sharing the prefix. If one
  // ever does, personal money stops being identifiable by name and this fix
  // needs a different signal, not a tweak.
  it('leaves every business-side entry alone', () => {
    const business = [...CATEGORIES, ...SUB_CATEGORIES].filter(n => !n.startsWith('Personal'));
    expect(business.filter(isPersonalCoaName)).toEqual([]);
  });

  it('matches on a word boundary, not a bare prefix', () => {
    expect(isPersonalCoaName('Personalisation')).toBe(false);
    expect(isPersonalCoaName('Personalised Gifts')).toBe(false);
    expect(isPersonalCoaName('Personal')).toBe(true);
    expect(isPersonalCoaName('personal health')).toBe(true); // case-insensitive
    expect(isPersonalCoaName('  Personal Tax  ')).toBe(true); // trimmed
  });

  it('treats a missing name as not personal', () => {
    expect(isPersonalCoaName('')).toBe(false);
    expect(isPersonalCoaName(null)).toBe(false);
    expect(isPersonalCoaName(undefined)).toBe(false);
  });

  // A rename of the Personal business must not break the switch — which is why
  // the business is pinned by record ID, not looked up by name.
  it('pins the Personal business by record ID, not by name', () => {
    expect(configSrc).toMatch(/bizPersonal:\s*'reclAPC2vMx2Umuzb'/);
    expect(reconSrc).toContain('REC.bizPersonal');
    // findBusinessIdByName('Personal') would reintroduce the name coupling.
    expect(reconSrc).not.toMatch(/findBusinessIdByName\(\s*'Personal'\s*\)/);
  });

  // The rule is worthless if nothing calls it. It has to reach every path that
  // can write a Business to Airtable, not only the two columns Kevin clicks.
  it('is wired to both Chart of Accounts columns, the cost and tenancy auto-fills, and the matcher', () => {
    expect(reconSrc).toContain('onchange="applyPersonalBusinessRule(${i})">${catSelect}');
    expect(reconSrc).toContain('onchange="applyPersonalBusinessRule(${i})">${subCatSelect}');
    // reconCostChanged and reconTenancyChanged both set Business in code, which
    // fires no change event — each has to re-assert the rule itself.
    for (const fn of ['reconCostChanged', 'reconTenancyChanged']) {
      expect(extract(reconSrc, fn, 'js/reconciliation.js')).toContain('applyPersonalBusinessRule(idx)');
    }
    // The headless auto-reconcile agent never touches the DOM. It reads the
    // matcher's result objects, PATCHes them, and feeds the same values to
    // saveReconRule — so the rule has to be applied at the matcher's output.
    expect(extract(reconSrc, 'runReconciliationMatching', 'js/reconciliation.js'))
      .toContain('results.push(forcePersonalBusiness(result))');
  });

  // Businesses load asynchronously. Writing a link before they arrive would
  // invent a record ID the picker cannot hold.
  it('never writes a business it could not find', () => {
    const fn = extract(reconSrc, 'forcePersonalBusiness', 'js/reconciliation.js');
    expect(fn).toContain('if (!biz) return result');
  });

});
