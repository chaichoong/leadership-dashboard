// Starting a new quarter on the Objective & Strategy page.
//
// The page defaults to the current quarter and finds no record, so this is the
// first screen a founder meets. Two of the invariants below regressed inside a
// single session while fixing the others, which is why they are pinned here.
//
// What must hold:
//   1. The empty state offers BOTH routes in (wizard and manual). It used to
//      offer only the wizard, so a founder who wanted to type their own plan
//      had no form to type into.
//   2. The wizard always has a form to write into. It renders one via the
//      prior-quarter pre-fill — but a brand-new client has no prior quarter,
//      and the prior fetch is wrapped in a silent catch. Skipping every step
//      then reached "review the form and hit Save" with no form on the page.
//   3. Save never writes a fields-less record. readAllFormFields() reads the
//      DOM, so no form means `{}`, and saveRecord force-adds Quarter/Year/
//      Business — a junk record that counts as "a plan exists", hides the
//      empty state, and costs the founder both routes in.
//
// (3) is the one with teeth: it writes to Airtable. It is asserted against the
// intercepted POST body, not the UI.

const { test, expect } = require('@playwright/test');
const { MOCK_PAT } = require('./helpers');

const OBJ_STRAT_TABLE = 'tblEBvFw8DonwxzGh';   // js/config.js → TABLES.objStrat
const BUSINESSES_TABLE = 'tblpqkvWJJo8Uu25q'; // js/config.js → TABLES.businesses

// Field IDs from js/config.js → OBJSTRAT.
const OBJECTIVE_FID = 'fldYgHiiw6acphydt';

// The page defaults its picker to the calendar quarter we are actually in, so
// the mock has to agree with it to tell the two reads apart. Derived rather
// than hardcoded, or this file quietly breaks on 1 October.
const CURRENT_QUARTER = 'Q' + (Math.floor(new Date().getMonth() / 3) + 1);

/**
 * Serve the strategy page with no saved plan for any quarter.
 * `priorQuarterRecords` lets a test decide whether a prior quarter exists —
 * the difference between a returning client and a brand-new one.
 */
async function loadStrategyPage(page, { priorQuarterRecords = [] } = {}) {
    const writes = [];

    await page.addInitScript((pat) => {
        localStorage.setItem('_dlr_pat', pat);
        // Wizard sessions persist per business×quarter×year; a leftover would
        // resume mid-flow instead of starting clean. Prefix must match
        // wizSessionKey() in strategy.js — a wrong one clears nothing and reads
        // as protection it is not providing.
        Object.keys(localStorage)
            .filter(k => k.startsWith('ostrat:wizard:'))
            .forEach(k => localStorage.removeItem(k));
    }, MOCK_PAT);

    await page.route('**/v0/**', async (route) => {
        const req = route.request();
        const url = req.url();
        const method = req.method();

        if (method === 'POST' || method === 'PATCH') {
            writes.push({ method, url, body: JSON.parse(req.postData() || '{}') });
            return route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({ id: 'recCreated', fields: {} }),
            });
        }

        if (url.includes(BUSINESSES_TABLE)) {
            return route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({
                    records: [{ id: 'recBiz1', fields: { 'Business Name': 'Active Corp', 'Name': 'Active Corp', 'Active': true } }],
                }),
            });
        }

        if (url.includes(OBJ_STRAT_TABLE)) {
            // Two different reads hit this table, and they must not be
            // conflated: the page asks for the SELECTED quarter (the one being
            // planned — always empty here, which is what puts the empty state
            // on screen), and the wizard then asks for the PRIOR one to
            // pre-fill and reflect from. Tell them apart by the quarter in the
            // formula.
            //
            // URLSearchParams encodes spaces as '+', so the formula arrives as
            // {Quarter}+=+"Q2" — decodeURIComponent alone leaves the pluses in
            // and a naive /\s*=\s*/ never matches. Getting this wrong makes the
            // mock serve [] to everything, and the pre-fill tests then pass
            // while proving nothing.
            const formula = decodeURIComponent(url).replace(/\+/g, ' ');
            const asked = (formula.match(/\{Quarter\}\s*=\s*"(Q[1-4])"/) || [])[1];
            const isPriorLookup = asked && asked !== CURRENT_QUARTER;
            return route.fulfill({
                status: 200, contentType: 'application/json',
                body: JSON.stringify({ records: isPriorLookup ? priorQuarterRecords : [] }),
            });
        }

        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ records: [] }) });
    });

    await page.goto('/os/strategy/index.html');
    await page.waitForFunction(() => {
        const app = document.getElementById('app');
        return app && app.style.display !== 'none';
    }, { timeout: 20000 }).catch(() => {});

    // Pick the business; quarter/year already default to today's quarter.
    await page.selectOption('#businessSel', { index: 1 }).catch(() => {});
    await page.waitForTimeout(800);

    return writes;
}

