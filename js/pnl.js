// ══════════════════════════════════════════
// P&L — Profit & Loss by Month (Real Estate OS)
// Reads from allTransactions loaded by dashboard.js
// ══════════════════════════════════════════

    // Which business is this P&L for. Defaults to Real Estate.
    let pnlBusinessName = 'Real Estate';
    // How many trailing months to show (including current)
    let pnlMonths = 12;

    // Explicit sub-category allow-lists per section (order preserved in output).
    // Anything outside these lists is intentionally excluded from the P&L — e.g.
    // Capex, Transfers, Loan Receipts, Balance Sheet moves, Personal categories.
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

    // Return array of YYYY-MM keys for the last N months, oldest → newest
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

    // Build id→name lookup from a loaded table given its primary field id
    function pnlBuildLookup(records, nameFieldId) {
        const out = {};
        (records || []).forEach(r => {
            const n = getField(r, nameFieldId);
            if (n) out[r.id] = String(n);
        });
        return out;
    }

    // Read linked-record id (first entry) from a linked field. Airtable REST with
    // returnFieldsByFieldId=true returns an array of record ID strings; the MCP
    // returns [{id, name}] — handle both.
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

    // Aggregate transactions into a P&L structure for the given business.
    function buildPnL(transactions, businessName, monthKeys) {
        const monthSet = new Set(monthKeys);

        // Resolve linked-record names via the loaded tables (REST returns just IDs)
        const subCatNames = pnlBuildLookup(allSubCategories, 'fldO4BTJhFv5EsN6i');   // Sub Category Name
        const bizNames = pnlBuildLookup(allBusinesses, 'fldbbRqVxLxUdHwIR');          // Business Name
        const resolve = (field, map) => {
            const id = pnlLinkId(field);
            if (!id) return '';
            return map[id] || '';
        };

        // Build a sub-category → section map from the explicit allow-lists.
        // This is the *authoritative* classifier — the COA category link on the
        // transaction is only used for sign convention, not for inclusion.
        const subToSection = {};
        PNL_SECTIONS.forEach(sec => sec.subs.forEach(s => { subToSection[s] = sec.name; }));

        // section name -> subCatName -> { monthKey: amount }
        const sections = {};
        PNL_SECTIONS.forEach(sec => {
            sections[sec.name] = {};
            sec.subs.forEach(s => { sections[sec.name][s] = {}; });
        });

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
            if (!sectionName) return; // sub-cat not in our P&L allow-list → skip

            const amt = Number(getField(tx, F.txReportAmount)) || 0;
            // Revenue stays as-is; expense magnitudes flipped to positive so
            // GP = Revenue - COGS and NP = GP - OpEx work arithmetically.
            const signed = sectionName === 'Revenue' ? amt : -amt;

            sections[sectionName][subCat][mKey] = (sections[sectionName][subCat][mKey] || 0) + signed;
        });

        // Convert to ordered structure, preserving the user's defined sub-cat order.
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
            monthKeys.forEach(k => {
                let t = 0;
                rows.forEach(r => { t += r.monthly[k] || 0; });
                totals[k] = t;
                grand += t;
            });
            return { name: secDef.name, rows, totals, total: grand };
        }

        const revenue = sectionRows(PNL_SECTIONS[0]);
        const cogs    = sectionRows(PNL_SECTIONS[1]);
        const opex    = sectionRows(PNL_SECTIONS[2]);

        // Derived rows
        const grossProfit = {};
        const grossMargin = {};
        const netProfit = {};
        const netMargin = {};
        monthKeys.forEach(k => {
            const rev = revenue.totals[k] || 0;
            const cg = cogs.totals[k] || 0;
            const op = opex.totals[k] || 0;
            const gp = rev - cg;
            grossProfit[k] = gp;
            grossMargin[k] = rev !== 0 ? (gp / rev) * 100 : 0;
            const np = gp - op;
            netProfit[k] = np;
            netMargin[k] = rev !== 0 ? (np / rev) * 100 : 0;
        });

        const grandRev = revenue.total;
        const grandCogs = cogs.total;
        const grandOpex = opex.total;
        const grandGP = grandRev - grandCogs;
        const grandNP = grandGP - grandOpex;

        return {
            monthKeys,
            revenue, cogs, opex,
            grossProfit, grossMargin,
            netProfit, netMargin,
            grand: {
                revenue: grandRev,
                cogs: grandCogs,
                opex: grandOpex,
                grossProfit: grandGP,
                grossMargin: grandRev !== 0 ? (grandGP / grandRev) * 100 : 0,
                netProfit: grandNP,
                netMargin: grandRev !== 0 ? (grandNP / grandRev) * 100 : 0,
            }
        };
    }

    // Format helpers for P&L cells
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

    function renderPnL() {
        const host = document.getElementById('tab-pnl');
        if (!host) return;

        if (!Array.isArray(allTransactions) || allTransactions.length === 0) {
            host.innerHTML = `<div class="section"><h2 class="section-title">Profit &amp; Loss OS</h2>
                <p style="color:#64748b">Loading transactions… if this persists, open the Leadership Dashboard first.</p></div>`;
            return;
        }

        // P&L is locked to Real Estate for now
        const businessNames = ['Real Estate'];
        pnlBusinessName = 'Real Estate';

        const keys = pnlMonthKeys(pnlMonths);
        const pnl = buildPnL(allTransactions, pnlBusinessName, keys);

        const headCells = keys.map(k => `<th style="text-align:right;min-width:88px">${pnlMonthLabel(k)}</th>`).join('') +
            `<th style="text-align:right;min-width:100px;background:#f1f5f9">Total</th>`;

        function rowsFor(section, indent = 14) {
            return section.rows.map(r => {
                const cells = keys.map(k => `<td style="text-align:right">${pnlFmt(r.monthly[k] || 0)}</td>`).join('');
                return `<tr>
                    <td style="padding-left:${indent}px;color:#475569">${escHtml(r.subCat)}</td>
                    ${cells}
                    <td style="text-align:right;background:#f8fafc;font-weight:600">${pnlFmt(r.total)}</td>
                </tr>`;
            }).join('');
        }

        function totalRow(label, perMonth, grand, { bold = true, bg = '#e2e8f0', color = '#0f172a' } = {}) {
            const cells = keys.map(k => `<td style="text-align:right">${pnlFmt(perMonth[k] || 0)}</td>`).join('');
            return `<tr style="background:${bg};color:${color};${bold ? 'font-weight:700' : ''}">
                <td style="padding:8px 10px">${escHtml(label)}</td>
                ${cells}
                <td style="text-align:right">${pnlFmt(grand)}</td>
            </tr>`;
        }

        function marginRow(label, perMonth, grand) {
            const cells = keys.map(k => `<td style="text-align:right">${pnlPct(perMonth[k] || 0)}</td>`).join('');
            return `<tr style="background:#fafafa;font-style:italic;color:#475569">
                <td style="padding:6px 10px">${escHtml(label)}</td>
                ${cells}
                <td style="text-align:right">${pnlPct(grand)}</td>
            </tr>`;
        }

        function sectionHeader(name) {
            return `<tr style="background:#0f172a;color:#fff">
                <td style="padding:8px 10px;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:1px">${escHtml(name)}</td>
                <td colspan="${keys.length + 1}"></td>
            </tr>`;
        }

        const bizOptions = businessNames.map(n =>
            `<option value="${escHtml(n)}" ${n === pnlBusinessName ? 'selected' : ''}>${escHtml(n)}</option>`
        ).join('');

        const monthOptions = [1, 3, 6, 12].map(m =>
            `<option value="${m}" ${m === pnlMonths ? 'selected' : ''}>${m} month${m === 1 ? '' : 's'}</option>`
        ).join('');

        host.innerHTML = `
            <div class="section">
                <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:12px">
                    <div>
                        <h2 class="section-title" style="margin-bottom:4px">Profit &amp; Loss OS</h2>
                        <span style="font-size:12px;color:#94a3b8">Derived from reconciled transactions &nbsp;·&nbsp; Grouped by Chart of Accounts category</span>
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

                <!-- Summary KPI cards (period totals) -->
                <div class="cards-grid" style="margin-bottom:16px">
                    <div class="kpi-card"><div class="kpi-card-label">Total Revenue</div>
                        <div class="kpi-card-value text-green">${pnlFmt(pnl.grand.revenue)}</div>
                        <div class="kpi-card-sub">${pnlMonths}-month total</div></div>
                    <div class="kpi-card"><div class="kpi-card-label">Gross Profit</div>
                        <div class="kpi-card-value">${pnlFmt(pnl.grand.grossProfit)}</div>
                        <div class="kpi-card-sub">Margin ${pnl.grand.grossMargin.toFixed(1)}%</div></div>
                    <div class="kpi-card"><div class="kpi-card-label">Operating Expenses</div>
                        <div class="kpi-card-value text-red">${pnlFmt(pnl.grand.opex)}</div>
                        <div class="kpi-card-sub">${pnlMonths}-month total</div></div>
                    <div class="kpi-card"><div class="kpi-card-label">Net Profit</div>
                        <div class="kpi-card-value ${pnl.grand.netProfit >= 0 ? 'text-green' : 'text-red'}">${pnlFmt(pnl.grand.netProfit)}</div>
                        <div class="kpi-card-sub">Margin ${pnl.grand.netMargin.toFixed(1)}%</div></div>
                </div>

                <div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:8px">
                    <table class="invoice-table" style="min-width:${160 + keys.length * 100}px;font-size:12px">
                        <thead>
                            <tr style="background:#f8fafc">
                                <th style="min-width:220px;text-align:left">Line Item</th>
                                ${headCells}
                            </tr>
                        </thead>
                        <tbody>
                            ${sectionHeader('Revenue')}
                            ${rowsFor(pnl.revenue)}
                            ${totalRow('Total Revenue', pnl.revenue.totals, pnl.grand.revenue, { bg: '#dcfce7', color: '#065f46' })}

                            ${sectionHeader('Cost of Goods Sold')}
                            ${rowsFor(pnl.cogs)}
                            ${totalRow('Total COGS', pnl.cogs.totals, pnl.grand.cogs, { bg: '#fee2e2', color: '#991b1b' })}

                            ${totalRow('Gross Profit', pnl.grossProfit, pnl.grand.grossProfit, { bg: '#e0f2fe', color: '#075985' })}
                            ${marginRow('Gross Profit Margin', pnl.grossMargin, pnl.grand.grossMargin)}

                            ${sectionHeader('Operating Expenses')}
                            ${rowsFor(pnl.opex)}
                            ${totalRow('Total Operating Expenses', pnl.opex.totals, pnl.grand.opex, { bg: '#fee2e2', color: '#991b1b' })}

                            ${totalRow('Net Profit', pnl.netProfit, pnl.grand.netProfit, { bg: '#d1fae5', color: '#065f46' })}
                            ${marginRow('Net Profit Margin', pnl.netMargin, pnl.grand.netMargin)}
                        </tbody>
                    </table>
                </div>

                <p style="color:#94a3b8;font-size:11px;margin-top:12px">
                    Revenue = transactions categorised <em>Revenue</em>. COGS = <em>Cost of Goods Sold</em>. OpEx = <em>Operating Expenses</em>.
                    Capital expenditure, loans, transfers, balance-sheet and personal transactions are excluded.
                    Unreconciled transactions (those missing a category or business link) are skipped.
                </p>
            </div>
        `;
    }
