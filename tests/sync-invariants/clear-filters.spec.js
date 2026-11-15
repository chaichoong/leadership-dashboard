// Invariant: every filter bar has a working "Clear filters" control.
// Gap: Income, AR Variable, Costs, Invoices and Skills all filtered the list but
//      gave no way back to the default view — a narrow filter plus a search term
//      left an empty table and no obvious escape. Transactions and the Tasks OS
//      already had one; the rest did not.
// Rule: clicking "Clear filters" resets EVERY filter control on that tab to the
//       value the tab loads with (which is not always blank — Income defaults to
//       "In Payment", Costs to "Active only", AR Variable to "Unpaid") and
//       re-renders. Sort order is a view preference and must NOT be reset.

const { test, expect } = require('@playwright/test');
const { loadDashboard } = require('./helpers');

// tab id → [clear button selector, { control id: expected value after clear }, sort control id]
const TABS = {
  income: {
    render: 'renderIncomeTab',
    defaults: { incomeStatusFilter: 'in-payment', incomeBusinessFilter: 'all', incomeFilterText: '' },
    dirty: { incomeStatusFilter: 'all', incomeBusinessFilter: 'all', incomeFilterText: 'zzz-no-match' },
    sort: { id: 'incomeSortBy', value: 'tenant' },
  },
  'ar-variable': {
    render: 'renderARVariableTab',
    defaults: { arvStatusFilter: 'unpaid', arvBusinessFilter: 'all', arvFilterText: '' },
    dirty: { arvStatusFilter: 'paid', arvBusinessFilter: 'all', arvFilterText: 'zzz-no-match' },
    sort: { id: 'arvSortBy', value: 'customer' },
  },
  costs: {
    render: 'renderCostsTab',
    defaults: { costsStatusFilter: 'active', costsFreqFilter: 'all', costsFilterText: '' },
    dirty: { costsStatusFilter: 'inactive', costsFreqFilter: 'annual', costsFilterText: 'zzz-no-match' },
    sort: { id: 'costsSortBy', value: 'name' },
  },
  invoices: {
    render: 'renderInvoiceTab',
    defaults: { invFilterText: '' },
    dirty: { invFilterText: 'zzz-no-match' },
    sort: { id: 'invSortBy', value: 'payee' },
  },
};

test.describe('Clear filters', () => {

  for (const [tab, cfg] of Object.entries(TABS)) {
    test(`${tab} tab: clear button resets every filter to its default`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));

      await loadDashboard(page, tab);
      await page.evaluate(t => switchTab(t), tab);

      // The button must exist inside this tab's panel — a clear control that
      // lives on another tab is no use to the person looking at this one.
      const btn = page.locator(`#tab-${tab} button.od-clear-filters`);
      await expect(btn).toHaveCount(1);

      // Dirty every filter, plus the sort control (which must survive).
      await page.evaluate(({ dirty, sort, render }) => {
        Object.keys(dirty).forEach(id => { const el = document.getElementById(id); if (el) el.value = dirty[id]; });
        const s = document.getElementById(sort.id);
        if (s) s.value = sort.value;
        if (typeof window[render] === 'function') window[render]();
      }, cfg);

      await btn.click();
      await page.waitForTimeout(400);

      const after = await page.evaluate(({ defaults, sort }) => {
        const out = { filters: {}, sort: null };
        Object.keys(defaults).forEach(id => {
          const el = document.getElementById(id);
          out.filters[id] = el ? el.value : '__MISSING__';
        });
        const s = document.getElementById(sort.id);
        out.sort = s ? s.value : '__MISSING__';
        return out;
      }, cfg);

      expect(after.filters).toEqual(cfg.defaults);
      // Sort is a view preference, not a filter — clearing must leave it alone.
      expect(after.sort).toBe(cfg.sort.value);
      expect(errors).toEqual([]);
    });
  }

  // The two Skills Library checks went on 15 Nov 2026 with the tab (js/skills.js).

  test('every filter bar in the shell has a clear control', async ({ page }) => {
    await loadDashboard(page, 'overview');

    // Control: this must find filter bars at all. A selector typo would report
    // "0 bars, 0 without a clear button" and pass forever.
    const audit = await page.evaluate(() => {
      const bars = [...document.querySelectorAll('.od-filter-row')];
      const missing = bars
        .filter(bar => !bar.querySelector('button.od-clear-filters'))
        .map(bar => (bar.closest('.tab-panel') || {}).id || 'unknown');
      return { total: bars.length, missing };
    });

    expect(audit.total).toBeGreaterThan(0);
    expect(audit.missing).toEqual([]);
  });
});
