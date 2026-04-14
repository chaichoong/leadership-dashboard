// ══════════════════════════════════════════
// FINTABLE SYNC MONITOR
// ══════════════════════════════════════════
    // ─── Fintable Sync Monitor ───────────────────────────────────────
    let fintableLoaded = false;
    let fintableAccountsCache = null;

    const FINTABLE_EXCLUDED = [
        'Cafe Zempler', 'Personal Santander Maintenance', 'Personal Santander Budget',
        'Personal Santander Investing', 'SHL Zempler', 'Two Chefs Zempler', 'Two Chefs Stripe'
    ];

    async function fetchFintableAccounts() {
        if (!PAT) return [];
        const ACCOUNTS_TABLE = 'tbl1nr0EcX2T62KME';
        const fields = [
            'fldqr09KqLGGYCYkC',  // *Name
            'fld8HOlbBrXbHesoA',  // **Last Successful Update
            'fldQ4vElprkABxQRx',  // **Institution
            'fldhDG5jDA8Tu2JyI',  // **GBP
            'fld21HAxSawQCxICj',  // Account Alias
            'fldIyCsxvjoBqju3y'   // **Fintable User
        ];

        const sixMonthsAgo = new Date();
        sixMonthsAgo.setDate(sixMonthsAgo.getDate() - 183);

        let allRecords = [];
        let offset = null;
        do {
            const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${ACCOUNTS_TABLE}`);
            fields.forEach(f => url.searchParams.append('fields[]', f));
            url.searchParams.set('filterByFormula', `IS_AFTER({**Last Successful Update}, '${sixMonthsAgo.toISOString().split('T')[0]}')`);
            url.searchParams.set('sort[0][field]', '**Last Successful Update');
            url.searchParams.set('sort[0][direction]', 'desc');
            if (offset) url.searchParams.set('offset', offset);

            const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${PAT}` } });
            const data = await resp.json();
            if (data.records) allRecords = allRecords.concat(data.records);
            offset = data.offset || null;
        } while (offset);

        return allRecords.filter(r => !FINTABLE_EXCLUDED.includes(r.fields['Account Alias'] || ''));
    }

    function classifyFintableAccount(record) {
        const f = record.fields;
        const alias = f['Account Alias'] || f['*Name'] || 'Unknown';
        const lastSync = f['**Last Successful Update'] ? new Date(f['**Last Successful Update']) : null;
        const hoursAgo = lastSync ? (new Date() - lastSync) / (1000 * 60 * 60) : Infinity;

        let status;
        if (hoursAgo <= 24) status = 'ok';
        else if (hoursAgo <= 72) status = 'warning';
        else if (hoursAgo <= 168) status = 'alert';
        else status = 'critical';

        return { alias, status, hoursAgo };
    }

    function updateFintableAlerts(records) {
        const classified = records.map(classifyFintableAccount);
        const critical = classified.filter(a => a.status === 'critical');
        const alert = classified.filter(a => a.status === 'alert');
        const warning = classified.filter(a => a.status === 'warning');
        const problemCount = critical.length + alert.length;

        // Sidebar badge
        const badge = document.getElementById('fintableBadge');
        if (critical.length > 0) {
            badge.style.display = 'inline-block';
            badge.style.background = '#ef4444';
            badge.textContent = critical.length;
        } else if (alert.length > 0) {
            badge.style.display = 'inline-block';
            badge.style.background = '#f97316';
            badge.textContent = alert.length;
        } else if (warning.length > 0) {
            badge.style.display = 'inline-block';
            badge.style.background = '#eab308';
            badge.textContent = warning.length;
        } else {
            badge.style.display = 'none';
        }

        // Alert banner on Leadership Dashboard
        const banner = document.getElementById('fintableAlertBanner');
        if (problemCount === 0) {
            banner.style.display = 'none';
            return;
        }

        const parts = [];
        if (critical.length > 0) parts.push(`<strong>${critical.length}</strong> need${critical.length === 1 ? 's' : ''} reconnecting (7+ days)`);
        if (alert.length > 0) parts.push(`<strong>${alert.length}</strong> stale (3–7 days)`);

        const bgColor = critical.length > 0 ? '#fef2f2' : '#fff7ed';
        const borderColor = critical.length > 0 ? '#fecaca' : '#fed7aa';
        const iconColor = critical.length > 0 ? '#dc2626' : '#ea580c';

        banner.style.display = 'block';
        banner.innerHTML = `<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:10px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px;cursor:pointer" onclick="switchTab('fintable')">
            <span style="font-size:20px">&#x1F50C;</span>
            <div style="flex:1">
                <div style="font-weight:600;font-size:13px;color:${iconColor}">Fintable Sync Alert</div>
                <div style="font-size:12px;color:#64748b">${parts.join(' · ')} — <span style="color:${iconColor};text-decoration:underline">View Sync Monitor</span></div>
            </div>
        </div>`;
    }

    async function loadFintableSyncMonitor() {
        if (!PAT) return;
        // Use cached data if available, otherwise fetch fresh
        if (!fintableAccountsCache) {
            fintableAccountsCache = await fetchFintableAccounts();
            updateFintableAlerts(fintableAccountsCache);
        }
        renderFintableMonitor(fintableAccountsCache);
        fintableLoaded = true;
    }

    // Background check — runs on dashboard load without rendering the full table
    async function checkFintableSyncStatus() {
        try {
            fintableAccountsCache = await fetchFintableAccounts();
            updateFintableAlerts(fintableAccountsCache);
        } catch (e) {
            console.error('Fintable sync check failed:', e);
        }
    }

    function renderFintableMonitor(records) {
        const now = new Date();

        // Classify each account
        const accounts = records.map(r => {
            const f = r.fields;
            const alias = f['Account Alias'] || f['*Name'] || 'Unknown';
            const institution = f['**Institution'] || '—';
            const lastSync = f['**Last Successful Update'] ? new Date(f['**Last Successful Update']) : null;
            const balance = f['**GBP'];
            const hoursAgo = lastSync ? (now - lastSync) / (1000 * 60 * 60) : Infinity;

            let status, statusColor, statusLabel;
            if (hoursAgo <= 24) {
                status = 'ok'; statusColor = '#22c55e'; statusLabel = 'OK';
            } else if (hoursAgo <= 72) {
                status = 'warning'; statusColor = '#eab308'; statusLabel = 'Warning';
            } else if (hoursAgo <= 168) {
                status = 'alert'; statusColor = '#f97316'; statusLabel = 'Alert';
            } else {
                status = 'critical'; statusColor = '#ef4444'; statusLabel = 'Critical';
            }

            return { alias, institution, lastSync, balance, hoursAgo, status, statusColor, statusLabel };
        });

        // Summary cards
        const total = accounts.length;
        const ok = accounts.filter(a => a.status === 'ok').length;
        const warning = accounts.filter(a => a.status === 'warning').length;
        const alert = accounts.filter(a => a.status === 'alert').length;
        const critical = accounts.filter(a => a.status === 'critical').length;

        const summaryEl = document.getElementById('fintableSummary');
        summaryEl.innerHTML = `
            <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;text-align:center">
                <div style="font-size:28px;font-weight:700;color:#16a34a">${ok}</div>
                <div style="font-size:12px;color:#15803d">Healthy</div>
            </div>
            <div style="background:#fefce8;border:1px solid #fef08a;border-radius:10px;padding:16px;text-align:center">
                <div style="font-size:28px;font-weight:700;color:#ca8a04">${warning}</div>
                <div style="font-size:12px;color:#a16207">1–3 Days</div>
            </div>
            <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:16px;text-align:center">
                <div style="font-size:28px;font-weight:700;color:#ea580c">${alert}</div>
                <div style="font-size:12px;color:#c2410c">3–7 Days</div>
            </div>
            <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;text-align:center">
                <div style="font-size:28px;font-weight:700;color:#dc2626">${critical}</div>
                <div style="font-size:12px;color:#b91c1c">Needs Reconnect</div>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;text-align:center">
                <div style="font-size:28px;font-weight:700;color:#334155">${total}</div>
                <div style="font-size:12px;color:#64748b">Total Active</div>
            </div>
        `;

        // Table rows — sort most recently synced first
        const sorted = [...accounts].sort((a, b) => a.hoursAgo - b.hoursAgo);
        const tbody = document.getElementById('fintableBody');
        tbody.innerHTML = sorted.map(a => {
            const syncStr = a.lastSync
                ? a.lastSync.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + a.lastSync.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
                : 'Never';
            const agoStr = formatTimeAgo(a.hoursAgo);
            const balStr = a.balance != null ? '£' + a.balance.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
            const rowBg = a.status === 'critical' ? 'rgba(239,68,68,0.06)' : a.status === 'alert' ? 'rgba(249,115,22,0.06)' : '';

            return `<tr style="border-bottom:1px solid #f1f5f9;${rowBg ? 'background:' + rowBg : ''}">
                <td style="padding:10px 12px"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${a.statusColor};margin-right:6px"></span>${a.statusLabel}</td>
                <td style="padding:10px 12px;font-weight:500">${a.alias}</td>
                <td style="padding:10px 12px;color:#64748b">${a.institution}</td>
                <td style="padding:10px 12px">${syncStr}</td>
                <td style="padding:10px 12px;font-weight:500;color:${a.statusColor}">${agoStr}</td>
                <td style="padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums">${balStr}</td>
            </tr>`;
        }).join('');
    }

    function formatTimeAgo(hours) {
        if (hours < 1) return 'Just now';
        if (hours < 24) return Math.round(hours) + 'h ago';
        const days = Math.floor(hours / 24);
        if (days === 1) return '1 day ago';
        if (days < 30) return days + ' days ago';
        const months = Math.floor(days / 30);
        return months + (months === 1 ? ' month ago' : ' months ago');
    }

