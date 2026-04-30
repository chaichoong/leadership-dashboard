// ══════════════════════════════════════════
// ARREARS ENGINE — 7-stage credit control pipeline (extends CFV detection)
// ══════════════════════════════════════════
//
// Scope of this file:
//   • Loads Arrears Records from Airtable (TABLES.arrears)
//   • Computes the expected stage for every active tenancy each sweep
//   • Creates arrears records when a stage should fire and none exists
//   • Progresses existing records forward when their next stage is due
//   • Auto-pauses (UC tenants) or auto-resolves (Working tenants) when a
//     reconciled payment lands for the rent cycle
//
// Out of scope (later slices):
//   • Mica task auto-creation for phone calls
//   • Email / SMS / letter sending
//   • Template engine
//   • UI rebuild of CFV tab as kanban
//   • Section 8 trigger (depends on statement work-in-progress)
//
// Tenant-type rules:
//   • Working          → preventive at Day -1, full chase pipeline
//   • Universal Credit → preventive at Day -7 (Mica calls UC), full chase if needed
//   • Agent-Managed    → SKIPPED entirely (agent collects)

    // ── Stage definitions ──
    // day = days from Original Due Date (negative = before due)
    // Stages with a `min` lower than -1 only apply to UC.
    const ARREARS_STAGES = [
        { name: 'Preventive',          minWorking: -1, minUC: -7 },
        { name: 'Soft Chase',          minWorking:  1, minUC:  1 },
        { name: 'Firm Contact',        minWorking:  7, minUC:  7 },
        { name: 'Formal Warning',      minWorking: 14, minUC: 14 },
        { name: 'Pre-Action',          minWorking: 21, minUC: 21 },
        // Section 8 + Court are stage names in the schema but not auto-progressed
        // by this engine — they require the statement (in progress) and a manual
        // Section-8 task. The engine stops at Pre-Action.
    ];

    // Open / progressing statuses (records the engine acts on)
    const ARREARS_OPEN_STATUSES = new Set(['Active', 'Escalated']);

    // Globals
    let allArrearsRecords = [];
    let arrearsLoadedAt = 0;

    // ── Tenant-type accessor ──
    // Reads `Rent Payment Type` from the linked Tenant record. Returns one of
    // 'Working' / 'Universal Credit' / 'Agent-Managed', or null if undetermined.
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

    // ── Determine which stage SHOULD be active ──
    // Returns the latest stage whose threshold has been crossed, or null if no
    // stage should fire yet.
    function getExpectedStage(tenantType, daysFromDue) {
        if (tenantType === 'Agent-Managed' || !tenantType) return null;
        const useUC = tenantType === 'Universal Credit';
        let active = null;
        for (const s of ARREARS_STAGES) {
            const threshold = useUC ? s.minUC : s.minWorking;
            if (daysFromDue >= threshold) active = s.name;
        }
        return active;
    }

    function arrearsStageIndex(name) {
        const i = ARREARS_STAGES.findIndex(s => s.name === name);
        return i === -1 ? -1 : i;
    }

    // ── Load arrears records from Airtable ──
    async function loadArrearsRecords(force = false) {
        // Cache for 60 seconds to avoid re-fetching during the same sweep
        if (!force && allArrearsRecords.length && (Date.now() - arrearsLoadedAt) < 60000) {
            return allArrearsRecords;
        }
        try {
            const data = await airtableFetch(TABLES.arrears, { pageSize: 100 });
            allArrearsRecords = (data && data.records) ? data.records : [];
            arrearsLoadedAt = Date.now();
            return allArrearsRecords;
        } catch (err) {
            console.warn('arrears: loadArrearsRecords failed', err);
            allArrearsRecords = [];
            return [];
        }
    }

    // ── Find an existing arrears record for a tenancy + due-date pair ──
    function findArrearsRecord(tenancyId, dueDate) {
        const dueIso = dueDate.toISOString().slice(0, 10);
        return allArrearsRecords.find(r => {
            const linkedTenancy = getField(r, ARREARS.tenancy);
            const linkedId = extractLinkedId(linkedTenancy);
            if (linkedId !== tenancyId) return false;
            const dueRaw = getField(r, ARREARS.originalDueDate);
            if (!dueRaw) return false;
            return String(dueRaw).slice(0, 10) === dueIso;
        });
    }

    // ── Find all open arrears records for a tenancy (any due date) ──
    function findOpenArrearsForTenancy(tenancyId) {
        return allArrearsRecords.filter(r => {
            const linkedId = extractLinkedId(getField(r, ARREARS.tenancy));
            if (linkedId !== tenancyId) return false;
            const status = getStatusName(getField(r, ARREARS.status));
            return ARREARS_OPEN_STATUSES.has(status);
        });
    }

    function getStatusName(field) {
        if (!field) return '';
        if (typeof field === 'string') return field;
        return field.name || '';
    }
    function getStageName(field) {
        return getStatusName(field); // same shape (singleSelect)
    }

    // ── Compute the next-action due date for a given stage ──
    function nextActionDueFor(stageName, originalDueDate) {
        const idx = arrearsStageIndex(stageName);
        if (idx === -1 || idx === ARREARS_STAGES.length - 1) return null;
        const next = ARREARS_STAGES[idx + 1];
        // We use the working-tenant threshold for next-action display because it's
        // the more common case; UC records will progress on the same day anyway
        // (Soft Chase onwards is identical for both tenant types).
        const nextDue = new Date(originalDueDate);
        nextDue.setDate(nextDue.getDate() + Math.max(0, next.minWorking));
        return nextDue;
    }

    function nextActionTypeFor(stageName) {
        const idx = arrearsStageIndex(stageName);
        if (idx === -1 || idx === ARREARS_STAGES.length - 1) return '';
        return ARREARS_STAGES[idx + 1].name;
    }

    // ── Build a Reference like AR-2026-04-XXXX ──
    // We use openedDate year-month plus a short tenancy ref slice so it's
    // human-readable in lists. No collision risk per (tenancy, due-date).
    function buildArrearsReference(tenancy, dueDate) {
        const yyyy = dueDate.getFullYear();
        const mm = String(dueDate.getMonth() + 1).padStart(2, '0');
        const tenRef = String(getField(tenancy, F.tenRef) || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()
                    || tenancy.id.slice(-4).toUpperCase();
        return `AR-${yyyy}-${mm}-${tenRef}`;
    }

    // ── Airtable POST: create one arrears record ──
    async function createArrearsRecord(payload) {
        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.arrears}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: payload, typecast: false }),
        });
        if (!resp.ok) {
            const err = await resp.text();
            console.error('arrears: createArrearsRecord failed', resp.status, err);
            return null;
        }
        return await resp.json();
    }

    // ── Airtable PATCH: update one arrears record ──
    async function updateArrearsRecord(recordId, fieldUpdates) {
        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.arrears}/${recordId}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: fieldUpdates }),
        });
        if (!resp.ok) {
            const err = await resp.text();
            console.error('arrears: updateArrearsRecord failed', resp.status, err);
            return false;
        }
        return true;
    }

    // ── Open a new arrears record at a given stage ──
    async function openArrearsRecord(tenancy, tenantType, originalDueDate, stage, today) {
        const rent = Number(getField(tenancy, F.tenRent)) || 0;
        const reference = buildArrearsReference(tenancy, originalDueDate);
        const nextDue = nextActionDueFor(stage, originalDueDate);
        const payload = {
            [ARREARS.ref]: reference,
            [ARREARS.stage]: stage,
            [ARREARS.status]: 'Active',
            [ARREARS.openedDate]: today.toISOString().slice(0, 10),
            [ARREARS.originalDueDate]: originalDueDate.toISOString().slice(0, 10),
            [ARREARS.amountOwed]: rent,
            [ARREARS.tenancy]: [tenancy.id],
        };
        if (nextDue) {
            payload[ARREARS.nextActionDue] = nextDue.toISOString().slice(0, 10);
            payload[ARREARS.nextActionType] = nextActionTypeFor(stage);
        }
        const created = await createArrearsRecord(payload);
        if (created) {
            console.log(`arrears: opened ${reference} at "${stage}" for ${tenancy.id} (${tenantType})`);
            allArrearsRecords.push(created);
        }
        return created;
    }

    // ── Progress an existing record to a later stage ──
    async function progressArrearsRecord(record, newStage, today) {
        const dueRaw = getField(record, ARREARS.originalDueDate);
        const originalDue = dueRaw ? new Date(dueRaw) : null;
        const nextDue = originalDue ? nextActionDueFor(newStage, originalDue) : null;
        const updates = {
            [ARREARS.stage]: newStage,
        };
        if (nextDue) {
            updates[ARREARS.nextActionDue] = nextDue.toISOString().slice(0, 10);
            updates[ARREARS.nextActionType] = nextActionTypeFor(newStage);
        }
        const ok = await updateArrearsRecord(record.id, updates);
        if (ok) {
            const ref = getField(record, ARREARS.ref);
            console.log(`arrears: progressed ${ref} to "${newStage}"`);
            // Reflect locally so subsequent sweeps don't re-progress
            record.fields[ARREARS.stage] = { name: newStage };
        }
        return ok;
    }

    // ── Apply payment-received pause/resolve rules ──
    // UC: pause ALL open records for this tenancy (UC Latest Payment Received).
    // Working: resolve OLDEST open record only (FIFO — payment clears oldest debt).
    async function applyPaymentResolution(tenancyId, tenantType, today) {
        const open = findOpenArrearsForTenancy(tenancyId);
        if (!open.length) return;

        if (tenantType === 'Universal Credit') {
            for (const rec of open) {
                const ok = await updateArrearsRecord(rec.id, {
                    [ARREARS.status]: 'Paused (UC Rule)',
                    [ARREARS.pauseReason]: 'UC Latest Payment Received',
                    [ARREARS.tenancyEndAction]: 'Include in Final Statement',
                });
                if (ok) {
                    rec.fields[ARREARS.status] = { name: 'Paused (UC Rule)' };
                    console.log(`arrears: UC paused ${getField(rec, ARREARS.ref)} (latest payment received)`);
                }
            }
            return;
        }

        if (tenantType === 'Working') {
            // Resolve oldest open record only — FIFO allocation
            open.sort((a, b) => {
                const da = String(getField(a, ARREARS.originalDueDate) || '');
                const db = String(getField(b, ARREARS.originalDueDate) || '');
                return da.localeCompare(db);
            });
            const oldest = open[0];
            const ok = await updateArrearsRecord(oldest.id, {
                [ARREARS.status]: 'Resolved',
                [ARREARS.stage]: 'Resolved',
                [ARREARS.resolutionDate]: today.toISOString().slice(0, 10),
                [ARREARS.resolutionType]: 'Paid in Full',
            });
            if (ok) {
                oldest.fields[ARREARS.status] = { name: 'Resolved' };
                console.log(`arrears: Working resolved ${getField(oldest, ARREARS.ref)} (oldest open record cleared)`);
            }
        }
    }

    // ── Main engine ──
    // Called from cfv.js after detection runs. Idempotent — safe to run repeatedly.
    async function runArrearsEngine(today, tenantLookup) {
        if (!allTenancies || !allTenancies.length) return;
        await loadArrearsRecords();

        for (const tenancy of allTenancies) {
            if (!isTenantStatusActive(tenancy)) continue;

            const tenantType = getTenantTypeForTenancy(tenancy, tenantLookup);
            if (!tenantType || tenantType === 'Agent-Managed') continue;

            const rent = Number(getField(tenancy, F.tenRent)) || 0;
            if (rent <= 0) continue;

            // Compute this cycle's due date.
            // If today is after this month's due day, we track this month.
            // If before, we look at PREVIOUS month's due (an outstanding cycle).
            // For Preventive (Day -7 / Day -1) we look forward to NEXT due.
            const dueDay = getNumVal(tenancy, F.tenDueDay, 1);
            const dueThisMonth = new Date(today.getFullYear(), today.getMonth(), dueDay);
            const dueNextMonth = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
            const dueLastMonth = new Date(today.getFullYear(), today.getMonth() - 1, dueDay);

            // Candidate cycles to evaluate this sweep:
            //  - last month's due (if still unpaid → ongoing chase)
            //  - this month's due (if past or current)
            //  - next month's due (only for Preventive window)
            const candidates = [];
            if (today >= dueLastMonth) candidates.push(dueLastMonth);
            if (today >= new Date(dueThisMonth.getTime() - 8 * 86400000)) candidates.push(dueThisMonth);
            // Next-month preventive: only if we're inside its preventive window
            const daysToNext = Math.floor((dueNextMonth - today) / 86400000);
            const ucWindow = tenantType === 'Universal Credit' && daysToNext <= 7 && daysToNext > 0;
            const workWindow = tenantType === 'Working' && daysToNext <= 1 && daysToNext > 0;
            if (ucWindow || workWindow) candidates.push(dueNextMonth);

            // Has a reconciled payment landed in the calendar month of any candidate?
            const paidThisMonth = hasLinkedPaymentThisMonth(tenancy.id, today);

            // If payment received, run the resolution rule on existing open records
            if (paidThisMonth) {
                await applyPaymentResolution(tenancy.id, tenantType, today);
                // Don't open new records this sweep when current month is paid
                continue;
            }

            // For each candidate cycle, ensure the right stage is recorded
            for (const dueDate of candidates) {
                const daysFromDue = Math.floor((today - dueDate) / 86400000);
                const expectedStage = getExpectedStage(tenantType, daysFromDue);
                if (!expectedStage) continue;

                const existing = findArrearsRecord(tenancy.id, dueDate);
                if (!existing) {
                    await openArrearsRecord(tenancy, tenantType, dueDate, expectedStage, today);
                    continue;
                }

                // Skip if this record is already paused / resolved / closed
                const status = getStatusName(getField(existing, ARREARS.status));
                if (!ARREARS_OPEN_STATUSES.has(status)) continue;

                const currentStage = getStageName(getField(existing, ARREARS.stage));
                if (arrearsStageIndex(expectedStage) > arrearsStageIndex(currentStage)) {
                    await progressArrearsRecord(existing, expectedStage, today);
                }
            }
        }
    }

    // Expose to other modules
    window.runArrearsEngine = runArrearsEngine;
    window.loadArrearsRecords = loadArrearsRecords;
    window.getTenantTypeForTenancy = getTenantTypeForTenancy;
