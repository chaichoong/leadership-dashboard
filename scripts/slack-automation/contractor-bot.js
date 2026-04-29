// contractor-bot — Cloudflare Worker.
// =====================================================================
//
// Receives Slack message events from #property-management (sent by Gary,
// Roy, or Rob), classifies intent via Claude (claude-proxy worker), acts
// on Airtable via the REST API, replies in thread via the existing
// slack-notify worker.
//
// No Airtable automations, no Make / n8n / Zapier — Airtable is a clean
// database. This file is the entire automation.
//
// SUPABASE MIGRATION
// ─────────────────
// Port the handler body to supabase/functions/contractor-bot/index.ts:
//   - Replace `airtable()` calls with Supabase client queries on the
//     equivalent tables/columns.
//   - Replace the slack-notify worker URL with the Edge Function URL.
//   - Move secrets to `supabase secrets set`.
// Everything else (Slack signature verification, Claude proxy call,
// intent routing, mrkdwn replies) is portable as-is.
//
// SECRETS (Cloudflare worker → Settings → Variables and Secrets)
// ─────────────────────────────────────────────────────────────
//   AIRTABLE_PAT          — Personal Access Token with these scopes:
//                            data.records:read, data.records:write
//                           on base appnqjDpqDniH3IRl
//   SLACK_SIGNING_SECRET  — Slack app → Basic Information → App Credentials
//
// ENDPOINTS THIS WORKER USES (already deployed)
// ─────────────────────────────────────────────
//   slack-notify.kevinbrittain.workers.dev/   — channel-reply branch
//   claude-proxy.kevinbrittain.workers.dev/   — Anthropic-style { model, system, messages, max_tokens }

// ─── CONFIGURATION ────────────────────────────────────────────────────

const PROPERTY_CHANNEL_ID = 'C09EMKREPJL';

const SLACK_NOTIFY_URL  = 'https://slack-notify.kevinbrittain.workers.dev/';
const CLAUDE_PROXY_URL  = 'https://claude-proxy.kevinbrittain.workers.dev/';
const MODEL_FAST        = 'claude-haiku-4-5-20251001';

const AIRTABLE_BASE      = 'appnqjDpqDniH3IRl';
const TABLE_TASKS        = 'tblqB8b22hKBL4PF1';
const TABLE_PROPERTIES   = 'tbl6f0OkAmTC2jbuG';

const FIELD = {
    taskName:        'fldgFjGBw6bTKJFCD', // single line text
    description:     'fldRGhBQViKZKtkQ6', // richText
    status:          'fldx4qCw17UfrKpaN', // singleSelect
    priority:        'fldS21RwmwOqt71LI', // singleSelect — Urgent / Project / Not Urgent
    assignee:        'fldELMncVJYPDRJNc', // singleCollaborator
    properties:      'fldZKFvEpJ6NZeFKz', // multipleRecordLinks → Properties
    maintenanceTick: 'fldSEUvVA98as1HW6', // checkbox
    notes:           'fldR7apBzSp3oxFxz', // long text
    propertyName:    'fldy2t735TV5e1DIL', // single line text (Properties table)
};

// Slack user ID → contractor identity. Airtable email matches the email
// each contractor used to accept their base collaborator invite —
// Airtable's API resolves emails to user records on write, so no
// `usr...` IDs needed. Source of truth: TEAM array in
// os/tasks/index.html (lines 709–720).
const CONTRACTORS = {
    U0A9XD12YPN: { name: 'Gary Marsh',  firstName: 'Gary', airtableEmail: 'gkm.property.maintenance@outlook.com' },
    U0AAN4CTVQQ: { name: 'Roy Lavin',   firstName: 'Roy',  airtableEmail: 'roy.lavin1978@gmail.com' },
    U0A9MDFKA59: { name: 'Rob Jackson', firstName: 'Rob',  airtableEmail: 'rjm320@hotmail.com' },
};

// ─── ENTRY ────────────────────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        if (request.method !== 'POST') {
            return new Response('Method not allowed', { status: 405 });
        }

        // Read raw body once — needed verbatim for signature verification.
        const raw = await request.text();
        if (!await verifySlackSignature(request, raw, env.SLACK_SIGNING_SECRET)) {
            return new Response('Invalid signature', { status: 401 });
        }

        let payload;
        try { payload = JSON.parse(raw); }
        catch { return new Response('Invalid JSON', { status: 400 }); }

        // Slack URL verification handshake (only fires once, when wiring up).
        if (payload.type === 'url_verification') {
            return new Response(payload.challenge, {
                status: 200,
                headers: { 'Content-Type': 'text/plain' },
            });
        }

        // Slack expects an ack within 3 seconds. Process events asynchronously
        // via ctx.waitUntil so the worker returns immediately.
        if (payload.type === 'event_callback') {
            const evt = payload.event;
            if (shouldHandle(evt)) {
                ctx.waitUntil(routeMessage(evt, env).catch(err => {
                    console.error('contractor-bot:', err && err.stack || err);
                }));
            }
        }

        return new Response('ok', { status: 200 });
    },
};

