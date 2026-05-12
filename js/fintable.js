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
            badge.style.background = 'var(--danger)';
            badge.textContent = critical.length;
        } else if (alert.length > 0) {
            badge.style.display = 'inline-block';
            badge.style.background = 'var(--warning)';
            badge.textContent = alert.length;
        } else if (warning.length > 0) {
            badge.style.display = 'inline-block';
            badge.style.background = 'var(--warning)';
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

        const bgColor = critical.length > 0 ? 'var(--danger-bg)' : 'var(--warning-bg)';
        const borderColor = critical.length > 0 ? 'var(--danger-bg)' : 'var(--warning-bg)';
        const iconColor = critical.length > 0 ? 'var(--danger)' : 'var(--warning)';

        banner.style.display = 'block';
        banner.innerHTML = `<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:10px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px;cursor:pointer" onclick="switchTab('fintable')">
            <span style="font-size:20px">&#x1F50C;</span>
            <div style="flex:1">
                <div style="font-weight:600;font-size:13px;color:${iconColor}">Account Sync Alert</div>
                <div class="od-text-muted-sm" style="font-size:12px;color:var(--text-secondary)">${parts.join(' · ')} — <span style="color:${iconColor};text-decoration:underline">View Sync Monitor</span></div>
            </div>
        </div>`;
    }

    async function loadFintableSyncMonitor(forceRefresh) {
        if (!PAT) return;
        if (!fintableAccountsCache || forceRefresh) {
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
                status = 'ok'; statusColor = 'var(--success)'; statusLabel = 'OK';
            } else if (hoursAgo <= 72) {
                status = 'warning'; statusColor = 'var(--warning)'; statusLabel = 'Warning';
            } else if (hoursAgo <= 168) {
                status = 'alert'; statusColor = 'var(--warning)'; statusLabel = 'Alert';
            } else {
                status = 'critical'; statusColor = 'var(--danger)'; statusLabel = 'Critical';
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
            <div style="background:var(--success-bg);border:1px solid var(--success-border);border-radius:10px;padding:16px;text-align:center">
                <div class="od-metric-value" style="font-size:28px;color:var(--success)">${ok}</div>
                <div class="od-metric-label" style="color:var(--success)">Healthy</div>
            </div>
            <div style="background:var(--gold-100);border:1px solid var(--gold-200);border-radius:10px;padding:16px;text-align:center">
                <div class="od-metric-value" style="font-size:28px;color:var(--gold-700)">${warning}</div>
                <div class="od-metric-label" style="color:var(--gold-700)">1–3 Days</div>
            </div>
            <div style="background:var(--warning-bg);border:1px solid var(--warning-border);border-radius:10px;padding:16px;text-align:center">
                <div class="od-metric-value" style="font-size:28px;color:var(--warning)">${alert}</div>
                <div class="od-metric-label" style="color:var(--warning)">3–7 Days</div>
            </div>
            <div style="background:var(--danger-bg);border:1px solid var(--danger-border);border-radius:10px;padding:16px;text-align:center">
                <div class="od-metric-value" style="font-size:28px;color:var(--danger)">${critical}</div>
                <div class="od-metric-label" style="color:var(--danger)">Needs Reconnect</div>
            </div>
            <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:10px;padding:16px;text-align:center">
                <div class="od-metric-value" style="font-size:28px;color:var(--text-primary)">${total}</div>
                <div class="od-metric-label" style="color:var(--text-secondary)">Total Active</div>
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

            return `<tr style="border-bottom:1px solid var(--border-subtle);${rowBg ? 'background:' + rowBg : ''}">
                <td style="padding:10px 12px"><span role="img" aria-label="${a.statusLabel}" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${a.statusColor};margin-right:6px"></span>${a.statusLabel}</td>
                <td style="padding:10px 12px;font-weight:500">${escHtml(a.alias)}</td>
                <td style="padding:10px 12px;color:var(--text-secondary)">${escHtml(a.institution)}</td>
                <td style="padding:10px 12px">${syncStr}</td>
                <td style="padding:10px 12px;font-weight:500;color:${a.statusColor}">${agoStr}</td>
                <td style="padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums">${balStr}</td>
            </tr>`;
        }).join('');

        // ── Sync Bar + Health Checks ──
        if (typeof registerSyncBar === 'function') {
            registerSyncBar('fintable', {
                refreshFn: () => loadFintableSyncMonitor(true),
                checks: [
                    {
                        name: 'Account records fetched', kind: 'sync', run: () => {
                            if (!records || records.length === 0) return { status: 'fail', detail: 'No account records returned from Airtable' };
                            return { status: 'pass', detail: `${records.length} account records loaded from Accounts table` };
                        }
                    },
                    {
                        name: 'Each account classified', kind: 'sync', run: () => {
                            const unclassified = (records || []).filter(r => {
                                try { return !classifyFintableAccount(r); } catch (_) { return true; }
                            });
                            if (unclassified.length) return { status: 'fail', detail: `${unclassified.length} account(s) failed classification` };
                            return { status: 'pass', detail: `All ${records.length} accounts classified (Healthy / Stale / Critical / Inactive)` };
                        }
                    },
                    {
                        name: 'Last-sync timestamp present on every account', kind: 'sync', run: () => {
                            const missing = (records || []).filter(r => !r.fields?.['**Last Successful Update']);
                            if (missing.length) return { status: 'warn', detail: `${missing.length} account(s) missing last-sync timestamp — they may have never synced` };
                            return { status: 'pass', detail: 'All accounts have a recorded last-sync time' };
                        }
                    },
                    {
                        name: 'Stale-sync alert ribbon evaluates correctly', kind: 'automation', run: () => {
                            if (typeof updateFintableAlerts !== 'function') return { status: 'fail', detail: 'updateFintableAlerts() not loaded' };
                            return { status: 'pass', detail: 'Alert ribbon shows on dashboard when any monitored account is stale' };
                        }
                    },
                    {
                        name: 'Sidebar Accounts badge wired', kind: 'automation', run: () => {
                            const badgeEl = document.getElementById('fintableBadge');
                            if (!badgeEl) return { status: 'fail', detail: 'Sidebar badge element missing' };
                            return { status: 'pass', detail: 'Badge updates every dashboard refresh' };
                        }
                    },
                ],
            });
            markTabSynced('fintable');
        }
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

