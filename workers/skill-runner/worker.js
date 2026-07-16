// Skill Runner Worker — Claude API Proxy
// POST /run  { skillName, command, instructions, userPrompt? }
// Returns streamed or JSON response from Claude API
//
// AUTH (the repo is public, so the worker URL is public):
//   - Browser calls: the Origin header must exactly match ALLOWED_ORIGINS.
//     Browsers cannot spoof Origin, so an exact-match allow-list is the
//     authentication for in-app calls. The matched origin is reflected in
//     Access-Control-Allow-Origin — never '*'.
//   - Script/automation calls: send  Authorization: Bearer <SKILL_RUNNER_TOKEN>
//     (optional secret; only checked if the caller has no allow-listed Origin).
//   - Everything else: 403.
//
// Secrets required: ANTHROPIC_API_KEY
// Optional secrets: SKILL_RUNNER_TOKEN (bearer token for non-browser callers)
// Optional vars:    ALLOWED_ORIGINS_EXTRA (comma-separated extra origins)

const ALLOWED_ORIGINS = [
    'https://chaichoong.github.io',
    'http://localhost:8765', // local preview
];

// ── Best-effort per-IP rate limit ────────────────────────────────────
// NOTE: this is an in-memory limiter, so it is PER ISOLATE. Cloudflare
// runs many isolates across its edge, so a determined attacker can exceed
// the global rate; this only blunts naive abuse from a single POP. No
// other worker in this repo has a KV/Durable Object rate-limit pattern to
// copy — if abuse becomes real, move this to a Durable Object counter.
const RATE_LIMIT = 20;            // max requests
const RATE_WINDOW_MS = 60 * 1000; // per minute, per IP
const rateBuckets = new Map();

function rateLimited(ip) {
    const now = Date.now();
    let bucket = rateBuckets.get(ip);
    if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
        bucket = { start: now, count: 0 };
        rateBuckets.set(ip, bucket);
    }
    bucket.count++;
    // Opportunistic cleanup so the map cannot grow without bound
    if (rateBuckets.size > 5000) {
        for (const [k, v] of rateBuckets) {
            if (now - v.start > RATE_WINDOW_MS) rateBuckets.delete(k);
        }
    }
    return bucket.count > RATE_LIMIT;
}

function allowedOrigins(env) {
    const extra = (env.ALLOWED_ORIGINS_EXTRA || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    return ALLOWED_ORIGINS.concat(extra);
}

// Returns the origin to reflect in CORS headers, or null if not allowed.
function matchOrigin(request, env) {
    const origin = request.headers.get('Origin') || '';
    return allowedOrigins(env).includes(origin) ? origin : null;
}

function hasServiceToken(request, env) {
    if (!env.SKILL_RUNNER_TOKEN) return false;
    const auth = request.headers.get('Authorization') || '';
    return auth === `Bearer ${env.SKILL_RUNNER_TOKEN}`;
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
        const allowOrigin = matchOrigin(request, env);

        if (request.method === 'OPTIONS') {
            // Preflight: only answer for allow-listed origins.
            if (!allowOrigin) return new Response(null, { status: 403 });
            return new Response(null, { status: 204, headers: corsHeaders(allowOrigin) });
        }

        // Auth gate: allow-listed browser Origin OR service bearer token.
        if (!allowOrigin && !hasServiceToken(request, env)) {
            return jsonResponse({ error: 'Forbidden: origin not allowed and no valid service token' }, 403, allowOrigin);
        }

        // Best-effort per-IP rate limit (see note above).
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (rateLimited(ip)) {
            return jsonResponse({ error: 'Rate limit exceeded. Try again in a minute.' }, 429, allowOrigin);
        }

        if (request.method !== 'POST') {
            return jsonResponse({ error: 'POST required' }, 405, allowOrigin);
        }

        const url = new URL(request.url);

        if (url.pathname === '/run') {
            return handleRun(request, env, allowOrigin);
        }

        if (url.pathname === '/test') {
            const hasKey = !!env.ANTHROPIC_API_KEY;
            return jsonResponse({ status: hasKey ? 'ok' : 'missing_key', keyConfigured: hasKey }, 200, allowOrigin);
        }

        return jsonResponse({ error: 'Unknown endpoint. Use POST /run' }, 404, allowOrigin);
    },
};

async function handleRun(request, env, allowOrigin) {
    if (!env.ANTHROPIC_API_KEY) {
        return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured. Run: echo "sk-..." | npx wrangler secret put ANTHROPIC_API_KEY' }, 500, allowOrigin);
    }

    let body;
    try {
        body = await request.json();
    } catch (e) {
        return jsonResponse({ error: 'Invalid JSON body' }, 400, allowOrigin);
    }

    const { skillName, command, instructions, userPrompt } = body;
    if (!skillName && !instructions) {
        return jsonResponse({ error: 'skillName or instructions required' }, 400, allowOrigin);
    }

    // Build the system prompt from the skill definition
    const systemParts = [];
    if (skillName) systemParts.push(`You are executing the "${skillName}" skill.`);
    if (command) systemParts.push(`Skill command: /${command}`);
    if (instructions) systemParts.push(`Skill instructions:\n${instructions}`);
    const systemPrompt = systemParts.join('\n\n');

    // User message
    const userMessage = userPrompt || `Execute this skill now. Follow the instructions precisely and produce the output.`;

    try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                // Model ID lives in wrangler.toml [vars] — never hardcode it here.
                model: env.AI_MODEL_DEFAULT,
                max_tokens: 4096,
                system: systemPrompt,
                messages: [{ role: 'user', content: userMessage }],
            }),
        });

        if (!claudeRes.ok) {
            const errText = await claudeRes.text();
            return jsonResponse({ error: 'Claude API error: ' + errText }, claudeRes.status, allowOrigin);
        }

        const result = await claudeRes.json();
        const text = (result.content || []).map(b => b.text || '').join('\n');

        return jsonResponse({
            skillName: skillName || 'Custom',
            output: text,
            model: result.model,
            usage: result.usage,
        }, 200, allowOrigin);
    } catch (e) {
        return jsonResponse({ error: 'Request failed: ' + e.message }, 500, allowOrigin);
    }
}

function jsonResponse(data, status = 200, allowOrigin = null) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(allowOrigin) },
    });
}
