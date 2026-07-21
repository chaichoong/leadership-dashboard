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

// Live cash / credit-card items straight from the Accounts table, by the "Net Worth
// Class" tick (Cash | Credit Card). Balance is live (magnitude — cards store "owed"
// as a positive). This is the single source for what counts, replacing the old
// hard-coded name lists. Tick/untick an account and it appears/disappears here.
function netWorthAccounts(cls) {
    const accts = (typeof allAccounts !== 'undefined' && allAccounts) ? allAccounts : [];
    return accts
        .filter(a => getField(a, F.accNetWorthClass) === cls)
        .map(a => ({ name: getField(a, F.accountAlias) || '(account)', amount: Math.abs(Number(getField(a, F.accGBP)) || 0), id: a.id }))
        .sort((x, y) => y.amount - x.amount);
}

// Manage which accounts count in net worth, and as what. One row per account with a
// Cash / Credit card / Not counted selector; the choice writes straight to the
// Accounts table (Net Worth Class), so cash and cards update the moment you change it.
function openAccountManager() {
    const el = document.getElementById('tab-wealth');
    if (!el) return;
    const accts = ((typeof allAccounts !== 'undefined' && allAccounts) ? allAccounts : [])
        .filter(a => getField(a, F.accountAlias))
        .slice().sort((a, b) => Math.abs(Number(getField(b, F.accGBP)) || 0) - Math.abs(Number(getField(a, F.accGBP)) || 0));
    const rowHtml = a => {
        const name = getField(a, F.accountAlias) || '(account)';
        const bal = Math.abs(Number(getField(a, F.accGBP)) || 0);
        const cur = getField(a, F.accNetWorthClass) || '';
        const opt = v => `<option value="${v}"${cur === v ? ' selected' : ''}>${v || 'Not counted'}</option>`;
        return `<div style="display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--border-subtle);font-size:var(--fs-sm)">
            <span style="color:var(--text-primary);min-width:0">${escHtml(name)}</span>
            <span style="text-align:right;color:var(--text-secondary);white-space:nowrap">${escHtml(fmt0(bal))}</span>
            <select onchange="setAccountClass('${a.id}', this.value)" style="padding:5px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface)">${opt('')}${opt('Cash')}${opt('Credit Card')}</select>
        </div>`;
    };
    el.innerHTML = `<div style="max-width:720px;margin:0 auto">
        <div style="margin-bottom:8px"><button onclick="renderWealthTab()" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:var(--fs-sm);padding:0">&larr; Back to net worth</button></div>
        <div class="kpi-card">
            <div class="kpi-card-label" style="margin-bottom:4px">Which accounts count in net worth</div>
            <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-bottom:10px;line-height:1.5">Set each account to Cash, Credit Card, or Not counted. Balances stay live from the account, so you never type a figure. Changes save instantly. Sorted by balance.</div>
            <div style="max-height:60vh;overflow-y:auto">${accts.map(rowHtml).join('')}</div>
        </div>
    </div>`;
}

async function setAccountClass(id, cls) {
    const acc = ((typeof allAccounts !== 'undefined' && allAccounts) ? allAccounts : []).find(a => a.id === id);
    try {
        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.accounts}`, {
            method: 'PATCH', headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: [{ id, fields: { [F.accNetWorthClass]: cls || null } }], typecast: true }),
        });
        if (!resp.ok) throw new Error('Airtable ' + resp.status);
        if (acc) { acc.fields = acc.fields || {}; acc.fields[F.accNetWorthClass] = cls || null; } // keep the local cache in step
        if (typeof showToast === 'function') showToast(cls ? `Counted as ${cls}` : 'Not counted', { type: 'success' });
    } catch (e) {
        if (typeof showToast === 'function') showToast('Could not save — try again', { type: 'error' });
    }
}

// Add a new loan to Debts in detail. "+ Add loan" reveals an inline name field (not a
// native prompt, which would trigger the browser's saved-login autofill). Submitting
// creates a Debt Terms row; set its balance and rate in the row's editor afterwards.
function wealthAddLoan() {
    const box = document.getElementById('wealthAddLoanForm');
    if (!box) return;
    const show = box.style.display === 'none' || !box.style.display;
    box.style.display = show ? 'flex' : 'none';
    if (show) { const inp = document.getElementById('wealthNewLoanName'); if (inp) { inp.value = ''; inp.focus(); } }
}

async function wealthSubmitLoan() {
    const inp = document.getElementById('wealthNewLoanName');
    const name = inp ? inp.value.trim() : '';
    if (!name) { if (inp) inp.focus(); return; }
    const btn = document.getElementById('wealthAddLoanBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.debtTerms}`, {
            method: 'POST', headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: [{ fields: { [DEBT.name]: name, [DEBT.cls]: 'Loans', [DEBT.type]: 'Repayment' } }], typecast: true }),
        });
        if (!resp.ok) throw new Error('Airtable ' + resp.status);
        if (typeof showToast === 'function') showToast('Loan added — set its balance and rate', { type: 'success' });
        _debtPromise = null; _debtRecords = null;
        try { _debtRecords = await airtableFetch(TABLES.debtTerms); } catch (e) { /* render handles empty */ }
        const el = document.getElementById('tab-wealth');
        if (el && _wealthRecords) renderWealthContent(el, _wealthRecords);
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
        if (typeof showToast === 'function') showToast('Could not add the loan — try again', { type: 'error' });
    }
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
            body: JSON.stringify({ model: AI_MODEL_DEFAULT, max_tokens: 80, system: '', messages }),
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
function wealthRowHtml(cls, name, amount, live, isNew, readonly, sourceNote) {
    // Read-only row: for classes managed by their single source (cash/cards live,
    // real estate = Property Valuations, mortgages = Debt Terms). Shows the value but
    // can't be typed over here, so Wealth and Operations can never disagree. The value
    // still travels into the saved snapshot via data-amount.
    if (readonly) {
        return `<div class="wealth-row" data-wealth-type="${escHtml(cls)}" data-name="${escHtml(name)}" data-amount="${amount == null ? '' : amount}" data-readonly="1" style="display:flex;align-items:center;gap:8px;padding:5px 0">
            <label style="flex:1;font-size:var(--fs-sm);color:var(--text-secondary)">${escHtml(name)}${sourceNote ? ` <span style="color:var(--text-muted);font-size:var(--fs-xs)">· ${escHtml(sourceNote)}</span>` : ''}</label>
            <span style="color:var(--text-muted)">£</span>
            <span style="width:130px;text-align:right;font-size:var(--fs-sm);color:var(--text-primary)">${amount == null ? '–' : fmt0(amount)}</span>
        </div>`;
    }
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
    // Prefill the editable classes from THIS month's snapshot (not just the newest one),
    // so editing an existing month shows that month's investment/business figures.
    const curPeriod = periods.find(p => p.month === curMonth && String(p.year) === curYear) || latest;

    // Classes managed by their single source are read-only here, so a figure can only
    // ever be changed in one place and Wealth + Operations can never disagree. Only the
    // genuinely manual classes (loans, businesses, investments) stay editable.
    const READONLY_CLASSES = {
        'Cash': 'live from accounts',
        'Credit Cards': 'live from accounts',
        'Real Estate': 'managed in Operations → Properties',
        'Mortgages': 'calculated from loan terms',
        'Loans': 'managed in Debts in detail',
    };
    // Live per-property figures so read-only real estate + mortgages match the matrix
    // and the Operations Properties tab exactly (same Property Valuations source).
    let livePf = null;
    if (_valRecords && _debtRecords) { try { const pf = buildPortfolio(_valRecords, _debtRecords); if (pf.rows.length) livePf = pf; } catch (e) { /* fall back to snapshot items */ } }
    const itemsFor = cls => {
        if (cls === 'Real Estate' && livePf) return livePf.rows.map(p => ({ name: p.name, amount: p.value }));
        if (cls === 'Mortgages' && livePf) return livePf.rows.filter(p => p.mort > 0).map(p => ({ name: p.name, amount: p.mort }));
        return (curPeriod.items[cls] || []).map(it => ({ name: it.name, amount: it.amount }));
    };

    let rowsHtml = '';
    WEALTH_CLASS_ORDER.forEach(cls => {
        const ro = READONLY_CLASSES[cls];
        const itemRows = itemsFor(cls).map(it => {
            if (ro) {
                const live = WEALTH_LIVE_CLASSES.includes(cls) ? wealthLiveValue(it.name) : null;
                return wealthRowHtml(cls, it.name, (live != null) ? live : it.amount, null, false, true, ro);
            }
            return wealthRowHtml(cls, it.name, it.amount, null, false);
        }).join('');
        rowsHtml += `<div style="margin-top:18px;margin-bottom:4px;font-size:var(--fs-xs);font-weight:var(--fw-semibold);text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted)">${escHtml(cls)}${ro ? ` <span style="text-transform:none;letter-spacing:0;font-weight:var(--fw-regular)">· automatic</span>` : ''}</div>
            <div class="wealth-section" data-section="${escHtml(cls)}">${itemRows}</div>
            ${ro ? '' : `<button onclick="addWealthRow('${cls.replace(/'/g, "\\'")}')" style="background:none;border:1px dashed var(--border-default);border-radius:var(--radius-md);padding:5px 12px;margin-top:6px;font-size:var(--fs-xs);color:var(--accent);cursor:pointer">+ Add ${escHtml(cls)}</button>`}`;
    });

    el.innerHTML = `<div style="max-width:720px;margin:0 auto">
        <div style="margin-bottom:8px"><button onclick="renderWealthTab()" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:var(--fs-sm);padding:0">&larr; Back to net worth</button></div>
        <div class="kpi-card">
            <div class="kpi-card-label" style="margin-bottom:4px">Update investments &amp; businesses &middot; ${escHtml(curMonth)} ${escHtml(curYear)}</div>
            <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-bottom:10px;line-height:1.5">Update your investments and businesses here each month — drag a statement or screenshot onto a row to read the figure, type it in, use "+ Add" for something new, or &times; to drop what you have cleared. Anything you do not change rolls forward. Everything else is automatic or managed elsewhere and shown read only: cash and cards are live from accounts, real estate from Operations, Properties, mortgages from loan terms, and loans in Debts in detail.</div>
            ${alreadySaved ? `<div style="background:var(--info-bg,var(--accent-soft));border:1px solid var(--info,var(--accent));border-radius:var(--radius-sm);padding:8px 12px;margin-bottom:10px;font-size:var(--fs-sm);color:var(--text-primary)">You are editing ${escHtml(curMonth)} ${escHtml(curYear)}. Change your investments and businesses below, then Save. Automatic figures (cash, cards, property, mortgages, loans) stay as recorded for that month.</div>` : ''}
            <div id="wealthUpdateError" style="display:none;color:var(--danger);font-size:var(--fs-sm);margin:8px 0"></div>
            ${rowsHtml}
            <div style="display:flex;gap:10px;margin-top:22px">
                <button id="wealthSaveBtn" style="cursor:pointer;background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-md);padding:10px 20px;font-weight:var(--fw-semibold)" onclick="saveWealthUpdate('${curMonth}','${curYear}')">${alreadySaved ? 'Update' : 'Save'} ${escHtml(curMonth)} ${escHtml(curYear)}</button>
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

    const existing = computeNetWorth(_wealthRecords || []).some(p => p.month === curMonth && String(p.year) === curYear);
    // EDIT MODE — the month already has a snapshot. Reconcile only the editable classes
    // (investments, businesses) against its existing records; automatic classes stay as
    // recorded. This never duplicates the month.
    if (existing) { return saveWealthMonthEdit(curMonth, curYear, btn, showErr); }

    const rows = [...document.querySelectorAll('.wealth-row')];
    const records = [];
    rows.forEach(row => {
        const nameInput = row.querySelector('.wn');
        const name = (row.dataset.name != null ? row.dataset.name : (nameInput ? nameInput.value : '')).trim();
        if (!name) return; // skip blank added rows
        const amtInput = row.querySelector('.wa'); // read-only rows have no input — value is in data-amount
        records.push({ fields: {
            [NW.name]: name,
            [NW.amount]: (amtInput ? Number(amtInput.value) : Number(row.dataset.amount)) || 0,
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

// Edit an existing month: reconcile the editable classes (investments, businesses)
// against that month's saved records — PATCH changed amounts, POST new items, DELETE
// removed ones. Automatic classes (cash, cards, real estate, mortgages, loans) are
// untouched, so net worth for the month stays consistent and no month is duplicated.
async function saveWealthMonthEdit(curMonth, curYear, btn, showErr) {
    const EDITABLE = ['Investments', 'Businesses'];
    const formItems = [];
    [...document.querySelectorAll('.wealth-row')].forEach(row => {
        const type = row.dataset.wealthType;
        if (!EDITABLE.includes(type) || row.dataset.readonly) return;
        const nameInput = row.querySelector('.wn');
        const name = (row.dataset.name != null ? row.dataset.name : (nameInput ? nameInput.value : '')).trim();
        if (!name) return;
        const amtInput = row.querySelector('.wa');
        formItems.push({ type, name, amount: (amtInput ? Number(amtInput.value) : 0) || 0 });
    });
    const raw = (_wealthRecords || []).filter(r =>
        getField(r, NW.month) === curMonth && String(getField(r, NW.year)) === curYear && EDITABLE.includes(getField(r, NW.type)));
    const keyOf = (t, n) => t + '|' + n;
    const byKey = {}; raw.forEach(r => { byKey[keyOf(getField(r, NW.type), getField(r, NW.name))] = r; });
    const toCreate = [], toUpdate = [], toDelete = [], seen = new Set();
    formItems.forEach(it => {
        const k = keyOf(it.type, it.name); seen.add(k);
        const ex = byKey[k];
        if (ex) { if (Number(getField(ex, NW.amount)) !== it.amount) toUpdate.push({ id: ex.id, fields: { [NW.amount]: it.amount } }); }
        else toCreate.push({ fields: { [NW.name]: it.name, [NW.amount]: it.amount, [NW.type]: it.type, [NW.month]: curMonth, [NW.year]: curYear } });
    });
    raw.forEach(r => { if (!seen.has(keyOf(getField(r, NW.type), getField(r, NW.name)))) toDelete.push(r.id); });

    if (!toCreate.length && !toUpdate.length && !toDelete.length) { showErr('No changes to save.'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLES.netWorthByMonth}`;
    const hdr = { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' };
    try {
        for (let i = 0; i < toUpdate.length; i += 10) {
            const resp = await fetch(url, { method: 'PATCH', headers: hdr, body: JSON.stringify({ records: toUpdate.slice(i, i + 10), typecast: true }) });
            if (!resp.ok) throw new Error('Airtable returned ' + resp.status);
        }
        for (let i = 0; i < toCreate.length; i += 10) {
            const resp = await fetch(url, { method: 'POST', headers: hdr, body: JSON.stringify({ records: toCreate.slice(i, i + 10), typecast: true }) });
            if (!resp.ok) throw new Error('Airtable returned ' + resp.status);
        }
        for (let i = 0; i < toDelete.length; i += 10) {
            const q = toDelete.slice(i, i + 10).map(id => `records[]=${encodeURIComponent(id)}`).join('&');
            const resp = await fetch(`${url}?${q}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${PAT}` } });
            if (!resp.ok) throw new Error('Airtable returned ' + resp.status);
        }
        _wealthRecords = null; _wealthPromise = null;
        await renderWealthTab();
        if (typeof showToast === 'function') showToast(`${curMonth} ${curYear} investments & businesses updated`, { type: 'success' });
    } catch (e) {
        showErr('Could not save: ' + (e.message || 'error'));
    }
}

