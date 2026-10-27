// Guards for the "What to wear today" rules (Kevin, 27 Oct 2026).
//
// The three worked examples Kevin approved at the build gate are pinned here against the REAL
// js/wardrobe-pick.js. The fixture is shaped like the Airtable Wardrobe and Outfits rows, with
// generic names: the real wardrobe stays in Airtable, never in this public repo.
//   1. 27 Oct, feels 5° to 13°, drizzle 80%: casual gets the rain jacket and a beanie; smart gets the coat.
//   2. A dry mild May day: the casual outfit gets nothing added.
//   3. A cold dry January night: smart gets the coat, a beanie and a scarf.
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
const ITEMS = Object.fromEntries([
    item('tee', 'Tee'), item('jumper', 'Knit'), item('jeans', 'Trousers'), item('polo', 'Tee'), item('beige', 'Trousers'),
    item('belt', 'Accessory'), item('trainers', 'Shoes'), item('turtleneck', 'Knit'), item('blackJeans', 'Trousers'),
    item('shirt', 'Shirt'), item('navyChinos', 'Trousers', { status: 'Bought' }), item('sweat', 'Lounge'), item('joggers', 'Lounge'),
    item('hoodie', 'Lounge'), item('bomberTee', 'Tee'),
    item('tanBoots', 'Shoes', { layerRole: 'Leather boots casual' }), item('chelsea', 'Shoes', { layerRole: 'Leather boots smart' }),
    item('rainJacket', 'Jacket', { layerRole: 'Rain jacket', usedFor: ['Work'] }), item('bomber', 'Jacket', { layerRole: 'Casual jacket' }),
    item('coat', 'Coat', { layerRole: 'Smart coat' }), item('oliveBeanie', 'Accessory', { layerRole: 'Beanie', usedFor: ['Work'] }),
    item('burgundyBeanie', 'Accessory', { layerRole: 'Beanie', usedFor: ['Evening'] }), item('scarf', 'Accessory', { layerRole: 'Scarf' }),
    item('breton', 'Tee', { status: 'Need' }),
].map(i => [i.id, i]));
const outfit = (id, option, season, itemIds, lastWorn = null) => ({ id, name: id, option, season, itemIds, lastWorn });
// Same order as the Airtable rows: work, day, evening, home.
const OUTFITS = [
    outfit('Knit and denim', 'Out casual', 'Autumn and winter', ['tee', 'jumper', 'jeans', 'tanBoots']),
    outfit('Polo and stone', 'Out casual', 'All', ['polo', 'beige', 'belt', 'trainers']),
    outfit('Tee and bomber', 'Out casual', 'All', ['bomberTee', 'bomber', 'jeans', 'trainers']),
    outfit('Breton weekend', 'Out casual', 'All', ['breton', 'beige', 'trainers']),
    outfit('All black', 'Out smart casual', 'Autumn and winter', ['turtleneck', 'blackJeans', 'chelsea']),
    outfit('Oxford and navy', 'Out smart casual', 'All', ['shirt', 'navyChinos', 'belt', 'chelsea']),
    outfit('Sofa day', 'Stay at home', 'All', ['sweat', 'joggers']),
    outfit('Home office', 'Stay at home', 'All', ['tee', 'hoodie', 'joggers']),
];
const names = (pick) => pick.items.map(i => i.id);
const byOption = (picks, o) => picks.find(p => p.option === o);

describe('worked example 1: Tue 27 Oct 2026, feels 5 to 13, drizzle 80%', () => {
    const wx = { feelsNow: 10.5, actualNow: 14.5, feelsMin: 5.3, feelsMax: 13, rainChance: 80, code: 53 };
    const picks = P.pickOutfits(OUTFITS, ITEMS, wx, new Date('2026-10-27T11:15:00'));
    it('out casual: knit and denim, plus the rain jacket and the work beanie; leather boots kept', () => {
        const c = byOption(picks, 'Out casual');
        expect(c.outfit.id).toBe('Knit and denim');
        expect(names(c)).toEqual(['tee', 'jumper', 'jeans', 'tanBoots', 'rainJacket', 'oliveBeanie']);
    });
    it('out smart casual: the first eligible evening outfit, plus the coat and the evening beanie', () => {
        const s = byOption(picks, 'Out smart casual');
        expect(s.outfit.id).toBe('All black');
        expect(names(s)).toEqual(['turtleneck', 'blackJeans', 'chelsea', 'coat', 'burgundyBeanie']);
    });
    it('stay at home: no layers added', () => {
        const h = byOption(picks, 'Stay at home');
        expect(h.outfit.id).toBe('Sofa day');
        expect(h.added).toEqual([]);
    });
    it('the reason names the wind and the rain', () => {
        const r = P.reasonFor(wx, picks);
        expect(r).toContain('feel 4° colder');
        expect(r).toContain('80%');
        expect(r).toContain('beanie');
    });
});

describe('worked example 2: a dry mild May day, feels 14 to 19, rain 10%', () => {
    const wx = { feelsNow: 17, actualNow: 18, feelsMin: 14, feelsMax: 19, rainChance: 10, code: 1 };
    const picks = P.pickOutfits(OUTFITS, ITEMS, wx, new Date('2026-05-12T09:00:00'));
    it('out casual: polo and stone with nothing added (the winter knit is out of season)', () => {
        const c = byOption(picks, 'Out casual');
        expect(c.outfit.id).toBe('Polo and stone');
        expect(c.added).toEqual([]);
        expect(names(c)).toEqual(['polo', 'beige', 'belt', 'trainers']);
    });
    it('says no jacket is needed', () => {
        expect(P.reasonFor(wx, picks)).toBe('Dry and mild today, so no jacket needed.');
    });
});

