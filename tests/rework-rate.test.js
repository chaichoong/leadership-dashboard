// scripts/rework-rate.py measures how much work on origin/main went on fixing what had just
// shipped. The 29 Sep 2026 brief counted rework by hand in zsh and got 40 of 111 fixes: a bare
// `$files` is not split in zsh, so every multi-file fix went unchecked. The true file-level count
// was 101, and it reads high because a busy file almost always changed that week. The headline is
// now line level: did the fix change LINES a non-fix commit wrote in the 7 days before?
// These cases build real scratch repos with dated commits, so git decides, not a mock.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const SCRIPT = resolve(__dirname, '../scripts/rework-rate.py');
const ROOT = mkdtempSync(join(tmpdir(), 'reworkrate-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function repo(name) {
  const dir = join(ROOT, name);
  mkdirSync(dir);
  const git = (args, date) => execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  }).trim();
  git(['init', '-q', '-b', 'main']);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) git(['config', k, v]);
  const save = (day, subject, body) => {
    git(['add', '-A']);
    git(['commit', '-q', '-m', body ? `${subject}\n\n${body}` : subject], `${day}T12:00:00`);
  };
  return {
    dir,
    git,
    // Appends one line to each file: a pure addition, so it never counts at line level
    commit(day, subject, files, body = '') {
      for (const f of files) {
        mkdirSync(dirname(join(dir, f)), { recursive: true });
        appendFileSync(join(dir, f), `${subject}\n`);
      }
      save(day, subject, body);
    },
    // Writes whole files, so a commit can change exact lines
    write(day, subject, contents, body = '') {
      for (const [f, lines] of Object.entries(contents)) writeFileSync(join(dir, f), `${lines.join('\n')}\n`);
      save(day, subject, body);
    },
    publish() { git(['update-ref', 'refs/remotes/origin/main', 'HEAD']); },
  };
}

const run = (dir, ...extra) => spawnSync('python3', [SCRIPT, '--repo', dir, ...extra], { encoding: 'utf8' });
const measure = (dir) => {
  const r = run(dir, '--days', '30', '--until', '2026-06-30', '--json');
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
};
const fix = (m, subject) => m.fix_list.find((f) => f.subject === subject);

