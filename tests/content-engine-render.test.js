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
    expect(out.checks).toBeGreaterThanOrEqual(36);
  });

  it("inserts Ericamae's 8 second branded intro after the sign-off line (her app's rule) and makes the podcast audio", () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toContain('INTRO_CLIP = os.path.join(EDITED_ROOT, "Vlog Intro", "runprenuer-intro_clip.mp4")');
    expect(src).toContain('def intro_insert_seconds(segments');
    expect(src).toContain('insert_intro(captioned, at, paths["full"])');
    expect(src).toContain('paths["podcast"] = podcast_audio(captioned');
    expect(src).toMatch(/keep on \(\?:watching\|listening\)/);
  });

  it('finds the episode record by NAME first, and by raw link only among Full Episode records (3 Sep 2026: a catch-up clip landed on the 2195 Short record)', () => {
    const w = readFileSync(WATCH, 'utf8');
    const name = w.indexOf('{Content Name}="%s"\' % episode_name(day)');
    const raw = w.indexOf('FIND("%s", {Raw File Link}), {Content Type}="Long Form Video"');
    expect(name).toBeGreaterThan(-1);
    expect(raw).toBeGreaterThan(name);
  });

  it("applies Kevin's 4 Sep 2026 feedback: jingle at the real pause, first second of the jingle cut, diary phrase heard loosely, no stale Learnings link, podcast without the jingle", () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toContain('INTRO_TRIM_START = 1.0');
    expect(src).toContain('CUT_THRESHOLDS_DB = (-35, -30, -25, -20)');
    expect(src).toContain('at, resume = find_pause(masters["16:9"], segs, intro_insert_seconds(segs))');
    expect(src).toContain('clip_caption_at(open(caps).read(), at)');
    expect(src).toMatch(/learn\\w\*\\s\+\(\?:from\|for\|of\|through\|in\|to\)/);
    expect(src).toContain('elif role == "episode": fields["Reframed Video URL"] = None');
    expect(src).toContain('paths["podcast"] = podcast_audio(captioned, os.path.join(workdir, names["podcast"]), at, resume)');
    expect(src).toContain('"--subtitle", title.replace("|", " ").strip()');
  });

  it('writes the clipped caption file safely and reuses finished masters after a crash (5 Sep 2026)', () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toContain('clipped = clip_caption_at(open(caps).read(), at)');
    expect(src).not.toContain('open(caps, "w").write(clip_caption_at(open(caps).read(), at))');
    expect(src).toContain('def master_complete(');
    expect(src).toContain('render: reusing finished %s master');
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

  it("builds the LFMD from the 'Learnings from my diary' section, and the Summary from the teaser clip (Kevin, 3 Sep 2026)", () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toMatch(/LFMD_START_RE = re\.compile\(r"learn\\w\*\\s\+\(\?:from\|for\|of\|through\|in\|to\)/);
    expect(src).toContain('def lfmd_window(segments');
    expect(src).toContain('TEASER_MAX_SECONDS = 150');
    expect(src).toContain('if role == "teaser":');
    expect(src).toContain('"--no-raise-cut"');   // one angle for the whole clip
  });

  it('every flag the render passes to stab.py is a flag stab.py accepts (a comment once swallowed --video-only)', () => {
    const out = execFileSync('python3', [path.join(DIR, 'stab.py'), 'render', '--help'], { encoding: 'utf8', cwd: DIR });
    for (const flag of ['--proj', '--dfov', '--tilt', '--level', '--blend', '--size', '--no-raise-cut', '--workers', '--video-only', '--map', '--only']) {
      expect(out, flag).toContain(flag);
    }
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
