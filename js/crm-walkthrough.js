/* ===========================================================================
   CRM — interactive walkthrough
   ---------------------------------------------------------------------------
   A click-through tour of the CRM page: spotlights each control, explains it,
   and drives the real UI as it goes (switches tabs, opens the contact form)
   by clicking the page's own elements rather than reimplementing their state.

   Runs by itself the first time someone opens the CRM, the way a newly
   installed app does. After that it is opt-in from the "Guide" button in the
   top bar.

   This lives inside crm-supabase.html rather than the app shell because the
   shell loads every page into an <iframe> — a tour in the shell could not
   measure anything on this page. The trade-off is that it cannot highlight
   the left sidebar, which belongs to the shell.

   Steps that point at something the current user cannot see (the owner-only
   Clients tab and Onboarding link are hidden for client accounts by
   html.crm-gate) drop out automatically, so the tour never points at nothing.
   =========================================================================== */
(function () {
  'use strict';

  var KEY = 'od.crm.walkthrough';

  /* --- helpers ----------------------------------------------------------- */
  function $(sel) { return document.querySelector(sel); }
  function visible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }
  function tab(name) {
    var t = $('.tab[data-tab="' + name + '"]');
    if (t && visible(t)) t.click();          // click it so the page's own handler runs
  }
  function closeOverlays() {
    document.querySelectorAll('.overlay.open').forEach(function (o) { o.classList.remove('open'); });
  }
  function seen() { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  function markSeen() { try { localStorage.setItem(KEY, '1'); } catch (e) { /* no-op */ } }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* --- the tour ---------------------------------------------------------- */
  // before() puts the page into the state the step needs. It runs during the
  // "does this element exist" pass as well as on the way through, so it must
  // be safe to call repeatedly.
  var STEPS = [
    { before: function () { closeOverlays(); tab('contacts'); },
      target: null,
      title: 'This is your CRM',
      body: 'Everyone you deal with lives here — leads, clients, suppliers — along with the deals attached to them. Ninety seconds and you will know the whole page. Use Next and Back, or the arrow keys. Esc stops at any point.' },

    { target: '.tabs',
      title: 'Three views of the same data',
      body: 'Contacts is the address book. Pipeline is the money — the same people, arranged by how close the deal is. Clients is who has already signed. Nothing is duplicated between them; they are three ways of looking at one list.' },

    { target: '#addBtn',
      title: 'Everything starts here',
      body: 'One button, and it follows the tab you are on. On Contacts it adds a person or company; on Pipeline it adds a deal. Let us add a contact.' },

    { before: function () { tab('contacts'); if (!$('#contactOverlay.open')) $('#addBtn').click(); },
      target: '#cName',
      title: 'Only the name is required',
      body: 'Everything else can wait. Get the name in now and fill the rest in when you actually know it — a half-filled contact is far more useful than one you never got round to creating.' },

    { target: '#cKind',
      title: 'Person or company',
      body: 'Use Person for someone you speak to and Company for the business itself. If you deal with two people at the same firm, add both as people and put the firm in the Company field — that way the pipeline shows you who to chase, not just where.' },

    { target: '#cStatus',
      title: 'Lead, active, or archived',
      body: 'Lead is someone you are still chasing. Active is a live relationship. Archived hides them from the list without deleting anything, so you keep the history when a relationship goes quiet.' },

    { target: '#cSave',
      title: 'Save, and they appear immediately',
      body: 'It writes straight to your workspace — no separate sync step, and anyone else on your team sees it too.' },

    { before: function () { closeOverlays(); tab('contacts'); },
      target: '#contactsView',
      title: 'Your contact list',
      body: 'Name, type, company, email, phone and status at a glance. Click any row to reopen that contact and edit or delete them.' },

    { target: '#search',
      title: 'Find anyone fast',
      body: 'Filters as you type, across names and companies. Once the list runs past a screenful this is quicker than scrolling. It shows on the Contacts tab only.' },

    { before: function () { closeOverlays(); tab('pipeline'); },
      target: '#pipelineView',
      title: 'The pipeline is your deals by stage',
      body: 'Each card is a deal with a value against it, sorted into the stage it has reached. One glance tells you what is actually in play — and where things have got stuck.' },

    { target: '#addBtn',
      title: 'Same button, different job',
      body: 'On this tab + Add creates a deal instead of a contact: a title, a value, the stage it is at, and the contact it belongs to. That link is what ties the money back to a person.' },

    { before: function () { closeOverlays(); tab('clients'); },
      target: '#clientsView',
      title: 'When a deal is won',
      body: 'Mark a deal Won and you can turn it into a real client account from the deal itself — they get a login to their own workspace. Everyone who has made that journey is listed here.' },

    { before: function () { closeOverlays(); tab('clients'); },
      target: '#copyOnboarding',
      title: 'Send them the onboarding form',
      body: 'Copies a link to the onboarding form so a new client can fill in their own details. Their answers come back onto their contact record — no retyping, and nothing gets lost in an email thread.' },

    { before: function () { closeOverlays(); tab('contacts'); },
      target: null,
      title: 'That is the CRM',
      body: 'Add contacts, move deals through the pipeline, turn the won ones into clients. You can replay this any time from the Guide button in the top right.' }
  ];

  /* --- overlay ----------------------------------------------------------- */
  var css = [
    '.cw-block{position:fixed;inset:0;z-index:9000;display:none;}',
    '.cw-block.show{display:block;}',
    '.cw-spot{position:fixed;z-index:9001;border-radius:10px;pointer-events:none;',
    '  box-shadow:0 0 0 2px var(--accent,#3560A8),0 0 16px 3px rgba(53,96,168,.35),0 0 0 9999px rgba(15,23,42,.55);}',
    '.cw-spot.is-centred{box-shadow:0 0 0 9999px rgba(15,23,42,.62);}',
    '.cw-pop{position:fixed;z-index:9002;width:min(370px,calc(100vw - 32px));',
    '  background:var(--bg-surface,#fff);color:var(--text-primary,#101828);',
    '  border:1px solid var(--border-default,#d7dde7);border-radius:14px;padding:16px 18px 14px;',
    '  box-shadow:0 18px 50px rgba(15,23,42,.28);',
    '  font-family:var(--font-family-base,"DM Sans",system-ui,sans-serif);line-height:1.55;}',
    '.cw-pop.is-enter{animation:cw-in .22s cubic-bezier(.2,.9,.3,1);}',
    '@keyframes cw-in{from{opacity:0;transform:translateY(6px) scale(.98);}}',
    '.cw-kicker{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;',
    '  color:var(--accent,#3560A8);font-weight:700;padding-right:22px;}',
    '.cw-title{font-size:16px;font-weight:700;margin:5px 0 6px;letter-spacing:-.01em;}',
    '.cw-body{font-size:13.5px;color:var(--text-secondary,#5a6474);}',
    '.cw-nav{display:flex;align-items:center;gap:8px;margin-top:14px;padding-top:12px;',
    '  border-top:1px solid var(--border-subtle,#eceff4);}',
    '.cw-dots{display:flex;gap:5px;margin-right:auto;}',
    '.cw-dot{width:6px;height:6px;border-radius:999px;background:var(--border-default,#d7dde7);',
    '  border:none;padding:0;cursor:pointer;transition:width .2s;}',
    '.cw-dot.is-on{background:var(--accent,#3560A8);width:16px;}',
    '.cw-btn{border-radius:8px;padding:7px 13px;font-size:13px;font-weight:600;cursor:pointer;',
    '  font-family:inherit;border:1px solid transparent;}',
    '.cw-btn.primary{background:var(--accent,#3560A8);color:var(--accent-on,#fff);}',
    '.cw-btn.ghost{background:transparent;color:var(--text-secondary,#5a6474);',
    '  border-color:var(--border-default,#d7dde7);}',
    '.cw-x{position:absolute;top:10px;right:12px;background:none;border:none;',
    '  color:var(--text-muted,#8a93a2);font-size:17px;line-height:1;cursor:pointer;padding:2px 4px;}',
    '.cw-x:hover{color:var(--text-primary,#101828);}',
    '@media (prefers-reduced-motion:reduce){.cw-pop.is-enter{animation:none;}}'
  ].join('');

  var block, spot, pop, raf = null;
  var state = { steps: [], i: 0, open: false };

  function build() {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    block = document.createElement('div'); block.className = 'cw-block';
    spot = document.createElement('div');  spot.className = 'cw-spot';
    pop = document.createElement('div');   pop.className = 'cw-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-live', 'polite');
    [block, spot, pop].forEach(function (el) { el.style.display = 'none'; document.body.appendChild(el); });

    // Launch button in the top bar, to the left of the primary + Add action.
    var bar = document.querySelector('.topbar');
    var addBtn = document.getElementById('addBtn');
    if (bar && addBtn) {
      var btn = document.createElement('button');
      btn.className = 'btn ghost';
      btn.id = 'cwBtn';
      btn.type = 'button';
      btn.textContent = '❓ Guide';
      btn.title = 'Walk me through the CRM';
      btn.onclick = open;
      bar.insertBefore(btn, addBtn);
    }
  }

  /* --- engine ------------------------------------------------------------ */
  function resolve(step) {
    if (!step || !step.target) return null;
    var el = $(step.target);
    return visible(el) ? el : null;
  }

  function open() {
    // Work out which steps this user can actually see. Owner-only controls are
    // hidden for client accounts, and a target on another tab is not measurable
    // until we switch to it — so run each step's before() during the pass.
    state.steps = STEPS.filter(function (s) {
      if (s.before) s.before();
      return !s.target || resolve(s);
    });
    closeOverlays();
    tab('contacts');
    if (!state.steps.length) return;

    state.i = 0;
    state.open = true;
    block.style.display = ''; spot.style.display = ''; pop.style.display = '';
    block.classList.add('show');
    document.addEventListener('keydown', onKey, true);
    render();
    if (raf === null) raf = requestAnimationFrame(loop);
  }

  function close(completed) {
    if (!state.open) return;
    state.open = false;
    block.classList.remove('show');
    [block, spot, pop].forEach(function (el) { el.style.display = 'none'; });
    document.removeEventListener('keydown', onKey, true);
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
    closeOverlays();
    tab('contacts');
    if (completed) markSeen();
  }

  function go(n) { if (n >= 0 && n < state.steps.length) { state.i = n; render(); } }
  function next() { state.i >= state.steps.length - 1 ? close(true) : go(state.i + 1); }

  function onKey(e) {
    if (!state.open) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(false); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(state.i - 1); }
  }

  function render() {
    var step = state.steps[state.i];
    var total = state.steps.length;
    var last = state.i === total - 1;

    if (step.before) step.before();

    var dots = state.steps.map(function (_, i) {
      return '<button type="button" class="cw-dot' + (i === state.i ? ' is-on' : '') +
             '" data-i="' + i + '" aria-label="Step ' + (i + 1) + '"></button>';
    }).join('');

    pop.innerHTML =
      '<button type="button" class="cw-x" aria-label="Close the guide">✕</button>' +
      '<div class="cw-kicker">CRM guide · ' + (state.i + 1) + ' of ' + total + '</div>' +
      '<div class="cw-title">' + esc(step.title) + '</div>' +
      '<div class="cw-body">' + esc(step.body) + '</div>' +
      '<div class="cw-nav"><div class="cw-dots">' + dots + '</div>' +
        (state.i > 0 ? '<button type="button" class="cw-btn ghost cw-back">Back</button>' : '') +
        '<button type="button" class="cw-btn primary cw-next">' + (last ? 'Done' : 'Next') + '</button>' +
      '</div>';

    pop.querySelector('.cw-x').onclick = function () { close(false); };
    pop.querySelector('.cw-next').onclick = next;
    var back = pop.querySelector('.cw-back');
    if (back) back.onclick = function () { go(state.i - 1); };
    pop.querySelectorAll('.cw-dot').forEach(function (d) {
      d.onclick = function () { go(parseInt(d.dataset.i, 10)); };
    });

    pop.classList.remove('is-enter');
    void pop.offsetWidth;                      // restart the entry animation
    pop.classList.add('is-enter');

    var el = resolve(step);
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    position();
    pop.querySelector('.cw-next').focus({ preventScroll: true });
  }

  function position() {
    var el = resolve(state.steps[state.i]);
    var vw = window.innerWidth, vh = window.innerHeight;
    var pad = 8, gap = 12, sx, sy, sw, sh;

    if (el) {
      var r = el.getBoundingClientRect();
      sw = Math.min(r.width + pad * 2, vw - 16);
      sh = Math.min(r.height + pad * 2, vh - 16);
      sx = Math.max(8, Math.min(r.left - pad, vw - sw - 8));
      sy = Math.max(8, Math.min(r.top - pad, vh - sh - 8));
      spot.classList.remove('is-centred');
    } else {
      sw = 0; sh = 0; sx = vw / 2; sy = vh / 2;
      spot.classList.add('is-centred');
    }
    spot.style.cssText += ';width:' + sw + 'px;height:' + sh + 'px;left:' + sx + 'px;top:' + sy + 'px;';

    var pr = pop.getBoundingClientRect(), pw = pr.width, ph = pr.height;
    var top, left, beside = false;

    if (!el) {
      top = Math.max(12, (vh - ph) / 2);
      left = Math.max(12, (vw - pw) / 2);
    } else {
      if (sy + sh + gap + ph <= vh - 12) top = sy + sh + gap;          // below
      else if (sy - gap - ph >= 12) top = sy - gap - ph;               // above
      else { top = Math.max(12, Math.min(sy, vh - ph - 12)); beside = true; }
      left = beside
        ? (sx + sw + gap + pw <= vw - 12 ? sx + sw + gap : Math.max(12, sx - gap - pw))
        : Math.max(12, Math.min(sx, vw - pw - 12));
    }
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  }

  // Track the target every frame so the spotlight stays on it while the page
  // scrolls, resizes or re-renders underneath.
  function loop() {
    if (!state.open) { raf = null; return; }
    position();
    raf = requestAnimationFrame(loop);
  }

  /* --- init -------------------------------------------------------------- */
  function init() {
    build();
    // First visit: run it by itself. Wait for the first contacts render so the
    // page is not still empty when the tour starts talking about it.
    if (!seen()) setTimeout(function () { if (!state.open) open(); }, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.odCrmGuide = open;          // so anything else can launch it
})();
