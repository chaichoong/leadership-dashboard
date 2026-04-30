// ══════════════════════════════════════════
// COSTS TAB — Accounts Payable Fixed
// ══════════════════════════════════════════
    let costsTabRendered = false;

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

        const sourceData = statusFilter === 'all' ? costs
            : statusFilter === 'inactive' ? inactiveCosts
            : activeCosts;

        const filtered = filterText
            ? sourceData.filter(r =>
                (getField(r, F.costName) || '').toLowerCase().includes(filterText) ||
                (getField(r, F.costAccountAlias) || '').toLowerCase().includes(filterText) ||
                (getField(r, F.costFrequency) || '').toLowerCase().includes(filterText) ||
                getCostSubCatName(r).toLowerCase().includes(filterText))
            : sourceData;

        const sorted = [...filtered].sort((a, b) => {
            if (sortBy === 'due-day') return (Number(getField(a, F.costDueDay)) || 99) - (Number(getField(b, F.costDueDay)) || 99);
            if (sortBy === 'amount-desc') return (Number(getField(b, F.costExpected)) || 0) - (Number(getField(a, F.costExpected)) || 0);
            if (sortBy === 'amount-asc') return (Number(getField(a, F.costExpected)) || 0) - (Number(getField(b, F.costExpected)) || 0);
            if (sortBy === 'name') return (getField(a, F.costName) || '').localeCompare(getField(b, F.costName) || '');
            if (sortBy === 'status') return (getPaymentStatusName(getField(a, F.costPayStatus)) || '').localeCompare(getPaymentStatusName(getField(b, F.costPayStatus)) || '');
            return 0;
        });

        // Summary calculations
        const totalMonthly = activeCosts.reduce((s, r) => s + (Number(getField(r, F.costExpected)) || 0), 0);
        const overdueCount = activeCosts.filter(r => getPaymentStatusName(getField(r, F.costPayStatus)) === 'Overdue').length;
        const dueTodayCount = activeCosts.filter(r => getPaymentStatusName(getField(r, F.costPayStatus)) === 'Due Today').length;

        // Group by sub-category for analysis
        const byCat = {};
        activeCosts.forEach(r => {
            const cat = getCostSubCatName(r) || 'Uncategorised';
            if (!byCat[cat]) byCat[cat] = { total: 0, count: 0 };
            byCat[cat].total += Number(getField(r, F.costExpected)) || 0;
            byCat[cat].count++;
        });
        const catEntries = Object.entries(byCat).sort((a, b) => b[1].total - a[1].total);

        // Build shell on first render, just update dynamic parts after
        const summaryEl = document.getElementById('costsSummaryCards');
        const tableBodyEl = document.getElementById('costsTableBody');
        const tableEl = document.getElementById('costsTable');

        if (summaryEl) {
            summaryEl.innerHTML = `
                <div class="kpi-card">
                    <div class="kpi-card-label">Active Fixed Costs</div>
                    <div class="kpi-card-value">${activeCosts.length}</div>
                    <div class="kpi-card-sub">${inactiveCosts.length} inactive</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Monthly Total</div>
                    <div class="kpi-card-value text-red">${fmt(totalMonthly)}</div>
                    <div class="kpi-card-sub">Total of all active expected amounts</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Overdue / Due Today</div>
                    <div class="kpi-card-value" style="color:${(overdueCount + dueTodayCount) > 0 ? 'var(--danger)' : 'var(--success)'}">${overdueCount + dueTodayCount}</div>
                    <div class="kpi-card-sub">${overdueCount} overdue · ${dueTodayCount} due today</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Top Category</div>
                    <div class="kpi-card-value" style="font-size:16px">${catEntries.length > 0 ? escHtml(catEntries[0][0]) : '—'}</div>
                    <div class="kpi-card-sub">${catEntries.length > 0 ? fmt(catEntries[0][1].total) + ' (' + catEntries[0][1].count + ' costs)' : 'No data'}</div>
                </div>
            `;
        }

        if (tableEl) tableEl.style.display = '';

        if (tableBodyEl) {
            tableBodyEl.innerHTML = sorted.map((r, idx) => {
                const name = getField(r, F.costName) || '';
                const expected = Number(getField(r, F.costExpected)) || 0;
                const dueDay = Number(getField(r, F.costDueDay)) || null;
                const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                const frequency = getField(r, F.costFrequency) || '';
                const statusRaw = getField(r, F.costPayStatus);
                const statusName = getPaymentStatusName(statusRaw);
                const account = getField(r, F.costAccountAlias) || '';
                const inactive = getField(r, F.costInactive);
                const nextDue = getField(r, F.costDueDateNext) || '';
                const subCat = getCostSubCatName(r);

                const statusClass = statusName === 'Overdue' ? 'overdue'
                    : statusName === 'Due Today' ? 'due-soon'
                    : statusName === 'In Payment' ? 'in-payment'
                    : 'upcoming';

                const statusBadge = `<span class="inv-badge ${statusClass}">${escHtml(statusName || (inactive ? 'Inactive' : 'Unknown'))}</span>`;

                const linkedTxHtml = buildLinkedTransactionsHtml(r);

                const nextDueFormatted = nextDue ? formatCostDate(nextDue) : '—';

                return `<tr data-record-id="${r.id}" class="${inactive ? 'cost-inactive-row' : ''}">
                    <td style="text-align:center;color:var(--text-muted);font-size:11px;font-weight:600">${idx + 1}</td>
                    <td style="font-weight:600;max-width:200px">${escHtml(name)}</td>
                    <td style="text-align:right;white-space:nowrap;font-weight:600">${fmt(expected)}</td>
                    <td style="white-space:nowrap;color:var(--text-secondary)">${escHtml(dueDayStr)}</td>
                    <td style="white-space:nowrap">${nextDueFormatted}</td>
                    <td style="white-space:nowrap">${statusBadge}</td>
                    <td style="font-size:12px;color:var(--text-secondary)">${escHtml(frequency)}</td>
                    <td style="font-size:12px;color:var(--text-secondary)">${escHtml(account)}</td>
                    <td style="font-size:12px;color:var(--text-secondary);max-width:140px">${escHtml(subCat)}</td>
                    <td style="width:40px;text-align:center">
                        <button class="cost-expand-btn" onclick="event.stopPropagation(); toggleCostTxRow(this, '${r.id}')" title="Show linked transactions" style="background:none;border:1px solid var(--border-default);border-radius:4px;cursor:pointer;padding:2px 6px;font-size:11px;color:var(--text-secondary)">▶</button>
                    </td>
                </tr>
                <tr class="cost-tx-detail-row" id="cost-tx-${r.id}" style="display:none">
                    <td colspan="10" style="padding:8px 16px;background:var(--bg-surface-2);border-left:3px solid var(--accent)">
                        ${linkedTxHtml}
                    </td>
                </tr>`;
            }).join('');
        }

        // Spending breakdown card
        const breakdownEl = document.getElementById('costsBreakdown');
        if (breakdownEl) {
            breakdownEl.innerHTML = catEntries.map(([cat, data]) => {
                const pct = totalMonthly > 0 ? (data.total / totalMonthly * 100).toFixed(1) : '0.0';
                return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-subtle)">
                    <span style="flex:1;font-size:13px;font-weight:500;color:var(--text-primary)">${escHtml(cat)}</span>
                    <span style="font-size:12px;color:var(--text-muted)">${data.count} costs</span>
                    <span style="font-size:13px;font-weight:600;color:var(--text-primary);min-width:80px;text-align:right">${fmt(data.total)}</span>
                    <span style="font-size:11px;color:var(--text-muted);min-width:40px;text-align:right">${pct}%</span>
                    <div style="width:80px;height:6px;background:var(--bg-subtle);border-radius:3px;overflow:hidden">
                        <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:3px"></div>
                    </div>
                </div>`;
            }).join('');
        }

        // AI Analysis
        renderCostsAIAnalysis(activeCosts, totalMonthly, catEntries);

        // Sync bar
        if (typeof registerSyncBar === 'function') {
            registerSyncBar('costs', {
                refreshFn: async () => { if (typeof loadDashboard === 'function') await loadDashboard(); renderCostsTab(); },
                checks: [
                    {
                        name: 'Costs data loaded', kind: 'sync', run: () => {
                            const n = (allCosts || []).length;
                            if (n === 0) return { status: 'warn', detail: 'No costs loaded — data may still be fetching' };
                            return { status: 'pass', detail: `${n} cost records loaded` };
                        }
                    },
                    {
                        name: 'Active costs present', kind: 'sync', run: () => {
                            if (activeCosts.length === 0) return { status: 'warn', detail: 'No active costs found' };
                            return { status: 'pass', detail: `${activeCosts.length} active costs totalling ${fmt(totalMonthly)}` };
                        }
                    },
                    {
                        name: 'Overdue costs', kind: 'sync', run: () => {
                            if (overdueCount > 0) return { status: 'fail', detail: `${overdueCount} cost(s) overdue — action needed` };
                            return { status: 'pass', detail: 'No overdue costs' };
                        }
                    },
                    {
                        name: 'Missing amounts', kind: 'sync', run: () => {
                            const missing = activeCosts.filter(r => !getField(r, F.costExpected)).length;
                            if (missing > 0) return { status: 'warn', detail: `${missing} active cost(s) without expected amount` };
                            return { status: 'pass', detail: 'All active costs have expected amounts' };
                        }
                    }
                ]
            });
            if (typeof markTabSynced === 'function') markTabSynced('costs');
        }
    }

    // ── Helpers ──

    const SUBCAT_NAME_FIELD = 'fldO4BTJhFv5EsN6i';

    function getCostSubCatName(rec) {
        const linked = getField(rec, F.costSubCategory);
        if (!linked || !Array.isArray(linked) || linked.length === 0) return '';
        const subCat = (allSubCategories || []).find(s => s.id === linked[0]);
        if (!subCat) return '';
        const n = getField(subCat, SUBCAT_NAME_FIELD);
        return typeof n === 'string' ? n : (n?.name || '');
    }

    function formatCostDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        if (isNaN(d)) return escHtml(dateStr);
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    function buildLinkedTransactionsHtml(costRec) {
        const costId = costRec.id;
        const txs = (allTransactions || []).filter(tx => {
            const linked = getField(tx, F.txCost);
            return linked && Array.isArray(linked) && linked.includes(costId);
        });

        if (txs.length === 0) {
            return '<div style="font-size:12px;color:var(--text-muted);padding:4px 0">No linked transactions found</div>';
        }

        const txSorted = [...txs].sort((a, b) => {
            const da = new Date(getField(a, F.txDate) || '');
            const db = new Date(getField(b, F.txDate) || '');
            return db - da;
        });

        const rows = txSorted.slice(0, 20).map(tx => {
            const date = getField(tx, F.txDate) || '';
            const amount = Number(getField(tx, F.txReportAmount)) || 0;
            const label = txLabel(tx);
            const account = getField(tx, F.txAccountAlias) || '';
            const reconciled = getField(tx, F.txReconciled);
            const reconBadge = reconciled ? '<span style="color:var(--success);font-size:10px;font-weight:600">✓ Reconciled</span>' : '<span style="color:var(--text-muted);font-size:10px">Unreconciled</span>';
            return `<div style="display:grid;grid-template-columns:90px 1fr 90px 90px 90px;gap:8px;padding:4px 0;border-bottom:1px solid var(--border-subtle);font-size:12px;align-items:center">
                <span style="color:var(--text-secondary)">${escHtml(formatCostDate(date))}</span>
                <span style="color:var(--text-primary);font-weight:500">${escHtml(label)}</span>
                <span style="text-align:right;font-weight:600;color:${amount < 0 ? 'var(--danger)' : 'var(--text-primary)'}">${fmt(Math.abs(amount))}</span>
                <span style="color:var(--text-muted)">${escHtml(account)}</span>
                <span>${reconBadge}</span>
            </div>`;
        }).join('');

        const totalLinked = txSorted.reduce((s, tx) => s + Math.abs(Number(getField(tx, F.txReportAmount)) || 0), 0);

        return `<div style="margin-bottom:4px;font-size:11px;font-weight:600;color:var(--text-secondary)">${txSorted.length} linked transaction${txSorted.length !== 1 ? 's' : ''} · Total: ${fmt(totalLinked)}</div>
            <div style="display:grid;grid-template-columns:90px 1fr 90px 90px 90px;gap:8px;padding:4px 0;font-size:10px;text-transform:uppercase;color:var(--text-muted);font-weight:600">
                <span>Date</span><span>Description</span><span style="text-align:right">Amount</span><span>Account</span><span>Status</span>
            </div>
            ${rows}
            ${txSorted.length > 20 ? `<div style="font-size:11px;color:var(--text-muted);padding:4px 0">Showing 20 of ${txSorted.length} — use Transactions tab for full list</div>` : ''}`;
    }

    function toggleCostTxRow(btn, costId) {
        const row = document.getElementById('cost-tx-' + costId);
        if (!row) return;
        const visible = row.style.display !== 'none';
        row.style.display = visible ? 'none' : '';
        btn.textContent = visible ? '▶' : '▼';
    }

    // ── AI Analysis Panel ──

    function renderCostsAIAnalysis(activeCosts, totalMonthly, catEntries) {
        const el = document.getElementById('costsAIAnalysis');
        if (!el) return;

        const insights = [];

        // Insight: largest cost
        const largest = [...activeCosts].sort((a, b) => (Number(getField(b, F.costExpected)) || 0) - (Number(getField(a, F.costExpected)) || 0));
        if (largest.length > 0) {
            const top = largest[0];
            const topAmt = Number(getField(top, F.costExpected)) || 0;
            const pct = totalMonthly > 0 ? (topAmt / totalMonthly * 100).toFixed(1) : '0.0';
            insights.push(`<div class="cost-insight"><strong>Largest cost:</strong> ${escHtml(getField(top, F.costName) || '')} at ${fmt(topAmt)} (${pct}% of total monthly)</div>`);
        }

        // Insight: concentration risk
        if (catEntries.length > 0 && totalMonthly > 0) {
            const topCatPct = (catEntries[0][1].total / totalMonthly * 100);
            if (topCatPct > 40) {
                insights.push(`<div class="cost-insight" style="border-left-color:var(--warning)"><strong>Concentration risk:</strong> "${escHtml(catEntries[0][0])}" accounts for ${topCatPct.toFixed(1)}% of all fixed costs. Consider reviewing for potential savings.</div>`);
            }
        }

        // Insight: costs due in next 7 days
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const next7 = activeCosts.filter(r => {
            const nd = getField(r, F.costDueDateNext);
            if (!nd) return false;
            const d = new Date(nd);
            return d >= today && d <= new Date(today.getTime() + 7 * 86400000);
        });
        if (next7.length > 0) {
            const total7 = next7.reduce((s, r) => s + (Number(getField(r, F.costExpected)) || 0), 0);
            insights.push(`<div class="cost-insight" style="border-left-color:var(--info)"><strong>Due in next 7 days:</strong> ${next7.length} cost${next7.length !== 1 ? 's' : ''} totalling ${fmt(total7)}</div>`);
        }

        // Insight: annualised cost
        const annual = totalMonthly * 12;
        insights.push(`<div class="cost-insight"><strong>Annualised fixed costs:</strong> ${fmt(annual)} based on current monthly total of ${fmt(totalMonthly)}</div>`);

        // Insight: compare expected vs actual (using linked transactions this month)
        const thisMonth = new Date().getMonth();
        const thisYear = new Date().getFullYear();
        let actualThisMonth = 0;
        let costWithTxCount = 0;
        activeCosts.forEach(r => {
            const txs = (allTransactions || []).filter(tx => {
                const linked = getField(tx, F.txCost);
                if (!linked || !Array.isArray(linked) || !linked.includes(r.id)) return false;
                const d = new Date(getField(tx, F.txDate) || '');
                return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
            });
            if (txs.length > 0) {
                costWithTxCount++;
                actualThisMonth += txs.reduce((s, tx) => s + Math.abs(Number(getField(tx, F.txReportAmount)) || 0), 0);
            }
        });
        if (costWithTxCount > 0) {
            const variance = actualThisMonth - totalMonthly;
            const varPct = totalMonthly > 0 ? (variance / totalMonthly * 100).toFixed(1) : '0.0';
            const varColor = variance > 0 ? 'var(--danger)' : 'var(--success)';
            insights.push(`<div class="cost-insight" style="border-left-color:${varColor}"><strong>This month actual vs expected:</strong> ${fmt(actualThisMonth)} actual vs ${fmt(totalMonthly)} expected (<span style="color:${varColor}">${variance >= 0 ? '+' : ''}${varPct}%</span>) — ${costWithTxCount} of ${activeCosts.length} costs with transactions this month</div>`);
        }

        // Insight: potential savings candidates (small frequent costs)
        const smallCosts = activeCosts.filter(r => {
            const amt = Number(getField(r, F.costExpected)) || 0;
            return amt > 0 && amt < 50;
        });
        if (smallCosts.length >= 3) {
            const smallTotal = smallCosts.reduce((s, r) => s + (Number(getField(r, F.costExpected)) || 0), 0);
            insights.push(`<div class="cost-insight" style="border-left-color:var(--accent-gold)"><strong>Potential savings review:</strong> ${smallCosts.length} costs under £50/month (total ${fmt(smallTotal)}). Consider auditing subscriptions and small recurring charges.</div>`);
        }

        el.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">${insights.join('')}</div>`;
    }
