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
            { id: 't1', name: 'Adam Older', status: 'Active', dob: '1988-11-20', payType: 'Universal Credit', capExemption: 'Unknown' },
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
        expect(M.ageOn('1988-11-20', TODAY)).toBe(37);
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
    it('a block\'s potential is priced apartment by apartment: two over-35s in a 2-bed, one in a 1-bed', () => {
        const f = fixture();
        f.properties.push({ id: 'p5', name: 'Duckworth Building', type: 'Block', agent: 'Dummy Lettings', postcode: 'FY8 1SQ' });
        f.units.push({ id: 'f1', propertyId: 'p5', number: 1, type: 'Flat', status: 'Occupied', beds: 2, tenantIds: [] });
        f.units.push({ id: 'f2', propertyId: 'p5', number: 2, type: 'Flat', status: 'Occupied', beds: 1, tenantIds: [] });
        f.tenancies.push({ id: 'cf1', tenantIds: [], unitId: 'f1', rent: 500 }, { id: 'cf2', tenantIds: [], unitId: 'f2', rent: 600 });
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'agent:p5')).toBeUndefined();   // the block is no longer one row
        expect(p.levers.find(x => x.key === 'agent:f1').monthly).toBe(Math.round((2 * 398.88 - 500) * 100) / 100); // 297.76
        expect(p.levers.find(x => x.key === 'agent:f1').evidence[1]).toMatch(/joint tenancy of two × £398.88/);
        expect(p.levers.find(x => x.key === 'agent:f2').monthly).toBe(Math.round((398.88 - 600) * 100) / 100);     // no gain on a 1-bed at £600
    });
    // Renamed 16 Sep 2026: plain "HMO" now means the professional houses Roc Immo runs.
    it('every older stored strategy name reads as the new UC name', () => {
        expect(M.normaliseStrategy('HMO')).toBe('UC HMO');
        expect(M.normaliseStrategy('Joint tenancy')).toBe('UC joint tenancy');
        expect(M.normaliseStrategy('Add tenants')).toBe('UC HMO');
        expect(M.normaliseStrategy('Hold')).toBe('Leave as is');
        expect(M.normaliseStrategy('UC HMO')).toBe('UC HMO');
    });
    it('HMO strategy with no room for another tenant produces no rooms lever', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 3;   // 3 rooms, 3 tenants
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
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4;
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
        f.properties.push({ id: 'p4', name: '22 Newton Street', agent: 'Example Stays', postcode: 'BB12 0LG', beds: 3 });
        f.units.push({ id: 'u10', propertyId: 'p4', number: 1, type: 'Whole Property', status: 'Occupied', rent: 1800, tenantIds: [] });
        f.properties.push({ id: 'p6', name: '30 Burnbank Gardens', agent: 'Example Housing', postcode: 'ML3 9HD', beds: 1 });
        f.units.push({ id: 'u11', propertyId: 'p6', number: 1, type: 'Whole Property', status: 'Occupied', rent: 540, tenantIds: [] });
        f.tenancies.push({ id: 'c9', tenantIds: [], unitId: 'u9', rent: 1750 }, { id: 'c10', tenantIds: [], unitId: 'u10', rent: 1800 }, { id: 'c11', tenantIds: [], unitId: 'u11', rent: 540 });
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
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4;
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
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4;
        const p = M.buildPlan(f, S, TODAY);   // Paul Flat (52) holds a two-room flat-let
        const pk = p.packs[0];
        const paul = pk.tenants.find(t => t.name === 'Paul Flat');
        expect(paul).toBeTruthy();
        expect(paul.givesUpRoom).toBe(true);
        expect(paul.sign).toContain('Tenancy variation: one room instead of two, at the same rent');
        expect(paul.note).toMatch(/rent does not change/);
    });
    it('a joint tenancy pack asks for both agreements and the CTR claim, and no side letter', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop();
        f.properties[0].strategy = 'Joint tenancy';
        const pk = M.buildPlan(f, S, TODAY).packs[0];
        expect(pk.before.join(' ')).toMatch(/Joint tenancy agreement for the whole house/);
        expect(pk.before.join(' ')).toMatch(/Earlier-term agreement for the first tenant alone/);
        expect(pk.before.every(x => typeof x === 'string')).toBe(true);
        expect(JSON.stringify(pk)).not.toMatch(/side letter/i);
        pk.tenants.forEach(t => expect(t.sign).toContain('Joint tenancy agreement'));
        expect(pk.tenants.some(t => t.forms.some(x => /Council Tax Reduction claim, backdated/.test(x)))).toBe(true);
        expect(pk.after.join(' ')).toMatch(/Tell the council/);
    });
    it('packs come in strategic order and a blocked tenant is shown but not counted', () => {
        const f = fixture(); f.tenants[2].dob = '';
        f.properties.push({ id: 'p2', name: '13 Far Street', agent: 'Collins Head Lease', postcode: 'BB5 5PT' });
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
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4;
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
    it('UC HMO counts lettable rooms less tenants as new lets, now', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 5;   // 5 rooms, 3 tenants
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
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4; f.properties[0].payg = 'No';
        expect(M.buildPlan(f, S, TODAY).levers.find(x => x.key === 'rooms:p1').monthly).toBe(897.52 - 75);
    });
    it('adds council tax to a new let when the house is not already owner-liable', () => {
        const f = fixture(); f.costs = []; f.properties[0].ctNote = ''; f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4;
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
        f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4;
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'ct:p1')).toBeUndefined();
        expect(p.levers.find(x => x.key === 'rooms:p1').counted).toBe('now');
    });
    it('prices a Collins property as a £250 take-back and keeps it out of the agent-held potential', () => {
        const f = fixture();
        f.properties.push({ id: 'p2', name: '13 John Street', agent: 'Collins Head Lease', postcode: 'BB5 5PT' });
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
    it('a known capped tenant already at the full rate is noted for a CRF claim, with no lever', () => {
        const f = fixture(); f.tenants[0].dob = '1986-01-01'; f.tenancies[0].rent = 897.52; f.tenants[0].capExemption = 'None (capped)';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(l => l.tenantId === 't1')).toBeUndefined();
        expect(p.properties[0].tenants[0].note).toMatch(/CRF Housing Payment/);
    });
    it('the CRF total adds up the shortfall behind every counted lever', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4;
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
        const f = fixture(); f.properties[0].postcode = 'M40 1EZ'; f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4;
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
        const f = fixture(); f.properties[0].postcode = 'M40 1EZ'; f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4;
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
    it('every refresh stays on its own tenant, however small, so its property pack shows it', () => {
        const f = fixture();
        f.tenants[0].dob = '1996-01-01'; f.tenancies[0].rent = 520;   // under 35: room rate, £4.90 short
        f.tenants[2].dob = '1997-01-01'; f.tenancies[2].rent = 521;
        f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4;
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'refresh:small')).toBeUndefined();
        expect(p.levers.filter(x => x.lever === 'Rate refresh').map(x => x.monthly).sort()).toEqual([3.9, 4.9]);
        const pk = p.packs.find(x => x.id === 'p1');
        expect(pk.tenants.map(t => t.name)).toEqual(expect.arrayContaining(['Adam Older', 'Travis Young']));
        expect(pk.monthly).toBeCloseTo(p.totals.paper + p.totals.works, 2);
    });
});

