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
// Per-class items for the current view, stashed so "Save this month" can capture them.
let _wealthSnapshotData = null;

// Readiness gate (mirrors money.js). allAccounts is the LAST global the dashboard
// sets, so its presence means a full dashboard load completed and allTransactions /
// allSubCategories are populated too. We deliberately do NOT call loadDashboard()
// here — init and the switchTab tail already do. A second concurrent call doubles
// the Airtable request burst and trips the 5/sec rate limit.
function wealthDataReady() {
    return typeof allAccounts !== 'undefined' && allAccounts && allAccounts.length > 0;
}
function waitForWealthData(timeoutMs) {
    return new Promise(resolve => {
        if (wealthDataReady()) { resolve(true); return; }
        const started = Date.now();
        const timer = setInterval(() => {
            if (wealthDataReady()) { clearInterval(timer); resolve(true); return; }
            if (Date.now() - started >= timeoutMs) { clearInterval(timer); resolve(false); }
        }, 400);
    });
}

// Net-worth items to exclude from the Wealth view (accounts not linked to the
// system). Filtered out of totals and itemisation; the Airtable data is untouched.
const WEALTH_EXCLUDE_ITEMS = ['Hyper Jar', 'Operations Director - ANNA'];

// ── Engine ───────────────────────────────────────────────────────────────────
// Group rows by month, sum by class, derive assets / liabilities / net worth.
function computeNetWorth(records) {
    const periods = {};
    (records || []).forEach(r => {
        const type = getField(r, NW.type);
        if (!type) return;
        if (WEALTH_EXCLUDE_ITEMS.includes(getField(r, NW.name))) return;
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

    // Wait for the dashboard load to populate the shared globals before firing our
    // own Airtable requests. On a deep-link straight to #wealth, these fetches would
    // otherwise race loadDashboard's burst, trip the 5/sec rate limit and wedge the
    // spinner. We also need allTransactions for the cash-flow + expenditure sections.
    await waitForWealthData(90000);

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
    // Optional: per-property valuations + debt terms so the hero's Real Estate and
    // Mortgages lines reconcile with the per-property breakdown below. Non-fatal —
    // if these fail, the hero falls back to the monthly snapshot's lumped figures.
    try {
        if (!_valPromise) _valPromise = airtableFetch(TABLES.valuations);
        if (!_debtPromise) _debtPromise = airtableFetch(TABLES.debtTerms);
        const [vals, debts] = await Promise.all([_valPromise, _debtPromise]);
        _valRecords = vals; _debtRecords = debts;
    } catch (e) { /* hero falls back to snapshot real-estate/mortgage lines */ }
    try {
        renderWealthContent(el, _wealthRecords);
    } catch (e) {
        el.innerHTML = `<div style="max-width:960px;margin:0 auto"><div class="kpi-card" style="text-align:center;color:var(--text-secondary)">
            <div style="font-weight:var(--fw-semibold);margin-bottom:6px;color:var(--text-primary)">Could not display net worth</div>
            <div style="font-size:var(--fs-sm)">${escHtml(e.message || 'Unexpected error')}</div></div></div>`;
    }
}

// ── Monthly update form ──────────────────────────────────────────────────────
// Pull a live balance for the handful of accounts we can map by name to a synced
// Account record. Credit-card balances come back with inconsistent signs, so we
// store the magnitude (snapshots hold "owed" as a positive number).
function wealthLiveValue(name) {
    const map = {
        'santander': REC.santander,
        'tnt mgt zempler': REC.tntZempler,
        'american express': REC.americanExpress,
        'santander credit card': REC.santanderCC,
        'lloyds credit card': REC.lloydsCreditCard,
    };
    const recId = map[(name || '').trim().toLowerCase()];
    if (!recId) return null;
    const accts = (typeof allAccounts !== 'undefined' && allAccounts) ? allAccounts : [];
    const a = accts.find(x => x.id === recId);
    if (!a) return null;
    const v = Number(getField(a, F.accGBP));
    return isNaN(v) ? null : Math.abs(v);
}

const WEALTH_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEALTH_CLASS_ORDER = ['Cash','Real Estate','Investments','Businesses','Credit Cards','Loans','Mortgages'];
const WEALTH_LIVE_CLASSES = ['Cash','Credit Cards'];

// ── Document reader (Claude vision) ──────────────────────────────────────────
// Drag a screenshot/statement onto a row, or use the clip button, and Claude
// reads the figure. The value is a SUGGESTION the user confirms — it fills the
// field but is never saved until the user clicks Save, so a misread cannot slip
// silently into net worth. Any failure falls back to manual entry.
const WEALTH_EXTRACT_PROMPT = 'You are reading a financial document or screenshot (a bank, investment, loan or mortgage statement, or an account screen). Identify the single most relevant CURRENT balance or total value in GBP. Respond with ONLY the number — digits and an optional decimal point, no commas, no currency symbol, no words. If there is no clear value, respond exactly: NONE';

function parseWealthNumber(text) {
    if (!text || /none/i.test(text)) return null;
    const cleaned = String(text).replace(/[^0-9.]/g, '');
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : Math.abs(n);
}

function wealthReadDoc(btn) {
    const row = btn.closest('.wealth-row');
    if (!row) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,application/pdf';
    input.onchange = () => { if (input.files && input.files[0]) wealthExtractIntoRow(row, input.files[0]); };
    input.click();
}

function wealthDrop(event, row) {
    event.preventDefault();
    row.style.background = '';
    const file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
    if (file) wealthExtractIntoRow(row, file);
}

async function wealthExtractIntoRow(row, file) {
    const status = row.querySelector('.wread-status');
    const amt = row.querySelector('.wa');
    const setStatus = (t, c) => { if (status) { status.textContent = t; status.style.color = c || 'var(--text-muted)'; } };
    if (!file) return;
    const okTypes = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
    if (!okTypes.includes(file.type)) { setStatus('use PNG/JPG/PDF', 'var(--danger)'); return; }
    if (file.size > 8 * 1024 * 1024) { setStatus('file too big (8MB)', 'var(--danger)'); return; }
    setStatus('reading…');
    if (amt) amt.style.borderColor = '';
    try {
        const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
        const b64 = String(dataUrl).split(',')[1];
        if (!b64) { setStatus('couldn’t read — enter manually', 'var(--danger)'); return; }
        const block = (file.type === 'application/pdf')
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
            : { type: 'image', source: { type: 'base64', media_type: file.type, data: b64 } };
        const messages = [{ role: 'user', content: [block, { type: 'text', text: WEALTH_EXTRACT_PROMPT }] }];
        const resp = await fetch(AI_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 80, system: '', messages }),
        });
        if (!resp.ok) { setStatus('couldn’t read — enter manually', 'var(--danger)'); return; }
        const data = await resp.json();
        const num = parseWealthNumber(data.content && data.content[0] ? data.content[0].text : '');
        if (num == null) { setStatus('no figure found — enter manually', 'var(--danger)'); return; }
        if (amt) { amt.value = num; amt.style.borderColor = 'var(--success)'; }
        setStatus('AI-read · check it', 'var(--success)');
    } catch (e) {
        setStatus('couldn’t read — enter manually', 'var(--danger)');
    }
}

// One editable row. Existing items carry their name in data-name (label shown);
// new items get a name text input so you can add a property/business/loan.
function wealthRowHtml(cls, name, amount, live, isNew) {
    const tag = (live != null) ? `<span style="color:var(--success);font-size:var(--fs-xs);margin-left:8px">live</span>` : '';
    const nameCell = isNew
        ? `<input type="text" class="wn" placeholder="Name (e.g. new property)" style="flex:1;padding:6px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface)">`
        : `<label style="flex:1;font-size:var(--fs-sm);color:var(--text-primary)">${escHtml(name)}${tag}</label>`;
    const dataName = isNew ? '' : ` data-name="${escHtml(name)}"`;
    return `<div class="wealth-row" data-wealth-type="${escHtml(cls)}"${dataName} style="display:flex;align-items:center;gap:8px;padding:5px 0"
        ondragover="event.preventDefault();this.style.background='var(--bg-surface-2)'" ondragleave="this.style.background=''" ondrop="wealthDrop(event,this)">
        ${nameCell}
        <span class="wread-status" style="font-size:var(--fs-xs);color:var(--text-muted);white-space:nowrap"></span>
        <span style="color:var(--text-muted)">£</span>
        <input type="number" step="0.01" class="wa" value="${amount == null ? '' : amount}"
            style="width:130px;padding:6px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);text-align:right;background:var(--bg-surface)">
        <button type="button" onclick="wealthReadDoc(this)" title="Read the value from a screenshot or statement" style="background:none;border:1px solid var(--border-default);border-radius:var(--radius-sm);cursor:pointer;font-size:13px;padding:3px 7px;line-height:1">&#x1F4CE;</button>
        <button type="button" onclick="this.closest('.wealth-row').remove()" title="Remove this item" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:16px;padding:2px 4px;line-height:1">&times;</button>
    </div>`;
}

// Append a blank row to a class section so the user can add a new asset/liability.
function addWealthRow(cls) {
    const sec = document.querySelector(`.wealth-section[data-section="${(window.CSS && CSS.escape) ? CSS.escape(cls) : cls}"]`);
    if (!sec) return;
    sec.insertAdjacentHTML('beforeend', wealthRowHtml(cls, '', null, null, true));
    const inp = sec.querySelector('.wealth-row:last-child .wn');
    if (inp) inp.focus();
}

// Render the monthly update form. Existing items pre-fill (cash/cards live, the
// rest last month's value); each class can gain new items or drop sold ones.
function openWealthUpdate() {
    const el = document.getElementById('tab-wealth');
    if (!el || !_wealthRecords) return;
    const periods = computeNetWorth(_wealthRecords);
    const latest = periods[periods.length - 1];
    const now = new Date();
    const curMonth = WEALTH_MONTHS[now.getMonth()];
    const curYear = String(now.getFullYear());
    const alreadySaved = periods.some(p => p.month === curMonth && String(p.year) === curYear);

    let rowsHtml = '';
    WEALTH_CLASS_ORDER.forEach(cls => {
        const items = latest.items[cls] || [];
        const itemRows = items.map(it => {
            const live = WEALTH_LIVE_CLASSES.includes(cls) ? wealthLiveValue(it.name) : null;
            return wealthRowHtml(cls, it.name, (live != null) ? live : it.amount, live, false);
        }).join('');
        rowsHtml += `<div style="margin-top:18px;margin-bottom:4px;font-size:var(--fs-xs);font-weight:var(--fw-semibold);text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted)">${escHtml(cls)}</div>
            <div class="wealth-section" data-section="${escHtml(cls)}">${itemRows}</div>
            <button onclick="addWealthRow('${cls.replace(/'/g, "\\'")}')" style="background:none;border:1px dashed var(--border-default);border-radius:var(--radius-md);padding:5px 12px;margin-top:6px;font-size:var(--fs-xs);color:var(--accent);cursor:pointer">+ Add ${escHtml(cls)}</button>`;
    });

    el.innerHTML = `<div style="max-width:720px;margin:0 auto">
        <div style="margin-bottom:8px"><button onclick="renderWealthTab()" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:var(--fs-sm);padding:0">&larr; Back to net worth</button></div>
        <div class="kpi-card">
            <div class="kpi-card-label" style="margin-bottom:4px">Update figures for ${escHtml(curMonth)} ${escHtml(curYear)}</div>
            <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-bottom:10px;line-height:1.5">Cash and cards are pre-filled live. Everything else shows last month's value — change only what moved. Use "+ Add" to record a new property, business, loan or investment, and the &times; to drop anything you have sold or cleared. Dragging a statement or screenshot to auto-read figures is the next upgrade.</div>
            ${alreadySaved ? `<div style="background:var(--warning-bg);border:1px solid var(--warning);border-radius:var(--radius-sm);padding:8px 12px;margin-bottom:10px;font-size:var(--fs-sm);color:var(--text-primary)">${escHtml(curMonth)} ${escHtml(curYear)} already has a saved snapshot. Editing an existing month is coming next; saving now would duplicate it, so it is disabled.</div>` : ''}
            <div id="wealthUpdateError" style="display:none;color:var(--danger);font-size:var(--fs-sm);margin:8px 0"></div>
            ${rowsHtml}
            <div style="display:flex;gap:10px;margin-top:22px">
                <button id="wealthSaveBtn" ${alreadySaved ? 'disabled style="opacity:0.5;cursor:not-allowed;' : 'style="cursor:pointer;'}background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);padding:10px 20px;font-weight:var(--fw-semibold)" onclick="saveWealthUpdate('${curMonth}','${curYear}')">Save ${escHtml(curMonth)} ${escHtml(curYear)}</button>
                <button onclick="renderWealthTab()" style="background:none;border:1px solid var(--border-default);border-radius:var(--radius-md);padding:10px 20px;cursor:pointer;color:var(--text-secondary)">Cancel</button>
            </div>
        </div>
    </div>`;
}

