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
    expect(job.cron).toBe('0 22 * * *');
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

  // Kevin, 2 Oct 2026: three a night. A day begun late is killed at the job's stop and the copy, cards and publishing
  // steps after the loop never run. Drives the script's own function, extracted verbatim.
  it('starts no day from 04:00, so the night always reaches its cards and publishing steps', () => {
    const run = readFileSync(RUN, 'utf8');
    const block = run.match(/# --- last-start-block[\s\S]*?# --- end last-start-block ---/)[0];
    const may = (hour, env = {}) => {
      try { execFileSync('bash', ['-c', `${block}\nce_may_start_day ${hour}`], { env: { PATH: process.env.PATH, ...env } }); return true; }
      catch (e) { return false; }
    };
    expect([22, 23, 0, 1, 3].map(h => may(h))).toEqual([true, true, true, true, true]);
    expect([4, 5, 6, 7, 12, 21].map(h => may(h))).toEqual([false, false, false, false, false, false]);
    expect(may(5, { CE_ALLOW_DAYTIME: '1' })).toBe(true);          // a deliberate daytime run is not cut short
    expect(may(3, { CE_LAST_START_HOUR: '3' })).toBe(false);
    expect(run).toMatch(/if ! ce_may_start_day "\$\(date \+%-H\)" "\$\(date \+%-M\)" "\$\(ce_guest_wait_minutes\)"; then[\s\S]{0,400}continue/);
    expect(run).toMatch(/export JOB_QUEUE_DRAIN_FILE="\$CE_GUEST_WAIT_FILE"/);
    expect(run, 'the record must start empty each night').toMatch(/: > "\$CE_GUEST_WAIT_FILE"/);
    expect(run).toContain('approval.py run --pending --limit "$COPY_LIMIT"');   // a card for every episode the night planned
  });

  // Review of PR #788 (15 Oct 2026): a render's background phase can end waiting for a light job still inside the
  // guest lane. Minutes the night spends that way come off the 04:00 last start, so the last day keeps its room
  // before the 07:00 stop. A night with no such wait keeps exactly 04:00.
  it('counts the minutes spent waiting for guests against the 04:00 last start', () => {
    const { mkdtempSync, writeFileSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const run = readFileSync(RUN, 'utf8');
    const block = run.match(/# --- last-start-block[\s\S]*?# --- end last-start-block ---/)[0];
    const sh = (cmd, env = {}) => execFileSync('bash', ['-c', `${block}\n${cmd}`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).trim();
    const may = (h, m, waited) => { try { sh(`ce_may_start_day ${h} ${m} ${waited}`); return true; } catch (e) { return false; } };
    expect([may(3, 59, 0), may(4, 0, 0)], 'no wait: exactly 04:00').toEqual([true, false]);
    expect([may(3, 19, 40), may(3, 20, 40), may(23, 50, 40)]).toEqual([true, false, true]);
    const f = path.join(mkdtempSync(path.join(tmpdir(), 'ce-wait-')), 'guest-wait.txt');
    writeFileSync(f, '1500.0\n900.4\n');
    expect(sh('ce_guest_wait_minutes', { CE_GUEST_WAIT_FILE: f })).toBe('40');
    expect(sh('ce_guest_wait_minutes', { CE_GUEST_WAIT_FILE: f + '.none' }), 'no record reads as no wait').toBe('0');
  });

  it('streams the raw clip with retries while Drive hydrates it, and a failed pull never kills the run (4 Sep 2026)', () => {
    const w = readFileSync(path.join(ROOT, 'scripts', 'content-engine', 'watch.py'), 'utf8');
    expect(w).toContain('DRIVE_RETRY_ERRNOS = (11, 35)');
    expect(w).toContain('copy_streaming(e["path"], dest + ".part", max_minutes=window)');
    expect(w).not.toContain('shutil.copyfile(e["path"]');
    const sh = readFileSync(path.join(ROOT, 'scripts', 'content-engine-run.sh'), 'utf8');
    expect(sh).toMatch(/watch\.py next --day "\$day" \|\| break/);
    expect(sh).toContain('REPO="$(cd "$(dirname "$0")/.." && pwd)"');
  });

  it("resets a clip left 'pulling' by a dead run, so it is not skipped for ever", () => {
    const w = readFileSync(path.join(ROOT, 'scripts', 'content-engine', 'watch.py'), 'utf8');
    expect(w).toContain('def repair_stale_pulls(');
    expect(w).toContain('stale = repair_stale_pulls(ledger, why=why)');
  });

  it('retries an Airtable call through a DNS blip, never through a real Airtable error (5 Sep 2026)', () => {
    const w = readFileSync(path.join(ROOT, 'scripts', 'content-engine', 'watch.py'), 'utf8');
    expect(w).toContain('AIRTABLE_RETRIES, AIRTABLE_RETRY_SECONDS = 6, 30');
    expect(w).toContain('except urllib.error.HTTPError:\n            raise');
  });

  it("night order: slot 1 continues the run, the other slots take the oldest missing days that fit the disk; gap days publish outside the cursor (Kevin, 8 Sep 2026)", () => {
    const w = readFileSync(path.join(ROOT, 'scripts', 'content-engine', 'watch.py'), 'utf8');
    expect(w).toContain('GAP_DAYS_FILE = os.path.expanduser("~/.config/od/content_engine_gap_days")');
    // `record` added 20 Oct 2026 (finding 20261020-phase-3-1004): the night's plan writes down the
    // redo order it used, so the morning report reads that instead of recomputing it after the
    // night's redo has drained. It defaults off, so every other caller is unchanged.
    expect(w).toContain('def plan(ledger, slots, gaps=None, free=None, start=None, record=False)');
    expect(w).toContain('if since and date < since and streak_day(date) not in gaps: continue');
    expect(w).toContain('def day_fits(ledger, day, free)');
    expect(w).toContain('def pull_window_minutes(size)'); // 40 min per 4 GB: an 18 GB gap clip is not abandoned at 40 min every night
    expect(w).toContain('max_minutes=window)');
    expect(w).toContain('def disk_line(ledger, free=None)'); // the morning line says SHORT before a night pulls nothing
    const sh = readFileSync(path.join(ROOT, 'scripts', 'content-engine-run.sh'), 'utf8');
    expect(sh).toMatch(/for day in \$DAYS; do/);
    const p = readFileSync(path.join(ROOT, 'scripts', 'content-engine', 'publish.py'), 'utf8');
    expect(p).toContain('moves_cursor(day, gaps): state[CURSOR_KEY] = max(cursor(state), day)');   // a gap day never moves it; a late day never pulls it back
  });

  it("starts at Kevin's takeover day and renders the configured number of episodes a night (8 Sep 2026)", () => {
    const w = readFileSync(path.join(ROOT, 'scripts', 'content-engine', 'watch.py'), 'utf8');
    expect(w).toContain('START_DAY_FILE = os.path.expanduser("~/.config/od/content_engine_start_day")');
    expect(w).toContain('since = since or since_for_start_day()');
    const sh = readFileSync(path.join(ROOT, 'scripts', 'content-engine-run.sh'), 'utf8');
    expect(sh).toContain('content_engine_episodes_per_night');
    expect(sh).toMatch(/watch\.py plan --slots "\$EPISODES"/);
    expect(w).toContain('ap.add_argument("--since", default=None'); // the CLI default used to pin the scan to 4 June 2026, hiding day 2054 from the takeover
    const p = readFileSync(path.join(ROOT, 'scripts', 'content-engine', 'publish.py'), 'utf8');
    expect(p).toContain('def staggered(slot, index');
    // No closing bracket: PR #369 (10 Sep 2026) added youtube_at= after index,
    // and the exact-call match turned main red. What matters is that the index
    // still reaches when_for, so each clip gets its own staggered slot.
    expect(p).toContain('when_for(platform, spec["clip"], index');
  });

  it('is described on the Automations list (deterministic job, not a register agent)', () => {
    const auto = readFileSync(path.join(ROOT, 'js', 'automations-data.js'), 'utf8');
    expect(auto).toMatch(/key: 'content-engine'/);
    // Since R10 (3 Sep 2026) the job DOES schedule, but only episodes Kevin approved on the card.
    expect(auto).toContain('Nothing is scheduled without his approval on the card');
  });

  it('raw clips come down and finished videos go up through the Drive API, with the mounted folder as the fallback (Kevin, 9 Sep 2026)', () => {
    const d = readFileSync(path.join(ROOT, 'scripts', 'content-engine', 'drive_api.py'), 'utf8');
    expect(d).toContain('KEY_FILE = os.path.expanduser("~/.config/od/gdrive_service_account.json")');
    expect(d).toContain('def download(file_id, dest, size=None');
    expect(d).toContain('uploadType=resumable&supportsAllDrives=true');
    expect(d).not.toMatch(/private_key["']?\s*[:=]\s*["']-----/); // never a key in the repo
    const w = readFileSync(path.join(ROOT, 'scripts', 'content-engine', 'watch.py'), 'utf8');
    expect(w).toContain('if e.get("drive_id") and pull_via_api(e, dest + ".part"):');
    expect(w).toContain('copy_streaming(e["path"], dest + ".part", max_minutes=window)'); // the fallback stays
    const r = readFileSync(path.join(ROOT, 'scripts', 'content-engine', 'render.py'), 'utf8');
    expect(r).toContain('links = publish_via_api(paths, day, transcript_txt, role)');
    expect(r).toContain('drive_api.folder_id(drive_api.EDITED_PATH + [hundreds_folder(day), str(day)], create=True)');
  });
});

// Kevin's approved build (task rec1KkjrSv0U9KUXZ; review of 2 Oct 2026, finding 20261003-agent-dispatch-734): two
// edge cases in the night loop. These run the REAL loop lines of content-engine-run.sh, the REAL `watch.py next`
// decision (next_exit) and the REAL render.run queue, with only the Drive copy and the ffmpeg render stood in.
describe('content-engine night loop: the two edge cases', () => {
  const { mkdtempSync, writeFileSync, chmodSync, mkdirSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const CE = path.join(ROOT, 'scripts', 'content-engine');
  const REAL_PY = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();   // the interpreter itself, not a shim that reads HOME

  const QUEUE = path.join(ROOT, 'scripts', 'job-queue.py');

  // underQueue: run the loop the way launchd does, inside `job-queue.py run`, so the render line's
  // `job-queue.py background` really declares its phase (15 Oct 2026). Otherwise it runs bare, as a
  // hand-started script would, and background simply runs the render.
  function night(ledger, days, { scanFirst = false, underQueue = false } = {}) {
    const home = mkdtempSync(path.join(tmpdir(), 'ce-night-'));
    const work = path.join(home, 'work'); mkdirSync(work);
    const ledgerDir = path.join(home, 'knowledge-os', 'logs', 'content-engine'); mkdirSync(ledgerDir, { recursive: true });
    for (const v of Object.values(ledger)) {
      if (v.local === 'ON_DISK') { v.local = path.join(work, v.key); writeFileSync(v.local, 'x'.repeat(v.size)); }
      delete v.key;
    }
    writeFileSync(path.join(ledgerDir, 'ledger.json'), JSON.stringify(ledger));
    const driver = path.join(home, 'driver.py');
    writeFileSync(driver, `
import os, sys
sys.path.insert(0, ${JSON.stringify(CE)})
import watch as w
w.LEDGER = os.environ["CE_LEDGER"]   # a scratch ledger; HOME stays real so the interpreter finds its own packages
mode, args = sys.argv[1], sys.argv[2:]
if mode == "watch" and args[0] == "next":
    def fake_pull(ledger, key, work):
        p = os.path.join(work, key); open(p, "wb").write(b"x" * int(ledger[key]["size"]))
        ledger[key].update(status="pulled", local=p); w.save_ledger(ledger); print("pull: %s" % key); return p
    sys.exit(w.next_exit(w.load_ledger(), int(args[args.index("--day") + 1]), os.environ["CE_WORK"], pull_fn=fake_pull))
if mode == "watch" and args[0] == "repair":
    led = w.load_ledger(); why = {}
    for k in w.repair_stale_pulls(led, os.environ["CE_WORK"], why=why): print("scan: %s %s" % (k, why.get(k, "")))
    w.save_ledger(led); sys.exit(0)
import render as r
def fake_process(k, ledger, keep):
    ledger[k]["status"] = "rendered"; w.save_ledger(ledger); print("RENDERED %s" % k)
r.process = fake_process
r.run(limit=1)
`);
    const bin = path.join(home, 'bin'); mkdirSync(bin);
    writeFileSync(path.join(bin, 'python3'), `#!/bin/bash
case "$1" in
  scripts/content-engine/watch.py) shift; exec "${REAL_PY}" "${driver}" watch "$@";;
  scripts/content-engine/render.py) shift; exec "${REAL_PY}" "${driver}" render "$@";;
  scripts/job-queue.py) shift; exec "${REAL_PY}" "${QUEUE}" "$@";;
esac
echo "unexpected: python3 $*" >&2; exit 9
`);
    chmodSync(path.join(bin, 'python3'), 0o755);
    const queueDir = path.join(home, 'queue');
    const schedule = path.join(home, 'schedule.json');
    writeFileSync(schedule, JSON.stringify({ 'ce-night': { cron: '0 22 * * *', maxLateMinutes: 600, mode: 'wrapped' } }));
    const sh = readFileSync(RUN, 'utf8');
    const loop = sh.match(/# --- last-start-block[\s\S]*?\nfor day in \$DAYS; do\n[\s\S]*?\ndone\n/)[0];
    const pre = scanFirst ? 'python3 scripts/content-engine/watch.py repair\n' : '';
    const argv = underQueue
      ? [REAL_PY, [QUEUE, 'run', 'ce-night', '--no-stale-check', '--timeout', '1', '--', '/bin/bash', '-c', pre + loop]]
      : ['/bin/bash', ['-c', pre + loop]];
    const out = execFileSync(argv[0], argv[1], { encoding: 'utf8', cwd: home,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME, CE_LEDGER: path.join(ledgerDir, 'ledger.json'), CE_WORK: work, DAYS: days, CE_ALLOW_DAYTIME: '1',
        JOB_QUEUE_DIR: queueDir, JOB_QUEUE_SCHEDULE: schedule, JOB_QUEUE_POLL: '0.05', CE_GUEST_WAIT_FILE: path.join(home, 'guest-wait.txt') } });
    if (!underQueue) return out;
    const log = path.join(queueDir, 'queue-events.jsonl');
    const events = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { out, events };
  }
  const dayBlock = (out, day) => out.split('== day ').find((b) => b.startsWith(String(day))) || '';

  it('a one-clip day last in the night, behind an older pulled clip, renders inside its own day block', () => {
    const out = night({
      'older.insv': { key: 'older.insv', day: 2050, date: '2026-01-10', seq: 1, size: 5, status: 'pulled', local: 'ON_DISK' },
      'only.insv': { key: 'only.insv', day: 2060, date: '2026-01-20', seq: 1, size: 5, status: 'new' },
    }, '2060');
    const block = dayBlock(out, 2060);
    expect(block, 'control: the day ran').toMatch(/pull: only\.insv/);
    expect(block).toMatch(/RENDERED older\.insv/);
    expect(block).toMatch(/RENDERED only\.insv/);
    expect(block).toMatch(/next: nothing waiting for day 2060/);   // and only then is the day done
  });

  it('two pulled clips whose files have gone no longer hold the pull limit: the night pulls and renders its day', () => {
    const out = night({
      'gone-a.insv': { key: 'gone-a.insv', day: 2040, date: '2026-01-01', seq: 1, size: 5, status: 'pulled', local: '/nonexistent/gone-a.insv' },
      'gone-b.insv': { key: 'gone-b.insv', day: 2041, date: '2026-01-02', seq: 1, size: 5, status: 'pulled', local: '/nonexistent/gone-b.insv' },
      'today.insv': { key: 'today.insv', day: 2070, date: '2026-01-30', seq: 1, size: 5, status: 'new' },
    }, '2070', { scanFirst: true });
    expect(out).toMatch(/scan: gone-a\.insv was pulled but its local copy is gone; reset to new/);
    expect(out).toMatch(/scan: gone-b\.insv was pulled but its local copy is gone/);
    const block = dayBlock(out, 2070);
    expect(block).toMatch(/pull: today\.insv/);
    expect(block).toMatch(/RENDERED today\.insv/);
    expect(block).not.toMatch(/already pulled and not yet rendered/);
  });

  it('the counter alone also ignores a pulled clip with no file, even before the scan resets it', () => {
    const out = night({
      'gone-a.insv': { key: 'gone-a.insv', day: 2040, date: '2026-01-01', seq: 1, size: 5, status: 'pulled', local: '/nonexistent/gone-a.insv' },
      'gone-b.insv': { key: 'gone-b.insv', day: 2041, date: '2026-01-02', seq: 1, size: 5, status: 'pulled', local: '/nonexistent/gone-b.insv' },
      'today.insv': { key: 'today.insv', day: 2070, date: '2026-01-30', seq: 1, size: 5, status: 'new' },
    }, '2070');
    expect(dayBlock(out, 2070)).toMatch(/RENDERED today\.insv/);
  });

  // 15 Oct 2026: the render held the queue lock for hours while the brain feeds gave up behind it. Under the queue,
  // every render of the REAL loop is a declared background phase, the run keeps the lock throughout (one acquire, one
  // release), and the renders and their order are unchanged.
  it('under the queue, every render is a background phase and the run keeps the lock from start to finish', () => {
    const { out, events } = night({
      'a.insv': { key: 'a.insv', day: 2080, date: '2026-02-09', seq: 1, size: 5, status: 'new' },
      'b.insv': { key: 'b.insv', day: 2080, date: '2026-02-09', seq: 2, size: 5, status: 'new' },
    }, '2080', { underQueue: true });
    const block = dayBlock(out, 2080);
    expect(block).toMatch(/RENDERED a\.insv[\s\S]*RENDERED b\.insv/);
    expect(block).toMatch(/next: nothing waiting for day 2080/);
    const states = events.filter((e) => e.job === 'ce-night').map((e) => e.state);
    expect(states.filter((s) => s === 'yielded')).toHaveLength(2);       // one phase per render
    expect(states.filter((s) => s === 'resumed')).toHaveLength(2);
    expect(states.filter((s) => s === 'acquired')).toHaveLength(1);      // the lock never changed hands
    expect(states.filter((s) => s === 'released')).toHaveLength(1);
    expect(events.filter((e) => e.state === 'resumed').every((e) => e.exit === 0)).toBe(true);
    expect(states[states.length - 1]).toBe('released');
  });
});

// 8 Nov 2026: the 7 Nov 22:00 run passed the queue's Drive probe, then os.walk dropped every folder Drive would not
// serve, the scan read "no clips" in 0.7 s and the night was lost: no render, no episode cards, only a Mac pop-up.
// These run the REAL watch.scan on a scratch raw folder with one batch folder locked (chmod 000, which os.walk meets
// exactly as it met Drive's refusal) and only the waits stood in. Every write goes to scratch: the ledger, the skipped
// list, the lost-night marker and the findings queue. Back-tested on the old scan: it exits at once with no wait, no
// marker and no finding.
describe('content-engine scan: a raw folder Drive will not serve', () => {
  const { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const CE = path.join(ROOT, 'scripts', 'content-engine');
  const CLIP = 'VID_20260601_090000_00_001.insv';   // invented

  // scenario: 'locked' | 'comes-back' | 'empty' | 'partial' (2026 locked, 2025 readable with a clip)
  function scanIn(scenario) {
    const home = mkdtempSync(path.join(tmpdir(), 'ce-scan-'));
    const batch = path.join(home, 'raw', '2026', 'batch');
    mkdirSync(batch, { recursive: true });
    if (scenario !== 'empty') writeFileSync(path.join(batch, CLIP), 'x');
    if (scenario === 'partial') {
      mkdirSync(path.join(home, 'raw', '2025', 'older'), { recursive: true });
      writeFileSync(path.join(home, 'raw', '2025', 'older', 'VID_20260501_090000_00_002.insv'), 'x');   // invented
    }
    // a marker from an earlier lost night, and an earlier complete skipped list, so clearing and keeping both show
    writeFileSync(path.join(home, 'lost_night.json'), JSON.stringify({ at: '2026-11-01T22:30:00', why: 'earlier' }));
    writeFileSync(path.join(home, 'skipped_names.json'), JSON.stringify({ at: '2026-11-01T22:00:00', names: ['earlier'] }));
    if (scenario !== 'empty') chmodSync(path.join(home, 'raw', '2026'), 0o000);
    const driver = path.join(home, 'driver.py');
    writeFileSync(driver, `
import datetime as dt, json, os, sys
sys.path.insert(0, ${JSON.stringify(CE)})
import watch as w
home = ${JSON.stringify(home)}
w.RAW_ROOT = os.path.join(home, "raw")
w.LEDGER = os.path.join(home, "ledger.json")
w.SKIPPED_NAMES_FILE = os.path.join(home, "skipped_names.json")
w.drive_id = lambda p: None
locked = os.path.join(w.RAW_ROOT, "2026")
sleeps = []
def sleep(s):
    sleeps.append(s)
    if ${JSON.stringify(scenario)} == "comes-back" and len(sleeps) == 2: os.chmod(locked, 0o755)
code = 0
try:
    w.scan(create=False, since=dt.date(2026, 1, 1), waits=(60, 120, 300), sleep=sleep)
except SystemExit as e:
    code = 1; print(e)
finally:
    os.chmod(locked, 0o755)
print("RESULT " + json.dumps({"code": code, "sleeps": sleeps, "lost": w.lost_night(), "ledger": sorted(w.load_ledger()),
                              "skipped": json.load(open(w.SKIPPED_NAMES_FILE))["names"]}))
`);
    const findings = path.join(home, 'findings.jsonl');
    const out = execFileSync('python3', [driver], { encoding: 'utf8', env: { ...process.env,
      FINDINGS_FILE: findings, FINDINGS_OVERFLOW_FILE: path.join(home, 'overflow.jsonl'),
      FINDINGS_AGENTS_CACHE: path.join(home, 'agents-cache.json'), FINDINGS_AGENT: '' } });
    const result = JSON.parse(out.split('RESULT ')[1]);
    const filed = existsSync(findings)
      ? readFileSync(findings, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    rmSync(home, { recursive: true, force: true });
    return { out, result, filed };
  }

  it('an unreadable folder is walked again on every wait, then the night is given up with one finding and a marker', () => {
    const { out, result, filed } = scanIn('locked');
    expect(result.code).toBe(1);
    expect(result.sleeps).toEqual([60, 120, 300]);                       // three waits, four walks
    expect(out).toMatch(/Drive would not serve 1 folder \(first: 2026: /);
    expect(out).toContain("the night's render did not run");
    const adds = filed.filter((f) => f.op === 'add');
    expect(adds).toHaveLength(1);
    expect(adds[0].routine).toBe('content-engine');
    expect(adds[0].severity).toBe('high');
    expect(adds[0].detail).toMatch(/walked the raw folder 4 times over 8 min/);
    expect(result.lost.why).toMatch(/Drive would not serve 1 folder/);
  });

  it('a folder that comes back during the wait is read, its clip is seen and no finding is filed', () => {
    const { out, result, filed } = scanIn('comes-back');
    expect(result.code).toBe(0);
    expect(result.sleeps).toEqual([60, 120]);                            // the third walk read it
    expect(result.ledger).toEqual([CLIP]);
    expect(out).toMatch(/scan: 1 clips seen, 1 new/);
    expect(result.lost).toBeNull();                                     // the earlier lost night is cleared
    expect(result.skipped).toEqual([]);                                 // a complete walk rewrites the list
    expect(filed).toEqual([]);
  });

  it('a walk that finds clips but misses a folder runs the night, and keeps the last complete skipped list', () => {
    const { out, result, filed } = scanIn('partial');
    expect(result.code).toBe(0);
    expect(result.sleeps).toEqual([]);                                  // clips came back: no wait
    expect(result.ledger).toEqual(['VID_20260501_090000_00_002.insv']);
    expect(out).toMatch(/1 clips found, but Drive would not serve 1 folder \(first: 2026: /);
    expect(result.skipped).toEqual(['earlier']);                        // not overwritten by an incomplete walk
    expect(result.lost).toBeNull();
    expect(filed).toEqual([]);
  });

  it('an empty listing is named as empty, not as unreadable', () => {
    const { result, filed } = scanIn('empty');
    expect(result.code).toBe(1);
    expect(result.lost.why).toBe('the folder listed but held no clips');
    expect(filed.filter((f) => f.op === 'add')).toHaveLength(1);
  });

  it("the 08:00 content line opens with the lost night, from the marker the live writer reads", () => {
    const out = execFileSync('python3', ['-c', `
import datetime as dt, json, sys
sys.path.insert(0, ${JSON.stringify(CE)})
import content_report as cr, watch, publish, approval, runpreneur_sync
rec = {"at": "2026-11-07T22:30:05", "why": "Drive would not serve 3 folders (first: 2026: Resource deadlock avoided)"}
watch.lost_night = lambda path=None: rec
watch.load_ledger = lambda: {}
watch.skipped_names = lambda path=None, ruled=None: []
watch.skipped_ruled = lambda *a, **k: []
publish.load_state = lambda *a, **k: {}
publish.held_days = lambda *a, **k: {}
approval.load_state = lambda *a, **k: {}
runpreneur_sync.load_state = lambda *a, **k: {}
cr.live_overlay = lambda st, ap, now, rp, rc: (st, ap, {})
now = dt.datetime(2026, 11, 8, 8, 0, tzinfo=dt.timezone.utc)
live = cr.build_live(now)
plain = cr.build(now, {}, {}, {}, {}, plan=[], skipped=[], holds={})
late = cr.lost_night_line({"at": "2026-11-08T00:50:00", "why": "w"})
day = cr.lost_night_line({"at": "2026-11-08T10:15:00", "why": "w"})
print(json.dumps({"live": live["headline"], "plain": plain["headline"], "late": late, "day": day}))
`], { encoding: 'utf8' });
    const { live, plain, late, day } = JSON.parse(out.trim().split('\n').pop());
    expect(live.startsWith('Content: The Sat 7 Nov night render did not run (Drive would not serve 3 folders')).toBe(true);
    expect(live).toContain('so it made no new episodes. NOTHING went out yesterday.');
    expect(plain.startsWith('Content: NOTHING went out yesterday.')).toBe(true);   // no marker, no line
    expect(late).toBe('The Sat 7 Nov night render did not run (w), so it made no new episodes');   // after midnight: the evening before
    expect(day).toBe('The raw video scan at 10:15 on Sun 8 Nov found no clips (w)');               // a hand run is not a night
  });
});
