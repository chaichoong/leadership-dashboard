// ══════════════════════════════════════════
// COSTS TAB — Accounts Payable Fixed
// Reads from the clean "Last Reconciled *" fields owned by the dashboard
// (written by the reconciliation flow + one-off backfill button).
// ══════════════════════════════════════════

    // ── Loading + sync indicators ──
    // Shows a spinner overlay when costs haven't loaded yet, plus a small
    // "Syncing…" pill when background syncDerivedCostFields is running.
    function showCostsLoadingState() {
        const panel = document.getElementById('tab-costs');
        if (!panel) return;
        let overlay = document.getElementById('costsLoadingOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'costsLoadingOverlay';
            overlay.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 0;gap:16px;color:var(--text-secondary)';
            overlay.innerHTML = `
                <div style="width:40px;height:40px;border:3px solid var(--border-default);border-top-color:var(--accent);border-radius:50%;animation:cost-spin 0.8s linear infinite"></div>
                <div style="font-size:14px;font-weight:500">Loading Accounts Payable Fixed…</div>
                <div id="costsLoadingMessage" style="font-size:12px;color:var(--text-muted);text-align:center;max-width:480px">Fetching costs from Airtable. This usually takes a few seconds.</div>
                <button id="costsLoadingRetryBtn" class="od-btn od-btn-primary" onclick="forceCostsRefresh()" style="margin-top:8px;display:none">Force Refresh from Airtable</button>
                <style>@keyframes cost-spin { to { transform: rotate(360deg); } }</style>
            `;
            panel.appendChild(overlay);
        }
        overlay.style.display = 'flex';
        // Hide the rest of the tab content while loading
        ['costsSummaryCards', 'costsTable', 'costsBreakdown', 'costsAIAnalysis'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });

        // After 8s of waiting, surface the manual refresh button + harder copy.
        if (window._costsLoadingTimer) clearTimeout(window._costsLoadingTimer);
        window._costsLoadingTimer = setTimeout(() => {
            const msg = document.getElementById('costsLoadingMessage');
            const btn = document.getElementById('costsLoadingRetryBtn');
            if (msg) msg.innerHTML = 'Still loading after 8 seconds — something may be wrong. Click below to force a fresh fetch from Airtable. If that doesn\'t work, log out and back in.';
            if (btn) btn.style.display = 'inline-block';
        }, 8000);
    }

    // Manual escape hatch — clears the local cache and refetches everything.
    async function forceCostsRefresh() {
        const btn = document.getElementById('costsLoadingRetryBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
        try {
            // Bust the dash cache (indexedDB)
            if (typeof clearDashCache === 'function') {
                try { await clearDashCache(); } catch (err) { console.warn('clearDashCache failed:', err); }
            }
            // Re-run the full dashboard load
            if (typeof loadDashboard === 'function') {
                await loadDashboard();
            }
            renderCostsTab();
        } catch (err) {
            showToast('Refresh failed: ' + err.message, { type: 'error' });
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Force Refresh from Airtable'; }
        }
    }

    function hideCostsLoadingState() {
        if (window._costsLoadingTimer) { clearTimeout(window._costsLoadingTimer); window._costsLoadingTimer = null; }
        const overlay = document.getElementById('costsLoadingOverlay');
        if (overlay) overlay.style.display = 'none';
        ['costsSummaryCards', 'costsBreakdown', 'costsAIAnalysis'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = '';
        });
        const tbl = document.getElementById('costsTable');
        if (tbl) tbl.style.display = '';
    }

    // Pill in the corner that shows during background syncs.
    function showSyncPill(msg) {
        let pill = document.getElementById('costsSyncPill');
        if (!pill) {
            pill = document.createElement('div');
            pill.id = 'costsSyncPill';
            pill.style.cssText = 'position:fixed;top:12px;right:12px;background:var(--info-bg);color:var(--info);padding:6px 12px;border-radius:20px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:8px;z-index:1500;box-shadow:var(--shadow-sm)';
            pill.innerHTML = '<span style="width:10px;height:10px;border:2px solid var(--info);border-top-color:transparent;border-radius:50%;animation:cost-spin 0.8s linear infinite"></span><span class="cost-sync-pill-msg"></span>';
            document.body.appendChild(pill);
        }
        pill.querySelector('.cost-sync-pill-msg').textContent = msg;
        pill.style.display = 'flex';
    }

    function hideSyncPill() {
        const pill = document.getElementById('costsSyncPill');
        if (pill) pill.style.display = 'none';
    }


    const SUBCAT_NAME_FIELD = 'fldO4BTJhFv5EsN6i';
    const CAT_NAME_FIELD = 'fldii4oUzSfmplihO';

    // Match thresholds for variance check (Last Reconciled Amount vs Expected Cost)
    const VAR_TOL_ABS = 1;     // £1 absolute
    const VAR_TOL_PCT = 0.02;  // 2% relative
    const VAR_HARD_PCT = 0.10; // > 10% = red

    function renderCostsTab() {
        const costs = (allCosts || []);
        const activeCosts = costs.filter(r => isCostActive(r));
        const inactiveCosts = costs.filter(r => !isCostActive(r));

        const panel = document.getElementById('tab-costs');
        if (!panel) return;

        // Loading state: if no costs loaded yet, show a clear spinner with explainer.
        // Distinguish "still fetching" from "loaded but genuinely empty" — the other
        // tables land in the same dashboard load, so if any of them have data the
        // fetch has completed and the Costs table is simply empty.
        if (costs.length === 0) {
            const dashLoaded = (allTransactions || []).length > 0 || (allTenancies || []).length > 0 || (allBusinesses || []).length > 0;
            if (dashLoaded) {
                hideCostsLoadingState();
                const tableBodyEl = document.getElementById('costsTableBody');
                if (tableBodyEl) tableBodyEl.innerHTML = `<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:32px">No costs yet — add your first fixed cost in Airtable.</td></tr>`;
                return;
            }
            showCostsLoadingState();
            return;
        } else {
            hideCostsLoadingState();
        }

        const filterText = (document.getElementById('costsFilterText')?.value || '').toLowerCase().trim();
        const sortBy = document.getElementById('costsSortBy')?.value || 'due-day';
        const statusFilter = document.getElementById('costsStatusFilter')?.value || 'active';
        const freqFilter = document.getElementById('costsFreqFilter')?.value || 'all';

        let sourceData = statusFilter === 'all' ? costs
            : statusFilter === 'inactive' ? inactiveCosts
            : activeCosts;

        if (freqFilter !== 'all') {
            sourceData = sourceData.filter(r => {
                const fr = getCostFrequency(r);
                if (freqFilter === 'monthly') return fr === 'Monthly' || fr === '4-Weekly' || fr === 'Fortnightly' || fr === 'Weekly' || fr === 'Daily';
                if (freqFilter === 'quarterly') return fr === 'Quarterly';
                if (freqFilter === 'annual') return fr === 'Annually';
                return true;
            });
        }

        const filtered = filterText
            ? sourceData.filter(r => {
                const haystack = [
                    getField(r, F.costName),
                    getField(r, F.costExpected),
                    getField(r, F.costLastReconAmount),
                    getField(r, F.costLastReconDate),
                    getField(r, F.costEndDate),
                    getField(r, F.costExpectedNext),
                    getField(r, F.costDaysOverdue),
                    getField(r, F.costVarianceAmount),
                    getPaymentStatusName(getField(r, F.costStatusNew)),
                    getPaymentStatusName(getField(r, F.costVarianceFlag)),
                    getCostFrequency(r),
                    getCostAccountName(r),
                    getCostSubCatName(r),
                    (getField(r, F.costDueDay) ? 'day ' + getField(r, F.costDueDay) : ''),
                ].map(v => (v == null ? '' : String(typeof v === 'object' && v.name ? v.name : v))).join('  ').toLowerCase();
                return haystack.includes(filterText);
            })
            : sourceData;

        const enriched = filtered.map(r => enrichCost(r));

        const sorted = [...enriched].sort((a, b) => {
            if (sortBy === 'due-day') return (a.dueDay || 99) - (b.dueDay || 99);
            if (sortBy === 'amount-desc') return b.expected - a.expected;
            if (sortBy === 'amount-asc') return a.expected - b.expected;
            if (sortBy === 'name') return a.name.localeCompare(b.name);
            if (sortBy === 'overdue-desc') return (b.daysOverdue || -999) - (a.daysOverdue || -999);
            if (sortBy === 'last-paid-desc') {
                const da = a.lastReconDate ? new Date(a.lastReconDate).getTime() : 0;
                const db = b.lastReconDate ? new Date(b.lastReconDate).getTime() : 0;
                return db - da;
            }
            return 0;
        });

        // Summary calculations on active set.
        // IMPORTANT: matches the Leadership Dashboard rule — raw sum of Expected Cost
        // across all active costs, with no frequency normalisation. The two figures
        // must always agree (single source of truth).
        const enrichedActive = activeCosts.map(r => enrichCost(r));
        const totalMonthly = enrichedActive.reduce((s, e) => s + e.expected, 0);
        const overdueCosts = enrichedActive.filter(e => e.daysOverdue !== null && e.daysOverdue > 0);
        const varianceCosts = enrichedActive.filter(e => e.varianceFlag !== 'match' && e.lastReconAmount != null);
        const hardVarianceCount = enrichedActive.filter(e => e.varianceFlag === 'hard').length;

        // Group by sub-category
        const byCat = {};
        enrichedActive.forEach(e => {
            const cat = e.subCatName || 'Uncategorised';
            if (!byCat[cat]) byCat[cat] = { total: 0, count: 0 };
            byCat[cat].total += e.expected;
            byCat[cat].count++;
        });
        const catEntries = Object.entries(byCat).sort((a, b) => b[1].total - a[1].total);

        const summaryEl = document.getElementById('costsSummaryCards');
        if (summaryEl) {
            summaryEl.innerHTML = `
                <div class="kpi-card">
                    <div class="kpi-card-label">Active Fixed Costs</div>
                    <div class="kpi-card-value">${activeCosts.length}</div>
                    <div class="kpi-card-sub">${inactiveCosts.length} inactive</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Monthly Fixed Costs</div>
                    <div class="kpi-card-value text-red">${fmt(totalMonthly)}</div>
                    <div class="kpi-card-sub">Sum of Expected Cost — matches Leadership Dashboard</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Overdue</div>
                    <div class="kpi-card-value" style="color:${overdueCosts.length > 0 ? 'var(--danger)' : 'var(--success)'}">${overdueCosts.length}</div>
                    <div class="kpi-card-sub">Past expected next payment date</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Variance Flags</div>
                    <div class="kpi-card-value" style="color:${hardVarianceCount > 0 ? 'var(--danger)' : (varianceCosts.length > 0 ? 'var(--warning)' : 'var(--success)')}">${varianceCosts.length}</div>
                    <div class="kpi-card-sub">${hardVarianceCount} hard · ${varianceCosts.length - hardVarianceCount} soft</div>
                </div>
            `;
        }

        const tableEl = document.getElementById('costsTable');
        if (tableEl) tableEl.style.display = '';

        const tableBodyEl = document.getElementById('costsTableBody');
        if (tableBodyEl) {
            if (sorted.length === 0) {
                tableBodyEl.innerHTML = `<tr><td colspan="13" style="text-align:center;color:var(--text-muted);padding:32px">No costs match your filters.</td></tr>`;
            } else {
                tableBodyEl.innerHTML = sorted.map((e, idx) => renderCostRow(e, idx)).join('');
            }
        }

        const breakdownEl = document.getElementById('costsBreakdown');
        if (breakdownEl) {
            breakdownEl.innerHTML = catEntries.map(([cat, data]) => {
                const pctNum = totalMonthly > 0 ? (data.total / totalMonthly * 100).toFixed(1) : '0.0';
                return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-subtle)">
                    <span style="flex:1;font-size:13px;font-weight:500;color:var(--text-primary)">${escHtml(cat)}</span>
                    <span style="font-size:12px;color:var(--text-muted)">${data.count} costs</span>
                    <span style="font-size:13px;font-weight:600;color:var(--text-primary);min-width:80px;text-align:right">${fmt(data.total)}</span>
                    <span style="font-size:11px;color:var(--text-muted);min-width:40px;text-align:right">${pctNum}%</span>
                    <div style="width:80px;height:6px;background:var(--bg-subtle);border-radius:3px;overflow:hidden">
                        <div style="height:100%;width:${pctNum}%;background:var(--accent);border-radius:3px"></div>
                    </div>
                </div>`;
            }).join('');
        }

        renderCostsAIAnalysis(enrichedActive, totalMonthly, catEntries);

        // Two-way sync: push computed fields (Days Overdue, Variance, Expected Next, Status)
        // back to Airtable. Runs in the background; UI renders from local state immediately.
        if (typeof syncDerivedCostFields === 'function' && typeof PAT !== 'undefined' && PAT) {
            syncDerivedCostFields().catch(err => console.warn('Cost derived sync failed:', err));
        }

        if (typeof registerSyncBar === 'function') {
            registerSyncBar('costs', {
                refreshFn: async () => { if (typeof loadDashboard === 'function') await loadDashboard(); renderCostsTab(); },
                checks: [
                    { name: 'Costs data loaded', kind: 'sync', run: () => {
                        const n = (allCosts || []).length;
                        if (n === 0) return { status: 'warn', detail: 'No costs loaded — data may still be fetching' };
                        return { status: 'pass', detail: `${n} cost records loaded` };
                    }},
                    { name: 'Active costs found', kind: 'sync', run: () => {
                        const total = activeCosts.length;
                        const grand = (allCosts || []).length;
                        if (grand === 0) return { status: 'warn', detail: 'No costs loaded yet' };
                        if (total === 0) return { status: 'fail', detail: `0 of ${grand} costs are active. If you expect costs here, click Refresh — your local cache may be stale.` };
                        return { status: 'pass', detail: `${total} active costs (Payment Status = In Payment or Overdue)` };
                    }},
                    { name: 'Overdue costs', kind: 'sync', run: () => {
                        if (overdueCosts.length > 0) return { status: 'fail', detail: `${overdueCosts.length} cost(s) overdue — review` };
                        return { status: 'pass', detail: 'No overdue costs' };
                    }},
                    { name: 'Amount variance flags', kind: 'sync', run: () => {
                        if (hardVarianceCount > 0) return { status: 'fail', detail: `${hardVarianceCount} cost(s) with hard variance (>10%) — review reconciliation` };
                        if (varianceCosts.length > 0) return { status: 'warn', detail: `${varianceCosts.length} cost(s) with soft variance — possible rate change` };
                        return { status: 'pass', detail: 'All reconciled amounts match expected' };
                    }},
                    { name: 'Missing amounts', kind: 'sync', run: () => {
                        const missing = activeCosts.filter(r => !getField(r, F.costExpected)).length;
                        if (missing > 0) return { status: 'warn', detail: `${missing} active cost(s) without expected amount` };
                        return { status: 'pass', detail: 'All active costs have expected amounts' };
                    }}
                ]
            });
            if (typeof markTabSynced === 'function') markTabSynced('costs');
        }
    }

    // ── Enrichment: pulls all the per-cost computed values into one object ──
    function enrichCost(r) {
        const expected = Number(getField(r, F.costExpected)) || 0;
        const frequency = getCostFrequency(r);
        const dueDay = Number(getField(r, F.costDueDay)) || null;
        const endDate = getField(r, F.costEndDate) || null;
        const lastReconDate = getField(r, F.costLastReconDate) || null;
        const lastReconAmount = getField(r, F.costLastReconAmount);
        const lastReconAmountNum = lastReconAmount != null ? Number(lastReconAmount) : null;
        const lastReconAccountIds = (getField(r, F.costLastReconAccount) || []).map(v => v.id || v).filter(Boolean);
        const lastReconSubCatIds = (getField(r, F.costLastReconSubCat) || []).map(v => v.id || v).filter(Boolean);
        const accountName = lastReconAccountIds.length > 0 ? getAccountName(lastReconAccountIds[0]) : '';
        const subCatName = lastReconSubCatIds.length > 0 ? getSubCatNameById(lastReconSubCatIds[0]) : '';
        // Payment Status is the source of truth — Kevin curates this manually.
        // Active = "In Payment" or "Overdue"; everything else (Paused, Inactive) is excluded.
        const status = getPaymentStatusName(getField(r, F.costPayStatus)) || '';
        const inactive = !!getField(r, F.costInactive) || status === 'Inactive' || status === 'Paused';

        // Expected payment date for THIS period (anchored on Due Day, weekend-shifted).
        const expectedThisPeriod = computeExpectedNextPayment(lastReconDate, dueDay, frequency);
        const today = new Date(); today.setHours(0,0,0,0);

        // "Paid this period" — did a payment land for the current period?
        //
        // Direct debits routinely clear a few days BEFORE the due day (Sky paid
        // on the 29th for a due day of 30, Oldham on the 17th for a due day of
        // 22). The old test was `lastRecon >= expected`, which scored those as
        // UNPAID and then counted days from the due date — so paying a bill
        // EARLY made it read as overdue. That was 5 of 21 overdue costs.
        //
        // The tolerance only applies to the Due-Day-anchored path (Monthly, or
        // frequency unset). Every other frequency derives `expected` FROM
        // lastReconDate (lastRecon + interval), so lastRecon can never reach it
        // and the tolerance is either inert (Fortnightly/4-Weekly/Quarterly/
        // Annually) or actively harmful — on Daily and Weekly, expected minus 7
        // days lands on or before lastRecon itself, which would mark those costs
        // permanently paid and silence real overdues.
        const EARLY_PAY_TOLERANCE_DAYS = 7;
        const dueDayAnchored = (frequency === 'Monthly' || !frequency);
        const paidThisPeriod = expectedThisPeriod && lastReconDate
            ? new Date(lastReconDate).getTime() >= expectedThisPeriod.getTime()
                - (dueDayAnchored ? EARLY_PAY_TOLERANCE_DAYS * 86400000 : 0)
            : false;

        // Days overdue:
        //   - If paid this period → 0 (or negative, but we'll show as paid)
        //   - If today >= expected and not yet paid → today - expected (positive)
        //   - If today < expected → negative (days until due)
        let daysOverdue = null;
        if (expectedThisPeriod) {
            if (paidThisPeriod) {
                daysOverdue = 0; // already paid this period
            } else {
                daysOverdue = Math.round((today.getTime() - expectedThisPeriod.getTime()) / 86400000);
            }
        }

        // Drift: how late/early the last actual payment was vs its expected day in the month it was made.
        const lastPaymentDrift = computeLastPaymentDrift(lastReconDate, dueDay);

        // Variance against expected — respects sticky dismissal until next reconciliation.
        let varianceFlag = 'unknown';
        let varianceAmount = 0;
        let variancePct = 0;
        if (lastReconAmountNum != null && expected > 0) {
            varianceAmount = lastReconAmountNum - expected;
            variancePct = Math.abs(varianceAmount) / expected;
            const absVar = Math.abs(varianceAmount);
            if (absVar <= VAR_TOL_ABS && variancePct <= VAR_TOL_PCT) varianceFlag = 'match';
            else if (variancePct > VAR_HARD_PCT) varianceFlag = 'hard';
            else varianceFlag = 'soft';
        }
        // Dismissal: if the user dismissed at the same lastReconDate, treat as match for UI
        const dismissedAt = getField(r, F.costVarianceDismissedAt);
        const varianceDismissed = !!(dismissedAt && lastReconDate &&
            new Date(dismissedAt).toDateString() === new Date(lastReconDate).toDateString());

        return {
            id: r.id,
            raw: r,
            name: getField(r, F.costName) || '',
            expected, frequency, dueDay, endDate,
            lastReconDate, lastReconAmount: lastReconAmountNum,
            lastReconAccountIds, lastReconSubCatIds, accountName, subCatName,
            status, inactive,
            expectedNext: expectedThisPeriod,
            daysOverdue,
            paidThisPeriod,
            lastPaymentDrift,
            varianceFlag, varianceAmount, variancePct, varianceDismissed,
        };
    }

    function renderCostRow(e, idx) {
        const dueDayStr = e.dueDay ? `Day ${e.dueDay}` : '— set —';
        const dueDayCell = `<span class="cost-editable" data-cost-id="${e.id}" data-field="${F.costDueDay}" data-type="dueday" data-raw="${e.dueDay || ''}" onclick="event.stopPropagation(); editCostField(this)" title="Click to edit Due Day" style="cursor:pointer">${escHtml(dueDayStr)}</span>`;
        const accountStr = e.accountName ? escHtml(e.accountName) : '<span style="color:var(--text-muted)">—</span>';
        const subCatStr = e.subCatName ? escHtml(e.subCatName) : '<span style="color:var(--text-muted)">—</span>';

        // Editable Expected Cost
        const expectedCell = `<span class="cost-editable" data-cost-id="${e.id}" data-field="${F.costExpected}" data-type="number" onclick="event.stopPropagation(); editCostField(this)" title="Click to edit Expected Cost" style="cursor:pointer">${fmt(e.expected)}</span>`;

        // Editable End Date
        const endDateInner = e.endDate ? formatCostDate(e.endDate) : '<span style="color:var(--text-muted)">— set —</span>';
        const endDateCell = `<span class="cost-editable" data-cost-id="${e.id}" data-field="${F.costEndDate}" data-type="date" data-raw="${e.endDate || ''}" onclick="event.stopPropagation(); editCostField(this)" title="Click to edit End Date" style="cursor:pointer;font-size:11px;color:var(--text-muted)">${endDateInner}</span>`;

        // Last Paid + drift badge (click for "amend Due Day" action)
        let lastPaidCell;
        if (!e.lastReconDate) {
            lastPaidCell = '<span style="color:var(--text-muted)">—</span>';
        } else {
            const drift = e.lastPaymentDrift;
            let driftBadge = '';
            if (drift !== null && drift !== 0 && Math.abs(drift) > 1) {
                const cls = drift > 1 ? 'warning' : 'info';
                const sign = drift > 0 ? '+' : '';
                const tip = drift > 1
                    ? `Last payment was ${drift} days after the expected day — click for actions`
                    : `Last payment landed ${Math.abs(drift)} days BEFORE the expected day — click for actions`;
                driftBadge = ` <span class="cost-drift-badge" style="font-size:10px;color:var(--${cls});font-weight:600;cursor:pointer;text-decoration:underline" title="${tip}" onclick="event.stopPropagation(); openDriftMenu(this, '${e.id}')">${sign}${drift}d</span>`;
            }
            lastPaidCell = `${formatCostDate(e.lastReconDate)}${driftBadge}`;
        }

        // Last Reconciled Amount + variance badge with actions menu
        const lastAmtRaw = e.lastReconAmount != null ? fmt(e.lastReconAmount) : '<span style="color:var(--text-muted)">—</span>';
        let varianceBadge = '';
        if (e.lastReconAmount != null && e.varianceFlag !== 'unknown') {
            if (e.varianceDismissed) {
                varianceBadge = `<span style="color:var(--text-muted);font-size:10px;cursor:pointer;text-decoration:underline" title="Variance dismissed — click to undo" onclick="event.stopPropagation(); undismissCostVariance('${e.id}')">dismissed ↶</span>`;
            } else if (e.varianceFlag === 'match') {
                varianceBadge = '<span style="color:var(--success);font-size:11px" title="Reconciled amount matches expected">✓</span>';
            } else {
                const sign = e.varianceAmount >= 0 ? '+' : '−';
                const cls = e.varianceFlag === 'hard' ? 'danger' : 'warning';
                const tail = e.varianceFlag === 'hard' ? ' ⚠' : '';
                varianceBadge = `<span class="inv-badge cost-variance-badge" style="background:var(--${cls}-bg);color:var(--${cls});cursor:pointer" title="${(e.variancePct*100).toFixed(1)}% variance — click for actions" onclick="event.stopPropagation(); openVarianceMenu(this, '${e.id}')">${sign}${fmt(Math.abs(e.varianceAmount))}${tail}</span>`;
            }
        }
        const lastAmtCell = `<div style="display:flex;align-items:center;gap:6px;justify-content:flex-end">${lastAmtRaw} ${varianceBadge}</div>`;

        // Status badge
        const statusClass = e.status === 'Overdue' ? 'overdue'
            : e.status === 'In Payment' ? 'in-payment'
            : e.status === 'Paused' ? 'due-soon'
            : 'estimate';
        // Status badge — clickable to override. A small lock icon appears when manually overridden.
        const statusLocked = !!getField(e.raw, F.costStatusLockedAt) &&
            !!e.lastReconDate &&
            new Date(getField(e.raw, F.costStatusLockedAt)).toDateString() === new Date(e.lastReconDate).toDateString();
        const lockIcon = statusLocked ? ' <span title="Manually overridden — auto-flip disabled until next reconciliation" style="font-size:10px">🔒</span>' : '';
        const statusBadge = e.status
            ? `<span class="inv-badge ${statusClass}" style="cursor:pointer" title="Click to change status" onclick="event.stopPropagation(); openStatusMenu(this, '${e.id}')">${escHtml(e.status)}${lockIcon}</span>`
            : `<span style="color:var(--text-muted);font-size:11px;cursor:pointer;text-decoration:underline" title="Click to set status" onclick="event.stopPropagation(); openStatusMenu(this, '${e.id}')">— set status —</span>`;

        // Days Overdue (Due-Day-anchored, paid-this-period aware)
        let overdueCell = '<span style="color:var(--text-muted)">—</span>';
        if (e.daysOverdue !== null && !e.inactive) {
            if (e.paidThisPeriod) {
                overdueCell = '<span style="color:var(--success);font-size:11px">✓ paid this period</span>';
            } else if (e.daysOverdue > 0) {
                overdueCell = `<span style="color:var(--danger);font-weight:600">${e.daysOverdue}d overdue</span>`;
            } else if (e.daysOverdue === 0) {
                overdueCell = '<span style="color:var(--warning);font-weight:600">Due today</span>';
            } else {
                overdueCell = `<span style="color:var(--text-muted)">in ${Math.abs(e.daysOverdue)}d</span>`;
            }
        }

        return `<tr data-record-id="${e.id}" class="${e.inactive ? 'cost-inactive-row' : ''}">
            <td style="text-align:center;color:var(--text-muted);font-size:11px;font-weight:600">${idx + 1}</td>
            <td style="font-weight:600;max-width:200px"><span class="cost-editable" data-cost-id="${e.id}" data-field="${F.costName}" data-type="text" onclick="event.stopPropagation(); editCostField(this)" title="Click to edit Cost Name" style="cursor:pointer">${escHtml(e.name)}</span></td>
            <td style="text-align:right;white-space:nowrap;font-weight:600">${expectedCell}</td>
            <td style="text-align:right;white-space:nowrap">${lastAmtCell}</td>
            <td style="white-space:nowrap;color:var(--text-secondary)">${dueDayCell}</td>
            <td style="white-space:nowrap">${lastPaidCell}</td>
            <td style="white-space:nowrap">${overdueCell}</td>
            <td style="white-space:nowrap">${statusBadge}</td>
            <td style="font-size:12px;color:var(--text-secondary)">${escHtml(e.frequency)}</td>
            <td style="font-size:12px;color:var(--text-secondary)">${accountStr}</td>
            <td style="font-size:12px;color:var(--text-secondary);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${subCatStr}</td>
            <td style="white-space:nowrap">${endDateCell}</td>
            <td style="width:80px;text-align:center;white-space:nowrap">
                <button class="od-btn od-btn-outline od-btn-sm" onclick="event.stopPropagation(); costOpenPrintStatement('${e.id}')" title="Print statement" style="margin-right:2px">🖨</button>
                <span class="expand-chevron" id="cost-chev-${e.id}" onclick="event.stopPropagation(); toggleCostTxRow('${e.id}')" style="cursor:pointer;font-size:11px" title="Show linked transactions">▶</span>
            </td>
        </tr>
        <tr class="expand-row cost-tx-detail-row" id="cost-tx-${e.id}" style="display:none">
            <td colspan="13"><div class="expand-content">
                ${buildLinkedTransactionsHtml(e)}
            </div></td>
        </tr>`;
    }

    // ── Helpers ──

    function getCostFrequency(rec) {
        const f = getField(rec, F.costFrequency);
        if (!f) return '';
        if (typeof f === 'string') return f;
        return f.name || '';
    }

    function getCostSubCatName(rec) {
        const linked = getField(rec, F.costLastReconSubCat) || getField(rec, F.costSubCategory);
        if (!linked || !Array.isArray(linked) || linked.length === 0) return '';
        const id = linked[0].id || linked[0];
        return getSubCatNameById(id);
    }

    function getCostAccountName(rec) {
        const linked = getField(rec, F.costLastReconAccount);
        if (!linked || !Array.isArray(linked) || linked.length === 0) return '';
        const id = linked[0].id || linked[0];
        return getAccountName(id);
    }

    function getSubCatNameById(id) {
        const sc = (allSubCategories || []).find(s => s.id === id);
        if (!sc) return '';
        const n = getField(sc, SUBCAT_NAME_FIELD);
        if (typeof n === 'string') return n;
        if (n && n.name) return n.name;
        return '';
    }

    function getAccountName(id) {
        const acc = (allAccounts || []).find(a => a.id === id);
        if (!acc) return '';
        // Prefer Account Alias (human-friendly), fall back to *Name (coded), then any short string.
        const alias = getField(acc, F.accountAlias);
        if (typeof alias === 'string' && alias.trim()) return alias.trim();
        const name = getField(acc, 'fldqr09KqLGGYCYkC'); // *Name
        if (typeof name === 'string' && name.trim()) return name.trim();
        const fields = acc.fields || {};
        for (const k of Object.keys(fields)) {
            const v = fields[k];
            if (typeof v === 'string' && v.length > 0 && v.length < 80) return v;
        }
        return '';
    }

    function formatCostDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        if (isNaN(d)) return escHtml(dateStr);
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    // Convert any frequency to monthly equivalent (£/month)
    function monthlyEquivalent(amount, frequency) {
        if (!amount) return 0;
        switch (frequency) {
            case 'Daily':       return amount * 30;
            case 'Weekly':      return amount * (52 / 12);
            case 'Fortnightly': return amount * (26 / 12);
            case '4-Weekly':    return amount * (13 / 12);
            case 'Monthly':     return amount;
            case 'Quarterly':   return amount / 3;
            case 'Annually':    return amount / 12;
            default:            return amount;
        }
    }

    // Shift a date forward to the next business day if it lands on Sat/Sun.
    // Most fixed costs are direct debits which honour banking days; standing
    // orders fall on the literal due day. We default to DD behaviour because
    // Kevin confirmed most are DDs.
    function shiftWeekendToMonday(d) {
        const day = d.getDay();
        if (day === 6) d.setDate(d.getDate() + 2); // Sat → Mon
        else if (day === 0) d.setDate(d.getDate() + 1); // Sun → Mon
        return d;
    }

    // Compute the EXPECTED payment date for the current period, anchored on
    // Due Day (not the actual last payment date). Weekend-shifted for DD.
    //
    // For monthly/sub-monthly: the most recent occurrence of Due Day in the
    // current or previous month, on/before today.
    // For quarterly/annually: anchored to the lastReconDate's month, advanced
    // by the frequency interval; if no last recon, uses Due Day of current
    // period as best-effort.
    function computeExpectedNextPayment(lastReconDate, dueDay, frequency) {
        const today = new Date(); today.setHours(0,0,0,0);
        if (!dueDay) return null;

        // Sub-monthly frequencies don't really fit the Due Day model — fall
        // back to lastReconDate + interval (or today as starting point).
        if (frequency === 'Daily' || frequency === 'Weekly' || frequency === 'Fortnightly' || frequency === '4-Weekly') {
            if (!lastReconDate) return null;
            const last = new Date(lastReconDate); last.setHours(0,0,0,0);
            return shiftWeekendToMonday(addFrequency(last, frequency));
        }

        if (frequency === 'Monthly' || !frequency) {
            // Most-recent occurrence of Due Day at or before today.
            // If today's date < dueDay, the expectation is in this month but in the future,
            // so the "expected this period" is last month's due day.
            let expected = new Date(today.getFullYear(), today.getMonth(), dueDay);
            shiftWeekendToMonday(expected);
            if (expected > today) {
                // Use previous month's due day as the relevant "expected this period"
                expected = new Date(today.getFullYear(), today.getMonth() - 1, dueDay);
                shiftWeekendToMonday(expected);
            }
            return expected;
        }

        if (frequency === 'Quarterly') {
            // Anchored to lastReconDate's month, advanced by 3 months.
            if (!lastReconDate) {
                const expected = new Date(today.getFullYear(), today.getMonth(), dueDay);
                return shiftWeekendToMonday(expected);
            }
            const last = new Date(lastReconDate); last.setHours(0,0,0,0);
            const expected = new Date(last.getFullYear(), last.getMonth() + 3, dueDay);
            return shiftWeekendToMonday(expected);
        }

        if (frequency === 'Annually') {
            if (!lastReconDate) {
                const expected = new Date(today.getFullYear(), today.getMonth(), dueDay);
                return shiftWeekendToMonday(expected);
            }
            const last = new Date(lastReconDate); last.setHours(0,0,0,0);
            const expected = new Date(last.getFullYear() + 1, last.getMonth(), dueDay);
            return shiftWeekendToMonday(expected);
        }

        return null;
    }

    function addFrequency(d, frequency) {
        const out = new Date(d);
        switch (frequency) {
            case 'Daily':       out.setDate(out.getDate() + 1); break;
            case 'Weekly':      out.setDate(out.getDate() + 7); break;
            case 'Fortnightly': out.setDate(out.getDate() + 14); break;
            case '4-Weekly':    out.setDate(out.getDate() + 28); break;
            case 'Monthly':     out.setMonth(out.getMonth() + 1); break;
            case 'Quarterly':   out.setMonth(out.getMonth() + 3); break;
            case 'Annually':    out.setFullYear(out.getFullYear() + 1); break;
            default:            out.setMonth(out.getMonth() + 1); break;
        }
        return out;
    }

    // Returns positive days late if last payment landed AFTER its expected weekend-shifted date.
    // Returns negative if early. Null if no last payment or no due day.
    function computeLastPaymentDrift(lastReconDate, dueDay) {
        if (!lastReconDate || !dueDay) return null;
        const paid = new Date(lastReconDate); paid.setHours(0,0,0,0);
        // The expected date for THE month the payment was made in
        let expected = new Date(paid.getFullYear(), paid.getMonth(), dueDay);
        shiftWeekendToMonday(expected);
        return Math.round((paid - expected) / 86400000);
    }

    function buildLinkedTransactionsHtml(e) {
        const txs = (allTransactions || []).filter(tx => {
            const linked = getField(tx, F.txCost);
            if (!Array.isArray(linked)) return false;
            return linked.some(v => (v.id || v) === e.id);
        });

        if (txs.length === 0) {
            return '<div class="expand-empty">No linked transactions found</div>';
        }

        const txSorted = [...txs].sort((a, b) => {
            const da = new Date(getField(a, F.txDate) || ''); const db = new Date(getField(b, F.txDate) || '');
            return db - da;
        });

        const totalLinked = txSorted.reduce((s, tx) => s + Math.abs(Number(getField(tx, F.txReportAmount)) || 0), 0);

        const rows = txSorted.slice(0, 20).map(tx => {
            const date = getField(tx, F.txDate) || '';
            const amount = Number(getField(tx, F.txReportAmount)) || 0;
            const label = txLabel(tx);
            const account = getField(tx, F.txAccountAlias) || '';
            const reconciled = getField(tx, F.txReconciled);

            const catLinks = (getField(tx, F.txCategory) || []).map(v => v.id || v).filter(Boolean);
            const catName = catLinks.length > 0 ? getCatNameById(catLinks[0]) : '';
            const catCell = `<span class="tx-cat-editable" data-tx-id="${tx.id}" data-link-type="cat" onclick="event.stopPropagation(); editTxLinkField(this)" title="Click to set category" style="cursor:pointer;color:${catName ? 'var(--text-primary)' : 'var(--text-muted)'}">${catName ? escHtml(catName) : '— set —'}</span>`;

            const scLinks = (getField(tx, F.txSubCategory) || []).map(v => v.id || v).filter(Boolean);
            const scName = scLinks.length > 0 ? getSubCatNameById(scLinks[0]) : '';
            const scCell = `<span class="tx-cat-editable" data-tx-id="${tx.id}" data-link-type="subcat" onclick="event.stopPropagation(); editTxLinkField(this)" title="Click to set sub-category" style="cursor:pointer;color:${scName ? 'var(--text-primary)' : 'var(--text-muted)'}">${scName ? escHtml(scName) : '— set —'}</span>`;

            const reconBadge = reconciled
                ? '<span style="color:var(--success);font-size:10px;font-weight:600">✓ Reconciled</span>'
                : '<span style="color:var(--text-muted);font-size:10px">Unreconciled</span>';
            const unlinkBtn = reconciled
                ? `<button class="od-btn od-btn-outline od-btn-sm" onclick="event.stopPropagation(); unlinkTxFromCost('${tx.id}', '${e.id}', this)" title="Unlink — wrong reconciliation" style="color:var(--danger);border-color:var(--danger)">Unlink</button>`
                : '';
            return `<tr>
                <td style="color:var(--text-secondary)">${escHtml(formatCostDate(date))}</td>
                <td class="truncate" style="font-weight:500">${escHtml(label)}</td>
                <td class="money" style="font-weight:600;color:${amount < 0 ? 'var(--danger)' : 'var(--text-primary)'}">${fmt(Math.abs(amount))}</td>
                <td style="color:var(--text-muted)">${escHtml(account)}</td>
                <td>${catCell}</td>
                <td>${scCell}</td>
                <td>${reconBadge}</td>
                <td style="text-align:right">${unlinkBtn}</td>
            </tr>`;
        }).join('');

        return `<div class="expand-summary"><span>${txSorted.length} linked transaction${txSorted.length !== 1 ? 's' : ''} · Total: <strong>${fmt(totalLinked)}</strong></span></div>
            <table class="tx-table">
            <colgroup><col style="width:90px"><col><col style="width:95px"><col style="width:100px"><col style="width:140px"><col style="width:150px"><col style="width:95px"><col style="width:75px"></colgroup>
            <thead><tr>
                <th>Date</th><th>Description</th><th class="money">Amount</th><th>Account</th><th>Category</th><th>Sub-Category</th><th>Status</th><th></th>
            </tr></thead>
            <tbody>${rows}</tbody>
            </table>
            ${txSorted.length > 20 ? '<div style="font-size:var(--fs-xs);color:var(--text-muted);padding:6px 0">Showing 20 of ' + txSorted.length + '</div>' : ''}`;
    }

    function getCatNameById(id) {
        const c = (allCategories || []).find(x => x.id === id);
        if (!c) return '';
        const n = getField(c, CAT_NAME_FIELD);
        return typeof n === 'string' ? n : (n?.name || '');
    }

    // Type-to-search editor for tx Category / Sub-Category. Replaces the span
    // with an <input list="datalist"> so typing filters options inline (same
    // pattern as the reconciliation dropdowns). PATCHes Airtable on commit.
    let _txDlCounter = 0;
    async function editTxLinkField(span) {
        const txId = span.dataset.txId;
        const linkType = span.dataset.linkType; // 'cat' or 'subcat'
        const tx = (allTransactions || []).find(t => t.id === txId);
        if (!tx) return;
        const fieldId = linkType === 'cat' ? F.txCategory : F.txSubCategory;
        const records = linkType === 'cat' ? (allCategories || []) : (allSubCategories || []);
        const nameField = linkType === 'cat' ? CAT_NAME_FIELD : SUBCAT_NAME_FIELD;
        const currentLinks = (getField(tx, fieldId) || []).map(v => v.id || v).filter(Boolean);
        const currentId = currentLinks[0] || '';

        const items = records.map(r => ({
            id: r.id,
            name: (typeof getField(r, nameField) === 'string' ? getField(r, nameField) : (getField(r, nameField)?.name || '')) || '(unnamed)'
        })).sort((a, b) => a.name.localeCompare(b.name));
        const currentName = items.find(i => i.id === currentId)?.name || '';

        const dlId = 'tx-dl-' + (++_txDlCounter);
        const wrapper = document.createElement('span');
        wrapper.style.cssText = 'display:inline-flex;align-items:center;gap:2px';
        wrapper.innerHTML = `
            <input type="text" list="${dlId}" value="${escHtml(currentName)}" placeholder="Type to search…" autocomplete="off"
                   style="width:140px;padding:2px 4px;border:1px solid var(--accent);border-radius:3px;font-size:11px;background:var(--bg-surface);color:var(--text-primary)">
            <datalist id="${dlId}">
                ${items.map(i => `<option value="${escHtml(i.name)}" data-id="${i.id}">`).join('')}
            </datalist>
        `;
        const input = wrapper.querySelector('input');
        const parent = span.parentNode;
        parent.replaceChild(wrapper, span);
        input.focus();
        input.select();

        let done = false;
        const renderAndRestore = () => {
            const expanded = getExpandedCostIds();
            renderCostsTab();
            restoreExpandedCostRows(expanded);
        };
        const finish = async (commit) => {
            if (done) return; done = true;
            if (!commit) { renderAndRestore(); return; }
            const typed = input.value.trim();
            let newId = '';
            if (typed) {
                const match = items.find(i => i.name.toLowerCase() === typed.toLowerCase());
                if (!match) {
                    alert(`No ${linkType === 'cat' ? 'category' : 'sub-category'} matches "${typed}". Pick from the list.`);
                    renderAndRestore(); return;
                }
                newId = match.id;
            }
            if (newId === currentId) { renderAndRestore(); return; }
            const newLinks = newId ? [newId] : [];
            try {
                const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${txId}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: { [fieldId]: newLinks } })
                });
                if (!resp.ok) throw new Error('PATCH ' + resp.status);
                if (!tx.fields) tx.fields = {};
                tx.fields[fieldId] = newLinks;
                const newName = newId ? items.find(i => i.id === newId)?.name : '— none —';
                pushUndoAction({
                    kind: 'tx-link', txId, fieldId,
                    oldValue: currentLinks, newValue: newLinks,
                    label: `${linkType === 'cat' ? 'Category' : 'Sub-Category'} → ${newName}`
                });
                renderAndRestore();
            } catch (err) {
                alert('Save failed: ' + err.message);
                renderAndRestore();
            }
        };

        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
            else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
        });
        // Datalist suggestions fire 'change' on selection AND 'input' on typing.
        // We commit on blur to give the user time to finish typing.
        input.addEventListener('blur', () => finish(true));
    }

    function getExpandedCostIds() {
        const ids = [];
        document.querySelectorAll('.cost-tx-detail-row').forEach(row => {
            if (row.style.display !== 'none') {
                const id = row.id.replace('cost-tx-', '');
                if (id) ids.push(id);
            }
        });
        return ids;
    }

    function restoreExpandedCostRows(ids) {
        for (const id of ids) {
            const row = document.getElementById('cost-tx-' + id);
            if (row) {
                row.style.display = '';
                const chevron = document.getElementById('cost-chev-' + id);
                if (chevron) chevron.classList.add('open');
            }
        }
    }

    function toggleCostTxRow(costId) {
        const row = document.getElementById('cost-tx-' + costId);
        const chevron = document.getElementById('cost-chev-' + costId);
        if (!row) return;
        const visible = row.style.display !== 'none';
        row.style.display = visible ? 'none' : '';
        if (chevron) chevron.classList.toggle('open', !visible);
    }

    // Unlink a transaction from a cost — used when a reconciliation was wrong.
    // Clears txCost on the transaction; recomputes the cost's "Last Reconciled *" fields
    // from the remaining linked txs.
    async function unlinkTxFromCost(txId, costId, btn) {
        if (!confirm('Unlink this transaction from the cost? This will mark it as a wrong match and clear the link in Airtable.')) return;
        if (btn) { btn.textContent = '...'; btn.disabled = true; }
        try {
            // Clear txCost on the transaction
            const txResp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${txId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: { [F.txCost]: [] } })
            });
            if (!txResp.ok) throw new Error('Failed to unlink tx: ' + txResp.status);
            // Update local state
            const localTx = allTransactions.find(t => t.id === txId);
            if (localTx) localTx.fields[F.txCost] = [];
            // Recompute the cost's "Last Reconciled *" from the remaining reconciled linked txs
            await recomputeCostFromLinkedTxs(costId);
            const expanded = getExpandedCostIds();
            renderCostsTab();
            restoreExpandedCostRows(expanded);
        } catch (err) {
            alert('Unlink failed: ' + err.message);
            if (btn) { btn.textContent = 'Unlink'; btn.disabled = false; }
        }
    }

    // Recompute and write Last Reconciled * fields from the remaining linked reconciled txs
    async function recomputeCostFromLinkedTxs(costId) {
        const remaining = (allTransactions || []).filter(tx => {
            if (!getField(tx, F.txReconciled)) return false;
            const linked = getField(tx, F.txCost);
            if (!Array.isArray(linked)) return false;
            return linked.some(v => (v.id || v) === costId);
        });
        if (remaining.length === 0) {
            // No linked reconciled txs left — clear the fields
            const fields = {
                [F.costLastReconDate]: null,
                [F.costLastReconAmount]: null,
                [F.costLastReconAccount]: [],
                [F.costLastReconSubCat]: [],
            };
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}/${costId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields })
            });
            if (resp.ok) {
                const cost = (allCosts || []).find(c => c.id === costId);
                if (cost) Object.assign(cost.fields || {}, fields);
            }
            return;
        }
        const sorted = [...remaining].sort((a, b) =>
            new Date(getField(b, F.txDate) || '') - new Date(getField(a, F.txDate) || ''));
        const newest = sorted[0];
        const accIds = (getField(newest, F.txAccountLink) || []).map(v => v.id || v).filter(Boolean);
        const scIds = (getField(newest, F.txSubCategory) || []).map(v => v.id || v).filter(Boolean);
        await syncCostFromReconciledTx(
            costId,
            getField(newest, F.txDate),
            Number(getField(newest, F.txReportAmount)) || 0,
            accIds, scIds
        );
        // syncCost only writes when newer-or-equal — force the write here even if older
        // by directly PATCHing if the helper skipped:
        const cost = (allCosts || []).find(c => c.id === costId);
        if (cost && getField(cost, F.costLastReconDate) !== getField(newest, F.txDate)) {
            const fields = {
                [F.costLastReconDate]: getField(newest, F.txDate),
                [F.costLastReconAmount]: Math.abs(Number(getField(newest, F.txReportAmount)) || 0),
            };
            if (accIds.length > 0) fields[F.costLastReconAccount] = accIds.slice(0, 1);
            if (scIds.length > 0) fields[F.costLastReconSubCat] = scIds.slice(0, 1);
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}/${costId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields })
            });
            if (resp.ok) Object.assign(cost.fields || {}, fields);
        }
    }

    // ── AI Analysis ──
    function renderCostsAIAnalysis(enrichedActive, totalMonthly, catEntries) {
        const el = document.getElementById('costsAIAnalysis');
        if (!el) return;

        const insights = [];
        const sortedByExpected = [...enrichedActive].sort((a, b) => b.expected - a.expected);

        if (sortedByExpected.length > 0) {
            const top = sortedByExpected[0];
            const pct = totalMonthly > 0 ? (top.expected / totalMonthly * 100).toFixed(1) : '0.0';
            insights.push(`<div class="cost-insight"><strong>Largest cost:</strong> ${escHtml(top.name)} at ${fmt(top.expected)} ${top.frequency.toLowerCase()} (${pct}% of total)</div>`);
        }

        if (catEntries.length > 0 && totalMonthly > 0) {
            const topCatPct = (catEntries[0][1].total / totalMonthly * 100);
            if (topCatPct > 40) {
                insights.push(`<div class="cost-insight" style="border-left-color:var(--warning)"><strong>Concentration risk:</strong> "${escHtml(catEntries[0][0])}" accounts for ${topCatPct.toFixed(1)}% of all fixed costs. Consider reviewing for potential savings.</div>`);
            }
        }

        const overdueList = enrichedActive.filter(e => e.daysOverdue !== null && e.daysOverdue > 0);
        if (overdueList.length > 0) {
            insights.push(`<div class="cost-insight" style="border-left-color:var(--danger)"><strong>Overdue (${overdueList.length}):</strong> ${overdueList.map(e => `${escHtml(e.name)} (${e.daysOverdue}d)`).slice(0, 5).join(', ')}${overdueList.length > 5 ? '…' : ''}</div>`);
        }

        const hardVar = enrichedActive.filter(e => e.varianceFlag === 'hard');
        if (hardVar.length > 0) {
            insights.push(`<div class="cost-insight" style="border-left-color:var(--danger)"><strong>Hard variance (${hardVar.length}):</strong> Reconciled amount differs from expected by &gt;10%. Either rate has changed (update Expected Cost) or wrong tx was reconciled (click variance badge to review).</div>`);
        }

        // True annual exposure across mixed frequencies (monthly × 12, annual × 1, quarterly × 4, etc.)
        const trueAnnual = enrichedActive.reduce((s, e) => s + monthlyEquivalent(e.expected, e.frequency) * 12, 0);
        insights.push(`<div class="cost-insight"><strong>True annual exposure:</strong> ${fmt(trueAnnual)} (frequency-aware: monthly × 12, annual × 1, quarterly × 4, etc.)</div>`);

        const smallCosts = enrichedActive.filter(e => {
            return e.expected > 0 && e.expected < 50;
        });
        if (smallCosts.length >= 3) {
            const smallTotal = smallCosts.reduce((s, e) => s + e.expected, 0);
            insights.push(`<div class="cost-insight" style="border-left-color:var(--accent-gold)"><strong>Potential savings review:</strong> ${smallCosts.length} costs under £50 (total ${fmt(smallTotal)}). Consider auditing subscriptions and small recurring charges.</div>`);
        }

        el.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">${insights.join('')}</div>`;
    }

    // ── Backfill: one-shot script to populate Cost Status (New) + Last Reconciled * fields ──
    // Runs in dry-run mode by default; click again to commit.
    let _costsBackfillState = { plan: null };

    async function runCostsBackfillDryRun() {
        const btn = document.getElementById('costsBackfillBtn');
        const out = document.getElementById('costsBackfillOutput');
        if (!btn || !out) return;
        btn.disabled = true;
        btn.textContent = 'Running dry-run…';

        // Backfill ONLY populates the "Last Reconciled *" fields from each cost's
        // most recent reconciled transaction. Status is curated manually by Kevin
        // in the legacy Payment Status field — never touched by the dashboard.
        const plan = [];
        for (const c of (allCosts || [])) {
            const hasReconDate = !!getField(c, F.costLastReconDate);
            if (hasReconDate) continue; // already populated

            const reconciledTxs = (allTransactions || []).filter(tx => {
                if (!getField(tx, F.txReconciled)) return false;
                const linked = getField(tx, F.txCost);
                if (!Array.isArray(linked)) return false;
                return linked.some(v => (v.id || v) === c.id);
            });
            if (reconciledTxs.length === 0) continue;

            const newest = reconciledTxs.sort((a, b) =>
                new Date(getField(b, F.txDate) || '') - new Date(getField(a, F.txDate) || ''))[0];

            const writes = {
                [F.costLastReconDate]: getField(newest, F.txDate),
                [F.costLastReconAmount]: Math.abs(Number(getField(newest, F.txReportAmount)) || 0),
            };
            const accIds = (getField(newest, F.txAccountLink) || []).map(v => v.id || v).filter(Boolean);
            if (accIds.length > 0) writes[F.costLastReconAccount] = accIds.slice(0, 1);
            const scIds = (getField(newest, F.txSubCategory) || []).map(v => v.id || v).filter(Boolean);
            if (scIds.length > 0) writes[F.costLastReconSubCat] = scIds.slice(0, 1);

            plan.push({
                id: c.id,
                name: getField(c, F.costName) || '(unnamed)',
                writes,
                paymentStatus: getPaymentStatusName(getField(c, F.costPayStatus)) || '(no status)',
                reconciledCount: reconciledTxs.length,
            });
        }

        _costsBackfillState.plan = plan;

        if (plan.length === 0) {
            out.innerHTML = '<div style="color:var(--success);font-weight:600;padding:8px 0">All costs already have Last Reconciled fields populated — nothing to backfill.</div>';
            btn.disabled = false;
            btn.textContent = 'Re-run dry-run';
            return;
        }

        const renderRow = (p) => {
            const w = p.writes;
            const parts = [];
            parts.push(`Last Paid → ${formatCostDate(w[F.costLastReconDate])}`);
            parts.push(`Amount → ${fmt(w[F.costLastReconAmount])}`);
            if (w[F.costLastReconAccount]) parts.push(`Account → ${escHtml(getAccountName(w[F.costLastReconAccount][0]) || '(linked)')}`);
            if (w[F.costLastReconSubCat]) parts.push(`Sub-Cat → ${escHtml(getSubCatNameById(w[F.costLastReconSubCat][0]) || '(linked)')}`);
            return `<div style="padding:4px 0;border-bottom:1px solid var(--border-subtle);font-size:12px"><strong>${escHtml(p.name)}</strong> <span style="color:var(--text-muted)">[${escHtml(p.paymentStatus)}] · ${p.reconciledCount} reconciled tx${p.reconciledCount !== 1 ? 's' : ''}</span><br><span style="color:var(--text-secondary)">${parts.join(' · ')}</span></div>`;
        };

        const byStatus = {};
        plan.forEach(p => { (byStatus[p.paymentStatus] ||= []).push(p); });
        const sectionsHtml = Object.entries(byStatus)
            .sort((a, b) => b[1].length - a[1].length)
            .map(([status, items]) => {
                const open = (status === 'In Payment' || status === 'Overdue') ? 'open' : '';
                return `<details ${open} style="margin-bottom:12px"><summary style="cursor:pointer;padding:6px 8px;background:var(--bg-subtle);color:var(--text-secondary);border-radius:4px;font-weight:600">${escHtml(status)} — ${items.length} cost${items.length !== 1 ? 's' : ''}</summary><div style="padding:8px 0">${items.map(renderRow).join('')}</div></details>`;
            }).join('');

        const summary = `
            <div style="font-weight:600;margin-bottom:8px">Dry-run plan: ${plan.length} cost record(s) will get their Last Reconciled fields populated</div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">This backfill only writes the Last Reconciled Payment Date, Amount, Account and Sub-Category fields, sourced from each cost's most recent reconciled transaction. The Payment Status field is never touched — that stays under your control.</div>
        `;

        out.innerHTML = summary + sectionsHtml + `<div style="margin-top:12px;padding:8px;background:var(--info-bg);color:var(--info);border-radius:4px;font-size:12px">Review the rows above. If correct, click <strong>Commit Backfill</strong>.</div>`;
        btn.disabled = false;
        btn.textContent = 'Re-run dry-run';
        document.getElementById('costsCommitBtn').style.display = 'inline-block';
    }

    // ── Two-way sync: write computed fields back to Airtable ──
    // Computed values (Days Overdue, Variance Amount, Variance Flag, Expected Next Payment,
    // and the In Payment ↔ Overdue transition on Cost Status (New)) are derived from clean
    // inputs (Last Reconciled *, Frequency, Expected Cost, End Date) and synced to Airtable
    // so the database is always the source of truth.
    //
    // Strategy: only write when the computed value actually differs from the stored value
    // (avoid hammering Airtable with no-op PATCHes). Batch in groups of 10 (Airtable max).
    let _syncDerivedInFlight = false;
    async function syncDerivedCostFields() {
        if (_syncDerivedInFlight) return { skipped: true };
        _syncDerivedInFlight = true;
        try {
            const writes = [];
            for (const c of (allCosts || [])) {
                const e = enrichCost(c);
                const storedDays = getField(c, F.costDaysOverdue);
                const storedVarAmt = getField(c, F.costVarianceAmount);
                const storedVarFlag = getPaymentStatusName(getField(c, F.costVarianceFlag));
                const storedNext = getField(c, F.costExpectedNext);

                const computedNext = e.expectedNext ? toIsoDate(e.expectedNext) : null;
                const computedDays = e.daysOverdue;
                const computedVarAmt = e.varianceFlag !== 'unknown' ? +(e.varianceAmount.toFixed(2)) : null;
                const computedVarFlag = ({ match: 'Match', soft: 'Soft', hard: 'Hard', unknown: 'Unknown' })[e.varianceFlag] || 'Unknown';

                // Auto-flip Payment Status between "In Payment" and "Overdue"
                // based on whether this period has been paid yet. Paused/Inactive
                // are NEVER touched — only In Payment ↔ Overdue transitions.
                // Manual override: if Status Locked Until Recon == current Last
                // Reconciled Payment Date, the user has just overridden the status
                // and we leave it alone until a new reconciliation arrives.
                const currentStatus = getPaymentStatusName(getField(c, F.costPayStatus));
                const lockAt = getField(c, F.costStatusLockedAt);
                const lastRecon = getField(c, F.costLastReconDate);
                const isLocked = !!lockAt && !!lastRecon &&
                    new Date(lockAt).toDateString() === new Date(lastRecon).toDateString();
                let desiredStatus = currentStatus;
                if (!isLocked && (currentStatus === 'In Payment' || currentStatus === 'Overdue')) {
                    if (e.paidThisPeriod || (e.daysOverdue !== null && e.daysOverdue <= 0)) {
                        desiredStatus = 'In Payment';
                    } else if (e.daysOverdue !== null && e.daysOverdue > 0) {
                        desiredStatus = 'Overdue';
                    }
                }

                const fields = {};
                if (desiredStatus && desiredStatus !== currentStatus) {
                    fields[F.costPayStatus] = desiredStatus;
                }
                if (computedDays !== null && Number(storedDays) !== Number(computedDays)) {
                    fields[F.costDaysOverdue] = computedDays;
                }
                if (computedVarAmt != null && Number(storedVarAmt || 0).toFixed(2) !== Number(computedVarAmt).toFixed(2)) {
                    fields[F.costVarianceAmount] = computedVarAmt;
                }
                if (storedVarFlag !== computedVarFlag) {
                    fields[F.costVarianceFlag] = computedVarFlag;
                }
                if (computedNext && storedNext !== computedNext) {
                    fields[F.costExpectedNext] = computedNext;
                }

                if (Object.keys(fields).length > 0) {
                    writes.push({ id: c.id, fields });
                }
            }

            if (writes.length === 0) return { ok: true, written: 0 };

            showSyncPill(`Syncing ${writes.length} cost field${writes.length !== 1 ? 's' : ''}…`);

            let written = 0, failed = 0;
            for (let i = 0; i < writes.length; i += 10) {
                const batch = writes.slice(i, i + 10);
                try {
                    const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}`, {
                        method: 'PATCH',
                        headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ records: batch })
                    });
                    if (resp.ok) {
                        written += batch.length;
                        batch.forEach(b => {
                            const c = (allCosts || []).find(x => x.id === b.id);
                            if (c) { if (!c.fields) c.fields = {}; Object.assign(c.fields, b.fields); }
                        });
                    } else {
                        failed += batch.length;
                        const err = await resp.json().catch(() => ({}));
                        console.warn('syncDerivedCostFields batch failed', err);
                    }
                } catch (e) {
                    failed += batch.length;
                    console.warn('syncDerivedCostFields fetch error', e);
                }
                showSyncPill(`Syncing ${Math.min(i + 10, writes.length)} of ${writes.length}…`);
            }
            return { ok: failed === 0, written, failed };
        } finally {
            _syncDerivedInFlight = false;
            hideSyncPill();
        }
    }

    // ── Inline edit (Expected Cost, End Date) ──
    // Replaces the clicked span with an input. On blur/Enter: PATCH to Airtable
    // and re-render. Esc cancels. Undo toast for amend operations.
    async function editCostField(span) {
        const costId = span.dataset.costId;
        const fieldId = span.dataset.field;
        const type = span.dataset.type;
        const cost = (allCosts || []).find(c => c.id === costId);
        if (!cost) return;

        let oldValue;
        if (type === 'date') oldValue = span.dataset.raw || '';
        else if (type === 'dueday') oldValue = span.dataset.raw || '';
        else if (type === 'text') oldValue = getField(cost, fieldId) || '';
        else oldValue = Number(getField(cost, fieldId)) || '';

        const input = document.createElement('input');
        if (type === 'number') { input.type = 'number'; input.step = '0.01'; }
        else if (type === 'dueday') { input.type = 'number'; input.min = '1'; input.max = '31'; input.step = '1'; }
        else if (type === 'text') { input.type = 'text'; }
        else input.type = 'date';
        input.value = oldValue;
        input.style.cssText = `${type === 'text' ? 'width:240px' : 'width:110px'};padding:2px 4px;border:1px solid var(--accent);border-radius:3px;font-size:12px;background:var(--bg-surface);color:var(--text-primary)`;
        const parent = span.parentNode;
        parent.replaceChild(input, span);
        input.focus();
        if (type !== 'date') input.select();

        let done = false;
        const finish = async (commit) => {
            if (done) return; done = true;
            if (!commit) { renderCostsTab(); return; }
            const newRaw = input.value;
            // Due Day is a singleSelect on Airtable — write as string name ("1".."31").
            // Number → numeric value. Date → ISO or null.
            let newValue;
            if (type === 'number') newValue = newRaw === '' ? null : Number(newRaw);
            else if (type === 'dueday') {
                const n = parseInt(newRaw, 10);
                if (newRaw !== '' && (isNaN(n) || n < 1 || n > 31)) { alert('Due Day must be between 1 and 31'); renderCostsTab(); return; }
                newValue = newRaw === '' ? null : String(n);
            }
            else if (type === 'text') newValue = newRaw.trim() || null;
            else newValue = newRaw || null;
            if (String(newValue ?? '') === String(oldValue ?? '')) { renderCostsTab(); return; }

            try {
                const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}/${costId}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: { [fieldId]: newValue } })
                });
                if (!resp.ok) throw new Error('PATCH ' + resp.status);
                if (!cost.fields) cost.fields = {};
                cost.fields[fieldId] = newValue;
                const label = type === 'number' ? `Expected → ${fmt(newValue || 0)}`
                    : type === 'dueday' ? `Due Day → ${newValue || '—'}`
                    : type === 'text' ? `Cost Name → ${newValue || '—'}`
                    : `End Date → ${formatCostDate(newValue)}`;
                pushUndoAction({ kind: 'edit', costId, fieldId, oldValue, newValue, label });
                renderCostsTab();
            } catch (err) {
                alert('Save failed: ' + err.message);
                renderCostsTab();
            }
        };

        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
            else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
    }

    // ── Status override menu ──
    // Shows In Payment / Overdue / Paused / Inactive. Selecting any sets the
    // Status Locked Until Recon = current Last Reconciled Payment Date so the
    // auto-flip leaves it alone until a new reconciliation arrives.
    function openStatusMenu(badge, costId) {
        document.querySelectorAll('.cost-status-menu').forEach(m => m.remove());
        const cost = (allCosts || []).find(c => c.id === costId);
        if (!cost) return;
        const current = getPaymentStatusName(getField(cost, F.costPayStatus)) || '(unset)';

        const menu = document.createElement('div');
        menu.className = 'cost-status-menu';
        menu.style.cssText = 'position:absolute;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:6px;box-shadow:var(--shadow-md);padding:6px;z-index:1000;font-size:12px;min-width:200px';
        const opts = [
            { name: 'In Payment', color: 'var(--success)' },
            { name: 'Overdue', color: 'var(--danger)' },
            { name: 'Paused', color: 'var(--warning)' },
            { name: 'Inactive', color: 'var(--text-muted)' },
        ];
        const buttons = opts.map(o => {
            const tick = o.name === current ? '✓ ' : '&nbsp;&nbsp;';
            return `<button class="od-btn" onclick="setCostStatus('${costId}', '${o.name}')" style="display:block;width:100%;text-align:left;padding:8px;background:none;color:${o.color};font-weight:600">${tick}${o.name}</button>`;
        }).join('');
        const unlockBtn = `<button class="od-btn od-btn-sm" onclick="unlockCostStatus('${costId}')" style="display:block;width:100%;text-align:left;padding:6px 8px;background:none;color:var(--text-secondary);border-top:1px solid var(--border-subtle);margin-top:4px">↶ Clear manual override (let auto-flip resume)</button>`;
        menu.innerHTML = `<div style="padding:6px 8px;font-size:11px;color:var(--text-muted);border-bottom:1px solid var(--border-subtle);margin-bottom:4px">Override status for <strong>${escHtml(getField(cost, F.costName) || '')}</strong></div>${buttons}${unlockBtn}`;
        menu.querySelectorAll('button').forEach(b => {
            b.addEventListener('mouseenter', () => b.style.background = 'var(--bg-surface-2)');
            b.addEventListener('mouseleave', () => b.style.background = 'none');
        });
        document.body.appendChild(menu);
        const rect = badge.getBoundingClientRect();
        menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
        menu.style.left = (rect.left + window.scrollX) + 'px';
        setTimeout(() => {
            const off = (ev) => {
                if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', off); }
            };
            document.addEventListener('click', off);
        }, 0);
    }

    async function setCostStatus(costId, newStatus) {
        document.querySelectorAll('.cost-status-menu').forEach(m => m.remove());
        const cost = (allCosts || []).find(c => c.id === costId);
        if (!cost) return;
        const oldStatus = getPaymentStatusName(getField(cost, F.costPayStatus));
        const lastReconDate = getField(cost, F.costLastReconDate);
        // Lock ties to the current lastReconDate; if no payments yet, lock to today.
        const lockDate = lastReconDate || toIsoDate(new Date());
        const oldLock = getField(cost, F.costStatusLockedAt);
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}/${costId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: { [F.costPayStatus]: newStatus, [F.costStatusLockedAt]: lockDate } })
            });
            if (!resp.ok) throw new Error('PATCH ' + resp.status);
            if (!cost.fields) cost.fields = {};
            cost.fields[F.costPayStatus] = { name: newStatus };
            cost.fields[F.costStatusLockedAt] = lockDate;
            pushUndoAction({
                kind: 'status', costId,
                oldStatus, newStatus, oldLock, newLock: lockDate,
                label: `Status → ${newStatus} (locked until next payment)`
            });
            renderCostsTab();
        } catch (err) {
            alert('Status update failed: ' + err.message);
        }
    }

    // ── Drift menu ──
    // Same pattern as the variance menu, but on the Last Paid drift badge.
    // Offers a one-click "Amend Due Day to N" using the actual day-of-month
    // from the most recent reconciled payment.
    function openDriftMenu(badge, costId) {
        document.querySelectorAll('.cost-drift-menu, .cost-variance-menu, .cost-status-menu').forEach(m => m.remove());
        const cost = (allCosts || []).find(c => c.id === costId);
        if (!cost) return;
        const lastReconDate = getField(cost, F.costLastReconDate);
        if (!lastReconDate) return;
        const actualDay = new Date(lastReconDate).getDate(); // day-of-month
        const currentDueDay = Number(getField(cost, F.costDueDay)) || null;

        const menu = document.createElement('div');
        menu.className = 'cost-drift-menu';
        menu.style.cssText = 'position:absolute;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:6px;box-shadow:var(--shadow-md);padding:6px;z-index:1000;font-size:12px;min-width:260px';
        menu.innerHTML = `
            <div style="padding:6px 8px;font-size:11px;color:var(--text-secondary);border-bottom:1px solid var(--border-subtle);margin-bottom:4px">
                <strong>${escHtml(getField(cost, F.costName) || '')}</strong><br>
                Recorded Due Day: ${currentDueDay || '—'} · Actual day paid: ${actualDay}
            </div>
            <button class="drift-menu-btn od-btn" onclick="amendDueDayFromLastPaid('${costId}')" style="display:block;width:100%;text-align:left;padding:8px;background:none">📅 Amend Due Day to ${actualDay} <span style="color:var(--text-muted);font-size:10px">— payments actually land on the ${actualDay}${ordinal(actualDay)}</span></button>
            <button class="drift-menu-btn od-btn" onclick="this.parentElement.remove()" style="display:block;width:100%;text-align:left;padding:8px;background:none;color:var(--text-secondary)">Cancel</button>
        `;
        menu.querySelectorAll('.drift-menu-btn').forEach(b => {
            b.addEventListener('mouseenter', () => b.style.background = 'var(--bg-surface-2)');
            b.addEventListener('mouseleave', () => b.style.background = 'none');
        });
        document.body.appendChild(menu);
        const rect = badge.getBoundingClientRect();
        menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
        menu.style.left = (rect.left + window.scrollX) + 'px';
        setTimeout(() => {
            const off = (ev) => {
                if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', off); }
            };
            document.addEventListener('click', off);
        }, 0);
    }

    async function amendDueDayFromLastPaid(costId) {
        document.querySelectorAll('.cost-drift-menu').forEach(m => m.remove());
        const cost = (allCosts || []).find(c => c.id === costId);
        if (!cost) return;
        const lastReconDate = getField(cost, F.costLastReconDate);
        if (!lastReconDate) return;
        const actualDay = new Date(lastReconDate).getDate();
        const oldValue = String(Number(getField(cost, F.costDueDay)) || '');
        const newValue = String(actualDay);
        if (oldValue === newValue) return;
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}/${costId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: { [F.costDueDay]: newValue } })
            });
            if (!resp.ok) throw new Error('PATCH ' + resp.status);
            if (!cost.fields) cost.fields = {};
            // Store the raw value — same shape editCostField writes. Readers do
            // Number(getField(...)), which would return NaN for a { name } object.
            cost.fields[F.costDueDay] = newValue;
            pushUndoAction({ kind: 'edit', costId, fieldId: F.costDueDay, oldValue, newValue, label: `Due Day → ${newValue}` });
            renderCostsTab();
        } catch (err) {
            alert('Amend Due Day failed: ' + err.message);
        }
    }

    function ordinal(n) {
        const s = ['th', 'st', 'nd', 'rd'];
        const v = n % 100;
        return s[(v - 20) % 10] || s[v] || s[0];
    }

    async function unlockCostStatus(costId) {
        document.querySelectorAll('.cost-status-menu').forEach(m => m.remove());
        const cost = (allCosts || []).find(c => c.id === costId);
        if (!cost) return;
        const oldLock = getField(cost, F.costStatusLockedAt);
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}/${costId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: { [F.costStatusLockedAt]: null } })
            });
            if (!resp.ok) throw new Error('PATCH ' + resp.status);
            cost.fields[F.costStatusLockedAt] = null;
            pushUndoAction({ kind: 'status-unlock', costId, oldLock, newLock: null, label: 'Manual status override cleared' });
            renderCostsTab();
        } catch (err) {
            alert('Unlock failed: ' + err.message);
        }
    }

    // ── Variance actions menu ──
    function openVarianceMenu(badge, costId) {
        // Remove any open menu first
        document.querySelectorAll('.cost-variance-menu').forEach(m => m.remove());
        const cost = (allCosts || []).find(c => c.id === costId);
        if (!cost) return;
        const e = enrichCost(cost);

        const menu = document.createElement('div');
        menu.className = 'cost-variance-menu';
        menu.style.cssText = 'position:absolute;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:6px;box-shadow:var(--shadow-md);padding:6px;z-index:1000;font-size:12px;min-width:240px';
        menu.innerHTML = `
            <div style="padding:6px 8px;font-size:11px;color:var(--text-secondary);border-bottom:1px solid var(--border-subtle);margin-bottom:4px">
                <strong>${escHtml(e.name)}</strong><br>
                Expected ${fmt(e.expected)} · Last paid ${fmt(e.lastReconAmount)} · Diff ${e.varianceAmount >= 0 ? '+' : '−'}${fmt(Math.abs(e.varianceAmount))} (${(e.variancePct*100).toFixed(1)}%)
            </div>
            <button class="var-menu-btn od-btn" onclick="amendExpectedCost('${costId}')" style="display:block;width:100%;text-align:left;padding:8px;background:none">📝 Amend Expected to ${fmt(e.lastReconAmount)} <span style="color:var(--text-muted);font-size:10px">— rate has actually changed</span></button>
            <button class="var-menu-btn od-btn" onclick="dismissCostVariance('${costId}')" style="display:block;width:100%;text-align:left;padding:8px;background:none">🚫 Dismiss this variance <span style="color:var(--text-muted);font-size:10px">— bulk payment / one-off explained</span></button>
            <button class="var-menu-btn od-btn" onclick="this.parentElement.remove()" style="display:block;width:100%;text-align:left;padding:8px;background:none;color:var(--text-secondary)">Cancel</button>
        `;
        // Hover effect via inline JS (cleaner than adding CSS class)
        menu.querySelectorAll('.var-menu-btn').forEach(b => {
            b.addEventListener('mouseenter', () => b.style.background = 'var(--bg-surface-2)');
            b.addEventListener('mouseleave', () => b.style.background = 'none');
        });
        document.body.appendChild(menu);
        const rect = badge.getBoundingClientRect();
        menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
        menu.style.left = (rect.left + window.scrollX) + 'px';
        // Dismiss on outside click
        setTimeout(() => {
            const off = (ev) => {
                if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', off); }
            };
            document.addEventListener('click', off);
        }, 0);
    }

    async function amendExpectedCost(costId) {
        document.querySelectorAll('.cost-variance-menu').forEach(m => m.remove());
        const cost = (allCosts || []).find(c => c.id === costId);
        if (!cost) return;
        const newAmount = Number(getField(cost, F.costLastReconAmount));
        if (!newAmount) { alert('No reconciled amount to copy from'); return; }
        const oldExpected = Number(getField(cost, F.costExpected)) || 0;
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}/${costId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: { [F.costExpected]: newAmount } })
            });
            if (!resp.ok) throw new Error('PATCH ' + resp.status);
            cost.fields[F.costExpected] = newAmount;
            pushUndoAction({ kind: 'amend', costId, oldValue: oldExpected, newValue: newAmount, label: `Expected updated to ${fmt(newAmount)}` });
            renderCostsTab();
        } catch (err) {
            alert('Amend failed: ' + err.message);
        }
    }

    async function dismissCostVariance(costId) {
        document.querySelectorAll('.cost-variance-menu').forEach(m => m.remove());
        const cost = (allCosts || []).find(c => c.id === costId);
        if (!cost) return;
        const lastReconDate = getField(cost, F.costLastReconDate);
        if (!lastReconDate) return;
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}/${costId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: { [F.costVarianceDismissedAt]: lastReconDate } })
            });
            if (!resp.ok) throw new Error('PATCH ' + resp.status);
            cost.fields[F.costVarianceDismissedAt] = lastReconDate;
            pushUndoAction({ kind: 'dismiss', costId, oldValue: null, newValue: lastReconDate, label: `Variance dismissed for ${getField(cost, F.costName)}` });
            renderCostsTab();
        } catch (err) {
            alert('Dismiss failed: ' + err.message);
        }
    }

    async function undismissCostVariance(costId) {
        const cost = (allCosts || []).find(c => c.id === costId);
        if (!cost) return;
        const oldDismissed = getField(cost, F.costVarianceDismissedAt);
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}/${costId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: { [F.costVarianceDismissedAt]: null } })
            });
            if (!resp.ok) throw new Error('PATCH ' + resp.status);
            cost.fields[F.costVarianceDismissedAt] = null;
            pushUndoAction({ kind: 'undismiss', costId, oldValue: oldDismissed, newValue: null, label: `Variance dismissal cleared` });
            renderCostsTab();
        } catch (err) {
            alert('Undismiss failed: ' + err.message);
        }
    }

    // ── Undo system ──
    // Sliding toast with Undo button. Last action only — keep it simple.
    let _undoTimer = null;
    function pushUndoAction(action) {
        const existing = document.getElementById('costsUndoToast');
        if (existing) existing.remove();
        if (_undoTimer) clearTimeout(_undoTimer);

        const toast = document.createElement('div');
        toast.id = 'costsUndoToast';
        toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--bg-sidebar);color:var(--text-inverse);padding:10px 14px;border-radius:8px;box-shadow:var(--shadow-lg);font-size:13px;z-index:2000;display:flex;align-items:center;gap:12px;max-width:400px';
        toast.innerHTML = `
            <span>${escHtml(action.label)}</span>
            <button class="od-btn od-btn-sm" onclick="performUndo()" style="background:var(--accent-gold);color:var(--bg-sidebar);font-weight:600">Undo</button>
        `;
        document.body.appendChild(toast);
        window._lastCostUndo = action;
        _undoTimer = setTimeout(() => { toast.remove(); window._lastCostUndo = null; }, 8000);
    }

    async function performUndo() {
        const action = window._lastCostUndo;
        if (!action) return;
        const toast = document.getElementById('costsUndoToast');
        if (toast) toast.remove();
        if (_undoTimer) clearTimeout(_undoTimer);
        window._lastCostUndo = null;
        const cost = (allCosts || []).find(c => c.id === action.costId);
        if (!cost) return;

        // Status undo restores both the status name AND the lock anchor
        // (so the auto-flip behaviour matches the pre-action state).
        try {
            // Tx-link undo writes back to the Transactions table, not Costs.
            if (action.kind === 'tx-link') {
                const tx = (allTransactions || []).find(t => t.id === action.txId);
                const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${action.txId}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: { [action.fieldId]: action.oldValue || [] } })
                });
                if (!resp.ok) throw new Error('PATCH ' + resp.status);
                if (tx) { if (!tx.fields) tx.fields = {}; tx.fields[action.fieldId] = action.oldValue || []; }
                renderCostsTab();
                return;
            }
            let fields;
            if (action.kind === 'status') {
                fields = { [F.costPayStatus]: action.oldStatus || null, [F.costStatusLockedAt]: action.oldLock || null };
            } else if (action.kind === 'status-unlock') {
                fields = { [F.costStatusLockedAt]: action.oldLock || null };
            } else {
                const fieldId = action.kind === 'amend' ? F.costExpected
                    : (action.kind === 'dismiss' || action.kind === 'undismiss') ? F.costVarianceDismissedAt
                    : action.fieldId;
                fields = { [fieldId]: action.oldValue };
            }
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}/${action.costId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields })
            });
            if (!resp.ok) throw new Error('PATCH ' + resp.status);
            if (!cost.fields) cost.fields = {};
            Object.entries(fields).forEach(([k, v]) => {
                cost.fields[k] = (k === F.costPayStatus && v) ? { name: v } : v;
            });
            renderCostsTab();
        } catch (err) {
            alert('Undo failed: ' + err.message);
        }
    }

    function toIsoDate(d) {
        if (!d) return null;
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    async function commitCostsBackfill() {
        const plan = _costsBackfillState.plan;
        if (!plan || plan.length === 0) { alert('No plan loaded — run dry-run first'); return; }
        if (!confirm(`Commit backfill for ${plan.length} cost(s)? This writes to Airtable.`)) return;
        const btn = document.getElementById('costsCommitBtn');
        const out = document.getElementById('costsBackfillOutput');
        btn.disabled = true;
        btn.textContent = 'Committing…';

        let ok = 0, fail = 0;
        const errors = [];
        const batches = [];
        for (let i = 0; i < plan.length; i += 10) batches.push(plan.slice(i, i + 10));
        for (const batch of batches) {
            const records = batch.map(p => ({ id: p.id, fields: p.writes }));
            try {
                const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.costs}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ records })
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    fail += batch.length;
                    errors.push(err.error?.message || resp.status);
                } else {
                    ok += batch.length;
                    // Update local state
                    batch.forEach(p => {
                        const c = (allCosts || []).find(x => x.id === p.id);
                        if (c) {
                            if (!c.fields) c.fields = {};
                            Object.assign(c.fields, p.writes);
                        }
                    });
                }
            } catch (e) {
                fail += batch.length;
                errors.push(e.message);
            }
        }

        out.innerHTML = `<div style="color:${fail === 0 ? 'var(--success)' : 'var(--warning)'};font-weight:600;padding:8px 0">Backfill complete: ${ok} succeeded, ${fail} failed${errors.length > 0 ? '<br>Errors: ' + escHtml(errors.slice(0, 3).join('; ')) : ''}</div>`;
        btn.textContent = 'Commit Backfill';
        btn.disabled = false;
        _costsBackfillState.plan = null;
        renderCostsTab();
    }

    // ══════════════════════════════════════════
    // PRINT STATEMENT — per-cost payment ledger
    // ══════════════════════════════════════════

    function costOpenPrintStatement(costId) {
        const cost = (allCosts || []).find(c => c.id === costId);
        if (!cost) return;
        const e = enrichCost(cost);

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:center;justify-content:center';
        const panel = document.createElement('div');
        panel.style.cssText = 'background:var(--bg-surface);border-radius:var(--radius-lg);padding:24px;max-width:440px;width:90%;box-shadow:var(--shadow-lg)';

        const today = new Date();
        const defaultStart = '2025-04-01';
        const defaultEnd = today.toISOString().slice(0, 10);

        panel.innerHTML = `
            <div style="font-weight:600;font-size:15px;margin-bottom:4px">Generate Cost Statement</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:16px">${escHtml(e.name)} · ${escHtml(e.frequency)} · Expected: ${fmt(e.expected)}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
                <div>
                    <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">Start date</label>
                    <input id="costStmtStart" type="date" value="${defaultStart}" style="width:100%;padding:6px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:13px;box-sizing:border-box">
                </div>
                <div>
                    <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">End date</label>
                    <input id="costStmtEnd" type="date" value="${defaultEnd}" style="width:100%;padding:6px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:13px;box-sizing:border-box">
                </div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
                <button id="costStmtCancel" class="od-btn od-btn-secondary">Cancel</button>
                <button id="costStmtGenerate" class="od-btn od-btn-primary">Generate</button>
            </div>
        `;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', ev => { if (ev.target === overlay) overlay.remove(); });
        panel.querySelector('#costStmtCancel').addEventListener('click', () => overlay.remove());
        panel.querySelector('#costStmtGenerate').addEventListener('click', () => {
            const startDate = new Date(panel.querySelector('#costStmtStart').value);
            const endDate = new Date(panel.querySelector('#costStmtEnd').value);
            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) { alert('Select valid dates'); return; }
            overlay.remove();
            costGeneratePrintStatement(e, startDate, endDate);
        });
    }
    window.costOpenPrintStatement = costOpenPrintStatement;

    function costGeneratePrintStatement(e, startDate, endDate) {
        const txs = (allTransactions || []).filter(tx => {
            const linked = getField(tx, F.txCost);
            if (!Array.isArray(linked)) return false;
            if (!linked.some(v => (v.id || v) === e.id)) return false;
            const dateStr = String(getField(tx, F.txDate) || '');
            const txDate = dateStr ? new Date(dateStr) : null;
            if (!txDate || isNaN(txDate)) return false;
            return txDate >= startDate && txDate <= endDate;
        });

        txs.sort((a, b) => new Date(getField(a, F.txDate) || '') - new Date(getField(b, F.txDate) || ''));

        let runningTotal = 0;
        const ledgerRows = txs.map(tx => {
            const amount = Math.abs(Number(getField(tx, F.txReportAmount)) || 0);
            runningTotal += amount;
            const date = String(getField(tx, F.txDate) || '').slice(0, 10);
            const desc = txLabel(tx);
            const account = String(getField(tx, F.txAccountAlias) || '');
            const reconciled = getField(tx, F.txReconciled);
            return { date, desc, account, amount, runningTotal, reconciled };
        });

        const totalPaid = runningTotal;
        const paymentCount = txs.length;

        const monthsBetween = ((endDate.getFullYear() - startDate.getFullYear()) * 12) + (endDate.getMonth() - startDate.getMonth()) + 1;
        let totalExpected = 0;
        const freq = (e.frequency || '').toLowerCase();
        if (freq === 'monthly') totalExpected = e.expected * monthsBetween;
        else if (freq === 'quarterly') totalExpected = e.expected * Math.ceil(monthsBetween / 3);
        else if (freq === 'annually' || freq === 'annual') totalExpected = e.expected * Math.ceil(monthsBetween / 12);
        else if (freq === 'weekly') totalExpected = e.expected * Math.round(monthsBetween * 4.33);
        else if (freq === 'fortnightly') totalExpected = e.expected * Math.round(monthsBetween * 2.17);
        else if (freq === '4-weekly') totalExpected = e.expected * Math.round(monthsBetween * (13 / 12));
        else totalExpected = e.expected * monthsBetween;

        const variance = totalPaid - totalExpected;

        const fmtDateStr = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

        const statusLabel = e.status || 'Unknown';
        const dueDayLabel = e.dueDay ? `Day ${e.dueDay} of each ${freq === 'monthly' ? 'month' : 'period'}` : 'Not set';

        const printWin = window.open('', '_blank', 'width=800,height=900');
        if (!printWin) {
            showToast('Pop-up blocked — allow pop-ups to print', { type: 'error' });
            return;
        }
        // Hex values below are intentional — tokens.css does not load in the popup,
        // so the token values are inlined directly.
        printWin.document.write(`<!DOCTYPE html><html><head><title>Cost Statement — ${escHtml(e.name)}</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
            * { margin:0; padding:0; box-sizing:border-box; }
            body { font-family:'Inter',sans-serif; color:#1C2422; padding:40px; font-size:12px; line-height:1.5; }
            h1 { font-size:20px; margin-bottom:4px; }
            .meta { color:#5A6660; font-size:12px; margin-bottom:24px; }
            .summary-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:24px; }
            .summary-box { border:1px solid #DDE1D9; border-radius:8px; padding:12px; }
            .summary-box .label { font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#5A6660; font-weight:600; }
            .summary-box .value { font-size:16px; font-weight:700; margin-top:4px; }
            table { width:100%; border-collapse:collapse; margin-bottom:24px; }
            th { text-align:left; padding:6px 8px; font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#5A6660; font-weight:600; border-bottom:2px solid #DDE1D9; }
            td { padding:6px 8px; border-bottom:1px solid #E5E8E1; font-size:11px; }
            .text-right { text-align:right; }
            .text-danger { color:#A33B3B; }
            .text-success { color:#2C6E49; }
            .footer { margin-top:32px; font-size:10px; color:#8A928C; border-top:1px solid #E5E8E1; padding-top:12px; }
            @media print { body { padding:20px; } .no-print { display:none; } }
        </style></head><body>
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
            <div>
                <h1>Cost Statement</h1>
                <div class="meta">${fmtDateStr(startDate)} to ${fmtDateStr(endDate)}</div>
            </div>
            <button class="no-print" onclick="window.print()" style="background:#2C6E49;color:#FBFBF9;border:1px solid #2C6E49;border-radius:8px;padding:10px 18px;font-size:13px;font-weight:600;font-family:'Inter',sans-serif;cursor:pointer">Print</button>
        </div>
        <div class="summary-grid">
            <div class="summary-box"><div class="label">Cost Name</div><div class="value">${escHtml(e.name)}</div></div>
            <div class="summary-box"><div class="label">Status</div><div class="value">${escHtml(statusLabel)}</div></div>
            <div class="summary-box"><div class="label">Expected per payment</div><div class="value">${fmt(e.expected)}</div></div>
            <div class="summary-box"><div class="label">Frequency</div><div class="value">${escHtml(e.frequency || 'Unknown')}</div></div>
            <div class="summary-box"><div class="label">Due Day</div><div class="value">${escHtml(dueDayLabel)}</div></div>
            <div class="summary-box"><div class="label">Payments in period</div><div class="value">${paymentCount}</div></div>
            <div class="summary-box"><div class="label">Total expected</div><div class="value">${fmt(totalExpected)}</div></div>
            <div class="summary-box"><div class="label">Total paid</div><div class="value">${fmt(totalPaid)}</div></div>
        </div>
        ${totalExpected > 0 ? `<div style="margin-bottom:24px;padding:12px;border:1px solid ${Math.abs(variance) < 0.01 ? '#DDE1D9' : (variance > 0 ? '#A33B3B' : '#2C6E49')};border-radius:8px;display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:12px;font-weight:600">Variance</span>
            <span style="font-size:16px;font-weight:700;color:${Math.abs(variance) < 0.01 ? '#1C2422' : (variance > 0 ? '#A33B3B' : '#2C6E49')}">${variance > 0 ? '+' : variance < 0 ? '-' : ''}${fmt(Math.abs(variance))}</span>
        </div>` : ''}
        <table>
            <thead><tr><th>Date</th><th>Description</th><th>Account</th><th class="text-right">Amount</th><th class="text-right">Running Total</th></tr></thead>
            <tbody>${ledgerRows.length > 0 ? ledgerRows.map(r => `<tr>
                <td>${escHtml(r.date)}</td>
                <td>${escHtml(r.desc)}</td>
                <td style="color:#5A6660">${escHtml(r.account)}</td>
                <td class="text-right" style="font-weight:500">${fmt(r.amount)}</td>
                <td class="text-right" style="font-weight:600">${fmt(r.runningTotal)}</td>
            </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;color:#8A928C;padding:24px">No payments found in this date range</td></tr>'}</tbody>
        </table>
        <div class="footer">
            Generated ${new Date().toLocaleDateString('en-GB', { day:'numeric',month:'long',year:'numeric' })} at ${new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}.
            ${escHtml(e.name)}: ${escHtml(e.frequency || '')} cost, expected ${fmt(e.expected)} per payment.
            ${paymentCount} payment${paymentCount !== 1 ? 's' : ''} totalling ${fmt(totalPaid)} in this period.
        </div>
        </body></html>`);
        printWin.document.close();
    }
    window.costGeneratePrintStatement = costGeneratePrintStatement;
