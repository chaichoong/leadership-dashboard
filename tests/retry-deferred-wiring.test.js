import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RETRY = resolve(ROOT, 'scripts/retry-deferred.py');
const SCHEDULE = resolve(ROOT, 'scripts/job-schedule.json');

// Finding 20260828-exceptions-386.
//
// A job gated on the Google Drive mount can be DEFERRED: the mount wakes lazily
// and an unmounted vault lists but will not open. retry-deferred exists to bring
// such a job back — but only for jobs that opted in with retryWhenDeferred.
//
// ceo-agent carried the drive precondition and no flag. On 27 Aug 2026 it
// deferred at 06:45, never ran, and retry-deferred reported "NOT WIRED" on eight
// consecutive hourly sweeps. The 09:00 CEO brief went without its input and no
// alarm fired, because reporting a gap is not failing on one.
//
// The pairing is a property of the schedule, so it is checked on every run
// rather than only on the days it bites. `false` is a declaration and passes; a
// MISSING key is an omission and fails.

function run(args) {
  try {
    const stdout = execFileSync('python3', [RETRY, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

function driveGated(cfg) {
  return (cfg.needs || []).some((n) => n && typeof n === 'object' && 'drive' in n);
}

function networkGated(cfg) {
  return (cfg.needs || []).some(
    (n) => n === 'network' || (n && typeof n === 'object' && 'network' in n),
  );
}

// Finding 20260906-daily-ops-476. Finding 386 fixed only the Drive half. A
// network probe flaps for the same reason and costs the same day: on 4 and 5
// Sep 2026 a DNS blip on api.airtable.com deferred `prospecting` twice, and the
// hourly sweep printed "NOT WIRED" and exited 0 both days.
const transientGated = (cfg) => driveGated(cfg) || networkGated(cfg);
const live = (name, cfg) => !name.startsWith('_') && cfg && cfg.cron && cfg.enabled !== false;

describe('retry-deferred wiring check', () => {
  const schedule = JSON.parse(readFileSync(SCHEDULE, 'utf8'));

  it('every drive-gated job in the live schedule declares retryWhenDeferred', () => {
    const gated = Object.entries(schedule).filter(
      ([name, cfg]) => !name.startsWith('_') && cfg && cfg.cron && driveGated(cfg),
    );
    // Control: if this list is empty the assertion below is vacuous and would
    // pass for ever after someone renames `needs` or `drive`.
    expect(gated.length).toBeGreaterThanOrEqual(4);
    const undeclared = gated
      .filter(([, cfg]) => !('retryWhenDeferred' in cfg))
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('ceo-agent is opted IN — it feeds the 09:00 CEO brief', () => {
    expect(schedule['ceo-agent'].retryWhenDeferred).toBe(true);
  });

  it('daily-ops opts out explicitly, with a recorded reason', () => {
    expect(schedule['daily-ops'].retryWhenDeferred).toBe(false);
    expect(String(schedule['daily-ops'].retryWhenDeferredNote || '')).not.toBe('');
  });

  it('every ENABLED job on a transient precondition declares retryWhenDeferred', () => {
    const gated = Object.entries(schedule).filter(
      ([name, cfg]) => live(name, cfg) && transientGated(cfg),
    );
    // Control: an empty list would make the assertion below vacuous for ever
    // after someone renames `needs`, `drive` or `network`.
    expect(gated.length).toBeGreaterThanOrEqual(20);
    const undeclared = gated
      .filter(([, cfg]) => !('retryWhenDeferred' in cfg))
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('the two jobs that lost days to a DNS blip are opted IN', () => {
    expect(schedule.prospecting.retryWhenDeferred).toBe(true);
    expect(schedule['prod-sweep-weekly'].retryWhenDeferred).toBe(true);
  });

  it('handback-poll opts out explicitly, with a recorded reason', () => {
    // A 30-minute poller does not lose a day to one deferred slot, so re-firing
    // it would add a duplicate poll rather than rescue anything. An explicit no
    // with a reason is a decision; a missing key is the omission this fails on.
    expect(schedule['handback-poll'].retryWhenDeferred).toBe(false);
    expect(String(schedule['handback-poll'].retryWhenDeferredNote || '')).not.toBe('');
  });

  it('checkwiring passes on the live schedule', () => {
    const r = run(['checkwiring']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/all declare retryWhenDeferred/);
  });

  it('BACK-TEST: removing the flag makes checkwiring FAIL, not merely report', () => {
    const broken = JSON.parse(readFileSync(SCHEDULE, 'utf8'));
    delete broken['ceo-agent'].retryWhenDeferred;
    const p = join(mkdtempSync(join(tmpdir(), 'retry-wiring-')), 'job-schedule.json');
    writeFileSync(p, JSON.stringify(broken));

    const r = run(['checkwiring', p]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/UNDECLARED\s+ceo-agent/);
  });

  it('BACK-TEST: removing the flag from a NETWORK-gated job also FAILS', () => {
    const broken = JSON.parse(readFileSync(SCHEDULE, 'utf8'));
    expect(networkGated(broken.prospecting)).toBe(true);
    expect(driveGated(broken.prospecting)).toBe(false); // network only — the half 386 missed
    delete broken.prospecting.retryWhenDeferred;
    const p = join(mkdtempSync(join(tmpdir(), 'retry-wiring-')), 'job-schedule.json');
    writeFileSync(p, JSON.stringify(broken));

    const r = run(['checkwiring', p]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/UNDECLARED\s+prospecting/);
  });

  it('an explicit false is a decision and passes; only a missing key fails', () => {
    const cfg = JSON.parse(readFileSync(SCHEDULE, 'utf8'));
    const p = join(mkdtempSync(join(tmpdir(), 'retry-wiring-')), 'job-schedule.json');
    writeFileSync(p, JSON.stringify(cfg));
    expect(run(['checkwiring', p]).code).toBe(0);
    expect(cfg['daily-ops'].retryWhenDeferred).toBe(false); // and it is drive-gated
    expect(driveGated(cfg['daily-ops'])).toBe(true);
  });

  it('the decision selftest still passes in full', () => {
    const r = run(['selftest']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/decision cases pass/);
    expect(r.stdout).not.toMatch(/^FAIL/m);
  });
});