// ════════════════════════════════════════════════════════════════════════
// The four-strategy rebuild (Kevin, 16 Sep 2026)
// ════════════════════════════════════════════════════════════════════════
describe('the four strategies', () => {
    it('prices all four on every property, with council tax only on HMO and short lets', () => {
        const p = M.buildPlan(fixture(), S, TODAY);
        const v = p.properties[0];
        expect(v.strategies.map(x => x.name)).toEqual(['Single let', 'UC joint tenancy', 'UC HMO', 'Serviced accommodation']);
        const by = v.strategyBy;
        expect(by['Single let'].councilTax).toBe(0);
        expect(by['UC joint tenancy'].councilTax).toBe(0);
        expect(by['UC HMO'].councilTax).toBe(135);            // the live bank-fed cost row
        expect(by['Serviced accommodation'].councilTax).toBe(135);
    });
    it('joint tenancy is the 1-bed rate times two, and two places to let', () => {
        const p = M.buildPlan(fixture(), S, TODAY);
        const jt = p.properties[0].strategyBy['UC joint tenancy'];
        expect(jt.gross).toBe(M.weeklyToMonthly(M.LHA_WEEKLY.Cambridge.b1) * 2);
        expect(jt.units).toBe(2);
        expect(jt.net).toBe(jt.gross); // the tenants carry the council tax
    });
    it('HMO is rentable rooms times the 1-bed rate, less the council tax we then pay', () => {
        const f = fixture(); f.properties[0].lettableRooms = 5;
        const p = M.buildPlan(f, S, TODAY);
        const hmo = p.properties[0].strategyBy['UC HMO'];
        const b1 = M.weeklyToMonthly(M.LHA_WEEKLY.Cambridge.b1);
        expect(hmo.units).toBe(5);
        expect(hmo.gross).toBe(Math.round(5 * b1 * 100) / 100);
        expect(hmo.net).toBe(Math.round((5 * b1 - 135) * 100) / 100);
    });
    it('serviced accommodation is £500 net, less council tax, and one place', () => {
        const p = M.buildPlan(fixture(), S, TODAY);
        const sa = p.properties[0].strategyBy['Serviced accommodation'];
        expect(sa.gross).toBe(500);
        expect(sa.units).toBe(1);
        expect(sa.net).toBe(365);
    });
    it('a settings row moves the short-let budget without a code change', () => {
        const p = M.buildPlan(fixture(), { sa_monthly: 800 }, TODAY);
        expect(p.properties[0].strategyBy['Serviced accommodation'].gross).toBe(800);
    });
});

describe('council tax', () => {
    const noCost = () => { const f = fixture(); f.costs = []; return f; };
    it('a live bank-fed cost row beats the band', () => {
        const f = fixture(); f.properties[0].ctBand = 'B'; f.properties[0].ctAnnual = 1900.86;
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.ct.monthly).toBe(135);
        expect(v.ct.confirmed).toBe(true);
        expect(v.ct.source).toMatch(/what you pay today/);
    });
    it('the band on the record is used when nothing is paid today', () => {
        const f = noCost(); f.properties[0].ctAnnual = 1900.86; f.properties[0].ctBand = 'B';
        expect(M.buildPlan(f, S, TODAY).properties[0].ct.monthly).toBe(158.41);
    });
    it('a band with no annual figure is priced from the council band-D table', () => {
        const f = noCost(); f.properties[0].ctBand = 'A'; // CB9 = West Suffolk, band D £2,443.96
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.ct.council).toBe('West Suffolk');
        expect(v.ct.monthly).toBe(135.78); // 2443.96 × 6/9 ÷ 12
        expect(v.ct.confirmed).toBe(true);
    });
    it('every band is a fixed fraction of band D, so one known band gives them all', () => {
        const d = M.COUNCIL_BAND_D['Sefton'].d;
        Object.keys(M.BAND_NINTHS).forEach(b => {
            const f = noCost();
            f.properties[0].postcode = 'L20 7DR'; f.properties[0].ctBand = b;
            const v = M.buildPlan(f, S, TODAY).properties[0];
            expect(v.ct.monthly).toBe(Math.round(Math.round(d * M.BAND_NINTHS[b] / 9 * 100) / 100 / 12 * 100) / 100);
        });
    });
    it('an unknown band in a KNOWN council borrows the band its neighbours are on, and says so', () => {
        const f = noCost();
        f.properties[0].ctBand = '';
        f.properties.push({ id: 'p9', name: 'Neighbour', agent: 'Property Portfolio', postcode: 'CB9 0AL', ctBand: 'B' });
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.ct.borrowed).toBe(true);
        expect(v.ct.band).toBe('B');
        expect(v.ct.monthly).toBe(158.41);
        expect(v.ct.source).toMatch(/every other West Suffolk property we own/);
    });
    // The bug this guards: a missing council tax figure read as £0, which makes an HMO
    // look more profitable than it is. Unknown must be null and say so on the page.
    it('an unknown council gives NULL, never £0, and the HMO figure says it is before council tax', () => {
        const f = noCost();
        f.properties[0].postcode = 'ZZ99 9ZZ'; f.properties[0].ctBand = '';
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.ct.monthly).toBeNull();
        expect(v.ct.confirmed).toBe(false);
        expect(v.strategyBy['UC HMO'].councilTax).toBeNull();
        expect(v.strategyBy['UC HMO'].ctNote).toMatch(/BEFORE council tax/);
        expect(v.strategyBy['UC HMO'].assumed).toBe(true);
    });
});

describe('self-managed versus agent-run', () => {
    it('the Collins head lease is ours, a letting agent is not, and a tenant pay type never decides it', () => {
        const f = fixture();
        f.properties.push({ id: 'c1', name: 'Collins house', agent: 'Collins Head Lease', postcode: 'BB5 5PT' });
        f.properties.push({ id: 'a1', name: 'Agent house', agent: 'Roc Immo', postcode: 'CB9 0AH' });
        f.properties.push({ id: 'n1', name: 'No agent named', agent: '', postcode: 'CB9 0AJ' });
        const p = M.buildPlan(f, S, TODAY);
        const names = p.selfManaged.map(v => v.name);
        expect(names).toContain('Collins house');
        expect(names).toContain('No agent named');
        expect(p.agentManaged.map(v => v.name)).toEqual(['Agent house']);
        expect(p.selfManaged.length + p.agentManaged.length).toBe(p.properties.length);
    });
    it('the split reads the property, not a tenant collected by an agent', () => {
        const f = fixture();
        f.tenants[0].payType = 'Agent-Managed';   // 22 Newton Street and 23 Viola Street look like this
        expect(M.buildPlan(f, S, TODAY).selfManaged.map(v => v.id)).toContain('p1');
    });
});

describe('a block of flats', () => {
    it('a block with no flat units recorded is still priced as one block', () => {
        const f = fixture();
        f.properties = [{ id: 'b1', name: 'Duckworth Building', type: 'Block', beds: 3, agent: 'Dummy Lettings', postcode: 'FY8 1SQ' }];
        f.units = []; f.tenants = []; f.tenancies = []; f.costs = [];
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.current).toBe('Block of flats');
        expect(v.strategyBy['Single let'].gross).toBe(646 * 3); // the researched FY8 flat rent, per flat
        ['UC joint tenancy', 'UC HMO', 'Serviced accommodation'].forEach(k => expect(v.strategyBy[k].na).toBe(true));
    });
});

