// ══════════════════════════════════════════
// INVOICES TAB — Fetch, Render, Match, Approve, Pay
// ══════════════════════════════════════════
    // ── Invoices Tab — backed by Airtable ──
    let airtableInvoices = [];
    let invoiceRefreshedAt = null;

    async function fetchInvoicesFromAirtable() {
        if (!PAT) return;
        try {
            const params = new URLSearchParams({
                'filterByFormula': "NOT({Status}='Paid')",
                'sort[0][field]': 'Email Date',
                'sort[0][direction]': 'asc',
                'returnFieldsByFieldId': 'true',
            });
            const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLES.invoices}?${params}`;
            const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + PAT } });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            airtableInvoices = data.records.map(r => {
                const f = r.fields;
                return {
                    recordId:      r.id,
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
                };
            });
            invoiceRefreshedAt = new Date();
            invoiceTabRendered = false;
            if (document.getElementById('tab-invoices').classList.contains('active')) {
                renderInvoiceTab();
            }
            fetchGmailLabelCount();
        } catch (e) {
            console.warn('Airtable invoice fetch failed:', e.message);
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
        const dashCount = airtableInvoices.filter(inv => inv.status !== 'Paid').length;
        if (lastGmailCount === null) {
            el.innerHTML = `<span style="color:#64748b">Dashboard: <strong>${dashCount}</strong> unpaid</span>`;
        } else if (dashCount === lastGmailCount) {
            el.innerHTML = `<span style="color:#16a34a">Dashboard: <strong>${dashCount}</strong> | Gmail: <strong>${lastGmailCount}</strong> ✓ In sync</span>`;
        } else {
            el.innerHTML = `<span style="color:#d97706">Dashboard: <strong>${dashCount}</strong> | Gmail: <strong>${lastGmailCount}</strong> ⚠️ Mismatch</span>`;
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

        // Source data comes directly from Airtable — no localStorage merging needed
        const sourceData = airtableInvoices.filter(inv => inv.status !== 'Paid');

        // Update the "Last refreshed" text
        const refreshSpan = document.querySelector('#tab-invoices .section span[style*="font-size:12px"]');
        if (refreshSpan) {
            const refreshTime = invoiceRefreshedAt
                ? invoiceRefreshedAt.toLocaleString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
                : 'Not yet loaded';
            const statusLabel = airtableInvoices.length > 0
                ? '<span style="color:#16a34a;font-weight:600">Airtable</span>'
                : '<span style="color:#d97706;font-weight:600">Loading…</span>';
            refreshSpan.innerHTML = `Source: <strong style="color:#64748b">Airtable → Gmail</strong> &nbsp;·&nbsp; ${statusLabel} &nbsp;·&nbsp; Last refreshed: <strong style="color:#64748b">${refreshTime}</strong> &nbsp;·&nbsp; <a href="#" onclick="event.preventDefault(); triggerGmailInvoiceSync(); this.textContent='Syncing…'; setTimeout(()=>this.textContent='Refresh from Gmail',4000)" style="color:#2563eb;font-size:11px;text-decoration:underline">Refresh from Gmail</a> &nbsp;·&nbsp; <span id="invSyncHealth" style="font-size:11px"></span>`;
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
                    <div class="kpi-card-value" style="color:#94a3b8">${unknownCount}</div>
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

            const displayAmt = inv.amount;
            const displayPayee = (inv.payee || '').trim();
            const displayDesc = (inv.desc || '').trim();
            const displayRef = (inv.ref || '').trim();

            // Editable fields — click empty ones to enter data (saves to Airtable)
            const amountHtml = displayAmt !== null
                ? `<span class="inv-amount">${fmt(displayAmt)}</span>`
                : `<span class="inv-amount unknown" onclick="event.stopPropagation(); editInvField(this,'${inv.recordId}','${INV.amount}','number')" title="Click to enter amount" style="cursor:pointer">Enter £ ✏️</span>`;

            const payeeHtml = displayPayee
                ? escHtml(displayPayee)
                : `<span style="color:#94a3b8;cursor:pointer" onclick="event.stopPropagation(); editInvField(this,'${inv.recordId}','${INV.payee}','text')" title="Click to enter payee">Enter payee ✏️</span>`;

            const descHtml = displayDesc
                ? escHtml(displayDesc)
                : `<span style="color:#94a3b8;cursor:pointer" onclick="event.stopPropagation(); editInvField(this,'${inv.recordId}','${INV.desc}','text')" title="Click to enter description">Enter description ✏️</span>`;

            const refHtml = displayRef
                ? `<span style="font-family:monospace;font-size:11px;color:#64748b">${escHtml(displayRef)}</span>`
                : `<span style="color:#94a3b8;cursor:pointer;font-size:11px" onclick="event.stopPropagation(); editInvField(this,'${inv.recordId}','${INV.ref}','text')" title="Click to enter ref">Add ref ✏️</span>`;

            const gmailUrl = inv.gmailUrl || `https://mail.google.com/mail/u/0/#all/${inv.id}`;
            const threadId = inv.threadId || inv.id;

            // AI match suggestion row
            let matchRow = '';
            if (match && !inv.matchRejected) {
                matchRow = `<tr class="inv-match-suggestion" id="inv-match-${idx}">
                    <td colspan="7" style="padding:6px 12px;background:#eff6ff;border-left:3px solid #2563eb">
                        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                            <span style="font-size:11px;font-weight:700;color:#2563eb">🤖 AI Match Found:</span>
                            <span style="font-size:12px;color:#1e293b">${escHtml(match.txDate)} · ${escHtml(match.txLabel)} · <strong>${fmt(Math.abs(match.txAmount))}</strong></span>
                            <div style="margin-left:auto;display:flex;gap:6px">
                                <button class="inv-approve-btn" onclick="event.stopPropagation(); approveMatch('${inv.recordId}','${threadId}','${match.txRecordId}','${gmailUrl}',this,${idx})" title="Approve this match and move to paid">✓ Approve</button>
                                <button class="inv-reject-btn" onclick="event.stopPropagation(); rejectMatch('${inv.recordId}',${idx})" title="Dismiss this suggestion">✗ Reject</button>
                            </div>
                        </div>
                    </td>
                </tr>`;
            }

            // Action column
            const actionHtml = `<button class="inv-mark-paid-btn" onclick="event.stopPropagation(); markInvoicePaid('${inv.recordId}','${threadId}','','${gmailUrl}',this)" title="Mark as paid — updates Airtable + moves Gmail label">Mark Paid</button>`;

            return `<tr data-record-id="${inv.recordId}" onclick="window.open('${gmailUrl}','_blank')" title="Open in Gmail">
                <td style="text-align:center;color:#94a3b8;font-size:11px;font-weight:600">${idx + 1}</td>
                <td style="white-space:nowrap;min-width:100px">${dateCell}<br>${badge}</td>
                <td style="font-weight:600;max-width:160px">${payeeHtml}</td>
                <td style="color:#475569;max-width:300px;font-size:12px">${descHtml}</td>
                <td style="white-space:nowrap">${refHtml}</td>
                <td style="text-align:right;white-space:nowrap">${amountHtml}</td>
                <td style="width:110px;text-align:center" onclick="event.stopPropagation()">${actionHtml}</td>
            </tr>${matchRow}`;
        }).join('');
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

    // ── Click-to-edit any invoice field — saves to Airtable ──
    function editInvField(el, recordId, fieldId, inputType) {
        const input = document.createElement('input');
        input.type = inputType === 'number' ? 'number' : 'text';
        if (inputType === 'number') { input.step = '0.01'; input.placeholder = '0.00'; }
        else { input.placeholder = fieldId === INV.payee ? 'Payee name' : fieldId === INV.desc ? 'Description' : fieldId === INV.ref ? 'Invoice ref' : 'Value'; }
        const w = inputType === 'number' ? '80px' : (fieldId === INV.ref ? '90px' : '150px');
        input.style.cssText = `width:${w};padding:3px 6px;font-size:12px;border:1px solid #2563eb;border-radius:4px;${inputType === 'number' ? 'text-align:right;' : ''}`;

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
                const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.invoices}/${recordId}`, {
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
            await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.invoices}/${recordId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: { [INV.matchRejected]: true } })
            });
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
                paidFields[INV.matchedTx] = [{ id: txRecordId }];
            }
            await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.invoices}/${recordId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: paidFields })
            });

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
                await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${txRecordId}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: { [F.txInvoiceData]: gmailUrl } })
                });
            }

            btn.textContent = 'Done';
            btn.style.background = '#dcfce7';
            btn.style.color = '#16a34a';
            btn.style.borderColor = '#16a34a';

            // Remove from local array and re-render
            airtableInvoices = airtableInvoices.filter(i => i.recordId !== recordId);
            setTimeout(() => {
                invoiceTabRendered = false;
                renderInvoiceTab();
            }, 1500);

        } catch (e) {
            console.error('Mark as paid failed:', e);
            btn.textContent = 'Failed';
            btn.style.background = '#fee2e2';
            btn.classList.remove('loading');
            setTimeout(() => { btn.textContent = 'Mark Paid'; btn.style.background = ''; }, 3000);
        }
    }


    // ══════════════════════════════════════════
