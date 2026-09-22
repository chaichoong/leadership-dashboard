// Invariant: the Payment Run tab must go RED when its weekly feed stops.
//
// The bug this exists for did not throw, log, or look wrong. The old AP
// Variable feed synced the Gmail label "3: to pay" into Dashboard Invoices.
// Kevin stopped applying that label, so the label held zero messages, the sync
// found nothing to do, and the newest row in the table stayed dated 10 Jul 2026
// for SEVENTY DAYS. Every health check on the tab passed the whole time,
// because every one of them asked "is this data well formed" and not one asked
// "did the feed actually run". A dead pipeline and a quiet week are
// indistinguishable unless something measures the clock.
//
// So: MAX(Run Date) across the table is the liveness signal, and a run older
// than PAYMENT_RUN_STALE_DAYS fails the check rather than warning. The other
// tests here guard the two things that make the list trustworthy — that a
// changed sort code interrupts, and that the week is split the way the scan
// filed it.

const { test, expect } = require('@playwright/test');
const { loadDashboard, localTodayISO } = require('./helpers');

const INVOICES_TABLE = 'tblkOTKIG2Tyiy9aM';
const F = {
  msgId: 'fldnbLSFMemMuLSzP',
  payee: 'fldBVAMn9vA1by7MN',
  desc: 'fldT0onwVg9JDJ1sv',
  amount: 'fldauZCUSWeIfGryG',
  emailDate: 'fldEpaivUV4uXW3DP',
  ref: 'fldKq7JbfOIxeu1ai',
  status: 'fldJ5InUPlY4t7MgP',
  gmailUrl: 'fldeFqA4TVNzDEMCh',
  payTo: 'fldLUPVZHAEbsNJb1',
  runDate: 'fldwtlpZOL9oa7OZo',
  bankChanged: 'fldom7XtxiN9ojCKi',
};

// Local date parts, not toISOString(): UTC is the previous day before 01:00
// in BST, so "8 days ago" became 9 and the 8-day test failed for that hour.
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localTodayISO(d);
};

function invoice(id, over = {}) {
  return {
    id,
    createdTime: new Date().toISOString(),
    fields: {
      [F.msgId]: over.msgId || id,
      [F.payee]: over.payee || 'Priority Response Group LTD',
      [F.desc]: over.desc || 'Gas safety certificate',
      [F.amount]: over.amount === undefined ? 90 : over.amount,
      [F.emailDate]: over.emailDate || daysAgo(1),
      [F.ref]: over.ref || '0004/09/2026',
      [F.status]: 'Unpaid',
      [F.gmailUrl]: 'https://mail.google.com/mail/u/0/#all/abc',
      [F.payTo]: over.payTo === undefined ? 'Sort Code 12-34-56\nAccount Number 12345678' : over.payTo,
      [F.runDate]: over.runDate === undefined ? daysAgo(0) : over.runDate,
      [F.bankChanged]: !!over.bankChanged,
    },
  };
}

// Serve the invoices table from `rows`; everything else falls through to the
// standard fixture mock. Registered AFTER loadDashboard() — Playwright matches
// the most recently registered handler first, so routing before it is shadowed.
async function routeInvoices(page, rows) {
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    const url = route.request().url();
    if (!url.includes(INVOICES_TABLE) || route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ records: rows }),
    });
  });
}

// `at` freezes the page's clock before the tab renders, for tests whose answer
// depends on where "now" falls against the Friday 21:00 cutoff.
async function openPaymentRun(page, rows, at) {
  await loadDashboard(page);
  if (at) await page.clock.setFixedTime(at);
  await routeInvoices(page, rows);
  await page.evaluate(() => switchTab('invoices'));
  await page.evaluate(() => fetchInvoicesFromAirtable());
  await page.waitForFunction(() => document.querySelectorAll('#invoiceTableBody tr').length > 0);
}

// Run one registered health check by name and return its result.
// `_syncBars` is a top-level const in js/sync-bar.js — not on `window`, but in
// the global lexical scope, so it resolves inside page.evaluate.
async function runCheck(page, name) {
  return page.evaluate((checkName) => {
    const bar = _syncBars && _syncBars.invoices;
    const checks = (bar && bar.checks) || [];
    const check = checks.find((c) => c.name === checkName);
    if (!check) return { missing: true, names: checks.map((c) => c.name) };
    return check.run();
  }, name);
}

