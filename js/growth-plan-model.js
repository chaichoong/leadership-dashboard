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
    // Monthly UC amounts per BRMA, 2026-27. Only the BRMAs the portfolio sits in.
    const LHA_2026_27 = {
        'Cambridge':                  { sar: 526.33, b1: 900.00, b2: 950.00, b3: 1125.00, b4: 1450.00 },
        'Central Greater Manchester': { sar: 411.58, b1: 775.00, b2: 875.00, b3: 950.00,  b4: 1350.00 },
        'Greater Liverpool':          { sar: 344.36, b1: 500.00, b2: 595.00, b3: 650.00,  b4: 875.00 },
        'Fylde Coast':                { sar: 350.88, b1: 400.00, b2: 542.00, b3: 625.00,  b4: 742.50 },
        'East Lancs':                 { sar: 291.50, b1: 425.00, b2: 475.00, b3: 595.00,  b4: 795.00 },
        'Central Lancs':              { sar: 304.17, b1: 450.00, b2: 575.00, b3: 650.00,  b4: 925.00 },
        'Hull and East Riding':       { sar: 335.83, b1: 380.00, b2: 475.00, b3: 550.00,  b4: 700.00 },
        'Sunderland':                 { sar: 321.33, b1: 425.00, b2: 475.00, b3: 550.00,  b4: 700.00 },
        'Barrow-in-Furness':          { sar: 395.42, b1: 475.00, b2: 500.00, b3: 635.00,  b4: 807.50 },
        'Colchester':                 { sar: 401.33, b1: 625.00, b2: 795.00, b3: 975.00,  b4: 1250.00 },
    };
    // Postcode outward code → BRMA. Haverhill and Soham are both Cambridge BRMA
    // (Uttlesford BRMA map). BB7 2NX (Clitheroe) and SR8 4QQ (Peterlee) were looked up
    // on lha-direct.voa.gov.uk on 9 Sep 2026: East Lancs and Sunderland respectively.
    const BRMA_BY_OUTWARD = {
        CB9: 'Cambridge', CB7: 'Cambridge', M40: 'Central Greater Manchester',
        L4: 'Greater Liverpool', L20: 'Greater Liverpool', FY8: 'Fylde Coast',
        BB12: 'East Lancs', BB5: 'East Lancs', BB7: 'East Lancs', HU3: 'Hull and East Riding',
        SR8: 'Sunderland', LA13: 'Barrow-in-Furness', CO12: 'Colchester',
    };
    const BRMA_UNCERTAIN = {}; // outward codes still to confirm on LHA Direct; none as at 9 Sep 2026
    const LOCAL_OUTWARD = new Set(['CB9', 'CB7']); // the estate Kevin manages in person
    const ROOMS_PER_UNIT = { 'Room': 1, 'Flat-Let': 2 }; // Flat-Let = bedroom + own living room

    const EFFORT_WEIGHT = { Paper: 1, Light: 2, Works: 4, Legal: 6 };
    const STAGE = {
        'Rent uplift': 1, 'Rate refresh': 1, 'Council tax': 2, 'Room release': 3, 'New room let': 3,
        'Void let': 4, 'Take-back': 4, 'Agent-held': 5,
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

    // The rent a single UC tenant can carry without the cap biting, given what
    // we know about their exemption. Unknown is treated as capped (conservative):
    // the plan then shows the extra available once the exemption is evidenced.
    function safeRentFor(exemptionValue, lhaRate, settings) {
        const ex = exemptionInput(exemptionValue);
        if (ex.exempt) return { rent: lhaRate, ifExempt: lhaRate, known: ex.known, exempt: true };
        const calc = benefitCap({ single: true, age: 35, housing: lhaRate }, settings);
        const rent = Math.min(lhaRate, calc.safeRent);
        return { rent: round2(rent), ifExempt: lhaRate, known: ex.known, exempt: false };
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
        const rentFor = (tenantId, unit, fallback) => {
            const list = tenanciesByTenant[tenantId] || [];
            const tc = list.find(x => x.unitId === unit.id) || list[list.length - 1];
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
            const ctMonthly = ctLive || ctNoteAmount || s('council_tax_default', 145);

            const roomsInUse = occupied.reduce((n, u) => n + (u.type === 'Whole Property' ? 0 : (ROOMS_PER_UNIT[u.type] || 1)), 0)
                + (occupied.some(u => u.type === 'Whole Property') ? Math.max(num(prop.beds), 1) : 0);
            const lettable = prop.lettableRooms != null && prop.lettableRooms !== '' ? num(prop.lettableRooms) : null;
            const lettableEff = lettable != null ? lettable : roomsInUse;

            const view = {
                id: prop.id, name: prop.name, type: prop.type, postcode: prop.postcode || '', area: prop.area || '',
                brma: rates ? rates.brma : null, brmaNote: BRMA_UNCERTAIN[ow] || '', local, mgmt, agent: prop.agent || '',
                rentNow: round2(propRent), ctLive: round2(ctLive), ctMonthly: round2(ctMonthly), ownerPaysCt, ctPayer: prop.ctPayer || 'Unknown',
                payg: prop.payg || 'Unknown', beds: num(prop.beds), lettable, lettableEff, roomsInUse,
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
                    const rent = rentFor(t.id, u, num(u.rent) / Math.max(1, uTenants.length));
                    const uc = isUc(t, u), hb = isHb(t, u);
                    const tv = { id: t.id, name: t.name, dob: t.dob || '', age, payType: t.payType || '', uc, hb, rent: round2(rent), capExemption: t.capExemption || 'Unknown', unitId: u.id, unitType: u.type, rateNow: null, target: null, note: '' };
                    const wholeShared = u.type !== 'Whole Property' || occupied.filter(x => x.type === 'Whole Property').length >= 2;
                    if (mgmt === 'kevin' && rates && (uc || hb) && !wholeShared) {
                        // One household renting the whole house: the LHA rate depends on who lives
                        // there (children, couple), which Airtable does not record. Priced by hand.
                        tv.note = 'Whole-house let: LHA rate depends on the household, not modelled here';
                    }
                    if (mgmt === 'kevin' && rates && (uc || hb) && wholeShared) {
                        const roomUnit = u.type === 'Room';
                        // HB keeps the shared rate in a shared house at any age; UC does not.
                        const entitled1Bed = !roomUnit || (uc && age != null && age >= 35);
                        const rate = entitled1Bed ? rates.b1 : rates.sar;
                        tv.rateNow = rate;
                        if (roomUnit && uc && age == null) {
                            const safe = safeRentFor(tv.capExemption, rates.b1, settings);
                            unknownAge.push({ tenantId: t.id, tenant: t.name, propertyId: prop.id, property: prop.name, unit: u.number, rent: tv.rent, upliftIfOver35: round2(Math.max(0, safe.rent - rent)), upliftIfExempt: round2(Math.max(0, rates.b1 - rent)) });
                            tv.note = 'Age unknown: if 35 or over, entitled to the 1-bed rate';
                        } else if (uc) {
                            const safe = safeRentFor(tv.capExemption, rate, settings);
                            tv.target = safe.rent;
                            const leverName = (roomUnit && entitled1Bed) ? 'Rent uplift' : 'Rate refresh';
                            const gap = round2(safe.rent - rent);
                            const gapIfExempt = round2(rate - rent);
                            if (gap > 0.5) {
                                levers.push(lever({
                                    key: `${leverName === 'Rent uplift' ? 'uplift' : 'refresh'}:${t.id}`, lever: leverName, propertyId: prop.id, property: prop.name,
                                    tenantId: t.id, tenant: t.name, unitId: u.id, unit: u.number,
                                    title: leverName === 'Rent uplift'
                                        ? `${t.name}: room rate to 1-bed rate (age ${age})`
                                        : `${t.name}: rent to the 2026-27 ${entitled1Bed ? '1-bed' : 'room'} rate`,
                                    monthly: gap, monthlyIfExempt: gapIfExempt, oneOff: 0, effort: 'Paper', counted: 'now',
                                    evidence: [
                                        `Rent now £${rent.toFixed(2)} (tenancy record)`,
                                        `${rates.brma} ${entitled1Bed ? '1-bed' : 'room'} rate 2026-27 £${rate.toFixed(2)}`,
                                        age != null ? `Age ${age} (DOB ${t.dob})` : 'Age not needed for this unit type',
                                        safe.exempt ? `Benefit cap: exempt (${tv.capExemption})` : `Benefit cap: ${safe.known ? 'NOT exempt' : 'exemption unknown'} — safe rent £${safe.rent.toFixed(2)} (cap £${capSingle.cap} less standard allowance £${capSingle.standard})`,
                                    ],
                                    needs: safe.exempt ? [] : [`Confirm benefit cap exemption: +£${(gapIfExempt - gap).toFixed(2)} a month more if exempt`],
                                    firstStep: safe.exempt
                                        ? `Serve the rent increase notice for ${t.name} at £${rate.toFixed(2)} and update the UC housing costs`
                                        : `Ask ${t.name} for their UC statement: LCWRA, PIP or earnings on it lifts the cap`,
                                }, planByKey));
                            } else if (gapIfExempt > 0.5 && !safe.known) {
                                // Rent already sits above the cap-safe figure. Nothing to add until the
                                // exemption is evidenced; the extra to the full rate is shown as upside.
                                tv.note = 'Cap check needed: rent is above the safe rent unless an exemption applies';
                                levers.push(lever({
                                    key: `refresh:${t.id}`, lever: 'Rate refresh', propertyId: prop.id, property: prop.name,
                                    tenantId: t.id, tenant: t.name, unitId: u.id, unit: u.number,
                                    title: `${t.name}: to the 2026-27 ${entitled1Bed ? '1-bed' : 'room'} rate once the cap exemption is confirmed`,
                                    monthly: 0, monthlyIfExempt: gapIfExempt, oneOff: 0, effort: 'Paper', counted: 'now', capCheck: true,
                                    evidence: [`Rent now £${rent.toFixed(2)} (tenancy record)`, `${rates.brma} ${entitled1Bed ? '1-bed' : 'room'} rate 2026-27 £${rate.toFixed(2)}`,
                                        `Benefit cap: exemption unknown — safe rent £${safe.rent.toFixed(2)}, so the rent is already £${(-gap).toFixed(2)} over it`],
                                    needs: [`Confirm benefit cap exemption before any increase: +£${gapIfExempt.toFixed(2)} a month if exempt`],
                                    firstStep: `Ask ${t.name} for their UC statement: LCWRA, PIP or earnings on it lifts the cap`,
                                }, planByKey));
                            } else if (gap < -0.5 && safe.known && !safe.exempt) {
                                tv.note = `Capped: rent £${rent.toFixed(2)} is £${(-gap).toFixed(2)} above the safe rent`;
                                view.flags.push(`${t.name} is over the benefit cap by £${(-gap).toFixed(2)} a month at the current rent`);
                            }
                        }
                    }
                    uView.tenants.push(tv);
                    view.tenants.push(tv);
                });
                view.units.push(uView);
            });

            if (mgmt === 'kevin' && rates) {
                // Stage 3: rooms. A Flat-Let holds two rooms; an over-35 UC tenant keeps the
                // 1-bed rate in one room, so the second room can be let again.
                const releasable = view.tenants.filter(t => t.unitType === 'Flat-Let' && t.uc && t.age != null && t.age >= 35);
                const spare = Math.max(0, lettableEff - roomsInUse);
                const newLets = releasable.length + spare;
                const occupants = view.tenants.length;
                if (newLets > 0) {
                    const safe = safeRentFor('Unknown', rates.b1, settings);
                    const utilities = prop.payg === 'Yes' ? 0 : s('utilities_per_tenant', 75);
                    const ctExtra = ownerPaysCt ? 0 : ctMonthly; // becoming a shared house makes the owner liable
                    const gross = newLets * safe.rent, grossExempt = newLets * rates.b1;
                    const net = round2(gross - newLets * utilities - ctExtra);
                    const netExempt = round2(grossExempt - newLets * utilities - ctExtra);
                    const evidence = [
                        `Rooms in use ${roomsInUse} of ${lettableEff} lettable${lettable == null ? ' (lettable rooms not set — using rooms in use)' : ''}`,
                        releasable.length ? `${releasable.map(t => `${t.name} (${t.age})`).join(', ')} hold a two-room flat-let each and keep the 1-bed rate in one room` : 'No flat-let to shrink',
                        spare ? `${spare} room${spare > 1 ? 's' : ''} not let at all` : 'No spare room beyond the flat-lets',
                        `New let at £${safe.rent.toFixed(2)} (cap-safe) or £${rates.b1.toFixed(2)} if the tenant is exempt`,
                        utilities ? `Utilities £${utilities} per new tenant (PAYG Meters: ${prop.payg || 'Unknown'})` : 'PAYG meters: tenants carry utilities',
                        ctExtra ? `Council tax £${ctMonthly.toFixed(2)} a month falls on the owner once the house is shared` : `Council tax already with the owner (£${ctMonthly.toFixed(2)})`,
                    ];
                    const needs = [];
                    if (lettable == null) needs.push('Set Lettable Rooms on this property (receptions data in Airtable is unreliable)');
                    if (prop.payg !== 'Yes') needs.push('Fit PAYG meters, or budget the utilities');
                    if (occupants + newLets >= 5) needs.push(`${occupants + newLets} occupants: mandatory HMO licence (5+ people)`);
                    levers.push(lever({
                        key: `rooms:${prop.id}`, lever: releasable.length ? 'Room release' : 'New room let', propertyId: prop.id, property: prop.name,
                        title: `${prop.name}: ${newLets} more room${newLets > 1 ? 's' : ''} let to over-35 UC tenants`,
                        monthly: net, monthlyIfExempt: netExempt, oneOff: round2(newLets * s('room_prep_cost', 1500)), effort: 'Works', counted: local ? 'now' : 'remote',
                        count: newLets, evidence, needs,
                        firstStep: releasable.length ? `Agree with ${releasable[0].name} to move to one room at the same rent, then fire-safe the freed room` : 'Fire-safe the spare room (door, alarm, lock) and list it',
                    }, planByKey));
                }
                // Stage 2: council tax. Two tenants on one joint agreement makes them liable.
                if (occupants === 2 && view.tenants.every(t => t.uc || t.hb) && prop.ctPayer !== 'Tenants') {
                    const residual = round2(ctMonthly * s('ct_residual_pct', 0) / 100);
                    const credit = round2(residual * s('ct_credit_share', 100) / 100);
                    const saving = round2(ctMonthly - credit);
                    const payerKnown = ownerPaysCt;
                    const roomsLever = newLets > 0;
                    if (saving > 0) levers.push(lever({
                        key: `ct:${prop.id}`, lever: 'Council tax', propertyId: prop.id, property: prop.name,
                        title: `${prop.name}: joint tenancy for ${view.tenants.map(t => t.name).join(' and ')}, council tax moves to them`,
                        monthly: saving, monthlyIfExempt: saving, oneOff: 0, effort: 'Paper',
                        counted: payerKnown ? 'now' : 'check', alternative: roomsLever,
                        evidence: [`Council tax ${payerKnown ? 'paid by owner' : 'payer not recorded'}: £${ctMonthly.toFixed(2)} a month${ctLive ? ' (live cost)' : ' (estimate)'}`,
                            roomsLever ? 'EITHER/OR with the rooms lever: a joint tenancy of the whole house rules out a third room let' : 'No spare room here, so this does not compete with a room let',
                            'One agreement of 6+ months for the whole house makes the tenants liable (SI 2023/1175)',
                            `Each joint renter keeps their own 1-bed LHA up to their share, so rent is unchanged`,
                            `Tenants claim council tax reduction (West Suffolk: up to 100% for low income); residual £${residual.toFixed(2)} credited back at ${s('ct_credit_share', 100)}%`],
                        needs: (payerKnown ? [] : ['Confirm who pays council tax today (set Council Tax Payer on the card)']).concat(['New joint AST with the council tax credit clause', 'Tell the council the liability has changed']),
                        firstStep: `Draft the joint AST for ${prop.name} with the council tax clause (template on this page)`,
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
            if (mgmt === 'rocimmo' && rates) {
                const rooms = pUnits.filter(u => u.type === 'Room').length;
                const potential = round2(rooms * rates.b1 - propRent);
                if (potential > 0) levers.push(lever({
                    key: `agent:${prop.id}`, lever: 'Agent-held', propertyId: prop.id, property: prop.name,
                    title: `${prop.name}: ${rooms} rooms at the 1-bed rate instead of the Roc Immo head rent`,
                    monthly: potential, monthlyIfExempt: potential, oneOff: 0, effort: 'Legal', counted: 'agent',
                    evidence: [`Head rent now £${propRent.toFixed(2)} a month`, `${rooms} rooms × £${rates.b1.toFixed(2)} = £${(rooms * rates.b1).toFixed(2)} gross, before council tax, utilities and management`],
                    needs: ['Future potential only (Kevin, 9 Sep 2026) — no action generated'],
                    firstStep: 'None: agent-held',
                }, planByKey));
            }
            properties.push(view);
        });

        // Fold the pennies: refreshes under £10 a month become one portfolio row.
        const tiny = levers.filter(l => l.lever === 'Rate refresh' && Math.max(l.monthly, l.monthlyIfExempt) < 10);
        if (tiny.length > 1) {
            tiny.forEach(l => { levers.splice(levers.indexOf(l), 1); });
            levers.push(lever({
                key: 'refresh:small', lever: 'Rate refresh', propertyId: null, property: 'Portfolio',
                title: `${tiny.length} tenants: small 2026-27 rate refreshes`, monthly: round2(tiny.reduce((n, l) => n + l.monthly, 0)),
                monthlyIfExempt: round2(tiny.reduce((n, l) => n + l.monthlyIfExempt, 0)), oneOff: 0, effort: 'Paper', counted: 'now',
                evidence: tiny.map(l => `${l.tenant} (${l.property}): +£${l.monthly.toFixed(2)}${l.capCheck ? ` (+£${l.monthlyIfExempt.toFixed(2)} once the cap exemption is confirmed)` : ''}`), needs: tiny.some(l => l.capCheck) ? ['Cap exemption to confirm for the ones marked'] : [],
                firstStep: 'Do these with the next UC housing-costs update for each tenant, not as a separate job',
            }, planByKey));
        }
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
            check: sum(levers.filter(l => l.counted === 'check' && active(l))),
            agentHeld: sum(levers.filter(l => l.counted === 'agent')),
            done: sum(levers.filter(l => l.status === 'Done')),
            oneOff: sum(now, l => l.oneOff),
        };
        totals.actionable = round2(totals.paper + totals.works + totals.voids + totals.remote);
        totals.maximum = round2(totals.actionable + totals.exemptUpside + totals.unknownAge + totals.check + totals.agentHeld);
        const next = levers.find(l => l.counted === 'now' && active(l) && l.status !== 'In progress') || levers.find(l => l.counted === 'now' && active(l)) || null;
        return { today: T, levers, properties, unknownAge, totals, next, safeSingle, capSingle, lhaStale: lhaStale(T), stageNames: STAGE_NAMES, stageOf: l => STAGE[l.lever] || 5 };
    }

    function lever(o, planByKey) {
        const row = planByKey[o.key] || null;
        return Object.assign({ status: row ? (row.status || 'Candidate') : 'Candidate', planId: row ? row.id : null, taskIds: row ? (row.taskIds || []) : [], stage: STAGE[o.lever] || 5 }, o);
    }

    return { LHA_2026_27, LHA_VALID_TO, BRMA_BY_OUTWARD, BRMA_UNCERTAIN, STAGE, STAGE_NAMES, EFFORT_WEIGHT, monthlyFromFrequency, ageOn, outward, brmaFor, isLocal, ratesFor, lhaStale, benefitCap, exemptionInput, safeRentFor, isUc, isHb, managementOf, buildPlan };
});
