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
        // typecast lets Airtable accept select values whose option is missing
        // from the field. Without it, writing "Contacted (1:1)" 422'd on 12 Aug
        // 2026: the schema never gained the option, so EVERY post-send status
        // update failed while the emails themselves went out fine.
        const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}/${recordId}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${PAT}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields, typecast: true }),
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

    // ── Outbound email model ───────────────────────────────────
    // ONE builder feeds BOTH the preview Kevin approves and the email GHL
    // actually sends. Two code paths would drift, and a drifting preview is
    // worse than no preview: he would sign off on something the prospect
    // never receives. Every change to what goes out belongs in here.

    const PROS_EMAIL_ROUTES = ['Email reply (they asked)', 'Email sequence (Ltd)'];
    const PROS_LEGACY_BOOKING = 'api.leadconnectorhq.com/widget/booking';

    function prosIsEmailRoute(route) { return PROS_EMAIL_ROUTES.includes(route); }

    // Fallback when the agent has not written an Email Subject (records created
    // before the field existed on 7 Aug 2026). Kevin overrides it in the card.
    function prospectDefaultSubject(rec) {
        return prosField(rec, 'Contact Route') === 'Email reply (they asked)'
            ? 'Your post about finding some help'
            : `A thought for ${prosField(rec, 'Company') || 'your business'}`;
    }

    // The sign-off line is part of the signature, never part of the draft, so
    // every email ends the same way whoever wrote the body.
    function prospectSignatureText() {
        return `Kevin\n\n${OD_SENDER.name}\n${OD_SENDER.title}\n${OD_SENDER.website}\n${OD_SENDER.email}`
            + `\n\n${OD_SENDER.postal}`
            + `\nPrefer not to hear from me? Reply "unsubscribe" or email ${OD_SENDER.email} with Unsubscribe in the subject.`;
    }

    // 20 of the 131 drafts on 7 Aug 2026 already ended with a bare "Kevin", and
    // the agent may write one again. Strip a trailing first-name line so the
    // sign-off appears once, not twice. Requires its own line: a body ending
    // "...a quick call with Kevin" is left alone.
    function prosStripSignOff(text) {
        return text.replace(/\s+$/, '').replace(/\n+[ \t]*Kevin[.,!]?[ \t]*$/i, '');
    }

    // Hex, not design tokens, on purpose: this HTML leaves the app and is
    // rendered by Gmail/Outlook, which do not resolve CSS custom properties.
    // Values mirror tokens.css (--text-secondary, --text-primary, --accent).
    function prospectSignatureHtml() {
        return '<div style="margin-top:16px;font-size:14px;color:#1C2422">Kevin</div>'
            + '<div style="margin-top:16px;font-size:13px;line-height:1.5;color:#5A6660">'
            + `<div style="font-weight:600;color:#1C2422">${escHtml(OD_SENDER.name)}</div>`
            + `<div>${escHtml(OD_SENDER.title)}</div>`
            + `<div><a href="https://${escHtml(OD_SENDER.website)}" style="color:#2C6E49">${escHtml(OD_SENDER.website)}</a></div>`
            + `<div><a href="mailto:${escHtml(OD_SENDER.email)}" style="color:#2C6E49">${escHtml(OD_SENDER.email)}</a></div>`
            + '</div>'
            // PECR footer. Kept visually quiet but always present and always a real
            // link, never a merge tag that might not render at the other end.
            + '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #DDE1D9;font-size:11px;line-height:1.5;color:#8A928C">'
            + `<div>${escHtml(OD_SENDER.postal)}</div>`
            + `<div>Prefer not to hear from me? <a href="${escHtml(OD_SENDER.unsubscribeMailto)}" style="color:#8A928C">Unsubscribe</a>, or just reply "unsubscribe".</div>`
            + '</div>';
    }

    // Turns bare URLs in ALREADY-ESCAPED text into anchors. A plain-text link
    // is not guaranteed to be clickable in every mail client, and the booking
    // link is the only action the email asks for.
    function prosLinkify(escaped) {
        return escaped.replace(/https?:\/\/[^\s<]+/g, m => {
            const trail = (m.match(/[.,;:!?)\]]+$/) || [''])[0];
            const url = trail ? m.slice(0, -trail.length) : m;
            return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color:#2C6E49">${url}</a>${trail}`;
        });
    }

    // Escape FIRST, then linkify: escaping afterwards would destroy the anchors.
    function prosBodyHtml(text) {
        return prosLinkify(escHtml(text)).replace(/\n/g, '<br>');
    }

    // overrides lets the live preview use the unsaved textarea/input values.
    function buildProspectEmail(rec, overrides) {
        const o = overrides || {};
        const draft = String(o.draft !== undefined ? o.draft : prosField(rec, 'Draft Message') || '');
        const subject = String(o.subject !== undefined ? o.subject : prosField(rec, 'Email Subject') || '').trim()
            || prospectDefaultSubject(rec);
        const body = prosStripSignOff(draft);
        return {
            fromName: OD_SENDER.name,
            from: OD_SENDER.email,
            to: prosField(rec, 'Contact Email'),
            toName: prosField(rec, 'Name'),
            subject,
            text: body + '\n\n' + prospectSignatureText(),
            html: prosBodyHtml(body) + prospectSignatureHtml(),
        };
    }

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
        // Agent accuracy = share of Kevin-reviewed prospects he approved (rejected =
        // a miss). This is the gate metric: >90% over 2 consecutive weeks unlocks
        // auto-approve for high-confidence prospects.
        const reviewed = records.filter(r => !['Found', PROS_QUEUE_STATUS].includes(prosStatus(r)));
        const rejected = reviewed.filter(r => prosStatus(r) === 'Rejected').length;
        const accuracy = reviewed.length ? (((reviewed.length - rejected) / reviewed.length) * 100) : null;
        const accColor = accuracy === null ? 'var(--text-muted)' : accuracy >= 90 ? 'var(--success)' : accuracy >= 70 ? 'var(--accent-gold)' : 'var(--danger)';
        el.innerHTML = stages.map(s => `
            <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:14px;text-align:center">
                <div style="font-size:24px;font-weight:var(--fw-bold);color:${s.color}">${s.value}</div>
                <div style="font-size:var(--fs-xs);color:var(--text-secondary);margin-top:2px">${s.label}</div>
            </div>`).join('')
            + `<div style="background:var(--accent-soft);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:14px;text-align:center">
                <div style="font-size:24px;font-weight:var(--fw-bold);color:var(--accent)">${total ? ((calls / total) * 100).toFixed(1) : '0.0'}%</div>
                <div style="font-size:var(--fs-xs);color:var(--text-secondary);margin-top:2px">Found → call rate</div>
            </div>
            <div style="background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);padding:14px;text-align:center" title="Approved ÷ reviewed. Above 90% for 2 weeks unlocks auto-approve.">
                <div style="font-size:24px;font-weight:var(--fw-bold);color:${accColor}">${accuracy === null ? '—' : accuracy.toFixed(0) + '%'}</div>
                <div style="font-size:var(--fs-xs);color:var(--text-secondary);margin-top:2px">Agent accuracy (${reviewed.length} reviewed)</div>
            </div>`;
    }

    // Plain-English "what happens after Approve" line per contact route.
    // The [BOOKING-LINK] caveat only appears when the placeholder is genuinely
    // still there — as standing text it told Kevin to fix something that was
    // already fine on every one of the 131 drafts.
    function prosRouteProcess(route, isLtd, hasPlaceholder) {
        const fix = hasPlaceholder ? ' (replace [BOOKING-LINK] first)' : '';
        switch (route) {
            case 'Email reply (they asked)':
                return `Approve → this reply is SENT via GoHighLevel${fix} → replies land in GHL, Claude drafts responses → 7 days silent → ${isLtd ? 'two personal follow-ups (days 7 and 14), then stop' : 'one follow-up then stop (never sequenced)'}`;
            case 'Email sequence (Ltd)':
                // Personalised follow-ups, not a generic sequence — Kevin's ruling 8 Aug 2026,
                // written by the agent from this exact draft + the pain signal (skill §6b)
                return `Approve → this intro is SENT via GoHighLevel${fix} → 7 days silent → two personal follow-ups (days 7 and 14), then stop`;
            case 'LinkedIn connect':
                return 'Approve → Copy the message above → send the connect from your LinkedIn → message on accept → Claude drafts replies';
            case 'Website contact form':
                return `Approve → this message goes via their contact form → replies move to email → 7 days silent → ${isLtd ? 'two personal follow-ups (days 7 and 14), then stop' : 'stop (never sequenced)'}`;
            case 'No route yet':
                return 'Approve → you choose the personal route (e.g. a Facebook message from your account) — nothing automated';
            default:
                return '';
        }
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
            const route = prosField(r, 'Contact Route');
            const draft = prosField(r, 'Draft Message');
            const isLtd = entity === 'Limited Company';
            const entityChip = isLtd
                ? `<span style="background:var(--success-bg);color:var(--success);padding:2px 8px;border-radius:var(--radius-full);font-size:var(--fs-xs);font-weight:var(--fw-medium)">Limited Company${email ? ' · email OK' : ''}</span>`
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
                    ${route ? `<span style="background:var(--accent-soft);color:var(--accent);padding:2px 8px;border-radius:var(--radius-full);font-size:var(--fs-xs);font-weight:var(--fw-medium)">${escHtml(route)}</span>` : ''}
                    ${email ? `<span style="font-size:var(--fs-xs);color:var(--text-secondary)">${escHtml(email)} <span style="color:${confColor};font-weight:var(--fw-medium)">(${escHtml(emailConf || '?')} confidence)</span></span>` : '<span style="font-size:var(--fs-xs);color:var(--danger)">No email found</span>'}
                    ${keyword ? `<span style="font-size:var(--fs-xs);color:var(--text-muted)">matched: ${escHtml(keyword)}</span>` : ''}
                </div>
                ${draft || route ? renderProspectComposer(r, id, name, draft, route) : ''}
                ${route ? `<div style="margin-top:8px;font-size:var(--fs-xs);color:var(--text-secondary);background:var(--bg-subtle);border-radius:var(--radius-sm);padding:6px 10px"><span style="font-weight:var(--fw-semibold);color:var(--text-primary)">Process:</span> ${escHtml(prosRouteProcess(route, isLtd, draft.includes('[BOOKING-LINK]')))}</div>` : ''}
            </div>`;
        }).join('');
    }

    // ── Composer: what Kevin approves is what the prospect receives ────

    // Email routes get the full envelope (From / To / Subject / signed-off
    // body). Every other route is NOT an email — no subject line and no
    // signature is added by the send path, so showing one here would lie.
    function renderProspectComposer(rec, id, name, draft, route) {
        const isEmail = prosIsEmailRoute(route);
        const stale = draft.includes(PROS_LEGACY_BOOKING);
        const placeholder = draft.includes('[BOOKING-LINK]');
        const warn = stale
            ? `<div data-link-warning="${escHtml(id)}" style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--warning-bg);color:var(--warning);border-radius:var(--radius-sm);padding:6px 10px;font-size:var(--fs-xs)">
                    <span>This message still has the old raw booking link, which looks like spam.</span>
                    <button class="od-btn-secondary" style="padding:2px 10px;font-size:var(--fs-xs)" onclick="fixProspectBookingLink('${escHtml(id)}')">Use the website link</button>
               </div>`
            : placeholder
            ? `<div style="margin-top:8px;background:var(--warning-bg);color:var(--warning);border-radius:var(--radius-sm);padding:6px 10px;font-size:var(--fs-xs)">This message still says [BOOKING-LINK]. Replace it before approving or nothing will send.</div>`
            : '';

        const editor = `
            <div style="margin-top:12px">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px">
                    <span style="font-size:var(--fs-xs);font-weight:var(--fw-semibold);color:var(--text-secondary)">${isEmail ? 'Edit the wording' : 'Message to send (edit before approving)'}</span>
                    <button class="od-btn-secondary" style="padding:2px 10px;font-size:var(--fs-xs)" onclick="copyProspectDraft('${escHtml(id)}', this)">Copy</button>
                </div>
                <textarea data-draft-for="${escHtml(id)}" rows="5" oninput="refreshProspectPreview('${escHtml(id)}')" aria-label="Message for ${escHtml(name)}" style="width:100%;padding:8px 10px;border:1px solid var(--border-default);border-radius:var(--radius-md);font-size:var(--fs-sm);font-family:var(--font-family-base);background:var(--bg-surface-2);color:var(--text-primary);resize:vertical">${escHtml(draft)}</textarea>
            </div>`;

        if (!isEmail) return warn + editor;

        const email = buildProspectEmail(rec);
        const to = email.to
            ? `${escHtml(email.toName || 'Unknown')} &lt;${escHtml(email.to)}&gt;`
            : `<span style="color:var(--danger)">no email address found — this cannot send</span>`;
        const label = 'font-size:var(--fs-xs);color:var(--text-muted);font-weight:var(--fw-medium)';
        const value = 'font-size:var(--fs-xs);color:var(--text-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

        return `
            <div style="margin-top:12px">
                <div style="font-size:var(--fs-xs);font-weight:var(--fw-semibold);color:var(--text-secondary);margin-bottom:4px">Exactly what lands in their inbox</div>
                <div style="border:1px solid var(--border-default);border-radius:var(--radius-lg);overflow:hidden">
                    <div style="background:var(--bg-subtle);padding:10px 12px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 10px;align-items:center">
                        <span style="${label}">From</span><span style="${value}">${escHtml(email.fromName)} &lt;${escHtml(email.from)}&gt;</span>
                        <span style="${label}">To</span><span style="${value}">${to}</span>
                        <span style="${label}">Subject</span>
                        <input type="text" data-subject-for="${escHtml(id)}" value="${escHtml(prosField(rec, 'Email Subject'))}" placeholder="${escHtml(prospectDefaultSubject(rec))}" oninput="refreshProspectPreview('${escHtml(id)}')" aria-label="Email subject for ${escHtml(name)}" style="width:100%;padding:4px 8px;border:1px solid var(--border-default);border-radius:var(--radius-sm);font-size:var(--fs-xs);font-family:var(--font-family-base);background:var(--bg-surface);color:var(--text-primary)">
                    </div>
                    <div data-email-preview="${escHtml(id)}" style="background:var(--bg-surface);padding:16px;font-size:var(--fs-sm);line-height:1.6;color:var(--text-primary);word-break:break-word">${email.html}</div>
                </div>
            </div>
            ${warn}
            ${editor}`;
    }

    // Re-renders the preview from the UNSAVED field values as Kevin types, so
    // the envelope never lags behind the wording he is looking at.
    function refreshProspectPreview(recordId) {
        const ta = document.querySelector(`textarea[data-draft-for="${recordId}"]`);
        // The stale-link warning exists on every route, the envelope only on
        // email routes, so clear the warning before the email-only early exit.
        const warning = document.querySelector(`[data-link-warning="${recordId}"]`);
        if (warning && ta && !ta.value.includes(PROS_LEGACY_BOOKING)) warning.remove();
        const host = document.querySelector(`[data-email-preview="${recordId}"]`);
        const rec = (prospectsCache || []).find(r => r.id === recordId);
        if (!host || !rec) return;
        const si = document.querySelector(`input[data-subject-for="${recordId}"]`);
        host.innerHTML = buildProspectEmail(rec, {
            draft: ta ? ta.value : undefined,
            subject: si ? si.value : undefined,
        }).html;
    }

    // Swaps the raw CRM widget URL for the public booking page. Same calendar,
    // so the prospect's experience is unchanged; only the link they see differs.
    function fixProspectBookingLink(recordId) {
        const ta = document.querySelector(`textarea[data-draft-for="${recordId}"]`);
        if (!ta) return;
        ta.value = ta.value.replace(/https?:\/\/api\.leadconnectorhq\.com\/widget\/booking\/\S+/g, OD_BOOKING_URL);
        refreshProspectPreview(recordId);
        if (typeof showToast === 'function') showToast('Link swapped. It saves when you approve.', { type: 'info', duration: 4000 });
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

    async function approveProspect(recordId) {
        // Persist edits FIRST so what sends is exactly what Kevin saw. Subject
        // and body are saved together: sending an edited body under the old
        // subject is the same drift the single builder exists to prevent.
        const rec = (prospectsCache || []).find(r => r.id === recordId);
        const ta = document.querySelector(`textarea[data-draft-for="${recordId}"]`);
        const si = document.querySelector(`input[data-subject-for="${recordId}"]`);
        if (rec) {
            const fields = {};
            if (ta && ta.value !== (rec.fields['Draft Message'] || '')) fields[PROSPECT.draftMessage] = ta.value;
            if (si && si.value.trim() !== (rec.fields['Email Subject'] || '')) fields[PROSPECT.emailSubject] = si.value.trim();
            if (Object.keys(fields).length) {
                try {
                    await patchProspectingRecord(TABLES.prospects, recordId, fields);
                    if (fields[PROSPECT.draftMessage] !== undefined) rec.fields['Draft Message'] = ta.value;
                    if (fields[PROSPECT.emailSubject] !== undefined) rec.fields['Email Subject'] = si.value.trim();
                } catch (e) { console.warn('Edit save failed (continuing with approval):', e); }
            }
        }
        await _prosChangeStatus(recordId, 'Approved', 'approved');
        attemptGHLSync(recordId);
    }
    function rejectProspect(recordId) { _prosChangeStatus(recordId, 'Rejected', 'rejected'); }

    // Direct GHL sync on approval, using the same Private Integration token the
    // Inbound Comms module stores in this browser (localStorage ghl_api_key /
    // ghl_location_id). Ltd + email prospects only — manual-track prospects are
    // never auto-synced. Any failure falls back to the daily agent's sync pass.
    async function attemptGHLSync(recordId) {
        const rec = (prospectsCache || []).find(r => r.id === recordId);
        if (!rec) return;
        const email = prosField(rec, 'Contact Email');
        const isLtd = prosField(rec, 'Entity Type') === 'Limited Company';
        if (!email) return;
        // Dedicated OD Prospecting credentials. IMPORTANT: prospects live in the
        // "Operations Director" GHL sub-account (dgsH…9ik), NOT the Runpreneur one
        // that Inbound Comms' shared ghl_location_id points at — never fall back
        // to the shared location or contacts land in the wrong business.
        const ghlKey = localStorage.getItem('od_prospecting_ghl_key') || localStorage.getItem('ghl_api_key');
        const ghlLoc = localStorage.getItem('od_prospecting_ghl_location');
        if (!ghlKey || !ghlLoc) {
            if (typeof showToast === 'function') showToast('Approved. GHL keys not set in this browser (Inbound Comms → Settings) — the daily agent will sync it instead', { type: 'info', duration: 6000 });
            return;
        }
        try {
            // Conversation-first: contacts land in GHL as CRM records only. The
            // od-prospect-nurture tag (which fires the email sequence) is applied
            // later by the agent's follow-up pass, Ltd companies only, after 7
            // silent days. Manual-track contacts are tagged so they can NEVER
            // be swept into an email workflow.
            const tags = isLtd ? ['od-prospect'] : ['od-prospect', 'od-prospect-manual'];
            const resp = await fetch('https://services.leadconnectorhq.com/contacts/', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${ghlKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: prosField(rec, 'Name'),
                    email,
                    companyName: prosField(rec, 'Company'),
                    locationId: ghlLoc,
                    source: 'od-prospecting',
                    tags,
                }),
            });
            const data = await resp.json().catch(() => ({}));
            let contactId = data && data.contact && data.contact.id;
            // GHL answers 400 with meta.contactId when the contact already exists — reuse it
            if (!contactId && data && data.meta && data.meta.contactId) contactId = data.meta.contactId;
            if (!contactId) throw new Error('GHL HTTP ' + resp.status);
            await patchProspectingRecord(TABLES.prospects, recordId, { [PROSPECT.ghlId]: contactId, [PROSPECT.status]: 'Synced to GHL' });
            rec.fields['GHL Contact ID'] = contactId;
            rec.fields['Status'] = 'Synced to GHL';
            renderProspectingTab();
            if (typeof showToast === 'function') showToast('Synced to GoHighLevel as a contact', { type: 'success' });
            // Gold standard: approve = message sent, all from this page.
            await sendProspectEmailViaGHL(rec, contactId, ghlKey, ghlLoc);
        } catch (e) {
            console.warn('Direct GHL sync failed (daily agent will retry):', e);
            if (typeof showToast === 'function') showToast('Approved. Direct GHL sync failed — the daily agent will sync it instead', { type: 'warning', duration: 6000 });
        }
    }

    // Send the approved opening message as an email through GoHighLevel so the
    // whole conversation lives in GHL (kept out of the team-managed Gmail inbox).
    // Only fires for email routes with a real draft; refuses to send while the
    // [BOOKING-LINK] placeholder is still in the text.
    async function sendProspectEmailViaGHL(rec, contactId, ghlKey, ghlLoc) {
        const route = prosField(rec, 'Contact Route');
        if (!prosIsEmailRoute(route)) return;
        // PECR hard rule, enforced HERE and not only upstream (finding
        // 20260812-drift-095). Until 12 Aug 2026 Entity Type was read exactly
        // once in this file — to pick a GHL tag — and the send path never
        // looked at it. The only abort was a missing email address. So a Sole
        // Trader or Unknown record that the agent had labelled Contact Route
        // "Email sequence (Ltd)" got cold-emailed from this page, and the gate
        // the SOP calls a hard rule was a field the agent wrote about itself.
        // Contact Route is an opinion; this is the check.
        // "Email reply (they asked)" is exempt BY DESIGN (skill §4.5, Kevin 14
        // Jul 2026): those prospects publicly asked for help, so replying is
        // solicited correspondence, not unsolicited marketing — any entity
        // type. The Ltd gate below protects the cold route only.
        const entity = prosField(rec, 'Entity Type');
        if (route !== 'Email reply (they asked)' && entity !== 'Limited Company') {
            if (typeof showToast === 'function') showToast(`Not emailed: entity type is ${entity || 'unknown'}. An unsolicited email is only lawful to a Limited Company — the contact is synced, so message them personally on LinkedIn instead.`, { type: 'warning', duration: 9000 });
            return;
        }
        const draft = prosField(rec, 'Draft Message');
        if (!draft) return;
        if (draft.includes('[BOOKING-LINK]')) {
            if (typeof showToast === 'function') showToast('Not sent yet: replace [BOOKING-LINK] in the message with your booking URL, then approve again', { type: 'warning', duration: 8000 });
            return;
        }
        // Same builder that produced the preview Kevin just approved.
        const email = buildProspectEmail(rec);

        // The send and the bookkeeping fail for DIFFERENT reasons and need
        // different messages. On 12 Aug 2026 one catch wrapped both: 18 emails
        // sent perfectly, then the status write 422'd (missing select option),
        // and the toast blamed the send — inviting a re-approve and leaving the
        // records in the exact status the daily agent re-sends. An email that
        // went out but was recorded as unsent is a DOUBLE-SEND waiting to
        // happen; an email that failed but was recorded as sent is a lost
        // prospect. Never let one message describe both.
        try {
            const resp = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${ghlKey}`, 'Version': '2021-04-15', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type: 'Email',
                    contactId,
                    subject: email.subject,
                    html: email.html,
                    // Required: without an explicit from, the OD location returns a 500
                    emailFrom: email.from,
                }),
            });
            if (!resp.ok) throw new Error('GHL send HTTP ' + resp.status);
        } catch (e) {
            console.warn('GHL email send failed (contact is synced; agent will handle the send):', e);
            if (typeof showToast === 'function') showToast('Contact synced, but the GHL email send failed — the daily agent will send it instead', { type: 'warning', duration: 7000 });
            return;
        }

        // The email is now genuinely out. Record it, retrying once, and if the
        // record still cannot be updated say EXACTLY that — the send worked.
        const followUp = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
        const fields = { [PROSPECT.status]: 'Contacted (1:1)', [PROSPECT.nextFollowUp]: followUp };
        try {
            try {
                await patchProspectingRecord(TABLES.prospects, rec.id, fields);
            } catch (first) {
                await new Promise(r => setTimeout(r, 800));
                await patchProspectingRecord(TABLES.prospects, rec.id, fields);
            }
            rec.fields['Status'] = 'Contacted (1:1)';
            rec.fields['Next Follow-up'] = followUp;
            renderProspectingTab();
            if (typeof showToast === 'function') showToast('Email sent via GoHighLevel — follow-up check in 7 days', { type: 'success', duration: 6000 });
        } catch (e) {
            console.warn('Email SENT but the status update failed:', e);
            if (typeof showToast === 'function') showToast(`The email WAS sent. The record could not be marked Contacted (${(e && e.message) || 'unknown error'}) — do not approve this prospect again; the daily agent repairs the status on its next run`, { type: 'warning', duration: 10000 });
        }
    }

    function copyProspectDraft(recordId, btn) {
        const ta = document.querySelector(`textarea[data-draft-for="${recordId}"]`);
        if (!ta || !ta.value) { if (typeof showToast === 'function') showToast('No draft to copy yet', { type: 'warning' }); return; }
        // Email routes copy the signed-off version; LinkedIn/contact-form
        // routes copy the raw text, because no signature is added to those.
        const rec = (prospectsCache || []).find(r => r.id === recordId);
        const text = rec && prosIsEmailRoute(prosField(rec, 'Contact Route'))
            ? buildProspectEmail(rec, { draft: ta.value }).text
            : ta.value;
        navigator.clipboard.writeText(text).then(() => {
            if (btn) { const t = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = t; }, 2000); }
        }).catch(() => {
            // Fallback copies the SAME text, not the raw textarea — otherwise a
            // clipboard-permission failure silently yields an unsigned message.
            const tmp = document.createElement('textarea');
            tmp.value = text;
            tmp.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(tmp);
            tmp.select();
            document.execCommand('copy');
            tmp.remove();
        });
    }

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

        const statuses = ['All', 'Ready for Review', 'Approved', 'Synced to GHL', 'Contacted (1:1)', 'Connect Sent', 'In Sequence', 'Replied', 'Call Booked', 'No Response', 'Rejected', 'Suppressed'];
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
                : ['Rejected', 'Suppressed', 'No Response'].includes(status) ? 'var(--text-muted)'
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
                    // Finding 20260812-drift-096. This inspected 'In Sequence'
                    // and 'Replied' only — and NOTHING in this file has ever
                    // written 'In Sequence'. The send path writes 'Contacted
                    // (1:1)'. So a non-Ltd prospect emailed at approve time
                    // could never be seen, and the red alert the SOP relies on
                    // passed for the wrong reason, indefinitely.
                    //
                    // 'Connect Sent' is deliberately NOT a breach status: it is
                    // a LinkedIn connection, which PECR does not govern, and
                    // flagging lawful manual outreach to a sole trader is how a
                    // check earns a reputation for crying wolf and gets ignored.
                    // The downstream statuses can follow either channel, so they
                    // warn rather than fail.
                    name: 'PECR gate: only Limited Companies emailed', kind: 'automation', run: () => {
                        const EMAILED = ['Contacted (1:1)', 'In Sequence'];
                        const DOWNSTREAM = ['Replied', 'No Response', 'Call Booked'];
                        const PRE_CONTACT = ['Ready for Review', 'Approved', 'Rejected', 'Suppressed'];
                        const notLtd = r => prosField(r, 'Entity Type') !== 'Limited Company';
                        const inspected = records.filter(r => EMAILED.concat(DOWNSTREAM, ['Connect Sent']).includes(prosStatus(r)));

                        // Control. A status list that matches nothing reads as a
                        // clean pass for ever, which is exactly how the old list
                        // survived. Never report a green gate off zero records.
                        if (!inspected.length) {
                            const past = records.filter(r => !PRE_CONTACT.includes(prosStatus(r)));
                            if (past.length) return { status: 'fail', detail: `${past.length} prospect(s) are past Approved but match none of the statuses this check inspects — the gate is blind, not clean` };
                            return { status: 'warn', detail: 'Nobody has been contacted yet, so this gate has never been exercised' };
                        }

                        const breach = records.filter(r => EMAILED.includes(prosStatus(r)) && notLtd(r));
                        if (breach.length) return { status: 'fail', detail: `${breach.length} non-Ltd prospect(s) have been emailed — PECR breach risk, stop and check them` };
                        const unclear = records.filter(r => DOWNSTREAM.includes(prosStatus(r)) && notLtd(r));
                        if (unclear.length) return { status: 'warn', detail: `${unclear.length} non-Ltd prospect(s) sit past first contact — check they were reached on LinkedIn, not by email` };
                        return { status: 'pass', detail: `All ${inspected.length} contacted prospect(s) are Limited Companies` };
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
