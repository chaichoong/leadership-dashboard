import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLL = resolve(ROOT, 'scripts/handback-poll.py');
const DISPATCH = resolve(ROOT, 'scripts/agent-dispatch.py');
const RUNNER = resolve(ROOT, 'scripts/handback-poll-run.sh');

// The hand-back poller (26 Aug 2026). Kevin approves from Slack; until this
// existed nothing opened the queue between daily-ops at 07:00 and the three
// triage slots, so his median wait was 3.6 hours for work the agent finishes in
// five minutes. The poller runs every thirty minutes and, on a quiet tick,
// spends nothing: the gate below decides whether to wake a headless claude run.
//
// The failure to fear is not a crash. It is a poller that answers "nothing to
// do" for ever after a field is renamed, because `counts.get(key, 0)` cannot
// tell an empty queue from a broken read. Every control here is back-tested:
// the fixture is the shape the bug would actually produce.

const BASE_COUNTS = {
  openTasksRead: 87, agentLinkedOpen: 56, worklist: 56,
  approvedHandbacks: 0, changesRequested: 0, deferredRedos: 0,
  newWork: 0, tier2Parked: 0, routingNeeded: 0, unclassified: 0,
};

function tmp() { return mkdtempSync(join(tmpdir(), 'handback-poll-')); }

function queueFile(dir, counts) {
  const p = join(dir, 'queue.json');
  writeFileSync(p, JSON.stringify({ counts: { ...BASE_COUNTS, ...counts } }));
  return p;
}

/** Run the gate. Never throws: the exit code IS the result. */
function gate(queuePath, logsDir) {
  try {
    const stdout = execFileSync('python3',
      [POLL, 'gate', '--queue', queuePath, '--dispatch-logs', logsDir],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, ...JSON.parse(stdout) };
  } catch (e) {
    return { code: e.status, ...JSON.parse(String(e.stdout || '{}')) };
  }
}

describe('hand-back gate — when to wake an agent', () => {
  it('WORKS when a hand-back is waiting (exit 0 spawns the run)', () => {
    const d = tmp();
    const r = gate(queueFile(d, { approvedHandbacks: 2, changesRequested: 3 }),
                   join(d, 'nologs'));
    expect(r.code).toBe(0);
    expect(r.decision).toBe('work');
    expect(r.total).toBe(5);
  });

  it('counts deferred redos as work — a redo Kevin delayed still owes him one', () => {
    const d = tmp();
    const r = gate(queueFile(d, { deferredRedos: 1 }), join(d, 'nologs'));
    expect(r.decision).toBe('work');
  });

  it('is IDLE, not broken, when only new work is queued (exit 3, no tokens spent)', () => {
    const d = tmp();
    const r = gate(queueFile(d, { newWork: 4 }), join(d, 'nologs'));
    expect(r.code).toBe(3);
    expect(r.decision).toBe('idle');
  });
});

describe('in-flight guard — two runs must never work one hand-back', () => {
  function runDir(logs, name, { report = false, ageMinutes = 0 } = {}) {
    const d = join(logs, name);
    mkdirSync(d, { recursive: true });
    const f = join(d, 'rec123.md');
    writeFileSync(f, 'draft');
    if (report) writeFileSync(join(d, 'report.json'), '{}');
    const when = Date.now() / 1000 - ageMinutes * 60;
    utimesSync(f, when, when);
    return d;
  }

  it('SKIPS while a dispatch run is actively writing', () => {
    const d = tmp(); const logs = join(d, 'logs');
    runDir(logs, '20260826-171319', { ageMinutes: 1 });
    const r = gate(queueFile(d, { approvedHandbacks: 5 }), logs);
    expect(r.code).toBe(3);
    expect(r.decision).toBe('skip');
    expect(r.reason).toMatch(/20260826-171319/);
  });

  it('does NOT skip for a run that crashed and left its directory behind', () => {
    // Freshness, not the mere absence of a report. A crashed run leaves a
    // report-less directory for ever; treating that as "busy" would stop the
    // poller permanently and it would look healthy the whole time.
    const d = tmp(); const logs = join(d, 'logs');
    runDir(logs, '20260801-200711', { ageMinutes: 600 });
    const r = gate(queueFile(d, { approvedHandbacks: 5 }), logs);
    expect(r.decision).toBe('work');
  });

  it('does NOT skip for a finished run, however recent', () => {
    const d = tmp(); const logs = join(d, 'logs');
    runDir(logs, '20260826-171319', { ageMinutes: 0, report: true });
    const r = gate(queueFile(d, { changesRequested: 2 }), logs);
    expect(r.decision).toBe('work');
  });
});

