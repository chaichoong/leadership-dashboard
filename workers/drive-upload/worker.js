// Google Drive SOP Upload Worker
// POST /upload  { workflowName, htmlContent, fileName }
// Returns { folderId, folderUrl, fileId, fileUrl, docId, docUrl }
// GET /auth/start — redirects to Google OAuth consent screen
// GET /auth/callback — exchanges code for refresh token, displays it
//
// AUTH (the repo is public, so the worker URL is public):
//   - Browser calls (os/systemisation/index.html "Upload to Drive" button):
//     authenticated by strict Origin allow-list alone — browsers cannot
//     spoof Origin. The matched origin is reflected exactly, never '*'.
//     A claimed-browser call missing Sec-Fetch-* headers is treated as a
//     script and must present the bearer token instead.
//   - Script/automation calls: Authorization: Bearer <DRIVE_UPLOAD_TOKEN>
//     (REQUIRED secret for non-browser callers — uploads are high-consequence).
//   - Everything else: 403.
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
//          DRIVE_PARENT_FOLDER_ID, DRIVE_UPLOAD_TOKEN, GMAIL_SEND_KEY
// Optional vars: ALLOWED_ORIGINS_EXTRA (comma-separated extra origins)
// KV: GMAIL_AUTH — holds the gmail.send refresh token, written by /auth/callback
//     (state=gmail) so granting consent needs no terminal step.
//
// GMAIL SEND (added 6 Aug 2026, Kevin's ruling: approved agent work sends
// email itself rather than handing Kevin a draft):
//   GET  /auth/gmail  — one-time consent for the gmail.send scope (reuses this
//                       worker's registered /auth/callback redirect URI).
//                       Optional ?account=x@y.com preselects the Google account.
//                       Tokens are stored PER ACCOUNT (openid email scope tells
//                       the callback which account granted), so several senders
//                       can be connected side by side.
//   POST /send-email  — { to, subject, text, cc?, from? }; script-only, gated by
//                       Authorization: Bearer <GMAIL_SEND_KEY>. Sends as `from`
//                       if that account is connected; defaults to DEFAULT_SENDER
//                       (Kevin's ruling, 6 Aug 2026: kevinbrittain@gmail.com
//                       unless the task says otherwise).
//   GET  /send-email/test — token health + which senders are connected.
//
// CALENDAR (added 1 Sep 2026, Inbound Comms Response extension): approved
// diary entries land in Kevin's Google Calendar headlessly. Gated by the SAME
// Bearer <GMAIL_SEND_KEY> as /send-email — a diary write is a send-class
// consequence. The CONTROL is scripts/calendar-write.py, which only forwards
// the Agent Output of a task Kevin approved. Requires the calendar.events
// scope — a 403 from Google means the stored token predates this change:
// re-grant once at /auth/gmail. Attendees are REFUSED at this layer too: a
// diary entry never emails a third party; invites are Correspondence.
//   POST /calendar/create — { title, start, end, timeZone, location?,
//                             description?, account? } → { id, htmlLink }.
//                             start/end are RFC3339 local times paired with
//                             timeZone (Europe/London from the script).
//   GET  /calendar/test   — token health + whether calendar scope is granted.
//
// GMAIL TRIAGE (added 24 Aug 2026, Inbound Comms Triage agent): script-only
// read + label endpoints so the daily triage run can sort Kevin's inbox
// headlessly. Gated by Bearer <GMAIL_TRIAGE_KEY> — deliberately NOT the send
// key, so the credential the triage runtime holds cannot send email. Fails
// closed if the secret is unset.
// They need the gmail.modify scope — a 403 from Google means the stored token
// predates this change (gmail.send only): re-grant once at /auth/gmail.
//   POST /gmail/labels — { account? } → every label's { id, name }.
//   POST /gmail/list   — { q?, labelIds?, maxResults?, pageToken?, account? }
//                        Messages matching a Gmail search q and/or exact
//                        labelIds (preferred for label lookups — no query
//                        syntax to silently mis-parse), each with headers,
//                        snippet, labelIds, internalDate and a plain-text body
//                        excerpt. Read-only. Max 25 per call (each message is
//                        its own Gmail fetch and the worker has a
//                        50-subrequest budget); `nextPageToken` is returned
//                        when more remain — callers MUST treat its presence
//                        as "you have not seen everything".
//   POST /gmail/modify — { ids: [..], addLabels?: [..], removeLabels?: [..], account? }
//                        Applies label changes; archive = removeLabels ["INBOX"].
//                        Label NAMES resolve via the labels list; raw user-label
//                        ids (Label_123...) and ALL-CAPS system ids (INBOX,
//                        UNREAD) pass through. A user label whose NAME is bare
//                        all-caps would be misread as a system id — keep the
//                        numbered-prefix naming this system already uses.
//                        SPAM and TRASH are refused: this endpoint can label
//                        and archive, never send, delete, or mark spam. Max 40 ids.