// Save the form as a new dated snapshot. Creates one record per line item in the
// net worth table. Guards against duplicating a month that already exists.
async function saveWealthUpdate(curMonth, curYear) {
    const btn = document.getElementById('wealthSaveBtn');
    const errEl = document.getElementById('wealthUpdateError');
    const showErr = m => { if (errEl) { errEl.style.display = 'block'; errEl.textContent = m; } if (btn) { btn.disabled = false; btn.textContent = `Save ${curMonth} ${curYear}`; } };

    // Duplicate guard — never create a second snapshot for the same month.
    const existing = computeNetWorth(_wealthRecords || []).some(p => p.month === curMonth && String(p.year) === curYear);
    if (existing) { showErr(`${curMonth} ${curYear} is already saved. Editing an existing month is coming next.`); return; }

    const rows = [...document.querySelectorAll('.wealth-row')];
    const records = [];
    rows.forEach(row => {
        const nameInput = row.querySelector('.wn');
        const name = (row.dataset.name != null ? row.dataset.name : (nameInput ? nameInput.value : '')).trim();
        if (!name) return; // skip blank added rows
        records.push({ fields: {
            [NW.name]: name,
            [NW.amount]: Number(row.querySelector('.wa').value) || 0,
            [NW.type]: row.dataset.wealthType,
            [NW.month]: curMonth,
            [NW.year]: curYear,
        } });
    });
    if (!records.length) { showErr('Nothing to save.'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        for (let i = 0; i < records.length; i += 10) {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.netWorthByMonth}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ records: records.slice(i, i + 10), typecast: true }),
            });
            if (!resp.ok) throw new Error('Airtable returned ' + resp.status);
        }
        _wealthRecords = null;
        _wealthPromise = null;
        await renderWealthTab();
    } catch (e) {
        showErr('Could not save: ' + (e.message || 'error'));
    }
}

// Show a small amber badge on the Wealth sidebar item when monthly figures are
// stale, so the "needs updating" alert is visible from any tab (the sidebar is
// always on screen). Isolated: only touches the Wealth nav item.
function updateWealthSidebarFlag(monthsBehind) {
    const dot = document.querySelector("[data-sidebar-health='wealth']");
    const navItem = dot ? dot.closest('.sidebar-item') : null;
    if (!navItem) return;
    let badge = navItem.querySelector('.wealth-stale-badge');
    if (monthsBehind > 0) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'wealth-stale-badge';
            badge.style.cssText = 'margin-left:6px;min-width:18px;height:18px;border-radius:9px;font-size:10px;font-weight:700;color:#fff;background:var(--warning);text-align:center;line-height:18px;padding:0 5px';
            navItem.appendChild(badge);
        }
        badge.textContent = monthsBehind + 'm';
        badge.title = monthsBehind + ' month(s) of figures need updating';
    } else if (badge) {
        badge.remove();
    }
}

