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

    const classRow = (cls, colour) => {
        const val = view.byClass[cls] || 0;
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
    const heroNote = livePortfolio
        ? `<span style="color:var(--text-muted);font-size:var(--fs-xs)">Real estate &amp; mortgages are live from your per-property valuations; other classes from the ${escHtml(asOf)} snapshot.</span>`
        : changeHtml;

    el.innerHTML = `
    <div style="max-width:960px;margin:0 auto">

        ${monthsBehind > 0 ? `<!-- Staleness alert -->
        <div style="background:var(--warning-bg);border:1px solid var(--warning);border-radius:var(--radius-lg);padding:var(--space-4);margin-bottom:var(--space-5);display:flex;gap:12px;align-items:flex-start">
            <span style="font-size:20px;line-height:1.2">⚠️</span>
            <div>
                <div style="font-weight:var(--fw-semibold);color:var(--text-primary);margin-bottom:2px">Your figures are ${monthsBehind} month${monthsBehind === 1 ? '' : 's'} out of date</div>
                <div style="font-size:var(--fs-sm);color:var(--text-secondary)">Latest snapshot is ${escHtml(asOf)}. To bring this up to ${escHtml(currentLabel)}, ${manualItemCount} manual figures need updating: property and business valuations, loan and mortgage balances, and investments. Cash and credit cards update live.</div>
                <button onclick="openWealthUpdate()" style="margin-top:10px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);padding:8px 16px;font-size:var(--fs-sm);font-weight:var(--fw-semibold);cursor:pointer">Update figures for ${escHtml(currentLabel)}</button>
            </div>
        </div>` : ''}

        <!-- 1–3 · Monthly cash flow: money in − money out = net (the headline) -->
        <div id="wealthCashflow" style="margin-bottom:var(--space-5)"></div>

        <!-- 4–5 · Income buckets — allocate the net cash flow (incl. Debt Clearance) -->
        <div id="wealthBuckets" style="margin-bottom:var(--space-5)"></div>

        <!-- 6 · Net worth — assets & liabilities (foundation, below the monthly flow) -->
        <!-- Hero: net worth -->
        <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:var(--space-6);margin-bottom:var(--space-5)">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
                <span style="color:var(--text-secondary);font-size:var(--fs-sm)">Net worth</span>
                <span style="margin-left:auto;color:var(--text-muted);font-size:var(--fs-xs)">As of ${escHtml(asOf)}</span>
            </div>
            <div style="font-size:var(--fs-3xl);font-weight:var(--fw-bold);color:var(--text-primary);line-height:1.1">${fmt(view.net)}</div>
            <div style="margin-top:8px">${heroNote}</div>
        </div>

        <!-- Assets + Liabilities -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-5);margin-bottom:var(--space-5)">
            <div class="kpi-card">
                <div class="kpi-card-label" style="margin-bottom:10px">Assets <span style="float:right;color:var(--success);font-weight:var(--fw-bold)">${fmt(view.assets)}</span></div>
                ${classRow('Cash', 'var(--tone-blue)')}
                ${classRow('Real Estate', 'var(--tone-sage)')}
                ${classRow('Investments', 'var(--tone-olive)')}
                ${classRow('Businesses', 'var(--tone-gold)')}
            </div>
            <div class="kpi-card">
                <div class="kpi-card-label" style="margin-bottom:10px">Liabilities <span style="float:right;color:var(--danger);font-weight:var(--fw-bold)">${fmt(view.liabilities)}</span></div>
                ${classRow('Credit Cards', 'var(--tone-gold)')}
                ${classRow('Loans', 'var(--tone-plum)')}
                ${classRow('Mortgages', 'var(--danger)')}
            </div>
        </div>

        <!-- Property portfolio — per property (value − mortgage = equity) -->
        <div id="wealthProperties" style="margin-bottom:var(--space-5)"></div>

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

        <!-- Update-method audit -->
        <div class="kpi-card" style="margin-bottom:var(--space-5)">
            <div class="kpi-card-label" style="margin-bottom:12px">How these figures update</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
                ${auditCol('Live · auto', 'var(--success)', REALTIME_CLASSES, 'Synced from your connected bank and card accounts. No monthly input needed.')}
                ${auditCol('Monthly · you update', 'var(--warning)', MANUAL_CLASSES, 'You refresh these once a month: valuations and loan balances. The update form will make this one quick pass.')}
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

        <!-- Personal expenditure (from transactions) -->
        <div id="wealthExpenditure" style="margin-top:var(--space-5)"></div>

        <!-- Loans & mortgages (auto-computed from terms) -->
        <div id="wealthDebts" style="margin-top:var(--space-5)"></div>

    </div>`;

    // Monthly cash flow + personal expenditure read the already-loaded transaction
    // globals (sync). The async sections fetch their own tables.
    renderWealthCashflow();
    renderPersonalExpenditure();
    loadWealthProperties();
    loadDebtTerms();
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
            key, reRevenue: m.reRevenue, personalIncome: m.personalIncome, totalIncome,
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

function renderWealthCashflow() {
    const el = document.getElementById('wealthCashflow');
    if (!el) return;
    const txns = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];
    if (!txns.length) { el.innerHTML = ''; return; }

    const months = buildMonthlyCashflow(wealthMonthKeys(3, 1)); // last 3 complete months
    if (!months.length) { el.innerHTML = ''; return; }
    const latest = months[months.length - 1];
    const avgNet = Math.round(months.reduce((s, m) => s + m.net, 0) / months.length);
    const netColour = latest.net >= 0 ? 'var(--success)' : 'var(--danger)';

    // A statement row. opts: indent, bold, colour, sign, border (top border for subtotals).
    const r = (label, val, o = {}) => `<div style="display:flex;justify-content:space-between;padding:4px 0;${o.border ? 'border-top:' + o.border + ';' : ''}">
        <span style="color:${o.labelColour || 'var(--text-secondary)'};${o.indent ? 'padding-left:14px;' : ''}font-weight:${o.bold ? 'var(--fw-bold)' : 'var(--fw-regular)'}">${escHtml(label)}</span>
        <span style="color:${o.colour || 'var(--text-primary)'};font-weight:${o.bold ? 'var(--fw-bold)' : 'var(--fw-semibold)'};white-space:nowrap">${o.sign || ''}${fmt(val)}</span>
    </div>`;
    const head = t => `<div style="font-size:var(--fs-xs);font-weight:var(--fw-semibold);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin:16px 0 2px">${escHtml(t)}</div>`;
    const ordered = (items, order) => order.filter(n => items[n]).map(n => ({ name: n, amt: items[n] }));
    const itemLines = (items, order) => {
        const rows = ordered(items, order);
        if (!rows.length) return `<div style="padding:4px 0 4px 14px;color:var(--text-muted);font-size:var(--fs-sm)">No transactions this month</div>`;
        return rows.map(it => r(wealthCfLabel(it.name), it.amt, { indent: true, sign: '− ', colour: 'var(--danger)' })).join('');
    };

    // Mini 3-month net trend.
    const maxAbs = Math.max(...months.map(m => Math.abs(m.net)), 1);
    const trend = months.map(m => {
        const pct = Math.round((Math.abs(m.net) / maxAbs) * 100);
        const c = m.net >= 0 ? 'var(--tone-sage)' : 'var(--danger)';
        return `<div style="flex:1;text-align:center">
            <div style="height:46px;display:flex;align-items:flex-end;justify-content:center">
                <div style="width:60%;height:${Math.max(pct, 3)}%;background:${c};border-radius:var(--radius-sm) var(--radius-sm) 0 0"></div>
            </div>
            <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:4px">${escHtml(wealthMonthLabel(m.key).split(' ')[0].slice(0, 3))}</div>
            <div style="font-size:var(--fs-xs);color:${m.net >= 0 ? 'var(--success)' : 'var(--danger)'}">${fmt0(m.net)}</div>
        </div>`;
    }).join('');

    el.innerHTML = `
    <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:var(--space-6)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
            <span style="color:var(--text-secondary);font-size:var(--fs-sm)">Net monthly cash flow</span>
            <span style="margin-left:auto;color:var(--text-muted);font-size:var(--fs-xs)">${escHtml(wealthMonthLabel(latest.key))}</span>
        </div>
        <div style="font-size:var(--fs-3xl);font-weight:var(--fw-bold);color:${netColour};line-height:1.1">${fmt(latest.net)}</div>
        <div style="margin-top:4px;color:var(--text-muted);font-size:var(--fs-xs)">3-month average ${fmt(avgNet)}/mo</div>

        ${head('Money in')}
        ${r('Real estate / portfolio revenue', latest.reRevenue, { colour: 'var(--success)', sign: '+ ' })}
        ${r('Personal income', latest.personalIncome, { colour: 'var(--success)', sign: '+ ' })}
        ${r('Total income', latest.totalIncome, { bold: true, border: '1px solid var(--border-default)', labelColour: 'var(--text-primary)' })}

        ${head('Less business expenditure')}
        ${itemLines(latest.bizItems, CASHFLOW_COST_SUBCATS)}
        ${r('Total business expenditure', latest.bizTotal, { bold: true, sign: '− ', colour: 'var(--danger)', border: '1px solid var(--border-default)', labelColour: 'var(--text-primary)' })}

        ${head('Less personal expenditure')}
        ${itemLines(latest.perItems, CASHFLOW_PERSONAL_EXPENSE_SUBCATS)}
        ${r('Total personal expenditure', latest.perTotal, { bold: true, sign: '− ', colour: 'var(--danger)', border: '1px solid var(--border-default)', labelColour: 'var(--text-primary)' })}

        <div style="display:flex;justify-content:space-between;padding:10px 0;border-top:2px solid var(--border-default);margin-top:4px">
            <span style="color:var(--text-primary);font-weight:var(--fw-bold);font-size:var(--fs-lg)">Net cash flow</span>
            <span style="color:${netColour};font-weight:var(--fw-bold);font-size:var(--fs-lg)">${fmt(latest.net)}</span>
        </div>

        <div style="display:flex;gap:6px;margin-top:8px;align-items:flex-end">${trend}</div>

        <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-top:14px;line-height:1.5">
            Real estate / portfolio revenue = Fixed, Variable and Rental Income. Personal income = your booked personal income (internal drawings excluded so rent isn't double-counted). Business and personal expenditure are itemised by sub-category. Net cash flow = total income − all expenditure, which then feeds your buckets below. Business expenditure here is operating costs (matching the P&L); capital loan/mortgage repayments are not yet included — flag if you want them.
        </div>
    </div>`;
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
    renderBuckets(el);
}

