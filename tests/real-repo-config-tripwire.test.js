// The tripwire in tests/real-repo-config-tripwire.js, proved on a throwaway repository (Kevin's
// approved build, task recUoY0aovRqJTG6R). It never writes to this repository.
//
// Each case builds a fresh repository in a temp folder holding this repo's REAL vitest.config.js and
// the files it loads, plus one probe test, then starts a real inner vitest run there. The probe does
// to that throwaway repository what the push gate's tests did to this one on 2 Oct 2026. The inner
// run must FAIL for the incident's settings and PASS for ordinary config traffic (a branch section).
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../vitest.config.js';
import { sharedConfigPath, readWatched, diffWatched } from './real-repo-config-tripwire.js';
import { clearGitLocalEnv } from './git-local-env.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The real config and every file it loads, copied as they are.
const CARRIED = ['vitest.config.js', 'tests/real-repo-config-tripwire.js', 'tests/git-local-env.js',
  'tests/setup-git-env.js', 'tests/setup-yield.js', 'tests/clock-skew-reporter.js'];

const PROBE = `
import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
it('probe', () => {
  const set = { bare: ['core.bare', 'true'], hooks: ['core.hooksPath', '/dev/null'], user: ['user.name', 't'],
                gpg: ['commit.gpgsign', 'false'], branch: ['branch.feature-x.remote', 'origin'] }[process.env.TRIPWIRE_PROBE];
  if (set) execFileSync('git', ['config', ...set], { cwd: process.cwd() });
});
`;

function innerRun(probe, { git = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tripwire-'));
  try {
    for (const f of CARRIED) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      copyFileSync(join(ROOT, f), join(dir, f));
    }
    writeFileSync(join(dir, 'tests', 'probe.test.js'), PROBE);
    writeFileSync(join(dir, 'package.json'), '{"type": "module"}');
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const env = clearGitLocalEnv({ ...process.env });
    if (git) execFileSync('git', ['init', '-q'], { cwd: dir, env });
    const before = git ? readWatched(sharedConfigPath(dir)) : null;
    const r = spawnSync('npx', ['vitest', 'run'], {
      cwd: dir, encoding: 'utf8', timeout: 50000, env: { ...env, TRIPWIRE_PROBE: probe },
    });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), before };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the real-repo git config tripwire', () => {
  if (process.env.TRIPWIRE_PROBE) return;   // never inside an inner run
  const realBefore = readWatched(sharedConfigPath());

  it('is wired into this repository\'s vitest config as a global setup', () => {
    expect(config.test.globalSetup).toContain('tests/real-repo-config-tripwire.js');
  });

  it('reads this repository\'s shared config and sees core.bare (control: a blind read is not a pass)', () => {
    const watched = readWatched(sharedConfigPath());
    expect(watched['core.bare']).toEqual(['false']);
    expect(watched['core.hookspath']).toBeUndefined();
  });

  for (const [probe, key, after] of [['bare', 'core.bare', 'true'], ['hooks', 'core.hookspath', '/dev/null'],
    ['user', 'user.name', 't'], ['gpg', 'commit.gpgsign', 'false']]) {
    it(`a test run that sets ${key} on its own repository FAILS, naming it`, () => {
      const r = innerRun(probe);
      expect(r.before['core.bare'], 'control: the throwaway repository was read').toEqual(['false']);
      expect(r.status, r.out.slice(-1500)).not.toBe(0);
      expect(r.out).toMatch(/REAL REPO CONFIG TRIPWIRE/);
      expect(r.out).toContain(`${key}: ${r.before[key] ? r.before[key].join(', ') : '(not set)'} -> ${after}`);
    }, 60000);
  }

  it('a run that adds only a branch section passes (ordinary config traffic never trips it)', () => {
    const r = innerRun('branch');
    expect(r.status, r.out.slice(-1500)).toBe(0);
    expect(r.out).toMatch(/1 passed/);   // control: the probe really ran
  }, 60000);

  it('a copy with no git repository (a git archive export) runs its tests, with a one-line note', () => {
    const r = innerRun('none', { git: false });
    expect(r.status, r.out.slice(-1500)).toBe(0);
    expect(r.out).toMatch(/real-repo config tripwire: skipped, .* is not a git checkout/);
    expect(r.out).toMatch(/1 passed/);   // control: the tests still ran
  }, 60000);

  it('a run that touches nothing passes', () => {
    const r = innerRun('none');
    expect(r.status, r.out.slice(-1500)).toBe(0);
    expect(r.out).toMatch(/1 passed/);
  }, 60000);

  it('the diff names each moved setting and ignores the rest', () => {
    expect(diffWatched({ 'core.bare': ['false'] }, { 'core.bare': ['true'], 'core.hookspath': ['/dev/null'] }))
      .toEqual(['core.bare: false -> true', 'core.hookspath: (not set) -> /dev/null']);
    expect(diffWatched({ 'core.bare': ['false'] }, { 'core.bare': ['false'] })).toEqual([]);
  });

  it('none of the above touched this repository\'s own settings', () => {
    expect(diffWatched(realBefore, readWatched(sharedConfigPath()))).toEqual([]);
  });
});
