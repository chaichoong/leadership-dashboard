// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for the Systemisation page (os/systemisation/index-supabase.html)
// ════════════════════════════════════════════════════════════════
// Intercepts the page's Airtable REST calls and serves them from Supabase,
// returning Airtable-shaped records keyed by field id. The page is otherwise
// byte-for-byte the live page. Non-Airtable calls (Claude proxy for AI, Drive
// upload worker, Loom) pass straight through.
//
// Tables: Systemisation Workflows + Workflow Steps (full CRUD), Main Methods +
// Businesses (read), Tasks (read-by-id + create a video task). The Objective &
// Strategy table is NOT migrated yet → stubbed empty (method→business grouping
// is deferred to that module).
(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';
  let _sb = null;
  function sbc() { if (!_sb) _sb = window.supabase.createClient(SB_URL, SB_ANON, { auth: { persistSession: true, storageKey: '_dlr_sb_app' } }); return _sb; }
  window.sbSys = sbc;

  const WORKFLOWS = 'tblLPoRHFBl0vqR24', STEPS = 'tblTadoyWXFHbmYxm',
        METHODS = 'tbl065D58MBEJhjlp', BUSINESSES = 'tblpqkvWJJo8Uu25q',
        TASKS = 'tblqB8b22hKBL4PF1', OBJSTRAT = 'tblEBvFw8DonwxzGh';
  const STUB = new Set([OBJSTRAT]);   // not migrated yet → empty reads / no-op writes

  // kinds: scalar | num | bool | date | datetime | link | linkArr | collabOne | json
  const M = {};
  M[WORKFLOWS] = { source: 'sys_workflows', write: 'sys_workflows', map: {
    fldsaS0jeoSRuJN28:['name','scalar'], fld1cGXzKp8ab5nBr:['description','scalar'],
    fldoN7pdUv4CIcKf2:['fulfil_stage','scalar'], fldTYbvsvqD1CQmxd:['department','scalar'],
    fldBHe23lba7DkLci:['status','scalar'], fldOAAESotc8rNKyu:['sort_order','num'],
    fldQZEvjCRYUaQdME:['main_method_ids','linkArr'], fldQcQSnlSipSBhb4:['business_ids','linkArr'],
    fldmRF1UDkbHtl1AG:['skill_definition','scalar'], fldNtXnxGrpUivWxU:['drive_url','scalar'],
    fldgXZCvwDKgTHGsH:['drive_doc_url','scalar'], fldW4qoDv2mrTNvu7:['sop_document','scalar'],
  }};
  M[STEPS] = { source: 'workflow_steps', write: 'workflow_steps', map: {
    fldqKG4mVY16PTNmO:['name','scalar'], fldlSSG0bV9VyhKEN:['description','scalar'],
    fldmGLPupz0fZFfch:['workflow_id','link'], fldPHutLN9Q2c2SzU:['step_type','scalar'],
    fldyNojZsSjfF6lLI:['sop_content','scalar'], fldZo6pPcn1lNvOay:['sop_status','scalar'],
    fldOWS3MfMSVJyo0b:['sort_order','num'], fldOisvuXul0r1XUD:['skill_id','scalar'],
  }};
  M[METHODS] = { source: 'main_methods', write: 'main_methods', map: {
    fldRphzaAUzBqconG:['name','scalar'], fldWDxL9EyS1iaGlf:['description','scalar'],
    fldi4uVOf2NgxiSKy:['objstrat_ids','linkArr'],
  }};
  M[BUSINESSES] = { source: 'businesses', write: 'businesses', map: {
    fldbbRqVxLxUdHwIR:['name','scalar'], fldhXBnRrngCVsgSk:['active','bool'],
  }};
  M[TASKS] = { source: 'tasks', write: 'tasks', map: {
    fldgFjGBw6bTKJFCD:['name','scalar'], fld7XP8w8kbxfETV4:['due_date','date'],
    fldx4qCw17UfrKpaN:['status','scalar'], fldELMncVJYPDRJNc:['assignee','collabOne'],
    fldS21RwmwOqt71LI:['priority','scalar'], fld10VzzbiNNgRmIi:['time_estimate','scalar'],
    fldRGhBQViKZKtkQ6:['description','scalar'], fldR7apBzSp3oxFxz:['notes','scalar'],
    fldVDvfhfOUBNvAxe:['category','scalar'], fldcq3t6uAPgWSOP8:['collaborators','json'],
  }};

  const toIso = v => { try { return new Date(v).toISOString(); } catch (e) { return v; } };

  function rowToRecord(row, cfg) {
    const fields = {};
    for (const fid in cfg.map) {
      const [col, kind] = cfg.map[fid];
      let v = row[col];
      if (v === null || v === undefined || v === '') continue;
      if (kind === 'num') v = Number(v);
      else if (kind === 'bool') v = Boolean(v);
      else if (kind === 'link') v = [v];                       // single FK → [id]
      else if (kind === 'linkArr') { v = Array.isArray(v) ? v : []; if (!v.length) continue; }
      else if (kind === 'collabOne') v = { email: v };
      else if (kind === 'datetime') v = toIso(v);
      else if (kind === 'json') { if (Array.isArray(v) && v.length === 0) continue; }
      fields[fid] = v;
    }
    return { id: row.id, createdTime: toIso(row.created_date || row.created_at), fields, cellValuesByFieldId: fields };
  }

  const asIds = v => {
    if (v == null) return [];
    if (!Array.isArray(v)) v = [v];
    return v.map(x => (x && typeof x === 'object') ? (x.id || x.email || null) : x).filter(Boolean);
  };

  function fieldsToColumns(tableId, fields) {
    const cfg = M[tableId], out = {};
    for (const fid in fields) {
      const spec = cfg.map[fid]; if (!spec) continue;
      const [col, kind] = spec;
      let v = fields[fid];
      if (v && typeof v === 'object' && !Array.isArray(v) && 'name' in v && kind !== 'collabOne' && kind !== 'json') v = v.name;
      if (kind === 'link') v = asIds(v)[0] ?? null;            // array → first id
      else if (kind === 'linkArr') v = asIds(v);               // → jsonb array of ids
      else if (kind === 'collabOne') v = (v && typeof v === 'object') ? (v.email ?? null) : v;
      else if (kind === 'bool') v = Boolean(v);
      else if (kind === 'num') v = (v === '' || v == null) ? null : Number(v);
      else if (kind === 'json') v = v ?? [];
      else if (v === '') v = null;
      out[col] = v;
    }
    return out;
  }

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  // filterByFormula → query. Systemisation only filters TASKS by RECORD_ID().
  function applyFilter(q, tableId, formula) {
    if (!formula) return q;
    if (tableId === TASKS) {
      const ids = [...formula.matchAll(/RECORD_ID\(\)\s*=\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
      if (ids.length) q = q.in('id', ids);
    }
    return q;
  }

  async function readList(tableId, url) {
    const cfg = M[tableId];
    if (!cfg) return { records: [] };
    const formula = url.searchParams.get('filterByFormula');
    const rows = []; const page = 1000; let from = 0;
    for (;;) {
      let q = sbc().from(cfg.source).select('*').range(from, from + page - 1);
      q = applyFilter(q, tableId, formula);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < page) break;
      from += page;
    }
    return { records: rows.map(r => rowToRecord(r, cfg)) };   // no offset → page stops after one page
  }
  async function readOne(tableId, id) {
    const cfg = M[tableId];
    const { data, error } = await sbc().from(cfg.source).select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return rowToRecord(data, cfg);
  }

  const realFetch = window.fetch.bind(window);
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
          if (method === 'POST') return json({ records: [{ id: 'stub' + Date.now(), fields: {} }] });
          return json({ id: recId || 'stub', fields: {} });
        }
        if (!M[tableId]) return realFetch(input, init);
        const url = new URL(urlStr);
        if (method === 'GET') return json(recId ? await readOne(tableId, recId) : await readList(tableId, url));
        if (method === 'POST') {                                // create: { records:[{fields}] }
          const b = JSON.parse(init.body || '{}');
          const recs = Array.isArray(b.records) ? b.records : [{ fields: b.fields || {} }];
          const out = [];
          for (const r of recs) {
            const cols = fieldsToColumns(tableId, r.fields || {});
            const { data, error } = await sbc().from(M[tableId].write).insert(cols).select().single();
            if (error) return json({ error: { message: error.message } }, 422);
            out.push(rowToRecord(data, M[tableId]));
          }
          return json({ records: out });
        }
        if (method === 'PATCH') {                               // update single: { fields }
          const b = JSON.parse(init.body || '{}');
          const cols = fieldsToColumns(tableId, b.fields || {});
          if (Object.keys(cols).length) {
            const { error } = await sbc().from(M[tableId].write).update(cols).eq('id', recId);
            if (error) return json({ error: { message: error.message } }, 422);
          }
          return json(await readOne(tableId, recId));           // bare record (page reads it directly)
        }
        if (method === 'DELETE') {
          const { error } = await sbc().from(M[tableId].write).delete().eq('id', recId);
          if (error) return json({ error: { message: error.message } }, 422);
          return json({ id: recId, deleted: true });
        }
      }
    } catch (e) {
      console.error('[sys-shim] error for', urlStr, e);
      return json({ error: { message: String(e.message || e) } }, 500);
    }
    return realFetch(input, init);   // Claude proxy (AI), Drive upload, Loom, everything else
  };

  window.sbSysSignIn  = (email, password) => sbc().auth.signInWithPassword({ email, password });
  window.sbSysSession = () => sbc().auth.getSession().then(r => r.data.session);
  console.log('[sys-shim] Supabase Systemisation shim active →', SB_URL);
})();
