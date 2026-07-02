// ══════════════════════════════════════════
// AR VARIABLE TAB — Accounts Receivable Variable
// Outbound invoices sent to customers/clients.
// Backed by Airtable table TABLES.arVariable.
// ══════════════════════════════════════════
    let arvData = [];
    let arvRefreshedAt = null;
    let arvTabRendered = false;
    let arvFetchInProgress = false;

    // ── Fetch from Airtable ──
    async function fetchARVariableData() {
        if (!PAT || arvFetchInProgress) return;
        arvFetchInProgress = true;
        showARVLoadingState();
        try {
            const records = await airtableFetch(TABLES.arVariable, {
                'sort[0][field]': ARV.dueDate,
                'sort[0][direction]': 'asc',
            });
            arvData = records.map(r => {
                const f = r.fields;
                const statusRaw = f[ARV.status];
                const statusName = typeof statusRaw === 'object' && statusRaw !== null ? (statusRaw.name || '') : (statusRaw || '');
                const dueDateStr = f[ARV.dueDate] || null;
                let daysOverdue = 0;
                if (dueDateStr && statusName !== 'Paid' && statusName !== 'Draft' && statusName !== 'Written Off') {
                    const due = new Date(dueDateStr);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    due.setHours(0, 0, 0, 0);
                    daysOverdue = Math.max(0, Math.floor((today - due) / 86400000));
                }
                return {
                    recordId:   r.id,
                    customer:   f[ARV.customer] || '',
                    invoiceNo:  f[ARV.invoiceNo] || '',
                    desc:       f[ARV.desc] || '',
                    amount:     f[ARV.amount] != null ? Number(f[ARV.amount]) : null,
                    dateSent:   f[ARV.dateSent] || null,
                    dueDate:    dueDateStr,
                    status:     statusName,
                    businessIds: Array.isArray(f[ARV.business]) ? f[ARV.business] : [],
                    ref:        f[ARV.ref] || '',
                    notes:      f[ARV.notes] || '',
                    daysOverdue,
                };
            });
            arvRefreshedAt = new Date();
            arvTabRendered = false;
            hideARVLoadingState();
            if (document.getElementById('tab-ar-variable')?.classList.contains('active')) {
                renderARVariableTab();
            }
        } catch (e) {
            hideARVLoadingState();
            if (e.message !== 'Auth failed') {
                arvData = [];
                arvTabRendered = false;
                if (document.getElementById('tab-ar-variable')?.classList.contains('active')) {
                    renderARVariableTab();
                }
            }
        } finally {
            arvFetchInProgress = false;
        }
    }

    // ── Loading state ──
    function showARVLoadingState() {
        const spinner = document.getElementById('arvLoadingSpinner');
        const table = document.getElementById('arvTable');
        if (spinner) spinner.style.display = 'flex';
        if (table) table.style.display = 'none';
        const cards = document.getElementById('arvSummaryCards');
        if (cards) cards.style.display = 'none';

        if (window._arvLoadingTimer) clearTimeout(window._arvLoadingTimer);
        window._arvLoadingTimer = setTimeout(() => {
            const msg = document.getElementById('arvLoadingMessage');
            const btn = document.getElementById('arvLoadingRetryBtn');
            if (msg) msg.textContent = 'Still loading after 8 seconds. Click below to force a fresh fetch.';
            if (btn) btn.style.display = 'inline-block';
        }, 8000);
    }

    function hideARVLoadingState() {
        if (window._arvLoadingTimer) { clearTimeout(window._arvLoadingTimer); window._arvLoadingTimer = null; }
        const spinner = document.getElementById('arvLoadingSpinner');
        if (spinner) spinner.style.display = 'none';
        const cards = document.getElementById('arvSummaryCards');
        if (cards) cards.style.display = '';
        const table = document.getElementById('arvTable');
        if (table) table.style.display = '';
    }

    async function forceARVRefresh() {
        const btn = document.getElementById('arvLoadingRetryBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Refreshing...'; }
        try {
            await fetchARVariableData();
            renderARVariableTab();
        } catch (err) {
            if (typeof showToast === 'function') showToast('Refresh failed: ' + err.message, { type: 'error' });
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Force Refresh from Airtable'; }
        }
    }

    // ── Business name resolver ──
    function arvBusinessName(businessIds) {
        if (!businessIds || businessIds.length === 0) return '';
        const bizId = typeof businessIds[0] === 'object' ? businessIds[0].id : businessIds[0];
        const biz = (allBusinesses || []).find(b => b.id === bizId);
        if (biz) return getField(biz, BIZ_NAME_FIELD) || '';
        return '';
    }

    // ── Populate business filter dropdown ──
    function populateARVBusinessFilter() {
        const sel = document.getElementById('arvBusinessFilter');
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

    // ── Format date for display ──
    function arvFormatDate(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    // ── Render ──
    function renderARVariableTab() {
        arvTabRendered = true;
        const panel = document.getElementById('tab-ar-variable');
        if (!panel) return;

        // If no data has been fetched yet and table ID is placeholder, show empty state directly
        const isPlaceholder = TABLES.arVariable.includes('PLACEHOLDER');

        if (!isPlaceholder && arvData.length === 0 && !arvRefreshedAt) {
            fetchARVariableData();
            return;
        }

        hideARVLoadingState();
        populateARVBusinessFilter();

        const filterText = (document.getElementById('arvFilterText')?.value || '').toLowerCase().trim();
        const sortBy = document.getElementById('arvSortBy')?.value || 'due-date';
        const statusFilter = document.getElementById('arvStatusFilter')?.value || 'unpaid';
        const businessFilter = document.getElementById('arvBusinessFilter')?.value || 'all';

        // Refreshed at label
        const refreshedEl = document.getElementById('arvRefreshedAt');
        if (refreshedEl) {
            if (isPlaceholder) {
                refreshedEl.textContent = 'Airtable table not yet connected';
            } else if (arvRefreshedAt) {
                refreshedEl.textContent = 'Last refreshed: ' + arvRefreshedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            }
        }

        // Filter by status
        let filtered = [...arvData];
        if (statusFilter === 'unpaid') {
            filtered = filtered.filter(inv => inv.status === 'Sent' || inv.status === 'Overdue');
        } else if (statusFilter !== 'all') {
            const target = statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1);
            filtered = filtered.filter(inv => inv.status === target);
        }

        // Filter by business
        if (businessFilter !== 'all') {
            filtered = filtered.filter(inv => {
                return inv.businessIds.some(id => {
                    const bizId = typeof id === 'object' ? id.id : id;
                    return bizId === businessFilter;
                });
            });
        }

        // Text search
        if (filterText) {
            filtered = filtered.filter(inv => {
                const haystack = [
                    inv.customer, inv.invoiceNo, inv.desc, inv.ref,
                    inv.amount != null ? inv.amount.toString() : '',
                    inv.status, arvBusinessName(inv.businessIds),
                ].join('  ').toLowerCase();
                return haystack.includes(filterText);
            });
        }

        // Sort
        const sorted = filtered.sort((a, b) => {
            if (sortBy === 'due-date') {
                if (!a.dueDate && !b.dueDate) return 0;
                if (!a.dueDate) return 1;
                if (!b.dueDate) return -1;
                return new Date(a.dueDate) - new Date(b.dueDate);
            }
            if (sortBy === 'due-date-desc') {
                if (!a.dueDate && !b.dueDate) return 0;
                if (!a.dueDate) return 1;
                if (!b.dueDate) return -1;
                return new Date(b.dueDate) - new Date(a.dueDate);
            }
            if (sortBy === 'amount-desc') return (b.amount || 0) - (a.amount || 0);
            if (sortBy === 'amount-asc') return (a.amount || 0) - (b.amount || 0);
            if (sortBy === 'customer') return a.customer.localeCompare(b.customer);
            if (sortBy === 'status') {
                const order = { 'Overdue': 0, 'Sent': 1, 'Draft': 2, 'Paid': 3, 'Written Off': 4 };
                return (order[a.status] ?? 5) - (order[b.status] ?? 5);
            }
            return 0;
        });

        // Summary calculations (on full dataset, not filtered)
        const allSent = arvData.filter(inv => inv.status === 'Sent');
        const allOverdue = arvData.filter(inv => inv.status === 'Overdue');
        const allPaid = arvData.filter(inv => inv.status === 'Paid');
        const unpaid = [...allSent, ...allOverdue];
        const totalOutstanding = unpaid.reduce((s, inv) => s + (inv.amount || 0), 0);
        const totalOverdue = allOverdue.reduce((s, inv) => s + (inv.amount || 0), 0);
        const avgDaysOverdue = allOverdue.length > 0
            ? Math.round(allOverdue.reduce((s, inv) => s + inv.daysOverdue, 0) / allOverdue.length)
            : 0;

        // Summary cards
        const summaryEl = document.getElementById('arvSummaryCards');
        if (summaryEl) {
            summaryEl.style.display = '';
            summaryEl.innerHTML = `
                <div class="kpi-card">
                    <div class="kpi-card-label">Total Outstanding</div>
                    <div class="kpi-card-value" style="color:var(--accent)">${fmt(totalOutstanding)}</div>
                    <div class="kpi-card-sub">${unpaid.length} unpaid invoice${unpaid.length !== 1 ? 's' : ''}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Overdue</div>
                    <div class="kpi-card-value" style="color:${allOverdue.length > 0 ? 'var(--danger)' : 'var(--success)'}">${fmt(totalOverdue)}</div>
                    <div class="kpi-card-sub">${allOverdue.length} overdue invoice${allOverdue.length !== 1 ? 's' : ''}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Avg Days Overdue</div>
                    <div class="kpi-card-value">${avgDaysOverdue}</div>
                    <div class="kpi-card-sub">${allOverdue.length > 0 ? 'Across ' + allOverdue.length + ' overdue invoices' : 'No overdue invoices'}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Paid (All Time)</div>
                    <div class="kpi-card-value" style="color:var(--success)">${allPaid.length}</div>
                    <div class="kpi-card-sub">${fmt(allPaid.reduce((s, inv) => s + (inv.amount || 0), 0))} collected</div>
                </div>
            `;
        }

        // Data table
        const tableEl = document.getElementById('arvTable');
        const tableBodyEl = document.getElementById('arvTableBody');

        if (isPlaceholder && arvData.length === 0) {
            if (tableEl) tableEl.style.display = 'none';
            if (tableBodyEl) {
                tableBodyEl.innerHTML = '';
            }
            // Show placeholder empty state
            let emptyEl = document.getElementById('arvEmptyState');
            if (!emptyEl) {
                emptyEl = document.createElement('div');
                emptyEl.id = 'arvEmptyState';
                emptyEl.style.cssText = 'text-align:center;padding:48px 24px;color:var(--text-muted)';
                tableEl?.parentElement?.appendChild(emptyEl);
            }
            emptyEl.innerHTML = `
                <div style="font-size:32px;margin-bottom:12px" aria-hidden="true">&#x1F4E4;</div>
                <div style="font-size:15px;font-weight:600;color:var(--text-secondary);margin-bottom:8px">No outbound invoices yet</div>
                <div style="font-size:13px;max-width:420px;margin:0 auto;line-height:1.5">
                    Invoices you send to customers will appear here. Add records to the Outbound Invoices table in Airtable to get started.
                </div>
            `;
            emptyEl.style.display = '';
        } else {
            // Remove placeholder if it exists
            const emptyEl = document.getElementById('arvEmptyState');
            if (emptyEl) emptyEl.style.display = 'none';

            if (tableEl) tableEl.style.display = '';

            if (tableBodyEl) {
                if (sorted.length === 0) {
                    tableBodyEl.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:32px">${
                        arvData.length === 0
                            ? 'No outbound invoices found. Invoices you send to customers will appear here.'
                            : 'No invoices match your filters.'
                    }</td></tr>`;
                } else {
                    tableBodyEl.innerHTML = sorted.map((inv, idx) => renderARVRow(inv, idx)).join('');
                }
            }
        }

        // Health bar
        if (typeof registerSyncBar === 'function') {
            registerSyncBar('ar-variable', {
                refreshFn: async () => { await fetchARVariableData(); renderARVariableTab(); },
                checks: [
                    { name: 'Table connected', kind: 'sync', run: () => {
                        if (isPlaceholder) return { status: 'warn', detail: 'Airtable table ID is a placeholder. Update TABLES.arVariable in config.js.' };
                        return { status: 'pass', detail: 'Table ID configured' };
                    }},
                    { name: 'Data loaded', kind: 'sync', run: () => {
                        if (isPlaceholder) return { status: 'warn', detail: 'Waiting for table connection' };
                        if (arvData.length === 0 && arvRefreshedAt) return { status: 'pass', detail: 'No invoices in table (empty is OK)' };
                        if (arvData.length === 0) return { status: 'warn', detail: 'No data loaded yet' };
                        return { status: 'pass', detail: `${arvData.length} invoice records loaded` };
                    }},
                    { name: 'Outstanding invoices', kind: 'sync', run: () => {
                        if (unpaid.length === 0) return { status: 'pass', detail: 'No outstanding invoices' };
                        return { status: 'pass', detail: `${unpaid.length} unpaid totalling ${fmt(totalOutstanding)}` };
                    }},
                    { name: 'Overdue invoices', kind: 'sync', run: () => {
                        if (allOverdue.length === 0) return { status: 'pass', detail: 'Nothing overdue' };
                        if (allOverdue.length <= 2) return { status: 'warn', detail: `${allOverdue.length} overdue (${fmt(totalOverdue)})` };
                        return { status: 'fail', detail: `${allOverdue.length} overdue totalling ${fmt(totalOverdue)}` };
                    }},
                    { name: 'Missing amounts', kind: 'sync', run: () => {
                        const missing = arvData.filter(inv => inv.amount == null || inv.amount === 0).length;
                        if (missing === 0) return { status: 'pass', detail: 'All invoices have amounts' };
                        return { status: 'warn', detail: `${missing} invoice(s) without an amount` };
                    }},
                    { name: 'Missing due dates', kind: 'sync', run: () => {
                        const missing = arvData.filter(inv => !inv.dueDate && inv.status !== 'Draft').length;
                        if (missing === 0) return { status: 'pass', detail: 'All sent invoices have due dates' };
                        return { status: 'warn', detail: `${missing} sent invoice(s) without a due date` };
                    }},
                ]
            });
            if (typeof markTabSynced === 'function') markTabSynced('ar-variable');
        }
    }

    // ── Row renderer ──
    function renderARVRow(inv, idx) {
        const statusColors = {
            'Draft':       { bg: 'var(--bg-subtle)',    text: 'var(--text-secondary)' },
            'Sent':        { bg: 'var(--info-bg)',      text: 'var(--info)' },
            'Overdue':     { bg: 'var(--danger-bg)',    text: 'var(--danger)' },
            'Paid':        { bg: 'var(--success-bg)',   text: 'var(--success)' },
            'Written Off': { bg: 'var(--warning-bg)',   text: 'var(--warning)' },
        };
        const sc = statusColors[inv.status] || statusColors['Draft'];
        const statusBadge = `<span class="inv-badge" style="background:${sc.bg};color:${sc.text}">${escHtml(inv.status || 'Unknown')}</span>`;

        const bizName = arvBusinessName(inv.businessIds);
        const overdueDisplay = inv.daysOverdue > 0
            ? `<span style="color:var(--danger);font-weight:600">${inv.daysOverdue}d</span>`
            : '<span style="color:var(--text-muted)">&#8212;</span>';

        return `<tr>
            <td style="text-align:center;color:var(--text-muted);font-size:11px">${idx + 1}</td>
            <td style="font-weight:500">${escHtml(inv.customer) || '<span style="color:var(--text-muted)">&#8212;</span>'}</td>
            <td style="font-size:12px">${escHtml(inv.invoiceNo) || '<span style="color:var(--text-muted)">&#8212;</span>'}</td>
            <td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(inv.desc)}">${escHtml(inv.desc) || '<span style="color:var(--text-muted)">&#8212;</span>'}</td>
            <td style="text-align:right;font-weight:600">${inv.amount != null ? fmt(inv.amount) : '<span style="color:var(--text-muted)">&#8212;</span>'}</td>
            <td style="font-size:12px">${arvFormatDate(inv.dateSent) || '<span style="color:var(--text-muted)">&#8212;</span>'}</td>
            <td style="font-size:12px">${arvFormatDate(inv.dueDate) || '<span style="color:var(--text-muted)">&#8212;</span>'}</td>
            <td>${statusBadge}</td>
            <td style="font-size:12px">${escHtml(bizName) || '<span style="color:var(--text-muted)">&#8212;</span>'}</td>
            <td style="text-align:center">${overdueDisplay}</td>
        </tr>`;
    }
