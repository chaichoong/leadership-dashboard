// KPI Library — ADMIN ONLY tab (Leadership section).
//
// The catalogue of ready-made KPI templates a client picks from when their
// leadership dashboard is built. Seeded 1 Aug 2026 from a full harvest of
// every metric this platform already computes (docs/kpi-library-spec.md is
// the source of truth for the seed; this page renders it and enriches it
// with what is LIVE right now from the Projects table).
//
// ADMIN ONLY: this tab must never appear in a client tenant's shell. Today
// the whole GitHub Pages build is Kevin's private admin build, so hiding is
// inherent; the `adminOnly: true` flag on the PAGE_REGISTRY entry is the
// contract the Supabase migration must honour when real client shells exist.
//
// KPI_LIBRARY below is THE CANONICAL LIBRARY (the spec doc holds rationale).
// Three things keep it honest: the health check on this page flags any live
// KPI without a template on every open; the daily kpi-library-coverage
// invariant (scripts/check-data-invariants.py, run by the prod sweep) does
// the same without needing a browser and PARSES THIS ARRAY — keep the
// `name:`/`how:` single-quoted literal format or its parser fails loudly;
// and the CLAUDE.md rule requires new KPI compute code to ship its library
// entry in the same commit.

// ── The ten computation shapes ──────────────────────────────────────────
const KPI_SHAPES = [
    { id: 'T1',  name: 'Sum of transactions',        blanks: 'category · business · window · signed' },
    { id: 'T2',  name: 'Sum A minus sum B',          blanks: 'two sum configs · window' },
    { id: 'T3',  name: 'Count of matching records',  blanks: 'table · filters · date bounds' },
    { id: 'T4',  name: 'Ratio × 100',                blanks: 'numerator · denominator' },
    { id: 'T5',  name: 'Sum of a field',             blanks: 'table · field · filters' },
    { id: 'T6',  name: 'Funnel-stage count',         blanks: 'status field · ordered stages · threshold' },
    { id: 'T7',  name: 'Task completion on project', blanks: 'project (auto) · optional name match' },
    { id: 'T8',  name: 'Age / staleness',            blanks: 'date field · filters · max or average' },
    { id: 'T9',  name: 'Balance snapshot sum',       blanks: 'account set (tenant setting)' },
    { id: 'T10', name: 'Target wrapper',             blanks: 'any shape · target · direction · bands' },
];

