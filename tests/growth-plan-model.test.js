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
        expect(M.brmaFor('SA5 7JW')).toBe('Swansea');
        expect(M.brmaFor('ZZ1 1AA')).toBe(null);
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
    it('an unknown age is OUT of the plan (facts only) unless 35+ is confirmed', () => {
        const f = fixture(); f.tenants[2].dob = '';
        let p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'uplift:t3')).toBeUndefined();
        expect(p.unknownAge.map(u => u.tenant)).toEqual(['Travis Young']);
        expect(p.totals.paper).toBe(372.62);
        f.tenants[2].over35Confirmed = true;
        p = M.buildPlan(f, S, TODAY);
        const l = p.levers.find(x => x.key === 'uplift:t3');
        expect(l.monthly).toBe(372.62);
        expect(l.title).toMatch(/35\+ confirmed/);
        expect(l.evidence.join(' ')).toMatch(/confirmed by Kevin/);
        expect(p.unknownAge).toEqual([]);
        expect(p.totals.paper).toBe(372.62 + 372.62);
    });
    it('a tenant already at the rate but receiving less gets a CRF top-up for the gap', () => {
        const f = fixture(); f.tenancies[1].actual = 836.52; // Paul: due 897.52, received 836.52
        const p = M.buildPlan(f, S, TODAY);
        const l = p.levers.find(x => x.key === 'topup:t2');
        expect(l.lever).toBe('CRF top-up');
        expect(l.monthly).toBe(61);
        expect(l.capShortfall).toBe(61);
        expect(l.stage).toBe(1);
        expect(p.totals.paper).toBe(372.62 + 61);
    });
    it('no top-up when the received amount matches, or when nothing has been received yet', () => {
        const f = fixture(); f.tenancies[1].actual = 897.52; f.tenancies[0].actual = 0;
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.lever === 'CRF top-up')).toBeUndefined();
    });
    it('a block is priced flat by flat: two over-35s in a 2-bed, one in a 1-bed', () => {
        const f = fixture();
        f.properties.push({ id: 'p5', name: 'Duckworth Building', type: 'Block', agent: 'Intus Lettings', postcode: 'FY8 1SQ' });
        f.units.push({ id: 'f1', propertyId: 'p5', number: 1, type: 'Flat', status: 'Occupied', rent: 500, beds: 2, tenantIds: [] });
        f.units.push({ id: 'f2', propertyId: 'p5', number: 2, type: 'Flat', status: 'Occupied', rent: 600, beds: 1, tenantIds: [] });
        const l = M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'agent:p5');
        expect(l.monthly).toBe(Math.round((2 * 398.88 + 398.88 - 1100) * 100) / 100); // 96.64
        expect(l.evidence[1]).toMatch(/1 two-bed flats × 2 × £398.88 \+ 1 one-bed flats × £398.88/);
    });
    it('old strategy names still read (Add tenants = HMO, Hold = Leave as is)', () => {
        expect(M.normaliseStrategy('Add tenants')).toBe('HMO');
        expect(M.normaliseStrategy('Hold')).toBe('Leave as is');
        expect(M.normaliseStrategy('Joint tenancy')).toBe('Joint tenancy');
    });
    it('HMO strategy with no planned extra tenants produces no rooms lever', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].plannedExtra = 0;
        expect(M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'rooms:p1')).toBeUndefined();
    });
    it('a joint tenancy house with no live cost is priced from its council tax band', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop(); f.costs = [];
        f.properties[0].strategy = 'Joint tenancy'; f.properties[0].ctBand = 'B'; f.properties[0].ctAnnual = 1900.86;
        const ct = M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'ct:p1');
        expect(ct.monthly).toBe(158.41);
        expect(ct.evidence[0]).toMatch(/Band B: £1900.86 a year = £158.41 a month/);
    });
    it('tasks for a house go to its Growth Plan Owner, else paper to Kevin and works to Roy', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].plannedExtra = 1;
        let p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'uplift:t1').owner).toBe('Kevin');
        expect(p.levers.find(x => x.key === 'rooms:p1').owner).toBe('Roy');
        f.properties[0].owner = 'Kevin';
        p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'rooms:p1').owner).toBe('Kevin');
    });
    it('further potential follows each property: rooms × rate for an HMO, two for a house, one for a 1-bed; gains count', () => {
        const f = fixture();
        f.properties.push({ id: 'p3', name: '28 Chedburgh Place', agent: 'Roc Immo', postcode: 'CB9 0AJ', lettableRooms: 5 });
        f.units.push({ id: 'u9', propertyId: 'p3', number: 1, type: 'Room', status: 'Occupied', rent: 1750, tenantIds: [] });
        f.properties.push({ id: 'p4', name: '22 Newton Street', agent: 'Staycay', postcode: 'BB12 0LG', beds: 3 });
        f.units.push({ id: 'u10', propertyId: 'p4', number: 1, type: 'Whole Property', status: 'Occupied', rent: 1800, tenantIds: [] });
        f.properties.push({ id: 'p6', name: '30 Burnbank Gardens', agent: 'Mears', postcode: 'ML3 9HD', beds: 1 });
        f.units.push({ id: 'u11', propertyId: 'p6', number: 1, type: 'Whole Property', status: 'Occupied', rent: 540, tenantIds: [] });
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'agent:p3').monthly).toBe(2737.6);   // 5 × 897.52 − 1750
        expect(p.levers.find(x => x.key === 'agent:p4').monthly).toBe(-1002.24); // 2 × 398.88 − 1800
        expect(p.levers.find(x => x.key === 'agent:p6').monthly).toBe(-91.24);   // 448.76 − 540 (South Lanarkshire 1-bed)
        expect(p.totals.agentHeld).toBe(2737.6);
    });
    it('a Leave-as-is house you manage also shows its further potential, uncounted in the plan', () => {
        const f = fixture(); f.properties[0].strategy = 'Leave as is'; f.properties[0].lettableRooms = 4;
        const p = M.buildPlan(f, S, TODAY);
        const l = p.levers.find(x => x.key === 'agent:p1');
        expect(l.counted).toBe('agent');
        expect(l.monthly).toBe(Math.round((4 * 897.52 - (524.90 + 897.52 + 524.90)) * 100) / 100);
        expect(l.title).toMatch(/re-let/);
    });
    it('a property pack carries everything for one visit: prep, tenants, works, afterwards', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].plannedExtra = 1;
        const p = M.buildPlan(f, S, TODAY);
        expect(p.packs).toHaveLength(1);
        const pk = p.packs[0];
        expect(pk.name).toBe('18 Test Park');
        expect(pk.monthly).toBe(Math.round((372.62 + 897.52) * 100) / 100);
        expect(pk.crf).toBe(93 + 93);
        expect(pk.oneOff).toBe(1500);
        expect(pk.before.join(' ')).toMatch(/Rent change letter/);
        expect(pk.before.join(' ')).toMatch(/Authority to act/);
        expect(pk.tenants.map(t => t.name)).toContain('Adam Older');
        const adam = pk.tenants.find(t => t.name === 'Adam Older');
        expect(adam.sign).toContain('Rent change letter');
        expect(adam.forms.join(' ')).toMatch(/UC journal: report the housing costs change to £897.52/);
        expect(adam.forms.join(' ')).toMatch(/CRF Housing Payment, £93.00 a month to landlord/);
        expect(adam.collect).toContain('National Insurance number');
        expect(pk.works.join(' ')).toMatch(/Fire-safe/);
        expect(pk.after.join(' ')).toMatch(/Diarise the CRF renewal/);
    });
    it('a tenant giving up a room is in the pack, with the rent-does-not-change line', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].plannedExtra = 1;
        const p = M.buildPlan(f, S, TODAY);   // Paul Flat (52) holds a two-room flat-let
        const pk = p.packs[0];
        const paul = pk.tenants.find(t => t.name === 'Paul Flat');
        expect(paul).toBeTruthy();
        expect(paul.givesUpRoom).toBe(true);
        expect(paul.sign).toContain('Tenancy variation: one room instead of two, at the same rent');
        expect(paul.note).toMatch(/rent does not change/);
    });
    it('a joint tenancy pack asks for the agreement, the side letter and the CTR claim', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop();
        f.properties[0].strategy = 'Joint tenancy';
        const pk = M.buildPlan(f, S, TODAY).packs[0];
        expect(pk.before.join(' ')).toMatch(/Joint tenancy agreement for the whole house/);
        expect(pk.before.join(' ')).toMatch(/Council tax side letter/);
        pk.tenants.forEach(t => expect(t.sign).toContain('Joint tenancy agreement'));
        expect(pk.tenants.some(t => t.forms.some(x => /Council Tax Reduction claim, backdated/.test(x)))).toBe(true);
        expect(pk.after.join(' ')).toMatch(/Tell the council/);
    });
    it('packs come in strategic order and a blocked tenant is shown but not counted', () => {
        const f = fixture(); f.tenants[2].dob = '';
        f.properties.push({ id: 'p2', name: '13 Far Street', agent: 'Simon Collins', postcode: 'BB5 5PT' });
        const p = M.buildPlan(f, S, TODAY);
        expect(p.packs.map(x => x.name)).toEqual(['18 Test Park', '13 Far Street']);
        expect(p.packs[0].stage).toBe(1);
        expect(p.packs[1].stage).toBe(4);
        const blocked = p.packs[0].tenants.find(t => t.name === 'Travis Young');
        expect(blocked.blocked).toBe(true);
        expect(blocked.uplift).toBe(0);
        expect(blocked.note).toMatch(/Not in the plan until the date of birth/);
    });
    it('a pack keeps its finished levers but leaves them out of the total', () => {
        const f = fixture({ planRows: [{ id: 'recPlan1', key: 'uplift:t1', status: 'Done' }] });
        const pk = M.buildPlan(f, S, TODAY).packs[0];
        expect(pk.levers.some(l => l.status === 'Done')).toBe(true);
        expect(pk.openCount).toBe(pk.levers.length - 1);
        expect(pk.monthly).toBe(Math.round((pk.levers.filter(l => l.status !== 'Done').reduce((n, l) => n + l.monthly, 0)) * 100) / 100);
    });
    it('the to-do list carries every counted lever with its owner, in stage order', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].plannedExtra = 1;
        const p = M.buildPlan(f, S, TODAY);
        expect(p.todo.length).toBeGreaterThan(1);
        expect(p.todo[0].owner).toBe('Kevin');
        expect(p.todo.map(t => t.stage)).toEqual([...p.todo.map(t => t.stage)].sort());
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
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].plannedExtra = 2;
        const l = M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'rooms:p1');
        expect(l.count).toBe(2);
        expect(l.counted).toBe('now');
        expect(l.monthly).toBe(1795.04);
        expect(l.capShortfall).toBe(186);
    });
    it('Hold strategy produces no house lever; uplifts still show', () => {
        const f = fixture(); f.properties[0].strategy = 'Leave as is';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'rooms:p1')).toBeUndefined();
        expect(p.levers.find(x => x.key === 'ct:p1')).toBeUndefined();
        expect(p.levers.find(x => x.key === 'uplift:t1')).toBeTruthy();
    });
    it('utilities only come off a new let when Kevin has taken the bills on (PAYG = No)', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].plannedExtra = 1; f.properties[0].payg = 'No';
        expect(M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'rooms:p1').monthly).toBe(897.52 - 75);
    });
    it('adds council tax to a new let when the house is not already owner-liable', () => {
        const f = fixture(); f.costs = []; f.properties[0].ctNote = ''; f.properties[0].strategy = 'HMO'; f.properties[0].plannedExtra = 1;
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
    it('a joint tenancy house with neither a live cost nor a band is £0 and asks for the band', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop(); f.costs = [];
        f.properties[0].strategy = 'Joint tenancy';
        const ct = M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'ct:p1');
        expect(ct.monthly).toBe(0);
        expect(ct.counted).toBe('now');
        expect(ct.evidence[0]).toMatch(/set Council Tax Band and Council Tax Annual/);
    });
    it('Add tenants strategy drops the joint tenancy lever', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop();
        f.properties[0].strategy = 'HMO'; f.properties[0].plannedExtra = 1;
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'ct:p1')).toBeUndefined();
        expect(p.levers.find(x => x.key === 'rooms:p1').counted).toBe('now');
    });
    it('prices a Collins property as a £250 take-back and keeps it out of the agent-held potential', () => {
        const f = fixture();
        f.properties.push({ id: 'p2', name: '13 John Street', agent: 'Simon Collins', postcode: 'BB5 5PT' });
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'takeback:p2').monthly).toBe(250);
        expect(p.levers.find(x => x.key === 'agent:p2')).toBeUndefined();
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
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].plannedExtra = 1;
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
        const f = fixture(); f.properties[0].postcode = 'M40 1EZ'; f.properties[0].strategy = 'HMO'; f.properties[0].plannedExtra = 1;
        f.units.push({ id: 'u5', propertyId: 'p1', number: 5, type: 'Whole Property', status: 'Void', rent: 0, tenantIds: [] });
        const p = M.buildPlan(f, S, TODAY);
        expect(p.totals.remoteVoids).toBeGreaterThan(0);
        expect(p.totals.remoteWorks).toBeGreaterThan(0);
        expect(p.totals.remote).toBe(Math.round((p.totals.remoteWorks + p.totals.remoteVoids) * 100) / 100);
    });
    it('a void house compares its further potential against the planned family let, not its old rent', () => {
        const f = fixture(); f.properties[0].strategy = 'Leave as is'; f.tenants = []; f.tenancies = [];
        f.units = [{ id: 'u5', propertyId: 'p1', number: 1, type: 'Whole Property', status: 'Void', rent: 499.70, tenantIds: [] }];
        const p = M.buildPlan(f, { void_rent_18_test_park: 850 }, TODAY);
        const l = p.levers.find(x => x.key === 'agent:p1');
        expect(l.monthly).toBe(Math.round((2 * 897.52 - (850 + 135)) * 100) / 100); // void lever = rent + council tax saving
        expect(l.evidence[0]).toMatch(/lets it to a family/);
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
        const f = fixture(); f.properties[0].postcode = 'M40 1EZ'; f.properties[0].strategy = 'HMO'; f.properties[0].plannedExtra = 1;
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
        expect(p.todo[0].key).toBe('uplift:t1');
        expect(p.todo[0].text).toMatch(/UC journal/);
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
