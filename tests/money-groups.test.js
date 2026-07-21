import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// ── Money Groups: budgets vs buckets ─────────────────────────────────────────
//
// The bug this guards against, in Kevin's own worked example:
//
//   Save £1,000/month into the Tax bucket for five months. In month six the £5,000
//   tax bill lands and you pay it. Before this fix that payment counted as personal
//   expenditure, so net cash flow for month six went NEGATIVE — and because every
//   bucket is apportioned as a % of net cash flow (floored at £0), every OTHER
//   bucket got nothing in the exact month the pot existed to absorb the shock.
//   Debt got £0. Dreams got £0. Future got £0. The pot did its job and the system
//   punished him for it.
//
// The invariant: money spent from a bucket must NOT reduce net cash flow. Its pot
// was already funded out of an earlier month's surplus. Counting it once, in the
// pot, is the entire point of having the pot.
//
// These run against the REAL config.js + wealth.js source, not a copy, so a future
// edit that puts a bucket sub-category back into the budgeted list fails here.

function loadEngine() {
  const sandbox = {
    window: {}, document: { getElementById: () => null },
    console, Math, Date, Number, String, Object, Array, Set, JSON, isNaN, isFinite, parseFloat, parseInt,
    allTransactions: [], allSubCategories: [], allAccounts: [],
    getField: (rec, fieldId) => (rec.fields ? rec.fields[fieldId] : undefined),
    fmt0: (n) => '£' + Math.round(n),
    escHtml: (s) => String(s == null ? '' : s),
  };
  vm.createContext(sandbox);
  vm.runInContext(read('js/config.js'), sandbox);
  vm.runInContext(read('js/wealth.js'), sandbox);
  // Top-level `const`/`function` live in the script's global lexical scope, which is
  // not reachable as a property of the context object. A follow-up script in the same
  // context can still see them, so hoist the bindings the tests need onto the sandbox.
  vm.runInContext(`Object.assign(globalThis, {
    F, SUBCAT, PERSONAL_MONEY_GROUPS, BUCKET_SPEND_SUBCATS,
    CASHFLOW_PERSONAL_EXPENSE_SUBCATS, PERSONAL_EXPENSE_SUBCATS,
    buildMonthlyCashflow, buildBucketBalances, personalMoneyGroups, wealthMatrixCard,
  })`, sandbox);
  // _cfTxIndex is a module-level `let`; expose a reader from inside the same scope.
  vm.runInContext(`globalThis.getCfTxIndex = () => _cfTxIndex;`, sandbox);
  // Same reason: `allTransactions` / `allSubCategories` are lexical `let`s in
  // config.js, so assigning sandbox.allTransactions would NOT be seen by the engine.
  // Write through a setter that runs inside the same lexical scope.
  vm.runInContext(`globalThis.__setData = (t, sc, ac) => { allTransactions = t; allSubCategories = sc; allAccounts = ac || []; }`, sandbox);
  return sandbox;
}

// Build a transaction using the real field IDs from config.js.
function tx(sandbox, { date, amount, subId, alias }) {
  const F = sandbox.F;
  return { id: 'rec' + Math.random().toString(36).slice(2), fields: {
    [F.txDate]: date, [F.txReportAmount]: amount, [F.txSubCategory]: [subId],
    ...(alias ? { [F.txAccountAlias]: [alias] } : {}),
  } };
}

const SUB = {
  essentials: 'recF1C2ZXBfNeYlGT',   // Personal Household Essentials — Needs
  lifestyle:  'recism4LGdEx0Nh9Q',   // Personal Discretionary Lifestyle — Wants
  tax:        'recS1AiGq8oDEzmZD',   // Personal Tax — Tax bucket
  travel:     'recEvGF5Sr8R9p6tC',   // Personal Travel — Dreams bucket
  cardXfer:   'recdDXNq71YfAuha2',   // placeholder, resolved by name below
  income:     'recPersonalIncomeOther',
};

