import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The dashboard loads js/re-kpis.js as a plain <script>; the same file exports under
// Node, so this suite runs the shipped rules, not a copy of them.
//
// The fixtures follow the three worked examples Kevin approved at the build gate on
// 2 Oct 2026 (cost split by business, one tenant moving between units, one house's
// certificates). Names, dates and rents are invented on purpose: this repo is public.
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const K = require(resolve(root, 'js/re-kpis.js'));

const TODAY = '2026-10-02';
const RE = 'recRE', PERSONAL = 'recPERSONAL';
const levels = r => r.alarms.map(a => a.level);

describe('plan cushion: property costs only', () => {
    const tenancies = [
        { rent: 34469.08, payStatus: 'In Payment', tenantActive: true },
        { rent: 900, payStatus: 'CFV Actioned', tenantActive: true },
        { rent: 500, payStatus: 'In Payment', tenantActive: false }, // ended: never rent now
        { rent: 900, payStatus: 'CFV', tenantActive: true },
    ];
    const costs = [
        { name: 'Mortgages', expected: 18916.78, active: true, businessIds: [RE] },
        { name: 'Household', expected: 3856.43, active: true, businessIds: [PERSONAL] },
        { name: 'Software', expected: 14.39, active: true, businessIds: ['recOD'] },
        { name: 'Paused', expected: 999, active: false, businessIds: [RE] },
    ];
    const r = K.planCushion({ tenancies, costs, businessId: RE, budget: 4300 });

    it('subtracts Real Estate costs and nothing else (worked example 1)', () => {
        expect(r.propertyCosts).toBe(18916.78);
        expect(r.excludedCosts).toBe(3870.82);
        expect(r.cushion).toBe(15552.3);
    });
    it("Kevin's income is the cushion less the variable budget", () => {
        expect(r.income).toBe(11252.3);
        expect(r.incomeWithActioned).toBe(12152.3);
    });
    it('the old mixed basis would have read 11,681.48: prove the test can tell them apart', () => {
        const mixed = K.planCushion({ tenancies, costs: costs.map(c => ({ ...c, businessIds: [RE] })), businessId: RE, budget: 4300 });
        expect(mixed.cushion).toBe(11681.48);
    });
    it('goes red when the tenancies or the costs did not load', () => {
        expect(K.alarmLevel(K.planCushion({ tenancies: [], costs, businessId: RE, budget: 4300 }))).toBe('red');
        expect(K.alarmLevel(K.planCushion({ tenancies, costs: [], businessId: RE, budget: 4300 }))).toBe('red');
        expect(K.alarmLevel(r)).toBe('');
    });
    it('names an active cost with no business instead of silently dropping it', () => {
        const x = K.planCushion({ tenancies, costs: [...costs, { name: 'Orphan', expected: 10, active: true, businessIds: [] }], businessId: RE, budget: 4300 });
        expect(levels(x)).toEqual(['amber']);
        expect(x.alarms[0].msg).toContain('Orphan');
    });
});

