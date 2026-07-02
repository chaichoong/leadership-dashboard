// Cloudflare Worker — claude-proxy
//
// THIS IS THE RECONCILED SOURCE OF THE LIVE `claude-proxy` worker (pulled from
// the Cloudflare dashboard on 2026-07-02 and re-hardened). Two jobs:
//   1. Relay browser AI calls to api.anthropic.com, injecting the server-side
//      key so the key never ships to the browser (in-app AI, P&L, Skills, Tasks
//      all rely on this — they send NO key of their own).
//   2. Store the Inbound-Comms shared knowledge base in KV (/shared-data).
//
// Auth model (hardened): the old version trusted a plain Origin/Referer STRING,
// which any script can set — that let the monthly-valuations job (and anyone
// else) spend the key by faking the header. Now:
//   - Browser calls: Origin/Referer must match AND a Sec-Fetch-* header must be
//     present. Browsers always send Sec-Fetch metadata; plain HTTP clients
//     (curl/urllib) omit it, so a bare header-spoof no longer passes.
//   - Script/automation calls: send Authorization: Bearer <PROXY_SERVICE_TOKEN>.
//   - Neither → 403.
// Residual risk (a client forging BOTH Origin and Sec-Fetch) is accepted for
// now; the durable fix is per-key rate limiting + moving off browser-injected
// keys at the multi-tenant migration.
//
// Secrets/bindings (already set on the deployed worker; keep them):
//   CLAUDE_API_KEY (secret)      — the Anthropic key, injected server-side
//   PROXY_SERVICE_TOKEN (secret) — bearer token for script callers (NEW)
//   SHARED_DATA (KV namespace)   — knowledge-base store for /shared-data
//   SLACK_BOT_TOKEN (secret)     — vestigial, unused by this code; left in place

const ALLOWED_ORIGIN = 'https://chaichoong.github.io';

function isBrowserCall(request) {
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  const originOk = origin === ALLOWED_ORIGIN || referer.startsWith(ALLOWED_ORIGIN + '/');
  // Real browsers set fetch-metadata headers automatically; scripts that merely
  // set Origin/Referer usually do not.
  const hasFetchMeta = request.headers.get('Sec-Fetch-Site') !== null
    || request.headers.get('Sec-Fetch-Mode') !== null;
  return originOk && hasFetchMeta;
}

function hasServiceToken(request, env) {
  const auth = request.headers.get('Authorization') || '';
  // Two independently named tokens so services can be added or rotated without
  // breaking each other (TOKEN = GitHub valuations job, TOKEN_2 = agent-runner).
  if (env.PROXY_SERVICE_TOKEN && auth === `Bearer ${env.PROXY_SERVICE_TOKEN}`) return true;
  if (env.PROXY_SERVICE_TOKEN_2 && auth === `Bearer ${env.PROXY_SERVICE_TOKEN_2}`) return true;
  return false;
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // CORS preflight — must not require auth.
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Single auth gate: legitimate browser OR a token-bearing script.
    if (!isBrowserCall(request) && !hasServiceToken(request, env)) {
      return new Response('Forbidden', { status: 403, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ============================================================
    // GET /shared-data — Retrieve shared data from KV
    // ============================================================
    if (path === '/shared-data' && request.method === 'GET') {
      try {
        const keys = ['knowledge_base', 'kb_last_built', 'ai_corrections'];
        const result = {};

        for (const key of keys) {
          const stored = await env.SHARED_DATA.get(key);
          if (stored) {
            try {
              result[key] = JSON.parse(stored);
            } catch {
              result[key] = { data: stored, timestamp: 0 };
            }
          }
        }

        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: { message: err.message } }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // ============================================================
    // POST /shared-data — Save shared data to KV
    // ============================================================
    if (path === '/shared-data' && request.method === 'POST') {
      try {
        const { key, data, timestamp } = await request.json();

        if (!key || data === undefined) {
          return new Response(JSON.stringify({ error: { message: 'Missing required fields: key, data' } }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const allowedKeys = ['knowledge_base', 'kb_last_built', 'ai_corrections'];
        if (!allowedKeys.includes(key)) {
          return new Response(JSON.stringify({ error: { message: 'Invalid key. Allowed: ' + allowedKeys.join(', ') } }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const entry = JSON.stringify({
          data: data,
          timestamp: timestamp || Date.now(),
        });

        await env.SHARED_DATA.put(key, entry);

        return new Response(JSON.stringify({ success: true, key }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: { message: err.message } }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }

    // ============================================================
    // POST / — Claude API proxy (server-side key injected)
    // ============================================================
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    try {
      const body = await request.json();

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      const data = await response.text();
      return new Response(data, {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: err.message } }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};
