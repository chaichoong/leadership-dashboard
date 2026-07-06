// Agent Runner — turns a Systemisation SOP into a working AI agent.
//
// Run loop per agent (mirrors docs/agent-runtime-spec.md):
//   trigger (cron / manual) → gather (scoped Airtable reads) → decide (Claude
//   tool-use loop) → gate (testing = propose-only; live = safe writes auto,
//   everything else proposed) → act → log (Agent Activity, with undo payload).
//
// Safety model:
//   - TESTING agents NEVER write business data. Every intended action becomes a
//     "Proposed" activity row for human tick/cross in the app.
//   - LIVE agents auto-execute ONLY field updates allowlisted in the agent's
//     config (sop.agent.autoFields). Anything else is proposed.
//   - No delete tool exists at all. Money/tenancy-status style fields are only
//     ever auto-written if explicitly allowlisted.
//   - Every write logs the BEFORE values so the app can undo it.

const BASE_ID = 'appnqjDpqDniH3IRl';
const WORKFLOWS_TBL = 'tblLPoRHFBl0vqR24';
const ACTIVITY_TBL = 'tblJ3GFnAAoXf99e9';
const CLAUDE_PROXY = 'https://claude-proxy.kevinbrittain.workers.dev';
const MODEL = 'claude-sonnet-4-6';
const MAX_TOOL_TURNS = 16;
const ALLOWED_ORIGINS = ['https://chaichoong.github.io'];

// Workflow-table field IDs (match os/systemisation/index.html WF constants)
const WF_NAME = 'fldsaS0jeoSRuJN28';
const WF_SOP = 'fldW4qoDv2mrTNvu7';

// Tables the AI may be granted access to, by friendly name.
// The per-agent allowlist (sop.agent.tables) lists friendly names from this map.
const TABLE_MAP = {
    tenancies: 'tblN51a88qTDB6iMH',
    tenants: 'tblX4elTuu01gwBYh',
    tasks: 'tblqB8b22hKBL4PF1',
    workflows: 'tblLPoRHFBl0vqR24',
};

// ── Airtable helpers (field NAMES as keys — legible for the model) ──
async function atList(env, tableId, params) {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
    Object.entries(params || {}).forEach(([k, v]) => {
        if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
        else if (v != null) url.searchParams.set(k, v);
    });
    const res = await fetch(url, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } });
    if (!res.ok) throw new Error(`Airtable list ${tableId}: ${res.status}`);
    return res.json();
}
async function atGet(env, tableId, recId) {
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}/${recId}`, {
        headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` },
    });
    if (!res.ok) throw new Error(`Airtable get: ${res.status}`);
    return res.json();
}
async function atPatch(env, tableId, recId, fields) {
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}/${recId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, typecast: true }),
    });
    if (!res.ok) throw new Error(`Airtable patch: ${res.status} ${await res.text()}`);
    return res.json();
}
async function atCreate(env, tableId, fields) {
    const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, typecast: true }),
    });
    if (!res.ok) throw new Error(`Airtable create: ${res.status} ${await res.text()}`);
    return res.json();
}

// ── Activity log ──
async function logActivity(env, wfId, runId, state, summary, detail, payload) {
    try {
        await atCreate(env, ACTIVITY_TBL, {
            'Summary': String(summary).slice(0, 250),
            'Agent': [wfId],
            'State': state,
            'Detail': String(detail || '').slice(0, 8000),
            'Payload': payload ? JSON.stringify(payload).slice(0, 90000) : '',
            'Run': runId,
        });
    } catch (e) {
        console.error('activity log failed:', e.message);
    }
}

// ── AI call through the proxy (tools pass through to Anthropic) ──
async function callClaude(env, system, messages, tools) {
    // env.PROXY is a service binding to claude-proxy (same-zone public URLs 1042)
    const res = await env.PROXY.fetch(CLAUDE_PROXY, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.PROXY_TOKEN}`,
            'User-Agent': 'agent-runner/1.0',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 3000, system, messages, tools }),
    });
    if (!res.ok) throw new Error(`proxy ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
}

