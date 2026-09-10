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
    const STRATEGY_ALIASES = { 'Add tenants': 'HMO', 'Hold': 'Leave as is' };
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

    // ── The plan ────────────────────────────────────────────────────────
    function buildPlan(data, settings, today) {
        const s = (k, d) => setting(settings, k, d);
        const T = today || new Date().toISOString().slice(0, 10);
        const units = data.units || [];
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

        const levers = [];
        const properties = [];
        const unknownAge = [];
        let rentNow = 0;

        (data.properties || []).forEach(prop => {
            const pUnits = (unitsByProp[prop.id] || []).slice().sort((a, b) => num(a.number) - num(b.number));
            const occupied = pUnits.filter(u => u.status === 'Occupied' || (u.tenantIds || []).length);
            const pTenants = [];
            occupied.forEach(u => (u.tenantIds || []).forEach(id => { const t = tenantById[id]; if (t && t.status !== 'Former') pTenants.push(Object.assign({ unit: u }, t)); }));
            const mgmt = managementOf(prop, pTenants);
            const rates = ratesFor(prop.postcode, settings);
            const local = isLocal(prop.postcode);
            const ow = outward(prop.postcode);
            const propRent = pUnits.reduce((sum, u) => sum + num(u.rent), 0);
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
                brma: rates ? rates.brma : null, brmaNote: BRMA_UNCERTAIN[ow] || '', local, mgmt, agent: prop.agent || '',
                rentNow: round2(propRent), ctLive: round2(ctLive), ctMonthly: round2(ctMonthly), ownerPaysCt, ctPayer: prop.ctPayer || 'Unknown',
                payg: prop.payg || 'Unknown', beds: num(prop.beds), lettable, lettableEff, roomsInUse, strategy: normaliseStrategy(prop.strategy), plannedExtra: num(prop.plannedExtra), owner: prop.owner || '', ctBand: prop.ctBand || '', ctAnnual: num(prop.ctAnnual), ctBandMonthly,
                rates, units: [], tenants: [], levers: [], flags: [],
            };
            if (!rates && prop.postcode) view.flags.push('No LHA table for this postcode');
            if (!prop.postcode) view.flags.push('No postcode on the property record');

            // Per tenant view + stage 1 levers
            occupied.forEach(u => {
                const uTenants = (u.tenantIds || []).map(id => tenantById[id]).filter(t => t && t.status !== 'Former');
                const uView = { id: u.id, number: u.number, type: u.type, status: u.status, rent: round2(num(u.rent)), incomeType: u.incomeType || '', tenants: [] };
                uTenants.forEach(t => {
                    const age = ageOn(t.dob, T);
                    const over35Known = age != null ? age >= 35 : !!t.over35Confirmed; // Kevin/Roy can confirm 35+ without a date of birth
                    const rent = rentFor(t.id, u, num(u.rent) / Math.max(1, uTenants.length));
                    const uc = isUc(t, u), hb = isHb(t, u);
                    const tv = { id: t.id, name: t.name, dob: t.dob || '', age, payType: t.payType || '', uc, hb, rent: round2(rent), capExemption: t.capExemption || 'Unknown', unitId: u.id, unitType: u.type, rateNow: null, target: null, note: '',
                        over35Confirmed: !!t.over35Confirmed, ni: t.ni || '', phone: t.phone || '', email: t.email || '', idSeen: t.idSeen || '', ucStatementSeen: !!t.ucStatementSeen };
                    const wholeShared = u.type !== 'Whole Property' || occupied.filter(x => x.type === 'Whole Property').length >= 2;
                    if (mgmt === 'kevin' && rates && (uc || hb) && !wholeShared) {
                        // One household renting the whole house: the LHA rate depends on who lives
                        // there (children, couple), which Airtable does not record. Priced by hand.
                        tv.note = 'Whole-house let: LHA rate depends on the household, not modelled here';
                    }
                    if (mgmt === 'kevin' && rates && (uc || hb) && wholeShared) {
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
                            if (gap > 0.5) {
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
                                }, planByKey));
                            }
                            const tc = tenancyFor(t.id, u);
                            const received = tc && tc.actual != null ? num(tc.actual) / Math.max(1, (tc.tenantIds || []).length) : null;
                            if (gap <= 0.5 && received != null && received > 0 && rent - received > 10) {
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

            if (mgmt === 'kevin' && rates) {
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
                const newLets = strategy === 'HMO' ? num(prop.plannedExtra) : (strategy ? 0 : computedLets);
                const occupants = view.tenants.length;
                if (newLets > 0) {
                    const capNew = capPosition('Unknown', rates.b1, settings);
                    const utilities = prop.payg === 'No' ? s('utilities_per_tenant', 75) : 0; // bills sit with the tenants unless Kevin has taken them on
                    const ctExtra = ownerPaysCt ? 0 : ctMonthly; // becoming a shared house makes the owner liable
                    const gross = newLets * rates.b1;
                    const net = round2(gross - newLets * utilities - ctExtra);
                    const evidence = [
                        strategy === 'HMO' ? `Kevin's strategy: HMO, add ${newLets} tenant${newLets > 1 ? 's' : ''} here` : `Rooms in use ${roomsInUse} of ${lettableEff} lettable${lettable == null ? ' (lettable rooms not set — using rooms in use)' : ''}`,
                        releasable.length ? `${releasable.map(t => `${t.name} (${t.age})`).join(', ')} hold a two-room flat-let each and keep the 1-bed rate in one room` : 'No flat-let to shrink',
                        `New let at £${rates.b1.toFixed(2)} (1-bed rate); a capped tenant is £${capNew.shortfall.toFixed(2)} short, covered by a CRF Housing Payment or by choosing an exempt tenant`,
                        utilities ? `Utilities £${utilities} per new tenant (you have taken the bills on)` : 'Bills stay with the tenants (PAYG)',
                        ctExtra ? `Council tax £${ctMonthly.toFixed(2)} a month falls on the owner once the house is shared` : `Council tax already with the owner (£${ctMonthly.toFixed(2)})`,
                    ];
                    const needs = [];
                    if (!strategy) needs.push('Set Growth Strategy on this house (Add tenants / Joint tenancy / Hold)');
                    if (strategy === 'HMO' && lettable != null && lettableEff < roomsInUse + newLets - releasable.length) needs.push(`Lettable rooms (${lettableEff}) do not fit ${occupants + newLets} tenants`);
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
                if (occupants === 2 && view.tenants.every(t => t.uc || t.hb) && prop.ctPayer !== 'Tenants' && strategy !== 'HMO' && strategy !== 'Leave as is') {
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
                        counted: strategy === 'Joint tenancy' ? 'now' : 'check', alternative: !strategy && newLets > 0,
                        evidence: [ctLive ? `Council tax paid by you today: £${ctLive.toFixed(2)} a month (live cost, bank-fed)` : (ctBandMonthly ? `Band ${prop.ctBand || '?'}: £${num(prop.ctAnnual).toFixed(2)} a year = £${ctBandMonthly.toFixed(2)} a month. Nothing paid today (bank feed Jun 2025 to Sep 2026) but the owner is liable for a room-by-room let until the joint tenancy and a backdated Council Tax Reduction are in place, so it counts` : 'No council tax figure on this house: set Council Tax Band and Council Tax Annual on the property'),
                            strategy === 'Joint tenancy' ? "Kevin's strategy: joint tenancy, no extra tenant here" : 'No strategy set: shown as a candidate',
                            'One agreement of 6+ months for the whole house makes the tenants liable (SI 2023/1175)',
                            'Each joint renter keeps their own 1-bed LHA up to their share, so rent is unchanged',
                            `Tenants claim Council Tax Reduction (West Suffolk: up to 100% for low income); any residual paid by you to the council under the side letter`],
                        needs: ['Joint AST from ast_joint_template.md plus the council tax side letter', 'Council Tax Reduction claim for the tenants at the same meeting, backdated to the tenancy start', 'Tell the council the liability has changed'],
                        firstStep: `Prepare the joint AST and side letter for ${prop.name} (templates in Drive), then book the tenant meeting`,
                    }, planByKey));
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
                    evidence: [`Rent received now £${propRent.toFixed(2)} (unit rollup)`, `Margin on take-back £${margin} a month (Kevin, 9 Sep 2026)`],
                    needs: ['Q4 only, after the legal question set comes back (ruling 31 Jul 2026)', 'Say nothing to Collins or the sub-tenants until then'],
                    firstStep: 'Check the legal question set on approaching sub-tenants has an answer',
                }, planByKey));
            }
            const leaveAsIs = mgmt === 'kevin' && normaliseStrategy(prop.strategy) === 'Leave as is';
            if ((mgmt === 'rocimmo' || mgmt === 'agent' || leaveAsIs) && rates) {
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
                    evidence: [voidLever ? `Void: the plan lets it to a family at £${voidLever.monthly.toFixed(2)} a month, so that is the comparison` : `Rent now £${propRent.toFixed(2)} a month${mgmt === 'kevin' ? '' : ' via ' + (prop.agent || 'the agent')}`, `${how} (${rates.brma} 1-bed) = £${potentialRent.toFixed(2)} a month, before council tax and management`, potential < 0 ? 'The current rent is higher than the LHA figure: no gain' : (roomsCap ? 'Council tax and licensing would sit with the owner as an HMO' : 'Council tax would sit with the tenants')],
                    needs: ['Potential only: no action generated'],
                    firstStep: 'None: potential only',
                }, planByKey));
            }
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
        const next = levers.find(l => l.counted === 'now' && active(l) && l.status !== 'In progress') || levers.find(l => l.counted === 'now' && active(l)) || null;
        const todo = levers.filter(l => (l.counted === 'now' || l.counted === 'remote') && active(l)).map(l => ({ key: l.key, stage: l.stage, text: l.firstStep, owner: l.owner, property: l.property, monthly: l.monthly, status: l.status }));
        const packs = buildPacks(properties, levers, active);
        return { today: T, levers, properties, unknownAge, totals, next, todo, packs, safeSingle, capSingle, lhaStale: lhaStale(T), stageNames: STAGE_NAMES, stageOf: l => STAGE[l.lever] || 5 };
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
                .map(l => ({ key: l.key, title: l.title, monthly: l.monthly, counted: l.counted, needs: l.needs, evidence: l.evidence }));
            if (!all.length && !decide.length) return;
            const joint = v.strategy === 'Joint tenancy' && own.some(l => l.lever === 'Council tax');
            const roomLever = own.find(l => l.lever === 'Room release' || l.lever === 'New room let');
            const takeBack = own.find(l => l.lever === 'Take-back');
            const voidLet = own.find(l => l.lever === 'Void let');
            const names = v.tenants.map(t => t.name);

            const before = [];
            if (joint) {
                before.push('Joint tenancy agreement for the whole house (ast_joint_template.md in Drive), naming ' + names.join(' and '));
                before.push('Council tax side letter (council_tax_side_letter_template.md), signed the same day');
                before.push('Plain-English note for each tenant: joint and several liability, and what happens if one leaves');
            }
            if (own.some(l => l.lever === 'Rent uplift' || l.lever === 'Rate refresh')) {
                before.push('Rent change letter for each tenant going up, at the ' + (v.rates ? v.rates.brma : 'local') + ' 1-bed rate');
            }
            if (!takeBack && !voidLet) before.push('Authority to act letter for every tenant (authority_to_act_template.md)');
            if (own.some(l => l.capShortfall > 0)) before.push('CRF Housing Payment details: the shortfall figure per tenant, and their last two months of bank statements');

            const releasing = new Set((roomLever && roomLever.releasableIds) || []);
            const tenants = [];
            v.tenants.forEach(t => {
                const up = own.find(l => l.tenantId === t.id);
                const ageUnknown = t.age == null && !t.over35Confirmed && t.uc && t.unitType === 'Room' && v.mgmt === 'kevin';
                const givesUpRoom = releasing.has(t.id);
                if (!up && !joint && !ageUnknown && !givesUpRoom) return;
                const sign = [];
                if (joint) sign.push('Joint tenancy agreement', 'Council tax side letter', 'Plain-English note');
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
            if (joint) after.push('Tell the council the council tax liability has changed, and send the copy bill route in the side letter');
            if (own.some(l => l.capShortfall > 0)) after.push('Diarise the CRF renewal: awards are short term and the shortfall returns when one ends');
            if (own.some(l => l.lever === 'Rent uplift' || l.lever === 'Rate refresh' || l.lever === 'CRF top-up')) after.push('Check the next UC payment lands at the new figure, and that the managed payment to landlord is still in place');
            if (tenants.some(t => t.collect.length)) after.push('Enter everything collected on the tenant meeting form the same day');
            if (takeBack) after.push('Nothing is said to the head tenant or the sub-tenants until the legal question set comes back');

            packs.push({
                id: v.id, name: v.name, strategy: v.strategy || (v.mgmt === 'kevin' ? 'Not set' : 'Agent-managed'),
                owner: (own[0] || all[0] || { owner: 'Kevin' }).owner, area: v.area, local: v.local, mgmt: v.mgmt,
                stage: Math.min.apply(null, (own.length ? own : (all.length ? all : [{ stage: 2 }])).map(l => l.stage)),
                monthly: round2(own.reduce((n, l) => n + num(l.monthly), 0)),
                oneOff: round2(own.reduce((n, l) => n + num(l.oneOff), 0)),
                crf: round2(own.reduce((n, l) => n + num(l.capShortfall), 0)),
                openCount: own.length,
                ctBand: v.ctBand, ctBandMonthly: v.ctBandMonthly, ctLive: v.ctLive,
                before, tenants, works, after, decide,
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

    return { LHA_WEEKLY, LHA_2026_27, LHA_VALID_TO, weeklyToMonthly, normaliseStrategy, taskOwnerFor, buildPacks, BRMA_BY_OUTWARD, BRMA_UNCERTAIN, STAGE, STAGE_NAMES, EFFORT_WEIGHT, monthlyFromFrequency, ageOn, outward, brmaFor, isLocal, ratesFor, lhaStale, benefitCap, exemptionInput, capPosition, isUc, isHb, managementOf, buildPlan };
});