describe('rework-rate counts', () => {
  let R;
  beforeAll(() => {
    R = repo('counts');
    writeFileSync(join(R.dir, 'seed.txt'), 'seed\n');
    // Before the window (window: 1 to 30 Jun, --until 2026-06-30 --days 30)
    R.commit('2026-05-01', 'Add the widget', ['js/widget.js', 'seed.txt']);
    R.commit('2026-05-28', 'Add the base page', ['page.html', 'app.py']);
    // In the window
    R.commit('2026-06-02', 'Fix: base page title', ['page.html', 'tests/page.test.js', 'docs/notes.md'], 'Kevin saw the wrong title.');
    R.commit('2026-06-03', 'Build the report script', ['scripts/report.py', 'js/config.js']);
    R.commit('2026-06-04', 'Auto-bump pageVer for modified pages [auto-bump]', ['js/config.js', 'js/widget.js']);
    R.commit('2026-06-05', 'fix: report totals', ['scripts/report.py', 'scripts/schedule.json', 'logs/run.log'], 'Found by the nightly sweep. Kevin had not seen it.');
    R.commit('2026-06-06', 'Hotfix: widget crash', ['js/widget.js', 'js/config.js'], 'Caught in code review.');
    R.commit('2026-06-10', 'Build the export tool', ['scripts/export.sh']);
    R.git(['checkout', '-q', '-b', 'side']);
    R.commit('2026-06-12', 'Build the side note', ['side.txt']);
    R.git(['checkout', '-q', 'main']);
    R.git(['merge', '-q', '--no-ff', 'side', '-m', 'Merge side'], '2026-06-12T13:00:00');
    R.commit('2026-06-18', 'Add export tests', ['tests/export.test.js']);
    R.commit('2026-06-20', 'Fix: export tool path', ['scripts/export.sh', 'tests/export.test.js'], 'The roy-assistant runner hit it.');
    R.commit('2026-06-21', 'Fix: export tool quoting', ['scripts/export.sh'], 'The daily invariant caught it.');
    R.commit('2026-06-24', 'Build the api worker', ['workers/api.js']);
    R.commit('2026-06-25', 'fix: tidy the readme', ['README.md', 'docs/x.md'], 'Roy asked for the tidy.');
    R.commit('2026-06-26', 'Fix: page, api and report agree', ['page.html', 'scripts/report.py', 'workers/api.js'], "Kevin's audit found the mismatch.");
    // After the window
    R.commit('2026-07-02', 'Fix: after the window', ['page.html']);
    R.publish();
  });

  it('counts changes without auto-bump or merge commits, inside the window only', () => {
    expect(measure(R.dir).changes).toBe(12);
  });

  it('counts fixes by subject: fix or hotfix, any case', () => {
    const m = measure(R.dir);
    expect(m.fixes).toBe(7);
    expect(m.fix_list.map((f) => f.subject)).not.toContain('Fix: after the window');
  });

  it('sorts each fix into an area after dropping tests, docs and markdown', () => {
    expect(measure(R.dir).area).toEqual({ scripts: 3, frontend: 2, both: 1, other: 1 });
  });

  it('file level: counts a fix when a non-fix changed one of its files in the 7 days before', () => {
    const m = measure(R.dir);
    expect(m.file_rework).toBe(3);
    // Built 5 days before, and before the window starts: the lookback still sees it
    expect(fix(m, 'Fix: base page title').file_rework.commit).toBeTruthy();
    expect(fix(m, 'fix: report totals').file_rework.subject).toBe('Build the report script');
  });

  it('file level: checks every file of a multi-file fix, not just the first', () => {
    const r = fix(measure(R.dir), 'Fix: page, api and report agree').file_rework;
    expect(r.file).toBe('workers/api.js');
    expect(r.subject).toBe('Build the api worker');
  });

  it('file level: ignores an auto-bump, a config.js or tests/ change, a fix 10 days on, and a fix after a fix', () => {
    const m = measure(R.dir);
    expect(fix(m, 'Hotfix: widget crash').file_rework).toBeNull();
    expect(fix(m, 'Fix: export tool path').file_rework).toBeNull();
    expect(fix(m, 'Fix: export tool quoting').file_rework).toBeNull();
    expect(fix(m, 'fix: tidy the readme').file_rework).toBeNull();
  });

  it('line level: every fix here only appends lines, so none counts', () => {
    const m = measure(R.dir);
    expect(m.line_rework).toBe(0);
    expect(m.fix_of_fix).toBe(0);
  });

  it('names the finder: robot before person before review, names case-sensitive', () => {
    const m = measure(R.dir);
    expect(m.finder).toEqual({ person: 3, robot: 2, review: 1, unclear: 1 });
    expect(fix(m, 'fix: report totals').finder).toBe('robot');
    expect(fix(m, 'Fix: page, api and report agree').finder).toBe('person');
    expect(fix(m, 'Fix: export tool path').finder).toBe('unclear');
  });

  it('lists the most-fixed files without tests, docs, .md, logs, config.js or .json', () => {
    expect(measure(R.dir).top_files).toEqual([
      { path: 'page.html', fixes: 2 },
      { path: 'scripts/export.sh', fixes: 2 },
      { path: 'scripts/report.py', fixes: 2 },
      { path: 'js/widget.js', fixes: 1 },
      { path: 'workers/api.js', fixes: 1 },
    ]);
  });

  it('fails loudly on a window with no changes', () => {
    const r = run(R.dir, '--days', '30', '--until', '2026-01-31');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no changes/);
  });
});

