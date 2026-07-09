// content-machine-boot.js — Supabase login gate for the Content Machine clone.
// The app gates on localStorage `cm_at_key` (its Airtable token). This origin's
// localStorage is SHARED with the live content-machine app, so we seed cm_at_key
// only-if-empty (never clobber the live app's real key — the shim ignores the
// value anyway) and show a Supabase login overlay if there's no session yet.
(function () {
  window.__SB_CLONE__ = true;
  try { if (!localStorage.getItem('cm_at_key')) localStorage.setItem('cm_at_key', 'supabase'); } catch (e) {}

  function overlay() {
    const d = document.createElement('div');
    d.id = 'sbLoginOverlay';
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#141915;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif';
    d.innerHTML =
      '<div style="background:#1d241f;border:1px solid #2c352d;border-radius:12px;padding:28px;width:340px;box-shadow:0 8px 24px rgba(0,0,0,.35)">' +
      '<div style="font-size:18px;font-weight:700;color:#EAEFEA">Content Machine — Supabase</div>' +
      '<div style="font-size:13px;color:#9aa39b;margin:2px 0 16px">Sign in to load your content</div>' +
      '<input id="sbEmail" type="email" placeholder="Email" value="kevin@operationsdirector.co.uk" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #2c352d;background:#141915;color:#EAEFEA;border-radius:8px;margin-bottom:8px">' +
      '<input id="sbPass" type="password" placeholder="Password" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #2c352d;background:#141915;color:#EAEFEA;border-radius:8px;margin-bottom:12px">' +
      '<button id="sbGo" style="width:100%;background:#2C6E49;color:#fff;border:0;padding:10px;border-radius:8px;font-weight:600;cursor:pointer">Sign in</button>' +
      '<div id="sbErr" style="color:#e0736b;font-size:12px;margin-top:8px;display:none"></div></div>';
    return d;
  }

  async function start() {
    let sess = null;
    try { sess = await window.sbCMSession(); } catch (e) {}
    if (sess) return;   // shared shell session — the app loads; the shim waits for it too
    const ov = overlay();
    document.body.appendChild(ov);
    const err = ov.querySelector('#sbErr');
    async function attempt() {
      err.style.display = 'none';
      const email = ov.querySelector('#sbEmail').value.trim();
      const pass = ov.querySelector('#sbPass').value;
      const { error } = await window.sbCMSignIn(email, pass);
      if (error) { err.textContent = error.message; err.style.display = 'block'; return; }
      ov.remove(); location.reload();   // re-run the app now that a session exists
    }
    ov.querySelector('#sbGo').addEventListener('click', attempt);
    ov.querySelector('#sbPass').addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
