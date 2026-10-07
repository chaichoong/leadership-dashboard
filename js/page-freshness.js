// ── An open tab runs the code it opened with (Kevin, 7 Oct 2026) ──
// The Your step cards shipped at 12:43 on 7 Oct: an approved card that waits on a step only Kevin
// can take, with no Approve button. His approval tab had been open since the morning, so it kept
// the old code all day and showed those cards with Approve. He approved ten of them two to four
// times each, every approval sent the card round the robots, and each one came back. Nothing on
// either page noticed that a newer copy was live.
//
// So before a page saves a decision, it asks the server whether its own file has changed since the
// tab loaded it, and reloads instead of saving when it has. GitHub Pages sends an ETag of
// "<mtime>-<size>" in hex (weak, W/, when gzipped); the size is the file's own byte count, the
// same number the browser gives as the page's decoded body (measured 7 Oct 2026: 513316 both).
// The mtime part changes on every deploy of the site, so only the size is compared: an edit to
// another file never reloads this page. The limit: an edit that leaves the file exactly the same
// size is not seen (scripts/agent-dispatch.py your_step_reapproved still covers the Your step case).
// Anything unknown (no timing entry, no ETag, offline) reads as fresh: a guess never blocks a save.
//
// Used by os/agents/index.html (applyApprovalDecision) and os/tasks/index.html (apvDecide).
// Tested by tests/page-freshness.test.js and tests/sync-invariants/approval-stale-tab.spec.js.
(function (root) {
    'use strict';

    const CHECK_EVERY_MS = 10000;   // a bulk approval of twenty cards asks the server a few times, not twenty
    const FRESH_PARAM = 'fresh';
    const RELOADED_KEY = 'page_freshness_reloaded_at';
    const LOOP_GUARD_MS = 60000;

    // The file size inside a GitHub Pages ETag, or 0 when the header is not that shape.
    function etagBytes(etag) {
        const m = /^(?:W\/)?"[0-9a-f]+-([0-9a-f]+)"$/i.exec(String(etag || '').trim());
        return m ? parseInt(m[1], 16) : 0;
    }

    // The byte size of the page this tab loaded, or 0 when the browser does not say.
    function loadedBytes(perf) {
        try {
            const n = (perf || root.performance).getEntriesByType('navigation')[0];
            return (n && Number(n.decodedBodySize)) || 0;
        } catch (e) {
            console.warn('page freshness: no navigation timing, so the check is off', e);
            return 0;
        }
    }

    // This page's own address with a query no cache has seen, keeping every other parameter and
    // the hash. The check and the reload both use one, so neither can be answered by a cached copy
    // (the CDN keeps a copy per address for ten minutes; review, 7 Oct 2026).
    function freshUrl(loc, now) {
        const params = new URLSearchParams(loc.search || '');
        params.set(FRESH_PARAM, String(now || Date.now()));
        return loc.pathname + '?' + params.toString() + (loc.hash || '');
    }

    // One guard per page: the AI Agents and Tasks pages share sessionStorage as iframes of one
    // dashboard tab, and one page's reload must never switch off the other's check (review round 2).
    function reloadKey() { return RELOADED_KEY + ':' + root.location.pathname; }

    // A reload in the last minute that still left this page different means the server is not
    // giving out one copy yet: say so and let the save go, rather than reload for ever.
    function reloadedJustNow(now) {
        try {
            if (!root.sessionStorage) return false;
            const at = Number(root.sessionStorage.getItem(reloadKey()) || 0);
            return at > 0 && (now || Date.now()) - at < LOOP_GUARD_MS;
        } catch (e) {
            console.warn('page freshness: the reload guard could not be read', e);
            return false;
        }
    }

    let checkedAt = 0, stale = false, reloading = false, pending = null;

    async function ask(mine, opts) {
        try {
            const r = await (opts.fetch || root.fetch)(freshUrl(root.location), { method: 'HEAD', cache: 'no-store' });
            const live = r && r.ok ? etagBytes(r.headers.get('etag')) : 0;
            if (live > 0 && live !== mine) {
                if (reloadedJustNow()) {
                    console.warn('page freshness: still different straight after a reload, so this save goes ahead');
                } else {
                    stale = true;
                }
            }
        } catch (e) {
            console.warn('page freshness: the live copy could not be checked', e);
        }
        return stale;
    }

    // True when the live copy of this page differs from the one the tab loaded. A caller that
    // arrives while a check is out waits for that check's answer, never a stale "fresh".
    async function isStale(opts) {
        opts = opts || {};
        if (stale) return true;
        if (pending) return pending;
        const mine = opts.mine != null ? opts.mine : loadedBytes();
        if (!mine) return false;
        const now = Date.now();
        if (!opts.force && now - checkedAt < CHECK_EVERY_MS) return false;
        checkedAt = now;
        pending = ask(mine, opts);
        try { return await pending; } finally { pending = null; }
    }

    // Load the live copy once, after the toast has had time to be read.
    function reload(delayMs) {
        if (reloading) return;
        reloading = true;
        setTimeout(() => {
            try { root.sessionStorage.setItem(reloadKey(), String(Date.now())); }
            catch (e) { console.warn('page freshness: the reload guard could not be written', e); }
            root.location.replace(freshUrl(root.location));
        }, delayMs == null ? 2500 : delayMs);
    }

    function _reset() { checkedAt = 0; stale = false; reloading = false; pending = null; }

    const api = { CHECK_EVERY_MS, etagBytes, loadedBytes, freshUrl, isStale, reload, _reset };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PageFreshness = api;
})(typeof window !== 'undefined' ? window : globalThis);