// ── Auto roll-forward (monthly snapshot) ─────────────────────────────────────
// Kevin's rule: it happens automatically without him, but he can override any
// figure and that value is carried forward. When the Wealth tab loads on/after
// the 1st, this stamps the PREVIOUS completed month's snapshot if it's missing —
// using the same live figures the matrix shows (cash + cards live, mortgages
// amortised incl. 17 Newington, real estate at latest approved valuation, and
// loans/businesses/investments carried from the last snapshot). It only ever
// CREATES a missing month; it never overwrites, so manual edits are safe and
// carry forward naturally (carried classes copy the previous month).
let _wealthAutoStamping = false;
async function maybeAutoStampPrevMonth(periods, gatherItems) {
    if (_wealthAutoStamping) return;                     // one attempt per load cycle
    if (typeof PAT === 'undefined' || !PAT) return;      // not authed yet
    if (!periods || !periods.length) return;             // need a prior snapshot to carry from
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); // previous completed month
    const tMonth = WEALTH_MONTHS[d.getMonth()];
    const tYear = String(d.getFullYear());
    if (periods.some(p => p.month === tMonth && String(p.year) === tYear)) return; // already stamped
    const items = gatherItems();
    if (!items.length) return;
    _wealthAutoStamping = true;
    const records = items.map(it => ({ fields: {
        [NW.name]: it.name,
        [NW.amount]: Number(it.amount) || 0,
        [NW.type]: it.type,
        [NW.month]: tMonth,
        [NW.year]: tYear,
    } }));
    try {
        for (let i = 0; i < records.length; i += 10) {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.netWorthByMonth}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ records: records.slice(i, i + 10), typecast: true }),
            });
            if (!resp.ok) throw new Error('Airtable returned ' + resp.status);
            if (i + 10 < records.length) await new Promise(r => setTimeout(r, 300)); // stay under the rate limit
        }
        if (typeof showToast === 'function') showToast(`${tMonth} ${tYear} net worth snapshot saved automatically — edit any figure to override it`, { type: 'success', duration: 6000 });
        _wealthRecords = null; _wealthPromise = null;
        await renderWealthTab();
    } catch (e) {
        if (typeof showToast === 'function') showToast(`Could not auto-save ${tMonth}'s snapshot — you can still update it manually`, { type: 'warning' });
    } finally {
        _wealthAutoStamping = false;
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
            badge.style.cssText = 'margin-left:6px;min-width:18px;height:18px;border-radius:9px;font-size:10px;font-weight:700;color:var(--accent-on);background:var(--warning);text-align:center;line-height:18px;padding:0 5px';
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
    // Sync the Loans class with the editable Debt Terms balances used in "Debts in detail"
    // (your typed figure wins, else the snapshot), so net worth and the debt table agree.
    const syncedLoanItems = debtRows().filter(r => r.cls === 'Loans').map(r => ({ name: r.name, amount: r.balance }));
    if (syncedLoanItems.length) {
        view.byClass['Loans'] = syncedLoanItems.reduce((s, i) => s + (i.amount || 0), 0);
    }
    // Cash + credit cards: live from the Accounts you've ticked (Net Worth Class).
    // Falls back to the snapshot only if nothing is ticked yet (so it never blanks out).
    const cashItems = netWorthAccounts('Cash');
    const cardItems = netWorthAccounts('Credit Card');
    if (cashItems.length) view.byClass['Cash'] = cashItems.reduce((s, i) => s + i.amount, 0);
    if (cardItems.length) view.byClass['Credit Cards'] = cardItems.reduce((s, i) => s + i.amount, 0);
    // Recompute the roll-ups after the loan/cash/card overrides.
    view.assets = NW_ASSET_CLASSES.reduce((s, c) => s + (view.byClass[c] || 0), 0);
    view.liabilities = NW_LIABILITY_CLASSES.reduce((s, c) => s + (view.byClass[c] || 0), 0);
    view.net = view.assets - view.liabilities;
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
    // "Behind" is measured against the last COMPLETED month, not the in-progress one.
    // The auto roll-forward keeps the previous month stamped, so in normal operation
    // this is 0 and no "update figures" nag shows — the current month stays live and
    // is frozen automatically on the 1st. It only goes positive if a completed month
    // genuinely has no snapshot (e.g. the app was not opened for a while).
    const monthsBehind = Math.max(0, (now.getFullYear() * 12 + now.getMonth() - 1) - (latest.year * 12 + latest.monthIdx));
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
    // The current (in-progress) month always shows the live reconciled figure, even if
    // an early snapshot for it exists — so it matches the top KPI strip and the live
    // item rows. Completed months show their frozen snapshot.
    const classVals = cls => alKeys.map((k, i) => {
        if (i === alLast) { const v = view.byClass[cls]; return v == null ? null : v; }
        const p = periodByKey[k];
        if (p) { const v = p.byClass[cls]; return v == null ? null : v; }
        return null;
    });
    const itemRows = (items, goodUp) => (items && items.length)
        ? items.slice().sort((a, b) => b.amount - a.amount).map(it => ({ label: it.name, goodUp, values: alKeys.map((k, i) => i === alLast ? it.amount : null) }))
        : undefined;
    const alRow = (label, cls, items, goodUp) => ({ label, goodUp, values: classVals(cls), items: itemRows(items, goodUp) });
    const totalVals = pick => alKeys.map((k, i) => { if (i === alLast) return pick(view); const p = periodByKey[k]; return p ? pick(p) : null; });
    const alSections = [
        { header: 'Assets', rows: [
            alRow('Cash', 'Cash', cashItems.length ? cashItems : snapItems('Cash'), true),
            alRow('Real Estate', 'Real Estate', reItems, true),
            alRow('Investments', 'Investments', snapItems('Investments'), true),
            alRow('Businesses', 'Businesses', snapItems('Businesses'), true),
            { label: 'Total assets', goodUp: true, bold: true, border: '1px solid var(--border-default)', values: totalVals(p => p.assets) },
        ] },
        { header: 'Liabilities', rows: [
            alRow('Credit Cards', 'Credit Cards', cardItems.length ? cardItems : snapItems('Credit Cards'), false),
            alRow('Loans', 'Loans', syncedLoanItems.length ? syncedLoanItems : snapItems('Loans'), false),
            alRow('Mortgages', 'Mortgages', mortItems, false),
            { label: 'Total liabilities', goodUp: false, bold: true, border: '1px solid var(--border-default)', values: totalVals(p => p.liabilities) },
        ] },
        { header: '', rows: [
            { label: 'Net worth', goodUp: true, bold: true, border: '2px solid var(--border-default)', values: totalVals(p => p.net) },
        ] },
    ];
    const assetsHtml = wealthMatrixCard(
        'Assets, liabilities & net worth — rolling 12 months',
        'Class totals over 12 months. The current month (●) shows today\'s live figures (matching the strip at the top); completed months show their saved month-end snapshot. Click a class to expand its breakdown. Arrows = change vs the previous month; the Δ column and highlight follow the last completed month, like the other tables.',
        alMonths, alSections, { anchor: 'completed' });

    // ── KPI summary strip (headline figures + 1/3/6/9/12-month changes) ──
    // 13-month series (current + 12 prior) so every period change is computable.
    const kpiKeys = wealthMonthKeys(13, 0); // current month + 12 prior
    const kpiRef = wealthCompletedIdx(kpiKeys); // last completed month (flow anchor)
    const kpiLast = kpiKeys.length - 1; // current month (stock/balance anchor)
    const kpiSnap = pick => kpiKeys.map((k, i) => { if (i === kpiLast) return pick(view); const p = periodByKey[k]; return p ? pick(p) : null; });
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
    const periodBtn = n => `<button onclick="setWealthChangePeriod(${n})" style="padding:5px 12px;border:1px solid var(--border-default);border-radius:var(--radius-md);cursor:pointer;font-size:var(--fs-sm);background:${_wealthChangeMonths === n ? 'var(--accent)' : 'var(--bg-surface)'};color:${_wealthChangeMonths === n ? 'var(--accent-on)' : 'var(--text-secondary)'};font-weight:${_wealthChangeMonths === n ? 'var(--fw-semibold)' : 'var(--fw-regular)'}">${n}M</button>`;
    const changeSelector = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:var(--space-5);flex-wrap:wrap">
        <span style="color:var(--text-secondary);font-size:var(--fs-sm)">Trend column (Δ):</span>
        ${[1, 3, 6, 9, 12].map(periodBtn).join('')}
    </div>`;

    el.innerHTML = `
    <div style="width:100%">

        <!-- Refresh + sync status + health checks (same bar every other tab has) -->
        <div data-sync-bar="wealth"></div>

        ${kpiStrip}

        <!-- Property valuations to review (from the monthly AI job) — approve here, syncs to Operations -->
        <div id="wealthPendingVals" style="margin-bottom:var(--space-5)"></div>

        ${changeSelector}

        ${monthsBehind > 0 ? `<!-- Staleness alert -->
        <div style="background:var(--warning-bg);border:1px solid var(--warning);border-radius:var(--radius-lg);padding:var(--space-4);margin-bottom:var(--space-5);display:flex;gap:12px;align-items:flex-start">
            <span style="font-size:20px;line-height:1.2">⚠️</span>
            <div>
                <div style="font-weight:var(--fw-semibold);color:var(--text-primary);margin-bottom:2px">Your figures are ${monthsBehind} month${monthsBehind === 1 ? '' : 's'} out of date</div>
                <div style="font-size:var(--fs-sm);color:var(--text-secondary)">Latest snapshot is ${escHtml(asOf)}. To bring this up to ${escHtml(currentLabel)}, ${manualItemCount} manual figures need updating: property and business valuations, loan and mortgage balances, and investments. Cash and credit cards update live.</div>
                <button onclick="openWealthUpdate()" style="margin-top:10px;background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-md);padding:8px 16px;font-size:var(--fs-sm);font-weight:var(--fw-semibold);cursor:pointer">Update figures for ${escHtml(currentLabel)}</button>
            </div>
        </div>` : ''}

        <!-- Monthly cash flow (rolling 12 months) -->
        <div id="wealthCashflow" style="margin-bottom:var(--space-5)"></div>

        <!-- Income buckets — manage (add/remove/%) then the 12-month grid -->
        <div id="wealthBucketEditor" style="margin-bottom:var(--space-3)"></div>
        <div id="wealthBuckets" style="margin-bottom:var(--space-5)"></div>

        <!-- Assets, liabilities & net worth (rolling 12 months) -->
        ${assetsHtml}

        <div style="margin:-8px 0 var(--space-5);display:flex;gap:8px;flex-wrap:wrap">
            <button onclick="openWealthUpdate()" style="background:none;border:1px solid var(--border-default);border-radius:var(--radius-md);padding:7px 14px;font-size:var(--fs-sm);color:var(--text-secondary);cursor:pointer">&#9998; Update investments &amp; businesses</button>
            <button onclick="openAccountManager()" style="background:none;border:1px solid var(--border-default);border-radius:var(--radius-md);padding:7px 14px;font-size:var(--fs-sm);color:var(--text-secondary);cursor:pointer">&#9881; Which accounts count</button>
        </div>

        <!-- Debts in detail — per-debt rate, balance, monthly cost + AI pay-down guidance -->
        <div id="wealthDebts" style="margin-bottom:var(--space-5)"></div>

        <!-- Analysis — Rich Dad ratios (read-only; rendered by wealth-ratios.js) -->
        <div id="wealthRatios" style="margin-bottom:var(--space-5)"></div>

    </div>`;

    // Cash flow reads the already-loaded transactions (sync). Buckets fetch their table.
    renderWealthCashflow();
    // Buckets fetch async; the two bucket health checks run before that resolves and
    // would read as amber ("no buckets") until a manual Re-run. Re-run the passive
    // checks once buckets have loaded so the pill settles on its true state on its own.
    loadWealthBuckets().then(() => { if (typeof markTabSynced === 'function') markTabSynced('wealth'); });
    renderWealthPendingVals();
    renderDebtsDetail();
    // Analysis ratios — read-only interpretation of the figures above (own file).
    if (typeof renderWealthRatios === 'function') renderWealthRatios(view);

    // Refresh + sync status + health checks — the standard bar every other tab has.
    registerWealthSyncBar(view, monthsBehind, asOf, currentLabel);

    // Auto roll-forward: stamp the previous completed month's snapshot if missing,
    // using the exact figures shown above. Only runs once accounts are loaded so
    // cash/cards are live (otherwise they'd carry the last snapshot). Never
    // overwrites an existing month, so manual overrides are preserved and carried.
    if (accountsLoaded) {
        maybeAutoStampPrevMonth(periods, () => {
            const out = [];
            const add = (cls, arr) => (arr || []).forEach(it => {
                if (it && it.name && it.name !== '(unnamed)') out.push({ name: it.name, amount: Number(it.amount) || 0, type: cls });
            });
            // Cash + cards: live per named account, falling back to last snapshot if not mapped.
            const liveClassItems = cls => (latest.items[cls] || []).map(it => { const lv = wealthLiveValue(it.name); return { name: it.name, amount: (lv != null ? lv : it.amount) }; });
            add('Cash', cashItems.length ? cashItems : liveClassItems('Cash'));
            add('Credit Cards', cardItems.length ? cardItems : liveClassItems('Credit Cards'));
            add('Real Estate', reItems);                 // latest approved valuations
            add('Mortgages', mortItems);                 // amortised (incl. 17 Newington)
            add('Investments', snapItems('Investments')); // carried forward
            add('Businesses', snapItems('Businesses'));   // carried forward
            add('Loans', syncedLoanItems.length ? syncedLoanItems : snapItems('Loans')); // synced editable balances
            return out;
        });
    }
}

// Wire the shared sync bar for the Wealth tab: a Refresh button (reloads the
// underlying data and re-renders), a freshness stamp, and health checks that
// confirm the data behind net worth, cash flow and buckets actually loaded and
// is current. Snapshot figures (view, monthsBehind) are captured at render time;
// the bar re-registers on every render, and Refresh re-runs the whole load.
function registerWealthSyncBar(view, monthsBehind, asOf, currentLabel) {
    if (typeof registerSyncBar !== 'function') return;
    const num = a => (a && a.length) || 0;
    registerSyncBar('wealth', {
        // Plain-English explainer, opened from the "Page guide" button in the sync bar.
        guideUrl: 'guide-wealth.html?v=1',
        refreshFn: async () => {
            // Refresh the shared dashboard data (transactions, accounts) then the
            // Wealth-specific tables, then re-render from scratch.
            if (typeof loadDashboard === 'function') { try { await loadDashboard(); } catch (_) {} }
            _wealthRecords = null; _wealthPromise = null;
            _valRecords = null; _valPromise = null;
            _debtRecords = null; _debtPromise = null;
            _bucketsRecords = null; _bucketsPromise = null;
            await renderWealthTab();
        },
        checks: [
            { name: 'Net worth snapshots loaded', kind: 'sync', run: () => {
                const n = num(_wealthRecords);
                if (n === 0) return { status: 'fail', detail: 'No net worth snapshot records loaded' };
                return { status: 'pass', detail: `${n} snapshot rows loaded (latest ${asOf})` };
            }},
            { name: 'Figures up to date', kind: 'sync', run: () => {
                if (monthsBehind <= 0) return { status: 'pass', detail: `Current to ${currentLabel}` };
                return { status: 'warn', detail: `${monthsBehind} month${monthsBehind === 1 ? '' : 's'} out of date — click "Update figures for ${currentLabel}"` };
            }},
            { name: 'Transactions loaded (cash flow + buckets)', kind: 'sync', run: () => {
                const n = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions.length : 0;
                if (n === 0) return { status: 'warn', detail: 'No transactions cached — open the Leadership Dashboard once so cash flow and buckets can populate' };
                return { status: 'pass', detail: `${n} transactions available` };
            }},
            { name: 'Property valuations loaded', kind: 'sync', run: () => {
                const n = num(_valRecords);
                if (n === 0) return { status: 'warn', detail: 'No per-property valuations — real estate falls back to the monthly snapshot' };
                return { status: 'pass', detail: `${n} property valuation records loaded` };
            }},
            { name: 'Income buckets loaded', kind: 'sync', run: () => {
                const n = num(_bucketsRecords);
                if (n === 0) return { status: 'warn', detail: 'No income buckets configured yet' };
                return { status: 'pass', detail: `${n} buckets loaded` };
            }},
            { name: 'Bucket allocations total 100%', kind: 'sync', run: () => {
                const recs = _bucketsRecords || [];
                if (!recs.length) return { status: 'warn', detail: 'No buckets to total' };
                const total = recs.reduce((s, r) => s + (Number(getField(r, BUCKET.pct)) || 0), 0);
                if (total === 100) return { status: 'pass', detail: 'Allocations total 100%' };
                return { status: 'warn', detail: `Allocations total ${total}% (aim for 100%)` };
            }},
            { name: 'Net worth reconciles', kind: 'sync', run: () => {
                // Recompute assets and liabilities straight from the raw snapshot
                // rows (independently of computeNetWorth) and compare against the
                // rendered view totals. Catches a drift anywhere in the pipeline
                // rather than comparing the view to itself.
                const recs = _wealthRecords || [];
                if (!recs.length) return { status: 'warn', detail: 'No snapshot rows to reconcile against' };
                const rows = [];
                let latestKey = -1;
                recs.forEach(r => {
                    const type = getField(r, NW.type);
                    const mi = WEALTH_MONTH_INDEX[getField(r, NW.month)];
                    const yr = parseInt(getField(r, NW.year), 10);
                    if (!type || mi === undefined || isNaN(yr)) return;
                    if (WEALTH_EXCLUDE_ITEMS.includes(getField(r, NW.name))) return;
                    const key = yr * 12 + mi;
                    if (key > latestKey) latestKey = key;
                    rows.push({ key, type, amount: Number(getField(r, NW.amount)) || 0 });
                });
                if (latestKey < 0) return { status: 'warn', detail: 'No dated snapshot rows to reconcile against' };
                const byClass = {};
                rows.forEach(r => { if (r.key === latestKey) byClass[r.type] = (byClass[r.type] || 0) + r.amount; });
                // Mirror the live real-estate/mortgage override the view applies.
                if (_valRecords && _debtRecords) {
                    try {
                        const pf = buildPortfolio(_valRecords, _debtRecords);
                        if (pf.rows.length) { byClass['Real Estate'] = pf.totalValue; byClass['Mortgages'] = pf.totalMortAll; }
                    } catch (e) { /* compare against the snapshot figures instead */ }
                }
                // Mirror the loan sync the view applies (editable Debt Terms balances).
                try {
                    const sl = debtRows().filter(r => r.cls === 'Loans');
                    if (sl.length) byClass['Loans'] = sl.reduce((s, r) => s + (r.balance || 0), 0);
                } catch (e) { /* compare against the snapshot loans instead */ }
                // Mirror the live cash/card override (Accounts ticked as Cash / Credit Card).
                const mc = netWorthAccounts('Cash'); if (mc.length) byClass['Cash'] = mc.reduce((s, i) => s + i.amount, 0);
                const md = netWorthAccounts('Credit Card'); if (md.length) byClass['Credit Cards'] = md.reduce((s, i) => s + i.amount, 0);
                const rawAssets = NW_ASSET_CLASSES.reduce((s, c) => s + (byClass[c] || 0), 0);
                const rawLiabilities = NW_LIABILITY_CLASSES.reduce((s, c) => s + (byClass[c] || 0), 0);
                const assetDiff = rawAssets - view.assets;
                const liabDiff = rawLiabilities - view.liabilities;
                const netDiff = (rawAssets - rawLiabilities) - view.net;
                if (Math.abs(assetDiff) > 1 || Math.abs(liabDiff) > 1 || Math.abs(netDiff) > 1) {
                    return { status: 'fail', detail: `Rendered totals drift from the raw snapshot rows — assets Δ ${fmt(assetDiff)}, liabilities Δ ${fmt(liabDiff)}, net Δ ${fmt(netDiff)}` };
                }
                return { status: 'pass', detail: `Raw rows recompute to assets ${fmt(rawAssets)} − liabilities ${fmt(rawLiabilities)} = ${fmt(rawAssets - rawLiabilities)}, matching the view` };
            }},
        ],
    });
    if (typeof markTabSynced === 'function') markTabSynced('wealth');
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

// Which Money Group each personal sub-category belongs to, and which are bucket-funded.
// Live driver is the "Money Group" single-select on the sub-category record; the
// PERSONAL_MONEY_GROUPS map in config.js only backstops a cleared field.
//
// Bucket membership is read from the CODE constant, not the Income Buckets links,
// on purpose: net cash flow must not change value depending on whether an async
// fetch has landed yet. The links decide which pot a category draws from; this
// decides whether it counts as expenditure at all.
function personalMoneyGroups() {
    const byName = {};
    ((typeof allSubCategories !== 'undefined' && allSubCategories) ? allSubCategories : []).forEach(r => {
        const n = getField(r, SUBCAT.name); if (!n) return;
        const g = getField(r, SUBCAT.moneyGroup);
        if (g === 'Needs' || g === 'Wants') byName[String(n)] = g;
    });
    // Fall back to the code map for anything the field does not answer.
    Object.keys(PERSONAL_MONEY_GROUPS).forEach(n => { if (!byName[n]) byName[n] = PERSONAL_MONEY_GROUPS[n]; });
    const bucketSubs = new Set();
    Object.keys(BUCKET_SPEND_SUBCATS).forEach(b => BUCKET_SPEND_SUBCATS[b].forEach(s => bucketSubs.add(s)));
    return { byName, bucketSubs };
}

// Transactions behind the last buildMonthlyCashflow run, indexed sub-category → month
// key → [tx]. Populated as a side-effect so the drill-down shows exactly the rows that
// produced the figure on screen, never a re-query that could filter differently.
let _cfTxIndex = {};

function buildMonthlyCashflow(monthKeys) {
    const txns = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];
    _cfTxIndex = {};
    const subNames = {};
    ((typeof allSubCategories !== 'undefined' && allSubCategories) ? allSubCategories : []).forEach(r => {
        const n = getField(r, SUBCAT.name); if (n) subNames[r.id] = String(n);
    });
    const { byName: moneyGroup, bucketSubs } = personalMoneyGroups();
    const reSet = new Set(CASHFLOW_INCOME_SUBCATS);            // real estate / portfolio revenue
    const piSet = new Set(CASHFLOW_PERSONAL_INCOME_SUBCATS);   // personal income
    const bizSet = new Set(CASHFLOW_COST_SUBCATS);             // business expenditure (itemised)
    const linkId = f => { if (!f) return null; if (Array.isArray(f)) { const x = f[0]; return x && typeof x === 'object' ? x.id : x; } return typeof f === 'object' ? f.id : f; };
    const set = new Set(monthKeys);
    const blank = () => ({ reRevenue: 0, personalIncome: 0, bizItems: {}, perItems: {}, bucketItems: {} });
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
        // Bucket membership is tested FIRST. If a category is somehow both bucket-linked
        // and carrying a Money Group, treating it as budgeted would deduct it from net
        // cash flow AND drain its pot — the exact double-count this design exists to
        // stop. Bucket wins, so the worst case is a missing budget line, not a figure
        // that is wrong twice.
        else if (bucketSubs.has(sub)) m.bucketItems[sub] = (m.bucketItems[sub] || 0) + (-amt);
        else if (moneyGroup[sub]) m.perItems[sub] = (m.perItems[sub] || 0) + (-amt);
        else return; // not counted anywhere — don't index it either
        if (!_cfTxIndex[sub]) _cfTxIndex[sub] = {};
        (_cfTxIndex[sub][key] = _cfTxIndex[sub][key] || []).push(tx);
    });
    return monthKeys.map(k => {
        const m = byMonth[k];
        const bizTotal = Object.values(m.bizItems).reduce((s, v) => s + v, 0);
        const perTotal = Object.values(m.perItems).reduce((s, v) => s + v, 0);
        const bucketTotal = Object.values(m.bucketItems).reduce((s, v) => s + v, 0);
        const groupTotal = g => Object.keys(m.perItems)
            .filter(n => moneyGroup[n] === g)
            .reduce((s, n) => s + m.perItems[n], 0);
        const totalIncome = m.reRevenue + m.personalIncome;
        return {
            key: k, reRevenue: m.reRevenue, personalIncome: m.personalIncome, totalIncome,
            bizItems: m.bizItems, bizTotal, perItems: m.perItems, perTotal,
            bucketItems: m.bucketItems, bucketTotal,
            needsTotal: groupTotal('Needs'), wantsTotal: groupTotal('Wants'),
            net: totalIncome - bizTotal - perTotal,
        };
    });
}

// ── Cash-flow drill-down ─────────────────────────────────────────────────────
// Click any figure in the Monthly cash flow matrix to see the transactions behind
// it, in the same shape as the P&L drill-down. Rows opt in by carrying a `drill`
// array of sub-category names; wealthMatrixCard is shared with the net-worth,
// buckets and ratios tables, and a row without `drill` renders exactly as before.
//
// Reads _cfTxIndex, populated by the same pass that produced the totals, so the
// list can never disagree with the number that was clicked.
function wealthDrill(subs, monthKey, label) {
    if (!Array.isArray(subs) || !subs.length) return;

    const txs = [];
    subs.forEach(sub => {
        const byMonth = _cfTxIndex[sub] || {};
        (monthKey ? [monthKey] : Object.keys(byMonth)).forEach(k => (byMonth[k] || []).forEach(t => txs.push(t)));
    });
    txs.sort((a, b) => new Date(getField(b, F.txDate)) - new Date(getField(a, F.txDate)));

    const subNames = {};
    ((typeof allSubCategories !== 'undefined' && allSubCategories) ? allSubCategories : [])
        .forEach(r => { const n = getField(r, SUBCAT.name); if (n) subNames[r.id] = String(n); });
    const linkId = f => { if (!f) return null; if (Array.isArray(f)) { const x = f[0]; return x && typeof x === 'object' ? x.id : x; } return typeof f === 'object' ? f.id : f; };

    // Editable pickers. Category, sub-category and business are all shown so a
    // miscoded transaction can be corrected here rather than hunting for it on the
    // Reconciliation tab. Saves straight to Airtable; the matrix re-renders on close.
    const optionList = (recs, fieldId) => (recs || [])
        .map(r => ({ id: r.id, name: String(getField(r, fieldId) || '') }))
        .filter(o => o.name).sort((a, b) => a.name.localeCompare(b.name));
    const catOpts = optionList(typeof allCategories !== 'undefined' ? allCategories : [], CAT_NAME_FIELD);
    const subOpts = optionList(typeof allSubCategories !== 'undefined' ? allSubCategories : [], SUBCAT.name);
    const bizOpts = optionList((typeof getActiveBusinesses === 'function') ? getActiveBusinesses()
        : (typeof allBusinesses !== 'undefined' ? allBusinesses : []), BIZ_NAME_FIELD);
    const picker = (txId, kind, opts, currentId) => {
        if (!opts.length) return '<span style="color:var(--text-muted)">–</span>';
        const o = opts.map(x => `<option value="${escHtml(x.id)}"${x.id === currentId ? ' selected' : ''}>${escHtml(x.name)}</option>`).join('');
        return `<select onchange="wealthEditTx('${escHtml(txId)}','${kind}',this.value,this)" style="max-width:180px;padding:4px 6px;border:1px solid var(--border-default);border-radius:var(--radius-sm);font-size:var(--fs-xs);background:var(--bg-surface);color:var(--text-primary)"><option value="">— none —</option>${o}</select>`;
    };

    let total = 0;
    const money = v => `${v < 0 ? '−' : ''}£${Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const rowsHtml = txs.map(t => {
        const amt = Number(getField(t, F.txReportAmount)) || 0;
        total += amt;
        const d = getField(t, F.txDate) || '';
        const desc = String(getField(t, F.txDescription) || getField(t, F.txVendor) || '(no description)');
        const acct = String(getField(t, F.txAccountAlias) || '');
        return `<tr style="border-top:1px solid var(--border-subtle)" data-tx="${escHtml(t.id)}">
            <td style="padding:7px 10px;white-space:nowrap;color:var(--text-secondary);vertical-align:top">${escHtml(d)}</td>
            <td style="padding:7px 10px;vertical-align:top;min-width:180px;word-break:break-word">${escHtml(desc)}</td>
            <td style="padding:7px 10px;vertical-align:top;color:var(--text-muted);white-space:nowrap">${escHtml(acct)}</td>
            <td style="padding:5px 6px;vertical-align:top">${picker(t.id, 'category', catOpts, linkId(getField(t, F.txCategory)))}</td>
            <td style="padding:5px 6px;vertical-align:top">${picker(t.id, 'subCategory', subOpts, linkId(getField(t, F.txSubCategory)))}</td>
            <td style="padding:5px 6px;vertical-align:top">${picker(t.id, 'business', bizOpts, linkId(getField(t, F.txBusiness)))}</td>
            <td style="padding:7px 10px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:var(--fw-semibold);color:${amt < 0 ? 'var(--danger)' : 'var(--success)'};vertical-align:top">${money(amt)}<span class="wd-status" style="display:block;font-size:9px;font-weight:var(--fw-regular);min-height:11px"></span></td>
        </tr>`;
    }).join('');

    wealthCloseDrill();
    const overlay = document.createElement('div');
    overlay.id = 'wealthDrillOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.onclick = e => { if (e.target === overlay) wealthCloseDrill(); };
    overlay.innerHTML = `<div style="background:var(--bg-surface);border-radius:var(--radius-lg);max-width:1000px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:var(--shadow-lg)">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border-default)">
            <div style="min-width:0">
                <div style="font-size:var(--fs-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:1px">${escHtml(monthKey ? wealthMonthLabel(monthKey) : 'Rolling 12 months')}</div>
                <div style="font-size:var(--fs-lg);font-weight:var(--fw-bold);color:var(--text-primary)">${escHtml(label || '')}</div>
                <div style="font-size:var(--fs-sm);color:var(--text-secondary);margin-top:3px">${txs.length} transaction${txs.length === 1 ? '' : 's'} · Total <strong style="color:var(--text-primary)">${money(total)}</strong> <span style="color:var(--text-muted)">· money out shows as a minus. Something in the wrong place? Change its category, sub-category or business right here — it saves as you pick, and the figures update when you close.</span></div>
            </div>
            <button onclick="wealthCloseDrill()" aria-label="Close" style="background:none;border:none;font-size:26px;line-height:1;cursor:pointer;color:var(--text-muted);padding:0 4px">&times;</button>
        </div>
        <div style="overflow:auto;flex:1">
            <table style="width:100%;border-collapse:collapse;font-size:var(--fs-sm)">
                <thead><tr style="position:sticky;top:0;background:var(--bg-subtle)">
                    <th style="text-align:left;padding:7px 10px;font-weight:var(--fw-medium);color:var(--text-muted);font-size:var(--fs-xs)">Date</th>
                    <th style="text-align:left;padding:7px 10px;font-weight:var(--fw-medium);color:var(--text-muted);font-size:var(--fs-xs)">Description</th>
                    <th style="text-align:left;padding:7px 10px;font-weight:var(--fw-medium);color:var(--text-muted);font-size:var(--fs-xs)">Account</th>
                    <th style="text-align:left;padding:7px 10px;font-weight:var(--fw-medium);color:var(--text-muted);font-size:var(--fs-xs)">Category</th>
                    <th style="text-align:left;padding:7px 10px;font-weight:var(--fw-medium);color:var(--text-muted);font-size:var(--fs-xs)">Sub-category</th>
                    <th style="text-align:left;padding:7px 10px;font-weight:var(--fw-medium);color:var(--text-muted);font-size:var(--fs-xs)">Business</th>
                    <th style="text-align:right;padding:7px 10px;font-weight:var(--fw-medium);color:var(--text-muted);font-size:var(--fs-xs)">Amount</th>
                </tr></thead>
                <tbody>${rowsHtml || `<tr><td colspan="7" style="padding:24px;text-align:center;color:var(--text-muted)">No transactions behind this figure.</td></tr>`}</tbody>
            </table>
        </div>
    </div>`;
    document.body.appendChild(overlay);
    document.addEventListener('keydown', wealthDrillEsc);
}
// Save a recategorisation from the drill-down. Writes to Airtable, updates the local
// transaction cache so the page agrees without a refetch, and flags the matrix to
// re-render on close (re-rendering mid-edit would rip the open modal out).
let _wealthDrillEdited = false;
async function wealthEditTx(txId, kind, valueId, el) {
    const fieldId = { category: F.txCategory, subCategory: F.txSubCategory, business: F.txBusiness }[kind];
    if (!fieldId) return;
    const status = el && el.closest('tr') ? el.closest('tr').querySelector('.wd-status') : null;
    const setStatus = (txt, colour) => { if (status) { status.textContent = txt; status.style.color = colour; } };
    setStatus('saving…', 'var(--text-muted)');
    if (el) el.disabled = true;
    try {
        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ records: [{ id: txId, fields: { [fieldId]: valueId ? [valueId] : [] } }] }),
        });
        if (!resp.ok) throw new Error('Airtable ' + resp.status);
        const rec = ((typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : []).find(t => t.id === txId);
        if (rec) { rec.fields = rec.fields || {}; rec.fields[fieldId] = valueId ? [valueId] : []; }
        _wealthDrillEdited = true;
        setStatus('saved', 'var(--success)');
    } catch (e) {
        setStatus('not saved', 'var(--danger)');
        if (typeof showToast === 'function') showToast('Could not save that change — try again', { type: 'error' });
    } finally {
        if (el) el.disabled = false;
    }
}
function wealthCloseDrill() {
    const o = document.getElementById('wealthDrillOverlay');
    if (o) o.remove();
    document.removeEventListener('keydown', wealthDrillEsc);
    // Recategorising moves money between rows, so the figures behind the modal are
    // stale the moment an edit lands. Re-render once, on close.
    if (_wealthDrillEdited) {
        _wealthDrillEdited = false;
        if (typeof renderWealthCashflow === 'function') renderWealthCashflow();
        if (typeof renderPersonalExpenditure === 'function') renderPersonalExpenditure();
        if (typeof loadWealthBuckets === 'function') loadWealthBuckets();
    }
}
function wealthDrillEsc(e) { if (e.key === 'Escape') wealthCloseDrill(); }

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
// Period (months) for the matrices' trend/change column. Defaults to 1-month; changed via the selector.
let _wealthChangeMonths = 1;
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

    // A row opts into the drill-down by carrying `drill` (an array of sub-category
    // names). Rows without it — net worth, buckets, ratios — render exactly as before.
    // Arguments are emitted as JSON literals, not as quoted strings built by hand.
    // escHtml is NOT safe here: it turns ' into &#39;, and the HTML parser decodes
    // entities BEFORE the JS is parsed, so an apostrophe in a category name would
    // close the string literal and break (or inject into) the handler. JSON.stringify
    // escapes for the JS context; the entity pass then escapes for the attribute.
    const jsArg = v => JSON.stringify(v == null ? null : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const drillAttr = (row, monthKey) => {
        if (!row || !row.drill || !row.drill.length) return { attr: '', style: '' };
        return {
            attr: ` onclick="wealthDrill(${jsArg(row.drill)},${jsArg(monthKey || null)},${jsArg(String(row.label || ''))})" title="Show the transactions behind this"`,
            style: 'cursor:pointer;',
        };
    };
    const valCell = (v, prev, goodUp, i, fmtV, row) => {
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
        const d = drillAttr(row, months[i] && months[i].key);
        return `<td${d.attr} style="text-align:right;padding:5px 8px;white-space:nowrap;${d.style}${bg}color:${v < 0 ? 'var(--danger)' : 'var(--text-primary)'}">${(fmtV || fmt0)(v)}${arrow}</td>`;
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
        const fmtV = row.fmt || opts.fmtVal || fmt0;
        const rowBg = isChild ? 'var(--bg-surface-2)' : (row.bold ? 'var(--bg-subtle)' : 'var(--bg-surface)');
        const cells = vals.map((v, i) => valCell(v, i > 0 ? vals[i - 1] : null, goodUp, i, fmtV, row)).join('');
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
    const mg = personalMoneyGroups();
    // Drive the itemised rows from the LIVE group map, not the static constant, so a
    // sub-category classified in Airtable but absent from config still gets its own
    // line. Otherwise its spend would land in the Needs/Wants subtotal with no row
    // behind it and the children would stop summing to the parent.
    const groupNames = g => Object.keys(mg.byName)
        .filter(n => mg.byName[n] === g && cf.some(m => m.perItems[n]))
        .sort((a, b) => cf.reduce((s, m) => s + (m.perItems[b] || 0), 0) - cf.reduce((s, m) => s + (m.perItems[a] || 0), 0));
    const needsNames = groupNames('Needs');
    const wantsNames = groupNames('Wants');
    const bucketNames = Object.keys(BUCKET_SPEND_SUBCATS)
        .reduce((a, b) => a.concat(BUCKET_SPEND_SUBCATS[b]), [])
        .filter(n => cf.some(m => m.bucketItems[n]));

    // Per-month portfolio income (non-cash): the rise in investment value that month,
    // less any contributions you paid in (sub-category "Personal Investment"). It only
    // appears in the month you update the investment value, so most months read £0 and
    // the update month shows the jump. Added to Total income; excluded from Net cash
    // flow because it is reinvested, not withdrawn.
    const mkeys = months.map(m => m.key);
    const periods = (typeof computeNetWorth === 'function' && _wealthRecords) ? computeNetWorth(_wealthRecords) : [];
    const skOf = k => { const [y, mo] = k.split('-').map(Number); return y * 12 + (mo - 1); };
    const invAt = sk => { let best = null; periods.forEach(p => { if (p.sortKey <= sk && (!best || p.sortKey > best.sortKey)) best = p; }); return best ? (best.byClass['Investments'] || 0) : null; };
    const contribAgg = (typeof buildWealthTxAgg === 'function') ? buildWealthTxAgg(mkeys) : mkeys.map(() => ({ contributions: 0 }));
    const portfolioSeries = mkeys.map((k, i) => {
        const cur = invAt(skOf(k)), prev = invAt(skOf(k) - 1);
        if (cur == null || prev == null) return 0;
        return Math.max(0, cur - prev - ((contribAgg[i] && contribAgg[i].contributions) || 0));
    });

    // Drill keys. Every figure below is the sum of transactions in these sub-categories,
    // so the drill-down is the same set the total was built from. Investment income is
    // the one row with no drill: it is a valuation movement, not transactions.
    const allIncome = CASHFLOW_INCOME_SUBCATS.concat(CASHFLOW_PERSONAL_INCOME_SUBCATS);
    const netSubs = allIncome.concat(bizNames, needsNames, wantsNames);

    const sections = [
        { header: 'Money in', rows: [
            { label: 'Real estate income (passive)', values: series(m => m.reRevenue), goodUp: true, drill: CASHFLOW_INCOME_SUBCATS },
            { label: 'Personal income (earned)', values: series(m => m.personalIncome), goodUp: true, drill: CASHFLOW_PERSONAL_INCOME_SUBCATS },
            { label: 'Investment income (portfolio)', values: portfolioSeries, goodUp: true },
            { label: 'Total income', values: cf.map((m, i) => m.totalIncome + portfolioSeries[i]), goodUp: true, bold: true, border: '1px solid var(--border-default)', drill: allIncome },
        ] },
        { header: 'Expenditure', rows: [
            { label: 'Business expenditure', values: series(m => m.bizTotal), goodUp: false, bold: true, drill: bizNames,
              items: bizNames.map(n => ({ label: wealthCfLabel(n), values: series(m => m.bizItems[n] || 0), goodUp: false, drill: [n] })) },
            { label: 'Personal expenditure', values: series(m => m.perTotal), goodUp: false, bold: true, drill: needsNames.concat(wantsNames),
              items: [
                  { label: 'Needs', values: series(m => m.needsTotal), goodUp: false, drill: needsNames },
                  ...needsNames.map(n => ({ label: '· ' + wealthCfLabel(n), values: series(m => m.perItems[n] || 0), goodUp: false, drill: [n] })),
                  { label: 'Wants', values: series(m => m.wantsTotal), goodUp: false, drill: wantsNames },
                  ...wantsNames.map(n => ({ label: '· ' + wealthCfLabel(n), values: series(m => m.perItems[n] || 0), goodUp: false, drill: [n] })),
              ] },
        ] },
        { header: '', rows: [
            { label: 'Net cash flow', values: series(m => m.net), goodUp: true, bold: true, border: '2px solid var(--border-default)', drill: netSubs },
        ] },
        ...(bucketNames.length ? [{ header: 'Funded from your buckets (not expenditure)', rows: [
            { label: 'Bucket spending', values: series(m => m.bucketTotal), goodUp: false, bold: true, drill: bucketNames,
              items: bucketNames.map(n => ({ label: wealthCfLabel(n), values: series(m => m.bucketItems[n] || 0), goodUp: false, drill: [n] })) },
        ] }] : []),
    ];
    el.innerHTML = `<div style="background:var(--accent-soft);border-left:3px solid var(--accent);border-radius:var(--radius-md);padding:12px 16px;margin-bottom:var(--space-4);font-size:var(--fs-sm);color:var(--text-primary);line-height:1.55"><strong>Use this at your monthly review.</strong> It shows whether more came in than went out across your whole life, property plus personal, month by month, and whether your net worth is climbing. This is the long game, not a spend-today figure. For what is safe to spend today, use the <strong>Money Confidence</strong> tab. For the month ahead, use the <strong>Cash Flow</strong> tab.</div>` + wealthMatrixCard(
        'Monthly cash flow — rolling 12 months',
        'Money in (real estate / portfolio revenue + personal income + portfolio income) less itemised business and personal expenditure = net cash flow, which feeds your buckets. Personal expenditure is your BUDGETED money only — Needs and Wants. Money you spend from a bucket (debt payments, travel, maintenance, investment, tax) is shown at the bottom and is deliberately NOT deducted here: its pot was already funded out of an earlier month’s surplus, so counting it again would starve every bucket in the month you finally spend what you saved. Portfolio income is your investments’ growth: added to Total income but excluded from Net cash flow because it is reinvested, not withdrawn. Click a row <em>name</em> to expand the detail, or click any <em>figure</em> to see the transactions behind it. The current month (●) is still in progress; the highlighted column and the Δ trend use the last completed month.',
        months, sections, { anchor: 'completed' });
}

// ── Property portfolio — per property ─────────────────────────────────────────
// Joins each property's latest Approved valuation (Property Valuations table) to
// its mortgage balance (Debt Terms, Class=Mortgages) to show value, mortgage and
// equity per property, plus reconciled real-estate / mortgage / equity totals.
// This itemises what the monthly snapshot holds as single lumped lines.
let _valRecords = null;
let _valPromise = null;

// ── Pending property valuations (review + approve on the Wealth tab) ──────────
// The monthly AI job writes fresh values as "Pending Review". Kevin approves them
// here; because both the Wealth tab and the Operations Properties tab read the same
// Property Valuations table, approving from here updates both. Net worth only moves
// once approved.
function renderWealthPendingVals() {
    const el = document.getElementById('wealthPendingVals');
    if (!el) return;
    const vals = (typeof _valRecords !== 'undefined' && _valRecords) ? _valRecords : [];
    const pend = vals.filter(r => getField(r, VAL.status) === 'Pending Review');
    if (!pend.length) { el.innerHTML = ''; return; }
    // Latest Approved value per property key, so each row shows old → new.
    const approvedByKey = {};
    vals.forEach(r => {
        if (getField(r, VAL.status) !== 'Approved') return;
        const key = wealthPropKey(getField(r, VAL.title) || '');
        if (!key) return;
        const date = getField(r, VAL.date) || '';
        if (!approvedByKey[key] || date > approvedByKey[key].date) approvedByKey[key] = { date, value: Number(getField(r, VAL.value)) || 0 };
    });
    const rowsHtml = pend.map(r => {
        const title = getField(r, VAL.title) || '';
        const name = (title.split('·')[0] || title).trim();
        const nv = Number(getField(r, VAL.value)) || 0;
        const cur = approvedByKey[wealthPropKey(title)];
        const conf = getField(r, VAL.confidence) || '';
        const comps = getField(r, VAL.comparables) || '';
        const diff = cur ? nv - cur.value : null;
        const delta = (diff == null || diff === 0) ? '' :
            `<span style="color:${diff > 0 ? 'var(--success)' : 'var(--danger)'};font-weight:var(--fw-semibold)"> ${diff > 0 ? '▲' : '▼'} ${fmt0(Math.abs(diff))}</span>`;
        return `<div style="border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:10px 12px;margin-bottom:8px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
                <div style="min-width:0">
                    <div style="font-weight:var(--fw-semibold);color:var(--text-primary)">${escHtml(name)}</div>
                    <div style="font-size:var(--fs-xs);color:var(--text-muted)">${cur ? escHtml(fmt0(cur.value)) + ' → ' : ''}<span style="color:var(--text-primary);font-weight:var(--fw-semibold)">${escHtml(fmt0(nv))}</span>${delta} &middot; ${escHtml(conf || 'no')} confidence</div>
                </div>
                <div style="display:flex;gap:6px;flex-shrink:0">
                    <button onclick="wealthValuationAction(['${r.id}'],'Approved')" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-md);padding:6px 14px;font-size:var(--fs-sm);font-weight:var(--fw-semibold);cursor:pointer">Approve</button>
                    <button onclick="wealthValuationAction(['${r.id}'],'Rejected')" style="background:none;border:1px solid var(--border-default);color:var(--text-secondary);border-radius:var(--radius-md);padding:6px 12px;font-size:var(--fs-sm);cursor:pointer">Reject</button>
                </div>
            </div>
            ${comps ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:var(--fs-xs);color:var(--text-secondary)">Why this figure</summary><div style="font-size:var(--fs-xs);color:var(--text-secondary);margin-top:4px;line-height:1.5">${escHtml(comps)}</div></details>` : ''}
        </div>`;
    }).join('');
    el.innerHTML = `<div class="kpi-card" style="border-left:3px solid var(--accent-gold)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;flex-wrap:wrap">
            <div class="kpi-card-label" style="margin:0">${pend.length} property valuation${pend.length === 1 ? '' : 's'} to review</div>
            <button onclick="wealthApproveAllValuations()" style="background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-md);padding:6px 14px;font-size:var(--fs-sm);font-weight:var(--fw-semibold);cursor:pointer">Approve all</button>
        </div>
        <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-bottom:10px;line-height:1.5">Fresh AI estimates from the monthly job. Approving updates net worth here and the Operations Properties tab (same source). Nothing changes until you approve.</div>
        ${rowsHtml}
    </div>`;
}

async function wealthApproveAllValuations() {
    const ids = ((typeof _valRecords !== 'undefined' && _valRecords) ? _valRecords : [])
        .filter(r => getField(r, VAL.status) === 'Pending Review').map(r => r.id);
    await wealthValuationAction(ids, 'Approved');
}

// Set the status on one or more Property Valuations records, then re-fetch and
// re-render so net worth and the review list reflect the change immediately.
async function wealthValuationAction(ids, status) {
    if (!ids || !ids.length) return;
    try {
        const recs = ids.map(id => ({ id, fields: { [VAL.status]: status } }));
        for (let i = 0; i < recs.length; i += 10) {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.valuations}`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ records: recs.slice(i, i + 10), typecast: true }),
            });
            if (!resp.ok) throw new Error('Airtable ' + resp.status);
            if (i + 10 < recs.length) await new Promise(r => setTimeout(r, 300));
        }
        if (typeof showToast === 'function') showToast(`${ids.length} valuation${ids.length === 1 ? '' : 's'} ${status.toLowerCase()}`, { type: 'success' });
        _valPromise = null; _valRecords = null;
        try { _valRecords = await airtableFetch(TABLES.valuations); } catch (e) { /* keep going; render handles empty */ }
        const el = document.getElementById('tab-wealth');
        if (el && _wealthRecords) renderWealthContent(el, _wealthRecords);
    } catch (e) {
        if (typeof showToast === 'function') showToast('Could not update the valuation — please try again', { type: 'error' });
    }
}