// ── The seed library ────────────────────────────────────────────────────
// status: 'live' = running with compute code on Kevin's projects today;
//         'ready' = shape proven elsewhere in the platform, template is a lift;
//         'setting' = needs a per-tenant setting first (the de-Kevin list);
//         'blocked' = known defect must be fixed before a client ever sees it.
const KPI_LIBRARY = [
    // Tier 1 — generic core (ships with the spine)
    { tier: 1, group: 'Money', name: 'Monthly Recurring Revenue', shape: 'T1', status: 'live',
      how: 'Fixed-income category for the business, calendar month, signed so refunds net off.' },
    { tier: 1, group: 'Money', name: 'Revenue (period)', shape: 'T1', status: 'ready',
      how: 'Revenue categories over a chosen window. Same engine as the P&L revenue line.' },
    { tier: 1, group: 'Money', name: 'Cash collected', shape: 'T1', status: 'live',
      how: 'Revenue category + business inside the quarter. The "first cash through the door" KPI.' },
    { tier: 1, group: 'Money', name: 'Operating cushion (cash)', shape: 'T2', status: 'live',
      how: 'Income sums minus cost-linked sums over a rolling 31 days, reversal-aware.' },
    { tier: 1, group: 'Money', name: 'Monthly fixed costs', shape: 'T5', status: 'ready',
      how: 'Expected amount over active cost records — the AP Fixed headline.' },
    { tier: 1, group: 'Money', name: 'Net profit and margins', shape: 'T2', status: 'setting',
      how: 'P&L section sums. Needs the per-tenant chart-of-accounts mapping (today the section lists are hardcoded to Kevin\'s sub-categories).' },
    { tier: 1, group: 'Money', name: 'Cash balance', shape: 'T9', status: 'setting',
      how: 'Sum of chosen account balances. Needs the per-tenant account set (today two account record IDs are hardcoded).' },
    { tier: 1, group: 'Money', name: 'Safe to act today', shape: 'T2', status: 'setting',
      how: 'Balance minus protective floor minus uncovered costs. Flagship number; account set, wages float and reliability haircut become tenant settings.' },
    { tier: 1, group: 'Money', name: 'Outstanding / overdue invoices', shape: 'T5', status: 'ready',
      how: 'Sum and count over unpaid outbound invoices, overdue split by due date.' },
    { tier: 1, group: 'Money', name: 'Average days overdue', shape: 'T8', status: 'ready',
      how: 'Mean age past due across overdue invoices.' },
    { tier: 1, group: 'Work', name: 'Task completion %', shape: 'T7', status: 'live',
      how: 'Completed over total tasks on the project. Warning from the Q2 close: self-referential as a definition of done — pair it with an external-outcome KPI.' },
    { tier: 1, group: 'Work', name: 'Completed tasks (name-matched)', shape: 'T7', status: 'live',
      how: 'Counts completed tasks whose name matches a phrase — "rehearsal", "pack". Moves on its own when the team completes real work.' },
    { tier: 1, group: 'Work', name: 'Active / overdue task counts', shape: 'T3', status: 'ready',
      how: 'Open tasks, optionally overdue-only, for a project or the whole business.' },
    { tier: 1, group: 'Work', name: 'Work done by AI %', shape: 'T4', status: 'live',
      how: 'Estimated minutes of AI work over estimated minutes of all work, on tasks completed in the window. Time-weighted, never task counts: fifty 15-minute triages is not one 8-hour build. AI work means an agent on Team Member (agents cannot hold the Assignee collaborator field) OR work an agent raised that the owner approved first time — but NEVER work the owner sent back, which is the owner\'s hour however the links read. Publish coverage (share of completed tasks carrying a time estimate) beside it; the number is only as good as that, and completed tasks must be swept for estimates or they are invisible to both sides.' },
    { tier: 1, group: 'Work', name: 'Team utilisation %', shape: 'T4', status: 'setting',
      how: 'Allocated hours over capacity. BLOCKED on moving capacity out of localStorage into a tenant settings table.' },
    { tier: 1, group: 'Sales & growth', name: 'Prospects contacted', shape: 'T6', status: 'live',
      how: 'Prospects whose status has reached the contact stage or beyond in an ordered funnel.' },
    { tier: 1, group: 'Sales & growth', name: 'Funnel stage counts + conversion', shape: 'T4', status: 'ready',
      how: 'Counts per funnel stage plus found-to-call rate.' },
    { tier: 1, group: 'Sales & growth', name: 'Calls booked / attended', shape: 'T3', status: 'ready',
      how: 'The north-star pattern from the content playbook: judged on attended, not impressions.' },
    { tier: 1, group: 'Sales & growth', name: 'Pipeline value by stage', shape: 'T5', status: 'ready',
      how: 'Sum of deal values per CRM stage (Supabase side).' },
    { tier: 1, group: 'AI workforce', name: 'Agent accuracy %', shape: 'T4', status: 'setting',
      how: 'Per agent per task type, 20-decision bar. Must standardise on the ONE shared module — the platform currently holds three competing accuracy definitions.' },
    { tier: 1, group: 'AI workforce', name: 'Approvals waiting', shape: 'T3', status: 'ready',
      how: 'Tasks sitting at Status Approval — work an agent prepared that awaits a human yes.' },
    { tier: 1, group: 'AI workforce', name: 'AI agents live', shape: 'T3', status: 'ready',
      how: 'Workflow agents in the live state, with testing and pending counts alongside.' },
    // Tier 2 — property pack (add-on only)
    { tier: 2, group: 'Property pack', name: 'Occupancy rate', shape: 'T4', status: 'ready', how: 'Occupied over total rental units.' },
    { tier: 2, group: 'Property pack', name: 'Rent roll (expected monthly income)', shape: 'T5', status: 'ready', how: 'Sum of rent by payment status over active tenancies.' },
    { tier: 2, group: 'Property pack', name: 'Paid tenancy rate', shape: 'T4', status: 'ready', how: 'In-payment over active tenancies.' },
    { tier: 2, group: 'Property pack', name: 'CFV count and exposure', shape: 'T5', status: 'ready', how: 'Count and rent sum of tenancies not paying.' },
    { tier: 2, group: 'Property pack', name: 'Arrears balance and days', shape: 'T8', status: 'ready', how: 'Owed minus paid per tenancy, days in arrears, Section 8 threshold at 62 days.' },
    { tier: 2, group: 'Property pack', name: 'Gross / net yield', shape: 'T4', status: 'ready', how: 'Annualised rent over portfolio value.' },
    { tier: 2, group: 'Property pack', name: 'LTV and equity', shape: 'T4', status: 'ready', how: 'Debt over value; value minus debt.' },
    { tier: 2, group: 'Property pack', name: 'Compliance certificates', shape: 'T3', status: 'ready', how: 'Expired, expiring within 30 days, active, missing.' },
    { tier: 2, group: 'Property pack', name: 'Payment-lag buffer days', shape: 'T8', status: 'ready', how: '80th percentile of rent payment lag — feeds the safe-to-act floor.' },
];

