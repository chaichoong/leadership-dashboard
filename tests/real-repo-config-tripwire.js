// A test run must never change this repository's own git settings (Kevin's approved build, task
// recUoY0aovRqJTG6R; the 2 Oct 2026 incident in docs/incident-lessons.md).
//
// On 2 Oct 2026 the push gate's tests ran with git's own GIT_DIR inherited and wrote to the REAL
// shared config: `bare = true`, `hooksPath = /dev/null`, a test identity and `gpgsign = false`.
// Every worktree then answered "this operation must be run in a work tree", and with hooks off the
// private-name guard and the push gate stopped running. PR 678 closed that route
// (scripts/pre-push and tests/setup-git-env.js clear git's variables). This closes the rest: any
// route a test finds to that file fails the whole run, naming each setting that moved.
//
// Wired in vitest.config.js as `globalSetup`, so it runs once before the first test file and once
// after the last. It watches only the settings the incident changed: core.bare, core.hooksPath,
// every user.* value and commit.gpgsign. Other sessions add branch and worktree sections to the
// shared config all day, and those must not trip it.
//
// A read that fails at the start fails the run: a tripwire that cannot see is not a pass. A copy with no
// .git at all (a `git archive` export) has nothing to guard: it is skipped with a one-line note.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearGitLocalEnv } from './git-local-env.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WATCHED = /^(core\.bare|core\.hookspath|user\..+|commit\.gpgsign)$/;

// git's own variables cleared, so a run started from a hook still reads THIS repository's config.
const gitEnv = () => clearGitLocalEnv({ ...process.env });

/** The shared config file every worktree of this checkout reads (the main .git/config). */
export function sharedConfigPath(root = ROOT) {
  const out = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, env: gitEnv(), encoding: 'utf8' }).trim();
  const common = isAbsolute(out) ? out : resolve(root, out);
  return resolve(common, 'config');
}

/** The watched settings in that file, as { key: [values] }. Throws when the file cannot be read. */
export function readWatched(file) {
  if (!existsSync(file)) throw new Error(`no git config at ${file}`);
  let text = '';
  try {
    text = execFileSync('git', ['config', '--file', file, '--get-regexp', '.'], { env: gitEnv(), encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e;   // 1 = no key at all; anything else is a broken read
  }
  const out = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    if (!WATCHED.test(key)) continue;
    (out[key] = out[key] || []).push(sp < 0 ? '' : line.slice(sp + 1));
  }
  return out;
}

/** Every watched setting whose values differ, as human lines. */
export function diffWatched(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const show = (v) => (v ? v.join(', ') : '(not set)');
  return keys.filter((k) => show(before[k]) !== show(after[k])).map((k) => `${k}: ${show(before[k])} -> ${show(after[k])}`);
}

export default function setup() {
  // A copy with no git repository of its own (a `git archive` export, a tarball) has no settings to guard.
  // Checked on this folder itself, never by asking git, which would find a parent repository and watch that.
  if (!existsSync(resolve(ROOT, '.git'))) {
    process.stderr.write(`real-repo config tripwire: skipped, ${ROOT} is not a git checkout\n`);
    return undefined;
  }
  const file = sharedConfigPath();
  const before = readWatched(file);
  // The control: every git repository's config carries core.bare. Without it this is not a read.
  if (!before['core.bare']) throw new Error(`REAL REPO CONFIG TRIPWIRE: cannot see core.bare in ${file}, so it cannot watch it`);
  return function teardown() {
    const changed = diffWatched(before, readWatched(file));
    if (changed.length) {
      throw new Error(`REAL REPO CONFIG TRIPWIRE: this test run changed the repository's own git settings in ${file}. `
        + `Put them back by hand, then find the test that ran git without a throwaway repository of its own. `
        + `Changed: ${changed.join('; ')}`);
    }
  };
}
