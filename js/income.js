// ══════════════════════════════════════════
// INCOME TAB — Accounts Receivable Fixed
// Read-only view of fixed recurring income (tenancy rent).
// Data comes from global arrays loaded by dashboard.js.
// ══════════════════════════════════════════
    let _incomeBreakdownView = 'property';

    // ── Loading state ──
    function showIncomeLoadingState() {
        const panel = document.getElementById('tab-income');
        if (!panel) return;
        let overlay = document.getElementById('incomeLoadingOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'incomeLoadingOverlay';
            overlay.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 0;gap:16px;color:var(--text-secondary)';
            overlay.innerHTML = `
                <div style="width:40px;height:40px;border:3px solid var(--border-default);border-top-color:var(--accent);border-radius:50%;animation:income-spin 0.8s linear infinite"></div>
                <div style="font-size:14px;font-weight:500">Loading Accounts Receivable Fixed…</div>
                <div id="incomeLoadingMessage" style="font-size:12px;color:var(--text-muted);text-align:center;max-width:480px">Fetching tenancy data from Airtable. This usually takes a few seconds.</div>
                <button id="incomeLoadingRetryBtn" class="od-btn od-btn-primary" onclick="forceIncomeRefresh()" style="margin-top:8px;display:none">Force Refresh from Airtable</button>
                <style>@keyframes income-spin { to { transform: rotate(360deg); } }</style>
            `;
            panel.appendChild(overlay);
        }
        overlay.style.display = 'flex';
        ['incomeSummaryCards', 'incomeTable', 'incomeBreakdown', 'incomeAIAnalysis'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        if (window._incomeLoadingTimer) clearTimeout(window._incomeLoadingTimer);
        window._incomeLoadingTimer = setTimeout(() => {
            const msg = document.getElementById('incomeLoadingMessage');
            const btn = document.getElementById('incomeLoadingRetryBtn');
            if (msg) msg.innerHTML = 'Still loading after 8 seconds. Click below to force a fresh fetch from Airtable. If that doesn\'t work, log out and back in.';
            if (btn) btn.style.display = 'inline-block';
        }, 8000);
    }

    async function forceIncomeRefresh() {
        const btn = document.getElementById('incomeLoadingRetryBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
        try {
            if (typeof clearDashCache === 'function') {
                try { await clearDashCache(); } catch (err) { console.warn('clearDashCache failed:', err); }
            }
            if (typeof loadDashboard === 'function') {
                await loadDashboard();
            }
            renderIncomeTab();
        } catch (err) {
            if (typeof showToast === 'function') showToast('Refresh failed: ' + err.message, { type: 'error' });
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Force Refresh from Airtable'; }
        }
    }

    function hideIncomeLoadingState() {
        if (window._incomeLoadingTimer) { clearTimeout(window._incomeLoadingTimer); window._incomeLoadingTimer = null; }
        const overlay = document.getElementById('incomeLoadingOverlay');
        if (overlay) overlay.style.display = 'none';
        ['incomeSummaryCards', 'incomeBreakdown', 'incomeAIAnalysis'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = '';
        });
        const tbl = document.getElementById('incomeTable');
        if (tbl) tbl.style.display = '';
    }

    // ── Helpers ──
    function getIncomePayStatus(r) {
        const raw = getField(r, F.tenPayStatus);
        if (!raw) return 'Unknown';
        if (raw === PS.tenInPayment || raw.id === PS.tenInPayment) return 'In Payment';
        if (raw === PS.tenCFV || raw.id === PS.tenCFV) return 'CFV';
        if (raw === PS.tenCFVActioned || raw.id === PS.tenCFVActioned) return 'CFV Actioned';
        if (typeof raw === 'object' && raw.name) return raw.name;
        return String(raw);
    }

    function getIncomeTenantName(tenancy) {
        const surname = getField(tenancy, F.tenSurname) || '';
        if (surname) return surname;
        const linked = getField(tenancy, F.tenLinkedTenant);
        if (Array.isArray(linked) && linked.length > 0) {
            const tenantId = linked[0].id || linked[0];
            const tenant = (allTenants || []).find(t => t.id === tenantId);
            if (tenant) return getField(tenant, F.tenantName) || 'Unknown';
        }
        return 'Unknown';
    }

    function getIncomePropertyName(tenancy) {
        const prop = getField(tenancy, F.tenProperty);
        if (Array.isArray(prop) && prop.length > 0) {
            if (typeof prop[0] === 'string') return prop[0];
            if (prop[0].name) return prop[0].name;
        }
        return '';
    }

    function getIncomeUnitName(tenancy) {
        const unit = getField(tenancy, F.tenUnitRef);
        if (Array.isArray(unit) && unit.length > 0) {
            if (typeof unit[0] === 'string') return unit[0];
            if (unit[0].name) return unit[0].name;
        }
        return '';
    }

    function getIncomeTenantPayType(tenancy) {
        const linked = getField(tenancy, F.tenLinkedTenant);
        if (Array.isArray(linked) && linked.length > 0) {
            const tenantId = linked[0].id || linked[0];
            const tenant = (allTenants || []).find(t => t.id === tenantId);
            if (tenant) {
                const pt = getField(tenant, F.tenantPayType);
                if (pt && typeof pt === 'object' && pt.name) return pt.name;
                if (typeof pt === 'string') return pt;
            }
        }
        return 'Unknown';
    }

    function getIncomeFrequency(tenancy) {
        const freq = getField(tenancy, F.tenPayFreq);
        if (freq && typeof freq === 'object' && freq.name) return freq.name;
        if (typeof freq === 'string') return freq;
        return 'Monthly';
    }

    function isActiveTenancy(r) {
        const status = getField(r, F.tenStatus);
        if (Array.isArray(status) && status.length > 0) {
            const val = typeof status[0] === 'object' ? status[0].name : String(status[0]);
            if (val === 'Former' || val === 'Inactive') return false;
        }
        return true;
    }

    // ── Enrichment ──
    function enrichIncome(r) {
        const rent = Number(getField(r, F.tenRent)) || 0;
        const dueDay = Number(getField(r, F.tenDueDay)) || null;
        const payStatus = getIncomePayStatus(r);
        const tenantName = getIncomeTenantName(r);
        const propertyName = getIncomePropertyName(r);
        const unitName = getIncomeUnitName(r);
        const payType = getIncomeTenantPayType(r);
        const frequency = getIncomeFrequency(r);
        const daysOverdue = Number(getField(r, F.tenDaysOverdue)) || 0;
        const daysUntilDue = Number(getField(r, F.tenDaysUntilDue)) || 0;
        const nextDueDate = getField(r, F.tenNextDueDate) || null;
        const paidThisMonth = getField(r, F.tenPaidThisMonth);
        const active = isActiveTenancy(r);

        return {
            id: r.id,
            raw: r,
            rent, dueDay, payStatus, tenantName, propertyName, unitName,
            payType, frequency, daysOverdue, daysUntilDue, nextDueDate,
            paidThisMonth, active,
        };
    }

    // ── Render ──
    function renderIncomeTab() {
        const tenancies = (allTenancies || []);
        const activeTenancies = tenancies.filter(r => isActiveTenancy(r));

        const panel = document.getElementById('tab-income');
        if (!panel) return;

        if (tenancies.length === 0) {
            showIncomeLoadingState();
            if (!window._incomeDataPoll) {
                window._incomeDataPoll = setInterval(() => {
                    if ((allTenancies || []).length > 0) {
                        clearInterval(window._incomeDataPoll);
                        window._incomeDataPoll = null;
                        renderIncomeTab();
                    }
                }, 500);
            }
            return;
        } else {
            if (window._incomeDataPoll) { clearInterval(window._incomeDataPoll); window._incomeDataPoll = null; }
            hideIncomeLoadingState();
        }

        const filterText = (document.getElementById('incomeFilterText')?.value || '').toLowerCase().trim();
        const sortBy = document.getElementById('incomeSortBy')?.value || 'due-day';
        const statusFilter = document.getElementById('incomeStatusFilter')?.value || 'in-payment';
        const businessFilter = document.getElementById('incomeBusinessFilter')?.value || 'all';

        // Populate business filter dropdown
        populateIncomeBusinessFilter();

        const enriched = activeTenancies.map(r => enrichIncome(r));

        // Status filter
        let filtered = enriched;
        if (statusFilter === 'in-payment') {
            filtered = filtered.filter(e => e.payStatus === 'In Payment');
        } else if (statusFilter === 'cfv') {
            filtered = filtered.filter(e => e.payStatus === 'CFV' || e.payStatus === 'CFV Actioned');
        }

        // Business filter — tenancies have no direct business link, so derive
        // tenancy → business from transactions (txTenancy + txBusiness are both
        // written by the reconciliation engine when rent is reconciled).
        if (businessFilter !== 'all') {
            const tenancyBusinesses = {};
            (allTransactions || []).forEach(tx => {
                const tens = getField(tx, F.txTenancy);
                const biz = getField(tx, F.txBusiness);
                if (!Array.isArray(tens) || tens.length === 0 || !Array.isArray(biz) || biz.length === 0) return;
                tens.forEach(t => {
                    const tid = typeof t === 'object' ? t.id : t;
                    if (!tenancyBusinesses[tid]) tenancyBusinesses[tid] = new Set();
                    biz.forEach(b => tenancyBusinesses[tid].add(typeof b === 'object' ? b.id : b));
                });
            });
            filtered = filtered.filter(e => tenancyBusinesses[e.id] && tenancyBusinesses[e.id].has(businessFilter));
        }

        // Text search
        if (filterText) {
            filtered = filtered.filter(e => {
                const haystack = [
                    e.tenantName, e.propertyName, e.unitName,
                    e.rent, e.payStatus, e.payType, e.frequency,
                    e.dueDay ? 'day ' + e.dueDay : '',
                ].map(v => String(v ?? '')).join('  ').toLowerCase();
                return haystack.includes(filterText);
            });
        }

        // Sort
        const sorted = [...filtered].sort((a, b) => {
            if (sortBy === 'due-day') return (a.dueDay || 99) - (b.dueDay || 99);
            if (sortBy === 'rent-desc') return b.rent - a.rent;
            if (sortBy === 'rent-asc') return a.rent - b.rent;
            if (sortBy === 'tenant') return a.tenantName.localeCompare(b.tenantName);
            if (sortBy === 'status') {
                const order = { 'CFV': 0, 'CFV Actioned': 1, 'In Payment': 2 };
                return (order[a.payStatus] ?? 3) - (order[b.payStatus] ?? 3);
            }
            return 0;
        });

        // Summary calculations (always on full active set, not filtered)
        const inPayment = enriched.filter(e => e.payStatus === 'In Payment');
        const cfvItems = enriched.filter(e => e.payStatus === 'CFV' || e.payStatus === 'CFV Actioned');
        const totalMonthlyIncome = inPayment.reduce((s, e) => s + e.rent, 0);
        const totalAllIncome = enriched.reduce((s, e) => s + e.rent, 0);

        // Payment type counts
        const payTypeCounts = {};
        enriched.forEach(e => {
            const pt = e.payType || 'Unknown';
            payTypeCounts[pt] = (payTypeCounts[pt] || 0) + 1;
        });
        const payTypeSummary = Object.entries(payTypeCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${v} ${escHtml(k)}`)
            .join(' · ');

        // Summary cards
        const summaryEl = document.getElementById('incomeSummaryCards');
        if (summaryEl) {
            summaryEl.innerHTML = `
                <div class="kpi-card">
                    <div class="kpi-card-label">Active Income Sources</div>
                    <div class="kpi-card-value">${inPayment.length}</div>
                    <div class="kpi-card-sub">${cfvItems.length} CFV / not in payment</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Monthly Expected Income</div>
                    <div class="kpi-card-value" style="color:var(--success)">${fmt(totalMonthlyIncome)}</div>
                    <div class="kpi-card-sub">From ${inPayment.length} active sources (${fmt(totalAllIncome)} total incl. CFV)</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">CFV / Not In Payment</div>
                    <div class="kpi-card-value" style="color:${cfvItems.length > 0 ? 'var(--danger)' : 'var(--success)'}">${cfvItems.length}</div>
                    <div class="kpi-card-sub">${cfvItems.length > 0 ? fmt(cfvItems.reduce((s, e) => s + e.rent, 0)) + ' at risk' : 'All sources in payment'}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Payment Type Split</div>
                    <div class="kpi-card-value" style="font-size:var(--fs-lg)">${enriched.length}</div>
                    <div class="kpi-card-sub">${payTypeSummary || 'No data'}</div>
                </div>
            `;
        }

        // Data table
        const tableEl = document.getElementById('incomeTable');
        if (tableEl) tableEl.style.display = '';

        const tableBodyEl = document.getElementById('incomeTableBody');
        if (tableBodyEl) {
            if (sorted.length === 0) {
                tableBodyEl.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:32px">No income sources match your filters.</td></tr>`;
            } else {
                tableBodyEl.innerHTML = sorted.map((e, idx) => renderIncomeRow(e, idx)).join('');
            }
        }

        // Breakdown
        renderIncomeBreakdown(enriched, totalAllIncome);

        // AI Analysis
        renderIncomeAIAnalysis(enriched, inPayment, cfvItems, totalMonthlyIncome, totalAllIncome);

        // Sync bar
        if (typeof registerSyncBar === 'function') {
            registerSyncBar('income', {
                refreshFn: async () => { if (typeof loadDashboard === 'function') await loadDashboard(); renderIncomeTab(); },
                checks: [
                    { name: 'Tenancy data loaded', kind: 'sync', run: () => {
                        const n = (allTenancies || []).length;
                        if (n === 0) return { status: 'warn', detail: 'No tenancies loaded — data may still be fetching' };
                        return { status: 'pass', detail: `${n} tenancy records loaded` };
                    }},
                    { name: 'Active income sources', kind: 'sync', run: () => {
                        if (enriched.length === 0) return { status: 'warn', detail: 'No active tenancies found' };
                        return { status: 'pass', detail: `${enriched.length} active tenancies` };
                    }},
                    { name: 'In-payment count', kind: 'sync', run: () => {
                        if (inPayment.length === 0 && enriched.length > 0) return { status: 'fail', detail: 'No tenancies in payment — all are CFV' };
                        return { status: 'pass', detail: `${inPayment.length} of ${enriched.length} tenancies in payment` };
                    }},
                    { name: 'Cash flow voids', kind: 'sync', run: () => {
                        if (cfvItems.length > 0) return { status: 'fail', detail: `${cfvItems.length} tenancy/ies in CFV — ${fmt(cfvItems.reduce((s, e) => s + e.rent, 0))} at risk` };
                        return { status: 'pass', detail: 'No cash flow voids' };
                    }},
                    { name: 'Missing rent amounts', kind: 'sync', run: () => {
                        const missing = enriched.filter(e => !e.rent || e.rent === 0).length;
                        if (missing > 0) return { status: 'warn', detail: `${missing} tenancy/ies without rent amount set` };
                        return { status: 'pass', detail: 'All tenancies have rent amounts' };
                    }},
                    { name: 'Missing due days', kind: 'sync', run: () => {
                        const missing = enriched.filter(e => !e.dueDay).length;
                        if (missing > 0) return { status: 'warn', detail: `${missing} tenancy/ies without due day set` };
                        return { status: 'pass', detail: 'All tenancies have due days' };
                    }},
                ]
            });
            if (typeof markTabSynced === 'function') markTabSynced('income');
        }
    }

    // ── Business filter dropdown ──
    function populateIncomeBusinessFilter() {
        const sel = document.getElementById('incomeBusinessFilter');
        if (!sel || sel.dataset.populated) return;
        sel.dataset.populated = '1';
        const businesses = (allBusinesses || []).filter(b => getField(b, BIZ_ACTIVE_FIELD));
        businesses.forEach(b => {
            const name = getField(b, BIZ_NAME_FIELD) || 'Unknown';
            const opt = document.createElement('option');
            opt.value = b.id;
            opt.textContent = name;
            sel.appendChild(opt);
        });
    }

    // ── Row renderer ──
    function renderIncomeRow(e, idx) {
        const statusClass = e.payStatus === 'CFV' ? 'danger'
            : e.payStatus === 'CFV Actioned' ? 'warning'
            : 'success';
        const statusBadge = `<span class="inv-badge" style="background:var(--${statusClass}-bg);color:var(--${statusClass})">${escHtml(e.payStatus)}</span>`;

        const cfvLink = (e.payStatus === 'CFV' || e.payStatus === 'CFV Actioned')
            ? `<span style="margin-left:4px;cursor:pointer;color:var(--accent);font-size:11px;text-decoration:underline" onclick="event.stopPropagation(); navigateToCFV()" title="Go to CFV page for this tenancy">View CFV</span>`
            : '';

        const dueDayStr = e.dueDay ? `Day ${e.dueDay}` : '<span style="color:var(--text-muted)">—</span>';

        const payTypeBadge = e.payType && e.payType !== 'Unknown'
            ? `<span style="font-size:11px;padding:2px 6px;border-radius:4px;background:var(--bg-subtle);color:var(--text-secondary)">${escHtml(e.payType)}</span>`
            : '<span style="color:var(--text-muted)">—</span>';

        return `<tr style="cursor:default">
            <td style="text-align:center;color:var(--text-muted);font-size:11px">${idx + 1}</td>
            <td style="font-weight:500">${escHtml(e.tenantName)}</td>
            <td>${escHtml(e.propertyName) || '<span style="color:var(--text-muted)">—</span>'}</td>
            <td style="font-size:12px">${escHtml(e.unitName) || '<span style="color:var(--text-muted)">—</span>'}</td>
            <td style="text-align:right;font-weight:600">${fmt(e.rent)}</td>
            <td>${dueDayStr}</td>
            <td>${statusBadge}${cfvLink}</td>
            <td>${payTypeBadge}</td>
            <td style="font-size:12px;color:var(--text-secondary)">${escHtml(e.frequency)}</td>
        </tr>`;
    }

    // ── CFV navigation ──
    function navigateToCFV() {
        if (typeof switchTab === 'function') {
            switchTab('cfv');
        }
    }

    // ── Breakdown ──
    function renderIncomeBreakdown(enriched, totalIncome) {
        const togglesEl = document.getElementById('incomeBreakdownToggles');
        const breakdownEl = document.getElementById('incomeBreakdown');
        if (!togglesEl || !breakdownEl) return;

        const hasProperty = enriched.some(e => e.propertyName);
        const views = [];
        if (hasProperty) views.push({ key: 'property', label: 'By Property' });
        views.push({ key: 'paytype', label: 'By Payment Type' });
        if ((allBusinesses || []).length > 1) views.push({ key: 'business', label: 'By Business' });

        if (views.length === 0) {
            togglesEl.innerHTML = '';
            breakdownEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px">No breakdown data available.</div>';
            return;
        }

        if (!views.find(v => v.key === _incomeBreakdownView)) {
            _incomeBreakdownView = views[0].key;
        }

        togglesEl.innerHTML = views.map(v =>
            `<button class="od-btn ${_incomeBreakdownView === v.key ? 'od-btn-outline' : 'od-btn-secondary'} od-btn-sm" onclick="_incomeBreakdownView='${v.key}'; renderIncomeBreakdown(window._lastIncomeEnriched, window._lastIncomeTotalIncome)">${v.label}</button>`
        ).join('');

        // Cache for re-render from toggle clicks
        window._lastIncomeEnriched = enriched;
        window._lastIncomeTotalIncome = totalIncome;

        const groups = {};
        enriched.forEach(e => {
            let key;
            if (_incomeBreakdownView === 'property') key = e.propertyName || 'No Property';
            else if (_incomeBreakdownView === 'paytype') key = e.payType || 'Unknown';
            else key = 'All'; // business not yet linked
            if (!groups[key]) groups[key] = { total: 0, count: 0, inPayment: 0, cfv: 0 };
            groups[key].total += e.rent;
            groups[key].count++;
            if (e.payStatus === 'In Payment') groups[key].inPayment++;
            else groups[key].cfv++;
        });

        const entries = Object.entries(groups).sort((a, b) => b[1].total - a[1].total);

        breakdownEl.innerHTML = entries.map(([key, data]) => {
            const pctNum = totalIncome > 0 ? (data.total / totalIncome * 100).toFixed(1) : '0.0';
            const cfvNote = data.cfv > 0
                ? `<span style="color:var(--danger);font-size:11px;margin-left:4px">${data.cfv} CFV</span>`
                : '';
            return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-subtle)">
                <span style="flex:1;font-size:13px;font-weight:500;color:var(--text-primary)">${escHtml(key)}</span>
                <span style="font-size:12px;color:var(--text-muted)">${data.count} ${data.count === 1 ? 'source' : 'sources'}${cfvNote}</span>
                <span style="font-size:13px;font-weight:600;color:var(--text-primary);min-width:80px;text-align:right">${fmt(data.total)}</span>
                <span style="font-size:11px;color:var(--text-muted);min-width:40px;text-align:right">${pctNum}%</span>
                <div style="width:80px;height:6px;background:var(--bg-subtle);border-radius:3px;overflow:hidden">
                    <div style="height:100%;width:${pctNum}%;background:var(--accent);border-radius:3px"></div>
                </div>
            </div>`;
        }).join('');
    }

    // ── AI Analysis ──
    function renderIncomeAIAnalysis(enriched, inPayment, cfvItems, totalMonthly, totalAll) {
        const el = document.getElementById('incomeAIAnalysis');
        if (!el) return;

        if (enriched.length === 0) {
            el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px">No data available for analysis.</div>';
            return;
        }

        const lines = [];
        const collectionRate = enriched.length > 0 ? ((inPayment.length / enriched.length) * 100).toFixed(0) : 0;
        lines.push(`<strong>Collection rate:</strong> ${collectionRate}% of ${enriched.length} tenancies are in payment (${fmt(totalMonthly)} of ${fmt(totalAll)} expected).`);

        if (cfvItems.length > 0) {
            const cfvTotal = cfvItems.reduce((s, e) => s + e.rent, 0);
            lines.push(`<strong>At risk:</strong> ${cfvItems.length} tenancy/ies totalling ${fmt(cfvTotal)}/month are in CFV status. This represents ${(cfvTotal / totalAll * 100).toFixed(1)}% of total expected income.`);
        }

        // Payment type breakdown
        const ptGroups = {};
        enriched.forEach(e => { ptGroups[e.payType] = (ptGroups[e.payType] || 0) + 1; });
        const ptParts = Object.entries(ptGroups).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${escHtml(String(v))} ${escHtml(k)}`);
        if (ptParts.length > 1) {
            lines.push(`<strong>Payment type mix:</strong> ${ptParts.join(', ')}.`);
        }

        // Concentration risk
        const byProp = {};
        enriched.forEach(e => {
            const p = e.propertyName || 'Unknown';
            byProp[p] = (byProp[p] || 0) + e.rent;
        });
        const propEntries = Object.entries(byProp).sort((a, b) => b[1] - a[1]);
        if (propEntries.length > 0 && totalAll > 0) {
            const topProp = propEntries[0];
            const topPct = (topProp[1] / totalAll * 100).toFixed(0);
            if (Number(topPct) > 50) {
                lines.push(`<strong>Concentration risk:</strong> ${escHtml(topProp[0])} generates ${topPct}% of total income (${fmt(topProp[1])}/month).`);
            }
        }

        // Missing data warnings
        const missingRent = enriched.filter(e => !e.rent || e.rent === 0).length;
        const missingDueDay = enriched.filter(e => !e.dueDay).length;
        if (missingRent > 0 || missingDueDay > 0) {
            const parts = [];
            if (missingRent > 0) parts.push(`${missingRent} without rent amount`);
            if (missingDueDay > 0) parts.push(`${missingDueDay} without due day`);
            lines.push(`<strong>Data quality:</strong> ${parts.join(', ')}. Update these in Airtable for accurate reporting.`);
        }

        el.innerHTML = `<div style="font-size:13px;color:var(--text-secondary);line-height:1.7">${lines.map(l => `<p style="margin:0 0 8px">${l}</p>`).join('')}</div>`;
    }
