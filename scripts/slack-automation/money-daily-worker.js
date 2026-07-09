// money-confidence-daily — Slack DM of the "Safe to act today" figure.
//
// Cron: Mon–Fri 09:30 Europe/London. Recomputes the figure LIVE from Airtable
// at send time (never a cached value), then DMs Kevin so he has it on his phone
// before he opens the laptop.
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
};
const REC = {
    santander:    'rec3LiEiifomEHlvy',
    tntZempler:   'recsR9QhRKYwgV8oP',
    subRentalInc: 'recI8yCstyDP1Nd4b',
};

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
async function airtableFetch(pat, tableId, params = {}) {
    const records = [];
    let offset = null;
    do {
        const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
        url.searchParams.set('returnFieldsByFieldId', 'true');
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

async function sendDailyDM(env) {
    const token = env.SLACK_BOT_TOKEN;
    const pat = env.AIRTABLE_PAT;
    if (!token) throw new Error('SLACK_BOT_TOKEN not configured');
    if (!pat) throw new Error('AIRTABLE_PAT not configured');
    const recipient = env.RECIPIENT_EMAIL || DEFAULT_RECIPIENT;

    const userId = await slackLookup(token, recipient);
    const m = await loadAndCompute(pat);
    const fallback = `Safe to act today: ${fmt(m.safeToActToday)} (${LIGHT_LABEL[m.light]})`;
    await slackPost(token, userId, fallback, buildBlocks(m));
    return m;
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

// True only at the 09:30 Europe/London firing, whichever UTC cron fired it.
// Two UTC crons (08:30 + 09:30) cover BST and GMT; this gate lets exactly one
// through per day.
function isLondonSendTime(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', hour: 'numeric', minute: 'numeric', hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find(p => p.type === 'hour').value);
    const minute = Number(parts.find(p => p.type === 'minute').value);
    return hour === 9 && minute >= 25 && minute <= 35;
}

export default {
    async scheduled(event, env, ctx) {
        if (!isLondonSendTime(new Date(event.scheduledTime))) return; // wrong DST firing
        ctx.waitUntil((async () => {
            try { await sendDailyDM(env); }
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
            const m = await loadAndCompute(env.AIRTABLE_PAT);
            return Response.json({ ok: true, ...m });
        } catch (err) {
            return Response.json({ ok: false, error: String(err && err.message || err) }, { status: 500 });
        }
    },
};
