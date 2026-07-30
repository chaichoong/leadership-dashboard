// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for the Team OS / HR page (os/team/index-supabase.html)
// ════════════════════════════════════════════════════════════════
// Routes the HR page's Airtable REST calls to Supabase.
//   team_members / departments / roles / achievements / sops  — Module-1 tables,
//     read id-keyed (returnFieldsByFieldId=true). Extra NON-SENSITIVE HR profile
//     fields (handbook, constraints, role/values Q&A, expected weekly, emergency
//     contact, vision board, PR date) live in team_members.hr_fields (jsonb) and
//     are merged in on read / merged (never clobbered) on write.
//   performance_reviews (PR) + dod (DOD)  — new tables (migration 0042), stored as
//     a `fields` jsonb blob keyed by Airtable field id; returned/written straight.
//   tasks (TASKS)  — the Training tab's SOP-task plumbing is a FOLLOW-UP (the tasks
//     table has no SOP-link / team-member / training columns yet), so task reads
//     return empty and task writes soft-fail. Training shows "nothing yet", never
//     errors, and never calls Airtable with the dummy token.
//
// SENSITIVE FIELDS (pay rate + bank details) are HARD-BLOCKED here (DROP set):
// never read, never written to Supabase — belt-and-suspenders on top of the page,
// which already has those inputs removed (Kevin, 2026-07-30).
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
        ROLES='tblHiFrzekohQk2lt', SOP='tblF3tSfEajPQJHoI',
        PR='tblfsuNXU9HRN4d9f', DOD='tbltrOX1yyiuUuW59', TASKS='tblqB8b22hKBL4PF1';

  // Sensitive Airtable field ids — NEVER stored in Supabase (pay rate + bank details).
  const DROP = new Set(['fldQjulT29GI0qk5g','fldYBMmRA17CDXLOK','fld2dt7AcXnbRDNa1',
                        'fld4EqMDKgx00Zshe','fldPaMgmtF3qx1uFz','fldOhos4hwNDEiJuL','fld2XUP3uCax41QT8']);

  // kinds: scalar | num | bool | date | link | collabMember | json | hr (→ hr_fields jsonb)
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
    // ── extra HR profile fields → team_members.hr_fields (jsonb), non-sensitive ──
    fldEIwDJhvGJ8FTgH:['handbook_link','hr'], fldvjbOZ7ejbFOQK9:['constraints','hr'],
    fldz7qEmMCPqowtv4:['expected_weekly','hr'], fldvW1nHNeMb817N8:['vision_board','hr'],
    fldcDbWN6n7ja31RM:['emergency_name','hr'], fldzlBLXXCL1u55HH:['emergency_phone','hr'],
    fldw28xtoxwSJgH2Z:['manager_email','hr'], fldMz4jWtPL3WAJ55:['pr_date','hr'],
    fldYtFQuL1asBE07O:['role_q1','hr'], fldbkTXzx9FW5UEfi:['role_q2','hr'], fldon0ExmdR0iMIQk:['role_q3','hr'],
    fldXvdy9rlO2TLqYw:['val_q1','hr'], fldZwfiKIaJGflaDj:['val_q2','hr'], fldV82hlqXrrmTf6s:['val_q3','hr'],
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
  // Blob tables (migration 0042): pass the jsonb `fields` straight through.
  M[PR]  = { source:'performance_reviews', write:'performance_reviews', blob:true, memberField:'fld92bhCxJHTsXabB' };
  M[DOD] = { source:'dod', write:'dod', blob:true };
  // Training tasks — follow-up: read empty, writes soft-fail (never touch Airtable).
  M[TASKS] = { stub:true };

  const toIso = v => { try { return new Date(v).toISOString(); } catch (e) { return v; } };
  function rowToRecord(row, cfg) {
    if (cfg.blob) { const f = row.fields || {}; return { id: row.id, createdTime: toIso(row.created_at), fields: f, cellValuesByFieldId: f }; }
    const fields = {}; const hr = row.hr_fields || {};
    for (const fid in cfg.map) {
      if (DROP.has(fid)) continue;
      const [col, kind] = cfg.map[fid];
      let v = kind === 'hr' ? hr[col] : row[col];
      if (v === null || v === undefined || v === '') continue;
      if (kind === 'num') v = Number(v);
      else if (kind === 'bool') v = Boolean(v);
      else if (kind === 'link') v = [v];
      else if (kind === 'collabMember') v = { email: row.member_email || '', name: v };
      else if (kind === 'json') { if (Array.isArray(v) && !v.length) continue; }
      fields[fid] = v;
    }
    return { id: row.id, createdTime: toIso(row.created_at), fields, cellValuesByFieldId: fields };
  }
  // Returns { cols, hr } — cols are real columns, hr is the hr_fields sub-object (may be empty/null).
  function fieldsToColumns(tableId, fields) {
    const cfg = M[tableId], out = {}, hr = {};
    if (cfg.blob) {
      const clean = {}; for (const k in (fields || {})) if (!DROP.has(k)) clean[k] = fields[k];
      out.fields = clean;
      if (cfg.memberField && Array.isArray(clean[cfg.memberField])) out.team_member_id = clean[cfg.memberField][0] ?? null;
      return { cols: out, hr: null }; }
    for (const fid in fields) {
      if (DROP.has(fid)) continue;               // sensitive → never persisted
      const spec = cfg.map[fid]; if (!spec) continue;
      const [col, kind] = spec;
      let v = fields[fid];
      if (v && typeof v === 'object' && !Array.isArray(v) && 'name' in v && kind !== 'collabMember' && kind !== 'json') v = v.name;
      if (kind === 'hr') { hr[col] = v; continue; }
      if (kind === 'link') v = Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
      else if (kind === 'collabMember') v = (v && typeof v === 'object') ? (v.email ?? v.name ?? null) : v;
      else if (kind === 'bool') v = Boolean(v);
      else if (kind === 'num') v = (v === '' || v == null) ? null : Number(v);
      else if (kind === 'json') { out[col] = Array.isArray(v) ? v : (v ?? []); continue; }
      else if (v === '') v = null;
      out[col] = v;
    }
    return { cols: out, hr };
  }

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  async function readList(tableId) {
    await ensureSession();
    const cfg = M[tableId];
    if (cfg.stub) return { records: [] };
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
    const cfg = M[tableId];
    if (cfg.stub) return { id, fields: {} };
    const { data, error } = await sbc().from(cfg.source).select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return rowToRecord(data, cfg);
  }
  // team_members hr_fields must MERGE (a member edit sends only the edited subset).
  async function mergeHr(id, hr) {
    if (!hr || !Object.keys(hr).length) return;
    const { data } = await sbc().from('team_members').select('hr_fields').eq('id', id).single();
    const merged = { ...((data && data.hr_fields) || {}), ...hr };
    await sbc().from('team_members').update({ hr_fields: merged }).eq('id', id);
  }
  // Blob tables (PR/DOD): a PATCH sends only the changed fields — MERGE into the
  // existing jsonb (e.g. marking trained sends only DOD.trained; must not wipe the
  // SOP title/status/video). Returns the row-shaped record for the response.
  async function patchBlob(tableId, id, partial) {
    const cfg = M[tableId];
    const { data } = await sbc().from(cfg.source).select('fields').eq('id', id).single();
    const merged = { ...((data && data.fields) || {}), ...(partial || {}) };
    const upd = { fields: merged };
    if (cfg.memberField && Array.isArray(merged[cfg.memberField])) upd.team_member_id = merged[cfg.memberField][0] ?? null;
    const { error } = await sbc().from(cfg.write).update(upd).eq('id', id);
    if (error) throw new Error(error.message);
    return { id, fields: merged, cellValuesByFieldId: merged };
  }

  const realFetch = window.fetch.bind(window);
  const AT_RE = new RegExp(`https://api\\.airtable\\.com/v0/${BASE}/([^/?]+)(?:/([^/?]+))?`);

  window.fetch = async function (input, init = {}) {
    const urlStr = (typeof input === 'string') ? input : (input && (input.url || input.href)) || '';
    try {
      const m = AT_RE.exec(urlStr);
      if (m && M[m[1]]) {
        const [, tableId, recId] = m;
        const cfg = M[tableId];
        const method = (init.method || 'GET').toUpperCase();
        if (cfg.stub) {   // Training tasks — follow-up (see header)
          if (method === 'GET') return json(recId ? { id: recId, fields: {} } : { records: [] });
          return json({ error: { message: 'Training task sync is not enabled in this workspace yet.' } }, 422);
        }
        if (method === 'GET') return json(recId ? await readOne(tableId, recId) : await readList(tableId));
        if (method === 'POST') {   // create
          const b = JSON.parse(init.body || '{}');
          const recs = Array.isArray(b.records) ? b.records : [{ fields: b.fields || {} }];
          const out = [];
          for (const r of recs) {
            const { cols, hr } = fieldsToColumns(tableId, r.fields || {});
            const { data, error } = await sbc().from(cfg.write).insert(cols).select().single();
            if (error) return json({ error: { message: error.message } }, 422);
            if (hr && Object.keys(hr).length) await mergeHr(data.id, hr);
            out.push(await readOne(tableId, data.id));
          }
          return json(Array.isArray(b.records) ? { records: out } : out[0]);
        }
        if (method === 'PATCH') {
          const b = JSON.parse(init.body || '{}');
          const list = Array.isArray(b.records) ? b.records : [{ id: recId, fields: b.fields || {} }];
          for (const r of list) {
            if (cfg.blob) { try { await patchBlob(tableId, r.id, r.fields || {}); } catch (e) { return json({ error: { message: e.message } }, 422); } continue; }
            const { cols, hr } = fieldsToColumns(tableId, r.fields || {});
            if (Object.keys(cols).length) { const { error } = await sbc().from(cfg.write).update(cols).eq('id', r.id); if (error) return json({ error: { message: error.message } }, 422); }
            if (hr && Object.keys(hr).length) await mergeHr(r.id, hr);
          }
          if (Array.isArray(b.records)) return json({ records: list });
          return json(await readOne(tableId, recId));
        }
        if (method === 'DELETE') { await sbc().from(cfg.write).delete().eq('id', recId); return json({ id: recId, deleted: true }); }
      }
    } catch (e) {
      console.error('[team-shim] error for', urlStr, e);
      return json({ error: { message: String(e.message || e) } }, 500);
    }
    return realFetch(input, init);
  };

  window.sbTeamSignIn  = (email, password) => sbc().auth.signInWithPassword({ email, password });
  window.sbTeamSession = () => sbc().auth.getSession().then(r => r.data.session);
  console.log('[team-shim] Supabase Team/HR shim active →', SB_URL);
})();
