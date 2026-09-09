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
    });
    it('Cambridge room and 1-bed rates come from settings when set, gov.uk figures otherwise', () => {
        expect(M.ratesFor('CB9 0AJ', S)).toMatchObject({ sar: 526.33, b1: 900 });
        expect(M.ratesFor('CB9 0AJ', { lha_1bed: 925 }).b1).toBe(925);
    });
    it('flags the LHA table as stale after 31 March 2027', () => {
        expect(M.lhaStale('2027-03-31')).toBe(false);
        expect(M.lhaStale('2027-04-01')).toBe(true);
    });
});

describe('buildPlan levers', () => {
    it('lifts a 37-year-old UC room tenant to the cap-safe rent, and shows the 1-bed rate as upside', () => {
        const p = M.buildPlan(fixture(), S, TODAY);
        const l = p.levers.find(x => x.key === 'uplift:t1');
        expect(l).toBeTruthy();
        expect(l.lever).toBe('Rent uplift');
        expect(l.monthly).toBe(279.62);          // 804.52 - 524.90
        expect(l.monthlyIfExempt).toBe(375.10);  // 900 - 524.90
        expect(l.effort).toBe('Paper');
        expect(l.needs[0]).toMatch(/exemption/);
    });
    it('gives the full 1-bed rate when the exemption is evidenced', () => {
        const f = fixture(); f.tenants[0].capExemption = 'PIP or DLA';
        const l = M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'uplift:t1');
        expect(l.monthly).toBe(375.10);
        expect(l.needs).toEqual([]);
    });
    it('never uplifts an under-35 in a room, and lists an unknown age separately', () => {
        const f = fixture(); f.tenants[2].dob = '';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'uplift:t3')).toBeUndefined();
        expect(p.unknownAge.map(u => u.tenant)).toEqual(['Travis Young']);
        expect(p.unknownAge[0].upliftIfOver35).toBe(279.62);
    });
    it('Housing Benefit in a shared room keeps the shared rate at any age', () => {
        const f = fixture(); f.units[0].incomeType = 'Housing Benefit'; f.tenants[0].payType = 'Working';
        expect(M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'uplift:t1')).toBeUndefined();
    });
    it('frees one room per over-35 UC flat-let and prices the new let net of utilities', () => {
        const p = M.buildPlan(fixture(), S, TODAY);
        const l = p.levers.find(x => x.key === 'rooms:p1');
        expect(l.lever).toBe('Room release');
        expect(l.count).toBe(1);
        expect(l.monthly).toBe(729.52);      // 804.52 - 75 utilities; council tax already with the owner
        expect(l.monthlyIfExempt).toBe(825);
        expect(l.oneOff).toBe(1500);
        expect(l.effort).toBe('Works');
    });
    it('PAYG meters remove the utilities cost from a new let', () => {
        const f = fixture(); f.properties[0].payg = 'Yes';
        expect(M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'rooms:p1').monthly).toBe(804.52);
    });
    it('adds council tax to a new let when the house is not already owner-liable', () => {
        const f = fixture(); f.costs = []; f.properties[0].ctNote = '';
        expect(M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'rooms:p1').monthly).toBe(804.52 - 75 - 145);
    });
    it('offers a joint tenancy on a two-tenant house and marks it either/or with a room let', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop();
        f.properties[0].ctPayer = 'Owner';
        const p = M.buildPlan(f, S, TODAY);
        const ct = p.levers.find(x => x.key === 'ct:p1');
        expect(ct.monthly).toBe(135);
        expect(ct.alternative).toBe(true);
        expect(ct.counted).toBe('alternative'); // the room let (729.52) beats it
        expect(p.totals.paper).toBe(282.1); // 279.62 uplift + 2.48 refresh for the exempt flat-let; the CT saving is not double counted
    });
    it('counts a joint tenancy when it is the only lever on the house', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop();
        f.properties[0].ctPayer = 'Owner'; f.tenants[1].dob = '1996-01-01'; // under 35: no room release
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'ct:p1').counted).toBe('now');
        expect(p.levers.find(x => x.key === 'rooms:p1')).toBeUndefined();
    });
    it('puts an unknown council tax payer in the check bucket, not the actionable total', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop(); f.costs = []; f.tenants[1].dob = '1996-01-01';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'ct:p1').counted).toBe('check');
        expect(p.totals.check).toBe(135);
    });
    it('prices a Collins property as a take-back and a Roc Immo house as agent-held', () => {
        const f = fixture();
        f.properties.push({ id: 'p2', name: '13 John Street', agent: 'Simon Collins', postcode: 'BB5 5PT' });
        f.properties.push({ id: 'p3', name: '28 Chedburgh Place', agent: 'Roc Immo', postcode: 'CB9 0AJ' });
        f.units.push({ id: 'u9', propertyId: 'p3', number: 1, type: 'Room', status: 'Occupied', rent: 350, tenantIds: [] });
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'takeback:p2').monthly).toBe(250);
        const a = p.levers.find(x => x.key === 'agent:p3');
        expect(a.monthly).toBe(550);
        expect(a.counted).toBe('agent');
        expect(p.totals.agentHeld).toBe(550);
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
        expect(p.properties[0].tenants.map(t => t.rateNow)).toEqual([900, 900]);
    });
    it('a council tax debt plan does not count as the live bill', () => {
        const f = fixture(); f.costs.push({ propertyId: 'p1', name: 'ARP Enforcement Agency - CT Debt', monthly: 100 });
        expect(M.buildPlan(f, S, TODAY).properties[0].ctLive).toBe(135);
    });
    it('property cards never list a refresh the table folded away', () => {
        const f = fixture(); f.tenants[0].dob = '1996-01-01'; f.tenants[2].dob = '1997-01-01';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.properties[0].levers.map(l => l.key)).not.toContain('refresh:t1');
        expect(p.levers.find(l => l.key === 'refresh:small')).toBeTruthy();
    });
    it('a void unit becomes a Void let priced from settings', () => {
        const f = fixture(); f.units.push({ id: 'u5', propertyId: 'p1', number: 5, type: 'Whole Property', status: 'Void', rent: 0, tenantIds: [] });
        const l = M.buildPlan(f, { void_rent_18_test_park: 700 }, TODAY).levers.find(x => x.key === 'void:u5');
        expect(l.monthly).toBe(700 + 135);
    });
    it('remote houses are priced but kept out of the local totals', () => {
        const f = fixture(); f.properties[0].postcode = 'M40 1EZ';
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
        expect(p.next.firstStep).toMatch(/UC statement/);
    });
    it('carries Growth Plan row status onto the lever and drops Done rows from the totals', () => {
        const f = fixture({ planRows: [{ id: 'recPlan1', key: 'uplift:t1', status: 'Done' }] });
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'uplift:t1').status).toBe('Done');
        expect(p.totals.paper).toBe(3.91); // only the two small refreshes remain
        expect(p.totals.done).toBe(279.62);
    });
    it('folds refreshes under £10 into one portfolio row', () => {
        const f = fixture();
        f.tenants[0].dob = '1996-01-01'; // under 35: room rate applies, 524.90 → 526.33
        f.tenants[2].dob = '1997-01-01';
        const p = M.buildPlan(f, S, TODAY);
        const small = p.levers.find(x => x.key === 'refresh:small');
        expect(small).toBeTruthy();
        expect(small.monthly).toBe(5.34); // 1.43 + 1.43 room refreshes + 2.48 for the exempt flat-let
        expect(p.levers.filter(x => x.lever === 'Rate refresh' && x.key !== 'refresh:small')).toEqual([]);
    });
});
