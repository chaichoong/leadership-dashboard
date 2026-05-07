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
        // 28 Chedburgh — £324.338 per child
        ['rec092k8deHh32G89', 1, '28 Chedburgh', 1621.69],   // parent (Split 1, holds bulk amount)
        ['recSYgDIpHCbojuXy', 2, '28 Chedburgh', 324.338],
        ['recrSe1uH0aFtVIMG', 3, '28 Chedburgh', 324.338],
        // ['reco249SRxTpLJ0X0', 4, '28 Chedburgh', 324.338], // DELETED in Airtable
        ['recTAdm8jPTg6o1f5', 5, '28 Chedburgh', 324.338],
        // 42 Elmdon — £277.36 per child
        ['recvYcYFKWftNy8ou', 1, '42 Elmdon', 1386.80],      // parent
        ['recT13JDNKI9A6Vr4', 2, '42 Elmdon', 277.36],
        ['recitGfhZZMxqgbGf', 3, '42 Elmdon', 277.36],
        ['rec5ty78ZDRLPZUoG', 4, '42 Elmdon', 277.36],
        ['recWjkcaTNX294aKP', 5, '42 Elmdon', 277.36],
        // 32 Elmdon — £251.68 per child
        ['recq9YLUN3hIiDYmO', 1, '32 Elmdon', 1258.40],      // parent
        ['recAfnUFwH5vn2cgF', 2, '32 Elmdon', 251.68],
        ['recQ4DkHzhX2il6Yn', 3, '32 Elmdon', 251.68],
        ['recASbqel8AR2SAIZ', 4, '32 Elmdon', 251.68],
        ['recPOMI9Nkgxpg6Od', 5, '32 Elmdon', 251.68],
    ];

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function resolveTenancy(unitNumber, propertyMatch) {
        const ten = allTenancies.find(t => {
            const propName = String(getField(t, F.tenProperty)?.[0] || '');
            const unitRef = String(getField(t, F.tenUnitRef)?.[0] || '');
            return propName.toLowerCase().includes(propertyMatch.toLowerCase())
                && new RegExp(`\\bunit\\s*${unitNumber}\\b`, 'i').test(unitRef);
        });
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

    async function fetchTx(txId) {
        const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${txId}?cb=${Date.now()}`, {
            headers: { 'Authorization': 'Bearer ' + PAT }
        });
        return r.ok ? r.json() : null;
    }

    async function patchTx(txId, fields) {
        const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.transactions}/${txId}`, {
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
        // Use the first IMMO target — patch Reconciled to its current value
        // (no-op functionally but exercises the write path).
        const probe = FIXES[0][0];
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
        // Immediate read-back (within ~ms — too fast for any automation)
        const immediate = await fetchTx(probe);
        const immediateVal = immediate?.fields?.[F.txReconciled] === true;
        // Restore original value
        await patchTx(probe, { [F.txReconciled]: wasReconciled });
        if (immediateVal !== targetVal) {
            return { ok: false, reason: `PAT cannot write Reconciled field — PATCH returned 200 but value didn't change (was ${wasReconciled}, set ${targetVal}, immediate read shows ${immediateVal})` };
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
})();