// ── Debts in detail (per-debt rate, balance, monthly cost) + AI pay-down guidance ──
// One place to see what each debt costs. Balances self-calculate: interest-only debts
// hold at principal, repayment debts amortise (reuses amortisedBalance), credit cards
// use the live account balance. Rates/terms are set three ways (type, screenshot, or a
// T&Cs document the AI reads) and saved to Debt Terms, so the figures keep working from
// then on. Reads the same Debt Terms + accounts as net worth, so no second set of numbers.
const WEALTH_CARD_NAMES = ['American Express', 'Santander Credit Card', 'Lloyds Credit Card'];
const _num = v => (v === '' || v == null) ? null : (isFinite(Number(v)) ? Number(v) : null);

// Account number = the trailing 6+ alphanumeric token of a debt/cost name, e.g.
// "Kent Reliance - 55EP - 70016005" → "70016005". This joins a Debt Terms record to
// its real monthly payment in the Costs table (both carry the same account number).
function debtAcctKey(name) {
    const m = String(name || '').match(/([A-Za-z0-9]{6,})\s*$/);
    return m ? m[1].toLowerCase() : '';
}

// account number → real monthly payment (Costs table, expected amount). First match wins.
function debtCostByAcct() {
    const costs = (typeof allCosts !== 'undefined' && allCosts) ? allCosts : [];
    const map = {};
    costs.forEach(c => {
        if (typeof isCostActive === 'function' && !isCostActive(c)) return; // only active payments count (skip paused/inactive)
        const key = debtAcctKey(getField(c, F.costName) || '');
        const amt = Number(getField(c, F.costExpected)) || 0;
        if (key && amt > 0 && map[key] == null) map[key] = amt;
    });
    return map;
}

