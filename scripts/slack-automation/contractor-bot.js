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
//                           + data.recordComments:write on base
//                           appnqjDpqDniH3IRl
//   SLACK_SIGNING_SECRET  — Slack app → Basic Information → App Credentials
//   ANTHROPIC_API_KEY     — sk-ant-… from console.anthropic.com
//   SLACK_BOT_TOKEN       — xoxb-… bot token from the Operations Director
//                           Slack app (same as in slack-notify worker)
//   INTERNAL_BEARER       — Shared secret for the /create-task endpoint.
//                           Used by the contractor-job-creator Claude
//                           skill (Mica/Erica/Kevin run it locally) to
//                           authenticate task-creation calls. Generate
//                           any random string ≥ 32 chars and distribute
//                           via password manager.
//
// BINDINGS (Cloudflare → contractor-bot → Settings → Bindings)
// ───────────────────────────────────────────────────────────
//   ATTACHMENTS  — R2 bucket binding (e.g. bucket name "contractor-bot-attachments")
//   STATE        — KV namespace binding (e.g. namespace "contractor-bot-state")

// ─── CONFIGURATION ────────────────────────────────────────────────────

const PROPERTY_CHANNEL_ID = 'C09EMKREPJL';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Model IDs live in wrangler.toml [vars] (AI_MODEL_DEFAULT / AI_MODEL_LIGHT)
// and are read off `env` at the call site — a module-scope const cannot see
// `env`, which is how the old literals got stranded on a stale model. The
// light/default split is preserved:
//   env.AI_MODEL_LIGHT   — the cheap default for most calls (was MODEL_FAST)
//   env.AI_MODEL_DEFAULT — the intent classifier (was MODEL_ACCURATE). Sonnet
//     handles the fault-vs-progress distinction (e.g. "blocked drain" = new
//     fault, not a contractor status report) reliably where Haiku trips up.
//     Single short call per inbound message, so the cost is pennies.

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
    // The legacy Contractor singleSelect (fldgmzcr3jHALsdYD) is no
    // longer written by the bot. The dashboard's Contractor Tasks tab
    // now filters by Assignee email, so the singleSelect is redundant.
    // Old records still carry it for backwards-compat display in the
    // task drawer; nothing here needs to write it.
    propertyName:    'fldy2t735TV5e1DIL', // single line text (Properties table)
};

// Defaults written on every contractor-created task.
const BUSINESS_REAL_ESTATE_ID = 'recoGcXRXCniyJsTz';
const BUSINESS_OPS_DIRECTOR_ID = 'reca9ofzhuw13ZzGE'; // Operations Director — used for Roy's non-property work (sales, lead follow-ups, customer prospecting)

// Per-contractor business resolution rules:
//   - Gary, Rob → ALWAYS Real Estate. Both only do property maintenance.
//   - Roy + property linked → Real Estate (any property work is RE by definition).
//   - Roy + no property + sales/customer/lead/client/prospect vocabulary → Operations Director.
//   - Roy + ambiguous → Real Estate (default), the confirmation prompt mentions
//                       this so the user can override before the write.
function resolveBusinessId(assignee, hasResolvedProperty, descriptionText) {
    const fn = (assignee.firstName || '').toLowerCase();
    if (fn === 'gary' || fn === 'rob') return { id: BUSINESS_REAL_ESTATE_ID, name: 'Real Estate', confident: true };
    if (fn === 'roy') {
        if (hasResolvedProperty) return { id: BUSINESS_REAL_ESTATE_ID, name: 'Real Estate', confident: true };
        const t = (descriptionText || '').toLowerCase();
        const opsKeywords = /\b(sales|customer|client|prospect|lead|follow[- ]?up|enquiry|inquiry|appointment|deal|call back|cold call|outreach|pitch|demo|onboard)\b/;
        if (opsKeywords.test(t)) return { id: BUSINESS_OPS_DIRECTOR_ID, name: 'Operations Director', confident: true };
        return { id: BUSINESS_REAL_ESTATE_ID, name: 'Real Estate', confident: false };
    }
    // Unknown contractor — safest fallback.
    return { id: BUSINESS_REAL_ESTATE_ID, name: 'Real Estate', confident: false };
}

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
const CONTRACTORS = {
    U0A9XD12YPN: { name: 'Gary Marsh',  firstName: 'Gary', airtableEmail: 'gkm.property.maintenance@outlook.com' },
    U0AAN4CTVQQ: { name: 'Roy Lavin',   firstName: 'Roy',  airtableEmail: 'roy.lavin1978@gmail.com' },
    U0A9MDFKA59: { name: 'Rob Jackson', firstName: 'Rob',  airtableEmail: 'rjm320@hotmail.com' },
};

// Slack user ID → office team identity. Team members can post in
// #property-management to:
//   - log new contractor jobs and assign them
//     (e.g. "boiler broken at 55 Elmdon, give it to Gary"),
//   - mark a contractor task complete / in progress on their behalf,
//   - add a comment, or attach a photo.
// The pool of "open tasks" for a team member in fetchOpenTasksFor is
// every task where they're the Assignee OR a Collaborator — which
// covers every contractor task, since the bot auto-adds Kevin/Mica/
// Erica as collaborators on each one.
const TEAM_MEMBERS = {
    U08HW8F1MA8: { name: 'Kevin Brittain',  firstName: 'Kevin', airtableEmail: 'kevin@runpreneur.org.uk' },
    U08HW0TAWAE: { name: 'Mica Albovias',   firstName: 'Mica',  airtableEmail: 'micaa.work@gmail.com' },
    U08J38Y0PTN: { name: 'Ericamae Atenta', firstName: 'Erica', airtableEmail: 'atentaerica@gmail.com' },
};

// Resolve a Slack user ID to either a contractor or a team-member sender,
// or null if neither. Used by shouldHandle + routing to know how to treat
// the message.
function senderFor(slackUserId) {
    const c = CONTRACTORS[slackUserId];
    if (c) return { kind: 'contractor', ...c };
    const t = TEAM_MEMBERS[slackUserId];
    if (t) return { kind: 'team', ...t };
    return null;
}

