// ══════════════════════════════════════════════════════════════════
// Quick Task — floating "+ Task" button + lightweight capture modal.
// Loaded by every page so a task can be added from anywhere with two
// clicks. Self-contained: bundles its own table/field IDs and team
// roster so it works in iframe pages that don't load config.js.
//
// IFRAME BEHAVIOUR: when this script runs inside an iframe (i.e.
// loaded via the parent shell's tab embed), it suppresses the FAB —
// the parent shell's FAB already floats above the iframe content in
// the z-index stack, so two buttons would just clutter the UI.
// Standalone access to an iframe page (e.g. opening compliance.html
// directly) still gets its own FAB because window === window.top.
// ══════════════════════════════════════════════════════════════════
(function(){
  'use strict';

  // Suppress FAB inside iframes; parent shell already has one.
  if (window !== window.top) return;

  // ── Airtable wiring (kept in sync with js/config.js TABLES.tasks
  //    and the task field IDs in os/tasks/index.html). Hard-coded so
  //    this module works on iframe pages that don't load config.js.
  const QT_BASE_ID = 'appnqjDpqDniH3IRl';
  const QT_TASKS_TABLE = 'tblqB8b22hKBL4PF1';
  const QT_F = {
    name:           'fldgFjGBw6bTKJFCD',
    dueDate:        'fld7XP8w8kbxfETV4',
    status:         'fldx4qCw17UfrKpaN',
    assignee:       'fldELMncVJYPDRJNc',
    priority:       'fldS21RwmwOqt71LI',
    timeEst:        'fld10VzzbiNNgRmIi',
    description:    'fldRGhBQViKZKtkQ6',
    hardDeadline:   'fldZKzIxgyrQ8CG8a',
    createdByEmail: 'fldtzljV5m0eTgBK5',
  };

  // Team roster mirrors os/tasks/index.html TEAM. Used to populate
  // the Assignee dropdown and to resolve a key → email so the
  // Airtable singleCollaborator field accepts the value via
  // typecast:true. Update this list when the team page does.
  const QT_TEAM = [
    { key: 'kevin', name: 'Kevin Brittain',  email: 'kevin@runpreneur.org.uk' },
    { key: 'mica',  name: 'Mica Albovias',   email: 'micaa.work@gmail.com' },
    { key: 'erica', name: 'Ericamae Atenta', email: 'atentaerica@gmail.com' },
  ];
  const QT_PRIORITY_OPTIONS = ['Project', 'Urgent', 'Not Urgent'];
  const QT_TIME_OPTIONS     = ['15 min', '30 min', '45 min', '1 hr', '2 hr', '3 hr', '4 hr', '8 hr'];

  // ── Helpers ──
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Status auto-derives from due date so the task lands in the right
  // bucket on the Tasks page without the user having to set it.
  function deriveStatus(due) {
    if (!due) return 'Upcoming';
    const t = todayStr();
    if (due < t) return 'Overdue';
    if (due === t) return 'Today';
    return 'Upcoming';
  }

  // Identity is stored under _task_user by the Tasks page identity
  // overlay. Default to Kevin if nothing's set yet (e.g. user has
  // never opened the Tasks tab on this device).
  function getCurrentUser() {
    try {
      const raw = localStorage.getItem('_task_user');
      if (raw) {
        const u = JSON.parse(raw);
        if (u && u.email) return u;
      }
    } catch (e) {}
    return QT_TEAM[0];
  }

  function getPAT() {
    try { return localStorage.getItem('_dlr_pat') || ''; } catch (e) { return ''; }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showToast(msg, isError) {
    const t = document.createElement('div');
    t.className = 'qt-toast' + (isError ? ' qt-toast-error' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => {
      t.classList.add('qt-toast-fade');
      setTimeout(() => t.remove(), 320);
    }, isError ? 3500 : 2200);
  }

  // ── Modal ──
  function openModal() {
    if (document.getElementById('qtModal')) return;
    const cur = getCurrentUser();
    const today = todayStr();
    const overlay = document.createElement('div');
    overlay.id = 'qtModal';
    overlay.className = 'qt-modal-overlay';
    overlay.onclick = e => { if (e.target === overlay) closeModal(); };
    overlay.innerHTML = `
      <div class="qt-modal" role="dialog" aria-label="Quick Add Task">
        <div class="qt-modal-head">
          <h3>Quick Add Task</h3>
          <button class="qt-x" type="button" aria-label="Close" data-qt-close="1">&times;</button>
        </div>
        <div class="qt-row qt-row-stacked">
          <label for="qtName">Task</label>
          <input type="text" id="qtName" placeholder="What needs to be done?" autocomplete="off">
        </div>
        <div class="qt-row">
          <label for="qtAssignee">Assignee</label>
          <select id="qtAssignee">
            ${QT_TEAM.map(m => `<option value="${m.key}" ${m.key === cur.key ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
          </select>
        </div>
        <div class="qt-row">
          <label for="qtDue">Due Date</label>
          <div class="qt-due-wrap">
            <input type="date" id="qtDue" value="${today}">
            <label class="qt-hard"><input type="checkbox" id="qtHard"> Hard deadline</label>
          </div>
        </div>
        <div class="qt-row">
          <label for="qtTimeEst">Time</label>
          <select id="qtTimeEst">
            ${QT_TIME_OPTIONS.map(o => `<option ${o === '15 min' ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </div>
        <div class="qt-row">
          <label for="qtPriority">Priority</label>
          <select id="qtPriority">
            ${QT_PRIORITY_OPTIONS.map(p => `<option ${p === 'Not Urgent' ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
        <div class="qt-row qt-row-stacked">
          <label for="qtDesc">Notes <span class="qt-optional">(optional)</span></label>
          <textarea id="qtDesc" rows="3" placeholder="Anything else..."></textarea>
        </div>
        <div class="qt-modal-foot">
          <button class="qt-btn qt-btn-ghost" type="button" data-qt-close="1">Cancel</button>
          <button class="qt-btn qt-btn-primary" type="button" id="qtSubmit">Add Task</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Wire up handlers — using addEventListener instead of inline onclick
    // means CSP-safe and survives clones; data-qt-close lets the X and
    // Cancel button share the same handler.
    overlay.querySelectorAll('[data-qt-close]').forEach(el => {
      el.addEventListener('click', closeModal);
    });
    document.getElementById('qtSubmit').addEventListener('click', submit);

    // Cmd/Ctrl+Enter submits, Escape cancels — both standard quick-capture
    // shortcuts. Keep handlers scoped to the overlay so they don't leak.
    overlay.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
      }
    });

    // Focus the name field after a tick so the autofocus attribute and
    // the modal entrance animation don't fight each other.
    setTimeout(() => {
      const n = document.getElementById('qtName');
      if (n) n.focus();
    }, 60);
  }

  function closeModal() {
    const m = document.getElementById('qtModal');
    if (m) m.remove();
  }

  async function submit() {
    const nameEl = document.getElementById('qtName');
    if (!nameEl) return;
    const name = (nameEl.value || '').trim();
    if (!name) { showToast('Task name required', true); nameEl.focus(); return; }

    const due       = document.getElementById('qtDue').value;
    const assignee  = document.getElementById('qtAssignee').value;
    const priority  = document.getElementById('qtPriority').value;
    const timeEst   = document.getElementById('qtTimeEst').value;
    const hard      = document.getElementById('qtHard').checked;
    const desc      = (document.getElementById('qtDesc').value || '').trim();

    const pat = getPAT();
    if (!pat) { showToast('Not signed in to Airtable. Reload and enter your PAT.', true); return; }

    const member = QT_TEAM.find(m => m.key === assignee) || QT_TEAM[0];
    const cur = getCurrentUser();

    const fields = {};
    fields[QT_F.name] = name;
    if (due) fields[QT_F.dueDate] = due;
    fields[QT_F.status] = deriveStatus(due);
    fields[QT_F.assignee] = { email: member.email };
    if (priority) fields[QT_F.priority] = priority;
    if (timeEst)  fields[QT_F.timeEst]  = timeEst;
    if (desc)     fields[QT_F.description] = desc;
    fields[QT_F.hardDeadline] = !!hard;
    if (cur && cur.email) fields[QT_F.createdByEmail] = cur.email;

    const btn = document.getElementById('qtSubmit');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }

    try {
      const url = `https://api.airtable.com/v0/${QT_BASE_ID}/${QT_TASKS_TABLE}?returnFieldsByFieldId=true`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, typecast: true }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error('HTTP ' + res.status + ' — ' + t.slice(0, 220));
      }
      const created = await res.json();
      closeModal();
      const whenLbl = due === todayStr() ? ' for today' : (due ? ' for ' + due : '');
      showToast(`✓ Task added${whenLbl}`);

      // If the parent shell has a Tasks iframe loaded, ping it so it
      // can refresh its grid and show the new row immediately.
      try {
        const tasksFrame = document.getElementById('tasksFrame');
        if (tasksFrame && tasksFrame.contentWindow) {
          tasksFrame.contentWindow.postMessage({ type: 'qt:task-created', id: created.id }, '*');
        }
      } catch (e) { /* cross-origin iframes will throw — non-fatal */ }
    } catch (e) {
      console.error('[QuickTask] submit failed', e);
      if (btn) { btn.disabled = false; btn.textContent = 'Add Task'; }
      showToast('Failed: ' + e.message, true);
    }
  }

  // ── FAB ──
  function renderFab() {
    if (document.getElementById('qtFab')) return;
    const fab = document.createElement('button');
    fab.id = 'qtFab';
    fab.className = 'qt-fab';
    fab.type = 'button';
    fab.title = 'Quick Add Task';
    fab.setAttribute('aria-label', 'Quick add task');
    fab.innerHTML = '<span class="qt-fab-plus" aria-hidden="true">+</span><span class="qt-fab-label">Task</span>';
    fab.addEventListener('click', openModal);
    document.body.appendChild(fab);
  }

  // Allow the Tasks iframe to receive a "task created" ping and refresh.
  // The Tasks page itself can listen via window.addEventListener('message').
  function init() {
    renderFab();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API for any page that wants to trigger the modal programmatically
  // (e.g. a sidebar shortcut, a slash-command, a keyboard binding).
  window.QuickTask = { open: openModal, close: closeModal };
})();
