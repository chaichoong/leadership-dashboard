// Strategy Plan OS — standalone page (loaded directly or via iframe).
// Depends on: ../../js/config.js (TABLES, OBJSTRAT, BASE_ID), ../../js/prompts/boardroom-mentor.js

const AI_PROXY = 'https://claude-proxy.kevinbrittain.workers.dev';

// Runtime state
let PAT_LOCAL = '';
let allBusinessesLocal = [];
let currentRecord = null;   // Airtable record currently loaded (null if new)
let isDirty = false;
let wizardState = null;     // see wizard.js section below
const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];

function goToDashboard() {
    try {
        if (window.parent && window.parent !== window && typeof window.parent.switchTab === 'function') {
            window.parent.switchTab('overview');
            return;
        }
    } catch (e) { /* cross-origin */ }
    window.location.href = '../../index.html';
}

function authenticate() {
    const input = document.getElementById('patInput').value.trim();
    if (!input) return;
    PAT_LOCAL = input;
    sessionStorage.setItem('_dlr_pat', input);
    localStorage.setItem('airtable_pat', input);
    document.getElementById('authScreen').style.display = 'none';
    initApp();
}

(function init() {
    const saved = localStorage.getItem('airtable_pat') || sessionStorage.getItem('_dlr_pat');
    if (saved) {
        PAT_LOCAL = saved;
        sessionStorage.setItem('_dlr_pat', saved);
        document.getElementById('authScreen').style.display = 'none';
        initApp();
    }
    document.getElementById('patInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') authenticate();
    });
})();