// Known defects the harvest surfaced — a client must NEVER see these. Kept on
// the admin page so they stay visible until fixed.
const KPI_DEKEVIN = [
    'Hardcoded bank account record IDs in four places → per-tenant "accounts in cleared balance" setting.',
    'Hardcoded sub-category name lists (P&L sections, cashflow, personal expenses) → per-tenant chart-of-accounts mapping at onboarding.',
    'localStorage-only inputs (team capacity, task-hours budget, comms accuracy log) → tenant settings tables.',
    'Three competing "AI accuracy" definitions → one shared module (js/agent-accuracy.js is the keeper).',
    'kpi-sources "Completed tasks this month" is a stub that always returns 0 but renders as a real value.',
    'Operations → Customers KPI grid runs on three hardcoded demo rows.',
    'Browser-side new Function() compute → server-side template evaluation at the Supabase cutover.',
];

// Projects table fields read for the "live right now" panel.
const KPILIB_PROJ_F = {
    name:           'fldiMZICg1KOORpte',
    kpiName:        'fldABYFMf2yBKWdlD',
    kpiUnit:        'fldrYZEghROXYf6w0',
    kpiTarget:      'fldaI0voHia91SYZz',
    kpiCurrent:     'fldB1QJDUsukxKzjQ',
    kpiComputeCode: 'fldA7vPiLnbgEoKh1',
    kpiLastUpdated: 'fldNk2U74jBxZ6esJ',
    closedOn:       'fldzGI0ywBTpOK2dy',
};

let _kpiLibLiveRows = null;   // cache of live automated KPIs (null = not fetched)
let _kpiLibFetchError = '';

