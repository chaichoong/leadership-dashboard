import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoreFile = resolve(root, 'monitoring/.gitignore');
const ignoreSrc = readFileSync(ignoreFile, 'utf8');

// Only the housekeeping half of the file. Everything from the never-commit marker down
// is a PRIVACY rule (tenant names, rent figures, email bodies in a public repo) and is
// enforced separately by tests/never-commit-paths.test.js. This test must never be read
// as licence to relax those.
const housekeeping = ignoreSrc.split('# never-commit:begin')[0];

function isIgnored(path) {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' });
    return true;
  } catch { return false; }
}


// ─────────────────────────────────────────────────────────────────────────────
// 20260816-drift-181 — no drift report reached git after 6 Aug 2026
// ─────────────────────────────────────────────────────────────────────────────
// monitoring/.gitignore carried `drift-2*.md`. Forty reports up to 6 Aug are TRACKED —
// git ignores an ignore rule once a path is tracked — so the rule only ever hid the new
// ones. The drift routine reported success every day, and the queue-fixer's `git add -A`
// silently staged nothing. Seven reports were written and lost before anyone noticed.
describe('monitoring reports can actually reach git', () => {
  it('drift reports are not ignored', () => {
    expect(housekeeping).not.toMatch(/^\s*drift-2\*\.md\s*$/m);
    expect(housekeeping).not.toMatch(/^\s*drift-.*\.md\s*$/m);
  });

  it('git agrees they are not ignored', () => {
    // The rule is one thing; what git does is another. Ask git directly.
    // check-ignore exits 0 when a path IS ignored and 1 when it is not, so the
    // throw is the pass here.
    expect(isIgnored('monitoring/drift-2026-08-16.md')).toBe(false);
    expect(isIgnored('monitoring/drift-2099-01-01.md')).toBe(false);   // any future report
    // Control: the privacy patterns must still be ignored, or this test is asserting
    // that nothing in this directory is ignored, which would be a different bug.
    expect(isIgnored('monitoring/task-sweep-detail-2026-08-16.md')).toBe(true);
  });

  it('e2e-sweep and task-sweep reports are not ignored either', () => {
    // Only the unredacted companions are private: the -worklist-, -decisions-,
    // -applied- and -detail- files. The plain dated reports are the audit trail.
    expect(housekeeping).not.toMatch(/e2e-sweep/);
    expect(housekeeping).not.toMatch(/^\s*task-sweep-2\*/m);
  });

  it('the privacy block is untouched — the unredacted companions stay ignored', () => {
    const privacy = ignoreSrc.slice(ignoreSrc.indexOf('# never-commit:begin'));
    for (const pattern of [
      'task-sweep-worklist-*.json',
      'task-sweep-decisions-*.json',
      'task-sweep-applied-*.json',
      'task-sweep-detail-*.md',
    ]) {
      expect(privacy).toContain(pattern);
    }
  });

  it('explains why the drift rule was removed, so nobody re-adds it', () => {
    expect(housekeeping).toMatch(/drift-2\*\.md WAS ignored/);
  });

  it('every dated report on disk is either tracked or explained', () => {
    const files = readdirSync(resolve(root, 'monitoring'))
      .filter(f => /^(drift|e2e-sweep|task-sweep)-\d{4}-\d{2}-\d{2}\.md$/.test(f));
    expect(files.length).toBeGreaterThan(0);   // control: an empty glob asserts nothing
    const ignored = files.filter(f => isIgnored(`monitoring/${f}`));
    expect(ignored).toEqual([]);
  });
});
