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

        // KPI + Tracking + DoD — ports into Projects OS on sync.
        const det = OBJSTRAT.qpDetails[i];
        card.appendChild(kpiSubsection(`KPI for Project ${i + 1}`, {
            kpiNameFid: det.kpiName,
            kpiUnitFid: det.kpiUnit,
            trackingFid: det.tracking,
            dodFid: det.dod,
        }, fields));

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

// Compact KPI + Tracking + DoD block for inside a Quarterly Project card.
// Matches the Projects OS schema so values sync 1-to-1 on project creation.
function kpiSubsection(title, fieldMap, fields) {
    const box = document.createElement('div');
    box.className = 'kpi-subsection';
    const h = document.createElement('div');
    h.className = 'kpi-subsection-title';
    h.textContent = title;
    box.appendChild(h);

    // KPI Name + Unit side-by-side
    const nameUnitRow = document.createElement('div');
    nameUnitRow.style.cssText = 'display:grid;grid-template-columns:1fr 80px;gap:8px';
    nameUnitRow.appendChild(singleLineField('KPI Name', fieldMap.kpiNameFid, fields[fieldMap.kpiNameFid] || ''));
    // Unit select
    const unitRow = document.createElement('div');
    unitRow.className = 'field-row';
    const unitLabel = document.createElement('label');
    unitLabel.textContent = 'Unit';
    const unitSel = document.createElement('select');
    unitSel.dataset.fieldId = fieldMap.kpiUnitFid;
    ['', '£', '%', 'count', 'days', 'items', 'hours'].forEach(u => {
        const opt = document.createElement('option');
        opt.value = u; opt.textContent = u || '—';
        if (extractSelectName(fields[fieldMap.kpiUnitFid]) === u) opt.selected = true;
        unitSel.appendChild(opt);
    });
    unitSel.style.cssText = 'padding:9px 10px;border:1px solid var(--border-default);border-radius:6px;font-size:13px;background:var(--bg-surface);font-family:inherit;color:var(--text-primary)';
    unitSel.addEventListener('change', () => markDirty());
    unitRow.appendChild(unitLabel);
    unitRow.appendChild(unitSel);
    nameUnitRow.appendChild(unitRow);
    box.appendChild(nameUnitRow);

    box.appendChild(textareaField('Tracking Method', fieldMap.trackingFid, fields[fieldMap.trackingFid] || ''));
    box.appendChild(textareaField('Definition of Done', fieldMap.dodFid, fields[fieldMap.dodFid] || ''));
    return box;
}

// Airtable singleSelect values come back as either a plain string (when
// queried with returnFieldsByFieldId on newer schemas) or an object like
// { id, name, color }. Normalise to a string.
function extractSelectName(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v.name) return v.name;
    return '';
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

// Lines up the 3 Quarterly Project columns. Every QP card has the same
// textarea structure in the same DOM order (Project, KPI Tracking, KPI DoD,
// stone M1, stone M2, stone M3), so we match each textarea at position N
// across all three cards and set min-height to the tallest. That way every
// horizontal row of fields across the three columns sits at the same height.
function equaliseQuarterlyProjects() {
    const cards = document.querySelectorAll('.qp-card');
    if (cards.length !== 3) return;
    const tasByCard = Array.from(cards).map(c => Array.from(c.querySelectorAll('textarea')));
    // Reset + re-measure every textarea before we equalise, otherwise a prior
    // min-height masks the true natural height of the tallest in the row.
    tasByCard.flat().forEach(t => { t.style.minHeight = ''; autosize(t); });
    const maxLen = Math.max(...tasByCard.map(arr => arr.length));
    for (let pos = 0; pos < maxLen; pos++) {
        const tas = tasByCard.map(arr => arr[pos]).filter(Boolean);
        if (tas.length < 2) continue;
        const max = Math.max(...tas.map(t => t.offsetHeight));
        tas.forEach(t => { t.style.minHeight = max + 'px'; });
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
        // returnFieldsByFieldId=true so the response has fields keyed by field
        // ID (same shape as loadRecord). Without this, later code that reads
        // currentRecord.fields[fieldId] fails silently (e.g. pushProjectsManually
        // couldn't find QP text and reported "no quarterly projects").
        if (currentRecord) {
            // Update
            const res = await airtableFetch(`${TABLES.objStrat}/${currentRecord.id}?returnFieldsByFieldId=true`, {
                method: 'PATCH',
                body: JSON.stringify({ fields, typecast: true }),
            });
            currentRecord = res;
        } else {
            // Create
            const res = await airtableFetch(`${TABLES.objStrat}?returnFieldsByFieldId=true`, {
                method: 'POST',
                body: JSON.stringify({ fields, typecast: true }),
            });
            currentRecord = res;
        }
        isDirty = false;
        setStatus('success', `Saved ${quarter} ${year}.`);
        setTimeout(() => setStatus('', ''), 2500);
        // After a successful save, offer to push Quarterly Projects to
        // Projects OS as real project records. Shown as an inline banner —
        // user can ignore and save again later without re-prompting within
        // the same session.
        offerProjectPush();
    } catch (e) {
        setStatus('error', `Save failed: ${e.message}`);
    } finally {
        updateSaveButton();
    }
}

// ═════════════════════════════════════════════════════════════════════
// PROJECTS OS SYNC — push each non-empty Quarterly Project as a record
// in the Projects table, with all the fields we captured in the Strategy
// OS (KPI Name/Unit/Tracking, Definition of Done, Business, Quarter bounds).
// ═════════════════════════════════════════════════════════════════════

// Projects table field IDs (matches os/tasks/index.html PF constants).
const PROJ_F = {
    name:        'fldiMZICg1KOORpte',
    business:    'fldtdJTFkMtldxEVf',
    startDate:   'fldGIlsn0cSEpnj18',
    endDate:     'fldU0cJparnkvOUsV',
    status:      'fldZ0SpReVaDS1VXb',
    dod:         'fldgjzVEnfnZowrBD',
    kpiName:     'fldABYFMf2yBKWdlD',
    kpiUnit:     'fldrYZEghROXYf6w0',
    kpiTracking: 'fld2wYB5ZEn9WRcjN',
};

// Tasks table field IDs (matches os/tasks/index.html F constants).
const TASK_F = {
    name:      'fldgFjGBw6bTKJFCD',
    dueDate:   'fld7XP8w8kbxfETV4',
    status:    'fldx4qCw17UfrKpaN',
    assignee:  'fldELMncVJYPDRJNc',
    priority:  'fldS21RwmwOqt71LI',
    time:      'flduPjY0p7MmQzDvH',
    desc:      'fldRGhBQViKZKtkQ6',
    business:  'fldLu1Y4GzyWcDoxr',
    projects:  'fldBg0rQy0FrOAkRN',
};

// Kevin's Airtable collaborator email — Assignee is a singleCollaborator.
const KEVIN_EMAIL = 'kevin@runpreneur.org.uk';
const DEFAULT_TASK_DURATION_SECONDS = 15 * 60;   // 15 minutes as seconds

let pushOfferDismissedForRecord = null;

function offerProjectPush() {
    if (!currentRecord) return;
    if (pushOfferDismissedForRecord === currentRecord.id) return;
    const { businessId, quarter, year } = getSelection();
    if (!businessId) return;
    // Read from the form so we see whatever the founder just typed, not
    // whatever shape the Airtable response came back in.
    const fields = readAllFormFields();
    const qps = OBJSTRAT.quarterlyProjects
        .map((fid, i) => ({ i, text: (fields[fid] || '').trim() }))
        .filter(q => q.text);
    if (!qps.length) return;

    const host = document.getElementById('statusBar');
    host.className = 'status-bar';
    host.style.display = 'block';
    host.innerHTML = `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between">
        <span>Push ${qps.length} Quarterly Project${qps.length === 1 ? '' : 's'} to Projects OS? This will create ${qps.length} linked project record${qps.length === 1 ? '' : 's'} in the Projects table for ${escapeHtml(quarter)} ${escapeHtml(year)}.</span>
        <span style="display:flex;gap:6px">
            <button class="btn btn-ghost" id="pushLaterBtn">Not now</button>
            <button class="btn btn-primary" id="pushNowBtn">Push projects →</button>
        </span>
    </div>`;
    document.getElementById('pushLaterBtn').onclick = () => {
        pushOfferDismissedForRecord = currentRecord.id;
        setStatus('', '');
    };
    document.getElementById('pushNowBtn').onclick = async () => {
        // Route through the preview modal so tasks-from-stones get the same approval flow.
        const btn = document.getElementById('pushNowBtn');
        if (btn) btn.disabled = true;
        setStatus('info', 'Building preview…');
        try {
            const proposal = await buildPushProposal(qps, fields);
            setStatus('', '');
            showPushApprovalModal(proposal, fields);
        } catch (e) {
            console.error('[post-save push preview]', e);
            setStatus('error', `Couldn't build preview: ${e.message || e}`);
        }
        if (btn) btn.disabled = false;
    };
}

