// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for the Objective & Strategy page (os/strategy/index-supabase.html)
// ════════════════════════════════════════════════════════════════
// Routes the page's Airtable REST calls to Supabase. The Objective & Strategy
// table is ~90 fields wide → stored as a jsonb `fields` blob keyed by Airtable
// field id (matches returnFieldsByFieldId=true), with business_name/quarter/year
// as columns for the {Business Name}/{Quarter}/{Year} filter. Businesses are read
// name-keyed (that call omits returnFieldsByFieldId); team/projects/tasks are read
// id-keyed. Per CORE scope, the "push plan → Projects/Tasks" WRITES are stubbed
// (accepted no-op) — reads still work. AI (claude-proxy) passes through.
(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';
  let _sb = null;
  function sbc() { if (!_sb) _sb = window.supabase.createClient(SB_URL, SB_ANON, { auth: { persistSession: true, storageKey: '_dlr_sb_app' } }); return _sb; }
  window.sbStrategy = sbc;

  const OBJSTRAT = 'tblEBvFw8DonwxzGh', BUSINESSES = 'tblpqkvWJJo8Uu25q',
        TEAM = 'tblco0p2OnlLQVAX7', PROJECTS = 'tblHrpTMd5LNYn8v1',
        TASKS = 'tblqB8b22hKBL4PF1', METHODS = 'tbl065D58MBEJhjlp';
  const STUB_WRITE = new Set([PROJECTS, TASKS]);   // core scope: defer the push write-back

  // objStrat key field ids (to derive filter columns on writes)
  const F_BUSINESS = 'fldLt6uDJ2xKCMlj2', F_QUARTER = 'fldQl2h3gCxYacE1k', F_YEAR = 'fldARVrVpuCWxufQO';

  // id-keyed maps for the read-only tables. kinds: scalar|num|bool|date|datetime|link|collabOne|collabMember
  const M = {};
  M[PROJECTS] = { source: 'v_projects', map: {
    fldiMZICg1KOORpte:['name','scalar'], fldZ0SpReVaDS1VXb:['status','scalar'],
    fldGIlsn0cSEpnj18:['start_date','date'], fldU0cJparnkvOUsV:['end_date','date'],
    flduh2IybVmweI6lD:['deliverable','scalar'], fldgjzVEnfnZowrBD:['definition_of_done','scalar'],
    fldABYFMf2yBKWdlD:['kpi_name','scalar'], fldaI0voHia91SYZz:['kpi_target','num'],
    fldB1QJDUsukxKzjQ:['kpi_current','num'], fldrYZEghROXYf6w0:['kpi_unit','scalar'],
    fld2wYB5ZEn9WRcjN:['kpi_tracking','scalar'], fldtdJTFkMtldxEVf:['business_id','link'],
    fldXUAPrpStGwc2V9:['owner','collabOne'],
  }};
  M[TASKS] = { source: 'tasks', map: {
    fldgFjGBw6bTKJFCD:['name','scalar'], fld7XP8w8kbxfETV4:['due_date','date'],
    fldx4qCw17UfrKpaN:['status','scalar'], fldELMncVJYPDRJNc:['assignee','collabOne'],
    fldS21RwmwOqt71LI:['priority','scalar'], fldRGhBQViKZKtkQ6:['description','scalar'],
    fldVDvfhfOUBNvAxe:['category','scalar'], fldR7apBzSp3oxFxz:['notes','scalar'],
  }};
  M[TEAM] = { source: 'v_team_members', map: {
    flds7xoRFQhcRTnbB:['name','scalar'], fldh16yvEgBy8uLKQ:['member','collabMember'],
    fld2YLfcPqSe6b60u:['active','bool'], fldFyTZu3vu1a7X3a:['preferred_name','scalar'],
    fld1DYEbtyVsO2GVP:['full_legal_name','scalar'],
  }};
  M[METHODS] = { source: 'main_methods', map: {
    fldRphzaAUzBqconG:['name','scalar'], fldWDxL9EyS1iaGlf:['description','scalar'],
  }};

  const toIso = v => { try { return new Date(v).toISOString(); } catch (e) { return v; } };
  function rowToRecord(row, cfg) {   // id-keyed
    const fields = {};
    for (const fid in cfg.map) {
      const [col, kind] = cfg.map[fid];
      let v = row[col];
      if (v === null || v === undefined || v === '') continue;
      if (kind === 'num') v = Number(v);
      else if (kind === 'bool') v = Boolean(v);
      else if (kind === 'link') v = [v];
      else if (kind === 'collabOne') v = { email: v };
      else if (kind === 'collabMember') v = { email: row.member_email || '', name: v };
      else if (kind === 'datetime') v = toIso(v);
      fields[fid] = v;
    }
    return { id: row.id, createdTime: toIso(row.created_date || row.created_at), fields, cellValuesByFieldId: fields };
  }

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  // ── objStrat ──
  function osRecord(row) {
    const fields = row.fields || {};
    return { id: row.id, createdTime: toIso(row.created_time || row.created_at), fields, cellValuesByFieldId: fields };
  }
  async function osList(url) {
    const formula = url.searchParams.get('filterByFormula') || '';
    const max = parseInt(url.searchParams.get('maxRecords') || '0', 10);
    let q = sbc().from('objectives_strategy').select('*');
    let m;
    if ((m = /\{Business Name\}\s*=\s*"([^"]*)"/.exec(formula))) q = q.eq('business_name', m[1].replace(/\\"/g, '"'));
    if ((m = /\{Quarter\}\s*=\s*"([^"]*)"/.exec(formula)))       q = q.eq('quarter', m[1]);
    if ((m = /\{Year\}\s*=\s*"([^"]*)"/.exec(formula)))          q = q.eq('year', m[1]);
    if (max > 0) q = q.limit(max);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return { records: (data || []).map(osRecord) };
  }
  async function osGetOne(id) {
    const { data, error } = await sbc().from('objectives_strategy').select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return osRecord(data);
  }
  // derive the filter columns from an incoming fields blob
  async function osColsFromFields(fields, existing) {
    const out = { fields: existing ? { ...(existing.fields || {}), ...fields } : fields };
    const link = fields[F_BUSINESS];
    if (Array.isArray(link) && link.length) {
      const bizId = (link[0] && typeof link[0] === 'object') ? link[0].id : link[0];
      out.business_id = bizId || null;
      const { data } = await sbc().from('businesses').select('name').eq('id', bizId).maybeSingle();
      if (data) out.business_name = data.name;
    }
    if (F_QUARTER in fields) out.quarter = fields[F_QUARTER];
    if (F_YEAR in fields)    out.year = fields[F_YEAR];
    return out;
  }
  async function osCreate(fields) {
    const cols = await osColsFromFields(fields, null);
    const { data, error } = await sbc().from('objectives_strategy').insert(cols).select().single();
    if (error) return json({ error: { message: error.message } }, 422);
    return json(osRecord(data));
  }
  async function osPatch(id, fields) {
    const { data: existing } = await sbc().from('objectives_strategy').select('*').eq('id', id).single();
    const cols = await osColsFromFields(fields, existing || {});
    const { error } = await sbc().from('objectives_strategy').update(cols).eq('id', id);
    if (error) return json({ error: { message: error.message } }, 422);
    return json(await osGetOne(id));
  }

  // ── businesses (name-keyed; strategy reads .fields['Business Name']) ──
  async function bizList(url) {
    const formula = url.searchParams.get('filterByFormula') || '';
    let q = sbc().from('businesses').select('*');
    if (/\{Active\}\s*=\s*TRUE/.test(formula)) q = q.eq('active', true);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return { records: (data || []).map(r => ({ id: r.id, fields: { 'Business Name': r.name, 'Name': r.name, 'Active': !!r.active }, cellValuesByFieldId: { 'Business Name': r.name } })) };
  }

  async function readIdKeyed(tableId, url) {
    const cfg = M[tableId];
    const rows = []; const page = 1000; let from = 0;
    for (;;) {
      const { data, error } = await sbc().from(cfg.source).select('*').range(from, from + page - 1);
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < page) break;
      from += page;
    }
    return { records: rows.map(r => rowToRecord(r, cfg)) };
  }

  const realFetch = window.fetch.bind(window);
  const AT_RE = new RegExp(`https://api\\.airtable\\.com/v0/${BASE}/([^/?]+)(?:/([^/?]+))?`);

  window.fetch = async function (input, init = {}) {
    const urlStr = (typeof input === 'string') ? input : (input && (input.url || input.href)) || '';
    try {
      const mm = AT_RE.exec(urlStr);
      if (mm) {
        const [, tableId, recId] = mm;
        const method = (init.method || 'GET').toUpperCase();
        const url = new URL(urlStr);

        if (tableId === OBJSTRAT) {
          if (method === 'GET')   return json(recId ? await osGetOne(recId) : await osList(url));
          if (method === 'POST')  { const b = JSON.parse(init.body || '{}'); return await osCreate(b.fields || {}); }
          if (method === 'PATCH') { const b = JSON.parse(init.body || '{}'); return await osPatch(recId, b.fields || {}); }
          if (method === 'DELETE'){ await sbc().from('objectives_strategy').delete().eq('id', recId); return json({ id: recId, deleted: true }); }
        }
        if (tableId === BUSINESSES && method === 'GET' && !recId) return json(await bizList(url));
        if (M[tableId]) {
          if (method === 'GET') {
            if (recId) { const { data } = await sbc().from(M[tableId].source).select('*').eq('id', recId).single(); return json(data ? rowToRecord(data, M[tableId]) : { id: recId, fields: {} }); }
            return json(await readIdKeyed(tableId, url));
          }
          if (STUB_WRITE.has(tableId)) {   // deferred push: accept without writing
            if (method === 'POST')  { const b = JSON.parse(init.body || '{}'); return json({ id: 'stub' + Date.now(), fields: b.fields || {} }); }
            if (method === 'PATCH') return json({ id: recId || 'stub', fields: (JSON.parse(init.body || '{}').fields) || {} });
            if (method === 'DELETE') return json({ id: recId, deleted: true });
          }
        }
      }
    } catch (e) {
      console.error('[strategy-shim] error for', urlStr, e);
      return json({ error: { message: String(e.message || e) } }, 500);
    }
    return realFetch(input, init);   // claude-proxy (AI) + everything else
  };

  window.sbStrategySignIn  = (email, password) => sbc().auth.signInWithPassword({ email, password });
  window.sbStrategySession = () => sbc().auth.getSession().then(r => r.data.session);
  console.log('[strategy-shim] Supabase Objective & Strategy shim active →', SB_URL);
})();
