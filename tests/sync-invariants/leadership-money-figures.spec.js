// Leadership Dashboard money figures (audit against Airtable, Kevin's rulings of 14 Oct 2026).
//
// Four figures read wrong on the live page that day, each one built from the wrong input:
//   1. The operating cushion card counted rent from CFV Actioned tenancies (not being paid)
//      and called the £14,300 income floor a target: "120.7% of target, on track" for a
//      cushion that was 101.8% of the floor.
//   2. "Safe to withdraw" held nothing back for maintenance, compliance, utilities or the
//      non-payment allowance (£3,650 a month), so it offered that money as spare.
//   3. The credit card payoff time divided the cards by the property surplus (before the
//      variable budget and Kevin's living costs): "clears in ~2 months" for about 7.
//   4. The cash cushion cards headlined a rolling 31 days, which took in two of a monthly
//      payment landing at both ends. They now headline the last full month.
// The rules are unit-tested in tests/re-kpis.test.js; this drives the page that draws them.
// Every name and amount here is invented. Airtable is mocked (helpers.js), so no PAT.

const { test, expect } = require('@playwright/test');
const { makeFixtures, loadDashboardWithFixtures, localTodayISO } = require('./helpers');

const RE_ID = 'recoGcXRXCniyJsTz';          // RE_Q4.businessId in js/config.js
const TEN = { status: 'fldxU3dPUnbK0SCDq', rent: 'fldDMyfZLFMeONPq8', dueDay: 'fldhy2U0CQmM2oS4P', tenantStatus: 'fldgWAyha1Uij1SZP', ref: 'fldyNVvFn4x8GY14q', start: 'fld2rPXwwV8dXb1zF' };
const COST = { name: 'fldS6FYfpkhu6tJG0', expected: 'fld9JibXkMpTeMcxw', dueDay: 'fld7IsfiGvKpxEwSs', payStatus: 'fldXZNI96v8HgjuSh', business: 'fldrPjvdFPCKWqeyd', frequency: 'fldvozTHvs5VH3lNi' };
const TX = { date: 'fldoyQ6Rr9cHp3bgQ', amount: 'fldN01r1hp7UQjgtm', report: 'fldot7iisZeL3WrdR', reconciled: 'fldxKX1IbIFcAOnn5', sub: 'fldMRjSVzZVYeHb0A', business: 'fldX1aFlJyzpXGhbF', cost: 'fldGkpkVqSeiGvUGL', name: 'fldsbuAJCTsXHug4C' };
const SUB_NAME = 'fldO4BTJhFv5EsN6i';
const BUCKET = { name: 'fld58yk6iOatTIIxJ', pct: 'fldJkDpfd9p36ddbC' };

// ISO date for day `day` of the month `back` months before this one (local time).
function monthDay(back, day) {
    const now = new Date();
    return localTodayISO(new Date(now.getFullYear(), now.getMonth() - back, day));
}

function fixtures({ debtPct = 70, lastMonthFixed = -400 } = {}) {
    const f = makeFixtures();
    f.businesses = [...f.businesses, { id: RE_ID, fields: { fldbbRqVxLxUdHwIR: 'Real Estate', fldhXBnRrngCVsgSk: true } }];
    // One tenancy paying £15,000 and one CFV Actioned at £2,000: cushion £14,000 from the
    // paying tenancy, £16,000 if the other pays too. The floor needs £14,300.
    f.tenancies = [
        { id: 'recTenPaying', fields: { [TEN.ref]: 'SAMPLE-1', [TEN.status]: 'In Payment', [TEN.rent]: 15000, [TEN.dueDay]: 20, [TEN.tenantStatus]: 'Active', [TEN.start]: '2025-01-01' } },
        { id: 'recTenActioned', fields: { [TEN.ref]: 'SAMPLE-2', [TEN.status]: 'CFV Actioned', [TEN.rent]: 2000, [TEN.dueDay]: 21, [TEN.tenantStatus]: 'Active', [TEN.start]: '2025-01-01' } },
    ];
    f.costs = [{ id: 'recCostRE', fields: { [COST.name]: 'Sample mortgage', [COST.expected]: 1000, [COST.dueDay]: 15, [COST.payStatus]: 'In Payment', [COST.business]: [RE_ID], [COST.frequency]: 'Monthly' } }];
    f.subCategories = [
        { id: 'recSubRent', fields: { [SUB_NAME]: 'Rental Income' } },
        { id: 'recSubFixed', fields: { [SUB_NAME]: 'Sample Fixed Cost' } },   // in no Wealth cash flow group
    ];
    const tx = (id, date, amount, sub, extra = {}) => ({ id, fields: {
        [TX.name]: 'Sample ' + id, [TX.date]: date, [TX.amount]: amount, [TX.report]: amount, [TX.reconciled]: true,
        [TX.sub]: [sub], [TX.business]: [RE_ID], ...extra,
    } });
    f.transactions = [
        // £1,000 rent in each of the last three full months: personal net cash flow £1,000 a month.
        tx('rent3', monthDay(3, 10), 1000, 'recSubRent'),
        tx('rent2', monthDay(2, 10), 1000, 'recSubRent'),
        tx('rent1', monthDay(1, 10), 1000, 'recSubRent'),
        // Last full month: one £400 property fixed cost, so that month's cash cushion is £600.
        tx('fixed1', monthDay(1, 10), lastMonthFixed, 'recSubFixed', { [TX.cost]: ['recCostRE'] }),
        // Today: £1,000 rent, so the rolling 31 days reads £1,000 or £1,600, never £600.
        tx('rentToday', localTodayISO(), 1000, 'recSubRent'),
    ];
    f.incomeBuckets = [
        { id: 'recBucketDebt', fields: { [BUCKET.name]: 'Debt', [BUCKET.pct]: debtPct } },
        { id: 'recBucketDreams', fields: { [BUCKET.name]: 'Dreams', [BUCKET.pct]: 100 - debtPct } },
    ];
    return f;
}

