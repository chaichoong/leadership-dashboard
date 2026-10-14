import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 14 Oct 2026 — two wrong figures in Wealth > Debts in detail (and on Home, which shows
// the same section). Every name, date and amount below is invented.
//
// 1. A card read its last STATEMENT balance, not today's. The bank feed copies one of
//    the balances the bank sends into **GBP, and for one card it copied
//    "previouslyClosedBooked", so a payment made after the statement never showed.
//    **Raw holds every balance the bank sent; cardOwed() takes the current booked one.
// 2. A repayment loan grew by its rate every month. The roll-forward meant for the
//    accruing interest-only charging order also caught any loan with a start date, and
//    compounded it from the date it was drawn, with no repayments.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wealthSrc = readFileSync(resolve(root, 'js/wealth.js'), 'utf8');
const sharedSrc = readFileSync(resolve(root, 'js/shared.js'), 'utf8');

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
function constLine(text, name, file) {
  const m = text.match(new RegExp(`const ${name} = [^\\n]+;`));
  if (!m) throw new Error(`const ${name} not found in ${file}`);
  return m[0];
}

const F = { accGBP: 'gbp', accRaw: 'raw', accNetWorthClass: 'cls', accountAlias: 'alias', accLastUpdate: 'upd' };
const getField = (rec, field) => rec?.fields?.[field];

const cardOwed = new Function('F', 'getField',
  `${constLine(sharedSrc, 'CARD_BALANCE_ORDER', 'js/shared.js')}
   ${extract(sharedSrc, 'cardOwed', 'js/shared.js')}; return cardOwed;`)(F, getField);

// The raw feed payload as the Accounts table stores it: balances nested one level down.
const raw = (...balances) => JSON.stringify({
  details: { account: { currency: 'GBP', cashAccountType: 'CARD' } },
  balances: { balances: balances.map(([balanceType, amount, referenceDate]) => ({ balanceAmount: { amount: String(amount), currency: 'GBP' }, balanceType, referenceDate })) },
});
const card = (gbp, rawText, extra = {}) => ({ id: 'recTestCard', fields: { gbp, raw: rawText, cls: 'Credit Card', alias: 'Test Card', upd: '2030-01-10T09:00:00Z', ...extra } });

describe('cardOwed: what a card owes today, from its bank feed', () => {
  it('reads past a stored statement balance to the current booked one', () => {
    // Statement 900 owed; a 500 payment since; the bank reports 400 owed today and
    // 1,100 of spare credit. The feed stored the statement figure.
    const acc = card(900, raw(['forwardAvailable', 1100, '2030-01-10'], ['openingBooked', -400, '2030-01-10'], ['previouslyClosedBooked', -900, '2029-12-18']));
    expect(cardOwed(acc)).toBe(400);
  });
  it('prefers the booked balance to the available one (spare credit is not debt)', () => {
    const acc = card(-350, raw(['interimAvailable', 1650, '2030-01-10'], ['interimBooked', -350, '2030-01-10']));
    expect(cardOwed(acc)).toBe(350);
  });
  it('takes an "information" balance when it is the only one the bank sends', () => {
    expect(cardOwed(card(12345.67, raw(['information', -12345.67, '2030-01-10'])))).toBe(12345.67);
  });
  it('uses the statement balance only when nothing newer was sent', () => {
    expect(cardOwed(card(1, raw(['previouslyClosedBooked', -620, '2029-12-18'])))).toBe(620);
  });
  it('a card in credit owes nothing (the bank reports what is owed as a negative)', () => {
    expect(cardOwed(card(45.1, raw(['interimAvailable', 1745.1, '2030-01-10'], ['interimBooked', 45.1, '2030-01-10'])))).toBe(0);
  });
  it('falls back to the stored figure when the feed sent only spare credit, nothing, or junk', () => {
    expect(cardOwed(card(-275, raw(['interimAvailable', 900, '2030-01-10'])))).toBe(275);
    expect(cardOwed(card(-275, ''))).toBe(275);
    expect(cardOwed(card(-275, undefined))).toBe(275);
    expect(cardOwed(card(-275, '{not json'))).toBe(275);
  });
  it('a missing account owes nothing rather than throwing', () => {
    expect(cardOwed(undefined)).toBe(0);
  });
});

describe('netWorthAccounts counts a card at what it owes today', () => {
  const build = (accounts) => new Function('F', 'getField', 'cardOwed', 'allAccounts',
    `${extract(wealthSrc, 'accountFeedAgeHours', 'js/wealth.js')}
     ${extract(wealthSrc, 'accountStaleNote', 'js/wealth.js')}
     ${extract(wealthSrc, 'accountAmount', 'js/wealth.js')}
     ${extract(wealthSrc, 'netWorthAccounts', 'js/wealth.js')}; return netWorthAccounts;`)(F, getField, cardOwed, accounts);

  it('the stale statement card counts at today\'s balance; cash is unchanged', () => {
    const accounts = [
      card(900, raw(['forwardAvailable', 1100, '2030-01-10'], ['openingBooked', -400, '2030-01-10'], ['previouslyClosedBooked', -900, '2029-12-18'])),
      { id: 'recTestCash', fields: { gbp: 2500.5, raw: raw(['interimAvailable', 2400, '2030-01-10'], ['interimBooked', 2500.5, '2030-01-10']), cls: 'Cash', alias: 'Test Current', upd: '2030-01-10T09:00:00Z' } },
    ];
    const nw = build(accounts);
    expect(nw('Credit Card').map(a => a.amount)).toEqual([400]);
    expect(nw('Cash').map(a => a.amount)).toEqual([2500.5]);
  });
});

describe('debtRows: only an interest-only loan rolls forward on its own', () => {
  const DEBT = { name: 'n', cls: 'c', type: 't', principal: 'p', rate: 'r', term: 'm', start: 's', payMatch: 'pm' };
  const loan = (id, name, type, principal, rate, start) => ({ id, fields: { n: name, c: 'Loans', t: type, p: principal, r: rate, s: start } });
  const rows = (debts) => new Function('F', 'getField', 'DEBT', '_debtRecords', 'allTransactions',
    `const _num = v => (v === '' || v == null) ? null : (isFinite(Number(v)) ? Number(v) : null);
     const creditCardItems = () => [];
     const debtCostByAcct = () => ({});
     const debtLoanBalances = () => ({});
     const amortisedBalance = () => { throw new Error('loans never amortise'); };
     ${extract(wealthSrc, 'debtAcctKey', 'js/wealth.js')}
     ${extract(wealthSrc, 'solveRepayRate', 'js/wealth.js')}
     ${extract(wealthSrc, 'manualDebtBalance', 'js/wealth.js')}
     ${extract(wealthSrc, 'debtPayments', 'js/wealth.js')}
     ${extract(wealthSrc, 'accruedDebtBalance', 'js/wealth.js')}
     ${extract(wealthSrc, 'debtRows', 'js/wealth.js')}; return debtRows();`)(F, getField, DEBT, debts, []);

  it('a repayment loan with a start date and a rate holds at the figure you typed', () => {
    const [r] = rows([loan('recTestRepay', 'Test Repayment Loan', 'Repayment', 31234.56, 2.5, '2021-06-01')]);
    expect(r.balance).toBe(31234.56);
  });
  it('an interest-only loan with a start date and a rate still accrues', () => {
    const [r] = rows([loan('recTestAccrue', 'Test Accruing Debt', 'Interest-only', 20000, 6, '2021-06-01')]);
    expect(r.balance).toBeGreaterThan(20000);
  });
  it('a loan with no start date holds at its figure, whatever its type', () => {
    const out = rows([loan('recA', 'Test Loan A', 'Repayment', 15000, 3, ''), loan('recB', 'Test Loan B', 'Interest-only', 9000, 4, '')]);
    expect(out.map(r => r.balance)).toEqual([15000, 9000]);
  });
  it('an accruing debt runs simple interest by the day, not whole months compounded', () => {
    // 140 days from 10 Mar to 28 Jul at 6%: 20,000 + 20,000 x 6% x 140/365 = 20,460.27.
    // Monthly compounding over Mar..Jul (the old maths) gives 20,505.03.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2030, 6, 28, 15, 30));
    try {
      const [r] = rows([loan('recTestAccrue', 'Test Accruing Debt', 'Interest-only', 20000, 6, '2030-03-10')]);
      expect(r.balance).toBeCloseTo(20460.27, 2);
      expect(r.accrues).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

// 14 Oct 2026 — the charging order. Judgment-debt interest is simple and runs per day; the
// monthly compounding (which also charged the start month and the current month in full)
// overstated it. All figures invented.
describe('accruedDebtBalance: simple interest by the day', () => {
  const DEBT = { name: 'n', cls: 'c', type: 't', principal: 'p', rate: 'r', start: 's', payMatch: 'pm' };
  const TF = { ...F, txReportAmount: 'amt', txDescription: 'desc', txDate: 'date' };
  const build = (txns) => new Function('F', 'getField', 'DEBT', 'allTransactions',
    `${extract(wealthSrc, 'debtPayments', 'js/wealth.js')}
     ${extract(wealthSrc, 'accruedDebtBalance', 'js/wealth.js')}; return accruedDebtBalance;`)(TF, getField, DEBT, txns);
  const debt = (fields) => ({ id: 'recTestDebt', fields: { n: 'Test Accruing Debt', c: 'Loans', t: 'Interest-only', ...fields } });

  it('adds nothing on the start day and a day\'s interest per calendar day after', () => {
    const acc = build([]);
    const d = debt({ p: 20000, r: 6, s: '2030-03-10' });
    expect(acc(d, new Date(2030, 2, 10, 18, 0))).toBe(20000);
    expect(acc(d, new Date(2030, 6, 28, 9, 0))).toBeCloseTo(20460.27, 2);
  });
  it('a matched payment clears the interest run up first, then the amount owed', () => {
    // 7.3% a year on 10,000 = 2.00 a day. 100 days to 11 Apr = 200 interest; a 300
    // payment clears it and 100 of the debt (9,900 left); 40 more days at 1.98 = 79.20.
    const acc = build([
      { fields: { amt: -300, desc: 'TEST LENDER REPAYMENT', date: '2030-04-11' } },
      { fields: { amt: -50, desc: 'UNRELATED SHOP', date: '2030-04-12' } },
      { fields: { amt: 300, desc: 'TEST LENDER REFUND', date: '2030-04-13' } },
    ]);
    const d = debt({ p: 10000, r: 7.3, s: '2030-01-01', pm: 'TEST LENDER' });
    expect(acc(d, new Date(2030, 4, 21, 12, 0))).toBeCloseTo(9979.2, 2);
  });
  it('holds at its amount with no start date, and owes nothing with no amount', () => {
    const acc = build([]);
    expect(acc(debt({ p: 5000, r: 8, s: '' }), new Date(2030, 0, 1))).toBe(5000);
    expect(acc(debt({ p: 0, r: 8, s: '2030-01-01' }), new Date(2030, 5, 1))).toBe(0);
  });
});

describe('debtEditorHtml: an accruing debt saves its amount on the start date', () => {
  const editor = new Function('escHtml', 'fmt0',
    `${extract(wealthSrc, 'debtEditorHtml', 'js/wealth.js')}; return debtEditorHtml;`)(s => String(s), n => String(n));
  const valueOf = html => (html.match(/class="de-principal"[^>]*value="([^"]*)"/) || [])[1];

  it('pre-fills the start-date amount, so saving never stores interest twice', () => {
    const row = { id: 'recTestDebt', name: 'Test Accruing Debt', cls: 'Loans', type: 'Interest-only', rate: 6, balance: 20460.27, principal: 20000, term: 0, start: '2030-03-10', accrues: true };
    const html = editor(row);
    expect(valueOf(html)).toBe('20000');
    expect(html).toContain('Amount on start date');
    // The "Read screenshot / document" flow reads this flag and leaves the amount alone.
    expect(html).toContain('data-accrues="1"');
  });
  it('a loan that does not accrue still edits its current balance', () => {
    const row = { id: 'recTestLoan', name: 'Test Loan', cls: 'Loans', type: 'Repayment', rate: 2.5, balance: 31234.56, principal: 31234.56, term: 0, start: '', accrues: false };
    const html = editor(row);
    expect(valueOf(html)).toBe('31234.56');
    expect(html).toContain('data-accrues=""');
  });
});
