// strategy-boot.js — Supabase login gate for the Objective & Strategy clone.
// strategy.js runs its own auth IIFE on load (reads _dlr_pat, then initApp()).
// To (a) gate that on a real Supabase login and (b) not clobber the shared token,
// this boot loads strategy.js DYNAMICALLY only after a session exists, and seeds
// _dlr_pat only if it's empty (never overwrites a real token — the shim ignores
// the value anyway). Mirrors the shared-origin safety used on the other clones.
(function () {
  window.__SB_CLONE__ = true;
  try { if (!localStorage.getItem('_dlr_pat')) localStorage.setItem('_dlr_pat', 'supabase'); } catch (e) {}

  const STRATEGY_SRC = 'strategy.js?v=48';
  function loadStrategy() {
    const s = document.createElement('script');
    s.src = STRATEGY_SRC;
    document.body.appendChild(s);   // its init IIFE runs now, with the shim + session in place
  }

  function overlay() {
    const d = document.createElement('div');
    d.id = 'sbLoginOverlay';
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#F1F3EF;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif';
    d.innerHTML =
      '<div style="background:#fff;border:1px solid #DDE1D9;border-radius:12px;padding:28px;width:340px;box-shadow:0 8px 24px rgba(0,0,0,.08)">' +
      '<div style="font-size:18px;font-weight:700;color:#1C2422">Objective &amp; Strategy — Supabase</div>' +
      '<div style="font-size:13px;color:#5A6660;margin:2px 0 16px">Sign in to load your strategy</div>' +
      '<input id="sbEmail" type="email" placeholder="Email" value="kevin@operationsdirector.co.uk" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DDE1D9;border-radius:8px;margin-bottom:8px">' +
      '<input id="sbPass" type="password" placeholder="Password" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DDE1D9;border-radius:8px;margin-bottom:12px">' +
      '<button id="sbGo" style="width:100%;background:#2C6E49;color:#fff;border:0;padding:10px;border-radius:8px;font-weight:600;cursor:pointer">Sign in</button>' +
      '<div id="sbErr" style="color:#B42318;font-size:12px;margin-top:8px;display:none"></div></div>';
    return d;
  }

  async function start() {
    let sess = null;
    try { sess = await window.sbStrategySession(); } catch (e) {}
    if (sess) { loadStrategy(); return; }
    const ov = overlay();
    document.body.appendChild(ov);
    const err = ov.querySelector('#sbErr');
    async function attempt() {
      err.style.display = 'none';
      const email = ov.querySelector('#sbEmail').value.trim();
      const pass = ov.querySelector('#sbPass').value;
      const { error } = await window.sbStrategySignIn(email, pass);
      if (error) { err.textContent = error.message; err.style.display = 'block'; return; }
      ov.remove(); loadStrategy();
    }
    ov.querySelector('#sbGo').addEventListener('click', attempt);
    ov.querySelector('#sbPass').addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
