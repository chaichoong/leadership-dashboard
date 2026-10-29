// Guards for the wash cycle on the "What to wear today" card (Kevin, 29 Oct 2026).
//
// Kevin's rulings: each day worn adds one wear; at its limit (Tee, Shirt, Lounge 1; Knit 3; Trousers,
// Shorts 5; anything else never; or the piece's own Wash every) a piece goes in the wash and is not
// offered for 2 days, then counts as clean again with no press. The outfit worn longest ago comes
// first, judged by its washable pieces too. Generic names only: this repo is public.
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

const item = (id, type, extra = {}) => ({ id, name: id, type, status: 'Own', usedFor: [], ...extra });
const outfit = (id, option, itemIds, lastWorn = null) => ({ id, name: id, option, season: 'All', itemIds, lastWorn });
const TODAY = '2026-10-29';
const D = new Date(2026, 9, 29, 9, 0);

describe('wash limits', () => {
    it('come from the type, or the piece\'s own Wash every (0 = never counted)', () => {
        expect(P.washLimit(item('a', 'Tee'))).toBe(1);
        expect(P.washLimit(item('a', 'Knit'))).toBe(3);
        expect(P.washLimit(item('a', 'Trousers'))).toBe(5);
        expect(P.washLimit(item('a', 'Jacket'))).toBe(0);
        expect(P.washLimit(item('a', 'Shoes'))).toBe(0);
        expect(P.washLimit(item('a', 'Knit', { washEvery: 2 }))).toBe(2);
        expect(P.washLimit(item('a', 'Tee', { washEvery: 0 }))).toBe(0);
    });
});

describe('logging a wear', () => {
    it('adds one wear and stamps the day; at the limit the piece goes in the wash', () => {
        expect(P.wearFields(item('k', 'Knit', { wears: 1, lastWorn: '2026-10-27' }), TODAY))
            .toEqual({ lastWorn: TODAY, prevWorn: '2026-10-27', wears: 2, inWashSince: null });
        expect(P.wearFields(item('k', 'Knit', { wears: 2 }), TODAY))
            .toEqual({ lastWorn: TODAY, prevWorn: null, wears: 3, inWashSince: TODAY });
        expect(P.wearFields(item('t', 'Tee'), TODAY).inWashSince).toBe(TODAY);
    });
    it('never counts the same day twice', () => {
        expect(P.wearFields(item('k', 'Knit', { wears: 1, lastWorn: TODAY }), TODAY)).toBeNull();
    });
    it('does not count a piece that is never washed, but still stamps the day', () => {
        expect(P.wearFields(item('j', 'Jacket'), TODAY)).toEqual({ lastWorn: TODAY, prevWorn: null, wears: 0, inWashSince: null });
    });
    it('starts again from one when the piece is back from the wash', () => {
        expect(P.wearFields(item('k', 'Knit', { wears: 3, inWashSince: '2026-10-26', lastWorn: '2026-10-26' }), TODAY))
            .toEqual({ lastWorn: TODAY, prevWorn: '2026-10-26', wears: 1, inWashSince: null });
    });
    it('a piece already in the wash, worn and then taken back, is still in the wash', () => {
        const dirty = item('t', 'Tee', { wears: 1, lastWorn: '2026-10-28', inWashSince: '2026-10-28' });
        const worn = { ...dirty, ...P.wearFields(dirty, TODAY) };
        expect(worn).toMatchObject({ wears: 2, inWashSince: '2026-10-28', lastWorn: TODAY });
        const back = { ...worn, ...P.unwearFields(worn, TODAY) };
        expect(P.inWash(back, TODAY)).toBe(true);
        expect(back.wears).toBe(1);
    });
    it('taking today back restores the day before, the count, and the wash', () => {
        const worn = item('t', 'Tee', { wears: 1, lastWorn: TODAY, prevWorn: '2026-10-20', inWashSince: TODAY });
        expect(P.unwearFields(worn, TODAY)).toEqual({ lastWorn: '2026-10-20', prevWorn: null, wears: 0, inWashSince: null });
        expect(P.unwearFields(item('t', 'Tee', { lastWorn: '2026-10-28' }), TODAY)).toBeNull();
    });
});

