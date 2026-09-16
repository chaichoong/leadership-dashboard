// ════════════════════════════════════════════════════════════════════════
// Real Estate Growth Plan — the maths (pure, no DOM, no fetch).
//
// growth-plan.html normalises Airtable records into plain objects and hands
// them to buildPlan(). tests/growth-plan-model.test.js loads this same file
// under Node, so every rule the page shows is the rule the tests check.
//
// Rules this file encodes, with sources (checked 9 Sep 2026):
//   • Universal Credit pays the 1-bed LHA rate to a single claimant aged 35+
//     even in shared accommodation (UC Regs 2013, Sch 4 para 2B). Housing
//     Benefit does NOT: an HB claimant in a shared house gets the shared rate
//     regardless of age. Shelter Legal, entitledto.
//   • Joint renters who are not a couple: each one's eligible rent is the
//     lower of their share and their own LHA rate (Sch 4 paras 24, 35), so a
//     joint tenancy does not cut the rent two over-35s bring in.
//   • Council tax: an HMO is one dwelling and the OWNER pays (SI 2023/1175,
//     from 1 Dec 2023). Let the whole house on one agreement of 6+ months
//     and the tenants are liable instead.
//   • Benefit cap 2026-27: single £1,229.42 / month outside London; earnings
//     of £881+ a month, LCWRA, PIP/DLA or a carer element lift it.
//   • LHA rates: gov.uk england-rates-2026-to-2027.csv (monthly UC amounts).
//     Valid to 31 Mar 2027 — a health check warns when they go stale.
// ════════════════════════════════════════════════════════════════════════
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.GrowthPlanModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const LHA_VALID_TO = '2027-03-31';
    // WEEKLY LHA rates read from lha-direct.voa.gov.uk on 9 Sep 2026 (September 2026 search,
    // one postcode per BRMA). Monthly = weekly × 52 / 12, which is how UC states them: the
    // Cambridge 1-bed is £207.12 a week = £897.52 a month. A downloaded "2026-27" CSV had
    // different figures (£900.00) and was wrong; the lookup is the source. Kevin checked.
    const LHA_WEEKLY = {
        'Cambridge':                  { sar: 121.13, b1: 207.12, b2: 218.63, b3: 258.90, b4: 333.70 },
        'Central Greater Manchester': { sar: 94.72,  b1: 178.36, b2: 201.37, b3: 218.63, b4: 310.68 },
        'Greater Liverpool':          { sar: 79.25,  b1: 115.07, b2: 136.93, b3: 149.59, b4: 201.37 },
        'Fylde Coast':                { sar: 80.75,  b1: 92.05,  b2: 124.73, b3: 143.84, b4: 170.88 },
        'West Pennine':               { sar: 71.50,  b1: 92.05,  b2: 103.56, b3: 116.22, b4: 175.48 },
        'East Lancs':                 { sar: 67.08,  b1: 97.81,  b2: 109.32, b3: 136.93, b4: 182.96 },
        'East Riding':                { sar: 77.29,  b1: 87.45,  b2: 109.32, b3: 126.58, b4: 161.10 },
        'Sunderland':                 { sar: 73.95,  b1: 97.81,  b2: 109.32, b3: 126.58, b4: 161.10 },
        'Furness':                    { sar: 91.00,  b1: 109.32, b2: 115.07, b3: 146.14, b4: 185.84 },
        'Colchester':                 { sar: 92.36,  b1: 143.84, b2: 182.96, b3: 224.38, b4: 287.67 },
        'South Lanarkshire':          { sar: 86.30,  b1: 103.56, b2: 132.33, b3: 164.74, b4: 254.76 },
        'Swansea':                    { sar: 86.30,  b1: 120.82, b2: 126.58, b3: 138.08, b4: 188.71 },
    };
    const weeklyToMonthly = w => Math.round(w * 52 / 12 * 100) / 100;
    const LHA_2026_27 = {};
    Object.keys(LHA_WEEKLY).forEach(k => { const w = LHA_WEEKLY[k]; LHA_2026_27[k] = { sar: weeklyToMonthly(w.sar), b1: weeklyToMonthly(w.b1), b2: weeklyToMonthly(w.b2), b3: weeklyToMonthly(w.b3), b4: weeklyToMonthly(w.b4) }; });
    // Postcode outward code → BRMA, each looked up on LHA Direct on 9 Sep 2026.
    const BRMA_BY_OUTWARD = {
        CB9: 'Cambridge', CB7: 'Cambridge', M40: 'Central Greater Manchester',
        L4: 'Greater Liverpool', L20: 'Greater Liverpool', FY8: 'Fylde Coast',
        BB12: 'West Pennine', BB5: 'East Lancs', BB7: 'East Lancs', HU3: 'East Riding',
        SR8: 'Sunderland', LA13: 'Furness', CO12: 'Colchester', ML3: 'South Lanarkshire', SA5: 'Swansea',
    };
    const BRMA_UNCERTAIN = {}; // outward codes still to confirm on LHA Direct; none as at 9 Sep 2026
    const LOCAL_OUTWARD = new Set(['CB9', 'CB7']); // the estate Kevin manages in person
    const ROOMS_PER_UNIT = { 'Room': 1, 'Flat-Let': 2 }; // Flat-Let = bedroom + own living room

    const EFFORT_WEIGHT = { Paper: 1, Light: 2, Works: 4, Legal: 6 };
    const STAGE = {
        'Rent uplift': 1, 'Rate refresh': 1, 'Council tax': 2, 'Room release': 3, 'New room let': 3,
        'CRF top-up': 1, 'Void let': 4, 'Take-back': 4, 'Agent-held': 5,
    };
    const STAGE_NAMES = { 1: 'Paper trail', 2: 'Council tax', 3: 'Rooms', 4: 'Voids and take-backs', 5: 'Agent-held potential' };

    function monthlyFromFrequency(amount, frequency) {
        const a = Number(amount) || 0;
        switch (String(frequency || 'Monthly')) {
            case 'Weekly': return a * 52 / 12;
            case 'Fortnightly': return a * 26 / 12;
            case '4-Weekly': return a * 13 / 12;
            case 'Quarterly': return a / 3;
            case 'Annually': case 'Yearly': case 'Annual': return a / 12;
            default: return a;
        }
    }
    // Kevin, 16 Sep 2026: plain "HMO" now means the professional houses Roc Immo runs,
    // so our own strategies carry "UC". Every older stored value still reads.
    const STRATEGY_ALIASES = { 'HMO': 'UC HMO', 'Joint tenancy': 'UC joint tenancy', 'Add tenants': 'UC HMO', 'Hold': 'Leave as is' };
    function normaliseStrategy(v) { const t = String(v || '').trim(); return STRATEGY_ALIASES[t] || t; }
    function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
    function round2(v) { return Math.round(v * 100) / 100; }
    function setting(settings, key, fallback) {
        const v = settings && settings[key];
        return (v === undefined || v === null || v === '') ? fallback : num(v, fallback);
    }

    function ageOn(dob, today) {
        if (!dob) return null;
        const b = new Date(dob + 'T00:00:00'); if (isNaN(b)) return null;
        const t = today ? new Date(today + 'T00:00:00') : new Date();
        let a = t.getFullYear() - b.getFullYear();
        if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) a--;
        return a;
    }
    function outward(postcode) {
        const m = String(postcode || '').trim().toUpperCase().match(/^([A-Z]{1,2}\d{1,2}[A-Z]?)\s*\d?[A-Z]{0,2}$/);
        return m ? m[1] : '';
    }
    function brmaFor(postcode) { return BRMA_BY_OUTWARD[outward(postcode)] || null; }
    function isLocal(postcode) { return LOCAL_OUTWARD.has(outward(postcode)); }
    function ratesFor(postcode, settings) {
        const brma = brmaFor(postcode);
        if (!brma) return null;
        const base = LHA_2026_27[brma];
        if (brma === 'Cambridge') {
            // The settings table can override the two Cambridge figures (they are the ones
            // every Haverhill rent hangs on) without a code change each April.
            return { brma, sar: setting(settings, 'lha_room', base.sar), b1: setting(settings, 'lha_1bed', base.b1), b2: base.b2, b3: base.b3, b4: base.b4 };
        }
        return Object.assign({ brma }, base);
    }
    function lhaStale(today) { return (today || new Date().toISOString().slice(0, 10)) > LHA_VALID_TO; }

    // ── Benefit cap calculator ──────────────────────────────────────────
    // Returns what a claimant's UC would be, whether the cap bites, and the
    // highest rent that leaves them whole ("safe rent").
    function benefitCap(input, settings) {
        const i = input || {};
        const single = i.single !== false;
        const age = num(i.age, 35);
        const children = Math.max(0, Math.floor(num(i.children, 0)));
        const housing = Math.max(0, num(i.housing, 0));
        const earnings = Math.max(0, num(i.earnings, 0));
        const s = (k, d) => setting(settings, k, d);
        const standard = single
            ? (age >= 25 ? s('uc_standard_single_25', 424.90) : s('uc_standard_single_u25', 338.58))
            : s('uc_standard_couple_25', 666.97);
        let elements = 0;
        const parts = [];
        if (i.lcwra === 'existing') { elements += s('uc_lcwra_existing', 429.80); parts.push('LCWRA (pre-Apr 2026)'); }
        else if (i.lcwra === 'new') { elements += s('uc_lcwra_new', 217.26); parts.push('LCWRA (new claim)'); }
        if (i.carer) { elements += s('uc_carer', 209.34); parts.push('Carer'); }
        if (children) { elements += children * s('uc_child', 303.94); parts.push(`${children} child element${children > 1 ? 's' : ''}`); }
        const workAllowance = s('uc_work_allowance_housing', 427);
        const taper = s('uc_taper', 0.55);
        const taperDeduction = earnings > workAllowance ? (earnings - workAllowance) * taper : 0;
        const ucBeforeCap = Math.max(0, standard + elements + housing - taperDeduction);
        const cap = (single && children === 0) ? s('benefit_cap_single', 1229.42) : s('benefit_cap_family', 1835);
        const threshold = s('cap_earnings_threshold', 881);
        let exemptReason = '';
        if (earnings >= threshold) exemptReason = `Earnings £${earnings.toFixed(2)} a month reach the £${threshold} threshold`;
        else if (i.lcwra === 'existing' || i.lcwra === 'new') exemptReason = 'LCWRA element in the award';
        else if (i.pipDla) exemptReason = 'PIP or DLA in payment';
        else if (i.carer) exemptReason = 'Carer element in the award';
        const exempt = !!exemptReason;
        const excess = exempt ? 0 : Math.max(0, ucBeforeCap - cap);
        const nonHousing = standard + elements - taperDeduction;
        const safeRent = exempt ? housing : Math.max(0, round2(cap - nonHousing));
        return {
            standard: round2(standard), elements: round2(elements), elementParts: parts,
            taperDeduction: round2(taperDeduction), housing: round2(housing),
            ucBeforeCap: round2(ucBeforeCap), cap: round2(cap), exempt, exemptReason,
            capped: excess > 0, shortfall: round2(excess), ucPaid: round2(ucBeforeCap - excess), safeRent,
        };
    }

    // What the Tenants "Benefit Cap Exemption" select means for the maths.
    function exemptionInput(value) {
        switch (value) {
            case 'LCWRA': return { lcwra: 'existing', known: true, exempt: true };
            case 'PIP or DLA': return { pipDla: true, known: true, exempt: true };
            case 'Carer': return { carer: true, known: true, exempt: true };
            case 'Earnings over threshold': return { earnings: 9999, known: true, exempt: true };
            case 'Not on UC': return { known: true, exempt: true, notUc: true };
            case 'None (capped)': return { known: true, exempt: false };
            default: return { known: false, exempt: false };
        }
    }

    // Kevin's ruling, 9 Sep 2026: rent is always set at the full LHA rate. Where the benefit
    // cap bites, the housing element paid to the landlord falls short and the shortfall is
    // covered by a Crisis and Resilience Fund Housing Payment (the council payment that
    // replaced Discretionary Housing Payments on 1 April 2026), applied for with the tenant.
    // So this reports the shortfall to apply for, never a lower rent.
    function capPosition(exemptionValue, lhaRate, settings) {
        const ex = exemptionInput(exemptionValue);
        if (ex.exempt) return { rent: lhaRate, known: true, exempt: true, shortfall: 0 };
        const calc = benefitCap({ single: true, age: 35, housing: lhaRate }, settings);
        return { rent: lhaRate, known: ex.known, exempt: false, shortfall: calc.shortfall };
    }

    function isUc(tenant, unit) {
        if (tenant && tenant.payType === 'Universal Credit') return true;
        if (tenant && tenant.payType === 'Working') return false;
        const inc = unit && unit.incomeType;
        return inc === 'Universal Credit' || inc === 'UC and Working';
    }
    function isHb(tenant, unit) { return !!(unit && unit.incomeType === 'Housing Benefit') && !(tenant && tenant.payType === 'Universal Credit'); }

    function managementOf(prop, tenants) {
        const agent = String(prop.agent || '').trim();
        if (/collins/i.test(agent)) return 'collins';
        if (/roc\s*immo/i.test(agent)) return 'rocimmo';
        if (agent && !/property portfolio/i.test(agent)) return 'agent';
        if (tenants.some(t => t.payType === 'Agent-Managed')) return 'agent';
        return 'kevin';
    }

    function roomsUsedBy(unit, lettable) {
        if (unit.type === 'Whole Property') return lettable || 0;
        return ROOMS_PER_UNIT[unit.type] || 1;
    }


    // ════════════════════════════════════════════════════════════════
    // STRATEGY COMPARISON (Kevin's rebuild, 16 Sep 2026)
    //
    // Every property is priced under all four strategies so the choice is
    // visible rather than argued. The rules are Kevin's, verbatim:
    //   • Single let      one household in the whole property. Tenants pay the
    //                     council tax. Income = open-market rent.
    //   • Joint tenancy   two over-35 UC tenants on ONE agreement. Tenants pay
    //                     the council tax. Income = 1-bed LHA × 2.
    //   • HMO             one over-35 UC tenant per room. THE OWNER pays the
    //                     council tax (SI 2023/1175). Income = rooms × 1-bed LHA.
    //   • Serviced accom. short lets. The owner pays the council tax.
    //                     Income = £500 a month, net to us (Kevin, 16 Sep 2026).
    // ════════════════════════════════════════════════════════════════
    const STRATEGY_LIST = ['Single let', 'UC joint tenancy', 'UC HMO', 'Serviced accommodation'];
    // What Kevin can pick for a property: the four, or hold it where it is.
    const PLAN_CHOICES = STRATEGY_LIST.concat(['Leave as is']);

    // Council tax is set in ninths of the band D charge, fixed by statute
    // (Local Government Finance Act 1992 s.5). One known band gives every band.
    // Wales uses the same ninths as England and adds band I (Swansea).
    const BAND_NINTHS = { A: 6, B: 7, C: 8, D: 9, E: 11, F: 13, G: 15, H: 18, I: 21 };

    // Band D annual charge, 2026-27. "derived" means computed from a band already
    // on a property record using the statutory ninths, which is arithmetic, not a guess.
    const COUNCIL_BAND_D = {
        'West Suffolk':        { d: 2443.96, source: 'derived from band B £1,900.86 on the Haverhill property records' },
        'East Cambridgeshire': { d: 2485.18, source: 'derived from band B £1,932.92 on 18 Northfield Park' },
        'Manchester':          { d: 2312.04, source: 'derived from band A £1,541.36 on 1406 Oldham Road' },
        'Sefton':              { d: 2564.73, source: 'sefton.gov.uk bands and charges, read 16 Sep 2026' },
        'Liverpool':           { d: 2673.59, source: 'liverpool.gov.uk "how much is my council tax", read 16 Sep 2026' },
        'Ribble Valley':       { d: 2383.79, source: 'ribblevalley.gov.uk charges by parish (Clitheroe), read 16 Sep 2026' },
        'Burnley':             { d: 2549.42, source: 'Burnley 2026-27 band table, read 16 Sep 2026 (band B £1,982.88 is exactly 7/9 of it, which checks out)' },
        'Kingston upon Hull':  { d: 2295.05, source: 'derived from the Hull band A total of £1,530.03 for 2026-27, council, social care, police, fire and combined authority' },
        'Hyndburn':            { d: 2465.99, source: 'derived from the Hyndburn band A total of £1,643.99 for 2026-27' },
        'Swansea':             { d: 2238.29, source: 'Swansea 2026-27 band D; band A £1,492.19 checks out at 6/9' },
        'Westmorland and Furness': { d: 2474.81, source: 'westmorlandandfurness.gov.uk charges by parish, Barrow Town 2026-27, all precepts' },
        'Durham':              { d: 2832.42, source: 'Horden parish band D 2025-26 including the parish precept (durham.gov.uk guide). The 2026-27 parish figure is not published yet, so this is last year: the real bill is a little higher, never lower' },
        'Fylde':               { d: 2509.35, source: 'fylde.gov.uk council tax bands 2026/27, St Annes (band A £1,672.90), read 16 Sep 2026. Lytham and Ansdell carry slightly different parish charges' },
    };
    // Outward code → billing authority. A code that is absent is NOT guessed: the
    // property shows "council tax rate not confirmed" and its HMO and serviced
    // accommodation figures are marked assumed.
    const COUNCIL_BY_OUTWARD = {
        CB9: 'West Suffolk', CB7: 'East Cambridgeshire', M40: 'Manchester',
        L20: 'Sefton', L4: 'Liverpool', BB7: 'Ribble Valley',
        BB12: 'Burnley', HU3: 'Kingston upon Hull', BB5: 'Hyndburn', SA5: 'Swansea',
        LA13: 'Westmorland and Furness', SR8: 'Durham', FY8: 'Fylde',
    };

    // Open-market single-let rent, researched 16 Sep 2026 for the properties Kevin
    // named. Everything else falls back to the LHA rate for its bedroom count, which
    // is marked as an estimate on the page. A settings row overrides either.
    const MARKET_RENT = {
        '11 Aigburth Avenue': { rent: 625, source: '2-bed terrace, HU3 outcode average, September 2026 listings' },
        '13 John Street':     { rent: 657, source: '2-bed terrace, BB5 average asking rent, September 2026' },
        '15 Marloes Court':   { rent: 950, source: '3-bed, Fforestfach SA5 listings £925 to £975, August 2026' },
        '16 Eleventh Street': { rent: 550, source: '2-bed, Peterlee SR8; Eleventh Street £500, Seventh Street £525, area median £623' },
        '82 Devon Street':    { rent: 730, source: '2-bed terrace, Barrow-in-Furness LA13 average asking rent' },
        '18 Siddows Avenue':  { rent: 675, source: '3-bed terrace, Clitheroe BB7 average asking rent' },
        '22 Newton Street':   { rent: 752, source: '3-bed terrace, Burnley BB12 average asking rent' },
        '23 Viola Street':    { rent: 850, source: '3-bed terrace, Bootle L20 listings £800 to £1,100' },
        // Priced flat by flat (16 Sep 2026): the growth plan shows each apartment as its own row.
        'Duckworth Building': { rent: 646, source: '1-bed flat, Lytham St Annes FY8 average asking rent (per flat)', byBeds: {
            1: { rent: 646, source: '1-bed flat, Lytham St Annes FY8 average asking rent' },
            2: { rent: 750, source: '2-bed flat, St Annes FY8: Rightmove listed 17 on 16 Sep 2026, the everyday ones £625 to £1,000 (seafront and retirement flats at £1,200 to £2,000 left out); £750 taken, towards the bottom, for a town-centre conversion' },
        } },
        // The rest of the portfolio, researched 16 Sep 2026 so no self-managed property
        // is left pricing its single-let column off the housing allowance.
        '13 Chedburgh Place':  { rent: 1247, source: '3-bed terrace, Haverhill CB9 average asking rent' },
        '5 Dalham Place':      { rent: 1247, source: '3-bed terrace, Haverhill CB9 average asking rent' },
        '55 Elmdon Place':     { rent: 1247, source: '3-bed terrace, Haverhill CB9 average asking rent' },
        '14 Wentworth Terrace':{ rent: 1050, source: '2-bed terrace, Haverhill CB9; listings £995 to £1,150, area average £982 across all 2-beds' },
        '6 Chedburgh Place':   { rent: 1050, source: '2-bed terrace, Haverhill CB9; listings £995 to £1,150, area average £982 across all 2-beds' },
        '4 Abington Place':    { rent: 1400, source: '4-bed, Haverhill CB9 average asking rent (range £1,300 to £1,700)' },
        '34 Connaught Road':   { rent: 1400, source: '4-bed, Haverhill CB9 average asking rent (range £1,300 to £1,700)' },
        '18 Northfield Park':  { rent: 950,  source: '2-bed, Soham CB7; 2-bed flat £850, 3-bed cottage £1,050' },
        '1406 Oldham Road':    { rent: 1150, source: '3-bed terrace, Newton Heath M40; listings £1,100 to £1,295' },
        '282 Stanley Park Avenue South': { rent: 875, source: '3-bed terrace, Anfield L4; listings £800 to £945' },
    };

    // What has to be signed, collected and submitted for each strategy (Kevin, 16 Sep 2026).
    const CHECKLIST = {
        'Single let': {
            note: 'The tenancy agreement is already in place and the tenant pays the council tax. Usually nothing to do.',
            property: [], tenant: [], ifShort: [],
        },
        'UC joint tenancy': {
            note: 'One agreement covering the whole house, both names on it. The council tax only moves to them once every tenant has signed it.',
            property: ['Joint tenancy agreement, one agreement with both names on it'],
            tenant: ['Letter of authority, so we can set up their council tax reduction', 'Proof of address'],
            ifShort: ['Discretionary housing application, where their rent is short'],
        },
        'UC HMO': {
            note: 'One agreement per tenant. We keep the council tax. Every tenant aged 35 or over goes on the 1-bed rate.',
            property: [],
            tenant: ['Individual tenancy agreement at the 1-bed rate', 'Letter of authority', 'Proof of address'],
            ifShort: ['Discretionary housing application, where their rent is short'],
        },
        'Serviced accommodation': {
            note: 'Run by an agent on short lets. Nothing for us to sign with a tenant.',
            property: [], tenant: [], ifShort: [],
        },
    };

    // The four ticks every tenant carries (Kevin, 16 Sep 2026). Each is a field on Tenants.
    const TENANT_DOCS = [
        { key: 'correctAgreement', label: 'Correct tenancy agreement' },
        { key: 'proofOfAddress',   label: 'Proof of address' },
        { key: 'authoritySigned',  label: 'Letter of authority' },
        { key: 'rentUplift',       label: 'Rent uplift' },
    ];

    // Explanation lines are read by a person, so they get thousands separators.
    const money = n => Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    function councilFor(postcode) { return COUNCIL_BY_OUTWARD[outward(postcode)] || null; }

    // Kevin, 16 Sep 2026: a property is ours unless a live letting agent runs it.
    // "Property Portfolio" is our own landlord name, and Simon Collins stopped
    // counting as an agent, so his houses come back into our list.
    function isSelfManaged(prop) {
        if (prop && prop.movingToSelfManage) return true;   // being taken back: treat it as ours
        const agent = String((prop && prop.agent) || '').trim();
        if (!agent) return true;
        if (/property portfolio/i.test(agent)) return true;
        if (/collins/i.test(agent)) return true;
        return false;
    }

    // The band each council's properties are on, taken from the ones that carry a band.
    // Used to fill a blank band on a property in a council we already know, and always
    // reported as borrowed on the page.
    function bandsByCouncil(properties) {
        const tally = {};
        (properties || []).forEach(p => {
            const c = councilFor(p.postcode); const b = String(p.ctBand || '').trim().toUpperCase();
            if (!c || !b || !BAND_NINTHS[b]) return;
            (tally[c] = tally[c] || {})[b] = (tally[c][b] || 0) + 1;
        });
        const out = {};
        Object.keys(tally).forEach(c => { out[c] = Object.keys(tally[c]).sort((a, b) => tally[c][b] - tally[c][a])[0]; });
        return out;
    }

    // The council tax we would pay on this property, a month. A live cost row that the
    // bank feed reconciles always wins; then the band on the record; then the band-D
    // table for its council. Anything not read from a record is flagged, never hidden.
    function councilTaxFor(prop, liveMonthly, bandFallback) {
        const band = String(prop.ctBand || '').trim().toUpperCase();
        const council = councilFor(prop.postcode);
        if (liveMonthly > 0) return { monthly: round2(liveMonthly), band, council, confirmed: true, source: `£${money(round2(liveMonthly))} a month is what you pay today (live cost row, bank-fed)` };
        if (num(prop.ctAnnual) > 0) return { monthly: round2(num(prop.ctAnnual) / 12), band, council, confirmed: true, source: `Band ${band || '?'}, £${money(num(prop.ctAnnual))} a year on the property record` };
        const table = council && COUNCIL_BAND_D[council];
        if (band && table) {
            const annual = round2(table.d * BAND_NINTHS[band] / 9);
            return { monthly: round2(annual / 12), band, council, confirmed: true, source: `Band ${band} in ${council}: £${money(annual)} a year (${table.source})` };
        }
        // Council known, band not. Every other property we own in that council carries
        // the same band, so use it and SAY it is borrowed. Stating the assumption is the
        // point: a silent £0 would make an HMO look more profitable than it is.
        if (!band && table && bandFallback) {
            const annual = round2(table.d * BAND_NINTHS[bandFallback] / 9);
            return { monthly: round2(annual / 12), band: bandFallback, council, confirmed: false, borrowed: true,
                source: `No band on this property. Using band ${bandFallback}, which every other ${council} property we own is on: £${money(annual)} a year. Set the real band to fix this.` };
        }
        // Nothing to go on. monthly is null, NOT zero: the page shows "not known" and
        // prices the HMO and short-let figures before council tax rather than pretending
        // there is none (CLAUDE.md: an inferred value presented as fact is worse than "I don't know").
        return { monthly: null, band, council, confirmed: false,
            source: band ? `Band ${band}, but the council tax rate for ${council || 'this area'} has not been looked up yet` : `No council tax band on this property${council ? '' : ', and no council matched to its postcode'} yet` };
    }

    // Rooms we could let individually. The Lettable Rooms field is the answer where
    // Kevin has set it; otherwise the rooms already let (a flat-let is two rooms);
    // otherwise the bedroom count. Which one was used is always stated.
    function rentableRoomsFor(prop, pUnits) {
        if (prop.lettableRooms != null && prop.lettableRooms !== '') return { rooms: num(prop.lettableRooms), source: 'Lettable Rooms on the property record', confirmed: true };
        const let_ = pUnits.filter(u => u.type === 'Room' || u.type === 'Flat-Let');
        if (let_.length) {
            const rooms = let_.reduce((n, u) => n + (ROOMS_PER_UNIT[u.type] || 1), 0);
            return { rooms, source: `${rooms} rooms already let here (a flat-let counts as two)`, confirmed: false };
        }
        const beds = Math.max(1, num(prop.beds));
        return { rooms: beds, source: `${beds} bedrooms on ${prop.unitRecord ? "this apartment's rental unit" : 'the property record'}`, confirmed: false };
    }

    function marketRentFor(prop, rates, settings) {
        const slug = 'market_rent_' + String(prop.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const override = settings && settings[slug];
        if (override !== undefined && override !== null && override !== '') return { rent: num(override), source: 'Typed into the assumptions on this page', researched: true };
        // An apartment shown on its own row is priced by its bedrooms, off its block's research.
        const known = MARKET_RENT[prop.name] || (prop.parentName ? MARKET_RENT[prop.parentName] : null);
        const byBeds = known && known.byBeds && known.byBeds[Math.max(1, num(prop.beds) || 1)];
        if (byBeds) return { rent: byBeds.rent, source: byBeds.source, researched: true };
        if (known) return { rent: known.rent, source: known.source, researched: true };
        if (rates) {
            const beds = Math.max(1, Math.min(4, num(prop.beds) || 1));
            const rate = rates['b' + beds] || rates.b1;
            return { rent: round2(rate), source: `Estimate only: the ${rates.brma} ${beds}-bed housing allowance. Type the real market rent in the assumptions.`, researched: false };
        }
        return { rent: 0, source: 'No market rent and no housing allowance for this postcode', researched: false };
    }

    // What the property IS today, read from its units. Not what we want it to be.
    function currentStrategyOf(prop, pUnits) {
        // Rental Units → Letting Strategy, where every unit carries the same one (16 Sep 2026).
        // A serviced let looks exactly like a single let from its unit type, so 22 Newton
        // Street read "Single let" until this was recorded.
        const stated = Array.from(new Set(pUnits.map(u => normaliseStrategy(u.lettingStrategy))));
        if (pUnits.length && stated.length === 1 && STRATEGY_LIST.includes(stated[0])) return stated[0];
        if (prop.type === 'Block') return 'Block of flats';
        const roomUnits = pUnits.filter(u => u.type === 'Room' || u.type === 'Flat-Let');
        const whole = pUnits.filter(u => u.type === 'Whole Property');
        const shared = roomUnits.length >= 2 || whole.length >= 2 || (roomUnits.length === 1 && whole.length === 0);
        if (!shared) return 'Single let';
        return isSelfManaged(prop) ? 'UC HMO' : 'HMO';   // an agent's room let is a professional HMO
    }

    // The four strategies, priced. Every one carries how it was worked out.
    function priceStrategies(prop, pUnits, rates, settings, ctInfo, roomInfo, market) {
        const s = (k, d) => setting(settings, k, d);
        const b1 = rates ? rates.b1 : 0;
        const saRent = s('sa_monthly', 500);
        const out = [];

        out.push({
            name: 'Single let', units: 1, gross: round2(market.rent), councilTax: 0, net: round2(market.rent),
            how: `Open-market rent for the whole property: £${money(market.rent)} a month`,
            ctNote: 'The tenant pays the council tax, not us', assumed: !market.researched,
            why: market.source,
        });

        out.push({
            name: 'UC joint tenancy', units: 2, gross: round2(b1 * 2), councilTax: 0, net: round2(b1 * 2),
            how: rates ? `Two tenants aged 35+ on one agreement: 2 × £${money(b1)} (the ${rates.brma} 1-bed rate)` : 'No housing allowance rate for this postcode',
            ctNote: 'The tenants pay the council tax, but only once EVERY tenant has signed the one joint agreement. Until then it stays with us.', assumed: !rates,
            why: rates ? `${rates.brma} 1-bed rate £${money(b1)} a month, from the weekly LHA × 52 ÷ 12` : '',
        });

        const ctKnown = ctInfo.monthly != null;
        const ctCost = ctKnown ? round2(ctInfo.monthly) : null;
        const ctLine = ctKnown
            ? `We pay the council tax: £${money(ctCost)} a month${ctInfo.borrowed ? ' (band borrowed from our other properties in this council)' : ''}`
            : 'We pay the council tax. The amount is not known yet, so this figure is BEFORE council tax.';

        const hmoGross = round2(roomInfo.rooms * b1);
        out.push({
            name: 'UC HMO', units: roomInfo.rooms, gross: hmoGross, councilTax: ctCost, net: round2(hmoGross - (ctCost || 0)),
            how: rates ? `${roomInfo.rooms} rooms × £${money(b1)} (the ${rates.brma} 1-bed rate) = £${money(hmoGross)}` : 'No housing allowance rate for this postcode',
            ctNote: ctLine, assumed: !rates || !roomInfo.confirmed || !ctKnown || !!ctInfo.borrowed,
            why: [roomInfo.source, ctInfo.source].join('. '),
        });

        out.push({
            name: 'Serviced accommodation', units: 1, gross: round2(saRent), councilTax: ctCost, net: round2(saRent - (ctCost || 0)),
            how: `Short lets, budgeted at £${money(saRent)} a month net to us`,
            ctNote: ctLine, assumed: !ctKnown || !!ctInfo.borrowed,
            why: `£${money(saRent)} a month is the budget Kevin set. ${ctInfo.source}`,
        });

        // A flat on its own row (an apartment in a block) is let whole, so a room-by-room
        // let never applies, and a joint tenancy needs a bedroom each for its two tenants.
        if (prop.type === 'Flat') {
            const beds = Math.max(1, num(prop.beds) || 1);
            out.forEach(x => {
                const hmo = x.name === 'UC HMO';
                if (!hmo && !(x.name === 'UC joint tenancy' && beds < 2)) return;
                x.na = true; x.gross = 0; x.net = 0; x.units = 0; x.councilTax = null; x.ctNote = '';
                x.how = hmo ? 'Does not apply to a flat' : 'Does not apply to a one-bedroom flat';
                x.why = hmo ? 'A flat is let whole, never room by room.' : 'A joint tenancy needs a bedroom each for its two tenants.';
            });
        }

        // A block of flats is not a house. Letting it room by room or on one joint
        // tenancy is not a thing you can do to a block, so those two are marked
        // not applicable rather than priced at a number nobody could ever collect.
        if (prop.type === 'Block') {
            const flats = pUnits.filter(u => u.type === 'Flat');
            const n = flats.length || Math.max(1, num(prop.beds));
            const single = out[0];
            single.units = n;
            single.gross = round2(market.rent * n);
            single.net = single.gross;
            single.how = `${n} flats × £${money(market.rent)} a month`;
            out.forEach(x => {
                if (x.name === 'UC joint tenancy' || x.name === 'UC HMO' || x.name === 'Serviced accommodation') {
                    x.na = true; x.gross = 0; x.net = 0; x.units = 0; x.councilTax = null;
                    x.how = 'Does not apply to a block of flats';
                    x.ctNote = ''; x.why = 'A block is let flat by flat, so this strategy is not an option here.';
                }
            });
        }

        return out;
    }

    // Kevin, 16 Sep 2026: Duckworth Building is nine apartments, each let on its own terms
    // (1 and 2 serviced accommodation, 3 to 9 single lets). Airtable keeps it as one property
    // with nine rental units, which is right for the accounts, so the growth plan splits a
    // block into one row per flat here and nowhere else. Each apartment's plan, council tax
    // band and frozen start live on its Rental Units record; the agent, postcode, bills and
    // the self-manage tick come from the block. A cost row on the block itself cannot be
    // shared out between flats, so it is not read for them.
    function splitBlocks(properties, units) {
        const unitsByProp = {};
        (units || []).forEach(u => { (unitsByProp[u.propertyId] = unitsByProp[u.propertyId] || []).push(u); });
        const outProps = [], moved = {};
        (properties || []).forEach(p => {
            const all = unitsByProp[p.id] || [];
            const flats = p.type === 'Block' ? all.filter(u => u.type === 'Flat') : [];
            if (flats.length < all.length || !flats.length) outProps.push(p);   // anything that is not a flat stays on the block
            flats.slice().sort((a, b) => num(a.number) - num(b.number)).forEach(u => {
                moved[u.id] = p.id;
                outProps.push({
                    id: u.id, name: `${p.name}, Apartment ${u.number}`, parentId: p.id, parentName: p.name, unitRecord: true,
                    type: 'Flat', beds: u.beds, agent: p.agent, postcode: p.postcode, area: p.area, ctNote: '',
                    lettableRooms: null, payg: p.payg, ctPayer: p.ctPayer, owner: p.owner,
                    strategy: u.growthStrategy || '', ctBand: u.ctBand || '', ctAnnual: 0,
                    baselineRent: u.baselineRent == null ? null : u.baselineRent,
                    baselineCt: u.baselineCt == null ? null : u.baselineCt,
                    baselineDate: u.baselineDate || '', movingToSelfManage: !!p.movingToSelfManage,
                });
            });
        });
        const outUnits = (units || []).map(u => moved[u.id] ? Object.assign({}, u, { propertyId: u.id, blockId: moved[u.id] }) : u);
        return { properties: outProps, units: outUnits };
    }

    // Kevin, 16 Sep 2026: rent now is what the LIVE tenancies say, per unit. The unit's
    // Expected Rent rollup adds ended tenancies too: 22 Newton Street read £1,800 (the live
    // £500 serviced let plus a £1,300 tenancy that had ended), and nine other units carried
    // £5,894.74 a month that nobody pays. A tenancy with a status other than Live is ignored.
    function liveRentByUnit(tenancies) {
        const out = {};
        (tenancies || []).forEach(tc => {
            if (!tc.unitId || (tc.status && tc.status !== 'Live')) return;
            out[tc.unitId] = round2((out[tc.unitId] || 0) + num(tc.rent));
        });
        return out;
    }

    // ── The plan ────────────────────────────────────────────────────────
    function buildPlan(data, settings, today) {
        const s = (k, d) => setting(settings, k, d);
        const T = today || new Date().toISOString().slice(0, 10);
        const split = splitBlocks(data.properties, data.units);
        const units = split.units;
        const allProperties = split.properties;
        const liveRent = liveRentByUnit(data.tenancies);
        const unitRent = u => liveRent[u.id] || 0;
        const unitsByProp = {};
        units.forEach(u => { (unitsByProp[u.propertyId] = unitsByProp[u.propertyId] || []).push(u); });
        const tenantById = {}; (data.tenants || []).forEach(t => { tenantById[t.id] = t; });
        // A tenant can carry more than one tenancy row; take the one on the unit being priced,
        // and share a joint tenancy's rent between its tenants.
        const tenanciesByTenant = {}; (data.tenancies || []).forEach(tc => { (tc.tenantIds || []).forEach(id => { (tenanciesByTenant[id] = tenanciesByTenant[id] || []).push(tc); }); });
        const tenancyFor = (tenantId, unit) => { const list = tenanciesByTenant[tenantId] || []; return list.find(x => x.unitId === unit.id) || list[list.length - 1] || null; };
        const rentFor = (tenantId, unit, fallback) => {
            const tc = tenancyFor(tenantId, unit);
            if (!tc) return fallback;
            return num(tc.rent) / Math.max(1, (tc.tenantIds || []).length);
        };
        const ctByProp = {}; (data.costs || []).forEach(c => {
            if (!c.propertyId || c.shared || /debt|arrears|enforcement|bailiff|\bbin\b|bins\b|garden waste/i.test(String(c.name || ''))) return; // a repayment plan or a bin charge is not the bill
            ctByProp[c.propertyId] = (ctByProp[c.propertyId] || 0) + num(c.monthly);
        });
        const planByKey = {}; (data.planRows || []).forEach(r => { if (r.key) planByKey[r.key] = r; });
        const capSingle = benefitCap({ single: true, age: 35, housing: 0 }, settings);
        const safeSingle = round2(capSingle.cap - capSingle.standard); // £804.52 on 2026-27 figures

        const bandByCouncil = bandsByCouncil(allProperties);
        const levers = [];
        const properties = [];
        const unknownAge = [];
        let rentNow = 0;

        allProperties.forEach(prop => {
            const pUnits = (unitsByProp[prop.id] || []).slice().sort((a, b) => num(a.number) - num(b.number));
            const occupied = pUnits.filter(u => u.status === 'Occupied' || (u.tenantIds || []).length);
            const pTenants = [];
            occupied.forEach(u => (u.tenantIds || []).forEach(id => { const t = tenantById[id]; if (t && t.status !== 'Former') pTenants.push(Object.assign({ unit: u }, t)); }));
            const mgmt = managementOf(prop, pTenants);
            // Review fix, 16 Sep 2026: the self-managed tools key off whether the property is
            // OURS, not off the agent name. managementOf reads the agent field and a tenant's pay
            // type, so a property promoted by "Moving to self-manage", and 22 Newton Street and
            // 23 Viola Street (each with one agent-collected tenancy), were in our list without
            // their uplift, room and council tax moves. Collins keeps its own take-back lever.
            const ours = mgmt === 'kevin' || (mgmt !== 'collins' && isSelfManaged(prop));
            const rates = ratesFor(prop.postcode, settings);
            const local = isLocal(prop.postcode);
            const ow = outward(prop.postcode);
            const propRent = pUnits.reduce((sum, u) => sum + unitRent(u), 0);
            rentNow += propRent;
            const ctLive = ctByProp[prop.id] || 0;
            const ctNoteAmount = (() => { const m = String(prop.ctNote || '').match(/£?\s*([\d,]+(?:\.\d+)?)/); return m ? num(m[1].replace(/,/g, '')) : 0; })();
            const ownerPaysCt = prop.ctPayer === 'Owner' || (prop.ctPayer !== 'Tenants' && ctLive > 0);
            const ctBandMonthly = prop.ctAnnual ? round2(num(prop.ctAnnual) / 12) : 0;
            const ctMonthly = ctLive || ctBandMonthly || s('council_tax_default', 145);

            const roomsInUse = occupied.reduce((n, u) => n + (u.type === 'Whole Property' ? 0 : (ROOMS_PER_UNIT[u.type] || 1)), 0)
                + (occupied.some(u => u.type === 'Whole Property') ? Math.max(num(prop.beds), 1) : 0);
            const lettable = prop.lettableRooms != null && prop.lettableRooms !== '' ? num(prop.lettableRooms) : null;
            const lettableEff = lettable != null ? lettable : roomsInUse;

            const view = {
                id: prop.id, name: prop.name, type: prop.type, postcode: prop.postcode || '', area: prop.area || '',
                brma: rates ? rates.brma : null, brmaNote: BRMA_UNCERTAIN[ow] || '', local, mgmt, ours, agent: prop.agent || '',
                rentNow: round2(propRent), ctLive: round2(ctLive), ctMonthly: round2(ctMonthly), ownerPaysCt, ctPayer: prop.ctPayer || 'Unknown',
                payg: prop.payg || 'Unknown', beds: num(prop.beds), lettable, lettableEff, roomsInUse, strategy: normaliseStrategy(prop.strategy), owner: prop.owner || '', ctBand: prop.ctBand || '', ctAnnual: num(prop.ctAnnual), ctBandMonthly,
                rates, units: [], tenants: [], levers: [], flags: [],
            };
            if (!rates && prop.postcode) view.flags.push('No LHA table for this postcode');
            if (!prop.postcode) view.flags.push('No postcode on the property record');

            // Per tenant view + stage 1 levers
            occupied.forEach(u => {
                const uTenants = (u.tenantIds || []).map(id => tenantById[id]).filter(t => t && t.status !== 'Former');
                const uView = { id: u.id, number: u.number, type: u.type, status: u.status, rent: round2(unitRent(u)), incomeType: u.incomeType || '', lettingStrategy: normaliseStrategy(u.lettingStrategy), tenants: [] };
                uTenants.forEach(t => {
                    const age = ageOn(t.dob, T);
                    const over35Known = age != null ? age >= 35 : !!t.over35Confirmed; // Kevin/Roy can confirm 35+ without a date of birth
                    const rent = rentFor(t.id, u, unitRent(u) / Math.max(1, uTenants.length));
                    const uc = isUc(t, u), hb = isHb(t, u);
                    const tv = { id: t.id, name: t.name, dob: t.dob || '', age, payType: t.payType || '', uc, hb, rent: round2(rent), capExemption: t.capExemption || 'Unknown', unitId: u.id, unitType: u.type, rateNow: null, target: null, note: '',
                        over35Confirmed: !!t.over35Confirmed, ni: t.ni || '', phone: t.phone || '', email: t.email || '', idSeen: t.idSeen || '', ucStatementSeen: !!t.ucStatementSeen,
                        // The four ticks (Kevin, 16 Sep 2026). Rent Uplift blank reads as To do.
                        correctAgreement: !!t.correctAgreement, proofOfAddress: !!t.proofOfAddress, authoritySigned: !!t.authoritySigned,
                        rentUplift: t.rentUplift || 'To do', upliftGap: 0 };
                    const wholeShared = u.type !== 'Whole Property' || occupied.filter(x => x.type === 'Whole Property').length >= 2;
                    if (ours && rates && (uc || hb) && !wholeShared) {
                        // One household renting the whole house: the LHA rate depends on who lives
                        // there (children, couple), which Airtable does not record. Priced by hand.
                        tv.note = 'Whole-house let: LHA rate depends on the household, not modelled here';
                    }
                    if (ours && rates && (uc || hb) && wholeShared) {
                        const roomUnit = u.type === 'Room';
                        // HB keeps the shared rate in a shared house at any age; UC does not.
                        const entitled1Bed = !roomUnit || (uc && over35Known);
                        const rate = entitled1Bed ? rates.b1 : rates.sar;
                        tv.rateNow = rate;
                        if (roomUnit && uc && age == null && !t.over35Confirmed) {
                            // Kevin, 9 Sep 2026: no date of birth and not confirmed 35+ means OUT of the plan;
                            // the tenant stays on the facts list until the date of birth is known.
                            const gapU = round2(Math.max(0, rates.b1 - rent));
                            unknownAge.push({ tenantId: t.id, tenant: t.name, propertyId: prop.id, property: prop.name, unit: u.number, rent: tv.rent, upliftIfOver35: gapU, upliftIfExempt: gapU });
                            tv.note = 'Age unknown: not in the plan until the date of birth is on file (or 35+ is confirmed)';
                        } else if (uc) {
                            const cap = capPosition(tv.capExemption, rate, settings);
                            tv.target = rate;
                            tv.capShortfall = cap.shortfall;
                            tv.capKnown = cap.known;
                            const leverName = (roomUnit && entitled1Bed) ? 'Rent uplift' : 'Rate refresh';
                            const gap = round2(rate - rent);
                            const notNeeded = tv.rentUplift === 'Not needed';
                            if (gap > 0.5 && !notNeeded) tv.upliftGap = gap;
                            if (gap > 0.5 && !notNeeded) {
                                const crfNeed = cap.exempt ? [] : [`${cap.known ? 'Benefit cap bites' : 'Benefit cap likely bites'}: apply for a CRF Housing Payment of £${cap.shortfall.toFixed(2)} a month paid to the landlord, or record the exemption`];
                                levers.push(lever({
                                    key: `${leverName === 'Rent uplift' ? 'uplift' : 'refresh'}:${t.id}`, lever: leverName, propertyId: prop.id, property: prop.name,
                                    tenantId: t.id, tenant: t.name, unitId: u.id, unit: u.number,
                                    title: leverName === 'Rent uplift'
                                        ? `${t.name}: room rate to 1-bed rate (${age != null ? 'age ' + age : '35+ confirmed'})`
                                        : `${t.name}: rent to the ${rates.brma} ${entitled1Bed ? '1-bed' : 'room'} rate`,
                                    monthly: gap, monthlyIfExempt: gap, oneOff: 0, effort: 'Paper', counted: 'now',
                                    capShortfall: cap.exempt ? 0 : cap.shortfall,
                                    evidence: [
                                        `Rent now £${rent.toFixed(2)} (tenancy record)`,
                                        `${rates.brma} ${entitled1Bed ? '1-bed' : 'room'} rate £${rate.toFixed(2)} a month (LHA Direct, Sep 2026)`,
                                        age != null ? `Age ${age} (DOB ${t.dob})` : (t.over35Confirmed && roomUnit ? '35 or over confirmed by Kevin (no date of birth on file yet)' : 'Age not needed for this unit type'),
                                        cap.exempt ? `Benefit cap: exempt (${tv.capExemption})` : `Benefit cap: ${cap.known ? 'not exempt' : 'exemption unknown'}; at £${rate.toFixed(2)} the housing element is £${cap.shortfall.toFixed(2)} short (cap £${capSingle.cap} less standard allowance £${capSingle.standard})`,
                                    ],
                                    needs: crfNeed,
                                    firstStep: `Meet ${t.name}: sign the rent change to £${rate.toFixed(2)}, report it in the UC journal${cap.exempt ? '' : ', submit the CRF Housing Payment form'}`,
                                    ...(tv.rentUplift === 'Done' ? { status: 'Done' } : {}),
                                }, planByKey));
                            }
                            const tc = tenancyFor(t.id, u);
                            const received = tc && tc.actual != null ? num(tc.actual) / Math.max(1, (tc.tenantIds || []).length) : null;
                            if (gap <= 0.5 && !notNeeded && received != null && received > 0 && rent - received > 10) {
                                const short = round2(rent - received);
                                tv.received = round2(received);
                                levers.push(lever({
                                    key: `topup:${t.id}`, lever: 'CRF top-up', propertyId: prop.id, property: prop.name, tenantId: t.id, tenant: t.name, unitId: u.id, unit: u.number,
                                    title: `${t.name}: £${received.toFixed(2)} received against £${rent.toFixed(2)} due; CRF Housing Payment for the gap`,
                                    monthly: short, monthlyIfExempt: short, oneOff: 0, effort: 'Paper', counted: 'now', capShortfall: short,
                                    evidence: [`Rent due £${rent.toFixed(2)} (tenancy record), latest amount received £${received.toFixed(2)} (Actual Rent rollup)`, `Gap £${short.toFixed(2)} a month: the benefit cap is taking the housing element down`, `${rates.brma} 1-bed rate £${rate.toFixed(2)}: the rent is already right`],
                                    needs: [`Apply for a CRF Housing Payment of £${short.toFixed(2)} a month paid to the landlord, or record the exemption if the UC statement shows one`],
                                    firstStep: `Meet ${t.name}: read the UC statement, submit the CRF Housing Payment form for £${short.toFixed(2)} a month`,
                                }, planByKey));
                            }
                            if (gap <= 0.5 && cap.known && !cap.exempt && cap.shortfall > 0) {
                                tv.note = `Capped: housing element £${cap.shortfall.toFixed(2)} short at this rent; CRF Housing Payment to apply for`;
                            } else if (!cap.exempt && cap.shortfall > 0 && !cap.known) {
                                tv.note = `Cap check: £${cap.shortfall.toFixed(2)} a month short unless exempt; CRF Housing Payment if not`;
                            }
                        }
                    }
                    uView.tenants.push(tv);
                    view.tenants.push(tv);
                });
                view.units.push(uView);
            });

            // EXTRA TENANTS (Kevin, 16 Sep 2026): worked out, never typed in. It is the lettable
            // rooms less the tenants living there, so correcting the lettable rooms corrects it.
            // The old typed-in "Planned Extra Tenants" disagreed with the rooms (5 Dalham Place:
            // 5 rooms, 4 tenants, typed 2) and is no longer read.
            const roomInfo = rentableRoomsFor(prop, pUnits);
            const extraTenants = Math.max(0, roomInfo.rooms - view.tenants.length);
            // A joint tenancy move already started on this house (see the interim move below).
            const interimRow = (() => { const r = planByKey[`ct:${prop.id}`]; return r && ['Adopted', 'In progress', 'Done'].includes(r.status) ? r : null; })();
            let interimJtDone = false;
            if (ours && rates) {
                // Kevin's strategy per house (Properties → Growth Strategy, 9 Sep 2026) decides
                // which of the two house levers applies. Joint tenancy: council tax to the
                // tenants, no extra tenant. Add tenants: fill the planned rooms, owner keeps
                // council tax. Hold: neither. Blank: both are shown as candidates to decide.
                const strategy = normaliseStrategy(prop.strategy);
                view.strategy = strategy;
                view.owner = prop.owner || '';
                const releasable = view.tenants.filter(t => t.unitType === 'Flat-Let' && t.uc && t.age != null && t.age >= 35);
                const spare = Math.max(0, lettableEff - roomsInUse);
                const computedLets = releasable.length + spare;
                const newLets = strategy === 'UC HMO' ? extraTenants : (strategy ? 0 : computedLets);
                const occupants = view.tenants.length;
                if (newLets > 0) {
                    const capNew = capPosition('Unknown', rates.b1, settings);
                    const utilities = prop.payg === 'No' ? s('utilities_per_tenant', 75) : 0; // bills sit with the tenants unless Kevin has taken them on
                    const ctExtra = ownerPaysCt ? 0 : ctMonthly; // becoming a shared house makes the owner liable
                    const gross = newLets * rates.b1;
                    const net = round2(gross - newLets * utilities - ctExtra);
                    const evidence = [
                        strategy === 'UC HMO' ? `Kevin's strategy: UC HMO, add ${newLets} tenant${newLets > 1 ? 's' : ''} here` : `Rooms in use ${roomsInUse} of ${lettableEff} lettable${lettable == null ? ' (lettable rooms not set — using rooms in use)' : ''}`,
                        releasable.length ? `${releasable.map(t => `${t.name} (${t.age})`).join(', ')} hold a two-room flat-let each and keep the 1-bed rate in one room` : 'No flat-let to shrink',
                        `New let at £${rates.b1.toFixed(2)} (1-bed rate); a capped tenant is £${capNew.shortfall.toFixed(2)} short, covered by a CRF Housing Payment or by choosing an exempt tenant`,
                        utilities ? `Utilities £${utilities} per new tenant (you have taken the bills on)` : 'Bills stay with the tenants (PAYG)',
                        ctExtra ? `Council tax £${ctMonthly.toFixed(2)} a month falls on the owner once the house is shared` : `Council tax already with the owner (£${ctMonthly.toFixed(2)})`,
                    ];
                    const needs = [];
                    if (!strategy) needs.push('Set Growth Strategy on this house (Add tenants / Joint tenancy / Hold)');
                    if (strategy === 'UC HMO' && lettable != null && lettableEff < roomsInUse + newLets - releasable.length) needs.push(`Lettable rooms (${lettableEff}) do not fit ${occupants + newLets} tenants`);
                    if (occupants + newLets >= 5) needs.push(`${occupants + newLets} occupants: mandatory HMO licence (5+ people)`);
                    levers.push(lever({
                        key: `rooms:${prop.id}`, lever: releasable.length ? 'Room release' : 'New room let', propertyId: prop.id, property: prop.name,
                        releasableIds: releasable.map(t => t.id),
                        title: `${prop.name}: ${newLets} more room${newLets > 1 ? 's' : ''} let to over-35 UC tenants`,
                        monthly: net, monthlyIfExempt: net, oneOff: round2(newLets * s('room_prep_cost', 1500)), effort: 'Works', counted: strategy ? (local ? 'now' : 'remote') : 'check',
                        capShortfall: round2(newLets * capNew.shortfall),
                        count: newLets, evidence, needs,
                        firstStep: releasable.length ? `Agree with ${releasable[0].name} to move to one room at the same rent, then fire-safe the freed room` : 'Fire-safe the spare room (door, alarm, lock) and list it',
                    }, planByKey));
                }
                // Stage 2: council tax. Two tenants on one joint agreement makes them liable.
                if (occupants === 2 && view.tenants.every(t => t.uc || t.hb) && prop.ctPayer !== 'Tenants' && strategy !== 'UC HMO' && strategy !== 'Leave as is') {
                    // Only council tax Kevin pays TODAY counts as a saving (a live Costs row, which the bank
                    // feed reconciles). Where nothing is paid, the joint tenancy is protection: it stops the
                    // owner being billed for a house let by the room, and the row shows £0.
                    // Kevin, 9 Sep 2026: even where nothing is paid today the owner is liable for a room-by-room
                    // let until the joint tenancy and a backdated Council Tax Reduction are in place, so the
                    // band figure counts as potential income. A live cost row (bank-fed) wins where one exists.
                    const ctBasis = ctLive || ctBandMonthly;
                    const residual = round2(ctBasis * s('ct_residual_pct', 0) / 100);
                    const credit = round2(residual * s('ct_credit_share', 100) / 100);
                    const saving = round2(ctBasis - credit);
                    levers.push(lever({
                        key: `ct:${prop.id}`, lever: 'Council tax', propertyId: prop.id, property: prop.name,
                        title: `${prop.name}: joint tenancy for ${view.tenants.map(t => t.name).join(' and ')}, council tax moves to them`,
                        monthly: saving, monthlyIfExempt: saving, oneOff: 0, effort: 'Paper',
                        counted: strategy === 'UC joint tenancy' ? 'now' : 'check', alternative: !strategy && newLets > 0,
                        evidence: [ctLive ? `Council tax paid by you today: £${ctLive.toFixed(2)} a month (live cost, bank-fed)` : (ctBandMonthly ? `Band ${prop.ctBand || '?'}: £${num(prop.ctAnnual).toFixed(2)} a year = £${ctBandMonthly.toFixed(2)} a month. Nothing paid today (bank feed Jun 2025 to Sep 2026) but the owner is liable for a room-by-room let until the joint tenancy and a backdated Council Tax Reduction are in place, so it counts` : 'No council tax figure on this house: set Council Tax Band and Council Tax Annual on the property'),
                            strategy === 'UC joint tenancy' ? "Kevin's strategy: joint tenancy, no extra tenant here" : 'No strategy set: shown as a candidate',
                            'One agreement of 6+ months for the whole house makes the tenants liable (SI 2023/1175)',
                            'Each joint renter keeps their own 1-bed LHA up to their share, so rent is unchanged',
                            `Tenants claim Council Tax Reduction on the Anglia Revenues online form (up to 100% for a working-age household on UC and not working), which the signed authority lets Roy or Kevin submit`],
                        needs: ['Joint tenancy agreement from ast_joint_template.md', 'Council Tax Reduction claim for the tenants at the same meeting, backdated to the tenancy start', 'Tell the council the liability has changed'],
                        firstStep: `Prepare the joint tenancy agreement for ${prop.name}, then book the tenant meeting`,
                    }, planByKey));
                } else if (strategy === 'UC HMO' && occupants === 2 && extraTenants > 0 && interimRow) {
                    // Kevin, 16 Sep 2026 (14 Wentworth Terrace): a house planned as a UC HMO still signs its
                    // two tenants onto a joint tenancy first, to take the council tax off us to date. It comes
                    // back to us when the third tenant moves in, so the move adds nothing to the plan. Only a
                    // move already started is kept, so no other two-tenant house grows a new candidate.
                    const names = view.tenants.map(t => t.name).join(' and ');
                    levers.push(lever({
                        key: `ct:${prop.id}`, lever: 'Council tax', propertyId: prop.id, property: prop.name, interim: true,
                        title: `${prop.name}: joint tenancy for ${names}, clears the council tax to date`,
                        monthly: 0, monthlyIfExempt: 0, oneOff: 0, effort: 'Paper', counted: 'now',
                        evidence: [`A step before the third tenant: while ${names} are the only tenants, the joint tenancy takes the council tax off us`,
                            'It comes back to us when the third tenant moves in, so it adds nothing to the plan',
                            'One agreement of 6+ months for the whole house makes the tenants liable (SI 2023/1175)'],
                        needs: ['Joint tenancy agreement from ast_joint_template.md', 'Tell the council the liability has changed, backdated to the tenancy start'],
                        firstStep: `Sign ${names} onto one joint tenancy for ${prop.name}, then tell the council`,
                    }, planByKey));
                    interimJtDone = interimRow.status === 'Done';
                } else if (ownerPaysCt && occupants >= 3) {
                    view.flags.push(`Council tax stays with the owner while ${occupants} tenants are let by the room`);
                }
                // Stage 4: voids
                pUnits.filter(u => u.status === 'Void').forEach(u => {
                    const marketKey = 'void_rent_' + String(prop.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
                    const fallback = /siddows/i.test(prop.name) ? s('siddows_market_rent', 850) : (rates.b3 || rates.b1);
                    const rent = s(marketKey, fallback);
                    const ctSaving = ownerPaysCt ? ctMonthly : 0;
                    levers.push(lever({
                        key: `void:${u.id}`, lever: 'Void let', propertyId: prop.id, property: prop.name, unitId: u.id, unit: u.number,
                        title: `${prop.name}: let the void${/siddows/i.test(prop.name) ? ' to a family at market rent' : ''}`,
                        monthly: round2(rent + ctSaving), monthlyIfExempt: round2(rent + ctSaving), oneOff: 0, effort: 'Light', counted: local ? 'now' : 'remote',
                        evidence: [`Unit ${u.number} is Void (rental unit status)`, `Rent assumption £${rent.toFixed(2)} a month (settings)`, ctSaving ? `Council tax £${ctSaving.toFixed(2)} stops when a tenant moves in` : 'Council tax not currently with the owner'],
                        needs: ['Confirm the asking rent against local listings'],
                        firstStep: `List ${prop.name} on OpenRent at £${rent.toFixed(2)}`,
                    }, planByKey));
                });
            }
            if (mgmt === 'collins') {
                const margin = s('collins_margin_per_property', 250);
                levers.push(lever({
                    key: `takeback:${prop.id}`, lever: 'Take-back', propertyId: prop.id, property: prop.name,
                    title: `${prop.name}: take back from the Collins head lease`,
                    monthly: margin, monthlyIfExempt: margin, oneOff: 0, effort: 'Legal', counted: 'now',
                    evidence: [`Rent received now £${propRent.toFixed(2)} (live tenancies)`, `Margin on take-back £${margin} a month (Kevin, 9 Sep 2026)`],
                    needs: ['Q4 only, after the legal question set comes back (ruling 31 Jul 2026)', 'Say nothing to Collins or the sub-tenants until then'],
                    firstStep: 'Check the legal question set on approaching sub-tenants has an answer',
                }, planByKey));
            }
            const leaveAsIs = ours && normaliseStrategy(prop.strategy) === 'Leave as is';
            // A promoted property is ours now, so it is no longer priced as agent-held potential.
            if (((!ours && (mgmt === 'rocimmo' || mgmt === 'agent')) || leaveAsIs) && rates) {
                // Kevin, 9 Sep 2026: what each property outside the plan could bring at the 1-bed rate.
                // Lettable Rooms of 3+ = an HMO of over-35s (rooms × 1-bed); a 1-bed home = one tenant;
                // a block = per flat (two in a 2-bed, one in a 1-bed); anything else = a joint tenancy of two.
                const flats = prop.type === 'Block' ? pUnits.filter(u => u.type === 'Flat') : [];
                const roomsCap = lettable != null && lettable >= 3 ? lettable : 0;
                let potentialRent, how;
                if (flats.length) {
                    potentialRent = round2(flats.reduce((n, f) => n + (num(f.beds) >= 2 ? 2 : 1) * rates.b1, 0));
                    how = `${flats.filter(f => num(f.beds) >= 2).length} two-bed flats × 2 × £${rates.b1.toFixed(2)} + ${flats.filter(f => num(f.beds) < 2).length} one-bed flats × £${rates.b1.toFixed(2)}`;
                } else if (roomsCap) {
                    potentialRent = round2(roomsCap * rates.b1);
                    how = `${roomsCap} rentable rooms × £${rates.b1.toFixed(2)} (HMO of over-35s)`;
                } else if (num(prop.beds) === 1) {
                    potentialRent = round2(rates.b1);
                    how = `one tenant × £${rates.b1.toFixed(2)} (1-bed home)`;
                } else {
                    potentialRent = round2(2 * rates.b1);
                    how = `joint tenancy of two × £${rates.b1.toFixed(2)}`;
                }
                // A void house is compared against what the plan lets it for (the void lever), not its old rent.
                const voidHere = pUnits.some(u => u.status === 'Void');
                const voidLever = voidHere ? levers.find(l => l.propertyId === prop.id && l.lever === 'Void let') : null;
                const baseline = voidLever ? voidLever.monthly : propRent;
                const potential = round2(potentialRent - baseline);
                levers.push(lever({
                    key: `agent:${prop.id}`, lever: 'Agent-held', propertyId: prop.id, property: prop.name,
                    title: `${prop.name}: ${leaveAsIs ? 're-let' : 'take back and let'} to over-35 UC tenants at the 1-bed rate (${roomsCap ? roomsCap + ' rooms' : flats.length ? flats.length + ' flats' : num(prop.beds) === 1 ? 'one tenant' : 'joint tenancy of two'})`,
                    monthly: potential, monthlyIfExempt: potential, oneOff: 0, effort: 'Legal', counted: 'agent',
                    evidence: [voidLever ? `Void: the plan lets it to a family at £${voidLever.monthly.toFixed(2)} a month, so that is the comparison` : `Rent now £${propRent.toFixed(2)} a month${ours ? '' : ' via ' + (prop.agent || 'the agent')}`, `${how} (${rates.brma} 1-bed) = £${potentialRent.toFixed(2)} a month, before council tax and management`, potential < 0 ? 'The current rent is higher than the LHA figure: no gain' : (roomsCap ? 'Council tax and licensing would sit with the owner as an HMO' : 'Council tax would sit with the tenants')],
                    needs: ['Potential only: no action generated'],
                    firstStep: 'None: potential only',
                }, planByKey));
            }
            // ── The four strategies, priced for this property ──────────────
            const ctInfo = councilTaxFor(prop, ctLive, bandByCouncil[councilFor(prop.postcode)] || '');
            const market = marketRentFor(prop, rates, settings);
            const strategies = priceStrategies(prop, pUnits, rates, settings, ctInfo, roomInfo, market);
            // Review fix, 16 Sep 2026: the units cannot tell a joint tenancy from two room lets
            // (both are flat-lets or rooms). Council Tax Payer = Tenants on a house of one or two
            // tenants is the record saying it is already a joint tenancy, so "Leave as is" holds
            // it as one and the paperwork rule decides the council tax, instead of charging us.
            const unitCurrent = currentStrategyOf(prop, pUnits);
            const statedJoint = unitCurrent === 'UC HMO' && prop.ctPayer === 'Tenants' && view.tenants.length > 0 && view.tenants.length <= 2;
            const current = statedJoint ? 'UC joint tenancy' : unitCurrent;
            const selfManaged = isSelfManaged(prop);
            // Kevin's Growth Strategy field is the TARGET. "Leave as is" holds the property
            // exactly where it is, income included, so it is never priced off the LHA table.
            const rawTarget = normaliseStrategy(prop.strategy);
            const holdFlat = rawTarget === 'Leave as is';
            const chosen = holdFlat ? current : (selfManaged ? (rawTarget || '') : '');
            const byName = {}; strategies.forEach(x => { byName[x.name] = x; });
            const chosenRow = byName[chosen] || null;
            const voids = pUnits.filter(u => u.status === 'Void').length;
            const occupiedUnits = pUnits.filter(u => u.status !== 'Void').length;
            const tenantCount = view.tenants.length;
            const b1 = rates ? rates.b1 : 0;

            // RENT NOW is a forecast (Kevin, 16 Sep 2026): the rent on the record, plus every
            // uplift ticked Done. The higher of the two is taken per tenant, so once Roy updates
            // the tenancy record to the new rate the uplift is not counted twice.
            const upliftsDone = round2(view.tenants.filter(t => t.rentUplift === 'Done').reduce((n, t) => n + num(t.upliftGap), 0));
            const upliftsToDo = round2(view.tenants.filter(t => t.rentUplift !== 'Done' && t.rentUplift !== 'Not needed').reduce((n, t) => n + num(t.upliftGap), 0));
            // Review fix, 16 Sep 2026: an empty unit still carries the Expected Rent of the tenancy
            // that ended, a placeholder nobody pays. Counting it as rent now held 18 Siddows Avenue
            // (empty) at £499.70, so picking Single let showed +£175.30 instead of +£675, and a
            // placeholder above market would have been planned as if collected.
            const voidRent = round2(pUnits.filter(u => u.status === 'Void').reduce((n, u) => n + unitRent(u), 0));
            const occupiedRent = round2(propRent - voidRent);
            const rentNowForecast = round2(occupiedRent + upliftsDone);

            // COUNCIL TAX NOW (Kevin, 16 Sep 2026). On a property we run, it is OURS unless the
            // property is a single let today, or a joint tenancy where EVERY tenant has the
            // correct agreement ticked. An explicit "Owner" payer on a single let means we took
            // the bills on. On an agent-run property we only know what the bank shows we pay.
            // The interim joint tenancy on a UC HMO house counts once its move is marked Done: the
            // council tax is the tenants' until the third tenant moves in (Kevin, 16 Sep 2026).
            const jtDocumented = (chosen === 'UC joint tenancy' && tenantCount > 0 && view.tenants.every(t => t.correctAgreement)) || interimJtDone;
            const singleLetTenantPays = current === 'Single let' && prop.ctPayer !== 'Owner';
            // Kevin, 16 Sep 2026: a property with nobody in it is OURS for council tax until a
            // tenant moves in, whatever it is let as. 18 Siddows Avenue read £0 as a "single let"
            // while empty; its renovation exemption is ending, so the liability is shown as ours.
            const emptyNow = pUnits.length > 0 && occupiedUnits === 0;
            // Kevin, 16 Sep 2026: serviced accommodation puts the council tax on us, whoever runs
            // it. The bank feed shows nothing paid on 22 Newton Street or Duckworth apartments 1
            // and 2, so it is counted from the band: the safer, lower "left for us".
            const saNow = current === 'Serviced accommodation';
            const ctLiableNow = saNow || (selfManaged ? (emptyNow || !(singleLetTenantPays || jtDocumented)) : ctLive > 0);
            const ctAmount = ctInfo.monthly == null ? 0 : ctInfo.monthly;
            const ctNow = ctLiableNow ? round2(ctAmount) : 0;
            // Review fix, 16 Sep 2026: an unknown council tax still has to be ADDED UP as something,
            // so it counts as £0 in the sums, but every figure it touches carries a flag and the
            // page names the property. A silent £0 made the ceiling look bigger than it is.
            const ctNowUnknown = ctLiableNow && ctInfo.monthly == null;
            // What we were liable for BEFORE any joint tenancy paperwork was ticked: the starting
            // point. Reading ctNow instead would erase a saving ticked before the freeze, the same
            // way reading the forecast rent would erase an uplift.
            const liableBeforeTicks = saNow || (selfManaged ? (emptyNow || !singleLetTenantPays) : ctLive > 0);
            const ctBeforeTicks = liableBeforeTicks ? round2(ctAmount) : 0;
            const ctBeforeTicksUnknown = liableBeforeTicks && ctInfo.monthly == null;
            const ctNowWhy = saNow ? 'Serviced accommodation, so the council tax is ours'
                : !selfManaged
                ? (ctLive > 0 ? `We pay £${money(ctLive)} a month on this agent-run property (bank-fed cost row)` : 'The agent or tenant carries it: nothing in the bank feed')
                : emptyNow ? 'Empty, so the council tax is ours until a tenant moves in'
                : interimJtDone ? 'The joint tenancy is signed, so the council tax is theirs until the third tenant moves in'
                : jtDocumented ? 'Every tenant has signed the joint agreement, so the council tax is theirs'
                : singleLetTenantPays ? 'A single let: the tenant pays the council tax'
                : chosen === 'UC joint tenancy' ? `Ours until every tenant's correct tenancy agreement is ticked (${view.tenants.filter(t => t.correctAgreement).length} of ${tenantCount} so far)`
                : 'Let by the room, so the council tax is ours';

            // PLAN DONE: where this property lands once the plan picked for it is finished.
            let planRent = rentNowForecast, planCt = ctNow, planWhy = 'No plan picked: held where it is';
            let newPlaces = null;   // extra lets the plan adds; null means "use the strategy's own count"
            let planCtUnknown = ctNowUnknown;
            if (holdFlat) { planWhy = 'Leave as is: rent and council tax held exactly where they are'; }
            else if (chosen && chosenRow) {
                const newLets = extraTenants;
                if (chosen === 'UC HMO' && current === 'UC HMO') {
                    newPlaces = newLets;
                    // An empty unit's record rent is a placeholder already inside rent now. Every empty
                    // room is priced at the 1-bed rate below, so the placeholder comes out first or the
                    // same room would be counted twice.
                    planRent = round2(rentNowForecast + upliftsToDo + newLets * b1);   // empty rooms are in newLets, not in rent now
                    planCt = ctInfo.monthly == null ? ctNow : round2(ctInfo.monthly);
                    planCtUnknown = ctInfo.monthly == null;
                    planWhy = `${roomInfo.rooms} lettable room${roomInfo.rooms === 1 ? '' : 's'} less ${tenantCount} tenant${tenantCount === 1 ? '' : 's'} = ${newLets} more tenant${newLets === 1 ? '' : 's'} at £${money(b1)}, plus the uplifts still to do; we keep the council tax`;
                } else if (chosen === 'UC joint tenancy' && tenantCount > 0 && tenantCount <= 2) {
                    newPlaces = Math.max(0, 2 - occupiedUnits);
                    planRent = round2(rentNowForecast + upliftsToDo);
                    planCt = 0;
                    planCtUnknown = false;
                    planWhy = 'Same tenants on one joint agreement: their rents stay, and the council tax moves to them';
                } else if (chosen === 'Single let' && current === 'Single let') {
                    // Kevin, 16 Sep 2026: picking Single let on 15 Marloes Court (£237 now, £950 market)
                    // showed "no change", because a same-strategy plan only added uplifts. A single let's
                    // uplift IS the market rent. The higher of the two, so a rent already above market
                    // (22 Newton Street, £1,800 against £752) is never planned downwards.
                    newPlaces = 0;
                    const ownerPays = prop.ctPayer === 'Owner';
                    planRent = round2(Math.max(rentNowForecast, market.rent));
                    planCt = ownerPays ? round2(ctAmount) : 0;
                    planCtUnknown = ownerPays && ctInfo.monthly == null;
                    const whoPays = ownerPays
                        ? (ctInfo.monthly == null ? 'we pay the council tax, amount not known' : `we pay the council tax (£${money(ctAmount)} a month)`)
                        : 'the tenant pays the council tax';
                    const nowWords = rentNowForecast > 0 ? `against £${money(rentNowForecast)} now` : 'and it is empty now';
                    planWhy = !(market.rent > 0)
                        ? `No open-market rent is known for this property, so it is held at £${money(rentNowForecast)}; ${whoPays}`
                        : market.rent > rentNowForecast
                            ? `Let at the open-market rent of £${money(market.rent)} (${market.source}), ${nowWords}; ${whoPays}`
                            : `Already at or above the open-market rent (£${money(market.rent)}), so held at £${money(rentNowForecast)}; ${whoPays}`;
                } else if (chosen === current) {
                    newPlaces = 0;
                    planRent = round2(rentNowForecast + upliftsToDo);
                    planCt = chosenRow.councilTax == null ? ctNow : round2(chosenRow.councilTax);
                    planCtUnknown = chosenRow.councilTax == null;
                    planWhy = chosen === 'Serviced accommodation'
                        ? `Stays serviced accommodation at £${money(planRent)} a month; we pay the council tax`
                        : 'Same strategy, with the uplifts still to do';
                } else {
                    planRent = round2(chosenRow.gross);
                    planCt = chosenRow.councilTax == null ? 0 : round2(chosenRow.councilTax);
                    planCtUnknown = chosenRow.councilTax == null;
                    planWhy = `Re-let as a ${chosen}: ${chosenRow.how}`;
                }
            }

            // BEST POSSIBLE: the ceiling. Whichever leaves the most, out of where it is now, the
            // plan picked, and each of the four strategies. Never below where it already is.
            const options = [{ name: 'Where it is now', rent: rentNowForecast, ct: ctNow, ctUnknown: ctNowUnknown },
                { name: 'The plan picked', rent: planRent, ct: planCt, ctUnknown: planCtUnknown }]
                .concat(strategies.filter(x => !x.na).map(x => ({ name: x.name, rent: x.gross, ct: x.councilTax == null ? 0 : x.councilTax, ctUnknown: x.councilTax == null })));
            const bestOpt = options.slice().sort((a, b) => (b.rent - b.ct) - (a.rent - a.ct))[0];
            const best = strategies.filter(x => !x.na).slice().sort((a, b) => b.net - a.net)[0] || strategies[0];

            const unitsPlanned = holdFlat || !chosenRow ? occupiedUnits
                : newPlaces != null ? occupiedUnits + newPlaces : chosenRow.units;
            Object.assign(view, {
                strategies, strategyBy: byName, current, chosen, target: rawTarget, best, leaveAsIs: holdFlat,
                chosenRow, ct: ctInfo, roomInfo, market,
                unitsNow: occupiedUnits, unitsPlanned, unitsExtra: Math.max(0, unitsPlanned - occupiedUnits),
                voids, tenantCount,
                recordRent: occupiedRent, voidRent,
                rentNow: rentNowForecast, upliftsDone, upliftsToDo,
                ctNow, ctLiableNow, ctNowWhy, jtDocumented,
                planRent: round2(planRent), planCt: round2(planCt), planWhy,
                bestRent: round2(bestOpt.rent), bestCt: round2(bestOpt.ct), bestWhy: bestOpt.name,
                ctNowUnknown, planCtUnknown, bestCtUnknown: !!bestOpt.ctUnknown,
                ctBeforeTicks, ctBeforeTicksUnknown, statedJoint, extraTenants, emptyNow,
                // Extra tenants only moves the plan for a UC HMO that is not being held as it is.
                extraTenantsApplies: !holdFlat && (chosen === 'UC HMO' || (!chosen && current === 'UC HMO')),
                extraTenantsWhy: holdFlat ? 'Leave as is holds it' : (chosen && chosen !== 'UC HMO') ? `only counts for a UC HMO, and the plan is ${chosen}` : (!chosen && current !== 'UC HMO') ? 'only counts for a UC HMO' : '',
                leftNow: round2(rentNowForecast - ctNow),
                leftPlan: round2(planRent - planCt),
                leftBest: round2(bestOpt.rent - bestOpt.ct),
                netPlanned: round2(planRent - planCt),
                upliftChosen: chosen ? round2((planRent - planCt) - (rentNowForecast - ctNow)) : null,
                upliftBest: round2((bestOpt.rent - bestOpt.ct) - (rentNowForecast - ctNow)),
                checklist: selfManaged ? (CHECKLIST[chosen] || null) : null,
                // Kevin, 16 Sep 2026: the split reads the PROPERTY, never a tenant's pay type.
                // Simon Collins is not an agent, and a ticked "Moving to self-manage" promotes
                // an agent-run property into our list with everything that comes with it.
                selfManaged, movingToSelfManage: !!prop.movingToSelfManage,
                // An apartment shown on its own row: its plan and frozen start save to its Rental Units record.
                unitRecord: !!prop.unitRecord, parentId: prop.parentId || null, parentName: prop.parentName || '',
                // One rental unit (a whole-house let, or an apartment): how it is let today can be set on the page.
                soleUnitId: pUnits.length === 1 ? pUnits[0].id : null,
                lettingStated: pUnits.length === 1 ? normaliseStrategy(pUnits[0].lettingStrategy) : '',
                baselineRent: prop.baselineRent == null ? null : num(prop.baselineRent),
                baselineCt: prop.baselineCt == null ? null : num(prop.baselineCt),
                baselineDate: prop.baselineDate || '',
            });
            properties.push(view);
        });

        // Rank: money per unit of effort, then money.
        levers.forEach(l => { l.score = round2(l.monthly / (EFFORT_WEIGHT[l.effort] || 1)); });
        const active = l => l.status !== 'Dropped' && l.status !== 'Done';
        levers.sort((a, b) => (a.counted === 'agent') - (b.counted === 'agent') || a.stage - b.stage || b.score - a.score || b.monthlyIfExempt - a.monthlyIfExempt);
        // An either/or council tax lever only counts when it beats the rooms lever on the same house.
        levers.filter(l => l.alternative).forEach(ct => {
            const rooms = levers.find(r => r.propertyId === ct.propertyId && (r.lever === 'Room release' || r.lever === 'New room let'));
            if (!rooms) return;
            if (rooms.monthly >= ct.monthly) { ct.counted = 'alternative'; ct.loser = true; }
            else { rooms.counted = 'alternative'; rooms.loser = true; }
        });
        const ownerByProperty = {}; properties.forEach(v => { if (v.owner) ownerByProperty[v.id] = v.owner; });
        levers.forEach(l => { l.owner = taskOwnerFor(l, ownerByProperty); });
        properties.forEach(v => { v.levers = levers.filter(l => l.propertyId === v.id); });
        const sum = (arr, f) => round2(arr.reduce((n, l) => n + (f ? f(l) : l.monthly), 0));
        const now = levers.filter(l => l.counted === 'now' && active(l));
        const totals = {
            rentNow: round2(rentNow),
            paper: sum(now.filter(l => STAGE[l.lever] <= 2)),
            works: sum(now.filter(l => STAGE[l.lever] === 3)),
            voids: sum(now.filter(l => STAGE[l.lever] === 4)),
            remote: sum(levers.filter(l => l.counted === 'remote' && active(l))),
            remoteWorks: sum(levers.filter(l => l.counted === 'remote' && active(l) && STAGE[l.lever] === 3)),
            remoteVoids: sum(levers.filter(l => l.counted === 'remote' && active(l) && STAGE[l.lever] === 4)),
            exemptUpside: sum(levers.filter(l => l.counted !== 'agent' && active(l)), l => Math.max(0, l.monthlyIfExempt - l.monthly)),
            unknownAge: round2(unknownAge.reduce((n, u) => n + u.upliftIfOver35, 0)),
            crfShortfall: sum(levers.filter(l => l.counted !== 'agent' && active(l)), l => num(l.capShortfall)),
            crfCount: levers.filter(l => l.counted !== 'agent' && active(l) && num(l.capShortfall) > 0).length,
            check: sum(levers.filter(l => l.counted === 'check' && active(l))),
            agentHeld: sum(levers.filter(l => l.counted === 'agent' && l.monthly > 0)),
            done: sum(levers.filter(l => l.status === 'Done')),
            oneOff: sum(now, l => l.oneOff),
        };
        totals.actionable = round2(totals.paper + totals.works + totals.voids + totals.remote);
        totals.potentialIncrease = round2(totals.actionable + totals.agentHeld); // ages to confirm are already inside the paper trail
        totals.maximum = round2(totals.potentialIncrease + totals.check);

        // ── Progress (Kevin, 16 Sep 2026) ────────────────────────────────────
        // Forecast only. The leadership dashboard owns the actual cash; this page answers
        // "have we done everything needed to get the money coming in?". A tick moves money
        // from "could" to "now". Done is Realised, even though the money lags behind.
        properties.forEach(v => {
            const mine = levers.filter(l => l.propertyId === v.id);
            const running = mine.filter(l => l.status === 'Adopted' || l.status === 'In progress');
            v.runningCount = running.length;
            const upliftsOpen = v.tenants.filter(t => t.rentUplift !== 'Done' && t.rentUplift !== 'Not needed' && t.upliftGap > 0).length;
            const jtConversion = v.chosen === 'UC joint tenancy' && v.tenantCount > 0 && v.tenantCount <= 2;
            const strategySettled = v.leaveAsIs || v.chosen === v.current || (jtConversion && v.jtDocumented);
            const didWork = v.upliftsDone > 0 || v.jtDocumented;
            // Kevin, 16 Sep 2026: "No change needed" while the plan still adds money was wrong
            // (15 Marloes Court £237 planned to £950; 55 Elmdon Place with two tenants to add).
            // Settled means the plan adds nothing more to what is left for us.
            const planStillAdds = num(v.upliftChosen) > 0.5;
            v.upliftsOpenCount = upliftsOpen;
            if (!v.selfManaged) v.progress = 'Agent-run';
            else if (!v.chosen) v.progress = 'Not decided';
            else if (v.leaveAsIs) v.progress = 'No change needed';
            else if (strategySettled && !upliftsOpen && !planStillAdds) v.progress = didWork ? 'Realised' : 'No change needed';
            else if (running.length) v.progress = 'In progress';
            else v.progress = 'To do';
        });
        const selfManaged = properties.filter(v => v.selfManaged);
        const agentManaged = properties.filter(v => !v.selfManaged);

        // Review fix, 16 Sep 2026: when a lever stops being generated (a tenant set to "Not
        // needed", a record updated, a tenant moved out) its Growth Plan row can still be Adopted
        // or In progress. Nothing rendered it, so nothing could close it. Each such row is now
        // pinned to its property by the id in its key, and the page offers a Drop.
        const liveKeys = new Set(levers.map(l => l.key));
        const tenantProp = {}, unitProp = {};
        units.forEach(u => { unitProp[u.id] = u.propertyId; (u.tenantIds || []).forEach(id => { tenantProp[id] = u.propertyId; }); });
        // A row keyed to a block that is now split sits on its lowest-numbered apartment, so it can still be dropped.
        const blockProp = {};
        units.filter(u => u.blockId).sort((a, b) => num(a.number) - num(b.number)).forEach(u => { if (!blockProp[u.blockId]) blockProp[u.blockId] = u.propertyId; });
        const propIds = new Set(properties.map(v => v.id));
        const stranded = (data.planRows || [])
            .filter(r => r.key && !liveKeys.has(r.key) && (r.status === 'Adopted' || r.status === 'In progress'))
            .map(r => {
                const ref = String(r.key).split(':').slice(1).join(':');
                return { id: r.id, key: r.key, status: r.status, title: r.title || r.key, taskIds: r.taskIds || [],
                    propertyId: propIds.has(ref) ? ref : (tenantProp[ref] || unitProp[ref] || blockProp[ref] || null) };
            });
        properties.forEach(v => { v.strandedRows = stranded.filter(r => r.propertyId === v.id); });
        totals.strandedRows = stranded;

        // The grid: rent, council tax and what is left, in four columns.
        const column = pick => {
            const rent = round2(properties.reduce((n, v) => n + num(pick(v).rent), 0));
            const ct = round2(properties.reduce((n, v) => n + num(pick(v).ct), 0));
            const ctUnknown = properties.filter(v => pick(v).ctUnknown).map(v => v.name);
            return { rent, ct, left: round2(rent - ct), ctUnknown };
        };
        // Where we started is frozen once. Until a property has its snapshot it reads as
        // today, and the grid says so rather than inventing a starting point.
        totals.startedFrozen = properties.length > 0 && properties.every(v => v.baselineRent != null && v.baselineCt != null);
        // Only the MISSING figures, so freezing never overwrites a starting point already saved.
        totals.toFreeze = properties.filter(v => v.baselineRent == null || v.baselineCt == null).map(v => ({
            id: v.id, name: v.name, unitRecord: v.unitRecord,
            rent: v.baselineRent == null ? v.recordRent : null,
            ct: v.baselineCt == null ? v.ctBeforeTicks : null,
            date: v.baselineDate ? null : T,
        }));
        totals.grid = {
            // Unfrozen, "started" is the rent on the RECORD, which is the rent before any uplift
            // ticked Done here. Reading the forecast instead would make every uplift already done
            // vanish from the journey, since started and now would match.
            started: column(v => ({ rent: v.baselineRent == null ? v.recordRent : v.baselineRent, ct: v.baselineCt == null ? v.ctBeforeTicks : v.baselineCt, ctUnknown: v.baselineCt == null && v.ctBeforeTicksUnknown })),
            now: column(v => ({ rent: v.rentNow, ct: v.ctNow, ctUnknown: v.ctNowUnknown })),
            plan: column(v => ({ rent: v.planRent, ct: v.planCt, ctUnknown: v.planCtUnknown })),
            best: column(v => ({ rent: v.bestRent, ct: v.bestCt, ctUnknown: v.bestCtUnknown })),
        };
        totals.rentNow = totals.grid.now.rent;
        totals.upliftsDone = round2(properties.reduce((n, v) => n + num(v.upliftsDone), 0));
        totals.upliftsToDo = round2(properties.reduce((n, v) => n + num(v.upliftsToDo), 0));
        totals.notDecided = selfManaged.filter(v => v.progress === 'Not decided').length;
        totals.chosenUplift = round2(totals.grid.plan.left - totals.grid.now.left);
        totals.bestUplift = round2(totals.grid.best.left - totals.grid.now.left);
        totals.unitsNow = properties.reduce((n, v) => n + num(v.unitsNow), 0);
        totals.unitsPlanned = properties.reduce((n, v) => n + num(v.unitsPlanned), 0);
        totals.unitsExtra = properties.reduce((n, v) => n + num(v.unitsExtra), 0);
        // NOT totals.voids: that name is already the MONEY bucket for void lets and
        // take-backs further up, and overwriting it silently zeroed the actionable figure.
        totals.voidUnits = properties.reduce((n, v) => n + num(v.voids), 0);
        totals.tenants = properties.reduce((n, v) => n + num(v.tenantCount), 0);
        const next = levers.find(l => l.counted === 'now' && active(l) && l.status !== 'In progress') || levers.find(l => l.counted === 'now' && active(l)) || null;
        const todo = levers.filter(l => (l.counted === 'now' || l.counted === 'remote') && active(l)).map(l => ({ key: l.key, stage: l.stage, text: l.firstStep, owner: l.owner, property: l.property, monthly: l.monthly, status: l.status }));
        const packs = buildPacks(properties, levers, active);
        return { today: T, levers, properties, selfManaged, agentManaged, unknownAge, totals, next, todo, packs, safeSingle, capSingle, lhaStale: lhaStale(T), stageNames: STAGE_NAMES, stageOf: l => STAGE[l.lever] || 5 };
    }

    // ── Property work packs ─────────────────────────────────────────────
    // Kevin, 10 Sep 2026: the plan is worked property by property, not tenant by
    // tenant, so one visit closes a whole house. Each pack is everything Roy (or
    // Kevin) needs for that address: what to take, what happens with each tenant,
    // what works are needed, what is submitted afterwards.
    function buildPacks(properties, levers, active) {
        const packs = [];
        properties.forEach(v => {
            const all = levers.filter(l => l.propertyId === v.id && (l.counted === 'now' || l.counted === 'remote'));
            const own = all.filter(active);
            const decide = levers.filter(l => l.propertyId === v.id && active(l) && (l.counted === 'check' || l.counted === 'alternative'))
                .map(l => ({ key: l.key, lever: l.lever, stage: l.stage, title: l.title, monthly: l.monthly, counted: l.counted, needs: l.needs, evidence: l.evidence }));
            if (!all.length && !decide.length) return;
            const joint = v.strategy === 'UC joint tenancy' && own.some(l => l.lever === 'Council tax');
            const roomLever = own.find(l => l.lever === 'Room release' || l.lever === 'New room let');
            const takeBack = own.find(l => l.lever === 'Take-back');
            const voidLet = own.find(l => l.lever === 'Void let');
            const names = v.tenants.map(t => t.name);

            const before = [];
            if (joint) {
                before.push('Joint tenancy agreement for the whole house (ast_joint_template.md in Drive), naming ' + names.join(' and '));
                before.push('Earlier-term agreement for the first tenant alone (ast_whole_single_template.md), from the date they moved in, at the 1-bed rate, so the backdated council tax liability is covered');
            }
            if (own.some(l => l.lever === 'Rent uplift' || l.lever === 'Rate refresh')) {
                before.push('Rent change letter for each tenant going up, at the ' + (v.rates ? v.rates.brma : 'local') + ' 1-bed rate');
            }
            if (!takeBack && v.tenants.length) before.push('Authority to act letter for every tenant (authority_to_act_template.md)');
            if (own.some(l => l.capShortfall > 0)) before.push('CRF Housing Payment details: the shortfall figure per tenant, and their last two months of bank statements');

            const releasing = new Set((roomLever && roomLever.releasableIds) || []);
            const tenants = [];
            v.tenants.forEach(t => {
                const up = own.find(l => l.tenantId === t.id);
                const ageUnknown = t.age == null && !t.over35Confirmed && t.uc && t.unitType === 'Room' && v.ours;
                const givesUpRoom = releasing.has(t.id);
                if (!up && !joint && !ageUnknown && !givesUpRoom) return;
                const sign = [];
                if (joint) sign.push('Joint tenancy agreement');
                else if (up && (up.lever === 'Rent uplift' || up.lever === 'Rate refresh')) sign.push('Rent change letter');
                if (givesUpRoom) sign.push('Tenancy variation: one room instead of two, at the same rent');
                if (!takeBack) sign.push('Authority to act');
                const collect = [];
                if (!t.dob) collect.push('date of birth');
                if (!t.ni) collect.push('National Insurance number');
                if (!t.phone) collect.push('mobile');
                if (!t.email) collect.push('email');
                if (!t.idSeen) collect.push('photo ID');
                if (!t.ucStatementSeen) collect.push('latest UC statement');
                const forms = [];
                if (up && up.lever !== 'CRF top-up') forms.push('UC journal: report the housing costs change to £' + num(up.target || t.target || t.rateNow).toFixed(2));
                else if (joint) forms.push('UC journal: report the joint tenancy and the other tenant');
                if (joint) forms.push('Council Tax Reduction claim, backdated to the tenancy start');
                if (up && up.capShortfall > 0) forms.push('CRF Housing Payment, £' + num(up.capShortfall).toFixed(2) + ' a month to landlord');
                tenants.push({
                    id: t.id, name: t.name, age: t.age, over35Confirmed: !!t.over35Confirmed, uc: t.uc,
                    rentNow: t.rent, target: up && up.lever !== 'CRF top-up' ? (t.target || t.rateNow) : null,
                    uplift: up ? up.monthly : 0, crf: up ? (up.capShortfall || 0) : 0,
                    capExemption: t.capExemption, blocked: ageUnknown, givesUpRoom, sign, collect, forms,
                    note: ageUnknown ? 'Not in the plan until the date of birth is on file, or 35 or over is confirmed'
                        : (givesUpRoom ? 'Keeps the 1-bed rate in one room, so the second room is let again. Their rent does not change: say that first.' : (t.note || '')),
                });
            });

            const works = [];
            if (roomLever) {
                works.push(roomLever.firstStep);
                works.push('Fire-safe each new room (door, alarm, lock) and list it: £' + num(roomLever.oneOff).toFixed(0) + ' one-off');
            }
            if (voidLet) works.push(voidLet.firstStep);

            const after = [];
            if (joint) after.push('Tell the council the council tax liability has changed, and submit the Council Tax Reduction form online with the signed authority');
            if (own.some(l => l.capShortfall > 0)) after.push('Diarise the CRF renewal: awards are short term and the shortfall returns when one ends');
            if (own.some(l => l.lever === 'Rent uplift' || l.lever === 'Rate refresh' || l.lever === 'CRF top-up')) after.push('Check the next UC payment lands at the new figure, and that the managed payment to landlord is still in place');
            if (tenants.some(t => t.collect.length)) after.push('Enter everything collected on the tenant meeting form the same day');
            if (takeBack) after.push('Nothing is said to the head tenant or the sub-tenants until the legal question set comes back');

            packs.push({
                id: v.id, name: v.name, strategy: v.strategy || (v.ours ? 'Not set' : 'Agent-managed'),
                owner: (own[0] || all[0] || {}).owner || v.owner || 'Kevin', area: v.area, local: v.local, mgmt: v.mgmt,
                stage: Math.min.apply(null, (own.length ? own : (all.length ? all : decide)).map(l => l.stage || 2)),
                monthly: round2(own.reduce((n, l) => n + num(l.monthly), 0)),
                oneOff: round2(own.reduce((n, l) => n + num(l.oneOff), 0)),
                crf: round2(own.reduce((n, l) => n + num(l.capShortfall), 0)),
                openCount: own.length,
                ctBand: v.ctBand, ctBandMonthly: v.ctBandMonthly, ctLive: v.ctLive,
                before, tenants, works, after, decide,
                flags: (v.flags || []).concat(v.brmaNote ? [v.brmaNote] : []),
                openCountAll: all.length,
                levers: all.map(l => ({ key: l.key, lever: l.lever, title: l.title, monthly: l.monthly, oneOff: l.oneOff, effort: l.effort, status: l.status, capShortfall: l.capShortfall || 0, evidence: l.evidence, needs: l.needs })),
            });
        });
        packs.sort((a, b) => a.stage - b.stage || b.monthly - a.monthly);
        return packs;
    }

    function lever(o, planByKey) {
        const row = planByKey[o.key] || null;
        return Object.assign({ status: row ? (row.status || 'Candidate') : 'Candidate', planId: row ? row.id : null, taskIds: row ? (row.taskIds || []) : [], stage: STAGE[o.lever] || 5 }, o);
    }
    // Who a task goes to: the house's own Growth Plan Owner if set, else paper and legal to Kevin,
    // works and lettings to Roy. (4 Abington: Kevin, with Rob for Jason and Roy for Paul.)
    function taskOwnerFor(l, ownerByProperty) {
        const forced = ownerByProperty && l.propertyId ? ownerByProperty[l.propertyId] : '';
        if (forced) return forced;
        return (l.effort === 'Works' || l.effort === 'Light') ? 'Roy' : 'Kevin';
    }

    return { money, splitBlocks, liveRentByUnit, STRATEGY_LIST, PLAN_CHOICES, TENANT_DOCS, STRATEGY_ALIASES, CHECKLIST, COUNCIL_BAND_D, COUNCIL_BY_OUTWARD, MARKET_RENT, BAND_NINTHS, councilFor, isSelfManaged, bandsByCouncil, councilTaxFor, rentableRoomsFor, marketRentFor, currentStrategyOf, priceStrategies,
        LHA_WEEKLY, LHA_2026_27, LHA_VALID_TO, weeklyToMonthly, normaliseStrategy, taskOwnerFor, buildPacks, BRMA_BY_OUTWARD, BRMA_UNCERTAIN, STAGE, STAGE_NAMES, EFFORT_WEIGHT, monthlyFromFrequency, ageOn, outward, brmaFor, isLocal, ratesFor, lhaStale, benefitCap, exemptionInput, capPosition, isUc, isHb, managementOf, buildPlan };
});
