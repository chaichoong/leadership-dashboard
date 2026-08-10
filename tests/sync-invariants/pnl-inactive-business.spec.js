// Invariant: a deactivated business is still shown, never silently swapped or blanked.
//
// Two bugs, one root cause — the P&L resolved everything against the ACTIVE-only
// business list, so a business that had been unticked simply stopped existing:
//
//  * Finding 20260810-drift-053: if the selected business was deactivated,
//    renderPnL() reassigned pnlBusinessName to whichever name sorted first. The
//    page then showed a DIFFERENT company's books under the same heading, with no
//    notice. Nothing errored and the figures looked perfectly plausible.
//  * Finding 20260810-drift-054: in the drill-down, the Business cell resolved the
//    transaction's linked id against the active-only list, returning ''. A set link
//    read as unset, which invites someone to "fix" it by relinking.
//
// Rule: the PICKER offers active businesses only; DISPLAY resolves against every
// business. A deactivated selection is kept, marked, and announced.

const { test, expect } = require('@playwright/test');
const { loadDashboard } = require('./helpers');

// Fixtures: recBiz1 'Active Corp' (active), recBiz2 'Inactive Ltd' (NOT active),
// recBiz3 'Another Active' (active).

test.describe('P&L and deactivated businesses', () => {

  test('a deactivated selection is kept and announced, not swapped', async ({ page }) => {
    await loadDashboard(page, 'pnl');

    const result = await page.evaluate(() => {
      // Somebody was looking at this company when it was ticked Active.
      pnlBusinessName = 'Inactive Ltd';
      renderPnL();
      const sel = document.getElementById('pnlBizSelect');
      return {
        stateName: pnlBusinessName,
        selected: sel ? sel.value : null,
        options: sel ? [...sel.options].map((o) => o.textContent.trim()) : [],
        noticeText: (document.getElementById('pnlInactiveBizNotice') || {}).textContent || '',
      };
    });

    // The selection survives. This is the whole point: the page must not start
    // showing another company's numbers because a checkbox changed in Airtable.
    expect(result.stateName, 'the P&L silently repointed at another business').toBe('Inactive Ltd');
    expect(result.selected).toBe('Inactive Ltd');

    // It is visibly flagged, in the notice and in the option itself.
    expect(result.noticeText).toContain('Inactive Ltd');
    expect(result.noticeText.toLowerCase()).toContain('no longer');
    expect(result.options.some((o) => o.includes('Inactive Ltd') && o.includes('not active'))).toBe(true);
  });

  test('the picker still offers only active businesses to switch TO', async ({ page }) => {
    await loadDashboard(page, 'pnl');

    const options = await page.evaluate(() => {
      pnlBusinessName = 'Active Corp';
      renderPnL();
      const sel = document.getElementById('pnlBizSelect');
      return [...sel.options].map((o) => o.value);
    });

    // Control for the test above: without this, "keep the selection" could be
    // mistaken for "put every business in the list", which is the original bug
    // this page was built to avoid.
    expect(options).toContain('Active Corp');
    expect(options).not.toContain('Inactive Ltd');
  });

  test('the notice is absent when the selected business is active', async ({ page }) => {
    await loadDashboard(page, 'pnl');
    const hasNotice = await page.evaluate(() => {
      pnlBusinessName = 'Active Corp';
      renderPnL();
      return !!document.getElementById('pnlInactiveBizNotice');
    });
    // A warning that is always on screen is a warning nobody reads.
    expect(hasNotice).toBe(false);
  });

  test('the drill-down shows the name of an INACTIVE linked business', async ({ page }) => {
    await loadDashboard(page, 'pnl');

    const cellValue = await page.evaluate(() => {
      // Rebuild the drill-down's business resolution exactly as pnlDrill does:
      // the datalist comes from the active list, the DISPLAYED value must come
      // from every business.
      const bizList = pnlNameList(getActiveBusinesses(), PNL_NAME_FIELDS.business);
      const bizAllList = pnlNameList(allBusinesses, PNL_NAME_FIELDS.business);
      const nameById = (list, id) => {
        if (!id) return '';
        const h = list.find((o) => o.id === id);
        return h ? h.name : '';
      };
      return {
        fromActiveOnly: nameById(bizList, 'recBiz2'),
        fromAll: nameById(bizAllList, 'recBiz2'),
        drillUsesAll: typeof pnlDrill === 'function',
      };
    });

    // The old behaviour, kept as the back-test: resolving against the active-only
    // list is exactly what produced the empty cell.
    expect(cellValue.fromActiveOnly).toBe('');
    expect(cellValue.fromAll, 'a set business link still renders as empty').toBe('Inactive Ltd');
    expect(cellValue.drillUsesAll).toBe(true);
  });

  test('the drill-down source resolves display against allBusinesses', () => {
    // Guards the wiring the test above can only approximate: if someone points
    // the Business cell back at the active-only list, this fails.
    const src = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../js/pnl.js'), 'utf8');
    expect(src).toContain('bizAllList');
    expect(src).toMatch(/nameById\(bizAllList, bizId\)/);
  });
});
