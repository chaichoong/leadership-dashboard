// ai-brain-boot.js — Supabase login gate for the AI Brain clone.
// ai-brain.html reads PAT from localStorage._dlr_pat at parse time; if empty it
// shows "Sign in to the dashboard". This boot (loaded in <head>, before the page's
// inline script) seeds _dlr_pat only-if-empty (never clobbers the shared token —
// the shim ignores the value), and shows a Supabase login overlay if there's no
// session yet (standalone). In the shell a shared session already exists.
(function () {
  window.__SB_CLONE__ = true;
  try { if (!localStorage.getItem('_dlr_pat')) localStorage.setItem('_dlr_pat', 'supabase'); } catch (e) {}

  function overlay() {
    const d = document.createElement('div');
    d.id = 'sbLoginOverlay';
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#F1F3EF;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif';
    d.innerHTML =
      '<div style="background:#fff;border:1px solid #DDE1D9;border-radius:12px;padding:28px;width:340px;box-shadow:0 8px 24px rgba(0,0,0,.08)">' +
      '<div style="font-size:18px;font-weight:700;color:#1C2422">AI Brain — Supabase</div>' +
      '<div style="font-size:13px;color:#5A6660;margin:2px 0 16px">Sign in to load your brain</div>' +
      '<input id="sbEmail" type="email" placeholder="Email" value="kevin@operationsdirector.co.uk" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DDE1D9;border-radius:8px;margin-bottom:8px">' +
      '<input id="sbPass" type="password" placeholder="Password" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DDE1D9;border-radius:8px;margin-bottom:12px">' +
      '<button id="sbGo" style="width:100%;background:#2C6E49;color:#fff;border:0;padding:10px;border-radius:8px;font-weight:600;cursor:pointer">Sign in</button>' +
      '<div id="sbErr" style="color:#B42318;font-size:12px;margin-top:8px;display:none"></div></div>';
    return d;
  }

  async function start() {
    let sess = null;
    try { sess = await window.sbBrainSession(); } catch (e) {}
    if (sess) return;   // shared shell session — let the page load
    const ov = overlay();
    document.body.appendChild(ov);
    const err = ov.querySelector('#sbErr');
    async function attempt() {
      err.style.display = 'none';
      const email = ov.querySelector('#sbEmail').value.trim();
      const pass = ov.querySelector('#sbPass').value;
      const { error } = await window.sbBrainSignIn(email, pass);
      if (error) { err.textContent = error.message; err.style.display = 'block'; return; }
      ov.remove();
      if (typeof window.loadToday === 'function') window.loadToday(true);   // now that a session exists
    }
    ov.querySelector('#sbGo').addEventListener('click', attempt);
    ov.querySelector('#sbPass').addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
