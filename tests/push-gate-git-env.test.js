// Git's repository variables never reach the tests the push gate runs (2 Oct 2026).
//
// Git starts the pre-push hook of a linked worktree with GIT_DIR set to the real
// repository (from the main checkout it sets none, which is why this stayed
// hidden). scripts/pre-push started vitest with that inherited, and the tests that build a throwaway
// repository in a temp folder (`git init`, `git config`, `git commit`, `git push`)
// ran every one of those commands against the REAL repository. A push to main
// from a worktree left the shared config reading `bare = true` with hooks off and
// a test identity, moved the branch and HEAD on to fixture commits, and pushed a
// fixture branch to GitHub. Two guards, each driven for real here:
//   1. scripts/pre-push clears the variables before it starts anything;
//   2. tests/setup-git-env.js clears them inside every test file, whatever
//      started the run.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// The pure module, never the setup file: importing the setup file here would clear the
// variables in this file by itself and the probe below would prove nothing.
import { clearGitLocalEnv, GIT_LOCAL_ENV_VARS } from './git-local-env.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRE_PUSH = join(ROOT, 'scripts', 'pre-push');
const DECOY = '/nonexistent/decoy-repo.git';
// Every repository variable git knows, set to a decoy, plus one numbered config pair. A push from a linked
// worktree sets GIT_DIR and GIT_PREFIX; commit hooks set more (GIT_INDEX_FILE). All of them must go, so a
// hand-written partial list in the hook cannot pass.
const HOOK_ENV = { ...Object.fromEntries(GIT_LOCAL_ENV_VARS.map((k) => [k, DECOY + '/' + k.toLowerCase()])),
                   GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true' };

describe('the push gate keeps git\'s own variables away from the tests', () => {
  it('scripts/pre-push starts both suites with none of them set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'push-gate-env-'));
    try {
      // The gate checks its runners are installed before it starts them.
      mkdirSync(join(dir, 'node_modules', 'vitest'), { recursive: true });
      mkdirSync(join(dir, 'node_modules', '@playwright'), { recursive: true });
      // A stand-in for npx that records the environment each suite would run in.
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const seen = join(dir, 'seen.txt');
      writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "RUN $1" >> "${seen}"\nenv | grep '^GIT_' >> "${seen}"\nexit 0\n`);
      chmodSync(join(bin, 'npx'), 0o755);
      const r = spawnSync('bash', [PRE_PUSH, 'origin', 'https://example.invalid/repo.git'], {
        cwd: dir, encoding: 'utf8', timeout: 60000,
        input: 'refs/heads/topic 1111111111111111111111111111111111111111 refs/heads/main 2222222222222222222222222222222222222222\n',
        env: { ...process.env, ...HOOK_ENV, PATH: `${bin}:${process.env.PATH}`, GATE_LOG: join(dir, 'gate.log'), SKIP_SYNC_TESTS: '' },
      });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      const text = readFileSync(seen, 'utf8');
      // control: both suites really were started through the stand-in
      expect(text.match(/^RUN (vitest|playwright)$/gm)).toEqual(['RUN vitest', 'RUN playwright']);
      for (const name of Object.keys(HOOK_ENV)) expect(text, name).not.toContain(name + '=');
      expect(text).not.toContain(DECOY);
      // and the gate still logged its decision
      expect(readFileSync(join(dir, 'gate.log'), 'utf8')).toContain('RAN\tvitest + playwright');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the list cleared is git\'s own list of repository variables', () => {
    const real = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(real.length).toBeGreaterThan(8);
    expect(real.filter((v) => !GIT_LOCAL_ENV_VARS.includes(v))).toEqual([]);
    const env = clearGitLocalEnv({ ...HOOK_ENV, GIT_AUTHOR_NAME: 'kept', PATH: '/usr/bin' });
    expect(env).toEqual({ GIT_AUTHOR_NAME: 'kept', PATH: '/usr/bin' });
  });

  // The inner run of this same file, started the way a hook would start it.
  it('probe: inside a test file the variables are gone', () => {
    if (!process.env.PUSH_GATE_PROBE) return;
    for (const name of Object.keys(HOOK_ENV)) expect(process.env[name], name).toBeUndefined();
    writeFileSync(process.env.PUSH_GATE_PROBE, 'probe ran');
  });

  it('a vitest run started with them set clears them before any test runs', () => {
    if (process.env.PUSH_GATE_PROBE) return; // the inner run never starts another one
    const dir = mkdtempSync(join(tmpdir(), 'push-gate-probe-'));
    try {
      const marker = join(dir, 'probe.txt');
      const r = spawnSync('npx', ['vitest', 'run', 'tests/push-gate-git-env.test.js', '-t', 'probe: inside a test file'], {
        // under vitest's 60 s worker window, so a slow inner run is a plain failure, not a worker timeout
        cwd: ROOT, encoding: 'utf8', timeout: 50000,
        env: { ...process.env, ...HOOK_ENV, PUSH_GATE_PROBE: marker },
      });
      expect(r.status, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-500)).toBe(0);
      // control: the probe really ran in the inner run, it was not filtered out
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