// Kevin, 16 Sep 2026: "Duckworth Building is 9 separate apartments ... Apartments 1 and 2 are
// service accommodation, and apartments 3 to 9 are all single lets." Split in the growth plan only.
function duckworth() {
    const flats = [[1, 2, 500, 'Serviced accommodation'], [2, 2, 500, 'Serviced accommodation'], [3, 2, 651, 'Single let'], [5, 1, 687, 'Single let']];
    return {
        properties: [{ id: 'blk', name: 'Duckworth Building', type: 'Block', beds: 9, agent: 'Dummy Lettings', postcode: 'FY8 1SQ', ctPayer: 'Unknown', baselineRent: 2338, baselineCt: 0 }],
        units: flats.map(([n, beds, , how]) => ({ id: 'apt' + n, propertyId: 'blk', number: n, type: 'Flat', status: 'Occupied', beds, rent: 9999, tenantIds: ['ta' + n],
            lettingStrategy: how, ctBand: n === 5 ? '' : 'A', baselineRent: n === 5 ? null : 1, baselineCt: n === 5 ? null : 2, baselineDate: n === 5 ? '' : '2026-09-16' })),
        tenants: flats.map(([n]) => ({ id: 'ta' + n, name: n <= 2 ? 'Example Stays Ltd' : 'Tenant ' + n, status: 'Active', payType: 'Working' })),
        tenancies: flats.map(([n, , rent]) => ({ id: 'tc' + n, tenantIds: ['ta' + n], unitId: 'apt' + n, rent })),
        costs: [], planRows: [],
    };
}
describe('Duckworth Building: one row per apartment (16 Sep 2026)', () => {
    it('the block becomes one row per flat, named by apartment, with its own rent', () => {
        const p = M.buildPlan(duckworth(), S, TODAY);
        expect(p.properties.map(v => v.name)).toEqual(['Duckworth Building, Apartment 1', 'Duckworth Building, Apartment 2', 'Duckworth Building, Apartment 3', 'Duckworth Building, Apartment 5']);
        expect(p.properties.find(v => v.id === 'blk')).toBeUndefined();
        expect(p.properties.map(v => v.rentNow)).toEqual([500, 500, 651, 687]);
        expect(p.totals.grid.now.rent).toBe(2338);
        const a1 = p.properties[0];
        expect(a1.unitRecord).toBe(true);
        expect(a1.parentId).toBe('blk');
        expect(a1.selfManaged).toBe(false);   // Dummy Lettings runs the block, so every flat is agent-run
    });
    it('apartments 1 and 2 read serviced accommodation, 3 onwards single let', () => {
        const p = M.buildPlan(duckworth(), S, TODAY);
        expect(p.properties.map(v => v.current)).toEqual(['Serviced accommodation', 'Serviced accommodation', 'Single let', 'Single let']);
    });
    it('serviced accommodation council tax is ours even though an agent runs it; a single let is not', () => {
        const p = M.buildPlan(duckworth(), S, TODAY);
        const bandA = Math.round(2509.35 * 6 / 9 / 12 * 100) / 100;   // St Annes band A £1,672.90 a year
        expect(bandA).toBe(139.41);
        expect(p.properties[0].ctNow).toBe(139.41);
        expect(p.properties[0].ctNowWhy).toMatch(/Serviced accommodation/);
        expect(p.properties[2].ctNow).toBe(0);
        expect(p.totals.grid.now.ct).toBe(278.82);
    });
    it('each flat is priced by its bedrooms: a 2-bed single let at £750, a 1-bed at £646, no room lets', () => {
        const p = M.buildPlan(duckworth(), S, TODAY);
        const a3 = p.properties[2], a5 = p.properties[3];
        expect(a3.strategyBy['Single let'].gross).toBe(750);
        expect(a5.strategyBy['Single let'].gross).toBe(646);
        expect(a3.strategyBy['UC HMO'].na).toBe(true);
        expect(a3.strategyBy['UC joint tenancy'].na).toBeFalsy();   // a 2-bed flat takes two tenants
        expect(a5.strategyBy['UC joint tenancy'].na).toBe(true);    // a 1-bed flat does not
        expect(a5.bestRent).toBe(687);                              // already above the 1-bed market rent
    });
    it('each flat keeps its own frozen start and band, read from its rental unit', () => {
        const p = M.buildPlan(duckworth(), S, TODAY);
        expect(p.properties[0].baselineRent).toBe(1);
        expect(p.properties[0].baselineCt).toBe(2);
        expect(p.properties[3].baselineRent).toBeNull();
        // A flat with no band borrows the band the other flats in the council carry, and says so.
        expect(p.properties[3].ct.borrowed).toBe(true);
        expect(p.properties[3].ct.band).toBe('A');
        const miss = p.totals.toFreeze.find(x => x.id === 'apt5');
        expect(miss.unitRecord).toBe(true);
        expect(miss.rent).toBe(687);
    });
    it('an open move keyed to the block before the split sits on the first apartment, so it can be dropped', () => {
        const f = duckworth(); f.planRows = [{ id: 'r1', key: 'rooms:blk', status: 'Adopted', title: 'Old block move', taskIds: [] }];
        const p = M.buildPlan(f, S, TODAY);
        expect(p.properties.find(v => v.id === 'apt1').strandedRows.map(r => r.id)).toEqual(['r1']);
    });
    it('an apartment names its own rental unit as where its rooms and letting come from', () => {
        const v = M.buildPlan(duckworth(), S, TODAY).properties[2];
        expect(v.roomInfo.source).toBe("2 bedrooms on this apartment's rental unit");
        expect(v.soleUnitId).toBe('apt3');
        expect(v.lettingStated).toBe('Single let');
    });
    it('a block that also holds a unit that is not a flat keeps a row for that unit', () => {
        const f = duckworth();
        f.units.push({ id: 'shop', propertyId: 'blk', number: 10, type: 'Whole Property', status: 'Occupied', tenantIds: [] });
        f.tenancies.push({ id: 'tcs', tenantIds: [], unitId: 'shop', rent: 300 });
        const p = M.buildPlan(f, S, TODAY);
        expect(p.properties.find(v => v.id === 'blk').rentNow).toBe(300);
        expect(p.totals.grid.now.rent).toBe(2638);
    });
});

describe('rent now reads live tenancies, never the unit rollup (16 Sep 2026)', () => {
    // 22 Newton Street: the unit's Expected Rent said £1,800, the live Example Stays tenancy £500 and
    // a tenancy that had ended £1,300. Only the live one is rent coming in.
    const newton = () => ({
        properties: [{ id: 'nw', name: '22 Newton Street', type: 'Single Let', beds: 3, agent: 'Property Portfolio', postcode: 'BB12 0LG', ctBand: 'B', ctPayer: 'Unknown', strategy: 'Serviced accommodation' }],
        units: [{ id: 'nu', propertyId: 'nw', number: 1, type: 'Whole Property', status: 'Occupied', rent: 1800, tenantIds: ['sc'], lettingStrategy: 'Serviced accommodation' }],
        tenants: [{ id: 'sc', name: 'Example Stays Ltd', status: 'Active', payType: 'Working' }],
        tenancies: [{ id: 'live', tenantIds: ['sc'], unitId: 'nu', rent: 500, status: 'Live' }, { id: 'old', tenantIds: ['sc'], unitId: 'nu', rent: 1300, status: 'Ended' }],
        costs: [], planRows: [],
    });
    it('22 Newton Street reads £500 rent now, not the £1,800 rollup', () => {
        const v = M.buildPlan(newton(), S, TODAY).properties[0];
        expect(v.rentNow).toBe(500);
        expect(v.recordRent).toBe(500);
    });
    it('a unit with no live tenancy brings in nothing, whatever its rollup says', () => {
        const f = newton(); f.tenancies = [];
        expect(M.buildPlan(f, S, TODAY).properties[0].rentNow).toBe(0);
    });
    it('reads as serviced accommodation, with the Burnley band B council tax ours', () => {
        const v = M.buildPlan(newton(), S, TODAY).properties[0];
        expect(v.current).toBe('Serviced accommodation');
        expect(v.ctNow).toBe(165.24);   // 2,549.42 × 7/9 ÷ 12
        expect(v.planRent).toBe(500);
        expect(v.planCt).toBe(165.24);
        expect(v.planWhy).toMatch(/Stays serviced accommodation/);
        expect(v.progress).toBe('No change needed');
    });
    it('without a letting strategy recorded it would still read as a single let', () => {
        const f = newton(); delete f.units[0].lettingStrategy;
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.current).toBe('Single let');
        expect(v.ctNow).toBe(0);
    });
    it('units that disagree on their letting strategy fall back to the unit types', () => {
        const f = fixture(); f.units[0].lettingStrategy = 'Serviced accommodation'; f.units[1].lettingStrategy = 'Single let';
        expect(M.buildPlan(f, S, TODAY).properties[0].current).toBe('UC HMO');
    });
});

describe('progress is forecast, and a tick moves money from could to now', () => {
    const withPlan = (strategy, rows) => { const f = fixture(); f.properties[0].strategy = strategy; f.planRows = rows || []; return f; };
    it('a property with no plan picked reads Not decided, whatever its moves say', () => {
        const f = fixture();
        f.planRows = [{ id: 'r1', key: 'uplift:t1', status: 'Adopted', taskIds: [] }];
        expect(M.buildPlan(f, S, TODAY).properties[0].progress).toBe('Not decided');
    });
    it('an uplift still to do with a move adopted reads In progress', () => {
        const p = M.buildPlan(withPlan('HMO', [{ id: 'r1', key: 'uplift:t1', status: 'Adopted', taskIds: [] }]), S, TODAY);
        expect(p.properties[0].progress).toBe('In progress');
    });
    it('every uplift ticked done on a settled strategy reads Realised, with no bank figure involved', () => {
        const f = withPlan('HMO'); f.properties[0].lettableRooms = 3;   // no room left to fill
        f.tenants[0].rentUplift = 'Done';
        f.tenants.slice(1).forEach(t => { t.rentUplift = 'Not needed'; });
        expect(M.buildPlan(f, S, TODAY).properties[0].progress).toBe('Realised');
    });
    it('nothing to chase and nothing done reads No change needed, not Realised', () => {
        const f = withPlan('HMO'); f.properties[0].lettableRooms = 3;   // no room left to fill
        f.tenants.forEach(t => { t.rentUplift = 'Not needed'; });
        expect(M.buildPlan(f, S, TODAY).properties[0].progress).toBe('No change needed');
    });
});

