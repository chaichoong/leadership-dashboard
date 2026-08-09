// Nothing matching monitoring/.gitignore may be TRACKED. This repo is public.
//
// Regression origin: 8 Aug 2026. monitoring/task-sweep-applied-2026-08-06.json was
// committed and sat in a public repo, despite monitoring/.gitignore carrying an
// explicit "NEVER commit these" rule above the exact pattern that matches it.
//
// .gitignore only stops UNTRACKED files being added. Once a path is tracked, git
// ignores the ignore rule for ever and no warning is ever printed. The rule was
// therefore documentation, not a guard. This test is the guard.
//
// Back-tested: `git add -f monitoring/task-sweep-applied-2026-08-06.json` makes it
// go red.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const IGNORE = resolve(ROOT, 'monitoring/.gitignore');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

// Read the patterns from the .gitignore itself rather than restating them here, so
// a new never-commit rule is covered the moment it is written down.
//
// Only the block between the never-commit markers counts. The rest of that file is
// housekeeping — `schema-2*.json` is ignored for noise, yet 80 of those snapshots
// are deliberately tracked. Enforcing the whole file would fail on day one and be
// deleted, which is worse than no guard at all.
function patterns() {
  const text = readFileSync(IGNORE, 'utf8');
  const start = text.indexOf('# never-commit:begin');
  const end = text.indexOf('# never-commit:end');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('monitoring/.gitignore has lost its never-commit:begin/end markers');
  }
  return text
    .slice(start, end)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

// Translate a git glob to a RegExp. These patterns are all simple `name-*.json`
// shapes — no `**`, no directory anchors — so a `*`-only translation is honest.
function toRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

describe('monitoring/ never-commit patterns', () => {
  const tracked = git(['ls-files', 'monitoring/'])
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^monitoring\//, ''));

  it('has patterns to enforce (the .gitignore itself is not empty or moved)', () => {
    expect(patterns().length).toBeGreaterThan(0);
    expect(patterns()).toContain('task-sweep-applied-*.json');
  });

  it('tracks no file matching a never-commit pattern', () => {
    const offenders = [];
    for (const pattern of patterns()) {
      const re = toRegExp(pattern);
      for (const file of tracked) {
        if (re.test(file)) offenders.push(`monitoring/${file} (matches ${pattern})`);
      }
    }
    // These files carry tenant names, rent figures, phone numbers and email bodies.
    expect(offenders).toEqual([]);
  });
});