const STALE_CHECK = 'Weekly payment run is current';

test.describe('Payment Run staleness', () => {
  test('a fresh run passes', async ({ page }) => {
    await openPaymentRun(page, [invoice('rec1', { runDate: daysAgo(0) })]);
    const result = await runCheck(page, STALE_CHECK);
    expect(result.missing, `check not registered; found ${JSON.stringify(result.names)}`).toBeFalsy();
    expect(result.status).toBe('pass');
  });

  test('a run 9 days old FAILS — one missed Friday is the whole signal', async ({ page }) => {
    // 8 days is the threshold: a weekly run plus a day of slack. At 9 days a
    // Friday has definitely been missed, and Kevin finds out within a week
    // instead of after seventy days.
    await openPaymentRun(page, [invoice('rec1', { runDate: daysAgo(9) })]);
    const result = await runCheck(page, STALE_CHECK);
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/stopped|out of date/i);
  });

  test('still passes at 8 days, so it does not cry wolf on a late run', async ({ page }) => {
    await openPaymentRun(page, [invoice('rec1', { runDate: daysAgo(8) })]);
    expect((await runCheck(page, STALE_CHECK)).status).toBe('pass');
  });

  test('no Run Date anywhere FAILS — the scan has never completed', async ({ page }) => {
    // This is the exact shape of the 70-day outage: rows present, well formed,
    // nothing stamped. It must not read as healthy.
    await openPaymentRun(page, [invoice('rec1', { runDate: null })]);
    const result = await runCheck(page, STALE_CHECK);
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/never/i);
  });

  test('the staleness is stated on the page, not only in the sync bar', async ({ page }) => {
    await openPaymentRun(page, [invoice('rec1', { runDate: daysAgo(30) })]);
    const header = await page.textContent('#tab-invoices .section span');
    expect(header).toMatch(/the weekly scan has stopped/i);
  });

  // The age is counted in calendar days. Counted in elapsed hours, the 25-hour
  // day when the clocks go back made an 8-day-old run read as 9 from 23:00 to
  // midnight all that week, and the 23-hour day in spring made a 9-day-old run
  // read as 8 from midnight to 01:00. Frozen at those hours, in London.
  test.describe('across a clock change', () => {
    test.use({ timezoneId: 'Europe/London' });

    test('8 days after the clocks go back still passes at 23:30', async ({ page }) => {
      await openPaymentRun(page, [invoice('rec1', { runDate: '2026-10-18' })], '2026-10-26T23:30:00+00:00');
      expect((await runCheck(page, STALE_CHECK)).status).toBe('pass');
    });

    test('9 days after the clocks go forward still FAILS at 00:30', async ({ page }) => {
      await openPaymentRun(page, [invoice('rec1', { runDate: '2027-03-28' })], '2027-04-06T00:30:00+01:00');
      expect((await runCheck(page, STALE_CHECK)).status).toBe('fail');
    });
  });
});