async function airtableFetch(path, options = {}) {
    const url = path.startsWith('http') ? path : `https://api.airtable.com/v0/${BASE_ID}/${path}`;
    const res = await fetch(url, {
        ...options,
        headers: { 'Authorization': `Bearer ${PAT_LOCAL}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`${res.status} ${txt.slice(0, 200)}`);
    }
    return res.json();
}

async function initApp() {
    showLoading(true);
    try {
        await loadBusinesses();
        populateContextBar();
        document.getElementById('app').style.display = 'block';
        await autoSelectLatestRecord();
    } catch (e) {
        setStatus('error', `Failed to load: ${e.message}`);
        document.getElementById('app').style.display = 'block';
    } finally {
        showLoading(false);
    }
}

function showLoading(on) {
    document.getElementById('loadingOverlay').style.display = on ? 'flex' : 'none';
}

function setStatus(kind, message) {
    const el = document.getElementById('statusBar');
    if (!message) { el.style.display = 'none'; return; }
    el.className = 'status-bar ' + kind;
    el.textContent = message;
    el.style.display = 'block';
}

async function loadBusinesses() {
    // Businesses table primary field is "Business Name" (singleLineText).
    // "Business" is a lookup array — avoid it.
    const data = await airtableFetch(`${TABLES.businesses}?pageSize=100`);
    allBusinessesLocal = data.records.map(r => {
        let raw = r.fields['Business Name'] ?? r.fields['Name'] ?? r.fields['Business'];
        if (Array.isArray(raw)) raw = raw.join(', ');
        return { id: r.id, name: raw ? String(raw) : '(unnamed)' };
    });
    allBusinessesLocal.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function populateContextBar() {
    const bsel = document.getElementById('businessSel');
    bsel.innerHTML = '<option value="">Select a business…</option>' +
        allBusinessesLocal.map(b => `<option value="${b.id}">${escapeHtml(b.name)}</option>`).join('');
    bsel.addEventListener('change', onContextChange);

    const ysel = document.getElementById('yearSel');
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let y = currentYear - 1; y <= currentYear + 2; y++) years.push(y);
    ysel.innerHTML = '<option value="">—</option>' + years.map(y => `<option>${y}</option>`).join('');
    ysel.value = String(currentYear);

    document.getElementById('quarterSel').addEventListener('change', onContextChange);
    ysel.addEventListener('change', onContextChange);

    // Set current quarter default
    const m = new Date().getMonth();
    const currentQ = m < 3 ? 'Q1' : m < 6 ? 'Q2' : m < 9 ? 'Q3' : 'Q4';
    document.getElementById('quarterSel').value = currentQ;
}

function getSelection() {
    return {
        businessId: document.getElementById('businessSel').value,
        quarter: document.getElementById('quarterSel').value,
        year: document.getElementById('yearSel').value,
    };
}

async function onContextChange() {
    if (isDirty && !confirm('You have unsaved changes. Discard and load different record?')) return;
    await loadRecord();
}

async function autoSelectLatestRecord() {
    // If no business selected, leave empty state.
    const { businessId } = getSelection();
    if (!businessId) {
        renderEmptyState('Pick a business to begin.');
        return;
    }
    await loadRecord();
}

async function loadRecord() {
    const { businessId, quarter, year } = getSelection();
    if (!businessId) {
        renderEmptyState('Pick a business to begin.');
        return;
    }
    if (!quarter || !year) {
        renderEmptyState('Pick a quarter and year to load the plan.');
        return;
    }
    setStatus('info', 'Loading plan…');
    try {
        // Airtable link fields stringify to primary-field values (business names),
        // not record IDs — so match on the "Business Name" formula field instead.
        const business = allBusinessesLocal.find(b => b.id === businessId);
        const businessName = (business?.name || '').replace(/"/g, '\\"');
        const params = new URLSearchParams({
            filterByFormula: `AND({Business Name} = "${businessName}", {Quarter} = "${quarter}", {Year} = "${year}")`,
            maxRecords: '1',
            returnFieldsByFieldId: 'true',
        });
        const data = await airtableFetch(`${TABLES.objStrat}?${params.toString()}`);
        if (data.records.length) {
            currentRecord = data.records[0];
            renderForm(currentRecord.fields);
            setStatus('success', `Loaded ${quarter} ${year}.`);
            setTimeout(() => setStatus('', ''), 2000);
        } else {
            currentRecord = null;
            renderEmptyState(`No plan yet for ${quarter} ${year}. Start the AI Wizard to build one — it will pull the previous quarter as a starting point.`);
            setStatus('', '');
        }
    } catch (e) {
        setStatus('error', `Load failed: ${e.message}`);
    }
    isDirty = false;
    updateSaveButton();
}

function renderEmptyState(message) {
    const host = document.getElementById('planForm');
    host.innerHTML = `<div class="empty-state">
        <h3>Nothing here yet</h3>
        <p>${escapeHtml(message)}</p>
        <button class="btn btn-primary" onclick="openWizard()">Start AI Wizard</button>
    </div>`;
}

// ═════════════════════════════════════════════════════════════════════
// FORM RENDERING — maps OBJSTRAT field IDs to editable inputs.
// ═════════════════════════════════════════════════════════════════════

function renderForm(fields) {
    fields = fields || {};
    const host = document.getElementById('planForm');
    host.innerHTML = '';

    // Sticky top navigator — anchor links to every section divider/section.
    const nav = document.createElement('div');
    nav.className = 'section-nav';
    nav.innerHTML = `<div class="section-nav-inner">
        <span class="section-nav-label">Jump to</span>
        <a href="#sec-objective">Objective</a>
        <a href="#sec-target-statement">Target</a>
        <a href="#sec-customer-profile">Customer</a>
        <a href="#sec-undertakings">Undertakings</a>
        <a href="#sec-original-selling-points">USPs</a>
        <a href="#sec-main-method-step-by-step">Method</a>
        <a href="#sec-enticement">Enticement</a>
        <span class="section-nav-sep">•</span>
        <a href="#sec-nine-year-target">9-yr</a>
        <a href="#sec-three-year-target">3-yr</a>
        <a href="#sec-one-year-target">1-yr</a>
        <a href="#sec-quarterly-priority-projects">Quarterly</a>
        <span class="section-nav-sep">•</span>
        <a href="#" onclick="toggleAllSections(true); return false;" class="section-nav-action">Expand all</a>
        <a href="#" onclick="toggleAllSections(false); return false;" class="section-nav-action">Collapse all</a>
    </div>`;
    host.appendChild(nav);

    // ────────────────────────────────────────────────────────────────
    // PLAN HEADER — one record, two plans stacked.
    // ────────────────────────────────────────────────────────────────
    host.appendChild(planDivider('📜 Objective Plan',
        'Why the business exists. Reviewed annually, tweaked quarterly. All fields below share this single Airtable record with the Strategy Plan.'));

    // Objective statement
    host.appendChild(richSection({
        icon: '🚀', title: 'Objective',
        hint: 'The overarching objective of the business.',
        children: [
            textareaField('Objective', OBJSTRAT.objective, fields[OBJSTRAT.objective] || '', 'large'),
        ],
    }));

    // Target Statement — What / Who / How
    host.appendChild(richSection({
        icon: '🎯', title: 'Target Statement',
        hint: 'What we do, who we do it for, and how we do it.',
        children: [
            gridOf([
                textareaField('What we do', OBJSTRAT.targetWhat, fields[OBJSTRAT.targetWhat] || ''),
                textareaField('Who we do it for', OBJSTRAT.targetWho, fields[OBJSTRAT.targetWho] || ''),
                textareaField('How we do it', OBJSTRAT.targetHow, fields[OBJSTRAT.targetHow] || ''),
            ]),
        ],
    }));

    // Customer Profile
    host.appendChild(richSection({
        icon: '👤', title: 'Customer Profile',
        hint: 'Who is our target market?',
        children: [
            textareaField('Customer Profile', OBJSTRAT.customerProfile, fields[OBJSTRAT.customerProfile] || '', 'large'),
        ],
    }));

    // Undertakings 1-20 (rules of play)
    host.appendChild(richSection({
        icon: '🤝', title: 'Undertakings',
        hint: 'The rules that we all follow within the business. Leave blanks empty — 20 slots.',
        children: [undertakingsGrid(fields)],
    }));

    // USPs 1-5
    host.appendChild(richSection({
        icon: '⭐', title: 'Original Selling Points',
        hint: 'What differentiates us from competitors? Up to five.',
        children: [
            uspsGrid(fields),
        ],
    }));

    // Main Method steps 1-10
    host.appendChild(richSection({
        icon: '🧩', title: 'Main Method (Step-by-Step)',
        hint: 'The proven process or secret recipe — what the business does, in sequential steps. Up to 10.',
        children: [
            methodStepsGrid(fields),
        ],
    }));

    // Enticement
    host.appendChild(richSection({
        icon: '✨', title: 'Enticement',
        hint: 'What is our offer that the target market cannot refuse?',
        children: [
            textareaField('Enticement', OBJSTRAT.enticement, fields[OBJSTRAT.enticement] || '', 'large'),
        ],
    }));

    // ────────────────────────────────────────────────────────────────
    // STRATEGY PLAN — the quarterly half.
    // ────────────────────────────────────────────────────────────────
    host.appendChild(planDivider('🎯 Strategy Plan',
        'How the business wins this quarter. Iterated every 90 days. Quarterly projects feed into Projects OS; monthly stones feed into Tasks OS.'));

    // Nine-Year Target
    host.appendChild(richSection({
        icon: '🎯', title: 'Nine-Year Target',
        hint: 'Paint the picture of what the business will look like in nine years, as specific as possible so it can be visualised.',
        children: [
            textareaField('Vision', OBJSTRAT.nineYearTarget, fields[OBJSTRAT.nineYearTarget] || '', 'large'),
        ],
    }));

    // Three-Year Target
    host.appendChild(richSection({
        icon: '🏆', title: 'Three-Year Target',
        hint: 'What will the business look like in three years? Include up to three measurables.',
        children: [
            textareaField('Target', OBJSTRAT.threeYearTarget, fields[OBJSTRAT.threeYearTarget] || '', 'large'),
            gridOf(OBJSTRAT.threeYearMeas.map((fid, i) =>
                textareaField(`Three-Year Measurable ${i + 1}`, fid, fields[fid] || ''))),
        ],
    }));

    // One-Year Target
    host.appendChild(richSection({
        icon: '🥇', title: 'One-Year Target',
        hint: 'What will the business look like in one year? Include up to three measurables.',
        children: [
            textareaField('Target', OBJSTRAT.oneYearTarget, fields[OBJSTRAT.oneYearTarget] || '', 'large'),
            gridOf(OBJSTRAT.oneYearMeas.map((fid, i) =>
                textareaField(`One-Year Measurable ${i + 1}`, fid, fields[fid] || ''))),
        ],
    }));

    // Quarterly Projects + Monthly Stepping Stones (same collapsible pattern)
    const qpSection = document.createElement('details');
    qpSection.className = 'section';
    qpSection.id = 'sec-quarterly-priority-projects';
    // Open by default if any quarterly project text exists
    const qpHasContent = OBJSTRAT.quarterlyProjects.some(fid => (fields[fid] || '').trim());
    qpSection.open = qpHasContent;
    qpSection.innerHTML = `<summary><span class="section-title-row"><span class="section-title">💼 Quarterly Priority Projects</span><span class="section-chevron">▾</span></span></summary>
        <div class="section-body"><span class="section-sub">The three most important goals for the next 90 days. Each project breaks down into 3 monthly stepping stones.</span></div>`;

    const qpGrid = document.createElement('div');
    qpGrid.className = 'grid-cols-3';
    for (let i = 0; i < 3; i++) {
        const qpFid = OBJSTRAT.quarterlyProjects[i];
        const stones = OBJSTRAT.monthlyStones[i];
        const card = document.createElement('div');
        card.className = 'qp-card';
        card.innerHTML = `<h4>⭐ Quarterly Project ${i + 1}</h4>`;
        card.appendChild(textareaField(`Project`, qpFid, fields[qpFid] || ''));

        const stonesWrap = document.createElement('div');
        stonesWrap.className = 'qp-stones';
        const stonesHead = document.createElement('div');
        stonesHead.style.cssText = 'font-size:11px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-top:4px;';
        stonesHead.textContent = 'Monthly Stepping Stones';
        stonesWrap.appendChild(stonesHead);

        stones.forEach((stoneFid, m) => {
            const row = document.createElement('div');
            row.className = 'stone';
            const label = document.createElement('span');
            label.className = 'm-label';
            label.textContent = `M${m + 1}`;
            const ta = document.createElement('textarea');
            ta.dataset.fieldId = stoneFid;
            ta.value = fields[stoneFid] || '';
            ta.placeholder = `Month ${m + 1} deliverable`;
            ta.rows = 1;
            ta.addEventListener('input', () => {
                markDirty(); autosize(ta); equaliseQuarterlyProjects();
            });
            row.appendChild(label);
            row.appendChild(ta);
            stonesWrap.appendChild(row);
        });
        card.appendChild(stonesWrap);
        qpGrid.appendChild(card);
    }
    qpSection.querySelector('.section-body').appendChild(qpGrid);
    host.appendChild(qpSection);

    // Auto-size every textarea to its content. Two passes — the first settles
    // natural heights, the second captures any shifts (fonts loading, etc.).
    setTimeout(autosizeAll, 0);
    setTimeout(autosizeAll, 120);

    // Attach "✨ Revise with AI" buttons to every field with a matching wizard step.
    attachReviseAffordances();

    // When a section is toggled open, its textareas couldn't be measured while
    // it was closed. Re-run the full equalise pass so rows inside it match.
    document.querySelectorAll('.plan-form details.section').forEach(d => {
        d.addEventListener('toggle', () => {
            if (d.open) {
                setTimeout(() => {
                    d.querySelectorAll('textarea').forEach(autosize);
                    equaliseAllCardRows();
                    equaliseAllGridRows();
                }, 0);
            }
        });
    });
}

// Called from the section nav "Expand all" / "Collapse all" links.
function toggleAllSections(openAll) {
    document.querySelectorAll('.plan-form details.section').forEach(d => { d.open = !!openAll; });
    if (openAll) {
        setTimeout(autosizeAll, 0);
        setTimeout(autosizeAll, 120);
    }
}

// Re-equalise on window resize (column count may change, breaking row groupings).
window.addEventListener('resize', () => {
    clearTimeout(window.__strategyResizeT);
    window.__strategyResizeT = setTimeout(autosizeAll, 150);
});

// Helpers for form building

function planDivider(title, sub) {
    const d = document.createElement('div');
    d.className = 'plan-divider';
    d.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(sub)}</p>`;
    return d;
}

function undertakingsGrid(fields) {
    // Numbered cards in a responsive grid. Multi-line content — use textareas.
    return cardGrid(OBJSTRAT.undertakings.map((fid, i) => numberedCard({
        number: i + 1, fieldId: fid, value: fields[fid] || '',
        placeholder: 'Undertaking text…',
    })), { minColWidth: 260 });
}

function uspsGrid(fields) {
    // 5 USPs — slightly wider cards look best.
    return cardGrid(OBJSTRAT.usps.map((fid, i) => numberedCard({
        number: i + 1, fieldId: fid, value: fields[fid] || '',
        placeholder: 'USP text…',
    })), { minColWidth: 300 });
}

function methodStepsGrid(fields) {
    // 10 method steps.
    return cardGrid(OBJSTRAT.methodSteps.map((fid, i) => numberedCard({
        number: i + 1, fieldId: fid, value: fields[fid] || '',
        placeholder: 'Step text…',
    })), { minColWidth: 280 });
}

// Build a responsive card grid. CSS Grid auto-fills columns; all items in the
// same visual row end up the same height via CSS align-items: stretch + the
// equaliseRowHeights() pass in autosizeAll.
function cardGrid(cards, opts = {}) {
    const g = document.createElement('div');
    g.className = 'card-grid';
    g.style.gridTemplateColumns = `repeat(auto-fill, minmax(${opts.minColWidth || 280}px, 1fr))`;
    cards.forEach(c => g.appendChild(c));
    return g;
}

function numberedCard({ number, fieldId, value, placeholder }) {
    const card = document.createElement('div');
    card.className = 'num-card';
    if (!value) card.classList.add('is-empty');
    card.innerHTML = `<div class="num-badge">${String(number).padStart(2, '0')}</div>`;
    const ta = document.createElement('textarea');
    ta.dataset.fieldId = fieldId;
    ta.value = value || '';
    ta.placeholder = placeholder || '';
    ta.rows = 1;
    ta.addEventListener('input', () => {
        markDirty(); autosize(ta);
        card.classList.toggle('is-empty', !ta.value.trim());
        equaliseCardRow(card);
    });
    card.appendChild(ta);
    // Click anywhere on the card (badge / padding / empty area) focuses the
    // textarea and drops the cursor at the end.
    card.addEventListener('click', e => {
        if (e.target === ta || e.target.classList?.contains('revise-btn')) return;
        ta.focus();
        const len = ta.value.length;
        try { ta.setSelectionRange(len, len); } catch (err) {}
    });
    return card;
}

function singleLineField(label, fieldId, value) {
    const row = document.createElement('div');
    row.className = 'field-row';
    const lab = document.createElement('label');
    lab.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.fieldId = fieldId;
    input.value = value || '';
    input.addEventListener('input', () => markDirty());
    row.appendChild(lab);
    row.appendChild(input);
    return row;
}

function richSection({ icon, title, hint, children }) {
    // Each section is a <details> so it can be folded.
    // Default: open if any field inside has content, otherwise closed.
    const d = document.createElement('details');
    d.className = 'section';
    d.open = childrenHaveContent(children);

    const summary = document.createElement('summary');
    summary.innerHTML = `<span class="section-title-row"><span class="section-title">${icon ? escapeHtml(icon) + ' ' : ''}${escapeHtml(title)}</span><span class="section-chevron">▾</span></span>`;
    d.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'section-body';
    if (hint) {
        const sub = document.createElement('span');
        sub.className = 'section-sub';
        sub.textContent = hint;
        body.appendChild(sub);
    }
    children.forEach(c => body.appendChild(c));
    d.appendChild(body);

    // Give each section an id for nav anchoring
    d.id = 'sec-' + slugify(title);
    return d;
}

function childrenHaveContent(children) {
    for (const c of children) {
        if (!c) continue;
        const fields = c.querySelectorAll ? c.querySelectorAll('[data-field-id]') : [];
        for (const f of fields) if (f.value && String(f.value).trim()) return true;
    }
    return false;
}

function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function textareaField(label, fieldId, value, sizeClass) {
    const row = document.createElement('div');
    row.className = 'field-row';
    const lab = document.createElement('label');
    lab.textContent = label;
    const ta = document.createElement('textarea');
    ta.dataset.fieldId = fieldId;
    ta.value = value || '';
    if (sizeClass) ta.className = sizeClass;
    ta.rows = 1;
    ta.addEventListener('input', () => {
        markDirty(); autosize(ta);
        // If this textarea is inside a multi-column grid, re-equalise the row
        // so its column-mates grow to match.
        if (row.parentElement?.classList.contains('grid-cols-2') ||
            row.parentElement?.classList.contains('grid-cols-3')) {
            equaliseFieldRow(ta);
        }
        // If it's inside a Quarterly Project card, match the 3 Project
        // textareas and keep the stepping stones aligned below.
        if (row.closest('.qp-card')) equaliseQuarterlyProjects();
    });
    row.appendChild(lab);
    row.appendChild(ta);
    return row;
    // Initial sizing handled by autosizeAll() at the end of renderForm.
}

// Grow a textarea to fit its content. No cap — if content is long, the textarea
// is long. Clipping content is never acceptable.
function autosize(ta) {
    if (!ta) return;
    // Clear any min-height set by row-equalize so we measure natural height.
    ta.style.minHeight = '';
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + 2) + 'px';
}

// Re-size every textarea on the page, then equalise heights within each
// visual row so grids look symmetric.
function autosizeAll() {
    document.querySelectorAll('.plan-form textarea').forEach(autosize);
    // Measurement is only correct once layout settles — run equalize in a
    // second pass to catch any shifts from the first one.
    equaliseAllCardRows();
    equaliseAllGridRows();
    equaliseQuarterlyProjects();
}

// Lines up the 3 Quarterly Project columns: the Project description textarea
// matches across columns, then M1 across, M2 across, M3 across. That way the
// stepping stones in each card sit at the same y-position.
function equaliseQuarterlyProjects() {
    const cards = document.querySelectorAll('.qp-card');
    if (cards.length !== 3) return;
    const projectTAs = Array.from(cards).map(c => c.querySelector('.field-row textarea')).filter(Boolean);
    equaliseTextareas(projectTAs);
    for (let m = 0; m < 3; m++) {
        const stoneTAs = Array.from(cards).map(c => c.querySelectorAll('.stone textarea')[m]).filter(Boolean);
        equaliseTextareas(stoneTAs);
    }
}

function equaliseTextareas(tas) {
    if (tas.length < 2) return;
    tas.forEach(t => { t.style.minHeight = ''; autosize(t); });
    const max = Math.max(...tas.map(t => t.offsetHeight));
    tas.forEach(t => { t.style.minHeight = max + 'px'; });
}

// Group cards within one .card-grid by their offsetTop (visual row) and set
// every textarea's min-height in that row to the tallest natural height.
// Using min-height (not height) means symmetry never clips long content —
// a cell taller than its neighbours wins, shorter ones match up to it.
function equaliseAllCardRows() {
    document.querySelectorAll('.card-grid').forEach(grid => {
        const cards = Array.from(grid.querySelectorAll('.num-card'));
        if (!cards.length) return;
        // Reset min-heights so measurements are natural.
        cards.forEach(c => { const t = c.querySelector('textarea'); if (t) t.style.minHeight = ''; });
        // Re-autosize in case something was pending.
        cards.forEach(c => { const t = c.querySelector('textarea'); if (t) autosize(t); });
        const rows = groupByTop(cards);
        rows.forEach(row => {
            const tas = row.map(c => c.querySelector('textarea')).filter(Boolean);
            if (tas.length < 2) return;
            const max = Math.max(...tas.map(t => t.offsetHeight));
            tas.forEach(t => { t.style.minHeight = max + 'px'; });
        });
    });
}

// Same pattern for the 3-col grids (Target Statement, Measurables).
function equaliseAllGridRows() {
    document.querySelectorAll('.grid-cols-2, .grid-cols-3').forEach(grid => {
        const rows = Array.from(grid.querySelectorAll('.field-row'));
        if (rows.length < 2) return;
        // Reset, re-measure, then equalise.
        rows.forEach(r => { const t = r.querySelector('textarea'); if (t) { t.style.minHeight = ''; autosize(t); } });
        const groups = groupByTop(rows);
        groups.forEach(group => {
            const tas = group.map(r => r.querySelector('textarea')).filter(Boolean);
            if (tas.length < 2) return;
            const max = Math.max(...tas.map(t => t.offsetHeight));
            tas.forEach(t => { t.style.minHeight = max + 'px'; });
        });
    });
}

// Equalise one row — called from the input handler so typing grows row-mates.
function equaliseCardRow(card) {
    const grid = card.closest('.card-grid');
    if (!grid) return;
    const top = card.offsetTop;
    const row = Array.from(grid.querySelectorAll('.num-card')).filter(c => c.offsetTop === top);
    const tas = row.map(c => c.querySelector('textarea')).filter(Boolean);
    if (tas.length < 2) return;
    tas.forEach(t => { t.style.minHeight = ''; autosize(t); });
    const max = Math.max(...tas.map(t => t.offsetHeight));
    tas.forEach(t => { t.style.minHeight = max + 'px'; });
}

// Called when any textarea outside a card grid grows/shrinks (e.g. Target
// Statement, Measurables). Re-runs row-equalize across all 2/3-col grids.
function equaliseFieldRow(ta) {
    // Cheap enough to just re-do all grid rows — there are only a handful.
    equaliseAllGridRows();
}

function groupByTop(els) {
    const byTop = new Map();
    els.forEach(el => {
        const key = el.offsetTop;
        if (!byTop.has(key)) byTop.set(key, []);
        byTop.get(key).push(el);
    });
    return Array.from(byTop.values());
}

function gridOf(children) {
    const g = document.createElement('div');
    g.className = 'grid-cols-3';
    children.forEach(c => g.appendChild(c));
    return g;
}

function markDirty() {
    isDirty = true;
    updateSaveButton();
}

function updateSaveButton() {
    document.getElementById('saveBtn').disabled = !isDirty;
}

// ═════════════════════════════════════════════════════════════════════
// SAVE — collects field values and upserts to Airtable.
// ═════════════════════════════════════════════════════════════════════

async function saveRecord() {
    const { businessId, quarter, year } = getSelection();
    if (!businessId || !quarter || !year) {
        setStatus('warn', 'Pick a business, quarter and year before saving.');
        return;
    }
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    setStatus('info', 'Saving…');

    // Collect values from all inputs/textareas with data-field-id
    const fields = {};
    document.querySelectorAll('[data-field-id]').forEach(el => {
        const fid = el.dataset.fieldId;
        const v = el.value.trim();
        fields[fid] = v;
    });

    // Quarter/year/business are always required
    fields[OBJSTRAT.quarter] = quarter;
    fields[OBJSTRAT.year] = year;
    fields[OBJSTRAT.business] = [businessId];

    try {
        if (currentRecord) {
            // Update
            const res = await airtableFetch(`${TABLES.objStrat}/${currentRecord.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ fields, typecast: true }),
            });
            currentRecord = res;
        } else {
            // Create
            const res = await airtableFetch(TABLES.objStrat, {
                method: 'POST',
                body: JSON.stringify({ fields, typecast: true }),
            });
            currentRecord = res;
        }
        isDirty = false;
        setStatus('success', `Saved ${quarter} ${year}.`);
        setTimeout(() => setStatus('', ''), 2500);
    } catch (e) {
        setStatus('error', `Save failed: ${e.message}`);
    } finally {
        updateSaveButton();
    }
}

// ═════════════════════════════════════════════════════════════════════
// AI WIZARD — Boardroom Mentor voice, section-by-section interview.
// Challenges weak answers, pulls previous quarter as context.
// ═════════════════════════════════════════════════════════════════════

const WIZARD_STEPS = [
    // ── Objective plan (top of the form — reviewed rarely, but important to
    //    set the frame before anything below it.)
    { id: 'reflection', label: 'Quarterly reflection', needsPrior: true,
      ask: "Looking back at last quarter: what hit, what missed, and why?\n\nI'll use this to calibrate the bar for this quarter — specifically to make sure what slipped becomes a measurable here. One paragraph is plenty.",
      targetFid: null /* discovery — not saved */ },
    { id: 'objective', label: 'Objective', targetFid: () => OBJSTRAT.objective,
      ask: "The Objective is the single overarching statement of what this business exists to do. It sits at the top of the plan and every quarterly project should ladder back to it.\n\nAim for one tight paragraph covering:\n• What the business ultimately produces (an outcome, not an activity)\n• Who benefits\n• Why it matters\n\nExample shape: 'To [verb] [what] for [who], so that [outcome the world looks like].'" },
    { id: 'targetWhat', label: 'Target — What we do', targetFid: () => OBJSTRAT.targetWhat,
      ask: "Target Statement, part 1 of 3: WHAT we do.\n\nOne sentence describing the product or service in plain language. No marketing adjectives unless they're doing real work. If a stranger couldn't repeat it back, it's too vague." },
    { id: 'targetWho', label: 'Target — Who we do it for', targetFid: () => OBJSTRAT.targetWho,
      ask: "Target Statement, part 2 of 3: WHO we do it for.\n\nOne sentence naming the specific target customer — segment, size, stage, and what makes them the ideal fit. 'Small businesses' is too vague; 'UK founder-owned businesses doing £100k–£5m, with one decision-maker' is sharp." },
    { id: 'targetHow', label: 'Target — How we do it', targetFid: () => OBJSTRAT.targetHow,
      ask: "Target Statement, part 3 of 3: HOW we do it.\n\nOne sentence on your distinctive method — what's different about the way you deliver vs. anyone else a customer could buy from?" },
    { id: 'customerProfile', label: 'Customer Profile', targetFid: () => OBJSTRAT.customerProfile,
      ask: "The detailed ideal customer profile — who you target and who you DON'T.\n\nBullets are ideal. Cover:\n• Stage / size / revenue band\n• Budget reality (cash-pay, equity-pay, both?)\n• Mindset (what they believe, what they're tired of)\n• Deal-breakers — who you refuse to take on and why\n\nThe sharper the 'not us' list, the less time you waste on bad-fit leads." },
    { id: 'enticement', label: 'Enticement', targetFid: () => OBJSTRAT.enticement,
      ask: "The Enticement — the irresistible offer your target market cannot refuse.\n\nOne paragraph. What specifically makes it hard to say no? Pricing structure, risk reversal, outcome guarantee, turnaround, access — whatever your asymmetric advantage is." },
    // ── List sections — one question each that gathers the whole list.
    { id: 'undertakings', kind: 'list', label: 'Undertakings (team rules)', fieldIdsFn: () => OBJSTRAT.undertakings, maxItems: 20,
      ask: "The Undertakings are the shared rules that every team member (and AI agent) follows day-to-day — your non-negotiables.\n\nExamples of good ones: 'Own the outcome — you deliver on time and to standard', 'Tell the truth even when uncomfortable', 'Never raise a problem without a proposed solution'.\n\nIf this is your first time: give me 10–15 rules in plain English, one per line. I'll tidy and number them.\n\nIf you already have some: tell me what to add, reword or remove — e.g. 'add one about routine discipline', 'reword #3 to say X', 'no changes'.",
      descriptionForAI: "A list of non-negotiable team/culture rules for the business. Short title + 2–3 supporting bullets each." },
    { id: 'usps', kind: 'list', label: 'Original Selling Points (USPs)', fieldIdsFn: () => OBJSTRAT.usps, maxItems: 5,
      ask: "The Original Selling Points — why a customer chooses you over any alternative.\n\nUp to 5. Each should be a genuine, defensible differentiator (not marketing fluff). Name the advantage, then explain why it's true.\n\nIf first-time: give me as many as come to mind, I'll structure them.\n\nIf existing: say what to change, e.g. 'add one about our equity model', 'tighten #2', 'no changes'.",
      descriptionForAI: "Unique selling points. Each item: a bold claim + a short paragraph backing it up." },
    { id: 'mainMethod', kind: 'list', label: 'Main Method (step-by-step process)', fieldIdsFn: () => OBJSTRAT.methodSteps, maxItems: 10,
      ask: "The Main Method — the proven process the business follows to deliver its outcome, step by step. Up to 10 steps.\n\nThink of it as the 'secret recipe' — the sequence a client moves through, or the way you systematically build the work. A well-known example is EOS's 'Vision / People / Data / Issues / Process / Traction', or your existing OPTIMISE framework.\n\nIf first-time: list the steps in order, one per line, with a short description each.\n\nIf existing: say what to change — e.g. 'add a step between 3 and 4 for X', 'reword step 5', 'no changes'.",
      descriptionForAI: "Sequential steps of the main delivery method. Each item: a short step name + a one-sentence explanation." },
    // ── Strategy plan (quarterly cadence — where most of the iteration happens.)
    { id: 'nineYear', label: 'Nine-Year Target', targetFid: () => OBJSTRAT.nineYearTarget,
      ask: 'Paint the nine-year picture of this business. Be specific and visual — what does it look like, sound like, count like? If it is vague I will push back.' },
    { id: 'threeYear', label: 'Three-Year Target', targetFid: () => OBJSTRAT.threeYearTarget,
      ask: 'What does the business look like in three years? Include size, structure, income, and delivery model. I will then ask you for three measurables separately.' },
    { id: 'threeYearM1', label: 'Three-Year Measurable 1', targetFid: () => OBJSTRAT.threeYearMeas[0],
      ask: 'Three-Year Measurable 1 — one concrete, numeric measurable. Net profit, revenue, occupancy rate, count of something. Target, how you measure it, formula if relevant.' },
    { id: 'threeYearM2', label: 'Three-Year Measurable 2', targetFid: () => OBJSTRAT.threeYearMeas[1],
      ask: 'Three-Year Measurable 2 — a different dimension. If M1 was money, this should be a systems/operations measurable, or vice versa.' },
    { id: 'threeYearM3', label: 'Three-Year Measurable 3', targetFid: () => OBJSTRAT.threeYearMeas[2],
      ask: 'Three-Year Measurable 3 — optional. If you do not have a distinct third, say "skip".' },
    { id: 'oneYear', label: 'One-Year Target', targetFid: () => OBJSTRAT.oneYearTarget,
      ask: 'One-year picture. What does the business look like in twelve months? Must be a plausible stepping stone to the three-year target, not a wish.' },
    { id: 'oneYearM1', label: 'One-Year Measurable 1', targetFid: () => OBJSTRAT.oneYearMeas[0],
      ask: 'One-Year Measurable 1 — numeric, tracked monthly. What and how measured?' },
    { id: 'oneYearM2', label: 'One-Year Measurable 2', targetFid: () => OBJSTRAT.oneYearMeas[1],
      ask: 'One-Year Measurable 2.' },
    { id: 'oneYearM3', label: 'One-Year Measurable 3', targetFid: () => OBJSTRAT.oneYearMeas[2],
      ask: 'One-Year Measurable 3 (optional).' },
    { id: 'qp1', label: 'Quarterly Project 1', targetFid: () => OBJSTRAT.quarterlyProjects[0],
      ask: 'Quarterly Project 1 — the single most important 90-day project. Name + focus + what "done" looks like. The one that, if it slips, the quarter is a write-off.' },
    { id: 'qp1m1', label: 'QP1 — Month 1', targetFid: () => OBJSTRAT.monthlyStones[0][0],
      ask: 'QP1 — Month 1 stepping stone. A concrete deliverable by end of month 1. If it is not testable/visible, rewrite.' },
    { id: 'qp1m2', label: 'QP1 — Month 2', targetFid: () => OBJSTRAT.monthlyStones[0][1], ask: 'QP1 — Month 2 stepping stone.' },
    { id: 'qp1m3', label: 'QP1 — Month 3', targetFid: () => OBJSTRAT.monthlyStones[0][2], ask: 'QP1 — Month 3 stepping stone (project complete state).' },
    { id: 'qp2', label: 'Quarterly Project 2', targetFid: () => OBJSTRAT.quarterlyProjects[1],
      ask: 'Quarterly Project 2. Different dimension from QP1 — do not duplicate.' },
    { id: 'qp2m1', label: 'QP2 — Month 1', targetFid: () => OBJSTRAT.monthlyStones[1][0], ask: 'QP2 — Month 1 stepping stone.' },
    { id: 'qp2m2', label: 'QP2 — Month 2', targetFid: () => OBJSTRAT.monthlyStones[1][1], ask: 'QP2 — Month 2 stepping stone.' },
    { id: 'qp2m3', label: 'QP2 — Month 3', targetFid: () => OBJSTRAT.monthlyStones[1][2], ask: 'QP2 — Month 3 stepping stone.' },
    { id: 'qp3', label: 'Quarterly Project 3', targetFid: () => OBJSTRAT.quarterlyProjects[2],
      ask: 'Quarterly Project 3. Optional — "skip" is a valid answer. Better three focused than four diluted.' },
    { id: 'qp3m1', label: 'QP3 — Month 1', targetFid: () => OBJSTRAT.monthlyStones[2][0], ask: 'QP3 — Month 1 (skip if no QP3).' },
    { id: 'qp3m2', label: 'QP3 — Month 2', targetFid: () => OBJSTRAT.monthlyStones[2][1], ask: 'QP3 — Month 2.' },
    { id: 'qp3m3', label: 'QP3 — Month 3', targetFid: () => OBJSTRAT.monthlyStones[2][2], ask: 'QP3 — Month 3.' },
];

// Max number of pushbacks the mentor is allowed per step before auto-accepting.
// Without this, a stubborn answer can loop forever.
const MAX_PUSHBACKS_PER_STEP = 2;

// localStorage key for a wizard session, scoped to business × quarter × year.
function wizSessionKey() {
    const { businessId, quarter, year } = getSelection();
    return `ostrat:wizard:${businessId}:${quarter}:${year}`;
}

// Save everything we'd need to resume a wizard — but NOT the DOM elements or
// the full Airtable prior record (we re-fetch that on resume).
function persistWizardState() {
    if (!wizardState) return;
    try {
        localStorage.setItem(wizSessionKey(), JSON.stringify({
            stepIndex: wizardState.stepIndex,
            answers: wizardState.answers,
            reflection: wizardState.reflection || '',
            pushbackCount: wizardState.pushbackCount,
            stepHistory: wizardState.stepHistory,
            visibleMessages: wizardState.visibleMessages || [],
            focusStepId: wizardState.focusStepId || null,
            savedAt: Date.now(),
        }));
    } catch (e) { /* quota or disabled */ }
}

function clearWizardSession() {
    try { localStorage.removeItem(wizSessionKey()); } catch (e) {}
}

function openWizard(opts = {}) {
    const { businessId, quarter, year } = getSelection();
    if (!businessId || !quarter || !year) {
        setStatus('warn', 'Pick a business, quarter and year first.');
        return;
    }
    // Spot-edit: { focusStepId } jumps the wizard straight to one step.
    const focusStepId = opts.focusStepId || null;

    // Try to resume a saved session for this business/quarter/year.
    let saved = null;
    try {
        const raw = localStorage.getItem(wizSessionKey());
        if (raw) saved = JSON.parse(raw);
    } catch (e) {}

    wizardState = {
        stepIndex: 0,
        answers: saved?.answers || {},
        priorRecord: null,
        businessName: allBusinessesLocal.find(b => b.id === businessId)?.name || '',
        stepHistory: [],
        pushbackCount: 0,
        reflection: saved?.reflection || '',
        visibleMessages: [],
        focusStepId,
    };

    document.getElementById('wizardPanel').style.display = 'flex';
    document.querySelector('.layout').classList.add('with-wizard');
    document.getElementById('wizMessages').innerHTML = '';

    if (focusStepId) {
        // Spot-edit — jump to one step only.
        const idx = WIZARD_STEPS.findIndex(s => s.id === focusStepId);
        wizardState.stepIndex = idx >= 0 ? idx : 0;
        appendWizMessage('system', `Spot-edit mode — working on a single question. Hit ✕ when done.`);
        loadPriorQuarter().then(() => askCurrentStep());
        return;
    }

    if (saved && saved.visibleMessages?.length && typeof saved.stepIndex === 'number') {
        // Resume — replay messages and pick up where we left off.
        wizardState.stepIndex = saved.stepIndex;
        wizardState.stepHistory = saved.stepHistory || [];
        wizardState.pushbackCount = saved.pushbackCount || 0;
        saved.visibleMessages.forEach(m => appendWizMessage(m.role, m.content, { skipPersist: true }));
        appendWizMessage('system', `↻ Resumed from ${new Date(saved.savedAt).toLocaleTimeString()}. Step ${wizardState.stepIndex + 1}/${WIZARD_STEPS.length}. Reset session? Click 'Start over' below.`);
        addResetButton();
        loadPriorQuarter();
        return;
    }

    // Fresh wizard.
    appendWizMessage('system', "Boardroom Mentor. UK English, direct, analytical. I'll challenge vague answers once or twice — after that I accept and move on. Use '← Back' to revise a previous answer, 'Move on →' to skip, or ✕ to close.");
    loadPriorQuarter().then(() => askCurrentStep());
}

function addResetButton() {
    // Add a one-shot "Start over" action under the last system message.
    const host = document.getElementById('wizMessages');
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost';
    btn.style.cssText = 'align-self:center;font-size:11px;padding:4px 10px';
    btn.textContent = 'Start over';
    btn.onclick = () => {
        if (!confirm('Discard the current session and start the wizard from scratch?')) return;
        clearWizardSession();
        closeWizard();
        setTimeout(() => openWizard(), 50);
    };
    host.appendChild(btn);
    host.scrollTop = host.scrollHeight;
}

async function loadPriorQuarter() {
    const { businessId, quarter, year } = getSelection();
    const qIdx = QUARTERS.indexOf(quarter);
    const priorQ = qIdx > 0 ? QUARTERS[qIdx - 1] : 'Q4';
    const priorY = qIdx > 0 ? year : String(parseInt(year, 10) - 1);
    try {
        const business = allBusinessesLocal.find(b => b.id === businessId);
        const businessName = (business?.name || '').replace(/"/g, '\\"');
        const params = new URLSearchParams({
            filterByFormula: `AND({Business Name} = "${businessName}", {Quarter} = "${priorQ}", {Year} = "${priorY}")`,
            maxRecords: '1',
            returnFieldsByFieldId: 'true',
        });
        const data = await airtableFetch(`${TABLES.objStrat}?${params.toString()}`);
        if (data.records.length) {
            wizardState.priorRecord = data.records[0];
            appendWizMessage('system', `Prior quarter loaded: ${priorQ} ${priorY}. I will reference it where useful.`);

            // If no record exists for the current quarter yet, pre-fill the form
            // with the prior quarter's values so the user can iterate on them rather
            // than starting blank. Only touch fields that are currently empty.
            if (!currentRecord) {
                const priorFields = wizardState.priorRecord.fields || {};
                renderForm(priorFields);
                markDirty();
                appendWizMessage('system', `Form pre-filled from ${priorQ} ${priorY}. I'll walk through each section so we can iterate.`);
            }
        } else {
            appendWizMessage('system', `No prior quarter found (${priorQ} ${priorY}). Starting fresh.`);
        }
    } catch (e) { /* silent */ }
}

function closeWizard(opts = {}) {
    if (!wizardState) { hideWizardUI(); return; }
    // Closing always keeps the session in localStorage — reopen picks up
    // exactly where we left off. Pass keepSession:false to fully reset.
    if (opts.keepSession === false) clearWizardSession();
    wizardState = null;
    hideWizardUI();
}

function hideWizardUI() {
    document.getElementById('wizardPanel').style.display = 'none';
    document.querySelector('.layout').classList.remove('with-wizard');
}

function currentStep() {
    if (!wizardState) return null;
    const step = WIZARD_STEPS[wizardState.stepIndex];
    if (step && step.needsPrior && !wizardState.priorRecord) {
        wizardState.stepIndex++;
        return currentStep();
    }
    return step;
}

function askCurrentStep() {
    const step = currentStep();
    document.getElementById('wizStepLabel').textContent = step ? `Step ${wizardState.stepIndex + 1} of ${WIZARD_STEPS.length} · ${step.label}` : 'Complete';
    if (!step) return finaliseWizard();
    // Reset per-step critique history — new step starts with no memory of the old one.
    wizardState.stepHistory = [];
    wizardState.pushbackCount = 0;
    appendWizMessage('assistant', step.ask);

    // List step: show the current list so the user can reference it when asking
    // for changes. Falls through to the generic "Currently:" block below for
    // single-field steps.
    if (step.kind === 'list') {
        const fids = step.fieldIdsFn();
        const items = fids.map(fid => currentValueForField(fid)).filter(v => v && v.trim());
        if (items.length) {
            const preview = items.map((t, i) => `${i + 1}. ${t.split('\n')[0]}`).join('\n');
            appendWizMessage('system', `Current list (${items.length} of ${step.maxItems}):\n\n${preview}\n\nType the changes you want, or 'no changes' / 'Move on →' to keep as-is.`);
        } else {
            appendWizMessage('system', `Nothing set yet. List them out and I'll structure them into the ${step.maxItems}-slot format.`);
        }
        return;
    }

    // Single-field step: show the current/prior value inline so the user can
    // iterate rather than retype.
    if (step.targetFid) {
        const fid = step.targetFid();
        const existing = currentValueForField(fid);
        if (existing) {
            appendWizMessage('system', `Currently:\n\n${existing}\n\nType your iteration, or press 'Move on →' to keep as-is.`);
        }
    }
}

function currentValueForField(fid) {
    // Prefer whatever is in the form (may have been pre-filled from prior quarter)
    const el = document.querySelector(`[data-field-id="${fid}"]`);
    if (el && el.value && el.value.trim()) return el.value.trim();
    // Fall back to prior record
    const f = wizardState?.priorRecord?.fields || {};
    const v = f[fid];
    return (v && typeof v === 'string' && v.trim()) ? v.trim() : '';
}

async function wizSend() {
    const ta = document.getElementById('wizInput');
    const text = ta.value.trim();
    if (!text || !wizardState) return;
    ta.value = '';
    const step = currentStep();
    if (!step) return;
    appendWizMessage('user', text);
    wizardState.stepHistory.push({ role: 'user', content: text });

    // List step — special handling: AI produces a whole new list based on the
    // current list + the user's change instruction.
    if (step.kind === 'list') {
        await handleListStep(step, text);
        return;
    }

    // Reflection / discovery steps have no target field — they're just context
    // gathering for the mentor. Accept without critique so the user can move on.
    if (!step.targetFid) {
        wizardState.answers[step.id] = text;
        // Reflection feeds later steps: store it on the wizard state so every
        // subsequent critique call includes it as context. This is how "what
        // missed last quarter" actually shapes "this quarter's measurables."
        if (step.id === 'reflection') wizardState.reflection = text;
        appendWizMessage('assistant', 'Noted — I\'ll refer back to this as we work through the rest of the sections.');
        wizardState.stepIndex++;
        askCurrentStep();
        return;
    }

    // If we've already pushed back MAX times, auto-accept so we don't loop.
    if (wizardState.pushbackCount >= MAX_PUSHBACKS_PER_STEP) {
        wizardState.answers[step.id] = text;
        appendWizMessage('assistant', 'Accepted — moving on. You can sharpen this in the form later if you want.');
        applyOrAskToMerge(step, text);
        return;
    }

    // Let Boardroom Mentor critique it, with the full step history so it can
    // see what has already been asked and answered and not repeat itself.
    const critique = await boardroomCritique(step, wizardState.stepHistory);
    if (critique && critique.accept === false) {
        wizardState.pushbackCount++;
        const pushback = critique.pushback || 'Can you be more specific?';
        wizardState.stepHistory.push({ role: 'assistant', content: pushback });
        const remaining = MAX_PUSHBACKS_PER_STEP - wizardState.pushbackCount;
        const tail = remaining > 0
            ? `\n\n(${remaining} more push-back before I auto-accept. Hit 'Move on →' any time to skip.)`
            : "\n\n(I'll accept your next answer as-is and move on.)";
        appendWizMessage('assistant', pushback + tail);
        return;
    }
    // Accept
    const accepted = critique?.refined || text;
    wizardState.answers[step.id] = accepted;
    if (critique?.note) appendWizMessage('assistant', critique.note);
    applyOrAskToMerge(step, accepted);
}

// Decide whether to overwrite silently or ask the user how to combine with
// existing content. Three choices: Replace, Add (append), or Incorporate
// (AI merges intelligently).
function applyOrAskToMerge(step, newText) {
    if (!step.targetFid) {
        advanceStep();
        return;
    }
    const fid = step.targetFid();
    const existing = currentValueForField(fid);
    const newTrim = (newText || '').trim();
    const existingTrim = (existing || '').trim();
    // No prior content, or identical — just apply and move on.
    if (!existingTrim || existingTrim === newTrim) {
        applyFieldValueInUI(fid, newText);
        advanceStep();
        return;
    }
    showMergePicker(step, newText, existing);
}

function advanceStep() {
    if (wizardState.focusStepId) { closeWizard({ keepSession: false }); return; }
    wizardState.stepIndex++;
    askCurrentStep();
    persistWizardState();
}

function showMergePicker(step, newText, existingText) {
    const host = document.getElementById('wizMessages');
    const wrap = document.createElement('div');
    wrap.className = 'msg system merge-picker';
    wrap.innerHTML = `<div style="font-weight:600;color:var(--text-primary);margin-bottom:4px">The field already has content — how should this be applied?</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
        <strong>Replace</strong>: drop the existing text, use only your new answer.<br>
        <strong>Add</strong>: append your new answer to the existing text.<br>
        <strong>Incorporate</strong>: Claude merges them intelligently.</div>`;
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
    const mk = (label, handler) => {
        const b = document.createElement('button');
        b.className = 'btn btn-ghost';
        b.style.cssText = 'font-size:11px;padding:4px 10px';
        b.textContent = label;
        b.onclick = handler;
        return b;
    };
    btnRow.appendChild(mk('Replace', () => resolveMerge(step, newText)));
    btnRow.appendChild(mk('Add', () => resolveMerge(step, existingText.trimEnd() + '\n\n' + newText)));
    btnRow.appendChild(mk('Incorporate with AI', async () => {
        btnRow.querySelectorAll('button').forEach(b => { b.disabled = true; });
        const merged = await aiMerge(existingText, newText, step);
        resolveMerge(step, merged);
    }));
    wrap.appendChild(btnRow);
    host.appendChild(wrap);
    host.scrollTop = host.scrollHeight;
    // Persist so a refresh mid-pick doesn't leave the wizard in a weird state —
    // the visible message log will replay the picker on resume.
    if (wizardState) {
        (wizardState.visibleMessages = wizardState.visibleMessages || []).push({
            role: 'system', content: '(merge picker — Replace / Add / Incorporate was shown)'
        });
        persistWizardState();
    }
}

function resolveMerge(step, finalText) {
    if (!wizardState) return;
    const fid = step.targetFid();
    applyFieldValueInUI(fid, finalText);
    wizardState.answers[step.id] = finalText;
    advanceStep();
}

// Handle a list-kind wizard step — ask Claude to produce the full new list
// based on the current list + the founder's change instruction, show it as
// a preview, and commit to all slots on confirmation.
async function handleListStep(step, instruction) {
    const fids = step.fieldIdsFn();
    const current = fids.map(fid => currentValueForField(fid) || '');
    const currentNonEmpty = current.filter(v => v.trim());

    // If user says "no changes" / "skip" / similar, just advance without AI call.
    if (/^(no changes?|none|skip|keep|same|pass|all good)$/i.test(instruction.trim())) {
        appendWizMessage('assistant', 'Noted — no changes. Moving on.');
        advanceStep();
        return;
    }

    appendWizMessage('assistant', 'Restructuring the list… one moment.');
    const newList = await boardroomListRewrite(step, currentNonEmpty, instruction);
    if (!newList || !newList.length) {
        appendWizMessage('assistant', "I didn't get a clean list back. Keeping the current list and moving on — you can edit inline in the form.");
        advanceStep();
        return;
    }

    // Preview + confirm before writing all slots.
    showListPreview(step, newList, current);
}

function showListPreview(step, newList, previous) {
    const host = document.getElementById('wizMessages');
    const wrap = document.createElement('div');
    wrap.className = 'msg system';
    const preview = newList.map((t, i) => `${i + 1}. ${t.split('\n')[0]}`).join('\n');
    const text = `Proposed new list (${newList.length} item${newList.length === 1 ? '' : 's'}):\n\n${preview}\n\nApply to the form?`;
    wrap.textContent = text;
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:8px;flex-wrap:wrap';
    const mk = (label, handler) => {
        const b = document.createElement('button');
        b.className = 'btn btn-ghost';
        b.style.cssText = 'font-size:11px;padding:4px 10px';
        b.textContent = label;
        b.onclick = handler;
        return b;
    };
    btnRow.appendChild(mk('Apply (replace)', () => applyListAndAdvance(step, newList)));
    btnRow.appendChild(mk('Revise', () => {
        appendWizMessage('assistant', 'OK — tell me what to change and I\'ll rework it.');
    }));
    btnRow.appendChild(mk('Keep existing', () => {
        appendWizMessage('assistant', 'No changes applied. Moving on.');
        advanceStep();
    }));
    wrap.appendChild(btnRow);
    host.appendChild(wrap);
    host.scrollTop = host.scrollHeight;
    // Track the preview in the visible log.
    if (wizardState) {
        (wizardState.visibleMessages = wizardState.visibleMessages || []).push({ role: 'system', content: text + ' (pending choice)' });
        persistWizardState();
    }
}

function applyListAndAdvance(step, list) {
    const fids = step.fieldIdsFn();
    const sized = list.slice(0, step.maxItems);
    fids.forEach((fid, i) => applyFieldValueInUI(fid, sized[i] || ''));
    appendWizMessage('assistant', `Applied ${sized.length} item${sized.length === 1 ? '' : 's'} to the form.`);
    advanceStep();
}

async function boardroomListRewrite(step, currentList, instruction) {
    const system = buildCachedWizardSystem(
        `Strategy Plan OS — ${wizardState.businessName}. Restructuring a list field.`,
        `You are restructuring the "${step.label}" list for the business.

Context: ${step.descriptionForAI || ''}
Maximum items allowed: ${step.maxItems}

Current list (JSON array, may be empty):
${JSON.stringify(currentList)}

Founder's change instruction (their own words):
"${instruction}"

Your task: return a JSON object {"list": ["item 1", "item 2", ...]} representing the FINAL list after applying the founder's instruction. Rules:
- If the founder listed new items directly (first-time use), structure them into the list.
- If they said "add", "reword", "remove", or similar, apply those edits to the current list.
- If they gave a full new list, replace.
- Preserve all substance from the current list that wasn't explicitly changed.
- Tidy each item for grammar, punctuation, UK English, while keeping the founder's voice.
- Each item can be a single sentence OR a title followed by bullets — preserve structure if the current list has structure.
- Never exceed ${step.maxItems} items.

Return the JSON object ONLY. No commentary. No code fence.`
    );
    try {
        const res = await fetch(AI_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 3000,
                system,
                messages: [{ role: 'user', content: 'Return the restructured list now.' }],
            }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const raw = (data.content?.[0]?.text || '').trim();
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return null;
        const parsed = JSON.parse(match[0]);
        return Array.isArray(parsed.list) ? parsed.list.map(String) : null;
    } catch (e) { return null; }
}

async function aiMerge(existing, addition, step) {
    const system = buildCachedWizardSystem(
        `Strategy Plan OS — ${wizardState.businessName}. Merging a new addition into an existing field.`,
        `You have existing text for "${step.label}" and a new addition the founder wants incorporated. Return ONLY the merged text — no explanation, no commentary, no JSON. Preserve the structure and tone of the existing text. Incorporate the new material where it fits best, and tighten for coherence. Do not lose any substance from either side; if they conflict, prefer the newer content.`
    );
    try {
        const res = await fetch(AI_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1500,
                system,
                messages: [
                    { role: 'user', content: `EXISTING:\n${existing}\n\nNEW TO INCORPORATE:\n${addition}\n\nReturn the merged text only.` },
                ],
            }),
        });
        if (!res.ok) return existing.trimEnd() + '\n\n' + addition;
        const data = await res.json();
        return (data.content?.[0]?.text || '').trim() || (existing.trimEnd() + '\n\n' + addition);
    } catch (e) { return existing.trimEnd() + '\n\n' + addition; }
}

