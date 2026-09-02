// Regression tests for scripts/slot-postrun.sh — the shared epilogue every
// slot wrapper (task-manager-run.sh, inbound-triage-run.sh, agent-slot-run.sh)
// now exits through.
//
// ORIGIN (findings 20260827-phase-2-381 and -382):
//   - 26 Aug 2026, 17:00 task-manager slot: the board pass finished with rc=0,
//     but the privacy sweep quarantined monitoring/schema-2026-08-26.json —
//     the drift scanner's Airtable schema snapshot, whose field DESCRIPTIONS
//     matched the '"description":' leak pattern — and the old epilogue's
//     combined failure branch then reported "task-manager run FAILED (rc=0)"
//     and exited 1. A successful run was recorded as a failure in
//     job-status.jsonl.
//   - 25 Aug 2026: the same sweep in inbound-triage-run.sh quarantined 41
//     COMMITTED schema files ("Inbound Message Content" is a field NAME in
//     the table structure, not message content). The git-tracked exemption
//     fixed those, but the SAME DAY's snapshot is untracked until the nightly
//     fixer commits it, so it kept false-positiving.
//   - 26 Aug 2026, 09:00 inbound-triage slot: the wrapper died leaving a
//     start header and no done line. The wrappers now trap catchable
//     terminations; this file asserts the traps exist in all three.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts/slot-postrun.sh');
const LEAK_ERE = '"description":|Inbound Message Content|CREDITOR MATTER';
const BAD_ERE = 'HTTP Error 401|401 Unauthorized|Unauthorized|OAuth access token has expired|BROKEN|VERIFY FAIL';

let repo, scratch, log, marker;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  return r;
}

function runPostrun({ job = 'test-job', rc = 0, startLine = 1, leak = LEAK_ERE, bad = BAD_ERE } = {}) {
  return sh('bash', [SCRIPT, job, String(rc), log, String(startLine), marker, scratch, leak, bad], {
    env: { ...process.env, SLOT_POSTRUN_REPO: repo },
  });
}

// A monitoring file only enters the sweep if it is NEWER than the run-start
// marker, so age the marker into the past rather than sleeping.
function ageMarker() {
  const past = new Date(Date.now() - 60_000);
  utimesSync(marker, past, past);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'slot-postrun-'));
  sh('git', ['-C', repo, 'init', '-q']);
  mkdirSync(join(repo, 'monitoring'));
  scratch = join(repo, 'scratch');
  mkdirSync(scratch);
  log = join(repo, 'runs.log');
  writeFileSync(log, '===== test-job run =====\n');
  marker = join(repo, '.run-start');
  writeFileSync(marker, '');
  ageMarker();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('slot-postrun.sh exit-code semantics (finding 20260827-phase-2-381)', () => {
  it('reports OK and exits 0 on a clean rc=0 run, appending the done line', () => {
    const r = runPostrun();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('test-job run OK');
    expect(readFileSync(log, 'utf8')).toMatch(/===== done rc=0 /);
  });

  it('THE 26 AUG BUG: a quarantine on a successful run is informational, not a failure', () => {
    // Reverting slot-postrun.sh to the old combined failure branch makes this
    // exit 1 with "FAILED (rc=0)" — exactly what job-status recorded at
    // 2026-08-26T17:48:06Z for a board pass that had succeeded.
    const leakFile = join(repo, 'monitoring', 'leaked-report.json');
    writeFileSync(leakFile, '{"description": "tenant detail that must not be committed"}');
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('privacy quarantine');
    expect(r.stderr).toContain('PRIVACY');
    expect(r.stderr).not.toContain('FAILED');
    // The file is still quarantined — informational does not mean ignored.
    expect(existsSync(leakFile)).toBe(false);
    expect(existsSync(join(scratch, 'leaked-report.json'))).toBe(true);
  });

  it('preserves the real non-zero rc instead of flattening it to 1', () => {
    const r = runPostrun({ rc: 7 });
    expect(r.status).toBe(7);
    expect(r.stderr).toContain('FAILED (rc=7)');
    expect(readFileSync(log, 'utf8')).toMatch(/===== done rc=7 /);
  });

  it('still fails (exit 1) when rc=0 but the log tail carries an auth/broken marker', () => {
    writeFileSync(log, '===== test-job run =====\nOAuth access token has expired\n');
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAILED');
  });

  it('only reads THIS run\'s tail: a failure marker before start_line does not fail the run', () => {
    writeFileSync(log, 'OAuth access token has expired\n===== test-job run =====\nall good\n');
    const r = runPostrun({ rc: 0, startLine: 1 });
    expect(r.status).toBe(0);
  });
});