function renderWealthContent(el, records, valRecs, debtRecs) {
    // Live per-property data: explicit args win (used by tests), else the module cache.
    valRecs = valRecs || _valRecords;
    debtRecs = debtRecs || _debtRecords;
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

    // Reconcile Real Estate + Mortgages to the live per-property data when it loaded,
    // so the hero, the class rows and the per-property breakdown all agree. Other
    // classes still come from the monthly snapshot. `view` is a shallow copy so the
    // trend (built from the raw snapshots) stays untouched.
    const view = { byClass: { ...latest.byClass }, assets: latest.assets, liabilities: latest.liabilities, net: latest.net };
    let livePortfolio = null;
    if (valRecs && debtRecs) {
        try {
            const pf = buildPortfolio(valRecs, debtRecs);
            if (pf.rows.length) {
                view.byClass['Real Estate'] = pf.totalValue;
                view.byClass['Mortgages'] = pf.totalMortAll;
                view.assets = NW_ASSET_CLASSES.reduce((s, c) => s + (view.byClass[c] || 0), 0);
                view.liabilities = NW_LIABILITY_CLASSES.reduce((s, c) => s + (view.byClass[c] || 0), 0);
                view.net = view.assets - view.liabilities;
                livePortfolio = pf;
            }
        } catch (e) { /* fall back to snapshot figures */ }
    }
    // Only show a month-on-month delta when NOT overriding with live data — comparing
    // a live latest against a snapshot prev would be misleading.
    const netChange = (prev && !livePortfolio) ? view.net - prev.net : null;

    // Live bank cash today (unambiguous: the two current accounts the dashboard uses).
    // Null-safe: allAccounts may not be populated yet on first load — getField throws
    // if passed undefined, so look the record up first and skip if absent.
    const accts = (typeof allAccounts !== 'undefined' && allAccounts) ? allAccounts : [];
    const accountsLoaded = accts.length > 0;
    const bal = id => { const a = accts.find(x => x.id === id); return a ? (Number(getField(a, F.accGBP)) || 0) : 0; };
    const liveCash = bal(REC.santander) + bal(REC.tntZempler);
    const snapCash = latest.byClass['Cash'] || 0;

    // Itemised asset/liability lines per class. Most classes come from the monthly
    // snapshot items; Real Estate + Mortgages use the live per-property data so they
    // match the reconciled totals.
    const snapItems = cls => (latest.items[cls] || []).filter(it => it.name && it.name !== '(unnamed)').map(it => ({ name: it.name, amount: it.amount }));
    const pfRows = livePortfolio ? livePortfolio.rows : [];
    const reItems = pfRows.length ? pfRows.map(p => ({ name: p.name, amount: p.value })) : snapItems('Real Estate');
    const mortItems = pfRows.length ? pfRows.filter(p => p.mort > 0).map(p => ({ name: p.name, amount: p.mort })) : snapItems('Mortgages');

    // ── Staleness + update-method audit ──
    // Real-time classes can be synced from connected accounts; the rest are
    // updated once a month by hand. This drives the "needs updating" alert.
    const REALTIME_CLASSES = ['Cash', 'Credit Cards'];
    const MANUAL_CLASSES = ['Real Estate', 'Investments', 'Businesses', 'Loans', 'Mortgages'];
    const now = new Date();
    const monthsBehind = (now.getFullYear() * 12 + now.getMonth()) - (latest.year * 12 + latest.monthIdx);
    const currentLabel = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const manualItemCount = MANUAL_CLASSES.reduce((s, c) => s + ((latest.items[c] || []).length), 0);
    // Flag the sidebar so the "needs updating" alert is visible from anywhere.
    updateWealthSidebarFlag(monthsBehind);

    const auditCol = (title, colour, classes, note) => {
        const rows = classes.map(c => {
            const n = (latest.items[c] || []).length;
            return `<div style="display:flex;justify-content:space-between;font-size:var(--fs-sm);padding:3px 0">
                <span style="color:var(--text-secondary)">${escHtml(c)}</span>
                <span style="color:var(--text-muted)">${n} item${n === 1 ? '' : 's'}</span>
            </div>`;
        }).join('');
        return `<div>
            <div style="font-size:var(--fs-xs);font-weight:var(--fw-semibold);color:${colour};text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">${escHtml(title)}</div>
            ${rows}
            <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-top:6px;line-height:1.5">${escHtml(note)}</div>
        </div>`;
    };

    // An itemised class block: coloured header with the class total, then each item.
    const itemSection = (title, colour, items, total) => {
        const lines = items.length
            ? items.slice().sort((a, b) => b.amount - a.amount).map(it => `<div class="detail-item" style="padding-left:16px">
                <span class="detail-item-name" style="color:var(--text-secondary)">${escHtml(it.name)}</span>
                <span class="detail-item-value">${fmt0(it.amount)}</span>
            </div>`).join('')
            : `<div style="padding:4px 0 4px 16px;color:var(--text-muted);font-size:var(--fs-sm)">No items yet</div>`;
        return `<div style="margin-bottom:12px">
            <div class="detail-item" style="border-bottom:1px solid var(--border-subtle);padding-bottom:4px">
                <span class="detail-item-name" style="font-weight:var(--fw-semibold);color:var(--text-primary)"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colour};margin-right:8px"></span>${escHtml(title)}</span>
                <span class="detail-item-value" style="font-weight:var(--fw-bold);color:var(--text-primary)">${fmt(total)}</span>
            </div>
            ${lines}
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
    const heroNote = livePortfolio
        ? `<span style="color:var(--text-muted);font-size:var(--fs-xs)">Real estate &amp; mortgages are live from your per-property valuations; other classes from the ${escHtml(asOf)} snapshot.</span>`
        : changeHtml;

    // ── Assets, liabilities & net worth as a rolling 12-month matrix ──
    const periodByKey = {};
    periods.forEach(p => { periodByKey[`${p.year}-${String(p.monthIdx + 1).padStart(2, '0')}`] = p; });
    const alMonths = wealthMonths12();
    const alKeys = alMonths.map(m => m.key);
    const alLast = alKeys.length - 1;
    // A month's snapshot wins; the latest column falls back to the reconciled live
    // figure when that month has no saved snapshot yet. Other gaps stay blank.
    const classVals = cls => alKeys.map((k, i) => {
        const p = periodByKey[k];
        if (p) { const v = p.byClass[cls]; return v == null ? null : v; }
        if (i === alLast) { const v = view.byClass[cls]; return v == null ? null : v; }
        return null;
    });
    const itemRows = (items, goodUp) => (items && items.length)
        ? items.slice().sort((a, b) => b.amount - a.amount).map(it => ({ label: it.name, goodUp, values: alKeys.map((k, i) => i === alLast ? it.amount : null) }))
        : undefined;
    const alRow = (label, cls, items, goodUp) => ({ label, goodUp, values: classVals(cls), items: itemRows(items, goodUp) });
    const totalVals = pick => alKeys.map((k, i) => { const p = periodByKey[k]; if (p) return pick(p); return i === alLast ? pick(view) : null; });
    const alSections = [
        { header: 'Assets', rows: [
            alRow('Cash', 'Cash', snapItems('Cash'), true),
            alRow('Real Estate', 'Real Estate', reItems, true),
            alRow('Investments', 'Investments', snapItems('Investments'), true),
            alRow('Businesses', 'Businesses', snapItems('Businesses'), true),
            { label: 'Total assets', goodUp: true, bold: true, border: '1px solid var(--border-default)', values: totalVals(p => p.assets) },
        ] },
        { header: 'Liabilities', rows: [
            alRow('Credit Cards', 'Credit Cards', snapItems('Credit Cards'), false),
            alRow('Loans', 'Loans', snapItems('Loans'), false),
            alRow('Mortgages', 'Mortgages', mortItems, false),
            { label: 'Total liabilities', goodUp: false, bold: true, border: '1px solid var(--border-default)', values: totalVals(p => p.liabilities) },
        ] },
        { header: '', rows: [
            { label: 'Net worth', goodUp: true, bold: true, border: '2px solid var(--border-default)', values: totalVals(p => p.net) },
        ] },
    ];
    const assetsHtml = wealthMatrixCard(
        'Assets, liabilities & net worth — rolling 12 months',
        'Class totals over 12 months (blank where there is no monthly snapshot yet). Click a class to expand its current breakdown. Real estate and mortgages use your live per-property figures; other classes come from the latest monthly snapshot. Arrows = change vs the previous month; 12-mo = change across the period.',
        alMonths, alSections);

    // ── KPI summary strip (headline figures + 1/3/6/9/12-month changes) ──
    // 13-month series (current + 12 prior) so every period change is computable.
    const kpiKeys = wealthMonthKeys(13, 0); // current month + 12 prior
    const kpiRef = wealthCompletedIdx(kpiKeys); // last completed month (flow anchor)
    const kpiLast = kpiKeys.length - 1; // current month (stock/balance anchor)
    const kpiSnap = pick => kpiKeys.map((k, i) => { const p = periodByKey[k]; if (p) return pick(p); return i === kpiLast ? pick(view) : null; });
    const kpiCfSeries = buildMonthlyCashflow(kpiKeys).map(m => m.net);
    const KPI_PERIODS = [1, 3, 6, 9, 12];
    const periodChanges = (series, goodUp, anchorIdx) => {
        const cur = series[anchorIdx];
        return KPI_PERIODS.map(n => {
            const prev = series[anchorIdx - n];
            if (cur == null || prev == null || prev === 0) return `<span style="color:var(--text-muted)">${n}m&nbsp;–</span>`;
            const p = (cur - prev) / Math.abs(prev) * 100;
            if (Math.round(p) === 0) return `<span style="color:var(--text-muted)">${n}m&nbsp;0%</span>`;
            const up = p > 0, good = goodUp ? up : !up;
            return `<span style="color:${good ? 'var(--success)' : 'var(--danger)'}">${n}m&nbsp;${up ? '▲' : '▼'}${Math.abs(Math.round(p))}%</span>`;
        }).join('<span style="color:var(--border-default)">&nbsp;·&nbsp;</span>');
    };
    const kpiCard = (label, value, valueColour, series, goodUp, anchorIdx) => `<div class="kpi-card" style="margin-bottom:0">
        <div class="kpi-card-label" style="margin-bottom:6px">${escHtml(label)}</div>
        <div style="font-size:var(--fs-2xl);font-weight:var(--fw-bold);color:${valueColour};line-height:1.1">${fmt(value)}</div>
        <div style="margin-top:8px;font-size:var(--fs-xs);font-weight:var(--fw-semibold);line-height:1.7">${periodChanges(series, goodUp, anchorIdx)}</div>
    </div>`;
    // Net worth / assets / liabilities are point-in-time balances → anchor on the
    // current month (kpiLast). Cash flow is a monthly flow distorted by the partial
    // current month → anchor on the last completed month (kpiRef).
    const cfNetNow = kpiCfSeries[kpiRef] || 0;
    const kpiStrip = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:var(--space-4);margin-bottom:var(--space-5)">
        ${kpiCard('Net worth', view.net, view.net >= 0 ? 'var(--text-primary)' : 'var(--danger)', kpiSnap(p => p.net), true, kpiLast)}
        ${kpiCard('Net cash flow (last complete month)', cfNetNow, cfNetNow >= 0 ? 'var(--success)' : 'var(--danger)', kpiCfSeries, true, kpiRef)}
        ${kpiCard('Total assets', view.assets, 'var(--text-primary)', kpiSnap(p => p.assets), true, kpiLast)}
        ${kpiCard('Total liabilities', view.liabilities, 'var(--text-primary)', kpiSnap(p => p.liabilities), false, kpiLast)}
    </div>`;

    // Trend-column period selector (drives the Δ column on every matrix below).
    const periodBtn = n => `<button onclick="setWealthChangePeriod(${n})" style="padding:5px 12px;border:1px solid var(--border-default);border-radius:var(--radius-md);cursor:pointer;font-size:var(--fs-sm);background:${_wealthChangeMonths === n ? 'var(--accent)' : 'var(--bg-surface)'};color:${_wealthChangeMonths === n ? '#fff' : 'var(--text-secondary)'};font-weight:${_wealthChangeMonths === n ? 'var(--fw-semibold)' : 'var(--fw-regular)'}">${n}M</button>`;
    const changeSelector = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:var(--space-5);flex-wrap:wrap">
        <span style="color:var(--text-secondary);font-size:var(--fs-sm)">Trend column (Δ):</span>
        ${[1, 3, 6, 9, 12].map(periodBtn).join('')}
    </div>`;

    el.innerHTML = `
    <div style="width:100%">

        ${kpiStrip}

        ${changeSelector}

        ${monthsBehind > 0 ? `<!-- Staleness alert -->
        <div style="background:var(--warning-bg);border:1px solid var(--warning);border-radius:var(--radius-lg);padding:var(--space-4);margin-bottom:var(--space-5);display:flex;gap:12px;align-items:flex-start">
            <span style="font-size:20px;line-height:1.2">⚠️</span>
            <div>
                <div style="font-weight:var(--fw-semibold);color:var(--text-primary);margin-bottom:2px">Your figures are ${monthsBehind} month${monthsBehind === 1 ? '' : 's'} out of date</div>
                <div style="font-size:var(--fs-sm);color:var(--text-secondary)">Latest snapshot is ${escHtml(asOf)}. To bring this up to ${escHtml(currentLabel)}, ${manualItemCount} manual figures need updating: property and business valuations, loan and mortgage balances, and investments. Cash and credit cards update live.</div>
                <button onclick="openWealthUpdate()" style="margin-top:10px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);padding:8px 16px;font-size:var(--fs-sm);font-weight:var(--fw-semibold);cursor:pointer">Update figures for ${escHtml(currentLabel)}</button>
            </div>
        </div>` : ''}

        <!-- Monthly cash flow (rolling 12 months) -->
        <div id="wealthCashflow" style="margin-bottom:var(--space-5)"></div>

        <!-- Income buckets — manage (add/remove/%) then the 12-month grid -->
        <div id="wealthBucketEditor" style="margin-bottom:var(--space-3)"></div>
        <div id="wealthBuckets" style="margin-bottom:var(--space-5)"></div>

        <!-- Assets, liabilities & net worth (rolling 12 months) -->
        ${assetsHtml}

    </div>`;

    // Cash flow reads the already-loaded transactions (sync). Buckets fetch their table.
    renderWealthCashflow();
    loadWealthBuckets();
}

// ── Monthly cash flow (money in − money out = net) ───────────────────────────
// The headline of the Wealth page, mirroring Kevin's personal financial statement:
// money in (business revenue + personal income) − money out (business costs) = net
// monthly cash flow, which then feeds the income buckets. Classification matches
// the P&L tab (by sub-category name) so the two agree. Reads allTransactions (no
// fetch). Personal-expenditure subcats are NOT money-out here — those are draws,
// shown separately lower down. "Personal Income Drawings" is excluded as it is an
// internal transfer that would double-count rental income.
function wealthMonthKeys(n, endOffset) {
    // n complete months ending `endOffset` months before the current (partial) month.
    const out = [];
    const now = new Date();
    for (let i = n - 1 + endOffset; i >= endOffset; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    return out;
}

// Key for the current (partial) calendar month, e.g. "2026-06".
function wealthCurrentMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Index of the last COMPLETED month in a chronological key list. The current
// calendar month is partial, so flow trends (cash flow, buckets) anchor on the
// month before it. Returns the last index if the current month is not in the list.
function wealthCompletedIdx(keys) {
    const cm = wealthCurrentMonthKey();
    for (let i = keys.length - 1; i >= 0; i--) if (keys[i] !== cm) return i;
    return Math.max(0, keys.length - 1);
}

function buildMonthlyCashflow(monthKeys) {
    const txns = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];
    const subNames = {};
    ((typeof allSubCategories !== 'undefined' && allSubCategories) ? allSubCategories : []).forEach(r => {
        const n = getField(r, 'fldO4BTJhFv5EsN6i'); if (n) subNames[r.id] = String(n);
    });
    const reSet = new Set(CASHFLOW_INCOME_SUBCATS);            // real estate / portfolio revenue
    const piSet = new Set(CASHFLOW_PERSONAL_INCOME_SUBCATS);   // personal income
    const bizSet = new Set(CASHFLOW_COST_SUBCATS);             // business expenditure (itemised)
    const perSet = new Set(CASHFLOW_PERSONAL_EXPENSE_SUBCATS); // personal expenditure (itemised)
    const linkId = f => { if (!f) return null; if (Array.isArray(f)) { const x = f[0]; return x && typeof x === 'object' ? x.id : x; } return typeof f === 'object' ? f.id : f; };
    const set = new Set(monthKeys);
    const blank = () => ({ reRevenue: 0, personalIncome: 0, bizItems: {}, perItems: {} });
    const byMonth = {};
    monthKeys.forEach(k => byMonth[k] = blank());
    txns.forEach(tx => {
        const dateStr = getField(tx, F.txDate); if (!dateStr) return;
        const d = new Date(dateStr); if (isNaN(d)) return;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!set.has(key)) return;
        const sub = subNames[linkId(getField(tx, F.txSubCategory))] || '';
        const amt = Number(getField(tx, F.txReportAmount)) || 0; // inflow +, outflow −
        const m = byMonth[key];
        if (reSet.has(sub)) m.reRevenue += amt;
        else if (piSet.has(sub)) m.personalIncome += amt;
        else if (bizSet.has(sub)) m.bizItems[sub] = (m.bizItems[sub] || 0) + (-amt); // positive magnitude
        else if (perSet.has(sub)) m.perItems[sub] = (m.perItems[sub] || 0) + (-amt);
    });
    return monthKeys.map(k => {
        const m = byMonth[k];
        const bizTotal = Object.values(m.bizItems).reduce((s, v) => s + v, 0);
        const perTotal = Object.values(m.perItems).reduce((s, v) => s + v, 0);
        const totalIncome = m.reRevenue + m.personalIncome;
        return {
            key: k, reRevenue: m.reRevenue, personalIncome: m.personalIncome, totalIncome,
            bizItems: m.bizItems, bizTotal, perItems: m.perItems, perTotal,
            net: totalIncome - bizTotal - perTotal,
        };
    });
}

function wealthMonthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

// Strip the accounting prefixes so itemised lines read cleanly.
function wealthCfLabel(name) {
    return String(name).replace(/^COGS /, '').replace(/^Opex /, '').replace(/^Personal /, '');
}

// ── Shared 12-month matrix ───────────────────────────────────────────────────
// Every Wealth section renders through this so they share one format: a sticky
// label column, 12 rolling month columns (value + a small up/down arrow vs the
// previous month), and a final "12-mo" column = change from the first shown month
// to now. Rows with `items` are expandable (click the label to toggle sub-rows).
//   months   = [{ key, label }]
//   sections = [{ header, rows }];  row = { label, values:[12|null], items?, bold, goodUp(=true), border }
let _wealthRowSeq = 0;
// Period (months) for the matrices' trend/change column. Changed via the selector.
let _wealthChangeMonths = 12;
function wealthToggleRows(rid, td) {
    const rows = document.querySelectorAll('tr.wm-child-' + rid);
    let shown = false;
    rows.forEach(r => { const hidden = r.style.display === 'none'; r.style.display = hidden ? '' : 'none'; shown = hidden; });
    const caret = td.querySelector('.wm-caret'); if (caret) caret.textContent = shown ? '▾' : '▸';
}
// opts.leadHeader (string) adds a highlighted column right after the labels, fed by
// each row's `lead` value (e.g. "In the pot" for buckets). opts.anchor controls the
// % trends: 'completed' anchors on the last completed month (for flow data distorted
// by the partial current month); otherwise the latest/current column is used.
function wealthMatrixCard(title, note, months, sections, opts) {
    opts = opts || {};
    const leadHeader = opts.leadHeader || null;
    const stick = 'position:sticky;left:0;background:var(--bg-surface);z-index:1';
    const colCount = months.length + 2 + (leadHeader ? 1 : 0);
    const lastCol = months.length - 1;
    const refIdx = wealthCompletedIdx(months.map(m => m.key));
    const anchorIdx = opts.anchor === 'completed' ? refIdx : lastCol;
    const runningIdx = anchorIdx !== lastCol ? lastCol : -1; // current partial month, shown but not the % anchor
    const colStyle = i => i === anchorIdx ? 'background:var(--accent-soft);' : (i === runningIdx ? 'background:var(--bg-subtle);' : '');
    const monthHead = months.map((m, i) => {
        const isAnchor = i === anchorIdx;
        return `<th style="text-align:right;padding:6px 8px;font-weight:${isAnchor ? 'var(--fw-semibold)' : 'var(--fw-regular)'};color:${isAnchor ? 'var(--text-primary)' : 'var(--text-muted)'};white-space:nowrap;${colStyle(i)}">${escHtml(m.label)}${i === runningIdx ? ' <span style="font-size:8px;color:var(--text-muted)" title="Current month, still in progress">●</span>' : ''}</th>`;
    }).join('');
    const leadHead = leadHeader ? `<th style="text-align:right;padding:6px 8px;font-weight:var(--fw-semibold);color:var(--text-primary);white-space:nowrap;background:var(--accent-soft)">${escHtml(leadHeader)}</th>` : '';

    const valCell = (v, prev, goodUp, i) => {
        const bg = colStyle(i);
        if (v == null) return `<td style="text-align:right;padding:5px 8px;color:var(--text-muted);${bg}">–</td>`;
        let arrow = '';
        if (prev != null && prev !== 0) {
            const pct = (v - prev) / Math.abs(prev) * 100;
            if (isFinite(pct) && Math.round(pct) !== 0) {
                const up = pct > 0, good = goodUp ? up : !up;
                arrow = ` <span style="font-size:9px;color:${good ? 'var(--success)' : 'var(--danger)'}">${up ? '▲' : '▼'}</span>`;
            }
        }
        return `<td style="text-align:right;padding:5px 8px;white-space:nowrap;${bg}color:${v < 0 ? 'var(--danger)' : 'var(--text-primary)'}">${fmt0(v)}${arrow}</td>`;
    };
    const changeCell = (values, goodUp) => {
        let cur = values[anchorIdx];
        if (cur == null && opts.anchor !== 'completed') { const nn = values.filter(v => v != null); cur = nn.length ? nn[nn.length - 1] : null; }
        let prev = values[anchorIdx - _wealthChangeMonths];
        if (prev == null) { const nn = values.slice(0, anchorIdx + 1).filter(v => v != null); prev = nn.length ? nn[0] : null; } // fall back to the earliest available
        if (cur == null || prev == null || prev === 0) return `<td style="text-align:right;padding:5px 8px;color:var(--text-muted)">–</td>`;
        const pct = (cur - prev) / Math.abs(prev) * 100;
        if (Math.round(pct) === 0) return `<td style="text-align:right;padding:5px 8px;color:var(--text-muted);white-space:nowrap">0%</td>`;
        const up = pct > 0, good = goodUp ? up : !up;
        return `<td style="text-align:right;padding:5px 8px;white-space:nowrap;font-weight:var(--fw-semibold);color:${good ? 'var(--success)' : 'var(--danger)'}">${up ? '▲' : '▼'} ${Math.abs(Math.round(pct))}%</td>`;
    };
    const leadCell = (row, isChild) => {
        if (!leadHeader) return '';
        if (isChild || row.lead == null) return `<td style="background:var(--accent-soft)"></td>`;
        return `<td style="text-align:right;padding:5px 8px;white-space:nowrap;background:var(--accent-soft);font-weight:var(--fw-semibold);color:${row.lead < 0 ? 'var(--danger)' : 'var(--text-primary)'}">${fmt0(row.lead)}</td>`;
    };
    const renderRow = (row, isChild, parentRid) => {
        const goodUp = row.goodUp !== false;
        const vals = row.values;
        const rowBg = isChild ? 'var(--bg-surface-2)' : (row.bold ? 'var(--bg-subtle)' : 'var(--bg-surface)');
        const cells = vals.map((v, i) => valCell(v, i > 0 ? vals[i - 1] : null, goodUp, i)).join('');
        const hasItems = row.items && row.items.length;
        const rid = hasItems ? ('r' + (++_wealthRowSeq)) : '';
        const caret = hasItems ? '<span class="wm-caret" style="display:inline-block;width:12px;color:var(--text-muted)">▸</span>' : (isChild ? '' : '<span style="display:inline-block;width:12px"></span>');
        const trAttr = isChild ? `class="wm-child-${parentRid}" style="display:none;background:${rowBg}"` : `style="background:${rowBg}${row.border ? ';border-top:' + row.border : ''}"`;
        const labelStyle = `text-align:left;padding:5px 8px;${isChild ? 'padding-left:26px;' : ''}font-weight:${row.bold ? 'var(--fw-bold)' : 'var(--fw-regular)'};color:${isChild ? 'var(--text-secondary)' : 'var(--text-primary)'};position:sticky;left:0;background:${rowBg};z-index:1${hasItems ? ';cursor:pointer' : ''}`;
        const onclick = hasItems ? ` onclick="wealthToggleRows('${rid}',this)"` : '';
        let html = `<tr ${trAttr}><td${onclick} style="${labelStyle}">${caret}${escHtml(row.label)}</td>${leadCell(row, isChild)}${cells}${changeCell(vals, goodUp)}</tr>`;
        if (hasItems) html += row.items.map(it => renderRow(it, true, rid)).join('');
        return html;
    };
    const body = sections.map(sec => {
        const sh = sec.header ? `<tr><td colspan="${colCount}" style="padding:12px 8px 2px;font-size:var(--fs-xs);font-weight:var(--fw-semibold);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;${stick}">${escHtml(sec.header)}</td></tr>` : '';
        return sh + sec.rows.map(r => renderRow(r, false)).join('');
    }).join('');

    return `<div class="kpi-card" style="margin-bottom:var(--space-5)">
        <div class="kpi-card-label" style="margin-bottom:4px">${escHtml(title)}</div>
        ${note ? `<div style="color:var(--text-muted);font-size:var(--fs-xs);margin-bottom:10px;line-height:1.5">${note}</div>` : ''}
        <div style="overflow-x:auto">
            <table style="border-collapse:collapse;font-size:var(--fs-sm);width:100%">
                <thead><tr><th style="${stick}"></th>${leadHead}${monthHead}<th style="text-align:right;padding:6px 8px;font-weight:var(--fw-semibold);color:var(--text-primary);white-space:nowrap">${_wealthChangeMonths}-mo Δ</th></tr></thead>
                <tbody>${body}</tbody>
            </table>
        </div>
    </div>`;
}

// Rolling 12-month list ending at the CURRENT (partial) month, with short labels
// (e.g. "Jul 25"). The current month is shown so today's figures are visible, but
// the matrices anchor their % trends on the last completed month (wealthCompletedIdx).
function wealthMonths12() {
    return wealthMonthKeys(12, 0).map(k => ({ key: k, label: wealthMonthLabel(k).split(' ')[0].slice(0, 3) + ' ' + k.slice(2, 4) }));
}

// Selector handler: set the Δ-column period and re-render the tab from cached data.
function setWealthChangePeriod(n) {
    _wealthChangeMonths = n;
    const el = document.getElementById('tab-wealth');
    if (el && _wealthRecords) renderWealthContent(el, _wealthRecords);
}


function renderWealthCashflow() {
    const el = document.getElementById('wealthCashflow');
    if (!el) return;
    const txns = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];
    if (!txns.length) { el.innerHTML = ''; return; }

    const months = wealthMonths12();
    const cf = buildMonthlyCashflow(months.map(m => m.key));
    const series = pick => cf.map(pick);
    const bizNames = CASHFLOW_COST_SUBCATS.filter(n => cf.some(m => m.bizItems[n]));
    const perNames = CASHFLOW_PERSONAL_EXPENSE_SUBCATS.filter(n => cf.some(m => m.perItems[n]));

    const sections = [
        { header: 'Money in', rows: [
            { label: 'Real estate / portfolio revenue', values: series(m => m.reRevenue), goodUp: true },
            { label: 'Personal income', values: series(m => m.personalIncome), goodUp: true },
            { label: 'Total income', values: series(m => m.totalIncome), goodUp: true, bold: true, border: '1px solid var(--border-default)' },
        ] },
        { header: 'Expenditure', rows: [
            { label: 'Business expenditure', values: series(m => m.bizTotal), goodUp: false, bold: true,
              items: bizNames.map(n => ({ label: wealthCfLabel(n), values: series(m => m.bizItems[n] || 0), goodUp: false })) },
            { label: 'Personal expenditure', values: series(m => m.perTotal), goodUp: false, bold: true,
              items: perNames.map(n => ({ label: wealthCfLabel(n), values: series(m => m.perItems[n] || 0), goodUp: false })) },
        ] },
        { header: '', rows: [
            { label: 'Net cash flow', values: series(m => m.net), goodUp: true, bold: true, border: '2px solid var(--border-default)' },
        ] },
    ];
    el.innerHTML = wealthMatrixCard(
        'Monthly cash flow — rolling 12 months',
        'Money in (real estate / portfolio revenue + personal income, internal drawings excluded) less itemised business and personal expenditure = net cash flow, which feeds your buckets. Click Business or Personal expenditure to expand the detail. The current month (●) is still in progress; the highlighted column and the Δ trend use the last completed month. Business expenditure is operating costs (matching the P&L); capital repayments not yet included.',
        months, sections, { anchor: 'completed' });
}

// ── Property portfolio — per property ─────────────────────────────────────────
// Joins each property's latest Approved valuation (Property Valuations table) to
// its mortgage balance (Debt Terms, Class=Mortgages) to show value, mortgage and
// equity per property, plus reconciled real-estate / mortgage / equity totals.
// This itemises what the monthly snapshot holds as single lumped lines.
let _valRecords = null;
let _valPromise = null;

// Normalise a property name for matching valuation titles to mortgage notes.
// Strips a trailing " · ..." suffix, any "(…)" parenthetical, punctuation and case.
function wealthPropKey(s) {
    return String(s || '')
        .split('·')[0]
        .replace(/\(.*?\)/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

async function loadWealthProperties() {
    const el = document.getElementById('wealthProperties');
    if (!el) return;
    if (typeof PAT === 'undefined' || !PAT) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="kpi-card" style="color:var(--text-muted);font-size:var(--fs-sm)">Loading property portfolio…</div>`;
    try {
        if (!_valPromise) _valPromise = airtableFetch(TABLES.valuations);
        if (!_debtPromise) _debtPromise = airtableFetch(TABLES.debtTerms);
        const [vals, debts] = await Promise.all([_valPromise, _debtPromise]);
        _valRecords = vals;
        _debtRecords = debts; // share the cache with loadDebtTerms
        renderWealthProperties(el, vals, debts);
    } catch (e) {
        _valPromise = null;
        el.innerHTML = `<div class="kpi-card" style="color:var(--text-secondary);font-size:var(--fs-sm)">Could not load the property portfolio.</div>`;
    }
}

// Build the per-property portfolio: latest Approved valuation per property joined
// to its mortgage balance (Debt Terms, Class=Mortgages). Returns the rows plus
// reconciled totals. Shared by the per-property card and the hero reconciliation
// so both always show the same real-estate and mortgage figures.
function buildPortfolio(valRecs, debtRecs) {
    // Latest Approved valuation per property (key from the title).
    const latestByProp = {};
    (valRecs || []).forEach(r => {
        if (getField(r, VAL.status) !== 'Approved') return;
        const title = getField(r, VAL.title) || '';
        const key = wealthPropKey(title);
        if (!key) return;
        const value = Number(getField(r, VAL.value)) || 0;
        const date = getField(r, VAL.date) || '';
        const conf = getField(r, VAL.confidence) || '';
        const cur = latestByProp[key];
        if (!cur || date > cur.date) latestByProp[key] = { key, name: title.split('·')[0].trim(), value, date, conf };
    });

    // Mortgage balance per property (Debt Terms, Class=Mortgages). Notes start with
    // the property name ("55 Elmdon Place · …"); fall back to the record Name.
    const mortByProp = {};
    (debtRecs || []).forEach(r => {
        if (getField(r, DEBT.cls) !== 'Mortgages') return;
        const principal = Number(getField(r, DEBT.principal)) || 0;
        if (principal <= 0) return;
        const type = getField(r, DEBT.type) || 'Interest-only';
        const rate = Number(getField(r, DEBT.rate)) || 0;
        const term = Number(getField(r, DEBT.term)) || 0;
        const start = getField(r, DEBT.start) || '';
        const bal = amortisedBalance(type, principal, rate, term, start).balance;
        const note = getField(r, DEBT.notes) || '';
        const key = wealthPropKey(note) || wealthPropKey(getField(r, DEBT.name));
        if (!key) return;
        mortByProp[key] = (mortByProp[key] || 0) + bal;
    });

    // Match each valuation to a mortgage by key. Exact first, then a prefix match
    // either way so "282 Stanley Park Ave" lines up with the valuation
    // "282 Stanley Park Avenue South" and "1406 Oldham Road, Manchester" with
    // "1406 Oldham Road". Each mortgage is claimed once. Track matches so any
    // unmatched mortgage is flagged rather than silently dropped.
    const mortKeys = Object.keys(mortByProp);
    const matchedMortKeys = new Set();
    const matchMort = (pk) => {
        if (mortByProp[pk] != null && !matchedMortKeys.has(pk)) return pk;
        let best = null;
        mortKeys.forEach(m => {
            if (matchedMortKeys.has(m)) return;
            if (pk.startsWith(m) || m.startsWith(pk)) { if (!best || m.length > best.length) best = m; }
        });
        return best;
    };
    const rows = Object.values(latestByProp).map(p => {
        const mk = matchMort(p.key);
        const mort = mk ? mortByProp[mk] : 0;
        if (mk) matchedMortKeys.add(mk);
        return { ...p, mort, equity: p.value - mort };
    }).sort((a, b) => b.value - a.value);

    const totalValue = rows.reduce((s, r) => s + r.value, 0);
    const totalMortMatched = rows.reduce((s, r) => s + r.mort, 0);
    // Any mortgage not matched to a valuation (naming mismatch). It still counts as
    // debt in the all-up mortgage total, but is shown separately in the card so the
    // visible rows always sum to the card footer.
    const orphanMorts = mortKeys.filter(k => !matchedMortKeys.has(k));
    const orphanTotal = orphanMorts.reduce((s, k) => s + mortByProp[k], 0);
    return {
        rows, totalValue, totalMortMatched, orphanMorts, orphanTotal,
        totalMortAll: totalMortMatched + orphanTotal,
    };
}

function renderWealthProperties(el, valRecs, debtRecs) {
    const pf = buildPortfolio(valRecs, debtRecs);
    if (!pf.rows.length) {
        el.innerHTML = `<div class="kpi-card" style="color:var(--text-secondary);font-size:var(--fs-sm)">No approved property valuations yet.</div>`;
        return;
    }
    const rows = pf.rows;
    const totalValue = pf.totalValue;
    const totalMort = pf.totalMortMatched;
    const totalEquity = totalValue - totalMort;
    const orphanMorts = pf.orphanMorts;
    const orphanTotal = pf.orphanTotal;

    const confDot = c => {
        const col = c === 'High' ? 'var(--success)' : c === 'Low' ? 'var(--danger)' : 'var(--warning)';
        return c ? `<span title="${escHtml(c)} confidence" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${col};margin-left:6px;vertical-align:middle"></span>` : '';
    };

    const bodyRows = rows.map(r => `<tr style="border-top:1px solid var(--border-subtle)">
        <td style="padding:6px 8px;color:var(--text-primary)">${escHtml(r.name)}${confDot(r.conf)}</td>
        <td style="padding:6px 8px;text-align:right;color:var(--text-primary)">${fmt0(r.value)}</td>
        <td style="padding:6px 8px;text-align:right;color:var(--text-secondary)">${r.mort > 0 ? fmt0(r.mort) : '<span style=\"color:var(--text-muted)\">none</span>'}</td>
        <td style="padding:6px 8px;text-align:right;font-weight:var(--fw-semibold);color:${r.equity >= 0 ? 'var(--success)' : 'var(--danger)'}">${fmt0(r.equity)}</td>
    </tr>`).join('');

    el.innerHTML = `<div class="kpi-card">
        <div class="kpi-card-label" style="margin-bottom:4px">Property portfolio — per property</div>
        <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-bottom:12px;line-height:1.5">Latest approved valuation for each property, net of its mortgage. Values are desktop web-search estimates; the dot shows confidence (<span style="color:var(--success)">green</span> high, <span style="color:var(--warning)">amber</span> medium, <span style="color:var(--danger)">red</span> low). Edit a valuation in the Operations → Properties tab.</div>
        <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:var(--fs-sm)">
            <thead><tr style="color:var(--text-muted);font-size:var(--fs-xs)">
                <th style="text-align:left;padding:6px 8px">Property (${rows.length})</th>
                <th style="text-align:right;padding:6px 8px">Value</th>
                <th style="text-align:right;padding:6px 8px">Mortgage</th>
                <th style="text-align:right;padding:6px 8px">Equity</th>
            </tr></thead>
            <tbody>${bodyRows}</tbody>
            <tfoot><tr style="border-top:2px solid var(--border-default);font-weight:var(--fw-bold)">
                <td style="padding:8px;color:var(--text-primary)">Total real estate</td>
                <td style="padding:8px;text-align:right;color:var(--text-primary)">${fmt0(totalValue)}</td>
                <td style="padding:8px;text-align:right;color:var(--danger)">${fmt0(totalMort)}</td>
                <td style="padding:8px;text-align:right;color:var(--success)">${fmt0(totalEquity)}</td>
            </tr></tfoot>
        </table>
        </div>
        ${orphanTotal > 0 ? `<div style="margin-top:10px;color:var(--warning);font-size:var(--fs-xs);line-height:1.5">⚠️ ${fmt0(orphanTotal)} of mortgage debt across ${orphanMorts.length} record${orphanMorts.length === 1 ? '' : 's'} could not be matched to a valued property and is excluded above. Check the Debt Terms names.</div>` : ''}
    </div>`;
}

// ── Loan & mortgage auto-compute (amortisation) ──────────────────────────────
// Computes the current outstanding balance from each debt's terms, so loans and
// mortgages stop being a manual monthly figure. Interest-only debts hold at the
// principal; repayment debts amortise. Terms live in the Debt Terms table.
const DEBT_INP = 'padding:5px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface);';
const fmt0 = n => '£' + Math.round(n).toLocaleString('en-GB');
let _debtRecords = null;
let _debtPromise = null;

// Outstanding balance today from terms. Returns { balance, computed } where
// computed=false means we lack the terms to amortise (fall back to principal).
function amortisedBalance(type, principal, ratePct, termMonths, startStr, asOf) {
    const P = Number(principal) || 0;
    if (P <= 0) return { balance: 0, computed: false };
    if (type === 'Interest-only') return { balance: P, computed: true };
    // Repayment needs term + start to amortise.
    const n = Math.round(Number(termMonths) || 0);
    const start = startStr ? new Date(startStr) : null;
    if (!n || !start || isNaN(start.getTime())) return { balance: P, computed: false };
    const now = asOf || new Date();
    let k = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
    k = Math.max(0, Math.min(k, n));
    const i = (Number(ratePct) || 0) / 100 / 12;
    let bal;
    if (i === 0) {
        bal = P * (1 - k / n);
    } else {
        const pow = Math.pow(1 + i, k);
        const M = P * i / (1 - Math.pow(1 + i, -n));
        bal = P * pow - M * (pow - 1) / i;
    }
    return { balance: Math.max(0, Math.round(bal * 100) / 100), computed: true };
}

async function loadDebtTerms() {
    const el = document.getElementById('wealthDebts');
    if (!el) return;
    if (!_debtRecords) {
        el.innerHTML = `<div class="kpi-card" style="color:var(--text-muted);font-size:var(--fs-sm)">Loading loans & mortgages…</div>`;
        if (typeof PAT === 'undefined' || !PAT) { el.innerHTML = ''; return; }
        try {
            if (!_debtPromise) _debtPromise = airtableFetch(TABLES.debtTerms);
            _debtRecords = await _debtPromise;
        } catch (e) {
            _debtPromise = null;
            el.innerHTML = `<div class="kpi-card" style="color:var(--text-secondary);font-size:var(--fs-sm)">Could not load loan/mortgage terms.</div>`;
            return;
        }
    }
    renderDebtTerms(el);
}

function renderDebtTerms(el) {
    const recs = (_debtRecords || []).slice();
    const sel = (cur, opts) => opts.map(o => `<option value="${o}"${o === cur ? ' selected' : ''}>${o}</option>`).join('');
    const rowHtml = (r) => {
        const id = r ? r.id : '';
        const name = r ? (getField(r, DEBT.name) || '') : '';
        const cls = r ? (getField(r, DEBT.cls) || 'Loans') : 'Loans';
        const type = r ? (getField(r, DEBT.type) || 'Repayment') : 'Repayment';
        const principal = r ? (Number(getField(r, DEBT.principal)) || 0) : 0;
        const rate = r ? (Number(getField(r, DEBT.rate)) || 0) : 0;
        const term = r ? (Number(getField(r, DEBT.term)) || 0) : 0;
        const start = r ? (getField(r, DEBT.start) || '') : '';
        const calc = amortisedBalance(type, principal, rate, term, start);
        const balText = principal > 0 ? (calc.computed ? fmt0(calc.balance) : fmt0(calc.balance) + ' *') : '–';
        return `<tr class="debt-row" data-debt-id="${escHtml(id)}" style="border-top:1px solid var(--border-subtle)">
            <td style="padding:5px 6px"><input type="text" class="d-name" value="${escHtml(name)}" placeholder="Name" style="${DEBT_INP}width:140px"></td>
            <td style="padding:5px 6px"><select class="d-cls" style="${DEBT_INP}">${sel(cls, ['Loans', 'Mortgages'])}</select></td>
            <td style="padding:5px 6px"><select class="d-type" onchange="recalcDebtRow(this)" style="${DEBT_INP}">${sel(type, ['Repayment', 'Interest-only'])}</select></td>
            <td style="padding:5px 6px;text-align:right"><span style="color:var(--text-muted)">£</span><input type="number" class="d-principal" value="${principal || ''}" oninput="recalcDebtRow(this)" placeholder="0" style="${DEBT_INP}width:96px;text-align:right"></td>
            <td style="padding:5px 6px;text-align:right"><input type="number" step="0.01" class="d-rate" value="${rate || ''}" oninput="recalcDebtRow(this)" placeholder="0" style="${DEBT_INP}width:60px;text-align:right">%</td>
            <td style="padding:5px 6px;text-align:right"><input type="number" class="d-term" value="${term || ''}" oninput="recalcDebtRow(this)" placeholder="0" style="${DEBT_INP}width:60px;text-align:right"></td>
            <td style="padding:5px 6px"><input type="date" class="d-start" value="${escHtml(start)}" onchange="recalcDebtRow(this)" style="${DEBT_INP}"></td>
            <td class="d-balance" style="padding:5px 6px;text-align:right;font-weight:var(--fw-semibold);color:var(--text-primary);white-space:nowrap">${balText}</td>
            <td style="padding:5px 6px;text-align:center"><button onclick="this.closest('.debt-row').remove()" title="Remove" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:15px">&times;</button></td>
        </tr>`;
    };
    const bodyRows = recs.map(rowHtml).join('');

    el.innerHTML = `<div class="kpi-card">
        <div class="kpi-card-label" style="margin-bottom:4px">Loans &amp; mortgages — auto-computed</div>
        <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-bottom:12px;line-height:1.5">Enter each debt's terms once. The balance is then computed every month: interest-only holds at the original amount; repayment amortises. A <strong>*</strong> means the balance is the original amount because repayment terms (rate, term, start) are not complete yet.</div>
        <div id="debtSaveError" style="display:none;color:var(--danger);font-size:var(--fs-sm);margin-bottom:8px"></div>
        <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:var(--fs-sm)">
            <thead><tr style="color:var(--text-muted);font-size:var(--fs-xs)">
                <th style="text-align:left;padding:5px 6px">Name</th><th style="text-align:left;padding:5px 6px">Class</th><th style="text-align:left;padding:5px 6px">Type</th>
                <th style="text-align:right;padding:5px 6px">Original</th><th style="text-align:right;padding:5px 6px">Rate</th><th style="text-align:right;padding:5px 6px">Term (mo)</th>
                <th style="text-align:left;padding:5px 6px">Start</th><th style="text-align:right;padding:5px 6px">Balance now</th><th></th>
            </tr></thead>
            <tbody id="debtRows">${bodyRows}</tbody>
        </table>
        </div>
        <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
            <button id="debtSaveBtn" onclick="saveDebtTerms()" style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);padding:8px 18px;font-weight:var(--fw-semibold);cursor:pointer">Save terms</button>
            <button onclick="addDebtRow()" style="background:none;border:1px dashed var(--border-default);border-radius:var(--radius-md);padding:8px 16px;cursor:pointer;color:var(--accent)">+ Add debt</button>
            <span style="color:var(--text-muted);font-size:var(--fs-xs);align-self:center">Computed balances flow into your net-worth update next.</span>
        </div>
    </div>`;
}

// Recompute one row's "Balance now" cell live as terms are edited.
function recalcDebtRow(inp) {
    const row = inp.closest('.debt-row');
    if (!row) return;
    const type = row.querySelector('.d-type').value;
    const principal = row.querySelector('.d-principal').value;
    const rate = row.querySelector('.d-rate').value;
    const term = row.querySelector('.d-term').value;
    const start = row.querySelector('.d-start').value;
    const calc = amortisedBalance(type, principal, rate, term, start);
    const cell = row.querySelector('.d-balance');
    if (cell) cell.textContent = (Number(principal) > 0) ? (calc.computed ? fmt0(calc.balance) : fmt0(calc.balance) + ' *') : '–';
}

function addDebtRow() {
    const tbody = document.getElementById('debtRows');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.className = 'debt-row';
    tr.dataset.debtId = '';
    tr.style.borderTop = '1px solid var(--border-subtle)';
    tr.innerHTML = `<td style="padding:5px 6px"><input type="text" class="d-name" placeholder="Name" style="${DEBT_INP}width:140px"></td>
        <td style="padding:5px 6px"><select class="d-cls" style="${DEBT_INP}"><option>Loans</option><option>Mortgages</option></select></td>
        <td style="padding:5px 6px"><select class="d-type" onchange="recalcDebtRow(this)" style="${DEBT_INP}"><option>Repayment</option><option>Interest-only</option></select></td>
        <td style="padding:5px 6px;text-align:right"><span style="color:var(--text-muted)">£</span><input type="number" class="d-principal" oninput="recalcDebtRow(this)" placeholder="0" style="${DEBT_INP}width:96px;text-align:right"></td>
        <td style="padding:5px 6px;text-align:right"><input type="number" step="0.01" class="d-rate" oninput="recalcDebtRow(this)" placeholder="0" style="${DEBT_INP}width:60px;text-align:right">%</td>
        <td style="padding:5px 6px;text-align:right"><input type="number" class="d-term" oninput="recalcDebtRow(this)" placeholder="0" style="${DEBT_INP}width:60px;text-align:right"></td>
        <td style="padding:5px 6px"><input type="date" class="d-start" onchange="recalcDebtRow(this)" style="${DEBT_INP}"></td>
        <td class="d-balance" style="padding:5px 6px;text-align:right;font-weight:var(--fw-semibold);color:var(--text-primary)">–</td>
        <td style="padding:5px 6px;text-align:center"><button onclick="this.closest('.debt-row').remove()" title="Remove" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:15px">&times;</button></td>`;
    tbody.appendChild(tr);
}

async function saveDebtTerms() {
    const btn = document.getElementById('debtSaveBtn');
    const errEl = document.getElementById('debtSaveError');
    const showErr = m => { if (errEl) { errEl.style.display = 'block'; errEl.textContent = m; } if (btn) { btn.disabled = false; btn.textContent = 'Save terms'; } };
    const rows = [...document.querySelectorAll('.debt-row')];
    const creates = [], updates = [];
    rows.forEach(row => {
        const name = row.querySelector('.d-name').value.trim();
        if (!name) return;
        const fields = {
            [DEBT.name]: name,
            [DEBT.cls]: row.querySelector('.d-cls').value,
            [DEBT.type]: row.querySelector('.d-type').value,
            [DEBT.principal]: Number(row.querySelector('.d-principal').value) || 0,
            [DEBT.rate]: Number(row.querySelector('.d-rate').value) || 0,
            [DEBT.term]: Number(row.querySelector('.d-term').value) || 0,
            [DEBT.start]: row.querySelector('.d-start').value || null,
        };
        if (row.dataset.debtId) updates.push({ id: row.dataset.debtId, fields });
        else creates.push({ fields });
    });
    if (!creates.length && !updates.length) { showErr('Nothing to save.'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        for (let i = 0; i < updates.length; i += 10) {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.debtTerms}`, {
                method: 'PATCH', headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ records: updates.slice(i, i + 10), typecast: true }),
            });
            if (!resp.ok) throw new Error('Airtable ' + resp.status);
        }
        for (let i = 0; i < creates.length; i += 10) {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.debtTerms}`, {
                method: 'POST', headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ records: creates.slice(i, i + 10), typecast: true }),
            });
            if (!resp.ok) throw new Error('Airtable ' + resp.status);
        }
        _debtRecords = null;
        _debtPromise = null;
        await loadDebtTerms();
    } catch (e) {
        showErr('Could not save: ' + (e.message || 'error'));
    }
}