// ─── EVENT FILTERING ──────────────────────────────────────────────────

function shouldHandle(evt) {
    if (!evt || evt.type !== 'message') return false;
    if (evt.channel !== PROPERTY_CHANNEL_ID) return false;
    // Ignore message subtypes (edits, joins, channel_join, bot messages, etc).
    if (evt.subtype) return false;
    if (evt.bot_id) return false;
    // Only handle messages from contractors — Kevin/Mica/Erica are ignored.
    if (!CONTRACTORS[evt.user]) return false;
    return true;
}

// ─── ROUTING ──────────────────────────────────────────────────────────

async function routeMessage(evt, env) {
    const contractor = CONTRACTORS[evt.user];
    const text = (evt.text || '').trim();
    if (!text) return;

    // Reply target: thread on the original message. If the original message
    // is itself a thread reply, we still want our reply in that thread.
    const threadTs = evt.thread_ts || evt.ts;

    const intent = await classifyIntent(text, env);
    switch (intent) {
        case 'new_job':       return handleNewJob(contractor, text, threadTs, env);
        case 'status_update': return handleStatusUpdate(contractor, text, threadTs, env);
        case 'list_request':  return handleListRequest(contractor, threadTs, env);
        default:
            return reply(threadTs, env,
                `Hi ${contractor.firstName}, I'm not sure what you need. Try:\n` +
                `• *New job* — describe what needs doing and at which property\n` +
                `• *Update* — tell me if you've started or finished a job\n` +
                `• *My list* — ask "what's on my list" to see your open jobs`
            );
    }
}

// ─── INTENT CLASSIFICATION ────────────────────────────────────────────

