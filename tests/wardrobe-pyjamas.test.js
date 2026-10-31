// Tonight's pyjamas (Kevin, 31 Oct 2026): "what pyjamas we're going to wear in the evening, and also
// when to put them in the wash". Pinned against the REAL js/wardrobe-pick.js. Generic names only:
// the real wardrobe stays in Airtable, never in this public repo.
//
// The rule: a pair is worn 3 nights, then washed (back 2 days later). The pair part-way through its
// nights is finished before a fresh one starts; otherwise the clean pair worn longest ago is next.
// Pyjamas are never counted in the day's outfits.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(readFileSync(resolve(ROOT, 'js/wardrobe-pick.js'), 'utf8'), sandbox);
const P = sandbox.WardrobePick;

const pair = (id, extra = {}) => ({ id, name: id, type: 'Pyjamas', status: 'Own', ...extra });
const at = (iso) => new Date(iso + 'T20:00:00');
const items = (...list) => Object.fromEntries(list.map(i => [i.id, i]));
const brief = (p) => p && { id: p.item.id, night: p.night, limit: p.limit, washAfter: p.washAfter, wornTonight: p.wornTonight };

describe('tonight\'s pyjamas', () => {
    it('pyjamas wash every 3 nights by default, and a piece can override it', () => {
        expect(P.washLimit(pair('a'))).toBe(3);
        expect(P.washLimit(pair('a', { washEvery: 5 }))).toBe(5);
    });

    it('a fresh week starts on the pair worn longest ago: night 1 of 3, washed after the third night', () => {
        const its = items(pair('blue', { lastWorn: '2026-10-20' }), pair('check', { lastWorn: '2026-10-10' }), pair('grey'));
        // Never worn sorts first: it has waited longest of all.
        expect(brief(P.pickPyjamas(its, at('2026-10-31')))).toEqual({ id: 'grey', night: 1, limit: 3, washAfter: '2026-11-02', wornTonight: false });
    });

    it('the pair part-way through its nights is finished first', () => {
        const its = items(pair('blue', { lastWorn: '2026-10-30', wears: 1 }), pair('grey'));
        expect(brief(P.pickPyjamas(its, at('2026-10-31')))).toEqual({ id: 'blue', night: 2, limit: 3, washAfter: '2026-11-01', wornTonight: false });
    });

    it('the last night says so: washed the next morning', () => {
        const its = items(pair('blue', { lastWorn: '2026-10-30', wears: 2 }));
        expect(brief(P.pickPyjamas(its, at('2026-10-31')))).toEqual({ id: 'blue', night: 3, limit: 3, washAfter: '2026-10-31', wornTonight: false });
    });

    it('once logged tonight, tonight\'s pair stays the answer, and logging its third night puts it in the wash', () => {
        const blue = pair('blue', { lastWorn: '2026-10-30', wears: 2 });
        const logged = Object.assign({}, blue, P.wearFields(blue, '2026-10-31'));
        expect(logged.inWashSince).toBe('2026-10-31');
        const p = P.pickPyjamas(items(logged, pair('grey')), at('2026-10-31'));
        expect(brief(p)).toEqual({ id: 'blue', night: 3, limit: 3, washAfter: '2026-10-31', wornTonight: true });
        // Next night the washed pair is out and the other pair starts.
        expect(brief(P.pickPyjamas(items(logged, pair('grey')), at('2026-11-01'))).id).toBe('grey');
        // Two days after the wash it is clean again and back to night 1.
        expect(P.inWash(logged, '2026-11-02')).toBe(false);
        expect(P.wearsNow(logged, '2026-11-02')).toBe(0);
    });

    it('a pair in the wash is never picked, and none clean means no pick', () => {
        const its = items(pair('blue', { lastWorn: '2026-10-31', wears: 3, inWashSince: '2026-10-31' }));
        expect(P.pickPyjamas(its, at('2026-11-01'))).toBeNull();
    });

    it('a pair given away is never picked', () => {
        expect(P.pickPyjamas(items(pair('old', { status: 'Clear out' })), at('2026-10-31'))).toBeNull();
    });

    it('pyjamas are nightwear and nothing else is', () => {
        expect(P.isNightwear(pair('a'))).toBe(true);
        expect(P.isNightwear({ type: 'Lounge' })).toBe(false);
    });
});
