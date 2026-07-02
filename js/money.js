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
//   - payment-lag buffer ..... cashflow.js:1133 analysePaymentLag()
//
// MODEL (revised per Kevin): "Safe to act today" is bounded by cash in hand and
// never exceeds the bank balance. It is the cleared balance minus a wages float,
// a payment-lag timing cushion, and the fixed costs that reliable rent will NOT
// cover. Expected rent is not added in — you act only on money you hold today.
// Maintenance is NOT reserved (paid from the surplus in priority order). The
// non-payment haircut replaces the old CFV reserve. Only wages remain as a float.
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

    // Reliable rent covers most fixed costs. Only the shortfall must be held back
    // from cash. Maintenance is NOT reserved (it is paid from the safe-to-act
    // surplus in priority order). Missed-payment risk is handled by the haircut
    // above, so there is no separate CFV reserve. Only wages remain as a fixed float.
    const uncoveredCosts = Math.max(0, monthlyCosts - netExpectedRent);
    const wagesFloat = WAGES_TARGET_GBP;

    // Payment-lag timing cushion — fixed costs can land before rent clears.
    let bufferDays = 3, bufferReason = 'Default 3-day buffer';
    if (typeof analysePaymentLag === 'function') {
        const lag = analysePaymentLag(transactions, [...inPaymentTen, ...cfvActionTen]);
        bufferDays = lag.bufferDays;
        bufferReason = lag.bufferReason;
    }
    const lagCushion = Math.round((bufferDays / 31) * monthlyCosts);

    // Protective floor — cash that must never be touched.
    const floor = wagesFloat + lagCushion;

    // Safe to act TODAY — bounded by cash in hand, so it can never exceed the bank
    // balance. Take current cash, set aside the floor and the fixed costs that
    // reliable rent will not cover. Expected rent is NOT added in: you act only on
    // money you actually hold today.
    const safeToActToday = Math.max(0, clearedBalance - floor - uncoveredCosts);

    // Traffic light
    let light, headline;
    if (clearedBalance < floor) {
        light = 'red';
        headline = 'Below your protective floor. Pay only essentials. Take nothing for yourself.';
    } else if (safeToActToday <= 0) {
        light = 'amber';
        headline = 'Cushion intact, but reliable rent does not cover this month’s fixed costs. Cover commitments only.';
    } else {
        light = 'green';
        headline = 'Surplus available. Act on the plan: pay critical invoices, then clear the priority card.';
    }

    return {
        santBal, zempBal, clearedBalance,
        inPaymentIncome, cfvActionedIncome, cfvExposure,
        grossExpectedRent, nonPaymentRate, rentHaircut, netExpectedRent,
        monthlyCosts, uncoveredCosts, wagesFloat, bufferDays, bufferReason, lagCushion,
        floor, safeToActToday, light, headline,
        counts: { inPayment: inPaymentTen.length, cfvActioned: cfvActionTen.length, cfvOpen: cfvOpenTen.length },
    };
}

// ── Render ───────────────────────────────────────────────────────────────────
// Readiness gates on allAccounts specifically — it is the LAST global set
// (inside renderDashboard, after allTenancies/allCosts). Gating on it guarantees
// a full dashboard load completed, so the balance, rent and cost figures are all
// populated together. Gating on allTenancies alone would let the figure compute
// with a £0 balance during the brief window before renderDashboard runs.
function moneyDataReady() {
    return typeof allAccounts !== 'undefined' && allAccounts && allAccounts.length > 0;
}

// Wait for an IN-PROGRESS dashboard load to populate the shared globals.
// We deliberately do NOT call loadDashboard() here: init (and the switchTab
// refresh tail) already trigger it. A second concurrent call doubles the
// Airtable request burst (18+ simultaneous requests), trips the 5/sec rate
// limit, and forces retries/backoff that drag the load out to minutes. We
// simply wait for the data the existing load produces.
function waitForMoneyData(timeoutMs) {
    return new Promise(resolve => {
        if (moneyDataReady()) { resolve(true); return; }
        const started = Date.now();
        const timer = setInterval(() => {
            if (moneyDataReady()) { clearInterval(timer); resolve(true); return; }
            if (Date.now() - started >= timeoutMs) { clearInterval(timer); resolve(false); }
        }, 400);
    });
}

