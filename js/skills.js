// ══════════════════════════════════════════
// SKILLS LIBRARY — Browse, search, and filter all Claude Code / Cowork skills
// ══════════════════════════════════════════

(function () {
    'use strict';

    let _skillsRendered = false;
    let _activeCategory = null;
    let _searchTerm = '';

    function renderSkillsLibrary() {
        const container = document.getElementById('skillsLibraryContent');
        if (!container) return;

        const filtered = SKILLS_LIBRARY.filter(s => {
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
        if (countEl) countEl.textContent = filtered.length + ' of ' + SKILLS_LIBRARY.length + ' skills';

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
                html += `<div class="skills-card" data-skill-id="${escHtml(s.id)}">
                    <div class="skills-card-header" onclick="toggleSkillDetail('${escHtml(s.id)}')" role="button" tabindex="0" aria-expanded="false"
                         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleSkillDetail('${escHtml(s.id)}')}">
                        <div class="skills-card-title">${escHtml(s.name)}</div>
                        <span class="skills-source-badge ${sourceClass}">${escHtml(sourceBadge)}</span>
                    </div>
                    <div class="skills-card-desc">${escHtml(s.description)}</div>
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
        if (!bar || bar.children.length > 0) return;
        SKILLS_CATEGORIES.forEach(cat => {
            const count = SKILLS_LIBRARY.filter(s => s.category === cat).length;
            const pill = document.createElement('button');
            pill.className = 'skills-filter-pill';
            pill.dataset.category = cat;
            pill.textContent = cat + ' (' + count + ')';
            pill.onclick = function () { setSkillsCategory(cat); };
            bar.appendChild(pill);
        });
    }

    window.renderSkillsTab = function () {
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