describe('the wash takes 2 days, then the piece is clean on its own', () => {
    const tee = item('t', 'Tee', { wears: 1, inWashSince: '2026-10-28' });
    it('is in the wash the day it hits the limit and the day after', () => {
        expect(P.inWash(tee, '2026-10-28')).toBe(true);
        expect(P.inWash(tee, '2026-10-29')).toBe(true);
    });
    it('is clean again on the second day, with no press', () => {
        expect(P.cleanOn(tee)).toBe('2026-10-30');
        expect(P.inWash(tee, '2026-10-30')).toBe(false);
        expect(P.wearsNow(tee, '2026-10-30')).toBe(0);
    });
});

describe('the picks', () => {
    const ITEMS = Object.fromEntries([
        item('teeA', 'Tee'), item('teeB', 'Tee'), item('jeans', 'Trousers'), item('chinos', 'Trousers'), item('trainers', 'Shoes'),
        item('sweat', 'Lounge'), item('joggers', 'Lounge'),
    ].map(i => [i.id, i]));
    const OUTFITS = [
        outfit('A', 'Out casual', ['teeA', 'jeans', 'trainers']),
        outfit('B', 'Out casual', ['teeB', 'chinos', 'trainers']),
        outfit('Home', 'Stay at home', ['sweat', 'joggers']),
    ];
    const casual = (items, outfits = OUTFITS) => P.chooseBase(outfits, items, 'Out casual', D);

    it('skip an outfit with a piece in the wash', () => {
        expect(casual(ITEMS).id).toBe('A');
        expect(casual({ ...ITEMS, teeA: { ...ITEMS.teeA, inWashSince: '2026-10-28' } }).id).toBe('B');
    });
    it('offer it again once the wash is over', () => {
        expect(casual({ ...ITEMS, teeA: { ...ITEMS.teeA, inWashSince: '2026-10-27' } }).id).toBe('A');
    });
    it('count a washable piece worn in some other mix as the outfit being worn', () => {
        // Outfit A was never pressed, but its jeans went out yesterday in a mix he logged.
        expect(casual({ ...ITEMS, jeans: { ...ITEMS.jeans, lastWorn: '2026-10-28' } }).id).toBe('B');
    });
    it('ignore shoes and jackets when judging how recently an outfit was worn', () => {
        expect(casual({ ...ITEMS, trainers: { ...ITEMS.trainers, lastWorn: '2026-10-28' } }).id).toBe('A');
    });
    it('keep today\'s worn outfit on the card even if it has just gone in the wash', () => {
        const worn = OUTFITS.map(o => (o.id === 'A' ? { ...o, lastWorn: TODAY } : o));
        expect(casual({ ...ITEMS, teeA: { ...ITEMS.teeA, inWashSince: TODAY } }, worn).id).toBe('A');
    });
    it('return no outfit when every one has a piece in the wash', () => {
        const wash = { inWashSince: TODAY };
        expect(casual({ ...ITEMS, teeA: { ...ITEMS.teeA, ...wash }, teeB: { ...ITEMS.teeB, ...wash } })).toBeNull();
    });
    it('never add a weather layer that is in the wash', () => {
        const items = { ...ITEMS, scarfA: item('scarfA', 'Accessory', { layerRole: 'Scarf', washEvery: 1, inWashSince: TODAY }),
            scarfB: item('scarfB', 'Accessory', { layerRole: 'Scarf' }) };
        const pick = P.pickOutfits(OUTFITS, items, { feelsMin: 2, rainChance: 0 }, D).find(p => p.option === 'Out casual');
        expect(pick.items.map(i => i.id)).toContain('scarfB');
        expect(pick.items.map(i => i.id)).not.toContain('scarfA');
    });
});
