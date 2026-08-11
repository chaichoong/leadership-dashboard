// money-confidence-daily — now the AI CEO morning brief (28 Jul 2026).
//
// Cron: Mon–Fri 09:00 Europe/London. Recomputes the money figure LIVE from
// Airtable, gathers open tasks + calendar + quarter context, has the AI CEO
// (Integrator voice, ONE-thing rule) write the daily direction, DMs Kevin,
// and stores the brief in the CEO Briefs table for the dashboard tab.
// If the CEO layer fails for ANY reason, the original money-only DM still
// sends — the working feed is never sacrificed to the new feature.
// Design: docs/ai-org-chart-spec.md + the AI brain (00 AI Context).
//
// ── SOURCE OF TRUTH ──────────────────────────────────────────────────────────
// This is a faithful PORT of the browser engine. Keep it in sync:
//   - computeSafeToAct() ........ js/money.js:37-117
//   - analysePaymentLag() ....... js/cashflow.js:1146-1219
//   - helpers (getField, getNumVal, getPaymentStatusName, isTenancyEnded,
//     isTenantStatusActive, isCostActive) .... js/shared.js:143-310
// If the formula changes in the app, change it here too or the Slack figure
// will drift from the Money tab. The web app remains the canonical engine.
//
// ── ENV / SECRETS ────────────────────────────────────────────────────────────
//   SLACK_BOT_TOKEN   xoxb-… (scopes: chat:write, users:read, users:read.email)
//   AIRTABLE_PAT      pat_… read on Accounts, Tenancies, Costs, Transactions
//   RECIPIENT_EMAIL   (optional) Slack email to DM. Default kevin@runpreneur.org.uk
//   TRIGGER_KEY       (optional) shared key that guards the manual test endpoint
// ─────────────────────────────────────────────────────────────────────────────

const BASE_ID = 'appnqjDpqDniH3IRl';
const DEFAULT_RECIPIENT = 'kevin@runpreneur.org.uk';
const WAGES_TARGET_GBP = 1500;

const TBL = {
    accounts:     'tbl1nr0EcX2T62KME',
    costs:        'tblx5kvhzNEI5TFlS',
    tenancies:    'tblN51a88qTDB6iMH',
    transactions: 'tbln0gzhCAorFc3zB',
};
const F = {
    accGBP:        'fldhDG5jDA8Tu2JyI',
    tenRent:       'fldDMyfZLFMeONPq8',
    tenPayStatus:  'fldxU3dPUnbK0SCDq',
    tenStatus:     'fldgWAyha1Uij1SZP',
    tenEndDate:    'fldwHhhKAq4f1nY9e',
    tenDueDay:     'fldhy2U0CQmM2oS4P',
    costExpected:  'fld9JibXkMpTeMcxw',
    costInactive:  'fldQJPGLFMbwVelsW',
    costPayStatus: 'fldXZNI96v8HgjuSh',
    txReconciled:  'fldxKX1IbIFcAOnn5',
    txSubCategory: 'fldMRjSVzZVYeHb0A',
    txTenancy:     'fldPmAMmxwqs4SdPa',
    txDate:        'fldoyQ6Rr9cHp3bgQ',
    // CEO Briefs (written below by storeBrief). IDs, not names: a rename in
    // Airtable would drop the field from the write silently, and the nightly drift
    // monitor only watches IDs. Mirrors F.ceo* in js/config.js, which js/ceo-brief.js
    // reads — keep the two in step.
    ceoDate:        'fldzLwBd3Mjg7rDxM',
    ceoOneThing:    'fldQDCAcd74Bb6mpY',
    ceoFirstStep:   'fld4O4EuxHzMWARV7',
    ceoWhy:         'fldqooUbDCQ4yNlWQ',
    ceoIgnoreToday: 'fldmC5AYRaJdfyFGx',
    ceoBoardFlags:  'fldS7ZoGAS7sAJfJq',
    ceoHandedOff:   'fld9PQ10p8V4N8Y0U',
    ceoMoneyLight:  'fldBIbjpHlA2QmVbO',
    ceoSafeToAct:   'fldQ4JEWYpHpI2KDs',
    ceoFullBrief:   'fldPkiaWvmYAoyHEl',
    ceoSourceStats: 'fldVgR25q8bqdub4c',
};
const REC = {
    santander:    'rec3LiEiifomEHlvy',
    tntZempler:   'recsR9QhRKYwgV8oP',
    subRentalInc: 'recI8yCstyDP1Nd4b',
};

// CEO-brief tables (fetched by FIELD NAME, not field id — see airtableFetch byName)
const TBL_TASKS  = 'tblqB8b22hKBL4PF1';
const TBL_BRIEFS = 'tblIxbzDSOCI5hqJn';
const CLAUDE_PROXY = 'https://claude-proxy.kevinbrittain.workers.dev';

// ── Ported helpers ───────────────────────────────────────────────────────────
const getField = (rec, id) => rec.fields?.[id];
function getNumVal(rec, id, fallback) {
    const val = getField(rec, id);
    if (val == null) return fallback;
    if (typeof val === 'number') return val;
    if (typeof val === 'object' && val.name != null) return Number(val.name) || fallback;
    return Number(val) || fallback;
}
function getPaymentStatusName(field) {
    if (!field) return '';
    if (typeof field === 'string') return field;
    if (field.name) return field.name;
    return String(field);
}
function isTenancyEnded(rec) {
    const raw = getField(rec, F.tenEndDate);
    if (!raw) return false;
    const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
    const end = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(raw);
    if (isNaN(end.getTime())) return false;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return end < startOfToday;
}
function isTenantStatusActive(rec) {
    if (isTenancyEnded(rec)) return false;
    const status = getField(rec, F.tenStatus);
    if (!status) return false;
    if (Array.isArray(status)) return status.some(s => typeof s === 'string' && s.trim().toLowerCase() === 'active');
    if (typeof status === 'string') return status.trim().toLowerCase() === 'active';
    return false;
}
function isCostActive(rec) {
    if (getField(rec, F.costInactive)) return false;
    const status = getPaymentStatusName(getField(rec, F.costPayStatus));
    return status === 'In Payment' || status === 'Overdue';
}