// "Move on →" — user wants to skip this step regardless of what's been said.
// Commit whatever's already in the form field (pre-filled or last accepted)
// so we don't blank it. If nothing is there, the field just stays empty.
function wizSkip() {
    if (!wizardState) return;
    const step = currentStep();
    if (!step) return;
    appendWizMessage('user', '(moving on)');
    // Spot-edit — one question only; close after the user moves on.
    if (wizardState.focusStepId) { closeWizard({ keepSession: false }); return; }
    wizardState.stepIndex++;
    askCurrentStep();
    persistWizardState();
}

// "← Back" — revise the previous question. Decrements the step and re-asks.
function wizBack() {
    if (!wizardState) return;
    // Find the previous answerable step (skipping discovery-only ones that were
    // auto-handled based on needsPrior).
    let idx = wizardState.stepIndex - 1;
    while (idx >= 0) {
        const s = WIZARD_STEPS[idx];
        if (!s.needsPrior || wizardState.priorRecord) break;
        idx--;
    }
    if (idx < 0) {
        appendWizMessage('system', "Already on the first question.");
        return;
    }
    wizardState.stepIndex = idx;
    wizardState.stepHistory = [];
    wizardState.pushbackCount = 0;
    appendWizMessage('system', `← Stepped back to "${WIZARD_STEPS[idx].label}". Your previous answer is still in the form; type a new one, or Move on to keep it.`);
    askCurrentStep();
    persistWizardState();
}

