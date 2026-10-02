// ════════════════════════════════════════════════════════════════════════
// Real Estate quarterly KPIs — the maths (pure, no DOM, no fetch).
//
// js/dashboard.js normalises Airtable records into plain objects and hands
// them to these functions, both for the Leadership Dashboard cards and for
// the three Q4 projects' KPI Compute Code (which calls ctx.reKpis.*). One
// file, so the card and the project can never disagree about a rule.
// tests/re-kpis.test.js loads this same file under Node.
//
// Rules this file encodes (Kevin, Q4 2026 strategy session, 1-2 Oct 2026):
//   • The property cushion subtracts PROPERTY costs only. Personal and
//     Operations Director costs are never in it.
//   • PLAN (contracted rent less expected fixed costs) and CASH (rent
//     received less payments made) are two figures and are never merged.
//   • Kevin's income from property = the cushion less the variable budget
//     (plan) or less the variable payments actually made (cash).
//   • Rent now comes from LIVE tenancies. Never the unit Expected Rent
//     rollup, which counts ended tenancies.
//   • Project KPIs count NAMED units and tenants only. A replacement tenant
//     anywhere else is never counted.
//   • A figure that cannot be trusted says so: every result carries
//     `alarms`, and a card with a red alarm is shown as not updating.
// ════════════════════════════════════════════════════════════════════════
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ReKpis = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const RENT_SUB = 'Rental Income';
    // Which variable budget line a payment falls under, by sub-category name.
    const VARIABLE_LINES = {
        'Opex Labour': 'Wages', 'COGS Labour': 'Wages',
        'COGS Property Reactive Maintenance': 'Maintenance',
        'COGS Property Utilities': 'Utilities',
        'COGS Property Compliance': 'Compliance',
    };

    const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
    const lower = s => String(s || '').trim().toLowerCase();
    const iso = s => String(s || '').slice(0, 10);
    const red = msg => ({ level: 'red', msg });
    const amber = msg => ({ level: 'amber', msg });

    function addDays(isoDate, days) {
        const [y, m, d] = iso(isoDate).split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
    }
    function monthEnd(monthKey) {
        const [y, m] = monthKey.split('-').map(Number);
        return `${monthKey}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    }
    function previousMonthKey(today) {
        const [y, m] = iso(today).split('-').map(Number);
        const d = new Date(Date.UTC(y, m - 2, 1));
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }

    // A tenancy is live when it has started and has not ended. An end date of today
    // still counts as live, matching isTenancyEnded() in shared.js.
    function isLive(t, today) {
        if (t.end && iso(t.end) < iso(today)) return false;
        return !!t.start && iso(t.start) <= iso(today);
    }
    const inPayment = t => lower(t.payStatus) === 'in payment';

    // ── KPIs 1 and 3: plan ───────────────────────────────────────────────
    // tenancies: [{ rent, payStatus, tenantActive }]   (tenantActive = isTenantStatusActive)
    // costs:     [{ name, expected, active, businessIds }]
    function planCushion({ tenancies, costs, businessId, budget }) {
        const counted = (tenancies || []).filter(t => t.tenantActive);
        const sumRent = status => counted.filter(t => lower(t.payStatus) === status)
            .reduce((s, t) => s + (Number(t.rent) || 0), 0);
        const inPaymentCount = counted.filter(inPayment).length;
        const inPaymentRent = sumRent('in payment');
        const cfvActionedRent = sumRent('cfv actioned');

        const active = (costs || []).filter(c => c.active);
        const property = active.filter(c => (c.businessIds || []).includes(businessId));
        const sum = list => list.reduce((s, c) => s + (Number(c.expected) || 0), 0);
        const propertyCosts = sum(property);
        const excludedCosts = sum(active) - propertyCosts;

        const alarms = [];
        if (!inPaymentCount) alarms.push(red('No tenancy reads In Payment. The tenancy data did not load.'));
        if (!property.length) alarms.push(red('No active property cost was found. The cost data did not load.'));
        const untagged = active.filter(c => !(c.businessIds || []).length);
        if (untagged.length) alarms.push(amber(`${untagged.length} active cost(s) carry no business, so they are left out: ${untagged.map(c => c.name).join(', ')}.`));

        const cushion = inPaymentRent - propertyCosts;
        return {
            inPaymentRent: round2(inPaymentRent), inPaymentCount, cfvActionedRent: round2(cfvActionedRent),
            propertyCosts: round2(propertyCosts), propertyCostCount: property.length,
            excludedCosts: round2(excludedCosts), excludedCostCount: active.length - property.length,
            budget: round2(budget),
            cushion: round2(cushion),
            cushionWithActioned: round2(cushion + cfvActionedRent),
            income: round2(cushion - budget),
            incomeWithActioned: round2(cushion + cfvActionedRent - budget),
            alarms,
        };
    }

    // ── KPIs 2 and 4: cash ───────────────────────────────────────────────
    // transactions: [{ id, date, amount (signed), subCategories: [names], businesses: [names],
    //                  costIds, reconciled, description }]  (the compute-context shape)
    // costBusinessNames: { costId: [business names] } — only used to flag mismatches.
    //
    // Only FILED (reconciled) transactions are counted at all.
    // Fixed  = a payment linked to a cost record, tagged to the property business.
    // Variable = any other property payment (no cost record). Both are SIGNED sums, so
    // a bounced direct debit coming back cancels the payment it reverses.
    function cashWindow({ transactions, costBusinessNames, businessName, start, end }) {
        let rent = 0, fixed = 0, variable = 0, unreconciled = 0, rentCount = 0, fixedCount = 0;
        const lines = {}, mismatches = [], untagged = [];
        (transactions || []).forEach(tx => {
            const d = iso(tx.date);
            if (!d || d < start || d > end) return;
            // A payment that has not been filed yet counts in NEITHER figure. Fresh bank
            // receipts arrive tagged to the property business with no sub-category: counted,
            // a rent receipt read as money in on the income line while the cushion ignored
            // it (2 Oct 2026: income £11,591 against a true £8,614). It raises amber instead.
            if (!tx.reconciled) { unreconciled++; return; }
            const amt = Number(tx.amount) || 0;
            const subs = tx.subCategories || [];
            if (subs.includes(RENT_SUB)) { rent += amt; rentCount++; return; }
            if (!(tx.businesses || []).includes(businessName)) {
                // A payment against a PROPERTY cost record that is not tagged to the property
                // business is left out of the figure. Say so: silently it inflates the cushion.
                const owner = (tx.costIds || []).length ? ((costBusinessNames || {})[tx.costIds[0]] || []) : [];
                if (owner.includes(businessName)) untagged.push({ id: tx.id, date: d, amount: round2(-amt), description: String(tx.description || '').slice(0, 60) });
                return;
            }
            if ((tx.costIds || []).length) {
                fixed += -amt; fixedCount++;
                const costBiz = (costBusinessNames || {})[tx.costIds[0]] || [];
                if (costBiz.length && !costBiz.includes(businessName)) {
                    mismatches.push({ id: tx.id, date: d, amount: round2(-amt), description: String(tx.description || '').slice(0, 60), costBusiness: costBiz.join(', ') });
                }
                return;
            }
            variable += -amt;
            const line = VARIABLE_LINES[subs[0]] || 'Other';
            lines[line] = (lines[line] || 0) + (-amt);
        });
        Object.keys(lines).forEach(k => { lines[k] = round2(lines[k]); });
        return {
            start, end, rent: round2(rent), rentCount, fixed: round2(fixed), fixedCount,
            variable: round2(variable), variableLines: lines,
            cushion: round2(rent - fixed), income: round2(rent - fixed - variable),
            unreconciled, mismatches, untagged,
        };
    }

    function cashCushion({ transactions, costBusinessNames, businessName, today, baselineMonths, feedStaleDays }) {
        const base = { transactions, costBusinessNames, businessName };
        const rolling = cashWindow({ ...base, start: addDays(today, -30), end: iso(today) });
        const lastKey = previousMonthKey(today);
        const lastMonth = cashWindow({ ...base, start: `${lastKey}-01`, end: monthEnd(lastKey) });
        const months = (baselineMonths || []).map(k => cashWindow({ ...base, start: `${k}-01`, end: monthEnd(k) }));
        const avg = key => months.length ? round2(months.reduce((s, m) => s + m[key], 0) / months.length) : null;
        const baseline = { cushion: avg('cushion'), income: avg('income'), rent: avg('rent'), fixed: avg('fixed'), variable: avg('variable') };

        // Newest PROPERTY transaction: rent, or anything tagged to the property business. A
        // live personal card feed must not hide a property account that has stopped.
        const isProperty = tx => (tx.subCategories || []).includes(RENT_SUB) || (tx.businesses || []).includes(businessName);
        const newest = (transactions || []).reduce((mx, tx) => (isProperty(tx) && iso(tx.date) > mx && iso(tx.date) <= iso(today) ? iso(tx.date) : mx), '');
        const alarms = [];
        if (!(transactions || []).length) alarms.push(red('No bank transactions loaded.'));
        else if (!newest) alarms.push(red('No property transaction found. The bank feed or the filing has stopped.'));
        else if (newest < addDays(today, -(feedStaleDays || 4))) alarms.push(red(`The newest property transaction is dated ${newest}. The bank feed or the filing has stopped.`));
        if (!rolling.rentCount) alarms.push(red('No rent received in the window. The feed or the filing has stopped.'));
        if (rolling.unreconciled) alarms.push(amber(`${rolling.unreconciled} payment(s) in the window are not filed yet, so this figure will move.`));
        if (rolling.untagged.length) alarms.push(amber(`${rolling.untagged.length} payment(s) against a property cost record are not tagged to the property business, so they are left out. Check them.`));
        if (rolling.mismatches.length) alarms.push(amber(`${rolling.mismatches.length} payment(s) are tagged to property but linked to another business's cost record. They are counted as property. Check them.`));
        return { rolling, lastMonth, lastMonthKey: lastKey, baseline, newestTransaction: newest, alarms };
    }

    // Live tenancies sitting in a unit, leaving out anyone the unit must not count.
    function liveInUnit(tenancies, unitId, excludeTenantIds, today) {
        const skip = excludeTenantIds || [];
        return (tenancies || []).filter(t => (t.unitIds || []).includes(unitId) && isLive(t, today)
            && !(t.tenantIds || []).some(id => skip.includes(id)));
    }

    // ── KPI 5: named units with a signed tenant in ───────────────────────
    // units cfg: [{ id, label, stretch, excludeTenantIds }]   knownUnitIds: every unit id that loaded
    // tenancies: [{ id, unitIds, tenantIds, surname, start, end, payStatus, rent }]
    function namedUnits({ units, tenancies, knownUnitIds, today }) {
        const alarms = [];
        const rows = (units || []).map(u => {
            const live = liveInUnit(tenancies, u.id, u.excludeTenantIds, today);
            if (knownUnitIds && !knownUnitIds.includes(u.id)) alarms.push(red(`${u.label} is missing from the Rental Units table.`));
            // A tenancy with no start date is never live under the rule above. Say so, or a
            // let unit reads "Empty" for ever because one date was left blank.
            const undated = (tenancies || []).filter(t => (t.unitIds || []).includes(u.id) && !t.start && !(t.end && iso(t.end) < iso(today)));
            if (!live.length && undated.length) alarms.push(amber(`${u.label} has a tenancy with no start date, so it is not counted yet.`));
            return { id: u.id, label: u.label, stretch: !!u.stretch, filled: live.length > 0, tenant: live.map(t => t.surname).filter(Boolean).join(', ') };
        });
        if (!(tenancies || []).length) alarms.push(red('No tenancies loaded.'));
        const committed = rows.filter(r => !r.stretch);
        const filled = committed.filter(r => r.filled).length;
        const stretchFilled = rows.filter(r => r.stretch && r.filled).length;
        return { value: filled + stretchFilled, filled, of: committed.length, stretchFilled, stretchOf: rows.length, rows, alarms };
    }

    // ── KPI 6: new monthly rent in payment from the named tenants ────────
    // lines cfg: [{ label, tenantId | unitId, excludeTenantIds, stretch }]
    // A tenancy is counted once, on the first line that claims it.
    function namedRent({ lines, tenancies, knownTenantIds, knownUnitIds, today }) {
        const alarms = [];
        const claimed = new Set();
        const rows = (lines || []).map(l => {
            let matches;
            if (l.tenantId) {
                matches = (tenancies || []).filter(t => (t.tenantIds || []).includes(l.tenantId) && isLive(t, today));
                if (knownTenantIds && !knownTenantIds.includes(l.tenantId)) alarms.push(red(`${l.label} has no tenancy on record.`));
            } else {
                matches = liveInUnit(tenancies, l.unitId, l.excludeTenantIds, today);
                if (knownUnitIds && !knownUnitIds.includes(l.unitId)) alarms.push(red(`${l.label}: its unit is missing from the Rental Units table.`));
            }
            const paying = matches.filter(t => inPayment(t) && !claimed.has(t.id));
            paying.forEach(t => claimed.add(t.id));
            const status = paying.length ? 'In Payment' : (matches.length ? (matches[0].payStatus || 'No status') : 'No tenancy yet');
            return { label: l.label, stretch: !!l.stretch, rent: round2(paying.reduce((s, t) => s + (Number(t.rent) || 0), 0)), status };
        });
        if (!(tenancies || []).length) alarms.push(red('No tenancies loaded.'));
        const committed = round2(rows.filter(r => !r.stretch).reduce((s, r) => s + r.rent, 0));
        const stretch = round2(rows.filter(r => r.stretch).reduce((s, r) => s + r.rent, 0));
        return { value: round2(committed + stretch), committed, stretch, rows, alarms };
    }

    // ── KPI 8: self-managed properties fully compliant ───────────────────
    // properties: [{ id, name, agent, noGas }]
    // certs:      [{ type, propertyId, status, renewal, hasFile }]
    // A property counts when gas (or "no gas"), the electrical inspection and the
    // insurance document are each in date AND on file.
    function compliance({ properties, certs, selfManagedAgent, expected, today }) {
        const alarms = [];
        const mine = (properties || []).filter(p => lower(p.agent) === lower(selfManagedAgent));
        const good = (propertyId, type) => (certs || []).some(c => c.propertyId === propertyId && c.type === type
            && c.hasFile && lower(c.status) !== 'expired' && c.renewal && iso(c.renewal) >= iso(today));
        const rows = mine.map(p => {
            const gas = p.noGas ? 'No gas' : (good(p.id, 'GSC') ? 'OK' : 'Missing');
            const electrical = good(p.id, 'EICR') ? 'OK' : 'Missing';
            const insurance = good(p.id, 'Landlord Insurance') ? 'OK' : 'Missing';
            return { id: p.id, name: p.name, gas, electrical, insurance, compliant: gas !== 'Missing' && electrical === 'OK' && insurance === 'OK' };
        }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (!(certs || []).length) alarms.push(red('No certificates loaded.'));
        else {
            // A certificate type renamed in Airtable would make every property read Missing
            // and save a calm 0. The book always holds some of each type, so none is a fault.
            const absent = ['GSC', 'EICR', 'Landlord Insurance'].filter(t => !certs.some(c => c.type === t));
            if (absent.length) alarms.push(red(`The certificate book holds no ${absent.join(' or ')} record at all. A certificate type was renamed or the book did not load.`));
        }
        if (!mine.length) alarms.push(red('No self-managed property found.'));
        else if (expected && mine.length !== expected) alarms.push(amber(`${mine.length} self-managed properties found, ${expected} expected. A property was added, removed or handed to an agent.`));
        return { value: rows.filter(r => r.compliant).length, of: mine.length, rows, alarms };
    }

    // ── KPI 7: personal net cash flow ────────────────────────────────────
    // months: the Wealth page's own buildMonthlyCashflow() output for the last complete
    // months, oldest first. Nothing is regrouped here: this only picks and averages.
    function personalNet({ months }) {
        const alarms = [];
        const list = months || [];
        if (!list.length) alarms.push(red('The Wealth cash flow did not load.'));
        else if (!list.some(m => m.totalIncome)) alarms.push(red('The Wealth cash flow shows no income. The transactions did not load.'));
        const last = list.length ? list[list.length - 1] : null;
        const average = list.length ? round2(list.reduce((s, m) => s + (Number(m.net) || 0), 0) / list.length) : null;
        return { value: last ? round2(last.net) : null, lastMonthKey: last ? last.key : '', average, months: list.map(m => ({ key: m.key, net: round2(m.net) })), alarms };
    }

    // Worst alarm on a result: 'red' | 'amber' | ''. A thrown rule is red, never blank.
    function alarmLevel(result) {
        if (!result) return 'red';
        const a = result.alarms || [];
        return a.some(x => x.level === 'red') ? 'red' : (a.length ? 'amber' : '');
    }

    return { planCushion, cashWindow, cashCushion, namedUnits, namedRent, compliance, personalNet, alarmLevel, isLive, addDays, previousMonthKey, VARIABLE_LINES };
});