// Port of js/cashflow.js analysePaymentLag(). `transactions` may be pre-filtered
// to reconciled rental-income rows — the internal guards make that identical to
// passing the full set.
function analysePaymentLag(transactions, incomeTenancies) {
    const lagByTenancy = {};
    const tenancyDueDay = {};
    incomeTenancies.forEach(r => { tenancyDueDay[r.id] = getNumVal(r, F.tenDueDay, 1); });

    (transactions || []).forEach(r => {
        if (!getField(r, F.txReconciled)) return;
        const sc = getField(r, F.txSubCategory);
        const scIds = Array.isArray(sc) ? sc.map(s => typeof s === 'object' ? s.id : s) : [];
        if (!scIds.includes(REC.subRentalInc)) return;

        const linked = getField(r, F.txTenancy);
        const tenIds = Array.isArray(linked)
            ? linked.map(t => (t && typeof t === 'object') ? t.id : t).filter(Boolean)
            : [];
        if (tenIds.length === 0) return;

        const txDateStr = getField(r, F.txDate);
        if (!txDateStr) return;
        const txDate = new Date(txDateStr);
        if (isNaN(txDate.getTime())) return;

        tenIds.forEach(tid => {
            const dueDay = tenancyDueDay[tid];
            if (!dueDay) return;
            const txMonth = txDate.getMonth();
            const txYear = txDate.getFullYear();
            const lastDayOfMonth = new Date(txYear, txMonth + 1, 0).getDate();
            const dueDate = new Date(txYear, txMonth, Math.min(dueDay, lastDayOfMonth));
            if (txDate < dueDate) {
                const prevMonthLastDay = new Date(txYear, txMonth, 0).getDate();
                const prevMonth = new Date(txYear, txMonth - 1, Math.min(dueDay, prevMonthLastDay));
                const lagPrev = Math.round((txDate - prevMonth) / 86400000);
                if (lagPrev >= 0 && lagPrev <= 15) {
                    if (!lagByTenancy[tid]) lagByTenancy[tid] = [];
                    lagByTenancy[tid].push(lagPrev);
                    return;
                }
            }
            const lag = Math.round((txDate - dueDate) / 86400000);
            if (lag >= -5 && lag <= 30) {
                if (!lagByTenancy[tid]) lagByTenancy[tid] = [];
                lagByTenancy[tid].push(lag);
            }
        });
    });

    const allLags = [];
    for (const tid in lagByTenancy) {
        const lags = lagByTenancy[tid];
        if (lags.length < 2) continue;
        allLags.push(...lags);
    }

    let bufferDays = 3;
    let bufferReason = 'Default 3-day buffer (insufficient transaction history for analysis)';
    if (allLags.length >= 10) {
        const sorted = [...allLags].sort((a, b) => a - b);
        const p80 = sorted[Math.floor(sorted.length * 0.8)];
        bufferDays = Math.max(2, Math.min(p80 + 1, 10));
        const avgAll = (allLags.reduce((s, v) => s + v, 0) / allLags.length).toFixed(1);
        bufferReason = `${bufferDays}-day buffer from ${allLags.length} payments (avg ${avgAll} days lag, 80th pct ${p80} days)`;
    }
    return { bufferDays, bufferReason, sampleSize: allLags.length };
}

// Port of js/money.js computeSafeToAct().
function computeSafeToAct({ accounts, tenancies, costs, transactions }) {
    const santanderRec = accounts.find(r => r.id === REC.santander);
    const zemplerRec   = accounts.find(r => r.id === REC.tntZempler);
    const santBal = Number(getField(santanderRec, F.accGBP)) || 0;
    const zempBal = Number(getField(zemplerRec, F.accGBP)) || 0;
    const clearedBalance = santBal + zempBal;

    const statusOf = r => getPaymentStatusName(getField(r, F.tenPayStatus)).trim().toLowerCase();
    const rentOf   = r => Number(getField(r, F.tenRent)) || 0;
    const inPaymentTen = tenancies.filter(r => statusOf(r) === 'in payment'   && isTenantStatusActive(r));
    const cfvActionTen = tenancies.filter(r => statusOf(r) === 'cfv actioned' && isTenantStatusActive(r));
    const cfvOpenTen   = tenancies.filter(r => statusOf(r) === 'cfv'          && isTenantStatusActive(r));
    const inPaymentIncome   = inPaymentTen.reduce((s, r) => s + rentOf(r), 0);
    const cfvActionedIncome = cfvActionTen.reduce((s, r) => s + rentOf(r), 0);
    const cfvExposure       = cfvOpenTen.reduce((s, r) => s + rentOf(r), 0);
    const grossExpectedRent = inPaymentIncome + cfvActionedIncome;
    const totalActiveRent   = grossExpectedRent + cfvExposure;

    const nonPaymentRate = totalActiveRent > 0 ? cfvExposure / totalActiveRent : 0;
    const rentHaircut    = grossExpectedRent * nonPaymentRate;
    const netExpectedRent = grossExpectedRent - rentHaircut;

    const activeCosts = costs.filter(r => isCostActive(r));
    const monthlyCosts = activeCosts.reduce((s, r) => s + (Number(getField(r, F.costExpected)) || 0), 0);

    const uncoveredCosts = Math.max(0, monthlyCosts - netExpectedRent);
    const wagesFloat = WAGES_TARGET_GBP;

    const lag = analysePaymentLag(transactions, [...inPaymentTen, ...cfvActionTen]);
    const bufferDays = lag.bufferDays;
    const lagCushion = Math.round((bufferDays / 31) * monthlyCosts);

    const floor = wagesFloat + lagCushion;
    const safeToActToday = Math.max(0, clearedBalance - floor - uncoveredCosts);

    let light, headline;
    if (clearedBalance < floor) {
        light = 'red';
        headline = 'Below your protective floor. Pay only essentials. Take nothing for yourself.';
    } else if (safeToActToday <= 0) {
        light = 'amber';
        headline = 'Cushion intact, but reliable rent does not cover this month’s fixed costs. Cover commitments only.';
    } else {
        light = 'green';
        headline = 'Surplus available. Act on the plan: pay critical invoices, then clear the priority card.';
    }

    return {
        santBal, zempBal, clearedBalance,
        grossExpectedRent, nonPaymentRate, rentHaircut, netExpectedRent,
        monthlyCosts, uncoveredCosts, wagesFloat, bufferDays, lagCushion,
        floor, safeToActToday, light, headline,
        counts: { inPayment: inPaymentTen.length, cfvActioned: cfvActionTen.length, cfvOpen: cfvOpenTen.length },
    };
}

