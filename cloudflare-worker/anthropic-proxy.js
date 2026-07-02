// Cloudflare Worker — Anthropic API proxy
//
// Why this exists:
//   The Operations OS calls api.anthropic.com from the browser. Some
//   browser extensions and corporate networks block direct calls to
//   that host — the request fails with "Failed to fetch" before it
//   even leaves the device. This Worker sits on a *.workers.dev URL
//   that those filters don't touch, forwards every request to
//   api.anthropic.com, and adds the CORS headers Chrome wants.
//
// What it does NOT do:
//   - It does NOT store your API key. You still send the x-api-key
//     header from the browser; the Worker just relays it.
//   - It does NOT log request bodies.
//
// Lock down the origin allow-list before deploying:
//   ALLOWED_ORIGINS controls who can call this Worker. By default
//   we accept the GitHub Pages dashboard host. Add others as needed.
//
// Deploy in 5 minutes:
//   1. Go to dash.cloudflare.com and create a free Workers account.
//   2. Workers & Pages → Create → Create Worker → name it
//      'anthropic-proxy' (or whatever).
//   3. Click 'Quick edit' / 'Edit code' and replace the default code
//      with the contents of this file.
//   4. Deploy. Copy the URL it gives you (something like
//      https://anthropic-proxy.<your-account>.workers.dev).
//   5. In the Operations OS, click any property → Run AI Valuation →
//      when prompted (or via the test button), paste the Worker URL.
//      The page stores it in localStorage and uses it from then on.

const ALLOWED_ORIGINS = [
  'https://chaichoong.github.io',
  'http://localhost:8765', // local preview
];

// Headers the Anthropic SDK sends that we should forward upstream
const FORWARD_HEADERS = new Set([
  'content-type',
  'x-api-key',
  'anthropic-version',
  'anthropic-dangerous-direct-browser-access',
  'anthropic-beta',
]);

// Two call modes, each with its own auth so a spoofed Origin can never make
// the Worker spend the server-side key:
//   1. Browser mode — Origin is in ALLOWED_ORIGINS (browsers cannot forge the
//      Origin header) AND the caller supplies its own x-api-key, which we relay.
//      The Worker injects nothing.
//   2. Server/script mode — no trusted browser Origin, so the caller must
//      present Authorization: Bearer <PROXY_SERVICE_TOKEN>. Only then does the
//      Worker inject env.ANTHROPIC_API_KEY. This is the mode monthly-valuations
//      uses; it removes the old Origin-spoofing workaround.
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const originAllowed = ALLOWED_ORIGINS.includes(origin);
    const allowOrigin = originAllowed ? origin : 'null';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowOrigin),
      });
    }

    // Allow GET on root for a quick health check
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return new Response('Anthropic proxy is alive. POST to /v1/messages.', {
        status: 200,
        headers: { ...corsHeaders(allowOrigin), 'content-type': 'text/plain' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: corsHeaders(allowOrigin),
      });
    }

    // Decide the call mode. A real browser sends Sec-Fetch-* headers; scripts
    // that merely set an Origin string do not — so a browser Origin claim is
    // only trusted alongside those fetch-metadata headers.
    const secFetchSite = request.headers.get('Sec-Fetch-Site');
    const looksLikeBrowser = originAllowed && secFetchSite !== null;
    const serviceToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const serviceAuthed = env && env.PROXY_SERVICE_TOKEN && serviceToken === env.PROXY_SERVICE_TOKEN;

    if (!looksLikeBrowser && !serviceAuthed) {
      return new Response(JSON.stringify({ error: 'Unauthorized — browser Origin or service token required', origin }), {
        status: 403,
        headers: { ...corsHeaders(allowOrigin), 'content-type': 'application/json' },
      });
    }

    // Build upstream request
    const upstreamUrl = 'https://api.anthropic.com' + url.pathname + url.search;
    const upstreamHeaders = new Headers();
    for (const [k, v] of request.headers.entries()) {
      if (FORWARD_HEADERS.has(k.toLowerCase())) upstreamHeaders.set(k, v);
    }
    // Server/script mode: inject the server-side key ONLY for token-authed
    // callers, never for a bare Origin claim. Browser mode relays the caller's
    // own x-api-key untouched.
    if (serviceAuthed && env.ANTHROPIC_API_KEY) {
      upstreamHeaders.set('x-api-key', env.ANTHROPIC_API_KEY);
      if (!upstreamHeaders.has('anthropic-version')) upstreamHeaders.set('anthropic-version', '2023-06-01');
    }

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: request.body,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Upstream fetch failed', message: String(e) }), {
        status: 502,
        headers: { ...corsHeaders(allowOrigin), 'content-type': 'application/json' },
      });
    }

    // Mirror status + body, add CORS
    const respHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders(allowOrigin))) respHeaders.set(k, v);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  },
};

function corsHeaders(allowOrigin) {
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers':
      'Content-Type, X-API-Key, Anthropic-Version, Anthropic-Dangerous-Direct-Browser-Access, Anthropic-Beta',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