function appendWizMessage(role, text, opts = {}) {
    const host = document.getElementById('wizMessages');
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = text;
    host.appendChild(el);
    host.scrollTop = host.scrollHeight;
    // Track visible messages so we can replay on resume.
    if (wizardState) {
        (wizardState.visibleMessages = wizardState.visibleMessages || []).push({ role, content: text });
        if (!opts.skipPersist) persistWizardState();
    }
    return el;
}

function applyFieldValueInUI(fid, value) {
    const el = document.querySelector(`[data-field-id="${fid}"]`);
    if (el) {
        el.value = value;
        markDirty();
        resizeFieldAndRowMates(el);
    } else {
        // Record may not be rendered yet (empty state). Re-render with a stub.
        renderForm({});
        const el2 = document.querySelector(`[data-field-id="${fid}"]`);
        if (el2) {
            el2.value = value;
            markDirty();
            resizeFieldAndRowMates(el2);
        }
    }
}

// After programmatically changing a field's value, re-size it to fit the new
// content and re-run whichever row-equalize applies to its container. Keeps
// adjacent columns in sync so a long answer pushes its row-mates down
// together rather than leaving a ragged edge.
function resizeFieldAndRowMates(el) {
    if (!el || el.tagName !== 'TEXTAREA') return;
    autosize(el);
    // Numbered card grid (Undertakings / USPs / Method Steps)
    const card = el.closest('.num-card');
    if (card) { equaliseCardRow(card); return; }
    // Quarterly Projects — align Project field and each monthly stone across 3 cols
    if (el.closest('.qp-card')) { equaliseQuarterlyProjects(); return; }
    // Target Statement / Measurables — multi-col grid of field-rows
    const fieldRow = el.closest('.field-row');
    if (fieldRow?.parentElement?.classList.contains('grid-cols-2') ||
        fieldRow?.parentElement?.classList.contains('grid-cols-3')) {
        equaliseFieldRow(el);
    }
}

