// Invariant: the AI Agents register's Guardrail Level CONTROLS the auto-reconcile
// tier — it is never just a label.
//
// Kevin's ruling (24 Aug 2026): the reconciliation agent stays at "Approval
// required" until accuracy reaches 95%; he approves every transaction manually.
// A register that says "Approval required" while the browser's auto-run toggle
// quietly approves transactions would be the register lying about behaviour.
// So runAutoReconcile() asks the register first, and FAILS CLOSED: an
// unreadable register also means no auto run.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT, loadDashboard } = require('./helpers');

const AGENTS_TABLE = 'tbl9msVjyQWslLOIZ';
const RECON_AGENT_ROW = 'recyrN5YCQFssAniE';
const F_GUARDRAIL = 'fldWgqxMFmaAAvUHC';

// Serve the register row with the given guardrail level (or an error status).
async function routeRegisterRow(page, { level, status = 200 }) {
  await page.route(`**/api.airtable.com/v0/**/${AGENTS_TABLE}/${RECON_AGENT_ROW}**`, async (route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return; }
    if (status !== 200) { await route.fulfill({ status, contentType: 'application/json', body: '{}' }); return; }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: RECON_AGENT_ROW, fields: { [F_GUARDRAIL]: level } }),
    });
  });
}

test.describe('Reconciliation agent guardrail gate', () => {

  test('"Approval required" blocks the auto tier before any matching or writes', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await routeRegisterRow(page, { level: 'Approval required' });

    // Count every Airtable write the auto run attempts.
    const writes = [];
    await page.route('**/api.airtable.com/v0/**', async (route) => {
      const m = route.request().method();
      if (m === 'PATCH' || m === 'POST') { writes.push(route.request().url()); }
      await route.fallback();
    });

    const allowed = await page.evaluate(async () => await autoAllowedByGuardrail());
    expect(allowed).toBe(false);

    await page.evaluate(async () => await runAutoReconcile());
    expect(writes).toEqual([]);
  });

  test('"Hybrid escalation" and "Autonomous" allow the auto tier', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);

    await routeRegisterRow(page, { level: 'Hybrid escalation' });
    expect(await page.evaluate(async () => await autoAllowedByGuardrail())).toBe(true);

    await routeRegisterRow(page, { level: 'Autonomous' });
    expect(await page.evaluate(async () => await autoAllowedByGuardrail())).toBe(true);
  });

  test('fails closed: an unreadable register means no auto run', async ({ page }) => {
    await page.addInitScript((pat) => localStorage.setItem('_dlr_pat', pat), MOCK_PAT);
    await loadDashboard(page);
    await routeRegisterRow(page, { status: 500 });

    expect(await page.evaluate(async () => await autoAllowedByGuardrail())).toBe(false);
  });
});
