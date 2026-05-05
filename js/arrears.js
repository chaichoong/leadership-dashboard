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
//   • Email / SMS / letter sending
//   • Template engine
//   • UI rebuild of CFV tab as kanban
//   • Section 8 trigger (depends on statement work-in-progress)

// Slice A (this file): Mica task auto-creation
// On a stage event (new arrears record OR progression to a later stage), if the
// stage requires manual phone work, queue a task in the Tasks table assigned to
// Mica. The task lands in her "Today" queue, links back to the tenancy/tenant/
// unit, and includes a script + tenant context. Phone-call stages: Preventive
// (UC tenants only — call UC office), Soft Chase, Firm Contact, Formal Warning,
// Pre-Action.
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

    // ── Cumulative arrears calculation cutoff ──
    // Reconciled transactions before this date aren't trustworthy enough to use
    // for cumulative arrears maths (Kevin started reconciling on 2025-04-01).
    // Tenancies that started before this date have their effective-arrears
    // computed from this date forward; tenancies that started after use their
    // tenancy start date.
    const ARREARS_DATA_START = '2025-04-01';

    // Count of expected monthly payments between two dates (inclusive of start month).
    function monthsBetween(startDate, endDate) {
        if (endDate < startDate) return 0;
        const ys = startDate.getFullYear();
        const ms = startDate.getMonth();
        const ye = endDate.getFullYear();
        const me = endDate.getMonth();
        return Math.max(0, (ye - ys) * 12 + (me - ms) + 1);
    }

    // List of rent cycle dates (each one = one expected payment) between
    // max(tenancy_start, ARREARS_DATA_START) and today. Anchored to the
    // tenancy's `tenDueDay` so cycles align with how Airtable already tracks
    // due dates. Returns Date[] in chronological order.
    function cyclesForTenancy(tenancy, today) {
        const tenStart = getTenancyStartDate(tenancy);
        if (!tenStart) return [];
        const dataStart = new Date(ARREARS_DATA_START);
        const effectiveStart = tenStart > dataStart ? tenStart : dataStart;
        const dueDay = getNumVal(tenancy, F.tenDueDay, 1);

        // First cycle is on/after effectiveStart at the due-day
        let cycle = new Date(effectiveStart.getFullYear(), effectiveStart.getMonth(), dueDay);
        if (cycle < effectiveStart) {
            cycle = new Date(cycle.getFullYear(), cycle.getMonth() + 1, dueDay);
        }
        const cycles = [];
        while (cycle <= today) {
            cycles.push(new Date(cycle));
            cycle = new Date(cycle.getFullYear(), cycle.getMonth() + 1, dueDay);
        }
        return cycles;
    }

    // True if a transaction has this tenancy in its linked-tenancies field.
    // Handles split transactions: a single bank tx may link to multiple
    // tenancies (e.g. one transfer covering two units). `extractLinkedId`
    // only returns the FIRST linked id, so it silently misses split-tx
    // payments — we walk the full array here.
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

    // Reconciled rent payments linked to this tenancy since data-start.
    // Returns full payment objects so the breakdown view can display them.
    function paymentsForTenancy(tenancyId) {
        const dataStart = new Date(ARREARS_DATA_START);
        const payments = [];
        for (const tx of allTransactions) {
            if (!getField(tx, F.txReconciled)) continue;
            if (!txLinkedToTenancy(tx, tenancyId)) continue;
            const txDateStr = getField(tx, F.txDate);
            if (!txDateStr) continue;
            const txDate = new Date(txDateStr);
            if (txDate < dataStart) continue;
            const amount = Number(getField(tx, F.txReportAmount) || getField(tx, F.txAmount)) || 0;
            payments.push({ date: txDate, dateStr: String(txDateStr).slice(0, 10), amount });
        }
        payments.sort((a, b) => a.date - b.date);
        return payments;
    }

    // Convenience: count of payments
    function actualPaymentsForTenancy(tenancyId) {
        return paymentsForTenancy(tenancyId).length;
    }

    // ── New-tenant guard ──
    // The chase pipeline only kicks in once the tenancy has had its first
    // reconciled rent payment. New tenants whose UC claim hasn't been set up
    // yet (or whose first working/agent payment hasn't landed) shouldn't be
    // chased — they're CFVs by default until they establish a baseline.
    // This also avoids the false S8-readiness for brand-new UC tenants where
    // expected payments looks like 3 months but they've literally been in the
    // property a few weeks waiting for UC to process.
    function hasFirstPaymentLanded(tenancyId) {
        return actualPaymentsForTenancy(tenancyId) >= 1;
    }

    // Tenancy start sanity. Returns null if tenStartDate is missing — the
    // arrears engine and view both skip such tenancies (you can't compute
    // arrears against an unknown move-in date).
    function getTenancyStartDate(tenancy) {
        const raw = String(getField(tenancy, F.tenStartDate) || '');
        if (!raw) return null;
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
    }

    // Full arrears breakdown for a tenancy — the single source of truth that
    // drives both the effective-months number and the audit view. Returns a
    // structured object so the UI can show every component of the maths.
    //
    // Model:
    //   cycles_passed = count of due-day dates between effectiveStart and today
    //   expected      = cycles_passed for Working/Agent
    //                 = cycles_passed - 1 for UC (UC pays one cycle in arrears,
    //                   so first month is structurally "free")
    //   actual        = reconciled rent payments linked to this tenancy
    //   missed        = max(0, expected - actual)
    //   effective     = missed for Working/Agent
    //                 = missed + 1 for UC (the structural shadow)
    //   s8_ready      = effective >= 2
    function computeArrearsBreakdown(tenancy, tenantType, today) {
        const tenStart = getTenancyStartDate(tenancy);
        if (!tenantType || tenantType === 'Agent-Managed') {
            return { applicable: false, reason: 'Agent-managed or unknown tenant type', tenStart, tenantType };
        }
        if (!tenStart) {
            return { applicable: false, reason: 'No tenancy start date in Airtable', tenantType };
        }

        const dataStart = new Date(ARREARS_DATA_START);
        const effectiveStart = tenStart > dataStart ? tenStart : dataStart;
        const dueDay = getNumVal(tenancy, F.tenDueDay, 1);
        const rent = Number(getField(tenancy, F.tenRent)) || 0;
        const cycles = cyclesForTenancy(tenancy, today);
        const payments = paymentsForTenancy(tenancy.id);
        const actual = payments.length;

        // New-tenant guard: chase only kicks in after first payment lands.
        if (actual === 0) {
            return {
                applicable: false,
                reason: 'No reconciled payments yet — chase pipeline only starts after the first payment lands',
                tenStart, effectiveStart, dueDay, rent, cycles, payments, actual,
                tenantType, isUC: tenantType === 'Universal Credit',
            };
        }

        const isUC = tenantType === 'Universal Credit';
        const cyclesPassed = cycles.length;
        const expected = isUC ? Math.max(0, cyclesPassed - 1) : cyclesPassed;
        const missed = Math.max(0, expected - actual);
        const effectiveMonths = isUC ? missed + 1 : missed;
        const cumulativeBalance = effectiveMonths * rent;

        return {
            applicable: true,
            tenantType, isUC,
            tenStart, effectiveStart, dueDay, rent,
            cycles, cyclesPassed,
            payments, actual,
            expected, missed, effectiveMonths,
            cumulativeBalance,
            s8Ready: effectiveMonths >= 2,
        };
    }

    // Effective months in arrears (number ≥ 0; 0 means not chaseable).
    function computeEffectiveMonthsArrears(tenancy, tenantType, today) {
        const b = computeArrearsBreakdown(tenancy, tenantType, today);
        return b.applicable ? b.effectiveMonths : 0;
    }

    // S8 readiness flag. Always false if the tenancy isn't chaseable yet.
    function isS8Ready(tenancy, tenantType, today) {
        const b = computeArrearsBreakdown(tenancy, tenantType, today);
        return b.applicable && b.s8Ready;
    }

    // ── Currently-in-arrears check (drives CFV detection) ──
    // Kevin's simple rule: after 2 days past the most recent due date, if NO
    // reconciled payment has landed against the tenancy in the current cycle
    // window → CFV. ANY reconciled payment linked to the tenancy in that
    // window → in-payment, regardless of value (split transactions can mean
    // a partial amount lands).
    //
    // The "cycle window" is from the previous due date (exclusive) through
    // today. A payment dated anywhere in that range counts. Early payments
    // (e.g. April 28 for May 1 rent), on-time, and late payments all match.
    function isCurrentlyInArrears(tenancy, tenantType, today) {
        if (!getTenancyStartDate(tenancy)) return false;

        const dueDay = getNumVal(tenancy, F.tenDueDay, 1);
        const tolerance = 2; // days after due date before flagging

        // Find the latest due-day that is at least `tolerance` days past today —
        // i.e. the most recent "matured" cycle. Within-tolerance must roll back
        // to the previous month so an unpaid prior cycle isn't silently cleared
        // the moment a new due date passes.
        let matureDue = new Date(today.getFullYear(), today.getMonth(), dueDay);
        matureDue.setHours(0, 0, 0, 0);
        if (Math.floor((today - matureDue) / 86400000) < tolerance) {
            matureDue = new Date(today.getFullYear(), today.getMonth() - 1, dueDay);
            matureDue.setHours(0, 0, 0, 0);
        }

        // No matured cycle yet (e.g. brand-new tenancy whose first due date is
        // still in the future or within tolerance) → not in arrears.
        if (Math.floor((today - matureDue) / 86400000) < tolerance) return false;

        // Tenancy started after the matured cycle → tenant didn't exist yet.
        const tenStart = getTenancyStartDate(tenancy);
        if (tenStart && tenStart > matureDue) return false;

        // Cycle window: previous due date (exclusive) through today (inclusive)
        const prevDue = new Date(matureDue.getFullYear(), matureDue.getMonth() - 1, dueDay);
        prevDue.setHours(0, 0, 0, 0);

        const paid = allTransactions.some(tx => {
            if (!getField(tx, F.txReconciled)) return false;
            if (!txLinkedToTenancy(tx, tenancy.id)) return false;
            const txDateStr = getField(tx, F.txDate);
            if (!txDateStr) return false;
            const txDate = new Date(txDateStr);
            txDate.setHours(0, 0, 0, 0);
            return txDate > prevDue && txDate <= today;
        });

        return !paid;
    }

    // ── Mica task config ──
    // Mirrored from cashflow.js's UC task pattern (which works in production).
    // Tasks land in Mica's queue, tied to the £12k Operating Cushion project,
    // and link back to the tenancy/tenant/unit so they have full context.
    const MICA = {
        email:     'micaa.work@gmail.com',
        projectId: 'recyJDDWaEAzMXMxw',  // £12k Monthly Operating Cushion project
    };
    const TASK_F = {
        name:        'fldgFjGBw6bTKJFCD',
        assignee:    'fldELMncVJYPDRJNc',
        dueDate:     'fld7XP8w8kbxfETV4',
        status:      'fldx4qCw17UfrKpaN',
        timeEst:     'fld10VzzbiNNgRmIi',
        project:     'fldBg0rQy0FrOAkRN',
        hardDeadline:'fldZKzIxgyrQ8CG8a',
        tenancies:   'fldmne4RYJU22ICub',
        tenants:     'fld6ZcfEogJmeQj2c',
        rentalUnits: 'fldEW648YtTZ6j01n',
        desc:        'fldRGhBQViKZKtkQ6',
    };
    // Stages that require Mica to physically pick up the phone
    const PHONE_TASK_STAGES = new Set(['Soft Chase', 'Firm Contact', 'Formal Warning', 'Pre-Action']);

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
    // airtableFetch (shared.js) returns an array of records directly and handles
    // pagination internally. Earlier this code wrongly unwrapped `.records` on
    // that array which always returned `undefined` — meaning the cache was
    // always empty and every sweep recreated every record. That's how 240
    // duplicates appeared. Treat the return value as an array.
    async function loadArrearsRecords(force = false) {
        // Cache for 60 seconds to avoid re-fetching during the same sweep
        if (!force && allArrearsRecords.length && (Date.now() - arrearsLoadedAt) < 60000) {
            return allArrearsRecords;
        }
        try {
            const records = await airtableFetch(TABLES.arrears);
            allArrearsRecords = Array.isArray(records) ? records : [];
            arrearsLoadedAt = Date.now();
            return allArrearsRecords;
        } catch (err) {
            console.warn('arrears: loadArrearsRecords failed', err);
            // Keep stale cache rather than zero — better to skip a sweep than
            // create dupes against an empty cache.
            return allArrearsRecords;
        }
    }

    // Lookup by Reference field — used as the dedup key (one record per
    // tenancy + due-month is enforced by the Reference being unique).
    function findArrearsByReference(reference) {
        return allArrearsRecords.find(r => getField(r, ARREARS.ref) === reference);
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

    // ── Build a Reference like AR-2026-04-COLLIN-3KKR ──
    // Year-month + 6-char ref slice + 4-char tenancy id suffix. The id suffix
    // disambiguates tenancies whose ref starts with the same 6 chars (e.g. two
    // "Collins" tenancies). The Reference is the upsert merge key — uniqueness
    // here is the contract that prevents duplicate arrears records.
    function buildArrearsReference(tenancy, dueDate) {
        const yyyy = dueDate.getFullYear();
        const mm = String(dueDate.getMonth() + 1).padStart(2, '0');
        const tenRef = String(getField(tenancy, F.tenRef) || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()
                    || tenancy.id.slice(-4).toUpperCase();
        const idSuffix = tenancy.id.slice(-4).toUpperCase();
        return `AR-${yyyy}-${mm}-${tenRef}-${idSuffix}`;
    }

    // ── Build the title + body for a Mica task at a given stage ──
    function buildMicaTaskFor(stage, tenantType, tenancy, tenant, arrearsRecord, daysFromDue) {
        const tenantName = tenant ? String(getField(tenant, F.tenantName) || '') : '';
        const phone = tenant ? String(getField(tenant, F.tenantPhone) || '') : '';
        const email = tenant ? String(getField(tenant, F.tenantEmail) || '') : '';
        const rent = Number(getField(tenancy, F.tenRent)) || 0;
        const reference = getField(arrearsRecord, ARREARS.ref);
        const dueRaw = String(getField(arrearsRecord, ARREARS.originalDueDate) || '');

        // Day -7 UC verification call has its own, distinct script
        if (stage === 'Preventive' && tenantType === 'Universal Credit') {
            return {
                title: `Call UC to verify rent payment for ${tenantName} (${reference})`,
                body:
`UC Verification Call (Day -7)

Tenant: ${tenantName}
Reference: ${reference}
Expected rent: £${rent.toFixed(2)}
Original due date: ${dueRaw}

UC Office: ${UC_CONTACT.phone}

Confirm with UC:
1. Payment is scheduled
2. It is being processed
3. It will be paid to the landlord (us)

Outcomes:
- Confirmed → no further action
- Delayed / Suspended / Reduced → log in arrears record; Early Intervention will fire
- Unable to reach UC → reschedule for next working day

Auto-generated from arrears engine.`,
            };
        }

        const stageScripts = {
            'Soft Chase':     'Polite check-in. "May be a timing issue — if you\'ve already paid please disregard."',
            'Firm Contact':   'Need to understand what\'s happening. Agree a payment plan if needed.',
            'Formal Warning': 'Final chance before formal notice. Letter also being sent.',
            'Pre-Action':     'Section 8 imminent. Recorded letter being sent. Last chance to settle.',
        };

        return {
            title: `${stage} call: ${tenantName} (${reference})`,
            body:
`${stage} — phone call

Tenant: ${tenantName}
Reference: ${reference}
Days overdue: ${daysFromDue}
Amount owed: £${rent.toFixed(2)}
Phone: ${phone || '(no phone on file)'}
Email: ${email || '(no email on file)'}

Approach: ${stageScripts[stage] || ''}

Log the call outcome by adding a Comment to this task.

Auto-generated from arrears engine.`,
        };
    }

    // ── Create a Mica task and link it back to the arrears record ──
    // Two-step pattern (mirrors cashflow.js createUCTask): Airtable rejects
    // the full field set on POST, so we create with name + assignee, then
    // PATCH the rest. Returns the created task record on success.
    async function createMicaTaskForArrears(arrearsRecord, taskInfo, tenancy, tenant) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLES.tasks}`;

        const createBody = {
            fields: {
                [TASK_F.name]: taskInfo.title,
                [TASK_F.assignee]: { email: MICA.email },
            },
            typecast: true,
        };
        const resp1 = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(createBody),
        });
        if (!resp1.ok) {
            console.error('arrears: Mica task create failed', await resp1.text());
            return null;
        }
        const created = await resp1.json();

        const tenantId = tenant ? tenant.id : null;
        const unitLink = getField(tenancy, F.tenUnit);
        const unitId = extractLinkedId(unitLink);

        const patchFields = {
            [TASK_F.timeEst]:      '15 min',
            [TASK_F.dueDate]:      todayStr,
            [TASK_F.status]:       'Today',
            [TASK_F.hardDeadline]: true,
            [TASK_F.project]:      [MICA.projectId],
            [TASK_F.tenancies]:    [tenancy.id],
            [TASK_F.desc]:         taskInfo.body,
        };
        if (tenantId) patchFields[TASK_F.tenants] = [tenantId];
        if (unitId)   patchFields[TASK_F.rentalUnits] = [unitId];

        const resp2 = await fetch(`${url}/${created.id}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: patchFields, typecast: true }),
        });
        if (!resp2.ok) {
            console.warn('arrears: Mica task PATCH failed (task created but missing context)', await resp2.text());
        }

        // Link the new task back to the arrears record so we have a chain.
        const existingTaskIds = (function() {
            const links = getField(arrearsRecord, ARREARS.linkedTasks);
            if (!Array.isArray(links)) return [];
            return links.map(x => typeof x === 'string' ? x : (x && x.id)).filter(Boolean);
        })();
        await updateArrearsRecord(arrearsRecord.id, {
            [ARREARS.linkedTasks]: [...existingTaskIds, created.id],
        });

        console.log(`arrears: Mica task created — "${taskInfo.title}"`);
        return created;
    }

    // Does this stage + tenant-type combination need a Mica phone task?
    function needsMicaPhoneTask(stage, tenantType) {
        if (stage === 'Preventive' && tenantType === 'Universal Credit') return true;
        return PHONE_TASK_STAGES.has(stage);
    }

    // ── Airtable PATCH with performUpsert: atomic create-or-update by Reference ──
    // This is the dedup contract. Even if two sweeps fire concurrently, Airtable
    // serialises upserts on the merge field so only one record per Reference can exist.
    // Returns the canonical record (created or updated) with fields by ID for cache.
    async function upsertArrearsRecord(payload) {
        const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLES.arrears}?returnFieldsByFieldId=true`;
        const resp = await fetch(url, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                performUpsert: { fieldsToMergeOn: [ARREARS.ref] },
                records: [{ fields: payload }],
                typecast: false,
            }),
        });
        if (!resp.ok) {
            const err = await resp.text();
            console.error('arrears: upsertArrearsRecord failed', resp.status, err);
            return null;
        }
        const data = await resp.json();
        return (data.records && data.records[0]) || null;
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

    // ── Open or update an arrears record at a given stage ──
    // Uses Airtable upsert (atomic at the database level) so duplicate creates
    // are physically impossible. Cache check is now an optimisation only —
    // the Reference uniqueness is enforced by the upsert merge key.
    async function openArrearsRecord(tenancy, tenantType, originalDueDate, stage, today) {
        const reference = buildArrearsReference(tenancy, originalDueDate);

        // Optimisation: skip the API call if we already have this in the cache
        // and it's at or past the requested stage. (Stage progression is handled
        // by progressArrearsRecord — this guard just avoids redundant upserts.)
        const existing = findArrearsByReference(reference);
        if (existing) {
            const currentStage = getStageName(getField(existing, ARREARS.stage));
            if (arrearsStageIndex(currentStage) >= arrearsStageIndex(stage)) {
                return existing;
            }
            // Existing is at an earlier stage — let progressArrearsRecord handle it.
            return existing;
        }

        const rent = Number(getField(tenancy, F.tenRent)) || 0;
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
        const upserted = await upsertArrearsRecord(payload);
        if (upserted) {
            console.log(`arrears: upserted ${reference} at "${stage}" for ${tenancy.id} (${tenantType})`);
            // Replace any stale cache entry with the canonical record (fields by ID).
            const i = allArrearsRecords.findIndex(r => r.id === upserted.id);
            if (i >= 0) allArrearsRecords[i] = upserted;
            else allArrearsRecords.push(upserted);
        }
        return upserted;
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

        // One-time cleanup: close any open arrears records for tenancies that
        // haven't yet had their first reconciled payment. These were created
        // by an earlier engine version that didn't have the new-tenant guard.
        for (const rec of allArrearsRecords) {
            const status = getStatusName(getField(rec, ARREARS.status));
            if (!ARREARS_OPEN_STATUSES.has(status)) continue;
            const tenancyId = extractLinkedId(getField(rec, ARREARS.tenancy));
            if (!tenancyId) continue;
            if (!hasFirstPaymentLanded(tenancyId)) {
                const ok = await updateArrearsRecord(rec.id, {
                    [ARREARS.status]: 'Closed',
                    [ARREARS.notes]: 'Auto-closed: tenancy has not yet had a first reconciled payment. Chase will resume after first payment lands.',
                });
                if (ok) {
                    rec.fields[ARREARS.status] = { name: 'Closed' };
                    console.log(`arrears: auto-closed orphan record ${getField(rec, ARREARS.ref)} (no first payment yet)`);
                }
            }
        }

        // Stage events that fire this sweep — Mica tasks are created in a second
        // pass once all arrears records are settled, so we don't double-create
        // tasks if an upsert+progression both happen in the same sweep.
        const stageEvents = [];

        for (const tenancy of allTenancies) {
            if (!isTenantStatusActive(tenancy)) continue;

            const tenantType = getTenantTypeForTenancy(tenancy, tenantLookup);
            if (!tenantType || tenantType === 'Agent-Managed') continue;

            const rent = Number(getField(tenancy, F.tenRent)) || 0;
            if (rent <= 0) continue;

            // New-tenant guard: arrears chase only kicks in after the first
            // reconciled payment lands. Until then the tenant lives in the
            // legacy CFV view. Avoids over-flagging brand-new UC tenants
            // whose claim is still being set up.
            if (!hasFirstPaymentLanded(tenancy.id)) continue;

            // Sanity: tenancies without a start date can't be evaluated.
            if (!getTenancyStartDate(tenancy)) continue;

            const tenant = getTenantForTenancy(tenancy, tenantLookup);

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
            const daysToNext = Math.floor((dueNextMonth - today) / 86400000);
            const ucWindow = tenantType === 'Universal Credit' && daysToNext <= 7 && daysToNext > 0;
            const workWindow = tenantType === 'Working' && daysToNext <= 1 && daysToNext > 0;
            if (ucWindow || workWindow) candidates.push(dueNextMonth);

            const paidThisMonth = hasLinkedPaymentThisMonth(tenancy.id, today);

            if (paidThisMonth) {
                await applyPaymentResolution(tenancy.id, tenantType, today);
                continue;
            }

            for (const dueDate of candidates) {
                const daysFromDue = Math.floor((today - dueDate) / 86400000);
                const expectedStage = getExpectedStage(tenantType, daysFromDue);
                if (!expectedStage) continue;

                const existing = findArrearsRecord(tenancy.id, dueDate);
                if (!existing) {
                    // Fresh create — stage event for the entry stage
                    const created = await openArrearsRecord(tenancy, tenantType, dueDate, expectedStage, today);
                    if (created) {
                        stageEvents.push({ record: created, stage: expectedStage, tenancy, tenant, tenantType, daysFromDue });
                    }
                    continue;
                }

                const status = getStatusName(getField(existing, ARREARS.status));
                if (!ARREARS_OPEN_STATUSES.has(status)) continue;

                const currentStage = getStageName(getField(existing, ARREARS.stage));
                if (arrearsStageIndex(expectedStage) > arrearsStageIndex(currentStage)) {
                    const ok = await progressArrearsRecord(existing, expectedStage, today);
                    if (ok) {
                        stageEvents.push({ record: existing, stage: expectedStage, tenancy, tenant, tenantType, daysFromDue });
                    }
                }
            }
        }

        // Second pass: create Mica tasks for stage events that need a phone call.
        // We only check `linkedTasks` count as a sanity dedup — the engine's own
        // logic (upsert is idempotent, progression only fires on real stage change)
        // already ensures we don't fire tasks for the same (record, stage) twice.
        for (const evt of stageEvents) {
            if (!needsMicaPhoneTask(evt.stage, evt.tenantType)) continue;
            const taskInfo = buildMicaTaskFor(evt.stage, evt.tenantType, evt.tenancy, evt.tenant, evt.record, evt.daysFromDue);
            await createMicaTaskForArrears(evt.record, taskInfo, evt.tenancy, evt.tenant);
        }
    }

    // ══════════════════════════════════════════
    // ARREARS VIEW — renders into the CFV tab as a "Arrears Pipeline" section.
    // Shows all active arrears records with stage, days overdue, contacts, etc.
    // ══════════════════════════════════════════

    // Stage → Sage-token-aware badge classes (matches Airtable colours)
    const STAGE_BADGE = {
        'Preventive':       { bg: 'var(--info-bg)',     fg: 'var(--info)' },
        'Early Intervention':{ bg: 'var(--warning-bg)', fg: 'var(--warning)' },
        'Soft Chase':       { bg: 'var(--warning-bg)',  fg: 'var(--warning)' },
        'Firm Contact':     { bg: 'var(--warning-bg)',  fg: 'var(--warning)' },
        'Formal Warning':   { bg: 'var(--danger-bg)',   fg: 'var(--danger)' },
        'Pre-Action':       { bg: 'var(--danger-bg)',   fg: 'var(--danger)' },
        'Section 8':        { bg: 'var(--danger-bg)',   fg: 'var(--danger)' },
        'Court':            { bg: 'var(--danger-bg)',   fg: 'var(--danger)' },
        'Resolved':         { bg: 'var(--success-bg)',  fg: 'var(--success)' },
    };
    const STATUS_BADGE = {
        'Active':           { bg: 'var(--success-bg)', fg: 'var(--success)' },
        'Paused':           { bg: 'var(--bg-subtle)',  fg: 'var(--text-secondary)' },
        'Paused (UC Rule)': { bg: 'var(--bg-subtle)',  fg: 'var(--text-secondary)' },
        'Resolved':         { bg: 'var(--success-bg)', fg: 'var(--success)' },
        'Escalated':        { bg: 'var(--danger-bg)',  fg: 'var(--danger)' },
        'Closed':           { bg: 'var(--bg-subtle)',  fg: 'var(--text-muted)' },
    };
    function badgeHtml(text, palette) {
        const p = palette || { bg: 'var(--bg-subtle)', fg: 'var(--text-secondary)' };
        return `<span style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:600;background:${p.bg};color:${p.fg}">${escHtml(text || '—')}</span>`;
    }

    // Find tenancy by id (for cross-referencing arrears → tenancy → tenant + property)
    function findTenancyById(id) {
        return allTenancies.find(t => t.id === id);
    }

    // Render the calculation breakdown for a single tenant — drives the
    // click-to-expand audit row in the per-tenant table.
    function renderBreakdownHtml(t) {
        const b = t.breakdown;
        const fmtDate = d => d instanceof Date ? d.toISOString().slice(0, 10) : '';
        const cyclesList = b.cycles.length
            ? b.cycles.map(d => fmtDate(d)).join(', ')
            : '<em style="color:var(--text-muted)">none</em>';
        const paymentsList = b.payments.length
            ? `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px">
                <thead><tr style="text-align:left;background:var(--bg-surface)">
                    <th style="padding:4px 8px;font-weight:600;color:var(--text-secondary)">#</th>
                    <th style="padding:4px 8px;font-weight:600;color:var(--text-secondary)">Date</th>
                    <th style="padding:4px 8px;font-weight:600;color:var(--text-secondary);text-align:right">Amount</th>
                </tr></thead>
                <tbody>${b.payments.map((p, i) => `<tr>
                    <td style="padding:4px 8px;color:var(--text-muted)">${i + 1}</td>
                    <td style="padding:4px 8px">${escHtml(p.dateStr)}</td>
                    <td style="padding:4px 8px;text-align:right;font-variant-numeric:tabular-nums">£${p.amount.toFixed(2)}</td>
                </tr>`).join('')}</tbody>
              </table>`
            : '<em style="color:var(--text-muted)">none</em>';

        const ucNote = b.isUC
            ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">UC pays one cycle in arrears, so expected = cycles − 1 (the first month is always structurally unpaid until tenancy ends).</div>'
            : '';

        return `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;font-size:12px;color:var(--text-secondary)">
                <div>
                    <div style="font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px">Inputs</div>
                    <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px">
                        <div>Tenancy start:</div><div>${fmtDate(b.tenStart)}</div>
                        <div>Calculation start:</div><div>${fmtDate(b.effectiveStart)} <span style="color:var(--text-muted)">${b.tenStart >= new Date(ARREARS_DATA_START) ? '(tenancy start)' : `(reconciliation cutoff ${ARREARS_DATA_START})`}</span></div>
                        <div>Due day:</div><div>${b.dueDay}${b.dueDay === 1 ? 'st' : b.dueDay === 2 ? 'nd' : b.dueDay === 3 ? 'rd' : 'th'} of each month</div>
                        <div>Monthly rent:</div><div>£${b.rent.toFixed(2)}</div>
                        <div>Tenant type:</div><div>${b.tenantType}</div>
                    </div>
                </div>
                <div>
                    <div style="font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px">Calculation</div>
                    <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px">
                        <div>Cycles passed:</div><div><strong>${b.cyclesPassed}</strong></div>
                        <div>Expected payments:</div><div><strong>${b.expected}</strong> ${b.isUC ? '<span style="color:var(--text-muted)">(cycles − 1, UC structural)</span>' : '(= cycles)'}</div>
                        <div>Actual payments:</div><div><strong>${b.actual}</strong></div>
                        <div>Missed:</div><div><strong>${b.missed}</strong> = max(0, ${b.expected} − ${b.actual})</div>
                        <div>Effective months arrears:</div><div><strong style="color:${b.s8Ready ? 'var(--danger)' : 'var(--text-primary)'}">${b.effectiveMonths}</strong> ${b.isUC ? '= missed + 1 (UC shadow)' : '= missed'}</div>
                        <div>Cumulative balance:</div><div><strong>£${b.cumulativeBalance.toFixed(2)}</strong> = ${b.effectiveMonths} × £${b.rent.toFixed(2)}</div>
                        <div>Section 8 ready:</div><div>${b.s8Ready ? '<strong style="color:var(--danger)">Yes</strong> (effective ≥ 2)' : 'No'}</div>
                    </div>
                    ${ucNote}
                </div>
                <div style="grid-column:1/-1">
                    <div style="font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px;margin-top:8px">Cycle dates (${b.cycles.length})</div>
                    <div style="font-size:11px;color:var(--text-secondary);font-family:var(--font-family-mono,monospace)">${cyclesList}</div>
                </div>
                <div style="grid-column:1/-1">
                    <div style="font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px;margin-top:8px">Reconciled rent payments since ${ARREARS_DATA_START} (${b.payments.length})</div>
                    ${paymentsList}
                </div>
            </div>
        `;
    }

    // Toggle a breakdown row's visibility + flip the chevron in the parent row.
    function toggleArrearsBreakdown(rowId, parentRow) {
        const row = document.getElementById(rowId);
        if (!row) return;
        const isHidden = row.style.display === 'none';
        row.style.display = isHidden ? 'table-row' : 'none';
        const chevron = parentRow.querySelector('[data-chevron]');
        if (chevron) chevron.innerHTML = isHidden ? '&#x25BE;' : '&#x25B8;';
    }
    window.toggleArrearsBreakdown = toggleArrearsBreakdown;

    function renderArrearsSection(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        // No data yet — show a quiet placeholder rather than nothing
        if (!allArrearsRecords.length) {
            container.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:13px;text-align:center">
                Arrears engine has not yet created any records — a sweep runs on each dashboard load.
            </div>`;
            return;
        }

        const today = new Date();
        const todayMs = today.getTime();

        // Filter to non-closed AND linked to a tenancy that has had its first
        // reconciled payment (otherwise the chase shouldn't apply yet).
        const visible = allArrearsRecords
            .map(r => {
                const dueRaw = String(getField(r, ARREARS.originalDueDate) || '');
                const dueMs = dueRaw ? new Date(dueRaw).getTime() : todayMs;
                const daysOverdue = Math.floor((todayMs - dueMs) / 86400000);
                return { rec: r, daysOverdue };
            })
            .filter(({ rec }) => {
                const status = getStatusName(getField(rec, ARREARS.status));
                if (status === 'Closed') return false;
                const tenancyId = extractLinkedId(getField(rec, ARREARS.tenancy));
                if (!tenancyId) return false;
                return hasFirstPaymentLanded(tenancyId);
            })
            .sort((a, b) => b.daysOverdue - a.daysOverdue);

        // Summary by stage
        const byStage = {};
        let totalAmount = 0;
        visible.forEach(({ rec }) => {
            const stage = getStageName(getField(rec, ARREARS.stage)) || '—';
            byStage[stage] = (byStage[stage] || 0) + 1;
            totalAmount += Number(getField(rec, ARREARS.amountOwed)) || 0;
        });

        // Per-tenant cumulative summary — uses transaction history since the
        // data-start cutoff to compute effective months arrears (incl. UC +1).
        // Stores the full breakdown so the click-to-expand row can show the
        // calculation steps without recomputing.
        const tenantLookup = {};
        allTenants.forEach(t => { tenantLookup[t.id] = t; });
        const perTenant = new Map();
        for (const { rec } of visible) {
            const tenancyId = extractLinkedId(getField(rec, ARREARS.tenancy));
            if (!tenancyId || perTenant.has(tenancyId)) continue;
            const tenancy = findTenancyById(tenancyId);
            if (!tenancy) continue;
            const tenantType = getTenantTypeForTenancy(tenancy, tenantLookup);
            const tenant = getTenantForTenancy(tenancy, tenantLookup);
            const tenantName = tenant ? String(getField(tenant, F.tenantName) || '') : String(getField(tenancy, F.tenSurname) || '—');
            const breakdown = computeArrearsBreakdown(tenancy, tenantType, today);
            if (!breakdown.applicable) continue;
            perTenant.set(tenancyId, {
                tenancyId, tenancy, tenantType, tenantName,
                rent: breakdown.rent,
                effectiveMonths: breakdown.effectiveMonths,
                s8Ready: breakdown.s8Ready,
                cumulativeBalance: breakdown.cumulativeBalance,
                breakdown,
            });
        }

        // Total exposure including the UC shadow month for any tenant with arrears
        let totalExposure = 0;
        let s8ReadyCount = 0;
        for (const t of perTenant.values()) {
            totalExposure += t.cumulativeBalance;
            if (t.s8Ready) s8ReadyCount++;
        }

        const stageOrder = ['Preventive', 'Early Intervention', 'Soft Chase', 'Firm Contact', 'Formal Warning', 'Pre-Action', 'Section 8', 'Court', 'Resolved'];
        const summaryChips = stageOrder
            .filter(s => byStage[s])
            .map(s => `<span style="display:inline-block;margin-right:8px">${badgeHtml(`${s} (${byStage[s]})`, STAGE_BADGE[s])}</span>`)
            .join('');

        // Build table rows
        const rows = visible.map(({ rec, daysOverdue }) => {
            const reference = String(getField(rec, ARREARS.ref) || '—');
            const stage = getStageName(getField(rec, ARREARS.stage));
            const status = getStatusName(getField(rec, ARREARS.status));
            const amount = Number(getField(rec, ARREARS.amountOwed)) || 0;
            const lastContact = String(getField(rec, ARREARS.lastContactDate) || '');
            const nextAction = String(getField(rec, ARREARS.nextActionType) || '');
            const nextDue = String(getField(rec, ARREARS.nextActionDue) || '');

            const tenancyId = extractLinkedId(getField(rec, ARREARS.tenancy));
            const tenancy = findTenancyById(tenancyId);
            const tenantLookup = {};
            allTenants.forEach(t => { tenantLookup[t.id] = t; });
            const tenant = tenancy ? getTenantForTenancy(tenancy, tenantLookup) : null;
            const tenantType = tenancy ? getTenantTypeForTenancy(tenancy, tenantLookup) : null;
            const tenantName = tenant ? String(getField(tenant, F.tenantName) || '') : (tenancy ? String(getField(tenancy, F.tenSurname) || '') : '—');
            const propertyVal = tenancy ? getField(tenancy, F.tenProperty) : null;
            const property = Array.isArray(propertyVal) ? propertyVal[0] : (propertyVal || '');
            const unitVal = tenancy ? getField(tenancy, F.tenUnitRef) : null;
            const unit = Array.isArray(unitVal) ? unitVal[0] : (unitVal || '');

            return `<tr style="border-bottom:1px solid var(--border-subtle)">
                <td style="padding:10px 12px;font-family:var(--font-family-mono,monospace);font-size:11px;color:var(--text-secondary)">${escHtml(reference)}</td>
                <td style="padding:10px 12px"><div style="font-weight:600">${escHtml(tenantName)}</div>${unit ? `<div style="font-size:11px;color:var(--text-muted)">${escHtml(unit)}</div>` : ''}</td>
                <td style="padding:10px 12px;font-size:12px;color:var(--text-secondary)">${escHtml(property)}</td>
                <td style="padding:10px 12px">${badgeHtml(stage, STAGE_BADGE[stage])}</td>
                <td style="padding:10px 12px">${badgeHtml(status, STATUS_BADGE[status])}</td>
                <td style="padding:10px 12px;text-align:right;font-weight:${daysOverdue >= 21 ? '700' : '500'};color:${daysOverdue >= 14 ? 'var(--danger)' : 'var(--text-primary)'};font-variant-numeric:tabular-nums">${daysOverdue}</td>
                <td style="padding:10px 12px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums">£${amount.toFixed(2)}</td>
                <td style="padding:10px 12px;font-size:12px;color:var(--text-secondary)">${escHtml(lastContact || '')}</td>
                <td style="padding:10px 12px;font-size:12px">${nextAction ? `<div>${escHtml(nextAction)}</div>${nextDue ? `<div style="color:var(--text-muted);font-size:11px">${escHtml(nextDue)}</div>` : ''}` : ''}</td>
                <td style="padding:10px 12px">${tenantType ? badgeHtml(tenantType, { bg: 'var(--bg-subtle)', fg: 'var(--text-secondary)' }) : ''}</td>
            </tr>`;
        }).join('');

        // Per-tenant summary rows with click-to-expand breakdown.
        // Each tenant gets two <tr> elements: the summary row and a hidden
        // breakdown row (toggled via the inline onclick handler).
        const tenantSummaryRows = Array.from(perTenant.values())
            .sort((a, b) => b.effectiveMonths - a.effectiveMonths)
            .map(t => {
                const rowBg = t.s8Ready ? 'var(--danger-bg)' : 'transparent';
                const breakdownId = `arrearsBreakdown_${t.tenancyId}`;
                return `<tr style="background:${rowBg};border-bottom:1px solid var(--border-subtle);cursor:pointer" onclick="toggleArrearsBreakdown('${breakdownId}', this)">
                    <td style="padding:10px 12px"><span style="display:inline-block;width:14px;color:var(--text-muted);font-size:10px" data-chevron>&#x25B8;</span> <span style="font-weight:600;color:var(--text-primary)">${escHtml(t.tenantName)}</span></td>
                    <td style="padding:10px 12px">${badgeHtml(t.tenantType, { bg: 'var(--bg-subtle)', fg: 'var(--text-secondary)' })}</td>
                    <td style="padding:10px 12px;text-align:right;font-weight:${t.effectiveMonths >= 2 ? '700' : '500'};color:${t.effectiveMonths >= 2 ? 'var(--danger)' : 'var(--text-primary)'};font-variant-numeric:tabular-nums">${t.effectiveMonths.toFixed(0)}</td>
                    <td style="padding:10px 12px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;color:var(--text-primary)">£${t.cumulativeBalance.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td style="padding:10px 12px">${t.s8Ready ? badgeHtml('S8 Ready', { bg: 'var(--danger)', fg: '#fff' }) : ''}</td>
                </tr>
                <tr id="${breakdownId}" style="display:none;background:var(--bg-surface-2)">
                    <td colspan="5" style="padding:16px 24px">${renderBreakdownHtml(t)}</td>
                </tr>`;
            }).join('');

        // KPI cards at the top — visually weightier than chip summary
        const kpiCardsHtml = `
            <div class="cards-grid" style="margin-bottom:16px">
                <div class="kpi-card">
                    <div class="kpi-card-label">Tenants in arrears</div>
                    <div class="kpi-card-value">${perTenant.size}</div>
                    <div class="kpi-card-sub">${visible.length} active arrears record${visible.length === 1 ? '' : 's'}</div>
                </div>
                <div class="kpi-card">
                    <div class="kpi-card-label">Total exposure</div>
                    <div class="kpi-card-value text-red">£${totalExposure.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    <div class="kpi-card-sub">Cumulative balance owed (UC includes +1 month shadow)</div>
                </div>
                <div class="kpi-card" style="${s8ReadyCount > 0 ? 'border-color:var(--danger);border-width:2px' : ''}">
                    <div class="kpi-card-label" style="${s8ReadyCount > 0 ? 'color:var(--danger)' : ''}">Section 8 ready</div>
                    <div class="kpi-card-value ${s8ReadyCount > 0 ? 'text-red' : ''}">${s8ReadyCount}</div>
                    <div class="kpi-card-sub">${s8ReadyCount > 0 ? 'Tenants at ≥ 2 effective months' : 'No tenants have hit threshold'}</div>
                </div>
            </div>
        `;

        container.innerHTML = `
            <div class="section">
                <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
                    <h2 class="section-title" style="margin-bottom:0">Arrears Pipeline</h2>
                    <span style="font-size:12px;color:var(--text-muted)">Calculated from reconciled transactions since ${ARREARS_DATA_START} &nbsp;·&nbsp; new tenants enter the chase only after their first payment lands</span>
                </div>
                ${kpiCardsHtml}
                ${perTenant.size ? `
                <div style="margin-bottom:24px;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);overflow:hidden">
                    <div style="padding:12px 16px;background:var(--bg-surface-2);border-bottom:1px solid var(--border-default);font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px">
                        Per-tenant cumulative position
                    </div>
                    <div style="overflow-x:auto">
                        <table style="width:100%;border-collapse:collapse;font-size:13px">
                            <thead>
                                <tr style="text-align:left;background:var(--bg-surface)">
                                    <th style="padding:10px 12px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-muted);border-bottom:1px solid var(--border-subtle)">Tenant</th>
                                    <th style="padding:10px 12px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-muted);border-bottom:1px solid var(--border-subtle)">Type</th>
                                    <th style="padding:10px 12px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-muted);border-bottom:1px solid var(--border-subtle);text-align:right">Months arrears</th>
                                    <th style="padding:10px 12px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-muted);border-bottom:1px solid var(--border-subtle);text-align:right">Balance</th>
                                    <th style="padding:10px 12px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-muted);border-bottom:1px solid var(--border-subtle)">Section 8</th>
                                </tr>
                            </thead>
                            <tbody>${tenantSummaryRows}</tbody>
                        </table>
                    </div>
                </div>
                ` : ''}
                <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px">
                    <h3 style="font-size:13px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin:0">Active arrears records</h3>
                    <div style="font-size:12px">${summaryChips}</div>
                </div>
                <div style="overflow-x:auto">
                    <table style="width:100%;border-collapse:collapse;font-size:13px">
                        <thead>
                            <tr style="text-align:left;border-bottom:2px solid var(--border-default);background:var(--bg-surface-2)">
                                <th style="padding:8px 10px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary)">Reference</th>
                                <th style="padding:8px 10px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary)">Tenant</th>
                                <th style="padding:8px 10px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary)">Property</th>
                                <th style="padding:8px 10px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary)">Stage</th>
                                <th style="padding:8px 10px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary)">Status</th>
                                <th style="padding:8px 10px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary);text-align:right">Days&nbsp;O/D</th>
                                <th style="padding:8px 10px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary);text-align:right">Amount</th>
                                <th style="padding:8px 10px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary)">Last&nbsp;Contact</th>
                                <th style="padding:8px 10px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary)">Next&nbsp;Action</th>
                                <th style="padding:8px 10px;font-weight:600;font-size:11px;text-transform:uppercase;color:var(--text-secondary)">Type</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        `;
    }

    // Expose to other modules
    window.runArrearsEngine = runArrearsEngine;
    window.loadArrearsRecords = loadArrearsRecords;
    window.getTenantTypeForTenancy = getTenantTypeForTenancy;
    window.renderArrearsSection = renderArrearsSection;
    window.isCurrentlyInArrears = isCurrentlyInArrears;
