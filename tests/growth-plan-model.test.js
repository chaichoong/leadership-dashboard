import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The page loads js/growth-plan-model.js as a plain <script>; the same file exports
// under Node, so this suite runs the shipped maths, not a copy of it.
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const M = require(resolve(root, 'js/growth-plan-model.js'));

const TODAY = '2026-09-09';
const S = {}; // empty settings → the 2026-27 defaults baked into the model

function fixture(overrides = {}) {
    // One Haverhill house: a 37-year-old UC tenant in a room, a 52-year-old in a
    // two-room flat-let, a 24-year-old in a room. Council tax paid by the owner.
    const base = {
        properties: [{ id: 'p1', name: '18 Test Park', type: 'HMO', beds: 3, agent: 'Property Portfolio', postcode: 'CB9 0AJ', ctNote: '£135.00', lettableRooms: null, payg: 'Unknown', ctPayer: 'Unknown' }],
        units: [
            { id: 'u1', propertyId: 'p1', number: 1, type: 'Room', status: 'Occupied', rent: 524.90, incomeType: 'Universal Credit', tenantIds: ['t1'] },
            { id: 'u2', propertyId: 'p1', number: 2, type: 'Flat-Let', status: 'Occupied', rent: 897.52, incomeType: 'Universal Credit', tenantIds: ['t2'] },
            { id: 'u3', propertyId: 'p1', number: 3, type: 'Room', status: 'Occupied', rent: 524.90, incomeType: 'Universal Credit', tenantIds: ['t3'] },
        ],
        tenants: [
            { id: 't1', name: 'Adam Older', status: 'Active', dob: '1988-11-24', payType: 'Universal Credit', capExemption: 'Unknown' },
            { id: 't2', name: 'Paul Flat', status: 'Active', dob: '1974-01-01', payType: 'Universal Credit', capExemption: 'LCWRA' },
            { id: 't3', name: 'Travis Young', status: 'Active', dob: '2002-05-05', payType: 'Universal Credit', capExemption: 'Unknown' },
        ],
        tenancies: [
            { id: 'c1', tenantIds: ['t1'], unitId: 'u1', rent: 524.90 },
            { id: 'c2', tenantIds: ['t2'], unitId: 'u2', rent: 897.52 },
            { id: 'c3', tenantIds: ['t3'], unitId: 'u3', rent: 524.90 },
        ],
        costs: [{ propertyId: 'p1', name: 'West Suffolk Council - CT', monthly: 135 }],
        planRows: [],
    };
    return Object.assign(base, overrides);
}

describe('benefit cap calculator (2026-27 figures)', () => {
    it('caps a single over-35 on £900 housing with no exemption by £95.48', () => {
        const r = M.benefitCap({ single: true, age: 35, housing: 900 }, S);
        expect(r.standard).toBe(424.90);
        expect(r.cap).toBe(1229.42);
        expect(r.capped).toBe(true);
        expect(r.shortfall).toBe(95.48);
        expect(r.safeRent).toBe(804.52);
    });
    it('LCWRA, PIP/DLA, carer and £881 earnings each lift the cap', () => {
        expect(M.benefitCap({ housing: 900, lcwra: 'existing' }, S).exempt).toBe(true);
        expect(M.benefitCap({ housing: 900, pipDla: true }, S).exempt).toBe(true);
        expect(M.benefitCap({ housing: 900, carer: true }, S).exempt).toBe(true);
        expect(M.benefitCap({ housing: 900, earnings: 881 }, S).exempt).toBe(true);
        expect(M.benefitCap({ housing: 900, earnings: 880.99 }, S).exempt).toBe(false);
    });
    it('uses the family cap and child elements for a parent', () => {
        const r = M.benefitCap({ single: true, children: 2, housing: 1125 }, S);
        expect(r.cap).toBe(1835);
        expect(r.elements).toBe(607.88);
        expect(r.capped).toBe(true);
    });
    it('reads figures from settings when present', () => {
        const r = M.benefitCap({ housing: 900 }, { benefit_cap_single: 1300, uc_standard_single_25: 400 });
        expect(r.safeRent).toBe(900);
        expect(r.capped).toBe(false);
    });
    it('tapers earnings below the threshold before comparing to the cap', () => {
        const r = M.benefitCap({ housing: 900, earnings: 627 }, S); // £200 over the £427 work allowance
        expect(r.taperDeduction).toBe(110);
        expect(r.ucBeforeCap).toBe(1214.9);
        expect(r.capped).toBe(false);
    });
});

