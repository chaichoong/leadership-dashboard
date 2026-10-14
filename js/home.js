// ── Home tab (Kevin, 29 Sep 2026; rebuilt 14 Oct 2026) ──
// The plan Kevin approved on 9 Oct (task recwJcP4xIgAeR723): ONE scroll of the real pages, nothing
// copied, so Home can never disagree with the page a section comes from.
//   1. Approvals, then 2. the CEO brief: the AI Agents page itself in its Home mode
//      (os/agents/index.html?home=1), in a frame that grows to its full height. That page tells
//      every other open copy of the queue when it changes a task, so a card answered here is gone
//      from the AI Agents tab too.
//   3. The Leadership Dashboard and 4. Wealth: the real #tab-overview and #tab-wealth panels, shown
//      under Home by body.home-mode (css/home.css). Wealth is drawn the first time it scrolls into view.
// The old "what needs you today" task list is gone (Kevin, 14 Oct 2026: "Anything that needs me
// should come to me as an approval card"). The app opens on Home. Nothing in shared.js, dashboard.js
// or wealth.js changes: a MutationObserver watches #tab-home's active class.
(function () {
    'use strict';
    const TAB = 'home';
    const REREAD_AFTER_MS = 60 * 1000;        // reopening Home re-reads the queue and the brief
    const READY_TIMEOUT_MS = 60 * 1000;       // a copy that never says it is ready is reported, not waited on for ever
    const KEEP_FRESH_MS = 5 * 60 * 1000;      // a Home left open re-reads every five minutes
    const state = { agents: { phase: 'idle' }, wealth: 'waiting', loadedAt: 0, rereadAt: 0, dataReady: false };

    function frame() { return document.getElementById('homeAgentsFrame'); }
    function homeOpen() { const p = document.getElementById('tab-home'); return !!(p && p.classList.contains('active')); }
    function signedIn() { return typeof PAT === 'string' && PAT.length > 0; }
    function setStatus(text, isError) {
        const el = document.getElementById('homeAgentsStatus');
        if (!el) return;
        el.textContent = text;
        el.hidden = !text;
        el.classList.toggle('home-error', !!isError);
    }
    function tellFrame(msg) {
        const f = frame();
        if (f && f.contentWindow) f.contentWindow.postMessage(Object.assign({ source: 'home-shell' }, msg), window.location.origin);
    }

    // The frame loads once the sign-in key exists and the dashboard has done its first reads: two
    // bursts at once can trip Airtable's rate limit, which locks every read out for 30 seconds.
    function loadAgents(force) {
        const f = frame();
        if (!f || !signedIn() || !state.dataReady) return;
        if (f.getAttribute('src') && !force) return;
        state.rereadAt = Date.now();
        setStatus('Loading your approvals and the CEO brief…', false);
        if (typeof markTabRefreshing === 'function') markTabRefreshing(TAB);
        f.setAttribute('src', `${f.getAttribute('data-src')}&cb=${Date.now()}`);
        frameLoading();
    }
    // A load has started, from here or from the copy reloading itself for a new version.
    function frameLoading() {
        state.agents = { phase: 'loading' };
        const started = state.loadedAt = Date.now();
        setTimeout(() => {
            if (state.loadedAt !== started || state.agents.phase !== 'loading') return;
            state.agents = { phase: 'error', error: 'it did not finish loading within a minute' };
            setStatus('Your approvals and the CEO brief are taking too long to load. Press Refresh in the bar above, or open the AI Agents page.', true);
            if (typeof markTabSynced === 'function') markTabSynced(TAB);
            maybeWealth();
        }, READY_TIMEOUT_MS);
    }
    // Home opened again, or left open. The copy is NEVER reloaded here: a reload would lose a note
    // Kevin is typing (review, 14 Oct 2026). It is asked to re-read; a newer deploy reloads it through
    // its own stale-tab path, which carries his notes over. Only a copy that failed is loaded again.
    function keepFresh(force) {
        if (!homeOpen()) return;
        // The first load happens even in a background tab, so the approvals are ready when Kevin looks
        // (live check, 14 Oct 2026: a tab opened behind another showed "Loading…" until it was shown).
        if (!frame() || !frame().getAttribute('src')) { loadAgents(false); return; }
        if (document.visibilityState !== 'visible') return;   // re-reads wait for him to be looking
        if (state.agents.phase === 'error') { loadAgents(true); return; }
        const now = Date.now();
        if ((force || now - state.rereadAt > REREAD_AFTER_MS) && state.agents.phase === 'ready') { state.rereadAt = now; tellFrame({ type: 'homeRefresh' }); }
    }

    // The band of the frame that is on screen, so its dialogs, toasts and Undo bar open where Kevin
    // is looking: inside a frame as tall as its content, "fixed" would mean the frame, not the screen.
    let bandRaf = 0;
    function postBand() {
        bandRaf = 0;
        const f = frame();
        if (!f || !homeOpen()) return;
        const r = f.getBoundingClientRect();
        const top = Math.max(0, pinnedHeight() - r.top);   // below the pinned jump row, so a sticky bar is never under it
        const bottom = Math.min(r.height, window.innerHeight - r.top);
        tellFrame({ type: 'homeViewport', top: Math.round(top), h: Math.round(Math.max(0, bottom - top)) });
    }
    function queueBand() { if (!bandRaf) bandRaf = requestAnimationFrame(postBand); }

    // Messages from Home's own copy of the AI Agents page, and from nothing else.
    window.addEventListener('message', (e) => {
        const f = frame();
        if (!f || e.source !== f.contentWindow || e.origin !== window.location.origin) return;
        const d = e.data || {};
        if (d.source !== 'agents-home') return;
        if (d.type === 'agentsHomeHeight' && Number(d.h) > 0) {
            f.style.height = `${Math.ceil(Number(d.h))}px`;
            queueBand();
            return;
        }
        if (d.type === 'agentsHomeLoading') {
            if (state.agents.phase !== 'loading') frameLoading();   // our own load already counts
            return;
        }
        if (d.type === 'agentsHomeScrollTo') {
            scrollToY(f.getBoundingClientRect().top + window.pageYOffset + Math.max(0, Number(d.y) || 0));
            return;
        }
        if (d.type === 'agentsHomeReady') {
            state.agents = d.ok ? { phase: 'ready', waiting: Number(d.waiting) || 0, brief: d.brief, at: Date.now() }
                : { phase: 'error', error: String(d.error || 'unknown') };
            setStatus(d.ok ? '' : `Your approvals and the CEO brief could not be read (${state.agents.error}). Press Refresh in the bar above, or open the AI Agents page.`, !d.ok);
            queueBand();
            maybeWealth();   // the frame has its real height now, so "near the screen" means something
            if (pendingJump) redoJump();   // a jump made while it loaded is aimed again at its real place
            if (typeof markTabSynced === 'function') markTabSynced(TAB);
            return;
        }
        if (d.type === 'agentsHomeInput') pendingJump = null;   // he has moved on: never pull him back
    });

    // renderWealthTab handles its own errors and draws them into the panel, so the outcome is read
    // from what it drew, never from the call returning.
    function wealthOutcome() {
        const el = document.getElementById('tab-wealth');
        const text = (el && el.textContent) || '';
        if (/Could not (load|display) net worth/.test(text)) return 'failed';
        if (!text.trim() || /Loading wealth data/.test(text)) return 'waiting';
        return 'loaded';
    }
    // Foldable sections (Kevin, 14 Oct 2026: "collapse each section down should I need it"). The
    // approvals, sign-ins and brief fold inside their own page; the dashboard and Wealth fold here.
    // One key for the whole page, remembered in this browser.
    const FOLD_KEY = 'od_home_folded';
    function foldState() {
        try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}; }
        catch (err) { console.warn('[home] fold state unreadable', err); return {}; }
    }
    function folded(key) { return document.body.classList.contains('home-folded-' + key); }
    function setFold(key, fold, save) {
        document.body.classList.toggle('home-folded-' + key, fold);
        const b = document.querySelector(`[data-home-fold="${key}"]`);
        if (b) b.setAttribute('aria-expanded', fold ? 'false' : 'true');
        if (save) {
            try { const st = foldState(); st[key] = fold; localStorage.setItem(FOLD_KEY, JSON.stringify(st)); }
            catch (err) { console.warn('[home] fold state not saved', err); }
        }
        if (key === 'wealth' && !fold && save) maybeWealth();   // opened by hand: drawn if in view, once the approvals are in
        queueBand();
    }

    // Wealth is drawn the first time its heading comes near the screen, never on load. Until the
    // approvals frame has its real height its heading sits near the top, so it waits for the frame
    // (review, 14 Oct 2026: with the dashboard folded, Wealth drew at load).
    function wealthNear() {
        const divider = document.getElementById('homeWealthDivider');
        if (!divider) return false;
        const r = divider.getBoundingClientRect();
        return r.bottom > -300 && r.top < window.innerHeight + 300;
    }
    function maybeWealth() {
        if (!homeOpen()) return;
        const waiting = state.agents.phase === 'idle' || state.agents.phase === 'loading';
        const near = wealthNear();
        // Say why the heading has nothing under it yet, rather than leave it blank.
        const note = document.getElementById('homeWealthWait');
        if (note) note.hidden = !(waiting && near && state.wealth === 'waiting' && wealthOutcome() === 'waiting');   // the Wealth page may have drawn it already
        if (!waiting && near) loadWealth();
    }

    async function loadWealth() {
        if (folded('wealth')) return;   // a folded Wealth is never drawn
        if (state.wealth === 'loading' || state.wealth === 'loaded') return;
        if (typeof renderWealthTab !== 'function') { state.wealth = 'failed'; return; }
        state.wealth = 'loading';
        const note = document.getElementById('homeWealthWait');
        if (note) note.hidden = true;
        try { await renderWealthTab(); state.wealth = wealthOutcome(); }
        catch (err) { state.wealth = 'failed'; console.error('[home] Wealth could not be drawn:', err); }
        document.body.classList.add('home-wealth-drawn');
        if (pendingJump && pendingJump.key === 'wealth') redoJump();   // it has its real height now
        if (typeof markTabSynced === 'function') markTabSynced(TAB);
    }

    function setDate() {
        const d = document.getElementById('homeDate');
        if (d) d.textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });
    }

    function registerChecks() {
        if (typeof registerSyncBar !== 'function') return;
        registerSyncBar(TAB, {
            refreshFn: () => {
                setDate();
                keepFresh(true);
                if (typeof loadDashboard === 'function') loadDashboard();
                if (state.wealth !== 'waiting') { state.wealth = 'waiting'; loadWealth(); }
            },
            checks: [
                { name: 'Approvals and CEO brief loaded', kind: 'sync', run: () => {
                    const a = state.agents;
                    if (a.phase === 'ready') return { status: 'pass', detail: `${a.waiting} card(s) waiting; the CEO brief is ${a.brief === 'ready' ? 'in' : String(a.brief)}` };
                    if (a.phase === 'error') return { status: 'fail', detail: a.error };
                    return { status: 'warn', detail: signedIn() ? 'Still loading' : 'Waiting for you to sign in' };
                } },
                { name: 'Leadership Dashboard data in', kind: 'sync', run: () => (typeof window.dashDataAsOf === 'number'
                    ? { status: 'pass', detail: `Read ${Math.max(0, Math.round((Date.now() - window.dashDataAsOf) / 60000))} min ago` }
                    : { status: 'warn', detail: 'The dashboard has not finished reading yet' }) },
                { name: 'Wealth', kind: 'sync', run: () => (state.wealth === 'failed' ? { status: 'fail', detail: 'Wealth could not be drawn. Open the Wealth page.' }
                    : state.wealth === 'loaded' ? { status: 'pass', detail: 'Drawn' }
                    : { status: 'pass', detail: 'Drawn when you scroll down to it' }) },
            ],
        });
    }

    // The jump row (Kevin, 14 Oct 2026): one button per section, pinned at the top once Home scrolls past it.
    // The row covers the whole content column; its padding keeps the buttons in line with the page.
    function jumpBar() { return document.getElementById('homeJump'); }
    function pinnedHeight() { const b = jumpBar(); return b && b.classList.contains('home-jump-pinned') ? b.offsetHeight : 0; }
    function syncPin() {
        const slot = document.getElementById('homeJumpSlot'), bar = jumpBar();
        if (!slot || !bar) return;
        const r = slot.getBoundingClientRect();
        const pin = homeOpen() && r.top < 0;
        if (pin) {
            // On a phone the menu button is pinned at the top left, so the row spans the screen and its
            // buttons start clear of it. On a wider screen it runs from the sidebar's edge to the screen's.
            const menu = document.querySelector('.sidebar-toggle');
            const phone = !!menu && getComputedStyle(menu).display !== 'none';
            const side = document.querySelector('.sidebar');
            const left = phone || !side ? 0 : Math.max(0, Math.round(side.getBoundingClientRect().right));
            const right = document.documentElement.clientWidth;
            const menuRight = phone ? menu.getBoundingClientRect().right + 8 : 0;
            slot.style.height = `${bar.getBoundingClientRect().height}px`;
            Object.assign(bar.style, { left: `${left}px`, width: `${Math.max(0, right - left)}px`,
                paddingLeft: `${Math.max(0, r.left - left, menuRight - left)}px`, paddingRight: `${Math.max(0, right - r.right)}px` });
        } else {
            slot.style.height = '';
            Object.assign(bar.style, { left: '', width: '', paddingLeft: '', paddingRight: '' });
        }
        bar.classList.toggle('home-jump-pinned', pin);
        // A control reached with Tab is scrolled clear of the row, never left underneath it.
        document.documentElement.style.scrollPaddingTop = pin ? `${Math.ceil(bar.getBoundingClientRect().height) + 12}px` : '';
    }
    // Where a section's heading lands: just below the row, which is pinned by the time it gets there.
    function scrollToY(y) {
        const b = jumpBar();
        const gap = (b ? b.offsetHeight : 0) + 12;
        window.scrollTo({ top: Math.max(0, Math.round(y - gap)), behavior: 'smooth' });
    }
    // A jump made before the page has its final shape (the approvals still loading, Wealth not yet drawn)
    // is aimed again once it has, unless Kevin has scrolled or typed since. It lapses after 20 seconds.
    let pendingJump = null;
    function redoJump() {
        if (!pendingJump) return;
        if (Date.now() - pendingJump.at > 20000) { pendingJump = null; return; }
        jumpTo(pendingJump.key, true);
    }
    function jumpTo(key, again) {
        if (!again) pendingJump = { key, at: Date.now() };
        if (key === 'dashboard' || key === 'wealth') {
            if (folded(key)) setFold(key, false, true);
            const b = document.querySelector(`[data-home-fold="${key}"]`);
            if (b) { scrollToY(b.getBoundingClientRect().top + window.pageYOffset); if (!again) b.focus({ preventScroll: true }); }
            return;
        }
        // Sign-ins, approvals and the brief live in the frame: it opens the section and says where it starts.
        // Until it has loaded, the jump goes to the top of the frame.
        if (state.agents.phase === 'ready') { tellFrame({ type: 'homeJump', zone: key }); return; }
        const f = frame();
        if (f) scrollToY(f.getBoundingClientRect().top + window.pageYOffset);
    }

    function wire() {
        const panel = document.getElementById('tab-home');
        if (!panel) return;
        panel.addEventListener('click', (e) => {
            const jump = e.target.closest('[data-home-jump]');
            if (jump) jumpTo(jump.getAttribute('data-home-jump'));
        });
        // The Wealth header sits outside the Home panel (it heads the Wealth panel), so listen on the page.
        document.addEventListener('click', (e) => {
            const b = e.target.closest('[data-home-fold]');
            if (b) { const key = b.getAttribute('data-home-fold'); setFold(key, !folded(key), true); }
        });
        const st = foldState();
        ['dashboard', 'wealth'].forEach(key => setFold(key, !!st[key], false));
        const sync = () => {
            const open = panel.classList.contains('active');
            document.body.classList.toggle('home-mode', open);
            if (open) { setDate(); keepFresh(); queueBand(); }
            syncPin();
        };
        new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['class'] });
        sync();
        const ready = () => { state.dataReady = true; keepFresh(); };
        if (window.whenMainDataReady && typeof window.whenMainDataReady.then === 'function') window.whenMainDataReady.then(ready);
        else ready();
        setTimeout(ready, 20000);   // a dashboard read that never finishes must not keep the approvals off Home
        // Kevin scrolling or typing himself cancels a jump still waiting to be re-aimed.
        ['wheel', 'touchmove', 'keydown'].forEach(t => window.addEventListener(t, () => { pendingJump = null; }, { passive: true }));
        // The row pins in the scroll event itself, before the frame is painted, so it never lags a frame behind.
        window.addEventListener('scroll', () => { syncPin(); queueBand(); }, { passive: true });
        window.addEventListener('resize', () => { syncPin(); queueBand(); });
        // Layout above the frame can move without a scroll (the sync bar's drawer opening, the dashboard drawing).
        if (typeof ResizeObserver === 'function') new ResizeObserver(() => { syncPin(); queueBand(); }).observe(document.body);
        document.addEventListener('visibilitychange', () => keepFresh());   // never pass the event in as "force"
        setInterval(() => { if (Date.now() - state.rereadAt > KEEP_FRESH_MS) keepFresh(true); }, 30 * 1000);
        const divider = document.getElementById('homeWealthDivider');
        if (divider && typeof IntersectionObserver === 'function') {
            new IntersectionObserver((entries) => {
                if (entries.some(en => en.isIntersecting)) maybeWealth();
            }, { rootMargin: '300px 0px' }).observe(divider);
        }
    }

    function init() {
        registerChecks();
        wire();
        // The app opens on Home (Kevin, 14 Oct 2026). A link that names a page still opens that page.
        // The address is left bare until the page has loaded: the shell switches again to any page the
        // address names at load and once more when its data is in, and each switch scrolls to the top,
        // which would pull Kevin back up mid-scroll.
        const opensHome = !window.location.hash || window.location.hash === '#' + TAB;   // a reload of #home too
        if (opensHome && typeof switchTab === 'function') {
            switchTab(TAB);
            history.replaceState(null, '', window.location.pathname + window.location.search);
            window.addEventListener('load', () => {
                if (homeOpen() && !window.location.hash) history.replaceState(null, '', '#' + TAB);
            });
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
