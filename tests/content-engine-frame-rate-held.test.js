// The frame rate the episode is DELIVERED at, measured and gated (scripts/content-engine/qa.py,
// scripts/content-engine/render.py).
//
// Findings 20261016-phase-3-937, 20261017-phase-3-960, 20261023-phase-3-1052 and
// 20261025-phase-3-1075. Kevin reported the same thing four separate times: stabilisation was good
// around the 2080s episodes and has got jolty since. The mechanism was found on 12 Oct 2026
// (finding 20261012-phase-3-837, tests/content-engine-stab-fps.test.js): a forced 24 fps output on
// a 29.97 fps clip resamples on an uneven 5:4 cadence and drops frames, which is the judder.
//
// The mechanism was fixed. The MEASUREMENT was not, and that is why the four findings stayed open.
// 2099, 2100 and 2106 all shipped resampled and all passed this gate, because the line in qa.py
// read:
//
//     add("frame rate handled", True, False, "source %s fps, rendered at 24" % ...)
//
// a hardcoded pass that ASSERTED the rate instead of measuring it, and went on asserting "rendered
// at 24" for weeks after the code had stopped doing that. render.py now writes render_fps off the
// delivered file and the gate compares it with the source, hard.
//
// Driven through qa.gate with 2106's real numbers, not grepped: the bug was a value nothing read.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CE = path.resolve(__dirname, '..', 'scripts', 'content-engine');

function gate(extra) {
  const script = String.raw`
import sys, os, json, tempfile, subprocess
sys.path.insert(0, ${JSON.stringify(CE)})
import qa

SECONDS = {}
class Probe:
    def __init__(self, out): self.stdout, self.returncode = out, 0
real_run = subprocess.run
def fake_run(cmd, *a, **k):
    if os.path.basename(cmd[0]) == "ffprobe": return Probe(SECONDS.get(os.path.basename(cmd[-1]), ""))
    return real_run(cmd, *a, **k)
subprocess.run = fake_run

tmp = tempfile.mkdtemp()
def mk(name, body="media", mode="w"):
    p = os.path.join(tmp, name); open(p, mode).write(body); return p
length = 600.0
cues = "".join("%d\n00:00:%02d,000 --> 00:00:%02d,000\nsome words here now\n\n" % (i + 1, i, i + 1) for i in range(60))
files = {"full": mk("full.mp4"), "full_yt": mk("full_yt.mp4"), "podcast": mk("pod.mp3"), "lfmd": "", "lfmd_yt": "",
         "summary": "", "full_srt": mk("full.srt", cues), "lfmd_srt": "", "thumb": mk("t.png", b"0" * 30000, "wb"),
         "transcript": mk("tr.txt", "")}
SECONDS.update({"full.mp4": str(length + 7), "full_yt.mp4": str(length + 7), "pod.mp3": str(length)})
ep = {"episode": 2106, "role": "episode", "status": "rendered", "duration": length,
      "horizon": {"1": 2.0, "10": 1.0}}
ep.update(json.loads(sys.argv[1]))
ok, failures, passed = qa.gate(2106, {"c.insv": ep}, files)
print(json.dumps({"ok": ok, "failures": failures, "passed": passed}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, JSON.stringify(extra)], { encoding: 'utf8', cwd: CE }));
}

describe('content engine: the delivered frame rate is measured, not asserted', () => {
  it("refuses 2106's real numbers: a 29.97 fps source delivered at 24 fps", () => {
    const r = gate({ source_fps: 29.97, render_fps: 24.0 });
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f[0])).toEqual(['frame rate held']);
    expect(r.failures[0][1]).toContain('judder');
  });

  it('passes a rate that held, and says both numbers on the card', () => {
    const r = gate({ source_fps: 29.97, render_fps: 29.97 });
    expect(r.ok).toBe(true);
    const line = r.passed.find((p) => p[0] === 'frame rate held');
    expect(line[1]).toBe('source 29.97 fps, delivered 29.97 fps');
  });

  it('calls a day with no measurement NOT MEASURED, and does not block it', () => {
    // Every episode rendered before 1 Nov 2026 has no render_fps. An unmeasured day must not be
    // dressed up as a pass (binding rule: no silent zeros) and must not refuse an old card either.
    const r = gate({ source_fps: 29.97 });
    expect(r.ok).toBe(true);
    expect(r.passed.map((p) => p[0])).not.toContain('frame rate held');
    const r2 = gate({});
    expect(r2.ok).toBe(true);
  });

  it('treats probe rounding as the same rate, not a resample', () => {
    expect(gate({ source_fps: 24.0, render_fps: 23.976 }).ok).toBe(true);
  });
});