// Loan balances come from the latest net worth snapshot (Loans class) where the
// pre-entered figures live — Debt Terms holds the loan names but not their balances.
function debtLoanBalances() {
    try {
        const periods = computeNetWorth((typeof _wealthRecords !== 'undefined' && _wealthRecords) ? _wealthRecords : []);
        const latest = periods[periods.length - 1];
        const m = {};
        ((latest && latest.items && latest.items['Loans']) || []).forEach(it => { if (it.name) m[it.name.trim().toLowerCase()] = it.amount; });
        return m;
    } catch (e) { return {}; }
}

// The annual rate a repayment schedule implies, from its real monthly payment, current
// balance and remaining term: payment = balance·i / (1−(1+i)^−rem). Binary search on i.
function solveRepayRate(payment, balance, remMonths) {
    if (!(payment > 0) || !(balance > 0) || !(remMonths > 0)) return null;
    const pay = i => i === 0 ? balance / remMonths : balance * i / (1 - Math.pow(1 + i, -remMonths));
    let lo = 0, hi = 0.40 / 12;
    if (pay(hi) < payment) return null; // implies > 40% a year — implausible, leave unknown
    for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (pay(mid) < payment) lo = mid; else hi = mid; }
    return (lo + hi) / 2 * 12 * 100;
}

