// ══════════════════════════════════════════
// LEADERSHIP DASHBOARD — Load Data & Render KPIs
// ══════════════════════════════════════════

    // ── Stale-while-revalidate cache for instant reloads ──
    // Uses IndexedDB, not localStorage: the full dataset is ~50MB (7000+ transactions)
    // which blows through localStorage's 5-10MB quota and silently fails to save.
    // IndexedDB handles hundreds of MB and stores objects directly (no JSON stringify).
    const DASH_CACHE_KEY = '_dlr_dashcache_v1';
    const DASH_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — older than this, don't show stale
    const IDB_DB_NAME = '_dlr_cache';
    const IDB_STORE = 'kv';

    let _idbPromise = null;
    function _openIDB() {
        if (_idbPromise) return _idbPromise;
        _idbPromise = new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) { reject(new Error('IDB unsupported')); return; }
            const req = indexedDB.open(IDB_DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error('IDB open blocked'));
        });
        return _idbPromise;
    }

    function _idbGet(key) {
        return _openIDB().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }));
    }

    function _idbSet(key, value) {
        return _openIDB().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(value, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    }

    function _idbDel(key) {
        return _openIDB().then(db => new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        }));
    }

    async function loadDashCache() {
        try {
            const parsed = await _idbGet(DASH_CACHE_KEY);
            if (!parsed || !parsed.savedAt || !parsed.data) return null;
            const ageMs = Date.now() - parsed.savedAt;
            if (ageMs > DASH_CACHE_MAX_AGE_MS) return null;
            return { data: parsed.data, ageMs };
        } catch (e) {
            return null;
        }
    }

    async function saveDashCache(data) {
        try {
            await _idbSet(DASH_CACHE_KEY, { savedAt: Date.now(), data });
        } catch (e) {
            console.warn('Dashboard cache save failed:', e);
            try { await _idbDel(DASH_CACHE_KEY); } catch (_) {}
        }
    }

    async function clearDashCache() {
        try { await _idbDel(DASH_CACHE_KEY); } catch (_) {}
        // Also clear the old localStorage cache left over from pre-IDB versions
        try { localStorage.removeItem(DASH_CACHE_KEY); } catch (_) {}
    }

    function setRefreshingIndicator(on, ageMs) {
        const el = document.getElementById('refreshingBadge');
        if (!el) return;
        if (on) {
            const ageLabel = ageMs != null ? formatAge(ageMs) : '';
            el.innerHTML = '<span class="refresh-dot" style="background:#2563eb"></span>Refreshing\u2026' +
                (ageLabel ? ' <span style="opacity:0.7">(showing data from ' + ageLabel + ')</span>' : '');
            el.style.display = 'inline-flex';
        } else {
            el.style.display = 'none';
        }
    }

    function formatAge(ms) {
        const mins = Math.round(ms / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + ' min ago';
        const hrs = Math.round(mins / 60);
        if (hrs < 24) return hrs + 'h ago';
        return Math.round(hrs / 24) + 'd ago';
    }

    // ── Strategic KPIs (from Projects table) ──
    // The Projects table lives in the same base as the Task OS. Fields below mirror
    // the PF constant in os/tasks/index.html. Kept as local constants so this file
    // stays independent — if you change field IDs, update both.
    const STRAT_PROJECTS_TABLE = 'tblHrpTMd5LNYn8v1';
    const STRAT_PF = {
        name:            'fldiMZICg1KOORpte',
        status:          'fldZ0SpReVaDS1VXb',
        start:           'fldGIlsn0cSEpnj18',
        end:             'fldU0cJparnkvOUsV',
        completed:       'fldliObR7TdTdjht7',
        kpiName:         'fldABYFMf2yBKWdlD',
        kpiTarget:       'fldaI0voHia91SYZz',
        kpiCurrent:      'fldB1QJDUsukxKzjQ',
        kpiUnit:         'fldrYZEghROXYf6w0',
        business:        'fldtdJTFkMtldxEVf',
        owner:           'fldXUAPrpStGwc2V9',
        kpiAutomated:    'fldU7tTf8aRgG60wI',
        kpiSource:       'fldic3mgIRLLu2Sre',
        kpiLastUpdated:  'fldNk2U74jBxZ6esJ',
        kpiLastUpdatedBy:'fldIgmO8OqA3a7K5o',
        kpiComputeCode:  'fldA7vPiLnbgEoKh1',
        kpiDetailJson:   'fldeGDKEg6HEXCUh4',
        totalTasks:      'fldtw6NQZ8CSF3RXi',
        completedTasks:  'fld7IDjY0xB4JGBfn',
    };
    const STRAT_TEAM_KEYS = {
        'kevin@runpreneur.org.uk':'kevin',
        'micaa.work@gmail.com':'mica',
        'atentaerica@gmail.com':'erica',
    };
    let strategicKpiFilter = 'all';
    let _strategicKpiProjects = [];
    let _strategicBusinessIdToName = {};

    // Readiness signal for the main dashboard data tables (allTransactions,
    // allTenancies, allCosts, allBusinesses, allCategories, allSubCategories).
    // loadStrategicKpis now fires at the top of loadDashboard — BEFORE those
    // globals are populated — so its Projects fetch + initial render can race
    // against the main 9-table fetch. But runAutomatedKpis needs those globals
    // to compute values, so it waits on this promise before starting. Resolved
    // by markMainDataReady() once either the cache-hit path or the fresh-fetch
    // path has finished populating the globals.
    let _mainDataReadyResolve = null;
    const _mainDataReadyPromise = new Promise(r => { _mainDataReadyResolve = r; });
    function markMainDataReady() {
        if (_mainDataReadyResolve) { _mainDataReadyResolve(); _mainDataReadyResolve = null; }
    }

    function _stratSelName(v){if(!v)return '';if(typeof v==='string')return v;if(typeof v==='object'&&v.name)return v.name;return ''}
    function _stratDaysAgo(iso){if(!iso)return null;const ms=Date.now()-new Date(iso).getTime();return Math.floor(ms/86400000)}
    function _stratComputeHealth(p){
        if(p.completed||p.status==='Completed')return'Completed';
        if(p.status==='Not Started')return'Not Started';
        if(!p.start||!p.end)return p.status||'Unknown';
        const today=new Date();today.setHours(0,0,0,0);
        const s=new Date(p.start+'T00:00:00'),e=new Date(p.end+'T00:00:00');
        if(e<s)return p.status||'Unknown';
        if(e<today)return'Off-Track';
        const total=e-s,elapsed=Math.max(0,today-s);
        const timePct=total>0?(elapsed/total)*100:0;
        let progPct=null;
        if(p.kpiTarget>0&&p.kpiCurrent>=0)progPct=(p.kpiCurrent/p.kpiTarget)*100;
        else if(p.totalTasks>0)progPct=((p.completedTasks||0)/p.totalTasks)*100;
        if(progPct===null)return p.status||'Unknown';
        if(timePct<5)return'Not Started';
        const ratio=timePct>0?(progPct/timePct)*100:100;
        if(ratio>=100)return'On-Target';
        if(ratio>=85)return'On-Track';
        return'Off-Track';
    }
    // Returns a CSS value — uses design tokens so the colour set always stays on-brand.
    function _stratHealthColour(h){
        if(h==='On-Target'||h==='Completed'||h==='On-Track')return'var(--success)';
        if(h==='Off-Track')return'var(--danger)';
        if(h==='Not Started')return'var(--text-muted)';
        return'var(--warning)';
    }

    async function loadStrategicKpis(){
        try{
            // Build business ID→name map from already-loaded businesses
            // Business name field ID is fldbbRqVxLxUdHwIR (same as used in pnl.js)
            _strategicBusinessIdToName={};
            (allBusinesses||[]).forEach(b=>{
                const name=getField(b,'fldbbRqVxLxUdHwIR');
                if(name)_strategicBusinessIdToName[b.id]=typeof name==='string'?name:(name.name||'');
            });
            const records=await airtableFetch(STRAT_PROJECTS_TABLE);
            _strategicKpiProjects=records.map(r=>{
                const ownerObj=getField(r,STRAT_PF.owner);
                const businessLinks=getField(r,STRAT_PF.business)||[];
                let businessName='';
                if(Array.isArray(businessLinks)&&businessLinks[0]){
                    const b=businessLinks[0];
                    if(typeof b==='object'&&b.name)businessName=b.name;
                    else if(typeof b==='string')businessName=_strategicBusinessIdToName[b]||'';
                }
                return {
                    id:r.id,
                    name:getField(r,STRAT_PF.name)||'(Untitled)',
                    status:_stratSelName(getField(r,STRAT_PF.status)),
                    start:getField(r,STRAT_PF.start)||'',
                    end:getField(r,STRAT_PF.end)||'',
                    completed:!!getField(r,STRAT_PF.completed),
                    kpiName:getField(r,STRAT_PF.kpiName)||'',
                    kpiTarget:Number(getField(r,STRAT_PF.kpiTarget))||0,
                    kpiCurrent:Number(getField(r,STRAT_PF.kpiCurrent))||0,
                    kpiUnit:_stratSelName(getField(r,STRAT_PF.kpiUnit)),
                    business:businessName,
                    owner:ownerObj?{name:ownerObj.name||'',email:ownerObj.email||''}:null,
                    kpiAutomated:!!getField(r,STRAT_PF.kpiAutomated),
                    kpiSource:getField(r,STRAT_PF.kpiSource)||'',
                    kpiLastUpdated:getField(r,STRAT_PF.kpiLastUpdated)||'',
                    kpiLastUpdatedBy:getField(r,STRAT_PF.kpiLastUpdatedBy)||'',
                    totalTasks:Number(getField(r,STRAT_PF.totalTasks))||0,
                    completedTasks:Number(getField(r,STRAT_PF.completedTasks))||0,
                };
            });
            // Render immediately with the values already on each project so
            // the section never disappears while compute runs. Compute writes
            // back to Airtable in the background and re-renders on completion.
            renderStrategicKpis();
            try{
                await runAutomatedKpis(records);
                renderStrategicKpis();
            }catch(e){console.warn('[runAutomatedKpis] failed',e)}
        }catch(e){console.warn('[loadStrategicKpis] failed',e)}
    }

    // ─── Automated KPI compute runner (dashboard-side) ──────────────────
    // Projects with a hand-written compute function body in the
    // "KPI Compute Code" field get recomputed every time the dashboard
    // loads. The compute receives a rich ctx including all finance data
    // (transactions, costs, categories, businesses) so the function can
    // reason over the whole chart of accounts without fetching anything
    // itself. Result is PATCHed back to kpiCurrent + kpiLastUpdated on
    // the project record so both the dashboard and Task OS see it.
    function buildAutomatedKpiContext(project){
        // Build ID → name maps from the already-loaded global arrays
        const bizIdToName={};
        (allBusinesses||[]).forEach(b=>{
            const n=getField(b,'fldbbRqVxLxUdHwIR');
            if(n)bizIdToName[b.id]=typeof n==='string'?n:(n.name||'');
        });
        const catIdToName={};
        (allCategories||[]).forEach(c=>{
            const n=getField(c,'fldii4oUzSfmplihO');
            if(n)catIdToName[c.id]=typeof n==='string'?n:(n.name||'');
        });
        const subCatIdToName={};
        (allSubCategories||[]).forEach(sc=>{
            const n=getField(sc,'fldO4BTJhFv5EsN6i');
            if(n)subCatIdToName[sc.id]=typeof n==='string'?n:(n.name||'');
        });
        const costIdToBiz={};
        const costIdToInactive={};
        (allCosts||[]).forEach(co=>{
            const bizLinks=getField(co,'fldrPjvdFPCKWqeyd')||[];
            const bizNames=(Array.isArray(bizLinks)?bizLinks:[]).map(x=>typeof x==='object'?x.name||bizIdToName[x.id]||'':bizIdToName[x]||'').filter(Boolean);
            costIdToBiz[co.id]=bizNames;
            costIdToInactive[co.id]=!!getField(co,'fldQJPGLFMbwVelsW');
        });
        // Tenancy ID → friendly label. Primary field on Tenancies isn't
        // human-readable, so build "Unit-Ref — Surname" using tenRef +
        // tenSurname (e.g. "34CR — Smith"). Falls back to whichever is
        // present, then to the ID.
        const tenIdToLabel={};
        const getTenField=(r,fid)=>{
            const v=r&&r.fields?r.fields[fid]:undefined;
            if(Array.isArray(v))return v[0]||'';
            return v||'';
        };
        (allTenancies||[]).forEach(tn=>{
            const ref=String(getTenField(tn,'fldyNVvFn4x8GY14q')||'').trim();
            const surname=String(getTenField(tn,'fldOXazTqBWieEOK2')||'').trim();
            let label=ref && surname ? `${ref} — ${surname}` : (ref||surname||'');
            tenIdToLabel[tn.id]=label||tn.id;
        });
        // Simplify transactions into a flat shape the compute function can reason over
        const txs=(allTransactions||[]).map(tx=>{
            const bizLinks=getField(tx,'fldX1aFlJyzpXGhbF')||[];
            const bizNames=(Array.isArray(bizLinks)?bizLinks:[]).map(x=>typeof x==='object'?x.name||bizIdToName[x.id]||'':bizIdToName[x]||'').filter(Boolean);
            const catLinks=getField(tx,'fldFPmNixqHPQy4D6')||[];
            const catNames=(Array.isArray(catLinks)?catLinks:[]).map(x=>typeof x==='object'?x.name||catIdToName[x.id]||'':catIdToName[x]||'').filter(Boolean);
            const subLinks=getField(tx,'fldMRjSVzZVYeHb0A')||[];
            const subNames=(Array.isArray(subLinks)?subLinks:[]).map(x=>typeof x==='object'?x.name||subCatIdToName[x.id]||'':subCatIdToName[x]||'').filter(Boolean);
            const costLinks=getField(tx,'fldGkpkVqSeiGvUGL')||[];
            const costIds=(Array.isArray(costLinks)?costLinks:[]).map(x=>typeof x==='object'?x.id:x).filter(Boolean);
            const reportAmount=Number(getField(tx,'fldot7iisZeL3WrdR'))||0;
            const date=getField(tx,'fldoyQ6Rr9cHp3bgQ')||'';
            const reconciled=!!getField(tx,'fldxKX1IbIFcAOnn5');
            const vendor=getField(tx,'fld0Xr8sboQ0ekJQJ')||'';
            const description=getField(tx,'fldsbuAJCTsXHug4C')||'';
            // Tenancy link (for rental income rows). Resolve each linked-record
            // id to the friendly "Unit Ref — Surname" label built above.
            const tenLinks=getField(tx,'fldPmAMmxwqs4SdPa')||[];
            const tenancyNames=(Array.isArray(tenLinks)?tenLinks:[]).map(x=>{
                const id=typeof x==='object'?x.id:x;
                return tenIdToLabel[id]||(typeof x==='object'?(x.name||x.id):x)||'';
            }).filter(Boolean);
            return {
                id:tx.id,
                date:(date||'').slice(0,10),
                amount:reportAmount, // SIGNED: +ve = money in, −ve = money out
                reconciled,
                vendor: typeof vendor==='string'?vendor:(vendor&&vendor.name)||'',
                description: typeof description==='string'?description:'',
                businesses:bizNames,
                categories:catNames,
                subCategories:subNames,
                costIds,
                hasCost:costIds.length>0,
                tenancies:tenancyNames,
            };
        });
        return {
            today:new Date().toISOString().slice(0,10),
            project:{
                id:project.id,
                name:project.name||'',
                start:project.start||'',
                end:project.end||'',
                business:project.business||'',
                kpiTarget:project.kpiTarget||0,
                kpiUnit:project.kpiUnit||'',
            },
            transactions:txs,
            costs:(allCosts||[]).map(co=>({
                id:co.id,
                name:getField(co,'fldS6FYfpkhu6tJG0')||'',
                businesses:costIdToBiz[co.id]||[],
                inactive:!!costIdToInactive[co.id],
            })),
            // Helpers
            between(iso, startIso, endIso){
                if(!iso)return false;
                const d=String(iso).slice(0,10);
                return (!startIso||d>=startIso)&&(!endIso||d<=endIso);
            },
            addDays(iso, days){
                if(!iso)return '';
                const [y,m,d]=iso.slice(0,10).split('-').map(Number);
                const dt=new Date(Date.UTC(y,m-1,d+days));
                return dt.toISOString().slice(0,10);
            },
            monthRange(iso){
                const d=(iso||new Date().toISOString()).slice(0,10);
                const [y,m]=d.split('-').map(Number);
                const start=`${y}-${String(m).padStart(2,'0')}-01`;
                const lastDay=new Date(Date.UTC(y,m,0)).getUTCDate();
                const end=`${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
                return {start,end};
            },
            sumBy(arr,fn){return (arr||[]).reduce((s,x)=>s+(+fn(x)||0),0)},
            countWhere(arr,fn){return (arr||[]).filter(fn).length},
        };
    }

    function runKpiComputeCode(code, ctx){
        if(!code||!String(code).trim())return null;
        try{
            // eslint-disable-next-line no-new-func
            const fn=new Function('ctx','"use strict";'+code);
            const v=fn(ctx);
            if(typeof v==='number'&&isFinite(v))return v;
            if(typeof v==='string'){const n=parseFloat(v);if(!isNaN(n))return n}
            // If the function returns an object (e.g. { rolling, months }), stash it
            // on the project record so renderStrategicKpis can pick a specific value
            // for display. Return the primary value field for kpiCurrent.
            if(v&&typeof v==='object'){
                ctx._lastKpiDetail=v;
                const primary=v.value??v.primary??v.rolling??v.current??null;
                if(typeof primary==='number'&&isFinite(primary))return primary;
            }
            return null;
        }catch(e){console.warn('[runKpiComputeCode] error',e);return null}
    }

    // Fetch a slim view of every task — just the fields we need for
    // task-completion style KPIs. Only called when the dashboard runs
    // automated KPIs, so it doesn't add load to unrelated refreshes.
    async function fetchTasksForKpi(){
        try{
            const url=`https://api.airtable.com/v0/${BASE_ID}/${TABLES.tasks}?returnFieldsByFieldId=true&pageSize=100&fields[]=fldx4qCw17UfrKpaN&fields[]=fldBg0rQy0FrOAkRN&fields[]=fldFOi1SwEKuJRmdN&fields[]=fldgFjGBw6bTKJFCD&fields[]=fld7XP8w8kbxfETV4`;
            let all=[],offset=null;
            do{
                const r=await fetch(url+(offset?'&offset='+offset:''),{headers:{Authorization:`Bearer ${PAT}`}});
                if(!r.ok)throw new Error('tasks fetch '+r.status);
                const d=await r.json();all=all.concat(d.records||[]);offset=d.offset||null;
            }while(offset);
            return all.map(t=>{
                const c=t.cellValuesByFieldId||t.fields||{};
                const statusObj=c['fldx4qCw17UfrKpaN'];
                const status=typeof statusObj==='string'?statusObj:(statusObj&&statusObj.name)||'';
                const projLinks=c['fldBg0rQy0FrOAkRN']||[];
                const projectIds=(Array.isArray(projLinks)?projLinks:[]).map(x=>typeof x==='object'?x.id:x).filter(Boolean);
                return {
                    id:t.id,
                    name:c['fldgFjGBw6bTKJFCD']||'',
                    status,
                    completed:status==='Completed',
                    projectIds,
                    completion:c['fldFOi1SwEKuJRmdN']||'',
                    dueDate:c['fld7XP8w8kbxfETV4']||'',
                };
            });
        }catch(e){console.warn('[fetchTasksForKpi] failed',e);return []}
    }
    async function runAutomatedKpis(projectRecords){
        if(!Array.isArray(projectRecords))return;
        const withCode=projectRecords.filter(r=>{
            const code=getField(r,STRAT_PF.kpiComputeCode);
            return code && String(code).trim();
        });
        if(!withCode.length)return;
        // The compute code reads from allTransactions / allTenancies / allCosts
        // / allBusinesses / allCategories / allSubCategories. Wait for those to
        // be populated before computing (they're set by either the cache-hit
        // render or the fresh-fetch success path in loadDashboard).
        await _mainDataReadyPromise;
        // Fetch the task list once for any project KPI that needs it.
        const tasksForKpi=await fetchTasksForKpi();
        // Run all computes synchronously, updating local state per project so the
        // caller can renderStrategicKpis() with fresh values right away. PATCHes
        // to Airtable fire in the background (fire-and-forget) — they used to be
        // awaited sequentially, costing N × ~500ms on the critical path for data
        // the UI already had locally. Persisting to Airtable is housekeeping so
        // the next session's initial (pre-compute) render shows today's numbers.
        for(const rec of withCode){
            try{
                const code=getField(rec,STRAT_PF.kpiComputeCode);
                const local=_strategicKpiProjects.find(p=>p.id===rec.id)||{
                    id:rec.id,
                    name:getField(rec,STRAT_PF.name)||'',
                    start:getField(rec,STRAT_PF.start)||'',
                    end:getField(rec,STRAT_PF.end)||'',
                    kpiTarget:Number(getField(rec,STRAT_PF.kpiTarget))||0,
                    kpiUnit:_stratSelName(getField(rec,STRAT_PF.kpiUnit)),
                };
                const ctx=buildAutomatedKpiContext(local);
                ctx.tasks=tasksForKpi;
                const value=runKpiComputeCode(code,ctx);
                if(value==null)continue;
                const rounded=Math.round(value*100)/100;
                local.kpiCurrent=rounded;
                local.kpiReturn=ctx._lastKpiDetail||null;
                local.kpiDetail=ctx._lastKpiDetail||null;
                local.kpiLastUpdated=new Date().toISOString();
                let who='Leadership Dashboard';
                try{if(typeof currentUser!=='undefined'&&currentUser&&(currentUser.name||currentUser.email))who=currentUser.name||currentUser.email}catch(e){}
                local.kpiLastUpdatedBy=who;

                // Fire-and-forget Airtable persist.
                (async ()=>{
                    try{
                        const payload={};
                        payload[STRAT_PF.kpiCurrent]=rounded;
                        payload[STRAT_PF.kpiLastUpdated]=local.kpiLastUpdated;
                        payload[STRAT_PF.kpiLastUpdatedBy]=local.kpiLastUpdatedBy;
                        // Serialize the full compute return (months + detail) so
                        // the Task OS can read the same drilldown without re-
                        // fetching transactions. Cap at ~95KB to stay under
                        // Airtable's 100,000-char long-text limit.
                        try{
                            let json=JSON.stringify(ctx._lastKpiDetail||{});
                            const CAP=95000;
                            if(json.length>CAP){
                                const obj=ctx._lastKpiDetail||{};
                                if(obj.detail){
                                    for(const size of [40,25,15,5]){
                                        if(obj.detail.rolling){
                                            obj.detail.rolling.revTxs=(obj.detail.rolling.revTxs||[]).slice(0,size);
                                            obj.detail.rolling.costTxs=(obj.detail.rolling.costTxs||[]).slice(0,size);
                                        }
                                        if(obj.detail.monthsDetail){
                                            Object.keys(obj.detail.monthsDetail).forEach(k=>{
                                                obj.detail.monthsDetail[k].revTxs=(obj.detail.monthsDetail[k].revTxs||[]).slice(0,size);
                                                obj.detail.monthsDetail[k].costTxs=(obj.detail.monthsDetail[k].costTxs||[]).slice(0,size);
                                            });
                                        }
                                        json=JSON.stringify(obj);
                                        if(json.length<=CAP)break;
                                    }
                                }
                                if(json.length>CAP){
                                    json=JSON.stringify({value:obj.value,rolling:obj.rolling,months:obj.months});
                                }
                            }
                            payload[STRAT_PF.kpiDetailJson]=json;
                        }catch(e){console.warn('[runAutomatedKpis] stringify failed',e)}
                        const url=`https://api.airtable.com/v0/${BASE_ID}/${STRAT_PROJECTS_TABLE}/${rec.id}?returnFieldsByFieldId=true`;
                        const resp=await fetch(url,{
                            method:'PATCH',
                            headers:{'Authorization':`Bearer ${PAT}`,'Content-Type':'application/json'},
                            body:JSON.stringify({fields:payload,typecast:true}),
                        });
                        if(!resp.ok)console.warn('[runAutomatedKpis] PATCH',rec.id,'returned',resp.status);
                    }catch(e){console.warn('[runAutomatedKpis] PATCH failed for',rec.id,e)}
                })();
            }catch(e){console.warn('[runAutomatedKpis] per-project error',e)}
        }
    }

    function renderStrategicKpis(){
        const section=document.getElementById('strategicKpiSection');
        const list=document.getElementById('strategicKpiList');
        const pills=document.getElementById('strategicKpiPills');
        const countEl=document.getElementById('strategicKpiCount');
        if(!section||!list||!pills)return;
        const active=_strategicKpiProjects.filter(p=>p.kpiName&&!p.completed&&p.status!=='Completed');
        if(!active.length){section.style.display='none';return}
        section.style.display='block';

        // Filter pills — match the sage-executive token palette used on the rest of the page.
        const filters=['all','Real Estate','Operations Director','Personal'];
        pills.innerHTML=filters.map(f=>{
            const label=f==='all'?'All':f;
            const isActive=strategicKpiFilter===f;
            const bg=isActive?'var(--accent)':'var(--bg-surface)';
            const color=isActive?'var(--accent-on)':'var(--text-secondary)';
            const border=isActive?'var(--accent)':'var(--border-default)';
            return `<button onclick="setStrategicKpiFilter('${f.replace(/'/g,"\\'")}')" style="padding:6px 14px;border-radius:var(--radius-full);border:1px solid ${border};background:${bg};color:${color};font-size:var(--fs-sm);font-weight:var(--fw-semibold);cursor:pointer;transition:background var(--dur-fast) var(--ease),border-color var(--dur-fast) var(--ease)">${escHtml(label)}</button>`;
        }).join('');

        let filtered=active.slice();
        if(strategicKpiFilter!=='all')filtered=filtered.filter(p=>p.business===strategicKpiFilter);
        countEl.textContent=`· ${filtered.length} active KPI${filtered.length!==1?'s':''}`;

        if(!filtered.length){list.innerHTML=`<div style="padding:20px;text-align:center;color:var(--text-secondary);background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg)">No active KPIs for this business.</div>`;list.style.cssText='';return}

        // Row layout: Project+Business | Owner | KPI | Current / Target | Progress | Status | Updated
        // Project name can wrap to two lines; the business pill sits underneath it for at-a-glance context.
        list.innerHTML=filtered.map(p=>{
            const health=_stratComputeHealth(p);
            const healthColor=_stratHealthColour(health);
            const pct=p.kpiTarget>0?Math.min(100,(p.kpiCurrent/p.kpiTarget)*100):0;
            const unitPrefix=p.kpiUnit==='£'?'£':'';
            const unitSuffix=['%','count','days','items','hours'].includes(p.kpiUnit)?' '+p.kpiUnit:'';
            const ownerChip=(()=>{
                if(!p.owner||!p.owner.email)return '<span style="font-size:var(--fs-xs);color:var(--text-muted)">No owner</span>';
                const k=STRAT_TEAM_KEYS[p.owner.email]||'';
                const initials=(p.owner.name||'?').split(' ').map(w=>w[0]).join('').slice(0,2);
                return `<span class="avatar avatar-${k}" style="width:22px;height:22px;font-size:10px;display:inline-flex;align-items:center;justify-content:center;border-radius:50%" title="${escHtml(p.owner.name||'')}">${escHtml(initials)}</span>`;
            })();
            // Business pill — sits under the project name, same spirit as category chips elsewhere.
            const businessPill=p.business
                ? `<span style="display:inline-block;font-size:var(--fs-xs);font-weight:var(--fw-medium);color:var(--text-secondary);background:var(--bg-subtle);padding:2px 8px;border-radius:var(--radius-full);letter-spacing:0.01em">${escHtml(p.business)}</span>`
                : `<span style="display:inline-block;font-size:var(--fs-xs);color:var(--text-muted);font-style:italic">No business</span>`;
            // Staleness / auto indicator — now uses success/danger/text tokens.
            let stamp='';
            if(p.kpiAutomated){
                stamp=`<span style="font-size:10px;font-weight:var(--fw-semibold);color:var(--accent);background:var(--accent-soft);padding:2px 6px;border-radius:var(--radius-sm)">Auto</span>`;
            }else{
                const days=_stratDaysAgo(p.kpiLastUpdated);
                if(days===null)stamp=`<span style="font-size:var(--fs-xs);color:var(--danger);font-weight:var(--fw-semibold)">Never updated</span>`;
                else if(days>7)stamp=`<span style="font-size:var(--fs-xs);color:var(--danger);font-weight:var(--fw-semibold)">${days}d stale</span>`;
                else stamp=`<span style="font-size:var(--fs-xs);color:var(--text-secondary)">${days<1?'today':days===1?'1d ago':days+'d ago'}</span>`;
            }
            // Optional month-by-month breakdown from kpiReturn.months.
            const kRet=p.kpiReturn||p.kpiDetail||null;
            const hasMonths=!!(kRet&&kRet.months&&Object.keys(kRet.months).length);
            const hasDetail=!!(kRet&&kRet.detail);
            let monthsRow='';
            if(hasMonths){
                const monthNames={'01':'Jan','02':'Feb','03':'Mar','04':'Apr','05':'May','06':'Jun','07':'Jul','08':'Aug','09':'Sep','10':'Oct','11':'Nov','12':'Dec'};
                const cells=Object.keys(kRet.months).sort().map(k=>{
                    const [,mm]=k.split('-');const label=monthNames[mm]||k;
                    const v=kRet.months[k];
                    const hit=p.kpiTarget>0&&v>=p.kpiTarget;
                    const clickable=hasDetail&&kRet.detail.monthsDetail&&kRet.detail.monthsDetail[k];
                    const onclick=clickable?`onclick="toggleStratKpiDrill('${p.id}','${k}');event.stopPropagation();event.preventDefault();return false"`:'';
                    const cursor=clickable?'cursor:pointer;':'';
                    const hitBg=hit?'var(--success-bg)':'var(--bg-surface-2)';
                    const hitColor=hit?'var(--success)':'var(--text-secondary)';
                    return `<span ${onclick} style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:${hitBg};color:${hitColor};border-radius:var(--radius-full);font-size:var(--fs-xs);font-variant-numeric:tabular-nums;${cursor}" title="${clickable?'Click to see the transactions':''}"><b>${label}</b> ${unitPrefix}${(v||0).toLocaleString('en-GB')}${unitSuffix}</span>`;
                }).join(' ');
                const totalClick=hasDetail?`<button onclick="toggleStratKpiDrill('${p.id}','rolling');event.stopPropagation();event.preventDefault();return false" style="background:var(--bg-surface);border:1px solid var(--border-default);color:var(--text-secondary);padding:2px 8px;border-radius:var(--radius-full);font-size:var(--fs-xs);cursor:pointer;margin-left:6px">Rolling 31d ▾</button>`:'';
                monthsRow=`<div style="grid-column:1/-1;padding:0 14px 10px 14px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-top:none;border-bottom:none;font-size:var(--fs-xs);color:var(--text-secondary)"><span style="margin-right:6px;color:var(--text-muted)">Per month:</span>${cells}${totalClick}</div>`;
            }
            // Drilldown container (hidden until toggled)
            const drillId=`stratKpiDrill-${p.id}`;
            const drillRow=`<div id="${drillId}" data-expanded="" style="display:none;grid-column:1/-1;padding:14px;background:var(--bg-surface-2);border:1px solid var(--border-subtle);border-top:none;border-bottom:none;font-size:var(--fs-sm)"></div>`;
            return `<div class="strat-kpi-row" data-project-id="${p.id}" style="display:grid;grid-template-columns:2.2fr 32px 2fr 1.3fr 110px 96px 96px;gap:12px;align-items:start;padding:12px 14px;background:var(--bg-surface);border:1px solid var(--border-subtle);border-bottom:none;font-size:var(--fs-base);${hasDetail?'cursor:pointer':''};transition:background var(--dur-fast) var(--ease)" ${hasDetail?`onclick="toggleStratKpiDrill('${p.id}','rolling')"`:''} onmouseover="this.style.background='var(--bg-surface-2)'" onmouseout="this.style.background='var(--bg-surface)'">
                <div style="display:flex;flex-direction:column;gap:4px;min-width:0">
                    <div style="font-weight:var(--fw-semibold);color:var(--text-primary);line-height:1.35;word-break:break-word">${escHtml(p.name)}</div>
                    ${businessPill}
                </div>
                <div style="text-align:center;padding-top:2px">${ownerChip}</div>
                <div style="color:var(--text-secondary);line-height:1.35;word-break:break-word;padding-top:2px" title="${escHtml(p.kpiName)}">${escHtml(p.kpiName)}</div>
                <div style="color:var(--text-primary);font-variant-numeric:tabular-nums;padding-top:2px">${unitPrefix}${p.kpiCurrent.toLocaleString('en-GB')}${unitSuffix} <span style="color:var(--text-muted)">/ ${unitPrefix}${p.kpiTarget.toLocaleString('en-GB')}${unitSuffix}</span></div>
                <div style="height:8px;background:var(--bg-subtle);border-radius:var(--radius-sm);overflow:hidden;margin-top:6px"><div style="height:100%;width:${pct}%;background:${healthColor};border-radius:var(--radius-sm);transition:width var(--dur-slow) var(--ease)"></div></div>
                <div style="font-size:var(--fs-xs);font-weight:var(--fw-semibold);color:${healthColor};text-align:center;padding-top:2px">${escHtml(health)}</div>
                <div style="text-align:right;padding-top:2px">${stamp}</div>
            </div>${monthsRow}${drillRow}`;
        }).join('')+`<div style="height:1px;background:var(--border-subtle)"></div>`;
        // Rounded wrapper around the whole stack.
        list.style.cssText='border-radius:var(--radius-lg);overflow:hidden;border:1px solid var(--border-default);box-shadow:var(--shadow-sm)';
    }

    function setStrategicKpiFilter(f){strategicKpiFilter=f;renderStrategicKpis()}
    window.setStrategicKpiFilter=setStrategicKpiFilter;

    // Expand/collapse a project's KPI drilldown showing the transactions
    // that made up the calculation. bucket = 'rolling' | 'YYYY-MM'
    function toggleStratKpiDrill(pid, bucket){
        const p=_strategicKpiProjects.find(x=>x.id===pid);if(!p)return;
        const kRet=p.kpiReturn||p.kpiDetail;
        if(!kRet||!kRet.detail)return;
        const el=document.getElementById(`stratKpiDrill-${pid}`);if(!el)return;
        const currentKey=el.getAttribute('data-expanded');
        const newKey=(currentKey===bucket)?'':bucket;
        if(!newKey){el.style.display='none';el.setAttribute('data-expanded','');return}
        let detail=null, label='';
        if(bucket==='rolling'){detail=kRet.detail.rolling;label='Rolling 31 days'}
        else if(kRet.detail.monthsDetail&&kRet.detail.monthsDetail[bucket]){
            detail=kRet.detail.monthsDetail[bucket];
            const [y,m]=bucket.split('-');
            const monthNames={'01':'January','02':'February','03':'March','04':'April','05':'May','06':'June','07':'July','08':'August','09':'September','10':'October','11':'November','12':'December'};
            label=`${monthNames[m]||m} ${y}`;
        }
        if(!detail){el.style.display='none';return}
        // Task-completion KPIs have no transactions — render a tasks list instead.
        const displayHint0=(kRet&&kRet.display)||{};
        if(displayHint0.kind==='taskCompletion'){
            const done=detail.completedTasks||[];
            const open=detail.outstandingTasks||[];
            const row=t=>`<tr style="border-top:1px solid #f1f5f9"><td style="padding:6px 8px;color:#1e293b">${escHtml(t.name||'(Untitled)')}</td><td style="padding:6px 8px;font-size:11px;color:#64748b">${escHtml(t.status||'')}</td><td style="padding:6px 8px;font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#64748b">${escHtml((t.dueDate||t.completion||'').slice(0,10))}</td></tr>`;
            const table=(title,list,color)=>`<div style="margin-top:8px;padding:10px;background:#fff;border:1px solid #e2e8f0;border-radius:6px">
                <div style="font-weight:600;color:${color};margin-bottom:6px">${title} · ${list.length} task${list.length===1?'':'s'}</div>
                ${list.length?`<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.5px"><th style="padding:4px 8px;text-align:left">Task</th><th style="padding:4px 8px;text-align:left">Status</th><th style="padding:4px 8px;text-align:left">Date</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table>`:'<div style="color:#94a3b8;font-style:italic;font-size:12px">None</div>'}
            </div>`;
            el.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <div><strong>${escHtml(label)}</strong> · ${escHtml(detail.label||'')}</div>
                <button onclick="toggleStratKpiDrill('${pid}','${bucket}')" style="background:none;border:1px solid #cbd5e1;padding:2px 10px;border-radius:4px;cursor:pointer;font-size:11px">Close ▴</button>
              </div>
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px">
                <div style="padding:10px;background:#f0fdf4;border-radius:6px"><div style="font-size:10px;color:#14532d;font-weight:600;text-transform:uppercase">Completed</div><div style="font-size:16px;font-weight:700;color:#14532d">${detail.completedCount||0}</div></div>
                <div style="padding:10px;background:#fef2f2;border-radius:6px"><div style="font-size:10px;color:#991b1b;font-weight:600;text-transform:uppercase">Outstanding</div><div style="font-size:16px;font-weight:700;color:#991b1b">${detail.outstandingCount||0}</div></div>
                <div style="padding:10px;background:#eff6ff;border-radius:6px"><div style="font-size:10px;color:#1e3a8a;font-weight:600;text-transform:uppercase">Total</div><div style="font-size:16px;font-weight:700;color:#1e3a8a">${detail.total||0}</div></div>
              </div>
              ${table('Completed',done,'#14532d')}
              ${table('Outstanding',open,'#991b1b')}`;
            el.style.display='block';el.setAttribute('data-expanded',bucket);
            return;
        }
        const unitPrefix=p.kpiUnit==='£'?'£':'';
        const fmtAmt=n=>`${unitPrefix}${(n||0).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
        const fmtSigned=n=>{
            const num=Number(n)||0;
            const abs=Math.abs(num);
            const str=`${unitPrefix}${abs.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
            return num<0?`<span style="color:#991b1b">−${str}</span>`:str;
        };
        // Determine column layout for revenue rows from the compute output's
        // display hint (if any). Default: Date / Tenancy / Description / Amount.
        // For MRR-style KPIs the compute can set display.revenueColumns to
        // ['date','description','amount'] to drop the Tenancy column.
        const displayHint=(kRet&&kRet.display)||{};
        const txTable=(title,list,color,kind)=>{
            const columns=(kind==='revenue'&&displayHint.revenueColumns)
                ? displayHint.revenueColumns
                : ['date', kind==='revenue'?'tenancy':'cost', 'description', 'amount'];
            const headerFor={date:'Date',tenancy:'Tenancy',cost:'Cost',description:'Description',amount:'Amount'};
            if(!list||!list.length)return `<div style="margin-top:8px;padding:8px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;color:#94a3b8;font-style:italic">No ${title.toLowerCase()} transactions in this window</div>`;
            const rows=list.map(t=>{
                const isReversal=kind==='revenue'?t.amount<0:t.amount>0;
                const rowBg=isReversal?'background:#fef9c3':'';
                const reversalTag=isReversal?'<span style="font-size:10px;color:#a16207;background:#fde68a;padding:1px 5px;border-radius:3px;margin-right:4px">REVERSAL</span>':'';
                const cellFor=(col,isFirst)=>{
                    const tag=isFirst?reversalTag:'';
                    if(col==='date')return `<td style="padding:6px 8px;white-space:nowrap;color:#64748b;font-family:ui-monospace,Menlo,monospace;font-size:11px">${escHtml(t.date||'')}</td>`;
                    if(col==='tenancy')return `<td style="padding:6px 8px;color:#1e293b">${tag}${escHtml(t.tenancy||t.vendor||'-')}</td>`;
                    if(col==='cost')return `<td style="padding:6px 8px;color:#1e293b">${tag}${escHtml(t.cost||t.vendor||'-')}</td>`;
                    if(col==='description')return `<td style="padding:6px 8px;color:#1e293b">${tag}${escHtml((t.description||'').slice(0,120))}</td>`;
                    if(col==='amount')return `<td style="padding:6px 8px;text-align:right;font-variant-numeric:tabular-nums;color:#1e293b">${fmtSigned(t.amount)}</td>`;
                    return '<td></td>';
                };
                return `<tr style="border-top:1px solid #f1f5f9;${rowBg}">${columns.map((c,i)=>cellFor(c,i===1)).join('')}</tr>`;
            }).join('');
            return `<div style="margin-top:8px;padding:10px;background:#fff;border:1px solid #e2e8f0;border-radius:6px">
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
                    <div style="font-weight:600;color:${color}">${title} · ${list.length} tx · Net ${fmtAmt(kind==='revenue'?(list.reduce((s,t)=>s+(Number(t.amount)||0),0)):(list.reduce((s,t)=>s+(-Number(t.amount)||0),0)))}</div>
                </div>
                <table style="width:100%;border-collapse:collapse;font-size:12px">
                    <thead><tr style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.5px">
                        ${columns.map(c=>`<th style="padding:4px 8px;text-align:${c==='amount'?'right':'left'}">${headerFor[c]||c}</th>`).join('')}
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
        };
        el.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <div><strong>${escHtml(label)}</strong> · Window: ${escHtml(detail.windowStart||'-')} → ${escHtml(detail.windowEnd||'-')}</div>
                <button onclick="toggleStratKpiDrill('${pid}','${bucket}')" style="background:none;border:1px solid #cbd5e1;padding:2px 10px;border-radius:4px;cursor:pointer;font-size:11px">Close ▴</button>
            </div>
            <div style="display:grid;grid-template-columns:${displayHint.hideCosts?'1fr':'1fr 1fr 1fr'};gap:10px;margin-bottom:10px">
                <div style="padding:10px;background:#f0fdf4;border-radius:6px"><div style="font-size:10px;color:#14532d;font-weight:600;text-transform:uppercase">${escHtml(displayHint.revenueLabel||'Revenue')}</div><div style="font-size:16px;font-weight:700;color:#14532d">${fmtAmt(detail.revenue)}</div></div>
                ${displayHint.hideCosts?'':`<div style="padding:10px;background:#fef2f2;border-radius:6px"><div style="font-size:10px;color:#991b1b;font-weight:600;text-transform:uppercase">Fixed Costs</div><div style="font-size:16px;font-weight:700;color:#991b1b">${fmtAmt(detail.costs)}</div></div>`}
                ${displayHint.hideCosts?'':`<div style="padding:10px;background:#eff6ff;border-radius:6px"><div style="font-size:10px;color:#1e3a8a;font-weight:600;text-transform:uppercase">Cushion</div><div style="font-size:16px;font-weight:700;color:${detail.net>=0?'#14532d':'#991b1b'}">${fmtAmt(detail.net)}</div></div>`}
            </div>
            ${txTable(displayHint.revenueLabel||'Revenue', detail.revTxs, '#14532d', 'revenue')}
            ${displayHint.hideCosts?'':txTable('Fixed Costs', detail.costTxs, '#991b1b', 'costs')}`;
        el.style.display='block';
        el.setAttribute('data-expanded',bucket);
    }
    window.toggleStratKpiDrill=toggleStratKpiDrill;

    // ── Dashboard Load ──
    async function loadDashboard() {
        // Kick off Strategic KPIs loading IMMEDIATELY — parallel with everything
        // below. It used to fire AFTER the main 9-table fetch landed (transactions
        // alone is ~7k rows paginated) which pushed the KPIs section to ~60s on
        // cold loads, AND it was also firing a second time after cache render,
        // doubling the compute work. Now: one call, as early as possible, racing
        // against the main fetch instead of queueing behind it.
        loadStrategicKpis();

        // Try instant render from cache first
        const cached = await loadDashCache();
        let renderedFromCache = false;
        if (cached) {
            try {
                const d = cached.data;
                allTransactions = d.transactions;
                allTenancies   = d.tenancies;
                allTenants     = d.tenants;
                allCosts       = d.costs;
                allCategories  = d.categories;
                allSubCategories = d.subCategories;
                allBusinesses  = d.businesses;
                // Let runAutomatedKpis (fired via loadStrategicKpis at top) proceed.
                markMainDataReady();
                renderDashboard(d.accounts, d.costs, d.tenancies, d.transactions, d.rentalUnits, d.tenants);
                document.getElementById('dashboard').style.display = 'block';
                document.getElementById('loadingOverlay').style.display = 'none';
                setRefreshingIndicator(true, cached.ageMs);
                renderedFromCache = true;
            } catch (e) {
                console.warn('Cache render failed, falling back to full load:', e);
                clearDashCache();
                renderedFromCache = false;
            }
        }

        if (!renderedFromCache) {
            document.getElementById('loadingOverlay').style.display = 'flex';
            document.getElementById('loadingSpinner').style.display = '';
            document.getElementById('loadingText').textContent = 'Loading your dashboard...';
            document.getElementById('loadingActions').style.display = 'none';
        }

        try {
            // Fetch Airtable data and Gmail invoices in parallel
            const [accounts, costs, tenancies, transactions, rentalUnits, tenants, categories, subCategories, businesses] = await Promise.all([
                airtableFetch(TABLES.accounts),
                airtableFetch(TABLES.costs),
                airtableFetch(TABLES.tenancies),
                airtableFetch(TABLES.transactions),
                airtableFetch(TABLES.rentalUnits),
                airtableFetch(TABLES.tenants),
                airtableFetch(TABLES.categories),
                airtableFetch(TABLES.subCategories),
                airtableFetch(TABLES.businesses),
            ]);

            // Fire invoice fetch from Airtable + Gmail sync + Fintable sync check in parallel (non-blocking)
            fetchInvoicesFromAirtable();
            triggerGmailInvoiceSync();
            checkFintableSyncStatus();

            allTransactions = transactions;
            allTenancies = tenancies;
            allTenants = tenants;
            allCosts = costs;
            allCategories = categories;
            allSubCategories = subCategories;
            allBusinesses = businesses;
            // Signal to runAutomatedKpis that the globals it depends on are now
            // populated. (No-op if cache-hit already resolved it.)
            markMainDataReady();

            // Clear stale "returned" flags — if Airtable now shows In Payment, the flag is no longer needed
            tenancies.forEach(t => {
                const status = getPaymentStatusName(getField(t, F.tenPayStatus)).toLowerCase().trim();
                if (status === 'in payment') {
                    localStorage.removeItem('cfv_' + t.id + '_returned');
                }
            });
            renderDashboard(accounts, costs, tenancies, transactions, rentalUnits, tenants);

            // Save fresh data to cache for next instant reload
            saveDashCache({ accounts, costs, tenancies, transactions, rentalUnits, tenants, categories, subCategories, businesses });

            document.getElementById('dashboard').style.display = 'block';
            document.getElementById('loadingOverlay').style.display = 'none';
            setRefreshingIndicator(false);

            // Update sidebar badges on load
            updateSitemapBadge();
            // CFV badges: quick count from tenancy data
            try {
                const cfvList = detectCFVs();
                const visible = cfvList.filter(e => {
                    if (e.status === 'cfv' || e.status === 'potential') return !localStorage.getItem('cfv_dismissed_' + e.tenancyId);
                    return true;
                });
                updateCFVSidebarBadges(
                    visible.filter(e => e.status === 'cfv' || e.status === 'potential').length,
                    visible.filter(e => e.status === 'cfv actioned').length
                );
            } catch(e) { console.warn('Badge update failed:', e); }

            // Schedule smart refresh — defers if user is actively interacting
            if (refreshTimer) clearInterval(refreshTimer);
            refreshTimer = setInterval(() => smartRefresh(), REFRESH_INTERVAL);
            // (Strategic KPIs already loading — fired at the top of loadDashboard so
            // they render in parallel with the main fetch instead of behind it.)
        } catch (e) {
            if (e.message === 'Auth failed') { clearDashCache(); return; }
            console.error(e);
            // If we're already showing cached data, keep it visible and just flag the refresh failure
            if (renderedFromCache) {
                const el = document.getElementById('refreshingBadge');
                if (el) {
                    el.innerHTML = '<span class="refresh-dot" style="background:#dc2626"></span>' +
                        'Couldn\u2019t refresh \u2014 showing saved data';
                    el.style.display = 'inline-flex';
                }
                return;
            }
            document.getElementById('loadingSpinner').style.display = 'none';
            document.getElementById('loadingText').innerHTML =
                '<div style="font-size:20px;color:#dc2626;margin-bottom:8px">Couldn\u2019t load your dashboard</div>' +
                '<div style="font-size:14px;color:#475569;max-width:480px;text-align:center">' +
                (e.message || 'Unknown error') + '</div>';
            document.getElementById('loadingActions').style.display = 'block';
        }
    }

    function renderDashboard(accounts, costs, tenancies, transactions, rentalUnits, tenants) {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // Header
        document.getElementById('headerDate').textContent =
            now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) +
            ' | Combined Accounts: Santander + TNT Mgt Zempler';
        document.getElementById('lastUpdated').textContent =
            now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

        // ── SECTION 1: Financial Overview ──
        const santanderRec = accounts.find(r => r.id === REC.santander);
        const zemplerRec = accounts.find(r => r.id === REC.tntZempler);
        const santBal = Number(getField(santanderRec, F.accGBP)) || 0;
        const zempBal = Number(getField(zemplerRec, F.accGBP)) || 0;
        const openingBalance = santBal + zempBal;

        // Unreconciled transactions
        const unreconciledTx = transactions.filter(r => {
            const reconciled = getField(r, F.txReconciled);
            const alias = getField(r, F.txAccountAlias);
            return !reconciled && isOurAccount(alias);
        });

        // Monthly Income — split into In Payment only (low) and In Payment + CFV Actioned (high)
        const inPaymentTenanciesS1 = tenancies.filter(r => getPaymentStatusName(getField(r, F.tenPayStatus)).trim().toLowerCase() === 'in payment' && isTenantStatusActive(r));
        const cfvActionedTenanciesS1 = tenancies.filter(r => getPaymentStatusName(getField(r, F.tenPayStatus)).trim().toLowerCase() === 'cfv actioned' && isTenantStatusActive(r));
        const incTenancies = [...inPaymentTenanciesS1, ...cfvActionedTenanciesS1];
        const inPaymentIncome = inPaymentTenanciesS1.reduce((s, r) => s + (Number(getField(r, F.tenRent)) || 0), 0);
        const cfvActionedIncome = cfvActionedTenanciesS1.reduce((s, r) => s + (Number(getField(r, F.tenRent)) || 0), 0);
        const monthlyIncome = inPaymentIncome + cfvActionedIncome; // full = In Payment + CFV Actioned
        const inPaymentCount = inPaymentTenanciesS1.length;
        const cfvActionedCount = cfvActionedTenanciesS1.length;

        // Monthly Costs — include ALL active/in-payment costs regardless of which account they're paid from
        const activeCosts = costs.filter(r => isCostActive(r));
        const monthlyCosts = activeCosts.reduce((s, r) => s + (Number(getField(r, F.costExpected)) || 0), 0);

        // Operating cushion = revenue − fixed costs. (Distinct from gross profit = revenue − COGS,
        // and from operating profit = revenue − fixed − variable costs, which we'll compute elsewhere.)
        // Low = In Payment only minus costs; High = (In Payment + CFV Actioned) income minus costs.
        const operatingCushionLow = inPaymentIncome - monthlyCosts;
        const operatingCushionHigh = monthlyIncome - monthlyCosts;
        const operatingCushionMarginLow = inPaymentIncome > 0 ? (operatingCushionLow / inPaymentIncome * 100).toFixed(2) : '0.00';
        const operatingCushionMarginHigh = monthlyIncome > 0 ? (operatingCushionHigh / monthlyIncome * 100).toFixed(2) : '0.00';

        // Sort income tenancies by due day asc, costs by due day asc
        const incSorted = [...incTenancies].sort((a, b) => (getNumVal(a, F.tenDueDay, 99)) - (getNumVal(b, F.tenDueDay, 99)));
        const costSorted = [...activeCosts].sort((a, b) => (getNumVal(a, F.costDueDay, 99)) - (getNumVal(b, F.costDueDay, 99)));

        // Unreconciled transactions bar (above Financial Overview, alongside Balance Calculator)
        // Accuracy stats now live in Airtable (TABLES.reconAudit). getReconAccuracyStats() returns
        // cached values for an instant paint; the async refresh below rehydrates from Airtable and
        // swaps in fresh HTML without disturbing the Unreconciled card next to it.
        const accCard = buildAccuracyKPIHtml(getReconAccuracyStats());
        document.getElementById('reconBar').innerHTML = `
            ${expandableCard('Unreconciled Transactions', unreconciledTx.length, `Santander + TNT Mgt Zempler`,
                (unreconciledTx.length === 0
                    ? '<div class="detail-item"><span><em>No unreconciled transactions</em></span></div>'
                    : unreconciledTx.map(r => `<div class="detail-item"><span class="detail-item-name">${escHtml(getField(r, F.txDate) || '')} — ${escHtml(txLabel(r))}</span><span class="detail-item-value">${fmt(Number(getField(r, F.txReportAmount)) || 0)}</span></div>`).join(''))
                + `<div style="margin-top:12px;padding-top:12px;border-top:1px solid #e2e8f0;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <button onclick="event.stopPropagation(); triggerReconciliation(this)" style="padding:8px 16px;font-size:12px;font-weight:600;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer">Run Reconciliation</button>
                    <span style="font-size:11px;color:#94a3b8" id="reconStatus"></span>
                </div>`
            )}
            <div id="accuracyKpiCard">${accCard}</div>
        `;
        // Background: migrate legacy localStorage log → Airtable (one-shot, no-op after first run),
        // then refresh from Airtable and swap in the up-to-date card.
        (async () => {
            try { await migrateLocalReconLog(); } catch {}
            try {
                const fresh = await refreshReconAccuracyStats();
                const host = document.getElementById('accuracyKpiCard');
                if (host) host.innerHTML = buildAccuracyKPIHtml(fresh);
            } catch {}
        })();

        document.getElementById('financialCards').innerHTML = `
            <div class="kpi-card">
                <div class="kpi-card-label">Opening Balance</div>
                <div class="kpi-card-value">${fmt(openingBalance)}</div>
                <div class="kpi-card-sub">Santander ${fmt(santBal)} | TNT Zempler ${fmt(zempBal)}</div>
            </div>
            ${expandableCard('Monthly Income', `<span style="color:#d97706">£${Math.floor(inPaymentIncome).toLocaleString('en-GB')}</span> <span style="color:#94a3b8;font-size:20px;margin:0 4px">–</span> <span style="color:#16a34a">£${Math.floor(monthlyIncome).toLocaleString('en-GB')}</span>`,
                `${inPaymentCount} In Payment (confirmed) + ${cfvActionedCount} CFV Actioned (expected)`,
                `<div style="margin-bottom:8px;font-weight:600;color:#1e293b">In Payment (${inPaymentCount})</div>` +
                [...inPaymentTenanciesS1].sort((a,b) => (Number(getField(a, F.tenDueDay))||99) - (Number(getField(b, F.tenDueDay))||99)).map(r => {
                    const dueDay = getNumVal(r, F.tenDueDay, null);
                    const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                    return `<div class="detail-item"><span class="detail-item-name"><span style="color:#64748b;min-width:52px;display:inline-block">${escHtml(dueDayStr)}</span>${escHtml(String(getField(r, F.tenSurname) || ''))} – ${escHtml(String(getField(r, F.tenRef) || ''))}</span><span class="detail-item-value">${fmt(Number(getField(r, F.tenRent)) || 0)}</span></div>`;
                }).join('') +
                `<div class="detail-total"><span>In Payment Subtotal</span><span>${fmt(inPaymentIncome)}</span></div>` +
                (cfvActionedCount > 0 ? `<div style="margin:12px 0 8px;font-weight:600;color:#d97706">CFV Actioned (${cfvActionedCount})</div>` +
                [...cfvActionedTenanciesS1].sort((a,b) => (Number(getField(a, F.tenDueDay))||99) - (Number(getField(b, F.tenDueDay))||99)).map(r => {
                    const dueDay = getNumVal(r, F.tenDueDay, null);
                    const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                    return `<div class="detail-item"><span class="detail-item-name"><span style="color:#64748b;min-width:52px;display:inline-block">${escHtml(dueDayStr)}</span>${escHtml(String(getField(r, F.tenSurname) || ''))} – ${escHtml(String(getField(r, F.tenRef) || ''))}</span><span class="detail-item-value">${fmt(Number(getField(r, F.tenRent)) || 0)}</span></div>`;
                }).join('') +
                `<div class="detail-total"><span>Full Total (incl. CFV Actioned)</span><span>${fmt(monthlyIncome)}</span></div>` : ''),
                ''
            )}
            ${expandableCard('Monthly Costs', fmt(monthlyCosts), `${activeCosts.length} active costs`,
                costSorted.map(r => {
                    const dueDay = getNumVal(r, F.costDueDay, null);
                    const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                    return `<div class="detail-item"><span class="detail-item-name"><span style="color:#64748b;min-width:52px;display:inline-block">${escHtml(dueDayStr)}</span>${escHtml(String(getField(r, F.costName) || ''))}</span><span class="detail-item-value">${fmt(Number(getField(r, F.costExpected)) || 0)}</span></div>`;
                }).join('') +
                `<div class="detail-total"><span>Total</span><span>${fmt(monthlyCosts)}</span></div>`,
                'text-red'
            )}
            <div class="kpi-card">
                <div class="kpi-card-label">Monthly Operating Cushion</div>
                <div class="kpi-card-value"><span style="color:#d97706">£${Math.floor(operatingCushionLow).toLocaleString('en-GB')}</span><span style="color:#94a3b8;font-size:20px;margin:0 4px">–</span><span style="color:#16a34a">£${Math.floor(operatingCushionHigh).toLocaleString('en-GB')}</span></div>
                <div class="kpi-card-sub">Monthly income minus monthly fixed costs — In Payment only → incl. CFV Actioned</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-card-label">Operating Cushion Margin</div>
                <div class="kpi-card-value"><span style="color:#d97706">${operatingCushionMarginLow}%</span><span style="color:#94a3b8;font-size:20px;margin:0 4px">–</span><span style="color:#16a34a">${operatingCushionMarginHigh}%</span></div>
                <div class="kpi-card-sub">Operating Cushion ÷ Monthly Income — In Payment only → incl. CFV Actioned</div>
            </div>
        `;

        // ── SECTION 2: Portfolio Overview ──
        const totalUnits = rentalUnits.length;
        const voidUnits = rentalUnits.filter(r => {
            const status = getField(r, F.unitStatus);
            return status && (typeof status === 'string' ? status : (status.name || '')).toLowerCase().includes('void');
        });
        const occupiedCount = totalUnits - voidUnits.length;
        const occupancyRate = totalUnits > 0 ? (occupiedCount / totalUnits * 100).toFixed(2) : '0.00';

        // Group by property
        const unitsByProperty = {};
        rentalUnits.forEach(r => {
            const propVals = lookupValues(getField(r, F.unitPropName));
            const propName = propVals.length > 0 ? propVals.join(', ') : 'Unknown';
            if (!unitsByProperty[propName]) unitsByProperty[propName] = { total: 0, occupied: 0, voids: [] };
            unitsByProperty[propName].total++;
            const status = getField(r, F.unitStatus);
            const isVoid = typeof status === 'string' && status.toLowerCase() === 'void';
            if (isVoid) {
                unitsByProperty[propName].voids.push(r);
            } else {
                unitsByProperty[propName].occupied++;
            }
        });

        document.getElementById('portfolioCards').innerHTML = `
            ${expandableCard('Total Rental Units', totalUnits, '',
                Object.entries(unitsByProperty).sort((a,b) => b[1].total - a[1].total)
                    .map(([p, d]) => `<div class="detail-item"><span class="detail-item-name">${escHtml(p)}</span><span class="detail-item-value">${d.total} units</span></div>`).join('')
            )}
            ${expandableCard('Occupied Units', occupiedCount, '',
                Object.entries(unitsByProperty).filter(([,d]) => d.occupied > 0).sort((a,b) => b[1].occupied - a[1].occupied)
                    .map(([p, d]) => `<div class="detail-item"><span class="detail-item-name">${escHtml(p)}</span><span class="detail-item-value">${d.occupied} units</span></div>`).join(''),
                'text-green'
            )}
            ${expandableCard('Void Units', voidUnits.length, '',
                voidUnits.map(r => {
                    // Primary field (formula) = display name e.g. "Unit 3 – 42 Elmdon Place"
                    let unitDisplay = getField(r, F.unitName);
                    if (Array.isArray(unitDisplay)) unitDisplay = unitDisplay.join(', ');
                    // Unit Number field
                    const unitNum = getField(r, F.unitNumber);
                    // Property Name (Short) — multipleLookupValues
                    const propVals = lookupValues(getField(r, F.unitPropName));
                    const propStr = propVals.join(', ');
                    // Build label: prefer primary field, fallback to "Unit X — Property"
                    let label;
                    if (unitDisplay && String(unitDisplay).trim()) {
                        label = String(unitDisplay).trim();
                    } else if (unitNum && propStr) {
                        label = `Unit ${unitNum} — ${propStr}`;
                    } else if (propStr) {
                        label = propStr;
                    } else if (unitNum) {
                        label = `Unit ${unitNum}`;
                    } else {
                        label = 'Unnamed Unit';
                    }
                    return `<div class="detail-item"><span class="detail-item-name">${escHtml(label)}</span></div>`;
                }).join(''),
                voidUnits.length > 0 ? 'text-amber' : 'text-green'
            )}
            <div class="kpi-card">
                <div class="kpi-card-label">Occupancy Rate</div>
                <div class="kpi-card-value ${Number(occupancyRate) >= 90 ? 'text-green' : Number(occupancyRate) >= 80 ? 'text-amber' : 'text-red'}">${occupancyRate}%</div>
                <div class="progress-bar"><div class="progress-bar-fill ${Number(occupancyRate) >= 90 ? 'green' : Number(occupancyRate) >= 80 ? 'amber' : 'red'}" style="width:${occupancyRate}%"></div></div>
            </div>
        `;

        // ── SECTION 3: Tenancy Metrics ── (all filters require active tenant status)
        const activeTenancies = tenancies.filter(r => isTenancyActive(getField(r, F.tenPayStatus)) && isTenantStatusActive(r));
        const inPaymentTenancies = tenancies.filter(r => getPaymentStatusName(getField(r, F.tenPayStatus)) === 'In Payment' && isTenantStatusActive(r));
        const cfvTenancies = tenancies.filter(r => getPaymentStatusName(getField(r, F.tenPayStatus)) === 'CFV' && isTenantStatusActive(r));
        const cfvActionedTenancies = tenancies.filter(r => getPaymentStatusName(getField(r, F.tenPayStatus)) === 'CFV Actioned' && isTenantStatusActive(r));
        const paidRate = activeTenancies.length > 0 ? (inPaymentTenancies.length / activeTenancies.length * 100).toFixed(2) : '0.00';

        const tenancyDetailList = (list) => [...list]
            .sort((a, b) => (getNumVal(a, F.tenDueDay, 99)) - (getNumVal(b, F.tenDueDay, 99)))
            .map(r => {
                const dueDay = getNumVal(r, F.tenDueDay, null);
                const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                return `<div class="detail-item"><span class="detail-item-name"><span style="color:#64748b;min-width:52px;display:inline-block">${escHtml(dueDayStr)}</span>${escHtml(String(getField(r, F.tenSurname) || ''))} – ${escHtml(String(getField(r, F.tenRef) || ''))}</span><span class="detail-item-value">${fmt(Number(getField(r, F.tenRent)) || 0)}</span></div>`;
            })
            .join('');

        const allTenancyDetails = [...activeTenancies]
            .sort((a, b) => (getNumVal(a, F.tenDueDay, 99)) - (getNumVal(b, F.tenDueDay, 99)))
            .map(r => {
                const dueDay = getNumVal(r, F.tenDueDay, null);
                const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                return `<div class="detail-item"><span class="detail-item-name"><span style="color:#64748b;min-width:52px;display:inline-block">${escHtml(dueDayStr)}</span>${escHtml(String(getField(r, F.tenSurname) || ''))} – ${escHtml(String(getField(r, F.tenRef) || ''))} (${getPaymentStatusName(getField(r, F.tenPayStatus))})</span><span class="detail-item-value">${fmt(Number(getField(r, F.tenRent)) || 0)}</span></div>`;
            })
            .join('');

        // Detect potential CFVs for the alert badge on the Leadership Dashboard
        let potentialCfvCount = 0;
        const todayForCfv = new Date();
        todayForCfv.setHours(0,0,0,0);
        tenancies.forEach(t => {
            const status = getPaymentStatusName(getField(t, F.tenPayStatus)).toLowerCase().trim();
            if (status !== 'in payment') return;
            if (!isTenantStatusActive(t)) return;
            const rent = Number(getField(t, F.tenRent)) || 0;
            if (rent <= 0) return;
            const dueDay = getNumVal(t, F.tenDueDay, 1);
            const dueThisMonth = new Date(todayForCfv.getFullYear(), todayForCfv.getMonth(), dueDay);
            const daysOver = todayForCfv >= dueThisMonth ? Math.floor((todayForCfv - dueThisMonth) / 86400000) : 0;
            const paid = getField(t, F.tenPaidThisMonth);
            if (daysOver >= CFV_TOLERANCE_DAYS && !paid && !localStorage.getItem('cfv_dismissed_' + t.id)) {
                potentialCfvCount++;
            }
        });

        const potentialCfvAlert = potentialCfvCount > 0
            ? `<div onclick="switchTab('cfv')" style="margin-top:8px;padding:8px 12px;background:#fef3c7;border:1px solid #d97706;border-radius:6px;cursor:pointer;font-size:12px;color:#92400e;display:flex;align-items:center;gap:6px">
                <span style="font-size:16px">⚠️</span>
                <span><strong>${potentialCfvCount} potential CFV${potentialCfvCount !== 1 ? 's' : ''}</strong> detected — click to review</span>
                <span style="margin-left:auto;font-size:10px;color:#d97706">View CFVs →</span>
               </div>`
            : '';

        document.getElementById('tenancyCards').innerHTML = `
            ${expandableCard('Total Tenancies', activeTenancies.length, '', allTenancyDetails)}
            ${expandableCard('In Payment', inPaymentTenancies.length, '', tenancyDetailList(inPaymentTenancies), 'text-green')}
            ${expandableCard('CFV', cfvTenancies.length, '', tenancyDetailList(cfvTenancies), 'text-amber')}
            ${expandableCard('CFV Actioned', cfvActionedTenancies.length, '', tenancyDetailList(cfvActionedTenancies), 'text-amber')}
            <div class="kpi-card">
                <div class="kpi-card-label">Paid Tenancy Rate</div>
                <div class="kpi-card-value ${Number(paidRate) >= 80 ? 'text-green' : Number(paidRate) >= 60 ? 'text-amber' : 'text-red'}">${paidRate}%</div>
                <div class="progress-bar"><div class="progress-bar-fill ${Number(paidRate) >= 80 ? 'green' : Number(paidRate) >= 60 ? 'amber' : 'red'}" style="width:${paidRate}%"></div></div>
            </div>
        `;

        // Show alert banner below tenancy metrics if potential CFVs detected
        const existingAlert = document.getElementById('cfvAlertBanner');
        if (existingAlert) existingAlert.remove();
        if (potentialCfvAlert) {
            const alertDiv = document.createElement('div');
            alertDiv.id = 'cfvAlertBanner';
            alertDiv.innerHTML = potentialCfvAlert;
            document.getElementById('tenancyCards').parentElement.appendChild(alertDiv);
        }

        // ── SECTION 4: 31-Day Operational Metrics ──
        const thirtyDaysAgo = new Date(today);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const recentTx = transactions.filter(r => {
            const d = getField(r, F.txDate);
            if (!d) return false;
            const txDate = new Date(d);
            return txDate >= thirtyDaysAgo && txDate <= today;
        });

        function txBySubCat(recIds) {
            return recentTx.filter(r => {
                const sc = getField(r, F.txSubCategory);
                if (!sc) return false;
                if (Array.isArray(sc)) return sc.some(id => recIds.includes(id));
                return recIds.includes(sc);
            });
        }

        const rentalIncTx = txBySubCat([REC.subRentalInc]);
        const rentalInc30 = rentalIncTx.reduce((s, r) => s + (Number(getField(r, F.txReportAmount)) || 0), 0);

        const maintTx = txBySubCat([REC.subMaint]);
        const maintSpend = Math.abs(maintTx.reduce((s, r) => s + (Number(getField(r, F.txReportAmount)) || 0), 0));
        const maintPct = rentalInc30 > 0 ? (maintSpend / rentalInc30 * 100).toFixed(1) : '0.0';

        const wagesTx = txBySubCat([REC.subOpexLabour, REC.subCOGSLabour]);
        const wagesSpend = Math.abs(wagesTx.reduce((s, r) => s + (Number(getField(r, F.txReportAmount)) || 0), 0));
        const wagesPct = rentalInc30 > 0 ? (wagesSpend / rentalInc30 * 100).toFixed(1) : '0.0';

        const cfvExposureTenancies = [...cfvTenancies, ...cfvActionedTenancies];
        const cfvExposure = cfvExposureTenancies.reduce((s, r) => s + (Number(getField(r, F.tenRent)) || 0), 0);
        const cfvExposurePct = monthlyIncome > 0 ? (cfvExposure / monthlyIncome * 100).toFixed(1) : '0.0';

        const txDetailList = (list, showTeamMember = false) => [...list]
            .sort((a, b) => new Date(getField(b, F.txDate)) - new Date(getField(a, F.txDate)))
            .map(r => {
                const label = showTeamMember
                    ? (() => {
                        const tm = txTeamMemberName(r);
                        const base = txLabel(r);
                        return tm ? `${tm} — ${base}` : base;
                      })()
                    : txLabel(r);
                return `<div class="detail-item"><span class="detail-item-name">${escHtml(getField(r, F.txDate) || '')} — ${escHtml(label)}</span><span class="detail-item-value">${fmt(Math.abs(Number(getField(r, F.txReportAmount)) || 0))}</span></div>`;
            })
            .join('');

        // Targets — fixed £ amounts for variable costs
        // Budget constants (also used by cash flow forecast which runs outside this function)
        // Defined at module level — see below

        // Variable cost reserve (sum of budgets)
        const variableCostReserve = MAINT_TARGET_GBP + WAGES_TARGET_GBP + CFV_TARGET_GBP; // £6,000
        // Required operating cushion = clear profit target + variable cost budgets.
        // The operating cushion must be big enough to absorb variable costs AND still leave the
        // clear profit target behind — anything less means we're eating into the profit target.
        const requiredOperatingCushion = CLEAR_PROFIT_TARGET + variableCostReserve; // £16,000

        // Traffic light uses £ targets now (actual vs budget)
        const maintNum = maintSpend;
        const wagesNum = wagesSpend;
        const cfvNum = cfvExposure;

        function targetProgressBarGBP(actual, target) {
            const tl = trafficLight(actual, target);
            const maxVal = target * 2;
            const w = Math.min(actual / maxVal * 100, 100);
            const targetPos = Math.min(target / maxVal * 100, 100);
            return `<div class="progress-bar">
                <div class="progress-bar-fill ${tl}" style="width:${w}%"></div>
                <div style="position:absolute;left:${targetPos}%;top:0;bottom:0;width:2px;background:#1e293b;border-radius:1px" title="Budget: ${fmt(target)}"></div>
            </div>`;
        }

        // Operating cushion progress towards target
        const ocProgressPct = requiredOperatingCushion > 0 ? Math.min(operatingCushionHigh / requiredOperatingCushion * 100, 150).toFixed(1) : '0.0';
        const ocOnTrack = operatingCushionHigh >= requiredOperatingCushion;

        document.getElementById('operationalCards').innerHTML = `
            ${expandableCard('Rental Income (31d)', fmt(rentalInc30), 'Actual from transactions',
                txDetailList(rentalIncTx) + `<div class="detail-total"><span>Total</span><span>${fmt(rentalInc30)}</span></div>`,
                'text-green'
            )}
            ${expandableCard('Maintenance Spend (31d)', fmt(maintSpend),
                `${maintPct}% of rent | Budget: ${fmt(MAINT_TARGET_GBP)} | ${maintSpend <= MAINT_TARGET_GBP ? '<span class="text-green">Under budget</span>' : maintSpend <= MAINT_TARGET_GBP * 1.1 ? '<span class="text-amber">On budget</span>' : '<span class="text-red">Over budget</span>'}`,
                txDetailList(maintTx) + `<div class="detail-total"><span>Total</span><span>${fmt(maintSpend)}</span></div>`,
                trafficLightClass(maintNum, MAINT_TARGET_GBP),
                targetProgressBarGBP(maintNum, MAINT_TARGET_GBP)
            )}
            ${expandableCard('Wages Spend (31d)', fmt(wagesSpend),
                `${wagesPct}% of rent | Budget: ${fmt(WAGES_TARGET_GBP)} | ${wagesSpend <= WAGES_TARGET_GBP ? '<span class="text-green">Under budget</span>' : wagesSpend <= WAGES_TARGET_GBP * 1.1 ? '<span class="text-amber">On budget</span>' : '<span class="text-red">Over budget</span>'}`,
                txDetailList(wagesTx, true) + `<div class="detail-total"><span>Total</span><span>${fmt(wagesSpend)}</span></div>`,
                trafficLightClass(wagesNum, WAGES_TARGET_GBP),
                targetProgressBarGBP(wagesNum, WAGES_TARGET_GBP)
            )}
            ${expandableCard('CFV Exposure', fmt(cfvExposure),
                `${cfvExposurePct}% of income | Budget: ${fmt(CFV_TARGET_GBP)} | ${cfvExposure <= CFV_TARGET_GBP ? '<span class="text-green">Under budget</span>' : cfvExposure <= CFV_TARGET_GBP * 1.1 ? '<span class="text-amber">On budget</span>' : '<span class="text-red">Over budget</span>'}`,
                [...cfvExposureTenancies].sort((a,b) => (Number(getField(a, F.tenDueDay))||99) - (Number(getField(b, F.tenDueDay))||99))
                    .map(r => {
                        const dueDay = getNumVal(r, F.tenDueDay, null);
                        const dueDayStr = dueDay ? `Day ${dueDay}` : '—';
                        return `<div class="detail-item"><span class="detail-item-name"><span style="color:#64748b;min-width:52px;display:inline-block">${escHtml(dueDayStr)}</span>${escHtml(String(getField(r, F.tenSurname) || ''))} – ${escHtml(String(getField(r, F.tenRef) || ''))}</span><span class="detail-item-value">${fmt(Number(getField(r, F.tenRent)) || 0)}</span></div>`;
                    })
                    .join('') + `<div class="detail-total"><span>Total</span><span>${fmt(cfvExposure)}</span></div>`,
                trafficLightClass(cfvNum, CFV_TARGET_GBP),
                targetProgressBarGBP(cfvNum, CFV_TARGET_GBP)
            )}
            <div class="kpi-card clickable" onclick="toggleCard(this)">
                <div class="kpi-card-label">Target Operating Cushion <span class="chevron">▸</span></div>
                <div class="kpi-card-value"><span class="${ocOnTrack ? 'text-green' : 'text-amber'}">£${Math.floor(operatingCushionHigh).toLocaleString('en-GB')}</span><span style="color:#94a3b8;font-size:20px;margin:0 4px">/</span><span style="color:#1e293b">£${Math.floor(requiredOperatingCushion).toLocaleString('en-GB')}</span></div>
                <div class="kpi-card-sub">${ocProgressPct}% of target | ${ocOnTrack ? `<span class="text-green">On track — ${fmt(CLEAR_PROFIT_TARGET)} clear profit</span>` : `<span class="text-red">Shortfall: ${fmt(requiredOperatingCushion - operatingCushionHigh)}</span>`}</div>
                <div class="progress-bar" style="position:relative">
                    <div class="progress-bar-fill ${ocOnTrack ? 'green' : 'amber'}" style="width:${Math.min(Number(ocProgressPct), 100)}%"></div>
                </div>
                <div class="kpi-card-detail">
                    <div style="font-size:12px;color:#64748b">
                        <div style="display:flex;justify-content:space-between;padding:3px 0"><span>Maintenance budget</span><span>${fmt(MAINT_TARGET_GBP)}</span></div>
                        <div style="display:flex;justify-content:space-between;padding:3px 0"><span>Wages budget</span><span>${fmt(WAGES_TARGET_GBP)}</span></div>
                        <div style="display:flex;justify-content:space-between;padding:3px 0"><span>CFV allowance</span><span>${fmt(CFV_TARGET_GBP)}</span></div>
                        <div style="display:flex;justify-content:space-between;padding:3px 0;border-top:1px solid #e2e8f0;margin-top:4px;padding-top:4px"><span>Variable cost reserve</span><span style="font-weight:600">${fmt(variableCostReserve)}</span></div>
                        <div style="display:flex;justify-content:space-between;padding:3px 0"><span>Clear profit target</span><span style="font-weight:600">${fmt(CLEAR_PROFIT_TARGET)}</span></div>
                        <div style="display:flex;justify-content:space-between;padding:3px 0;border-top:1px solid #e2e8f0;margin-top:4px;padding-top:4px;font-weight:600;color:#1e293b"><span>Required operating cushion</span><span>${fmt(requiredOperatingCushion)}</span></div>
                    </div>
                </div>
            </div>
        `;

        // ── SECTION 5: 31-Day Cash Flow Forecast ──
        // Build UC tenant map: tenant record ID → true if Universal Credit
        const ucTenantIds = new Set();
        tenants.forEach(t => {
            const payType = getField(t, F.tenantPayType);
            const typeName = typeof payType === 'string' ? payType : (payType && payType.name ? payType.name : '');
            if (typeName.toLowerCase().includes('universal credit')) {
                ucTenantIds.add(t.id);
            }
        });
        // Build tenancy → isUC map via linked tenant
        // Linked field returns [{id: "recXXX", name: "..."}, ...] objects
        const tenancyIsUC = {};
        tenancies.forEach(r => {
            const linked = getField(r, F.tenLinkedTenant);
            if (Array.isArray(linked)) {
                tenancyIsUC[r.id] = linked.some(item => {
                    const tenantId = typeof item === 'string' ? item : (item && item.id ? item.id : null);
                    return tenantId && ucTenantIds.has(tenantId);
                });
            }
        });

        const cashFlowRows = buildCashFlow(today, openingBalance, incTenancies, activeCosts, tenancies, transactions, monthlyIncome, tenancyIsUC);

        // ── SECTION 6: AI Analysis ──
        // Credit card balances
        const lloydsCCRec = accounts.find(r => r.id === REC.lloydsCreditCard);
        const amexRec = accounts.find(r => r.id === REC.americanExpress);
        const santanderCCRec = accounts.find(r => r.id === REC.santanderCC);
        const lloydsCCBal = Number(getField(lloydsCCRec, F.accGBP)) || 0;
        const amexBal = Number(getField(amexRec, F.accGBP)) || 0;
        const santanderCCBal = Number(getField(santanderCCRec, F.accGBP)) || 0;
        // Lloyds: shows negative balance = owed amount
        // AmEx: shows positive balance = owed amount
        // Santander CC: shows available credit; owed = limit − available
        const lloydsCCOwed = Math.abs(lloydsCCBal);
        const amexOwed = Math.max(0, amexBal);
        const santanderCCOwed = Math.max(0, SANTANDER_CC_LIMIT - santanderCCBal);
        const totalCCDebt = lloydsCCOwed + amexOwed + santanderCCOwed;

        const voidCostPerMonth = monthlyIncome > 0 && occupiedCount > 0
            ? (monthlyIncome / occupiedCount).toFixed(0)
            : 0;

        const cfvUnactioned = cfvTenancies.reduce((s, r) => s + (Number(getField(r, F.tenRent)) || 0), 0);

        // ── CREDIT CARD STRATEGIC REPAYMENT PLAN ──
        // Payment deadlines: AmEx 28th, Santander CC 14th, Lloyds CC 21st
        // Minimum payments estimated at ~2% of balance or £25 whichever is greater
        const ccRepaymentPlan = (() => {
            const cards = [
                { name: 'American Express', owed: amexOwed, dueDay: 28, recId: REC.americanExpress },
                { name: 'Santander Credit Card', owed: santanderCCOwed, dueDay: 14, recId: REC.santanderCC },
                { name: 'Lloyds Credit Card', owed: lloydsCCOwed, dueDay: 21, recId: REC.lloydsCreditCard },
            ].filter(c => c.owed > 0.01);

            // Estimate minimum payment for each card (2% of balance or £25, whichever is greater)
            cards.forEach(c => { c.minPayment = Math.max(25, c.owed * 0.02); });

            // Find minimum payment deadlines within the 31-day window
            const windowEnd = new Date(today);
            windowEnd.setDate(windowEnd.getDate() + 30);
            const deadlines = [];
            cards.forEach(c => {
                // Check this month and next month for the due day
                for (let m = 0; m <= 1; m++) {
                    const dueDate = new Date(today.getFullYear(), today.getMonth() + m, c.dueDay);
                    if (dueDate >= today && dueDate <= windowEnd) {
                        deadlines.push({ card: c.name, date: dueDate, minPayment: c.minPayment, dueDay: c.dueDay });
                    }
                }
            });
            deadlines.sort((a, b) => a.date - b.date);

            // Walk the 31-day window to find Fridays
            const fridays = [];
            let d = new Date(today);
            while (d <= windowEnd) {
                if (d.getDay() === 5) fridays.push(new Date(d));
                d.setDate(d.getDate() + 1);
            }

            const MIN_BUFFER = 750;

            // Use actual cash flow forecast rows for accurate balance estimates
            const cfRows = cashFlowRows || [];
            function getClosingBal(dayIdx) {
                if (dayIdx >= 0 && dayIdx < cfRows.length) return cfRows[dayIdx].closing;
                return cfRows.length > 0 ? cfRows[cfRows.length - 1].closing : openingBalance;
            }

            const plans = [];
            let remainingDebt = cards.map(c => ({ ...c }));
            let cumulativePaid = 0;
            const minPaidFor = {};

            fridays.forEach((fri, idx) => {
                const daysFromNow = Math.round((fri - today) / 86400000);
                // Use actual closing balance from cash flow forecast, minus already-committed CC payments
                const estBalance = getClosingBal(daysFromNow) - cumulativePaid;

                // Look ahead 7 days using actual forecast data to find lowest point
                let worstAhead = estBalance;
                for (let ahead = 1; ahead <= 7; ahead++) {
                    const futBal = getClosingBal(daysFromNow + ahead) - cumulativePaid;
                    if (futBal < worstAhead) worstAhead = futBal;
                }

                // The limiting factor is whichever is tighter:
                // - Today's balance minus buffer
                // - Lowest upcoming balance minus buffer (protects against a dip next week)
                const fromToday = Math.max(0, estBalance - MIN_BUFFER);
                const fromLookAhead = Math.max(0, worstAhead - MIN_BUFFER);
                const available = Math.min(fromToday, fromLookAhead);

                // Build a plain-English reason for the payment amount
                let reason;
                const balanceAfterPay = estBalance - available;
                if (available < 10) {
                    reason = `Balance of ${fmt(estBalance)} is too close to the ${fmt(MIN_BUFFER)} safety buffer to make a payment.`;
                } else if (fromLookAhead < fromToday) {
                    const lowestDay = (() => {
                        let minBal = estBalance, minD = 0;
                        for (let a = 1; a <= 7; a++) {
                            const b = getClosingBal(daysFromNow + a) - cumulativePaid;
                            if (b < minBal) { minBal = b; minD = a; }
                        }
                        const d2 = new Date(fri); d2.setDate(d2.getDate() + minD);
                        return d2.toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'short'});
                    })();
                    reason = `Payment limited because the balance dips to ${fmt(worstAhead)} on ${lowestDay} next week. Keeping ${fmt(MIN_BUFFER)} buffer means ${fmt(available)} is safe to spend.`;
                } else {
                    reason = `Balance of ${fmt(estBalance)} minus ${fmt(MIN_BUFFER)} buffer = ${fmt(available)} available for payment.`;
                }

                // Check which minimum payments are due before the NEXT Friday (or end of window)
                const nextFri = fridays[idx + 1] || windowEnd;
                const upcomingMins = deadlines.filter(dl =>
                    dl.date >= fri && dl.date < nextFri && !minPaidFor[dl.card + '-' + dl.date.getMonth()]
                );

                // Priority 1: Cover minimum payments due before next Friday
                let budget = available;
                const payments = [];
                upcomingMins.forEach(dl => {
                    if (budget <= 0) return;
                    const card = remainingDebt.find(c => c.name === dl.card);
                    if (!card || card.owed <= 0) return;
                    const minPay = Math.min(dl.minPayment, card.owed, budget);
                    payments.push({ name: dl.card, pay: minPay, isMinimum: true, dueDate: dl.date });
                    card.owed -= minPay;
                    budget -= minPay;
                    cumulativePaid += minPay;
                    minPaidFor[dl.card + '-' + dl.date.getMonth()] = true;
                });

                // Priority 2: Allocate remaining surplus to highest-balance card
                const sortedDebt = [...remainingDebt].sort((a, b) => b.owed - a.owed);
                for (const card of sortedDebt) {
                    if (card.owed <= 0 || budget <= 0) continue;
                    const pay = Math.min(card.owed, budget);
                    const existing = payments.find(p => p.name === card.name);
                    if (existing) {
                        existing.pay += pay;
                        existing.isMinimum = false;
                    } else {
                        payments.push({ name: card.name, pay, isMinimum: false });
                    }
                    card.owed -= pay;
                    budget -= pay;
                    cumulativePaid += pay;
                }

                const totalPay = payments.reduce((s, p) => s + p.pay, 0);
                plans.push({
                    date: fri, estBalance, available, totalPay,
                    noFunds: totalPay < 1,
                    payments, buffer: MIN_BUFFER,
                    upcomingDeadlines: upcomingMins,
                    reason, worstAhead, balanceAfterPay: estBalance - totalPay
                });
            });
            return { cards, plans, remaining: remainingDebt, minBuffer: MIN_BUFFER, deadlines };
        })();

        const ccTableRows = ccRepaymentPlan.plans.map(p => {
            const dayStr = p.date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

            if (p.noFunds) {
                return `<div style="padding:12px 0;border-bottom:1px solid #e2e8f0;">
                    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
                        <strong style="color:#1e293b;font-size:14px">${dayStr}</strong>
                        <span style="color:#94a3b8;font-size:13px;font-weight:600">No payment this week</span>
                    </div>
                    <div style="font-size:12px;color:#64748b;line-height:1.5">${p.reason}</div>
                </div>`;
            }

            const paymentLines = p.payments.map(pay => {
                const dueBadge = pay.dueDate
                    ? `<span style="background:#fef2f2;color:#dc2626;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px">due ${pay.dueDate.toLocaleDateString('en-GB', {day:'numeric', month:'short'})}</span>`
                    : '';
                const minBadge = pay.isMinimum
                    ? `<span style="background:#fef3c7;color:#92400e;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:6px">min. payment</span>`
                    : '';
                return `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:13px;color:#475569;">
                    <span>${escHtml(pay.name)}${dueBadge}${minBadge}</span>
                    <strong>${fmt(pay.pay)}</strong>
                </div>`;
            }).join('');

            return `<div style="padding:12px 0;border-bottom:1px solid #e2e8f0;">
                <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
                    <strong style="color:#1e293b;font-size:14px">${dayStr}</strong>
                    <span style="color:#16a34a;font-weight:700;font-size:15px">Pay ${fmt(p.totalPay)}</span>
                </div>
                ${paymentLines}
                <div style="margin-top:8px;padding:8px 10px;background:#f8fafc;border-radius:6px;font-size:12px;color:#64748b;line-height:1.6">
                    <div style="display:flex;justify-content:space-between;margin-bottom:2px">
                        <span>Account balance on this date</span><strong style="color:#1e293b">${fmt(p.estBalance)}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;margin-bottom:2px">
                        <span>Credit card payment</span><strong style="color:#dc2626">-${fmt(p.totalPay)}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between;padding-top:4px;border-top:1px solid #e2e8f0;margin-top:2px">
                        <span>Balance after payment</span><strong style="color:${p.balanceAfterPay >= p.buffer ? '#16a34a' : '#d97706'}">${fmt(p.balanceAfterPay)}</strong>
                    </div>
                    <div style="display:flex;justify-content:space-between">
                        <span>Safety buffer</span><span>${fmt(p.buffer)}</span>
                    </div>
                    <div style="margin-top:6px;padding-top:6px;border-top:1px solid #e2e8f0;color:#475569;font-size:11px">${p.reason}</div>
                </div>
            </div>`;
        }).join('');

        // ── AI COMMENTARY — titled sections ──
        const maintStatus = maintSpend < MAINT_TARGET_GBP ? 'green' : maintSpend <= MAINT_TARGET_GBP * 1.1 ? 'amber' : 'red';
        const wagesStatus = wagesSpend < WAGES_TARGET_GBP ? 'green' : wagesSpend <= WAGES_TARGET_GBP * 1.1 ? 'amber' : 'red';

        document.getElementById('aiCommentary').innerHTML = `
            <h3 style="color:#1e293b;font-size:15px;margin:0 0 8px">Financial Health</h3>
            <p>The portfolio generates ${fmt(inPaymentIncome)} confirmed monthly income (In Payment) with a further ${fmt(cfvActionedIncome)} from ${cfvActionedCount} CFV Actioned tenancies, giving a best-case total of ${fmt(monthlyIncome)}. Against ${fmt(monthlyCosts)} in fixed costs, the operating cushion margin ranges from ${operatingCushionMarginLow}% to ${operatingCushionMarginHigh}%. ${Number(operatingCushionMarginHigh) >= 40 ? 'The upper range is healthy.' : 'Margins are tight — cost reduction or occupancy gains are needed.'}</p>

            <h3 style="color:#1e293b;font-size:15px;margin:16px 0 8px">Operating Cushion Target</h3>
            <p>Target operating cushion: ${fmt(requiredOperatingCushion)}/month (${fmt(CLEAR_PROFIT_TARGET)} clear profit + ${fmt(variableCostReserve)} variable costs: ${fmt(MAINT_TARGET_GBP)} maintenance, ${fmt(WAGES_TARGET_GBP)} wages, ${fmt(CFV_TARGET_GBP)} CFV allowance). Current best-case operating cushion is ${fmt(operatingCushionHigh)} — ${ocOnTrack ? `a surplus of ${fmt(operatingCushionHigh - requiredOperatingCushion)} above target. You are on track.` : `a shortfall of ${fmt(requiredOperatingCushion - operatingCushionHigh)} (${ocProgressPct}% of target). Focus on filling voids and converting CFVs to close the gap.`}</p>

            <h3 style="color:#1e293b;font-size:15px;margin:16px 0 8px">Operational Performance (31-Day)</h3>
            <p>Actual rental income over 31 days: ${fmt(rentalInc30)}. Maintenance spend of ${fmt(maintSpend)} is ${maintStatus === 'green' ? 'under' : maintStatus === 'amber' ? 'on' : 'over'} the ${fmt(MAINT_TARGET_GBP)} budget${maintStatus === 'red' ? ' — investigate whether reactive costs can shift to planned maintenance' : ''}. Wages at ${fmt(wagesSpend)} are ${wagesStatus === 'green' ? 'under' : wagesStatus === 'amber' ? 'on' : 'over'} the ${fmt(WAGES_TARGET_GBP)} budget.</p>

            <h3 style="color:#1e293b;font-size:15px;margin:16px 0 8px">Occupancy &amp; Voids</h3>
            <p>Occupancy is ${occupancyRate}% with ${voidUnits.length} void${voidUnits.length !== 1 ? 's' : ''}. Each void costs roughly £${voidCostPerMonth}/month in lost income. ${voidUnits.length > 0 ? `Filling ${Math.min(3, voidUnits.length)} void${Math.min(3, voidUnits.length) !== 1 ? 's' : ''} would add ${fmt(Math.min(3, voidUnits.length) * Number(voidCostPerMonth))}/month — the highest-ROI lever available.` : 'Full occupancy — excellent.'}</p>

            <h3 style="color:#1e293b;font-size:15px;margin:16px 0 8px">CFV Risk</h3>
            <p>CFV exposure is ${fmt(cfvExposure)} against a ${fmt(CFV_TARGET_GBP)} monthly allowance (${cfvExposure <= CFV_TARGET_GBP ? 'within budget' : 'over budget by ' + fmt(cfvExposure - CFV_TARGET_GBP)}). ${cfvTenancies.length > 0 ? `${cfvTenancies.length} remain unactioned (${fmt(cfvUnactioned)}) — actioning these improves income certainty.` : 'All CFVs actioned — good.'}</p>

            <h3 style="color:#1e293b;font-size:15px;margin:16px 0 8px">Quick Wins</h3>
            <p>${voidUnits.length > 0 ? '(1) Fill voids — biggest revenue impact per action. ' : ''}${cfvTenancies.length > 0 ? `(${voidUnits.length > 0 ? '2' : '1'}) Action ${cfvTenancies.length} unactioned CFV${cfvTenancies.length !== 1 ? 's' : ''} to secure ${fmt(cfvUnactioned)}/month. ` : ''}${maintStatus !== 'green' ? `(${(voidUnits.length > 0 ? 1 : 0) + (cfvTenancies.length > 0 ? 1 : 0) + 1}) Reduce maintenance from ${fmt(maintSpend)} to below ${fmt(MAINT_TARGET_GBP)} budget. ` : ''}Monitor cash flow pinch points around mortgage payment clusters (typically days 1-6).</p>

            <hr style="border:none;border-top:1px solid #cbd5e1;margin:20px 0;">
            <h3 style="color:#1e293b;font-size:16px;margin:0 0 12px">Strategic Credit Card Repayment Plan</h3>
            <p style="margin:0 0 8px">Total credit card debt: <strong>${fmt(totalCCDebt)}</strong> across ${ccRepaymentPlan.cards.length} card${ccRepaymentPlan.cards.length !== 1 ? 's' : ''}.</p>
            <p style="margin:0 0 12px;font-size:13px;color:#475569">Strategy: weekly payments each Friday. Minimum payments are prioritised before each card's due date. Remaining surplus allocated highest-balance first. Buffer of <strong>${fmt(ccRepaymentPlan.minBuffer)}</strong> always retained. 7-day look-ahead ensures no cash flow shortfall.</p>
            <div style="margin-bottom:16px">
                ${ccRepaymentPlan.cards.map(c => {
                    // Proper English ordinal: 11/12/13 are always 'th'; otherwise
                    // the last digit picks st/nd/rd/th. The previous one-liner
                    // matched only the literal numbers 1/2/3, so 21st rendered
                    // as "21th".
                    const d = c.dueDay;
                    const lastTwo = d % 100;
                    const last = d % 10;
                    const suffix = (lastTwo >= 11 && lastTwo <= 13) ? 'th'
                        : last === 1 ? 'st'
                        : last === 2 ? 'nd'
                        : last === 3 ? 'rd' : 'th';
                    return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:14px;">
                        <span style="color:#475569">${escHtml(c.name)} <span style="color:#94a3b8;font-size:12px">(due ${d}${suffix} | min. ${fmt(c.minPayment)})</span></span>
                        <span style="font-weight:600;color:${c.owed > 5000 ? '#dc2626' : '#d97706'}">${fmt(c.owed)}</span>
                    </div>`;
                }).join('')}
            </div>
            <div>${ccTableRows}</div>
            ${ccRepaymentPlan.remaining.some(c => c.owed > 0.01)
                ? `<p style="margin:12px 0 0;font-size:13px;color:#64748b">After 31 days, remaining: ${ccRepaymentPlan.remaining.filter(c=>c.owed>0.01).map(c=>`${c.name} ${fmt(c.owed)}`).join(', ')}.</p>`
                : `<p style="margin:12px 0 0;font-size:13px;color:#16a34a">All credit card debt could be cleared within this 31-day window based on current projections.</p>`
            }
        `;

        // Balance Calculator — populate with forecast inflows/outflows
        populateCalcFromForecast(cashFlowRows);
        const calcBalInput = document.getElementById('calcOpeningBal');
        if (calcBalInput && !calcBalInput.dataset.userEdited) {
            calcBalInput.value = openingBalance.toFixed(2);
        }

        // (Removed) — the "Last bank sync" footer was dropped from index.html; the
        // Fintable Sync Monitor OS page surfaces this same timestamp more clearly.

        // Store computed state for AI context
        if (typeof updateDashboardState === 'function') {
            updateDashboardState({
                openingBalance, santBal, zempBal,
                monthlyIncome, inPaymentIncome, monthlyCosts,
                operatingCushionHigh, operatingCushionLow, operatingCushionMarginHigh, operatingCushionMarginLow,
                activeTenanciesCount: activeTenancies.length,
                inPaymentCount: inPaymentTenancies.length,
                cfvCount: cfvTenancies.length,
                cfvActionedCount: cfvActionedTenancies.length,
                cfvExposure, rentalInc30, maintSpend, wagesSpend,
                occupancyRate,
                unreconciledCount: unreconciledTx.length,
            });
        }
    }
