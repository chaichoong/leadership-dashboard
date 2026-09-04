// kpi-library-boot.js — login + OWNER-ONLY gate for the KPI Library twin.
// The KPI Library is an admin/owner reference tool — NEVER shown to clients (the
// shell already hides it from non-owners). This gates DIRECT access to the page:
// only the owner passes; anyone else gets an "admin only" screen. Fail-CLOSED, with
// an opaque cover up-front so the tool never flashes before identity is known.
(function () {
  window.__SB_CLONE__ = true;

  function overlay() {
    const d = document.createElement('div');
    d.id = 'sbLoginOverlay';
    d.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#F1F3EF;display:flex;align-items:center;justify-content:center;font-family:"DM Sans",system-ui,sans-serif';
    d.innerHTML =
      '<div style="background:#fff;border:1px solid #DDE1D9;border-radius:12px;padding:28px;width:340px;box-shadow:0 8px 24px rgba(0,0,0,.08)">' +
      '<div style="font-size:18px;font-weight:700;color:#1C2422">KPI Library — Supabase</div>' +
      '<div style="font-size:13px;color:#5A6660;margin:2px 0 16px">Sign in to load the library</div>' +
      '<input id="sbEmail" type="email" placeholder="Email" value="kevin@operationsdirector.co.uk" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DDE1D9;background:#fff;color:#1C2422;border-radius:8px;margin-bottom:8px">' +
      '<input id="sbPass" type="password" placeholder="Password" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DDE1D9;background:#fff;color:#1C2422;border-radius:8px;margin-bottom:12px">' +
      '<button id="sbGo" style="width:100%;background:#2C6E49;color:#fff;border:0;padding:10px;border-radius:8px;font-weight:600;cursor:pointer">Sign in</button>' +
      '<div id="sbErr" style="color:#B42318;font-size:12px;margin-top:8px;display:none"></div></div>';
    return d;
  }
  function ownerGate() {
    const d = document.createElement('div');
    d.id = 'sbOwnerGate';
    d.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#F1F3EF;display:flex;align-items:center;justify-content:center;font-family:"DM Sans",system-ui,sans-serif';
    d.innerHTML =
      '<div style="background:#fff;border:1px solid #DDE1D9;border-radius:12px;padding:32px;max-width:420px;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.08)">' +
      '<div style="font-size:30px;margin-bottom:10px">🔒</div>' +
      '<div style="font-size:18px;font-weight:700;color:#1C2422;margin-bottom:6px">Not available on your plan</div>' +
      '<div style="font-size:13px;color:#5A6660;line-height:1.5">The KPI Library is an internal admin tool.</div></div>';
    return d;
  }

  function proceed() {
    let rendered = false;
    function doRender() {
      if (rendered) return true;
      if (typeof renderKpiLibraryTab !== 'function') return false;   // deferred scripts not ready yet
      rendered = true;
      // config.js declares a global `let PAT = ''` the live app fills via shared.js
      // (not loaded here); satisfy the app's PAT guard. The shim routes the one
      // Projects read to Supabase, so the value is unused.
      try { PAT = 'supabase'; } catch (e) {}
      // Render the STATIC template library immediately — pre-set the live-rows cache
      // so renderKpiLibraryTab does NOT block on (or spin waiting for) the live-KPI
      // fetch. This guarantees the library shows even if that read is slow.
      try { _kpiLibLiveRows = []; } catch (e) {}
      try { renderKpiLibraryTab(); } catch (e) { console.error('[kpi-boot] render failed', e); }
      // Then fill the "live right now" panel in the background (no spinner, no block).
      try {
        if (typeof kpiLibFetchLive === 'function') {
          kpiLibFetchLive()
            .then(rows => { try { _kpiLibLiveRows = rows; renderKpiLibraryTab(); } catch (e) {} })
            .catch(() => {});
        }
      } catch (e) {}
      return true;
    }
    if (doRender()) return;
    // Poll up to ~10s in case the deferred app scripts load slowly, plus a
    // window-load fallback — so the render can never be silently skipped.
    let tries = 0;
    const iv = setInterval(() => { if (doRender() || ++tries > 200) clearInterval(iv); }, 50);
    window.addEventListener('load', doRender);
  }

  function showLogin() {
    const ov = overlay();
    document.body.appendChild(ov);
    const err = ov.querySelector('#sbErr');
    async function attempt() {
      err.style.display = 'none';
      const email = ov.querySelector('#sbEmail').value.trim();
      const pass = ov.querySelector('#sbPass').value;
      const { error } = await window.sbKpiSignIn(email, pass);
      if (error) { err.textContent = error.message; err.style.display = 'block'; return; }
      if (!(await window.sbKpiIsOwner())) { ov.remove(); document.body.appendChild(ownerGate()); return; }
      ov.remove(); proceed();
    }
    ov.querySelector('#sbGo').addEventListener('click', attempt);
    ov.querySelector('#sbPass').addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
  }

  async function start() {
    const cover = document.createElement('div');
    cover.id = 'sbBootCover';
    cover.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#F1F3EF';
    (document.body || document.documentElement).appendChild(cover);
    let sess = null;
    try { sess = await window.sbKpiSession(); } catch (e) {}
    if (!sess) { cover.remove(); showLogin(); return; }                    // no session → login
    if (!(await window.sbKpiIsOwner())) { document.body.appendChild(ownerGate()); cover.remove(); return; }  // not owner → blocked
    cover.remove(); proceed();                                             // owner → load
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
