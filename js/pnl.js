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

        // Parallel index of the tx records backing each (section, subCat, monthKey) bucket.
        // Used by drill-down clicks — same shape as sections{}.
        const txIndex = {};
        PNL_SECTIONS.forEach(sec => {
            txIndex[sec.name] = {};
            sec.subs.forEach(s => { txIndex[sec.name][s] = {}; });
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

            if (!txIndex[sectionName][subCat][mKey]) txIndex[sectionName][subCat][mKey] = [];
            txIndex[sectionName][subCat][mKey].push(tx);
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
            txIndex,
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

    // Cached P&L result so drill-down clicks don't have to re-aggregate
    let _pnlCache = null;
    // Track whether any edits were made inside the drill modal so we know to
    // re-render the P&L when it closes.
    let _pnlEditsMade = false;

    // Which businesses appear in the top-of-report dropdown. Amend dropdown inside
    // drill-down rows uses the full allBusinesses list (includes Personal etc.).
    const PNL_TOP_BUSINESSES = ['Real Estate', 'Operations Director'];

    // Field primary IDs for name lookups
    const PNL_NAME_FIELDS = {
        category:    'fldii4oUzSfmplihO',
        subCategory: 'fldO4BTJhFv5EsN6i',
        business:    'fldbbRqVxLxUdHwIR',
    };

    // Build <option> list for a dropdown. records come from allCategories etc.
    function pnlOptionList(records, nameFieldId, selectedId) {
        const sorted = [...(records || [])].map(r => ({
            id: r.id,
            name: String(getField(r, nameFieldId) || '')
        })).filter(o => o.name).sort((a, b) => a.name.localeCompare(b.name));
        const opts = ['<option value="">(none)</option>']
            .concat(sorted.map(o =>
                `<option value="${escHtml(o.id)}" ${o.id === selectedId ? 'selected' : ''}>${escHtml(o.name)}</option>`
            ));
        return opts.join('');
    }

    // PATCH a single linked-record field on a transaction and update the local
    // tx record so the UI stays in sync without a full refresh.
    async function pnlEditTxField(txId, kind, recordId, selectEl) {
        const fieldMap = {
            category:    F.txCategory,
            subCategory: F.txSubCategory,
            business:    F.txBusiness,
        };
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
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error?.message || resp.status);
            }
            const updated = await resp.json();

            // Mirror new field values onto the local tx record so future renders
            // reflect the change. updated.fields is keyed by field ID.
            const tx = (allTransactions || []).find(t => t.id === txId);
            if (tx && updated.fields) {
                Object.assign(tx.fields, updated.fields);
            }
            _pnlEditsMade = true;
            if (status) { status.textContent = '✓'; status.style.color = '#16a34a'; }
        } catch (e) {
            console.error('pnlEditTxField failed', e);
            if (status) { status.textContent = '✗ ' + (e.message || 'err'); status.style.color = '#dc2626'; }
        }
    }

    // Drill-down: show the transactions that make up a given slice.
    // scope = 'cell' | 'subTotal' | 'monthTotal' | 'sectionTotal'
    function pnlDrill(scope, section, subCat, monthKey) {
        if (!_pnlCache) return;
        const idx = _pnlCache.txIndex;
        let txs = [];
        if (scope === 'cell') {
            txs = (idx[section]?.[subCat]?.[monthKey]) || [];
        } else if (scope === 'subTotal') {
            Object.values(idx[section]?.[subCat] || {}).forEach(arr => txs.push(...arr));
        } else if (scope === 'monthTotal') {
            Object.values(idx[section] || {}).forEach(bySub => {
                (bySub[monthKey] || []).forEach(tx => txs.push(tx));
            });
        } else if (scope === 'sectionTotal') {
            Object.values(idx[section] || {}).forEach(bySub => {
                Object.values(bySub).forEach(arr => txs.push(...arr));
            });
        }

        // Sort newest first
        txs.sort((a, b) => new Date(getField(b, F.txDate)) - new Date(getField(a, F.txDate)));

        let title;
        if (scope === 'cell') title = `${subCat} — ${pnlMonthLabel(monthKey)}`;
        else if (scope === 'subTotal') title = `${subCat} — ${pnlMonths} month total`;
        else if (scope === 'monthTotal') title = `${section} — ${pnlMonthLabel(monthKey)}`;
        else title = `${section} — ${pnlMonths} month total`;

        // Builder for an editable linked-record select embedded in a drill row.
        // onchange calls pnlEditTxField(txId, kind, value, this)
        function editSelect(txId, kind, currentId, options) {
            return `<div style="display:flex;align-items:center;gap:4px">
                <select onchange="pnlEditTxField(${jsAttr(txId)}, ${jsAttr(kind)}, this.value, this)"
                    style="font-size:11px;padding:2px 4px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;max-width:140px">
                    ${options}
                </select>
                <span class="pnl-edit-status" style="font-size:11px;min-width:12px"></span>
            </div>`;
        }

        // Local jsAttr so we can use the helper inside this function scope too.
        const jsAttr = (v) => JSON.stringify(v == null ? null : v).replace(/"/g, '&quot;');

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

            const catOpts    = pnlOptionList(allCategories,    PNL_NAME_FIELDS.category,    catId);
            const subCatOpts = pnlOptionList(allSubCategories, PNL_NAME_FIELDS.subCategory, subCatId);
            const bizOpts    = pnlOptionList(allBusinesses,    PNL_NAME_FIELDS.business,    bizId);

            return `<tr>
                <td style="padding:8px 10px;white-space:nowrap;vertical-align:top">${escHtml(date)}</td>
                <td style="padding:8px 10px;vertical-align:top;min-width:180px">${escHtml(detail)}</td>
                <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums;${amtCls};font-weight:600;vertical-align:top">${amt < 0 ? '-' : ''}£${Math.abs(amt).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td style="padding:6px 8px;vertical-align:top">${editSelect(tx.id, 'category',    catId,    catOpts)}</td>
                <td style="padding:6px 8px;vertical-align:top">${editSelect(tx.id, 'subCategory', subCatId, subCatOpts)}</td>
                <td style="padding:6px 8px;vertical-align:top">${editSelect(tx.id, 'business',    bizId,    bizOpts)}</td>
            </tr>`;
        }).join('');

        const sumFmt = `${runningTotal < 0 ? '-' : ''}£${Math.abs(runningTotal).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

        const overlay = document.createElement('div');
        overlay.id = 'pnlDrillOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
        overlay.onclick = (e) => { if (e.target === overlay) pnlCloseDrill(); };
        overlay.innerHTML = `
            <div style="background:#fff;border-radius:12px;max-width:1100px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 40px rgba(0,0,0,0.3)">
                <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #e2e8f0">
                    <div>
                        <div style="font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px">${escHtml(section)}</div>
                        <div style="font-size:16px;font-weight:700;color:#0f172a">${escHtml(title)}</div>
                        <div style="font-size:12px;color:#64748b;margin-top:2px">${txs.length} transaction${txs.length === 1 ? '' : 's'} &nbsp;·&nbsp; Sum of Report Amount: <strong>${sumFmt}</strong> &nbsp;·&nbsp; <span style="color:#94a3b8">Changes save instantly; report refreshes when you close.</span></div>
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
                                <th style="padding:8px 10px;text-align:left;font-weight:600;color:#475569">Business (For Reports)</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml || '<tr><td colspan="6" style="padding:40px;text-align:center;color:#94a3b8">No transactions for this slice.</td></tr>'}</tbody>
                    </table>
                </div>
            </div>
        `;
        // Remove any stale overlay
        pnlCloseDrill();
        document.body.appendChild(overlay);
        document.addEventListener('keydown', pnlEscHandler);
    }
    function pnlCloseDrill() {
        const o = document.getElementById('pnlDrillOverlay');
        if (o) o.remove();
        document.removeEventListener('keydown', pnlEscHandler);
        // If any row-level edits happened, refresh the P&L to reflect re-classified amounts.
        if (_pnlEditsMade) {
            _pnlEditsMade = false;
            if (typeof renderPnL === 'function') renderPnL();
        }
    }
    function pnlEscHandler(e) { if (e.key === 'Escape') pnlCloseDrill(); }

    function renderPnL() {
        const host = document.getElementById('tab-pnl');
        if (!host) return;

        if (!Array.isArray(allTransactions) || allTransactions.length === 0) {
            host.innerHTML = `<div class="section"><h2 class="section-title">Profit &amp; Loss OS</h2>
                <p style="color:#64748b">Loading transactions… if this persists, open the Leadership Dashboard first.</p></div>`;
            return;
        }

        // Top-of-report Business filter: only the two business-level P&Ls.
        // (The amend dropdown in drill rows uses the full allBusinesses list,
        // which includes Personal etc., so mis-categorised txs can be corrected.)
        const businessNames = PNL_TOP_BUSINESSES.slice();
        if (!businessNames.includes(pnlBusinessName)) pnlBusinessName = businessNames[0];

        const keys = pnlMonthKeys(pnlMonths);
        const pnl = buildPnL(allTransactions, pnlBusinessName, keys);
        _pnlCache = pnl;

        const headCells = keys.map(k => `<th style="text-align:right;min-width:88px">${pnlMonthLabel(k)}</th>`).join('') +
            `<th style="text-align:right;min-width:100px;background:#f1f5f9">Total</th>`;

        // JSON-stringify a value for safe embedding inside a double-quoted HTML attribute.
        // JSON strings contain " which would close the attribute — escape them as &quot;.
        function jsAttr(v) {
            return JSON.stringify(v == null ? null : v).replace(/"/g, '&quot;');
        }

        // Clickable data cell — drills down to the transactions backing the value.
        // Only wires up click if there are transactions behind the number.
        function cellTd(section, subCat, monthKey, value, extraStyle = '') {
            const hasTx = !!(pnl.txIndex[section]?.[subCat]?.[monthKey]?.length);
            if (!hasTx) return `<td style="text-align:right;${extraStyle}">${pnlFmt(value)}</td>`;
            return `<td style="text-align:right;cursor:pointer;${extraStyle}" onclick="pnlDrill('cell', ${jsAttr(section)}, ${jsAttr(subCat)}, ${jsAttr(monthKey)})" title="Show transactions">${pnlFmt(value)}</td>`;
        }

        function subTotalTd(section, subCat, value) {
            const hasTx = Object.values(pnl.txIndex[section]?.[subCat] || {}).some(arr => arr.length);
            const base = 'text-align:right;background:#f8fafc;font-weight:600';
            if (!hasTx) return `<td style="${base}">${pnlFmt(value)}</td>`;
            return `<td style="${base};cursor:pointer" onclick="pnlDrill('subTotal', ${jsAttr(section)}, ${jsAttr(subCat)}, null)" title="Show all transactions for this line">${pnlFmt(value)}</td>`;
        }

        function rowsFor(section, indent = 14) {
            return section.rows.map(r => {
                const cells = keys.map(k => cellTd(section.name, r.subCat, k, r.monthly[k] || 0)).join('');
                return `<tr>
                    <td style="padding-left:${indent}px;color:#475569">${escHtml(r.subCat)}</td>
                    ${cells}
                    ${subTotalTd(section.name, r.subCat, r.total)}
                </tr>`;
            }).join('');
        }

        // Section totals (Total Revenue / Total COGS / Total OpEx) — clickable, scoped to that section.
        function sectionTotalRow(label, sectionName, perMonth, grand, { bg = '#e2e8f0', color = '#0f172a' } = {}) {
            const cells = keys.map(k => `<td style="text-align:right;cursor:pointer" onclick="pnlDrill('monthTotal', ${jsAttr(sectionName)}, null, ${jsAttr(k)})" title="Show ${escHtml(sectionName)} transactions for ${escHtml(pnlMonthLabel(k))}">${pnlFmt(perMonth[k] || 0)}</td>`).join('');
            return `<tr style="background:${bg};color:${color};font-weight:700">
                <td style="padding:8px 10px">${escHtml(label)}</td>
                ${cells}
                <td style="text-align:right;cursor:pointer" onclick="pnlDrill('sectionTotal', ${jsAttr(sectionName)}, null, null)" title="Show all ${escHtml(sectionName)} transactions">${pnlFmt(grand)}</td>
            </tr>`;
        }

        // Derived totals (GP, NP) — not clickable since they combine sections.
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
                    Unreconciled transactions (those missing a category or business link) are skipped.
                </p>
            </div>
        `;
    }
