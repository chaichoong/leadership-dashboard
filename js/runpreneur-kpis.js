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
//   • A partner counts only with a written yes on file (Status Signed AND the Written Yes
//     attachment). Gear, content sharing, a collaboration or a sponsorship all count.
//   • Cold email goes to limited companies only; an approached sole trader is flagged.
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

    // ── Project 2: partners signed (a written yes) ───────────────────────
    // rows: [{ name, kinds: [], status, rank, companyType, approachedOn, hasWrittenYes }], or null
    // when the table did not load. approachTarget: the approaches the plan commits to (40).
    // today (ISO): an Approached On date counts only once it has passed; a planned date is not a send.
    const APPROACHED = ['Approached', 'Replied', 'Signed', 'Declined'];
    function partnersSigned({ rows, approachTarget, today }) {
        const now = String(today || new Date().toISOString()).slice(0, 10);
        if (!Array.isArray(rows)) return { value: null, alarms: [red('The partners list did not load.')] };
        const alarms = [];
        if (!rows.length) alarms.push(amber('The partners list has no rows yet.'));
        const out = rows.map(r => {
            const status = String(r.status || 'Listed');
            const sentOn = String(r.approachedOn || '').slice(0, 10);
            // An approach already sent stays sent after an opt-out; the opt-out only stops the next one.
            const approached = APPROACHED.includes(status) || (!!sentOn && sentOn <= now);
            const signed = status === 'Signed' && !!r.hasWrittenYes;
            return { name: r.name || '(no name)', kinds: r.kinds || [], status, rank: r.rank == null ? null : Number(r.rank), companyType: r.companyType || '',
                approached, signed, optedOut: status === 'Do not contact', signedNoProof: status === 'Signed' && !r.hasWrittenYes,
                yesNotSigned: status !== 'Signed' && !!r.hasWrittenYes };
        });
        const noProof = out.filter(r => r.signedNoProof).length;
        if (noProof) alarms.push(amber(`${noProof} partner${noProof === 1 ? ' is' : 's are'} marked Signed with no written yes attached, so not counted.`));
        const notLtd = out.filter(r => r.approached && r.companyType && r.companyType !== 'Limited company').length;
        if (notLtd) alarms.push(amber(`${notLtd} approached partner${notLtd === 1 ? ' is' : 's are'} not a limited company. Cold email goes to limited companies only; anyone else must agree first.`));
        const noType = out.filter(r => r.approached && !r.companyType).length;
        if (noType) alarms.push(amber(`${noType} approached partner${noType === 1 ? ' has' : 's have'} no company type recorded, so the cold-email rule cannot be checked.`));
        const yesNotSigned = out.filter(r => r.yesNotSigned).length;
        if (yesNotSigned) alarms.push(amber(`${yesNotSigned} partner${yesNotSigned === 1 ? ' has' : 's have'} a written yes attached but is not marked Signed, so not counted.`));
        const approached = out.filter(r => r.approached).length;
        // Signed first, then approached, then the list by rank.
        out.sort((a, b) => (b.signed - a.signed) || (b.approached - a.approached) || ((a.rank == null ? 1e9 : a.rank) - (b.rank == null ? 1e9 : b.rank)));
        return { value: out.filter(r => r.signed).length, approached, approachTarget: Number(approachTarget) || null, listed: out.length,
            optedOut: out.filter(r => r.optedOut).length, rows: out, alarms };
    }

    return { moneyConfirmed, partnersSigned, alarmLevel };
});
