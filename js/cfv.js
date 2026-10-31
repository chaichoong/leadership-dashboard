// ══════════════════════════════════════════
// CFV TAB — Cash Flow Void Detection, Actions & Comments
// ══════════════════════════════════════════

    // CFV TAB — Cash Flow Void Detection & Management
    // ══════════════════════════════════════════

    const CFV_TOLERANCE_DAYS = 2; // days after due date before flagging

    // ── ONE definition of "does this CFV still count" ────────────────────
    // Three places used to answer this question and two of them got it wrong
    // (finding 20260811-drift-080, 11 Aug 2026):
    //   * renderCFVTab (below) dismissed 'potential' only, with an expiry.
    //   * cfvAutoReturnToPayment dismissed 'potential' only, no expiry.
    //   * js/dashboard.js dismissed 'potential' OR a CONFIRMED 'cfv', no expiry.
    // A tenancy dismissed while merely 'potential' keeps its localStorage key
    // until the next due day passes. If it escalates to a confirmed CFV in the
    // meantime, the sidebar hid it while the CFV page listed it — the sidebar
    // under-reported genuinely overdue rent, on the alarm Kevin scans first.
    // Latent on 11 Aug only because none of the five live CFVs had a key.
    //
    // The rule: only a 'potential' entry is dismissable, and only until the next
    // due day plus the tolerance window. A confirmed CFV or a CFV Actioned item
    // always counts.
    function cfvIsVisible(entry) {
        if (!entry) return false;
        if (entry.status !== 'potential') return true;
        const dismissedAt = localStorage.getItem('cfv_dismissed_' + entry.tenancyId);
        if (!dismissedAt) return true;
        const dismissDate = new Date(dismissedAt);
        if (isNaN(dismissDate.getTime())) {
            localStorage.removeItem('cfv_dismissed_' + entry.tenancyId);
            return true;
        }
        const dueDay = entry.dueDay || 1;
        // The next due day strictly after the dismissal. If this month's due day
        // is on or before the dismissal, roll to next month.
        let nextDueDate = new Date(dismissDate.getFullYear(), dismissDate.getMonth(), dueDay);
        if (nextDueDate <= dismissDate) {
            nextDueDate = new Date(dismissDate.getFullYear(), dismissDate.getMonth() + 1, dueDay);
        }
        const expiryTime = nextDueDate.getTime() + CFV_TOLERANCE_DAYS * 86400000;
        if (Date.now() >= expiryTime) {
            localStorage.removeItem('cfv_dismissed_' + entry.tenancyId);
            return true;
        }
        return false;
    }

    // The badge, computed the same way everywhere. Safe to call before the CFV
    // tab has ever been opened: it only needs allTenancies / allTransactions,
    // which the dashboard cache render populates.
    function refreshCFVSidebarBadges() {
        if (typeof updateCFVSidebarBadges !== 'function') return;
        if (typeof detectCFVs !== 'function') return;
        // Read-only: a badge count must never write to Airtable.
        const visible = detectCFVs({ autoReturn: false }).filter(cfvIsVisible);
        updateCFVSidebarBadges(
            visible.filter(e => e.status === 'cfv' || e.status === 'potential').length,
            visible.filter(e => e.status === 'cfv actioned').length
        );
    }
    // ── Rent paid by set-off (9 Oct 2026) ────────────────────────────────
    // Kevin, 6 Oct 2026, on 30 Burnbank Gardens: a letting agent keeping the rent against a repair bill
    // we owe them means the rent IS paid, "so it's not a cash flow void". The tenancy carries the window
    // (Rent Set-off From / Until, written only by scripts/tenancy-record.py). Shared with js/arrears.js.
    function rentSetOffWindow(tenancy) {
        const read = (fid) => {
            const v = getField(tenancy, fid);
            if (!v) return null;
            const d = new Date(String(v).slice(0, 10) + 'T00:00:00');
            return isNaN(d.getTime()) ? null : d;
        };
        const until = read(F.tenSetOffUntil);
        if (!until) return null;
        const from = read(F.tenSetOffFrom);
        return { from: from && from <= until ? from : null, until };
    }
    window.rentSetOffWindow = rentSetOffWindow;

    // True while the rent is paid by set-off. Mirrors scripts/rent-check.py judge(): the oldest unpaid rent (a payment
    // covers rent due up to 5 days after it; nothing before the tenancy began; nothing older than the 80-day bank look-
    // back) must fall due INSIDE the window, and the first rent after the window must not be past the tolerance. Rent
    // owed before the window began is still owed (independent review, 9 Oct 2026).
    function cfvSetOffCovers(tenancy, today, txIndex) {
        const win = rentSetOffWindow(tenancy);
        if (!win || !win.from) return false;
        const dueDay = getNumVal(tenancy, F.tenDueDay, 1) || 1;
        const dueIn = (y, m) => new Date(y, m, Math.min(dueDay, new Date(y, m + 1, 0).getDate()));
        const day = (v) => { const d = v ? new Date(String(v).slice(0, 10) + 'T00:00:00') : null; return d && !isNaN(d.getTime()) ? d : null; };
        // No start date: the rent check cannot tell, so neither can this (review round 2, 9 Oct 2026).
        let floor = day(getField(tenancy, F.tenStartDate));
        if (!floor) return false;
        const lookback = new Date(today);
        lookback.setDate(lookback.getDate() - 80);
        if (lookback > floor) floor = lookback;
        // Only payments the rent check reads: dated after today minus 80 days.
        let newest = null;
        const txs = txIndex ? (txIndex.get(tenancy.id) || [])
            : (allTransactions || []).filter(tx => getField(tx, F.txReconciled) && txLinkedToTenancy(tx, tenancy.id));
        for (const tx of txs) {
            const d = day(getField(tx, F.txDate));
            if (d && d > lookback && (!newest || d > newest)) newest = d;
        }
        if (newest) {
            const paidTo = new Date(newest);
            paidTo.setDate(paidTo.getDate() + 6);
            if (paidTo > floor) floor = paidTo;
        }
        let owed = dueIn(floor.getFullYear(), floor.getMonth());
        if (owed < floor) owed = dueIn(floor.getFullYear(), floor.getMonth() + 1);
        if (owed < win.from || owed > win.until) return false;
        const ref = new Date(today);
        ref.setDate(ref.getDate() - CFV_TOLERANCE_DAYS);
        let due = dueIn(ref.getFullYear(), ref.getMonth());
        if (due > ref) due = dueIn(ref.getFullYear(), ref.getMonth() - 1);
        return due <= win.until;
    }
    window.cfvSetOffCovers = cfvSetOffCovers;

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

    // Build tenant lookup from allTenants array. Memoised per sweep so a
    // full CFV detection pass doesn't rebuild it once per tenancy (O(tenancies
    // × tenants)); the cache is keyed on the allTenants reference, so it
    // rebuilds automatically whenever the data array is replaced on refresh.
    let _tenantLookupCache = null;
    let _tenantLookupSource = null;
    function buildTenantLookup() {
        if (_tenantLookupCache && _tenantLookupSource === allTenants) return _tenantLookupCache;
        const lookup = {};
        allTenants.forEach(t => { lookup[t.id] = t; });
        _tenantLookupCache = lookup;
        _tenantLookupSource = allTenants;
        return lookup;
    }

    // Get tenant record linked to a tenancy
    function getTenantForTenancy(tenancy, tenantLookup) {
        const linked = getField(tenancy, F.tenLinkedTenant);
        if (!linked) return null;
        const tenantId = Array.isArray(linked) ? (typeof linked[0] === 'string' ? linked[0] : linked[0]?.id) : null;
        return tenantId ? tenantLookup[tenantId] : null;
    }

    // ── Core "is this tenancy current?" check ──
    // Old version checked "any reconciled transaction this calendar month"
    // which produced both false positives (early payment dated in previous
    // month → not matched → flagged as CFV despite being paid) and false
    // negatives (any unrelated transaction in this month → matched → looked
    // paid despite this month's rent never landing).
    //
    // New version delegates to the arrears engine's count-based check, which
    // compares expected payments (cycles whose maturity window has passed)
    // against actual reconciled payments — robust to date/month boundary
    // edge cases.
    function hasLinkedPaymentThisMonth(tenancyId, today, txIndex) {
        const tenancy = allTenancies.find(t => t.id === tenancyId);
        if (!tenancy) return true; // unknown — don't flag

        // Guard: if no reconciled transaction is linked to this tenancy at all,
        // there is no payment evidence. The arrears engine returns "not in arrears"
        // for tenancies with no start date or no history, producing a false positive
        // "payment detected" that would auto-return new CFVs to In Payment.
        const hasAnyLinkedTx = txIndex
            ? (txIndex.get(tenancyId) || []).length > 0
            : allTransactions.some(tx => {
                if (!getField(tx, F.txReconciled)) return false;
                const links = getField(tx, F.txTenancy);
                if (!links) return false;
                const arr = Array.isArray(links) ? links : [links];
                return arr.some(item => (typeof item === 'object' ? item.id : item) === tenancyId);
            });
        if (!hasAnyLinkedTx) return false;

        const tenantLookup = buildTenantLookup();
        const tenantType = (typeof getTenantTypeForTenancy === 'function')
            ? getTenantTypeForTenancy(tenancy, tenantLookup)
            : null;
        if (typeof isCurrentlyInArrears !== 'function') {
            // Fallback to old logic if arrears.js isn't loaded for some reason
            const thisMonth = today.getMonth();
            const thisYear = today.getFullYear();
            return allTransactions.some(tx => {
                if (!getField(tx, F.txReconciled)) return false;
                const linkedId = extractLinkedId(getField(tx, F.txTenancy));
                if (linkedId !== tenancyId) return false;
                const txDateStr = getField(tx, F.txDate);
                if (!txDateStr) return false;
                const txDate = new Date(txDateStr);
                return txDate.getMonth() === thisMonth && txDate.getFullYear() === thisYear;
            });
        }
        return !isCurrentlyInArrears(tenancy, tenantType, today, txIndex);
    }

    // Detect CFVs using direct tenancy-linked transactions.
    //
    // WRITES ARE OPT-OUT, NOT AUTOMATIC. When a tenancy turns out to have paid,
    // the sweep can queue it back to In Payment in Airtable and post an audit
    // comment. That is right when the CFV tab is on screen or a reconciliation
    // just finished, and wrong when all the caller wanted was a NUMBER.
    //
    // 20260820-queue-fixer-267: counting the sidebar badge and gathering AI
    // context both ran the full detector, so simply opening the dashboard could
    // change a tenancy's Payment Status and write a comment — twice on a cold
    // load, once off the cached render and once off fresh data. The only guard
    // was a localStorage flag, which another browser or a cleared cache walks
    // straight past. Pass {autoReturn:false} from any read-only caller.
    //
    // The count is identical either way: an auto-returned tenancy is one that
    // has paid, so it never appears in the returned list on either path.
    function detectCFVs(opts) {
        const autoReturn = !(opts && opts.autoReturn === false);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tenantLookup = buildTenantLookup();
        // Build the transaction-by-tenancy index ONCE for this whole sweep so the
        // per-tenancy helpers below read only their own payments instead of
        // re-scanning the full transactions array each time (was the main freeze).
        const txIndex = (typeof buildTxByTenancyIndex === 'function') ? buildTxByTenancyIndex() : null;
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
                // the tenancy-ender skill runs. Only exclude when the status is explicitly
                // "Former"; new tenancies may have an empty/null rollup and must still show.
                if (isTenantStatusFormer(tenancy)) return;

                // Rent paid by set-off is paid: never listed as a cash flow void. The status itself is
                // moved by the agent through scripts/tenancy-record.py, never from a page load.
                if (cfvSetOffCovers(tenancy, today, txIndex)) return;

                const paidDetected = hasLinkedPaymentThisMonth(tenancy.id, today, txIndex);

                // Auto-return to In Payment if a linked reconciled transaction exists
                if (paidDetected) {
                    autoReturnQueue.push(tenancy.id);
                    return; // Don't add to CFV list — it's being cleared
                }

                // No re-flag (Kevin, 14 Oct 2026): a CFV or CFV Actioned tenancy is already a CFV.
                // The old rule re-flagged every actioned tenancy once its rent day was 2 days past,
                // which is every month, since an actioned tenancy is unpaid by definition; and
                // confirming the re-flag cleared its dismissal, so the row came straight back.
                // A missed expected payment is moved back with the row's "Move to CFV" button.
                const tenant = getTenantForTenancy(tenancy, tenantLookup);
                cfvList.push(buildCFVEntry(tenancy, tenant, statusName, today, txIndex));
                return;
            }

            // ── Path B: "In Payment" tenancies — check for potential new CFVs ──
            if (statusName !== 'in payment') return;
            if (!isTenantStatusActive(tenancy)) return;

            const rent = Number(getField(tenancy, F.tenRent)) || 0;
            if (rent <= 0) return;
            if (cfvSetOffCovers(tenancy, today, txIndex)) return;   // rent paid by set-off: not a potential CFV

            // Use the new count-based check (handles timing via tolerance
            // windows: 5 days for Working/Agent, 14 days for UC). This
            // catches prior-cycle misses for late-due-day tenants which the
            // old daysOverdue gate missed (e.g. UC dueDay=27 on May 5 was
            // invisible until May 27 passed).
            const paidThisMonth = hasLinkedPaymentThisMonth(tenancy.id, today, txIndex);
            if (paidThisMonth) return; // Paid — not a CFV

            // No linked payment found — flag as potential CFV
            const tenant = getTenantForTenancy(tenancy, tenantLookup);
            const entry = buildCFVEntry(tenancy, tenant, 'potential', today, txIndex);
            entry.autoDetected = true;
            cfvList.push(entry);
        });

        // Process auto-returns in the background (don't block detection)
        if (autoReturn && autoReturnQueue.length > 0) {
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
                if (typeof showToast === 'function') showToast(`Rent restarted — ${surname || tenancyId} auto-returned to In Payment`, { type: 'info' });
            } else {
                // Airtable update failed — remove local flag so it retries next load
                localStorage.removeItem('cfv_' + tenancyId + '_returned');
                console.warn(`CFV auto-return failed for ${tenancyId}`);
            }
        }
        // Re-render after all updates
        if (tenancyIds.length > 0) {
            renderCFVTab();
            refreshCFVSidebarBadges();
        }
    }

    function buildCFVEntry(tenancy, tenant, status, today, txIndex) {
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

        const cfvKey = 'cfv_' + tenancy.id;

        // Most recent reconciled payment linked to this tenancy — used both as the
        // "when did we last actually see money from them?" anchor in the table and
        // to derive days overdue below.
        let lastPaymentDate = null;
        let lastPaymentAmount = null;
        const lpSource = txIndex
            ? (txIndex.get(tenancy.id) || [])
            : (allTransactions || []).filter(tx => getField(tx, F.txReconciled)
                && (typeof txLinkedToTenancy === 'function' ? txLinkedToTenancy(tx, tenancy.id) : false));
        for (const tx of lpSource) {
            const dStr = getField(tx, F.txDate);
            if (!dStr) continue;
            const d = new Date(dStr);
            if (isNaN(d.getTime())) continue;
            if (!lastPaymentDate || d > lastPaymentDate) {
                lastPaymentDate = d;
                lastPaymentAmount = Number(getField(tx, F.txReportAmount) || getField(tx, F.txAmount)) || 0;
            }
        }

        // ── Days overdue — derived from the actual last reconciled payment, NOT a
        // frozen localStorage start date. The old approach stored the due date at
        // first detection and never advanced it, so a tenancy that later made a
        // payment still read an ever-growing figure (e.g. "65 days" when the last
        // payment was five weeks ago). We instead find the cycle the last payment
        // covered and count from the NEXT (first unpaid) monthly due date.
        const CFV_EARLY_PAY_DAYS = 5; // a payment up to 5 days early still pays that cycle
        let daysOverdue = 0;
        if (lastPaymentDate) {
            const dd = dueDay || 1;
            const anchor = new Date(lastPaymentDate);
            anchor.setDate(anchor.getDate() + CFV_EARLY_PAY_DAYS);
            // Cycle the payment covered = latest monthly due date on/before the anchor.
            let coveredDue = new Date(anchor.getFullYear(), anchor.getMonth(), dd);
            if (coveredDue > anchor) coveredDue = new Date(anchor.getFullYear(), anchor.getMonth() - 1, dd);
            const nextDue = new Date(coveredDue.getFullYear(), coveredDue.getMonth() + 1, dd);
            daysOverdue = Math.max(0, Math.floor((today - nextDue) / 86400000));
        } else if (status === 'cfv' || status === 'potential' || status === 'cfv actioned') {
            // No payment history at all — measure from the most recent due date that
            // has already passed (this month's, or last month's if not yet reached).
            const dueThisMonth = new Date(today.getFullYear(), today.getMonth(), dueDay || 1);
            const startDue = dueThisMonth > today
                ? new Date(today.getFullYear(), today.getMonth() - 1, dueDay || 1)
                : dueThisMonth;
            daysOverdue = Math.max(0, Math.floor((today - startDue) / 86400000));
        }

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
            // No "Moved out" button: the letting agent keeps paying when the occupant leaves (Kevin, 6 Aug 2026).
            agentManaged: !!tenant && /agent/i.test(moSel(getField(tenant, F.tenantPayType))),
            chaseStage, chaseStart,
            lastPaymentDate, lastPaymentAmount,
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
        // Hard-refresh on the CFV tab can fire renderCFVTab BEFORE loadDashboard
        // populates the global tenancy/transaction arrays. Show a loading state
        // instead of a blank panel, and trigger a dashboard load so we self-heal
        // without forcing the user back to the Leadership Dashboard.
        if (!allTenancies.length) {
            const summary = document.getElementById('cfvSummaryCards');
            if (summary) {
                summary.innerHTML = `<div class="kpi-card" style="grid-column:1/-1;text-align:center;padding:24px">
                    <div class="spinner" style="margin:0 auto 12px"></div>
                    <div class="kpi-card-label">Loading Cash Flow Voids…</div>
                    <div class="kpi-card-sub">Fetching tenancies and transactions from Airtable</div>
                </div>`;
            }
            // Kick off a dashboard load if one isn't already in flight, then re-render.
            if (typeof loadDashboard === 'function' && !window._cfvSelfHealInFlight) {
                window._cfvSelfHealInFlight = true;
                loadDashboard().finally(() => {
                    window._cfvSelfHealInFlight = false;
                    if (allTenancies.length) renderCFVTab();
                });
            }
            return;
        }

        // Show immediate loading indicator so the tab doesn't appear frozen
        // while the synchronous detectCFVs() sweep runs. That sweep scans every
        // tenancy against the full transactions array (and the arrears engine),
        // which blocks the main thread for a noticeable beat on first open.
        const summaryCards = document.getElementById('cfvSummaryCards');
        const tbody = document.getElementById('cfvTableBody');
        const showedSpinner = summaryCards && !summaryCards.querySelector('.kpi-card-value');
        if (showedSpinner) {
            summaryCards.innerHTML = `<div class="kpi-card" style="grid-column:1/-1;text-align:center;padding:24px">
                <div class="spinner" style="margin:0 auto 12px"></div>
                <div class="kpi-card-label">Loading Cash Flow Voids…</div>
                <div class="kpi-card-sub">Checking every tenancy against this month's payments</div>
            </div>`;
            if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="od-empty-state">
                <div class="spinner" style="margin:0 auto 8px"></div>Loading…</td></tr>`;
            // Yield two animation frames so the browser actually PAINTS the spinner
            // before detectCFVs() blocks the main thread. Without this the spinner
            // HTML is set but never rendered — the user sees the previous tab frozen
            // and assumes the page has crashed.
            //
            // requestAnimationFrame does NOT fire while the document is hidden
            // (background tab, minimised window, headless/automated render). A bare
            // `await new Promise(requestAnimationFrame)` then stays pending forever,
            // leaving the tab stuck on the "Loading Cash Flow Voids…" spinner. Race
            // each frame against a short timeout so a hidden document still makes
            // progress — there is nothing to paint when hidden anyway, and when the
            // tab is visible rAF wins first so the paint guarantee is preserved.
            const nextFrame = () => new Promise(resolve => {
                let settled = false;
                const done = () => { if (!settled) { settled = true; resolve(); } };
                requestAnimationFrame(done);
                setTimeout(done, 50);
            });
            await nextFrame();
            await nextFrame();
        }

        // Auto-return writes to Airtable, so it runs only while this page itself is open. Home shows the
        // same panel read-only (Kevin, 19 Oct 2026): the app opens on Home, and opening a page writes nothing.
        const onCfvPage = !!document.getElementById('tab-cfv')?.classList.contains('active');
        const cfvList = detectCFVs(onCfvPage ? undefined : { autoReturn: false });
        const today = new Date();

        // DO NOT auto-update Airtable — show potential CFVs for user approval
        // User must confirm before status changes in Airtable

        // Filter out dismissed potential CFVs using localStorage (instant, no API).
        // syncDismissalsFromAirtable runs in the background below to restore any
        // localStorage entries lost by cache clears; if it finds any, it re-renders.
        // The rule itself lives in cfvIsVisible() so the sidebar badge and this
        // table can never disagree about what counts.
        const filteredList = cfvList.filter(cfvIsVisible);

        // Background: restore dismissals from Airtable comments for potential
        // CFVs where localStorage is empty (e.g. user cleared site data). If any
        // are restored, re-render so the dismissed entries disappear.
        const potentialEntries = cfvList.filter(e => e.status === 'potential');
        if (potentialEntries.length > 0) {
            // Re-render ONLY when a dismissal was NEWLY restored this run. The old
            // check ("does any potential entry have a dismissal in localStorage")
            // stayed true forever once any potential CFV had been dismissed, so it
            // re-rendered on every render — an infinite loop that made the table
            // shake and the comment buttons flicker.
            syncDismissalsFromAirtable(potentialEntries).then((restored) => {
                if (restored > 0) renderCFVTab();
            });
        }

        // Summary
        const potentialCfvs = filteredList.filter(e => e.status === 'potential');
        const cfvOnly = filteredList.filter(e => e.status === 'cfv' || e.status === 'potential');
        const confirmedCfvs = filteredList.filter(e => e.status === 'cfv');
        const cfvActioned = filteredList.filter(e => e.status === 'cfv actioned');
        const totalExposure = filteredList.reduce((s, e) => s + e.rent, 0);
        const oldestOverdue = cfvOnly.length ? Math.max(...cfvOnly.map(e => e.daysOverdue)) : 0;

        if (summaryCards) {
            summaryCards.innerHTML = `
                ${potentialCfvs.length > 0 ? `<div class="kpi-card" style="border-color:var(--warning);border-width:2px">
                    <div class="kpi-card-label" style="color:var(--warning)">⚠ Potential CFVs</div>
                    <div class="kpi-card-value" style="color:var(--warning)">${potentialCfvs.length}</div>
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
                    <div class="kpi-card-value" style="color:var(--warning)">${cfvActioned.length}</div>
                    <div class="kpi-card-sub">${cfvActioned.length > 0 ? 'Awaiting payment confirmation' : 'No actioned CFVs'}</div>
                </div>
            `;
        }

        // Update sidebar badges
        updateCFVSidebarBadges(confirmedCfvs.length + potentialCfvs.length, cfvActioned.length);

        // Render the Arrears Pipeline section below the legacy CFV table.
        // Loads arrears records on demand so the section appears as soon as the
        // tab is opened, even if the engine sweep hasn't completed yet.
        if (typeof loadArrearsRecords === 'function' && typeof renderArrearsSection === 'function') {
            loadArrearsRecords().finally(() => renderArrearsSection('arrearsPipelineContainer'));
        }

        // Table
        if (!tbody) return;

        if (filteredList.length === 0) {
            tbody.innerHTML = `<tr><td colspan="9" class="od-empty-state">No cash flow voids detected. All tenancies are in payment.</td></tr>`;
            return;
        }

        // Render table immediately with placeholder comment buttons.
        // Comment counts are fetched in the background and button labels
        // are updated as they arrive (no blocking await).
        const commentCounts = {};

        // Sort: Potential first, then CFV, then CFV Actioned — by due day
        filteredList.sort((a, b) => {
            const statusOrder = { 'potential': 0, 'cfv': 1, 'cfv actioned': 2 };
            const sDiff = (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0);
            if (sDiff !== 0) return sDiff;
            return (a.dueDay || 99) - (b.dueDay || 99);
        });

        tbody.innerHTML = filteredList.map((entry, idx) => {
            const statusBadge = entry.status === 'cfv actioned'
                ? '<span class="cfv-status-badge cfv-actioned">CFV Actioned</span>'
                : entry.status === 'potential'
                ? '<span class="cfv-status-badge potential">Potential CFV</span>'
                : '<span class="cfv-status-badge cfv">CFV</span>';

            // Contact info
            let contactHtml = '';
            if (entry.tenantPhone || entry.tenantEmail) {
                contactHtml = '<div class="cfv-contact-info">';
                if (entry.tenantPhone) {
                    const telClean = String(entry.tenantPhone).replace(/[^0-9+]/g, '');
                    contactHtml += telClean
                        ? `<a href="tel:${escHtml(telClean)}">${escHtml(entry.tenantPhone)}</a><br>`
                        : `${escHtml(entry.tenantPhone)}<br>`;
                }
                if (entry.tenantEmail) {
                    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(entry.tenantEmail).trim());
                    contactHtml += emailOk
                        ? `<a href="mailto:${escHtml(String(entry.tenantEmail).trim())}">${escHtml(entry.tenantEmail)}</a>`
                        : `${escHtml(entry.tenantEmail)}`;
                }
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
                    <button class="cfv-action-btn" style="background:var(--danger);color:white;border-color:var(--danger)" onclick="event.stopPropagation(); cfvConfirmAsCFV('${entry.tenancyId}','${escJs(entry.surname)}',this)">Confirm CFV</button>
                    <button class="cfv-action-btn success" onclick="event.stopPropagation(); cfvDismissAsCFV('${entry.tenancyId}','${escJs(entry.surname)}',this)" style="margin-top:4px">Not a CFV</button>
                `;
            } else if (entry.status === 'cfv') {
                // Confirmed CFV — can mark actioned
                actionsHtml = `
                    <button class="cfv-action-btn primary" onclick="event.stopPropagation(); cfvConfirmAction('actioned','${entry.tenancyId}','${escJs(entry.surname)}',this)">Mark Actioned</button>
                    <button class="cfv-action-btn" data-comment-btn="${entry.tenancyId}" onclick="event.stopPropagation(); cfvShowComments('${entry.tenancyId}','${escJs(entry.surname)}','${escJs(entry.ref)}')" style="margin-top:4px">${commentBtnLabel}</button>
                `;
            } else {
                // CFV Actioned — can return to In Payment or move back to CFV
                actionsHtml = `
                    <button class="cfv-action-btn success" onclick="event.stopPropagation(); cfvConfirmAction('inpayment','${entry.tenancyId}','${escJs(entry.surname)}',this)">In Payment</button>
                    <button class="cfv-action-btn" style="border-color:var(--danger);color:var(--danger);margin-top:4px" onclick="event.stopPropagation(); cfvConfirmAction('cfv','${entry.tenancyId}','${escJs(entry.surname)}',this)">Move to CFV</button>
                    <button class="cfv-action-btn" data-comment-btn="${entry.tenancyId}" onclick="event.stopPropagation(); cfvShowComments('${entry.tenancyId}','${escJs(entry.surname)}','${escJs(entry.ref)}')" style="margin-top:4px">${commentBtnLabel}</button>
                `;
            }

            if (!entry.agentManaged) {
                actionsHtml += `
                    <button class="cfv-action-btn" data-moved-out="${entry.tenancyId}" onclick="event.stopPropagation(); cfvMovedOut('${entry.tenancyId}','${escHtml(escJs(entry.surname))}')" style="margin-top:4px">Moved out</button>
                `;
            }

            // Payment detected banner removed — auto-return handles this now

            return `<tr>
                <td class="od-cell-bold">${entry.tenantId
                    ? `<a href="#" onclick="event.preventDefault();event.stopPropagation();cfvNavToTenant('${entry.tenantId}')" style="color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent)" title="View in Operations">${escHtml(entry.surname)}</a>`
                    : escHtml(entry.surname)}<br><span class="od-text-muted-sm">${escHtml(entry.ref)}</span></td>
                <td>${escHtml(entry.propertyName)}<br><span class="od-text-muted-sm">${escHtml(entry.unitName)}</span></td>
                <td class="od-cell-num od-cell-bold">${fmt(entry.rent)}</td>
                <td class="od-cell-center">${entry.dueDay || '—'}</td>
                <td class="od-cell-center" style="font-weight:700;color:${entry.daysOverdue > 7 ? 'var(--danger)' : entry.daysOverdue > 3 ? 'var(--warning)' : 'var(--text-primary)'}">${entry.daysOverdue}</td>
                <td class="od-cell-nowrap">${entry.lastPaymentDate
                    ? `${entry.lastPaymentDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}<br><span class="od-text-muted-sm od-cell-num">${fmt(entry.lastPaymentAmount)}</span>`
                    : '<span style="color:var(--text-muted);font-style:italic">never</span>'}</td>
                <td>${statusBadge}</td>
                <td>${contactHtml}</td>
                <td style="min-width:100px" onclick="event.stopPropagation()">${actionsHtml}</td>
            </tr>`;
        }).join('');

        // Background: fetch comment counts and update button labels as they arrive.
        // The table is already visible with "Comments" placeholders; this just
        // adds the count badges without blocking the initial render.
        Promise.all(filteredList.map(entry => limitedApiFetch(async () => {
            try {
                const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tenancies}/${entry.tenancyId}/comments`, {
                    headers: { 'Authorization': 'Bearer ' + PAT }
                });
                if (resp.ok) {
                    const data = await resp.json();
                    const cc = (data.comments || []).length;
                    if (cc > 0) {
                        const label = `💬 ${cc} comment${cc !== 1 ? 's' : ''}`;
                        document.querySelectorAll(`[data-comment-btn="${entry.tenancyId}"]`).forEach(btn => {
                            btn.textContent = label;
                        });
                    }
                }
            } catch (e) { /* non-fatal — buttons keep their placeholder label */ }
        })));

        // ── Sync Bar + Health Checks ──
        // Compute the CFV list and tenant lookup ONCE for all passive health
        // checks below. Previously each check called detectCFVs() itself, so the
        // heavy tenancy×transaction sweep ran 5 extra times on every render —
        // the main cause of the tab freezing, the page feeling glitchy, and the
        // dashboard sub-tab buttons blanking (a frozen main thread cannot paint).
        // detectCFVs() already ran at the top of this render (`cfvList`); reuse it.
        const hcCfvList = cfvList;
        const hcLookup = buildTenantLookup();
        if (typeof registerSyncBar === 'function') {
            registerSyncBar('cfv', {
                // loadDashboard re-fetches the underlying tenancies/transactions; renderCFVTab
                // re-derives this tab's view from those globals. Both must run for the user's
                // refresh click to actually reflect new data on this specific tab.
                refreshFn: async () => { await loadDashboard(); await renderCFVTab(); },
                checks: [
                    {
                        name: 'CFV detection runs without error', kind: 'sync', run: () => {
                            // detectCFVs() already ran for this render without throwing
                            // (we are here because it returned), so report on that result
                            // rather than running the heavy sweep a second time.
                            return { status: 'pass', detail: `${hcCfvList.length} CFV entries computed (CFV + actioned + potential)` };
                        }
                    },
                    {
                        name: 'Tenancy → Tenant link resolves', kind: 'sync', run: () => {
                            const orphans = hcCfvList.filter(e => !hcLookup[(e.tenantId || '')]);
                            if (orphans.length) return { status: 'warn', detail: `${orphans.length} CFV tenancies have no resolvable tenant record` };
                            return { status: 'pass', detail: `All ${hcCfvList.length} CFV entries have a linked tenant` };
                        }
                    },
                    {
                        name: 'Days-overdue figure populated for each CFV', kind: 'sync', run: () => {
                            const cfvOnly = hcCfvList.filter(e => e.status === 'cfv' || e.status === 'cfv actioned');
                            const missing = cfvOnly.filter(e => e.daysOverdue == null || isNaN(e.daysOverdue));
                            if (missing.length) return { status: 'fail', detail: `${missing.length} CFV(s) missing daysOverdue value — formula on Tenancies table may be broken` };
                            return { status: 'pass', detail: `All ${cfvOnly.length} CFV entries have daysOverdue computed` };
                        }
                    },
                    {
                        name: 'CFV exposure number computed', kind: 'sync', run: () => {
                            const exposure = hcCfvList.filter(e => e.status === 'cfv' || e.status === 'cfv actioned')
                                .reduce((s, e) => s + (Number(e.rent) || 0), 0);
                            if (isNaN(exposure)) return { status: 'fail', detail: 'Exposure calculation produced NaN' };
                            return { status: 'pass', detail: `Total CFV exposure: ${fmt(exposure)}` };
                        }
                    },
                    {
                        name: 'Sidebar CFV badges in sync with detection', kind: 'automation', run: () => {
                            // This check used to compute its own numbers and then report
                            // "sidebar badges match" unconditionally — it could never fail,
                            // and its dismissal filter disagreed with the one the badge
                            // actually uses (it treated confirmed CFVs as dismissable; the
                            // render path only ever dismisses 'potential'). Now it reads the
                            // rendered badges and fails on a real mismatch.
                            // Same rule the badge uses, by calling it — a check
                            // with its own copy of the rule cannot catch the rule
                            // being wrong.
                            const visible = hcCfvList.filter(cfvIsVisible);
                            const cfvCount = visible.filter(e => e.status === 'cfv' || e.status === 'potential').length;
                            const actionedCount = visible.filter(e => e.status === 'cfv actioned').length;
                            const readBadge = cls => {
                                const el = document.querySelector('.cfv-sidebar-badge.' + cls);
                                return el ? Number(el.textContent.trim()) : 0;   // absent badge means zero
                            };
                            const shownCfv = readBadge('cfv-red');
                            const shownActioned = readBadge('cfv-orange');
                            if (shownCfv !== cfvCount || shownActioned !== actionedCount) {
                                return { status: 'fail', detail: `Sidebar shows ${shownCfv} unactioned · ${shownActioned} actioned, detection says ${cfvCount} · ${actionedCount} — badge is stale` };
                            }
                            return { status: 'pass', detail: `${cfvCount} unactioned · ${actionedCount} actioned · verified against the rendered badges` };
                        }
                    },
                    {
                        name: 'Dismissals persist across devices', kind: 'automation', run: () => {
                            const localCount = Object.keys(localStorage).filter(k => k.startsWith('cfv_dismissed_')).length;
                            return { status: 'pass', detail: `${localCount} potential-CFV dismissals stored locally; restored from Airtable comments on load` };
                        }
                    },
                ],
            });
            markTabSynced('cfv');
        }
    }

    // ── CFV Actions ──

    async function updateTenancyStatus(tenancyId, statusSelectId) {
        if (!PAT) { showToast('No Airtable token — cannot update status', { type: 'error' }); return false; }
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tenancies}/${tenancyId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: { [F.tenPayStatus]: statusSelectId === CFV_STATUS_IDS.inPayment ? 'In Payment' : statusSelectId === CFV_STATUS_IDS.cfvActioned ? 'CFV Actioned' : statusSelectId === CFV_STATUS_IDS.cfv ? 'CFV' : { id: statusSelectId } } })
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                console.error('Airtable PATCH failed:', resp.status, JSON.stringify(err));
                showToast(`Failed to update Airtable (${resp.status}): ${err.error?.message || 'Unknown error'}`, { type: 'error', duration: 6000 });
                return false;
            }
            return true;
        } catch (e) {
            console.error('Failed to update tenancy status:', e);
            showToast('Network error updating Airtable: ' + e.message, { type: 'error', duration: 6000 });
            return false;
        }
    }

    // Confirmation step before any status change
    async function cfvConfirmAction(action, tenancyId, surname, btn) {
        const labels = { actioned: 'Mark as CFV Actioned', inpayment: 'Return to In Payment', cfv: 'Move back to CFV' };
        const msg = `Are you sure you want to ${labels[action] || action} for ${surname}?`;
        if (!await showConfirm(msg, { title: labels[action] || 'Confirm', danger: action === 'cfv' })) return;
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
        btn.style.background = 'var(--danger-bg)';
        btn.style.color = 'var(--danger)';
        setTimeout(() => renderCFVTab(), 1500);
        // Bust the IDB cache before reloading. Without this, loadDashboard's
        // "instant render from cache" path returns stale data from before the
        // PATCH and overwrites our in-memory mutation, reverting the action.
        // (Symptom: clicking Confirm CFV on Tenancy A then Tenancy B caused
        // A to flip back to Potential CFV when B's loadDashboard fired.)
        setTimeout(async () => { if (typeof clearDashCache === 'function') await clearDashCache(); loadDashboard(); }, 3000);
    }

    function cfvDismissReturn(tenancyId, btn) {
        localStorage.setItem('cfv_' + tenancyId + '_returnDismissed', '1');
        const row = btn.closest('tr');
        if (row) row.style.display = 'none';
    }

    // Confirm a potential CFV — update Airtable status to CFV
    async function cfvConfirmAsCFV(tenancyId, surname, btn) {
        if (!await showConfirm(`Confirm ${surname} as a Cash Flow Void?\n\nThis will update the payment status to CFV in Airtable.`, { title: 'Confirm CFV', danger: true })) return;
        btn.textContent = '...';
        btn.disabled = true;
        const ok = await updateTenancyStatus(tenancyId, CFV_STATUS_IDS.cfv);
        if (!ok) { btn.textContent = 'Failed'; btn.disabled = false; return; }
        await addTenancyComment(tenancyId, 'Confirmed as CFV from Leadership Dashboard.');
        const rec = allTenancies.find(t => t.id === tenancyId);
        if (rec) rec.fields[F.tenPayStatus] = { id: CFV_STATUS_IDS.cfv, name: 'CFV' };
        btn.textContent = 'Confirmed ✓';
        btn.style.background = 'var(--danger-bg)';
        btn.style.color = 'var(--danger)';
        setTimeout(() => renderCFVTab(), 1500);
        // Bust the IDB cache before reloading. Without this, loadDashboard's
        // "instant render from cache" path returns stale data from before the
        // PATCH and overwrites our in-memory mutation, reverting the action.
        // (Symptom: clicking Confirm CFV on Tenancy A then Tenancy B caused
        // A to flip back to Potential CFV when B's loadDashboard fired.)
        setTimeout(async () => { if (typeof clearDashCache === 'function') await clearDashCache(); loadDashboard(); }, 3000);
    }

    // Dismiss a potential CFV — not a real CFV, return to In Payment
    async function cfvDismissAsCFV(tenancyId, surname, btn) {
        if (!await showConfirm(`Dismiss ${surname} as not a CFV?\n\nThis will keep the tenancy as In Payment.`, { title: 'Dismiss CFV' })) return;
        btn.textContent = '...';
        btn.disabled = true;
        // Store dismissal locally so it doesn't reappear until next cycle
        const now = new Date();
        localStorage.setItem('cfv_dismissed_' + tenancyId, now.toISOString());
        // Clear any chase data that was started
        localStorage.removeItem('cfv_' + tenancyId + '_chaseStart');
        localStorage.removeItem('cfv_' + tenancyId + '_startDate');
        // Also post a structured Airtable comment so the dismissal survives
        // browser cache clears. The tag is machine-readable by syncDismissalsFromAirtable.
        const tag = `[CFV-DISMISSED:${now.toISOString().split('T')[0]}]`;
        await addTenancyComment(tenancyId, `${tag} Dismissed as not a CFV from Leadership Dashboard. Payment confirmed via other means.`);
        btn.textContent = 'Dismissed ✓';
        btn.style.background = 'var(--success-bg)';
        btn.style.color = 'var(--success)';
        setTimeout(() => renderCFVTab(), 1500);
    }

    // Rebuild missing localStorage dismissals from Airtable comments.
    // Handles the case where the user cleared site data or switched browser — previously
    // dismissed CFVs would all reappear because localStorage was wiped. Now the dismissal
    // lives permanently as a comment on the tenancy record, so we can restore it.
    async function syncDismissalsFromAirtable(potentialEntries) {
        if (!PAT || !potentialEntries.length) return 0;
        let restored = 0; // count of dismissals NEWLY written to localStorage this run
        await Promise.all(potentialEntries.map(entry => limitedApiFetch(async () => {
            if (localStorage.getItem('cfv_dismissed_' + entry.tenancyId)) return; // already have it
            let comments;
            try {
                comments = await fetchAllComments(TABLES.tenancies, entry.tenancyId);
            } catch (e) { return; }
            // Find the most recent dismissal comment. Match either the new structured
            // tag [CFV-DISMISSED:YYYY-MM-DD] or the historic free-text form so pre-tag
            // dismissals are also recognised.
            let latest = null;
            for (const c of comments) {
                const text = c.text || '';
                const hasTag = /\[CFV-DISMISSED:\d{4}-\d{2}-\d{2}\]/.test(text);
                const hasLegacy = /Dismissed as not a CFV/i.test(text);
                if (!hasTag && !hasLegacy) continue;
                const d = new Date(c.createdTime);
                if (!latest || d > latest) latest = d;
            }
            if (!latest) return;
            // Apply the same "expires at next due day + tolerance" rule used in
            // renderCFVTab's filter, so restored dismissals respect the current cycle.
            const dueDay = entry.dueDay || 1;
            let nextDueDate = new Date(latest.getFullYear(), latest.getMonth(), dueDay);
            if (nextDueDate <= latest) {
                nextDueDate = new Date(latest.getFullYear(), latest.getMonth() + 1, dueDay);
            }
            const expiryTime = nextDueDate.getTime() + CFV_TOLERANCE_DAYS * 86400000;
            if (Date.now() < expiryTime) {
                localStorage.setItem('cfv_dismissed_' + entry.tenancyId, latest.toISOString());
                restored++;
            }
        })));
        return restored;
    }

    async function cfvMarkActioned(tenancyId, btn) {
        btn.textContent = '...';
        btn.disabled = true;
        const ok = await updateTenancyStatus(tenancyId, CFV_STATUS_IDS.cfvActioned);
        if (!ok) { btn.textContent = 'Failed'; btn.disabled = false; return; }
        await addTenancyComment(tenancyId, 'Status changed to CFV Actioned from Leadership Dashboard.');
        btn.textContent = 'Done ✓';
        btn.style.background = 'var(--success-bg)';
        btn.style.color = 'var(--success)';
        const rec = allTenancies.find(t => t.id === tenancyId);
        if (rec) rec.fields[F.tenPayStatus] = { id: CFV_STATUS_IDS.cfvActioned, name: 'CFV Actioned', color: 'yellowLight2' };
        setTimeout(() => renderCFVTab(), 1500);
        // Bust the IDB cache before reloading. Without this, loadDashboard's
        // "instant render from cache" path returns stale data from before the
        // PATCH and overwrites our in-memory mutation, reverting the action.
        // (Symptom: clicking Confirm CFV on Tenancy A then Tenancy B caused
        // A to flip back to Potential CFV when B's loadDashboard fired.)
        setTimeout(async () => { if (typeof clearDashCache === 'function') await clearDashCache(); loadDashboard(); }, 3000);
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
        btn.style.background = 'var(--success-bg)';
        btn.style.color = 'var(--success)';
        setTimeout(() => renderCFVTab(), 1000);
        // Bust the IDB cache before reloading. Without this, loadDashboard's
        // "instant render from cache" path returns stale data from before the
        // PATCH and overwrites our in-memory mutation, reverting the action.
        // (Symptom: clicking Confirm CFV on Tenancy A then Tenancy B caused
        // A to flip back to Potential CFV when B's loadDashboard fired.)
        setTimeout(async () => { if (typeof clearDashCache === 'function') await clearDashCache(); loadDashboard(); }, 3000);
    }

    // ── Moved out (Kevin, 31 Oct 2026) ──
    // "When a cash flow void turns into a move-out, we can just click a button ... It updates everything
    // accordingly, and the system is accurate once again." One confirmed click ends the tenancy the way the
    // airtable-tenancy-ender skill does, behind its six-question gate. Every doubt shows in the box BEFORE anything
    // is written and he settles it there (his call, 31 Oct: the box, not approval cards). Every read is fresh, by a
    // list on RECORD_ID (a GET by id ignores the table in the URL), every write is read back, and a failed step stops
    // the run and names itself. What it writes, in this order, so that a run stopped early leaves the row on the page
    // and pressing the button again finishes the job (the plan is re-read, so a step already done reads as done):
    //   1. the tenancy's open tasks: Cancelled, never deleted, each with a comment saying why.
    //   2. the unit: Void, only when it reads Occupied (or blank) and no other live tenancy in the Tenancies table sits
    //      on it. The unit's legacy link (Tenancies copy, a dead table whose rows still read "Live") does not count.
    //   3. each tenant: this unit off Current Unit, and Former, unless they still have another live tenancy with us
    //      (a tenant moving between our houses keeps that one, Kevin 29 Oct 2026; one on the same unit keeps the unit).
    //   4. the tenancy: End Date = the move-out date, Payment Status cleared. It KEEPS its Rental Unit link as
    //      history: the end date is what every page and robot reads as finished (isTenancyEnded, rent-check is_live).
    //   5. one dated comment on the tenancy listing every change and every step skipped; if a step fails, a comment
    //      saying where it stopped, what was done and what was not.
    // Never offered on an agent-managed tenancy (buildCFVEntry), and refused if one gets here.
    const MO_CLOSED_TASK = ['Completed', 'Cancelled'];
    const MO_REC_RE = /^rec[A-Za-z0-9]{14}$/;

    function moSel(v) { return v && typeof v === 'object' && !Array.isArray(v) ? String(v.name || '') : String(v || ''); }
    function moIds(v) { return (Array.isArray(v) ? v : []).map(x => (x && typeof x === 'object') ? x.id : x).filter(Boolean); }
    function moDay(v) {
        const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    }
    function moIso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
    function moLong(iso) {
        const d = moDay(iso);
        return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : String(iso || '');
    }
    function moToday() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    // Another tenancy still holds the unit or the tenant while it has no end date, or one AFTER today. An end date of
    // today counts as gone: it is what this button writes for a tenant who left today, so two tenants leaving one
    // unit on the same day must free it (independent review, 31 Oct 2026). isTenancyEnded keeps today's row on the
    // page; this is only the gate's question, "is anyone else still here?".
    function moLive(rec) { const end = moDay(rec.fields[F.tenEndDate]); return !end || end > moToday(); }

    // Records by id from ONE table, read as a list so the table is proved. Ids come off link fields; anything that
    // is not a record id never reaches the formula.
    async function moRead(tableId, ids) {
        const unique = [...new Set(ids)].filter(id => MO_REC_RE.test(id));
        const out = [];
        for (let i = 0; i < unique.length; i += 40) {
            const part = unique.slice(i, i + 40).map(id => `RECORD_ID()='${id}'`);
            out.push(...await airtableFetch(tableId, { filterByFormula: part.length === 1 ? part[0] : `OR(${part.join(',')})` }));
        }
        return out;
    }

    // Everything the button would do, read fresh. Refusals stop it; warnings are shown and he decides.
    async function moBuildPlan(tenancyId) {
        const [tenancy] = await moRead(TABLES.tenancies, [tenancyId]);
        if (!tenancy) throw new Error('This tenancy is not in the Tenancies table.');
        const tf = tenancy.fields;
        const unitIds = moIds(tf[F.tenUnit]);
        const tenantIds = moIds(tf[F.tenLinkedTenant]);
        const [tenants, units, tasks] = await Promise.all([
            moRead(TABLES.tenants, tenantIds),
            moRead(TABLES.rentalUnits, unitIds),
            moRead(TABLES.tasks, moIds(tf[F.tenTasks])),
        ]);
        // The other tenancies of each tenant and on each unit, in one read.
        const otherIds = [...tenants.flatMap(t => moIds(t.fields[F.tenantTenancies])),
                          ...units.flatMap(u => moIds(u.fields[F.unitTenancies]))].filter(id => id !== tenancyId);
        const others = new Map((await moRead(TABLES.tenancies, otherIds)).map(r => [r.id, r]));
        const liveOther = id => id !== tenancyId && others.has(id) && moLive(others.get(id));
        const unreadOthers = new Set(otherIds.filter(id => MO_REC_RE.test(id))).size - others.size;
        const refOf = id => String(others.get(id)?.fields[F.tenRef] || id);

        const plan = {
            tenancyId, ref: String(tf[F.tenRef] || tenancyId), status: moSel(tf[F.tenPayStatus]),
            start: tf[F.tenStartDate] || '', refusals: [], warnings: [], tenants: [], units: [], tasks: [],
        };
        if (tf[F.tenEndDate]) plan.refusals.push(`This tenancy already has an end date (${moLong(tf[F.tenEndDate])}).`);
        if (!tenantIds.length) plan.warnings.push('No tenant is linked to this tenancy, so no tenant record changes.');
        if (!unitIds.length) plan.warnings.push('No rental unit is linked to this tenancy, so no unit changes.');
        // A linked record that does not read back is a doubt, never a silent skip.
        if (tenants.length !== new Set(tenantIds).size) plan.refusals.push('A tenant linked to this tenancy could not be read from Airtable.');
        if (units.length !== new Set(unitIds).size) plan.refusals.push('The rental unit linked to this tenancy could not be read from Airtable.');
        // An unread one would count as gone, which fails toward voiding the unit and marking the tenant Former.
        if (unreadOthers) plan.refusals.push('Another tenancy linked to this tenant or unit could not be read from Airtable.');

        for (const t of tenants) {
            const name = String(t.fields[F.tenantName] || t.id);
            if (/agent/i.test(moSel(t.fields[F.tenantPayType]))) {
                plan.refusals.push(`${name} is a letting agent: the agent keeps paying when the occupant leaves, so this tenancy is never ended for a move-out.`);
            }
            const elsewhere = moIds(t.fields[F.tenantTenancies]).filter(liveOther);
            const current = moIds(t.fields[F.tenantCurrentUnit]);
            // A live tenancy of theirs on this same unit (an old record left open by a rent change) keeps the unit.
            const keep = new Set(elsewhere.flatMap(id => moIds(others.get(id).fields[F.tenUnit])));
            const after = elsewhere.length ? current.filter(u => !unitIds.includes(u) || keep.has(u)) : [];
            plan.tenants.push({
                id: t.id, name, former: !elsewhere.length, wasFormer: moSel(t.fields[F.tenantStatus]) === 'Former',
                currentAfter: after, unlinks: current.length !== after.length, elsewhere: elsewhere.map(refOf),
            });
        }
        for (const u of units) {
            const name = String(u.fields[F.unitName] || u.id);
            const live = moIds(u.fields[F.unitTenancies]).filter(liveOther);
            // Only an Occupied (or blank) unit is voided: Rent Ready and Not Ready already say nobody lives there.
            const status = moSel(u.fields[F.unitStatus]);
            plan.units.push({ id: u.id, name, status, voidIt: !live.length && (!status || status === 'Occupied'), liveOthers: live.map(refOf) });
            if (live.length) plan.warnings.push(`${name} stays as it is: ${live.map(refOf).join(', ')} is still live on it. If that tenant has gone too, end that tenancy separately.`);
        }
        plan.tasks = tasks.filter(t => !MO_CLOSED_TASK.includes(moSel(t.fields[TASK_FIELDS.status])))
            .map(t => ({ id: t.id, name: String(t.fields[TASK_FIELDS.name] || t.id) }));
        return plan;
    }

    // What the date changes: a date in the future or before the tenancy began is refused, and money paid in after
    // it is shown (from the page's reconciled payments, so it lists what the page knows).
    function moDateCheck(plan, iso) {
        const day = moDay(iso);
        if (!day) return { refusals: ['Pick the move-out date.'], warnings: [] };
        const refusals = [];
        if (day > moToday()) refusals.push('The move-out date cannot be in the future.');
        const start = moDay(plan.start);
        if (start && day < start) refusals.push(`The move-out date is before the tenancy began (${moLong(plan.start)}).`);
        const txs = (typeof buildTxByTenancyIndex === 'function' ? buildTxByTenancyIndex().get(plan.tenancyId) : null) || [];
        const after = txs.map(tx => ({ d: moDay(getField(tx, F.txDate)), amt: Number(getField(tx, F.txReportAmount) || getField(tx, F.txAmount)) || 0 }))
            .filter(p => p.d && p.d > day && p.amt > 0).sort((a, b) => a.d - b.d);
        const warnings = after.map(p => `${fmt(p.amt)} came in on ${moLong(moIso(p.d))}, after the move-out date. Check whether it is owed back.`);
        return { refusals, warnings };
    }

    // The part of a plan that decides the writes. Read again at Confirm: if it changed while the box was open,
    // nothing is written.
    function moSignature(plan) {
        return JSON.stringify([plan.status, plan.start, plan.refusals, plan.tenants.map(t => [t.id, t.former, t.currentAfter]),
                               plan.units.map(u => [u.id, u.voidIt]), plan.tasks.map(t => t.id)]);
    }

    function moChangeLines(plan, iso) {
        const lines = [`Tenancy ${plan.ref}: end date ${moLong(iso)}, payment status cleared${plan.status ? ` (now ${plan.status})` : ''}.`];
        for (const t of plan.tenants) {
            if (t.former) lines.push(`${t.name}: ${t.wasFormer ? 'already Former' : 'marked Former'}${t.unlinks ? ', unlinked from the unit' : ''}.`);
            else lines.push(`${t.name}: stays Active, still a tenant at ${t.elsewhere.join(', ')}${t.unlinks ? ', unlinked from this unit' : ''}.`);
        }
        for (const u of plan.units) {
            if (u.voidIt) lines.push(`${u.name}: set to Void.`);
            else if (u.liveOthers.length) lines.push(`${u.name}: left as it is (another live tenancy).`);
            else lines.push(`${u.name}: already ${u.status}, left as it is.`);
        }
        lines.push(plan.tasks.length
            ? `${plan.tasks.length} open task${plan.tasks.length === 1 ? '' : 's'} cancelled, each with a note: ${plan.tasks.map(t => t.name).join('; ')}.`
            : 'No open tasks to cancel.');
        return lines;
    }

    // A write or comment, retried while Airtable says 429 (five requests a second per base, shared with the robots),
    // as airtableFetch does for reads. A busy moment must never stop a run halfway.
    async function moSend(url, init) {
        for (let attempt = 0; ; attempt++) {
            const resp = await fetch(url, init);
            if (resp.status !== 429 || attempt === 3) return resp;
            await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 8000)));
        }
    }

    async function moPatch(tableId, id, fields) {
        const resp = await moSend(`https://api.airtable.com/v0/${BASE_ID}/${tableId}/${id}`, {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields }),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(`Airtable refused the change (${resp.status}${err.error?.message ? ': ' + err.error.message : ''})`);
        }
    }

    // Read the record back and prove every field landed. null = blank; an array = exactly these linked ids.
    async function moReadBack(tableId, id, want) {
        const [rec] = await moRead(tableId, [id]);
        if (!rec) throw new Error('it could not be read back');
        for (const [fid, value] of Object.entries(want)) {
            const got = rec.fields[fid];
            const ok = value === null ? (got == null || got === '' || (Array.isArray(got) && !got.length))
                : Array.isArray(value) ? JSON.stringify(moIds(got).sort()) === JSON.stringify([...value].sort())
                : moSel(got) === value;
            if (!ok) throw new Error('the change did not land when read back');
        }
    }

    async function moComment(tableId, id, text) {
        try {
            const resp = await moSend(`https://api.airtable.com/v0/${BASE_ID}/${tableId}/${id}/comments`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
            });
            return resp.ok;
        } catch (e) {
            console.warn('Moved out: comment not saved', e);
            return false;
        }
    }

    // The writes, in the order above. onStep(text, ok) reports each one. Throws at the first failed write, naming it,
    // after leaving a comment on the tenancy that says where it stopped.
    async function moRun(plan, iso, onStep) {
        const today = moLong(moIso(moToday()));
        const steps = [];   // { label, note, run }: what the box shows, what the tenancy comment says, the write
        for (const task of plan.tasks) {
            steps.push({ label: `Task cancelled: ${task.name}`, note: `Task cancelled: ${task.name} (${task.id}).`, run: async () => {
                await moPatch(TABLES.tasks, task.id, { [TASK_FIELDS.status]: 'Cancelled' });
                await moReadBack(TABLES.tasks, task.id, { [TASK_FIELDS.status]: 'Cancelled' });
                const why = `Cancelled on ${today}: the tenant moved out on ${moLong(iso)} and tenancy ${plan.ref} was ended from the Cash Flow Voids page.`;
                if (!await moComment(TABLES.tasks, task.id, why)) onStep(`The note on task "${task.name}" did not save. The task is cancelled.`, false);
            } });
        }
        for (const u of plan.units.filter(u => u.voidIt)) {
            steps.push({ label: `${u.name} set to Void`, note: `${u.name}: Void.`, run: async () => {
                await moPatch(TABLES.rentalUnits, u.id, { [F.unitStatus]: 'Void' });
                await moReadBack(TABLES.rentalUnits, u.id, { [F.unitStatus]: 'Void' });
            } });
        }
        // Tenants who stay Active first: one marked Former hides the row (isTenantStatusFormer), so a joint tenancy
        // stopped between two tenants must stop before that, while the button can still finish it.
        for (const t of [...plan.tenants].sort((a, b) => Number(a.former) - Number(b.former))) {
            const fields = {};
            if (t.former && !t.wasFormer) fields[F.tenantStatus] = 'Former';
            if (t.unlinks) fields[F.tenantCurrentUnit] = t.currentAfter;
            if (!Object.keys(fields).length) continue;
            steps.push({
                label: `${t.name} ${t.former ? 'marked Former' : 'kept Active'}${t.unlinks ? ' and unlinked from the unit' : ''}`,
                note: t.former ? `${t.name}: Former${t.unlinks ? ', unlinked from the unit' : ''}.`
                    : `${t.name}: kept Active (still a tenant at ${t.elsewhere.join(', ')})${t.unlinks ? ', unlinked from this unit' : ''}.`,
                run: async () => {
                    await moPatch(TABLES.tenants, t.id, fields);
                    await moReadBack(TABLES.tenants, t.id, fields);
                },
            });
        }
        steps.push({ label: `Tenancy ${plan.ref} ended`, note: `End date ${iso}, payment status cleared (was ${plan.status || 'blank'}).`, run: async () => {
            await moPatch(TABLES.tenancies, plan.tenancyId, { [F.tenEndDate]: iso, [F.tenPayStatus]: null });
            await moReadBack(TABLES.tenancies, plan.tenancyId, { [F.tenEndDate]: iso, [F.tenPayStatus]: null });
        } });

        const notes = [];
        for (let i = 0; i < steps.length; i++) {
            try {
                await steps[i].run();
            } catch (e) {
                onStep(`${steps[i].label}: ${e.message}. Stopped here, nothing after this step was changed.`, false);
                const trace = [`${today}: Moved out (${moLong(iso)}) STOPPED at "${steps[i].label}": ${e.message}.`,
                               notes.length ? `Done before it: ${notes.join(' ')}` : 'Nothing was changed before it.',
                               // The write itself may have landed with only its read-back failing: unconfirmed, not undone.
                               `Not confirmed: ${steps[i].label}.`,
                               ...(i + 1 < steps.length ? [`Not done: ${steps.slice(i + 1).map(s => s.label).join('; ')}.`] : []),
                               'Press Moved out again while the row is listed, or finish these by hand.'];
                if (!await moComment(TABLES.tenancies, plan.tenancyId, trace.join('\n'))) {
                    onStep('The note on the tenancy saying where it stopped did not save either.', false);
                }
                throw e;
            }
            notes.push(steps[i].note);
            onStep(steps[i].label, true);
        }
        const skipped = [
            ...plan.tenants.filter(t => !(t.former && !t.wasFormer) && !t.unlinks).map(t => `${t.name}: no change needed.`),
            ...plan.units.filter(u => !u.voidIt).map(u => u.liveOthers.length
                ? `${u.name}: not voided, ${u.liveOthers.join(', ')} is still live on it.` : `${u.name}: already ${u.status}, left as it is.`),
            ...(plan.units.length ? [] : ['No unit linked, so no unit changed.']),
            ...(plan.tasks.length ? [] : ['No open tasks.']),
        ];
        const summary = [`${today}: moved out on ${moLong(iso)}, ended from the Cash Flow Voids page.`, ...notes, ...skipped];
        if (!await moComment(TABLES.tenancies, plan.tenancyId, summary.join('\n'))) {
            onStep('The summary comment on the tenancy did not save. Every change above went through.', false);
        }
    }

    async function cfvMovedOut(tenancyId, surname) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:10001;display:flex;align-items:center;justify-content:center';
        const panel = document.createElement('div');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', 'Moved out');
        panel.id = 'cfvMovedOutBox';
        panel.style.cssText = 'background:var(--bg-surface);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);padding:24px;max-width:520px;width:92%;max-height:85vh;overflow-y:auto';
        const todayIso = moIso(moToday());
        panel.innerHTML = `
            <div style="font-size:var(--fs-lg);font-weight:var(--fw-semibold);color:var(--text-primary);margin-bottom:12px">Moved out: ${escHtml(surname)}</div>
            <label style="display:block;font-size:var(--fs-sm);color:var(--text-secondary);margin-bottom:12px">Move-out date
                <input type="date" id="cfvMoDate" value="${todayIso}" max="${todayIso}" style="display:block;margin-top:4px;padding:6px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm)">
            </label>
            <div id="cfvMoBody" style="font-size:var(--fs-sm);color:var(--text-secondary)">Reading the tenancy, tenant, unit and tasks from Airtable…</div>
            <div id="cfvMoProgress" style="font-size:var(--fs-sm);margin-top:12px"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px">
                <button id="cfvMoCancel" class="cfv-action-btn">Cancel</button>
                <button id="cfvMoGo" class="cfv-action-btn" disabled style="background:var(--danger);color:var(--accent-on);border-color:var(--danger)">End tenancy</button>
            </div>`;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        const body = panel.querySelector('#cfvMoBody');
        const dateInput = panel.querySelector('#cfvMoDate');
        const progress = panel.querySelector('#cfvMoProgress');
        const go = panel.querySelector('#cfvMoGo');
        const cancel = panel.querySelector('#cfvMoCancel');
        let running = false, finished = false;
        const close = () => {
            if (running) return;
            overlay.remove();
            if (finished) {
                setTimeout(() => renderCFVTab(), 300);
                // Same reason as the other actions: the IDB cache would put the old record back.
                setTimeout(async () => { if (typeof clearDashCache === 'function') await clearDashCache(); loadDashboard(); }, 1500);
            }
        };
        cancel.onclick = close;
        overlay.onclick = (e) => { if (e.target === overlay) close(); };

        let plan;
        try {
            plan = await moBuildPlan(tenancyId);
        } catch (e) {
            body.innerHTML = `<div style="color:var(--danger)">Could not read the records: ${escHtml(e.message)}. Nothing was changed.</div>`;
            return;
        }
        const list = (items, colour) => items.length
            ? `<ul style="margin:6px 0 0 18px;padding:0;color:${colour}">${items.map(i => `<li style="margin-bottom:4px">${escHtml(i)}</li>`).join('')}</ul>` : '';
        const render = () => {
            const dated = moDateCheck(plan, dateInput.value);
            const refusals = [...plan.refusals, ...dated.refusals];
            const warnings = [...plan.warnings, ...dated.warnings];
            body.innerHTML = (refusals.length
                ? `<div style="font-weight:var(--fw-semibold);color:var(--danger)">Cannot end this tenancy</div>${list(refusals, 'var(--danger)')}`
                : `<div style="font-weight:var(--fw-semibold);color:var(--text-primary)">What will change</div>${list(moChangeLines(plan, dateInput.value), 'var(--text-primary)')}
                   <div style="margin-top:8px">A dated comment on the tenancy will list all of this.</div>`)
                + (warnings.length ? `<div style="margin-top:12px;padding:8px 10px;background:var(--warning-bg);border-radius:var(--radius-md)">
                       <div style="font-weight:var(--fw-semibold);color:var(--warning)">Check before you confirm</div>${list(warnings, 'var(--text-primary)')}</div>` : '');
            go.disabled = refusals.length > 0;
        };
        dateInput.onchange = render;
        render();

        go.onclick = async () => {
            const iso = dateInput.value;
            if (moDateCheck(plan, iso).refusals.length || plan.refusals.length) return;
            running = true;
            go.disabled = true; cancel.disabled = true; dateInput.disabled = true;
            const report = (text, ok) => {
                progress.insertAdjacentHTML('beforeend', `<div style="color:${ok ? 'var(--success)' : 'var(--danger)'};margin-bottom:4px">${ok ? '✓' : '✗'} ${escHtml(text)}</div>`);
            };
            let writing = false;
            try {
                // Read everything again: if anything changed while the box was open, write nothing.
                const fresh = await moBuildPlan(tenancyId);
                if (moSignature(fresh) !== moSignature(plan)) {
                    report('Something changed in Airtable since this box opened, so nothing was written. Close it and press Moved out again.', false);
                } else {
                    writing = true;
                    await moRun(plan, iso, report);
                    finished = true;
                    const rec = allTenancies.find(t => t.id === tenancyId);
                    if (rec) { rec.fields[F.tenEndDate] = iso; delete rec.fields[F.tenPayStatus]; }
                    report('Done. Close this box and the row leaves the list.', true);
                    showToast(`${surname}: tenancy ended, moved out ${moLong(iso)}`, { type: 'success' });
                }
            } catch (e) {
                if (writing) finished = true;   // moRun named the failed step; earlier steps may have landed, so re-read on close
                else report(`Could not read the records again (${e.message}), so nothing was written.`, false);
                console.warn('Moved out stopped:', e);
            } finally {
                running = false;
                go.style.display = 'none';
                cancel.disabled = false;
                cancel.textContent = 'Close';
            }
        };
    }

    // ── Comments ──

    // A comment is not decoration here: a dismissal is RESTORED from the tagged
    // [CFV-DISMISSED:date] comment when localStorage is empty, so a comment that
    // never lands means the dismissal is lost on the next device or cache clear.
    // This used to swallow both halves — the fetch never checked res.ok, so a 403
    // from a PAT missing data.recordComments:write returned "successfully" and only
    // a console.warn covered a thrown error. Both now reach the operator.
    async function addTenancyComment(recordId, text) {
        if (!PAT) return false;
        try {
            const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tenancies}/${recordId}/comments`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text })
            });
            if (!res.ok) {
                const hint = res.status === 403
                    ? ' — your Airtable token is missing the data.recordComments:write scope'
                    : '';
                if (typeof showToast === 'function') {
                    showToast(`Audit comment not saved (${res.status})${hint}. The action itself went through.`,
                        { type: 'warning', duration: 7000 });
                }
                console.warn('Failed to add comment:', res.status, hint);
                return false;
            }
            return true;
        } catch (e) {
            if (typeof showToast === 'function') {
                showToast('Audit comment not saved (network error). The action itself went through.',
                    { type: 'warning', duration: 7000 });
            }
            console.warn('Failed to add comment:', e);
            return false;
        }
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
        if (comments.length === 0) return `<div class="od-text-muted-sm" style="padding:8px 0">${emptyMsg}</div>`;
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
        container.innerHTML = '<div class="od-empty-state">Loading full comment history...</div>';

        // Fetch all comments from the tenancy record
        const tenancyComments = await fetchAllComments(TABLES.tenancies, tenancyId);

        let commentsHtml = '';
        if (tenancyComments.length > 0) {
            commentsHtml = formatCommentsList(tenancyComments, '');
        } else {
            commentsHtml = '<div class="od-text-muted-sm" style="padding:12px 0">No comments yet. Your Airtable PAT may need the <strong>data.recordComments:read</strong> scope — update at <a href="https://airtable.com/create/tokens" target="_blank">airtable.com/create/tokens</a>.</div>';
        }

        container.innerHTML = `
            <div class="cfv-comment-box">
                <div class="cfv-comment-header">
                    <span class="cfv-comment-tenant">${escHtml(surname)} — ${escHtml(ref)}</span>
                    <button class="cfv-action-btn" onclick="document.getElementById('cfvCommentsSection').style.display='none'">Close</button>
                </div>
                <div style="font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:6px;padding-top:8px">Tenancy Comments (${tenancyComments.length})</div>
                <div class="cfv-comment-list" style="max-height:400px">${commentsHtml}</div>
                <div style="margin-top:12px;padding-top:8px;border-top:1px solid var(--border-default)">
                    <textarea class="cfv-comment-input" id="cfvNewComment" rows="2" placeholder="Add a comment..."></textarea>
                    <button class="cfv-action-btn primary cfv-comment-send" onclick="cfvAddComment('${tenancyId}','${escJs(surname)}','${escJs(ref)}')">Add Comment</button>
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

    // ── Navigate to tenant record in Operations tab ──
    // Switches to the Operations iframe, waits for it to load, then sends
    // a postMessage to crossNav to the tenant row.
    function cfvNavToTenant(tenantId) {
        if (!tenantId) return;
        switchTab('operations');
        const frame = document.getElementById('operationsFrame');
        if (!frame) return;

        // Ensure the iframe src is loaded
        const src = frame.getAttribute('data-src') || frame.getAttribute('src');
        if (!frame.getAttribute('src') || !frame.getAttribute('src').includes('operations')) {
            frame.setAttribute('src', src);
        }

        // Poll until iframe is ready, then send the crossNav message
        let attempts = 0;
        const poll = setInterval(() => {
            attempts++;
            try {
                frame.contentWindow.postMessage({
                    type: 'ops:crossNav',
                    entity: 'tenants',
                    recordId: tenantId,
                }, '*');
            } catch (e) { /* iframe not ready */ }
            if (attempts > 100) clearInterval(poll);  // give up after 10s
        }, 100);

        // Stop polling once we get an ack
        const onAck = (e) => {
            if (e.data?.type === 'ops:crossNavAck') {
                clearInterval(poll);
                window.removeEventListener('message', onAck);
            }
        };
        window.addEventListener('message', onAck);
    }
