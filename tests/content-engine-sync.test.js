// Content Engine: the "How far I've run" sync (runpreneur_sync.py) and the Spotify plan (spotify.py).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'scripts', 'content-engine');

describe('content-engine runpreneur sync', () => {
  it('passes its selftest (calendar day, caption wording, progress, never double-counts a run)', () => {
    const out = JSON.parse(execFileSync('python3', [path.join(DIR, 'runpreneur_sync.py'), 'selftest'], { encoding: 'utf8', cwd: DIR }));
    expect(out.failed).toEqual([]);
  });
  it("uses the calendar for the day number (1 Jun 2020 = day 1), the app's exact caption, and the site's four custom values", () => {
    const src = readFileSync(path.join(DIR, 'runpreneur_sync.py'), 'utf8');
    expect(src).toContain('STREAK_START = dt.date(2020, 6, 1)');
    expect(src).toContain('#runpreneurchallenge');
    for (const k of ['total_of_days', 'total_disctance', 'total_raised', 'progress_bar']) expect(src).toContain(`"${k}"`);
    expect(src).toContain('refusing to write blind');
  });
  it('runs nightly after publishing and never kills the run on a Strava quota error', () => {
    const sh = readFileSync(path.join(ROOT, 'scripts', 'content-engine-run.sh'), 'utf8');
    expect(sh.indexOf('runpreneur_sync.py run')).toBeGreaterThan(sh.indexOf('publish.py run'));
    expect(sh).toMatch(/runpreneur_sync\.py run \|\| echo/);
  });
});

describe('content-engine spotify plan', () => {
  it('passes its selftest and never publishes in test mode', () => {
    const out = JSON.parse(execFileSync('python3', [path.join(DIR, 'spotify.py'), 'selftest'], { encoding: 'utf8', cwd: DIR }));
    expect(out.failed).toEqual([]);
    const src = readFileSync(path.join(DIR, 'spotify.py'), 'utf8');
    expect(src).toContain('"Publish now" if not test else "Save as draft"');
    expect(src).toContain('PODCAST_FORMAT = "video"');
    expect(readFileSync(path.join(DIR, 'publish.py'), 'utf8')).toContain('upload = files["podcast"] if spotify.PODCAST_FORMAT == "audio"');
    expect(readFileSync(path.join(DIR, 'publish.py'), 'utf8')).toContain('spotify.write_plan(day, upload');
  });
});
