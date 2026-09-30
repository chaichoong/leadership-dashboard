// THE SWEEP READ THE WRONG DAYS (finding 20260924-ceo-memory-sweep-591).
//
// The nightly memory sweep picked session transcripts by FILE MTIME. Mtime says
// when a file was last touched, which is not what day the conversation in it
// happened, and it failed in both directions on one run:
//
//   * On the 24 Sep run for 23 Sep, three mtime-selected files actually held
//     content from 15, 21-22 and 22 Sep. Caught by hand.
//   * Any session live on 23 Sep and resumed on 24 Sep carried a 24 Sep mtime,
//     so it fell outside the window and would never have been read at all.
//
// scripts/transcripts-for-day.py reads the LINE timestamps instead. Both gaps
// are in its selftest, which this runs, plus the CLI contract the skill depends
// on: JSON shape, the quiet-day exit code, and a refusal on a bad date.

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(root, 'scripts/transcripts-for-day.py');
const ROOT = mkdtempSync(join(tmpdir(), 'tfd-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const py = (...args) => spawnSync('python3', [SCRIPT, ...args], { encoding: 'utf8' });

describe('the script proves both mtime gaps in its own selftest', () => {
  it('passes its selftest', () => {
    const r = py('selftest');
    expect(r.stdout).toMatch(/selftest ok: content timestamps decide, mtime does not/);
    expect(r.status).toBe(0);
  });
});

describe('the CLI contract the skill calls', () => {
  // One transcript per case, with mtime deliberately disagreeing with content.
  const dir = mkdtempSync(join(ROOT, 'proj-'));
  const line = (day) => JSON.stringify({ type: 'x', timestamp: `${day}T12:00:00.000Z` }) + '\n';
  const setMtime = (p, day) => {
    const t = new Date(`${day}T12:00:00`);
    utimesSync(p, t, t);
  };

  const resumed = join(dir, 'resumed.jsonl');
  writeFileSync(resumed, line('2026-09-23') + line('2026-09-24'));
  setMtime(resumed, '2026-09-24');

  const stale = join(dir, 'stale.jsonl');
  writeFileSync(stale, line('2026-09-15') + line('2026-09-22'));
  setMtime(stale, '2026-09-24');

  it('selects the session resumed the next day, and leaves out the stale file', () => {
    const r = py('2026-09-23', '--dir', dir, '--json');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.day).toBe('2026-09-23');
    expect(out.count).toBe(1);
    expect(out.transcripts[0].path).toBe(resumed);
    expect(out.transcripts[0].lines).toBe(1);
    // It reports the disagreement rather than hiding it.
    expect(out.transcripts[0].mtimeDay).toBe('2026-09-24');
  });

  it('exits 1 on a genuinely quiet day, so the sweep can log it and stop', () => {
    const r = py('2026-01-01', '--dir', dir, '--json');
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).count).toBe(0);
  });

  it('flags the mtime disagreement in the plain-text form too', () => {
    const r = py('2026-09-23', '--dir', dir);
    expect(r.stdout).toMatch(/mtime selection would have got this wrong/);
  });

  it('honours --min-lines, so one stray line is not a day of conversation', () => {
    expect(py('2026-09-23', '--dir', dir, '--min-lines', '2', '--json').status).toBe(1);
  });

  it('refuses a date it cannot read instead of guessing one', () => {
    const r = py('yesterday', '--dir', dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/REFUSED/);
  });

  it('never prints transcript content, only paths and counts', () => {
    const secret = join(dir, 'secret.jsonl');
    writeFileSync(secret, JSON.stringify({
      type: 'x', timestamp: '2026-09-23T12:00:00.000Z',
      content: 'RENT ARREARS FIGURE AND A TENANT NAME',
    }) + '\n');
    for (const args of [['2026-09-23', '--dir', dir], ['2026-09-23', '--dir', dir, '--json']]) {
      expect(py(...args).stdout).not.toMatch(/RENT ARREARS FIGURE/);
    }
  });
});

describe('the skill calls the script and forbids the old route', () => {
  const skill = readFileSync(
    join(root, '.claude/scheduled-tasks/ceo-memory-sweep/SKILL.md'), 'utf8');

  it('names the script', () => {
    expect(skill).toMatch(/scripts\/transcripts-for-day\.py/);
  });

  it('says in so many words that mtime is not the selector', () => {
    expect(skill).toMatch(/NEVER pick transcripts by `ls -t`, `find -mtime` or file modification time/);
  });
});
