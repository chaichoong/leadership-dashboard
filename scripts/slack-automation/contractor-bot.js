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
            const evt = payload.event || {};
            // Diagnostic: log every event we receive plus whether we'll
            // route it. Keeps a clear breadcrumb of "Slack sent X, we
            // did Y" in the worker logs without dumping full payloads.
            const why = shouldHandle(evt);
            console.log('[event_callback]',
                'type=', evt.type,
                'channel_type=', evt.channel_type,
                'channel=', evt.channel,
                'user=', evt.user,
                'thread_ts=', evt.thread_ts ? 'yes' : 'no',
                'subtype=', evt.subtype || 'none',
                'bot_id=', evt.bot_id ? 'yes' : 'no',
                'will_route=', why);
            if (why) {
                ctx.waitUntil(routeMessage(evt, env).catch(err => {
                    console.error('contractor-bot:', err && err.stack || err);
                }));
            } else {
                // Spell out the rejection reason — most useful when an
                // event reaches the worker but doesn't match either branch.
                if (!evt || evt.type !== 'message') console.log('[skip] not a message event');
                else if (evt.bot_id) console.log('[skip] bot message');
                else if (evt.subtype && evt.subtype !== 'file_share') console.log('[skip] subtype=', evt.subtype);
                else if (!evt.user) console.log('[skip] no user');
                else if (evt.channel_type === 'im' && !evt.thread_ts) console.log('[skip] DM but not a thread reply');
                else if (evt.channel_type === 'im' && !evt.text) console.log('[skip] DM thread reply with no text');
                else if (evt.channel !== PROPERTY_CHANNEL_ID) console.log('[skip] channel', evt.channel, 'is not property-management');
                else if (!CONTRACTORS[evt.user]) console.log('[skip] user', evt.user, 'is not in CONTRACTORS map');
                else console.log('[skip] structured-notification text filter matched');
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
    if (evt.bot_id) return false;
    if (evt.subtype && evt.subtype !== 'file_share') return false;
    if (!evt.user) return false;
    // BRANCH 1 — DM thread reply.
    // The dashboard sends comment-DMs to collaborators; users can reply in
    // the thread of those DMs and we post their reply as a comment on the
    // task. We accept ANY DM thread reply here; downstream code verifies
    // the parent was actually a comment-DM (Task ID embedded in context
    // block) before doing anything.
    if (evt.channel_type === 'im' && evt.thread_ts && evt.text) return true;
    // BRANCH 2 — contractor channel message (legacy / primary flow).
    if (evt.channel !== PROPERTY_CHANNEL_ID) return false;
    if (!CONTRACTORS[evt.user]) return false;
    // Skip structured notifications posted by the dashboard's
    // contractor-job-creator skill — without this we'd interpret them as
    // a contractor reporting new work.
    //
    // We deliberately do NOT filter on "Sent using @Claude" — Slack
    // appends that suffix to EVERY message posted via Claude's MCP,
    // including legitimate test posts, so it would block all of them.
    // The skill-specific markers below are unique to the skill's
    // notification format.
    const text = evt.text || '';
    if (text.includes('🆕 New job added')) return false;
    if (text.includes('View your job list')) return false;
    return true;
}

// ─── ROUTING ──────────────────────────────────────────────────────────

