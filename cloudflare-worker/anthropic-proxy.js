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
  'https://leadership-dashboard-gamma.vercel.app', // Supabase build on Vercel
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

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : 'null';

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

    if (allowOrigin === 'null') {
      return new Response(JSON.stringify({ error: 'Origin not allowed', origin }), {
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