describe('cash cushion', () => {
    const tx = (date, amount, sub, extra = {}) => ({ id: date + sub + amount, date, amount, subCategories: [sub], businesses: ['Real Estate'], costIds: [], reconciled: true, description: '', ...extra });
    const transactions = [
        tx('2026-09-10', 1000, 'Rental Income'),
        tx('2026-09-12', -400, 'Mortgage Interest', { costIds: ['c1'] }),
        tx('2026-09-13', -50, 'Personal Household Essentials', { costIds: ['c2'], businesses: ['Personal'] }), // personal: never counted
        tx('2026-09-14', -30, 'Software & Subscriptions', { costIds: ['c3'] }),                                  // tagged property, cost record personal
        tx('2026-09-15', -400, 'COGS Property Utilities'),          // filed as utilities
        tx('2026-09-16', -100, 'COGS Property Reactive Maintenance'),
        tx('2026-09-20', -25, 'Mortgage Interest', { costIds: ['c1'] }),
        tx('2026-09-21', 25, 'Mortgage Interest', { costIds: ['c1'] }), // bounced direct debit coming back
        tx('2026-10-01', -60, 'Opex Labour'),
        tx('2026-08-01', 5000, 'Rental Income'),                    // outside the rolling window
    ];
    const costBusinessNames = { c1: ['Real Estate'], c2: ['Personal'], c3: ['Personal'] };
    const r = K.cashCushion({ transactions, costBusinessNames, businessName: 'Real Estate', today: TODAY, baselineMonths: ['2026-08', '2026-09'], feedStaleDays: 4 });

    it('rolling window is today and the 30 days before it', () => {
        expect(r.rolling.start).toBe('2026-09-02');
        expect(r.rolling.end).toBe(TODAY);
    });
    it('fixed = cost-linked property payments, signed so a reversal cancels', () => {
        expect(r.rolling.rent).toBe(1000);
        expect(r.rolling.fixed).toBe(430);
        expect(r.rolling.cushion).toBe(570);
    });
    it('variable = property payments with no cost record, split by budget line', () => {
        expect(r.rolling.variable).toBe(560);
        expect(r.rolling.variableLines).toEqual({ Utilities: 400, Maintenance: 100, Wages: 60 });
        expect(r.rolling.income).toBe(10);
    });
    it('flags a property payment whose cost record belongs to another business', () => {
        expect(r.rolling.mismatches).toHaveLength(1);
        expect(r.rolling.mismatches[0].amount).toBe(30);
    });
    it('last full month and the baseline average are whole calendar months', () => {
        expect(r.lastMonthKey).toBe('2026-09');
        expect(r.lastMonth.income).toBe(70);       // October wages are not in September
        expect(r.baseline.cushion).toBe(2785);     // (5000 + 570) / 2
    });

    // GOAL check 7: a broken input must turn the card red, not leave a calm number.
    it('goes red when the bank feed has stopped', () => {
        const stale = K.cashCushion({ transactions, costBusinessNames, businessName: 'Real Estate', today: '2026-10-09', baselineMonths: [], feedStaleDays: 4 });
        expect(K.alarmLevel(stale)).toBe('red');
        expect(stale.alarms[0].msg).toContain('2026-10-01');
    });
    it('goes red with no transactions at all, and when no rent is in the window', () => {
        expect(K.alarmLevel(K.cashCushion({ transactions: [], businessName: 'Real Estate', today: TODAY }))).toBe('red');
        const noRent = transactions.filter(t => t.subCategories[0] !== 'Rental Income');
        expect(K.alarmLevel(K.cashCushion({ transactions: noRent, costBusinessNames, businessName: 'Real Estate', today: TODAY }))).toBe('red');
    });
    // Found in review, 2 Oct 2026: the freshness test read EVERY account, so a live personal
    // card feed hid a property account that had stopped.
    it('a live personal feed does not hide a stopped property feed', () => {
        const personalOnly = [
            tx('2026-09-05', 1000, 'Rental Income'),
            tx('2026-09-10', -400, 'Mortgage Interest', { costIds: ['c1'] }),
            tx('2026-10-02', -20, 'Personal Household Essentials', { businesses: ['Personal'] }),
        ];
        const x = K.cashCushion({ transactions: personalOnly, costBusinessNames, businessName: 'Real Estate', today: TODAY, feedStaleDays: 4 });
        expect(K.alarmLevel(x)).toBe('red');
        expect(x.newestTransaction).toBe('2026-09-10');
    });
    // Found in review: a payment against a property cost record with no business tag was
    // dropped without a word, which reads as a bigger cushion.
    it('names a property cost payment that is not tagged to the property business', () => {
        const x = K.cashCushion({
            transactions: [tx('2026-09-30', 1000, 'Rental Income'), tx('2026-10-01', -400, 'Mortgage Interest', { costIds: ['c1'], businesses: [] })],
            costBusinessNames, businessName: 'Real Estate', today: TODAY,
        });
        expect(x.rolling.cushion).toBe(1000);
        expect(x.rolling.untagged).toHaveLength(1);
        expect(K.alarmLevel(x)).toBe('amber');
    });
    // Found on the live page, 2 Oct 2026: four rent receipts arrived unfiled, tagged to the
    // property business with no sub-category. The income line read them as money in
    // (£11,591) while the cushion ignored them, so the two cards disagreed by £2,977.
    it('an unfiled receipt counts in neither figure and raises amber', () => {
        const base = transactions.filter(t => !t.costIds.includes('c3'));
        const before = K.cashCushion({ transactions: base, costBusinessNames, businessName: 'Real Estate', today: TODAY });
        const withReceipt = [...base, tx('2026-10-01', 2449.09, '', { reconciled: false, subCategories: [] })];
        const after = K.cashCushion({ transactions: withReceipt, costBusinessNames, businessName: 'Real Estate', today: TODAY });
        expect(after.rolling.income).toBe(before.rolling.income);
        expect(after.rolling.cushion).toBe(before.rolling.cushion);
        expect(after.rolling.unreconciled).toBe(1);
        expect(K.alarmLevel(after)).toBe('amber');
    });
    it('goes amber, not red, while payments in the window are unfiled', () => {
        const unfiled = [...transactions.filter(t => !t.costIds.includes('c3')), tx('2026-09-30', -10, '', { reconciled: false, businesses: [] })];
        const x = K.cashCushion({ transactions: unfiled, costBusinessNames, businessName: 'Real Estate', today: TODAY });
        expect(K.alarmLevel(x)).toBe('amber');
    });
    it('a healthy feed raises nothing', () => {
        const clean = transactions.filter(t => !t.costIds.includes('c3'));
        expect(K.alarmLevel(K.cashCushion({ transactions: clean, costBusinessNames, businessName: 'Real Estate', today: TODAY }))).toBe('');
    });
});