function debtRows() {
    const debts = (typeof _debtRecords !== 'undefined' && _debtRecords) ? _debtRecords : [];
    const costByAcct = debtCostByAcct();
    const loanBal = debtLoanBalances();
    // Credit-card rate rows live in Debt Terms (Class = Credit Cards), matched by name.
    const cardRec = {};
    debts.forEach(r => { if (getField(r, DEBT.cls) === 'Credit Cards') cardRec[(getField(r, DEBT.name) || '').trim().toLowerCase()] = r; });
    // Cards = the Accounts you've ticked as "Credit Card" (balance live from the account),
    // matched to a Debt Terms row by name for the rate.
    const cardRows = netWorthAccounts('Credit Card').map(acc => {
        const rec = cardRec[acc.name.trim().toLowerCase()];
        const rate = rec ? _num(getField(rec, DEBT.rate)) : null;
        const balance = acc.amount; // live from the Accounts table — never the stored figure
        // Monthly interest = balance × annual APR ÷ 12 (the rate is an annual APR).
        const monthly = (rate != null && rate > 0 && balance > 0) ? balance * rate / 100 / 12 : null;
        return { id: rec ? rec.id : '', name: acc.name, cls: 'Credit Cards', type: 'Revolving', rate, storedRate: rate, balance, monthly, live: true, principal: balance, term: 0, start: '', flag: false };
    });
    const otherRows = debts.filter(r => getField(r, DEBT.cls) !== 'Credit Cards').map(r => {
        const name = getField(r, DEBT.name) || '';
        const cls = getField(r, DEBT.cls) || 'Loans';
        const type = getField(r, DEBT.type) || '';
        const storedRate = _num(getField(r, DEBT.rate));
        const principal = Number(getField(r, DEBT.principal)) || 0;
        const term = Number(getField(r, DEBT.term)) || 0;
        const start = getField(r, DEBT.start) || '';
        // Balance: loans use your edited figure (Debt Terms) first, falling back to the
        // snapshot; mortgages amortise (interest-only holds at principal).
        let balance;
        if (cls === 'Loans') { const lb = loanBal[name.trim().toLowerCase()]; balance = principal > 0 ? principal : (lb != null ? lb : 0); }
        else { balance = amortisedBalance(type, principal, storedRate || 0, term, start).balance; }
        // Real monthly payment, matched by account number.
        const monthly = costByAcct[debtAcctKey(name)] != null ? costByAcct[debtAcctKey(name)] : null;
        // Rate DERIVED from the real payment: interest-only = payment×12÷balance; repayment solved.
        let rate = null;
        if (monthly != null && balance > 0) {
            if (type === 'Repayment') {
                const s = start ? new Date(start) : null;
                const elapsed = (s && !isNaN(s.getTime())) ? Math.max(0, (new Date().getFullYear() - s.getFullYear()) * 12 + (new Date().getMonth() - s.getMonth())) : 0;
                rate = solveRepayRate(monthly, balance, term > 0 ? Math.max(1, term - elapsed) : 0);
            } else {
                rate = monthly * 12 / balance * 100;
            }
        }
        if (rate == null) rate = storedRate;                 // no payment yet → fall back to the lender rate
        const flag = (rate != null && storedRate != null && Math.abs(rate - storedRate) > 0.5);
        return { id: r.id, name, cls, type, rate, storedRate, balance, monthly, live: false, principal, term, start, flag };
    });
    return cardRows.concat(otherRows);
}

