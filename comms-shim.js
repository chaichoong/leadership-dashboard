// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for Inbound Comms (follow-up-supabase.html)
// ════════════════════════════════════════════════════════════════
// The page is GMAIL-first: the email list comes from Gmail (Google OAuth, untouched).
// Airtable is only the task write/sync side — this shim routes those calls to Supabase.
// Handles the inbound filterByFormula patterns (FIND on note_url, AND on is_inbound/
// status/note_url). Gmail, Slack, AI/SMS workers pass through. Certs/accuracy/tenancy-
// doc flows are stubbed (core-workflow scope). Attachment uploads are no-op success.
(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';
  let _sb = null;
  function sbc() { if (!_sb) _sb = window.supabase.createClient(SB_URL, SB_ANON, { auth:{ persistSession:true, storageKey:'_dlr_sb_app' } }); return _sb; }
  window.sbComms = sbc;

  const TASKS='tblqB8b22hKBL4PF1', PROPS='tbl6f0OkAmTC2jbuG', TENANCIES='tblN51a88qTDB6iMH',
        ACCURACY='tblhibxhT8smNYGM3', CERTS='tbl35rf9qtmq0P87r';
  const STUB = new Set([TENANCIES, ACCURACY, CERTS]);   // deferred flows → empty/no-op

  // Airtable user id ↔ email (3 assignees the inbound flow uses)
  const USER_EMAIL = { usrP7K5pmPSdVVgTN:'micaa.work@gmail.com', usrKkopUJSGsBhWMD:'kevin@runpreneur.org.uk', usrejWz04hiXxxgVa:'atentaerica@gmail.com' };
  const EMAIL_USER = Object.fromEntries(Object.entries(USER_EMAIL).map(([k,v]) => [v, k]));

  // kinds: scalar | num | bool | date | datetime | link | arr | assignee
  const M = {};
  M[TASKS] = { source:'tasks', write:'tasks', map:{
    fldgFjGBw6bTKJFCD:['name','scalar'], fldx4qCw17UfrKpaN:['status','scalar'],
    fldELMncVJYPDRJNc:['assignee','assignee'], fldS21RwmwOqt71LI:['priority','scalar'],
    fld10VzzbiNNgRmIi:['time_estimate','scalar'], fldRGhBQViKZKtkQ6:['description','scalar'],
    fldueazD67F7fUGee:['is_inbound','bool'], fldiXSzcMol6Tdwij:['source_type','scalar'],
    fldiSNijdCy5GXuzL:['message_content','scalar'], fldzf4xlbrQuktx0i:['sender','scalar'],
    fldR4peEZRXo7tjoI:['date_received','date'], fldXf1p0vtHqOZcKl:['note_url','scalar'],
    fld7XP8w8kbxfETV4:['due_date','date'], fldSEUvVA98as1HW6:['maintenance','bool'],
    fldZKFvEpJ6NZeFKz:['property_id','link'], fldRpwiBGqEVaN20H:['due_date_interface','datetime'],
    fldcq3t6uAPgWSOP8:['collaborators','arr'], fldEbs9cscRr8elcw:['attachments','arr'],
  }};
  M[PROPS] = { source:'properties', write:'properties', map:{
    fldy2t735TV5e1DIL:['property','scalar'], fldqMbR329TNY974G:['property_name_short','scalar'],
  }};

  const toIso = v => { try { return new Date(v).toISOString(); } catch(e){ return v; } };
  function rowToRecord(row, cfg) {
    const fields = {};
    for (const fid in cfg.map) {
      const [col, kind] = cfg.map[fid];
      let v = row[col];
      if (v === null || v === undefined || v === '') continue;
      if (kind === 'num') v = Number(v);
      else if (kind === 'bool') v = Boolean(v);
      else if (kind === 'link') v = [v];
      else if (kind === 'datetime') v = toIso(v);
      else if (kind === 'assignee') v = { id: EMAIL_USER[v] || v, email: v, name: v };
      else if (kind === 'arr') { v = Array.isArray(v) ? v.filter(x=>x!=null) : []; if (!v.length) continue; }
      fields[fid] = v;
    }
    return { id: row.id, createdTime: row.created_date || row.created_at, fields, cellValuesByFieldId: fields };
  }
  function fieldsToColumns(tableId, fields) {
    const cfg = M[tableId], out = {};
    for (const fid in fields) {
      const spec = cfg.map[fid]; if (!spec) continue;
      const [col, kind] = spec;
      let v = fields[fid];
      if (kind === 'assignee') { v = (v && typeof v === 'object') ? (USER_EMAIL[v.id] || v.email || null) : v; }
      else if (kind === 'link') v = Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
      else if (kind === 'arr') { out[col] = Array.isArray(v) ? v : []; continue; }
      else if (v && typeof v === 'object' && 'name' in v) v = v.name;
      if (kind === 'bool') v = Boolean(v);
      else if (kind === 'num') v = (v===''||v==null) ? null : Number(v);
      else if (v === '') v = null;
      out[col] = v;
    }
    return out;
  }

  // Translate the inbound Tasks filterByFormula patterns → a supabase-js query
  function applyTaskFilter(q, url) {
    const formula = url.searchParams.get('filterByFormula');
    const maxRecords = parseInt(url.searchParams.get('maxRecords') || '0', 10);
    if (formula) {
      const find = /FIND\(\s*["']([^"']+)["']\s*,\s*\{fldXf1p0vtHqOZcKl\}\s*\)/.exec(formula);
      if (find) q = q.ilike('note_url', '%' + find[1] + '%');
      if (/\{fldueazD67F7fUGee\}/.test(formula)) q = q.eq('is_inbound', true);
      if (/\{fldx4qCw17UfrKpaN\}\s*=\s*["']Completed["']/.test(formula)) q = q.eq('status', 'Completed');
      if (/\{fldx4qCw17UfrKpaN\}\s*!=\s*["']Completed["']/.test(formula)) q = q.neq('status', 'Completed');
      if (/\{fldXf1p0vtHqOZcKl\}\s*!=\s*["']["']/.test(formula)) q = q.not('note_url', 'is', null);
    }
    if (maxRecords > 0) q = q.limit(maxRecords);
    return q;
  }

  const json = (o, s=200) => new Response(JSON.stringify(o), { status:s, headers:{'Content-Type':'application/json'} });

  async function readList(tableId, url) {
    const cfg = M[tableId];
    if (!cfg) return { records: [] };
    const rows = []; const page = 1000; let from = 0;
    for (;;) {
      let q = sbc().from(cfg.source).select('*').range(from, from+page-1);
      if (tableId === TASKS) q = applyTaskFilter(q, url);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < page) break;
      from += page;
    }
    return { records: rows.map(r => rowToRecord(r, cfg)) };
  }
  async function readOne(tableId, id) {
    const cfg = M[tableId];
    if (!cfg) return { id, fields: {} };
    const { data, error } = await sbc().from(cfg.source).select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return rowToRecord(data, cfg);
  }

  const _realFetch = window.fetch.bind(window);
  const AT_RE = new RegExp(`https://api\\.airtable\\.com/v0/${BASE}/([^/?]+)(?:/([^/?]+))?(?:/(comments)(?:/([^/?]+))?)?`);
  const CONTENT_RE = new RegExp(`https://content\\.airtable\\.com/v0/${BASE}/`);

  window.fetch = async function (input, init = {}) {
    const urlStr = (typeof input === 'string') ? input : (input && (input.url || input.href)) || '';
    try {
      if (CONTENT_RE.test(urlStr)) return json({ id:'noop', fields:{} });  // attachment upload — no-op (deferred)
      const m = AT_RE.exec(urlStr);
      if (m) {
        const [, tableId, recId, isComments] = m;
        const method = (init.method || 'GET').toUpperCase();
        if (isComments === 'comments') return json(method === 'GET' ? { comments: [] } : { id:'noop' });
        if (STUB.has(tableId)) {   // deferred flows: empty read / accept write
          if (method === 'GET') return json(recId ? { id:recId, fields:{} } : { records: [] });
          if (method === 'POST') return json({ id:'stub'+Date.now(), fields:JSON.parse(init.body||'{}').fields||{} });
          return json({ id: recId || 'stub', fields:{} });
        }
        if (!M[tableId]) return _realFetch(input, init);
        const url = new URL(urlStr);
        if (method === 'GET') return json(recId ? await readOne(tableId, recId) : await readList(tableId, url));
        if (method === 'POST') {
          const b = JSON.parse(init.body || '{}');
          if (Array.isArray(b.records)) {                       // batch (rare)
            const inserted = [];
            for (const rec of b.records) {
              const { data } = await sbc().from(M[tableId].write).insert(fieldsToColumns(tableId, rec.fields||{})).select().single();
              if (data) inserted.push(await readOne(tableId, data.id));
            }
            return json({ records: inserted });
          }
          const { data, error } = await sbc().from(M[tableId].write).insert(fieldsToColumns(tableId, b.fields||{})).select().single();
          if (error) return json({ error:{ message:error.message } }, 422);
          return json(await readOne(tableId, data.id));
        }
        if (method === 'PATCH') {
          const b = JSON.parse(init.body || '{}');
          if (Array.isArray(b.records)) {
            for (const rec of b.records) await sbc().from(M[tableId].write).update(fieldsToColumns(tableId, rec.fields||{})).eq('id', rec.id);
            return json({ records: b.records });
          }
          const cols = fieldsToColumns(tableId, b.fields||{});
          if (Object.keys(cols).length) {
            const { error } = await sbc().from(M[tableId].write).update(cols).eq('id', recId);
            if (error) return json({ error:{ message:error.message } }, 422);
          }
          return json(await readOne(tableId, recId));
        }
        if (method === 'DELETE') {
          const url = new URL(urlStr);
          const ids = url.searchParams.getAll('records[]');
          const targets = ids.length ? ids : [recId];
          await sbc().from(M[tableId].write).delete().in('id', targets);
          return json(ids.length ? { records: targets.map(id=>({id,deleted:true})) } : { id:recId, deleted:true });
        }
      }
    } catch (e) {
      console.error('[comms-shim] error for', urlStr, e);
      return json({ error:{ message:String(e.message||e) } }, 500);
    }
    return _realFetch(input, init);  // Gmail, Slack, AI/SMS workers, Apps Script, Google APIs
  };

  window.sbCommsSignIn  = (email, password) => sbc().auth.signInWithPassword({ email, password });
  window.sbCommsSession = () => sbc().auth.getSession().then(r => r.data.session);
  console.log('[comms-shim] Supabase Inbound Comms shim active →', SB_URL);
})();
