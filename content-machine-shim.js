// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for the Content Machine app (content-machine-supabase.html)
// ════════════════════════════════════════════════════════════════
// The app (github.com/chaichoong/content-machine) uses ONE Airtable table
// (tblEPzZdwBZeSXFRB) read/written by FIELD NAME (no returnFieldsByFieldId) with
// full CRUD. Stored in Supabase as a name-keyed `fields` jsonb blob. AI (BYO keys +
// content-machine-proxy worker) and everything else pass straight through.
(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';
  const TABLE = 'tblEPzZdwBZeSXFRB';
  let _sb = null;
  function sbc() { if (!_sb) _sb = window.supabase.createClient(SB_URL, SB_ANON, { auth: { persistSession: true, storageKey: '_dlr_sb_app' } }); return _sb; }
  window.sbCM = sbc;
  let _sessReady = null;
  function ensureSession() { if (!_sessReady) _sessReady = sbc().auth.getSession().catch(() => {}); return _sessReady; }

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const rec = row => ({ id: row.id, createdTime: (row.created_at || null), fields: row.fields || {}, cellValuesByFieldId: row.fields || {} });

  async function readList(url) {
    // The app calls this in a loop with ?pageSize=100 and paginates on the
    // returned `offset`. We return ALL rows in one page and NO offset, so the
    // loop stops after a single pass. `pageSize` is the app's page size, NOT a
    // total cap — honouring it would truncate the dataset to 100 records.
    await ensureSession();
    const rows = []; const page = 1000; let from = 0;
    for (;;) {
      const { data, error } = await sbc().from('content_machine').select('*').range(from, from + page - 1);
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < page) break;
      from += page;
    }
    return { records: rows.map(rec) };   // no offset → app's pagination loop stops
  }
  async function readOne(id) {
    await ensureSession();
    const { data, error } = await sbc().from('content_machine').select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return rec(data);
  }

  const realFetch = window.fetch.bind(window);
  const AT_RE = new RegExp(`https://api\\.airtable\\.com/v0/${BASE}/([^/?]+)(?:/([^/?]+))?`);

  window.fetch = async function (input, init = {}) {
    const urlStr = (typeof input === 'string') ? input : (input && (input.url || input.href)) || '';
    try {
      const m = AT_RE.exec(urlStr);
      if (m && m[1] === TABLE) {
        const recId = m[2];
        const method = (init.method || 'GET').toUpperCase();
        const url = new URL(urlStr);
        if (method === 'GET') return json(recId ? await readOne(recId) : await readList(url));
        if (method === 'POST') {   // create: { records:[{fields}], typecast }
          const b = JSON.parse(init.body || '{}');
          const recs = Array.isArray(b.records) ? b.records : [{ fields: b.fields || {} }];
          const out = [];
          for (const r of recs) {
            const { data, error } = await sbc().from('content_machine').insert({ fields: r.fields || {} }).select().single();
            if (error) return json({ error: { message: error.message } }, 422);
            out.push(rec(data));
          }
          return json(Array.isArray(b.records) ? { records: out } : out[0]);
        }
        if (method === 'PATCH') {   // update single: { fields }
          const b = JSON.parse(init.body || '{}');
          if (Array.isArray(b.records)) {
            const out = [];
            for (const r of b.records) {
              const { data: ex } = await sbc().from('content_machine').select('fields').eq('id', r.id).single();
              const merged = { ...((ex && ex.fields) || {}), ...(r.fields || {}) };
              await sbc().from('content_machine').update({ fields: merged }).eq('id', r.id);
              out.push({ id: r.id, fields: merged });
            }
            return json({ records: out });
          }
          await ensureSession();
          const { data: ex } = await sbc().from('content_machine').select('fields').eq('id', recId).single();
          const merged = { ...((ex && ex.fields) || {}), ...((b.fields) || {}) };
          const { error } = await sbc().from('content_machine').update({ fields: merged }).eq('id', recId);
          if (error) return json({ error: { message: error.message } }, 422);
          return json({ id: recId, fields: merged });
        }
        if (method === 'DELETE') {
          const url2 = new URL(urlStr);
          const ids = url2.searchParams.getAll('records[]');
          const targets = ids.length ? ids : [recId];
          await sbc().from('content_machine').delete().in('id', targets);
          return json(ids.length ? { records: targets.map(id => ({ id, deleted: true })) } : { id: recId, deleted: true });
        }
      }
    } catch (e) {
      console.error('[cm-shim] error for', urlStr, e);
      return json({ error: { message: String(e.message || e) } }, 500);
    }
    return realFetch(input, init);   // AI proxy (BYO keys) + everything else
  };

  window.sbCMSignIn  = (email, password) => sbc().auth.signInWithPassword({ email, password });
  window.sbCMSession = () => sbc().auth.getSession().then(r => r.data.session);
  console.log('[cm-shim] Supabase Content Machine shim active →', SB_URL);
})();