function renderDebtsDetail() {
    const el = document.getElementById('wealthDebts');
    if (!el) return;
    const rows = debtRows();
    if (!rows.length) { el.innerHTML = ''; return; }
    const CLS = ['Credit Cards', 'Loans', 'Mortgages'];
    const totOwed = rows.reduce((s, r) => s + (r.balance || 0), 0);
    const totMonthly = rows.reduce((s, r) => s + (r.monthly || 0), 0);
    const missing = rows.filter(r => r.rate == null).length;
    const flagged = rows.filter(r => r.flag).length;
    const noPay = rows.filter(r => r.cls !== 'Credit Cards' && r.monthly == null).length;

    const rateCell = r => {
        if (r.rate == null) return `<span style="color:var(--accent);font-size:var(--fs-xs)">set rate</span>`;
        const shown = Math.round(r.rate * 100) / 100;
        const col = r.rate >= 8 ? 'var(--danger)' : r.rate >= 6 ? 'var(--warning)' : 'var(--text-primary)';
        const warn = r.flag ? `<span title="Payment implies ${shown}% but the lender rate is ${r.storedRate}% — check this balance" style="color:var(--warning);font-size:10px;cursor:help"> &#9888;</span>` : '';
        return `<span style="font-weight:var(--fw-semibold);color:${col}">${shown}%</span>${warn}`;
    };
    const editorId = r => 'de-' + (r.id || r.name.replace(/[^a-z0-9]/gi, ''));
    const rowHtml = r => {
        const eid = editorId(r);
        return `<div style="border-bottom:1px solid var(--border-subtle)">
            <div style="display:grid;grid-template-columns:1fr auto auto auto auto;gap:10px;align-items:center;padding:7px 8px;font-size:var(--fs-sm)">
                <div style="min-width:0"><span style="color:var(--text-primary)">${escHtml(r.name)}</span> <span style="color:var(--text-muted);font-size:var(--fs-xs)">${escHtml(r.type || '')}${r.live ? ' · live' : ''}</span></div>
                <div style="text-align:right;white-space:nowrap;color:var(--text-primary)">${escHtml(fmt0(r.balance))}</div>
                <div style="text-align:right;white-space:nowrap;width:64px">${rateCell(r)}</div>
                <div style="text-align:right;white-space:nowrap;width:96px;color:var(--text-secondary)">${r.monthly != null ? escHtml(fmt0(r.monthly)) + '/mo' : '—'}</div>
                <button onclick="wealthToggleDebtEditor('${eid}')" style="background:none;border:1px solid var(--border-default);border-radius:var(--radius-sm);cursor:pointer;font-size:var(--fs-xs);color:var(--text-secondary);padding:3px 9px">Edit</button>
            </div>
            <div id="${eid}" style="display:none;padding:4px 8px 12px">${debtEditorHtml(r)}</div>
        </div>`;
    };
    const sections = CLS.map(cls => {
        const g = rows.filter(r => r.cls === cls).sort((a, b) => (b.rate == null ? -1 : b.rate) - (a.rate == null ? -1 : a.rate));
        if (!g.length) return '';
        const sub = g.reduce((s, r) => s + (r.balance || 0), 0);
        return `<div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;font-size:var(--fs-xs);font-weight:var(--fw-semibold);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;padding:0 8px 4px">
                <span>${escHtml(cls)}</span><span>${escHtml(fmt0(sub))}</span>
            </div>${g.map(rowHtml).join('')}</div>`;
    }).join('');

    el.innerHTML = `<div class="kpi-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:4px">
            <div class="kpi-card-label" style="margin:0">Debts in detail</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
                <button onclick="wealthAddLoan()" style="background:none;border:1px solid var(--border-default);color:var(--text-secondary);border-radius:var(--radius-md);padding:6px 12px;font-size:var(--fs-sm);cursor:pointer">+ Add loan</button>
                <button onclick="getDebtGuidance(this)" style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);padding:6px 14px;font-size:var(--fs-sm);font-weight:var(--fw-semibold);cursor:pointer">Get pay-down guidance</button>
            </div>
        </div>
        <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-bottom:8px;line-height:1.5">Sorted by interest rate, highest first. Total owed <strong style="color:var(--text-primary)">${escHtml(fmt0(totOwed))}</strong> · payments <strong style="color:var(--text-primary)">${escHtml(fmt0(totMonthly))}/mo</strong>${missing ? ` · <span style="color:var(--warning)">${missing} still need a rate</span>` : ''}. For mortgages, the monthly figure is your real payment (active costs only) and the rate is what that payment implies; &#9888; means it differs from the lender's rate, so that balance is worth checking${flagged ? ` (${flagged} flagged)` : ''}. For credit cards, the balance is live from your accounts (never overwritten) and the monthly figure is the interest at the card's annual APR. Loan balances are editable and carry forward.${noPay ? ` ${noPay} debt${noPay === 1 ? '' : 's'} have no matched payment yet — set the terms by typing, dropping a screenshot, or dropping the terms document.` : ''}</div>
        <div id="wealthAddLoanForm" style="display:none;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
            <input id="wealthNewLoanName" type="text" placeholder="Loan name (e.g. Director's loan)" autocomplete="off" name="wealth-new-loan"
                onkeydown="if(event.key==='Enter'){event.preventDefault();wealthSubmitLoan()}"
                style="flex:1;min-width:180px;padding:6px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface)">
            <button id="wealthAddLoanBtn" onclick="wealthSubmitLoan()" style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);padding:6px 14px;font-size:var(--fs-sm);font-weight:var(--fw-semibold);cursor:pointer">Add</button>
        </div>
        ${sections}
        <div id="wealthDebtGuidance" style="margin-top:12px"></div>
    </div>`;
}

