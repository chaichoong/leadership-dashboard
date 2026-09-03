// Content Engine R6: the YouTube thumbnail (scripts/content-engine/thumbnail.py), a port of the Content
// Machine app's thDraw() with its icon catalogue and logo lifted verbatim into cm_thumb_assets.py. The
// selftest parses all 290 catalogue icons, measures text through ffmpeg and composes a real 1280x720
// PNG; the checks below pin the two bugs found on the first render (3 Sep 2026): a title with an
// apostrophe vanished because it went through text='...', and a catalogue path with a malformed arc
// crashed the parser instead of stopping where a browser would.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '..', 'scripts', 'content-engine');
const THUMB = path.join(DIR, 'thumbnail.py');
const RENDER = path.join(DIR, 'render.py');

describe('content-engine thumbnail', () => {
  it('passes its own selftest (icon catalogue, path parser, text measure, real composition)', () => {
    const out = JSON.parse(execFileSync('python3', [THUMB, 'selftest'], { encoding: 'utf8', cwd: DIR }));
    expect(out.failed).toEqual([]);
    expect(out.checks).toBeGreaterThanOrEqual(13);
  }, 120000);

  it("puts every title line through a text file, so an apostrophe (KIDS CAN'T FIND) never ends the filter quote", () => {
    const src = readFileSync(THUMB, 'utf8');
    expect(src).not.toMatch(/drawtext=[^\n]*:text='/);
    expect(src).toMatch(/textfile='%s'/);
  });

  it('stops a malformed path where a browser would instead of crashing on it', () => {
    const src = readFileSync(THUMB, 'utf8');
    expect(src).toContain('class _PathEnd(Exception)');
    expect(src).toContain('except (_PathEnd, IndexError):');
  });

  it('is part of the render: frame from the 9:16 master, Claude titles with a banner fallback, link on the record', () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toContain('paths["thumb"], e["thumb_lines"] = make_thumbnail(masters["9:16"]');
    expect(src).toContain('fields["Thumbnail URL"] = links["thumb"]');
    expect(src).toContain('using the banner title');
  });
});