// First-name → contractor lookup, used when a team member writes "assign
// to Gary" or replies "Gary" to the bot's "who should I assign this to?"
// prompt. Lenient on purpose — uses a word-boundary search so it copes
// with extra wrapping text:
//   "Gary"                                          → Gary  ✓
//   "Gary please"                                   → Gary  ✓
//   "Gary\n*Sent using* <@U0ALEDV9XNK|Claude>"      → Gary  ✓
//   "let's get Roy on it"                           → Roy   ✓
//   "Gargantua"                                     → null  (word boundary)
function findContractorByFirstName(text) {
    if (!text) return null;
    const haystack = String(text);
    for (const slackId of Object.keys(CONTRACTORS)) {
        const c = CONTRACTORS[slackId];
        const re = new RegExp(`\\b${c.firstName}\\b`, 'i');
        if (re.test(haystack)) {
            return { kind: 'contractor', slackUserId: slackId, ...c };
        }
    }
    return null;
}

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

        // POST /create-task — internal endpoint used by the
        // contractor-job-creator Claude skill (and eventually the
        // dashboard "Add Task" form). Authenticated by a bearer token
        // shared with the office team. Different auth from the Slack
        // event flow because there's no Slack signature to verify.
        if (url.pathname === '/create-task') {
            return handleInternalCreateTask(request, env);
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
                ctx.waitUntil(routeMessage(evt, env).catch(async err => {
                    console.error('contractor-bot:', err && err.stack || err);
                    // Don't leave the contractor staring at an unresponsive
                    // bot — drop a generic error in the channel thread so
                    // they know to try again or use the dashboard. Best-effort:
                    // if THIS reply also fails (e.g. SLACK_BOT_TOKEN issue),
                    // the inner catch keeps the worker from crashing.
                    try {
                        const threadTs = evt && (evt.thread_ts || evt.ts);
                        if (threadTs && evt.channel === PROPERTY_CHANNEL_ID) {
                            await reply(threadTs, env,
                                `Sorry — something went wrong on my end and I couldn't process that. ` +
                                `Try sending it again, or use the dashboard if the problem keeps happening.`
                            );
                        }
                    } catch (replyErr) {
                        console.error('contractor-bot: failed to send error reply:', replyErr && replyErr.stack || replyErr);
                    }
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
    // Accept messages from BOTH contractors and team members. Contractors
    // do their own work; team members can log new jobs and assign them.
    if (!CONTRACTORS[evt.user] && !TEAM_MEMBERS[evt.user]) return false;
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
    const sender = senderFor(evt.user);
    if (!sender) return;
    const text = (evt.text || '').trim();
    const threadTs = evt.thread_ts || evt.ts;
    const hasFiles = evt.files && evt.files.length > 0;
    if (!text && !hasFiles) return;

    // If the bot recently asked this user a clarifying question,
    // treat the new message as the answer instead of classifying it fresh.
    if (env.STATE) {
        const pending = await getPendingState(env, evt.user);
        if (pending) {
            return resolvePending(sender, text, pending, evt, threadTs, env);
        }
    }

    // Fresh message — classify intent and route.
    const intent = await classifyIntent(text || '(file uploaded)', env);

    // FILE-ONLY / unclear-text-with-files → treat as a photo attachment to
    // an existing job. Skipped when the intent clearly fits another flow
    // (new_job carries its photos along; status_update will too, see
    // handleStatusUpdate). Works for both contractors (their own jobs)
    // and team members (tasks they're Assignee or Collaborator on — which
    // includes every contractor task because of auto-collab).
    if (
        hasFiles &&
        (intent === 'unknown' || intent === 'list_request' || !text)
    ) {
        return handleAttachPhoto(sender, text, evt, threadTs, env);
    }

    switch (intent) {
        case 'new_job':       return handleNewJob(sender, text, evt, threadTs, env);
        case 'status_update': return handleStatusUpdate(sender, text, evt, threadTs, env);
        case 'list_request':  return handleListRequest(sender, threadTs, env);
        default:
            return reply(threadTs, env,
                `Hi ${sender.firstName}, I'm not sure what you need. Try:\n` +
                `• *New job* — describe what needs doing and at which property\n` +
                `• *Update* — tell me if you've started or finished a job\n` +
                `• *My list* — ask "what's on my list" to see your open jobs`
            );
    }
}

// ─── INTERNAL ENDPOINT: /create-task ──────────────────────────────────
//
// Used by the contractor-job-creator Claude skill (Mica/Erica/Kevin
// running Claude Code/Co-Work) and — eventually — the dashboard's
// "Add Task" form. Single source-of-truth for contractor task creation:
// the same business resolution, property matching, assignee email
// handling, channel reply, contractor DM and team-collaborator setup
// that the Slack flow uses.
//
// Auth: shared INTERNAL_BEARER token. NOT a per-user identity, just a
// "did this come from someone who's allowed to call us" gate. Office
// team stores it locally (e.g. ~/.contractor-bot-bearer.txt) and the
// skill reads it via Bash before POSTing.
//
// Request body:
//   {
//     "description":         "Tenant says boiler at 55 Elmdon broken, no hot water",
//     "propertyHint":        "55 Elmdon",                       // optional — bot will extract from description if omitted
//     "assigneeFirstName":   "Gary",                            // required: Gary | Roy | Rob
//     "actorName":           "Mica Albovias",                   // optional — used in channel reply ("Logged for X — added by Mica")
//     "actorEmail":          "micaa.work@gmail.com",            // optional — added as a Collaborator on the task if recognised
//     "businessOverride":    "operations" | "real_estate"       // optional — forces business; otherwise auto-resolved
//   }
//
// Response:
//   200 { "ok": true, taskId, taskName, propertyName, businessName, priority, assigneeName }
//   400 { "ok": false, "error": "..." }   // bad input
//   401 { "ok": false, "error": "..." }   // bad / missing bearer
//   404 { "ok": false, "error": "..." }   // contractor or property not found
//   500 { "ok": false, "error": "..." }   // unexpected failure
async function handleInternalCreateTask(request, env) {
    const respondJson = (status, body) => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

    // Auth.
    const authHeader = request.headers.get('Authorization') || '';
    const presentedToken = authHeader.replace(/^Bearer\s+/i, '');
    if (!env.INTERNAL_BEARER) {
        return respondJson(500, { ok: false, error: 'INTERNAL_BEARER not configured on the worker' });
    }
    if (!presentedToken || presentedToken !== env.INTERNAL_BEARER) {
        return respondJson(401, { ok: false, error: 'Unauthorised — bearer token missing or wrong' });
    }

    // Parse body.
    let body;
    try { body = await request.json(); }
    catch { return respondJson(400, { ok: false, error: 'Invalid JSON body' }); }

    const description = String(body.description || '').trim();
    const propertyHint = String(body.propertyHint || '').trim();
    const assigneeFirstName = String(body.assigneeFirstName || '').trim();
    const actorName = String(body.actorName || '').trim();
    const actorEmail = String(body.actorEmail || '').trim();
    const businessOverride = String(body.businessOverride || '').trim().toLowerCase();

    if (!description) {
        return respondJson(400, { ok: false, error: '`description` is required' });
    }
    if (!assigneeFirstName) {
        return respondJson(400, { ok: false, error: '`assigneeFirstName` is required (Gary, Roy, or Rob)' });
    }

    // Resolve assignee.
    const assignee = findContractorByFirstName(assigneeFirstName);
    if (!assignee) {
        return respondJson(404, { ok: false, error: `Couldn't recognise contractor "${assigneeFirstName}". Use Gary, Roy, or Rob.` });
    }

    // Run the same field extraction as the Slack flow so task name,
    // priority, and propertyHint are filled from the description.
    let extraction;
    try {
        extraction = await extractNewJobFields(description, env);
    } catch (e) {
        return respondJson(500, { ok: false, error: `Field extraction failed: ${e && e.message || e}` });
    }
    const effectivePropertyHint = propertyHint || extraction.propertyHint || '';

    // Resolve property.
    if (!effectivePropertyHint) {
        return respondJson(400, { ok: false, error: 'No property mentioned in description and no propertyHint provided. Add the property name/address.' });
    }
    const matches = await matchProperty(effectivePropertyHint, env);
    if (matches.length === 0) {
        return respondJson(404, { ok: false, error: `No property matched "${effectivePropertyHint}". Try a more specific name.` });
    }
    if (matches.length > 1) {
        return respondJson(400, {
            ok: false,
            error: `Property hint "${effectivePropertyHint}" matched ${matches.length} properties. Use a more specific propertyHint.`,
            candidates: matches.slice(0, 5).map(p => p.name),
        });
    }
    const property = matches[0];

    // Business resolution.
    let businessRes;
    if (businessOverride === 'operations' || businessOverride === 'operations director' || businessOverride === 'ops') {
        businessRes = { id: BUSINESS_OPS_DIRECTOR_ID, name: 'Operations Director', confident: true };
    } else if (businessOverride === 'real_estate' || businessOverride === 'real estate' || businessOverride === 're') {
        businessRes = { id: BUSINESS_REAL_ESTATE_ID, name: 'Real Estate', confident: true };
    } else {
        businessRes = resolveBusinessId(assignee, true /* property always present here */, description);
    }

    const priority = extraction.priority === 'High Priority' ? 'Urgent' : 'Not Urgent';

    // Build the same field set the Slack confirm flow writes.
    const collaboratorEmails = TEAM_COLLABORATOR_EMAILS
        .filter(e => e.toLowerCase() !== assignee.airtableEmail.toLowerCase());
    // If actorEmail is one of the team-collab emails (and isn't the assignee),
    // it's already in the list above. Nothing extra needed.
    const fields = {
        [FIELD.taskName]:        extraction.taskName,
        [FIELD.description]:     description,
        [FIELD.status]:          'Upcoming',
        [FIELD.priority]:        priority,
        [FIELD.assignee]:        { email: assignee.airtableEmail },
        [FIELD.properties]:      [property.id],
        [FIELD.business]:        [businessRes.id],
        [FIELD.maintenanceTick]: true,
        [FIELD.collaborators]:   collaboratorEmails.map(email => ({ email })),
    };

    let created;
    try {
        created = await createTask(env, fields);
    } catch (e) {
        return respondJson(500, { ok: false, error: `Airtable createTask failed: ${e && e.message || e}` });
    }
    const newTaskId = created && created.records && created.records[0] && created.records[0].id;

    // Notify channel + DM the contractor (mirrors Slack flow). Best-effort —
    // a Slack failure shouldn't fail the whole API call now that the task
    // has been written to Airtable. Errors are returned in the response so
    // the caller can surface them.
    const slackErrors = [];
    const headerLine = actorName
        ? `✅ Logged for ${assignee.firstName} (added by ${actorName.split(' ')[0]}).`
        : `✅ Logged for ${assignee.firstName}.`;
    const channelLines = [
        headerLine,
        `*${extraction.taskName}*`,
        `📍 ${property.name}`,
        `⚡ Priority: ${priority}`,
        `🏢 Business: ${businessRes.name}`,
    ];
    try {
        await postSlackChannelMessage(env, PROPERTY_CHANNEL_ID, channelLines.join('\n'));
    } catch (e) {
        slackErrors.push(`channel post: ${e && e.message || e}`);
    }
    try {
        await dmUserByEmail(env, assignee.airtableEmail,
            `*Operations Director* assigned to you:\n` +
            `*${extraction.taskName}*\n` +
            `📍 ${property.name}\n` +
            `⚡ Priority: ${priority}`
        );
    } catch (e) {
        slackErrors.push(`assignee DM: ${e && e.message || e}`);
    }

    return respondJson(200, {
        ok: true,
        taskId: newTaskId,
        taskName: extraction.taskName,
        propertyName: property.name,
        businessName: businessRes.name,
        priority,
        assigneeName: assignee.name,
        slackWarnings: slackErrors.length ? slackErrors : undefined,
    });
}

// Posts a plain message to the given channel via Slack chat.postMessage.
// Used by the internal /create-task endpoint to mirror the channel-reply
// the Slack flow does in its confirmation path.
async function postSlackChannelMessage(env, channel, text) {
    if (!env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN not configured');
    const resp = await fetch(SLACK_POST_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, text }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(`Slack post failed: ${data.error}`);
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
        `You classify Slack messages from maintenance/property contractors.\n\n` +
        `Decision procedure (apply IN ORDER, take the first that fits):\n\n` +
        `1. Is the contractor describing THEIR OWN work activity — that they've started, finished, are stuck on, are waiting on parts for, are working on right now? → status_update\n` +
        `2. Is the contractor reporting that SOMETHING is broken / blocked / leaking / not working / damaged / needs fixing? → new_job (the THING is in that state; it's a fault to fix)\n` +
        `3. Is the contractor asking what's on their list / their workload / their jobs? → list_request\n` +
        `4. Otherwise → unknown\n\n` +
        `Important: words like "blocked", "broken", "leaking", "stopped", "not working" describe the OBJECT'S state — they almost always mean new_job. Only treat them as status_update when the SUBJECT is clearly the contractor themselves ("I'm blocked", "I'm stuck", "I'm waiting on parts").\n\n` +
        `Output JSON: {"reasoning": "one sentence on why", "label": "new_job" | "status_update" | "list_request" | "unknown"}\n\n` +
        `Examples:\n` +
        `  "boiler broken at 55 Elmdon" → {"reasoning": "boiler is in a broken state — fault report", "label": "new_job"}\n` +
        `  "blocked drain at 5 Woodcock" → {"reasoning": "drain is blocked — fault description, not contractor progress", "label": "new_job"}\n` +
        `  "tap leaking in kitchen" → {"reasoning": "tap is leaking — fault report", "label": "new_job"}\n` +
        `  "done with the boiler" → {"reasoning": "contractor announcing completion of their work", "label": "status_update"}\n` +
        `  "I'm stuck on the wiring" → {"reasoning": "contractor reporting own progress is blocked", "label": "status_update"}\n` +
        `  "waiting on parts" → {"reasoning": "contractor describing own work-in-progress state", "label": "status_update"}\n` +
        `  "what's on my list" → {"reasoning": "asking for their open jobs", "label": "list_request"}`;

    // Use Sonnet for this — Haiku gets confused by polysemous words like
    // "blocked" and consistently mis-routed fault reports as status updates.
    // Sonnet handles the fault-vs-progress distinction reliably. 50-token
    // call, runs once per inbound message — pennies.
    const raw = await callClaude(env, {
        model: env.AI_MODEL_DEFAULT,
        system,
        messages: [{ role: 'user', content: text }],
        maxTokens: 100,
    });
    let label = 'unknown';
    try {
        const parsed = JSON.parse((raw || '').trim().replace(/^```json\s*|\s*```$/g, ''));
        label = (parsed.label || '').trim().toLowerCase();
    } catch (e) {
        // Fall back to scanning the raw response for one of the known labels.
        const m = (raw || '').toLowerCase().match(/\b(new_job|status_update|list_request|unknown)\b/);
        if (m) label = m[1];
    }
    if (['new_job', 'status_update', 'list_request', 'unknown'].includes(label)) return label;
    return 'unknown';
}

// ─── HANDLER 1: NEW JOB ───────────────────────────────────────────────

// `override` lets resolvePending re-enter this handler with a property
// or assignee already chosen (so we don't ask twice).
//
// Assignee resolution:
//   1. Use override.resolvedAssignee if present (multi-turn flow).
//   2. Else use the AI-extracted assigneeHint mapped to a contractor
//      (handles "boiler at Elmdon, give it to Gary" from a team member).
//   3. Else if the sender is a contractor, assign to themselves.
//   4. Else (team member sender, no hint) — ask who.
async function handleNewJob(sender, text, evt, threadTs, env, override) {
    override = override || {};
    const extraction = override.extraction || await extractNewJobFields(text, env);

    // ── Step 1: resolve assignee (which contractor will own this task)
    let assignee = override.resolvedAssignee || null;
    if (!assignee && extraction.assigneeHint) {
        assignee = findContractorByFirstName(extraction.assigneeHint);
    }
    if (!assignee && sender.kind === 'contractor') {
        assignee = sender;
    }
    if (!assignee) {
        // Team-member sender with no explicit assignee in the message.
        // Ask, then resume on their reply.
        await setPendingState(env, evt.user, {
            kind: 'awaiting_assignee',
            originalMessage: text,
            extraction,
            eventTs: evt.ts,
        });
        return reply(threadTs, env,
            `Hi ${sender.firstName}, who should I assign this to?\n` +
            `Reply with one of: *Gary*, *Roy*, or *Rob*.`
        );
    }

    // ── Step 2: resolve property (existing logic, unchanged)
    let property = override.resolvedProperty || null;
    if (!property) {
        const matches = await matchProperty(extraction.propertyHint, env);
        if (matches.length === 0) {
            await setPendingState(env, evt.user, {
                kind: 'awaiting_property',
                originalMessage: text,
                extraction,
                resolvedAssignee: assignee, // remember the assignee we just resolved
                eventTs: evt.ts,
            });
            return reply(threadTs, env,
                `Thanks ${sender.firstName} — which property is that at? Reply with the name or address.`
            );
        }
        if (matches.length > 1) {
            const candidates = matches.slice(0, 5);
            await setPendingState(env, evt.user, {
                kind: 'awaiting_property_choice',
                originalMessage: text,
                extraction,
                resolvedAssignee: assignee,
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
    const senderIsAssignee = sender.kind === 'contractor'
        && sender.airtableEmail.toLowerCase() === assignee.airtableEmail.toLowerCase();
    // Per-contractor business resolution. Property linked here always means
    // hasResolvedProperty=true (we resolved one above). For Gary/Rob this is
    // always Real Estate; for Roy it depends on the description vocabulary.
    const businessRes = resolveBusinessId(assignee, !!property, text);

    // ── Step 3: ASK FOR CONFIRMATION before creating anything.
    //   Stash everything we'd need to actually create the task in KV;
    //   resolvePending('confirm_create') runs the actual write on yes.
    const fileCount = (evt.files && evt.files.length) || 0;
    const summaryLines = [
        senderIsAssignee
            ? `Just to confirm — should I log this${fileCount ? ` (and attach ${fileCount} file${fileCount > 1 ? 's' : ''})` : ''}?`
            : `Just to confirm — should I log this for ${assignee.firstName}${fileCount ? ` (and attach ${fileCount} file${fileCount > 1 ? 's' : ''})` : ''}?`,
        ``,
        `*${extraction.taskName}*`,
        `📍 ${property.name}`,
        `⚡ Priority: ${priority}`,
        `🏢 Business: ${businessRes.name}` + (businessRes.confident ? '' : ` _(if you wanted Operations Director, reply *no, ops* and I'll switch)_`),
        ``,
        `Reply *yes* to log it, *no* to cancel.`,
    ];
    await setPendingState(env, evt.user, {
        kind: 'confirm_create',
        // Everything we need to actually create the task on confirmation.
        // Stored as plain JSON in KV (no functions/non-serialisable values).
        plan: {
            taskName: extraction.taskName,
            description: text || '(uploaded file)',
            priority,
            propertyId: property.id,
            propertyName: property.name,
            businessId: businessRes.id,
            businessName: businessRes.name,
            assigneeEmail: assignee.airtableEmail,
            assigneeFirstName: assignee.firstName,
            collaboratorEmails: TEAM_COLLABORATOR_EMAILS
                .filter(e => e.toLowerCase() !== assignee.airtableEmail.toLowerCase()),
            files: evt.files || [], // re-ingested on confirmation
            messageTs: evt.ts,
            threadTs,
            senderIsAssignee,
            // Forward to assignee DM (resolved via email lookup at write time).
            assigneeAirtableEmail: assignee.airtableEmail,
        },
        eventTs: evt.ts,
    });
    return reply(threadTs, env, summaryLines.join('\n'));
}

// Called by resolvePending when the user answers "yes" to a confirm_create
// prompt. Performs the actual Airtable write, channel reply, and assignee DM.
async function executeConfirmedCreate(env, plan, threadTs) {
    const attachments = await ingestSlackFiles(env, plan.files, plan.messageTs);
    const fields = {
        [FIELD.taskName]:        plan.taskName,
        [FIELD.description]:     plan.description,
        [FIELD.status]:          'Upcoming',
        [FIELD.priority]:        plan.priority,
        [FIELD.assignee]:        { email: plan.assigneeEmail },
        [FIELD.properties]:      [plan.propertyId],
        [FIELD.business]:        [plan.businessId || BUSINESS_REAL_ESTATE_ID],
        [FIELD.maintenanceTick]: true,
        [FIELD.collaborators]:   plan.collaboratorEmails.map(email => ({ email })),
    };
    if (attachments.length) {
        fields[FIELD.attachments] = attachments;
    }

    const created = await createTask(env, fields);
    const newTaskId = created && created.records && created.records[0] && created.records[0].id;
    if (newTaskId) {
        await setThreadTask(env, threadTs, newTaskId);
    }

    const headerLine = plan.senderIsAssignee
        ? `✅ Logged, ${plan.assigneeFirstName}.`
        : `✅ Logged for ${plan.assigneeFirstName}.`;
    const channelLines = [
        headerLine,
        `*${plan.taskName}*`,
        `📍 ${plan.propertyName}`,
        `⚡ Priority: ${plan.priority}`,
    ];
    if (attachments.length) {
        channelLines.push(`📎 ${attachments.length} attachment${attachments.length > 1 ? 's' : ''}`);
    }
    channelLines.push(plan.senderIsAssignee ? `Added to your list.` : `Added to ${plan.assigneeFirstName}'s list.`);
    await reply(threadTs, env, channelLines.join('\n'));

    await dmUserByEmail(env, plan.assigneeAirtableEmail,
        `*Operations Director* assigned to you:\n` +
        `*${plan.taskName}*\n` +
        `📍 ${plan.propertyName}\n` +
        `⚡ Priority: ${plan.priority}`
    );
}

async function extractNewJobFields(text, env) {
    const system =
        `Extract structured fields from a Slack message about a new property/maintenance job.\n\n` +
        `Respond with ONLY valid JSON (no markdown, no code fences) matching:\n` +
        `{\n` +
        `  "taskName":     "short 3-7 word title, e.g. 'Fix boiler - no hot water'",\n` +
        `  "propertyHint": "the property name/address mentioned, or empty string",\n` +
        `  "priority":     "High Priority" or "Low Priority",\n` +
        `  "assigneeHint": "first name of the contractor to assign (Gary, Roy, or Rob), or empty string"\n` +
        `}\n\n` +
        `Priority:\n` +
        `  High Priority = health/safety risk, no heating/hot water, water leaks, structural,\n` +
        `                  security, electrical faults, gas, fire safety, flooding, sewage.\n` +
        `  Low Priority  = cosmetic, non-urgent, wear and tear, painting, external/garden.\n\n` +
        `Assignee hint — only fill this when the message EXPLICITLY says who to assign\n` +
        `the job to. Common patterns:\n` +
        `  "assign to Gary"          → "Gary"\n` +
        `  "give it to Roy"          → "Roy"\n` +
        `  "for Rob"                 → "Rob"\n` +
        `  "Gary can do this one"    → "Gary"\n` +
        `  "let's get Roy on it"     → "Roy"\n\n` +
        `Do NOT fill assigneeHint just because a contractor is mentioned in the body of\n` +
        `the description — e.g. "as discussed with Gary yesterday" doesn't mean assign\n` +
        `to Gary. Only fill it when the intent to assign is unmistakable. Empty string\n` +
        `if there's no explicit assignment.`;

    const raw = await callClaude(env, {
        system,
        messages: [{ role: 'user', content: text }],
        maxTokens: 250,
    });
    try {
        const parsed = JSON.parse(raw.trim().replace(/^```json\s*|\s*```$/g, ''));
        return {
            taskName:     parsed.taskName     || (text.slice(0, 60) || 'Untitled job'),
            propertyHint: parsed.propertyHint || '',
            priority:     parsed.priority     || 'Low Priority',
            assigneeHint: parsed.assigneeHint || '',
        };
    } catch (e) {
        return {
            taskName:     text.slice(0, 60) || 'Untitled job',
            propertyHint: '',
            priority:     'Low Priority',
            assigneeHint: '',
        };
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

async function handleStatusUpdate(sender, text, evt, threadTs, env, override) {
    override = override || {};
    const openTasks = override.openTasks || await fetchOpenTasksFor(sender, env);
    if (openTasks.length === 0) {
        return reply(threadTs, env,
            `${sender.firstName}, you don't have any open jobs right now.`
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
        // Treat "not matched" as ANY index outside the valid range, not
        // just -1. Claude has occasionally returned a stale or invented
        // index (e.g. 99 when there are 5 tasks) — without this guard
        // we'd dereference openTasks[99] and crash on `.taskName`.
        const inRange = Number.isInteger(match.matchedTaskIndex)
            && match.matchedTaskIndex >= 0
            && match.matchedTaskIndex < openTasks.length;
        if (!inRange) {
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
                `I can't tell which job you mean, ${sender.firstName}. Your open jobs:\n${list}\n` +
                `Reply with the number or job name.`
            );
        }
        target = openTasks[match.matchedTaskIndex];
        action = match.action;
        noteText = match.noteText;
    }

    // ASK FOR CONFIRMATION before any write. Stash plan in KV (including
    // any attached files for later ingestion). On "yes" the matching
    // execute helper runs the writes. The optional `files` block carries
    // Slack file metadata through KV; ingestSlackFiles is called only on
    // confirmation so we don't write unwanted files to R2.
    const propertyTag = target.propertyName ? ` — ${target.propertyName}` : '';
    const files = (evt.files || []);
    const fileCount = files.length;
    const fileSuffix = fileCount > 0
        ? ` (and attach ${fileCount} file${fileCount > 1 ? 's' : ''})`
        : '';
    const filePlan = fileCount > 0
        ? { files, messageTs: evt.ts }
        : null;

    if (action === 'completed') {
        await setPendingState(env, evt.user, {
            kind: 'confirm_complete',
            plan: {
                taskId: target.id,
                taskName: target.taskName,
                propertyName: target.propertyName || '',
                actorAirtableEmail: sender.airtableEmail,
                actorName: sender.name,
                attachmentPlan: filePlan,
            },
            eventTs: evt.ts,
        });
        return reply(threadTs, env,
            `Just to confirm — mark *${target.taskName}*${propertyTag} as completed${fileSuffix}?\n` +
            `Reply *yes* to mark it done, *no* to cancel.`
        );
    }
    if (action === 'in_progress') {
        await setPendingState(env, evt.user, {
            kind: 'confirm_in_progress',
            plan: { taskId: target.id, taskName: target.taskName, attachmentPlan: filePlan },
            eventTs: evt.ts,
        });
        return reply(threadTs, env,
            `Just to confirm — mark *${target.taskName}*${propertyTag} as in progress${fileSuffix}?\n` +
            `Reply *yes* to start it, *no* to cancel.`
        );
    }
    if (action === 'note') {
        const rawCommentText = noteText || text;
        const commentBody = `*${sender.firstName} via Slack*\n${rawCommentText}`;
        await setPendingState(env, evt.user, {
            kind: 'confirm_note',
            plan: {
                taskId: target.id,
                taskName: target.taskName,
                commentBody,
                commentText: rawCommentText,    // for the fan-out DM (without the "via Slack" prefix)
                commenterEmail: sender.airtableEmail, // skip self when fanning out
                attachmentPlan: filePlan,
            },
            eventTs: evt.ts,
        });
        return reply(threadTs, env,
            `Just to confirm — add this comment to *${target.taskName}*${propertyTag}${fileSuffix}?\n\n` +
            `> ${noteText || text}\n\n` +
            `Reply *yes* to add, *no* to cancel.`
        );
    }
    return reply(threadTs, env, `I caught your message but wasn't sure what to do with it.`);
}

// Helpers called by resolvePending after the user answers "yes" to a
// confirmation prompt. Each performs the actual Airtable write + reply.

async function executeConfirmedComplete(env, plan, threadTs) {
    await updateTask(env, plan.taskId, { [FIELD.status]: 'Completed' });
    const attachedCount = await maybeAppendAttachments(env, plan.taskId, plan.attachmentPlan);
    const firstName = (plan.actorName || '').split(' ')[0] || 'there';
    const attachLine = attachedCount > 0
        ? `📎 ${attachedCount} attachment${attachedCount > 1 ? 's' : ''} added.\n`
        : '';
    await reply(threadTs, env,
        `✅ Marked complete: *${plan.taskName}*. Nice one ${firstName}.\n${attachLine}`.trim()
    );
    await dmTeamExcept(env, plan.actorAirtableEmail,
        `*${plan.actorName}* completed a task you collaborate on:\n` +
        `*${plan.taskName}*` +
        (plan.propertyName ? `\n📍 ${plan.propertyName}` : '')
    );
}

async function executeConfirmedInProgress(env, plan, threadTs) {
    await updateTask(env, plan.taskId, { [FIELD.status]: 'Today' });
    const attachedCount = await maybeAppendAttachments(env, plan.taskId, plan.attachmentPlan);
    const attachLine = attachedCount > 0
        ? ` (📎 ${attachedCount} attachment${attachedCount > 1 ? 's' : ''} added)`
        : '';
    await reply(threadTs, env, `👍 Got it — *${plan.taskName}* is now in progress${attachLine}.`);
}

async function executeConfirmedNote(env, plan, threadTs) {
    await addComment(env, plan.taskId, plan.commentBody);
    const attachedCount = await maybeAppendAttachments(env, plan.taskId, plan.attachmentPlan);
    const attachLine = attachedCount > 0
        ? ` (📎 ${attachedCount} attachment${attachedCount > 1 ? 's' : ''} added)`
        : '';
    await reply(threadTs, env, `💬 Comment added to *${plan.taskName}*${attachLine}.`);
    // Mirror the dashboard's notifyCollabsOnComment fan-out: when a
    // comment lands on a task, every collaborator on that task plus the
    // assignee gets a Slack DM with the comment text — except whoever
    // wrote it. Without this, Slack-added comments are invisible to the
    // office team unless they refresh the dashboard. Best-effort: a
    // failure to fan out shouldn't fail the comment itself, which has
    // already been written above.
    try {
        await fanOutCommentDM(env, plan.taskId, plan.commenterEmail, plan.commentText, plan.taskName);
    } catch (err) {
        console.error('fanOutCommentDM failed (non-blocking):', err && err.stack || err);
    }
}

// Fans out a "comment on a task you collaborate on" Slack DM to every
// collaborator + assignee on the task, skipping the commenter. Reads
// the task fresh from Airtable so the collab list is current.
async function fanOutCommentDM(env, taskId, commenterEmail, commentText, taskName) {
    if (!env.SLACK_BOT_TOKEN) return;
    // Fetch the task's collaborators + assignee. Airtable's single-record
    // GET endpoint returns ALL fields and rejects requests that include a
    // `fields[]` selector with HTTP 422 — fields[] is only valid on the
    // list endpoint. Just read the whole record and pluck what we need.
    const url = `/${TABLE_TASKS}/${taskId}?returnFieldsByFieldId=true`;
    let recipients = new Set();
    try {
        const got = await airtable(env, 'GET', url);
        const collabs = (got && got.fields && got.fields[FIELD.collaborators]) || [];
        const assignee = got && got.fields && got.fields[FIELD.assignee];
        for (const c of collabs) {
            if (c && c.email) recipients.add(c.email.toLowerCase());
        }
        if (assignee && assignee.email) recipients.add(assignee.email.toLowerCase());
    } catch (e) {
        console.error('fanOutCommentDM: read task failed:', e && e.stack || e);
        return;
    }
    if (commenterEmail) recipients.delete(commenterEmail.toLowerCase());
    if (recipients.size === 0) return;

    // Reuse the local dispatchCommentDm helper — same DM format the
    // dashboard's slack-notify worker would produce, but called direct
    // from this worker. We can NOT call slack-notify worker-to-worker
    // (Cloudflare returns error 1042 on `*.workers.dev` cross-worker
    // fetches), so we replicate the format inline.
    for (const email of recipients) {
        const slackEmail = commentSlackEmailFor(email);
        try {
            await dispatchCommentDm(env, slackEmail, {
                taskName: taskName || '(no name)',
                taskId,
                actorName: '(via Slack)',
                commentText: String(commentText || '').slice(0, 500),
            });
        } catch (e) {
            console.error(`fanOutCommentDM: DM dispatch failed for ${email}:`, e && e.stack || e);
        }
    }
}

// Standalone-photo execute: just appends the files to the task's
// Attachments field. Used when the contractor uploads a photo without
// any other action (no completion, no comment text).
async function executeConfirmedAttach(env, plan, threadTs) {
    const attachedCount = await maybeAppendAttachments(env, plan.taskId, plan.attachmentPlan);
    if (attachedCount === 0) {
        return reply(threadTs, env, `Hmm, I couldn't read the file from Slack. Try uploading again?`);
    }
    await reply(threadTs, env,
        `📎 ${attachedCount} file${attachedCount > 1 ? 's' : ''} attached to *${plan.taskName}*.`
    );
}

// Ingests Slack files (R2 upload) and APPENDS them to the task's existing
// Attachments — Airtable PATCH on attachment fields REPLACES by default,
// so we fetch the current attachments first and merge. Returns the number
// of files actually added (0 if the plan is null/empty).
//
// SAFETY: if the existing-attachments read fails for any reason we throw
// rather than continue. Continuing with `existing = []` would silently
// destroy any prior photos on the task — that bug is exactly what an
// "append" function must not do. The caller already has a try/catch and
// reports a generic "something went wrong" to the contractor, who can
// retry from the dashboard if needed.
async function maybeAppendAttachments(env, taskId, attachmentPlan) {
    if (!attachmentPlan || !attachmentPlan.files || attachmentPlan.files.length === 0) return 0;
    const newAttachments = await ingestSlackFiles(env, attachmentPlan.files, attachmentPlan.messageTs);
    if (newAttachments.length === 0) return 0;
    // Read existing attachments first — letting GET errors propagate so a
    // failed read never leads to a destructive PATCH.
    const url = `/${TABLE_TASKS}/${taskId}?returnFieldsByFieldId=true&fields%5B%5D=${FIELD.attachments}`;
    const got = await airtable(env, 'GET', url);
    const existing = (got && got.fields && got.fields[FIELD.attachments]) || [];
    const merged = [
        ...existing.map(a => ({ id: a.id })), // preserve existing by id only
        ...newAttachments,                    // add new (objects with url)
    ];
    await updateTask(env, taskId, { [FIELD.attachments]: merged });
    return newAttachments.length;
}

async function matchStatusUpdate(text, openTasks, env) {
    const taskList = openTasks.map((t, i) =>
        `${i}: ${t.taskName}${t.propertyName ? ' — ' + t.propertyName : ''}`
    ).join('\n');

    const system =
        `Someone has sent a Slack message about a job (could be the contractor doing\n` +
        `the work or a team member updating on their behalf). Match it to one of the\n` +
        `open jobs below and classify the action.\n\n` +
        `OPEN JOBS:\n${taskList}\n\n` +
        `Action rules:\n` +
        `  - "completed" → the work itself is finished. The sender says "done", "finished",\n` +
        `    "all sorted", "complete". Strong signal that the task can be closed.\n` +
        `  - "in_progress" → the contractor THEMSELVES is starting / actively doing /\n` +
        `    en route to the work. The sender's verb is about doing the job:\n` +
        `    "started", "on my way", "fixing it now", "I'm working on", "I've begun".\n` +
        `  - "note" → DEFAULT for everything else: relayed information, observations,\n` +
        `    tenant feedback, scheduling chats, access details, supplier updates,\n` +
        `    parts ETAs, anything that should be recorded against the job but is NOT\n` +
        `    the contractor declaring they're starting or finishing the physical work.\n\n` +
        `Important: "tenant says/feels/is/messaged…", "FYI…", "heads up…", "update…",\n` +
        `"keysafe code…", "they're happy to wait" → ALWAYS "note". The subject is the\n` +
        `tenant or the situation, not the contractor's own work activity. Pick\n` +
        `"in_progress" only when the SUBJECT of the verb is the contractor (or "I").\n\n` +
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

async function handleListRequest(sender, threadTs, env) {
    const tasks = await fetchOpenTasksFor(sender, env);
    if (tasks.length === 0) {
        return reply(threadTs, env, `✨ Nothing on your list, ${sender.firstName}. All clear.`);
    }
    const lines = tasks.map((t, i) => {
        const pri = t.priority === 'Urgent' ? ' 🔴' : '';
        const prop = t.propertyName ? ` — ${t.propertyName}` : '';
        return `${i + 1}. *${t.taskName}*${prop}${pri}`;
    });
    return reply(threadTs, env,
        `${sender.firstName}, here's your list (${tasks.length}):\n${lines.join('\n')}`
    );
}

// ─── HANDLER 4: STANDALONE PHOTO ATTACHMENT ───────────────────────────
//
// Triggered when the contractor uploads a photo (or other file) without
// describing a new job and without an obvious status-update intent. The
// photo needs to be attached to one of their existing open tasks, but
// we don't yet know which one. We try in order:
//   1. Thread context — if they replied to a known task's thread.
//   2. AI matching against the surrounding text (if any) + open tasks.
//   3. Ask explicitly with a numbered list of open jobs.
// Followed always by a yes/no confirmation before the actual attach.
async function handleAttachPhoto(sender, text, evt, threadTs, env, override) {
    override = override || {};
    const openTasks = override.openTasks || await fetchOpenTasksFor(sender, env);
    if (openTasks.length === 0) {
        return reply(threadTs, env,
            `${sender.firstName}, you don't have any open jobs to attach this to. ` +
            `Log a new job first by describing what's wrong and where.`
        );
    }

    let target = override.resolvedTask || null;

    // 1. Try thread context first — if this photo is a reply in a thread
    //    that the bot logged a task in, we can target that task directly.
    if (!target && evt.thread_ts) {
        const threadTaskId = await getThreadTask(env, evt.thread_ts);
        if (threadTaskId) {
            target = openTasks.find(t => t.id === threadTaskId) || null;
        }
    }

    // 2. If text is non-trivial, ask Claude to match it across open tasks.
    if (!target && text && text.length > 2) {
        const match = await matchStatusUpdate(text, openTasks, env);
        const inRange = Number.isInteger(match.matchedTaskIndex)
            && match.matchedTaskIndex >= 0
            && match.matchedTaskIndex < openTasks.length;
        if (inRange) {
            target = openTasks[match.matchedTaskIndex];
        }
    }

    // 3. Couldn't match — ask the contractor which job. List their
    //    open tasks; their reply (number or job name) resolves it.
    if (!target) {
        await setPendingState(env, evt.user, {
            kind: 'awaiting_attach_task_choice',
            taskIds: openTasks.map(t => t.id),
            // Persist the file metadata so we can run the attach on resume.
            attachmentPlan: { files: evt.files || [], messageTs: evt.ts },
            eventTs: evt.ts,
        });
        const list = openTasks.map((t, i) =>
            `${i + 1}. ${t.taskName}${t.propertyName ? ' — ' + t.propertyName : ''}`
        ).join('\n');
        const fileCount = (evt.files && evt.files.length) || 0;
        return reply(threadTs, env,
            `Got the file${fileCount > 1 ? 's' : ''}. Which job should I attach ` +
            `${fileCount > 1 ? 'them' : 'it'} to, ${sender.firstName}?\n${list}\n` +
            `Reply with the number or job name.`
        );
    }

    // We know the target — ask for confirmation, then attach.
    const fileCount = (evt.files && evt.files.length) || 0;
    const propertyTag = target.propertyName ? ` — ${target.propertyName}` : '';
    await setPendingState(env, evt.user, {
        kind: 'confirm_attach',
        plan: {
            taskId: target.id,
            taskName: target.taskName,
            attachmentPlan: { files: evt.files || [], messageTs: evt.ts },
        },
        eventTs: evt.ts,
    });
    return reply(threadTs, env,
        `Just to confirm — attach ${fileCount === 1 ? 'this file' : `these ${fileCount} files`} to *${target.taskName}*${propertyTag}?\n` +
        `Reply *yes* to attach, *no* to cancel.`
    );
}

// ─── MULTI-TURN: pending-state resolution ─────────────────────────────

async function resolvePending(sender, text, pending, evt, threadTs, env) {
    // Optimistic clear — if the resolution fails we re-store below.
    await clearPendingState(env, evt.user);

    // CONFIRMATION FLOWS — every write goes through one of these. The
    // user replies "yes" / "no" to a previously-sent summary; on yes we
    // run the action helpers, on no we cancel cleanly, otherwise re-ask.
    if (
        pending.kind === 'confirm_create' ||
        pending.kind === 'confirm_complete' ||
        pending.kind === 'confirm_in_progress' ||
        pending.kind === 'confirm_note' ||
        pending.kind === 'confirm_attach'
    ) {
        // Special case for confirm_create only: "no, ops" / "no, operations"
        // overrides the suggested business to Operations Director and
        // proceeds with the write. Lets the user fix an ambiguous Roy
        // classification without restarting the whole flow.
        if (pending.kind === 'confirm_create' && /\b(no|n)\b[\s,]*\b(ops|operations)\b/i.test(text)) {
            try {
                const overriddenPlan = {
                    ...pending.plan,
                    businessId: BUSINESS_OPS_DIRECTOR_ID,
                    businessName: 'Operations Director',
                };
                await reply(threadTs, env, `Switching business to *Operations Director* and logging…`);
                await executeConfirmedCreate(env, overriddenPlan, threadTs);
            } catch (err) {
                console.error('confirm execute (override-ops) failed:', err && err.stack || err);
                await reply(threadTs, env,
                    `Something went wrong on my end while saving that. Please try again or use the dashboard.`
                );
            }
            return;
        }

        const answer = parseYesNo(text);
        if (answer === null) {
            await setPendingState(env, evt.user, pending);
            return reply(threadTs, env,
                `Sorry, I didn't catch that — reply *yes* to go ahead, *no* to cancel.`
            );
        }
        if (answer === 'no') {
            return reply(threadTs, env, `Cancelled — nothing changed. Send a fresh message any time.`);
        }
        // yes — execute the appropriate action.
        try {
            if (pending.kind === 'confirm_create')      await executeConfirmedCreate(env, pending.plan, threadTs);
            if (pending.kind === 'confirm_complete')    await executeConfirmedComplete(env, pending.plan, threadTs);
            if (pending.kind === 'confirm_in_progress') await executeConfirmedInProgress(env, pending.plan, threadTs);
            if (pending.kind === 'confirm_note')        await executeConfirmedNote(env, pending.plan, threadTs);
            if (pending.kind === 'confirm_attach')      await executeConfirmedAttach(env, pending.plan, threadTs);
        } catch (err) {
            console.error(`confirm execute (${pending.kind}) failed:`, err && err.stack || err);
            await reply(threadTs, env,
                `Something went wrong on my end while saving that. Please try again or use the dashboard.`
            );
        }
        return;
    }

    // Standalone-photo flow: contractor sent a file without context, the
    // bot asked which open job to attach it to. Their reply (number or
    // job name) resolves the target — then we ask for the yes/no confirm.
    if (pending.kind === 'awaiting_attach_task_choice') {
        const openTasks = await fetchOpenTasksFor(sender, env);
        const candidates = openTasks.filter(t => pending.taskIds.includes(t.id));
        const chosen = pickFromCandidates(text, candidates, t => t.taskName);
        if (!chosen) {
            await setPendingState(env, evt.user, pending);
            return reply(threadTs, env,
                `That didn't match any of your open jobs. Try the number or the job name.`
            );
        }
        // Re-enter handleAttachPhoto with the chosen task as override + the
        // remembered files. Reusing the handler keeps the confirmation
        // prompt format consistent with the direct path.
        return handleAttachPhoto(
            sender, '', // text empty here — the photo is the payload
            { ...evt, files: pending.attachmentPlan.files, ts: pending.attachmentPlan.messageTs },
            threadTs, env,
            { openTasks, resolvedTask: chosen }
        );
    }

    // NEW: team-member supplied the assignee for a job.
    if (pending.kind === 'awaiting_assignee') {
        const assignee = findContractorByFirstName(text);
        if (!assignee) {
            await setPendingState(env, evt.user, pending);
            return reply(threadTs, env,
                `I don't know who that is. Reply with one of: *Gary*, *Roy*, or *Rob*.`
            );
        }
        return handleNewJob(
            sender, pending.originalMessage, evt, threadTs, env,
            { extraction: pending.extraction, resolvedAssignee: assignee }
        );
    }

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
            sender, pending.originalMessage, evt, threadTs, env,
            {
                extraction: pending.extraction,
                resolvedProperty: matches[0],
                resolvedAssignee: pending.resolvedAssignee, // preserve through the flow
            }
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
            sender, pending.originalMessage, evt, threadTs, env,
            {
                extraction: pending.extraction,
                resolvedProperty: chosen,
                resolvedAssignee: pending.resolvedAssignee,
            }
        );
    }

    if (pending.kind === 'awaiting_task_choice') {
        const openTasks = await fetchOpenTasksFor(sender, env);
        const candidates = openTasks.filter(t => pending.taskIds.includes(t.id));
        const chosen = pickFromCandidates(text, candidates, t => t.taskName);
        if (!chosen) {
            await setPendingState(env, evt.user, pending);
            return reply(threadTs, env,
                `That didn't match any of your open jobs. Try the number or the job name.`
            );
        }
        const match = await matchStatusUpdate(pending.originalMessage, [chosen], env);
        return handleStatusUpdate(
            sender, pending.originalMessage, evt, threadTs, env,
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

// Parses a contractor's reply to a confirmation prompt as 'yes' / 'no' /
// null (didn't understand). Tolerant of surrounding text + Slack's
// auto-appended "Sent using @Claude" footer.
//
// Deliberately conservative on the "no" side: words like "don't",
// "skip", "wrong" are NOT treated as cancels on their own, because
// they're easy false-positives ("I don't know", "let me skip ahead",
// "that's wrong, the property is X"). Better to ask again than to
// cancel a contractor's intent because of an off-hand phrase. They
// can always type a clean "no" or "cancel" to back out.
function parseYesNo(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(yes|y|yeah|yep|yup|sure|confirm|confirmed|correct|go ahead|do it|ok|okay|👍)\b/.test(t)) return 'yes';
    if (/\b(no|n|nope|nah|cancel)\b/.test(t)) return 'no';
    if (/👎/.test(t)) return 'no';
    return null;
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

// DM by Airtable email — useful when we have the assignee's record but
// not their Slack user ID (e.g. when a team member assigns a job to a
// contractor we need to DM). Falls back silently if the email doesn't
// resolve to a Slack user.
async function dmUserByEmail(env, email, text) {
    const slackEmail = commentSlackEmailFor(email); // honour Gary's slackEmail override
    const userId = await lookupSlackUserByEmail(env, slackEmail);
    if (!userId) {
        console.error(`dmUserByEmail: no Slack user for ${slackEmail} (Airtable: ${email})`);
        return false;
    }
    return dmUser(env, userId, text);
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

async function fetchOpenTasksFor(sender, env) {
    const fields = [
        FIELD.taskName, FIELD.status, FIELD.priority,
        FIELD.properties, FIELD.notes, FIELD.maintenanceTick,
    ];
    // Pool of open tasks the sender can act on:
    //   - Contractor: tasks where they're the Assignee. Anything assigned
    //     to them is contractor work by definition (maintenance, gardening,
    //     callouts, anything). Do NOT additionally filter by Maintenance
    //     Ticket — that would over-narrow and hide non-maintenance work.
    //   - Team member: tasks where they're the Assignee OR a Collaborator.
    //     Because the bot auto-adds Kevin/Mica/Erica as collaborators on
    //     every contractor task, this pool covers every open contractor
    //     task plus the team member's own work — letting them comment on,
    //     complete, or attach photos to any of them via Slack.
    const safeName = escapeFormula(sender.name);
    const formula = sender.kind === 'team'
        ? `AND(` +
              `{Status}!='Completed',` +
              `OR(` +
                  `{Assignee}='${safeName}',` +
                  `FIND('${safeName}', ARRAYJOIN({Collaborators}, ','))` +
              `)` +
          `)`
        : `AND(` +
              `{Status}!='Completed',` +
              `{Assignee}='${safeName}'` +
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

async function callClaude(env, { system, messages, maxTokens, model }) {
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
            model: model || env.AI_MODEL_LIGHT,
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