function wealthToggleDebtEditor(eid) {
    const el = document.getElementById(eid);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// Inline editor for one debt: manual fields + drag/clip a screenshot or terms doc.
function debtEditorHtml(r) {
    const inp = (cls, ph, val, extra) => `<input class="${cls}" placeholder="${escHtml(ph)}" value="${val == null ? '' : escHtml(String(val))}" ${extra || ''} style="padding:5px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface);width:100%">`;
    const isRepay = r.type === 'Repayment';
    return `<div class="debt-editor" data-id="${escHtml(r.id)}" data-name="${escHtml(r.name)}" data-cls="${escHtml(r.cls)}"
        ondragover="event.preventDefault();this.style.background='var(--bg-surface-2)'" ondragleave="this.style.background=''" ondrop="wealthDebtDrop(event,this)">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:8px">
            <label style="font-size:var(--fs-xs);color:var(--text-muted)">Rate %${inp('de-rate', 'e.g. 22.9', r.rate, 'type="number" step="0.01"')}</label>
            <label style="font-size:var(--fs-xs);color:var(--text-muted)">Type<select class="de-type" style="padding:5px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface);width:100%"><option${r.type === 'Interest-only' ? ' selected' : ''}>Interest-only</option><option${isRepay ? ' selected' : ''}>Repayment</option><option${r.cls === 'Credit Cards' ? ' selected' : ''}>Revolving</option></select></label>
            ${r.cls === 'Credit Cards'
                ? `<label style="font-size:var(--fs-xs);color:var(--text-muted)">Balance (from Accounts, live)<div style="padding:5px 8px;font-size:var(--fs-sm);color:var(--text-secondary)">${escHtml(fmt0(r.balance))}</div></label>`
                : `<label style="font-size:var(--fs-xs);color:var(--text-muted)">${r.cls === 'Loans' ? 'Current balance £' : 'Original amount £'}${inp('de-principal', '0', (r.cls === 'Loans' ? r.balance : r.principal) || '', 'type="number" step="0.01"')}</label>`}
            <label style="font-size:var(--fs-xs);color:var(--text-muted)">Term (months)${inp('de-term', 'repayment only', r.term || '', 'type="number"')}</label>
            <label style="font-size:var(--fs-xs);color:var(--text-muted)">Start date${inp('de-start', 'YYYY-MM-DD', r.start || '', 'type="date"')}</label>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button onclick="wealthSaveDebt(this)" style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);padding:6px 14px;font-size:var(--fs-sm);font-weight:var(--fw-semibold);cursor:pointer">Save</button>
            <button onclick="wealthReadDebtDoc(this)" style="background:none;border:1px solid var(--border-default);border-radius:var(--radius-md);padding:6px 12px;font-size:var(--fs-sm);cursor:pointer;color:var(--text-secondary)">📎 Read screenshot / document</button>
            <span class="de-status" style="font-size:var(--fs-xs);color:var(--text-muted)">Drop a screenshot or terms PDF here, or type the figures.</span>
        </div>
    </div>`;
}

async function wealthSaveDebt(btn) {
    const box = btn.closest('.debt-editor');
    if (!box) return;
    const status = box.querySelector('.de-status');
    const val = sel => { const e = box.querySelector(sel); return e ? e.value.trim() : ''; };
    const fields = {};
    const rate = _num(val('.de-rate')); if (rate != null) fields[DEBT.rate] = rate;
    const type = val('.de-type'); if (type) fields[DEBT.type] = type;
    // Credit-card balances come from the Accounts table and are never stored/overwritten here.
    const principal = _num(val('.de-principal')); if (principal != null && box.dataset.cls !== 'Credit Cards') fields[DEBT.principal] = principal;
    const term = _num(val('.de-term')); if (term != null) fields[DEBT.term] = Math.round(term);
    const start = val('.de-start'); if (start) fields[DEBT.start] = start;
    if (!Object.keys(fields).length) { if (status) { status.textContent = 'Nothing to save yet.'; } return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const id = box.dataset.id;
        let resp;
        if (id) {
            resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.debtTerms}`, {
                method: 'PATCH', headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ records: [{ id, fields }], typecast: true }),
            });
        } else {
            // New record — needed for a credit card whose rate is set for the first time.
            fields[DEBT.name] = box.dataset.name;
            fields[DEBT.cls] = box.dataset.cls;
            resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.debtTerms}`, {
                method: 'POST', headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ records: [{ fields }], typecast: true }),
            });
        }
        if (!resp.ok) throw new Error('Airtable ' + resp.status);
        if (typeof showToast === 'function') showToast('Debt updated', { type: 'success' });
        _debtPromise = null; _debtRecords = null;
        try { _debtRecords = await airtableFetch(TABLES.debtTerms); } catch (e) { /* render handles empty */ }
        const el = document.getElementById('tab-wealth');
        if (el && _wealthRecords) renderWealthContent(el, _wealthRecords);
    } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
        if (status) { status.textContent = 'Could not save — try again.'; status.style.color = 'var(--danger)'; }
    }
}

function wealthDebtDrop(event, box) {
    event.preventDefault();
    box.style.background = '';
    const file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
    if (file) wealthExtractDebtTerms(box, file);
}

function wealthReadDebtDoc(btn) {
    const box = btn.closest('.debt-editor');
    if (!box) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,application/pdf';
    input.onchange = () => { if (input.files && input.files[0]) wealthExtractDebtTerms(box, input.files[0]); };
    input.click();
}

const DEBT_EXTRACT_PROMPT = 'You are reading a loan, mortgage, or credit-card statement or terms document. Extract these fields and respond with ONLY a JSON object, no other text: {"rate": <annual interest rate as a number in percent, or null>, "type": <"Interest-only" or "Repayment" or "Revolving" or null>, "principal": <the original loan amount or current balance in GBP as a number, or null>, "term": <full term in months as a number, or null>, "start": <start date as YYYY-MM-DD, or null>}. Use null for any field not clearly stated. Numbers only, no commas or currency symbols.';

async function wealthExtractDebtTerms(box, file) {
    const status = box.querySelector('.de-status');
    const setS = (t, c) => { if (status) { status.textContent = t; status.style.color = c || 'var(--text-muted)'; } };
    const okTypes = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
    if (!okTypes.includes(file.type)) { setS('Use a PNG, JPG or PDF.', 'var(--danger)'); return; }
    if (file.size > 8 * 1024 * 1024) { setS('File too big (8MB max).', 'var(--danger)'); return; }
    setS('Reading…');
    try {
        const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
        const b64 = String(dataUrl).split(',')[1];
        if (!b64) { setS('Could not read the file — enter manually.', 'var(--danger)'); return; }
        const block = (file.type === 'application/pdf')
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
            : { type: 'image', source: { type: 'base64', media_type: file.type, data: b64 } };
        const resp = await fetch(AI_PROXY, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: AI_MODEL_DEFAULT, max_tokens: 300, messages: [{ role: 'user', content: [block, { type: 'text', text: DEBT_EXTRACT_PROMPT }] }] }),
        });
        if (!resp.ok) { setS('Could not read — enter manually.', 'var(--danger)'); return; }
        const data = await resp.json();
        let text = '';
        (data.content || []).forEach(b => { if (b && b.type === 'text') text += b.text; });
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) { setS('No terms found — enter manually.', 'var(--danger)'); return; }
        const got = JSON.parse(m[0]);
        const put = (sel, v) => { if (v == null) return; const e = box.querySelector(sel); if (e) { e.value = v; e.style.borderColor = 'var(--success)'; } };
        put('.de-rate', got.rate);
        put('.de-principal', got.principal);
        put('.de-term', got.term);
        put('.de-start', got.start);
        if (got.type) { const t = box.querySelector('.de-type'); if (t) t.value = got.type; }
        setS('Read it — check the figures, then Save.', 'var(--success)');
    } catch (e) {
        setS('Could not read — enter manually.', 'var(--danger)');
    }
}

