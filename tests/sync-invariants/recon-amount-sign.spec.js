// Invariant: the reconciliation Amount column must show money IN vs money OUT
//
// Bug (Aug 2026): the Amount cell rendered `fmt(Math.abs(r.txAmount))`. `fmt` ALREADY
// strips the sign (`'£' + Math.abs(n)`), so the second Math.abs was a no-op on top of a
// no-op — either way the minus never reached the screen. The only remaining signal was
// the .text-green / .text-red class, and that lost a specificity fight it was never
// meant to be in: `.od-table td { color: var(--text-primary) }` scores (0,1,1) against a
// bare `.text-red` at (0,1,0), so every amount rendered in plain body text. A £1,742.60
// refund and a £1,742.60 bill were pixel-identical while Kevin approved them one by one.
//
// Two things are being locked down here, and BOTH matter:
//   1. The sign lives in the TEXT. Colour alone is not a signal — it is unreadable to a
//      colour-blind user and, as this bug proved, one CSS rule away from vanishing.
//   2. The colour still resolves to the danger/success tokens inside .od-table. This is
//      the half a text-only assertion would miss, and the half that regressed silently.
//
// This calls the REAL window.reconRowHtml and reads getComputedStyle against the REAL
// stylesheet. Asserting on a copy of the markup would pass while the shipped page broke.

const { test, expect } = require('@playwright/test');
const { loadDashboardWithFixtures, FIELDS } = require('./helpers');

// Only the fields reconRowHtml actually reads.
const row = (txAmount) => ({
  txId: 'recTest1', txDate: '2026-08-01', txAccount: 'Barclays',
  txVendor: 'Test Vendor', txDesc: 'test description', txAmount,
  categoryId: '', subCatId: '', businessId: '', tenantId: '',
  tenancyId: '', unitId: '', propertyId: '', costId: '', status: '', matchType: '',
});

// Render through the shipped function, inside a real .od-table, and report what the
// browser resolves — text and computed colour, exactly as Kevin's eye receives it.
async function renderAmountCell(page, txAmount) {
  return page.evaluate((r) => {
    const host = document.createElement('table');
    host.className = 'od-table';
    host.innerHTML = '<tbody>' + window.reconRowHtml(r, 0) + '</tbody>';
    document.body.appendChild(host);
    const cell = host.querySelector('td.num-cell');
    const out = {
      text: cell.textContent.trim(),
      title: cell.getAttribute('title'),
      colour: getComputedStyle(cell).color,
      whiteSpace: getComputedStyle(cell).whiteSpace,
    };
    host.remove();
    return out;
  }, row(txAmount));
}

// Resolve a token to the rgb() string the browser reports, so the assertion tracks
// tokens.css instead of pinning a hex that a rebrand would falsely fail.
async function tokenColour(page, token) {
  return page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${t})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, token);
}