function renderBuckets(el) {
    const recs = (_bucketsRecords || []).slice().sort((a, b) =>
        (Number(getField(a, BUCKET.sort)) || 0) - (Number(getField(b, BUCKET.sort)) || 0));
    const totalBal = recs.reduce((s, r) => s + (Number(getField(r, BUCKET.balance)) || 0), 0);
    const totalPct = recs.reduce((s, r) => s + (Number(getField(r, BUCKET.pct)) || 0), 0);

    // Prefill the allocate amount with the Money Confidence surplus when available.
    let surplus = 0;
    try {
        if (typeof computeSafeToAct === 'function' && typeof allAccounts !== 'undefined' && allAccounts && allAccounts.length) {
            surplus = computeSafeToAct().safeToActToday || 0;
        }
    } catch (e) { /* surplus stays 0 */ }

    const rows = recs.map(r => {
        const name = getField(r, BUCKET.name) || '(unnamed)';
        const pct = Number(getField(r, BUCKET.pct)) || 0;
        const bal = Number(getField(r, BUCKET.balance)) || 0;
        return `<div class="bucket-row" data-bucket-id="${escHtml(r.id)}" style="display:flex;align-items:center;gap:10px;padding:6px 0">
            <span style="flex:1;font-size:var(--fs-sm);color:var(--text-primary)">${escHtml(name)}</span>
            <input type="number" step="1" min="0" class="bpct" value="${pct}" title="Allocation %"
                style="width:64px;padding:6px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);text-align:right;background:var(--bg-surface)"><span style="color:var(--text-muted);font-size:var(--fs-sm)">%</span>
            <span style="color:var(--text-muted)">£</span>
            <input type="number" step="0.01" class="bbal" value="${bal}" title="Current balance"
                style="width:130px;padding:6px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);text-align:right;background:var(--bg-surface)">
        </div>`;
    }).join('');

    const pctWarn = totalPct !== 100
        ? `<span style="color:var(--warning);font-size:var(--fs-xs);margin-left:8px">allocations total ${totalPct}% (aim for 100%)</span>` : '';

    el.innerHTML = `<div class="kpi-card">
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px">
            <span class="kpi-card-label">Income buckets</span>
            <span style="margin-left:auto;color:var(--text-secondary);font-size:var(--fs-sm)">Total saved: <strong style="color:var(--text-primary)">${fmt(totalBal)}</strong></span>
        </div>
        <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-bottom:12px;line-height:1.5">Split your surplus into pots by percentage. Allocate distributes an amount across the balances; edit any balance directly to record spending, then Save. ${pctWarn}</div>
        <div id="bucketRows">${rows}</div>
        <div id="bucketSaveError" style="display:none;color:var(--danger);font-size:var(--fs-sm);margin-top:8px"></div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap;border-top:1px solid var(--border-subtle);padding-top:14px">
            <span style="color:var(--text-secondary);font-size:var(--fs-sm)">Allocate £</span>
            <input type="number" step="0.01" id="bucketAllocAmt" value="${surplus > 0 ? surplus.toFixed(2) : ''}" placeholder="amount"
                style="width:140px;padding:6px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);text-align:right;background:var(--bg-surface)">
            <button onclick="bucketAllocate()" style="background:var(--bg-subtle);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:8px 14px;font-size:var(--fs-sm);cursor:pointer;color:var(--text-primary)">Distribute by %</button>
            ${surplus > 0 ? `<span style="color:var(--text-muted);font-size:var(--fs-xs)">pre-filled from your "safe to act today"</span>` : ''}
            <button id="bucketSaveBtn" onclick="saveBuckets()" style="margin-left:auto;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);padding:8px 18px;font-weight:var(--fw-semibold);cursor:pointer">Save buckets</button>
        </div>
    </div>`;
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
