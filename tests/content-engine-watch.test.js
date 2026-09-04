// Content Engine R1: the raw-footage folder watch (scripts/content-engine/watch.py) and its
// nightly Go Signal. The pure parts (clip-name parsing, streak-day arithmetic, record shape,
// queue order) run through the script's own selftest; the wiring checks below fail if the job
// is scheduled without being described, or described without being scheduled.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const WATCH = path.join(ROOT, 'scripts', 'content-engine', 'watch.py');
const RUN = path.join(ROOT, 'scripts', 'content-engine-run.sh');

describe('content-engine watch: selftest', () => {
  it('passes its own selftest (clip parsing, streak day, record shape, queue order)', () => {
    const out = JSON.parse(execFileSync('python3', [WATCH, 'selftest'], { encoding: 'utf8' }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(10);
  });

  it("counts the streak from Kevin's start date, 1 June 2020 = day 1 (4 Jul 2026 = 2225)", () => {
    const src = readFileSync(WATCH, 'utf8');
    expect(src).toMatch(/STREAK_START = dt\.date\(2020, 6, 1\)/);
    expect(src).toContain('def resolve_episode(date_day, spoken_day');
  });

  it('keeps its state outside the public repo and writes it atomically', () => {
    const src = readFileSync(WATCH, 'utf8');
    expect(src).toMatch(/knowledge-os\/logs\/content-engine\/ledger\.json/);
    expect(src).toContain('os.replace(tmp, LEDGER)');
  });

  it('creates one record per shooting day, not per clip, and checks for an existing one first', () => {
    const src = readFileSync(WATCH, 'utf8');
    expect(src).toContain('one record per shooting day');
    expect(src).toContain('def find_record(file_id, day)');
    expect(src).toMatch(/MAX_PULLED = 2/);
  });
});

describe('content-engine watch: nightly wiring', () => {
  const schedule = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'job-schedule.json'), 'utf8'));
  const job = schedule['content-engine'];

  it('is a wrapped, Drive-gated job in job-schedule.json that retries when deferred', () => {
    expect(job).toBeTruthy();
    expect(job.mode).toBe('wrapped');
    expect(job.cron).toBe('0 2 * * *');
    expect(job.retryWhenDeferred).toBe(true);
    const drive = job.needs.find((n) => typeof n === 'object' && n.drive);
    expect(drive.drive).toContain('Runpreneur - Raw Video');
  });

  it('has a run script that scans, pulls one clip, renders one clip and reports', () => {
    expect(existsSync(RUN)).toBe(true);
    const run = readFileSync(RUN, 'utf8');
    expect(run).toContain('watch.py scan --create');
    expect(run).toContain('watch.py next');
    expect(run).toContain('watch.py report');
    expect(run).toContain('render.py run --limit 1');
    expect(run).toContain('platform_copy.py run --pending');
    expect(run).not.toContain('stab.py');   // rendering goes through render.py, never a bare stab call
  });

  it('streams the raw clip with retries while Drive hydrates it, and a failed pull never kills the run (4 Sep 2026)', () => {
    const w = readFileSync(path.join(ROOT, 'scripts', 'content-engine', 'watch.py'), 'utf8');
    expect(w).toContain('DRIVE_RETRY_ERRNOS = (11, 35)');
    expect(w).toContain('copy_streaming(e["path"], dest + ".part")');
    expect(w).not.toContain('shutil.copyfile(e["path"]');
    const sh = readFileSync(path.join(ROOT, 'scripts', 'content-engine-run.sh'), 'utf8');
    expect(sh).toMatch(/watch\.py next \|\| echo/);
    expect(sh).toContain('REPO="$(cd "$(dirname "$0")/.." && pwd)"');
  });

  it("resets a clip left 'pulling' by a dead run, so it is not skipped for ever", () => {
    const w = readFileSync(path.join(ROOT, 'scripts', 'content-engine', 'watch.py'), 'utf8');
    expect(w).toContain('def repair_stale_pulls(');
    expect(w).toContain('stale = repair_stale_pulls(ledger)');
  });

  it('is described on the Automations list (deterministic job, not a register agent)', () => {
    const auto = readFileSync(path.join(ROOT, 'js', 'automations-data.js'), 'utf8');
    expect(auto).toMatch(/key: 'content-engine'/);
    // Since R10 (3 Sep 2026) the job DOES schedule, but only episodes Kevin approved on the card.
    expect(auto).toContain('Nothing is scheduled without his approval on the card');
  });
});
