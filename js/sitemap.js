// ══════════════════════════════════════════
// SITE MAP & LINKS — Renderer, SOP Update Requests
// ══════════════════════════════════════════
    // ── Git Sync Checker ──
    // Map PAGE_REGISTRY id → array of source files to check on GitHub
    const PAGE_SOURCE_FILES = {
        'overview':    ['js/dashboard.js'],
        'os-strategy': ['os/strategy/index.html', 'os/strategy/strategy.js', 'os/strategy/strategy.css'],
        'tasks':       ['os/tasks/index.html'],
        'cfv':         ['js/cfv.js'],
        'invoices':    ['js/invoices.js'],
        'pnl':         ['js/pnl.js'],
        'comms':       ['follow-up.html'],
        'compliance':  ['compliance.html'],
        'launch-plan': ['os/launch-plan.html'],
        'os-hub':      ['os/index.html'],
        'os-bplan':    ['os/business-plan-builder/index.html'],
        'fintable':    ['js/fintable.js'],
        'sitemap':     ['js/sitemap.js'],
    };
    const GITHUB_REPO = 'chaichoong/leadership-dashboard';
    const GIT_SYNC_CACHE_KEY = '_git_sync_cache';
    const GIT_SYNC_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
    const GITHUB_PAT_KEY = '_github_pat';
    // Authenticated requests on public repos get 5,000/hr instead of 60/hr.
    // Any classic token (no scopes needed) or fine-grained token with
    // "Contents: read" on this repo works.

    function githubAuthHeaders() {
        const pat = localStorage.getItem(GITHUB_PAT_KEY);
        return pat ? { 'Authorization': 'Bearer ' + pat } : {};
    }

    function setGitHubToken() {
        const current = localStorage.getItem(GITHUB_PAT_KEY);
        const input = prompt(
            'Paste a GitHub personal access token to raise the rate limit from 60/hr to 5,000/hr.\n\n' +
            'Any classic token with no scopes works (repo is public). Clear the field and OK to remove an existing token.',
            current || ''
        );
        if (input === null) return; // cancelled
        const trimmed = input.trim();
        if (!trimmed) {
            localStorage.removeItem(GITHUB_PAT_KEY);
            alert('GitHub token removed. Reverting to 60/hr unauthenticated limit.');
        } else if (!/^gh[pous]_[A-Za-z0-9]{20,}$|^github_pat_[A-Za-z0-9_]{20,}$/.test(trimmed)) {
            if (!confirm('That doesn\'t look like a standard GitHub token (ghp_… or github_pat_…). Save anyway?')) return;
            localStorage.setItem(GITHUB_PAT_KEY, trimmed);
        } else {
            localStorage.setItem(GITHUB_PAT_KEY, trimmed);
        }
        // Clear cached data and re-render so the new auth state shows
        localStorage.removeItem(GIT_SYNC_CACHE_KEY);
        gitSyncData = null;
        renderSiteMap();
    }

    // Holds the fetched git data between renderSiteMap calls. null = not checked yet.
    let gitSyncData = null;

    // Parse the total commit count out of a GitHub API Link header.
    // Link looks like: <url&page=42>; rel="last". That tells us the total pages
    // at per_page=1, i.e. the total commit count for the path. If no Link header
    // (≤1 page of results), the count is the length of the current response.
    function commitCountFromLink(linkHeader, fallback) {
        if (!linkHeader) return fallback;
        const m = linkHeader.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
        return m ? parseInt(m[1], 10) : fallback;
    }

    async function fetchLastCommit(path) {
        if (!path) return null;
        const url = `https://api.github.com/repos/${GITHUB_REPO}/commits?path=${encodeURIComponent(path)}&per_page=1`;
        const resp = await fetch(url, { headers: githubAuthHeaders() });
        if (resp.status === 401) {
            // Token invalid — wipe it so the user isn't stuck
            localStorage.removeItem(GITHUB_PAT_KEY);
            throw new Error('GitHub token rejected (401) — token cleared, falling back to unauthenticated');
        }
        if (resp.status === 403 || resp.status === 429) {
            // Rate limit exceeded — include remaining budget in error
            const remaining = resp.headers.get('x-ratelimit-remaining');
            const reset = resp.headers.get('x-ratelimit-reset');
            const resetIn = reset ? Math.max(0, Math.round((+reset * 1000 - Date.now()) / 60000)) : '?';
            throw new Error(`rate-limited (resets in ${resetIn}m, remaining=${remaining})`);
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) return null;
        const count = commitCountFromLink(resp.headers.get('link'), data.length);
        return {
            date: data[0].commit.author.date,
            sha: data[0].sha.slice(0, 7),
            message: data[0].commit.message.split('\n')[0],
            count, // total commits for this path
        };
    }

    // For a stale page, count how many page-source commits landed AFTER the SOP's
    // last commit. That's the "improvements behind" number.
    async function fetchCommitsSince(path, sinceIso) {
        if (!path || !sinceIso) return null;
        const url = `https://api.github.com/repos/${GITHUB_REPO}/commits?path=${encodeURIComponent(path)}&since=${encodeURIComponent(sinceIso)}&per_page=1`;
        const resp = await fetch(url, { headers: githubAuthHeaders() });
        if (resp.status === 403 || resp.status === 429) {
            throw new Error('rate-limited');
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!Array.isArray(data)) return 0;
        return commitCountFromLink(resp.headers.get('link'), data.length);
    }

    // All paths we currently expect to have fetched for the checker to be complete.
    function expectedSyncPaths() {
        const paths = new Set();
        for (const p of PAGE_REGISTRY) {
            (PAGE_SOURCE_FILES[p.id] || []).forEach(f => paths.add(f));
            if (p.sopFile) paths.add(p.sopFile);
        }
        return paths;
    }

    async function runGitSyncCheck(btn) {
        // Check localStorage cache first
        const cached = localStorage.getItem(GIT_SYNC_CACHE_KEY);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                const fresh = Date.now() - parsed.fetchedAt < GIT_SYNC_CACHE_TTL;
                // Require the cache to have a SUCCESSFUL entry for every path we
                // currently expect. This handles two failure modes:
                //   (a) PAGE_SOURCE_FILES has grown since this cache was written
                //       (e.g. we added strategy sources) — missing keys force refetch.
                //   (b) A prior run was partially rate-limited, leaving error
                //       entries instead of real data. A later run (e.g. with a
                //       GitHub token now set) should refetch those.
                // An entry counts as "good" if it's null (file has no commits,
                // which is valid) or has a `date` field (successful fetch).
                const expected = expectedSyncPaths();
                const covered = parsed.results && [...expected].every(p => {
                    const r = parsed.results[p];
                    return r === null || (r && r.date);
                });
                if (fresh && covered) {
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
            let rateLimited = false;
            for (const path of paths) {
                if (rateLimited) {
                    results[path] = { error: 'skipped: rate limit hit earlier in run' };
                    continue;
                }
                try {
                    results[path] = await fetchLastCommit(path);
                } catch (e) {
                    results[path] = { error: e.message };
                    if (/rate-limited/.test(e.message)) rateLimited = true;
                }
            }
            // Second pass: for each page, if its source was committed AFTER the SOP,
            // count commits to the source since the SOP's last commit. That's "improvements
            // behind". Keyed by page.id in a side-map.
            const driftByPage = {};
            if (!rateLimited) {
                for (const p of PAGE_REGISTRY) {
                    if (!p.sopFile) continue;
                    const srcFiles = PAGE_SOURCE_FILES[p.id] || [];
                    if (srcFiles.length === 0) continue;
                    const sopRec = results[p.sopFile];
                    if (!sopRec || !sopRec.date) continue;
                    // Pick latest page source date across this page's source files
                    let latestSrc = null;
                    for (const f of srcFiles) {
                        const r = results[f];
                        if (r && r.date && (!latestSrc || r.date > latestSrc)) latestSrc = r.date;
                    }
                    if (!latestSrc || latestSrc <= sopRec.date) continue; // not stale, skip
                    try {
                        // Use the first (latest) source file for drift. Good enough for pages
                        // with a single source file (which is all of them today).
                        const driftCount = await fetchCommitsSince(srcFiles[0], sopRec.date);
                        if (driftCount != null) driftByPage[p.id] = driftCount;
                    } catch (e) {
                        if (/rate-limited/.test(e.message)) { rateLimited = true; break; }
                    }
                }
            }

            // Count how many genuinely succeeded (got a date OR returned null cleanly)
            const successCount = Object.values(results).filter(r => r === null || (r && r.date)).length;
            const errorCount = Object.values(results).filter(r => r && r.error).length;
            gitSyncData = { fetchedAt: Date.now(), results, driftByPage, successCount, errorCount, rateLimited };
            // Only cache if most calls succeeded — don't poison the cache with a mostly-failed run
            if (successCount >= paths.size / 2) {
                localStorage.setItem(GIT_SYNC_CACHE_KEY, JSON.stringify(gitSyncData));
            }
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
        updateSitemapBadge();
    }

    // Sidebar badge next to "Site Map & Links" — total pages needing attention.
    // When git sync data is loaded, counts git-stale + missing-SOP + unknown.
    // Before any sync has run, falls back to the old declared-version mismatch
    // count so the badge still signals something useful on a fresh page load.
    function updateSitemapBadge() {
        const badge = document.getElementById('sitemapBadge');
        if (!badge) return;
        let stale = 0, missing = 0, unknown = 0, declaredOnly = 0;
        if (gitSyncData) {
            for (const p of PAGE_REGISTRY) {
                const gs = getGitStatus(p);
                if (!gs) continue;
                if (gs.state === 'stale') stale++;
                else if (gs.state === 'no-sop') missing++;
                else if (gs.state === 'unknown') unknown++;
            }
        } else {
            declaredOnly = PAGE_REGISTRY.filter(p => p.pageVer !== p.sopVer).length;
        }
        const total = gitSyncData ? (stale + missing + unknown) : declaredOnly;
        if (total > 0) {
            badge.textContent = total;
            badge.style.display = 'inline-block';
            // Red if anything stale/missing/declared-mismatch; orange only when
            // the sole issue is "unknown" (can't make a real call yet).
            const anyAction = stale + missing + declaredOnly > 0;
            badge.style.background = anyAction ? 'var(--danger)' : 'var(--warning)';
            badge.title = gitSyncData
                ? `${stale} stale · ${missing} missing SOP${unknown ? ' · ' + unknown + ' unknown' : ''}`
                : `${declaredOnly} page${declaredOnly === 1 ? '' : 's'} with declared-version mismatch — click Check Git Sync for real status`;
        } else {
            badge.style.display = 'none';
            badge.title = '';
        }
    }

    // Auto-load cached sync data on script start so the table AND sidebar badge
    // reflect the last-known state without requiring any clicks. We deliberately
    // ignore the TTL here — showing old-but-complete data is far better than
    // reverting to "Not checked yet" on a hard refresh. The "checked X ago"
    // line in the KPI card tells the user exactly how fresh it is, and the
    // Re-check button is one click away. TTL still gates runGitSyncCheck so an
    // intentional click that sees stale cache will refetch.
    (function primeSitemapBadge() {
        try {
            const cached = localStorage.getItem(GIT_SYNC_CACHE_KEY);
            if (!cached) return;
            const parsed = JSON.parse(cached);
            const expected = expectedSyncPaths();
            const covered = parsed.results && [...expected].every(p => {
                const r = parsed.results[p];
                return r === null || (r && r.date);
            });
            if (covered) gitSyncData = parsed;
        } catch {}
        // Wait for DOM so the badge element exists; then paint.
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', updateSitemapBadge);
        } else {
            updateSitemapBadge();
        }
    })();

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

    // Return full git status for a page: dates, commit counts, drift count, state.
    // state is one of: 'stale' | 'current' | 'unknown' | 'no-source' | 'no-sop'
    function getGitStatus(p) {
        if (!gitSyncData) return null;
        const srcFiles = PAGE_SOURCE_FILES[p.id] || [];
        const errors = [];
        // Latest page source date + commit count across all tracked files for this page
        let pageDate = null;
        let pageCount = null;
        for (const f of srcFiles) {
            const r = gitSyncData.results[f];
            if (!r) continue;
            if (r.error) { errors.push(`${f}: ${r.error}`); continue; }
            if (r.date && (!pageDate || r.date > pageDate)) pageDate = r.date;
            if (typeof r.count === 'number') {
                pageCount = (pageCount == null) ? r.count : Math.max(pageCount, r.count);
            }
        }
        const sopRec = p.sopFile ? gitSyncData.results[p.sopFile] : null;
        let sopDate = null, sopCount = null;
        if (sopRec) {
            if (sopRec.error) errors.push(`${p.sopFile}: ${sopRec.error}`);
            else {
                if (sopRec.date) sopDate = sopRec.date;
                if (typeof sopRec.count === 'number') sopCount = sopRec.count;
            }
        }
        const driftCount = gitSyncData.driftByPage ? gitSyncData.driftByPage[p.id] : null;

        // Determine state
        let state, stale = false;
        if (srcFiles.length === 0) {
            state = 'no-source';           // page has no tracked source file (e.g. Contractor Job List)
        } else if (!p.sopFile) {
            state = 'no-sop';              // page has source but no SOP to compare
        } else if (!pageDate && !sopDate) {
            state = 'unknown';             // both API calls failed (rate limit or network)
        } else if (!pageDate || !sopDate) {
            state = 'unknown';             // partial data — can't make a call
        } else {
            stale = pageDate > sopDate;
            state = stale ? 'stale' : 'current';
        }
        return { pageDate, sopDate, pageCount, sopCount, driftCount, stale, state, errors };
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
        let gitUnknown = 0;
        let gitCurrent = 0;
        let gitMissingSop = 0;
        const outOfSync = [];
        const gitStalePages = [];
        const gitUnknownPages = [];
        const gitMissingSopPages = [];
        tbody.innerHTML = PAGE_REGISTRY.map((p, i) => {
            const versionMatch = p.pageVer === p.sopVer;
            if (versionMatch) matched++;
            else outOfSync.push(p);

            // Git sync status (only if data has been fetched)
            const gs = getGitStatus(p);
            if (gs) {
                if (gs.state === 'stale') { gitStale++; gitStalePages.push(p); }
                else if (gs.state === 'current') gitCurrent++;
                else if (gs.state === 'unknown') { gitUnknown++; gitUnknownPages.push(p); }
                else if (gs.state === 'no-sop') { gitMissingSop++; gitMissingSopPages.push(p); }
            }

            // Status: prefer git truth when we have it; fall back to declared-version match
            let statusHtml;
            if (gs && gs.state === 'stale') {
                statusHtml = '<span style="color:var(--danger);font-weight:600">⚠ Update needed</span>';
            } else if (gs && gs.state === 'current') {
                statusHtml = '<span style="color:var(--success);font-weight:600">✓ In sync</span>';
            } else if (gs && gs.state === 'unknown') {
                statusHtml = '<span style="color:var(--warning);font-weight:600">? Unknown</span>';
            } else if (gs && gs.state === 'no-sop') {
                // Page has source but no SOP — an SOP needs to be created
                statusHtml = '<span style="color:var(--danger);font-weight:600">⚠ SOP needed</span>';
            } else if (gs && gs.state === 'no-source') {
                statusHtml = '<span style="color:var(--text-muted);font-weight:500">—</span>';
            } else {
                // No git data yet — fall back to declared-version comparison
                statusHtml = versionMatch
                    ? '<span style="color:var(--success);font-weight:600">✓ In sync (declared)</span>'
                    : '<span style="color:var(--warning);font-weight:600">⚠ Update needed (declared)</span>';
            }

            let gitCell;
            if (!gs) {
                gitCell = '<span style="color:var(--text-muted);font-size:11px">Not checked</span>';
            } else {
                const pageStr = gs.pageDate ? fmtRelative(gs.pageDate) : (gs.state === 'no-source' ? 'no source tracked' : '—');
                const sopStr = gs.sopDate ? fmtRelative(gs.sopDate) : (gs.state === 'no-sop' ? 'no SOP' : '—');
                let label;
                if (gs.state === 'stale') {
                    label = `<span style="color:var(--danger);font-weight:600">⚠ SOP stale</span>`;
                } else if (gs.state === 'current') {
                    label = `<span style="color:var(--success);font-weight:600">✓ SOP current</span>`;
                } else if (gs.state === 'unknown') {
                    const errTip = gs.errors.length ? ' title="' + escHtml(gs.errors.join(' | ')) + '"' : '';
                    label = `<span style="color:var(--warning);font-weight:600"${errTip}>? Unknown (API error)</span>`;
                } else if (gs.state === 'no-source') {
                    label = `<span style="color:var(--text-muted);font-weight:500">— no tracked source</span>`;
                } else if (gs.state === 'no-sop') {
                    label = `<span style="color:var(--danger);font-weight:600">⚠ SOP needed</span>`;
                }
                gitCell = `<div style="font-size:11px;line-height:1.4">
                    ${label}<br>
                    <span style="color:var(--text-secondary)">Page: ${pageStr}</span><br>
                    <span style="color:var(--text-secondary)">SOP: ${sopStr}</span>
                </div>`;
            }

            // Page v. / SOP v. cells: git commit count is the live version number,
            // declared pageVer/sopVer from config.js is shown as a small semver tag
            // underneath for continuity. Drift count appears under Page v. when stale.
            const pageVerCell = (() => {
                // Headline: git commit count if we have it, else declared pageVer.
                let headline;
                if (gs && typeof gs.pageCount === 'number') {
                    const colour = gs.state === 'stale' ? 'var(--danger)' : 'var(--text-primary)';
                    headline = `<div style="font-family:monospace;font-size:14px;font-weight:700;color:${colour}">v${gs.pageCount}</div>`;
                } else {
                    headline = `<div style="font-family:monospace;font-size:12px;font-weight:600">${p.pageVer}</div>`;
                }
                let lines = headline;
                // Sub-line: declared tag (if we have git data) + date + drift.
                if (gs && typeof gs.pageCount === 'number') {
                    lines += `<div style="font-size:10px;color:var(--text-muted);margin-top:1px">tag ${escHtml(p.pageVer)}</div>`;
                }
                if (gs && gs.pageDate) {
                    const col = gs.state === 'stale' ? 'var(--danger)' : 'var(--text-muted)';
                    lines += `<div style="font-size:10px;color:${col};margin-top:1px">${fmtRelative(gs.pageDate)}</div>`;
                }
                if (gs && gs.state === 'stale' && typeof gs.driftCount === 'number' && gs.driftCount > 0) {
                    lines += `<div style="font-size:10px;color:var(--danger);font-weight:600;margin-top:1px" title="page-source commits since SOP was last written">⚠ ${gs.driftCount} improvement${gs.driftCount === 1 ? '' : 's'} behind</div>`;
                }
                if (gs && gs.state === 'no-source') {
                    lines += `<div style="font-size:10px;color:var(--text-muted);margin-top:1px">no tracked src</div>`;
                } else if (gs && gs.errors.length && !gs.pageDate) {
                    lines += `<div style="font-size:10px;color:var(--warning);margin-top:1px">? unknown</div>`;
                }
                return lines;
            })();
            const sopVerCell = (() => {
                let headline;
                if (gs && typeof gs.sopCount === 'number') {
                    headline = `<div style="font-family:monospace;font-size:14px;font-weight:700;color:var(--text-primary)">v${gs.sopCount}</div>`;
                } else {
                    headline = `<div style="font-family:monospace;font-size:12px;font-weight:600">${p.sopVer}</div>`;
                }
                let lines = headline;
                if (gs && typeof gs.sopCount === 'number') {
                    lines += `<div style="font-size:10px;color:var(--text-muted);margin-top:1px">tag ${escHtml(p.sopVer)}</div>`;
                }
                if (gs && gs.sopDate) {
                    lines += `<div style="font-size:10px;color:var(--text-muted);margin-top:1px">${fmtRelative(gs.sopDate)}</div>`;
                } else if (gs && !p.sopFile) {
                    lines += `<div style="font-size:10px;color:var(--danger);font-weight:600;margin-top:1px">needs SOP</div>`;
                } else if (gs && gs.errors.length && !gs.sopDate) {
                    lines += `<div style="font-size:10px;color:var(--warning);margin-top:1px">? unknown</div>`;
                }
                return lines;
            })();

            return `<tr>
                <td style="text-align:center;color:var(--text-muted);font-weight:600">${i + 1}</td>
                <td style="font-weight:600">${p.icon} ${escHtml(p.name)}</td>
                <td style="text-align:center">${pageVerCell}</td>
                <td><a href="#${p.id}" onclick="switchTab('${p.id}')" style="font-size:12px">Open</a></td>
                <td style="font-size:11px"><a href="${p.standalone}" target="_blank">${escHtml(p.standalone)}</a> <button class="sitemap-copy" onclick="event.stopPropagation();copyLink('${p.standalone}')">Copy</button></td>
                <td>${p.sopFile ? `<a href="${p.sopFile}" target="_blank" style="font-size:12px">Open SOP</a> <button class="sitemap-copy" onclick="event.stopPropagation();copyLink('${p.sopFile}')">Copy</button>` : '<span style="color:var(--text-muted);font-size:11px">no SOP</span>'}</td>
                <td style="text-align:center">${sopVerCell}</td>
                <td style="text-align:center">${statusHtml}</td>
                <td>${gitCell}</td>
            </tr>`;
        }).join('');

        if (integrity) {
            const total = PAGE_REGISTRY.length;
            const allGood = matched === total;
            // Pages that need SOP attention = git-stale (SOP behind page) PLUS
            // pages with source but no SOP file yet (need one creating). If we
            // have no git data yet, fall back to declared-version mismatch.
            const effectiveStalePages = gitSyncData
                ? [...gitStalePages, ...gitMissingSopPages]
                : outOfSync;
            let sopRequested = localStorage.getItem('_sop_update_requested');
            // Clear the requested flag if everything is now in sync OR if it's older than 24 hours
            if (sopRequested) {
                const elapsed = Date.now() - new Date(sopRequested).getTime();
                if (effectiveStalePages.length === 0 || elapsed > 24 * 60 * 60 * 1000) {
                    localStorage.removeItem('_sop_update_requested');
                    sopRequested = null;
                }
            }
            let updateAllBtn = '';
            if (effectiveStalePages.length > 0) {
                if (sopRequested) {
                    updateAllBtn = `<button class="cfv-action-btn" style="font-size:11px;padding:8px 16px;margin-top:8px;background:#dcfce7;color:#16a34a;border-color:#16a34a;cursor:default" disabled>✓ Update Requested — Processing (${effectiveStalePages.length} SOPs)</button>`
                        + ` <button class="cfv-action-btn" onclick="resetSOPRequestFlag()" style="font-size:11px;padding:8px 16px;margin-top:8px">Reset &amp; Re-enable</button>`;
                } else {
                    updateAllBtn = `<button class="cfv-action-btn primary" onclick="requestAllSOPUpdates(this)" style="font-size:11px;padding:8px 16px;margin-top:8px">Update All Out-of-Sync SOPs (${effectiveStalePages.length})</button>`;
                }
            }
            // Auth state for the GitHub API (affects rate limit)
            const gitHubAuthed = !!localStorage.getItem(GITHUB_PAT_KEY);
            const authBtn = gitHubAuthed
                ? `<button class="cfv-action-btn" onclick="setGitHubToken()" style="font-size:11px;padding:8px 16px;margin-top:8px;color:var(--success);border-color:var(--success)" title="Change or remove the stored GitHub token">🔑 Authenticated · 5k/hr</button>`
                : `<button class="cfv-action-btn" onclick="setGitHubToken()" style="font-size:11px;padding:8px 16px;margin-top:8px" title="Store a GitHub token to raise the rate limit from 60/hr to 5,000/hr">🔑 Set GitHub token (60→5k/hr)</button>`;
            // Git sync KPI card + button
            let gitCard, gitBtn;
            if (!gitSyncData) {
                gitCard = `<div class="kpi-card" style="flex:1;min-width:160px;padding:12px 16px">
                    <div class="kpi-card-label">Git Sync (real)</div>
                    <div style="font-size:20px;font-weight:700;color:var(--text-muted)">—</div>
                    <div style="font-size:10px;color:var(--text-muted);margin-top:2px">Not checked yet</div>
                </div>`;
                gitBtn = `<button class="cfv-action-btn primary" onclick="runGitSyncCheck(this)" style="font-size:11px;padding:8px 16px;margin-top:8px">Check Git Sync</button>`;
            } else {
                const fetchedRel = fmtRelative(new Date(gitSyncData.fetchedAt).toISOString());
                // Headline numeric (matches other cards' 20px), detail line under it
                let colour, bigNum, subline;
                if (gitUnknown > 0) {
                    colour = 'var(--warning)';
                    bigNum = `${gitCurrent}/${total} ?`;
                    subline = `${gitUnknown} unknown · ${gitStale} stale`;
                } else if (gitStale > 0) {
                    colour = 'var(--danger)';
                    bigNum = `${gitCurrent}/${total} ⚠`;
                    subline = `${gitStale} stale`;
                } else {
                    colour = 'var(--success)';
                    bigNum = `${gitCurrent}/${total} ✓`;
                    subline = 'all current';
                }
                const authSuffix = gitHubAuthed ? ' · 🔑 auth' : '';
                gitCard = `<div class="kpi-card" style="flex:1;min-width:160px;padding:12px 16px">
                    <div class="kpi-card-label">Git Sync (real)</div>
                    <div style="font-size:20px;font-weight:700;color:${colour}">${bigNum}</div>
                    <div style="font-size:10px;color:var(--text-muted);margin-top:2px">${subline} · checked ${fetchedRel}${gitSyncData.rateLimited ? ' · <strong style="color:var(--warning)">rate-limited</strong>' : ''}${authSuffix}</div>
                </div>`;
                gitBtn = `<button class="cfv-action-btn" onclick="clearGitSyncCache();runGitSyncCheck(this)" style="font-size:11px;padding:8px 16px;margin-top:8px">Re-check Git Sync</button>`;
            }

            integrity.innerHTML = `
                <div style="display:flex;gap:16px;align-items:stretch;flex-wrap:wrap">
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
                    ${authBtn}
                    ${updateAllBtn}
                </div>
                ${gitSyncData && gitStale > 0 ? `<div style="margin-top:8px;padding:10px 12px;background:var(--danger-bg);border:1px solid var(--danger);border-radius:6px;font-size:12px;color:var(--danger)">
                    <strong>⚠ ${gitStale} SOP${gitStale === 1 ? '' : 's'} stale in git:</strong> ${gitStalePages.map(p => escHtml(p.name)).join(', ')}. The page source file has been edited since the SOP was last written.
                </div>` : ''}
                ${gitSyncData && gitUnknown > 0 ? `<div style="margin-top:8px;padding:10px 12px;background:var(--warning-bg);border:1px solid var(--warning);border-radius:6px;font-size:12px;color:var(--warning)">
                    <strong>? ${gitUnknown} page${gitUnknown === 1 ? '' : 's'} unknown:</strong> ${gitUnknownPages.map(p => escHtml(p.name)).join(', ')}. GitHub API ${gitSyncData.rateLimited ? 'rate-limited this run — wait ~1h or hit Re-check later.' : 'returned no data for at least one of these files.'}
                </div>` : ''}
                ${gitSyncData && gitMissingSop > 0 ? `<div style="margin-top:8px;padding:10px 12px;background:var(--danger-bg);border:1px solid var(--danger);border-radius:6px;font-size:12px;color:var(--danger)">
                    <strong>⚠ ${gitMissingSop} page${gitMissingSop === 1 ? '' : 's'} missing an SOP:</strong> ${gitMissingSopPages.map(p => escHtml(p.name)).join(', ')}. A new SOP needs to be created for ${gitMissingSop === 1 ? 'this page' : 'these pages'}.
                </div>` : ''}
            `;
        }
        // Keep the sidebar badge in step with whatever the table now shows.
        updateSitemapBadge();

        // ── Sync Bar + Health Checks ──
        if (typeof registerSyncBar === 'function') {
            registerSyncBar('sitemap', {
                refreshFn: () => { clearGitSyncCache(); renderSiteMap(); },
                checks: [
                    {
                        name: 'PAGE_REGISTRY populated', kind: 'sync', run: () => {
                            const n = (PAGE_REGISTRY || []).length;
                            if (n === 0) return { status: 'fail', detail: 'Empty registry — sitemap will be blank' };
                            return { status: 'pass', detail: `${n} pages registered in config.js` };
                        }
                    },
                    {
                        name: 'Live page versions vs registered', kind: 'sync', run: () => {
                            const reg = PAGE_REGISTRY || [];
                            const sopMatches = reg.filter(p => p.pageVer === p.sopVer).length;
                            const sopBehind = reg.filter(p => p.pageVer !== p.sopVer && p.sopFile);
                            if (sopBehind.length === 0) return { status: 'pass', detail: `All ${sopMatches} pages have SOP version matching pageVer` };
                            return { status: 'warn', detail: `${sopBehind.length} page(s) have an SOP version behind pageVer: ${sopBehind.slice(0, 3).map(p => p.id).join(', ')}${sopBehind.length > 3 ? '…' : ''}` };
                        }
                    },
                    {
                        name: 'GitHub API reachable', kind: 'automation', run: () => {
                            // gitSyncData is populated by getGitStatus — set to true means a fetch ran
                            if (typeof gitSyncData === 'undefined' || !gitSyncData) return { status: 'warn', detail: 'GitHub status not yet fetched (auto-loads when tab opens)' };
                            return { status: 'pass', detail: 'Live GitHub API check ran successfully on this load' };
                        }
                    },
                    {
                        name: 'Auto-bump pageVer workflow healthy', kind: 'automation', run: () => {
                            // Heuristic: if any page in registry has a non-1.0 pageVer, the auto-bump has run at least once.
                            const reg = PAGE_REGISTRY || [];
                            const bumped = reg.filter(p => p.pageVer && p.pageVer !== '1.0').length;
                            if (bumped === 0) return { status: 'warn', detail: 'No page has been bumped above v1.0 — workflow may not be running' };
                            return { status: 'pass', detail: `${bumped} pages have been auto-bumped past v1.0` };
                        }
                    },
                    {
                        name: 'SOP-update request mechanism wired', kind: 'automation', run: () => {
                            if (typeof requestSOPUpdate !== 'function') return { status: 'fail', detail: 'requestSOPUpdate() missing' };
                            return { status: 'pass', detail: 'SOP-update buttons in the table will route a request via Airtable' };
                        }
                    },
                ],
            });
            markTabSynced('sitemap');
        }
    }

    async function requestSOPUpdate(pageId, sopFile, pageVer, pageName, btn) {
        if (!PAT) { alert('No Airtable token'); return; }
        btn.textContent = 'Requesting...';
        btn.disabled = true;
        // If sopFile is empty, this is a "create new SOP" request, not a regeneration.
        const isNew = !sopFile;
        const requestLabel = isNew
            ? `CREATE NEW ${pageName} SOP (page v${pageVer})`
            : `Update ${pageName} SOP to v${pageVer}`;
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${SOP_QUEUE_TABLE}`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: {
                    [SOP_QUEUE_FIELDS.request]: requestLabel,
                    [SOP_QUEUE_FIELDS.sopFile]: sopFile || '(new)',
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
        // Build the list of pages needing SOP attention:
        //   - git-stale: SOP exists but page has been edited since it was last written → regenerate
        //   - no-sop: page has source but no SOP file yet → create new SOP
        // Pre-sync fallback: declared-version mismatch (pageVer !== sopVer).
        const stalePages = [];
        for (const p of PAGE_REGISTRY) {
            const gs = getGitStatus(p);
            if (gs) {
                if (gs.state === 'stale' || gs.state === 'no-sop') stalePages.push(p);
            } else if (p.sopFile && p.pageVer !== p.sopVer) {
                stalePages.push(p);
            }
        }
        if (stalePages.length === 0) {
            alert('Nothing to update — all tracked SOPs are current.');
            return;
        }
        if (!confirm(`Queue SOP updates for ${stalePages.length} out-of-sync page${stalePages.length === 1 ? '' : 's'}?\n\n${stalePages.map(p => '• ' + p.name).join('\n')}`)) return;
        btn.textContent = 'Requesting...';
        btn.disabled = true;
        for (const p of stalePages) {
            await requestSOPUpdate(p.id, p.sopFile, p.pageVer, p.name, { textContent: '', disabled: false, style: {} });
            await new Promise(r => setTimeout(r, 300));
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
