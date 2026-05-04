// slack-notify worker — Slack ⇄ Tasks bridge.
//
// TWO endpoints:
//
// 1. POST /  (root)
//    Outbound DM dispatch from the web app.
//    Body: { recipientEmail, taskName, taskId, actorName, action, commentText? }
//    action: 'assigned' | 'reassigned' | 'completed' | 'comment' | 'lookup-only'
//
// 2. POST /slack-events
//    Inbound Slack Events API webhook (URL verification + threaded DM replies).
//    A user replies in the THREAD of a comment-DM → we post their reply as
//    a comment on the Airtable task, then fan out new-comment DMs to every
//    other collaborator.
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
function teamLookupByAirtableEmail(email) {
    if (!email) return null;
    return TEAM.find(t => t.email.toLowerCase() === email.toLowerCase()) || null;
}
// Reverse: given the Slack email a user posted from, find the matching
// TEAM record. Used to attribute incoming Slack replies to a TEAM member.
function teamLookupBySlackEmail(slackEmail) {
    if (!slackEmail) return null;
    const lc = slackEmail.toLowerCase();
    return TEAM.find(t =>
        t.email.toLowerCase() === lc ||
        (t.slackEmail && t.slackEmail.toLowerCase() === lc)
    ) || null;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/slack-events') {
            return handleSlackEvents(request, env);
        }
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
// INBOUND: Slack thread reply → Airtable comment + fan-out
// ════════════════════════════════════════════════════════════════════

async function handleSlackEvents(request, env) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const rawBody = await request.text();

    // 1. Verify Slack request signature.
    const valid = await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET);
    if (!valid) return new Response('Invalid signature', { status: 401 });

    let body;
    try { body = JSON.parse(rawBody); }
    catch { return new Response('Bad JSON', { status: 400 }); }

    // 2. URL verification handshake (initial setup with Slack).
    if (body.type === 'url_verification') {
        return new Response(body.challenge, { headers: { 'Content-Type': 'text/plain' } });
    }

    // 3. Real event. Acknowledge fast (Slack expects 200 within 3s) — do
    //    the work async via waitUntil so the bot doesn't get retried.
    if (body.type === 'event_callback' && body.event) {
        const ev = body.event;
        // Only handle threaded user message replies in DMs.
        if (ev.type === 'message'
            && ev.channel_type === 'im'
            && ev.thread_ts
            && !ev.bot_id
            && !ev.subtype // skip edits, deletions, etc.
            && ev.user
            && ev.text) {
            // Process in the background; respond 200 immediately.
            // (Cloudflare Workers expose ctx.waitUntil via the third arg in
            //  the modern signature, but we're using the simpler fetch
            //  signature — fire-and-forget the promise. Slack will retry
            //  if we return non-2xx, so we MUST return 200 even if the
            //  Airtable side fails.)
            handleThreadReply(ev, env).catch(err => console.error('[slack-events] thread reply failed', err));
        }
    }
    return new Response('', { status: 200 });
}