async function load(page, { settings = {}, ...opts } = {}) {
    // The safety floor fixed at £500, so the held-back budget is the only thing that moves
    // the last day's balance. Weekly costs stay at their default (Wages £150 every Friday)
    // unless a test saves its own.
    await page.addInitScript((s) => {
        if (!sessionStorage.getItem('_seeded')) {
            localStorage.setItem('_wa_settings', JSON.stringify({ floorOverride: 500, weeklyCostsRuling20261007: true, ...s }));
            sessionStorage.setItem('_seeded', '1');
        }
    }, settings);
    await loadDashboardWithFixtures(page, fixtures(opts));
}
const finalBalance = async (page) => {
    const finalCard = page.locator('#cashflowKPIs .kpi-card', { hasText: 'Final Balance' });
    await expect(finalCard).toBeVisible();
    return gbp(await finalCard.locator('.kpi-card-value').textContent());
};

const gbp = s => Number(String(s).replace(/[^0-9.\-−]/g, '').replace('−', '-'));

test.describe('Leadership Dashboard money figures (14 Oct 2026)', () => {
    test('the floor card counts In Payment tenancies only and calls £14,300 the floor', async ({ page }) => {
        await load(page);
        const card = page.locator('#operationalCards .kpi-card', { hasText: 'income floor (plan)' });
        await expect(card.locator('.kpi-card-value')).toHaveText('£14,000/£14,300');
        await expect(card.locator('.kpi-card-sub')).toContainText('97.9% of the floor');
        await expect(card.locator('.kpi-card-sub')).toContainText('£300.00 below it');
        await expect(card).not.toContainText('On track');
        await expect(page.locator('#aiCommentary')).toContainText('£300.00 below the floor');
        await expect(page.locator('#aiCommentary')).toContainText('it is £16,000.00');   // only if the CFV Actioned tenancy pays
    });

    test('safe to withdraw holds back the £3,650 budget, which stays in the last day\'s balance', async ({ page }) => {
        await load(page);
        await expect(page.locator('#waHeldBackNote')).toContainText('Holds back £3,650.00');
        // Floor £500 + the £3,650 held back. Without the hold the advisor takes it down to the floor.
        expect(await finalBalance(page), 'the withdrawals took the held-back budget').toBeGreaterThanOrEqual(4150);
        // Control: the advisor still offers withdrawals, so the hold did not switch it off.
        await expect(page.locator('#cfWaControls')).toContainText('Safe to withdraw (31-day cycle)');
    });

    // Found in review: with no wages row in the weekly box, the £650 wages budget was held nowhere.
    test('a weekly box with no wages row holds back the wages budget too', async ({ page }) => {
        await load(page, { settings: { commitments: [{ label: 'Cleaner', amount: 10, day: 2 }] } });
        await expect(page.locator('#waHeldBackNote')).toContainText('Holds back £4,300.00 for wages');
        expect(await finalBalance(page)).toBeGreaterThanOrEqual(4800);
    });

    test('credit card payoff runs on personal net cash flow times the Debt pot share', async ({ page }) => {
        await load(page);
        const panel = page.locator('#creditCardSummary');
        // £1,000 a month personal net cash flow x 70% = £700 to the cards; £5,200 owed.
        await expect(panel).toContainText('At £700.00 a month to the cards', { timeout: 15000 });
        await expect(panel).toContainText('clears in ~8 months');
        await expect(page.locator('#ccPaymentInput')).toHaveValue('700');
    });

    test('a 0% Debt pot share says so, and gives no payoff time', async ({ page }) => {
        await load(page, { debtPct: 0 });
        await expect(page.locator('#creditCardSummary')).toContainText('Your Debt pot share is 0%', { timeout: 15000 });
        await expect(page.locator('#creditCardSummary')).not.toContainText('to clear');
    });

    test('the cash cushion cards headline the last full month, rolling 31 days beside it', async ({ page }) => {
        await load(page);
        const card = label => page.locator('#reQ4Cards .kpi-card').filter({ has: page.locator('.kpi-card-label', { hasText: label }) });
        const cushion = card('Property cushion (cash)');
        await expect(cushion.locator('.kpi-card-value')).toHaveText('£600');
        await expect(cushion.locator('.kpi-card-sub')).toContainText('the last full month');
        await expect(cushion.locator('.kpi-card-sub')).toContainText('rolling 31 days');
        const income = card('Income from property (cash)');
        await expect(income.locator('.kpi-card-value')).toHaveText('£600');
    });

    // Found in review: fmt() drops the minus sign, so a month that lost money read as a gain in the rows.
    test('a month that lost money shows the minus sign in the headline and the rows', async ({ page }) => {
        await load(page, { lastMonthFixed: -1400 });
        const cushion = page.locator('#reQ4Cards .kpi-card').filter({ has: page.locator('.kpi-card-label', { hasText: 'Property cushion (cash)' }) });
        await expect(cushion.locator('.kpi-card-value')).toHaveText('−£400');
        const row = label => cushion.locator('.kpi-card-detail .od-breakdown-row').filter({ has: page.locator('span', { hasText: new RegExp('^' + label + '$') }) });
        await expect(row('Property cushion \\(cash\\)')).toContainText('− £400.00');
        await expect(row('Income from property \\(cash\\)')).toContainText('− £400.00');
    });
});