// Invoked from the "Push Projects →" button. Builds a proposal (projects +
// AI-extracted tasks from monthly stepping stones) and shows an approval
// modal before anything is written to Airtable.
async function pushProjectsManually() {
    if (!currentRecord) {
        setStatus('warn', 'Save the plan first, then push projects.');
        return;
    }
    const fields = readAllFormFields();
    const qps = OBJSTRAT.quarterlyProjects
        .map((fid, i) => ({ i, text: (fields[fid] || '').trim() }))
        .filter(q => q.text);
    if (!qps.length) {
        setStatus('warn', 'No Quarterly Projects to push — add some text to Quarterly Project 1/2/3 first, then Save changes, then try again.');
        return;
    }

    const btn = document.getElementById('pushProjBtn');
    if (btn) btn.disabled = true;
    setStatus('info', 'Building preview (extracting tasks from monthly stones)…');

    let proposal;
    try {
        proposal = await buildPushProposal(qps, fields);
    } catch (e) {
        console.error('[pushProjectsManually] buildPushProposal', e);
        setStatus('error', `Couldn't build task preview: ${e.message || e}`);
        if (btn) btn.disabled = false;
        return;
    }
    setStatus('', '');
    if (btn) btn.disabled = false;
    showPushApprovalModal(proposal, fields);
}

// Snapshot every form field by its data-field-id into a { fid: value } map.
// This is the single source of truth for what's currently on screen. Used
// when we need to operate on current form state (save/push) independently of
// whatever the last Airtable response looked like.
function readAllFormFields() {
    const out = {};
    document.querySelectorAll('[data-field-id]').forEach(el => {
        out[el.dataset.fieldId] = el.value || '';
    });
    return out;
}

// Build a preview of what the push will create — projects + AI-extracted
// tasks from each monthly stepping stone. Also checks which projects already
// exist in Projects OS for this business/quarter so we can flag duplicates
// and skip them on write.
async function buildPushProposal(qps, fields) {
    const { businessId, quarter, year } = getSelection();
    const qIdx = QUARTERS.indexOf(quarter);
    const yearNum = parseInt(year, 10);
    const starts = [[1, 1], [4, 1], [7, 1], [10, 1]];
    const ends   = [[3, 31], [6, 30], [9, 30], [12, 31]];
    const pad = n => String(n).padStart(2, '0');
    const qStartISO = `${yearNum}-${pad(starts[qIdx][0])}-${pad(starts[qIdx][1])}`;
    const qEndISO   = `${yearNum}-${pad(ends[qIdx][0])}-${pad(ends[qIdx][1])}`;
    const monthEndsInQuarter = [0, 1, 2].map(m => {
        const mo = starts[qIdx][0] + m;
        const lastDay = new Date(yearNum, mo, 0).getDate();
        return `${yearNum}-${pad(mo)}-${pad(lastDay)}`;
    });

    // Dedup: build a map of existing project NAME (lowercased) → record ID
    // for every project on this Business whose Start Date = quarter start.
    // We'll reuse the record ID when linking tasks to existing projects.
    let existingByName = new Map();
    try {
        const business = allBusinessesLocal.find(b => b.id === businessId);
        const businessName = (business?.name || '').replace(/"/g, '\\"');
        const filter = `AND(` +
            `FIND("${businessName}", ARRAYJOIN({Business}))>0, ` +
            `DATETIME_FORMAT({Start Date}, "YYYY-MM-DD") = "${qStartISO}"` +
        `)`;
        const params = new URLSearchParams({
            filterByFormula: filter,
            returnFieldsByFieldId: 'true',
            pageSize: '100',
        });
        const data = await airtableFetch(`${TABLES.projects}?${params.toString()}`);
        (data.records || []).forEach(r => {
            const n = r.fields?.[PROJ_F.name];
            if (n) existingByName.set(String(n).trim().toLowerCase(), r.id);
        });
        console.log('[buildPushProposal] existing projects for dedup:', Array.from(existingByName.entries()));
    } catch (e) {
        console.warn('[buildPushProposal] project dedup check failed — will still allow push', e);
    }

    const proposal = { quarter, year, qStartISO, qEndISO, projects: [] };
    for (const qp of qps) {
        const det = OBJSTRAT.qpDetails[qp.i];
        const projectName = deriveProjectName(qp.text);
        const nameKey = projectName.trim().toLowerCase();
        const alreadyExists = existingByName.has(nameKey);
        const existingProjectId = alreadyExists ? existingByName.get(nameKey) : null;

        // For existing projects, fetch the tasks already linked to them so we
        // can dedup tasks on name. For new projects, nothing to fetch yet.
        let existingTaskNames = new Set();
        if (alreadyExists) {
            try {
                const safeName = projectName.replace(/"/g, '\\"');
                const tFilter = `FIND("${safeName}", ARRAYJOIN({Projects}))>0`;
                const tParams = new URLSearchParams({
                    filterByFormula: tFilter,
                    returnFieldsByFieldId: 'true',
                    pageSize: '200',
                });
                const tData = await airtableFetch(`${TABLES.tasks}?${tParams.toString()}`);
                (tData.records || []).forEach(r => {
                    const n = r.fields?.[TASK_F.name];
                    if (n) existingTaskNames.add(String(n).trim().toLowerCase());
                });
                console.log(`[buildPushProposal] existing tasks on "${projectName}":`, Array.from(existingTaskNames));
            } catch (e) {
                console.warn('[buildPushProposal] task dedup fetch failed for', projectName, e);
            }
        }

        const stones = OBJSTRAT.monthlyStones[qp.i].map(sFid => (fields[sFid] || '').trim());
        const tasksByMonth = [[], [], []];
        for (let m = 0; m < 3; m++) {
            const stone = stones[m];
            if (!stone || /^(n\/?a|tbc|skip|none|-|—|…)$/i.test(stone)) continue;
            const extracted = await extractTasksFromStone(stone, qp.i + 1, m + 1, projectName);
            tasksByMonth[m] = extracted.map(name => ({
                name,
                dueISO: monthEndsInQuarter[m],
                month: m + 1,
                exists: existingTaskNames.has(String(name).trim().toLowerCase()),
            }));
        }

        proposal.projects.push({
            qp,
            projectName,
            qpText: qp.text,
            dod: (fields[det.dod] || '').trim(),
            kpiName: (fields[det.kpiName] || '').trim(),
            kpiUnit: extractSelectName(fields[det.kpiUnit]) || '',
            tracking: (fields[det.tracking] || '').trim(),
            stones,
            tasksByMonth,
            alreadyExists,
            existingProjectId,
        });
    }
    return proposal;
}

// Ask Sonnet to break a monthly stepping stone into discrete, actionable
// tasks. A stone like "Website finalised with call booking and Stripe
// integrated for product sales" becomes two tasks. A stone like "Complete
// 5 Woodcock renovation" stays a single task.
async function extractTasksFromStone(stoneText, projectNumber, monthNumber, projectName) {
    const system = buildCachedWizardSystem(
        `Strategy Plan OS — extracting tasks from a monthly stepping stone.`,
        `You are breaking down a monthly stepping stone into discrete, actionable tasks for a task management system.

Context:
- Quarterly Project: "${projectName}"
- Month: ${monthNumber} of 3 in this quarter
- Stepping stone text: "${stoneText}"

Your job: extract the discrete tasks implied by the stepping stone. If the stone reads as a single deliverable, return one task. If it contains multiple distinct deliverables joined by "and", commas, or similar, split them into separate tasks.

RULES:
- Return a JSON object {"tasks": ["task 1", "task 2", ...]} — nothing else.
- Each task name: short, imperative, 3–10 words. E.g. "Finalise website" not "Website will be finalised".
- Preserve specific names, numbers, and products the founder used.
- Don't invent tasks that aren't implied by the stone.
- Don't split a single deliverable into sub-steps — each task should match one bullet-point-sized deliverable.
- UK English.`
    );
    try {
        const res = await fetch(AI_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 800,
                system,
                messages: [{ role: 'user', content: `Stone: "${stoneText}"\n\nReturn the JSON task list now.` }],
            }),
        });
        if (!res.ok) return [stoneText];  // fail open — keep the stone as one task
        const data = await res.json();
        const raw = (data.content?.[0]?.text || '').trim();
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return [stoneText];
        const parsed = JSON.parse(match[0]);
        const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(t => String(t).trim()).filter(Boolean) : [];
        return tasks.length ? tasks : [stoneText];
    } catch (e) {
        console.warn('[extractTasksFromStone] falling back to single task', e);
        return [stoneText];
    }
}