describe('rooms, market rent and the checklist', () => {
    it('lettable rooms beats the rooms in use, and both beat the bedroom count', () => {
        const f = fixture(); f.properties[0].lettableRooms = 6;
        expect(M.buildPlan(f, S, TODAY).properties[0].roomInfo).toMatchObject({ rooms: 6, confirmed: true });
        const g = fixture(); // two rooms plus a flat-let (which is two rooms) = 4
        expect(M.buildPlan(g, S, TODAY).properties[0].roomInfo.rooms).toBe(4);
    });
    it('a researched market rent is used and a guessed one is flagged', () => {
        const f = fixture(); f.properties[0].name = '23 Viola Street';
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.market.rent).toBe(850);
        expect(v.market.researched).toBe(true);
        const g = M.buildPlan(fixture(), S, TODAY).properties[0];
        expect(g.market.researched).toBe(false);
        expect(g.market.source).toMatch(/Estimate only/);
        expect(g.strategyBy['Single let'].assumed).toBe(true);
    });
    it('a settings row overrides a researched market rent', () => {
        const f = fixture(); f.properties[0].name = '23 Viola Street';
        expect(M.buildPlan(f, { market_rent_23_viola_street: 925 }, TODAY).properties[0].market.rent).toBe(925);
    });
    it('each strategy carries the paperwork it needs, and single lets need none', () => {
        expect(M.CHECKLIST['UC joint tenancy'].property[0]).toMatch(/Joint tenancy agreement/);
        expect(M.CHECKLIST['UC joint tenancy'].tenant).toEqual(['Letter of authority, so we can set up their council tax reduction', 'Proof of address']);
        expect(M.CHECKLIST['UC HMO'].tenant[0]).toMatch(/Individual tenancy agreement/);
        expect(M.CHECKLIST['UC HMO'].tenant).toHaveLength(3);
        expect(M.CHECKLIST['Single let'].property).toEqual([]);
        expect(M.CHECKLIST['Single let'].tenant).toEqual([]);
        expect(M.CHECKLIST['Serviced accommodation'].note).toMatch(/Nothing for us to sign/);
    });
    it('"Leave as is" holds the property on whatever it is today', () => {
        const f = fixture(); f.properties[0].strategy = 'Leave as is';
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.current).toBe('UC HMO');
        expect(v.chosen).toBe('UC HMO');
        expect(v.progress).toBe('No change needed');
    });
});

// Every self-managed property carries a researched open-market rent (16 Sep 2026).
// The guard is the COUNT, not a list of names: adding a property without researching
// its rent should turn this red rather than slipping through as an "estimate" pill.
describe('market rents are researched, not estimated', () => {
    it('covers every property we run ourselves', () => {
        const names = Object.keys(M.MARKET_RENT);
        ['13 Chedburgh Place', '5 Dalham Place', '55 Elmdon Place', '14 Wentworth Terrace',
         '6 Chedburgh Place', '4 Abington Place', '34 Connaught Road', '18 Northfield Park',
         '1406 Oldham Road', '282 Stanley Park Avenue South', '18 Siddows Avenue',
         '22 Newton Street', '23 Viola Street', '11 Aigburth Avenue', '13 John Street',
         '15 Marloes Court', '16 Eleventh Street', '82 Devon Street'].forEach(n => {
            expect(names, `${n} has no researched market rent`).toContain(n);
        });
    });
    it('every entry carries a figure and where it came from', () => {
        Object.entries(M.MARKET_RENT).forEach(([name, r]) => {
            expect(r.rent, name).toBeGreaterThan(0);
            expect(String(r.source).trim().length, name).toBeGreaterThan(20);   // a real sentence, not a placeholder
        });
    });
});

// ════════════════════════════════════════════════════════════════════════
// Kevin's second pass, 16 Sep 2026: council tax follows the letting and the
// paperwork, a tick moves money into "now", and the grid reads left to right.
// ════════════════════════════════════════════════════════════════════════
const singleLet = (over = {}) => ({
    properties: [Object.assign({ id: 'sl', name: 'Single House', type: 'Single Let', beds: 3, agent: 'Property Portfolio', postcode: 'CB9 0AJ', ctBand: 'B', ctAnnual: 1900.86 }, over)],
    units: [{ id: 'su', propertyId: 'sl', number: 1, type: 'Whole Property', status: 'Occupied', rent: 1000, incomeType: 'Working', tenantIds: ['st'] }],
    tenants: [{ id: 'st', name: 'One Household', status: 'Active', payType: 'Working' }],
    tenancies: [{ id: 'sc', tenantIds: ['st'], unitId: 'su', rent: 1000 }], costs: [], planRows: [],
});
// Two tenants in two flat-lets: the shape of the houses Kevin is moving to a joint tenancy.
const twoFlatLets = () => ({
    properties: [{ id: 'jt', name: 'Pair House', type: 'Single Let', beds: 2, agent: 'Property Portfolio', postcode: 'CB9 0AJ', ctBand: 'B', ctAnnual: 1900.86, strategy: 'Joint tenancy' }],
    units: [1, 2].map(n => ({ id: 'ju' + n, propertyId: 'jt', number: n, type: 'Flat-Let', status: 'Occupied', rent: 897.52, incomeType: 'Universal Credit', tenantIds: ['jt' + n] })),
    tenants: [1, 2].map(n => ({ id: 'jt' + n, name: 'Joint ' + n, status: 'Active', dob: '1970-01-01', payType: 'Universal Credit', capExemption: 'LCWRA', rentUplift: 'Not needed' })),
    tenancies: [1, 2].map(n => ({ id: 'jc' + n, tenantIds: ['jt' + n], unitId: 'ju' + n, rent: 897.52 })), costs: [], planRows: [],
});

describe('council tax now follows the letting and the paperwork', () => {
    it('a house let by the room is ours', () => {
        const v = M.buildPlan(fixture(), S, TODAY).properties[0];
        expect(v.current).toBe('UC HMO');
        expect(v.ctLiableNow).toBe(true);
        expect(v.ctNow).toBe(135);
    });
    it('a single let is the tenant\'s', () => {
        const v = M.buildPlan(singleLet(), S, TODAY).properties[0];
        expect(v.ctLiableNow).toBe(false);
        expect(v.ctNow).toBe(0);
    });
    it('a single let where we took the bills on is ours', () => {
        const v = M.buildPlan(singleLet({ ctPayer: 'Owner' }), S, TODAY).properties[0];
        expect(v.ctNow).toBe(158.41);
    });
    // The rule Kevin set: picking a joint tenancy is not enough, the paperwork has to be in.
    it('a joint tenancy is ours until EVERY tenant has the correct agreement ticked', () => {
        const f = twoFlatLets();
        expect(M.buildPlan(f, S, TODAY).properties[0].ctNow).toBe(158.41);
        f.tenants[0].correctAgreement = true;
        const half = M.buildPlan(f, S, TODAY).properties[0];
        expect(half.ctNow).toBe(158.41);
        expect(half.ctNowWhy).toMatch(/1 of 2/);
        f.tenants[1].correctAgreement = true;
        const done = M.buildPlan(f, S, TODAY).properties[0];
        expect(done.jtDocumented).toBe(true);
        expect(done.ctNow).toBe(0);
    });
    it('the ticks do nothing to council tax unless the plan is a joint tenancy', () => {
        const f = twoFlatLets(); f.properties[0].strategy = 'HMO';
        f.tenants.forEach(t => { t.correctAgreement = true; });
        expect(M.buildPlan(f, S, TODAY).properties[0].ctNow).toBe(158.41);
    });
    it('on an agent-run property it is only what the bank shows we pay', () => {
        const f = singleLet({ agent: 'Example Housing', ctBand: 'B' });
        expect(M.buildPlan(f, S, TODAY).properties[0].ctNow).toBe(0);
        f.costs = [{ propertyId: 'sl', name: 'Stirling Park - CT', monthly: 195 }];
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.ctNow).toBe(195);
        expect(v.ctNowWhy).toMatch(/bank-fed/);
    });
});

