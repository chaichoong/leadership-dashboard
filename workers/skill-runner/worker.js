// Skill Runner Worker — Claude API Proxy
// POST /run  { skillName, command, instructions, userPrompt? }
// Returns streamed or JSON response from Claude API
// Secrets required: ANTHROPIC_API_KEY

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

        const url = new URL(request.url);

        if (url.pathname === '/run') {
            return handleRun(request, env);
        }

        if (url.pathname === '/test') {
            const hasKey = !!env.ANTHROPIC_API_KEY;
            return jsonResponse({ status: hasKey ? 'ok' : 'missing_key', keyConfigured: hasKey });
        }

        return jsonResponse({ error: 'Unknown endpoint. Use POST /run' }, 404);
    },
};

async function handleRun(request, env) {
    if (!env.ANTHROPIC_API_KEY) {
        return jsonResponse({ error: 'ANTHROPIC_API_KEY not configured. Run: echo "sk-..." | npx wrangler secret put ANTHROPIC_API_KEY' }, 500);
    }

    let body;
    try {
        body = await request.json();
    } catch (e) {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const { skillName, command, instructions, userPrompt } = body;
    if (!skillName && !instructions) {
        return jsonResponse({ error: 'skillName or instructions required' }, 400);
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
                model: 'claude-sonnet-4-6',
                max_tokens: 4096,
                system: systemPrompt,
                messages: [{ role: 'user', content: userMessage }],
            }),
        });

        if (!claudeRes.ok) {
            const errText = await claudeRes.text();
            return jsonResponse({ error: 'Claude API error: ' + errText }, claudeRes.status);
        }

        const result = await claudeRes.json();
        const text = (result.content || []).map(b => b.text || '').join('\n');

        return jsonResponse({
            skillName: skillName || 'Custom',
            output: text,
            model: result.model,
            usage: result.usage,
        });
    } catch (e) {
        return jsonResponse({ error: 'Request failed: ' + e.message }, 500);
    }
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}
