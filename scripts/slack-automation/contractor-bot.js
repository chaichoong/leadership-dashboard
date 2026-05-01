// contractor-bot — Cloudflare Worker.
// =====================================================================
//
// Receives Slack message events from #property-management (sent by Gary,
// Roy, or Rob), classifies intent via Claude, acts on Airtable via the
// REST API, replies in thread via Slack chat.postMessage, and sends DMs
// for assignment + completion notifications.
//
// SELF-CONTAINED. The worker calls Anthropic and Slack APIs directly,
// not via the dashboard's claude-proxy or slack-notify workers — those
// are gated to browser calls from the GitHub Pages origin and don't
// allow worker-to-worker calls (Cloudflare returns error 1042 for
// `*.workers.dev` worker-to-worker fetches in some configurations).
// Direct API calls are simpler, faster, and remove the dependency
// entirely. The dashboard's proxies are unchanged.
//
// PHASE 2 FEATURES (added on top of basic intent routing):
//   1. Auto-collaborators — every maintenance task auto-adds Kevin,
//      Mica, and Erica as Collaborators so they get completion DMs.
//   2. Assignment DM — when a task is created, the contractor (assignee)
//      gets a DM mirroring the dashboard's existing flow.
//   3. Completion DMs — when a task is marked complete, all OTHER
//      collaborators (excluding the contractor who completed it) get
//      a DM, mirroring the dashboard's existing rule.
//   4. Attachments — if the Slack message includes files, they're
//      downloaded from Slack, stored in Cloudflare R2, and attached
//      to the Airtable task. The worker serves them publicly via
//      GET /files/<key> so Airtable can fetch them.
//   5. Multi-turn conversation — when the bot asks a clarifying
//      question (e.g. "which property?"), the contractor's next message
//      is treated as the answer. State is held in Cloudflare KV with
//      a 10-minute TTL.
//
// SUPABASE MIGRATION
// ─────────────────
// Port the handler body to supabase/functions/contractor-bot/index.ts:
//   - Airtable REST → Supabase client queries.
//   - R2 binding → Supabase Storage.
//   - KV binding → Supabase database table or Redis.
//   - Move secrets to `supabase secrets set`.
// Slack signature verification, Anthropic call, intent routing, Slack
// reply, and the multi-turn flow are portable as-is.
//
// SECRETS (Cloudflare → contractor-bot → Settings → Variables and Secrets)
// ────────────────────────────────────────────────────────────────────────
//   AIRTABLE_PAT          — PAT with data.records:read + data.records:write
//                           on base appnqjDpqDniH3IRl
//   SLACK_SIGNING_SECRET  — Slack app → Basic Information → App Credentials
//   ANTHROPIC_API_KEY     — sk-ant-… from console.anthropic.com
//   SLACK_BOT_TOKEN       — xoxb-… bot token from the Operations Director
//                           Slack app (same as in slack-notify worker)
//
// BINDINGS (Cloudflare → contractor-bot → Settings → Bindings)
// ───────────────────────────────────────────────────────────
//   ATTACHMENTS  — R2 bucket binding (e.g. bucket name "contractor-bot-attachments")
//   STATE        — KV namespace binding (e.g. namespace "contractor-bot-state")

// ─── CONFIGURATION ────────────────────────────────────────────────────

const PROPERTY_CHANNEL_ID = 'C09EMKREPJL';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL_FAST        = 'claude-haiku-4-5-20251001';

const SLACK_POST_URL    = 'https://slack.com/api/chat.postMessage';
const SLACK_LOOKUP_URL  = 'https://slack.com/api/users.lookupByEmail';

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
    business:        'fldLu1Y4GzyWcDoxr', // multipleRecordLinks → Businesses
    collaborators:   'fldcq3t6uAPgWSOP8', // multipleCollaborators
    attachments:     'fldEbs9cscRr8elcw', // multipleAttachments
    // Legacy Contractor singleSelect — kept in sync because the
    // Contractor Tasks tab still filters by this field.
    contractor:      'fldgmzcr3jHALsdYD', // singleSelect — Gary Marsh / Rob Jackson / Roy Lavin
    propertyName:    'fldy2t735TV5e1DIL', // single line text (Properties table)
};

// Defaults written on every contractor-created task.
const BUSINESS_REAL_ESTATE_ID = 'recoGcXRXCniyJsTz';

// Auto-added as Collaborators on every task the bot creates. Same set
// receives completion DMs (excluding whoever did the completion).
const TEAM_COLLABORATOR_EMAILS = [
    'kevin@runpreneur.org.uk',
    'micaa.work@gmail.com',
    'atentaerica@gmail.com',
];