describe('the rent uplift tick', () => {
    const tenant = (f, id) => f.tenants.find(t => t.id === id);
    it('Done moves the uplift into rent now', () => {
        const f = fixture(); tenant(f, 't1').rentUplift = 'Done';
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.recordRent).toBe(1947.32);
        expect(v.upliftsDone).toBe(372.62);
        expect(v.rentNow).toBe(2319.94);
    });
    // Presetting everyone except the four as "Not needed" must never add a penny.
    it('Not needed adds nothing to now OR the plan, and raises no uplift move', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 3;   // no room for another tenant
        tenant(f, 't1').rentUplift = 'Not needed';
        const p = M.buildPlan(f, S, TODAY);
        const v = p.properties[0];
        expect(v.rentNow).toBe(1947.32);
        expect(v.upliftsDone).toBe(0);
        expect(v.upliftsToDo).toBe(0);
        expect(v.planRent).toBe(1947.32);   // the preset must never inflate "if the plan is done"
        expect(p.levers.find(l => l.key === 'uplift:t1')).toBeUndefined();
    });
    it('is not counted twice once the tenancy record is updated to the new rent', () => {
        const f = fixture(); tenant(f, 't1').rentUplift = 'Done';
        f.units[0].rent = 897.52; f.tenancies[0].rent = 897.52;   // Roy updates the record
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.recordRent).toBe(2319.94);
        expect(v.upliftsDone).toBe(0);
        expect(v.rentNow).toBe(2319.94);
    });
    it('To do sits in the plan column, not in now', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO';
        f.properties[0].lettableRooms = 3;   // no room for another tenant, so only the uplift moves the plan
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.rentNow).toBe(1947.32);
        expect(v.upliftsToDo).toBe(372.62);
        expect(v.planRent).toBe(2319.94);
    });
    it('Done shows its move as Done without a second click', () => {
        const f = fixture(); tenant(f, 't1').rentUplift = 'Done';
        expect(M.buildPlan(f, S, TODAY).levers.find(l => l.key === 'uplift:t1').status).toBe('Done');
    });
});

describe('"Leave as is" holds the income flat', () => {
    // The 55 Elmdon Place shape: two tenants at the 1-bed rate, band B. Before this fix
    // it reported +£1,636.63 while the status read "No change needed".
    it('gives an uplift of exactly nothing', () => {
        const f = {
            properties: [{ id: 'e', name: '55 Elmdon Place', type: 'HMO', beds: 3, agent: 'Property Portfolio', postcode: 'CB9 0AH', ctBand: 'B', ctAnnual: 1900.86, lettableRooms: 4, strategy: 'Leave as is' }],
            units: [1, 2].map(n => ({ id: 'u' + n, propertyId: 'e', number: n, type: 'Whole Property', status: 'Occupied', rent: 897.52, incomeType: 'Universal Credit', tenantIds: ['t' + n] })),
            tenants: [1, 2].map(n => ({ id: 't' + n, name: 'T' + n, status: 'Active', dob: '1980-01-01', payType: 'Universal Credit', capExemption: 'LCWRA' })),
            tenancies: [1, 2].map(n => ({ id: 'c' + n, tenantIds: ['t' + n], unitId: 'u' + n, rent: 897.52 })), costs: [], planRows: [],
        };
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.upliftChosen).toBe(0);
        expect(v.planRent).toBe(v.rentNow);
        expect(v.planCt).toBe(v.ctNow);
    });
});

describe('the grid', () => {
    it('every column reads left for us = rent less council tax', () => {
        const g = M.buildPlan(fixture(), S, TODAY).totals.grid;
        ['started', 'now', 'plan', 'best'].forEach(k => {
            expect(g[k].left).toBe(Math.round((g[k].rent - g[k].ct) * 100) / 100);
        });
    });
    // Reading the forecast would make an uplift already done vanish: started would equal now.
    it('unfrozen, started is the rent on the record, so a done uplift still shows as progress', () => {
        const f = fixture(); f.tenants[0].rentUplift = 'Done';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.totals.startedFrozen).toBe(false);
        expect(p.totals.grid.started.rent).toBe(1947.32);
        expect(p.totals.grid.now.rent).toBe(2319.94);
    });
    it('frozen, started never moves again', () => {
        const f = fixture();
        f.properties[0].baselineRent = 1500; f.properties[0].baselineCt = 99;
        const p = M.buildPlan(f, S, TODAY);
        expect(p.totals.startedFrozen).toBe(true);
        expect(p.totals.grid.started).toMatchObject({ rent: 1500, ct: 99, left: 1401 });
    });
    it('a joint tenancy of the same two tenants keeps their rents and drops the council tax in the plan', () => {
        const v = M.buildPlan(twoFlatLets(), S, TODAY).properties[0];
        expect(v.planRent).toBe(v.rentNow);
        expect(v.planCt).toBe(0);
        expect(v.planWhy).toMatch(/rents stay/);
    });
    it('the ceiling is never below where a property already is', () => {
        const f = singleLet(); f.units[0].rent = 5000; f.tenancies[0].rent = 5000;
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.leftBest).toBeGreaterThanOrEqual(v.leftNow);
        expect(v.bestWhy).toBe('Where it is now');
    });
});

describe('agent-run properties', () => {
    it('an agent\'s room let is a professional HMO, ours is a UC HMO', () => {
        const f = fixture(); f.properties[0].agent = 'Roc Immo';
        expect(M.buildPlan(f, S, TODAY).properties[0].current).toBe('HMO');
        expect(M.buildPlan(fixture(), S, TODAY).properties[0].current).toBe('UC HMO');
    });
    it('get no plan and no checklist while an agent runs them', () => {
        const f = fixture(); f.properties[0].agent = 'Roc Immo'; f.properties[0].strategy = 'HMO';
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.selfManaged).toBe(false);
        expect(v.chosen).toBe('');
        expect(v.paperwork).toBeNull();
    });
    it('Moving to self-manage brings one into our list with everything ours get', () => {
        const f = fixture(); f.properties[0].agent = 'Roc Immo'; f.properties[0].movingToSelfManage = true; f.properties[0].strategy = 'HMO';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.selfManaged.map(v => v.id)).toContain('p1');
        expect(p.agentManaged).toHaveLength(0);
        expect(p.properties[0].current).toBe('UC HMO');
        expect(p.properties[0].chosen).toBe('UC HMO');
        expect(p.properties[0].paperwork).not.toBeNull();
    });
});

describe('the plan picker', () => {
    it('offers all four strategies and Leave as is', () => {
        expect(M.PLAN_CHOICES).toEqual(['Single let', 'UC joint tenancy', 'UC HMO', 'Serviced accommodation', 'Leave as is']);
    });
    it('every tenant carries the four ticks Kevin asked for', () => {
        expect(M.TENANT_DOCS.map(d => d.label)).toEqual(['Correct tenancy agreement', 'Proof of address', 'Letter of authority', 'Rent uplift']);
    });
});