let _moneyRendered = false;

// Register the Money tab's sync bar + health checks. The refresh piggybacks
// on the dashboard load (money mirrors that data); it never fires its own
// Airtable burst — see waitForMoneyData for why.
function registerMoneySyncBar() {
    if (typeof registerSyncBar !== 'function') return;
    registerSyncBar('money', {
        refreshFn: () => {
            if (typeof loadDashboard === 'function') return loadDashboard({ force: true });
            return renderMoneyTab();
        },
        checks: [
            { name: 'Dashboard data present', kind: 'sync', run: () => moneyDataReady()
                ? { status: 'pass', detail: `${allAccounts.length} account(s) loaded` }
                : { status: 'warn', detail: 'Waiting for data — open the Leadership Dashboard' } },
            { name: 'Bank balances loaded', kind: 'sync', run: () => {
                if (!moneyDataReady()) return { status: 'warn', detail: 'Not yet loaded' };
                const m = computeSafeToAct();
                return (m && isFinite(m.clearedBalance)) ? { status: 'pass', detail: fmt(m.clearedBalance) + ' cleared' } : { status: 'warn', detail: 'No balance figure' };
            } },
            { name: 'Safe-to-act figure computed', kind: 'sync', run: () => {
                if (!moneyDataReady()) return { status: 'warn', detail: 'Not yet loaded' };
                const m = computeSafeToAct();
                return (m && isFinite(m.safeToActToday)) ? { status: 'pass', detail: fmt(m.safeToActToday) + ' safe to act' } : { status: 'fail', detail: 'Figure not finite' };
            } },
            { name: 'Reliable rent computed', kind: 'sync', run: () => {
                if (!moneyDataReady()) return { status: 'warn', detail: 'Not yet loaded' };
                const m = computeSafeToAct();
                return (m && isFinite(m.netExpectedRent)) ? { status: 'pass', detail: fmt(m.netExpectedRent) + ' reliable rent' } : { status: 'warn', detail: 'No reliable-rent figure' };
            } },
        ],
    });
}

async function renderMoneyTab() {
    const el = document.getElementById('tab-money');
    if (!el) return;
    registerMoneySyncBar();

    if (moneyDataReady()) { renderMoneyContent(el, computeSafeToAct()); if (typeof markTabSynced === 'function') markTabSynced('money'); return; }

    el.innerHTML = `<div data-sync-bar="money"></div>
        <div style="display:flex;align-items:center;justify-content:center;min-height:240px;color:var(--text-muted)">
        <div style="text-align:center">
            <div class="spinner" style="margin:0 auto 12px"></div>
            <div>Loading money data…</div>
        </div></div>`;
    registerMoneySyncBar();

    const ok = await waitForMoneyData(90000);
    if (!ok) {
        el.innerHTML = `<div data-sync-bar="money"></div>
        <div style="max-width:920px;margin:0 auto"><div class="kpi-card" style="text-align:center;color:var(--text-secondary)">
            <div style="font-weight:var(--fw-semibold);margin-bottom:6px;color:var(--text-primary)">Money data did not load</div>
            <div style="font-size:var(--fs-sm);margin-bottom:12px">The Leadership Dashboard data hasn't arrived yet.</div>
            <button onclick="renderMoneyTab()" style="padding:8px 16px;border:none;background:var(--accent);color:var(--accent-on);border-radius:var(--radius-md);cursor:pointer;font-size:var(--fs-sm);font-weight:var(--fw-semibold)">Retry</button>
        </div></div>`;
        registerMoneySyncBar();
        return;
    }
    renderMoneyContent(el, computeSafeToAct());
    if (typeof markTabSynced === 'function') markTabSynced('money');
}

