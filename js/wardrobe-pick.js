// ── What to wear: the weather rules and the outfit choice (Kevin, 27 Oct 2026) ──
// Pure functions, no DOM and no fetches, so the rules Kevin approved are pinned by
// tests/wardrobe-pick.test.js. js/wardrobe.js draws the card from what this returns.
//
// Each outfit is only its base clothes. The weather adds the rest (the plan Kevin approved):
//   - out casual: a feels-like low under 12° adds a jacket, the rain jacket when rain is 50%+
//   - out smart casual: a feels-like low under 10° adds the smart coat
//   - rain 50%+ swaps trainers for the leather boots of that option
//   - a low of 6° or below adds a beanie, 4° or below a scarf
// Stay at home gets no layers. An outfit that already has a jacket or coat gets no extra one.
(function (root) {
    'use strict';

    const OPTIONS = ['Stay at home', 'Out casual', 'Out smart casual'];
    const OWNED = ['Own', 'Bought'];
    const RAIN_PCT = 50;
    const JACKET_BELOW = 12;
    const COAT_BELOW = 10;
    const BEANIE_AT = 6;
    const SCARF_AT = 4;

    // WMO weather codes (Open-Meteo) in plain words.
    const WMO = {
        0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
        51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
        61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
        71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
        80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Heavy snow showers',
        95: 'Thunderstorms', 96: 'Thunderstorms with hail', 99: 'Thunderstorms with hail',
    };
    function describeCode(code) { return WMO[code] || 'Mixed weather'; }

    // October to March is autumn and winter; April to September spring and summer.
    function seasonOf(date) {
        const m = date.getMonth();
        return (m >= 9 || m <= 2) ? 'Autumn and winter' : 'Spring and summer';
    }

    function isoDay(date) {
        return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    }

    function owned(item) { return !!item && OWNED.includes(item.status); }
    function isOuter(item) { return !!item && (item.type === 'Jacket' || item.type === 'Coat'); }

    function byRole(itemsById, role, prefer) {
        const all = Object.values(itemsById).filter(it => owned(it) && it.layerRole === role);
        return all.find(it => prefer && (it.usedFor || []).includes(prefer)) || all[0] || null;
    }

    // The outfit for one option: today's worn one if any, else the least recently worn eligible one,
    // ties going to list order. Eligible = this option, this season (or All), every item owned.
    function chooseBase(outfits, itemsById, option, date) {
        const season = seasonOf(date);
        const today = isoDay(date);
        const eligible = outfits
            .map((o, i) => ({ o, i }))
            .filter(({ o }) => o.option === option && (o.season === 'All' || o.season === season)
                && o.itemIds.length > 0 && o.itemIds.every(id => owned(itemsById[id])));
        if (!eligible.length) return null;
        const wornToday = eligible.find(({ o }) => o.lastWorn === today);
        if (wornToday) return wornToday.o;
        eligible.sort((a, b) => {
            const la = a.o.lastWorn || '', lb = b.o.lastWorn || '';
            return la === lb ? a.i - b.i : (la < lb ? -1 : 1);
        });
        return eligible[0].o;
    }

    function applyWeather(base, itemsById, option, wx) {
        const items = base.itemIds.map(id => itemsById[id]);
        const added = [];
        if (option === 'Stay at home') return { items, added };
        const known = (v) => typeof v === 'number' && isFinite(v);
        const rainy = known(wx.rainChance) && wx.rainChance >= RAIN_PCT;
        const cold = known(wx.feelsMin);   // an unknown low adds nothing, never every layer
        const casual = option === 'Out casual';
        const add = (it, why) => { if (it && !items.includes(it)) { items.push(it); added.push({ item: it, why }); } };

        if (!items.some(isOuter) && cold) {
            if (casual && wx.feelsMin < JACKET_BELOW) {
                // No rain jacket owned: the casual jacket still goes on, never nothing.
                const jacket = rainy ? (byRole(itemsById, 'Rain jacket') || byRole(itemsById, 'Casual jacket')) : byRole(itemsById, 'Casual jacket');
                add(jacket, rainy ? 'rain' : 'cold');
            } else if (!casual && wx.feelsMin < COAT_BELOW) {
                add(byRole(itemsById, 'Smart coat'), 'cold');
            }
        }
        if (rainy) {
            const shoe = items.find(it => it.type === 'Shoes');
            const boots = byRole(itemsById, casual ? 'Leather boots casual' : 'Leather boots smart');
            if (boots && shoe && !/^Leather boots/.test(shoe.layerRole || '')) {
                items.splice(items.indexOf(shoe), 1, boots);
                added.push({ item: boots, why: 'rain', replaces: shoe });
            }
        }
        if (cold && wx.feelsMin <= BEANIE_AT) add(byRole(itemsById, 'Beanie', casual ? 'Work' : 'Evening'), 'cold');
        if (cold && wx.feelsMin <= SCARF_AT) add(byRole(itemsById, 'Scarf'), 'cold');
        return { items, added };
    }

    // One plain sentence on what the weather changed, built from what was actually added to the
    // outfits going out, so it never promises a layer the card does not show.
    function reasonFor(wx, picks) {
        const known = (v) => typeof v === 'number' && isFinite(v);
        const adds = (picks || []).filter(p => p.option !== 'Stay at home').flatMap(p => p.added);
        const has = (why, type) => adds.some(a => a.why === why && (!type || a.item.type === type || a.item.layerRole === type));
        const parts = [];
        const gap = known(wx.actualNow) && known(wx.feelsNow) ? Math.round(wx.actualNow - wx.feelsNow) : 0;
        if (gap >= 3) parts.push(`the wind makes it feel ${gap}° colder than it is`);
        if (known(wx.rainChance) && wx.rainChance >= RAIN_PCT) {
            const cover = [has('rain', 'Jacket') ? 'a jacket that sheds rain' : '', adds.some(a => a.replaces) ? 'leather boots, not trainers' : ''].filter(Boolean);
            parts.push(`rain is likely (${Math.round(wx.rainChance)}%)` + (cover.length ? `, so ${cover.join(' and ')}` : ', and these outfits already cover it'));
        }
        if (has('cold', 'Coat') || has('cold', 'Jacket')) parts.push(`it feels as low as ${Math.round(wx.feelsMin)}°, so a warm layer on top`);
        if (has('cold', 'Scarf')) parts.push('a beanie and scarf for the coldest part of the day');
        else if (has('cold', 'Beanie')) parts.push(`a beanie for later, when it drops to ${Math.round(wx.feelsMin)}°`);
        if (!parts.length) {
            return known(wx.feelsMin) && wx.feelsMin >= JACKET_BELOW ? 'Dry and mild today, so no jacket needed.' : 'Nothing in today\'s weather changes these outfits.';
        }
        const s = parts.join('; ');
        return s.charAt(0).toUpperCase() + s.slice(1) + '.';
    }

    function pickOutfits(outfits, itemsById, wx, date) {
        return OPTIONS.map(option => {
            const base = chooseBase(outfits, itemsById, option, date);
            if (!base) return { option, outfit: null, items: [], added: [], wornToday: false };
            const { items, added } = applyWeather(base, itemsById, option, wx);
            return { option, outfit: base, items, added, wornToday: base.lastWorn === isoDay(date) };
        });
    }

    // The option marked "Best for today": the one he is already wearing, else Out casual (his normal
    // work day of cafés and viewings), else whichever option has an outfit.
    function bestOption(picks) {
        const worn = picks.find(p => p.wornToday);
        if (worn) return worn.option;
        return picks.find(p => p.option === 'Out casual' && p.outfit) ? 'Out casual' : (picks.find(p => p.outfit) || {}).option || null;
    }

    const api = { OPTIONS, describeCode, seasonOf, isoDay, chooseBase, applyWeather, reasonFor, pickOutfits, bestOption,
        RULES: { RAIN_PCT, JACKET_BELOW, COAT_BELOW, BEANIE_AT, SCARF_AT } };
    root.WardrobePick = api;
})(typeof window !== 'undefined' ? window : globalThis);
