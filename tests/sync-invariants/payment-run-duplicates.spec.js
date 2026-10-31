// Invariant: a duplicate on the Payment Run can be found and taken off without
// calling it paid, and a payment reconciled in the reconciliation tab clears its
// row (Kevin, 31 Oct 2026).
//
// Bug: one ground rent bill came in on two approved cards and sat on the list
// twice. The only way off was Mark Paid, so both rows ended up "Paid" on the
// same day for one £6 payment, which "technically isn't true". Nothing on the
// page said the two rows were the same bill, and reconciling the payment did
// nothing to the list.
//
// Fixture shaped from that case, every name and amount invented: the repo is public.

const { test, expect } = require('@playwright/test');
const { loadDashboard, localTodayISO } = require('./helpers');

const INVOICES_TABLE = 'tblkOTKIG2Tyiy9aM';
const F = {
  msgId: 'fldnbLSFMemMuLSzP', payee: 'fldBVAMn9vA1by7MN', desc: 'fldT0onwVg9JDJ1sv',
  amount: 'fldauZCUSWeIfGryG', emailDate: 'fldEpaivUV4uXW3DP', ref: 'fldKq7JbfOIxeu1ai',
  status: 'fldJ5InUPlY4t7MgP', notes: 'fldV2xsw9en67ts0o', paidDate: 'fld9GqL9RlLWPAymx',
  matchedTx: 'fldpHf5vYCIgj3Scz', runDate: 'fldwtlpZOL9oa7OZo',
};
const TX = { amount: 'fldN01r1hp7UQjgtm', vendor: 'fld0Xr8sboQ0ekJQJ', date: 'fldoyQ6Rr9cHp3bgQ' };

const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return localTodayISO(d); };

function row(id, over) {
  return { id, createdTime: new Date().toISOString(), fields: {
    [F.msgId]: id, [F.payee]: over.payee, [F.desc]: over.desc || '', [F.amount]: over.amount,
    [F.emailDate]: over.emailDate || daysAgo(3), [F.ref]: over.ref || '', [F.status]: 'Unpaid',
    [F.notes]: over.notes || '', [F.runDate]: daysAgo(0),
  } };
}

const FIRST = row('recTwinA', { payee: 'Oakbridge Estates Limited', amount: 7, ref: '55120', desc: 'Ground rent, 9 Larch Street', emailDate: daysAgo(30) });
const SECOND = row('recTwinB', { payee: 'INBOUND: Oakbridge ground rent arrears GBP 7.00', amount: 7, desc: 'Oakbridge chases ground rent, 9 Larch Street, pay by Friday' });
const OTHER_HOUSE = row('recOther', { payee: 'Fernway Plumbing Ltd', amount: 90, desc: 'Call-out, 4 Birch Road', ref: '' });
const OTHER_HOUSE2 = row('recOther2', { payee: 'Fernway Plumbing Ltd', amount: 90, desc: 'Call-out, 12 Cedar Place', ref: '' });
const DIFF_REF = row('recRef1', { payee: 'Kestrel Fire Ltd', amount: 72, ref: '40011' });
const DIFF_REF2 = row('recRef2', { payee: 'Kestrel Fire Ltd', amount: 72, ref: '40012' });
const PAYABLE = row('recPay', { payee: 'Hollin Clearances Ltd', amount: 350, ref: 'INV-9001', emailDate: daysAgo(2) });

async function openPaymentRun(page, rows, patches, paidRows = []) {
  await loadDashboard(page);
  await page.route('**/api.airtable.com/v0/**', async (route) => {
    const req = route.request();
    if (!req.url().includes(INVOICES_TABLE)) { await route.fallback(); return; }
    if (req.method() === 'PATCH') {
      patches.push({ url: req.url(), body: req.postDataJSON() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'x', fields: {} }) });
      return;
    }
    // The paid-rows read (for payments already claimed) asks for Status = Paid.
    const paidRead = decodeURIComponent(req.url()).includes("{Status}='Paid'");
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: paidRead ? paidRows : rows }) });
  });
  await page.evaluate(() => switchTab('invoices'));
  await page.evaluate(() => fetchInvoicesFromAirtable());
  await page.waitForFunction(() => document.querySelectorAll('#invoiceTableBody tr[data-record-id]').length > 0);
}

const twinText = (page, id) => page.locator(`tr[data-record-id="${id}"] .inv-twin`);

