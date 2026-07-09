// ══════════════════════════════════════════
// WEALTH — Analysis ratios (Rich Dad personal financial statement)
// ══════════════════════════════════════════
// A READ-ONLY interpretation layer at the bottom of the Wealth tab, collapsible
// and collapsed by default. It reads figures the page already computes (the live
// `view`, the transaction-based monthly cash flow, and the net-worth snapshots)
// and never writes back. A bug here can only make a ratio look wrong; it cannot
// move net worth, cash flow, or any figure above it.
//
// INCOME MODEL (locked with Kevin 2026-07-09). His Wealth statement entwines
// business and personal because the portfolio sits in his personal name:
//   money in  = Earned + Passive + Portfolio
//   money out = business expenditure + personal expenditure
//   net cash flow = cash money in − money out   (Portfolio is NOT in this — it is
//                                                never withdrawn, so no cash moves)
//
//   Earned    = active/worked income: Personal Income Other (wife's salary + child
//               benefit) + any business revenue (Fixed/Variable Income). OD income
//               is earned in the early stage; it moves to Passive once it runs
//               without Kevin working for it.
//   Passive   = GROSS rental income (the full rent). Property costs and mortgages
//               are already captured in money out, so rent is counted gross here.
//   Portfolio = the month-on-month RISE in investment value, minus Kevin's own
//               contributions (sub-category "Personal Investment"), so only what
//               the investments themselves earned is counted. It is income he has
//               earned but chosen to reinvest, so it is non-cash: it lands in net
//               worth via the rising Investments asset line, never in cash.
//
// PORTFOLIO TREATMENT PER METRIC (all labelled on the page):
//   Net cash flow / Savings rate  → EXCLUDED (cash measures; it is never withdrawn)
//   Income by source              → INCLUDED as its own non-cash line
//   Does your money work          → INCLUDED (it is money your money made)
//   Passive vs expenses (rat-race)→ EXCLUDED (rental only — reliable, not volatile)
//   Return on assets              → INCLUDED as its own line + a blended line
//   Financial runway / Debt ratio → reflected via net worth / assets (Investments)

// Sub-category that records investment contributions (money Kevin pays IN to the
// portfolio). Subtracted from the investment-value rise so top-ups are not counted
// as earnings. None exist today; the logic is correct for when they start.
const WEALTH_CONTRIBUTION_SUBCAT = 'Personal Investment';
const WEALTH_RENTAL_SUBCAT = 'Rental Income';

// Trailing completed months to average over — smooths lumpy months.
const WEALTH_RATIO_MONTHS = 3;

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

// Per-month transaction aggregates the cash flow does not expose: gross rental
// (to split it out of business revenue) and investment contributions. Reads
// allTransactions + allSubCategories (no fetch), classifying by sub-category name
// exactly like buildMonthlyCashflow so the figures reconcile.
function buildWealthTxAgg(monthKeys) {
    const txns = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];
    const subNames = {};
    ((typeof allSubCategories !== 'undefined' && allSubCategories) ? allSubCategories : []).forEach(r => {
        const n = getField(r, 'fldO4BTJhFv5EsN6i'); if (n) subNames[r.id] = String(n);
    });
    const linkId = f => { if (!f) return null; if (Array.isArray(f)) { const x = f[0]; return x && typeof x === 'object' ? x.id : x; } return typeof f === 'object' ? f.id : f; };
    const set = new Set(monthKeys);
    const byMonth = {};
    monthKeys.forEach(k => byMonth[k] = { grossRental: 0, contributions: 0 });
    txns.forEach(tx => {
        const dateStr = getField(tx, F.txDate); if (!dateStr) return;
        const d = new Date(dateStr); if (isNaN(d)) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!set.has(key)) return;
        const sub = subNames[linkId(getField(tx, F.txSubCategory))] || '';
        const amt = Number(getField(tx, F.txReportAmount)) || 0; // inflow +, outflow −
        const m = byMonth[key];
        if (sub === WEALTH_RENTAL_SUBCAT) m.grossRental += amt;
        else if (sub === WEALTH_CONTRIBUTION_SUBCAT) m.contributions += Math.abs(amt); // money paid in
    });
    return monthKeys.map(k => byMonth[k]);
}

