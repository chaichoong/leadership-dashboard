// ══════════════════════════════════════════
// RECONCILIATION ENGINE v2 — Matching, Knowledge Base, Accuracy Tracking
// ══════════════════════════════════════════
    // RECONCILIATION ENGINE v2
    // ══════════════════════════════════════════

    // Knowledge base — learns from corrections
    function getReconRules() {
        try { return JSON.parse(localStorage.getItem('recon_rules') || '[]'); } catch { return []; }
    }
    function saveReconRule(vendorKey, data) {
        const rules = getReconRules();
        const existing = rules.find(r => r.vendorKey === vendorKey);
        if (existing) {
            Object.assign(existing, data);
            existing.confidence = Math.min((existing.confidence || 0) + 1, 10);
        } else {
            rules.push({ vendorKey, ...data, confidence: 1 });
        }
        localStorage.setItem('recon_rules', JSON.stringify(rules));
    }
    function findReconRule(vendorText) {
        const rules = getReconRules();
        const vLower = vendorText.toLowerCase();
        return rules.find(r => vLower.includes(r.vendorKey)) || null;
    }

    // Helper: get sub-category name by record ID
    function getSubCatName(recId) {
        if (!recId) return '';
        const rec = allSubCategories.find(r => r.id === recId);
        return rec ? (getField(rec, 'fldO4BTJhFv5EsN6i') || '') : '';
    }
    function getCatName(recId) {
        if (!recId) return '';
        const rec = allCategories.find(r => r.id === recId);
        return rec ? (getField(rec, 'fldii4oUzSfmplihO') || '') : '';
    }

    // Build dropdown options for reconciliation columns
    // ── Searchable dropdown helpers ──
    // Uses <input list="datalist"> for type-to-search. All sorted A-Z.
    // Each returns { datalist, inputValue } — datalist is <datalist> HTML, inputValue is pre-selected display text
    let _dlCounter = 0;
    function reconDropdown(id, items, selectedId, style) {
        // items = [{ id, name }] — sorted A-Z
        const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
        const dlId = 'dl_' + id;
        const selected = sorted.find(i => i.id === selectedId);
        const val = selected ? selected.name : '';
        const datalist = `<datalist id="${dlId}">${sorted.map(i => `<option value="${escHtml(i.name)}" data-id="${i.id}">`).join('')}</datalist>`;
        return `${datalist}<input id="${id}" list="${dlId}" value="${escHtml(val)}" style="${style}" autocomplete="off" placeholder="Type to search...">`;
    }

    function buildSubCatDropdown(id, selectedId) {
        const items = allSubCategories.map(r => ({ id: r.id, name: getField(r, 'fldO4BTJhFv5EsN6i') || '' }));
        return reconDropdown(id, items, selectedId, 'font-size:10px;padding:2px 4px;width:170px');
    }
    function buildCatDropdown(id, selectedId) {
        const items = allCategories.map(r => ({ id: r.id, name: getField(r, 'fldii4oUzSfmplihO') || '' }));
        return reconDropdown(id, items, selectedId, 'font-size:10px;padding:2px 4px;width:140px');
    }
    function buildTenantDropdown(id, selectedId) {
        const items = allTenants.filter(t => {
            const status = getField(t, F.tenantStatus);
            return status && typeof status === 'object' ? status.name === 'Active' : String(status || '').toLowerCase() === 'active';
        }).map(t => ({ id: t.id, name: getField(t, F.tenantName) || '' }));
        return reconDropdown(id, items, selectedId, 'font-size:10px;padding:2px 4px;width:110px');
    }
    function buildTenancyDropdown(id, selectedId) {
        const items = allTenancies.filter(r => isTenancyActive(getField(r, F.tenPayStatus))).map(r => ({
            id: r.id, name: getField(r, F.tenRef) || ''
        }));
        return reconDropdown(id, items, selectedId, 'font-size:10px;padding:2px 4px;width:140px');
    }
    function buildRentalUnitDropdown(id, selectedId) {
        const seen = new Set();
        const items = [];
        allTenancies.forEach(r => {
            const unitField = getField(r, F.tenUnit);
            const unitId = Array.isArray(unitField) ? unitField[0] : unitField;
            const unitRef = getField(r, F.tenUnitRef);
            const unitName = Array.isArray(unitRef) ? unitRef[0] : (unitRef || '');
            if (!unitId || seen.has(unitId)) return;
            seen.add(unitId);
            items.push({ id: unitId, name: unitName });
        });
        return reconDropdown(id, items, selectedId, 'font-size:10px;padding:2px 4px;width:120px');
    }
    function buildPropertyDropdown(id, selectedName) {
        const seen = new Set();
        const items = [];
        allTenancies.forEach(r => {
            const prop = getField(r, F.tenProperty);
            const propName = Array.isArray(prop) ? prop[0] : (prop || '');
            if (!propName || seen.has(propName)) return;
            seen.add(propName);
            items.push({ id: propName, name: propName });
        });
        return reconDropdown(id, items, selectedName, 'font-size:10px;padding:2px 4px;width:120px');
    }
    function buildCostDropdown(id, selectedId) {
        const items = allCosts.filter(r => isCostActive(r)).map(r => ({
            id: r.id, name: getField(r, F.costName) || ''
        }));
        return reconDropdown(id, items, selectedId, 'font-size:10px;padding:2px 4px;width:130px');
    }
    function buildBusinessDropdown(id, selectedId) {
        const items = allBusinesses.map(r => ({
            id: r.id, name: getField(r, 'fldbbRqVxLxUdHwIR') || ''
        }));
        return reconDropdown(id, items, selectedId, 'font-size:10px;padding:2px 4px;width:120px');
    }

    // Resolve a datalist input value back to its record ID
    function resolveDropdownId(inputId) {
        const input = document.getElementById(inputId);
        if (!input || !input.value) return '';
        const dlId = input.getAttribute('list');
        const dl = document.getElementById(dlId);
        if (!dl) return input.value; // fallback: return raw value (for property which uses name as id)
        const opt = [...dl.options].find(o => o.value === input.value);
        return opt ? opt.getAttribute('data-id') : '';
    }

    function triggerReconciliation(btn) {
        btn.textContent = 'Analysing...';
        btn.disabled = true;
        btn.style.background = '#64748b';
        document.getElementById('reconStatus').textContent = 'Matching unreconciled transactions...';
        setTimeout(() => {
            try {
                const results = runReconciliationMatching();
                showReconciliationPanel(results);
                btn.textContent = 'Run Reconciliation';
                btn.style.background = '#2563eb';
                btn.disabled = false;
                document.getElementById('reconStatus').textContent = `Found ${results.length} transactions`;
            } catch (e) {
                console.error('Reconciliation error:', e);
                btn.textContent = 'Failed';
                btn.style.background = '#dc2626';
                document.getElementById('reconStatus').textContent = 'Error: ' + e.message;
                setTimeout(() => { btn.textContent = 'Run Reconciliation'; btn.style.background = '#2563eb'; btn.disabled = false; }, 3000);
            }
        }, 100);
    }

    // Build a lookup of historical patterns from ALL reconciled transactions
    // Helper to extract a linked record ID from Airtable field data
    function extractLinkedId(field) {
        if (!field) return null;
        if (Array.isArray(field)) {
            const first = field[0];
            if (!first) return null;
            return typeof first === 'object' ? first.id : first;
        }
        return typeof field === 'object' ? field.id : field;
    }

    // Normalise text → lowercase, strip non-alphanumeric, collapse whitespace
    function reconNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim(); }

    // Extract meaningful description tokens (skip very short or purely numeric fragments)
    function reconDescTokens(desc) {
        return reconNorm(desc).split(/\s+/).filter(w => w.length >= 2 && !/^\d{1,2}$/.test(w));
    }

    function buildHistoricalPatterns() {
        // Two separate indexes:
        //   composite  — vendor+description → all fields (tenancy, unit, property, etc.)
        //   vendorOnly — vendor alone       → stable fields only (cat, subcat, biz, cost)
        const composite = {};   // key → { ...allFields, count }
        const vendorOnly = {};  // key → { catId, subCatId, bizId, costId, count }

        function addComposite(key, data) {
            if (!key || key.length < 4) return;
            if (!composite[key]) { composite[key] = { count: 0, ...data }; }
            composite[key].count++;
            if (data.subCatId)  composite[key].subCatId  = data.subCatId;
            if (data.catId)     composite[key].catId     = data.catId;
            if (data.bizId)     composite[key].bizId     = data.bizId;
            if (data.costId)    composite[key].costId    = data.costId;
            if (data.tenancyId) composite[key].tenancyId = data.tenancyId;
            if (data.unitId)    composite[key].unitId    = data.unitId;
        }

        function addVendorOnly(key, data) {
            if (!key || key.length < 2) return;
            if (!vendorOnly[key]) { vendorOnly[key] = { count: 0 }; }
            vendorOnly[key].count++;
            // Stable fields only — no tenancy/unit
            if (data.subCatId) vendorOnly[key].subCatId = data.subCatId;
            if (data.catId)    vendorOnly[key].catId    = data.catId;
            if (data.bizId)    vendorOnly[key].bizId    = data.bizId;
            if (data.costId)   vendorOnly[key].costId   = data.costId;
        }

        allTransactions.forEach(tx => {
            if (!getField(tx, F.txReconciled)) return;

            const data = {
                subCatId:  extractLinkedId(getField(tx, F.txSubCategory)),
                catId:     extractLinkedId(getField(tx, F.txCategory)),
                bizId:     extractLinkedId(getField(tx, F.txBusiness)),
                costId:    extractLinkedId(getField(tx, F.txCost)),
                tenancyId: extractLinkedId(getField(tx, F.txTenancy)),
                unitId:    extractLinkedId(getField(tx, F.txUnit)),
            };

            if (!data.subCatId && !data.catId && !data.costId && !data.tenancyId) return;

            const vendor = reconNorm(getField(tx, F.txVendor));
            const vWords = vendor.split(/\s+/).filter(w => w.length >= 2);
            const dTokens = reconDescTokens(getField(tx, F.txDescription));

            // ── Vendor-only keys (stable fields) ──
            if (vWords.length >= 1) addVendorOnly(vWords[0], data);
            if (vWords.length >= 2) addVendorOnly(vWords.slice(0, 2).join(' '), data);
            if (vWords.length >= 3) addVendorOnly(vWords.slice(0, 3).join(' '), data);

            // ── Composite keys: vendor + description (all fields inc. tenancy/unit) ──
            // Combine vendor prefix with description tokens at multiple granularities
            // This is what differentiates "British Gas | 123 High St" from "British Gas | 456 Park Lane"
            const vPrefix = vWords.slice(0, 2).join(' ') || (vWords[0] || '');
            if (vPrefix && dTokens.length >= 2) {
                addComposite(vPrefix + '|' + dTokens.slice(0, 2).join(' '), data);
            }
            if (vPrefix && dTokens.length >= 3) {
                addComposite(vPrefix + '|' + dTokens.slice(0, 3).join(' '), data);
            }
            if (vPrefix && dTokens.length >= 4) {
                addComposite(vPrefix + '|' + dTokens.slice(0, 4).join(' '), data);
            }
            // Full description fingerprint (most specific — catches identical recurring transactions)
            if (vPrefix && dTokens.length >= 2) {
                addComposite(vPrefix + '|' + dTokens.join(' '), data);
            }

            // Description-only keys (for transactions with no vendor)
            if (!vendor && dTokens.length >= 2) {
                addVendorOnly(dTokens.slice(0, 2).join(' '), data);
                addVendorOnly(dTokens.slice(0, 3).join(' '), data);
                // Also composite from description alone
                if (dTokens.length >= 4) addComposite('|' + dTokens.slice(0, 4).join(' '), data);
                if (dTokens.length >= 2) addComposite('|' + dTokens.join(' '), data);
            }
        });
        return { composite, vendorOnly };
    }

    function runReconciliationMatching() {
        const results = [];
        // Include ALL accounts for reconciliation (not just Santander + TNT)
        const unrec = allTransactions.filter(r => !getField(r, F.txReconciled));

        // 1. Build historical patterns from ALL reconciled transactions
        const { composite: compositePatterns, vendorOnly: vendorOnlyPatterns } = buildHistoricalPatterns();

        // 2. Build tenancy lookup for enrichment
        const tenantLookup = buildTenantLookup();
        const tenancyLookup = {};
        allTenancies.forEach(r => { tenancyLookup[r.id] = r; });
        const costLookup = {};
        allCosts.forEach(r => { costLookup[r.id] = r; });

        unrec.forEach(tx => {
            const amt = Number(getField(tx, F.txReportAmount)) || 0;
            const rawAmt = Number(getField(tx, F.txAmount)) || 0;
            const vendor = String(getField(tx, F.txVendor) || '');
            const desc = String(getField(tx, F.txDescription) || '');
            const txDate = getField(tx, F.txDate) || '';
            const txId = tx.id;

            const result = {
                txId, txDate, txVendor: vendor, txDesc: desc,
                txAmount: amt || rawAmt,
                categoryId: '', categoryName: '',
                subCatId: '', subCatName: '',
                businessId: '', businessName: '',
                tenantName: '', tenantId: '', tenancyLabel: '', tenancyId: '',
                unitName: '', unitId: '', propertyName: '',
                costLabel: '', costId: '',
                matchType: '', score: 0, status: 'unmatched',
            };

            // Build candidate keys
            const vWords = reconNorm(vendor).split(/\s+/).filter(w => w.length >= 2);
            const dTokens = reconDescTokens(desc);
            const vPrefix = vWords.slice(0, 2).join(' ') || (vWords[0] || '');

            // Vendor-only keys (most specific first)
            const vendorKeys = [];
            if (vWords.length >= 3) vendorKeys.push(vWords.slice(0, 3).join(' '));
            if (vWords.length >= 2) vendorKeys.push(vWords.slice(0, 2).join(' '));
            if (vWords.length >= 1) vendorKeys.push(vWords[0]);
            // Description-only fallback keys
            if (!vPrefix && dTokens.length >= 3) vendorKeys.push(dTokens.slice(0, 3).join(' '));
            if (!vPrefix && dTokens.length >= 2) vendorKeys.push(dTokens.slice(0, 2).join(' '));

            // Composite keys: vendor+description (most specific first)
            const compositeKeys = [];
            const vp = vPrefix || '';
            if (vp && dTokens.length >= 2) {
                compositeKeys.push(vp + '|' + dTokens.join(' '));                       // full desc
                if (dTokens.length >= 4) compositeKeys.push(vp + '|' + dTokens.slice(0, 4).join(' '));
                if (dTokens.length >= 3) compositeKeys.push(vp + '|' + dTokens.slice(0, 3).join(' '));
                compositeKeys.push(vp + '|' + dTokens.slice(0, 2).join(' '));
            }
            if (!vp && dTokens.length >= 2) {
                compositeKeys.push('|' + dTokens.join(' '));
                if (dTokens.length >= 4) compositeKeys.push('|' + dTokens.slice(0, 4).join(' '));
            }

            // ── Priority 1: Knowledge base (user corrections — highest priority) ──
            let matched = false;
            for (const key of vendorKeys) {
                const rule = findReconRule(key);
                if (rule && (rule.subCatId || rule.costId || rule.tenancyId)) {
                    applyRuleToResult(result, rule, 'Knowledge Base', rule.confidence || 5);
                    matched = true;
                    break;
                }
            }

            // ── Priority 2: Composite match (vendor+description → all fields inc. tenancy/unit/property) ──
            if (!matched) {
                for (const key of compositeKeys) {
                    const hit = compositePatterns[key];
                    if (hit && hit.count >= 1) {
                        applyHistoricalToResult(result, hit, tenancyLookup, tenantLookup, costLookup, hit.count, true);
                        matched = true;
                        break;
                    }
                }
            }

            // ── Priority 3: Vendor-only match (stable fields only — cat/subcat/biz/cost) ──
            if (!matched) {
                for (const key of vendorKeys) {
                    const hit = vendorOnlyPatterns[key];
                    if (hit && hit.count >= 1) {
                        applyHistoricalToResult(result, hit, tenancyLookup, tenantLookup, costLookup, hit.count, false);
                        matched = true;
                        break;
                    }
                }
            }

            results.push(result);
        });

        results.sort((a, b) => {
            if (a.status === 'suggestion' && b.status !== 'suggestion') return -1;
            if (a.status !== 'suggestion' && b.status === 'suggestion') return 1;
            return b.score - a.score;
        });
        return results;
    }

    function applyRuleToResult(result, rule, matchType, score) {
        result.subCatId = rule.subCatId || '';
        result.subCatName = rule.subCatName || getSubCatName(rule.subCatId);
        result.categoryId = rule.categoryId || '';
        result.categoryName = rule.categoryName || getCatName(rule.categoryId);
        result.businessId = rule.businessId || '';
        result.businessName = rule.businessName || '';
        result.costLabel = rule.costLabel || '';
        result.costId = rule.costId || '';
        result.tenantName = rule.tenantName || '';
        result.tenancyLabel = rule.tenancyLabel || '';
        result.tenancyId = rule.tenancyId || '';
        result.unitName = rule.unitName || '';
        result.unitId = rule.unitId || '';
        result.propertyName = rule.propertyName || '';
        result.matchType = matchType;
        result.score = score;
        result.status = 'suggestion';
    }

    // includeVariableFields: true = composite match (apply tenancy/unit/property)
    //                        false = vendor-only match (stable fields only — leave variable fields blank)
    function applyHistoricalToResult(result, hist, tenancyLookup, tenantLookup, costLookup, count, includeVariableFields) {
        // Stable fields — always applied
        result.subCatId = hist.subCatId || '';
        result.subCatName = getSubCatName(hist.subCatId);
        result.categoryId = hist.catId || '';
        result.categoryName = getCatName(hist.catId);
        result.businessId = hist.bizId || '';

        // Cost — stable per vendor, always applied
        if (hist.costId && costLookup[hist.costId]) {
            const cost = costLookup[hist.costId];
            result.costId = hist.costId;
            result.costLabel = String(getField(cost, F.costName) || '');
        }

        // Variable fields — only applied from composite (vendor+description) matches
        if (includeVariableFields) {
            result.unitId = hist.unitId || '';

            if (hist.tenancyId && tenancyLookup[hist.tenancyId]) {
                const ten = tenancyLookup[hist.tenancyId];
                result.tenancyId = hist.tenancyId;
                result.tenancyLabel = String(getField(ten, F.tenRef) || '');
                const tenant = getTenantForTenancy(ten, tenantLookup);
                result.tenantName = tenant ? String(getField(tenant, F.tenantName) || '') : '';
                result.tenantId = tenant ? tenant.id : '';
                const unitRef = getField(ten, F.tenUnitRef);
                result.unitName = Array.isArray(unitRef) ? unitRef[0] : (unitRef || '');
                const prop = getField(ten, F.tenProperty);
                result.propertyName = Array.isArray(prop) ? prop[0] : (prop || '');
            }
        }
        // When includeVariableFields is false, tenancy/tenant/unit/property stay blank
        // — better to leave empty than guess wrong

        const matchLabel = includeVariableFields ? `Composite (${count}x)` : `Vendor (${count}x)`;
        result.matchType = matchLabel;
        result.score = includeVariableFields ? Math.min(count + 4, 10) : Math.min(count + 2, 8);
        result.status = 'suggestion';
    }

    function showReconciliationPanel(results) {
        const existing = document.getElementById('reconPanel');
        if (existing) existing.remove();
        const matched = results.filter(r => r.status === 'suggestion').length;
        const unmatched = results.length - matched;
        const thStyle = 'padding:6px;text-align:left;font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;white-space:nowrap';

        const panel = document.createElement('div');
        panel.id = 'reconPanel';
        panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:10px';

        panel.innerHTML = `
        <div style="background:white;border-radius:12px;max-width:98vw;width:100%;max-height:95vh;display:flex;flex-direction:column;box-shadow:0 25px 50px rgba(0,0,0,0.25)">
            <div style="padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
                <div>
                    <h2 style="font-size:16px;font-weight:700;color:#1e293b;margin:0">Transaction Reconciliation</h2>
                    <p style="font-size:11px;color:#64748b;margin:3px 0 0">${results.length} unreconciled · ${matched} suggestions · ${unmatched} unmatched</p>
                </div>
                <div style="display:flex;gap:6px">
                    <button onclick="approveAllRecon()" style="padding:6px 14px;font-size:11px;font-weight:600;background:#16a34a;color:white;border:none;border-radius:6px;cursor:pointer">Approve All Transactions</button>
                    <button onclick="closeReconPanel()" style="padding:6px 14px;font-size:11px;font-weight:600;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer">Close</button>
                </div>
            </div>
            <div style="overflow:auto;padding:8px 12px">
                <table style="width:100%;border-collapse:collapse;font-size:11px;min-width:1200px">
                    <thead>
                        <tr style="border-bottom:2px solid #e2e8f0">
                            <th style="${thStyle}">#</th>
                            <th style="${thStyle}">Date</th>
                            <th style="${thStyle}">Vendor / Description</th>
                            <th style="${thStyle};text-align:right">Amount</th>
                            <th style="${thStyle}">Category</th>
                            <th style="${thStyle}">Sub-Category</th>
                            <th style="${thStyle}">Business</th>
                            <th style="${thStyle}">Tenant</th>
                            <th style="${thStyle}">Tenancy</th>
                            <th style="${thStyle}">Rental Unit</th>
                            <th style="${thStyle}">Property</th>
                            <th style="${thStyle}">Cost</th>
                            <th style="${thStyle};text-align:center">Action</th>
                        </tr>
                    </thead>
                    <tbody id="reconTableBody">
                        ${results.map((r, i) => reconRowHtml(r, i)).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
        document.body.appendChild(panel);
        window._reconResults = results;
        // Snapshot original AI suggestions for accuracy tracking
        window._reconOriginals = results.map(r => ({
            categoryId: r.categoryId, subCatId: r.subCatId,
            businessId: r.businessId, tenancyId: r.tenancyId,
            unitId: r.unitId, costId: r.costId,
            status: r.status
        }));
    }

    function reconRowHtml(r, i) {
        const amtClass = r.txAmount >= 0 ? 'text-green' : 'text-red';
        const cell = 'padding:5px 6px;vertical-align:top;font-size:11px';
        const dim = 'color:#94a3b8;font-size:10px';
        const catSelect = buildCatDropdown('recon-cat-' + i, r.categoryId);
        const subCatSelect = buildSubCatDropdown('recon-subcat-' + i, r.subCatId);

        const actionHtml = r.status === 'approved'
            ? `<span style="color:#16a34a;font-weight:600;font-size:10px">Done ✓</span>`
            : `<button id="recon-btn-${i}" class="cfv-action-btn success" onclick="approveRecon(${i})" style="font-size:10px;min-width:55px">Approve</button>`;

        const matchBadge = r.matchType ? `<span style="font-size:9px;color:#2563eb;font-weight:600">${escHtml(r.matchType)}</span>` : '';

        return `<tr id="recon-row-${i}" style="border-bottom:1px solid #f1f5f9;${r.status === 'approved' ? 'opacity:0.5;' : ''}">
            <td style="${cell};color:#94a3b8;font-weight:600">${i + 1}</td>
            <td style="${cell};white-space:nowrap">${escHtml(r.txDate)}</td>
            <td style="${cell};max-width:180px"><strong>${escHtml(r.txVendor)}</strong><br><span style="${dim}">${escHtml(r.txDesc).substring(0, 60)}</span><br>${matchBadge}</td>
            <td style="${cell};text-align:right;font-weight:600;font-variant-numeric:tabular-nums" class="${amtClass}">${fmt(Math.abs(r.txAmount))}</td>
            <td style="${cell}">${catSelect}</td>
            <td style="${cell}">${subCatSelect}</td>
            <td style="${cell}">${buildBusinessDropdown('recon-business-' + i, r.businessId || '')}</td>
            <td style="${cell}">${buildTenantDropdown('recon-tenant-' + i, r.tenantId || '')}</td>
            <td style="${cell}" onchange="reconTenancyChanged(${i})">${buildTenancyDropdown('recon-tenancy-' + i, r.tenancyId || '')}</td>
            <td style="${cell}">${buildRentalUnitDropdown('recon-unit-' + i, r.unitId || '')}</td>
            <td style="${cell}">${buildPropertyDropdown('recon-property-' + i, r.propertyName || '')}</td>
            <td style="${cell}">${buildCostDropdown('recon-cost-' + i, r.costId || '')}</td>
            <td style="${cell};text-align:center;min-width:60px">${actionHtml}</td>
        </tr>`;
    }

    function reconCatChanged(idx) {
        const sel = document.getElementById('recon-cat-' + idx);
        if (sel) window._reconResults[idx].categoryId = sel.value;
    }
    function reconSubCatChanged(idx) {
        const sel = document.getElementById('recon-subcat-' + idx);
        if (sel) {
            window._reconResults[idx].subCatId = sel.value;
            window._reconResults[idx].subCatName = getSubCatName(sel.value);
        }
    }
    // When tenancy input changes, auto-fill tenant, unit, property
    // Attach this via onchange on the tenancy input
    function reconTenancyChanged(idx) {
        const input = document.getElementById('recon-tenancy-' + idx);
        if (!input || !input.value) return;
        const tenancyId = resolveDropdownId('recon-tenancy-' + idx);
        const tenancy = allTenancies.find(t => t.id === tenancyId);
        if (!tenancy) return;
        const tLookup = buildTenantLookup();
        const tenant = getTenantForTenancy(tenancy, tLookup);

        // Set tenant input
        const tenantInput = document.getElementById('recon-tenant-' + idx);
        if (tenantInput && tenant) tenantInput.value = getField(tenant, F.tenantName) || '';

        // Set unit input
        const unitRef = getField(tenancy, F.tenUnitRef);
        const unitInput = document.getElementById('recon-unit-' + idx);
        if (unitInput) unitInput.value = Array.isArray(unitRef) ? unitRef[0] : (unitRef || '');

        // Set property input
        const propField = getField(tenancy, F.tenProperty);
        const propInput = document.getElementById('recon-property-' + idx);
        if (propInput) propInput.value = Array.isArray(propField) ? propField[0] : (propField || '');

        // Set sub-category to Rental Income if empty
        const subCatInput = document.getElementById('recon-subcat-' + idx);
        if (subCatInput && !subCatInput.value) subCatInput.value = getSubCatName(REC.subRentalInc);
    }

    function toggleAmendRow(idx) {
        const row = document.getElementById('recon-amend-' + idx);
        if (row) {
            row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
            const input = document.getElementById('recon-amend-input-' + idx);
            if (input) input.focus();
        }
    }

    function applyAmendment(idx) {
        const input = document.getElementById('recon-amend-input-' + idx);
        const text = (input ? input.value : '').toLowerCase().trim();
        if (!text) return;
        const r = window._reconResults[idx];

        // Match against sub-category names
        allSubCategories.forEach(sc => {
            const name = (getField(sc, 'fldO4BTJhFv5EsN6i') || '').toLowerCase();
            if (name && text.includes(name)) { r.subCatId = sc.id; r.subCatName = getField(sc, 'fldO4BTJhFv5EsN6i'); }
        });
        // Match against category names
        allCategories.forEach(cat => {
            const name = (getField(cat, 'fldii4oUzSfmplihO') || '').toLowerCase();
            if (name && text.includes(name)) { r.categoryId = cat.id; r.categoryName = getField(cat, 'fldii4oUzSfmplihO'); }
        });
        // Match against tenant names
        allTenants.forEach(t => {
            const name = (getField(t, F.tenantName) || '').toLowerCase();
            if (name && name.length >= 3 && text.includes(name)) { r.tenantName = getField(t, F.tenantName); r.tenantId = t.id; }
        });
        // Match against tenancy references
        allTenancies.forEach(ten => {
            const surname = (getField(ten, F.tenSurname) || '').toLowerCase();
            if (surname && surname.length >= 3 && text.includes(surname)) {
                r.tenancyLabel = getField(ten, F.tenRef) || '';
                r.tenancyId = ten.id;
                r.tenantName = r.tenantName || getField(ten, F.tenSurname);
                const unitRef = getField(ten, F.tenUnitRef);
                const property = getField(ten, F.tenProperty);
                const unitId = getField(ten, F.tenUnit);
                r.unitName = Array.isArray(unitRef) ? unitRef[0] : (unitRef || '');
                r.unitId = Array.isArray(unitId) ? unitId[0] : unitId;
                r.propertyName = Array.isArray(property) ? property[0] : (property || '');
            }
        });
        // Match against cost names
        allCosts.forEach(c => {
            const name = (getField(c, F.costName) || '').toLowerCase();
            if (name && name.length >= 3 && text.includes(name)) { r.costLabel = getField(c, F.costName); r.costId = c.id; }
        });

        r.status = 'suggestion';
        r.matchType = 'Amended';

        // Re-render just this row
        const row = document.getElementById('recon-row-' + idx);
        const amendRow = document.getElementById('recon-amend-' + idx);
        if (row && amendRow) {
            const temp = document.createElement('tbody');
            temp.innerHTML = reconRowHtml(r, idx);
            row.replaceWith(temp.children[0]);
            amendRow.replaceWith(temp.children[0] || document.createElement('tr'));
        }
        // Simpler: just re-render the whole table
        const tbody = document.getElementById('reconTableBody');
        if (tbody) tbody.innerHTML = window._reconResults.map((r, i) => reconRowHtml(r, i)).join('');
    }

    // ── AI Reconciliation Accuracy Tracking ──
    // Persistent audit log lives in the Airtable "AI Recon Audit" table (TABLES.reconAudit).
    // Design for performance as the data accumulates:
    //   - Every write auto-prunes rows older than 35 days, so the table never grows past ~1 month.
    //   - Every read uses server-side filterByFormula (last 31 days), so the response is always small.
    //   - Last-known stats are mirrored to localStorage for instant page paints; background refresh
    //     reconciles with Airtable and updates the card in place.
    // The dashboard used to store this log in localStorage only — the data was wiped on Apr 2026
    // when the browser cleared site storage. Moving to Airtable makes it survive browser resets
    // and available across devices.

    const RECON_CACHE_KEY = '_recon_accuracy_cache';
    let _reconStatsCache = null; // in-memory mirror of cache (saves one JSON.parse on refresh)

    // Shared markup for the "AI Reconciliation Accuracy" KPI card. Used by both the initial
    // cached render in dashboard.js and the async refresh that swaps in fresh data — single
    // source of truth so the two paths can never drift.
    function buildAccuracyKPIHtml(stats) {
        if (!stats) return '';
        return `
            <div class="kpi-card">
                <div class="kpi-card-label">AI Reconciliation Accuracy</div>
                <div class="kpi-card-value" style="color:${stats.colour}">${stats.pct}%</div>
                <div class="kpi-card-sub">${stats.accurate}/${stats.total} correct — last 31 days</div>
                <div style="margin-top:8px;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden">
                    <div style="height:100%;width:${stats.pct}%;background:${stats.colour};border-radius:3px;transition:width 0.3s"></div>
                </div>
                <div style="margin-top:6px;font-size:10px;color:#94a3b8">Target: ≥90% <span style="color:#16a34a">●</span> 75–89% <span style="color:#d97706">●</span> &lt;75% <span style="color:#ef4444">●</span></div>
            </div>`;
    }

    // Synchronous — returns cached stats for an instant render. Call refreshReconAccuracyStats()
    // in the background to update.
    function getReconAccuracyStats() {
        if (_reconStatsCache) return _reconStatsCache;
        try {
            const raw = localStorage.getItem(RECON_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (parsed && parsed.stats) {
                _reconStatsCache = parsed.stats;
                return parsed.stats;
            }
        } catch {}
        return null;
    }

    // Fetch the last 31 days of audit rows from Airtable, recompute stats, update the cache.
    // Returns the fresh stats (or null when there are no recent rows).
    async function refreshReconAccuracyStats() {
        if (typeof PAT === 'undefined' || !PAT) return _reconStatsCache; // not authed yet
        try {
            // Server-side: only rows where Date is within the last 31 days. Payload stays tiny.
            const formula = encodeURIComponent(`IS_AFTER({Date}, DATEADD(TODAY(), -31, 'days'))`);
            const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLES.reconAudit}?pageSize=100&filterByFormula=${formula}&returnFieldsByFieldId=true`;
            const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + PAT } });
            if (!resp.ok) return _reconStatsCache;
            const data = await resp.json();
            const records = data.records || [];
            if (records.length === 0) {
                _reconStatsCache = null;
                localStorage.removeItem(RECON_CACHE_KEY);
                return null;
            }
            const total = records.length;
            const accurate = records.filter(r => r.fields && r.fields[RECAUDIT.wasAccurate]).length;
            const pct = Math.round((accurate / total) * 100);
            const colour = pct >= 90 ? '#16a34a' : pct >= 75 ? '#d97706' : '#ef4444';
            const label = pct >= 90 ? 'green' : pct >= 75 ? 'amber' : 'red';
            const stats = { total, accurate, pct, colour, label };
            _reconStatsCache = stats;
            try { localStorage.setItem(RECON_CACHE_KEY, JSON.stringify({ ts: Date.now(), stats })); } catch {}
            return stats;
        } catch (e) {
            console.warn('refreshReconAccuracyStats failed:', e);
            return _reconStatsCache;
        }
    }

    // Write one audit row. Fire-and-forget from the caller — errors are logged but don't block
    // the approval flow. Also kicks off a prune of rows older than 35 days so the table self-cleans.
    async function logReconAccuracy(txId, wasAccurate) {
        if (typeof PAT === 'undefined' || !PAT) return;
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.reconAudit}`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: {
                    [RECAUDIT.txId]: txId,
                    [RECAUDIT.date]: new Date().toISOString().slice(0, 10),
                    [RECAUDIT.wasAccurate]: !!wasAccurate,
                }}),
            });
            if (!resp.ok) {
                console.warn('logReconAccuracy write failed:', resp.status);
                return;
            }
            // Background housekeeping — don't await, don't block
            pruneStaleAudit().catch(() => {});
            refreshReconAccuracyStats().catch(() => {});
        } catch (e) {
            console.warn('logReconAccuracy exception:', e);
        }
    }

    // Delete audit rows older than 35 days. Keeps the table small so reads stay fast.
    // Runs in batches of 10 (Airtable's max per delete request).
    async function pruneStaleAudit() {
        if (typeof PAT === 'undefined' || !PAT) return;
        try {
            const formula = encodeURIComponent(`IS_BEFORE({Date}, DATEADD(TODAY(), -35, 'days'))`);
            const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLES.reconAudit}?pageSize=100&filterByFormula=${formula}`;
            const resp = await fetch(url, { headers: { 'Authorization': 'Bearer ' + PAT } });
            if (!resp.ok) return;
            const data = await resp.json();
            const ids = (data.records || []).map(r => r.id);
            if (ids.length === 0) return;
            for (let i = 0; i < ids.length; i += 10) {
                const batch = ids.slice(i, i + 10);
                const params = new URLSearchParams();
                batch.forEach(id => params.append('records[]', id));
                await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.reconAudit}?${params.toString()}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + PAT },
                });
            }
        } catch (e) {
            console.warn('pruneStaleAudit failed:', e);
        }
    }

    // One-shot migration from the legacy localStorage log ("_recon_accuracy_log") to Airtable.
    // Runs on first dashboard load after this code ships; flips a flag once complete so we never
    // re-run it. Safe to call repeatedly — no-op after the flag is set.
    async function migrateLocalReconLog() {
        if (localStorage.getItem('_recon_audit_migrated') === '1') return;
        if (typeof PAT === 'undefined' || !PAT) return;
        let old;
        try { old = JSON.parse(localStorage.getItem('_recon_accuracy_log') || '[]'); } catch { old = []; }
        if (!Array.isArray(old) || old.length === 0) {
            localStorage.setItem('_recon_audit_migrated', '1');
            localStorage.removeItem('_recon_accuracy_log');
            return;
        }
        try {
            for (let i = 0; i < old.length; i += 10) {
                const batch = old.slice(i, i + 10);
                const records = batch
                    .filter(e => e && e.txId)
                    .map(e => ({ fields: {
                        [RECAUDIT.txId]: String(e.txId),
                        [RECAUDIT.date]: e.date || new Date().toISOString().slice(0, 10),
                        [RECAUDIT.wasAccurate]: !!e.wasAccurate,
                    }}));
                if (records.length === 0) continue;
                const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.reconAudit}`, {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ records }),
                });
                if (!resp.ok) throw new Error('Migration batch failed: HTTP ' + resp.status);
            }
            localStorage.setItem('_recon_audit_migrated', '1');
            localStorage.removeItem('_recon_accuracy_log');
            refreshReconAccuracyStats().catch(() => {});
        } catch (e) {
            // Don't set the flag — will retry next load
            console.warn('migrateLocalReconLog failed, will retry next load:', e);
        }
    }

    async function approveRecon(idx) {
        const r = window._reconResults[idx];
        if (r.status === 'approved') return; // already done
        const btn = document.getElementById('recon-btn-' + idx);
        if (btn) { btn.textContent = '...'; btn.disabled = true; }

        const fields = { [F.txReconciled]: true };

        const catId = resolveDropdownId('recon-cat-' + idx);
        const subCatId = resolveDropdownId('recon-subcat-' + idx);
        const businessId = resolveDropdownId('recon-business-' + idx);
        const tenancyId = resolveDropdownId('recon-tenancy-' + idx);
        const unitId = resolveDropdownId('recon-unit-' + idx);
        const costId = resolveDropdownId('recon-cost-' + idx);

        if (catId) fields[F.txCategory] = [catId];
        if (subCatId) fields[F.txSubCategory] = [subCatId];
        if (businessId) fields[F.txBusiness] = [businessId];
        if (tenancyId) fields[F.txTenancy] = [tenancyId];
        if (unitId) fields[F.txUnit] = [unitId];
        if (costId) fields[F.txCost] = [costId];

        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${r.txId}`, {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields })
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            const msg = `Row ${idx + 1} failed: ${err.error?.message || resp.status}`;
            console.error(msg);
            if (btn) { btn.textContent = 'Failed'; btn.disabled = false; }
            throw new Error(msg);
        }

        r.status = 'approved';

        // Sync local allTransactions so CFV detection sees the reconciled status immediately
        const localTx = allTransactions.find(t => t.id === r.txId);
        if (localTx) {
            if (!localTx.fields) localTx.fields = {};
            localTx.fields[F.txReconciled] = true;
            if (catId) localTx.fields[F.txCategory] = [catId];
            if (tenancyId) localTx.fields[F.txTenancy] = [{ id: tenancyId }];
        }
        // Re-run CFV sidebar badge count so cleared CFVs disappear immediately
        if (typeof updateCFVSidebarBadges === 'function' && typeof detectCFVs === 'function') {
            try {
                const cfvList = detectCFVs();
                const visible = cfvList.filter(e => {
                    if (e.status === 'cfv' || e.status === 'potential') return !localStorage.getItem('cfv_dismissed_' + e.tenancyId);
                    return true;
                });
                const cfvCount = visible.filter(e => e.status === 'cfv' || e.status === 'potential').length;
                const actionedCount = visible.filter(e => e.status === 'cfv actioned').length;
                updateCFVSidebarBadges(cfvCount, actionedCount);
            } catch (e) { /* non-critical */ }
        }

        // Track AI reconciliation accuracy
        const orig = (window._reconOriginals || [])[idx];
        if (orig && orig.status === 'suggestion') {
            const final = { categoryId: catId, subCatId, businessId, tenancyId, unitId, costId };
            const wasAccurate = ['categoryId', 'subCatId', 'businessId', 'tenancyId', 'unitId', 'costId']
                .every(f => (final[f] || '') === (orig[f] || ''));
            logReconAccuracy(r.txId, wasAccurate);
        }

        const getInputVal = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
        const vendorKey = r.txVendor.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/).slice(0, 3).join(' ');
        if (vendorKey.length >= 3) {
            saveReconRule(vendorKey, {
                subCatId, subCatName: getInputVal('recon-subcat-' + idx),
                categoryId: catId, categoryName: getInputVal('recon-cat-' + idx),
                businessId, businessName: getInputVal('recon-business-' + idx),
                costLabel: getInputVal('recon-cost-' + idx), costId,
                tenantName: getInputVal('recon-tenant-' + idx),
                tenancyLabel: getInputVal('recon-tenancy-' + idx), tenancyId,
                unitName: getInputVal('recon-unit-' + idx), unitId,
                propertyName: getInputVal('recon-property-' + idx),
            });
        }

        if (btn) { btn.textContent = '✓'; btn.style.background = '#dcfce7'; btn.style.color = '#16a34a'; }
        const row = document.getElementById('recon-row-' + idx);
        if (row) row.style.opacity = '0.5';

        // Mark that recon state has changed so the panel close / next load skips the stale cache
        window._reconChanged = true;
        if (typeof clearDashCache === 'function') clearDashCache();
    }

    async function approveAllRecon() {
        const results = window._reconResults || [];

        // A row is approveable if it's not already done AND has at least one field filled in
        // (either an AI suggestion OR a manually-picked dropdown value).
        // This stops "Approve All" from silently skipping rows the user filled in by hand.
        const rowHasData = (i) =>
            !!(resolveDropdownId('recon-cat-' + i) ||
               resolveDropdownId('recon-subcat-' + i) ||
               resolveDropdownId('recon-business-' + i) ||
               resolveDropdownId('recon-tenant-' + i) ||
               resolveDropdownId('recon-tenancy-' + i) ||
               resolveDropdownId('recon-unit-' + i) ||
               resolveDropdownId('recon-property-' + i) ||
               resolveDropdownId('recon-cost-' + i));

        const approveIdxs = [];
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === 'approved') continue;
            if (results[i].status === 'suggestion' || rowHasData(i)) approveIdxs.push(i);
        }
        const skipped = results.filter(r => r.status !== 'approved').length - approveIdxs.length;

        if (approveIdxs.length === 0) { alert('No transactions to approve. Fill in at least one field on a row first.'); return; }
        const skipMsg = skipped > 0 ? ` (${skipped} empty row${skipped === 1 ? '' : 's'} will be skipped — fill in a field to include them)` : '';
        if (!confirm(`Approve ${approveIdxs.length} transaction${approveIdxs.length === 1 ? '' : 's'}? This will mark them as reconciled in Airtable.${skipMsg}`)) return;

        let successCount = 0;
        let failCount = 0;
        const statusEl = document.getElementById('reconStatus');
        for (const i of approveIdxs) {
            if (statusEl) statusEl.textContent = `Processing ${successCount + failCount + 1} of ${approveIdxs.length}...`;

            // Try up to 3 attempts per transaction
            let succeeded = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    await approveRecon(i);
                    successCount++;
                    succeeded = true;
                    break;
                } catch (e) {
                    const isRateLimit = e.message && (e.message.includes('429') || e.message.includes('RATE_LIMIT'));
                    const isServerError = e.message && (e.message.includes('500') || e.message.includes('502') || e.message.includes('503'));
                    if ((isRateLimit || isServerError) && attempt < 2) {
                        // Wait longer on each retry: 2s, then 5s
                        await new Promise(r => setTimeout(r, attempt === 0 ? 2000 : 5000));
                    } else {
                        console.error(`Row ${i} failed after ${attempt + 1} attempts:`, e.message);
                        failCount++;
                        break;
                    }
                }
            }
            // 500ms pause between requests — more conservative to avoid rate limits on large batches
            await new Promise(r => setTimeout(r, 500));
        }
        document.getElementById('reconStatus').textContent = `Done: ${successCount} approved${failCount > 0 ? ', ' + failCount + ' failed' : ''} — refreshing...`;
        // Bust the stale-while-revalidate cache so the refresh shows fresh numbers, not the pre-approval ones
        if (typeof clearDashCache === 'function') clearDashCache();
        window._reconChanged = false; // consumed by this refresh
        setTimeout(() => loadDashboard(), 2000);
    }

    // Close the recon panel; if any rows were approved while it was open, trigger a dashboard refresh
    function closeReconPanel() {
        const panel = document.getElementById('reconPanel');
        if (panel) panel.remove();
        if (window._reconChanged) {
            window._reconChanged = false;
            if (typeof clearDashCache === 'function') clearDashCache();
            loadDashboard();
        }
    }