// ── Airtable ─────────────────────────────────────────────────────────────────
async function airtableFetch(pat, tableId, params = {}, byName = false) {
    const records = [];
    let offset = null;
    do {
        const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
        if (!byName) url.searchParams.set('returnFieldsByFieldId', 'true');
        Object.entries(params).forEach(([k, v]) => {
            if (Array.isArray(v)) v.forEach(val => url.searchParams.append(k, val));
            else url.searchParams.append(k, v);
        });
        if (offset) url.searchParams.set('offset', offset);

        let resp;
        for (let attempt = 0; attempt < 4; attempt++) {
            resp = await fetch(url, { headers: { Authorization: `Bearer ${pat}` } });
            if (resp.status === 429) {
                await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
                continue;
            }
            break;
        }
        if (!resp.ok) throw new Error(`Airtable ${tableId} error ${resp.status}`);
        const data = await resp.json();
        records.push(...data.records);
        offset = data.offset || null;
    } while (offset);
    return records;
}

async function loadAndCompute(pat) {
    const [accounts, tenancies, costs, transactions] = await Promise.all([
        airtableFetch(pat, TBL.accounts, {
            filterByFormula: `OR(RECORD_ID()='${REC.santander}',RECORD_ID()='${REC.tntZempler}')`,
            'fields[]': [F.accGBP],
        }),
        airtableFetch(pat, TBL.tenancies, {
            'fields[]': [F.tenRent, F.tenPayStatus, F.tenStatus, F.tenEndDate, F.tenDueDay],
        }),
        airtableFetch(pat, TBL.costs, {
            'fields[]': [F.costExpected, F.costInactive, F.costPayStatus],
        }),
        // Pre-filtered to reconciled rental income (identical lag result, tiny payload).
        // The ID re-check inside analysePaymentLag corrects any ARRAYJOIN over-match.
        airtableFetch(pat, TBL.transactions, {
            filterByFormula: `AND({Reconciled}=1,FIND("Rental Income",ARRAYJOIN({Chart of Accounts - Sub Category}))>0)`,
            'fields[]': [F.txReconciled, F.txSubCategory, F.txTenancy, F.txDate],
        }),
    ]);
    return computeSafeToAct({ accounts, tenancies, costs, transactions });
}

// ── CEO brief: gather → think → store ────────────────────────────────────────

function todayLondonISO() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

