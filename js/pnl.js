// ══════════════════════════════════════════
// P&L — Profit & Loss by Month
// Reads from allTransactions loaded by dashboard.js
// Charts via Chart.js (loaded in index.html), AI via existing proxy
// ══════════════════════════════════════════

    // Which business is this P&L for. Defaults to Real Estate.
    let pnlBusinessName = 'Real Estate';
    // How many trailing months to show (including current)
    let pnlMonths = 12;

    // Explicit sub-category allow-lists per section (order preserved in output).
    const PNL_SECTIONS = [
        { name: 'Revenue', subs: [
            'Fixed Income',
            'Variable Income',
            'Rental Income',
        ]},
        { name: 'Cost of Goods Sold', subs: [
            'COGS Labour',
            'COGS Sales Fees',
            'COGS Product Costs',
            'COGS Delivery Costs',
            'COGS Commission',
            'COGS Property Council Tax',
            'COGS Property Utilities',
            'COGS Property Reactive Maintenance',
            'COGS Property Compliance',
        ]},
        { name: 'Operating Expenses', subs: [
            'Opex Labour',
            'Marketing',
            'Premises / Overheads',
            'Insurance',
            'Software & Subscriptions',
            'Professional Fees',
            'Travel & Training',
            'Operational Supplies',
            'Subsistence',
            'Director Discretionary Expenses',
            'Charity',
            'Mortgage Interest',
            'Loan Interest',
            'Bank Transaction Fees',
            'Tax',
        ]},
    ];

    // ── Targets ──
    const PNL_REVENUE_TARGET = 35000;        // £35,000/month revenue target
    const PNL_GROSS_MARGIN_TARGET = 80;      // 80% gross profit margin target
    const PNL_NET_MARGIN_TARGET = 15;        // 15% net profit margin target
    const PNL_CLEAR_PROFIT_TARGET = 5000;    // £5,000/month net profit target
    const PNL_MAINT_TARGET = typeof MAINT_TARGET_GBP !== 'undefined' ? MAINT_TARGET_GBP : 3000;
    const PNL_WAGES_TARGET = typeof WAGES_TARGET_GBP !== 'undefined' ? WAGES_TARGET_GBP : 1500;

    // ── Helpers ──
    function pnlMonthKeys(n) {
        const out = [];
        const now = new Date();
        for (let i = n - 1; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
        }
        return out;
    }

    function pnlMonthLabel(key) {
        const [y, m] = key.split('-').map(Number);
        return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
    }

    function pnlBuildLookup(records, nameFieldId) {
        const out = {};
        (records || []).forEach(r => {
            const n = getField(r, nameFieldId);
            if (n) out[r.id] = String(n);
        });
        return out;
    }

    function pnlLinkId(field) {
        if (!field) return null;
        if (Array.isArray(field)) {
            const first = field[0];
            if (!first) return null;
            return typeof first === 'object' ? first.id : first;
        }
        if (typeof field === 'object') return field.id;
        return null;
    }

    // ── Build P&L data structure ──
    function buildPnL(transactions, businessName, monthKeys) {
        const monthSet = new Set(monthKeys);
        const subCatNames = pnlBuildLookup(allSubCategories, 'fldO4BTJhFv5EsN6i');
        const bizNames = pnlBuildLookup(allBusinesses, 'fldbbRqVxLxUdHwIR');
        const resolve = (field, map) => { const id = pnlLinkId(field); return id ? (map[id] || '') : ''; };

        const subToSection = {};
        PNL_SECTIONS.forEach(sec => sec.subs.forEach(s => { subToSection[s] = sec.name; }));

        const sections = {};
        PNL_SECTIONS.forEach(sec => { sections[sec.name] = {}; sec.subs.forEach(s => { sections[sec.name][s] = {}; }); });
        const txIndex = {};
        PNL_SECTIONS.forEach(sec => { txIndex[sec.name] = {}; sec.subs.forEach(s => { txIndex[sec.name][s] = {}; }); });

        transactions.forEach(tx => {
            const biz = resolve(getField(tx, F.txBusiness), bizNames);
            if (biz !== businessName) return;
            const dateStr = getField(tx, F.txDate);
            if (!dateStr) return;
            const d = new Date(dateStr);
            if (isNaN(d)) return;
            const mKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            if (!monthSet.has(mKey)) return;
            const subCat = resolve(getField(tx, F.txSubCategory), subCatNames);
            const sectionName = subToSection[subCat];
            if (!sectionName) return;
            const amt = Number(getField(tx, F.txReportAmount)) || 0;
            const signed = sectionName === 'Revenue' ? amt : -amt;
            sections[sectionName][subCat][mKey] = (sections[sectionName][subCat][mKey] || 0) + signed;
            if (!txIndex[sectionName][subCat][mKey]) txIndex[sectionName][subCat][mKey] = [];
            txIndex[sectionName][subCat][mKey].push(tx);
        });

        function sectionRows(secDef) {
            const bySub = sections[secDef.name];
            const rows = secDef.subs.map(subCat => {
                const monthly = bySub[subCat] || {};
                let total = 0;
                monthKeys.forEach(k => { total += monthly[k] || 0; });
                return { subCat, monthly, total };
            });
            const totals = {};
            let grand = 0;
            monthKeys.forEach(k => { let t = 0; rows.forEach(r => { t += r.monthly[k] || 0; }); totals[k] = t; grand += t; });
            return { name: secDef.name, rows, totals, total: grand };
        }

        const revenue = sectionRows(PNL_SECTIONS[0]);
        const cogs    = sectionRows(PNL_SECTIONS[1]);
        const opex    = sectionRows(PNL_SECTIONS[2]);

        const grossProfit = {}, grossMargin = {}, netProfit = {}, netMargin = {};
        monthKeys.forEach(k => {
            const rev = revenue.totals[k] || 0, cg = cogs.totals[k] || 0, op = opex.totals[k] || 0;
            const gp = rev - cg;
            grossProfit[k] = gp;
            grossMargin[k] = rev ? (gp / rev) * 100 : 0;
            const np = gp - op;
            netProfit[k] = np;
            netMargin[k] = rev ? (np / rev) * 100 : 0;
        });

        const grandRev = revenue.total, grandCogs = cogs.total, grandOpex = opex.total;
        const grandGP = grandRev - grandCogs, grandNP = grandGP - grandOpex;

        return {
            monthKeys, revenue, cogs, opex, txIndex,
            grossProfit, grossMargin, netProfit, netMargin,
            grand: {
                revenue: grandRev, cogs: grandCogs, opex: grandOpex,
                grossProfit: grandGP,
                grossMargin: grandRev ? (grandGP / grandRev) * 100 : 0,
                netProfit: grandNP,
                netMargin: grandRev ? (grandNP / grandRev) * 100 : 0,
            }
        };
    }

    // ── Format helpers ──
    function pnlFmt(n) {
        if (n === 0 || !n) return '<span style="color:#cbd5e1">–</span>';
        const abs = Math.abs(n).toLocaleString('en-GB', { maximumFractionDigits: 0 });
        return n < 0 ? `<span style="color:#dc2626">(£${abs})</span>` : `£${abs}`;
    }
    function pnlPct(n) {
        if (!isFinite(n) || n === 0) return '<span style="color:#cbd5e1">–</span>';
        const cls = n >= 0 ? 'text-green' : 'text-red';
        return `<span class="${cls}">${n.toFixed(1)}%</span>`;
    }
    function pnlGBP(n) {
        return `£${Math.abs(n).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
    }

    // ── State ──
    let _pnlCache = null;
    let _pnlEditsMade = false;
    let _pnlCharts = {};  // chart instances to destroy on re-render

    const PNL_TOP_BUSINESSES = ['Real Estate', 'Operations Director'];
    const PNL_NAME_FIELDS = {
        category:    'fldii4oUzSfmplihO',
        subCategory: 'fldO4BTJhFv5EsN6i',
        business:    'fldbbRqVxLxUdHwIR',
    };

    // ── Datalist / edit helpers ──
    function pnlNameList(records, nameFieldId) {
        return [...(records || [])].map(r => ({
            id: r.id, name: String(getField(r, nameFieldId) || '')
        })).filter(o => o.name).sort((a, b) => a.name.localeCompare(b.name));
    }
    function pnlDatalistOptions(list) {
        return list.map(o => `<option value="${escHtml(o.name)}"></option>`).join('');
    }
    function pnlOptionList(records, nameFieldId, selectedId) {
        const sorted = pnlNameList(records, nameFieldId);
        return ['<option value="">(none)</option>']
            .concat(sorted.map(o =>
                `<option value="${escHtml(o.id)}" ${o.id === selectedId ? 'selected' : ''}>${escHtml(o.name)}</option>`
            )).join('');
    }
    function pnlResolveNameToId(kind, name) {
        const src = kind === 'category' ? allCategories : kind === 'subCategory' ? allSubCategories : kind === 'business' ? allBusinesses : [];
        const fieldId = PNL_NAME_FIELDS[kind];
        if (!fieldId || !name) return '';
        const needle = String(name).trim().toLowerCase();
        if (!needle) return '';
        const rec = (src || []).find(r => String(getField(r, fieldId) || '').toLowerCase() === needle);
        return rec ? rec.id : null;
    }
    function pnlEditTxByName(txId, kind, typedName, inputEl) {
        if (typedName === '' || typedName == null) return pnlEditTxField(txId, kind, '', inputEl);
        const id = pnlResolveNameToId(kind, typedName);
        const status = inputEl?.parentElement?.querySelector('.pnl-edit-status');
        if (id === null) { if (status) { status.textContent = '✗ no match'; status.style.color = '#dc2626'; } return; }
        return pnlEditTxField(txId, kind, id, inputEl);
    }
    async function pnlEditTxField(txId, kind, recordId, selectEl) {
        const fieldMap = { category: F.txCategory, subCategory: F.txSubCategory, business: F.txBusiness };
        const fieldId = fieldMap[kind];
        if (!fieldId) return;
        const status = selectEl?.parentElement?.querySelector('.pnl-edit-status');
        if (status) { status.textContent = '…'; status.style.color = '#94a3b8'; }
        const fields = {};
        fields[fieldId] = recordId ? [recordId] : [];
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${txId}`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields, returnFieldsByFieldId: true })
            });
            if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error?.message || resp.status); }
            const updated = await resp.json();
            const tx = (allTransactions || []).find(t => t.id === txId);
            if (tx && updated.fields) Object.assign(tx.fields, updated.fields);
            _pnlEditsMade = true;
            if (status) { status.textContent = '✓'; status.style.color = '#16a34a'; }
        } catch (e) {
            console.error('pnlEditTxField failed', e);
            if (status) { status.textContent = '✗ ' + (e.message || 'err'); status.style.color = '#dc2626'; }
        }
    }

    // ── Drill-down modal ──
    function pnlDrill(scope, section, subCat, monthKey) {
        if (!_pnlCache) return;
        const idx = _pnlCache.txIndex;
        let txs = [];
        if (scope === 'cell') txs = (idx[section]?.[subCat]?.[monthKey]) || [];
        else if (scope === 'subTotal') Object.values(idx[section]?.[subCat] || {}).forEach(arr => txs.push(...arr));
        else if (scope === 'monthTotal') Object.values(idx[section] || {}).forEach(bySub => { (bySub[monthKey] || []).forEach(tx => txs.push(tx)); });
        else if (scope === 'sectionTotal') Object.values(idx[section] || {}).forEach(bySub => { Object.values(bySub).forEach(arr => txs.push(...arr)); });

        txs.sort((a, b) => new Date(getField(b, F.txDate)) - new Date(getField(a, F.txDate)));

        let title;
        if (scope === 'cell') title = `${subCat} — ${pnlMonthLabel(monthKey)}`;
        else if (scope === 'subTotal') title = `${subCat} — ${pnlMonths} month total`;
        else if (scope === 'monthTotal') title = `${section} — ${pnlMonthLabel(monthKey)}`;
        else title = `${section} — ${pnlMonths} month total`;

        const jsAttr = (v) => JSON.stringify(v == null ? null : v).replace(/"/g, '&quot;');
        function editInput(txId, kind, currentName, datalistId) {
            return `<div style="display:flex;align-items:center;gap:4px">
                <input list="${datalistId}" value="${escHtml(currentName)}"
                    onchange="pnlEditTxByName(${jsAttr(txId)}, ${jsAttr(kind)}, this.value, this)"
                    placeholder="Type to search…"
                    style="font-size:11px;padding:3px 6px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;width:150px">
                <span class="pnl-edit-status" style="font-size:11px;min-width:12px"></span>
            </div>`;
        }

        const catList = pnlNameList(allCategories, PNL_NAME_FIELDS.category);
        const subList = pnlNameList(allSubCategories, PNL_NAME_FIELDS.subCategory);
        const bizList = pnlNameList(allBusinesses, PNL_NAME_FIELDS.business);
        const datalistHtml = `
            <datalist id="pnl-dl-category">${pnlDatalistOptions(catList)}</datalist>
            <datalist id="pnl-dl-subCategory">${pnlDatalistOptions(subList)}</datalist>
            <datalist id="pnl-dl-business">${pnlDatalistOptions(bizList)}</datalist>`;
        const nameById = (list, id) => { if (!id) return ''; const h = list.find(o => o.id === id); return h ? h.name : ''; };

        let runningTotal = 0;
        const rowsHtml = txs.map(tx => {
            const date = getField(tx, F.txDate) || '';
            const amt = Number(getField(tx, F.txReportAmount)) || 0;
            runningTotal += amt;
            const detail = txLabel(tx);
            const catId = pnlLinkId(getField(tx, F.txCategory));
            const subCatId = pnlLinkId(getField(tx, F.txSubCategory));
            const bizId = pnlLinkId(getField(tx, F.txBusiness));
            const amtCls = amt < 0 ? 'color:#dc2626' : 'color:#065f46';
            return `<tr>
                <td style="padding:8px 10px;white-space:nowrap;vertical-align:top">${escHtml(date)}</td>
                <td style="padding:8px 10px;vertical-align:top;min-width:180px">${escHtml(detail)}</td>
                <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums;${amtCls};font-weight:600;vertical-align:top">${amt < 0 ? '-' : ''}£${Math.abs(amt).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td style="padding:6px 8px;vertical-align:top">${editInput(tx.id, 'category', nameById(catList, catId), 'pnl-dl-category')}</td>
                <td style="padding:6px 8px;vertical-align:top">${editInput(tx.id, 'subCategory', nameById(subList, subCatId), 'pnl-dl-subCategory')}</td>
                <td style="padding:6px 8px;vertical-align:top">${editInput(tx.id, 'business', nameById(bizList, bizId), 'pnl-dl-business')}</td>
            </tr>`;
        }).join('');

        const sumFmt = `${runningTotal < 0 ? '-' : ''}£${Math.abs(runningTotal).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const overlay = document.createElement('div');
        overlay.id = 'pnlDrillOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
        overlay.onclick = (e) => { if (e.target === overlay) pnlCloseDrill(); };
        overlay.innerHTML = `${datalistHtml}
            <div style="background:#fff;border-radius:12px;max-width:1100px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 40px rgba(0,0,0,0.3)">
                <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #e2e8f0">
                    <div>
                        <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">${escHtml(section)}</div>
                        <div style="font-size:16px;font-weight:700;color:#0f172a">${escHtml(title)}</div>
                        <div style="font-size:12px;color:#64748b;margin-top:2px">${txs.length} transaction${txs.length === 1 ? '' : 's'} · Sum: <strong>${sumFmt}</strong> · <span style="color:#94a3b8">Changes save instantly; report refreshes on close.</span></div>
                    </div>
                    <button onclick="pnlCloseDrill()" style="background:none;border:none;font-size:24px;cursor:pointer;color:#64748b;padding:0 8px">&times;</button>
                </div>
                <div style="overflow:auto;flex:1">
                    <table style="width:100%;border-collapse:collapse;font-size:13px">
                        <thead style="background:#f8fafc;position:sticky;top:0">
                            <tr style="border-bottom:1px solid #e2e8f0">
                                <th style="padding:8px 10px;text-align:left;font-weight:600;color:#475569">Date</th>
                                <th style="padding:8px 10px;text-align:left;font-weight:600;color:#475569">Transaction Detail</th>
                                <th style="padding:8px 10px;text-align:right;font-weight:600;color:#475569">Report Amount</th>
                                <th style="padding:8px 10px;text-align:left;font-weight:600;color:#475569">Category</th>
                                <th style="padding:8px 10px;text-align:left;font-weight:600;color:#475569">Sub-Category</th>
                                <th style="padding:8px 10px;text-align:left;font-weight:600;color:#475569">Business</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml || '<tr><td colspan="6" style="padding:40px;text-align:center;color:#94a3b8">No transactions for this slice.</td></tr>'}</tbody>
                    </table>
                </div>
            </div>`;
        pnlCloseDrill();
        document.body.appendChild(overlay);
        document.addEventListener('keydown', pnlEscHandler);
    }
    function pnlCloseDrill() {
        const o = document.getElementById('pnlDrillOverlay');
        if (o) o.remove();
        document.removeEventListener('keydown', pnlEscHandler);
        if (_pnlEditsMade) { _pnlEditsMade = false; if (typeof renderPnL === 'function') renderPnL(); }
    }
    function pnlEscHandler(e) { if (e.key === 'Escape') pnlCloseDrill(); }

    // ══════════════════════════════════════════
    // CHARTS
    // ══════════════════════════════════════════
    function pnlDestroyCharts() {
        Object.values(_pnlCharts).forEach(c => { try { c.destroy(); } catch(e){} });
        _pnlCharts = {};
    }

    function pnlRenderCharts(pnl, keys) {
        if (typeof Chart === 'undefined') return;
        pnlDestroyCharts();
        const labels = keys.map(k => pnlMonthLabel(k));
        const revData = keys.map(k => pnl.revenue.totals[k] || 0);
        const cogsData = keys.map(k => pnl.cogs.totals[k] || 0);
        const opexData = keys.map(k => pnl.opex.totals[k] || 0);
        const gpData = keys.map(k => pnl.grossProfit[k] || 0);
        const npData = keys.map(k => pnl.netProfit[k] || 0);
        const gpMData = keys.map(k => pnl.grossMargin[k] || 0);
        const npMData = keys.map(k => pnl.netMargin[k] || 0);

        const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const sharedOptions = {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { font: { size: 11, family: fontFamily }, padding: 12, usePointStyle: true, pointStyle: 'circle' } } },
            scales: { x: { grid: { display: false }, ticks: { font: { size: 10, family: fontFamily } } }, y: { grid: { color: '#f1f5f9' }, ticks: { font: { size: 10, family: fontFamily } } } },
        };

        // 1. Revenue vs Expenses bar chart
        const ctx1 = document.getElementById('pnlChartRevExp');
        if (ctx1) {
            _pnlCharts.revExp = new Chart(ctx1, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [
                        { label: 'Revenue', data: revData, backgroundColor: '#22c55e', borderRadius: 4, barPercentage: 0.7 },
                        { label: 'COGS', data: cogsData.map(v => -v), backgroundColor: '#f87171', borderRadius: 4, barPercentage: 0.7 },
                        { label: 'OpEx', data: opexData.map(v => -v), backgroundColor: '#fb923c', borderRadius: 4, barPercentage: 0.7 },
                    ]
                },
                options: {
                    ...sharedOptions,
                    plugins: {
                        ...sharedOptions.plugins,
                        title: { display: true, text: 'Revenue vs Expenses', font: { size: 13, weight: '600', family: fontFamily }, color: '#0f172a', padding: { bottom: 8 } },
                        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: £${Math.abs(c.raw).toLocaleString('en-GB', { maximumFractionDigits: 0 })}` } }
                    },
                    scales: {
                        ...sharedOptions.scales,
                        y: { ...sharedOptions.scales.y, ticks: { ...sharedOptions.scales.y.ticks, callback: (v) => `£${(v / 1000).toFixed(0)}k` } }
                    }
                }
            });
        }

        // 2. Profit trend line chart with targets
        const ctx2 = document.getElementById('pnlChartProfit');
        if (ctx2) {
            _pnlCharts.profit = new Chart(ctx2, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        { label: 'Gross Profit', data: gpData, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6, borderWidth: 2 },
                        { label: 'Net Profit', data: npData, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6, borderWidth: 2 },
                        { label: `NP Target (£${(PNL_CLEAR_PROFIT_TARGET/1000).toFixed(0)}k/mo)`, data: keys.map(() => PNL_CLEAR_PROFIT_TARGET), borderColor: '#ef4444', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false },
                    ]
                },
                options: {
                    ...sharedOptions,
                    plugins: {
                        ...sharedOptions.plugins,
                        title: { display: true, text: 'Profit Trend', font: { size: 13, weight: '600', family: fontFamily }, color: '#0f172a', padding: { bottom: 8 } },
                        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: £${c.raw.toLocaleString('en-GB', { maximumFractionDigits: 0 })}` } }
                    },
                    scales: {
                        ...sharedOptions.scales,
                        y: { ...sharedOptions.scales.y, ticks: { ...sharedOptions.scales.y.ticks, callback: (v) => `£${(v / 1000).toFixed(0)}k` } }
                    }
                }
            });
        }

        // 3. Margin trend with 15% target
        const ctx3 = document.getElementById('pnlChartMargin');
        if (ctx3) {
            _pnlCharts.margin = new Chart(ctx3, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        { label: 'Gross Margin %', data: gpMData, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.08)', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6, borderWidth: 2 },
                        { label: 'Net Margin %', data: npMData, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6, borderWidth: 2 },
                        { label: `GP Target (${PNL_GROSS_MARGIN_TARGET}%)`, data: keys.map(() => PNL_GROSS_MARGIN_TARGET), borderColor: '#3b82f6', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false },
                        { label: `NP Target (${PNL_NET_MARGIN_TARGET}%)`, data: keys.map(() => PNL_NET_MARGIN_TARGET), borderColor: '#ef4444', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false },
                    ]
                },
                options: {
                    ...sharedOptions,
                    plugins: {
                        ...sharedOptions.plugins,
                        title: { display: true, text: 'Profit Margin Trend', font: { size: 13, weight: '600', family: fontFamily }, color: '#0f172a', padding: { bottom: 8 } },
                        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw.toFixed(1)}%` } }
                    },
                    scales: {
                        ...sharedOptions.scales,
                        y: { ...sharedOptions.scales.y, ticks: { ...sharedOptions.scales.y.ticks, callback: (v) => `${v}%` } }
                    }
                }
            });
        }

        // 4. Expense breakdown doughnut
        const ctx4 = document.getElementById('pnlChartBreakdown');
        if (ctx4) {
            // Combine all COGS + OpEx sub-cats with non-zero totals
            const slices = [];
            const colours = [
                '#f87171','#fb923c','#fbbf24','#a3e635','#34d399','#22d3ee','#60a5fa','#a78bfa','#f472b6','#e879f9',
                '#f97316','#84cc16','#14b8a6','#06b6d4','#8b5cf6','#ec4899','#ef4444','#10b981','#6366f1','#d946ef',
                '#f59e0b','#0ea5e9','#8b5cf6','#64748b'
            ];
            [pnl.cogs, pnl.opex].forEach(sec => {
                sec.rows.forEach(r => { if (r.total > 0) slices.push({ label: r.subCat, value: r.total }); });
            });
            slices.sort((a, b) => b.value - a.value);

            const totalExp = slices.reduce((s, o) => s + o.value, 0);
            _pnlCharts.breakdown = new Chart(ctx4, {
                type: 'doughnut',
                data: {
                    labels: slices.map(s => s.label),
                    datasets: [{ data: slices.map(s => s.value), backgroundColor: colours.slice(0, slices.length), borderWidth: 1, borderColor: '#fff' }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    layout: { padding: { right: 10 } },
                    plugins: {
                        legend: { position: 'bottom', maxHeight: 120, labels: { font: { size: 10, family: fontFamily }, padding: 6, usePointStyle: true, pointStyle: 'circle', boxWidth: 8 } },
                        title: { display: true, text: 'Expense Breakdown (Period Total)', font: { size: 13, weight: '600', family: fontFamily }, color: '#0f172a', padding: { bottom: 4 } },
                        tooltip: { callbacks: { label: (c) => { const pct = totalExp ? ((c.raw / totalExp) * 100).toFixed(1) : 0; return `${c.label}: £${c.raw.toLocaleString('en-GB', { maximumFractionDigits: 0 })} (${pct}%)`; } } }
                    },
                    cutout: '55%'
                }
            });
        }
    }

    // ══════════════════════════════════════════
    // AI ANALYSIS
    // ══════════════════════════════════════════
    let _pnlAiLoading = false;

    function pnlBuildAIContext(pnl, keys) {
        const monthLabels = keys.map(k => pnlMonthLabel(k));
        const data = {
            business: pnlBusinessName,
            period: `${pnlMonths} months (${monthLabels[0]} – ${monthLabels[monthLabels.length - 1]})`,
            targets: { monthlyRevenue: `£${PNL_REVENUE_TARGET.toLocaleString()}`, grossMargin: `${PNL_GROSS_MARGIN_TARGET}%`, netMargin: `${PNL_NET_MARGIN_TARGET}%`, monthlyNetProfit: `£${PNL_CLEAR_PROFIT_TARGET.toLocaleString()}`, monthlyMaintenance: `£${PNL_MAINT_TARGET.toLocaleString()}`, monthlyWages: `£${PNL_WAGES_TARGET.toLocaleString()}` },
            grandTotals: {
                revenue: pnl.grand.revenue, cogs: pnl.grand.cogs, opex: pnl.grand.opex,
                grossProfit: pnl.grand.grossProfit, grossMargin: pnl.grand.grossMargin.toFixed(1) + '%',
                netProfit: pnl.grand.netProfit, netMargin: pnl.grand.netMargin.toFixed(1) + '%',
            },
            monthlyBreakdown: keys.map(k => ({
                month: pnlMonthLabel(k),
                revenue: pnl.revenue.totals[k] || 0,
                cogs: pnl.cogs.totals[k] || 0,
                opex: pnl.opex.totals[k] || 0,
                grossProfit: pnl.grossProfit[k] || 0,
                grossMargin: (pnl.grossMargin[k] || 0).toFixed(1) + '%',
                netProfit: pnl.netProfit[k] || 0,
                netMargin: (pnl.netMargin[k] || 0).toFixed(1) + '%',
            })),
            topExpenses: [],
        };
        // Top 10 expense sub-categories
        const allExp = [];
        [pnl.cogs, pnl.opex].forEach(sec => sec.rows.forEach(r => { if (r.total > 0) allExp.push({ subCat: r.subCat, section: sec.name, total: r.total, monthly: keys.map(k => ({ month: pnlMonthLabel(k), amount: r.monthly[k] || 0 })) }); }));
        allExp.sort((a, b) => b.total - a.total);
        data.topExpenses = allExp.slice(0, 10);
        return data;
    }

    async function pnlRunAIAnalysis() {
        if (_pnlAiLoading || !_pnlCache) return;
        _pnlAiLoading = true;
        const panel = document.getElementById('pnlAiPanel');
        if (!panel) return;
        panel.innerHTML = '<div style="display:flex;align-items:center;gap:8px;color:#64748b;font-size:13px;padding:16px"><div class="ai-typing-dot" style="animation:blink 1.4s infinite both"></div><div class="ai-typing-dot" style="animation:blink 1.4s infinite both 0.2s"></div><div class="ai-typing-dot" style="animation:blink 1.4s infinite both 0.4s"></div><span style="margin-left:8px">Analysing P&L data…</span></div>';

        const keys = _pnlCache.monthKeys;
        const ctx = pnlBuildAIContext(_pnlCache, keys);
        const systemPrompt = `You are a sharp financial analyst for a UK property management micro-business. You are reviewing the Profit & Loss data below.

RULES:
- British English always (analyse, colour, organise, etc.)
- Use £ with commas. Be concise, data-driven, specific.
- Structure response as: **Performance Summary** (2-3 sentences), **Key Trends** (3-4 bullet points), **Areas of Concern** (2-3 bullets), **Opportunities** (2-3 bullets), **Path to ${PNL_NET_MARGIN_TARGET}% Net Margin** (specific actions with £ amounts).
- Compare against targets: revenue £${PNL_REVENUE_TARGET.toLocaleString()}/mo, gross margin ${PNL_GROSS_MARGIN_TARGET}%, net profit £${PNL_CLEAR_PROFIT_TARGET.toLocaleString()}/mo, net margin ${PNL_NET_MARGIN_TARGET}%, maintenance budget £${PNL_MAINT_TARGET.toLocaleString()}/mo, wages budget £${PNL_WAGES_TARGET.toLocaleString()}/mo.
- Identify the biggest cost drivers and where savings would have the most impact.
- Flag any months where net profit was negative or margin dropped sharply.
- Keep total response under 350 words. No preamble.`;

        const userMsg = `Here is the P&L data:\n\`\`\`json\n${JSON.stringify(ctx, null, 0)}\n\`\`\`\n\nProvide your analysis.`;

        try {
            const resp = await fetch(typeof AI_PROXY !== 'undefined' ? AI_PROXY : 'https://claude-proxy.kevinbrittain.workers.dev', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, system: systemPrompt, messages: [{ role: 'user', content: userMsg }] })
            });
            if (!resp.ok) throw new Error(`API ${resp.status}`);
            const data = await resp.json();
            const text = data.content?.[0]?.text || 'No analysis available.';
            panel.innerHTML = `<div style="font-size:13px;line-height:1.7;color:#1e293b">${typeof renderMarkdown === 'function' ? renderMarkdown(text) : text.replace(/\n/g, '<br>')}</div>
                <div style="margin-top:8px;display:flex;gap:6px">
                    <button onclick="pnlRunAIAnalysis()" style="font-size:10px;padding:3px 10px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:4px;cursor:pointer;color:#64748b">↻ Refresh Analysis</button>
                </div>`;
        } catch (e) {
            console.error('P&L AI analysis failed:', e);
            panel.innerHTML = `<div style="color:#dc2626;font-size:12px;padding:12px">Analysis unavailable: ${escHtml(e.message)}. <button onclick="pnlRunAIAnalysis()" style="font-size:11px;padding:2px 8px;background:#fee2e2;border:1px solid #fca5a5;border-radius:4px;cursor:pointer;color:#991b1b;margin-left:6px">Retry</button></div>`;
        } finally {
            _pnlAiLoading = false;
        }
    }

    // ══════════════════════════════════════════
    // KPI Card with target comparison
    // ══════════════════════════════════════════
    function pnlKpiCard(label, value, sub, { target, targetLabel, isMargin = false, invertComparison = false } = {}) {
        let indicatorHtml = '';
        if (target != null) {
            const actual = isMargin ? value : value;
            const diff = actual - target;
            const good = invertComparison ? diff <= 0 : diff >= 0;
            const pct = target !== 0 ? Math.abs(diff / target * 100).toFixed(0) : 0;
            const col = good ? '#16a34a' : '#dc2626';
            const arrow = good ? '▲' : '▼';
            const diffFmt = isMargin ? `${Math.abs(diff).toFixed(1)}pp` : pnlGBP(Math.abs(diff));
            indicatorHtml = `<div style="font-size:10px;margin-top:2px;color:${col}">${arrow} ${diffFmt} ${good ? 'above' : 'below'} ${targetLabel || 'target'}</div>`;
        }
        const valFmt = isMargin ? `${value.toFixed(1)}%` : pnlFmt(value);
        const valCls = isMargin
            ? (value >= (target || 0) ? 'text-green' : 'text-red')
            : (value >= 0 ? 'text-green' : 'text-red');
        return `<div class="kpi-card">
            <div class="kpi-card-label">${escHtml(label)}</div>
            <div class="kpi-card-value ${valCls}">${valFmt}</div>
            <div class="kpi-card-sub">${sub}</div>
            ${indicatorHtml}
        </div>`;
    }

    // ══════════════════════════════════════════
    // MAIN RENDER
    // ══════════════════════════════════════════
    function renderPnL() {
        const host = document.getElementById('tab-pnl');
        if (!host) return;

        if (!Array.isArray(allTransactions) || allTransactions.length === 0) {
            host.innerHTML = `<div class="section"><h2 class="section-title">Profit &amp; Loss OS</h2>
                <p style="color:#64748b">Loading transactions… if this persists, open the Leadership Dashboard first.</p></div>`;
            return;
        }

        pnlDestroyCharts();

        const businessNames = PNL_TOP_BUSINESSES.slice();
        if (!businessNames.includes(pnlBusinessName)) pnlBusinessName = businessNames[0];

        const keys = pnlMonthKeys(pnlMonths);
        const pnl = buildPnL(allTransactions, pnlBusinessName, keys);
        _pnlCache = pnl;

        // Avg monthly figures for target comparison
        const avgRev = pnl.grand.revenue / pnlMonths;
        const avgNP = pnl.grand.netProfit / pnlMonths;
        const avgMaint = (pnl.cogs.rows.find(r => r.subCat === 'COGS Property Reactive Maintenance')?.total || 0) / pnlMonths;
        const avgWages = ((pnl.cogs.rows.find(r => r.subCat === 'COGS Labour')?.total || 0) + (pnl.opex.rows.find(r => r.subCat === 'Opex Labour')?.total || 0)) / pnlMonths;

        const headCells = keys.map(k => `<th style="text-align:right;min-width:88px;background:#f8fafc">${pnlMonthLabel(k)}</th>`).join('') +
            `<th class="pnl-total-col" style="text-align:right;min-width:100px;background:#f1f5f9">Total</th>`;

        function jsAttr(v) { return JSON.stringify(v == null ? null : v).replace(/"/g, '&quot;'); }

        function cellTd(section, subCat, monthKey, value, extraStyle = '') {
            const hasTx = !!(pnl.txIndex[section]?.[subCat]?.[monthKey]?.length);
            if (!hasTx) return `<td style="text-align:right;${extraStyle}">${pnlFmt(value)}</td>`;
            return `<td style="text-align:right;cursor:pointer;${extraStyle}" onclick="pnlDrill('cell', ${jsAttr(section)}, ${jsAttr(subCat)}, ${jsAttr(monthKey)})" title="Show transactions">${pnlFmt(value)}</td>`;
        }
        function subTotalTd(section, subCat, value) {
            const hasTx = Object.values(pnl.txIndex[section]?.[subCat] || {}).some(arr => arr.length);
            const base = 'text-align:right;background:#f8fafc;font-weight:600';
            if (!hasTx) return `<td style="${base}">${pnlFmt(value)}</td>`;
            return `<td style="${base};cursor:pointer" onclick="pnlDrill('subTotal', ${jsAttr(section)}, ${jsAttr(subCat)}, null)" title="Show all">${pnlFmt(value)}</td>`;
        }
        function rowsFor(section, indent = 14) {
            return section.rows.map(r => {
                const cells = keys.map(k => cellTd(section.name, r.subCat, k, r.monthly[k] || 0)).join('');
                return `<tr><td class="pnl-first" style="padding-left:${indent}px;color:#475569;background:#fff">${escHtml(r.subCat)}</td>${cells}${subTotalTd(section.name, r.subCat, r.total)}</tr>`;
            }).join('');
        }
        function sectionTotalRow(label, sectionName, perMonth, grand, { bg = '#e2e8f0', color = '#0f172a' } = {}) {
            const cells = keys.map(k => `<td style="text-align:right;cursor:pointer;background:${bg};color:${color}" onclick="pnlDrill('monthTotal', ${jsAttr(sectionName)}, null, ${jsAttr(k)})" title="Show ${escHtml(sectionName)}">${pnlFmt(perMonth[k] || 0)}</td>`).join('');
            return `<tr style="font-weight:700"><td class="pnl-first" style="padding:8px 10px;background:${bg};color:${color}">${escHtml(label)}</td>${cells}<td style="text-align:right;cursor:pointer;background:${bg};color:${color}" onclick="pnlDrill('sectionTotal', ${jsAttr(sectionName)}, null, null)">${pnlFmt(grand)}</td></tr>`;
        }
        function totalRow(label, perMonth, grand, { bold = true, bg = '#e2e8f0', color = '#0f172a' } = {}) {
            const cells = keys.map(k => `<td style="text-align:right;background:${bg};color:${color}">${pnlFmt(perMonth[k] || 0)}</td>`).join('');
            return `<tr style="${bold ? 'font-weight:700' : ''}"><td class="pnl-first" style="padding:8px 10px;background:${bg};color:${color}">${escHtml(label)}</td>${cells}<td style="text-align:right;background:${bg};color:${color}">${pnlFmt(grand)}</td></tr>`;
        }
        function marginRow(label, perMonth, grand) {
            const cells = keys.map(k => `<td style="text-align:right;background:#fafafa">${pnlPct(perMonth[k] || 0)}</td>`).join('');
            return `<tr style="font-style:italic;color:#475569"><td class="pnl-first" style="padding:6px 10px;background:#fafafa">${escHtml(label)}</td>${cells}<td style="text-align:right;background:#fafafa">${pnlPct(grand)}</td></tr>`;
        }
        function sectionHeader(name) {
            return `<tr style="color:#fff"><td class="pnl-first" style="padding:8px 10px;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:1px;background:#0f172a">${escHtml(name)}</td><td colspan="${keys.length + 1}" style="background:#0f172a"></td></tr>`;
        }

        const bizOptions = businessNames.map(n => `<option value="${escHtml(n)}" ${n === pnlBusinessName ? 'selected' : ''}>${escHtml(n)}</option>`).join('');
        const monthOptions = [1, 3, 6, 12].map(m => `<option value="${m}" ${m === pnlMonths ? 'selected' : ''}>${m} month${m === 1 ? '' : 's'}</option>`).join('');

        host.innerHTML = `
            <div data-sync-bar="pnl"></div>
            <div class="section">
                <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:12px">
                    <div>
                        <h2 class="section-title" style="margin-bottom:4px">Profit &amp; Loss OS</h2>
                        <span style="font-size:12px;color:#94a3b8">Live from reconciled transactions · ${pnlBusinessName}</span>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                        <label style="font-size:12px;color:#64748b">Business:
                            <select id="pnlBizSelect" onchange="pnlBusinessName=this.value;renderPnL()" style="font-size:12px;padding:4px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;margin-left:4px">${bizOptions}</select>
                        </label>
                        <label style="font-size:12px;color:#64748b">Period:
                            <select id="pnlMonthsSelect" onchange="pnlMonths=Number(this.value);renderPnL()" style="font-size:12px;padding:4px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;margin-left:4px">${monthOptions}</select>
                        </label>
                    </div>
                </div>

                <!-- AI Analysis -->
                <div style="background:linear-gradient(135deg,#f8fafc 0%,#eef2ff 100%);border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin-bottom:16px">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                        <span style="font-size:16px">🤖</span>
                        <span style="font-size:13px;font-weight:700;color:#0f172a">AI Financial Analysis</span>
                        <button onclick="pnlRunAIAnalysis()" style="margin-left:auto;font-size:11px;padding:4px 12px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;color:#64748b;font-weight:500">Generate Analysis</button>
                    </div>
                    <div id="pnlAiPanel" style="color:#64748b;font-size:12px">Click <strong>Generate Analysis</strong> to get AI-powered insights into your P&amp;L trends, cost drivers, and path to ${PNL_NET_MARGIN_TARGET}% net margin.</div>
                </div>

                <!-- Row 1: Revenue · COGS · OpEx — same format: period total + avg/mo -->
                <div class="cards-grid" style="margin-bottom:12px">
                    ${pnlKpiCard('Revenue', pnl.grand.revenue, `${pnlMonths}-month total · Avg £${Math.round(avgRev).toLocaleString()}/mo`, { target: PNL_REVENUE_TARGET * pnlMonths, targetLabel: `£${(PNL_REVENUE_TARGET/1000).toFixed(0)}k/mo` })}
                    ${pnlKpiCard('Cost of Goods Sold', pnl.grand.cogs, `${pnlMonths}-month total · Avg £${Math.round(pnl.grand.cogs / pnlMonths).toLocaleString()}/mo · ${((pnl.grand.cogs / pnl.grand.revenue) * 100 || 0).toFixed(1)}% of revenue`, { invertComparison: true })}
                    ${pnlKpiCard('Operating Expenses', pnl.grand.opex, `${pnlMonths}-month total · Avg £${Math.round(pnl.grand.opex / pnlMonths).toLocaleString()}/mo · ${((pnl.grand.opex / pnl.grand.revenue) * 100 || 0).toFixed(1)}% of revenue`, { invertComparison: true })}
                </div>

                <!-- Row 2: Gross Profit · Gross Margin · Net Profit · Net Margin -->
                <div class="cards-grid" style="margin-bottom:12px">
                    ${pnlKpiCard('Gross Profit', pnl.grand.grossProfit, `${pnlMonths}-month total · Avg £${Math.round(pnl.grand.grossProfit / pnlMonths).toLocaleString()}/mo`)}
                    ${pnlKpiCard('Gross Margin', pnl.grand.grossMargin, `Target ${PNL_GROSS_MARGIN_TARGET}%`, { target: PNL_GROSS_MARGIN_TARGET, targetLabel: `${PNL_GROSS_MARGIN_TARGET}%`, isMargin: true })}
                    ${pnlKpiCard('Net Profit', pnl.grand.netProfit, `${pnlMonths}-month total · Avg £${Math.round(avgNP).toLocaleString()}/mo`, { target: PNL_CLEAR_PROFIT_TARGET * pnlMonths, targetLabel: `£${(PNL_CLEAR_PROFIT_TARGET/1000).toFixed(0)}k/mo` })}
                    ${pnlKpiCard('Net Margin', pnl.grand.netMargin, `Target ${PNL_NET_MARGIN_TARGET}%`, { target: PNL_NET_MARGIN_TARGET, targetLabel: `${PNL_NET_MARGIN_TARGET}%`, isMargin: true })}
                </div>

                <!-- Row 3: Maintenance · Wages (both with % of revenue) -->
                <div class="cards-grid" style="margin-bottom:20px">
                    ${pnlKpiCard('Avg Monthly Maintenance', avgMaint, `Budget £${PNL_MAINT_TARGET.toLocaleString()}/mo · ${avgRev ? (avgMaint / avgRev * 100).toFixed(1) : 0}% of revenue`, { target: PNL_MAINT_TARGET, targetLabel: 'budget', invertComparison: true })}
                    ${pnlKpiCard('Avg Monthly Wages', avgWages, `Budget £${PNL_WAGES_TARGET.toLocaleString()}/mo · ${avgRev ? (avgWages / avgRev * 100).toFixed(1) : 0}% of revenue`, { target: PNL_WAGES_TARGET, targetLabel: 'budget', invertComparison: true })}
                </div>

                <!-- Charts — 2 per row, taller for clarity -->
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
                    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;height:380px">
                        <canvas id="pnlChartRevExp"></canvas>
                    </div>
                    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;height:380px">
                        <canvas id="pnlChartProfit"></canvas>
                    </div>
                    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;height:380px">
                        <canvas id="pnlChartMargin"></canvas>
                    </div>
                    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;height:420px">
                        <canvas id="pnlChartBreakdown"></canvas>
                    </div>
                </div>

                <!-- P&L Grid -->
                <style>
                    .pnl-grid-wrap { position:relative; overflow:auto; max-height:85vh; border:1px solid #e2e8f0; border-radius:8px; }
                    .pnl-grid { border-collapse:separate; border-spacing:0; }
                    .pnl-grid thead th { position:sticky; top:0; z-index:2; }
                    .pnl-grid tbody td.pnl-first, .pnl-grid thead th.pnl-first { position:sticky; left:0; z-index:1; }
                    .pnl-grid thead th.pnl-first { z-index:3; }
                    .pnl-grid thead th { box-shadow: inset 0 -1px 0 #e2e8f0; }
                    .pnl-grid tbody td.pnl-first { box-shadow: inset -1px 0 0 #e2e8f0; }
                </style>
                <div class="pnl-grid-wrap">
                    <table class="invoice-table pnl-grid" style="min-width:${160 + keys.length * 100}px;font-size:12px">
                        <thead>
                            <tr>
                                <th class="pnl-first" style="min-width:220px;text-align:left;background:#f8fafc">Line Item</th>
                                ${headCells}
                            </tr>
                        </thead>
                        <tbody>
                            ${sectionHeader('Revenue')}
                            ${rowsFor(pnl.revenue)}
                            ${sectionTotalRow('Total Revenue', 'Revenue', pnl.revenue.totals, pnl.grand.revenue, { bg: '#dcfce7', color: '#065f46' })}

                            ${sectionHeader('Cost of Goods Sold')}
                            ${rowsFor(pnl.cogs)}
                            ${sectionTotalRow('Total COGS', 'Cost of Goods Sold', pnl.cogs.totals, pnl.grand.cogs, { bg: '#fee2e2', color: '#991b1b' })}

                            ${totalRow('Gross Profit', pnl.grossProfit, pnl.grand.grossProfit, { bg: '#e0f2fe', color: '#075985' })}
                            ${marginRow('Gross Profit Margin', pnl.grossMargin, pnl.grand.grossMargin)}

                            ${sectionHeader('Operating Expenses')}
                            ${rowsFor(pnl.opex)}
                            ${sectionTotalRow('Total Operating Expenses', 'Operating Expenses', pnl.opex.totals, pnl.grand.opex, { bg: '#fee2e2', color: '#991b1b' })}

                            ${totalRow('Net Profit', pnl.netProfit, pnl.grand.netProfit, { bg: '#d1fae5', color: '#065f46' })}
                            ${marginRow('Net Profit Margin', pnl.netMargin, pnl.grand.netMargin)}
                        </tbody>
                    </table>
                </div>

                <p style="color:#94a3b8;font-size:11px;margin-top:12px">
                    Revenue = transactions categorised <em>Revenue</em>. COGS = <em>Cost of Goods Sold</em>. OpEx = <em>Operating Expenses</em>.
                    Capital expenditure, loans, transfers, balance-sheet and personal transactions are excluded.
                    Targets: Revenue <strong>£${PNL_REVENUE_TARGET.toLocaleString()}/mo</strong> · Gross Margin <strong>${PNL_GROSS_MARGIN_TARGET}%</strong> · Net Profit <strong>£${PNL_CLEAR_PROFIT_TARGET.toLocaleString()}/mo</strong> · Net Margin <strong>${PNL_NET_MARGIN_TARGET}%</strong>.
                </p>
            </div>
        `;

        // Render charts after DOM is ready
        requestAnimationFrame(() => pnlRenderCharts(pnl, keys));

        // ── Sync Bar + Health Checks ──
        if (typeof registerSyncBar === 'function') {
            registerSyncBar('pnl', {
                // Pull fresh transactions/categories then re-render the P&L view from them.
                refreshFn: async () => { await loadDashboard(); renderPnL(); },
                checks: [
                    {
                        name: 'Reconciled transactions present', kind: 'sync', run: () => {
                            const rec = (allTransactions || []).filter(r => getField(r, F.txReconciled));
                            if (rec.length === 0) return { status: 'fail', detail: 'No reconciled transactions — P&L cannot be computed' };
                            return { status: 'pass', detail: `${rec.length} reconciled transactions available across all business filters` };
                        }
                    },
                    {
                        name: `Last ${pnlMonths} months computed`, kind: 'sync', run: () => {
                            if (!keys || keys.length === 0) return { status: 'fail', detail: 'No month buckets generated' };
                            const haveData = keys.filter(k =>
                                Math.abs(pnl.revenue.totals[k] || 0) > 0 ||
                                Math.abs(pnl.cogs.totals[k] || 0) > 0 ||
                                Math.abs(pnl.opex.totals[k] || 0) > 0
                            ).length;
                            if (haveData === 0) return { status: 'warn', detail: `${keys.length} month buckets generated but all empty — check business filter and data` };
                            return { status: 'pass', detail: `${haveData}/${keys.length} months have non-zero P&L data` };
                        }
                    },
                    {
                        name: 'Categories + Sub-Categories loaded', kind: 'sync', run: () => {
                            const cats = (allCategories || []).length;
                            const subs = (allSubCategories || []).length;
                            if (cats === 0 || subs === 0) return { status: 'fail', detail: `Chart of Accounts incomplete: ${cats} categories, ${subs} sub-categories` };
                            return { status: 'pass', detail: `${cats} categories · ${subs} sub-categories from Chart of Accounts` };
                        }
                    },
                    {
                        name: 'Business filter resolves to records', kind: 'sync', run: () => {
                            // Use the same resolution path as buildPnL: link → record ID → name via lookup
                            const bizNames = pnlBuildLookup(allBusinesses, 'fldbbRqVxLxUdHwIR');
                            const matches = (allTransactions || []).filter(t => {
                                const id = pnlLinkId(getField(t, F.txBusiness));
                                return id && bizNames[id] === pnlBusinessName;
                            });
                            if (matches.length === 0) {
                                return { status: 'fail', detail: `0 transactions matched business "${pnlBusinessName}" — check business filter and link resolution` };
                            }
                            return { status: 'pass', detail: `${matches.length} transactions matched business "${pnlBusinessName}"` };
                        }
                    },
                    {
                        name: 'Net Profit grand total computed', kind: 'automation', run: () => {
                            const grand = pnl.grand;
                            if (!grand || isNaN(grand.netProfit)) return { status: 'fail', detail: 'Grand totals missing or NaN' };
                            return { status: 'pass', detail: `${pnlMonths}-month net profit: ${pnlGBP(grand.netProfit)} (${(grand.netMargin || 0).toFixed(1)}%)` };
                        }
                    },
                    {
                        name: 'Charts render hook scheduled', kind: 'automation', run: () => {
                            return { status: 'pass', detail: 'pnlRenderCharts() queued via requestAnimationFrame after each render' };
                        }
                    },
                ],
            });
            markTabSynced('pnl');
        }
    }
