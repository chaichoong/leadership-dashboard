// The only gate on main must not turn itself off.
//
// Regression origin: 24 Aug 2026, finding 20260822-ceo-memory-sweep-318.
// Two pushes to main on 21 Aug ran the SAME hook in the SAME checkout with
// different outcomes: the first ran no tests at all, the second ran 211 in
// 3.5 minutes. Reading the hook explained it — a missing node_modules/vitest
// printed a warning and continued, and a missing node_modules/@playwright
// printed a warning and `exit 0`. So an absent or half-installed node_modules
// silently turned the gate into a pass.
//
// That is SKIP_SYNC_TESTS=1 with nobody having to type it, and no record left
// that the gate did not run. The defect was observed on 21 Aug, written up in
// prose, and lost: no finding, no task.
//
// The hook is exercised as a real script with a fake git and fake npx on PATH,
// against a temp directory that stands in for the checkout.
//
// Back-tested: restoring the warn-and-continue branches makes the first two
// cases report exit 0.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK = resolve(__dirname, '..', 'scripts/pre-push');

// A sandbox checkout with stub `git` and `npx` on PATH, so nothing real runs.
function runHook({ vitest = true, playwright = true, npx = true, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prepush-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });

  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho deadbee\n');
  chmodSync(join(bin, 'git'), 0o755);
  if (npx) {
    // Records that it was called, and succeeds.
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "$@" >> ${join(dir, 'npx-calls')}\nexit 0\n`);
    chmodSync(join(bin, 'npx'), 0o755);
  }
  if (vitest) mkdirSync(join(dir, 'node_modules/vitest'), { recursive: true });
  if (playwright) mkdirSync(join(dir, 'node_modules/@playwright'), { recursive: true });

  const gateLog = join(dir, 'gate.log');
  let status = 0;
  let output = '';
  try {
    output = execFileSync('bash', [HOOK, 'origin'], {
      cwd: dir,
      encoding: 'utf8',
      input: 'refs/heads/main abc refs/heads/main def\n',
      // With npx:false the PATH is trimmed to the stub dir plus the base system
      // ones, so the real npx (nvm, /usr/local/bin, ...) cannot be found. Adding
      // process.env.PATH here would let a real npx through and the case would
      // test nothing.
      env: {
        ...process.env,
        ...env,
        PATH: npx ? `${bin}:${process.env.PATH}` : `${bin}:/usr/bin:/bin`,
        GATE_LOG: gateLog,
      },
    });
  } catch (err) {
    status = err.status;
    output = `${err.stdout || ''}${err.stderr || ''}`;
  }
  return {
    status,
    output,
    log: existsSync(gateLog) ? readFileSync(gateLog, 'utf8') : '',
    npxCalls: existsSync(join(dir, 'npx-calls')) ? readFileSync(join(dir, 'npx-calls'), 'utf8') : '',
  };
}

describe('pre-push gate', () => {
  it('runs both suites and records that it did', () => {
    const r = runHook();
    expect(r.status).toBe(0);
    expect(r.npxCalls).toMatch(/vitest/);
    expect(r.npxCalls).toMatch(/playwright/);
    expect(r.log).toMatch(/RAN/);
  });

  it('BLOCKS the push when vitest is not installed', () => {
    const r = runHook({ vitest: false });
    expect(r.status, 'a missing runner must not read as a pass').toBe(1);
    expect(r.output).toMatch(/npm install/);
    expect(r.log).toMatch(/BLOCKED/);
  });

  it('BLOCKS the push when Playwright is not installed', () => {
    const r = runHook({ playwright: false });
    expect(r.status).toBe(1);
    expect(r.log).toMatch(/BLOCKED/);
    // vitest still ran first — the block is about the suite that cannot run.
    expect(r.npxCalls).toMatch(/vitest/);
    expect(r.npxCalls).not.toMatch(/playwright/);
  });

  it('BLOCKS the push when npx is missing entirely', () => {
    const r = runHook({ npx: false });
    expect(r.status).toBe(1);
    expect(r.log).toMatch(/BLOCKED/);
  });

  it('still honours the deliberate escape hatch, and records the bypass', () => {
    // The escape hatch stays: it is a typed, visible act. What was removed is
    // the bypass nobody had to type.
    const r = runHook({ env: { SKIP_SYNC_TESTS: '1' } });
    expect(r.status).toBe(0);
    expect(r.log).toMatch(/BYPASSED/);
  });

  it('does not gate a push to a branch other than main', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepush-branch-'));
    const out = execFileSync('bash', [HOOK, 'origin'], {
      cwd: dir,
      encoding: 'utf8',
      input: 'refs/heads/fix/x abc refs/heads/fix/x def\n',
      env: { ...process.env, GATE_LOG: join(dir, 'gate.log') },
    });
    expect(out).not.toMatch(/Running unit tests/);
  });
});