// Slack user ID → contractor identity. Airtable email matches the email
// each contractor used to accept their base collaborator invite —
// Airtable's API resolves emails to user records on write.
//
// `contractorFieldValue` (optional) is written to the legacy Contractor
// singleSelect field. Only set for the three real contractors so test
// entries don't pollute the singleSelect's options.
const CONTRACTORS = {
    U0A9XD12YPN: { name: 'Gary Marsh',  firstName: 'Gary', airtableEmail: 'gkm.property.maintenance@outlook.com', contractorFieldValue: 'Gary Marsh' },
    U0AAN4CTVQQ: { name: 'Roy Lavin',   firstName: 'Roy',  airtableEmail: 'roy.lavin1978@gmail.com',              contractorFieldValue: 'Roy Lavin' },
    U0A9MDFKA59: { name: 'Rob Jackson', firstName: 'Rob',  airtableEmail: 'rjm320@hotmail.com',                   contractorFieldValue: 'Rob Jackson' },
};

// Multi-turn pending state kept in KV for this many seconds. After expiry
// the contractor's next message is treated as a fresh request.
const PENDING_TTL_SECONDS = 600;

// ─── ENTRY ────────────────────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // GET /files/<key> → serve attachment from R2 (public; Airtable
        // downloads from this URL when ingesting the attachment).
        if (request.method === 'GET' && url.pathname.startsWith('/files/')) {
            const key = decodeURIComponent(url.pathname.slice('/files/'.length));
            return serveR2File(key, env);
        }

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

// ─── R2 FILE SERVING ──────────────────────────────────────────────────

async function serveR2File(key, env) {
    if (!env.ATTACHMENTS) {
        return new Response('Attachments storage not configured', { status: 500 });
    }
    const obj = await env.ATTACHMENTS.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    return new Response(obj.body, {
        headers: {
            'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000, immutable',
        },
    });
}

// ─── EVENT FILTERING ──────────────────────────────────────────────────

function shouldHandle(evt) {
    if (!evt || evt.type !== 'message') return false;
    if (evt.channel !== PROPERTY_CHANNEL_ID) return false;
    // Ignore message subtypes (edits, joins, channel_join, bot messages, etc),
    // EXCEPT 'file_share' — that's how Slack signals a message with files.
    if (evt.subtype && evt.subtype !== 'file_share') return false;
    if (evt.bot_id) return false;
    if (!CONTRACTORS[evt.user]) return false;
    return true;
}

// ─── ROUTING ──────────────────────────────────────────────────────────