describe('controls — a broken read must never read as a quiet queue', () => {
  it('FAILS when the queue JSON never got written', () => {
    const d = tmp();
    const r = gate(join(d, 'absent.json'), join(d, 'nologs'));
    expect(r.code).toBe(1);
    expect(r.reason).toMatch(/never ran/);
  });

  it('FAILS on a queue JSON with no counts object', () => {
    const d = tmp();
    const p = join(d, 'q.json');
    writeFileSync(p, JSON.stringify({ worklist: [] }));
    expect(gate(p, join(d, 'nologs')).code).toBe(1);
  });

  it('FAILS when a count key is renamed — the silent-for-ever bug', () => {
    // Back-test: this is exactly what `approvedHandbacks` -> `approvedHandback`
    // in agent-dispatch.py would produce. With .get(key, 0) the gate would
    // report "no hand-backs waiting" every half hour, for ever, and nothing
    // would error.
    const d = tmp();
    const counts = { ...BASE_COUNTS, approvedHandbacks: 9 };
    delete counts.approvedHandbacks;
    counts.approvedHandback = 9;
    const p = join(d, 'q.json');
    writeFileSync(p, JSON.stringify({ counts }));
    const r = gate(p, join(d, 'nologs'));
    expect(r.code).toBe(1);
    expect(r.reason).toMatch(/approvedHandbacks/);
  });

  it('FAILS when agents hold open tasks but every lane counts zero', () => {
    const d = tmp();
    const r = gate(queueFile(d, {}), join(d, 'nologs')); // BASE is all-zero lanes
    expect(r.code).toBe(1);
    expect(r.reason).toMatch(/classifier is broken/);
  });

  it('is IDLE, not broken, when the agents genuinely hold nothing', () => {
    const d = tmp();
    const r = gate(queueFile(d, { agentLinkedOpen: 0, worklist: 0 }),
                   join(d, 'nologs'));
    expect(r.code).toBe(3);
    expect(r.decision).toBe('idle');
  });
});

describe('drift — the gate reads keys agent-dispatch.py actually emits', () => {
  it('every key the gate requires is present in the queue counts literal', () => {
    // The gate's control turns a rename into a loud failure at RUNTIME. This
    // turns it into a failure at PUSH time, which is cheaper.
    const required = JSON.parse(execFileSync('python3', ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location('hp', ${JSON.stringify(POLL)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(list(m.HANDBACK_KEYS) + list(m.SHAPE_KEYS)))
`], { encoding: 'utf8' }));
    expect(required.length).toBeGreaterThan(0);

    const src = readFileSync(DISPATCH, 'utf8');
    const block = src.slice(src.indexOf('"counts": {'));
    const emitted = block.slice(0, block.indexOf('\n        }'));
    for (const key of required) {
      expect(emitted, `agent-dispatch.py no longer emits "${key}"`)
        .toMatch(new RegExp(`"${key}"\\s*:`));
    }
  });
});

describe('the scheduled job itself', () => {
  const schedule = JSON.parse(readFileSync(resolve(ROOT, 'scripts/job-schedule.json'), 'utf8'));

  it('is registered, so the morning digest notices if it stops', () => {
    expect(schedule['handback-poll']).toBeTruthy();
    expect(schedule['handback-poll'].mode).toBe('wrapped');
  });

  it('fires every 30 minutes', () => {
    expect(schedule['handback-poll'].cron).toBe('*/30 * * * *');
  });

  it('skips a tick more than 20 minutes late rather than stampeding on wake', () => {
    // Every job on this Mac fires at once when it wakes. Six back-to-back
    // polls would each spawn a claude run against the same queue.
    const late = schedule['handback-poll'].maxLateMinutes;
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(30);
  });
});

describe('the runner keeps the loop safe', () => {
  const sh = readFileSync(RUNNER, 'utf8');

  it('works hand-backs only — new work and routing stay in the daily slots', () => {
    expect(sh).toMatch(/WORK ONLY THE HAND-BACKS/);
    expect(sh).toMatch(/IGNORE new work entirely, do NO routing and NO escalation/);
  });

  it('keeps the approval gate before the action', () => {
    expect(sh).toMatch(/the gate sits BEFORE the action/);
  });

  it('keeps step 7 verify mandatory — the run must grade itself', () => {
    expect(sh).toMatch(/Step 7 \(verify\) is MANDATORY/);
  });

  it('keeps the CEO review pass on non-tier-1 redos', () => {
    expect(sh).toMatch(/CEO review pass over non-tier-1 redos/);
  });

  it('treats a missing report.json as a blind run, not a clean tick', () => {
    expect(sh).toMatch(/produced no report\.json/);
  });

  it('beats on every path, so a stopped poller cannot look like a quiet day', () => {
    expect(sh.match(/^\s*beat /gm).length).toBeGreaterThanOrEqual(5);
  });
});
