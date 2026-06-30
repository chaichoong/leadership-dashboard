// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for the Operations page (os/operations/index-supabase.html)
// ════════════════════════════════════════════════════════════════
// Serves the page's Airtable calls from Supabase. Returns records with `fields`
// keyed by the real Airtable field id (the page resolves ids at runtime from the
// base metadata, which this shim also serves from ops-schema.json).
// Costs + Transactions are DEFERRED (Module 3) → return empty so their widgets
// degrade gracefully. Non-Airtable calls pass through.

(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';
  const sb = window.supabase.createClient(SB_URL, SB_ANON, { auth: { persistSession: true, storageKey: '_dlr_sb_app' } });
  window.sbOps = sb;

  const TENANTS='tblX4elTuu01gwBYh', TENANCIES='tblN51a88qTDB6iMH', UNITS='tblM3mZCR5kiEdWMj',
        PROPS='tbl6f0OkAmTC2jbuG', VALS='tblZYsa0u1M17N7ZE', CATS='tbleWb8ioptnEwPR8',
        COSTS='tblx5kvhzNEI5TFlS', TX='tbln0gzhCAorFc3zB';
  const DEFER = new Set();   // Module 3 migrated — Costs + Transactions now live

  // table id → { source (read), write (base table), map: {airtableFieldId:[col,kind]} }
  // kinds: scalar | num | bool | date | link | arr
  const M = {};
  M[PROPS] = { source:'v_properties', write:'properties', map:{
    fldy2t735TV5e1DIL:['property','scalar'], fldKLF9xZ4YhzCswh:['prop_type','scalar'],
    fldeXUMcC6O4AcvRG:['beds','num'], fldxsjkiQ3RcV7y1j:['market_value','num'],
    fldliPo3ClTAOomKG:['mortgage_balance','num'], fldEUrWVhSp3NY8Hh:['agent','scalar'],
    fldpM6c1zm29JxdLb:['purchase_date','date'], fldUPO8q3dkY2YxDQ:['notes','scalar'],
    fldjk13txQl6HVNyK:['mortgage_cost_link','link'], fldBZKzQDV7UXwrI8:['business_id','link'],
    fldLoWcv40Ag5sHRF:['units','arr'],
  }};
  M[UNITS] = { source:'v_rental_units', write:'rental_units', map:{
    fldr8sliyu8h2jw9t:['name','scalar'], fldsItq0vU3sHv7n9:['unit_type','scalar'],
    fld3nPlpdXSExxDuq:['unit_number','num'], fldUJNRGgzgyAwwjt:['property_id','link'],
    fldBvqysXBm9rIm0E:['status','scalar'], fldQO09UAFRf07V7q:['current_tenant_id','link'],
    fldxOnUDg49C2PNVW:['current_tenancy_id','link'],
  }};
  M[TENANTS] = { source:'v_tenants', write:'tenants', map:{
    fldxBKW7QnujSDWqA:['name','scalar'], fldix9mkn151Yl2eH:['surname','scalar'],
    fldAXzP9SGIHiAhrv:['status','scalar'], fldeLsZYqbKS77S2V:['current_unit_id','link'],
    fldraHUkWfqo4olLF:['phone','scalar'], fldybEduFY3DWWTfT:['email','scalar'],
    fldv7FKsqXYswyCFE:['dob','date'], fldZbrk8Xw5Dcwxhi:['pay_type','scalar'],
    fldWijr5nOIcKJMP4:['tenancies','arr'],
  }};
  M[TENANCIES] = { source:'v_tenancies', write:'tenancies', map:{
    fldyNVvFn4x8GY14q:['ref','scalar'], fld1i5bDoHL3B6rUf:['tenant_id','link'],
    fld7cjLLEHKAx49OK:['unit_id','link'], fldxU3dPUnbK0SCDq:['pay_status','scalar'],
    fld2rPXwwV8dXb1zF:['start_date','date'], fldDMyfZLFMeONPq8:['rent','num'],
    fldhy2U0CQmM2oS4P:['due_day','scalar'], fld5O24mC8vOezjXK:['pay_freq','scalar'],
    fldgWAyha1Uij1SZP:['tenant_status','scalar'], fldxfIa0W1nqCbLo2:['property_id','link'],
    fldql2nyQlPfkPP4p:['unit_reference','scalar'],
  }};
  M[VALS] = { source:'property_valuations', write:'property_valuations', map:{
    fldRBIx2kRFAVmH0k:['title','scalar'], fldEEmN3R9fSsX9mr:['property_id','link'],
    fldjuVUTvN7poUAgD:['date','date'], fldMecW8pkzlyY7Gp:['estimated_value','num'],
    fldu2CSv2DsCYDXmh:['source','scalar'], fldQtbOpIQ2BR0yYz:['status','scalar'],
    fldgFb0ICksUdb29u:['confidence','scalar'], fldnldTHRVLBVrvOe:['comparables','scalar'],
    fldu0WJbrGAehac4Q:['methodology','scalar'], fld52DDH3BhY0vCra:['previous_value','num'],
    fld8X5yIdz6oPG2jj:['approved_by','scalar'], fldxUhWDTrpWEFGCK:['approved_on','date'],
  }};
  M[CATS] = { source:'coa_categories', write:'coa_categories', map:{ fldii4oUzSfmplihO:['name','scalar'] }};
  M[COSTS] = { source:'costs', write:'costs', map:{
    fldS6FYfpkhu6tJG0:['name','scalar'], fld9JibXkMpTeMcxw:['expected','num'],
    fldQJPGLFMbwVelsW:['inactive','bool'],
  }};
  M[TX] = { source:'transactions', write:'transactions', map:{
    fldoyQ6Rr9cHp3bgQ:['date','date'], fldN01r1hp7UQjgtm:['amount','num'],
    fldsbuAJCTsXHug4C:['name','scalar'], fldFPmNixqHPQy4D6:['category_id','link'],
    fldxKX1IbIFcAOnn5:['reconciled','bool'], fldPmAMmxwqs4SdPa:['tenancy_id','link'],
    fldJGIhSbgXNIEW4a:['unit_id','link'], fldvp44VfF8uTTthp:['property_id','link'],
  }};

  function rowToRecord(row, cfg) {
    const fields = {};
    for (const fid in cfg.map) {
      const [col, kind] = cfg.map[fid];
      let v = row[col];
      if (v === null || v === undefined || v === '') continue;
      if (kind === 'num') v = Number(v);
      else if (kind === 'bool') v = Boolean(v);
      else if (kind === 'link') v = [v];
      else if (kind === 'arr') { v = Array.isArray(v) ? v.filter(Boolean) : []; if (!v.length) continue; }
      fields[fid] = v;
    }
    return { id: row.id, createdTime: row.created_at, fields };
  }
  function fieldsToColumns(tableId, fields) {
    const cfg = M[tableId], out = {};
    for (const fid in fields) {
      const spec = cfg.map[fid]; if (!spec) continue;
      const [col, kind] = spec;
      let v = fields[fid];
      if (v && typeof v === 'object' && !Array.isArray(v) && 'name' in v) v = v.name;   // select {name}
      if (kind === 'link') v = Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
      else if (kind === 'arr') continue;            // inverse links are read-only
      else if (kind === 'bool') v = Boolean(v);
      else if (kind === 'num') v = (v === '' || v == null) ? null : Number(v);
      else if (v === '') v = null;
      if (col === 'units' || col === 'tenancies') continue;  // derived
      out[col] = v;
    }
    return out;
  }

  const json = (o, s=200) => new Response(JSON.stringify(o), { status:s, headers:{'Content-Type':'application/json'} });

  async function readList(tableId, url) {
    if (DEFER.has(tableId)) return { records: [] };
    const cfg = M[tableId];
    if (!cfg) return null;
    // Transactions: honour the page's 24-month IS_AFTER({Date},'YYYY-MM-DD') filter
    // so we don't pull the entire ledger (thousands of rows) on every load.
    let dateGte = null;
    if (tableId === TX && url) {
      const m = /IS_AFTER\([^,]*,\s*'(\d{4}-\d{2}-\d{2})'/.exec(url.searchParams.get('filterByFormula') || '');
      if (m) dateGte = m[1];
    }
    const rows = []; const page = 1000; let from = 0;
    for (;;) {
      let q = sb.from(cfg.source).select('*').range(from, from+page-1);
      if (dateGte) q = q.gte('date', dateGte);
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
    const { data, error } = await sb.from(cfg.source).select('*').eq('id', id).single();
    if (error) throw new Error(error.message);
    return rowToRecord(data, cfg);
  }

  // base metadata (the page resolves field ids from this) — served from ops-schema.json
  let _meta = null;
  async function meta() {
    if (_meta) return _meta;
    const r = await _realFetch('ops-schema.json', { cache: 'no-store' });
    _meta = await r.json();
    return _meta;
  }

  const _realFetch = window.fetch.bind(window);
  const META_RE = new RegExp(`https://api\\.airtable\\.com/v0/meta/bases/${BASE}/tables`);
  const AT_RE   = new RegExp(`https://api\\.airtable\\.com/v0/${BASE}/([^/?]+)(?:/([^/?]+))?`);

  window.fetch = async function (input, init = {}) {
    const urlStr = (typeof input === 'string') ? input : (input && input.url) || '';
    try {
      if (META_RE.test(urlStr)) return json(await meta());
      const m = AT_RE.exec(urlStr);
      if (m) {
        const [, tableId, recId] = m;
        const method = (init.method || 'GET').toUpperCase();
        if (DEFER.has(tableId)) return json({ records: [] });
        if (!M[tableId]) return _realFetch(input, init);
        if (method === 'GET') return json(recId ? await readOne(tableId, recId) : await readList(tableId, new URL(urlStr)));
        if (method === 'POST') {
          const b = JSON.parse(init.body || '{}');
          const { data, error } = await sb.from(M[tableId].write).insert(fieldsToColumns(tableId, b.fields||{})).select().single();
          if (error) return json({ error:{ message:error.message } }, 422);
          return json(await readOne(tableId, data.id));
        }
        if (method === 'PATCH') {
          const b = JSON.parse(init.body || '{}');
          const cols = fieldsToColumns(tableId, b.fields||{});
          if (Object.keys(cols).length) {
            const { error } = await sb.from(M[tableId].write).update(cols).eq('id', recId);
            if (error) return json({ error:{ message:error.message } }, 422);
          }
          return json(await readOne(tableId, recId));
        }
        if (method === 'DELETE') {
          const { error } = await sb.from(M[tableId].write).delete().eq('id', recId);
          if (error) return json({ error:{ message:error.message } }, 422);
          return json({ id: recId, deleted: true });
        }
      }
    } catch (e) {
      console.error('[ops-shim] error for', urlStr, e);
      return json({ error:{ message:String(e.message||e) } }, 500);
    }
    return _realFetch(input, init);
  };

  window.sbOpsSignIn  = (email, password) => sb.auth.signInWithPassword({ email, password });
  window.sbOpsSession = () => sb.auth.getSession().then(r => r.data.session);
  console.log('[ops-shim] Supabase Operations shim active →', SB_URL);
})();