describe('slot-postrun.sh privacy sweep exemptions', () => {
  it('never quarantines a drift schema snapshot (schema-YYYY-MM-DD.json)', () => {
    // Schema snapshots carry '"description":' (field descriptions) and
    // "Inbound Message Content" (a field NAME) — table structure, not
    // message content. False-positived on 25 Aug (41 files) and 26 Aug 2026.
    const snap = join(repo, 'monitoring', 'schema-2026-08-26.json');
    writeFileSync(snap, '{"fldX": {"name": "Inbound Message Content", "description": "field"}}');
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('PRIVACY');
    expect(existsSync(snap)).toBe(true);
  });

  it('never quarantines a git-tracked file', () => {
    const tracked = join(repo, 'monitoring', 'committed-report.md');
    writeFileSync(tracked, 'CREDITOR MATTER — historic committed report');
    sh('git', ['-C', repo, 'add', 'monitoring/committed-report.md']);
    sh('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed']);
    writeFileSync(tracked, 'CREDITOR MATTER — touched this run'); // newer than marker
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(0);
    expect(existsSync(tracked)).toBe(true);
  });

  it('leaves files older than the run-start marker alone', () => {
    const old = join(repo, 'monitoring', 'old-report.json');
    writeFileSync(old, '{"description": "predates this run"}');
    const past = new Date(Date.now() - 120_000);
    utimesSync(old, past, past);
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(0);
    expect(existsSync(old)).toBe(true);
  });
});

describe('slot wrappers use the shared epilogue and trap abnormal death (finding 20260827-phase-2-382)', () => {
  const wrappers = [
    'scripts/task-manager-run.sh',
    'scripts/inbound-triage-run.sh',
    'scripts/agent-slot-run.sh',
  ];

  for (const w of wrappers) {
    it(`${w} calls slot-postrun.sh, traps EXIT/TERM/HUP/INT, and keeps no inline sweep`, () => {
      const src = readFileSync(join(ROOT, w), 'utf8');
      expect(src).toContain('scripts/slot-postrun.sh');
      // The 09:00 26 Aug death left a start header with no done line. Every
      // catchable termination must now write one.
      expect(src).toContain('trap __on_exit EXIT');
      expect(src).toContain("trap 'exit 143' TERM");
      expect(src).toContain("trap 'exit 129' HUP");
      expect(src).toContain("trap 'exit 130' INT");
      expect(src).toContain('__POSTRUN_DONE=1');
      // The old inline copy of the sweep is what diverged and mislabelled a
      // good run; it must not come back alongside the shared helper.
      expect(src).not.toContain('__LEAKED');
      // The old combined failure branch must not come back either.
      expect(src).not.toMatch(/\[ \$RC -ne 0 \] \|\| \[ -n "\$__BAD" \]/);
    });
  }
});

