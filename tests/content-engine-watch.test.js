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
    expect(w).toContain('stale = repair_stale_pulls(ledger)');
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
    expect(p).toContain('def may_go_to_youtube(day, gaps, state, ledger, approved)');
    expect(p).toContain('moves_cursor(day, gaps): state[CURSOR_KEY] = day');
    expect(p).toContain('d > cursor(state) + 1 and d not in gaps');
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
    expect(p).toContain('when_for(platform, spec["clip"], index)');
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
    expect(r).toContain('links = publish_via_api(paths, day, transcript_txt)');
    expect(r).toContain('drive_api.folder_id(drive_api.EDITED_PATH + [hundreds_folder(day), str(day)], create=True)');
  });
});