// ── Tool definitions shown to the model ──
function toolDefs(allowedTables) {
    const tableList = allowedTables.join(', ');
    return [
        {
            name: 'search_records',
            description: `Read records from Airtable. Allowed tables: ${tableList}. Field names are the keys. Use filterFormula (Airtable formula syntax) to narrow results.`,
            input_schema: {
                type: 'object',
                properties: {
                    table: { type: 'string', description: `One of: ${tableList}` },
                    filterFormula: { type: 'string', description: 'Optional Airtable filterByFormula' },
                    max: { type: 'number', description: 'Max records (default 25, cap 100)' },
                },
                required: ['table'],
            },
        },
        {
            name: 'update_record',
            description: `Update fields on a record. Allowed tables: ${tableList}. In testing mode this only PROPOSES the change for human approval. Always explain why.`,
            input_schema: {
                type: 'object',
                properties: {
                    table: { type: 'string' },
                    recordId: { type: 'string' },
                    recordLabel: { type: 'string', description: 'Human name of the record — tenant / property / unit (e.g. "Unit 7 – Duckworth Building (Intus Lettings)"). The owner reads this first.' },
                    fields: { type: 'object', description: 'Field name → new value' },
                    why: { type: 'string', description: 'One-line reason a human will read' },
                },
                required: ['table', 'recordId', 'recordLabel', 'fields', 'why'],
            },
        },
        {
            name: 'read_comments',
            description: 'Read the comment history on a record, newest first. ALWAYS read a case\'s comments before deciding what to do with it — the latest comments carry the current position, agreed plans, and what has already been done.',
            input_schema: {
                type: 'object',
                properties: {
                    table: { type: 'string', description: `One of: ${tableList}` },
                    recordId: { type: 'string' },
                    max: { type: 'number', description: 'Max comments (default 10, cap 25)' },
                },
                required: ['table', 'recordId'],
            },
        },
        {
            name: 'add_comment',
            description: 'Add an audit comment to a record (goes to the record comment feed).',
            input_schema: {
                type: 'object',
                properties: {
                    table: { type: 'string' },
                    recordId: { type: 'string' },
                    recordLabel: { type: 'string', description: 'Human name of the record — tenant / property / unit. The owner reads this first.' },
                    text: { type: 'string' },
                },
                required: ['table', 'recordId', 'recordLabel', 'text'],
            },
        },
        {
            name: 'propose_action',
            description: 'Propose any action outside your tools (e.g. "send a chase message to X", "escalate Y to Kevin"). A human approves or rejects it in the app.',
            input_schema: {
                type: 'object',
                properties: {
                    summary: { type: 'string', description: 'Short action title' },
                    detail: { type: 'string', description: 'Everything a human needs to act, including any drafted message text' },
                },
                required: ['summary', 'detail'],
            },
        },
    ];
}