describe('places and status read true', () => {
    // Kevin, 16 Sep 2026: extra tenants is the lettable rooms less the tenants living there,
    // worked out, never typed. A flat-let tenant's second room is a lettable room.
    it('extra tenants is lettable rooms less tenants, and planned places follow it', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4;
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.tenantCount).toBe(3);
        expect(v.extraTenants).toBe(1);
        expect(v.unitsExtra).toBe(1);
        expect(v.planWhy).toMatch(/4 lettable rooms less 3 tenants = 1 more tenant/);
    });
    it('correcting the lettable rooms corrects the extra tenants, and a typed number is ignored', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO';
        f.properties[0].plannedExtra = 2;   // the old typed field, which disagreed with the rooms
        f.properties[0].lettableRooms = 4;
        expect(M.buildPlan(f, S, TODAY).properties[0].extraTenants).toBe(1);
        f.properties[0].lettableRooms = 3;
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.extraTenants).toBe(0);
        expect(v.planRent).toBe(Math.round((v.rentNow + v.upliftsToDo) * 100) / 100);   // the uplift still to do, and no new tenant
    });
    it('never goes below nothing when there are more tenants than rooms recorded', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 2;
        expect(M.buildPlan(f, S, TODAY).properties[0].extraTenants).toBe(0);
    });
    it('an empty room is not rent now, and is priced once in the plan', () => {
        const f = fixture(); f.properties[0].strategy = 'HMO'; f.properties[0].lettableRooms = 4;
        f.units.push({ id: 'u4', propertyId: 'p1', number: 4, type: 'Room', status: 'Void', rent: 400, tenantIds: [] });
        f.tenancies.push({ id: 'c4', tenantIds: [], unitId: 'u4', rent: 400 });   // a tenancy still Live on a unit already marked Void
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.voidRent).toBe(400);
        expect(v.rentNow).toBe(1947.32);                              // the empty room's £400 placeholder is not rent coming in
        expect(v.recordRent).toBe(1947.32);
        expect(v.extraTenants).toBe(1);
        expect(v.planRent).toBe(Math.round((1947.32 + 372.62 + 897.52) * 100) / 100);   // the empty room at the 1-bed rate, once
    });
    it('an agent-run property reads Agent-run, never Not decided', () => {
        const f = fixture(); f.properties[0].agent = 'Roc Immo';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.properties[0].progress).toBe('Agent-run');
        expect(p.totals.notDecided).toBe(0);
    });
});

// ════════════════════════════════════════════════════════════════════════
// Review fixes, 16 Sep 2026
// ════════════════════════════════════════════════════════════════════════
describe('review fix 1: a property that is ours gets the self-managed moves', () => {
    it('a Roc Immo house ticked Moving to self-manage generates its rent uplift', () => {
        const f = fixture(); f.properties[0].agent = 'Roc Immo';
        expect(M.buildPlan(f, S, TODAY).levers.find(l => l.key === 'uplift:t1')).toBeUndefined();
        f.properties[0].movingToSelfManage = true;
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(l => l.key === 'uplift:t1').monthly).toBe(372.62);
        expect(p.properties[0].upliftsToDo).toBe(372.62);
        expect(p.levers.find(l => l.lever === 'Agent-held')).toBeUndefined();   // no longer priced as agent potential
    });
    it('a house of ours with one agent-collected tenant still gets its moves', () => {
        const f = fixture(); f.tenants[1].payType = 'Agent-Managed';   // the 22 Newton / 23 Viola shape
        const p = M.buildPlan(f, S, TODAY);
        expect(p.properties[0].ours).toBe(true);
        expect(p.levers.find(l => l.key === 'uplift:t1')).toBeTruthy();
    });
    it('a Collins house keeps its take-back', () => {
        const f = fixture(); f.properties[0].agent = 'Collins Head Lease';
        expect(M.buildPlan(f, S, TODAY).levers.find(l => l.lever === 'Take-back')).toBeTruthy();
    });
});

describe('review fix 2: unknown council tax is flagged, never passed off as nothing', () => {
    const noCouncil = () => { const f = fixture(); f.costs = []; f.properties[0].postcode = 'CO12 3DB'; f.properties[0].ctBand = ''; f.properties[0].strategy = 'HMO'; return f; };
    it('now, plan and best all carry the flag, and the grid names the property', () => {
        const p = M.buildPlan(noCouncil(), S, TODAY);
        const v = p.properties[0];
        expect(v.ct.monthly).toBeNull();
        expect(v.ctNowUnknown).toBe(true);
        expect(v.planCtUnknown).toBe(true);
        expect(p.totals.grid.now.ctUnknown).toEqual(['18 Test Park']);
        expect(p.totals.grid.plan.ctUnknown).toEqual(['18 Test Park']);
    });
    it('a known council tax raises no flag', () => {
        const p = M.buildPlan(fixture(), S, TODAY);
        ['started', 'now', 'plan', 'best'].forEach(k => expect(p.totals.grid[k].ctUnknown).toEqual([]));
    });
    it('a single let owes no council tax, so an unknown rate is no gap there', () => {
        const f = singleLet({ postcode: 'CO12 3DB', ctBand: '', ctAnnual: 0 });
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.ctNowUnknown).toBe(false);
    });
});

describe('review fix 3: Leave as is on a joint tenancy already in place', () => {
    const stated = () => { const f = twoFlatLets(); f.properties[0].strategy = 'Leave as is'; f.properties[0].ctPayer = 'Tenants'; return f; };
    it('with every agreement ticked, the council tax is theirs', () => {
        const f = stated(); f.tenants.forEach(t => { t.correctAgreement = true; });
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.current).toBe('UC joint tenancy');
        expect(v.chosen).toBe('UC joint tenancy');
        expect(v.ctNow).toBe(0);
        expect(v.progress).toBe('No change needed');
    });
    it('with the paperwork missing, Kevin\'s rule still charges us', () => {
        const v = M.buildPlan(stated(), S, TODAY).properties[0];
        expect(v.ctNow).toBe(158.41);
        expect(v.ctNowWhy).toMatch(/0 of 2/);
    });
    it('Tenants as payer on a house of three is not read as a joint tenancy', () => {
        const f = fixture(); f.properties[0].ctPayer = 'Tenants';
        expect(M.buildPlan(f, S, TODAY).properties[0].current).toBe('UC HMO');
    });
});

describe('review fix 4: a move with nothing behind it can be closed', () => {
    it('an Adopted row for a tenant set to Not needed is pinned to its property', () => {
        const f = fixture();
        f.tenants[0].rentUplift = 'Not needed';
        f.planRows = [{ id: 'r1', key: 'uplift:t1', title: 'Adam Older: room rate to 1-bed rate', status: 'Adopted', taskIds: ['recTask'] },
                      { id: 'r2', key: 'rooms:p1', title: 'old room let', status: 'Dropped', taskIds: [] }];
        const p = M.buildPlan(f, S, TODAY);
        expect(p.properties[0].strandedRows).toEqual([{ id: 'r1', key: 'uplift:t1', status: 'Adopted', title: 'Adam Older: room rate to 1-bed rate', taskIds: ['recTask'], propertyId: 'p1' }]);
        expect(p.totals.strandedRows).toHaveLength(1);   // the Dropped row is history, not a problem
    });
    it('a row whose lever still exists is not stranded', () => {
        const f = fixture(); f.planRows = [{ id: 'r1', key: 'uplift:t1', status: 'Adopted', taskIds: [] }];
        expect(M.buildPlan(f, S, TODAY).totals.strandedRows).toEqual([]);
    });
});

describe('review fix 5: where we started', () => {
    it('unfrozen, its council tax is what we paid before any paperwork tick', () => {
        const f = twoFlatLets(); f.tenants.forEach(t => { t.correctAgreement = true; });
        const p = M.buildPlan(f, S, TODAY);
        expect(p.totals.grid.now.ct).toBe(0);
        expect(p.totals.grid.started.ct).toBe(158.41);   // the saving shows as progress
    });
    it('the freeze list holds only what is missing, and never what is saved', () => {
        const f = fixture();
        f.properties.push(Object.assign({}, singleLet().properties[0], { id: 'sl2', baselineRent: 900, baselineCt: 0, baselineDate: '2026-09-10' }));
        f.properties.push(Object.assign({}, singleLet().properties[0], { id: 'sl3', baselineRent: 800, baselineDate: '2026-09-10' }));
        const p = M.buildPlan(f, S, TODAY);
        const byId = Object.fromEntries(p.totals.toFreeze.map(x => [x.id, x]));
        expect(byId.p1).toMatchObject({ rent: 1947.32, ct: 135, date: TODAY });
        expect(byId.sl2).toBeUndefined();
        expect(byId.sl3).toMatchObject({ rent: null, ct: 0, date: null });
    });
});

