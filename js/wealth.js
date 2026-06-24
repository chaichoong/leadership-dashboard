// ══════════════════════════════════════════
// WEALTH — Net Worth statement (+ income buckets, added next)
// ══════════════════════════════════════════
//
// Purpose: keep Kevin on top of net worth. Reads his Airtable Wealth OS
// (Specific Net Worth Statement by Month) and shows total net worth, the
// six-class breakdown (assets minus liabilities), and the month-on-month trend.
//
// ISOLATION: new, additive tab. Does NOT modify any existing tab. It fetches
// its own data (the net worth table is not in the dashboard globals) and reuses
// shared helpers (airtableFetch, getField, fmt, escHtml).
//
// DATA NOTE: the net worth snapshots are entered monthly in Airtable. The view
// is labelled "as of <latest month>". A small live-cash line shows current
// synced bank balances for comparison. Fully live computation (live cash/credit
// /loan classification) needs the account-type field — a later task.

const WEALTH_MONTH_INDEX = {
    January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
    July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

let _wealthRecords = null;
let _wealthPromise = null;

// ── Engine ───────────────────────────────────────────────────────────────────
// Group rows by month, sum by class, derive assets / liabilities / net worth.
function computeNetWorth(records) {
    const periods = {};
    (records || []).forEach(r => {
        const type = getField(r, NW.type);
        if (!type) return;
        const month = getField(r, NW.month);
        const year = getField(r, NW.year);
        if (!month || !year) return;
        const mi = WEALTH_MONTH_INDEX[month];
        if (mi === undefined) return;
        const yr = parseInt(year, 10);
        const amount = Number(getField(r, NW.amount)) || 0;
        const key = year + '-' + month;
        if (!periods[key]) periods[key] = { year: yr, month, monthIdx: mi, sortKey: yr * 12 + mi, byClass: {}, items: {} };
        periods[key].byClass[type] = (periods[key].byClass[type] || 0) + amount;
        (periods[key].items[type] = periods[key].items[type] || []).push({ name: getField(r, NW.name) || '(unnamed)', amount });
    });
    return Object.values(periods).map(p => {
        const assets = NW_ASSET_CLASSES.reduce((s, c) => s + (p.byClass[c] || 0), 0);
        const liabilities = NW_LIABILITY_CLASSES.reduce((s, c) => s + (p.byClass[c] || 0), 0);
        return { ...p, assets, liabilities, net: assets - liabilities };
    }).sort((a, b) => a.sortKey - b.sortKey);
}

// ── Render ───────────────────────────────────────────────────────────────────
async function renderWealthTab() {
    const el = document.getElementById('tab-wealth');
    if (!el) return;

    if (_wealthRecords) { renderWealthContent(el, _wealthRecords); return; }

    el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;min-height:240px;color:var(--text-muted)">
        <div style="text-align:center"><div class="spinner" style="margin:0 auto 12px"></div><div>Loading wealth data…</div></div></div>`;

    if (typeof PAT === 'undefined' || !PAT) return; // auth screen is showing; nothing to do yet

    try {
        if (!_wealthPromise) _wealthPromise = airtableFetch(TABLES.netWorthByMonth);
        _wealthRecords = await _wealthPromise;
    } catch (e) {
        _wealthPromise = null;
        el.innerHTML = `<div style="max-width:960px;margin:0 auto"><div class="kpi-card" style="text-align:center;color:var(--text-secondary)">
            <div style="font-weight:var(--fw-semibold);margin-bottom:6px;color:var(--text-primary)">Could not load net worth data</div>
            <div style="font-size:var(--fs-sm)">Use the Refresh button, or switch tabs and back.</div></div></div>`;
        return;
    }
    try {
        renderWealthContent(el, _wealthRecords);
    } catch (e) {
        el.innerHTML = `<div style="max-width:960px;margin:0 auto"><div class="kpi-card" style="text-align:center;color:var(--text-secondary)">
            <div style="font-weight:var(--fw-semibold);margin-bottom:6px;color:var(--text-primary)">Could not display net worth</div>
            <div style="font-size:var(--fs-sm)">${escHtml(e.message || 'Unexpected error')}</div></div></div>`;
    }
}

function renderWealthContent(el, records) {
    const periods = computeNetWorth(records);
    if (!periods.length) {
        el.innerHTML = `<div style="max-width:960px;margin:0 auto"><div class="kpi-card" style="text-align:center;color:var(--text-secondary)">
            <div style="font-weight:var(--fw-semibold);margin-bottom:6px;color:var(--text-primary)">No net worth data yet</div>
            <div style="font-size:var(--fs-sm)">Add entries to the Net Worth Statement in Airtable and they will show here.</div></div></div>`;
        return;
    }

    const latest = periods[periods.length - 1];
    const prev = periods.length > 1 ? periods[periods.length - 2] : null;
    const asOf = `${latest.month} ${latest.year}`;
    const netChange = prev ? latest.net - prev.net : null;

    // Live bank cash today (unambiguous: the two current accounts the dashboard uses).
    // Null-safe: allAccounts may not be populated yet on first load — getField throws
    // if passed undefined, so look the record up first and skip if absent.
    const accts = (typeof allAccounts !== 'undefined' && allAccounts) ? allAccounts : [];
    const accountsLoaded = accts.length > 0;
    const bal = id => { const a = accts.find(x => x.id === id); return a ? (Number(getField(a, F.accGBP)) || 0) : 0; };
    const liveCash = bal(REC.santander) + bal(REC.tntZempler);
    const snapCash = latest.byClass['Cash'] || 0;

    const classRow = (cls, colour) => {
        const val = latest.byClass[cls] || 0;
        return `<div class="detail-item">
            <span class="detail-item-name"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colour};margin-right:8px"></span>${escHtml(cls)}</span>
            <span class="detail-item-value">${fmt(val)}</span>
        </div>`;
    };

    // Trend: net worth per month with a proportional bar
    const maxNet = Math.max(...periods.map(p => Math.abs(p.net)), 1);
    const trendRows = periods.map(p => {
        const pct = Math.round((Math.abs(p.net) / maxNet) * 100);
        return `<div style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;font-size:var(--fs-sm);margin-bottom:3px">
                <span style="color:var(--text-secondary)">${escHtml(p.month)} ${p.year}</span>
                <span style="font-weight:var(--fw-semibold);color:var(--text-primary)">${fmt(p.net)}</span>
            </div>
            <div style="height:8px;background:var(--bg-subtle);border-radius:var(--radius-full);overflow:hidden">
                <div style="height:100%;width:${pct}%;background:var(--tone-sage);border-radius:var(--radius-full)"></div>
            </div>
        </div>`;
    }).join('');

    const changeHtml = netChange === null ? '' :
        `<span style="color:${netChange >= 0 ? 'var(--success)' : 'var(--danger)'};font-size:var(--fs-sm);font-weight:var(--fw-semibold)">
            ${netChange >= 0 ? '▲' : '▼'} ${fmt(netChange)} vs ${prev.month}</span>`;

    el.innerHTML = `
    <div style="max-width:960px;margin:0 auto">

        <!-- Hero: net worth -->
        <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:var(--space-6);margin-bottom:var(--space-5)">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
                <span style="color:var(--text-secondary);font-size:var(--fs-sm)">Net worth</span>
                <span style="margin-left:auto;color:var(--text-muted);font-size:var(--fs-xs)">As of ${escHtml(asOf)}</span>
            </div>
            <div style="font-size:var(--fs-3xl);font-weight:var(--fw-bold);color:var(--text-primary);line-height:1.1">${fmt(latest.net)}</div>
            <div style="margin-top:8px">${changeHtml}</div>
        </div>

        <!-- Assets + Liabilities -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-5);margin-bottom:var(--space-5)">
            <div class="kpi-card">
                <div class="kpi-card-label" style="margin-bottom:10px">Assets <span style="float:right;color:var(--success);font-weight:var(--fw-bold)">${fmt(latest.assets)}</span></div>
                ${classRow('Cash', 'var(--tone-blue)')}
                ${classRow('Real Estate', 'var(--tone-sage)')}
                ${classRow('Investments', 'var(--tone-olive)')}
                ${classRow('Businesses', 'var(--tone-gold)')}
            </div>
            <div class="kpi-card">
                <div class="kpi-card-label" style="margin-bottom:10px">Liabilities <span style="float:right;color:var(--danger);font-weight:var(--fw-bold)">${fmt(latest.liabilities)}</span></div>
                ${classRow('Credit Cards', 'var(--tone-gold)')}
                ${classRow('Loans', 'var(--tone-plum)')}
                ${classRow('Mortgages', 'var(--danger)')}
            </div>
        </div>

        <!-- Live cash comparison -->
        <div class="kpi-card" style="margin-bottom:var(--space-5)">
            <div class="kpi-card-label" style="margin-bottom:8px">Live bank cash today</div>
            <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
                <span style="font-size:var(--fs-2xl);font-weight:var(--fw-bold);color:var(--text-primary)">${accountsLoaded ? fmt(liveCash) : '<span style=\"color:var(--text-muted);font-size:var(--fs-base)\">Syncing…</span>'}</span>
                <span style="color:var(--text-muted);font-size:var(--fs-sm)">Santander + TNT Zempler, synced now</span>
            </div>
            <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-top:8px;line-height:1.5">
                Cash in the ${asOf} snapshot was ${fmt(snapCash)} across all accounts (Monese, Hyper Jar, ANNA and others). The live figure above covers only the two synced current accounts. Fully live net worth across every class is the next enhancement.
            </div>
        </div>

        <!-- Trend -->
        <div class="kpi-card">
            <div class="kpi-card-label" style="margin-bottom:14px">Net worth trend</div>
            ${trendRows}
            <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-top:6px;line-height:1.5">
                Built from your monthly Airtable snapshots. Keep them current (or wait for the live computation) to extend the trend.
            </div>
        </div>

    </div>`;
}
