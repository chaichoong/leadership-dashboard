// Content Engine R2/R3/R5: one pulled clip -> transcript -> episode number -> three outputs ->
// edited Drive folder -> episode record (scripts/content-engine/render.py). The pure parts run
// through the script's own selftest; the checks below pin Kevin's episode-number ruling
// (3 Sep 2026) and the B-roll guard so a refactor cannot quietly loosen them.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '..', 'scripts', 'content-engine');
const RENDER = path.join(DIR, 'render.py');
const WATCH = path.join(DIR, 'watch.py');

describe('content-engine render', () => {
  it('passes its own selftest (folder naming, output names, banner title, record fields)', () => {
    const out = JSON.parse(execFileSync('python3', [RENDER, 'selftest'], { encoding: 'utf8', cwd: DIR }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(9);
  });

  it('never writes copy from an empty transcript: under 50 characters of speech is B-roll', () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toMatch(/MIN_TRANSCRIPT_CHARS = 50/);
    expect(src).toContain('e["status"] = "broll"');
  });

  it("works out the episode with Kevin's rule: date first, spoken day as a check, catch-up keeps the spoken day", () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toContain('watch.resolve_episode(date_day, watch.spoken_day(text)');
    const w = readFileSync(WATCH, 'utf8');
    expect(w).toContain('"catch-up for the missed previous day"');
    expect(w).toMatch(/spoken day %d disagrees with the date/);
  });

  it('uses the approved recipe numbers for both aspects', () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toMatch(/"16:9": \["--proj", "sg", "--dfov", "250", "--tilt", "11", "--level"/);
    expect(src).toMatch(/"9:16": \["--proj", "sg", "--dfov", "215", "--tilt", "9", "--level"/);
  });

  it('files outputs under the edited folder\'s hundreds convention and writes the four links', () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toContain('hundreds_folder(day)');
    for (const f of ['Video Edited URL', 'Subtitled Video URL', 'Reframed Video URL', 'Summary Video URL', 'Transcription']) {
      expect(src).toContain(f);
    }
    expect(src).toMatch(/STATUS_DONE = "Optimisation and Design Done"/);
  });
});