async function boardroomCritique(step, history) {
    // Call Claude to critique. Return { accept: true/false, pushback?: "…", refined?: "…", note?: "…" }
    // `history` is the full back-and-forth for THIS step so the mentor sees what
    // it has already asked and doesn't repeat the same challenge verbatim.
    const priorContext = wizardState.priorRecord
        ? `Prior quarter's record (for reference): ${JSON.stringify(extractCompactPrior(wizardState.priorRecord))}`
        : 'No prior quarter record — starting fresh.';
    const reflectionContext = wizardState.reflection
        ? `\n\nFOUNDER'S REFLECTION ON LAST QUARTER (their own words — reference when relevant so "what missed" shapes "what we commit to now"):\n"${wizardState.reflection}"`
        : '';
    const attemptCount = history.filter(m => m.role === 'user').length;
    const system = buildCachedWizardSystem(
        `Strategy Plan OS — ${wizardState.businessName}. ${priorContext}${reflectionContext}`,
        `You are interviewing the founder to build this quarter's strategy plan, one field at a time.

Section: "${step.label}"
Question you asked: "${step.ask}"
This is the founder's attempt #${attemptCount} at answering.

GUIDING PRINCIPLE — ACCEPT MORE THAN YOU REJECT. Your job is to help them think sharper, not block them. Accept any answer that is:
- At least moderately specific (a concrete deliverable, number, or direction — doesn't need to be perfect)
- Sized roughly right for the horizon (9-year = visionary, quarterly project = 90 days, monthly stone = 30 days of work)
- Not pure motivational fluff ("be the best", "crush it")

If there's genuine weakness, push back ONCE with a specific, focused challenge. After one push-back you should lean strongly toward accepting the next answer even if imperfect — the founder can refine in the form.

IMPORTANT: Look at the full conversation above. If you've already pushed back on the same point, DO NOT repeat the same push-back. Either accept, or push on a different dimension. Repeating yourself blocks progress and is a failure on your part.

Reply with a JSON object ONLY, nothing else. Shape:
{"accept": true|false, "pushback"?: "one short paragraph (2–3 sentences max) in UK English, naming one specific thing to add or sharpen — never repeat a point you've already made", "refined"?: "the founder's latest answer tidied for grammar, punctuation and flow — see rules below — MUST be included on every accept", "note"?: "one short confirmation line after accept, optional"}

"refined" rules (REQUIRED on every accept):
- Fix grammar, punctuation, capitalisation, and awkward phrasing.
- Use UK English spelling.
- Preserve the founder's own words and voice where they work. This is a polish, not a rewrite.
- Preserve ALL substance — every number, name, claim, and nuance stays intact. Never add facts the founder didn't give you.
- Keep the length in the same ballpark as the founder's input.
- Keep bullet lists as bullet lists; keep paragraph structure.
- If the input was already clean, you may return it verbatim.

Do not accept pure platitudes. Do accept rough-but-usable answers, especially on attempt 2+. Prefer 'accept with refined tightening' over 'reject'.`
    );
    try {
        const res = await fetch(AI_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 600,
                system,
                // Pass the full per-step conversation so the model sees what it's already asked.
                messages: history.map(m => ({ role: m.role, content: m.content })),
            }),
        });
        if (!res.ok) return { accept: true }; // fail open
        const data = await res.json();
        const text = (data.content?.[0]?.text || '').trim();
        // Extract JSON
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { accept: true };
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed;
    } catch (e) {
        return { accept: true };
    }
}

