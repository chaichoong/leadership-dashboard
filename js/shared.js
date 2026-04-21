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
        const iframeTabs = ['os-strategy', 'os-hub', 'os-bplan', 'tasks', 'launch-plan', 'comms', 'compliance', 'airtable'];
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

    // Check session on load — deferred to DOMContentLoaded so all JS modules are parsed
    // and loadDashboard (defined in dashboard.js) is available before we call it.
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
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _opsDirectorInit);
    } else {
        _opsDirectorInit();
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

            const resp = await fetch(url, {
                headers: { 'Authorization': `Bearer ${PAT}` }
            });
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
        const status = getPaymentStatusName(getField(rec, F.costPayStatus));
        const validStatuses = ['In Payment', 'Active', 'Overdue', 'Due Today', 'Upcoming'];
        const inactive = getField(rec, F.costInactive);
        return validStatuses.includes(status) && !inactive;
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

    function switchTab(tabId) {
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.tab-btn, .sidebar-item').forEach(b => b.classList.remove('active'));
        document.getElementById('tab-' + tabId).classList.add('active');
        // Update URL hash for deep-linking
        if (history.replaceState) history.replaceState(null, '', '#' + tabId);
        // Highlight the sidebar item
        // OS-INTEGRATION: 'os-hub' and 'os-bplan' keys below — DO NOT REMOVE (see MEMORY.md)
        const tabLabelMap = { overview: 'Leadership', tasks: 'Task and Project Management OS', airtable: 'Contractor', invoices: 'Invoices', pnl: 'Profit', cfv: 'Cash Flow Voids', comms: 'Inbound', compliance: 'Compliance', sitemap: 'Site Map', fintable: 'Fintable', 'os-hub': 'Operating Systems', 'os-bplan': 'Business Launch Plan Builder', 'os-strategy': 'Objective & Strategy', 'launch-plan': 'Director Launch Plan' };
        document.querySelectorAll('.sidebar-item').forEach(b => {
            if (b.textContent.includes(tabLabelMap[tabId] || '')) b.classList.add('active');
        });
        // Also highlight old tab buttons (if visible)
        document.querySelectorAll('.tab-btn').forEach(b => {
            if ((tabId === 'overview' && b.textContent.includes('Leadership')) ||
                (tabId === 'airtable' && b.textContent.includes('Contractor')) ||
                (tabId === 'invoices' && b.textContent.includes('Invoices')) ||
                (tabId === 'cfv' && b.textContent.includes('Cash Flow Voids'))) {
                b.classList.add('active');
            }
        });
        // Lazy-load iframes on first switch
        if (tabId === 'airtable') {
            const frame = document.getElementById('airtableFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('airtable.com')) frame.src = frame.dataset.src;
        }
        if (tabId === 'comms') {
            const frame = document.getElementById('commsFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('follow-up')) frame.src = frame.dataset.src;
        }
        if (tabId === 'compliance') {
            const frame = document.getElementById('complianceFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('compliance')) frame.src = frame.dataset.src;
        }
        // Render invoices tab on switch
        if (tabId === 'invoices') {
            renderInvoiceTab();
        }
        // Render Profit & Loss on switch
        if (tabId === 'pnl') {
            if (typeof renderPnL === 'function') renderPnL();
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
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('tasks')) frame.src = frame.dataset.src;
        }
        // Launch Plan lazy-load
        if (tabId === 'launch-plan') {
            const frame = document.getElementById('launchPlanFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('launch-plan')) frame.src = frame.dataset.src;
        }
        // OS-INTEGRATION: Lazy-load iframes — DO NOT REMOVE (see MEMORY.md)
        if (tabId === 'os-hub') {
            const frame = document.getElementById('osHubFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('os/')) frame.src = frame.dataset.src;
        }
        if (tabId === 'os-bplan') {
            const frame = document.getElementById('osBplanFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('business-plan')) frame.src = frame.dataset.src;
        }
        if (tabId === 'os-strategy') {
            const frame = document.getElementById('osStrategyFrame');
            if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('strategy')) frame.src = frame.dataset.src;
        }
        // /OS-INTEGRATION: Lazy-load

        // Refresh data on tab switch (but don't interrupt if already loading)
        if (PAT && !document.getElementById('loadingOverlay').style.display.includes('flex')) {
            loadDashboard();
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

