// ════════════════════════════════════════════════════════════════
// SUPABASE SHIM for the Skills Library (skills-supabase.html)
// ════════════════════════════════════════════════════════════════
// The skills CATALOG is static (js/skills-data.js) — no data layer needed.
// Only two Airtable touchpoints move to Supabase:
//   1. Active presets  — settings record tblHGNzDmOs59r9QD/recqbcIz2R2griDn3,
//      field "Active Skill IDs" (a JSON string) → app_settings key/value.
//   2. SOP-generated skills — reads tblLPoRHFBl0vqR24 (= sys_workflows, already
//      migrated) fields "Skill Definition" / "Drive URL", filter NOT empty.
// Both calls use field NAMES (no returnFieldsByFieldId), so we return name-keyed
// fields. The Claude proxy (Run Skill) and everything else pass straight through.
(function () {
  const SB_URL  = window.SUPABASE_URL  || 'https://ptkyhzlsvijcwyovgrgv.supabase.co';
  const SB_ANON = window.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0a3loemxzdmlqY3d5b3Zncmd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMzIxNzgsImV4cCI6MjA5MTkwODE3OH0.U5ZdIjw--_UgJlYi75JTjpb2doBTjO4W8LUZPnZzkFU';
  const BASE = 'appnqjDpqDniH3IRl';
  const SETTINGS_TABLE = 'tblHGNzDmOs59r9QD', SETTINGS_REC = 'recqbcIz2R2griDn3';
  const WORKFLOWS = 'tblLPoRHFBl0vqR24';
  const ACTIVE_KEY = 'active_skill_ids';   // app_settings row key
  let _sb = null;
  function sbc() { if (!_sb) _sb = window.supabase.createClient(SB_URL, SB_ANON, { auth: { persistSession: true, storageKey: '_dlr_sb_app' } }); return _sb; }
  window.sbSkills = sbc;

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  async function getActivePresets() {
    const { data } = await sbc().from('app_settings').select('value').eq('key', ACTIVE_KEY).maybeSingle();
    const value = (data && data.value) || '';
    return { id: SETTINGS_REC, createdTime: null, fields: { 'Active Skill IDs': value }, cellValuesByFieldId: { 'Active Skill IDs': value } };
  }
  async function saveActivePresets(fields) {
    const value = fields['Active Skill IDs'];
    const { error } = await sbc().from('app_settings').upsert({ key: ACTIVE_KEY, value: value == null ? '' : String(value) }, { onConflict: 'key' });
    if (error) return json({ error: { message: error.message } }, 422);
    return json({ id: SETTINGS_REC, fields });
  }
  async function getSOPSkills() {
    const rows = [];
    const page = 1000; let from = 0;
    for (;;) {
      const { data, error } = await sbc().from('sys_workflows')
        .select('id, skill_definition, drive_url')
        .not('skill_definition', 'is', null).neq('skill_definition', '')
        .range(from, from + page - 1);
      if (error) throw new Error(error.message);
      rows.push(...data);
      if (data.length < page) break;
      from += page;
    }
    return { records: rows.map(r => ({
      id: r.id,
      fields: { 'Skill Definition': r.skill_definition, 'Drive URL': r.drive_url || '' },
      cellValuesByFieldId: { 'Skill Definition': r.skill_definition, 'Drive URL': r.drive_url || '' },
    })) };
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
        if (tableId === SETTINGS_TABLE) {
          if (method === 'GET') return json(await getActivePresets());
          if (method === 'PATCH') { const b = JSON.parse(init.body || '{}'); return await saveActivePresets(b.fields || {}); }
          return json({ id: recId || SETTINGS_REC, fields: {} });
        }
        if (tableId === WORKFLOWS && method === 'GET' && !recId) return json(await getSOPSkills());
        // any other Airtable call from this page → let it through (nothing else expected)
      }
    } catch (e) {
      console.error('[skills-shim] error for', urlStr, e);
      return json({ error: { message: String(e.message || e) } }, 500);
    }
    return realFetch(input, init);   // Claude proxy (Run Skill), and everything else
  };

  window.sbSkillsSignIn  = (email, password) => sbc().auth.signInWithPassword({ email, password });
  window.sbSkillsSession = () => sbc().auth.getSession().then(r => r.data.session);
  console.log('[skills-shim] Supabase Skills shim active →', SB_URL);
})();