// Called by renderDashboard after a fresh data load so the Money tab reflects
// the same numbers without its own fetch. Only re-renders once the tab has
// been opened at least once (avoids building hidden DOM on every load).
function notifyMoneyDataUpdated() {
    if (!_moneyRendered) return;
    const el = document.getElementById('tab-money');
    if (!el || !moneyDataReady()) return;
    renderMoneyContent(el, computeSafeToAct());
    if (typeof markTabSynced === 'function') markTabSynced('money');
}
window.notifyMoneyDataUpdated = notifyMoneyDataUpdated;

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

    _moneyRendered = true;
    el.innerHTML = `
    <div data-sync-bar="money"></div>
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

        <!-- Reliable income this month -->
        <div class="kpi-card" style="margin-bottom:var(--space-5)">
            <div class="kpi-card-label" style="margin-bottom:12px">Reliable rent this month</div>
            ${row('Expected rent (In Payment + CFV Actioned)', m.grossExpectedRent)}
            ${row(`Less: non-payment haircut (${pct}% currently in CFV)`, m.rentHaircut, { sign: '− ', colour: 'var(--danger)' })}
            ${row('Reliable rent', m.netExpectedRent, { strong: true, border: true, colour: 'var(--success)' })}
            <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-top:10px;line-height:1.5">
                The haircut replaces the old CFV reserve: missed rent is handled here, once, by discounting what you can rely on.
            </div>
        </div>

        <!-- How the figure is built (auditable, bounded by cash in hand) -->
        <div class="kpi-card" style="margin-bottom:var(--space-5)">
            <div class="kpi-card-label" style="margin-bottom:12px">Safe to act today — from cash in hand</div>
            ${row('Cleared balance (Santander + TNT Zempler)', m.clearedBalance, { strong: true })}
            ${row('Less: wages float', m.wagesFloat, { sign: '− ', colour: 'var(--danger)' })}
            ${row(`Less: timing cushion (${m.bufferDays}-day payment lag)`, m.lagCushion, { sign: '− ', colour: 'var(--danger)' })}
            ${row(`Less: fixed costs reliable rent won't cover (${fmt(m.monthlyCosts)} costs − ${fmt(m.netExpectedRent)} rent)`, m.uncoveredCosts, { sign: '− ', colour: 'var(--danger)' })}
            ${row('Safe to act today', m.safeToActToday, { strong: true, border: true, colour: lightColour })}
            <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-top:10px;line-height:1.5">
                This figure can never exceed what is in the bank. It is your cash, minus a ${fmt(m.wagesFloat)} wages float, a small timing cushion, and the part of this month's fixed costs your reliable rent will not cover. Maintenance is not reserved — you pay it from this surplus in the order below.
            </div>
        </div>

        <!-- What to do with it -->
        <div class="kpi-card">
            <div class="kpi-card-label" style="margin-bottom:8px">Where it goes (priority order)</div>
            <ol style="margin:0;padding-left:20px;color:var(--text-secondary);font-size:var(--fs-sm);line-height:1.9">
                <li><strong style="color:var(--text-primary)">Protect the floor</strong> — ${fmt(m.floor)} stays put (wages float + timing cushion).</li>
                <li><strong style="color:var(--text-primary)">Consequential payments</strong> — tax, insurance, minimum credit card payments, critical maintenance.</li>
                <li><strong style="color:var(--text-primary)">Highest-interest card</strong> — all remaining surplus (avalanche).</li>
                <li><strong style="color:var(--text-primary)">Deferrable maintenance</strong> — oldest invoices first.</li>
            </ol>
            <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-top:12px;line-height:1.5">
                Invoice triage and the live payment waterfall arrive next. For now this confirms the order: minimum card payments rank above discretionary maintenance and above extra debt paydown.
            </div>
        </div>

    </div>`;
}
