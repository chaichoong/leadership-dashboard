// Content Engine stabiliser frame rate (scripts/content-engine/stab.py).
//
// Finding 20261012-phase-3-837: three episodes in a row (2099, 2100, 2106) were sent back for
// stabilisation judder, and the "degradation" tracked the SOURCE frame rate exactly — every
// sent-back episode is 29.97 fps, every episode to 2097 is 24.0 and was fine. stab.py pinned
// FPS = 24.0 and passed it to insta.frame_stream, so a 29.97 fps clip was resampled 29.97 -> 24,
// which drops frames on an uneven 5:4 cadence. That IS the judder. A 24.0 fps source resamples
// 1:1, which is why it never showed before.
//
// The rate now comes from the clip (fps_for -> probe_fps -> set_fps) before anything reads FPS.
// The cases are driven in stab.py's own selftest rather than grepped, because the specific way
// this broke was an import-time default binding (fps=FPS in per_frame_R's signature), which no
// amount of reading the source makes obvious.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '..', 'scripts', 'content-engine');
const STAB = path.join(DIR, 'stab.py');

describe('content-engine stab frame rate', () => {
  it('passes its own selftest, which drives the source-rate resolution end to end', () => {
    const out = execFileSync('python3', [STAB, 'selftest'], { encoding: 'utf8', cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toContain('stab selftest ok');
  });

  it('never re-hardcodes the output rate: FPS is resolved from the clip, not bound at import', () => {
    const src = readFileSync(STAB, 'utf8');
    // the resolution path exists and is called before the render reads FPS
    expect(src).toContain('def parse_fps(text)');
    expect(src).toContain('def probe_fps(clip)');
    expect(src).toContain('def fps_for(clip)');
    expect(src).toMatch(/print\("stab: source rate %\.3f fps" % fps_for\(clip\)\)/);
    // the two defaults that used to bind FPS at import time must stay late-bound, or set_fps
    // cannot reach them and the gyro mapping silently stays on a 24 fps timeline
    expect(src).toContain('def per_frame_R(t, Rs, n_frames, fps=None, offset=0.0):');
    expect(src).toContain('def apply_pans(F_sm, pans, fps=None):');
    expect(src).not.toMatch(/def \w+\([^)]*fps=FPS/);
    // and the frame pull must ask for the pinned rate, which is the source rate
    expect(src).toContain('fps=FPS)   # FPS is the SOURCE rate');
  });
});
