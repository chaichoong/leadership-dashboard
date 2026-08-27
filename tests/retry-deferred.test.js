import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SWEEP = resolve(ROOT, 'scripts/retry-deferred.py');
const SCHEDULE = JSON.parse(readFileSync(resolve(ROOT, 'scripts/job-schedule.json'), 'utf8'));
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// 27 Aug 2026. launchd fires a job once; if the machine is not ready the queue
// DEFERS, and nothing ever came back. A defer was a lost day, and the generous
// maxLateMinutes allowed lateness nothing could use. The brain went four days
// unfed (24-27 Aug) with Drive unreadable from a sleeping Mac at 22:45.
// ─────────────────────────────────────────────────────────────────────────────

describe('retry-deferred decision table', () => {
  it('passes its own selftest, covering every branch', () => {
    const out = execFileSync('python3', [SWEEP, 'selftest'], { encoding: 'utf8' });
    expect(out).toMatch(/11\/11 decision cases pass/);
    expect(out).not.toMatch(/^FAIL/m);
  });

  it('a defer past its window is MISSED, never a quiet skip', () => {
    // Filing it under "skip" let the sweep print a clean all-clear on the very
    // morning the brain was four days unfed. The report must name a lost day.
    const src = read('scripts/retry-deferred.py');
    expect(src).toMatch(/return "missed"/);
    expect(src).toMatch(/lost the day/);
  });
});

describe('BACK-TEST: the two bugs this sweep\'s own dry run caught', () => {
  it('reads events into a LIST, not the generator jq.read_events() returns', () => {
    // Consumed once, the generator is empty for every later caller: the first
    // job checked read correctly and every job after it saw zero events and
    // reported "did not defer" — a broken read wearing the face of an
    // all-clear. Exactly the failure the sweep exists to end.
    const src = read('scripts/retry-deferred.py');
    expect(src).toMatch(/events = list\(jq\.read_events\(\)\)/);
    expect(src, 'a bare read_events() assignment is the bug returning')
      .not.toMatch(/events = jq\.read_events\(\)\s*$/m);
  });

  it('counts today\'s attempts with a datetime, never jq.now()\'s float', () => {
    // jq.now() returns time.time(). Passing it to attempts_today crashed the
    // first real run — but only AFTER the first kickstart, because the
    // ledger-missing early return hides it until the file exists. Neither a dry
    // run nor a first run can reach it, which is the shape that ships.
    const src = read('scripts/retry-deferred.py');
    expect(src).toMatch(/attempts_today\(job, datetime\.now\(\)\.astimezone\(\)\)/);
    expect(src, 'jq.now() is a float, not a datetime')
      .not.toMatch(/attempts_today\([^)]*jq\.now\(\)/);
  });

  it('normalises naive local due times against aware UTC log stamps', () => {
    // last_scheduled() returns naive local; parse_event_ts() returns aware UTC.
    // Comparing them raises TypeError, which would have crashed the sweep every
    // hour, silently, had it shipped.
    const src = read('scripts/retry-deferred.py');
    expect(src).toMatch(/def _aware\(dt\)/);
    expect(src).toMatch(/_aware\(due\)/);
  });
});

describe('every `needs` entry is a form preconditions_met actually understands', () => {
  // ceo-agent carried `"drive"` as a bare string where the queue expects
  // {"drive": path}. preconditions_met fell through to its unknown-precondition
  // branch and returned False on EVERY run, so the job deferred permanently and
  // had never once run — zero status records, ever. A one-word config typo that
  // nothing could see.
  const VALID_STRINGS = ['network'];

  it('control: the schedule has jobs that declare needs', () => {
    const withNeeds = Object.entries(SCHEDULE)
      .filter(([k, v]) => !k.startsWith('_') && v && v.needs);
    expect(withNeeds.length).toBeGreaterThan(3);
  });

  it('no job declares a precondition the queue cannot evaluate', () => {
    const bad = [];
    for (const [job, cfg] of Object.entries(SCHEDULE)) {
      if (job.startsWith('_') || !cfg || !cfg.needs) continue;
      for (const need of cfg.needs) {
        if (typeof need === 'string') {
          if (!VALID_STRINGS.includes(need)) bad.push(`${job}: bare "${need}"`);
        } else if (need && typeof need === 'object') {
          if (!('drive' in need)) bad.push(`${job}: object without a drive key`);
          else if (typeof need.drive !== 'string' || !need.drive.includes('CloudStorage')) {
            bad.push(`${job}: drive is not a CloudStorage path`);
          }
        } else {
          bad.push(`${job}: ${JSON.stringify(need)}`);
        }
      }
    }
    // Back-test: restoring ceo-agent's `"drive"` string makes this fail.
    expect(bad, 'these jobs defer for ever and never run').toEqual([]);
  });

  it('the valid string list matches what preconditions_met branches on', () => {
    // If job-queue learns a new bare precondition, this test must learn it too,
    // or a legitimate new need reads as a typo.
    const jq = read('scripts/job-queue.py');
    const fn = jq.match(/def preconditions_met\(cfg\)[\s\S]*?\n    return True/);
    expect(fn, 'preconditions_met (control)').not.toBeNull();
    for (const s of VALID_STRINGS) expect(fn[0]).toContain(`need == "${s}"`);
  });
});

describe('the jobs that lost days are opted in, and the sweep is registered', () => {
  it('the four jobs that died carry retryWhenDeferred', () => {
    for (const j of ['feed-brain', 'compound-brain', 'publish-brain', 'knowledge-os-sort']) {
      expect(SCHEDULE[j], j).toBeTruthy();
      expect(SCHEDULE[j].retryWhenDeferred, `${j} must opt in`).toBe(true);
    }
  });

  it('the brain jobs can actually be rescued by a morning sweep', () => {
    // A 22:45 defer with a 300-minute window closes at 03:45, while the Mac is
    // still asleep — so the sweep could report the miss but never fix it.
    for (const j of ['feed-brain', 'compound-brain', 'publish-brain']) {
      const due = 22 * 60 + 45;
      const reach = due + SCHEDULE[j].maxLateMinutes;
      expect(reach % (24 * 60), `${j} must still be runnable after 09:00`)
        .toBeGreaterThan(9 * 60);
    }
  });

  it('retry-deferred is registered, hourly, and outside the queue', () => {
    const cfg = SCHEDULE['retry-deferred'];
    expect(cfg, 'registered in job-schedule.json').toBeTruthy();
    expect(cfg.cron).toMatch(/^\d+ \* \* \* \*$/);
    // Outside the queue on purpose: it exists to rescue jobs the queue turned
    // away, so waiting behind a stuck routine would stop it doing its one job.
    expect(cfg.queued).toBe(false);
  });

  it('resolves launchd labels from the plists rather than assuming a prefix', () => {
    // Most jobs are com.kevinbrittain.<job>; masterplan-sync is
    // com.od.masterplan-sync. Assuming the convention means a job that can
    // never be re-fired while the sweep reports a clean run for ever.
    const src = read('scripts/retry-deferred.py');
    expect(src).toMatch(/plistlib/);
    expect(src, 'must not build the label by string concatenation')
      .not.toMatch(/com\.kevinbrittain\.["'\s]*\+|"com\.kevinbrittain\.%s"/);
    expect(src).toMatch(/no launchd label could be resolved|has_label/);
  });

  it('an opted-in job with no resolvable label is an ERROR, not a silent pass', () => {
    const src = read('scripts/retry-deferred.py');
    const m = src.match(/if not has_label:[\s\S]{0,240}/);
    expect(m).not.toBeNull();
    expect(m[0]).toContain('"error"');
  });
});
