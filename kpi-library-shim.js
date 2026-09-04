// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for the KPI Library (kpi-library-supabase.html)
// ════════════════════════════════════════════════════════════════
// The KPI Library is a mostly-STATIC reference (KPI_LIBRARY templates live in
// js/kpi-library.js). Its only live read is the Projects table — the "live right
// now" panel showing which templates run on a real project today. This routes that
// ONE read → Supabase v_projects (already migrated), returning Airtable-shaped
// records keyed by field id (the page fetches with returnFieldsByFieldId=true).
// Every other Airtable call returns empty; non-Airtable calls pass through.
//
// KPI Library is OWNER-ONLY (admin tool, never sold to clients). The boot gates on
// the owner email; RLS still scopes v_projects to the owner's org regardless.

(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';
  const OWNER_LOGIN = 'kevin@operationsdirector.co.uk';

  try { if (!window.PAT) window.PAT = 'supabase'; } catch (e) {}

  let _sb = null;
  function sbc() {
    if (!_sb) _sb = window.supabase.createClient(SB_URL, SB_ANON, { auth: { persistSession: true, storageKey: '_dlr_sb_app' } });
    return _sb;
  }
  window.sbKpi = sbc;

  const PROJECTS = 'tblHrpTMd5LNYn8v1';
  // Airtable field id → v_projects column (only the fields KPILIB_PROJ_F reads).
  const PROJ_MAP = {
    fldiMZICg1KOORpte: 'name',
    fldABYFMf2yBKWdlD: 'kpi_name',
    fldrYZEghROXYf6w0: 'kpi_unit',
    fldaI0voHia91SYZz: 'kpi_target',
    fldB1QJDUsukxKzjQ: 'kpi_current',
    fldA7vPiLnbgEoKh1: 'kpi_compute_code',
    // kpiLastUpdated + closedOn have no v_projects column → omitted (last-updated
    // shows blank; the closed filter is approximated by "kpi_name present" below).
  };

  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

  async function readProjects() {
    const cols = ['id'].concat(Object.values(PROJ_MAP));
    let data;
    try {
      // Safety timeout: a slow/hanging view read must NEVER freeze the library
      // behind its spinner. On timeout/error we fall back to an empty live panel;
      // the static template library still renders.
      const q = sbc().from('v_projects').select(cols.join(','));
      const res = await Promise.race([
        q,
        new Promise((_, rej) => setTimeout(() => rej(new Error('v_projects timed out')), 6000)),
      ]);
      if (res.error) throw new Error(res.error.message);
      data = res.data;
    } catch (e) {
      console.warn('[kpi-shim] live-KPI read skipped:', e.message);
      return { records: [] };
    }
    // Only rows with a KPI name (the page's main filter: {KPI Name} != "").
    const rows = (data || []).filter(r => r.kpi_name != null && String(r.kpi_name).trim() !== '');
    return {
      records: rows.map(r => {
        const fields = {};
        for (const fid in PROJ_MAP) {
          const v = r[PROJ_MAP[fid]];
          if (v !== null && v !== undefined && v !== '') fields[fid] = v;
        }
        return { id: r.id, createdTime: r.created_at, fields };
      }),
    };
  }

  const _realFetch = window.fetch.bind(window);
  const AT_RE = new RegExp(`https://api\\.airtable\\.com/v0/${BASE}/([^/?]+)`);

  window.fetch = async function (input, init = {}) {
    const urlStr = (typeof input === 'string') ? input : (input && (input.url || input.href)) || '';
    try {
      const m = AT_RE.exec(urlStr);
      if (m) {
        const tableId = m[1];
        const method = (init.method || 'GET').toUpperCase();
        if (tableId === PROJECTS && method === 'GET') return json(await readProjects());
        // Any other Airtable call → empty / swallow (KPI Library never writes).
        if (method === 'GET') return json({ records: [] });
        return json({ id: 'noop', fields: {} });
      }
    } catch (e) {
      console.error('[kpi-shim] error for', urlStr, e);
      return json({ error: { message: String(e.message || e) } }, 500);
    }
    return _realFetch(input, init);
  };

  window.sbKpiSignIn  = (email, password) => sbc().auth.signInWithPassword({ email, password });
  window.sbKpiSession = () => sbc().auth.getSession().then(r => r.data.session);
  window.sbKpiIsOwner = async function () {
    try {
      // Read the email from the LOCAL session (instant, no network). getUser() makes
      // a /user network call that can be slow inside an embedded frame and leave the
      // boot's opaque cover up — a blank page. getSession() is synchronous-fast.
      const { data } = await sbc().auth.getSession();
      const email = data && data.session && data.session.user && data.session.user.email;
      return !!(email && email.toLowerCase() === OWNER_LOGIN);
    } catch (e) { return false; }
  };
  console.log('[kpi-shim] Supabase KPI Library shim active →', SB_URL);
})();
