import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// ── Income buckets: the pot must be a balance, not a rolling window ──────────
//
// What shipped, and what Kevin actually saw on 14 Aug 2026:
//
//   Debt   in £12,169   spent £30,691   IN THE POT £0
//   Dreams in  £3,478   spent  £8,559   IN THE POT £0
//   Fix    in  £1,738   spent    £811   IN THE POT £927
//
// Four of five pots read £0 and the fifth could not be trusted. Three causes,
// each guarded below:
//
//  1. The cumulative run RESET at the left edge of the rolling 12-month window.
//     So a pot's balance changed every month even when no money moved — Fix read
//     £927 on the window ending Aug 2026 and £1,059 on the window ending Jul 2026.
//     A savings pot that drops because a month scrolled off is not a balance.
//  2. Monthly allocation was floored at £0, so a negative-cash-flow month put
//     nothing in and took nothing out. Eight of the twelve months were negative,
//     so spending ran on against pots that were never funded, and the overspend
//     (dragged in from before buckets even existed) pinned them at £0 for years.
//  3. `buckets.some(b => b.subs)` decided globally whether to apply the
//     BUCKET_SPEND_SUBCATS defaults. An empty array is TRUTHY, so adding one
//     bucket with nothing ticked silently dropped every default mapping.
//
// The fix: each bucket has a Start Date and an Opening Balance. The run starts
// there, allocation is signed, and the pot may go negative.
//
// These run against the REAL config.js + wealth.js source, not a copy.

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
  vm.runInContext(`Object.assign(globalThis, {
    F, SUBCAT, BUCKET, BUCKET_SPEND_SUBCATS, BUCKET_DEFAULT_START,
    buildBucketBalances, bucketStartKey, renderBuckets, wealthCompletedIdx, wealthMonths12,
    bucketSubsDropdown, personalMoneyGroups,
  })`, sandbox);
  vm.runInContext(`globalThis.__setData = (t, sc, ac, bk) => {
    allTransactions = t; allSubCategories = sc; allAccounts = ac || []; _bucketsRecords = bk || null;
  }`, sandbox);
  return sandbox;
}

// Sub-categories, by the names the code maps to buckets in BUCKET_SPEND_SUBCATS.
const SUBS = [
  { id: 'recTravel', name: 'Personal Travel' },          // Dreams
  { id: 'recMaint', name: 'Personal Maintenance' },      // Fix
  { id: 'recIncome', name: 'Personal Income Other' },  // income, feeds net cash flow
  { id: 'recEssent', name: 'Personal Household Essentials' }, // Needs — budgeted
];

function subRecords(sandbox) {
  const { SUBCAT } = sandbox;
  return SUBS.map((s) => ({
    id: s.id,
    fields: {
      [SUBCAT.name]: s.name,
      ...(s.name === 'Personal Household Essentials' ? { [SUBCAT.moneyGroup]: 'Needs' } : {}),
    },
  }));
}

function tx(sandbox, { date, amount, subId }) {
  const { F } = sandbox;
  return { id: 'rec' + Math.random().toString(36).slice(2), fields: {
    [F.txDate]: date, [F.txReportAmount]: amount, [F.txSubCategory]: [subId],
  } };
}

const months = (keys) => keys.map((k) => ({ key: k, label: k }));

describe('bucketStartKey', () => {
  const s = loadEngine();
  it('takes the month from an ISO date', () => {
    expect(s.bucketStartKey('2026-05-01')).toBe('2026-05');
    expect(s.bucketStartKey('2026-05-31T00:00:00.000Z')).toBe('2026-05');
  });
  it('falls back to the configured default when blank or junk', () => {
    const fallback = s.BUCKET_DEFAULT_START.slice(0, 7);
    expect(s.bucketStartKey('')).toBe(fallback);
    expect(s.bucketStartKey(null)).toBe(fallback);
    expect(s.bucketStartKey('not a date')).toBe(fallback);
  });
  it('the default start is Kevin\'s 1 May 2026 decision', () => {
    expect(s.BUCKET_DEFAULT_START).toBe('2026-05-01');
  });
});

