// ══════════════════════════════════════════
// SKILLS LIBRARY — Browse, search, and filter all Claude Code / Cowork skills
// ══════════════════════════════════════════

(function () {
    'use strict';

    let _skillsRendered = false;
    let _activeCategory = null;
    let _searchTerm = '';
    let _sopSkills = [];
    let _sopSkillsFetched = false;

    async function fetchSOPSkills() {
        if (_sopSkillsFetched || typeof PAT === 'undefined' || !PAT) return;
        try {
            const baseId = 'appnqjDpqDniH3IRl';
            const tableId = 'tblLPoRHFBl0vqR24';
            const fieldId = 'fldmRF1UDkbHtl1AG';
            const driveFieldId = 'fldNtXnxGrpUivWxU';
            const url = `https://api.airtable.com/v0/${baseId}/${tableId}?fields[]=${fieldId}&fields[]=${driveFieldId}&filterByFormula=NOT({Skill Definition}='')`;
            const res = await fetch(url, { headers: { Authorization: `Bearer ${PAT}` } });
            if (!res.ok) return;
            const data = await res.json();
            const skills = [];
            (data.records || []).forEach(r => {
                const raw = r.fields[fieldId];
                if (!raw) return;
                const driveUrl = r.fields[driveFieldId] || '';
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
                        <span class="skills-source-badge ${sourceClass}">${escHtml(sourceBadge)}</span>
                    </div>
                    <div class="skills-card-desc">${escHtml(s.description)}</div>
                    <div class="skills-card-actions" style="padding:8px 16px 4px;display:flex;gap:8px;align-items:center">
                        <button class="skills-run-btn" onclick="event.stopPropagation();runSkill('${escHtml(s.id)}')" style="padding:6px 14px;border:none;border-radius:var(--radius-sm,4px);background:var(--accent,#2C6E49);color:#fff;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;display:flex;align-items:center;gap:4px">&#x25B6; Run Skill</button>
                        ${hasDrive ? `<a href="${escHtml(s.driveUrl || s.driveDocUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="padding:6px 10px;border:1px solid var(--border-default,#DDE1D9);border-radius:var(--radius-sm,4px);background:var(--bg-surface,#fff);color:var(--text-secondary,#5A6660);cursor:pointer;font-size:12px;font-family:inherit;text-decoration:none;display:flex;align-items:center;gap:4px">&#x1F4C2; Drive Folder</a>` : ''}
                    </div>
                    <div class="skills-card-detail" id="skill-detail-${escHtml(s.id)}" style="display:none">
                        <div class="skills-detail-row">
                            <span class="skills-detail-label">Command</span>
                            <code class="skills-detail-value">${escHtml(s.command)}</code>
                        </div>
                        <div class="skills-detail-row">
                            <span class="skills-detail-label">Category</span>
                            <span class="skills-detail-value">${escHtml(s.category)}</span>
                        </div>
                        ${s.tags && s.tags.length ? `<div class="skills-detail-row">
                            <span class="skills-detail-label">Tags</span>
                            <span class="skills-detail-value skills-tags">${s.tags.map(t => '<span class="skills-tag">' + escHtml(t) + '</span>').join('')}</span>
                        </div>` : ''}
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

    window.runSkill = function (id) {
        const skill = allSkills().find(s => s.id === id);
        if (!skill) { showToast('Skill not found', { type: 'warning' }); return; }

        // Build the command text to copy as a slash command for Claude Co-Work
        const cmd = skill.command || skill.id;
        let clipText = '/' + cmd;
        if (skill.instructions) clipText += '\n\n' + skill.instructions;

        // Copy to clipboard
        navigator.clipboard.writeText(clipText).then(() => {
            let msg = 'Copied: /' + cmd + ' — paste into Claude Code or Co-Work to run.';
            if (skill.driveUrl) {
                msg += ' Drive folder opening.';
                window.open(skill.driveUrl, '_blank', 'noopener');
            }
            showToast(msg, { type: 'success', duration: 6000 });
        }).catch(() => {
            prompt('Copy this slash command to use in Claude Code or Co-Work:', clipText);
            if (skill.driveUrl) window.open(skill.driveUrl, '_blank', 'noopener');
        });
    };

    window.toggleSkillDetail = function (id) {
        const detail = document.getElementById('skill-detail-' + id);
        if (!detail) return;
        const card = detail.closest('.skills-card');
        const header = card ? card.querySelector('.skills-card-header') : null;
        const isOpen = detail.style.display !== 'none';
        detail.style.display = isOpen ? 'none' : 'block';
        if (header) header.setAttribute('aria-expanded', String(!isOpen));
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
        const input = document.getElementById('skillsSearchInput');
        if (input) input.value = '';
        document.querySelectorAll('.skills-filter-pill').forEach(p => p.classList.remove('active'));
        renderSkillsLibrary();
    };

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
        renderFilterPills();
        renderSkillsLibrary();
    };

    window.expandAllSkills = function () {
        document.querySelectorAll('.skills-card-detail').forEach(d => {
            d.style.display = 'block';
            const card = d.closest('.skills-card');
            if (card) {
                const hdr = card.querySelector('.skills-card-header');
                if (hdr) hdr.setAttribute('aria-expanded', 'true');
            }
        });
    };

    window.collapseAllSkills = function () {
        document.querySelectorAll('.skills-card-detail').forEach(d => {
            d.style.display = 'none';
            const card = d.closest('.skills-card');
            if (card) {
                const hdr = card.querySelector('.skills-card-header');
                if (hdr) hdr.setAttribute('aria-expanded', 'false');
            }
        });
    };
})();
