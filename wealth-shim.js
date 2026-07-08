// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for the Wealth tab (wealth-supabase.html)
// ════════════════════════════════════════════════════════════════
// CHAINS on top of dashboard-shim.js (loaded first): the Wealth tab reads the
// dashboard globals (allAccounts/allTransactions) via the dashboard shim, PLUS its
// own tables which this shim routes to Supabase. Those are read by field NAME
// (airtableFetch without returnFieldsByFieldId) with batch writes → stored as
// name-keyed `fields` jsonb blobs.
//   net_worth_by_month / income_buckets / personal_budgets  → full CRUD
//   valuations + debt_terms (per-property overlays) → STUBBED empty (optional; the
//   page falls back to the monthly snapshot's lumped figures — non-fatal).
// Anything this shim doesn't own falls through to the dashboard shim (prevFetch).
(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';
  let _sb = null;
  function sbc() { if (!_sb) _sb = window.supabase.createClient(SB_URL, SB_ANON, { auth: { persistSession: true, storageKey: '_dlr_sb_app' } }); return _sb; }
  window.sbWealth = sbc;

  const T = {   // Airtable table id → Supabase table
    'tblvtDXCBJCHu9hnK': 'net_worth_by_month',
    'tbldMPjXTu7ho5f0T': 'income_buckets',
    'tblm5ZxyoiLfaBAS4': 'personal_budgets',
  };
  const STUB = new Set(['tblTz8ErAmQGu7rIZ', 'tblZYsa0u1M17N7ZE']);  // debtTerms, valuations — deferred (optional)

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const rec = row => ({ id: row.id, fields: row.fields || {}, cellValuesByFieldId: row.fields || {} });

  // The Wealth tab's first fetch fires on the #wealth hash render, which can beat the
  // async session restore → RLS returns empty → wealth.js CACHES that empty result and
  // shows "No net worth data". Force the session to load before any query so the first
  // read already has auth.
  let _sessReady = null;
  function ensureSession() { if (!_sessReady) _sessReady = sbc().auth.getSession().catch(() => {}); return _sessReady; }

  async function readAll(table) {
    await ensureSession();
    const rows = []; const page = 1000; let from = 0;
    for (;;) {
      const { data, error } = await sbc().from(table).select('*').range(from, from + page - 1);
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < page) break;
      from += page;
    }
    return { records: rows.map(rec) };
  }
  async function readOne(table, id) {
    await ensureSession();
    const { data, error } = await sbc().from(table).select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return rec(data);
  }
  async function createRecs(table, recs, single) {
    const out = [];
    for (const r of recs) {
      const { data, error } = await sbc().from(table).insert({ fields: r.fields || {} }).select().single();
      if (error) return { _err: error.message };
      out.push(rec(data));
    }
    return single ? out[0] : { records: out };
  }
  async function patchRecs(table, recs) {
    const out = [];
    for (const r of recs) {
      const { data: ex } = await sbc().from(table).select('fields').eq('id', r.id).single();
      const merged = { ...((ex && ex.fields) || {}), ...(r.fields || {}) };
      const { error } = await sbc().from(table).update({ fields: merged }).eq('id', r.id);
      if (error) return { _err: error.message };
      out.push({ id: r.id, fields: merged });
    }
    return { records: out };
  }
  async function patchOne(table, id, fields) {
    const { data: ex } = await sbc().from(table).select('fields').eq('id', id).single();
    const merged = { ...((ex && ex.fields) || {}), ...(fields || {}) };
    const { error } = await sbc().from(table).update({ fields: merged }).eq('id', id);
    if (error) return json({ error: { message: error.message } }, 422);
    return json({ id, fields: merged });
  }

  const prevFetch = window.fetch.bind(window);   // dashboard-shim's override (loaded before us)
  const AT_RE = new RegExp(`https://api\\.airtable\\.com/v0/${BASE}/([^/?]+)(?:/([^/?]+))?`);

  window.fetch = async function (input, init = {}) {
    const urlStr = (typeof input === 'string') ? input : (input && (input.url || input.href)) || '';
    try {
      const m = AT_RE.exec(urlStr);
      if (m) {
        const [, tableId, recId] = m;
        const method = (init.method || 'GET').toUpperCase();
        if (STUB.has(tableId)) {
          if (method === 'GET') return json(recId ? { id: recId, fields: {} } : { records: [] });
          if (method === 'POST') { const b = JSON.parse(init.body || '{}'); return json(Array.isArray(b.records) ? { records: [] } : { id: 'stub' + Date.now(), fields: b.fields || {} }); }
          return json(recId ? { id: recId, fields: {} } : { records: [] });
        }
        if (T[tableId]) {
          const table = T[tableId];
          if (method === 'GET') return json(recId ? await readOne(table, recId) : await readAll(table));
          if (method === 'POST') {
            const b = JSON.parse(init.body || '{}');
            const recs = Array.isArray(b.records) ? b.records : [{ fields: b.fields || {} }];
            const r = await createRecs(table, recs, !Array.isArray(b.records));
            return r && r._err ? json({ error: { message: r._err } }, 422) : json(r);
          }
          if (method === 'PATCH') {
            const b = JSON.parse(init.body || '{}');
            if (Array.isArray(b.records)) { const r = await patchRecs(table, b.records); return r._err ? json({ error: { message: r._err } }, 422) : json(r); }
            return await patchOne(table, recId, b.fields || {});
          }
          if (method === 'DELETE') {
            const url = new URL(urlStr);
            const ids = url.searchParams.getAll('records[]');
            const targets = ids.length ? ids : [recId];
            const { error } = await sbc().from(table).delete().in('id', targets);
            if (error) return json({ error: { message: error.message } }, 422);
            return json(ids.length ? { records: targets.map(id => ({ id, deleted: true })) } : { id: recId, deleted: true });
          }
        }
      }
    } catch (e) {
      console.error('[wealth-shim] error for', urlStr, e);
      return json({ error: { message: String(e.message || e) } }, 500);
    }
    return prevFetch(input, init);   // dashboard-shim handles allAccounts/allTransactions/etc; else real network
  };

  console.log('[wealth-shim] Supabase Wealth shim active (chained after dashboard-shim) →', SB_URL);
})();
