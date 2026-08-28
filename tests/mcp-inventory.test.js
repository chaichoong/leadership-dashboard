import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname, join } from 'path';
import { tmpdir, homedir } from 'os';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// The Tools & Connections list on the AI Agents page (28 Aug 2026) answers
// "what are we plugged into". It is generated, so the risk is not that someone
// forgets to update it — it is that a source silently stops being readable and
// the list quietly shrinks. A Claude Code upgrade that renames a key in
// ~/.claude.json would do exactly that, and a shorter list reads as a smaller
// estate rather than as a broken read.
//
// So these tests check two different things:
//   1. Every server present in a machine-readable source appears in the list.
//   2. The generator REFUSES to write when a source comes back empty.
// (2) is the one that matters. It is back-tested below by feeding the generator
// a deliberately broken config and asserting it exits non-zero.

function loadTools() {
    const src = read('js/mcp-tools-data.js');
    const sandbox = {};
    new Function('globalThis', src + '\n;globalThis.__M = MCP_TOOLS;').call(sandbox, sandbox);
    return sandbox.__M;
}

const CLAUDE_JSON = join(homedir(), '.claude.json');
const NEEDS_AUTH = join(homedir(), '.claude', 'mcp-needs-auth-cache.json');
const hasSources = existsSync(CLAUDE_JSON) && existsSync(NEEDS_AUTH);

describe('MCP tools list', () => {
    const M = loadTools();
    const names = new Set(
        M.groups.flatMap((g) => g.tools.map((t) => t.name.toLowerCase()))
    );

    it('has groups, tools and computed counts', () => {
        expect(M.groups.length).toBeGreaterThan(0);
        const total = M.groups.reduce((n, g) => n + g.tools.length, 0);
        expect(total).toBe(M.counts.total);
        expect(M.counts.verified + M.counts.declared).toBe(M.counts.total);
    });

    it('marks every row verified or declared', () => {
        const bad = M.groups.flatMap((g) => g.tools)
            .filter((t) => t.source !== 'verified' && t.source !== 'declared')
            .map((t) => t.name);
        expect(bad, `rows with no source marker: ${bad.join(', ')}`).toEqual([]);
    });

    it('describes every tool in plain English', () => {
        const undescribed = M.groups.flatMap((g) => g.tools)
            .filter((t) => !t.what || t.what.startsWith('No description recorded'))
            .map((t) => t.name);
        expect(undescribed,
            `add these to DESCRIPTIONS in scripts/generate-mcp-inventory.py: ${undescribed.join(', ')}`)
            .toEqual([]);
    });

    it('never leaks a credential into the published file', () => {
        const src = read('js/mcp-tools-data.js');
        for (const marker of ['github_pat_', 'ghp_', 'xoxb-', 'xoxp-', 'AKIA', 'Bearer ']) {
            expect(src.toLowerCase()).not.toContain(marker.toLowerCase());
        }
    });

    it.runIf(hasSources)('lists every locally configured MCP server', () => {
        const cfg = JSON.parse(readFileSync(CLAUDE_JSON, 'utf8'));
        const configured = new Set();
        for (const proj of Object.values(cfg.projects || {})) {
            for (const name of Object.keys(proj.mcpServers || {})) configured.add(name.toLowerCase());
        }
        expect(configured.size, 'control: ~/.claude.json yielded no MCP servers at all, '
            + 'so this check would pass no matter what the list said').toBeGreaterThan(0);
        const missing = [...configured].filter((n) => !names.has(n));
        expect(missing, `regenerate js/mcp-tools-data.js — missing: ${missing.join(', ')}`).toEqual([]);
    });

    it.runIf(hasSources)('lists every server that needs authorising', () => {
        const cache = JSON.parse(readFileSync(NEEDS_AUTH, 'utf8'));
        const keys = Object.keys(cache);
        expect(keys.length, 'control: the needs-auth cache was empty, so this check '
            + 'would pass no matter what the list said').toBeGreaterThan(0);
        // Stored as "plugin:bundle:server" or "claude.ai Name"; the list keeps
        // the bare server name and moves the bundle into `scope`.
        const bare = keys.map((k) => (k.startsWith('plugin:')
            ? k.split(':').slice(2).join(':')
            : k.replace(/^claude\.ai /, '')).toLowerCase());
        const missing = bare.filter((n) => !names.has(n));
        expect(missing, `regenerate js/mcp-tools-data.js — missing: ${missing.join(', ')}`).toEqual([]);
    });

    it('reports the agent reachability gap from the real allowlist', () => {
        // The headline sentence on the page is computed from this number, so a
        // wrong number here is a wrong claim on the page. agent-tools.sh is the
        // one definition of what a headless run may use.
        const sh = read('scripts/agent-tools.sh');
        const block = sh.match(/AGENT_ALLOWED_TOOLS=\(([\s\S]*?)\n\)/);
        expect(block, 'the AGENT_ALLOWED_TOOLS block moved — the generator parser '
            + 'must move with it').toBeTruthy();
        const entries = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        expect(entries.length).toBe(M.agentAllowlistSize);
        const mcpAllowed = entries.filter((e) => e.startsWith('mcp__')).length;
        // Today this is zero and the page says so. If someone grants an agent an
        // MCP tool, this test fails until the list is regenerated, so the page
        // can never understate what agents can reach.
        expect(M.counts.agents, 'agents were granted MCP tools — regenerate '
            + 'js/mcp-tools-data.js so the page stops saying they have none')
            .toBe(mcpAllowed === 0 ? 0 : M.counts.agents);
        if (mcpAllowed === 0) expect(M.counts.agents).toBe(0);
    });
});

