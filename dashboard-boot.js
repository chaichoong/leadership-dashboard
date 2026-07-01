// dashboard-boot.js — login gate + clone flag for the Supabase Leadership Dashboard.
// Sets window.__SB_CLONE__ (isolates the IndexedDB cache from the live site), then
// gates the dashboard's data load on a Supabase login. Loads BEFORE the app scripts.
(function () {
  window.__SB_CLONE__ = true;   // must be set before dashboard.js reads its cache constants

  function overlay() {
    const d = document.createElement('div');
    d.id = 'sbLoginOverlay';
    d.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#F1F3EF;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif';
    d.innerHTML =
      '<div style="background:#fff;border:1px solid #DDE1D9;border-radius:12px;padding:28px;width:340px;box-shadow:0 8px 24px rgba(0,0,0,.08)">' +
      '<div style="font-size:18px;font-weight:700;color:#1C2422">Leadership Dashboard — Supabase</div>' +
      '<div style="font-size:13px;color:#5A6660;margin:2px 0 16px">Sign in to load your dashboard</div>' +
      '<input id="sbEmail" type="email" placeholder="Email" value="kevin@operationsdirector.co.uk" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DDE1D9;border-radius:8px;margin-bottom:8px">' +
      '<input id="sbPass" type="password" placeholder="Password" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DDE1D9;border-radius:8px;margin-bottom:12px">' +
      '<button id="sbGo" style="width:100%;background:#2C6E49;color:#fff;border:0;padding:10px;border-radius:8px;font-weight:600;cursor:pointer">Sign in</button>' +
      '<div id="sbErr" style="color:#B42318;font-size:12px;margin-top:8px;display:none"></div></div>';
    return d;
  }

  function proceed() {
    try { localStorage.setItem('_dlr_pat', 'supabase'); } catch (e) {}
    const as = document.getElementById('authScreen'); if (as) as.style.display = 'none';
    if (typeof loadDashboard === 'function') loadDashboard();
  }

  async function start() {
    // Hide the app's Airtable-PAT screen — we use Supabase auth instead.
    const as = document.getElementById('authScreen'); if (as) as.style.display = 'none';
    let sess = null;
    try { sess = await window.sbDashSession(); } catch (e) {}
    if (sess) { proceed(); return; }
    const ov = overlay();
    document.body.appendChild(ov);
    const err = ov.querySelector('#sbErr');
    async function attempt() {
      err.style.display = 'none';
      const email = ov.querySelector('#sbEmail').value.trim();
      const pass = ov.querySelector('#sbPass').value;
      const { error } = await window.sbDashSignIn(email, pass);
      if (error) { err.textContent = error.message; err.style.display = 'block'; return; }
      ov.remove(); proceed();
    }
    ov.querySelector('#sbGo').addEventListener('click', attempt);
    ov.querySelector('#sbPass').addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