// ── Tool execution with the safety gate ──
async function execTool(env, ctx, name, input) {
    const { wfId, runId, state, allowedTables, autoFields, autoComments, stats, seenPayloads } = ctx;

    const resolveTable = (t) => {
        const key = String(t || '').toLowerCase().trim();
        if (!allowedTables.includes(key)) return null;
        return TABLE_MAP[key] || null;
    };

    if (name === 'search_records') {
        const tableId = resolveTable(input.table);
        if (!tableId) return { error: `table not allowed: ${input.table}. Allowed: ${allowedTables.join(', ')}` };
        const max = Math.min(Number(input.max) || 25, 100);
        const params = { pageSize: String(max) };
        if (input.filterFormula) params.filterByFormula = input.filterFormula;
        const data = await atList(env, tableId, params);
        const records = (data.records || []).slice(0, max).map(r => ({ id: r.id, fields: r.fields }));
        return { count: records.length, records };
    }

    if (name === 'read_comments') {
        const tableId = resolveTable(input.table);
        if (!tableId) return { error: `table not allowed: ${input.table}` };
        const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}/${input.recordId}/comments`, {
            headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` },
        });
        if (!res.ok) return { error: `comments fetch failed: ${res.status}` };
        const data = await res.json();
        const max = Math.min(Number(input.max) || 10, 25);
        const comments = (data.comments || []).slice(-max).reverse().map(c => ({
            at: c.createdTime,
            by: (c.author && (c.author.name || c.author.email)) || 'unknown',
            text: String(c.text || '').slice(0, 600),
        }));
        return { count: comments.length, comments };
    }

    if (name === 'update_record') {
        const tableId = resolveTable(input.table);
        if (!tableId) return { error: `table not allowed: ${input.table}` };
        const dedupKey = `upd:${tableId}:${input.recordId}:${JSON.stringify(input.fields)}`;
        if (seenPayloads.has(dedupKey)) return { ok: true, note: 'already proposed/done previously — skipped duplicate' };
        seenPayloads.add(dedupKey);

        // capture BEFORE values for undo
        let before = {};
        try {
            const cur = await atGet(env, tableId, input.recordId);
            Object.keys(input.fields || {}).forEach(k => { before[k] = cur.fields[k] ?? null; });
        } catch (e) { before = { _fetchFailed: e.message }; }

        const payload = { kind: 'update', table: input.table, tableId, recordId: input.recordId, fields: input.fields, before };

        const label = String(input.recordLabel || input.recordId).slice(0, 120);
        const fieldsAllAllowlisted = Object.keys(input.fields || {}).every(f => (autoFields || []).includes(f));
        if (state === 'live' && fieldsAllAllowlisted) {
            await atPatch(env, tableId, input.recordId, input.fields);
            stats.auto++;
            await logActivity(env, wfId, runId, 'Auto-done', `${label} — updated ${Object.keys(input.fields || {}).join(', ')}`, input.why, payload);
            return { ok: true, executed: true };
        }
        stats.proposed++;
        await logActivity(env, wfId, runId, 'Proposed', `${label} — update ${Object.keys(input.fields || {}).join(', ')}`, input.why, payload);
        return { ok: true, executed: false, note: state === 'testing' ? 'testing mode: proposed for human approval' : 'field(s) not auto-allowlisted: proposed for human approval' };
    }

    if (name === 'add_comment') {
        const tableId = resolveTable(input.table);
        if (!tableId) return { error: `table not allowed: ${input.table}` };
        const payload = { kind: 'comment', table: input.table, tableId, recordId: input.recordId, text: input.text };
        // Comments only auto-post when the owner has explicitly allowed it —
        // a freshly-live agent with no permissions still queues EVERYTHING.
        if (state === 'live' && autoComments === true) {
            const res = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${tableId}/${input.recordId}/comments`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: String(input.text).slice(0, 4000) }),
            });
            if (!res.ok) return { error: `comment failed: ${res.status}` };
            stats.auto++;
            await logActivity(env, wfId, runId, 'Auto-done', `${String(input.recordLabel || input.recordId).slice(0, 120)} — audit comment added`, input.text, payload);
            return { ok: true, executed: true };
        }
        stats.proposed++;
        await logActivity(env, wfId, runId, 'Proposed', `${String(input.recordLabel || input.recordId).slice(0, 120)} — add audit comment`, input.text, payload);
        return { ok: true, executed: false, note: 'testing mode: proposed' };
    }

    if (name === 'propose_action') {
        const dedupKey = `prop:${String(input.summary).slice(0, 120)}`;
        if (seenPayloads.has(dedupKey)) return { ok: true, note: 'already proposed previously — skipped duplicate' };
        seenPayloads.add(dedupKey);
        stats.proposed++;
        await logActivity(env, wfId, runId, 'Proposed', input.summary, input.detail, { kind: 'manual', summary: input.summary });
        return { ok: true, queued: true };
    }

    return { error: `unknown tool: ${name}` };
}

// ── One agent, one run ──
async function runAgent(env, wf) {
    const wfId = wf.id;
    const name = wf.fields[WF_NAME] || 'Untitled agent';
    let sop = {};
    try { sop = JSON.parse(wf.fields[WF_SOP] || '{}'); } catch (e) { return; }
    const agent = sop.agent || {};
    const state = agent.state; // 'testing' | 'live'
    if (state !== 'testing' && state !== 'live') return;

    const allowedTables = (agent.tables || []).map(t => String(t).toLowerCase()).filter(t => TABLE_MAP[t]);
    const autoFields = agent.autoFields || [];
    const runId = `run-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}-${wfId.slice(-5)}`;
    const stats = { proposed: 0, auto: 0 };
    const seenPayloads = new Set();

    // Recent activity → dedup + learning (rejections must not be re-proposed)
    let recentBlock = '';
    try {
        // NOTE: link-field formulas match display names, not record ids — fetch and
        // filter in code on the Agent link array so dedup/learning actually work.
        const act = await atList(env, ACTIVITY_TBL, {
            pageSize: '100',
            'sort[0][field]': 'Run', 'sort[0][direction]': 'desc',
        });
        act.records = (act.records || []).filter(r => Array.isArray(r.fields['Agent']) && r.fields['Agent'].includes(wfId)).slice(0, 40);
        const rows = (act.records || []).map(r => {
            const f = r.fields;
            const p = f['Payload'] || '';
            if (f['State'] === 'Proposed' || f['State'] === 'Auto-done') {
                try {
                    const pl = JSON.parse(p);
                    if (pl.kind === 'update') seenPayloads.add(`upd:${pl.tableId}:${pl.recordId}:${JSON.stringify(pl.fields)}`);
                    if (pl.kind === 'manual') seenPayloads.add(`prop:${String(pl.summary).slice(0, 120)}`);
                } catch (e) {}
            }
            const fb = f['Feedback'] ? ` — owner's feedback: "${String(f['Feedback']).slice(0, 300)}"` : '';
            return `- [${f['State']}] ${f['Summary']}${f['State'] === 'Rejected' ? ` (REJECTED${fb} — do not propose this again, and apply the feedback to everything you do)` : fb}`;
        });
        if (rows.length) recentBlock = `\n\nYour recent activity (do not repeat existing proposals; never re-propose rejected items):\n${rows.slice(0, 30).join('\n')}`;
    } catch (e) {}

    const sopText = (sop.sopSteps || []).map((s, i) => {
        const detail = Array.isArray(s.detail) ? s.detail.map(b => `  - ${b}`).join('\n') : (s.detail || '');
        return `Step ${i + 1}: ${s.name}\n${detail}`;
    }).join('\n\n');
    const cautions = (sop.cautions || []).map(c => `- ${c}`).join('\n');
    // The owner's answers to the AGENTIC readiness questions are part of the
    // process definition — the decision rules often live here, not in the steps.
    const answers = (sop.readiness && sop.readiness.answers) || {};
    const answersBlock = Object.keys(answers).length
        ? `\n\nOWNER'S ANSWERS TO PROCESS QUESTIONS (authoritative decision rules):\n${Object.entries(answers).map(([k, v]) => `- ${v}`).join('\n')}`
        : '';
    const operator = agent.operator || 'Kevin';
    const fieldGuide = agent.fieldGuide
        ? `\n\nFIELD GUIDE for this base (follow exactly):\n${agent.fieldGuide}`
        : '';
    // Permanent lessons distilled from the owner's feedback — the agent's memory.
    const lessons = (agent.lessons || []).length
        ? `\n\nLESSONS FROM THE OWNER (permanent rules — apply to every decision):\n${agent.lessons.map(l => `- ${typeof l === 'string' ? l : l.text}`).join('\n')}`
        : '';

    const system = `You are an autonomous operations agent named "${name}" working inside a UK property business's Airtable base. You were built from the owner's own SOP. Today's date: ${new Date().toISOString().slice(0, 10)}.

YOUR SOP (follow it exactly):
${sopText}${answersBlock}

CAUTIONS (never violate these):
${cautions || '- none recorded'}

DATA TRUST RULES (critical — the tables contain historical noise):
- Records carry legacy fields. NEVER base a decision on fields whose names contain "(Deprecated)", "Legacy", "Debug", "Static", or bare flag fields like "CFV" / "CFV Status" — they are stale.
- Prefer fields marked "(Unified)" or "Derived" — e.g. "Payment Status (Unified)" is the authoritative payment status.
- If authoritative fields conflict with each other, do NOT pick the alarming one: flag the conflict with propose_action instead.${fieldGuide}

IDENTITY: you act on behalf of ${operator}. Every outward message (chasers, emails, texts) signs off as ${operator} — never as a company, account, or management name.${lessons}

OPERATING RULES:
- You are in ${state.toUpperCase()} mode. ${state === 'testing' ? 'Nothing you do executes — every action is proposed to the owner for approval. Be thorough but precise.' : 'Only allowlisted safe updates execute automatically; everything else queues for the owner.'}
- Work ONLY from real data you read with search_records. Never invent records or values.
- Before deciding anything about a specific case, read its comment history (read_comments). The latest comments are the current position — never propose something the comments show is already done, agreed, or ruled out, and reference the history in your reasoning.
- Every update_record needs a clear one-line "why" a human can judge instantly.
- Use propose_action for anything outside your tools (messages to people, escalations), including full drafted text.
- Be conservative: if unsure, propose rather than act, or do nothing and say so.
- Work efficiently: batch several tool calls in one turn where possible (e.g. propose the comment, status update, and chaser for a case together) — you have a limited number of turns per run.
- When you have finished the SOP pass, reply with a short plain-text summary of what you found and did. Do not call more tools after that.${recentBlock}`;

    const tools = toolDefs(allowedTables);
    const messages = [{ role: 'user', content: `Run your SOP now over the live data. Allowed tables: ${allowedTables.join(', ')}.` }];

    let finalText = '';
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const resp = await callClaude(env, system, messages, tools);
        const toolUses = (resp.content || []).filter(b => b.type === 'tool_use');
        const texts = (resp.content || []).filter(b => b.type === 'text').map(b => b.text);
        if (texts.length) finalText = texts.join('\n');
        if (!toolUses.length || resp.stop_reason === 'end_turn') break;

        messages.push({ role: 'assistant', content: resp.content });
        const results = [];
        for (const tu of toolUses) {
            let out;
            try { out = await execTool(env, { wfId, runId, state, allowedTables, autoFields, autoComments: agent.autoComments === true, stats, seenPayloads }, tu.name, tu.input || {}); }
            catch (e) { out = { error: e.message }; }
            results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 12000) });
        }
        messages.push({ role: 'user', content: results });
    }

    await logActivity(env, wfId, runId, 'Note',
        `Run complete: ${stats.proposed} proposed, ${stats.auto} auto-done`,
        finalText || '(no summary)', { kind: 'run-summary', stats });
    return { wfId, name, runId, stats };
}

