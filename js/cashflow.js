// ══════════════════════════════════════════
// CASH FLOW — Forecast, Projections, Balance Calculator, UC Checks, What-If
// ══════════════════════════════════════════

    // ── Cash Flow Forecast ──
    function buildCashFlow(today, openingBalance, incomeTenancies, activeCostsList, allTenancies, transactions, monthlyIncome, tenancyIsUC, creditCards) {
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

        // After variable costs figures (red line values)
        const totalVarCostReserve = dailyVarCostReserve * days.length;
        const finalBalanceAfterVar = finalBalance - totalVarCostReserve;
        const netChangeAfterVar = finalBalanceAfterVar - openingBalance;
        let lowestBalAfterVar = openingBalance;
        let lowestDayAfterVar = '';
        chartDataWorstCase.forEach((v, idx) => {
            if (v < lowestBalAfterVar) { lowestBalAfterVar = v; lowestDayAfterVar = chartLabels[idx]; }
        });

        // Range-based figures: low = fixed costs only (green), high = after variable reserves (red)
        const totalOutHigh = totalOut + totalVarCostReserve;
        const netChangeLow = finalBalance - openingBalance;
        const netChangeHigh = netChangeAfterVar;
        const finalBalanceLow = finalBalance;
        const finalBalanceHigh = finalBalanceAfterVar;
        const lowestBalLow = lowestBal;
        const lowestBalHigh = lowestBalAfterVar;

        // Cash flow KPI cards — range-based with stacked layout for range values
        const fmtK = v => { const abs = Math.abs(v); return (abs >= 1000 ? '£' + (v/1000).toFixed(1) + 'k' : fmt(v)); };
        const cfLabelStyle = 'min-height:36px;display:flex;align-items:flex-start';
        const rangeStyle = 'display:flex;flex-direction:column;align-items:center;gap:2px;line-height:1.2';
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
                <div class="kpi-card-label" style="${cfLabelStyle}">Total Out (Range)</div>
                <div class="kpi-card-value text-red" style="${rangeStyle}"><span>${fmtK(totalOut)}</span><span style="font-size:0.65em;color:var(--text-muted)">to</span><span>${fmtK(totalOutHigh)}</span></div>
                <div class="kpi-card-sub">Fixed to incl. reserves</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-card-label" style="${cfLabelStyle}">Net Change (Range)</div>
                <div class="kpi-card-value" style="${rangeStyle}"><span class="${netChangeLow >= 0 ? 'text-green' : 'text-red'}">${netChangeLow >= 0 ? '+' : ''}${fmtK(netChangeLow)}</span><span style="font-size:0.65em;color:var(--text-muted)">to</span><span class="${netChangeHigh >= 0 ? 'text-green' : 'text-red'}">${netChangeHigh >= 0 ? '+' : ''}${fmtK(netChangeHigh)}</span></div>
                <div class="kpi-card-sub">Best case to worst case</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-card-label" style="${cfLabelStyle}">Final Balance (Range)</div>
                <div class="kpi-card-value" style="${rangeStyle}"><span class="text-green">${fmtK(finalBalanceLow)}</span><span style="font-size:0.65em;color:var(--text-muted)">to</span><span style="color:var(--warning)">${fmtK(finalBalanceHigh)}</span></div>
                <div class="kpi-card-sub">Day 31: green line to red line</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-card-label" style="${cfLabelStyle}">Lowest Balance (Range)</div>
                <div class="kpi-card-value" style="${rangeStyle}"><span class="${lowestBalLow >= 0 ? 'text-green' : 'text-red'}">${fmtAccounting(lowestBalLow)}</span><span style="font-size:0.65em;color:var(--text-muted)">to</span><span class="${lowestBalHigh >= 0 ? 'text-green' : 'text-red'}" style="${lowestBalHigh >= 0 ? 'color:var(--warning)' : ''}">${fmtAccounting(lowestBalHigh)}</span></div>
                <div class="kpi-card-sub">${lowestDay} / ${lowestDayAfterVar}</div>
            </div>
        `;

        // ── Withdrawal Schedule (integrated into forecast) ──
        const waSettings = getWASettings();
        const waState = getWAState();

        const userBal = waState && waState.userEditedBal && waState.openingBal
            ? parseFloat(waState.openingBal) : null;
        const effectiveOpening = userBal !== null ? userBal : openingBalance;

        const WEEKLY_WAGES = waSettings.wages !== undefined ? waSettings.wages : 330;
        const WEEKLY_TOPUP = waSettings.topup !== undefined ? waSettings.topup : 140;
        const COMMIT_DAY = waSettings.commitDay !== undefined ? waSettings.commitDay : 5;
        const WEEKLY_COMMITMENTS = WEEKLY_WAGES + WEEKLY_TOPUP;
        const DAY_NAMES_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

        // Today's items section removed — items are already visible in the forecast table

        // Build WA projection from effective opening balance
        // Uses the single-checkbox exclusion system: unchecked items are excluded
        const cfExcl = getCFExclusions();
        const waProjected = [];
        let waRunning = effectiveOpening;
        rows.forEach((r, idx) => {
            let dayIn = 0, dayOut = 0;

            r.inflows.forEach(f => {
                if (f.cleared) return;
                const cbId = cfStableKey(r.key, 'in', f.name, f.amount);
                if (cfExcl[cbId]) return;
                dayIn += f.amount;
            });
            r.outflows.forEach(f => {
                if (f.cleared) return;
                const cbId = cfStableKey(r.key, 'out', f.name, f.amount);
                if (cfExcl[cbId]) return;
                dayOut += f.amount;
            });

            const dow = r.date.getDay();
            if (dow === COMMIT_DAY) dayOut += WEEKLY_COMMITMENTS;

            const waOpening = waRunning;
            waRunning += dayIn - dayOut;
            waProjected.push({ opening: waOpening, balance: waRunning, dayIn, dayOut });
        });

        // Calculate safety buffer
        const lagAnalysis = analysePaymentLag(window._waTransactions || [], window._waIncomeTenancies || []);
        const maxSingleInflow = rows.reduce((max, r) => {
            r.inflows.forEach(f => { if (!f.cleared && f.amount > max) max = f.amount; });
            return max;
        }, 0);
        const calculatedBuffer = Math.max(500, maxSingleInflow * 0.3 * lagAnalysis.bufferDays / 3);
        const calculatedRounded = Math.ceil(calculatedBuffer / 50) * 50;
        const floorOverride = waSettings.floorOverride;
        const roundedBuffer = floorOverride !== null && floorOverride !== undefined
            ? Math.ceil(floorOverride / 50) * 50
            : calculatedRounded;
        const usingCustomFloor = floorOverride !== null && floorOverride !== undefined;

        // Run withdrawal algorithm
        const waWithdrawals = [];
        let waLastIdx = -1;
        const WA_MIN_GAP = 3;
        for (let i = 0; i < waProjected.length; i++) {
            if (i - waLastIdx < WA_MIN_GAP && waLastIdx >= 0) continue;
            const day = waProjected[i];
            const availNow = day.opening - roundedBuffer;
            if (availNow < 50) continue;
            let minFuture = availNow;
            for (let j = i + 1; j < waProjected.length; j++) {
                const lowest = Math.min(waProjected[j].opening, waProjected[j].balance);
                const futAvail = lowest - roundedBuffer;
                if (futAvail < minFuture) minFuture = futAvail;
            }
            if (minFuture < 50) continue;
            const amt = Math.floor(minFuture / 50) * 50;
            if (amt < 50) continue;
            waWithdrawals.push({ idx: i, key: rows[i].key, date: rows[i].date, amount: amt, balBefore: day.opening, balAfter: day.opening - amt });
            for (let j = i; j < waProjected.length; j++) {
                waProjected[j].balance -= amt;
                if (j > i) waProjected[j].opening -= amt;
            }
            waLastIdx = i;
        }
        const waByKey = {};
        waWithdrawals.forEach(w => { waByKey[w.key] = w; });
        const waTotalAvailable = waWithdrawals.reduce((s, w) => s + w.amount, 0);

        // Render WA controls below chart, above table
        const waControlsEl = document.getElementById('cfWaControls');
        if (waControlsEl) {
            const balanceWarning = userBal !== null && Math.abs(effectiveOpening - openingBalance) > 200;

            const dayOptions = [0,1,2,3,4,5,6].map(d => {
                const sel = d === COMMIT_DAY ? ' selected' : '';
                return `<option value="${d}"${sel}>${DAY_NAMES_SHORT[d]}</option>`;
            }).join('');

            const floorVal = usingCustomFloor ? floorOverride : calculatedRounded;
            const floorEdited = usingCustomFloor ? ' data-user-edited="1"' : '';

            waControlsEl.innerHTML = `
                <div style="background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:16px;margin:16px 0">
                    <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap">
                        <label style="font-weight:var(--fw-medium);white-space:nowrap">Opening balance:</label>
                        <input type="number" id="waOpeningBal" value="${effectiveOpening.toFixed(2)}"
                            step="0.01"
                            style="width:140px;padding:6px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface)"
                            onchange="this.dataset.userEdited='1';waRecalc()"
                            ${userBal !== null ? 'data-user-edited="1"' : ''}>
                        <span style="color:var(--text-muted);font-size:var(--fs-xs)">Your actual bank balance right now</span>
                        ${waTotalAvailable > 0 ? `<span style="margin-left:auto;font-weight:var(--fw-semibold);color:var(--success)">Safe to withdraw: ${fmt(waTotalAvailable)}</span>` : '<span style="margin-left:auto;color:var(--text-muted);font-size:var(--fs-sm)">No safe withdrawal windows</span>'}
                    </div>

                    ${balanceWarning ? `<div style="padding:8px 12px;background:var(--warning-bg);border-radius:var(--radius-sm);margin-bottom:8px;font-size:var(--fs-xs);color:var(--text-primary)">
                        <strong>Balance mismatch:</strong> Entered balance (${fmt(effectiveOpening)}) differs from dashboard (${fmt(openingBalance)}) by ${fmt(Math.abs(effectiveOpening - openingBalance))}.
                    </div>` : ''}

                    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:var(--fs-sm);color:var(--text-secondary)">
                        <span>Safety floor:</span>
                        <input type="number" id="waFloorOverride" value="${floorVal}"
                            step="50" min="0"
                            style="width:90px;padding:4px 8px;border:1px solid var(--border-default);border-radius:var(--radius-sm);font-size:var(--fs-sm);background:var(--bg-surface)"
                            onchange="this.dataset.userEdited='1';waRecalc()"${floorEdited}>
                        ${usingCustomFloor ? '<button onclick="waResetFloor()" style="font-size:var(--fs-xs);color:var(--accent);background:none;border:none;cursor:pointer;text-decoration:underline">Reset</button>' : ''}
                        <span style="color:var(--border-default)">|</span>
                        <span>Commitments:</span>
                        <input type="number" id="waWagesAmount" value="${WEEKLY_WAGES}"
                            step="10" min="0"
                            style="width:80px;padding:4px 8px;border:1px solid var(--border-default);border-radius:var(--radius-sm);font-size:var(--fs-sm);background:var(--bg-surface)"
                            onchange="this.dataset.userEdited='1';waRecalc()"${waSettings.wages !== undefined ? ' data-user-edited="1"' : ''}>
                        <span>+</span>
                        <input type="number" id="waTopupAmount" value="${WEEKLY_TOPUP}"
                            step="10" min="0"
                            style="width:80px;padding:4px 8px;border:1px solid var(--border-default);border-radius:var(--radius-sm);font-size:var(--fs-sm);background:var(--bg-surface)"
                            onchange="this.dataset.userEdited='1';waRecalc()"${waSettings.topup !== undefined ? ' data-user-edited="1"' : ''}>
                        <span>on</span>
                        <select id="waCommitDay"
                            style="padding:4px 8px;border:1px solid var(--border-default);border-radius:var(--radius-sm);font-size:var(--fs-sm);background:var(--bg-surface)"
                            onchange="this.dataset.userEdited='1';waRecalc()"${waSettings.commitDay !== undefined ? ' data-user-edited="1"' : ''}>
                            ${dayOptions}
                        </select>
                    </div>
                </div>
            `;
        }

        // Table
        const tbody = document.getElementById('cashflowBody');
        tbody.innerHTML = rows.map((r, i) => {
            const wknd = isWeekend(r.date) ? ' weekend' : '';
            const closingClass = r.closing < 0 ? 'text-red' : r.closing < 500 ? 'text-amber' : 'text-green';
            const w = waByKey[r.key];

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
                    const excluded = !checked;
                    return `<div class="cashflow-detail-item in" style="${excluded ? 'opacity:0.5' : ''}"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1"><input type="checkbox" data-cf-key="${cbId}" data-row="${i}" data-fi="${fi}" data-dir="in" ${checked} onchange="toggleCFExclusion(this.dataset.cfKey)"><span class="cashflow-detail-item-name" style="flex:1;${excluded ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">${escHtml(f.name)}${acctTag(f.account)}</span></label><span class="cashflow-detail-item-value" style="${excluded ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">+${fmt(f.amount)}</span></div>`;
                }).join('')
                : '<div class="cashflow-detail-item"><em>None</em></div>';
            const outflowsHtml = r.outflows.length > 0
                ? r.outflows.map((f, fi) => {
                    if (f.cleared) {
                        return `<div class="cashflow-detail-item out" style="opacity:0.5"><span class="cashflow-detail-item-name" style="flex:1;color:var(--text-muted)">${escHtml(f.name)}${reconBadge}${acctTag(f.account)}</span><span class="cashflow-detail-item-value" style="text-decoration:line-through;color:var(--text-muted)">-${fmt(f.amount)}</span></div>`;
                    }
                    const cbId = cfStableKey(r.key, 'out', f.name, f.amount);
                    const checked = !isCFExcluded(cbId) ? 'checked' : '';
                    const excluded = !checked;
                    return `<div class="cashflow-detail-item out" style="${excluded ? 'opacity:0.5' : ''}"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex:1"><input type="checkbox" data-cf-key="${cbId}" data-row="${i}" data-fi="${fi}" data-dir="out" ${checked} onchange="toggleCFExclusion(this.dataset.cfKey)"><span class="cashflow-detail-item-name" style="flex:1;${excluded ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">${escHtml(f.name)}${acctTag(f.account)}</span></label><span class="cashflow-detail-item-value" style="${excluded ? 'text-decoration:line-through;color:var(--text-muted)' : ''}">-${fmt(f.amount)}</span></div>`;
                }).join('')
                : '<div class="cashflow-detail-item"><em>None</em></div>';

            const dayAccounts = new Set();
            r.inflows.forEach(f => { if (f.account) dayAccounts.add(f.account); });
            r.outflows.forEach(f => { if (f.account) dayAccounts.add(f.account); });
            const acctSummary = dayAccounts.size > 0
                ? [...dayAccounts].map(a => escHtml(a)).join(', ')
                : '';

            const withdrawCell = w
                ? `<span style="color:var(--accent);font-weight:var(--fw-semibold)">${fmt(w.amount)}</span>`
                : '';

            const waDay = waProjected[i];
            const afterWdBalance = waDay ? waDay.balance : r.closing;
            const afterWdClass = afterWdBalance < 0 ? 'text-red' : afterWdBalance < 500 ? 'text-amber' : '';
            const afterWdDiffers = Math.abs(afterWdBalance - r.closing) > 0.01;

            return `
                <tr class="cashflow-row${wknd}" onclick="toggleCashflowRow('cfrow-${i}', this)">
                    <td><span class="expand-chevron" id="cf-chev-${i}">▶</span><strong>${dayName(r.date)}</strong></td>
                    <td>${fmtAccounting(r.opening)}</td>
                    <td class="text-green">${r.dayIn > 0 ? '+' + fmt(r.dayIn) : ''}</td>
                    <td class="text-red">${r.dayOut > 0 ? '-' + fmt(r.dayOut) : ''}</td>
                    <td class="${closingClass}"><strong>${fmtAccounting(r.closing)}</strong></td>
                    <td class="${afterWdClass}" style="${afterWdDiffers ? 'font-weight:var(--fw-medium)' : 'color:var(--text-muted)'}">${fmtAccounting(afterWdBalance)}</td>
                    <td>${withdrawCell}</td>
                    <td class="od-text-muted-sm" style="white-space:nowrap">${acctSummary}</td>
                </tr>
                <tr class="cashflow-table-row-detail" id="cfrow-${i}">
                    <td colspan="8"><div class="expand-content"><div class="cashflow-detail-list">
                        <div style="margin-bottom:8px;"><strong>Inflows</strong> <span style="font-weight:normal;font-size:var(--fs-xs);color:var(--text-muted)">(tick = expected, untick = cleared)</span></div>
                        ${inflowsHtml}
                        <div style="margin-top:8px;margin-bottom:8px;"><strong>Outflows:</strong></div>
                        ${outflowsHtml}
                        ${w ? `<div style="margin-top:8px;padding:6px 8px;background:var(--accent-soft);border-radius:var(--radius-sm);font-size:var(--fs-xs);color:var(--accent)"><strong>Withdrawal window:</strong> ${fmt(w.amount)} safe to take (balance after: ${fmt(w.balAfter)})</div>` : ''}
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
                <td></td>
            </tr>
            <tr style="background:var(--bg-surface-2);font-size:0.8rem;color:var(--text-secondary)">
                <td colspan="8" style="padding:8px 12px;line-height:1.6">
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

        // Chart: green = best case (fixed costs only), red = worst case (after reserves), shaded band, orange = what-if
        if (cashflowChartInstance) cashflowChartInstance.destroy();
        const ctx = document.getElementById('cashflowChart');
        cashflowChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: chartLabels,
                datasets: [{
                    label: 'Best Case (Fixed Costs Only)',
                    data: chartData,
                    borderColor: successColor,
                    backgroundColor: 'rgba(22, 163, 74, 0.10)',
                    borderWidth: 2,
                    fill: '+1',
                    tension: 0.4,
                    pointRadius: 3,
                    pointBackgroundColor: successColor,
                    pointBorderColor: surfaceColor,
                    pointBorderWidth: 2,
                    pointHoverRadius: 6,
                }, {
                    label: 'Worst Case (Incl. Variable Reserves)',
                    data: chartDataWorstCase,
                    borderColor: dangerColor,
                    backgroundColor: 'rgba(220, 38, 38, 0.04)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.4,
                    pointRadius: 3,
                    pointBackgroundColor: dangerColor,
                    pointBorderColor: surfaceColor,
                    pointBorderWidth: 2,
                    pointHoverRadius: 6,
                }, {
                    label: 'What-If (Excludes Unchecked + Wages)',
                    data: whatIfData,
                    borderColor: warningColor,
                    backgroundColor: 'rgba(217, 119, 6, 0.05)',
                    borderWidth: 2,
                    borderDash: [4, 4],
                    fill: false,
                    tension: 0.4,
                    pointRadius: 3,
                    pointBackgroundColor: warningColor,
                    pointBorderColor: surfaceColor,
                    pointBorderWidth: 2,
                    pointHoverRadius: 6,
                    hidden: !hasAnyExclusions(),
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
        // ── Credit Card Summary ──
        const ccEl = document.getElementById('creditCardSummary');
        if (ccEl && creditCards && creditCards.length > 0) {
            const totalCCDebt = creditCards.reduce((s, c) => s + c.owed, 0);
            const monthlySurplus = netChangeLow > 0 ? netChangeLow : 0;

            const ccRows = creditCards.filter(c => c.owed > 0.01).map(c => {
                const d = c.dueDay;
                const lastTwo = d % 100;
                const last = d % 10;
                const suffix = (lastTwo >= 11 && lastTwo <= 13) ? 'th'
                    : last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
                const monthsToClear = monthlySurplus > 0 ? Math.ceil(c.owed / monthlySurplus) : null;
                const projectionText = monthsToClear !== null
                    ? `~${monthsToClear} month${monthsToClear !== 1 ? 's' : ''} to clear`
                    : 'No surplus to project';
                return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border-subtle);font-size:var(--fs-sm)">
                    <span style="flex:1">${escHtml(c.name)} <span style="color:var(--text-muted);font-size:var(--fs-xs)">(due ${d}${suffix})</span></span>
                    <span style="width:100px;text-align:right;font-weight:var(--fw-semibold);color:${c.owed > 5000 ? 'var(--danger)' : 'var(--warning)'}">${fmt(c.owed)}</span>
                    <span style="width:160px;text-align:right;font-size:var(--fs-xs);color:var(--text-secondary)">${projectionText}</span>
                </div>`;
            }).join('');

            const totalMonths = monthlySurplus > 0 ? Math.ceil(totalCCDebt / monthlySurplus) : null;
            const totalProjection = totalMonths !== null
                ? `At current surplus of ${fmt(monthlySurplus)}/month, total debt clears in ~${totalMonths} month${totalMonths !== 1 ? 's' : ''}.`
                : 'No monthly surplus available to project clearance timeline.';

            ccEl.innerHTML = `
                <div style="margin-top:20px;padding:16px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-md)">
                    <div style="font-weight:var(--fw-semibold);margin-bottom:8px;color:var(--text-primary)">Credit Card Balances <span style="font-weight:var(--fw-regular);color:var(--text-secondary)">Total: ${fmt(totalCCDebt)}</span></div>
                    ${ccRows}
                    <div style="margin-top:10px;font-size:var(--fs-xs);color:var(--text-secondary)">${totalProjection}</div>
                </div>
            `;
        } else if (ccEl) {
            ccEl.innerHTML = '';
        }

        // Store all args so waRecalc can trigger a full rebuild
        window._cfBuildArgs = {
            today, openingBalance, incomeTenancies, activeCostsList,
            allTenancies, transactions, monthlyIncome, tenancyIsUC, creditCards
        };
        window._waRows = rows;
        window._waDashboardOpening = openingBalance;
        window._waTransactions = transactions;
        window._waIncomeTenancies = incomeTenancies;

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
        waRecalc();
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


    // ══════════════════════════════════════════
    // WITHDRAWAL ADVISOR
    // ══════════════════════════════════════════

    function getCalcStateDate() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

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
        const state = {
            date: getCalcStateDate(),
            openingBal: balInput ? balInput.value : '',
            userEditedBal: balInput ? !!balInput.dataset.userEdited : false,
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

    function waRecalc() {
        saveWAState();
        if (window._cfBuildArgs) {
            const a = window._cfBuildArgs;
            buildCashFlow(a.today, a.openingBalance, a.incomeTenancies, a.activeCostsList,
                a.allTenancies, a.transactions, a.monthlyIncome, a.tenancyIsUC, a.creditCards);
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
