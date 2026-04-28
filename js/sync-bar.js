// ══════════════════════════════════════════
// SYNC BAR + HEALTH CHECK — shared across all tabs
// ══════════════════════════════════════════
// Each tab registers a config with a refresh function and a list of checks.
// The checks are functions returning { status: 'pass'|'warn'|'fail', detail: '…' }.
// The bar shows freshness + a roll-up health pill; clicking the pill expands a
// drawer with each check's status and detail. The intent: at any moment Kevin
// can verify "the data on this tab actually matches Airtable AND every
// automation that should be running is running" — exactly the kind of check
// that confirmed Inbound Comms was healthy.
//
// Usage from a tab's renderer (called after data loads successfully):
//   registerSyncBar('overview', {
//     refreshFn: () => loadDashboard(),
//     checks: [
//       { name: 'Santander balance loaded', kind: 'sync', run: () => {…} },
//       { name: 'Smart refresh timer running', kind: 'automation', run: () => {…} },
//     ],
//   });
//   markTabSynced('overview');
//
// Each check's run() returns:
//   { status: 'pass'|'warn'|'fail', detail: 'human-readable line' }

    const _syncBars = {}; // tabId → { lastSyncedAt, refreshFn, isRefreshing, checks, drawerOpen, lastResults, lastRunAt }

    function registerSyncBar(tabId, config) {
        const existing = _syncBars[tabId] || {};
        _syncBars[tabId] = {
            lastSyncedAt: existing.lastSyncedAt || null,
            isRefreshing: existing.isRefreshing || false,
            drawerOpen: existing.drawerOpen || false,
            lastResults: existing.lastResults || null,
            lastRunAt: existing.lastRunAt || null,
            ...config,
        };
        renderSyncBar(tabId);
    }

    function markTabSynced(tabId) {
        const s = _syncBars[tabId];
        if (!s) return;
        s.lastSyncedAt = Date.now();
        s.isRefreshing = false;
        // Auto-run checks once on each successful sync so the pill is always live
        runHealthChecks(tabId);
    }

    function markTabRefreshing(tabId) {
        const s = _syncBars[tabId];
        if (!s) return;
        s.isRefreshing = true;
        renderSyncBar(tabId);
    }

    function runHealthChecks(tabId) {
        const s = _syncBars[tabId];
        if (!s) return;
        const checks = (s.checks || []).map(c => {
            try {
                const r = c.run() || { status: 'warn', detail: 'No result returned' };
                return { name: c.name, kind: c.kind || 'sync', ...r };
            } catch (e) {
                return { name: c.name, kind: c.kind || 'sync', status: 'fail', detail: 'Check threw: ' + (e.message || String(e)) };
            }
        });
        s.lastResults = checks;
        s.lastRunAt = Date.now();
        renderSyncBar(tabId);
    }

    function _formatAge(ms) {
        if (ms == null) return 'never';
        const sec = Math.floor(ms / 1000);
        if (sec < 5) return 'just now';
        if (sec < 60) return sec + 's ago';
        const min = Math.floor(sec / 60);
        if (min < 60) return min + ' min ago';
        const hr = Math.floor(min / 60);
        if (hr < 24) return hr + 'h ago';
        return Math.floor(hr / 24) + 'd ago';
    }

    function _rollupStatus(results) {
        if (!results || !results.length) return 'unknown';
        if (results.some(r => r.status === 'fail')) return 'fail';
        if (results.some(r => r.status === 'warn')) return 'warn';
        return 'pass';
    }

    function renderSyncBar(tabId) {
        const host = document.querySelector(`[data-sync-bar="${tabId}"]`);
        if (!host) return;
        const s = _syncBars[tabId] || {};

        const ageMs = s.lastSyncedAt ? Date.now() - s.lastSyncedAt : null;
        let dotClass = 'gray';
        let timeText = 'Not yet loaded';
        if (s.isRefreshing) {
            dotClass = 'blue';
            timeText = 'Refreshing…';
        } else if (s.lastSyncedAt) {
            timeText = 'Synced ' + _formatAge(ageMs);
            if (ageMs < 5 * 60000) dotClass = 'green';
            else if (ageMs < 30 * 60000) dotClass = 'amber';
            else dotClass = 'red';
        }

        const rollup = _rollupStatus(s.lastResults);
        // Health dot inherits the worse of (freshness, health) so a single glance tells Kevin if anything is off
        if (rollup === 'fail') dotClass = 'red';
        else if (rollup === 'warn' && dotClass === 'green') dotClass = 'amber';

        let pillText = '— No checks';
        let pillClass = 'gray';
        if (s.lastResults && s.lastResults.length) {
            const pass = s.lastResults.filter(r => r.status === 'pass').length;
            const total = s.lastResults.length;
            pillText = `${pass}/${total} checks ${rollup === 'pass' ? '✓' : rollup === 'warn' ? '⚠' : '✗'}`;
            pillClass = rollup === 'pass' ? 'green' : rollup === 'warn' ? 'amber' : 'red';
        }

        const refreshDisabled = s.isRefreshing || !s.refreshFn;
        const drawerHtml = s.drawerOpen ? _renderDrawer(tabId, s) : '';

        host.innerHTML = `
            <div class="sync-bar">
                <span class="sync-bar-dot ${dotClass}" aria-hidden="true"></span>
                <span class="sync-bar-time">${escHtml(timeText)}</span>
                <button class="sync-bar-refresh" onclick="triggerSyncBarRefresh('${tabId}')" ${refreshDisabled ? 'disabled' : ''} title="Re-fetch this tab's data">↻ Refresh</button>
                <button class="sync-bar-health ${pillClass}" onclick="toggleHealthDrawer('${tabId}')" title="Click to expand checks">${pillText}</button>
            </div>
            ${drawerHtml}
        `;
    }

    function _renderDrawer(tabId, s) {
        const results = s.lastResults || [];
        if (!results.length) {
            return `<div class="sync-bar-drawer"><em style="color:var(--text-muted)">No checks defined for this tab yet.</em></div>`;
        }
        const grouped = { sync: [], automation: [] };
        results.forEach(r => {
            const k = (r.kind === 'automation') ? 'automation' : 'sync';
            grouped[k].push(r);
        });
        const renderGroup = (heading, items) => {
            if (!items.length) return '';
            return `
                <div class="sync-check-group">
                    <div class="sync-check-heading">${heading}</div>
                    ${items.map(r => `
                        <div class="sync-check-item ${r.status}">
                            <span class="sync-check-icon">${r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : '✗'}</span>
                            <div class="sync-check-body">
                                <div class="sync-check-name">${escHtml(r.name)}</div>
                                <div class="sync-check-detail">${escHtml(r.detail || '')}</div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;
        };
        const lastRunText = s.lastRunAt ? 'Checks last run ' + _formatAge(Date.now() - s.lastRunAt) : '';
        return `
            <div class="sync-bar-drawer">
                <div class="sync-bar-drawer-header">
                    <strong>Health check</strong>
                    <span style="color:var(--text-muted);font-size:var(--fs-xs);margin-left:8px">${escHtml(lastRunText)}</span>
                    <button class="sync-bar-rerun" onclick="runHealthChecks('${tabId}')" title="Re-run all checks">Re-run</button>
                </div>
                ${renderGroup('Data sync', grouped.sync)}
                ${renderGroup('Automations & feature health', grouped.automation)}
            </div>
        `;
    }

    function triggerSyncBarRefresh(tabId) {
        const s = _syncBars[tabId];
        if (!s || !s.refreshFn || s.isRefreshing) return;
        markTabRefreshing(tabId);
        Promise.resolve()
            .then(() => s.refreshFn())
            .catch(e => console.warn(`[sync-bar] refresh failed for ${tabId}`, e))
            .finally(() => {
                // Each tab's load function is responsible for calling markTabSynced when done.
                // Fallback: if 30s passes without it being called, force-clear the spinner so
                // the UI never gets stuck on "Refreshing…".
                setTimeout(() => {
                    const cur = _syncBars[tabId];
                    if (cur && cur.isRefreshing) markTabSynced(tabId);
                }, 30000);
            });
    }

    function toggleHealthDrawer(tabId) {
        const s = _syncBars[tabId];
        if (!s) return;
        s.drawerOpen = !s.drawerOpen;
        // Re-run checks when opening so the user sees current state, not stale results
        if (s.drawerOpen) runHealthChecks(tabId);
        else renderSyncBar(tabId);
    }

    // Tick freshness display every 15s so "X min ago" stays current without a re-render
    setInterval(() => {
        Object.keys(_syncBars).forEach(tabId => {
            const s = _syncBars[tabId];
            // Only re-render the chrome bits, not the whole drawer (which would jitter on click)
            if (!document.querySelector(`[data-sync-bar="${tabId}"]`)) return;
            const ageMs = s.lastSyncedAt ? Date.now() - s.lastSyncedAt : null;
            const timeEl = document.querySelector(`[data-sync-bar="${tabId}"] .sync-bar-time`);
            if (timeEl && !s.isRefreshing && s.lastSyncedAt) {
                timeEl.textContent = 'Synced ' + _formatAge(ageMs);
            }
        });
    }, 15000);
