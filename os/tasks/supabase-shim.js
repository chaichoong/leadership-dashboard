// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for the Tasks page (os/tasks/index-supabase.html)
// ════════════════════════════════════════════════════════════════
// Intercepts the page's Airtable REST calls (api.airtable.com /
// content.airtable.com) and serves them from Supabase instead, returning
// Airtable-shaped JSON so the 8k-line page logic stays unchanged.
// Non-Airtable calls (Slack worker, Google Calendar, Claude proxy) pass through.
//
// Records are returned with `fields` keyed by Airtable field id (the page reads
// via gf(rec,fid) = rec.cellValuesByFieldId?.[fid] ?? rec.fields?.[fid]).
// Supabase row PKs ARE the Airtable record ids, so links map straight to FKs.

(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';
  const sb = window.supabase.createClient(SB_URL, SB_ANON, { auth: { persistSession: true, storageKey: '_dlr_sb_app' } });
  window.sbTasks = sb;

  // ── table id → { source, write, map } ──────────────────────────
  // map: { airtableFieldId: [column, kind] }
  //   kinds: scalar | num | bool | date | link | collabOne | json
  const TASKS = 'tblqB8b22hKBL4PF1', PROJECTS = 'tblHrpTMd5LNYn8v1',
        BUSINESSES = 'tblpqkvWJJo8Uu25q', PROPS = 'tbl6f0OkAmTC2jbuG',
        TEAM = 'tblco0p2OnlLQVAX7', COMPL = 'tblxnBxgD9pzLlvgl';

  const M = {};
  M[TASKS] = { source: 'tasks', write: 'tasks', map: {
    fldgFjGBw6bTKJFCD:['name','scalar'], fld7XP8w8kbxfETV4:['due_date','date'],
    fldx4qCw17UfrKpaN:['status','scalar'], fldELMncVJYPDRJNc:['assignee','collabOne'],
    fldS21RwmwOqt71LI:['priority','scalar'], fld10VzzbiNNgRmIi:['time_estimate','scalar'],
    flduPjY0p7MmQzDvH:['time_duration','scalar'], fldRGhBQViKZKtkQ6:['description','scalar'],
    fldNhDWBX5gQm2p6b:['recurring','scalar'], fldW4ym7haKK0BZzt:['recurring_flag','bool'],
    fldR7apBzSp3oxFxz:['notes','scalar'], fldVDvfhfOUBNvAxe:['category','scalar'],
    fldFOi1SwEKuJRmdN:['completion_date','datetime'], fldWib3IHh3jY9vBZ:['on_hold','bool'],
    fldS2OR7oQKC7T1to:['original_due_date','date'], fldZKzIxgyrQ8CG8a:['hard_deadline','bool'],
    fldmhkeRaDkiL3Ga4:['some_day','bool'], fldcq3t6uAPgWSOP8:['collaborators','json'],
    fldSEUvVA98as1HW6:['maintenance','bool'], fldtzljV5m0eTgBK5:['created_by_email','scalar'],
    fldgmzcr3jHALsdYD:['contractor','scalar'], fldSsspLUGqzDqJYz:['priority_level','scalar'],
    fldRpwiBGqEVaN20H:['due_date_interface','datetime'], fldLu1Y4GzyWcDoxr:['business_id','link'],
    fldBg0rQy0FrOAkRN:['project_id','link'], fldZKFvEpJ6NZeFKz:['property_id','link'],
    fldywB2EXESbXB7it:['created_date','datetime'],
  }};
  M[PROJECTS] = { source: 'v_projects', write: 'projects', map: {
    fldiMZICg1KOORpte:['name','scalar'], fldZ0SpReVaDS1VXb:['status','scalar'],
    fldGIlsn0cSEpnj18:['start_date','date'], fldU0cJparnkvOUsV:['end_date','date'],
    flduh2IybVmweI6lD:['deliverable','scalar'], fldgjzVEnfnZowrBD:['definition_of_done','scalar'],
    fldABYFMf2yBKWdlD:['kpi_name','scalar'], fldaI0voHia91SYZz:['kpi_target','num'],
    fldB1QJDUsukxKzjQ:['kpi_current','num'], fldrYZEghROXYf6w0:['kpi_unit','scalar'],
    fld2wYB5ZEn9WRcjN:['kpi_tracking','scalar'], fldtdJTFkMtldxEVf:['business_id','link'],
    fldXUAPrpStGwc2V9:['owner','collabOne'], fldN5l2H4WCsM0S3x:['collaborators','json'],
    fldU7tTf8aRgG60wI:['kpi_automated','bool'], fldic3mgIRLLu2Sre:['kpi_source','scalar'],
    fldNk2U74jBxZ6esJ:['kpi_last_updated','datetime'], fldIgmO8OqA3a7K5o:['kpi_last_updated_by','scalar'],
    fldA7vPiLnbgEoKh1:['kpi_compute_code','scalar'], fldeGDKEg6HEXCUh4:['kpi_detail_json','json'],
    // rollup columns (read-only, from v_projects)
    fldtw6NQZ8CSF3RXi:['total_tasks','num'], fld7IDjY0xB4JGBfn:['completed_tasks','num'],
    fld4X8l4SE4clIYhb:['overdue_tasks','num'], fld4sGSE2yyyMC7Sj:['completion_pct','num'],
  }};
  M[BUSINESSES] = { source: 'businesses', write: 'businesses', map: {
    fldbbRqVxLxUdHwIR:['name','scalar'],
  }};
  M[PROPS] = { source: 'properties', write: 'properties', map: {
    fldy2t735TV5e1DIL:['property','scalar'], fldqMbR329TNY974G:['property_name_short','scalar'],
  }};
  M[TEAM] = { source: 'v_team_members', write: 'team_members', map: {
    flds7xoRFQhcRTnbB:['name','scalar'], fldh16yvEgBy8uLKQ:['member','collabMember'],
    fld2YLfcPqSe6b60u:['active','bool'], fldFyTZu3vu1a7X3a:['preferred_name','scalar'],
    fld1DYEbtyVsO2GVP:['full_legal_name','scalar'],
  }};
  M[COMPL] = { source: 'task_completions', write: 'task_completions', map: {
    fldHDYbN6OGRgTXJe:['task_id','link'], fld79W0aWikDpz14p:['completed_by','scalar'],
    fldgXYahqxBhEBWbK:['completed_at','datetime'], fldmD73Jp5lhw0WGj:['task_name','scalar'],
    fld03eN4H0rB3nZH7:['time_est','scalar'], fldBdmHiRMfLvQ4ZE:['minutes','num'],
    fldthW4i7551wOXa1:['business','scalar'], fld889If2Y3EvrLiL:['project','scalar'],
    fld35384OFUdorE0U:['cadence','scalar'],
  }};

  // Normalise a Postgres timestamptz ("...+00:00") to Airtable's "...Z" ISO so
  // the page's strict post-write string comparison doesn't false-flag a drift.
  const toIso = v => { try { return new Date(v).toISOString(); } catch (e) { return v; } };

  // ── row → Airtable-shaped record ──
  function rowToRecord(row, cfg) {
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
      else if (kind === 'datetime') v = toIso(v);   // timestamptz → "...Z"
      else if (kind === 'json') { if (Array.isArray(v) && v.length === 0) continue; }
      fields[fid] = v;
    }
    return { id: row.id, createdTime: toIso(row.created_date || row.created_at), fields, cellValuesByFieldId: fields };
  }

  // ── Airtable fields{} → Supabase column object (writes) ──
  function fieldsToColumns(tableId, fields) {
    const cfg = M[tableId], out = {};
    for (const fid in fields) {
      const spec = cfg.map[fid];
      if (!spec) continue;
      const [col, kind] = spec;
      let v = fields[fid];
      // selects/links the page sends as {name:...} objects (Airtable typecast style)
      if (v && typeof v === 'object' && !Array.isArray(v) && 'name' in v && kind !== 'collabOne' && kind !== 'json') v = v.name;
      if (kind === 'link') v = Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
      else if (kind === 'collabOne') v = (v && typeof v === 'object') ? (v.email ?? null) : v;
      else if (kind === 'bool') v = Boolean(v);
      else if (kind === 'num') v = (v === '' || v == null) ? null : Number(v);
      else if (kind === 'json') v = v ?? [];
      else if (v === '') v = null;
      // never write rollup/derived columns
      if (['total_tasks','completed_tasks','overdue_tasks','completion_pct'].includes(col)) continue;
      out[col] = v;
    }
    return out;
  }

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  // ── known filterByFormula → query builder ──
  function applyFilter(q, tableId, formula) {
    if (!formula) return q;
    if (tableId === TASKS) {
      // main load: AND({Status}!="Completed",{Some Day}=FALSE())
      if (/Status\}\s*!=\s*"Completed"/.test(formula)) q = q.neq('status', 'Completed');
      if (/Some Day\}\s*=\s*FALSE/.test(formula)) q = q.eq('some_day', false);
      if (/Status\}\s*=\s*"Completed"/.test(formula)) q = q.eq('status', 'Completed');
    } else if (tableId === TEAM) {
      if (/Active\}\s*=\s*TRUE/.test(formula)) q = q.eq('active', true);
    } else {
      console.warn('[shim] unhandled filterByFormula for', tableId, '— returning all rows:', formula);
    }
    return q;
  }

  const ATT_FIELD = 'fldEbs9cscRr8elcw';  // Tasks "Attachments" field id
  async function attachmentsFor(taskIds) {
    const map = {};
    if (!taskIds.length) return map;
    const { data } = await sb.from('task_attachments').select('*').in('task_id', taskIds);
    (data || []).forEach(a => {
      (map[a.task_id] = map[a.task_id] || []).push({ id: a.id, url: a.url, filename: a.filename, type: a.content_type });
    });
    return map;
  }

  async function readList(tableId, url) {
    const cfg = M[tableId];
    if (!cfg) throw new Error('shim: no map for table ' + tableId);
    const formula = url.searchParams.get('filterByFormula');
    const rows = []; const page = 1000; let from = 0;
    for (;;) {
      let q = sb.from(cfg.source).select('*').range(from, from + page - 1);
      q = applyFilter(q, tableId, formula);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < page) break;
      from += page;
    }
    const records = rows.map(r => rowToRecord(r, cfg));
    if (tableId === TASKS) {
      const att = await attachmentsFor(rows.map(r => r.id));
      records.forEach(rec => { if (att[rec.id]) { rec.fields[ATT_FIELD] = att[rec.id]; rec.cellValuesByFieldId[ATT_FIELD] = att[rec.id]; } });
    }
    return { records };
  }

  async function readOne(tableId, id) {
    const cfg = M[tableId];
    const { data, error } = await sb.from(cfg.source).select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    const rec = rowToRecord(data, cfg);
    if (tableId === TASKS) {
      const att = await attachmentsFor([id]);
      if (att[id]) { rec.fields[ATT_FIELD] = att[id]; rec.cellValuesByFieldId[ATT_FIELD] = att[id]; }
    }
    return rec;
  }

  // ── comments ──
  async function listComments(taskId) {
    const { data, error } = await sb.from('task_comments').select('*').eq('task_id', taskId).order('created_at');
    if (error) throw new Error(error.message);
    return { comments: (data || []).map(c => ({
      id: c.id, text: c.body, createdTime: c.created_at,
      author: { name: c.author_name, email: c.author_email },
    })) };
  }
  const AUTHOR_RE = /^\[author:([^|\]]*)\|([^\]]*)\]\s*/;
  async function createComment(taskId, text) {
    let name = null, email = null, body = text || '';
    const m = AUTHOR_RE.exec(body);
    if (m) { name = m[1]; email = m[2]; body = body.slice(m[0].length); }
    const { data, error } = await sb.from('task_comments')
      .insert({ task_id: taskId, author_name: name, author_email: email, body }).select().single();
    if (error) throw new Error(error.message);
    return { id: data.id, text: data.body, createdTime: data.created_at, author: { name: data.author_name, email: data.author_email } };
  }

  // ── attachments (Storage) ──
  async function uploadAttachment(taskId, fieldId, payload) {
    const { filename, file, contentType } = payload;
    const bytes = Uint8Array.from(atob(file), c => c.charCodeAt(0));
    // Storage keys must be URL-safe: strip spaces/colons/other chars from the
    // path only (the real filename is kept in the DB row for display).
    const safe = String(filename || 'file').replace(/[^A-Za-z0-9._-]+/g, '_');
    const path = `${taskId}/${Date.now()}_${safe}`;
    const up = await sb.storage.from('task-attachments').upload(path, bytes, { contentType, upsert: false });
    if (up.error) throw new Error(up.error.message);
    const { data: pub } = sb.storage.from('task-attachments').getPublicUrl(path);
    await sb.from('task_attachments').insert({ task_id: taskId, filename, url: pub.publicUrl, content_type: contentType, storage_path: path });
    const { data: all } = await sb.from('task_attachments').select('*').eq('task_id', taskId);
    const arr = (all || []).map(a => ({ id: a.id, url: a.url, filename: a.filename, type: a.content_type }));
    return { id: taskId, fields: { [fieldId]: arr } };
  }

  // ── fetch interceptor ──
  const realFetch = window.fetch.bind(window);
  const AT_RE = new RegExp(`https://api\\.airtable\\.com/v0/${BASE}/([^/?]+)(?:/([^/?]+))?(?:/(comments)(?:/([^/?]+))?)?`);
  const CONTENT_RE = new RegExp(`https://content\\.airtable\\.com/v0/${BASE}/([^/]+)/([^/]+)/uploadAttachment`);

  window.fetch = async function (input, init = {}) {
    const urlStr = (typeof input === 'string') ? input : (input && input.url) || '';
    try {
      const cm = CONTENT_RE.exec(urlStr);
      if (cm) {
        const [, taskId, fieldId] = cm;
        const body = JSON.parse(init.body || '{}');
        return json(await uploadAttachment(taskId, fieldId, body));
      }
      const m = AT_RE.exec(urlStr);
      if (m) {
        const [, tableId, recId, isComments, commentId] = m;
        const method = (init.method || 'GET').toUpperCase();
        // comments endpoints: /{table}/{recId}/comments[/{commentId}]
        if (isComments === 'comments') {
          if (method === 'GET') return json(await listComments(recId));
          if (method === 'POST') { const b = JSON.parse(init.body || '{}'); return json(await createComment(recId, b.text)); }
          if (method === 'DELETE') { await sb.from('task_comments').delete().eq('id', commentId); return json({ id: commentId, deleted: true }); }
        }
        if (!M[tableId]) return realFetch(input, init); // unmapped table → let it hit Airtable
        const url = new URL(urlStr);
        if (method === 'GET') {
          if (recId) return json(await readOne(tableId, recId));
          return json(await readList(tableId, url));
        }
        if (method === 'POST') { // create
          const b = JSON.parse(init.body || '{}');
          const cols = fieldsToColumns(tableId, b.fields || {});
          const { data, error } = await sb.from(M[tableId].write).insert(cols).select().single();
          if (error) return json({ error: { message: error.message } }, 422);
          return json(rowToRecord(data, M[tableId]));
        }
        if (method === 'PATCH') { // update
          const b = JSON.parse(init.body || '{}');
          const f = b.fields || {};
          // attachment removal: page sends the kept list as [{id}] — delete the rest
          if (tableId === TASKS && f['fldEbs9cscRr8elcw'] !== undefined) {
            const keep = (f['fldEbs9cscRr8elcw'] || []).map(a => a.id).filter(Boolean);
            const { data: existing } = await sb.from('task_attachments').select('id').eq('task_id', recId);
            const toDelete = (existing || []).map(a => a.id).filter(id => !keep.includes(id));
            if (toDelete.length) await sb.from('task_attachments').delete().in('id', toDelete);
          }
          const cols = fieldsToColumns(tableId, f);
          if (Object.keys(cols).length) {
            const { error } = await sb.from(M[tableId].write).update(cols).eq('id', recId);
            if (error) return json({ error: { message: error.message } }, 422);
          }
          // read back through the view so derived/rollup + attachments echo correctly
          return json(await readOne(tableId, recId));
        }
        if (method === 'DELETE') {
          const { error } = await sb.from(M[tableId].write).delete().eq('id', recId);
          if (error) return json({ error: { message: error.message } }, 422);
          return json({ id: recId, deleted: true });
        }
      }
    } catch (e) {
      console.error('[shim] error for', urlStr, e);
      return json({ error: { message: String(e.message || e) } }, 500);
    }
    return realFetch(input, init); // everything else (Slack, GCal, Claude proxy)
  };

  // ── auth helpers used by the login overlay ──
  window.sbTasksSignIn  = (email, password) => sb.auth.signInWithPassword({ email, password });
  window.sbTasksSession = () => sb.auth.getSession().then(r => r.data.session);
  console.log('[shim] Supabase Tasks shim active →', SB_URL);
})();
