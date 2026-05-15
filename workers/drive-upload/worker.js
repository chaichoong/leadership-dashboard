// Google Drive SOP Upload Worker
// POST /upload  { workflowName, htmlContent, fileName }
// Returns { folderId, folderUrl, fileId, fileUrl }
// GET /auth/start — redirects to Google OAuth consent screen
// GET /auth/callback — exchanges code for refresh token, displays it

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/auth/start') {
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${env.GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(url.origin + '/auth/callback')}&response_type=code&scope=${encodeURIComponent('https://www.googleapis.com/auth/drive')}&access_type=offline&prompt=consent`;
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

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (request.method !== 'POST') {
            return jsonResponse({ error: 'POST required' }, 405);
        }

        try {
            const { workflowName, htmlContent, fileName } = await request.json();
            if (!workflowName || !htmlContent) {
                return jsonResponse({ error: 'workflowName and htmlContent are required' }, 400);
            }

            const accessToken = await getAccessToken(env);
            const parentFolderId = env.DRIVE_PARENT_FOLDER_ID;

            const folder = await createFolder(accessToken, workflowName, parentFolderId);

            const safeName = (fileName || workflowName).replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '-') + '.html';
            const file = await uploadFile(accessToken, safeName, htmlContent, folder.id);

            await shareFolder(accessToken, folder.id);

            return jsonResponse({
                folderId: folder.id,
                folderUrl: `https://drive.google.com/drive/folders/${folder.id}`,
                fileId: file.id,
                fileUrl: `https://drive.google.com/file/d/${file.id}/view`,
            });
        } catch (e) {
            return jsonResponse({ error: e.message }, 500);
        }
    },
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
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
