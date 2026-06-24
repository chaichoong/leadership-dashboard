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

        ${monthsBehind > 0 ? `<!-- Staleness alert -->
        <div style="background:var(--warning-bg);border:1px solid var(--warning);border-radius:var(--radius-lg);padding:var(--space-4);margin-bottom:var(--space-5);display:flex;gap:12px;align-items:flex-start">
            <span style="font-size:20px;line-height:1.2">⚠️</span>
            <div>
                <div style="font-weight:var(--fw-semibold);color:var(--text-primary);margin-bottom:2px">Your figures are ${monthsBehind} month${monthsBehind === 1 ? '' : 's'} out of date</div>
                <div style="font-size:var(--fs-sm);color:var(--text-secondary)">Latest snapshot is ${escHtml(asOf)}. To bring this up to ${escHtml(currentLabel)}, ${manualItemCount} manual figures need updating: property and business valuations, loan and mortgage balances, and investments. Cash and credit cards update live.</div>
                <button onclick="openWealthUpdate()" style="margin-top:10px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);padding:8px 16px;font-size:var(--fs-sm);font-weight:var(--fw-semibold);cursor:pointer">Update figures for ${escHtml(currentLabel)}</button>
            </div>
        </div>` : ''}

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

        <!-- Income buckets (loaded separately) -->
        <div id="wealthBuckets" style="margin-top:var(--space-5)"></div>

    </div>`;

    // Personal expenditure reads the already-loaded transaction globals (sync).
    renderPersonalExpenditure();
    // Load + render the income buckets section (its own Airtable fetch).
    loadWealthBuckets();
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
        const amt = Math.abs((typeof txDisplayAmount === 'function') ? txDisplayAmount(r) : (Number(getField(r, F.txReportAmount)) || 0));
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
        const cells = r.byMonth.map(v => `<td style="text-align:right;padding:6px 8px;color:${v > 0 ? 'var(--text-primary)' : 'var(--text-muted)'}">${v > 0 ? fmt0(v) : '–'}</td>`).join('');
        // Colour the average vs budget: over = danger, within = success, no budget = neutral.
        const avgColour = r.budget > 0 ? (r.avg > r.budget ? 'var(--danger)' : 'var(--success)') : 'var(--text-primary)';
        const flag = r.budget > 0 ? (r.avg > r.budget ? ` (+${fmt0(r.avg - r.budget)})` : ` (−${fmt0(r.budget - r.avg)})`) : '';
        // Drill-down: the transactions making up this category, biggest first.
        const txnRows = r.txns.slice().sort((a, b) => b.amt - a.amt).map(t => `<tr style="border-top:1px solid var(--border-subtle)">
            <td style="padding:4px 8px;color:var(--text-secondary);white-space:nowrap">${t.d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}</td>
            <td style="padding:4px 8px;color:var(--text-primary)">${escHtml(t.desc)}</td>
            <td style="padding:4px 8px;color:var(--text-muted);white-space:nowrap">${escHtml(t.account)}</td>
            <td style="padding:4px 8px;text-align:right;color:var(--text-primary);white-space:nowrap">${fmt2(t.amt)}</td>
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
            <td style="text-align:right;padding:6px 8px"><span style="color:var(--text-muted)">£</span><input type="number" step="1" min="0" class="pbud" data-budget-id="${escHtml(r.budgetId)}" value="${r.budget || ''}" placeholder="0" style="width:84px;padding:5px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);text-align:right;background:var(--bg-surface)"></td>
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
        <div style="margin-top:14px"><button id="budgetSaveBtn" onclick="saveBudgets()" style="background:var(--accent);color:#fff;border:none;border-radius:var(--radius-md);padding:8px 18px;font-weight:var(--fw-semibold);cursor:pointer">Save budgets</button></div>
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
