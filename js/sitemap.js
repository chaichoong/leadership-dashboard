// ══════════════════════════════════════════
// SITE MAP & LINKS — Renderer, SOP Update Requests
// ══════════════════════════════════════════
    // ── Git Sync Checker ──
    // Map PAGE_REGISTRY id → array of source files to check on GitHub
    const PAGE_SOURCE_FILES = {
        'overview':    ['js/dashboard.js'],
        'tasks':       ['os/tasks/index.html'],
        'cfv':         ['js/cfv.js'],
        'invoices':    ['js/invoices.js'],
        'pnl':         ['js/pnl.js'],
        'comms':       ['follow-up.html'],
        'compliance':  ['compliance.html'],
        'airtable':    [],                               // no single source file — HTML is in index.html
        'launch-plan': ['os/launch-plan.html'],
        'os-hub':      ['os/index.html'],
        'os-bplan':    ['os/business-plan-builder/index.html'],
        'fintable':    ['js/fintable.js'],
        'sitemap':     ['js/sitemap.js'],
    };
    const GITHUB_REPO = 'chaichoong/leadership-dashboard';
    const GIT_SYNC_CACHE_KEY = '_git_sync_cache';
    const GIT_SYNC_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

    // Holds the fetched git data between renderSiteMap calls. null = not checked yet.
    let gitSyncData = null;

    async function fetchLastCommit(path) {
        if (!path) return null;
        const url = `https://api.github.com/repos/${GITHUB_REPO}/commits?path=${encodeURIComponent(path)}&per_page=1`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`GitHub API ${resp.status} for ${path}`);
        const data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        return {
            date: data[0].commit.author.date,
            sha: data[0].sha.slice(0, 7),
            message: data[0].commit.message.split('\n')[0],
        };
    }

    async function runGitSyncCheck(btn) {
        // Check localStorage cache first
        const cached = localStorage.getItem(GIT_SYNC_CACHE_KEY);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (Date.now() - parsed.fetchedAt < GIT_SYNC_CACHE_TTL) {
                    gitSyncData = parsed;
                    renderSiteMap();
                    return;
                }
            } catch {}
        }
        if (btn) { btn.textContent = 'Checking GitHub...'; btn.disabled = true; }
        try {
            const results = {};
            // Build a flat list of every unique path to fetch (page sources + SOPs)
            const paths = new Set();
            for (const p of PAGE_REGISTRY) {
                (PAGE_SOURCE_FILES[p.id] || []).forEach(f => paths.add(f));
                if (p.sopFile) paths.add(p.sopFile);
            }
            // Fetch sequentially to be nice to the 60/hr rate limit, but fast-ish
            for (const path of paths) {
                try {
                    results[path] = await fetchLastCommit(path);
                } catch (e) {
                    results[path] = { error: e.message };
                }
            }
            gitSyncData = { fetchedAt: Date.now(), results };
            localStorage.setItem(GIT_SYNC_CACHE_KEY, JSON.stringify(gitSyncData));
            renderSiteMap();
        } catch (e) {
            alert('Git sync check failed: ' + e.message);
            if (btn) { btn.textContent = 'Check Git Sync'; btn.disabled = false; }
        }
    }

    function clearGitSyncCache() {
        localStorage.removeItem(GIT_SYNC_CACHE_KEY);
        gitSyncData = null;
        renderSiteMap();
    }

    function fmtRelative(iso) {
        if (!iso) return '—';
        const d = new Date(iso);
        const diffMs = Date.now() - d.getTime();
        const diffH = diffMs / 3600000;
        const diffD = diffH / 24;
        if (diffH < 1) return Math.round(diffMs / 60000) + 'm ago';
        if (diffH < 24) return Math.round(diffH) + 'h ago';
        if (diffD < 30) return Math.round(diffD) + 'd ago';
        return d.toLocaleDateString();
    }

    // Return { pageDate, sopDate, stale } for a given PAGE_REGISTRY entry
    function getGitStatus(p) {
        if (!gitSyncData) return null;
        const srcFiles = PAGE_SOURCE_FILES[p.id] || [];
        // Latest page source date across all tracked files for this page
        let pageDate = null;
        for (const f of srcFiles) {
            const r = gitSyncData.results[f];
            if (r && r.date && (!pageDate || r.date > pageDate)) pageDate = r.date;
        }
        const sopRec = p.sopFile ? gitSyncData.results[p.sopFile] : null;
        const sopDate = sopRec && sopRec.date ? sopRec.date : null;
        let stale = false;
        if (pageDate && sopDate) stale = pageDate > sopDate;
        else if (pageDate && !sopDate && p.sopFile) stale = true; // page has source but SOP missing
        return { pageDate, sopDate, stale };
    }

    // ── Site Map Renderer ──
    const SOP_QUEUE_TABLE = 'tbltuZz5Omrpo7t1x';
    const SOP_QUEUE_FIELDS = {
        request: 'fld0ShElHxR10mmBk',
        sopFile: 'fldLvshpipHswyudX',
        pageVersion: 'fldidv94zf8kd0ApG',
        status: 'fldt4Y6lunSdEF0jX',
        pageId: 'fldsrBokVDBz1ZneD',
        requestedAt: 'fldp8IIF9YmmnplzS',
    };

    function renderSiteMap() {
        const tbody = document.getElementById('sitemapTableBody');
        const integrity = document.getElementById('sitemapIntegrity');
        if (!tbody) return;

        let matched = 0;
        let gitStale = 0;
        const outOfSync = [];
        const gitStalePages = [];
        tbody.innerHTML = PAGE_REGISTRY.map((p, i) => {
            const versionMatch = p.pageVer === p.sopVer;
            if (versionMatch) matched++;
            else outOfSync.push(p);

            // Git sync status (only if data has been fetched)
            const gs = getGitStatus(p);
            if (gs && gs.stale) { gitStale++; gitStalePages.push(p); }

            const statusHtml = versionMatch
                ? '<span style="color:var(--success);font-weight:600">✓ In sync</span>'
                : '<span style="color:var(--warning);font-weight:600">⚠ Update needed</span>';

            let gitCell;
            if (!gs) {
                gitCell = '<span style="color:var(--text-muted);font-size:11px">Not checked</span>';
            } else {
                const pageStr = gs.pageDate ? fmtRelative(gs.pageDate) : '—';
                const sopStr = gs.sopDate ? fmtRelative(gs.sopDate) : (p.sopFile ? '—' : 'n/a');
                const label = gs.stale
                    ? `<span style="color:var(--danger);font-weight:600">⚠ SOP stale</span>`
                    : `<span style="color:var(--success);font-weight:600">✓ SOP current</span>`;
                gitCell = `<div style="font-size:11px;line-height:1.4">
                    ${label}<br>
                    <span style="color:var(--text-secondary)">Page: ${pageStr}</span><br>
                    <span style="color:var(--text-secondary)">SOP: ${sopStr}</span>
                </div>`;
            }

            return `<tr>
                <td style="text-align:center;color:var(--text-muted);font-weight:600">${i + 1}</td>
                <td style="font-weight:600">${p.icon} ${escHtml(p.name)}</td>
                <td style="text-align:center;font-family:monospace;font-size:11px">${p.pageVer}</td>
                <td><a href="#${p.id}" onclick="switchTab('${p.id}')" style="font-size:12px">Open</a></td>
                <td style="font-size:11px"><a href="${p.standalone}" target="_blank">${escHtml(p.standalone)}</a> <button class="sitemap-copy" onclick="event.stopPropagation();copyLink('${p.standalone}')">Copy</button></td>
                <td>${p.sopFile ? `<a href="${p.sopFile}" target="_blank" style="font-size:12px">Open SOP</a> <button class="sitemap-copy" onclick="event.stopPropagation();copyLink('${p.sopFile}')">Copy</button>` : '<span style="color:var(--text-muted);font-size:11px">no SOP</span>'}</td>
                <td style="text-align:center;font-family:monospace;font-size:11px">${p.sopVer}</td>
                <td style="text-align:center">${statusHtml}</td>
                <td>${gitCell}</td>
            </tr>`;
        }).join('');

        if (integrity) {
            const total = PAGE_REGISTRY.length;
            const allGood = matched === total;
            let sopRequested = localStorage.getItem('_sop_update_requested');
            // Clear the requested flag if everything is now in sync OR if it's older than 24 hours
            if (sopRequested) {
                const elapsed = Date.now() - new Date(sopRequested).getTime();
                if (outOfSync.length === 0 || elapsed > 24 * 60 * 60 * 1000) {
                    localStorage.removeItem('_sop_update_requested');
                    sopRequested = null;
                }
            }
            let updateAllBtn = '';
            if (outOfSync.length > 0) {
                if (sopRequested) {
                    updateAllBtn = `<button class="cfv-action-btn" style="font-size:11px;padding:8px 16px;margin-top:8px;background:#dcfce7;color:#16a34a;border-color:#16a34a;cursor:default" disabled>✓ Update Requested — Processing (${outOfSync.length} SOPs)</button>`
                        + ` <button class="cfv-action-btn" onclick="resetSOPRequestFlag()" style="font-size:11px;padding:8px 16px;margin-top:8px">Reset &amp; Re-enable</button>`;
                } else {
                    updateAllBtn = `<button class="cfv-action-btn primary" onclick="requestAllSOPUpdates(this)" style="font-size:11px;padding:8px 16px;margin-top:8px">Update All Out-of-Sync SOPs (${outOfSync.length})</button>`;
                }
            }
            // Git sync KPI card + button
            let gitCard, gitBtn;
            if (!gitSyncData) {
                gitCard = `<div class="kpi-card" style="flex:1;min-width:200px;padding:12px 16px">
                    <div class="kpi-card-label">Git Sync</div>
                    <div style="font-size:13px;font-weight:600;color:var(--text-muted)">Not checked yet</div>
                </div>`;
                gitBtn = `<button class="cfv-action-btn primary" onclick="runGitSyncCheck(this)" style="font-size:11px;padding:8px 16px;margin-top:8px">Check Git Sync</button>`;
            } else {
                const gitGood = gitStale === 0;
                const fetchedRel = fmtRelative(new Date(gitSyncData.fetchedAt).toISOString());
                gitCard = `<div class="kpi-card" style="flex:1;min-width:200px;padding:12px 16px">
                    <div class="kpi-card-label">Git Sync (real)</div>
                    <div style="font-size:20px;font-weight:700;color:${gitGood ? 'var(--success)' : 'var(--danger)'}">${total - gitStale}/${total} ${gitGood ? '✓' : '⚠'}</div>
                    <div style="font-size:10px;color:var(--text-muted);margin-top:2px">Checked ${fetchedRel}</div>
                </div>`;
                gitBtn = `<button class="cfv-action-btn" onclick="clearGitSyncCache();runGitSyncCheck(this)" style="font-size:11px;padding:8px 16px;margin-top:8px">Re-check Git Sync</button>`;
            }

            integrity.innerHTML = `
                <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
                    <div class="kpi-card" style="flex:1;min-width:160px;padding:12px 16px">
                        <div class="kpi-card-label">Pages</div>
                        <div style="font-size:20px;font-weight:700">${total}</div>
                    </div>
                    <div class="kpi-card" style="flex:1;min-width:160px;padding:12px 16px">
                        <div class="kpi-card-label">SOPs</div>
                        <div style="font-size:20px;font-weight:700">${total}</div>
                    </div>
                    <div class="kpi-card" style="flex:1;min-width:160px;padding:12px 16px">
                        <div class="kpi-card-label">Version Sync (declared)</div>
                        <div style="font-size:20px;font-weight:700;color:${allGood ? 'var(--success)' : 'var(--warning)'}">${matched}/${total} ${allGood ? '✓' : '⚠'}</div>
                    </div>
                    ${gitCard}
                </div>
                <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
                    ${gitBtn}
                    ${updateAllBtn}
                </div>
                ${gitSyncData && gitStale > 0 ? `<div style="margin-top:8px;padding:10px 12px;background:var(--danger-bg);border:1px solid var(--danger);border-radius:6px;font-size:12px;color:var(--danger)">
                    <strong>⚠ ${gitStale} SOP${gitStale === 1 ? '' : 's'} stale in git:</strong> ${gitStalePages.map(p => escHtml(p.name)).join(', ')}. The page source file has been edited since the SOP was last written.
                </div>` : ''}
            `;
        }
    }

    async function requestSOPUpdate(pageId, sopFile, pageVer, pageName, btn) {
        if (!PAT) { alert('No Airtable token'); return; }
        btn.textContent = 'Requesting...';
        btn.disabled = true;
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${SOP_QUEUE_TABLE}`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: {
                    [SOP_QUEUE_FIELDS.request]: `Update ${pageName} SOP to v${pageVer}`,
                    [SOP_QUEUE_FIELDS.sopFile]: sopFile,
                    [SOP_QUEUE_FIELDS.pageVersion]: pageVer,
                    [SOP_QUEUE_FIELDS.status]: 'Pending',
                    [SOP_QUEUE_FIELDS.pageId]: pageId,
                    [SOP_QUEUE_FIELDS.requestedAt]: new Date().toISOString(),
                }})
            });
            if (resp.ok) {
                btn.textContent = 'Queued ✓';
                btn.style.background = '#dcfce7';
                btn.style.color = '#16a34a';
                const toast = document.getElementById('shareToast');
                toast.textContent = `SOP update queued for ${pageName} — will be processed automatically`;
                toast.style.display = 'block';
                setTimeout(() => { toast.style.display = 'none'; }, 4000);
            } else {
                btn.textContent = 'Failed';
                btn.disabled = false;
            }
        } catch (e) {
            btn.textContent = 'Failed';
            btn.disabled = false;
            alert('Error: ' + e.message);
        }
    }

    async function requestAllSOPUpdates(btn) {
        if (!confirm('Queue SOP updates for all out-of-sync pages?')) return;
        btn.textContent = 'Requesting...';
        btn.disabled = true;
        for (const p of PAGE_REGISTRY) {
            if (p.pageVer !== p.sopVer) {
                await requestSOPUpdate(p.id, p.sopFile, p.pageVer, p.name, { textContent: '', disabled: false, style: {} });
                await new Promise(r => setTimeout(r, 300));
            }
        }
        // Mark as requested in localStorage so it persists across refreshes
        localStorage.setItem('_sop_update_requested', new Date().toISOString());
        btn.textContent = '✓ Update Requested — Processing';
        btn.style.background = '#dcfce7';
        btn.style.color = '#16a34a';
        btn.style.borderColor = '#16a34a';
        const toast = document.getElementById('shareToast');
        toast.textContent = 'All SOP updates queued — will be processed automatically';
        toast.style.display = 'block';
        setTimeout(() => { toast.style.display = 'none'; }, 4000);
    }

    function resetSOPRequestFlag() {
        localStorage.removeItem('_sop_update_requested');
        renderSiteMap();
    }

    // Share current page — copies the deep link to clipboard