async function handleThreadReply(event, env) {
    const slackToken = env.SLACK_BOT_TOKEN;
    const airtablePat = env.AIRTABLE_PAT;
    const baseId = env.AIRTABLE_BASE_ID;
    const tasksTable = env.AIRTABLE_TASKS_TABLE;
    if (!slackToken || !airtablePat || !baseId || !tasksTable) {
        console.error('[slack-events] missing env', { slackToken: !!slackToken, airtablePat: !!airtablePat, baseId: !!baseId, tasksTable: !!tasksTable });
        return;
    }

    // 1. Look up the parent message — find the embedded Task ID.
    const parentRes = await fetch(
        `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(event.channel)}&ts=${encodeURIComponent(event.thread_ts)}&limit=1`,
        { headers: { Authorization: 'Bearer ' + slackToken } }
    );
    const parent = await parentRes.json();
    if (!parent.ok || !parent.messages || !parent.messages.length) {
        console.warn('[slack-events] could not fetch parent message', parent.error || parent);
        return;
    }
    const parentMsg = parent.messages[0];
    const taskId = extractTaskIdFromMessage(parentMsg);
    if (!taskId) {
        console.warn('[slack-events] no Task ID in parent message — ignoring', parentMsg.ts);
        return;
    }

    // 2. Resolve the Slack user who posted → Airtable email + display name.
    const userInfoRes = await fetch(
        'https://slack.com/api/users.info?user=' + encodeURIComponent(event.user),
        { headers: { Authorization: 'Bearer ' + slackToken } }
    );
    const userInfo = await userInfoRes.json();
    if (!userInfo.ok) {
        console.warn('[slack-events] users.info failed', userInfo.error);
        return;
    }
    const slackEmail = userInfo.user && userInfo.user.profile && userInfo.user.profile.email;
    const slackDisplayName = userInfo.user && userInfo.user.real_name;
    const teamMember = teamLookupBySlackEmail(slackEmail);
    const actorName = (teamMember && teamMember.name) || slackDisplayName || slackEmail || 'Slack user';
    const actorAirtableEmail = (teamMember && teamMember.email) || slackEmail || '';

    // 3. Strip Slack mrkdwn/quotes/zero-widths from the reply text.
    const replyText = cleanSlackText(event.text);
    if (!replyText) return;

    // 4. Post as a comment on the Airtable task.
    //    PAT comments default to the PAT-owner author. Prefix with the
    //    real author so it's attributable in the dashboard's comments view.
    const commentBody = `[via Slack — ${actorName}] ${replyText}`;
    const commentRes = await fetch(
        `https://api.airtable.com/v0/${baseId}/${tasksTable}/${taskId}/comments`,
        {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + airtablePat,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: commentBody }),
        }
    );
    if (!commentRes.ok) {
        const errText = await commentRes.text();
        console.error('[slack-events] Airtable comment POST failed', commentRes.status, errText);
        // Tell the Slack user — short ack in the thread.
        await postEphemeralOrDm(slackToken, event, '⚠️ Couldn\'t post your reply as a comment on the task. The Airtable API returned ' + commentRes.status + '.');
        return;
    }

    // 5. Fetch the task to get name + collaborators for fan-out.
    const taskRes = await fetch(
        `https://api.airtable.com/v0/${baseId}/${tasksTable}/${taskId}?returnFieldsByFieldId=true`,
        { headers: { Authorization: 'Bearer ' + airtablePat } }
    );
    if (!taskRes.ok) {
        console.error('[slack-events] task fetch failed', await taskRes.text());
        return;
    }
    const task = await taskRes.json();
    const F_NAME = 'fldgFjGBw6bTKJFCD';
    const F_ASSIGNEE = 'fldELMncVJYPDRJNc';
    const F_COLLABORATORS = 'fldcq3t6uAPgWSOP8';
    const fields = task.fields || {};
    const taskName = fields[F_NAME] || '(Untitled)';
    const recipients = new Set();
    const collabs = fields[F_COLLABORATORS] || [];
    if (Array.isArray(collabs)) collabs.forEach(c => { if (c && c.email) recipients.add(c.email) });
    const assignee = fields[F_ASSIGNEE];
    if (assignee && assignee.email) recipients.add(assignee.email);
    // Don't ping the Slack reply author back to themselves.
    if (actorAirtableEmail) recipients.delete(actorAirtableEmail);

    // 6. Fan out a 'comment' DM to each remaining recipient. Reuses the
    //    outbound dispatch by posting to ourselves — keeps the message
    //    formatting consistent across all comment notifications.
    for (const email of recipients) {
        try {
            const slackTarget = slackEmailFor(email);
            await dispatchCommentDm(slackToken, slackTarget, {
                taskName,
                taskId,
                actorName,
                commentText: replyText,
            });
        } catch (e) {
            console.warn('[slack-events] fan-out failed for', email, e);
        }
    }

    // 7. Tiny ✅ reaction on the user's reply so they know it landed.
    try {
        await fetch('https://slack.com/api/reactions.add', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + slackToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: event.channel, timestamp: event.ts, name: 'white_check_mark' }),
        });
    } catch (_) { /* non-critical */ }
}

