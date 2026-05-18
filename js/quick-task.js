// ══════════════════════════════════════════════════════════════════
// Quick Task — floating "+ Task" button on every page.
//
// FLOW (revised by user request: drawer-first, never a simple modal):
//   1. User clicks the FAB
//   2. We route to the Tasks page's startQuickAddInline() helper —
//      a centred name-only input bar that creates the task and opens
//      the Task Drawer. Same UX as the timeline / kanban inline-add.
//   3. The user fills in the rest (project, business, hard deadline,
//      etc.) inside the drawer.
//
// ENVIRONMENTS:
//   • Parent shell (index.html): switch to the Tasks tab, wait for
//     the iframe to load, then postMessage qt:start-quick-add. The
//     Tasks page listens and renders the inline-add bar.
//   • Standalone Tasks page (os/tasks/index.html opened directly):
//     window.startQuickAddInline exists locally — call it.
//   • Other standalone iframe pages (compliance.html, follow-up.html,
//     os/strategy, os/operations, os/business-plan-builder): the
//     Task Drawer doesn't exist on these pages, so the FAB navigates
//     to the parent shell with a hash that auto-triggers quick-add
//     once the Tasks tab is loaded.
//
// IFRAME SUPPRESSION: when this script runs inside an iframe (i.e.
// loaded via the parent shell's tab embed), it suppresses the FAB —
// the parent shell's FAB already floats above the iframe content.
// ══════════════════════════════════════════════════════════════════
(function(){
  'use strict';

  // Suppress FAB inside iframes; parent shell already has one.
  if (window !== window.top) return;

  // Wait for the iframe content to be ready before postMessage. The
  // listener inside os/tasks/index.html attaches at script-eval time,
  // which only happens after the iframe's HTML has loaded. If we post
  // too early the message disappears into the void.
  function waitForTasksIframeReady(frame, cb, attempts) {
    attempts = attempts == null ? 30 : attempts; // 30 × 100ms = 3s budget
    if (attempts <= 0) { console.warn('[QuickTask] tasks iframe never became ready; posting anyway'); cb(); return; }
    try {
      const w = frame.contentWindow;
      if (w && typeof w.openNewTaskDrawer === 'function') { cb(); return; }
    } catch (e) { /* cross-origin or transient — fall through to retry */ }
    setTimeout(() => waitForTasksIframeReady(frame, cb, attempts - 1), 100);
  }

  function openOnTasksPage() {
    // Parent shell: hop to the Tasks tab, then ping the iframe to open
    // the Task Drawer directly (cursor in the title, ready to type).
    // Timeline + Kanban double-clicks still get the inline-name-first
    // flow — those carry positional context that makes the bar useful.
    if (typeof window.switchTab === 'function' && document.getElementById('tasksFrame')) {
      const frame = document.getElementById('tasksFrame');
      try { window.switchTab('tasks'); } catch (e) { console.warn('[QuickTask] switchTab failed', e); }
      waitForTasksIframeReady(frame, () => {
        try {
          frame.contentWindow.postMessage({ type: 'qt:open-new-task-drawer' }, '*');
        } catch (e) { console.warn('[QuickTask] postMessage failed', e); }
      });
      return true;
    }
    // Tasks page open standalone — call the function directly.
    if (typeof window.openNewTaskDrawer === 'function') {
      window.openNewTaskDrawer();
      return true;
    }
    return false;
  }

  function navigateToShellTasks() {
    // From a non-Tasks standalone iframe page, navigate up to the parent
    // shell with a hash that the shell can interpret as "open Tasks +
    // start quick-add". The Tasks page's switchTab + the parent's hash
    // handler do the rest.
    //
    // We compute the relative path back to /index.html based on the
    // current URL depth (root vs os/* vs os/*/*/).
    const path = location.pathname;
    let up = '';
    if (/\/os\/[^\/]+\/[^\/]+\//.test(path)) up = '../../';
    else if (/\/os\/[^\/]+\//.test(path)) up = '../';
    location.href = up + 'index.html#tasks?qa=1';
  }

  // Public entry point. On the Tasks page, use the full drawer. On any
  // other page in the parent shell, use the lightweight quick-task modal
  // so the user stays on their current page.
  function openQuickAdd() {
    // If we are on the Tasks page (standalone), use the full drawer.
    if (typeof window.openNewTaskDrawer === 'function') {
      window.openNewTaskDrawer();
      return;
    }
    // Parent shell but NOT on the Tasks tab: use the lightweight modal.
    if (typeof window.openQuickTaskModal === 'function') {
      const isTasksTab = location.hash.replace(/\?.*/,'') === '#tasks';
      if (!isTasksTab) {
        window.openQuickTaskModal({});
        return;
      }
    }
    // On the Tasks tab or fallback: use the full drawer via iframe.
    if (openOnTasksPage()) return;
    navigateToShellTasks();
  }

  function renderFab() {
    if (document.getElementById('qtFab')) return;
    const fab = document.createElement('button');
    fab.id = 'qtFab';
    fab.className = 'qt-fab';
    fab.type = 'button';
    fab.title = 'Quick Add Task';
    fab.setAttribute('aria-label', 'Quick add task');
    fab.innerHTML = '<span class="qt-fab-plus" aria-hidden="true">+</span><span class="qt-fab-label">Task</span>';
    fab.addEventListener('click', openQuickAdd);
    document.body.appendChild(fab);
  }

  // If the parent shell loads with #tasks?qa=1 (because we navigated up
  // from a standalone iframe page), auto-trigger the quick-add flow
  // after the Tasks iframe has had a chance to load.
  function checkAutoTrigger() {
    if (location.hash && /[#&]tasks\b.*[?&]qa=1/.test(location.hash)) {
      // Defer so switchTab and the iframe initial load can settle first.
      setTimeout(openOnTasksPage, 500);
    }
  }

  function init() {
    renderFab();
    checkAutoTrigger();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API for any page that wants to trigger from elsewhere
  // (e.g. a sidebar shortcut, slash-command, keyboard binding).
  window.QuickTask = { open: openQuickAdd };
})();