// ── Personal expenditure + budgets (actual spend per category vs budget) ─────
// Sums transactions coded to the personal-expense sub-categories, by month, over
// the last 6 months, and compares the average to a monthly budget per category
// (Personal Budgets table). Spend comes from the global allTransactions (no
// fetch); budgets are fetched once and cached.
let _budgetRecords = null;
let _budgetPromise = null;

async function renderPersonalExpenditure() {
    const el = document.getElementById('wealthExpenditure');
    if (!el) return;
    const txns = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];
    if (!txns.length) {
        el.innerHTML = `<div class="kpi-card" style="color:var(--text-muted);font-size:var(--fs-sm)">Personal expenditure loads once transactions have synced — open the Leadership Dashboard once, then come back.</div>`;
        return;
    }

    // Budgets (fetch once, cache). Failure is non-fatal — table still shows spend.
    if (!_budgetRecords && typeof PAT !== 'undefined' && PAT) {
        try {
            if (!_budgetPromise) _budgetPromise = airtableFetch(TABLES.personalBudgets);
            _budgetRecords = await _budgetPromise;
        } catch (e) { _budgetRecords = []; _budgetPromise = null; }
    }
    const budgetByName = {}, budgetIdByName = {};
    (_budgetRecords || []).forEach(r => {
        const n = getField(r, PBUDGET.category);
        if (n) { budgetByName[n] = Number(getField(r, PBUDGET.budget)) || 0; budgetIdByName[n] = r.id; }
    });

    const catIds = new Set(PERSONAL_EXPENSE_SUBCATS.map(c => c.id));

    // Last 6 calendar months (oldest → newest)
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({ key: d.getFullYear() + '-' + d.getMonth(), label: d.toLocaleDateString('en-GB', { month: 'short' }) });
    }
    const monthKeys = new Set(months.map(m => m.key));

    const data = {};
    const txnsByCat = {};
    PERSONAL_EXPENSE_SUBCATS.forEach(c => { data[c.id] = {}; txnsByCat[c.id] = []; });
    txns.forEach(r => {
        const sc = getField(r, F.txSubCategory);
        const scIds = Array.isArray(sc) ? sc.map(x => (x && typeof x === 'object') ? x.id : x) : [];
        const hit = scIds.find(id => catIds.has(id));
        if (!hit) return;
        const dateStr = getField(r, F.txDate);
        if (!dateStr) return;
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return;
        const key = d.getFullYear() + '-' + d.getMonth();
        if (!monthKeys.has(key)) return;
        // Spend = money out. Report amount is NEGATIVE for outflows and POSITIVE
        // for refunds / direct-debit reversals, so negate it: outflows add to
        // spend, reversals net OFF. (Previously Math.abs() added reversals too,
        // which overstated the totals.)
        const signed = (typeof txDisplayAmount === 'function') ? txDisplayAmount(r) : (Number(getField(r, F.txReportAmount)) || 0);
        const amt = -signed;
        data[hit][key] = (data[hit][key] || 0) + amt;
        // Keep the underlying transactions so each category can be drilled into.
        txnsByCat[hit].push({
            d,
            desc: String(getField(r, F.txDescription) || getField(r, F.txVendor) || '(no description)'),
            account: String(getField(r, F.txAccountAlias) || ''),
            amt,
        });
    });

    const rows = PERSONAL_EXPENSE_SUBCATS.map(c => {
        const byMonth = months.map(m => data[c.id][m.key] || 0);
        const total = byMonth.reduce((s, v) => s + v, 0);
        return { id: c.id, name: c.name, byMonth, total, avg: total / months.length, budget: budgetByName[c.name] || 0, budgetId: budgetIdByName[c.name] || '', txns: txnsByCat[c.id] };
    }).sort((a, b) => b.total - a.total);

    const grandAvg = rows.reduce((s, r) => s + r.total, 0) / months.length;
    const grandBudget = rows.reduce((s, r) => s + r.budget, 0);
    const fmt0 = n => '£' + Math.round(n).toLocaleString('en-GB');

    const headCells = months.map(m => `<th style="text-align:right;padding:6px 8px;font-weight:var(--fw-medium);color:var(--text-muted);font-size:var(--fs-xs)">${escHtml(m.label)}</th>`).join('');
    const colspan = months.length + 3; // Category + months + Avg + Budget
    const fmt2 = n => '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const bodyRows = rows.map(r => {
        const cells = r.byMonth.map(v => `<td style="text-align:right;padding:6px 8px;color:${Math.abs(v) >= 0.005 ? (v < 0 ? 'var(--success)' : 'var(--text-primary)') : 'var(--text-muted)'}">${Math.abs(v) >= 0.005 ? fmt0(v) : '–'}</td>`).join('');
        // Colour the average vs budget: over = danger, within = success, no budget = neutral.
        const avgColour = r.budget > 0 ? (r.avg > r.budget ? 'var(--danger)' : 'var(--success)') : 'var(--text-primary)';
        const flag = r.budget > 0 ? (r.avg > r.budget ? ` (+${fmt0(r.avg - r.budget)})` : ` (−${fmt0(r.budget - r.avg)})`) : '';
        // Drill-down: the transactions making up this category, most recent first.
        // Reversals/refunds (negative spend) are shown in green so they stand out.
        const txnRows = r.txns.slice().sort((a, b) => b.d - a.d).map(t => `<tr style="border-top:1px solid var(--border-subtle)">
            <td style="padding:4px 8px;color:var(--text-secondary);white-space:nowrap">${t.d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
            <td style="padding:4px 8px;color:var(--text-primary)">${escHtml(t.desc)}</td>
            <td style="padding:4px 8px;color:var(--text-muted);white-space:nowrap">${escHtml(t.account)}</td>
            <td style="padding:4px 8px;text-align:right;white-space:nowrap;color:${t.amt < 0 ? 'var(--success)' : 'var(--text-primary)'}">${fmt2(t.amt)}</td>
        </tr>`).join('');
        const detail = r.txns.length
            ? `<table style="width:100%;border-collapse:collapse;font-size:var(--fs-xs);background:var(--bg-surface-2);border-radius:var(--radius-sm)">
                <thead><tr><th style="text-align:left;padding:4px 8px;color:var(--text-muted)">Date</th><th style="text-align:left;padding:4px 8px;color:var(--text-muted)">Description</th><th style="text-align:left;padding:4px 8px;color:var(--text-muted)">Account</th><th style="text-align:right;padding:4px 8px;color:var(--text-muted)">Amount</th></tr></thead>
                <tbody>${txnRows}</tbody></table>
                <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-top:6px">${r.txns.length} transaction${r.txns.length === 1 ? '' : 's'} over 6 months. Anything in the wrong place? Recategorise it in reconciliation and it drops out here.</div>`
            : `<div style="color:var(--text-muted);font-size:var(--fs-xs)">No transactions in the last 6 months.</div>`;
        return `<tr style="border-top:1px solid var(--border-subtle)">
            <td style="padding:6px 8px"><span onclick="toggleExpDetail('${r.id}')" style="cursor:pointer;color:var(--accent);user-select:none"><span id="exp-chev-${r.id}" style="display:inline-block;width:12px;transition:transform .15s">▸</span> ${escHtml(r.name)}</span></td>
            ${cells}
            <td style="text-align:right;padding:6px 8px;font-weight:var(--fw-semibold);color:${avgColour}">${fmt0(r.avg)}<span style="font-size:var(--fs-xs);font-weight:var(--fw-regular)">${flag}</span></td>
            <td style="text-align:right;padding:6px 8px"><span style="color:var(--text-muted)">£</span><input type="number" step="1" min="0" class="pbud" data-budget-id="${escHtml(r.budgetId)}" data-avg="${Math.round(r.avg)}" value="${r.budget || ''}" placeholder="0" style="width:84px;padding:5px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);text-align:right;background:var(--bg-surface)"></td>
        </tr>
        <tr id="exp-detail-${r.id}" style="display:none"><td colspan="${colspan}" style="padding:4px 8px 12px 28px">${detail}</td></tr>`;
    }).join('');
    const totalCells = months.map((m, idx) => {
        const t = rows.reduce((s, r) => s + (r.byMonth[idx] || 0), 0);
        return `<td style="text-align:right;padding:8px;font-weight:var(--fw-semibold);color:var(--text-primary)">${fmt0(t)}</td>`;
    }).join('');

    el.innerHTML = `<div class="kpi-card">
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px;flex-wrap:wrap">
            <span class="kpi-card-label">Personal expenditure vs budget</span>
            <span style="margin-left:auto;color:var(--text-secondary);font-size:var(--fs-sm)">Avg/month: <strong style="color:var(--text-primary)">${fmt0(grandAvg)}</strong>${grandBudget > 0 ? ` vs budget <strong style="color:${grandAvg > grandBudget ? 'var(--danger)' : 'var(--success)'}">${fmt0(grandBudget)}</strong>` : ''}</span>
        </div>
        <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-bottom:12px;line-height:1.5">Actual spend per category, last 6 months, from your reconciled transactions (biggest first). Set a monthly budget per category; the Avg turns red when you are over it, green when under. Save to persist.</div>
        <div id="budgetSaveError" style="display:none;color:var(--danger);font-size:var(--fs-sm);margin-bottom:8px"></div>
        <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:var(--fs-sm)">
            <thead><tr>
                <th style="text-align:left;padding:6px 8px;font-weight:var(--fw-medium);color:var(--text-muted);font-size:var(--fs-xs)">Category</th>
                ${headCells}
                <th style="text-align:right;padding:6px 8px;font-weight:var(--fw-medium);color:var(--text-muted);font-size:var(--fs-xs)">Avg</th>
                <th style="text-align:right;padding:6px 8px;font-weight:var(--fw-medium);color:var(--text-muted);font-size:var(--fs-xs)">Budget</th>
            </tr></thead>
            <tbody>${bodyRows}</tbody>
            <tfoot><tr style="border-top:2px solid var(--border-default)">
                <td style="padding:8px;font-weight:var(--fw-semibold);color:var(--text-primary)">Total</td>
                ${totalCells}
                <td style="text-align:right;padding:8px;font-weight:var(--fw-bold);color:var(--text-primary)">${fmt0(grandAvg)}</td>
                <td style="text-align:right;padding:8px;font-weight:var(--fw-bold);color:var(--text-primary)">${grandBudget > 0 ? fmt0(grandBudget) : '–'}</td>
            </tr></tfoot>
        </table>
        </div>
        <div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button id="budgetSaveBtn" onclick="saveBudgets()" style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);padding:8px 18px;font-weight:var(--fw-semibold);cursor:pointer">Save budgets</button>
            <button onclick="suggestBudgets()" style="background:none;border:1px solid var(--border-default);border-radius:var(--radius-md);padding:8px 16px;cursor:pointer;color:var(--text-primary)">Suggest from spend</button>
            <span style="color:var(--text-muted);font-size:var(--fs-xs)">fills each budget from its 6-month average (rounded up), then review and Save</span>
        </div>
    </div>`;
}

