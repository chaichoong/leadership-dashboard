// ══════════════════════════════════════════
// WEALTH — Analysis ratios (Rich Dad personal financial statement)
// ══════════════════════════════════════════
// A READ-ONLY interpretation layer that sits at the bottom of the Wealth tab as a
// collapsible "Analysis" section. It reads figures the page has already computed —
// the live `view` (net worth, assets, liabilities, class totals) plus the same
// transaction-based monthly cash flow (`buildMonthlyCashflow`) — and never writes
// anything back. A bug here can only make a ratio look wrong; it cannot move net
// worth, cash flow, or any figure above it.
//
// The six ratios brought across from Kevin's Kiyosaki personal financial statement:
//   1. Passive income to expenses (the rat-race-escape gauge, target >= 1.00)
//   2. Does your money work for you? (passive + portfolio share of net income)
//   3. How much do you keep? (savings rate = net cash flow / total income)
//   4. Return on assets (net rental income / real estate value — portfolio yield)
//   5. Financial runway (net worth / monthly expenses, in months)
//   6. Debt ratio (liabilities / assets, read against a safe band, not "always down")
//
// CORRECTNESS: passive income is NET (rental income less property costs), never
// gross rent, so the gauges do not read healthier than reality. The earned/passive
// split is derived so it reconciles exactly to the cash flow above:
//   netEarned = (net cash flow + personal expenses) - netPassive
// Portfolio income is not in the transaction feed yet, so it is shown as £0.

// Property-related costs deducted from rental income to reach NET passive income.
// Every entry is a sub-category name already present in CASHFLOW_COST_SUBCATS.
const WEALTH_PROPERTY_COST_SUBCATS = [
    'COGS Property Council Tax', 'COGS Property Utilities',
    'COGS Property Reactive Maintenance', 'COGS Property Compliance',
    'Mortgage Interest',
];

// How many completed months to average over. A trailing window smooths lumpy
// months (a one-off tax or maintenance hit) so the gauges do not swing wildly.
const WEALTH_RATIO_MONTHS = 3;

// Collapsed by default — the section adds nothing to the view on load until opened.
function wealthRatiosOpen() {
    try { return localStorage.getItem('wealthRatios_open') === '1'; } catch (e) { return false; }
}
function toggleWealthRatios() {
    const open = !wealthRatiosOpen();
    try { localStorage.setItem('wealthRatios_open', open ? '1' : '0'); } catch (e) { /* ignore */ }
    const body = document.getElementById('wealthRatiosBody');
    const caret = document.getElementById('wealthRatiosCaret');
    if (body) body.style.display = open ? 'block' : 'none';
    if (caret) caret.textContent = open ? '▾' : '▸';
}

// Net passive income per month = gross rental income − property costs. This is the
// only figure computed independently here; everything else reuses the page's cash
// flow so the split always ties out. Reads allTransactions + allSubCategories (no
// fetch), classifying by sub-category name exactly like buildMonthlyCashflow.
function buildWealthPassiveSplit(monthKeys) {
    const txns = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];
    const subNames = {};
    ((typeof allSubCategories !== 'undefined' && allSubCategories) ? allSubCategories : []).forEach(r => {
        const n = getField(r, 'fldO4BTJhFv5EsN6i'); if (n) subNames[r.id] = String(n);
    });
    const propSet = new Set(WEALTH_PROPERTY_COST_SUBCATS);
    const linkId = f => { if (!f) return null; if (Array.isArray(f)) { const x = f[0]; return x && typeof x === 'object' ? x.id : x; } return typeof f === 'object' ? f.id : f; };
    const set = new Set(monthKeys);
    const byMonth = {};
    monthKeys.forEach(k => byMonth[k] = { grossRental: 0, propertyCosts: 0 });
    txns.forEach(tx => {
        const dateStr = getField(tx, F.txDate); if (!dateStr) return;
        const d = new Date(dateStr); if (isNaN(d)) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!set.has(key)) return;
        const sub = subNames[linkId(getField(tx, F.txSubCategory))] || '';
        const amt = Number(getField(tx, F.txReportAmount)) || 0; // inflow +, outflow −
        const m = byMonth[key];
        if (sub === 'Rental Income') m.grossRental += amt;
        else if (propSet.has(sub)) m.propertyCosts += (-amt); // positive magnitude
    });
    return monthKeys.map(k => byMonth[k]);
}

