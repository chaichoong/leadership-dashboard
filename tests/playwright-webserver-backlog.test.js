// The Playwright test web server must not reset connections under a burst.
//
// Found 29 Sep 2026: every full sync-invariant run failed 4-16 tests, a different set each
// time, each passing alone, all as "switchTab / loadDashboard / allCategories is not
// defined" (a <script> that never loaded). Cause: socketserver's default listen backlog
// of 5. macOS resets a connection that arrives while the backlog is full, and Chrome does
// not retry a reset script. Measured: 24 simultaneous requests lost 13-16 at the default,
// 0 at request_queue_size = 128.
//
// This drives the REAL command from playwright.config.js (not a copy of it) with the same
// burst. Back-tested: with the request_queue_size line removed from the config it fails.

import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import http from 'http';
import net from 'net';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);

function freePort() {
    return Number(execFileSync(process.execPath, ['-e',
        "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});",
    ]).toString());
}

async function waitForListen(port, ms = 8000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const up = await new Promise(res => {
            const c = net.connect(port, '127.0.0.1', () => { c.destroy(); res(true); });
            c.on('error', () => res(false));
        });
        if (up) return;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('test web server never started listening on ' + port);
}

function get(port) {
    return new Promise(res => {
        const req = http.get({ host: '127.0.0.1', port, path: '/js/dashboard.js', agent: false }, r => {
            r.resume();
            r.on('end', () => res(r.statusCode));
        });
        req.on('error', e => res(e.code || e.message));
        req.setTimeout(10000, () => { req.destroy(); res('timeout'); });
    });
}

describe('Playwright test web server', () => {
    it('answers a 24-connection burst (4 browsers x 6 connections) with no resets', async () => {
        const { webServer } = require_(resolve(ROOT, 'playwright.config.js'));
        const port = freePort();
        const command = webServer.command.replace(`('', ${webServer.port})`, `('', ${port})`);
        expect(command, 'could not retarget the configured port').toContain(`('', ${port})`);

        const server = spawn('/bin/sh', ['-c', command], { cwd: ROOT, stdio: 'ignore', detached: true });
        try {
            await waitForListen(port);
            // Three bursts: one lucky pass must not read as a fix.
            for (let burst = 0; burst < 3; burst++) {
                const results = await Promise.all(Array.from({ length: 24 }, () => get(port)));
                const failures = results.filter(s => s !== 200);
                expect(failures, `burst ${burst + 1}: connections reset or failed`).toEqual([]);
            }
        } finally {
            try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ }
        }
    }, 30000);
});
