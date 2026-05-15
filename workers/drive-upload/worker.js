// Google Drive SOP Upload Worker
// POST /upload  { workflowName, htmlContent, fileName }
// Returns { folderId, folderUrl, fileId, fileUrl }

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
    async fetch(request, env) {
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

            const accessToken = await getAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
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

// Google OAuth2 JWT flow for service accounts
async function getAccessToken(serviceAccountJson) {
    const sa = JSON.parse(serviceAccountJson);
    const now = Math.floor(Date.now() / 1000);

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64url(JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/drive',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    }));

    const signingInput = `${header}.${claim}`;
    const signature = await signRS256(signingInput, sa.private_key);
    const jwt = `${signingInput}.${signature}`;

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });

    if (!res.ok) throw new Error('Google auth failed: ' + await res.text());
    const data = await res.json();
    return data.access_token;
}

async function signRS256(input, privateKeyPem) {
    const pemBody = privateKeyPem
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\s/g, '');
    const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

    const key = await crypto.subtle.importKey(
        'pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
    );

    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
    return base64url(new Uint8Array(sig));
}

function base64url(data) {
    let b64;
    if (typeof data === 'string') {
        b64 = btoa(data);
    } else {
        b64 = btoa(String.fromCharCode(...data));
    }
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