describe('Income buckets — the pot is a balance, not a window', () => {
  // £1,000 of income and £100 of travel every month, Jan–Jun. Dreams takes 50%.
  function setup(sandbox) {
    const t = [];
    ['01', '02', '03', '04', '05', '06'].forEach((m) => {
      t.push(tx(sandbox, { date: `2026-${m}-05`, amount: 1000, subId: 'recIncome' }));
      t.push(tx(sandbox, { date: `2026-${m}-20`, amount: -100, subId: 'recTravel' }));
    });
    sandbox.__setData(t, subRecords(sandbox), [], null);
  }

  it('THE REGRESSION: a month\'s balance is the same whichever window it is viewed in', () => {
    const s = loadEngine();
    setup(s);
    const bucket = [{ name: 'Dreams', pct: 50, start: '2026-01-01', opening: 0 }];
    // April's balance, seen from a window ending in April vs one ending in June.
    const shortWin = s.buildBucketBalances(bucket, months(['2026-02', '2026-03', '2026-04']))[0];
    const longWin = s.buildBucketBalances(bucket, months(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']))[0];
    const aprilShort = shortWin.balance[shortWin.balance.length - 1];
    const aprilLong = longWin.balance[3];
    expect(aprilShort).toBe(aprilLong);
    // And it is the real cumulative from January: 4 x (500 - 100).
    expect(aprilLong).toBe(1600);
  });

  it('months before the start date are null, not £0', () => {
    const s = loadEngine();
    setup(s);
    const [b] = s.buildBucketBalances(
      [{ name: 'Dreams', pct: 50, start: '2026-04-01', opening: 0 }],
      months(['2026-02', '2026-03', '2026-04', '2026-05']));
    expect(b.balance.slice(0, 2)).toEqual([null, null]);
    expect(b.appor.slice(0, 2)).toEqual([null, null]);
    expect(b.spent.slice(0, 2)).toEqual([null, null]);
    // A £0 here would read as "we allocated nothing", which is a different claim.
    expect(b.balance[2]).toBe(400);
  });

  it('spend before the start date is not carried forward', () => {
    const s = loadEngine();
    // £5,000 of travel in January, then nothing but income.
    const t = [tx(s, { date: '2026-01-10', amount: -5000, subId: 'recTravel' })];
    ['02', '03'].forEach((m) => t.push(tx(s, { date: `2026-${m}-05`, amount: 1000, subId: 'recIncome' })));
    s.__setData(t, subRecords(s), [], null);
    const win = months(['2026-01', '2026-02', '2026-03']);
    const started = s.buildBucketBalances([{ name: 'Dreams', pct: 50, start: '2026-02-01', opening: 0 }], win)[0];
    expect(started.balance[2]).toBe(1000);           // 2 x £500, January ignored
    const fromJan = s.buildBucketBalances([{ name: 'Dreams', pct: 50, start: '2026-01-01', opening: 0 }], win)[0];
    expect(fromJan.balance[2]).toBe(-4000);          // the old deficit, carried
  });

  it('the opening balance is where the run starts', () => {
    const s = loadEngine();
    setup(s);
    const [b] = s.buildBucketBalances(
      [{ name: 'Dreams', pct: 50, start: '2026-05-01', opening: 2500 }],
      months(['2026-04', '2026-05', '2026-06']));
    expect(b.balance).toEqual([null, 2900, 3300]);   // 2500 + (500-100) each month
  });

  it('a negative cash-flow month draws every pot DOWN, it does not just add £0', () => {
    const s = loadEngine();
    // Feb has no income but £600 of budgeted essentials, so net cash flow is negative.
    const t = [
      tx(s, { date: '2026-01-05', amount: 1000, subId: 'recIncome' }),
      tx(s, { date: '2026-02-15', amount: -600, subId: 'recEssent' }),
    ];
    s.__setData(t, subRecords(s), [], null);
    const [b] = s.buildBucketBalances(
      [{ name: 'Dreams', pct: 50, start: '2026-01-01', opening: 0 }],
      months(['2026-01', '2026-02']));
    expect(b.appor).toEqual([500, -300]);
    expect(b.balance).toEqual([500, 200]);
    // Before the fix appor[1] was Math.max(0, ...) = 0 and the pot stayed at 500,
    // overstating what was actually set aside.
  });

  it('a pot may go negative — overspending it is information, not something to hide', () => {
    const s = loadEngine();
    const t = [
      tx(s, { date: '2026-01-05', amount: 1000, subId: 'recIncome' }),
      tx(s, { date: '2026-01-20', amount: -900, subId: 'recTravel' }),
    ];
    s.__setData(t, subRecords(s), [], null);
    const [b] = s.buildBucketBalances(
      [{ name: 'Dreams', pct: 50, start: '2026-01-01', opening: 0 }],
      months(['2026-01']));
    expect(b.balance[0]).toBe(-400);   // 500 in, 900 out
  });

  it('a refund with no matching spend cannot conjure money into a pot', () => {
    const s = loadEngine();
    const t = [
      tx(s, { date: '2026-01-05', amount: 1000, subId: 'recIncome' }),
      tx(s, { date: '2026-01-20', amount: 250, subId: 'recTravel' }),  // inflow: a refund
    ];
    s.__setData(t, subRecords(s), [], null);
    const [b] = s.buildBucketBalances(
      [{ name: 'Dreams', pct: 50, start: '2026-01-01', opening: 0 }],
      months(['2026-01']));
    expect(b.spent[0]).toBe(-250);     // shown as money coming back
    expect(b.balance[0]).toBe(500);    // but cumulative spend floors at 0, so no windfall
  });
});

describe('Income buckets — category mapping', () => {
  it('THE REGRESSION: a bucket with nothing ticked does not wipe the others', () => {
    const s = loadEngine();
    const t = [
      tx(s, { date: '2026-06-05', amount: 1000, subId: 'recIncome' }),
      tx(s, { date: '2026-06-20', amount: -100, subId: 'recTravel' }),
    ];
    s.__setData(t, subRecords(s), [], null);
    const win = months(['2026-06']);
    const base = [{ name: 'Dreams', pct: 50, start: '2026-01-01', opening: 0 }];
    const alone = s.buildBucketBalances(base, win)[0];
    expect(alone.spent[0]).toBe(100);  // via the BUCKET_SPEND_SUBCATS default
    // Add a brand-new bucket whose subs array is empty. `[]` is truthy, and the old
    // code read that as "explicit mappings are in play" for EVERY bucket, so Dreams
    // lost its default and its Spent row dropped to zero.
    const withNew = s.buildBucketBalances(
      base.concat([{ name: 'Zzz', pct: 0, start: '2026-01-01', opening: 0, subs: [] }]), win);
    expect(withNew[0].spent[0]).toBe(100);
    expect(withNew[1].spent[0]).toBe(0);
  });

  it('an explicit tick replaces that bucket\'s default, and only that bucket\'s', () => {
    const s = loadEngine();
    const t = [
      tx(s, { date: '2026-06-05', amount: 1000, subId: 'recIncome' }),
      tx(s, { date: '2026-06-20', amount: -100, subId: 'recTravel' }),
      tx(s, { date: '2026-06-21', amount: -70, subId: 'recMaint' }),
    ];
    s.__setData(t, subRecords(s), [], null);
    const win = months(['2026-06']);
    const out = s.buildBucketBalances([
      // Dreams defaults to Travel; tick Maintenance instead.
      { name: 'Dreams', pct: 50, start: '2026-01-01', opening: 0, subs: ['recMaint'] },
      { name: 'Debt', pct: 50, start: '2026-01-01', opening: 0 },
    ], win);
    expect(out[0].spent[0]).toBe(70);   // Maintenance, not the £100 of Travel
    expect(out[1].spent[0]).toBe(0);    // Debt's default is card transfers; none here
  });

  it('a budgeted (Needs/Wants) category can never drain a pot, even if ticked', () => {
    const s = loadEngine();
    const t = [
      tx(s, { date: '2026-06-05', amount: 1000, subId: 'recIncome' }),
      tx(s, { date: '2026-06-18', amount: -300, subId: 'recEssent' }),
    ];
    s.__setData(t, subRecords(s), [], null);
    const [b] = s.buildBucketBalances(
      [{ name: 'Dreams', pct: 50, start: '2026-01-01', opening: 0, subs: ['recEssent'] }],
      months(['2026-06']));
    // Essentials already reduced net cash flow; draining the pot too would double-count.
    expect(b.spent[0]).toBe(0);
    expect(b.appor[0]).toBe(350);       // 50% of (1000 - 300)
  });
});

describe('Income buckets — what the grid shows', () => {
  // Kevin's ruling, 15 Aug 2026 (second revision): TWO headline figures per pot.
  // "In the pot" is locked at the end of the last completed month and does not move
  // all month; "Right now" is the live balance, fluctuating day by day from both the
  // money-in side (share of month-to-date net cash flow) and the spend side (as
  // transactions reconcile). At the rollover the live figure becomes the locked one.
  // Locked-only froze daily budgeting; live-only had no stable reference. Both.
  it('locked "In the pot" holds still while live "Right now" moves with today\'s spend', () => {
    const s = loadEngine();
    const now = new Date();
    const key = (back) => {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };
    // £1,000 income in the last completed month AND in the current one.
    const t = [
      tx(s, { date: key(1) + '-05', amount: 1000, subId: 'recIncome' }),
      tx(s, { date: key(0) + '-05', amount: 1000, subId: 'recIncome' }),
    ];
    s.__setData(t, subRecords(s), [], null);
    // Locked cell: accent-soft + semibold. Live cell: bg-subtle + semibold (the month
    // columns also use bg-subtle, but with `color:` following, never `font-weight:`).
    const lockedOf = (html) => {
      const m = html.match(/background:var\(--accent-soft\);font-weight:var\(--fw-semibold\);color:[^"]*">([^<]*)</);
      return m && m[1];
    };
    const liveOf = (html) => {
      const m = html.match(/background:var\(--bg-subtle\);font-weight:var\(--fw-semibold\);color:[^"]*">([^<]*)</);
      return m && m[1];
    };
    const el = { innerHTML: '' };
    const bucket = [{ name: 'Dreams', pct: 50, start: key(2) + '-01', opening: 0 }];
    s.renderBuckets(el, bucket);
    expect(el.innerHTML).toContain('In the pot');
    expect(el.innerHTML).toContain('Right now');
    // Locked = completed month's £500. Live = that plus the current month's £500.
    expect(lockedOf(el.innerHTML)).toBe('£500');
    expect(liveOf(el.innerHTML)).toBe('£1,000');
    // THE GUARD: a spend synced TODAY moves the live figure and ONLY the live figure.
    t.push(tx(s, { date: key(0) + '-15', amount: -300, subId: 'recTravel' }));
    s.__setData(t, subRecords(s), [], null);
    const el2 = { innerHTML: '' };
    s.renderBuckets(el2, bucket);
    expect(lockedOf(el2.innerHTML)).toBe('£500');
    expect(liveOf(el2.innerHTML)).toBe('£700');
  });

  it('the balance is the headline row and the workings sit underneath it', () => {
    const s = loadEngine();
    s.__setData([], subRecords(s), [], null);
    const el = { innerHTML: '' };
    s.renderBuckets(el, [{ name: 'Dreams', pct: 50, start: '2026-01-01', opening: 0 }]);
    expect(el.innerHTML).toContain('Money in');
    expect(el.innerHTML).toContain('Spent');
    // "Running balance" was a hidden child row, which is why Kevin could not see it.
    expect(el.innerHTML).not.toContain('Running balance');
  });
});

// ── Fixes for the four defects the code review found in the first cut ─────────
describe('Income buckets — review fixes', () => {
  it('two buckets sharing a name keep their own balance and their own spend', () => {
    const s = loadEngine();
    s.__setData([
      tx(s, { date: '2026-06-05', amount: 1000, subId: 'recIncome' }),
      tx(s, { date: '2026-06-20', amount: -300, subId: 'recTravel' }),
    ], subRecords(s), [], null);
    const out = s.buildBucketBalances([
      { name: 'Dreams', pct: 50, start: '2026-01-01', opening: 0 },
      { name: 'Dreams', pct: 20, start: '2026-01-01', opening: 0 },
    ], months(['2026-06']));
    // Each bucket keeps its own allocation.
    expect(out[0].appor[0]).toBe(500);
    expect(out[1].appor[0]).toBe(200);
    // The £300 of travel drains exactly ONE pot. A category maps to a single bucket by
    // design — charging both would double-count the same spend, which is the thing the
    // budgets-vs-buckets split exists to prevent.
    expect(out[0].spent[0] + out[1].spent[0]).toBe(300);
    expect(out[0].balance[0]).toBe(500);
    expect(out[1].balance[0]).toBe(-100);
    // The grid must render two DISTINCT balances. Keyed by name, both rows collapsed
    // onto the second bucket and showed "£-100" twice against a total of "£100".
    const el = { innerHTML: '' };
    s.renderBuckets(el, [
      { name: 'Dreams', pct: 50, start: '2026-01-01', opening: 0 },
      { name: 'Dreams', pct: 20, start: '2026-01-01', opening: 0 },
    ]);
    const leads = [...el.innerHTML.matchAll(/accent-soft\);font-weight:var\(--fw-semibold\);color:[^"]*">([^<]*)</g)].map(m => m[1]);
    expect(leads).toEqual(['£500', '£-100', '£400']);
  });

  it('the FIRST bucket still collects its transactions (position 0 is falsy)', () => {
    const s = loadEngine();
    s.__setData([
      tx(s, { date: '2026-06-05', amount: 1000, subId: 'recIncome' }),
      tx(s, { date: '2026-06-20', amount: -300, subId: 'recTravel' }),
    ], subRecords(s), [], null);
    // Dreams is at index 0. A truthiness check on the bucket index would drop it.
    const [dreams] = s.buildBucketBalances(
      [{ name: 'Dreams', pct: 50, start: '2026-01-01', opening: 0 }], months(['2026-06']));
    expect(dreams.spent[0]).toBe(300);
  });

  it('a budgeted category that is already linked survives a save', () => {
    const s = loadEngine();
    s.__setData([], subRecords(s), [], null);
    // recEssent is Money Group = Needs, so it renders disabled. If it was linked, the
    // markup must still carry its id or saving would delete the link from Airtable.
    const html = s.bucketSubsDropdown(['recTravel', 'recEssent']);
    expect(html).toContain('be-sub-locked');
    expect(html).toContain('value="recEssent"');
    // The count must match what bucketSubsCount() recomputes from .be-sub-cb:checked,
    // i.e. only the categories that actually draw the pot down.
    expect(html).toMatch(/be-subs-count">1</);
    expect((html.match(/class="be-sub-cb"/g) || []).length).toBe(3);
  });

  it('an empty bucket list does not print "start date ()"', () => {
    const s = loadEngine();
    s.__setData([], subRecords(s), [], null);
    const el = { innerHTML: '' };
    s.renderBuckets(el, []);
    expect(el.innerHTML).not.toContain('start date ()');
    expect(el.innerHTML).toContain('No buckets are set up yet');
  });
});
