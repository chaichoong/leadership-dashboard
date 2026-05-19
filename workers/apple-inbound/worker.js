// apple-inbound — Cloudflare Worker.
// =====================================================================
//
// Receives webhook POSTs from Apple Shortcuts on Kevin's iPhone/Watch.
//
//   POST /voice-task     — Apple Watch voice dictation → Airtable task
//   POST /text-forward   — Forwarded text → email to Gmail for inbound comms processing
//   POST /voice-forward  — Voice message audio → R2 + email to Gmail for inbound comms
//   GET  /files/<key>    — Serve uploaded audio from R2
//
// All POST endpoints require Bearer token auth matching env.BEARER_TOKEN.
//
// SECRETS (Cloudflare dashboard → apple-inbound → Settings → Variables and Secrets)
// ────────────────────────────────────────────────────────────────────────
//   AIRTABLE_PAT    — PAT with data.records:read + data.records:write
//   BEARER_TOKEN    — Shared secret for Apple Shortcuts auth
//   SLACK_BOT_TOKEN — xoxb-... for optional Slack notifications
//   RESEND_API_KEY  — Resend API key for sending forwarded emails
//   FROM_EMAIL      — Sending address (e.g. shortcuts@operationsdirector.co.uk)

const AIRTABLE_BASE  = 'appnqjDpqDniH3IRl';
const TABLE_TASKS    = 'tblqB8b22hKBL4PF1';
const AIRTABLE_URL   = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${TABLE_TASKS}`;

const RECIPIENT_EMAIL = 'kevinbrittain@gmail.com';

const FIELD = {
    taskName:      'fldgFjGBw6bTKJFCD',
    description:   'fldRGhBQViKZKtkQ6',
    status:        'fldx4qCw17UfrKpaN',
    isInbound:     'fldueazD67F7fUGee',
    assignee:      'fldELMncVJYPDRJNc',
    priority:      'fldS21RwmwOqt71LI',
    sender:        'fldzf4xlbrQuktx0i',
    dateReceived:  'fldR4peEZRXo7tjoI',
    messageBody:   'fldiSNijdCy5GXuzL',
    attachments:   'fldEbs9cscRr8elcw',
    collaborators: 'fldcq3t6uAPgWSOP8',
    dueDate:       'fld7XP8w8kbxfETV4',
    timeEstimate:  'fld10VzzbiNNgRmIi',
};

const KEVIN_EMAIL = 'kevin@runpreneur.org.uk';
const MICA_EMAIL  = 'micaa.work@gmail.com';
const ERICA_EMAIL = 'atentaerica@gmail.com';

const SLACK_POST_URL   = 'https://slack.com/api/chat.postMessage';
const SLACK_LOOKUP_URL = 'https://slack.com/api/users.lookupByEmail';

// ─── ENTRY ────────────────────────────────────────────────────────────

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === 'GET' && url.pathname.startsWith('/files/')) {
            const key = decodeURIComponent(url.pathname.slice('/files/'.length));
            return serveR2File(key, env);
        }

        if (request.method === 'GET' && url.pathname === '/health') {
            return json({ status: 'ok', worker: 'apple-inbound' });
        }

        if (request.method !== 'POST') {
            return json({ error: 'Method not allowed' }, 405);
        }

        if (!verifyBearer(request, env.BEARER_TOKEN)) {
            return json({ error: 'Unauthorized' }, 401);
        }

        try {
            if (url.pathname === '/voice-task') return await handleVoiceTask(request, env);
            if (url.pathname === '/text-forward') return await handleTextForward(request, env);
            if (url.pathname === '/voice-forward') return await handleVoiceForward(request, env);
            return json({ error: 'Not found' }, 404);
        } catch (err) {
            console.error('apple-inbound error:', err && err.stack || err);
            return json({ error: 'Internal error', detail: String(err) }, 500);
        }
    },
};

// ─── HANDLERS ─────────────────────────────────────────────────────────

async function handleVoiceTask(request, env) {
    const body = await parseBody(request);
    const taskName = body.task_name || body.text || body.transcription || '';
    if (!taskName.trim()) {
        return json({ error: 'task_name or text is required' }, 400);
    }

    const today = new Date().toLocaleString('en-CA', { timeZone: 'Europe/London' }).slice(0, 10);

    const fields = {
        [FIELD.taskName]:      taskName.trim(),
        [FIELD.status]:        'Today',
        [FIELD.priority]:      body.priority || 'Not Urgent',
        [FIELD.dateReceived]:  today,
        [FIELD.dueDate]:       today,
        [FIELD.timeEstimate]:  '15 min',
        [FIELD.assignee]:      { email: KEVIN_EMAIL },
    };

    if (body.description) {
        fields[FIELD.description] = body.description;
    }

    const record = await createAirtableRecord(fields, env);

    if (env.SLACK_BOT_TOKEN) {
        await notifySlack(env, `New task from Apple Watch: *${taskName.trim()}*`);
    }

    return json({ ok: true, recordId: record.id, task: taskName.trim() });
}

async function handleTextForward(request, env) {
    const body = await parseBody(request);
    const text = body.text || body.message || body.content || '';
    if (!text.trim()) {
        return json({ error: 'text or message is required' }, 400);
    }

    const sender = body.sender || body.from || 'Unknown sender';
    const subject = `Text message for processing - from ${sender}`;
    const fromEmail = env.FROM_EMAIL || 'shortcuts@operationsdirector.co.uk';

    await sendViaResend(env, {
        from: `Apple Shortcut <${fromEmail}>`,
        to: RECIPIENT_EMAIL,
        subject,
        html: buildTextEmailHtml(text.trim(), sender),
        text: `Forwarded text message\nFrom: ${sender}\n\n${text.trim()}`,
    });

    if (env.SLACK_BOT_TOKEN) {
        await notifySlack(env, `Text forwarded to inbound from ${sender}`);
    }

    return json({ ok: true, subject });
}

async function handleVoiceForward(request, env) {
    const contentType = request.headers.get('content-type') || '';

    let audioData, audioFilename, sender, transcription;

    if (contentType.includes('multipart/form-data')) {
        const formData = await request.formData();
        const file = formData.get('audio') || formData.get('file') || formData.get('voice');
        if (!file) return json({ error: 'audio file is required in form data' }, 400);

        audioData = await file.arrayBuffer();
        audioFilename = file.name || `voice-${Date.now()}.m4a`;
        sender = formData.get('sender') || formData.get('from') || 'Unknown sender';
        transcription = formData.get('transcription') || formData.get('notes') || formData.get('text') || '';
    } else {
        const body = await parseBody(request);
        if (body.audio_base64) {
            audioData = base64ToArrayBuffer(body.audio_base64);
            audioFilename = body.filename || `voice-${Date.now()}.m4a`;
        } else {
            return json({ error: 'audio file or audio_base64 is required' }, 400);
        }
        sender = body.sender || body.from || 'Unknown sender';
        transcription = body.transcription || body.notes || body.text || '';
    }

    const r2Key = `voice/${Date.now()}-${audioFilename}`;
    await env.ATTACHMENTS.put(r2Key, audioData, {
        httpMetadata: { contentType: guessAudioMime(audioFilename) },
    });

    const workerUrl = new URL(request.url);
    const publicUrl = `${workerUrl.origin}/files/${encodeURIComponent(r2Key)}`;

    const subject = transcription
        ? `Voice message for processing - from ${sender}`
        : `Voice message for processing - from ${sender}`;

    const fromEmail = env.FROM_EMAIL || 'shortcuts@operationsdirector.co.uk';

    await sendViaResend(env, {
        from: `Apple Shortcut <${fromEmail}>`,
        to: RECIPIENT_EMAIL,
        subject,
        html: buildVoiceEmailHtml(sender, publicUrl, audioFilename, transcription),
        text: buildVoiceEmailText(sender, publicUrl, transcription),
    });

    if (env.SLACK_BOT_TOKEN) {
        await notifySlack(env, `Voice message forwarded to inbound from ${sender}`);
    }

    return json({ ok: true, audioUrl: publicUrl });
}

// ─── EMAIL ────────────────────────────────────────────────────────────

async function sendViaResend(env, email) {
    const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: email.from,
            to: [email.to],
            subject: email.subject,
            html: email.html,
            text: email.text,
        }),
    });

    if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`Resend API ${resp.status}: ${errBody}`);
    }

    return resp.json();
}

function buildTextEmailHtml(text, sender) {
    return `
