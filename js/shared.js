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
        const iframeTabs = ['os-strategy', 'os-bplan', 'tasks', 'comms', 'operations', 'systemisation', 'os-team', 'ai-brain'];
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
    window.getField = getField;

    // Split-aware amount: returns the correct per-portion amount for any
    // transaction. Checks Split Override first (set on split parents and
    // custom-amount children) so we never need to rely on Split Count > 1
    // for display purposes. Changing Split Count triggers the Airtable
    // "Split Transactions" automation, so existing parents that only need
    // an amount correction should set Override with Split Count = 1.
    function txDisplayAmount(rec) {
        const override = getField(rec, F.txSplitOverride);
        if (override != null && override !== '') return Number(override) || 0;
        const splitCount = Number(getField(rec, F.txSplitCount)) || 1;
        if (splitCount > 1) {
            return (Number(getField(rec, F.txAmount)) || 0) / splitCount;
        }
        const report = getField(rec, F.txReportAmount);
        if (report != null && report !== '') return Number(report) || 0;
        return Number(getField(rec, F.txAmount)) || 0;
    }
    window.txDisplayAmount = txDisplayAmount;

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

    // A tenancy is "ended" once its Tenancy End Date is before today. Mirrors the
    // Airtable "Tenancy Status" formula: IF(end AND end < TODAY(), "Ended", "Live").
    // Needed because the tenant-status rollup below reflects the linked tenant, which
    // may stay Active across other live tenancies even after this one has ended.
    function isTenancyEnded(rec) {
        const raw = getField(rec, F.tenEndDate);
        if (!raw) return false;
        const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
        const end = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(raw);
        if (isNaN(end.getTime())) return false;
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        return end < startOfToday;
    }
    window.isTenancyEnded = isTenancyEnded;

    // Check the tenant's actual status (rollup from Tenants table) — excludes "Former" tenants
    // and any tenancy whose end date has passed (rollup can lag when the tenant is shared).
    // Field returns an array like ["Active"] or ["Former"]
    function isTenantStatusActive(rec) {
        if (isTenancyEnded(rec)) return false;
        const status = getField(rec, F.tenStatus);
        if (!status) return false;
        if (Array.isArray(status)) {
            return status.some(s => typeof s === 'string' && s.trim().toLowerCase() === 'active');
        }
        if (typeof status === 'string') return status.trim().toLowerCase() === 'active';
        return false;
    }

    // Positive check for "Former" — returns false when the field is empty/null,
    // so new tenancies with an unpopulated rollup are NOT treated as former.
    // An ended tenancy counts as former even if the shared tenant rollup still reads Active.
    function isTenantStatusFormer(rec) {
        if (isTenancyEnded(rec)) return true;
        const status = getField(rec, F.tenStatus);
        if (!status) return false;
        if (Array.isArray(status)) {
            return status.some(s => typeof s === 'string' && s.trim().toLowerCase() === 'former');
        }
        if (typeof status === 'string') return status.trim().toLowerCase() === 'former';
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
                <div class="kpi-card-value ${valueClass}">${value}</div>
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
        if (!e.data || typeof e.data !== 'object') return;
        if (e.origin !== 'null' && e.origin !== window.location.origin) return;

        if (e.data.type === 'syncBarStatus' && e.data.tabId) {
            updateSidebarHealth(e.data.tabId, e.data.status);
            return;
        }

        // Open lightweight task creation modal on the current page (no tab switch)
        if (e.data.type === 'qt:open-new-task-drawer') {
            const opts = e.data.opts || {};
            openQuickTaskModal(opts);
            return;
        }
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

    const DASHBOARD_GROUP = ['overview', 'cfv'];
    const ACCOUNTS_GROUP = ['income', 'ar-variable', 'costs', 'invoices', 'transactions', 'fintable'];

    async function switchTab(tabId) {
        // Standalone-only pages (e.g. Property Compliance, How It Works) live in
        // PAGE_REGISTRY with a `standalone` file but have NO in-app `tab-<id>`
        // panel. Calling switchTab for them used to deactivate every panel and
        // then find nothing to show, blanking the whole content area. Detect that
        // case up front — open the standalone page in a new tab and leave the
        // current view untouched — before any panel is deactivated.
        if (!document.getElementById('tab-' + tabId)) {
            const regEntry = (typeof PAGE_REGISTRY !== 'undefined')
                ? PAGE_REGISTRY.find(p => p.id === tabId) : null;
            if (regEntry && regEntry.standalone) {
                window.open(regEntry.standalone, '_blank');
                return;
            }
        }
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.tab-btn, .sidebar-item').forEach(b => b.classList.remove('active'));
        const tabEl = document.getElementById('tab-' + tabId);
        if (tabEl) tabEl.classList.add('active');
        window.scrollTo(0, 0);
        // Update URL hash for deep-linking
        if (history.replaceState) history.replaceState(null, '', '#' + tabId);
        // Highlight the sidebar item by mapping tabId → onclick attribute.
        document.querySelectorAll('.sidebar-item').forEach(b => {
            const onclickAttr = b.getAttribute('onclick') || '';
            if (onclickAttr.includes(`switchTab('${tabId}')`)) b.classList.add('active');
        });
        // Dashboard mega-tab: highlight "Leadership Dashboard" sidebar item for overview or cfv
        if (DASHBOARD_GROUP.includes(tabId)) {
            const dashItem = document.querySelector('[data-tab-group="dashboard"]');
            if (dashItem) dashItem.classList.add('active');
        }
        // Show/hide dashboard sub-tab bar
        const dashSubtabBar = document.getElementById('dashboardSubtabBar');
        if (dashSubtabBar) {
            if (DASHBOARD_GROUP.includes(tabId)) {
                dashSubtabBar.style.display = '';
                dashSubtabBar.querySelectorAll('.accounts-subtab').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tab === tabId);
                });
            } else {
                dashSubtabBar.style.display = 'none';
            }
        }
        // Accounts mega-tab: highlight the "Accounts" sidebar item for any sub-tab
        if (ACCOUNTS_GROUP.includes(tabId)) {
            const accountsItem = document.querySelector('[data-tab-group="accounts"]');
            if (accountsItem) accountsItem.classList.add('active');
        }
        // Show/hide accounts sub-tab bar and update active button
        const subtabBar = document.getElementById('accountsSubtabBar');
        if (subtabBar) {
            if (ACCOUNTS_GROUP.includes(tabId)) {
                subtabBar.style.display = '';
                subtabBar.querySelectorAll('.accounts-subtab').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.tab === tabId);
                });
            } else {
                subtabBar.style.display = 'none';
            }
        }
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
        // Render income tab on switch
        if (tabId === 'income') {
            if (typeof renderIncomeTab === 'function') renderIncomeTab();
        }
        // Render AR Variable tab on switch
        if (tabId === 'ar-variable') {
            if (typeof renderARVariableTab === 'function') renderARVariableTab();
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
        // Render Money Confidence on switch
        if (tabId === 'money') {
            if (typeof renderMoneyTab === 'function') renderMoneyTab();
        }
        // Render Wealth on switch
        if (tabId === 'wealth') {
            if (typeof renderWealthTab === 'function') renderWealthTab();
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
        // Load Prospecting pipeline on switch
        if (tabId === 'prospecting') {
            if (typeof loadProspectingTab === 'function') loadProspectingTab();
        }
        // Render Skills Library on switch
        if (tabId === 'skills') {
            if (typeof renderSkillsTab === 'function') renderSkillsTab();
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
        // Systemisation OS lazy-load (cache-busted so Pages deploys are picked up)
        if (tabId === 'systemisation') {
            const frame = document.getElementById('systemisationFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('systemisation')) {
                frame.src = frame.dataset.src + (frame.dataset.src.includes('?') ? '&' : '?') + 'cb=' + Date.now();
            }
        }
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
                frame.src = frame.dataset.src + '?cb=' + Date.now();
            }
        }
        if (tabId === 'os-team') {
            const frame = document.getElementById('osTeamFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('team')) {
                frame.src = frame.dataset.src + (frame.dataset.src.includes('?') ? '&' : '?') + 'cb=' + Date.now();
            }
        }
        // Content Machine (Marketing) lazy-load — standalone app loaded via iframe,
        // cache-busted so its Pages deploys are picked up without a hard refresh.
        if (tabId === 'content-machine') {
            const frame = document.getElementById('contentMachineFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('content-machine')) {
                frame.src = frame.dataset.src + (frame.dataset.src.includes('?') ? '&' : '?') + 'cb=' + Date.now();
            }
        }
        // AI Brain (Operations) lazy-load — standalone module page via iframe,
        // cache-busted so Pages deploys are picked up without a hard refresh.
        if (tabId === 'ai-brain') {
            const frame = document.getElementById('aiBrainFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('ai-brain')) {
                frame.src = frame.dataset.src + (frame.dataset.src.includes('?') ? '&' : '?') + 'cb=' + Date.now();
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

    function toggleCashflowRow(rowId, parentRow) {
        const row = document.getElementById(rowId);
        if (!row) return;
        const wasHidden = row.style.display === 'none';
        row.style.display = wasHidden ? 'table-row' : 'none';
        const idx = rowId.replace('cfrow-', '');
        const chevron = document.getElementById('cf-chev-' + idx);
        if (chevron) chevron.classList.toggle('open', wasHidden);
    }

    function escHtml(str) {
        // Escapes quotes as well as &<> so output is safe inside
        // double- AND single-quoted HTML attributes, not just text nodes.
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
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

    // ── Branded toast notification (replaces alert() for non-blocking messages) ──
    let _toastTimer = null;
    function showToast(msg, { type = 'info', duration = 4000 } = {}) {
        let el = document.getElementById('appToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'appToast';
            el.setAttribute('role', 'status');
            el.setAttribute('aria-live', 'polite');
            el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 20px;border-radius:var(--radius-md);font-size:var(--fs-sm);font-weight:var(--fw-medium);box-shadow:var(--shadow-lg);z-index:10000;opacity:0;transition:opacity 0.2s;pointer-events:none;max-width:480px;text-align:center';
            document.body.appendChild(el);
        }
        const colors = {
            info:    { bg: 'var(--info-bg)',    fg: 'var(--info)',    border: 'var(--info)' },
            success: { bg: 'var(--success-bg)', fg: 'var(--success)', border: 'var(--success)' },
            warning: { bg: 'var(--warning-bg)', fg: 'var(--warning)', border: 'var(--warning)' },
            error:   { bg: 'var(--danger-bg)',  fg: 'var(--danger)',  border: 'var(--danger)' },
        };
        const c = colors[type] || colors.info;
        el.style.background = c.bg;
        el.style.color = c.fg;
        el.style.border = '1px solid ' + c.border;
        el.textContent = msg;
        el.style.opacity = '1';
        clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => { el.style.opacity = '0'; }, duration);
    }

    // ── Branded confirm dialog (replaces confirm() with a promise-based modal) ──
    function showConfirm(msg, { title = 'Confirm', okLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:10001;display:flex;align-items:center;justify-content:center';
            overlay.setAttribute('role', 'presentation');
            const panel = document.createElement('div');
            panel.setAttribute('role', 'alertdialog');
            panel.setAttribute('aria-modal', 'true');
            panel.setAttribute('aria-label', title);
            panel.style.cssText = 'background:var(--bg-surface);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);padding:24px;max-width:420px;width:90%';
            panel.innerHTML = `<div style="font-size:var(--fs-lg);font-weight:var(--fw-semibold);color:var(--text-primary);margin-bottom:12px">${escHtml(title)}</div><div style="font-size:var(--fs-sm);color:var(--text-secondary);white-space:pre-wrap;margin-bottom:20px">${escHtml(msg)}</div><div style="display:flex;gap:8px;justify-content:flex-end"></div>`;
            const btnRow = panel.querySelector('div:last-child');
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = cancelLabel;
            cancelBtn.style.cssText = 'padding:8px 16px;border:1px solid var(--border-default);background:var(--bg-surface);color:var(--text-primary);border-radius:var(--radius-md);cursor:pointer;font-size:var(--fs-sm)';
            const okBtn = document.createElement('button');
            okBtn.textContent = okLabel;
            okBtn.style.cssText = `padding:8px 16px;border:none;background:${danger ? 'var(--danger)' : 'var(--accent)'};color:var(--accent-on);border-radius:var(--radius-md);cursor:pointer;font-size:var(--fs-sm);font-weight:var(--fw-semibold)`;
            btnRow.appendChild(cancelBtn);
            btnRow.appendChild(okBtn);
            function close(result) { overlay.remove(); resolve(result); }
            cancelBtn.onclick = () => close(false);
            okBtn.onclick = () => close(true);
            overlay.onclick = (e) => { if (e.target === overlay) close(false); };
            overlay.appendChild(panel);   // BUG FIX: panel was orphaned, so the
                                           // backdrop appeared but the dialog body
                                           // (title, message, buttons) was never
                                           // visible. Every CFV action button silently
                                           // failed because the user couldn't click
                                           // an OK button that wasn't in the DOM.
            document.body.appendChild(overlay);
            okBtn.focus();
        });
    }

    // ── Quick Task Creation Modal ──
    // Opens a lightweight task creation form as an overlay on the current page.
    // No tab switching required. Creates the task directly via Airtable API.
    // Fields match the full Task Drawer in os/tasks/index.html.
    function openQuickTaskModal(opts) {
        opts = opts || {};
        const existing = document.getElementById('quickTaskOverlay');
        if (existing) existing.remove();

        const isEdit = !!(opts && opts.task);
        const task = (opts && opts.task) || {};
        const tf = task.fields || {};
        const taskId = task.id || '';
        const todayStr = new Date().toISOString().split('T')[0];

        // Extract field values for edit mode
        const valName = isEdit ? (tf[TASK_FIELDS.name] || '') : (opts.name || '');
        const valDesc = isEdit ? (tf[TASK_FIELDS.description] || '') : (opts.description || '');
        const valDue = isEdit ? (tf[TASK_FIELDS.dueDate] || todayStr) : todayStr;
        const valHardDeadline = isEdit ? !!tf[TASK_FIELDS.hardDeadline] : false;
        const valTimeEst = isEdit ? (tf[TASK_FIELDS.timeEstimate] || '15 min') : '15 min';
        const valPriority = isEdit ? (tf[TASK_FIELDS.priority] || 'Not Urgent') : 'Not Urgent';
        const valStatus = isEdit ? (tf[TASK_FIELDS.status] || 'Today') : 'Today';
        const valBusinessRaw = isEdit ? (tf[TASK_FIELDS.business] || []) : (opts.business ? [opts.business] : []);
        const selectedBusinessId = Array.isArray(valBusinessRaw) ? valBusinessRaw[0] : valBusinessRaw;
        const valRecurring = isEdit ? (tf[TASK_FIELDS.recurring] || '') : '';
        const valProject = isEdit ? (tf[TASK_FIELDS.project] || []) : [];
        const assigneeRaw = isEdit ? (tf[TASK_FIELDS.assignee] || '') : '';
        const valAssignee = typeof assigneeRaw === 'object' ? (assigneeRaw.email || '') : assigneeRaw;
        const selectedProjectId = Array.isArray(valProject) ? valProject[0] : valProject;

        const overlay = document.createElement('div');
        overlay.id = 'quickTaskOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center';

        // Build team options
        const teamOptions = (typeof TASK_TEAM !== 'undefined' ? TASK_TEAM : []).map(m =>
            `<option value="${escHtml(m.key)}"${(m.email === valAssignee || m.key === valAssignee) ? ' selected' : ''}>${escHtml(m.name)}</option>`
        ).join('');

        // Build project options. The shell has no allProjects global (that
        // lives inside the os/tasks iframe), so projects are fetched once
        // and cached; the select is populated when the fetch resolves.
        let projectOptions = '<option value="">-</option>';
        const buildProjectOptions = (records) => {
            let opts = '<option value="">-</option>';
            records
                .filter(p => {
                    const st = (p.fields && (p.fields['Status'] || p.fields['Project Status'])) || '';
                    return st !== 'Completed' && st !== 'Cancelled';
                })
                .sort((a, b) => ((a.fields['Name'] || a.fields['Project Name'] || '') + '').localeCompare((b.fields['Name'] || b.fields['Project Name'] || '') + ''))
                .forEach(p => {
                    const pName = p.fields['Name'] || p.fields['Project Name'] || 'Unnamed';
                    const sel = p.id === selectedProjectId ? ' selected' : '';
                    opts += `<option value="${escHtml(p.id)}"${sel}>${escHtml(pName)}</option>`;
                });
            return opts;
        };
        if (window._qtProjectsCache) {
            projectOptions = buildProjectOptions(window._qtProjectsCache);
        } else {
            limitedApiFetch(() => fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.projects}?pageSize=100`, {
                headers: { 'Authorization': `Bearer ${PAT}` }
            }).then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
                .then(data => {
                    window._qtProjectsCache = data.records || [];
                    const selEl = document.getElementById('qtProject');
                    if (selEl) {
                        const current = selEl.value;
                        selEl.innerHTML = buildProjectOptions(window._qtProjectsCache);
                        if (current) selEl.value = current;
                    }
                })
                .catch(e => console.warn('Quick Task: projects fetch failed', e));
        }

        // Build select option helpers
        const makeOpts = (arr, selected) => arr.map(v => {
            const label = v || '-';
            return `<option value="${escHtml(v)}"${v === selected ? ' selected' : ''}>${escHtml(label)}</option>`;
        }).join('');

        const timeOpts = makeOpts(['15 min','30 min','45 min','1 hr','2 hr','3 hr','4 hr','8 hr'], valTimeEst);
        const priorityOpts = makeOpts(['Not Urgent','Project','Urgent'], valPriority);
        const statusOpts = makeOpts(['Today','Upcoming','Approval'], valStatus);
        let businessOpts = '<option value="">-</option>';
        if (typeof allBusinesses !== 'undefined' && Array.isArray(allBusinesses)) {
            // allBusinesses is fetched with returnFieldsByFieldId, so fields
            // are keyed by field ID — read via the BIZ_* constants, never names.
            allBusinesses
                .filter(b => getField(b, BIZ_ACTIVE_FIELD))
                .sort((a, b) => ((getField(a, BIZ_NAME_FIELD) || '') + '').localeCompare((getField(b, BIZ_NAME_FIELD) || '') + ''))
                .forEach(b => {
                    const bName = getField(b, BIZ_NAME_FIELD) || 'Unnamed';
                    const sel = b.id === selectedBusinessId ? ' selected' : '';
                    businessOpts += `<option value="${escHtml(b.id)}"${sel}>${escHtml(bName)}</option>`;
                });
        }
        const recurringOpts = makeOpts(['','Daily','Weekly','Fortnightly','Monthly','Quarterly','Bi-Annually','Annually'], valRecurring);

        // Styles matching drawer layout
        const lbl = 'font-size:11px;font-weight:600;color:var(--text-secondary,#5A6660);text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;min-width:110px';
        const inp = 'width:100%;padding:8px 10px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);font-size:var(--fs-sm,14px);font-family:inherit;box-sizing:border-box;background:var(--bg-surface,#fff)';
        const sel = inp + ';cursor:pointer';
        const row = 'display:flex;align-items:center;gap:12px';
        const secLbl = 'font-size:11px;font-weight:600;color:var(--text-secondary,#5A6660);text-transform:uppercase;letter-spacing:0.5px;margin-top:8px';

        const panel = document.createElement('div');
        panel.style.cssText = 'background:var(--bg-surface,#fff);border-radius:var(--radius-lg,12px);padding:24px;width:520px;max-width:90vw;max-height:90vh;overflow-y:auto;box-shadow:var(--shadow-lg,0 8px 32px rgba(0,0,0,0.2))';
        panel.innerHTML = `
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
                <span style="font-size:11px;font-weight:600;color:var(--text-secondary,#5A6660);text-transform:uppercase;letter-spacing:0.5px">Task</span>
                <button id="qtClose" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-muted,#8A928C);padding:0 4px;line-height:1">&times;</button>
            </div>
            <input id="qtName" type="text" value="${escHtml(valName)}" placeholder="(Untitled)" style="width:100%;padding:6px 8px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);font-size:16px;font-weight:600;font-family:inherit;box-sizing:border-box;color:var(--text-primary,#1C2422);margin-bottom:4px" />
            ${isEdit ? '<p style="font-size:12px;color:var(--text-muted,#8A928C);margin:0 0 12px 0">Click any field to edit. Changes auto-save.</p>' : '<div style="margin-bottom:12px"></div>'}

            <div style="display:flex;flex-direction:column;gap:10px">
                <!-- Assignee -->
                <div style="${row}">
                    <span style="${lbl}">Assignee</span>
                    <div style="flex:1;display:flex;gap:8px;align-items:center">
                        <select id="qtAssignee" style="${sel};flex:1">
                            <option value="">Select assignee...</option>
                            ${teamOptions}
                        </select>
                        ${isEdit ? `<button id="qtResendSlack" style="white-space:nowrap;padding:6px 10px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);cursor:pointer;font-size:12px;font-family:inherit;display:flex;align-items:center;gap:4px" title="Resend Slack notification">&#x1F514; Resend Slack</button>` : ''}
                    </div>
                </div>

                <!-- Due Date -->
                <div style="${row}">
                    <span style="${lbl}">Due Date</span>
                    <div style="flex:1"><input id="qtDue" type="date" value="${escHtml(valDue)}" style="${inp}" /></div>
                </div>

                <!-- Hard Deadline -->
                <div style="${row}">
                    <span style="${lbl}">Hard Deadline</span>
                    <div style="flex:1;display:flex;align-items:center;gap:8px">
                        <input id="qtHardDeadline" type="checkbox" ${valHardDeadline ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--accent,#2C6E49);cursor:pointer;flex-shrink:0" />
                        <span style="font-size:12px;font-weight:600;color:var(--warning,#C6A15B);text-transform:uppercase">Flag as immovable (never auto-rescheduled)</span>
                    </div>
                </div>

                <!-- Time Estimate -->
                <div style="${row}">
                    <span style="${lbl}">Time Estimate</span>
                    <div style="flex:1"><select id="qtTime" style="${sel}">${timeOpts}</select></div>
                </div>

                <!-- Priority -->
                <div style="${row}">
                    <span style="${lbl}">Priority</span>
                    <div style="flex:1"><select id="qtPriority" style="${sel}">${priorityOpts}</select></div>
                </div>

                <!-- Project -->
                <div style="${row}">
                    <span style="${lbl}">Project</span>
                    <div style="flex:1"><select id="qtProject" style="${sel}">${projectOptions}</select></div>
                </div>

                <!-- Status -->
                <div style="${row}">
                    <span style="${lbl}">Status</span>
                    <div style="flex:1"><select id="qtStatus" style="${sel}">${statusOpts}</select></div>
                </div>

                <!-- Business -->
                <div style="${row}">
                    <span style="${lbl}">Business</span>
                    <div style="flex:1"><select id="qtBusiness" style="${sel}">${businessOpts}</select></div>
                </div>

                <!-- Recurring -->
                <div style="${row}">
                    <span style="${lbl}">Recurring</span>
                    <div style="flex:1"><select id="qtRecurring" style="${sel}">${recurringOpts}</select></div>
                </div>

                <!-- Description -->
                <div style="margin-top:4px">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                        <span style="${secLbl};margin-top:0">Description</span>
                        <button id="qtDescExpand" style="font-size:11px;padding:2px 8px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface-2,#F4F6F1);cursor:pointer;color:var(--text-secondary,#5A6660);font-family:inherit">Expand</button>
                    </div>
                    <textarea id="qtDesc" rows="3" placeholder="Describe the task or the end result..." style="${inp};resize:vertical">${escHtml(valDesc)}</textarea>
                </div>

                <!-- Collaborators -->
                <div style="margin-top:4px">
                    <span style="${secLbl}">Collaborators</span>
                    <div id="qtCollaborators" style="margin-top:6px">
                        <button id="qtAddCollab" style="padding:6px 12px;border:1px solid var(--accent,#2C6E49);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);color:var(--accent,#2C6E49);cursor:pointer;font-size:12px;font-family:inherit;font-weight:600">+ Add Collaborator</button>
                    </div>
                </div>

                <!-- Attachments -->
                <div style="margin-top:4px">
                    <span style="${secLbl}">Attachments</span>
                    <div id="qtAttachmentsList" style="margin-top:6px"></div>
                    <div id="qtAttachmentsDrop" style="margin-top:6px;padding:16px;border:2px dashed var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);text-align:center;color:var(--text-muted,#8A928C);font-size:12px;cursor:${isEdit ? 'pointer' : 'default'};transition:border-color 0.2s,background 0.2s">
                        ${isEdit ? '<span style="pointer-events:none">&#x1F4CE; Drop files here or click to upload</span>' : '<span>Save task first to add attachments</span>'}
                        ${isEdit ? '<input type="file" id="qtFileInput" multiple style="display:none">' : ''}
                    </div>
                </div>
            </div>

            <!-- Comments (edit mode only) -->
            ${isEdit ? `
            <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border-subtle,#E5E8E1)">
                <button id="qtCommentsBtn" style="width:100%;padding:10px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface-2,#F4F6F1);cursor:pointer;font-size:13px;font-family:inherit;color:var(--text-primary,#1C2422);display:flex;align-items:center;justify-content:center;gap:6px">
                    &#x1F4AC; Add &amp; View Comments <span id="qtCommentCount" style="background:var(--accent,#2C6E49);color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:600"></span>
                </button>
                <div id="qtCommentsSection" style="display:none;margin-top:12px">
                    <textarea id="qtCommentInput" rows="2" placeholder="Write a comment..." style="${inp};resize:vertical;margin-bottom:8px"></textarea>
                    <button id="qtPostComment" style="padding:6px 12px;border:none;border-radius:var(--radius-sm,4px);background:var(--accent,#2C6E49);color:#fff;cursor:pointer;font-size:12px;font-family:inherit;font-weight:600;margin-bottom:12px">Post Comment</button>
                    <div id="qtCommentsList" style="max-height:200px;overflow-y:auto"></div>
                </div>
            </div>` : ''}

            <!-- Footer -->
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--border-subtle,#E5E8E1)">
                <button id="qtCancel" style="padding:8px 16px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);color:var(--text-primary,#1C2422);cursor:pointer;font-size:var(--fs-sm,14px);font-family:inherit">Cancel</button>
                ${isEdit ? `
                    <button id="qtDelete" style="padding:8px 16px;border:1px solid var(--danger,#DC3545);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);color:var(--danger,#DC3545);cursor:pointer;font-size:var(--fs-sm,14px);font-family:inherit">Delete</button>
                    <button id="qtComplete" style="padding:8px 16px;border:none;border-radius:var(--radius-sm,4px);background:var(--accent,#2C6E49);color:#fff;cursor:pointer;font-size:var(--fs-sm,14px);font-family:inherit;font-weight:var(--fw-semibold,600)">Complete</button>
                ` : `
                    <button id="qtSubmit" style="padding:8px 16px;border:none;border-radius:var(--radius-sm,4px);background:var(--accent,#2C6E49);color:#fff;cursor:pointer;font-size:var(--fs-sm,14px);font-family:inherit;font-weight:var(--fw-semibold,600)">Create Task</button>
                `}
            </div>
        `;

        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        // The Business options are built from allBusinesses, which may still be
        // loading when the drawer opens (e.g. straight into Systemisation →
        // Assign Video Task). Repopulate once the data lands so the field is
        // never an empty, dead dropdown.
        if (businessOpts === '<option value="">-</option>') {
            let bizTries = 0;
            const bizPoll = setInterval(() => {
                bizTries++;
                const selEl = panel.querySelector('#qtBusiness');
                if (!selEl || !document.body.contains(selEl) || bizTries > 40) { clearInterval(bizPoll); return; }
                if (typeof allBusinesses !== 'undefined' && Array.isArray(allBusinesses) && allBusinesses.length) {
                    clearInterval(bizPoll);
                    let optsHtml = '<option value="">-</option>';
                    allBusinesses
                        .filter(b => getField(b, BIZ_ACTIVE_FIELD))
                        .sort((a, b) => ((getField(a, BIZ_NAME_FIELD) || '') + '').localeCompare((getField(b, BIZ_NAME_FIELD) || '') + ''))
                        .forEach(b => {
                            const s2 = b.id === selectedBusinessId ? ' selected' : '';
                            optsHtml += `<option value="${escHtml(b.id)}"${s2}>${escHtml(getField(b, BIZ_NAME_FIELD) || 'Unnamed')}</option>`;
                        });
                    selEl.innerHTML = optsHtml;
                    if (selectedBusinessId) selEl.value = selectedBusinessId;
                }
            }, 500);
        }

        // Close handlers
        const handleEsc = (e) => { if (e.key === 'Escape') closeModal(); };
        document.addEventListener('keydown', handleEsc);
        const closeModal = () => { overlay.remove(); document.removeEventListener('keydown', handleEsc); };
        panel.querySelector('#qtClose').onclick = closeModal;
        panel.querySelector('#qtCancel').onclick = closeModal;
        overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };

        // Description expand/collapse
        const descExpand = panel.querySelector('#qtDescExpand');
        if (descExpand) {
            descExpand.onclick = () => {
                const ta = panel.querySelector('#qtDesc');
                if (ta.rows < 8) { ta.rows = 10; descExpand.textContent = 'Collapse'; }
                else { ta.rows = 3; descExpand.textContent = 'Expand'; }
            };
        }

        // Collaborator stub
        const addCollabBtn = panel.querySelector('#qtAddCollab');
        if (addCollabBtn) {
            addCollabBtn.onclick = () => {
                if (!isEdit) { showToast('Save the task first to add collaborators', { type: 'info' }); return; }
                showToast('Collaborator management coming soon', { type: 'info' });
            };
        }

        if (isEdit) {
            // ── Auto-save helper ──
            const autoSave = async (fieldId, value) => {
                try {
                    const f = {}; f[fieldId] = value;
                    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tasks}/${taskId}`, {
                        method: 'PATCH',
                        headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fields: f })
                    });
                    if (!res.ok) throw new Error(res.status);
                } catch (e) { showToast('Failed to save: ' + e.message, { type: 'error' }); }
            };

            // Wire auto-save on every field
            panel.querySelector('#qtName').onblur = () => autoSave(TASK_FIELDS.name, panel.querySelector('#qtName').value.trim());
            panel.querySelector('#qtAssignee').onchange = () => {
                const key = panel.querySelector('#qtAssignee').value;
                const m = (typeof TASK_TEAM !== 'undefined' ? TASK_TEAM : []).find(x => x.key === key);
                if (m) autoSave(TASK_FIELDS.assignee, { email: m.email });
            };
            panel.querySelector('#qtDue').onchange = () => autoSave(TASK_FIELDS.dueDate, panel.querySelector('#qtDue').value);
            panel.querySelector('#qtHardDeadline').onchange = () => autoSave(TASK_FIELDS.hardDeadline, panel.querySelector('#qtHardDeadline').checked);
            panel.querySelector('#qtTime').onchange = () => autoSave(TASK_FIELDS.timeEstimate, panel.querySelector('#qtTime').value);
            panel.querySelector('#qtPriority').onchange = () => autoSave(TASK_FIELDS.priority, panel.querySelector('#qtPriority').value);
            panel.querySelector('#qtProject').onchange = () => {
                const p = panel.querySelector('#qtProject').value;
                autoSave(TASK_FIELDS.project, p ? [p] : []);
            };
            panel.querySelector('#qtStatus').onchange = () => autoSave(TASK_FIELDS.status, panel.querySelector('#qtStatus').value);
            panel.querySelector('#qtBusiness').onchange = () => {
                const b = panel.querySelector('#qtBusiness').value;
                autoSave(TASK_FIELDS.business, b ? [b] : []);
            };
            panel.querySelector('#qtRecurring').onchange = () => autoSave(TASK_FIELDS.recurring, panel.querySelector('#qtRecurring').value);
            panel.querySelector('#qtDesc').onblur = () => autoSave(TASK_FIELDS.description, panel.querySelector('#qtDesc').value);

            // ── Delete handler ──
            const deleteBtn = panel.querySelector('#qtDelete');
            if (deleteBtn) {
                deleteBtn.onclick = async () => {
                    const ok = await showConfirm('Are you sure you want to delete this task? This cannot be undone.', { title: 'Delete Task', okLabel: 'Delete', danger: true });
                    if (!ok) return;
                    deleteBtn.disabled = true; deleteBtn.textContent = 'Deleting...';
                    try {
                        const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tasks}/${taskId}`, {
                            method: 'DELETE', headers: { Authorization: 'Bearer ' + PAT }
                        });
                        if (!res.ok) throw new Error('Delete failed: ' + res.status);
                        closeModal();
                        showToast('Task deleted', { type: 'success' });
                        if (typeof allTasks !== 'undefined') {
                            const idx = allTasks.findIndex(t => t.id === taskId);
                            if (idx > -1) allTasks.splice(idx, 1);
                        }
                    } catch (err) {
                        deleteBtn.disabled = false; deleteBtn.textContent = 'Delete';
                        showToast('Failed to delete: ' + err.message, { type: 'error' });
                    }
                };
            }

            // ── Complete handler ──
            const completeBtn = panel.querySelector('#qtComplete');
            if (completeBtn) {
                completeBtn.onclick = async () => {
                    completeBtn.disabled = true; completeBtn.textContent = 'Completing...';
                    try {
                        const f = {}; f[TASK_FIELDS.status] = 'Completed';
                        const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tasks}/${taskId}`, {
                            method: 'PATCH',
                            headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ fields: f })
                        });
                        if (!res.ok) throw new Error('Complete failed: ' + res.status);
                        closeModal();
                        showToast('Task completed', { type: 'success' });
                        if (typeof allTasks !== 'undefined') {
                            const t = allTasks.find(x => x.id === taskId);
                            if (t && t.fields) t.fields[TASK_FIELDS.status] = 'Completed';
                        }
                    } catch (err) {
                        completeBtn.disabled = false; completeBtn.textContent = 'Complete';
                        showToast('Failed to complete: ' + err.message, { type: 'error' });
                    }
                };
            }

            // ── Resend Slack notification (calls the slack-notify worker,
            // same request shape as os/tasks notifyAssigneeSlack) ──
            const resendBtn = panel.querySelector('#qtResendSlack');
            if (resendBtn) {
                resendBtn.onclick = async () => {
                    const assigneeKey = panel.querySelector('#qtAssignee')?.value || '';
                    const member = (typeof TASK_TEAM !== 'undefined' ? TASK_TEAM : []).find(m => m.key === assigneeKey || m.email === assigneeKey);
                    const taskName = (panel.querySelector('#qtName')?.value || '').trim();
                    if (!member || !member.email) { showToast('Pick an assignee first', { type: 'warning' }); return; }
                    if (!taskName || taskName === '(Untitled)') { showToast('Give the task a name first', { type: 'warning' }); return; }
                    resendBtn.disabled = true;
                    try {
                        const res = await fetch(SLACK_NOTIFY_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ recipientEmail: member.email, taskName, taskId, actorName: 'Operations Director', action: 'assigned' })
                        });
                        if (!res.ok) throw new Error('HTTP ' + res.status);
                        showToast('Slack notification sent to ' + member.name, { type: 'success' });
                    } catch (err) {
                        showToast('Slack notification failed: ' + err.message, { type: 'error' });
                    } finally {
                        resendBtn.disabled = false;
                    }
                };
            }

            // ── Attachments ──
            const attDrop = panel.querySelector('#qtAttachmentsDrop');
            const attFileInput = panel.querySelector('#qtFileInput');
            const attListEl = panel.querySelector('#qtAttachmentsList');
            if (attDrop && isEdit) {
                // Show existing attachments
                const existingAtts = tf[TASK_FIELDS.attachments] || [];
                function renderExistingAttachments(atts) {
                    if (!attListEl || !atts || atts.length === 0) { if (attListEl) attListEl.innerHTML = ''; return; }
                    attListEl.innerHTML = atts.map((a, i) => {
                        const fname = escHtml(a.filename || 'file');
                        const thumb = a.thumbnails && a.thumbnails.small ? a.thumbnails.small.url : '';
                        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--bg-surface-2,#F4F6F1);border-radius:var(--radius-sm,4px);margin-bottom:4px">
                            ${thumb ? `<img src="${escHtml(thumb)}" style="width:28px;height:28px;object-fit:cover;border-radius:3px">` : '<span style="font-size:16px">&#x1F4CE;</span>'}
                            <a href="${escHtml(a.url)}" target="_blank" rel="noopener" style="flex:1;color:var(--accent,#2C6E49);font-size:12px;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${fname}</a>
                            <span style="font-size:10px;color:var(--text-muted,#8A928C)">${a.size ? (a.size / 1024).toFixed(0) + ' KB' : ''}</span>
                        </div>`;
                    }).join('');
                }
                renderExistingAttachments(existingAtts);

                // Drag-drop handlers
                attDrop.ondragover = (e) => { e.preventDefault(); attDrop.style.borderColor = 'var(--accent,#2C6E49)'; attDrop.style.background = 'var(--accent-soft,#DDE8DF)'; };
                attDrop.ondragleave = () => { attDrop.style.borderColor = 'var(--border-default,#DDE1D9)'; attDrop.style.background = ''; };
                attDrop.ondrop = (e) => {
                    e.preventDefault();
                    attDrop.style.borderColor = 'var(--border-default,#DDE1D9)'; attDrop.style.background = '';
                    if (e.dataTransfer.files.length) uploadAttachments(e.dataTransfer.files);
                };
                attDrop.onclick = () => { if (attFileInput) attFileInput.click(); };
                if (attFileInput) attFileInput.onchange = () => { if (attFileInput.files.length) uploadAttachments(attFileInput.files); attFileInput.value = ''; };

                async function uploadAttachments(files) {
                    attDrop.innerHTML = '<span style="color:var(--text-muted,#8A928C);font-size:12px">Uploading...</span>';
                    try {
                        for (const file of files) {
                            const formData = new FormData();
                            formData.append('file', file);
                            const res = await fetch(`https://content.airtable.com/v0/${BASE_ID}/${TABLES.tasks}/${taskId}/${TASK_FIELDS.attachments}/uploadAttachment`, {
                                method: 'POST',
                                headers: { Authorization: 'Bearer ' + PAT },
                                body: formData
                            });
                            if (!res.ok) throw new Error('Upload failed: ' + res.status);
                        }
                        // Refresh attachments list
                        const recRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tasks}/${taskId}?fields[]=${TASK_FIELDS.attachments}`, {
                            headers: { Authorization: 'Bearer ' + PAT }
                        });
                        if (recRes.ok) {
                            const recData = await recRes.json();
                            renderExistingAttachments(recData.fields[TASK_FIELDS.attachments] || []);
                        }
                        showToast(files.length + ' file(s) uploaded', { type: 'success' });
                    } catch (err) {
                        showToast('Upload failed: ' + err.message, { type: 'error' });
                    }
                    attDrop.innerHTML = '<span style="pointer-events:none">&#x1F4CE; Drop files here or click to upload</span><input type="file" id="qtFileInput" multiple style="display:none">';
                    const newInput = attDrop.querySelector('#qtFileInput');
                    if (newInput) newInput.onchange = () => { if (newInput.files.length) uploadAttachments(newInput.files); newInput.value = ''; };
                }
            }

            // ── Comments ──
            const commentsBtn = panel.querySelector('#qtCommentsBtn');
            const commentsSection = panel.querySelector('#qtCommentsSection');
            if (commentsBtn && commentsSection) {
                // Load comment count
                (async () => {
                    try {
                        const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tasks}/${taskId}/comments`, {
                            headers: { Authorization: 'Bearer ' + PAT }
                        });
                        if (res.ok) {
                            const data = await res.json();
                            const comments = data.comments || [];
                            panel._comments = comments;
                            const countEl = panel.querySelector('#qtCommentCount');
                            if (countEl && comments.length > 0) countEl.textContent = comments.length;
                        }
                    } catch (e) { console.warn('Quick Task: comment count load failed', e); }
                })();

                commentsBtn.onclick = () => {
                    const open = commentsSection.style.display !== 'none';
                    commentsSection.style.display = open ? 'none' : 'block';
                    if (!open) {
                        const list = panel.querySelector('#qtCommentsList');
                        const comments = panel._comments || [];
                        if (comments.length === 0) {
                            list.innerHTML = '<p style="text-align:center;color:var(--text-muted);font-size:12px;padding:8px">No comments yet</p>';
                        } else {
                            list.innerHTML = comments.map(c => `
                                <div style="padding:8px;border-bottom:1px solid var(--border-subtle,#E5E8E1);font-size:13px">
                                    <div style="font-weight:600;color:var(--text-primary);margin-bottom:2px">${escHtml((c.author && c.author.name) || 'Unknown')}</div>
                                    <div style="color:var(--text-secondary)">${escHtml(c.text || '')}</div>
                                    <div style="color:var(--text-muted);font-size:11px;margin-top:2px">${new Date(c.createdTime).toLocaleString()}</div>
                                </div>`).join('');
                        }
                    }
                };

                // Post comment
                const postBtn = panel.querySelector('#qtPostComment');
                if (postBtn) {
                    postBtn.onclick = async () => {
                        const input = panel.querySelector('#qtCommentInput');
                        const text = input.value.trim();
                        if (!text) return;
                        postBtn.disabled = true; postBtn.textContent = 'Posting...';
                        try {
                            const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tasks}/${taskId}/comments`, {
                                method: 'POST',
                                headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                                body: JSON.stringify({ text })
                            });
                            if (!res.ok) throw new Error('Failed to post comment');
                            input.value = '';
                            showToast('Comment posted', { type: 'success' });
                            // Refresh comments
                            const rr = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tasks}/${taskId}/comments`, {
                                headers: { Authorization: 'Bearer ' + PAT }
                            });
                            if (rr.ok) {
                                const data = await rr.json();
                                panel._comments = data.comments || [];
                                const countEl = panel.querySelector('#qtCommentCount');
                                if (countEl) countEl.textContent = panel._comments.length || '';
                                // Re-render list
                                commentsSection.style.display = 'none';
                                commentsBtn.click();
                            }
                        } catch (err) {
                            showToast('Failed to post comment: ' + err.message, { type: 'error' });
                        }
                        postBtn.disabled = false; postBtn.textContent = 'Post Comment';
                    };
                }
            }
        } else {
            // ── Create mode submit ──
            panel.querySelector('#qtSubmit').onclick = async () => {
                const taskName = panel.querySelector('#qtName').value.trim();
                if (!taskName) { showToast('Task name is required', { type: 'warning' }); return; }
                // Systemisation video tasks must belong to a business so the SOP
                // (and everything generated from it) is segregated per business.
                if (opts.requireBusiness && !panel.querySelector('#qtBusiness').value) {
                    showToast('Pick a Business — every SOP must belong to one', { type: 'warning' });
                    return;
                }

                const submitBtn = panel.querySelector('#qtSubmit');
                submitBtn.disabled = true; submitBtn.textContent = 'Creating...';

                try {
                    const assigneeKey = panel.querySelector('#qtAssignee').value;
                    const member = (typeof TASK_TEAM !== 'undefined' ? TASK_TEAM : []).find(m => m.key === assigneeKey);

                    const fields = {};
                    fields[TASK_FIELDS.name] = taskName;
                    fields[TASK_FIELDS.description] = panel.querySelector('#qtDesc').value;
                    fields[TASK_FIELDS.dueDate] = panel.querySelector('#qtDue').value || todayStr;
                    fields[TASK_FIELDS.priority] = panel.querySelector('#qtPriority').value;
                    fields[TASK_FIELDS.timeEstimate] = panel.querySelector('#qtTime').value;
                    fields[TASK_FIELDS.status] = panel.querySelector('#qtStatus').value;
                    if (member) fields[TASK_FIELDS.assignee] = { email: member.email };
                    const biz = panel.querySelector('#qtBusiness').value;
                    if (biz) fields[TASK_FIELDS.business] = [biz];
                    const rec = panel.querySelector('#qtRecurring').value;
                    if (rec) fields[TASK_FIELDS.recurring] = rec;
                    fields[TASK_FIELDS.hardDeadline] = panel.querySelector('#qtHardDeadline').checked;
                    const proj = panel.querySelector('#qtProject').value;
                    if (proj) fields[TASK_FIELDS.project] = [proj];

                    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tasks}`, {
                        method: 'POST',
                        headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ records: [{ fields }] })
                    });
                    if (!res.ok) throw new Error('Airtable error: ' + res.status);
                    const resData = await res.json();
                    const createdId = resData.records && resData.records[0] ? resData.records[0].id : null;

                    // Send task ID back to source iframe (e.g. Systemisation)
                    if (createdId && opts && opts._wfId) {
                        document.querySelectorAll('iframe').forEach(f => {
                            try {
                                f.contentWindow.postMessage({
                                    type: 'qt:task-created',
                                    taskId: createdId,
                                    wfId: opts._wfId,
                                }, '*');
                            } catch(e) { /* cross-origin iframe, skip */ }
                        });
                    }

                    closeModal();
                    showToast('Task created: ' + taskName, { type: 'success' });
                } catch (err) {
                    submitBtn.disabled = false; submitBtn.textContent = 'Create Task';
                    showToast('Failed to create task: ' + err.message, { type: 'error' });
                }
            };
        }

        panel.querySelector('#qtName').focus();
    }

