// ══════════════════════════════════════════
// COSTS TAB — Accounts Payable Fixed
// Reads from the clean "Last Reconciled *" fields owned by the dashboard
// (written by the reconciliation flow + one-off backfill button).
// ══════════════════════════════════════════
    let costsTabRendered = false;

    const SUBCAT_NAME_FIELD = 'fldO4BTJhFv5EsN6i';

    // Match thresholds for variance check (Last Reconciled Amount vs Expected Cost)
    const VAR_TOL_ABS = 1;     // £1 absolute
    const VAR_TOL_PCT = 0.02;  // 2% relative
    const VAR_HARD_PCT = 0.10; // > 10% = red

    function renderCostsTab() {
        costsTabRendered = true;
        const costs = (allCosts || []);
        const activeCosts = costs.filter(r => isCostActive(r));
        const inactiveCosts = costs.filter(r => !isCostActive(r));

        const panel = document.getElementById('tab-costs');
        if (!panel) return;

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

        // Summary calculations on active set
        const enrichedActive = activeCosts.map(r => enrichCost(r));
        const totalMonthly = enrichedActive.reduce((s, e) => s + monthlyEquivalent(e.expected, e.frequency), 0);
        const overdueCosts = enrichedActive.filter(e => e.daysOverdue !== null && e.daysOverdue > 0);
        const varianceCosts = enrichedActive.filter(e => e.varianceFlag !== 'match' && e.lastReconAmount != null);
        const hardVarianceCount = enrichedActive.filter(e => e.varianceFlag === 'hard').length;

        // Group by sub-category
        const byCat = {};
        enrichedActive.forEach(e => {
            const cat = e.subCatName || 'Uncategorised';
            if (!byCat[cat]) byCat[cat] = { total: 0, count: 0 };
            byCat[cat].total += monthlyEquivalent(e.expected, e.frequency);
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
                    <div class="kpi-card-label">Monthly Equivalent</div>
                    <div class="kpi-card-value text-red">${fmt(totalMonthly)}</div>
                    <div class="kpi-card-sub">All frequencies normalised to monthly</div>
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
            tableBodyEl.innerHTML = sorted.map((e, idx) => renderCostRow(e, idx)).join('');
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
                    { name: 'Status field migrated', kind: 'sync', run: () => {
                        const migrated = activeCosts.filter(r => getPaymentStatusName(getField(r, F.costStatusNew))).length;
                        const total = activeCosts.length;
                        if (total === 0) return { status: 'pass', detail: 'No active costs' };
                        if (migrated === 0) return { status: 'warn', detail: `Cost Status (New) is empty for all ${total} active costs — run backfill` };
                        if (migrated < total) return { status: 'warn', detail: `${total - migrated}/${total} active costs missing Cost Status (New) — re-run backfill` };
                        return { status: 'pass', detail: `${migrated}/${total} active costs migrated to Cost Status (New)` };
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
        const status = getPaymentStatusName(getField(r, F.costStatusNew)) || (isCostActive(r) ? 'In Payment' : 'Inactive');
        const inactive = !!getField(r, F.costInactive) || status === 'Inactive';

        // Compute expected next payment date and days overdue, client-side
        const expectedNext = computeExpectedNextPayment(lastReconDate, dueDay, frequency);
        const today = new Date(); today.setHours(0,0,0,0);
        const daysOverdue = expectedNext ? Math.floor((today.getTime() - expectedNext.getTime()) / 86400000) : null;

        // Variance against expected
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

        return {
            id: r.id,
            raw: r,
            name: getField(r, F.costName) || '',
            expected, frequency, dueDay, endDate,
            lastReconDate, lastReconAmount: lastReconAmountNum,
            lastReconAccountIds, lastReconSubCatIds, accountName, subCatName,
            status, inactive,
            expectedNext, daysOverdue,
            varianceFlag, varianceAmount, variancePct,
        };
    }

    function renderCostRow(e, idx) {
        const dueDayStr = e.dueDay ? `Day ${e.dueDay}` : '—';
        const endDateStr = e.endDate ? formatCostDate(e.endDate) : '—';
        const lastPaidStr = e.lastReconDate ? formatCostDate(e.lastReconDate) : '<span style="color:var(--text-muted)">—</span>';
        const lastAmtStr = e.lastReconAmount != null ? fmt(e.lastReconAmount) : '<span style="color:var(--text-muted)">—</span>';
        const accountStr = e.accountName ? escHtml(e.accountName) : '<span style="color:var(--text-muted)">—</span>';
        const subCatStr = e.subCatName ? escHtml(e.subCatName) : '<span style="color:var(--text-muted)">—</span>';

        // Status badge
        const statusClass = e.status === 'Overdue' ? 'overdue' : e.status === 'Inactive' ? 'estimate' : 'in-payment';
        const statusBadge = `<span class="inv-badge ${statusClass}">${escHtml(e.status)}</span>`;

        // Days overdue
        let overdueCell = '<span style="color:var(--text-muted)">—</span>';
        if (e.daysOverdue !== null && !e.inactive) {
            if (e.daysOverdue > 0) {
                overdueCell = `<span style="color:var(--danger);font-weight:600">${e.daysOverdue}d overdue</span>`;
            } else if (e.daysOverdue === 0) {
                overdueCell = `<span style="color:var(--warning);font-weight:600">Due today</span>`;
            } else {
                overdueCell = `<span style="color:var(--text-muted)">in ${Math.abs(e.daysOverdue)}d</span>`;
            }
        }

        // Variance badge
        let varianceBadge = '';
        if (e.varianceFlag === 'match') {
            varianceBadge = '<span style="color:var(--success);font-size:11px" title="Reconciled amount matches expected">✓</span>';
        } else if (e.varianceFlag === 'soft') {
            const sign = e.varianceAmount >= 0 ? '+' : '−';
            varianceBadge = `<span class="inv-badge" style="background:var(--warning-bg);color:var(--warning);cursor:pointer" title="Soft variance ${(e.variancePct*100).toFixed(1)}% — possible rate change" onclick="event.stopPropagation(); toggleCostTxRow(this, '${e.id}')">${sign}${fmt(Math.abs(e.varianceAmount))}</span>`;
        } else if (e.varianceFlag === 'hard') {
            const sign = e.varianceAmount >= 0 ? '+' : '−';
            varianceBadge = `<span class="inv-badge" style="background:var(--danger-bg);color:var(--danger);cursor:pointer" title="Hard variance ${(e.variancePct*100).toFixed(1)}% — review reconciliation" onclick="event.stopPropagation(); toggleCostTxRow(this, '${e.id}')">${sign}${fmt(Math.abs(e.varianceAmount))} ⚠</span>`;
        }

        return `<tr data-record-id="${e.id}" class="${e.inactive ? 'cost-inactive-row' : ''}">
            <td style="text-align:center;color:var(--text-muted);font-size:11px;font-weight:600">${idx + 1}</td>
            <td style="font-weight:600;max-width:200px">${escHtml(e.name)}</td>
            <td style="text-align:right;white-space:nowrap;font-weight:600">${fmt(e.expected)}</td>
            <td style="text-align:right;white-space:nowrap">${lastAmtStr} ${varianceBadge}</td>
            <td style="white-space:nowrap;color:var(--text-secondary)">${escHtml(dueDayStr)}</td>
            <td style="white-space:nowrap">${lastPaidStr}</td>
            <td style="white-space:nowrap">${overdueCell}</td>
            <td style="white-space:nowrap">${statusBadge}</td>
            <td style="font-size:12px;color:var(--text-secondary)">${escHtml(e.frequency)}</td>
            <td style="font-size:12px;color:var(--text-secondary)">${accountStr}</td>
            <td style="font-size:12px;color:var(--text-secondary);max-width:140px">${subCatStr}</td>
            <td style="white-space:nowrap;font-size:11px;color:var(--text-muted)">${endDateStr}</td>
            <td style="width:40px;text-align:center">
                <button onclick="event.stopPropagation(); toggleCostTxRow(this, '${e.id}')" title="Show linked transactions" style="background:none;border:1px solid var(--border-default);border-radius:4px;cursor:pointer;padding:2px 6px;font-size:11px;color:var(--text-secondary)">▶</button>
            </td>
        </tr>
        <tr class="cost-tx-detail-row" id="cost-tx-${e.id}" style="display:none">
            <td colspan="13" style="padding:8px 16px;background:var(--bg-surface-2);border-left:3px solid var(--accent)">
                ${buildLinkedTransactionsHtml(e)}
            </td>
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
        // Try common name fields — Airtable returns by field ID. Look for any short string field.
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

    // Compute the expected next payment date given last reconciled date + frequency
    function computeExpectedNextPayment(lastReconDate, dueDay, frequency) {
        const today = new Date(); today.setHours(0,0,0,0);
        if (lastReconDate) {
            const last = new Date(lastReconDate);
            last.setHours(0,0,0,0);
            return addFrequency(last, frequency);
        }
        // Never reconciled — fall back to upcoming due day this month or next
        if (!dueDay) return null;
        const thisMonth = new Date(today.getFullYear(), today.getMonth(), dueDay);
        if (thisMonth >= today) return thisMonth;
        return new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
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

    function buildLinkedTransactionsHtml(e) {
        const txs = (allTransactions || []).filter(tx => {
            const linked = getField(tx, F.txCost);
            if (!Array.isArray(linked)) return false;
            return linked.some(v => (v.id || v) === e.id);
        });

        if (txs.length === 0) {
            return '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No linked transactions found</div>';
        }

        const txSorted = [...txs].sort((a, b) => {
            const da = new Date(getField(a, F.txDate) || ''); const db = new Date(getField(b, F.txDate) || '');
            return db - da;
        });

        const rows = txSorted.slice(0, 20).map(tx => {
            const date = getField(tx, F.txDate) || '';
            const amount = Number(getField(tx, F.txReportAmount)) || 0;
            const label = txLabel(tx);
            const account = getField(tx, F.txAccountAlias) || '';
            const reconciled = getField(tx, F.txReconciled);
            const reconBadge = reconciled
                ? '<span style="color:var(--success);font-size:10px;font-weight:600">✓ Reconciled</span>'
                : '<span style="color:var(--text-muted);font-size:10px">Unreconciled</span>';
            const unlinkBtn = reconciled
                ? `<button onclick="event.stopPropagation(); unlinkTxFromCost('${tx.id}', '${e.id}', this)" title="Unlink — wrong reconciliation" style="background:none;border:1px solid var(--border-default);border-radius:3px;cursor:pointer;padding:1px 6px;font-size:10px;color:var(--danger)">Unlink</button>`
                : '';
            return `<div style="display:grid;grid-template-columns:90px 1fr 90px 90px 90px 70px;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-subtle);font-size:12px;align-items:center">
                <span style="color:var(--text-secondary)">${escHtml(formatCostDate(date))}</span>
                <span style="color:var(--text-primary);font-weight:500">${escHtml(label)}</span>
                <span style="text-align:right;font-weight:600;color:${amount < 0 ? 'var(--danger)' : 'var(--text-primary)'}">${fmt(Math.abs(amount))}</span>
                <span style="color:var(--text-muted)">${escHtml(account)}</span>
                <span>${reconBadge}</span>
                <span style="text-align:right">${unlinkBtn}</span>
            </div>`;
        }).join('');

        const totalLinked = txSorted.reduce((s, tx) => s + Math.abs(Number(getField(tx, F.txReportAmount)) || 0), 0);

        return `<div style="margin-bottom:4px;font-size:11px;font-weight:600;color:var(--text-secondary)">${txSorted.length} linked transaction${txSorted.length !== 1 ? 's' : ''} · Total: ${fmt(totalLinked)}</div>
            <div style="display:grid;grid-template-columns:90px 1fr 90px 90px 90px 70px;gap:8px;padding:4px 0;font-size:10px;text-transform:uppercase;color:var(--text-muted);font-weight:600">
                <span>Date</span><span>Description</span><span style="text-align:right">Amount</span><span>Account</span><span>Status</span><span></span>
            </div>
            ${rows}
            ${txSorted.length > 20 ? `<div style="font-size:11px;color:var(--text-muted);padding:4px 0">Showing 20 of ${txSorted.length} — use Transactions tab for full list</div>` : ''}`;
    }

    function toggleCostTxRow(btn, costId) {
        const row = document.getElementById('cost-tx-' + costId);
        if (!row) return;
        const visible = row.style.display !== 'none';
        row.style.display = visible ? 'none' : '';
        if (btn.textContent === '▶') btn.textContent = '▼';
        else if (btn.textContent === '▼') btn.textContent = '▶';
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
            renderCostsTab();
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
            const monthly = monthlyEquivalent(top.expected, top.frequency);
            const pct = totalMonthly > 0 ? (monthly / totalMonthly * 100).toFixed(1) : '0.0';
            insights.push(`<div class="cost-insight"><strong>Largest cost:</strong> ${escHtml(top.name)} at ${fmt(top.expected)} ${top.frequency.toLowerCase()} (${fmt(monthly)}/mo, ${pct}% of total)</div>`);
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

        const annual = totalMonthly * 12;
        insights.push(`<div class="cost-insight"><strong>Annualised fixed costs:</strong> ${fmt(annual)} based on monthly equivalent of ${fmt(totalMonthly)}</div>`);

        const smallCosts = enrichedActive.filter(e => {
            const m = monthlyEquivalent(e.expected, e.frequency);
            return m > 0 && m < 50;
        });
        if (smallCosts.length >= 3) {
            const smallTotal = smallCosts.reduce((s, e) => s + monthlyEquivalent(e.expected, e.frequency), 0);
            insights.push(`<div class="cost-insight" style="border-left-color:var(--accent-gold)"><strong>Potential savings review:</strong> ${smallCosts.length} costs under £50/mo (total ${fmt(smallTotal)}/mo). Consider auditing subscriptions and small recurring charges.</div>`);
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

        const plan = [];
        for (const c of (allCosts || [])) {
            const inactive = !!getField(c, F.costInactive);
            const hasNewStatus = !!getPaymentStatusName(getField(c, F.costStatusNew));
            const hasReconDate = !!getField(c, F.costLastReconDate);

            // Find most recent reconciled tx linked to this cost
            const txs = (allTransactions || []).filter(tx => {
                if (!getField(tx, F.txReconciled)) return false;
                const linked = getField(tx, F.txCost);
                if (!Array.isArray(linked)) return false;
                return linked.some(v => (v.id || v) === c.id);
            });
            const newest = txs.length > 0 ? txs.sort((a, b) =>
                new Date(getField(b, F.txDate) || '') - new Date(getField(a, F.txDate) || ''))[0] : null;

            const writes = {};
            if (!hasNewStatus) writes[F.costStatusNew] = inactive ? 'Inactive' : 'In Payment';
            if (newest && !hasReconDate) {
                writes[F.costLastReconDate] = getField(newest, F.txDate);
                writes[F.costLastReconAmount] = Math.abs(Number(getField(newest, F.txReportAmount)) || 0);
                const accIds = (getField(newest, F.txAccountLink) || []).map(v => v.id || v).filter(Boolean);
                if (accIds.length > 0) writes[F.costLastReconAccount] = accIds.slice(0, 1);
                const scIds = (getField(newest, F.txSubCategory) || []).map(v => v.id || v).filter(Boolean);
                if (scIds.length > 0) writes[F.costLastReconSubCat] = scIds.slice(0, 1);
            }

            if (Object.keys(writes).length > 0) {
                plan.push({ id: c.id, name: getField(c, F.costName) || '(unnamed)', writes, txCount: txs.length });
            }
        }

        _costsBackfillState.plan = plan;

        if (plan.length === 0) {
            out.innerHTML = '<div style="color:var(--success);font-weight:600;padding:8px 0">All costs are already up to date — nothing to backfill.</div>';
            btn.disabled = false;
            btn.textContent = 'Re-run dry-run';
            return;
        }

        const summary = `<div style="font-weight:600;margin-bottom:8px">Dry-run plan: ${plan.length} cost record(s) will be updated</div>`;
        const lines = plan.slice(0, 50).map(p => {
            const w = p.writes;
            const parts = [];
            if (w[F.costStatusNew]) parts.push(`Status → ${w[F.costStatusNew]}`);
            if (w[F.costLastReconDate]) parts.push(`Last Paid → ${formatCostDate(w[F.costLastReconDate])}`);
            if (w[F.costLastReconAmount] != null) parts.push(`Amount → ${fmt(w[F.costLastReconAmount])}`);
            if (w[F.costLastReconAccount]) parts.push(`Account → ${getAccountName(w[F.costLastReconAccount][0]) || '(linked)'}`);
            if (w[F.costLastReconSubCat]) parts.push(`Sub-Cat → ${getSubCatNameById(w[F.costLastReconSubCat][0]) || '(linked)'}`);
            return `<div style="padding:4px 0;border-bottom:1px solid var(--border-subtle);font-size:12px"><strong>${escHtml(p.name)}</strong> <span style="color:var(--text-muted)">(${p.txCount} reconciled txs)</span><br><span style="color:var(--text-secondary)">${parts.join(' · ')}</span></div>`;
        }).join('');
        const more = plan.length > 50 ? `<div style="color:var(--text-muted);font-size:11px;padding:4px 0">…and ${plan.length - 50} more</div>` : '';
        out.innerHTML = summary + lines + more + `<div style="margin-top:12px;padding:8px;background:var(--info-bg);color:var(--info);border-radius:4px;font-size:12px">Review the plan above. If correct, click <strong>Commit Backfill</strong>. To re-generate the plan, click <strong>Re-run dry-run</strong>.</div>`;
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
    async function syncDerivedCostFields(opts = {}) {
        if (_syncDerivedInFlight) return { skipped: true };
        _syncDerivedInFlight = true;
        try {
            const writes = [];
            for (const c of (allCosts || [])) {
                const e = enrichCost(c);
                const inactiveChecked = !!getField(c, F.costInactive);
                const storedDays = getField(c, F.costDaysOverdue);
                const storedVarAmt = getField(c, F.costVarianceAmount);
                const storedVarFlag = getPaymentStatusName(getField(c, F.costVarianceFlag));
                const storedNext = getField(c, F.costExpectedNext);
                const storedStatus = getPaymentStatusName(getField(c, F.costStatusNew));

                const computedNext = e.expectedNext ? toIsoDate(e.expectedNext) : null;
                const computedDays = e.daysOverdue;
                const computedVarAmt = e.varianceFlag !== 'unknown' ? +(e.varianceAmount.toFixed(2)) : null;
                const computedVarFlag = ({ match: 'Match', soft: 'Soft', hard: 'Hard', unknown: 'Unknown' })[e.varianceFlag] || 'Unknown';

                // Compute desired status: Inactive (if checkbox), else Overdue (if past due), else In Payment.
                // Only flips an existing status if the trigger condition genuinely changed.
                let desiredStatus = storedStatus || (inactiveChecked ? 'Inactive' : 'In Payment');
                if (inactiveChecked) {
                    desiredStatus = 'Inactive';
                } else if (computedDays !== null && computedDays > 0) {
                    desiredStatus = 'Overdue';
                } else if (storedStatus === 'Overdue' && computedDays !== null && computedDays <= 0) {
                    desiredStatus = 'In Payment';
                } else if (!storedStatus) {
                    desiredStatus = 'In Payment';
                }

                const fields = {};
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
                if (desiredStatus && desiredStatus !== storedStatus) {
                    fields[F.costStatusNew] = desiredStatus;
                }

                if (Object.keys(fields).length > 0) {
                    writes.push({ id: c.id, fields });
                }
            }

            if (writes.length === 0) return { ok: true, written: 0 };

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
            }
            if (opts.verbose) console.log(`syncDerivedCostFields: ${written} written, ${failed} failed`);
            return { ok: failed === 0, written, failed };
        } finally {
            _syncDerivedInFlight = false;
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
