// ══════════════════════════════════════════
// CEO BRIEF — the AI CEO's daily direction, on the dashboard
// ══════════════════════════════════════════
//
// Shows the same brief the 09:00 Slack DM delivers, plus history. The brief is
// WRITTEN by the money-confidence-daily Cloudflare worker (scripts/
// slack-automation/money-daily-worker.js) into the CEO Briefs table; this tab
// only READS. Discussion happens in Slack by design (Kevin, 28 Jul 2026) — the
// tab is the record, Slack is the conversation.
//
// ISOLATION: additive tab. Own fetch (small table); no shared globals modified.
//
// Field IDs, not names. This tab and the worker both used field names until
// 2026-07-29; the nightly drift monitor only watches the IDs in config.js, so a
// rename in Airtable would have broken the 09:00 brief silently with nothing to
// catch it. Both sides now go through TABLES.ceoBriefs / F.ceo* and the read asks
// for returnFieldsByFieldId=true, matching every other fetch in the platform.

let ceoBriefRecords = null; // session cache; Refresh re-fetches

async function fetchCeoBriefs() {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.ceoBriefs}`);
    url.searchParams.set('returnFieldsByFieldId', 'true');
    url.searchParams.set('pageSize', '30');
    url.searchParams.append('sort[0][field]', F.ceoDate);
    url.searchParams.append('sort[0][direction]', 'desc');
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${PAT}` } });
    if (!resp.ok) throw new Error(`CEO Briefs fetch failed (${resp.status})`);
    const data = await resp.json();
    return data.records || [];
}

function ceoBriefTodayISO() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

// A brief is written in TWO stages, so "a record exists for today" does not mean
// "today's brief is ready". The 07:30 department huddle writes the record first
// with only One Thing, First Step and Board Flags; the 09:00 worker then PATCHes
// in the money light, safe-to-act figure, why, ignore-today and handed-off.
//
// Full Brief is the marker for stage two, and the worker already uses exactly
// this test on the write side (gatherHuddle: "if (getField(rec, F.ceoFullBrief))
// return null; // worker already ran today"). The read side uses it too, so both
// halves of the pipeline agree on what "finished" means.
//
// Without this, the 07:30 stub rendered as a finished brief every weekday
// morning: a dash for the money light, a dash for safe-to-act, no reasoning, and
// no warning that anything was missing. Found by the drift monitor 2026-07-31.
function ceoBriefIsComplete(rec) {
    return Boolean((rec && rec.fields || {})[F.ceoFullBrief]);
}

function ceoLightBadge(light) {
    const map = {
        green: ['var(--success)', 'var(--success-bg)', 'GREEN'],
        amber: ['var(--warning)', 'var(--warning-bg)', 'AMBER'],
        red:   ['var(--danger)',  'var(--danger-bg)',  'RED'],
    };
    const [fg, bg, label] = map[light] || ['var(--text-muted)', 'var(--bg-subtle)', '—'];
    return `<span style="color:${fg};background:${bg};padding:2px 10px;border-radius:var(--radius-full);font-size:var(--fs-xs);font-weight:var(--fw-semibold)">${label}</span>`;
}