// Kevin's ruling, 6 Aug 2026: emails go from this account unless the task
// specifies another connected sender.
const DEFAULT_SENDER = 'kevinbrittain@gmail.com';

// Send-as aliases (Kevin's ruling, 20 Aug 2026: business copy sends from the
// business address). These are NOT separate Google accounts — they are verified
// "Send mail as" aliases inside the account they map to, so they cannot grant
// their own consent at /auth/gmail. The send path uses the mapped account's
// token and stamps the alias as the From header; Gmail refuses the send if the
// alias is not verified in that account's settings, so an unverified alias
// fails loudly rather than sending as the wrong identity.
const SEND_AS_ALIASES = {
    // Kevin, 20 Aug 2026: the OD address is a verified "Send as" alias of the
    // RUNPRENEUR account (it appears in that account's Compose dropdown), not
    // of kevinbrittain@gmail.com — mapping it to gmail made Google rewrite the
    // From header on 19 warm emails.
    'kevin@operationsdirector.co.uk': 'kevin@runpreneur.org.uk',
};

const ALLOWED_ORIGINS = [
    'https://chaichoong.github.io',
    'http://localhost:8765', // local preview
];

function allowedOrigins(env) {
    const extra = (env.ALLOWED_ORIGINS_EXTRA || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    return ALLOWED_ORIGINS.concat(extra);
}

// Returns the origin to reflect in CORS headers, or null if not allowed.
// A real browser fetch sends Sec-Fetch-Mode (fetch metadata); a script that
// spoofs Origin usually does not. Spoofed-Origin scripts must use the token.
function matchBrowserOrigin(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (!allowedOrigins(env).includes(origin)) return null;
    if (!request.headers.get('Sec-Fetch-Mode') && !request.headers.get('Sec-Fetch-Site')) return null;
    return origin;
}

function hasServiceToken(request, env) {
    if (!env.DRIVE_UPLOAD_TOKEN) return false;
    const auth = request.headers.get('Authorization') || '';
    return auth === `Bearer ${env.DRIVE_UPLOAD_TOKEN}`;
}

function corsHeaders(allowOrigin) {
    const headers = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Vary': 'Origin',
    };
    if (allowOrigin) headers['Access-Control-Allow-Origin'] = allowOrigin;
    return headers;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/auth/start') {
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(url.origin + '/auth/callback')}&response_type=code&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive')}&access_type=offline&prompt=consent`;
            return Response.redirect(authUrl, 302);
        }

        if (url.pathname === '/auth/gmail') {
            // openid email is included so the callback can prove WHICH account
            // granted, and file the token under that account.
            const hint = url.searchParams.get('account');
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(url.origin + '/auth/callback')}&response_type=code&scope=${encodeURIComponent('openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events')}&access_type=offline&prompt=consent&state=gmail${hint ? `&login_hint=${encodeURIComponent(hint)}` : ''}`;
            return Response.redirect(authUrl, 302);
        }

        if (url.pathname === '/auth/callback') {
            const code = url.searchParams.get('code');
            if (!code) return new Response('No code provided', { status: 400 });

            const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `code=${code}&client_id=${env.GOOGLE_CLIENT_ID}&client_secret=${env.GOOGLE_CLIENT_SECRET}&redirect_uri=${encodeURIComponent(url.origin + '/auth/callback')}&grant_type=authorization_code`,
            });
            const tokenData = await tokenRes.json();

            // Gmail consent: store the token ourselves so the human step is
            // one click, not a terminal command.
            if (url.searchParams.get('state') === 'gmail') {
                if (!tokenData.refresh_token) {
                    return new Response('Error: no refresh token returned. ' + JSON.stringify(tokenData), { status: 400 });
                }
                const email = emailFromIdToken(tokenData.id_token);
                if (!email) {
                    return new Response('Error: could not read the granting account from Google\'s response. Nothing was stored.', { status: 400 });
                }
                await env.GMAIL_AUTH.put(`gmail_refresh_token:${email.toLowerCase()}`, tokenData.refresh_token);
                return new Response(
                    `<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
                    <h2>Email, inbox triage and calendar are connected for ${email}</h2>
                    <p>The agents can now send approved email from this account, the triage agent can read and sort its inbox, and approved calendar entries can be added to its diary. Nothing else to do — you can close this tab.</p>
                    </body></html>`,
                    { status: 200, headers: { 'Content-Type': 'text/html' } }
                );
            }

            if (tokenData.refresh_token) {
                return new Response(
                    `<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
                    <h2>Success</h2>
                    <p>Copy this refresh token and save it as a Cloudflare Worker secret:</p>
                    <pre style="background:#f0f0f0;padding:12px;border-radius:4px;word-break:break-all">${tokenData.refresh_token}</pre>
                    <p>Run this in your terminal:</p>
                    <code style="background:#f0f0f0;padding:8px;border-radius:4px;display:block">echo "${tokenData.refresh_token}" | npx wrangler secret put GOOGLE_REFRESH_TOKEN</code>
                    <p style="color:#666;margin-top:20px">You can close this tab after saving the token.</p>
                    </body></html>`,
                    { status: 200, headers: { 'Content-Type': 'text/html' } }
                );
            }
            return new Response('Error: ' + JSON.stringify(tokenData), { status: 400 });
        }

        // ------------------------------------------------------------------
        // Gmail send — script-only, never browser-origin. High consequence:
        // this sends real email as Kevin, so the bearer key is REQUIRED and
        // there is no origin-based path.
        // ------------------------------------------------------------------
        if (url.pathname === '/send-email' || url.pathname === '/send-email/test') {
            const auth = request.headers.get('Authorization') || '';
            if (!env.GMAIL_SEND_KEY || auth !== `Bearer ${env.GMAIL_SEND_KEY}`) {
                return jsonResponse({ error: 'Forbidden' }, 403);
            }
            try {
                if (url.pathname === '/send-email/test') {
                    const listed = await env.GMAIL_AUTH.list({ prefix: 'gmail_refresh_token:' });
                    const connected = listed.keys.map(k => k.name.slice('gmail_refresh_token:'.length));
                    let scope = null, expires_in = null;
                    const probe = connected[0] && await env.GMAIL_AUTH.get(`gmail_refresh_token:${connected[0]}`);
                    if (probe) {
                        const accessToken = await getGmailAccessToken(env, probe);
                        const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
                        const data = await info.json();
                        scope = data.scope || null; expires_in = data.expires_in || null;
                    }
                    // Aliases only count when their parent account is connected.
                    const aliases = Object.entries(SEND_AS_ALIASES)
                        .filter(([, acct]) => connected.includes(acct))
                        .map(([alias, acct]) => `${alias} (via ${acct})`);
                    return jsonResponse({ status: connected.length ? 'ok' : 'not-connected',
                                          defaultSender: DEFAULT_SENDER, connected, aliases, scope, expires_in },
                                        connected.length ? 200 : 409);
                }

                if (request.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);
                const { to, subject, text, cc, from, attachment } = await request.json();
                if (!to || !subject || !text) {
                    return jsonResponse({ error: 'to, subject and text are required' }, 400);
                }
                if (attachment !== undefined && attachment !== null) {
                    const bad = attachmentProblem(attachment);
                    if (bad) return jsonResponse({ error: bad }, 400);
                }

                const sender = (from || DEFAULT_SENDER).toLowerCase().trim();
                // The sender's own consent always wins; the alias map is a
                // FALLBACK for when it has none. Mapping first would shadow a
                // real account behind its parent — and Gmail rewrites the From
                // header to the parent unless the alias is verified there,
                // which is how 19 warm emails went out as the wrong identity
                // on 20 Aug 2026.
                let tokenAccount = sender;
                let refreshToken = await env.GMAIL_AUTH.get(`gmail_refresh_token:${sender}`);
                if (!refreshToken && SEND_AS_ALIASES[sender]) {
                    tokenAccount = SEND_AS_ALIASES[sender];
                    refreshToken = await env.GMAIL_AUTH.get(`gmail_refresh_token:${tokenAccount}`);
                }
                if (!refreshToken) {
                    const listed = await env.GMAIL_AUTH.list({ prefix: 'gmail_refresh_token:' });
                    const connected = listed.keys.map(k => k.name.slice('gmail_refresh_token:'.length));
                    return jsonResponse({ error: `Gmail not connected for ${tokenAccount}. Connected senders: ${connected.join(', ') || 'none'}. Grant once at /auth/gmail?account=${tokenAccount}`, connected }, 409);
                }
                const accessToken = await getGmailAccessToken(env, refreshToken);

                const raw = buildRawEmail({ to, subject, text, cc, from: sender,
                                            attachment: attachment || undefined });
                const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ raw }),
                });
                if (!sendRes.ok) throw new Error('Gmail send failed: ' + await sendRes.text());
                const sent = await sendRes.json();
                return jsonResponse({ status: 'sent', id: sent.id, threadId: sent.threadId });
            } catch (e) {
                return jsonResponse({ error: e.message }, 500);
            }
        }

        // ------------------------------------------------------------------
        // Calendar — script-only, never browser-origin. Writes an approved
        // entry to Kevin's own diary. Same key as /send-email: a diary write
        // is a send-class consequence, and the approval gate lives in
        // scripts/calendar-write.py, not here.
        // ------------------------------------------------------------------
        if (url.pathname === '/calendar/create' || url.pathname === '/calendar/test') {
            const auth = request.headers.get('Authorization') || '';
            if (!env.GMAIL_SEND_KEY || auth !== `Bearer ${env.GMAIL_SEND_KEY}`) {
                return jsonResponse({ error: 'Forbidden' }, 403);
            }
            try {
                if (url.pathname === '/calendar/test') {
                    // Probe the account the diary writes will actually use —
                    // probing whichever account lists first reported a
                    // NEIGHBOUR'S consent state as this lane's health.
                    const acctQ = (url.searchParams.get('account') || DEFAULT_SENDER).toLowerCase().trim();
                    const listed = await env.GMAIL_AUTH.list({ prefix: 'gmail_refresh_token:' });
                    const connected = listed.keys.map(k => k.name.slice('gmail_refresh_token:'.length));
                    let scope = null, calendarScope = false;
                    const probe = await env.GMAIL_AUTH.get(`gmail_refresh_token:${acctQ}`);
                    if (probe) {
                        const accessToken = await getGmailAccessToken(env, probe);
                        const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
                        const data = await info.json();
                        scope = data.scope || null;
                        calendarScope = !!(scope && scope.includes('calendar.events'));
                    }
                    return jsonResponse({ status: calendarScope ? 'ok' : 'not-connected',
                                          account: acctQ, connected, calendarScope,
                                          hint: calendarScope ? undefined
                                              : `Re-grant once at /auth/gmail?account=${acctQ} — the stored token predates the calendar scope.` },
                                        calendarScope ? 200 : 409);
                }

                if (request.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);
                const body = await request.json();
                if (body.attendees !== undefined) {
                    return jsonResponse({ error: 'attendees are not supported: a diary entry never emails a third party. Anything inviting someone is Correspondence and goes through the email gate.' }, 400);
                }
                const { title, start, end, timeZone, location, description, account } = body;
                if (!title || !start || !end || !timeZone) {
                    return jsonResponse({ error: 'title, start, end and timeZone are required' }, 400);
                }
                const acct = (account || DEFAULT_SENDER).toLowerCase().trim();
                const refreshToken = await env.GMAIL_AUTH.get(`gmail_refresh_token:${acct}`);
                if (!refreshToken) {
                    return jsonResponse({ error: `Google not connected for ${acct}. Grant once at /auth/gmail?account=${acct}` }, 409);
                }
                const accessToken = await getGmailAccessToken(env, refreshToken);
                const createRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        summary: title,
                        start: { dateTime: start, timeZone },
                        end: { dateTime: end, timeZone },
                        location: location || undefined,
                        description: description || undefined,
                    }),
                });
                if (!createRes.ok) {
                    const detail = await createRes.text();
                    if (createRes.status === 403) {
                        return jsonResponse({ error: `Calendar scope not granted for ${acct} — re-grant once at /auth/gmail?account=${acct}. Google said: ${detail.slice(0, 200)}` }, 409);
                    }
                    throw new Error('Calendar create failed: ' + detail);
                }
                const ev = await createRes.json();
                return jsonResponse({ status: 'created', id: ev.id, htmlLink: ev.htmlLink });
            } catch (e) {
                return jsonResponse({ error: e.message }, 500);
            }
        }

        // ------------------------------------------------------------------
        // Gmail triage — script-only, never browser-origin. Reads and labels
        // Kevin's inbox for the Inbound Comms Triage agent. Same STYLE of
        // bearer gate as /send-email but a deliberately DIFFERENT key, so the
        // triage credential cannot send. Requires the gmail.modify scope.
        // ------------------------------------------------------------------
        if (url.pathname === '/gmail/labels' || url.pathname === '/gmail/list' || url.pathname === '/gmail/modify') {
            // A separate key from /send-email on purpose: the triage runtime's
            // credential must not be able to send mail. Fails closed when unset.
            const auth = request.headers.get('Authorization') || '';
            if (!env.GMAIL_TRIAGE_KEY || auth !== `Bearer ${env.GMAIL_TRIAGE_KEY}`) {
                return jsonResponse({ error: 'Forbidden' }, 403);
            }
            if (request.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);
            try {
                const body = await request.json().catch(() => ({}));
                const account = (body.account || DEFAULT_SENDER).toLowerCase().trim();
                const refreshToken = await env.GMAIL_AUTH.get(`gmail_refresh_token:${account}`);
                if (!refreshToken) {
                    return jsonResponse({ error: `Gmail not connected for ${account}. Grant once at /auth/gmail?account=${account}` }, 409);
                }
                const accessToken = await getGmailAccessToken(env, refreshToken);
                if (url.pathname === '/gmail/labels') return jsonResponse(await gmailLabels(accessToken));
                if (url.pathname === '/gmail/list') return jsonResponse(await gmailList(accessToken, body));
                return jsonResponse(await gmailModify(accessToken, body));
            } catch (e) {
                // Google answers 403 insufficientPermissions when the stored
                // token predates the gmail.modify scope — name the fix.
                const hint = /insufficient|PERMISSION_DENIED|403/i.test(e.message)
                    ? ' If this is a permission error, re-grant once at /auth/gmail (the triage scope was added 24 Aug 2026).' : '';
                return jsonResponse({ error: e.message + hint }, 500);
            }
        }

        const allowOrigin = matchBrowserOrigin(request, env);

        if (request.method === 'OPTIONS') {
            // Preflight: only answer for allow-listed origins.
            if (!allowOrigin) return new Response(null, { status: 403 });
            return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
        }

        // Auth gate for everything below (/test and /upload):
        // allow-listed browser Origin OR service bearer token.
        if (!allowOrigin && !hasServiceToken(request, env)) {
            return jsonResponse({ error: 'Forbidden: origin not allowed and no valid service token' }, 403, allowOrigin);
        }

        if (url.pathname === '/test') {
            try {
                const accessToken = await getAccessToken(env);
                const parentId = env.DRIVE_PARENT_FOLDER_ID;
                // Verify we can list the parent folder
                const listRes = await fetch(`https://www.googleapis.com/drive/v3/files/${parentId}?fields=id,name,mimeType`, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                });
                const folderInfo = listRes.ok ? await listRes.json() : { error: await listRes.text() };
                return jsonResponse({ status: 'ok', auth: 'valid', parentFolder: folderInfo }, 200, allowOrigin);
            } catch (e) {
                return jsonResponse({ status: 'error', message: e.message }, 500, allowOrigin);
            }
        }

        if (request.method !== 'POST') {
            return jsonResponse({ error: 'POST required' }, 405, allowOrigin);
        }

        try {
            const { workflowName, htmlContent, fileName } = await request.json();
            if (!workflowName || !htmlContent) {
                return jsonResponse({ error: 'workflowName and htmlContent are required' }, 400, allowOrigin);
            }

            const accessToken = await getAccessToken(env);
            const parentFolderId = env.DRIVE_PARENT_FOLDER_ID;

            const folder = await createFolder(accessToken, workflowName, parentFolderId);

            const safeName = (fileName || workflowName).replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-');
            const file = await uploadFile(accessToken, safeName + '.html', htmlContent, folder.id);

            // Google Doc creation is non-blocking — if it fails, we still return the HTML file
            let doc = null;
            let docError = null;
            try {
                doc = await uploadAsGoogleDoc(accessToken, safeName, htmlContent, folder.id);
            } catch (docErr) {
                docError = docErr.message;
                console.error('Google Doc creation failed:', docErr.message);
            }

            await shareFolder(accessToken, folder.id);

            return jsonResponse({
                folderId: folder.id,
                folderUrl: `https://drive.google.com/drive/folders/${folder.id}`,
                fileId: file.id,
                fileUrl: `https://drive.google.com/file/d/${file.id}/view`,
                docId: doc ? doc.id : null,
                docUrl: doc ? `https://docs.google.com/document/d/${doc.id}/edit` : null,
                docError: docError,
            }, 200, allowOrigin);
        } catch (e) {
            return jsonResponse({ error: e.message }, 500, allowOrigin);
        }
    },
};

