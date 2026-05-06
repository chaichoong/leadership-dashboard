// ══════════════════════════════════════════
// SHARED — Smart Refresh, Auth, API, Helpers, UI Helpers
// ══════════════════════════════════════════

    // ── Smart Refresh: delays refresh while user is actively interacting ──
    let lastUserActivity = 0;       // timestamp of last interaction
    const IDLE_THRESHOLD = 15 * 60 * 1000; // 15 min idle before auto-refresh fires
    let refreshPending = false;     // true when a refresh was deferred due to activity

    function markUserActive() {
        lastUserActivity = Date.now();
        // If a refresh was pending and got deferred, schedule a check
        // once the user goes idle for 15 minutes
        if (refreshPending) {
            scheduleIdleRefresh();
        }
    }

    let idleCheckTimer = null;
    function scheduleIdleRefresh() {
        if (idleCheckTimer) clearTimeout(idleCheckTimer);
        idleCheckTimer = setTimeout(() => {
            const idleTime = Date.now() - lastUserActivity;
            if (idleTime >= IDLE_THRESHOLD) {
                refreshPending = false;
                loadDashboard();
            } else {
                // Not idle long enough, check again after remaining time
                scheduleIdleRefresh();
            }
        }, IDLE_THRESHOLD - (Date.now() - lastUserActivity) + 500);
    }

    function smartRefresh() {
        // Don't refresh while the user is in an OS iframe (Strategy, Tasks,
        // Launch Plan, etc.) — a dashboard reload blows through the loading
        // overlay and drops any in-flight wizard/form state.
        const activeTab = (window.location.hash || '#overview').slice(1);
        const iframeTabs = ['os-strategy', 'os-bplan', 'tasks', 'comms', 'compliance', 'operations'];
        if (iframeTabs.includes(activeTab)) {
            refreshPending = true;
            scheduleIdleRefresh();
            return;
        }
        const idleTime = Date.now() - lastUserActivity;
        if (idleTime >= IDLE_THRESHOLD || lastUserActivity === 0) {
            // User has been idle — refresh immediately
            refreshPending = false;
            loadDashboard();
        } else {
            // User is active — defer refresh
            refreshPending = true;
            scheduleIdleRefresh();
        }
    }

    // Track user activity on interactive elements
    document.addEventListener('click', markUserActive);
    document.addEventListener('keydown', markUserActive);
    document.addEventListener('input', markUserActive);

    // ── Auth ──
    function authenticate() {
        const input = document.getElementById('patInput').value.trim();
        if (!input) return;
        PAT = input;
        localStorage.setItem('_dlr_pat', input);
        document.getElementById('authScreen').style.display = 'none';
        loadDashboard();
    }

    function logout() {
        PAT = '';
        localStorage.removeItem('_dlr_pat');
        if (typeof clearDashCache === 'function') clearDashCache();
        document.getElementById('authScreen').style.display = 'flex';
        document.getElementById('dashboard').style.display = 'none';
    }

    // Check session on load — MUST wait for DOMContentLoaded so sibling deferred
    // scripts (dashboard.js, invoices.js, etc.) have finished executing. When shared.js
    // itself has `defer`, document.readyState is already 'interactive' here, so a naive
    // check for 'loading' would skip the wait and call loadDashboard() before it exists.
    function _opsDirectorInit() {
        const saved = localStorage.getItem('_dlr_pat');
        if (saved) {
            PAT = saved;
            document.getElementById('authScreen').style.display = 'none';
            loadDashboard();
        }
        document.getElementById('patInput').addEventListener('keydown', e => {
            if (e.key === 'Enter') authenticate();
        });
    }
    if (document.readyState === 'complete') {
        _opsDirectorInit();
    } else {
        document.addEventListener('DOMContentLoaded', _opsDirectorInit);
    }

    // ── Airtable API ──
    async function airtableFetch(tableId, params = {}) {
        const records = [];
        let offset = null;
        do {
            const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
            url.searchParams.set('returnFieldsByFieldId', 'true');
            Object.entries(params).forEach(([k, v]) => {
                if (Array.isArray(v)) v.forEach(val => url.searchParams.append(k, val));
                else url.searchParams.append(k, v);
            });
            if (offset) url.searchParams.set('offset', offset);

            let resp;
            for (let _attempt = 0; _attempt < 4; _attempt++) {
                resp = await fetch(url, {
                    headers: { 'Authorization': `Bearer ${PAT}` }
                });
                if (resp.status === 429) {
                    const wait = Math.min(1000 * Math.pow(2, _attempt), 8000);
                    await new Promise(r => setTimeout(r, wait));
                    continue;
                }
                break;
            }
            if (resp.status === 401 || resp.status === 403) {
                localStorage.removeItem('_dlr_pat');
                document.getElementById('authScreen').style.display = 'flex';
                document.getElementById('authError').style.display = 'block';
                document.getElementById('loadingOverlay').style.display = 'none';
                document.getElementById('dashboard').style.display = 'none';
                throw new Error('Auth failed');
            }
            if (!resp.ok) throw new Error(`API error: ${resp.status}`);
            const data = await resp.json();
            records.push(...data.records);
            offset = data.offset || null;
        } while (offset);
        return records;
    }

    // ── Helpers ──
    const fmt = n => '£' + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtSigned = n => (n >= 0 ? '+' : '-') + fmt(n);
    // Accounting brackets: negative = (£X), positive = £X
    const fmtAccounting = n => n < 0 ? `(${fmt(n)})` : fmt(n);

    // Extract a numeric value from a field that may be a plain number, string, or singleSelect object
    function getNumVal(rec, fieldId, fallback) {
        const val = getField(rec, fieldId);
        if (val == null) return fallback;
        if (typeof val === 'number') return val;
        if (typeof val === 'object' && val.name != null) return Number(val.name) || fallback;
        return Number(val) || fallback;
    }
    const pct = (a, b) => b === 0 ? '0.0' : ((a / b) * 100).toFixed(1);

    // Traffic light: Green = below target, Amber = target to target+10%, Red = above
    function trafficLight(actual, target) {
        if (actual < target) return 'green';
        if (actual <= target * 1.10) return 'amber';
        return 'red';
    }
    function trafficLightClass(actual, target) {
        const tl = trafficLight(actual, target);
        return tl === 'green' ? 'text-green' : tl === 'amber' ? 'text-amber' : 'text-red';
    }
    function trafficLightLabel(actual, target) {
        const tl = trafficLight(actual, target);
        return tl === 'green' ? 'Below target' : tl === 'amber' ? 'On target' : 'Above target';
    }

    function getField(rec, fieldId) {
        return rec.fields?.[fieldId];
    }

    // Active businesses only — every user-facing business picker/filter calls this
    // so deactivated businesses (Active checkbox unticked in Airtable) disappear from
    // dropdowns while still resolving correctly on historical records via allBusinesses.
    function getActiveBusinesses() {
        return (typeof allBusinesses !== 'undefined' ? allBusinesses : [])
            .filter(b => !!getField(b, BIZ_ACTIVE_FIELD));
    }

    // Account Alias comes back as a flat array of name strings e.g. ["Santander"]
    // or as a linked-record object with linkedRecordIds. Handle both.
    function isOurAccount(aliasField) {
        if (!aliasField) return false;
        // Flat string array from lookup (most common with returnFieldsByFieldId)
        if (Array.isArray(aliasField)) {
            return aliasField.some(v => typeof v === 'string' && (v === 'Santander' || v === 'TNT Mgt Zempler'));
        }
        // Linked record object format
        if (aliasField.linkedRecordIds) {
            return aliasField.linkedRecordIds.includes(REC.santander) || aliasField.linkedRecordIds.includes(REC.tntZempler);
        }
        if (typeof aliasField === 'string') {
            return aliasField === 'Santander' || aliasField === 'TNT Mgt Zempler';
        }
        return false;
    }

    // Extract display values from multipleLookupValues fields
    // With returnFieldsByFieldId=true, these come back as {linkedRecordIds: [...], valuesByLinkedRecordId: {recId: ["value"]}}
    function lookupValues(field) {
        if (!field) return [];
        if (Array.isArray(field)) return field.map(String); // flat array format
        if (field.valuesByLinkedRecordId) {
            const vals = [];
            Object.values(field.valuesByLinkedRecordId).forEach(v => {
                if (Array.isArray(v)) vals.push(...v.map(String));
                else vals.push(String(v));
            });
            return vals;
        }
        if (typeof field === 'string') return [field];
        return [String(field)];
    }

    // Payment status comes back as a plain string name e.g. "In Payment"
    function getPaymentStatusName(field) {
        if (!field) return '';
        if (typeof field === 'string') return field;
        if (field.name) return field.name;
        return String(field);
    }

    function isTenancyActive(statusField) {
        const name = getPaymentStatusName(statusField).trim().toLowerCase();
        return ['in payment', 'cfv actioned', 'cfv'].includes(name);
    }

    function isTenancyIncome(statusField) {
        const name = getPaymentStatusName(statusField).trim().toLowerCase();
        return ['in payment', 'cfv actioned'].includes(name);
    }

    // Check the tenant's actual status (rollup from Tenants table) — excludes "Former" tenants
    // Field returns an array like ["Active"] or ["Former"]
    function isTenantStatusActive(rec) {
        const status = getField(rec, F.tenStatus);
        if (!status) return false;
        if (Array.isArray(status)) {
            return status.some(s => typeof s === 'string' && s.trim().toLowerCase() === 'active');
        }
        if (typeof status === 'string') return status.trim().toLowerCase() === 'active';
        return false;
    }

    function isCostActive(rec) {
        // Single rule, used everywhere (Leadership Dashboard monthly costs,
        // AP Fixed table, reconciliation dropdowns, transactions dropdowns).
        // Active = Payment Status is "In Payment" OR "Overdue".
        // Anything else (Paused, Inactive, empty) is excluded.
        if (getField(rec, F.costInactive)) return false;
        const status = getPaymentStatusName(getField(rec, F.costPayStatus));
        return status === 'In Payment' || status === 'Overdue';
    }

    // ── Cost reconciliation sync ──
    // Updates a Cost record's "Last Reconciled" fields when a transaction is reconciled
    // against it, but only if this tx is newer than the previously-recorded most-recent.
    // Writes: Last Reconciled Payment Date, Last Reconciled Amount, Last Reconciled Account,
    // Last Reconciled Sub-Category. Idempotent — safe to call multiple times.
    async function syncCostFromReconciledTx(costId, txDate, txAmount, txAccountIds, txSubCatIds) {
        if (!costId || !txDate) return { skipped: true, reason: 'missing costId or txDate' };
        const cost = (allCosts || []).find(c => c.id === costId);
        const existingDate = cost ? getField(cost, F.costLastReconDate) : null;
        if (existingDate && new Date(existingDate) > new Date(txDate)) {
            return { skipped: true, reason: 'existing reconciled date is newer' };
        }
        const fields = {
            [F.costLastReconDate]: txDate,
            [F.costLastReconAmount]: Math.abs(Number(txAmount) || 0),
        };
        if (Array.isArray(txAccountIds) && txAccountIds.length > 0) {
            fields[F.costLastReconAccount] = txAccountIds.slice(0, 1);
        }
        if (Array.isArray(txSubCatIds) && txSubCatIds.length > 0) {
            fields[F.costLastReconSubCat] = txSubCatIds.slice(0, 1);
        }
        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}/${costId}`, {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields })
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            console.warn('syncCostFromReconciledTx failed', err);
            return { skipped: false, ok: false, error: err };
        }
        if (cost) {
            if (!cost.fields) cost.fields = {};
            Object.assign(cost.fields, fields);
        }
        return { skipped: false, ok: true };
    }

    function dayName(d) {
        return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    }

    function isWeekend(d) {
        return d.getDay() === 0 || d.getDay() === 6;
    }

    // Use local date parts to avoid DST duplicate-date bugs (e.g. UK clocks-forward)
    function dateKey(d) {
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    // Sub-category name lookup (for transactions where vendor is blank)
    const SUB_CAT_NAMES = {};
    // Populated after REC is defined below in txLabel()

    function txLabel(r) {
        const vendor = getField(r, F.txVendor);
        if (vendor && String(vendor).trim()) return String(vendor).trim();
        const desc = getField(r, F.txDescription);
        if (desc && String(desc).trim()) {
            const d = String(desc).trim();
            return d.length > 70 ? d.substring(0, 70) + '…' : d;
        }
        const sc = getField(r, F.txSubCategory);
        if (sc && Array.isArray(sc)) {
            for (const id of sc) {
                if (id === REC.subRentalInc) return 'Rental Income';
                if (id === REC.subMaint) return 'Property Reactive Maintenance';
                if (id === REC.subOpexLabour) return 'Opex Labour';
                if (id === REC.subCOGSLabour) return 'COGS Labour';
            }
        }
        return 'Uncategorised';
    }

    function txTeamMemberName(r) {
        const tm = getField(r, F.txTeamMember);
        if (!tm) return null;
        if (Array.isArray(tm)) {
            const first = tm[0];
            if (first && typeof first === 'object' && first.name) return first.name;
        }
        return null;
    }


    // ── UI Helpers ──
    function expandableCard(label, value, sub, detailHtml, valueClass = '', extraHtml = '') {
        return `
            <div class="kpi-card clickable" onclick="toggleCard(this)">
                <div class="kpi-card-label">${escHtml(label)} <span class="chevron">▸</span></div>
                <div class="kpi-card-value ${valueClass}">${typeof value === 'number' ? value : value}</div>
                ${sub ? `<div class="kpi-card-sub">${sub}</div>` : ''}
                ${extraHtml}
                <div class="kpi-card-detail">${detailHtml}</div>
            </div>
        `;
    }

    function toggleCard(el) { el.classList.toggle('expanded'); }

    // ── Sidebar health rollup ──
    // Each tab's sync-bar broadcasts its rollup status via _broadcastStatus()
    // in js/sync-bar.js. The parent shell catches those broadcasts here and
    // updates a small dot beside that tab's sidebar item, so a single glance
    // at the sidebar tells Kevin whether anything's gone amber/red anywhere.
    function updateSidebarHealth(tabId, status) {
        const dot = document.querySelector(`[data-sidebar-health="${tabId}"]`);
        if (!dot) return;
        // Translate rollup status names ('pass'/'warn'/'fail') into the dot's
        // colour classes ('green'/'amber'/'red'). Iframes broadcast pass/warn/
        // fail; the parent's own sync-bar.js calls updateSidebarHealth directly
        // with the same names. Either way, we land on a single colour class.
        const cls = status === 'pass' ? 'green'
            : status === 'warn' ? 'amber'
            : status === 'fail' ? 'red'
            : status === 'refreshing' ? 'refreshing'
            : status; // pass through 'green'/'amber'/'red' if already translated
        dot.classList.remove('green', 'amber', 'red', 'refreshing', 'unknown');
        dot.classList.add(cls || 'unknown');
        const label = (cls === 'green') ? 'All checks passing'
            : (cls === 'amber') ? 'Some checks warning'
            : (cls === 'red') ? 'Failures detected'
            : (cls === 'refreshing') ? 'Refreshing…'
            : 'No checks run yet';
        dot.title = label;
        // Bubble the update to the section dot (worst-case rollup of all tabs in this section).
        rollUpSidebarSection(tabId);
    }
    // Listen for status pings from iframe pages.
    window.addEventListener('message', (e) => {
        if (!e.data || e.data.type !== 'syncBarStatus' || !e.data.tabId) return;
        if (e.origin !== 'null' && e.origin !== window.location.origin) return;
        updateSidebarHealth(e.data.tabId, e.data.status);
    });

    // ── Sidebar collapsible sections (Phase 3 restructure) ──
    // Each .sidebar-section has a [data-section] key and a [data-tabs] CSV of
    // tab IDs it contains. Collapsed state persists per-section in localStorage.
    // The active-tab's section is always force-expanded so deep-links never
    // hide the user's view.
    const _SIDEBAR_COLLAPSE_KEY = '_sidebar_collapsed_sections';
    function _readCollapsedSections() {
        try { return JSON.parse(localStorage.getItem(_SIDEBAR_COLLAPSE_KEY) || '[]') || []; } catch { return []; }
    }
    function _writeCollapsedSections(arr) {
        try { localStorage.setItem(_SIDEBAR_COLLAPSE_KEY, JSON.stringify(arr || [])); } catch {}
    }
    function toggleSidebarSection(name) {
        const sec = document.querySelector(`.sidebar-section[data-section="${name}"]`);
        if (!sec) return;
        sec.classList.toggle('collapsed');
        const isCollapsed = sec.classList.contains('collapsed');
        const chev = sec.querySelector('.sidebar-section-chevron');
        if (chev) chev.innerHTML = isCollapsed ? '&#x25B8;' : '&#x25BE;';
        const header = sec.querySelector('.sidebar-section-header');
        if (header) header.setAttribute('aria-expanded', String(!isCollapsed));
        const cur = _readCollapsedSections();
        const idx = cur.indexOf(name);
        if (sec.classList.contains('collapsed') && idx === -1) cur.push(name);
        if (!sec.classList.contains('collapsed') && idx !== -1) cur.splice(idx, 1);
        _writeCollapsedSections(cur);
    }
    function expandSidebarSectionForTab(tabId) {
        // Find the section that owns this tab and force-expand it.
        const all = document.querySelectorAll('.sidebar-section[data-tabs]');
        for (const sec of all) {
            const tabs = (sec.getAttribute('data-tabs') || '').split(',').map(s => s.trim()).filter(Boolean);
            if (!tabs.includes(tabId)) continue;
            if (sec.classList.contains('collapsed')) {
                sec.classList.remove('collapsed');
                const chev = sec.querySelector('.sidebar-section-chevron');
                if (chev) chev.innerHTML = '&#x25BE;';
                const hdr = sec.querySelector('.sidebar-section-header');
                if (hdr) hdr.setAttribute('aria-expanded', 'true');
                // Don't write to localStorage — auto-expand on navigation should be
                // ephemeral. User-driven toggles still persist as before.
            }
            break;
        }
    }
    function restoreSidebarSectionState() {
        const collapsed = _readCollapsedSections();
        document.querySelectorAll('.sidebar-section[data-section]').forEach(sec => {
            const name = sec.getAttribute('data-section');
            const isCollapsed = collapsed.includes(name) || sec.classList.contains('coming-soon');
            sec.classList.toggle('collapsed', isCollapsed);
            const chev = sec.querySelector('.sidebar-section-chevron');
            if (chev) chev.innerHTML = isCollapsed ? '&#x25B8;' : '&#x25BE;';
            const hdr = sec.querySelector('.sidebar-section-header');
            if (hdr) hdr.setAttribute('aria-expanded', String(!isCollapsed));
        });
    }
    // Worst-case rollup: section dot inherits the worst child's status.
    // Order of severity: red > amber > refreshing > green > unknown.
    function rollUpSidebarSection(tabId) {
        const sec = document.querySelector(`.sidebar-section[data-tabs*="${tabId}"]`);
        if (!sec) return;
        // Verify exact membership (data-tabs is CSV, *= is substring).
        const tabs = (sec.getAttribute('data-tabs') || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!tabs.includes(tabId)) return;
        const dotEl = sec.querySelector('.sidebar-section-dot');
        if (!dotEl) return;
        let worst = 'unknown';
        const order = { red: 4, amber: 3, refreshing: 2, green: 1, unknown: 0 };
        tabs.forEach(t => {
            const childDot = document.querySelector(`[data-sidebar-health="${t}"]`);
            if (!childDot) return;
            const cls = ['red', 'amber', 'refreshing', 'green', 'unknown'].find(c => childDot.classList.contains(c)) || 'unknown';
            if (order[cls] > order[worst]) worst = cls;
        });
        dotEl.classList.remove('red', 'amber', 'refreshing', 'green', 'unknown');
        dotEl.classList.add(worst);
    }
    // Restore section state once DOM is ready.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', restoreSidebarSectionState);
    } else {
        restoreSidebarSectionState();
    }

    async function switchTab(tabId) {
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.tab-btn, .sidebar-item').forEach(b => b.classList.remove('active'));
        document.getElementById('tab-' + tabId).classList.add('active');
        // Update URL hash for deep-linking
        if (history.replaceState) history.replaceState(null, '', '#' + tabId);
        // Highlight the sidebar item by mapping tabId → onclick attribute. Cleaner
        // than the old text-includes approach which broke when labels were
        // shortened in the Phase 3 restructure.
        document.querySelectorAll('.sidebar-item').forEach(b => {
            const onclickAttr = b.getAttribute('onclick') || '';
            if (onclickAttr.includes(`switchTab('${tabId}')`)) b.classList.add('active');
        });
        // Auto-expand the section that contains the now-active tab so it's
        // always visible after deep-linking.
        expandSidebarSectionForTab(tabId);
        // Also highlight old tab buttons (if visible)
        document.querySelectorAll('.tab-btn').forEach(b => {
            if ((tabId === 'overview' && b.textContent.includes('Leadership')) ||
                (tabId === 'invoices' && b.textContent.includes('Accounts Payable')) ||
                (tabId === 'cfv' && b.textContent.includes('Cash Flow Voids'))) {
                b.classList.add('active');
            }
        });
        // Lazy-load iframes on first switch
if (tabId === 'comms') {
            const frame = document.getElementById('commsFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('follow-up')) frame.src = frame.dataset.src;
        }
        if (tabId === 'compliance') {
            const frame = document.getElementById('complianceFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('compliance')) frame.src = frame.dataset.src;
        }
        // Render costs tab on switch
        if (tabId === 'costs') {
            if (typeof renderCostsTab === 'function') renderCostsTab();
        }
        // Render invoices tab on switch
        if (tabId === 'invoices') {
            renderInvoiceTab();
        }
        // Render Profit & Loss on switch
        if (tabId === 'pnl') {
            if (typeof renderPnL === 'function') renderPnL();
        }
        // Render Transactions on switch
        if (tabId === 'transactions') {
            if (typeof renderTransactionsTab === 'function') renderTransactionsTab();
        }
        // Render CFV tab on switch
        if (tabId === 'cfv') {
            renderCFVTab();
        }
        // Render Site Map on switch
        if (tabId === 'sitemap') {
            renderSiteMap();
        }
        // Load Fintable Sync Monitor on switch
        if (tabId === 'fintable') {
            loadFintableSyncMonitor();
        }
        // Task Manager lazy-load
        if (tabId === 'tasks') {
            const frame = document.getElementById('tasksFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('tasks')) {
                // Cache-bust so Pages deploys of os/tasks/index.html are picked up
                // without the user having to clear their browser cache.
                frame.src = frame.dataset.src + (frame.dataset.src.includes('?') ? '&' : '?') + 'cb=' + Date.now();
            }
        }
        // (Launch Plan tab removed — content was duplicating Strategy OS.)
        // Operations OS lazy-load (cache-busted so Pages deploys are picked up)
        if (tabId === 'operations') {
            const frame = document.getElementById('operationsFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('operations')) {
                frame.src = frame.dataset.src + (frame.dataset.src.includes('?') ? '&' : '?') + 'cb=' + Date.now();
            }
        }
        // Plan Builder + Strategy iframe lazy-load (Operating Systems Hub
        // removed in Phase 3 sidebar restructure).
        if (tabId === 'os-bplan') {
            const frame = document.getElementById('osBplanFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('business-plan')) frame.src = frame.dataset.src;
        }
        if (tabId === 'os-strategy') {
            const frame = document.getElementById('osStrategyFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('strategy')) {
                // Bust the iframe cache so Pages deploys of os/strategy/index.html
                // are picked up without the user having to clear their browser cache.
                frame.src = frame.dataset.src + '?cb=' + Date.now();
            }
        }

        // Refresh data on tab switch — but only if cache is stale.
        // Re-fetching on every tab switch was hammering Airtable and causing the
        // UI to flicker through "Refreshing…" state on every click. With a fresh
        // cache we just re-render from it; the 15-min smartRefresh handles background updates.
        const TAB_SWITCH_STALE_MS = 2 * 60 * 1000; // 2 min — aggressive enough to feel live, cheap enough to avoid churn
        if (PAT && !document.getElementById('loadingOverlay').style.display.includes('flex')) {
            const cached = typeof loadDashCache === 'function' ? await loadDashCache() : null;
            if (!cached || cached.ageMs > TAB_SWITCH_STALE_MS) {
                loadDashboard();
            }
        }
    }


    function shareCurrentPage() {
        const hash = window.location.hash || '#overview';
        const url = window.location.origin + window.location.pathname + hash;
        navigator.clipboard.writeText(url).then(() => {
            const toast = document.getElementById('shareToast');
            toast.style.display = 'block';
            setTimeout(() => { toast.style.display = 'none'; }, 2500);
        }).catch(() => { prompt('Copy this link:', url); });
    }

    function copyLink(path) {
        const base = window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
        const url = base + path;
        navigator.clipboard.writeText(url).then(() => {
            const toast = document.getElementById('shareToast');
            toast.style.display = 'block';
            setTimeout(() => { toast.style.display = 'none'; }, 2500);
        }).catch(() => { prompt('Copy this link:', url); });
    }

    // Sidebar toggle (mobile)
    function toggleSidebar() {
        document.getElementById('sidebar').classList.toggle('open');
        document.getElementById('sidebarOverlay').classList.toggle('open');
    }

    // Auto-switch to tab from URL hash (e.g. #invoices, #cfv)
    // Also close sidebar on mobile after tab switch
    const _origSwitchTab = switchTab;
    switchTab = function(tabId) {
        _origSwitchTab(tabId);
        // Close sidebar on mobile
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebarOverlay').classList.remove('open');
        // Update AI quick-action chips for current tab
        if (typeof renderAIChips === 'function') renderAIChips();
    };

    // On load: check URL hash for deep-linking
    window.addEventListener('load', () => {
        const hash = window.location.hash.replace('#', '');
        if (hash && document.getElementById('tab-' + hash)) {
            switchTab(hash);
        }
    });

    function toggleCashflowRow(rowId) {
        const row = document.getElementById(rowId);
        if (row) {
            row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
        }
    }

    function escHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    function escJs(str) {
        if (str == null) return '';
        return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    }

    // ── Concurrency limiter for Airtable API (5 req/sec rate limit) ──
    const _apiQueue = [];
    let _apiInFlight = 0;
    const API_MAX_CONCURRENT = 4;
    function _drainApiQueue() {
        while (_apiQueue.length > 0 && _apiInFlight < API_MAX_CONCURRENT) {
            const { fn, resolve, reject } = _apiQueue.shift();
            _apiInFlight++;
            fn().then(resolve, reject).finally(() => { _apiInFlight--; _drainApiQueue(); });
        }
    }
    function limitedApiFetch(fn) {
        return new Promise((resolve, reject) => {
            _apiQueue.push({ fn, resolve, reject });
            _drainApiQueue();
        });
    }

    // ── Render generation guard — discard stale async renders ──
    const _renderGen = {};
    function nextRenderGen(tabId) { _renderGen[tabId] = (_renderGen[tabId] || 0) + 1; return _renderGen[tabId]; }
    function isCurrentRender(tabId, gen) { return _renderGen[tabId] === gen; }