// Pull the Task ID out of a parent DM. We embed it as a context block:
// "Task ID: `recXYZ...`". Falls back to scanning the text if blocks aren't
// present (very old messages from before we standardised on context blocks).
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

// Strip Slack-specific markup so the comment text reads cleanly in the
// dashboard. Removes <@U123|name> mentions, <!channel> notifies, link
// formatting <https://x|y>, and zero-width characters Slack inserts.
function cleanSlackText(text) {
    if (!text) return '';
    let s = String(text);
    s = s.replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, '');
    s = s.replace(/<!channel>/g, '@channel').replace(/<!here>/g, '@here');
    s = s.replace(/<([^|>]+)\|([^>]+)>/g, '$2');
    s = s.replace(/<([^>]+)>/g, '$1');
    s = s.replace(/[​-‍﻿]/g, '');
    return s.trim();
}

// Same shape as the outbound /comment DM, but sent from the worker
// directly (we already have userId resolution + chat.postMessage). This
// avoids a second HTTP round-trip back to ourselves.
async function dispatchCommentDm(slackToken, recipientEmail, payload) {
    const lookupRes = await fetch(
        'https://slack.com/api/users.lookupByEmail?email=' + encodeURIComponent(recipientEmail),
        { headers: { Authorization: 'Bearer ' + slackToken } }
    );
    const lookup = await lookupRes.json();
    if (!lookup.ok || !lookup.user) {
        console.warn('[fan-out] no Slack user for', recipientEmail, lookup.error);
        return;
    }
    const userId = lookup.user.id;
    const headerLine = '*' + escapeMrkdwn(payload.actorName) + '* left a comment on a task you collaborate on:';
    const cleanComment = String(payload.commentText || '').trim().slice(0, 500);
    const text = headerLine + '\n\n• ' + escapeMrkdwn(payload.taskName) +
        (cleanComment ? '\n\n> ' + escapeMrkdwn(cleanComment).split('\n').join('\n> ') : '');
    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: headerLine } },
        { type: 'section', text: { type: 'mrkdwn', text: '*' + escapeMrkdwn(payload.taskName) + '*' } },
    ];
    if (cleanComment) {
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '> ' + escapeMrkdwn(cleanComment).split('\n').join('\n> ') },
        });
    }
    if (payload.taskId) {
        blocks.push({
            type: 'context',
            elements: [
                { type: 'mrkdwn', text: '💬 Reply in this thread to add a comment on the task.' },
                { type: 'mrkdwn', text: 'Task ID: `' + escapeMrkdwn(payload.taskId) + '`' },
            ],
        });
    }
    await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + slackToken, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel: userId, text, blocks }),
    });
}

async function postEphemeralOrDm(slackToken, event, message) {
    try {
        await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + slackToken, 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ channel: event.channel, thread_ts: event.thread_ts, text: message }),
        });
    } catch (_) { /* swallow */ }
}

// HMAC-SHA256 signing verification per Slack docs. Rejects requests
// older than 5 minutes to mitigate replay attacks.
async function verifySlackSignature(request, rawBody, signingSecret) {
    if (!signingSecret) {
        console.warn('[slack-events] SLACK_SIGNING_SECRET not configured — refusing all events');
        return false;
    }
    const sig = request.headers.get('X-Slack-Signature');
    const ts = request.headers.get('X-Slack-Request-Timestamp');
    if (!sig || !ts) return false;
    const tsNum = parseInt(ts, 10);
    if (!isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 60 * 5) return false;
    const baseString = `v0:${ts}:${rawBody}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', enc.encode(signingSecret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBytes = await crypto.subtle.sign('HMAC', key, enc.encode(baseString));
    const computed = 'v0=' + [...new Uint8Array(sigBytes)].map(b => b.toString(16).padStart(2, '0')).join('');
    // Constant-time comparison to avoid timing attacks.
    if (computed.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
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