function extractCompactPrior(rec) {
    const f = rec.fields || {};
    // fields are keyed by ID because loadPriorQuarter uses returnFieldsByFieldId
    const readSelect = v => (v && typeof v === 'object') ? v.name : v;
    return {
        quarter: readSelect(f[OBJSTRAT.quarter]),
        year: readSelect(f[OBJSTRAT.year]),
        nineYear: f[OBJSTRAT.nineYearTarget],
        threeYear: f[OBJSTRAT.threeYearTarget],
        oneYear: f[OBJSTRAT.oneYearTarget],
        qp1: f[OBJSTRAT.quarterlyProjects[0]],
        qp2: f[OBJSTRAT.quarterlyProjects[1]],
        qp3: f[OBJSTRAT.quarterlyProjects[2]],
    };
}

function finaliseWizard() {
    appendWizMessage('assistant', 'All sections captured. I have pre-filled the form. Review, then hit "Save changes" at the top. After saving, I will offer to push the three Quarterly Projects into Projects OS as real project records with linked monthly Tasks.');
    document.getElementById('wizStepLabel').textContent = 'Complete — review form';
    // Wizard finished cleanly — drop the saved session so the next open starts fresh.
    clearWizardSession();
}

// Add a "✨ Revise" button on each form field that opens the wizard jumped to
// that specific step. Only attach for fields that have a matching wizard step.
function attachReviseAffordances() {
    const stepByFid = new Map();
    for (const step of WIZARD_STEPS) {
        if (!step.targetFid) continue;
        try { stepByFid.set(step.targetFid(), step.id); } catch (e) {}
    }
    document.querySelectorAll('[data-field-id]').forEach(el => {
        const fid = el.dataset.fieldId;
        const stepId = stepByFid.get(fid);
        if (!stepId) return;
        if (el.dataset.reviseAttached) return;
        el.dataset.reviseAttached = '1';
        el.addEventListener('focus', () => showReviseButton(el, stepId));
        el.addEventListener('blur', () => {
            // Delay so clicking the button registers before blur hides it.
            setTimeout(() => hideReviseButton(el), 150);
        });
    });
}

function showReviseButton(field, stepId) {
    let btn = field.parentElement.querySelector('.revise-btn');
    if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'revise-btn';
        btn.textContent = '✨ Revise with AI';
        btn.onmousedown = e => { e.preventDefault(); /* keep focus */ };
        btn.onclick = () => { openWizard({ focusStepId: stepId }); };
        field.parentElement.appendChild(btn);
    }
    btn.style.display = 'inline-flex';
}

function hideReviseButton(field) {
    const btn = field.parentElement?.querySelector('.revise-btn');
    if (btn) btn.style.display = 'none';
}

// Warn before unload if form has unsaved edits (or the wizard is mid-flow).
window.addEventListener('beforeunload', e => {
    if (isDirty) { e.preventDefault(); e.returnValue = ''; return ''; }
});

function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