describe('ages, BRMAs and rates', () => {
    it('computes age from a date of birth on a given day', () => {
        expect(M.ageOn('1988-11-24', TODAY)).toBe(37);
        expect(M.ageOn('1991-09-10', TODAY)).toBe(34); // birthday tomorrow
        expect(M.ageOn('1991-09-09', TODAY)).toBe(35);
        expect(M.ageOn('', TODAY)).toBe(null);
    });
    it('maps Haverhill and Soham to Cambridge, Manchester M40 to Central Greater Manchester', () => {
        expect(M.brmaFor('CB9 0AJ')).toBe('Cambridge');
        expect(M.brmaFor('cb7 5uz')).toBe('Cambridge');
        expect(M.brmaFor('M40 1EZ')).toBe('Central Greater Manchester');
        expect(M.brmaFor('SA5 7JW')).toBe(null);
        // Looked up on LHA Direct, 9 Sep 2026
        expect(M.brmaFor('BB7 2NX')).toBe('East Lancs');
        expect(M.brmaFor('SR8 4QQ')).toBe('Sunderland');
        expect(M.ratesFor('SR8 4QQ', S).b1).toBe(423.84);
    });
    it('Cambridge room and 1-bed rates come from settings when set, gov.uk figures otherwise', () => {
        expect(M.ratesFor('CB9 0AJ', S)).toMatchObject({ sar: 524.90, b1: 897.52 }); // £121.13 and £207.12 a week, LHA Direct Sep 2026
        expect(M.weeklyToMonthly(207.12)).toBe(897.52);
        expect(M.brmaFor('BB12 0LG')).toBe('West Pennine');
        expect(M.brmaFor('HU3 3QA')).toBe('East Riding');
        expect(M.brmaFor('LA13 9PY')).toBe('Furness');
        expect(M.ratesFor('CB9 0AJ', { lha_1bed: 925 }).b1).toBe(925);
    });
    it('flags the LHA table as stale after 31 March 2027', () => {
        expect(M.lhaStale('2027-03-31')).toBe(false);
        expect(M.lhaStale('2027-04-01')).toBe(true);
    });
});

