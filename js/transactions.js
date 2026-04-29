// ══════════════════════════════════════════
// TRANSACTIONS — Searchable, filterable historical transaction explorer
// Reads from allTransactions (already loaded by dashboard.js)
// Virtual scrolling keeps DOM small even with 8000+ records
// ══════════════════════════════════════════

    // ── Shared grid template for header + rows (kept in lockstep) ──
    // 13 columns matching the reconciliation engine's linked-record set, plus Account.
    // Vendor/Description uses minmax(...,1fr) so it absorbs any extra width and
    // shrinks with text-overflow:ellipsis on tight screens. Tightened from the
    // original 1700px min so the table fits standard laptop content widths
    // (~1200–1280) without horizontal scroll.
    const _TX_GRID = '70px minmax(100px, 1.4fr) 85px 105px 125px 90px 105px 105px 85px 110px 100px 90px 45px';

    // ── Module state ──
    let _txState = {
        rendered: false,
        filtered: [],          // current filtered/sorted list of tx records
        sortBy: 'date',        // date | amount | vendor
        sortDir: 'desc',       // asc | desc
        search: '',
        f_business: '',
        f_category: '',
        f_subcat: '',
        f_account: '',
        f_recon: '',           // '', 'yes', 'no'
        f_dateFrom: '',
        f_dateTo: '',
        f_amountMin: '',
        f_amountMax: '',
        rowH: 44,              // row height in px
        viewportH: 600,        // table viewport height
        scrollTop: 0,
        // Lookup maps (built once per render)
        subCatById: {},
        catById: {},
        bizById: {},
        costById: {},
        unitById: {},
        tenancyById: {},
        tenancyRecById: {},   // full tenancy record (for tenant + property resolution)
        tenantById: {},       // tenant name by tenant id
        unitPropById: {},     // property name (string) keyed by unit id
    };

    // ── Build name lookups from globally-loaded data ──
    function _txBuildLookups() {
        const s = _txState;
        s.subCatById = {};
        (allSubCategories || []).forEach(r => {
            const n = getField(r, 'fldYDOOrhEUAQAaNb') || r.fields?.Name || Object.values(r.fields || {})[0];
            s.subCatById[r.id] = typeof n === 'string' ? n : (n?.name || '');
        });
        s.catById = {};
        (allCategories || []).forEach(r => {
            const n = r.fields?.Name || Object.values(r.fields || {})[0];
            s.catById[r.id] = typeof n === 'string' ? n : (n?.name || '');
        });
        s.bizById = {};
        (allBusinesses || []).forEach(r => {
            const n = r.fields?.Name || Object.values(r.fields || {})[0];
            s.bizById[r.id] = typeof n === 'string' ? n : (n?.name || '');
        });
        s.costById = {};
        (allCosts || []).forEach(r => {
            const n = getField(r, F.costName);
            s.costById[r.id] = typeof n === 'string' ? n : (n?.name || '');
        });
        s.unitById = {};
        (allRentalUnits || []).forEach(r => {
            const n = getField(r, F.unitName);
            s.unitById[r.id] = typeof n === 'string' ? n : (n?.name || '');
        });
        s.tenancyById = {};
        s.tenancyRecById = {};
        (allTenancies || []).forEach(r => {
            const n = getField(r, F.tenRef);
            s.tenancyById[r.id] = typeof n === 'string' ? n : (n?.name || '');
            s.tenancyRecById[r.id] = r;
        });
        // Tenant id → tenant display name (resolves Tenancy → Customers link)
        s.tenantById = {};
        (typeof allTenants !== 'undefined' && allTenants ? allTenants : []).forEach(r => {
            const n = getField(r, F.tenantName);
            s.tenantById[r.id] = typeof n === 'string' ? n : (n?.name || '');
        });
        // Unit id → property name string (via the unit's Property Name lookup)
        s.unitPropById = {};
        (allRentalUnits || []).forEach(r => {
            const v = getField(r, F.unitPropName);
            if (Array.isArray(v) && v.length) s.unitPropById[r.id] = String(v[0]);
            else if (typeof v === 'string') s.unitPropById[r.id] = v;
        });
    }

    // Resolve tenant name for a transaction:
    //   tx → tenancy → tenancy.tenLinkedTenant → tenant.name
    function _txTenantNameFor(rec) {
        const s = _txState;
        const tenancyId = _txLinkedId(rec, F.txTenancy);
        if (!tenancyId) return '';
        const tenancy = s.tenancyRecById[tenancyId];
        if (!tenancy) return '';
        const linked = getField(tenancy, F.tenLinkedTenant);
        if (!linked) return '';
        const tenantId = Array.isArray(linked) ? (typeof linked[0] === 'string' ? linked[0] : linked[0]?.id) : '';
        return tenantId ? (s.tenantById[tenantId] || '') : '';
    }

    // Resolve property name for a transaction:
    //   1) tenancy → F.tenProperty (string lookup)
    //   2) unit → F.unitPropName (string lookup)
    function _txPropertyNameFor(rec) {
        const s = _txState;
        const tenancyId = _txLinkedId(rec, F.txTenancy);
        if (tenancyId) {
            const tenancy = s.tenancyRecById[tenancyId];
            if (tenancy) {
                const v = getField(tenancy, F.tenProperty);
                if (Array.isArray(v) && v.length) return String(v[0]);
                if (typeof v === 'string') return v;
            }
        }
        const unitId = _txLinkedId(rec, F.txUnit);
        if (unitId && s.unitPropById[unitId]) return s.unitPropById[unitId];
        return '';
    }

    // ── Helpers to extract fields cleanly ──
    function _txLinkedId(rec, fieldId) {
        const v = getField(rec, fieldId);
        if (!v) return '';
        if (Array.isArray(v) && v.length) return typeof v[0] === 'string' ? v[0] : (v[0]?.id || '');
        return '';
    }
    function _txAmount(rec) {
        const a = getField(rec, F.txReportAmount);
        if (a != null) return Number(a) || 0;
        return Number(getField(rec, F.txAmount)) || 0;
    }
    function _txAccountName(rec) {
        const a = getField(rec, F.txAccountAlias);
        if (Array.isArray(a) && a.length) return String(a[0]);
        if (typeof a === 'string') return a;
        return '';
    }
    function _txDateStr(rec) {
        const d = getField(rec, F.txDate);
        return d ? String(d) : '';
    }

    // ── Build searchable text blob (cached per record on first access) ──
    function _txSearchBlob(rec) {
        if (rec._txBlob) return rec._txBlob;
        const s = _txState;
        const parts = [
            getField(rec, F.txVendor) || '',
            getField(rec, F.txDescription) || '',
            _txAccountName(rec),
            s.subCatById[_txLinkedId(rec, F.txSubCategory)] || '',
            s.catById[_txLinkedId(rec, F.txCategory)] || '',
            s.bizById[_txLinkedId(rec, F.txBusiness)] || '',
            s.costById[_txLinkedId(rec, F.txCost)] || '',
            s.unitById[_txLinkedId(rec, F.txUnit)] || '',
            s.tenancyById[_txLinkedId(rec, F.txTenancy)] || '',
            _txTenantNameFor(rec),
            _txPropertyNameFor(rec),
            String(_txAmount(rec).toFixed(2)),
            _txDateStr(rec),
        ];
        rec._txBlob = parts.join(' ').toLowerCase();
        return rec._txBlob;
    }

    // ── Apply filters + sort ──
    function _txApplyFilters() {
        const s = _txState;
        const all = (typeof allTransactions !== 'undefined' && allTransactions) ? allTransactions : [];
        const search = s.search.trim().toLowerCase();
        const searchTokens = search ? search.split(/\s+/).filter(Boolean) : [];
        const dateFrom = s.f_dateFrom ? s.f_dateFrom : '';
        const dateTo = s.f_dateTo ? s.f_dateTo : '';
        const amtMin = s.f_amountMin === '' ? null : Number(s.f_amountMin);
        const amtMax = s.f_amountMax === '' ? null : Number(s.f_amountMax);

        const filtered = [];
        for (const rec of all) {
            // Date range
            const d = _txDateStr(rec);
            if (dateFrom && d < dateFrom) continue;
            if (dateTo && d > dateTo) continue;
            // Reconciled filter
            if (s.f_recon === 'yes' && !getField(rec, F.txReconciled)) continue;
            if (s.f_recon === 'no' && getField(rec, F.txReconciled)) continue;
            // Business / category / sub-cat / account
            if (s.f_business && _txLinkedId(rec, F.txBusiness) !== s.f_business) continue;
            if (s.f_category && _txLinkedId(rec, F.txCategory) !== s.f_category) continue;
            if (s.f_subcat && _txLinkedId(rec, F.txSubCategory) !== s.f_subcat) continue;
            if (s.f_account && _txAccountName(rec) !== s.f_account) continue;
            // Amount
            if (amtMin != null || amtMax != null) {
                const abs = Math.abs(_txAmount(rec));
                if (amtMin != null && abs < amtMin) continue;
                if (amtMax != null && abs > amtMax) continue;
            }
            // Search
            if (searchTokens.length) {
                const blob = _txSearchBlob(rec);
                let ok = true;
                for (const t of searchTokens) { if (!blob.includes(t)) { ok = false; break; } }
                if (!ok) continue;
            }
            filtered.push(rec);
        }

        // Sort
        const dir = s.sortDir === 'asc' ? 1 : -1;
        filtered.sort((a, b) => {
            let av, bv;
            if (s.sortBy === 'date') {
                av = _txDateStr(a); bv = _txDateStr(b);
            } else if (s.sortBy === 'amount') {
                av = _txAmount(a); bv = _txAmount(b);
            } else if (s.sortBy === 'vendor') {
                av = (getField(a, F.txVendor) || getField(a, F.txDescription) || '').toString().toLowerCase();
                bv = (getField(b, F.txVendor) || getField(b, F.txDescription) || '').toString().toLowerCase();
            }
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
            return 0;
        });

        s.filtered = filtered;
    }

    // ── Render initial shell ──
    // Snapshot of last-rendered data sizes — used to skip redundant re-renders
    // and to detect when the dashboard's globals have caught up after an initial
    // paint that ran before loadDashboard() finished.
    let _txLastSig = '';
    function _txDataSig() {
        return [
            (typeof allTransactions !== 'undefined' && allTransactions ? allTransactions.length : 0),
            (typeof allCategories !== 'undefined' && allCategories ? allCategories.length : 0),
            (typeof allSubCategories !== 'undefined' && allSubCategories ? allSubCategories.length : 0),
            (typeof allBusinesses !== 'undefined' && allBusinesses ? allBusinesses.length : 0),
            (typeof allCosts !== 'undefined' && allCosts ? allCosts.length : 0),
            (typeof allRentalUnits !== 'undefined' && allRentalUnits ? allRentalUnits.length : 0),
            (typeof allTenancies !== 'undefined' && allTenancies ? allTenancies.length : 0),
            (typeof allTenants !== 'undefined' && allTenants ? allTenants.length : 0),
        ].join('|');
    }

    let _txWatchTimer = null;
    function _txWatchForData() {
        // Race-fix: when the user lands on #transactions on first paint, switchTab
        // can fire BEFORE loadDashboard's async await for the IndexedDB cache
        // resolves — so allTransactions is still []. Poll briefly until the
        // globals are populated, then re-render. Stops once data appears or after
        // ~30s. Cleans up on subsequent successful renders.
        if (_txWatchTimer) return;
        let ticks = 0;
        _txWatchTimer = setInterval(() => {
            ticks++;
            const sig = _txDataSig();
            if (sig !== _txLastSig && (typeof allTransactions !== 'undefined' && allTransactions && allTransactions.length > 0)) {
                clearInterval(_txWatchTimer);
                _txWatchTimer = null;
                renderTransactionsTab();
                return;
            }
            if (ticks > 60) {  // 60 * 500ms = 30s cap
                clearInterval(_txWatchTimer);
                _txWatchTimer = null;
            }
        }, 500);
    }

    function renderTransactionsTab() {
        const root = document.getElementById('tab-transactions');
        if (!root) return;
        if (!_txState.rendered) {
            root.innerHTML = _txShellHtml();
            _txState.rendered = true;
            // Wire scroll
            const vp = document.getElementById('txViewport');
            if (vp) vp.addEventListener('scroll', () => {
                _txState.scrollTop = vp.scrollTop;
                _txRenderRows();
            });
        }
        _txBuildLookups();
        _txPopulateFilterOptions();
        // Reset cached search blobs so newly-resolved linked-record names get
        // included on the next search (blobs are computed lazily and cached
        // on each record; if lookups were empty during the first render, the
        // blob would have missed those names).
        if (typeof allTransactions !== 'undefined' && allTransactions) {
            for (const r of allTransactions) { if (r && r._txBlob) r._txBlob = null; }
        }
        _txApplyFilters();
        _txRenderRows();
        _txRenderInsights();
        _txRegisterSyncBar();
        _txLastSig = _txDataSig();
        // If data wasn't ready yet, watch for it and re-render once it arrives.
        const total = (typeof allTransactions !== 'undefined' && allTransactions ? allTransactions.length : 0);
        if (total === 0) _txWatchForData();
    }

    // ── Sync Bar + Health Checks ──
    // Mirrors the pattern used by every other page so the health-check ribbon
    // appears in the same place and surfaces stale data the same way.
    function _txRegisterSyncBar() {
        if (typeof registerSyncBar !== 'function') return;
        registerSyncBar('transactions', {
            refreshFn: async () => {
                if (typeof loadDashboard === 'function') await loadDashboard();
                renderTransactionsTab();
            },
            checks: [
                {
                    name: 'Transactions loaded from cache', kind: 'sync', run: () => {
                        const n = (typeof allTransactions !== 'undefined' && allTransactions ? allTransactions : []).length;
                        if (n === 0) return { status: 'fail', detail: 'No transactions in memory — dashboard cache may have failed to load' };
                        return { status: 'pass', detail: `${n.toLocaleString()} transaction records loaded from dashboard cache (zero extra API calls)` };
                    }
                },
                {
                    name: 'Reconciliation coverage', kind: 'sync', run: () => {
                        const all = (typeof allTransactions !== 'undefined' && allTransactions ? allTransactions : []);
                        if (!all.length) return { status: 'warn', detail: 'No transactions to evaluate' };
                        const recon = all.filter(t => getField(t, F.txReconciled)).length;
                        const unrec = all.length - recon;
                        const pctNum = Math.round((recon / all.length) * 100);
                        return { status: 'pass', detail: `${recon.toLocaleString()} reconciled · ${unrec.toLocaleString()} unreconciled (${pctNum}% covered)` };
                    }
                },
                {
                    name: 'Linked-record name lookups resolve', kind: 'sync', run: () => {
                        const s = _txState;
                        const counts = {
                            categories: Object.keys(s.catById || {}).length,
                            subCategories: Object.keys(s.subCatById || {}).length,
                            businesses: Object.keys(s.bizById || {}).length,
                            costs: Object.keys(s.costById || {}).length,
                            units: Object.keys(s.unitById || {}).length,
                            tenancies: Object.keys(s.tenancyById || {}).length,
                            tenants: Object.keys(s.tenantById || {}).length,
                        };
                        const empty = Object.entries(counts).filter(([_, v]) => v === 0).map(([k]) => k);
                        if (empty.length) return { status: 'warn', detail: `Empty lookup tables: ${empty.join(', ')}` };
                        return { status: 'pass', detail: `Cat ${counts.categories} · SubCat ${counts.subCategories} · Biz ${counts.businesses} · Cost ${counts.costs} · Unit ${counts.units} · Tenancy ${counts.tenancies} · Tenant ${counts.tenants}` };
                    }
                },
                {
                    name: 'Tenant resolution via Tenancy → Customers link', kind: 'sync', run: () => {
                        const all = (typeof allTransactions !== 'undefined' && allTransactions ? allTransactions : []);
                        const linkedToTenancy = all.filter(t => _txLinkedId(t, F.txTenancy));
                        if (!linkedToTenancy.length) return { status: 'pass', detail: 'No tenancy-linked transactions to check' };
                        const resolved = linkedToTenancy.filter(t => _txTenantNameFor(t)).length;
                        if (resolved === 0) return { status: 'fail', detail: `${linkedToTenancy.length} transactions linked to a tenancy but tenant name resolves on 0 — Customers link or allTenants may be empty` };
                        if (resolved < linkedToTenancy.length) return { status: 'warn', detail: `${resolved}/${linkedToTenancy.length} tenancy-linked tx resolve to a tenant name` };
                        return { status: 'pass', detail: `All ${linkedToTenancy.length} tenancy-linked tx resolve to a tenant name` };
                    }
                },
                {
                    name: 'Property resolution', kind: 'sync', run: () => {
                        const all = (typeof allTransactions !== 'undefined' && allTransactions ? allTransactions : []);
                        const haveTenancyOrUnit = all.filter(t => _txLinkedId(t, F.txTenancy) || _txLinkedId(t, F.txUnit));
                        if (!haveTenancyOrUnit.length) return { status: 'pass', detail: 'No transactions linked to a tenancy or unit' };
                        const resolved = haveTenancyOrUnit.filter(t => _txPropertyNameFor(t)).length;
                        if (resolved < haveTenancyOrUnit.length * 0.9) return { status: 'warn', detail: `${resolved}/${haveTenancyOrUnit.length} resolve to a property name` };
                        return { status: 'pass', detail: `${resolved}/${haveTenancyOrUnit.length} resolve to a property name` };
                    }
                },
                {
                    name: 'Filter + virtual table render', kind: 'automation', run: () => {
                        const total = (typeof allTransactions !== 'undefined' && allTransactions ? allTransactions : []).length;
                        const visible = (_txState.filtered || []).length;
                        if (!document.getElementById('txViewport')) return { status: 'fail', detail: 'Virtual viewport not mounted' };
                        return { status: 'pass', detail: `${visible.toLocaleString()} of ${total.toLocaleString()} match current filters` };
                    }
                },
            ],
        });
        if (typeof markTabSynced === 'function') markTabSynced('transactions');
    }

    function _txShellHtml() {
        return `
        <div data-sync-bar="transactions"></div>
        <div class="section">
            <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
                <h2 class="section-title" style="margin-bottom:0">Transactions</h2>
                <span style="font-size:12px;color:var(--text-muted)" id="txCountLabel">—</span>
            </div>
            <p style="color:var(--text-secondary);font-size:13px;margin-top:0;margin-bottom:16px">Search and filter the full transaction history. Data is read from the dashboard cache — no extra API calls.</p>

            <!-- Search & filter bar -->
            <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-md);padding:12px;margin-bottom:16px">
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;align-items:end">
                    <label style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px;grid-column:span 2">
                        <span>Search (vendor, description, ref, anything)</span>
                        <input type="text" id="txSearch" placeholder="e.g. screwfix, council tax, 150" oninput="_txOnSearchInput()" style="font-size:13px;padding:6px 8px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text-primary)">
                    </label>
                    <label style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px">
                        <span>Reconciled</span>
                        <select id="txReconFilter" onchange="_txOnFilterChange('f_recon', this.value)" style="font-size:12px;padding:5px 6px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text-primary)">
                            <option value="">Any</option>
                            <option value="yes">Reconciled only</option>
                            <option value="no">Unreconciled only</option>
                        </select>
                    </label>
                    <label style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px">
                        <span>Business</span>
                        <select id="txBusinessFilter" onchange="_txOnFilterChange('f_business', this.value)" style="font-size:12px;padding:5px 6px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text-primary)"></select>
                    </label>
                    <label style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px">
                        <span>Category</span>
                        <select id="txCategoryFilter" onchange="_txOnFilterChange('f_category', this.value)" style="font-size:12px;padding:5px 6px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text-primary)"></select>
                    </label>
                    <label style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px">
                        <span>Sub-Category</span>
                        <select id="txSubCatFilter" onchange="_txOnFilterChange('f_subcat', this.value)" style="font-size:12px;padding:5px 6px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text-primary)"></select>
                    </label>
                    <label style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px">
                        <span>Account</span>
                        <select id="txAccountFilter" onchange="_txOnFilterChange('f_account', this.value)" style="font-size:12px;padding:5px 6px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text-primary)"></select>
                    </label>
                    <label style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px">
                        <span>Date from</span>
                        <input type="date" id="txDateFrom" onchange="_txOnFilterChange('f_dateFrom', this.value)" style="font-size:12px;padding:5px 6px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text-primary)">
                    </label>
                    <label style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px">
                        <span>Date to</span>
                        <input type="date" id="txDateTo" onchange="_txOnFilterChange('f_dateTo', this.value)" style="font-size:12px;padding:5px 6px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text-primary)">
                    </label>
                    <label style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px">
                        <span>Amount £ min</span>
                        <input type="number" id="txAmtMin" step="0.01" placeholder="0" onchange="_txOnFilterChange('f_amountMin', this.value)" style="font-size:12px;padding:5px 6px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text-primary)">
                    </label>
                    <label style="font-size:11px;color:var(--text-secondary);display:flex;flex-direction:column;gap:4px">
                        <span>Amount £ max</span>
                        <input type="number" id="txAmtMax" step="0.01" placeholder="∞" onchange="_txOnFilterChange('f_amountMax', this.value)" style="font-size:12px;padding:5px 6px;border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-surface);color:var(--text-primary)">
                    </label>
                </div>
                <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                    <button onclick="_txClearFilters()" style="font-size:12px;padding:5px 12px;border:1px solid var(--border-default);background:var(--bg-surface);color:var(--text-primary);border-radius:var(--radius-sm);cursor:pointer">Clear filters</button>
                    <button onclick="_txExportCsv()" style="font-size:12px;padding:5px 12px;border:1px solid var(--border-default);background:var(--bg-surface);color:var(--text-primary);border-radius:var(--radius-sm);cursor:pointer">Export CSV</button>
                    <button onclick="_txRunAiAnalysis()" style="font-size:12px;padding:5px 12px;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:var(--radius-sm);cursor:pointer">AI analysis of filtered set</button>
                </div>
            </div>

            <!-- Insights panel (collapsible) -->
            <details style="margin-bottom:16px;border:1px solid var(--border-default);border-radius:var(--radius-md);background:var(--bg-surface)" id="txInsightsDetails">
                <summary style="padding:10px 14px;cursor:pointer;font-size:13px;font-weight:var(--fw-semibold);color:var(--text-primary)">Insights — spending breakdown for filtered set</summary>
                <div id="txInsightsBody" style="padding:0 14px 14px"></div>
            </details>

            <!-- Virtual table — horizontal scroll wraps an inner min-width grid so all
                 reconciliation linked fields fit. Vertical scroll is on the viewport. -->
            <div style="border:1px solid var(--border-default);border-radius:var(--radius-md);background:var(--bg-surface);overflow:hidden">
              <div style="overflow-x:auto">
                <div style="min-width:1200px">
                <div style="display:grid;grid-template-columns:${_TX_GRID};gap:0;background:var(--bg-subtle);border-bottom:1px solid var(--border-default);font-size:11px;font-weight:var(--fw-semibold);color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em">
                    <div onclick="_txSetSort('date')" style="padding:8px 12px;cursor:pointer" title="Sort by date">Date <span id="txSortInd-date"></span></div>
                    <div onclick="_txSetSort('vendor')" style="padding:8px 12px;cursor:pointer" title="Sort by vendor">Vendor / Description <span id="txSortInd-vendor"></span></div>
                    <div onclick="_txSetSort('amount')" style="padding:8px 12px;cursor:pointer;text-align:right" title="Sort by amount">Amount <span id="txSortInd-amount"></span></div>
                    <div style="padding:8px 12px">Category</div>
                    <div style="padding:8px 12px">Sub-Category</div>
                    <div style="padding:8px 12px">Business</div>
                    <div style="padding:8px 12px">Tenant</div>
                    <div style="padding:8px 12px">Tenancy</div>
                    <div style="padding:8px 12px">Unit</div>
                    <div style="padding:8px 12px">Property</div>
                    <div style="padding:8px 12px">Cost</div>
                    <div style="padding:8px 12px">Account</div>
                    <div style="padding:8px 12px;text-align:center">Recon</div>
                </div>
                <div id="txViewport" style="height:600px;overflow-y:auto;position:relative">
                    <div id="txSpacer" style="position:relative;width:100%"></div>
                    <div id="txRows" style="position:absolute;top:0;left:0;right:0"></div>
                </div>
                </div>
              </div>
            </div>
        </div>
        `;
    }

    function _txPopulateFilterOptions() {
        const s = _txState;
        // Build option lists once
        function fillSelect(id, items, current) {
            const el = document.getElementById(id);
            if (!el) return;
            const opts = ['<option value="">All</option>']
                .concat(items.map(it => `<option value="${escHtml(it.id)}">${escHtml(it.name || '(unnamed)')}</option>`));
            el.innerHTML = opts.join('');
            el.value = current || '';
        }
        const businesses = Object.entries(s.bizById).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
        const categories = Object.entries(s.catById).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
        const subCats = Object.entries(s.subCatById).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
        fillSelect('txBusinessFilter', businesses, s.f_business);
        fillSelect('txCategoryFilter', categories, s.f_category);
        fillSelect('txSubCatFilter', subCats, s.f_subcat);
        // Accounts come from transactions themselves (string field)
        const accSet = new Set();
        (allTransactions || []).forEach(r => { const a = _txAccountName(r); if (a) accSet.add(a); });
        const accList = [...accSet].sort();
        const accEl = document.getElementById('txAccountFilter');
        if (accEl) {
            accEl.innerHTML = ['<option value="">All</option>']
                .concat(accList.map(a => `<option value="${escHtml(a)}">${escHtml(a)}</option>`))
                .join('');
            accEl.value = s.f_account || '';
        }
        // Reconciled select
        const rEl = document.getElementById('txReconFilter');
        if (rEl) rEl.value = s.f_recon || '';
        // Sort indicators
        ['date', 'vendor', 'amount'].forEach(k => {
            const el = document.getElementById('txSortInd-' + k);
            if (el) el.textContent = (s.sortBy === k) ? (s.sortDir === 'asc' ? '▲' : '▼') : '';
        });
    }

    // ── Virtual rendering ──
    function _txRenderRows() {
        const s = _txState;
        const rows = s.filtered;
        const viewport = document.getElementById('txViewport');
        const spacer = document.getElementById('txSpacer');
        const rowsHost = document.getElementById('txRows');
        const countLabel = document.getElementById('txCountLabel');
        if (!viewport || !spacer || !rowsHost) return;

        if (countLabel) {
            const total = (allTransactions || []).length;
            countLabel.textContent = rows.length === total
                ? `${total.toLocaleString()} transactions`
                : `${rows.length.toLocaleString()} of ${total.toLocaleString()} transactions`;
        }

        spacer.style.height = (rows.length * s.rowH) + 'px';
        const viewportH = viewport.clientHeight || s.viewportH;
        const startIdx = Math.max(0, Math.floor(s.scrollTop / s.rowH) - 5);
        const visibleCount = Math.ceil(viewportH / s.rowH) + 10;
        const endIdx = Math.min(rows.length, startIdx + visibleCount);

        let html = '';
        for (let i = startIdx; i < endIdx; i++) {
            html += _txRowHtml(rows[i], i);
        }
        rowsHost.style.transform = `translateY(${startIdx * s.rowH}px)`;
        rowsHost.innerHTML = html;
    }

    function _txRowHtml(rec, idx) {
        const s = _txState;
        const date = _txDateStr(rec);
        const dateShort = date ? new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '';
        const vendor = getField(rec, F.txVendor) || '';
        const desc = getField(rec, F.txDescription) || '';
        const label = vendor || desc || '(no label)';
        const sub = vendor && desc ? desc : '';
        const subCatName = s.subCatById[_txLinkedId(rec, F.txSubCategory)] || '';
        const catName = s.catById[_txLinkedId(rec, F.txCategory)] || '';
        const amount = _txAmount(rec);
        const amtClass = amount >= 0 ? 'text-green' : 'text-red';
        const account = _txAccountName(rec);
        const bizName = s.bizById[_txLinkedId(rec, F.txBusiness)] || '';
        const tenantName = _txTenantNameFor(rec);
        const tenancyRef = s.tenancyById[_txLinkedId(rec, F.txTenancy)] || '';
        const unitName = s.unitById[_txLinkedId(rec, F.txUnit)] || '';
        const propertyName = _txPropertyNameFor(rec);
        const costName = s.costById[_txLinkedId(rec, F.txCost)] || '';
        const reconciled = !!getField(rec, F.txReconciled);
        const reconDot = reconciled
            ? `<span title="Reconciled" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--success)"></span>`
            : `<span title="Unreconciled" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--warning)"></span>`;
        const zebra = (idx % 2) ? 'var(--bg-surface-2)' : 'var(--bg-surface)';
        const dimCell = 'padding:0 12px;font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        const muted = '<span style="color:var(--text-muted)">—</span>';
        return `
            <div onclick="_txOpenRow('${rec.id}')" style="display:grid;grid-template-columns:${_TX_GRID};gap:0;height:${s.rowH}px;border-bottom:1px solid var(--border-subtle);background:${zebra};cursor:pointer;align-items:center;font-size:13px;color:var(--text-primary)">
                <div style="padding:0 12px;color:var(--text-secondary);font-size:12px">${escHtml(dateShort)}</div>
                <div style="padding:0 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    <div style="font-weight:var(--fw-medium);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(label)}</div>
                    ${sub ? `<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(sub)}</div>` : ''}
                </div>
                <div class="${amtClass}" style="padding:0 12px;text-align:right;font-variant-numeric:tabular-nums;font-weight:var(--fw-medium)">${amount < 0 ? '-' : ''}${fmt(amount)}</div>
                <div style="${dimCell}">${catName ? escHtml(catName) : muted}</div>
                <div style="${dimCell}">${subCatName ? escHtml(subCatName) : muted}</div>
                <div style="${dimCell}">${bizName ? escHtml(bizName) : muted}</div>
                <div style="${dimCell}">${tenantName ? escHtml(tenantName) : muted}</div>
                <div style="${dimCell}">${tenancyRef ? escHtml(tenancyRef) : muted}</div>
                <div style="${dimCell}">${unitName ? escHtml(unitName) : muted}</div>
                <div style="${dimCell}">${propertyName ? escHtml(propertyName) : muted}</div>
                <div style="${dimCell}">${costName ? escHtml(costName) : muted}</div>
                <div style="${dimCell}">${account ? escHtml(account) : muted}</div>
                <div style="padding:0 12px;text-align:center">${reconDot}</div>
            </div>
        `;
    }

    function _txOpenRow(id) {
        const rec = (allTransactions || []).find(r => r.id === id);
        if (!rec) return;
        const s = _txState;
        const date = _txDateStr(rec);
        const vendor = getField(rec, F.txVendor) || '';
        const desc = getField(rec, F.txDescription) || '';
        const subCat = s.subCatById[_txLinkedId(rec, F.txSubCategory)] || '';
        const cat = s.catById[_txLinkedId(rec, F.txCategory)] || '';
        const biz = s.bizById[_txLinkedId(rec, F.txBusiness)] || '';
        const cost = s.costById[_txLinkedId(rec, F.txCost)] || '';
        const unit = s.unitById[_txLinkedId(rec, F.txUnit)] || '';
        const tenancy = s.tenancyById[_txLinkedId(rec, F.txTenancy)] || '';
        const tenant = _txTenantNameFor(rec);
        const property = _txPropertyNameFor(rec);
        const amount = _txAmount(rec);
        const account = _txAccountName(rec);
        const reconciled = !!getField(rec, F.txReconciled);
        const teamMember = txTeamMemberName(rec) || '';

        const airtableUrl = `https://airtable.com/${BASE_ID}/${TABLES.transactions}/${rec.id}`;

        const fields = [
            ['Date', escHtml(date)],
            ['Amount', `<span class="${amount >= 0 ? 'text-green' : 'text-red'}">${amount < 0 ? '-' : ''}${fmt(amount)}</span>`],
            ['Vendor', escHtml(vendor)],
            ['Description', escHtml(desc)],
            ['Account', escHtml(account)],
            ['Reconciled', reconciled ? '<span class="text-green">Yes</span>' : '<span class="text-amber">No</span>'],
            ['Category', escHtml(cat)],
            ['Sub-Category', escHtml(subCat)],
            ['Business', escHtml(biz)],
            ['Tenant', escHtml(tenant)],
            ['Tenancy', escHtml(tenancy)],
            ['Unit', escHtml(unit)],
            ['Property', escHtml(property)],
            ['Cost', escHtml(cost)],
            ['Team Member', escHtml(teamMember)],
        ].filter(([_, v]) => v && v !== '');

        const rowsHtml = fields.map(([k, v]) => `
            <div style="display:grid;grid-template-columns:140px 1fr;gap:12px;padding:6px 0;border-bottom:1px solid var(--border-subtle)">
                <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em">${k}</div>
                <div style="font-size:13px;color:var(--text-primary)">${v}</div>
            </div>
        `).join('');

        // Modal overlay
        let modal = document.getElementById('txDetailModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'txDetailModal';
            modal.style.cssText = 'position:fixed;inset:0;background:rgba(28,36,34,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
            document.body.appendChild(modal);
        }
        modal.innerHTML = `
            <div style="background:var(--bg-surface);border-radius:var(--radius-lg);max-width:640px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:var(--shadow-lg)">
                <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--border-default)">
                    <h3 style="margin:0;font-size:15px;font-weight:var(--fw-semibold);color:var(--text-primary)">Transaction Detail</h3>
                    <button onclick="document.getElementById('txDetailModal').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-muted);padding:0 4px">✕</button>
                </div>
                <div style="padding:14px 18px">
                    ${rowsHtml}
                </div>
                <div style="padding:12px 18px;border-top:1px solid var(--border-default);display:flex;gap:8px;justify-content:flex-end">
                    <a href="${airtableUrl}" target="_blank" rel="noopener" style="font-size:12px;padding:6px 12px;border:1px solid var(--border-default);background:var(--bg-surface);color:var(--text-primary);border-radius:var(--radius-sm);text-decoration:none">Open in Airtable ↗</a>
                    <button onclick="document.getElementById('txDetailModal').remove()" style="font-size:12px;padding:6px 12px;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:var(--radius-sm);cursor:pointer">Close</button>
                </div>
            </div>
        `;
    }

    // ── Filter / sort handlers ──
    let _txSearchDebounce = null;
    function _txOnSearchInput() {
        clearTimeout(_txSearchDebounce);
        _txSearchDebounce = setTimeout(() => {
            _txState.search = document.getElementById('txSearch').value || '';
            _txState.scrollTop = 0;
            const vp = document.getElementById('txViewport');
            if (vp) vp.scrollTop = 0;
            _txApplyFilters();
            _txRenderRows();
            _txRenderInsights();
        }, 150);
    }
    function _txOnFilterChange(key, value) {
        _txState[key] = value || '';
        _txState.scrollTop = 0;
        const vp = document.getElementById('txViewport');
        if (vp) vp.scrollTop = 0;
        _txApplyFilters();
        _txRenderRows();
        _txRenderInsights();
    }
    function _txClearFilters() {
        Object.assign(_txState, {
            search: '', f_business: '', f_category: '', f_subcat: '', f_account: '',
            f_recon: '', f_dateFrom: '', f_dateTo: '', f_amountMin: '', f_amountMax: '',
            scrollTop: 0,
        });
        // Reset DOM inputs
        ['txSearch','txDateFrom','txDateTo','txAmtMin','txAmtMax'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        ['txReconFilter','txBusinessFilter','txCategoryFilter','txSubCatFilter','txAccountFilter'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        const vp = document.getElementById('txViewport');
        if (vp) vp.scrollTop = 0;
        _txApplyFilters();
        _txRenderRows();
        _txRenderInsights();
    }
    function _txSetSort(key) {
        if (_txState.sortBy === key) {
            _txState.sortDir = _txState.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            _txState.sortBy = key;
            _txState.sortDir = key === 'date' ? 'desc' : (key === 'amount' ? 'desc' : 'asc');
        }
        ['date','vendor','amount'].forEach(k => {
            const el = document.getElementById('txSortInd-' + k);
            if (el) el.textContent = (_txState.sortBy === k) ? (_txState.sortDir === 'asc' ? '▲' : '▼') : '';
        });
        _txApplyFilters();
        _txRenderRows();
    }

    // ── Insights panel ──
    function _txRenderInsights() {
        const body = document.getElementById('txInsightsBody');
        if (!body) return;
        const s = _txState;
        const rows = s.filtered;
        if (!rows.length) {
            body.innerHTML = '<p style="color:var(--text-muted);font-size:13px;margin:8px 0">No transactions match the current filters.</p>';
            return;
        }
        // Aggregates
        let totalIn = 0, totalOut = 0, reconCount = 0;
        const byBiz = {};
        const bySubCat = {};
        const byVendor = {};
        const byMonth = {};
        for (const r of rows) {
            const a = _txAmount(r);
            if (a >= 0) totalIn += a; else totalOut += a;
            if (getField(r, F.txReconciled)) reconCount++;
            const biz = s.bizById[_txLinkedId(r, F.txBusiness)] || '(no business)';
            byBiz[biz] = (byBiz[biz] || 0) + a;
            const sc = s.subCatById[_txLinkedId(r, F.txSubCategory)] || '(uncategorised)';
            bySubCat[sc] = (bySubCat[sc] || 0) + a;
            const v = (getField(r, F.txVendor) || getField(r, F.txDescription) || '(unknown)').toString().slice(0, 40);
            // Vendors count outflows only for "top spend" insight
            if (a < 0) byVendor[v] = (byVendor[v] || 0) + a;
            const d = _txDateStr(r);
            if (d.length >= 7) {
                const mk = d.slice(0, 7);
                byMonth[mk] = (byMonth[mk] || 0) + a;
            }
        }
        const reconPct = rows.length ? Math.round((reconCount / rows.length) * 100) : 0;

        function topList(obj, n = 5, signFilter = null) {
            return Object.entries(obj)
                .filter(([_, v]) => signFilter === 'neg' ? v < 0 : signFilter === 'pos' ? v > 0 : true)
                .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
                .slice(0, n);
        }
        function listHtml(items, fmtAmount = true) {
            if (!items.length) return '<div style="color:var(--text-muted);font-size:12px">No data</div>';
            const max = Math.max(...items.map(([_, v]) => Math.abs(v)));
            return items.map(([k, v]) => {
                const w = max ? Math.round((Math.abs(v) / max) * 100) : 0;
                const cls = v >= 0 ? 'text-green' : 'text-red';
                return `
                    <div style="display:grid;grid-template-columns:1fr 100px;gap:8px;align-items:center;padding:3px 0;font-size:12px">
                        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(k)}">
                            <div style="display:inline-block;height:6px;width:${w}%;background:var(--accent-soft);border-radius:3px;vertical-align:middle;margin-right:6px;max-width:60%"></div>
                            ${escHtml(k)}
                        </div>
                        <div class="${cls}" style="text-align:right;font-variant-numeric:tabular-nums">${fmtAmount ? (v < 0 ? '-' : '') + fmt(v) : v}</div>
                    </div>
                `;
            }).join('');
        }

        const monthEntries = Object.entries(byMonth).sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-12);
        const monthHtml = monthEntries.map(([m, v]) => {
            const cls = v >= 0 ? 'text-green' : 'text-red';
            const label = (() => {
                const [y, mo] = m.split('-').map(Number);
                return new Date(y, mo - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
            })();
            return `
                <div style="display:grid;grid-template-columns:1fr 110px;gap:8px;align-items:center;padding:3px 0;font-size:12px">
                    <div>${label}</div>
                    <div class="${cls}" style="text-align:right;font-variant-numeric:tabular-nums">${v < 0 ? '-' : '+'}${fmt(v)}</div>
                </div>
            `;
        }).join('');

        body.innerHTML = `
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:12px 0">
                <div style="padding:10px;background:var(--bg-subtle);border-radius:var(--radius-sm)">
                    <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em">Inflows</div>
                    <div class="text-green" style="font-size:18px;font-weight:var(--fw-semibold);font-variant-numeric:tabular-nums">+${fmt(totalIn)}</div>
                </div>
                <div style="padding:10px;background:var(--bg-subtle);border-radius:var(--radius-sm)">
                    <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em">Outflows</div>
                    <div class="text-red" style="font-size:18px;font-weight:var(--fw-semibold);font-variant-numeric:tabular-nums">-${fmt(Math.abs(totalOut))}</div>
                </div>
                <div style="padding:10px;background:var(--bg-subtle);border-radius:var(--radius-sm)">
                    <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em">Net</div>
                    <div class="${(totalIn + totalOut) >= 0 ? 'text-green' : 'text-red'}" style="font-size:18px;font-weight:var(--fw-semibold);font-variant-numeric:tabular-nums">${(totalIn + totalOut) >= 0 ? '+' : '-'}${fmt(totalIn + totalOut)}</div>
                </div>
                <div style="padding:10px;background:var(--bg-subtle);border-radius:var(--radius-sm)">
                    <div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em">Reconciled</div>
                    <div style="font-size:18px;font-weight:var(--fw-semibold)">${reconPct}%</div>
                    <div style="font-size:11px;color:var(--text-muted)">${reconCount.toLocaleString()} of ${rows.length.toLocaleString()}</div>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">
                <div>
                    <div style="font-size:12px;font-weight:var(--fw-semibold);margin-bottom:6px;color:var(--text-secondary)">Top spend by sub-category</div>
                    ${listHtml(topList(bySubCat, 6, 'neg'))}
                </div>
                <div>
                    <div style="font-size:12px;font-weight:var(--fw-semibold);margin-bottom:6px;color:var(--text-secondary)">Top vendors by spend</div>
                    ${listHtml(topList(byVendor, 6, 'neg'))}
                </div>
                <div>
                    <div style="font-size:12px;font-weight:var(--fw-semibold);margin-bottom:6px;color:var(--text-secondary)">Net by business</div>
                    ${listHtml(topList(byBiz, 8))}
                </div>
                <div>
                    <div style="font-size:12px;font-weight:var(--fw-semibold);margin-bottom:6px;color:var(--text-secondary)">Net by month (last 12)</div>
                    ${monthHtml || '<div style="color:var(--text-muted);font-size:12px">No data</div>'}
                </div>
            </div>
        `;
    }

    // ── CSV export ──
    function _txExportCsv() {
        const s = _txState;
        const rows = s.filtered;
        const headers = ['Date','Vendor','Description','Amount','Account','Category','Sub-Category','Business','Tenant','Tenancy','Unit','Property','Cost','Reconciled'];
        const csvRows = [headers.join(',')];
        const esc = v => {
            if (v == null) return '';
            const str = String(v);
            return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
        };
        for (const r of rows) {
            csvRows.push([
                _txDateStr(r),
                getField(r, F.txVendor) || '',
                getField(r, F.txDescription) || '',
                _txAmount(r).toFixed(2),
                _txAccountName(r),
                s.catById[_txLinkedId(r, F.txCategory)] || '',
                s.subCatById[_txLinkedId(r, F.txSubCategory)] || '',
                s.bizById[_txLinkedId(r, F.txBusiness)] || '',
                _txTenantNameFor(r),
                s.tenancyById[_txLinkedId(r, F.txTenancy)] || '',
                s.unitById[_txLinkedId(r, F.txUnit)] || '',
                _txPropertyNameFor(r),
                s.costById[_txLinkedId(r, F.txCost)] || '',
                getField(r, F.txReconciled) ? 'Yes' : 'No',
            ].map(esc).join(','));
        }
        const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `transactions-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ── AI analysis: feed filtered set to existing AI assistant ──
    function _txRunAiAnalysis() {
        const s = _txState;
        const rows = s.filtered;
        if (!rows.length) { alert('No transactions in current filter.'); return; }

        // Build a compact summary the assistant can reason about
        let totalIn = 0, totalOut = 0;
        const bySubCat = {}, byVendor = {}, byMonth = {};
        for (const r of rows) {
            const a = _txAmount(r);
            if (a >= 0) totalIn += a; else totalOut += a;
            const sc = s.subCatById[_txLinkedId(r, F.txSubCategory)] || '(uncategorised)';
            bySubCat[sc] = (bySubCat[sc] || 0) + a;
            if (a < 0) {
                const v = (getField(r, F.txVendor) || getField(r, F.txDescription) || '(unknown)').toString().slice(0, 40);
                byVendor[v] = (byVendor[v] || 0) + a;
            }
            const d = _txDateStr(r);
            if (d.length >= 7) byMonth[d.slice(0, 7)] = (byMonth[d.slice(0, 7)] || 0) + a;
        }
        const top = (obj, n) => Object.entries(obj).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, n);

        const filterDesc = [];
        if (s.search) filterDesc.push(`search="${s.search}"`);
        if (s.f_business) filterDesc.push(`business=${s.bizById[s.f_business] || s.f_business}`);
        if (s.f_category) filterDesc.push(`category=${s.catById[s.f_category] || s.f_category}`);
        if (s.f_subcat) filterDesc.push(`sub-category=${s.subCatById[s.f_subcat] || s.f_subcat}`);
        if (s.f_account) filterDesc.push(`account=${s.f_account}`);
        if (s.f_recon) filterDesc.push(`reconciled=${s.f_recon}`);
        if (s.f_dateFrom || s.f_dateTo) filterDesc.push(`dates=${s.f_dateFrom || '…'}..${s.f_dateTo || '…'}`);
        if (s.f_amountMin || s.f_amountMax) filterDesc.push(`amount=£${s.f_amountMin || '0'}..£${s.f_amountMax || '∞'}`);

        const promptLines = [
            `I'm looking at ${rows.length} transactions from the Transactions page.`,
            filterDesc.length ? `Active filters: ${filterDesc.join(', ')}.` : 'No filters applied (whole history).',
            ``,
            `Totals: inflows +£${totalIn.toFixed(2)}, outflows -£${Math.abs(totalOut).toFixed(2)}, net ${(totalIn + totalOut).toFixed(2)}.`,
            ``,
            `Top spend sub-categories:`,
            ...top(bySubCat, 8).map(([k, v]) => `  • ${k}: £${v.toFixed(2)}`),
            ``,
            `Top vendors by spend:`,
            ...top(byVendor, 8).map(([k, v]) => `  • ${k}: £${v.toFixed(2)}`),
            ``,
            `Net by month (recent):`,
            ...Object.entries(byMonth).sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-12).map(([m, v]) => `  • ${m}: £${v.toFixed(2)}`),
            ``,
            `Please analyse this for spending efficiency. Where am I overspending? Are there obvious optimisations or vendor consolidation opportunities? Any unusual patterns or month-on-month shifts I should look at?`
        ];
        const prompt = promptLines.join('\n');

        // Open the AI panel and send the prompt through the existing pipeline
        if (typeof toggleAIPanel === 'function') {
            const panel = document.getElementById('aiPanel');
            if (panel && !panel.classList.contains('open')) toggleAIPanel();
        }
        const input = document.getElementById('aiInput');
        if (input) {
            input.value = prompt;
            if (typeof sendAIMessage === 'function') sendAIMessage();
        } else {
            // Fallback — copy to clipboard if AI panel is unavailable
            navigator.clipboard.writeText(prompt).then(() => alert('AI analysis prompt copied to clipboard — paste it into the AI assistant.'));
        }
    }
