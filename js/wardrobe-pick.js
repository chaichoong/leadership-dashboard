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
//
// Washing (Kevin, 29 Oct 2026): each day a piece is worn adds one wear. At its limit (by Type, or its
// own Wash every; 0 = never counted) it goes in the wash and is not offered for 2 days, then counts as
// clean again on its own. The outfit worn longest ago, judged by its washable pieces too, comes first.
//
// Pyjamas (Kevin, 31 Oct 2026): their own Type, 3 nights to a wash, picked for tonight on their own and
// never part of the day's outfits or its "I'm wearing something else" log.
(function (root) {
    'use strict';

    const OPTIONS = ['Stay at home', 'Out casual', 'Out smart casual'];
    const OWNED = ['Own', 'Bought'];
    const RAIN_PCT = 50;
    const JACKET_BELOW = 12;
    const COAT_BELOW = 10;
    const BEANIE_AT = 6;
    const SCARF_AT = 4;
    // Kevin, 31 Oct 2026: lounge pieces (hoodies, sweatshirts, joggers) go over a tee, so 3 wears, not 1; shirts 2.
    // Sport kit and the dressing gown carry their own Wash every (1 and 7) on the piece.
    const WASH_DEFAULT = { Tee: 1, Shirt: 2, Lounge: 3, Knit: 3, Trousers: 5, Shorts: 5, Pyjamas: 3 };   // anything else is never counted
    const CLEAN_AFTER_DAYS = 2;

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

    // ── Washing ──
    function addDays(iso, n) {
        const d = new Date(iso + 'T12:00:00Z');
        d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
    }
    function washLimit(item) {
        return typeof item.washEvery === 'number' && item.washEvery >= 0 ? item.washEvery : (WASH_DEFAULT[item.type] || 0);
    }
    function cleanOn(item) { return item && item.inWashSince ? addDays(item.inWashSince, CLEAN_AFTER_DAYS) : null; }
    function inWash(item, today) { const c = cleanOn(item); return !!c && today < c; }
    // Wears that count now: back from the wash means a clean start.
    function wearsNow(item, today) {
        if (item.inWashSince && !inWash(item, today)) return 0;
        return typeof item.wears === 'number' && item.wears > 0 ? item.wears : 0;
    }
    // The fields to save when a piece is worn today, or null when today is already logged on it.
    function wearFields(item, today) {
        if (item.lastWorn === today) return null;
        // Already in the wash and worn anyway: one more wear, same wash date, so taking it back leaves it in the wash.
        if (inWash(item, today)) return { lastWorn: today, prevWorn: item.lastWorn || null, wears: (item.wears || 0) + 1, inWashSince: item.inWashSince };
        const limit = washLimit(item);
        const wears = limit > 0 ? wearsNow(item, today) + 1 : wearsNow(item, today);
        return { lastWorn: today, prevWorn: item.lastWorn || null, wears, inWashSince: limit > 0 && wears >= limit ? today : null };
    }
    // The fields that take today's wear back off a piece, or null when it was not logged today.
    function unwearFields(item, today) {
        if (item.lastWorn !== today) return null;
        const counted = washLimit(item) > 0;
        return { lastWorn: item.prevWorn || null, prevWorn: null, wears: Math.max(0, (item.wears || 0) - (counted ? 1 : 0)),
            inWashSince: item.inWashSince === today ? null : (item.inWashSince || null) };
    }
    // When the outfit was last worn, counting a washable piece worn in some other mix.
    // A twin worn counts as this piece worn, so the same look is not offered two days running.
    function freshness(o, itemsById) {
        return o.itemIds.reduce((m, id) => {
            const it = itemsById[id];
            if (!it || washLimit(it) <= 0) return m;
            return twins(itemsById, it).concat(it).reduce((mm, t) => ((t.lastWorn || '') > mm ? t.lastWorn : mm), m);
        }, o.lastWorn || '');
    }
    // Twins (Kevin, 31 Oct 2026): pieces sharing a Twin group are identical, so an outfit's piece is
    // stood in for by a twin: the piece itself if clean, else a clean twin. For the outfit worn today
    // (wornToday) the one worn today comes first, so the card shows what is on. null when none is clean.
    function twins(itemsById, it) {
        const group = it && it.twinGroup ? Object.values(itemsById).filter(o => owned(o) && o.twinGroup === it.twinGroup) : [];
        return owned(it) ? [it, ...group.filter(o => o !== it)] : group;
    }
    function standIn(itemsById, id, today, wornToday) {
        const all = twins(itemsById, itemsById[id]);
        return (wornToday && all.find(o => o.lastWorn === today)) || all.find(o => !inWash(o, today)) || null;
    }
    function isOuter(item) { return !!item && (item.type === 'Jacket' || item.type === 'Coat'); }
    function isNightwear(item) { return !!item && item.type === 'Pyjamas'; }

    // Tonight's pyjamas: the pair already logged tonight; else the pair part-way through its nights
    // (worn since its last wash), so one pair is finished before the next is started; else the clean
    // pair worn longest ago, ties by name. null when no owned pair is out of the wash.
    // night = which night of its cycle tonight is; washAfter = the last night before it goes in the wash.
    function pickPyjamas(itemsById, date) {
        const today = isoDay(date);
        const pairs = Object.values(itemsById).filter(it => owned(it) && isNightwear(it));
        const plan = (item, wornTonight) => {
            const limit = washLimit(item);
            const night = wearsNow(item, today) + (wornTonight ? 0 : 1);
            return { item, wornTonight, night, limit, washAfter: limit > 0 ? addDays(today, Math.max(0, limit - night)) : null };
        };
        const tonight = pairs.find(it => it.lastWorn === today);
        if (tonight) return plan(tonight, true);
        const clean = pairs.filter(it => !inWash(it, today));
        if (!clean.length) return null;
        const byName = (a, b) => a.name.localeCompare(b.name);
        const going = clean.filter(it => wearsNow(it, today) > 0).sort((a, b) => (b.lastWorn || '').localeCompare(a.lastWorn || '') || byName(a, b))[0];
        return plan(going || clean.slice().sort((a, b) => (a.lastWorn || '').localeCompare(b.lastWorn || '') || byName(a, b))[0], false);
    }

    function byRole(itemsById, role, prefer, today) {
        const all = Object.values(itemsById).filter(it => owned(it) && it.layerRole === role && !(today && inWash(it, today)));
        return all.find(it => prefer && (it.usedFor || []).includes(prefer)) || all[0] || null;
    }

    // The outfit for one option: today's worn one if any, else the least recently worn eligible one,
    // ties going to list order. Eligible = this option, this season (or All), every item owned and none
    // in the wash. Least recently worn counts its washable pieces' own dates too.
    function chooseBase(outfits, itemsById, option, date) {
        const season = seasonOf(date);
        const today = isoDay(date);
        const eligible = outfits
            .map((o, i) => ({ o, i }))
            .filter(({ o }) => o.option === option && (o.season === 'All' || o.season === season)
                && o.itemIds.length > 0 && o.itemIds.every(id => twins(itemsById, itemsById[id]).length > 0));
        const wornToday = eligible.find(({ o }) => o.lastWorn === today);
        if (wornToday) return wornToday.o;
        const clean = eligible.filter(({ o }) => o.itemIds.every(id => standIn(itemsById, id, today)));
        if (!clean.length) return null;
        clean.forEach(e => { e.f = freshness(e.o, itemsById); });
        clean.sort((a, b) => {
            const la = a.f, lb = b.f;
            return la === lb ? a.i - b.i : (la < lb ? -1 : 1);
        });
        return clean[0].o;
    }

    function applyWeather(base, itemsById, option, wx, today) {
        const items = base.itemIds.map(id => (today && standIn(itemsById, id, today, base.lastWorn === today)) || itemsById[id]);
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
                const jacket = rainy ? (byRole(itemsById, 'Rain jacket', null, today) || byRole(itemsById, 'Casual jacket', null, today)) : byRole(itemsById, 'Casual jacket', null, today);
                add(jacket, rainy ? 'rain' : 'cold');
            } else if (!casual && wx.feelsMin < COAT_BELOW) {
                add(byRole(itemsById, 'Smart coat', null, today), 'cold');
            }
        }
        if (rainy) {
            const shoe = items.find(it => it.type === 'Shoes');
            const boots = byRole(itemsById, casual ? 'Leather boots casual' : 'Leather boots smart', null, today);
            if (boots && shoe && !/^Leather boots/.test(shoe.layerRole || '')) {
                items.splice(items.indexOf(shoe), 1, boots);
                added.push({ item: boots, why: 'rain', replaces: shoe });
            }
        }
        if (cold && wx.feelsMin <= BEANIE_AT) add(byRole(itemsById, 'Beanie', casual ? 'Work' : 'Evening', today), 'cold');
        if (cold && wx.feelsMin <= SCARF_AT) add(byRole(itemsById, 'Scarf', null, today), 'cold');
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
            const { items, added } = applyWeather(base, itemsById, option, wx, isoDay(date));
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
        washLimit, cleanOn, inWash, wearsNow, wearFields, unwearFields, isNightwear, pickPyjamas, addDays, standIn,
        RULES: { RAIN_PCT, JACKET_BELOW, COAT_BELOW, BEANIE_AT, SCARF_AT, WASH_DEFAULT, CLEAN_AFTER_DAYS } };
    root.WardrobePick = api;
})(typeof window !== 'undefined' ? window : globalThis);
