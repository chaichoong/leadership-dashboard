// Content Engine 360 pipeline: the deterministic half of the Runpreneur lane
// (scripts/content-engine/*). These run the scripts' own selftests and pin the
// calibrated constants Kevin approved on 2 Sep 2026, so a "tidy-up" cannot quietly
// change the picture: the IMU axis mapping, the caption/title placement rules and the
// brand dictionary were each found by testing against real footage, not by reasoning.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '..', 'scripts', 'content-engine');
const STAB = path.join(DIR, 'stab.py');
const OVERLAYS = path.join(DIR, 'overlays.py');
const INSTA = path.join(DIR, 'insta.py');
const py = (file, args = []) => execFileSync('python3', [file, ...args], { encoding: 'utf8', cwd: DIR });

describe('content-engine: stab.py (stitch + gyro horizon lock)', () => {
  it('passes its own selftest', () => {
    expect(py(STAB, ['selftest'])).toContain('stab selftest ok');
  });

  it('keeps the X4 lens and IMU calibration that was measured against real footage', () => {
    const insta = readFileSync(INSTA, 'utf8');
    expect(insta).toMatch(/MIRROR = \{"front": \(1\.0, 1\.0\), "back": \(-1\.0, 1\.0\)\}/);
    expect(insta).toMatch(/FRONT = 1/);
    expect(insta).toMatch(/LENS_FOV = 190\.0/);
    const doc = readFileSync(path.resolve(__dirname, '..', 'docs', 'content-engine-360.md'), 'utf8');
    expect(doc).toContain('--map z-yx');      // the only mapping that stays level with weak gravity gain
  });

  it('reads the lens size from the file rather than assuming 5.7K (Feb 2026 clips are 8K)', () => {
    const insta = readFileSync(INSTA, 'utf8');
    expect(insta).toContain('def lens_size(path)');
    expect(insta).not.toMatch(/reshape\(SIZE, SIZE, 3\)/);
  });
});

describe('content-engine: overlays.py (captions + banners)', () => {
  it('passes its own selftest', () => {
    expect(py(OVERLAYS, ['selftest'])).toContain('overlays selftest ok');
  });

  it("re-chunks a whisper SRT into <=5-word lines, drops noise and fixes the brand", () => {
    const src = readFileSync(OVERLAYS, 'utf8');
    expect(src).toContain('MAX_WORDS = 5');
    expect(src).toMatch(/Runpreneur/);
    // Kevin's placement rules: captions in the band under the feet, titles in the band above the head
    expect(src).toMatch(/"16:9": ".*MarginV=28.*Alignment=2"/);
    expect(src).toMatch(/"9:16": ".*MarginV=34.*Alignment=2"/);
    expect(src).toMatch(/BANNER_Y = 190/);
  });

  it('applies captions to every format, including LFMD (Kevin, 2 Sep 2026)', () => {
    const src = readFileSync(OVERLAYS, 'utf8');
    const lfmd = src.slice(src.indexOf('def build_lfmd'), src.indexOf('def build_summary'));
    expect(lfmd).toContain('_subs_filter');
  });
});
