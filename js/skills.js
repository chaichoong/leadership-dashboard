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

    async function fetchActivePresets() {
        if (_activePresetsFetched || typeof PAT === 'undefined' || !PAT) return;
        try {
            const url = `https://api.airtable.com/v0/${BASE_ID}/${SETTINGS_TABLE}/${SETTINGS_RECORD}?fields[]=${encodeURIComponent(ACTIVE_SKILLS_FIELD)}`;
            const res = await fetch(url, { headers: { Authorization: 'Bearer ' + PAT } });
            if (!res.ok) return;
            const data = await res.json();
            const raw = data.fields[ACTIVE_SKILLS_FIELD];
            if (raw) {
                try { _activePresetIds = JSON.parse(raw); } catch (e) { _activePresetIds = []; }
            }
            _activePresetsFetched = true;
        } catch (e) {}
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
        } catch (e) {}
    }

    async function fetchSOPSkills() {
        if (_sopSkillsFetched || typeof PAT === 'undefined' || !PAT) return;
        try {
            const baseId = 'appnqjDpqDniH3IRl';
            const tableId = 'tblLPoRHFBl0vqR24';
            const skillFieldName = 'Skill Definition';
            const driveFieldName = 'Drive URL';
            const baseUrl = `https://api.airtable.com/v0/${baseId}/${tableId}?fields[]=${encodeURIComponent(skillFieldName)}&fields[]=${encodeURIComponent(driveFieldName)}&filterByFormula=NOT({${skillFieldName}}='')`;
            const skills = [];
            let offset = '';
            do {
                const pageUrl = offset ? `${baseUrl}&offset=${encodeURIComponent(offset)}` : baseUrl;
                const res = await fetch(pageUrl, { headers: { Authorization: `Bearer ${PAT}` } });
                if (!res.ok) break;
                const data = await res.json();
                (data.records || []).forEach(r => {
                    const raw = r.fields[skillFieldName];
                    if (!raw) return;
                    const driveUrl = r.fields[driveFieldName] || '';
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
                    } catch (e) {}
                });
                offset = data.offset || '';
            } while (offset);
            _sopSkills = skills;
            _sopSkillsFetched = true;
        } catch (e) {}
    }

    function allSkills() {
        return SKILLS_LIBRARY.concat(_sopSkills);
    }

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

        const grouped = {};
        SKILLS_CATEGORIES.forEach(cat => { grouped[cat] = []; });
        filtered.forEach(s => {
            if (!grouped[s.category]) grouped[s.category] = [];
            grouped[s.category].push(s);
        });

        const countEl = document.getElementById('skillsTotalCount');
        if (countEl) countEl.textContent = filtered.length + ' of ' + all.length + ' skills';

        let html = '';
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
                    <div class="skills-card-header" onclick="toggleSkillDetail('${escHtml(s.id)}')" role="button" tabindex="0" aria-expanded="false"
                         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleSkillDetail('${escHtml(s.id)}')}">
                        <div class="skills-card-title">${escHtml(s.name)}</div>
                        <div style="display:flex;align-items:center;gap:8px">
                            <span class="skills-source-badge ${sourceClass}">${escHtml(sourceBadge)}</span>
                            <span class="skills-chevron" style="font-size:12px;color:var(--text-muted,#8A928C);transition:transform 0.2s">&#x25BC;</span>
                        </div>
                    </div>
                    <div class="skills-card-desc">${escHtml(s.description)}</div>
                    <div class="skills-card-actions" style="padding:8px 16px 4px;display:flex;gap:8px;align-items:center">
                        <button class="skills-run-btn" onclick="event.stopPropagation();runSkill('${escHtml(s.id)}')" style="padding:6px 14px;border:none;border-radius:var(--radius-sm,4px);background:var(--accent,#2C6E49);color:#fff;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;display:flex;align-items:center;gap:4px">&#x25B6; Run Skill</button>
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
                            <span class="skills-detail-label" style="margin-bottom:6px">Instructions <button onclick="event.stopPropagation();openSkillDetail('${escHtml(s.id)}')" style="margin-left:8px;padding:2px 8px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);color:var(--accent,#2C6E49);cursor:pointer;font-size:11px;font-family:inherit">View Full</button></span>
                            <div class="skills-detail-value" style="max-height:120px;overflow-y:auto;white-space:pre-wrap;font-size:12px;line-height:1.5;background:var(--bg-surface-2,#F4F6F1);padding:10px 12px;border-radius:var(--radius-sm,4px);border:1px solid var(--border-subtle,#E5E8E1)">${escHtml(s.instructions)}</div>
                        </div>` : ''}
                        ${!s.instructions ? `<div style="padding:4px 0"><button onclick="event.stopPropagation();openSkillDetail('${escHtml(s.id)}')" style="padding:4px 12px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);color:var(--accent,#2C6E49);cursor:pointer;font-size:12px;font-family:inherit">View Full Details</button></div>` : ''}
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

    const SKILL_RUNNER_URL = 'https://skill-runner.kevinbrittain.workers.dev';

    window.runSkill = async function (id) {
        const skill = allSkills().find(s => s.id === id);
        if (!skill) { showToast('Skill not found', { type: 'warning' }); return; }

        // Track as active preset (persists to Airtable for all users)
        if (skill.source !== 'sop' && skill.source !== 'custom') saveActivePreset(id);

        if (skill.driveUrl) window.open(skill.driveUrl, '_blank', 'noopener');

        // Try running via the skill-runner worker
        showSkillRunModal(skill, 'Running skill...');
        try {
            const res = await fetch(SKILL_RUNNER_URL + '/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    skillName: skill.name,
                    command: skill.command,
                    instructions: skill.instructions || skill.description,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Worker returned ' + res.status }));
                throw new Error(err.error || 'Worker error');
            }
            const result = await res.json();
            showSkillRunModal(skill, result.output, result.usage);
        } catch (e) {
            // Fallback: copy to clipboard if worker is not deployed
            const cmd = skill.command || skill.id;
            let clipText = '/' + cmd;
            if (skill.instructions) clipText += '\n\n' + skill.instructions;
            navigator.clipboard.writeText(clipText).catch(() => {});
            showSkillRunModal(skill, 'Worker not available (' + e.message + ').\n\nThe skill command has been copied to your clipboard. Paste it into Claude Code or Co-Work to run.\n\n/' + cmd);
        }
    };

    function showSkillRunModal(skill, content, usage) {
        const isLoading = content === 'Running skill...';
        const usageInfo = usage ? `<div style="font-size:11px;color:var(--text-muted,#8A928C);margin-top:12px;padding-top:8px;border-top:1px solid var(--border-subtle,#E5E8E1)">Tokens: ${usage.input_tokens} in, ${usage.output_tokens} out</div>` : '';

        const html = `<div style="max-width:800px;margin:0 auto">
            ${isLoading ? '<div style="text-align:center;padding:40px"><div style="display:inline-block;width:32px;height:32px;border:3px solid var(--border-default);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite"></div><p style="margin-top:12px;color:var(--text-secondary)">Executing ${escHtml(skill.name)}...</p><style>@keyframes spin{to{transform:rotate(360deg)}}</style></div>' :
            `<div style="white-space:pre-wrap;font-size:13px;line-height:1.7;background:var(--bg-surface-2,#F4F6F1);padding:16px 20px;border-radius:var(--radius-md,8px);border:1px solid var(--border-subtle,#E5E8E1);max-height:60vh;overflow-y:auto">${escHtml(content)}</div>${usageInfo}`}
        </div>`;

        // Remove existing modal if present
        const existing = document.getElementById('skill-run-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'skill-run-modal';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;padding:20px';
        if (!isLoading) overlay.onclick = function(e) { if (e.target === overlay) overlay.remove(); };
        const panel = document.createElement('div');
        panel.style.cssText = 'background:var(--bg-surface,#FBFBF9);border-radius:var(--radius-lg,12px);padding:28px 32px;max-width:860px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:var(--shadow-lg)';
        panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
            <h2 style="margin:0;font-size:18px">${escHtml(skill.name)}</h2>
            ${!isLoading ? '<button onclick="this.closest(\'#skill-run-modal\').remove()" style="border:none;background:none;font-size:20px;cursor:pointer;color:var(--text-muted,#8A928C)">&times;</button>' : ''}
        </div>` + html;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
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
    };

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
            <button onclick="runSkill('${escHtml(skill.id)}')" style="padding:8px 20px;border:none;border-radius:var(--radius-sm,4px);background:var(--accent,#2C6E49);color:#fff;cursor:pointer;font-size:13px;font-weight:600;font-family:inherit">&#x25B6; Run Skill</button>
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
