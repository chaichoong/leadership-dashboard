import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The dashboard loads js/re-kpis.js as a plain <script>; the same file exports under
// Node, so this suite runs the shipped rules, not a copy of them.
//
// The fixtures follow the three worked examples Kevin approved at the build gate on
// 2 Oct 2026 (cost split by business, one tenant moving between units, one house's
// certificates). Every name, date and amount is invented on purpose: this repo is public.
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const K = require(resolve(root, 'js/re-kpis.js'));

const TODAY = '2026-10-02';
const RE = 'recRE', PERSONAL = 'recPERSONAL';
const levels = r => r.alarms.map(a => a.level);

describe('plan cushion: property costs only', () => {
    const tenancies = [
        { rent: 31250.40, payStatus: 'In Payment', tenantActive: true },
        { rent: 900, payStatus: 'CFV Actioned', tenantActive: true },
        { rent: 500, payStatus: 'In Payment', tenantActive: false }, // ended: never rent now
        { rent: 850, payStatus: 'CFV', tenantActive: true },
    ];
    const costs = [
        { name: 'Mortgages', expected: 17120.85, active: true, businessIds: [RE] },
        { name: 'Household', expected: 3410.27, active: true, businessIds: [PERSONAL] },
        { name: 'Software', expected: 14.75, active: true, businessIds: ['recOD'] },
        { name: 'Paused', expected: 999, active: false, businessIds: [RE] },
    ];
    const r = K.planCushion({ tenancies, costs, businessId: RE, budget: 4000 });

    it('subtracts Real Estate costs and nothing else (worked example 1)', () => {
        expect(r.propertyCosts).toBe(17120.85);
        expect(r.excludedCosts).toBe(3425.02);
        expect(r.cushion).toBe(14129.55);
    });
    it("Kevin's income is the cushion less the variable budget", () => {
        expect(r.income).toBe(10129.55);
        expect(r.incomeWithActioned).toBe(11029.55);
    });
    it('the old mixed basis would have read 10,704.53: prove the test can tell them apart', () => {
        const mixed = K.planCushion({ tenancies, costs: costs.map(c => ({ ...c, businessIds: [RE] })), businessId: RE, budget: 4000 });
        expect(mixed.cushion).toBe(10704.53);
    });
    it('goes red when the tenancies or the costs did not load', () => {
        expect(K.alarmLevel(K.planCushion({ tenancies: [], costs, businessId: RE, budget: 4000 }))).toBe('red');
        expect(K.alarmLevel(K.planCushion({ tenancies, costs: [], businessId: RE, budget: 4000 }))).toBe('red');
        expect(K.alarmLevel(r)).toBe('');
    });
    it('names an active cost with no business instead of silently dropping it', () => {
        const x = K.planCushion({ tenancies, costs: [...costs, { name: 'Orphan', expected: 10, active: true, businessIds: [] }], businessId: RE, budget: 4000 });
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
    // while the cushion ignored them, so the two cards disagreed.
    it('an unfiled receipt counts in neither figure and raises amber', () => {
        const base = transactions.filter(t => !t.costIds.includes('c3'));
        const before = K.cashCushion({ transactions: base, costBusinessNames, businessName: 'Real Estate', today: TODAY });
        const withReceipt = [...base, tx('2026-10-01', 2400.50, '', { reconciled: false, subCategories: [] })];
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

// Kevin, 9 to 10 Oct 2026: three units move from a serviced-accommodation operator to a letting
// agent. Each unit already holds a live tenancy under the old arrangement, and two also hold an old
// record with no end date, so only a tenancy that STARTS on or after the move date counts. Shaped on
// the real units (an old record from 2021 plus the current arrangement from 2026); ids invented.
describe('named units since a move date: the old arrangement never counts', () => {
    const units = [
        { id: 'mv1', label: 'Moving unit 1' },
        { id: 'mv2', label: 'Moving unit 2' },
        { id: 'mv3', label: 'Moving stretch unit', stretch: true },
    ];
    const old = [
        { id: 'o1', unitIds: ['mv1'], tenantIds: ['tenLegacy1'], surname: '', start: '2021-02-24', end: '', payStatus: '', rent: 0 },
        { id: 'o2', unitIds: ['mv1'], tenantIds: ['tenOperator'], surname: 'Operator', start: '2026-01-01', end: '', payStatus: 'CFV', rent: 500 },
        { id: 'o3', unitIds: ['mv2'], tenantIds: ['tenOperator'], surname: 'Operator', start: '2026-01-01', end: '', payStatus: 'CFV', rent: 500 },
        { id: 'o4', unitIds: ['mv2'], tenantIds: ['tenLegacy2'], surname: '', start: '2021-02-24', end: '', payStatus: '', rent: 0 },
        { id: 'o5', unitIds: ['mv3'], tenantIds: ['tenOperator'], surname: 'Operator', start: '2026-04-01', end: '', payStatus: 'CFV', rent: 500 },
    ];
    const known = { knownUnitIds: ['mv1', 'mv2', 'mv3'], since: '2026-10-09' };

    it('today: 0 of 2, every unit shown as still on the old arrangement', () => {
        const u = K.namedUnits({ units, tenancies: old, today: '2026-10-10', ...known });
        expect([u.filled, u.of, u.value, u.stretchOf]).toEqual([0, 2, 0, 3]);
        expect(u.rows.map(r => r.held)).toEqual([2, 2, 1]);
        expect(u.rows.every(r => r.outgoing === '')).toBe(true);
        expect(K.alarmLevel(u)).toBe('');
    });
    it('counts a new tenancy from the move date, even while the old record stays live', () => {
        const moved = [...old,
            { id: 'n1', unitIds: ['mv1'], tenantIds: ['tenNew1'], surname: 'NewOne', start: '2026-11-20', end: '', payStatus: 'In Payment', rent: 650 },
            { id: 'n2', unitIds: ['mv2'], tenantIds: ['tenNew2'], surname: 'NewTwo', start: '2026-12-05', end: '', payStatus: '', rent: 640 }];
        const u = K.namedUnits({ units, tenancies: moved, today: '2026-11-25', ...known });
        expect(u.filled).toBe(1);
        expect(u.rows[0]).toMatchObject({ filled: true, tenant: 'NewOne', held: 0 });
        expect(u.rows[1].incoming).toEqual({ tenant: 'NewTwo', start: '2026-12-05' });
        const later = K.namedUnits({ units, tenancies: moved, today: '2026-12-06', ...known });
        expect([later.filled, later.value]).toEqual([2, 2]);
    });
    it('the old tenant re-dated after the move (a rent change is a new tenancy) never counts', () => {
        const excl = units.map(u => ({ ...u, excludeTenantIds: ['tenOperator'] }));
        const redated = [...old, { id: 'r1', unitIds: ['mv1'], tenantIds: ['tenOperator'], surname: 'Operator', start: '2026-10-15', end: '', payStatus: 'CFV', rent: 550 }];
        const u = K.namedUnits({ units: excl, tenancies: redated, today: '2026-10-20', ...known });
        expect(u.filled).toBe(0);
        expect(u.rows[0].held).toBe(3);                              // the label still says "old arrangement"
    });
    it('without a move date the same units read as already let, which is why the date is set', () => {
        const u = K.namedUnits({ units, tenancies: old, today: '2026-10-10', knownUnitIds: known.knownUnitIds });
        expect(u.filled).toBe(2);
    });
});

// Kevin, 6 Oct 2026: a room that replaces a leaving tenant is a named unit too. Shaped on
// the live case (a tenant still paying the old rate while a new tenant at the newer rate
// is found), with every name and amount invented.
describe('replacement rooms', () => {
    const LEAVER = 'tenLeaver';
    const units = [
        { id: 'uR', label: 'House F Unit 3', excludeTenantIds: [LEAVER] },
        { id: 'uS', label: 'House G Unit 1', stretch: true },
    ];
    const lines = [{ label: 'New tenant F3', unitId: 'uR', excludeTenantIds: [LEAVER], replacesRent: 510.40, stretch: true }];
    const known = { knownUnitIds: ['uR', 'uS'], today: TODAY };
    const leaver = { id: 'tL', unitIds: ['uR'], tenantIds: [LEAVER], surname: 'Leaver', start: '2025-05-21', end: '', payStatus: 'In Payment', rent: 510.40 };
    const incoming = { id: 'tN', unitIds: ['uR'], tenantIds: ['tenIncoming'], surname: 'Incoming', start: '2026-09-28', end: '', payStatus: 'In Payment', rent: 880.25 };

    it('a room holding only the leaving tenant is not filled, and says who is still on record', () => {
        const u = K.namedUnits({ units, tenancies: [leaver], ...known });
        expect([u.filled, u.of]).toEqual([0, 1]);
        expect(u.rows[0]).toMatchObject({ filled: false, outgoing: 'Leaver', incoming: null });
        expect(u.rows[1]).toMatchObject({ filled: false, outgoing: '', incoming: null });   // a truly empty room stays "Empty"
    });
    it('the new tenant fills the room even while the leaver is still linked', () => {
        const u = K.namedUnits({ units, tenancies: [leaver, incoming], ...known });
        expect(u.filled).toBe(1);
        expect(u.rows[0]).toMatchObject({ filled: true, tenant: 'Incoming', outgoing: '' });
    });
    it('a new tenant signed to move in later is shown, but not counted', () => {
        const u = K.namedUnits({ units, tenancies: [leaver, { ...incoming, start: '2026-11-01', payStatus: '' }], ...known });
        expect(u.filled).toBe(0);
        expect(u.rows[0].incoming).toEqual({ tenant: 'Incoming', start: '2026-11-01' });
    });
    it('only the rise over the leaving tenant\'s rent counts as new rent', () => {
        const r = K.namedRent({ lines, tenancies: [leaver, incoming], ...known });
        expect(r.rows[0]).toMatchObject({ rent: 369.85, replaces: 510.4, status: 'In Payment' });
        expect(r.stretch).toBe(369.85);
        expect(K.alarmLevel(r)).toBe('');
    });
    it('nets the fixed figure the plan counted, even when the leaver moves on at another rent', () => {
        const moved = [{ ...leaver, end: '2026-09-30' }, { id: 'tL2', unitIds: ['uX'], tenantIds: [LEAVER], surname: 'Leaver', start: '2026-10-01', end: '', payStatus: 'In Payment', rent: 650 }];
        expect(K.namedRent({ lines, tenancies: [...moved, incoming], ...known }).value).toBe(369.85);
    });
    it('a re-let below the old rent is a loss, not a gain', () => {
        expect(K.namedRent({ lines, tenancies: [leaver, { ...incoming, rent: 450 }], ...known }).value).toBe(-60.4);
    });
    it('counts nothing before the new tenant is paying', () => {
        expect(K.namedRent({ lines, tenancies: [leaver, { ...incoming, payStatus: 'CFV' }], ...known }).value).toBe(0);
    });
    it('goes amber when another line has already counted the room\'s tenant at full rent', () => {
        const both = [{ label: 'Named tenant', tenantId: 'tenIncoming' }, ...lines];
        const r = K.namedRent({ lines: both, tenancies: [leaver, incoming], ...known });
        expect(r.value).toBe(880.25);
        expect(K.alarmLevel(r)).toBe('amber');
    });
});

// The live list in js/config.js. The 2 Oct build counted four units while the plan named
// five tenants to find (Kevin, 6 Oct 2026): the target and the list must agree.
describe('the Q4 named units in js/config.js', () => {
    const sandbox = { window: {}, console };
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(resolve(root, 'js/config.js'), 'utf8') + '\nglobalThis.__RE_Q4 = RE_Q4;', sandbox);
    const Q = sandbox.__RE_Q4;

    it('the unit target matches the units listed: five committed, six with the stretch', () => {
        expect(Q.units.filter(u => !u.stretch).length).toBe(Q.targets.namedUnits.committed);
        expect(Q.units.length).toBe(Q.targets.namedUnits.stretch);
        expect([Q.targets.namedUnits.committed, Q.targets.namedUnits.stretch]).toEqual([5, 6]);
    });
    it('every replacement rent line names the leaving tenant, and matches its unit', () => {
        const repl = Q.rent.filter(l => l.replacesRent);
        expect(repl.length).toBe(2);
        repl.forEach(l => {
            expect(l.excludeTenantIds && l.excludeTenantIds.length).toBeTruthy();
            expect(Q.units.find(u => u.id === l.unitId).excludeTenantIds).toEqual(l.excludeTenantIds);
        });
    });
    it('the stretch targets rose by exactly the two re-lets at £897.52 over the leaving rents', () => {
        const rise = Q.rent.filter(l => l.replacesRent).reduce((s, l) => s + (897.52 - l.replacesRent), 0);
        expect(Math.round(rise * 100) / 100).toBe(745.62);
        expect(Q.targets.namedRent.stretch - 5318).toBe(Math.round(rise));
        expect(Q.targets.cushionPlan.stretch - 21187).toBe(Math.round(rise));
        expect(Q.targets.incomePlan.stretch - 16887).toBe(Math.round(rise));
        expect(Q.targets.personalNet.stretch - 11250).toBe(Math.round(rise));
        expect([Q.targets.namedRent.committed, Q.targets.cushionPlan.committed, Q.targets.incomePlan.committed]).toEqual([2693, 18245, 13945]);
    });
    it('every named unit has a rent line, so a unit cannot be counted without its rent', () => {
        Q.units.forEach(u => expect(Q.rent.some(l => l.unitId === u.id)).toBe(true));
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
        cert('p1', 'EICR', '2030-09-15'), cert('p1', 'Landlord Insurance', '2027-03-10'),
        cert('p2', 'EICR', '2031-01-01'), cert('p2', 'Landlord Insurance', '2027-03-10'),
        cert('p3', 'GSC', '2026-09-12'),                                   // lapsed last month
        cert('p3', 'EICR', '2031-01-01', { hasFile: false }),              // in date but no document on file
        cert('p3', 'Landlord Insurance', '2027-03-10', { status: 'Expired' }),
        cert('p4', 'GSC', '2027-01-01'), cert('p4', 'EICR', '2031-01-01'), cert('p4', 'Landlord Insurance', '2027-03-10'),
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
    const months = [{ key: '2026-07', net: 6200.40, totalIncome: 32000 }, { key: '2026-08', net: 4410.15, totalIncome: 31000 }, { key: '2026-09', net: 5890.25, totalIncome: 32500 }];
    it('headline is the last full month; the average is beside it', () => {
        const r = K.personalNet({ months });
        expect(r.value).toBe(5890.25);
        expect(r.lastMonthKey).toBe('2026-09');
        expect(r.average).toBe(5500.27);
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