describe('a single let is planned at the open-market rent (Kevin, 16 Sep 2026)', () => {
    const marloes = (over = {}) => {
        const f = singleLet(Object.assign({ name: '15 Marloes Court', postcode: 'SA5 7JW', beds: 3, ctBand: 'A', ctAnnual: 1492.19, agent: 'Collins Head Lease', strategy: 'Single let' }, over));
        f.units[0].rent = 237; f.tenancies[0].rent = 237;
        return f;
    };
    it('15 Marloes Court: £237 now, £950 market, so the plan adds £713', () => {
        const v = M.buildPlan(marloes(), S, TODAY).properties[0];
        expect(v.current).toBe('Single let');
        expect(v.chosen).toBe('Single let');
        expect(v.planRent).toBe(950);
        expect(v.planCt).toBe(0);
        expect(v.upliftChosen).toBe(713);
        expect(v.planWhy).toMatch(/open-market rent of £950.00/);
        expect(v.progress).toBe('To do');   // Kevin, 16 Sep 2026: money still to come is never "No change needed"
    });
    it('a rent already above market is held, never planned downwards', () => {
        const f = marloes({ name: '22 Newton Street', postcode: 'BB12 0LG' });
        f.units[0].rent = 1800; f.tenancies[0].rent = 1800;
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.planRent).toBe(1800);
        expect(v.upliftChosen).toBe(0);
        expect(v.planWhy).toMatch(/Already at or above/);
    });
    it('a single let where we took the bills on keeps the council tax in the plan', () => {
        const v = M.buildPlan(marloes({ ctPayer: 'Owner' }), S, TODAY).properties[0];
        expect(v.planCt).toBe(124.35);
        expect(v.upliftChosen).toBe(713);   // we already pay it now, so the change is still the rent
    });
    it('Leave as is still holds a single let flat', () => {
        const v = M.buildPlan(marloes({ strategy: 'Leave as is' }), S, TODAY).properties[0];
        expect(v.planRent).toBe(237);
        expect(v.upliftChosen).toBe(0);
    });
    it('an HMO re-let as a single let is priced at market, not held at its room rents', () => {
        const f = fixture(); f.properties[0].strategy = 'Single let';
        f.properties[0].name = '13 Chedburgh Place';
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.current).toBe('UC HMO');
        expect(v.planRent).toBe(1247);   // the Haverhill 3-bed market rent, below the £1,947.32 now
    });
});

describe('review fixes: empty properties, extra tenants, and the single-let explanation', () => {
    const empty = (placeholder, over = {}) => {
        const f = singleLet(Object.assign({ name: '18 Siddows Avenue', postcode: 'BB7 2NX', beds: 3, ctBand: 'B', ctAnnual: 0, strategy: 'Single let' }, over));
        f.units[0].status = 'Void'; f.units[0].rent = placeholder; f.units[0].tenantIds = [];
        f.tenants = []; f.tenancies = [];
        return f;
    };
    it('18 Siddows Avenue, empty: nothing coming in now, so a single let at £675 adds £675 of rent', () => {
        const v = M.buildPlan(empty(499.70), S, TODAY).properties[0];
        expect(v.rentNow).toBe(0);
        expect(v.planRent).toBe(675);
        // Left for us rises by the rent AND the council tax we stop owing once it is let:
        // 675 − (0 − 154.51). The empty-property council tax rule landed after this test.
        expect(v.upliftChosen).toBe(829.51);
        expect(v.planWhy).toMatch(/it is empty now/);
    });
    it('an old placeholder above market is never planned as if collected', () => {
        const v = M.buildPlan(empty(900), S, TODAY).properties[0];
        expect(v.planRent).toBe(675);
    });
    it('the starting figure an empty property freezes with is what comes in, not the placeholder', () => {
        const p = M.buildPlan(empty(499.70), S, TODAY);
        expect(p.totals.toFreeze[0].rent).toBe(0);
        expect(p.totals.grid.started.rent).toBe(0);
    });
    it('the explanation says we pay the council tax when we do', () => {
        const f = singleLet({ name: '15 Marloes Court', postcode: 'SA5 7JW', ctBand: 'A', ctAnnual: 1492.19, ctPayer: 'Owner', strategy: 'Single let' });
        f.units[0].rent = 237; f.tenancies[0].rent = 237;
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.planWhy).toMatch(/we pay the council tax \(£124.35 a month\)/);
        expect(v.planWhy).not.toMatch(/tenant pays/);
    });
    it('a missing market rent is named, not reported as "at or above £0.00"', () => {
        const f = singleLet({ name: 'Nowhere House', postcode: 'ZZ99 9ZZ', strategy: 'Single let' });
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.market.rent).toBe(0);
        expect(v.planRent).toBe(1000);
        expect(v.planWhy).toMatch(/No open-market rent is known/);
        expect(v.planWhy).not.toMatch(/£0\.00/);
    });
    it('extra tenants only counts where the plan is a UC HMO', () => {
        const hmo = fixture(); hmo.properties[0].strategy = 'HMO';
        expect(M.buildPlan(hmo, S, TODAY).properties[0].extraTenantsApplies).toBe(true);
        const noPlan = fixture();
        expect(M.buildPlan(noPlan, S, TODAY).properties[0].extraTenantsApplies).toBe(true);   // a UC HMO today, nothing picked
        const held = fixture(); held.properties[0].strategy = 'Leave as is';
        expect(M.buildPlan(held, S, TODAY).properties[0]).toMatchObject({ extraTenantsApplies: false, extraTenantsWhy: 'Leave as is holds it' });
        const jt = twoFlatLets();
        expect(M.buildPlan(jt, S, TODAY).properties[0]).toMatchObject({ extraTenantsApplies: false, extraTenantsWhy: 'only counts for a UC HMO, and the plan is UC joint tenancy' });
        const sl = singleLet();
        expect(M.buildPlan(sl, S, TODAY).properties[0]).toMatchObject({ extraTenantsApplies: false, extraTenantsWhy: 'only counts for a UC HMO' });
    });
});

describe('an empty property (Kevin, 16 Sep 2026)', () => {
    const empty = (over = {}) => {
        const f = singleLet(Object.assign({ name: '18 Siddows Avenue', postcode: 'BB7 2NX', beds: 3, ctBand: 'B', ctAnnual: 0, strategy: 'Leave as is' }, over));
        f.units[0].status = 'Void'; f.units[0].rent = 499.70; f.units[0].tenantIds = [];
        f.tenants = []; f.tenancies = [];
        return f;
    };
    it('owes its council tax to us until a tenant moves in, even as a single let', () => {
        const v = M.buildPlan(empty(), S, TODAY).properties[0];
        expect(v.current).toBe('Single let');
        expect(v.emptyNow).toBe(true);
        expect(v.ctNow).toBe(154.51);   // Ribble Valley band B: 2,383.79 × 7/9 ÷ 12
        expect(v.ctNowWhy).toMatch(/Empty, so the council tax is ours until a tenant moves in/);
        expect(v.ctBeforeTicks).toBe(154.51);
    });
    it('Leave as is holds that liability in the plan', () => {
        const v = M.buildPlan(empty(), S, TODAY).properties[0];
        expect(v.planCt).toBe(154.51);
    });
    it('once let as a single let, the plan hands the council tax to the tenant', () => {
        const v = M.buildPlan(empty({ strategy: 'Single let' }), S, TODAY).properties[0];
        expect(v.ctNow).toBe(154.51);
        expect(v.planCt).toBe(0);
        expect(v.planRent).toBe(675);
    });
    it('the moment a tenant is in, it is theirs again', () => {
        const f = empty(); f.units[0].status = 'Occupied'; f.units[0].tenantIds = ['st'];
        f.tenants = [{ id: 'st', name: 'New Tenant', status: 'Active', payType: 'Working' }];
        f.tenancies = [{ id: 'sc', tenantIds: ['st'], unitId: 'su', rent: 675 }];
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.emptyNow).toBe(false);
        expect(v.ctNow).toBe(0);
    });
    it('one empty room in a house of tenants does not make the whole house empty', () => {
        const f = fixture();
        f.units.push({ id: 'u4', propertyId: 'p1', number: 4, type: 'Room', status: 'Void', rent: 400, tenantIds: [] });
        expect(M.buildPlan(f, S, TODAY).properties[0].emptyNow).toBe(false);
    });
});