// Approval modal — shows the full proposal (projects + tasks per month) and
// lets the user approve everything, approve projects only, or cancel.
function showPushApprovalModal(proposal, fields) {
    // Remove any existing modal first
    document.getElementById('pushModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'pushModal';
    overlay.className = 'push-modal-overlay';

    // Aggregate counts — "new" means records we'll actually create.
    const newProjects = proposal.projects.filter(p => !p.alreadyExists);
    const existingProjects = proposal.projects.filter(p => p.alreadyExists);
    const countNewTasks = proposal.projects.reduce((n, p) =>
        n + p.tasksByMonth.reduce((nn, m) => nn + m.filter(t => !t.exists).length, 0), 0);
    const countExistingTasks = proposal.projects.reduce((n, p) =>
        n + p.tasksByMonth.reduce((nn, m) => nn + m.filter(t => t.exists).length, 0), 0);

    const projectsHtml = proposal.projects.map((p, i) => {
        const monthsHtml = p.tasksByMonth.map((tasks, m) => {
            if (!tasks.length) return '';
            const header = `<div class="push-month-label">Month ${m + 1} — due ${tasks[0].dueISO}</div>`;
            const items = tasks.map(t =>
                t.exists
                    ? `<li class="task-existing">${escapeHtml(t.name)}<span class="task-existing-badge">Already exists</span></li>`
                    : `<li>${escapeHtml(t.name)}</li>`
            ).join('');
            return `${header}<ul class="push-task-list">${items}</ul>`;
        }).join('');

        const badge = p.alreadyExists
            ? '<span class="push-exists-badge">Existing project — tasks will be linked to it</span>'
            : '';

        return `
        <div class="push-project${p.alreadyExists ? ' push-project-existing' : ''}">
            <div class="push-project-head">
                <span class="push-project-num">QP${p.qp.i + 1}</span>
                <span class="push-project-name">${escapeHtml(p.projectName)}</span>
                ${badge}
            </div>
            ${p.kpiName ? `<div class="push-project-meta"><strong>KPI:</strong> ${escapeHtml(p.kpiName)}${p.kpiUnit ? ' (' + escapeHtml(p.kpiUnit) + ')' : ''}</div>` : ''}
            ${p.dod ? `<div class="push-project-meta"><strong>Definition of Done:</strong> ${escapeHtml(p.dod)}</div>` : ''}
            <div class="push-project-tasks">
                ${monthsHtml || '<div style="font-size:12px;color:var(--text-muted);font-style:italic">No monthly stepping stones to convert to tasks.</div>'}
            </div>
        </div>`;
    }).join('');

    const totalNewRecords = newProjects.length + countNewTasks;
    const dedupNoteParts = [];
    if (existingProjects.length) dedupNoteParts.push(`${existingProjects.length} existing project${existingProjects.length === 1 ? '' : 's'} will be reused (no duplicate created)`);
    if (countExistingTasks) dedupNoteParts.push(`${countExistingTasks} task${countExistingTasks === 1 ? '' : 's'} already exist and will be skipped`);
    const dedupNote = dedupNoteParts.length
        ? `<div style="font-size:12px;color:var(--info);margin-bottom:12px;padding:8px 12px;background:var(--info-bg);border-radius:6px;border:1px solid var(--info-bg)">${dedupNoteParts.join(' · ')}.</div>`
        : '';

    const approveLabel = totalNewRecords === 0
        ? 'Nothing new to create'
        : `Approve · create ${totalNewRecords} new record${totalNewRecords === 1 ? '' : 's'}`;

    overlay.innerHTML = `
    <div class="push-modal">
        <div class="push-modal-head">
            <div>
                <div class="push-modal-title">Push to Projects &amp; Tasks OS</div>
                <div class="push-modal-sub">${newProjects.length} new project${newProjects.length === 1 ? '' : 's'} · ${countNewTasks} new task${countNewTasks === 1 ? '' : 's'} · ${escapeHtml(proposal.quarter)} ${escapeHtml(proposal.year)}</div>
            </div>
            <button class="push-modal-close" type="button">&times;</button>
        </div>
        <div class="push-modal-body">
            ${dedupNote}
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">Each task will be assigned to Kevin, priority <strong>Project</strong>, duration <strong>15 min</strong>, linked to the project + business, due by end of its month. Review and approve.</div>
            ${projectsHtml}
        </div>
        <div class="push-modal-foot">
            <button class="btn btn-ghost" type="button" id="pushCancelBtn">Cancel</button>
            <button class="btn btn-ghost" type="button" id="pushProjOnlyBtn"${newProjects.length === 0 ? ' disabled' : ''}>Projects only (no tasks)</button>
            <button class="btn btn-primary" type="button" id="pushApproveBtn"${totalNewRecords === 0 ? ' disabled' : ''}>${approveLabel}</button>
        </div>
    </div>`;

    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.push-modal-close').onclick = close;
    overlay.querySelector('#pushCancelBtn').onclick = close;
    overlay.querySelector('#pushProjOnlyBtn').onclick = () => { close(); executePush(proposal, fields, { tasks: false }); };
    overlay.querySelector('#pushApproveBtn').onclick = () => { close(); executePush(proposal, fields, { tasks: true }); };
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

// Actually create the Airtable records. Runs after user approves the preview.
async function executePush(proposal, fields, opts) {
    const { businessId } = getSelection();
    const btn = document.getElementById('pushProjBtn');
    if (btn) btn.disabled = true;

    // New projects vs existing — tasks get created for both; projects only
    // for the new ones.
    const newProjects = proposal.projects.filter(p => !p.alreadyExists);
    const countNewTasks = proposal.projects.reduce((n, p) =>
        n + p.tasksByMonth.reduce((nn, m) => nn + m.filter(t => !t.exists).length, 0), 0);
    setStatus('info', `Creating ${newProjects.length} project${newProjects.length === 1 ? '' : 's'}${opts.tasks ? ` + ${countNewTasks} task${countNewTasks === 1 ? '' : 's'}` : ''}…`);

    const results = {
        projectsCreated: 0, projectsReused: 0,
        tasksCreated: 0, tasksSkipped: 0,
        failed: 0, errors: [],
    };

    for (const p of proposal.projects) {
        // 1. Project — reuse existing ID or create a new one.
        let projectId = p.existingProjectId;
        if (p.alreadyExists) {
            results.projectsReused++;
        } else {
            const projBody = { fields: {}, typecast: true };
            projBody.fields[PROJ_F.name] = p.projectName;
            projBody.fields[PROJ_F.business] = [businessId];
            projBody.fields[PROJ_F.startDate] = proposal.qStartISO;
            projBody.fields[PROJ_F.endDate] = proposal.qEndISO;
            projBody.fields[PROJ_F.dod] = p.dod || p.qpText;
            if (p.kpiName) projBody.fields[PROJ_F.kpiName] = p.kpiName;
            if (p.kpiUnit) projBody.fields[PROJ_F.kpiUnit] = p.kpiUnit;
            if (p.tracking) projBody.fields[PROJ_F.kpiTracking] = p.tracking;
            try {
                const created = await airtableFetch(TABLES.projects, { method: 'POST', body: JSON.stringify(projBody) });
                projectId = created.id;
                results.projectsCreated++;
                console.log('[executePush] project created', projectId, p.projectName);
            } catch (e) {
                console.error('[executePush] project failed QP' + (p.qp.i + 1), e, projBody);
                results.failed++;
                results.errors.push(`QP${p.qp.i + 1} project: ${e.message || String(e)}`);
                continue;
            }
        }

        // 2. Tasks — one per extracted item, linked to the (new or existing)
        // project. Skip tasks whose names already exist on that project.
        if (!opts.tasks) continue;
        if (!projectId) continue;
        for (const month of p.tasksByMonth) {
            for (const t of month) {
                if (t.exists) { results.tasksSkipped++; continue; }
                const taskBody = { fields: {}, typecast: true };
                taskBody.fields[TASK_F.name] = t.name;
                taskBody.fields[TASK_F.dueDate] = t.dueISO;
                taskBody.fields[TASK_F.status] = 'Upcoming';
                taskBody.fields[TASK_F.priority] = 'Project';
                taskBody.fields[TASK_F.assignee] = { email: KEVIN_EMAIL };
                taskBody.fields[TASK_F.time] = DEFAULT_TASK_DURATION_SECONDS;
                taskBody.fields[TASK_F.business] = [businessId];
                taskBody.fields[TASK_F.projects] = [projectId];
                taskBody.fields[TASK_F.desc] = `From ${proposal.quarter} ${proposal.year} Month ${t.month} stepping stone of "${p.projectName}".`;
                try {
                    await airtableFetch(TABLES.tasks, { method: 'POST', body: JSON.stringify(taskBody) });
                    results.tasksCreated++;
                } catch (e) {
                    console.error('[executePush] task failed', t.name, e, taskBody);
                    results.failed++;
                    results.errors.push(`Task "${t.name}": ${e.message || String(e)}`);
                }
            }
        }
    }
    if (btn) btn.disabled = false;

    if (results.failed === 0) {
        const bits = [];
        if (results.projectsCreated) bits.push(`${results.projectsCreated} project${results.projectsCreated === 1 ? '' : 's'}`);
        if (results.projectsReused) bits.push(`${results.projectsReused} existing project${results.projectsReused === 1 ? '' : 's'} reused`);
        if (results.tasksCreated) bits.push(`${results.tasksCreated} task${results.tasksCreated === 1 ? '' : 's'}`);
        if (results.tasksSkipped) bits.push(`${results.tasksSkipped} task${results.tasksSkipped === 1 ? '' : 's'} skipped (already exist)`);
        setStatus('success', `✓ ${bits.join(' · ')} in Tasks & Projects OS.`);
        pushOfferDismissedForRecord = currentRecord.id;
        setTimeout(() => setStatus('', ''), 6000);
    } else {
        const bar = document.getElementById('statusBar');
        bar.className = 'status-bar error';
        bar.style.display = 'block';
        bar.innerHTML = `<div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;justify-content:space-between">
            <div>
                <div style="font-weight:600;margin-bottom:4px">Created ${results.projectsCreated} project${results.projectsCreated === 1 ? '' : 's'}, ${results.tasksCreated} task${results.tasksCreated === 1 ? '' : 's'}. ${results.failed} failed.</div>
                <div style="font-size:12px;opacity:0.9;font-family:monospace;max-height:200px;overflow-y:auto">${results.errors.map(escapeHtml).join('<br>')}</div>
            </div>
            <button class="btn btn-ghost" onclick="setStatus('', '')" style="flex-shrink:0">Dismiss</button>
        </div>`;
    }
}

// Derive a short project name from the QP textarea — first line, or first
// sentence, up to ~80 chars. Many Strategy QP entries start with a title
// then a description; grab the title.
function deriveProjectName(text) {
    const firstLine = text.split('\n').map(s => s.trim()).find(s => s) || '';
    // Strip common "Project N:" prefixes so the Projects OS name is clean.
    const stripped = firstLine.replace(/^project\s*\d+\s*[:\-–]\s*/i, '').trim();
    // Return the full name — the Task & Project Management OS renders project
    // cards with word-wrapping now, so there's no UI reason to truncate here.
    // (Previous 100-char cap was silently truncating real quarterly project names.)
    return stripped || firstLine;
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
      ask: "OBJECTIVE — the overarching reason the business exists.\n\nJust a few words on what you're ultimately trying to produce and for whom. Even one sentence is plenty. I'll turn it into a proper objective statement." },
    { id: 'targetWhat', label: 'Target — What we do', targetFid: () => OBJSTRAT.targetWhat,
      ask: "TARGET — WHAT we do.\n\nA few words on the product or service. I'll tighten it into a professional one-liner." },
    { id: 'targetWho', label: 'Target — Who we do it for', targetFid: () => OBJSTRAT.targetWho,
      ask: "TARGET — WHO we do it for.\n\nJust the rough customer type — size, stage, anything distinctive. I'll sharpen it into a targeting statement." },
    { id: 'targetHow', label: 'Target — How we do it', targetFid: () => OBJSTRAT.targetHow,
      ask: "TARGET — HOW we do it.\n\nA sentence or two on your delivery method — what's different about your approach? I'll write it up." },
    { id: 'customerProfile', label: 'Customer Profile', targetFid: () => OBJSTRAT.customerProfile,
      ask: "CUSTOMER PROFILE — who you target and who you don't.\n\nJust give me the rough shape — anything like stage, size, budget, mindset, deal-breakers. A few bullet points will do. I'll flesh it out into a proper profile." },
    // ── List sections — one question each that gathers the whole list.
    { id: 'undertakings', kind: 'list', label: 'Undertakings (team rules)', fieldIdsFn: () => OBJSTRAT.undertakings, maxItems: 20,
      ask: "UNDERTAKINGS — team non-negotiables.\n\nJust list them rough — 'own the outcome', 'tell the truth', 'data not drama', 'no drama'. Even 5–6 is fine, I'll fill in the obvious ones and structure them. If you have some set, tell me what to change ('add one about routine discipline', 'no changes').",
      descriptionForAI: "A list of non-negotiable team/culture rules for the business. Short title + 2–3 supporting bullets each." },
    { id: 'usps', kind: 'list', label: 'Original Selling Points (USPs)', fieldIdsFn: () => OBJSTRAT.usps, maxItems: 5,
      ask: "USPs — why a customer chooses you over anyone else.\n\nJust the rough claims. 'Done-for-you not coaching', 'we take equity', 'AI-first'. I'll turn them into defensible differentiators.",
      descriptionForAI: "Unique selling points. Each item: a bold claim + a short paragraph backing it up." },
    { id: 'mainMethod', kind: 'list', label: 'Main Method (step-by-step process)', fieldIdsFn: () => OBJSTRAT.methodSteps, maxItems: 10,
      ask: "MAIN METHOD — the step-by-step process you follow.\n\nJust the step names in order, even one word each. I'll write the descriptions. E.g. 'Objective, Priorities, Team, Income, Methods, Intelligence, Scoreboards, Exit-ready'.",
      descriptionForAI: "Sequential steps of the main delivery method. Each item: a short step name + a one-sentence explanation." },
    { id: 'enticement', label: 'Enticement', targetFid: () => OBJSTRAT.enticement,
      ask: "ENTICEMENT — the irresistible offer.\n\nA few words on what makes your offer hard to say no to — pricing, risk reversal, equity model, guarantee, turnaround, anything asymmetric. I'll write it up." },
    // ── Strategy plan (quarterly cadence — where most of the iteration happens.)
    { id: 'nineYear', label: 'Nine-Year Target', targetFid: () => OBJSTRAT.nineYearTarget,
      ask: "NINE-YEAR TARGET — the long vision.\n\nJust a few key numbers / facts — income, size, level of founder involvement, any exit notes. I'll turn it into a proper vision statement with business model, portfolio, delivery, team, founder role, lifestyle." },
    { id: 'threeYear', label: 'Three-Year Target', targetFid: () => OBJSTRAT.threeYearTarget,
      ask: "THREE-YEAR TARGET — the mid-range vision.\n\nA few numbers and direction markers — income, clients/units, what's automated, what the founder still does. I'll fill in the structure." },
    { id: 'threeYearM1', label: 'Three-Year Measurable 1', targetFid: () => OBJSTRAT.threeYearMeas[0],
      ask: "THREE-YEAR MEASURABLE 1 — one numeric KPI.\n\nJust the number and what it measures. E.g. '£15k/month net profit', '95% occupancy', '5 equity partnerships'. I'll write up the full target + how-to-measure." },
    { id: 'threeYearM2', label: 'Three-Year Measurable 2', targetFid: () => OBJSTRAT.threeYearMeas[1],
      ask: "THREE-YEAR MEASURABLE 2 — a DIFFERENT dimension to M1.\n\nIf M1 was money, make this systems/ops. Just the number and what it is." },
    { id: 'threeYearM3', label: 'Three-Year Measurable 3', targetFid: () => OBJSTRAT.threeYearMeas[2],
      ask: "THREE-YEAR MEASURABLE 3 — optional. Say 'skip' if you've got nothing distinct to add." },
    { id: 'oneYear', label: 'One-Year Target', targetFid: () => OBJSTRAT.oneYearTarget,
      ask: "ONE-YEAR TARGET — what the business looks like in 12 months.\n\nA few numbers and direction — income, progress towards 3-year, what systems are live. I'll write it up as a proper stepping-stone target." },
    { id: 'oneYearM1', label: 'One-Year Measurable 1', targetFid: () => OBJSTRAT.oneYearMeas[0],
      ask: "ONE-YEAR MEASURABLE 1 — one number, tracked monthly.\n\nJust the KPI and the number. E.g. '£5k/month income from Operations Director'." },
    { id: 'oneYearM2', label: 'One-Year Measurable 2', targetFid: () => OBJSTRAT.oneYearMeas[1],
      ask: "ONE-YEAR MEASURABLE 2 — a different dimension. One number + what it is." },
    { id: 'oneYearM3', label: 'One-Year Measurable 3', targetFid: () => OBJSTRAT.oneYearMeas[2],
      ask: "ONE-YEAR MEASURABLE 3 — optional. Say 'skip' if nothing distinct." },
    { id: 'qp1', label: 'Quarterly Project 1', targetFid: () => OBJSTRAT.quarterlyProjects[0],
      ask: "QUARTERLY PROJECT 1 — the #1 most important 90-day project.\n\nJust the project name + a word or two on the focus. I'll write up the full brief — deliverable, scope, success criteria — based on what you've said about the rest of the plan." },
    { id: 'qp1det', label: 'QP1 — KPI / Tracking / Definition of Done', kind: 'projectDetails', qpIndex: 0,
      ask: "QP1 — the metrics.\n\nJust the rough KPI and what 'done' looks like. E.g. 'DOD v2 complete, deployed to one client' or 'occupancy 95%'. I'll structure it into KPI name, unit, tracking method, and a full definition of done." },
    { id: 'qp1m1', label: 'QP1 — Month 1', targetFid: () => OBJSTRAT.monthlyStones[0][0],
      ask: "QP1 — Month 1 stepping stone.\n\nJust a word or two on what's tangibly done by end of month 1. I'll write the deliverable." },
    { id: 'qp1m2', label: 'QP1 — Month 2', targetFid: () => OBJSTRAT.monthlyStones[0][1],
      ask: "QP1 — Month 2 stepping stone.\n\nWhat's done by end of month 2?" },
    { id: 'qp1m3', label: 'QP1 — Month 3', targetFid: () => OBJSTRAT.monthlyStones[0][2],
      ask: "QP1 — Month 3 stepping stone (project complete state).\n\nWhat does 'done' look like?" },
    { id: 'qp2', label: 'Quarterly Project 2', targetFid: () => OBJSTRAT.quarterlyProjects[1],
      ask: "QUARTERLY PROJECT 2 — different dimension to QP1.\n\nJust the name + a word on focus. I'll write up the full brief." },
    { id: 'qp2det', label: 'QP2 — KPI / Tracking / Definition of Done', kind: 'projectDetails', qpIndex: 1,
      ask: "QP2 — the metrics. Rough KPI + what 'done' looks like. I'll structure the rest." },
    { id: 'qp2m1', label: 'QP2 — Month 1', targetFid: () => OBJSTRAT.monthlyStones[1][0],
      ask: "QP2 — Month 1 stepping stone. A word or two." },
    { id: 'qp2m2', label: 'QP2 — Month 2', targetFid: () => OBJSTRAT.monthlyStones[1][1],
      ask: "QP2 — Month 2 stepping stone." },
    { id: 'qp2m3', label: 'QP2 — Month 3', targetFid: () => OBJSTRAT.monthlyStones[1][2],
      ask: "QP2 — Month 3 stepping stone (project complete)." },
    { id: 'qp3', label: 'Quarterly Project 3', targetFid: () => OBJSTRAT.quarterlyProjects[2],
      ask: "QUARTERLY PROJECT 3 — optional. Say 'skip' if you'd rather only run two.\n\nOtherwise just the name + focus." },
    { id: 'qp3det', label: 'QP3 — KPI / Tracking / Definition of Done', kind: 'projectDetails', qpIndex: 2,
      ask: "QP3 — the metrics. Skip if no QP3. Otherwise rough KPI + 'done' state." },
    { id: 'qp3m1', label: 'QP3 — Month 1', targetFid: () => OBJSTRAT.monthlyStones[2][0],
      ask: "QP3 — Month 1 stepping stone. Skip if no QP3." },
    { id: 'qp3m2', label: 'QP3 — Month 2', targetFid: () => OBJSTRAT.monthlyStones[2][1],
      ask: "QP3 — Month 2 stepping stone." },
    { id: 'qp3m3', label: 'QP3 — Month 3', targetFid: () => OBJSTRAT.monthlyStones[2][2],
      ask: "QP3 — Month 3 stepping stone." },
];

// Max number of pushbacks the mentor is allowed per step before auto-accepting.
// Set to 1 by design — the wizard's job is to produce 90% output from 10%
// input, not interrogate the founder. Push back only when there is zero
// substance to work with.
const MAX_PUSHBACKS_PER_STEP = 1;

// localStorage key for a wizard session, scoped to business × quarter × year.
function wizSessionKey() {
    const { businessId, quarter, year } = getSelection();
    return `ostrat:wizard:${businessId}:${quarter}:${year}`;
}

// Save everything we'd need to resume a wizard — but NOT the DOM elements or
// the full Airtable prior record (we re-fetch that on resume).
// We save the current step's ID (not its numeric index) so resumes stay
// correct even if the WIZARD_STEPS array changes order or gains/loses steps
// between sessions.
function persistWizardState() {
    if (!wizardState) return;
    try {
        const currentId = WIZARD_STEPS[wizardState.stepIndex]?.id || null;
        localStorage.setItem(wizSessionKey(), JSON.stringify({
            stepId: currentId,
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

    if (saved && saved.visibleMessages?.length && (saved.stepId || typeof saved.stepIndex === 'number')) {
        // Resume — replay messages and pick up where we left off.
        // Prefer stepId (resilient to array changes); fall back to stepIndex
        // for older sessions persisted before the stepId field existed.
        let resumeIndex = 0;
        if (saved.stepId) {
            const idx = WIZARD_STEPS.findIndex(s => s.id === saved.stepId);
            resumeIndex = idx >= 0 ? idx : 0;
        } else if (typeof saved.stepIndex === 'number') {
            resumeIndex = Math.min(saved.stepIndex, WIZARD_STEPS.length - 1);
        }
        wizardState.stepIndex = resumeIndex;
        wizardState.stepHistory = saved.stepHistory || [];
        wizardState.pushbackCount = saved.pushbackCount || 0;
        saved.visibleMessages.forEach(m => appendWizMessage(m.role, m.content, { skipPersist: true }));
        const currLabel = WIZARD_STEPS[resumeIndex]?.label || 'end';
        appendWizMessage('system', `↻ Resumed from ${new Date(saved.savedAt).toLocaleTimeString()}. Step ${resumeIndex + 1}/${WIZARD_STEPS.length} · ${currLabel}. Reset session? Click 'Start over' below.`);
        addResetButton();
        loadPriorQuarter();
        return;
    }

    // Fresh wizard.
    appendWizMessage('system', "Boardroom Mentor here. Think of me as a strategic consultant — you give me 10% (a few words, rough bullets, key numbers) and I write the other 90% in the form. I won't interrogate you. Preview → approve → done. Use '← Back' to revise, 'Move on →' to skip, ✕ to close.");
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

    // Project-details step — one bulk question that captures KPI name, unit,
    // tracking method and definition of done. AI parses the free-form answer
    // into structured JSON and writes to the four Airtable fields.
    if (step.kind === 'projectDetails') {
        await handleProjectDetailsStep(step, text);
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

// After an accepted answer we show a preview of the AI-refined text and let
// the founder approve, tweak, or write their own. Only after approval does
// it actually get written to the form.
// • Empty field: show approval preview, then apply on Use.
// • Non-empty field: show merge picker (Replace / Add / Amend with AI).
function applyOrAskToMerge(step, newText) {
    if (!step.targetFid) {
        advanceStep();
        return;
    }
    const fid = step.targetFid();
    const existing = currentValueForField(fid);
    const newTrim = (newText || '').trim();
    const existingTrim = (existing || '').trim();
    // Non-empty (and not identical) → merge picker
    if (existingTrim && existingTrim !== newTrim) {
        showMergePicker(step, newText, existing);
        return;
    }
    // Empty field → show approval preview so the founder can approve / tweak
    // the AI-expanded version before it populates the form.
    showApprovalPreview(step, newText);
}

function showApprovalPreview(step, proposedText) {
    const host = document.getElementById('wizMessages');
    const wrap = document.createElement('div');
    wrap.className = 'msg system approval-preview';
    const label = 'Here\'s what I\'d write into the form:';
    wrap.innerHTML = `<div style="font-weight:600;color:var(--text-primary);margin-bottom:6px">${escapeHtml(label)}</div>
        <div style="white-space:pre-wrap;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:6px;padding:10px 12px;margin-bottom:8px;font-size:13px;line-height:1.55">${escapeHtml(proposedText)}</div>`;
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
    btnRow.appendChild(mk('Use this', () => {
        const fid = step.targetFid();
        applyFieldValueInUI(fid, proposedText);
        wizardState.answers[step.id] = proposedText;
        advanceStep();
    }));
    btnRow.appendChild(mk('Tweak it', () => {
        appendWizMessage('assistant', "OK — tell me what to change. I'll redo it.");
        // stepIndex stays put; user's next Send triggers another critique/refine
    }));
    btnRow.appendChild(mk('I\'ll write it myself', () => {
        const ta = document.getElementById('wizInput');
        ta.value = proposedText;
        ta.focus();
        appendWizMessage('assistant', "Edit in the input box and hit Send when you're happy. I'll accept it as-is.");
    }));
    wrap.appendChild(btnRow);
    host.appendChild(wrap);
    host.scrollTop = host.scrollHeight;
    if (wizardState) {
        (wizardState.visibleMessages = wizardState.visibleMessages || []).push({
            role: 'system', content: '[Approval preview] ' + proposedText + ' (Use / Tweak / Write own)'
        });
        persistWizardState();
    }
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
    wrap.innerHTML = `<div style="font-weight:600;color:var(--text-primary);margin-bottom:6px">The field already has content — how should your answer be applied?</div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;line-height:1.5">
        <strong>Replace</strong> · Discard the existing text. AI writes your answer as the new value.<br>
        <strong>Add</strong> · Keep the existing text. AI smooths your answer in as a clean addition (no duplicated facts).<br>
        <strong>Amend with AI</strong> · Treat your answer as an instruction ("change 20k to 15k", "tighten this", "add a line about X") and let AI apply it to the existing text.</div>`;
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
    btnRow.appendChild(mk('Add', async () => {
        btnRow.querySelectorAll('button').forEach(b => { b.disabled = true; });
        const merged = await aiAddContent(existingText, newText, step);
        resolveMerge(step, merged);
    }));
    btnRow.appendChild(mk('Amend with AI', async () => {
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
            role: 'system', content: '(merge picker — Replace / Add / Amend with AI was shown)'
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

// Handle a project-details wizard step — one question captures KPI name,
// KPI unit, tracking method, definition of done. AI parses the free-form
// answer into structured JSON and writes to the four target fields.
async function handleProjectDetailsStep(step, answer) {
    const det = OBJSTRAT.qpDetails[step.qpIndex];
    if (/^(skip|none|pass|no)$/i.test(answer.trim())) {
        appendWizMessage('assistant', 'Skipping project details.');
        advanceStep();
        return;
    }
    appendWizMessage('assistant', 'Structuring…');
    const parsed = await boardroomParseProjectDetails(step, answer);
    if (!parsed) {
        appendWizMessage('assistant', "I couldn't structure that cleanly. Moving on — you can edit the KPI / Tracking / DoD inline in the form.");
        advanceStep();
        return;
    }
    const prev = {
        kpiName: currentValueForField(det.kpiName),
        kpiUnit: extractSelectName(document.querySelector(`[data-field-id="${det.kpiUnit}"]`)?.value) || '',
        tracking: currentValueForField(det.tracking),
        dod: currentValueForField(det.dod),
    };
    showProjectDetailsPreview(step, parsed, prev);
}

function showProjectDetailsPreview(step, parsed, previous) {
    const det = OBJSTRAT.qpDetails[step.qpIndex];
    const host = document.getElementById('wizMessages');
    const wrap = document.createElement('div');
    wrap.className = 'msg system';
    const preview = `Proposed for Project ${step.qpIndex + 1}:\n\n• KPI: ${parsed.kpiName || '—'}${parsed.kpiUnit ? ' (' + parsed.kpiUnit + ')' : ''}${parsed.kpiTarget ? ' · target ' + parsed.kpiTarget : ''}\n• Tracking: ${parsed.trackingMethod || '—'}\n• Definition of Done: ${parsed.definitionOfDone || '—'}`;
    wrap.textContent = preview;
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
    btnRow.appendChild(mk('Apply', () => {
        applyFieldValueInUI(det.kpiName, parsed.kpiName || '');
        const unitEl = document.querySelector(`[data-field-id="${det.kpiUnit}"]`);
        if (unitEl) { unitEl.value = parsed.kpiUnit || ''; markDirty(); }
        applyFieldValueInUI(det.tracking, parsed.trackingMethod || '');
        applyFieldValueInUI(det.dod, parsed.definitionOfDone || '');
        appendWizMessage('assistant', 'Applied.');
        advanceStep();
    }));
    btnRow.appendChild(mk('Revise', () => {
        appendWizMessage('assistant', 'OK — tell me what to change and I\'ll rework it.');
    }));
    btnRow.appendChild(mk('Keep existing', () => {
        appendWizMessage('assistant', 'No changes applied.');
        advanceStep();
    }));
    wrap.appendChild(btnRow);
    host.appendChild(wrap);
    host.scrollTop = host.scrollHeight;
    if (wizardState) {
        (wizardState.visibleMessages = wizardState.visibleMessages || []).push({ role: 'system', content: preview + ' (pending choice)' });
        persistWizardState();
    }
}

async function boardroomParseProjectDetails(step, answer) {
    const system = buildCachedWizardSystem(
        `Strategy Plan OS — ${wizardState.businessName}. Parsing Project ${step.qpIndex + 1} metadata.`,
        `Parse the founder's answer into structured project metadata.

Return a JSON object ONLY — no commentary, no code fence:
{
  "kpiName": "short KPI name (e.g. 'Monthly recurring revenue')",
  "kpiUnit": one of: "£", "%", "count", "days", "items", "hours" — pick the best match, or "" if none fits,
  "kpiTarget": "optional — a specific numeric target mentioned, as a number. Omit if not given.",
  "trackingMethod": "how it's tracked: source, frequency, owner — tidy the founder's wording, UK English",
  "definitionOfDone": "the end state that means the project is done — tidy the founder's wording, UK English"
}

Rules:
- Preserve every specific number, name, and claim the founder gave.
- Tidy for grammar/flow. UK English.
- If a field isn't addressed in the answer, return an empty string for it (not null).`
    );
    try {
        const res = await fetch(AI_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1500,
                system,
                messages: [{ role: 'user', content: answer }],
            }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        const raw = (data.content?.[0]?.text || '').trim();
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return null;
        return JSON.parse(match[0]);
    } catch (e) { return null; }
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
                model: 'claude-sonnet-4-20250514',
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

// ADD mode — keep the existing content intact, append the founder's new
// content so it flows naturally. AI only cleans up the seam and tidies
// grammar; it does NOT modify the existing content and does NOT treat the
// input as an instruction.
async function aiAddContent(existing, addition, step) {
    const system = buildCachedWizardSystem(
        `Strategy Plan OS — ${wizardState.businessName}. Appending new content to an existing field.`,
        `The founder has EXISTING text for "${step.label}" and NEW content they want added to it.

Your job: return the full final text with the new content appended naturally.

RULES:
- Keep every word of the existing text UNCHANGED. Do not rephrase, condense, or edit it.
- Append the new content beneath it. Add a blank line, a transition phrase, or a new bullet if that fits the structure; otherwise just a paragraph break.
- Tidy only the new content for grammar and UK English. Do not touch the existing text.
- Avoid duplicating facts already stated in the existing text — if the new content repeats a point verbatim, drop the duplicate.
- Match the structure of the existing text: if it's bulleted, add as a new bullet; if paragraphs, add as a new paragraph.
- Return the full final text ONLY. No explanation. No quotes. No markdown code fences.`
    );
    try {
        const res = await fetch(AI_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 2000,
                system,
                messages: [
                    { role: 'user', content: `EXISTING TEXT (keep exactly as-is):\n"""\n${existing}\n"""\n\nNEW CONTENT TO ADD (tidy and append):\n"""\n${addition}\n"""\n\nReturn the full final text only.` },
                ],
            }),
        });
        if (!res.ok) return existing.trimEnd() + '\n\n' + addition;
        const data = await res.json();
        let out = (data.content?.[0]?.text || '').trim();
        out = out.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
        out = out.replace(/^"""\n?|\n?"""$/g, '');
        return out || (existing.trimEnd() + '\n\n' + addition);
    } catch (e) { return existing.trimEnd() + '\n\n' + addition; }
}

async function aiMerge(existing, userInput, step) {
    const system = buildCachedWizardSystem(
        `Strategy Plan OS — ${wizardState.businessName}. Applying a founder's instruction to an existing field.`,
        `You have the EXISTING text for "${step.label}" and an INSTRUCTION from the founder. Your job is to return the full UPDATED text after applying the instruction.

The instruction may be one of these kinds — figure out which before responding:

1. EDIT — the founder wants a specific change to the existing text. Examples:
   - "change 20–25k to 15–20k"
   - "replace HMOs with serviced accommodation"
   - "remove the bit about AI agents"
   - "tighten the third paragraph"
   → Apply the change to the existing text. Change ONLY what was requested. Everything else stays identical.

2. ADDITION — the founder is adding a new sentence, bullet, or idea. Examples:
   - "also include that we're expanding to Scotland"
   - "add a line about equity partnerships"
   → Incorporate it where it fits naturally. Do not rewrite surrounding material.

3. REWRITE — the founder wants the whole thing recast. Examples:
   - "make it punchier"
   - "rewrite this in first person"
   - "shorten to 3 bullets"
   → Rewrite accordingly, preserving every number, name, and claim.

RULES:
- Return the full final text of the field. Not a diff. Not a "before/after". Not an explanation. Not JSON. Just the text.
- UK English. Clean grammar and punctuation.
- Preserve every specific number, date, and name that the founder did NOT explicitly ask you to change.
- Keep the structure (bullets / paragraphs / headings) unless asked to change it.
- Never invent new facts. If the instruction is ambiguous about what to keep, keep it.
- Do not prepend any framing like "Here's the updated text:" — output the text directly.`
    );
    try {
        const res = await fetch(AI_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 2000,
                system,
                messages: [
                    { role: 'user', content: `EXISTING TEXT:\n"""\n${existing}\n"""\n\nFOUNDER'S INSTRUCTION:\n"""\n${userInput}\n"""\n\nReturn the full updated text only.` },
                ],
            }),
        });
        if (!res.ok) return existing.trimEnd() + '\n\n' + userInput;
        const data = await res.json();
        let out = (data.content?.[0]?.text || '').trim();
        // Strip any common wrappers the model might slip in despite instructions.
        out = out.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
        out = out.replace(/^"""\n?|\n?"""$/g, '');
        return out || (existing.trimEnd() + '\n\n' + userInput);
    } catch (e) { return existing.trimEnd() + '\n\n' + userInput; }
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
    // CURRENT PLAN — what's in the form RIGHT NOW (including any edits the
    // founder has already made in this session). This is the source of truth
    // for "this quarter's plan". The prior quarter is background only.
    const currentPlanSnapshot = extractCurrentPlanFromForm();
    const currentContext = Object.keys(currentPlanSnapshot).some(k => currentPlanSnapshot[k])
        ? `\n\nCURRENT PLAN STATE (these are the founder's latest edits in this session — THIS is the source of truth for context, not the prior quarter): ${JSON.stringify(currentPlanSnapshot)}`
        : '';
    const priorContext = wizardState.priorRecord
        ? `\n\nPRIOR QUARTER'S RECORD (background reference only — use for reflection, but do NOT quote its numbers or claims unless the founder has confirmed them for this quarter too): ${JSON.stringify(extractCompactPrior(wizardState.priorRecord))}`
        : '\n\nNo prior quarter record.';
    const reflectionContext = wizardState.reflection
        ? `\n\nFOUNDER'S REFLECTION ON LAST QUARTER (their own words): "${wizardState.reflection}"`
        : '';
    const attemptCount = history.filter(m => m.role === 'user').length;
    const system = buildCachedWizardSystem(
        `Strategy Plan OS — ${wizardState.businessName}.${currentContext}${priorContext}${reflectionContext}`,
        `You are interviewing the founder to build this quarter's strategy plan, one field at a time.

Section: "${step.label}"
Question you asked: "${step.ask}"
This is the founder's attempt #${attemptCount} at answering.

CORE PHILOSOPHY — 10% INPUT, 90% OUTPUT.
The founder is giving you 10%. Your job — as the Boardroom Mentor — is to produce the other 90%. Think of yourself as a top-tier strategic consultant who has been briefed on the business and is now drafting the plan document. The founder will approve or tweak what you write; your job is to write it, not to interrogate them. Draw on:
- Their input in this step (the 10%)
- The CURRENT PLAN STATE already filled in (everything else they've said this session)
- The PRIOR QUARTER'S RECORD (for reflection, not for lifting content)
- The FOUNDER'S REFLECTION if given
- Your domain expertise in business operating systems, portfolio strategy, and the mentor playbook

GUIDING PRINCIPLE — ACCEPT AND EXPAND.
Accept ANY answer that has any substance at all — even a single sentence, a few bullets, or a fragment is enough. Your refined output does the heavy lifting. Push back ONLY if the answer has literally zero substance — e.g. pure platitudes ("be amazing", "crush it") or a refusal. A terse one-liner with a real fact in it (a number, a name, a direction) is plenty. Expand it into a full professional section.

MAX 1 PUSH-BACK.
After one push-back (if any), ALWAYS accept and produce rich output from what you have. Do not ask for more.

IMPORTANT: Look at the full conversation above. If you've already pushed back, DO NOT push back again. Accept and refine.

Reply with a JSON object ONLY, nothing else. Shape:
{"accept": true|false, "pushback"?: "one short paragraph (2–3 sentences max) in UK English, naming one specific thing to add or sharpen — never repeat a point you've already made", "refined"?: "a fully-developed, professional-quality version of the founder's answer — see rules below — MUST be included on every accept", "note"?: "one short confirmation line after accept, optional"}

"refined" RULES (REQUIRED on every accept) — this is the heart of the tool. The founder is likely dictating or bullet-pointing; your job is to turn that raw material into something they'd be proud to put in a strategic plan document.

0. CUMULATIVE ANSWER — CRITICAL. On attempt 2 or later (after you've pushed back), the founder is ADDING TO or CLARIFYING their earlier answer, not replacing it. The refined output MUST combine every fact, number, name, claim, and substantial point from ALL of the founder's messages in this conversation — not just the latest. Treat the whole conversation as ONE BUILDING ANSWER. Example: if their first message said "£20–25k/month net profit from UK property" and their second message (replying to your push-back on delivery model) said "long-term buy-and-hold HMOs and single lets", the refined version must include BOTH — the income figure AND the delivery model — in a single coherent output. Dropping either half is a failure on your part.

1. EXPAND rough input. If the founder gave bullets, a rough paragraph, or conversational dictation, write it up as proper prose or a structured list with headings/bullets — whatever fits the section. Don't just tidy commas.
2. APPLY your expertise. Frame the answer the way the Boardroom Mentor would — bringing the right business-planning structure (mission vs vision vs target, outcome vs activity, input vs output metric, etc.). Give it the weight a professional plan deserves.
3. PRESERVE every specific fact. Every number, currency, percentage, count, name, product, timeframe, person, and place the founder gave you MUST appear in the refined version unchanged. You may re-word around them; you may not alter or drop them.
4. NEVER invent facts. If the founder didn't say a specific number or name, don't add one. If they said "20–25k", don't write "£22k". If they said "a few clients", don't write "5 clients". Use their own numbers verbatim.
5. UK English spelling, grammar, punctuation.
6. Match the expected shape of the field:
   - Nine-year / three-year / one-year Target: paragraph + bullet-structured sub-sections (Business Model, Portfolio, Delivery, Team, Founder Role, etc.) when the founder gave enough substance for that.
   - Measurables: tight numeric target + "how we measure it" line.
   - Objective / Customer Profile / Enticement: one well-crafted paragraph.
   - Target Statement parts: one tight sentence each.
   - Quarterly Projects: name + focus + success criteria, 2–4 short lines.
   - Monthly stepping stones: one concrete deliverable per month, one sentence each.
7. If the founder's answer was already polished and professional, return it verbatim.

CONTEXT: The founder is likely dictating on a phone or typing rough bullets. Treat the input as raw material. Do not penalise them for informal phrasing, missing capitalisation, or incomplete sentences — that's the RAW INPUT. Your job is to turn it into publication-quality output.

Do not accept pure platitudes ('be the best', 'crush it'). DO accept rough or terse answers if they have any real substance — your job is to build them up, not reject them. Prefer 'accept with a good refined expansion' over 'reject'. Push back only when the answer has no substance at all.`
    );
    try {
        const res = await fetch(AI_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 2500,
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

// Snapshot the form fields the wizard might reference as context. Pulls from
// the actual DOM inputs/textareas, so any edits the founder has made in this
// session (whether via the wizard or typed directly into the form) are
// reflected. Returns a compact object — only the fields the mentor needs for
// cross-referencing, not the full 60+ field record.
function extractCurrentPlanFromForm() {
    const read = fid => {
        const el = document.querySelector(`[data-field-id="${fid}"]`);
        if (!el) return '';
        const v = (el.value || '').trim();
        return v || '';
    };
    return {
        objective: read(OBJSTRAT.objective),
        targetWhat: read(OBJSTRAT.targetWhat),
        targetWho: read(OBJSTRAT.targetWho),
        targetHow: read(OBJSTRAT.targetHow),
        customerProfile: read(OBJSTRAT.customerProfile),
        enticement: read(OBJSTRAT.enticement),
        nineYearTarget: read(OBJSTRAT.nineYearTarget),
        threeYearTarget: read(OBJSTRAT.threeYearTarget),
        threeYearMeas: OBJSTRAT.threeYearMeas.map(read).filter(Boolean),
        oneYearTarget: read(OBJSTRAT.oneYearTarget),
        oneYearMeas: OBJSTRAT.oneYearMeas.map(read).filter(Boolean),
        quarterlyProjects: OBJSTRAT.quarterlyProjects.map(read).filter(Boolean),
        monthlyStones: OBJSTRAT.monthlyStones.map(stones => stones.map(read).filter(Boolean)),
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

// ═════════════════════════════════════════════════════════════════════
// PDF EXPORT — build a purpose-made printable layout from the loaded
// record (not a screenshot of the form) so the output is professional,
// branded, and doesn't include nav chrome or wizard panels. Uses
// html2pdf.js from CDN.
// ═════════════════════════════════════════════════════════════════════

async function exportPlanToPDF() {
    if (!currentRecord) {
        setStatus('warn', 'Save the plan first, then export.');
        return;
    }
    if (typeof html2pdf === 'undefined') {
        setStatus('error', 'PDF library failed to load. Check your connection and retry.');
        return;
    }
    const { businessId, quarter, year } = getSelection();
    const businessName = allBusinessesLocal.find(b => b.id === businessId)?.name || 'Business';
    // Use the live form values (not currentRecord.fields) so the PDF reflects
    // what's on screen — avoids any field-key / staleness issues.
    const fieldData = readAllFormFields();
    const doc = buildPrintableDocument(fieldData, businessName, quarter, year);

    // Full-screen blocker so the founder doesn't see the staging element
    // flash in and out of view while html2canvas is rendering.
    const blocker = document.createElement('div');
    blocker.id = 'pdf-blocker';
    blocker.style.cssText = 'position:fixed;inset:0;background:rgba(28,36,34,0.75);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-size:16px;font-weight:600;gap:14px;font-family:Inter,system-ui,sans-serif';
    blocker.innerHTML = '<div class="spinner" style="width:36px;height:36px;border:3px solid rgba(255,255,255,0.25);border-top-color:#fff;border-radius:50%;animation:spin 0.8s linear infinite"></div><div>Building your PDF…</div>';
    document.body.appendChild(blocker);

    // Staging container — html2canvas requires the element to be in the
    // viewport, so we position it top-left at z-index just below the blocker.
    // Width 794px = A4 portrait at 96 DPI.
    const stage = document.createElement('div');
    stage.style.cssText = 'position:fixed;top:0;left:0;width:794px;background:#fff;color:#1C2422;font-family:Inter,system-ui,sans-serif;z-index:9999;overflow:visible';
    stage.appendChild(doc);
    document.body.appendChild(stage);

    try {
        const fileName = `${slugify(businessName)}-${quarter}-${year}-plan.pdf`;
        await html2pdf()
            .set({
                margin: [14, 14, 18, 14],
                filename: fileName,
                pagebreak: { mode: ['css', 'legacy'], avoid: ['.pdf-section', '.pdf-card', '.pdf-qp', '.num-row'] },
                html2canvas: {
                    scale: 2,
                    useCORS: true,
                    letterRendering: true,
                    backgroundColor: '#FFFFFF',
                    // Force a consistent rendering window so content doesn't clip.
                    windowWidth: 794,
                    scrollX: 0,
                    scrollY: 0,
                },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            })
            .from(stage)
            .save();
        setStatus('success', `✓ ${fileName} downloaded.`);
        setTimeout(() => setStatus('', ''), 3000);
    } catch (e) {
        console.error('[exportPlanToPDF]', e);
        setStatus('error', `PDF export failed: ${e.message || e}. Check the console for details.`);
    } finally {
        if (stage.parentNode) stage.parentNode.removeChild(stage);
        if (blocker.parentNode) blocker.parentNode.removeChild(blocker);
    }
}

function buildPrintableDocument(f, businessName, quarter, year) {
    const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    // Helpers
    const esc = escapeHtml;
    const para = v => (v || '').trim();
    const nonEmpty = v => !!(v && String(v).trim());
    const readSel = v => (v && typeof v === 'object') ? (v.name || '') : (v || '');
    const mdToHtml = md => {
        // Render line-breaks + very light markdown (bold, bullets, headers) to nice HTML.
        const lines = String(md || '').split('\n');
        const out = [];
        let inList = false;
        for (let raw of lines) {
            let line = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            const isBullet = /^[•\-*]\s+/.test(line) || /^\d+\.\s+/.test(line);
            if (isBullet) {
                if (!inList) { out.push('<ul>'); inList = true; }
                out.push('<li>' + line.replace(/^[•\-*]\s+/, '').replace(/^\d+\.\s+/, '') + '</li>');
            } else {
                if (inList) { out.push('</ul>'); inList = false; }
                if (line.trim()) out.push('<p>' + line + '</p>');
            }
        }
        if (inList) out.push('</ul>');
        return out.join('');
    };

    const root = document.createElement('div');
    root.className = 'pdf-root';
    root.innerHTML = `
<style>
.pdf-root { padding: 16px 20px; }
.pdf-root * { box-sizing: border-box; }
.pdf-cover { text-align: left; padding: 28px 20px 40px; border-bottom: 4px solid #2C6E49; margin-bottom: 30px; }
.pdf-cover .eyebrow { font-size: 11px; letter-spacing: 3px; color: #5A6660; text-transform: uppercase; font-weight: 600; margin-bottom: 8px; }
.pdf-cover h1 { font-size: 36px; font-weight: 800; margin-bottom: 4px; color: #1C2422; letter-spacing: -0.5px; }
.pdf-cover .subtitle { font-size: 18px; color: #5A6660; margin-bottom: 18px; font-weight: 500; }
.pdf-cover .meta { display: flex; gap: 28px; font-size: 12px; color: #5A6660; }
.pdf-cover .meta strong { display: block; font-size: 15px; color: #1C2422; font-weight: 700; }
.pdf-section { margin-bottom: 22px; page-break-inside: avoid; }
.pdf-section h2 { font-size: 17px; font-weight: 700; color: #2C6E49; border-bottom: 2px solid #DDE8DF; padding-bottom: 4px; margin-bottom: 12px; }
.pdf-section h3 { font-size: 13px; font-weight: 700; color: #1C2422; margin-top: 10px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em; }
.pdf-card { background: #FBFBF9; border: 1px solid #DDE1D9; border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; page-break-inside: avoid; }
.pdf-card .card-label { font-size: 10px; color: #8A928C; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; margin-bottom: 4px; }
.pdf-card .card-value { font-size: 12px; color: #1C2422; line-height: 1.55; }
.pdf-card .card-value p { margin-bottom: 6px; }
.pdf-card .card-value p:last-child { margin-bottom: 0; }
.pdf-card .card-value ul { margin-left: 16px; margin-bottom: 4px; }
.pdf-card .card-value li { margin-bottom: 2px; }
.pdf-cols-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
.pdf-qp { background: #FBFBF9; border: 1px solid #DDE1D9; border-radius: 8px; padding: 12px; page-break-inside: avoid; }
.pdf-qp h3 { font-size: 12px; color: #2C6E49; margin-top: 0; margin-bottom: 6px; }
.pdf-qp .qp-body { font-size: 11px; line-height: 1.5; color: #1C2422; margin-bottom: 8px; }
.pdf-qp .qp-meta { font-size: 10px; color: #5A6660; margin-bottom: 6px; }
.pdf-qp .qp-meta strong { color: #1C2422; }
.pdf-qp .qp-stones { margin-top: 6px; padding-top: 6px; border-top: 1px dashed #DDE1D9; }
.pdf-qp .qp-stones .stone-row { display: flex; gap: 6px; margin-bottom: 3px; font-size: 10px; }
.pdf-qp .qp-stones .stone-m { font-weight: 700; color: #2C6E49; min-width: 26px; }
.pdf-num-list { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pdf-num-list .num-row { background: #FBFBF9; border: 1px solid #DDE1D9; border-radius: 6px; padding: 6px 10px; font-size: 11px; line-height: 1.45; page-break-inside: avoid; }
.pdf-num-list .num-row .n { font-weight: 700; color: #2C6E49; margin-right: 6px; }
.pdf-footer { margin-top: 26px; padding-top: 10px; border-top: 1px solid #DDE1D9; font-size: 10px; color: #8A928C; text-align: center; }
.page-break { page-break-after: always; }
</style>

<div class="pdf-cover">
  <div class="eyebrow">Objective &amp; Strategy Plan</div>
  <h1>${esc(businessName)}</h1>
  <div class="subtitle">${esc(quarter)} ${esc(year)}</div>
  <div class="meta">
    <div><strong>${esc(quarter)}</strong>Quarter</div>
    <div><strong>${esc(year)}</strong>Year</div>
    <div><strong>${esc(today)}</strong>Generated</div>
  </div>
</div>

${nonEmpty(f[OBJSTRAT.objective]) ? `
<div class="pdf-section">
  <h2>Objective</h2>
  <div class="pdf-card"><div class="card-value">${mdToHtml(f[OBJSTRAT.objective])}</div></div>
</div>` : ''}

${(nonEmpty(f[OBJSTRAT.targetWhat]) || nonEmpty(f[OBJSTRAT.targetWho]) || nonEmpty(f[OBJSTRAT.targetHow])) ? `
<div class="pdf-section">
  <h2>Target Statement</h2>
  <div class="pdf-cols-3">
    <div class="pdf-card"><div class="card-label">What we do</div><div class="card-value">${mdToHtml(f[OBJSTRAT.targetWhat])}</div></div>
    <div class="pdf-card"><div class="card-label">Who we do it for</div><div class="card-value">${mdToHtml(f[OBJSTRAT.targetWho])}</div></div>
    <div class="pdf-card"><div class="card-label">How we do it</div><div class="card-value">${mdToHtml(f[OBJSTRAT.targetHow])}</div></div>
  </div>
</div>` : ''}

${nonEmpty(f[OBJSTRAT.customerProfile]) ? `
<div class="pdf-section">
  <h2>Customer Profile</h2>
  <div class="pdf-card"><div class="card-value">${mdToHtml(f[OBJSTRAT.customerProfile])}</div></div>
</div>` : ''}

${(() => {
    const items = OBJSTRAT.undertakings.map(fid => f[fid]).filter(nonEmpty);
    if (!items.length) return '';
    return `<div class="pdf-section"><h2>Undertakings</h2><div class="pdf-num-list">${items.map((t, i) =>
        `<div class="num-row"><span class="n">${String(i + 1).padStart(2, '0')}</span>${mdToHtml(t)}</div>`
    ).join('')}</div></div>`;
})()}

${(() => {
    const items = OBJSTRAT.usps.map(fid => f[fid]).filter(nonEmpty);
    if (!items.length) return '';
    return `<div class="pdf-section"><h2>Original Selling Points</h2><div class="pdf-num-list">${items.map((t, i) =>
        `<div class="num-row"><span class="n">${String(i + 1).padStart(2, '0')}</span>${mdToHtml(t)}</div>`
    ).join('')}</div></div>`;
})()}

${(() => {
    const items = OBJSTRAT.methodSteps.map(fid => f[fid]).filter(nonEmpty);
    if (!items.length) return '';
    return `<div class="pdf-section"><h2>Main Method</h2><div class="pdf-num-list">${items.map((t, i) =>
        `<div class="num-row"><span class="n">${String(i + 1).padStart(2, '0')}</span>${mdToHtml(t)}</div>`
    ).join('')}</div></div>`;
})()}

${nonEmpty(f[OBJSTRAT.enticement]) ? `
<div class="pdf-section">
  <h2>Enticement</h2>
  <div class="pdf-card"><div class="card-value">${mdToHtml(f[OBJSTRAT.enticement])}</div></div>
</div>` : ''}

<div class="page-break"></div>

${nonEmpty(f[OBJSTRAT.nineYearTarget]) ? `
<div class="pdf-section">
  <h2>Nine-Year Target</h2>
  <div class="pdf-card"><div class="card-value">${mdToHtml(f[OBJSTRAT.nineYearTarget])}</div></div>
</div>` : ''}

${nonEmpty(f[OBJSTRAT.threeYearTarget]) ? `
<div class="pdf-section">
  <h2>Three-Year Target</h2>
  <div class="pdf-card"><div class="card-value">${mdToHtml(f[OBJSTRAT.threeYearTarget])}</div></div>
  <div class="pdf-cols-3">
    ${OBJSTRAT.threeYearMeas.map((fid, i) => nonEmpty(f[fid]) ?
      `<div class="pdf-card"><div class="card-label">Measurable ${i + 1}</div><div class="card-value">${mdToHtml(f[fid])}</div></div>` : ''
    ).join('')}
  </div>
</div>` : ''}

${nonEmpty(f[OBJSTRAT.oneYearTarget]) ? `
<div class="pdf-section">
  <h2>One-Year Target</h2>
  <div class="pdf-card"><div class="card-value">${mdToHtml(f[OBJSTRAT.oneYearTarget])}</div></div>
  <div class="pdf-cols-3">
    ${OBJSTRAT.oneYearMeas.map((fid, i) => nonEmpty(f[fid]) ?
      `<div class="pdf-card"><div class="card-label">Measurable ${i + 1}</div><div class="card-value">${mdToHtml(f[fid])}</div></div>` : ''
    ).join('')}
  </div>
</div>` : ''}

${(() => {
    const qps = OBJSTRAT.quarterlyProjects.map((fid, i) => ({ i, text: f[fid] })).filter(q => nonEmpty(q.text));
    if (!qps.length) return '';
    return `<div class="pdf-section"><h2>Quarterly Priority Projects</h2><div class="pdf-cols-3">${qps.map(q => {
        const d = OBJSTRAT.qpDetails[q.i];
        const stones = OBJSTRAT.monthlyStones[q.i];
        const unit = readSel(f[d.kpiUnit]);
        return `<div class="pdf-qp">
            <h3>⭐ Project ${q.i + 1}</h3>
            <div class="qp-body">${mdToHtml(q.text)}</div>
            ${nonEmpty(f[d.kpiName]) ? `<div class="qp-meta"><strong>KPI:</strong> ${esc(f[d.kpiName])}${unit ? ' (' + esc(unit) + ')' : ''}</div>` : ''}
            ${nonEmpty(f[d.tracking]) ? `<div class="qp-meta"><strong>Tracking:</strong> ${esc(f[d.tracking])}</div>` : ''}
            ${nonEmpty(f[d.dod]) ? `<div class="qp-meta"><strong>Definition of Done:</strong> ${esc(f[d.dod])}</div>` : ''}
            <div class="qp-stones">
                ${stones.map((sFid, m) => nonEmpty(f[sFid]) ?
                    `<div class="stone-row"><span class="stone-m">M${m + 1}</span><span>${esc(f[sFid])}</span></div>` : ''
                ).join('')}
            </div>
        </div>`;
    }).join('')}</div></div>`;
})()}

<div class="pdf-footer">
  Generated ${esc(today)} · Objective &amp; Strategy Plan · ${esc(businessName)} · ${esc(quarter)} ${esc(year)}
</div>`;
    return root;
}
