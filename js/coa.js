// ══════════════════════════════════════════
// CHART OF ACCOUNTS — admin for the two Airtable coding lists
//   Chart of Accounts - Categories      (TABLES.categories,    10 records)
//   Chart of Accounts - Sub Categories  (TABLES.subCategories, 49 records)
//
// Reads allCategories / allSubCategories (already loaded by dashboard.js) and
// writes straight back to Airtable. Two guards make that safe:
//
//   RENAME  is blocked for any name the reporting code matches as a string
//           literal. The P&L groups by sub-category NAME, so renaming
//           "Opex Labour" drops that row to zero with no error anywhere. The
//           locked set is derived from the live constants (PNL_SECTIONS,
//           CASHFLOW_*_SUBCATS, PERSONAL_MONEY_GROUPS, BUCKET_SPEND_SUBCATS)
//           rather than copied, so it cannot drift out of step with them.
//
//   DELETE  is blocked while a record holds any link, and for records the code
//           pins by record ID. Airtable deletes a linked record without
//           complaint, orphaning every cost and transaction behind it.
// ══════════════════════════════════════════

    // ── Module state ──
    let _coaState = {
        search: '',
        busy: false,      // a write is in flight — every action button is disabled
        registered: false // sync bar registered
    };

    const COA_KINDS = {
        category: {
            label: 'Category',
            plural: 'Categories',
            table: () => TABLES.categories,
            nameField: () => CAT_NAME_FIELD,
            records: () => (typeof allCategories !== 'undefined' && allCategories) ? allCategories : [],
        },
        subCategory: {
            label: 'Sub-category',
            plural: 'Sub-categories',
            table: () => TABLES.subCategories,
            nameField: () => SUBCAT.name,
            records: () => (typeof allSubCategories !== 'undefined' && allSubCategories) ? allSubCategories : [],
        },
    };

    const COA_MONEY_GROUPS = ['Needs', 'Wants'];
    const COA_NAME_MAX = 100;

    function coaName(rec, kind) {
        return String(getField(rec, COA_KINDS[kind].nameField()) || '').trim();
    }

    function coaMoneyGroup(rec) {
        const v = getField(rec, SUBCAT.moneyGroup);
        if (v == null) return '';
        return typeof v === 'object' ? String(v.name || '') : String(v);
    }

    // ── Guard 1: names the reporting code matches as string literals ─────────────
    // Built fresh on every render from the live constants, so adding a sub-category
    // to PNL_SECTIONS automatically locks its name here too.
    function coaProtectedNames(kind) {
        const map = new Map(); // lowercased name → [reason, …]
        const add = (name, reason) => {
            const key = String(name || '').trim().toLowerCase();
            if (!key) return;
            if (!map.has(key)) map.set(key, []);
            const reasons = map.get(key);
            if (!reasons.includes(reason)) reasons.push(reason);
        };

        const extra = (typeof COA_EXTRA_PROTECTED !== 'undefined' && COA_EXTRA_PROTECTED[kind]) || {};
        Object.keys(extra).forEach(n => add(n, extra[n]));

        if (kind === 'subCategory') {
            if (typeof PNL_SECTIONS !== 'undefined') {
                PNL_SECTIONS.forEach(sec => (sec.subs || []).forEach(s => add(s, `Profit & Loss — ${sec.name} row`)));
            }
            if (typeof CASHFLOW_INCOME_SUBCATS !== 'undefined') {
                CASHFLOW_INCOME_SUBCATS.forEach(s => add(s, 'Wealth cash flow — real estate income'));
            }
            if (typeof CASHFLOW_PERSONAL_INCOME_SUBCATS !== 'undefined') {
                CASHFLOW_PERSONAL_INCOME_SUBCATS.forEach(s => add(s, 'Wealth cash flow — personal income'));
            }
            if (typeof CASHFLOW_COST_SUBCATS !== 'undefined') {
                CASHFLOW_COST_SUBCATS.forEach(s => add(s, 'Wealth cash flow — business costs'));
            }
            if (typeof PERSONAL_MONEY_GROUPS !== 'undefined') {
                Object.keys(PERSONAL_MONEY_GROUPS).forEach(s => add(s, 'Wealth personal budget (Needs / Wants split)'));
            }
            if (typeof BUCKET_SPEND_SUBCATS !== 'undefined') {
                Object.keys(BUCKET_SPEND_SUBCATS).forEach(bucket => {
                    (BUCKET_SPEND_SUBCATS[bucket] || []).forEach(s => add(s, `Income bucket draw-down — ${bucket}`));
                });
            }
        }
        return map;
    }

    // ── Guard 2: records the code pins by record ID ──────────────────────────────
    // A rename is safe for these (the ID never changes) but a delete is fatal, so
    // they stay undeletable even when the link count is zero.
    function coaPinnedIds(kind) {
        const map = new Map(); // record ID → [reason, …]
        if (kind !== 'subCategory') return map;
        const add = (id, reason) => {
            if (!id) return;
            if (!map.has(id)) map.set(id, []);
            const reasons = map.get(id);
            if (!reasons.includes(reason)) reasons.push(reason);
        };

        if (typeof COA_ID_PINNED_SUBCATS !== 'undefined') {
            Object.keys(COA_ID_PINNED_SUBCATS).forEach(id => add(id, COA_ID_PINNED_SUBCATS[id]));
        }
        if (typeof REC !== 'undefined') {
            add(REC.subRentalInc, 'Cash flow forecast and AI reconciliation pin this by ID (js/cashflow.js, js/reconciliation.js)');
            add(REC.subMaint, 'Dashboard maintenance KPI pins this by ID (js/dashboard.js)');
            add(REC.subOpexLabour, 'Dashboard wages KPI pins this by ID (js/dashboard.js)');
            add(REC.subCOGSLabour, 'Dashboard wages KPI pins this by ID (js/dashboard.js)');
        }
        if (typeof PERSONAL_EXPENSE_SUBCATS !== 'undefined') {
            PERSONAL_EXPENSE_SUBCATS.forEach(c => add(c.id, 'Wealth personal budget row pins this by ID (js/config.js)'));
        }
        return map;
    }

    // How many live links a record holds, broken down by the table it links to.
    function coaLinkBreakdown(rec, kind) {
        const defs = (typeof COA_LINK_FIELDS !== 'undefined' && COA_LINK_FIELDS[kind]) || [];
        const parts = [];
        let total = 0;
        defs.forEach(def => {
            const val = getField(rec, def.id);
            const n = Array.isArray(val) ? val.length : 0;
            if (n > 0) {
                parts.push(`${def.label}: ${n.toLocaleString()}`);
                total += n;
            }
        });
        return { total, parts };
    }

    // ── Render ──────────────────────────────────────────────────────────────────
    // coaPaint() repaints the two panes only. renderCoaTab() also re-runs the
    // health checks, so typing in the search box doesn't re-run six checks per
    // keystroke for a filter that changes no data.
    function coaPaint() {
        const host = document.getElementById('coaPanes');
        if (!host) return;
        const search = document.getElementById('coaSearch');
        if (search && search.value !== _coaState.search) search.value = _coaState.search;
        host.innerHTML = `${coaPaneHtml('category')}${coaPaneHtml('subCategory')}`;
        coaWireEvents();
    }

    function renderCoaTab() {
        if (!document.getElementById('coaPanes')) return;
        coaPaint();
        coaRegisterSyncBar();
        markTabSynced('coa');
    }

    function coaPaneHtml(kind) {
        const cfg = COA_KINDS[kind];
        const protectedNames = coaProtectedNames(kind);
        const pinned = coaPinnedIds(kind);
        const isSub = kind === 'subCategory';
        const q = _coaState.search.trim().toLowerCase();

        const all = cfg.records().slice().sort((a, b) =>
            coaName(a, kind).localeCompare(coaName(b, kind), 'en-GB', { sensitivity: 'base' }));
        const rows = q ? all.filter(r => coaName(r, kind).toLowerCase().includes(q)) : all;

        const body = rows.length === 0
            ? `<tr><td colspan="${isSub ? 3 : 2}" style="padding:20px;text-align:center;color:var(--text-muted);font-size:var(--fs-sm)">${
                all.length === 0
                    ? 'Nothing loaded yet. Use Refresh in the bar above.'
                    : `No ${escHtml(cfg.plural.toLowerCase())} match &ldquo;${escHtml(_coaState.search.trim())}&rdquo;.`
              }</td></tr>`
            : rows.map(rec => coaRowHtml(rec, kind, protectedNames, pinned)).join('');

        return `
            <div class="coa-pane">
                <div class="coa-pane-head">
                    <h3 class="coa-pane-title">${escHtml(cfg.plural)}<span class="coa-count" aria-live="polite">${rows.length}${rows.length !== all.length ? ` of ${all.length}` : ''}</span></h3>
                    <button type="button" class="coa-add-btn" data-coa-action="add" data-coa-kind="${kind}"${_coaState.busy ? ' disabled' : ''}>+ Add ${escHtml(cfg.label.toLowerCase())}</button>
                </div>
                <div class="coa-table-wrap">
                    <table class="coa-table">
                        <thead>
                            <tr>
                                <th>Name <span class="coa-th-sub">&amp; what is coded to it</span></th>
                                ${isSub ? '<th style="width:104px">Money Group</th>' : ''}
                                <th style="width:140px">Actions</th>
                            </tr>
                        </thead>
                        <tbody>${body}</tbody>
                    </table>
                </div>
            </div>`;
    }

    function coaRowHtml(rec, kind, protectedNames, pinned) {
        const isSub = kind === 'subCategory';
        const name = coaName(rec, kind);
        const links = coaLinkBreakdown(rec, kind);
        const nameReasons = protectedNames.get(name.toLowerCase()) || [];
        const idReasons = pinned.get(rec.id) || [];
        const renameLocked = nameReasons.length > 0;
        const deleteLocked = links.total > 0 || renameLocked || idReasons.length > 0;
        const dis = _coaState.busy ? ' disabled' : '';

        // Sits under the name rather than in its own column: at two panes side by
        // side there is not enough width for four columns, and the first casualty
        // was the Delete button running off the edge of the pane.
        const usageText = links.parts.join(' · ');
        const usage = links.total === 0
            ? '<span class="coa-usage coa-usage-none">Nothing coded to it</span>'
            : `<span class="coa-usage" title="${escHtml(usageText)}">${escHtml(usageText)}</span>`;

        // The blocked Delete stays clickable on purpose — clicking it explains why.
        // The tooltip means you don't have to click to find out, and gives a screen
        // reader something to read other than a plain "Delete".
        const deleteHint = !deleteLocked ? ''
            : links.total > 0 ? ` title="Cannot delete — ${escHtml(usageText)} still coded to it"`
            : ` title="Cannot delete — ${escHtml((nameReasons.concat(idReasons))[0] || 'the app depends on this record')}"`;

        const mgCell = isSub ? `
            <td>
                <select class="coa-mg-select" data-coa-action="money-group" data-coa-id="${escHtml(rec.id)}" aria-label="Money Group for ${escHtml(name)}"${dis}>
                    <option value=""${coaMoneyGroup(rec) === '' ? ' selected' : ''}>—</option>
                    ${COA_MONEY_GROUPS.map(g => `<option value="${escHtml(g)}"${coaMoneyGroup(rec) === g ? ' selected' : ''}>${escHtml(g)}</option>`).join('')}
                </select>
            </td>` : '';

        return `
            <tr>
                <td>
                    <div class="coa-name-line">
                        <span class="coa-name" title="${escHtml(name)}">${escHtml(name) || '<em style="color:var(--text-muted)">(no name)</em>'}</span>
                        ${renameLocked ? '<span class="coa-lock" aria-hidden="true" title="Name locked — the reports match on it">&#128274;</span>' : ''}
                    </div>
                    <div class="coa-usage-line">${usage}</div>
                </td>
                ${mgCell}
                <td class="coa-actions">
                    <div>
                        <button type="button" class="coa-btn" data-coa-action="rename" data-coa-kind="${kind}" data-coa-id="${escHtml(rec.id)}"${dis}>Rename</button>
                        <button type="button" class="coa-btn coa-btn-danger" data-coa-action="delete" data-coa-kind="${kind}" data-coa-id="${escHtml(rec.id)}"${dis}${deleteLocked ? ' data-coa-blocked="1"' : ''}${deleteHint}>Delete</button>
                    </div>
                </td>
            </tr>`;
    }

    // ── Events (delegated once — rows are re-rendered on every write) ────────────
    function coaWireEvents() {
        const host = document.getElementById('coaPanes');
        if (host && !host.dataset.coaWired) {
            host.dataset.coaWired = '1';
            host.addEventListener('click', ev => {
                const btn = ev.target.closest('[data-coa-action]');
                if (!btn || btn.tagName === 'SELECT') return;
                const action = btn.dataset.coaAction;
                if (action === 'add') coaOpenAdd(btn.dataset.coaKind);
                else if (action === 'rename') coaOpenRename(btn.dataset.coaKind, btn.dataset.coaId);
                else if (action === 'delete') coaHandleDelete(btn.dataset.coaKind, btn.dataset.coaId);
            });
            host.addEventListener('change', ev => {
                const sel = ev.target.closest('select[data-coa-action="money-group"]');
                if (sel) coaSetMoneyGroup(sel.dataset.coaId, sel.value);
            });
        }
        const search = document.getElementById('coaSearch');
        if (search && !search.dataset.coaWired) {
            search.dataset.coaWired = '1';
            // Repaint only — the input lives outside #coaPanes, so it keeps focus.
            search.addEventListener('input', () => {
                _coaState.search = search.value;
                coaPaint();
            });
        }
    }

    function coaFind(kind, id) {
        return COA_KINDS[kind].records().find(r => r.id === id) || null;
    }

    // ── Actions ─────────────────────────────────────────────────────────────────
    function coaOpenAdd(kind) {
        const cfg = COA_KINDS[kind];
        coaOpenNameModal({
            title: `Add ${cfg.label.toLowerCase()}`,
            value: '',
            showMoneyGroup: kind === 'subCategory',
            moneyGroup: '',
            okLabel: 'Create',
            validate: name => coaValidateName(kind, name, null),
            onSave: (name, moneyGroup) => coaCreate(kind, name, moneyGroup),
        });
    }

    function coaOpenRename(kind, id) {
        const rec = coaFind(kind, id);
        if (!rec) { showToast('That record is no longer loaded — refresh the tab.', { type: 'error' }); return; }
        const name = coaName(rec, kind);
        const reasons = coaProtectedNames(kind).get(name.toLowerCase()) || [];
        if (reasons.length > 0) {
            coaOpenBlockedModal(
                'Rename locked',
                `"${name}" is matched by name in the app's reporting code. Renaming it here would leave those reports looking for a name that no longer exists, and they would quietly report zero instead of failing.\n\nDepends on this name:`,
                reasons,
                'Change the code first, then rename in the same release.'
            );
            return;
        }
        coaOpenNameModal({
            title: `Rename ${COA_KINDS[kind].label.toLowerCase()}`,
            value: name,
            showMoneyGroup: false,
            okLabel: 'Save',
            validate: newName => coaValidateName(kind, newName, id),
            onSave: newName => coaRename(kind, id, newName, name),
        });
    }

    // Returns an error string, or '' when the name is usable.
    function coaValidateName(kind, name, selfId) {
        const trimmed = String(name || '').trim();
        if (!trimmed) return 'Enter a name.';
        if (trimmed.length > COA_NAME_MAX) return `Keep it to ${COA_NAME_MAX} characters or fewer.`;
        const clash = COA_KINDS[kind].records().find(r =>
            r.id !== selfId && coaName(r, kind).toLowerCase() === trimmed.toLowerCase());
        if (clash) return `"${coaName(clash, kind)}" already exists. Names must be unique.`;
        return '';
    }

    async function coaCreate(kind, name, moneyGroup) {
        const cfg = COA_KINDS[kind];
        const fields = { [cfg.nameField()]: String(name).trim() };
        if (kind === 'subCategory' && moneyGroup) fields[SUBCAT.moneyGroup] = moneyGroup;
        await coaWrite({
            run: () => coaApi('POST', cfg.table(), null, { fields }),
            okMsg: `${cfg.label} "${String(name).trim()}" created.`,
            failMsg: `Could not create the ${cfg.label.toLowerCase()}`,
        });
    }

    async function coaRename(kind, id, newName, oldName) {
        const cfg = COA_KINDS[kind];
        await coaWrite({
            run: () => coaApi('PATCH', cfg.table(), id, { fields: { [cfg.nameField()]: String(newName).trim() } }),
            okMsg: `Renamed "${oldName}" to "${String(newName).trim()}".`,
            failMsg: 'Could not rename',
        });
    }

    async function coaSetMoneyGroup(id, value) {
        const rec = coaFind('subCategory', id);
        if (!rec) return;
        const oldValue = coaMoneyGroup(rec);
        const newValue = COA_MONEY_GROUPS.includes(value) ? value : '';
        if (newValue === oldValue) return;
        const name = coaName(rec, 'subCategory');
        const ok = await coaWrite({
            run: () => coaApi('PATCH', TABLES.subCategories, id, { fields: { [SUBCAT.moneyGroup]: newValue || null } }),
            okMsg: '',
            failMsg: 'Could not change the Money Group',
        });
        if (!ok) return;
        coaUndoToast(
            `${name} → ${newValue || 'no Money Group'}`,
            () => coaWrite({
                run: () => coaApi('PATCH', TABLES.subCategories, id, { fields: { [SUBCAT.moneyGroup]: oldValue || null } }),
                okMsg: `Money Group put back to ${oldValue || 'blank'}.`,
                failMsg: 'Could not undo',
            })
        );
    }

    async function coaHandleDelete(kind, id) {
        const rec = coaFind(kind, id);
        if (!rec) { showToast('That record is no longer loaded — refresh the tab.', { type: 'error' }); return; }
        const cfg = COA_KINDS[kind];
        const name = coaName(rec, kind);
        const links = coaLinkBreakdown(rec, kind);
        const nameReasons = coaProtectedNames(kind).get(name.toLowerCase()) || [];
        const idReasons = coaPinnedIds(kind).get(rec.id) || [];

        if (links.total > 0) {
            coaOpenBlockedModal(
                'Delete blocked — still in use',
                `"${name}" is linked to ${links.total.toLocaleString()} record${links.total === 1 ? '' : 's'}. Airtable would delete it anyway and leave every one of them with no coding at all.\n\nWhere it is used:`,
                links.parts,
                'Recode those records to another line first, then delete this one.'
            );
            return;
        }
        if (nameReasons.length > 0 || idReasons.length > 0) {
            coaOpenBlockedModal(
                'Delete blocked — the reports need it',
                `"${name}" has no links, but the app's code expects it to exist.\n\nDepends on it:`,
                nameReasons.concat(idReasons),
                'Change the code first, then delete in the same release.'
            );
            return;
        }

        const confirmed = await showConfirm(
            `Delete the ${cfg.label.toLowerCase()} "${name}"? Nothing is linked to it, so no cost or transaction loses its coding. This cannot be undone.`,
            { title: `Delete ${cfg.label.toLowerCase()}`, okLabel: 'Delete', danger: true }
        );
        if (!confirmed) return;

        await coaWrite({
            run: () => coaApi('DELETE', cfg.table(), id),
            okMsg: `${cfg.label} "${name}" deleted.`,
            failMsg: 'Could not delete',
        });
    }

    // ── Airtable I/O ────────────────────────────────────────────────────────────
    // Retries on 429 the same way airtableFetch does. Returns the parsed body.
    async function coaApi(method, tableId, recordId, body) {
        const url = `https://api.airtable.com/v0/${BASE_ID}/${tableId}` + (recordId ? `/${recordId}` : '');
        let resp;
        for (let attempt = 0; attempt < 4; attempt++) {
            resp = await fetch(url, {
                method,
                headers: {
                    'Authorization': 'Bearer ' + PAT,
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
            if (resp.status === 429) {
                await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 8000)));
                continue;
            }
            break;
        }
        if (!resp.ok) {
            // Airtable puts the useful part in the body; the status alone says nothing.
            let detail = '';
            try {
                const err = await resp.json();
                detail = (err && err.error && (err.error.message || err.error.type)) || '';
            } catch (_) { /* non-JSON body — the status will have to do */ }
            throw new Error(detail ? `${resp.status} — ${detail}` : `HTTP ${resp.status}`);
        }
        return resp.status === 200 ? resp.json() : null;
    }

    // One write, then a full reload of both lists so link counts and field shapes
    // come back from Airtable rather than being guessed locally. Returns true on
    // success. 59 records across two tables — the round trip is not worth optimising.
    async function coaWrite({ run, okMsg, failMsg }) {
        if (_coaState.busy) {
            // Repaint so a control the user already moved (the Money Group select)
            // snaps back to the value Airtable actually holds.
            coaPaint();
            return false;
        }
        _coaState.busy = true;
        coaPaint();
        try {
            await run();
            await coaReloadLists();
            if (okMsg) showToast(okMsg, { type: 'success' });
            return true;
        } catch (err) {
            showToast(`${failMsg}: ${err.message}`, { type: 'error', duration: 7000 });
            return false;
        } finally {
            _coaState.busy = false;
            renderCoaTab(); // re-runs the health checks — the data really did change
        }
    }

    // Refetch both tables into the globals every other tab reads, so the Costs,
    // Transactions and Reconciliation pickers see the change without a reload.
    async function coaReloadLists() {
        const [categories, subCategories] = await Promise.all([
            airtableFetch(TABLES.categories),
            airtableFetch(TABLES.subCategories),
        ]);
        allCategories = categories;
        allSubCategories = subCategories;
        // The dashboard's IndexedDB cache still holds the old lists and would serve
        // them on the next cold load. Drop it rather than patch it: a partial
        // rewrite of a nine-table payload is exactly how a cache goes subtly wrong.
        if (typeof clearDashCache === 'function') {
            try { await clearDashCache(); } catch (e) { console.warn('[coa] cache clear failed:', e); }
        }
    }

    // ── Modals ──────────────────────────────────────────────────────────────────
    function coaOpenNameModal({ title, value, showMoneyGroup, moneyGroup, okLabel, validate, onSave }) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:10001;display:flex;align-items:center;justify-content:center';
        overlay.setAttribute('role', 'presentation');

        const panel = document.createElement('div');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', title);
        panel.style.cssText = 'background:var(--bg-surface);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);padding:24px;max-width:460px;width:90%';
        panel.innerHTML = `
            <div style="font-size:var(--fs-lg);font-weight:var(--fw-semibold);color:var(--text-primary);margin-bottom:16px">${escHtml(title)}</div>
            <label style="display:block;font-size:var(--fs-xs);color:var(--text-secondary);margin-bottom:4px" for="coaModalName">Name</label>
            <input id="coaModalName" type="text" maxlength="${COA_NAME_MAX}" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface);color:var(--text-primary)">
            ${showMoneyGroup ? `
            <label style="display:block;font-size:var(--fs-xs);color:var(--text-secondary);margin:14px 0 4px" for="coaModalMg">Money Group <span style="color:var(--text-muted)">(personal spending only)</span></label>
            <select id="coaModalMg" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);background:var(--bg-surface);color:var(--text-primary)">
                <option value="">—</option>
                ${COA_MONEY_GROUPS.map(g => `<option value="${escHtml(g)}">${escHtml(g)}</option>`).join('')}
            </select>` : ''}
            <div id="coaModalErr" role="alert" style="display:none;margin-top:10px;font-size:var(--fs-xs);color:var(--danger)"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:20px"></div>`;

        const btnRow = panel.querySelector('div:last-child');
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'padding:8px 16px;border:1px solid var(--border-default);background:var(--bg-surface);color:var(--text-primary);border-radius:var(--radius-md);cursor:pointer;font-size:var(--fs-sm)';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.textContent = okLabel;
        okBtn.style.cssText = 'padding:8px 16px;border:none;background:var(--accent);color:var(--accent-on);border-radius:var(--radius-md);cursor:pointer;font-size:var(--fs-sm);font-weight:var(--fw-semibold)';
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);

        const input = panel.querySelector('#coaModalName');
        const mgSel = panel.querySelector('#coaModalMg');
        const errEl = panel.querySelector('#coaModalErr');
        input.value = value || '';
        if (mgSel && moneyGroup) mgSel.value = moneyGroup;

        function close() {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
        }
        function submit() {
            const err = validate(input.value);
            if (err) {
                errEl.textContent = err;
                errEl.style.display = 'block';
                input.focus();
                return;
            }
            close();
            onSave(input.value.trim(), mgSel ? mgSel.value : '');
        }
        function onKey(ev) {
            if (ev.key === 'Escape') { ev.preventDefault(); close(); }
            else if (ev.key === 'Enter' && ev.target === input) { ev.preventDefault(); submit(); }
        }

        cancelBtn.onclick = close;
        okBtn.onclick = submit;
        overlay.onclick = ev => { if (ev.target === overlay) close(); };
        document.addEventListener('keydown', onKey);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        input.focus();
        input.select();
    }

    // Read-only dialog explaining why an action is refused, listing what depends
    // on the record. Uses showConfirm's shape so it reads as the same product.
    function coaOpenBlockedModal(title, intro, reasons, footer) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.35);z-index:10001;display:flex;align-items:center;justify-content:center';
        overlay.setAttribute('role', 'presentation');

        const panel = document.createElement('div');
        panel.setAttribute('role', 'alertdialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', title);
        panel.style.cssText = 'background:var(--bg-surface);border-radius:var(--radius-lg);box-shadow:var(--shadow-lg);padding:24px;max-width:520px;width:90%;max-height:80vh;overflow-y:auto';
        panel.innerHTML = `
            <div style="font-size:var(--fs-lg);font-weight:var(--fw-semibold);color:var(--text-primary);margin-bottom:12px">${escHtml(title)}</div>
            <div style="font-size:var(--fs-sm);color:var(--text-secondary);white-space:pre-wrap;margin-bottom:12px">${escHtml(intro)}</div>
            <ul style="margin:0 0 16px;padding-left:20px;font-size:var(--fs-sm);color:var(--text-primary)">
                ${reasons.map(r => `<li style="margin-bottom:6px">${escHtml(r)}</li>`).join('')}
            </ul>
            <div style="font-size:var(--fs-xs);color:var(--text-muted);margin-bottom:20px">${escHtml(footer)}</div>
            <div style="display:flex;justify-content:flex-end"></div>`;

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.textContent = 'Close';
        okBtn.style.cssText = 'padding:8px 16px;border:none;background:var(--accent);color:var(--accent-on);border-radius:var(--radius-md);cursor:pointer;font-size:var(--fs-sm);font-weight:var(--fw-semibold)';
        panel.querySelector('div:last-child').appendChild(okBtn);

        function close() {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
        }
        function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); close(); } }
        okBtn.onclick = close;
        overlay.onclick = ev => { if (ev.target === overlay) close(); };
        document.addEventListener('keydown', onKey);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        okBtn.focus();
    }

    // Sliding toast with an Undo button. showToast is text-only, so this is its own.
    let _coaUndoTimer = null;
    function coaUndoToast(label, undoFn) {
        const existing = document.getElementById('coaUndoToast');
        if (existing) existing.remove();
        clearTimeout(_coaUndoTimer);

        const el = document.createElement('div');
        el.id = 'coaUndoToast';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:10px 14px;border-radius:var(--radius-md);font-size:var(--fs-sm);box-shadow:var(--shadow-lg);z-index:10000;background:var(--success-bg);color:var(--success);border:1px solid var(--success);display:flex;align-items:center;gap:12px;max-width:90vw';

        const text = document.createElement('span');
        text.textContent = label;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Undo';
        btn.style.cssText = 'padding:4px 10px;border:1px solid var(--success);background:transparent;color:var(--success);border-radius:var(--radius-sm);cursor:pointer;font-size:var(--fs-xs);font-weight:var(--fw-semibold)';
        btn.onclick = () => { el.remove(); clearTimeout(_coaUndoTimer); undoFn(); };

        el.appendChild(text);
        el.appendChild(btn);
        document.body.appendChild(el);
        _coaUndoTimer = setTimeout(() => el.remove(), 8000);
    }

    // ── Health bar ──────────────────────────────────────────────────────────────
    function coaRegisterSyncBar() {
        if (_coaState.registered) return;
        _coaState.registered = true;
        registerSyncBar('coa', {
            refreshFn: () => coaRefresh(),
            checks: [
                {
                    name: 'Both lists loaded from Airtable',
                    kind: 'sync',
                    run: () => {
                        const c = COA_KINDS.category.records().length;
                        const s = COA_KINDS.subCategory.records().length;
                        if (c === 0 || s === 0) return { status: 'fail', detail: `Categories ${c}, sub-categories ${s} — an empty list means the fetch failed, not that the table is empty.` };
                        return { status: 'pass', detail: `${c} categories, ${s} sub-categories.` };
                    },
                },
                {
                    name: 'No duplicate names',
                    kind: 'sync',
                    run: () => {
                        const dupes = [];
                        Object.keys(COA_KINDS).forEach(kind => {
                            const seen = new Map();
                            COA_KINDS[kind].records().forEach(r => {
                                const key = coaName(r, kind).toLowerCase();
                                if (!key) return;
                                seen.set(key, (seen.get(key) || 0) + 1);
                            });
                            seen.forEach((n, key) => { if (n > 1) dupes.push(`${COA_KINDS[kind].label}: "${key}" ×${n}`); });
                        });
                        if (dupes.length) return { status: 'fail', detail: `Two records share a name, so every name-matched report picks whichever loads first: ${dupes.join('; ')}` };
                        return { status: 'pass', detail: 'Every name is unique in both lists.' };
                    },
                },
                {
                    name: 'Report-critical names still present',
                    kind: 'sync',
                    run: () => {
                        const missing = [];
                        Object.keys(COA_KINDS).forEach(kind => {
                            const live = new Set(COA_KINDS[kind].records().map(r => coaName(r, kind).toLowerCase()));
                            coaProtectedNames(kind).forEach((reasons, key) => {
                                if (!live.has(key)) missing.push(`${COA_KINDS[kind].label} "${key}" (${reasons[0]})`);
                            });
                        });
                        if (missing.length) return { status: 'fail', detail: `The code looks for these by name and finds nothing, so those rows report zero: ${missing.join('; ')}` };
                        return { status: 'pass', detail: 'Every name the P&L, Wealth and reconciliation code matches on exists in Airtable.' };
                    },
                },
                {
                    name: 'ID-pinned sub-categories still present',
                    kind: 'sync',
                    run: () => {
                        const ids = new Set(COA_KINDS.subCategory.records().map(r => r.id));
                        const missing = [];
                        coaPinnedIds('subCategory').forEach((reasons, id) => {
                            if (!ids.has(id)) missing.push(`${id} (${reasons[0]})`);
                        });
                        if (missing.length) return { status: 'fail', detail: `Deleted or unreachable: ${missing.join('; ')}` };
                        return { status: 'pass', detail: `All ${coaPinnedIds('subCategory').size} record IDs hard-coded in the app resolve to a live sub-category.` };
                    },
                },
                {
                    name: 'Money Group values valid',
                    kind: 'sync',
                    run: () => {
                        const bad = COA_KINDS.subCategory.records()
                            .filter(r => { const v = coaMoneyGroup(r); return v && !COA_MONEY_GROUPS.includes(v); })
                            .map(r => `${coaName(r, 'subCategory')} = "${coaMoneyGroup(r)}"`);
                        if (bad.length) return { status: 'fail', detail: `Outside Needs/Wants, so the Wealth budget split ignores them: ${bad.join('; ')}` };
                        const set = COA_KINDS.subCategory.records().filter(r => coaMoneyGroup(r)).length;
                        return { status: 'pass', detail: `${set} sub-categories carry a Money Group, all Needs or Wants.` };
                    },
                },
                {
                    name: 'No unused lines cluttering the pickers',
                    kind: 'sync',
                    run: () => {
                        const unused = [];
                        Object.keys(COA_KINDS).forEach(kind => {
                            COA_KINDS[kind].records().forEach(r => {
                                if (coaLinkBreakdown(r, kind).total === 0) unused.push(`${COA_KINDS[kind].label}: ${coaName(r, kind)}`);
                            });
                        });
                        if (unused.length) return { status: 'warn', detail: `${unused.length} line${unused.length === 1 ? '' : 's'} with nothing coded to them — fine if new, worth deleting if abandoned: ${unused.join('; ')}` };
                        return { status: 'pass', detail: 'Every category and sub-category has at least one record coded to it.' };
                    },
                },
            ],
        });
    }

    async function coaRefresh() {
        markTabRefreshing('coa');
        try {
            await coaReloadLists();
            renderCoaTab();
        } catch (err) {
            showToast('Refresh failed: ' + err.message, { type: 'error' });
            markTabSynced('coa');
        }
    }
