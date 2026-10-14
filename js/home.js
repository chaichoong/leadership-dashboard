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
    const RELOAD_AFTER_MS = 20 * 60 * 1000;   // an older copy reloads, as the shell's own frames do
    const REREAD_AFTER_MS = 60 * 1000;        // reopening Home re-reads the queue and the brief
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
        state.agents = { phase: 'loading' };
        state.loadedAt = state.rereadAt = Date.now();
        setStatus('Loading your approvals and the CEO brief…', false);
        if (typeof markTabRefreshing === 'function') markTabRefreshing(TAB);
        f.setAttribute('src', `${f.getAttribute('data-src')}&cb=${Date.now()}`);
    }
    // Home opened again, or left open: a copy over 20 minutes old reloads, otherwise it re-reads.
    function keepFresh() {
        if (!homeOpen() || document.visibilityState !== 'visible') return;
        if (!frame() || !frame().getAttribute('src')) { loadAgents(false); return; }
        const now = Date.now();
        if (now - state.loadedAt > RELOAD_AFTER_MS) { loadAgents(true); return; }
        if (now - state.rereadAt > REREAD_AFTER_MS && state.agents.phase === 'ready') { state.rereadAt = now; tellFrame({ type: 'homeRefresh' }); }
    }

    // The band of the frame that is on screen, so its dialogs, toasts and Undo bar open where Kevin
    // is looking: inside a frame as tall as its content, "fixed" would mean the frame, not the screen.
    let bandRaf = 0;
    function postBand() {
        bandRaf = 0;
        const f = frame();
        if (!f || !homeOpen()) return;
        const r = f.getBoundingClientRect();
        const top = Math.max(0, -r.top);
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
        if (d.type === 'agentsHomeScrollTo') {
            const y = f.getBoundingClientRect().top + window.pageYOffset + Math.max(0, Number(d.y) || 0) - 16;
            window.scrollTo({ top: Math.max(0, Math.round(y)), behavior: 'smooth' });
            return;
        }
        if (d.type === 'agentsHomeReady') {
            state.agents = d.ok ? { phase: 'ready', waiting: Number(d.waiting) || 0, brief: d.brief, at: Date.now() }
                : { phase: 'error', error: String(d.error || 'unknown') };
            setStatus(d.ok ? '' : `Your approvals and the CEO brief could not be read (${state.agents.error}). Press Refresh in the bar above, or open the AI Agents page.`, !d.ok);
            queueBand();
            if (typeof markTabSynced === 'function') markTabSynced(TAB);
        }
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
    async function loadWealth() {
        if (state.wealth === 'loading' || state.wealth === 'loaded') return;
        if (typeof renderWealthTab !== 'function') { state.wealth = 'failed'; return; }
        state.wealth = 'loading';
        try { await renderWealthTab(); state.wealth = wealthOutcome(); }
        catch (err) { state.wealth = 'failed'; console.error('[home] Wealth could not be drawn:', err); }
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
                loadAgents(true);
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

    function wire() {
        const panel = document.getElementById('tab-home');
        if (!panel) return;
        panel.addEventListener('click', (e) => {
            const nav = e.target.closest('[data-home-tab]');
            if (nav && typeof switchTab === 'function') switchTab(nav.getAttribute('data-home-tab'));
        });
        const sync = () => {
            const open = panel.classList.contains('active');
            document.body.classList.toggle('home-mode', open);
            if (open) { setDate(); keepFresh(); queueBand(); }
        };
        new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['class'] });
        sync();
        const ready = () => { state.dataReady = true; keepFresh(); };
        if (window.whenMainDataReady && typeof window.whenMainDataReady.then === 'function') window.whenMainDataReady.then(ready);
        else ready();
        setTimeout(ready, 20000);   // a dashboard read that never finishes must not keep the approvals off Home
        window.addEventListener('scroll', queueBand, { passive: true });
        window.addEventListener('resize', queueBand);
        document.addEventListener('visibilitychange', keepFresh);
        setInterval(() => { if (Date.now() - state.rereadAt > KEEP_FRESH_MS) keepFresh(); }, 30 * 1000);
        // Wealth is drawn the first time its heading comes near the screen, never on load.
        const divider = document.getElementById('homeWealthDivider');
        if (divider && typeof IntersectionObserver === 'function') {
            new IntersectionObserver((entries) => {
                if (entries.some(en => en.isIntersecting) && document.body.classList.contains('home-mode')) loadWealth();
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
        if (!window.location.hash && typeof switchTab === 'function') {
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