test.describe('Objective & Strategy — starting a new quarter', () => {

    test('empty state offers both a wizard and a manual route', async ({ page }) => {
        await loadStrategyPage(page);

        const emptyState = page.locator('.empty-state');
        await expect(emptyState).toBeVisible();

        // Both routes, or a founder who does not want the AI is stuck.
        await expect(emptyState.getByRole('button', { name: /AI Wizard/i })).toBeVisible();
        await expect(emptyState.getByRole('button', { name: /Fill in manually/i })).toBeVisible();

        // And it must say which quarter this is, so nobody switches back to the
        // previous one to "start from" it.
        await expect(emptyState).toContainText(/right place/i);
    });

    test('"Fill in manually" renders an editable form with its hints visible', async ({ page }) => {
        await loadStrategyPage(page);

        await page.locator('.empty-state').getByRole('button', { name: /Fill in manually/i }).click();
        await page.waitForTimeout(500);

        await expect(page.locator('.plan-form [data-field-id]').first()).toBeVisible();

        // Sections fold shut when empty, which on a blank plan would hide every
        // hint behind a collapsed bar and leave the founder guessing.
        const openSections = await page.locator('.plan-form details.section[open]').count();
        const totalSections = await page.locator('.plan-form details.section').count();
        expect(totalSections).toBeGreaterThan(0);
        expect(openSections).toBe(totalSections);
        await expect(page.locator('.plan-form .section-sub').first()).toBeVisible();
    });

    test('typing then opening the wizard does not wipe the founder\'s own words', async ({ page }) => {
        await loadStrategyPage(page, {
            priorQuarterRecords: [{ id: 'recPrior', fields: { [OBJECTIVE_FID]: 'LAST QUARTER OBJECTIVE' } }],
        });

        await page.locator('.empty-state').getByRole('button', { name: /Fill in manually/i }).click();
        await page.waitForTimeout(400);

        const objective = page.locator(`[data-field-id="${OBJECTIVE_FID}"]`);
        await objective.fill('MY OWN TYPED OBJECTIVE');

        // Asking the AI for help must not overwrite what they already wrote.
        await page.locator('#wizardBtn').click();
        await page.waitForTimeout(1200);

        await expect(objective).toHaveValue('MY OWN TYPED OBJECTIVE');
    });

    test('pre-filling from last quarter does not arm Save', async ({ page }) => {
        // Opening the wizard carries the prior quarter into the form as a
        // starting point. That is last quarter's work, not this quarter's —
        // Save used to go live on it immediately, one click from a Q3 that is a
        // verbatim copy of Q2 and reads back as a finished plan.
        await loadStrategyPage(page, {
            priorQuarterRecords: [{ id: 'recPrior', fields: { [OBJECTIVE_FID]: 'LAST QUARTER OBJECTIVE' } }],
        });

        await page.locator('.empty-state').getByRole('button', { name: /AI Wizard/i }).click();
        await page.waitForTimeout(1200);

        // The carry-over happens...
        await expect(page.locator(`[data-field-id="${OBJECTIVE_FID}"]`)).toHaveValue('LAST QUARTER OBJECTIVE');
        // ...but saving it is not yet an option.
        await expect(page.locator('#saveBtn')).toBeDisabled();

        // Engaging with any field is what unlocks it.
        await page.locator(`[data-field-id="${OBJECTIVE_FID}"]`).fill('This quarter: ship the thing');
        await expect(page.locator('#saveBtn')).toBeEnabled();
    });

    test('wizard opened by a brand-new client has a form to write into', async ({ page }) => {
        // No prior quarter at all — the client-onboarding case.
        await loadStrategyPage(page, { priorQuarterRecords: [] });

        await page.locator('.empty-state').getByRole('button', { name: /AI Wizard/i }).click();
        await page.waitForTimeout(1200);

        // Without a rendered form the wizard types into nothing and the founder
        // is told to review a form that is not there.
        await expect(page.locator('.plan-form [data-field-id]').first()).toBeVisible();
        await expect(page.locator('.empty-state')).toHaveCount(0);
    });

    test('skipping every wizard step never creates an empty plan', async ({ page }) => {
        // Brand-new client, so nothing is carried over from a prior quarter and
        // skipping leaves the form genuinely blank.
        const writes = await loadStrategyPage(page, { priorQuarterRecords: [] });

        await page.locator('.empty-state').getByRole('button', { name: /AI Wizard/i }).click();
        await page.waitForTimeout(1000);

        // "Move on →" through the lot without answering anything.
        await page.evaluate(() => {
            for (let i = 0; i < WIZARD_STEPS.length + 3; i++) {
                if (typeof wizardState !== 'undefined' && wizardState) wizSkip();
            }
        });
        await page.waitForTimeout(400);

        // Finishing the wizard unlocks Save and tells the founder to press it.
        await expect(page.locator('#saveBtn')).toBeEnabled();

        await page.locator('#saveBtn').click();
        await page.waitForTimeout(600);

        // The write is the thing that matters: an empty record would count as
        // "a plan exists" and permanently hide the empty state.
        const planWrites = writes.filter(w => w.url.includes(OBJ_STRAT_TABLE));
        expect(planWrites).toHaveLength(0);
        await expect(page.locator('#statusBar')).toContainText(/nothing to save/i);

        // And the button must not wedge — the founder can still act.
        await expect(page.locator('#saveBtn')).toBeEnabled();
    });

    test('a real answer still saves', async ({ page }) => {
        // The guard above must not block a legitimate create.
        const writes = await loadStrategyPage(page);

        await page.locator('.empty-state').getByRole('button', { name: /Fill in manually/i }).click();
        await page.waitForTimeout(400);

        await page.locator(`[data-field-id="${OBJECTIVE_FID}"]`).fill('A real objective');
        await page.locator('#saveBtn').click();
        await page.waitForTimeout(800);

        const planWrites = writes.filter(w => w.url.includes(OBJ_STRAT_TABLE) && w.method === 'POST');
        expect(planWrites).toHaveLength(1);
        expect(planWrites[0].body.fields[OBJECTIVE_FID]).toBe('A real objective');
    });
});
