// Loom Transcript Worker
// GET /?id=<loomVideoId>  →  { transcript, words, source }
//
// How it works (no Loom API key needed):
// 1. Fetch the public share page server-side (no browser CORS restriction).
// 2. The page embeds a SIGNED CDN URL to the transcription JSON
//    (cdn.loom.com/mediametadata/transcription/<id>-N.json?Policy=...).
// 3. Fetch that JSON and join phrases[].value into plain text.
// 4. Fallback: the captions VTT URL (same page), stripped to plain text.
//
// Method verified 2026-07-02 against a real video: 68 phrases of genuine
// spoken transcript. This replaces the old title-only oembed fallback that
// meant SOPs were generated from the video TITLE, not its content.

const ALLOWED_ORIGINS = ['https://chaichoong.github.io'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function corsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    return {
        'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

function json(body, status, request) {
    return new Response(JSON.stringify(body), {
        status,
        headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(request)),
    });
}

// The URLs sit inside JSON strings in the page HTML with & escaped as &.
function unescapeUrl(u) {
    return u.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
}

function extractSignedUrl(html, pathPart) {
    const re = new RegExp('https://cdn\\.loom\\.com/mediametadata/' + pathPart + '/[^"]+');
    const m = html.match(re);
    return m ? unescapeUrl(m[0]) : null;
}

// Strip a WebVTT file down to its spoken text.
function vttToText(vtt) {
    return vtt
        .split('\n')
        .filter(line => {
            const l = line.trim();
            if (!l) return false;
            if (l === 'WEBVTT') return false;
            if (/^\d+$/.test(l)) return false;                 // cue numbers
            if (/-->/.test(l)) return false;                   // timestamps
            if (/^(NOTE|STYLE|REGION)\b/.test(l)) return false;
            return true;
        })
        .join(' ')
        .replace(/<[^>]+>/g, '')                               // inline cue tags
        .replace(/\s+/g, ' ')
        .trim();
}

export default {
    async fetch(request) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(request) });
        }
        if (request.method !== 'GET') {
            return json({ error: 'GET required' }, 405, request);
        }

        const url = new URL(request.url);
        const id = (url.searchParams.get('id') || '').trim();
        if (!/^[a-zA-Z0-9]{8,64}$/.test(id)) {
            return json({ error: 'invalid or missing id (expect the Loom share id)' }, 400, request);
        }

        try {
            const pageRes = await fetch(`https://www.loom.com/share/${id}`, {
                headers: { 'User-Agent': UA },
            });
            if (!pageRes.ok) {
                return json({ error: 'share page returned ' + pageRes.status }, 502, request);
            }
            const html = await pageRes.text();

            // Primary: the transcription JSON (full spoken transcript, phrase objects)
            const transcriptionUrl = extractSignedUrl(html, 'transcription');
            if (transcriptionUrl) {
                const tRes = await fetch(transcriptionUrl);
                if (tRes.ok) {
                    const data = await tRes.json();
                    const phrases = Array.isArray(data.phrases) ? data.phrases : [];
                    const text = phrases
                        .map(p => (p && typeof p.value === 'string') ? p.value.trim() : '')
                        .filter(Boolean)
                        .join(' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (text) {
                        return json({ transcript: text, words: text.split(' ').length, source: 'transcription' }, 200, request);
                    }
                }
            }

            // Fallback: captions VTT
            const captionsUrl = extractSignedUrl(html, 'captions');
            if (captionsUrl) {
                const cRes = await fetch(captionsUrl);
                if (cRes.ok) {
                    const text = vttToText(await cRes.text());
                    if (text) {
                        return json({ transcript: text, words: text.split(' ').length, source: 'captions' }, 200, request);
                    }
                }
            }

            return json({ error: 'no transcript found on the share page (video may still be processing, or transcript disabled)' }, 404, request);
        } catch (e) {
            return json({ error: 'transcript fetch failed: ' + e.message }, 500, request);
        }
    },
};
