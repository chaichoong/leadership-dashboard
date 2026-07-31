// ══════════════════════════════════════════
// AGENT ACCURACY — the single source for how agent work is scored
// ══════════════════════════════════════════
//
// Loaded as a plain <script> by the Task OS and the Leadership Dashboard, and
// imported directly by tests/agent-accuracy.test.js. One copy, because two
// copies of a threshold drift and the two surfaces then disagree about whether
// an agent has earned autonomy.
//
// THE RULES (Kevin, 31 Jul 2026)
//   - Score per agent PER TASK TYPE, never blended. An agent can be excellent
//     at drafting and poor at analysis; a single number hides exactly that.
//   - Accurate = approved as-is + approved with minor edits.
//   - The bar needs BOTH: at least 20 decisions of that task type by that
//     agent, AND 90%+, AND no rejections in the last 10.
//   - Crossing the bar produces a RECOMMENDATION. Nothing ever auto-promotes.
//     The owner moves the gears; accuracy only advises.
//
// KNOWN LIMIT, stated rather than hidden: the outcome lives in one field on the
// task, so a task that went round twice keeps only its FINAL verdict. A round
// that ended in "changes requested" and was later approved counts once, as the
// approval.
(function (root) {
    'use strict';

    var APPROVAL_OUTCOMES = ['Approved as-is', 'Approved with minor edits', 'Changes requested', 'Rejected'];
    var APPROVAL_ACCURATE = ['Approved as-is', 'Approved with minor edits'];

    var THRESHOLD = {
        minSample: 20,  // decisions of that task type by that agent
        minRate: 0.9,   // 90% accurate
        recentN: 10,    // and zero rejections in the last this-many
    };

    // history: [{ agentId, taskType, outcome, at }]  (at = ISO string, may be blank)
    // names:   optional { agentId: 'Display name' }
    // → one row per agent × task type, newest decisions weighted into `recent`.
    function computeAgentAccuracy(history, names) {
        var lookup = names || {};
        var buckets = {};
        (history || []).forEach(function (h) {
            if (!h || !h.agentId || !h.outcome) return;
            var type = h.taskType || 'Unclassified';
            var key = h.agentId + '||' + type;
            if (!buckets[key]) buckets[key] = { agentId: h.agentId, taskType: type, items: [] };
            buckets[key].items.push(h);
        });

        return Object.keys(buckets).map(function (key) {
            var b = buckets[key];
            // Newest first. Undated entries sort last so they can never
            // masquerade as recent and mask a fresh run of rejections.
            var items = b.items.slice().sort(function (a, c) {
                return String(c.at || '').localeCompare(String(a.at || ''));
            });
            var total = items.length;
            var accurate = items.filter(function (i) { return APPROVAL_ACCURATE.indexOf(i.outcome) !== -1; }).length;
            var rejected = items.filter(function (i) { return i.outcome === 'Rejected'; }).length;
            var recent = items.slice(0, THRESHOLD.recentN);
            var recentRejections = recent.filter(function (i) { return i.outcome === 'Rejected'; }).length;
            var rate = total ? accurate / total : 0;
            return {
                agentId: b.agentId,
                agentName: lookup[b.agentId] || b.agentId,
                taskType: b.taskType,
                total: total,
                accurate: accurate,
                rejected: rejected,
                rate: rate,
                recentRejections: recentRejections,
                ready: total >= THRESHOLD.minSample && rate >= THRESHOLD.minRate && recentRejections === 0,
            };
        }).sort(function (a, c) {
            return String(a.agentName).localeCompare(String(c.agentName))
                || String(a.taskType).localeCompare(String(c.taskType));
        });
    }

    // What the CEO huddle reads out. Wording matters: it is a recommendation to
    // Kevin, and it says so, because the moment this reads like a notification
    // of a change already made, the trust ramp is broken.
    function agentAutonomyRecommendations(rows) {
        return (rows || []).filter(function (r) { return r.ready; }).map(function (r) {
            return r.agentName + ' has cleared the bar on ' + r.taskType + ': '
                + Math.round(r.rate * 100) + '% over ' + r.total + ' approvals, no rejections in the last '
                + Math.min(r.total, THRESHOLD.recentN)
                + '. Your call whether it runs that task type without the gate.';
        });
    }

    var api = {
        APPROVAL_OUTCOMES: APPROVAL_OUTCOMES,
        APPROVAL_ACCURATE: APPROVAL_ACCURATE,
        THRESHOLD: THRESHOLD,
        computeAgentAccuracy: computeAgentAccuracy,
        agentAutonomyRecommendations: agentAutonomyRecommendations,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.AgentAccuracy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