describe('repo TOP-LEVEL sweep (1 Sep 2026: report files landed in the repo root)', () => {
  // The 13:00 and 17:00 task-manager slots wrote report-*.json/md at the
  // repo root: the skill referenced $LOG_DIR/$SCRATCH, which the runner
  // never exported under those names, so relative writes landed in the
  // wrapper's cwd. The sweep must now catch run artifacts at -maxdepth 1.
  it('quarantines a slot-run artifact this run created at the repo root, informationally', () => {
    const stray = join(repo, 'report-2026-09-01-17-v2.json');
    writeFileSync(stray, '{"actions": [{"task": "recX", "move": "close"}]}');
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('PRIVACY');
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(join(scratch, 'report-2026-09-01-17-v2.json'))).toBe(true);
  });

  it('quarantines a leak-content top-level file even when the name is unfamiliar', () => {
    const stray = join(repo, 'notes-tmp.txt');
    writeFileSync(stray, 'CREDITOR MATTER — draft that must never sit in a public repo');
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(0);
    expect(existsSync(stray)).toBe(false);
  });

  it('leaves a harmless unfamiliar top-level file, a tracked file, and a pre-run file alone', () => {
    const harmless = join(repo, 'scribble.txt');
    writeFileSync(harmless, 'no leak content here');
    const tracked = join(repo, 'report-tracked.json');
    writeFileSync(tracked, '{}');
    sh('git', ['-C', repo, 'add', 'report-tracked.json']);
    sh('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed']);
    writeFileSync(tracked, '{"touched": "this run"}');
    const old = join(repo, 'board-tmp.json');
    writeFileSync(old, '{"predates": "this run"}');
    const past = new Date(Date.now() - 120_000);
    utimesSync(old, past, past);
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(0);
    expect(existsSync(harmless)).toBe(true);
    expect(existsSync(tracked)).toBe(true);
    expect(existsSync(old)).toBe(true);
  });
});

describe('repo-WIDE sweep (2 Sep 2026, finding 435: helper scripts and a briefing in scripts/ and deeper)', () => {
  // The 17:00 task-manager slot wrote ten scripts/_tm_*.py helpers, a
  // close-proposal text and a rec*-output.md briefing with message content
  // into the public checkout. The top-level sweep saw none of it.
  it('quarantines an underscore helper under scripts/ even with no leak content', () => {
    mkdirSync(join(repo, 'scripts'));
    const stray = join(repo, 'scripts', '_tm_board_dups.py');
    writeFileSync(stray, 'import json\nprint("no private content here")\n');
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('PRIVACY');
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(join(scratch, '_tm_board_dups.py'))).toBe(true);
  });

  it('quarantines a rec*-output.md briefing and a deep leak-content file', () => {
    mkdirSync(join(repo, 'scripts'));
    mkdirSync(join(repo, 'docs'));
    const brief = join(repo, 'scripts', 'recr4lh8H9kALXMFy-output.md');
    writeFileSync(brief, 'TASK ID: recr4lh8H9kALXMFy\nTASK NAME: set a password\n');
    const deep = join(repo, 'docs', 'notes.txt');
    writeFileSync(deep, 'CREDITOR MATTER — never in a public repo');
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(0);
    expect(existsSync(brief)).toBe(false);
    expect(existsSync(deep)).toBe(false);
  });

  it('leaves tests/ fixtures, harmless untracked code, tracked files and the scratch dir alone', () => {
    mkdirSync(join(repo, 'tests'));
    mkdirSync(join(repo, 'js'));
    const fixture = join(repo, 'tests', 'new-case.test.js');
    writeFileSync(fixture, "const s = 'CREDITOR MATTER fixture';");
    const code = join(repo, 'js', 'feature.js');
    writeFileSync(code, 'export const x = 1;');
    const inScratch = join(scratch, 'close_recABC.txt');
    writeFileSync(inScratch, 'CLOSE PROPOSAL: duplicate');
    const tracked = join(repo, 'js', 'tracked.js');
    writeFileSync(tracked, '"description": "field"');
    sh('git', ['-C', repo, 'add', 'js/tracked.js']);
    sh('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed']);
    writeFileSync(tracked, '"description": "touched this run"');
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('PRIVACY');
    expect(existsSync(fixture)).toBe(true);
    expect(existsSync(code)).toBe(true);
    expect(existsSync(inScratch)).toBe(true);
    expect(existsSync(tracked)).toBe(true);
  });
});