// ── Load agents and run them all ──
async function runAllAgents(env, onlyWfId) {
    const data = await atList(env, WORKFLOWS_TBL, {
        returnFieldsByFieldId: 'true',
        pageSize: '100',
        'fields[]': [WF_NAME, WF_SOP],
    });
    const results = [];
    for (const wf of (data.records || [])) {
        if (onlyWfId && wf.id !== onlyWfId) continue;
        let sop = null;
        try { sop = JSON.parse(wf.fields[WF_SOP] || 'null'); } catch (e) {}
        if (!sop || !sop.disposition || sop.disposition.type !== 'agent') continue;
        if (!sop.agent || (sop.agent.state !== 'testing' && sop.agent.state !== 'live')) continue;
        try { results.push(await runAgent(env, wf)); }
        catch (e) {
            console.error(`agent ${wf.id} failed:`, e.message);
            await logActivity(env, wf.id, 'run-error', 'Note', 'Run failed', e.message, { kind: 'error' });
            results.push({ wfId: wf.id, error: e.message });
        }
    }
    return results;
}

// ── Auth for manual triggers ──
function callerAllowed(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    const auth = request.headers.get('Authorization') || '';
    return !!env.AGENT_RUNNER_TOKEN && auth === `Bearer ${env.AGENT_RUNNER_TOKEN}`;
}
function corsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    return {
        'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
}

export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(runAllAgents(env));
    },
    async fetch(request, env, ctx) {
        const headers = Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(request));
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
        const url = new URL(request.url);
        if (url.pathname === '/health') {
            return new Response(JSON.stringify({ ok: true, service: 'agent-runner' }), { status: 200, headers });
        }
        if (url.pathname === '/run' && request.method === 'POST') {
            if (!callerAllowed(request, env)) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers });
            const wfId = url.searchParams.get('wf') || null;
            const results = await runAllAgents(env, wfId);
            return new Response(JSON.stringify({ ran: results.length, results }), { status: 200, headers });
        }
        return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers });
    },
};