// Open tasks, compressed to what a CEO needs for triage. Field NAMES on purpose.
// Today's huddle digest, written by the LOCAL `ceo-huddle` scheduled task (~07:30 London).
// A Cloudflare Worker cannot dispatch the department agents, so the huddle runs in Claude Code
// and hands its result over through Airtable. Returns null when the huddle did not run (Mac
// asleep, agent error): the brief then generates exactly as it always did, so the 09:00 message
// never fails to arrive because of this.
async function gatherHuddle(pat) {
    try {
        const today = todayLondonISO();
        // returnFieldsByFieldId is NOT optional here: every read below is by field ID, and
        // without it Airtable keys the response by field NAME, so each getField returns
        // undefined and this function quietly returns null EVERY day. That is what happened
        // 30–31 Jul 2026: the huddle's call was silently binned, the CEO re-decided the day
        // alone, and the missing recordId meant the store POSTed a duplicate instead of
        // patching the 07:30 stub. Two bugs, one missing query parameter.
        const url = `https://api.airtable.com/v0/${BASE_ID}/${TBL_BRIEFS}`
            + `?returnFieldsByFieldId=true&maxRecords=5`
            + `&filterByFormula=${encodeURIComponent(`DATESTR({Date})='${today}'`)}`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${pat}` } });
        if (!r.ok) return null;
        // Prefer the stub still waiting to be filled. If a past bug left more than one row for
        // today, patching the unfinished one beats adding a third.
        const rec = ((await r.json()).records || []).find(x => !getField(x, F.ceoFullBrief));
        if (!rec) return null;   // no row today, or the worker already ran
        const oneThing = getField(rec, F.ceoOneThing) || '';
        const flags    = getField(rec, F.ceoBoardFlags) || '';
        if (!oneThing && !flags) return null;
        // What the departments already dispatched at 07:30. Carried through so the 09:00 store
        // does not overwrite it with the CEO's own shorter list — merged inside callCeo().
        const handedOff = String(getField(rec, F.ceoHandedOff) || '').split('\n').filter(Boolean);
        return { recordId: rec.id, oneThing, firstStep: getField(rec, F.ceoFirstStep) || '', flags, handedOff };
    } catch { return null; }
}

// Status 'Approval' is NOT work in progress. It is FINISHED agent work with the
// words already written, waiting on one tick in Slack — and for a Correspondence
// task, approving it sends the email.
//
// Until 11 Aug 2026 these were mixed into the same pile as everything else, with
// nothing in the payload saying what they were. The 09:00 brief that day
// (recbv7w4clndYdztn) made the one thing 'Re-engage Jack Duddy' and the first
// step 'Spend 10 minutes writing one honest, short re-opener in your own voice',
// and handed off 'worker-writer — draft a warm re-opener message for Jack Duddy'.
// All 20 'Warm lane: re-engage <name>' tasks were already in Approval, due
// 2026-08-08, each with a complete addressed email in Agent Output. The brief
// invented ten minutes of writing plus a duplicate agent dispatch for work that
// needed one tap, and never mentioned that 60 tasks were blocked behind Kevin.
// Same shape as the prospecting engine: the queue IS the gate, and nothing sends.
async function gatherTasks(pat) {
    const rows = await airtableFetch(pat, TBL_TASKS, {
        filterByFormula: `AND({Task Name}!='',NOT({Status}='Completed'),NOT({Status}='Cancelled'))`,
        'fields[]': ['Task Name', 'Assignee', 'Due Date', 'Status', 'Priority', 'Task Type'],
    }, true);
    const today = todayLondonISO();
    const t = rows.map(r => ({
        name: String(r.fields['Task Name'] || '').slice(0, 90),
        who: (r.fields['Assignee'] && r.fields['Assignee'].name) || 'unassigned',
        due: (r.fields['Due Date'] || '').slice(0, 10),
        status: String(r.fields['Status'] || ''),
        priority: String(r.fields['Priority'] || ''),
        type: String(r.fields['Task Type'] || ''),
    }));
    // Split first. An Approval task counted as overdue reads as work Kevin has not
    // done, when it is work an agent already did and he has not looked at.
    const waiting = t.filter(x => x.status === 'Approval');
    const live = t.filter(x => x.status !== 'Approval');
    const overdue = live.filter(x => x.due && x.due < today);
    const dueToday = live.filter(x => x.due === today);
    const kevins = live.filter(x => /kevin/i.test(x.who));
    const sends = waiting.filter(x => x.type === 'Correspondence');
    const line = x => `- ${x.name} | ${x.who} | due ${x.due || 'none'} | ${x.priority || x.status}`;
    const waitLine = x => `- ${x.name}${x.type === 'Correspondence' ? ' | APPROVING SENDS THE EMAIL' : ''} | waiting since ${x.due || 'unknown'}`;
    return {
        counts: {
            open: live.length,
            overdue: overdue.length,
            dueToday: dueToday.length,
            kevins: kevins.length,
            awaitingApproval: waiting.length,
            awaitingSend: sends.length,
        },
        overdueList: overdue.slice(0, 20).map(line).join('\n'),
        dueTodayList: dueToday.slice(0, 15).map(line).join('\n'),
        kevinList: kevins.slice(0, 25).map(line).join('\n'),
        approvalList: waiting.slice(0, 20).map(waitLine).join('\n'),
        // The names an agent must not be dispatched to redo. Lower-cased for a
        // cheap containment test in the brief validator.
        approvalNames: waiting.map(x => x.name.toLowerCase()),
    };
}

// Today's calendar from a private ICS feed (no OAuth needed). Optional: when the
// CALENDAR_ICS_URL secret is unset the brief simply says so.
async function gatherCalendar(env) {
    if (!env.CALENDAR_ICS_URL) return { connected: false, today: '' };
    try {
        const resp = await fetch(env.CALENDAR_ICS_URL);
        if (!resp.ok) throw new Error('ICS fetch ' + resp.status);
        const ics = await resp.text();
        const today = todayLondonISO().replace(/-/g, '');
        const events = [];
        for (const block of ics.split('BEGIN:VEVENT').slice(1)) {
            const dt = (block.match(/DTSTART[^:]*:(\d{8}(T\d{6})?)/) || [])[1] || '';
            if (!dt.startsWith(today)) continue;
            const summary = ((block.match(/SUMMARY:(.*)/) || [])[1] || '').trim();
            const time = dt.includes('T') ? `${dt.slice(9, 11)}:${dt.slice(11, 13)}` : 'all day';
            if (summary) events.push(`${time} — ${summary}`);
        }
        return { connected: true, today: events.sort().join('\n') || '(no events today)' };
    } catch (err) {
        return { connected: true, today: '(calendar could not be read today: ' + String(err.message).slice(0, 80) + ')' };
    }
}

function buildCeoPrompt(m, tasks, calendar, env, huddle) {
    // When the departments have already huddled, their conclusion LEADS. The CEO synthesises and
    // formats it. It does not re-decide the day from scratch and quietly overrule eleven heads.
    const huddleBlock = huddle ? `
DEPARTMENT HUDDLE, HELD 07:30 TODAY — your board's own conclusion. Lead with it.
Their ONE THING: ${huddle.oneThing}
Their first step: ${huddle.firstStep}
Their flags:
${huddle.flags}

Use their ONE THING as today's one thing, unless the money light or a hard deadline makes it
plainly wrong. If you override them, say so in one line and give the reason. Keep at most two of
their flags: the two that change what Kevin actually does today.
${huddle.handedOff && huddle.handedOff.length ? `The departments ALREADY dispatched these this morning, and they are added to handed_off automatically. Do NOT list them again:\n${huddle.handedOff.join('\n')}\n` : ''}` : `
No huddle ran today, so decide the day yourself from the data below.
`;
    const system = `You are Kevin Brittain's AI CEO — his right hand, running his day so he does not have to.
Voice: Gino Wickman's Integrator running Gary Keller's ONE-thing rule. Direct, warm, spartan, UK English.
HARD RULES:
- Write for a 13-year-old reader. No jargon, no acronyms without explanation, no em dashes.
- Give ONE thing, with a tiny FIRST STEP of about 10 minutes, so starting is easy. Never a list.
- Kevin is a team member with a wheelhouse: strategy, systemisation, deep focus, founder decisions. NEVER give him admin, chasing, paperwork or phone calls.
- DELEGATION, and AI COMES FIRST. Kevin's north star is that AI does up to 90% of repeatable work, so before you hand anything to a person, ask whether AI can do it. Three destinations, in this order:
  1. AI — a named agent. Real agents that exist today: worker-builder (code, pages, features), worker-writer (copy, outreach, posts, client documents), worker-researcher (finding and verifying facts, prospect and company checks), worker-analyst (numbers, Airtable queries, conversion rates, scorecards), worker-auditor (sweeps, security and compliance checks, page tests, regression checks). Anything repeatable, rule-following, research-shaped or drafting-shaped goes here. Name the agent; never say "AI" or "an agent" vaguely.
  2. Mica — operations work that genuinely needs a human: suppliers, contractors, tenants, anything physical or relationship-based.
  3. Ericamae — marketing and outreach work that genuinely needs a human.
- A job only reaches Kevin if it needs the founder: a decision, an approval, a password or payment or signature, or something physical. If it does not, hand it off and say where it went. Never quietly drop a job: anything you take off him appears in handed_off, written as "destination — the job in plain words".
- THE APPROVAL QUEUE COMES FIRST, and it is the one thing Kevin genuinely must do himself. The WAITING ON KEVIN'S TICK block lists work an agent has ALREADY FINISHED, with the words already written. It needs one tap in Slack, not ten minutes of writing. So: never make the first step "write", "draft" or "spend N minutes on" anything that appears in that block — say "approve" and name it. Never put a job in handed_off that dispatches an agent to redo something already sitting there; that produces the same work twice and Kevin approves it twice. If that block is not empty, clearing it is a strong candidate for today's one thing, because until he taps, nothing was actually sent.
- Triage doctrine: genuine urgency first (a real deadline WITH a real consequence — most "urgent" labels fail this test); otherwise project work that advances the QUARTER goals; everything else is ignored, batched or delegated.
- Max TWO board flags, one line each, only when a lane genuinely triggers: Crabtree (cash/labour), Michalowicz (Profit First discipline), Hormozi (offer/leads), Jenyns (should be a system/agent), Martell (AI should do this, not Kevin), Peters (overwhelm/energy — may pause the plan), Keller (this is scatter, refocus).
- The money traffic light is provided — respect it. Red or amber changes what today's one thing can be.
- NEVER treat a marketing email as a deadline. Tasks named "INBOUND: ..." are auto-created from Kevin's inbox and INCLUDE NEWSLETTERS AND PROMOTIONS. A scary subject line ("31st July S21 Deadline", "Action required", a warning emoji) from a newsletter, no-reply, marketing or notifications sender is CONTENT, not a commitment. Before calling anything urgent, ask: is there a named counterparty who is owed something by a date, with a real consequence if it is missed? A supplier chasing money, a court date, a compliance certificate expiring, a client promise: those are real. An industry newsletter warning the whole market about a rule change is not, and never becomes Kevin's one thing. If the task body shows the sender is a newsletter or no-reply address, put it in the ignore list and say it is marketing.
${env.PERSONA_CONTEXT ? '\nFOUNDER CONTEXT (private, never echo verbatim). Background on Kevin only. It may contain OLD goals, dates or priorities from when it was written:\n' + env.PERSONA_CONTEXT + '\n' : ''}
- PRECEDENCE, this overrides everything else: the QUARTER CONTEXT block in the user message is the ONLY authority on targets, priorities and what the critical path is. Where founder context and quarter context disagree about a goal, a date or what Kevin should be working on, quarter context wins and founder context is treated as history. Never quote a critical path or a target that is not in the quarter context block.
- LENGTH, this is a hard limit: at most 4 ignore items, at most 5 handed_off items, at most 2 flags. One short line each, no sub-clauses. one_thing, first_step, why and headline are one or two sentences each. A long answer gets cut off mid-sentence and Kevin sees nothing.
Respond ONLY with JSON: {"one_thing":"...","first_step":"...","why":"...","ignore":["...","..."],"handed_off":["worker-writer — draft the follow-up email to X"],"flags":["Persona: ..."],"headline":"one short sentence for the top of the message"}`;
    const user = `TODAY: ${todayLondonISO()} (${londonDateLabel()})

MONEY (live, from the Money Confidence engine):
Safe to act today: ${fmt(m.safeToActToday)} — light ${m.light.toUpperCase()}. ${m.headline}

QUARTER CONTEXT (the goals today must serve):
${env.QUARTER_CONTEXT || 'Q3 2026 ends 30 September. Theme: revenue for Operations Director. Targets reset 29 Jul 2026: 1 paying client by 30 Sep; 5 clients and about GBP2,000/month recurring by 31 Dec; GBP5,000/month by 30 Jun 2027. NOTHING gates outreach — build work runs in parallel and never blocks a prospect contact. The plan is 11 chunky tasks. Property: protect cash flow; year-end target £14,000/month operating cushion.'}

CALENDAR TODAY: ${calendar.connected ? '\n' + calendar.today : 'not connected yet'}

TASKS (live): ${tasks.counts.open} open, ${tasks.counts.overdue} overdue, ${tasks.counts.dueToday} due today, ${tasks.counts.kevins} carrying Kevin's name.
WAITING ON KEVIN'S TICK: ${tasks.counts.awaitingApproval} finished pieces of agent work sit in Status 'Approval', ${tasks.counts.awaitingSend} of them emails that SEND the moment he approves. This is DONE work, not work to do.
${tasks.approvalList || '(none)'}
OVERDUE (top):
${tasks.overdueList || '(none)'}
DUE TODAY:
${tasks.dueTodayList || '(none)'}
KEVIN'S OPEN TASKS (top):
${tasks.kevinList || '(none)'}

${huddleBlock}
Write today's brief.`;
    return { system, user };
}

// One attempt at the CEO call. Returns the raw parsed brief, or throws with the stop reason
// so the caller can tell "the model rambled past the ceiling" from "the proxy is down".
async function callCeoOnce(env, prompt) {
    const res = await env.PROXY.fetch(CLAUDE_PROXY, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.PROXY_TOKEN}`,
        },
        body: JSON.stringify({
            model: env.AI_MODEL_DEFAULT,
            // 900 truncated the JSON once handed_off was added (29 Jul: "CEO returned no JSON"
            // on every run — the closing brace never arrived). 1500 truncated it AGAIN on
            // 31 Jul at 4,869 chars. The ceiling is not the real fix on its own: the prompt
            // now caps list lengths too. This is headroom so a wordy day cannot silence the
            // brief, and a truncated reply is retried once below rather than lost.
            max_tokens: 3000,
            system: prompt.system,
            messages: [{ role: 'user', content: prompt.user }],
        }),
    });
    if (!res.ok) throw new Error('CEO proxy error ' + res.status + ': ' + (await res.text()).slice(0, 120));
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) throw new Error('CEO returned no JSON (stop=' + (data.stop_reason || '?') + ', ' + text.length + ' chars): ' + text.slice(-120));
    return JSON.parse(json[0]);
}

// Drop any hand-off that would dispatch an agent for a task already sitting in
// Approval. Matched on the distinctive words of the waiting task's name rather
// than the whole string: the brief writes "draft a warm re-opener for Jack
// Duddy" where the task is "Warm lane: re-engage Jack Duddy", so a substring
// test on the full name never fires. Two or more shared distinctive words is the
// bar — one ("draft") would strip half the list.
const HANDOFF_STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with', 'from',
    'draft', 'drafting', 'write', 'send', 'email', 'message', 'task', 'lane',
    'worker', 'writer', 'builder', 'researcher', 'analyst', 'auditor', 'agent',
]);
function distinctiveWords(text) {
    return new Set(String(text || '').toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !HANDOFF_STOPWORDS.has(w)));
}
function dropAlreadyWaiting(handedOff, tasks) {
    const waiting = (tasks && tasks.approvalNames) || [];
    if (!waiting.length) return handedOff;
    const waitingWords = waiting.map(distinctiveWords);
    return handedOff.filter(item => {
        const words = distinctiveWords(item);
        return !waitingWords.some(w => {
            let shared = 0;
            for (const word of w) if (words.has(word)) shared++;
            return shared >= 2;
        });
    });
}

async function callCeo(env, prompt, huddle, tasks) {
    let b;
    try {
        b = await callCeoOnce(env, prompt);
    } catch (err) {
        // A truncated or unparseable reply is recoverable: ask again, much shorter. A proxy
        // error (down, auth, rate limit) fails the same way twice, so do not burn a second call.
        if (String(err.message).startsWith('CEO proxy error')) throw err;
        const terse = {
            system: prompt.system,
            user: prompt.user + '\n\nYOUR LAST REPLY WAS CUT OFF BEFORE THE JSON CLOSED. Answer again, much shorter: one sentence per field, at most 2 ignore items, at most 3 handed_off items, at most 1 flag. Close the JSON.',
        };
        b = await callCeoOnce(env, terse);
    }
    if (!b.one_thing || !b.first_step) throw new Error('CEO JSON missing required fields');
    b.ignore = Array.isArray(b.ignore) ? b.ignore.slice(0, 4) : [];
    b.flags = Array.isArray(b.flags) ? b.flags.slice(0, 2) : [];
    // handed_off is optional: an older brief, or a genuinely quiet day, has nothing to route.
    b.handed_off = Array.isArray(b.handed_off) ? b.handed_off.slice(0, 5) : [];
    // The 07:30 huddle's dispatches lead, then the CEO's own. Deduped, one list, so the Slack
    // message and the stored record can never disagree about what was taken off Kevin.
    b.handed_off = [...new Set([...(huddle && huddle.handedOff || []), ...b.handed_off])].slice(0, 8);
    // A prompt rule is a request; this is the control. Nothing may dispatch an
    // agent to redo work that is already finished and waiting on Kevin's tick —
    // that produces the same email twice and he approves it twice. The prompt
    // asked for it on 11 Aug and the model handed off 'worker-writer — draft a
    // warm re-opener message for Jack Duddy' while the finished, addressed email
    // sat in Approval.
    b.handed_off = dropAlreadyWaiting(b.handed_off, tasks);
    return b;
}

async function storeBrief(pat, brief, m, tasks, huddle) {
    // Field IDs, not names — see the F.ceo* block. typecast is deliberately OFF:
    // with it on, a Money Light value that stopped matching the three choices
    // (green | amber | red) would quietly create a NEW choice instead of failing.
    // Off, Airtable rejects it, the caller's catch fires alertFailure, and the
    // Slack DM has already gone out — so a loud failure costs nothing.
    const body = {
        records: [{ fields: {
            [F.ceoDate]:        todayLondonISO(),
            [F.ceoOneThing]:    brief.one_thing.slice(0, 250),
            [F.ceoFirstStep]:   brief.first_step.slice(0, 250),
            [F.ceoWhy]:         brief.why || '',
            [F.ceoIgnoreToday]: brief.ignore.join('\n'),
            [F.ceoBoardFlags]:  brief.flags.join('\n'),
            [F.ceoHandedOff]:   brief.handed_off.join('\n'),
            [F.ceoMoneyLight]:  m.light,
            [F.ceoSafeToAct]:   Number(m.safeToActToday.toFixed(2)),
            [F.ceoFullBrief]:   JSON.stringify(brief),
            [F.ceoSourceStats]: JSON.stringify(tasks.counts),
        } }],
    };
    // Upsert. The 07:30 huddle already created today's record; a second POST would give Kevin
    // two briefs for one day and break the CEO Brief tab's read of the latest record.
    const usePatch = Boolean(huddle && huddle.recordId);
    const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TBL_BRIEFS}`, {
        method: usePatch ? 'PATCH' : 'POST',
        headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
        body: usePatch
            ? JSON.stringify({ records: [{ id: huddle.recordId, fields: body.records[0].fields }] })
            : JSON.stringify(body),
    });
    if (!r.ok) throw new Error('Brief store failed ' + r.status);
}

