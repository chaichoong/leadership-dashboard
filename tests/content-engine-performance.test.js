// Content Engine performance read (scripts/content-engine/performance.py): Kevin, 8 Sep 2026, "once a month, last
// 30 days... a performance read... three recommendations that become lessons". The Chen chain's measure step.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'scripts', 'content-engine');
const PERF = path.join(DIR, 'performance.py');

describe('content-engine performance read', () => {
  it('passes its own selftest (watch-page parsing, window, medians, weekly totals, the card, absence reporting)', () => {
    const out = execFileSync('python3', [PERF, 'selftest'], { encoding: 'utf8', timeout: 120000 });
    const last = out.trim().split('\n').pop();
    expect(JSON.parse(last).failed).toEqual([]);
  });

  it('reads public YouTube pages rather than yt-dlp per video (throttled after a few dozen calls on 8 Sep 2026)', () => {
    const p = readFileSync(PERF, 'utf8');
    expect(p).toContain('def fetch_watch(vid)');
    expect(p).toContain('def parse_watch_page(html)');
    expect(p).toContain('"--flat-playlist"'); // the listing is the only yt-dlp call, and it carries no counts
  });

  it('stores GoHighLevel totals weekly because the statistics API answers for seven days only, and sums the weeks in the window', () => {
    const p = readFileSync(PERF, 'utf8');
    expect(p).toContain('/social-media-posting/statistics?locationId=');
    expect(p).toContain('{"profileIds": [pid]}');
    expect(p).toContain('def weeks_in_window(snapshots, start, end)');
    expect(p).toContain('Fewer than four weeks stored');
  });

  it('writes views and likes onto the record fields that Engagements Total sums, matched by the YouTube link', () => {
    const p = readFileSync(PERF, 'utf8');
    expect(p).toContain('STAT_FIELDS = {"views": "👀 Views (YT)", "likes": "👍🏻 Likes (YT)"}');
    expect(p).toContain('FIND("%s", {YouTube Link})');
  });

  it('is one card through the same gate and submit as every other card, and approval turns the three recommendations into dated lessons', () => {
    const p = readFileSync(PERF, 'utf8');
    expect(p).toContain('approval.GATE, "create", "--force"');
    expect(p).toContain('approval.DISPATCH, "submit"');
    expect(p).toContain('d.append_lesson_to_file(AGENT_SLUG, line)');
    expect(p).toContain('d.mirror_lesson_to_register(REGISTER_ROW, line)');
    expect(p).toContain('if outcome in approval.APPROVED:');
  });

  it('is wired into the nightly run: verdict sync every night, snapshot on Mondays, the read on the 1st, none of them able to stop the lane', () => {
    const sh = readFileSync(path.join(ROOT, 'scripts', 'content-engine-run.sh'), 'utf8');
    expect(sh).toContain('performance.py sync || echo');
    expect(sh).toMatch(/date \+%u\)" = "1" \] && \{ python3 scripts\/content-engine\/performance\.py snapshot/);
    expect(sh).toMatch(/date \+%d\)" = "01" \] && \{ python3 scripts\/content-engine\/performance\.py run/);
  });
});
