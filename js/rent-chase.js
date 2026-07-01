// ══════════════════════════════════════════
// RENT CHASE — AI-drafted arrears chases, human-approved (nothing auto-sends)
// ══════════════════════════════════════════
//
// The first "approval-queue" agent. For every tenancy currently in arrears the
// AI drafts a humble, factual chase message. Each draft is queued for review:
// you edit it, then one click opens it ready to send in your own mail client
// (tenant email) or copies it (phone-only). NOTHING sends automatically — you
// are always the sender. Every send is logged with Undo, and skipping a tenant
// suppresses them so they are never re-drafted until you clear it.
//
// Reuses the reconciliation agent's runtime primitives (localStorage log +
// undo + suppress) and the arrears engine's canonical "in arrears" definition
// (window.computeRentStatement / window.isCurrentlyInArrears), so a chase can
// never contradict your own rent data.
//
// Depends only on confirmed globals:
//   allTenancies, allTenants (dashboard.js)
//   F, TABLES, BASE_ID, PAT (config.js)
//   getField, escHtml, fmt, showToast, isTenantStatusActive (shared.js)
//   window.computeRentStatement, window.buildTxByTenancyIndex,
//   window.getTenantTypeForTenancy (arrears.js)

    const RC_PROXY = 'https://claude-proxy.kevinbrittain.workers.dev';
    const RC_MIN_BALANCE = 50;        // don't chase for less than £50 owed
    const RC_LOG_KEY = 'rent_chase_log';
    const RC_SUPPRESS_KEY = 'rent_chase_suppress';

    let rcQueue = [];        // in-memory drafts awaiting approval
    let rcBusy = false;      // guard against double-drafting

    // ── localStorage primitives (mirror reconciliation.js) ──
    function rcGetLog() { try { return JSON.parse(localStorage.getItem(RC_LOG_KEY) || '[]'); } catch (e) { return []; } }
    function rcSetLog(list) { localStorage.setItem(RC_LOG_KEY, JSON.stringify(list.slice(-100))); }
    function rcGetSuppress() { try { return JSON.parse(localStorage.getItem(RC_SUPPRESS_KEY) || '[]'); } catch (e) { return []; } }
    function rcAddSuppress(id) {
        const s = rcGetSuppress();
        if (!s.includes(id)) { s.push(id); localStorage.setItem(RC_SUPPRESS_KEY, JSON.stringify(s)); }
    }
    function rcRemoveSuppress(id) {
        const s = rcGetSuppress().filter(x => x !== id);
        localStorage.setItem(RC_SUPPRESS_KEY, JSON.stringify(s));
    }
    window.getRentChaseLog = rcGetLog;
    window.getRentChaseSuppress = rcGetSuppress;

    // ── Tenant helpers (inlined so we depend on no unexposed functions) ──
    function rcTenantFor(tenancy) {
        const linked = getField(tenancy, F.tenLinkedTenant);
        if (!linked) return null;
        const id = Array.isArray(linked) ? (typeof linked[0] === 'string' ? linked[0] : linked[0]?.id) : null;
        return id ? (allTenants.find(t => t.id === id) || null) : null;
    }
    function rcFirstName(fullName) {
        const n = String(fullName || '').trim();
        if (!n) return 'there';
        return n.split(/\s+/)[0];
    }
    function rcPropertyLabel(tenancy) {
        const raw = getField(tenancy, F.tenProperty);
        const v = Array.isArray(raw) ? raw[0] : raw;
        return v ? String(v) : '';
    }

    // ══════════════════════════════════════════
    // GATHER — who is currently in arrears and worth chasing
    // ══════════════════════════════════════════
    function rcGatherCandidates() {
        const today = new Date();
        const txIndex = window.buildTxByTenancyIndex ? window.buildTxByTenancyIndex() : null;
        const lookup = {};
        (allTenants || []).forEach(t => { lookup[t.id] = t; });
        const suppressed = rcGetSuppress();
        const candidates = [];
        let suppressedCount = 0;

        for (const tenancy of (allTenancies || [])) {
            if (!isTenantStatusActive(tenancy)) continue;
            const tenantType = window.getTenantTypeForTenancy
                ? window.getTenantTypeForTenancy(tenancy, lookup) : null;

            const stmt = window.computeRentStatement(tenancy, tenantType, today, txIndex);
            if (!stmt || !stmt.applicable) continue;

            // Canonical "currently in arrears" (handles due-day tolerance + month
            // boundaries + tenant type) AND a meaningful outstanding balance.
            const inArrears = window.isCurrentlyInArrears
                ? window.isCurrentlyInArrears(tenancy, tenantType, today, txIndex) : (stmt.balance > 0);
            if (!inArrears) continue;
            if (stmt.balance < RC_MIN_BALANCE) continue;

            if (suppressed.includes(tenancy.id)) { suppressedCount++; continue; }

            const tenant = rcTenantFor(tenancy);
            const fullName = tenant
                ? String(getField(tenant, F.tenantName) || '').trim()
                : String(getField(tenancy, F.tenSurname) || '').trim();
            if (!fullName) continue; // can't personalise → skip

            const email = tenant ? String(getField(tenant, F.tenantEmail) || '').trim() : '';
            const phone = tenant ? String(getField(tenant, F.tenantPhone) || '').trim() : '';

            candidates.push({
                tenancyId: tenancy.id,
                fullName,
                firstName: rcFirstName(fullName),
                email,
                phone,
                amount: Math.round(stmt.balance),
                days: stmt.daysInArrears,
                monthlyRent: Math.round(stmt.monthlyRent),
                tenantType: tenantType || 'Unknown',
                property: rcPropertyLabel(tenancy),
            });
        }

        candidates.sort((a, b) => b.days - a.days);
        return { candidates, suppressedCount };
    }

    // ══════════════════════════════════════════
    // DRAFT — AI writes each chase (template fallback guarantees it always works)
    // ══════════════════════════════════════════
    function rcTemplate(c) {
        const amt = fmt(c.amount);
        let body;
        if (c.days >= 45) {
            body = `Hi ${c.firstName},\n\nI'm writing about your rent account, which is now around ${amt} behind (about ${c.days} days). I do need to get this resolved, so please arrange payment as soon as you can.\n\nIf something has changed or money is tight, please reply and we'll agree a realistic plan together. I would much rather work this out with you than let it grow.\n\nThank you,\nKevin`;
        } else if (c.days >= 14) {
            body = `Hi ${c.firstName},\n\nA quick follow-up on your rent account. It's currently about ${amt} behind (around ${c.days} days). Could you arrange payment when you're able?\n\nIf anything has changed or you'd like to spread it out, just reply and we'll sort a plan that works. Happy to help.\n\nThanks,\nKevin`;
        } else {
            body = `Hi ${c.firstName},\n\nI hope you're well. Just a friendly note that your rent account is showing about ${amt} outstanding (around ${c.days} days). Could you please arrange payment when you get a moment?\n\nIf there's anything you need to discuss, just reply. No problem at all.\n\nThanks,\nKevin`;
        }
        return { tenancyId: c.tenancyId, subject: 'A quick note about your rent account', body };
    }

    async function rcAiDrafts(candidates) {
        const system = `You write rent-arrears chase messages for a UK property owner (Kevin).
TONE RULES (strict):
- British English only. Warm, humble, factual, respectful. Never aggressive, never legal threats, never mention eviction or court.
- Address the tenant by first name. Sign off as "Kevin".
- State the outstanding amount and roughly how overdue, as fact, not accusation.
- Always offer to help or agree a payment plan if money is tight.
- Tier by how overdue: under 14 days = gentle friendly reminder; 14-44 days = firmer but supportive follow-up; 45+ days = serious but still kind, ask to resolve.
- Keep each message under 90 words. Plain text, no markdown, no emojis.
- For Universal Credit tenants be extra gentle (payments can lag from the council).
Return ONLY valid JSON, no prose, in this exact shape:
{"drafts":[{"tenancyId":"...","subject":"...","body":"..."}]}`;
        const payload = candidates.map(c => ({
            tenancyId: c.tenancyId,
            firstName: c.firstName,
            amountOwed: c.amount,
            daysOverdue: c.days,
            monthlyRent: c.monthlyRent,
            tenantType: c.tenantType,
        }));
        const userMsg = `Write one chase per tenant. Tenants:\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;

        const resp = await fetch(RC_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2500, system, messages: [{ role: 'user', content: userMsg }] })
        });
        if (!resp.ok) throw new Error('API ' + resp.status);
        const data = await resp.json();
        let text = data.content?.[0]?.text || '';
        text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        let parsed;
        try { parsed = JSON.parse(text); }
        catch (e) {
            const m = text.match(/\{[\s\S]*\}/);
            if (!m) throw new Error('Unparseable AI response');
            parsed = JSON.parse(m[0]);
        }
        const byId = {};
        (parsed.drafts || []).forEach(d => { if (d && d.tenancyId) byId[d.tenancyId] = d; });
        return byId;
    }

    // ══════════════════════════════════════════
    // BUILD THE QUEUE
    // ══════════════════════════════════════════
    async function rcDraftChases() {
        if (rcBusy) return;
        rcBusy = true;
        const btn = document.getElementById('rcDraftBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Drafting…'; }

        const { candidates } = rcGatherCandidates();
        if (!candidates.length) {
            rcBusy = false;
            if (btn) { btn.disabled = false; btn.textContent = '✍ Draft rent chases'; }
            rcQueue = [];
            renderRentChasePanel('rentChaseContainer');
            if (typeof showToast === 'function') showToast('No tenancies currently need chasing');
            return;
        }

        let aiOk = true;
        let byId = {};
        try {
            byId = await rcAiDrafts(candidates);
        } catch (e) {
            aiOk = false;
            console.warn('Rent chase AI drafting failed, using templates:', e);
        }

        rcQueue = candidates.map(c => {
            const ai = byId[c.tenancyId];
            const draft = (ai && ai.body) ? { subject: ai.subject || 'A quick note about your rent account', body: ai.body } : rcTemplate(c);
            return Object.assign({}, c, { subject: draft.subject, body: draft.body });
        });

        rcBusy = false;
        if (btn) { btn.disabled = false; btn.textContent = '✍ Re-draft rent chases'; }
        renderRentChasePanel('rentChaseContainer');
        if (typeof showToast === 'function') {
            showToast(aiOk ? `Drafted ${rcQueue.length} chase${rcQueue.length === 1 ? '' : 's'} — review and send` : `Drafted ${rcQueue.length} using the standard template (AI unavailable)`);
        }
    }

    // ── Read the (possibly edited) draft back out of the DOM before acting ──
    function rcReadDraft(tenancyId) {
        const item = rcQueue.find(q => q.tenancyId === tenancyId);
        if (!item) return null;
        const bodyEl = document.getElementById('rcBody-' + tenancyId);
        const subEl = document.getElementById('rcSubject-' + tenancyId);
        if (bodyEl) item.body = bodyEl.value;
        if (subEl) item.subject = subEl.value;
        return item;
    }

    // ── Actions ──
    function rcOpenEmail(tenancyId) {
        const item = rcReadDraft(tenancyId);
        if (!item) return;
        if (!item.email) { if (typeof showToast === 'function') showToast('No email on file — use Copy and send by text'); return; }
        const href = 'mailto:' + encodeURIComponent(item.email) +
            '?subject=' + encodeURIComponent(item.subject) +
            '&body=' + encodeURIComponent(item.body);
        window.open(href, '_blank');
        if (typeof showToast === 'function') showToast('Opened in your email — review and hit send');
    }

    async function rcCopy(tenancyId) {
        const item = rcReadDraft(tenancyId);
        if (!item) return;
        try {
            await navigator.clipboard.writeText(item.body);
            if (typeof showToast === 'function') showToast('Message copied — paste into your text or email app');
        } catch (e) {
            if (typeof showToast === 'function') showToast('Copy failed — select the text manually');
        }
    }

    // Log an audit note on the tenancy record (non-blocking; never breaks the flow)
    async function rcAuditComment(item) {
        if (!PAT) return;
        const via = item.email ? 'email' : 'copy';
        const text = `Rent chase prepared for sending (${via}) on ${new Date().toLocaleDateString('en-GB')} — approx ${fmt(item.amount)} outstanding, ~${item.days} days. Sent by Kevin from the Rent Chase queue.`;
        try {
            await fetch(`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tenancies}/${item.tenancyId}/comments`, {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ text })
            });
        } catch (e) { console.warn('Rent chase audit comment failed:', e); }
    }

    async function rcMarkSent(tenancyId) {
        const item = rcReadDraft(tenancyId);
        if (!item) return;
        const log = rcGetLog();
        log.push({
            tenancyId: item.tenancyId,
            tenantName: item.fullName,
            amount: item.amount,
            days: item.days,
            via: item.email ? 'email' : 'copy',
            at: new Date().toISOString(),
        });
        rcSetLog(log);
        rcAuditComment(item); // fire-and-forget audit trail
        rcQueue = rcQueue.filter(q => q.tenancyId !== tenancyId);
        renderRentChasePanel('rentChaseContainer');
        if (typeof showToast === 'function') showToast('Marked as sent and logged');
    }

    function rcSkip(tenancyId) {
        rcAddSuppress(tenancyId);
        rcQueue = rcQueue.filter(q => q.tenancyId !== tenancyId);
        renderRentChasePanel('rentChaseContainer');
        if (typeof showToast === 'function') showToast('Skipped — won\'t be drafted again until you clear it');
    }

    function rcUndo(idx) {
        const log = rcGetLog();
        if (idx < 0 || idx >= log.length) return;
        log.splice(idx, 1);
        rcSetLog(log);
        renderRentChasePanel('rentChaseContainer');
        if (typeof showToast === 'function') showToast('Chase log entry removed');
    }

    function rcClearSuppress() {
        localStorage.removeItem(RC_SUPPRESS_KEY);
        renderRentChasePanel('rentChaseContainer');
        if (typeof showToast === 'function') showToast('Skip list cleared');
    }

    // ══════════════════════════════════════════
    // RENDER
    // ══════════════════════════════════════════
    function rcBadge(text, color) {
        return `<span style="display:inline-block;font-size:11px;font-weight:var(--fw-semibold);padding:2px 8px;border-radius:var(--radius-full);background:${color};color:#fff">${escHtml(text)}</span>`;
    }
    function rcDaysColor(days) {
        if (days >= 45) return 'var(--danger)';
        if (days >= 14) return 'var(--warning)';
        return 'var(--accent)';
    }

    function rcQueueCardHtml(item) {
        const daysCol = rcDaysColor(item.days);
        const contact = item.email
            ? `<span style="color:var(--text-secondary)">✉ ${escHtml(item.email)}</span>`
            : (item.phone ? `<span style="color:var(--text-secondary)">📱 ${escHtml(item.phone)}</span>` : `<span style="color:var(--danger)">No contact on file</span>`);
        const ucNote = item.tenantType === 'Universal Credit'
            ? `<span style="font-size:11px;color:var(--text-muted)">UC — payments can lag from the council</span>` : '';
        return `
        <div style="border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:14px;margin-bottom:12px;background:var(--bg-surface)">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:10px">
                <div>
                    <div style="font-weight:var(--fw-semibold);color:var(--text-primary)">${escHtml(item.fullName)}${item.property ? ` <span style="font-weight:var(--fw-regular);color:var(--text-muted)">· ${escHtml(item.property)}</span>` : ''}</div>
                    <div style="margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                        ${rcBadge(fmt(item.amount) + ' owed', 'var(--text-secondary)')}
                        ${rcBadge('~' + item.days + ' days', daysCol)}
                        ${item.tenantType && item.tenantType !== 'Unknown' ? rcBadge(item.tenantType, 'var(--bg-subtle)').replace('#fff', 'var(--text-secondary)') : ''}
                    </div>
                </div>
                <div style="text-align:right;font-size:12px">${contact}<br>${ucNote}</div>
            </div>
            <input id="rcSubject-${item.tenancyId}" value="${escHtml(item.subject)}"
                style="width:100%;box-sizing:border-box;margin-bottom:8px;padding:8px 10px;border:1px solid var(--border-subtle);border-radius:var(--radius-md);font-family:var(--font-family-base);font-size:13px;color:var(--text-primary);background:var(--bg-app)">
            <textarea id="rcBody-${item.tenancyId}" rows="7"
                style="width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--border-subtle);border-radius:var(--radius-md);font-family:var(--font-family-base);font-size:13px;line-height:1.6;color:var(--text-primary);background:var(--bg-app);resize:vertical">${escHtml(item.body)}</textarea>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
                ${item.email ? `<button class="od-btn-primary od-btn-sm" onclick="rcOpenEmail('${item.tenancyId}')">✉ Open email</button>` : ''}
                <button class="od-btn-secondary od-btn-sm" onclick="rcCopy('${item.tenancyId}')">⧉ Copy message</button>
                <button class="od-btn-outline od-btn-sm" onclick="rcMarkSent('${item.tenancyId}')">✓ Mark sent</button>
                <button class="od-btn-outline od-btn-sm" onclick="rcSkip('${item.tenancyId}')" style="margin-left:auto">Skip</button>
            </div>
        </div>`;
    }

    function rcLogHtml() {
        const log = rcGetLog();
        if (!log.length) return '';
        // newest first
        const rows = log.slice().reverse().map((e, ri) => {
            const realIdx = log.length - 1 - ri;
            const d = new Date(e.at);
            const when = isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-subtle);font-size:12px">
                <span>${escHtml(e.tenantName || '—')} · ${fmt(e.amount || 0)} · <span style="color:var(--text-muted)">${escHtml(e.via || '')} · ${when}</span></span>
                <button class="od-btn-outline od-btn-sm" onclick="rcUndo(${realIdx})">Undo</button>
            </div>`;
        }).join('');
        return `<div style="margin-top:16px">
            <div style="font-weight:var(--fw-semibold);color:var(--text-secondary);font-size:13px;margin-bottom:6px">Chased today</div>
            ${rows}
        </div>`;
    }

    function renderRentChasePanel(containerId) {
        const el = document.getElementById(containerId || 'rentChaseContainer');
        if (!el) return;

        const suppressCount = rcGetSuppress().length;
        const suppressChip = suppressCount
            ? `<button class="od-btn-outline od-btn-sm" onclick="rcClearSuppress()">Clear skip list (${suppressCount})</button>` : '';

        const queueHtml = rcQueue.length
            ? rcQueue.map(rcQueueCardHtml).join('')
            : `<div class="od-text-muted-sm" style="padding:10px 0;color:var(--text-muted)">Click <strong>Draft rent chases</strong> to have the AI prepare a message for every tenancy currently in arrears. Nothing sends until you review it and hit send yourself.</div>`;

        el.innerHTML = `
        <div class="section">
            <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:8px">
                <h2 class="section-title" style="margin-bottom:0">Rent Chase <span style="font-size:12px;font-weight:var(--fw-regular);color:var(--accent)">· AI drafts, you approve</span></h2>
                <span style="font-size:12px;color:var(--text-muted)">Nothing sends automatically — every message is yours to review and send</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
                <button id="rcDraftBtn" class="od-btn-primary od-btn-sm" onclick="rcDraftChases()">✍ ${rcQueue.length ? 'Re-draft rent chases' : 'Draft rent chases'}</button>
                ${suppressChip}
            </div>
            ${queueHtml}
            ${rcLogHtml()}
        </div>`;
    }

    // ── Expose for onclick handlers + the CFV render hook ──
    window.renderRentChasePanel = renderRentChasePanel;
    window.rcDraftChases = rcDraftChases;
    window.rcOpenEmail = rcOpenEmail;
    window.rcCopy = rcCopy;
    window.rcMarkSent = rcMarkSent;
    window.rcSkip = rcSkip;
    window.rcUndo = rcUndo;
    window.rcClearSuppress = rcClearSuppress;