// Worked example 2: one tenant (CFV Actioned, £900) living in a named unit that only
// counts once somebody ELSE lives there.
describe('named units and named rent', () => {
    const MOVER = 'tenMover', SAMPLE = 'tenSample';
    const units = [
        { id: 'uA', label: 'House A Unit 3' },
        { id: 'uB', label: 'House A Unit 4' },
        { id: 'uC', label: 'House B Unit 3' },
        { id: 'uD', label: 'House C Unit 2', excludeTenantIds: [MOVER] },
        { id: 'uE', label: 'House D Unit 1', stretch: true },
    ];
    const lines = [
        { label: 'New tenant A3', unitId: 'uA' },
        { label: 'Mover', tenantId: MOVER },
        { label: 'Sample', tenantId: SAMPLE },
        { label: 'New tenant C2', unitId: 'uD', excludeTenantIds: [MOVER], stretch: true },
        { label: 'New tenant A4', unitId: 'uB', stretch: true },
        { label: 'New tenant D1', unitId: 'uE', stretch: true },
    ];
    const today = [
        { id: 't1', unitIds: ['uD'], tenantIds: [MOVER], surname: 'Mover', start: '2026-04-09', end: '', payStatus: 'CFV Actioned', rent: 900 },
        { id: 't2', unitIds: ['uZ'], tenantIds: [SAMPLE], surname: 'Sample', start: '2026-03-11', end: '', payStatus: 'CFV', rent: 900 },
        { id: 't3', unitIds: ['uE'], tenantIds: ['tenOld'], surname: 'Old', start: '2022-02-10', end: '2026-05-14', payStatus: 'In Payment', rent: 500 },
    ];
    const known = { knownUnitIds: ['uA', 'uB', 'uC', 'uD', 'uE'], knownTenantIds: [MOVER, SAMPLE, 'tenOld'], today: TODAY };

    it('today: 0 of 4 and £0 (worked example 2)', () => {
        const u = K.namedUnits({ units, tenancies: today, ...known });
        expect([u.filled, u.of, u.value, u.stretchOf]).toEqual([0, 4, 0, 5]);
        expect(u.rows.find(r => r.id === 'uD').filled).toBe(false); // only the mover lives there
        expect(u.rows.find(r => r.id === 'uE').filled).toBe(false); // that tenancy ended in May
        const r = K.namedRent({ lines, tenancies: today, ...known });
        expect(r.value).toBe(0);
        expect(r.rows.find(x => x.label === 'Mover').status).toBe('CFV Actioned');
        expect(K.alarmLevel(u)).toBe('');
        expect(K.alarmLevel(r)).toBe('');
    });

    const later = [
        { id: 't1', unitIds: ['uD'], tenantIds: [MOVER], surname: 'Mover', start: '2026-04-09', end: '2026-09-20', payStatus: 'CFV Actioned', rent: 900 },
        { id: 't1b', unitIds: ['uC'], tenantIds: [MOVER], surname: 'Mover', start: '2026-09-21', end: '', payStatus: 'In Payment', rent: 900 },
        { id: 't2', unitIds: ['uZ'], tenantIds: [SAMPLE], surname: 'Sample', start: '2026-03-11', end: '', payStatus: 'In Payment', rent: 900 },
        { id: 't4', unitIds: ['uA'], tenantIds: ['tenNewA'], surname: 'NewA', start: '2026-10-01', end: '', payStatus: 'In Payment', rent: 900 },
        { id: 't5', unitIds: ['uD'], tenantIds: ['tenNewD'], surname: 'NewD', start: '2026-09-25', end: '', payStatus: 'CFV', rent: 900 },
        { id: 't6', unitIds: ['uB'], tenantIds: ['tenFuture'], surname: 'Future', start: '2026-11-01', end: '', payStatus: '', rent: 900 },
        { id: 't7', unitIds: ['uQ'], tenantIds: ['tenReplacement'], surname: 'Replacement', start: '2026-09-01', end: '', payStatus: 'In Payment', rent: 600 },
    ];
    it('counts a unit when a live tenancy is linked, and the excluded unit once someone else is in', () => {
        const u = K.namedUnits({ units, tenancies: later, ...known });
        expect(u.filled).toBe(3);                                   // A3, B3 (the mover), C2 (the new tenant)
        expect(u.rows.find(r => r.id === 'uB').filled).toBe(false); // starts next month: not in yet
    });
    it('committed rent is the three named tenants in payment (£2,700); a replacement elsewhere never counts', () => {
        const r = K.namedRent({ lines, tenancies: later, ...known });
        expect(r.committed).toBe(2700);
        expect(r.stretch).toBe(0);                                  // the new C2 tenant is not paying yet
        expect(r.value).toBe(2700);
    });
    it('a tenancy is counted once even when two lines could claim it', () => {
        const both = [{ label: 'By unit', unitId: 'uA' }, { label: 'By tenant', tenantId: 'tenNewA' }];
        expect(K.namedRent({ lines: both, tenancies: later, today: TODAY }).value).toBe(900);
    });
    it('goes red when a rent line points at a unit that does not exist', () => {
        const typo = [{ label: 'Typo', unitId: 'uTYPO' }];
        expect(K.alarmLevel(K.namedRent({ lines: typo, tenancies: today, knownUnitIds: known.knownUnitIds, today: TODAY }))).toBe('red');
    });
    it('says so when a let unit reads empty only because the tenancy has no start date', () => {
        const undated = [{ id: 't9', unitIds: ['uA'], tenantIds: ['tenNew'], surname: 'New', start: '', end: '', payStatus: 'In Payment', rent: 900 }];
        const u = K.namedUnits({ units, tenancies: undated, ...known });
        expect(u.filled).toBe(0);
        expect(K.alarmLevel(u)).toBe('amber');
    });
    it('goes red when a named unit or tenant is missing, or nothing loaded', () => {
        expect(K.alarmLevel(K.namedUnits({ units, tenancies: today, knownUnitIds: ['uA'], today: TODAY }))).toBe('red');
        expect(K.alarmLevel(K.namedRent({ lines, tenancies: today, knownTenantIds: [MOVER], today: TODAY }))).toBe('red');
        expect(K.alarmLevel(K.namedUnits({ units, tenancies: [], knownUnitIds: known.knownUnitIds, today: TODAY }))).toBe('red');
    });
});

