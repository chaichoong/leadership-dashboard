// ══════════════════════════════════════════
// MONEY CONFIDENCE — "Safe to act today" engine + tab
// ══════════════════════════════════════════
//
// Purpose: remove emotion from day-to-day money decisions. One conservative,
// fully itemised figure that answers "how much can I safely act on today
// without leaving myself short?", plus a Green/Amber/Red light.
//
// ISOLATION: this tab is new, additive code. It does NOT modify the Leadership
// Dashboard (dashboard.js) or the Cash Flow tab (cashflow.js). It reads the
// SAME global data arrays (allAccounts/allTenancies/allCosts/allTransactions)
// and replicates the SAME formulas the dashboard already uses, so the inputs
// match exactly and never diverge from the numbers Kevin already trusts.
//
// Cross-reference for the replicated formulas:
//   - cleared balance ........ dashboard.js:926-930 (Santander + TNT Zempler GBP)
//   - In Payment income ...... dashboard.js:940,943
//   - CFV Actioned income .... dashboard.js:941,944
//   - monthly fixed costs .... dashboard.js:950-951 (isCostActive + costExpected)
//   - variable reserve ....... config.js MAINT/WAGES/CFV targets (£6,000)
//   - payment-lag buffer ..... cashflow.js:1133 analysePaymentLag()
//
// NOTE (v1): the rent non-payment haircut uses the CURRENT month's realised
// miss rate (live CFV exposure ÷ total active rent). Task #2 extends this to a
// trailing 3–6 month rate. The Withdrawal Advisor on the Cash Flow tab measures
// a different thing (total extractable over a 31-day cycle); a later task will
// point both at one shared engine so a single source of truth remains.

// ── Engine ─────────────────────────────────────────────────────────────────
// Pure-ish: reads globals, returns a fully itemised result object. No DOM.
function computeSafeToAct() {
    const accounts   = (typeof allAccounts   !== 'undefined' && allAccounts)   ? allAccounts   : [];
    const tenancies  = (typeof allTenancies  !== 'undefined' && allTenancies)  ? allTenancies  : [];
    const costs      = (typeof allCosts       !== 'undefined' && allCosts)      ? allCosts      : [];
    const transactions = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];

    // Cleared balance — current spendable cash (same two accounts as the dashboard)
    const santanderRec = accounts.find(r => r.id === REC.santander);
    const zemplerRec   = accounts.find(r => r.id === REC.tntZempler);
    const santBal = Number(getField(santanderRec, F.accGBP)) || 0;
    const zempBal = Number(getField(zemplerRec, F.accGBP)) || 0;
    const clearedBalance = santBal + zempBal;

    // Rent buckets (active tenancies only) — same status logic as the dashboard
    const statusOf = r => getPaymentStatusName(getField(r, F.tenPayStatus)).trim().toLowerCase();
    const rentOf   = r => Number(getField(r, F.tenRent)) || 0;
    const inPaymentTen = tenancies.filter(r => statusOf(r) === 'in payment'   && isTenantStatusActive(r));
    const cfvActionTen = tenancies.filter(r => statusOf(r) === 'cfv actioned' && isTenantStatusActive(r));
    const cfvOpenTen   = tenancies.filter(r => statusOf(r) === 'cfv'          && isTenantStatusActive(r));
    const inPaymentIncome   = inPaymentTen.reduce((s, r) => s + rentOf(r), 0);
    const cfvActionedIncome = cfvActionTen.reduce((s, r) => s + rentOf(r), 0);
    const cfvExposure       = cfvOpenTen.reduce((s, r) => s + rentOf(r), 0); // currently-missing rent
    const grossExpectedRent = inPaymentIncome + cfvActionedIncome;
    const totalActiveRent   = grossExpectedRent + cfvExposure;

    // Non-payment haircut — discount expected rent by the realised miss rate
    const nonPaymentRate = totalActiveRent > 0 ? cfvExposure / totalActiveRent : 0;
    const rentHaircut    = grossExpectedRent * nonPaymentRate;
    const netExpectedRent = grossExpectedRent - rentHaircut;

    // Monthly fixed costs (same active filter the dashboard uses)
    const activeCosts = costs.filter(r => isCostActive(r));
    const monthlyCosts = activeCosts.reduce((s, r) => s + (Number(getField(r, F.costExpected)) || 0), 0);

    // Variable reserve — the shock absorber Kevin already budgets (£6,000)
    const variableReserve = MAINT_TARGET_GBP + WAGES_TARGET_GBP + CFV_TARGET_GBP;

    // Payment-lag timing cushion — fixed costs can land before rent clears
    let bufferDays = 3, bufferReason = 'Default 3-day buffer';
    if (typeof analysePaymentLag === 'function') {
        const lag = analysePaymentLag(transactions, [...inPaymentTen, ...cfvActionTen]);
        bufferDays = lag.bufferDays;
        bufferReason = lag.bufferReason;
    }
    const lagCushion = Math.round((bufferDays / 31) * monthlyCosts);

    // The protective floor — cash that must never be touched
    const floor = variableReserve + lagCushion;

    // Safe to act today: what you can extract now and still end the month at/above
    // the protective floor, assuming rent arrives net of the current miss rate.
    const projectedSurplus = clearedBalance + netExpectedRent - monthlyCosts - floor;
    const safeToActToday = Math.max(0, projectedSurplus);

    // Traffic light — judged on cash-in-hand first, surplus second
    let light, headline;
    if (clearedBalance < floor) {
        light = 'red';
        headline = 'Below your protective floor. Pay only essentials. Take nothing for yourself.';
    } else if (projectedSurplus <= 0) {
        light = 'amber';
        headline = 'Cushion intact, but no surplus this month. Cover committed payments only.';
    } else {
        light = 'green';
        headline = 'Surplus available. Act on the plan: clear the priority card, pay critical invoices.';
    }

    return {
        santBal, zempBal, clearedBalance,
        inPaymentIncome, cfvActionedIncome, cfvExposure,
        grossExpectedRent, nonPaymentRate, rentHaircut, netExpectedRent,
        monthlyCosts, variableReserve, bufferDays, bufferReason, lagCushion,
        floor, projectedSurplus, safeToActToday, light, headline,
        counts: { inPayment: inPaymentTen.length, cfvActioned: cfvActionTen.length, cfvOpen: cfvOpenTen.length },
    };
}