// Kevin, 16 Sep 2026 (14 Wentworth Terrace): "We'll still be doing the joint tenancy for the two tenants
// there to get the historical council tax liability removed from us, but at the point at which we
// move a third tenant into that property, the council tax will come back to us."
describe('a joint tenancy before the third tenant on a UC HMO house', () => {
    const twoTenantHmo = (status) => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop();
        f.properties[0].strategy = 'UC HMO'; f.properties[0].lettableRooms = 3;
        f.planRows = status ? [{ id: 'r1', key: 'ct:p1', status, title: 'joint tenancy', taskIds: [] }] : [];
        return f;
    };
    it('a started joint tenancy move stays live, adds nothing to the plan, and is not stranded', () => {
        const p = M.buildPlan(twoTenantHmo('Adopted'), S, TODAY);
        const l = p.levers.find(x => x.key === 'ct:p1');
        expect(l.status).toBe('Adopted');
        expect(l.monthly).toBe(0);
        expect(l.evidence[1]).toMatch(/comes back to us when the third tenant moves in/);
        expect(p.totals.strandedRows).toHaveLength(0);
        const v = p.properties[0];
        expect(v.ctNow).toBe(135);          // still ours until the move is done
        expect(v.planCt).toBe(135);         // and ours again once the third tenant is in
    });
    it('marked Done, the council tax is the tenants\' now, and still ours in the plan', () => {
        const v = M.buildPlan(twoTenantHmo('Done'), S, TODAY).properties[0];
        expect(v.ctNow).toBe(0);
        expect(v.ctNowWhy).toMatch(/until the third tenant moves in/);
        expect(v.planCt).toBe(135);
        expect(v.planRent).toBeGreaterThan(v.rentNow);   // the third tenant's rent
    });
    it('no started move, no new candidate: other two-tenant UC HMO houses are unchanged', () => {
        const p = M.buildPlan(twoTenantHmo(null), S, TODAY);
        expect(p.levers.find(x => x.key === 'ct:p1')).toBeUndefined();
        expect(p.properties[0].ctNow).toBe(135);
    });
    it('a house with no room for a third tenant is not an interim joint tenancy', () => {
        const f = twoTenantHmo('Adopted'); f.properties[0].lettableRooms = 2;
        const p = M.buildPlan(f, S, TODAY);
        expect(p.levers.find(x => x.key === 'ct:p1')).toBeUndefined();
        expect(p.totals.strandedRows.map(r => r.key)).toEqual(['ct:p1']);
    });
});

// Kevin, 16 Sep 2026: "No change needed" only when the plan adds nothing.
describe('the status label follows the money still to come', () => {
    const hmo = rooms => { const f = fixture(); f.properties[0].strategy = 'UC HMO'; f.properties[0].lettableRooms = rooms; f.tenants.forEach(t => { t.rentUplift = 'Not needed'; }); return f; };
    it('a UC HMO with a room still to fill reads To do, not No change needed', () => {
        const v = M.buildPlan(hmo(4), S, TODAY).properties[0];
        expect(v.upliftChosen).toBeGreaterThan(0);
        expect(v.progress).toBe('To do');
    });
    it('once its move is started it reads In progress', () => {
        const f = hmo(4); f.planRows = [{ id: 'r1', key: 'rooms:p1', status: 'Adopted', taskIds: [] }];
        expect(M.buildPlan(f, S, TODAY).properties[0].progress).toBe('In progress');
    });
    it('with every room let and nothing to chase it reads No change needed', () => {
        const v = M.buildPlan(hmo(3), S, TODAY).properties[0];
        expect(v.upliftChosen).toBe(0);
        expect(v.progress).toBe('No change needed');
    });
});

// Kevin, 18 Sep 2026: "The checklist should be visible in the unexpanded card, and all the
// rest of the data is available when you expand."
describe('the checklist: what has to be done at each property', () => {
    it('lists every tenant tick and every move, and never lists a rent uplift twice', () => {
        const f = fixture(); f.properties[0].strategy = 'UC HMO'; f.properties[0].lettableRooms = 4;
        const v = M.buildPlan(f, S, TODAY).properties[0];
        const ticks = v.checklist.items.filter(i => i.kind === 'tick');
        expect(ticks).toHaveLength(12);                     // three tenants, four ticks each
        expect(ticks[0].text).toBe('Adam Older: correct tenancy agreement');
        expect(ticks[3].text).toBe('Adam Older: rent uplift');
        expect(ticks[3].note).toBe('£372.62 a month');      // the gap to the 1-bed rate
        const moves = v.checklist.items.filter(i => i.kind === 'move');
        expect(moves.map(m => m.text)).toEqual(['1 more room let to over-35 UC tenants']);
        expect(v.checklist.items.some(i => /room rate to 1-bed rate/.test(i.text))).toBe(false);
        expect(v.checklist.total).toBe(13);
        expect(v.checklist.done).toBe(0);
    });
    it('counts a tick as done, and Not needed counts as done too', () => {
        const f = fixture();
        f.tenants[0].correctAgreement = true; f.tenants[0].rentUplift = 'Not needed';
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.checklist.done).toBe(2);
        expect(v.checklist.open).toBe(v.checklist.total - 2);
        expect(v.checklist.items.find(i => i.text === 'Adam Older: rent uplift').note).toBe('nothing to chase');
    });
    it('carries the move status, so the buttons on the line know what to offer', () => {
        const f = fixture(); f.properties[0].strategy = 'UC HMO'; f.properties[0].lettableRooms = 4;
        f.planRows = [{ id: 'r1', key: 'rooms:p1', status: 'Adopted', taskIds: ['tsk1'] }];
        const item = M.buildPlan(f, S, TODAY).properties[0].checklist.items.find(i => i.kind === 'move');
        expect(item.status).toBe('Adopted');
        expect(item.done).toBe(false);
        expect(item.taskIds).toEqual(['tsk1']);
        expect(item.monthly).toBeGreaterThan(0);
    });
    it('a move that no longer applies is on the list as stale, so it can be dropped', () => {
        const f = fixture(); f.tenants[0].rentUplift = 'Not needed';
        f.planRows = [{ id: 'r1', key: 'uplift:t1', status: 'Adopted', title: 'Adam Older: room rate', taskIds: [] }];
        const v = M.buildPlan(f, S, TODAY).properties[0];
        const stale = v.checklist.items.filter(i => i.kind === 'stranded');
        expect(stale.map(i => i.rowId)).toEqual(['r1']);
    });
    it('a dropped move is off the count, and an agent-held potential is never on the list', () => {
        const f = fixture(); f.properties[0].strategy = 'Leave as is';
        const v = M.buildPlan(f, S, TODAY).properties[0];
        expect(v.checklist.items.some(i => /take back and let|re-let/.test(i.text))).toBe(false);
        expect(v.checklist.total).toBe(v.checklist.items.filter(i => !i.dropped).length);
    });
    it('the portfolio counts what is open across the properties we run', () => {
        const p = M.buildPlan(fixture(), S, TODAY);
        expect(p.totals.checklistOpen).toBe(p.selfManaged.reduce((n, v) => n + v.checklist.open, 0));
        expect(p.totals.checklistOpen).toBeGreaterThan(0);
    });
    it('an agent-run property carries no checklist and counts nothing', () => {
        const f = fixture(); f.properties[0].agent = 'Roc Immo';
        const p = M.buildPlan(f, S, TODAY);
        expect(p.agentManaged[0].checklist.items).toEqual([]);
        expect(p.totals.checklistOpen).toBe(0);
    });
});

describe('the grid shows the gain from the plan on its own (Kevin, 18 Sep 2026)', () => {
    it('gain is the plan less where we are now, rent, council tax and what is left', () => {
        const g = M.buildPlan(fixture(), S, TODAY).totals.grid;
        expect(g.gain.rent).toBe(Math.round((g.plan.rent - g.now.rent) * 100) / 100);
        expect(g.gain.ct).toBe(Math.round((g.plan.ct - g.now.ct) * 100) / 100);
        expect(g.gain.left).toBe(Math.round((g.plan.left - g.now.left) * 100) / 100);
        expect(g.gain.signed).toBe(true);
    });
    it('a plan that takes council tax off us reads as a fall in council tax', () => {
        const f = fixture(); f.units.pop(); f.tenants.pop(); f.tenancies.pop();
        f.properties[0].strategy = 'UC joint tenancy'; f.tenants.forEach(t => { t.correctAgreement = false; });
        const g = M.buildPlan(f, S, TODAY).totals.grid;
        expect(g.now.ct).toBe(135);
        expect(g.plan.ct).toBe(0);
        expect(g.gain.ct).toBe(-135);
    });
});