async function getDebtGuidance(btn) {
    const out = document.getElementById('wealthDebtGuidance');
    if (!out) return;
    const rows = debtRows();
    const known = rows.filter(r => r.rate != null && r.balance > 0);
    if (!known.length) { out.innerHTML = `<div style="color:var(--text-muted);font-size:var(--fs-sm)">Set a rate on at least one debt first.</div>`; return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
    out.innerHTML = `<div style="color:var(--text-muted);font-size:var(--fs-sm)"><span class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px"></span>Reading your debts…</div>`;
    out.scrollIntoView({ behavior: 'smooth', block: 'center' }); // move the screen to the results so it's obvious something happened
    const list = rows.map(r => `- ${r.name} (${r.cls}): balance £${Math.round(r.balance)}, rate ${r.rate == null ? 'UNKNOWN' : (Math.round(r.rate * 100) / 100) + '%'}, ${r.monthly != null ? '£' + Math.round(r.monthly) + '/mo payment' : 'monthly payment unknown'}`).join('\n');
    const prompt = `You are a UK wealth adviser. Here are the client's debts:\n${list}\n\nAssume long-run investment returns of about 5-7% a year after tax. In plain, direct English (UK), and in under 180 words:\n1. Name the debts that cost MORE than investing would return (pay these down first) and the order to clear them.\n2. Name the debts cheap enough that investing the money likely beats overpaying them.\n3. Give one clear next action.\nName any debt whose rate is UNKNOWN and say it needs a rate before it can be judged. Be specific with the debt names. No preamble, no disclaimer.`;
    try {
        const resp = await fetch(AI_PROXY, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: AI_MODEL_DEFAULT, max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!resp.ok) throw new Error('proxy ' + resp.status);
        const data = await resp.json();
        let text = '';
        (data.content || []).forEach(b => { if (b && b.type === 'text') text += b.text; });
        out.innerHTML = `<div style="background:var(--accent-soft);border-radius:var(--radius-md);padding:12px 14px;font-size:var(--fs-sm);color:var(--text-primary);line-height:1.6;white-space:pre-wrap">${escHtml(text.trim())}</div>`;
        out.scrollIntoView({ behavior: 'smooth', block: 'start' }); // land on the finished guidance
    } catch (e) {
        out.innerHTML = `<div style="color:var(--danger);font-size:var(--fs-sm)">Could not get guidance right now — please try again.</div>`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Get pay-down guidance'; }
    }
}

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
    const liveGroups = personalMoneyGroups().byName;

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
        // Group from the LIVE Money Group field, same source the cash-flow matrix uses,
        // so the two tables on this page can never split the same category differently.
        // Falls back to the static group when the field is blank.
        const live = liveGroups['Personal ' + c.name];
        return { id: c.id, name: c.name, group: live || c.group || 'Needs', byMonth, total, avg: total / months.length, budget: budgetByName[c.name] || 0, budgetId: budgetIdByName[c.name] || '', txns: txnsByCat[c.id] };
    }).sort((a, b) => b.total - a.total);

    const grandAvg = rows.reduce((s, r) => s + r.total, 0) / months.length;
    const grandBudget = rows.reduce((s, r) => s + r.budget, 0);
    const fmt0 = n => '£' + Math.round(n).toLocaleString('en-GB');

    const headCells = months.map(m => `<th style="text-align:right;padding:6px 8px;font-weight:var(--fw-medium);color:var(--text-muted);font-size:var(--fs-xs)">${escHtml(m.label)}</th>`).join('');
    const colspan = months.length + 3; // Category + months + Avg + Budget
    const fmt2 = n => '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Needs and Wants are budgeted separately, so the table is grouped with a
    // subtotal per group rather than one flat biggest-first list.
    const groupHeader = (g, label) => {
        const gr = rows.filter(r => r.group === g);
        if (!gr.length) return '';
        const avg = gr.reduce((s, r) => s + r.avg, 0);
        const bud = gr.reduce((s, r) => s + r.budget, 0);
        const cells = months.map((m, i) => `<td style="text-align:right;padding:6px 8px;font-weight:var(--fw-semibold);color:var(--text-secondary)">${fmt0(gr.reduce((s, r) => s + (r.byMonth[i] || 0), 0))}</td>`).join('');
        return `<tr style="background:var(--bg-subtle)">
            <td style="padding:7px 8px;font-weight:var(--fw-semibold);color:var(--text-primary)">${escHtml(label)}</td>
            ${cells}
            <td style="text-align:right;padding:7px 8px;font-weight:var(--fw-semibold);color:${bud > 0 && avg > bud ? 'var(--danger)' : 'var(--text-primary)'}">${fmt0(avg)}</td>
            <td style="text-align:right;padding:7px 8px;font-weight:var(--fw-semibold);color:var(--text-secondary)">${bud > 0 ? fmt0(bud) : '–'}</td>
        </tr>`;
    };
    const rowHtml = r => {
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
    };
    const bodyRows = [
        groupHeader('Needs', 'Needs — what you must pay'),
        rows.filter(r => r.group === 'Needs').map(rowHtml).join(''),
        groupHeader('Wants', 'Wants — what you choose to pay'),
        rows.filter(r => r.group === 'Wants').map(rowHtml).join(''),
    ].join('');
    const totalCells = months.map((m, idx) => {
        const t = rows.reduce((s, r) => s + (r.byMonth[idx] || 0), 0);
        return `<td style="text-align:right;padding:8px;font-weight:var(--fw-semibold);color:var(--text-primary)">${fmt0(t)}</td>`;
    }).join('');

    el.innerHTML = `<div class="kpi-card">
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:4px;flex-wrap:wrap">
            <span class="kpi-card-label">Personal expenditure vs budget</span>
            <span style="margin-left:auto;color:var(--text-secondary);font-size:var(--fs-sm)">Avg/month: <strong style="color:var(--text-primary)">${fmt0(grandAvg)}</strong>${grandBudget > 0 ? ` vs budget <strong style="color:${grandAvg > grandBudget ? 'var(--danger)' : 'var(--success)'}">${fmt0(grandBudget)}</strong>` : ''}</span>
        </div>
        <div style="color:var(--text-muted);font-size:var(--fs-xs);margin-bottom:12px;line-height:1.5">Actual spend per category, last 6 months, from your reconciled transactions. <strong>Needs</strong> are what you must pay; <strong>Wants</strong> are what you choose to pay. Set a monthly budget per category; the Avg turns red when you are over it, green when under. Save to persist. Travel, tax, maintenance, investment and debt payments are not here on purpose — they come out of your buckets, not your budget.</div>
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
            <button id="beSave" onclick="saveBucketEditor()" style="margin-left:auto;background:var(--accent);color:var(--accent-on);border:none;border-radius:var(--radius-md);padding:8px 18px;font-weight:var(--fw-semibold);cursor:pointer">Save buckets</button>
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

    const note = `Each row is a bucket and its share (%) of net cash flow. The highlighted "In the pot" column is what's in each bucket right now — apportioned in, less spent, never below £0. The monthly columns show what went in that month (£0 in any month with no surplus). Click a bucket to see what's been spent and its running balance. A <em>negative</em> figure on the Spent row is money coming back — a refund, or a direct debit that bounced and was returned — and it cancels the payment it reverses. If you spend more than a pot holds, the overspend carries forward, so the pot stays at £0 until later months have made it back. The current month (●) is still in progress; the Δ trend uses the last completed month.${totalPct !== 100 ? ` Percentages total ${totalPct}% (aim for 100%).` : ''}`;
    el.innerHTML = wealthMatrixCard('Income buckets — rolling 12 months', note, months, [{ header: '', rows }], { leadHeader: 'In the pot', anchor: 'completed' });
}

// Per-bucket cumulative balance: running (apportioned − spent). Apportioned = % of
// that month's net cash flow; spent = outflows reconciled to the bucket's mapped
// sub-categories (BUCKET_SPEND_SUBCATS). Cumulative over the months shown.
function buildBucketBalances(buckets, months) {
    const subNames = {};
    ((typeof allSubCategories !== 'undefined' && allSubCategories) ? allSubCategories : []).forEach(r => { const n = getField(r, SUBCAT.name); if (n) subNames[r.id] = String(n); });
    // Map sub-category name → bucket. The live editor passes explicit `subs` ids per
    // bucket (so unticking a category updates instantly); otherwise read the saved
    // Spend Sub-Categories links, falling back to the built-in defaults.
    // A budgeted category (Money Group = Needs/Wants) can never also drain a pot: it
    // already reduces net cash flow, so draining a bucket too would count it twice.
    // The bucket editor lets any sub-category be ticked, so guard it here rather than
    // trusting the tick.
    //
    // BUCKET_SPEND_SUBCATS wins over the Money Group field, exactly as it does in
    // buildMonthlyCashflow. Both functions must agree on membership or money goes
    // missing: if this file treated a code-listed bucket category as budgeted while
    // buildMonthlyCashflow still excluded it from expenditure, the spend would leave
    // net cash flow untouched AND drain no pot — invisible in both views.
    const mgroups = personalMoneyGroups();
    const budgeted = {};
    Object.keys(mgroups.byName).forEach(n => { if (!mgroups.bucketSubs.has(n)) budgeted[n] = mgroups.byName[n]; });
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
    Object.keys(subToBucket).forEach(n => { if (budgeted[n]) delete subToBucket[n]; });
    const linkId = f => { if (!f) return null; if (Array.isArray(f)) { const x = f[0]; return x && typeof x === 'object' ? x.id : x; } return typeof f === 'object' ? f.id : f; };
    const keys = months.map(m => m.key);
    const keyIdx = {}; keys.forEach((k, i) => keyIdx[k] = i);
    const spent = {}; buckets.forEach(b => spent[b.name] = keys.map(() => 0));
    const txns = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];
    // SIGNED, not outflows-only. A bounced direct debit to a credit card comes back
    // into the cash account as an inflow on the same sub-category, so summing signed
    // amounts cancels the failed payment automatically — no date-window matching, no
    // guessing at bank wording. Refunds on any other bucket cancel the same way.
    // Monthly totals are floored at £0 so a refund-only month cannot ADD to a pot.
    txns.forEach(tx => {
        const amt = Number(getField(tx, F.txReportAmount)) || 0;
        if (!amt) return;
        const dateStr = getField(tx, F.txDate); if (!dateStr) return;
        const d = new Date(dateStr); if (isNaN(d)) return;
        const idx = keyIdx[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`];
        if (idx === undefined) return;
        const bucket = subToBucket[subNames[linkId(getField(tx, F.txSubCategory))] || ''];
        if (bucket && spent[bucket]) spent[bucket][idx] += -amt;
    });

    // ── Credit-card payments: read the CARD side, not just the cash side ─────────
    // A card payment has two legs. The cash-side leg only counts here if someone
    // coded it "Personal Credit Card Transfer", and reconciliation mostly does not:
    // of 84 card payments only 43 carried that tag, so £74,971 of real debt paydown
    // was invisible to the Debt bucket (found 21 Jul 2026 when Kevin noticed his
    // July payments missing).
    //
    // An inflow to a credit-card account IS a payment, by definition — no tagging
    // required. So take the card leg as the source of truth and fall back to the
    // cash leg only where there is no card leg to read, which is exactly the case
    // for cards with no open-banking feed (Barclaycard, NatWest).
    const cardBucket = Object.keys(subToBucket).find(n => n === 'Personal Credit Card Transfer');
    if (cardBucket && spent[subToBucket[cardBucket]]) {
        const bname = subToBucket[cardBucket];
        const cardAliases = new Set(
            ((typeof allAccounts !== 'undefined' && allAccounts) ? allAccounts : [])
                .filter(a => getField(a, F.accNetWorthClass) === 'Credit Card')
                .map(a => String(getField(a, F.accountAlias) || '')).filter(Boolean));
        const aliasOf = tx => { const v = getField(tx, F.txAccountAlias); const x = Array.isArray(v) ? v[0] : v; return String((x && typeof x === 'object') ? x.id : (x || '')); };
        const subOf = tx => subNames[linkId(getField(tx, F.txSubCategory))] || '';
        const dateOf = tx => { const s = getField(tx, F.txDate); const d = s ? new Date(s) : null; return (d && !isNaN(d)) ? d : null; };
        const monthIdx = d => keyIdx[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`];

        // Card leg: signed, so a bounced direct debit returning on the card cancels
        // the payment it reverses (the Lloyds £1,978.70 bounce in May 2026).
        const cardLeg = txns.filter(t => cardAliases.has(aliasOf(t)) && subOf(t) === 'Transfer');
        cardLeg.forEach(t => {
            const d = dateOf(t); if (!d) return;
            const idx = monthIdx(d); if (idx === undefined) return;
            spent[bname][idx] += Number(getField(t, F.txReportAmount)) || 0; // inflow = paydown
        });

        // Remove the cash-side rows already counted above that duplicate a card leg,
        // matched on amount within a week. What survives is payments to cards we
        // cannot see — the only place the cash leg is the sole record.
        // Each card leg can cancel AT MOST ONE cash-side row. Without consuming the
        // match, two same-value payments in the same week to different cards — one fed,
        // one not — would both match the single card leg and both be removed, losing a
        // real payment. Kevin pays several cards on the same day (7 Jul 2026: £100 to
        // Lloyds and £100 to Santander CC), so this is the normal case, not a corner.
        const inflows = cardLeg
            .map(t => ({ amt: Math.round(Math.abs(Number(getField(t, F.txReportAmount)) || 0) * 100), d: dateOf(t), used: false }))
            .filter(x => x.d);
        txns.filter(t => subOf(t) === 'Personal Credit Card Transfer')
            .sort((a, b) => String(getField(a, F.txDate)).localeCompare(String(getField(b, F.txDate))))
            .forEach(t => {
                const d = dateOf(t); if (!d) return;
                const idx = monthIdx(d); if (idx === undefined) return;
                const amt = Number(getField(t, F.txReportAmount)) || 0;
                const cents = Math.round(Math.abs(amt) * 100);
                const match = inflows.find(x => !x.used && x.amt === cents && Math.abs(x.d - d) <= 7 * 864e5);
                if (match) { match.used = true; spent[bname][idx] -= -amt; } // card leg already has it
            });
    }
    const net = buildMonthlyCashflow(keys).map(m => m.net);
    return buckets.map(b => {
        const pct = Number(b.pct) || 0;
        // Monthly amount in is floored at £0: a negative-cash-flow month puts nothing
        // in (it never draws a bucket down), so the figure shows £0, never a negative.
        const appor = net.map(n => Math.max(0, Math.round(n * pct / 100)));
        const sp = (spent[b.name] || keys.map(() => 0)).map(v => Math.round(v));
        // Monthly spend stays SIGNED so a reversal cancels its payment even when the
        // two land in different calendar months — a direct debit taken on the 30th and
        // returned on the 2nd is the common bounce, and flooring per month would keep
        // the payment and silently discard the refund.
        //
        // Both cumulative runs are floored at 0 instead:
        //   · cumulative spend can't go negative, so a refund with no matching spend
        //     cannot conjure money into a pot;
        //   · the pot itself can't display negative.
        //
        // Overspend CARRIES FORWARD: spend £3,000 from a pot holding £400 and the pot
        // reads £0 until later allocations have made the £2,600 back. That is the
        // honest reading — the money really was spent — but it does mean a pot can sit
        // at £0 for months while allocations flow in. The alternative (forgiving the
        // overspend at each month boundary) would show money you have already spent.
        let runIn = 0, runSpent = 0;
        const balance = appor.map((a, i) => {
            runIn += a;
            runSpent = Math.max(0, runSpent + sp[i]);
            return Math.max(0, runIn - runSpent);
        });
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
