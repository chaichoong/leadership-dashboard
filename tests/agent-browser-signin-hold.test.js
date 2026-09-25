// Kevin, 25 Sep 2026: "The robot sign-in didn't work for Cloudflare ... the
// Chrome icon in my menu bar keeps flicking on and off with nothing happening."
// Two causes, both pinned here against the real script.
//
// 1. A bot check read as a live session. Cloudflare's dashboard showed the
//    robot "Performing security verification / Verify you are human" on its
//    own address with no password box, so the sign-in app opened no window
//    and handed the task back into the same wall.
// 2. A sign-in and a running agent fought for the one robot profile. The
//    insurance agent launched Chrome 40 times in 35 minutes; a sign-in window
//    had to catch a gap. Now `login` takes a hold first: the step in flight
//    finishes, no new step starts, his window opens, and the hold ends when
//    it closes.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require_ = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'agent-browser.js');
const b = require_(SCRIPT);

const made = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const running = (dir) => spawnSync('pgrep', ['-f', `user-data-dir=${dir}`]).status === 0;

// A throwaway HOME: the robot profile, its ledger and its hold all live under it.
function home() {
  const h = mkdtempSync(join(tmpdir(), 'od-hold-'));
  made.push(h);
  const root = join(h, '.config', 'od', 'agent-browser');
  mkdirSync(join(root, 'default'), { recursive: true });
  const sites = join(root, 'sites.json');
  writeFileSync(sites, JSON.stringify({ 'www.example.com': { label: 'Example', login: true, loginUrl: 'https://www.example.com/' } }));
  return { h, dir: join(root, 'default'), sites };
}

describe('a bot check is never a live session', () => {
  it('reads Cloudflare\'s "verify you are human" page as not signed in, and the real dashboard as signed in', () => {
    // The words and title of the page the agent photographed at 16:05 on 25 Sep 2026.
    const wall = 'dash.cloudflare.com Performing security verification This website uses a security service to protect against malicious bots. Verify you are human';
    expect(b.sessionVerdict('https://dash.cloudflare.com/', 0, wall, 'Just a moment...')).toMatchObject({ signedIn: false, botCheck: true });
    expect(b.sessionVerdict('https://dash.cloudflare.com/', 0, '', 'Just a moment...')).toMatchObject({ signedIn: false, botCheck: true });
    expect(b.sessionVerdict('https://dash.cloudflare.com/', 0, 'Verify you are human by completing the action below.', '')).toMatchObject({ signedIn: false, botCheck: true });
    expect(b.sessionVerdict('https://dash.cloudflare.com/abc/operationsdirector.co.uk/dns', 0, 'DNS Records Add record', 'DNS | Cloudflare')).toMatchObject({ signedIn: true, botCheck: false });
    // "just a moment" in ordinary page text is not a challenge; only the challenge's title is.
    expect(b.sessionVerdict('https://app.pingen.com/dashboard', 0, 'Just a moment while your letters load', 'Pingen')).toMatchObject({ signedIn: true, botCheck: false });
    // The old two-argument callers are unchanged.
    expect(b.sessionVerdict('https://app.pingen.com/dashboard', 0).signedIn).toBe(true);
  });
});

describe('Kevin\'s sign-in holds the robot profile', () => {
  it('a hold stands only while its process lives and for at most 20 minutes, and release removes it', () => {
    const { dir } = home();
    expect(b.signinHoldActive(dir)).toBe(false);
    b.takeSigninHold(dir);
    expect(b.signinHoldActive(dir)).toBe(true);
    expect(b.signinHoldActive(dir, Date.now() + b.HOLD_MAX_MS + 1000)).toBe(false);
    b.releaseSigninHold(dir);
    expect(existsSync(dir + '.signin-hold')).toBe(false);
    // A sign-in that crashed leaves its file behind; a dead owner frees the profile.
    const dead = spawnSync('true').pid;
    writeFileSync(dir + '.signin-hold', JSON.stringify({ pid: dead, at: Date.now() }));
    expect(b.signinHoldActive(dir)).toBe(false);
  });

  it('an agent step does not start while the hold stands (drives the real read command)', async () => {
    const { h, dir, sites } = home();
    // Held by this test process, which is alive for the whole test.
    writeFileSync(dir + '.signin-hold', JSON.stringify({ pid: process.pid, at: Date.now() }));
    const child = spawn(process.execPath, [SCRIPT, 'read', '--url', 'https://www.example.com/'], {
      env: { ...process.env, HOME: h, AGENT_BROWSER_SITES_FILE: sites }, stdio: 'ignore',
    });
    let exited = false;
    child.on('exit', () => { exited = true; });
    try {
      await sleep(4000);
      expect(exited).toBe(false);          // still waiting on the hold
      expect(running(dir)).toBe(false);    // and no Chrome on the profile
    } finally {
      child.kill('SIGKILL');
    }
  }, 15000);

  it('login takes the hold BEFORE the agent\'s step ends, opens the window after it, and releases on close', async () => {
    const { h, dir, sites } = home();
    // A fake `open`: records when it was called and runs a stand-in window
    // (a process whose command line carries the profile, as Chrome's does;
    // the ": " stops sh from exec'ing sleep and dropping that command line).
    const bin = join(h, 'bin');
    mkdirSync(bin);
    const log = join(h, 'open.log');
    writeFileSync(join(bin, 'open'), `#!/bin/sh
for a in "$@"; do case "$a" in --user-data-dir=*) d="$a";; esac; done
echo "$(date +%s) $d" >> ${JSON.stringify(log)}
nohup sh -c 'sleep 3; :' "$d" >/dev/null 2>&1 &
`);
    chmodSync(join(bin, 'open'), 0o755);
    // The agent's step, already running on the profile, ends in 3 seconds.
    const step = spawn('sh', ['-c', 'sleep 3; :', `--user-data-dir=${dir}`], { stdio: 'ignore' });
    await sleep(300);
    expect(running(dir)).toBe(true);
    const child = spawn(process.execPath, [SCRIPT, 'login', '--url', 'https://www.example.com/'], {
      env: { ...process.env, HOME: h, AGENT_BROWSER_SITES_FILE: sites, PATH: `${bin}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const done = new Promise(r => child.on('exit', code => r(code)));
    try {
      await sleep(1200);
      // The hold stands while the step is still running, and no window yet.
      expect(b.signinHoldActive(dir)).toBe(true);
      expect(existsSync(log)).toBe(false);
      const code = await done;
      expect(code).toBe(0);
      expect(readFileSync(log, 'utf8')).toContain(`--user-data-dir=${dir}`);
      expect(out).toMatch(/Plain Chrome window open for www\.example\.com/);
      expect(existsSync(dir + '.signin-hold')).toBe(false);
    } finally {
      child.kill('SIGKILL');
      step.kill('SIGKILL');
    }
  }, 30000);
});