test.describe('Reconciliation: the Amount column shows direction', () => {
  test.beforeEach(async ({ page }) => {
    await loadDashboardWithFixtures(page, {});
    await page.waitForFunction(() => typeof window.reconRowHtml === 'function', { timeout: 15000 });
  });

  test('an outflow renders with a minus sign', async ({ page }) => {
    // The regression itself: this read "£1,742.60" — indistinguishable from income.
    const cell = await renderAmountCell(page, -1742.60);
    expect(cell.text).toBe('-£1,742.60');
  });

  test('an inflow renders with a plus sign', async ({ page }) => {
    const cell = await renderAmountCell(page, 950);
    expect(cell.text).toBe('+£950.00');
  });

  test('an outflow and an inflow of the same size are never identical', async ({ page }) => {
    // The property that actually matters. Any future formatting change is free to move
    // the sign, use brackets, or add a suffix — it is not free to make these match.
    const out = await renderAmountCell(page, -1742.60);
    const inn = await renderAmountCell(page, 1742.60);
    expect(out.text).not.toBe(inn.text);
  });

  test('the outflow colour survives the .od-table specificity fight', async ({ page }) => {
    // Guards the CSS half. Delete `.od-table td.text-red` and this fails while every
    // text assertion above still passes.
    const cell = await renderAmountCell(page, -1742.60);
    expect(cell.colour).toBe(await tokenColour(page, '--danger'));
    expect(cell.colour).not.toBe(await tokenColour(page, '--text-primary'));
  });

  test('the inflow colour survives the .od-table specificity fight', async ({ page }) => {
    const cell = await renderAmountCell(page, 950);
    expect(cell.colour).toBe(await tokenColour(page, '--success'));
    expect(cell.colour).not.toBe(await tokenColour(page, '--text-primary'));
  });

  test('hovering the amount says which direction it is, in plain words', async ({ page }) => {
    expect((await renderAmountCell(page, -1742.60)).title).toBe('Money out');
    expect((await renderAmountCell(page, 950)).title).toBe('Money in');
  });

  test('the sign never wraps away from its figure', async ({ page }) => {
    // Caught on the first screenshot of the fix: the Amount column is narrow, so
    // "-£1,742.60" broke after the sign and left a bare "-" hanging on its own line
    // above the number. A detached minus is worse than none — it reads as a bullet.
    const cell = await renderAmountCell(page, -1742.60);
    expect(cell.whiteSpace).toBe('nowrap');
  });

  test('a zero amount claims no direction', async ({ page }) => {
    // Zero is neither in nor out. Signing it "+£0.00" would be a small lie, and the
    // old `>= 0` test would have coloured it green.
    const cell = await renderAmountCell(page, 0);
    expect(cell.text).toBe('£0.00');
    expect(cell.colour).toBe(await tokenColour(page, '--text-primary'));
  });

  test('a missing amount degrades to zero rather than NaN', async ({ page }) => {
    const cell = await renderAmountCell(page, null);
    expect(cell.text).toBe('£0.00');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The same question, one screen deeper: the Split Transaction modal.
//
// The modal works entirely in POSITIVE MAGNITUDES on purpose. `totalRaw` is
// Math.abs, the portion inputs collect magnitudes, and validation requires
// every portion > 0. performReconSplit applies the sign itself at write time
// (`amountSign`), because Airtable's Report Amount returns a Split Override
// verbatim — a positive override on an expense posts an outflow as revenue
// across every report. That is the split sign-flip incident, and it hid for
// years because inflow splits are already positive.
//
// So the fix here had to be a LABEL and nothing else. These tests assert both
// halves: that the user can read the direction, AND that the stored values are
// still unsigned. The second half is the one that matters most — it fails
// loudly if a future session "helpfully" signs the state and walks the
// codebase back into that incident.
// ═══════════════════════════════════════════════════════════════════════════

// Open the modal for a transaction of `amount`. allTransactions is a top-level
// `let`, so it is NOT on window — reach the lexical binding via global eval.
async function openSplit(page, amount) {
  return page.evaluate(([amount, txAmountField]) => {
    (0, eval)(`allTransactions = [{ id:'recSplitTest', fields: { '${txAmountField}': ${amount} } }]`);
    window._reconResults = [{
      txId: 'recSplitTest', txDate: '2026-08-01',
      txVendor: 'Close Brothers', txAccount: 'Barclays', txAmount: amount,
    }];
    const existing = document.getElementById('reconSplitModal');
    if (existing) existing.remove();
    window.openReconSplitModal(0);
    const modal = document.getElementById('reconSplitModal');
    if (!modal) return { opened: false };
    return {
      opened: true,
      header: modal.querySelector('.od-modal-header').innerText.replace(/\s+/g, ' ').trim(),
      eachPortion: (document.getElementById('splitEachLabel') || {}).textContent,
      storedTotalRaw: window._splitState.totalRaw,
    };
  }, [amount, FIELDS.txAmount]);
}

// Drive the Custom tab and report what the user reads plus what is stored.
async function customTotals(page, amounts) {
  return page.evaluate((amounts) => {
    window.setSplitMode('custom');
    const st = window._splitState;
    while (st.customRows.length < amounts.length) window.splitAddCustomRow();
    amounts.forEach((a, i) => { st.customRows[i].amount = a; });
    window.renderSplitModalBody();
    const body = document.getElementById('splitModalBody');
    const line = body.innerText.replace(/\s+/g, ' ').match(/Total:.*?(?=$)/);
    return {
      totalsLine: line ? line[0].trim() : '',
      storedRows: st.customRows.map(r => r.amount),
      storedTotalRaw: st.totalRaw,
      rowPrefixes: [...body.querySelectorAll('tbody tr td span')].map(s => s.textContent),
      saveDisabled: document.getElementById('splitSaveBtn').disabled,
    };
  }, amounts);
}

test.describe('Split modal: the direction is readable, the stored values stay unsigned', () => {
  test.beforeEach(async ({ page }) => {
    await loadDashboardWithFixtures(page, {});
    await page.waitForFunction(() => typeof window.openReconSplitModal === 'function', { timeout: 15000 });
  });

  test('an expense names itself money out, with the sign', async ({ page }) => {
    const m = await openSplit(page, -1742.60);
    expect(m.opened).toBe(true);
    expect(m.header).toContain('-£1,742.60');
    expect(m.header).toContain('money out');
  });

  test('income names itself money in, with the sign', async ({ page }) => {
    const m = await openSplit(page, 950);
    expect(m.header).toContain('+£950.00');
    expect(m.header).toContain('money in');
  });

  test('each equal portion carries the direction', async ({ page }) => {
    expect((await openSplit(page, -1742.60)).eachPortion).toBe('-£871.30');
    expect((await openSplit(page, 950)).eachPortion).toBe('+£475.00');
  });

  test('THE GUARD: labelling an expense leaves the stored magnitude positive', async ({ page }) => {
    // If this ever fails, someone has signed the modal's state. performReconSplit
    // multiplies by `amountSign` on write, so a pre-signed magnitude would be
    // signed TWICE — posting an expense as revenue. Do not "fix" this by
    // changing the assertion.
    const m = await openSplit(page, -1742.60);
    expect(m.storedTotalRaw).toBe(1742.60);
    expect(m.storedTotalRaw).toBeGreaterThan(0);
  });

  test('THE GUARD: custom portions stay plain positive numbers', async ({ page }) => {
    await openSplit(page, -1742.60);
    const r = await customTotals(page, [1000, 742.60]);
    expect(r.storedRows).toEqual([1000, 742.60]);
    expect(r.storedTotalRaw).toBe(1742.60);
  });

  test('the custom total carries the direction', async ({ page }) => {
    await openSplit(page, -1742.60);
    expect((await customTotals(page, [1000, 742.60])).totalsLine).toContain('Total: -£1,742.60');
    await openSplit(page, 950);
    expect((await customTotals(page, [500, 450])).totalsLine).toContain('Total: +£950.00');
  });

  test('each portion input shows which way the money goes', async ({ page }) => {
    await openSplit(page, -1742.60);
    expect((await customTotals(page, [1000, 742.60])).rowPrefixes).toEqual(['-£', '-£']);
    await openSplit(page, 950);
    expect((await customTotals(page, [500, 450])).rowPrefixes).toEqual(['+£', '+£']);
  });

  test('over-allocating reads differently from being short', async ({ page }) => {
    // The quieter half of the same bug: both states used to render
    // "Remaining: £157.40", identical text, separated only by colour.
    await openSplit(page, -1742.60);
    const over = await customTotals(page, [1000, 900]);
    const short = await customTotals(page, [1000, 585.20]);
    expect(over.totalsLine).toContain('Over by: £157.40');
    expect(short.totalsLine).toContain('Left to allocate: £157.40');
    expect(over.totalsLine).not.toBe(short.totalsLine);
    // Neither is a valid split, so Save stays shut in both cases.
    expect(over.saveDisabled).toBe(true);
    expect(short.saveDisabled).toBe(true);
  });

  test('a balanced split says so and opens Save', async ({ page }) => {
    await openSplit(page, -1742.60);
    const r = await customTotals(page, [1000, 742.60]);
    expect(r.totalsLine).toContain('Balanced');
    expect(r.totalsLine).not.toContain('Over by');
    expect(r.saveDisabled).toBe(false);
  });

  test('an empty Custom tab shows no sign on zero', async ({ page }) => {
    // "Total: -£0.00" reads as a debt that is not there.
    await openSplit(page, -1742.60);
    const r = await customTotals(page, ['', '']);
    expect(r.totalsLine).toContain('Total: £0.00');
    expect(r.totalsLine).not.toContain('-£0.00');
  });
});