function renderCeoBriefCard(rec, isToday) {
    const f = rec.fields || {};
    const flags = String(f[F.ceoBoardFlags] || '').split('\n').filter(Boolean);
    const ignore = String(f[F.ceoIgnoreToday] || '').split('\n').filter(Boolean);
    const handed = String(f[F.ceoHandedOff] || '').split('\n').filter(Boolean);
    const money = f[F.ceoSafeToAct] != null
        ? `£${Number(f[F.ceoSafeToAct]).toLocaleString('en-GB', { minimumFractionDigits: 2 })}` : '—';
    // Stage one only: show what the 07:30 huddle decided and say plainly that the
    // money light and the reasoning land at 9am, rather than printing two dashes
    // and letting the card read as finished.
    const provisional = !ceoBriefIsComplete(rec);
    const statusHtml = provisional
        ? `<span style="font-size:var(--fs-xs);color:var(--text-secondary);background:var(--bg-subtle);padding:2px 10px;border-radius:var(--radius-full)">7:30 huddle · money light and reasoning land at 9am</span>`
        : `${ceoLightBadge(f[F.ceoMoneyLight])}<span style="font-size:var(--fs-xs);color:var(--text-secondary)">Safe to act: <strong>${escHtml(money)}</strong></span>`;
    return `
    <div style="background:var(--bg-surface);border:1px solid ${isToday ? 'var(--accent)' : 'var(--border-default)'};border-radius:var(--radius-lg);padding:var(--space-5);margin-bottom:var(--space-4);box-shadow:var(--shadow-sm)">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:var(--space-3);flex-wrap:wrap">
            <div style="font-size:var(--fs-xs);color:var(--text-muted);font-weight:var(--fw-medium)">${escHtml(f[F.ceoDate] || '')}${isToday ? ' · TODAY' : ''}${provisional ? ' · NOT FINISHED' : ''}</div>
            <div style="display:flex;align-items:center;gap:var(--space-2)">${statusHtml}</div>
        </div>
        <div style="margin-top:var(--space-3);font-size:var(--fs-lg);font-weight:var(--fw-bold);color:var(--text-primary)">${escHtml(f[F.ceoOneThing] || '')}</div>
        ${f[F.ceoFirstStep] ? `<div style="margin-top:var(--space-2);padding:var(--space-3);background:var(--accent-soft);border-radius:var(--radius-md);font-size:var(--fs-sm);color:var(--text-primary)"><strong>Start here (10 min):</strong> ${escHtml(f[F.ceoFirstStep])}</div>` : ''}
        ${f[F.ceoWhy] ? `<div style="margin-top:var(--space-3);font-size:var(--fs-sm);color:var(--text-secondary)"><strong>Why this wins:</strong> ${escHtml(f[F.ceoWhy])}</div>` : ''}
        ${handed.length ? `<div style="margin-top:var(--space-3);padding:var(--space-3);background:var(--bg-surface-2);border-radius:var(--radius-md);font-size:var(--fs-sm);color:var(--text-secondary)"><strong style="color:var(--text-primary)">Not yours today, handed off:</strong><ul style="margin:var(--space-1) 0 0 var(--space-5);padding:0">${handed.map(h => `<li>${escHtml(h)}</li>`).join('')}</ul></div>` : ''}
        ${ignore.length ? `<div style="margin-top:var(--space-3);font-size:var(--fs-sm);color:var(--text-muted)"><strong>Ignore today:</strong><ul style="margin:var(--space-1) 0 0 var(--space-5);padding:0">${ignore.map(i => `<li>${escHtml(i)}</li>`).join('')}</ul></div>` : ''}
        ${flags.map(fl => `<div style="margin-top:var(--space-2);font-size:var(--fs-sm);color:var(--warning);background:var(--warning-bg);padding:var(--space-2) var(--space-3);border-radius:var(--radius-md)">⚑ ${escHtml(fl)}</div>`).join('')}
    </div>`;
}

function renderCeoBriefContent(el) {
    const recs = ceoBriefRecords || [];
    const today = ceoBriefTodayISO();
    const todayRec = recs.find(r => (r.fields || {})[F.ceoDate] === today);
    const history = recs.filter(r => r !== todayRec);
    const isWeekend = [0, 6].includes(new Date().getDay());

    let todayHtml;
    if (todayRec) {
        // A stage-one record still gets shown — the one thing and the first step are
        // the most useful part of the brief and hiding them until 9am wastes them —
        // but it is labelled, and the note below says what is still coming.
        todayHtml = (ceoBriefIsComplete(todayRec) ? '' : `<div style="background:var(--bg-subtle);border-radius:var(--radius-md);padding:var(--space-3);margin-bottom:var(--space-3);font-size:var(--fs-sm);color:var(--text-secondary)">This is the 7:30 huddle's call, not the finished brief. The money light, the safe-to-act figure and the reasoning arrive at 9am with the Slack DM.</div>`)
            + renderCeoBriefCard(todayRec, true);
    } else if (isWeekend) {
        todayHtml = `<div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:var(--space-5);color:var(--text-secondary);font-size:var(--fs-sm)">No brief today — the CEO writes briefs on weekday mornings at 9am. Enjoy the weekend.</div>`;
    } else {
        todayHtml = `<div style="background:var(--warning-bg);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:var(--space-5);color:var(--text-primary);font-size:var(--fs-sm)">⚠️ Today's brief has not arrived yet. It is written at 9am on weekdays. If it is past 9:15am, check the Slack DM — if that is missing too, the morning robot needs looking at.</div>`;
    }

    el.innerHTML = `<div data-sync-bar="ceo-brief"></div>
    <div style="max-width:860px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-4);flex-wrap:wrap;gap:var(--space-2)">
            <h2 style="margin:0;font-size:var(--fs-2xl);font-weight:var(--fw-bold);color:var(--text-primary)">☀️ CEO Brief</h2>
            <div style="font-size:var(--fs-xs);color:var(--text-muted)">Written 9am weekdays · reply in the Slack DM to talk it through</div>
        </div>
        ${todayHtml}
        ${history.length ? `
        <div style="margin-top:var(--space-6);font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--text-secondary);margin-bottom:var(--space-3)">Previous briefs</div>
        ${history.map(r => renderCeoBriefCard(r, false)).join('')}` : ''}
        ${!recs.length ? `<div style="margin-top:var(--space-4);color:var(--text-muted);font-size:var(--fs-sm)">No briefs stored yet. The first one lands the next weekday morning at 9am.</div>` : ''}
    </div>`;
}

