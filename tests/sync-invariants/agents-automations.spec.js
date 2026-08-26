const { test, expect } = require('@playwright/test');
const { AG, mockAgentsPage, loadAgentsPage, defaultFixtures } = require('./agents-page.helpers');

// The Automations section and the plain-English description (27 Aug 2026).
//
// Both exist for the same reason: by 26 register rows and ~70 running jobs,
// nobody remembers what row 4 does, and you cannot safely retire what you
// cannot describe. The failure mode they guard against is silent — a section
// that renders empty, or a description quietly clipped to one line — so these
// assert on the rendered page, not on the data file.

test.describe('AI Agents page — descriptions and automations', () => {

    test('shows each agent\'s plain-English description in full', async ({ page }) => {
        const fx = defaultFixtures();
        const LONG = 'When a creditor chases you for money, this writes your reply for you to approve. '
            + 'It follows the same script every time: first ask them to freeze the debt, and if they '
            + 'say no, offer the smallest monthly payment you can afford.';
        fx.agents[0].fields[AG.whatItDoes || 'fldhpQOgGF7khDBp2'] = LONG;
        await mockAgentsPage(page, fx);
        await loadAgentsPage(page);

        const card = page.locator('.sc-card', { hasText: 'Creditor Management' }).first();
        const what = card.locator('.sc-what');
        await expect(what).toHaveText(LONG);

        // NOT truncated. `.sc-goal` clips to one line with an ellipsis; if the
        // description ever inherits that, the whole point is lost.
        const style = await what.evaluate(el => getComputedStyle(el).whiteSpace);
        expect(style).not.toBe('nowrap');
        const box = await what.boundingBox();
        expect(box.height).toBeGreaterThan(30); // several wrapped lines, not one
    });

    test('says so when an agent has no description, rather than showing a blank', async ({ page }) => {
        const fx = defaultFixtures(); // fixture agents carry no whatItDoes
        await mockAgentsPage(page, fx);
        await loadAgentsPage(page);
        const card = page.locator('.sc-card', { hasText: 'Inbound Comms Response' }).first();
        await expect(card.locator('.sc-what-missing')).toContainText('No description yet');
    });

    test('renders the Automations section with real rows in every group', async ({ page }) => {
        await mockAgentsPage(page, defaultFixtures());
        await loadAgentsPage(page);

        const section = page.locator('#automationsLayer');
        await expect(section).toBeVisible();
        await expect(section).toContainText('Automations');

        // CONTROL. The whole risk here is a section that renders but is empty,
        // which reads as "nothing runs" instead of "the list did not load".
        // The estate has dozens of jobs; anything near zero is a broken render.
        const rows = section.locator('table.wf-grid tbody tr');
        await expect.poll(() => rows.count()).toBeGreaterThan(40);

        // Each group must actually appear, not just the wrapper.
        await expect(section).toContainText('Scheduled jobs on the Mac');
        await expect(section).toContainText('Cloudflare Workers');
        await expect(section).toContainText('Airtable automations');

        // Every row must carry a description — a name-only list is the thing
        // this section exists to replace.
        const blank = await section.locator('table.wf-grid tbody tr').evaluateAll(
            trs => trs.filter(tr => (tr.children[3]?.textContent || '').trim().length < 40).length
        );
        expect(blank).toBe(0);
    });

    test('shows the off jobs as off, not hidden', async ({ page }) => {
        await mockAgentsPage(page, defaultFixtures());
        await loadAgentsPage(page);
        const section = page.locator('#automationsLayer');
        // UC was switched off on 27 Aug 2026 and must stay visible as "Off".
        const ucRow = section.locator('tr', { hasText: 'UC Notifier Watchdog' }).first();
        await expect(ucRow).toContainText('Off');
    });

    test('reports a failure to load, never an empty list', async ({ page }) => {
        await mockAgentsPage(page, defaultFixtures());
        // Simulate the data file failing to load.
        await page.route('**/js/automations-data.js*', route => route.fulfill({ status: 404, body: '' }));
        await loadAgentsPage(page);
        const section = page.locator('#automationsLayer, .zone-error');
        await expect(page.locator('body')).toContainText('could not be loaded');
    });
});

// ── Review findings, 27 Aug 2026 ───────────────────────────────────────
// All three shipped in the first cut of this feature and were caught by the
// review gate. They are guarded here because each one is silent: the page
// still renders, it just tells Kevin something untrue.
test.describe('AI Agents page — automations counting and filtering', () => {

    test('counts only real automations, never the agents listed for completeness', async ({ page }) => {
        await mockAgentsPage(page, defaultFixtures());
        await loadAgentsPage(page);
        const head = page.locator('#automationsLayer .agentic-guide-head');
        const headText = await head.textContent();
        const shown = Number((headText.match(/\((\d+)\)/) || [])[1]);

        // The truth, computed from the data file the page loaded.
        const truth = await page.evaluate(() => {
            const notAgent = r => r.agent !== true;
            const mac = (AUTOMATIONS.macJobs || []).concat(AUTOMATIONS.otherMacJobs || []);
            return [mac, AUTOMATIONS.workers || [], AUTOMATIONS.airtable || []]
                .reduce((n, g) => n + g.filter(notAgent).length, 0)
                + (AUTOMATIONS.airtableOff || []).length;
        });
        const agentRows = await page.evaluate(() => {
            const mac = (AUTOMATIONS.macJobs || []).concat(AUTOMATIONS.otherMacJobs || []);
            return [mac, AUTOMATIONS.workers || [], AUTOMATIONS.airtable || []]
                .reduce((n, g) => n + g.filter(r => r.agent === true).length, 0);
        });

        expect(shown).toBe(truth);
        // CONTROL: if no row were flagged as an agent the assertion above would
        // pass trivially, proving nothing. There ARE agent rows to exclude.
        expect(agentRows).toBeGreaterThan(5);
        expect(shown).toBeLessThan(truth + agentRows);
    });

    test('the description is not double-ruled against the row beneath it', async ({ page }) => {
        const fx = defaultFixtures();
        fx.agents[0].fields['fldhpQOgGF7khDBp2'] = 'A description long enough to wrap onto a second line so the spacing under it is real.';
        await mockAgentsPage(page, fx);
        await loadAgentsPage(page);
        const borders = await page.locator('.sc-card').first().evaluate(card => {
            const what = card.querySelector('.sc-what');
            const row = card.querySelector('.sc-row');
            return {
                what: parseFloat(getComputedStyle(what).borderBottomWidth),
                row: parseFloat(getComputedStyle(row).borderTopWidth),
            };
        });
        // .sc-row already draws the divider; .sc-what must not draw a second one.
        expect(borders.row).toBeGreaterThan(0);
        expect(borders.what).toBe(0);
    });

    test('the search narrows the automations as well as the agents', async ({ page }) => {
        await mockAgentsPage(page, defaultFixtures());
        await loadAgentsPage(page);
        const rows = page.locator('#automationsLayer table.wf-grid tbody tr');
        const before = await rows.count();
        expect(before).toBeGreaterThan(40);

        await page.locator('#registerSearchInput').fill('drift scan');
        await expect.poll(() => rows.count()).toBeLessThan(before);
        await expect.poll(() => rows.count()).toBeGreaterThan(0);
        await expect(page.locator('#automationsLayer')).toContainText('Drift Scan');
    });
});
