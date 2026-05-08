// ══════════════════════════════════════════
// RENT STATEMENTS — Real-time rent balance for every tenancy
// ══════════════════════════════════════════
//
// Replaces the 7-stage arrears pipeline. Calculates a daily running
// balance per tenancy: total rent owed from start date minus total
// reconciled payments. Flags tenancies at >= 62 days arrears (2 months
// at 31 days/month) as Section 8 ready.
//
// Dependencies on globals from other files:
//   allTenancies, allTenants, allTransactions (loaded by dashboard.js)
//   F, TABLES, BASE_ID (config.js)
//   getField, getNumVal, extractLinkedId, escHtml, isTenantStatusActive (shared.js)

    // ── Tenant-type accessor ──
    function getTenantTypeForTenancy(tenancy, tenantLookup) {
        const tenant = getTenantForTenancy(tenancy, tenantLookup);
        if (!tenant) return null;
        const raw = getField(tenant, F.tenantPayType);
        const name = typeof raw === 'string' ? raw : (raw && raw.name ? raw.name : '');
        if (!name) return null;
        const lower = name.toLowerCase();
        if (lower.includes('universal credit')) return 'Universal Credit';
        if (lower.includes('agent')) return 'Agent-Managed';
        if (lower.includes('working')) return 'Working';
        return null;
    }

    // ── Tenant lookup helper (shared with cfv.js) ──
    function buildTenantLookup() {
        const lookup = {};
        allTenants.forEach(t => { lookup[t.id] = t; });
        return lookup;
    }

    function getTenantForTenancy(tenancy, tenantLookup) {
        const linked = getField(tenancy, F.tenLinkedTenant);
        if (!linked) return null;
        const tenantId = Array.isArray(linked) ? (typeof linked[0] === 'string' ? linked[0] : linked[0]?.id) : null;
        return tenantId ? tenantLookup[tenantId] : null;
    }

    // ── Transaction-to-tenancy link check ──
    function txLinkedToTenancy(tx, tenancyId) {
        const linked = getField(tx, F.txTenancy);
        if (!linked) return false;
        if (Array.isArray(linked)) {
            return linked.some(item => {
                const id = (typeof item === 'object' && item) ? item.id : item;
                return id === tenancyId;
            });
        }
        return (typeof linked === 'object' ? linked.id : linked) === tenancyId;
    }

    // ── Tenancy start date ──
    function getTenancyStartDate(tenancy) {
        const raw = String(getField(tenancy, F.tenStartDate) || '');
        if (!raw) return null;
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
    }

    // ══════════════════════════════════════════
    // RENT STATEMENT CALCULATION
    // ══════════════════════════════════════════

    const S8_THRESHOLD_DAYS = 62;

    // Reconciled transactions before this date aren't trustworthy.
    // Both rent owed and payments are calculated from this cutoff
    // (or tenancy start, whichever is later).
    const DATA_START = new Date('2025-04-01');

    // Compute the rent statement for a single tenancy.
    // Returns a structured object with every component of the maths.
    function computeRentStatement(tenancy, tenantType, today) {
        const tenStart = getTenancyStartDate(tenancy);
        if (!tenStart) {
            return { applicable: false, reason: 'No tenancy start date' };
        }
        if (tenStart > today) {
            return { applicable: false, reason: 'Tenancy has not started yet' };
        }

        const monthlyRent = Number(getField(tenancy, F.tenRent)) || 0;
        if (monthlyRent <= 0) {
            return { applicable: false, reason: 'No rent amount set' };
        }

        const effectiveStart = tenStart > DATA_START ? tenStart : DATA_START;
        const dailyRent = monthlyRent / 31;
        const daysSinceStart = Math.floor((today - effectiveStart) / 86400000);
        const totalRentOwed = dailyRent * daysSinceStart;

        // Reconciled transactions linked to this tenancy since the effective start
        const payments = [];
        let totalRentPaid = 0;
        for (const tx of allTransactions) {
            if (!getField(tx, F.txReconciled)) continue;
            if (!txLinkedToTenancy(tx, tenancy.id)) continue;
            const dateStr = String(getField(tx, F.txDate) || '');
            const txDate = dateStr ? new Date(dateStr) : null;
            if (txDate && txDate < effectiveStart) continue;
            const amount = txDisplayAmount(tx);
            const description = String(getField(tx, F.txDescription) || '').trim();
            const accountAlias = String(getField(tx, F.txAccountAlias) || '').trim();
            const vendor = String(getField(tx, F.txVendor) || '').trim();
            const categoryRaw = getField(tx, F.txCategory);
            const categoryId = Array.isArray(categoryRaw) ? (categoryRaw[0]?.id || categoryRaw[0] || '') : '';
            const subCatRaw = getField(tx, F.txSubCategory);
            const subCatId = Array.isArray(subCatRaw) ? (subCatRaw[0]?.id || subCatRaw[0] || '') : '';
            const unitRaw = getField(tx, F.txUnit);
            const unitId = Array.isArray(unitRaw) ? (unitRaw[0]?.id || unitRaw[0] || '') : '';
            const propertyRaw = getField(tx, F.txProperty);
            const propertyId = Array.isArray(propertyRaw) ? (propertyRaw[0]?.id || propertyRaw[0] || '') : '';
            const accountLinkRaw = getField(tx, F.txAccountLink);
            const accountLinkId = Array.isArray(accountLinkRaw) ? (accountLinkRaw[0]?.id || accountLinkRaw[0] || '') : '';
            payments.push({
                txId: tx.id,
                date: txDate,
                dateStr: dateStr.slice(0, 10),
                amount,
                description,
                vendor,
                accountAlias,
                categoryId,
                subCatId,
                unitId,
                propertyId,
                accountLinkId,
            });
            totalRentPaid += amount;
        }
        payments.sort((a, b) => (a.date || 0) - (b.date || 0));

        const balance = totalRentOwed - totalRentPaid;
        const daysInArrears = Math.round(balance / dailyRent);
        const s8Ready = daysInArrears >= S8_THRESHOLD_DAYS;

        return {
            applicable: true,
            tenantType: tenantType || 'Unknown',
            tenStart,
            effectiveStart,
            monthlyRent,
            dailyRent,
            daysSinceStart,
            totalRentOwed,
            totalRentPaid,
            payments,
            balance,
            daysInArrears,
            s8Ready,
        };
    }

    // Compute statements for all active tenancies. Returns sorted array.
    function computeAllRentStatements(today) {
        const tenantLookup = buildTenantLookup();
        const statements = [];

        for (const tenancy of allTenancies) {
            if (!isTenantStatusActive(tenancy)) continue;
            const tenantType = getTenantTypeForTenancy(tenancy, tenantLookup);
            const tenant = getTenantForTenancy(tenancy, tenantLookup);
            const tenantName = tenant
                ? String(getField(tenant, F.tenantName) || '')
                : String(getField(tenancy, F.tenSurname) || '—');
            const unitVal = getField(tenancy, F.tenUnitRef);
            const unit = Array.isArray(unitVal) ? unitVal[0] : (unitVal || '');
            const propertyVal = getField(tenancy, F.tenProperty);
            const property = Array.isArray(propertyVal) ? propertyVal[0] : (propertyVal || '');

            const stmt = computeRentStatement(tenancy, tenantType, today);
            if (!stmt.applicable) continue;

            statements.push({
                tenancyId: tenancy.id,
                tenancy,
                tenantName,
                unit,
                property,
                stmt,
            });
        }

        statements.sort((a, b) => b.stmt.daysInArrears - a.stmt.daysInArrears);
        return statements;
    }

    // ══════════════════════════════════════════
    // CFV INTEGRATION — kept for cfv.js compatibility
    // ══════════════════════════════════════════

    // Used by hasLinkedPaymentThisMonth in cfv.js to determine if a
    // tenancy is currently in arrears. Calendar-month based check.
    function isCurrentlyInArrears(tenancy, tenantType, today) {
        if (!getTenancyStartDate(tenancy)) return false;
        const tenStart = getTenancyStartDate(tenancy);
        if (tenStart && tenStart > today) return false;

        const dueDay = getNumVal(tenancy, F.tenDueDay, 1);
        const tolerance = 2;

        const paidIn = (y, m) => allTransactions.some(tx => {
            if (!getField(tx, F.txReconciled)) return false;
            if (!txLinkedToTenancy(tx, tenancy.id)) return false;
            const txDateStr = getField(tx, F.txDate);
            if (!txDateStr) return false;
            const txDate = new Date(txDateStr);
            return txDate.getFullYear() === y && txDate.getMonth() === m;
        });

        if (paidIn(today.getFullYear(), today.getMonth())) return false;

        const dueThisMonth = new Date(today.getFullYear(), today.getMonth(), dueDay);
        dueThisMonth.setHours(0, 0, 0, 0);
        const daysSinceDue = Math.floor((today - dueThisMonth) / 86400000);
        if (daysSinceDue >= tolerance) return true;

        const prevY = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
        const prevM = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
        return !paidIn(prevY, prevM);
    }

    // ══════════════════════════════════════════
    // UC RECURRING TASK AUTOMATION
    // ══════════════════════════════════════════
    //
    // On every dashboard load, scans UC tenancies that are "In Payment"
    // or "CFV Actioned" and ensures a task exists for 7 days before the
    // next rent due date. Pauses when status flips to CFV/Potential CFV.
    // Stops when tenancy has an end date in the past.

    const UC_TASK = {
        assigneeEmail:  'micaa.work@gmail.com',
        collaborators:  [
            { email: 'kevin@runpreneur.org.uk' },
            { email: 'atentaerica@gmail.com' },
        ],
        priority:       'Urgent',
        status:         'Upcoming',
        timeEstimate:   '15 min',
        hardDeadline:   true,
    };

    const ELIGIBLE_PAY_STATUSES = ['In Payment', 'CFV Actioned'];

    function ucTaskDateKey(d) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function ucCalcNextDueDate(dueDay, today) {
        if (!dueDay || dueDay < 1 || dueDay > 31) return null;
        const y = today.getFullYear();
        const m = today.getMonth();
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        const clampedDay = Math.min(dueDay, daysInMonth);
        let nextDue = new Date(y, m, clampedDay);
        if (nextDue <= today) {
            const nextM = m + 1;
            const daysInNext = new Date(y, nextM + 1, 0).getDate();
            nextDue = new Date(y, nextM, Math.min(dueDay, daysInNext));
        }
        return nextDue;
    }

    function ucCalcTaskDueDate(rentDueDate) {
        const d = new Date(rentDueDate);
        d.setDate(d.getDate() - 7);
        return d;
    }

    function ucTaskNameForTenancy(tenantName, rent, rentDueDate) {
        const dueStr = rentDueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        return `UC verification: ${tenantName}, £${rent.toFixed(2)} due ${dueStr}`;
    }

    function ucTaskDescription(tenantName, rent, rentDueDate, unitName, propertyName) {
        const dueStr = rentDueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        return [
            'UC Payment Verification (7 days before due)',
            '',
            `Tenant: ${tenantName}`,
            `Expected rent: £${rent.toFixed(2)}`,
            `Rent due date: ${dueStr}`,
            unitName ? `Unit: ${unitName}` : '',
            propertyName ? `Property: ${propertyName}` : '',
            '',
            `UC Office: ${UC_CONTACT.phone}`,
            '',
            'Confirm with UC:',
            '1. The payment is scheduled',
            '2. It is being processed',
            '3. It will be paid to the landlord',
            '',
            'If delayed, suspended, or reduced: escalate to Kevin immediately.',
        ].filter(Boolean).join('\n');
    }

    async function syncUCRecurringTasks() {
        if (!PAT || !allTenancies?.length || !allTenants?.length) return;

        const tenantLookup = buildTenantLookup();
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const candidates = [];
        for (const ten of allTenancies) {
            const tenantType = getTenantTypeForTenancy(ten, tenantLookup);
            if (tenantType !== 'Universal Credit') continue;

            const statusRaw = getField(ten, F.tenPayStatus);
            const statusName = typeof statusRaw === 'object' && statusRaw ? statusRaw.name : statusRaw;
            if (!ELIGIBLE_PAY_STATUSES.includes(statusName)) continue;

            const endDateStr = getField(ten, F.tenEndDate);
            if (endDateStr) {
                const endDate = new Date(endDateStr);
                if (!isNaN(endDate.getTime()) && endDate < today) continue;
            }

            if (!isTenantStatusActive(ten)) continue;

            const dueDay = Number(getField(ten, F.tenDueDay)) || 0;
            if (!dueDay) continue;

            const nextDue = ucCalcNextDueDate(dueDay, today);
            if (!nextDue) continue;

            const taskDue = ucCalcTaskDueDate(nextDue);

            const tenant = getTenantForTenancy(ten, tenantLookup);
            const tenantName = tenant ? (getField(tenant, F.tenantName) || 'Unknown') : 'Unknown';
            const rent = Number(getField(ten, F.tenRent)) || 0;

            const unitRef = getField(ten, F.tenUnitRef);
            const unitName = Array.isArray(unitRef) ? unitRef[0] : (unitRef || '');
            const propRef = getField(ten, F.tenProperty);
            const propertyName = Array.isArray(propRef) ? propRef[0] : (propRef || '');

            const unitRaw = getField(ten, F.tenUnit);
            const unitId = Array.isArray(unitRaw) ? (unitRaw[0]?.id || unitRaw[0]) : '';
            const tenantId = tenant ? tenant.id : '';

            const linkedTenantRaw = getField(ten, F.tenLinkedTenant);
            const linkedTenantId = Array.isArray(linkedTenantRaw)
                ? (typeof linkedTenantRaw[0] === 'string' ? linkedTenantRaw[0] : linkedTenantRaw[0]?.id)
                : '';

            candidates.push({
                tenancyId: ten.id,
                tenantId: linkedTenantId,
                unitId,
                tenantName,
                rent,
                nextDue,
                taskDue,
                unitName,
                propertyName,
            });
        }

        if (!candidates.length) return;

        const existingTasks = await ucFetchExistingTasks(candidates.map(c => c.tenancyId));

        let created = 0;
        for (const c of candidates) {
            const candidateTaskDueKey = ucTaskDateKey(c.taskDue);
            const already = existingTasks.some(t => {
                const linked = t.fields?.['fldmne4RYJU22ICub'];
                if (!linked) return false;
                const ids = Array.isArray(linked) ? linked.map(x => x?.id || x) : [];
                if (!ids.includes(c.tenancyId)) return false;
                const tDue = t.fields?.['fld7XP8w8kbxfETV4'] || '';
                return tDue === candidateTaskDueKey;
            });

            if (already) continue;

            try {
                if (created > 0) await new Promise(r => setTimeout(r, 500));
                await ucCreateTask(c);
                created++;
            } catch (err) {
                console.warn('UC task create failed for', c.tenantName, err);
            }
        }

        if (created > 0) {
            console.log(`UC tasks: created ${created} new verification tasks`);
        }
    }

    async function ucFetchExistingTasks(tenancyIds) {
        const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLES.tasks}?returnFieldsByFieldId=true&pageSize=100`
            + `&fields[]=fldgFjGBw6bTKJFCD&fields[]=fld7XP8w8kbxfETV4&fields[]=fldmne4RYJU22ICub&fields[]=fldx4qCw17UfrKpaN`;

        const all = [];
        let offset = '';
        do {
            const sep = url.includes('?') ? '&' : '?';
            const fetchUrl = offset ? `${url}${sep}offset=${offset}` : url;
            const resp = await fetch(fetchUrl, {
                headers: { 'Authorization': `Bearer ${PAT}` },
            });
            if (!resp.ok) break;
            const data = await resp.json();
            if (data.records) all.push(...data.records);
            offset = data.offset || '';
        } while (offset);

        return all.filter(t => {
            const name = t.fields?.['fldgFjGBw6bTKJFCD'] || '';
            return name.startsWith('UC verification:');
        });
    }

    async function ucCreateTask(c) {
        const taskName = ucTaskNameForTenancy(c.tenantName, c.rent, c.nextDue);
        const description = ucTaskDescription(c.tenantName, c.rent, c.nextDue, c.unitName, c.propertyName);
        const dueDateStr = ucTaskDateKey(c.taskDue);

        const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLES.tasks}`;

        const createResp = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fields: {
                    'fldgFjGBw6bTKJFCD': taskName,
                    'fldELMncVJYPDRJNc': { email: UC_TASK.assigneeEmail },
                },
                typecast: true,
            }),
        });

        if (!createResp.ok) {
            const err = await createResp.json();
            throw new Error(err.error?.message || createResp.statusText);
        }

        const created = await createResp.json();
        const recordId = created.id;

        const patchFields = {
            'fldRGhBQViKZKtkQ6': description,
            'fld10VzzbiNNgRmIi': UC_TASK.timeEstimate,
            'fld7XP8w8kbxfETV4': dueDateStr,
            'fldx4qCw17UfrKpaN': UC_TASK.status,
            'fldS21RwmwOqt71LI': UC_TASK.priority,
            'fldZKzIxgyrQ8CG8a': UC_TASK.hardDeadline,
            'fldcq3t6uAPgWSOP8': UC_TASK.collaborators,
            'fldmne4RYJU22ICub': [c.tenancyId],
            'fldLu1Y4GzyWcDoxr': ['recoGcXRXCniyJsTz'],  // Business → Real Estate
        };

        if (c.tenantId) patchFields['fld6ZcfEogJmeQj2c'] = [c.tenantId];
        if (c.unitId) patchFields['fldEW648YtTZ6j01n'] = [c.unitId];

        if (c.unitId && allRentalUnits?.length) {
            const unitRec = allRentalUnits.find(u => u.id === c.unitId);
            if (unitRec) {
                const propLinked = unitRec.fields?.['fldUJNRGgzgyAwwjt'] || unitRec.fields?.[F.unitProperty];
                const propId = Array.isArray(propLinked) ? (propLinked[0]?.id || propLinked[0]) : propLinked;
                if (propId) patchFields['fldZKFvEpJ6NZeFKz'] = [propId];
            }
        }

        const patchResp = await fetch(`${url}/${recordId}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: patchFields, typecast: true }),
        });

        if (!patchResp.ok) {
            console.warn('UC task patch failed for', c.tenantName);
        }

        return recordId;
    }

    async function runArrearsEngine() {
        try {
            await syncUCRecurringTasks();
        } catch (err) {
            console.warn('UC recurring task sync failed:', err);
        }
    }

    // ══════════════════════════════════════════
    // RENT STATEMENTS VIEW
    // ══════════════════════════════════════════

    function fmtMoney(n) {
        const abs = Math.abs(n);
        const formatted = '£' + abs.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return n < 0 ? '-' + formatted : formatted;
    }

    function toggleRentBreakdown(rowId, parentRow) {
        const row = document.getElementById(rowId);
        if (!row) return;
        const isHidden = row.style.display === 'none';
        row.style.display = isHidden ? 'table-row' : 'none';
        const chevron = parentRow.querySelector('[data-chevron]');
        if (chevron) chevron.innerHTML = isHidden ? '&#x25BE;' : '&#x25B8;';
    }
    window.toggleRentBreakdown = toggleRentBreakdown;

    // ── Searchable dropdown builder (mirrors reconciliation.js pattern) ──
    let _rsDlCounter = 0;
    function rsDropdown(id, items, selectedId, width, onchangeAttr) {
        const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
        const dlId = 'rsdl_' + (++_rsDlCounter);
        const selected = sorted.find(i => i.id === selectedId);
        const val = selected ? selected.name : '';
        const style = `font-size:10px;padding:2px 4px;width:${width};border:1px solid var(--border-default);border-radius:var(--radius-sm);background:var(--bg-surface)`;
        const onChange = onchangeAttr ? ` onchange="${onchangeAttr}"` : '';
        return `<datalist id="${dlId}">${sorted.map(i => `<option value="${escHtml(i.name)}" data-id="${i.id}">`).join('')}</datalist><input id="${id}" list="${dlId}" value="${escHtml(val)}" style="${style}" autocomplete="off" placeholder="Search..."${onChange}>`;
    }

    function rsResolveId(inputId) {
        const input = document.getElementById(inputId);
        if (!input || !input.value) return '';
        const dl = document.getElementById(input.getAttribute('list'));
        if (!dl) return input.value;
        const opt = [...dl.options].find(o => o.value === input.value);
        return opt ? opt.getAttribute('data-id') : '';
    }

    function rsCatItems() { return (allCategories || []).map(r => ({ id: r.id, name: getField(r, 'fldii4oUzSfmplihO') || '' })); }
    function rsSubCatItems() { return (allSubCategories || []).map(r => ({ id: r.id, name: getField(r, 'fldO4BTJhFv5EsN6i') || '' })); }
    function rsTenantItems() {
        return (allTenants || []).filter(t => {
            const s = getField(t, F.tenantStatus);
            return s && (typeof s === 'object' ? s.name === 'Active' : String(s).toLowerCase() === 'active');
        }).map(t => ({ id: t.id, name: getField(t, F.tenantName) || '' }));
    }
    function rsTenancyItems() {
        return (allTenancies || []).filter(t => isTenantStatusActive(t)).map(t => {
            const ref = getField(t, F.tenRef) || '';
            const surname = getField(t, F.tenSurname) || '';
            return { id: t.id, name: ref ? `${ref} (${surname})` : surname };
        });
    }
    function rsUnitItems() {
        const seen = new Set(), items = [];
        (allTenancies || []).forEach(r => {
            const unitField = getField(r, F.tenUnit);
            const unitId = Array.isArray(unitField) ? unitField[0] : unitField;
            const unitRef = getField(r, F.tenUnitRef);
            const unitName = Array.isArray(unitRef) ? unitRef[0] : (unitRef || '');
            if (!unitId || seen.has(unitId)) return;
            seen.add(unitId);
            items.push({ id: unitId, name: unitName });
        });
        return items;
    }
    function rsPropertyItems() {
        const seen = new Set(), items = [];
        const unitPropertyField = 'fldUJNRGgzgyAwwjt';
        const propNameByRecId = {};
        (allTenancies || []).forEach(r => {
            const propName = getField(r, F.tenProperty);
            const name = Array.isArray(propName) ? propName[0] : (propName || '');
            const unitRaw = getField(r, F.tenUnit);
            const unitId = Array.isArray(unitRaw) ? unitRaw[0] : unitRaw;
            if (!name || !unitId) return;
            const unit = (allRentalUnits || []).find(u => u.id === unitId);
            if (!unit) return;
            const propLinked = unit.fields[unitPropertyField];
            const propRecId = Array.isArray(propLinked) ? propLinked[0] : propLinked;
            if (propRecId && !seen.has(propRecId)) {
                seen.add(propRecId);
                propNameByRecId[propRecId] = name;
                items.push({ id: propRecId, name });
            }
        });
        return items;
    }
    function rsAccountItems() {
        return (allAccounts || []).map(r => {
            const name = getField(r, F.accountAlias) || r.id;
            return { id: r.id, name: String(name) };
        });
    }

    // ── PATCH a single transaction field ──
    async function rsPatchTxField(txId, fieldId, value) {
        const fields = {};
        fields[fieldId] = value;
        const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${txId}?returnFieldsByFieldId=true`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields, typecast: true }),
        });
        if (!res.ok) throw new Error('PATCH failed: HTTP ' + res.status);
        return res.json();
    }

    async function rsSaveTxField(txId, fieldId, inputId, isLinked) {
        const input = document.getElementById(inputId);
        if (!input) return;
        const indicator = input.parentElement.querySelector('.rs-save-indicator');
        if (indicator) { indicator.textContent = '⏳'; indicator.style.color = 'var(--text-muted)'; }

        const localTx = allTransactions.find(t => t.id === txId);
        const oldRaw = localTx ? localTx.fields[fieldId] : undefined;

        try {
            let value;
            if (isLinked) {
                const resolvedId = rsResolveId(inputId);
                value = resolvedId ? [resolvedId] : [];
            } else {
                value = input.value;
            }
            await rsPatchTxField(txId, fieldId, value);
            if (localTx) {
                if (isLinked) {
                    const resolvedId = rsResolveId(inputId);
                    localTx.fields[fieldId] = resolvedId ? [{ id: resolvedId }] : [];
                } else {
                    localTx.fields[fieldId] = value;
                }
            }
            if (indicator) { indicator.textContent = '✓'; indicator.style.color = 'var(--success)'; }
            setTimeout(() => { if (indicator) indicator.textContent = ''; }, 2000);

            if (fieldId === F.txTenancy) {
                const oldId = Array.isArray(oldRaw) ? (oldRaw[0]?.id || oldRaw[0] || '') : '';
                const newId = Array.isArray(value) ? (value[0] || '') : '';
                if (oldId !== newId) {
                    const oldUnit = localTx ? localTx.fields[F.txUnit] : undefined;
                    const oldProperty = localTx ? localTx.fields[F.txProperty] : undefined;
                    await rsCascadeFromTenancy(txId, newId, inputId);
                    rsRefreshAllOpenBreakdowns();
                    const label = !newId ? 'Tenancy removed from payment' : 'Payment moved to different tenancy';
                    rsShowUndoToast(txId, fieldId, oldRaw, label, oldUnit, oldProperty);
                }
            }
        } catch (err) {
            if (indicator) { indicator.textContent = '✗'; indicator.style.color = 'var(--danger)'; }
            if (typeof showToast === 'function') showToast('Save failed: ' + err.message, 'error');
        }
    }
    window.rsSaveTxField = rsSaveTxField;

    // When tenancy changes, auto-populate unit and property from the tenancy record.
    async function rsCascadeFromTenancy(txId, newTenancyId, tenancyInputId) {
        const prefix = tenancyInputId.replace(/tenancy$/, '');
        const unitInput = document.getElementById(prefix + 'unit');
        const propertyInput = document.getElementById(prefix + 'property');
        const localTx = allTransactions.find(t => t.id === txId);

        if (!newTenancyId) {
            // Cleared: blank out unit and property
            if (unitInput) unitInput.value = '';
            if (propertyInput) propertyInput.value = '';
            const fields = {};
            fields[F.txUnit] = [];
            fields[F.txProperty] = [];
            await rsPatchTxField(txId, F.txUnit, []);
            await rsPatchTxField(txId, F.txProperty, []);
            if (localTx) {
                localTx.fields[F.txUnit] = [];
                localTx.fields[F.txProperty] = [];
            }
            return;
        }

        const tenancy = allTenancies.find(t => t.id === newTenancyId);
        if (!tenancy) return;

        // Resolve unit
        const unitRaw = getField(tenancy, F.tenUnit);
        const unitId = Array.isArray(unitRaw) ? unitRaw[0] : (unitRaw || '');
        const unitRefRaw = getField(tenancy, F.tenUnitRef);
        const unitName = Array.isArray(unitRefRaw) ? unitRefRaw[0] : (unitRefRaw || '');

        // Resolve property via unit → property chain
        const unitPropertyField = 'fldUJNRGgzgyAwwjt';
        let propRecId = '';
        let propName = '';
        if (unitId) {
            const unitRec = (allRentalUnits || []).find(u => u.id === unitId);
            if (unitRec) {
                const propLinked = unitRec.fields[unitPropertyField];
                propRecId = Array.isArray(propLinked) ? propLinked[0] : (propLinked || '');
            }
            const propNameRaw = getField(tenancy, F.tenProperty);
            propName = Array.isArray(propNameRaw) ? propNameRaw[0] : (propNameRaw || '');
        }

        // Update DOM inputs
        if (unitInput) unitInput.value = unitName;
        if (propertyInput) propertyInput.value = propName;

        // Save both to Airtable
        const unitValue = unitId ? [unitId] : [];
        const propValue = propRecId ? [propRecId] : [];
        await rsPatchTxField(txId, F.txUnit, unitValue);
        await rsPatchTxField(txId, F.txProperty, propValue);
        if (localTx) {
            localTx.fields[F.txUnit] = unitId ? [{ id: unitId }] : [];
            localTx.fields[F.txProperty] = propRecId ? [{ id: propRecId }] : [];
        }
    }

    // Refresh every open breakdown panel and its parent summary row.
    // Called after tenancy reassignment so both source and destination update.
    function rsRefreshAllOpenBreakdowns() {
        const tenantLookup = buildTenantLookup();
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const openBreakdowns = document.querySelectorAll('[id^="rentBreakdown_"]');
        for (const row of openBreakdowns) {
            if (row.style.display === 'none') continue;
            const tenancyId = row.id.replace('rentBreakdown_', '');
            const tenancy = allTenancies.find(t => t.id === tenancyId);
            if (!tenancy) continue;
            const tenantType = getTenantTypeForTenancy(tenancy, tenantLookup);
            const tenant = getTenantForTenancy(tenancy, tenantLookup);
            const tenantName = tenant ? String(getField(tenant, F.tenantName) || '') : String(getField(tenancy, F.tenSurname) || '—');
            const unitVal = getField(tenancy, F.tenUnitRef);
            const unit = Array.isArray(unitVal) ? unitVal[0] : (unitVal || '');
            const propertyVal = getField(tenancy, F.tenProperty);
            const property = Array.isArray(propertyVal) ? propertyVal[0] : (propertyVal || '');
            const stmt = computeRentStatement(tenancy, tenantType, today);
            if (!stmt.applicable) continue;
            const entry = { tenancyId, tenancy, tenantName, unit, property, stmt };
            const td = row.querySelector('td');
            if (td) td.innerHTML = renderBreakdownDetail(entry);
            const parentRow = row.previousElementSibling;
            if (parentRow) {
                const cells = parentRow.querySelectorAll('td');
                if (cells.length >= 5) {
                    const balanceColour = stmt.balance > 0 ? 'var(--danger)' : stmt.balance < 0 ? 'var(--success)' : 'var(--text-primary)';
                    cells[3].innerHTML = `<span style="font-weight:600;color:${balanceColour};font-variant-numeric:tabular-nums">${fmtMoney(stmt.balance)}</span>`;
                    const daysColour = stmt.daysInArrears >= S8_THRESHOLD_DAYS ? 'var(--danger)' : stmt.daysInArrears > 0 ? 'var(--warning)' : 'var(--success)';
                    const daysWeight = stmt.daysInArrears >= S8_THRESHOLD_DAYS ? '700' : '500';
                    cells[4].innerHTML = `<span style="font-weight:${daysWeight};color:${daysColour};font-variant-numeric:tabular-nums">${stmt.daysInArrears}</span>`;
                }
            }
        }
    }

    // Undo toast for rent statement actions
    let _rsUndoTimer = null;
    function rsShowUndoToast(txId, fieldId, oldValue, label, oldUnit, oldProperty) {
        const existing = document.getElementById('rsUndoToast');
        if (existing) existing.remove();
        if (_rsUndoTimer) clearTimeout(_rsUndoTimer);

        window._rsLastUndo = { txId, fieldId, oldValue, oldUnit, oldProperty };
        const toast = document.createElement('div');
        toast.id = 'rsUndoToast';
        toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:var(--bg-sidebar);color:#fff;padding:10px 14px;border-radius:8px;box-shadow:var(--shadow-lg);font-size:13px;z-index:2000;display:flex;align-items:center;gap:12px;max-width:400px';
        toast.innerHTML = `<span>${escHtml(label)}</span><button onclick="rsPerformUndo()" style="background:var(--accent-gold);color:var(--bg-sidebar);border:none;padding:4px 10px;border-radius:4px;font-weight:600;cursor:pointer;font-size:12px">Undo</button>`;
        document.body.appendChild(toast);
        _rsUndoTimer = setTimeout(() => { toast.remove(); window._rsLastUndo = null; }, 8000);
    }

    async function rsPerformUndo() {
        const action = window._rsLastUndo;
        if (!action) return;
        const toast = document.getElementById('rsUndoToast');
        if (toast) toast.remove();
        if (_rsUndoTimer) clearTimeout(_rsUndoTimer);
        window._rsLastUndo = null;

        try {
            await rsPatchTxField(action.txId, action.fieldId, action.oldValue || []);
            const localTx = allTransactions.find(t => t.id === action.txId);
            if (localTx) localTx.fields[action.fieldId] = action.oldValue || [];
            // Restore cascaded unit and property if they were captured
            if (action.oldUnit !== undefined) {
                await rsPatchTxField(action.txId, F.txUnit, action.oldUnit || []);
                if (localTx) localTx.fields[F.txUnit] = action.oldUnit || [];
            }
            if (action.oldProperty !== undefined) {
                await rsPatchTxField(action.txId, F.txProperty, action.oldProperty || []);
                if (localTx) localTx.fields[F.txProperty] = action.oldProperty || [];
            }
            renderArrearsSection('arrearsPipelineContainer');
            if (typeof showToast === 'function') showToast('Change undone', 'success');
        } catch (err) {
            if (typeof showToast === 'function') showToast('Undo failed: ' + err.message, 'error');
        }
    }
    window.rsPerformUndo = rsPerformUndo;

    function renderBreakdownDetail(entry) {
        const s = entry.stmt;
        const fmtDate = d => d instanceof Date ? d.toISOString().slice(0, 10) : '';
        const cellStyle = 'padding:4px 4px;vertical-align:middle;position:relative';
        const indicatorHtml = '<span class="rs-save-indicator" style="font-size:9px;position:absolute;top:1px;right:2px"></span>';

        const accountLookup = {};
        (allAccounts || []).forEach(r => { accountLookup[r.id] = getField(r, F.accountAlias) || r.id; });

        const paymentRows = s.payments.length
            ? s.payments.map((p, i) => {
                const prefix = `rstx_${p.txId}_`;
                const bg = i % 2 ? 'background:var(--bg-surface-2)' : '';
                const roStyle = 'font-size:10px;color:var(--text-secondary)';
                const accountName = accountLookup[p.accountLinkId] || p.accountAlias || '';
                const saveFn = (field) => `rsSaveTxField('${p.txId}','${field}','${prefix}${field === F.txCategory ? 'cat' : field === F.txSubCategory ? 'subcat' : field === F.txTenancy ? 'tenancy' : field === F.txUnit ? 'unit' : 'property'}',true)`;
                return `<tr style="${bg}">
                    <td style="${cellStyle};color:var(--text-muted);font-size:11px;width:24px">${i + 1}</td>
                    <td style="${cellStyle};width:80px;${roStyle}">${escHtml(p.dateStr)}</td>
                    <td style="${cellStyle};width:160px;${roStyle};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px" title="${escHtml(p.description)}">${escHtml(p.description)}</td>
                    <td style="${cellStyle};width:90px;${roStyle}">${escHtml(accountName)}</td>
                    <td style="${cellStyle};text-align:right;width:70px;font-variant-numeric:tabular-nums;${roStyle}">${fmtMoney(p.amount)}</td>
                    <td style="${cellStyle};width:110px">${rsDropdown(prefix + 'cat', rsCatItems(), p.categoryId, '100px', saveFn(F.txCategory))}<span class="rs-save-indicator" style="font-size:9px;position:absolute;top:1px;right:2px"></span></td>
                    <td style="${cellStyle};width:120px">${rsDropdown(prefix + 'subcat', rsSubCatItems(), p.subCatId, '110px', saveFn(F.txSubCategory))}<span class="rs-save-indicator" style="font-size:9px;position:absolute;top:1px;right:2px"></span></td>
                    <td style="${cellStyle};width:140px">${rsDropdown(prefix + 'tenancy', rsTenancyItems(), entry.tenancyId, '130px', saveFn(F.txTenancy))}<span class="rs-save-indicator" style="font-size:9px;position:absolute;top:1px;right:2px"></span></td>
                    <td style="${cellStyle};width:100px">${rsDropdown(prefix + 'unit', rsUnitItems(), p.unitId, '90px', saveFn(F.txUnit))}<span class="rs-save-indicator" style="font-size:9px;position:absolute;top:1px;right:2px"></span></td>
                    <td style="${cellStyle};width:100px">${rsDropdown(prefix + 'property', rsPropertyItems(), p.propertyId, '90px', saveFn(F.txProperty))}<span class="rs-save-indicator" style="font-size:9px;position:absolute;top:1px;right:2px"></span></td>
                </tr>`;
            }).join('')
            : '<tr><td colspan="10" style="padding:8px;color:var(--text-muted);font-style:italic">No reconciled payments</td></tr>';

        const balanceColour = s.balance > 0 ? 'var(--danger)' : 'var(--success)';
        const balanceLabel = s.balance > 0 ? 'Tenant owes' : 'Tenant in credit';

        return `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;font-size:12px;color:var(--text-secondary)">
                <div>
                    <div style="font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px">Tenancy details</div>
                    <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px">
                        <div>Tenancy start:</div><div>${fmtDate(s.tenStart)}</div>
                        <div>Calculation from:</div><div>${fmtDate(s.effectiveStart)} ${s.effectiveStart > s.tenStart ? '<span style="color:var(--text-muted)">(data cutoff)</span>' : '<span style="color:var(--text-muted)">(tenancy start)</span>'}</div>
                        <div>Monthly rent:</div><div>${fmtMoney(s.monthlyRent)}</div>
                        <div>Daily rent:</div><div>${fmtMoney(s.dailyRent)}</div>
                        <div>Days since calc start:</div><div>${s.daysSinceStart.toLocaleString()}</div>
                        <div>Tenant type:</div><div>${escHtml(s.tenantType)}</div>
                    </div>
                </div>
                <div>
                    <div style="font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px">Balance calculation</div>
                    <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px">
                        <div>Total rent owed:</div><div style="font-weight:600">${fmtMoney(s.totalRentOwed)}</div>
                        <div>Total rent paid:</div><div style="font-weight:600">${fmtMoney(s.totalRentPaid)}</div>
                        <div>Balance:</div><div style="font-weight:700;color:${balanceColour}">${fmtMoney(s.balance)} <span style="font-weight:400;font-size:11px">(${balanceLabel})</span></div>
                        <div>Days in arrears:</div><div style="font-weight:700;color:${s.daysInArrears >= S8_THRESHOLD_DAYS ? 'var(--danger)' : s.daysInArrears > 0 ? 'var(--warning)' : 'var(--success)'}">${s.daysInArrears}</div>
                        <div>Section 8 ready:</div><div>${s.s8Ready ? '<strong style="color:var(--danger)">Yes</strong> (>= 62 days)' : 'No'}</div>
                    </div>
                </div>
                <div style="grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;margin-top:8px">
                    <div style="font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.5px;color:var(--text-muted)">Reconciled payments (${s.payments.length})</div>
                    <button onclick="event.stopPropagation();rsOpenPrintStatement('${entry.tenancyId}')" style="font-size:11px;padding:4px 12px;border:1px solid var(--accent);border-radius:var(--radius-md);background:var(--accent-soft);color:var(--accent);cursor:pointer;font-weight:600">Print Statement</button>
                </div>
                <div style="grid-column:1/-1;overflow-x:auto">
                    <table style="width:100%;border-collapse:collapse;font-size:11px">
                        <thead><tr style="text-align:left;background:var(--bg-surface)">
                            <th style="padding:4px 4px;font-weight:600;color:var(--text-secondary);font-size:10px">#</th>
                            <th style="padding:4px 4px;font-weight:600;color:var(--text-secondary);font-size:10px">Date</th>
                            <th style="padding:4px 4px;font-weight:600;color:var(--text-secondary);font-size:10px">Description</th>
                            <th style="padding:4px 4px;font-weight:600;color:var(--text-secondary);font-size:10px">Account</th>
                            <th style="padding:4px 4px;font-weight:600;color:var(--text-secondary);font-size:10px;text-align:right">Amount</th>
                            <th style="padding:4px 4px;font-weight:600;color:var(--text-secondary);font-size:10px">Category</th>
                            <th style="padding:4px 4px;font-weight:600;color:var(--text-secondary);font-size:10px">Sub-Category</th>
                            <th style="padding:4px 4px;font-weight:600;color:var(--text-secondary);font-size:10px">Tenancy</th>
                            <th style="padding:4px 4px;font-weight:600;color:var(--text-secondary);font-size:10px">Unit</th>
                            <th style="padding:4px 4px;font-weight:600;color:var(--text-secondary);font-size:10px">Property</th>
                        </tr></thead>
                        <tbody>${paymentRows}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    function renderArrearsSection(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!allTenancies || !allTenancies.length || !allTransactions) {
            container.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:13px;text-align:center">
                Waiting for dashboard data to load.
            </div>`;
            return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const statements = computeAllRentStatements(today);

        // KPI aggregations
        const inArrears = statements.filter(e => e.stmt.balance > 0);
        const totalExposure = inArrears.reduce((sum, e) => sum + e.stmt.balance, 0);
        const s8Count = statements.filter(e => e.stmt.s8Ready).length;

        // Type badge palette
        const typeBadge = (type) => {
            const palette = { bg: 'var(--bg-subtle)', fg: 'var(--text-secondary)' };
            return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:${palette.bg};color:${palette.fg}">${escHtml(type || '—')}</span>`;
        };

        const s8Badge = `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:var(--danger);color:#fff">S8 Ready</span>`;

        // Build table rows
        const rows = statements.map(entry => {
            const s = entry.stmt;
            const balanceColour = s.balance > 0 ? 'var(--danger)' : s.balance < 0 ? 'var(--success)' : 'var(--text-primary)';
            const daysColour = s.daysInArrears >= S8_THRESHOLD_DAYS ? 'var(--danger)' : s.daysInArrears > 0 ? 'var(--warning)' : 'var(--success)';
            const daysWeight = s.daysInArrears >= S8_THRESHOLD_DAYS ? '700' : '500';
            const breakdownId = `rentBreakdown_${entry.tenancyId}`;

            return `<tr style="border-bottom:1px solid var(--border-subtle);cursor:pointer" onclick="toggleRentBreakdown('${breakdownId}', this)">
                <td style="padding:10px 12px">
                    <span style="display:inline-block;width:14px;color:var(--text-muted);font-size:10px" data-chevron>&#x25B8;</span>
                    <span style="font-weight:600">${escHtml(entry.tenantName)}</span>
                    ${entry.unit ? `<div style="font-size:11px;color:var(--text-muted);margin-left:14px">${escHtml(entry.unit)}</div>` : ''}
                </td>
                <td style="padding:10px 12px">${typeBadge(s.tenantType)}</td>
                <td style="padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums">${fmtMoney(s.monthlyRent)}</td>
                <td style="padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;color:${balanceColour}">${fmtMoney(s.balance)}</td>
                <td style="padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums;font-weight:${daysWeight};color:${daysColour}">${s.daysInArrears}</td>
                <td style="padding:10px 12px;text-align:center">${s.s8Ready ? s8Badge : ''}</td>
            </tr>
            <tr id="${breakdownId}" style="display:none;background:var(--bg-surface-2)">
                <td colspan="6" style="padding:16px 24px">${renderBreakdownDetail(entry)}</td>
            </tr>`;
        }).join('');

        const kpiCardsHtml = `
            <div class="cards-grid" style="margin-bottom:16px">
                <div class="kpi-card">
                    <div class="kpi-card-label">Tenancies in arrears</div>
                    <div class="kpi-card-value">${inArrears.length}</div>
                    <div class="kpi-card-sub">${statements.length} active tenancies total</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Total arrears exposure</div>
                    <div class="kpi-card-value text-red">${fmtMoney(totalExposure)}</div>
                    <div class="kpi-card-sub">Sum of all positive balances</div>
                </div>
                <div class="kpi-card" style="${s8Count > 0 ? 'border-color:var(--danger);border-width:2px' : ''}">
                    <div class="kpi-card-label" style="${s8Count > 0 ? 'color:var(--danger)' : ''}">Section 8 ready</div>
                    <div class="kpi-card-value ${s8Count > 0 ? 'text-red' : ''}">${s8Count}</div>
                    <div class="kpi-card-sub">${s8Count > 0 ? 'Tenancies at 62+ days arrears' : 'No tenancies at threshold'}</div>
                </div>
            </div>
        `;

        container.innerHTML = `
            <div class="section">
                <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
                    <h2 class="section-title" style="margin-bottom:0">Rent Statements</h2>
                    <span style="font-size:12px;color:var(--text-muted)">Daily balance from tenancy start. Rent owed = daily rate (monthly / 31) x days elapsed. Payments deducted from running total.</span>
                </div>
                ${kpiCardsHtml}
                <div style="overflow-x:auto">
                    <table style="width:100%;border-collapse:collapse;font-size:13px">
                        <thead>
                            <tr style="text-align:left;border-bottom:2px solid var(--border-default);background:var(--bg-surface-2)">
                                <th style="padding:8px 12px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary)">Tenant / Unit</th>
                                <th style="padding:8px 12px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary)">Type</th>
                                <th style="padding:8px 12px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary);text-align:right">Monthly rent</th>
                                <th style="padding:8px 12px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary);text-align:right">Balance</th>
                                <th style="padding:8px 12px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary);text-align:right">Days arrears</th>
                                <th style="padding:8px 12px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary);text-align:center">Section 8</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    // ── Debug helper ──
    function explainCFV(query) {
        if (!query) {
            console.log('Usage: explainCFV("Smith") or explainCFV("recXYZ")');
            return;
        }
        const q = String(query).toLowerCase();
        const matches = allTenancies.filter(t => {
            if (t.id.toLowerCase() === q) return true;
            const surname = String(getField(t, F.tenSurname) || '').toLowerCase();
            const ref = String(getField(t, F.tenRef) || '').toLowerCase();
            return surname.includes(q) || ref.includes(q);
        });
        if (matches.length === 0) {
            console.log(`No tenancies matched "${query}". Try a surname or record ID.`);
            return;
        }
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const tenantLookup = buildTenantLookup();
        matches.forEach(tenancy => {
            const surname = getField(tenancy, F.tenSurname) || '?';
            const ref = getField(tenancy, F.tenRef) || '?';
            const tenantType = getTenantTypeForTenancy(tenancy, tenantLookup);
            const stmt = computeRentStatement(tenancy, tenantType, today);
            console.group(`${surname} (${ref}) — ${tenancy.id}`);
            if (!stmt.applicable) {
                console.log('Not applicable:', stmt.reason);
            } else {
                console.log('Type:', stmt.tenantType);
                console.log('Monthly rent:', fmtMoney(stmt.monthlyRent));
                console.log('Effective start:', stmt.effectiveStart.toISOString().slice(0,10));
                console.log('Days since start:', stmt.daysSinceStart);
                console.log('Total owed:', fmtMoney(stmt.totalRentOwed));
                console.log('Total paid:', fmtMoney(stmt.totalRentPaid), `(${stmt.payments.length} payments)`);
                console.log('Balance:', fmtMoney(stmt.balance));
                console.log('Days arrears:', stmt.daysInArrears);
                console.log('S8 ready:', stmt.s8Ready);
            }
            console.groupEnd();
        });
    }

    // ── Printable Rent Statement ──
    function rsOpenPrintStatement(tenancyId) {
        const tenancy = allTenancies.find(t => t.id === tenancyId);
        if (!tenancy) return;
        const tenantLookup = buildTenantLookup();
        const tenant = getTenantForTenancy(tenancy, tenantLookup);
        const tenantName = tenant ? String(getField(tenant, F.tenantName) || '') : String(getField(tenancy, F.tenSurname) || '');
        const unitVal = getField(tenancy, F.tenUnitRef);
        const unit = Array.isArray(unitVal) ? unitVal[0] : (unitVal || '');
        const propertyVal = getField(tenancy, F.tenProperty);
        const property = Array.isArray(propertyVal) ? propertyVal[0] : (propertyVal || '');
        const tenantType = getTenantTypeForTenancy(tenancy, tenantLookup);
        const monthlyRent = Number(getField(tenancy, F.tenRent)) || 0;

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:center;justify-content:center';
        const panel = document.createElement('div');
        panel.style.cssText = 'background:var(--bg-surface);border-radius:var(--radius-lg);padding:24px;max-width:440px;width:90%;box-shadow:var(--shadow-lg)';
        const today = new Date();
        const defaultStart = DATA_START.toISOString().slice(0, 10);
        const defaultEnd = today.toISOString().slice(0, 10);
        panel.innerHTML = `
            <div style="font-weight:600;font-size:15px;margin-bottom:4px">Generate Rent Statement</div>
            <div style="font-size:12px;color:var(--text-secondary);margin-bottom:16px">${escHtml(tenantName)} — ${escHtml(unit)}, ${escHtml(property)}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
                <div>
                    <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">Start date</label>
                    <input id="rsStmtStart" type="date" value="${defaultStart}" style="width:100%;padding:6px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:13px;box-sizing:border-box">
                </div>
                <div>
                    <label style="font-size:11px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">End date</label>
                    <input id="rsStmtEnd" type="date" value="${defaultEnd}" style="width:100%;padding:6px 8px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:13px;box-sizing:border-box">
                </div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end">
                <button id="rsStmtCancel" style="padding:6px 16px;border:1px solid var(--border-default);border-radius:var(--radius-md);background:var(--bg-surface);cursor:pointer;font-size:13px">Cancel</button>
                <button id="rsStmtGenerate" style="padding:6px 16px;border:1px solid var(--accent);border-radius:var(--radius-md);background:var(--accent);color:#fff;cursor:pointer;font-size:13px;font-weight:600">Generate</button>
            </div>
        `;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        panel.querySelector('#rsStmtCancel').addEventListener('click', () => overlay.remove());
        panel.querySelector('#rsStmtGenerate').addEventListener('click', () => {
            const startDate = new Date(panel.querySelector('#rsStmtStart').value);
            const endDate = new Date(panel.querySelector('#rsStmtEnd').value);
            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) { alert('Select valid dates'); return; }
            overlay.remove();
            rsGeneratePrintStatement(tenancy, tenantName, unit, property, tenantType, monthlyRent, startDate, endDate);
        });
    }
    window.rsOpenPrintStatement = rsOpenPrintStatement;

    function rsGeneratePrintStatement(tenancy, tenantName, unit, property, tenantType, monthlyRent, startDate, endDate) {
        const dueDay = getNumVal(tenancy, F.tenDueDay, 1);

        const payments = [];
        let totalPaid = 0;
        for (const tx of allTransactions) {
            if (!getField(tx, F.txReconciled)) continue;
            if (!txLinkedToTenancy(tx, tenancy.id)) continue;
            const dateStr = String(getField(tx, F.txDate) || '');
            const txDate = dateStr ? new Date(dateStr) : null;
            if (!txDate) continue;
            if (txDate < startDate || txDate > endDate) continue;
            const amount = txDisplayAmount(tx);
            const desc = String(getField(tx, F.txDescription) || '').trim();
            payments.push({ date: txDate, dateStr: dateStr.slice(0, 10), amount, description: desc });
            totalPaid += amount;
        }
        payments.sort((a, b) => a.date - b.date);
        const fmtDateStr = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

        const rentDues = [];
        let cursor = new Date(startDate);
        let firstDue = new Date(cursor.getFullYear(), cursor.getMonth(), dueDay);
        if (firstDue < startDate) firstDue.setMonth(firstDue.getMonth() + 1);
        let d = new Date(firstDue);
        while (d <= endDate) {
            rentDues.push({ type: 'rent', date: new Date(d), amount: monthlyRent });
            d.setMonth(d.getMonth() + 1);
        }
        const totalOwed = rentDues.length * monthlyRent;

        const allEvents = [
            ...rentDues.map(r => ({ ...r, desc: `Monthly rent due` })),
            ...payments.map(p => ({ type: 'payment', date: p.date, amount: p.amount, desc: p.description || 'Payment received' })),
        ];
        allEvents.sort((a, b) => a.date - b.date || (a.type === 'rent' ? -1 : 1));

        let runningBalance = 0;
        const ledgerRows = [];
        for (const ev of allEvents) {
            if (ev.type === 'rent') {
                runningBalance += ev.amount;
                ledgerRows.push({ date: ev.date.toISOString().slice(0, 10), desc: ev.desc, debit: fmtMoney(ev.amount), credit: '', balance: fmtMoney(runningBalance) });
            } else {
                runningBalance -= ev.amount;
                ledgerRows.push({ date: ev.date.toISOString().slice(0, 10), desc: ev.desc, debit: '', credit: fmtMoney(ev.amount), balance: fmtMoney(runningBalance) });
            }
        }

        const balance = totalOwed - totalPaid;
        const dailyRent = monthlyRent / 31;
        const daysInArrears = dailyRent > 0 ? Math.round(balance / dailyRent) : 0;

        const printWin = window.open('', '_blank', 'width=800,height=900');
        printWin.document.write(`<!DOCTYPE html><html><head><title>Rent Statement — ${escHtml(tenantName)}</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
            * { margin:0; padding:0; box-sizing:border-box; }
            body { font-family:'Inter',sans-serif; color:#1C2422; padding:40px; font-size:12px; line-height:1.5; }
            h1 { font-size:20px; margin-bottom:4px; }
            .meta { color:#5A6660; font-size:12px; margin-bottom:24px; }
            .summary-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:24px; }
            .summary-box { border:1px solid #DDE1D9; border-radius:8px; padding:12px; }
            .summary-box .label { font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#5A6660; font-weight:600; }
            .summary-box .value { font-size:16px; font-weight:700; margin-top:4px; }
            table { width:100%; border-collapse:collapse; margin-bottom:24px; }
            th { text-align:left; padding:6px 8px; font-size:10px; text-transform:uppercase; letter-spacing:0.5px; color:#5A6660; font-weight:600; border-bottom:2px solid #DDE1D9; }
            td { padding:6px 8px; border-bottom:1px solid #E5E8E1; font-size:11px; }
            .text-right { text-align:right; }
            .text-danger { color:#C53030; }
            .text-success { color:#2C6E49; }
            .footer { margin-top:32px; font-size:10px; color:#8A928C; border-top:1px solid #E5E8E1; padding-top:12px; }
            @media print { body { padding:20px; } .no-print { display:none; } }
        </style></head><body>
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
            <div>
                <h1>Rent Statement</h1>
                <div class="meta">${fmtDateStr(startDate)} to ${fmtDateStr(endDate)}</div>
            </div>
            <button class="no-print" onclick="window.print()" style="padding:8px 20px;border:1px solid #2C6E49;border-radius:6px;background:#2C6E49;color:#fff;cursor:pointer;font-size:13px;font-weight:600">Print</button>
        </div>
        <div class="summary-grid">
            <div class="summary-box"><div class="label">Tenant</div><div class="value">${escHtml(tenantName)}</div></div>
            <div class="summary-box"><div class="label">Property / Unit</div><div class="value">${escHtml(property)} — ${escHtml(unit)}</div></div>
            <div class="summary-box"><div class="label">Monthly rent</div><div class="value">${fmtMoney(monthlyRent)}</div></div>
            <div class="summary-box"><div class="label">Tenant type</div><div class="value">${escHtml(tenantType || 'Unknown')}</div></div>
            <div class="summary-box"><div class="label">Total rent owed</div><div class="value">${fmtMoney(totalOwed)}</div></div>
            <div class="summary-box"><div class="label">Total paid</div><div class="value">${fmtMoney(totalPaid)}</div></div>
            <div class="summary-box"><div class="label">Balance</div><div class="value ${balance > 0 ? 'text-danger' : 'text-success'}">${fmtMoney(balance)}</div></div>
            <div class="summary-box"><div class="label">Days in arrears</div><div class="value ${daysInArrears > 0 ? 'text-danger' : ''}">${daysInArrears}</div></div>
        </div>
        <table>
            <thead><tr><th>Date</th><th>Description</th><th class="text-right">Debit</th><th class="text-right">Credit</th><th class="text-right">Balance</th></tr></thead>
            <tbody>${ledgerRows.map(r => `<tr><td>${r.date}</td><td>${escHtml(r.desc)}</td><td class="text-right">${r.debit}</td><td class="text-right">${r.credit}</td><td class="text-right" style="font-weight:600">${r.balance}</td></tr>`).join('')}</tbody>
        </table>
        <div class="footer">
            Generated ${new Date().toLocaleDateString('en-GB', { day:'numeric',month:'long',year:'numeric' })} at ${new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}.
            Monthly rent: ${fmtMoney(monthlyRent)}, due on the ${dueDay}${dueDay===1?'st':dueDay===2?'nd':dueDay===3?'rd':'th'} of each month.
            Rent charges: ${rentDues.length} months totalling ${fmtMoney(totalOwed)}. Payments: ${payments.length} transactions totalling ${fmtMoney(totalPaid)}.
        </div>
        </body></html>`);
        printWin.document.close();
    }

    // ── Reassign transaction to a different tenancy (legacy modal) ──
    async function rentStmtReassignTx(txId, currentTenancyId) {
        const activeTenancies = allTenancies.filter(t => isTenantStatusActive(t));
        const tenantLookup = buildTenantLookup();
        const options = activeTenancies
            .map(t => {
                const tenant = getTenantForTenancy(t, tenantLookup);
                const name = tenant ? String(getField(tenant, F.tenantName) || '') : String(getField(t, F.tenSurname) || '—');
                const unitVal = getField(t, F.tenUnitRef);
                const unit = Array.isArray(unitVal) ? unitVal[0] : (unitVal || '');
                return { id: t.id, label: `${name} — ${unit}`.trim() };
            })
            .sort((a, b) => a.label.localeCompare(b.label));

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:10000;display:flex;align-items:center;justify-content:center';
        const panel = document.createElement('div');
        panel.style.cssText = 'background:var(--bg-surface);border-radius:var(--radius-lg);padding:24px;max-width:480px;width:90%;max-height:70vh;display:flex;flex-direction:column;box-shadow:var(--shadow-lg)';
        panel.innerHTML = `
            <div style="font-weight:600;margin-bottom:12px">Reassign transaction to tenancy</div>
            <input id="rsSearchInput" type="text" placeholder="Search tenancies..." style="width:100%;padding:8px 12px;border:1px solid var(--border-default);border-radius:var(--radius-md);margin-bottom:8px;font-size:13px;box-sizing:border-box">
            <div id="rsOptionsList" style="overflow-y:auto;flex:1;border:1px solid var(--border-subtle);border-radius:var(--radius-md);max-height:300px"></div>
            <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
                <button id="rsCancelBtn" style="padding:6px 16px;border:1px solid var(--border-default);border-radius:var(--radius-md);background:var(--bg-surface);cursor:pointer;font-size:13px">Cancel</button>
            </div>
        `;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        const searchInput = panel.querySelector('#rsSearchInput');
        const optionsList = panel.querySelector('#rsOptionsList');
        const cancelBtn = panel.querySelector('#rsCancelBtn');

        function renderOptions(filter) {
            const q = (filter || '').toLowerCase();
            const filtered = q ? options.filter(o => o.label.toLowerCase().includes(q)) : options;
            optionsList.innerHTML = filtered.map(o => {
                const isCurrent = o.id === currentTenancyId;
                return `<div data-tid="${o.id}" style="padding:8px 12px;cursor:${isCurrent ? 'default' : 'pointer'};font-size:13px;border-bottom:1px solid var(--border-subtle);${isCurrent ? 'background:var(--accent-soft);color:var(--text-muted)' : ''}" ${isCurrent ? '' : 'class="rs-option"'}>${escHtml(o.label)}${isCurrent ? ' <span style="font-size:11px">(current)</span>' : ''}</div>`;
            }).join('');
        }
        renderOptions('');
        searchInput.focus();
        searchInput.addEventListener('input', () => renderOptions(searchInput.value));

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.remove(); return; }
        });
        cancelBtn.addEventListener('click', () => overlay.remove());

        optionsList.addEventListener('click', async (e) => {
            const opt = e.target.closest('[data-tid]');
            if (!opt || !opt.classList.contains('rs-option')) return;
            const newTenancyId = opt.dataset.tid;
            if (newTenancyId === currentTenancyId) return;

            opt.style.background = 'var(--accent-soft)';
            opt.textContent = 'Reassigning...';

            try {
                const fields = {};
                fields[F.txTenancy] = [newTenancyId];
                const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${txId}?returnFieldsByFieldId=true`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields, typecast: true }),
                });
                if (!res.ok) throw new Error('PATCH failed: HTTP ' + res.status);

                const localTx = allTransactions.find(t => t.id === txId);
                if (localTx) localTx.fields[F.txTenancy] = [{ id: newTenancyId }];

                overlay.remove();
                if (typeof showToast === 'function') showToast('Transaction reassigned', 'success');
                renderArrearsSection('arrearsPipelineContainer');
            } catch (err) {
                opt.textContent = 'Failed — try again';
                opt.style.background = 'var(--danger-bg)';
                if (typeof showToast === 'function') showToast('Reassign failed: ' + err.message, 'error');
            }
        });

        optionsList.addEventListener('mouseover', (e) => {
            const opt = e.target.closest('.rs-option');
            if (opt) opt.style.background = 'var(--bg-surface-2)';
        });
        optionsList.addEventListener('mouseout', (e) => {
            const opt = e.target.closest('.rs-option');
            if (opt) opt.style.background = '';
        });
    }
    window.rentStmtReassignTx = rentStmtReassignTx;

    // ── Expose to other modules ──
    window.runArrearsEngine = runArrearsEngine;
    window.loadArrearsRecords = async function() {}; // no-op stub
    window.getTenantTypeForTenancy = getTenantTypeForTenancy;
    window.renderArrearsSection = renderArrearsSection;
    window.isCurrentlyInArrears = isCurrentlyInArrears;
    window.explainCFV = explainCFV;
    window.txLinkedToTenancy = txLinkedToTenancy;
    window.computeRentStatement = computeRentStatement;
