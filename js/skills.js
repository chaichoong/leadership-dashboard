// ══════════════════════════════════════════
// SKILLS LIBRARY — Browse, search, and filter all Claude Code / Cowork skills
// ══════════════════════════════════════════

(function () {
    'use strict';

    let _skillsRendered = false;
    let _activeCategory = null;
    let _searchTerm = '';
    let _sourceFilter = 'mine'; // 'mine' (custom + SOP), 'active' (mine + used presets), 'presets' (preset only), 'all' (everything)
    let _sopSkills = [];
    let _sopSkillsFetched = false;
    let _sopFetchFailed = false;
    let _activePresetIds = [];
    let _activePresetsFetched = false;

    // Strip namespace prefix from commands for display (e.g. "anthropic-skills:skill-name" -> "skill-name")
    function displayCommand(cmd) {
        if (!cmd) return '';
        const i = cmd.indexOf(':');
        return i > -1 ? cmd.substring(i + 1) : cmd;
    }
    const SETTINGS_TABLE = 'tblHGNzDmOs59r9QD';
    const SETTINGS_RECORD = 'recqbcIz2R2griDn3';
    const ACTIVE_SKILLS_FIELD = 'Active Skill IDs';

    // No `fields[]` on this URL, and no switching to the list endpoint. Two reasons:
    //   1. Airtable's single-record GET rejects fields[] with a 422 (only the list
    //      endpoint accepts it). That 422 silently broke this fetch until 17 Jul 2026.
    //   2. SETTINGS_TABLE keys rows by Name, and another row ('PROXY_SERVICE_TOKEN',
    //      read by scripts/monthly-valuations.py) holds a live service token in this
    //      same field. The list endpoint would pull that secret into the browser.
    // A single-record GET returns only SETTINGS_RECORD, so the token can never reach here.
    async function fetchActivePresets() {
        if (_activePresetsFetched || typeof PAT === 'undefined' || !PAT) return;
        try {
            const url = `https://api.airtable.com/v0/${BASE_ID}/${SETTINGS_TABLE}/${SETTINGS_RECORD}`;
            const res = await fetch(url, { headers: { Authorization: 'Bearer ' + PAT } });
            if (!res.ok) {
                console.warn('Skills: active presets fetch failed —', res.status, res.statusText);
                return;
            }
            const data = await res.json();
            const raw = (data.fields || {})[ACTIVE_SKILLS_FIELD];
            if (raw) {
                try { _activePresetIds = JSON.parse(raw); } catch (e) { _activePresetIds = []; }
            }
            _activePresetsFetched = true;
        } catch (e) {
            console.warn('Skills: failed to fetch active presets from Airtable', e);
        }
    }

    async function saveActivePreset(skillId) {
        if (typeof PAT === 'undefined' || !PAT) return;
        if (_activePresetIds.includes(skillId)) return;
        _activePresetIds.push(skillId);
        try {
            const f = {}; f[ACTIVE_SKILLS_FIELD] = JSON.stringify(_activePresetIds);
            await fetch(`https://api.airtable.com/v0/${BASE_ID}/${SETTINGS_TABLE}/${SETTINGS_RECORD}`, {
                method: 'PATCH',
                headers: { Authorization: 'Bearer ' + PAT, 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: f })
            });
        } catch (e) {
            console.warn('Skills: failed to save active preset', skillId, e);
        }
    }

    // One-time non-blocking notice when SOP skills can't be fetched from Airtable.
    // Shown once per failure (not per catch), cleared on the next successful fetch.
    let _sopNoticeShown = false;
    function showSOPSkillsNotice() {
        if (_sopNoticeShown) return;
        const anchor = document.getElementById('skillsLibraryContent');
        if (!anchor || !anchor.parentNode) return;
        _sopNoticeShown = true;
        const notice = document.createElement('div');
        notice.id = 'skillsSopNotice';
        notice.style.cssText = 'background:var(--warning-bg,#FBF3E4);border:1px solid var(--warning,#B8933A);border-radius:var(--radius-md,8px);padding:10px 14px;margin-bottom:12px;font-size:13px;color:var(--text-primary,#1C2422)';
        notice.textContent = 'Couldn’t load SOP skills — showing local presets';
        anchor.parentNode.insertBefore(notice, anchor);
    }
    function clearSOPSkillsNotice() {
        _sopNoticeShown = false;
        const el = document.getElementById('skillsSopNotice');
        if (el) el.remove();
    }

    async function fetchSOPSkills() {
        if (_sopSkillsFetched || typeof PAT === 'undefined' || !PAT) return;
        try {
            const tableId = 'tblLPoRHFBl0vqR24';
            const skillFieldName = 'Skill Definition';
            const driveFieldName = 'Drive URL';
            const sopFieldName = 'SOP Document';
            // Encode the formula explicitly — relying on the browser to normalise
            // spaces/quotes inside filterByFormula is what made this fetch fragile.
            const baseUrl = `https://api.airtable.com/v0/${BASE_ID}/${tableId}?fields[]=${encodeURIComponent(skillFieldName)}&fields[]=${encodeURIComponent(driveFieldName)}&fields[]=${encodeURIComponent(sopFieldName)}&filterByFormula=${encodeURIComponent(`NOT({${skillFieldName}}='')`)}`;
            const skills = [];
            let offset = '';
            do {
                const pageUrl = offset ? `${baseUrl}&offset=${encodeURIComponent(offset)}` : baseUrl;
                const res = await fetch(pageUrl, { headers: { Authorization: `Bearer ${PAT}` } });
                if (!res.ok) {
                    console.warn('Skills: SOP skills fetch returned HTTP', res.status);
                    _sopFetchFailed = true;
                    showSOPSkillsNotice();
                    break;
                }
                const data = await res.json();
                (data.records || []).forEach(r => {
                    const raw = r.fields[skillFieldName];
                    if (!raw) return;
                    const driveUrl = r.fields[driveFieldName] || '';
                    // Workflows that run as AI AGENTS get their own section — record the state.
                    try {
                        const sop = JSON.parse(r.fields[sopFieldName] || 'null');
                        if (sop && sop.disposition && sop.disposition.type === 'agent') {
                            _agentByWf[r.id] = { state: (sop.agent && sop.agent.state) || 'draft' };
                        }
                    } catch (e) { /* no SOP JSON — not an agent */ }
                    try {
                        const parsed = JSON.parse(raw);
                        const arr = Array.isArray(parsed) ? parsed : [parsed];
                        arr.forEach(sk => {
                            if (sk && sk.id && sk.name) {
                                sk.source = sk.source || 'sop';
                                if (driveUrl && !sk.driveUrl) sk.driveUrl = driveUrl;
                                if (!SKILLS_LIBRARY.some(s => s.id === sk.id)) skills.push(sk);
                            }
                        });
                    } catch (e) {
                        console.warn('Skills: could not parse Skill Definition on record', r.id, e);
                    }
                });
                offset = data.offset || '';
            } while (offset);
            _sopSkills = skills;
            _sopSkillsFetched = true;
            if (!_sopFetchFailed) clearSOPSkillsNotice();
        } catch (e) {
            console.warn('Skills: SOP skills fetch failed', e);
            _sopFetchFailed = true;
            showSOPSkillsNotice();
        }
        // A transient failure (rate limit, blip) used to stick as a permanent
        // banner. Retry once, quietly, and re-render if it comes good.
        if (_sopFetchFailed && !_sopRetryScheduled) {
            _sopRetryScheduled = true;
            setTimeout(async () => {
                _sopFetchFailed = false;
                await fetchSOPSkills();
                if (!_sopFetchFailed && typeof renderSkillsLibrary === 'function') renderSkillsLibrary();
            }, 2500);
        }
    }
    let _sopRetryScheduled = false;

    function allSkills() {
        return SKILLS_LIBRARY.concat(_sopSkills);
    }
    window.allSkills = allSkills;

    // ── Agents vs Skills: the library is the CATALOGUE, the AI Agents tab in
    // Systemisation is the OPERATIONS room. Agent-workflow skills get their own
    // section up top with the agent's state and a Manage button that deep-links
    // through (localStorage handoff — the Systemisation iframe consumes it).
    let _agentByWf = {};

    const AGENT_STATE_META = {
        live:    { label: 'LIVE',    bg: 'var(--success-bg)', fg: 'var(--success)' },
        testing: { label: 'TESTING', bg: 'var(--warning-bg)', fg: 'var(--warning)' },
        off:     { label: 'PAUSED',  bg: 'var(--bg-subtle)',  fg: 'var(--text-muted)' },
        draft:   { label: 'DRAFT',   bg: 'var(--bg-subtle)',  fg: 'var(--text-muted)' },
    };

    function openAgentInSystemisation(wfId) {
        localStorage.setItem('sys_open_agent', wfId);
        if (typeof switchTab === 'function') switchTab('systemisation');
    }
    window.openAgentInSystemisation = openAgentInSystemisation;

    function renderSkillsLibrary() {
        const container = document.getElementById('skillsLibraryContent');
        if (!container) return;

        const all = allSkills();
        const filtered = all.filter(s => {
            // Source filter
            const isCustomOrSop = s.source === 'custom' || s.source === 'sop' || s.source === 'project' || s.source === 'scheduled';
            if (_sourceFilter === 'mine' && !isCustomOrSop) return false;
            if (_sourceFilter === 'active') {
                // My skills + any preset that has been run
                if (!isCustomOrSop && !_activePresetIds.includes(s.id)) return false;
            }
            if (_sourceFilter === 'presets' && s.source !== 'preset' && s.source !== 'system') return false;
            // 'all' shows everything
            if (_activeCategory && s.category !== _activeCategory) return false;
            if (_searchTerm) {
                const q = _searchTerm.toLowerCase();
                return s.name.toLowerCase().includes(q) ||
                       s.description.toLowerCase().includes(q) ||
                       s.command.toLowerCase().includes(q) ||
                       (s.tags || []).some(t => t.toLowerCase().includes(q)) ||
                       s.category.toLowerCase().includes(q);
            }
            return true;
        });

        // Agents are workers, skills are tools: agent-workflow entries get their
        // own section on top; everything else stays in the category catalogue.
        const agentSkills = filtered.filter(s => s.workflowId && _agentByWf[s.workflowId]);
        const restSkills = filtered.filter(s => !(s.workflowId && _agentByWf[s.workflowId]));

        const grouped = {};
        SKILLS_CATEGORIES.forEach(cat => { grouped[cat] = []; });
        restSkills.forEach(s => {
            if (!grouped[s.category]) grouped[s.category] = [];
            grouped[s.category].push(s);
        });

        const countEl = document.getElementById('skillsTotalCount');
        if (countEl) countEl.textContent = filtered.length + ' of ' + all.length + ' skills';

        let html = '';
        if (agentSkills.length) {
            html += `<div class="skills-category-group">
                <div class="skills-category-header">
                    <span class="skills-category-icon">&#x26A1;</span>
                    <span class="skills-category-name">AI Agents &mdash; autonomous workers</span>
                    <span class="skills-category-count">${agentSkills.length}</span>
                </div>
                <div class="skills-grid">`;
            agentSkills.forEach(s => {
                const st = _agentByWf[s.workflowId] || {};
                const meta = AGENT_STATE_META[st.state] || AGENT_STATE_META.draft;
                html += `<div class="skills-card" data-skill-id="${escHtml(s.id)}">
                    <div class="skills-card-header">
                        <div class="skills-card-title">${escHtml(s.name)}</div>
                        <span style="font-size:11px;font-weight:700;letter-spacing:.5px;padding:3px 10px;border-radius:999px;background:${meta.bg};color:${meta.fg}">${meta.label}</span>
                    </div>
                    <div class="skills-card-desc">${escHtml(s.description)}</div>
                    <div class="skills-card-actions" style="padding:8px 16px 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                        <button class="skills-run-btn" onclick="openAgentInSystemisation('${escJs(s.workflowId)}')" style="padding:6px 14px;border:none;border-radius:var(--radius-sm,4px);background:var(--accent,#2C6E49);color:#fff;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">&#x26A1; Manage in AI Agents</button>
                        <button onclick="runSkill('${escJs(s.id)}')" style="padding:6px 14px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);color:var(--text-primary,#1C2422);cursor:pointer;font-size:12px;font-family:inherit">Open as chat guide</button>
                    </div>
                </div>`;
            });
            html += '</div></div>';
        }
        SKILLS_CATEGORIES.forEach(cat => {
            const skills = grouped[cat];
            if (!skills || skills.length === 0) return;

            html += `<div class="skills-category-group">
                <div class="skills-category-header">
                    <span class="skills-category-icon">${getCategoryIcon(cat)}</span>
                    <span class="skills-category-name">${escHtml(cat)}</span>
                    <span class="skills-category-count">${skills.length}</span>
                </div>
                <div class="skills-grid">`;

            skills.forEach(s => {
                const sourceBadge = SKILLS_SOURCE_LABELS[s.source] || s.source;
                const sourceClass = 'skills-source-' + s.source;
                const hasDrive = s.driveUrl || s.driveDocUrl;
                html += `<div class="skills-card" data-skill-id="${escHtml(s.id)}">
                    <div class="skills-card-header" onclick="toggleSkillDetail('${escJs(s.id)}')" role="button" tabindex="0" aria-expanded="false"
                         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleSkillDetail('${escJs(s.id)}')}">
                        <div class="skills-card-title">${escHtml(s.name)}</div>
                        <div style="display:flex;align-items:center;gap:8px">
                            <span class="skills-source-badge ${sourceClass}">${escHtml(sourceBadge)}</span>
                            <span class="skills-chevron" style="font-size:12px;color:var(--text-muted,#8A928C);transition:transform 0.2s">&#x25BC;</span>
                        </div>
                    </div>
                    <div class="skills-card-desc">${escHtml(s.description)}</div>
                    <div class="skills-card-actions" style="padding:8px 16px 4px;display:flex;gap:8px;align-items:center">
                        <button class="skills-run-btn" onclick="event.stopPropagation();runSkill('${escJs(s.id)}')" style="padding:6px 14px;border:none;border-radius:var(--radius-sm,4px);background:var(--accent,#2C6E49);color:#fff;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;display:flex;align-items:center;gap:4px">&#x25B6; Run Skill</button>
                        ${hasDrive ? `<a href="${escHtml(s.driveUrl || s.driveDocUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="padding:6px 10px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);color:var(--text-secondary,#5A6660);cursor:pointer;font-size:12px;font-family:inherit;text-decoration:none;display:flex;align-items:center;gap:4px">&#x1F4C2; Drive Folder</a>` : ''}
                    </div>
                    <div class="skills-card-detail" id="skill-detail-${escHtml(s.id)}" style="display:none">
                        <div class="skills-detail-row">
                            <span class="skills-detail-label">Command</span>
                            <code class="skills-detail-value">/${escHtml(displayCommand(s.command))}</code>
                        </div>
                        <div class="skills-detail-row">
                            <span class="skills-detail-label">Category</span>
                            <span class="skills-detail-value">${escHtml(s.category)}</span>
                        </div>
                        <div class="skills-detail-row">
                            <span class="skills-detail-label">Source</span>
                            <span class="skills-detail-value">${escHtml(SKILLS_SOURCE_LABELS[s.source] || s.source)}</span>
                        </div>
                        ${s.tags && s.tags.length ? `<div class="skills-detail-row">
                            <span class="skills-detail-label">Tags</span>
                            <span class="skills-detail-value skills-tags">${s.tags.map(t => '<span class="skills-tag">' + escHtml(t) + '</span>').join('')}</span>
                        </div>` : ''}
                        ${s.instructions ? `<div class="skills-detail-row" style="flex-direction:column;align-items:stretch">
                            <span class="skills-detail-label" style="margin-bottom:6px">Instructions <button onclick="event.stopPropagation();openSkillDetail('${escJs(s.id)}')" style="margin-left:8px;padding:2px 8px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);color:var(--accent,#2C6E49);cursor:pointer;font-size:11px;font-family:inherit">View Full</button></span>
                            <div class="skills-detail-value" style="max-height:120px;overflow-y:auto;white-space:pre-wrap;font-size:12px;line-height:1.5;background:var(--bg-surface-2,#F4F6F1);padding:10px 12px;border-radius:var(--radius-sm,4px);border:1px solid var(--border-subtle,#E5E8E1)">${escHtml(s.instructions)}</div>
                        </div>` : ''}
                        ${!s.instructions ? `<div style="padding:4px 0"><button onclick="event.stopPropagation();openSkillDetail('${escJs(s.id)}')" style="padding:4px 12px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);color:var(--accent,#2C6E49);cursor:pointer;font-size:12px;font-family:inherit">View Full Details</button></div>` : ''}
                    </div>
                </div>`;
            });

            html += '</div></div>';
        });

        if (filtered.length === 0) {
            html = `<div class="skills-empty">
                <div style="font-size:32px;margin-bottom:12px">&#x1F50D;</div>
                <div style="font-weight:600;margin-bottom:4px">No skills match your search</div>
                <div style="color:var(--text-muted);font-size:13px">Try a different keyword or clear your filters</div>
            </div>`;
        }

        container.innerHTML = html;
        _skillsRendered = true;
    }

    function getCategoryIcon(cat) {
        const icons = {
            'Property Management': '&#x1F3E0;',
            'Finance': '&#x1F4B0;',
            'Operations': '&#x1F3E2;',
            'Legal': '&#x2696;&#xFE0F;',
            'Data & Analytics': '&#x1F4CA;',
            'Customer Support': '&#x1F4AC;',
            'Productivity': '&#x23F0;',
            'Documents & Media': '&#x1F4C4;',
            'Automation': '&#x2699;&#xFE0F;',
            'Development': '&#x1F6E0;&#xFE0F;',
        };
        return icons[cat] || '&#x1F4E6;';
    }

    const SKILL_PROXY = 'https://claude-proxy.kevinbrittain.workers.dev';
    let _skillConversation = [];
    let _skillBusy = false;

    function buildSkillSystem(skill) {
        const instructions = skill.instructions || skill.description || '';
        return 'You are an AI assistant running the "' + skill.name + '" skill inside a web dashboard chat window.\n\n'
            + 'CRITICAL CONSTRAINTS:\n'
            + '- You are running in a browser chat. You have NO access to a file system, terminal, bash, Python, or any tools.\n'
            + '- NEVER pretend to run commands, scripts, or code. NEVER show bash/python code blocks as if you are executing them.\n'
            + '- NEVER claim files have been saved or generated somewhere. You cannot create files.\n'
            + '- If the skill would normally produce a document (agreement, report, letter, plan), you MUST generate the FULL document text directly in your response so the user can copy it.\n'
            + '- If the skill needs information from the user, ask clearly and concisely. When the user provides it, proceed immediately.\n'
            + '- Be direct. Do not explain what you would do. Just do it.\n\n'
            + 'SKILL INSTRUCTIONS:\n' + instructions;
    }

    window.runSkill = async function (id) {
        const skill = allSkills().find(s => s.id === id);
        if (!skill) { showToast('Skill not found', { type: 'warning' }); return; }

        if (skill.source !== 'sop' && skill.source !== 'custom') saveActivePreset(id);

        if (skill.driveUrl) window.open(skill.driveUrl, '_blank', 'noopener');

        _skillConversation = [];
        showSkillRunModal(skill);

        await sendSkillMessage(skill, buildSkillSystem(skill), 'Run this skill now.');
    };

    window.sendSkillReply = async function () {
        const input = document.getElementById('skill-chat-input');
        if (!input || !input.value.trim() || _skillBusy) return;
        const text = input.value.trim();
        input.value = '';

        const skillId = document.getElementById('skill-run-modal')?.dataset?.skillId;
        const skill = skillId ? allSkills().find(s => s.id === skillId) : null;
        if (!skill) return;

        appendSkillBubble('user', text);
        await sendSkillMessage(skill, buildSkillSystem(skill), text);
    };

    async function sendSkillMessage(skill, systemMsg, userText) {
        _skillBusy = true;
        _skillConversation.push({ role: 'user', content: userText });

        const chatEl = document.getElementById('skill-chat-messages');
        const inputArea = document.getElementById('skill-chat-area');
        if (inputArea) inputArea.style.display = 'none';

        const loadingEl = document.createElement('div');
        loadingEl.className = 'skill-msg-loading';
        loadingEl.style.cssText = 'padding:12px 0;text-align:center';
        loadingEl.innerHTML = '<div style="display:inline-block;width:20px;height:20px;border:2px solid var(--border-default,#DDE1D9);border-top-color:var(--accent,#2C6E49);border-radius:50%;animation:spin 1s linear infinite"></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
        if (chatEl) { chatEl.appendChild(loadingEl); chatEl.scrollTop = chatEl.scrollHeight; }

        try {
            const res = await fetch(SKILL_PROXY, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: AI_MODEL_DEFAULT,
                    max_tokens: 4096,
                    system: systemMsg,
                    messages: _skillConversation,
                }),
            });

            if (!res.ok) throw new Error('AI returned ' + res.status);
            const data = await res.json();
            const text = data.content?.[0]?.text || 'No response received.';
            _skillConversation.push({ role: 'assistant', content: text });

            loadingEl.remove();
            appendSkillBubble('assistant', text);
        } catch (e) {
            loadingEl.remove();
            appendSkillBubble('assistant', 'Error: ' + e.message);
        }

        if (inputArea) inputArea.style.display = 'flex';
        _skillBusy = false;
        const input = document.getElementById('skill-chat-input');
        if (input) input.focus();
    }

    function appendSkillBubble(role, text) {
        const chatEl = document.getElementById('skill-chat-messages');
        if (!chatEl) return;
        const div = document.createElement('div');
        div.style.cssText = role === 'user'
            ? 'padding:8px 14px;background:var(--accent-soft,#DDE8DF);border-radius:var(--radius-md,8px);margin-bottom:8px;font-size:13px;line-height:1.6;align-self:flex-end;max-width:85%'
            : 'padding:10px 14px;background:var(--bg-surface-2,#F4F6F1);border-radius:var(--radius-md,8px);border:1px solid var(--border-subtle,#E5E8E1);margin-bottom:8px;font-size:13px;line-height:1.7;max-width:95%';
        div.innerHTML = role === 'user' ? escHtml(text) : renderSkillMarkdown(text);
        if (role === 'assistant' && text.length > 200) {
            const copyBtn = document.createElement('button');
            copyBtn.textContent = 'Copy Response';
            copyBtn.style.cssText = 'margin-top:8px;padding:4px 12px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);color:var(--text-secondary,#5A6660);cursor:pointer;font-size:11px;font-family:inherit';
            copyBtn.onclick = function() { navigator.clipboard.writeText(text).then(function() { copyBtn.textContent = 'Copied'; setTimeout(function() { copyBtn.textContent = 'Copy Response'; }, 1500); }); };
            div.appendChild(copyBtn);
        }
        chatEl.appendChild(div);
        chatEl.scrollTop = chatEl.scrollHeight;
    }

    // SECURITY: the raw text is HTML-escaped FIRST so model output can never
    // inject markup — only the markdown patterns below produce HTML.
    function renderSkillMarkdown(text) {
        const escaped = String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        return escaped
            .replace(/```([\s\S]*?)```/g, '<pre style="background:var(--bg-subtle,#E5E8E1);padding:10px 14px;border-radius:6px;font-size:12px;overflow-x:auto;margin:8px 0"><code>$1</code></pre>')
            .replace(/`([^`]+)`/g, '<code style="background:var(--bg-subtle,#E5E8E1);padding:1px 4px;border-radius:3px;font-size:12px">$1</code>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/^### (.+)$/gm, '<h4 style="margin:10px 0 4px;font-size:14px">$1</h4>')
            .replace(/^## (.+)$/gm, '<h3 style="margin:12px 0 6px;font-size:15px">$1</h3>')
            .replace(/^# (.+)$/gm, '<h2 style="margin:14px 0 8px;font-size:16px">$1</h2>')
            .replace(/^- (.+)$/gm, '<div style="padding-left:12px">• $1</div>')
            .replace(/^\d+\. (.+)$/gm, '<div style="padding-left:12px">$&</div>')
            .replace(/\n/g, '<br>');
    }

    function showSkillRunModal(skill) {
        const existing = document.getElementById('skill-run-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'skill-run-modal';
        overlay.dataset.skillId = skill.id;
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px';
        const panel = document.createElement('div');
        panel.style.cssText = 'background:var(--bg-surface,#FBFBF9);border-radius:var(--radius-lg,12px);padding:0;max-width:860px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:var(--shadow-lg)';
        panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;padding:20px 24px 12px;border-bottom:1px solid var(--border-subtle,#E5E8E1)">
            <h2 style="margin:0;font-size:18px">${escHtml(skill.name)}</h2>
            <button onclick="this.closest('#skill-run-modal').remove()" style="border:none;background:none;font-size:20px;cursor:pointer;color:var(--text-muted,#8A928C)">&times;</button>
        </div>
        <div id="skill-chat-messages" style="flex:1;overflow-y:auto;padding:16px 24px;display:flex;flex-direction:column;min-height:200px;max-height:60vh"></div>
        <div id="skill-chat-area" style="display:none;padding:12px 24px 16px;border-top:1px solid var(--border-subtle,#E5E8E1);gap:8px;align-items:center">
            <input id="skill-chat-input" type="text" placeholder="Type your response..." onkeydown="if(event.key==='Enter'){event.preventDefault();sendSkillReply()}" style="flex:1;padding:10px 14px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-md,8px);font-size:13px;font-family:inherit;outline:none;background:var(--bg-surface,#FBFBF9)">
            <button onclick="sendSkillReply()" style="padding:10px 20px;border:none;border-radius:var(--radius-md,8px);background:var(--accent,#2C6E49);color:#fff;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit;white-space:nowrap">Send</button>
        </div>`;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
    }

    window.toggleSkillDetail = function (id) {
        const detail = document.getElementById('skill-detail-' + id);
        if (!detail) return;
        const card = detail.closest('.skills-card');
        const header = card ? card.querySelector('.skills-card-header') : null;
        const isOpen = detail.style.display !== 'none';
        detail.style.display = isOpen ? 'none' : 'block';
        if (header) {
            header.setAttribute('aria-expanded', String(!isOpen));
            const chevron = header.querySelector('.skills-chevron');
            if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
        }
    };

    window.setSkillsCategory = function (cat) {
        _activeCategory = (_activeCategory === cat) ? null : cat;
        document.querySelectorAll('.skills-filter-pill').forEach(p => {
            p.classList.toggle('active', p.dataset.category === _activeCategory);
        });
        renderSkillsLibrary();
    };

    window.onSkillsSearch = function (e) {
        _searchTerm = (e.target.value || '').trim();
        renderSkillsLibrary();
    };

    window.clearSkillsFilters = function () {
        _activeCategory = null;
        _searchTerm = '';
        _sourceFilter = 'mine';
        const input = document.getElementById('skillsSearchInput');
        if (input) input.value = '';
        document.querySelectorAll('.skills-filter-pill').forEach(p => p.classList.remove('active'));
        renderSourcePills();
        renderSkillsLibrary();
    };

    function renderSourcePills() {
        const bar = document.getElementById('skillsSourceBar');
        if (!bar) return;
        const all = allSkills();
        const isCustomOrSop = s => s.source === 'custom' || s.source === 'sop' || s.source === 'project' || s.source === 'scheduled';
        const myCount = all.filter(isCustomOrSop).length;
        const activePresetCount = all.filter(s => !isCustomOrSop(s) && _activePresetIds.includes(s.id)).length;
        const presetCount = all.filter(s => s.source === 'preset' || s.source === 'system').length;
        const allCount = all.length;
        bar.innerHTML = '';
        const sources = [
            { key: 'mine', label: 'My Skills (' + myCount + ')', desc: 'Custom + SOP-generated skills' },
            { key: 'active', label: 'Active (' + (myCount + activePresetCount) + ')', desc: 'My Skills + presets you have used' },
            { key: 'presets', label: 'Presets (' + presetCount + ')', desc: 'Generic Claude presets' },
            { key: 'all', label: 'All (' + allCount + ')', desc: 'Show everything' },
        ];
        sources.forEach(src => {
            const pill = document.createElement('button');
            pill.className = 'skills-source-pill' + (_sourceFilter === src.key ? ' active' : '');
            pill.textContent = src.label;
            pill.title = src.desc;
            pill.onclick = function () {
                _sourceFilter = src.key;
                document.querySelectorAll('.skills-source-pill').forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                renderSkillsLibrary();
            };
            bar.appendChild(pill);
        });
    }

    function renderFilterPills() {
        const bar = document.getElementById('skillsFilterBar');
        if (!bar) return;
        bar.innerHTML = '';
        const all = allSkills();
        SKILLS_CATEGORIES.forEach(cat => {
            const count = all.filter(s => s.category === cat).length;
            if (count === 0) return;
            const pill = document.createElement('button');
            pill.className = 'skills-filter-pill';
            pill.dataset.category = cat;
            pill.textContent = cat + ' (' + count + ')';
            pill.onclick = function () { setSkillsCategory(cat); };
            bar.appendChild(pill);
        });
    }

    window.renderSkillsTab = async function () {
        await fetchSOPSkills();
        await fetchActivePresets();
        renderSourcePills();
        renderFilterPills();
        renderSkillsLibrary();
        registerSkillsSyncBar();
    };

    // ── Sync / status bar (shared component from js/sync-bar.js) ──────────────
    // Injects its own host div at the top of the Skills panel (same pattern as
    // js/wealth.js) so index.html doesn't need editing. No-ops gracefully if the
    // panel or sync-bar module isn't present.
    function ensureSkillsSyncBarHost() {
        if (document.querySelector('[data-sync-bar="skills"]')) return true;
        const section = document.querySelector('#tab-skills .section');
        if (!section) return false;
        const host = document.createElement('div');
        host.setAttribute('data-sync-bar', 'skills');
        section.insertBefore(host, section.firstChild);
        return true;
    }

    function registerSkillsSyncBar() {
        if (typeof registerSyncBar !== 'function') return;
        if (!ensureSkillsSyncBarHost()) return;
        registerSyncBar('skills', {
            refreshFn: async function () {
                // Re-fetch SOP skills + active presets from Airtable and re-render
                _sopSkillsFetched = false;
                _sopFetchFailed = false;
                _activePresetsFetched = false;
                clearSOPSkillsNotice();
                await window.renderSkillsTab();
            },
            checks: [
                { name: 'Skills library data loaded', kind: 'sync', run: function () {
                    const n = (typeof SKILLS_LIBRARY !== 'undefined' && SKILLS_LIBRARY) ? SKILLS_LIBRARY.length : 0;
                    if (n === 0) return { status: 'fail', detail: 'SKILLS_LIBRARY is empty — js/skills-data.js may not have loaded' };
                    return { status: 'pass', detail: n + ' preset skills + ' + _sopSkills.length + ' SOP skills available' };
                }},
                { name: 'SOP skills fetched from Airtable', kind: 'sync', run: function () {
                    if (typeof PAT === 'undefined' || !PAT) return { status: 'warn', detail: 'Not signed in to Airtable yet — SOP skills unavailable' };
                    if (_sopFetchFailed) return { status: 'fail', detail: 'SOP skills fetch failed — showing local presets only. Click Refresh to retry' };
                    if (!_sopSkillsFetched) return { status: 'warn', detail: 'SOP skills not fetched yet' };
                    return { status: 'pass', detail: _sopSkills.length + ' SOP skills loaded' };
                }},
                { name: 'Active preset settings readable', kind: 'sync', run: function () {
                    if (typeof PAT === 'undefined' || !PAT) return { status: 'warn', detail: 'Not signed in to Airtable yet' };
                    if (!_activePresetsFetched) return { status: 'warn', detail: 'Active preset record not read — "Active" filter counts may be stale' };
                    return { status: 'pass', detail: _activePresetIds.length + ' active preset' + (_activePresetIds.length === 1 ? '' : 's') + ' recorded' };
                }},
                { name: 'AI model constant defined', kind: 'automation', run: function () {
                    if (typeof AI_MODEL_DEFAULT === 'undefined' || !AI_MODEL_DEFAULT) return { status: 'fail', detail: 'AI_MODEL_DEFAULT missing from js/config.js — Run Skill chat will fail' };
                    return { status: 'pass', detail: 'Skill runner uses ' + AI_MODEL_DEFAULT };
                }},
                { name: 'Skill cards rendered', kind: 'automation', run: function () {
                    const el = document.getElementById('skillsLibraryContent');
                    if (!el) return { status: 'warn', detail: 'Skills container not on this page' };
                    if (!_skillsRendered || !el.innerHTML.trim()) return { status: 'fail', detail: 'Skills list has not rendered' };
                    return { status: 'pass', detail: 'Skill cards rendered on the page' };
                }},
            ],
        });
        if (typeof markTabSynced === 'function') markTabSynced('skills');
    }

    window.expandAllSkills = function () {
        document.querySelectorAll('.skills-card-detail').forEach(d => {
            d.style.display = 'block';
            const card = d.closest('.skills-card');
            if (card) {
                const hdr = card.querySelector('.skills-card-header');
                if (hdr) {
                    hdr.setAttribute('aria-expanded', 'true');
                    const chev = hdr.querySelector('.skills-chevron');
                    if (chev) chev.style.transform = 'rotate(180deg)';
                }
            }
        });
    };

    window.openSkillDetail = function (id) {
        const skill = allSkills().find(s => s.id === id);
        if (!skill) return;
        const sourceBadge = SKILLS_SOURCE_LABELS[skill.source] || skill.source;
        const hasDrive = skill.driveUrl || skill.driveDocUrl;

        let html = `<div style="max-width:800px;margin:0 auto">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
                <h2 style="margin:0;font-size:20px;color:var(--text-primary,#1C2422)">${escHtml(skill.name)}</h2>
                <span class="skills-source-badge skills-source-${escHtml(skill.source)}" style="font-size:11px">${escHtml(sourceBadge)}</span>
            </div>
            <p style="color:var(--text-secondary,#5A6660);font-size:14px;line-height:1.6;margin:0 0 20px">${escHtml(skill.description)}</p>
            <div style="display:grid;grid-template-columns:120px 1fr;gap:8px 16px;margin-bottom:20px;font-size:13px">
                <span style="font-weight:600;color:var(--text-secondary,#5A6660)">Command</span>
                <code style="background:var(--bg-surface-2,#F4F6F1);padding:2px 8px;border-radius:4px;font-size:12px">/${escHtml(displayCommand(skill.command))}</code>
                <span style="font-weight:600;color:var(--text-secondary,#5A6660)">Category</span>
                <span>${escHtml(skill.category)}</span>
                <span style="font-weight:600;color:var(--text-secondary,#5A6660)">Source</span>
                <span>${escHtml(sourceBadge)}</span>
                ${skill.tags && skill.tags.length ? `<span style="font-weight:600;color:var(--text-secondary,#5A6660)">Tags</span>
                <span>${skill.tags.map(t => '<span style="display:inline-block;padding:2px 8px;background:var(--bg-subtle,#E5E8E1);border-radius:10px;font-size:11px;margin-right:4px;margin-bottom:2px">' + escHtml(t) + '</span>').join('')}</span>` : ''}
            </div>`;

        if (skill.instructions) {
            html += `<div style="margin-bottom:20px">
                <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:var(--text-primary,#1C2422)">Full Instructions</h3>
                <div style="white-space:pre-wrap;font-size:13px;line-height:1.7;background:var(--bg-surface-2,#F4F6F1);padding:16px 20px;border-radius:var(--radius-md,8px);border:1px solid var(--border-subtle,#E5E8E1);max-height:60vh;overflow-y:auto">${escHtml(skill.instructions)}</div>
            </div>`;
        }

        html += `<div style="display:flex;gap:8px;justify-content:flex-end;padding-top:12px;border-top:1px solid var(--border-subtle,#E5E8E1)">
            <button onclick="runSkill('${escJs(skill.id)}')" style="padding:8px 20px;border:none;border-radius:var(--radius-sm,4px);background:var(--accent,#2C6E49);color:#fff;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit">&#x25B6; Run Skill</button>
            ${hasDrive ? `<a href="${escHtml(skill.driveUrl || skill.driveDocUrl)}" target="_blank" rel="noopener" style="padding:8px 16px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);color:var(--text-secondary,#5A6660);cursor:pointer;font-size:13px;font-family:inherit;text-decoration:none">&#x1F4C2; Drive Folder</a>` : ''}
        </div></div>`;

        // Use the platform's showModal if available, otherwise create a simple overlay
        if (typeof showModal === 'function') {
            showModal(skill.name, html, '');
        } else {
            // Fallback modal
            const overlay = document.createElement('div');
            overlay.id = 'skill-detail-modal';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px';
            overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
            const panel = document.createElement('div');
            panel.style.cssText = 'background:var(--bg-surface,#FBFBF9);border-radius:var(--radius-lg,12px);padding:28px 32px;max-width:860px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:var(--shadow-lg)';
            panel.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button onclick="this.closest('#skill-detail-modal').remove()" style="border:none;background:none;font-size:20px;cursor:pointer;color:var(--text-muted,#8A928C)">&times;</button></div>` + html;
            overlay.appendChild(panel);
            document.body.appendChild(overlay);
        }
    };

    window.collapseAllSkills = function () {
        document.querySelectorAll('.skills-card-detail').forEach(d => {
            d.style.display = 'none';
            const card = d.closest('.skills-card');
            if (card) {
                const hdr = card.querySelector('.skills-card-header');
                if (hdr) {
                    hdr.setAttribute('aria-expanded', 'false');
                    const chev = hdr.querySelector('.skills-chevron');
                    if (chev) chev.style.transform = '';
                }
            }
        });
    };
})();
