// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for the AI Brain page (ai-brain-supabase.html)
// ════════════════════════════════════════════════════════════════
// One table: the "AI Brain Today" feed (Airtable tblZ75JgE1wzDP0ps), read by
// field NAME (no returnFieldsByFieldId) and updated with a Status:'resolved'
// PATCH. Stored in Supabase as a name-keyed `fields` jsonb blob. The "ask your
// brain" postMessage to the parent shell is untouched (passes through).
// NOTE: the feed is populated by external nightly automation into Airtable; this
// Supabase copy is a snapshot until a sync bridge is added.
(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';
  const TABLE = 'tblZ75JgE1wzDP0ps';
  // The "Feed your brain" capture lanes (Add note / video / document) POST to a
  // second Airtable table. Route those writes to Supabase so the buttons save
  // instead of hitting Airtable with the dummy token. Stored name-keyed like the
  // feed. (Requires migration 0041_ai_brain_inbox.sql; until it runs, the insert
  // errors and the page shows a friendly "couldn't save" — never a crash.)
  const INBOX = 'tbliR8KkOV4SKNiIZ';
  let _sb = null;
  function sbc() { if (!_sb) _sb = window.supabase.createClient(SB_URL, SB_ANON, { auth: { persistSession: true, storageKey: '_dlr_sb_app' } }); return _sb; }
  window.sbBrain = sbc;

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  async function readAll() {
    const rows = []; const page = 1000; let from = 0;
    for (;;) {
      const { data, error } = await sbc().from('ai_brain_today').select('*').range(from, from + page - 1);
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < page) break;
      from += page;
    }
    // page reads r.fields by NAME → return the name-keyed blob straight through
    return { records: rows.map(r => ({ id: r.id, fields: r.fields || {}, cellValuesByFieldId: r.fields || {} })) };
  }
  async function patchOne(id, fields) {
    const { data: existing } = await sbc().from('ai_brain_today').select('fields').eq('id', id).single();
    const merged = { ...((existing && existing.fields) || {}), ...(fields || {}) };
    const { error } = await sbc().from('ai_brain_today').update({ fields: merged }).eq('id', id);
    if (error) return json({ error: { message: error.message } }, 422);
    return json({ id, fields: merged });
  }
  // Airtable batch-create shape: { records: [{ fields: {...} }] } → insert each
  // row's name-keyed fields blob into ai_brain_inbox. org_id is stamped by the
  // table's column default (RLS), so the client only sends the fields.
  async function insertInbox(records) {
    const rows = (records || []).map(r => ({ fields: r.fields || {} }));
    const { data, error } = await sbc().from('ai_brain_inbox').insert(rows).select('id, fields');
    if (error) return json({ error: { message: error.message } }, 422);
    return json({ records: (data || []).map(r => ({ id: r.id, fields: r.fields || {} })) });
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
        if (method === 'GET')   return json(await readAll());
        if (method === 'PATCH') { const b = JSON.parse(init.body || '{}'); return await patchOne(recId, b.fields || {}); }
        if (method === 'DELETE'){ await sbc().from('ai_brain_today').delete().eq('id', recId); return json({ id: recId, deleted: true }); }
      }
      if (m && m[1] === INBOX) {
        const method = (init.method || 'GET').toUpperCase();
        if (method === 'POST') { const b = JSON.parse(init.body || '{}'); return await insertInbox(b.records || []); }
      }
    } catch (e) {
      console.error('[brain-shim] error for', urlStr, e);
      return json({ error: { message: String(e.message || e) } }, 500);
    }
    return realFetch(input, init);   // ask-brain postMessage path + everything else
  };

  window.sbBrainSignIn  = (email, password) => sbc().auth.signInWithPassword({ email, password });
  window.sbBrainSession = () => sbc().auth.getSession().then(r => r.data.session);
  console.log('[brain-shim] Supabase AI Brain shim active →', SB_URL);
})();
