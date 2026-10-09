// ── Home: the one list (Kevin, 29 Sep 2026) ──
// Brain ruling: Decisions/2026-09-29 Home screen is one list, hide before build, every new panel
// replaces one. Everything that needs Kevin today in ONE list, money and deadlines first, with
// the Leadership Dashboard underneath (js/home.js shows the real tab-overview panel, never a copy).
//
// The pick rules are the 09:00 brief's, copied from scripts/slack-automation/money-daily-worker.js
// (gatherTasks, selectDeadlines, deadlineHolder, selectOnlyYou, needsYouText, tenantChainText).
// Copied, not shared, because Kevin ruled the brief worker stays untouched while Home is on trial;
// tests/home-list.test.js runs both copies on the same tasks and fails if they ever pick
// differently. Differences on purpose: 14 days of deadlines (the brief shows 7), no "+N more"
// caps (a page has room; Slack does not), and approval cards and robot blockers added.
//
// Pure functions only, no DOM and no fetch, so vitest can load this file (module.exports below).
(function (root) {
    'use strict';

    const KEVIN_TEAM_MEMBER = 'recHEt2VPYothaqTd';
    const ROY_TEAM_MEMBER = 'reclbdjfVev3bqNHS';
    const HOME_DEADLINE_DAYS = 14;
    // The approval queue is Kevin's lane only: an empty Approver or his address (os/agents/index.html
    // loadApprovals, js/shared.js refreshAgentsBadge). A card in anyone else's lane is not his to decide.
    const APPROVER_EMAIL = 'kevin@runpreneur.org.uk';

    // The same read as the brief's gatherTasks: every open task, by field NAME.
    const OPEN_TASKS_FORMULA = "AND({Task Name}!='',NOT({Status}='Completed'),NOT({Status}='Cancelled'))";
    const TASK_FIELDS = ['Task Name', 'Assignee', 'Due Date', 'Status', 'Priority', 'Task Type',
        'Deferred Until', 'Team Member', 'Hard Deadline', 'Sent For Approval By', 'Some Day', 'Approver'];
    const ESTATE_KEYS = { needsYou: 'daily-ops-needs-you', blockers: 'agent-blockers', tenants: 'tenant-chain', rent: 'rent-position' };

    const LEGAL_RE = /\b(court|charging order|ccj|tribunal|solicitors?|claim form|bailiffs?|enforcement|hmrc|companies ?house|strike ?off|liquidat\w*|insolven\w*|bankrupt\w*|restraint|statutory demand|notice|summons|writ|legal)\b/i;
    const MONEY_RE = /\b(pay|payments?|arrears|minimum|debt|invoice|direct debit|standing order|mortgage|loan|fine|refund|gbp)\b|£/i;
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // One Airtable record into the brief's task shape (money-daily-worker.js gatherTasks).
    function toTask(rec) {
        const f = (rec && rec.fields) || {};
        return {
            id: rec.id,
            hard: Boolean(f['Hard Deadline']),
            inQueue: String(f['Status'] || '') === 'Approval'
                && Array.isArray(f['Sent For Approval By']) && f['Sent For Approval By'].length > 0,
            someDay: Boolean(f['Some Day']),
            name: String(f['Task Name'] || '').slice(0, 90),
            holders: Array.isArray(f['Team Member']) ? f['Team Member'] : [],
            who: (f['Assignee'] && f['Assignee'].name) || 'unassigned',
            due: (f['Due Date'] || '').slice(0, 10),
            status: String(f['Status'] || ''),
            priority: String(f['Priority'] || ''),
            type: String(f['Task Type'] || ''),
            deferred: String(f['Deferred Until'] || '').slice(0, 10),
            approverEmail: (f['Approver'] && f['Approver'].email) || '',
        };
    }

    function addDaysISO(iso, n) {
        const d = new Date(`${iso}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
    }
    function dayMonth(d) {
        return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
    }
    function whenText(d, today) {
        if (!d) return 'no date';
        if (d === today) return 'due today';
        return d < today ? `overdue since ${dayMonth(d)}` : `due ${dayMonth(d)}`;
    }
    function londonToday(now) {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })
            .format(now || new Date());
    }

    function deadlineHolder(x) {
        if (x.answered) return 'answered, going back to its agent';
        if (x.inQueue) return 'waiting in your approval queue';
        const holders = x.holders || [];
        if (holders.includes(KEVIN_TEAM_MEMBER)) return 'yours';
        if (holders.includes(ROY_TEAM_MEMBER)) return 'with Roy';
        if (holders.length) return 'with an AI agent';
        if (x.who && x.who !== 'unassigned') return `with ${x.who}`;
        return 'NO OWNER';
    }
    const kindOf = name => (LEGAL_RE.test(name) ? 0 : MONEY_RE.test(name) ? 1 : 2);

    // The brief's selectDeadlines with the window as a parameter.
    function selectDeadlines(tasks, today, days) {
        const horizon = addDaysISO(today, days === undefined ? HOME_DEADLINE_DAYS : days);
        const all = (tasks || [])
            .filter(x => x.hard && x.due && x.due <= horizon)
            .filter(x => !(x.deferred && x.deferred > today))
            .filter(x => !/^UC verification:/i.test(x.name))
            .map(x => ({ id: x.id, name: x.name, due: x.due, who: deadlineHolder(x), kind: kindOf(x.name), inQueue: x.inQueue }))
            .sort((a, b) => ((a.due > today) - (b.due > today)) || (a.kind - b.kind)
                || a.due.localeCompare(b.due) || a.name.localeCompare(b.name));
        // The CONTROL: how many open tasks carry the tick at all. Zero means the tick has stopped
        // being written or read, and an empty list would then read as a calm fortnight for ever.
        const ticked = (tasks || []).filter(x => x.hard).length;
        return { all, ticked };
    }

    function isOnlyYouName(name) {
        return !/\b(chase|chasing)\b|\brent payments?\b|\bUC payment|adobe sign|email signature|\bsign\b[^.]{0,40}\binto\b/i.test(name) && (
            /standing order|direct debit|docusign|\bbank (details|account|transfer|change)|\bbanking\b|\bpay\b|\bpayments?\b|\bsignatures?\b|\b(counter)?sign(ing)?\b(?![\s-]*(in|into|up|out)\b)/i.test(name)
            || /\bSO\b(?=\s*(?:[-–£]|amount\b|for\b))/.test(name));
    }
    // The brief's selectOnlyYou without the five-item cap.
    function selectOnlyYou(tasks, today, shown) {
        return (tasks || [])
            .filter(x => (x.holders || []).includes(KEVIN_TEAM_MEMBER))
            .filter(x => x.due && x.due <= today && !(x.deferred && x.deferred > today) && !x.someDay)
            .filter(x => !x.inQueue || isOnlyYouName(x.name))
            .filter(x => !x.answered)
            .filter(x => !(shown && shown.has(x.id)))
            .sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name))
            .map(x => ({ id: x.id, name: x.name, due: x.due, inQueue: x.inQueue }));
    }

    // The approval queue exactly as the AI Agents page counts it (os/agents/index.html
    // APV_QUEUE_FORMULA): Approval, raised by the loop, not knocked back to a later date, and not a
    // Your step card he has answered (`answered`, set by js/home.js from the queue read, 9 Oct 2026).
    const isKevinsLane = email => !email || email === APPROVER_EMAIL;
    function queueCards(tasks, today) {
        return (tasks || []).filter(x => x.inQueue && !x.answered && !(x.deferred && x.deferred > today) && isKevinsLane(x.approverEmail));
    }

    function parsePayload(row) {
        if (row === undefined) return { state: 'unread' };
        if (!row) return { state: 'missing' };
        try { return { state: 'ok', p: JSON.parse((row.fields && row.fields.Payload) || 'null') }; }
        catch (e) { return { state: 'damaged' }; }
    }

    // The brief's needsYouText, as data. note is set whenever the list cannot be trusted.
    function readNeedsYou(row, today) {
        const r = parsePayload(row);
        if (r.state === 'unread') return { items: [], note: 'The 07:00 check could not be read.' };
        if (r.state === 'damaged') return { items: [], note: 'The 07:00 check left a damaged row, so its list for you could not be read. It is in the morning report.' };
        const p = r.p;
        // A run still in progress is not a run that failed to report. estate-status.py
        // needs_you_row() sets running:true while daily-ops is mid-flight, and Home read
        // straight past it, so the 07:00 check read as absent at 07:05 every morning
        // (finding 20261002-queue-fixer-707). Checked BEFORE the date tests, because a
        // running row carries yesterday's date, or none at all.
        if (p && p.running) return { items: [], note: 'The 07:00 check is still running. Its list for you will follow.' };
        if (!p || !p.date) return { items: [], note: 'The 07:00 check has not reported yet.' };
        if (p.date !== today) return { items: [], note: `The 07:00 check has not reported today. Its last report was ${dayMonth(p.date)}.` };
        if (p.unreadable) return { items: [], note: 'The 07:00 check ran, but its list for you could not be read. It is in the morning report.' };
        const items = Array.isArray(p.items) ? p.items.map(x => String(x).slice(0, 400)) : [];
        return { items, note: '' };
    }

    // Robots stuck on Kevin, from the blocker sweep (scripts/estate-status.py blockers_summary): a TOOL
    // wall no fixer can reach. A TOOL wall that is not deferred is the daily robot fix's job, not
    // Kevin's, so it is left out. A sign-in, a site to add and a step only he can take are approval
    // cards since 8 Oct 2026 (Kevin: "I can just work through the approval cards as standard"), listed
    // under "Waiting for your approval" on this page, so they are not named twice here.
    const BLOCKER_STALE_MS = 2 * 60 * 60 * 1000;
    function readBlockers(row, now) {
        const r = parsePayload(row);
        if (r.state === 'unread') return { items: [], note: 'The robot blocker check could not be read.' };
        if (r.state === 'missing') return { items: [], note: 'The robot blocker check has never reported.' };
        if (r.state === 'damaged' || !r.p || !Array.isArray(r.p.open)) {
            const why = row && row.fields && row.fields.Detail ? ` It says: ${String(row.fields.Detail).slice(0, 200)}` : '';
            return { items: [], note: `The robot blocker check left no list.${why}` };
        }
        // The sweep could not read the task board: an empty list here means "unknown", not "none".
        if (r.p.controlFailed) {
            const why = row.fields && row.fields.Detail ? ` It says: ${String(row.fields.Detail).slice(0, 200)}` : '';
            return { items: [], note: `The robot blocker check could not read the task board, so it cannot say what is stuck.${why}` };
        }
        const walls = r.p.open;
        const items = [];
        // A TOOL wall no fixer can reach (7 Oct 2026): its fix needs a protected file. The fixer
        // opens the PR and a MERGE card comes to Kevin; until the card exists, he is told why it
        // is stuck. A report written before then has no toolState: a deferred finding is that case.
        const NO_FIXER = ['no-fixer', 'no-finding', 'deferred', 'merge-rejected', 'merge-closed'];
        walls.filter(w => w.kind === 'TOOL' && (NO_FIXER.includes(w.toolState) || (!w.toolState && w.findingStatus === 'deferred')))
            .forEach(w => items.push({ kind: 'tool', id: w.task, count: 1,
                text: `${String(w.name || 'A task')}: ${String(w.tool || 'no fixer can reach it; the fixer opens the PR and a MERGE card comes to you')}`,
                days: Number(w.days) || 0 }));
        items.sort((a, b) => b.days - a.days || a.text.localeCompare(b.text));
        const swept = r.p.sweptAt ? new Date(r.p.sweptAt).getTime() : NaN;
        const note = isNaN(swept) ? '' : (now - swept > BLOCKER_STALE_MS
            ? `The robot blocker check last ran ${Math.round((now - swept) / 3600000)} hours ago, so this part may be out of date.` : '');
        return { items, note };
    }

    // The brief's tenantChainText, as data.
    function readTenants(row, today) {
        const r = parsePayload(row);
        if (r.state === 'unread') return { light: 'fail', current: false, text: 'The tenant chain could not be read.' };
        if (r.state === 'damaged') return { light: 'fail', current: false, text: 'The tenant chain left a damaged report, so nothing about it is known.' };
        const p = r.p;
        if (!p || !p.asAt) return { light: 'fail', current: false, text: 'The tenant chain has not reported.' };
        if (p.asAt !== today) return { light: 'fail', current: false, text: `The chain has not run today. Its last run was ${dayMonth(p.asAt)}, so nothing about it is current.` };
        const line = String(p.briefLine || '').slice(0, 700) || 'ran, but left no summary line.';
        return { light: ['ok', 'warn', 'fail'].includes(p.worst) ? p.worst : 'unknown', current: true, text: line };
    }

    // The daily rent check's line (scripts/rent-check.py, 2 Oct 2026): how many rents are up to date
    // and who is late. Same payload shape as the tenants line (asAt, worst, briefLine). Kept apart
    // from readTenants because that one is the brief's twin and must keep the brief's exact words.
    function readRent(row, today) {
        const r = parsePayload(row);
        if (r.state === 'unread') return { light: 'fail', current: false, text: 'The rent check could not be read.' };
        if (r.state === 'damaged') return { light: 'fail', current: false, text: 'The rent check left a damaged report, so nothing about rent is known.' };
        const p = r.p;
        if (!p || !p.asAt) return { light: 'fail', current: false, text: 'The rent check has not reported.' };
        if (p.asAt !== today) return { light: 'fail', current: false, text: `The rent check has not run today. Its last run was ${dayMonth(p.asAt)}, so nothing about rent is current.` };
        const line = String(p.briefLine || '').slice(0, 700) || 'ran, but left no summary line.';
        return { light: ['ok', 'warn', 'fail'].includes(p.worst) ? p.worst : 'unknown', current: true, text: line };
    }

    // The one list. Groups in reading order: money and deadlines first. A task shows once, in the
    // first group that holds it.
    function buildHomeList({ tasks, today, needsRow, blockersRow, now }) {
        const deadlines = selectDeadlines(tasks, today, HOME_DEADLINE_DAYS);
        const shown = new Set(deadlines.all.map(x => x.id));
        const dueNow = deadlines.all.filter(x => x.due <= today);
        const coming = deadlines.all.filter(x => x.due > today);
        const onlyYou = selectOnlyYou(tasks, today, shown);
        onlyYou.forEach(x => shown.add(x.id));
        const blockers = readBlockers(blockersRow, now || Date.now());
        blockers.items = blockers.items.filter(x => !(x.id && shown.has(x.id)));
        blockers.items.forEach(x => { if (x.id) shown.add(x.id); });
        const needsYou = readNeedsYou(needsRow, today);
        const queue = queueCards(tasks, today);
        const approve = queue.filter(x => !shown.has(x.id))
            .map(x => ({ id: x.id, name: x.name, due: x.due, type: x.type, kind: kindOf(x.name) }))
            .sort((a, b) => (a.kind - b.kind) || (a.due || '9999').localeCompare(b.due || '9999') || a.name.localeCompare(b.name));
        const groups = [
            { key: 'deadlines-now', title: 'Deadlines due now', items: dueNow.map(x => ({ tag: 'Deadline', id: x.id, name: x.name, when: whenText(x.due, today), who: x.who, inQueue: x.inQueue, legal: x.kind === 0 })) },
            { key: 'only-you', title: 'Only you', items: onlyYou.map(x => ({ tag: 'Only you', id: x.id, name: x.name, when: whenText(x.due, today), who: x.inQueue ? 'waiting in your approval queue' : 'yours', inQueue: x.inQueue })) },
            { key: 'robots', title: 'Robots stuck on you', note: blockers.note, items: blockers.items.map(x => ({ tag: 'Robot stuck', id: x.id || '', name: x.text, when: x.count > 1 ? `blocking ${x.count} tasks` : (x.days >= 1 ? `stuck ${Math.floor(x.days)} day${Math.floor(x.days) === 1 ? '' : 's'}` : 'stuck today'), who: '' })) },
            { key: 'needs-you', title: 'From the 07:00 check', note: needsYou.note, items: needsYou.items.map(t => ({ tag: '07:00 check', id: '', name: t, when: '', who: '' })) },
            { key: 'deadlines-coming', title: `Deadlines in the next ${HOME_DEADLINE_DAYS} days`, items: coming.map(x => ({ tag: 'Deadline', id: x.id, name: x.name, when: whenText(x.due, today), who: x.who, inQueue: x.inQueue, legal: x.kind === 0 })) },
            { key: 'approve', title: 'Waiting for your approval', items: approve.map(x => ({ tag: x.kind === 0 ? 'Approve · legal' : x.kind === 1 ? 'Approve · money' : 'Approve', legal: x.kind === 0, id: x.id, name: x.name, when: x.due ? `waiting since ${dayMonth(x.due)}` : '', who: x.type === 'Correspondence' ? 'approving sends the email' : '', inQueue: true })) },
        ];
        // Parts that could not be checked, so an empty list is never read as "nothing needs you".
        const unchecked = groups.filter(g => g.note).map(g => g.title);
        if (!deadlines.ticked) unchecked.unshift('Deadlines (no open task carries the Hard Deadline tick)');
        return {
            groups,
            unchecked,
            ticked: deadlines.ticked,
            counts: {
                deadlines: deadlines.all.length, deadlinesDueNow: dueNow.length, onlyYou: onlyYou.length,
                robots: blockers.items.length, needsYou: needsYou.items.length, approve: approve.length,
                queue: queue.length, total: groups.reduce((n, g) => n + g.items.length, 0),
            },
        };
    }

    const api = {
        KEVIN_TEAM_MEMBER, ROY_TEAM_MEMBER, APPROVER_EMAIL, isKevinsLane, HOME_DEADLINE_DAYS, OPEN_TASKS_FORMULA, TASK_FIELDS, ESTATE_KEYS,
        LEGAL_RE, MONEY_RE, toTask, addDaysISO, dayMonth, whenText, londonToday, deadlineHolder,
        selectDeadlines, isOnlyYouName, selectOnlyYou, queueCards, readNeedsYou, readBlockers, readTenants, readRent,
        buildHomeList,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.HomeList = api;
})(typeof window !== 'undefined' ? window : globalThis);