// Toggle a category's transaction drill-down row.
function toggleExpDetail(catId) {
    const row = document.getElementById('exp-detail-' + catId);
    const chev = document.getElementById('exp-chev-' + catId);
    if (!row) return;
    const open = row.style.display !== 'none';
    row.style.display = open ? 'none' : 'table-row';
    if (chev) chev.style.transform = open ? '' : 'rotate(90deg)';
}

// Fill each budget input from its category's 6-month average, rounded UP to a
// clean figure so it is a realistic, slightly-generous target. Does not save.
function suggestBudgets() {
    document.querySelectorAll('.pbud').forEach(inp => {
        const avg = Number(inp.dataset.avg) || 0;
        let suggestion = 0;
        if (avg > 0) suggestion = avg < 100 ? Math.ceil(avg / 5) * 5 : Math.ceil(avg / 10) * 10;
        inp.value = suggestion;
        inp.style.borderColor = 'var(--accent)';
    });
}

async function saveBudgets() {
    const btn = document.getElementById('budgetSaveBtn');
    const errEl = document.getElementById('budgetSaveError');
    const records = [...document.querySelectorAll('.pbud')]
        .filter(i => i.dataset.budgetId)
        .map(i => ({ id: i.dataset.budgetId, fields: { [PBUDGET.budget]: Number(i.value) || 0 } }));
    if (!records.length) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        for (let i = 0; i < records.length; i += 10) {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.personalBudgets}`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ records: records.slice(i, i + 10) }),
            });
            if (!resp.ok) throw new Error('Airtable returned ' + resp.status);
        }
        _budgetRecords = null;
        _budgetPromise = null;
        await renderPersonalExpenditure();
    } catch (e) {
        if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Could not save budgets: ' + (e.message || 'error'); }
        if (btn) { btn.disabled = false; btn.textContent = 'Save budgets'; }
    }
}

// ── Income buckets ───────────────────────────────────────────────────────────
// Virtual overlay: allocate the Money Confidence surplus across pots by %, track
// a running balance per pot. Persisted in the Income Buckets Airtable table.
let _bucketsRecords = null;
let _bucketsPromise = null;

async function loadWealthBuckets() {
    const el = document.getElementById('wealthBuckets');
    if (!el) return;
    if (!_bucketsRecords) {
        el.innerHTML = `<div class="kpi-card" style="color:var(--text-muted);font-size:var(--fs-sm)">Loading income buckets…</div>`;
        try {
            if (!_bucketsPromise) _bucketsPromise = airtableFetch(TABLES.incomeBuckets);
            _bucketsRecords = await _bucketsPromise;
        } catch (e) {
            _bucketsPromise = null;
            el.innerHTML = `<div class="kpi-card" style="color:var(--text-secondary);font-size:var(--fs-sm)">Could not load income buckets.</div>`;
            return;
        }
    }
    renderBucketEditor(document.getElementById('wealthBucketEditor'));
    renderBuckets(el);
}

// Compact editor: add/remove buckets and set each one's % of net cash flow.
// <option> list of all sub-categories (A→Z), with the given ids pre-selected.
// A clear dropdown checklist of the chart-of-account sub-categories, with the
// given ids ticked. Friendlier than a native multi-select for new users.
function bucketSubsDropdown(linkedIds) {
    const sel = new Set(linkedIds || []);
    const subs = ((typeof allSubCategories !== 'undefined' && allSubCategories) ? allSubCategories : [])
        .map(r => ({ id: r.id, name: getField(r, 'fldO4BTJhFv5EsN6i') || '' }))
        .filter(s => s.name).sort((a, b) => a.name.localeCompare(b.name));
    const checks = subs.map(s => `<label style="display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:var(--fs-sm);cursor:pointer;white-space:nowrap;border-radius:var(--radius-sm);color:var(--text-primary)"><input type="checkbox" class="be-sub-cb" value="${escHtml(s.id)}"${sel.has(s.id) ? ' checked' : ''} onchange="bucketsLiveUpdate();bucketSubsCount(this)">${escHtml(s.name)}</label>`).join('');
    return `<div class="be-subs-wrap" style="position:relative;flex:1;min-width:210px">
        <button type="button" onclick="bucketSubsToggle(this)" style="width:100%;text-align:left;padding:6px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface);cursor:pointer;color:var(--text-secondary)"><span class="be-subs-count">${sel.size}</span> accounting categor${sel.size === 1 ? 'y' : 'ies'} ▾</button>
        <div class="be-subs-panel" style="display:none;position:absolute;z-index:20;top:calc(100% + 4px);left:0;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-md);box-shadow:var(--shadow-md);max-height:240px;overflow:auto;min-width:250px;padding:6px">
            <div style="font-size:var(--fs-xs);color:var(--text-muted);padding:2px 8px 6px;line-height:1.5">Tick the chart-of-account sub-categories whose spending draws money out of this bucket.</div>
            ${checks || '<div style="padding:6px 8px;color:var(--text-muted);font-size:var(--fs-sm)">No sub-categories loaded</div>'}
        </div>
    </div>`;
}
function bucketSubsToggle(btn) {
    const p = btn.nextElementSibling;
    if (p) p.style.display = p.style.display === 'block' ? 'none' : 'block';
}
function bucketSubsCount(cb) {
    const wrap = cb.closest('.be-subs-wrap');
    if (!wrap) return;
    const n = wrap.querySelectorAll('.be-sub-cb:checked').length;
    const btn = wrap.querySelector('button');
    if (btn) btn.innerHTML = `<span class="be-subs-count">${n}</span> accounting categor${n === 1 ? 'y' : 'ies'} ▾`;
}

function renderBucketEditor(el) {
    if (!el) return;
    const recs = (_bucketsRecords || []).slice().sort((a, b) =>
        (Number(getField(a, BUCKET.sort)) || 0) - (Number(getField(b, BUCKET.sort)) || 0));
    const rowHtml = (id, name, pct, linkedIds) => `<div class="be-row" data-id="${escHtml(id || '')}" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;flex-wrap:wrap">
        <input class="be-name" value="${escHtml(name || '')}" oninput="bucketsLiveUpdate()" placeholder="Bucket name" style="flex:1;min-width:120px;padding:6px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface)">
        <span style="display:flex;align-items:center;gap:2px"><input class="be-pct" type="number" min="0" value="${pct === '' ? '' : pct}" oninput="bucketsLiveUpdate()" style="width:60px;padding:6px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);text-align:right;background:var(--bg-surface)"><span style="color:var(--text-muted);font-size:var(--fs-sm)">%</span></span>
        ${bucketSubsDropdown(linkedIds)}
        <button onclick="this.closest('.be-row').remove();bucketsLiveUpdate()" title="Remove" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:16px;line-height:1;padding-top:6px">&times;</button>
    </div>`;
    el.innerHTML = `<div class="kpi-card">
        <div class="kpi-card-label" style="margin-bottom:6px">Manage income buckets</div>
        <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-bottom:4px">For each bucket, set its <strong>% of net cash flow</strong> and tick the <strong>accounting categories</strong> (your chart-of-account sub-categories) whose spending draws money out of it. Changes update the figures below instantly.</div>
        <div style="display:flex;gap:12px;font-size:var(--fs-xs);color:var(--text-muted);margin-bottom:10px"><span style="flex:1;min-width:120px">Bucket name</span><span style="width:80px">Allocation</span><span style="flex:1;min-width:210px">Accounting categories that draw it down</span><span style="width:14px"></span><span id="beTotal"></span></div>
        <div id="beRows">${recs.map(r => rowHtml(r.id, getField(r, BUCKET.name), Number(getField(r, BUCKET.pct)) || 0, (getField(r, BUCKET.spendSubs) || []).map(l => (l && typeof l === 'object') ? l.id : l))).join('')}</div>
        <div id="beError" style="display:none;color:var(--danger);font-size:var(--fs-sm);margin-top:6px"></div>
        <div style="display:flex;gap:10px;margin-top:10px;align-items:center">
            <button onclick="addBucketRow()" style="background:none;border:1px dashed var(--border-default);border-radius:var(--radius-md);padding:7px 14px;cursor:pointer;color:var(--accent);font-size:var(--fs-sm)">+ Add bucket</button>
            <button id="beSave" onclick="saveBucketEditor()" style="margin-left:auto;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);padding:8px 18px;font-weight:var(--fw-semibold);cursor:pointer">Save buckets</button>
        </div>
    </div>`;
    bucketEditorTotal();
}

function addBucketRow() {
    const c = document.getElementById('beRows');
    if (!c) return;
    const d = document.createElement('div');
    d.className = 'be-row';
    d.dataset.id = '';
    d.style.cssText = 'display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;flex-wrap:wrap';
    d.innerHTML = `<input class="be-name" oninput="bucketsLiveUpdate()" placeholder="Bucket name" style="flex:1;min-width:120px;padding:6px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface)">
        <span style="display:flex;align-items:center;gap:2px"><input class="be-pct" type="number" min="0" oninput="bucketsLiveUpdate()" style="width:60px;padding:6px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);text-align:right;background:var(--bg-surface)"><span style="color:var(--text-muted);font-size:var(--fs-sm)">%</span></span>
        ${bucketSubsDropdown([])}
        <button onclick="this.closest('.be-row').remove();bucketsLiveUpdate()" title="Remove" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:16px;line-height:1;padding-top:6px">&times;</button>`;
    c.appendChild(d);
    bucketsLiveUpdate();
}

