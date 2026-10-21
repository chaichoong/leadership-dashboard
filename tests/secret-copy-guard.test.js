import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, statSync, chmodSync, existsSync } from 'fs';
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

  // 15 Oct 2026, finding 20261015-agent-dispatch-885: the closing line always demanded a rotation,
  // so a 0600 copy in a local log directory came to Kevin as a credential wall he could not act on
  // (task rec1PD85WcOJRtNF7). Deleting that copy clears the exposure; rotation is for a copy that
  // had a route off this Mac.
  it('tells Kevin to delete a local copy, and does not demand a rotation it does not need', () => {
    const r = run(['--no-chmod'], { env });
    expect(r.stdout).toContain('Delete the file(s) listed above');
    expect(r.stdout).toContain('no rotation needed');
    expect(r.stdout).not.toContain('ROTATE');
  });

  it('does demand a rotation, and names the stored secret, when git tracks the copy', () => {
    // A copy git tracks is a published copy: this repo is public.
    const repo = join(home, 'knowledge-os', 'logs', 'tracked');
    mkdirSync(repo, { recursive: true });
    const tracked = join(repo, 'notes.txt');
    writeFileSync(tracked, token + '\n');
    const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    g('init', '-q');
    g('add', 'notes.txt');
    g('commit', '-qm', 'plant');
    const r = run(['--no-chmod'], { env });
    expect(r.stdout).toContain('ROTATE the secret held in');
    expect(r.stdout).toContain('airtable_pat');
    expect(r.stdout).toContain('git tracks it');
    expect(r.stdout).not.toContain(token);
    execFileSync('rm', ['-rf', repo]);
  });

  // 21 Oct 2026, findings 20261019-phase-2-990 / 20261020-phase-2-1007 (the copy sat for three
  // weeks and this guard was red on every hourly run, so its light meant nothing) and
  // 20261015-agent-dispatch-902 / 20261020-agent-dispatch-1013 (no unattended run could clear it,
  // because a bare rm is refused by the robots' permission settings). Each assertion below drives
  // --delete-unread against a planted fault; the back-test is at the bottom of this block.
  describe('--delete-unread', () => {
    const plant = () => {
      const h = mkdtempSync(join(tmpdir(), 'scg-del-'));
      const c = join(h, '.config', 'od');
      const l = join(h, 'knowledge-os', 'logs', 'a', 'scratch');
      mkdirSync(c, { recursive: true });
      mkdirSync(l, { recursive: true });
      writeFileSync(join(c, 'airtable_pat'), token + '\n');
      const copy = join(l, '.airtable_pat');
      writeFileSync(copy, token + '\n');
      return { home: h, cfg: c, logs: l, copy, env: { ...process.env, HOME: h } };
    };

    it('deletes a bare copy nothing reads, goes green, and leaves the stored copy working', () => {
      const p = plant();
      const r = run(['--delete-unread'], { env: p.env });
      expect(r.stdout).toContain('DELETED the copy');
      expect(r.stdout).toContain('clean');
      expect(r.stdout).not.toContain(token);
      expect(r.code).toBe(0);
      expect(existsSync(p.copy)).toBe(false);
      expect(existsSync(join(p.cfg, 'airtable_pat'))).toBe(true);
    });

    it('deletes nothing without the flag, so the default stays report-only', () => {
      const p = plant();
      const r = run([], { env: p.env });
      expect(r.code).toBe(1);
      expect(existsSync(p.copy)).toBe(true);
      expect(r.stdout).not.toContain('DELETED');
    });

    it('KEEPS a file that holds more than the secret, because that destroys a record', () => {
      const p = plant();
      const log = join(p.logs, 'run.log');
      writeFileSync(log, `step 1 ok\nPAT=${token}\nstep 2 ok\n`);
      const r = run(['--delete-unread'], { env: p.env });
      expect(existsSync(log)).toBe(true);
      expect(r.stdout).toContain('destroy a record');
      expect(r.code).toBe(1);          // a copy it cannot clear still reads red
    });

    it('KEEPS a copy that durable code still refers to', () => {
      const p = plant();
      const tools = join(p.home, 'tools');
      mkdirSync(tools, { recursive: true });
      writeFileSync(join(tools, 'reader.sh'), `PAT=$(cat ${p.copy})\n`);
      const r = run(['--delete-unread'], { env: p.env });
      expect(existsSync(p.copy)).toBe(true);
      expect(r.stdout).toContain('still refers to it');
      expect(r.code).toBe(1);
    });

    it('KEEPS a copy git tracks, because a delete does not un-publish it', () => {
      const p = plant();
      const repo = join(p.home, 'knowledge-os', 'logs', 'tracked');
      mkdirSync(repo, { recursive: true });
      const tracked = join(repo, '.airtable_pat');
      writeFileSync(tracked, token + '\n');
      const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
      g('init', '-q'); g('add', '.airtable_pat'); g('commit', '-qm', 'plant');
      const r = run(['--delete-unread'], { env: p.env });
      expect(existsSync(tracked)).toBe(true);
      expect(r.stdout).toContain('needs a rotation, not a delete');
      expect(r.stdout).toContain('ROTATE the secret held in');
    });

    it('never deletes the stored secret itself', () => {
      const p = plant();
      execFileSync('rm', [p.copy]);
      const r = run(['--delete-unread'], { env: p.env });
      expect(r.code).toBe(0);
      expect(existsSync(join(p.cfg, 'airtable_pat'))).toBe(true);
    });
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
    expect(r.out).not.toContain('--no-chmod');
    expect(r.code).toBe(0);
  });

  // The guard can only clear the copy if the hourly job actually asks it to. Without this the
  // fix is written and never runs, which is the shape of finding 20261019-phase-2-990.
  it('passes --delete-unread on a real run, so the hourly job can clear what it proves is debris', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mg-del-'));
    copyFileSync(resolve(ROOT, 'scripts/mac-guard.sh'), join(dir, 'mac-guard.sh'));
    writeFileSync(
      join(dir, 'secret-copy-guard.py'),
      'import sys\nprint("ARGS:[" + " ".join(sys.argv[1:]) + "]")\nsys.exit(0)\n'
    );
    const r = runGuard(dir);
    expect(r.out).toContain('ARGS:[--delete-unread]');
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