async function routeMessage(evt, env) {
    // DM thread-reply flow — handled by a separate code path so the
    // contractor-channel logic below stays untouched.
    if (evt.channel_type === 'im' && evt.thread_ts) {
        return handleDmThreadReply(evt, env);
    }
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

// ─── HANDLER 0: DM THREAD REPLY → AIRTABLE COMMENT ────────────────────
//
// When the dashboard DMs a collaborator about a comment / assignment,
// the user can reply in the thread to add their own comment on the
// task. We:
//   1. Fetch the parent message to extract the embedded Task ID.
//   2. Resolve the Slack user to a TEAM member (handles slackEmail
//      overrides like Gary's two-email setup).
//   3. POST the reply to Airtable's comments API on that task,
//      prefixed "[via Slack — <Name>]" so it's attributable.
//   4. Fan out a comment-DM to every other collaborator + assignee.
//   5. React ✅ on the user's reply to confirm receipt.

// TEAM map mirrors the dashboard's TEAM constant — used for Airtable↔Slack
// email translation when a member's two emails differ.
const COMMENT_TEAM = [
    { name: 'Kevin Brittain',   email: 'kevin@runpreneur.org.uk' },
    { name: 'Mica Albovias',    email: 'micaa.work@gmail.com' },
    { name: 'Ericamae Atenta',  email: 'atentaerica@gmail.com' },
    { name: 'Gary Marsh',       email: 'gkm.property.maintenance@outlook.com', slackEmail: 'roofline@outlook.com' },
    { name: 'Rob Jackson',      email: 'rjm320@hotmail.com' },
    { name: 'Roy Lavin',        email: 'roy.lavin1978@gmail.com' },
];
function commentSlackEmailFor(airtableEmail) {
    if (!airtableEmail) return airtableEmail;
    const m = COMMENT_TEAM.find(t => t.email.toLowerCase() === airtableEmail.toLowerCase());
    return (m && m.slackEmail) || airtableEmail;
}
function commentTeamBySlackEmail(slackEmail) {
    if (!slackEmail) return null;
    const lc = slackEmail.toLowerCase();
    return COMMENT_TEAM.find(t =>
        t.email.toLowerCase() === lc ||
        (t.slackEmail && t.slackEmail.toLowerCase() === lc)
    ) || null;
}

async function handleDmThreadReply(evt, env) {
    // 1. Look up the parent DM — find the embedded Task ID.
    const parentRes = await fetch(
        `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(evt.channel)}&ts=${encodeURIComponent(evt.thread_ts)}&limit=1`,
        { headers: { Authorization: 'Bearer ' + env.SLACK_BOT_TOKEN } }
    );
    const parent = await parentRes.json();
    if (!parent.ok || !parent.messages || !parent.messages.length) {
        console.warn('[dm-thread] could not fetch parent', parent.error || parent);
        return;
    }
    const taskId = extractTaskIdFromMessage(parent.messages[0]);
    if (!taskId) {
        console.warn('[dm-thread] no Task ID in parent — ignoring', parent.messages[0].ts);
        return;
    }

    // 2. Resolve the Slack user → Airtable email + display name.
    const userInfoRes = await fetch(
        'https://slack.com/api/users.info?user=' + encodeURIComponent(evt.user),
        { headers: { Authorization: 'Bearer ' + env.SLACK_BOT_TOKEN } }
    );
    const userInfo = await userInfoRes.json();
    if (!userInfo.ok) {
        console.warn('[dm-thread] users.info failed', userInfo.error);
        return;
    }
    const slackEmail = userInfo.user && userInfo.user.profile && userInfo.user.profile.email;
    const slackDisplay = userInfo.user && userInfo.user.real_name;
    const teamMember = commentTeamBySlackEmail(slackEmail);
    const actorName = (teamMember && teamMember.name) || slackDisplay || slackEmail || 'Slack user';
    const actorAirtableEmail = (teamMember && teamMember.email) || slackEmail || '';

    // 3. Strip Slack mrkdwn from the reply text.
    const replyText = cleanSlackText(evt.text);
    if (!replyText) return;

    // 4. POST as a comment on the Airtable task.
    const commentBody = `[via Slack — ${actorName}] ${replyText}`;
    const commentRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_TASKS}/${taskId}/comments`,
        {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + env.AIRTABLE_PAT, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: commentBody }),
        }
    );
    if (!commentRes.ok) {
        const errText = await commentRes.text();
        console.error('[dm-thread] Airtable comment POST failed', commentRes.status, errText);
        try {
            await fetch(SLACK_POST_URL, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + env.SLACK_BOT_TOKEN, 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({
                    channel: evt.channel,
                    thread_ts: evt.thread_ts,
                    text: '⚠️ Couldn\'t post your reply as a comment on the task. Airtable returned ' + commentRes.status + '.',
                }),
            });
        } catch (_) {}
        return;
    }

    // 5. Fetch the task to get name + collaborators for fan-out.
    const taskRes = await fetch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_TASKS}/${taskId}?returnFieldsByFieldId=true`,
        { headers: { Authorization: 'Bearer ' + env.AIRTABLE_PAT } }
    );
    if (!taskRes.ok) {
        console.error('[dm-thread] task fetch failed', await taskRes.text());
        return;
    }
    const task = await taskRes.json();
    const fields = task.fields || {};
    const taskName = fields[FIELD.taskName] || '(Untitled)';
    const recipients = new Set();
    const collabs = fields[FIELD.collaborators] || [];
    if (Array.isArray(collabs)) collabs.forEach(c => { if (c && c.email) recipients.add(c.email) });
    const assignee = fields[FIELD.assignee];
    if (assignee && assignee.email) recipients.add(assignee.email);
    if (actorAirtableEmail) recipients.delete(actorAirtableEmail);

    // 6. Fan out a 'comment' DM to each remaining recipient.
    for (const email of recipients) {
        try {
            const slackTarget = commentSlackEmailFor(email);
            await dispatchCommentDm(env, slackTarget, { taskName, taskId, actorName, commentText: replyText });
        } catch (e) {
            console.warn('[dm-thread] fan-out failed for', email, e);
        }
    }

    // 7. ✅ reaction so the user knows we received the reply.
    try {
        await fetch('https://slack.com/api/reactions.add', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + env.SLACK_BOT_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: evt.channel, timestamp: evt.ts, name: 'white_check_mark' }),
        });
    } catch (_) { /* non-critical */ }
}