describe('rework-rate line level', () => {
  let R;
  const range = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
  beforeAll(() => {
    R = repo('lines');
    const busy = range('old', 10);
    const other = range('other', 5);
    const big = range('big', 100);
    R.write('2026-05-01', 'Build the busy module', { 'busy.py': busy, 'other.py': other, 'big.py': big });
    busy.push(...range('new', 5));
    R.write('2026-06-10', 'Build the new feature', { 'busy.py': busy });
    busy[12] = 'new 3 fixed'; // written 3 days before by the build
    R.write('2026-06-13', 'Fix: new feature bug', { 'busy.py': busy });
    busy[1] = 'old 2 fixed'; // written 44 days before, in a file the build touched 4 days before
    R.write('2026-06-14', 'Fix: old bug in the busy file', { 'busy.py': busy });
    busy.splice(5, 0, 'guard'); // a pure addition
    R.write('2026-06-15', 'Fix: add a missing guard', { 'busy.py': busy });
    other[0] = 'other 1 fixed';
    R.write('2026-06-20', 'Fix: first attempt', { 'other.py': other });
    other[0] = 'other 1 fixed again'; // written 2 days before by a fix
    R.write('2026-06-22', 'Fix: second attempt', { 'other.py': other });
    for (let i = 0; i < 100; i += 2) big[i] = `${big[i]} edited`; // 50 separate ranges
    R.write('2026-06-25', 'Fix: many small edits', { 'big.py': big });
    R.publish();
  });

  it('counts a fix that changes lines a build wrote 3 days before', () => {
    const r = fix(measure(R.dir), 'Fix: new feature bug').line_rework;
    expect(r).toMatchObject({ file: 'busy.py', subject: 'Build the new feature' });
  });

  it('does not count a fix that only changes old lines in a busy file (file level wrongly does)', () => {
    const f = fix(measure(R.dir), 'Fix: old bug in the busy file');
    expect(f.line_rework).toBeNull();
    expect(f.file_rework).toMatchObject({ subject: 'Build the new feature' });
  });

  it('does not count a pure addition', () => {
    const f = fix(measure(R.dir), 'Fix: add a missing guard');
    expect(f.line_rework).toBeNull();
    expect(f.fix_of_fix).toBeNull();
  });

  it('counts a fix that changes lines another fix wrote 2 days before as a fix of a fix', () => {
    const m = measure(R.dir);
    expect(fix(m, 'Fix: second attempt').fix_of_fix).toMatchObject({ file: 'other.py', subject: 'Fix: first attempt' });
    expect(fix(m, 'Fix: second attempt').line_rework).toBeNull();
    expect(fix(m, 'Fix: first attempt').fix_of_fix).toBeNull();
  });

  it('caps the blame at 40 ranges per fix and says so', () => {
    const m = measure(R.dir);
    expect(fix(m, 'Fix: many small edits').blame_capped).toBe(true);
    expect(m.blame_capped).toBe(1);
    expect(m.blame_errors).toBe(0);
  });

  it('totals line rework, fix of a fix and file rework', () => {
    const m = measure(R.dir);
    expect(m.fixes).toBe(6);
    expect(m.line_rework).toBe(1);
    expect(m.fix_of_fix).toBe(1);
    expect(m.file_rework).toBe(3);
  });

  it('prints line rework as the headline, file rework labelled as file level', () => {
    const r = run(R.dir, '--days', '30', '--until', '2026-06-30');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^Line rework: 1 of 6 fixes changed lines a non-fix commit wrote in the 7 days before/m);
    expect(r.stdout).toMatch(/^Fix of a fix: 1 of 6/m);
    expect(r.stdout).toMatch(/^File rework \(blunt, file level\): 3 of 6 fixes/m);
    expect(r.stdout).toMatch(/^Blame cap hit on 1 fix: /m);
    expect(r.stdout.indexOf('Line rework')).toBeLessThan(r.stdout.indexOf('File rework'));
  });
});