// ── Slack ────────────────────────────────────────────────────────────────────
const fmt = n => '£' + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const LIGHT_EMOJI = { green: '🟢', amber: '🟡', red: '🔴' };
const LIGHT_LABEL = { green: 'GREEN', amber: 'AMBER', red: 'RED' };

function londonDateLabel() {
    return new Intl.DateTimeFormat('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London',
    }).format(new Date());
}

function buildBlocks(m) {
    const emoji = LIGHT_EMOJI[m.light];
    const label = LIGHT_LABEL[m.light];
    return [
        { type: 'header', text: { type: 'plain_text', text: `${emoji} Safe to act today: ${fmt(m.safeToActToday)}`, emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${label}* — ${m.headline}` } },
        {
            type: 'context',
            elements: [{
                type: 'mrkdwn',
                text: `${londonDateLabel()} · 09:30 · cash-in-hand figure, recomputed live · full breakdown on the Money tab`,
            }],
        },
    ];
}

async function slackLookup(token, email) {
    const r = await fetch('https://slack.com/api/users.lookupByEmail?email=' + encodeURIComponent(email),
        { headers: { Authorization: 'Bearer ' + token } });
    const d = await r.json();
    if (!d.ok) throw new Error('Slack lookup failed: ' + d.error);
    return d.user.id;
}

async function slackPost(token, channel, text, blocks) {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, text, blocks }),
    });
    const d = await r.json();
    if (!d.ok) throw new Error('Slack post failed: ' + d.error);
    return d;
}

// The 09:00 CEO brief blocks. Money line included so ONE message covers the morning.
function buildBriefBlocks(m, brief) {
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: `☀️ ${brief.headline || 'Your day, decided.'}`, emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `*THE ONE THING*\n${brief.one_thing}\n\n*Start here (10 min):* ${brief.first_step}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Why this wins today:* ${brief.why || ''}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `${LIGHT_EMOJI[m.light]} *Safe to act today: ${fmt(m.safeToActToday)}* (${LIGHT_LABEL[m.light]})` } },
    ];
    if (brief.ignore.length) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Ignore today:* ${brief.ignore.join(' · ')}` } });
    }
    if (brief.handed_off.length) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn',
            text: `*Not yours today, handed off:*\n${brief.handed_off.map(h => `• ${h}`).join('\n')}` } });
    }
    for (const f of brief.flags) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `⚑ ${f}` } });
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn',
        text: `${londonDateLabel()} · 09:00 CEO brief · reply here to talk it through · history on the CEO Brief tab` }] });
    return blocks;
}

async function sendDailyDM(env) {
    const token = env.SLACK_BOT_TOKEN;
    const pat = env.AIRTABLE_PAT;
    if (!token) throw new Error('SLACK_BOT_TOKEN not configured');
    if (!pat) throw new Error('AIRTABLE_PAT not configured');
    const recipient = env.RECIPIENT_EMAIL || DEFAULT_RECIPIENT;

    const userId = await slackLookup(token, recipient);
    const m = await loadAndCompute(pat);

    // CEO layer — any failure here falls back to the proven money-only DM.
    try {
        const [tasks, calendar, huddle] = await Promise.all([gatherTasks(pat), gatherCalendar(env), gatherHuddle(pat)]);
        const brief = await callCeo(env, buildCeoPrompt(m, tasks, calendar, env, huddle), huddle, tasks);
        const fallbackText = `ONE thing: ${brief.one_thing} | Safe to act: ${fmt(m.safeToActToday)} (${LIGHT_LABEL[m.light]})`;
        await slackPost(token, userId, fallbackText, buildBriefBlocks(m, brief));
        try { await storeBrief(pat, brief, m, tasks, huddle); }
        catch (e) { await alertFailure(env, new Error('Brief sent but NOT stored: ' + e.message)); }
        return m;
    } catch (ceoErr) {
        const fallback = `Safe to act today: ${fmt(m.safeToActToday)} (${LIGHT_LABEL[m.light]})`;
        await slackPost(token, userId, fallback, buildBlocks(m));
        await alertFailure(env, new Error('CEO brief failed (money DM sent as fallback): ' + ceoErr.message));
        return m;
    }
}

// Best-effort failure alert so a broken feed never fails silently.
async function alertFailure(env, err) {
    try {
        const token = env.SLACK_BOT_TOKEN;
        if (!token) return;
        const userId = await slackLookup(token, env.RECIPIENT_EMAIL || DEFAULT_RECIPIENT);
        await slackPost(token, userId,
            'Money Confidence: could not compute today’s figure',
            [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *Money Confidence* could not compute today’s figure.\nReason: ${String(err && err.message || err).slice(0, 300)}\n\nOpen the Money tab in the app to check manually.` } }]);
    } catch (_) { /* nothing more we can do */ }
}