async function routeMessage(evt, env) {
    const contractor = CONTRACTORS[evt.user];
    const text = (evt.text || '').trim();
    const threadTs = evt.thread_ts || evt.ts;
    const hasFiles = evt.files && evt.files.length > 0;
    if (!text && !hasFiles) return;

    // If the bot recently asked this contractor a clarifying question,
    // treat the new message as the answer instead of classifying it fresh.
    if (env.STATE) {
        const pending = await getPendingState(env, evt.user);
        if (pending) {
            return resolvePending(contractor, text, pending, evt, threadTs, env);
        }
    }

    // Fresh message — classify intent and route.
    const intent = await classifyIntent(text || '(file uploaded)', env);
    switch (intent) {
        case 'new_job':       return handleNewJob(contractor, text, evt, threadTs, env);
        case 'status_update': return handleStatusUpdate(contractor, text, evt, threadTs, env);
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

// `override` lets resolvePending re-enter this handler with a property
// already chosen (so we don't ask the contractor twice).
async function handleNewJob(contractor, text, evt, threadTs, env, override) {
    override = override || {};
    const extraction = override.extraction || await extractNewJobFields(text, env);

    let property = override.resolvedProperty || null;

    if (!property) {
        const matches = await matchProperty(extraction.propertyHint, env);
        if (matches.length === 0) {
            // Ask the contractor for a property; remember the original message
            // so we can resume on their next reply.
            await setPendingState(env, evt.user, {
                kind: 'awaiting_property',
                originalMessage: text,
                extraction,
                eventTs: evt.ts,
            });
            return reply(threadTs, env,
                `Hi ${contractor.firstName}, which property is that at? Reply with the name or address.`
            );
        }
        if (matches.length > 1) {
            const candidates = matches.slice(0, 5);
            await setPendingState(env, evt.user, {
                kind: 'awaiting_property_choice',
                originalMessage: text,
                extraction,
                candidates,
                eventTs: evt.ts,
            });
            const list = candidates.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
            return reply(threadTs, env,
                `A few properties match. Which one?\n${list}\nReply with the number or full address.`
            );
        }
        property = matches[0];
    }

    const priority = extraction.priority === 'High Priority' ? 'Urgent' : 'Not Urgent';

    // Ingest any Slack files into R2 → Airtable attachments.
    const attachments = await ingestSlackFiles(env, evt.files, evt.ts);

    // Auto-add Kevin/Mica/Erica as Collaborators (skip if the contractor's
    // own email matches one — they're the assignee, not a collaborator).
    const collaboratorEmails = TEAM_COLLABORATOR_EMAILS
        .filter(e => e.toLowerCase() !== contractor.airtableEmail.toLowerCase());

    const fields = {
        [FIELD.taskName]:        extraction.taskName,
        [FIELD.description]:     text || '(uploaded file)',
        [FIELD.status]:          'Upcoming',
        [FIELD.priority]:        priority,
        [FIELD.assignee]:        { email: contractor.airtableEmail },
        [FIELD.properties]:      [property.id],
        [FIELD.business]:        [BUSINESS_REAL_ESTATE_ID],
        [FIELD.maintenanceTick]: true,
        [FIELD.collaborators]:   collaboratorEmails.map(email => ({ email })),
    };
    if (contractor.contractorFieldValue) {
        fields[FIELD.contractor] = contractor.contractorFieldValue;
    }
    if (attachments.length) {
        fields[FIELD.attachments] = attachments;
    }

    await createTask(env, fields);

    // 1. Reply in #property-management thread (visible to the team).
    const channelLines = [
        `✅ Logged, ${contractor.firstName}.`,
        `*${extraction.taskName}*`,
        `📍 ${property.name}`,
        `⚡ Priority: ${priority}`,
    ];
    if (attachments.length) {
        channelLines.push(`📎 ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}`);
    }
    channelLines.push(`Added to your list.`);
    await reply(threadTs, env, channelLines.join('\n'));

    // 2. DM the contractor with the same confirmation (mirrors the
    // dashboard's existing assignee-DM behaviour).
    await dmUser(env, evt.user,
        `*Operations Director* assigned to you:\n` +
        `*${extraction.taskName}*\n` +
        `📍 ${property.name}\n` +
        `⚡ Priority: ${priority}`
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
        return { taskName: text.slice(0, 60) || 'Untitled job', propertyHint: '', priority: 'Low Priority' };
    }
}

async function matchProperty(hint, env) {
    if (!hint) return [];
    const all = await listAllProperties(env);
    const needle = hint.toLowerCase();
    return all.filter(p => p.name && p.name.toLowerCase().includes(needle));
}

// ─── HANDLER 2: STATUS UPDATE ─────────────────────────────────────────

async function handleStatusUpdate(contractor, text, evt, threadTs, env, override) {
    override = override || {};
    const openTasks = override.openTasks || await fetchOpenTasksFor(contractor, env);
    if (openTasks.length === 0) {
        return reply(threadTs, env,
            `${contractor.firstName}, you don't have any open jobs right now.`
        );
    }

    let target = override.resolvedTask || null;
    let action = override.action || null;
    let noteText = override.noteText || null;

    if (!target) {
        const match = await matchStatusUpdate(text, openTasks, env);
        if (match.matchedTaskIndex === -1) {
            // Save pending state, ask which job.
            await setPendingState(env, evt.user, {
                kind: 'awaiting_task_choice',
                originalMessage: text,
                taskIds: openTasks.map(t => t.id),
                eventTs: evt.ts,
            });
            const list = openTasks.map((t, i) =>
                `${i + 1}. ${t.taskName}${t.propertyName ? ' — ' + t.propertyName : ''}`
            ).join('\n');
            return reply(threadTs, env,
                `I can't tell which job you mean, ${contractor.firstName}. Your open jobs:\n${list}\n` +
                `Reply with the number or job name.`
            );
        }
        target = openTasks[match.matchedTaskIndex];
        action = match.action;
        noteText = match.noteText;
    }

    if (action === 'completed') {
        await updateTask(env, target.id, { [FIELD.status]: 'Completed' });
        await reply(threadTs, env,
            `✅ Marked complete: *${target.taskName}*. Nice one ${contractor.firstName}.`
        );
        // DM the OTHER team collaborators (skip whoever just completed it).
        await dmTeamExcept(env, contractor.airtableEmail,
            `*${contractor.name}* completed a task you collaborate on:\n` +
            `*${target.taskName}*` +
            (target.propertyName ? `\n📍 ${target.propertyName}` : '')
        );
        return;
    }
    if (action === 'in_progress') {
        await updateTask(env, target.id, { [FIELD.status]: 'Today' });
        return reply(threadTs, env, `👍 Got it — *${target.taskName}* is now in progress.`);
    }
    if (action === 'note') {
        // Post a native Airtable record comment (visible in the dashboard's
        // task-drawer Comments panel) rather than appending to the Notes
        // field. Comments are timestamped + author-attributed by Airtable;
        // the prefix here gives it the contractor's first name + "via Slack"
        // so it's obvious where the comment came from.
        const commentBody = `*${contractor.firstName} via Slack*\n${noteText || text}`;
        await addComment(env, target.id, commentBody);
        return reply(threadTs, env, `💬 Comment added to *${target.taskName}*.`);
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

// ─── MULTI-TURN: pending-state resolution ─────────────────────────────

async function resolvePending(contractor, text, pending, evt, threadTs, env) {
    // Optimistic clear — if the resolution fails we re-store below.
    await clearPendingState(env, evt.user);

    if (pending.kind === 'awaiting_property') {
        // Use the new message as the property name.
        const matches = await matchProperty(text, env);
        if (matches.length === 0) {
            await setPendingState(env, evt.user, pending);
            return reply(threadTs, env,
                `I still can't find that property. Try the name or address again.`
            );
        }
        if (matches.length > 1) {
            const candidates = matches.slice(0, 5);
            await setPendingState(env, evt.user, {
                ...pending,
                kind: 'awaiting_property_choice',
                candidates,
            });
            const list = candidates.map((p, i) => `${i + 1}. ${p.name}`).join('\n');
            return reply(threadTs, env,
                `A few properties match. Which one?\n${list}\nReply with the number or full address.`
            );
        }
        return handleNewJob(
            contractor, pending.originalMessage, evt, threadTs, env,
            { extraction: pending.extraction, resolvedProperty: matches[0] }
        );
    }

    if (pending.kind === 'awaiting_property_choice') {
        const candidates = pending.candidates;
        const chosen = pickFromCandidates(text, candidates, p => p.name);
        if (!chosen) {
            await setPendingState(env, evt.user, pending);
            return reply(threadTs, env,
                `That didn't match any of the options. Try the number (1–${candidates.length}) or the full property name.`
            );
        }
        return handleNewJob(
            contractor, pending.originalMessage, evt, threadTs, env,
            { extraction: pending.extraction, resolvedProperty: chosen }
        );
    }

    if (pending.kind === 'awaiting_task_choice') {
        // Refetch tasks to be safe (the contractor's open list may have moved on).
        const openTasks = await fetchOpenTasksFor(contractor, env);
        const candidates = openTasks.filter(t => pending.taskIds.includes(t.id));
        const chosen = pickFromCandidates(text, candidates, t => t.taskName);
        if (!chosen) {
            await setPendingState(env, evt.user, pending);
            return reply(threadTs, env,
                `That didn't match any of your open jobs. Try the number or the job name.`
            );
        }
        // Re-classify the original message now we know which job — so we
        // capture the action (done / in_progress / note).
        const match = await matchStatusUpdate(pending.originalMessage, [chosen], env);
        return handleStatusUpdate(
            contractor, pending.originalMessage, evt, threadTs, env,
            { openTasks, resolvedTask: chosen, action: match.action, noteText: match.noteText }
        );
    }

    // Unknown pending kind — fall through to normal routing.
    return routeMessage(evt, env);
}

function pickFromCandidates(text, candidates, nameOf) {
    if (!candidates || !candidates.length) return null;
    const trimmed = text.trim();
    const num = parseInt(trimmed, 10);
    if (Number.isInteger(num) && num >= 1 && num <= candidates.length) {
        return candidates[num - 1];
    }
    const lower = trimmed.toLowerCase();
    return candidates.find(c => nameOf(c).toLowerCase().includes(lower)) || null;
}

// ─── ATTACHMENTS: Slack → R2 → Airtable ───────────────────────────────

async function ingestSlackFiles(env, files, messageTs) {
    if (!env.ATTACHMENTS || !files || !files.length) return [];
    const out = [];
    for (const file of files) {
        try {
            const downloadUrl = file.url_private || file.url_private_download;
            if (!downloadUrl) continue;
            const fileResp = await fetch(downloadUrl, {
                headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
            });
            if (!fileResp.ok) {
                console.error(`Slack file fetch failed: ${fileResp.status}`);
                continue;
            }
            const body = await fileResp.arrayBuffer();
            const safeName = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
            const key = `${messageTs}/${safeName}`;
            await env.ATTACHMENTS.put(key, body, {
                httpMetadata: {
                    contentType: file.mimetype || 'application/octet-stream',
                },
            });
            out.push({
                url: `${publicFilesPrefix(env)}${encodeURIComponent(key)}`,
                filename: file.name || safeName,
            });
        } catch (err) {
            console.error('attachment ingest:', err && err.message);
        }
    }
    return out;
}

function publicFilesPrefix(env) {
    // Default to the workers.dev URL; override with PUBLIC_FILES_PREFIX
    // (e.g. a custom domain) by setting it as a Variable in the worker.
    return env.PUBLIC_FILES_PREFIX || 'https://contractor-bot.kevinbrittain.workers.dev/files/';
}

// ─── DIRECT MESSAGES ──────────────────────────────────────────────────

async function dmUser(env, slackUserId, text) {
    if (!env.SLACK_BOT_TOKEN) {
        throw new Error('SLACK_BOT_TOKEN not configured');
    }
    const resp = await fetch(SLACK_POST_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: slackUserId, text }),
    });
    const data = await resp.json();
    if (!data.ok) {
        console.error(`DM failed for ${slackUserId}: ${data.error}`);
    }
    return data.ok;
}

// DM each team-collaborator email except the one given (so the actor
// doesn't get pinged for their own action).
async function dmTeamExcept(env, excludeEmail, text) {
    const exclude = (excludeEmail || '').toLowerCase();
    for (const email of TEAM_COLLABORATOR_EMAILS) {
        if (email.toLowerCase() === exclude) continue;
        const userId = await lookupSlackUserByEmail(env, email);
        if (!userId) {
            console.error(`No Slack user for ${email}`);
            continue;
        }
        await dmUser(env, userId, text);
    }
}

async function lookupSlackUserByEmail(env, email) {
    if (!env.SLACK_BOT_TOKEN) return null;
    const resp = await fetch(`${SLACK_LOOKUP_URL}?email=${encodeURIComponent(email)}`, {
        headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    const data = await resp.json();
    return data.ok ? (data.user && data.user.id) : null;
}

// ─── MULTI-TURN: KV pending-state helpers ─────────────────────────────

async function getPendingState(env, slackUserId) {
    const json = await env.STATE.get(`pending:${slackUserId}`);
    return json ? JSON.parse(json) : null;
}

async function setPendingState(env, slackUserId, state) {
    if (!env.STATE) return;
    await env.STATE.put(`pending:${slackUserId}`, JSON.stringify(state), {
        expirationTtl: PENDING_TTL_SECONDS,
    });
}

async function clearPendingState(env, slackUserId) {
    if (!env.STATE) return;
    await env.STATE.delete(`pending:${slackUserId}`);
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

// Posts a record-level comment on the task. Different from the Notes
// field — these are Airtable's native record comments, shown in the
// dashboard's task-drawer Comments panel and in any Airtable interface.
// Requires PAT scope `data.recordComments:write`.
async function addComment(env, recordId, text) {
    return airtable(env, 'POST', `/${TABLE_TASKS}/${recordId}/comments`, { text });
}

async function fetchOpenTasksFor(contractor, env) {
    const fields = [
        FIELD.taskName, FIELD.status, FIELD.priority,
        FIELD.properties, FIELD.notes, FIELD.maintenanceTick,
    ];
    // Contractors only see Maintenance-Ticket tasks — never non-maintenance
    // work that might be incidentally assigned to them.
    const formula =
        `AND(` +
            `{Status}!='Completed',` +
            `{Assignee}='${escapeFormula(contractor.name)}',` +
            `{Maintenance Ticket}=TRUE()` +
        `)`;
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

// ─── EXTERNAL: Anthropic API ──────────────────────────────────────────

async function callClaude(env, { system, messages, maxTokens }) {
    if (!env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY not configured');
    }
    const resp = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
            model: MODEL_FAST,
            max_tokens: maxTokens,
            system,
            messages,
        }),
    });
    if (!resp.ok) {
        throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
    }
    const data = await resp.json();
    return (data.content && data.content[0] && data.content[0].text) || '';
}

// ─── EXTERNAL: Slack channel reply ────────────────────────────────────

async function reply(threadTs, env, text) {
    if (!env.SLACK_BOT_TOKEN) {
        throw new Error('SLACK_BOT_TOKEN not configured');
    }
    const resp = await fetch(SLACK_POST_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
            channel: PROPERTY_CHANNEL_ID,
            text,
            thread_ts: threadTs,
        }),
    });
    const data = await resp.json();
    if (!data.ok) {
        throw new Error(`Slack post failed: ${data.error || resp.status}`);
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