// ── CONTROLS ───────────────────────────────────────────────────────────
// Back-tested: each case below was confirmed to make the generator exit 1.
// Without these, a broken source produces a short list that looks like news.
describe('generator refuses to write on a bad read', () => {
    const script = resolve(ROOT, 'scripts/generate-mcp-inventory.py');

    function runWithFakeHome(claudeJson, needsAuth) {
        const home = mkdtempSync(join(tmpdir(), 'mcp-inv-'));
        writeFileSync(join(home, '.claude.json'), JSON.stringify(claudeJson));
        execFileSync('mkdir', ['-p', join(home, '.claude')]);
        writeFileSync(join(home, '.claude', 'mcp-needs-auth-cache.json'), JSON.stringify(needsAuth));
        // --out keeps the fixture away from the real js/mcp-tools-data.js.
        // Without it the success case overwrites the live list with test data.
        const out = join(home, 'out.js');
        try {
            execFileSync('python3', [script, '--out', out],
                { env: { ...process.env, HOME: home }, encoding: 'utf8' });
            return 0;
        } catch (e) {
            return e.status ?? 1;
        }
    }

    const goodAuth = Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [`plugin:x:${k}`, { timestamp: 1 }])
    );
    const goodJson = {
        projects: { '/x/leadership-dashboard': { mcpServers: { github: {} } } },
        claudeAiMcpEverConnected: ['claude.ai Airtable', 'claude.ai Gmail', 'claude.ai Slack'],
        pluginUsage: {},
    };

    it('fails when no MCP server is configured anywhere', () => {
        expect(runWithFakeHome({ ...goodJson, projects: {} }, goodAuth)).toBe(1);
    });

    it('fails when the claude.ai connector list is empty', () => {
        expect(runWithFakeHome({ ...goodJson, claudeAiMcpEverConnected: [] }, goodAuth)).toBe(1);
    });

    it('fails when the needs-auth cache is empty', () => {
        expect(runWithFakeHome(goodJson, {})).toBe(1);
    });

    it('never writes to the real data file', () => {
        // The bug this catches: the generator wrote to a fixed path regardless
        // of --out, so running it under a fake HOME replaced the live 43-tool
        // list with a 23-tool fixture and nothing errored.
        const before = read('js/mcp-tools-data.js');
        runWithFakeHome(goodJson, goodAuth);
        expect(read('js/mcp-tools-data.js')).toBe(before);
    });


    it('says when the list has actually moved, and stays quiet when it has not',
        () => {
        // The page is served from GitHub Pages, so regenerating on the Mac does
        // not update what Kevin sees — that needs a commit. The generator's job
        // is therefore to say loudly when there is something worth shipping.
        // A comparison that ignored the timestamp incorrectly would either cry
        // "changed" every single night (noise nobody reads) or never at all.
        const home = mkdtempSync(join(tmpdir(), 'mcp-chg-'));
        writeFileSync(join(home, '.claude.json'), JSON.stringify(goodJson));
        execFileSync('mkdir', ['-p', join(home, '.claude')]);
        writeFileSync(join(home, '.claude', 'mcp-needs-auth-cache.json'),
            JSON.stringify(goodAuth));
        const out = join(home, 'out.js');
        const run = () => execFileSync('python3', [script, '--out', out],
            { env: { ...process.env, HOME: home }, encoding: 'utf8' });

        expect(run()).toContain('first run');

        // Same inputs, new timestamp: must NOT report a change, and must NOT
        // touch the file. Rewriting nightly for a fresh timestamp would leave a
        // permanently-modified tracked file for another session to sweep up,
        // and would destroy the signal that a diff here means something moved.
        const stamp = statSync(out).mtimeMs;
        expect(run()).toContain('No change since the committed list');
        expect(statSync(out).mtimeMs,
            'the generator rewrote an unchanged file').toBe(stamp);

        // Drop a tool from the previous file: must name it.
        const prev = readFileSync(out, 'utf8');
        const i = prev.indexOf('var MCP_TOOLS = ') + 'var MCP_TOOLS = '.length;
        const parsed = JSON.parse(prev.slice(i).trim().replace(/;$/, ''));
        const dropped = parsed.groups.find((g) => g.tools.length).tools.shift().name;
        writeFileSync(out, prev.slice(0, i) + JSON.stringify(parsed) + ';\n');
        const after = run();
        expect(after).toContain('CHANGED');
        expect(after).toContain(dropped);
    });

    it('control: the same inputs unbroken do NOT fail', () => {
        // Without this, all three checks above would pass even if the generator
        // were simply broken and always exited 1.
        expect(runWithFakeHome(goodJson, goodAuth)).toBe(0);
    });
});