async function classifyIntent(text, env) {
    const system =
        `You classify short Slack messages from maintenance contractors into exactly one of:\n` +
        `  new_job        — reporting a new job that needs doing\n` +
        `  status_update  — reporting progress on an existing job (started, done, blocked, adding a note)\n` +
        `  list_request   — asking to see their open jobs / current workload\n` +
        `  unknown        — anything else, or too ambiguous\n\n` +
        `Respond with ONLY the single label, no other text.`;

    const label = await callClaude(env, {
        system,
        messages: [{ role: 'user', content: text }],
        maxTokens: 10,
    });
    const clean = (label || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    if (['new_job', 'status_update', 'list_request', 'unknown'].includes(clean)) return clean;
    return 'unknown';
}

// ─── HANDLER 1: NEW JOB ───────────────────────────────────────────────

async function handleNewJob(contractor, text, threadTs, env) {
    const extraction = await extractNewJobFields(text, env);

    const matches = await matchProperty(extraction.propertyHint, env);
    if (matches.length === 0) {
        return reply(threadTs, env,
            `Hi ${contractor.firstName}, I couldn't work out which property that's at. ` +
            `Can you reply with the property name or address?`
        );
    }
    if (matches.length > 1) {
        const list = matches.slice(0, 5).map((p, i) => `${i + 1}. ${p.name}`).join('\n');
        return reply(threadTs, env,
            `A few properties match. Which one?\n${list}\nReply with the number or the full address.`
        );
    }
    const property = matches[0];
    const priority = extraction.priority === 'High Priority' ? 'Urgent' : 'Not Urgent';

    await createTask(env, {
        [FIELD.taskName]:        extraction.taskName,
        [FIELD.description]:     text,
        [FIELD.status]:          'Upcoming',
        [FIELD.priority]:        priority,
        [FIELD.assignee]:        { email: contractor.airtableEmail },
        [FIELD.properties]:      [property.id],
        [FIELD.maintenanceTick]: true,
    });

    return reply(threadTs, env,
        `✅ Logged, ${contractor.firstName}.\n` +
        `*${extraction.taskName}*\n` +
        `📍 ${property.name}\n` +
        `⚡ Priority: ${priority}\n` +
        `Added to your list.`
    );
}

async function extractNewJobFields(text, env) {
    const system =
        `Extract structured fields from a maintenance contractor's Slack message about a new job.\n\n` +
        `Respond with ONLY valid JSON (no markdown, no code fences) matching:\n` +
        `{\n` +
        `  "taskName": "short 3-7 word title, e.g. 'Fix boiler - no hot water'",\n` +
        `  "propertyHint": "the property name/address mentioned, or empty string",\n` +
        `  "priority": "High Priority" or "Low Priority"\n` +
        `}\n\n` +
        `High Priority = health/safety risk, no heating/hot water, water leaks, structural,\n` +
        `security, electrical faults, gas, fire safety, flooding, sewage.\n` +
        `Low Priority = cosmetic, non-urgent, wear and tear, painting, external/garden.`;

    const raw = await callClaude(env, {
        system,
        messages: [{ role: 'user', content: text }],
        maxTokens: 200,
    });
    try {
        return JSON.parse(raw.trim().replace(/^```json\s*|\s*```$/g, ''));
    } catch (e) {
        return { taskName: text.slice(0, 60), propertyHint: '', priority: 'Low Priority' };
    }
}

async function matchProperty(hint, env) {
    if (!hint) return [];
    const all = await listAllProperties(env);
    const needle = hint.toLowerCase();
    return all.filter(p => p.name && p.name.toLowerCase().includes(needle));
}

// ─── HANDLER 2: STATUS UPDATE ─────────────────────────────────────────

async function handleStatusUpdate(contractor, text, threadTs, env) {
    const openTasks = await fetchOpenTasksFor(contractor, env);
    if (openTasks.length === 0) {
        return reply(threadTs, env,
            `${contractor.firstName}, you don't have any open jobs right now.`
        );
    }

    const match = await matchStatusUpdate(text, openTasks, env);
    if (match.matchedTaskIndex === -1) {
        const list = openTasks.map((t, i) =>
            `${i + 1}. ${t.taskName}${t.propertyName ? ' — ' + t.propertyName : ''}`
        ).join('\n');
        return reply(threadTs, env,
            `I can't tell which job you mean, ${contractor.firstName}. Your open jobs:\n${list}\n` +
            `Reply with the number or job name.`
        );
    }

    const target = openTasks[match.matchedTaskIndex];

    if (match.action === 'completed') {
        await updateTask(env, target.id, { [FIELD.status]: 'Completed' });
        return reply(threadTs, env, `✅ Marked complete: *${target.taskName}*. Nice one ${contractor.firstName}.`);
    }
    if (match.action === 'in_progress') {
        await updateTask(env, target.id, { [FIELD.status]: 'Today' });
        return reply(threadTs, env, `👍 Got it — *${target.taskName}* is now in progress.`);
    }
    if (match.action === 'note') {
        const newNote = noteWithPrefix(contractor, match.noteText);
        const combined = target.notes ? target.notes + '\n\n' + newNote : newNote;
        await updateTask(env, target.id, { [FIELD.notes]: combined });
        return reply(threadTs, env, `📝 Note added to *${target.taskName}*.`);
    }
    return reply(threadTs, env, `I caught your message but wasn't sure what to do with it.`);
}

async function matchStatusUpdate(text, openTasks, env) {
    const taskList = openTasks.map((t, i) =>
        `${i}: ${t.taskName}${t.propertyName ? ' — ' + t.propertyName : ''}`
    ).join('\n');

    const system =
        `A contractor has sent a Slack message about their work. Match it to one of the open jobs\n` +
        `below and classify the action.\n\n` +
        `OPEN JOBS:\n${taskList}\n\n` +
        `Respond with ONLY valid JSON (no markdown):\n` +
        `{\n` +
        `  "matchedTaskIndex": number,   // 0-based index, or -1 if no confident match\n` +
        `  "action": "completed" | "in_progress" | "note",\n` +
        `  "noteText": string             // empty unless action is "note"\n` +
        `}`;

    const raw = await callClaude(env, {
        system,
        messages: [{ role: 'user', content: text }],
        maxTokens: 250,
    });
    try {
        const p = JSON.parse(raw.trim().replace(/^```json\s*|\s*```$/g, ''));
        return {
            matchedTaskIndex: Number.isInteger(p.matchedTaskIndex) ? p.matchedTaskIndex : -1,
            action: p.action || 'note',
            noteText: p.noteText || text,
        };
    } catch (e) {
        return { matchedTaskIndex: -1, action: 'note', noteText: text };
    }
}

// ─── HANDLER 3: LIST REQUEST ──────────────────────────────────────────

async function handleListRequest(contractor, threadTs, env) {
    const tasks = await fetchOpenTasksFor(contractor, env);
    if (tasks.length === 0) {
        return reply(threadTs, env, `✨ Nothing on your list, ${contractor.firstName}. All clear.`);
    }
    const lines = tasks.map((t, i) => {
        const pri = t.priority === 'Urgent' ? ' 🔴' : '';
        const prop = t.propertyName ? ` — ${t.propertyName}` : '';
        return `${i + 1}. *${t.taskName}*${prop}${pri}`;
    });
    return reply(threadTs, env,
        `${contractor.firstName}, here's your list (${tasks.length}):\n${lines.join('\n')}`
    );
}

// ─── AIRTABLE REST API ────────────────────────────────────────────────

async function airtable(env, method, path, body) {
    const resp = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${env.AIRTABLE_PAT}`,
            'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
        throw new Error(`Airtable ${method} ${path} → ${resp.status}: ${await resp.text()}`);
    }
    return resp.json();
}

async function createTask(env, fields) {
    return airtable(env, 'POST', `/${TABLE_TASKS}`, {
        records: [{ fields }],
        typecast: true,
    });
}

async function updateTask(env, recordId, fields) {
    return airtable(env, 'PATCH', `/${TABLE_TASKS}/${recordId}`, { fields, typecast: true });
}

async function fetchOpenTasksFor(contractor, env) {
    const fields = [
        FIELD.taskName, FIELD.status, FIELD.priority,
        FIELD.properties, FIELD.notes, FIELD.maintenanceTick,
    ];
    const formula = `AND({Status}!='Completed',{Assignee}='${escapeFormula(contractor.name)}')`;
    const url = `/${TABLE_TASKS}` +
        `?returnFieldsByFieldId=true` +
        `&filterByFormula=${encodeURIComponent(formula)}` +
        fields.map(f => `&fields%5B%5D=${f}`).join('');

    const [data, properties] = await Promise.all([
        airtable(env, 'GET', url),
        listAllProperties(env),
    ]);
    const propMap = Object.fromEntries(properties.map(p => [p.id, p.name]));
    return data.records.map(r => parseTaskRecord(r, propMap));
}

function parseTaskRecord(r, propMap) {
    const f = r.fields || {};
    const status = f[FIELD.status];
    const priority = f[FIELD.priority];
    const props = f[FIELD.properties] || [];
    return {
        id: r.id,
        taskName: f[FIELD.taskName] || '',
        status: (status && (status.name || status)) || '',
        priority: (priority && (priority.name || priority)) || '',
        propertyId: props[0] || '',
        propertyName: propMap[props[0]] || '',
        notes: f[FIELD.notes] || '',
    };
}

async function listAllProperties(env) {
    const out = [];
    let offset = null;
    do {
        let url = `/${TABLE_PROPERTIES}?returnFieldsByFieldId=true` +
            `&fields%5B%5D=${FIELD.propertyName}&pageSize=100`;
        if (offset) url += `&offset=${encodeURIComponent(offset)}`;
        const data = await airtable(env, 'GET', url);
        for (const r of data.records) {
            out.push({ id: r.id, name: r.fields[FIELD.propertyName] || '' });
        }
        offset = data.offset || null;
    } while (offset);
    return out;
}

// ─── HELPERS ──────────────────────────────────────────────────────────

function noteWithPrefix(contractor, noteText) {
    const now = new Date();
    const d = now.toLocaleDateString('en-GB');
    const t = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `[${contractor.firstName} — ${d} ${t}] ${noteText}`;
}

function escapeFormula(s) {
    return String(s || '').replace(/'/g, "\\'");
}

// ─── EXTERNAL: Claude proxy ───────────────────────────────────────────

async function callClaude(env, { system, messages, maxTokens }) {
    const resp = await fetch(CLAUDE_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: MODEL_FAST,
            max_tokens: maxTokens,
            system,
            messages,
        }),
    });
    if (!resp.ok) {
        throw new Error(`Claude proxy ${resp.status}: ${await resp.text()}`);
    }
    const data = await resp.json();
    return (data.content && data.content[0] && data.content[0].text) || '';
}

// ─── EXTERNAL: Slack reply via slack-notify worker ────────────────────

async function reply(threadTs, env, text) {
    const resp = await fetch(SLACK_NOTIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            channel: PROPERTY_CHANNEL_ID,
            text,
            thread_ts: threadTs,
        }),
    });
    const data = await resp.json();
    if (!data.ok) {
        throw new Error(`Slack reply failed: ${data.error || resp.status}`);
    }
}

// ─── Slack signature verification ─────────────────────────────────────
// Slack signs every request with HMAC-SHA256 over `v0:<ts>:<rawBody>`
// using the app's signing secret. We reject anything that doesn't match
// or is older than 5 minutes (replay-attack protection).
// Docs: https://api.slack.com/authentication/verifying-requests-from-slack

async function verifySlackSignature(request, rawBody, signingSecret) {
    if (!signingSecret) return false;
    const ts = request.headers.get('X-Slack-Request-Timestamp');
    const sig = request.headers.get('X-Slack-Signature');
    if (!ts || !sig) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(ts, 10)) > 300) return false;

    const baseString = `v0:${ts}:${rawBody}`;
    const expected = `v0=${await hmacSha256Hex(signingSecret, baseString)}`;
    return constantTimeEqual(sig, expected);
}

async function hmacSha256Hex(secret, message) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return Array.from(new Uint8Array(sig))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
}
