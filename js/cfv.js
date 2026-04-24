// ══════════════════════════════════════════
// CFV TAB — Cash Flow Void Detection, Actions & Comments
// ══════════════════════════════════════════

    // CFV TAB — Cash Flow Void Detection & Management
    // ══════════════════════════════════════════

    const CFV_TOLERANCE_DAYS = 2; // days after due date before flagging
    const CFV_STATUS_IDS = {
        inPayment:   'sel4I99slfpd7Vc1t',
        cfv:         'sel2mWzsvOd8d8de0',
        cfvActioned: 'selmhFXah5Bodgg9x',
    };
    const CFV_CHASE_STAGES = [
        { day: 0, label: 'Stage 1', desc: 'Friendly reminder', cssClass: 'stage-1' },
        { day: 3, label: 'Stage 2', desc: 'Follow-up chase', cssClass: 'stage-2' },
        { day: 7, label: 'Stage 3', desc: 'Escalation', cssClass: 'stage-3' },
    ];

    // Build tenant lookup from allTenants array
    function buildTenantLookup() {
        const lookup = {};
        allTenants.forEach(t => { lookup[t.id] = t; });
        return lookup;
    }

    // Get tenant record linked to a tenancy
    function getTenantForTenancy(tenancy, tenantLookup) {
        const linked = getField(tenancy, F.tenLinkedTenant);
        if (!linked) return null;
        const tenantId = Array.isArray(linked) ? (typeof linked[0] === 'string' ? linked[0] : linked[0]?.id) : null;
        return tenantId ? tenantLookup[tenantId] : null;
    }

    // ── Core payment detection: uses direct tenancy link on transactions ──
    // Returns true if there's a reconciled transaction linked to this tenancy
    // in the current calendar month. No keyword matching, no formula dependency.
    function hasLinkedPaymentThisMonth(tenancyId, today) {
        const thisMonth = today.getMonth();
        const thisYear = today.getFullYear();
        return allTransactions.some(tx => {
            if (!getField(tx, F.txReconciled)) return false;
            // Check direct tenancy link
            const linkedTenancy = getField(tx, F.txTenancy);
            const linkedId = extractLinkedId(linkedTenancy);
            if (linkedId !== tenancyId) return false;
            // Check transaction is in the current month
            const txDateStr = getField(tx, F.txDate);
            if (!txDateStr) return false;
            const txDate = new Date(txDateStr);
            return txDate.getMonth() === thisMonth && txDate.getFullYear() === thisYear;
        });
    }

    // Detect CFVs using direct tenancy-linked transactions.
    // Auto-queues status updates back to In Payment when payment is confirmed.
    function detectCFVs() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tenantLookup = buildTenantLookup();
        const cfvList = [];
        // Tenancies to auto-return to In Payment (processed after loop)
        const autoReturnQueue = [];

        allTenancies.forEach(tenancy => {
            const statusName = getPaymentStatusName(getField(tenancy, F.tenPayStatus)).toLowerCase().trim();

            // ── Path A: Existing CFV / CFV Actioned tenancies ──
            if (statusName === 'cfv' || statusName === 'cfv actioned') {
                // Skip if locally marked as returned (prevents re-showing before Airtable syncs)
                if (localStorage.getItem('cfv_' + tenancy.id + '_returned')) return;

                // Skip if the tenancy has ended — tenant status will be "Former" after
                // the tenancy-ender skill runs. This keeps the CFV OS in sync with the
                // Leadership Dashboard, which filters voids by active tenant status.
                if (!isTenantStatusActive(tenancy)) return;

                const paidDetected = hasLinkedPaymentThisMonth(tenancy.id, today);

                // Auto-return to In Payment if a linked reconciled transaction exists
                if (paidDetected) {
                    autoReturnQueue.push(tenancy.id);
                    return; // Don't add to CFV list — it's being cleared
                }

                const tenant = getTenantForTenancy(tenancy, tenantLookup);
                const entry = buildCFVEntry(tenancy, tenant, statusName, today);

                // Re-flag check: CFV Actioned but next due date has passed with no payment
                if (statusName === 'cfv actioned') {
                    const dueDay = getNumVal(tenancy, F.tenDueDay, 1);
                    const dueThisMonth = new Date(today.getFullYear(), today.getMonth(), dueDay);
                    const daysSinceDue = today >= dueThisMonth ? Math.floor((today - dueThisMonth) / 86400000) : 0;

                    if (daysSinceDue >= CFV_TOLERANCE_DAYS) {
                        const reflagDismissKey = 'cfv_reflag_dismissed_' + tenancy.id;
                        if (!localStorage.getItem(reflagDismissKey)) {
                            entry.reflagged = true;
                        }
                    }
                }

                cfvList.push(entry);
                return;
            }

            // ── Path B: "In Payment" tenancies — check for potential new CFVs ──
            if (statusName !== 'in payment') return;
            if (!isTenantStatusActive(tenancy)) return;

            const rent = Number(getField(tenancy, F.tenRent)) || 0;
            if (rent <= 0) return;

            const dueDay = getNumVal(tenancy, F.tenDueDay, 1);
            const dueThisMonth = new Date(today.getFullYear(), today.getMonth(), dueDay);
            let daysOverdue = 0;
            if (today >= dueThisMonth) {
                daysOverdue = Math.floor((today - dueThisMonth) / 86400000);
            }

            // Only check if due date has passed + tolerance
            if (daysOverdue < CFV_TOLERANCE_DAYS) return;

            // Check for linked reconciled payment this month
            const paidThisMonth = hasLinkedPaymentThisMonth(tenancy.id, today);
            if (paidThisMonth) return; // Paid — not a CFV

            // No linked payment found — flag as potential CFV
            const tenant = getTenantForTenancy(tenancy, tenantLookup);
            const entry = buildCFVEntry(tenancy, tenant, 'potential', today);
            entry.autoDetected = true;
            cfvList.push(entry);
        });

        // Process auto-returns in the background (don't block detection)
        if (autoReturnQueue.length > 0) {
            cfvAutoReturnToPayment(autoReturnQueue);
        }

        return cfvList;
    }

    // Automatically return tenancies to In Payment when linked payment is detected
    async function cfvAutoReturnToPayment(tenancyIds) {
        for (const tenancyId of tenancyIds) {
            // Skip if already processed
            if (localStorage.getItem('cfv_' + tenancyId + '_returned')) continue;

            // Mark locally first so re-renders don't show it
            localStorage.setItem('cfv_' + tenancyId + '_returned', '1');

            const ok = await updateTenancyStatus(tenancyId, CFV_STATUS_IDS.inPayment);
            if (ok) {
                // Clear chase tracking and CFV start date
                localStorage.removeItem('cfv_' + tenancyId + '_chaseStart');
                localStorage.removeItem('cfv_' + tenancyId + '_startDate');
                localStorage.removeItem('cfv_' + tenancyId + '_returnDismissed');
                // Update local data
                const rec = allTenancies.find(t => t.id === tenancyId);
                if (rec) rec.fields[F.tenPayStatus] = { id: CFV_STATUS_IDS.inPayment, name: 'In Payment', color: 'cyanLight2' };
                // Add audit comment
                const surname = rec ? String(getField(rec, F.tenSurname) || '') : '';
                await addTenancyComment(tenancyId, `Auto-returned to In Payment — reconciled transaction linked to this tenancy detected for ${new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}.`);
                console.log(`CFV auto-return: ${surname || tenancyId} → In Payment`);
            } else {
                // Airtable update failed — remove local flag so it retries next load
                localStorage.removeItem('cfv_' + tenancyId + '_returned');
                console.warn(`CFV auto-return failed for ${tenancyId}`);
            }
        }
        // Re-render after all updates
        if (tenancyIds.length > 0) {
            renderCFVTab();
            if (typeof updateCFVSidebarBadges === 'function') {
                const cfvList = detectCFVs();
                const visible = cfvList.filter(e => {
                    if (e.status === 'cfv' || e.status === 'potential') return !localStorage.getItem('cfv_dismissed_' + e.tenancyId);
                    return true;
                });
                updateCFVSidebarBadges(
                    visible.filter(e => e.status === 'cfv' || e.status === 'potential').length,
                    visible.filter(e => e.status === 'cfv actioned').length
                );
            }
        }
    }

    function buildCFVEntry(tenancy, tenant, status, today) {
        const surname = String(getField(tenancy, F.tenSurname) || 'Unknown');
        const ref = String(getField(tenancy, F.tenRef) || '');
        const rent = Number(getField(tenancy, F.tenRent)) || 0;
        const dueDay = getNumVal(tenancy, F.tenDueDay, 0);
        const unitRef = getField(tenancy, F.tenUnitRef);
        const property = getField(tenancy, F.tenProperty);
        const propertyName = Array.isArray(property) ? property[0] : (property || '');
        const unitName = Array.isArray(unitRef) ? unitRef[0] : (unitRef || '');

        // Tenant contact info
        const tenantName = tenant ? String(getField(tenant, F.tenantName) || '') : '';
        const tenantPhone = tenant ? String(getField(tenant, F.tenantPhone) || '') : '';
        const tenantEmail = tenant ? String(getField(tenant, F.tenantEmail) || '') : '';

        // ── Days overdue: calculated from the CFV start date ──
        // When a CFV is first detected, we store the due date of that month as the start date.
        // Days overdue = today minus that start date. This persists across months.
        const cfvKey = 'cfv_' + tenancy.id;
        const storedStartDate = localStorage.getItem(cfvKey + '_startDate');
        let cfvStartDate = storedStartDate ? new Date(storedStartDate) : null;

        if (!cfvStartDate && (status === 'cfv' || status === 'potential' || status === 'cfv actioned')) {
            // Calculate the due date for the current month (or last month if due day hasn't passed)
            const dueThisMonth = new Date(today.getFullYear(), today.getMonth(), dueDay || 1);
            // If due day this month is in the future, the CFV is from last month's due date
            if (dueThisMonth > today) {
                cfvStartDate = new Date(today.getFullYear(), today.getMonth() - 1, dueDay || 1);
            } else {
                cfvStartDate = dueThisMonth;
            }
            localStorage.setItem(cfvKey + '_startDate', cfvStartDate.toISOString());
        }

        const daysOverdue = cfvStartDate ? Math.max(0, Math.floor((today - cfvStartDate) / 86400000)) : 0;

        // Chase stage from localStorage
        const chaseStartStr = localStorage.getItem(cfvKey + '_chaseStart');
        let chaseStart = chaseStartStr ? new Date(chaseStartStr) : null;
        if (!chaseStart && (status === 'cfv' || status === 'potential')) {
            chaseStart = today;
            localStorage.setItem(cfvKey + '_chaseStart', today.toISOString());
        }

        let chaseStage = 0;
        if (chaseStart) {
            const daysSinceChase = Math.floor((today - chaseStart) / 86400000);
            for (let i = CFV_CHASE_STAGES.length - 1; i >= 0; i--) {
                if (daysSinceChase >= CFV_CHASE_STAGES[i].day) { chaseStage = i; break; }
            }
        }

        return {
            tenancyId: tenancy.id,
            surname, ref, rent, dueDay, daysOverdue,
            propertyName, unitName,
            status,
            tenantName, tenantPhone, tenantEmail,
            tenantId: tenant ? tenant.id : null,
            chaseStage, chaseStart, cfvStartDate,
            autoDetected: false,
        };
    }

    // Render the CFV tab
    // Update sidebar badge counts for CFVs
    function updateCFVSidebarBadges(cfvCount, actionedCount) {
        const container = document.getElementById('cfvSidebarBadges');
        if (!container) return;
        let html = '';
        if (cfvCount > 0) html += `<span class="cfv-sidebar-badge cfv-red">${cfvCount}</span>`;
        if (actionedCount > 0) html += `<span class="cfv-sidebar-badge cfv-orange">${actionedCount}</span>`;
        container.innerHTML = html;
    }

    // updateSitemapBadge lives in js/sitemap.js now — it's git-aware and belongs
    // with the rest of the Site Map logic. Left as a no-op fallback in case this
    // file loads alone.
    if (typeof updateSitemapBadge !== 'function') {
        window.updateSitemapBadge = function noop() {};
    }

    async function renderCFVTab() {
        if (!allTenancies.length) return;

        const cfvList = detectCFVs();
        const today = new Date();

        // DO NOT auto-update Airtable — show potential CFVs for user approval
        // User must confirm before status changes in Airtable

        // Filter out dismissed potential CFVs (user clicked "Not a CFV")
        // Dismissal holds until the NEXT due day (plus tolerance) has passed —
        // i.e. the start of the next rent cycle. A fixed 25-day expiry was
        // wrong because it could expire within the same month (e.g. dismiss
        // on the 3rd, expire on the 28th — well before next month's due day).
        const filteredList = cfvList.filter(entry => {
            if (entry.status === 'potential') {
                const dismissedAt = localStorage.getItem('cfv_dismissed_' + entry.tenancyId);
                if (!dismissedAt) return true;
                const dismissDate = new Date(dismissedAt);
                const dueDay = entry.dueDay || 1;
                // Find the next due day strictly after the dismissal date.
                // If this month's due day is on/before the dismissal, roll to next month.
                let nextDueDate = new Date(dismissDate.getFullYear(), dismissDate.getMonth(), dueDay);
                if (nextDueDate <= dismissDate) {
                    nextDueDate = new Date(dismissDate.getFullYear(), dismissDate.getMonth() + 1, dueDay);
                }
                // Re-check only once the next due day + tolerance has elapsed
                const expiryTime = nextDueDate.getTime() + CFV_TOLERANCE_DAYS * 86400000;
                if (Date.now() >= expiryTime) {
                    localStorage.removeItem('cfv_dismissed_' + entry.tenancyId);
                    return true;
                }
                return false;
            }
            return true;
        });

        // Summary
        const potentialCfvs = filteredList.filter(e => e.status === 'potential');
        const cfvOnly = filteredList.filter(e => e.status === 'cfv' || e.status === 'potential');
        const confirmedCfvs = filteredList.filter(e => e.status === 'cfv');
        const cfvActioned = filteredList.filter(e => e.status === 'cfv actioned');
        const totalExposure = filteredList.reduce((s, e) => s + e.rent, 0);
        const oldestOverdue = cfvOnly.length ? Math.max(...cfvOnly.map(e => e.daysOverdue)) : 0;

        const summaryCards = document.getElementById('cfvSummaryCards');
        if (summaryCards) {
            summaryCards.innerHTML = `
                ${potentialCfvs.length > 0 ? `<div class="kpi-card" style="border-color:#d97706;border-width:2px">
                    <div class="kpi-card-label" style="color:#d97706">⚠ Potential CFVs</div>
                    <div class="kpi-card-value" style="color:#d97706">${potentialCfvs.length}</div>
                    <div class="kpi-card-sub">Awaiting your review — confirm or dismiss below</div>
                </div>` : ''}
                <div class="kpi-card">
                    <div class="kpi-card-label">Confirmed CFVs</div>
                    <div class="kpi-card-value text-red">${confirmedCfvs.length}</div>
                    <div class="kpi-card-sub">${confirmedCfvs.length > 0 ? 'Requires follow-up action' : 'No confirmed cash flow voids'}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Total Exposure</div>
                    <div class="kpi-card-value text-red">${fmt(totalExposure)}</div>
                    <div class="kpi-card-sub">Combined monthly rent at risk</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Oldest Overdue</div>
                    <div class="kpi-card-value">${oldestOverdue} days</div>
                    <div class="kpi-card-sub">${oldestOverdue > 14 ? 'Escalation may be required' : oldestOverdue > 0 ? 'Within initial chase window' : 'No overdue items'}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">CFV Actioned</div>
                    <div class="kpi-card-value" style="color:#d97706">${cfvActioned.length}</div>
                    <div class="kpi-card-sub">${cfvActioned.length > 0 ? 'Awaiting payment confirmation' : 'No actioned CFVs'}</div>
                </div>
            `;
        }

        // Update sidebar badges
        updateCFVSidebarBadges(confirmedCfvs.length + potentialCfvs.length, cfvActioned.length);

        // Table
        const tbody = document.getElementById('cfvTableBody');
        if (!tbody) return;

        if (filteredList.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:#94a3b8;font-size:14px">No cash flow voids detected. All tenancies are in payment.</td></tr>`;
            return;
        }

        // Fetch comment counts for all CFV tenancies in parallel
        const commentCounts = {};
        await Promise.all(filteredList.map(async entry => {
            try {
                const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tenancies}/${entry.tenancyId}/comments`, {
                    headers: { 'Authorization': 'Bearer ' + PAT }
                });
                if (resp.ok) {
                    const data = await resp.json();
                    commentCounts[entry.tenancyId] = (data.comments || []).length;
                } else {
                    commentCounts[entry.tenancyId] = 0;
                }
            } catch (e) { commentCounts[entry.tenancyId] = 0; }
        }));

        // Sort: Potential first, then CFV, then CFV Actioned — by due day
        filteredList.sort((a, b) => {
            const statusOrder = { 'potential': 0, 'cfv': 1, 'cfv actioned': 2 };
            const sDiff = (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0);
            if (sDiff !== 0) return sDiff;
            return (a.dueDay || 99) - (b.dueDay || 99);
        });

        tbody.innerHTML = filteredList.map((entry, idx) => {
            const statusBadge = entry.reflagged
                ? '<span class="cfv-status-badge potential">Re-flagged ⚠</span>'
                : entry.status === 'cfv actioned'
                ? '<span class="cfv-status-badge cfv-actioned">CFV Actioned</span>'
                : entry.status === 'potential'
                ? '<span class="cfv-status-badge potential">Potential CFV</span>'
                : '<span class="cfv-status-badge cfv">CFV</span>';

            const chase = CFV_CHASE_STAGES[entry.chaseStage];
            const chaseBadge = entry.status !== 'cfv actioned'
                ? `<span class="cfv-chase-badge ${chase.cssClass}">${chase.label}</span>`
                : '<span style="color:#94a3b8;font-size:10px">—</span>';

            // Contact info
            let contactHtml = '';
            if (entry.tenantPhone || entry.tenantEmail) {
                contactHtml = '<div class="cfv-contact-info">';
                if (entry.tenantPhone) contactHtml += `<a href="tel:${entry.tenantPhone}">${escHtml(entry.tenantPhone)}</a><br>`;
                if (entry.tenantEmail) contactHtml += `<a href="mailto:${entry.tenantEmail}">${escHtml(entry.tenantEmail)}</a>`;
                contactHtml += '</div>';
            } else {
                contactHtml = '<span class="cfv-contact-missing">⚠️ No contact info</span>';
            }

            // Comment count badge
            const cc = commentCounts[entry.tenancyId] || 0;
            const commentBtnLabel = cc > 0
                ? `💬 ${cc} comment${cc !== 1 ? 's' : ''}`
                : '💬 Comments';

            // Action buttons — different for each status
            let actionsHtml = '';
            if (entry.status === 'potential') {
                // Awaiting user review — confirm as CFV or dismiss
                actionsHtml = `
                    <button class="cfv-action-btn" style="background:#dc2626;color:white;border-color:#dc2626" onclick="event.stopPropagation(); cfvConfirmAsCFV('${entry.tenancyId}','${escHtml(entry.surname)}',this)">Confirm CFV</button>
                    <button class="cfv-action-btn success" onclick="event.stopPropagation(); cfvDismissAsCFV('${entry.tenancyId}','${escHtml(entry.surname)}',this)" style="margin-top:4px">Not a CFV</button>
                `;
            } else if (entry.status === 'cfv') {
                // Confirmed CFV — can mark actioned
                actionsHtml = `
                    <button class="cfv-action-btn primary" onclick="event.stopPropagation(); cfvConfirmAction('actioned','${entry.tenancyId}','${escHtml(entry.surname)}',this)">Mark Actioned</button>
                    <button class="cfv-action-btn" data-comment-btn="${entry.tenancyId}" onclick="event.stopPropagation(); cfvShowComments('${entry.tenancyId}','${escHtml(entry.surname)}','${escHtml(entry.ref)}')" style="margin-top:4px">${commentBtnLabel}</button>
                `;
            } else if (entry.reflagged) {
                // CFV Actioned but re-flagged — confirm as CFV again or dismiss
                actionsHtml = `
                    <button class="cfv-action-btn" style="background:#dc2626;color:white;border-color:#dc2626" onclick="event.stopPropagation(); cfvConfirmReflag('${entry.tenancyId}','${escHtml(entry.surname)}',this)">Confirm CFV</button>
                    <button class="cfv-action-btn" onclick="event.stopPropagation(); cfvDismissReflag('${entry.tenancyId}',this)" style="margin-top:4px">Dismiss</button>
                    <button class="cfv-action-btn" data-comment-btn="${entry.tenancyId}" onclick="event.stopPropagation(); cfvShowComments('${entry.tenancyId}','${escHtml(entry.surname)}','${escHtml(entry.ref)}')" style="margin-top:4px">${commentBtnLabel}</button>
                `;
            } else {
                // CFV Actioned — can return to In Payment or move back to CFV
                actionsHtml = `
                    <button class="cfv-action-btn success" onclick="event.stopPropagation(); cfvConfirmAction('inpayment','${entry.tenancyId}','${escHtml(entry.surname)}',this)">In Payment</button>
                    <button class="cfv-action-btn" style="border-color:#dc2626;color:#dc2626" onclick="event.stopPropagation(); cfvConfirmAction('cfv','${entry.tenancyId}','${escHtml(entry.surname)}',this)" style="margin-top:4px">Move to CFV</button>
                    <button class="cfv-action-btn" data-comment-btn="${entry.tenancyId}" onclick="event.stopPropagation(); cfvShowComments('${entry.tenancyId}','${escHtml(entry.surname)}','${escHtml(entry.ref)}')" style="margin-top:4px">${commentBtnLabel}</button>
                `;
            }

            // Payment detected banner removed — auto-return handles this now

            return `<tr>
                <td style="font-weight:600">${escHtml(entry.surname)}<br><span style="font-size:10px;color:#94a3b8">${escHtml(entry.ref)}</span></td>
                <td style="font-size:12px">${escHtml(entry.propertyName)}<br><span style="font-size:10px;color:#94a3b8">${escHtml(entry.unitName)}</span></td>
                <td style="text-align:right;font-weight:600;font-variant-numeric:tabular-nums">${fmt(entry.rent)}</td>
                <td style="text-align:center">${entry.dueDay || '—'}</td>
                <td style="text-align:center;font-weight:700;color:${entry.daysOverdue > 7 ? '#dc2626' : entry.daysOverdue > 3 ? '#d97706' : '#1e293b'}">${entry.daysOverdue}</td>
                <td>${statusBadge}</td>
                <td>${chaseBadge}</td>
                <td>${contactHtml}</td>
                <td style="min-width:100px" onclick="event.stopPropagation()">${actionsHtml}</td>
            </tr>`;
        }).join('');
    }

    // ── CFV Actions ──

    async function updateTenancyStatus(tenancyId, statusSelectId) {
        if (!PAT) { alert('No Airtable token — cannot update status'); return false; }
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tenancies}/${tenancyId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: { [F.tenPayStatus]: statusSelectId === CFV_STATUS_IDS.inPayment ? 'In Payment' : statusSelectId === CFV_STATUS_IDS.cfvActioned ? 'CFV Actioned' : statusSelectId === CFV_STATUS_IDS.cfv ? 'CFV' : { id: statusSelectId } } })
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                console.error('Airtable PATCH failed:', resp.status, JSON.stringify(err));
                alert(`Failed to update Airtable (${resp.status}): ${err.error?.message || 'Unknown error'}. Check your PAT has data.records:write scope.`);
                return false;
            }
            return true;
        } catch (e) {
            console.error('Failed to update tenancy status:', e);
            alert('Network error updating Airtable: ' + e.message);
            return false;
        }
    }

    // Confirmation step before any status change
    function cfvConfirmAction(action, tenancyId, surname, btn) {
        const labels = { actioned: 'Mark as CFV Actioned', inpayment: 'Return to In Payment', cfv: 'Move back to CFV' };
        const msg = `Are you sure you want to ${labels[action] || action} for ${surname}?`;
        if (!confirm(msg)) return;
        if (action === 'actioned') cfvMarkActioned(tenancyId, btn);
        else if (action === 'cfv') cfvMoveToCFV(tenancyId, btn);
        else cfvReturnToPayment(tenancyId, btn);
    }

    async function cfvMoveToCFV(tenancyId, btn) {
        btn.textContent = '...';
        btn.disabled = true;
        const ok = await updateTenancyStatus(tenancyId, CFV_STATUS_IDS.cfv);
        if (!ok) { btn.textContent = 'Failed'; btn.disabled = false; return; }
        await addTenancyComment(tenancyId, 'Moved back to CFV from CFV Actioned via Leadership Dashboard.');
        const rec = allTenancies.find(t => t.id === tenancyId);
        if (rec) rec.fields[F.tenPayStatus] = { id: CFV_STATUS_IDS.cfv, name: 'CFV' };
        btn.textContent = 'Done ✓';
        btn.style.background = '#fee2e2';
        btn.style.color = '#dc2626';
        setTimeout(() => renderCFVTab(), 1500);
        setTimeout(() => loadDashboard(), 3000);
    }

    function cfvDismissReturn(tenancyId, btn) {
        localStorage.setItem('cfv_' + tenancyId + '_returnDismissed', '1');
        const row = btn.closest('tr');
        if (row) row.style.display = 'none';
    }

    // Confirm a potential CFV — update Airtable status to CFV
    async function cfvConfirmAsCFV(tenancyId, surname, btn) {
        if (!confirm(`Confirm ${surname} as a Cash Flow Void? This will update the payment status to CFV in Airtable.`)) return;
        btn.textContent = '...';
        btn.disabled = true;
        const ok = await updateTenancyStatus(tenancyId, CFV_STATUS_IDS.cfv);
        if (!ok) { btn.textContent = 'Failed'; btn.disabled = false; return; }
        await addTenancyComment(tenancyId, 'Confirmed as CFV from Leadership Dashboard.');
        const rec = allTenancies.find(t => t.id === tenancyId);
        if (rec) rec.fields[F.tenPayStatus] = { id: CFV_STATUS_IDS.cfv, name: 'CFV' };
        btn.textContent = 'Confirmed ✓';
        btn.style.background = '#fee2e2';
        btn.style.color = '#dc2626';
        setTimeout(() => renderCFVTab(), 1500);
        setTimeout(() => loadDashboard(), 3000);
    }

    // Dismiss a potential CFV — not a real CFV, return to In Payment
    async function cfvDismissAsCFV(tenancyId, surname, btn) {
        if (!confirm(`Dismiss ${surname} as not a CFV? This will keep the tenancy as In Payment.`)) return;
        btn.textContent = '...';
        btn.disabled = true;
        // Store dismissal so it doesn't reappear until next month
        localStorage.setItem('cfv_dismissed_' + tenancyId, new Date().toISOString());
        // Clear any chase data that was started
        localStorage.removeItem('cfv_' + tenancyId + '_chaseStart');
        localStorage.removeItem('cfv_' + tenancyId + '_startDate');
        await addTenancyComment(tenancyId, `Dismissed as not a CFV from Leadership Dashboard. Payment confirmed via other means.`);
        btn.textContent = 'Dismissed ✓';
        btn.style.background = '#dcfce7';
        btn.style.color = '#16a34a';
        setTimeout(() => renderCFVTab(), 1500);
    }

    // Re-flag: confirm CFV Actioned back to CFV
    async function cfvConfirmReflag(tenancyId, surname, btn) {
        if (!confirm(`Re-flag ${surname} as CFV? Payment still hasn't come through.`)) return;
        btn.textContent = '...';
        btn.disabled = true;
        const ok = await updateTenancyStatus(tenancyId, CFV_STATUS_IDS.cfv);
        if (!ok) { btn.textContent = 'Failed'; btn.disabled = false; return; }
        await addTenancyComment(tenancyId, 'Re-flagged as CFV — payment not received on next due date.');
        const rec = allTenancies.find(t => t.id === tenancyId);
        if (rec) rec.fields[F.tenPayStatus] = { id: CFV_STATUS_IDS.cfv, name: 'CFV' };
        localStorage.removeItem('cfv_reflag_dismissed_' + tenancyId);
        btn.textContent = 'Confirmed ✓';
        setTimeout(() => renderCFVTab(), 1500);
        setTimeout(() => loadDashboard(), 3000);
    }

    // Dismiss re-flag — keep as CFV Actioned
    function cfvDismissReflag(tenancyId, btn) {
        localStorage.setItem('cfv_reflag_dismissed_' + tenancyId, new Date().toISOString());
        btn.textContent = 'Dismissed';
        setTimeout(() => renderCFVTab(), 1000);
    }

    async function cfvMarkActioned(tenancyId, btn) {
        btn.textContent = '...';
        btn.disabled = true;
        const ok = await updateTenancyStatus(tenancyId, CFV_STATUS_IDS.cfvActioned);
        if (!ok) { btn.textContent = 'Failed'; btn.disabled = false; return; }
        await addTenancyComment(tenancyId, 'Status changed to CFV Actioned from Leadership Dashboard.');
        btn.textContent = 'Done ✓';
        btn.style.background = '#dcfce7';
        btn.style.color = '#16a34a';
        const rec = allTenancies.find(t => t.id === tenancyId);
        if (rec) rec.fields[F.tenPayStatus] = { id: CFV_STATUS_IDS.cfvActioned, name: 'CFV Actioned', color: 'yellowLight2' };
        setTimeout(() => renderCFVTab(), 1500);
        setTimeout(() => loadDashboard(), 3000);
    }

    async function cfvReturnToPayment(tenancyId, btn) {
        btn.textContent = '...';
        btn.disabled = true;
        const ok = await updateTenancyStatus(tenancyId, CFV_STATUS_IDS.inPayment);
        if (!ok) {
            btn.textContent = 'Failed';
            btn.disabled = false;
            // Remove any local flag since Airtable wasn't updated
            localStorage.removeItem('cfv_' + tenancyId + '_returned');
            return;
        }
        // Clear chase tracking and CFV start date
        localStorage.removeItem('cfv_' + tenancyId + '_chaseStart');
        localStorage.removeItem('cfv_' + tenancyId + '_startDate');
        localStorage.removeItem('cfv_' + tenancyId + '_returnDismissed');
        // Update local data immediately so main dashboard reflects the change
        const rec = allTenancies.find(t => t.id === tenancyId);
        if (rec) rec.fields[F.tenPayStatus] = { id: CFV_STATUS_IDS.inPayment, name: 'In Payment', color: 'cyanLight2' };
        // Mark locally so re-render doesn't re-show this tenancy before full data refresh
        localStorage.setItem('cfv_' + tenancyId + '_returned', '1');
        await addTenancyComment(tenancyId, 'Returned to In Payment from Leadership Dashboard. Payment confirmed.');
        btn.textContent = 'Done ✓';
        btn.style.background = '#dcfce7';
        btn.style.color = '#16a34a';
        setTimeout(() => renderCFVTab(), 1000);
        setTimeout(() => loadDashboard(), 3000);
    }

    // ── Comments ──

    async function addTenancyComment(recordId, text) {
        if (!PAT) return;
        try {
            await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tenancies}/${recordId}/comments`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text })
            });
        } catch (e) { console.warn('Failed to add comment:', e); }
    }

    // Fetch ALL comments from a record (paginate if needed)
    async function fetchAllComments(tableId, recordId) {
        if (!PAT) return [];
        const all = [];
        let offset = null;
        try {
            do {
                let url = `https://api.airtable.com/v0/${BASE_ID}/${tableId}/${recordId}/comments`;
                if (offset) url += '?offset=' + encodeURIComponent(offset);
                const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + PAT } });
                if (!resp.ok) {
                    if (resp.status === 403 || resp.status === 422) {
                        console.error('Comments API rejected — PAT likely missing data.recordComments:read scope. Status:', resp.status);
                    }
                    break;
                }
                const data = await resp.json();
                all.push(...(data.comments || []));
                offset = data.offset || null;
            } while (offset);
        } catch (e) { console.warn('Failed to fetch comments:', e); }
        return all;
    }

    function formatCommentsList(comments, emptyMsg) {
        if (comments.length === 0) return `<div style="color:#94a3b8;font-size:12px;padding:8px 0">${emptyMsg}</div>`;
        return comments.map(c => {
            const d = new Date(c.createdTime);
            const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            const author = c.author?.name || c.author?.email || 'System';
            return `<div class="cfv-comment-item"><span class="cfv-comment-date">${dateStr} — ${escHtml(author)}</span><br>${escHtml(c.text)}</div>`;
        }).join('');
    }

    async function cfvShowComments(tenancyId, surname, ref) {
        const section = document.getElementById('cfvCommentsSection');
        const container = document.getElementById('cfvCommentsContainer');
        section.style.display = 'block';
        container.innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8">Loading full comment history...</div>';

        // Fetch all comments from the tenancy record
        const tenancyComments = await fetchAllComments(TABLES.tenancies, tenancyId);

        let commentsHtml = '';
        if (tenancyComments.length > 0) {
            commentsHtml = formatCommentsList(tenancyComments, '');
        } else {
            commentsHtml = '<div style="color:#94a3b8;font-size:12px;padding:12px 0">No comments yet. Your Airtable PAT may need the <strong>data.recordComments:read</strong> scope — update at <a href="https://airtable.com/create/tokens" target="_blank">airtable.com/create/tokens</a>.</div>';
        }

        container.innerHTML = `
            <div class="cfv-comment-box">
                <div class="cfv-comment-header">
                    <span class="cfv-comment-tenant">${escHtml(surname)} — ${escHtml(ref)}</span>
                    <button class="cfv-action-btn" onclick="document.getElementById('cfvCommentsSection').style.display='none'">Close</button>
                </div>
                <div style="font-size:12px;font-weight:700;color:#1e293b;margin-bottom:6px;padding-top:8px">Tenancy Comments (${tenancyComments.length})</div>
                <div class="cfv-comment-list" style="max-height:400px">${commentsHtml}</div>
                <div style="margin-top:12px;padding-top:8px;border-top:1px solid #e2e8f0">
                    <textarea class="cfv-comment-input" id="cfvNewComment" rows="2" placeholder="Add a comment..."></textarea>
                    <button class="cfv-action-btn primary cfv-comment-send" onclick="cfvAddComment('${tenancyId}','${escHtml(surname)}','${escHtml(ref)}')">Add Comment</button>
                </div>
            </div>
        `;

        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function cfvAddComment(tenancyId, surname, ref) {
        const input = document.getElementById('cfvNewComment');
        const text = input.value.trim();
        if (!text) return;
        input.disabled = true;
        await addTenancyComment(tenancyId, text);
        // Reload comments panel
        await cfvShowComments(tenancyId, surname, ref);
        // Refresh the row's comment button label so the count updates live
        refreshCommentBtnCount(tenancyId);
    }

    // Re-fetch the comment count for a single tenancy and update every
    // matching button in the CFV table (selected by data-comment-btn attribute).
    // Called after adding a comment so the "💬 N comments" label updates without
    // a full table re-render.
    async function refreshCommentBtnCount(tenancyId) {
        if (!PAT) return;
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tenancies}/${tenancyId}/comments`, {
                headers: { 'Authorization': 'Bearer ' + PAT }
            });
            if (!resp.ok) return;
            const data = await resp.json();
            const cc = (data.comments || []).length;
            const label = cc > 0 ? `💬 ${cc} comment${cc !== 1 ? 's' : ''}` : '💬 Comments';
            document.querySelectorAll(`[data-comment-btn="${tenancyId}"]`).forEach(btn => {
                btn.textContent = label;
            });
        } catch (e) { /* non-fatal — label will refresh on next render */ }
    }

// test
