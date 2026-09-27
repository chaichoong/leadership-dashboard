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

// NO SYMLINK MAY EVER BE TRACKED.
//
// 21 Aug 2026, finding 20260821-queue-fixer-297. `.gitignore` said
// `node_modules/` — with a trailing slash, which matches a DIRECTORY only. The
// checkout held a node_modules SYMLINK, the pattern did not match it, and one
// `git add -A` tracked a link pointing outside the repo. Every GitHub Pages
// deploy then failed, and the cause was invisible in a diff that showed one
// short line of text.
//
// The trailing slash was fixed in 4f23923. This test catches the whole class
// rather than that one name: git stores a symlink with mode 120000, so any
// tracked entry carrying that mode is a link somebody committed by accident.
//
// Back-tested: `ln -s /tmp/x link && git add -f link` makes it go red.
describe('no symlink is tracked', () => {
  it('no tracked entry carries mode 120000', () => {
    // `ls-files -s` reads the INDEX, so this goes red the moment a symlink is
    // staged — one step earlier than `ls-tree HEAD`, which needs it committed
    // first. Both would catch it before a push; the index catches it before a
    // commit message has been written.
    const links = git(['ls-files', '-s'])
      .split('\n')
      .filter((l) => l.startsWith('120000'))
      .map((l) => l.split('\t')[1]);
    // A symlink in a public repo is either a broken deploy (it points outside
    // the checkout) or a leak (it points at something real on Kevin's Mac).
    expect(links).toEqual([]);
  });

  it('the ignore rules meant to cover a NAME carry no trailing slash', () => {
    // A trailing slash is right for a path that is only ever a directory. It is
    // wrong for anything that could arrive as a symlink instead — which is what
    // node_modules did.
    const root = readFileSync(resolve(ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const nameNotDir = ['node_modules', 'dist', 'build', 'vendor'];
    const offenders = root.filter((l) => nameNotDir.includes(l.replace(/\/$/, '')) && l.endsWith('/'));
    expect(offenders, 'a trailing slash here stops the rule matching a symlink of the same name').toEqual([]);
  });
});
