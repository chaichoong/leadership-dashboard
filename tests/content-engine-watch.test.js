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
    expect(run).toMatch(/if ! ce_may_start_day "\$\(date \+%-H\)"; then[\s\S]{0,400}continue/);
    expect(run).toContain('approval.py run --pending --limit "$COPY_LIMIT"');   // a card for every episode the night planned
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
    expect(w).toContain('def plan(ledger, slots, gaps=None, free=None, start=None)');
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

  function night(ledger, days, { scanFirst = false } = {}) {
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
esac
echo "unexpected: python3 $*" >&2; exit 9
`);
    chmodSync(path.join(bin, 'python3'), 0o755);
    const sh = readFileSync(RUN, 'utf8');
    const loop = sh.match(/# --- last-start-block[\s\S]*?\nfor day in \$DAYS; do\n[\s\S]*?\ndone\n/)[0];
    const pre = scanFirst ? 'python3 scripts/content-engine/watch.py repair\n' : '';
    return execFileSync('/bin/bash', ['-c', pre + loop], { encoding: 'utf8', cwd: home,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME, CE_LEDGER: path.join(ledgerDir, 'ledger.json'), CE_WORK: work, DAYS: days, CE_ALLOW_DAYTIME: '1' } });
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
});