// ── Render ───────────────────────────────────────────────────────────────────
async function renderMoneyTab() {
    const el = document.getElementById('tab-money');
    if (!el) return;

    const dataReady = (typeof allAccounts !== 'undefined' && allAccounts && allAccounts.length) ||
                      (typeof allTenancies !== 'undefined' && allTenancies && allTenancies.length);
    if (!dataReady) {
        el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:240px;color:var(--text-muted)">
            <div style="text-align:center">
                <div class="spinner" style="margin:0 auto 12px"></div>
                <div>Loading money data…</div>
            </div></div>`;
        if (typeof PAT !== 'undefined' && PAT && typeof loadDashboard === 'function') {
            try { await loadDashboard(); } catch (e) { /* surfaced by dashboard's own error handling */ }
        }
        if (!((allAccounts && allAccounts.length) || (allTenancies && allTenancies.length))) return;
    }

    renderMoneyContent(el, computeSafeToAct());
}

function renderMoneyContent(el, m) {
    const lightColour = { green: 'var(--success)', amber: 'var(--warning)', red: 'var(--danger)' }[m.light];
    const lightBg     = { green: 'var(--success-bg)', amber: 'var(--warning-bg)', red: 'var(--danger-bg)' }[m.light];
    const lightLabel  = { green: 'GREEN', amber: 'AMBER', red: 'RED' }[m.light];
    const pct = (m.nonPaymentRate * 100).toFixed(1);

    // Itemised breakdown — every component visible so the figure is auditable.
    const row = (label, value, opts = {}) => {
        const sign = opts.sign || '';
        const colour = opts.colour ? `color:${opts.colour}` : '';
        const strong = opts.strong ? 'font-weight:var(--fw-semibold)' : '';
        const border = opts.border ? 'border-top:1px solid var(--border-default);margin-top:6px;padding-top:10px' : '';
        return `<div class="detail-item" style="${border}">
            <span class="detail-item-name" style="${strong}">${escHtml(label)}</span>
            <span class="detail-item-value" style="${colour};${strong}">${sign}${fmt(value)}</span>
        </div>`;
    };

    el.innerHTML = `
    <div style="max-width:920px;margin:0 auto">

        <!-- Hero: the one number -->
        <div style="background:${lightBg};border:1px solid ${lightColour};border-radius:var(--radius-lg);padding:var(--space-6);margin-bottom:var(--space-5)">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
                <span style="width:14px;height:14px;border-radius:var(--radius-full);background:${lightColour};display:inline-block;box-shadow:0 0 0 4px ${lightBg}"></span>
                <span style="font-weight:var(--fw-bold);letter-spacing:0.04em;color:${lightColour};font-size:var(--fs-sm)">${lightLabel}</span>
                <span style="margin-left:auto;color:var(--text-muted);font-size:var(--fs-xs)">Updates on every data sync</span>
            </div>
            <div style="color:var(--text-secondary);font-size:var(--fs-sm);margin-bottom:2px">Safe to act today</div>
            <div style="font-size:var(--fs-3xl);font-weight:var(--fw-bold);color:var(--text-primary);line-height:1.1">${fmt(m.safeToActToday)}</div>
            <div style="color:var(--text-primary);font-size:var(--fs-sm);margin-top:10px">${escHtml(m.headline)}</div>
        </div>

        <!-- How the figure is built (auditable) -->
        <div class="kpi-card" style="margin-bottom:var(--space-5)">
            <div class="kpi-card-label" style="margin-bottom:12px">How this figure is built</div>
            ${row('Cleared balance (Santander + TNT Zempler)', m.clearedBalance, { strong: true })}
            ${row('Add: expected rent this month', m.grossExpectedRent, { sign: '+ ', colour: 'var(--success)' })}
            ${row(`Less: non-payment haircut (${pct}% current miss rate)`, m.rentHaircut, { sign: '− ', colour: 'var(--danger)' })}
            ${row('Less: monthly fixed costs', m.monthlyCosts, { sign: '− ', colour: 'var(--danger)' })}
            ${row('Less: variable reserve (maintenance + wages + CFV)', m.variableReserve, { sign: '− ', colour: 'var(--danger)' })}
            ${row(`Less: timing cushion (${m.bufferDays}-day payment lag)`, m.lagCushion, { sign: '− ', colour: 'var(--danger)' })}
            ${row('Safe to act today', m.safeToActToday, { strong: true, border: true, colour: lightColour })}
            <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-top:10px;line-height:1.5">
                The variable reserve and timing cushion (${fmt(m.floor)} combined) are your protective floor. The figure above is what you can act on without dipping into it. Conservative by design: rent is already discounted for missed payments, so the number assumes some tenants do not pay.
            </div>
        </div>

        <!-- What to do with it -->
        <div class="kpi-card">
            <div class="kpi-card-label" style="margin-bottom:8px">Where it goes (priority order)</div>
            <ol style="margin:0;padding-left:20px;color:var(--text-secondary);font-size:var(--fs-sm);line-height:1.9">
                <li><strong style="color:var(--text-primary)">Protect the floor</strong> — ${fmt(m.floor)} stays put, always.</li>
                <li><strong style="color:var(--text-primary)">Consequential payments</strong> — wages, tax, insurance, minimum credit card payments, critical maintenance.</li>
                <li><strong style="color:var(--text-primary)">Highest-interest card</strong> — all remaining surplus (avalanche).</li>
                <li><strong style="color:var(--text-primary)">Deferrable maintenance</strong> — oldest invoices first.</li>
            </ol>
            <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-top:12px;line-height:1.5">
                Invoice triage and the live payment waterfall arrive next. For now this confirms the order: minimum card payments rank above discretionary maintenance and above extra debt paydown.
            </div>
        </div>

    </div>`;
}
