// comms-boot.js — Supabase login gate for the Inbound Comms clone.
// The page still uses Google OAuth for Gmail; this adds a Supabase login IN FRONT,
// so the shim's task queries have a session.
//
// IMPORTANT: this origin (chaichoong.github.io) shares ONE localStorage between the
// live Airtable page (follow-up.html) and this Supabase clone. The clone must NEVER
// write the shared `airtable_pat` key — doing so overwrites the live site's real
// Airtable token and breaks task-creation there ("Authentication required").
// Instead we satisfy the page's write-gate purely in memory by overriding
// getAirtablePat() to return a truthy dummy. The shim intercepts every Airtable call
// and routes it to Supabase, so the dummy is never sent anywhere real.
(function () {
  window.__SB_CLONE__ = true;

  // Override the page's token getter in memory only (no localStorage writes).
  // The page declares `function getAirtablePat()` in its inline body script, which
  // runs during body parse — before DOMContentLoaded — so re-assigning it here wins.
  function installPatShim() { try { window.getAirtablePat = function () { return 'supabase'; }; } catch (e) {} }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installPatShim);
  else installPatShim();
  window.addEventListener('load', installPatShim);

  function overlay() {
    const d = document.createElement('div');
    d.id = 'sbLoginOverlay';
    d.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#F1F3EF;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif';
    d.innerHTML =
      '<div style="background:#fff;border:1px solid #DDE1D9;border-radius:12px;padding:28px;width:340px;box-shadow:0 8px 24px rgba(0,0,0,.08)">' +
      '<div style="font-size:18px;font-weight:700;color:#1C2422">Inbound Comms — Supabase</div>' +
      '<div style="font-size:13px;color:#5A6660;margin:2px 0 16px">Sign in (then connect Gmail on the next screen)</div>' +
      '<input id="sbEmail" type="email" placeholder="Email" value="kevin@operationsdirector.co.uk" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DDE1D9;border-radius:8px;margin-bottom:8px">' +
      '<input id="sbPass" type="password" placeholder="Password" style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #DDE1D9;border-radius:8px;margin-bottom:12px">' +
      '<button id="sbGo" style="width:100%;background:#2C6E49;color:#fff;border:0;padding:10px;border-radius:8px;font-weight:600;cursor:pointer">Sign in</button>' +
      '<div id="sbErr" style="color:#B42318;font-size:12px;margin-top:8px;display:none"></div></div>';
    return d;
  }

  // Inbound Comms is a PAID ADD-ON. Only a workspace whose org_modules has
  // inbound_comms enabled may see it. Gate DIRECT access (the shell nav already
  // hides it); fail-CLOSED so a client can never reach a tool they haven't bought.
  async function isEntitled() {
    try {
      // RULE: the main/owner account always has every add-on (incl. new ones).
      const { data: u } = await window.sbComms().auth.getUser();
      if (u && u.user && u.user.email && u.user.email.toLowerCase() === 'kevin@operationsdirector.co.uk') return true;
      const { data } = await window.sbComms().from('org_modules').select('enabled').eq('module_key', 'inbound_comms').maybeSingle();
      return !!(data && data.enabled);
    } catch (e) { return false; }
  }
  function moduleGate() {
    const d = document.createElement('div');
    d.id = 'sbModuleGate';
    d.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#F1F3EF;display:flex;align-items:center;justify-content:center;font-family:Inter,system-ui,sans-serif';
    d.innerHTML =
      '<div style="background:#fff;border:1px solid #DDE1D9;border-radius:12px;padding:32px;max-width:420px;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.08)">' +
      '<div style="font-size:30px;margin-bottom:10px">🔒</div>' +
      '<div style="font-size:18px;font-weight:700;color:#1C2422;margin-bottom:6px">Inbound Comms isn’t in your plan</div>' +
      '<div style="font-size:13px;color:#5A6660;line-height:1.5">This is a paid add-on. Contact your account manager to add it to your workspace.</div></div>';
    return d;
  }

  function showLogin() {
    const ov = overlay();
    document.body.appendChild(ov);
    const err = ov.querySelector('#sbErr');
    async function attempt() {
      err.style.display = 'none';
      const email = ov.querySelector('#sbEmail').value.trim();
      const pass = ov.querySelector('#sbPass').value;
      const { error } = await window.sbCommsSignIn(email, pass);
      if (error) { err.textContent = error.message; err.style.display = 'block'; return; }
      ov.remove();
      if (!(await isEntitled())) document.body.appendChild(moduleGate());   // reveal only if bought
    }
    ov.querySelector('#sbGo').addEventListener('click', attempt);
    ov.querySelector('#sbPass').addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
  }

  async function start() {
    // Opaque cover up-front so the tool never flashes before we know the plan.
    const cover = document.createElement('div');
    cover.id = 'sbBootCover';
    cover.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#F1F3EF';
    (document.body || document.documentElement).appendChild(cover);
    let sess = null;
    try { sess = await window.sbCommsSession(); } catch (e) {}
    if (!sess) { cover.remove(); showLogin(); return; }        // no session → login
    if (!(await isEntitled())) { document.body.appendChild(moduleGate()); cover.remove(); return; }  // not bought → gate
    cover.remove();   // signed in AND entitled → let the page's Google auth proceed
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
