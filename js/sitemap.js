// ══════════════════════════════════════════
// SITE MAP & LINKS — Renderer, SOP Update Requests
// ══════════════════════════════════════════
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
        const outOfSync = [];
        tbody.innerHTML = PAGE_REGISTRY.map((p, i) => {
            const versionMatch = p.pageVer === p.sopVer;
            if (versionMatch) matched++;
            else outOfSync.push(p);
            const statusHtml = versionMatch
                ? '<span style="color:#16a34a;font-weight:600">✓ In sync</span>'
                : '<span style="color:#d97706;font-weight:600">⚠ Update needed</span>';
            return `<tr>
                <td style="text-align:center;color:#94a3b8;font-weight:600">${i + 1}</td>
                <td style="font-weight:600">${p.icon} ${escHtml(p.name)}</td>
                <td style="text-align:center;font-family:monospace;font-size:11px">${p.pageVer}</td>
                <td><a href="#${p.id}" onclick="switchTab('${p.id}')" style="font-size:12px">Open</a></td>
                <td style="font-size:11px"><a href="${p.standalone}" target="_blank">${escHtml(p.standalone)}</a> <button class="sitemap-copy" onclick="event.stopPropagation();copyLink('${p.standalone}')">Copy</button></td>
                <td><a href="${p.sopFile}" target="_blank" style="font-size:12px">Open SOP</a> <button class="sitemap-copy" onclick="event.stopPropagation();copyLink('${p.sopFile}')">Copy</button></td>
                <td style="text-align:center;font-family:monospace;font-size:11px">${p.sopVer}</td>
                <td style="text-align:center">${statusHtml}</td>
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
            integrity.innerHTML = `
                <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
                    <div class="kpi-card" style="flex:1;min-width:200px;padding:12px 16px">
                        <div class="kpi-card-label">Pages</div>
                        <div style="font-size:20px;font-weight:700">${total}</div>
                    </div>
                    <div class="kpi-card" style="flex:1;min-width:200px;padding:12px 16px">
                        <div class="kpi-card-label">SOPs</div>
                        <div style="font-size:20px;font-weight:700">${total}</div>
                    </div>
                    <div class="kpi-card" style="flex:1;min-width:200px;padding:12px 16px">
                        <div class="kpi-card-label">Version Sync</div>
                        <div style="font-size:20px;font-weight:700;color:${allGood ? '#16a34a' : '#d97706'}">${matched}/${total} ${allGood ? '✓' : '⚠'}</div>
                    </div>
                </div>
                ${updateAllBtn}
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
