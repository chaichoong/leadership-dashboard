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

    // Helper: get property record ID from a rental unit record ID
    function getPropertyIdFromUnit(unitId) {
        if (!unitId) return '';
        const unit = (allRentalUnits || []).find(u => u.id === unitId);
        if (!unit) return '';
        const propLink = getField(unit, F.unitProperty);
        return Array.isArray(propLink) ? (propLink[0] || '') : (propLink || '');
    }

    // Helper: find category record ID by name
    function findCategoryIdByName(name) {
        if (!name) return '';
        const lower = name.toLowerCase();
        const rec = allCategories.find(r => (getField(r, 'fldii4oUzSfmplihO') || '').toLowerCase() === lower);
        return rec ? rec.id : '';
    }

    // Helper: find business record ID by name
    function findBusinessIdByName(name) {
        if (!name) return '';
        const lower = name.toLowerCase();
        const rec = (allBusinesses || []).find(r => (getField(r, 'fldbbRqVxLxUdHwIR') || '').toLowerCase() === lower);
        return rec ? rec.id : '';
    }

    // Build dropdown options for reconciliation columns
    // ── Searchable dropdown helpers ──
    // Uses <input list="datalist"> for type-to-search. All sorted A-Z.
    // Each returns { datalist, inputValue } — datalist is <datalist> HTML, inputValue is pre-selected display text
    let _dlCounter = 0;
    function reconDropdown(id, items, selectedId, style, cssClass) {
        // items = [{ id, name }] — sorted A-Z
        const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
        const dlId = 'dl_' + id;
        const selected = sorted.find(i => i.id === selectedId);
        const val = selected ? selected.name : '';
        const datalist = `<datalist id="${dlId}">${sorted.map(i => `<option value="${escHtml(i.name)}" data-id="${i.id}">`).join('')}</datalist>`;
        const cls = cssClass ? ` class="${cssClass}"` : '';
        return `${datalist}<input id="${id}" list="${dlId}" value="${escHtml(val)}"${cls} style="${style}" autocomplete="off" placeholder="Type to search...">`;
    }

    function buildSubCatDropdown(id, selectedId) {
        const items = allSubCategories.map(r => ({ id: r.id, name: getField(r, 'fldO4BTJhFv5EsN6i') || '' }));
        return reconDropdown(id, items, selectedId, 'width:170px', 'od-filter-select');
    }
    function buildCatDropdown(id, selectedId) {
        const items = allCategories.map(r => ({ id: r.id, name: getField(r, 'fldii4oUzSfmplihO') || '' }));
        return reconDropdown(id, items, selectedId, 'width:140px', 'od-filter-select');
    }
    function buildTenantDropdown(id, selectedId) {
        const items = allTenants.filter(t => {
            const status = getField(t, F.tenantStatus);
            return status && typeof status === 'object' ? status.name === 'Active' : String(status || '').toLowerCase() === 'active';
        }).map(t => ({ id: t.id, name: getField(t, F.tenantName) || '' }));
        return reconDropdown(id, items, selectedId, 'width:110px', 'od-filter-select');
    }
    function buildTenancyDropdown(id, selectedId) {
        const items = allTenancies.filter(r => isTenancyActive(getField(r, F.tenPayStatus))).map(r => ({
            id: r.id, name: getField(r, F.tenRef) || ''
        }));
        return reconDropdown(id, items, selectedId, 'width:140px', 'od-filter-select');
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
        return reconDropdown(id, items, selectedId, 'width:120px', 'od-filter-select');
    }
    function buildPropertyDropdown(id, selectedId) {
        const seen = new Set();
        const items = [];
        (allRentalUnits || []).forEach(u => {
            const propLink = getField(u, F.unitProperty);
            const propId = Array.isArray(propLink) ? propLink[0] : propLink;
            const propNameArr = getField(u, F.unitPropName);
            const propName = Array.isArray(propNameArr) ? propNameArr[0] : (propNameArr || '');
            if (!propId || !propName || seen.has(propId)) return;
            seen.add(propId);
            items.push({ id: propId, name: propName });
        });
        return reconDropdown(id, items, selectedId, 'width:120px', 'od-filter-select');
    }
    function buildCostDropdown(id, selectedId) {
        const items = allCosts.filter(r => isCostActive(r)).map(r => ({
            id: r.id, name: getField(r, F.costName) || ''
        }));
        return reconDropdown(id, items, selectedId, 'width:130px', 'od-filter-select');
    }
    function buildBusinessDropdown(id, selectedId) {
        const pickList = getActiveBusinesses();
        if (selectedId && !pickList.some(r => r.id === selectedId)) {
            const cur = (allBusinesses || []).find(r => r.id === selectedId);
            if (cur) pickList.push(cur);
        }
        const items = pickList.map(r => ({
            id: r.id, name: getField(r, 'fldbbRqVxLxUdHwIR') || ''
        }));
        return reconDropdown(id, items, selectedId, 'width:120px', 'od-filter-select');
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
        btn.style.background = 'var(--text-secondary)';
        document.getElementById('reconStatus').textContent = 'Matching unreconciled transactions...';
        setTimeout(() => {
            try {
                const results = runReconciliationMatching();
                showReconciliationPanel(results);
                btn.textContent = 'Run Reconciliation';
                btn.style.background = 'var(--info)';
                btn.disabled = false;
                document.getElementById('reconStatus').textContent = `Found ${results.length} transactions`;
            } catch (e) {
                console.error('Reconciliation error:', e);
                btn.textContent = 'Failed';
                btn.style.background = 'var(--danger)';
                document.getElementById('reconStatus').textContent = 'Error: ' + e.message;
                setTimeout(() => { btn.textContent = 'Run Reconciliation'; btn.style.background = 'var(--info)'; btn.disabled = false; }, 3000);
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
            // Account Alias — Santander / TNT Zempler / AmEx / Lloyds CC / etc.
            // Surfaced in the recon panel so Kevin can disambiguate transactions
            // that look the same but came from different accounts (e.g. a £40
            // Tesco charge could be groceries on AmEx personal vs a tenant move-in
            // refund on Santander business — the account is the deciding signal).
            const txAccount = String(getField(tx, F.txAccountAlias) || '');
            const txId = tx.id;

            const result = {
                txId, txDate, txVendor: vendor, txDesc: desc, txAccount,
                txAmount: amt || rawAmt,
                categoryId: '', categoryName: '',
                subCatId: '', subCatName: '',
                businessId: '', businessName: '',
                tenantName: '', tenantId: '', tenancyLabel: '', tenancyId: '',
                unitName: '', unitId: '', propertyId: '',
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

            // ── Guard: costs are outgoings only ──
            // Incoming payments (positive amount) must never carry a cost link.
            // The historical matcher can bleed a costId from an outgoing payment
            // onto an incoming one when they share a vendor prefix (e.g. "BANK
            // GIRO CREDIT" matched to Home Protect). Strip it.
            if (result.txAmount >= 0 && result.costId) {
                result.costId = '';
                result.costLabel = '';
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
        result.propertyId = rule.propertyId || '';
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
                result.propertyId = getPropertyIdFromUnit(result.unitId);
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

        const panel = document.createElement('div');
        panel.id = 'reconPanel';
        panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:10px';

        panel.innerHTML = `
        <div class="od-modal" style="max-width:98vw;width:100%">
            <div class="od-modal-header" style="flex-wrap:wrap;gap:8px">
                <div>
                    <h2 class="od-section-header" style="border-bottom:none;padding-bottom:0;margin:0">Transaction Reconciliation</h2>
                    <p class="od-text-muted-sm" style="font-size:11px;color:var(--text-secondary);margin:3px 0 0">${results.length} unreconciled · ${matched} suggestions · ${unmatched} unmatched</p>
                </div>
                <div style="display:flex;gap:6px">
                    <button onclick="approveAllRecon()" class="od-btn od-btn-primary" style="background:var(--success)">Approve All Transactions</button>
                    <button onclick="closeReconPanel()" class="od-btn od-btn-secondary">Close</button>
                </div>
            </div>
            <div style="overflow:auto;padding:8px 12px">
                <table class="od-table" style="min-width:1260px">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Date</th>
                            <th>Account</th>
                            <th>Vendor / Description</th>
                            <th style="text-align:right">Amount</th>
                            <th>Category</th>
                            <th>Sub-Category</th>
                            <th>Business</th>
                            <th>Tenant</th>
                            <th>Tenancy</th>
                            <th>Rental Unit</th>
                            <th>Property</th>
                            <th>Cost</th>
                            <th style="text-align:center">Action</th>
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
            unitId: r.unitId, propertyId: r.propertyId, costId: r.costId,
            status: r.status
        }));
    }

    function reconRowHtml(r, i) {
        const amtClass = r.txAmount >= 0 ? 'text-green' : 'text-red';
        const cc = 'od-cell'; // base cell class (padding, font-size, v-align)
        const dimClass = 'od-text-muted-sm';
        const catSelect = buildCatDropdown('recon-cat-' + i, r.categoryId);
        const subCatSelect = buildSubCatDropdown('recon-subcat-' + i, r.subCatId);

        // Grey out the Split button ONLY if Split Count > 1 (= already split
        // and has live children in the Airtable base). Stale "(Split 1 of N)"
        // tags in the *Name field are NOT a blocker — the modal auto-cleans
        // them on Save so the Airtable automation will re-process the record.
        const isAlreadySplit = (() => {
            const tx = (allTransactions || []).find(t => t.id === r.txId);
            if (!tx) return false;
            const cnt = Number(getField(tx, F.txSplitCount)) || 1;
            return cnt > 1;
        })();
        const splitBtnHtml = isAlreadySplit
            ? `<button title="This transaction is already split (Split Count > 1). To re-split, first reset Split Count to 1 in Airtable and remove any existing child records." disabled class="od-btn od-btn-secondary od-btn-sm" style="color:var(--text-muted);cursor:not-allowed">Split</button>`
            : `<button onclick="openReconSplitModal(${i})" title="Split this transaction into N portions (the Airtable automation owns duplication)" class="od-btn od-btn-secondary od-btn-sm">Split</button>`;
        const actionHtml = r.status === 'approved'
            ? `<span class="od-status-badge success">Done ✓</span>`
            : `<div style="display:flex;flex-direction:column;gap:3px;align-items:stretch">
                  <button id="recon-btn-${i}" class="cfv-action-btn success" onclick="approveRecon(${i})" style="font-size:10px;min-width:55px">Approve</button>
                  ${splitBtnHtml}
              </div>`;

        const matchBadge = r.matchType ? `<span class="od-status-badge info">${escHtml(r.matchType)}</span>` : '';

        return `<tr id="recon-row-${i}" oninput="persistReconRow(${i})" style="border-bottom:1px solid var(--border-subtle);${r.status === 'approved' ? 'opacity:0.5;' : ''}">
            <td class="${cc}" style="color:var(--text-muted);font-weight:600">${i + 1}</td>
            <td class="${cc}" style="white-space:nowrap">${escHtml(r.txDate)}</td>
            <td class="${cc} muted-cell" style="white-space:nowrap">${escHtml(r.txAccount || '—')}</td>
            <td class="${cc}" style="max-width:260px"><strong style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block">${escHtml(r.txVendor)}</strong><span class="${dimClass}" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;word-break:break-word">${escHtml(r.txDesc)}</span>${matchBadge?'<br>'+matchBadge:''}</td>
            <td class="${cc} num-cell ${amtClass}" style="font-weight:600">${fmt(Math.abs(r.txAmount))}</td>
            <td class="${cc}">${catSelect}</td>
            <td class="${cc}">${subCatSelect}</td>
            <td class="${cc}">${buildBusinessDropdown('recon-business-' + i, r.businessId || '')}</td>
            <td class="${cc}">${buildTenantDropdown('recon-tenant-' + i, r.tenantId || '')}</td>
            <td class="${cc}" onchange="reconTenancyChanged(${i})">${buildTenancyDropdown('recon-tenancy-' + i, r.tenancyId || '')}</td>
            <td class="${cc}">${buildRentalUnitDropdown('recon-unit-' + i, r.unitId || '')}</td>
            <td class="${cc}">${buildPropertyDropdown('recon-property-' + i, r.propertyId || '')}</td>
            <td class="${cc}" onchange="reconCostChanged(${i})">${buildCostDropdown('recon-cost-' + i, r.costId || '')}</td>
            <td class="${cc}" style="text-align:center;min-width:60px">${actionHtml}</td>
        </tr>`;
    }

    // Persist every dropdown's resolved ID back to _reconResults[idx]
    // immediately on change. This is wired via oninput on each row's <tr>
    // so it fires for every dropdown change inside the row (input events
    // bubble up).
    //
    // Why it matters: any re-render of the table body (Split operation,
    // panel close/reopen, smart refresh) recreates the dropdown DOM from
    // _reconResults — so without this, the user's manual edits silently
    // revert to the AI-suggested values they were rendered with.
    //
    // Without this, Approve / Approve-All still works in the immediate
    // case (resolveDropdownId reads from current DOM at click-time), but
    // any re-render between manual edit and Approve loses the changes.
    function persistReconRow(idx) {
        const r = window._reconResults && window._reconResults[idx];
        if (!r) return;
        r.categoryId   = resolveDropdownId('recon-cat-' + idx)      || '';
        r.subCatId     = resolveDropdownId('recon-subcat-' + idx)   || '';
        r.businessId   = resolveDropdownId('recon-business-' + idx) || '';
        r.tenantId     = resolveDropdownId('recon-tenant-' + idx)   || '';
        r.tenancyId    = resolveDropdownId('recon-tenancy-' + idx)  || '';
        r.unitId       = resolveDropdownId('recon-unit-' + idx)     || '';
        r.propertyId = resolveDropdownId('recon-property-' + idx) || '';
        r.costId       = resolveDropdownId('recon-cost-' + idx)     || '';
        // Refresh display labels so re-render shows the right text
        r.categoryName = r.categoryId ? getCatName(r.categoryId) : '';
        r.subCatName   = r.subCatId   ? getSubCatName(r.subCatId) : '';
    }
    window.persistReconRow = persistReconRow;
    // When tenancy input changes, auto-fill tenant, unit, property.
    // Attached via onchange on the tenancy <td>.
    //
    // CRITICAL: for unit, we must NOT just dump the tenancy's `tenUnitRef`
    // lookup string into the unit input — the unit dropdown is deduped by
    // unit record ID, and its option `value`s come from whichever tenancy
    // was iterated FIRST when the dropdown was built. If the picked
    // tenancy's lookup string differs even slightly (en-dash variants,
    // trailing whitespace, capitalisation), it won't match any option and
    // resolveDropdownId returns "" on Approve — so unit silently drops.
    //
    // The robust fix: get the unit's record ID from `tenUnit` (the link)
    // and find the matching dropdown option by data-id, then use THAT
    // option's value as the input value. Same approach for tenant.
    function reconTenancyChanged(idx) {
        const input = document.getElementById('recon-tenancy-' + idx);
        if (!input || !input.value) return;
        const tenancyId = resolveDropdownId('recon-tenancy-' + idx);
        const tenancy = allTenancies.find(t => t.id === tenancyId);
        if (!tenancy) return;

        // ── Helper: set a datalist input by record-ID match ──
        // Looks up the option whose data-id === id, sets the input value
        // to that option's value. Falls back to fallbackName if no option
        // matches (the unit/tenant might not be in any tenancy yet).
        function setByRecordId(inputId, recId, fallbackName) {
            const inp = document.getElementById(inputId);
            if (!inp) return;
            if (!recId) { inp.value = fallbackName || ''; return; }
            const dl = document.getElementById(inp.getAttribute('list'));
            const opt = dl ? [...dl.options].find(o => o.getAttribute('data-id') === recId) : null;
            inp.value = opt ? opt.value : (fallbackName || '');
        }

        // ── Tenant ──
        const tLookup = buildTenantLookup();
        const tenant = getTenantForTenancy(tenancy, tLookup);
        if (tenant) {
            const tenantName = String(getField(tenant, F.tenantName) || '');
            setByRecordId('recon-tenant-' + idx, tenant.id, tenantName);
        } else {
            const tenantInput = document.getElementById('recon-tenant-' + idx);
            if (tenantInput) tenantInput.value = '';
        }

        // ── Unit ──
        // 1. Get unit ID from `tenUnit` link (preferred — record ID is canonical)
        // 2. Use it to pick the matching dropdown option by data-id
        // 3. Fallback name = rental unit's primary field, or the lookup string
        const unitLink = getField(tenancy, F.tenUnit);
        const unitId = Array.isArray(unitLink) ? unitLink[0] : unitLink;
        let unitFallbackName = '';
        if (unitId && typeof allRentalUnits !== 'undefined') {
            const unitRec = (allRentalUnits || []).find(u => u.id === unitId);
            if (unitRec) unitFallbackName = String(getField(unitRec, F.unitName) || '');
        }
        if (!unitFallbackName) {
            const unitRef = getField(tenancy, F.tenUnitRef);
            if (Array.isArray(unitRef) && unitRef.length && unitRef[0]) {
                unitFallbackName = String(unitRef[0]);
            } else if (unitRef && typeof unitRef === 'string') {
                unitFallbackName = unitRef;
            }
        }
        setByRecordId('recon-unit-' + idx, unitId, unitFallbackName);

        // ── Property — resolve from the unit's property link (record ID)
        const propRecId = getPropertyIdFromUnit(unitId);
        setByRecordId('recon-property-' + idx, propRecId, '');

        // ── Business — tenancy always belongs to Real Estate
        const reBizId = findBusinessIdByName('Real Estate');
        if (reBizId) setByRecordId('recon-business-' + idx, reBizId, 'Real Estate');

        // ── Category — Revenue for rental income
        const revenueCatId = findCategoryIdByName('Revenue');
        if (revenueCatId) setByRecordId('recon-cat-' + idx, revenueCatId, 'Revenue');

        // ── Sub-category — Rental Income
        const subCatInput = document.getElementById('recon-subcat-' + idx);
        if (subCatInput && !subCatInput.value) subCatInput.value = getSubCatName(REC.subRentalInc);

        // Persist the auto-filled values to _reconResults so a future
        // re-render doesn't wipe them. tenancyChanged sets several fields
        // (tenant, unit, property, sub-cat) without firing native input
        // events on each, so we explicitly call the persistence helper.
        persistReconRow(idx);
    }

    // When cost input changes, auto-fill business, category, subcategory, property
    function reconCostChanged(idx) {
        const input = document.getElementById('recon-cost-' + idx);
        if (!input || !input.value) return;
        const costId = resolveDropdownId('recon-cost-' + idx);
        const cost = (allCosts || []).find(c => c.id === costId);
        if (!cost) return;

        function setByRecordId(inputId, recId, fallbackName) {
            const inp = document.getElementById(inputId);
            if (!inp) return;
            if (!recId) { inp.value = fallbackName || ''; return; }
            const dl = document.getElementById(inp.getAttribute('list'));
            const opt = dl ? [...dl.options].find(o => o.getAttribute('data-id') === recId) : null;
            inp.value = opt ? opt.value : (fallbackName || '');
        }

        // ── Business from cost
        const costBizField = getField(cost, F.costBusiness);
        const costBizId = extractLinkedId(costBizField);
        if (costBizId) {
            const bizRec = (allBusinesses || []).find(r => r.id === costBizId);
            const bizName = bizRec ? (getField(bizRec, 'fldbbRqVxLxUdHwIR') || '') : '';
            setByRecordId('recon-business-' + idx, costBizId, bizName);
        }

        // ── Category from cost
        const costCatField = getField(cost, F.costCategory);
        const costCatId = extractLinkedId(costCatField);
        if (costCatId) setByRecordId('recon-cat-' + idx, costCatId, getCatName(costCatId));

        // ── Sub-category from cost
        const costSubField = getField(cost, F.costSubCategory);
        const costSubId = extractLinkedId(costSubField);
        if (costSubId) setByRecordId('recon-subcat-' + idx, costSubId, getSubCatName(costSubId));

        // ── Property from cost
        const costPropField = getField(cost, F.costProperty);
        const costPropId = extractLinkedId(costPropField);
        if (costPropId) setByRecordId('recon-property-' + idx, costPropId, '');

        persistReconRow(idx);
    }
    window.reconCostChanged = reconCostChanged;

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
        // Match against tenancy references — ONLY active tenancies (Former
        // tenancies left without an end-date were silently winning matches
        // on units that had a newer current tenancy, e.g. the Serco/IMMO LTD
        // dupes on 42 Elmdon Place. Filter ensures we never auto-match a
        // payment to a former tenancy, regardless of array iteration order.
        allTenancies.forEach(ten => {
            if (!isTenancyActive(getField(ten, F.tenPayStatus))) return;
            const surname = (getField(ten, F.tenSurname) || '').toLowerCase();
            if (surname && surname.length >= 3 && text.includes(surname)) {
                r.tenancyLabel = getField(ten, F.tenRef) || '';
                r.tenancyId = ten.id;
                r.tenantName = r.tenantName || getField(ten, F.tenSurname);
                const unitRef = getField(ten, F.tenUnitRef);
                const unitId = getField(ten, F.tenUnit);
                r.unitName = Array.isArray(unitRef) ? unitRef[0] : (unitRef || '');
                r.unitId = Array.isArray(unitId) ? unitId[0] : unitId;
                r.propertyId = getPropertyIdFromUnit(r.unitId);
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
                <div class="od-progress">
                    <div class="od-progress-fill" style="width:${stats.pct}%;background:${stats.colour}"></div>
                </div>
                <div class="od-text-muted-sm" style="margin-top:6px">Target: ≥90% <span style="color:var(--success)">●</span> 75–89% <span style="color:var(--warning)">●</span> &lt;75% <span style="color:var(--danger)">●</span></div>
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
            const colour = pct >= 90 ? 'var(--success)' : pct >= 75 ? 'var(--warning)' : 'var(--danger)';
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
        const propertyId = resolveDropdownId('recon-property-' + idx);
        const costId = resolveDropdownId('recon-cost-' + idx);

        if (catId) fields[F.txCategory] = [catId];
        if (subCatId) fields[F.txSubCategory] = [subCatId];
        if (businessId) fields[F.txBusiness] = [businessId];
        if (tenancyId) fields[F.txTenancy] = [tenancyId];
        if (unitId) fields[F.txUnit] = [unitId];
        if (propertyId) fields[F.txProperty] = [propertyId];
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
            if (subCatId) localTx.fields[F.txSubCategory] = [subCatId];
            if (businessId) localTx.fields[F.txBusiness] = [businessId];
            if (tenancyId) localTx.fields[F.txTenancy] = [{ id: tenancyId }];
            if (unitId) localTx.fields[F.txUnit] = [unitId];
            if (propertyId) localTx.fields[F.txProperty] = [propertyId];
            if (costId) localTx.fields[F.txCost] = [costId];
        }

        // ── Cost sync ──
        // If this reconciliation linked a transaction to a cost, write the new
        // "Last Reconciled *" fields back to that cost so the AP Fixed dashboard
        // reflects the latest payment, account, sub-category and amount.
        if (costId && localTx) {
            const txDate = getField(localTx, F.txDate);
            const txAmount = Number(getField(localTx, F.txReportAmount)) || 0;
            const txAccountIds = (getField(localTx, F.txAccountLink) || []).map(v => v.id || v).filter(Boolean);
            const finalSubCatIds = subCatId ? [subCatId] : ((getField(localTx, F.txSubCategory) || []).map(v => v.id || v).filter(Boolean));
            try {
                await syncCostFromReconciledTx(costId, txDate, txAmount, txAccountIds, finalSubCatIds);
                // Also push derived fields (Days Overdue, Variance, Expected Next, Status)
                if (typeof syncDerivedCostFields === 'function') {
                    syncDerivedCostFields().catch(e => console.warn('Derived sync failed:', e));
                }
            } catch (e) {
                console.warn('Cost sync after reconciliation failed (non-fatal):', e);
            }
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
            const final = { categoryId: catId, subCatId, businessId, tenancyId, unitId, propertyId, costId };
            const wasAccurate = ['categoryId', 'subCatId', 'businessId', 'tenancyId', 'unitId', 'propertyId', 'costId']
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
                propertyId: resolveDropdownId('recon-property-' + idx),
            });
        }

        if (btn) { btn.textContent = '✓'; btn.style.background = 'var(--success-bg)'; btn.style.color = 'var(--success)'; }
        const row = document.getElementById('recon-row-' + idx);
        if (row) row.style.opacity = '0.5';

        // Mark that recon state has changed so the panel close / next load skips the stale cache
        window._reconChanged = true;
        if (typeof clearDashCache === 'function') clearDashCache();
    }

    async function approveAllRecon() {
        const results = window._reconResults || [];

        // ALL non-approved rows are eligible. The previous version filtered
        // out rows with no AI suggestion and no manual dropdown values —
        // that meant a batch of unmatched-and-untouched rows triggered a
        // "No transactions to approve" toast (often missed) and the user
        // assumed the button was broken. The behaviour now matches the
        // per-row Approve button: PATCH `txReconciled = true` plus
        // whatever dropdown values are filled. Empty rows still get
        // marked reconciled (matching individual-Approve behaviour).
        const approveIdxs = [];
        for (let i = 0; i < results.length; i++) {
            if (results[i].status !== 'approved') approveIdxs.push(i);
        }

        if (approveIdxs.length === 0) {
            showToast('All transactions are already approved.', { type: 'info' });
            return;
        }

        // Count rows with no data so we can warn the user up front rather
        // than silently mark uncategorised transactions as reconciled.
        const rowHasData = (i) =>
            !!(resolveDropdownId('recon-cat-' + i) ||
               resolveDropdownId('recon-subcat-' + i) ||
               resolveDropdownId('recon-business-' + i) ||
               resolveDropdownId('recon-tenant-' + i) ||
               resolveDropdownId('recon-tenancy-' + i) ||
               resolveDropdownId('recon-unit-' + i) ||
               resolveDropdownId('recon-property-' + i) ||
               resolveDropdownId('recon-cost-' + i));
        const emptyCount = approveIdxs.filter(i => !rowHasData(i)).length;
        const emptyMsg = emptyCount > 0
            ? `\n\n⚠ ${emptyCount} of these row${emptyCount === 1 ? ' has' : 's have'} no categorisation. They'll be marked reconciled but with no Sub-Category / Business / Tenancy / etc. linked.`
            : '';

        if (!await showConfirm(
            `Approve ${approveIdxs.length} transaction${approveIdxs.length === 1 ? '' : 's'}?\n\nThis will mark them as reconciled in Airtable.${emptyMsg}`,
            { title: 'Approve Transactions' }
        )) return;

        let successCount = 0;
        let failCount = 0;
        const failedRows = []; // 1-indexed row numbers for the user-facing report
        const statusEl = document.getElementById('reconStatus');
        const setStatus = (txt) => { if (statusEl) statusEl.textContent = txt; };

        for (const i of approveIdxs) {
            setStatus(`Processing ${successCount + failCount + 1} of ${approveIdxs.length}…`);

            // Up to 3 attempts per row, with backoff on rate-limit / 5xx
            let succeeded = false;
            let lastErr = '';
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    await approveRecon(i);
                    successCount++;
                    succeeded = true;
                    break;
                } catch (e) {
                    lastErr = (e && e.message) || 'unknown';
                    const isRateLimit = lastErr.includes('429') || lastErr.includes('RATE_LIMIT');
                    const isServerError = lastErr.includes('500') || lastErr.includes('502') || lastErr.includes('503');
                    if ((isRateLimit || isServerError) && attempt < 2) {
                        await new Promise(r => setTimeout(r, attempt === 0 ? 2000 : 5000));
                    } else {
                        console.error(`[approveAllRecon] Row ${i + 1} failed after ${attempt + 1} attempts:`, lastErr);
                        failCount++;
                        failedRows.push(i + 1);
                        break;
                    }
                }
            }
            // 500ms pause between requests to be friendly to Airtable's
            // rate limiter on large batches.
            await new Promise(r => setTimeout(r, 500));
        }
        setStatus(`Done: ${successCount} approved${failCount > 0 ? `, ${failCount} failed` : ''} — refreshing…`);
        // Surface failures up front so the user knows which rows still need
        // attention (instead of just seeing the dashboard reload silently).
        if (failCount > 0) {
            showToast(
                `${failCount} of ${approveIdxs.length} rows failed (rows: ${failedRows.slice(0, 10).join(', ')}${failedRows.length > 10 ? '…' : ''}). Check the console for details.`,
                { type: 'error', duration: 8000 }
            );
        } else if (successCount > 0) {
            showToast(`✓ Approved ${successCount} transaction${successCount === 1 ? '' : 's'}.`, { type: 'success' });
        }
        // Bust the stale-while-revalidate cache so the refresh shows fresh numbers, not the pre-approval ones
        if (typeof clearDashCache === 'function') clearDashCache();
        window._reconChanged = false; // consumed by this refresh
        setTimeout(() => loadDashboard(), 2000);
    }

    // ════════════════════════════════════════════════════════════════════
    // SPLIT TRANSACTIONS — PATCH-ONLY (Airtable automation owns duplication)
    //
    // Kevin's Airtable base has a "Split Transactions" automation
    // (Operations Director → Automations → Finance → Split Transactions)
    // that triggers on `Split Count > 1` and creates N-1 child records
    // with `**GBP = original / N`, `Split Count = 1`, names "Split X of N".
    //
    // EQUAL MODE flow:
    //   1. Strip any stale "(Split X of Y)" suffix from *Name + PATCH
    //      Split Count = N on the source — single PATCH so the
    //      automation sees the clean name immediately.
    //   2. Poll Airtable for the N-1 new children (filterByFormula on
    //      vendor + date + **GBP = original / N). Up to 18s.
    //   3. Splice the source row out of _reconResults and the source +
    //      children rows in (in-place, no panel reload, no popup).
    //
    // CUSTOM AMOUNTS flow:
    //   1. PATCH source: clean name + Split Count = N + Split Override
    //      Amount = portion[0] + categorisation for portion 0.
    //   2. Wait for the automation to create N-1 children with **GBP =
    //      original / N (default equal-split amounts).
    //   3. PATCH each child: Split Override Amount = its portion +
    //      categorisation. The Report Amount formula honours Override
    //      first, so each child's Report Amount becomes its true
    //      portion (not the auto orig/N).
    //
    // NEVER POST duplicate transactions from JS — both we AND the
    // Airtable automation would create them, producing N × (N-1) extras.
    // (See commit f5b7aad / data-loss incident on 2026-05-04.)
    // ════════════════════════════════════════════════════════════════════
    function openReconSplitModal(idx) {
        const r = window._reconResults[idx];
        if (!r) return;
        // Find the live tx record so we have access to all the bank fields
        // we need to copy onto the duplicates.
        const tx = (allTransactions || []).find(t => t.id === r.txId);
        if (!tx) { alert('Cannot find the source transaction in memory. Refresh and try again.'); return; }
        const totalRaw = Math.abs(Number(getField(tx, F.txAmount)) || 0);
        if (totalRaw <= 0) { alert('Cannot split a £0 transaction.'); return; }

        const existing = document.getElementById('reconSplitModal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'reconSplitModal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:10001;display:flex;align-items:center;justify-content:center;padding:16px';
        overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

        overlay.innerHTML = `
            <div class="od-modal" style="width:100%;max-width:760px">
                <div class="od-modal-header" style="align-items:flex-start;gap:12px">
                    <div style="flex:1;min-width:0">
                        <h3 class="od-section-header" style="border-bottom:none;padding-bottom:0;margin:0">Split Transaction</h3>
                        <div style="margin-top:4px;font-size:11px;color:var(--text-secondary)">
                            <strong>${escHtml(r.txDate)}</strong> &middot;
                            <strong>${escHtml(r.txVendor || '—')}</strong> &middot;
                            <strong>${escHtml(r.txAccount || '—')}</strong> &middot;
                            Original: <strong style="color:var(--text-primary)">${fmt(totalRaw)}</strong>
                        </div>
                    </div>
                    <button onclick="document.getElementById('reconSplitModal').remove()" style="background:none;border:none;font-size:22px;line-height:1;color:var(--text-muted);cursor:pointer;padding:0 4px">&times;</button>
                </div>
                <div style="padding:14px 20px;border-bottom:1px solid var(--border-subtle);display:flex;gap:6px">
                    <button id="splitTabEqual"  data-mode="equal"  onclick="setSplitMode('equal')"  class="od-btn od-btn-primary" style="flex:1">Equal Split</button>
                    <button id="splitTabCustom" data-mode="custom" onclick="setSplitMode('custom')" class="od-btn od-btn-secondary" style="flex:1">Custom Amounts</button>
                </div>
                <div id="splitModalBody" style="overflow:auto;padding:16px 20px;flex:1"></div>
                <div style="padding:12px 20px;border-top:1px solid var(--border-default);display:flex;justify-content:flex-end;gap:8px;background:var(--bg-surface)">
                    <button onclick="document.getElementById('reconSplitModal').remove()" class="od-btn od-btn-secondary od-btn-lg">Cancel</button>
                    <button id="splitSaveBtn" onclick="performReconSplit(${idx})" class="od-btn od-btn-primary od-btn-lg">Save Split</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        // Stash modal state so the body renderers can read it
        window._splitState = {
            txIdx: idx,
            txId: r.txId,
            totalRaw,
            mode: 'equal',
            equalCount: 2,
            customRows: [
                { amount: '', subCatId: '', businessId: '', tenancyId: '', unitId: '', costId: '' },
                { amount: '', subCatId: '', businessId: '', tenancyId: '', unitId: '', costId: '' },
            ],
        };
        renderSplitModalBody();
    }
    window.openReconSplitModal = openReconSplitModal;

    function setSplitMode(mode) {
        const st = window._splitState; if (!st) return;
        st.mode = mode;
        // Toggle the tab visuals
        const tEq = document.getElementById('splitTabEqual');
        const tCu = document.getElementById('splitTabCustom');
        if (tEq && tCu) {
            tEq.className = mode === 'equal' ? 'od-btn od-btn-primary' : 'od-btn od-btn-secondary';
            tCu.className = mode === 'custom' ? 'od-btn od-btn-primary' : 'od-btn od-btn-secondary';
            tEq.style.cssText = 'flex:1';
            tCu.style.cssText = 'flex:1';
        }
        renderSplitModalBody();
    }
    window.setSplitMode = setSplitMode;

    function renderSplitModalBody() {
        const st = window._splitState; if (!st) return;
        const body = document.getElementById('splitModalBody'); if (!body) return;
        if (st.mode === 'equal') {
            const each = st.totalRaw / Math.max(1, st.equalCount);
            body.innerHTML = `
                <p style="margin:0 0 14px 0;font-size:12px;color:var(--text-secondary);line-height:1.5">
                    Sets <code>Split Count = N</code> on this transaction. The Airtable
                    <strong>"Split Transactions"</strong> automation creates <code>N − 1</code> child records
                    each with <code>Report Amount = ${fmt(each)}</code>.
                    <br><br>
                    <strong style="color:var(--accent-gold)">⚠ Tenancy, Unit and Tenant are cleared on every portion.</strong>
                    You must assign a tenancy to each row before approving — silent inheritance was causing every
                    portion of bulk rent payments to link to the same unit.
                </p>
                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                    <label style="font-size:12px;color:var(--text-primary);font-weight:600">Number of portions:
                        <input id="splitEqualCount" type="number" min="2" max="50" value="${st.equalCount}" oninput="splitOnEqualCountChange(this.value)"
                            style="margin-left:8px;width:70px;padding:6px 8px;font-size:13px;border:1px solid var(--border-default);border-radius:4px">
                    </label>
                    <span style="font-size:12px;color:var(--text-secondary)">Each portion: <strong style="color:var(--text-primary)" id="splitEachLabel">${fmt(each)}</strong></span>
                </div>
                <p style="margin:14px 0 0 0;font-size:11px;color:var(--text-muted);line-height:1.4">
                    <strong>JS does not duplicate records</strong> — only the Airtable automation does. This prevents the double-creation issue from the previous version.
                </p>
            `;
        } else {
            // Custom mode rows
            const rowsHtml = st.customRows.map((row, i) => `
                <tr id="splitCustomRow-${i}">
                    <td style="padding:4px 6px;font-size:11px;color:var(--text-muted);width:24px">${i + 1}</td>
                    <td style="padding:4px 6px"><input type="number" step="0.01" value="${row.amount === '' ? '' : row.amount}" oninput="splitOnCustomAmountChange(${i}, this.value)" placeholder="0.00" class="od-inline-input" style="text-align:right"></td>
                    <td style="padding:4px 6px">${buildSubCatDropdown('split-subcat-' + i, row.subCatId)}</td>
                    <td style="padding:4px 6px">${buildBusinessDropdown('split-business-' + i, row.businessId)}</td>
                    <td style="padding:4px 6px">${buildTenancyDropdown('split-tenancy-' + i, row.tenancyId)}</td>
                    <td style="padding:4px 6px;text-align:center;width:32px">
                        <button onclick="splitRemoveCustomRow(${i})" title="Remove this portion" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:16px;line-height:1;padding:0 4px">&times;</button>
                    </td>
                </tr>
            `).join('');
            const total = st.customRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
            const remaining = st.totalRaw - total;
            const remColor = Math.abs(remaining) < 0.005 ? 'var(--success)' : (remaining < 0 ? 'var(--danger)' : 'var(--text-secondary)');
            body.innerHTML = `
                <p style="margin:0 0 14px 0;font-size:12px;color:var(--text-secondary);line-height:1.5">
                    Enter each portion's amount and pre-categorise. The original record gets the first portion's amount + categories;
                    each remaining portion becomes a new record. Sum of all portions must equal <strong>${fmt(st.totalRaw)}</strong>.
                </p>
                <table class="od-table">
                    <thead>
                        <tr>
                            <th>#</th>
                            <th style="text-align:right;min-width:90px">Amount (£)</th>
                            <th>Sub-Category</th>
                            <th>Business</th>
                            <th>Tenancy</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
                <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:8px">
                    <button onclick="splitAddCustomRow()" class="od-btn od-btn-outline">+ Add Portion</button>
                    <div style="font-size:12px">
                        <span style="color:var(--text-muted)">Total: <strong style="color:var(--text-primary)">${fmt(total)}</strong></span>
                        &nbsp;·&nbsp;
                        <span style="color:${remColor}">Remaining: <strong>${fmt(remaining)}</strong></span>
                    </div>
                </div>
            `;
            // Wire up each row's Sub-Cat select to write back to state on change
            // (built-in dropdowns don't auto-bind to splitState).
            st.customRows.forEach((_, i) => {
                const wire = (selId, key) => {
                    const el = document.getElementById(selId);
                    if (el) el.onchange = () => { st.customRows[i][key] = resolveDropdownId(selId); };
                };
                wire('split-subcat-' + i, 'subCatId');
                wire('split-business-' + i, 'businessId');
                wire('split-tenancy-' + i, 'tenancyId');
            });
        }
        // Save button enabled-state hint
        updateSplitSaveButton();
    }

    function updateSplitSaveButton() {
        const st = window._splitState; if (!st) return;
        const btn = document.getElementById('splitSaveBtn'); if (!btn) return;
        let ok = false, label = 'Save Split';
        if (st.mode === 'equal') {
            ok = Number.isInteger(Number(st.equalCount)) && st.equalCount >= 2 && st.equalCount <= 50;
            label = `Save · ${st.equalCount} equal portions`;
        } else {
            const total = st.customRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
            ok = st.customRows.length >= 2 && Math.abs(st.totalRaw - total) < 0.005 && st.customRows.every(r => Number(r.amount) > 0);
            label = ok ? `Save · ${st.customRows.length} portions` : 'Save Split';
        }
        btn.disabled = !ok;
        btn.style.opacity = ok ? '1' : '0.5';
        btn.style.cursor = ok ? 'pointer' : 'not-allowed';
        btn.textContent = label;
    }

    function splitOnEqualCountChange(v) {
        const st = window._splitState; if (!st) return;
        const n = Math.max(2, Math.min(50, Math.floor(Number(v) || 2)));
        st.equalCount = n;
        const each = st.totalRaw / n;
        const lab = document.getElementById('splitEachLabel');
        if (lab) lab.textContent = fmt(each);
        updateSplitSaveButton();
    }
    window.splitOnEqualCountChange = splitOnEqualCountChange;

    function splitOnCustomAmountChange(i, v) {
        const st = window._splitState; if (!st) return;
        st.customRows[i].amount = v === '' ? '' : Number(v);
        // Re-render only the totals row to avoid trashing the user's focus
        renderSplitModalBody();
        // Restore focus to the input the user was typing in
        const inp = document.querySelectorAll('#splitCustomRow-' + i + ' input[type="number"]')[0];
        if (inp) { inp.focus(); inp.select(); }
    }
    window.splitOnCustomAmountChange = splitOnCustomAmountChange;

    function splitAddCustomRow() {
        const st = window._splitState; if (!st) return;
        st.customRows.push({ amount: '', subCatId: '', businessId: '', tenancyId: '', unitId: '', costId: '' });
        renderSplitModalBody();
    }
    window.splitAddCustomRow = splitAddCustomRow;

    function splitRemoveCustomRow(i) {
        const st = window._splitState; if (!st) return;
        if (st.customRows.length <= 2) { alert('A split needs at least 2 portions. Cancel the split if you want to leave it as one transaction.'); return; }
        st.customRows.splice(i, 1);
        renderSplitModalBody();
    }
    window.splitRemoveCustomRow = splitRemoveCustomRow;

    // PATCH-ONLY split. Equal mode: PATCH source's Split Count = N (also
    // strip any stale "(Split X of Y)" suffix from *Name) and let the
    // Airtable automation create N-1 children. Custom mode: do the same
    // PATCH plus Override + categorisation for portion 0; then once the
    // children appear, PATCH each one with its Override + categorisation.
    async function performReconSplit(idx) {
        const st = window._splitState;
        if (!st) return;
        const r = window._reconResults[idx]; if (!r) return;
        const tx = (allTransactions || []).find(t => t.id === r.txId); if (!tx) return;
        const btn = document.getElementById('splitSaveBtn');

        // ── Validate inputs per mode ──
        const N = st.mode === 'equal' ? st.equalCount : st.customRows.length;
        if (!Number.isInteger(N) || N < 2 || N > 50) {
            alert('Number of portions must be a whole number between 2 and 50.');
            return;
        }
        let portionAmounts, portionCats;
        if (st.mode === 'equal') {
            const each = st.totalRaw / N;
            portionAmounts = Array(N).fill(each);
            portionCats = Array(N).fill({});
        } else {
            // Custom: validate sum equals original within float tolerance
            const total = st.customRows.reduce((s, row) => s + (Number(row.amount) || 0), 0);
            if (Math.abs(st.totalRaw - total) > 0.005 || st.customRows.some(row => !(Number(row.amount) > 0))) {
                alert(`Custom amounts must sum exactly to ${fmt(st.totalRaw)}. Currently: ${fmt(total)}.`);
                return;
            }
            portionAmounts = st.customRows.map(row => Number(row.amount));
            portionCats = st.customRows.map(row => ({
                subCatId: row.subCatId, businessId: row.businessId,
                tenancyId: row.tenancyId, unitId: row.unitId, costId: row.costId,
            }));
        }

        // ── Pre-flight safety: refuse if source already has live children ──
        // We can't easily detect & clean orphan children, so re-splitting is
        // unsafe. The UI greys this out too (Split button disabled when
        // Split Count > 1) but check again here in case state is stale.
        const currentSplitCount = Number(getField(tx, F.txSplitCount)) || 1;
        if (currentSplitCount > 1) {
            alert(`This transaction is already split into ${currentSplitCount} portions. To re-split, first reset Split Count to 1 in Airtable AND delete the existing child records. Otherwise re-splitting would leave orphan children mixed with new ones.`);
            return;
        }

        if (btn) { btn.disabled = true; btn.textContent = 'Splitting…'; btn.style.opacity = '0.6'; }

        try {
            // ── Step 1: Build the source PATCH ──
            // Auto-clean any stale "(Split X of Y)" suffix from the name
            // so the Airtable automation's idempotency check doesn't
            // bail on processing this record.
            const currentName = String(getField(tx, F.txName) || '');
            const cleanName = currentName.replace(/\s*\(Split\s+\d+\s+of\s+\d+\)\s*$/i, '').trim();
            const srcFields = { [F.txSplitCount]: N };
            if (cleanName !== currentName) {
                srcFields[F.txName] = cleanName;
            }
            // Custom mode: also write Override + categorisation for portion[0]
            if (st.mode === 'custom') {
                srcFields[F.txSplitOverride] = portionAmounts[0];
                const c0 = portionCats[0];
                if (c0.subCatId)   srcFields[F.txSubCategory] = [c0.subCatId];
                if (c0.businessId) srcFields[F.txBusiness]    = [c0.businessId];
                if (c0.tenancyId)  srcFields[F.txTenancy]     = [c0.tenancyId];
                if (c0.unitId)     srcFields[F.txUnit]        = [c0.unitId];
                if (c0.costId)     srcFields[F.txCost]        = [c0.costId];
            }
            await patchTx(tx.id, srcFields);

            // ── Step 2: Poll for the children to appear ──
            if (btn) btn.textContent = 'Waiting for Airtable…';
            const sourceVendor = String(getField(tx, F.txVendor) || '');
            const sourceDate = getField(tx, F.txDate);
            const sourceRaw = Math.abs(Number(getField(tx, F.txAmount)) || 0);
            // Children are created with **GBP = orig / N (equal portion).
            // Even in Custom mode the automation creates them at the equal
            // amount; we override per-child afterwards.
            const automationChildAmount = sourceRaw / N * (sourceRaw === 0 ? 1 : Math.sign(Number(getField(tx, F.txAmount)) || 1));
            const children = await pollForSplitChildren({
                vendor: sourceVendor,
                date: sourceDate,
                childAmount: automationChildAmount,
                expectedCount: N - 1,
                sourceTxId: tx.id,
                timeoutMs: 18000,
            });

            // ── Step 3 (Custom mode only): PATCH each child with its
            //     Override + categorisation. Done in parallel for speed.
            if (st.mode === 'custom' && children.length) {
                const childPatches = children.map((child, k) => {
                    const portionIdx = k + 1; // children are portions 2..N
                    const c = portionCats[portionIdx];
                    const fields = { [F.txSplitOverride]: portionAmounts[portionIdx] };
                    if (c.subCatId)   fields[F.txSubCategory] = [c.subCatId];
                    if (c.businessId) fields[F.txBusiness]    = [c.businessId];
                    if (c.tenancyId)  fields[F.txTenancy]     = [c.tenancyId];
                    if (c.unitId)     fields[F.txUnit]        = [c.unitId];
                    if (c.costId)     fields[F.txCost]        = [c.costId];
                    return patchTx(child.id, fields);
                });
                await Promise.all(childPatches);
            }

            // ── Step 3 (Equal mode): break the parent's tenancy/unit/tenant
            //     inheritance on parent + every child. The Airtable automation
            //     copies every field from parent → child, so without this all N
            //     portions silently end up linked to whatever single tenancy
            //     the parent was matched to (e.g. an IMMO LTD bulk rent
            //     transfer covers 5 units but every child inherits Unit 2).
            //     We also flip Reconciled=false so the user MUST re-approve
            //     each portion with its correct per-portion tenancy.
            //     The parent gets Split Override = totalRaw / N so its Report
            //     Amount shows the per-portion amount (the automation doesn't
            //     change the parent's **GBP, which stays at the bulk total).
            if (st.mode === 'equal') {
                const perPortion = st.totalRaw / N;
                const clearFields = {
                    [F.txReconciled]: false,
                    [F.txTenancy]: [],
                    [F.txUnit]: [],
                };
                if (F.txTenant) clearFields[F.txTenant] = [];
                const childIds = children.map(c => c.id);
                const parentFields = { ...clearFields, [F.txSplitOverride]: perPortion };
                await Promise.all([
                    patchTx(tx.id, parentFields),
                    ...childIds.map(id => patchTx(id, clearFields)),
                ]);
            }

            // ── Step 4: Update local allTransactions to mirror Airtable ──
            if (!tx.fields) tx.fields = {};
            tx.fields[F.txSplitCount] = N;
            // Mirror the automation's name change (parent gets " (Split 1 of N)")
            tx.fields[F.txName] = `${cleanName} (Split 1 of ${N})`;
            if (st.mode === 'custom') {
                tx.fields[F.txSplitOverride] = portionAmounts[0];
                const c0 = portionCats[0];
                if (c0.subCatId)   tx.fields[F.txSubCategory] = [{ id: c0.subCatId }];
                if (c0.businessId) tx.fields[F.txBusiness]    = [{ id: c0.businessId }];
                if (c0.tenancyId)  tx.fields[F.txTenancy]     = [{ id: c0.tenancyId }];
                if (c0.unitId)     tx.fields[F.txUnit]        = [{ id: c0.unitId }];
                if (c0.costId)     tx.fields[F.txCost]        = [{ id: c0.costId }];
            } else {
                // Equal mode: mirror the per-row clears + Split Override we PATCHed above
                tx.fields[F.txReconciled] = false;
                tx.fields[F.txTenancy] = [];
                tx.fields[F.txUnit] = [];
                tx.fields[F.txSplitOverride] = st.totalRaw / N;
                if (F.txTenant) tx.fields[F.txTenant] = [];
            }
            children.forEach(child => {
                if (!allTransactions.find(t => t.id === child.id)) {
                    allTransactions.push(child);
                }
                if (st.mode === 'equal') {
                    if (!child.fields) child.fields = {};
                    child.fields[F.txReconciled] = false;
                    child.fields[F.txTenancy] = [];
                    child.fields[F.txUnit] = [];
                    if (F.txTenant) child.fields[F.txTenant] = [];
                }
            });

            // ── Step 5: Build the new _reconResults rows ──
            const newResults = [];
            // Source becomes Portion 1 — keep its existing categorisation
            // (or what the user set in custom mode for portion 0).
            const sourceTxAmount = portionAmounts[0] * (sourceRaw === 0 ? 1 : (Number(getField(tx, F.txAmount)) >= 0 ? 1 : -1));
            const portion0 = st.mode === 'custom' ? {
                ...r,
                txAmount: sourceTxAmount,
                subCatId: portionCats[0].subCatId || r.subCatId,
                subCatName: portionCats[0].subCatId ? getSubCatName(portionCats[0].subCatId) : r.subCatName,
                businessId: portionCats[0].businessId || r.businessId,
                tenancyId: portionCats[0].tenancyId || r.tenancyId,
                unitId: portionCats[0].unitId || r.unitId,
                costId: portionCats[0].costId || r.costId,
                matchType: `Split 1/${N} (custom)`,
                score: 0,
            } : {
                // Equal mode: clear the parent's per-portion fields (tenancy,
                // unit, tenant) so the user must explicitly classify each row.
                // Without this, all N rows default to whatever single tenancy
                // the auto-matcher pre-filled on the parent — causing every
                // child to silently end up linked to the same tenancy.
                ...r,
                txAmount: sourceTxAmount,
                tenantName: '', tenantId: '',
                tenancyLabel: '', tenancyId: '',
                unitName: '', unitId: '',
                propertyId: '',
                matchType: `Split 1/${N}`,
                score: 0,
                status: 'unmatched',
            };
            newResults.push(portion0);
            // Children become Portions 2..N
            children.forEach((child, k) => {
                const portionIdx = k + 1;
                const portionAmt = portionAmounts[portionIdx] * (sourceRaw === 0 ? 1 : (Number(getField(tx, F.txAmount)) >= 0 ? 1 : -1));
                const cats = st.mode === 'custom' ? {
                    categoryId: '', categoryName: '',
                    subCatId: portionCats[portionIdx].subCatId || '',
                    subCatName: portionCats[portionIdx].subCatId ? getSubCatName(portionCats[portionIdx].subCatId) : '',
                    businessId: portionCats[portionIdx].businessId || '', businessName: '',
                    tenantName: '', tenantId: '',
                    tenancyLabel: '', tenancyId: portionCats[portionIdx].tenancyId || '',
                    unitName: '', unitId: portionCats[portionIdx].unitId || '',
                    propertyId: '',
                    costLabel: '', costId: portionCats[portionIdx].costId || '',
                } : {
                    // Equal mode: keep parent's category/sub-cat/business/cost
                    // (those usually apply to every portion) but CLEAR the
                    // per-tenancy fields. Children must each be assigned a
                    // tenancy explicitly — silent inheritance was the bug
                    // that left every IMMO LTD split linked to one unit.
                    categoryId: r.categoryId, categoryName: r.categoryName,
                    subCatId: r.subCatId, subCatName: r.subCatName,
                    businessId: r.businessId, businessName: r.businessName,
                    tenantName: '', tenantId: '',
                    tenancyLabel: '', tenancyId: '',
                    unitName: '', unitId: '',
                    propertyId: '',
                    costLabel: r.costLabel, costId: r.costId,
                };
                newResults.push({
                    txId: child.id,
                    txDate: r.txDate, txVendor: r.txVendor, txDesc: r.txDesc,
                    txAccount: r.txAccount,
                    txAmount: portionAmt,
                    ...cats,
                    matchType: `Split ${portionIdx + 1}/${N}` + (st.mode === 'custom' ? ' (custom)' : ''),
                    score: 0,
                    // Equal mode: ALWAYS unmatched, regardless of parent's
                    // prior status. Forces user to set per-portion tenancy.
                    status: st.mode === 'custom' ? 'suggestion' : 'unmatched',
                });
            });
            // Placeholders for any children polling missed
            const placeholdersNeeded = (N - 1) - children.length;
            for (let k = 0; k < placeholdersNeeded; k++) {
                newResults.push({
                    txId: 'pending-' + idx + '-' + k,
                    txDate: r.txDate, txVendor: r.txVendor,
                    txDesc: '⏳ Airtable still creating this portion — refresh in a few seconds',
                    txAccount: r.txAccount,
                    txAmount: portionAmounts[children.length + 1 + k] || 0,
                    categoryId: '', categoryName: '',
                    subCatId: '', subCatName: '',
                    businessId: '', businessName: '',
                    tenantName: '', tenantId: '',
                    tenancyLabel: '', tenancyId: '',
                    unitName: '', unitId: '', propertyId: '',
                    costLabel: '', costId: '',
                    matchType: 'Pending', score: 0, status: 'pending',
                });
            }

            // ── Step 6: Splice into _reconResults + re-render in-place ──
            window._reconResults.splice(idx, 1, ...newResults);
            const originals = window._reconOriginals || (window._reconOriginals = []);
            originals.splice(idx, 1, ...newResults.map(nr => ({
                categoryId: nr.categoryId, subCatId: nr.subCatId,
                businessId: nr.businessId, tenancyId: nr.tenancyId,
                unitId: nr.unitId, costId: nr.costId,
                status: nr.status,
            })));

            const tbody = document.getElementById('reconTableBody');
            if (tbody) {
                tbody.innerHTML = window._reconResults.map((rr, i) => reconRowHtml(rr, i)).join('');
                for (let k = 0; k < newResults.length; k++) {
                    const row = document.getElementById('recon-row-' + (idx + k));
                    if (row) {
                        row.style.transition = 'background-color 0.4s ease';
                        row.style.backgroundColor = 'var(--accent-soft, #DDE8DF)';
                        setTimeout(() => { row.style.backgroundColor = ''; }, 1600);
                    }
                }
                const firstNew = document.getElementById('recon-row-' + idx);
                if (firstNew) firstNew.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            window._reconChanged = true;
            const overlay = document.getElementById('reconSplitModal');
            if (overlay) overlay.remove();
        } catch (e) {
            console.error('[performReconSplit] failed', e);
            alert('Split failed: ' + (e && e.message ? e.message : 'unknown error') + '\n\nThe Split Count PATCH may or may not have succeeded — check Airtable directly. The original transaction was NOT modified by JS beyond the Split Count + name + (custom mode) Override field.');
            if (btn) { btn.disabled = false; btn.textContent = 'Save Split'; btn.style.opacity = '1'; }
        }
    }
    window.performReconSplit = performReconSplit;

    // PATCH a single transaction record. Used to write Split Count.
    async function patchTx(txId, fields) {
        const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${txId}?returnFieldsByFieldId=true`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields, typecast: true }),
        });
        if (!res.ok) throw new Error('PATCH failed: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
        return res.json();
    }

    // Poll Airtable for the N-1 child records that the Split Transactions
    // automation creates. Filter: same Vendor + same Date + **GBP equals
    // expected child amount (= original / N) within float tolerance + not
    // the source itself. Returns up to expectedCount records.
    //
    // Polls every 600ms for up to timeoutMs. Tolerates partial success —
    // returns what it has when the timeout fires so the recon panel can
    // show progress instead of hanging.
    async function pollForSplitChildren(opts) {
        const { vendor, date, childAmount, expectedCount, sourceTxId, timeoutMs } = opts;
        const startTime = Date.now();
        // Escape single quotes in the vendor for the formula
        const safeVendor = (vendor || '').replace(/'/g, "\\'");
        // Date filter: IS_SAME on the **Date field. Date is YYYY-MM-DD string.
        const formula = `AND(`
            + `{*Vendor} = '${safeVendor}',`
            + `IS_SAME({**Date}, '${date}', 'day'),`
            + `ABS({**GBP} - ${childAmount}) < 0.01,`
            + `RECORD_ID() != '${sourceTxId}'`
            + `)`;
        const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}`
            + `?filterByFormula=${encodeURIComponent(formula)}`
            + `&returnFieldsByFieldId=true&pageSize=50`;

        while (Date.now() - startTime < timeoutMs) {
            try {
                const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + PAT } });
                if (res.ok) {
                    const data = await res.json();
                    const records = (data.records || []).filter(rec => {
                        // Only count records created since we triggered the split
                        // (avoid grabbing pre-existing same-amount records).
                        const created = new Date(rec.createdTime).getTime();
                        return created >= startTime - 5000; // 5s grace before our start
                    });
                    if (records.length >= expectedCount) {
                        return records.slice(0, expectedCount).map(rec => ({
                            id: rec.id, fields: rec.fields || {},
                        }));
                    }
                }
            } catch (e) {
                console.warn('[pollForSplitChildren] fetch failed (will retry)', e);
            }
            await new Promise(resolve => setTimeout(resolve, 600));
        }
        // Timeout — return whatever we've found in the last poll. Re-fetch
        // one final time so we don't miss anything created right before the
        // timeout fired.
        try {
            const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + PAT } });
            if (res.ok) {
                const data = await res.json();
                const records = (data.records || []).filter(rec => {
                    const created = new Date(rec.createdTime).getTime();
                    return created >= startTime - 5000;
                });
                return records.slice(0, expectedCount).map(rec => ({
                    id: rec.id, fields: rec.fields || {},
                }));
            }
        } catch (e) { /* swallow */ }
        return [];
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