<div style="font-family: sans-serif; max-width: 600px;">
  <h3 style="color: #333;">Forwarded text message</h3>
  <p><strong>From:</strong> ${escHtml(sender)}</p>
  <hr style="border: none; border-top: 1px solid #ddd;">
  <div style="white-space: pre-wrap; color: #222; line-height: 1.6;">${escHtml(text)}</div>
</div>`;
}

function buildVoiceEmailHtml(sender, audioUrl, filename, transcription) {
    const transcriptionBlock = transcription
        ? `<h4 style="color: #555;">Transcription</h4>
  <div style="white-space: pre-wrap; color: #222; line-height: 1.6; background: #f9f9f9; padding: 12px; border-radius: 6px;">${escHtml(transcription)}</div>`
        : `<p style="color: #888;"><em>No transcription provided. Listen to the audio below.</em></p>`;

    return `
<div style="font-family: sans-serif; max-width: 600px;">
  <h3 style="color: #333;">Voice message for processing</h3>
  <p><strong>From:</strong> ${escHtml(sender)}</p>
  <hr style="border: none; border-top: 1px solid #ddd;">
  ${transcriptionBlock}
  <h4 style="color: #555;">Audio file</h4>
  <p><a href="${escHtml(audioUrl)}" style="color: #2C6E49;">${escHtml(filename)}</a></p>
