// Five rules Kevin kept correcting on episode cards, moved from his notes into the scripts (16 Nov 2026).
//
// His notes on sent-back cards were stored as lessons that no script read: 54 of them sat under the wrong heading
// until 15 Nov, and the ones about the video could never have reached the code anyway, because render.py, qa.py and
// platform_copy.py decide those things and read no lesson. The estate review's lessons sort named five rules a
// script decides (kevin-hq "2026-11-13 estate review/10-lessons-sort", lines 34, 43, 45, 52 and 59). This file
// drives the code for each one on INVENTED episode data: no real video, no network, no Airtable, no Drive.
//
//   line 59  the jingle time in his own wording ("at exactly 27 seconds", "at 00:00:26", "at 00:00:26s")
//   line 34  the Learnings clip start he gives, put on the recording's clock and used; a long talk with no clip held
//   line 43  a YouTube or blog SEO title never starts with the day number
//   line 45  no Summary clip: the card says where the engine looked and what short clips it found
//   line 52  stabilisation shake: NOT built, nothing the pipeline keeps measures it (see the PR)
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CE = path.resolve(__dirname, '..', 'scripts', 'content-engine');
const J = (x) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

function py(body, { harness = '' } = {}) {
  const script = String.raw`
import sys, os, io, json, tempfile, contextlib, types, subprocess, datetime as dt
sys.path.insert(0, ${JSON.stringify(CE)})
import render, watch, qa, approval, platform_copy
${harness}
out, err = io.StringIO(), io.StringIO(); res = None
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
${body.split('\n').map((l) => '    ' + l).join('\n')}
print(json.dumps({"res": res, "out": out.getvalue(), "err": err.getvalue()}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8', cwd: CE }));
}

// ---------------------------------------------------------------- line 59, the jingle
describe('line 59: the jingle time Kevin gives, in the words he actually used', () => {
  it('reads "at exactly 27 seconds", "at 00:00:26" and "at 00:00:26s" (1808 on 20 Oct, 2113 on 2 and 5 Nov)', () => {
    const r = py(`res = [render.jingle_cut_from(n) for n in ${J([
      'The intro jingle should go in at exactly 27 seconds of the full video.',
      'The intro jingle should happen at 00:00:26 of the full episode.',
      'Try again - the instructions are pretty clear - The intro jingle should happen at 00:00:26s of the full episode.',
    ])}]`).res;
    expect(r).toEqual([[true, 27], [true, 26], [true, 26]]);
  });

  it('CONTROL: the wordings that already worked still work, and a pause length is still not a cut', () => {
    const r = py(`res = [render.jingle_cut_from(n) for n in ${J([
      'The intro jingle should happen at 26 seconds of the full episode. It is still not in the right place.',
      'The jingle is still in the wrong place. It should appear at about 33 seconds on this episode, but you just need to look for that 5-second pause.',
      'The jingle still in the wrong place. I leave a pause after the intro of maybe 5 seconds.',
    ])}]`).res;
    expect(r).toEqual([[true, 26], [true, 33], [true, null]]);
  });

  it('a figure in a sentence about the Learnings clip never moves the jingle', () => {
    // The old reader searched the whole note once any point named the jingle, so the clip length below became a
    // jingle cut at 45 s. With m:ss now read too, 4:37 would have passed the 5-minute cold-open limit as well.
    const r = py(`res = [render.jingle_cut_from(n) for n in ${J([
      'The intro jingle is still in the wrong place. Also the learnings clip cuts off at 45 seconds, so it is too short.',
      'The intro jingle is still in the wrong place. The learnings from my diary start at 4:37 on the full episode.',
    ])}]`).res;
    expect(r).toEqual([[true, null], [true, null]]);
  });

  it('redo_day puts his 00:00:26s on the ledger instead of dropping the stored cut', () => {
    const r = py(`
tmp = tempfile.mkdtemp()
note = "Try again - the instructions are pretty clear - The intro jingle should happen at 00:00:26s of the full episode."
state = {"2113": {"task": "recFAKE0000002113", "verdict": "changes", "feedback": note, "synced": "2026-11-05T09:00:00"}}
led = {"VID_A.insv": {"day": 2113, "episode": 2113, "role": "episode", "status": "rendered", "duration": 600.0, "intro_at_override": 41.0}}
rp = os.path.join(tmp, "r.md"); open(rp, "w").write("- " + note + " → the jingle goes where the note says\\n")
watch.save_ledger = lambda l: None
render.redo_day(2113, rp, "test", ledger=led, state=state, root=tmp, today=dt.date(2026, 11, 5), last_night=None, running=False)
res = led["VID_A.insv"].get("intro_at_override")`).res;
    expect(r).toBe(26);
  });
});

// ---------------------------------------------------------------- line 34, the Learnings clip
describe('line 34: the Learnings clip start Kevin gives is read, put on the right clock, and used', () => {
  it('reads every way he wrote it, on the sentence after the one that names the clip too', () => {
    const r = py(`res = [render.learnings_time_from(n)[1] for n in ${J([
      'Learnings from my diary is at exactly 4 minutes and 37 seconds of the main episode.',
      'Learnings from my diary is wrong. It should kick in at around 4:32 of the main episode.',
      'Learning from my diary is at 4m50s of the episode - please sort and resubmit for approval',
      'There is a learnings for my diary, and it\'s around 5 minutes and 15 seconds in.',
      'There was a "Learnings for my diary" which was at about 9:50 into the episode.',
    ])}]`).res;
    expect(r).toEqual([277, 272, 290, 315, 590]);
  });

  it('never guesses: two times in one note, a length, or no time at all give nothing', () => {
    const r = py(`res = [render.learnings_time_from(n) for n in ${J([
      '"Learnings from my diary" is not correct. I think it kicked in at about 4:30 on the main episode. I gave you feedback on a different episode about 6 minutes and 30 seconds in.',
      'The learnings clip is about 2 minutes long.',
      'Learning from my diary is still not in the right place',
      'The intro jingle should happen at 26 seconds of the full episode.',
    ])}]`).res;
    expect(r).toEqual([[true, null], [true, null], [true, null], [false, null]]);
  });

  it('his time is on the full episode, so it moves back by the jingle once past the cut (the 7 s 2121 lost)', () => {
    const r = py(`res = [render.master_time(277.0, 25.65), render.master_time(20.0, 25.65), render.master_time(28.0, 25.65), render.master_time(277.0, None)]`).res;
    expect(r).toEqual([270, 20, 25.65, null]);
  });

  it('the clip from his start ends where the detector would end it, and the two cannot drift apart', () => {
    const r = py(`
segs = [(0, 5, "welcome back"), (381.0, 388.0, "So ultimately, learning from an hour today, that the hills are hard"),
        (440.0, 450.0, "keep it in mind"), (495.0, 501.0, "stay positive, see you tomorrow")]
res = [list(render.lfmd_window(segs)), list(render.lfmd_window_at(segs, 381.0)), list(render.lfmd_window_at(segs, 382.4)),
       list(render.lfmd_window_at(segs, 384.0)), render.lfmd_window_at(segs, 700.0)]`).res;
    expect(r).toEqual([[381, 501], [381, 501], [381, 501], [384, 501], null]);
  });

  it('redo_day parks his start on the recording\'s clock for the night render', () => {
    const r = py(`
tmp = tempfile.mkdtemp()
note = "Learnings from my diary is at exactly 4 minutes and 37 seconds of the main episode."
state = {"2121": {"task": "recFAKE0000002121", "verdict": "changes", "feedback": note, "synced": "2026-10-31T09:00:00"}}
led = {"VID_A.insv": {"day": 2121, "episode": 2121, "role": "episode", "status": "rendered", "duration": 600.0, "intro_at": 25.65,
                      "lfmd_window": [276.74, 350.99], "lfmd_window_by": "operator"},
       "VID_B.insv": {"day": 2121, "episode": 2121, "role": "teaser", "status": "rendered", "duration": 40.0}}
rp = os.path.join(tmp, "r.md"); open(rp, "w").write("- " + note + " → the clip is placed at that time\\n")
watch.save_ledger = lambda l: None
render.redo_day(2121, rp, "test", ledger=led, state=state, root=tmp, today=dt.date(2026, 10, 31), last_night=None, running=False)
res = [led["VID_A.insv"].get("lfmd_at_keep"), "lfmd_at_keep" in led["VID_B.insv"], led["VID_A.insv"]["status"]]`).res;
    expect(r).toEqual([{ full: 277, master: 270 }, false, 'new']);
  });

  it('BACK-TEST: the night render places the clip at his time, over the detector AND over a window kept by hand', () => {
    // A transcript whose Learnings line has no learnings word in it ("so the latest word I say", 2122), so the
    // detector finds nothing; Kevin's 3:27 on the full episode, jingle cut at 20 s, is 200 s on the recording.
    const r = py(`
talk = ["some of the talk goes here"] * 200 + ["so the latest word I say is rest"] + ["that you should rest more"] * 79 + ["thank you as always, see you tomorrow"] + ["[BLANK_AUDIO]"] * 3
def cues(lines): return "".join("%d\\n00:%02d:%02d,000 --> 00:%02d:%02d,900\\n%s\\n\\n" % (i + 1, i // 60, i % 60, i // 60, i % 60, t) for i, t in enumerate(lines))
tmp = tempfile.mkdtemp(); clip = os.path.join(tmp, "VID_X.insv"); open(clip, "w").write("x")
def transcribe(c, w):
    s = os.path.join(w, "transcript.srt"); open(s, "w").write(cues(talk)); return " ".join(talk), s
class P:
    def __init__(self, o): self.stdout, self.returncode = o, 0
real = subprocess.run
subprocess.run = lambda cmd, *a, **k: P("400") if os.path.basename(cmd[0]) == "ffprobe" else real(cmd, *a, **k)
render.transcribe = transcribe
seen = {}
def stop(*a, **k): raise RuntimeError("stopped after the window was decided")
render.clip_role = lambda d, has: seen.setdefault("role_asked", True) and "episode"
render.find_pans_for = stop
sys.modules["pointing"] = types.SimpleNamespace(pans_arg=lambda p: "")
watch.save_ledger = lambda l: None
watch.spoken_day = lambda t: 2122
watch.resolve_episode = lambda d, s, prev_day_has_talk=False: (2122, "test")
out_ = []
for seed in ({"lfmd_at_keep": {"full": 207.0, "master": 200.0}},
             {"lfmd_at_keep": {"full": 207.0, "master": 200.0}, "lfmd_window_keep": [150.0, 250.0]},
             {"lfmd_window_keep": [150.0, 250.0]},
             {"lfmd_none_ok": "2026-11-16"},
             {"lfmd_at_keep": {"full": 900.0, "master": 893.0}},
             {"lfmd_at_keep": {"full": 107.0, "master": 100.0}, "lfmd_window_keep": [150.0, 250.0]},
             {"lfmd_at_keep": {"full": 205.0, "master": 198.0}}):
    led = {"VID_X.insv": dict({"local": clip, "date": "2026-02-19", "day": 2122, "status": "pulled"}, **seed)}
    try: render.process("VID_X.insv", led, keep=True)
    except RuntimeError: pass
    e = led["VID_X.insv"]
    out_.append([e["lfmd_window"], e["lfmd_window_by"], e.get("lfmd_from_note"), "lfmd_at_keep" in e, "lfmd_none_ok" in e, (e.get("lfmd_note_unused") or {}).get("full")])
res = out_`).res;
    expect(r[0]).toEqual([[200, 280.9], 'operator', { full: 207, master: 200, window: [200, 280.9] }, false, false, null]);
    expect(r[1]).toEqual([[200, 280.9], 'operator', { full: 207, master: 200, window: [200, 280.9] }, false, false, null]);
    expect(r[2]).toEqual([[150, 250], 'operator', null, false, false, null]);   // CONTROL: the kept window as before
    // the detector hears nothing here, and a re-render drops "watched, no section", so the new render is judged again
    expect(r[3]).toEqual([null, 'detector', null, false, false, null]);
    // a time past the end of the recording is said and dropped, never a failed render
    expect(r[4]).toEqual([null, 'detector', null, false, false, 900]);
    // 2132: a time with no learnings word near it does not overrule a clip already found, and the ledger says why
    expect(r[5]).toEqual([[150, 250], 'operator', null, false, false, 107]);
    // 2096: "about" 3 s after the line, so the clip starts on the line itself
    expect(r[6]).toEqual([[200, 280.9], 'operator', { full: 205, master: 198, window: [200, 280.9] }, false, false, null]);
  });

  it('the Learnings rebuild takes his time off the sent-back card, and its receipt speaks the full episode\'s clock', () => {
    const r = py(`
tmp = tempfile.mkdtemp(); clip = os.path.join(tmp, "c.insv"); open(clip, "w").write("x")
note = "Learnings from my diary is at exactly 4 minutes and 37 seconds of the main episode."
led = {"c.insv": {"episode": 2121, "role": "episode", "status": "rendered", "local": clip, "date": "2026-02-02", "drive_id": "d",
                  "duration": 600.0, "intro_at": 25.65, "lfmd_none_ok": "2026-11-16"}}
watch.load_ledger = lambda: led; watch.save_ledger = lambda l: None
srt = os.path.join(tmp, "s.srt")
open(srt, "w").write("1\\n00:04:20,000 --> 00:04:29,000\\nhow dangerous these birds can be. So ultimately, the\\n\\n"
                     "2\\n00:04:29,700 --> 00:04:35,000\\nlatest on my diet for this day, are that if\\n\\n"
                     "3\\n00:05:40,000 --> 00:05:43,000\\nstay positive, see you tomorrow\\n")
render.transcribe = lambda c, w: ("text", srt)
render.render_masters = lambda *a, **k: {}
render.title_from_transcript = lambda t: "t"
render.build_outputs = lambda *a, **k: {"lfmd": "l", "lfmd_yt": "y", "lfmd_srt": "s"}
render.publish_to_drive = lambda *a, **k: ("f", {"lfmd": "L", "lfmd_yt": "Y", "lfmd_srt": "S"})
render.find_or_create_record = lambda *a, **k: ("rec1", "found")
watch._airtable = lambda *a, **k: {}
render.release_hold = lambda d: None
approval.load_state = lambda: {"2121": {"task": "recFAKE0000002121", "verdict": "changes", "feedback": note}}
sent = []
approval.refresh_card = lambda day, receipt=None: sent.append(open(receipt).read())
render.redo_lfmd(2121)
res = {"window": led["c.insv"]["lfmd_window"], "by": led["c.insv"]["lfmd_window_by"], "note": led["c.insv"].get("lfmd_from_note"), "receipt": sent,
       "release": "lfmd_none_ok" in led["c.insv"]}`).res;
    expect(r.window).toEqual([269.7, 343]);
    expect(r.by).toBe('operator');
    expect(r.note.window).toEqual([269.7, 343]);
    expect(r.receipt[0]).toContain('rebuilt from 4:36 to 5:50 of the full episode');
    expect(r.release).toBe(false);                     // a rebuilt clip is judged again
  });

  it('the hourly receipt gives the full episode\'s clock, and says when his time was used or why not', () => {
    const r = py(`
text = render.sent_back_receipt("Learnings from my diary is at exactly 4 minutes and 37 seconds of the main episode.")
base = {"episode": 2121, "role": "episode", "status": "rendered", "intro_at": 25.65, "lfmd_window": [269.7, 343.0]}
used = dict(base, lfmd_from_note={"full": 277.0, "master": 270.0, "window": [269.7, 343.0]})
unused = dict(base, lfmd_note_unused={"full": 290.0, "why": "no Learnings line is heard within 6 s of your time, so the clip already found stands"})
card = {"redo_lfmd_before": {"window": [276.74, 350.99]}}
res = [render.concrete_receipt(text, 2121, {"a": used}, card), render.concrete_receipt(text, 2121, {"a": unused}, card)]`).res;
    expect(r[0]).toContain('now runs from 4:36 to 5:50 of the full episode, starting at the time on your note (it ran from 4:43 to 5:57 of the full episode before)');
    expect(r[1]).toContain('now runs from 4:36 to 5:50 of the full episode (your 4:50 was not used: no Learnings line is heard within 6 s of your time');
  });

  it('the output gate takes his time as the evidence for an early clip, only while it is the same window', () => {
    const r = py(`
ep = {"lfmd_window": [270.0, 343.0], "duration": 900.0, "lfmd_window_by": "operator"}
res = [qa.lfmd_position(dict(ep, lfmd_from_note={"full": 277.0, "master": 270.0, "window": [270.0, 343.0]}), 0, 2121)[:2],
       qa.lfmd_position(dict(ep, lfmd_from_note={"full": 277.0, "master": 270.0, "window": [300.0, 380.0]}), 0, 2121)[:2],
       qa.lfmd_position(ep, 0, 2121)[:2]]`).res;
    expect(r).toEqual([[true, true], [false, true], [false, true]]);
  });
});

// The gate on invented files: ffprobe is replaced by a table of lengths, so no media is made or read.
const GATE = String.raw`
SECONDS = {}
qa.seconds = lambda p, **k: (SECONDS.get(os.path.basename(p or ""), 0.0) if p else 0.0)
def gate_day(entry, captions, ledger_extra=None, transcript="no section named today"):
    tmp = tempfile.mkdtemp()
    def mk(name, body="media", mode="w"):
        p = os.path.join(tmp, name); open(p, mode).write(body); return p
    srt = "".join("%d\n%s --> %s\n%s\n\n" % (i + 1, render.srt_ts(i * 5), render.srt_ts(i * 5 + 4), t) for i, t in enumerate(captions))
    files = {"full": mk("full.mp4"), "full_yt": mk("full_yt.mp4"), "podcast": mk("pod.mp3"), "lfmd": "", "lfmd_yt": "", "summary": "",
             "full_srt": mk("full.srt", srt), "lfmd_srt": "", "thumb": mk("t.png", b"0" * 30000, "wb"), "transcript": mk("tr.txt", transcript)}
    n = len(captions) * 5
    SECONDS.update({"full.mp4": n + 7.0, "full_yt.mp4": n + 7.0, "pod.mp3": float(n)})
    ep = dict({"episode": 2187, "role": "episode", "status": "rendered", "lfmd_window": None, "duration": float(n),
               "date": "2026-05-27", "path": "/raw/19 May 26 - 2 June 26/VID_20260527_194356_00_063.insv"}, **entry)
    led = dict({"VID_20260527_194356_00_063.insv": ep}, **(ledger_extra or {}))
    ok, failures, passed = qa.gate(2187, led, files)
    return {"ok": ok, "failures": failures, "passed": passed}
`;
const TALK = Array(60).fill('and that is how the day went for me');
const SIGNED = [...TALK, 'so anyway that is it for me', 'stay positive, stay happy and I will see you again tomorrow'];

describe('line 34: a long episode with no Learnings clip is held when the talk runs on to his sign-off', () => {
  it('BACK-TEST: no clip, no diary line heard, sign-off reached: HELD (2086, 2095, 2122, 2130 reached him like this)', () => {
    const r = py(`res = gate_day({}, ${J(SIGNED)})`, { harness: GATE }).res;
    expect(r.ok).toBe(false);
    expect(r.failures.map(([n]) => n)).toEqual(['Learnings section']);
    expect(r.failures[0][1]).toContain('runs on to your sign-off at 5:05');
    expect(r.failures[0][1]).toContain('qa.py accept-no-learnings --day 2187');
  });

  it('CONTROL: a recording that stops before the sign-off (2082, 2183) is a note on the card, not a hold', () => {
    const r = py(`res = gate_day({}, ${J(TALK)})`, { harness: GATE }).res;
    expect(r.ok).toBe(true);
    expect(r.passed.find(([n]) => n === 'Learnings section')[1]).toContain('ends before your sign-off');
  });

  it('captions it could not read are NOT CHECKED, never "the recording ends before your sign-off"', () => {
    const r = py(`res = list(qa.no_learnings_check({"episode": 2187, "lfmd_window": None}, "/nonexistent/Episode_2187_Full_Episode_YT.srt", 2187))`).res;
    expect(r[0]).toBe(false);
    expect(r[1]).toBe(false);
    expect(r[2]).toMatch(/^NOT CHECKED: .*could not be read/);
  });

  it('CONTROL: a sign-off said early in the talk is not the end of it, so no hold', () => {
    const early = ['stay positive everyone, here we go', ...TALK];
    const r = py(`res = gate_day({}, ${J(early)})`, { harness: GATE }).res;
    expect(r.ok).toBe(true);
  });

  it('watched and ruled to have none: released, and the release refuses a day it does not fit', () => {
    const r = py(`
res = {"gate": gate_day({"lfmd_none_ok": "2026-11-16"}, ${J(SIGNED)})["ok"]}
led = {"a": {"episode": 2187, "role": "episode", "status": "rendered", "lfmd_window": None}}
saved = []
res["set"] = qa.accept_no_learnings(2187, led, save=saved.append, today=dt.date(2026, 11, 16))
res["saved"] = len(saved)
for bad in ({"lfmd_window": [200, 300]}, {"status": "new"}):
    try: qa.accept_no_learnings(2187, {"a": dict(led["a"], **bad)}, save=saved.append); res.setdefault("refused", []).append("accepted")
    except SystemExit as ex: res.setdefault("refused", []).append(str(ex))`, { harness: GATE }).res;
    expect(r.gate).toBe(true);
    expect(r.set).toBe('2026-11-16');
    expect(r.saved).toBe(1);
    expect(r.refused[0]).toContain('has a Learnings clip');
    expect(r.refused[1]).toContain('waiting to render again');
  });

  it('the gate reads the rendered recording, not a failed second one listed first (2107, 2108, 2109)', () => {
    const r = py(`
led = {"VID_1.insv": {"episode": 2187, "role": "episode", "status": "failed", "lfmd_window": None},
       "VID_2.insv": {"episode": 2187, "role": "episode", "status": "rendered", "lfmd_window": [200, 300]}}
res = qa.ledger_entries(2187, led)[0]["lfmd_window"]`, { harness: GATE }).res;
    expect(r).toEqual([200, 300]);
  });
});

// ---------------------------------------------------------------- line 45, the Summary clip
describe('line 45: no Summary clip, so the card says where the engine looked and what is there', () => {
  it('names the folders, the recording day and the next, and every short clip on them', () => {
    const r = py(`
extra = {"VID_20260528_071000_00_064.insv": {"date": "2026-05-28", "hms": "071000", "name": "VID_20260528_071000_00_064.insv", "status": "new",
             "size": 420000000, "path": "/raw/19 May 26 - 2 June 26/VID_20260528_071000_00_064.insv"},
         "VID_20260528_180000_00_065.insv": {"date": "2026-05-28", "name": "VID_20260528_180000_00_065.insv", "status": "rendered", "role": "episode",
             "episode": 2188, "duration": 610.0, "path": "/raw/19 May 26 - 2 June 26/VID_20260528_180000_00_065.insv"}}
res = gate_day({"lfmd_window": None, "lfmd_none_ok": "2026-11-16"}, ${J(SIGNED)}, ledger_extra=extra)
res = [d for n, d in res["passed"] if n == "teaser"]`, { harness: GATE }).res;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/^NO SUMMARY FOUND: looked in 19 May 26 - 2 June 26 for 27 May and 28 May; short clips there: /);
    expect(r[0]).toContain('VID_20260528_071000_00_064.insv (28 May, not pulled yet, 0.4 GB, new)');
    expect(r[0]).not.toContain('VID_20260528_180000');          // the next day's own long episode is not a summary
  });

  it('says so when nothing is there, and when the next day has not been seen yet', () => {
    const r = py(`
res = gate_day({"lfmd_none_ok": "2026-11-16"}, ${J(SIGNED)})
res = [d for n, d in res["passed"] if n == "teaser"][0]`, { harness: GATE }).res;
    expect(r).toContain('NO SUMMARY FOUND: looked in 19 May 26 - 2 June 26 for 27 May and 28 May');
    expect(r).toContain('nothing recorded on 28 May is on the ledger yet');
    expect(r).toContain('no other short clip was recorded on either day');
  });

  it('CONTROL: a day with its Summary clip gets the teaser checks, not the search', () => {
    const r = py(`
extra = {"VID_T.insv": {"episode": 2187, "role": "teaser", "status": "rendered", "title": "GET YOUR|TEAM", "date": "2026-05-27"}}
res = gate_day({"lfmd_none_ok": "2026-11-16"}, ${J(SIGNED)}, ledger_extra=extra)
res = [n for n, d in res["passed"] + res["failures"] if n.startswith("teaser")]`, { harness: GATE }).res;
    expect(r).toContain('teaser title');
    expect(r).not.toContain('teaser');
  });
});

// ---------------------------------------------------------------- line 43, the day number in a title
describe('line 43: a YouTube or blog SEO title never starts with the day number', () => {
  it('moves a leading day label to the end and says so on the card', () => {
    const r = py(`res = platform_copy.rules_check(${J({
      'YouTube Copy': 'SEO Title: Day 2079: Running in the Rain\nDescription: Day 2079 of my run.',
      'Blog Copy': 'SEO Title: Day 4 of My 30 Day Experiment: Cold Showers\n\nThe article.',
    })}, "")`).res;
    expect(r[0]['YouTube Copy']).toBe('SEO Title: Running in the Rain (Day 2079)\nDescription: Day 2079 of my run.');
    expect(r[0]['Blog Copy']).toBe('SEO Title: Cold Showers (Day 4 of My 30 Day Experiment)\n\nThe article.');
    expect(r[1].filter((i) => i.includes('SEO title started with'))).toHaveLength(2);
  });

  it('CONTROL: titles Kevin approved with the day elsewhere, and counts that are topics, are left alone', () => {
    const titles = ['Running Streak Day 2100: My Hardest 100 Days So Far', 'Running Off Road: Considerations for Road Runners | Day 2184',
      '3 Lessons From the Run', '2100 Days Barefoot: What I Learned', 'Day Off Running: Why Rest Matters'];
    const r = py(`res = [platform_copy.rules_check({"YouTube Copy": "SEO Title: " + t + "\\nDescription: d"}, "")[1] for t in ${J(titles)}]`).res;
    expect(r).toEqual(titles.map(() => []));
  });

  it('only the YouTube and blog SEO titles; a title that is only the label is reported, not rewritten', () => {
    const r = py(`res = [platform_copy.rules_check({"Podcast Copy": "Title: Day 2079: Running"}, ""), platform_copy.rules_check({"YouTube Copy": "SEO Title: Day 2079\\nDescription: d"}, "")]`).res;
    expect(r[0]).toEqual([{ 'Podcast Copy': 'Title: Day 2079: Running' }, []]);
    expect(r[1][0]['YouTube Copy']).toBe('SEO Title: Day 2079\nDescription: d');
    expect(r[1][1][0]).toContain("is only the label 'Day 2079'");
  });
});

describe('the three scripts still pass their own selftests', () => {
  for (const s of ['render.py', 'qa.py', 'platform_copy.py']) {
    it(s, () => {
      const out = execFileSync('python3', [s, 'selftest'], { encoding: 'utf8', cwd: CE }).trim().split('\n');
      expect(JSON.parse(out[out.length - 1]).failed).toEqual([]);
    });
  }
});
