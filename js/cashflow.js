// ══════════════════════════════════════════
// CASH FLOW — Forecast, Projections, Balance Calculator, UC Checks, What-If
// ══════════════════════════════════════════

    // ── Cash Flow Forecast ──
    function buildCashFlow(today, openingBalance, incomeTenancies, activeCostsList, allTenancies, transactions, monthlyIncome, tenancyIsUC) {
        const days = [];
        const dayMap = {};
        const todayKey = dateKey(today);

        // ── Reconciliation ──
        // Window: reconciled transactions from today-3 to today matched against
        // projected items from today to today+3. Payments may arrive early or late.
        //
        // MATCHING STRATEGY (multi-factor, keyword-first):
        // 1. PRIMARY: keyword matching — extract keywords from tx vendor/description
        //    and compare against the projected item's label (tenant name, unit ref, cost name).
        //    If 2+ keywords match, it's a strong match regardless of amount difference.
        // 2. SECONDARY: amount matching within £0.05 tolerance (exact match for costs)
        // 3. COMBINED: 1 keyword match + amount within 30% = match (handles letting agent deductions)
        //
        // Each reconciled tx is consumed on match — can only cancel one projected item.

        // Look back 5 days for reconciled transactions — catches payments that
        // arrived a few days early without pulling in last month's payments
        const reconDateKeys = [];
        for (let i = 0; i <= 5; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() - i);
            reconDateKeys.push(dateKey(d));
        }
        // Clear projected items up to 5 days ahead — matches early payments
        // against their upcoming due date without reaching too far forward
        const reconForecastKeys = [];
        for (let i = 0; i <= 5; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() + i);
            reconForecastKeys.push(dateKey(d));
        }

        const recentReconciled = (transactions || []).filter(r =>
            getField(r, F.txReconciled) && reconDateKeys.includes(getField(r, F.txDate))
        );

        // Extract searchable text from a transaction
        function txSearchText(r) {
            const vendor = String(getField(r, F.txVendor) || '').toLowerCase();
            const desc = String(getField(r, F.txDescription) || '').toLowerCase();
            return `${vendor} ${desc}`;
        }

        // Extract keywords from a label (e.g. "Smith – Unit 6, Duckworth Building")
        // Returns words of 3+ chars, lowercased, excluding common stop words.
        // Dedupes: labels like "Collins – COLLINS – UNIT 1 – 82 DEVON STREET" (surname + ref where
        // ref starts with surname) would otherwise emit "collins" twice, which inflated
        // keywordMatchCount and mis-triggered the "2+ keyword = strong match" clearing rule —
        // e.g. a Collins-Eleventh-Street payment would clear a Collins-Devon-Street forecast
        // because "collins" appearing in the tx description counted for both label tokens.
        const STOP_WORDS = new Set(['the','and','for','unit','from','with','payment','rent','rental','income','cost','ltd','limited']);
        function extractKeywords(label) {
            const words = label.toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
            return [...new Set(words)];
        }

        // Count how many keywords from a label appear in the transaction text
        function keywordMatchCount(txText, labelKeywords) {
            return labelKeywords.filter(kw => txText.includes(kw)).length;
        }

        // Sub-categories to EXCLUDE from outflow matching (internal movements, not cost payments)
        const EXCLUDED_OUTFLOW_SUBCATS = new Set([
            'recY5XDZspRDNjZOO',  // Transfer
            REC.subRentalInc,      // Rental Income (shouldn't be in outflows anyway)
        ]);

        // Build reconciled pools with full transaction data for keyword matching
        const reconciledInflows = [];  // income transactions
        const reconciledOutflows = []; // expense transactions

        recentReconciled.forEach(r => {
            const sc = getField(r, F.txSubCategory);
            const scIds = Array.isArray(sc) ? sc.map(s => typeof s === 'object' ? s.id : s) : [];
            const isIncome = scIds.includes(REC.subRentalInc);
            const isExcludedOutflow = scIds.some(id => EXCLUDED_OUTFLOW_SUBCATS.has(id));
            const reportAmt = Math.abs(Number(getField(r, F.txReportAmount)) || 0);
            const rawAmt = Math.abs(Number(getField(r, F.txAmount)) || 0);
            if (reportAmt <= 0 && rawAmt <= 0) return;
            const searchText = txSearchText(r);

            // Pull the tx's explicit Tenancy link(s) so we can prefer definitive matches over
            // keyword heuristics. Field returns [{id,name},...] or [] — normalise to an array of IDs.
            const linkedTen = getField(r, F.txTenancy);
            const tenancyIds = Array.isArray(linkedTen)
                ? linkedTen.map(x => (x && typeof x === 'object') ? x.id : x).filter(Boolean)
                : (linkedTen ? [(typeof linkedTen === 'object') ? linkedTen.id : linkedTen] : []);

            if (isIncome) {
                // Handle split transactions (e.g. Serco bulk payment)
                const count = rawAmt > reportAmt + 0.01 ? Math.round(rawAmt / reportAmt) : 1;
                for (let i = 0; i < count; i++) {
                    reconciledInflows.push({ amount: reportAmt, searchText, tenancyIds, used: false });
                }
            } else if (!isExcludedOutflow) {
                // Only include in outflow pool if NOT a Transfer or other excluded category
                const amt = reportAmt > 0 ? reportAmt : rawAmt;
                const txSubCatIds = getField(r, F.txSubCategory);
                const subCatSet = new Set(Array.isArray(txSubCatIds) ? txSubCatIds : []);
                const linkedCost = getField(r, F.txCost);
                const costIds = Array.isArray(linkedCost)
                    ? linkedCost.map(x => (x && typeof x === 'object') ? x.id : x).filter(Boolean)
                    : (linkedCost ? [(typeof linkedCost === 'object') ? linkedCost.id : linkedCost] : []);
                reconciledOutflows.push({ amount: amt, searchText, subCats: subCatSet, costIds, used: false });
            }
            // Excluded outflows (Transfers etc.) are silently dropped — they're internal movements
        });

        // Multi-factor match: does any unused reconciled inflow match this projected item?
        //
        // Priority 1 — EXPLICIT link on the reconciled transaction. If the tx's Tenancy linked
        // field contains this tenancy, that's definitive: stop looking. Also, any tx whose link
        // points to a DIFFERENT tenancy is never allowed to clear this forecast (it belongs
        // elsewhere) — this stops Lettings-Unit-5's paid rent silently clearing Unit-6's forecast
        // when a letting agent uses one bank reference for a multi-unit building.
        //
        // Priority 2 — KEYWORD match between tenancy label and tx vendor/description. Every path
        // requires at least 1 keyword overlap: amount alone is NOT enough. Many tenancies share
        // the same rent figure (e.g. £897.52) and silently clearing a forecast by amount hid the
        // Mayes tenancy forecast in Apr 2026 when unrelated Pinder / Murcutt payments came in.
        function isInflowAlreadyCleared(amount, label, forecastTenancyId) {
            // Priority 1: explicit tenancy link
            if (forecastTenancyId) {
                for (let i = 0; i < reconciledInflows.length; i++) {
                    if (reconciledInflows[i].used) continue;
                    if ((reconciledInflows[i].tenancyIds || []).includes(forecastTenancyId)) {
                        reconciledInflows[i].used = true;
                        return true;
                    }
                }
            }

            // Priority 2: keyword + amount heuristic (for txs without a link, or where the link
            // points to this tenancy but P1 didn't find it for some reason).
            const keywords = extractKeywords(label);
            let bestIdx = -1;
            let bestScore = 0;

            for (let i = 0; i < reconciledInflows.length; i++) {
                if (reconciledInflows[i].used) continue;
                const tx = reconciledInflows[i];
                // Skip txs whose Tenancy link points to a DIFFERENT tenancy — they genuinely
                // belong elsewhere and must not be allowed to cross-clear.
                if (forecastTenancyId && (tx.tenancyIds || []).length > 0 && !tx.tenancyIds.includes(forecastTenancyId)) continue;
                const kwCount = keywordMatchCount(tx.searchText, keywords);
                const amtClose = Math.abs(tx.amount - amount) < 0.05;
                const amtWithin30 = amount > 0 && Math.abs(tx.amount - amount) / amount < 0.30;

                // Strong match: 2+ keyword matches (e.g. surname + building name)
                if (kwCount >= 2) {
                    bestIdx = i;
                    break;
                }
                // Solid match: 1 keyword + exact amount (within 5p)
                if (kwCount >= 1 && amtClose && 2.5 > bestScore) {
                    bestIdx = i;
                    bestScore = 2.5;
                }
                // Acceptable match: 1 keyword + amount within 30% (handles letting agent deductions)
                if (kwCount >= 1 && amtWithin30 && kwCount + 1 > bestScore) {
                    bestIdx = i;
                    bestScore = kwCount + 1;
                }
                // No amount-only fallback — a matching amount alone is not evidence the same tenant paid.
            }
            if (bestIdx >= 0) { reconciledInflows[bestIdx].used = true; return true; }
            return false;
        }

        // Outflows: keyword + amount + sub-category matching
        // Three checks must align: (1) keyword match, (2) amount proximity, (3) sub-category match.
        // If both the cost and transaction have sub-category data, they MUST overlap.
        // This prevents false matches (e.g. Tesla software subscription ≠ Tesla vehicle charge).
        function isOutflowAlreadyCleared(amount, label, costSubCatIds, forecastCostId) {
            // Priority 1: explicit cost link on the transaction
            if (forecastCostId) {
                for (let i = 0; i < reconciledOutflows.length; i++) {
                    if (reconciledOutflows[i].used) continue;
                    if ((reconciledOutflows[i].costIds || []).includes(forecastCostId)) {
                        reconciledOutflows[i].used = true;
                        return true;
                    }
                }
            }

            // Priority 2: keyword + amount + sub-category heuristic (only for txs without a cost link)
            const keywords = extractKeywords(label);
            const costSubCats = new Set(Array.isArray(costSubCatIds) ? costSubCatIds : []);
            let bestIdx = -1;

            for (let i = 0; i < reconciledOutflows.length; i++) {
                if (reconciledOutflows[i].used) continue;
                const tx = reconciledOutflows[i];
                // Skip txs that are explicitly linked to a different cost
                if ((tx.costIds || []).length > 0 && forecastCostId && !tx.costIds.includes(forecastCostId)) continue;
                const kwCount = keywordMatchCount(tx.searchText, keywords);
                const tolerance = Math.max(amount * 0.33, 1.00);
                const amtClose = Math.abs(tx.amount - amount) <= tolerance;

                let subCatOk = true;
                if (costSubCats.size > 0 && tx.subCats.size > 0) {
                    subCatOk = [...costSubCats].some(id => tx.subCats.has(id));
                }

                if (kwCount >= 1 && amtClose && subCatOk) {
                    bestIdx = i;
                    break;
                }
            }
            if (bestIdx >= 0) { reconciledOutflows[bestIdx].used = true; return true; }
            return false;
        }

        function isInReconWindow(dk) {
            return reconForecastKeys.includes(dk);
        }

        // Build tenancy → last account alias and cost → last account alias maps
        // from transaction history so each forecast item shows which bank account
        // the last real payment came through.
        const tenancyLastAccount = {};
        const costLastAccount = {};
        const sortedTxByDate = [...(transactions || [])].sort((a, b) => {
            const da = getField(a, F.txDate) || '';
            const db = getField(b, F.txDate) || '';
            return db.localeCompare(da);
        });
        sortedTxByDate.forEach(r => {
            const alias = getField(r, F.txAccountAlias);
            if (!alias) return;
            const aliasStr = Array.isArray(alias) ? String(alias[0] || '') : String(alias);
            if (!aliasStr) return;

            const ten = getField(r, F.txTenancy);
            if (ten) {
                const tenIds = Array.isArray(ten) ? ten.map(t => (t && typeof t === 'object') ? t.id : t).filter(Boolean) : [];
                tenIds.forEach(tid => { if (!tenancyLastAccount[tid]) tenancyLastAccount[tid] = aliasStr; });
            }

            const cost = getField(r, F.txCost);
            if (cost) {
                const costIds = Array.isArray(cost) ? cost.map(c => (c && typeof c === 'object') ? c.id : c).filter(Boolean) : [];
                costIds.forEach(cid => { if (!costLastAccount[cid]) costLastAccount[cid] = aliasStr; });
            }
        });

        // Build 31 days using LOCAL date parts to avoid DST duplicates
        for (let i = 0; i < 31; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() + i);
            const key = dateKey(d);
            if (!dayMap[key]) {
                dayMap[key] = { date: new Date(d), inflows: [], outflows: [] };
                days.push(key);
            }
        }

        // Project income from tenancies — only active-status tenancies (belt-and-suspenders guard)
        incomeTenancies.forEach(r => {
            // Guard: skip if tenancy/tenant status is not explicitly active
            if (!isTenancyIncome(getField(r, F.tenPayStatus)) || !isTenantStatusActive(r)) return;
            const rent = Number(getField(r, F.tenRent)) || 0;
            if (rent <= 0) return;
            const dueDay = getNumVal(r, F.tenDueDay, 1);
            const freq = getField(r, F.tenPayFreq) || 'Monthly';
            const surname = String(getField(r, F.tenSurname) || 'Unknown');
            const ref = String(getField(r, F.tenRef) || '');
            const label = `${surname} – ${ref}`;
            // Extract linked tenant and rental unit IDs for UC task creation
            const linkedTenant = getField(r, F.tenLinkedTenant);
            const tenantId = Array.isArray(linkedTenant) ? (typeof linkedTenant[0] === 'string' ? linkedTenant[0] : linkedTenant[0]?.id) : null;
            const linkedUnit = getField(r, F.tenUnit);
            const unitId = Array.isArray(linkedUnit) ? (typeof linkedUnit[0] === 'string' ? linkedUnit[0] : linkedUnit[0]?.id) : null;

            projectDates(today, dueDay, freq, getField(r, F.tenDueDay), null).forEach(dk => {
                if (dayMap[dk]) {
                    const cleared = isInReconWindow(dk) && isInflowAlreadyCleared(rent, label, r.id);
                    const isUC = tenancyIsUC[r.id] || false;
                    dayMap[dk].inflows.push({ name: label, amount: rent, isUC, tenancyId: r.id, tenantId, unitId, dueDate: dk, account: tenancyLastAccount[r.id] || '', cleared });
                }
            });
        });

        // CFV Actioned tenancies — also include
        const cfvActTenancies = allTenancies.filter(r => getPaymentStatusName(getField(r, F.tenPayStatus)) === 'CFV Actioned');
        cfvActTenancies.forEach(r => {
            // Already included in incomeTenancies if filter is correct
        });

        // Project costs
        activeCostsList.forEach(r => {
            const amount = Number(getField(r, F.costExpected)) || 0;
            if (amount <= 0) return;
            const dueDay = getNumVal(r, F.costDueDay, 1);
            const freq = getField(r, F.costFrequency) || 'Monthly';
            const name = String(getField(r, F.costName) || 'Unknown cost');
            const dueDateNext = getField(r, F.costDueDateNext);
            const costSubCatIds = getField(r, F.costSubCategory); // linked sub-category record IDs

            projectDates(today, dueDay, freq, null, dueDateNext).forEach(dk => {
                if (dayMap[dk]) {
                    const cleared = isInReconWindow(dk) && isOutflowAlreadyCleared(amount, name, costSubCatIds, r.id);
                    dayMap[dk].outflows.push({ name, amount, account: costLastAccount[r.id] || '', cleared });
                }
            });
        });

        // Calculate running balance + worst-case line (deducting variable cost reserves daily)
        let balance = openingBalance;
        const chartLabels = [];
        const chartData = [];
        const chartDataWorstCase = [];
        let totalIn = 0, totalOut = 0, clearedIn = 0, clearedOut = 0, clearedInCount = 0, clearedOutCount = 0;
        let lowestBal = openingBalance;
        let lowestDay = '';
        const rows = [];

        // Daily variable cost reserve: £3k maint + £1.5k wages + £1.5k CFV = £6,000 / 31
        const dailyVarCostReserve = (MAINT_TARGET_GBP + WAGES_TARGET_GBP + CFV_TARGET_GBP) / 31;

        days.forEach((key, idx) => {
            const day = dayMap[key];
            const dayIn = day.inflows.reduce((s, i) => s + (i.cleared ? 0 : i.amount), 0);
            const dayOut = day.outflows.reduce((s, i) => s + (i.cleared ? 0 : i.amount), 0);
            const net = dayIn - dayOut;
            const opening = balance;
            const closing = balance + net;
            balance = closing;
            totalIn += dayIn;
            totalOut += dayOut;
            day.inflows.forEach(f => { if (f.cleared) { clearedIn += f.amount; clearedInCount++; } });
            day.outflows.forEach(f => { if (f.cleared) { clearedOut += f.amount; clearedOutCount++; } });

            if (closing < lowestBal) {
                lowestBal = closing;
                lowestDay = dayName(day.date);
            }

            chartLabels.push(dayName(day.date));
            chartData.push(closing);
            // Worst case: deduct cumulative variable cost reserve
            chartDataWorstCase.push(closing - dailyVarCostReserve * (idx + 1));
            rows.push({ date: day.date, key, opening, dayIn, dayOut, net, closing, inflows: day.inflows, outflows: day.outflows });
        });

        const finalBalance = balance;
        const netChange = finalBalance - openingBalance;

        // After variable costs figures (orange line values)
        const totalVarCostReserve = dailyVarCostReserve * days.length;
        const finalBalanceAfterVar = finalBalance - totalVarCostReserve;
        const netChangeAfterVar = finalBalanceAfterVar - openingBalance;
        let lowestBalAfterVar = openingBalance;
        let lowestDayAfterVar = '';
        chartDataWorstCase.forEach((v, idx) => {
            if (v < lowestBalAfterVar) { lowestBalAfterVar = v; lowestDayAfterVar = chartLabels[idx]; }
        });

        // Cash flow KPI cards — based on After Variable Costs (orange line)
        const cfLabelStyle = 'min-height:36px;display:flex;align-items:flex-start';
        document.getElementById('cashflowKPIs').innerHTML = `
            <div class="kpi-card">
                <div class="kpi-card-label" style="${cfLabelStyle}">Opening Balance</div>
                <div class="kpi-card-value">${fmt(openingBalance)}</div>
                <div class="kpi-card-sub">Santander + TNT Zempler</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-card-label" style="${cfLabelStyle}">Total In</div>
                <div class="kpi-card-value text-green">${fmt(totalIn)}</div>
                <div class="kpi-card-sub">Projected inflows over 31 days</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-card-label" style="${cfLabelStyle}">Total Out (incl. Reserves)</div>
                <div class="kpi-card-value text-red">${fmt(totalOut + totalVarCostReserve)}</div>
                <div class="kpi-card-sub">Fixed ${fmt(totalOut)} + Variable ${fmt(totalVarCostReserve)}</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-card-label" style="${cfLabelStyle}">Net Change (after Reserves)</div>
                <div class="kpi-card-value ${netChangeAfterVar >= 0 ? 'text-green' : 'text-red'}">${netChangeAfterVar >= 0 ? '+' : '-'}${fmt(netChangeAfterVar)}</div>
                <div class="kpi-card-sub">Income minus all costs and reserves</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-card-label" style="${cfLabelStyle}">Final Balance (after Reserves)</div>
                <div class="kpi-card-value" style="color:var(--warning)">${fmt(finalBalanceAfterVar)}</div>
                <div class="kpi-card-sub">Day 31 on the orange line</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-card-label" style="${cfLabelStyle}">Lowest Balance (after Reserves)</div>
                <div class="kpi-card-value ${lowestBalAfterVar >= 0 ? '' : 'text-red'}" style="${lowestBalAfterVar >= 0 ? 'color:var(--warning)' : ''}">${fmtAccounting(lowestBalAfterVar)}</div>
                <div class="kpi-card-sub">${lowestDayAfterVar}</div>
            </div>
        `;

        // Table
        const tbody = document.getElementById('cashflowBody');
        tbody.innerHTML = rows.map((r, i) => {
            const wknd = isWeekend(r.date) ? ' weekend' : '';
            const closingClass = r.closing < 0 ? 'text-red' : r.closing < 500 ? 'text-amber' : 'text-green';

            // Account tag helper
            const acctTag = (acct) => acct
                ? `<span class="od-text-muted-sm" style="background:var(--bg-subtle);padding:1px 6px;border-radius:3px;margin-left:6px;white-space:nowrap;color:var(--text-secondary)">${escHtml(acct)}</span>`
                : '';

            const reconBadge = '<span style="background:var(--bg-subtle);color:var(--text-muted);padding:1px 6px;border-radius:3px;margin-left:6px;font-size:0.75rem">Reconciled</span>';
            const inflowsHtml = r.inflows.length > 0
                ? r.inflows.map((f, fi) => {
                    if (f.cleared) {
                        return `<div class="cashflow-detail-item in" style="opacity:0.5"><span class="cashflow-detail-item-name" style="flex:1;color:var(--text-muted)">${escHtml(f.name)}${reconBadge}${acctTag(f.account)}</span><span class="cashflow-detail-item-value" style="text-decoration:line-through;color:var(--text-muted)">+${fmt(f.amount)}</span></div>`;
                    }
                    const cbId = cfStableKey(r.key, 'in', f.name, f.amount);
                    const checked = !isCFExcluded(cbId) ? 'checked' : '';
                    return `<div class="cashflow-detail-item in"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1"><input type="checkbox" data-cf-key="${cbId}" data-row="${i}" data-fi="${fi}" data-dir="in" ${checked} onchange="toggleCFExclusion(this.dataset.cfKey)"><span class="cashflow-detail-item-name" style="flex:1">${escHtml(f.name)}${acctTag(f.account)}</span></label><span class="cashflow-detail-item-value">+${fmt(f.amount)}</span></div>`;
                }).join('')
                : '<div class="cashflow-detail-item"><em>None</em></div>';
            const outflowsHtml = r.outflows.length > 0
                ? r.outflows.map((f, fi) => {
                    if (f.cleared) {
                        return `<div class="cashflow-detail-item out" style="opacity:0.5"><span class="cashflow-detail-item-name" style="flex:1;color:var(--text-muted)">${escHtml(f.name)}${reconBadge}${acctTag(f.account)}</span><span class="cashflow-detail-item-value" style="text-decoration:line-through;color:var(--text-muted)">-${fmt(f.amount)}</span></div>`;
                    }
                    const cbId = cfStableKey(r.key, 'out', f.name, f.amount);
                    const checked = !isCFExcluded(cbId) ? 'checked' : '';
                    return `<div class="cashflow-detail-item out"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1"><input type="checkbox" data-cf-key="${cbId}" data-row="${i}" data-fi="${fi}" data-dir="out" ${checked} onchange="toggleCFExclusion(this.dataset.cfKey)"><span class="cashflow-detail-item-name" style="flex:1">${escHtml(f.name)}${acctTag(f.account)}</span></label><span class="cashflow-detail-item-value">-${fmt(f.amount)}</span></div>`;
                }).join('')
                : '<div class="cashflow-detail-item"><em>None</em></div>';

            // Collect unique account aliases for this day's summary column
            const dayAccounts = new Set();
            r.inflows.forEach(f => { if (f.account) dayAccounts.add(f.account); });
            r.outflows.forEach(f => { if (f.account) dayAccounts.add(f.account); });
            const acctSummary = dayAccounts.size > 0
                ? [...dayAccounts].map(a => escHtml(a)).join(', ')
                : '';

            return `
                <tr class="cashflow-row${wknd}" onclick="toggleCashflowRow('cfrow-${i}', this)">
                    <td><span class="expand-chevron" id="cf-chev-${i}">▶</span><strong>${dayName(r.date)}</strong></td>
                    <td>${fmtAccounting(r.opening)}</td>
                    <td class="text-green">+${fmt(r.dayIn)}</td>
                    <td class="text-red">-${fmt(r.dayOut)}</td>
                    <td class="${r.net >= 0 ? 'text-green' : 'text-red'}">${r.net >= 0 ? '+' : '-'}${fmt(r.net)}</td>
                    <td class="${closingClass}"><strong>${fmtAccounting(r.closing)}</strong></td>
                    <td class="od-text-muted-sm" style="white-space:nowrap">${acctSummary}</td>
                </tr>
                <tr class="cashflow-table-row-detail" id="cfrow-${i}">
                    <td colspan="7"><div class="expand-content"><div class="cashflow-detail-list">
                        <div style="margin-bottom:8px;"><strong>Inflows:</strong></div>
                        ${inflowsHtml}
                        <div style="margin-top:8px;margin-bottom:8px;"><strong>Outflows:</strong></div>
                        ${outflowsHtml}
                    </div></div></td>
                </tr>
            `;
        }).join('');

        // Totals row + cross-check diagnostic
        const totalNet = totalIn - totalOut;
        const monthlyCostsCalc = activeCostsList.reduce((s, r) => s + (Number(getField(r, F.costExpected)) || 0), 0);
        const fullOutflows = totalOut + clearedOut;
        const fullInflows = totalIn + clearedIn;
        const outDiff = Math.abs(fullOutflows - monthlyCostsCalc);
        const inDiff = Math.abs(fullInflows - monthlyIncome);
        const outMatch = outDiff < monthlyCostsCalc * 0.05;
        const inMatch = inDiff < monthlyIncome * 0.05;
        const clearedNote = (clearedInCount + clearedOutCount) > 0
            ? `${clearedInCount + clearedOutCount} reconciled (${fmt(clearedIn)} in, ${fmt(clearedOut)} out)`
            : '';

        tbody.insertAdjacentHTML('beforeend', `
            <tr style="background:var(--bg-subtle);font-weight:var(--fw-semibold);border-top:2px solid var(--border-default)">
                <td>Totals</td>
                <td></td>
                <td class="text-green">+${fmt(totalIn)}</td>
                <td class="text-red">-${fmt(totalOut)}</td>
                <td class="${totalNet >= 0 ? 'text-green' : 'text-red'}">${totalNet >= 0 ? '+' : '-'}${fmt(totalNet)}</td>
                <td></td>
                <td></td>
            </tr>
            <tr style="background:var(--bg-surface-2);font-size:0.8rem;color:var(--text-secondary)">
                <td colspan="7" style="padding:8px 12px;line-height:1.6">
                    <strong>Cross-check vs Dashboard metrics:</strong><br>
                    Inflows: ${fmt(fullInflows)} forecast (incl. reconciled) vs ${fmt(monthlyIncome)} monthly income
                    <span style="color:${inMatch ? 'var(--success)' : 'var(--warning)'}">${inMatch ? '✓ Match' : '△ Differs'}</span>
                    ${!inMatch ? `<span style="color:var(--text-muted)"> (${fmt(inDiff)} gap — partial month or frequency differences)</span>` : ''}
                    <br>
                    Outflows: ${fmt(fullOutflows)} forecast (incl. reconciled) vs ${fmt(monthlyCostsCalc)} monthly costs
                    <span style="color:${outMatch ? 'var(--success)' : 'var(--warning)'}">${outMatch ? '✓ Match' : '△ Differs'}</span>
                    ${!outMatch ? `<span style="color:var(--text-muted)"> (${fmt(outDiff)} gap — quarterly/annual costs or partial month)</span>` : ''}
                    ${clearedNote ? `<br><span style="color:var(--text-muted)">🔄 ${clearedNote}</span>` : ''}
                </td>
            </tr>
        `);

        // Build what-if data: recalculate closing balances excluding unchecked items
        window._cfRows = rows;
        window._cfOpeningBalance = openingBalance;
        const whatIfData = buildWhatIfLine(rows, openingBalance);

        // Resolve design tokens to concrete colour strings BEFORE handing
        // them to Chart.js. Chart.js draws to a <canvas> and passes colour
        // strings straight to the 2D context — it does not resolve CSS
        // custom properties (`var(--success)`). Pre-resolving via
        // getComputedStyle keeps the chart on the design palette without
        // relying on hardcoded hex.
        const docStyle = getComputedStyle(document.documentElement);
        const cv = (name, fallback) => (docStyle.getPropertyValue(name) || '').trim() || fallback;
        const successColor   = cv('--success',        '#16a34a');
        const warningColor   = cv('--warning',        '#d97706');
        const dangerColor    = cv('--danger',         '#dc2626');
        const textPrimary    = cv('--text-primary',   '#1C2422');
        const textSecondary  = cv('--text-secondary', '#5A6660');
        const borderDefault  = cv('--border-default', '#DDE1D9');
        const surfaceColor   = cv('--bg-surface',     '#FBFBF9');

        // Chart
        if (cashflowChartInstance) cashflowChartInstance.destroy();
        const ctx = document.getElementById('cashflowChart');
        cashflowChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: chartLabels,
                datasets: [{
                    label: 'Closing Balance (Fixed Costs Only — No Variable Reserves)',
                    data: chartData,
                    borderColor: successColor,
                    backgroundColor: 'rgba(22, 163, 74, 0.06)',
                    borderWidth: 2,
                    borderDash: [6, 3],
                    fill: true,
                    tension: 0.4,
                    pointRadius: 3.5,
                    pointBackgroundColor: successColor,
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 2,
                    pointHoverRadius: 6,
                    pointStyle: 'circle',
                }, {
                    label: 'After All Variable Costs (Maintenance + Wages + CFV Reserve)',
                    data: chartDataWorstCase,
                    borderColor: warningColor,
                    backgroundColor: 'rgba(217, 119, 6, 0.05)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.4,
                    pointRadius: 3.5,
                    pointBackgroundColor: warningColor,
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 2,
                    pointHoverRadius: 6,
                    pointStyle: 'circle',
                }, {
                    label: 'What-If (Excludes Unchecked + Wages Only)',
                    data: whatIfData,
                    borderColor: dangerColor,
                    backgroundColor: 'rgba(220, 38, 38, 0.05)',
                    borderWidth: 2,
                    borderDash: [4, 4],
                    fill: false,
                    tension: 0.4,
                    pointRadius: 3.5,
                    pointBackgroundColor: dangerColor,
                    pointBorderColor: '#ffffff',
                    pointBorderWidth: 2,
                    pointHoverRadius: 6,
                    pointStyle: 'circle',
                    hidden: !hasAnyExclusions(), // hidden by default until user unchecks something
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: true,
                        labels: {
                            color: textPrimary,
                            font: { size: 12, family: cv('--font-family-base', 'Inter, sans-serif') },
                            padding: 15,
                        }
                    },
                    tooltip: {
                        backgroundColor: surfaceColor,
                        titleColor: textPrimary,
                        bodyColor: textSecondary,
                        borderColor: borderDefault,
                        borderWidth: 1,
                        padding: 12,
                        displayColors: true,
                        callbacks: { label: ctx => ctx.dataset.label + ': £' + ctx.parsed.y.toLocaleString('en-GB', {minimumFractionDigits: 2, maximumFractionDigits: 2}) }
                    }
                },
                scales: {
                    y: {
                        suggestedMin: -2000,
                        grid: { color: borderDefault, drawBorder: false },
                        ticks: {
                            color: textPrimary,
                            font: { size: 11 },
                            callback: v => '£' + v.toLocaleString()
                        }
                    },
                    x: {
                        grid: { display: false, drawBorder: false },
                        ticks: { color: textPrimary, font: { size: 10 } }
                    }
                }
            }
        });
        return rows;
    }

    // ── Due Date Projection ──
    function projectDates(today, dueDay, frequency, _unused, dueDateNext) {
        const dates = [];
        const windowEnd = new Date(today);
        windowEnd.setDate(windowEnd.getDate() + 31);
        const todayDay = today.getDate();

        const freq = (frequency || 'Monthly').toLowerCase();

        if (freq === 'weekly' || freq === 'fortnightly' || freq === '4-weekly') {
            // Use dueDateNext as anchor
            let anchor = dueDateNext ? new Date(dueDateNext) : null;
            if (!anchor || isNaN(anchor.getTime())) {
                // Fallback: use due day this month
                anchor = new Date(today.getFullYear(), today.getMonth(), dueDay);
            }
            const interval = freq === 'weekly' ? 7 : freq === 'fortnightly' ? 14 : 28;

            // Find first occurrence at or after today
            while (anchor < today) anchor.setDate(anchor.getDate() + interval);
            // Also check backwards in case anchor is far future
            let check = new Date(anchor);
            while (check > today) {
                const prev = new Date(check);
                prev.setDate(prev.getDate() - interval);
                if (prev < today) break;
                check = prev;
            }
            // Project forward from check
            let d = new Date(check);
            while (d <= windowEnd) {
                if (d >= today) dates.push(dateKey(d));
                d.setDate(d.getDate() + interval);
            }
        } else if (freq === 'daily') {
            let d = new Date(today);
            while (d <= windowEnd) {
                dates.push(dateKey(d));
                d.setDate(d.getDate() + 1);
            }
        } else if (freq === 'quarterly') {
            for (let m = 0; m < 3; m++) {
                const checkDate = new Date(today.getFullYear(), today.getMonth() + m, 1);
                const lastDay = new Date(checkDate.getFullYear(), checkDate.getMonth() + 1, 0).getDate();
                const actualDay = Math.min(dueDay, lastDay);
                const d = new Date(checkDate.getFullYear(), checkDate.getMonth(), actualDay);
                if (d >= today && d <= windowEnd && [0, 3, 6, 9].includes(d.getMonth())) {
                    dates.push(dateKey(d));
                }
            }
            if (dates.length === 0) {
                const thisMonth = new Date(today.getFullYear(), today.getMonth(), Math.min(dueDay, new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()));
                const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, Math.min(dueDay, new Date(today.getFullYear(), today.getMonth() + 2, 0).getDate()));
                [thisMonth, nextMonth].forEach(d => {
                    if (d >= today && d <= windowEnd) dates.push(dateKey(d));
                });
            }
        } else if (freq === 'annually' || freq === 'annual') {
            for (let m = 0; m < 2; m++) {
                const checkDate = new Date(today.getFullYear(), today.getMonth() + m, 1);
                const lastDay = new Date(checkDate.getFullYear(), checkDate.getMonth() + 1, 0).getDate();
                const actualDay = Math.min(dueDay, lastDay);
                const d = new Date(checkDate.getFullYear(), checkDate.getMonth(), actualDay);
                if (d >= today && d <= windowEnd) dates.push(dateKey(d));
            }
        } else {
            // Monthly (default)
            // Include this month's due date if today or future, plus next month
            // if within the 31-day window. Reconciliation handles already-paid items.
            const thisMonthLast = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
            const nextMonthLast = new Date(today.getFullYear(), today.getMonth() + 2, 0).getDate();

            let dThis;
            if (dueDay > thisMonthLast) {
                dThis = new Date(today.getFullYear(), today.getMonth() + 1, 1);
            } else {
                dThis = new Date(today.getFullYear(), today.getMonth(), dueDay);
            }
            // Normalise to midnight for clean comparison
            const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            if (dThis >= todayMidnight && dThis <= windowEnd) {
                dates.push(dateKey(dThis));
            }

            let dNext;
            if (dueDay > nextMonthLast) {
                dNext = new Date(today.getFullYear(), today.getMonth() + 2, 1);
            } else {
                dNext = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
            }
            if (dNext >= todayMidnight && dNext <= windowEnd) {
                dates.push(dateKey(dNext));
            }
        }

        return dates;
    }


    // ── Balance Calculator ──
    // Uses projected inflows/outflows from the cash flow forecast
    // State persists in sessionStorage, keyed by today's date — auto-resets on a new day
    let calcItems = [];
    const CALC_STATE_KEY = '_calc_state';

    function getCalcStateDate() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    }

    // Unique key for each calc item — survives index shifts between refreshes
    function calcItemKey(item) {
        return `${item.date}|${item.label}|${item.amount}|${item.isInflow ? 'in' : 'out'}`;
    }

    function saveCalcState() {
        const checked = [];
        calcItems.forEach((item, i) => {
            const cb = document.getElementById(`calc-cb-${i}`);
            if (cb && cb.checked) checked.push(calcItemKey(item));
        });
        const balInput = document.getElementById('calcOpeningBal');
        const panel = document.getElementById('calcPanel');
        const state = {
            date: getCalcStateDate(),
            checked,
            openingBal: balInput ? balInput.value : '',
            panelOpen: panel ? panel.classList.contains('open') : false,
            userEditedBal: balInput ? !!balInput.dataset.userEdited : false,
        };
        sessionStorage.setItem(CALC_STATE_KEY, JSON.stringify(state));
    }

    function loadCalcState() {
        try {
            const raw = sessionStorage.getItem(CALC_STATE_KEY);
            if (!raw) return null;
            const state = JSON.parse(raw);
            // Auto-reset on new day
            if (state.date !== getCalcStateDate()) {
                sessionStorage.removeItem(CALC_STATE_KEY);
                return null;
            }
            return state;
        } catch { return null; }
    }

    function toggleCalcPanel() {
        const panel = document.getElementById('calcPanel');
        panel.classList.toggle('open');
        saveCalcState();
    }

    function populateCalcFromForecast(rows) {
        calcItems = [];
        rows.forEach(r => {
            const dateStr = dayName(r.date);
            const dk = r.key;
            r.inflows.forEach(f => {
                calcItems.push({ date: dk, dateStr, label: f.name, amount: f.amount, isInflow: true });
            });
            r.outflows.forEach(f => {
                calcItems.push({ date: dk, dateStr, label: f.name, amount: f.amount, isInflow: false });
            });
        });

        // Load saved state BEFORE rendering so checked attributes are baked into HTML
        // Saved keys are item identity strings — match against current items by key
        const state = loadCalcState();
        const savedKeys = new Set(state && state.checked ? state.checked : []);
        const checkedIndices = new Set();
        if (savedKeys.size > 0) {
            calcItems.forEach((item, i) => {
                if (savedKeys.has(calcItemKey(item))) checkedIndices.add(i);
            });
        }
        renderCalcList(checkedIndices);

        // Restore panel and balance
        if (state) {
            const panel = document.getElementById('calcPanel');
            if (panel && state.panelOpen) panel.classList.add('open');
            const balInput = document.getElementById('calcOpeningBal');
            if (balInput && state.userEditedBal && state.openingBal) {
                balInput.value = state.openingBal;
                balInput.dataset.userEdited = '1';
            }
        }
        updateCalcTotals(true);
    }

    function renderCalcList(checkedSet) {
        const list = document.getElementById('calcTxList');
        if (!calcItems.length) {
            list.innerHTML = '<div class="od-empty-state">No forecast items found</div>';
            return;
        }
        list.innerHTML = calcItems.map((item, i) => {
            const amtClass = item.isInflow ? 'text-green' : 'text-red';
            const prefix = item.isInflow ? '+' : '-';
            const isChecked = checkedSet && checkedSet.has(i) ? ' checked' : '';
            const typeTag = item.isInflow
                ? '<span class="od-status-badge success" style="margin-left:6px">Inflow</span>'
                : '<span class="od-status-badge danger" style="margin-left:6px">Outflow</span>';
            return `<div class="calc-tx-item">
                <input type="checkbox" class="calc-tx-cb" id="calc-cb-${i}" data-idx="${i}"${isChecked} onchange="updateCalcTotals()">
                <span class="calc-tx-date">${escHtml(item.dateStr)}</span>
                <span class="calc-tx-name">${escHtml(item.label)}${typeTag}</span>
                <span class="calc-tx-amount ${amtClass}">${prefix}${fmt(item.amount)}</span>
            </div>`;
        }).join('');
    }

    function updateCalcTotals(skipSave) {
        const opening = parseFloat(document.getElementById('calcOpeningBal').value) || 0;
        let totalIn = 0, totalOut = 0;

        calcItems.forEach((item, i) => {
            const cb = document.getElementById(`calc-cb-${i}`);
            if (cb && cb.checked) {
                if (item.isInflow) totalIn += item.amount;
                else totalOut += item.amount;
            }
        });

        const net = totalIn - totalOut;
        const closing = opening + net;

        document.getElementById('calcTotalIn').textContent = '+' + fmt(totalIn);
        document.getElementById('calcTotalOut').textContent = '-' + fmt(totalOut);

        const netEl = document.getElementById('calcNetImpact');
        netEl.textContent = (net >= 0 ? '+' : '-') + fmt(net);
        netEl.className = 'calc-summary-value ' + (net >= 0 ? 'text-green' : 'text-red');

        const closingEl = document.getElementById('calcClosingBal');
        closingEl.textContent = fmtAccounting(closing);
        closingEl.className = 'calc-summary-value ' + (closing >= 0 ? 'text-green' : 'text-red');

        if (!skipSave) saveCalcState();
    }

    function calcSelectAll() {
        calcItems.forEach((_, i) => {
            const cb = document.getElementById(`calc-cb-${i}`);
            if (cb) cb.checked = true;
        });
        updateCalcTotals();
    }

    function calcDeselectAll() {
        calcItems.forEach((_, i) => {
            const cb = document.getElementById(`calc-cb-${i}`);
            if (cb) cb.checked = false;
        });
        updateCalcTotals();
    }

    function calcSelectInflows() {
        calcItems.forEach((item, i) => {
            const cb = document.getElementById(`calc-cb-${i}`);
            if (cb) cb.checked = item.isInflow;
        });
        updateCalcTotals();
    }

    function calcSelectOutflows() {
        calcItems.forEach((item, i) => {
            const cb = document.getElementById(`calc-cb-${i}`);
            if (cb) cb.checked = !item.isInflow;
        });
        updateCalcTotals();
    }

    // WHAT-IF CASH FLOW EXCLUSIONS
    // ══════════════════════════════════════════

    // Stable key: date + direction + name + amount — doesn't shift when data reorders
    function cfStableKey(dateKey, dir, name, amount) {
        return `${dateKey}|${dir}|${name}|${amount}`.replace(/[^a-zA-Z0-9|£.\-\s]/g, '');
    }

    function getCFExclusions() {
        try {
            const excl = JSON.parse(localStorage.getItem('_cf_exclusions') || '{}');
            // Auto-expire exclusions for dates that have passed
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const todayKey = dateKey(today);
            let changed = false;
            for (const key of Object.keys(excl)) {
                const datePart = key.split('|')[0]; // YYYY-MM-DD
                if (datePart && datePart < todayKey) { delete excl[key]; changed = true; }
            }
            if (changed) localStorage.setItem('_cf_exclusions', JSON.stringify(excl));
            return excl;
        } catch { return {}; }
    }
    function isCFExcluded(cbId) { return !!getCFExclusions()[cbId]; }
    function hasAnyExclusions() { return Object.keys(getCFExclusions()).length > 0; }

    function toggleCFExclusion(cbId) {
        const excl = getCFExclusions();
        if (excl[cbId]) {
            delete excl[cbId];
        } else {
            excl[cbId] = true;
        }
        localStorage.setItem('_cf_exclusions', JSON.stringify(excl));
        updateWhatIfChart();
    }

    function buildWhatIfLine(rows, openingBalance) {
        const excl = getCFExclusions();
        const dailyWagesReserve = WAGES_TARGET_GBP / 31;
        let balance = openingBalance;
        return rows.map((r, i) => {
            let dayIn = 0, dayOut = 0;
            r.inflows.forEach((f, fi) => {
                if (f.cleared) return;
                const key = cfStableKey(r.key, 'in', f.name, f.amount);
                if (!excl[key]) dayIn += f.amount;
            });
            r.outflows.forEach((f, fi) => {
                if (f.cleared) return;
                const key = cfStableKey(r.key, 'out', f.name, f.amount);
                if (!excl[key]) dayOut += f.amount;
            });
            balance += dayIn - dayOut;
            // Include wages budget only (not maintenance or CFV reserve)
            return balance - dailyWagesReserve * (i + 1);
        });
    }

    function updateWhatIfChart() {
        if (!cashflowChartInstance || !window._cfRows || !window._cfOpeningBalance) return;
        const whatIfData = buildWhatIfLine(window._cfRows, window._cfOpeningBalance);
        // Dataset index 2 is the what-if line
        if (cashflowChartInstance.data.datasets[2]) {
            cashflowChartInstance.data.datasets[2].data = whatIfData;
            cashflowChartInstance.data.datasets[2].hidden = !hasAnyExclusions();
            cashflowChartInstance.update();
        }
    }

    // ══════════════════════════════════════════
    // WITHDRAWAL ADVISOR
    // ══════════════════════════════════════════

    const WA_KEY = '_wa_state';
    const WA_SETTINGS_KEY = '_wa_settings';

    function getWASettings() {
        try {
            const raw = localStorage.getItem(WA_SETTINGS_KEY);
            if (!raw) return {};
            return JSON.parse(raw);
        } catch { return {}; }
    }

    function saveWASettings() {
        const floorInput = document.getElementById('waFloorOverride');
        const wagesInput = document.getElementById('waWagesAmount');
        const topupInput = document.getElementById('waTopupAmount');
        const daySelect = document.getElementById('waCommitDay');
        const settings = getWASettings();
        if (floorInput && floorInput.dataset.userEdited) settings.floorOverride = parseFloat(floorInput.value) || null;
        if (wagesInput && wagesInput.dataset.userEdited) settings.wages = parseFloat(wagesInput.value);
        if (topupInput && topupInput.dataset.userEdited) settings.topup = parseFloat(topupInput.value);
        if (daySelect && daySelect.dataset.userEdited) settings.commitDay = parseInt(daySelect.value);
        localStorage.setItem(WA_SETTINGS_KEY, JSON.stringify(settings));
    }

    function getWAState() {
        try {
            const raw = localStorage.getItem(WA_KEY);
            if (!raw) return null;
            const state = JSON.parse(raw);
            const todayStr = getCalcStateDate();
            if (state.date !== todayStr) {
                localStorage.removeItem(WA_KEY);
                return null;
            }
            return state;
        } catch { return null; }
    }

    function saveWAState() {
        const balInput = document.getElementById('waOpeningBal');
        const clearedIds = [];
        document.querySelectorAll('.wa-today-cb:checked').forEach(cb => {
            clearedIds.push(cb.dataset.waKey);
        });
        const riskIds = [];
        document.querySelectorAll('.wa-risk-cb:checked').forEach(cb => {
            riskIds.push(cb.dataset.waKey);
        });
        const state = {
            date: getCalcStateDate(),
            openingBal: balInput ? balInput.value : '',
            userEditedBal: balInput ? !!balInput.dataset.userEdited : false,
            cleared: clearedIds,
            riskExcluded: riskIds,
        };
        localStorage.setItem(WA_KEY, JSON.stringify(state));
        saveWASettings();
    }

    function analysePaymentLag(transactions, incomeTenancies) {
        const lagByTenancy = {};
        const tenancyDueDay = {};
        incomeTenancies.forEach(r => {
            const dueDay = getNumVal(r, F.tenDueDay, 1);
            tenancyDueDay[r.id] = dueDay;
        });

        (transactions || []).forEach(r => {
            if (!getField(r, F.txReconciled)) return;
            const sc = getField(r, F.txSubCategory);
            const scIds = Array.isArray(sc) ? sc.map(s => typeof s === 'object' ? s.id : s) : [];
            if (!scIds.includes(REC.subRentalInc)) return;

            const linked = getField(r, F.txTenancy);
            const tenIds = Array.isArray(linked)
                ? linked.map(t => (t && typeof t === 'object') ? t.id : t).filter(Boolean)
                : [];
            if (tenIds.length === 0) return;

            const txDateStr = getField(r, F.txDate);
            if (!txDateStr) return;
            const txDate = new Date(txDateStr);
            if (isNaN(txDate.getTime())) return;

            tenIds.forEach(tid => {
                const dueDay = tenancyDueDay[tid];
                if (!dueDay) return;
                const txMonth = txDate.getMonth();
                const txYear = txDate.getFullYear();
                const lastDayOfMonth = new Date(txYear, txMonth + 1, 0).getDate();
                const dueDate = new Date(txYear, txMonth, Math.min(dueDay, lastDayOfMonth));
                if (txDate < dueDate) {
                    const prevMonthLastDay = new Date(txYear, txMonth, 0).getDate();
                    const prevMonth = new Date(txYear, txMonth - 1, Math.min(dueDay, prevMonthLastDay));
                    const lagPrev = Math.round((txDate - prevMonth) / 86400000);
                    if (lagPrev >= 0 && lagPrev <= 15) {
                        if (!lagByTenancy[tid]) lagByTenancy[tid] = [];
                        lagByTenancy[tid].push(lagPrev);
                        return;
                    }
                }
                const lag = Math.round((txDate - dueDate) / 86400000);
                if (lag >= -5 && lag <= 30) {
                    if (!lagByTenancy[tid]) lagByTenancy[tid] = [];
                    lagByTenancy[tid].push(lag);
                }
            });
        });

        const allLags = [];
        const tenancyAvgLag = {};
        for (const tid in lagByTenancy) {
            const lags = lagByTenancy[tid];
            if (lags.length < 2) continue;
            const avg = lags.reduce((s, v) => s + v, 0) / lags.length;
            const maxLag = Math.max(...lags);
            tenancyAvgLag[tid] = { avg: Math.round(avg * 10) / 10, max: maxLag, count: lags.length };
            allLags.push(...lags);
        }

        let bufferDays = 3;
        let bufferReason = 'Default 3-day buffer (insufficient transaction history for analysis)';
        if (allLags.length >= 10) {
            const sorted = [...allLags].sort((a, b) => a - b);
            const p80Idx = Math.floor(sorted.length * 0.8);
            const p80 = sorted[p80Idx];
            bufferDays = Math.max(2, Math.min(p80 + 1, 10));
            const avgAll = (allLags.reduce((s, v) => s + v, 0) / allLags.length).toFixed(1);
            bufferReason = `${bufferDays}-day buffer from ${allLags.length} payments (avg ${avgAll} days lag, 80th pct ${p80} days)`;
        }

        return { tenancyAvgLag, bufferDays, bufferReason, sampleSize: allLags.length };
    }

    function buildWithdrawalSchedule(rows, dashboardOpeningBalance, transactions, incomeTenancies) {
        const container = document.getElementById('withdrawalAdvisorCard');
        if (!container) return;

        const lagAnalysis = analysePaymentLag(transactions, incomeTenancies);
        const state = getWAState();
        const settings = getWASettings();
        const savedCleared = new Set(state && state.cleared ? state.cleared : []);
        const savedRisk = new Set(state && state.riskExcluded ? state.riskExcluded : []);

        const userBal = state && state.userEditedBal && state.openingBal
            ? parseFloat(state.openingBal) : null;
        const effectiveOpening = userBal !== null ? userBal : dashboardOpeningBalance;

        const WEEKLY_WAGES = settings.wages !== undefined ? settings.wages : 330;
        const WEEKLY_TOPUP = settings.topup !== undefined ? settings.topup : 140;
        const COMMIT_DAY = settings.commitDay !== undefined ? settings.commitDay : 5;
        const WEEKLY_COMMITMENTS = WEEKLY_WAGES + WEEKLY_TOPUP;
        const DAY_NAMES_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

        const balanceDiff = Math.abs(effectiveOpening - dashboardOpeningBalance);
        const balanceWarning = userBal !== null && balanceDiff > 200;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayKey = dateKey(today);

        const todayItems = [];
        if (rows.length > 0 && rows[0].key === todayKey) {
            rows[0].inflows.forEach(f => {
                const key = `in|${f.name}|${f.amount}`;
                todayItems.push({ ...f, dir: 'in', waKey: key, cleared: savedCleared.has(key) });
            });
            rows[0].outflows.forEach(f => {
                const key = `out|${f.name}|${f.amount}`;
                todayItems.push({ ...f, dir: 'out', waKey: key, cleared: savedCleared.has(key) });
            });
        }

        const projectedDays = [];
        let runningBalance = effectiveOpening;
        let naturalBalance = effectiveOpening;

        const allDayInflows = [];

        rows.forEach((r, idx) => {
            let dayIn = 0, dayOut = 0;
            const isToday = r.key === todayKey;
            const dayInflowItems = [];

            r.inflows.forEach(f => {
                if (f.cleared) return;
                const inflowKey = `risk|${r.key}|${f.name}|${f.amount}`;
                const isRisk = savedRisk.has(inflowKey);
                if (isToday) {
                    const ck = `in|${f.name}|${f.amount}`;
                    if (savedCleared.has(ck)) return;
                }
                dayInflowItems.push({ name: f.name, amount: f.amount, riskKey: inflowKey, excluded: isRisk });
                if (!isRisk) dayIn += f.amount;
            });
            r.outflows.forEach(f => {
                if (f.cleared) return;
                if (isToday) {
                    const ck = `out|${f.name}|${f.amount}`;
                    if (savedCleared.has(ck)) return;
                }
                dayOut += f.amount;
            });

            const dow = r.date.getDay();
            if (dow === COMMIT_DAY) {
                dayOut += WEEKLY_COMMITMENTS;
            }

            const opening = runningBalance;
            const naturalOpening = naturalBalance;
            runningBalance += dayIn - dayOut;
            naturalBalance += dayIn - dayOut;

            allDayInflows.push({ key: r.key, date: r.date, items: dayInflowItems });

            projectedDays.push({
                date: r.date,
                key: r.key,
                dayIn,
                dayOut,
                opening,
                balance: runningBalance,
                naturalOpening,
                naturalBalance,
                isFriday: dow === COMMIT_DAY,
                isPadded: false,
            });
        });

        const EXTRA_DAYS = 14;
        if (rows.length > 0) {
            const lastForecastDate = new Date(rows[rows.length - 1].date);
            for (let d = 1; d <= EXTRA_DAYS; d++) {
                const padDate = new Date(lastForecastDate);
                padDate.setDate(padDate.getDate() + d);
                const dow = padDate.getDay();
                const dayOut = dow === COMMIT_DAY ? WEEKLY_COMMITMENTS : 0;
                const opening = runningBalance;
                const naturalOpening = naturalBalance;
                runningBalance -= dayOut;
                naturalBalance -= dayOut;

                projectedDays.push({
                    date: padDate,
                    key: dateKey(padDate),
                    dayIn: 0,
                    dayOut,
                    opening,
                    balance: runningBalance,
                    naturalOpening,
                    naturalBalance,
                    isFriday: dow === COMMIT_DAY,
                    isPadded: true,
                });
                allDayInflows.push({ key: dateKey(padDate), date: padDate, items: [] });
            }
        }

        const maxSingleInflow = rows.reduce((max, r) => {
            r.inflows.forEach(f => { if (!f.cleared && f.amount > max) max = f.amount; });
            return max;
        }, 0);
        const calculatedBuffer = Math.max(500, maxSingleInflow * 0.3 * lagAnalysis.bufferDays / 3);
        const calculatedRounded = Math.ceil(calculatedBuffer / 50) * 50;
        const floorOverride = settings.floorOverride;
        const roundedBuffer = floorOverride !== null && floorOverride !== undefined
            ? Math.ceil(floorOverride / 50) * 50
            : calculatedRounded;
        const usingCustomFloor = floorOverride !== null && floorOverride !== undefined;

        const withdrawals = [];
        let lastWithdrawalIdx = -1;
        const MIN_DAYS_BETWEEN = 3;

        for (let i = 0; i < projectedDays.length; i++) {
            if (i - lastWithdrawalIdx < MIN_DAYS_BETWEEN && lastWithdrawalIdx >= 0) continue;

            const day = projectedDays[i];
            const availableNow = day.opening - roundedBuffer;
            if (availableNow < 50) continue;

            let minFutureOpening = availableNow;
            const lookAhead = projectedDays.length;
            for (let j = i + 1; j < lookAhead; j++) {
                const lowestInDay = Math.min(projectedDays[j].opening, projectedDays[j].balance);
                const futureAvail = lowestInDay - roundedBuffer;
                if (futureAvail < minFutureOpening) minFutureOpening = futureAvail;
            }

            if (minFutureOpening < 50) continue;
            const withdrawAmount = Math.floor(minFutureOpening / 50) * 50;
            if (withdrawAmount < 50) continue;

            withdrawals.push({
                date: day.date,
                key: day.key,
                amount: withdrawAmount,
                balanceBefore: day.opening,
                balanceAfter: day.opening - withdrawAmount,
            });

            for (let j = i; j < projectedDays.length; j++) {
                projectedDays[j].balance -= withdrawAmount;
                if (j > i) projectedDays[j].opening -= withdrawAmount;
            }
            lastWithdrawalIdx = i;
        }

        const withdrawalByKey = {};
        withdrawals.forEach(w => { withdrawalByKey[w.key] = w; });

        const totalAvailable = withdrawals.reduce((s, w) => s + w.amount, 0);
        const nextWithdrawal = withdrawals.length > 0 ? withdrawals[0] : null;
        const riskExcludedTotal = allDayInflows.reduce((sum, d) =>
            sum + d.items.filter(i => i.excluded).reduce((s, i) => s + i.amount, 0), 0);

        let worstCaseNote = '';
        if (rows.length > 0) {
            let biggestInflow = { name: '', amount: 0, date: null };
            rows.forEach(r => {
                r.inflows.forEach(f => {
                    if (!f.cleared && f.amount > biggestInflow.amount) {
                        biggestInflow = { name: f.name, amount: f.amount, date: r.date };
                    }
                });
            });
            if (biggestInflow.amount > 0) {
                worstCaseNote = `If ${escHtml(biggestInflow.name)} (${fmt(biggestInflow.amount)}) doesn't arrive on ${dayName(biggestInflow.date)}, `;
                const impact = withdrawals.filter(w => w.date >= biggestInflow.date);
                if (impact.length > 0) {
                    worstCaseNote += `${impact.length} withdrawal${impact.length > 1 ? 's' : ''} totalling ${fmt(impact.reduce((s, w) => s + w.amount, 0))} would need to be delayed.`;
                } else {
                    worstCaseNote += `earlier withdrawals are unaffected but the buffer would be squeezed.`;
                }
            }
        }

        const todayItemsHtml = todayItems.length > 0
            ? `<div style="margin:12px 0 16px">
                <div style="font-weight:var(--fw-semibold);margin-bottom:8px;color:var(--text-primary)">Today's items (tick what's already cleared in the bank):</div>
                ${todayItems.map(item => {
                    const checked = item.cleared ? ' checked' : '';
                    const colour = item.dir === 'in' ? 'var(--success)' : 'var(--danger)';
                    const prefix = item.dir === 'in' ? '+' : '-';
                    return `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer">
                        <input type="checkbox" class="wa-today-cb" data-wa-key="${item.waKey.replace(/"/g, '&quot;')}"${checked} onchange="waRecalc()">
                        <span style="flex:1">${escHtml(item.name)}</span>
                        <span style="color:${colour};font-weight:var(--fw-medium)">${prefix}${fmt(item.amount)}</span>
                    </label>`;
                }).join('')}
                <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-top:4px">Ticked = already in your bank balance. Unticked = still expected today and included in the forecast.</div>
            </div>`
            : '';

        const scheduleHtml = withdrawals.length > 0
            ? withdrawals.map(w => {
                return `<div style="display:flex;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border-subtle)">
                    <span style="flex:1;font-weight:var(--fw-medium)">${dayName(w.date)}</span>
                    <span style="width:120px;text-align:right;color:var(--success);font-weight:var(--fw-semibold)">${fmt(w.amount)}</span>
                    <span style="width:140px;text-align:right;color:var(--text-secondary);font-size:var(--fs-sm)">Balance after: ${fmt(w.balanceAfter)}</span>
                </div>`;
            }).join('')
            : `<div style="padding:12px;color:var(--text-muted)">No safe withdrawal windows in the forecast period. All surplus is needed to cover commitments and maintain the safety buffer.</div>`;

        const forecastDayCount = rows.length;
        const totalDayCount = projectedDays.length;

        const dailyBalanceRows = projectedDays.map((d, idx) => {
            const isToday2 = d.key === todayKey;
            const w = withdrawalByKey[d.key];
            const isBelowBuffer = d.balance < roundedBuffer;
            const isNearBuffer = !isBelowBuffer && d.balance < roundedBuffer * 1.2;
            const closingClass = isBelowBuffer ? 'text-red' : isNearBuffer ? 'text-amber' : 'text-green';
            const wknd = [0, 6].includes(d.date.getDay()) ? ' weekend' : '';
            const paddedStyle = d.isPadded ? ' style="opacity:0.7;font-style:italic"' : '';

            const dayInflows = allDayInflows[idx];
            const hasRiskItems = dayInflows && dayInflows.items.length > 0;

            const inflowsDetail = hasRiskItems
                ? dayInflows.items.map(item => {
                    const chk = item.excluded ? ' checked' : '';
                    return `<div class="cashflow-detail-item in" style="${item.excluded ? 'opacity:0.5' : ''}">
                        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1">
                            <input type="checkbox" class="wa-risk-cb" data-wa-key="${item.riskKey.replace(/"/g, '&quot;')}"${chk} onchange="waRecalc()" title="Tick to flag as risk (exclude from forecast)">
                            <span class="cashflow-detail-item-name" style="flex:1;${item.excluded ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">${escHtml(item.name)}${item.excluded ? ' <span style="background:var(--danger-bg);color:var(--danger);padding:1px 6px;border-radius:3px;font-size:0.75rem">Risk</span>' : ''}</span>
                        </label>
                        <span class="cashflow-detail-item-value" style="${item.excluded ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">+${fmt(item.amount)}</span>
                    </div>`;
                }).join('')
                : '<div class="cashflow-detail-item"><em>None</em></div>';

            const withdrawNote = w
                ? `<div style="margin-top:6px;padding:6px 8px;background:var(--accent-soft);border-radius:var(--radius-sm);font-size:var(--fs-xs);color:var(--accent)"><strong>Withdrawal window:</strong> ${fmt(w.amount)} safe to take</div>`
                : '';

            const naturalDiff = d.naturalBalance - d.balance;
            const naturalNote = naturalDiff > 0
                ? `<div style="margin-top:6px;font-size:var(--fs-xs);color:var(--text-muted)">Without withdrawals, closing would be ${fmtAccounting(d.naturalBalance)}</div>`
                : '';

            const dateLabel = isToday2 ? '<strong>Today</strong>' : '<strong>' + dayName(d.date) + '</strong>';
            const paddedTag = d.isPadded ? ' <span style="font-size:0.7rem;color:var(--text-muted);font-weight:normal">(est.)</span>' : '';

            return `
                <tr class="cashflow-row${wknd}"${paddedStyle} onclick="toggleCashflowRow('warow-${idx}', this)">
                    <td><span class="expand-chevron" id="wa-chev-${idx}">▶</span>${dateLabel}${paddedTag}</td>
                    <td>${fmtAccounting(d.opening)}</td>
                    <td class="text-green">${d.dayIn > 0 ? '+' + fmt(d.dayIn) : ''}</td>
                    <td class="text-red">${d.dayOut > 0 ? '-' + fmt(d.dayOut) : ''}</td>
                    <td class="${closingClass}"><strong>${fmtAccounting(d.balance)}</strong></td>
                    <td style="color:var(--text-muted);font-size:var(--fs-xs)">${fmtAccounting(d.naturalBalance)}</td>
                    <td>${w ? '<span style="color:var(--accent);font-weight:var(--fw-semibold)">' + fmt(w.amount) + '</span>' : ''}</td>
                </tr>
                <tr class="cashflow-table-row-detail" id="warow-${idx}">
                    <td colspan="7"><div class="expand-content"><div class="cashflow-detail-list">
                        <div style="margin-bottom:8px"><strong>Inflows</strong> <span style="font-weight:normal;font-size:var(--fs-xs);color:var(--text-muted)">(tick to flag as risk payment)</span></div>
                        ${inflowsDetail}
                        ${withdrawNote}
                        ${naturalNote}
                    </div></div></td>
                </tr>`;
        }).join('');

        const riskBanner = riskExcludedTotal > 0
            ? `<div style="padding:10px 14px;background:var(--danger-bg);border-radius:var(--radius-md);margin-bottom:16px;font-size:var(--fs-sm);color:var(--text-primary)">
                <strong>Risk adjustments active:</strong> ${fmt(riskExcludedTotal)} in expected inflows excluded from forecast. Withdrawal schedule reflects reduced income.
            </div>`
            : '';

        const balanceWarningHtml = balanceWarning
            ? `<div style="padding:10px 14px;background:var(--warning-bg);border-radius:var(--radius-md);margin-bottom:16px;font-size:var(--fs-sm);color:var(--text-primary)">
                <strong>Balance mismatch:</strong> Your entered balance (${fmt(effectiveOpening)}) differs from the dashboard calculated balance (${fmt(dashboardOpeningBalance)}) by ${fmt(balanceDiff)}. The entered balance is used for all calculations. If this is wrong, clear the field and recalculate.
            </div>`
            : '';

        const headerValue = totalAvailable > 0
            ? `<span style="color:var(--success)">${fmt(totalAvailable)}</span>`
            : `<span style="color:var(--text-muted)">Nothing safe to withdraw</span>`;
        const headerSub = nextWithdrawal
            ? `Next: ${fmt(nextWithdrawal.amount)} on ${dayName(nextWithdrawal.date)}`
            : 'No withdrawal windows identified';

        const dayOptions = [0,1,2,3,4,5,6].map(d => {
            const sel = d === COMMIT_DAY ? ' selected' : '';
            return `<option value="${d}"${sel}>${DAY_NAMES_SHORT[d]}</option>`;
        }).join('');

        const floorVal = usingCustomFloor ? floorOverride : calculatedRounded;
        const floorEdited = usingCustomFloor ? ' data-user-edited="1"' : '';

        container.innerHTML = `
            <div class="kpi-card clickable" onclick="toggleCard(this)" style="max-width:100%">
                <div class="kpi-card-label">Safe to withdraw (${totalDayCount} days) <span class="chevron">&#x25B8;</span></div>
                <div class="kpi-card-value">${headerValue}</div>
                <div class="kpi-card-sub">${headerSub}</div>
                <div class="kpi-card-detail" onclick="event.stopPropagation()" style="text-align:left">
                    <div style="padding:16px 0">
                        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
                            <label style="font-weight:var(--fw-medium);white-space:nowrap">Opening balance (what is in the bank now):</label>
                            <input type="number" id="waOpeningBal" value="${effectiveOpening.toFixed(2)}"
                                step="0.01"
                                style="width:140px;padding:6px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface)"
                                onchange="this.dataset.userEdited='1';waRecalc()"
                                ${userBal !== null ? 'data-user-edited="1"' : ''}>
                            <span style="color:var(--text-muted);font-size:var(--fs-xs)">Your actual bank balance right now. Cleared items below are already in this figure.</span>
                        </div>

                        ${balanceWarningHtml}

                        ${todayItemsHtml}

                        ${riskBanner}

                        <div style="background:var(--bg-surface-2);padding:10px 14px;border-radius:var(--radius-md);margin-bottom:16px;font-size:var(--fs-sm);color:var(--text-secondary)">
                            <strong>Safety floor:</strong>
                            <input type="number" id="waFloorOverride" value="${floorVal}"
                                step="50" min="0"
                                style="width:100px;padding:4px 8px;border:1px solid var(--border-default);border-radius:var(--radius-sm);font-size:var(--fs-sm);background:var(--bg-surface);margin:0 6px"
                                onchange="this.dataset.userEdited='1';waRecalc()"${floorEdited}>
                            <span style="font-size:var(--fs-xs);color:var(--text-muted)">${usingCustomFloor ? 'Custom override' : 'Auto-calculated'} . ${escHtml(lagAnalysis.bufferReason)}</span>
                            ${usingCustomFloor ? ' <button onclick="waResetFloor()" style="font-size:var(--fs-xs);color:var(--accent);background:none;border:none;cursor:pointer;text-decoration:underline">Reset to auto</button>' : ''}
                        </div>

                        <div style="background:var(--bg-surface-2);padding:10px 14px;border-radius:var(--radius-md);margin-bottom:16px;font-size:var(--fs-sm);color:var(--text-secondary);display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                            <strong>Weekly commitments:</strong>
                            Wages
                            <input type="number" id="waWagesAmount" value="${WEEKLY_WAGES}"
                                step="10" min="0"
                                style="width:90px;padding:4px 8px;border:1px solid var(--border-default);border-radius:var(--radius-sm);font-size:var(--fs-sm);background:var(--bg-surface)"
                                onchange="this.dataset.userEdited='1';waRecalc()"${settings.wages !== undefined ? ' data-user-edited="1"' : ''}>
                            + Top-up
                            <input type="number" id="waTopupAmount" value="${WEEKLY_TOPUP}"
                                step="10" min="0"
                                style="width:90px;padding:4px 8px;border:1px solid var(--border-default);border-radius:var(--radius-sm);font-size:var(--fs-sm);background:var(--bg-surface)"
                                onchange="this.dataset.userEdited='1';waRecalc()"${settings.topup !== undefined ? ' data-user-edited="1"' : ''}>
                            = ${fmt(WEEKLY_COMMITMENTS)}/week on
                            <select id="waCommitDay"
                                style="padding:4px 8px;border:1px solid var(--border-default);border-radius:var(--radius-sm);font-size:var(--fs-sm);background:var(--bg-surface)"
                                onchange="this.dataset.userEdited='1';waRecalc()"${settings.commitDay !== undefined ? ' data-user-edited="1"' : ''}>
                                ${dayOptions}
                            </select>
                        </div>

                        <div style="font-weight:var(--fw-semibold);margin-bottom:8px;color:var(--text-primary)">Withdrawal schedule:</div>
                        <div style="border:1px solid var(--border-subtle);border-radius:var(--radius-md);overflow:hidden;margin-bottom:20px">
                            <div style="display:flex;padding:8px 12px;background:var(--bg-subtle);font-size:var(--fs-xs);color:var(--text-secondary);font-weight:var(--fw-semibold)">
                                <span style="flex:1">Date</span>
                                <span style="width:120px;text-align:right">Amount</span>
                                <span style="width:140px;text-align:right">Balance after</span>
                            </div>
                            ${scheduleHtml}
                        </div>

                        <div style="font-weight:var(--fw-semibold);margin-bottom:8px;color:var(--text-primary)">${totalDayCount}-day daily balance <span style="font-weight:var(--fw-regular);font-size:var(--fs-xs);color:var(--text-muted)">(click a row to expand and flag risk payments${EXTRA_DAYS > 0 ? '; last ' + EXTRA_DAYS + ' days are estimates with weekly commitments only' : ''})</span></div>
                        <div style="border:1px solid var(--border-subtle);border-radius:var(--radius-md);overflow:hidden">
                            <table class="cashflow-table" style="width:100%;font-size:var(--fs-sm)">
                                <thead>
                                    <tr>
                                        <th style="text-align:left">Date</th>
                                        <th style="text-align:right">Opening</th>
                                        <th style="text-align:right">In</th>
                                        <th style="text-align:right">Out</th>
                                        <th style="text-align:right">Closing</th>
                                        <th style="text-align:right;font-size:var(--fs-xs);color:var(--text-muted)">Natural</th>
                                        <th style="text-align:right">Withdraw</th>
                                    </tr>
                                </thead>
                                <tbody>${dailyBalanceRows}</tbody>
                            </table>
                        </div>

                        ${worstCaseNote ? `<div style="margin-top:16px;padding:10px 14px;background:var(--warning-bg);border-radius:var(--radius-md);font-size:var(--fs-sm);color:var(--text-primary)">
                            <strong>Worst case:</strong> ${worstCaseNote}
                        </div>` : ''}
                    </div>
                </div>
            </div>
        `;

        window._waRows = rows;
        window._waDashboardOpening = dashboardOpeningBalance;
        window._waTransactions = transactions;
        window._waIncomeTenancies = incomeTenancies;
    }

    function waRecalc() {
        const card = document.querySelector('#withdrawalAdvisorCard .kpi-card');
        const wasExpanded = card && card.classList.contains('expanded');
        saveWAState();
        if (window._waRows && window._waDashboardOpening !== undefined) {
            buildWithdrawalSchedule(window._waRows, window._waDashboardOpening, window._waTransactions, window._waIncomeTenancies);
        }
        if (wasExpanded) {
            const newCard = document.querySelector('#withdrawalAdvisorCard .kpi-card');
            if (newCard && !newCard.classList.contains('expanded')) newCard.classList.add('expanded');
        }
    }

    function waResetFloor() {
        const s = getWASettings();
        delete s.floorOverride;
        localStorage.setItem(WA_SETTINGS_KEY, JSON.stringify(s));
        const floorInput = document.getElementById('waFloorOverride');
        if (floorInput) delete floorInput.dataset.userEdited;
        waRecalc();
    }