describe('worked example 3: a cold dry January night, feels -1 to 4, rain 0%', () => {
    const wx = { feelsNow: 0, actualNow: 2, feelsMin: -1, feelsMax: 4, rainChance: 0, code: 0 };
    const picks = P.pickOutfits(OUTFITS, ITEMS, wx, new Date('2027-01-15T19:00:00'));
    it('out smart casual: coat, beanie and scarf', () => {
        expect(names(byOption(picks, 'Out smart casual'))).toEqual(['turtleneck', 'blackJeans', 'chelsea', 'coat', 'burgundyBeanie', 'scarf']);
    });
    it('out casual: the dry-weather jacket, not the rain jacket', () => {
        expect(names(byOption(picks, 'Out casual'))).toContain('bomber');
        expect(names(byOption(picks, 'Out casual'))).not.toContain('rainJacket');
    });
});

describe('the rules around the examples', () => {
    const date = new Date('2026-05-12T09:00:00');
    it('rain at 50% swaps trainers for the leather boots of that option, mild so no jacket', () => {
        const wx = { feelsNow: 15, actualNow: 15, feelsMin: 14, feelsMax: 18, rainChance: 50, code: 61 };
        const c = byOption(P.pickOutfits(OUTFITS, ITEMS, wx, date), 'Out casual');
        expect(names(c)).toEqual(['polo', 'beige', 'belt', 'tanBoots']);
        expect(c.added[0].replaces.id).toBe('trainers');
    });
    it('the reason only names what was added: rain with no jacket added never promises one', () => {
        const wx = { feelsNow: 15, actualNow: 15, feelsMin: 14, feelsMax: 18, rainChance: 60, code: 61 };
        const picks = P.pickOutfits(OUTFITS, ITEMS, wx, date);
        const r = P.reasonFor(wx, picks);
        expect(r).toContain('leather boots');
        expect(r).not.toContain('jacket');
    });
    it('no rain jacket owned: the casual jacket still goes on in the rain', () => {
        const noRain = { ...ITEMS, rainJacket: { ...ITEMS.rainJacket, status: 'Clear out' } };
        const wx = { feelsNow: 5, actualNow: 7, feelsMin: 5, feelsMax: 9, rainChance: 80, code: 63 };
        const c = byOption(P.pickOutfits(OUTFITS, noRain, wx, new Date('2026-10-27T09:00:00')), 'Out casual');
        expect(names(c)).toContain('bomber');
    });
    it('an unknown temperature or rain figure adds no layers at all', () => {
        const wx = { feelsNow: null, actualNow: null, feelsMin: null, feelsMax: null, rainChance: null, code: null };
        const picks = P.pickOutfits(OUTFITS, ITEMS, wx, new Date('2026-10-27T09:00:00'));
        expect(picks.flatMap(p => p.added)).toEqual([]);
        expect(P.reasonFor(wx, picks)).toBe("Nothing in today's weather changes these outfits.");
    });
    it('rain at 49% keeps the trainers', () => {
        const wx = { feelsNow: 15, actualNow: 15, feelsMin: 14, feelsMax: 18, rainChance: 49, code: 3 };
        expect(names(byOption(P.pickOutfits(OUTFITS, ITEMS, wx, date), 'Out casual'))).toContain('trainers');
    });
    it('an outfit that already has a jacket gets no second one', () => {
        const worn = OUTFITS.map(o => (o.id === 'Polo and stone' ? { ...o, lastWorn: '2026-05-11' } : o));
        const wx = { feelsNow: 8, actualNow: 9, feelsMin: 8, feelsMax: 12, rainChance: 0, code: 3 };
        const c = byOption(P.pickOutfits(worn, ITEMS, wx, date), 'Out casual');
        expect(c.outfit.id).toBe('Tee and bomber');
        expect(names(c).filter(id => ITEMS[id].type === 'Jacket')).toEqual(['bomber']);
    });
    it('rotation: the least recently worn outfit wins, and today\'s wear stays put all day', () => {
        const worn = OUTFITS.map(o => (o.id === 'Sofa day' ? { ...o, lastWorn: '2026-05-10' } : o));
        const wx = { feelsNow: 15, actualNow: 15, feelsMin: 14, feelsMax: 18, rainChance: 0, code: 0 };
        expect(byOption(P.pickOutfits(worn, ITEMS, wx, date), 'Stay at home').outfit.id).toBe('Home office');
        const today = OUTFITS.map(o => (o.id === 'Sofa day' ? { ...o, lastWorn: '2026-05-12' } : o));
        const h = byOption(P.pickOutfits(today, ITEMS, wx, date), 'Stay at home');
        expect(h.outfit.id).toBe('Sofa day');
        expect(h.wornToday).toBe(true);
    });
    it('an outfit with an item not yet owned is never offered', () => {
        const only = [OUTFITS.find(o => o.id === 'Breton weekend')];
        const wx = { feelsNow: 15, actualNow: 15, feelsMin: 14, feelsMax: 18, rainChance: 0, code: 0 };
        expect(byOption(P.pickOutfits(only, ITEMS, wx, date), 'Out casual').outfit).toBeNull();
    });
    it('season: October to March is autumn and winter', () => {
        expect(P.seasonOf(new Date('2026-10-01T12:00:00'))).toBe('Autumn and winter');
        expect(P.seasonOf(new Date('2027-03-31T12:00:00'))).toBe('Autumn and winter');
        expect(P.seasonOf(new Date('2027-04-01T12:00:00'))).toBe('Spring and summer');
    });
    it('names the weather in plain words, with a fallback', () => {
        expect(P.describeCode(53)).toBe('Drizzle');
        expect(P.describeCode(1234)).toBe('Mixed weather');
    });
});
