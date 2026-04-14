// ══════════════════════════════════════════
// LEADERSHIP DASHBOARD — Load Data & Render KPIs
// ══════════════════════════════════════════

    // ── Stale-while-revalidate cache for instant reloads ──
    const DASH_CACHE_KEY = '_dlr_dashcache_v1';
    const DASH_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — older than this, don't show stale

    function loadDashCache() {
        try {
            const raw = localStorage.getItem(DASH_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || !parsed.savedAt || !parsed.data) return null;
            const ageMs = Date.now() - parsed.savedAt;
            if (ageMs > DASH_CACHE_MAX_AGE_MS) return null;
            return { data: parsed.data, ageMs };
        } catch (e) {
            return null;
        }
    }

    function saveDashCache(data) {
        try {
            localStorage.setItem(DASH_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
        } catch (e) {
            // Quota exceeded or storage disabled — clear and ignore
            try { localStorage.removeItem(DASH_CACHE_KEY); } catch (_) {}
        }
    }

    function clearDashCache() {
        try { localStorage.removeItem(DASH_CACHE_KEY); } catch (_) {}
    }

    function setRefreshingIndicator(on, ageMs) {
        const el = document.getElementById('refreshingBadge');
        if (!el) return;
        if (on) {
            const ageLabel = ageMs != null ? formatAge(ageMs) : '';
            el.innerHTML = '<span class="refresh-dot" style="background:#2563eb"></span>Refreshing\u2026' +
                (ageLabel ? ' <span style="opacity:0.7">(showing data from ' + ageLabel + ')</span>' : '');
            el.style.display = 'inline-flex';
        } else {
            el.style.display = 'none';
        }
    }

    function formatAge(ms) {
        const mins = Math.round(ms / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + ' min ago';
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return hrs + 'h ago';
        return Math.round(hrs / 24) + 'd ago';
    }

    // ── Dashboard Load ──
    async function loadDashboard() {
        // Try instant render from cache first
        const cached = loadDashCache();
        let renderedFromCache = false;
        if (cached) {
            try {
                const d = cached.data;
                allTransactions = d.transactions;
                allTenancies   = d.tenancies;
                allTenants     = d.tenants;
                allCosts       = d.costs;
                allCategories  = d.categories;
                allSubCategories = d.subCategories;
                allBusinesses  = d.businesses;
                renderDashboard(d.accounts, d.costs, d.tenancies, d.transactions, d.rentalUnits, d.tenants);
                document.getElementById('dashboard').style.display = 'block';
                document.getElementById('loadingOverlay').style.display = 'none';
                setRefreshingIndicator(true, cached.ageMs);
                renderedFromCache = true;
            } catch (e) {
                console.warn('Cache render failed, falling back to full load:', e);
                clearDashCache();
                renderedFromCache = false;
            }
        }

        if (!renderedFromCache) {
            document.getElementById('loadingOverlay').style.display = 'flex';
            document.getElementById('loadingSpinner').style.display = '';
            document.getElementById('loadingText').textContent = 'Loading your dashboard...';
            document.getElementById('loadingActions').style.display = 'none';
        }

        try {
            // Fetch Airtable data and Gmail invoices in parallel
            const [accounts, costs, tenancies, transactions, rentalUnits, tenants, categories, subCategories, businesses] = await Promise.all([
                airtableFetch(TABLES.accounts),
                airtableFetch(TABLES.costs),
                airtableFetch(TABLES.tenancies),
                airtableFetch(TABLES.transactions),
                airtableFetch(TABLES.rentalUnits),
                airtableFetch(TABLES.tenants),
                airtableFetch(TABLES.categories),
                airtableFetch(TABLES.subCategories),
                airtableFetch(TABLES.businesses),
            ]);

            // Fire invoice fetch from Airtable + Gmail sync + Fintable sync check in parallel (non-blocking)
            fetchInvoicesFromAirtable();
            triggerGmailInvoiceSync();
            checkFintableSyncStatus();

            allTransactions = transactions;
            allTenancies = tenancies;
            allTenants = tenants;
            allCosts = costs;
            allCategories = categories;
            allSubCategories = subCategories;
            allBusinesses = businesses;

            // Clear stale "returned" flags — if Airtable now shows In Payment, the flag is no longer needed
            tenancies.forEach(t => {
                const status = getPaymentStatusName(getField(t, F.tenPayStatus)).toLowerCase().trim();
                if (status === 'in payment') {
                    localStorage.removeItem('cfv_' + t.id + '_returned');
                }
            });
            renderDashboard(accounts, costs, tenancies, transactions, rentalUnits, tenants);

            // Save fresh data to cache for next instant reload
            saveDashCache({ accounts, costs, tenancies, transactions, rentalUnits, tenants, categories, subCategories, businesses });

            document.getElementById('dashboard').style.display = 'block';
            document.getElementById('loadingOverlay').style.display = 'none';
            setRefreshingIndicator(false);

            // Update sidebar badges on load
            updateSitemapBadge();
            // CFV badges: quick count from tenancy data
            try {
                const todayForBadge = new Date(); todayForBadge.setHours(0,0,0,0);
                let badgeCfv = 0, badgeActioned = 0;
                tenancies.forEach(t => {
                    const status = getPaymentStatusName(getField(t, F.tenPayStatus)).toLowerCase().trim();
                    if (status === 'cfv') badgeCfv++;
                    else if (status === 'cfv actioned') badgeActioned++;
                    else if (status === 'in payment' && isTenantStatusActive(t)) {
                        const dueDay = getNumVal(t, F.tenDueDay, 1);
                        const dueDate = new Date(todayForBadge.getFullYear(), todayForBadge.getMonth(), dueDay);
                        const overdue = todayForBadge >= dueDate ? Math.floor((todayForBadge - dueDate) / 86400000) : 0;
                        if (overdue >= CFV_TOLERANCE_DAYS && !getField(t, F.tenPaidThisMonth) && !localStorage.getItem('cfv_dismissed_' + t.id)) badgeCfv++;
                    }
                });
                updateCFVSidebarBadges(badgeCfv, badgeActioned);
            } catch(e) { console.warn('Badge update failed:', e); }

            // Schedule smart refresh — defers if user is actively interacting
            if (refreshTimer) clearInterval(refreshTimer);
            refreshTimer = setInterval(() => smartRefresh(), REFRESH_INTERVAL);
        } catch (e) {
            if (e.message === 'Auth failed') { clearDashCache(); return; }
            console.error(e);
            // If we're already showing cached data, keep it visible and just flag the refresh failure
            if (renderedFromCache) {
                const el = document.getElementById('refreshingBadge');
                if (el) {
                    el.innerHTML = '<span class="refresh-dot" style="background:#dc2626"></span>' +
                        'Couldn\u2019t refresh \u2014 showing saved data';
                    el.style.display = 'inline-flex';
                }
                return;
            }
            document.getElementById('loadingSpinner').style.display = 'none';
            document.getElementById('loadingText').innerHTML =
                '<div style="font-size:20px;color:#dc2626;margin-bottom:8px">Couldn\u2019t load your dashboard</div>' +
                '<div style="font-size:14px;color:#475569;max-width:480px;text-align:center">' +
                (e.message || 'Unknown error') + '</div>';
            document.getElementById('loadingActions').style.display = 'block';
        }
    }

    function renderDashboard(accounts, costs, tenancies, transactions, rentalUnits, tenants) {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // Header
        document.getElementById('headerDate').textContent =
            now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) +
            ' | Combined Accounts: Santander + TNT Mgt Zempler';
        document.getElementById('lastUpdated').textContent =
            now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

        // ── SECTION 1: Financial Overview ──
        const santanderRec = accounts.find(r => r.id === REC.santander);
        const zemplerRec = accounts.find(r => r.id === REC.tntZempler);
        const santBal = Number(getField(santanderRec, F.accGBP)) || 0;
        const zempBal = Number(getField(zemplerRec, F.accGBP)) || 0;
        const openingBalance = santBal + zempBal;

        // Unreconciled transactions
        const unreconciledTx = transactions.filter(r => {
            const reconciled = getField(r, F.txReconciled);
            const alias = getField(r, F.txAccountAlias);
            return !reconciled && isOurAccount(alias);
        });

        // Monthly Income — split into In Payment only (low) and In Payment + CFV Actioned (high)
        const inPaymentTenanciesS1 = tenancies.filter(r => getPaymentStatusName(getField(r, F.tenPayStatus)).trim().toLowerCase() === 'in payment' && isTenantStatusActive(r));
        const cfvActionedTenanciesS1 = tenancies.filter(r => getPaymentStatusName(getField(r, F.tenPayStatus)).trim().toLowerCase() === 'cfv actioned' && isTenantStatusActive(r));
        const incTenancies = [...inPaymentTenanciesS1, ...cfvActionedTenanciesS1];
        const inPaymentIncome = inPaymentTenanciesS1.reduce((s, r) => s + (Number(getField(r, F.tenRent)) || 0), 0);
        const cfvActionedIncome = cfvActionedTenanciesS1.reduce((s, r) => s + (Number(getField(r, F.tenRent)) || 0), 0);
        const monthlyIncome = inPaymentIncome + cfvActionedIncome; // full = In Payment + CFV Actioned
        const inPaymentCount = inPaymentTenanciesS1.length;
        const cfvActionedCount = cfvActionedTenanciesS1.length;

        // Monthly Costs — include ALL active/in-payment costs regardless of which account they're paid from
        const activeCosts = costs.filter(r => isCostActive(r));
        const monthlyCosts = activeCosts.reduce((s, r) => s + (Number(getField(r, F.costExpected)) || 0), 0);

        // Profit & margin ranges: low = In Payment only minus costs, high = full income minus costs
        const grossProfitLow = inPaymentIncome - monthlyCosts;
        const grossProfitHigh = monthlyIncome - monthlyCosts;
        const grossMarginLow = inPaymentIncome > 0 ? (grossProfitLow / inPaymentIncome * 100).toFixed(2) : '0.00';
        const grossMarginHigh = monthlyIncome > 0 ? (grossProfitHigh / monthlyIncome * 100).toFixed(2) : '0.00';
        // Keep single values for backward compat in other sections
        const grossProfit = grossProfitHigh;
        const grossMargin = grossMarginHigh;

        // Sort income tenancies by due day asc, costs by due day asc
        const incSorted = [...incTenancies].sort((a, b) => (getNumVal(a, F.tenDueDay, 99)) - (getNumVal(b, F.tenDueDay, 99)));
        const costSorted = [...activeCosts].sort((a, b) => (getNumVal(a, F.costDueDay, 99)) - (getNumVal(b, F.costDueDay, 99)));

        // Unreconciled transactions bar (above Financial Overview, alongside Balance Calculator)
        const accStats = getReconAccuracyStats();
        const accCard = accStats ? `
            <div class="kpi-card">
                <div class="kpi-card-label">AI Reconciliation Accuracy</div>
                <div class="kpi-card-value" style="color:${accStats.colour}">${accStats.pct}%</div>
                <div class="kpi-card-sub">${accStats.accurate}/${accStats.total} correct — last ${accStats.total >= 100 ? '100' : '31 days'}</div>
                <div style="margin-top:8px;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden">
                    <div style="height:100%;width:${accStats.pct}%;background:${accStats.colour};border-radius:3px;transition:width 0.3s"></div>
                </div>
                <div style="margin-top:6px;font-size:10px;color:#94a3b8">Target: ≥90% <span style="color:#16a34a">●</span> 75–89% <span style="color:#d97706">●</span> &lt;75% <span style="color:#ef4444">●</span></div>
            </div>` : '';
        document.getElementById('reconBar').innerHTML = `
            ${expandableCard('Unreconciled Transactions', unreconciledTx.length, `Santander + TNT Mgt Zempler`,
                (unreconciledTx.length === 0
                    ? '<div class="detail-item"><span><em>No unreconciled transactions</em></span></div>'
                    : unreconciledTx.map(r => `<div class="detail-item"><span class="detail-item-name">${escHtml(getField(r, F.txDate) || '')} — ${escHtml(txLabel(r))}</span><span class="detail-item-value">${fmt(Number(getField(r, F.txReportAmount)) || 0)}</span></div>`).join(''))
                + `<div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <button onclick="event.stopPropagation(); triggerReconciliation(this)" style="padding:8px 16px;font-size:12px;font-weight:600;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer">Run Reconciliation</button>
                    <span style="font-size:11px;color:#94a3b8" id="reconStatus"></span>
                </div>`
            )}
            ${accCard}
        `;

        document.getElementById('financialCards').innerHTML = `
            <div class="kpi-card">
                <div class="kpi-card-label">Opening Balance</div>
                <div class="kpi-card-value">${fmt(openingBalance)}</div>
                <div class="kpi-card-sub">Santander ${fmt(santBal)} | TNT Zempler ${fmt(zempBal)}</div>
            </div>
            ${expandableCard('Monthly Income', `<span style="color:#d97706">£${Math.floor(inPaymentIncome).toLocaleString('en-GB')}</span> <span style="color:#94a3b8;font-size:20px;margin:0 4px">–</span> <span style="color:#16a34a">£${Math.floor(monthlyIncome).toLocaleString('en-GB')}</span>`,
                `${inPaymentCount} In Payment (confirmed) + ${cfvActionedCount} CFV Actioned (expected)`,
                `<div style="margin-bottom:8px;font-weight:600;color:#1e293b">In Payment (${inPaymentCount})</div>` +
                [...inPaymentTenanciesS1].sort((a,b) => (Number(getField(a, F.tenDueDay))||99) - (Number(getField(b, F.tenDueDay))||99)).map(r => {
                    const dueDay = getNumVal(r, F.tenDueDay, null);
                    const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                    return `<div class="detail-item"><span class="detail-item-name"><span style="color:#64748b;min-width:52px;display:inline-block">${escHtml(dueDayStr)}</span>${escHtml(String(getField(r, F.tenSurname) || ''))} – ${escHtml(String(getField(r, F.tenRef) || ''))}</span><span class="detail-item-value">${fmt(Number(getField(r, F.tenRent)) || 0)}</span></div>`;
                }).join('') +
                `<div class="detail-total"><span>In Payment Subtotal</span><span>${fmt(inPaymentIncome)}</span></div>` +
                (cfvActionedCount > 0 ? `<div style="margin:12px 0 8px;font-weight:600;color:#d97706">CFV Actioned (${cfvActionedCount})</div>` +
                [...cfvActionedTenanciesS1].sort((a,b) => (Number(getField(a, F.tenDueDay))||99) - (Number(getField(b, F.tenDueDay))||99)).map(r => {
                    const dueDay = getNumVal(r, F.tenDueDay, null);
                    const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                    return `<div class="detail-item"><span class="detail-item-name"><span style="color:#64748b;min-width:52px;display:inline-block">${escHtml(dueDayStr)}</span>${escHtml(String(getField(r, F.tenSurname) || ''))} – ${escHtml(String(getField(r, F.tenRef) || ''))}</span><span class="detail-item-value">${fmt(Number(getField(r, F.tenRent)) || 0)}</span></div>`;
                }).join('') +
                `<div class="detail-total"><span>Full Total (incl. CFV Actioned)</span><span>${fmt(monthlyIncome)}</span></div>` : ''),
                ''
            )}
            ${expandableCard('Monthly Costs', fmt(monthlyCosts), `${activeCosts.length} active costs`,
                costSorted.map(r => {
                    const dueDay = getNumVal(r, F.costDueDay, null);
                    const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                    return `<div class="detail-item"><span class="detail-item-name"><span style="color:#64748b;min-width:52px;display:inline-block">${escHtml(dueDayStr)}</span>${escHtml(String(getField(r, F.costName) || ''))}</span><span class="detail-item-value">${fmt(Number(getField(r, F.costExpected)) || 0)}</span></div>`;
                }).join('') +
                `<div class="detail-total"><span>Total</span><span>${fmt(monthlyCosts)}</span></div>`,
                'text-red'
            )}
            <div class="kpi-card">
                <div class="kpi-card-label">Monthly Gross Profit</div>
                <div class="kpi-card-value"><span style="color:#d97706">£${Math.floor(grossProfitLow).toLocaleString('en-GB')}</span><span style="color:#94a3b8;font-size:20px;margin:0 4px">–</span><span style="color:#16a34a">£${Math.floor(grossProfitHigh).toLocaleString('en-GB')}</span></div>
                <div class="kpi-card-sub">In Payment only → incl. CFV Actioned</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-card-label">Gross Margin</div>
                <div class="kpi-card-value"><span style="color:#d97706">${grossMarginLow}%</span><span style="color:#94a3b8;font-size:20px;margin:0 4px">–</span><span style="color:#16a34a">${grossMarginHigh}%</span></div>
                <div class="kpi-card-sub">In Payment only → incl. CFV Actioned</div>
            </div>
        `;

        // ── SECTION 2: Portfolio Overview ──
        const totalUnits = rentalUnits.length;
        const voidUnits = rentalUnits.filter(r => {
            const status = getField(r, F.unitStatus);
            return status && (typeof status === 'string' ? status : (status.name || '')).toLowerCase().includes('void');
        });
        const occupiedCount = totalUnits - voidUnits.length;
        const occupancyRate = totalUnits > 0 ? (occupiedCount / totalUnits * 100).toFixed(2) : '0.00';

        // Group by property
        const unitsByProperty = {};
        rentalUnits.forEach(r => {
            const propVals = lookupValues(getField(r, F.unitPropName));
            const propName = propVals.length > 0 ? propVals.join(', ') : 'Unknown';
            if (!unitsByProperty[propName]) unitsByProperty[propName] = { total: 0, occupied: 0, voids: [] };
            unitsByProperty[propName].total++;
            const status = getField(r, F.unitStatus);
            const isVoid = typeof status === 'string' && status.toLowerCase() === 'void';
            if (isVoid) {
                unitsByProperty[propName].voids.push(r);
            } else {
                unitsByProperty[propName].occupied++;
            }
        });

        document.getElementById('portfolioCards').innerHTML = `
            ${expandableCard('Total Rental Units', totalUnits, '',
                Object.entries(unitsByProperty).sort((a,b) => b[1].total - a[1].total)
                    .map(([p, d]) => `<div class="detail-item"><span class="detail-item-name">${escHtml(p)}</span><span class="detail-item-value">${d.total} units</span></div>`).join('')
            )}
            ${expandableCard('Occupied Units', occupiedCount, '',
                Object.entries(unitsByProperty).filter(([,d]) => d.occupied > 0).sort((a,b) => b[1].occupied - a[1].occupied)
                    .map(([p, d]) => `<div class="detail-item"><span class="detail-item-name">${escHtml(p)}</span><span class="detail-item-value">${d.occupied} units</span></div>`).join(''),
                'text-green'
            )}
            ${expandableCard('Void Units', voidUnits.length, '',
                voidUnits.map(r => {
                    // Primary field (formula) = display name e.g. "Unit 3 – 42 Elmdon Place"
                    let unitDisplay = getField(r, F.unitName);
                    if (Array.isArray(unitDisplay)) unitDisplay = unitDisplay.join(', ');
                    // Unit Number field
                    const unitNum = getField(r, F.unitNumber);
                    // Property Name (Short) — multipleLookupValues
                    const propVals = lookupValues(getField(r, F.unitPropName));
                    const propStr = propVals.join(', ');
                    // Build label: prefer primary field, fallback to "Unit X — Property"
                    let label;
                    if (unitDisplay && String(unitDisplay).trim()) {
                        label = String(unitDisplay).trim();
                    } else if (unitNum && propStr) {
                        label = `Unit ${unitNum} — ${propStr}`;
                    } else if (propStr) {
                        label = propStr;
                    } else if (unitNum) {
                        label = `Unit ${unitNum}`;
                    } else {
                        label = 'Unnamed Unit';
                    }
                    return `<div class="detail-item"><span class="detail-item-name">${escHtml(label)}</span></div>`;
                }).join(''),
                voidUnits.length > 0 ? 'text-amber' : 'text-green'
            )}
            <div class="kpi-card">
                <div class="kpi-card-label">Occupancy Rate</div>
                <div class="kpi-card-value ${Number(occupancyRate) >= 90 ? 'text-green' : Number(occupancyRate) >= 80 ? 'text-amber' : 'text-red'}">${occupancyRate}%</div>
                <div class="progress-bar"><div class="progress-bar-fill ${Number(occupancyRate) >= 90 ? 'green' : Number(occupancyRate) >= 80 ? 'amber' : 'red'}" style="width:${occupancyRate}%"></div></div>
            </div>
        `;

        // ── SECTION 3: Tenancy Metrics ── (all filters require active tenant status)
        const activeTenancies = tenancies.filter(r => isTenancyActive(getField(r, F.tenPayStatus)) && isTenantStatusActive(r));
        const inPaymentTenancies = tenancies.filter(r => getPaymentStatusName(getField(r, F.tenPayStatus)) === 'In Payment' && isTenantStatusActive(r));
        const cfvTenancies = tenancies.filter(r => getPaymentStatusName(getField(r, F.tenPayStatus)) === 'CFV' && isTenantStatusActive(r));
        const cfvActionedTenancies = tenancies.filter(r => getPaymentStatusName(getField(r, F.tenPayStatus)) === 'CFV Actioned' && isTenantStatusActive(r));
        const paidRate = activeTenancies.length > 0 ? (inPaymentTenancies.length / activeTenancies.length * 100).toFixed(2) : '0.00';

        const tenancyDetailList = (list) => [...list]
            .sort((a, b) => (getNumVal(a, F.tenDueDay, 99)) - (getNumVal(b, F.tenDueDay, 99)))
            .map(r => {
                const dueDay = getNumVal(r, F.tenDueDay, null);
                const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                return `<div class="detail-item"><span class="detail-item-name"><span style="color:#64748b;min-width:52px;display:inline-block">${escHtml(dueDayStr)}</span>${escHtml(String(getField(r, F.tenSurname) || ''))} – ${escHtml(String(getField(r, F.tenRef) || ''))}</span><span class="detail-item-value">${fmt(Number(getField(r, F.tenRent)) || 0)}</span></div>`;
            })
            .join('');

        const allTenancyDetails = [...activeTenancies]
            .sort((a, b) => (getNumVal(a, F.tenDueDay, 99)) - (getNumVal(b, F.tenDueDay, 99)))
            .map(r => {
                const dueDay = getNumVal(r, F.tenDueDay, null);
                const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                return `<div class="detail-item"><span class="detail-item-name"><span style="color:#64748b;min-width:52px;display:inline-block">${escHtml(dueDayStr)}</span>${escHtml(String(getField(r, F.tenSurname) || ''))} – ${escHtml(String(getField(r, F.tenRef) || ''))} (${getPaymentStatusName(getField(r, F.tenPayStatus))})</span><span class="detail-item-value">${fmt(Number(getField(r, F.tenRent)) || 0)}</span></div>`;
            })
            .join('');

        // Detect potential CFVs for the alert badge on the Leadership Dashboard
        let potentialCfvCount = 0;
        const todayForCfv = new Date();
        todayForCfv.setHours(0,0,0,0);
        tenancies.forEach(t => {
            const status = getPaymentStatusName(getField(t, F.tenPayStatus)).toLowerCase().trim();
            if (status !== 'in payment') return;
            if (!isTenantStatusActive(t)) return;
            const rent = Number(getField(t, F.tenRent)) || 0;
            if (rent <= 0) return;
            const dueDay = getNumVal(t, F.tenDueDay, 1);
            const dueThisMonth = new Date(todayForCfv.getFullYear(), todayForCfv.getMonth(), dueDay);
            const daysOver = todayForCfv >= dueThisMonth ? Math.floor((todayForCfv - dueThisMonth) / 86400000) : 0;
            const paid = getField(t, F.tenPaidThisMonth);
            if (daysOver >= CFV_TOLERANCE_DAYS && !paid && !localStorage.getItem('cfv_dismissed_' + t.id)) {
                potentialCfvCount++;
            }
        });

        const potentialCfvAlert = potentialCfvCount > 0
            ? `<div onclick="switchTab('cfv')" style="margin-top:8px;padding:8px 12px;background:#fef3c7;border:1px solid #d97706;border-radius:6px;cursor:pointer;font-size:12px;color:#92400e;display:flex;align-items:center;gap:6px">
                <span style="font-size:16px">⚠️</span>
                <span><strong>${potentialCfvCount} potential CFV${potentialCfvCount !== 1 ? 's' : ''}</strong> detected — click to review</span>
                <span style="margin-left:auto;font-size:10px;color:#d97706">View CFVs →</span>
               </div>`
            : '';

        document.getElementById('tenancyCards').innerHTML = `
            ${expandableCard('Total Tenancies', activeTenancies.length, '', allTenancyDetails)}
            ${expandableCard('In Payment', inPaymentTenancies.length, '', tenancyDetailList(inPaymentTenancies), 'text-green')}
            ${expandableCard('CFV', cfvTenancies.length, '', tenancyDetailList(cfvTenancies), 'text-amber')}
            ${expandableCard('CFV Actioned', cfvActionedTenancies.length, '', tenancyDetailList(cfvActionedTenancies), 'text-amber')}
            <div class="kpi-card">
                <div class="kpi-card-label">Paid Tenancy Rate</div>
                <div class="kpi-card-value ${Number(paidRate) >= 80 ? 'text-green' : Number(paidRate) >= 60 ? 'text-amber' : 'text-red'}">${paidRate}%</div>
                <div class="progress-bar"><div class="progress-bar-fill ${Number(paidRate) >= 80 ? 'green' : Number(paidRate) >= 60 ? 'amber' : 'red'}" style="width:${paidRate}%"></div></div>
            </div>
        `;

        // Show alert banner below tenancy metrics if potential CFVs detected
        const existingAlert = document.getElementById('cfvAlertBanner');
        if (existingAlert) existingAlert.remove();
        if (potentialCfvAlert) {
            const alertDiv = document.createElement('div');
            alertDiv.id = 'cfvAlertBanner';
            alertDiv.innerHTML = potentialCfvAlert;
            document.getElementById('tenancyCards').parentElement.appendChild(alertDiv);
        }

        // ── SECTION 4: 31-Day Operational Metrics ──
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const recentTx = transactions.filter(r => {
            const d = getField(r, F.txDate);
            if (!d) return false;
            const txDate = new Date(d);
            return txDate >= thirtyDaysAgo && txDate <= today;
        });

        function txBySubCat(recIds) {
            return recentTx.filter(r => {
                const sc = getField(r, F.txSubCategory);
                if (!sc) return false;
                if (Array.isArray(sc)) return sc.some(id => recIds.includes(id));
                return recIds.includes(sc);
            });
        }

        const rentalIncTx = txBySubCat([REC.subRentalInc]);
        const rentalInc30 = rentalIncTx.reduce((s, r) => s + (Number(getField(r, F.txReportAmount)) || 0), 0);

        const maintTx = txBySubCat([REC.subMaint]);
        const maintSpend = Math.abs(maintTx.reduce((s, r) => s + (Number(getField(r, F.txReportAmount)) || 0), 0));
        const maintPct = rentalInc30 > 0 ? (maintSpend / rentalInc30 * 100).toFixed(1) : '0.0';

        const wagesTx = txBySubCat([REC.subOpexLabour, REC.subCOGSLabour]);
        const wagesSpend = Math.abs(wagesTx.reduce((s, r) => s + (Number(getField(r, F.txReportAmount)) || 0), 0));
        const wagesPct = rentalInc30 > 0 ? (wagesSpend / rentalInc30 * 100).toFixed(1) : '0.0';

        const cfvExposureTenancies = [...cfvTenancies, ...cfvActionedTenancies];
        const cfvExposure = cfvExposureTenancies.reduce((s, r) => s + (Number(getField(r, F.tenRent)) || 0), 0);
        const cfvExposurePct = monthlyIncome > 0 ? (cfvExposure / monthlyIncome * 100).toFixed(1) : '0.0';

        const txDetailList = (list, showTeamMember = false) => [...list]
            .sort((a, b) => new Date(getField(b, F.txDate)) - new Date(getField(a, F.txDate)))
            .map(r => {
                const label = showTeamMember
                    ? (() => {
                        const tm = txTeamMemberName(r);
                        const base = txLabel(r);
                        return tm ? `${tm} — ${base}` : base;
                      })()
                    : txLabel(r);
                return `<div class="detail-item"><span class="detail-item-name">${escHtml(getField(r, F.txDate) || '')} — ${escHtml(label)}</span><span class="detail-item-value">${fmt(Math.abs(Number(getField(r, F.txReportAmount)) || 0))}</span></div>`;
            })
            .join('');

        // Targets — fixed £ amounts for variable costs
        // Budget constants (also used by cash flow forecast which runs outside this function)
        // Defined at module level — see below

        // Variable cost reserve (sum of budgets)
        const variableCostReserve = MAINT_TARGET_GBP + WAGES_TARGET_GBP + CFV_TARGET_GBP; // £6,000
        // Required gross profit = clear profit target + variable cost budgets
        const requiredGrossProfit = CLEAR_PROFIT_TARGET + variableCostReserve; // £16,000

        // Traffic light uses £ targets now (actual vs budget)
        const maintNum = maintSpend;
        const wagesNum = wagesSpend;
        const cfvNum = cfvExposure;

        function targetProgressBarGBP(actual, target) {
            const tl = trafficLight(actual, target);
            const maxVal = target * 2;
            const w = Math.min(actual / maxVal * 100, 100);
            const targetPos = Math.min(target / maxVal * 100, 100);
            return `<div class="progress-bar">
                <div class="progress-bar-fill ${tl}" style="width:${w}%"></div>
                <div style="position:absolute;left:${targetPos}%;top:0;bottom:0;width:2px;background:#1e293b;border-radius:1px" title="Budget: ${fmt(target)}"></div>
            </div>`;
        }

        // Gross profit progress towards target
        const gpProgressPct = requiredGrossProfit > 0 ? Math.min(grossProfitHigh / requiredGrossProfit * 100, 150).toFixed(1) : '0.0';
        const gpOnTrack = grossProfitHigh >= requiredGrossProfit;

        document.getElementById('operationalCards').innerHTML = `
            ${expandableCard('Rental Income (31d)', fmt(rentalInc30), 'Actual from transactions',
                txDetailList(rentalIncTx) + `<div class="detail-total"><span>Total</span><span>${fmt(rentalInc30)}</span></div>`,
                'text-green'
            )}
            ${expandableCard('Maintenance Spend (31d)', fmt(maintSpend),
                `${maintPct}% of rent | Budget: ${fmt(MAINT_TARGET_GBP)} | ${maintSpend <= MAINT_TARGET_GBP ? '<span class="text-green">Under budget</span>' : maintSpend <= MAINT_TARGET_GBP * 1.1 ? '<span class="text-amber">On budget</span>' : '<span class="text-red">Over budget</span>'}`,
                txDetailList(maintTx) + `<div class="detail-total"><span>Total</span><span>${fmt(maintSpend)}</span></div>`,
                trafficLightClass(maintNum, MAINT_TARGET_GBP),
                targetProgressBarGBP(maintNum, MAINT_TARGET_GBP)
            )}
            ${expandableCard('Wages Spend (31d)', fmt(wagesSpend),
                `${wagesPct}% of rent | Budget: ${fmt(WAGES_TARGET_GBP)} | ${wagesSpend <= WAGES_TARGET_GBP ? '<span class="text-green">Under budget</span>' : wagesSpend <= WAGES_TARGET_GBP * 1.1 ? '<span class="text-amber">On budget</span>' : '<span class="text-red">Over budget</span>'}`,
                txDetailList(wagesTx, true) + `<div class="detail-total"><span>Total</span><span>${fmt(wagesSpend)}</span></div>`,
                trafficLightClass(wagesNum, WAGES_TARGET_GBP),
                targetProgressBarGBP(wagesNum, WAGES_TARGET_GBP)
            )}
            ${expandableCard('CFV Exposure', fmt(cfvExposure),
                `${cfvExposurePct}% of income | Budget: ${fmt(CFV_TARGET_GBP)} | ${cfvExposure <= CFV_TARGET_GBP ? '<span class="text-green">Under budget</span>' : cfvExposure <= CFV_TARGET_GBP * 1.1 ? '<span class="text-amber">On budget</span>' : '<span class="text-red">Over budget</span>'}`,
                [...cfvExposureTenancies].sort((a,b) => (Number(getField(a, F.tenDueDay))||99) - (Number(getField(b, F.tenDueDay))||99))
                    .map(r => {
                        const dueDay = getNumVal(r, F.tenDueDay, null);
                        const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                        return `<div class="detail-item"><span class="detail-item-name"><span style="color:#64748b;min-width:52px;display:inline-block">${escHtml(dueDayStr)}</span>${escHtml(String(getField(r, F.tenSurname) || ''))} – ${escHtml(String(getField(r, F.tenRef) || ''))}</span><span class="detail-item-value">${fmt(Number(getField(r, F.tenRent)) || 0)}</span></div>`;
                    })
                    .join('') + `<div class="detail-total"><span>Total</span><span>${fmt(cfvExposure)}</span></div>`,
                trafficLightClass(cfvNum, CFV_TARGET_GBP),
                targetProgressBarGBP(cfvNum, CFV_TARGET_GBP)
            )}
            <div class="kpi-card clickable" onclick="toggleCard(this)">
                <div class="kpi-card-label">Target Gross Profit <span class="chevron">▸</span></div>
                <div class="kpi-card-value"><span class="${gpOnTrack ? 'text-green' : 'text-amber'}">£${Math.floor(grossProfitHigh).toLocaleString('en-GB')}</span><span style="color:#94a3b8;font-size:20px;margin:0 4px">/</span><span style="color:#1e293b">£${Math.floor(requiredGrossProfit).toLocaleString('en-GB')}</span></div>
                <div class="kpi-card-sub">${gpProgressPct}% of target | ${gpOnTrack ? `<span class="text-green">On track — ${fmt(CLEAR_PROFIT_TARGET)} clear profit</span>` : `<span class="text-red">Shortfall: ${fmt(requiredGrossProfit - grossProfitHigh)}</span>`}</div>
                <div class="progress-bar" style="position:relative">
                    <div class="progress-bar-fill ${gpOnTrack ? 'green' : 'amber'}" style="width:${Math.min(Number(gpProgressPct), 100)}%"></div>
                </div>
                <div class="kpi-card-detail">
                    <div style="font-size:12px;color:#64748b">
                        <div style="display:flex;justify-content:space-between;padding:3px 0"><span>Maintenance budget</span><span>${fmt(MAINT_TARGET_GBP)}</span></div>
                        <div style="display:flex;justify-content:space-between;padding:3px 0"><span>Wages budget</span><span>${fmt(WAGES_TARGET_GBP)}</span></div>
                        <div style="display:flex;justify-content:space-between;padding:3px 0"><span>CFV allowance</span><span>${fmt(CFV_TARGET_GBP)}</span></div>
                        <div style="display:flex;justify-content:space-between;padding:3px 0;border-top:1px solid #e2e8f0;margin-top:4px;padding-top:4px"><span>Variable cost reserve</span><span style="font-weight:600">${fmt(variableCostReserve)}</span></div>
                        <div style="display:flex;justify-content:space-between;padding:3px 0"><span>Clear profit target</span><span style="font-weight:600">${fmt(CLEAR_PROFIT_TARGET)}</span></div>
                        <div style="display:flex;justify-content:space-between;padding:3px 0;border-top:1px solid #e2e8f0;margin-top:4px;padding-top:4px;font-weight:600;color:#1e293b"><span>Required gross profit</span><span>${fmt(requiredGrossProfit)}</span></div>
                    </div>
                </div>
            </div>
        `;

        // ── SECTION 5: 31-Day Cash Flow Forecast ──
        // Build UC tenant map: tenant record ID → true if Universal Credit
        const ucTenantIds = new Set();
        tenants.forEach(t => {
            const payType = getField(t, F.tenantPayType);
            const typeName = typeof payType === 'string' ? payType : (payType && payType.name ? payType.name : '');
            if (typeName.toLowerCase().includes('universal credit')) {
                ucTenantIds.add(t.id);
            }
        });
        // Build tenancy → isUC map via linked tenant
        // Linked field returns [{id: "recXXX", name: "..."}, ...] objects
        const tenancyIsUC = {};
        tenancies.forEach(r => {
            const linked = getField(r, F.tenLinkedTenant);
            if (Array.isArray(linked)) {
                tenancyIsUC[r.id] = linked.some(item => {
                    const tenantId = typeof item === 'string' ? item : (item && item.id ? item.id : null);
                    return tenantId && ucTenantIds.has(tenantId);
                });
            }
        });

        const cashFlowRows = buildCashFlow(today, openingBalance, incTenancies, activeCosts, tenancies, transactions, monthlyIncome, tenancyIsUC);

        // ── SECTION 6: AI Analysis ──
        // Credit card balances
        const lloydsCCRec = accounts.find(r => r.id === REC.lloydsCreditCard);
        const amexRec = accounts.find(r => r.id === REC.americanExpress);
        const santanderCCRec = accounts.find(r => r.id === REC.santanderCC);
        const lloydsCCBal = Number(getField(lloydsCCRec, F.accGBP)) || 0;
        const amexBal = Number(getField(amexRec, F.accGBP)) || 0;
        const santanderCCBal = Number(getField(santanderCCRec, F.accGBP)) || 0;
        // Lloyds: shows negative balance = owed amount
        // AmEx: shows positive balance = owed amount
        // Santander CC: shows available credit; owed = limit − available
        const lloydsCCOwed = Math.abs(lloydsCCBal);
        const amexOwed = Math.max(0, amexBal);
        const santanderCCOwed = Math.max(0, SANTANDER_CC_LIMIT - santanderCCBal);
        const totalCCDebt = lloydsCCOwed + amexOwed + santanderCCOwed;

        const voidCostPerMonth = monthlyIncome > 0 && occupiedCount > 0
            ? (monthlyIncome / occupiedCount).toFixed(0)
            : 0;

        const cfvUnactioned = cfvTenancies.reduce((s, r) => s + (Number(getField(r, F.tenRent)) || 0), 0);

        // ── CREDIT CARD STRATEGIC REPAYMENT PLAN ──
        // Payment deadlines: AmEx 28th, Santander CC 14th, Lloyds CC 23rd
        // Minimum payments estimated at ~2% of balance or £25 whichever is greater
        const ccRepaymentPlan = (() => {
            const cards = [
                { name: 'American Express', owed: amexOwed, dueDay: 28, recId: REC.americanExpress },
                { name: 'Santander Credit Card', owed: santanderCCOwed, dueDay: 14, recId: REC.santanderCC },
                { name: 'Lloyds Credit Card', owed: lloydsCCOwed, dueDay: 23, recId: REC.lloydsCreditCard },
            ].filter(c => c.owed > 0.01);

            // Estimate minimum payment for each card (2% of balance or £25, whichever is greater)
            cards.forEach(c => { c.minPayment = Math.max(25, c.owed * 0.02); });

            // Find minimum payment deadlines within the 31-day window
            const windowEnd = new Date(today);
            windowEnd.setDate(windowEnd.getDate() + 30);
            const deadlines = [];
            cards.forEach(c => {
                // Check this month and next month for the due day
                for (let m = 0; m <= 1; m++) {
                    const dueDate = new Date(today.getFullYear(), today.getMonth() + m, c.dueDay);
                    if (dueDate >= today && dueDate <= windowEnd) {
                        deadlines.push({ card: c.name, date: dueDate, minPayment: c.minPayment, dueDay: c.dueDay });
                    }
                }
            });
            deadlines.sort((a, b) => a.date - b.date);

            // Walk the 31-day window to find Fridays
            const fridays = [];
            let d = new Date(today);
            while (d <= windowEnd) {
                if (d.getDay() === 5) fridays.push(new Date(d));
                d.setDate(d.getDate() + 1);
            }

            const MIN_BUFFER = 750;

            // Use actual cash flow forecast rows for accurate balance estimates
            const cfRows = cashFlowRows || [];
            function getClosingBal(dayIdx) {
                if (dayIdx >= 0 && dayIdx < cfRows.length) return cfRows[dayIdx].closing;
                return cfRows.length > 0 ? cfRows[cfRows.length - 1].closing : openingBalance;
            }

            const plans = [];
            let remainingDebt = cards.map(c => ({ ...c }));
            let cumulativePaid = 0;
            const minPaidFor = {};

            fridays.forEach((fri, idx) => {
                const daysFromNow = Math.round((fri - today) / 86400000);
                // Use actual closing balance from cash flow forecast, minus already-committed CC payments
                const estBalance = getClosingBal(daysFromNow) - cumulativePaid;

                // Look ahead 7 days using actual forecast data to find lowest point
                let worstAhead = estBalance;
                for (let ahead = 1; ahead <= 7; ahead++) {
                    const futBal = getClosingBal(daysFromNow + ahead) - cumulativePaid;
                    if (futBal < worstAhead) worstAhead = futBal;
                }

                // The limiting factor is whichever is tighter:
                // - Today's balance minus buffer
                // - Lowest upcoming balance minus buffer (protects against a dip next week)
                const fromToday = Math.max(0, estBalance - MIN_BUFFER);
                const fromLookAhead = Math.max(0, worstAhead - MIN_BUFFER);
                const available = Math.min(fromToday, fromLookAhead);

                // Build a plain-English reason for the payment amount
                let reason;
                const balanceAfterPay = estBalance - available;
                if (available < 10) {
                    reason = `Balance of ${fmt(estBalance)} is too close to the ${fmt(MIN_BUFFER)} safety buffer to make a payment.`;
                } else if (fromLookAhead < fromToday) {
                    const lowestDay = (() => {
                        let minBal = estBalance, minD = 0;
                        for (let a = 1; a <= 7; a++) {
                            const b = getClosingBal(daysFromNow + a) - cumulativePaid;
                            if (b < minBal) { minBal = b; minD = a; }
                        }
                        const d2 = new Date(fri); d2.setDate(d2.getDate() + minD);
                        return d2.toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'});
                    })();
                    reason = `Payment limited because the balance dips to ${fmt(worstAhead)} on ${lowestDay} next week. Keeping ${fmt(MIN_BUFFER)} buffer means ${fmt(available)} is safe to spend.`;
                } else {
                    reason = `Balance of ${fmt(estBalance)} minus ${fmt(MIN_BUFFER)} buffer = ${fmt(available)} available for payment.`;
                }

                // Check which minimum payments are due before the NEXT Friday (or end of window)
                const nextFri = fridays[idx + 1] || windowEnd;
                const upcomingMins = deadlines.filter(dl =>
                    dl.date >= fri && dl.date < nextFri && !minPaidFor[dl.card + '-' + dl.date.getMonth()]
                );

                // Priority 1: Cover minimum payments due before next Friday
                let budget = available;
                const payments = [];
                upcomingMins.forEach(dl => {
                    if (budget <= 0) return;
                    const card = remainingDebt.find(c => c.name === dl.card);
                    if (!card || card.owed <= 0) return;
                    const minPay = Math.min(dl.minPayment, card.owed, budget);
                    payments.push({ name: dl.card, pay: minPay, isMinimum: true, dueDate: dl.date });
                    card.owed -= minPay;
                    budget -= minPay;
                    cumulativePaid += minPay;
                    minPaidFor[dl.card + '-' + dl.date.getMonth()] = true;
                });

                // Priority 2: Allocate remaining surplus to highest-balance card
                const sortedDebt = [...remainingDebt].sort((a, b) => b.owed - a.owed);
                for (const card of sortedDebt) {
                    if (card.owed <= 0 || budget <= 0) continue;
                    const pay = Math.min(card.owed, budget);
                    const existing = payments.find(p => p.name === card.name);
                    if (existing) {
                        existing.pay += pay;
                        existing.isMinimum = false;
                    } else {
                        payments.push({ name: card.name, pay, isMinimum: false });
                    }
                    card.owed -= pay;
                    budget -= pay;
                    cumulativePaid += pay;
                }

                const totalPay = payments.reduce((s, p) => s + p.pay, 0);
                plans.push({
                    date: fri, estBalance, available, totalPay,
                    noFunds: totalPay < 1,
                    payments, buffer: MIN_BUFFER,
                    upcomingDeadlines: upcomingMins,
                    reason, worstAhead, balanceAfterPay: estBalance - totalPay
                });
            });
            return { cards, plans, remaining: remainingDebt, minBuffer: MIN_BUFFER, deadlines };
        })();

        const ccTableRows = ccRepaymentPlan.plans.map(p => {
            const dayStr = p.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

            if (p.noFunds) {
                return `<div style="padding:12px 0;border-bottom:1px solid #e2e8f0;">
                    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
                        <strong style="color:#1e293b;font-size:14px">${dayStr}</strong>
                        <span style="color:#94a3b8;font-size:13px;font-weight:600">No payment this week</span>
                    </div>
                    <div style="font-size:12px;color:#64748b;line-height:1.5">${p.reason}</div>
                </div>`;
            }

            const paymentLines = p.payments.map(pay => {
                const dueBadge = pay.dueDate
                    ? `<span style="background:#fef2f2;color:#dc2626;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px">due ${pay.dueDate.toLocaleDateString('en-GB', {day:'numeric', month:'short'})}</span>`
                    : '';
                const minBadge = pay.isMinimum
                    ? `<span style="background:#fef3c7;color:#92400e;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px">min. payment</span>`
                    : '';
                return `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:13px;color:#475569;">
                    <span>${escHtml(pay.name)}${dueBadge}${minBadge}</span>
                    <strong>${fmt(pay.pay)}</strong>
                </div>`;
            }).join('');

            return `<div style="padding:12px 0;border-bottom:1px solid #e2e8f0;">
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
                    <strong style="color:#1e293b;font-size:14px">${dayStr}</strong>
                    <span style="color:#16a34a;font-weight:700;font-size:15px">Pay ${fmt(p.totalPay)}</span>
                </div>
                ${paymentLines}
                <div style="margin-top:8px;padding:8px 10px;background:#f8fafc;border-radius:6px;font-size:12px;color:#64748b;line-height:1.6">
                    <div style="display:flex;justify-content:space-between;margin-bottom:2px">
                        <span>Account balance on this date</span><strong style="color:#1e293b">${fmt(p.estBalance)}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;margin-bottom:2px">
                        <span>Credit card payment</span><strong style="color:#dc2626">-${fmt(p.totalPay)}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;padding-top:4px;border-top:1px solid #e2e8f0;margin-top:2px">
                        <span>Balance after payment</span><strong style="color:${p.balanceAfterPay >= p.buffer ? '#16a34a' : '#d97706'}">${fmt(p.balanceAfterPay)}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between">
                        <span>Safety buffer</span><span>${fmt(p.buffer)}</span>
                    </div>
                    <div style="margin-top:6px;padding-top:6px;border-top:1px solid #e2e8f0;color:#475569;font-size:11px">${p.reason}</div>
                </div>
            </div>`;
        }).join('');

        // ── AI COMMENTARY — titled sections ──
        const maintStatus = maintSpend < MAINT_TARGET_GBP ? 'green' : maintSpend <= MAINT_TARGET_GBP * 1.1 ? 'amber' : 'red';
        const wagesStatus = wagesSpend < WAGES_TARGET_GBP ? 'green' : wagesSpend <= WAGES_TARGET_GBP * 1.1 ? 'amber' : 'red';

        document.getElementById('aiCommentary').innerHTML = `
            <h3 style="color:#1e293b;font-size:15px;margin:0 0 8px">Financial Health</h3>
            <p>The portfolio generates ${fmt(inPaymentIncome)} confirmed monthly income (In Payment) with a further ${fmt(cfvActionedIncome)} from ${cfvActionedCount} CFV Actioned tenancies, giving a best-case total of ${fmt(monthlyIncome)}. Against ${fmt(monthlyCosts)} in fixed costs, the gross margin ranges from ${grossMarginLow}% to ${grossMarginHigh}%. ${Number(grossMarginHigh) >= 40 ? 'The upper range is healthy.' : 'Margins are tight — cost reduction or occupancy gains are needed.'}</p>

            <h3 style="color:#1e293b;font-size:15px;margin:16px 0 8px">Profit Targets</h3>
            <p>Target gross profit: ${fmt(requiredGrossProfit)}/month (${fmt(CLEAR_PROFIT_TARGET)} clear profit + ${fmt(variableCostReserve)} variable costs: ${fmt(MAINT_TARGET_GBP)} maintenance, ${fmt(WAGES_TARGET_GBP)} wages, ${fmt(CFV_TARGET_GBP)} CFV allowance). Current best-case gross profit is ${fmt(grossProfitHigh)} — ${gpOnTrack ? `a surplus of ${fmt(grossProfitHigh - requiredGrossProfit)} above target. You are on track.` : `a shortfall of ${fmt(requiredGrossProfit - grossProfitHigh)} (${gpProgressPct}% of target). Focus on filling voids and converting CFVs to close the gap.`}</p>

            <h3 style="color:#1e293b;font-size:15px;margin:16px 0 8px">Operational Performance (31-Day)</h3>
            <p>Actual rental income over 31 days: ${fmt(rentalInc30)}. Maintenance spend of ${fmt(maintSpend)} is ${maintStatus === 'green' ? 'under' : maintStatus === 'amber' ? 'on' : 'over'} the ${fmt(MAINT_TARGET_GBP)} budget${maintStatus === 'red' ? ' — investigate whether reactive costs can shift to planned maintenance' : ''}. Wages at ${fmt(wagesSpend)} are ${wagesStatus === 'green' ? 'under' : wagesStatus === 'amber' ? 'on' : 'over'} the ${fmt(WAGES_TARGET_GBP)} budget.</p>

            <h3 style="color:#1e293b;font-size:15px;margin:16px 0 8px">Occupancy &amp; Voids</h3>
            <p>Occupancy is ${occupancyRate}% with ${voidUnits.length} void${voidUnits.length !== 1 ? 's' : ''}. Each void costs roughly £${voidCostPerMonth}/month in lost income. ${voidUnits.length > 0 ? `Filling ${Math.min(3, voidUnits.length)} void${Math.min(3, voidUnits.length) !== 1 ? 's' : ''} would add ${fmt(Math.min(3, voidUnits.length) * Number(voidCostPerMonth))}/month — the highest-ROI lever available.` : 'Full occupancy — excellent.'}</p>

            <h3 style="color:#1e293b;font-size:15px;margin:16px 0 8px">CFV Risk</h3>
            <p>CFV exposure is ${fmt(cfvExposure)} against a ${fmt(CFV_TARGET_GBP)} monthly allowance (${cfvExposure <= CFV_TARGET_GBP ? 'within budget' : 'over budget by ' + fmt(cfvExposure - CFV_TARGET_GBP)}). ${cfvTenancies.length > 0 ? `${cfvTenancies.length} remain unactioned (${fmt(cfvUnactioned)}) — actioning these improves income certainty.` : 'All CFVs actioned — good.'}</p>

            <h3 style="color:#1e293b;font-size:15px;margin:16px 0 8px">Quick Wins</h3>
            <p>${voidUnits.length > 0 ? '(1) Fill voids — biggest revenue impact per action. ' : ''}${cfvTenancies.length > 0 ? `(${voidUnits.length > 0 ? '2' : '1'}) Action ${cfvTenancies.length} unactioned CFV${cfvTenancies.length !== 1 ? 's' : ''} to secure ${fmt(cfvUnactioned)}/month. ` : ''}${maintStatus !== 'green' ? `(${(voidUnits.length > 0 ? 1 : 0) + (cfvTenancies.length > 0 ? 1 : 0) + 1}) Reduce maintenance from ${fmt(maintSpend)} to below ${fmt(MAINT_TARGET_GBP)} budget. ` : ''}Monitor cash flow pinch points around mortgage payment clusters (typically days 1-6).</p>

            <hr style="border:none;border-top:1px solid #cbd5e1;margin:20px 0;">
            <h3 style="color:#1e293b;font-size:16px;margin:0 0 12px">Strategic Credit Card Repayment Plan</h3>
            <p style="margin:0 0 8px">Total credit card debt: <strong>${fmt(totalCCDebt)}</strong> across ${ccRepaymentPlan.cards.length} card${ccRepaymentPlan.cards.length !== 1 ? 's' : ''}.</p>
            <p style="margin:0 0 12px;font-size:13px;color:#475569">Strategy: weekly payments each Friday. Minimum payments are prioritised before each card's due date. Remaining surplus allocated highest-balance first. Buffer of <strong>${fmt(ccRepaymentPlan.minBuffer)}</strong> always retained. 7-day look-ahead ensures no cash flow shortfall.</p>
            <div style="margin-bottom:16px">
                ${ccRepaymentPlan.cards.map(c =>
                    `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:14px;">
                        <span style="color:#475569">${escHtml(c.name)} <span style="color:#94a3b8;font-size:12px">(due ${c.dueDay}${c.dueDay===1?'st':c.dueDay===2?'nd':c.dueDay===3?'rd':'th'} | min. ${fmt(c.minPayment)})</span></span>
                        <span style="font-weight:600;color:${c.owed > 5000 ? '#dc2626' : '#d97706'}">${fmt(c.owed)}</span>
                    </div>`
                ).join('')}
            </div>
            <div>${ccTableRows}</div>
            ${ccRepaymentPlan.remaining.some(c => c.owed > 0.01)
                ? `<p style="margin:12px 0 0;font-size:13px;color:#64748b">After 31 days, remaining: ${ccRepaymentPlan.remaining.filter(c=>c.owed>0.01).map(c=>`${c.name} ${fmt(c.owed)}`).join(', ')}.</p>`
                : `<p style="margin:12px 0 0;font-size:13px;color:#16a34a">All credit card debt could be cleared within this 31-day window based on current projections.</p>`
            }
        `;

        // Balance Calculator — populate with forecast inflows/outflows
        populateCalcFromForecast(cashFlowRows);
        const calcBalInput = document.getElementById('calcOpeningBal');
        if (calcBalInput && !calcBalInput.dataset.userEdited) {
            calcBalInput.value = openingBalance.toFixed(2);
        }

        // Footer
        const lastSync = getField(santanderRec, F.accLastUpdate) || getField(zemplerRec, F.accLastUpdate) || 'Unknown';
        document.getElementById('footerSync').textContent = `Last bank sync: ${lastSync}`;

        // Store computed state for AI context
        if (typeof updateDashboardState === 'function') {
            updateDashboardState({
                openingBalance, santBal, zempBal,
                monthlyIncome, inPaymentIncome, monthlyCosts,
                grossProfitHigh, grossProfitLow, grossMarginHigh, grossMarginLow,
                activeTenanciesCount: activeTenancies.length,
                inPaymentCount: inPaymentTenancies.length,
                cfvCount: cfvTenancies.length,
                cfvActionedCount: cfvActionedTenancies.length,
                cfvExposure, rentalInc30, maintSpend, wagesSpend,
                occupancyRate,
                unreconciledCount: unreconciledTx.length,
            });
        }
    }