describe('Money Groups — config classification', () => {
  const s = loadEngine();

  it('budgeted categories are Needs or Wants only', () => {
    const groups = new Set(Object.values(s.PERSONAL_MONEY_GROUPS));
    expect([...groups].sort()).toEqual(['Needs', 'Wants']);
  });

  it('no sub-category is both budgeted and bucket-funded', () => {
    const budgeted = new Set(Object.keys(s.PERSONAL_MONEY_GROUPS));
    const bucketed = [];
    Object.values(s.BUCKET_SPEND_SUBCATS).forEach((list) => bucketed.push(...list));
    const overlap = bucketed.filter((n) => budgeted.has(n));
    expect(overlap).toEqual([]);
  });

  it('the budgeted cash-flow list is exactly the Needs+Wants map', () => {
    expect(s.CASHFLOW_PERSONAL_EXPENSE_SUBCATS.sort())
      .toEqual(Object.keys(s.PERSONAL_MONEY_GROUPS).sort());
  });

  it('bucket categories are absent from the budget table', () => {
    // PERSONAL_EXPENSE_SUBCATS drives the "spend vs budget" table. Travel and Tax
    // used to sit here; they are bucket-funded now and must not be budgeted too.
    const budgetNames = s.PERSONAL_EXPENSE_SUBCATS.map((c) => 'Personal ' + c.name);
    const bucketed = [];
    Object.values(s.BUCKET_SPEND_SUBCATS).forEach((list) => bucketed.push(...list));
    expect(bucketed.filter((n) => budgetNames.includes(n))).toEqual([]);
  });

  it('every budget-table category carries a Money Group', () => {
    s.PERSONAL_EXPENSE_SUBCATS.forEach((c) => {
      expect(['Needs', 'Wants']).toContain(c.group);
    });
  });
});

describe('Money Groups — net cash flow behaviour', () => {
  // Sub-category records keyed by the real IDs, so buildMonthlyCashflow can resolve
  // a link to a name exactly as it does against live Airtable data.
  function subsFor(s) {
    const N = s.SUBCAT.name;
    const named = (id, name, group) => ({ id, fields: { [N]: name, ...(group ? { [s.SUBCAT.moneyGroup]: group } : {}) } });
    return [
      named(SUB.essentials, 'Personal Household Essentials', 'Needs'),
      named(SUB.lifestyle, 'Personal Discretionary Lifestyle', 'Wants'),
      named(SUB.tax, 'Personal Tax'),
      named(SUB.travel, 'Personal Travel'),
      named('recCardXfer', 'Personal Credit Card Transfer'),
      named('recIncomeOther', 'Personal Income Other'),
    ];
  }

  it('a bucket-funded tax payment does NOT reduce net cash flow', () => {
    const s = loadEngine();
    s.__setData([
      tx(s, { date: '2026-06-05', amount: 10000, subId: 'recIncomeOther' }),
      tx(s, { date: '2026-06-10', amount: -6000, subId: SUB.essentials }),
      tx(s, { date: '2026-06-20', amount: -5000, subId: SUB.tax }), // the saved-for lump
    ], subsFor(s));
    const [m] = s.buildMonthlyCashflow(['2026-06']);
    // £10,000 in, £6,000 of Needs out. The £5,000 tax bill is bucket-funded.
    expect(m.net).toBe(4000);
    expect(m.perTotal).toBe(6000);
    expect(m.bucketTotal).toBe(5000);   // still visible, just not deducted
  });

  it('regression: the old behaviour would have gone negative', () => {
    const s = loadEngine();
    s.__setData([
      tx(s, { date: '2026-06-05', amount: 10000, subId: 'recIncomeOther' }),
      tx(s, { date: '2026-06-10', amount: -6000, subId: SUB.essentials }),
      tx(s, { date: '2026-06-20', amount: -5000, subId: SUB.tax }),
    ], subsFor(s));
    const [m] = s.buildMonthlyCashflow(['2026-06']);
    // Before the fix this was 10000 - 6000 - 5000 = -1000, which floored every
    // bucket allocation to £0 for the month. It must be positive now.
    expect(m.net).toBeGreaterThan(0);
  });

  it('Needs and Wants are split, and both still reduce net cash flow', () => {
    const s = loadEngine();
    s.__setData([
      tx(s, { date: '2026-06-05', amount: 8000, subId: 'recIncomeOther' }),
      tx(s, { date: '2026-06-10', amount: -5000, subId: SUB.essentials }),
      tx(s, { date: '2026-06-11', amount: -1000, subId: SUB.lifestyle }),
    ], subsFor(s));
    const [m] = s.buildMonthlyCashflow(['2026-06']);
    expect(m.needsTotal).toBe(5000);
    expect(m.wantsTotal).toBe(1000);
    expect(m.net).toBe(2000);
  });

  it('a refund nets off rather than adding to spend', () => {
    // The Math.abs() failure class: a direct-debit reversal is a POSITIVE amount on
    // an expense category. Adding its magnitude overstates spend instead of
    // cancelling the payment. This bit the personal-expenditure table before.
    const s = loadEngine();
    s.__setData([
      tx(s, { date: '2026-06-10', amount: -2020.20, subId: SUB.essentials }),
      tx(s, { date: '2026-06-12', amount: 2020.20, subId: SUB.essentials }), // bounced, returned
    ], subsFor(s));
    const [m] = s.buildMonthlyCashflow(['2026-06']);
    expect(m.perTotal).toBe(0);
  });
});

