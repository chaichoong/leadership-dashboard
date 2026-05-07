// slack-notify worker — outbound DM dispatch from the web app.
//
// Body: { recipientEmail, taskName, taskId, actorName, action, commentText? }
// action: 'assigned' | 'reassigned' | 'completed' | 'comment' | 'lookup-only'
//
// INBOUND (Slack thread replies → Airtable comments) is handled by the
// SEPARATE contractor-bot worker at /Users/.../scripts/slack-automation/
// contractor-bot.js — that's where Slack's Event Subscriptions URL points.
// Two workers, one Slack app: the URL goes to contractor-bot, which
// branches based on event.channel_type to handle both DM thread replies
// AND the contractor channel flow it was originally written for.
//
// ─── ENV / SECRETS ────────────────────────────────────────────────────
//
//   SLACK_BOT_TOKEN        xoxb-… token. Scopes:
//                            chat:write, users:read, users:read.email,
//                            im:history, im:read
//   SLACK_SIGNING_SECRET   from Slack app → Basic Information → Signing Secret
//   ALLOWED_ORIGIN         e.g. https://chaichoong.github.io  (or "*")
//   AIRTABLE_PAT           pat_… Personal Access Token. Scopes:
//                            data.records:read (Tasks),
//                            data.recordComments:read,
//                            data.recordComments:write
//   AIRTABLE_BASE_ID       appnqjDpqDniH3IRl
//   AIRTABLE_TASKS_TABLE   tblqB8b22hKBL4PF1
//
// ─────────────────────────────────────────────────────────────────────

// TEAM map — kept in sync with the web app's TEAM constant. slackEmail
// override applies to members whose Slack-registered email differs from
// their Airtable collaborator email.
const TEAM = [
    { name: 'Kevin Brittain',   email: 'kevin@runpreneur.org.uk' },
    { name: 'Mica Albovias',    email: 'micaa.work@gmail.com' },
    { name: 'Ericamae Atenta',  email: 'atentaerica@gmail.com' },
    { name: 'Gary Marsh',       email: 'gkm.property.maintenance@outlook.com', slackEmail: 'roofline@outlook.com' },
    { name: 'Rob Jackson',      email: 'rjm320@hotmail.com' },
    { name: 'Roy Lavin',        email: 'roy.lavin1978@gmail.com' },
];
function slackEmailFor(email) {
    if (!email) return email;
    const m = TEAM.find(t => t.email.toLowerCase() === email.toLowerCase());
    return (m && m.slackEmail) || email;
}
export default {
    async fetch(request, env) {
        return handleNotify(request, env);
    }
};

// ════════════════════════════════════════════════════════════════════
// OUTBOUND: web app → Slack DM
// ════════════════════════════════════════════════════════════════════

async function handleNotify(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || '*';
    const corsHeaders = {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405, corsHeaders);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Invalid JSON' }, 400, corsHeaders); }

    const { recipientEmail, taskName, taskId, actorName, action, commentText } = body || {};
    if (!recipientEmail || !taskName) {
        return json({ error: 'recipientEmail and taskName are required' }, 400, corsHeaders);
    }
    const cleanName = String(taskName).trim();
    if (!cleanName || cleanName === '(Untitled)') {
        return json({ error: 'Task name placeholder rejected (was "' + cleanName + '").' }, 400, corsHeaders);
    }

    const token = env.SLACK_BOT_TOKEN;
    if (!token) return json({ error: 'SLACK_BOT_TOKEN not configured' }, 500, corsHeaders);

    const lookupRes = await fetch(
        'https://slack.com/api/users.lookupByEmail?email=' + encodeURIComponent(recipientEmail),
        { headers: { Authorization: 'Bearer ' + token } }
    );
    const lookup = await lookupRes.json();
    if (!lookup.ok) {
        return json({ error: 'Slack lookup failed: ' + lookup.error, recipientEmail }, 502, corsHeaders);
    }
    const userId = lookup.user && lookup.user.id;
    if (!userId) return json({ error: 'No Slack user for that email' }, 404, corsHeaders);

    if (action === 'lookup-only') {
        return json({ ok: true, lookupOnly: true, userId, recipientEmail }, 200, corsHeaders);
    }

    let verb;
    if (action === 'completed') verb = 'completed a task you collaborate on';
    else if (action === 'reassigned') verb = 'reassigned to you';
    else if (action === 'comment') verb = 'left a comment on a task you collaborate on';
    else verb = 'assigned to you';
    const headerLine = actorName
        ? '*' + escapeMrkdwn(actorName) + '* ' + verb + ':'
        : 'A task was ' + verb + ':';

    const cleanComment = commentText ? String(commentText).trim().slice(0, 500) : '';
    const commentTail = (action === 'comment' && cleanComment)
        ? '\n\n> ' + escapeMrkdwn(cleanComment).split('\n').join('\n> ')
        : '';
    const text = headerLine + '\n\n• ' + escapeMrkdwn(cleanName) + commentTail;
    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: headerLine } },
        { type: 'section', text: { type: 'mrkdwn', text: '*' + escapeMrkdwn(cleanName) + '*' } },
    ];
    if (action === 'comment' && cleanComment) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '> ' + escapeMrkdwn(cleanComment).split('\n').join('\n> ') },
        });
    }
    if (taskId) {
        // Reply hint + machine-readable Task ID. The hint is human-friendly;
        // the Task ID is parsed by the events handler when someone replies.
        blocks.push({
            type: 'context',
            elements: [
                { type: 'mrkdwn', text: '💬 Reply in this thread to add a comment on the task.' },
                { type: 'mrkdwn', text: 'Task ID: `' + escapeMrkdwn(taskId) + '`' },
            ],
        });
    }

    const postRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: userId, text, blocks }),
    });
    const post = await postRes.json();
    if (!post.ok) {
        return json({ error: 'Slack post failed: ' + post.error }, 502, corsHeaders);
    }

    return json({ ok: true, channel: post.channel, ts: post.ts }, 200, corsHeaders);
}

// ════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ════════════════════════════════════════════════════════════════════

function json(obj, status, corsHeaders) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...(corsHeaders || {}) },
    });
}
function escapeMrkdwn(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