let ceoBriefLoading = false;
async function renderCeoBriefTab(force) {
    const el = document.getElementById('tab-ceo-brief');
    if (!el || ceoBriefLoading) return;
    registerCeoBriefSyncBar();

    if (ceoBriefRecords && !force) { renderCeoBriefContent(el); if (typeof markTabSynced === 'function') markTabSynced('ceo-brief'); return; }

    ceoBriefLoading = true;
    el.innerHTML = `<div data-sync-bar="ceo-brief"></div>
        <div style="padding:var(--space-8);text-align:center;color:var(--text-muted)">Loading the CEO brief…</div>`;
    try {
        ceoBriefRecords = await fetchCeoBriefs();
        renderCeoBriefContent(el);
        if (typeof markTabSynced === 'function') markTabSynced('ceo-brief');
    } catch (err) {
        el.innerHTML = `<div data-sync-bar="ceo-brief"></div>
        <div style="padding:var(--space-6);background:var(--danger-bg);border-radius:var(--radius-lg);max-width:560px">
            <div style="font-weight:var(--fw-semibold);color:var(--danger);margin-bottom:var(--space-2)">Could not load the CEO briefs</div>
            <div style="font-size:var(--fs-sm);color:var(--text-secondary);margin-bottom:var(--space-3)">${escHtml(String(err.message || err))}</div>
            <button onclick="renderCeoBriefTab(true)" style="padding:8px 16px;border:none;background:var(--accent);color:#fff;border-radius:var(--radius-md);cursor:pointer;font-size:var(--fs-sm);font-weight:var(--fw-semibold)">Retry</button>
        </div>`;
        if (typeof showToast === 'function') showToast('CEO briefs failed to load', 'error');
    } finally {
        ceoBriefLoading = false;
    }
}

function registerCeoBriefSyncBar() {
    if (typeof registerSyncBar !== 'function') return;
    registerSyncBar('ceo-brief', {
        refreshFn: () => renderCeoBriefTab(true),
        checks: [
            {
                name: 'Briefs table reachable', kind: 'sync', run: () => {
                    if (!ceoBriefRecords) return { status: 'fail', detail: 'Briefs not loaded yet — press Refresh' };
                    return { status: 'pass', detail: `${ceoBriefRecords.length} brief(s) stored in the CEO Briefs table` };
                }
            },
            {
                name: "Today's brief arrived (weekdays after 10am)", kind: 'automation', run: () => {
                    const now = new Date();
                    if ([0, 6].includes(now.getDay())) return { status: 'pass', detail: 'Weekend — no brief expected' };
                    const londonHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).format(now));
                    if (londonHour < 10) return { status: 'pass', detail: 'Before 10am — the brief may still be on its way' };
                    // The 07:30 huddle leaves a record behind, so "a record exists" is not
                    // proof the 9am robot ran. Only a finished brief counts as arrived.
                    const rec = (ceoBriefRecords || []).find(r => (r.fields || {})[F.ceoDate] === ceoBriefTodayISO());
                    if (!rec) return { status: 'fail', detail: 'Missing — check the Slack DM; if that is missing too, the morning robot needs attention' };
                    if (!ceoBriefIsComplete(rec)) return { status: 'fail', detail: 'Only the 7:30 huddle landed — the 9am robot did not finish the brief' };
                    return { status: 'pass', detail: 'Arrived and stored' };
                }
            },
            {
                name: 'Latest brief is complete', kind: 'sync', run: () => {
                    const recs = ceoBriefRecords || [];
                    if (!recs.length) return { status: 'warn', detail: 'No briefs stored yet — first one lands next weekday 9am' };
                    // Judge the latest FINISHED brief. Checking recs[0] blindly turned this
                    // red every weekday between 7:30 and 9am, when today's record is a
                    // huddle stub by design — a check that cries wolf gets ignored.
                    const latest = recs.find(ceoBriefIsComplete);
                    if (!latest) return { status: 'warn', detail: 'Only the 7:30 huddle so far — the 9am brief has not landed yet' };
                    const f = latest.fields || {};
                    const missing = [['One Thing', F.ceoOneThing], ['First Step', F.ceoFirstStep], ['Money Light', F.ceoMoneyLight]]
                        .filter(([, id]) => !f[id]).map(([label]) => label);
                    if (missing.length) return { status: 'fail', detail: 'Latest brief missing: ' + missing.join(', ') };
                    return { status: 'pass', detail: 'One thing, first step and money light all present' };
                }
            },
            {
                name: 'Morning robot ran within the last week', kind: 'automation', run: () => {
                    const recs = ceoBriefRecords || [];
                    if (!recs.length) return { status: 'warn', detail: 'No briefs yet — new install' };
                    // Finished briefs only. A run of 7:30 huddle stubs would otherwise keep
                    // this green through a week-long outage of the 9am robot.
                    const newest = recs.find(ceoBriefIsComplete);
                    if (!newest) return { status: 'fail', detail: 'No finished brief stored — the 9am robot has not completed a run' };
                    const latest = (newest.fields || {})[F.ceoDate] || '';
                    const age = Math.round((new Date(ceoBriefTodayISO()) - new Date(latest)) / 86400000);
                    if (age > 6) return { status: 'fail', detail: `Latest brief is ${age} days old — the 9am robot has stopped` };
                    return { status: 'pass', detail: `Latest brief: ${latest}` };
                }
            },
        ],
    });
}