test.describe('Payment Run list', () => {
  test('a changed sort code interrupts rather than sitting in a column', async ({ page }) => {
    // Supplier payment-redirection fraud is the one way this list could cost
    // real money, and it looks exactly like an ordinary invoice.
    await openPaymentRun(page, [invoice('rec1', { bankChanged: true, payee: 'Acme Roofing' })]);
    const body = await page.textContent('#invoiceTableBody');
    expect(body).toMatch(/Bank details are different/i);
    expect(body).toMatch(/Check with them by phone/i);
    const result = await runCheck(page, 'No payee has changed bank details');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('Acme Roofing');
  });

  // Kevin, 18 Sep 2026, just past the 9pm cutoff with the week's invoices
  // still unpaid: what he was about to pay had dropped out of "This week" and
  // into "Still owed" beside February's debts. A row from the week before the
  // last cutoff must land in "Last week", the run he is actually paying.
  //
  // The sections are anchored on the Friday 21:00 cutoff, not on today, so the
  // clock is frozen and the dates are fixed. With "4 days ago" instead, the
  // test passed Friday night to Monday and failed Tuesday to Friday: on Tuesday
  // 22 Sep, 4 days ago is the cutoff Friday itself, which counts as This week.
  // London is pinned because the cutoff is 21:00 London, whatever the host is.
  //
  // A row dated a boundary Friday belongs to the newer section, by design
  // (bucket_rows() in scripts/payment-run.py).
  const MOMENTS = [
    { when: 'six minutes past the Friday cutoff', at: '2026-09-18T21:06:00+01:00',
      thisWeek: '2026-09-18', lastWeek: '2026-09-14', stillOwed: '2026-02-12' },
    // One minute earlier the same 14 Sep row is still This week. No real
    // clock after 21:00 on 18 Sep gives this split, so it proves the freeze works.
    { when: 'one minute before the Friday cutoff', at: '2026-09-18T20:59:00+01:00',
      thisWeek: '2026-09-14', lastWeek: '2026-09-04', stillOwed: '2026-09-03' },
    { when: 'on a Tuesday night mid-week', at: '2026-09-22T23:00:00+01:00',
      thisWeek: '2026-09-18', lastWeek: '2026-09-16', stillOwed: '2026-02-12' },
  ];

  test.describe('at a fixed moment', () => {
    test.use({ timezoneId: 'Europe/London' });

    for (const m of MOMENTS) {
      test(`splits the list into three sections, with last week its own, ${m.when}`, async ({ page }) => {
        await openPaymentRun(page, [
          invoice('recNew', { emailDate: m.thisWeek, amount: 90, payee: 'Arrived Since Cutoff Ltd', runDate: '2026-09-18' }),
          invoice('recLast', { emailDate: m.lastWeek, amount: 300, payee: 'Paying Tonight Ltd', runDate: '2026-09-18' }),
          invoice('recOld', { emailDate: m.stillOwed, amount: 2450, payee: 'Edna Example', runDate: '2026-09-18' }),
        ], m.at);
        // Section headers and payees in page order. Every row must be present:
        // an indexOf check alone passes when a row lands in no section at all.
        const order = await page.$$eval('#invoiceTableBody tr', (rows) =>
          rows.map((r) => (r.classList.contains('inv-section-header')
            ? r.textContent.trim().split('\n')[0].trim()
            : (r.querySelector('input[data-field]') || {}).value || '')).filter(Boolean));
        expect(order).toEqual([
          'This week', 'Arrived Since Cutoff Ltd',
          'Last week', 'Paying Tonight Ltd',
          'Still owed', 'Edna Example',
        ]);
      });
    }
  });

  test('carries the older payables forward under Still owed', async ({ page }) => {
    await openPaymentRun(page, [
      invoice('recNew', { emailDate: daysAgo(1), amount: 90 }),
      invoice('recOld', { emailDate: daysAgo(120), amount: 2450, payee: 'Edna Example' }),
    ]);
    const body = await page.textContent('#invoiceTableBody');
    expect(body).toContain('This week');
    expect(body).toContain('Still owed');
    expect(body).toContain('£90.00');
    expect(body).toContain('£2,450.00');
    // The old one is carried forward, not dropped — this is the thing Kevin
    // asked about at the gate: rebuilding the tab must not lose the historic
    // payables. The payee lives in an <input value>, which textContent never
    // returns, so it is read off the field rather than the rendered text.
    const payees = await page.$$eval('#invoiceTableBody input[data-field]', (els) =>
      els.map((e) => e.value).filter(Boolean));
    expect(payees).toContain('Edna Example');
    // And it is in the SECOND section, not mixed into this week's list.
    const order = await page.$$eval('#invoiceTableBody tr', (rows) =>
      rows.map((r) => (r.classList.contains('inv-section-header')
        ? r.textContent.trim().split('\n')[0].trim()
        : (r.querySelector('input[data-field]') || {}).value || '')).filter(Boolean));
    expect(order.indexOf('Edna Example')).toBeGreaterThan(order.indexOf('Still owed'));
  });

  test('the bank details Kevin pays from are on screen', async ({ page }) => {
    await openPaymentRun(page, [invoice('rec1')]);
    const body = await page.textContent('#invoiceTableBody');
    expect(body).toContain('12-34-56');
    expect(body).toContain('12345678');
  });

  test('a duplicated Gmail message fails the no-duplicates check', async ({ page }) => {
    // 50 of 144 message ids were duplicated under the old feed, so every
    // invoice sat on the list twice.
    await openPaymentRun(page, [
      invoice('rec1', { msgId: 'same' }),
      invoice('rec2', { msgId: 'same' }),
    ]);
    const result = await runCheck(page, 'No invoice appears twice');
    expect(result.status).toBe('fail');
  });
});
