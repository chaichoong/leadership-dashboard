// prospecting-boot.js — login + add-on entitlement gate for the Prospecting twin.
// Prospecting is a PAID ADD-ON. After login, checks the org_modules 'prospecting'
// flag (via the shim's helper) and shows a "not in your plan" lock for anyone who
// hasn't bought it — fail-CLOSED on any error, with an opaque cover up-front so the
// tool never flashes before the plan is known. On success, boots the app's loader.
(function () {
  window.__SB_CLONE__ = true;

  function overlay() {
    const d = document.createElement('div');
    d.id = 'sbLoginOverlay';
    d.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#F1F3EF;display:flex;align-items:center;justify-content:center;font-family:"DM Sans",system-ui,sans-serif';
    d.innerHTML =
      '<div style="background:#fff;border:1px solid #DDE1D9;border-radius:12px;padding:28px;width:340px;box-shadow:0 8px 24px rgba(0,0,0,.08)">' +
      '<div style="font-size:18px;font-weight:700;color:#1C2422">Prospecting — Supabase</div>' +
      '<div style="font-size:13px;color:#5A6660;margin:2px 0 16px">Sign in to load your pipeline</div>' +
      '<input id="sbEmail" type="email" placeholder="Email" value="kevin@operationsdirector.co.uk" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DDE1D9;background:#fff;color:#1C2422;border-radius:8px;margin-bottom:8px">' +
      '<input id="sbPass" type="password" placeholder="Password" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DDE1D9;background:#fff;color:#1C2422;border-radius:8px;margin-bottom:12px">' +
      '<button id="sbGo" style="width:100%;background:#2C6E49;color:#fff;border:0;padding:10px;border-radius:8px;font-weight:600;cursor:pointer">Sign in</button>' +
      '<div id="sbErr" style="color:#B42318;font-size:12px;margin-top:8px;display:none"></div></div>';
    return d;
  }
  function moduleGate() {
    const d = document.createElement('div');
    d.id = 'sbModuleGate';
    d.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#F1F3EF;display:flex;align-items:center;justify-content:center;font-family:"DM Sans",system-ui,sans-serif';
    d.innerHTML =
      '<div style="background:#fff;border:1px solid #DDE1D9;border-radius:12px;padding:32px;max-width:420px;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.08)">' +
      '<div style="font-size:30px;margin-bottom:10px">🔒</div>' +
      '<div style="font-size:18px;font-weight:700;color:#1C2422;margin-bottom:6px">Prospecting isn’t in your plan</div>' +
      '<div style="font-size:13px;color:#5A6660;line-height:1.5">This is a paid add-on. Contact your account manager to add it to your workspace.</div></div>';
    return d;
  }

  function proceed() {
    // Deferred app scripts have run by DOMContentLoaded; poll briefly just in case.
    let tries = 0;
    (function go() {
      if (typeof loadProspectingTab === 'function') { loadProspectingTab(); return; }
      if (tries++ < 40) setTimeout(go, 50);
    })();
  }

  function showLogin() {
    const ov = overlay();
    document.body.appendChild(ov);
    const err = ov.querySelector('#sbErr');
    async function attempt() {
      err.style.display = 'none';
      const email = ov.querySelector('#sbEmail').value.trim();
      const pass = ov.querySelector('#sbPass').value;
      const { error } = await window.sbProspectingSignIn(email, pass);
      if (error) { err.textContent = error.message; err.style.display = 'block'; return; }
      if (!(await window.sbProspectingEntitled())) { ov.remove(); document.body.appendChild(moduleGate()); return; }
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
    try { sess = await window.sbProspectingSession(); } catch (e) {}
    if (!sess) { cover.remove(); showLogin(); return; }                     // no session → login
    if (!(await window.sbProspectingEntitled())) { document.body.appendChild(moduleGate()); cover.remove(); return; }  // not bought → lock
    cover.remove(); proceed();                                              // signed in AND entitled → load
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