describe('Cash-flow drill-down', () => {
  it('indexes the transactions behind every figure', () => {
    const s = loadEngine();
    const N = s.SUBCAT.name, G = s.SUBCAT.moneyGroup;
    s.__setData([
      tx(s, { date: '2026-06-10', amount: -2020.20, subId: 'recEss' }),
      tx(s, { date: '2026-06-12', amount: -180, subId: 'recEss' }),
      tx(s, { date: '2026-06-14', amount: -1000, subId: 'recCardXfer' }),
    ], [
      { id: 'recEss', fields: { [N]: 'Personal Household Essentials', [G]: 'Needs' } },
      { id: 'recCardXfer', fields: { [N]: 'Personal Credit Card Transfer' } },
    ]);
    const [m] = s.buildMonthlyCashflow(['2026-06']);
    const idx = s.getCfTxIndex();
    // The index must reproduce the figure on screen, or the drill-down disagrees
    // with the number that was clicked.
    const sum = list => list.reduce((t, r) => t + Math.abs(r.fields[s.F.txReportAmount]), 0);
    expect(sum(idx['Personal Household Essentials']['2026-06'])).toBeCloseTo(m.perItems['Personal Household Essentials'], 2);
    expect(sum(idx['Personal Credit Card Transfer']['2026-06'])).toBeCloseTo(m.bucketItems['Personal Credit Card Transfer'], 2);
  });

  it('an uncounted transaction is not indexed either', () => {
    // Anything that falls through every classification branch must stay out of the
    // index, or a drill-down would list rows that are in no total on the page.
    const s = loadEngine();
    const N = s.SUBCAT.name;
    s.__setData([tx(s, { date: '2026-06-10', amount: -500, subId: 'recMystery' })],
      [{ id: 'recMystery', fields: { [N]: 'Some Unclassified Thing' } }]);
    s.buildMonthlyCashflow(['2026-06']);
    expect(s.getCfTxIndex()['Some Unclassified Thing']).toBeUndefined();
  });

  it('onclick arguments survive quotes and ampersands in a category name', () => {
    // escHtml is NOT safe in an event-handler attribute: it turns ' into &#39;, and
    // the HTML parser decodes entities BEFORE the JS is parsed, so an apostrophe in
    // a category name closed the string literal and threw a SyntaxError on click.
    // Verified against the old implementation before this test was written.
    const s = loadEngine();
    const rows = [{ label: "Marketing O'Brien \"Ltd\" & Co", values: [100], drill: ["Marketing O'Brien \"Ltd\" & Co"] }];
    const html = s.wealthMatrixCard('t', '', [{ key: '2026-06', label: 'Jun' }], [{ header: '', rows }], {});
    const onclick = /onclick="(wealthDrill\(.*?\))"/.exec(html);
    expect(onclick).not.toBeNull();
    // Decode the attribute the way a browser would, then check it parses as JS.
    const decoded = onclick[1]
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(() => new Function('wealthDrill', decoded)).not.toThrow();
    // And the raw apostrophe must never sit inside a single-quoted JS string.
    expect(onclick[1]).not.toMatch(/'\[/);
  });

  it('a row without a drill key stays non-clickable', () => {
    // wealthMatrixCard is shared with the net-worth, buckets and ratios tables.
    const s = loadEngine();
    const rows = [{ label: 'Net worth', values: [1000] }];
    const html = s.wealthMatrixCard('t', '', [{ key: '2026-06', label: 'Jun' }], [{ header: '', rows }], {});
    expect(html).not.toContain('wealthDrill(');
  });
});

describe('Money Groups — bucket drawdown', () => {
  it('a bounced credit-card payment cancels itself in the Debt bucket', () => {
    // Signed netting, not a date-window heuristic: the reversal lands on the same
    // sub-category, so summing signed amounts cancels the failed payment. Banks word
    // reversals differently, so matching on the description would be fragile.
    const s = loadEngine();
    const N = s.SUBCAT.name;
    s.allSubCategories = [{ id: 'recCardXfer', fields: { [N]: 'Personal Credit Card Transfer' } }];
    s.allTransactions = [
      tx(s, { date: '2026-06-10', amount: -1978.70, subId: 'recCardXfer' }),
      tx(s, { date: '2026-06-12', amount: 1978.70, subId: 'recCardXfer' }), // UNPAID DIRECT DEBIT
    ];
    const months = [{ key: '2026-06', label: 'June 2026' }];
    const [debt] = s.buildBucketBalances([{ name: 'Debt', pct: 50 }], months);
    expect(debt.spent[0]).toBe(0);
  });

  it('a real credit-card payment draws the Debt bucket down', () => {
    const s = loadEngine();
    const N = s.SUBCAT.name;
    s.__setData([tx(s, { date: '2026-06-10', amount: -1000, subId: 'recCardXfer' })], [{ id: 'recCardXfer', fields: { [N]: 'Personal Credit Card Transfer' } }]);
    const months = [{ key: '2026-06', label: 'June 2026' }];
    const [debt] = s.buildBucketBalances([{ name: 'Debt', pct: 50 }], months);
    expect(debt.spent[0]).toBe(1000);
  });

  it('a bounce that returns in the NEXT month still cancels', () => {
    // The common case: a direct debit taken on the 30th and returned on the 2nd.
    // Flooring spend per calendar month would keep the payment and discard the
    // refund, leaving the pot permanently short by the full amount.
    const s = loadEngine();
    const N = s.SUBCAT.name;
    s.__setData([
      tx(s, { date: '2026-06-30', amount: -1978.70, subId: 'recCardXfer' }),
      tx(s, { date: '2026-07-02', amount: 1978.70, subId: 'recCardXfer' }),
    ], [{ id: 'recCardXfer', fields: { [N]: 'Personal Credit Card Transfer' } }]);
    const months = [{ key: '2026-06', label: 'Jun' }, { key: '2026-07', label: 'Jul' }];
    const [debt] = s.buildBucketBalances([{ name: 'Debt', pct: 0 }], months);
    // Nothing ever left the account, so the pot must be untouched by month two.
    expect(debt.balance[1]).toBe(0);
    expect(debt.spent[0] + debt.spent[1]).toBe(0);
  });

  it('a budgeted category ticked into a bucket does NOT double-count', () => {
    // The bucket editor lets any sub-category be ticked. Personal Health is a Need,
    // so it already reduces net cash flow — draining a pot too would count it twice.
    const s = loadEngine();
    const N = s.SUBCAT.name, G = s.SUBCAT.moneyGroup;
    const subs = [{ id: 'recHealth', fields: { [N]: 'Personal Health', [G]: 'Needs' } }];
    s.__setData([tx(s, { date: '2026-06-10', amount: -300, subId: 'recHealth' })], subs);
    const months = [{ key: '2026-06', label: 'Jun' }];
    const [fix] = s.buildBucketBalances([{ name: 'Fix', pct: 10, subs: ['recHealth'] }], months);
    expect(fix.spent[0]).toBe(0);
    const [m] = s.buildMonthlyCashflow(['2026-06']);
    expect(m.perTotal).toBe(300);   // counted once, as a Need
  });

  it('money never vanishes: a bucket category mislabelled Needs still drains its pot', () => {
    // The two functions must agree on bucket membership. If buildBucketBalances
    // treated a code-listed bucket category as budgeted while buildMonthlyCashflow
    // still excluded it from expenditure, a £3,000 holiday would reduce net cash
    // flow by nothing AND drain no pot — invisible in both views.
    const s = loadEngine();
    const N = s.SUBCAT.name, G = s.SUBCAT.moneyGroup;
    // Personal Travel is a Dreams bucket in code, but mislabelled Needs in Airtable.
    const subs = [{ id: 'recTravel', fields: { [N]: 'Personal Travel', [G]: 'Needs' } }];
    s.__setData([tx(s, { date: '2026-06-10', amount: -3000, subId: 'recTravel' })], subs);
    const months = [{ key: '2026-06', label: 'Jun' }];
    const [dreams] = s.buildBucketBalances([{ name: 'Dreams', pct: 20 }], months);
    const [m] = s.buildMonthlyCashflow(['2026-06']);
    expect(dreams.spent[0]).toBe(3000);   // the pot still drains
    expect(m.perTotal).toBe(0);           // and it is not double-counted as a Need
    expect(m.bucketTotal).toBe(3000);
  });

  it('overspend carries forward rather than being forgiven each month', () => {
    const s = loadEngine();
    const N = s.SUBCAT.name;
    s.__setData([
      tx(s, { date: '2026-06-10', amount: 2000, subId: 'recIncomeOther' }),
      tx(s, { date: '2026-06-11', amount: -3000, subId: 'recTravel' }),
      tx(s, { date: '2026-07-10', amount: 2000, subId: 'recIncomeOther' }),
    ], [
      { id: 'recTravel', fields: { [N]: 'Personal Travel' } },
      { id: 'recIncomeOther', fields: { [N]: 'Personal Income Other' } },
    ]);
    const months = [{ key: '2026-06', label: 'Jun' }, { key: '2026-07', label: 'Jul' }];
    const [dreams] = s.buildBucketBalances([{ name: 'Dreams', pct: 10 }], months);
    // £200/mo in, £3,000 out. The pot must stay at £0, not bounce back to £200 in
    // July as if the overspend had been written off at the month boundary.
    expect(dreams.balance[0]).toBe(0);
    expect(dreams.balance[1]).toBe(0);
  });

  it('reads the CARD leg, so an untagged card payment is still counted', () => {
    // Kevin spotted this on 21 Jul 2026: his early-July card payments were missing
    // from the Debt bucket. They were in the base, but reconciliation had coded them
    // plain "Transfer" rather than "Personal Credit Card Transfer", and the bucket
    // only read the cash leg. 41 payments worth £74,971 were invisible.
    // An inflow to a credit-card account IS a payment — no tagging required.
    const s = loadEngine();
    const N = s.SUBCAT.name;
    s.__setData([
      tx(s, { date: '2026-07-06', amount: 1000, subId: 'recTransfer', alias: 'American Express' }),
    ], [{ id: 'recTransfer', fields: { [N]: 'Transfer' } }],
       [{ id: 'recAmex', fields: { [s.F.accountAlias]: 'American Express', [s.F.accNetWorthClass]: 'Credit Card' } }]);
    const months = [{ key: '2026-07', label: 'Jul' }];
    const [debt] = s.buildBucketBalances([{ name: 'Debt', pct: 50 }], months);
    expect(debt.spent[0]).toBe(1000);
  });

  it('does not double-count when BOTH legs are present', () => {
    // The cash leg tagged Personal Credit Card Transfer AND the card-side inflow.
    // Counting both would double the paydown.
    const s = loadEngine();
    const N = s.SUBCAT.name;
    s.__setData([
      tx(s, { date: '2026-06-28', amount: -1024.31, subId: 'recCardXfer', alias: 'Santander' }),
      tx(s, { date: '2026-06-28', amount: 1024.31, subId: 'recTransfer', alias: 'American Express' }),
    ], [
      { id: 'recCardXfer', fields: { [N]: 'Personal Credit Card Transfer' } },
      { id: 'recTransfer', fields: { [N]: 'Transfer' } },
    ], [{ id: 'recAmex', fields: { [s.F.accountAlias]: 'American Express', [s.F.accNetWorthClass]: 'Credit Card' } }]);
    const months = [{ key: '2026-06', label: 'Jun' }];
    const [debt] = s.buildBucketBalances([{ name: 'Debt', pct: 50 }], months);
    expect(debt.spent[0]).toBe(1024); // spend is rounded to whole pounds for display
  });

  it('still counts a card with no feed, from the cash leg alone', () => {
    // Barclaycard has no open-banking feed, so there is no card leg to read. The
    // cash-side tag is the only record and must survive the de-duplication.
    const s = loadEngine();
    const N = s.SUBCAT.name;
    s.__setData([
      tx(s, { date: '2026-07-07', amount: -25, subId: 'recCardXfer', alias: 'Santander' }),
    ], [{ id: 'recCardXfer', fields: { [N]: 'Personal Credit Card Transfer' } }],
       [{ id: 'recAmex', fields: { [s.F.accountAlias]: 'American Express', [s.F.accNetWorthClass]: 'Credit Card' } }]);
    const months = [{ key: '2026-07', label: 'Jul' }];
    const [debt] = s.buildBucketBalances([{ name: 'Debt', pct: 50 }], months);
    expect(debt.spent[0]).toBe(25);
  });

  it('a refund-only month cannot ADD to a pot', () => {
    // Floor at £0: without it a net-positive month would inflate the bucket as if
    // the refund were fresh allocation.
    const s = loadEngine();
    const N = s.SUBCAT.name;
    s.__setData([tx(s, { date: '2026-06-10', amount: 500, subId: 'recTravel' })], [{ id: 'recTravel', fields: { [N]: 'Personal Travel' } }]);
    const months = [{ key: '2026-06', label: 'June 2026' }];
    const [dreams] = s.buildBucketBalances([{ name: 'Dreams', pct: 0 }], months);
    // Spend stays signed (the refund is real), but cumulative spend floors at 0 so
    // no money is conjured into the pot.
    expect(dreams.balance[0]).toBe(0);
  });
});
