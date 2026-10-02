import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CE = resolve(ROOT, 'scripts/content-engine');

// 2 Oct 2026, two faults in where the Learnings clip is cut, both found by the review of PR #680.
//
// 1. render.lfmd_window read the captions two pieces at a time. A diary line that whisper spread over three pieces
//    (a noise note in the middle, or a one-word piece) was never found, so no clip was cut, and the rebuild command
//    answered "no diary section". The same blind spot let the show's own name through as a Learnings section when a
//    noise note sat between the day number and "of the diary".
// 2. The output gate checked that a Learnings clip exists, never where it starts. 2081's was cut from an aside at
//    1 min 16 s of an 8 min 41 s episode and reached Kevin's card ("you've clipped the wrong section").
const J = (x) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

function py(body) {
  const script = String.raw`
import sys, os, io, json, tempfile, contextlib, subprocess
sys.path.insert(0, ${JSON.stringify(CE)})
import render, watch, qa

def segs(lines, step=10.0):
    return [(i * step, (i + 1) * step, t) for i, t in enumerate(lines)]

SECONDS = {}
class Probe:
    def __init__(self, out): self.stdout, self.returncode = out, 0
real_run = subprocess.run
def fake_run(cmd, *a, **k):
    if os.path.basename(cmd[0]) == "ffprobe": return Probe(SECONDS.get(os.path.basename(cmd[-1]), ""))
    return real_run(cmd, *a, **k)
subprocess.run = fake_run

def gate_for(window, length, accepted=None, recorded=True, transcript="", entry=None):
    """qa.gate on a day whose files are all in order: this Learnings window, this episode length (on the ledger when
    recorded), this transcript text. A day with no window has no Learnings clip files."""
    tmp = tempfile.mkdtemp()
    def mk(name, body="media", mode="w"):
        p = os.path.join(tmp, name); open(p, mode).write(body); return p
    last = length + 7          # the captions carry the 7 s jingle
    cues = "".join("%d\n%s --> %s\njust some words here now\n\n" % (i + 1, render.srt_ts(a), render.srt_ts(min(a + 5, last))) for i, a in enumerate(range(0, int(last), 5)))
    clip = bool(window)
    files = {"full": mk("full.mp4"), "full_yt": mk("full_yt.mp4"), "podcast": mk("pod.mp3"), "lfmd": mk("lfmd.mp4") if clip else "", "lfmd_yt": mk("lfmd_yt.mp4") if clip else "",
             "summary": "", "full_srt": mk("full.srt", cues), "lfmd_srt": mk("lfmd.srt", cues), "thumb": mk("t.png", b"0" * 30000, "wb"), "transcript": mk("tr.txt", transcript)}
    SECONDS.update({"full.mp4": str(length + 7), "full_yt.mp4": str(length + 7), "pod.mp3": str(length), "lfmd.mp4": "120", "lfmd_yt.mp4": "120"})
    ep = {"episode": 2081, "role": "episode", "status": "rendered", "lfmd_window": window, "horizon": {"1": 2.0, "10": 1.0}}
    if recorded: ep["duration"] = length
    if accepted is not None: ep["lfmd_early_ok"] = accepted
    ep.update(entry or {})
    ok, failures, passed = qa.gate(2081, {"c.insv": ep}, files)
    return {"ok": ok, "failures": failures, "passed": passed}

res = None
out, err = io.StringIO(), io.StringIO()
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
${body.split('\n').map((l) => '    ' + l).join('\n')}
print(json.dumps({"res": res, "out": out.getvalue(), "err": err.getvalue()}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

// three pieces of talk before the line and a sign-off after it, so a found window never starts at 0 by accident
const LEAD = ['Welcome back to the run', 'today I talk about rest', 'and why it matters so much'];
const TAIL = ['you should rest more than', 'you think you need to', 'thank you as always'];
const window = (middle) => py(`res = render.lfmd_window(segs(${J([...LEAD, ...middle, ...TAIL])}))`).res;

describe('the Learnings cutter reads the whole talk, not two captions at a time', () => {
  // the reviewer's sentences, each split so the line needs three pieces; the piece it starts on is counted after LEAD
  const SPLIT = [
    [['So the latest in my', '[BLANK_AUDIO]', 'diary is that'], 0],
    [['the learnings from', 'my', 'diary today'], 0],
    [['So the lessons', 'I have', 'for today'], 0],
    [['the latest in my', 'diary of the', 'day is'], 0],
    [['so the learnings', '[BLANK_AUDIO]', 'kind of my diary today are'], 2],
    [['So the learnings from my', '(wind blowing)', 'diary today'], 0],
    [['So the latest in my [inaudible]', 'diary is that'], 0],
    [['the learnings from my (wind', 'blowing) diary today are'], 0],
  ];
  for (const [middle, piece] of SPLIT) {
    it(`BACK-TEST: "${middle.join(' | ')}" is cut`, () => {
      const w = window(middle);
      expect(w).not.toBe(null);
      expect(w[0]).toBe((LEAD.length + piece) * 10);
    });
  }

  it('BACK-TEST: the show name with a noise note in it is not a Learnings section (2072)', () => {
    expect(py(`res = render.lfmd_window(segs(["So consecutive day 2072", "[BLANK_AUDIO]", "of the diary cover on printer", "and today I talk about rest", "see you tomorrow"]))`).res).toBe(null);
  });

  it('CONTROL: a line inside one piece, or over two, starts where it always did', () => {
    expect(window(['So the learnings from my diary today are'])[0]).toBe(30);
    expect(window(['so the latest', 'in my diary is that'])[0]).toBe(40);        // the piece that holds "in my diary"
    expect(window(['so the learnings', 'from my diary today'])[0]).toBe(40);
    expect(window(['So the learnings', 'from my dive for today are'])[0]).toBe(40);   // 1964 and 2032, as stored
    expect(window(['the learning from', 'a diet today is that'])[0]).toBe(30);   // 2060: starts at "learning"
    // "of my diary" straight after "kind" is an aside on its own, so the clip starts where the line does (review, 2 Oct 2026)
    expect(window(['the learnings that I kind', 'of my diary today are'])[0]).toBe(30);
  });

  it('CONTROL: no diary line, no window; and the last mention wins', () => {
    expect(window(['nothing about that section here'])).toBe(null);
    expect(window(['from my diary earlier on', 'some other talk in between', 'so the learnings from my diary today'])[0]).toBe(50);
  });

  it('the gate and the cutter give the same answer on the same talk, noise notes and all', () => {
    const r = py(`
import random
random.seed(7)
said = ["So the latest in my diary is that you should rest", "the learnings from my diary today are simple", "so the lessons I have for today are these",
        "the learning from a diet today is that problems pass", "So the next thing for my dive for today is patience", "the learnings of my dive today are clear"]
not_said = ["So consecutive day 2090 of the diary cover on printer and today", "welcome back to day 2,072 of the diary of a Runpreneur",
            "this vlog is kind of my diary so to speak for everyone", "when you dive deeper into it you learn a lot"]
wrong, yes = [], 0
for line in said + not_said:
    words = line.split()
    for _ in range(150):
        cuts = sorted(random.sample(range(1, len(words)), random.randint(1, min(4, len(words) - 1))))
        parts = [" ".join(words[a:b]) for a, b in zip([0] + cuts, cuts + [len(words)])]
        pieces = []
        for p in parts: pieces += [p] + ([random.choice(["[BLANK_AUDIO]", "(wind blowing)", "[inaudible]"])] if random.random() < 0.3 else [])
        if len(pieces) > 1 and random.random() < 0.3:      # a note whisper split across two captions
            j = random.randrange(len(pieces) - 1); pieces[j] += " (wind"; pieces[j + 1] = "blowing) " + pieces[j + 1]
        talk = ["welcome back", "some talk"] + pieces + ["and more", "thank you as always"]
        gate, cutter = render.lfmd_said("\\n".join(talk)), render.lfmd_window(segs(talk)) is not None
        yes += gate
        if gate != cutter or gate != (line in said): wrong.append([line, pieces, gate, cutter])
res = {"tried": 150 * len(said + not_said), "said": yes, "wrong": len(wrong), "first": wrong[:2]}`);
    expect(r.res.tried).toBe(1500);
    expect(r.res.wrong).toBe(0);
    expect(r.res.said).toBe(900);
  });
});

describe('the cutter records whether the Learnings clip closes the talk', () => {
  const closes = (lines) => py(`
s = segs(${J(lines)})
w = render.lfmd_window(s)
res = {"window": w, "closes": render.lfmd_closes_talk(s, w)}`).res;
  const TALK = ['Welcome back to the run', 'today I talk about rest', 'so the learnings from my diary today', 'are that you should rest more'];

  it('a clip that runs to the sign-off, with silence and a stray word after it, closes the talk', () => {
    const r = closes([...TALK, 'thank you as always', ...Array(10).fill('[BLANK_AUDIO]'), '(wind blowing)', 'Thank you.', '(wind blowing)', '[BLANK_AUDIO]']);
    expect(r.window).toEqual([20, 50]);
    expect(r.closes).toBe(true);
  });

  it('a sign-off phrase said in the middle, with the talk carrying on after it, does not', () => {
    const more = Array(8).fill('and here is some more of the talk that follows');
    const r = closes([...TALK, 'so stay positive whatever happens', ...more]);
    expect(r.window).toEqual([20, 50]);
    expect(r.closes).toBe(false);
  });

  it('a clip with no sign-off after it, or no clip at all, does not', () => {
    expect(closes([...TALK, 'and that is all for now']).closes).toBe(false);
    expect(closes(['Welcome back to the run', 'thank you as always'])).toEqual({ window: null, closes: false });
  });
});

describe('an aside stays an aside, however the captions split it', () => {
  it('CONTROL: "kind of for my diary" and "kind of in my diary" are not the diary line, for the gate or the cutter', () => {
    const r = py(`
texts = ["this vlog is kind of for my diary so to speak", "it is kind of in my diary really", "this vlog is kind of my diary so to speak",
         "welcome back to day 2072 of the diary cover on printer", "consecutive day 2,072 of the diary of a Runpreneur"]
res = [[render.lfmd_said(t), render.lfmd_window(segs(["welcome back", "some talk"] + t.split(" of ", 1)[0:1] + ["of " + t.split(" of ", 1)[1], "thank you as always"]))] for t in texts]`).res;
    expect(r).toEqual(Array(5).fill([false, null]));
  });
});

describe('the output gate reads the talk the way the cutter does', () => {
  it('BACK-TEST: the show name with a noise note in the transcript is not "he said the diary line"', () => {
    const r = py(`res = gate_for(None, 520.8, transcript="So consecutive day 2090\\n[BLANK_AUDIO]\\nof the diary cover on printer, and today I talk about rest.")`).res;
    expect(r.failures).toEqual([]);
    expect(r.passed.find(([n]) => n === 'Learnings section')[1]).toContain('by design');
  });

  it('BACK-TEST: the diary line with a noise note inside it, and no clip, is refused (the note used to hide it)', () => {
    const r = py(`res = gate_for(None, 520.8, transcript="So the latest in my\\n[BLANK_AUDIO]\\ndiary is that you should rest.")`).res;
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toEqual(['Learnings clip (captions)', '0 s; diary phrase found in the transcript']);
  });
});

describe('the output gate refuses a Learnings clip that starts in the wrong part of the episode', () => {
  it('BACK-TEST: 2081 as it shipped (clip from 1:16 of an 8:41 episode) is refused, and the card says what to do', () => {
    const r = py('res = gate_for([75.8, 254.8], 520.8)').res;
    expect(r.ok).toBe(false);
    expect(r.failures.map(([n]) => n)).toEqual(['Learnings clip position']);
    expect(r.failures[0][1]).toContain('starts at 1:16 of the 8:41 episode (14%)');
    expect(r.failures[0][1]).toContain('render.py redo --day 2081 --only lfmd');
    expect(r.failures[0][1]).toContain('qa.py accept-early --day 2081');
  });

  it('CONTROL: the earliest good clip on the stored days (2055, 54% in) passes, with the position on the card', () => {
    const r = py('res = gate_for([238.88, 415.08], 438.0)').res;
    expect(r.failures).toEqual([]);
    expect(r.passed.find(([n]) => n === 'Learnings clip position')[1]).toBe('starts at 3:59 of the 7:18 episode (54%)');
  });

  it('BACK-TEST: a recording left running after the sign-off does not refuse a good clip (4:30 of a 16:00 clip, sign-off at 6:40)', () => {
    const r = py('res = gate_for([270.0, 400.0], 960.0, entry={"lfmd_closes_talk": True})').res;
    expect(r.failures).toEqual([]);
    expect(r.passed.find(([n]) => n === 'Learnings clip position')[1]).toBe('starts at 4:30 of the 6:40 talk (67%)');
  });

  it('CONTROL: the same clip is refused when the render did not record that it closes the talk', () => {
    for (const flag of ['False', '1', '"yes"', 'None']) {
      const r = py(`res = gate_for([270.0, 400.0], 960.0, entry={"lfmd_closes_talk": ${flag}})`).res;
      expect(r.failures.map(([n]) => n)).toEqual(['Learnings clip position']);
      expect(r.failures[0][1]).toContain('starts at 4:30 of the 16:00 episode (28%)');
    }
  });

  it('CONTROL: a window that ends past the clip is not a talk length, so the clip length stays the measure', () => {
    const r = py('res = gate_for([75.8, 600.0], 520.8, entry={"lfmd_closes_talk": True})').res;
    expect(r.failures.map(([n]) => n)).toEqual(['Learnings clip position']);
    expect(r.failures[0][1]).toContain('starts at 1:16 of the 8:41 episode (14%)');
  });

  it('CONTROL: measured against its own end, 2081 is still refused', () => {
    const r = py('res = gate_for([75.8, 254.8], 520.8, entry={"lfmd_closes_talk": True})').res;
    expect(r.failures.map(([n]) => n)).toEqual(['Learnings clip position']);
    expect(r.failures[0][1]).toContain('starts at 1:16 of the 4:15 talk (29%)');
  });

  it('a clip just under the line is refused and says 39%, never a rounded-up 40%', () => {
    const r = py('res = gate_for([39.99, 200.0], 100.0)').res;
    expect(r.ok).toBe(false);
    expect(r.failures[0][1]).toContain('(39%)');
    expect(py('res = gate_for([29.0, 90.0], 100.0)').res.failures[0][1]).toContain('(29%)');
    expect(py('res = gate_for([40.0, 90.0], 100.0)').res.ok).toBe(true);
  });

  it('BACK-TEST: a render that recorded no episode length is still checked, against the podcast length', () => {
    const r = py('res = gate_for([75.8, 254.8], 520.8, recorded=False)').res;
    expect(r.failures.map(([n]) => n)).toEqual(['Learnings clip position']);
    expect(r.failures[0][1]).toContain('of the 8:41 episode');
  });

  it('an early clip accepted by hand passes; the acceptance does not carry to a different cut', () => {
    const yes = py('res = gate_for([75.8, 254.8], 520.8, accepted=[75.8, 254.8])').res;
    expect(yes.ok).toBe(true);
    expect(yes.passed.find(([n]) => n === 'Learnings clip position')[1]).toContain('accepted by hand');
    expect(py('res = gate_for([60.0, 240.0], 520.8, accepted=[75.8, 254.8])').res.ok).toBe(false);
  });

  it('a hand-edited acceptance of the wrong shape refuses the clip, it does not crash the night', () => {
    for (const shape of ['True', '1', '75.8', '"yes"']) {
      const r = py(`res = gate_for([75.8, 254.8], 520.8, accepted=${shape})`).res;
      expect(r.failures.map(([n]) => n)).toEqual(['Learnings clip position']);
    }
  });

  it('a ledger window or length nobody can read refuses the clip and says so, it does not crash the night', () => {
    for (const w of [75.8, true, '75.8,254.8', { start: 75.8 }, [null, 254.8], [600, 700], [75.8]]) {
      const r = py(`res = gate_for([75.8, 254.8], 520.8, entry={"lfmd_window": ${J(w)}})`).res;
      expect(r.failures.map(([n]) => n)).toEqual(['Learnings clip position']);
      expect(r.failures[0][1]).toContain('cannot be checked');
    }
    for (const d of ['nan', 'inf', '1e999', 'abc', true]) {
      const r = py(`res = gate_for([75.8, 254.8], 520.8, entry={"duration": ${J(d)}})`).res;
      expect(r.failures.map(([n]) => n)).toEqual(['Learnings clip position']);
      expect(r.failures[0][1]).toContain('cannot be checked');
    }
    const s = py(`res = gate_for([75.8, 254.8], 520.8, entry={"lfmd_window": ["75.8", 254.8]})`).res;   // a number typed as text still reads
    expect(s.failures[0][1]).toContain('starts at 1:16 of the 8:41 episode (14%)');
  });

  it('accept-early records the window on the day\'s rendered episode and nothing else', () => {
    const r = py(`
led = {"a.insv": {"episode": 2081, "role": "episode", "status": "rendered", "lfmd_window": [75.8, 254.8], "duration": 520.8},
       "b.insv": {"episode": 2081, "role": "teaser", "status": "rendered"}, "c.insv": {"episode": 2082, "role": "episode", "status": "rendered", "lfmd_window": [300.0, 400.0]}}
saved = []
qa.accept_early(2081, led, save=lambda l: saved.append(json.loads(json.dumps(l))))
res = {"saved": saved}`).res;
    expect(r.saved.length).toBe(1);
    expect(r.saved[0]['a.insv'].lfmd_early_ok).toEqual([75.8, 254.8]);
    expect(r.saved[0]['b.insv'].lfmd_early_ok).toBe(undefined);
    expect(r.saved[0]['c.insv'].lfmd_early_ok).toBe(undefined);
  });

  it('accept-early refuses a day with no clip, and a day that is waiting to render again', () => {
    const refusal = (entry) => py(`
saved = []
try:
    qa.accept_early(2081, {"c.insv": ${J(entry)}}, save=saved.append); res = "accepted"
except SystemExit as e:
    res = str(e) + (" SAVED" if saved else "")`).res;
    expect(refusal({ episode: 2081, role: 'episode', status: 'rendered', lfmd_window: null })).toBe('episode 2081 has no Learnings clip to accept');
    expect(refusal({ episode: 2081, role: 'episode', status: 'rendered', lfmd_window: 75.8 })).toBe('episode 2081 has no Learnings clip to accept');
    expect(refusal({ episode: 2081, role: 'episode', status: 'new', lfmd_window: [75.8, 254.8] })).toBe('episode 2081 is waiting to render again (new): accept its clip once that has run');
  });

  it('BACK-TEST: a Learnings rebuild drops the acceptance, so the clip it cuts is watched again', () => {
    const r = py(`
import approval
tmp = tempfile.mkdtemp(); clip = os.path.join(tmp, 'c.insv'); open(clip, 'w').write('x')
led = {"c.insv": {"episode": 2081, "role": "episode", "status": "rendered", "local": clip, "date": "2026-02-10", "drive_id": "d", "lfmd_window": [75.8, 254.8], "lfmd_early_ok": [75.8, 254.8]}}
saved = []
watch.load_ledger = lambda: led; watch.save_ledger = lambda l: saved.append(json.loads(json.dumps(l)))
srt = os.path.join(tmp, 's.srt'); open(srt, 'w').write("1\\n00:00:00,000 --> 00:00:05,000\\nSo the learnings from my diary today are that\\n\\n2\\n00:00:30,000 --> 00:00:40,000\\nsee you tomorrow\\n")
render.transcribe = lambda c, w: ("text", srt)
render.render_masters = lambda *a, **k: {}
render.build_outputs = lambda *a, **k: {"lfmd": "l", "lfmd_yt": "y", "lfmd_srt": "s"}
filed = []
def publish(*a, **k):
    filed.append("lfmd_early_ok" in saved[-1]["c.insv"] if saved else "nothing saved yet")
    return ("f", {"lfmd": "L", "lfmd_yt": "Y", "lfmd_srt": "S"})
render.publish_to_drive = publish
render.find_or_create_record = lambda *a, **k: ("rec1", "found")
watch._airtable = lambda *a, **k: {}
render.release_hold = lambda d: None
approval.load_state = lambda: {}
render.redo_lfmd(2081)
res = {"window": list(led["c.insv"]["lfmd_window"]), "accepted": led["c.insv"].get("lfmd_early_ok"), "on_disk_when_filed": filed, "closes": led["c.insv"].get("lfmd_closes_talk")}`).res;
    expect(r.window).toEqual([0, 40]);
    expect(r.closes).toBe(true);                        // it runs to "see you tomorrow" and nothing follows
    expect(r.accepted).toBe(null);
    expect(r.on_disk_when_filed).toEqual([false]);      // the saved ledger had already lost the acceptance
  });
});
