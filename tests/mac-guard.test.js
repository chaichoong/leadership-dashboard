import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, realpathSync, rmSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const GUARD = 'scripts/mac-guard.sh';
const src = read(GUARD);
// Comments in this script name the very bugs being guarded against, so any
// assertion about what the script *does* has to read the code, not the prose.
const code = src
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

// mac-guard.sh kills processes. Every bug in it costs the user live work, so
// the safety rails are asserted here rather than trusted to review.
//
// Both regressions below were real, hit on 6 Aug 2026 while building it, and
// the second one had the script one dry-run away from killing a live Claude
// session's preview server.

describe('mac-guard: portability traps that silently disable the age check', () => {
  // BUG 1 (6 Aug 2026): used `ps -o etimes=`. That field is GNU/Linux only.
  // BSD/macOS ps does not error on it — it prints its entire keyword list. The
  // result flowed into `[ "$AGE" -lt "$GRACE" ]`, which failed as a non-integer
  // comparison, so the guard fell straight through to the KILL branch for
  // every candidate regardless of age.
  it('never asks macOS ps for the Linux-only etimes field', () => {
    expect(code).not.toMatch(/ps\s+-o\s+etimes/);
    expect(code).not.toMatch(/\betimes=/);
    expect(code).toMatch(/ps -o etime= -p/);
  });

  // BUG 2 (6 Aug 2026): assigned to PPID. bash reserves it; assignment is a
  // fatal "readonly variable" error that aborted the run mid-sweep.
  it('never assigns to bash reserved variable names', () => {
    for (const reserved of ['PPID', 'UID', 'EUID', 'RANDOM', 'SECONDS']) {
      expect(src).not.toMatch(new RegExp(`^\\s*${reserved}=`, 'm'));
    }
  });
});

describe('mac-guard: age parser', () => {
  // Run the real function out of the real file, so the test cannot drift from
  // the shipped implementation.
  const ageOf = (etime) => {
    const fn = src.match(/age_seconds \(\) \{[\s\S]*?\n\}/)[0];
    const harness = `
      ${fn.replace(
        /raw=\$\(ps -o etime= -p "\$1" 2>\/dev\/null \| tr -d ' '\)/,
        'raw="$1"'
      )}
      age_seconds "${etime}" || echo UNPARSEABLE
    `;
    return execFileSync('bash', ['-c', harness], { encoding: 'utf8' }).trim();
  };

  it('parses every etime format macOS ps emits', () => {
    expect(ageOf('00:42')).toBe('42');            // MM:SS
    expect(ageOf('01:27:35')).toBe('5255');       // HH:MM:SS
    expect(ageOf('04-00:55:08')).toBe('348908');  // D-HH:MM:SS
  });

  // "Unknown age" must never read as "age zero" or as a huge number. Both
  // extremes pick a side; returning nothing makes callers skip the process.
  it('returns nothing rather than a number it cannot justify', () => {
    expect(ageOf('')).toBe('UNPARSEABLE');
    expect(ageOf('garbage')).toBe('UNPARSEABLE');
  });

  it('treats an unknown age as leave-alone at every call site', () => {
    const skipsOnUnknown = src.match(/AGE=\$\(age_seconds "\$pid"\) \|\| AGE=""\s*\n\s*if \[ -z "\$AGE" \]; then[\s\S]*?continue/g);
    const callSites = src.match(/AGE=\$\(age_seconds/g) || [];
    expect(skipsOnUnknown).toHaveLength(callSites.length);
  });
});

describe('mac-guard: kill rules', () => {
  it('refuses to touch any test browser while a test run exists', () => {
    // Blunt on purpose: a concurrent session's suite must not be sabotaged.
    expect(src).toMatch(/if pgrep -f "playwright test"[\s\S]*?SKIP[\s\S]*?test run is in progress/);
  });

  it('only reaps preview servers owned by the Claude desktop app', () => {
    expect(src).toMatch(/\*Claude\.app\*\)\s*;;/);
    expect(src).toMatch(/not started by Claude, leaving alone/);
  });

  it('requires an idle port before reaping a preview server', () => {
    expect(src).toMatch(/sTCP:ESTABLISHED/);
    expect(src).toMatch(/CONNS:-0\}" -gt 0[\s\S]*?SKIP/);
  });

  // A live session's server sits connectionless whenever its browser tab is
  // shut. Sessions here run 1-2 hours, so a short grace period reaps live work.
  it('gives preview servers hours, not minutes, before calling them abandoned', () => {
    const grace = Number(src.match(/^SERVER_GRACE=(\d+)/m)[1]);
    expect(grace).toBeGreaterThanOrEqual(14400);
  });

  it('never closes a Claude Code session, only advises', () => {
    const sessionBlock = src.slice(src.indexOf('SESSIONS='));
    expect(sessionBlock).toMatch(/ADVISORY/);
    expect(sessionBlock).not.toMatch(/\bkill\b/);
  });
});

