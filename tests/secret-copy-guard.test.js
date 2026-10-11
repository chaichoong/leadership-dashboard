import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, statSync, chmodSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = resolve(ROOT, 'scripts/secret-copy-guard.py');

// Every assertion here DRIVES the guard against a planted fault. Grepping the source for a
// safety rule proves only that the rule is written down (memory: a test that greps source is
// theatre), and the fault this guard exists for was itself invisible for weeks because nothing
// looked: the live Airtable token sat world-readable in two agent scratch directories
// (findings 20260924-report-597, 20261010-phase-5-822).

const run = (args, opts = {}) => {
  try {
    const stdout = execFileSync('python3', [GUARD, ...args], { encoding: 'utf8', ...opts });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: (e.stdout || '') + (e.stderr || '') };
  }
};

describe('secret-copy-guard: its own back-tested selftest', () => {
  it('passes, which is what proves a planted copy is detected and an id is not', () => {
    const r = run(['--selftest']);
    expect(r.stdout).toContain('selftest: ok');
    expect(r.code).toBe(0);
  });
});

describe('secret-copy-guard: driven against a planted credential copy', () => {
  // Build a fake home: a canonical secret store plus a log tree holding a copy of the token.
  const home = mkdtempSync(join(tmpdir(), 'scg-'));
  const cfg = join(home, '.config', 'od');
  const logs = join(home, 'knowledge-os', 'logs', 'some-agent', 'scratch');
  mkdirSync(cfg, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const token = 'patPLANTEDtoken0123456789abcdefGHIJ';
  const orgId = '286c1111-2222-3333-4444-555566667777';
  writeFileSync(join(cfg, 'airtable_pat'), token + '\n');
  writeFileSync(join(cfg, 'pingen_org_id'), orgId + '\n');
  const leak = join(logs, '.airtable_pat');
  writeFileSync(leak, token + '\n');
  chmodSync(leak, 0o644);
  const urlFile = join(logs, 'status.json');
  writeFileSync(urlFile, `{"landedOn":"https://app.pingen.com/organisation/${orgId}/dashboard"}\n`);

  // The guard resolves ~/.config/od and ~/knowledge-os from HOME, so pointing HOME at the fake
  // home exercises the real roots rather than a test-only code path.
  const env = { ...process.env, HOME: home };

  it('reports the copy, names the secret it matches, and never prints the value', () => {
    const r = run(['--no-chmod'], { env });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("COPY OF 'airtable_pat'");
    expect(r.stdout).toContain(leak);
    expect(r.stdout).not.toContain(token);
  });

  it('does not report an identifier that legitimately appears in a URL', () => {
    const r = run(['--no-chmod'], { env });
    expect(r.stdout).not.toContain('pingen_org_id');
    expect(r.stdout).not.toContain('status.json');
  });

  it('takes the world-readable bit off the copy, and deletes nothing', () => {
    expect(statSync(leak).mode & 0o777).toBe(0o644);
    const r = run([], { env });
    expect(r.code).toBe(1);
    expect(statSync(leak).mode & 0o777).toBe(0o600);
    expect(statSync(urlFile).mode & 0o777).toBe(0o644);   // untouched: not a credential
    expect(r.stdout).toContain('tightened to 0600');
  });

  it('goes quiet and green once the copy is gone', () => {
    execFileSync('rm', [leak]);
    const r = run([], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('clean');
  });

  it('exits 2, never 0, when it cannot read any canonical secret', () => {
    const empty = mkdtempSync(join(tmpdir(), 'scg-empty-'));
    const r = run([], { env: { ...process.env, HOME: empty } });
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('CANNOT CHECK');
  });
});

describe('mac-guard: a credential copy makes the hourly run red', () => {
  // Driven, not grepped: a stub guard in a throwaway scripts dir, so mac-guard's own exit
  // wiring is what is under test. Dry run, so nothing is ever killed.
  const mk = (stubExit) => {
    const dir = mkdtempSync(join(tmpdir(), 'mg-'));
    copyFileSync(resolve(ROOT, 'scripts/mac-guard.sh'), join(dir, 'mac-guard.sh'));
    writeFileSync(
      join(dir, 'secret-copy-guard.py'),
      `import sys\nprint("secret-copy-guard: stub")\nsys.exit(${stubExit})\n`
    );
    return dir;
  };
  const runGuard = (dir, ...args) => {
    try {
      return { code: 0, out: execFileSync('bash', [join(dir, 'mac-guard.sh'), ...args], { encoding: 'utf8' }) };
    } catch (e) {
      return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
  };

  it('exits 1 when the guard found a copy', () => {
    const r = runGuard(mk(1));
    expect(r.out).toContain('secret-copy-guard: stub');
    expect(r.code).toBe(1);
  });

  // The first wiring of this step ran the guard with its chmod ON during --dry-run, so a run
  // whose whole promise is "changes nothing" changed four file modes. The existing
  // "dry run changes nothing" test caught it; these two keep it caught.
  it('passes --no-chmod and still exits 0 in a dry run, whatever the guard found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mg-dry-'));
    copyFileSync(resolve(ROOT, 'scripts/mac-guard.sh'), join(dir, 'mac-guard.sh'));
    writeFileSync(
      join(dir, 'secret-copy-guard.py'),
      'import sys\nprint("ARGS:" + " ".join(sys.argv[1:]))\nsys.exit(1)\n'
    );
    const r = runGuard(dir, '--dry-run');
    expect(r.out).toContain('ARGS:--no-chmod');
    expect(r.code).toBe(0);
  });

  it('passes no chmod flag on a real run, so the exposure is actually taken off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mg-real-'));
    copyFileSync(resolve(ROOT, 'scripts/mac-guard.sh'), join(dir, 'mac-guard.sh'));
    writeFileSync(
      join(dir, 'secret-copy-guard.py'),
      'import sys\nprint("ARGS:[" + " ".join(sys.argv[1:]) + "]")\nsys.exit(0)\n'
    );
    const r = runGuard(dir);
    expect(r.out).toContain('ARGS:[]');
    expect(r.code).toBe(0);
  });

  it('still exits 0 when the guard is clean, so reaping alone never alarms', () => {
    const r = runGuard(mk(0));
    expect(r.code).toBe(0);
  });

  it('exits 0, and says so, when the guard script is missing entirely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mg-none-'));
    copyFileSync(resolve(ROOT, 'scripts/mac-guard.sh'), join(dir, 'mac-guard.sh'));
    const r = runGuard(dir);
    expect(r.out).toContain('secret-copy-guard.py not in');
    expect(r.code).toBe(0);
  });
});