function jsonResponse(data, status = 200, allowOrigin = null) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(allowOrigin) },
    });
}

// The middle segment of a Google id_token is base64url JSON carrying the
// granting account's email (scope openid email). No signature check needed:
// the token came straight from Google's token endpoint over TLS.
function emailFromIdToken(idToken) {
    try {
        const payload = (idToken || '').split('.')[1];
        const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(b64 + '='.repeat((4 - b64.length % 4) % 4))).email || null;
    } catch (e) {
        return null;
    }
}

async function getGmailAccessToken(env, refreshToken) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `client_id=${env.GOOGLE_CLIENT_ID}&client_secret=${env.GOOGLE_CLIENT_SECRET}&refresh_token=${encodeURIComponent(refreshToken)}&grant_type=refresh_token`,
    });
    if (!res.ok) throw new Error('Gmail auth failed: ' + await res.text());
    const data = await res.json();
    return data.access_token;
}

// Base64url for the Gmail API, unicode-safe (subjects and bodies carry £).
function b64url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildRawEmail({ to, subject, text, cc, from, attachment }) {
    const enc = new TextEncoder();
    const encodedSubject = `=?UTF-8?B?${btoa(String.fromCharCode(...enc.encode(subject)))}?=`;
    const bodyB64 = btoa(String.fromCharCode(...enc.encode(text)));
    const headers = [
        // From is stamped explicitly so a send-as alias keeps its identity;
        // Gmail validates it against the account's verified senders.
        ...(from ? [`From: ${from}`] : []),
        `To: ${to}`,
        ...(cc ? [`Cc: ${cc}`] : []),
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
    ];
    if (!attachment) {
        const lines = [
            ...headers,
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: base64',
            '',
            bodyB64,
        ];
        return b64url(enc.encode(lines.join('\r\n')));
    }
    // One attachment → multipart/mixed (added 25 Aug 2026 for the Creditor
    // Management agent's restraint-order pages; send-email.py is the only
    // caller and enforces the file guards). Every part below is ASCII by
    // construction — the body and the file ride as base64, the subject as an
    // encoded-word — so the whole raw message goes through btoa directly.
    // The per-byte b64url loop would be a CPU-limit risk at megabyte scale.
    const boundary = 'od-part-' + crypto.randomUUID();
    const safeName = String(attachment.filename).replace(/[^\w.\- ]/g, '_');
    const raw = [
        ...headers,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        bodyB64,
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType}; name="${safeName}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${safeName}"`,
        '',
        attachment.dataB64,
        `--${boundary}--`,
    ].join('\r\n');
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Shape gate for the optional /send-email attachment. Returns an error string
// or null. The real file guards (allowlisted directory, extension, size on
// disk) live in scripts/send-email.py, the only caller — this is the
// worker-side floor so a direct call cannot send arbitrary content shapes.
const ATTACH_MIME_ALLOWED = ['application/pdf', 'image/png', 'image/jpeg'];
const ATTACH_B64_MAX = 7 * 1024 * 1024; // ~5MB file, base64-encoded
function attachmentProblem(a) {
    if (!a || typeof a !== 'object') return 'attachment must be an object';
    if (!a.filename || typeof a.filename !== 'string') return 'attachment.filename required';
    if (!ATTACH_MIME_ALLOWED.includes(a.mimeType)) {
        return `attachment.mimeType must be one of ${ATTACH_MIME_ALLOWED.join(', ')}`;
    }
    if (typeof a.dataB64 !== 'string' || !a.dataB64) return 'attachment.dataB64 required';
    if (a.dataB64.length > ATTACH_B64_MAX) return 'attachment too large';
    if (!/^[A-Za-z0-9+/=]+$/.test(a.dataB64)) return 'attachment.dataB64 is not base64';
    return null;
}

// ---------------------------------------------------------------------------
// Gmail triage helpers (Inbound Comms Triage agent, 24 Aug 2026)
// ---------------------------------------------------------------------------

async function gmailLabels(token) {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Gmail labels list failed: ' + await res.text());
    const { labels = [] } = await res.json();
    return { labels: labels.map(l => ({ id: l.id, name: l.name, type: l.type })) };
}

async function gmailList(token, { q, labelIds, maxResults, pageToken }) {
    // Hard cap 25: the list call plus one get per message must stay inside the
    // worker's 50-subrequest budget alongside the token refresh. Callers
    // paginate with pageToken; nextPageToken in the response means MORE REMAIN.
    const cap = Math.min(Math.max(Number(maxResults) || 25, 1), 25);
    const params = new URLSearchParams({ maxResults: String(cap) });
    if (q) params.set('q', q);
    // Exact label matching — no free-text label: syntax for Gmail to mis-parse.
    for (const id of (Array.isArray(labelIds) ? labelIds : [])) params.append('labelIds', String(id));
    if (!q && !(Array.isArray(labelIds) && labelIds.length)) params.set('q', 'in:inbox');
    if (pageToken) params.set('pageToken', String(pageToken));
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!listRes.ok) throw new Error('Gmail list failed: ' + await listRes.text());
    const { messages = [], resultSizeEstimate, nextPageToken } = await listRes.json();
    const out = [];
    for (const m of messages) {
        const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!msgRes.ok) throw new Error('Gmail get failed for ' + m.id + ': ' + await msgRes.text());
        const msg = await msgRes.json();
        const headers = {};
        for (const h of (msg.payload?.headers || [])) {
            const k = h.name.toLowerCase();
            // list-unsubscribe is the strongest machine-mail signal the triage
            // rules use, so it rides along with the human-readable headers.
            // The auto-reply set (RFC 3834 auto-submitted, Exchange's
            // x-auto-response-suppress, x-autoreply/x-autorespond,
            // precedence) lets the triage scan mark a machine receipt of
            // something we sent WITHOUT judgement — those were reaching
            // Kevin's approval gate as tasks (2 Sep 2026).
            if (['from', 'to', 'subject', 'date', 'list-unsubscribe',
                 'auto-submitted', 'x-auto-response-suppress', 'x-autoreply',
                 'x-autorespond', 'precedence', 'in-reply-to'].includes(k)) headers[k] = h.value;
        }
        out.push({
            id: msg.id,
            threadId: msg.threadId,
            labelIds: msg.labelIds || [],
            internalDate: Number(msg.internalDate) || null,
            snippet: msg.snippet || '',
            headers,
            body: extractPlainText(msg.payload).slice(0, 4000),
        });
    }
    return { messages: out, resultSizeEstimate, nextPageToken: nextPageToken || null };
}

async function gmailModify(token, { ids, addLabels, removeLabels }) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('ids (array of message ids) is required');
    if (ids.length > 40) throw new Error('40 ids max per call');
    const add = Array.isArray(addLabels) ? addLabels : [];
    const remove = Array.isArray(removeLabels) ? removeLabels : [];
    if (!add.length && !remove.length) throw new Error('addLabels or removeLabels required');
    // Triage can label and archive, never destroy: trashing or spamming a
    // message from here would be a silent delete path.
    for (const name of add) {
        if (/^(SPAM|TRASH)$/i.test(String(name))) throw new Error(`Refusing to add ${name} — this endpoint never deletes or marks spam`);
    }
    const { labels } = await gmailLabels(token);
    const byName = new Map(labels.map(l => [l.name.toLowerCase(), l.id]));
    const resolve = (name) => {
        const s = String(name);
        if (/^Label_\d+$/.test(s)) return s; // raw user-label id
        if (/^[A-Z_]+$/.test(s)) return s;   // system label id (INBOX, UNREAD, …)
        const id = byName.get(s.toLowerCase());
        if (!id) throw new Error(`Unknown Gmail label: ${s}`);
        return id;
    };
    const addLabelIds = add.map(resolve);
    const removeLabelIds = remove.map(resolve);
    const results = [];
    for (const id of ids) {
        const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ addLabelIds, removeLabelIds }),
        });
        if (!res.ok) throw new Error(`Gmail modify failed for ${id}: ` + await res.text());
        const msg = await res.json();
        results.push({ id: msg.id, labelIds: msg.labelIds || [] });
    }
    return { modified: results.length, results };
}

// Prefer the text/plain part; fall back to text/html with tags stripped.
// Gmail body data is base64url; decode unicode-safely (bodies carry £).
function b64urlDecodeUtf8(data) {
    const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

function extractPlainText(payload) {
    if (!payload) return '';
    const queue = [payload];
    let html = null;
    while (queue.length) {
        const p = queue.shift();
        if (p.mimeType === 'text/plain' && p.body?.data) return b64urlDecodeUtf8(p.body.data);
        if (p.mimeType === 'text/html' && p.body?.data && html === null) html = b64urlDecodeUtf8(p.body.data);
        if (p.parts) queue.push(...p.parts);
    }
    if (html !== null) {
        return html
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/\s+/g, ' ')
            .trim();
    }
    return '';
}

async function getAccessToken(env) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `client_id=${env.GOOGLE_CLIENT_ID}&client_secret=${env.GOOGLE_CLIENT_SECRET}&refresh_token=${env.GOOGLE_REFRESH_TOKEN}&grant_type=refresh_token`,
    });

    if (!res.ok) throw new Error('Google auth failed: ' + await res.text());
    const data = await res.json();
    return data.access_token;
}

async function createFolder(token, name, parentId) {
    const metadata = {
        name,
        mimeType: 'application/vnd.google-apps.folder',
    };
    if (parentId) metadata.parents = [parentId];

    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(metadata),
    });
    if (!res.ok) throw new Error('Folder creation failed: ' + await res.text());
    return res.json();
}

async function uploadFile(token, fileName, htmlContent, folderId) {
    const metadata = { name: fileName, parents: [folderId] };
    const boundary = '----CloudflareWorkerBoundary';

    const body = [
        `--${boundary}\r\n`,
        'Content-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify(metadata) + '\r\n',
        `--${boundary}\r\n`,
        'Content-Type: text/html\r\n\r\n',
        htmlContent + '\r\n',
        `--${boundary}--`,
    ].join('');

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
    });
    if (!res.ok) throw new Error('File upload failed: ' + await res.text());
    return res.json();
}

async function uploadAsGoogleDoc(token, docName, htmlContent, folderId) {
    const metadata = {
        name: docName,
        parents: [folderId],
        mimeType: 'application/vnd.google-apps.document',
    };
    const boundary = '----CloudflareWorkerBoundaryDoc';

    const body = [
        `--${boundary}\r\n`,
        'Content-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify(metadata) + '\r\n',
        `--${boundary}\r\n`,
        'Content-Type: text/html\r\n\r\n',
        htmlContent + '\r\n',
        `--${boundary}--`,
    ].join('');

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
    });
    if (!res.ok) throw new Error('Google Doc upload failed: ' + await res.text());
    return res.json();
}

async function shareFolder(token, folderId) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
}
