// ═════════════════════════════════════════════════════════════════════
// PROJECT UPDATE — the dated line each open project carries: what moved
// since the last update, or that nothing did.
//
// Kevin, 10 Oct 2026 ("Resume it now"): the projects overview's last missing
// piece. Written each morning by scripts/sync-project-status.mjs (the 06:45
// job), by rule and never by an AI model, so it cannot invent progress. The
// Leadership Dashboard shows the stored line and flags it when it goes stale.
//
// A trust surface reports absence: a day with no movement says "nothing moved
// since <date>", never a blank or a repeat of yesterday's good news.
//
// Pure: no DOM, no fetch. Node (the job and vitest) requires it; the browser
// does not need it.
// ═════════════════════════════════════════════════════════════════════
(function (root) {
    'use strict';

    const MAX_NAMES = 3;            // task names in one line; the rest is "+N more"

    function dayLabel(iso) {
        const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
        return isNaN(d) ? String(iso || '') : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    }

    // "£1,000", "3 units", or a bare number for the 'count' unit.
    function amount(n, unit) {
        const v = Number(n) || 0;
        const num = v.toLocaleString('en-GB', { maximumFractionDigits: 2 });
        if (unit === '£') return '£' + num;
        if (unit === '£ a month') return '£' + num + ' a month';
        if (!unit || unit === 'count') return num;
        if (unit === '%') return num + '%';
        return num + ' ' + unit;
    }

    function progress(now) {
        const kpi = now.kpiTarget > 0
            ? (now.kpiUnit === '£' || now.kpiUnit === '£ a month' || now.kpiUnit === '%'
                ? `${amount(now.kpi, now.kpiUnit)} of ${amount(now.kpiTarget, now.kpiUnit)}`
                : `${amount(now.kpi, '')} of ${amount(now.kpiTarget, now.kpiUnit)}`)
            : null;
        return `${kpi ? kpi + ', ' : ''}${now.done} of ${now.total} tasks done, ${now.status || 'no status'}`;
    }

    function names(tasks) {
        const list = tasks.map(t => { const n = String(t.name || '(unnamed task)').trim(); return n.length > 80 ? n.slice(0, 79).trimEnd() + '…' : n; });
        const shown = list.slice(0, MAX_NAMES).join('; ');
        return list.length > MAX_NAMES ? `${shown} (+${list.length - MAX_NAMES} more)` : shown;
    }

    // prev:   the stored snapshot { kpi, done, total, status, at, movedAt } or null (first run)
    // now:    { kpi, kpiTarget, kpiUnit, done, total, status }
    // completed: tasks completed since prev.at (or since the project's start on the first run),
    //         [{ name, completedAt }]
    // today:  'YYYY-MM-DD'; start: the project's start date, used on the first run
    // nowIso: the run's timestamp, stored so the next run counts only tasks completed after it
    // Returns { line, state, moved }. Pass `prev` through baseline() first: a second run on the
    // same day compares with the snapshot from BEFORE today's first run, never with it.
    function buildProjectUpdate({ prev, now, completed, today, start, nowIso }) {
        const date = dayLabel(today);
        const stamp = nowIso || today;
        const base = prev || null;
        const done = completed || [];
        const tail = progress(now);
        if (!prev) {
            const since = dayLabel(start || today);
            const what = done.length ? `Completed since ${since}: ${names(done)}` : `Nothing completed since ${since}`;
            return { line: `${date}: first update. ${what}. Now ${tail}.`.replace(/…\./g, '…'), moved: done.length > 0,
                state: { kpi: now.kpi, done: now.done, total: now.total, status: now.status, at: today, atIso: stamp, movedAt: today, base } };
        }
        const moves = [];
        if (Number(prev.kpi) !== Number(now.kpi)) moves.push(`KPI ${amount(prev.kpi, now.kpiUnit === 'count' ? '' : now.kpiUnit)} → ${amount(now.kpi, now.kpiUnit === 'count' ? '' : now.kpiUnit)}`);
        if (done.length) moves.push(`Completed: ${names(done)}`);
        // The count says more than the names when tasks were done with no Completion Date, or one
        // was re-opened while another finished: say the count too, so nothing hides behind a name.
        const delta = Number(now.done) - Number(prev.done);
        if (delta !== done.length) moves.push(delta === 0 ? `Tasks done still ${now.done}` : `Tasks done ${prev.done} → ${now.done}`);
        if (Number(prev.total) !== Number(now.total)) moves.push(`Tasks on the project ${prev.total} → ${now.total}`);
        if ((prev.status || '') !== (now.status || '')) moves.push(`Status ${prev.status || 'none'} → ${now.status || 'none'}`);
        const moved = moves.length > 0;
        const strip = s => s && { kpi: s.kpi, done: s.done, total: s.total, status: s.status, at: s.at, atIso: s.atIso, movedAt: s.movedAt };
        const state = { kpi: now.kpi, done: now.done, total: now.total, status: now.status, at: today, atIso: stamp,
            movedAt: moved ? today : (prev.movedAt || prev.at || today), base: strip(base) };
        const line = moved
            ? `${date}: ${moves.join('. ')}. Now ${tail}.`
            : `${date}: nothing moved since ${dayLabel(state.movedAt)}. Still ${tail}.`;
        return { line: line.replace(/…\./g, '…'), state, moved };
    }

    // The stored snapshot, or null when it is missing or unreadable (the next run starts afresh).
    function parseState(raw) {
        if (!raw) return null;
        try { const v = JSON.parse(raw); return v && typeof v === 'object' && v.at ? v : null; }
        catch (e) { return null; }
    }

    // The snapshot to compare against today: the stored one, or, when today's run already
    // wrote (a retry), the one it was compared against. null = a first update.
    function baseline(state, today) {
        if (!state) return null;
        if (state.at === today) return state.base && state.base.at ? state.base : null;
        return state;
    }

    // Which completed tasks belong in this update. After a previous update: completed after its
    // timestamp. On a first update: completed on or after the project's start, the start held
    // between `floor` (the look-back limit) and today, so a future start never reads as "since
    // 1 Jan". Never after `nowIso`, so a task finished mid-run waits for the next update instead
    // of being named twice. tasks: [{ name, completedAt (ISO) }]
    function selectCompleted({ tasks, prev, start, today, floor, nowIso }) {
        const startDay = String(start || '').slice(0, 10) || floor;
        const since = prev ? String(prev.atIso || prev.at) : [[startDay, today].sort()[0], floor].sort().pop();
        const completed = (tasks || [])
            .filter(t => t && t.completedAt && (!nowIso || t.completedAt <= nowIso)
                && (prev ? t.completedAt > since : t.completedAt.slice(0, 10) >= since))
            .sort((a, b) => a.completedAt.localeCompare(b.completedAt));
        return { since, completed };
    }

    const api = { buildProjectUpdate, parseState, baseline, selectCompleted, dayLabel };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ProjectUpdate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