test.describe('Payment Run: duplicates', () => {
  test('two rows for one bill are both flagged as possible duplicates', async ({ page }) => {
    await openPaymentRun(page, [FIRST, SECOND, PAYABLE], []);
    await expect(twinText(page, 'recTwinA')).toContainText('Possible duplicate of INBOUND: Oakbridge');
    await expect(twinText(page, 'recTwinB')).toContainText('Possible duplicate of Oakbridge Estates Limited');
    await expect(twinText(page, 'recPay')).toHaveCount(0);
  });

  test('a different house or a different reference is never flagged', async ({ page }) => {
    await openPaymentRun(page, [OTHER_HOUSE, OTHER_HOUSE2, DIFF_REF, DIFF_REF2], []);
    for (const id of ['recOther', 'recOther2', 'recRef1', 'recRef2']) await expect(twinText(page, id)).toHaveCount(0);
  });

  test('Duplicate takes the row off as Status Duplicate, never Paid', async ({ page }) => {
    const patches = [];
    await openPaymentRun(page, [FIRST, SECOND], patches);
    page.once('dialog', d => d.accept());
    await page.locator('tr[data-record-id="recTwinB"] .inv-dup-btn').click();
    await expect.poll(() => patches.length).toBe(1);
    const p = patches[0];
    expect(p.url).toContain('recTwinB');
    expect(p.body.fields[F.status]).toBe('Duplicate');
    expect(p.body.fields[F.paidDate]).toBeUndefined();
    expect(p.body.fields[F.notes]).toContain('duplicate of row recTwinA');
    expect(p.body.typecast).toBe(true);
    await expect(page.locator('tr[data-record-id="recTwinB"]')).toHaveCount(0);
    // The row it repeated stays, and no longer reads as a duplicate.
    await expect(page.locator('tr[data-record-id="recTwinA"]')).toHaveCount(1);
    await expect(twinText(page, 'recTwinA')).toHaveCount(0);
  });

  test('the health check names the possible duplicates', async ({ page }) => {
    await openPaymentRun(page, [FIRST, SECOND], []);
    const r = await page.evaluate(() => _syncBars.invoices.checks.find(c => c.name === 'No invoice appears twice').run());
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('Oakbridge Estates Limited');
  });
});

test.describe('Payment Run: a reconciled payment clears its row', () => {
  const tx = (id, amount, vendor, date) => ({ id, fields: { [TX.amount]: amount, [TX.vendor]: vendor, [TX.date]: date } });

  test('the one row the payment pays is marked Paid with the payment linked', async ({ page }) => {
    const patches = [];
    await openPaymentRun(page, [PAYABLE, OTHER_HOUSE], patches);
    const settled = await page.evaluate((t) => window.settlePaymentRunForTransactions([t]), tx('recBankPay', -350, 'HOLLIN CLEARANCES', daysAgo(1)));
    expect(settled.map(s => s.recordId)).toEqual(['recPay']);
    expect(patches).toHaveLength(1);
    expect(patches[0].body.fields[F.status]).toBe('Paid');
    expect(patches[0].body.fields[F.matchedTx]).toEqual(['recBankPay']);
    expect(patches[0].body.fields[F.paidDate]).toBe(daysAgo(1));
  });

  test('a payment that names no payee, or could be either of two bills, clears nothing', async ({ page }) => {
    const patches = [];
    await openPaymentRun(page, [PAYABLE, OTHER_HOUSE, OTHER_HOUSE2], patches);
    // Right amount, wrong payee on the bank line.
    await page.evaluate((t) => window.settlePaymentRunForTransactions([t]), tx('recBank1', -350, 'NATWEST REF 5468110', daysAgo(1)));
    // Fernway's two £90 call-outs: the payment could be either.
    await page.evaluate((t) => window.settlePaymentRunForTransactions([t]), tx('recBank2', -90, 'FERNWAY PLUMBING', daysAgo(1)));
    // Money IN never pays a bill.
    await page.evaluate((t) => window.settlePaymentRunForTransactions([t]), tx('recBank3', 350, 'HOLLIN CLEARANCES', daysAgo(1)));
    expect(patches).toHaveLength(0);
  });

  // Review, 31 Oct 2026: the open twin was cleared with money that already belonged to a paid bill.
  const paidRow = (id, over) => ({ id, fields: { [F.payee]: over.payee, [F.amount]: over.amount, [F.status]: 'Paid',
    [F.paidDate]: over.paidDate, ...(over.tx ? { [F.matchedTx]: [over.tx] } : {}) } });

  test('a payment already linked to a paid bill never clears another row', async ({ page }) => {
    const patches = [];
    await openPaymentRun(page, [PAYABLE], patches, [paidRow('recOctPaid', { payee: 'Hollin Clearances Ltd', amount: 350, paidDate: daysAgo(3), tx: 'recBankPay' })]);
    await page.evaluate((t) => window.settlePaymentRunForTransactions([t]), tx('recBankPay', -350, 'HOLLIN CLEARANCES', daysAgo(1)));
    expect(patches).toHaveLength(0);
  });

  test('a payment that looks like a bill marked paid on its card (no payment linked yet) is left for that bill', async ({ page }) => {
    const patches = [];
    await openPaymentRun(page, [PAYABLE], patches, [paidRow('recCardPaid', { payee: 'Hollin Clearances Ltd', amount: 350, paidDate: daysAgo(2) })]);
    await page.evaluate((t) => window.settlePaymentRunForTransactions([t]), tx('recBankPay', -350, 'HOLLIN CLEARANCES', daysAgo(1)));
    expect(patches).toHaveLength(0);
  });
});
