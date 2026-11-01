// Where the intro jingle goes, when Kevin has told us (scripts/content-engine/render.py).
//
// Findings 20261018-ceo-memory-sweep-973 and 20261025-phase-3-1077. Episode 2100's jingle was sent
// back on 15, 16 AND 17 Oct 2026 and 2113's again on 25 Oct. find_pause() is deterministic, so each
// redo re-rendered the whole day "on the current code" and produced the identical cut: the card came
// straight back, and the figure Kevin put in the note ("at about 33 seconds", "at 26 seconds") had
// nowhere to go. Four bounces, no mechanism.
//
// Two doors now exist, and both land on one ledger field, intro_at_override:
//   render.py cut --day N --at 26.0   (typed, checked at the keyboard)
//   redo-day                          (read off the sent-back card, no human at all)
//
// Driven here rather than grepped, because what broke was a value nothing read.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CE = path.resolve(__dirname, '..', 'scripts', 'content-engine');

function py(body) {
  const script = String.raw`
import sys, json
sys.path.insert(0, ${JSON.stringify(CE)})
import render
res = None
${body.split('\n').map((l) => l).join('\n')}
print(json.dumps(res))
`;
  // set_cut tells the operator what it did, so the result is the LAST line, not the whole stdout
  const out = execFileSync('python3', ['-c', script], { encoding: 'utf8', cwd: CE });
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

describe('content engine: the jingle cut Kevin gives', () => {
  it("takes the figure out of his note on 2113 and on 2100", () => {
    expect(py(`res = render.jingle_cut_from("The intro jingle should happen at 26 seconds of the full episode. It is still not in the right place.")`)).toEqual([true, 26.0]);
    expect(py(`res = render.jingle_cut_from("The jingle is still in the wrong place. It should appear at about 33 seconds on this episode, but you just need to look for that 5-second pause.")`)).toEqual([true, 33.0]);
  });

  it('never reads the length of the pause as the place for the cut', () => {
    // "I leave a pause after the intro of maybe 5 seconds" is in the note that bounced 2100. Taking
    // the 5 there would put the jingle at 5 s, which is worse than leaving the detector alone.
    expect(py(`res = render.jingle_cut_from("The jingle still in the wrong place. I leave a pause after the intro of maybe 5 seconds.")`)).toEqual([true, null]);
    expect(py(`res = render.jingle_cut_from("The jingle needs to wait until the pause.")`)).toEqual([true, null]);
  });

  it('refuses two different figures rather than picking one', () => {
    expect(py(`res = render.jingle_cut_from("The jingle should be at 26 seconds. Actually the jingle belongs at 31 seconds.")`)).toEqual([true, null]);
  });

  it('keeps the gap the detector measured, so the podcast still loses the same pause', () => {
    // insert_intro splices the whole jingle in at the cut and podcast_audio removes [cut, resume].
    // Moving the cut without carrying the gap would change how much of his pause the podcast loses.
    expect(py(`res = list(render.cut_with_override(41.2, 43.7, 26.0, 600.0, 2113))`)).toEqual([26.0, 28.5, 'operator']);
    expect(py(`res = list(render.cut_with_override(41.2, 43.7, None, 600.0, 2113))`)).toEqual([41.2, 43.7, 'detector']);
  });

  it('refuses a figure that is not inside the episode, naming the day', () => {
    for (const bad of ['-1.0', '400.0', '599.5', '"later"', 'None']) {
      const r = py(`
try:
    render.check_cut_override(${bad}, 600.0, 2113); res = "accepted"
except SystemExit as ex:
    res = str(ex)
`);
      expect(r).not.toBe('accepted');
      expect(r).toContain('2113');
    }
  });

  it('stores it on the day and takes it off again', () => {
    expect(py(`
led = {"c.insv": {"episode": 2113, "role": "episode", "duration": 600.0}}
saved = []
got = render.set_cut(2113, at="26", ledger=led, save=saved.append)
render.set_cut(2113, clear=True, ledger=led, save=saved.append)
res = [got, "intro_at_override" in led["c.insv"], len(saved)]
`)).toEqual([26.0, false, 2]);
  });
});
