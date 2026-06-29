// ══════════════════════════════════════════
// INVOICES TAB — Fetch, Render, Match, Approve, Pay
// ══════════════════════════════════════════
    // ── Invoices Tab — backed by Airtable ──
    let airtableInvoices = [];
    let invoiceRefreshedAt = null;
    // Tracks the last Mark-Paid / Approve-Match attempt for the health checks panel
    // Shape: { ok: bool, when: Date, error: string|null, action: 'markPaid'|'approveMatch' }
    let lastApprovalAttempt = null;
    // Bulk-select state — Set of recordIds currently checked
    let invSelectedIds = new Set();

    // ── New-invoice tracking (based on Airtable createdTime vs localStorage lastSeen) ──
    function getLastSeenInvoiceTime() {
        return localStorage.getItem('lastSeenInvoiceTime') || '1970-01-01T00:00:00.000Z';
    }
    function markInvoicesAsSeen() {
        localStorage.setItem('lastSeenInvoiceTime', new Date().toISOString());
    }
    function updateInvoicesSidebarBadge() {
        const unpaid = airtableInvoices.filter(inv => inv.status !== 'Paid');
        const lastSeen = new Date(getLastSeenInvoiceTime());
        const newCount = unpaid.filter(inv => inv.createdTime && new Date(inv.createdTime) > lastSeen).length;
        const sidebarItem = document.querySelector('.sidebar-item[onclick*="invoices"]');
        if (!sidebarItem) return;
        const label = sidebarItem.querySelector('.sidebar-label');
        if (!label) return;
        let badge = sidebarItem.querySelector('.sidebar-invoice-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'sidebar-invoice-badge';
            badge.className = 'sidebar-invoice-badge od-count-badge';
            label.appendChild(badge);
        }
        if (newCount > 0) {
            badge.style.background = 'var(--danger)';
            badge.style.color = 'white';
            badge.textContent = `${unpaid.length} • ${newCount} new`;
        } else if (unpaid.length > 0) {
            badge.style.background = 'var(--border-default)';
            badge.style.color = 'var(--text-secondary)';
            badge.textContent = `${unpaid.length}`;
        } else {
            badge.textContent = '';
        }
    }

    async function fetchInvoicesFromAirtable() {
        if (!PAT) return;
        // Show loading spinner, hide table
        const spinner = document.getElementById('invoiceLoadingSpinner');
        const table = document.getElementById('invoiceTable');
        if (spinner) spinner.style.display = 'flex';
        if (table) table.style.display = 'none';
        try {
            const baseParams = {
                'filterByFormula': "{Status}='Unpaid'",
                'sort[0][field]': 'Email Date',
                'sort[0][direction]': 'asc',
                'returnFieldsByFieldId': 'true',
            };
            let allRecords = [], pageOffset = null;
            do {
                const params = new URLSearchParams(baseParams);
                if (pageOffset) params.set('offset', pageOffset);
                const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLES.invoices}?${params}`;
                const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + PAT } });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const data = await resp.json();
                allRecords.push(...data.records);
                pageOffset = data.offset || null;
            } while (pageOffset);
            airtableInvoices = allRecords.map(r => {
                const f = r.fields;
                return {
                    recordId:      r.id,
                    createdTime:   r.createdTime || null,
                    id:            f[INV.msgId] || f[INV.threadId] || '',
                    threadId:      f[INV.threadId] || '',
                    payee:         f[INV.payee] || '',
                    desc:          f[INV.desc] || '',
                    amount:        f[INV.amount] !== undefined && f[INV.amount] !== null ? f[INV.amount] : null,
                    emailDate:     f[INV.emailDate] || null,
                    dueDate:       f[INV.dueDate] || null,
                    ref:           f[INV.ref] || '',
                    hasAttachment: !!f[INV.hasAttachment],
                    hasPdf:        !!f[INV.hasPdf],
                    gmailUrl:      f[INV.gmailUrl] || `https://mail.google.com/mail/u/0/#all/${f[INV.threadId] || ''}`,
                    status:        typeof f[INV.status] === 'object' ? (f[INV.status]?.name || 'Unpaid') : (f[INV.status] || 'Unpaid'),
                    isEstimate:    !!f[INV.isEstimate],
                    matchRejected: !!f[INV.matchRejected],
                    // Business is a linked-record field — Airtable returns an array of record IDs
                    businessIds:   Array.isArray(f[INV.business]) ? f[INV.business] : [],
                };
            });
            invoiceRefreshedAt = new Date();
            invoiceTabRendered = false;
            updateInvoicesSidebarBadge();
            // Hide spinner, show table
            if (spinner) spinner.style.display = 'none';
            if (table) table.style.display = '';
            if (document.getElementById('tab-invoices').classList.contains('active')) {
                renderInvoiceTab();
            }
            fetchGmailLabelCount();
        } catch (e) {
            console.warn('Airtable invoice fetch failed:', e.message);
            // Hide spinner on error too, show table with whatever we have
            if (spinner) spinner.style.display = 'none';
            if (table) table.style.display = '';
        }
    }

    // Fetch Gmail "3. to pay" label count from Apps Script
    let lastGmailCount = null;
    async function fetchGmailLabelCount() {
        if (!GMAIL_SCRIPT_URL) return;
        try {
            const resp = await fetch(GMAIL_SCRIPT_URL + '?action=count');
            if (resp.ok) {
                const data = await resp.json();
                if (typeof data.gmailCount === 'number') {
                    lastGmailCount = data.gmailCount;
                    updateSyncHealthIndicator();
                }
            }
        } catch (e) {
            console.warn('Gmail count fetch failed:', e.message);
        }
    }

    function updateSyncHealthIndicator() {
        const el = document.getElementById('invSyncHealth');
        if (!el) return;
        const unpaidCount = airtableInvoices.filter(inv => inv.status === 'Unpaid').length;
        if (lastGmailCount === null) {
            el.innerHTML = `<span style="color:var(--text-secondary)">Dashboard: <strong>${unpaidCount}</strong> unpaid</span>`;
        } else if (unpaidCount === lastGmailCount) {
            el.innerHTML = `<span style="color:var(--success)">Dashboard: <strong>${unpaidCount}</strong> | Gmail: <strong>${lastGmailCount}</strong> ✓ In sync</span>`;
        } else {
            el.innerHTML = `<span style="color:var(--warning)">Dashboard: <strong>${unpaidCount}</strong> | Gmail: <strong>${lastGmailCount}</strong> ⚠️ Mismatch</span>`;
        }
    }

    // Trigger Gmail → Airtable sync via Apps Script (fire-and-forget)
    async function triggerGmailInvoiceSync() {
        if (!GMAIL_SCRIPT_URL) return;
        try {
            await fetch(GMAIL_SCRIPT_URL + '?action=sync', { mode: 'no-cors', redirect: 'follow' });
            // After sync, refresh from Airtable to pick up any new invoices
            setTimeout(fetchInvoicesFromAirtable, 3000);
        } catch (e) {
            console.warn('Gmail sync trigger failed (expected on first deploy):', e.message);
        }
    }

    // Trigger full reconcile: Airtable status realigned to match Gmail "3: to pay"
    async function triggerGmailInvoiceReconcile() {
        if (!GMAIL_SCRIPT_URL) return;
        if (!confirm('Reconcile dashboard against Gmail?\n\nThis will:\n• Mark as Paid any invoice whose email is no longer in "3: to pay"\n• Restore to Unpaid any invoice whose email IS in "3: to pay"\n\nUse this if the dashboard and Gmail get out of sync.')) return;
        try {
            // Use a real GET so we can read the JSON response (CORS allows simple GET)
            const resp = await fetch(GMAIL_SCRIPT_URL + '?action=reconcile', { redirect: 'follow' });
            let summary = 'Reconcile complete.';
            try {
                const data = await resp.json();
                if (data && data.success) {
                    summary = `Reconcile complete:\n• Gmail "3: to pay": ${data.gmailThreadCount}\n• Marked Paid: ${data.markedPaid}\n• Restored to Unpaid: ${data.restoredUnpaid}\n• Skipped (Estimates etc): ${data.skipped}`;
                } else if (data && data.error) {
                    summary = 'Reconcile error: ' + data.error;
                }
            } catch (parseErr) {
                // Response might be opaque if no-cors — just refresh
            }
            alert(summary);
            // Refresh dashboard to reflect changes
            setTimeout(fetchInvoicesFromAirtable, 500);
        } catch (e) {
            console.error('Reconcile failed:', e);
            alert('Reconcile failed — check the console for details.');
        }
    }

    function fmtInvDate(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    let invoiceTabRendered = false;
    function renderInvoiceTab() {
        invoiceTabRendered = true;
        const today = new Date();
        today.setHours(0,0,0,0);
        // Capture "last seen" BEFORE marking as seen, so NEW badges still show this render
        const lastSeenBeforeRender = new Date(getLastSeenInvoiceTime());

        // Source data comes directly from Airtable — no localStorage merging needed
        const sourceData = airtableInvoices.filter(inv => inv.status !== 'Paid');

        // Update the "Last refreshed" text
        const refreshSpan = document.querySelector('#tab-invoices .section span[style*="font-size:12px"]');
        if (refreshSpan) {
            const refreshTime = invoiceRefreshedAt
                ? invoiceRefreshedAt.toLocaleString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
                : 'Not yet loaded';
            const statusLabel = airtableInvoices.length > 0
                ? '<span style="color:var(--success);font-weight:600">Airtable</span>'
                : '<span style="color:var(--warning);font-weight:600">Loading…</span>';
            refreshSpan.innerHTML = `Source: <strong style="color:var(--text-secondary)">Airtable → Gmail</strong> &nbsp;·&nbsp; ${statusLabel} &nbsp;·&nbsp; Last refreshed: <strong style="color:var(--text-secondary)">${refreshTime}</strong> &nbsp;·&nbsp; <a href="#" onclick="event.preventDefault(); triggerGmailInvoiceSync(); this.textContent='Syncing…'; setTimeout(()=>this.textContent='Refresh from Gmail',4000)" style="color:var(--info);font-size:11px;text-decoration:underline">Refresh from Gmail</a> &nbsp;·&nbsp; <a href="#" onclick="event.preventDefault(); triggerGmailInvoiceReconcile(); this.textContent='Reconciling…'; setTimeout(()=>this.textContent='Reconcile with Gmail',4000)" style="color:var(--tone-plum);font-size:11px;text-decoration:underline" title="Realign dashboard against Gmail '3: to pay' label">Reconcile with Gmail</a> &nbsp;·&nbsp; <span id="invSyncHealth" style="font-size:11px"></span>`;
        }
        updateSyncHealthIndicator();

        // Cross-reference with Airtable transactions for AI matching
        const txMatches = matchInvoicesToTransactions(sourceData, allTransactions);

        // Filter by search text
        const filterText = (document.getElementById('invFilterText')?.value || '').toLowerCase().trim();
        const filtered = filterText
            ? sourceData.filter(inv =>
                (inv.payee || '').toLowerCase().includes(filterText) ||
                (inv.desc || '').toLowerCase().includes(filterText) ||
                (inv.ref || '').toLowerCase().includes(filterText))
            : sourceData;

        // Sort based on dropdown selection
        const sortBy = document.getElementById('invSortBy')?.value || 'date';
        const sorted = [...filtered].sort((a, b) => {
            if (sortBy === 'date') return new Date(a.dueDate || a.emailDate) - new Date(b.dueDate || b.emailDate);
            if (sortBy === 'date-desc') return new Date(b.dueDate || b.emailDate) - new Date(a.dueDate || a.emailDate);
            if (sortBy === 'amount') return (b.amount || 0) - (a.amount || 0);
            if (sortBy === 'amount-asc') return (a.amount || 0) - (b.amount || 0);
            if (sortBy === 'payee') return (a.payee || '').localeCompare(b.payee || '');
            return 0;
        });

        // Summary calculations (always based on all unpaid, not filtered)
        let knownTotal = 0, unknownCount = 0, overdueCount = 0;
        sourceData.forEach(inv => {
            if (inv.amount !== null) knownTotal += inv.amount; else unknownCount++;
            if (new Date(inv.dueDate || inv.emailDate) < today) overdueCount++;
        });

        // Summary cards
        const summaryCards = document.getElementById('invoiceSummaryCards');
        if (summaryCards) {
            summaryCards.innerHTML = `
                <div class="kpi-card">
                    <div class="kpi-card-label">Unpaid Invoices</div>
                    <div class="kpi-card-value">${sourceData.length}</div>
                    <div class="kpi-card-sub">Synced from Gmail "3. to pay"</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Known Amount Due</div>
                    <div class="kpi-card-value text-red">${fmt(knownTotal)}</div>
                    <div class="kpi-card-sub">${sourceData.length - unknownCount} of ${sourceData.length} invoices with amounts</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Amount Unknown</div>
                    <div class="kpi-card-value" style="color:var(--text-muted)">${unknownCount}</div>
                    <div class="kpi-card-sub">${unknownCount > 0 ? 'Click to enter amounts on table below' : 'All amounts populated'}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Overdue / Past Date</div>
                    <div class="kpi-card-value text-red">${overdueCount}</div>
                    <div class="kpi-card-sub">${overdueCount > 0 ? 'Due date has passed' : 'No overdue invoices'}</div>
                </div>
            `;
        }

        // Table rows
        const tbody = document.getElementById('invoiceTableBody');
        if (!tbody) return;

        tbody.innerHTML = sorted.map((inv, idx) => {
            const effDate = new Date(inv.dueDate || inv.emailDate);
            const isOverdue = effDate < today;
            const daysDiff = Math.round((effDate - today) / 86400000);
            const displayDate = fmtInvDate(inv.dueDate || inv.emailDate);
            const dateCell = `<strong>${displayDate}</strong>`;

            const matchKey = inv.id || inv.threadId;
            const match = txMatches[matchKey];

            let badge = '';
            if (inv.isEstimate) {
                badge = '<span class="inv-badge estimate">Estimate</span>';
            } else if (isOverdue) {
                badge = '<span class="inv-badge overdue">Overdue</span>';
            } else if (daysDiff <= 7) {
                badge = '<span class="inv-badge due-soon">Due soon</span>';
            } else {
                badge = '<span class="inv-badge upcoming">Upcoming</span>';
            }
            const isNew = inv.createdTime && new Date(inv.createdTime) > lastSeenBeforeRender;
            if (isNew) {
                badge += ' <span class="inv-badge" style="background:var(--success-bg);color:var(--success);border:1px solid var(--success)">NEW</span>';
            }

            const displayAmt = inv.amount;
            const displayPayee = (inv.payee || '').trim();
            const displayDesc = (inv.desc || '').trim();
            const displayRef = (inv.ref || '').trim();

            // Always-visible spreadsheet-style cell inputs. Each input has data-record + data-field
            // attributes so the delegated handlers (handleCellInputChange, handleCellInputBlur,
            // handleCellInputKey) know what to PATCH. See saveCellInput() for the save flow.
            // Amount is type="text" (not number) so trailing zeros are preserved — e.g. £40.00 not £40.
            // inputmode="decimal" still gives mobile users a numeric keyboard. Validation happens on save.
            const amountVal = displayAmt !== null ? Number(displayAmt).toFixed(2) : '';
            const amountHtml = `<input type="text" inputmode="decimal" class="inv-cell-input inv-cell-amount od-inline-input" data-record="${inv.recordId}" data-field="${INV.amount}" data-type="number" value="${amountVal}" placeholder="0.00" style="text-align:right;font-weight:600">`;
            const payeeHtml = `<input type="text" class="inv-cell-input od-inline-input" data-record="${inv.recordId}" data-field="${INV.payee}" data-type="text" value="${escHtml(displayPayee)}" placeholder="Payee…" style="font-weight:600">`;
            const descHtml = `<input type="text" class="inv-cell-input od-inline-input" data-record="${inv.recordId}" data-field="${INV.desc}" data-type="text" value="${escHtml(displayDesc)}" placeholder="Description…">`;
            const refHtml = `<input type="text" class="inv-cell-input inv-cell-ref od-inline-input" data-record="${inv.recordId}" data-field="${INV.ref}" data-type="text" value="${escHtml(displayRef)}" placeholder="Ref…" style="font-family:monospace;font-size:11px">`;

            // Business cell — always-visible <select> populated with active businesses only.
            // If the invoice already points at an inactive business we still show that option
            // so the value is preserved on render.
            const currentBizId = (inv.businessIds && inv.businessIds[0]) || '';
            const bizPickList = getActiveBusinesses();
            if (currentBizId && !bizPickList.some(b => b.id === currentBizId)) {
                const cur = (allBusinesses || []).find(b => b.id === currentBizId);
                if (cur) bizPickList.push(cur);
            }
            const bizOptions = ['<option value="">— None —</option>'].concat(
                bizPickList.map(b => {
                    const nm = getField(b, BIZ_NAME_FIELD);
                    const label = (typeof nm === 'string' ? nm : (nm && nm.name) || b.id);
                    return `<option value="${b.id}"${b.id === currentBizId ? ' selected' : ''}>${escHtml(label)}</option>`;
                })
            ).join('');
            const businessHtml = `<select class="inv-cell-input inv-cell-business od-inline-input" data-record="${inv.recordId}" data-field="${INV.business}" data-type="link" style="cursor:pointer">${bizOptions}</select>`;

            const gmailUrl = inv.gmailUrl || `https://mail.google.com/mail/u/0/#all/${inv.id}`;
            const threadId = inv.threadId || inv.id;
            const isSelected = invSelectedIds.has(inv.recordId);
            const checkboxHtml = `<input type="checkbox" class="inv-row-check" data-record="${inv.recordId}"${isSelected ? ' checked' : ''} title="Select for bulk action">`;
            const gmailLinkHtml = `<a href="${gmailUrl}" target="_blank" class="inv-gmail-link" title="Open in Gmail" style="font-size:13px;text-decoration:none;margin-left:6px">📧</a>`;

            // AI match suggestion row
            let matchRow = '';
            if (match && !inv.matchRejected) {
                matchRow = `<tr class="inv-match-suggestion" id="inv-match-${idx}">
                    <td colspan="9" style="padding:6px 12px;background:var(--info-bg);border-left:3px solid var(--info)">
                        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                            <span style="font-size:11px;font-weight:700;color:var(--info)">🤖 AI Match Found:</span>
                            <span style="font-size:12px;color:var(--text-primary)">${escHtml(match.txDate)} · ${escHtml(match.txLabel)} · <strong>${fmt(Math.abs(match.txAmount))}</strong></span>
                            <div style="margin-left:auto;display:flex;gap:6px">
                                <button class="inv-approve-btn" onclick="event.stopPropagation(); approveMatch('${escJs(inv.recordId)}','${escJs(threadId)}','${escJs(match.txRecordId)}','${escJs(gmailUrl)}',this,${idx})" title="Approve this match and move to paid">✓ Approve</button>
                                <button class="inv-reject-btn" onclick="event.stopPropagation(); rejectMatch('${inv.recordId}',${idx})" title="Dismiss this suggestion">✗ Reject</button>
                            </div>
                        </div>
                    </td>
                </tr>`;
            }

            // Action column
            const actionHtml = `<button class="inv-mark-paid-btn" onclick="event.stopPropagation(); markInvoicePaid('${escJs(inv.recordId)}','${escJs(threadId)}','','${escJs(gmailUrl)}',this)" title="Mark as paid — updates Airtable + moves Gmail label">Mark Paid</button>`;

            return `<tr data-record-id="${inv.recordId}"${isSelected ? ' class="inv-row-selected"' : ''}>
                <td style="text-align:center;width:32px">${checkboxHtml}</td>
                <td style="text-align:center;color:var(--text-muted);font-size:11px;font-weight:600">${idx + 1}</td>
                <td style="white-space:nowrap;min-width:120px">${dateCell}${gmailLinkHtml}<br>${badge}</td>
                <td style="max-width:180px">${payeeHtml}</td>
                <td style="max-width:280px">${descHtml}</td>
                <td style="white-space:nowrap;max-width:130px">${refHtml}</td>
                <td style="white-space:nowrap;max-width:120px">${amountHtml}</td>
                <td style="white-space:nowrap;max-width:140px">${businessHtml}</td>
                <td style="width:110px;text-align:center">${actionHtml}</td>
            </tr>${matchRow}`;
        }).join('');

        // ── Wire up cell input save (delegate via tbody) ──
        // Save fires on `change` for selects/numbers and on `blur` for text inputs.
        // Each input has data-record + data-field + data-type.
        if (!tbody.dataset.cellHandlersWired) {
            tbody.addEventListener('change', handleCellInputChange);
            tbody.addEventListener('blur', handleCellInputBlur, true); // capture
            tbody.addEventListener('keydown', handleCellInputKey);
            tbody.addEventListener('click', handleCheckboxClick);
            tbody.dataset.cellHandlersWired = 'true';
        }

        // Refresh bulk bar / select-all checkbox state to match invSelectedIds
        refreshBulkBarUI(sorted);

        // Tab is being viewed — mark invoices as seen so sidebar badge clears next refresh
        markInvoicesAsSeen();
        updateInvoicesSidebarBadge();

        // ── Sync Bar + Health Checks ──
        if (typeof registerSyncBar === 'function') {
            registerSyncBar('invoices', {
                // Re-fetch from Airtable (and trigger Gmail sync) — fetchInvoicesFromAirtable's
                // success path calls renderInvoiceTab which re-runs markTabSynced.
                refreshFn: async () => {
                    if (typeof triggerGmailInvoiceSync === 'function') triggerGmailInvoiceSync();
                    await fetchInvoicesFromAirtable();
                },
                checks: [
                    {
                        name: 'Invoices fetched from Airtable', kind: 'sync', run: () => {
                            const n = (airtableInvoices || []).length;
                            if (n === 0) return { status: 'warn', detail: 'No invoices loaded yet — Airtable fetch may be in flight' };
                            return { status: 'pass', detail: `${n} invoice records loaded (all statuses)` };
                        }
                    },
                    {
                        name: 'Outstanding invoices count', kind: 'sync', run: () => {
                            const open = (airtableInvoices || []).filter(inv => inv.status !== 'Paid');
                            return { status: 'pass', detail: `${open.length} not yet paid · ${(airtableInvoices||[]).length - open.length} marked Paid` };
                        }
                    },
                    {
                        name: 'Each invoice has Gmail thread link', kind: 'sync', run: () => {
                            const invs = airtableInvoices || [];
                            const missing = invs.filter(inv => !inv.gmailUrl && !inv.threadId);
                            if (missing.length) return { status: 'warn', detail: `${missing.length} invoices missing Gmail link — may have been imported manually` };
                            return { status: 'pass', detail: `All ${invs.length} invoices link back to their Gmail thread` };
                        }
                    },
                    {
                        name: 'Match-to-transaction matcher functioning', kind: 'automation', run: () => {
                            if (typeof matchInvoicesToTransactions !== 'function') return { status: 'fail', detail: 'matchInvoicesToTransactions() not loaded' };
                            try {
                                const unpaid = (airtableInvoices || []).filter(i => i.status !== 'Paid');
                                const matches = matchInvoicesToTransactions(unpaid, allTransactions || []) || {};
                                const matched = Object.values(matches).filter(m => m && m.txRecordId).length;
                                return { status: 'pass', detail: `${matched} of ${unpaid.length} unpaid invoices matched to a reconciled transaction` };
                            } catch (e) {
                                return { status: 'fail', detail: 'Matcher threw: ' + e.message };
                            }
                        }
                    },
                    {
                        name: 'Gmail sync script reachable', kind: 'automation', run: () => {
                            if (!GMAIL_SCRIPT_URL) return { status: 'warn', detail: 'GMAIL_SCRIPT_URL not configured in config.js' };
                            return { status: 'pass', detail: 'Apps Script web app URL configured · last fetch fires every dashboard load' };
                        }
                    },
                    {
                        name: 'Sidebar "new invoices" badge wired', kind: 'automation', run: () => {
                            if (typeof updateInvoicesSidebarBadge !== 'function') return { status: 'fail', detail: 'updateInvoicesSidebarBadge() not loaded' };
                            return { status: 'pass', detail: 'Badge updates on render and after fetch' };
                        }
                    },
                    {
                        name: 'Last Mark-Paid / AI match approval', kind: 'automation', run: () => {
                            if (!lastApprovalAttempt) {
                                return { status: 'pass', detail: 'No approvals yet this session' };
                            }
                            const when = lastApprovalAttempt.when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                            const verb = lastApprovalAttempt.action === 'approveMatch' ? 'AI match approval' : 'Mark Paid';
                            if (lastApprovalAttempt.ok) {
                                return { status: 'pass', detail: `${verb} succeeded at ${when}` };
                            }
                            return { status: 'fail', detail: `${verb} failed at ${when}: ${lastApprovalAttempt.error}` };
                        }
                    },
                ],
            });
            markTabSynced('invoices');
        }
    }

    // ── Match invoices to Airtable transactions ──
    function matchInvoicesToTransactions(invoices, transactions) {
        const matches = {};
        if (!transactions || !transactions.length) return matches;

        invoices.forEach(inv => {
            const invAmount = inv.amount;
            if (invAmount === null || invAmount === 0) return;
            const invKeywords = extractInvKeywords((inv.payee || '') + ' ' + (inv.desc || ''));
            const invDate = new Date(inv.dueDate || inv.emailDate);

            for (const tx of transactions) {
                const txAmt = Math.abs(Number(getField(tx, F.txReportAmount)) || 0);
                if (txAmt === 0) continue;
                if (Math.abs(txAmt - invAmount) > 0.02) continue;

                const txDateStr = getField(tx, F.txDate);
                if (!txDateStr) continue;
                const txDate = new Date(txDateStr);
                if (txDate < invDate) continue;

                const txVendor = String(getField(tx, F.txVendor) || '').toLowerCase();
                const txDesc = String(getField(tx, F.txDescription) || '').toLowerCase();
                const txText = txVendor + ' ' + txDesc;

                let kwMatches = 0;
                let longKwMatch = false;
                invKeywords.forEach(kw => {
                    if (txText.includes(kw)) {
                        kwMatches++;
                        if (kw.length >= 5) longKwMatch = true;
                    }
                });

                if (kwMatches >= 2 || (kwMatches >= 1 && longKwMatch)) {
                    const matchKey = inv.id || inv.threadId;
                    matches[matchKey] = {
                        txRecordId: tx.id,
                        txDate: txDateStr,
                        txLabel: txLabel(tx),
                        txAmount: txAmt,
                    };
                    break;
                }
            }
        });
        return matches;
    }

    function extractInvKeywords(text) {
        const stop = new Set(['invoice','inv','ltd','limited','the','and','for','from','via',
            'payment','estimate','fwd','re','hi','dear','please','find','attached','kind',
            'regards','sir','madame','thank','thanks','your','our','this','that','has','was']);
        return text.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 3 && !stop.has(w));
    }

    // ══════════════════════════════════════════
    // Always-visible spreadsheet-style cell inputs
    // ══════════════════════════════════════════

    // Update local airtableInvoices array so re-renders preserve the edit
    function _updateLocalInv(recordId, fieldId, value) {
        const inv = airtableInvoices.find(i => i.recordId === recordId);
        if (!inv) return;
        if (fieldId === INV.amount) inv.amount = value;
        else if (fieldId === INV.payee) inv.payee = value;
        else if (fieldId === INV.desc) inv.desc = value;
        else if (fieldId === INV.ref) inv.ref = value;
        else if (fieldId === INV.dueDate) inv.dueDate = value;
        else if (fieldId === INV.business) inv.businessIds = Array.isArray(value) ? value : (value ? [value] : []);
    }

    // Compare current input value against the stored value to skip no-op saves
    function _inputDirty(input, recordId, fieldId) {
        const inv = airtableInvoices.find(i => i.recordId === recordId);
        if (!inv) return true;
        if (fieldId === INV.amount) {
            const v = input.value.trim();
            const num = v === '' ? null : parseFloat(v);
            return (num === null) !== (inv.amount === null) || (num !== null && Math.abs((num || 0) - (inv.amount || 0)) > 0.001);
        }
        if (fieldId === INV.business) {
            const cur = (inv.businessIds && inv.businessIds[0]) || '';
            return input.value !== cur;
        }
        const map = { [INV.payee]:'payee', [INV.desc]:'desc', [INV.ref]:'ref' };
        const k = map[fieldId];
        if (k) return input.value.trim() !== (inv[k] || '');
        return true;
    }

    async function saveCellInput(input) {
        const recordId = input.dataset.record;
        const fieldId = input.dataset.field;
        const type = input.dataset.type;
        if (!recordId || !fieldId) return;
        if (!_inputDirty(input, recordId, fieldId)) return; // no-op

        let fieldValue;
        if (type === 'number') {
            const v = input.value.trim();
            if (v === '') fieldValue = null;
            else {
                const num = parseFloat(v);
                if (isNaN(num) || num < 0) { input.value = ''; return; }
                fieldValue = num;
            }
        } else if (type === 'link') {
            fieldValue = input.value ? [input.value] : [];
        } else {
            fieldValue = input.value.trim();
        }

        input.disabled = true;
        let saveOk = false;
        try {
            const body = { fields: { [fieldId]: fieldValue } };
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.invoices}/${recordId}?returnFieldsByFieldId=true`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            _updateLocalInv(recordId, fieldId, type === 'link' ? (input.value ? input.value : '') : fieldValue);
            saveOk = true;
        } catch (e) {
            console.error('Cell save failed:', e);
        } finally {
            input.disabled = false;
        }
        // After a successful number save, reformat input to two decimals (e.g. "40" → "40.00")
        if (saveOk && type === 'number' && fieldValue !== null) {
            input.value = Number(fieldValue).toFixed(2);
        }
        // Flash the input's parent cell
        const td = input.closest('td');
        if (td) {
            td.classList.add(saveOk ? 'inv-flash-ok' : 'inv-flash-fail');
            setTimeout(() => td.classList.remove('inv-flash-ok', 'inv-flash-fail'), 1500);
        }
    }

    function handleCellInputChange(e) {
        const t = e.target;
        if (!t.classList || !t.classList.contains('inv-cell-input')) return;
        // selects + numbers save on change
        if (t.tagName === 'SELECT' || t.dataset.type === 'number') saveCellInput(t);
    }

    function handleCellInputBlur(e) {
        const t = e.target;
        if (!t.classList || !t.classList.contains('inv-cell-input')) return;
        // text saves on blur (so user can keep typing without commit on every keystroke)
        if (t.tagName === 'INPUT' && t.dataset.type === 'text') saveCellInput(t);
    }

    function handleCellInputKey(e) {
        const t = e.target;
        if (!t.classList || !t.classList.contains('inv-cell-input')) return;
        if (e.key === 'Enter' && t.tagName === 'INPUT') {
            t.blur(); // triggers save via blur handler
            e.preventDefault();
        }
        if (e.key === 'Escape' && t.tagName === 'INPUT') {
            // Revert to stored value
            const inv = airtableInvoices.find(i => i.recordId === t.dataset.record);
            if (inv) {
                if (t.dataset.field === INV.amount) t.value = inv.amount !== null ? inv.amount : '';
                else if (t.dataset.field === INV.payee) t.value = inv.payee || '';
                else if (t.dataset.field === INV.desc) t.value = inv.desc || '';
                else if (t.dataset.field === INV.ref) t.value = inv.ref || '';
            }
            t.blur();
        }
    }

    function handleCheckboxClick(e) {
        const cb = e.target;
        if (!cb.classList || !cb.classList.contains('inv-row-check')) return;
        const recordId = cb.dataset.record;
        if (!recordId) return;
        if (cb.checked) invSelectedIds.add(recordId);
        else invSelectedIds.delete(recordId);
        const tr = cb.closest('tr');
        if (tr) tr.classList.toggle('inv-row-selected', cb.checked);
        refreshBulkBarUI();
    }

    // Update bulk-action bar visibility/count and the select-all checkbox state
    function refreshBulkBarUI(currentlyVisible) {
        const bar = document.getElementById('invBulkBar');
        const countEl = document.getElementById('invBulkCount');
        const selAll = document.getElementById('invSelectAll');
        const bulkSelect = document.getElementById('invBulkBusinessSelect');
        if (!bar) return;
        const n = invSelectedIds.size;
        bar.style.display = n > 0 ? 'flex' : 'none';
        if (countEl) countEl.textContent = `${n} selected`;
        // Re-populate bulk business dropdown every time. Only ACTIVE businesses (filtered by
        // the BIZ_ACTIVE_FIELD checkbox) — same as the per-row dropdowns. Inactive businesses
        // shouldn't be assignable in bulk operations.
        if (bulkSelect) {
            const businesses = (typeof getActiveBusinesses === 'function')
                ? getActiveBusinesses()
                : (allBusinesses || []);
            const previousValue = bulkSelect.value;
            bulkSelect.innerHTML = '<option value="">— None —</option>' +
                businesses.map(b => {
                    const nm = getField(b, BIZ_NAME_FIELD);
                    const label = (typeof nm === 'string' ? nm : (nm && nm.name) || b.id);
                    return `<option value="${b.id}">${escHtml(label)}</option>`;
                }).join('');
            // Preserve user's selection if they already picked one
            if (previousValue) bulkSelect.value = previousValue;
        }
        // Sync select-all header checkbox
        if (selAll && currentlyVisible) {
            const visibleIds = currentlyVisible.map(i => i.recordId);
            const allSelected = visibleIds.length > 0 && visibleIds.every(id => invSelectedIds.has(id));
            selAll.checked = allSelected;
            selAll.indeterminate = !allSelected && visibleIds.some(id => invSelectedIds.has(id));
            // (Re-)wire change handler for select-all (idempotent: reassigning is fine)
            selAll.onchange = () => {
                if (selAll.checked) visibleIds.forEach(id => invSelectedIds.add(id));
                else visibleIds.forEach(id => invSelectedIds.delete(id));
                renderInvoiceTab();
            };
        }
    }

    function clearInvoiceSelection() {
        invSelectedIds.clear();
        renderInvoiceTab();
    }

    async function applyBulkBusiness() {
        const sel = document.getElementById('invBulkBusinessSelect');
        if (!sel) return;
        const bizId = sel.value;
        const ids = Array.from(invSelectedIds);
        if (ids.length === 0) return;
        const bizLabel = bizId ? sel.options[sel.selectedIndex].text : 'None';
        if (!confirm(`Set business to "${bizLabel}" on ${ids.length} invoice${ids.length > 1 ? 's' : ''}?`)) return;
        // Airtable API allows up to 10 record updates per PATCH. Chunk them.
        const fieldValue = bizId ? [bizId] : [];
        let succeeded = 0, failed = 0;
        for (let i = 0; i < ids.length; i += 10) {
            const chunk = ids.slice(i, i + 10);
            const records = chunk.map(id => ({ id, fields: { [INV.business]: fieldValue } }));
            try {
                const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.invoices}?returnFieldsByFieldId=true`, {
                    method: 'PATCH',
                    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ records })
                });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                chunk.forEach(id => _updateLocalInv(id, INV.business, fieldValue));
                succeeded += chunk.length;
            } catch (e) {
                console.error('Bulk business update chunk failed:', e);
                failed += chunk.length;
            }
        }
        // Clear selection and re-render
        invSelectedIds.clear();
        renderInvoiceTab();
        if (failed > 0) alert(`Updated ${succeeded} of ${ids.length}. ${failed} failed — see console.`);
    }

    // ── Bulk mark selected invoices as Paid: batch Airtable status + per-thread Gmail label move ──
    async function applyBulkMarkPaid() {
        const btn = document.getElementById('invBulkMarkPaidBtn');
        // Only act on selected invoices that are still in the (unpaid) list and not already Paid
        const targets = Array.from(invSelectedIds)
            .map(id => airtableInvoices.find(i => i.recordId === id))
            .filter(inv => inv && inv.status !== 'Paid');
        if (targets.length === 0) return;

        const total = targets.reduce((sum, inv) => sum + (Number(inv.amount) || 0), 0);
        const totalLabel = (typeof fmt === 'function') ? fmt(total) : '£' + total.toFixed(2);
        if (!confirm(`Mark ${targets.length} invoice${targets.length > 1 ? 's' : ''} as Paid?\n\nTotal: ${totalLabel}\n\nThis updates Airtable and moves each Gmail label from "3. to pay" to "4: paid".`)) return;

        if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
        const today = new Date().toISOString().slice(0, 10);
        let succeeded = 0, failed = 0;
        const paidIds = [];

        // 1. Airtable status update — chunk to 10 records per PATCH (API limit)
        for (let i = 0; i < targets.length; i += 10) {
            const chunk = targets.slice(i, i + 10);
            const records = chunk.map(inv => ({
                id: inv.recordId,
                fields: { [INV.status]: 'Paid', [INV.paidDate]: today }
            }));
            try {
                const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.invoices}?returnFieldsByFieldId=true`, {
                    method: 'PATCH',
                    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ records })
                });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                chunk.forEach(inv => paidIds.push(inv.recordId));
                succeeded += chunk.length;
            } catch (e) {
                console.error('Bulk mark-paid chunk failed:', e);
                failed += chunk.length;
            }
        }

        // 2. Move Gmail label "3. to pay" → "4: paid" for each successfully paid invoice (fire-and-forget)
        if (GMAIL_SCRIPT_URL) {
            for (const recordId of paidIds) {
                const inv = airtableInvoices.find(i => i.recordId === recordId);
                const threadId = inv && (inv.threadId || inv.id);
                if (!threadId) continue;
                try {
                    const url = GMAIL_SCRIPT_URL + '?action=markPaid&threadId=' + encodeURIComponent(threadId);
                    await fetch(url, { redirect: 'follow', mode: 'no-cors' });
                } catch (fetchErr) {
                    console.warn('Gmail bulk mark-paid failed (will retry on next sync):', fetchErr.message);
                }
            }
        }

        // 3. Remove paid invoices from local state, clear selection, re-render
        airtableInvoices = airtableInvoices.filter(i => !paidIds.includes(i.recordId));
        invSelectedIds.clear();
        updateInvoicesSidebarBadge();
        lastApprovalAttempt = { ok: failed === 0, when: new Date(), error: failed ? `${failed} failed` : null, action: 'markPaid' };
        invoiceTabRendered = false;
        renderInvoiceTab();
        setTimeout(() => { if (typeof fetchGmailLabelCount === 'function') fetchGmailLabelCount(); }, 3500);

        if (btn) { btn.disabled = false; btn.textContent = 'Mark as Paid'; }
        if (failed > 0) alert(`Marked ${succeeded} of ${targets.length} as Paid. ${failed} failed — see console.`);
    }

    // ── Click-to-edit any invoice field — saves to Airtable ──
    function editInvField(el, recordId, fieldId, inputType) {
        const input = document.createElement('input');
        input.type = inputType === 'number' ? 'number' : 'text';
        if (inputType === 'number') { input.step = '0.01'; input.placeholder = '0.00'; }
        else { input.placeholder = fieldId === INV.payee ? 'Payee name' : fieldId === INV.desc ? 'Description' : fieldId === INV.ref ? 'Invoice ref' : 'Value'; }
        // Pre-populate with current value so corrections don't require retyping
        const currentInv = airtableInvoices.find(i => i.recordId === recordId);
        if (currentInv) {
            const currentVal = fieldId === INV.amount ? currentInv.amount
                : fieldId === INV.payee ? currentInv.payee
                : fieldId === INV.desc ? currentInv.desc
                : fieldId === INV.ref ? currentInv.ref
                : fieldId === INV.dueDate ? currentInv.dueDate
                : null;
            if (currentVal !== null && currentVal !== undefined && currentVal !== '') {
                input.value = String(currentVal);
            }
        }
        const w = inputType === 'number' ? '90px' : (fieldId === INV.ref ? '110px' : '170px');
        input.className = 'od-inline-input';
        input.style.cssText = `width:${w};border-color:var(--info);${inputType === 'number' ? 'text-align:right;' : ''}`;

        async function save() {
            const val = input.value.trim();
            if (!val) { renderInvoiceTab(); return; }
            let fieldValue;
            if (inputType === 'number') {
                const num = parseFloat(val);
                if (isNaN(num) || num <= 0) { renderInvoiceTab(); return; }
                fieldValue = num;
            } else {
                fieldValue = val;
            }
            // Save to Airtable
            input.disabled = true;
            input.style.opacity = '0.5';
            let saveOk = false;
            try {
                const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.invoices}/${recordId}?returnFieldsByFieldId=true`, {
                    method: 'PATCH',
                    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: { [fieldId]: fieldValue } })
                });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                // Update local data so re-render shows new value without refetching
                const inv = airtableInvoices.find(i => i.recordId === recordId);
                if (inv) {
                    if (fieldId === INV.amount) inv.amount = fieldValue;
                    else if (fieldId === INV.payee) inv.payee = fieldValue;
                    else if (fieldId === INV.desc) inv.desc = fieldValue;
                    else if (fieldId === INV.ref) inv.ref = fieldValue;
                    else if (fieldId === INV.dueDate) inv.dueDate = fieldValue;
                }
                saveOk = true;
            } catch (e) {
                console.error('Failed to save invoice field to Airtable:', e);
            }
            // Map field to column index: payee=2, desc=3, ref=4, amount=5
            const flashCol = fieldId === INV.payee ? 2 : fieldId === INV.desc ? 3 : fieldId === INV.ref ? 4 : fieldId === INV.amount ? 5 : -1;
            renderInvoiceTab();
            // Flash the cell green (saved) or red (failed) after re-render
            if (flashCol >= 0) {
                const newRow = document.querySelector(`tr[data-record-id="${recordId}"]`);
                const newTd = newRow && newRow.cells[flashCol];
                if (newTd) {
                    newTd.classList.add(saveOk ? 'inv-flash-ok' : 'inv-flash-fail');
                    setTimeout(() => newTd.classList.remove('inv-flash-ok', 'inv-flash-fail'), 1500);
                }
            }
        }

        input.onkeydown = function(e) {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') renderInvoiceTab();
        };
        input.onblur = save;
        el.replaceWith(input);
        input.focus();
        // Pre-select the current value so typing immediately replaces it
        if (input.value) input.select();
    }

    // ── Click-to-edit Business field (linked record dropdown) — saves to Airtable ──
    function editInvBusiness(el, recordId) {
        const inv = airtableInvoices.find(i => i.recordId === recordId);
        const currentBizId = (inv && inv.businessIds && inv.businessIds[0]) || '';
        const select = document.createElement('select');
        select.className = 'od-inline-input';
        select.style.cssText = 'border-color:var(--info);cursor:pointer';
        // Empty option for "no business assigned"
        const blank = document.createElement('option');
        blank.value = ''; blank.textContent = '— None —';
        select.appendChild(blank);
        const bizPickList = getActiveBusinesses();
        if (currentBizId && !bizPickList.some(b => b.id === currentBizId)) {
            const cur = (allBusinesses || []).find(b => b.id === currentBizId);
            if (cur) bizPickList.push(cur);
        }
        bizPickList.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.id;
            const nm = getField(b, BIZ_NAME_FIELD);
            opt.textContent = (typeof nm === 'string' ? nm : (nm && nm.name) || b.id);
            if (b.id === currentBizId) opt.selected = true;
            select.appendChild(opt);
        });

        async function save() {
            const newBizId = select.value;
            const fieldValue = newBizId ? [newBizId] : [];
            select.disabled = true;
            select.style.opacity = '0.5';
            let saveOk = false;
            try {
                const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.invoices}/${recordId}?returnFieldsByFieldId=true`, {
                    method: 'PATCH',
                    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: { [INV.business]: fieldValue } })
                });
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                if (inv) inv.businessIds = fieldValue;
                saveOk = true;
            } catch (e) {
                console.error('Failed to save business:', e);
            }
            renderInvoiceTab();
            // Flash the cell green/red after re-render. Business is column index 6 (after Business header insert).
            const newRow = document.querySelector(`tr[data-record-id="${recordId}"]`);
            const newTd = newRow && newRow.cells[6];
            if (newTd) {
                newTd.classList.add(saveOk ? 'inv-flash-ok' : 'inv-flash-fail');
                setTimeout(() => newTd.classList.remove('inv-flash-ok', 'inv-flash-fail'), 1500);
            }
        }

        // Save on change. Escape or click-away cancels by re-rendering.
        select.onchange = save;
        select.onblur = function() { if (!select.disabled) renderInvoiceTab(); };
        select.onkeydown = function(e) { if (e.key === 'Escape') renderInvoiceTab(); };
        el.replaceWith(select);
        select.focus();
    }

    // ── Approve AI match — mark paid in Airtable + move Gmail label ──
    async function approveMatch(recordId, threadId, txRecordId, gmailUrl, btn, rowIdx) {
        const suggRow = document.getElementById('inv-match-' + rowIdx);
        if (suggRow) suggRow.style.display = 'none';

        const parentRow = suggRow ? suggRow.previousElementSibling : null;
        const markBtn = parentRow ? parentRow.querySelector('.inv-mark-paid-btn') : btn;
        await markInvoicePaid(recordId, threadId, txRecordId, gmailUrl, markBtn || btn);
    }

    // ── Reject AI match — persist rejection in Airtable ──
    async function rejectMatch(recordId, rowIdx) {
        const suggRow = document.getElementById('inv-match-' + rowIdx);
        if (suggRow) suggRow.style.display = 'none';
        // Persist rejection in Airtable so it doesn't reappear
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.invoices}/${recordId}?returnFieldsByFieldId=true`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: { [INV.matchRejected]: true } })
            });
            if (!resp.ok) throw new Error('Reject save failed: HTTP ' + resp.status);
            const inv = airtableInvoices.find(i => i.recordId === recordId);
            if (inv) inv.matchRejected = true;
        } catch (e) {
            console.error('Failed to save match rejection:', e);
        }
    }

    // ── Mark invoice as paid: update Airtable + move Gmail label + link transaction ──
    async function markInvoicePaid(recordId, threadId, txRecordId, gmailUrl, btn) {
        btn.classList.add('loading');
        btn.textContent = 'Processing...';

        try {
            // 1. Update Airtable: status → Paid, set paid date, link transaction if matched
            const paidFields = {
                [INV.status]: 'Paid',
                [INV.paidDate]: new Date().toISOString().slice(0, 10),
            };
            if (txRecordId) {
                // Linked record fields take an array of record ID strings, not objects
                paidFields[INV.matchedTx] = [txRecordId];
            }
            const paidResp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.invoices}/${recordId}?returnFieldsByFieldId=true`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: paidFields })
            });
            if (!paidResp.ok) {
                const errBody = await paidResp.text();
                throw new Error('Airtable mark-paid failed: HTTP ' + paidResp.status + ' ' + errBody);
            }

            // 2. Move Gmail label from "3. to pay" to "4: paid"
            if (GMAIL_SCRIPT_URL && threadId) {
                try {
                    const url = GMAIL_SCRIPT_URL + '?action=markPaid&threadId=' + encodeURIComponent(threadId);
                    await fetch(url, { redirect: 'follow', mode: 'no-cors' });
                } catch (fetchErr) {
                    console.warn('Gmail mark-paid failed (will retry on next sync):', fetchErr.message);
                }
            }

            // 3. Attach Gmail link to the Airtable transaction's "Invoice Data" field
            if (txRecordId && PAT) {
                const txResp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${txRecordId}?returnFieldsByFieldId=true`, {
                    method: 'PATCH',
                    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: { [F.txInvoiceData]: gmailUrl } })
                });
                if (!txResp.ok) console.warn('Transaction link failed:', txResp.status);
            }

            btn.textContent = 'Done';
            btn.style.background = 'var(--success-bg)';
            btn.style.color = 'var(--success)';
            btn.style.borderColor = 'var(--success)';

            // Remove from local array and re-render
            airtableInvoices = airtableInvoices.filter(i => i.recordId !== recordId);
            updateInvoicesSidebarBadge();
            // Record success for the health checks panel
            lastApprovalAttempt = { ok: true, when: new Date(), error: null, action: txRecordId ? 'approveMatch' : 'markPaid' };
            setTimeout(() => {
                invoiceTabRendered = false;
                renderInvoiceTab();
            }, 1500);
            // Re-fetch Gmail count after the label-move has had time to propagate
            // (Apps Script call was fire-and-forget no-cors, so we wait ~3s then poll)
            setTimeout(() => { if (typeof fetchGmailLabelCount === 'function') fetchGmailLabelCount(); }, 3500);

        } catch (e) {
            console.error('Mark as paid failed:', e);
            // Record failure for the health checks panel — this is what the user will see
            lastApprovalAttempt = { ok: false, when: new Date(), error: e.message || String(e), action: txRecordId ? 'approveMatch' : 'markPaid' };
            btn.textContent = 'Failed';
            btn.style.background = 'var(--danger-bg)';
            btn.classList.remove('loading');
            setTimeout(() => { btn.textContent = 'Mark Paid'; btn.style.background = ''; }, 3000);
        }
    }


    // ══════════════════════════════════════════
