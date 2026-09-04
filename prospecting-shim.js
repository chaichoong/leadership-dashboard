// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for Prospecting (prospecting-supabase.html)
// ════════════════════════════════════════════════════════════════
// Intercepts js/prospecting.js's Airtable calls for the two Prospecting tables →
// Supabase, returning Airtable-shaped records. Rows store a `fields` jsonb keyed
// by Airtable field NAME (the app reads by name); incoming writes are id-keyed, so
// this maps id→name on the way in. Every OTHER Airtable table returns empty and
// non-Airtable calls (GoHighLevel sync, Claude proxy) pass straight through.
//
// Prospecting is a paid add-on: the boot gates the page on the 'prospecting'
// module, but the DATA is always org-isolated by RLS regardless.

(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';

  // The app's data layer bails early on a falsy PAT — give it a truthy dummy.
  // (The real Airtable PAT is never in this client-side app.)
  try { if (!window.PAT) window.PAT = 'supabase'; } catch (e) {}

  let _sb = null;
  function sbc() {
    if (!_sb) _sb = window.supabase.createClient(SB_URL, SB_ANON, { auth: { persistSession: true, storageKey: '_dlr_sb_app' } });
    return _sb;
  }
  window.sbProspecting = sbc;

  // Airtable table id → Supabase table
  const PROSPECTS = 'tbljHVGJoKJf8acy3', KEYWORDS = 'tblB5tZrXNaKFe02j';
  const TBL = { [PROSPECTS]: 'prospects', [KEYWORDS]: 'prospect_keywords' };

  // Airtable field id → field NAME (the name the app reads by, and how we store).
  // Mirrors PROSPECT / PKEY in js/config.js — keep in sync if a field id changes.
  const ID2NAME = {
    // Prospects
    fldJConBhbcg55dFE: 'Name',              fldokUrBcggRW91Ms: 'LinkedIn URL',
    fldWheU6cyPuuHYUE: 'Headline',          fldvP8ljYvuGI4Jif: 'Company',
    fldXVOVAZ4l32O2up: 'Company Website',   fldAn2mzI9RoQCVSm: 'Contact Email',
    fldk9HsMY5pf9D0U8: 'Email Source',      fld9h6F4K4jo2cD5d: 'Email Confidence',
    fld4eYVzxfQU74Mew: 'Entity Type',       fldQAvkn0p8KDj70h: 'Companies House No',
    fldvDtz1VuE40zyZI: 'Pain Signal',       fldRJgaACrUH5t9jC: 'Signal Source',
    fldnO2nIgnADzlvFN: 'Keyword Matched',   fldNFSZrPsUF1NAd1: 'Status',
    fldSoTbvGYRI2R0bq: 'Date Found',        fld2cltR75W6DYQuB: 'GHL Contact ID',
    fldPlSHFy8iJgCopr: 'Suppressed Reason', fld4yWgjxOoZT9NIV: 'Notes',
    fld18VDzR2Iu1m2qt: 'Contact Route',     fldafL2q6G5g1TpT7: 'Draft Message',
    fldKcQIXhHE2r0PnP: 'Email Subject',     fldYGbMRJmvSZqJu1: 'Next Follow-up',
    // Prospect Keywords
    fldkgKnoJYEU0RDkE: 'Keyword',           fldzIJbDDvNX5HvaN: 'Type',
    fld2RNZflCPTEV8Qd: 'Active',            fldV7wTV6TJx23k3l: 'Last Used',
    fldHQasLEVwvCLJiA: 'Prospects Found',   fldj3FXk0zPUINO2U: 'Notes',
  };
  // ('Notes' is the field name in both tables — harmless; the map keys are the
  // distinct field ids, so there is no collision.)
  function nameFor(id) { return ID2NAME[id] || id; }

  // Incoming write body is field-id-keyed → store keyed by field NAME.
  function toNameKeyed(fields) {
    const out = {};
    for (const k in fields) out[nameFor(k)] = fields[k];
    return out;
  }
  const record = row => ({ id: row.id, createdTime: row.created_at, fields: row.fields || {} });
  const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

  async function readList(tableId) {
    const rows = []; const page = 1000; let from = 0;
    for (;;) {
      const { data, error } = await sbc().from(TBL[tableId]).select('*').order('created_at', { ascending: false }).range(from, from + page - 1);
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < page) break;
      from += page;
    }
    return { records: rows.map(record) };
  }
  async function readOne(tableId, id) {
    const { data, error } = await sbc().from(TBL[tableId]).select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return record(data);
  }

  const _realFetch = window.fetch.bind(window);
  const AT_RE = new RegExp(`https://api\\.airtable\\.com/v0/${BASE}/([^/?]+)(?:/([^/?]+))?`);

  window.fetch = async function (input, init = {}) {
    const urlStr = (typeof input === 'string') ? input : (input && (input.url || input.href)) || '';
    try {
      const m = AT_RE.exec(urlStr);
      if (m) {
        const [, tableId, recId] = m;
        const method = (init.method || 'GET').toUpperCase();
        if (!TBL[tableId]) {                                   // any other table → empty / swallow
          if (method === 'GET') return json(recId ? { id: recId, fields: {} } : { records: [] });
          return json({ id: recId || 'noop', fields: {} });
        }
        if (method === 'GET') return json(recId ? await readOne(tableId, recId) : await readList(tableId));
        if (method === 'POST') {
          const b = JSON.parse(init.body || '{}');
          const { data, error } = await sbc().from(TBL[tableId]).insert({ fields: toNameKeyed(b.fields || {}) }).select().single();
          if (error) return json({ error: { message: error.message } }, 422);
          return json(record(data));
        }
        if (method === 'PATCH') {
          const b = JSON.parse(init.body || '{}');
          const patch = toNameKeyed(b.fields || {});
          const { data: cur, error: e1 } = await sbc().from(TBL[tableId]).select('fields').eq('id', recId).single();
          if (e1) return json({ error: { message: e1.message } }, 404);
          const merged = Object.assign({}, cur.fields || {}, patch);
          const { data, error } = await sbc().from(TBL[tableId]).update({ fields: merged }).eq('id', recId).select().single();
          if (error) return json({ error: { message: error.message } }, 422);
          return json(record(data));
        }
        if (method === 'DELETE') {
          await sbc().from(TBL[tableId]).delete().eq('id', recId);
          return json({ id: recId, deleted: true });
        }
      }
    } catch (e) {
      console.error('[prospecting-shim] error for', urlStr, e);
      return json({ error: { message: String(e.message || e) } }, 500);
    }
    return _realFetch(input, init);
  };

  // Auth + entitlement helpers for the boot.
  window.sbProspectingSignIn  = (email, password) => sbc().auth.signInWithPassword({ email, password });
  window.sbProspectingSession = () => sbc().auth.getSession().then(r => r.data.session);
  window.sbProspectingEntitled = async function () {
    try {
      // RULE: the main/owner account always has every add-on (incl. new ones).
      const { data: u } = await sbc().auth.getUser();
      if (u && u.user && u.user.email && u.user.email.toLowerCase() === 'kevin@operationsdirector.co.uk') return true;
      const { data } = await sbc().from('org_modules').select('enabled').eq('module_key', 'prospecting').maybeSingle();
      return !!(data && data.enabled);
    } catch (e) { return false; }   // fail-CLOSED
  };
  console.log('[prospecting-shim] Supabase Prospecting shim active →', SB_URL);
})();