describe('buildPlan levers', () => {
    it('lifts a 37-year-old UC room tenant to the full 1-bed rate and names the CRF shortfall to apply for', () => {
        const p = M.buildPlan(fixture(), S, TODAY);
        const l = p.levers.find(x => x.key === 'uplift:t1');
        expect(l).toBeTruthy();
        expect(l.lever).toBe('Rent uplift');
        expect(l.monthly).toBe(372.62);          // 897.52 - 524.90: rent is never lowered for the cap
        expect(l.capShortfall).toBe(93);         // 424.90 + 897.52 - 1229.42
        expect(l.effort).toBe('Paper');
        expect(l.needs[0]).toMatch(/CRF Housing Payment of £93.00/);
    });
    it('an evidenced exemption removes the CRF need, not the uplift', () => {
        const f = fixture(); f.tenants[0].capExemption = 'PIP or DLA';
        const l = M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'uplift:t1');
        expect(l.monthly).toBe(372.62);
        expect(l.capShortfall).toBe(0);
        expect(l.needs).toEqual([]);
    });
    it('never uplifts an under-35 in a room, and lists an unknown age separately', () => {
        const f = fixture(); f.tenants[2].dob = '';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'uplift:t3')).toBeUndefined();
        expect(p.unknownAge.map(u => u.tenant)).toEqual(['Travis Young']);
        expect(p.unknownAge[0].upliftIfOver35).toBe(372.62);
    });
    it('Housing Benefit in a shared room keeps the shared rate at any age', () => {
        const f = fixture(); f.units[0].incomeType = 'Housing Benefit'; f.tenants[0].payType = 'Working';
        expect(M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'uplift:t1')).toBeUndefined();
    });
    it('with no strategy set, a freed room is a candidate (check bucket) at the full 1-bed rate, bills with the tenant', () => {
        const p = M.buildPlan(fixture(), S, TODAY);
        const l = p.levers.find(x => x.key === 'rooms:p1');
        expect(l.lever).toBe('Room release');
        expect(l.count).toBe(1);
        expect(l.monthly).toBe(897.52);      // council tax already with the owner; PAYG so no utilities
        expect(l.capShortfall).toBe(93);
        expect(l.counted).toBe('check');
        expect(l.needs[0]).toMatch(/Set Growth Strategy/);
        expect(l.oneOff).toBe(1500);
    });
    it('Add tenants strategy counts the planned number of new lets as now', () => {
        const f = fixture(); f.properties[0].strategy = 'Add tenants'; f.properties[0].plannedExtra = 2;
        const l = M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'rooms:p1');
        expect(l.count).toBe(2);
        expect(l.counted).toBe('now');
        expect(l.monthly).toBe(1795.04);
        expect(l.capShortfall).toBe(186);
    });
    it('Hold strategy produces no house lever; uplifts still show', () => {
        const f = fixture(); f.properties[0].strategy = 'Hold';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'rooms:p1')).toBeUndefined();
        expect(p.levers.find(x => x.key === 'ct:p1')).toBeUndefined();
        expect(p.levers.find(x => x.key === 'uplift:t1')).toBeTruthy();
    });
    it('utilities only come off a new let when Kevin has taken the bills on (PAYG = No)', () => {
        const f = fixture(); f.properties[0].strategy = 'Add tenants'; f.properties[0].plannedExtra = 1; f.properties[0].payg = 'No';
        expect(M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'rooms:p1').monthly).toBe(897.52 - 75);
    });
    it('adds council tax to a new let when the house is not already owner-liable', () => {
        const f = fixture(); f.costs = []; f.properties[0].ctNote = ''; f.properties[0].strategy = 'Add tenants'; f.properties[0].plannedExtra = 1;
        expect(M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'rooms:p1').monthly).toBe(897.52 - 145);
    });
    it('with no strategy, a two-tenant house shows the joint tenancy as a candidate, either/or with the room let', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop();
        f.properties[0].ctPayer = 'Owner';
        const p = M.buildPlan(f, S, TODAY);
        const ct = p.levers.find(x => x.key === 'ct:p1');
        expect(ct.monthly).toBe(135);
        expect(ct.alternative).toBe(true);
        expect(ct.counted).toBe('alternative'); // the room let (897.52) beats it while nothing is decided
        expect(p.totals.paper).toBe(372.62); // the uplift only; the CT saving is not double counted
    });
    it('Joint tenancy strategy counts the council tax saving and drops the room let', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop();
        f.properties[0].strategy = 'Joint tenancy';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'ct:p1').counted).toBe('now');
        expect(p.levers.find(x => x.key === 'rooms:p1')).toBeUndefined();
        expect(p.totals.paper).toBe(372.62 + 135);
    });
    it('Add tenants strategy drops the joint tenancy lever', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop();
        f.properties[0].strategy = 'Add tenants'; f.properties[0].plannedExtra = 1;
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'ct:p1')).toBeUndefined();
        expect(p.levers.find(x => x.key === 'rooms:p1').counted).toBe('now');
    });
    it('prices a Collins property as a take-back and a Roc Immo house as agent-held', () => {
        const f = fixture();
        f.properties.push({ id: 'p2', name: '13 John Street', agent: 'Simon Collins', postcode: 'BB5 5PT' });
        f.properties.push({ id: 'p3', name: '28 Chedburgh Place', agent: 'Roc Immo', postcode: 'CB9 0AJ' });
        f.units.push({ id: 'u9', propertyId: 'p3', number: 1, type: 'Room', status: 'Occupied', rent: 350, tenantIds: [] });
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'takeback:p2').monthly).toBe(250);
        const a = p.levers.find(x => x.key === 'agent:p3');
        expect(a.monthly).toBe(547.52);
        expect(a.counted).toBe('agent');
        expect(p.totals.agentHeld).toBe(547.52);
        expect(p.totals.actionable).toBe(p.totals.paper + p.totals.works + p.totals.voids + p.totals.remote);
    });
    it('a whole-house let to one household is not priced (household size unknown)', () => {
        const f = fixture();
        f.units = [{ id: 'u1', propertyId: 'p1', number: 1, type: 'Whole Property', status: 'Occupied', rent: 1296.45, incomeType: 'Universal Credit', tenantIds: ['t1'] }];
        f.tenants = [f.tenants[0]]; f.tenancies = [{ id: 'c1', tenantIds: ['t1'], unitId: 'u1', rent: 1296.45 }];
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.filter(l => l.tenantId === 't1')).toEqual([]);
        expect(p.properties[0].tenants[0].note).toMatch(/Whole-house let/);
        expect(p.properties[0].tenants[0].rateNow).toBe(null);
    });
    it('two whole-property units in one house are shared, so each tenant gets the 1-bed rate', () => {
        const f = fixture();
        f.units = [
            { id: 'u1', propertyId: 'p1', number: 1, type: 'Whole Property', status: 'Occupied', rent: 897.52, incomeType: 'Universal Credit', tenantIds: ['t1'] },
            { id: 'u2', propertyId: 'p1', number: 2, type: 'Whole Property', status: 'Occupied', rent: 897.52, incomeType: 'Universal Credit', tenantIds: ['t2'] },
        ];
        f.tenants = f.tenants.slice(0, 2); f.tenancies = [{ id: 'c1', tenantIds: ['t1'], unitId: 'u1', rent: 897.52 }, { id: 'c2', tenantIds: ['t2'], unitId: 'u2', rent: 897.52 }];
        const p = M.buildPlan(f, S, TODAY);
        expect(p.properties[0].tenants.map(t => t.rateNow)).toEqual([897.52, 897.52]);
    });
    it('a council tax debt plan does not count as the live bill', () => {
        const f = fixture(); f.costs.push({ propertyId: 'p1', name: 'ARP Enforcement Agency - CT Debt', monthly: 100 });
        expect(M.buildPlan(f, S, TODAY).properties[0].ctLive).toBe(135);
    });
    it('property cards never list a refresh the table folded away', () => {
        const f = fixture(); f.tenants[0].dob = '1996-01-01'; f.tenancies[0].rent = 520; f.tenants[2].dob = '1997-01-01'; f.tenancies[2].rent = 521;
        const p = M.buildPlan(f, S, TODAY);
        expect(p.properties[0].levers.map(l => l.key)).not.toContain('refresh:t1');
        expect(p.levers.find(l => l.key === 'refresh:small')).toBeTruthy();
    });
    it('a known capped tenant already at the full rate is noted for a CRF claim, with no lever', () => {
        const f = fixture(); f.tenants[0].dob = '1986-01-01'; f.tenancies[0].rent = 897.52; f.tenants[0].capExemption = 'None (capped)';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(l => l.tenantId === 't1')).toBeUndefined();
        expect(p.properties[0].tenants[0].note).toMatch(/CRF Housing Payment/);
    });
    it('the CRF total adds up the shortfall behind every counted lever', () => {
        const f = fixture(); f.properties[0].strategy = 'Add tenants'; f.properties[0].plannedExtra = 1;
        const p = M.buildPlan(f, S, TODAY);
        expect(p.totals.crfShortfall).toBe(93 + 93); // Adam's uplift and one new let
        expect(p.totals.crfCount).toBe(2);
    });
    it('a joint tenancy shares its rent between the tenants', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies = [{ id: 'c1', tenantIds: ['t1', 't2'], unitId: 'u1', rent: 1600 }];
        f.units[0].tenantIds = ['t1', 't2']; f.units[1].tenantIds = [];
        const p = M.buildPlan(f, S, TODAY);
        expect(p.properties[0].tenants.map(t => t.rent)).toEqual([800, 800]);
    });
    it('prices a tenant from the tenancy on the unit being priced, not a stale second row', () => {
        const f = fixture(); f.tenancies.push({ id: 'c9', tenantIds: ['t1'], unitId: 'u9', rent: 300 });
        expect(M.buildPlan(f, S, TODAY).properties[0].tenants[0].rent).toBe(524.90);
    });
    it('bins and shared multi-property rows are not the council tax bill; frequencies convert to monthly', () => {
        const f = fixture(); f.costs.push({ propertyId: 'p1', name: 'Fylde Council Bin', monthly: 19 }, { propertyId: 'p1', name: 'CT', monthly: 50, shared: true });
        expect(M.buildPlan(f, S, TODAY).properties[0].ctLive).toBe(135);
        expect(M.monthlyFromFrequency(12, 'Weekly')).toBe(52);
        expect(M.monthlyFromFrequency(120, '4-Weekly')).toBe(130);
        expect(M.monthlyFromFrequency(300, 'Quarterly')).toBe(100);
        expect(M.monthlyFromFrequency(1200, 'Annually')).toBe(100);
        expect(M.monthlyFromFrequency(135, 'Monthly')).toBe(135);
    });
    it('remote levers split into works and voids', () => {
        const f = fixture(); f.properties[0].postcode = 'M40 1EZ'; f.properties[0].strategy = 'Add tenants'; f.properties[0].plannedExtra = 1;
        f.units.push({ id: 'u5', propertyId: 'p1', number: 5, type: 'Whole Property', status: 'Void', rent: 0, tenantIds: [] });
        const p = M.buildPlan(f, S, TODAY);
        expect(p.totals.remoteVoids).toBeGreaterThan(0);
        expect(p.totals.remoteWorks).toBeGreaterThan(0);
        expect(p.totals.remote).toBe(Math.round((p.totals.remoteWorks + p.totals.remoteVoids) * 100) / 100);
    });
    it('a void unit becomes a Void let priced from settings', () => {
        const f = fixture(); f.units.push({ id: 'u5', propertyId: 'p1', number: 5, type: 'Whole Property', status: 'Void', rent: 0, tenantIds: [] });
        const l = M.buildPlan(f, { void_rent_18_test_park: 700 }, TODAY).levers.find(x => x.key === 'void:u5');
        expect(l.monthly).toBe(700 + 135);
    });
    it('a remote house with no strategy is a candidate, not counted', () => {
        const f = fixture(); f.properties[0].postcode = 'M40 1EZ';
        const p = M.buildPlan(f, S, TODAY);
        const l = p.levers.find(x => x.key === 'rooms:p1');
        expect(l.counted).toBe('check');
        expect(p.totals.works).toBe(0);
        expect(p.totals.remote).toBe(0);
    });
    it('remote houses are priced but kept out of the local totals', () => {
        const f = fixture(); f.properties[0].postcode = 'M40 1EZ'; f.properties[0].strategy = 'Add tenants'; f.properties[0].plannedExtra = 1;
        const p = M.buildPlan(f, S, TODAY);
        const l = p.levers.find(x => x.key === 'rooms:p1');
        expect(l.counted).toBe('remote');
        expect(p.totals.works).toBe(0);
        expect(p.totals.remote).toBe(l.monthly);
    });
    it('ranks paper trail before council tax before works, and names the next action', () => {
        const p = M.buildPlan(fixture(), S, TODAY);
        const stages = p.levers.filter(l => l.counted !== 'agent').map(l => l.stage);
        expect(stages).toEqual([...stages].sort());
        expect(p.next.key).toBe('uplift:t1');
        expect(p.next.firstStep).toMatch(/UC journal/);
    });
    it('carries Growth Plan row status onto the lever and drops Done rows from the totals', () => {
        const f = fixture({ planRows: [{ id: 'recPlan1', key: 'uplift:t1', status: 'Done' }] });
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'uplift:t1').status).toBe('Done');
        expect(p.totals.paper).toBe(0); // nothing else on the house is above 0.5
        expect(p.totals.done).toBe(372.62);
    });
    it('folds refreshes under £10 into one portfolio row', () => {
        const f = fixture();
        f.tenants[0].dob = '1996-01-01'; f.tenancies[0].rent = 520; // under 35: room rate, £4.90 short
        f.tenants[2].dob = '1997-01-01'; f.tenancies[2].rent = 521;
        const p = M.buildPlan(f, S, TODAY);
        const small = p.levers.find(x => x.key === 'refresh:small');
        expect(small).toBeTruthy();
        expect(small.monthly).toBe(8.8); // 4.90 + 3.90
        expect(p.levers.filter(x => x.lever === 'Rate refresh' && x.key !== 'refresh:small')).toEqual([]);
    });
});
