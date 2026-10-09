// ── Home tab (Kevin, 29 Sep 2026) ──
// One list of everything that needs Kevin today (the rules live in js/home-list.js), then the
// real Leadership Dashboard underneath. While Home is open, body.home-mode (css/home.css) shows
// the #tab-overview panel below #tab-home, so every dashboard number is the dashboard's own,
// never a copy. Nothing in shared.js or dashboard.js changes: a MutationObserver watches
// #tab-home's active class. On trial beside the old screens; to revert, delete js/home.js,
// js/home-list.js, css/home.css, tests/home-list.test.js and the lines marked "Home tab" in
// index.html, js/config.js, scripts/pre-commit-action.py and the auto-bump workflow.
(function () {
    'use strict';
    const H = window.HomeList;
    const TAB = 'home';
    const READ_TIMEOUT_MS = 30 * 1000;
    const AUTO_RELOAD_MS = 5 * 60 * 1000;
    // The AI Agents queue's own formula (os/agents/index.html APV_QUEUE_FORMULA); its lane filter is applied below.
    const QUEUE_FORMULA = "AND({Status}='Approval', LEN({Sent For Approval By}&'')>0, NOT(IS_AFTER({Deferred Until}, TODAY())), NOT(AND(LEFT({Agent Output}&'', 10)='YOUR STEP:', FIND('KEVIN STEP ', {Approval Feedback}&'')>0)))";
    const recordUrl = (tbl, id) => `https://airtable.com/${BASE_ID}/${tbl}/${id}`;

    let _state = { phase: 'idle' };   // idle | loading | ready | error
    let _loadedAt = 0, _loading = false;

    // A paginated read by field NAME (the brief's shape), with the shell's 429 backoff and a
    // timeout, so a read that never settles cannot hold the page in "loading" for ever.
    async function readAll(tableId, params) {
        const out = [];
        let offset = null;
        do {
            const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
            Object.entries(params).forEach(([k, v]) => (Array.isArray(v) ? v : [v]).forEach(x => url.searchParams.append(k, x)));
            if (offset) url.searchParams.set('offset', offset);
            let resp;
            for (let attempt = 0; attempt < 4; attempt++) {
                const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), READ_TIMEOUT_MS);
                try { resp = await fetch(url, { headers: { Authorization: `Bearer ${PAT}` }, signal: ctl.signal }); }
                catch (e) { throw e.name === 'AbortError' ? new Error(`Airtable did not answer within ${READ_TIMEOUT_MS / 1000} seconds`) : e; }
                finally { clearTimeout(timer); }
                if (resp.status !== 429) break;
                await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 8000)));
            }
            if (resp.status === 401 || resp.status === 403) throw new Error('Airtable refused the sign-in key');
            if (!resp.ok) throw new Error(`Airtable answered ${resp.status}`);
            const data = await resp.json();
            if (!Array.isArray(data.records)) throw new Error('Airtable gave no records list');
            out.push(...data.records);
            offset = data.offset || null;
        } while (offset);
        return out;
    }

    // A side row that fails to read becomes `undefined` (its section then says it could not be
    // read), so one bad row never blanks the whole list.
    async function readEstateRow(key) {
        try { return (await readAll(TABLES.estateStatus, { filterByFormula: `{Key}='${key}'`, pageSize: '10' }))[0] || null; }
        catch (e) { console.warn(`[home] Estate Status row ${key} unreadable:`, e); return undefined; }
    }

    async function load() {
        if (_loading || typeof PAT === 'undefined' || !PAT) return;
        _loading = true; _loadedAt = Date.now();
        if (typeof markTabRefreshing === 'function') markTabRefreshing(TAB);
        if (_state.phase !== 'ready') { _state = { phase: 'loading' }; render(); }
        try {
            const now = Date.now(), today = H.londonToday(new Date(now));
            const [taskRecs, queueRecs, kevinRow, needsRow, blockersRow, tenantsRow, rentRow] = await Promise.all([
                readAll(TABLES.tasks, { filterByFormula: H.OPEN_TASKS_FORMULA, 'fields[]': H.TASK_FIELDS, pageSize: '100' }),
                readAll(TABLES.tasks, { filterByFormula: QUEUE_FORMULA, 'fields[]': ['Task Name', 'Approver'], pageSize: '100' }).catch(e => { console.warn('[home] queue count read failed:', e); return null; }),
                readAll(TABLES.teamMembers, { filterByFormula: `RECORD_ID()='${H.KEVIN_TEAM_MEMBER}'`, 'fields[]': ['Name'] }).catch(e => { console.warn('[home] team member read failed:', e); return null; }),
                readEstateRow(H.ESTATE_KEYS.needsYou), readEstateRow(H.ESTATE_KEYS.blockers), readEstateRow(H.ESTATE_KEYS.tenants),
                readEstateRow(H.ESTATE_KEYS.rent),
            ]);
            const tasks = taskRecs.map(H.toTask);
            // A card he has answered left the queue (QUEUE_FORMULA leaves it out until the sweep takes it):
            // it is not "waiting for your approval" on Home either (Kevin, 9 Oct 2026).
            if (queueRecs) {
                const live = new Set(queueRecs.map(q => q.id));
                tasks.forEach(t => { if (t.inQueue && !live.has(t.id)) t.answered = true; });
            }
            const mine = queueRecs ? queueRecs.filter(q => H.isKevinsLane(((q.fields || {}).Approver || {}).email)) : null;
            const list = H.buildHomeList({ tasks, today, needsRow, blockersRow, now });
            _state = { phase: 'ready', today, list, openTasks: tasks.length, tasks,
                queueCount: mine ? mine.length : null, queueNameless: mine ? mine.filter(q => !String((q.fields || {})['Task Name'] || '').trim()).length : 0, kevinFound: kevinRow ? kevinRow.length === 1 : null,
                tenants: H.readTenants(tenantsRow, today), rent: H.readRent(rentRow, today), at: now };
        } catch (e) {
            console.error('[home] list read failed:', e);
            _state = Object.assign({}, _state, { phase: _state.list ? 'ready' : 'error', error: String(e.message || e) });
        } finally {
            _loading = false;
            render();
            if (typeof markTabSynced === 'function') markTabSynced(TAB);
        }
    }

    function actionFor(item) {
        if (item.inQueue) return '<button type="button" class="home-act" data-home-queue>Open the queue</button>';
        if (item.id) return `<a class="home-act" href="${escHtml(recordUrl(TABLES.tasks, item.id))}" target="_blank" rel="noopener">Open task</a>`;
        return '';
    }
    function rowHtml(item) {
        const meta = [item.when, item.who].filter(Boolean).map(escHtml).join(' · ');
        const cls = item.tag === 'Deadline' || item.legal ? ' home-tag-urgent' : item.tag.indexOf('money') !== -1 || item.tag === 'Only you' ? ' home-tag-money' : '';
        return `<li class="home-row"><span class="home-tag${cls}">${escHtml(item.tag)}</span>
            <span class="home-main"><span class="home-name">${escHtml(item.name)}</span>${meta ? `<span class="home-meta">${meta}</span>` : ''}</span>${actionFor(item)}</li>`;
    }
    function groupHtml(g, list) {
        const deadlineGroup = g.key.indexOf('deadlines') === 0;
        const untrusted = deadlineGroup && !list.ticked
            ? 'No open task carries the Hard Deadline tick at all, so this list cannot be trusted today. Check the approval queue.' : '';
        const note = [g.note, untrusted].filter(Boolean).join(' ');
        if (!g.items.length && !note) return '';
        return `<section class="home-group" aria-label="${escHtml(g.title)}"><h3 class="home-group-title">${escHtml(g.title)} <span class="home-count">${g.items.length}</span></h3>
            ${note ? `<p class="home-note">${escHtml(note)}</p>` : ''}${g.items.length ? `<ul class="home-rows">${g.items.map(rowHtml).join('')}</ul>` : ''}</section>`;
    }

    function render() {
        const host = document.getElementById('homeList');
        if (!host) return;
        // Set on every render, so a Home left open past midnight shows the new day.
        const d = document.getElementById('homeDate');
        if (d) d.textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });
        const s = _state;
        if (s.phase === 'idle' || s.phase === 'loading') {
            host.innerHTML = `<p class="home-loading" role="status">${typeof PAT === 'undefined' || !PAT ? 'Waiting for you to sign in.' : 'Reading what needs you today…'}</p>`;
            return;
        }
        if (s.phase === 'error') {
            host.innerHTML = `<div class="home-error" role="alert">Could not read what needs you today (${escHtml(s.error)}). This list is NOT empty, it could not be read. Press Refresh in the bar above to try again.</div>`;
            return;
        }
        const c = s.list.counts;
        const stale = s.error ? `<div class="home-error" role="alert">The last refresh failed (${escHtml(s.error)}), so this list is from ${escHtml(new Date(s.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }))}.</div>` : '';
        const unchecked = s.list.unchecked.length
            ? ` Not checked: ${s.list.unchecked.join('; ')}.` : '';
        const summary = (c.total
            ? `${c.total} thing${c.total === 1 ? '' : 's'} need${c.total === 1 ? 's' : ''} you today: ${c.deadlinesDueNow} deadline${c.deadlinesDueNow === 1 ? '' : 's'} due now, ${c.onlyYou} only-you, ${c.robots} robot${c.robots === 1 ? '' : 's'} stuck, ${c.needsYou} from the 07:00 check, ${c.deadlines - c.deadlinesDueNow} deadline${c.deadlines - c.deadlinesDueNow === 1 ? '' : 's'} coming up, ${c.approve} to approve.`
            : (s.list.unchecked.length ? 'Nothing found, but part of this list could not be checked, so do not read it as a clear day.' : 'Nothing needs you today. Every list below was read and came back empty.')) + unchecked;
        const t = s.tenants, rent = s.rent;
        host.innerHTML = `${stale}<p class="home-summary" aria-live="polite">${escHtml(summary)}</p>
            ${s.list.groups.map(g => groupHtml(g, s.list)).join('')}
            <p class="home-tenants"><span class="home-light home-light-${escHtml(t.light)}" aria-hidden="true"></span><strong>Tenants:</strong> ${escHtml(t.text)}</p>
            <p class="home-tenants home-rent"><span class="home-light home-light-${escHtml(rent.light)}" aria-hidden="true"></span><strong>Rent:</strong> ${escHtml(rent.text)}</p>`;
    }

    function registerChecks() {
        if (typeof registerSyncBar !== 'function') return;
        const ready = fn => () => (_state.phase !== 'ready' ? { status: _state.phase === 'error' ? 'fail' : 'warn', detail: _state.error || 'Not loaded yet' } : fn(_state));
        registerSyncBar(TAB, {
            refreshFn: () => load(),
            checks: [
                { name: 'Task board read', kind: 'sync', run: ready(s => s.error ? { status: 'fail', detail: `Last refresh failed: ${s.error}` }
                    : s.openTasks > 0 ? { status: 'pass', detail: `${s.openTasks} open tasks read` } : { status: 'fail', detail: 'The read returned no open tasks at all, which is never true' }) },
                { name: 'Hard Deadline tick in use', kind: 'automation', run: ready(s => s.list.ticked > 0
                    ? { status: 'pass', detail: `${s.list.ticked} open task(s) carry the tick` } : { status: 'fail', detail: 'No open task carries the tick, so the deadline list cannot be trusted' }) },
                { name: 'Approvals match the queue', kind: 'sync', run: ready(s => s.queueCount === null ? { status: 'warn', detail: 'The queue count could not be read' }
                    : s.queueCount === s.list.counts.queue ? { status: 'pass', detail: `${s.queueCount} cards, the same count the AI Agents queue uses` }
                    : { status: 'warn', detail: `Home found ${s.list.counts.queue}, the AI Agents queue has ${s.queueCount}` + (s.queueNameless ? ` (${s.queueNameless} card(s) have no name, so Home cannot list them)` : ' (they can differ just after midnight, when the queue\'s date is still yesterday\'s)') }) },
                { name: '07:00 check reported today', kind: 'automation', run: ready(s => { const g = s.list.groups.find(x => x.key === 'needs-you');
                    return g.note ? { status: 'warn', detail: g.note } : { status: 'pass', detail: `${g.items.length} item(s) for you today` }; }) },
                { name: 'Robot blocker check current', kind: 'automation', run: ready(s => { const g = s.list.groups.find(x => x.key === 'robots');
                    return g.note ? { status: 'warn', detail: g.note } : { status: 'pass', detail: `${g.items.length} item(s) only you can clear` }; }) },
                { name: 'Tenant chain ran today', kind: 'automation', run: ready(s => !s.tenants.current
                    ? { status: 'warn', detail: s.tenants.text } : { status: 'pass', detail: 'Today\'s tenant line is in' }) },
                { name: 'Rent check ran today', kind: 'automation', run: ready(s => !s.rent.current
                    ? { status: 'warn', detail: s.rent.text } : { status: 'pass', detail: 'Today\'s rent line is in' }) },
                { name: 'Every deadline has an owner', kind: 'automation', run: ready(s => { const n = s.list.groups.filter(g => g.key.indexOf('deadlines') === 0)
                    .reduce((k, g) => k + g.items.filter(i => i.who === 'NO OWNER').length, 0);
                    return n ? { status: 'warn', detail: `${n} deadline(s) with NO OWNER` } : { status: 'pass', detail: 'Every deadline has a holder' }; }) },
                { name: 'Your team member row exists', kind: 'sync', run: ready(s => s.kevinFound === null ? { status: 'warn', detail: 'Could not check' }
                    : s.kevinFound ? { status: 'pass', detail: 'Only-you items are matched on it' } : { status: 'fail', detail: 'The row only-you items match on is gone, so Only you would always be empty' }) },
            ],
        });
    }

    function wire() {
        const panel = document.getElementById('tab-home');
        if (!panel) return;
        panel.addEventListener('click', e => {
            if (e.target.closest('[data-home-queue]')) {
                if (typeof window.deepLinkAgents === 'function') window.deepLinkAgents({ view: 'approvals' });
                else if (typeof switchTab === 'function') switchTab('agents');
                return;
            }
            const nav = e.target.closest('[data-home-tab]');
            if (nav && typeof switchTab === 'function') switchTab(nav.getAttribute('data-home-tab'));
        });
        const sync = () => {
            const open = panel.classList.contains('active');
            document.body.classList.toggle('home-mode', open);
            if (open && Date.now() - _loadedAt > 60 * 1000) load();
        };
        new MutationObserver(sync).observe(panel, { attributes: true, attributeFilter: ['class'] });
        sync();
        // A cold deep link to #home opens before sign-in has set PAT; read as soon as the shell's data is in.
        if (window.whenMainDataReady && typeof window.whenMainDataReady.then === 'function') {
            window.whenMainDataReady.then(() => { if (panel.classList.contains('active') && _state.phase !== 'ready') load(); });
        }
        // A Home left open refreshes every 5 minutes; a hidden one never reads.
        setInterval(() => {
            if (panel.classList.contains('active') && document.visibilityState === 'visible' && Date.now() - _loadedAt >= AUTO_RELOAD_MS) load();
        }, 15 * 1000);
    }

    function init() {
        if (!H) { console.error('[home] js/home-list.js did not load'); return; }
        registerChecks();
        render();
        wire();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