// Render the collapsible Analysis section into #wealthRatios. `view` is the live
// reconciled net-worth object from renderWealthContent (read-only).
function renderWealthRatios(view) {
    const host = document.getElementById('wealthRatios');
    if (!host) return;

    const header = (open) => `<button onclick="toggleWealthRatios()" aria-expanded="${open}" style="width:100%;display:flex;align-items:center;gap:10px;background:none;border:none;cursor:pointer;text-align:left;padding:0">
            <span id="wealthRatiosCaret" style="color:var(--text-muted);font-size:var(--fs-sm)">${open ? '▾' : '▸'}</span>
            <span style="font-size:var(--fs-lg);font-weight:var(--fw-semibold);color:var(--text-primary)">Analysis — is your money working?</span>
        </button>`;

    // No transactions cached yet → the split cannot be computed. Show a calm empty
    // state rather than a wall of zeroed ratios.
    const txns = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];
    if (!txns.length) {
        host.innerHTML = `<div class="kpi-card" style="margin-bottom:0">
            ${header(wealthRatiosOpen())}
            <div id="wealthRatiosBody" style="display:${wealthRatiosOpen() ? 'block' : 'none'};margin-top:14px;color:var(--text-secondary);font-size:var(--fs-sm)">
                Open the Leadership Dashboard once so your transactions load, then these ratios populate.
            </div></div>`;
        return;
    }

    // Trailing completed months (skip the partial current month).
    const keys = wealthMonthKeys(WEALTH_RATIO_MONTHS, 1);
    const cf = buildMonthlyCashflow(keys);
    const passive = buildWealthPassiveSplit(keys);
    const sum = arr => arr.reduce((s, v) => s + v, 0);

    // Sums over the window (ratio of sums == ratio of averages, but steadier).
    const totalIncome = sum(cf.map(m => m.totalIncome));   // gross money in
    const netCashFlow = sum(cf.map(m => m.net));           // after business + personal costs
    const personalExp = sum(cf.map(m => m.perTotal));      // personal expenditure
    const grossRental = sum(passive.map(m => m.grossRental));
    const propertyCosts = sum(passive.map(m => m.propertyCosts));
    const netPassive = grossRental - propertyCosts;
    const portfolio = 0;                                    // investment income not fed in yet
    // Reconciles to the cash flow: netEarned = (net + personal expenses) − netPassive.
    const netEarned = (netCashFlow + personalExp) - netPassive - portfolio;
    const netIncome = netEarned + netPassive + portfolio;  // == netCashFlow + personalExp

    const months = WEALTH_RATIO_MONTHS;
    const avgExp = personalExp / months;
    const monthLabel = `${wealthMonthLabel(keys[0]).replace(/ \d{4}$/, '')}–${wealthMonthLabel(keys[keys.length - 1])}`;

    // ── formatting + colour helpers ──
    const pct = (n, d) => (d && d > 0) ? Math.round((n / d) * 100) : null;
    const pctStr = v => v == null ? '—' : `${v}%`;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const C = { good: 'var(--success)', mid: 'var(--accent-gold)', low: 'var(--text-secondary)', bad: 'var(--danger)' };

    // ── 1. Passive income to expenses (the hero) ──
    // Both sides are the 3-month window total, so the ratio is the true monthly cover.
    const p2eRaw = personalExp > 0 ? (netPassive / personalExp) : null; // 1.0 == passive covers all expenses
    const p2ePct = p2eRaw == null ? null : Math.round(p2eRaw * 100);
    const p2eColour = p2eRaw == null ? C.low : (p2eRaw >= 1 ? C.good : (p2eRaw >= 0.5 ? C.mid : C.low));
    const p2eBar = p2eRaw == null ? 0 : clamp(Math.round(p2eRaw * 100), 0, 100);
    const p2eMsg = p2eRaw == null ? 'Add personal expense data to see this.'
        : p2eRaw >= 1 ? 'Your net rental income covers your personal expenses. Work is optional on this measure.'
        : `Net rental income covers ${p2ePct}% of your personal expenses. At 100% work becomes optional.`;
    const heroHtml = `<div style="border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:var(--space-4);background:var(--bg-surface-2);margin-bottom:var(--space-4)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
            <div style="font-weight:var(--fw-semibold);color:var(--text-primary)">Passive income vs expenses</div>
            <div style="font-size:var(--fs-xs);color:var(--text-muted)">target 100% · rat-race escape</div>
        </div>
        <div style="font-size:var(--fs-3xl);font-weight:var(--fw-bold);color:${p2eColour};line-height:1.1;margin:6px 0">${pctStr(p2ePct)}</div>
        <div style="height:10px;background:var(--bg-subtle);border-radius:var(--radius-full);overflow:hidden;margin-bottom:8px">
            <div style="height:100%;width:${p2eBar}%;background:${p2eColour};border-radius:var(--radius-full)"></div>
        </div>
        <div style="font-size:var(--fs-sm);color:var(--text-secondary);line-height:1.5">${escHtml(p2eMsg)}</div>
        <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:8px">Net passive ${fmt0(netPassive / months)}/mo · expenses ${fmt0(avgExp)}/mo · avg of ${months} months</div>
    </div>`;

    // ── the other five as compact ratio cards ──
    const card = (label, value, colour, target, meaning) => `<div class="kpi-card" style="margin-bottom:0">
        <div class="kpi-card-label" style="margin-bottom:4px">${escHtml(label)}</div>
        <div style="font-size:var(--fs-2xl);font-weight:var(--fw-bold);color:${colour};line-height:1.1">${value}</div>
        <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:4px">${escHtml(target)}</div>
        <div style="font-size:var(--fs-xs);color:var(--text-secondary);margin-top:8px;line-height:1.5">${escHtml(meaning)}</div>
    </div>`;

    // 2. Does your money work for you? — passive+portfolio share of net income
    const workRaw = netIncome > 0 ? ((netPassive + portfolio) / netIncome) : null;
    const workPct = workRaw == null ? null : Math.round(workRaw * 100);
    const workColour = workRaw == null ? C.low : (workRaw >= 0.5 ? C.good : (workRaw >= 0.25 ? C.mid : C.low));
    const c2 = card('Does your money work for you?', pctStr(workPct), workColour, 'share of income that is passive · higher is better',
        workRaw == null ? 'Needs a positive net income month to read.' : `${workPct}% of your net income arrives without active work. The rest is earned.`);

    // 3. How much do you keep? — savings rate
    const keepRaw = totalIncome > 0 ? (netCashFlow / totalIncome) : null;
    const keepPct = keepRaw == null ? null : Math.round(keepRaw * 100);
    const keepColour = keepRaw == null ? C.low : (keepRaw >= 0.2 ? C.good : (keepRaw >= 0.1 ? C.mid : (keepRaw >= 0 ? C.low : C.bad)));
    const c3 = card('How much do you keep?', pctStr(keepPct), keepColour, 'net cash flow ÷ total income · higher is better',
        keepRaw == null ? 'Needs income in the window to read.' : `You keep ${keepPct}p of every £1 that comes in after all costs.`);

    // 4. Return on assets — net rental yield on the property value
    const reValue = (view && view.byClass && view.byClass['Real Estate']) || 0;
    const roaRaw = reValue > 0 ? ((netPassive / months) * 12 / reValue) : null;
    const roaPct = roaRaw == null ? null : (roaRaw * 100);
    const roaStr = roaPct == null ? '—' : `${roaPct.toFixed(1)}%`;
    const roaColour = roaRaw == null ? C.low : (roaRaw >= 0.05 ? C.good : (roaRaw >= 0.03 ? C.mid : C.low));
    const c4 = card('Return on assets', roaStr, roaColour, 'net rental ÷ property value · yearly',
        roaRaw == null ? 'Needs a property value to read.' : `Your ${fmt0(reValue)} of property returns ${roaStr} a year net. Low yield flags lazy equity to refinance or sell.`);

    // 5. Financial runway — months of expenses covered by net worth
    const runwayMonths = avgExp > 0 ? (view.net / avgExp) : null;
    const runwayStr = runwayMonths == null ? '—' : (runwayMonths >= 24 ? `${(runwayMonths / 12).toFixed(1)} yrs` : `${Math.round(runwayMonths)} mo`);
    const runwayColour = runwayMonths == null ? C.low : (runwayMonths >= 120 ? C.good : (runwayMonths >= 36 ? C.mid : C.low));
    const c5 = card('Financial runway', runwayStr, runwayColour, 'net worth ÷ monthly expenses',
        runwayMonths == null ? 'Needs expense data to read.' : `Your net worth would cover ${Math.round(runwayMonths)} months of expenses if all income stopped.`);

    // 6. Debt ratio — liabilities against assets, read against a safe band
    const debtRaw = (view.assets > 0) ? (view.liabilities / view.assets) : null;
    const debtPct = debtRaw == null ? null : Math.round(debtRaw * 100);
    const debtColour = debtRaw == null ? C.low : (debtRaw <= 0.5 ? C.good : (debtRaw <= 0.75 ? C.mid : C.bad));
    const mortgages = (view.byClass && view.byClass['Mortgages']) || 0;
    const propLtv = reValue > 0 ? Math.round((mortgages / reValue) * 100) : null;
    const debtBand = debtRaw == null ? '' : (debtRaw <= 0.5 ? 'strong' : (debtRaw <= 0.75 ? 'moderate' : 'stretched'));
    const c6 = card('Debt ratio', pctStr(debtPct), debtColour, 'liabilities ÷ assets · safe band under 75%',
        debtRaw == null ? 'Needs asset data to read.' : `${debtPct}% of your assets are financed (${debtBand})${propLtv != null ? `. Property LTV ${propLtv}%` : ''}. Leverage is a tool, so watch the band, not just the direction.`);

    const grid = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--space-4);margin-bottom:var(--space-4)">
        ${c2}${c3}${c4}${c5}${c6}
    </div>`;

    // ── Income by source (net) — a stacked bar + figures ──
    const srcTotal = Math.max(netEarned, 0) + Math.max(netPassive, 0) + Math.max(portfolio, 0);
    const seg = (val, colour) => srcTotal > 0 ? `<div style="width:${clamp(Math.round((Math.max(val, 0) / srcTotal) * 100), 0, 100)}%;background:${colour};height:100%"></div>` : '';
    const srcRow = (label, val, colour) => `<div style="display:flex;justify-content:space-between;align-items:center;font-size:var(--fs-sm);padding:3px 0">
            <span style="color:var(--text-secondary)"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colour};margin-right:8px"></span>${escHtml(label)}</span>
            <span style="font-weight:var(--fw-semibold);color:var(--text-primary)">${fmt0(val / months)}/mo</span>
        </div>`;
    const splitHtml = `<div style="border:1px solid var(--border-subtle);border-radius:var(--radius-lg);padding:var(--space-4);margin-bottom:var(--space-3)">
        <div style="font-weight:var(--fw-semibold);color:var(--text-primary);margin-bottom:10px">Income by source (net, per month)</div>
        <div style="display:flex;height:12px;border-radius:var(--radius-full);overflow:hidden;background:var(--bg-subtle);margin-bottom:12px">
            ${seg(netEarned, 'var(--tone-olive)')}${seg(netPassive, 'var(--tone-sage)')}${seg(portfolio, 'var(--tone-blue)')}
        </div>
        ${srcRow('Earned (active work)', netEarned, 'var(--tone-olive)')}
        ${srcRow('Passive (net rental)', netPassive, 'var(--tone-sage)')}
        ${srcRow('Portfolio (investments)', portfolio, 'var(--tone-blue)')}
        <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:10px;line-height:1.5">Net of the costs each source carries, so it differs from the gross Total income line above. Portfolio income is not in your transaction feed yet, so it reads £0 until investment income is fed in.</div>
    </div>`;

    const note = `<div style="font-size:var(--fs-xs);color:var(--text-muted);line-height:1.6;margin-top:6px">Based on the last ${months} completed months (${escHtml(monthLabel)}). Passive income is net rental (rent less council tax, utilities, maintenance, compliance and mortgage interest). Balances (net worth, assets, debt) are today's live figures. Read-only — nothing here changes the numbers above.</div>`;

    host.innerHTML = `<div class="kpi-card" style="margin-bottom:0">
        ${header(wealthRatiosOpen())}
        <div id="wealthRatiosBody" style="display:${wealthRatiosOpen() ? 'block' : 'none'};margin-top:16px">
            ${heroHtml}
            ${grid}
            ${splitHtml}
            ${note}
        </div>
    </div>`;
}
