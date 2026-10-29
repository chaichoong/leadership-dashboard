// ── Wardrobe (Kevin, 27 Oct 2026) ──
// Two surfaces, one data read:
//   1. The "What to wear today" card at the top of My Dashboard (#homeWear): day, date, place, the
//      feels-like temperature, today's conditions, one plain reason, and three options (Stay at home,
//      Out casual, Out smart casual), each with a Wearing button that stamps today's date on the outfit
//      and its clothes so tomorrow rotates to something else.
//   2. The Wardrobe page (#tab-wardrobe): current clothes, recommended additions, and the clear-out.
//      Since 28 Oct 2026 (Kevin) it also edits the list: add a piece (optionally in place of an old one,
//      which hands it that piece's outfits), mark a new piece arrived, remove a piece (to Get rid of, never
//      deleted), mark an addition bought, or keep a piece after all. The picks read the same list.
// The rules live in js/wardrobe-pick.js (pinned by tests/wardrobe-pick.test.js). The clothes live only
// in Airtable (TABLES.wardrobe, TABLES.outfits): this repo is public. Weather comes from Open-Meteo
// (free, no key) at the browser's location when it has permission, else WEATHER_FALLBACK.
// Nothing in shared.js or home.js changes: MutationObservers watch the two panels' active class.
(function () {
    'use strict';
    const TAB = 'wardrobe';
    const WEATHER_MAX_AGE_MS = 15 * 60 * 1000;   // Open-Meteo's "current" moves every 15 minutes (Kevin, 29 Oct 2026: exact conditions)
    const HOUR_FROM = 6;            // the hourly strip runs 06:00 to 23:00 (Kevin, 28 Oct 2026)
    const WINDY_MPH = 15;           // the wind chip turns amber from here (was 25 km/h)
    const state = { data: null, dataError: null, loading: null, wx: null, wxError: null, wxAt: 0, wxDay: '', wxLoading: null, wxTriedAt: 0, wxTriedHour: null, shownHour: null, saving: false, view: 'own', form: null, other: false };   // form: null, 'add' or the id of the piece being removed; other: the I'm wearing something else picker is open
    const UNKNOWN_WX = { feelsNow: null, actualNow: null, feelsMin: null, feelsMax: null, rainChance: null, code: null };

    const signedIn = () => typeof PAT === 'string' && PAT.length > 0;
    const esc = (s) => escHtml(s == null ? '' : String(s));
    const swatch = (hex) => (/^#[0-9a-f]{3,8}$/i.test(hex || '') ? hex : 'var(--bg-subtle)');
    const P = () => window.WardrobePick;
    const today = () => P().isoDay(new Date());

    // ── Data ──
    async function loadData(force) {
        if (!force && state.data) return;
        if (state.loading && !force) return state.loading;
        state.loading = (async () => {
            try {
                const [wr, of] = await Promise.all([airtableFetch(TABLES.wardrobe), airtableFetch(TABLES.outfits)]);
                const items = {};
                wr.forEach(r => {
                    items[r.id] = {
                        id: r.id, name: getField(r, WR.name) || '(unnamed)', type: getField(r, WR.type) || '',
                        colour: getField(r, WR.colour) || '', swatch: getField(r, WR.swatch) || '',
                        usedFor: getField(r, WR.usedFor) || [], status: getField(r, WR.status) || '',
                        action: getField(r, WR.action) || '', layerRole: getField(r, WR.layerRole) || '',
                        buyIn: getField(r, WR.buyIn) || '', cap: getField(r, WR.cap) || '', reason: getField(r, WR.reason) || '',
                        lastWorn: getField(r, WR.lastWorn) || null, prevWorn: getField(r, WR.prevWorn) || null,
                        wears: getField(r, WR.wears) || 0, inWashSince: getField(r, WR.inWashSince) || null,
                        washEvery: typeof getField(r, WR.washEvery) === 'number' ? getField(r, WR.washEvery) : null,
                    };
                });
                // List order = the Order field (Kevin's plan order), so "the first eligible outfit" is the one he
                // approved at the gate; rows without one go last, oldest first. The API's own order means nothing,
                // and rows loaded together share a createdTime to the second (live, 27 Oct 2026).
                const rank = (r) => { const n = getField(r, OF.order); return typeof n === 'number' ? n : Infinity; };
                of.sort((a, b) => (rank(a) - rank(b)) || (a.createdTime < b.createdTime ? -1 : a.createdTime > b.createdTime ? 1 : 0));
                const outfits = of.map(r => ({
                    id: r.id, name: getField(r, OF.name) || '(unnamed)', option: getField(r, OF.option) || '',
                    itemIds: getField(r, OF.items) || [], season: getField(r, OF.season) || 'All',
                    why: getField(r, OF.why) || '', lastWorn: getField(r, OF.lastWorn) || null, prevWorn: getField(r, OF.prevWorn) || null,
                }));
                state.data = { items, outfits, at: Date.now() };
                state.dataError = null;
            } catch (err) {
                console.error('[wardrobe] Could not read the Wardrobe or Outfits table:', err);
                state.dataError = err && err.message === 'Auth failed' ? 'Your sign-in has expired.' : 'Your wardrobe could not be read from Airtable.';
            } finally {
                state.loading = null;
            }
        })();
        return state.loading;
    }

    function coords() {
        const fallback = Object.assign({ mine: false }, WEATHER_FALLBACK);
        if (!navigator.geolocation || !navigator.permissions) return Promise.resolve(fallback);
        return navigator.permissions.query({ name: 'geolocation' }).then(p => (p.state !== 'granted' ? fallback
            : new Promise(res => navigator.geolocation.getCurrentPosition(
                pos => res({ lat: pos.coords.latitude, lon: pos.coords.longitude, place: 'Your location', mine: true }),
                () => res(fallback), { timeout: 6000, maximumAge: 30 * 60 * 1000 }))))
            .catch(() => fallback);
    }

    function loadWeather(force) {
        if (!force && state.wx && Date.now() - state.wxAt < WEATHER_MAX_AGE_MS && state.wxDay === today()) return Promise.resolve();
        if (state.wxLoading) return state.wxLoading;
        state.wxLoading = readWeather().finally(() => { state.wxLoading = null; });
        return state.wxLoading;
    }
    async function readWeather() {
        state.wxTriedAt = Date.now(); state.wxTriedHour = placeHour(state.wx);   // followTheHour retries a failed read once an hour or every 15 minutes, never every minute
        try {
            const c = await coords();
            const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(c.lat.toFixed(3)) + '&longitude=' + encodeURIComponent(c.lon.toFixed(3))
                + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m'
                + '&daily=apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,weather_code,sunset'
                + '&hourly=apparent_temperature,precipitation,wind_speed_10m&wind_speed_unit=mph&timezone=auto&forecast_days=1';
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('weather ' + resp.status);
            const d = await resp.json();
            const cur = d.current || {}, day = d.daily || {};
            const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
            // Hour by hour, 6am to midnight (Kevin, 28 Oct 2026). The times are the place's own clock (timezone=auto).
            const hr = d.hourly || {};
            const hours = (hr.time || []).map((t, i) => ({ hour: Number((/T(\d\d)/.exec(t) || [])[1]), feels: n((hr.apparent_temperature || [])[i]),
                rainMm: n((hr.precipitation || [])[i]), wind: n((hr.wind_speed_10m || [])[i]) }))
                .filter(h => h.hour >= HOUR_FROM && h.hour <= 23);
            const wx = {
                feelsNow: n(cur.apparent_temperature), actualNow: n(cur.temperature_2m), wind: n(cur.wind_speed_10m),
                feelsMin: n((day.apparent_temperature_min || [])[0]), feelsMax: n((day.apparent_temperature_max || [])[0]),
                rainChance: n((day.precipitation_probability_max || [])[0]), code: n((day.weather_code || [])[0]) ?? n(cur.weather_code),
                place: c.place, mine: c.mine, hours,
                sunset: (/T(\d\d:\d\d)/.exec((day.sunset || [])[0] || '') || [])[1] || null,   // the place's own clock
                timezone: typeof d.timezone === 'string' ? d.timezone : null,
            };
            if (wx.feelsNow == null || wx.feelsMin == null || wx.feelsMax == null) throw new Error('weather reply missing temperatures');
            state.wx = wx; state.wxError = null; state.wxAt = Date.now(); state.wxDay = today();
        } catch (err) {
            console.error('[wardrobe] Weather read failed:', err);
            state.wxError = 'Today\'s weather could not be read, so the options below ignore it.';
            if (state.wxDay !== today()) state.wx = null;   // never show yesterday's weather as today's
        }
    }

    // ── What to wear today (My Dashboard) ──
    function itemRow(it, addedBy) {
        const tag = addedBy ? `<span class="wear-added">${addedBy.replaces ? 'for the rain, instead of ' + esc(addedBy.replaces.name) : 'for the ' + esc(addedBy.why)}</span>` : '';
        return `<li><i class="wear-sw" style="background:${swatch(it.swatch)}" aria-hidden="true"></i><span class="wear-name">${esc(it.name)}${tag}</span></li>`;
    }

    function optionCard(pick, best) {
        const isBest = pick.option === best;
        if (!pick.outfit) {
            return `<article class="wear-opt"><h3>${esc(pick.option)}</h3><p class="wear-note">No outfit ready today: each one for this option has a piece in the wash or is out of season.</p></article>`;
        }
        const addedById = new Map(pick.added.map(a => [a.item.id, a]));
        const btn = pick.wornToday
            ? '<button type="button" class="wear-btn wear-btn-done" disabled>Wearing today</button>'
            : `<button type="button" class="wear-btn${isBest ? ' wear-btn-primary' : ''}" data-wear-option="${esc(pick.option)}"${state.saving ? ' disabled' : ''}>Wearing this</button>`;
        return `<article class="wear-opt${isBest ? ' wear-opt-best' : ''}">
            <h3><span>${esc(pick.option)}</span>${isBest ? `<span class="wear-best">${pick.wornToday ? 'Today' : 'Best for today'}</span>` : ''}</h3>
            <p class="wear-outfit">${esc(pick.outfit.name)}</p>
            <ul>${pick.items.map(it => itemRow(it, addedById.get(it.id))).join('')}</ul>
            ${pick.outfit.why ? `<p class="wear-note">${esc(pick.outfit.why)}</p>` : ''}
            ${btn}
        </article>`;
    }

    // One column per hour: feels-like °C, rain in mm, wind in mph. Hours gone are faded, this hour is marked.
    // The hour now on the weather place's clock, the clock the hourly times are in (by zone name, so a clock-change day
    // stays right); the device clock if the reply named no zone.
    function placeHour(wx) {
        try {
            if (wx && wx.timezone) return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: wx.timezone }).format(new Date()));
        } catch (err) { console.error('[wardrobe] Unknown weather timezone:', wx.timezone, err); }
        return new Date().getHours();
    }
    function hourStrip(hours, now, sunset) {
        const sunHour = sunset ? Number(sunset.slice(0, 2)) : null;   // the column that holds sunset gets a gold label (Kevin, 29 Oct 2026)
        if (!hours || !hours.length) return '';
        const fmt1 = (v) => (v == null ? '–' : (Math.round(v * 10) / 10).toFixed(1));
        const cell = (h, body, extra) => `<td class="${h.hour < now ? 'wear-past' : h.hour === now ? 'wear-now' : ''}${extra || ''}">${body}</td>`;
        return `<div class="wear-hours" role="region" aria-label="Today hour by hour" tabindex="0"><table>
            <thead><tr><th scope="row">Time</th>${hours.map(h => `<th scope="col" class="${h.hour < now ? 'wear-past' : h.hour === now ? 'wear-now' : ''}"${h.hour === now ? ' aria-current="time"' : ''}>${String(h.hour).padStart(2, '0')}:00${h.hour === sunHour ? `<span class="wear-sunset">Sunset ${esc(sunset)}</span>` : ''}</th>`).join('')}</tr></thead>
            <tbody>
                <tr><th scope="row">Feels like</th>${hours.map(h => cell(h, h.feels == null ? '–' : Math.round(h.feels) + '°')).join('')}</tr>
                <tr><th scope="row">Rain (mm)</th>${hours.map(h => cell(h, fmt1(h.rainMm), h.rainMm > 0 ? ' wear-wet' : '')).join('')}</tr>
                <tr><th scope="row">Wind (mph)</th>${hours.map(h => cell(h, h.wind == null ? '–' : Math.round(h.wind), h.wind >= WINDY_MPH ? ' wear-windy' : '')).join('')}</tr>
            </tbody></table></div>`;
    }

    function currentPicks() {
        const wx = state.wx || UNKNOWN_WX;   // no weather: no layers, never a guess
        return P().pickOutfits(state.data.outfits, state.data.items, wx, new Date());
    }

    // "I'm wearing something else" (Kevin, 29 Oct 2026): tick the pieces actually on, starting from today's
    // log or the best option. What it saves feeds the rotation and the wash count like Wearing this does.
    const TYPE_ORDER = ['Tee', 'Shirt', 'Knit', 'Lounge', 'Trousers', 'Shorts', 'Jacket', 'Coat', 'Shoes', 'Accessory'];
    function otherBlock(picks, best) {
        const date = today();
        const all = Object.values(state.data.items).filter(it => it.status === 'Own' || it.status === 'Bought');
        const wornNow = all.filter(it => it.lastWorn === date);
        const dis = state.saving ? ' disabled' : '';
        if (!state.other) {
            const pressed = picks.some(p => p.wornToday);
            return wornNow.length && !pressed
                ? `<p class="wear-logged" role="status"><b>Wearing today:</b> ${wornNow.map(it => esc(it.name)).join(', ')} <button type="button" class="wear-link" data-wear-other${dis}>Change</button></p>`
                : `<p class="wear-otherbar"><button type="button" class="wear-btn" data-wear-other${dis}>I'm wearing something else</button></p>`;
        }
        const bestPick = picks.find(p => p.option === best);
        const ticked = new Set((wornNow.length ? wornNow : (bestPick ? bestPick.items : [])).map(it => it.id));
        const rank = (t) => { const i = TYPE_ORDER.indexOf(t); return i < 0 ? TYPE_ORDER.length : i; };
        const types = [...new Set(all.map(it => it.type || 'Other'))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
        const box = (it) => {
            const wash = P().inWash(it, date) ? ` <small>in the wash until ${esc(fmtDay(P().cleanOn(it)))}</small>` : '';
            return `<label><input type="checkbox" name="piece" value="${esc(it.id)}"${ticked.has(it.id) ? ' checked' : ''}> <i class="wear-sw" style="background:${swatch(it.swatch)}" aria-hidden="true"></i> ${esc(it.name)}${wash}</label>`;
        };
        return `<form class="wear-otherform" data-wear-otherform aria-labelledby="wearOtherTitle">
            <h3 id="wearOtherTitle">What are you wearing today?</h3>
            <p class="wear-note">Tick everything you have on. It saves today against each piece, so the card rotates and knows what needs washing.</p>
            <div class="wear-othergrid">${types.map(t => `<fieldset><legend>${esc(t)}</legend>${all.filter(it => (it.type || 'Other') === t).sort((a, b) => a.name.localeCompare(b.name)).map(box).join('')}</fieldset>`).join('')}</div>
            <div class="wr-formbtns"><button type="submit" class="wear-btn wear-btn-primary"${dis}>${state.saving ? 'Saving…' : 'Save what I\'m wearing'}</button><button type="button" class="wear-btn" data-wear-othercancel${dis}>Cancel</button></div>
        </form>`;
    }

    function renderHomeCard() {
        const el = document.getElementById('homeWear');
        if (!el) return;
        if (!signedIn()) { el.hidden = true; return; }
        el.hidden = false;
        // Local time on the device, the same clock Wearing stamps with, so abroad the two always agree.
        const dateLine = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        const wx = state.wx;
        const place = wx ? wx.place : WEATHER_FALLBACK.place;
        const head = `<div class="wear-head">
            <div><div class="wear-date">${esc(dateLine)} · ${esc(place)}</div><h2 id="homeWearTitle">What to wear today</h2></div>
            ${wx ? `<div class="wear-wx">
                <div class="wear-temp">${Math.round(wx.feelsNow)}°C<small>Feels like now${wx.actualNow != null ? ` (actual ${Math.round(wx.actualNow)}°C)` : ''}</small></div>
                <div class="wear-chips">
                    <span class="wear-chip">${esc(P().describeCode(wx.code))}</span>
                    <span class="wear-chip">Feels ${Math.round(wx.feelsMin)}° to ${Math.round(wx.feelsMax)}° today</span>
                    ${wx.rainChance != null ? `<span class="wear-chip${wx.rainChance >= P().RULES.RAIN_PCT ? ' wear-chip-rain' : ''}">Rain ${Math.round(wx.rainChance)}%</span>` : ''}
                    ${wx.wind != null ? `<span class="wear-chip${wx.wind >= WINDY_MPH ? ' wear-chip-wind' : ''}">Wind ${Math.round(wx.wind)} mph</span>` : ''}
                    ${wx.sunset ? `<span class="wear-chip wear-chip-sun">Sunset ${esc(wx.sunset)}</span>` : ''}
                </div></div>` : ''}
        </div>${wx ? hourStrip(wx.hours, placeHour(wx), wx.sunset) : ''}`;
        state.shownHour = wx ? placeHour(wx) : null;   // followTheHour redraws when the clock moves past it
        if (state.dataError) {
            el.innerHTML = head + `<p class="wear-error">${esc(state.dataError)} Press Refresh in the Wardrobe page's bar to try again.</p>`;
            return;
        }
        if (!state.data) { el.innerHTML = head + '<p class="wear-muted">Choosing today\'s outfits…</p>'; return; }
        if (!state.data.outfits.length) { el.innerHTML = head + '<p class="wear-muted">No outfits yet. Add them in the Outfits table in Airtable.</p>'; return; }
        const picks = currentPicks();
        const best = P().bestOption(picks);
        const why = wx ? `<p class="wear-why" role="status"><b>Why:</b> ${esc(P().reasonFor(wx, picks))}</p>` : `<p class="wear-error" role="status">${esc(state.wxError || 'Reading today\'s weather…')}</p>`;
        const stale = wx && state.wxError ? `<p class="wear-error">The weather could not be read again, so this is the reading from ${esc(new Date(state.wxAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}.</p>` : '';
        const locate = wx && !wx.mine && navigator.geolocation ? '<button type="button" class="wear-link" data-wear-locate>Use my location</button>' : '';
        el.innerHTML = head + stale + why
            + `<div class="wear-opts">${picks.map(p => optionCard(p, best)).join('')}</div>`
            + otherBlock(picks, best)
            + `<p class="wear-src">Weather from Open-Meteo for ${esc(place)}. ${locate}<button type="button" class="wear-link" data-wear-open>Open your wardrobe</button></p>`;
    }

    // landed (optional) collects the ids of each batch Airtable accepted, so an undo touches only those.
    async function patchRecords(table, records, landed) {
        for (let i = 0; i < records.length; i += 10) {
            const body = JSON.stringify({ records: records.slice(i, i + 10) });
            let resp;
            for (let attempt = 0; attempt < 3; attempt++) {
                resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${table}`, {
                    method: 'PATCH', headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' }, body });
                if (resp.status !== 429) break;
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
            if (!resp.ok) throw new Error('save failed: ' + resp.status);
            if (landed) records.slice(i, i + 10).forEach(r => landed.push(r.id));
        }
    }

    async function sendJson(method, url, body) {
        let resp;
        for (let attempt = 0; attempt < 3; attempt++) {
            resp = await fetch(url, { method, headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
            if (resp.status !== 429) break;
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
        if (!resp.ok) throw new Error(method + ' failed: ' + resp.status);
        return resp.json();
    }
    const tableUrl = (table) => `https://api.airtable.com/v0/${BASE_ID}/${table}`;

    // ── Editing the list (Kevin, 28 Oct 2026) ──
    // Every edit is one or more writes with an undo for each, the same pattern as Wearing; then the list is
    // read again from Airtable, so the page and today's picks show what Airtable holds, never a local guess.
    async function runEdit(steps, okMsg) {
        if (state.saving) return false;
        state.saving = true;
        renderWardrobePage();
        const done = [];
        let ok = true;
        try {
            for (const st of steps) { st.result = await st.doIt(done); done.push(st); }
        } catch (err) {
            ok = false;
            console.error('[wardrobe] Could not save the wardrobe change:', err);
            let undone = true;
            for (const st of done.reverse()) {
                try { await st.undo(); } catch (e) { undone = false; console.error('[wardrobe] Could not undo a part-saved change:', e); }
            }
            showToast(undone ? 'That did not save, so nothing changed. Try again in a moment.'
                : 'Only part of that saved. Press Refresh on the Wardrobe page to see what Airtable holds.', { type: 'error', duration: 8000 });
        }
        if (ok) { state.form = null; showToast(okMsg, { type: 'success' }); }
        await loadData(true);
        state.saving = false;
        renderWardrobePage();
        renderHomeCard();
        return ok;
    }

    function setStatus(id, fields, okMsg) {
        const it = state.data && state.data.items[id];
        if (!it) return;
        const before = { [WR.status]: it.status || null, [WR.action]: it.action || null, [WR.reason]: it.reason || null };
        const after = Object.assign({}, before, fields);
        return runEdit([{ doIt: () => patchRecords(TABLES.wardrobe, [{ id, fields: after }]), undo: () => patchRecords(TABLES.wardrobe, [{ id, fields: before }]) }], okMsg);
    }

    // Save some of a piece's fields; the undo puts back what the page last read for the same fields.
    function setFields(id, fields, okMsg) {
        const it = state.data && state.data.items[id];
        if (!it) return;
        const keyOf = Object.fromEntries(Object.entries(WR).map(([k, v]) => [v, k]));
        const before = Object.fromEntries(Object.keys(fields).map(f => [f, it[keyOf[f]] == null ? null : it[keyOf[f]]]));
        return runEdit([{ doIt: () => patchRecords(TABLES.wardrobe, [{ id, fields }]), undo: () => patchRecords(TABLES.wardrobe, [{ id, fields: before }]) }], okMsg);
    }

    // Add a piece. With "Replaces", the new piece takes the old one's place in every outfit it was in, and the
    // old one moves to Get rid of: that is how a new piece reaches today's picks.
    function addPiece(f) {
        const old = f.replaces ? state.data.items[f.replaces] : null;
        const stamp = fmtDay(today());
        const steps = [{
            doIt: () => sendJson('POST', tableUrl(TABLES.wardrobe), { typecast: true, records: [{ fields: {
                [WR.name]: f.name, [WR.type]: f.type || null, [WR.colour]: f.colour, [WR.swatch]: f.swatch,
                [WR.usedFor]: f.usedFor, [WR.status]: 'Own', [WR.layerRole]: old && old.layerRole ? old.layerRole : null,
                [WR.notes]: 'Added on the Wardrobe page on ' + stamp + (old ? ', in place of ' + old.name : '') + '.' } }] })
                .then(r => r.records[0].id),
            undo() { return this.result ? sendJson('DELETE', tableUrl(TABLES.wardrobe) + '?records[]=' + encodeURIComponent(this.result)) : null; },
        }];
        if (old) {
            const outfits = state.data.outfits.filter(o => o.itemIds.includes(old.id));
            if (outfits.length) {
                steps.push({
                    doIt: (done) => patchRecords(TABLES.outfits, outfits.map(o => ({ id: o.id, fields: { [OF.items]: o.itemIds.map(x => (x === old.id ? done[0].result : x)) } }))),
                    undo: () => patchRecords(TABLES.outfits, outfits.map(o => ({ id: o.id, fields: { [OF.items]: o.itemIds } }))),
                });
            }
            const before = { [WR.status]: old.status || null, [WR.reason]: old.reason || null, [WR.layerRole]: old.layerRole || null };
            steps.push({
                doIt: () => patchRecords(TABLES.wardrobe, [{ id: old.id, fields: { [WR.status]: 'Clear out', [WR.reason]: 'Replaced by ' + f.name + ' on ' + stamp, [WR.layerRole]: null } }]),
                undo: () => patchRecords(TABLES.wardrobe, [{ id: old.id, fields: before }]),
            });
        }
        return runEdit(steps, old ? `Added ${f.name}. It now stands in for ${old.name} in your outfits.` : `Added ${f.name} to your clothes.`);
    }

    // Wearing: two writes, each with its undo. The clothes are stamped first, then the outfit takes today
    // and keeps its old date in Previous worn. An outfit worn today stays on the card all day, so there is
    // no same-day switch to undo. A failure undoes the writes already made, and the message says plainly
    // if that undo failed.
    // Wearing this, or "I'm wearing something else": today's date and one wear go on exactly these pieces.
    // A piece logged earlier today but not in this set has its wear taken back, and an outfit pressed
    // earlier today goes back to its last date, so changing your mind never counts twice (Kevin, 29 Oct 2026).
    const WEAR_KEYS = { lastWorn: 'lastWorn', prevWorn: 'prevWorn', wears: 'wears', inWashSince: 'inWashSince' };
    function wearSteps(ids, chosen, date) {
        const items = state.data.items;
        const itemChanges = [];
        Object.values(items).forEach(it => {
            const f = ids.includes(it.id) ? P().wearFields(it, date) : P().unwearFields(it, date);
            if (f) itemChanges.push({ it, f });
        });
        const outfitChanges = state.data.outfits.filter(o => o.lastWorn === date && o !== chosen)
            .map(o => ({ o, f: { lastWorn: o.prevWorn || null, prevWorn: null } }));
        if (chosen && chosen.lastWorn !== date) outfitChanges.push({ o: chosen, f: { lastWorn: date, prevWorn: chosen.lastWorn || null } });
        const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k] == null ? null : obj[k]]));
        const step = (table, changes) => {
            const keys = table === TABLES.wardrobe ? Object.keys(WEAR_KEYS) : ['lastWorn', 'prevWorn'];
            const map = table === TABLES.wardrobe ? WR : OF;
            const snap = changes.map(c => pick(c.it || c.o, keys));
            const toFields = (vals) => Object.fromEntries(keys.map(k => [map[k], vals[k] == null ? null : vals[k]]));
            return { table, doIt: changes.map(c => ({ id: (c.it || c.o).id, fields: toFields(c.f) })),
                undo: changes.map((c, i) => ({ id: (c.it || c.o).id, fields: toFields(snap[i]) })),
                local: () => changes.forEach(c => Object.assign(c.it || c.o, c.f)),
                unlocal: () => changes.forEach((c, i) => Object.assign(c.it || c.o, snap[i])) };
        };
        return [step(TABLES.wardrobe, itemChanges), step(TABLES.outfits, outfitChanges)].filter(st => st.doIt.length);
    }
    async function saveWorn(ids, chosen, okMsg) {
        if (state.saving || !state.data) return false;
        const steps = wearSteps(ids, chosen, today());
        if (!steps.length) { state.other = false; renderHomeCard(); return true; }
        state.saving = true;
        steps.forEach(st => st.local());
        renderHomeCard();
        const done = [];
        let ok = true;
        try {
            // A batch of 10 can land before the next one fails: each step records what landed, and only that is undone.
            for (const st of steps) { st.landed = []; done.push(st); await patchRecords(st.table, st.doIt, st.landed); }
            state.other = false;
            showToast(okMsg, { type: 'success' });
        } catch (err) {
            ok = false;
            console.error('[wardrobe] Could not save what you are wearing:', err);
            steps.slice().reverse().forEach(st => st.unlocal());
            let undone = true;
            for (const st of done.reverse()) {
                const back = st.undo.filter(r => st.landed.includes(r.id));
                if (!back.length) continue;
                try { await patchRecords(st.table, back); } catch (e) { undone = false; console.error('[wardrobe] Could not undo a part-saved Wearing:', e); }
            }
            showToast(undone ? 'That did not save, so nothing changed. Try again in a moment.'
                : 'Only part of that saved. Press Refresh on the Wardrobe page to see what Airtable holds.', { type: 'error', duration: 8000 });
        } finally {
            state.saving = false;
            renderHomeCard();
            renderWardrobePage();
        }
        return ok;
    }
    function wear(option) {
        if (state.saving || !state.data) return;
        const pick = currentPicks().find(p => p.option === option);
        if (!pick || !pick.outfit) return;
        saveWorn(pick.items.map(it => it.id), pick.outfit, `Saved: you're wearing ${pick.outfit.name} today.`);
    }

    // ── Wardrobe page ──
    function wardrobeRows() {
        const all = Object.values(state.data.items);
        const usedIn = (id) => state.data.outfits.filter(o => o.itemIds.includes(id)).length;
        return {
            own: all.filter(i => i.status === 'Own' || i.status === 'Bought').sort((a, b) => (a.type || 'zz').localeCompare(b.type || 'zz') || a.name.localeCompare(b.name)),
            add: all.filter(i => i.status === 'Need').map(i => Object.assign({ completes: usedIn(i.id) }, i)).sort((a, b) => b.completes - a.completes),
            out: all.filter(i => i.status === 'Clear out').sort((a, b) => a.name.localeCompare(b.name)),
        };
    }

    function fmtDay(iso) {
        if (!iso) return 'Not yet';
        const d = new Date(iso + 'T12:00:00');
        return isNaN(d) ? 'Not yet' : d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });   // DD/MM/YYYY, the app's standard
    }

    const TYPES = ['Tee', 'Shirt', 'Knit', 'Trousers', 'Shorts', 'Jacket', 'Coat', 'Shoes', 'Lounge', 'Accessory'];
    const USES = ['Home', 'Work', 'Day out', 'Evening', 'Site visits'];
    const ACTIONS = ['Sell', 'Donate', 'Recycle', 'Site drawer'];

    function addForm(own) {
        const dis = state.saving ? ' disabled' : '';
        return `<form class="wr-form" data-wr-addform aria-labelledby="wrAddTitle">
            <h2 id="wrAddTitle">Add a piece</h2>
            <div class="wr-grid">
                <label>Name <input name="name" required maxlength="80" placeholder="e.g. Zara navy chinos" autocomplete="off"></label>
                <label>Type <select name="type"><option value="">Choose…</option>${TYPES.map(t => `<option>${t}</option>`).join('')}</select></label>
                <label>Colour <input name="colour" maxlength="40" placeholder="e.g. navy" autocomplete="off"></label>
                <label>Swatch <input type="color" name="swatch" value="#808080"></label>
            </div>
            <fieldset class="wr-uses"><legend>Used for</legend>${USES.map(u => `<label><input type="checkbox" name="usedFor" value="${u}"> ${u}</label>`).join('')}</fieldset>
            <label class="wr-wide">Replaces (optional)
                <select name="replaces"><option value="">Nothing, it is extra</option>${own.map(i => `<option value="${esc(i.id)}">${esc(i.name)}${i.type ? ' (' + esc(i.type) + ')' : ''}</option>`).join('')}</select>
                <small>It takes that piece's place in every outfit, so today's picks use it, and the old piece moves to Get rid of.</small>
            </label>
            <div class="wr-formbtns"><button type="submit" class="wear-btn wear-btn-primary"${dis}>${state.saving ? 'Saving…' : 'Save piece'}</button><button type="button" class="wear-btn" data-wr-cancel${dis}>Cancel</button></div>
        </form>`;
    }

    function removeForm(i) {
        const dis = state.saving ? ' disabled' : '';
        const n = state.data.outfits.filter(o => o.itemIds.includes(i.id)).length;
        return `<tr class="wr-formrow"><td colspan="6"><form class="wr-form wr-form-inline" data-wr-removeform="${esc(i.id)}" aria-label="Remove ${esc(i.name)}">
            <label>What happens to it <select name="action">${ACTIONS.map(a => `<option>${a}</option>`).join('')}</select></label>
            <label class="wr-wide">Why (optional) <input name="reason" maxlength="120" placeholder="e.g. worn out" autocomplete="off"></label>
            ${n ? `<p class="wear-note">It is in ${n} outfit${n === 1 ? '' : 's'}. Those stop being offered until it is replaced.</p>` : ''}
            <div class="wr-formbtns"><button type="submit" class="wear-btn wear-btn-primary"${dis}>${state.saving ? 'Saving…' : 'Move to Get rid of'}</button><button type="button" class="wear-btn" data-wr-cancel${dis}>Cancel</button></div>
        </form></td></tr>`;
    }

    // Wash column (Kevin, 29 Oct 2026): where the piece is in its cycle, and its own limit to change.
    function washCell(i, dis) {
        const date = today();
        const limit = P().washLimit(i);
        const where = limit === 0 ? 'Not counted'
            : P().inWash(i, date) ? `<span class="wr-pill wr-pill-new">In the wash</span> clean ${esc(fmtDay(P().cleanOn(i)))}`
            : `${P().wearsNow(i, date)} of ${limit} wear${limit === 1 ? '' : 's'}`;
        const def = P().RULES.WASH_DEFAULT[i.type] || 0;
        return `<div class="wr-wash">${where}<label class="wr-washevery">Every <input type="number" min="0" max="30" step="1" inputmode="numeric" data-wr-washevery="${esc(i.id)}" value="${i.washEvery == null ? '' : i.washEvery}" placeholder="${def}" aria-label="Wears before washing ${esc(i.name)} (blank = ${def}, 0 = never)"${dis}></label></div>`;
    }

    function renderWardrobePage() {
        const el = document.getElementById('wardrobePage');
        if (!el) return;
        if (!state.data) {
            el.innerHTML = `<h1 class="wr-title">Wardrobe</h1><p class="wear-${state.dataError ? 'error' : 'muted'}">${esc(state.dataError || 'Loading your wardrobe…')}</p>`;
            return;
        }
        const rows = wardrobeRows();
        const owned = (i) => i && (i.status === 'Own' || i.status === 'Bought');
        const ready = state.data.outfits.filter(o => o.itemIds.length && o.itemIds.every(id => owned(state.data.items[id]))).length;
        const dis = state.saving ? ' disabled' : '';
        const btn = (attr, id, label) => `<button type="button" class="wear-btn wr-act" ${attr}="${esc(id)}"${dis}>${label}</button>`;
        const ACTION = { Sell: 'wr-pill-warn', Donate: 'wr-pill-danger', Recycle: 'wr-pill-danger', 'Site drawer': 'wr-pill-muted' };
        const tab = (key, label, n) => `<button type="button" role="tab" id="wrTab-${key}" aria-controls="wrPanel-${key}" aria-selected="${state.view === key}" tabindex="${state.view === key ? 0 : -1}" data-wr-view="${key}">${label} <span class="wr-count">${n}</span></button>`;
        const table = (key, head, body, empty) => `<div class="wr-tablewrap" role="tabpanel" id="wrPanel-${key}" aria-labelledby="wrTab-${key}"${state.view === key ? '' : ' hidden'}>
            ${body ? `<table class="wr-table"><thead><tr>${head.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>` : `<p class="wear-muted">${empty}</p>`}</div>`;
        el.innerHTML = `<h1 class="wr-title">Wardrobe</h1>
            <div class="wr-stats" aria-live="polite">
                <div class="wr-stat"><b>${rows.own.length}</b><span>Pieces you own</span></div>
                <div class="wr-stat"><b>${ready} / ${state.data.outfits.length}</b><span>Outfits ready</span></div>
                <div class="wr-stat"><b>${rows.add.length}</b><span>To buy</span></div>
                <div class="wr-stat"><b>${rows.out.length}</b><span>To clear out</span></div>
            </div>
            ${state.view === 'own' ? (state.form === 'add' ? addForm(rows.own) : `<div class="wr-bar"><button type="button" class="wear-btn wear-btn-primary" data-wr-add${dis}>Add a piece</button></div>`) : ''}
            <div class="wr-tabs" role="tablist" aria-label="Wardrobe lists">${tab('own', 'Current clothes', rows.own.length)}${tab('add', 'Recommended additions', rows.add.length)}${tab('out', 'Get rid of', rows.out.length)}</div>
            ${table('own', ['Piece', 'Type', 'Colour', 'Used for', 'Last worn', 'Wash', '<span class="wr-sr">Actions</span>'], rows.own.map(i => `<tr>
                <td class="wr-name">${esc(i.name)}${i.status === 'Bought' ? ' <span class="wr-pill wr-pill-new">New</span>' : ''}</td><td>${esc(i.type)}</td>
                <td><i class="wear-sw" style="background:${swatch(i.swatch)}" aria-hidden="true"></i> ${esc(i.colour)}</td>
                <td>${(i.usedFor || []).map(u => `<span class="wr-pill">${esc(u)}</span>`).join(' ')}</td><td>${esc(fmtDay(i.lastWorn))}</td><td>${washCell(i, dis)}</td>
                <td class="wr-acts">${i.status === 'Bought' ? btn('data-wr-arrived', i.id, 'Arrived') : ''}${P().inWash(i, today()) || P().wearsNow(i, today()) > 0 ? btn('data-wr-washed', i.id, 'Washed') : ''}${btn('data-wr-remove', i.id, 'Remove')}</td></tr>
                ${state.form === i.id ? removeForm(i) : ''}`).join(''), 'Nothing marked as owned yet.')}
            ${table('add', ['Piece', 'Why', 'Completes', 'Buy in', 'Cap', '<span class="wr-sr">Actions</span>'], rows.add.map(i => `<tr>
                <td class="wr-name">${esc(i.name)}</td><td>${esc(i.reason)}</td><td>${i.completes} outfit${i.completes === 1 ? '' : 's'}</td><td>${esc(i.buyIn || 'Any time')}</td><td>${esc(i.cap)}</td>
                <td class="wr-acts">${btn('data-wr-bought', i.id, 'Bought it')}</td></tr>`).join(''), 'Nothing to buy. Your wardrobe covers every outfit.')}
            ${table('out', ['Piece', 'Reason', 'Action', '<span class="wr-sr">Actions</span>'], rows.out.map(i => `<tr>
                <td class="wr-name">${esc(i.name)}</td><td>${esc(i.reason)}</td><td><span class="wr-pill ${ACTION[i.action] || ''}">${esc(i.action || 'Decide')}</span></td>
                <td class="wr-acts">${btn('data-wr-keep', i.id, 'Keep it')}</td></tr>`).join(''), 'Nothing left to clear out.')}`;
    }

    // ── Health bar (Wardrobe page) ──
    function registerChecks() {
        if (typeof registerSyncBar !== 'function') return;
        registerSyncBar(TAB, {
            refreshFn: () => refresh(true),
            checks: [
                { name: 'Wardrobe table read', kind: 'sync', run: () => (state.dataError ? { status: 'fail', detail: state.dataError }
                    : state.data ? { status: Object.keys(state.data.items).length ? 'pass' : 'warn', detail: `${Object.keys(state.data.items).length} pieces` }
                    : { status: 'warn', detail: 'Not read yet' }) },
                { name: 'Outfits table read', kind: 'sync', run: () => (!state.data ? { status: 'warn', detail: 'Not read yet' }
                    : { status: state.data.outfits.length ? 'pass' : 'warn', detail: `${state.data.outfits.length} outfits` }) },
                { name: 'Every outfit links to clothes that exist', kind: 'sync', run: () => {
                    if (!state.data) return { status: 'warn', detail: 'Not read yet' };
                    const broken = state.data.outfits.filter(o => !o.itemIds.length || o.itemIds.some(id => !state.data.items[id]));
                    return broken.length ? { status: 'fail', detail: `${broken.length} outfit(s) point at missing clothes: ${broken.slice(0, 3).map(o => o.name).join(', ')}` }
                        : { status: 'pass', detail: 'All links resolve' };
                } },
                { name: "Today's weather read", kind: 'sync', run: () => (state.wx ? { status: state.wxError ? 'warn' : 'pass', detail: `${state.wx.place}, read ${Math.max(0, Math.round((Date.now() - state.wxAt) / 60000))} min ago` }
                    : state.wxError ? { status: 'fail', detail: state.wxError } : { status: 'warn', detail: 'Not read yet' }) },
                { name: 'An outfit ready for every option today', kind: 'sync', run: () => {
                    if (!state.data) return { status: 'warn', detail: 'Not read yet' };
                    const missing = currentPicks().filter(p => !p.outfit).map(p => p.option);
                    return missing.length ? { status: 'warn', detail: `Nothing ready for: ${missing.join(', ')}` } : { status: 'pass', detail: 'All three options have an outfit' };
                } },
            ],
        });
    }

    async function refresh(force) {
        if (!signedIn()) return;
        // Only show "refreshing" when something is actually read; reopening Home with fresh data reads nothing.
        const fetching = force || !state.data || !state.wx || state.wxDay !== today() || Date.now() - state.wxAt >= WEATHER_MAX_AGE_MS;
        if (fetching && typeof markTabRefreshing === 'function') markTabRefreshing(TAB);
        await Promise.all([loadData(force), loadWeather(force)]);
        renderHomeCard();
        renderWardrobePage();
        if (typeof markTabSynced === 'function') markTabSynced(TAB);
    }

    function wire() {
        document.addEventListener('click', (e) => {
            const w = e.target.closest('[data-wear-option]');
            if (w) { wear(w.getAttribute('data-wear-option')); return; }
            if (e.target.closest('[data-wear-open]')) { if (typeof switchTab === 'function') switchTab(TAB); return; }
            if (e.target.closest('[data-wear-other]') && !state.saving && state.data) {
                state.other = true; renderHomeCard();
                const f = document.querySelector('#homeWear [data-wear-otherform] input'); if (f) f.focus();
                return;
            }
            if (e.target.closest('[data-wear-othercancel]') && !state.saving) {
                state.other = false; renderHomeCard();
                const b = document.querySelector('#homeWear [data-wear-other]'); if (b) b.focus();
                return;
            }
            if (e.target.closest('[data-wear-locate]') && navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(() => loadWeather(true).then(renderHomeCard),
                    () => showToast('Location is off for this site, so the card stays on Cambridge weather.', { type: 'info' }));
                return;
            }
            const pick = (attr) => { const b = e.target.closest('[' + attr + ']'); return b && !b.disabled ? b.getAttribute(attr) : null; };
            let id;
            if (e.target.closest('[data-wr-add]')) { state.form = 'add'; renderWardrobePage(); focusIn('[data-wr-addform] input[name="name"]'); return; }
            if (e.target.closest('[data-wr-cancel]')) { closeForm(); return; }
            if ((id = pick('data-wr-remove'))) { state.form = id; renderWardrobePage(); focusIn('[data-wr-removeform] select'); return; }
            if ((id = pick('data-wr-washed'))) {
                setFields(id, { [WR.wears]: 0, [WR.inWashSince]: null }, `${state.data.items[id].name} is clean again.`);
                return;
            }
            if ((id = pick('data-wr-arrived'))) { setStatus(id, { [WR.status]: 'Own' }, `Marked ${state.data.items[id].name} as arrived.`); return; }
            if ((id = pick('data-wr-bought'))) { setStatus(id, { [WR.status]: 'Bought' }, `${state.data.items[id].name} moved to your clothes as new.`); return; }
            if ((id = pick('data-wr-keep'))) { setStatus(id, { [WR.status]: 'Own', [WR.action]: null, [WR.reason]: null }, `Kept ${state.data.items[id].name}. It is back in your clothes.`); return; }
            const v = e.target.closest('[data-wr-view]');
            if (v) { state.form = null; state.view = v.getAttribute('data-wr-view'); renderWardrobePage(); const t = document.getElementById('wrTab-' + state.view); if (t) t.focus(); }
        });
        // A piece's own wash limit: blank = its type's default, 0 = never counted.
        document.addEventListener('change', (e) => {
            const inp = e.target.closest && e.target.closest('[data-wr-washevery]');
            if (!inp || state.saving || !state.data) return;
            const id = inp.getAttribute('data-wr-washevery');
            const it = state.data.items[id];
            const raw = inp.value.trim();
            const v = raw === '' ? null : Number(raw);
            if (v != null && !(Number.isInteger(v) && v >= 0 && v <= 30)) {
                showToast('Use a whole number from 0 to 30, or leave it blank for the usual.', { type: 'error' });
                renderWardrobePage();
                return;
            }
            if (!it || v === it.washEvery) return;
            setFields(id, { [WR.washEvery]: v }, v == null ? `${it.name} is back to the usual wash limit.`
                : v === 0 ? `${it.name} is no longer counted for washing.` : `${it.name} now goes in the wash every ${v} wear${v === 1 ? '' : 's'}.`);
        });
        document.addEventListener('submit', (e) => {
            const other = e.target.closest('[data-wear-otherform]');
            if (other) {
                e.preventDefault();
                if (state.saving) return;
                const ids = new FormData(other).getAll('piece').map(String);
                if (!ids.length) { showToast('Tick at least one piece you are wearing.', { type: 'info' }); return; }
                // An outfit counts as worn when all its own pieces are ticked and nothing else but weather layers:
                // today's pressed one first, so a later change in the weather never un-presses it.
                const items = state.data.items;
                // Rain swaps an outfit's shoes for leather boots, so ticked boots stand in for its shoes.
                const bootsOn = ids.some(id => items[id] && items[id].type === 'Shoes' && /^Leather boots/.test(items[id].layerRole || ''));
                const met = (id) => ids.includes(id) || (bootsOn && items[id] && items[id].type === 'Shoes');
                const fits = (o) => o.itemIds.length && o.itemIds.every(met)
                    && ids.every(id => o.itemIds.includes(id) || (items[id] && items[id].layerRole));
                const same = state.data.outfits.find(o => o.lastWorn === today() && fits(o))
                    || (currentPicks().find(p => p.outfit && fits(p.outfit)) || {}).outfit;
                saveWorn(ids, same || null, `Saved what you're wearing today: ${ids.length} piece${ids.length === 1 ? '' : 's'}.`)
                    .then(ok => { if (ok) { const b = document.querySelector('#homeWear [data-wear-other]'); if (b) b.focus(); } });
                return;
            }
            const add = e.target.closest('[data-wr-addform]');
            const rm = e.target.closest('[data-wr-removeform]');
            if (!add && !rm) return;
            e.preventDefault();
            if (state.saving) return;
            const fd = new FormData(e.target);
            const val = (k) => String(fd.get(k) || '').trim();
            if (add) {
                const name = val('name');
                if (!name) { focusIn('[data-wr-addform] input[name="name"]'); return; }
                addPiece({ name, type: val('type'), colour: val('colour'), swatch: val('swatch'), usedFor: fd.getAll('usedFor'), replaces: val('replaces') });
            } else {
                const id = rm.getAttribute('data-wr-removeform');
                setStatus(id, { [WR.status]: 'Clear out', [WR.action]: val('action') || null, [WR.reason]: val('reason') || 'Removed on ' + fmtDay(today()) },
                    `Moved ${state.data.items[id].name} to Get rid of. Press Keep it there to undo.`);
            }
        });
        // Escape closes an open form.
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || !state.other || state.saving || !(e.target.closest && e.target.closest('[data-wear-otherform]'))) return;
            state.other = false; renderHomeCard();
            const b = document.querySelector('#homeWear [data-wear-other]'); if (b) b.focus();
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.form && !state.saving && e.target.closest && e.target.closest('.wr-form')) closeForm(); });
        // Arrow keys move between the Wardrobe tabs (roving tabindex).
        document.addEventListener('keydown', (e) => {
            const t = e.target.closest && e.target.closest('[data-wr-view]');
            if (!t || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
            e.preventDefault();
            const keys = ['own', 'add', 'out'];
            const i = keys.indexOf(t.getAttribute('data-wr-view'));
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? keys.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length;
            state.view = keys[next]; state.form = null; renderWardrobePage();
            const b = document.getElementById('wrTab-' + state.view); if (b) b.focus();
        });
        const watch = (id, onOpen) => {
            const panel = document.getElementById(id);
            if (!panel) return;
            const sync = () => { if (panel.classList.contains('active')) onOpen(); };
            new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['class'] });
            sync();
        };
        // Home: the card waits for the dashboard's first reads, so two bursts never trip Airtable's rate limit.
        // A dashboard read that never finishes must not keep the card on "Choosing…" all day.
        const homeReady = Promise.race([
            window.whenMainDataReady && typeof window.whenMainDataReady.then === 'function' ? window.whenMainDataReady : Promise.resolve(),
            new Promise(r => setTimeout(r, 8000)),
        ]);
        watch('tab-home', () => { renderHomeCard(); homeReady.then(() => refresh(false)); });
        watch('tab-wardrobe', () => { renderWardrobePage(); refresh(false); });
        // A Home left open overnight moves to the new day's weather and picks.
        const newDay = () => signedIn() && state.data && state.wxDay !== today();
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && newDay()) refresh(true); });
        setInterval(() => { if (document.visibilityState === 'visible' && newDay()) refresh(true); }, 5 * 60 * 1000);
        // Home open: the green column follows the clock, and each new hour (or 15 minutes) reads the weather again
        // so "Feels like now" is this hour's (Kevin, 29 Oct 2026). Focus and the strip scroll survive the redraw.
        const followTheHour = () => {
            const home = document.getElementById('tab-home');
            if (!signedIn() || document.visibilityState !== 'visible' || !home || !home.classList.contains('active') || !state.wx || newDay()) return;
            const hour = placeHour(state.wx);
            const due = Date.now() - state.wxTriedAt >= WEATHER_MAX_AGE_MS || hour !== state.wxTriedHour;
            if (hour === state.shownHour && !due) return;
            if (state.other) return;   // never redraw over half-ticked boxes; the next minute tries again
            (due ? loadWeather(true) : Promise.resolve()).then(() => {
                const card = document.getElementById('homeWear');
                if (state.saving || !card) return;   // the save redraws the card itself
                // Put focus and the strip's scroll back where they were.
                const f = card.contains(document.activeElement) ? document.activeElement : null;
                const key = f && ['data-wear-option', 'data-wear-locate', 'data-wear-open'].find(a => f.hasAttribute(a));
                const sel = !f ? null : f.classList.contains('wear-hours') ? '.wear-hours' : key ? `[${key}="${CSS.escape(f.getAttribute(key))}"]` : null;
                const strip = card.querySelector('.wear-hours');
                const left = strip ? strip.scrollLeft : 0;
                renderHomeCard();
                const again = card.querySelector('.wear-hours');
                if (again) again.scrollLeft = left;
                const back = sel && card.querySelector(sel);
                if (back) back.focus({ preventScroll: true });
            });
        };
        document.addEventListener('visibilitychange', followTheHour);
        setInterval(followTheHour, 60 * 1000);
    }

    function focusIn(sel) { const f = document.querySelector('#wardrobePage ' + sel); if (f) f.focus(); }
    function closeForm() {
        const back = typeof state.form === 'string' && state.form !== 'add' ? state.form : null;
        state.form = null; renderWardrobePage();
        focusIn(back ? `[data-wr-remove="${back}"]` : '[data-wr-add]');
    }

    function init() { registerChecks(); wire(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
