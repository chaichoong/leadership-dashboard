// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for the Team OS page (os/team/index-supabase.html)
// ════════════════════════════════════════════════════════════════
// Routes the page's Airtable REST calls to Supabase. All 5 tables are Module-1
// reference tables (already migrated): team_members, departments, roles,
// achievements, sops. Read id-keyed (returnFieldsByFieldId=true); the only write
// is creating an Achievement. ensureSession() waits for the shared login before
// the first query (the page loads on init, which can beat the async session).
(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';
  let _sb = null;
  function sbc() { if (!_sb) _sb = window.supabase.createClient(SB_URL, SB_ANON, { auth: { persistSession: true, storageKey: '_dlr_sb_app' } }); return _sb; }
  window.sbTeam = sbc;
  let _sessReady = null;
  function ensureSession() { if (!_sessReady) _sessReady = sbc().auth.getSession().catch(() => {}); return _sessReady; }

  const TEAM='tblco0p2OnlLQVAX7', ACHIEVE='tblHtx8o3zt1Rd8fF', DEPT='tbloIBoYzlF3URiYK',
        ROLES='tblHiFrzekohQk2lt', SOP='tblF3tSfEajPQJHoI';

  // kinds: scalar | num | bool | date | link | collabMember | json
  const M = {};
  M[TEAM] = { source:'team_members', write:'team_members', map:{
    flds7xoRFQhcRTnbB:['name','scalar'], fldFyTZu3vu1a7X3a:['preferred_name','scalar'],
    fld1DYEbtyVsO2GVP:['full_legal_name','scalar'], fldh16yvEgBy8uLKQ:['member','collabMember'],
    fld6O2PpClGpTZd8N:['role_id','link'], fldi8KmXyedB1ixrr:['department_id','link'],
    fld2Wt9bHuIT9iia4:['manager_id','link'], fldraub938ex3BqMU:['work_email','scalar'],
    fldTZ0ReLsqpAHxE8:['whatsapp','scalar'], fldekq1yBG4ZC2jKU:['profile_photo','json'],
    fldWQldpgSxZRqUu5:['job_title','scalar'], fldTOGTPw20khbtec:['status','scalar'],
    fld9uw166E6TkGusD:['start_date','date'], fld2YLfcPqSe6b60u:['active','bool'],
    fldqqOLK8d934TLdL:['contract_docs','json'], fld819Jpc8zHEUyVh:['country','scalar'],
    fld2XkmSBs70NvXKn:['working_days','json'], fldIwCBuf1B8KMbIp:['weekly_capacity','num'],
    fldbvMos3oFMrb4W9:['business_id','link'], fld3OV2XCYDAWwwbX:['slack_handle','scalar'],
    fldXOpDiYpVnxyDyL:['dob','date'],
  }};
  M[DEPT] = { source:'departments', write:'departments', map:{
    fldDGaNynfawVs36F:['name','scalar'], fldaXgNKrRhwoQ3t1:['head_id','link'],
  }};
  M[ROLES] = { source:'roles', write:'roles', map:{
    fldR7jqnTLqFNdJ4Y:['role','scalar'], fld45Tf2vWbbKVSEw:['department_id','link'],
  }};
  M[ACHIEVE] = { source:'achievements', write:'achievements', map:{
    fld371pHn1EQYRDq0:['title','scalar'], fldntslZwKqS7jnkv:['team_member_id','link'],
    fldvux4XWfVhVZ87B:['title_ai','scalar'], fldUxbt7ZOB5Ig1yD:['description','scalar'],
    fld0dfmYoaMQEbXrU:['date','date'], fldUh6dqEh9PNc8gr:['type','scalar'],
    fldlKhLHUYg1fPf7X:['source','scalar'], fldPO8gtvCy9qUN4D:['status','scalar'],
    fldaNdproX7gYya93:['approval','bool'],
  }};
  M[SOP] = { source:'sops', write:'sops', map:{
    fldKuv5brBlD02B63:['title','scalar'], fld6qkVkFgzN2XGbQ:['sop_status','scalar'],
    fldiLbmDHr6ghPRNr:['department_id','link'], fldxbWsXSSnWj6qBA:['business_id','link'],
    fldm7Uew4thUsRwUe:['team_member_id','link'], fldJms3VbxHmkaHol:['is_trained','scalar'],
    fldileM23VJc0b8Kd:['sop_video','scalar'],
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
      else if (kind === 'link') v = [v];
      else if (kind === 'collabMember') v = { email: row.member_email || '', name: v };
      else if (kind === 'date') v = v;
      else if (kind === 'json') { if (Array.isArray(v) && !v.length) continue; }
      fields[fid] = v;
    }
    return { id: row.id, createdTime: toIso(row.created_at), fields, cellValuesByFieldId: fields };
  }
  function fieldsToColumns(tableId, fields) {
    const cfg = M[tableId], out = {};
    for (const fid in fields) {
      const spec = cfg.map[fid]; if (!spec) continue;
      const [col, kind] = spec;
      let v = fields[fid];
      if (v && typeof v === 'object' && !Array.isArray(v) && 'name' in v && kind !== 'collabMember' && kind !== 'json') v = v.name;
      if (kind === 'link') v = Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
      else if (kind === 'collabMember') v = (v && typeof v === 'object') ? (v.email ?? v.name ?? null) : v;
      else if (kind === 'bool') v = Boolean(v);
      else if (kind === 'num') v = (v === '' || v == null) ? null : Number(v);
      else if (kind === 'json') { out[col] = Array.isArray(v) ? v : (v ?? []); continue; }
      else if (v === '') v = null;
      out[col] = v;
    }
    return out;
  }

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  async function readList(tableId) {
    await ensureSession();
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
  async function readOne(tableId, id) {
    await ensureSession();
    const { data, error } = await sbc().from(M[tableId].source).select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return rowToRecord(data, M[tableId]);
  }

  const realFetch = window.fetch.bind(window);
  const AT_RE = new RegExp(`https://api\\.airtable\\.com/v0/${BASE}/([^/?]+)(?:/([^/?]+))?`);

  window.fetch = async function (input, init = {}) {
    const urlStr = (typeof input === 'string') ? input : (input && (input.url || input.href)) || '';
    try {
      const m = AT_RE.exec(urlStr);
      if (m && M[m[1]]) {
        const [, tableId, recId] = m;
        const method = (init.method || 'GET').toUpperCase();
        if (method === 'GET') return json(recId ? await readOne(tableId, recId) : await readList(tableId));
        if (method === 'POST') {   // create (achievements)
          const b = JSON.parse(init.body || '{}');
          const recs = Array.isArray(b.records) ? b.records : [{ fields: b.fields || {} }];
          const out = [];
          for (const r of recs) {
            const { data, error } = await sbc().from(M[tableId].write).insert(fieldsToColumns(tableId, r.fields || {})).select().single();
            if (error) return json({ error: { message: error.message } }, 422);
            out.push(await readOne(tableId, data.id));
          }
          return json(Array.isArray(b.records) ? { records: out } : out[0]);
        }
        if (method === 'PATCH') {
          const b = JSON.parse(init.body || '{}');
          if (Array.isArray(b.records)) {
            for (const r of b.records) await sbc().from(M[tableId].write).update(fieldsToColumns(tableId, r.fields || {})).eq('id', r.id);
            return json({ records: b.records });
          }
          const cols = fieldsToColumns(tableId, b.fields || {});
          if (Object.keys(cols).length) { const { error } = await sbc().from(M[tableId].write).update(cols).eq('id', recId); if (error) return json({ error: { message: error.message } }, 422); }
          return json(await readOne(tableId, recId));
        }
        if (method === 'DELETE') { await sbc().from(M[tableId].write).delete().eq('id', recId); return json({ id: recId, deleted: true }); }
      }
    } catch (e) {
      console.error('[team-shim] error for', urlStr, e);
      return json({ error: { message: String(e.message || e) } }, 500);
    }
    return realFetch(input, init);
  };

  window.sbTeamSignIn  = (email, password) => sbc().auth.signInWithPassword({ email, password });
  window.sbTeamSession = () => sbc().auth.getSession().then(r => r.data.session);
  console.log('[team-shim] Supabase Team OS shim active →', SB_URL);
})();