// True during the WEEKDAY morning window in which a CEO brief may be sent,
// 09:00–11:59 Europe/London, whichever UTC cron fired it.
//
// This used to be `hour === 9 && minute <= 10` — a single ten-minute slot. That
// made the trigger TIME-shaped, and it had no redundancy: exactly one of the two
// crons can pass on any given day (BST: the 08:00 UTC one; GMT: the 09:00 UTC
// one), so ONE missed or >10-minutes-late firing meant no brief at all, silently.
// `alertFailure` only fires on a thrown error, and an early return throws nothing.
// That is exactly what happened on Fri 7 Aug 2026: no brief, no alarm, caught only
// because the separate ceo-brief-morning-check routine went looking.
//
// The window is now wide and the DEDUPLICATION lives in alreadyBriefedToday()
// below — the question that matters is not "is it 09:00 now?" but "does today's
// brief exist yet?". A late cron is harmless and a missed one is recovered by the
// next firing.
//
// The weekday half was missing until 3 Aug 2026. The header said Mon–Fri but the
// code only checked the hour, so Sunday 2 Aug 2026 produced a brief.
//
// Both the day AND the hour must be read in Europe/London, never from the
// runtime's own clock: at 09:00 London on a Monday in GMT it is still Sunday
// 09:00 UTC nowhere, but a naive getDay() on a UTC Date is one timezone away
// from being wrong on every boundary. Deriving the day from the en-CA date
// string keeps it locale-independent too — no reliance on how a runtime spells
// "Sat".
function isLondonSendTime(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', hour: 'numeric', hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find(p => p.type === 'hour').value);

    const londonYMD = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(now);
    const londonDay = new Date(`${londonYMD}T00:00:00Z`).getUTCDay(); // 0 = Sun … 6 = Sat
    const isWeekday = londonDay >= 1 && londonDay <= 5;

    return isWeekday && hour >= 9 && hour <= 11;
}

