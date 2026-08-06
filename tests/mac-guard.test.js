import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
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
  it('reports without killing and exits clean', () => {
    const out = execFileSync('bash', [resolve(ROOT, GUARD), '--dry-run'], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/mac-guard done: \d+ reaped/);
    expect(out).toMatch(/reaped/);
    expect(out).not.toMatch(/^\s+KILLED/m);
    expect(out).toMatch(/dry run/);
  });
});
