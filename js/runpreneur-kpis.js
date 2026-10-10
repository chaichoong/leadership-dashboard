// ════════════════════════════════════════════════════════════════════════
// Runpreneur quarterly KPIs — the maths (pure, no DOM, no fetch).
//
// js/dashboard.js reads the Runpreneur tables, normalises each row into a plain
// object and hands it here. The Runpreneur projects' KPI Compute Code calls
// ctx.runpreneur.*, which runs these functions. tests/runpreneur-kpis.test.js
// loads this same file under Node.
//
// Rules this file encodes (Kevin, Q4 2026 Runpreneur strategy session, 9-10 Oct 2026):
//   • Money counts only when the cause that received it confirms it: a row in
//     the Runpreneur Money Record with a receipt AND the Confirmed tick. A
//     headline figure, or a line someone typed, is never the measure.
//   • A figure that cannot be trusted says so: every result carries `alarms`,
//     and a red alarm stops the project saving a number.
// ════════════════════════════════════════════════════════════════════════
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.RunpreneurKpis = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
    const red = msg => ({ level: 'red', msg });
    const amber = msg => ({ level: 'amber', msg });

    function alarmLevel(result) {
        if (!result) return 'red';
        const a = result.alarms || [];
        return a.some(x => x.level === 'red') ? 'red' : (a.length ? 'amber' : '');
    }

    // ── Project 1: pounds a cause confirms it received ───────────────────
    // rows: [{ line, cause, source, amount (number or null), datePaid, hasReceipt, confirmed }], or null
    // when the table did not load. headline: the public total, shown beside the proof.
    function moneyConfirmed({ rows, headline }) {
        if (!Array.isArray(rows)) return { value: null, alarms: [red('The money record did not load.')] };
        const alarms = [];
        // An empty record is not a calm £0: the rows were deleted, or the read came back empty.
        if (!rows.length) alarms.push(amber('The money record has no lines.'));
        const seen = new Set();
        let duplicates = 0;
        const out = rows.map(r => {
            const raw = r.amount == null || r.amount === '' || isNaN(Number(r.amount)) ? null : round2(r.amount);
            const amount = raw === 0 ? null : raw;                      // £0 is no amount
            const negative = amount != null && amount < 0;              // every row is a payment TO a cause
            let counts = !!(r.confirmed && r.hasReceipt && amount != null && !negative);
            // The same payment entered twice counts once (same cause, amount and date paid).
            const key = counts ? [String(r.cause || '').trim().toLowerCase(), amount, String(r.datePaid || '').slice(0, 10)].join('|') : null;
            if (key && seen.has(key)) { counts = false; duplicates++; } else if (key) seen.add(key);
            return { line: r.line || '(no description)', cause: r.cause || '', source: r.source || '', amount, negative, confirmed: !!r.confirmed, hasReceipt: !!r.hasReceipt, counts };
        });
        const negatives = out.filter(r => r.negative).length;
        if (negatives) alarms.push(amber(`${negatives} line${negatives === 1 ? ' has' : 's have'} a negative amount, so not counted. Each line is a payment to a cause.`));
        if (duplicates) alarms.push(amber(`${duplicates} line${duplicates === 1 ? ' repeats' : 's repeat'} a payment already counted (same cause, amount and date), so counted once.`));
        const tickedNoReceipt = out.filter(r => r.confirmed && !r.hasReceipt);
        if (tickedNoReceipt.length) alarms.push(amber(`${tickedNoReceipt.length} line${tickedNoReceipt.length === 1 ? ' is' : 's are'} ticked Confirmed with no receipt, so not counted.`));
        const noAmount = out.filter(r => r.amount == null);
        if (noAmount.length) alarms.push(amber(`${noAmount.length} line${noAmount.length === 1 ? ' has' : 's have'} no amount yet.`));
        const value = round2(out.filter(r => r.counts).reduce((s, r) => s + r.amount, 0));
        const traced = round2(out.filter(r => r.amount != null).reduce((s, r) => s + r.amount, 0));
        return { value, traced, headline: Number(headline) || null, lines: out.length, confirmedLines: out.filter(r => r.counts).length, rows: out, alarms };
    }

    return { moneyConfirmed, alarmLevel };
});
