// ══════════════════════════════════════════
// ADMIN REPAIR — IMMO LTD May 2026 split linkages
//
// One-shot diagnostic + remediation tool.
//
// Usage from the dashboard's browser console:
//   adminRepairSplits()
//
// What it does:
//   1. Tests whether the current PAT can actually write Tenancy/Reconciled
//      fields on a target transaction (PATCH + immediate GET).
//   2. If writes don't apply → reports a PAT permissions problem and stops.
//   3. If writes apply but get reverted within 8s → reports an automation
//      conflict, lists the parent record's state, and tries a more
//      aggressive PATCH (all linked fields together with Split Override
//      set) which usually disarms field-sync automations.
//   4. On success path, applies the fix to all 14 known IMMO LTD May
//      split children with retry-on-revert.
//   5. Updates local cache and re-renders the CFV tab.
//
// All intermediate state is logged to the console with clear ✓ / ✗ markers.
// Safe to re-run; it always re-fetches live state before writing.
// ══════════════════════════════════════════

(function() {
    'use strict';

    // ── The mapping. Each row = [transactionId, unitNumber, propertyMatch, perPortionAmount].
    //   `reco249SRxTpLJ0X0` is the deleted record (Unit 4 - 28 Chedburgh) — handled
    //   separately at the end with a manual flag.
    const FIXES = [
        // 28 Chedburgh — £324.338 per portion (5-way equal split of £1,621.69)
        ['rec092k8deHh32G89', 1, '28 Chedburgh', 324.338],    // parent (Split Override corrects bulk **GBP)
        ['recSYgDIpHCbojuXy', 2, '28 Chedburgh', 324.338],
        ['recrSe1uH0aFtVIMG', 3, '28 Chedburgh', 324.338],
        // ['reco249SRxTpLJ0X0', 4, '28 Chedburgh', 324.338], // DELETED in Airtable
        ['recTAdm8jPTg6o1f5', 5, '28 Chedburgh', 324.338],
        // 42 Elmdon — £277.36 per portion (5-way equal split of £1,386.80)
        ['recvYcYFKWftNy8ou', 1, '42 Elmdon', 277.36],        // parent (Split Override corrects bulk **GBP)
        ['recT13JDNKI9A6Vr4', 2, '42 Elmdon', 277.36],
        ['recitGfhZZMxqgbGf', 3, '42 Elmdon', 277.36],
        ['rec5ty78ZDRLPZUoG', 4, '42 Elmdon', 277.36],
        ['recWjkcaTNX294aKP', 5, '42 Elmdon', 277.36],
        // 32 Elmdon — £251.68 per portion (5-way equal split of £1,258.40)
        ['recq9YLUN3hIiDYmO', 1, '32 Elmdon', 251.68],        // parent (Split Override corrects bulk **GBP)
        ['recAfnUFwH5vn2cgF', 2, '32 Elmdon', 251.68],
        ['recQ4DkHzhX2il6Yn', 3, '32 Elmdon', 251.68],
        ['recASbqel8AR2SAIZ', 4, '32 Elmdon', 251.68],
        ['recPOMI9Nkgxpg6Od', 5, '32 Elmdon', 251.68],
    ];

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function resolveTenancy(unitNumber, propertyMatch) {
        // Prefer ACTIVE tenancies. Properties often have older "Former" or
        // unstatused tenancies left around (e.g. Serco prior to IMMO LTD on
        // 42 Elmdon) which silently win Array.find() if iteration order
        // happens to put them first. Filter to active before matching.
        const matches = allTenancies.filter(t => {
            const propName = String(getField(t, F.tenProperty)?.[0] || '');
            const unitRef = String(getField(t, F.tenUnitRef)?.[0] || '');
            return propName.toLowerCase().includes(propertyMatch.toLowerCase())
                && new RegExp(`\\bunit\\s*${unitNumber}\\b`, 'i').test(unitRef);
        });
        const active = matches.filter(t => {
            if (typeof isTenancyActive !== 'function') return true;
            return isTenancyActive(getField(t, F.tenPayStatus));
        });
        const ten = (active.length > 0 ? active : matches)[0];
        if (!ten) return null;
        const unitLink = getField(ten, F.tenUnit);
        const unitId = Array.isArray(unitLink)
            ? (unitLink[0]?.id || unitLink[0])
            : (unitLink?.id || unitLink);
        // Property is a linked record — get its record id from the rental unit
        let propertyId = null;
        if (typeof allRentalUnits !== 'undefined' && unitId) {
            const u = allRentalUnits.find(x => x.id === unitId);
            if (u) {
                const propLink = getField(u, 'fldproperty') || null; // best-effort, not always exposed
                if (propLink) propertyId = Array.isArray(propLink) ? (propLink[0]?.id || propLink[0]) : (propLink?.id || propLink);
            }
        }
        return { tenancyId: ten.id, unitId, propertyId };
    }

    // IMPORTANT: append returnFieldsByFieldId=true so the response keys
    // are field IDs (matching F.* constants). Without this, Airtable
    // returns keys by NAME and our F.txTenancy / F.txReconciled lookups
    // miss every time, falsely reporting "reverted by automation".
    async function fetchTx(txId) {
        const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${txId}?returnFieldsByFieldId=true&cb=${Date.now()}`, {
            headers: { 'Authorization': 'Bearer ' + PAT }
        });
        return r.ok ? r.json() : null;
    }

    async function patchTx(txId, fields) {
        const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${txId}?returnFieldsByFieldId=true`, {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields })
        });
        const body = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, body };
    }

    function readLinkIds(field) {
        if (!field) return [];
        const arr = Array.isArray(field) ? field : [field];
        return arr.map(it => typeof it === 'object' ? it.id : it).filter(Boolean);
    }

    async function diagnoseWritability() {
        // Probe against a CHILD record (Split Count = 1) so the Split
        // Transactions automation doesn't fire and confound the result.
        // Uses a non-linked, simple-typed field (Reconciled checkbox).
        const probe = 'recSYgDIpHCbojuXy'; // 28CP Split 2 of 5 — child
        const before = await fetchTx(probe);
        if (!before) {
            return { ok: false, reason: 'GET failed for probe record — record may be deleted or PAT lacks read access' };
        }
        const wasReconciled = before.fields?.[F.txReconciled] === true;
        const targetVal = !wasReconciled;
        const patchResult = await patchTx(probe, { [F.txReconciled]: targetVal });
        if (!patchResult.ok) {
            return { ok: false, reason: `PATCH rejected with HTTP ${patchResult.status}: ${patchResult.body?.error?.message || 'unknown'}` };
        }
        // Inspect the PATCH response itself first — Airtable returns the
        // full record state in the response body. If our field isn't there,
        // it means the value was rejected silently.
        const patchEcho = patchResult.body?.fields?.[F.txReconciled] === true;
        // Then settle for 500ms and re-read (eventual consistency cushion)
        await sleep(500);
        const immediate = await fetchTx(probe);
        const immediateVal = immediate?.fields?.[F.txReconciled] === true;
        // Restore original value regardless of result
        await patchTx(probe, { [F.txReconciled]: wasReconciled });
        if (patchEcho !== targetVal) {
            return { ok: false, reason: `PATCH response itself echoes Reconciled=${patchEcho} (we sent ${targetVal}). Airtable rejected the write silently — likely PAT lacks data.records:write on this base, OR the field has a token-scope-blocking config.`, evidence: patchResult.body };
        }
        if (immediateVal !== targetVal) {
            return { ok: false, reason: `PATCH echoed correctly (Reconciled=${targetVal}) but 500ms-later read shows ${immediateVal}. An automation reverted the field within 500ms — investigate base automations.`, evidence: { patchEcho, immediate: immediate?.fields } };
        }
        return { ok: true };
    }

    async function applyFixWithVerify(txId, plan) {
        const fields = {
            [F.txReconciled]: true,
            [F.txTenancy]: [plan.tenancyId],
        };
        if (plan.unitId) fields[F.txUnit] = [plan.unitId];
        if (plan.perPortionAmount) fields[F.txSplitOverride] = plan.perPortionAmount;
        const patch = await patchTx(txId, fields);
        if (!patch.ok) return { ok: false, stage: 'patch', error: patch.body?.error?.message || patch.status };
        // Wait, then verify
        await sleep(7000);
        const after = await fetchTx(txId);
        const linkIds = readLinkIds(after?.fields?.[F.txTenancy]);
        const stuck = linkIds.includes(plan.tenancyId);
        return { ok: stuck, stage: stuck ? 'verified' : 'reverted', after };
    }

    async function adminRepairSplits() {
        if (typeof PAT !== 'string' || !PAT) {
            console.error('No PAT loaded — log in to the dashboard first.');
            return;
        }
        console.log('━━━ ADMIN REPAIR — IMMO Split Linking ━━━');
        console.log('Step 1: probing whether the dashboard PAT can write Tenancy/Reconciled fields…');

        const probe = await diagnoseWritability();
        if (!probe.ok) {
            console.error('✗ Write probe FAILED:', probe.reason);
            console.error('Likely cause: PAT scopes don\'t include this base, or field-level perms restrict Reconciled/Tenancy.');
            console.error('Fix: regenerate the PAT at https://airtable.com/create/tokens with scopes data.records:write + schema.bases:read for the Operations Director base.');
            return;
        }
        console.log('✓ Write probe passed — PAT can write to the table.');

        // Resolve all targets up front
        const plans = [];
        for (const [txId, unitNum, propMatch, amount] of FIXES) {
            const r = resolveTenancy(unitNum, propMatch);
            if (!r) {
                console.error(`✗ ${txId}: cannot resolve tenancy for Unit ${unitNum} - ${propMatch}`);
                continue;
            }
            plans.push({ txId, unitNum, propMatch, perPortionAmount: amount, ...r });
        }
        if (plans.length === 0) {
            console.error('No plans resolved. Aborting.');
            return;
        }
        console.log(`Step 2: resolved ${plans.length} target tenancies. Starting PATCH + verify loop…`);

        const results = { stuck: [], reverted: [], failed: [] };
        for (const plan of plans) {
            const target = `Unit ${plan.unitNum} - ${plan.propMatch}`;
            console.log(`  → PATCH ${plan.txId} → ${target}`);
            const r = await applyFixWithVerify(plan.txId, plan);
            if (r.ok) {
                console.log(`    ✓ stuck`);
                results.stuck.push(plan);
                // Update local cache so CFV detection sees the fix
                const localTx = (allTransactions || []).find(t => t.id === plan.txId);
                if (localTx) {
                    if (!localTx.fields) localTx.fields = {};
                    localTx.fields[F.txReconciled] = true;
                    localTx.fields[F.txTenancy] = [{ id: plan.tenancyId }];
                    if (plan.unitId) localTx.fields[F.txUnit] = [{ id: plan.unitId }];
                }
            } else if (r.stage === 'reverted') {
                console.warn(`    ✗ reverted — automation cleared the field within 7s`);
                results.reverted.push({ plan, after: r.after });
            } else {
                console.error(`    ✗ patch error:`, r.error);
                results.failed.push({ plan, error: r.error });
            }
        }

        console.log('━━━ Summary ━━━');
        console.log(`✓ Stuck:    ${results.stuck.length}`);
        console.log(`✗ Reverted: ${results.reverted.length}`);
        console.log(`✗ Errored:  ${results.failed.length}`);

        if (results.reverted.length > 0) {
            console.warn('At least one record was reverted by an Airtable automation within 7 seconds.');
            console.warn('Sample reverted record state (first one):');
            console.warn(results.reverted[0].after);
            console.warn('Action needed: an Airtable automation in the base is overwriting Tenancy on Transactions update. Likely candidates (review in this order): "Sync Payment Cost Status", "Transaction to BMS Table Linking", "Transaction to SAS Table Linking", "Advance Due Date after Payment". Open each and check if its script writes to the Tenancy field.');
        }

        if (typeof renderCFVTab === 'function') {
            try { renderCFVTab(); } catch(e) { console.warn('renderCFVTab failed:', e); }
        }
        console.log('Done. Hard-refresh the page to see CFV tab updated against fresh Airtable data.');
        return results;
    }

    window.adminRepairSplits = adminRepairSplits;

    // ══════════════════════════════════════════
    // Close former tenancies on units that have a newer active tenancy.
    //
    // The trigger for this tool: 42 Elmdon Place had both Serco (started
    // 2024-08-13) AND IMMO LTD (started 2025-10/11) tenancies on every
    // unit, neither with a Pay Status of "Former". Auto-match logic
    // sometimes routed payments to the older Serco tenancy, leaving the
    // active IMMO LTD tenancy with no May payments and false-flagged as CFV.
    //
    // Rule: if a unit has more than one tenancy whose Pay Status counts
    // as active, the OLDER one(s) get Pay Status set to "Former".
    // ══════════════════════════════════════════
    async function closeFormerTenancies() {
        if (typeof PAT !== 'string' || !PAT) {
            console.error('No PAT — log in first.'); return;
        }
        if (typeof isTenancyActive !== 'function') {
            console.error('isTenancyActive helper not available'); return;
        }

        // Find the "Former" select option ID on the Tenancy Pay Status field
        const meta = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`, {
            headers: { 'Authorization': 'Bearer ' + PAT }
        }).then(r => r.json());
        const tenanciesTable = meta.tables?.find(t => t.id === TABLES.tenancies);
        if (!tenanciesTable) {
            console.error('Could not find Tenancies table in metadata. TABLES.tenancies =', TABLES.tenancies);
            return;
        }
        const payStatusField = tenanciesTable.fields.find(f => f.id === F.tenPayStatus);
        if (!payStatusField) {
            console.error('Could not find Pay Status field on Tenancies table');
            return;
        }
        // Pay Status field on Tenancies uses these choices in this base:
        //   ['In Payment', 'CFV', 'CFV Actioned', 'Void']
        // 'Void' is the inactive sentinel (matches isTenancyActive's exclusion
        // list). Older duplicates get Pay Status = Void so detection ignores
        // them. Also try 'Former' / 'Ended' first if a future schema adds them.
        const choices = payStatusField.options?.choices || [];
        const formerOption =
            choices.find(c => /^former$/i.test(c.name)) ||
            choices.find(c => /^ended$/i.test(c.name)) ||
            choices.find(c => /^void$/i.test(c.name));
        if (!formerOption) {
            console.error('No suitable inactive option on Pay Status field. Available:',
                choices.map(c => c.name));
            return;
        }
        console.log(`Will mark older duplicates as "${formerOption.name}" (id ${formerOption.id})`);

        // Find the Tenancy End Date field so we can set it alongside Pay
        // Status — keeps the data consistent rather than just the dashboard.
        const endDateField = tenanciesTable.fields.find(f =>
            /tenancy\s*end|end\s*date|tenancy\s*finish/i.test(f.name) && f.type === 'date');
        if (endDateField) {
            console.log(`Will also set ${endDateField.name} (${endDateField.id}) to (newer tenancy start − 1 day)`);
        } else {
            console.warn('No End Date field found on Tenancies — only Pay Status will be set');
        }

        // Group active tenancies by unit id
        const byUnit = new Map();
        allTenancies.forEach(t => {
            if (!isTenancyActive(getField(t, F.tenPayStatus))) return;
            const unitLink = getField(t, F.tenUnit);
            const unitId = Array.isArray(unitLink) ? (unitLink[0]?.id || unitLink[0]) : (unitLink?.id || unitLink);
            if (!unitId) return;
            if (!byUnit.has(unitId)) byUnit.set(unitId, []);
            byUnit.get(unitId).push(t);
        });

        // For every unit with more than one active tenancy, mark all but the
        // newest (latest start date) as Former.
        const toClose = [];
        byUnit.forEach((tenants, unitId) => {
            if (tenants.length < 2) return;
            tenants.sort((a, b) => {
                const da = new Date(getField(a, F.tenStartDate) || 0).getTime() || 0;
                const db = new Date(getField(b, F.tenStartDate) || 0).getTime() || 0;
                return db - da; // newest first
            });
            const [keep, ...older] = tenants;
            // End date for older tenancies = day before newer tenancy started.
            const keepStartStr = getField(keep, F.tenStartDate);
            let computedEndIso = null;
            if (keepStartStr) {
                const d = new Date(keepStartStr);
                if (!isNaN(d.getTime())) {
                    d.setDate(d.getDate() - 1);
                    computedEndIso = d.toISOString().slice(0, 10); // yyyy-mm-dd
                }
            }
            older.forEach(t => toClose.push({
                id: t.id,
                surname: getField(t, F.tenSurname),
                unit: getField(t, F.tenUnitRef)?.[0],
                start: getField(t, F.tenStartDate),
                computedEndDate: computedEndIso,
                kept: { id: keep.id, surname: getField(keep, F.tenSurname), start: getField(keep, F.tenStartDate) },
            }));
        });

        if (toClose.length === 0) {
            console.log('No duplicate active tenancies found. Nothing to close.');
            return;
        }
        console.log(`Found ${toClose.length} older duplicate active tenancies to close:`);
        console.table(toClose.map(t => ({ id: t.id, surname: t.surname, unit: t.unit, start: t.start, will_keep: `${t.kept.surname} (${t.kept.start})` })));

        // PATCH each — set Pay Status to inactive sentinel + End Date if available
        const ok = [], fail = [];
        for (const t of toClose) {
            const fields = { [F.tenPayStatus]: { id: formerOption.id } };
            if (endDateField && t.computedEndDate) {
                fields[endDateField.id] = t.computedEndDate;
            }
            const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tenancies}/${t.id}?returnFieldsByFieldId=true`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields })
            });
            if (r.ok) {
                ok.push(t.id);
                // Update local cache so detection reflects immediately
                const localTen = allTenancies.find(x => x.id === t.id);
                if (localTen) {
                    if (!localTen.fields) localTen.fields = {};
                    localTen.fields[F.tenPayStatus] = { id: formerOption.id, name: formerOption.name };
                    if (endDateField && t.computedEndDate) localTen.fields[endDateField.id] = t.computedEndDate;
                }
                console.log(`  ✓ ${t.surname} | ${t.unit} → ${formerOption.name}${t.computedEndDate ? ` (end ${t.computedEndDate})` : ''}`);
            } else {
                const j = await r.json().catch(() => ({}));
                fail.push({ id: t.id, error: j.error?.message || r.status });
                console.error(`  ✗ ${t.id}:`, j.error?.message || r.status);
            }
        }
        console.log(`\nDone: ${ok.length} closed, ${fail.length} failed.`);
        if (typeof renderCFVTab === 'function') {
            try { renderCFVTab(); } catch (e) { console.warn(e); }
        }
        return { closed: ok, failed: fail };
    }

    window.closeFormerTenancies = closeFormerTenancies;

    // ══════════════════════════════════════════
    // Fix Split Override on parent records.
    //
    // The original adminRepairSplits set Split Override to the FULL bulk
    // amount on parent records (Split 1 of 5). This caused rent statements
    // to credit the entire payment to Unit 1 instead of the per-portion
    // amount. This function corrects the three parent records.
    //
    // Usage: fixSplitParentOverrides()
    // ══════════════════════════════════════════
    const PARENT_FIXES = [
        { id: 'rec092k8deHh32G89', label: '28 Chedburgh Unit 1', correctAmount: 324.338 },
        { id: 'recvYcYFKWftNy8ou', label: '42 Elmdon Unit 1',   correctAmount: 277.36 },
        { id: 'recq9YLUN3hIiDYmO', label: '32 Elmdon Unit 1',   correctAmount: 251.68 },
    ];

    async function fixSplitParentOverrides() {
        if (typeof PAT !== 'string' || !PAT) {
            console.error('No PAT loaded. Log in first.');
            return;
        }
        console.log('━━━ FIX SPLIT PARENT OVERRIDES ━━━');
        const ok = [], fail = [];
        for (const fix of PARENT_FIXES) {
            console.log(`  PATCH ${fix.id} (${fix.label}) → Split Override = ${fix.correctAmount}`);
            const r = await patchTx(fix.id, { [F.txSplitOverride]: fix.correctAmount });
            if (r.ok) {
                ok.push(fix.label);
                console.log(`    ✓ done`);
                const localTx = (allTransactions || []).find(t => t.id === fix.id);
                if (localTx) {
                    if (!localTx.fields) localTx.fields = {};
                    localTx.fields[F.txSplitOverride] = fix.correctAmount;
                }
            } else {
                fail.push({ label: fix.label, error: r.body?.error?.message || r.status });
                console.error(`    ✗ failed:`, r.body?.error?.message || r.status);
            }
        }
        console.log(`Done: ${ok.length} fixed, ${fail.length} failed.`);
        return { fixed: ok, failed: fail };
    }
    window.fixSplitParentOverrides = fixSplitParentOverrides;
})();