</div>`;
}

function buildVoiceEmailText(sender, audioUrl, transcription) {
    let text = `Voice message for processing\nFrom: ${sender}\n\n`;
    if (transcription) {
        text += `Transcription:\n${transcription}\n\n`;
    }
    text += `Audio: ${audioUrl}`;
    return text;
}

// ─── AIRTABLE ─────────────────────────────────────────────────────────

async function createAirtableRecord(fields, env) {
    const res = await fetch(AIRTABLE_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.AIRTABLE_PAT}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify({ fields }),
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Airtable create failed (${res.status}): ${text}`);
    }

    return res.json();
}

// ─── SLACK ────────────────────────────────────────────────────────────

async function notifySlack(env, message) {
    try {
        const slackId = await lookupSlackUser(env, KEVIN_EMAIL);
        if (!slackId) return;

        await fetch(SLACK_POST_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}`,
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({
                channel: slackId,
                text: message,
            }),
        });
    } catch (err) {
        console.error('Slack notify failed (non-fatal):', err);
    }
}

async function lookupSlackUser(env, email) {
    const res = await fetch(`${SLACK_LOOKUP_URL}?email=${encodeURIComponent(email)}`, {
        headers: { 'Authorization': `Bearer ${env.SLACK_BOT_TOKEN}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ok ? data.user.id : null;
}

// ─── R2 FILE SERVING ──────────────────────────────────────────────────

async function serveR2File(key, env) {
    const obj = await env.ATTACHMENTS.get(key);
    if (!obj) return new Response('Not found', { status: 404 });

    const headers = new Headers();
    headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
    headers.set('Cache-Control', 'public, max-age=86400');
    return new Response(obj.body, { headers });
}

// ─── HELPERS ──────────────────────────────────────────────────────────

function verifyBearer(request, expectedToken) {
    if (!expectedToken) return false;
    const auth = request.headers.get('Authorization') || '';
    return auth === `Bearer ${expectedToken}`;
}

async function parseBody(request) {
    const ct = request.headers.get('content-type') || '';
    if (ct.includes('application/json')) return request.json();
    if (ct.includes('application/x-www-form-urlencoded')) {
        const text = await request.text();
        return Object.fromEntries(new URLSearchParams(text));
    }
    const text = await request.text();
    try { return JSON.parse(text); } catch { return { text }; }
}

function base64ToArrayBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

function guessAudioMime(filename) {
    const ext = (filename || '').split('.').pop().toLowerCase();
    const mimes = {
        m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
        ogg: 'audio/ogg', aac: 'audio/aac', caf: 'audio/x-caf',
    };
    return mimes[ext] || 'audio/mp4';
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}
