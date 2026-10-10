import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The dashboard loads js/runpreneur-kpis.js as a plain <script>; the same file exports under
// Node, so this suite runs the shipped rule. The fixture follows the shape of the real money
// record seeded on 10 Oct 2026 (an event line, a payment-provider line, a line with no amount
// yet). Every name and amount here is invented: this repo is public.
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const K = require(resolve(root, 'js/runpreneur-kpis.js'));

describe('money confirmed: only a receipt plus the Confirmed tick counts', () => {
    const seeded = [
        { line: 'Sample child, sample event', cause: 'Sample child fund', source: 'Event', amount: 12000, hasReceipt: false, confirmed: false },
        { line: 'Sample charities, card donations', cause: 'Sample charities', source: 'Stripe', amount: 2500, hasReceipt: false, confirmed: false },
        { line: 'Sample marathon', cause: 'Sample charity', source: 'Direct to cause', amount: null, hasReceipt: false, confirmed: false },
    ];

    it('today: nothing confirmed reads £0, with the traced total beside it', () => {
        const r = K.moneyConfirmed({ rows: seeded, headline: 20000 });
        expect([r.value, r.traced, r.headline, r.lines, r.confirmedLines]).toEqual([0, 14500, 20000, 3, 0]);
        expect(K.alarmLevel(r)).toBe('amber');                       // one line has no amount yet
    });

    it('a line counts once it has a receipt AND the tick', () => {
        const rows = seeded.map((r, i) => i === 0 ? { ...r, hasReceipt: true, confirmed: true } : r);
        expect(K.moneyConfirmed({ rows }).value).toBe(12000);
    });

    it('a tick with no receipt, or a receipt with no tick, does not count, and the tick alone is flagged', () => {
        const tickOnly = seeded.map((r, i) => i === 1 ? { ...r, confirmed: true } : r);
        const t = K.moneyConfirmed({ rows: tickOnly });
        expect(t.value).toBe(0);
        expect(t.alarms.map(a => a.msg).join(' ')).toContain('ticked Confirmed with no receipt');
        const receiptOnly = seeded.map((r, i) => i === 1 ? { ...r, hasReceipt: true } : r);
        expect(K.moneyConfirmed({ rows: receiptOnly }).value).toBe(0);
    });

    it('a table that did not load is red with no number, never a calm £0', () => {
        const r = K.moneyConfirmed({ rows: null });
        expect(r.value).toBeNull();
        expect(K.alarmLevel(r)).toBe('red');
    });

    it('an empty table is £0 with a warning, never a calm £0 (rows deleted or the read came back empty)', () => {
        const r = K.moneyConfirmed({ rows: [] });
        expect([r.value, K.alarmLevel(r)]).toEqual([0, 'amber']);
    });

    // Found in review, 10 Oct 2026.
    const ok = { cause: 'Sample charity', source: 'Stripe', hasReceipt: true, confirmed: true, datePaid: '2026-03-31' };
    it('a negative amount is flagged and not counted', () => {
        const r = K.moneyConfirmed({ rows: [{ ...ok, line: 'A', amount: 1000 }, { ...ok, line: 'B', amount: -500, datePaid: '2026-04-01' }] });
        expect(r.value).toBe(1000);
        expect(r.alarms.map(a => a.msg).join(' ')).toContain('negative amount');
    });
    it('the same payment entered twice counts once, and says so', () => {
        const r = K.moneyConfirmed({ rows: [{ ...ok, line: 'A', amount: 1000 }, { ...ok, line: 'A again', amount: 1000 }] });
        expect(r.value).toBe(1000);
        expect(r.alarms.map(a => a.msg).join(' ')).toContain('counted once');
        const diffDate = K.moneyConfirmed({ rows: [{ ...ok, line: 'A', amount: 1000 }, { ...ok, line: 'B', amount: 1000, datePaid: '2026-06-30' }] });
        expect(diffDate.value).toBe(2000);
    });
    it('a £0 line is no amount, never a green confirmed line', () => {
        const r = K.moneyConfirmed({ rows: [{ ...ok, line: 'Zero', amount: 0 }] });
        expect([r.value, r.rows[0].counts, r.rows[0].amount]).toEqual([0, false, null]);
    });
});