// A small inline-SVG sparkline for a metric's 12-month history. `vals` is an array
// (nulls allowed for gaps); the line is scaled to its own min/max so movement is
// visible even on small ranges. The last point is marked. Returns '' if there is
// not enough history to draw a line.
function wealthSparkline(vals) {
    const pts = (vals || []).map((v, i) => ({ i, v })).filter(p => p.v != null && isFinite(p.v));
    if (pts.length < 2) return '';
    const xs = Math.max(1, (vals.length - 1));
    const lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
    const range = (hi - lo) || 1;
    const W = 132, H = 30, pad = 3;
    const x = i => pad + (i / xs) * (W - 2 * pad);
    const y = v => pad + (1 - (v - lo) / range) * (H - 2 * pad);
    const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;margin-top:8px" aria-hidden="true">
        <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="2.4" fill="var(--accent)"/>
    </svg>`;
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

    const txns = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];
    if (!txns.length) {
        host.innerHTML = `<div class="kpi-card" style="margin-bottom:0">
            ${header(wealthRatiosOpen())}
            <div id="wealthRatiosBody" style="display:${wealthRatiosOpen() ? 'block' : 'none'};margin-top:14px;color:var(--text-secondary);font-size:var(--fs-sm)">
                Open the Leadership Dashboard once so your transactions load, then these ratios populate.
            </div></div>`;
        return;
    }

    const months = WEALTH_RATIO_MONTHS;
    const keys = wealthMonthKeys(months, 1);          // trailing completed months
    const cf = buildMonthlyCashflow(keys);
    const agg = buildWealthTxAgg(keys);
    const sum = arr => arr.reduce((s, v) => s + v, 0);

    // ── money in (cash) ──
    const grossRental = sum(agg.map(m => m.grossRental));                 // Passive
    const cashIncome = sum(cf.map(m => m.totalIncome));                   // Earned + Passive
    const earned = cashIncome - grossRental;                             // Earned (worked income)
    const passive = grossRental;
    // ── money out ──
    const personalExp = sum(cf.map(m => m.perTotal));
    const businessExp = sum(cf.map(m => (m.bizTotal || 0)));
    const totalOut = personalExp + businessExp;
    const netCashFlow = sum(cf.map(m => m.net));                          // cash only

    // ── Portfolio income (non-cash): growth of the investment value less contributions ──
    // Investments are updated manually and often carry forward, so a fixed 3-month
    // window usually shows no change. Instead measure across every investment snapshot
    // we have (earliest with a value → latest), subtract contributions over that span,
    // and express it per month. As monthly updates become regular this tightens.
    const periods = (typeof computeNetWorth === 'function' && typeof _wealthRecords !== 'undefined' && _wealthRecords)
        ? computeNetWorth(_wealthRecords) : [];
    const invPeriods = periods.filter(p => p.byClass && p.byClass['Investments'] > 0).sort((a, b) => a.sortKey - b.sortKey);
    let portfolioPerMonth = 0, portfolioKnown = false, portfolioSpanMonths = 0, portfolioFromLabel = '';
    let invValueNow = (view && view.byClass && view.byClass['Investments']) || 0;
    if (invPeriods.length >= 2) {
        const first = invPeriods[0], last = invPeriods[invPeriods.length - 1];
        portfolioSpanMonths = last.sortKey - first.sortKey;
        if (!invValueNow) invValueNow = last.byClass['Investments'];
        if (portfolioSpanMonths > 0) {
            const spanKeys = [];
            for (let sk = first.sortKey; sk <= last.sortKey; sk++) spanKeys.push(`${Math.floor(sk / 12)}-${String((sk % 12) + 1).padStart(2, '0')}`);
            const spanContrib = sum(buildWealthTxAgg(spanKeys).map(m => m.contributions));
            const growth = last.byClass['Investments'] - first.byClass['Investments'] - spanContrib;
            portfolioPerMonth = Math.max(0, growth / portfolioSpanMonths);
            portfolioKnown = true;
            portfolioFromLabel = wealthMonthLabel(spanKeys[0]);
        }
    }
    // Express portfolio on the same monthly basis as the cash flows so money-in adds up.
    const portfolio = portfolioPerMonth * months;

    const moneyIn = earned + passive + portfolio;

    const monthLabel = `${wealthMonthLabel(keys[0]).replace(/ \d{4}$/, '')}–${wealthMonthLabel(keys[keys.length - 1])}`;
    const avgOut = totalOut / months;

    // ── helpers ──
    const pctStr = v => v == null ? '—' : `${Math.round(v)}%`;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const C = { good: 'var(--success)', mid: 'var(--accent-gold)', low: 'var(--text-secondary)', bad: 'var(--danger)' };

    // ── Month-by-month: recompute every metric for each of the rolling 12 months, each
    // as a SINGLE-MONTH figure calculated at that month's end (June's column is June's
    // figures), matching how money-in / money-out and the other matrices work. Feeds
    // both the sparkline on each card and the "Ratios — month by month" table below,
    // whose Δ column uses the trend selector at the top of the tab. Precomputed once. ──
    const tMonths = (typeof wealthMonths12 === 'function') ? wealthMonths12() : keys.map(k => ({ key: k, label: k }));
    const tKeys = tMonths.map(m => m.key);
    const tCf = buildMonthlyCashflow(tKeys);
    const tAgg = buildWealthTxAgg(tKeys);
    const skOf = k => { const [y, mo] = k.split('-').map(Number); return y * 12 + (mo - 1); };
    const snapAt = sk => { let best = null; (periods || []).forEach(p => { if (p.sortKey <= sk && (!best || p.sortKey > best.sortKey)) best = p; }); return best; };
    const invAt = sk => { const s = snapAt(sk); return s ? (s.byClass['Investments'] || 0) : null; };
    const metricAt = i => {
        const cfm = tCf[i] || {}, aggm = tAgg[i] || {};
        const gRent = aggm.grossRental || 0;
        const totInc = cfm.totalIncome || 0;
        const earnedM = totInc - gRent, passiveM = gRent;
        const outM = (cfm.bizTotal || 0) + (cfm.perTotal || 0);
        const perM = cfm.perTotal || 0;
        const netM = cfm.net || 0;
        const contribM = aggm.contributions || 0;
        const sk = skOf(tKeys[i]);
        const invEnd = invAt(sk), invPrev = invAt(sk - 1);
        const portM = (invEnd != null && invPrev != null) ? Math.max(0, invEnd - invPrev - contribM) : 0;
        const moneyInM = earnedM + passiveM + portM;
        const snap = snapAt(sk);
        const reM = snap ? (snap.byClass['Real Estate'] || 0) : 0;
        const invM = invEnd || 0;
        return {
            p2e: outM > 0 ? passiveM / outM * 100 : null,
            work: moneyInM > 0 ? (passiveM + portM) / moneyInM * 100 : null,
            keep: totInc > 0 ? netM / totInc * 100 : null,
            roa: (reM + invM) > 0 ? (passiveM + portM) * 12 / (reM + invM) * 100 : null,
            runway: (perM > 0 && snap && snap.net != null) ? snap.net / perM : null,
            debt: (snap && snap.assets > 0) ? snap.liabilities / snap.assets * 100 : null,
        };
    };
    const trend = { p2e: [], work: [], keep: [], roa: [], runway: [], debt: [] };
    for (let i = 0; i < tKeys.length; i++) { const mm = metricAt(i); Object.keys(trend).forEach(k => trend[k].push(mm[k])); }
    const trendCaption = '<div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:2px">12-month trend</div>';
    const sparkBlock = vals => { const svg = wealthSparkline(vals); return svg ? svg + trendCaption : ''; };

    // Month-by-month ratios table (same component + trend selector as the rest of the page).
    const pf = v => `${Math.round(v)}%`;
    const runFmt = v => v >= 24 ? `${(v / 12).toFixed(1)}y` : `${Math.round(v)}m`;
    const ratiosMatrix = (typeof wealthMatrixCard === 'function') ? wealthMatrixCard(
        'Ratios — month by month',
        'Each ratio at the end of each month. Use the trend selector at the top of the tab to set the Δ column period. The current month (●) is still in progress. Single-month figures are naturally more jerky than the smoothed headline above.',
        tMonths,
        [{ header: '', rows: [
            { label: 'Passive vs money out', values: trend.p2e, goodUp: true, fmt: pf },
            { label: 'Money working', values: trend.work, goodUp: true, fmt: pf },
            { label: 'How much you keep', values: trend.keep, goodUp: true, fmt: pf },
            { label: 'Return on assets (blended)', values: trend.roa, goodUp: true, fmt: pf },
            { label: 'Financial runway', values: trend.runway, goodUp: true, fmt: runFmt },
            { label: 'Debt ratio', values: trend.debt, goodUp: false, fmt: pf },
        ] }],
        { anchor: 'completed' }) : '';

    // Top banner — states the portfolio treatment once, plainly.
    const banner = `<div style="background:var(--info-bg,var(--accent-soft));border:1px solid var(--info,var(--accent));border-radius:var(--radius-md);padding:10px 14px;margin-bottom:var(--space-4);font-size:var(--fs-xs);color:var(--text-secondary);line-height:1.55">
        <strong style="color:var(--text-primary)">How portfolio income is treated:</strong> it is your investments' monthly growth, minus anything you paid in. You have not withdrawn it, so it counts as income and net worth but not as cash. It is excluded from net cash flow and the savings rate, and included in "money working" and return on assets.
    </div>`;

    // ── 1. Passive vs expenses (hero) — rental only ÷ total money out ──
    const p2eRaw = totalOut > 0 ? (passive / totalOut) : null;
    const p2ePct = p2eRaw == null ? null : Math.round(p2eRaw * 100);
    const p2eColour = p2eRaw == null ? C.low : (p2eRaw >= 1 ? C.good : (p2eRaw >= 0.5 ? C.mid : C.low));
    const p2eBar = p2eRaw == null ? 0 : clamp(Math.round(p2eRaw * 100), 0, 100);
    const p2eMsg = p2eRaw == null ? 'Not enough data yet to show this.'
        : p2eRaw >= 1 ? 'Your rental income covers all your money out. Work is optional on this measure.'
        : `Your rental income covers ${p2ePct}% of your total money out. At 100% work becomes optional.`;
    const heroHtml = `<div style="border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:var(--space-4);background:var(--bg-surface-2);margin-bottom:var(--space-4)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
            <div style="font-weight:var(--fw-semibold);color:var(--text-primary)">Passive income vs money out</div>
            <div style="font-size:var(--fs-xs);color:var(--text-muted)">target 100% · rat-race escape</div>
        </div>
        <div style="font-size:var(--fs-3xl);font-weight:var(--fw-bold);color:${p2eColour};line-height:1.1;margin:6px 0">${pctStr(p2ePct)}</div>
        <div style="height:10px;background:var(--bg-subtle);border-radius:var(--radius-full);overflow:hidden;margin-bottom:8px">
            <div style="height:100%;width:${p2eBar}%;background:${p2eColour};border-radius:var(--radius-full)"></div>
        </div>
        <div style="font-size:var(--fs-sm);color:var(--text-secondary);line-height:1.5">${escHtml(p2eMsg)}</div>
        <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:8px">Rental income ${fmt0(passive / months)}/mo ÷ total money out ${fmt0(avgOut)}/mo (business + personal), each averaged over the last ${months} completed months. Rental only; portfolio growth is excluded here as it is volatile and reinvested.</div>
        ${sparkBlock(trend.p2e)}
    </div>`;

    // ── compact metric card (with optional 12-month trend sparkline) ──
    const card = (label, value, colour, method, meaning, spark) => `<div class="kpi-card" style="margin-bottom:0">
        <div class="kpi-card-label" style="margin-bottom:4px">${escHtml(label)}</div>
        <div style="font-size:var(--fs-2xl);font-weight:var(--fw-bold);color:${colour};line-height:1.1">${value}</div>
        <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:4px">${escHtml(method)}</div>
        <div style="font-size:var(--fs-xs);color:var(--text-secondary);margin-top:8px;line-height:1.5">${escHtml(meaning)}</div>
        ${spark || ''}
    </div>`;

    // 2. Does your money work for you? — (passive + portfolio) share of money in
    const workRaw = moneyIn > 0 ? ((passive + portfolio) / moneyIn) : null;
    const workPct = workRaw == null ? null : Math.round(workRaw * 100);
    const workColour = workRaw == null ? C.low : (workRaw >= 0.5 ? C.good : (workRaw >= 0.25 ? C.mid : C.low));
    const c2 = card('Does your money work for you?', pctStr(workPct == null ? null : workPct), workColour,
        'passive + portfolio ÷ all money in · includes portfolio',
        workRaw == null ? 'Needs income in the window to read.' : `${workPct}% of your income is passive and portfolio income, not earned income.`,
        sparkBlock(trend.work));

    // 3. How much do you keep? — savings rate (cash only)
    const keepRaw = cashIncome > 0 ? (netCashFlow / cashIncome) : null;
    const keepPct = keepRaw == null ? null : Math.round(keepRaw * 100);
    const keepColour = keepRaw == null ? C.low : (keepRaw >= 0.2 ? C.good : (keepRaw >= 0.1 ? C.mid : (keepRaw >= 0 ? C.low : C.bad)));
    const c3 = card('How much do you keep?', pctStr(keepPct), keepColour,
        'net cash flow ÷ money in (earned + passive) · portfolio excluded',
        keepRaw == null ? 'Needs income in the window to read.' : `You keep ${keepPct}p of every £1 of cash that comes in after all costs.`,
        sparkBlock(trend.keep));

    // 4. Return on assets — property yield, investment return, blended
    const reValue = (view && view.byClass && view.byClass['Real Estate']) || 0;
    const yieldPct = (income, asset) => (asset > 0) ? ((income / months) * 12 / asset * 100) : null;
    const propY = yieldPct(passive, reValue);
    const invY = yieldPct(portfolio, invValueNow);
    const blendY = yieldPct(passive + portfolio, reValue + invValueNow);
    const yStr = v => v == null ? '—' : `${v.toFixed(1)}%`;
    const roaColour = blendY == null ? C.low : (blendY >= 0.05 * 100 ? C.good : (blendY >= 0.03 * 100 ? C.mid : C.low));
    const roaLine = (lbl, v) => `<div style="display:flex;justify-content:space-between;font-size:var(--fs-sm);padding:2px 0"><span style="color:var(--text-secondary)">${escHtml(lbl)}</span><span style="font-weight:var(--fw-semibold);color:var(--text-primary)">${yStr(v)}</span></div>`;
    const c4 = `<div class="kpi-card" style="margin-bottom:0">
        <div class="kpi-card-label" style="margin-bottom:6px">Return on assets</div>
        ${roaLine('Property yield (gross rent)', propY)}
        ${roaLine('Investment return (portfolio)', invY)}
        <div style="border-top:1px solid var(--border-subtle);margin-top:4px;padding-top:4px">${roaLine('Blended (all assets)', blendY)}</div>
        <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:6px">yearly income each asset makes ÷ its value. Blended combines both. Property yield = gross rent × 12 ÷ property value. Investment return is annualised from your investment history${portfolioFromLabel ? ` (since ${escHtml(portfolioFromLabel)})` : ''} and swings with the market.</div>
        ${sparkBlock(trend.roa)}
    </div>`;

    // 5. Financial runway — net worth ÷ PERSONAL monthly money out. If you sold up,
    // business outgoings would stop but personal costs would continue, so runway is
    // measured against personal expenditure only.
    const avgPersonalOut = personalExp / months;
    const runwayMonths = avgPersonalOut > 0 ? (view.net / avgPersonalOut) : null;
    const runwayStr = runwayMonths == null ? '—' : (runwayMonths >= 24 ? `${(runwayMonths / 12).toFixed(1)} yrs` : `${Math.round(runwayMonths)} mo`);
    const runwayColour = runwayMonths == null ? C.low : (runwayMonths >= 120 ? C.good : (runwayMonths >= 36 ? C.mid : C.low));
    const c5 = card('Financial runway', runwayStr, runwayColour,
        'net worth ÷ monthly personal money out',
        runwayMonths == null ? 'Needs personal-spend data to read.' : `Your net worth would cover ${Math.round(runwayMonths)} months of personal spending if all income stopped (business costs would stop too, so they are excluded).`,
        sparkBlock(trend.runway));

    // 6. Debt ratio — liabilities ÷ assets, safe band
    const debtRaw = (view.assets > 0) ? (view.liabilities / view.assets) : null;
    const debtPct = debtRaw == null ? null : Math.round(debtRaw * 100);
    const debtColour = debtRaw == null ? C.low : (debtRaw <= 0.5 ? C.good : (debtRaw <= 0.75 ? C.mid : C.bad));
    const mortgages = (view.byClass && view.byClass['Mortgages']) || 0;
    const propLtv = reValue > 0 ? Math.round((mortgages / reValue) * 100) : null;
    const debtBand = debtRaw == null ? '' : (debtRaw <= 0.5 ? 'strong' : (debtRaw <= 0.75 ? 'moderate' : 'stretched'));
    const c6 = card('Debt ratio', pctStr(debtPct), debtColour,
        'liabilities ÷ total assets · safe band under 75%',
        debtRaw == null ? 'Needs asset data to read.' : `${debtPct}% of your assets are financed (${debtBand})${propLtv != null ? `. Property LTV ${propLtv}%` : ''}. Leverage is a tool, so watch the band, not just the direction.`,
        sparkBlock(trend.debt));

    const grid = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--space-4);margin-bottom:var(--space-4)">
        ${c2}${c3}${c4}${c5}${c6}
    </div>`;

    // ── Income by source — averaged per month over the period set by the top selector ──
    // All three lines use the SAME selected window (1/3/6/9/12 months) so they are
    // consistent: earned + passive from that window's cash flow, portfolio from the
    // investment-value change across the same window. A month with no growth reads £0.
    const srcMonths = (typeof _wealthChangeMonths === 'number' && _wealthChangeMonths > 0) ? _wealthChangeMonths : months;
    const sKeys = wealthMonthKeys(srcMonths, 1);
    const sCf = buildMonthlyCashflow(sKeys);
    const sAgg = buildWealthTxAgg(sKeys);
    const sGrossRental = sum(sAgg.map(m => m.grossRental));
    const sCashIncome = sum(sCf.map(m => m.totalIncome));
    const srcEarned = (sCashIncome - sGrossRental) / srcMonths;   // per month
    const srcPassive = sGrossRental / srcMonths;                  // per month
    // Portfolio over the SAME window: investment value at the end minus at the start
    // (the month before the window), less contributions, per month. Falls back to the
    // earliest snapshot if the window starts before any investment data.
    const sInvEnd = invAt(skOf(sKeys[sKeys.length - 1]));
    let sInvStart = invAt(skOf(sKeys[0]) - 1);
    if (sInvStart == null && invPeriods.length) sInvStart = invPeriods[0].byClass['Investments'];
    const sContrib = sum(sAgg.map(m => m.contributions));
    const srcPortfolio = (sInvEnd != null && sInvStart != null) ? Math.max(0, sInvEnd - sInvStart - sContrib) / srcMonths : 0;
    const srcTotal = Math.max(srcEarned, 0) + Math.max(srcPassive, 0) + Math.max(srcPortfolio, 0);
    const seg = (val, colour) => srcTotal > 0 ? `<div style="width:${clamp(Math.round((Math.max(val, 0) / srcTotal) * 100), 0, 100)}%;background:${colour};height:100%"></div>` : '';
    const srcRow = (label, val, colour, tag) => `<div style="display:flex;justify-content:space-between;align-items:center;font-size:var(--fs-sm);padding:3px 0">
            <span style="color:var(--text-secondary)"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colour};margin-right:8px"></span>${escHtml(label)}${tag ? ` <span style="color:var(--text-muted);font-size:var(--fs-xs)">${escHtml(tag)}</span>` : ''}</span>
            <span style="font-weight:var(--fw-semibold);color:var(--text-primary)">${fmt0(val)}/mo</span>
        </div>`;
    const splitHtml = `<div style="border:1px solid var(--border-subtle);border-radius:var(--radius-lg);padding:var(--space-4);margin-bottom:var(--space-3)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:10px">
            <span style="font-weight:var(--fw-semibold);color:var(--text-primary)">Income by source, average per month</span>
            <span style="font-size:var(--fs-xs);color:var(--text-muted)">over the last ${srcMonths} month${srcMonths === 1 ? '' : 's'} · set by the trend selector</span>
        </div>
        <div style="display:flex;height:12px;border-radius:var(--radius-full);overflow:hidden;background:var(--bg-subtle);margin-bottom:12px">
            ${seg(srcEarned, 'var(--tone-olive)')}${seg(srcPassive, 'var(--tone-sage)')}${seg(srcPortfolio, 'var(--tone-blue)')}
        </div>
        ${srcRow('Earned (worked income)', srcEarned, 'var(--tone-olive)')}
        ${srcRow('Passive (gross rental)', srcPassive, 'var(--tone-sage)')}
        ${srcRow('Portfolio (investment growth)', srcPortfolio, 'var(--tone-blue)', 'reinvested, non-cash')}
        <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:10px;line-height:1.5">All three are averaged over the last ${srcMonths} month${srcMonths === 1 ? '' : 's'} (change the period with the selector at the top of the tab). Earned = worked income (Personal Income Other + any business revenue). Passive = gross rental (property costs sit in money out). Portfolio = your investment growth across that period, less contributions; reinvested, so it is income and net worth but not cash. A period with no investment update shows £0.</div>
    </div>`;

    const note = `<div style="font-size:var(--fs-xs);color:var(--text-muted);line-height:1.6;margin-top:6px">The headline figures above use the last ${months} completed months (${escHtml(monthLabel)}) for income and costs, and today's figures for net worth, assets and debt. The month-by-month table and the income split use the period you set with the selector at the top. Read-only — nothing here changes the numbers above.</div>`;

    host.innerHTML = `<div class="kpi-card" style="margin-bottom:0">
        ${header(wealthRatiosOpen())}
        <div id="wealthRatiosBody" style="display:${wealthRatiosOpen() ? 'block' : 'none'};margin-top:16px">
            ${banner}
            ${heroHtml}
            ${grid}
            ${ratiosMatrix}
            ${splitHtml}
            ${note}
        </div>
    </div>`;
}
