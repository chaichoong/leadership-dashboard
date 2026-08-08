// The scheduled routines' instructions must stay under review.
//
// Regression origin: 8 Aug 2026. All eighteen routines are driven by
// ~/.claude/scheduled-tasks/<name>/SKILL.md — the text that decides what each one
// reads, writes, and is forbidden to touch, including which Airtable tables it may
// change. None of it was in git: no diff, no review, no history. Fixes to routine
// behaviour were the one class of change that shipped with nobody reading them,
// including the fixes queue-fixer makes, which is the review step it exists for.
//
// The repo now holds a tracked mirror. This test is what stops the two drifting
// apart again — silently, which is how it went unnoticed the first time.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const SYNC = resolve(__dirname, '../scripts/sync-scheduled-tasks.py');
const LIVE = join(homedir(), '.claude/scheduled-tasks');
const TRACKED = resolve(__dirname, '../.claude/scheduled-tasks');

// On a machine without the live directory (CI, a second Mac) there is nothing to
// compare and a red gate would be unactionable. Skip loudly rather than fail.
const hasLive = existsSync(LIVE);

describe.skipIf(!hasLive)('scheduled-task instructions are version controlled', () => {
  it('every live SKILL.md matches its reviewed copy in the repo', () => {
    let out = '';
    let code = 0;
    try {
      out = execFileSync('python3', [SYNC, '--check'], { encoding: 'utf8' });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
      code = e.status;
    }

    // The message carries the routine names and the exact command to fix it.
    expect(out, out).not.toMatch(/UNTRACKED|MISSING|DRIFTED/);
    expect(code).toBe(0);
  });

  it('the tracked mirror is not empty, so a passing check means something', () => {
    // Control. An empty mirror plus an empty live directory would compare equal
    // and report "in sync" forever — the silent-zero trap this codebase keeps
    // hitting. Assert there is real content on both sides.
    const tracked = readdirSync(TRACKED).filter((n) =>
      existsSync(join(TRACKED, n, 'SKILL.md'))
    );
    const live = readdirSync(LIVE).filter((n) =>
      existsSync(join(LIVE, n, 'SKILL.md'))
    );

    expect(tracked.length).toBeGreaterThanOrEqual(15);
    expect(live.length).toBeGreaterThanOrEqual(15);
    expect(tracked).toContain('queue-fixer');
  });

  it('runtime state files are not mirrored into the repo', () => {
    // state.json and notified.json change on every run. Tracking them would leave
    // the tree permanently dirty and teach everyone to ignore it.
    const strays = [];
    for (const name of readdirSync(TRACKED)) {
      const dir = join(TRACKED, name);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (f !== 'SKILL.md') strays.push(`${name}/${f}`);
      }
    }

    expect(strays).toEqual([]);
  });
});