// Kevin, 9-10 Oct 2026: a partner is a written yes to gear, content sharing, a collaboration or a
// sponsorship. Shaped on the Dream 100 list; every name is invented.
describe('partners signed: only a written yes counts, and the approaches sit beside it', () => {
    const list = [
        { name: 'Sample Coffee', kinds: ['Sponsorship'], status: 'Signed', rank: 1, companyType: 'Limited company', approachedOn: '2026-11-03', hasWrittenYes: true },
        { name: 'Sample Shoes', kinds: ['Gear'], status: 'Signed', rank: 2, companyType: 'Limited company', approachedOn: '2026-11-03', hasWrittenYes: false },
        { name: 'Sample Gym', kinds: ['Content sharing'], status: 'Replied', rank: 3, companyType: 'Limited company', approachedOn: '2026-11-04', hasWrittenYes: false },
        { name: 'Sample Coach', kinds: [], status: 'Approached', rank: 4, companyType: 'Sole trader', approachedOn: '2026-11-05', hasWrittenYes: false },
        { name: 'Sample Brand', kinds: [], status: 'Listed', rank: 5, companyType: 'Limited company', approachedOn: '', hasWrittenYes: false },
        { name: 'Sample Opt-out', kinds: [], status: 'Do not contact', rank: 6, companyType: 'Limited company', approachedOn: '2026-11-05', hasWrittenYes: false },
    ];

    const today = '2026-11-10';
    it('counts the one Signed row with a written yes, and five approaches against 40 (an opt-out after a send still counts)', () => {
        const r = K.partnersSigned({ rows: list, approachTarget: 40, today });
        expect([r.value, r.approached, r.approachTarget, r.listed, r.optedOut]).toEqual([1, 5, 40, 6, 1]);
        expect(r.rows[0].name).toBe('Sample Coffee');                // signed first
    });
    it('flags a Signed row with no written yes, and an approached partner that is not a limited company', () => {
        const msgs = K.partnersSigned({ rows: list, approachTarget: 40, today }).alarms.map(a => a.msg).join(' ');
        expect(msgs).toContain('no written yes attached');
        expect(msgs).toContain('not a limited company');
    });
    // Found in review, 10 Oct 2026.
    it('a planned approach date in the future is not a send', () => {
        const planned = [{ name: 'Sample Planned', status: 'Listed', companyType: 'Limited company', approachedOn: '2026-12-20' }];
        expect(K.partnersSigned({ rows: planned, approachTarget: 40, today }).approached).toBe(0);
        expect(K.partnersSigned({ rows: planned, approachTarget: 40, today: '2026-12-20' }).approached).toBe(1);
    });
    it('an approached row with no company type, or Other, is flagged', () => {
        const rows = [{ name: 'Blank', status: 'Approached', companyType: '' }, { name: 'Other', status: 'Approached', companyType: 'Other' }];
        const msgs = K.partnersSigned({ rows, approachTarget: 40, today }).alarms.map(a => a.msg).join(' ');
        expect(msgs).toContain('no company type recorded');
        expect(msgs).toContain('not a limited company');
    });
    it('a written yes on a row not marked Signed is flagged and not counted', () => {
        const r = K.partnersSigned({ rows: [{ name: 'Yes', status: 'Replied', companyType: 'Limited company', hasWrittenYes: true }], approachTarget: 40, today });
        expect(r.value).toBe(0);
        expect(r.alarms.map(a => a.msg).join(' ')).toContain('not marked Signed');
    });
    it('a list that did not load is red with no number; an empty list is 0 with a warning', () => {
        const dead = K.partnersSigned({ rows: null, approachTarget: 40 });
        expect([dead.value, K.alarmLevel(dead)]).toEqual([null, 'red']);
        const empty = K.partnersSigned({ rows: [], approachTarget: 40 });
        expect([empty.value, K.alarmLevel(empty)]).toEqual([0, 'amber']);
    });
});