// Has today's brief already gone out? This is the idempotency half of the fix
// above: the window lets several firings through, and this is what stops Kevin
// getting three briefs a morning.
//
// Reads today's CEO Briefs row and treats a populated `Full Brief` as "sent" —
// the same field the CEO Brief tab reads, and the last thing storeBrief writes.
// The 07:30 huddle creates a STUB row with no Full Brief, so "a row exists" is
// deliberately NOT the test; it would suppress the brief every single day.
//
// On any read failure this returns FALSE, i.e. "go ahead and send". That
// direction is chosen on purpose: if Airtable is unreachable we cannot know, and
// a duplicate brief is a minor annoyance whereas a missing one is the entire bug
// this change exists to fix. Never flip this to fail-closed.
async function alreadyBriefedToday(pat) {
    try {
        const today = todayLondonISO();
        // returnFieldsByFieldId is NOT optional — see the note in gatherHuddle().
        // Without it the response is keyed by field NAME, getField returns
        // undefined for every row, and this would report "not sent" every day,
        // silently restoring the duplicate-brief behaviour.
        const url = `https://api.airtable.com/v0/${BASE_ID}/${TBL_BRIEFS}`
            + `?returnFieldsByFieldId=true&maxRecords=5`
            + `&filterByFormula=${encodeURIComponent(`DATESTR({Date})='${today}'`)}`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${pat}` } });
        if (!r.ok) return false;
        const records = (await r.json()).records || [];
        return records.some(x => String(getField(x, F.ceoFullBrief) || '').trim() !== '');
    } catch { return false; }
}

export default {
    async scheduled(event, env, ctx) {
        if (!isLondonSendTime(new Date(event.scheduledTime))) return; // outside the London weekday window
        ctx.waitUntil((async () => {
            try {
                // State-shaped, not time-shaped: several firings land inside the
                // window and the FIRST one that finds today's brief missing sends
                // it. Checked inside waitUntil so a slow Airtable read cannot make
                // the handler itself time out.
                if (await alreadyBriefedToday(env.AIRTABLE_PAT)) return;
                await sendDailyDM(env);
            }
            catch (err) { await alertFailure(env, err); throw err; }
        })());
    },

    // Manual test endpoint (guarded). Never expose financial data publicly.
    //   /?mode=compute&key=KEY  → JSON of the computed figure, no Slack
    //   /?mode=send&key=KEY     → computes AND sends the DM (ignores DST gate)
    async fetch(request, env) {
        const url = new URL(request.url);
        const key = url.searchParams.get('key');
        if (!env.TRIGGER_KEY || key !== env.TRIGGER_KEY) {
            return new Response('Forbidden', { status: 403 });
        }
        try {
            if (url.searchParams.get('mode') === 'send') {
                const m = await sendDailyDM(env);
                return Response.json({ ok: true, sent: true, safeToActToday: m.safeToActToday, light: m.light });
            }
            // mode=brief → compute the full CEO brief WITHOUT sending or storing.
            if (url.searchParams.get('mode') === 'brief') {
                const m = await loadAndCompute(env.AIRTABLE_PAT);
                const [tasks, calendar] = await Promise.all([gatherTasks(env.AIRTABLE_PAT), gatherCalendar(env)]);
                const huddle = await gatherHuddle(env.AIRTABLE_PAT);
                const brief = await callCeo(env, buildCeoPrompt(m, tasks, calendar, env, huddle), huddle, tasks);
                return Response.json({ ok: true, brief, money: { safeToActToday: m.safeToActToday, light: m.light }, taskCounts: tasks.counts, calendarConnected: calendar.connected });
            }
            const m = await loadAndCompute(env.AIRTABLE_PAT);
            return Response.json({ ok: true, ...m });
        } catch (err) {
            return Response.json({ ok: false, error: String(err && err.message || err) }, { status: 500 });
        }
    },
};
