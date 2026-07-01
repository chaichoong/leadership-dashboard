// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for the Leadership Dashboard (index-supabase.html)
// ════════════════════════════════════════════════════════════════
// Intercepts the dashboard's Airtable calls → Supabase, returning Airtable-shaped
// records keyed by field id. Maps the 9 Overview tables; every OTHER table returns
// EMPTY so the non-migrated tabs don't error. Comments endpoints are no-ops.
// Non-Airtable calls (Gmail, Slack, Fintable, Claude proxy) pass through.

(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';
  // Lazy client so the fetch override below installs UNCONDITIONALLY even if
  // supabase-js hasn't finished loading yet — otherwise a throw here would leave
  // window.fetch un-overridden and the app would fall through to Airtable.
  let _sb = null;
  function sbc() {
    if (!_sb) _sb = window.supabase.createClient(SB_URL, SB_ANON, { auth: { persistSession: true, storageKey: '_dlr_sb_app' } });
    return _sb;
  }
  window.sbDash = sbc;

  // Airtable table ids
  const ACCOUNTS='tbl1nr0EcX2T62KME', COSTS='tblx5kvhzNEI5TFlS', TENANCIES='tblN51a88qTDB6iMH',
        TX='tbln0gzhCAorFc3zB', UNITS='tblM3mZCR5kiEdWMj', TENANTS='tblX4elTuu01gwBYh',
        CATS='tbleWb8ioptnEwPR8', SUBCATS='tblOTdRcPf8AgRz25', BIZ='tblpqkvWJJo8Uu25q',
        PROJECTS='tblHrpTMd5LNYn8v1';

  const M = {};
  M[ACCOUNTS] = { source:'accounts', write:'accounts', map:{
    fldhDG5jDA8Tu2JyI:['gbp','num'], fld8HOlbBrXbHesoA:['last_update','date'],
    fld21HAxSawQCxICj:['account_alias','scalar'], fldqr09KqLGGYCYkC:['name','scalar'],
    fldvDKRsMRtIglykK:['business_id','link'],
  }};
  M[COSTS] = { source:'costs', write:'costs', map:{
    fldS6FYfpkhu6tJG0:['name','scalar'], fld9JibXkMpTeMcxw:['expected','num'],
    fld7IsfiGvKpxEwSs:['due_day','scalar'], fldvozTHvs5VH3lNi:['frequency','scalar'],
    fldXZNI96v8HgjuSh:['pay_status_legacy','scalar'], fldQJPGLFMbwVelsW:['inactive','bool'],
    fldQZBF4JzBsmWU87:['due_date_next','date'], fldRO90pSCj6ahVMC:['sub_category_id','link'],
    fldrPjvdFPCKWqeyd:['business_id','link'], fld7nikJBPz3BoZJG:['property_id','link'],
  }};
  M[TENANCIES] = { source:'v_tenancies', write:'tenancies', map:{
    fldyNVvFn4x8GY14q:['ref','scalar'], fldDMyfZLFMeONPq8:['rent','num'],
    fldhy2U0CQmM2oS4P:['due_day','scalar'], fldxU3dPUnbK0SCDq:['pay_status','scalar'],
    fldOXazTqBWieEOK2:['tenant_surname','scalar'], fld7cjLLEHKAx49OK:['unit_id','link'],
    fld5O24mC8vOezjXK:['pay_freq','scalar'], fld1i5bDoHL3B6rUf:['tenant_id','link'],
    fldgWAyha1Uij1SZP:['tenant_status','scalar'], fldql2nyQlPfkPP4p:['unit_reference','scalar'],
    fldxfIa0W1nqCbLo2:['property_name','scalar'], fldSNk1LWWcu517CA:['paid_this_month','num'],
  }};
  M[TX] = { source:'transactions', write:'transactions', map:{
    fldoyQ6Rr9cHp3bgQ:['date','date'], fldot7iisZeL3WrdR:['report_amount','num'],
    fldN01r1hp7UQjgtm:['amount','num'], fldxKX1IbIFcAOnn5:['reconciled','bool'],
    fldMRjSVzZVYeHb0A:['sub_category_id','link'], fldBrjlbeaKFm3WzQ:['account_alias','scalar'],
    fld0Xr8sboQ0ekJQJ:['vendor','scalar'], fldsbuAJCTsXHug4C:['name','scalar'],
    fld9hm24JQUPOCoWj:['account_id','link'], fldPmAMmxwqs4SdPa:['tenancy_id','link'],
    fldGkpkVqSeiGvUGL:['cost_id','link'], fldFPmNixqHPQy4D6:['category_id','link'],
    fldQ37YsyR9r3EbkP:['split_override','num'], fld20FWX7yjM8P2Kz:['split_count','num'],
  }};
  M[UNITS] = { source:'v_rental_units', write:'rental_units', map:{
    fldBvqysXBm9rIm0E:['status','scalar'], fld7NBHkhjqfbcxk7:['property_name_short','lookupOne'],
    fldr8sliyu8h2jw9t:['name','scalar'], fld3nPlpdXSExxDuq:['unit_number','num'],
    fldUJNRGgzgyAwwjt:['property_id','link'],
  }};
  M[TENANTS] = { source:'v_tenants', write:'tenants', map:{
    fldZbrk8Xw5Dcwxhi:['pay_type','scalar'], fldxBKW7QnujSDWqA:['name','scalar'],
    fldraHUkWfqo4olLF:['phone','scalar'], fldybEduFY3DWWTfT:['email','scalar'],
    fldAXzP9SGIHiAhrv:['status','scalar'],
  }};
  M[CATS]    = { source:'coa_categories', write:'coa_categories', map:{ fldii4oUzSfmplihO:['name','scalar'] }};
  M[SUBCATS] = { source:'coa_sub_categories', write:'coa_sub_categories', map:{ fldO4BTJhFv5EsN6i:['name','scalar'] }};
  M[BIZ]     = { source:'businesses', write:'businesses', map:{ fldbbRqVxLxUdHwIR:['name','scalar'], fldhXBnRrngCVsgSk:['active','bool'] }};
  M[PROJECTS] = { source:'v_projects', write:'projects', map:{
    fldiMZICg1KOORpte:['name','scalar'], fldZ0SpReVaDS1VXb:['status','scalar'],
    fldGIlsn0cSEpnj18:['start_date','date'], fldU0cJparnkvOUsV:['end_date','date'],
    fldABYFMf2yBKWdlD:['kpi_name','scalar'], fldaI0voHia91SYZz:['kpi_target','num'],
    fldB1QJDUsukxKzjQ:['kpi_current','num'], fldrYZEghROXYf6w0:['kpi_unit','scalar'],
    fld2wYB5ZEn9WRcjN:['kpi_tracking','scalar'], fldtdJTFkMtldxEVf:['business_id','link'],
    fldXUAPrpStGwc2V9:['owner','scalar'], fldic3mgIRLLu2Sre:['kpi_source','scalar'],
    fldA7vPiLnbgEoKh1:['kpi_compute_code','scalar'], fldeGDKEg6HEXCUh4:['kpi_detail_json','scalar'],
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
      else if (kind === 'lookupOne') v = [v];
      else if (kind === 'datetime') v = toIso(v);
      fields[fid] = v;
    }
    return { id: row.id, createdTime: row.created_at, fields, cellValuesByFieldId: fields };
  }
  function fieldsToColumns(tableId, fields) {
    const cfg = M[tableId], out = {};
    for (const fid in fields) {
      const spec = cfg.map[fid]; if (!spec) continue;
      const [col, kind] = spec;
      let v = fields[fid];
      if (v && typeof v === 'object' && !Array.isArray(v) && 'name' in v) v = v.name;
      if (kind === 'link' || kind === 'lookupOne') v = Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
      else if (kind === 'bool') v = Boolean(v);
      else if (kind === 'num') v = (v === '' || v == null) ? null : Number(v);
      else if (v === '') v = null;
      // never write derived/rollup columns
      if (['tenant_status','tenant_surname','property_name','unit_reference','paid_this_month',
           'name','property_name_short','report_amount'].includes(col) && (tableId===TENANCIES||tableId===UNITS)) continue;
      out[col] = v;
    }
    return out;
  }

  const json = (o, s=200) => new Response(JSON.stringify(o), { status:s, headers:{'Content-Type':'application/json'} });

  async function readList(tableId) {
    const cfg = M[tableId];
    if (!cfg) return { records: [] };   // un-migrated table → empty (other tabs stay quiet)
    const rows = []; const page = 1000; let from = 0;
    for (;;) {
      const { data, error } = await sbc().from(cfg.source).select('*').range(from, from+page-1);
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
    // input can be a string, a Request (.url), or a URL object (.href). The dashboard's
    // airtableFetch passes a URL object — missing .href here made every call fall through to Airtable.
    const urlStr = (typeof input === 'string') ? input : (input && (input.url || input.href)) || '';
    try {
      if (CONTENT_RE.test(urlStr)) return json({ id: 'noop', fields: {} });  // attachment uploads — no-op
      const m = AT_RE.exec(urlStr);
      if (m) {
        const [, tableId, recId, isComments, commentId] = m;
        const method = (init.method || 'GET').toUpperCase();
        if (isComments === 'comments') {                    // comments — no-op success
          if (method === 'GET') return json({ comments: [] });
          return json({ id: commentId || 'noop', createdTime: new Date().toISOString() });
        }
        if (!M[tableId]) {                                  // un-migrated table
          if (method === 'GET') return json(recId ? { id: recId, fields: {} } : { records: [] });
          return json({ id: recId || 'noop', fields: {} }); // swallow writes to un-migrated tables
        }
        if (method === 'GET') return json(recId ? await readOne(tableId, recId) : await readList(tableId));
        if (method === 'POST') {
          const b = JSON.parse(init.body || '{}');
          const { data, error } = await sbc().from(M[tableId].write).insert(fieldsToColumns(tableId, b.fields||{})).select().single();
          if (error) return json({ error:{ message:error.message } }, 422);
          return json(await readOne(tableId, data.id));
        }
        if (method === 'PATCH') {
          const b = JSON.parse(init.body || '{}');
          const cols = fieldsToColumns(tableId, b.fields||{});
          if (Object.keys(cols).length) {
            const { error } = await sbc().from(M[tableId].write).update(cols).eq('id', recId);
            if (error) return json({ error:{ message:error.message } }, 422);
          }
          return json(await readOne(tableId, recId));
        }
        if (method === 'DELETE') {
          await sbc().from(M[tableId].write).delete().eq('id', recId);
          return json({ id: recId, deleted: true });
        }
      }
    } catch (e) {
      console.error('[dash-shim] error for', urlStr, e);
      return json({ error:{ message:String(e.message||e) } }, 500);
    }
    return _realFetch(input, init);
  };

  window.sbDashSignIn  = (email, password) => sbc().auth.signInWithPassword({ email, password });
  window.sbDashSession = () => sbc().auth.getSession().then(r => r.data.session);
  console.log('[dash-shim] Supabase Leadership Dashboard shim active →', SB_URL);
})();
