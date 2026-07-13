// ══════════════════════════════════════════
// PROSPECTING — cold outbound pipeline (LinkedIn → email list → GHL)
// ══════════════════════════════════════════
// The daily /prospect-daily agent writes Prospects + updates Prospect Keywords.
// This tab is the human review gate: approve/reject the queue, watch the
// funnel, and manage the LinkedIn search keywords. Approved prospects are
// pushed to GoHighLevel by the agent on its next run (the GHL API key lives
// on Kevin's machine, never in this client-side app).
//
// PECR compliance rule enforced downstream: only Entity Type = "Limited
// Company" is enrolled in the email sequence; sole traders / unknown are
// tagged manual-track in GHL and never cold-emailed.

    let prospectingLoaded = false;
    let prospectsCache = null;
    let prospectKeywordsCache = null;
    let prospectingFilter = localStorage.getItem('pros_filter') || 'All';
    const PROS_QUEUE_STATUS = 'Ready for Review';

    // ── Data layer ─────────────────────────────────────────────

    async function fetchProspectingTable(tableId) {
        let all = [];
        let offset = null;
        do {
            const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
            if (offset) url.searchParams.set('offset', offset);
            const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${PAT}` } });
            if (!resp.ok) throw new Error(`Airtable fetch failed for ${tableId}: HTTP ` + resp.status);
            const data = await resp.json();
            if (data.records) all = all.concat(data.records);
            offset = data.offset || null;
        } while (offset);
        return all;
    }

    async function patchProspectingRecord(tableId, recordId, fields) {
        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}/${recordId}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields }),
        });
        if (!resp.ok) throw new Error('Airtable update failed: HTTP ' + resp.status);
        return resp.json();
    }

    // Called un-awaited from switchTab — owns its errors and error states.
    async function loadProspectingTab(forceRefresh) {
        if (!PAT) return;
        try {
            if (!prospectsCache || forceRefresh) {
                const queueEl = document.getElementById('prospectingQueue');
                if (queueEl && !prospectsCache) queueEl.innerHTML = '<div class="od-empty-state">Loading prospects…</div>';
                [prospectsCache, prospectKeywordsCache] = await Promise.all([
                    fetchProspectingTable(TABLES.prospects),
                    fetchProspectingTable(TABLES.prospectKeywords),
                ]);
            }
            renderProspectingTab();
            prospectingLoaded = true;
        } catch (e) {
            console.error('Prospecting load failed:', e);
            renderProspectingLoadError(e);
            if (typeof showToast === 'function') {
                showToast('Could not load prospecting data: ' + ((e && e.message) || 'unknown error'), { type: 'error' });
            }
        }
    }

    function renderProspectingLoadError(e) {
        const queueEl = document.getElementById('prospectingQueue');
        if (queueEl) {
            queueEl.innerHTML = `<div class="od-empty-state" style="color:var(--danger)">Could not load prospects — ${escHtml((e && e.message) || 'unknown error')}<br><button onclick="loadProspectingTab(true)" class="od-btn-secondary" style="margin-top:8px">Retry</button></div>`;
        }
        const tbody = document.getElementById('prospectingTableBody');
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="od-empty-state">—</td></tr>';
    }

    // ── Field readers (Airtable returns field NAMES as keys) ──

    function prosField(rec, name) { return (rec.fields && rec.fields[name]) || ''; }

    function prosStatus(rec) { return prosField(rec, 'Status') || 'Found'; }

    // ── Render ─────────────────────────────────────────────────

    function renderProspectingTab() {
        const records = prospectsCache || [];
        renderProspectingFunnel(records);
        renderProspectingQueue(records);
        renderProspectingPipeline(records);
        renderProspectingKeywords(prospectKeywordsCache || []);
        updateProspectingBadge(records);
        renderProspectingAgentStamp(records);
        registerProspectingSyncBar(records, prospectKeywordsCache || []);
    }

    function renderProspectingAgentStamp(records) {
        const el = document.getElementById('prospectingAgentStamp');
        if (!el) return;
        const dates = records.map(r => prosField(r, 'Date Found')).filter(Boolean).sort();
        if (!dates.length) { el.textContent = 'Agent has not run yet'; return; }
        const last = dates[dates.length - 1];
        el.textContent = 'Last prospects found: ' + new Date(last).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function renderProspectingFunnel(records) {
        const el = document.getElementById('prospectingFunnel');
        if (!el) return;
        const count = status => records.filter(r => prosStatus(r) === status).length;
        const total = records.length;
        const calls = count('Call Booked');
        const stages = [
            { label: 'Found (all time)', value: total, color: 'var(--text-primary)' },
            { label: 'Ready for review', value: count(PROS_QUEUE_STATUS), color: 'var(--info)' },
            { label: 'Approved', value: count('Approved'), color: 'var(--accent)' },
            { label: 'Synced to GHL', value: count('Synced to GHL'), color: 'var(--tone-olive)' },
            { label: 'In sequence', value: count('In Sequence'), color: 'var(--tone-blue)' },
            { label: 'Replied', value: count('Replied'), color: 'var(--tone-plum)' },
            { label: 'Calls booked', value: calls, color: 'var(--accent-gold)' },
        ];
        el.innerHTML = stages.map(s => `
            <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:14px;text-align:center">
                <div style="font-size:24px;font-weight:var(--fw-bold);color:${s.color}">${s.value}</div>
                <div style="font-size:var(--fs-xs);color:var(--text-secondary);margin-top:2px">${s.label}</div>
            </div>`).join('')
            + `<div style="background:var(--accent-soft);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:14px;text-align:center">
                <div style="font-size:24px;font-weight:var(--fw-bold);color:var(--accent)">${total ? ((calls / total) * 100).toFixed(1) : '0.0'}%</div>
                <div style="font-size:var(--fs-xs);color:var(--text-secondary);margin-top:2px">Found → call rate</div>
            </div>`;
    }

    function renderProspectingQueue(records) {
        const el = document.getElementById('prospectingQueue');
        if (!el) return;
        const queue = records.filter(r => prosStatus(r) === PROS_QUEUE_STATUS)
            .sort((a, b) => String(prosField(a, 'Date Found')).localeCompare(String(prosField(b, 'Date Found'))));
        if (!queue.length) {
            el.innerHTML = '<div class="od-empty-state">No prospects waiting for review. The daily agent adds new ones each weekday morning.</div>';
            return;
        }
        el.innerHTML = queue.map(r => {
            const id = r.id;
            const name = prosField(r, 'Name') || 'Unnamed prospect';
            const headline = prosField(r, 'Headline');
            const company = prosField(r, 'Company');
            const website = prosField(r, 'Company Website');
            const linkedin = prosField(r, 'LinkedIn URL');
            const email = prosField(r, 'Contact Email');
            const emailConf = prosField(r, 'Email Confidence');
            const entity = prosField(r, 'Entity Type') || 'Unknown';
            const pain = prosField(r, 'Pain Signal');
            const keyword = prosField(r, 'Keyword Matched');
            const isLtd = entity === 'Limited Company';
            const entityChip = isLtd
                ? `<span style="background:var(--success-bg);color:var(--success);padding:2px 8px;border-radius:var(--radius-full);font-size:var(--fs-xs);font-weight:var(--fw-medium)">Limited Company · email OK</span>`
                : `<span style="background:var(--warning-bg);color:var(--warning);padding:2px 8px;border-radius:var(--radius-full);font-size:var(--fs-xs);font-weight:var(--fw-medium)">${escHtml(entity)} · manual track (PECR)</span>`;
            const confColor = emailConf === 'High' ? 'var(--success)' : emailConf === 'Medium' ? 'var(--accent-gold)' : 'var(--danger)';
            return `
            <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:16px;margin-bottom:12px" data-prospect-id="${escHtml(id)}">
                <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:flex-start">
                    <div style="min-width:0;flex:1">
                        <div style="font-weight:var(--fw-semibold);color:var(--text-primary);font-size:var(--fs-md);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                            ${linkedin ? `<a href="${escHtml(linkedin)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escHtml(name)} ↗</a>` : escHtml(name)}
                        </div>
                        ${headline ? `<div style="color:var(--text-secondary);font-size:var(--fs-sm);margin-top:2px">${escHtml(headline)}</div>` : ''}
                        <div style="color:var(--text-secondary);font-size:var(--fs-sm);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                            ${escHtml(company || '—')}${website ? ` · <a href="${escHtml(website)}" target="_blank" rel="noopener" style="color:var(--accent)">website ↗</a>` : ''}
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;flex-shrink:0">
                        <button class="od-btn-primary" onclick="approveProspect('${escHtml(id)}')">Approve</button>
                        <button class="od-btn-secondary" onclick="rejectProspect('${escHtml(id)}')">Reject</button>
                    </div>
                </div>
                ${pain ? `<div style="margin-top:10px;padding:10px 12px;background:var(--bg-surface-2);border-left:3px solid var(--accent-gold);border-radius:var(--radius-sm);font-size:var(--fs-sm);color:var(--text-primary);word-break:break-word">“${escHtml(pain)}”</div>` : ''}
                <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;align-items:center">
                    ${entityChip}
                    ${email ? `<span style="font-size:var(--fs-xs);color:var(--text-secondary)">${escHtml(email)} <span style="color:${confColor};font-weight:var(--fw-medium)">(${escHtml(emailConf || '?')} confidence)</span></span>` : '<span style="font-size:var(--fs-xs);color:var(--danger)">No email found</span>'}
                    ${keyword ? `<span style="font-size:var(--fs-xs);color:var(--text-muted)">matched: ${escHtml(keyword)}</span>` : ''}
                </div>
            </div>`;
        }).join('');
    }

    // ── Approve / Reject with undo ─────────────────────────────

    let _prosUndoTimer = null;

    function _prosSetStatusLocal(recordId, status) {
        const rec = (prospectsCache || []).find(r => r.id === recordId);
        if (rec) rec.fields['Status'] = status;
    }

    async function _prosChangeStatus(recordId, newStatus, verb) {
        const card = document.querySelector(`[data-prospect-id="${recordId}"]`);
        if (card) card.querySelectorAll('button').forEach(b => b.disabled = true);
        const prevStatus = (() => {
            const rec = (prospectsCache || []).find(r => r.id === recordId);
            return rec ? prosStatus(rec) : PROS_QUEUE_STATUS;
        })();
        try {
            await patchProspectingRecord(TABLES.prospects, recordId, { [PROSPECT.status]: newStatus });
            _prosSetStatusLocal(recordId, newStatus);
            renderProspectingTab();
            _prosShowUndoToast(`Prospect ${verb}`, recordId, prevStatus);
        } catch (e) {
            console.error(`Prospect ${verb} failed:`, e);
            if (card) card.querySelectorAll('button').forEach(b => b.disabled = false);
            if (typeof showToast === 'function') showToast(`Could not update prospect: ` + ((e && e.message) || 'unknown error'), { type: 'error' });
        }
    }

    function approveProspect(recordId) { _prosChangeStatus(recordId, 'Approved', 'approved — syncs to GHL on the next agent run'); }
    function rejectProspect(recordId) { _prosChangeStatus(recordId, 'Rejected', 'rejected'); }

    function _prosShowUndoToast(message, recordId, prevStatus) {
        let host = document.getElementById('prosUndoToast');
        if (!host) {
            host = document.createElement('div');
            host.id = 'prosUndoToast';
            host.setAttribute('role', 'status');
            host.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg-sidebar);color:#fff;padding:10px 16px;border-radius:var(--radius-lg);font-size:var(--fs-sm);display:flex;gap:12px;align-items:center;z-index:9999;box-shadow:var(--shadow-lg)';
            document.body.appendChild(host);
        }
        host.innerHTML = `<span>${escHtml(message)}</span><button style="background:none;border:1px solid rgba(255,255,255,.4);color:#fff;border-radius:var(--radius-sm);padding:3px 10px;cursor:pointer;font-size:var(--fs-xs)" id="prosUndoBtn">Undo</button>`;
        host.style.display = 'flex';
        document.getElementById('prosUndoBtn').addEventListener('click', async () => {
            host.style.display = 'none';
            clearTimeout(_prosUndoTimer);
            try {
                await patchProspectingRecord(TABLES.prospects, recordId, { [PROSPECT.status]: prevStatus });
                _prosSetStatusLocal(recordId, prevStatus);
                renderProspectingTab();
                if (typeof showToast === 'function') showToast('Undone — prospect back in the queue', { type: 'info' });
            } catch (e) {
                console.error('Prospect undo failed:', e);
                if (typeof showToast === 'function') showToast('Undo failed: ' + ((e && e.message) || 'unknown error'), { type: 'error' });
            }
        });
        clearTimeout(_prosUndoTimer);
        _prosUndoTimer = setTimeout(() => { host.style.display = 'none'; }, 8000);
    }

    // ── Pipeline table ─────────────────────────────────────────

    function renderProspectingPipeline(records) {
        const tbody = document.getElementById('prospectingTableBody');
        const filterBar = document.getElementById('prospectingFilterBar');
        if (!tbody || !filterBar) return;

        const statuses = ['All', 'Ready for Review', 'Approved', 'Synced to GHL', 'In Sequence', 'Replied', 'Call Booked', 'Rejected', 'Suppressed'];
        if (!statuses.includes(prospectingFilter)) prospectingFilter = 'All';
        filterBar.innerHTML = statuses.map(s => {
            const active = s === prospectingFilter;
            return `<button class="accounts-subtab${active ? ' active' : ''}" onclick="setProspectingFilter('${escHtml(s)}')" aria-pressed="${active}">${escHtml(s)}</button>`;
        }).join('');

        const shown = records
            .filter(r => prospectingFilter === 'All' || prosStatus(r) === prospectingFilter)
            .sort((a, b) => String(prosField(b, 'Date Found')).localeCompare(String(prosField(a, 'Date Found'))));

        if (!shown.length) {
            tbody.innerHTML = `<tr><td colspan="7" class="od-empty-state">${records.length ? 'No prospects with this status.' : 'No prospects yet — the daily agent fills this table.'}</td></tr>`;
            return;
        }
        tbody.innerHTML = shown.map(r => {
            const linkedin = prosField(r, 'LinkedIn URL');
            const name = prosField(r, 'Name') || '—';
            const dateFound = prosField(r, 'Date Found');
            const status = prosStatus(r);
            const statusColor = status === 'Call Booked' ? 'var(--accent-gold)'
                : status === 'Rejected' || status === 'Suppressed' ? 'var(--text-muted)'
                : status === PROS_QUEUE_STATUS ? 'var(--info)'
                : 'var(--accent)';
            return `<tr>
                <td style="font-weight:var(--fw-medium);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${linkedin ? `<a href="${escHtml(linkedin)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escHtml(name)}</a>` : escHtml(name)}</td>
                <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(prosField(r, 'Company') || '—')}</td>
                <td style="font-size:var(--fs-xs)">${escHtml(prosField(r, 'Entity Type') || 'Unknown')}</td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--fs-xs)">${escHtml(prosField(r, 'Contact Email') || '—')}</td>
                <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--fs-xs);color:var(--text-secondary)" title="${escHtml(prosField(r, 'Pain Signal'))}">${escHtml(prosField(r, 'Pain Signal') || '—')}</td>
                <td><span style="color:${statusColor};font-weight:var(--fw-medium);font-size:var(--fs-xs)">${escHtml(status)}</span></td>
                <td style="font-size:var(--fs-xs);color:var(--text-secondary)">${dateFound ? new Date(dateFound).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—'}</td>
            </tr>`;
        }).join('');
    }

    function setProspectingFilter(status) {
        prospectingFilter = status;
        localStorage.setItem('pros_filter', status);
        renderProspectingPipeline(prospectsCache || []);
    }

    // ── Keyword manager ────────────────────────────────────────

    function renderProspectingKeywords(keywords) {
        const el = document.getElementById('prospectingKeywords');
        if (!el) return;
        if (!keywords.length) {
            el.innerHTML = '<div class="od-empty-state">No keywords yet — add the first pain phrase below.</div>';
            return;
        }
        const sorted = [...keywords].sort((a, b) => String(prosField(a, 'Keyword')).localeCompare(String(prosField(b, 'Keyword'))));
        el.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px">` + sorted.map(k => {
            const active = !!prosField(k, 'Active');
            const found = prosField(k, 'Prospects Found');
            const lastUsed = prosField(k, 'Last Used');
            return `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:var(--radius-md);flex-wrap:wrap">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;min-width:200px">
                    <input type="checkbox" ${active ? 'checked' : ''} onchange="toggleProspectKeyword('${escHtml(k.id)}', this.checked, this)" aria-label="Toggle keyword ${escHtml(prosField(k, 'Keyword'))}">
                    <span style="font-size:var(--fs-sm);color:${active ? 'var(--text-primary)' : 'var(--text-muted)'};font-weight:var(--fw-medium)">${escHtml(prosField(k, 'Keyword'))}</span>
                </label>
                <span style="font-size:var(--fs-xs);color:var(--text-muted);background:var(--bg-subtle);padding:2px 8px;border-radius:var(--radius-full)">${escHtml(prosField(k, 'Type') || '—')}</span>
                <span style="font-size:var(--fs-xs);color:var(--text-secondary)">${found ? `${found} found` : 'none found yet'}${lastUsed ? ` · last used ${new Date(lastUsed).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}` : ''}</span>
            </div>`;
        }).join('') + `</div>`;
    }

    async function toggleProspectKeyword(recordId, active, checkboxEl) {
        if (checkboxEl) checkboxEl.disabled = true;
        try {
            await patchProspectingRecord(TABLES.prospectKeywords, recordId, { [PKEY.active]: active });
            const rec = (prospectKeywordsCache || []).find(r => r.id === recordId);
            if (rec) rec.fields['Active'] = active;
            renderProspectingKeywords(prospectKeywordsCache || []);
            if (typeof showToast === 'function') showToast(`Keyword ${active ? 'activated' : 'deactivated'}`, { type: 'info', duration: 2500 });
        } catch (e) {
            console.error('Keyword toggle failed:', e);
            if (checkboxEl) { checkboxEl.checked = !active; checkboxEl.disabled = false; }
            if (typeof showToast === 'function') showToast('Could not update keyword: ' + ((e && e.message) || 'unknown error'), { type: 'error' });
        }
    }

    async function addProspectKeyword() {
        const input = document.getElementById('newKeywordInput');
        const typeSel = document.getElementById('newKeywordType');
        const btn = document.getElementById('addKeywordBtn');
        const keyword = (input && input.value || '').trim();
        if (!keyword) { if (typeof showToast === 'function') showToast('Type a keyword first', { type: 'warning' }); return; }
        const exists = (prospectKeywordsCache || []).some(k => String(prosField(k, 'Keyword')).toLowerCase() === keyword.toLowerCase());
        if (exists) { if (typeof showToast === 'function') showToast('That keyword already exists', { type: 'warning' }); return; }
        if (btn) btn.disabled = true;
        try {
            const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.prospectKeywords}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: { [PKEY.keyword]: keyword, [PKEY.type]: typeSel ? typeSel.value : 'Pain Phrase', [PKEY.active]: true } }),
            });
            if (!resp.ok) throw new Error('Airtable create failed: HTTP ' + resp.status);
            const created = await resp.json();
            // Normalise to name-keyed fields for local cache consistency
            prospectKeywordsCache = prospectKeywordsCache || [];
            prospectKeywordsCache.push({ id: created.id, fields: { 'Keyword': keyword, 'Type': typeSel ? typeSel.value : 'Pain Phrase', 'Active': true } });
            if (input) input.value = '';
            renderProspectingKeywords(prospectKeywordsCache);
            if (typeof showToast === 'function') showToast('Keyword added — the agent picks it up on its next run', { type: 'success' });
        } catch (e) {
            console.error('Keyword add failed:', e);
            if (typeof showToast === 'function') showToast('Could not add keyword: ' + ((e && e.message) || 'unknown error'), { type: 'error' });
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ── Badge + health ─────────────────────────────────────────

    function updateProspectingBadge(records) {
        const badge = document.getElementById('prospectingBadge');
        if (!badge) return;
        const queueCount = records.filter(r => prosStatus(r) === PROS_QUEUE_STATUS).length;
        if (queueCount > 0) {
            badge.style.display = 'inline-block';
            badge.style.background = 'var(--accent-gold)';
            badge.textContent = queueCount;
        } else {
            badge.style.display = 'none';
        }
    }

    function registerProspectingSyncBar(records, keywords) {
        if (typeof registerSyncBar !== 'function') return;
        registerSyncBar('prospecting', {
            refreshFn: () => loadProspectingTab(true),
            checks: [
                {
                    name: 'Prospects table reachable', kind: 'sync', run: () => {
                        if (!prospectsCache) return { status: 'fail', detail: 'Prospects fetch has not completed' };
                        return { status: 'pass', detail: `${records.length} prospect record(s) loaded` };
                    }
                },
                {
                    name: 'Active search keywords defined', kind: 'sync', run: () => {
                        const active = keywords.filter(k => !!prosField(k, 'Active')).length;
                        if (!keywords.length) return { status: 'fail', detail: 'Keywords table is empty — the agent has nothing to search' };
                        if (!active) return { status: 'fail', detail: 'No ACTIVE keywords — the agent will find nothing' };
                        return { status: 'pass', detail: `${active} active keyword(s) of ${keywords.length}` };
                    }
                },
                {
                    name: 'Daily agent ran recently', kind: 'automation', run: () => {
                        const dates = records.map(r => prosField(r, 'Date Found')).filter(Boolean).sort();
                        if (!dates.length) return { status: 'warn', detail: 'No prospects found yet — agent has not completed a run' };
                        const last = new Date(dates[dates.length - 1]);
                        const daysAgo = (Date.now() - last.getTime()) / 86400000;
                        if (daysAgo > 3) return { status: 'warn', detail: `Last prospects found ${Math.floor(daysAgo)} days ago — check the scheduled agent is running` };
                        return { status: 'pass', detail: 'Prospects found within the last 3 days' };
                    }
                },
                {
                    name: 'Approved prospects synced to GHL', kind: 'automation', run: () => {
                        const backlog = records.filter(r => prosStatus(r) === 'Approved');
                        if (backlog.length > 20) return { status: 'warn', detail: `${backlog.length} approved prospect(s) awaiting GHL sync — agent may not be syncing` };
                        if (backlog.length) return { status: 'pass', detail: `${backlog.length} approved, syncs on next agent run` };
                        return { status: 'pass', detail: 'No approved prospects waiting' };
                    }
                },
                {
                    name: 'Synced records carry a GHL Contact ID', kind: 'sync', run: () => {
                        const synced = records.filter(r => ['Synced to GHL', 'In Sequence', 'Replied', 'Call Booked'].includes(prosStatus(r)));
                        const missing = synced.filter(r => !prosField(r, 'GHL Contact ID'));
                        if (missing.length) return { status: 'warn', detail: `${missing.length} synced prospect(s) missing GHL Contact ID` };
                        return { status: 'pass', detail: synced.length ? `All ${synced.length} synced prospect(s) have GHL IDs` : 'Nothing synced yet' };
                    }
                },
                {
                    name: 'PECR gate: no sole traders in sequence', kind: 'automation', run: () => {
                        const inSeq = records.filter(r => ['In Sequence', 'Replied'].includes(prosStatus(r)));
                        const bad = inSeq.filter(r => prosField(r, 'Entity Type') !== 'Limited Company');
                        if (bad.length) return { status: 'fail', detail: `${bad.length} non-Ltd prospect(s) are in the email sequence — PECR breach risk, pull them out` };
                        return { status: 'pass', detail: 'Only Limited Companies in the email sequence' };
                    }
                },
                {
                    name: 'Sidebar Prospecting badge wired', kind: 'automation', run: () => {
                        if (!document.getElementById('prospectingBadge')) return { status: 'fail', detail: 'Badge element missing from sidebar' };
                        return { status: 'pass', detail: 'Badge shows the review-queue count' };
                    }
                },
            ],
        });
        markTabSynced('prospecting');
    }
