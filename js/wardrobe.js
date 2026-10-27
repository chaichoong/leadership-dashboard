// ── Wardrobe (Kevin, 27 Oct 2026) ──
// Two surfaces, one data read:
//   1. The "What to wear today" card at the top of My Dashboard (#homeWear): day, date, place, the
//      feels-like temperature, today's conditions, one plain reason, and three options (Stay at home,
//      Out casual, Out smart casual), each with a Wearing button that stamps today's date on the outfit
//      and its clothes so tomorrow rotates to something else.
//   2. The Wardrobe page (#tab-wardrobe): current clothes, recommended additions, and the clear-out.
// The rules live in js/wardrobe-pick.js (pinned by tests/wardrobe-pick.test.js). The clothes live only
// in Airtable (TABLES.wardrobe, TABLES.outfits): this repo is public. Weather comes from Open-Meteo
// (free, no key) at the browser's location when it has permission, else WEATHER_FALLBACK.
// Nothing in shared.js or home.js changes: MutationObservers watch the two panels' active class.
(function () {
    'use strict';
    const TAB = 'wardrobe';
    const WEATHER_MAX_AGE_MS = 30 * 60 * 1000;
    const state = { data: null, dataError: null, loading: null, wx: null, wxError: null, wxAt: 0, wxDay: '', wxLoading: null, saving: false, view: 'own' };
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
                        lastWorn: getField(r, WR.lastWorn) || null,
                    };
                });
                // List order = the order the outfits were added (Kevin's plan order), so "the first eligible
                // outfit" is the one he approved at the gate. The API returns rows in its own order.
                const planKey = (r) => { const m = String(getField(r, OF.planId) || '').match(/^([a-z]*)(\d*)/i); return [m[1], Number(m[2]) || 0]; };
                of.sort((a, b) => {
                    if (a.createdTime !== b.createdTime) return a.createdTime < b.createdTime ? -1 : 1;
                    const [pa, na] = planKey(a), [pb, nb] = planKey(b);
                    return pa === pb ? na - nb : pa.localeCompare(pb);
                });
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
        try {
            const c = await coords();
            const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(c.lat.toFixed(3)) + '&longitude=' + encodeURIComponent(c.lon.toFixed(3))
                + '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m'
                + '&daily=apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=1';
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('weather ' + resp.status);
            const d = await resp.json();
            const cur = d.current || {}, day = d.daily || {};
            const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
            const wx = {
                feelsNow: n(cur.apparent_temperature), actualNow: n(cur.temperature_2m), wind: n(cur.wind_speed_10m),
                feelsMin: n((day.apparent_temperature_min || [])[0]), feelsMax: n((day.apparent_temperature_max || [])[0]),
                rainChance: n((day.precipitation_probability_max || [])[0]), code: n((day.weather_code || [])[0]) ?? n(cur.weather_code),
                place: c.place, mine: c.mine,
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
            return `<article class="wear-opt"><h3>${esc(pick.option)}</h3><p class="wear-note">No outfit ready for this season. Add one in the Outfits table.</p></article>`;
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

    function currentPicks() {
        const wx = state.wx || UNKNOWN_WX;   // no weather: no layers, never a guess
        return P().pickOutfits(state.data.outfits, state.data.items, wx, new Date());
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
                    ${wx.wind != null ? `<span class="wear-chip${wx.wind >= 25 ? ' wear-chip-wind' : ''}">Wind ${Math.round(wx.wind)} km/h</span>` : ''}
                </div></div>` : ''}
        </div>`;
        if (state.dataError) {
            el.innerHTML = head + `<p class="wear-error">${esc(state.dataError)} Press Refresh in the Wardrobe page's bar to try again.</p>`;
            return;
        }
        if (!state.data) { el.innerHTML = head + '<p class="wear-muted">Choosing today\'s outfits…</p>'; return; }
        if (!state.data.outfits.length) { el.innerHTML = head + '<p class="wear-muted">No outfits yet. Add them in the Outfits table in Airtable.</p>'; return; }
        const picks = currentPicks();
        const best = P().bestOption(picks);
        const why = wx ? `<p class="wear-why" role="status"><b>Why:</b> ${esc(P().reasonFor(wx, picks))}</p>` : `<p class="wear-error" role="status">${esc(state.wxError || 'Reading today\'s weather…')}</p>`;
        const locate = wx && !wx.mine && navigator.geolocation ? '<button type="button" class="wear-link" data-wear-locate>Use my location</button>' : '';
        el.innerHTML = head + why
            + `<div class="wear-opts">${picks.map(p => optionCard(p, best)).join('')}</div>`
            + `<p class="wear-src">Weather from Open-Meteo for ${esc(place)}. ${locate}<button type="button" class="wear-link" data-wear-open>Open your wardrobe</button></p>`;
    }

    async function patchRecords(table, records) {
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
        }
    }

    // Wearing: two writes, each with its undo. The clothes are stamped first, then the outfit takes today
    // and keeps its old date in Previous worn. An outfit worn today stays on the card all day, so there is
    // no same-day switch to undo. A failure undoes the writes already made, and the message says plainly
    // if that undo failed.
    async function wear(option) {
        if (state.saving || !state.data) return;
        const pick = currentPicks().find(p => p.option === option);
        if (!pick || !pick.outfit) return;
        const date = today();
        const chosen = pick.outfit;
        const steps = [
            { table: TABLES.wardrobe,
              doIt: pick.items.map(it => ({ id: it.id, fields: { [WR.lastWorn]: date } })),
              undo: pick.items.map(it => ({ id: it.id, fields: { [WR.lastWorn]: it.lastWorn || null } })),
              local: () => pick.items.forEach(it => { it.lastWorn = date; }), unlocal: (snap) => pick.items.forEach((it, i) => { it.lastWorn = snap[i]; }),
              snap: pick.items.map(it => it.lastWorn) },
            { table: TABLES.outfits,
              doIt: [{ id: chosen.id, fields: { [OF.lastWorn]: date, [OF.prevWorn]: chosen.lastWorn === date ? (chosen.prevWorn || null) : (chosen.lastWorn || null) } }],
              undo: [{ id: chosen.id, fields: { [OF.lastWorn]: chosen.lastWorn || null, [OF.prevWorn]: chosen.prevWorn || null } }],
              local: () => { chosen.prevWorn = chosen.lastWorn === date ? chosen.prevWorn : chosen.lastWorn; chosen.lastWorn = date; },
              unlocal: (snap) => { chosen.lastWorn = snap[0]; chosen.prevWorn = snap[1]; }, snap: [chosen.lastWorn, chosen.prevWorn] },
        ].filter(st => st.doIt.length);
        state.saving = true;
        steps.forEach(st => st.local());
        renderHomeCard();
        const done = [];
        try {
            for (const st of steps) { await patchRecords(st.table, st.doIt); done.push(st); }
            showToast(`Saved: you're wearing ${chosen.name} today.`, { type: 'success' });
        } catch (err) {
            console.error('[wardrobe] Could not save what you are wearing:', err);
            steps.slice().reverse().forEach(st => st.unlocal(st.snap));
            let undone = true;
            for (const st of done.reverse()) {
                try { await patchRecords(st.table, st.undo); } catch (e) { undone = false; console.error('[wardrobe] Could not undo a part-saved Wearing:', e); }
            }
            showToast(undone ? 'That did not save, so nothing changed. Try again in a moment.'
                : 'Only part of that saved. Press Refresh on the Wardrobe page to see what Airtable holds.', { type: 'error', duration: 8000 });
        } finally {
            state.saving = false;
            renderHomeCard();
            renderWardrobePage();
        }
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
        return isNaN(d) ? 'Not yet' : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
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
        const ACTION = { Sell: 'wr-pill-warn', Donate: 'wr-pill-danger', Recycle: 'wr-pill-danger', 'Site drawer': 'wr-pill-muted' };
        const tab = (key, label, n) => `<button type="button" role="tab" id="wrTab-${key}" aria-controls="wrPanel-${key}" aria-selected="${state.view === key}" data-wr-view="${key}">${label} <span class="wr-count">${n}</span></button>`;
        const table = (key, head, body, empty) => `<div class="wr-tablewrap" role="tabpanel" id="wrPanel-${key}" aria-labelledby="wrTab-${key}"${state.view === key ? '' : ' hidden'}>
            ${body ? `<table class="wr-table"><thead><tr>${head.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>` : `<p class="wear-muted">${empty}</p>`}</div>`;
        el.innerHTML = `<h1 class="wr-title">Wardrobe</h1>
            <div class="wr-stats" aria-live="polite">
                <div class="wr-stat"><b>${rows.own.length}</b><span>Pieces you own</span></div>
                <div class="wr-stat"><b>${ready} / ${state.data.outfits.length}</b><span>Outfits ready</span></div>
                <div class="wr-stat"><b>${rows.add.length}</b><span>To buy</span></div>
                <div class="wr-stat"><b>${rows.out.length}</b><span>To clear out</span></div>
            </div>
            <div class="wr-tabs" role="tablist" aria-label="Wardrobe lists">${tab('own', 'Current clothes', rows.own.length)}${tab('add', 'Recommended additions', rows.add.length)}${tab('out', 'Get rid of', rows.out.length)}</div>
            ${table('own', ['Piece', 'Type', 'Colour', 'Used for', 'Last worn'], rows.own.map(i => `<tr>
                <td class="wr-name">${esc(i.name)}${i.status === 'Bought' ? ' <span class="wr-pill wr-pill-new">New</span>' : ''}</td><td>${esc(i.type)}</td>
                <td><i class="wear-sw" style="background:${swatch(i.swatch)}" aria-hidden="true"></i> ${esc(i.colour)}</td>
                <td>${(i.usedFor || []).map(u => `<span class="wr-pill">${esc(u)}</span>`).join(' ')}</td><td>${esc(fmtDay(i.lastWorn))}</td></tr>`).join(''), 'Nothing marked as owned yet.')}
            ${table('add', ['Piece', 'Why', 'Completes', 'Buy in', 'Cap'], rows.add.map(i => `<tr>
                <td class="wr-name">${esc(i.name)}</td><td>${esc(i.reason)}</td><td>${i.completes} outfit${i.completes === 1 ? '' : 's'}</td><td>${esc(i.buyIn || 'Any time')}</td><td>${esc(i.cap)}</td></tr>`).join(''), 'Nothing to buy. Your wardrobe covers every outfit.')}
            ${table('out', ['Piece', 'Reason', 'Action'], rows.out.map(i => `<tr>
                <td class="wr-name">${esc(i.name)}</td><td>${esc(i.reason)}</td><td><span class="wr-pill ${ACTION[i.action] || ''}">${esc(i.action || 'Decide')}</span></td></tr>`).join(''), 'Nothing left to clear out.')}`;
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
                { name: "Today's weather read", kind: 'sync', run: () => (state.wx ? { status: 'pass', detail: `${state.wx.place}, read ${Math.max(0, Math.round((Date.now() - state.wxAt) / 60000))} min ago` }
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
        if (typeof markTabRefreshing === 'function') markTabRefreshing(TAB);
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
            if (e.target.closest('[data-wear-locate]') && navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(() => loadWeather(true).then(renderHomeCard),
                    () => showToast('Location is off for this site, so the card stays on Cambridge weather.', { type: 'info' }));
                return;
            }
            const v = e.target.closest('[data-wr-view]');
            if (v) { state.view = v.getAttribute('data-wr-view'); renderWardrobePage(); const t = document.getElementById('wrTab-' + state.view); if (t) t.focus(); }
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
    }

    function init() { registerChecks(); wire(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
