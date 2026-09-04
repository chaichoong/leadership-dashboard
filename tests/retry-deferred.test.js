import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
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
    // Count is read from the output rather than hardcoded — a hardcoded number
    // turns every new case into a failing test instead of a passing one.
    const m = out.match(/(\d+)\/(\d+) decision cases pass/);
    expect(m, `no tally in: ${out}`).toBeTruthy();
    expect(m[1]).toBe(m[2]);
    expect(Number(m[2])).toBeGreaterThanOrEqual(15);
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

// ─────────────────────────────────────────────────────────────────────────────
// THE FALSE ALL-CLEAR (28 Aug 2026).
//
// The brain jobs deferred overnight with Drive unreadable from a sleeping Mac.
// By morning Drive was readable and they were ready to re-fire — but another
// job held the queue lock, and "lock held" returned a bare "skip". report()
// prints no line for a skip and counted none of them, so the sweep printed:
//
//     retry-deferred: 0 re-fired, 0 lost the day, 0 still blocked, ...
//       nothing had deferred — this is a real all-clear
//
// while feed-brain sat 40 minutes from losing the day. The sweep built to end
// exactly this failure was announcing it as success. Observed live that
// morning, then reproduced by calling decide() with only lock_holder changed.
//
// The fix inverts the default: silence is an ALLOW-LIST of three states that
// each mean "nothing outstanding". Everything else is printed, including an
// action this code has never seen.
// ─────────────────────────────────────────────────────────────────────────────
describe('a job that did not run is never represented by silence', () => {
  function report(results) {
    const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('rd', ${JSON.stringify(SWEEP)})
rd = importlib.util.module_from_spec(spec); spec.loader.exec_module(rd)
sys.exit(rd.report(json.loads(sys.argv[1])))
`;
    const r = spawnSync('python3', ['-c', py, JSON.stringify(results)], { encoding: 'utf8' });
    return { out: r.stdout || '', code: r.status };
  }

  it('a deferred job waiting on the queue is NAMED, never silent', () => {
    const { out } = report([{
      job: 'feed-brain', action: 'waiting',
      reason: 'deferred (drive unreadable); ready to re-fire but the queue lock is held by inbound-triage',
    }]);
    expect(out).toMatch(/WAITING\s+feed-brain/);
    expect(out).toMatch(/1 waiting/);
    // The exact sentence that appeared over three un-run brain jobs.
    expect(out).not.toMatch(/real all-clear/);
  });

  it('the cap-reached case is reported too — it also means the job never ran', () => {
    const { out } = report([{ job: 'publish-brain', action: 'waiting', reason: 'already re-fired 3 times' }]);
    expect(out).toMatch(/WAITING\s+publish-brain/);
    expect(out).not.toMatch(/real all-clear/);
  });

  it('only the three "nothing outstanding" states may pass in silence', () => {
    const { out } = report([
      { job: 'a', action: 'skip-not-due', reason: 'never due' },
      { job: 'b', action: 'skip-succeeded', reason: 'already ran' },
      { job: 'c', action: 'skip-not-deferred', reason: 'did not defer' },
    ]);
    // These three genuinely have nothing outstanding, so the all-clear is real.
    expect(out).toMatch(/real all-clear/);
    expect(out).not.toMatch(/WAITING|BLOCKED|MISSED/);
  });

  it('an action nobody wrote a label for is still printed, and fails the run', () => {
    // The property that keeps this fixed: a branch added to decide() later is
    // visible by default rather than silent by default.
    const { out, code } = report([{ job: 'z', action: 'invented-today', reason: 'new branch' }]);
    expect(out).toMatch(/INVENTED-TODAY\s+z/);
    expect(out).not.toMatch(/real all-clear/);
    expect(code).toBe(1);
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

// ─────────────────────────────────────────────────────────────────────────────
// 29 Aug 2026, finding 397. maxLateMinutes 720 turns a long outage into a
// silent lost day. From 28 Aug 23:07Z to 29 Aug 09:08Z every hourly pass logged
// "still blocked: cannot read founder-profile.md [Errno 11]" for compound-brain,
// feed-brain and publish-brain. compound-brain last ran 27 Aug 16:33 and
// feed-brain 27 Aug 16:17 — the brain went TWO DAYS unfed, unpublished and
// uncompounded, and the only signal was one drive-auth line and hourly BLOCKED
// lines nobody reads. A lost morning and a job that has stopped printed the
// same word.
// ─────────────────────────────────────────────────────────────────────────────
describe('a job silent for two days is escalated, not filed under MISSED', () => {
  // Drives the real decide() so the branch is exercised, not just grepped for.
  const decide = (over) => {
    const py = `
import importlib.util, json
from datetime import datetime, timedelta
spec = importlib.util.spec_from_file_location('rd', ${JSON.stringify(SWEEP)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
now = datetime(2026, 8, 29, 11, 30)
cfg = {"cron": "0 23 * * *", "maxLateMinutes": 960, "retryWhenDeferred": True}
base = dict(due=now - timedelta(hours=12), late=720.0, is_stale=True, opted_in=True,
            has_label=True, succeeded=False, defer_reason="cannot read founder-profile.md",
            ready=False, ready_why="drive", lock_holder=None, attempts=0, days_silent=0)
base.update(json.loads(${JSON.stringify(JSON.stringify(over))}))
action, reason = m.decide("compound-brain", cfg, now, **base)
print(json.dumps({"action": action, "reason": reason}))
`;
    return JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }));
  };

  it('BACK-TEST: two days silent is STOPPED, where it used to be plain MISSED', () => {
    const r = decide({ days_silent: 2 });
    expect(r.action).toBe('missed-days');
    expect(r.reason).toMatch(/HAS NOT COMPLETED FOR 2 DAYS/);
  });

  it('CONTROL: one lost day is still an ordinary MISSED, or the alarm is noise', () => {
    // Escalating on every late morning is what teaches people to ignore it.
    expect(decide({ days_silent: 1 }).action).toBe('missed');
    expect(decide({ days_silent: 0 }).action).toBe('missed');
  });

  it('a job never seen completing here is not turned into a fake escalation', () => {
    expect(decide({ days_silent: null }).action).toBe('missed');
  });

  it('escalation needs the job to be OUT of its window, not merely stale data', () => {
    // Still inside maxLateMinutes means it can still be re-fired today.
    expect(decide({ days_silent: 9, is_stale: false, ready: true }).action).toBe('retry');
  });

  it('report() names the stopped jobs on their own line and fails the run', () => {
    const py = `
import importlib.util, io, json, contextlib
spec = importlib.util.spec_from_file_location('rd', ${JSON.stringify(SWEEP)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rows = [
  {"job": "compound-brain", "action": "missed-days", "reason": "stopped", "due": None},
  {"job": "feed-brain", "action": "missed-days", "reason": "stopped", "due": None},
  {"job": "masterplan-sync", "action": "blocked", "reason": "still blocked", "due": None},
]
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = m.report(rows)
print(json.dumps({"out": buf.getvalue(), "code": code}))
`;
    const r = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }));
    expect(r.out).toMatch(/ESCALATE: compound-brain, feed-brain/);
    // On its own line near the top — buried thirty lines down among BLOCKED
    // noise is how the brain went two days unfed with something printed daily.
    const lines = r.out.split('\n');
    expect(lines.findIndex((l) => l.includes('ESCALATE'))).toBeLessThan(2);
    expect(r.code, 'a stopped job must not exit 0').toBe(1);
  });

  it('CONTROL: an ordinary MISSED still exits 0, so the escalation means something', () => {
    const py = `
import importlib.util, io, json, contextlib
spec = importlib.util.spec_from_file_location('rd', ${JSON.stringify(SWEEP)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rows = [{"job": "feed-brain", "action": "missed", "reason": "late", "due": None}]
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    code = m.report(rows)
print(json.dumps({"out": buf.getvalue(), "code": code}))
`;
    const r = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }));
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/ESCALATE/);
  });
});

describe('the Drive-gated jobs get a window a morning flap cannot eat', () => {
  // 28 Aug: the mount cleared at 10:06 and compound-brain was marked MISSED at
  // 11:06 anyway, because 23:00 + 720 min expires at 11:00. The window has to
  // outlast a morning flap or retry-deferred can never rescue anything.
  for (const job of ['feed-brain', 'compound-brain', 'publish-brain']) {
    it(`${job} survives past midday`, () => {
      const cfg = SCHEDULE[job];
      const [, hh] = cfg.cron.split(' ');
      const expiresAt = Number(hh) * 60 + Number(cfg.cron.split(' ')[0]) + cfg.maxLateMinutes;
      // Minutes past its own start; it fires the night before, so > 24h means
      // it would never be skipped at all, which is the opposite mistake.
      expect(expiresAt, 'must reach past 13:00 the next day').toBeGreaterThan(24 * 60 + 13 * 60);
      expect(cfg.maxLateMinutes, 'must still be skippable').toBeLessThan(1440);
      expect(cfg.retryWhenDeferred).toBe(true);
    });
  }

  it('knowledge-os-sort keeps a window inside the same working day', () => {
    const cfg = SCHEDULE['knowledge-os-sort'];
    expect(cfg.maxLateMinutes).toBeGreaterThan(480);
    expect(9 * 60 + cfg.maxLateMinutes).toBeLessThanOrEqual(20 * 60);
  });
});
