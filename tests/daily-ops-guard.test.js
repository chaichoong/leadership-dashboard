// Guards the --guard mode of scripts/morning-digest.py.
//
// WHY (15 Aug 2026)
// The scheduler stamped daily-ops lastRunAt at 06:20 and delivered the run to
// no session: no transcript anywhere received the prompt, no phase-1 mark, no
// reports, no findings. The full 11:00 digest caught it, but Kevin noticed
// first and asked "why has this not run today?" — the machine must never again
// be beaten to that question by the person it reports to.
//
// The guard's one principle: the scheduler's lastRunAt is an assertion by the
// component being checked, so it is never consulted. The phase-1 queue mark is
// written by the run itself doing work; its absence is ground truth.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts/morning-digest.py');

// Run guard() with a fixture events file and a frozen London clock; capture
// what it prints, returns, and would post to Slack.
function runGuard(events, nowLondonIso, reports = []) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const queueDir = join(dir, 'queue');
  const monitoring = join(dir, 'monitoring');
  mkdirSync(queueDir, { recursive: true });
  // An EMPTY monitoring dir is the 17 Aug 2026 state. It must exist, so the
  // artefact check is reading a real directory and not silently passing on a
  // missing path — a fixture that cannot fail proves nothing.
  mkdirSync(monitoring, { recursive: true });
  for (const name of reports) writeFileSync(join(monitoring, name), 'report\n');
  writeFileSync(join(queueDir, 'queue-events.jsonl'),
    events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  const py = `
import importlib.util, json, os, sys
from datetime import datetime
from zoneinfo import ZoneInfo
os.environ["JOB_LOG_DIR"] = ${JSON.stringify(dir)}
os.environ["JOB_QUEUE_DIR"] = ${JSON.stringify(queueDir)}
os.environ["MONITORING_DIR"] = ${JSON.stringify(monitoring)}
spec = importlib.util.spec_from_file_location("md", ${JSON.stringify(SCRIPT)})
md = importlib.util.module_from_spec(spec); spec.loader.exec_module(md)
sent = []
notified = []
# post_to_slack is a retired no-op in production (1 Sep 2026) but the alarm
# text still flows through it, so capturing it checks the message content.
# mac_notify is the REAL surviving surface — an alarm that skips it reaches
# nobody, which is exactly what these tests exist to prevent.
md.post_to_slack = lambda m: sent.append(m)
md.mac_notify = lambda t: notified.append(t)
now = datetime.fromisoformat(sys.argv[1]).replace(tzinfo=ZoneInfo("Europe/London"))
code = md.guard(now_dt=now)
print(json.dumps({"code": code, "sent": sent, "notified": notified}))
`;
  const out = execFileSync('python3', ['-c', py, nowLondonIso], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const markAt = (iso) => ({ job: 'daily-ops', state: 'mark', ts: iso });
const endAt = (iso) => ({ job: 'daily-ops', state: 'mark', ts: iso, note: 'end' });

describe('daily-ops guard', () => {
  it('stays silent when the run marked today', () => {
    const { code, sent, notified } = runGuard(
      [markAt('2026-08-15T05:20:00Z')], '2026-08-15T09:30:00');
    expect(code).toBe(0);
    expect(sent).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });

  it('alarms when there is no mark today after 08:00 London', () => {
    const { code, sent, notified } = runGuard([], '2026-08-15T09:30:00');
    expect(code).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('daily-ops has not started today');
    expect(sent[0]).toContain('run daily ops');
    // The macOS notification is the only surface left that reaches a human
    // (Slack alerts retired 1 Sep 2026) — an alarm that skips it is silent.
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain('run daily ops');
  });

  it("yesterday's mark does not cover today — the 15 Aug case exactly", () => {
    // On 15 Aug the newest mark was 14 Aug's. lastRunAt said today; the mark
    // said otherwise. The mark must win.
    const { code, sent, notified } = runGuard(
      [markAt('2026-08-14T05:20:15Z')], '2026-08-15T09:30:00');
    expect(code).toBe(1);
    expect(sent).toHaveLength(1);
    expect(notified).toHaveLength(1);
  });

  it('holds its tongue before 08:00 London instead of crying at a slow wake', () => {
    const { code, sent, notified } = runGuard([], '2026-08-15T07:15:00');
    expect(code).toBe(0);
    expect(sent).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });

  it('counts the London day, not the UTC day, at the midnight boundary', () => {
    // A mark at 23:30Z during BST is 00:30 London the NEXT day. If the guard
    // compared UTC days it would call this yesterday's mark and false-alarm.
    const { code } = runGuard([markAt('2026-08-14T23:30:00Z')], '2026-08-15T09:00:00');
    expect(code).toBe(0);
  });

  it('ignores events from other jobs and non-start events', () => {
    const { code } = runGuard([
      { job: 'uc-check-slack-notifier', state: 'mark', ts: '2026-08-15T06:04:00Z' },
      { job: 'daily-ops', state: 'released', ts: '2026-08-15T06:04:00Z' },
    ], '2026-08-15T09:30:00');
    expect(code).toBe(1);
  });

  it('keeps the full digest isolated from the production events log', () => {
    // Until 15 Aug 2026 the digest's embedded routine-stacking check read the
    // REAL queue log even under fixture env, so digest tests passed or failed
    // with the health of the live machine — they went red the morning the real
    // daily-ops silently failed, on assertions about unrelated fixture jobs.
    // The check now follows the digest's own events path and only runs when
    // daily-ops is part of the schedule under test.
    const runDigest = (scheduleObj, events) => {
      const dir = mkdtempSync(join(tmpdir(), 'digest-'));
      const queueDir = join(dir, 'queue');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'queue-events.jsonl'),
        events.map(e => JSON.stringify(e)).join('\n') + '\n');
      const schedPath = join(dir, 'schedule.json');
      writeFileSync(schedPath, JSON.stringify(scheduleObj));
      try {
        return execFileSync('python3', [SCRIPT, '--no-post'], {
          encoding: 'utf8',
          env: { ...process.env, JOB_LOG_DIR: dir, JOB_QUEUE_DIR: queueDir,
                 JOB_QUEUE_SCHEDULE: schedPath, DIGEST_GRACE_MINUTES: '0',
                 FINDINGS_FILE: join(dir, 'findings-queue.jsonl') },
        });
      } catch (err) { return (err.stdout || '') + (err.stderr || ''); }
    };
    // CONTROL. Two of the three assertions below check for the ABSENCE of the
    // stacking line, and a digest that crashed prints no such line either — so
    // they would pass on a traceback. They did, briefly: the first version of
    // these fixtures used the key "event" where job-queue.py writes "state"
    // (scripts/job-queue.py:153), the digest died on KeyError, and the test
    // stayed green. Every run must be proved to have produced a real digest.
    const assertRealDigest = (out, label) => {
      expect(out, `${label}: digest crashed instead of reporting`).not.toMatch(/Traceback|KeyError/);
      expect(out, `${label}: digest produced no job summary`).toMatch(/Scheduled jobs:|recorded nothing/);
      return out;
    };
    const nowIso = new Date().toISOString();

    // daily-ops in the schedule, no mark in the FIXTURE events → alarms from
    // fixture state alone, regardless of what the production log says.
    const out1 = runDigest(
      { 'daily-ops': { cron: '0 7 * * *', maxLateMinutes: 900, mode: 'cooperative' } },
      [{ job: 'other-job', state: 'acquired', ts: nowIso }]);
    assertRealDigest(out1, 'out1');
    expect(out1).toMatch(/Routine stacking/);

    // Same schedule, fixture mark present → the stacking alarm stays quiet.
    const out2 = runDigest(
      { 'daily-ops': { cron: '0 7 * * *', maxLateMinutes: 900, mode: 'cooperative' } },
      [{ job: 'daily-ops', state: 'mark', ts: nowIso }]);
    assertRealDigest(out2, 'out2');
    expect(out2).not.toMatch(/Routine stacking/);

    // A fixture world with no daily-ops at all is not asked about it.
    const out3 = runDigest(
      { 'always-due': { cron: '* * * * *', maxLateMinutes: 60, mode: 'wrapped' } },
      [{ job: 'always-due', state: 'acquired', ts: nowIso },
       { job: 'always-due', state: 'released', ts: nowIso }]);
    assertRealDigest(out3, 'out3');
    expect(out3).not.toMatch(/Routine stacking/);
  });

  // ── DID IT FINISH? (17 Aug 2026, finding 20260818-ceo-memory-sweep-215) ──
  //
  // daily-ops marked at 06:07 and died at 07:59 when a huddle subagent stalled.
  // Phases 3-9 never ran. The 08:30 guard said "healthy" because a start mark
  // was all it looked for, and Kevin was told nothing for a whole day.
  describe('completion check', () => {
    const REPORTS = ['e2e-sweep-2026-08-17.md', 'task-sweep-2026-08-17.md'];

    it('replays 17 Aug: started, died, no reports — alarms', () => {
      const { code, sent } = runGuard(
        [markAt('2026-08-17T05:07:00Z')], '2026-08-17T11:30:00', []);
      expect(code, 'a dead mid-run morning still read as healthy').toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(/started but did not finish/i);
      expect(sent[0], 'the alarm does not name what is missing')
        .toMatch(/e2e-sweep-2026-08-17\.md/);
    });

    it('is silent when phase 9 stamped its end mark', () => {
      const { code, sent } = runGuard(
        [markAt('2026-08-17T05:07:00Z'), endAt('2026-08-17T07:40:00Z')],
        '2026-08-17T11:30:00', []);
      expect(code).toBe(0);
      expect(sent).toHaveLength(0);
    });

    it('accepts a run with no end mark when every report is on disk', () => {
      // Runs that predate the end mark must not alarm every morning. Evidence
      // of the work beats the absence of a stamp.
      const { code, sent } = runGuard(
        [markAt('2026-08-17T05:07:00Z')], '2026-08-17T11:30:00', REPORTS);
      expect(code).toBe(0);
      expect(sent).toHaveLength(0);
    });

    it('alarms when only SOME of the day\'s reports exist', () => {
      // 17 Aug died after phase 2. A partial set is a partial run, and the
      // message must say which half is missing rather than average it away.
      const { code, sent } = runGuard(
        [markAt('2026-08-17T05:07:00Z')], '2026-08-17T11:30:00',
        ['e2e-sweep-2026-08-17.md']);
      expect(code).toBe(1);
      expect(sent[0]).toMatch(/task-sweep-2026-08-17\.md/);
    });

    it('does not cry wolf while the run is still going', () => {
      // 06:05 start, an hour or two expected. At 09:30 an unfinished run is
      // normal; alarming there is how a guard gets ignored.
      const { code, sent } = runGuard(
        [markAt('2026-08-17T05:07:00Z')], '2026-08-17T09:30:00', []);
      expect(code).toBe(0);
      expect(sent).toHaveLength(0);
    });

    it('ignores yesterday\'s reports', () => {
      // The artefact check is dated on purpose: a stale file from an earlier
      // morning is exactly the "looks like it ran" evidence that fooled 17 Aug.
      const { code } = runGuard(
        [markAt('2026-08-17T05:07:00Z')], '2026-08-17T11:30:00',
        ['e2e-sweep-2026-08-16.md', 'task-sweep-2026-08-16.md']);
      expect(code).toBe(1);
    });

    it('an end mark from yesterday does not pass today', () => {
      const { code } = runGuard(
        [endAt('2026-08-16T07:40:00Z'), markAt('2026-08-17T05:07:00Z')],
        '2026-08-17T11:30:00', []);
      expect(code).toBe(1);
    });

    it('still alarms louder when nothing started at all', () => {
      // The start check outranks the completion check: no mark is a worse
      // failure and keeps its own message.
      const { code, sent } = runGuard([], '2026-08-17T11:30:00', REPORTS);
      expect(code).toBe(1);
      expect(sent[0]).toMatch(/has not started today/i);
    });
  });

  it('never reads the scheduler lastRunAt', () => {
    // The whole point. If guard() starts consulting the scheduler's own state,
    // it is asking the suspect for an alibi.
    const src = require('fs').readFileSync(SCRIPT, 'utf8');
    const guardBody = src.slice(src.indexOf('def guard('), src.indexOf('def post_to_slack('));
    // Prose may explain WHY lastRunAt is ignored; code may not touch it. Strip
    // the docstring and comments, then assert the executable lines are clean.
    const codeOnly = guardBody
      .replace(/"""[\s\S]*?"""/g, '')
      .split('\n').map(l => l.replace(/#.*$/, '')).join('\n');
    expect(codeOnly).not.toMatch(/lastRunAt|scheduled-tasks\.json/);
  });
});