async function kpiLibFetchLive() {
    const params = new URLSearchParams({
        filterByFormula: 'AND({KPI Name} != "", {Closed On} = BLANK())',
        returnFieldsByFieldId: 'true',
        pageSize: '100',
    });
    Object.values(KPILIB_PROJ_F).forEach(fid => params.append('fields[]', fid));
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.projects}?${params.toString()}`, {
        headers: { 'Authorization': `Bearer ${PAT}` },
    });
    if (!res.ok) throw new Error(`Airtable ${res.status}`);
    const data = await res.json();
    return (data.records || []).map(r => ({
        project: r.fields[KPILIB_PROJ_F.name] || '(unnamed project)',
        kpi: r.fields[KPILIB_PROJ_F.kpiName] || '',
        unit: r.fields[KPILIB_PROJ_F.kpiUnit] || '',
        target: r.fields[KPILIB_PROJ_F.kpiTarget],
        current: r.fields[KPILIB_PROJ_F.kpiCurrent],
        automated: !!r.fields[KPILIB_PROJ_F.kpiComputeCode],
        lastUpdated: r.fields[KPILIB_PROJ_F.kpiLastUpdated] || '',
    }));
}

const KPILIB_STATUS = {
    live:    { label: 'LIVE',           colour: 'var(--success)', bg: 'var(--success-bg)', hint: 'Running with compute code on a real project today' },
    ready:   { label: 'READY',          colour: 'var(--info)',    bg: 'var(--info-bg)',    hint: 'Shape proven elsewhere in the platform — template is a lift' },
    setting: { label: 'NEEDS SETTING',  colour: 'var(--warning)', bg: 'var(--warning-bg)', hint: 'Needs a per-tenant setting before a client can use it' },
    blocked: { label: 'BLOCKED',        colour: 'var(--danger)',  bg: 'var(--danger-bg)',  hint: 'Known defect — fix before any client sees it' },
};

function kpiLibChip(status) {
    const s = KPILIB_STATUS[status] || KPILIB_STATUS.ready;
    return `<span title="${escHtml(s.hint)}" style="font-size:var(--fs-xs);font-weight:var(--fw-bold);letter-spacing:0.04em;padding:2px 8px;border-radius:var(--radius-full);color:${s.colour};background:${s.bg}">${s.label}</span>`;
}

function kpiLibEntryCard(e) {
    return `<div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:12px 14px;display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-weight:var(--fw-semibold);color:var(--text-primary)">${escHtml(e.name)}</span>
            <span style="font-size:var(--fs-xs);color:var(--text-muted);background:var(--bg-subtle);border-radius:var(--radius-sm);padding:1px 6px" title="${escHtml((KPI_SHAPES.find(s => s.id === e.shape) || {}).name || '')}">${escHtml(e.shape)}</span>
            <span style="margin-left:auto">${kpiLibChip(e.status)}</span>
        </div>
        <div style="font-size:var(--fs-sm);color:var(--text-secondary)">${escHtml(e.how)}</div>
    </div>`;
}

function kpiLibGroupedGrid(entries) {
    const groups = [];
    entries.forEach(e => { if (!groups.includes(e.group)) groups.push(e.group); });
    return groups.map(g => `
        <div style="font-size:var(--fs-xs);font-weight:var(--fw-semibold);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin:14px 0 8px">${escHtml(g)}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px">
            ${entries.filter(e => e.group === g).map(kpiLibEntryCard).join('')}
        </div>`).join('');
}

function registerKpiLibSyncBar() {
    if (typeof registerSyncBar !== 'function') return;
    registerSyncBar('kpi-library', {
        refreshFn: () => { _kpiLibLiveRows = null; return renderKpiLibraryTab(); },
        checks: [
            {
                name: 'Admin-only flag set', kind: 'sync', run: () => {
                    const entry = (typeof PAGE_REGISTRY !== 'undefined') ? PAGE_REGISTRY.find(p => p.id === 'kpi-library') : null;
                    if (!entry) return { status: 'fail', detail: 'kpi-library missing from PAGE_REGISTRY' };
                    if (!entry.adminOnly) return { status: 'fail', detail: 'adminOnly flag missing — a client shell could render this page after migration' };
                    return { status: 'pass', detail: 'Registry entry carries adminOnly: true — the migration contract for hiding this page from clients' };
                }
            },
            {
                name: 'Library data integrity', kind: 'sync', run: () => {
                    const shapeIds = KPI_SHAPES.map(s => s.id);
                    const bad = KPI_LIBRARY.filter(e => !shapeIds.includes(e.shape) || !e.name || !e.how);
                    if (bad.length) return { status: 'fail', detail: `${bad.length} entr${bad.length === 1 ? 'y' : 'ies'} with an unknown shape or missing fields` };
                    const names = KPI_LIBRARY.map(e => e.name.toLowerCase());
                    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
                    if (dupes.length) return { status: 'fail', detail: `Duplicate entries: ${dupes.join(', ')}` };
                    return { status: 'pass', detail: `${KPI_LIBRARY.length} entries across ${shapeIds.length} shapes, no duplicates` };
                }
            },
            {
                name: 'Live KPIs fetched from Projects', kind: 'sync', run: () => {
                    if (_kpiLibFetchError) return { status: 'fail', detail: `Projects fetch failed: ${_kpiLibFetchError}` };
                    if (_kpiLibLiveRows === null) return { status: 'warn', detail: 'Not fetched yet — open the tab or press Refresh' };
                    // Control: Kevin always has at least one open automated KPI.
                    // Zero rows here means the query or field map broke, not that
                    // the business stopped measuring things.
                    const auto = _kpiLibLiveRows.filter(r => r.automated).length;
                    if (_kpiLibLiveRows.length === 0) return { status: 'fail', detail: 'Query returned ZERO open KPIs — the filter or field map is broken (control expects at least one)' };
                    return { status: 'pass', detail: `${_kpiLibLiveRows.length} open project KPI(s), ${auto} automated with compute code` };
                }
            },
            {
                name: 'Every live automated KPI maps to a library shape', kind: 'automation', run: () => {
                    if (!_kpiLibLiveRows) return { status: 'warn', detail: 'Awaiting fetch' };
                    // The standing rule: every KPI written for Kevin is written
                    // generically. This check keeps the library honest — a live
                    // KPI with no library counterpart means a new template is due.
                    // Matching is stem overlap on significant words (5-char
                    // prefixes), so "Recovery packs complete" finds "Completed
                    // tasks" rather than false-flagging on word order.
                    const stems = s => String(s || '').toLowerCase().split(/[^a-z]+/)
                        .filter(w => w.length >= 5).map(w => w.slice(0, 5));
                    const libStems = KPI_LIBRARY.map(e => stems(e.name + ' ' + e.how));
                    const orphans = _kpiLibLiveRows.filter(r => {
                        if (!r.automated) return false;
                        const ks = stems(r.kpi);
                        return !libStems.some(ls => ks.some(k => ls.includes(k)));
                    });
                    if (orphans.length) return { status: 'warn', detail: `${orphans.length} live KPI(s) with no obvious library entry — add the template: ${orphans.map(o => o.kpi).join(', ')}` };
                    return { status: 'pass', detail: 'Every live automated KPI has a library counterpart' };
                }
            },
            {
                name: 'De-Kevining list not empty-stated', kind: 'automation', run: () => {
                    if (!KPI_DEKEVIN.length) return { status: 'warn', detail: 'The blocker list is empty — verify against docs/kpi-library-spec.md before believing it' };
                    return { status: 'pass', detail: `${KPI_DEKEVIN.length} known blockers tracked until fixed` };
                }
            },
        ],
    });
}

async function renderKpiLibraryTab() {
    const el = document.getElementById('tab-kpi-library');
    if (!el) return;
    registerKpiLibSyncBar();

    if (_kpiLibLiveRows === null) {
        el.innerHTML = `<div data-sync-bar="kpi-library"></div>
            <div style="display:flex;align-items:center;justify-content:center;min-height:200px;color:var(--text-muted)">
                <div style="text-align:center"><div class="spinner" style="margin:0 auto 12px"></div><div>Loading the KPI library…</div></div>
            </div>`;
        registerKpiLibSyncBar();
        try {
            _kpiLibFetchError = '';
            _kpiLibLiveRows = await kpiLibFetchLive();
        } catch (e) {
            _kpiLibFetchError = e.message || String(e);
            _kpiLibLiveRows = [];
        }
    }

    const tier1 = KPI_LIBRARY.filter(e => e.tier === 1);
    const tier2 = KPI_LIBRARY.filter(e => e.tier === 2);
    const liveCount = _kpiLibLiveRows.filter(r => r.automated).length;

    const liveRowsHtml = _kpiLibLiveRows.length
        ? _kpiLibLiveRows.map(r => {
            const fmtVal = v => (v == null || v === '') ? '—' : (r.unit === '£' ? `£${Number(v).toLocaleString('en-GB')}` : `${v}${r.unit === '%' ? '%' : r.unit ? ' ' + r.unit : ''}`);
            return `<tr>
                <td style="padding:6px 10px;border-bottom:1px solid var(--border-subtle);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px" title="${escHtml(r.project)}">${escHtml(r.project)}</td>
                <td style="padding:6px 10px;border-bottom:1px solid var(--border-subtle)">${escHtml(r.kpi)}</td>
                <td style="padding:6px 10px;border-bottom:1px solid var(--border-subtle);text-align:right">${escHtml(fmtVal(r.current))} / ${escHtml(fmtVal(r.target))}</td>
                <td style="padding:6px 10px;border-bottom:1px solid var(--border-subtle)">${r.automated ? '<span style="color:var(--success);font-weight:var(--fw-semibold)">Auto</span>' : '<span style="color:var(--warning)">Manual</span>'}</td>
                <td style="padding:6px 10px;border-bottom:1px solid var(--border-subtle);color:var(--text-muted)">${escHtml((r.lastUpdated || '').slice(0, 10) || '—')}</td>
            </tr>`;
        }).join('')
        : `<tr><td colspan="5" style="padding:14px;text-align:center;color:var(--text-muted)">${_kpiLibFetchError ? 'Could not load live KPIs: ' + escHtml(_kpiLibFetchError) : 'No open project KPIs found.'}</td></tr>`;

    el.innerHTML = `<div data-sync-bar="kpi-library"></div>
    <div class="section">
        <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:4px">
            <h2 class="section-title" style="margin-bottom:0">📚 KPI Library</h2>
            <span style="font-size:var(--fs-xs);font-weight:var(--fw-bold);letter-spacing:0.05em;color:var(--accent);background:var(--accent-soft);padding:3px 10px;border-radius:var(--radius-full)" title="Never rendered in a client tenant's shell — the adminOnly registry flag carries this rule into the Supabase migration">ADMIN ONLY — HIDDEN FROM CLIENTS</span>
        </div>
        <p style="font-size:var(--fs-sm);color:var(--text-secondary);max-width:860px;margin-bottom:16px">
            The templates a client picks from when their leadership dashboard is built. Each entry is a computation shape plus a few blanks —
            a client fills blanks, never writes code. Anything a client asks for that is not here goes through the request queue, is built
            generically, and becomes the next entry. Seeded 1 Aug 2026 from every metric this platform already computes.
        </p>

        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:20px">
            <div class="kpi-card"><div style="font-size:var(--fs-2xl);font-weight:var(--fw-bold);color:var(--text-primary)">${tier1.length}</div><div style="font-size:var(--fs-xs);color:var(--text-muted)">Generic core entries</div></div>
            <div class="kpi-card"><div style="font-size:var(--fs-2xl);font-weight:var(--fw-bold);color:var(--text-primary)">${tier2.length}</div><div style="font-size:var(--fs-xs);color:var(--text-muted)">Property pack entries</div></div>
            <div class="kpi-card"><div style="font-size:var(--fs-2xl);font-weight:var(--fw-bold);color:var(--text-primary)">${KPI_SHAPES.length}</div><div style="font-size:var(--fs-xs);color:var(--text-muted)">Computation shapes</div></div>
            <div class="kpi-card"><div style="font-size:var(--fs-2xl);font-weight:var(--fw-bold);color:var(--success)">${liveCount}</div><div style="font-size:var(--fs-xs);color:var(--text-muted)">Automated KPIs live right now</div></div>
        </div>

        <h3 style="font-size:var(--fs-lg);font-weight:var(--fw-semibold);color:var(--text-primary);margin:18px 0 8px">Live on the platform right now</h3>
        <p style="font-size:var(--fs-sm);color:var(--text-secondary);margin-bottom:8px">Open project KPIs from the Projects table — the proof each template works before a client ever picks it. Closed quarters are excluded.</p>
        <div style="overflow-x:auto;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg)">
            <table style="width:100%;border-collapse:collapse;font-size:var(--fs-sm)">
                <thead><tr style="background:var(--bg-subtle)">
                    <th style="text-align:left;padding:8px 10px">Project</th>
                    <th style="text-align:left;padding:8px 10px">KPI</th>
                    <th style="text-align:right;padding:8px 10px">Current / target</th>
                    <th style="text-align:left;padding:8px 10px">Updates</th>
                    <th style="text-align:left;padding:8px 10px">Last moved</th>
                </tr></thead>
                <tbody>${liveRowsHtml}</tbody>
            </table>
        </div>

        <h3 style="font-size:var(--fs-lg);font-weight:var(--fw-semibold);color:var(--text-primary);margin:24px 0 8px">The ten computation shapes</h3>
        <p style="font-size:var(--fs-sm);color:var(--text-secondary);margin-bottom:8px">Every entry below is one of these shapes plus blanks. The engine builds the shapes once; library entries are data, not code.</p>
        <div style="overflow-x:auto;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg)">
            <table style="width:100%;border-collapse:collapse;font-size:var(--fs-sm)">
                <thead><tr style="background:var(--bg-subtle)"><th style="text-align:left;padding:8px 10px;width:60px">Shape</th><th style="text-align:left;padding:8px 10px">What it computes</th><th style="text-align:left;padding:8px 10px">The blanks a client fills</th></tr></thead>
                <tbody>${KPI_SHAPES.map(s => `<tr>
                    <td style="padding:6px 10px;border-bottom:1px solid var(--border-subtle);font-weight:var(--fw-semibold);color:var(--accent)">${escHtml(s.id)}</td>
                    <td style="padding:6px 10px;border-bottom:1px solid var(--border-subtle)">${escHtml(s.name)}</td>
                    <td style="padding:6px 10px;border-bottom:1px solid var(--border-subtle);color:var(--text-secondary)">${escHtml(s.blanks)}</td>
                </tr>`).join('')}</tbody>
            </table>
        </div>

        <h3 style="font-size:var(--fs-lg);font-weight:var(--fw-semibold);color:var(--text-primary);margin:24px 0 0">Tier 1 — Generic core <span style="font-size:var(--fs-sm);font-weight:var(--fw-regular);color:var(--text-muted)">(ships with every client's dashboard)</span></h3>
        ${kpiLibGroupedGrid(tier1)}

        <h3 style="font-size:var(--fs-lg);font-weight:var(--fw-semibold);color:var(--text-primary);margin:24px 0 0">Tier 2 — Property pack <span style="font-size:var(--fs-sm);font-weight:var(--fw-regular);color:var(--text-muted)">(add-on clients only)</span></h3>
        ${kpiLibGroupedGrid(tier2)}

        <h3 style="font-size:var(--fs-lg);font-weight:var(--fw-semibold);color:var(--text-primary);margin:24px 0 8px">Before any client sees this — the de-Kevining list</h3>
        <div style="background:var(--warning-bg);border-left:4px solid var(--warning);border-radius:var(--radius-md);padding:12px 16px">
            <ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px;font-size:var(--fs-sm);color:var(--text-primary)">
                ${KPI_DEKEVIN.map(d => `<li>${escHtml(d)}</li>`).join('')}
            </ul>
        </div>

        <p style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:16px">Source of truth: docs/kpi-library-spec.md · Build trigger: the picker and server-side template engine land with client one's leadership-dashboard build (Supabase side).</p>
    </div>`;

    if (typeof markTabSynced === 'function') markTabSynced('kpi-library');
}
window.renderKpiLibraryTab = renderKpiLibraryTab;
