// ═════════════════════════════════════════════════════════════════════
// PROJECT HEALTH — the single source of truth for "is this project on track".
//
// One rule, used in three places: the Leadership Dashboard, the Tasks &
// Projects page, and scripts/sync-project-status.mjs (the daily job that
// writes the answer back to Airtable). It lives here so those three can
// never drift apart — the platform has been bitten by a ported copy of a
// calculation before (see tests/constant-drift.test.js).
//
// THE RULE. How far through the quarter are you, versus how far through the
// target? Not raw completion. A project three days into a 91-day quarter with
// nothing done is fine; the same project on day 85 is not.
//
//     timePct = days elapsed / project duration
//     progPct = KPI current / KPI target      (falls back to tasks done / tasks total)
//     ratio   = progPct / timePct
//
//     ratio >= 100%  → On-Target      keeping pace or ahead
//     ratio >=  85%  → On-Track       slightly behind, recoverable
//     otherwise      → Off-Track
//
// WHY THE STORED STATUS IS NOT CONSULTED (except Completed). Projects are
// created by the Strategy push with Airtable's default of "Not Started", and
// nothing used to change it. Five Q3 2026 projects sat at "Not Started" for 33
// days while the dashboard short-circuited on that value and never ran the
// calculation above — so a quarter that was genuinely off-track read as if it
// had not begun. Health is derived, so it cannot go stale. "Not Started" is a
// conclusion this function reaches from the dates (the first 5% of the
// quarter), never an input it trusts.
//
// Airtable's Project Status single-select accepts exactly these five strings.
// Returning anything else would make the daily job create a junk option.
// ═════════════════════════════════════════════════════════════════════

(function (root) {
    'use strict';

    const PROJECT_STATUSES = ['Not Started', 'Off-Track', 'On-Track', 'On-Target', 'Completed'];

    // Below this share of the quarter, a project with nothing done is not
    // behind — it has barely started. Without it every project would read
    // Off-Track on day one, which is the flaw in the legacy Airtable formula
    // this replaces (it compared raw completion against a flat 85%).
    const NOT_STARTED_TIME_PCT = 5;
    const ON_TARGET_RATIO = 100;
    const ON_TRACK_RATIO = 85;

    function toDay(value) {
        if (!value) return null;
        const d = new Date(String(value).slice(0, 10) + 'T00:00:00');
        return isNaN(d.getTime()) ? null : d;
    }

    /**
     * @param {object} p  { status, completed, start, end, kpiTarget, kpiCurrent,
     *                      totalTasks, completedTasks }
     * @param {Date|string} [now]  defaults to today; pass a date to test or to
     *                             evaluate a quarter as at a specific day.
     * @returns {string} one of PROJECT_STATUSES, or 'Unknown' when there is not
     *                   enough information to judge (missing dates, or no
     *                   measurable progress signal at all).
     */
    function computeProjectHealth(p, now) {
        p = p || {};
        // Completed is the one stored value worth trusting: it is an explicit
        // statement of fact, not a default left behind by the record's creation.
        if (p.completed || p.status === 'Completed') return 'Completed';

        const start = toDay(p.start);
        const end = toDay(p.end);
        if (!start || !end || end < start) return 'Unknown';

        const today = now ? (now instanceof Date ? new Date(now) : new Date(now)) : new Date();
        today.setHours(0, 0, 0, 0);

        // Past its end date and not marked complete — no ratio needed.
        if (end < today) return 'Off-Track';

        const total = end - start;
        const elapsed = Math.max(0, today - start);
        const timePct = total > 0 ? (elapsed / total) * 100 : 0;

        // Prefer the KPI, because that is what the project is actually for.
        // Tasks are the fallback for projects with no numeric target.
        let progPct = null;
        const kpiTarget = Number(p.kpiTarget) || 0;
        const kpiCurrent = Number(p.kpiCurrent) || 0;
        const totalTasks = Number(p.totalTasks) || 0;
        const completedTasks = Number(p.completedTasks) || 0;
        if (kpiTarget > 0 && kpiCurrent >= 0) progPct = (kpiCurrent / kpiTarget) * 100;
        else if (totalTasks > 0) progPct = (completedTasks / totalTasks) * 100;

        // Nothing measurable at all — say so rather than guess a health.
        if (progPct === null) return timePct < NOT_STARTED_TIME_PCT ? 'Not Started' : 'Unknown';

        if (timePct < NOT_STARTED_TIME_PCT) return 'Not Started';

        const ratio = timePct > 0 ? (progPct / timePct) * 100 : 100;
        if (ratio >= ON_TARGET_RATIO) return 'On-Target';
        if (ratio >= ON_TRACK_RATIO) return 'On-Track';
        return 'Off-Track';
    }

    // Only these are safe to write into Airtable's single-select. 'Unknown' is
    // a display state — writing it would invent a new choice.
    function isWritableStatus(status) {
        return PROJECT_STATUSES.indexOf(status) !== -1;
    }

    const api = { computeProjectHealth, isWritableStatus, PROJECT_STATUSES,
                  NOT_STARTED_TIME_PCT, ON_TARGET_RATIO, ON_TRACK_RATIO };

    // Browser: plain <script> tag, so hang it on window like the rest of the app.
    // Node (the daily job and vitest): CommonJS export.
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    Object.keys(api).forEach(k => { root[k] = api[k]; });

})(typeof globalThis !== 'undefined' ? globalThis : this);