describe('mac-guard: dry run changes nothing', () => {
  // The credential step scans ~/knowledge-os by content. Against the real home that is
  // 13,786 files and 1.7 GB read: 11.5s of an 11.8s dry run at load 2, past the 30s test
  // timeout at load 30-58, which failed merge-pr.py twice for an unrelated PR (14 Oct 2026).
  // So HOME points at a fake one, as tests/secret-copy-guard.test.js does. The real guard
  // still runs end to end, and a planted world-readable copy proves the dry run looked,
  // reported it, left its mode alone and still exited clean.
  const token = 'patPLANTEDtoken0123456789abcdefGHIJ';
  let home;
  let leak;
  beforeAll(() => {
    // realpath: the guard prints resolved paths, and macOS tmpdir sits behind /var -> /private/var.
    home = realpathSync(mkdtempSync(join(tmpdir(), 'mg-home-')));
    const cfg = join(home, '.config', 'od');
    const scratch = join(home, 'knowledge-os', 'logs', 'some-agent', 'scratch');
    mkdirSync(cfg, { recursive: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(cfg, 'airtable_pat'), token + '\n');
    leak = join(scratch, '.airtable_pat');
    writeFileSync(leak, token + '\n');
    chmodSync(leak, 0o644);
  });
  afterAll(() => home && rmSync(home, { recursive: true, force: true }));

  // The fake home only keeps the test fast while every place the guard reads hangs off HOME.
  // A root added as an absolute path would put the real tree, and the timeout, straight back.
  it('reads secrets and scans only under HOME', () => {
    const py = [
      'import importlib.util, json, os, sys',
      'spec = importlib.util.spec_from_file_location("guard", sys.argv[1])',
      'g = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(g)',
      'print(json.dumps([os.path.realpath(os.path.expanduser(p)) for p in (g.CONFIG_DIR, *g.SEARCH_ROOTS)]))',
    ].join('\n');
    const places = JSON.parse(
      execFileSync('python3', ['-c', py, resolve(ROOT, 'scripts/secret-copy-guard.py')], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home },
      })
    );
    expect(places.length).toBeGreaterThan(1);
    for (const p of places) expect(p === home || p.startsWith(home + '/'), `${p} is outside HOME`).toBe(true);
  });

  it('reports without killing and exits clean', () => {
    const started = Date.now();
    const out = execFileSync('bash', [resolve(ROOT, GUARD), '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    const elapsed = Date.now() - started;
    expect(out).toMatch(/mac-guard done: \d+ reaped/);
    expect(out).not.toMatch(/^\s+KILLED/m);
    expect(out).toMatch(/dry run/);
    expect(out).toContain("COPY OF 'airtable_pat'");
    expect(out).toContain(leak);
    expect(out).not.toContain(token);
    expect(statSync(leak).mode & 0o777).toBe(0o644);
    // 0.2-0.6s on the fake home at load 2-24. The bound is a third of the 30s timeout, so a
    // slow step creeping back fails here with its time, not as a timeout under load.
    expect(elapsed, `dry run took ${elapsed}ms`).toBeLessThan(10_000);
  });
});