function extractTaskIdFromMessage(msg) {
    if (msg.blocks && Array.isArray(msg.blocks)) {
        for (const blk of msg.blocks) {
            const els = (blk.elements || []);
            for (const el of els) {
                const t = (el && el.text) || '';
                const m = t.match(/Task ID:\s*`?(rec[A-Za-z0-9]{14})`?/);
                if (m) return m[1];
            }
            const txt = (blk.text && blk.text.text) || '';
            const m2 = txt.match(/Task ID:\s*`?(rec[A-Za-z0-9]{14})`?/);
            if (m2) return m2[1];
        }
    }
    const m = (msg.text || '').match(/Task ID:\s*`?(rec[A-Za-z0-9]{14})`?/);
    return m ? m[1] : null;
}

function cleanSlackText(text) {
    if (!text) return '';
    let s = String(text);
    s = s.replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, '');
    s = s.replace(/<!channel>/g, '@channel').replace(/<!here>/g, '@here');
    s = s.replace(/<([^|>]+)\|([^>]+)>/g, '$2');
    s = s.replace(/<([^>]+)>/g, '$1');
    return s.trim();
}

async function dispatchCommentDm(env, recipientEmail, payload) {
    const lookupRes = await fetch(
        SLACK_LOOKUP_URL + '?email=' + encodeURIComponent(recipientEmail),
        { headers: { Authorization: 'Bearer ' + env.SLACK_BOT_TOKEN } }
    );
    const lookup = await lookupRes.json();
    if (!lookup.ok || !lookup.user) {
        console.warn('[fan-out] no Slack user for', recipientEmail, lookup.error);
        return;
    }
    const userId = lookup.user.id;
    const escape = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const headerLine = '*' + escape(payload.actorName) + '* left a comment on a task you collaborate on:';
    const cleanComment = String(payload.commentText || '').trim().slice(0, 500);
    const text = headerLine + '\n\n• ' + escape(payload.taskName) +
        (cleanComment ? '\n\n> ' + escape(cleanComment).split('\n').join('\n> ') : '');
    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: headerLine } },
        { type: 'section', text: { type: 'mrkdwn', text: '*' + escape(payload.taskName) + '*' } },
    ];
    if (cleanComment) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '> ' + escape(cleanComment).split('\n').join('\n> ') },
        });
    }
    if (payload.taskId) {
        blocks.push({
            type: 'context',
            elements: [
                { type: 'mrkdwn', text: '💬 Reply in this thread to add a comment on the task.' },
                { type: 'mrkdwn', text: 'Task ID: `' + escape(payload.taskId) + '`' },
            ],
        });
    }
    await fetch(SLACK_POST_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.SLACK_BOT_TOKEN, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel: userId, text, blocks }),
    });
}

// ─── INTENT CLASSIFICATION ────────────────────────────────────────────

