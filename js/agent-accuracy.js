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

    // ─── A REJECTION IS NOT ALWAYS A MARK AGAINST THE WRITER ──────────
    //
    // Measured 27 Aug 2026 across all 175 decisions Kevin had made. Of his 58
    // rejections, NOT ONE said the draft was wrong. Every one said the task
    // should not have existed: already handled, Roy's, too trivial, duplicate,
    // stale. Blended accuracy read 66.9%; on the drafts that were actually
    // judged AS drafts it was 96.7%.
    //
    // That gap was not cosmetic. Guardrail bands tighten automatically on this
    // number, so agents were being restricted for a failure upstream of them —
    // the Inbound Comms Response agent read 57% on correspondence while scoring
    // 100% on the eight drafts anyone had actually judged.
    //
    // So a rejection carrying one of these reasons leaves the draft-quality
    // bucket ENTIRELY. Not counted as accurate, not counted in the total: it is
    // evidence about whatever created the task, not about the agent that wrote
    // it. `Verdict Reason` on the task is where Kevin records which it was, in
    // one tap, at the moment he decides. He classifies; no model guesses.
    var RELEVANCE_REASONS = [
        'Already done elsewhere',
        'Roy owns it',
        'Not worth my attention',
        'Duplicate',
        'Parked for now',
        'No longer relevant',
    ];
    // The one reason that IS a judgement on the writing.
    var QUALITY_REASON = 'The work is wrong';
    // ── NONE OF THE SEVEN (4 Sep 2026) ───────────────────────────────
    // Kevin can always reject in his own words (his ruling, 28 Aug), and until
    // now those rejections stored NOTHING in Verdict Reason — indistinguishable
    // from a write that never happened, which is how five of them went unseen
    // between 1 and 3 Sep. They now store this instead: an explicit "he did not
    // say which kind", which counts exactly as a blank always did (an unknown,
    // never a pass) while being visible as a choice rather than a gap.
    var UNCLASSIFIED_REASON = 'Something else';

    function isUnclassifiedRejection(item) {
        return item.outcome === 'Rejected'
            && (!item.reason || item.reason === UNCLASSIFIED_REASON);
    }

    function isRelevanceFailure(item) {
        return item.outcome === 'Rejected'
            && RELEVANCE_REASONS.indexOf(item.reason || '') !== -1;
    }

    // ─── THE BAR (Kevin, 31 Jul 2026; MIN DAYS added 28 Aug 2026) ─────
    //
    // The day the first agent ever cleared this bar, the sample was checked and
    // all 26 of its decisions had happened in THREE DAYS — 3 on the 26th, 14 on
    // the 27th, 9 on the 28th. A burst, not a track record, and the report was
    // about to recommend autonomy on it.
    //
    // Kevin's ruling: an agent must hold the standard over a rolling 30 days
    // before it passes. Volume is not the same as consistency, and a busy
    // Tuesday can manufacture a sample in an afternoon. Elapsed time is the one
    // thing that cannot be manufactured.
    var THRESHOLD = {
        minSample: 20,  // decisions of that task type by that agent
        minRate: 0.9,   // 90% accurate
        recentN: 10,    // and zero rejections in the last this-many
        minDays: 30,    // spanning at least this many days, first to last
    };

    /** Whole days between the oldest and newest dated decision in a bucket.
     *  Undated entries are ignored rather than counted as today: treating a
     *  blank date as now would let a single dated decision look like a span. */
    function spanDays(items) {
        var dates = (items || [])
            .map(function (i) { return Date.parse(i.at || ''); })
            .filter(function (t) { return !isNaN(t); });
        if (dates.length < 2) return 0;
        return Math.floor((Math.max.apply(null, dates) - Math.min.apply(null, dates))
            / 86400000);
    }

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
            // Split before counting anything. Relevance failures are not this
            // agent's work being judged, so they never touch its rate, its
            // sample, or its recent run — including the "no rejections in the
            // last 10" clause, which a single relevance failure could
            // otherwise use to block an agent from the bar indefinitely. That
            // is exactly what was blocking Writer/Correspondence at 95%.
            var relevance = items.filter(isRelevanceFailure);
            var judged = items.filter(function (i) { return !isRelevanceFailure(i); });

            var total = judged.length;
            var accurate = judged.filter(function (i) { return APPROVAL_ACCURATE.indexOf(i.outcome) !== -1; }).length;
            var rejected = judged.filter(function (i) { return i.outcome === 'Rejected'; }).length;
            var recent = judged.slice(0, THRESHOLD.recentN);
            var recentRejections = recent.filter(function (i) { return i.outcome === 'Rejected'; }).length;
            var rate = total ? accurate / total : 0;
            // Honesty about the past. Every decision made before 27 Aug 2026
            // carries no reason, and nothing may guess one on Kevin's behalf —
            // he is the only one who can tell "Roy owns this" (a rule) from
            // "wrong invoice number" (a one-off). They stay in the total, and
            // this count says how much of the score is therefore unexplained.
            var unclassified = judged.filter(isUnclassifiedRejection).length;
            // Measured across the JUDGED decisions, not the relevance failures:
            // the question is how long this agent has been doing THIS WORK to
            // this standard, and a rejected-as-irrelevant task is not evidence
            // either way.
            var days = spanDays(judged);
            return {
                agentId: b.agentId,
                agentName: lookup[b.agentId] || b.agentId,
                taskType: b.taskType,
                spanDays: days,
                daysToGo: Math.max(0, THRESHOLD.minDays - days),
                total: total,
                accurate: accurate,
                rejected: rejected,
                rate: rate,
                recentRejections: recentRejections,
                // Not this agent's failure. Counted so it is never silently
                // dropped: these are the tasks that should not have reached
                // Kevin at all, and somebody has to own that number.
                relevanceFailures: relevance.length,
                unclassifiedRejections: unclassified,
                ready: total >= THRESHOLD.minSample && rate >= THRESHOLD.minRate
                       && recentRejections === 0 && days >= THRESHOLD.minDays,
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
                + Math.round(r.rate * 100) + '% over ' + r.total + ' approvals across '
                + r.spanDays + ' days, no rejections in the last '
                + Math.min(r.total, THRESHOLD.recentN)
                + '. Your call whether it runs that task type without the gate.';
        });
    }

    // The ONE way to count live agents across two populations that overlap:
    // legacy workflow agents (SOP JSON, sop.agent.state) and register role
    // agents (AI Agents table, Status). A register row may LINK a workflow
    // (its `Workflow` field) — that pair is one agent, not two. The dashboard
    // card once summed the populations raw while the Systemisation tab badge
    // subtracted the overlap, so the front page could exceed the tab it links
    // to. Same subtraction here, tested, shared.
    //   wfAgents:     [{ id, state }]                (state: 'live'|'testing'|…)
    //   registerRows: [{ status, workflowIds: [] }]  (status: 'Live'|'Built'|…)
    function countAgents(wfAgents, registerRows) {
        var linked = {};
        (registerRows || []).forEach(function (r) {
            (r.workflowIds || []).forEach(function (id) { linked[id] = true; });
        });
        var wfOnly = (wfAgents || []).filter(function (a) { return !linked[a.id]; });
        return {
            live: wfOnly.filter(function (a) { return a.state === 'live'; }).length
                + (registerRows || []).filter(function (r) { return r.status === 'Live'; }).length,
            testing: wfOnly.filter(function (a) { return a.state === 'testing'; }).length,
            wfOverlap: (wfAgents || []).length - wfOnly.length,
        };
    }

    // The second number: how much of what reached Kevin should never have.
    // Draft quality belongs to the agent that wrote it; relevance belongs to
    // whatever created the task. One number could never carry both.
    function relevanceScore(history) {
        var all = (history || []).filter(function (h) { return h && h.outcome; });
        var bad = all.filter(isRelevanceFailure).length;
        var classified = all.filter(function (h) {
            return !isUnclassifiedRejection(h);
        }).length;
        return {
            decisions: all.length,
            classified: classified,
            relevanceFailures: bad,
            // Share of CLASSIFIED decisions that were worth his time. Measured
            // against classified only, because an unclassified rejection is an
            // unknown, not a pass.
            rate: classified ? (classified - bad) / classified : 0,
        };
    }

    // ─── AUTONOMY LEVELS (Kevin's ruling, 7 Sep 2026; Chen Book 4 ch 5) ──
    //
    // Every decision an agent makes sits at one of three levels, decided per
    // CATEGORY of decision, never per agent. A = the agent acts (Kevin sees it
    // on "Handled without you"), B = drafted and Kevin approves, C = Kevin
    // only. The word "tier" is avoided: tier 1 already means the private legal
    // matter. scripts/agent-dispatch.py decides the level at submit and
    // VERIFIES the evidence; this table is the page's read-only copy for the
    // 15-Minute Dashboard, and tests/constant-drift.test.js keeps the two in
    // step.
    var AUTONOMY_LEVELS = {
        'close: duplicate':        { level: 'A', since: '2026-09-07' },
        'close: already handled':  { level: 'A', since: '2026-09-07' },
        'information only':        { level: 'A', since: '2026-09-04' },
        'calendar entry':          { level: 'A', since: '2026-09-07' },
        'pass to Roy':             { level: 'A', since: '2026-09-07' },
        'close: judgement':        { level: 'B' },
        'email: reply':            { level: 'B' },
        'email: quote request':    { level: 'B' },
        'email: OD outbound':      { level: 'B' },
        'content card':            { level: 'B' },
        'report':                  { level: 'B' },
        'recommendation':          { level: 'B' },
        'sign document':           { level: 'C' },
        'post letter':             { level: 'C' },
        'tier-1 matter':           { level: 'C' },
        'spend over the rule':     { level: 'C' },
    };
    // The money rule. Mirrors DECISION_MONEY in scripts/agent-dispatch.py.
    var DECISION_MONEY = { log: 25, inform: 100 };

    // The Notes marker agent-dispatch.py leaves on every Level A carry-out.
    var HANDLED_MARK = 'HANDLED WITHOUT YOU';

    // Shape-only classification of a decided task, for the dashboard's
    // per-category evidence. Same shapes the dispatcher's decision_level reads,
    // minus the evidence checks (a page cannot fetch the keeper). Returns one
    // of the AUTONOMY_LEVELS keys.
    function decisionCategory(output, taskType, name) {
        var raw = String(output || '');
        var nm = String(name || '');
        // Drop the tier-1 banner lines so the shape underneath is judged, but
        // remember it: a tier-1 matter is Level C whatever the shape.
        var tier1 = /(:rotating_light:|\u{1F6A8})\s*TIER\s*1\b/iu.test(raw) || /^\s*🚨?\s*TIER 1\./m.test(raw);
        var lines = raw.split('\n');
        var i = 0;
        while (i < lines.length && (!lines[i].trim() || (i < 3 && /TIER\s*1/i.test(lines[i])))) i++;
        var out = lines.slice(i).join('\n').trim();
        var up = out.toUpperCase();
        if (tier1) return 'tier-1 matter';
        // Money before shape: a PASS TO ROY over the rule is a card whatever its shape.
        if (/^\s*SPEND:\s*£?\s*[\d,]+(?:\.\d+)?\s*(?:\/|per\s|a\s|each\s|every\s)?(?:month|week|year|quarter|annum|recurring|monthly|weekly|annually|yearly)\b/im.test(out)) return 'spend over the rule';
        var spend = /^\s*SPEND:\s*£?\s*([\d,]+(?:\.\d+)?)/im.exec(out);
        if (spend && parseFloat(spend[1].replace(/,/g, '')) > DECISION_MONEY.inform) return 'spend over the rule';
        if (/^SIGN-IN:/i.test(nm) || /^\s*SIGN-IN NEEDED:/im.test(out)) return 'information only';
        if (/^CLOSE PROPOSAL:\s*duplicate of\s+rec[A-Za-z0-9]{14}\b/i.test(out)) return 'close: duplicate';
        if (/^CLOSE PROPOSAL:\s*(?:already (?:handled|done|dealt with)|done already|handled)\b[^\n]*?\brec[A-Za-z0-9]{14}\b/i.test(out)) return 'close: already handled';
        if (up.indexOf('CLOSE PROPOSAL:') === 0) return 'close: judgement';
        if (up.indexOf('PASS TO ROY:') === 0) return 'pass to Roy';
        if (/^CONTENT/i.test(nm)) return 'content card';
        if (up.indexOf('CALENDAR:') === 0) return 'calendar entry';
        if (up.indexOf('DOCUMENT:') === 0) return 'sign document';
        if (up.indexOf('POST:') === 0) return 'post letter';
        if (/^(TO|FROM|CC|SUBJECT):/i.test(out)) {
            if (/^(COMPLIANCE|CORRESPONDENCE)/i.test(nm)) return 'email: quote request';
            if (/^(INBOUND|Chase)/i.test(nm)) return 'email: reply';
            return 'email: OD outbound';
        }
        if (/\*\*Carrying this out will involve:\*\*\s*Nothing\.?\s*(Information only\.?)?\s*$/i.test(out)) return 'information only';
        if (/RECOMMEND/i.test(out.slice(0, 1000))) return 'recommendation';
        if (taskType === 'Correspondence') return 'email: reply';
        return 'report';
    }

    // A Level B category becomes a Level A CANDIDATE on the same bar an agent
    // does (Chen's 90/100, Kevin's 20 sample + rolling 30 days + clean last
    // 10). Kevin clicks; nothing promotes itself. history items carry
    // { category, outcome, at }.
    function categoryCandidates(history) {
        var buckets = {};
        (history || []).forEach(function (h) {
            if (!h || !h.category || !h.outcome) return;
            (buckets[h.category] = buckets[h.category] || []).push(h);
        });
        return Object.keys(buckets).map(function (cat) {
            var items = buckets[cat].slice().sort(function (a, c) {
                return String(c.at || '').localeCompare(String(a.at || ''));
            });
            var judged = items.filter(function (i) { return !isRelevanceFailure(i); });
            var total = judged.length;
            var accurate = judged.filter(function (i) { return APPROVAL_ACCURATE.indexOf(i.outcome) !== -1; }).length;
            var recentRejections = judged.slice(0, THRESHOLD.recentN).filter(function (i) { return i.outcome === 'Rejected'; }).length;
            var days = spanDays(judged);
            var rate = total ? accurate / total : 0;
            var lvl = (AUTONOMY_LEVELS[cat] || {}).level || 'B';
            return {
                category: cat, level: lvl, total: total, accurate: accurate, rate: rate,
                spanDays: days, recentRejections: recentRejections,
                relevanceFailures: items.length - total,
                candidate: lvl === 'B' && total >= THRESHOLD.minSample && rate >= THRESHOLD.minRate
                           && recentRejections === 0 && days >= THRESHOLD.minDays,
            };
        }).sort(function (a, c) { return c.total - a.total; });
    }

    var api = {
        AUTONOMY_LEVELS: AUTONOMY_LEVELS,
        DECISION_MONEY: DECISION_MONEY,
        HANDLED_MARK: HANDLED_MARK,
        decisionCategory: decisionCategory,
        categoryCandidates: categoryCandidates,
        APPROVAL_OUTCOMES: APPROVAL_OUTCOMES,
        APPROVAL_ACCURATE: APPROVAL_ACCURATE,
        RELEVANCE_REASONS: RELEVANCE_REASONS,
        QUALITY_REASON: QUALITY_REASON,
        UNCLASSIFIED_REASON: UNCLASSIFIED_REASON,
        isRelevanceFailure: isRelevanceFailure,
        isUnclassifiedRejection: isUnclassifiedRejection,
        relevanceScore: relevanceScore,
        THRESHOLD: THRESHOLD,
        computeAgentAccuracy: computeAgentAccuracy,
        agentAutonomyRecommendations: agentAutonomyRecommendations,
        countAgents: countAgents,
        spanDays: spanDays,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.AgentAccuracy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
