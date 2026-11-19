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
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, utimesSync, readdirSync } from 'node:fs';
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

function runPostrun({ job = 'test-job', rc = 0, startLine = 1, leak = LEAK_ERE, bad = BAD_ERE,
                      tolerated = null } = {}) {
  const args = [SCRIPT, job, String(rc), log, String(startLine), marker, scratch, leak, bad];
  if (tolerated !== null) args.push(tolerated);
  return sh('bash', args, { env: { ...process.env, SLOT_POSTRUN_REPO: repo } });
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

// Finding 20261001-exceptions-676. The 1 Oct inbound-triage slot wrote
// "===== done rc=0 =====" into runs.log and then exited 1 on its log markers,
// so runs.log said the slot finished fine while queue-events.jsonl recorded it
// as died. Every reader that parses the done line (check-routines.py
// death_causes, estate-status.py paused_skip) trusted the log over the queue.
// Back-tested by reverting the EXIT_RC block: both assertions below fail.
describe('the done line records the code the wrapper EXITS with (finding 20261001-exceptions-676)', () => {
  it('writes done rc=1 with the first marker when rc=0 but the tail carries a failure', () => {
    writeFileSync(log, '===== test-job run =====\nOAuth access token has expired\n');
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(1);
    const text = readFileSync(log, 'utf8');
    // The log and the exit code now agree.
    expect(text).toMatch(/===== done rc=1 \(rc=0 but log tail carried failure markers: /);
    expect(text).not.toMatch(/===== done rc=0 /);
    // The cause is IN the log, not only on a stderr stream nothing keeps.
    expect(text).toContain('OAuth access token has expired');
  });

  it('leaves the done line parseable: it still starts "===== done rc=" and carries the number', () => {
    writeFileSync(log, '===== test-job run =====\nBROKEN: history book\n');
    runPostrun({ rc: 0 });
    const done = readFileSync(log, 'utf8').split('\n').filter(l => l.startsWith('===== done rc='));
    expect(done).toHaveLength(1);
    // check-routines.py reads the integer straight after "rc=".
    expect(done[0].slice('===== done rc='.length).match(/^\d+/)[0]).toBe('1');
  });

  it('a tolerated marker is not a failure, so the done line stays rc=0', () => {
    writeFileSync(log, '===== test-job run =====\nBROKEN: expected and survivable\n');
    const r = runPostrun({ rc: 0, tolerated: 'expected and survivable' });
    expect(r.status).toBe(0);
    expect(readFileSync(log, 'utf8')).toMatch(/===== done rc=0 /);
  });

  it('a real non-zero rc is reported as itself, never relabelled', () => {
    writeFileSync(log, '===== test-job run =====\nBROKEN: history book\n');
    const r = runPostrun({ rc: 7 });
    expect(r.status).toBe(7);
    expect(readFileSync(log, 'utf8')).toMatch(/===== done rc=7 /);
    expect(readFileSync(log, 'utf8')).not.toContain('rc=0 but log tail');
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

// ─── FINDING 20260915-daily-ops-exceptions-531 ───────────────────────
//
// inbound-triage's 13:00 slot on 14 Sep 2026 was recorded FAILED (exit 1)
// although it completed. The wrapper's marker list carries a bare `"error"`
// pattern, and the scan's own Gmail back-off writes a line that contains it:
//
//   {"error": "GMAIL RATE METRIC STILL FULL after 585s of waiting (Gmail
//    short-window rate metric; it refills in about a minute). The watermark is
//    NOT advanced, so no mail is lost — the next slot picks up from here. ..."}
//
// That line is the handler working. The fix is a SUBTRACTION, not a deletion:
// `"error"` still catches `API Error: {"type":"error",...}` from a headless
// claude that then exits 0, and the wrapper names the survivable line instead.
//
// Back-tested: drop the ninth argument from inbound-triage-run.sh and the
// first test here goes red with exit 1, which is exactly what job-status
// recorded on 14 Sep.
describe('a tolerated line is not a failure marker (finding 531)', () => {
  const TRIAGE_BAD =
    '"error"|HTTP Error 401|401 Unauthorized|Unauthorized|OAuth access token has expired|BROKEN|Full Disk Access';
  const TRIAGE_TOLERATED = 'GMAIL RATE METRIC STILL FULL';
  const RATE_LINE =
    '{"error": "GMAIL RATE METRIC STILL FULL after 585s of waiting (Gmail short-window rate metric;'
    + ' it refills in about a minute). The watermark is NOT advanced, so no mail is lost'
    + ' \u2014 the next slot picks up from here."}';

  it('THE 14 SEP BUG: the Gmail rate-metric retry line no longer fails the slot', () => {
    writeFileSync(log, '===== inbound-triage run =====\n' + RATE_LINE + '\nWatermark advanced\n');
    const r = runPostrun({ job: 'inbound-triage', rc: 0, bad: TRIAGE_BAD, tolerated: TRIAGE_TOLERATED });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('inbound-triage run OK');
    expect(r.stderr).not.toContain('FAILED');
  });

  it('without the tolerated list it still fails — proving the marker really did match', () => {
    writeFileSync(log, '===== inbound-triage run =====\n' + RATE_LINE + '\n');
    const r = runPostrun({ job: 'inbound-triage', rc: 0, bad: TRIAGE_BAD });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAILED');
  });

  it('a REAL error JSON is still caught, tolerated list and all', () => {
    // The whole point of not deleting the bare "error" pattern. A headless
    // claude prints this and then exits 0.
    writeFileSync(
      log,
      '===== inbound-triage run =====\n'
        + RATE_LINE + '\n'
        + 'API Error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n'
    );
    const r = runPostrun({ job: 'inbound-triage', rc: 0, bad: TRIAGE_BAD, tolerated: TRIAGE_TOLERATED });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAILED');
    expect(r.stderr).toContain('overloaded_error');
  });

  it('a non-zero rc still fails even when every marker line is tolerated', () => {
    writeFileSync(log, '===== inbound-triage run =====\n' + RATE_LINE + '\n');
    const r = runPostrun({ job: 'inbound-triage', rc: 2, bad: TRIAGE_BAD, tolerated: TRIAGE_TOLERATED });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('FAILED (rc=2)');
  });

  it('omitting the argument entirely keeps the old behaviour for the other two wrappers', () => {
    writeFileSync(log, '===== test-job run =====\nBROKEN: skill file missing\n');
    const r = runPostrun({ rc: 0 });
    expect(r.status).toBe(1);
  });

  it('inbound-triage-run.sh actually passes the tolerated pattern', () => {
    // A fix in the shared script that no wrapper opts into changes nothing.
    const wrapper = readFileSync(resolve(ROOT, 'scripts/inbound-triage-run.sh'), 'utf8');
    expect(wrapper).toContain("'GMAIL RATE METRIC STILL FULL'");
  });
});

// ---------------------------------------------------------------------------
// A slot that cannot reach its only source is not a pass.
//
// Finding 20260918-daily-ops-phase2-excepti-544: the prospecting slot on 17 Sep
// reported "Chrome sourcing: SKIPPED. The claude-in-chrome tools are not loaded
// in this session slot", found 0, synced 0, used 0 keywords — and exited 0, so
// nothing alarmed while 89 prospects sat at Ready for Review. The failure
// markers are read from agent-slot-run.sh's own source, never copied here, so
// deleting them there fails this test.
describe('slot failure markers: an unavailable lane fails the run (finding 544)', () => {
  const runnerSrc = readFileSync(resolve(ROOT, 'scripts/agent-slot-run.sh'), 'utf8');
  // The line may end with a shell continuation, because a TOLERATED pattern
  // now follows it (PR #763). Without the optional backslash this read
  // silently returns undefined and all three cases below fail on a change
  // that is correct.
  const realBad = (runnerSrc.match(/^\s*'(HTTP Error 401\|[^']*)'\s*\\?\s*$/m) || [])[1];

  it('agent-slot-run.sh still passes a failure-marker pattern to the epilogue', () => {
    expect(realBad).toBeTruthy();
  });

  it('fails an rc=0 run whose log carries LANE UNAVAILABLE', () => {
    writeFileSync(log, 'start\nLANE UNAVAILABLE: claude-in-chrome - tools not loaded\nfound 0, synced 0\n');
    const r = runPostrun({ rc: 0, bad: realBad });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/LANE UNAVAILABLE/);
  });

  it('fails an rc=0 run carrying the exact 17 Sep prospecting wording', () => {
    writeFileSync(log, 'start\nChrome sourcing: SKIPPED. The claude-in-chrome tools are not loaded in this session slot\n');
    const r = runPostrun({ rc: 0, bad: realBad });
    expect(r.status).toBe(1);
  });

  it('still passes an ordinary clean slot run', () => {
    writeFileSync(log, 'start\nfound 12, deduped 3, synced 9\n');
    const r = runPostrun({ rc: 0, bad: realBad });
    expect(r.status).toBe(0);
  });

  it('the prospecting skill tells the slot to print the marker', () => {
    const skill = readFileSync(resolve(ROOT, '.claude/scheduled-tasks/prospecting/SKILL.md'), 'utf8');
    expect(skill).toMatch(/LANE UNAVAILABLE: claude-in-chrome/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 18 Nov 2026, finding 20261011-agent-dispatch-834. macOS Full Disk Access
// belongs to the job's own /usr/bin/python3, never to the claude binary, so
// `whatsapp-sweep.py lookup` run by an agent failed "authorization denied" and
// no WhatsApp read worked from a dispatch run after 24 Aug. Now the refused
// lookup queues a request, the post-run step reads it OUTSIDE claude, and the
// same command returns that answer on the agent's next run. The post-run is
// driven against a STUB sweep script; the agent side runs the real script
// against a file that is not a database (the same sqlite3.DatabaseError).
// Invented names only.
// ─────────────────────────────────────────────────────────────────────────────
describe('finding 20261011-agent-dispatch-834: a WhatsApp lookup the agent cannot make is read by the post-run step', () => {
  const REAL_SWEEP = resolve(ROOT, 'scripts/whatsapp-sweep.py');
  const STUB = String.raw`import json, os, sys
a = sys.argv
if os.environ.get("STUB_FAIL"): sys.exit(1)
print(json.dumps({"who": a[a.index("--who") + 1], "args": a[2:], "serving": os.environ.get("WHATSAPP_LOOKUP_SERVING"),
                  "claudecode": "CLAUDECODE" in os.environ,
                  "chats": [{"chat": "Pat Example", "messages": [{"from": "Pat Example", "text": "Boiler fixed"}]}]}))
`;
  let wa, notADb;
  const waEnv = (extra = {}) => {
    const env = { ...process.env, SLOT_POSTRUN_REPO: repo, WHATSAPP_LOOKUP_DIR: wa, WHATSAPP_DB_PATH: notADb, ...extra };
    if (!('WHATSAPP_LOOKUP_SERVING' in extra)) delete env.WHATSAPP_LOOKUP_SERVING;
    return env;
  };
  const TASK = 'recTEST0000000001';
  const agentLookup = (who, extra = {}) => sh('python3', [REAL_SWEEP, 'lookup', '--who', who, '--task', TASK], { env: waEnv(extra) });
  const postrun = (extra = {}) => sh('bash', [SCRIPT, 'test-job', '0', log, '1', marker, scratch, LEAK_ERE, BAD_ERE],
    { env: waEnv(extra) });
  const withStub = () => { mkdirSync(join(repo, 'scripts'), { recursive: true }); writeFileSync(join(repo, 'scripts/whatsapp-sweep.py'), STUB); };
  const request = (slug, who) => { mkdirSync(join(wa, 'requests'), { recursive: true }); writeFileSync(join(wa, 'requests', `${slug}.json`), JSON.stringify({ who, days: 60 })); };

  beforeEach(() => {
    wa = join(repo, 'wa');
    notADb = join(repo, 'ChatStorage.sqlite');
    writeFileSync(notADb, 'not a sqlite database: the read is refused the way macOS refuses claude');
  });

  it('round trip: queued in the run, read after it, answered on the next run', () => {
    const first = agentLookup('Pat Example');
    expect(first.status).toBe(3);
    const q = JSON.parse(first.stdout);
    expect(q.error).toMatch(/QUEUED, not failed/);
    expect(readdirSync(join(wa, 'requests')).length).toBe(1);
    const [qname] = readdirSync(join(wa, 'requests'));

    withStub();
    const r = postrun();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('test-job run OK');
    expect(r.stderr).toContain('whatsapp lookups: 1 of 1 queued request(s) read outside claude');
    expect(existsSync(join(wa, 'requests', qname))).toBe(false);
    const res = JSON.parse(readFileSync(join(wa, 'results', qname), 'utf8'));
    expect(res.who).toBe('Pat Example');
    expect(res.args).toEqual(['--who', 'Pat Example', '--days', '60', '--limit', '40']);
    expect(res.serving).toBe('1');          // the refusal of the post-run's own read is final, never re-queued
    expect(res.claudecode).toBe(false);

    expect(res.task).toBe(TASK);
    const next = agentLookup('Pat Example');  // the same command, still refused inside claude
    expect(next.status).toBe(0);
    const ans = JSON.parse(next.stdout);
    expect(ans.chats[0].messages[0].text).toBe('Boiler fixed');
    expect(ans.readOutsideClaude).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(sh('python3', [REAL_SWEEP, 'lookup', '--who', 'Pat Example', '--task', 'recTEST0000000009'], { env: waEnv() }).status).toBe(3);
  });

  it('a lookup that fails outside claude is a loud answer, and never fails the slot', () => {
    withStub();
    agentLookup('Pat Example');   // queues it for TASK
    const r = postrun({ STUB_FAIL: '1' });
    expect(r.status).toBe(0);
    const [rname] = readdirSync(join(wa, 'results'));
    const res = JSON.parse(readFileSync(join(wa, 'results', rname), 'utf8'));
    expect(res.error).toMatch(/printed no JSON \(rc=1\)/);
    const next = agentLookup('Pat Example');   // the next run sees the failure and asks again, not "nobody said anything"
    expect(next.status).toBe(3);
    expect(next.stdout).toMatch(/attempt 2 of 3.*printed no JSON/);
  });

  it('reads at most five a run, and leaves the rest for the next slot', () => {
    withStub();
    for (let i = 1; i <= 7; i++) request(`contact-${i}`, `Contact Number ${i}`);
    postrun();
    expect(readdirSync(join(wa, 'results')).length).toBe(5);
    expect(readdirSync(join(wa, 'requests')).length).toBe(2);
  });

  it('the post-run read itself is never re-queued: with SERVING set a refusal is an error', () => {
    const r = agentLookup('Pat Example', { WHATSAPP_LOOKUP_SERVING: '1' });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stderr).error).toMatch(/not a database/);
    expect(existsSync(join(wa, 'requests'))).toBe(false);
  });

  it('a repo with no sweep script leaves the queue alone (so no test can drain a real queue)', () => {
    request('pat-example', 'Pat Example');
    const r = postrun();
    expect(r.status).toBe(0);
    expect(existsSync(join(wa, 'requests/pat-example.json'))).toBe(true);
    expect(existsSync(join(wa, 'results'))).toBe(false);
  });
});

// Review of PR 983 (18 Nov 2026). An error answer was served for 72 h and never asked again; a good answer was
// reused whatever days/limit the new call asked for and even after a newer request; the file name dropped every
// non a-z0-9 letter ("Zoë" and "Zo" shared a file, a non-Latin name became "unnamed"); any task could be served
// another task's answer; and one request whose file could not be moved jammed the rest of the queue.
describe('finding 20261011-agent-dispatch-834 review: the queued answer is the right one, for the right task', () => {
  const REAL_SWEEP = resolve(ROOT, 'scripts/whatsapp-sweep.py');
  const TASK = 'recTEST0000000001';
  const OTHER = 'recTEST0000000002';
  let wa, notADb;
  const env = (extra = {}) => {
    const e = { ...process.env, SLOT_POSTRUN_REPO: repo, WHATSAPP_LOOKUP_DIR: wa, WHATSAPP_DB_PATH: notADb, ...extra };
    delete e.WHATSAPP_LOOKUP_SERVING;
    return e;
  };
  const lookup = (...args) => {
    const r = sh('python3', [REAL_SWEEP, 'lookup', ...args], { env: env() });
    let out = {}; try { out = JSON.parse(r.stdout); } catch { /* the rc says what happened */ }
    return { rc: r.status, ...out };
  };
  const files = (kind) => (existsSync(join(wa, kind)) ? readdirSync(join(wa, kind)).filter((n) => n.endsWith('.json')) : []);
  const readReq = () => JSON.parse(readFileSync(join(wa, 'requests', files('requests')[0]), 'utf8'));
  // Play the post-run step's part by hand: answer every waiting request with `answer`, as slot-postrun.sh does.
  const answerAll = (answer) => {
    mkdirSync(join(wa, 'results'), { recursive: true });
    for (const n of files('requests')) {
      const req = JSON.parse(readFileSync(join(wa, 'requests', n), 'utf8'));
      writeFileSync(join(wa, 'results', n), JSON.stringify({ ...answer, task: req.task, who: req.who, days: req.days,
        limit: req.limit, asked: req.asked, answered: new Date(Date.now() + 1000).toISOString(), attempts: req.attempts || 1 }));
      rmSync(join(wa, 'requests', n));
    }
  };
  const GOOD = { chats: [{ chat: 'Pat Example', messages: [{ from: 'Pat Example', text: 'Boiler fixed' }] }] };

  beforeEach(() => {
    wa = join(repo, 'wa');
    notADb = join(repo, 'ChatStorage.sqlite');
    writeFileSync(notADb, 'not a sqlite database');
  });

  it('an error answer is asked again, up to three attempts, then given as the final word', () => {
    expect(lookup('--who', 'Pat Example', '--task', TASK).rc).toBe(3);
    answerAll({ error: 'authorization denied' });
    const second = lookup('--who', 'Pat Example', '--task', TASK);
    expect(second.rc).toBe(3);
    expect(readReq().attempts).toBe(2);
    answerAll({ error: 'authorization denied' });
    expect(lookup('--who', 'Pat Example', '--task', TASK).rc).toBe(3);
    expect(readReq().attempts).toBe(3);
    answerAll({ error: 'authorization denied' });
    const last = lookup('--who', 'Pat Example', '--task', TASK);
    expect(last.rc).toBe(1);
    expect(last.error).toBe('authorization denied');
    expect(files('requests')).toEqual([]);
  });

  it('an answer is given only for the same who, days and limit, and never when a newer request waits', () => {
    lookup('--who', 'Pat Example', '--task', TASK, '--days', '60');
    answerAll(GOOD);
    expect(lookup('--who', 'Pat Example', '--task', TASK, '--days', '60').rc).toBe(0);
    expect(lookup('--who', 'Pat Example', '--task', TASK, '--days', '30').rc).toBe(3);   // a different ask: queued
    expect(lookup('--who', 'Pat Example', '--task', TASK, '--days', '30', '--limit', '5').rc).toBe(3);
    expect(files('requests').length).toBe(2);
    // an answer older than a request for the same key is not the answer to it
    const [n] = files('results');
    const req = { task: TASK, who: 'Pat Example', days: 60, limit: 40, asked: new Date(Date.now() + 60_000).toISOString(), attempts: 1 };
    writeFileSync(join(wa, 'requests', n), JSON.stringify(req));
    expect(lookup('--who', 'Pat Example', '--task', TASK, '--days', '60').rc).toBe(3);
  });

  it('the file name is a hash of the exact name: "Zoë" and "Zo" never share one, and a non-Latin name is not "unnamed"', () => {
    for (const who of ['Zoë Example', 'Zo Example', '李小龍', '王小芳']) lookup('--who', who, '--task', TASK);
    const names = files('requests');
    expect(names.length).toBe(4);
    expect(names.some((n) => n.includes('unnamed'))).toBe(false);
  });

  it('an answer is given only to the task that asked; a lookup with no task id is not queued', () => {
    lookup('--who', 'Pat Example', '--task', TASK);
    answerAll(GOOD);
    expect(lookup('--who', 'Pat Example', '--task', TASK).rc).toBe(0);
    expect(lookup('--who', 'Pat Example', '--task', OTHER).rc).toBe(3);
    rmSync(join(wa, 'requests'), { recursive: true, force: true });
    const bare = lookup('--who', 'Pat Example');
    expect(bare.rc).toBe(3);
    expect(bare.error).toMatch(/--task/);
    expect(files('requests')).toEqual([]);
  });

  it('one request whose answer cannot be filed never jams the rest of the queue', () => {
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'scripts/whatsapp-sweep.py'), 'import json; print(json.dumps({"chats": []}))\n');
    mkdirSync(join(wa, 'requests'), { recursive: true });
    for (const n of ['a-first', 'b-second']) {
      writeFileSync(join(wa, 'requests', `${n}.json`), JSON.stringify({ task: TASK, who: `Contact ${n}`, days: 60, limit: 40 }));
    }
    mkdirSync(join(wa, 'results', 'a-first.json'), { recursive: true });   // a directory where the answer must go
    const r = sh('bash', [SCRIPT, 'test-job', '0', log, '1', marker, scratch, LEAK_ERE, BAD_ERE], { env: env() });
    expect(r.status).toBe(0);
    expect(existsSync(join(wa, 'results', 'b-second.json'))).toBe(true);
    expect(existsSync(join(wa, 'requests', 'b-second.json'))).toBe(false);
    expect(r.stderr).toMatch(/1 of 2/);
  });
});

// Re-review of PR 983 (18 Nov 2026): a good answer was served for 72 h to the same task asking the same question, and
// while it existed no new request was written, so a stale answer kept coming back. And a request file that is not
// valid JSON was never answered or removed, so it took one of the five places on every run.
describe('finding 20261011-agent-dispatch-834 re-review: an answer is given once, and a broken request is answered', () => {
  const REAL_SWEEP = resolve(ROOT, 'scripts/whatsapp-sweep.py');
  const TASK = 'recTEST0000000001';
  let wa, notADb;
  const env = () => {
    const e = { ...process.env, SLOT_POSTRUN_REPO: repo, WHATSAPP_LOOKUP_DIR: wa, WHATSAPP_DB_PATH: notADb };
    delete e.WHATSAPP_LOOKUP_SERVING;
    return e;
  };
  const ask = () => sh('python3', [REAL_SWEEP, 'lookup', '--who', 'Pat Example', '--task', TASK], { env: env() });
  const postrun = () => sh('bash', [SCRIPT, 'test-job', '0', log, '1', marker, scratch, LEAK_ERE, BAD_ERE], { env: env() });

  beforeEach(() => {
    wa = join(repo, 'wa');
    notADb = join(repo, 'ChatStorage.sqlite');
    writeFileSync(notADb, 'not a sqlite database');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    writeFileSync(join(repo, 'scripts/whatsapp-sweep.py'), 'import json; print(json.dumps({"chats": [{"chat": "Pat Example", "messages": []}]}))\n');
  });

  it('a good answer is given once (and re-read for 30 minutes); after that the same question is asked again', () => {
    expect(ask().status).toBe(3);
    postrun();
    expect(ask().status).toBe(0);                 // the first read after it was answered
    expect(ask().status).toBe(0);                 // the same run reading it again
    const [n] = readdirSync(join(wa, 'results'));
    const p = join(wa, 'results', n);
    const res = JSON.parse(readFileSync(p, 'utf8'));
    res.served = new Date(Date.now() - 31 * 60_000).toISOString();   // first given 31 minutes ago
    writeFileSync(p, JSON.stringify(res));
    const later = ask();
    expect(later.status).toBe(3);
    expect(readdirSync(join(wa, 'requests')).length).toBe(1);
  });

  it('a request that is not valid JSON is answered with an error and removed, so it never holds a place', () => {
    mkdirSync(join(wa, 'requests'), { recursive: true });
    writeFileSync(join(wa, 'requests', 'broken.json'), '{not json');
    const r = postrun();
    expect(r.status).toBe(0);
    expect(existsSync(join(wa, 'requests', 'broken.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(wa, 'results', 'broken.json'), 'utf8')).error).toMatch(/could not be read/);
  });
});