// Worked example 3: electrical to 2030 and insurance to 2027, but no gas certificate
// and no "no gas" mark, so the property is not compliant.
describe('compliance', () => {
    const cert = (propertyId, type, renewal, extra = {}) => ({ propertyId, type, renewal, status: 'Active', hasFile: true, ...extra });
    const properties = [
        { id: 'p1', name: 'House B', agent: 'Property Portfolio', noGas: false },
        { id: 'p2', name: 'House A', agent: 'Property Portfolio', noGas: true },
        { id: 'p3', name: 'House E', agent: 'Property Portfolio', noGas: false },
        { id: 'p4', name: 'Agent house', agent: 'Some Lettings Ltd', noGas: false },
    ];
    const certs = [
        cert('p1', 'EICR', '2030-09-11'), cert('p1', 'Landlord Insurance', '2027-03-02'),
        cert('p2', 'EICR', '2031-01-01'), cert('p2', 'Landlord Insurance', '2027-03-02'),
        cert('p3', 'GSC', '2026-09-08'),                                   // lapsed last month
        cert('p3', 'EICR', '2031-01-01', { hasFile: false }),              // in date but no document on file
        cert('p3', 'Landlord Insurance', '2027-03-02', { status: 'Expired' }),
        cert('p4', 'GSC', '2027-01-01'), cert('p4', 'EICR', '2031-01-01'), cert('p4', 'Landlord Insurance', '2027-03-02'),
    ];
    const run = extra => K.compliance({ properties, certs, selfManagedAgent: 'Property Portfolio', expected: 3, today: TODAY, ...extra });

    it('no gas certificate and no "no gas" mark is not compliant (worked example 3)', () => {
        const row = run().rows.find(r => r.id === 'p1');
        expect(row).toMatchObject({ gas: 'Missing', electrical: 'OK', insurance: 'OK', compliant: false });
    });
    it('"no gas" stands in for the gas certificate; agent-managed houses are never counted', () => {
        const r = run();
        expect([r.value, r.of]).toEqual([1, 3]);
        expect(r.rows.find(x => x.id === 'p2').compliant).toBe(true);
    });
    it('lapsed, expired and not-on-file certificates each fail', () => {
        expect(run().rows.find(r => r.id === 'p3')).toMatchObject({ gas: 'Missing', electrical: 'Missing', insurance: 'Missing' });
    });
    it('a certificate that runs out today still counts today', () => {
        const r = K.compliance({ properties, certs: [...certs, cert('p1', 'GSC', TODAY)], selfManagedAgent: 'Property Portfolio', expected: 3, today: TODAY });
        expect(r.value).toBe(2);
    });
    // Found in review: a certificate type renamed in Airtable made every property read
    // Missing and saved a calm 0.
    it('goes red when a whole certificate type is absent from the book', () => {
        const r = run({ certs: certs.filter(c => c.type !== 'GSC') });
        expect(K.alarmLevel(r)).toBe('red');
        expect(r.alarms[0].msg).toContain('GSC');
    });
    it('goes red with no certificates, amber when the count of houses is not the one expected', () => {
        expect(K.alarmLevel(run({ certs: [] }))).toBe('red');
        expect(K.alarmLevel(run({ expected: 13 }))).toBe('amber');
        expect(K.alarmLevel(run())).toBe('');
    });
});

describe('personal net cash flow', () => {
    const months = [{ key: '2026-07', net: 6609.82, totalIncome: 35000 }, { key: '2026-08', net: 4534.69, totalIncome: 34000 }, { key: '2026-09', net: 6008.35, totalIncome: 35900 }];
    it('headline is the last full month; the average is beside it', () => {
        const r = K.personalNet({ months });
        expect(r.value).toBe(6008.35);
        expect(r.lastMonthKey).toBe('2026-09');
        expect(r.average).toBe(5717.62);
    });
    it('goes red when the Wealth cash flow is empty', () => {
        expect(K.alarmLevel(K.personalNet({ months: [] }))).toBe('red');
        expect(K.alarmLevel(K.personalNet({ months: months.map(m => ({ ...m, totalIncome: 0 })) }))).toBe('red');
    });
});

describe('alarmLevel', () => {
    it('a missing result is red, never blank', () => {
        expect(K.alarmLevel(null)).toBe('red');
        expect(K.alarmLevel({ alarms: [] })).toBe('');
    });
});