// Live: redraw the 12-month buckets grid from the current editor inputs as the user
// types percentages/names or adds/removes rows, before saving.
function bucketsLiveUpdate() {
    bucketEditorTotal();
    const list = [...document.querySelectorAll('.be-row')].map(r => ({
        name: r.querySelector('.be-name').value.trim(),
        pct: Number(r.querySelector('.be-pct').value) || 0,
        subs: [...r.querySelectorAll('.be-sub-cb:checked')].map(cb => cb.value),
    })).filter(b => b.name);
    const el = document.getElementById('wealthBuckets');
    if (el) renderBuckets(el, list);
}

function bucketEditorTotal() {
    const t = [...document.querySelectorAll('.be-pct')].reduce((s, i) => s + (Number(i.value) || 0), 0);
    const el = document.getElementById('beTotal');
    if (el) el.innerHTML = `Total <strong style="color:var(--text-primary)">${t}%</strong>${t === 100 ? ' ✓' : ` <span style="color:var(--warning)">(aim for 100%)</span>`}`;
}

async function saveBucketEditor() {
    const btn = document.getElementById('beSave');
    const errEl = document.getElementById('beError');
    const fail = m => { if (errEl) { errEl.style.display = 'block'; errEl.textContent = m; } if (btn) { btn.disabled = false; btn.textContent = 'Save buckets'; } };
    const rows = [...document.querySelectorAll('.be-row')];
    const present = new Set();
    const creates = [], updates = [];
    rows.forEach((r, i) => {
        const name = r.querySelector('.be-name').value.trim();
        if (!name) return;
        const pct = Number(r.querySelector('.be-pct').value) || 0;
        const subs = [...r.querySelectorAll('.be-sub-cb:checked')].map(cb => cb.value);
        const fields = { [BUCKET.name]: name, [BUCKET.pct]: pct, [BUCKET.sort]: i + 1, [BUCKET.spendSubs]: subs };
        const id = r.dataset.id;
        if (id) { present.add(id); updates.push({ id, fields }); } else { creates.push({ fields }); }
    });
    const deletes = (_bucketsRecords || []).map(r => r.id).filter(id => !present.has(id));
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLES.incomeBuckets}`;
    try {
        for (let i = 0; i < updates.length; i += 10) {
            const resp = await fetch(url, { method: 'PATCH', headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ records: updates.slice(i, i + 10), typecast: true }) });
            if (!resp.ok) throw new Error('Airtable ' + resp.status);
        }
        for (let i = 0; i < creates.length; i += 10) {
            const resp = await fetch(url, { method: 'POST', headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ records: creates.slice(i, i + 10), typecast: true }) });
            if (!resp.ok) throw new Error('Airtable ' + resp.status);
        }
        if (deletes.length) {
            const qs = deletes.map(id => 'records[]=' + id).join('&');
            const resp = await fetch(url + '?' + qs, { method: 'DELETE', headers: { 'Authorization': `Bearer ${PAT}` } });
            if (!resp.ok) throw new Error('Airtable ' + resp.status);
        }
        _bucketsRecords = null;
        _bucketsPromise = null;
        await loadWealthBuckets();
    } catch (e) {
        fail('Could not save: ' + (e.message || 'error'));
    }
}

function renderBuckets(el, override) {
    if (!el) return;
    // `override` (live editor values) wins; otherwise read the saved bucket records.
    const list = override || (_bucketsRecords || []).slice()
        .sort((a, b) => (Number(getField(a, BUCKET.sort)) || 0) - (Number(getField(b, BUCKET.sort)) || 0))
        .map(r => ({ name: getField(r, BUCKET.name) || '(unnamed)', pct: Number(getField(r, BUCKET.pct)) || 0 }));
    const buckets = list.filter(b => b.name);
    const months = wealthMonths12();
    const last = months.length - 1;
    const totalPct = buckets.reduce((s, b) => s + (Number(b.pct) || 0), 0);

    // One consolidated table: per-bucket monthly amount in (floored at £0), with the
    // current cumulative balance ("In the pot") highlighted right after the name.
    const bal = buildBucketBalances(buckets, months);
    const byName = {}; bal.forEach(b => byName[b.name] = b);
    const rows = buckets.map(b => {
        const pct = Number(b.pct) || 0;
        const bb = byName[b.name] || { appor: months.map(() => 0), spent: months.map(() => 0), balance: months.map(() => 0) };
        return {
            label: `${b.name} (${pct}%)`,
            goodUp: true,
            lead: bb.balance[last],
            values: bb.appor,
            items: [
                { label: 'Spent', goodUp: false, values: bb.spent },
                { label: 'Running balance', goodUp: true, values: bb.balance },
            ],
        };
    });
    const totApr = months.map((_, i) => bal.reduce((s, b) => s + (b.appor[i] || 0), 0));
    const totPot = bal.reduce((s, b) => s + (b.balance[last] || 0), 0);
    rows.push({ label: 'Total allocated', goodUp: true, bold: true, border: '1px solid var(--border-default)', lead: totPot, values: totApr });

    const note = `Each row is a bucket and its share (%) of net cash flow. The highlighted "In the pot" column is what's in each bucket right now — apportioned in, less spent, never below £0. The monthly columns show what went in that month (£0 in any month with no surplus). The current month (●) is still in progress; the Δ trend uses the last completed month. Click a bucket to see what's been spent and its running balance.${totalPct !== 100 ? ` Percentages total ${totalPct}% (aim for 100%).` : ''}`;
    el.innerHTML = wealthMatrixCard('Income buckets — rolling 12 months', note, months, [{ header: '', rows }], { leadHeader: 'In the pot', anchor: 'completed' });
}

// Per-bucket cumulative balance: running (apportioned − spent). Apportioned = % of
// that month's net cash flow; spent = outflows reconciled to the bucket's mapped
// sub-categories (BUCKET_SPEND_SUBCATS). Cumulative over the months shown.
function buildBucketBalances(buckets, months) {
    const subNames = {};
    ((typeof allSubCategories !== 'undefined' && allSubCategories) ? allSubCategories : []).forEach(r => { const n = getField(r, 'fldO4BTJhFv5EsN6i'); if (n) subNames[r.id] = String(n); });
    // Map sub-category name → bucket. The live editor passes explicit `subs` ids per
    // bucket (so unticking a category updates instantly); otherwise read the saved
    // Spend Sub-Categories links, falling back to the built-in defaults.
    const subToBucket = {};
    if (buckets.some(b => b.subs)) {
        buckets.forEach(b => (b.subs || []).forEach(id => { const nm = subNames[id]; if (nm && b.name) subToBucket[nm] = b.name; }));
    } else {
        (_bucketsRecords || []).forEach(r => {
            const bname = getField(r, BUCKET.name);
            const links = getField(r, BUCKET.spendSubs) || [];
            (Array.isArray(links) ? links : []).forEach(l => { const sid = (l && typeof l === 'object') ? l.id : l; const nm = subNames[sid]; if (nm && bname) subToBucket[nm] = bname; });
        });
        Object.keys(BUCKET_SPEND_SUBCATS).forEach(b => BUCKET_SPEND_SUBCATS[b].forEach(s => { if (!subToBucket[s]) subToBucket[s] = b; }));
    }
    const linkId = f => { if (!f) return null; if (Array.isArray(f)) { const x = f[0]; return x && typeof x === 'object' ? x.id : x; } return typeof f === 'object' ? f.id : f; };
    const keys = months.map(m => m.key);
    const keyIdx = {}; keys.forEach((k, i) => keyIdx[k] = i);
    const spent = {}; buckets.forEach(b => spent[b.name] = keys.map(() => 0));
    const txns = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];
    txns.forEach(tx => {
        const amt = Number(getField(tx, F.txReportAmount)) || 0;
        if (amt >= 0) return; // outflows only
        const dateStr = getField(tx, F.txDate); if (!dateStr) return;
        const d = new Date(dateStr); if (isNaN(d)) return;
        const idx = keyIdx[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`];
        if (idx === undefined) return;
        const bucket = subToBucket[subNames[linkId(getField(tx, F.txSubCategory))] || ''];
        if (bucket && spent[bucket]) spent[bucket][idx] += -amt;
    });
    const net = buildMonthlyCashflow(keys).map(m => m.net);
    return buckets.map(b => {
        const pct = Number(b.pct) || 0;
        // Monthly amount in is floored at £0: a negative-cash-flow month puts nothing
        // in (it never draws a bucket down), so the figure shows £0, never a negative.
        const appor = net.map(n => Math.max(0, Math.round(n * pct / 100)));
        const sp = (spent[b.name] || keys.map(() => 0)).map(v => Math.round(v));
        // Cumulative balance is floored at 0: a bucket can't go negative — overspend
        // just empties it (the shortfall is picked up in the expenditure budgets).
        let run = 0;
        const balance = appor.map((a, i) => { run = Math.max(0, run + a - sp[i]); return run; });
        return { name: b.name, appor, spent: sp, balance };
    });
}

