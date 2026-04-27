// notify-slack-worker.js — Cloudflare Worker route for task-assignment Slack notifications.
//
// Deploy as one route on the existing claude-proxy worker (or any worker).
// Web app fires fire-and-forget POSTs to this endpoint after every task
// create / assignee change so the assignee gets a Slack DM.
//
// PORTABILITY: identical code runs as a Supabase Edge Function. To migrate,
// copy the handler body into supabase/functions/notify-slack/index.ts,
// move the secrets from `wrangler secret put` to `supabase secrets set`,
// and update the web app's fetch URL.
//
// ─── ENV / SECRETS ────────────────────────────────────────────────────
//
//   SLACK_BOT_TOKEN  — xoxb-… token from your Slack app's "OAuth & Permissions"
//                      Required scopes: chat:write, users:read, users:read.email
//   ALLOWED_ORIGIN   — e.g. https://chaichoong.github.io (or "*" for any)
//
// ─── REQUEST ──────────────────────────────────────────────────────────
//
//   POST /notify-slack
//   Content-Type: application/json
//   {
//     "recipientEmail": "atentaerica@gmail.com",  // assignee
//     "taskName":       "Send the rent statement",
//     "taskId":         "recXYZ…",
//     "actorName":      "Kevin Brittain",         // who did the assigning
//     "action":         "assigned"                // or "reassigned"
//   }
//
//   Returns 200 { ok: true } on success, 4xx / 5xx with { error } on failure.
//   Caller should ignore failures — notifications never block the user save.
//
// ─── INTEGRATION ──────────────────────────────────────────────────────
// Inside your existing Worker's fetch handler:
//
//   if (url.pathname === '/notify-slack' && request.method === 'POST') {
//       return handleNotifySlack(request, env);
//   }
//
// Then paste this whole file beneath that handler.
// ─────────────────────────────────────────────────────────────────────

export async function handleNotifySlack(request, env) {
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

    const { recipientEmail, taskName, taskId, actorName, action } = body || {};
    if (!recipientEmail || !taskName) {
        return json({ error: 'recipientEmail and taskName are required' }, 400, corsHeaders);
    }

    const token = env.SLACK_BOT_TOKEN;
    if (!token) return json({ error: 'SLACK_BOT_TOKEN not configured' }, 500, corsHeaders);

    // 1. Resolve email → Slack user ID
    const lookupRes = await fetch(
        `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(recipientEmail)}`,
        { headers: { Authorization: `Bearer ${token}` } }
    );
    const lookup = await lookupRes.json();
    if (!lookup.ok) {
        return json(
            { error: `Slack lookup failed: ${lookup.error}`, recipientEmail },
            502,
            corsHeaders
        );
    }
    const userId = lookup.user && lookup.user.id;
    if (!userId) return json({ error: 'No Slack user for that email' }, 404, corsHeaders);

    // 2. Open / reuse a DM channel and post the message
    const verb = action === 'reassigned' ? 'reassigned to you' : 'assigned to you';
    const headerLine = actorName
        ? `*${escapeMrkdwn(actorName)}* ${verb} a task:`
        : `A task was ${verb}:`;
    const text = `${headerLine}\n\n• ${escapeMrkdwn(taskName)}`;
    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: headerLine } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${escapeMrkdwn(taskName)}*` } },
    ];
    if (taskId) {
        blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `Task ID: \`${escapeMrkdwn(taskId)}\`` }],
        });
    }

    const postRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: userId, text, blocks }),
    });
    const post = await postRes.json();
    if (!post.ok) {
        return json({ error: `Slack post failed: ${post.error}` }, 502, corsHeaders);
    }

    return json({ ok: true, channel: post.channel, ts: post.ts }, 200, corsHeaders);
}

function json(obj, status, corsHeaders) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
}

// Slack mrkdwn escaping — we don't want a stray <, >, or & to break formatting.
function escapeMrkdwn(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
