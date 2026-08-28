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
//
// Two harnesses, because the sources behave differently. The CONFIG controls
// run under a fixture HOME, and fire before the health check is ever reached.
// The HEALTH controls must use the real HOME, because `claude mcp list` reads
// far more than ~/.claude.json and reports nothing under a synthetic one — so a
// fixture HOME could not tell a real failure from an artificial one.
describe('generator refuses to write on a bad read', () => {
    const script = resolve(ROOT, 'scripts/generate-mcp-inventory.py');

    const goodAuth = Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => [`plugin:x:${k}`, { timestamp: 1 }])
    );
    const goodJson = {
        projects: { [ROOT]: { mcpServers: { github: {}, metricool: {} } } },
        claudeAiMcpEverConnected: ['claude.ai Airtable', 'claude.ai Gmail', 'claude.ai Slack'],
        pluginUsage: {},
    };

    function tmpHome(claudeJson, needsAuth) {
        const home = mkdtempSync(join(tmpdir(), 'mcp-inv-'));
        writeFileSync(join(home, '.claude.json'), JSON.stringify(claudeJson));
        execFileSync('mkdir', ['-p', join(home, '.claude')]);
        writeFileSync(join(home, '.claude', 'mcp-needs-auth-cache.json'),
            JSON.stringify(needsAuth));
        return home;
    }

    // --out keeps every fixture away from the real js/mcp-tools-data.js.
    function run(env, out) {
        try {
            return { status: 0, stdout: execFileSync('python3', [script, '--out', out],
                { env, encoding: 'utf8' }) };
        } catch (e) {
            return { status: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
        }
    }

    function runFixture(claudeJson, needsAuth) {
        const home = tmpHome(claudeJson, needsAuth);
        return run({ ...process.env, HOME: home }, join(home, 'out.js')).status;
    }

    it('fails when no MCP server is configured anywhere', () => {
        expect(runFixture({ ...goodJson, projects: {} }, goodAuth)).toBe(1);
    });

    it('fails when the claude.ai connector list is empty', () => {
        expect(runFixture({ ...goodJson, claudeAiMcpEverConnected: [] }, goodAuth)).toBe(1);
    });

    it('fails when the needs-auth cache is empty', () => {
        expect(runFixture(goodJson, {})).toBe(1);
    });

    it('refuses to write when the health check finds nothing', () => {
        // THE BUG THIS CATCHES (28 Aug 2026). MCP servers are stored per project
        // in ~/.claude.json, keyed by working directory. Under launchd the job
        // inherited a different cwd, so `claude mcp list` printed "No MCP servers
        // configured" and exited 0. The generator believed it, wrote github as
        // "Not checked" instead of "Connected", and dropped Kevin's reachable
        // count from 21 to 20. It would have published that as fact every night.
        //
        // Copy the REAL config into a home with no ~/.local/bin/claude, and
        // strip PATH. The config reads then succeed so we actually reach the
        // health check, and the binary cannot be found, which reproduces the
        // same empty-health condition the wrong cwd produced. Pointing HOME at
        // the real home would not work: the fallback binary path is deliberately
        // robust enough to find claude even with PATH stripped.
        const home = mkdtempSync(join(tmpdir(), 'mcp-health-'));
        execFileSync('mkdir', ['-p', join(home, '.claude')]);
        writeFileSync(join(home, '.claude.json'),
            readFileSync(join(homedir(), '.claude.json'), 'utf8'));
        writeFileSync(join(home, '.claude', 'mcp-needs-auth-cache.json'),
            readFileSync(join(homedir(), '.claude', 'mcp-needs-auth-cache.json'), 'utf8'));
        const out = join(home, 'out.js');
        const r = run({ HOME: home, PATH: '/usr/bin:/bin' }, out);
        expect(r.status, 'an unreadable health check must not produce a file').toBe(1);
        expect(r.stderr).toContain('failed check, not an empty estate');
        expect(existsSync(out), 'nothing should have been written').toBe(false);
    }, 30_000);

    it('pins the working directory when checking health', () => {
        // The cwd is the actual root cause. A future edit that drops it would
        // reintroduce a bug that only shows up in the unattended run.
        expect(read('scripts/generate-mcp-inventory.py'),
            'live_health() must pass cwd=REPO to the subprocess')
            .toMatch(/timeout=120,\s*cwd=REPO/);
    });

    it('says when the list has moved, and stays quiet when it has not', () => {
        // The page is served from GitHub Pages, so regenerating on the Mac does
        // not update what Kevin sees. The generator's job is to say when there is
        // something worth shipping, and to leave the file alone otherwise: a diff
        // on js/mcp-tools-data.js IS the alert, so a nightly no-op rewrite would
        // both destroy that signal and leave a permanently dirty tracked file.
        const out = join(mkdtempSync(join(tmpdir(), 'mcp-chg-')), 'out.js');
        const env = { ...process.env };

        expect(run(env, out).stdout).toContain('first run');

        const stamp = statSync(out).mtimeMs;
        expect(run(env, out).stdout).toContain('No change since the committed list');
        expect(statSync(out).mtimeMs,
            'the generator rewrote an unchanged file').toBe(stamp);

        // Drop a tool from the previous file: it must notice and name it.
        const prev = readFileSync(out, 'utf8');
        const i = prev.indexOf('var MCP_TOOLS = ') + 'var MCP_TOOLS = '.length;
        const parsed = JSON.parse(prev.slice(i).trim().replace(/;$/, ''));
        const dropped = parsed.groups.find((g) => g.tools.length).tools.shift().name;
        writeFileSync(out, prev.slice(0, i) + JSON.stringify(parsed) + ';\n');
        const after = run(env, out).stdout;
        expect(after).toContain('CHANGED');
        expect(after).toContain(dropped);
    }, 60_000);

    it('never writes to the real data file', () => {
        // The bug this catches: the generator wrote to a fixed path regardless
        // of --out, so running it under a fixture replaced the live 43-tool list
        // with a 23-tool fixture and nothing errored.
        const before = read('js/mcp-tools-data.js');
        runFixture(goodJson, goodAuth);
        run({ ...process.env }, join(mkdtempSync(join(tmpdir(), 'mcp-x-')), 'out.js'));
        expect(read('js/mcp-tools-data.js')).toBe(before);
    }, 60_000);


    it.runIf(hasSources)('reports the same health however the job was launched', () => {
        // THE REAL ROOT CAUSE (28 Aug 2026). The github server starts via `npx`,
        // so a PATH without node makes `claude mcp list` say "Failed to connect".
        // That is true of the environment the check ran in and false of Kevin's.
        // launchd gives a job PATH=/usr/bin:/bin and no shell profile, so the
        // first unattended run measured ITSELF and published github as
        // "Not checked", dropping the reachable count from 21 to 20.
        //
        // The invariant, and the only one worth asserting: the answer must not
        // depend on who launched the job. A wrong cwd or a thin PATH must not
        // change what this says about the estate.
        const dir = mkdtempSync(join(tmpdir(), 'mcp-env-'));
        const rich = join(dir, 'rich.js');
        const thin = join(dir, 'thin.js');

        expect(run({ ...process.env }, rich).status).toBe(0);
        // env -i equivalent: no inherited PATH, no shell profile, foreign cwd.
        expect(run({ HOME: homedir(), PATH: '/usr/bin:/bin' }, thin).status).toBe(0);

        const authOf = (f) => {
            const src = readFileSync(f, 'utf8');
            const i = src.indexOf('var MCP_TOOLS = ') + 'var MCP_TOOLS = '.length;
            const d = JSON.parse(src.slice(i).trim().replace(/;$/, ''));
            return Object.fromEntries(
                d.groups.flatMap((g) => g.tools).map((t) => [t.name, t.auth]));
        };
        expect(authOf(thin),
            'a thin launchd-style environment reported different health to an '
            + 'interactive one — the check is measuring itself, not the estate')
            .toEqual(authOf(rich));
    }, 60_000);

    it('control: a good read really does succeed', () => {
        // Without this, every check above would pass even if the generator were
        // simply broken and always exited 1.
        const out = join(mkdtempSync(join(tmpdir(), 'mcp-ok-')), 'out.js');
        expect(run({ ...process.env }, out).status).toBe(0);
        expect(existsSync(out)).toBe(true);
    }, 30_000);
});