// Distribute the allocate amount across the balance inputs by each row's %.
// Does not save — the user reviews then clicks Save.
function bucketAllocate() {
    const amt = Number((document.getElementById('bucketAllocAmt') || {}).value) || 0;
    if (amt <= 0) return;
    document.querySelectorAll('.bucket-row').forEach(row => {
        const pct = Number(row.querySelector('.bpct').value) || 0;
        const balInput = row.querySelector('.bbal');
        const cur = Number(balInput.value) || 0;
        balInput.value = Math.round((cur + amt * pct / 100) * 100) / 100;
        balInput.style.borderColor = 'var(--accent)';
    });
}

async function saveBuckets() {
    const btn = document.getElementById('bucketSaveBtn');
    const errEl = document.getElementById('bucketSaveError');
    const rows = [...document.querySelectorAll('.bucket-row')];
    const records = rows.map(row => ({
        id: row.dataset.bucketId,
        fields: {
            [BUCKET.pct]: Number(row.querySelector('.bpct').value) || 0,
            [BUCKET.balance]: Number(row.querySelector('.bbal').value) || 0,
        },
    }));
    if (!records.length) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        for (let i = 0; i < records.length; i += 10) {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.incomeBuckets}`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ records: records.slice(i, i + 10) }),
            });
            if (!resp.ok) throw new Error('Airtable returned ' + resp.status);
        }
        _bucketsRecords = null;
        _bucketsPromise = null;
        await loadWealthBuckets();
    } catch (e) {
        if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Could not save buckets: ' + (e.message || 'error'); }
        if (btn) { btn.disabled = false; btn.textContent = 'Save buckets'; }
    }
}