async function classifyIntent(text, env) {
    const system =
        `You classify short Slack messages from maintenance/property contractors into exactly one of:\n\n` +
        `  new_job        — reporting a NEW job that needs doing. Describes a fault, a piece of work, or something that needs attention. Usually mentions a property and what's wrong / what's needed.\n` +
        `  status_update  — reporting progress on an EXISTING job they're already working on. Announces completion, that they've started, that they're stuck/waiting, or adds a note about the work in progress.\n` +
        `  list_request   — asking to see their open jobs / current workload.\n` +
        `  unknown        — anything else, or too ambiguous.\n\n` +
        `Critical disambiguation:\n` +
        `Words like "blocked", "broken", "leaking", "not working", "stopped", "stuck" are normally describing FAULTS — that's a new_job (the thing is in that state). They're status_update only when clearly referring to the contractor's own progress ("I'm blocked waiting for parts", "I'm stuck on the wiring").\n\n` +
        `Examples:\n` +
        `  "boiler broken at 55 Elmdon"             → new_job (fault description)\n` +
        `  "blocked drain at 5 Woodcock"            → new_job (fault description; "blocked" describes the drain)\n` +
        `  "tap leaking in kitchen at Chedburgh"    → new_job (fault description)\n` +
        `  "no hot water at Northfield"             → new_job (fault description)\n` +
        `  "done with the boiler"                   → status_update (announcing completion)\n` +
        `  "finished at Elmdon"                     → status_update (announcing completion)\n` +
        `  "started on the front door"              → status_update (announcing progress)\n` +
        `  "waiting on parts for the boiler"       → status_update (note on existing work)\n` +
        `  "stuck on the wiring at 12 Oldham"       → status_update (own progress, blocked)\n` +
        `  "what's on my list"                      → list_request\n` +
        `  "show my jobs"                           → list_request\n\n` +
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

    const created = await createTask(env, fields);
    const newTaskId = created && created.records && created.records[0] && created.records[0].id;

    // Remember which task this thread is about, so any future thread reply
    // (status update, comment, completion) targets THIS task and isn't
    // fuzzy-matched to an unrelated one.
    if (newTaskId) {
        await setThreadTask(env, threadTs, newTaskId);
    }

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
    const needle = hint.toLowerCase().trim();

    // Pass 1 — exact substring either way. Fast-path for the common cases:
    //   "55 Elmdon"            → "55 Elmdon Place, …"        (prop includes hint)
    //   "13 Chedburgh Place"   → "13 Chedburgh Place, …"     (prop includes hint)
    //   "Roofline cottage"     → "Roofline Cottage"          (exact)
    const substringMatches = all.filter(p => {
        if (!p.name) return false;
        const propName = p.name.toLowerCase();
        return propName.includes(needle) || needle.includes(propName);
    });
    if (substringMatches.length > 0) return substringMatches;

    // Pass 2 — token-based scoring for hints where neither side strictly
    // contains the other. Catches:
    //   "Unit 4, 13 Chedburgh Place" → "13 Chedburgh Place, Haverhill, …"
    //     (hint adds "Unit 4", record adds postcode + town — overlap on
    //      ["13", "chedburgh", "place"] = 3 tokens.)
    // Returns the property/properties with the highest token overlap, so
    // long as that overlap is ≥ 2 distinct tokens (otherwise too weak to
    // be confident — fall back to asking the contractor).
    const hintTokens = tokenize(hint);
    if (hintTokens.length === 0) return [];
    const scored = all.map(p => ({
        record: p,
        score: tokenOverlap(hintTokens, tokenize(p.name)),
    }));
    const maxScore = scored.reduce((m, s) => s.score > m ? s.score : m, 0);
    if (maxScore < 2) return [];
    return scored.filter(s => s.score === maxScore).map(s => s.record);
}

function tokenize(s) {
    return (s || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(t => t.length > 1); // skip "" and single chars ("a", "i")
}

function tokenOverlap(aTokens, bTokens) {
    const bSet = new Set(bTokens);
    let n = 0;
    for (const t of aTokens) if (bSet.has(t)) n++;
    return n;
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

    // If this is a thread reply AND we have a remembered task for that
    // thread, use it directly. Only Claude's job here is to classify the
    // ACTION (completed / in_progress / note) — no fuzzy task matching.
    // This stops the bot picking a semantically-similar but wrong task
    // (e.g. "Struggling to schedule" → "Source solicitor and arrange
    // meeting" when the contractor was clearly talking about the task
    // logged earlier in the same thread).
    if (!target && evt.thread_ts) {
        const threadTaskId = await getThreadTask(env, evt.thread_ts);
        if (threadTaskId) {
            const threadTask = openTasks.find(t => t.id === threadTaskId);
            if (threadTask) {
                const match = await matchStatusUpdate(text, [threadTask], env);
                target = threadTask;
                action = match.action;
                noteText = match.noteText;
            }
        }
    }

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

// ─── THREAD → TASK MAPPING ────────────────────────────────────────────
// When the bot creates a task in response to a message in a thread, it
// remembers `thread_ts → task_id`. When the contractor later replies in
// that same thread (e.g. "ran into delays" or "done"), the bot uses
// the remembered task directly instead of asking Claude to guess which
// of the contractor's open jobs the message is about. Stops the bot
// from fuzzy-matching to a totally unrelated task.
const THREAD_TASK_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

async function setThreadTask(env, threadTs, taskId) {
    if (!env.STATE || !threadTs || !taskId) return;
    await env.STATE.put(`thread:${threadTs}`, taskId, {
        expirationTtl: THREAD_TASK_TTL_SECONDS,
    });
}

async function getThreadTask(env, threadTs) {
    if (!env.STATE || !threadTs) return null;
    return await env.STATE.get(`thread:${threadTs}`);
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
    // Contractor identity is the only filter — anything assigned to them
    // is contractor work by definition (maintenance, gardening, callouts,
    // anything). Do NOT additionally filter by Maintenance Ticket — that
    // would over-narrow and hide non-maintenance contractor work.
    const formula =
        `AND(` +
            `{Status}!='Completed',` +
            `{Assignee}='${escapeFormula(contractor.name)}'` +
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
