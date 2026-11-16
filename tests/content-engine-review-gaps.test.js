// The follow-up gaps two reviews left open in the Content Engine (16 Nov 2026).
//
// kevin-hq "2026-11-13 estate review/20-pr948-review.md", "Can follow" F1 to F6, plus the gap PR 948 named itself:
//   F1  a note time near the end of the talk made the Learnings-only rebuild fail every night
//   F2  Kevin's time (and a hand window) was lost when a render failed after the clip was placed
//   F3  the title rule turned "#1 Mistake..." into "Mistake... (#1)", and a comparison or a countdown the same way
//   F4  his note times were put on the recording's clock with a fixed 7.0 s, not the jingle the render spliced in
//   F5  a weak word ("diet", "latest") closing the sentence before the line could start the clip early
//   F6  the card's "Learnings clip position" line gave the recording's clock, not the full episode's
//   gap a note saying the clip is in the wrong place, with no time, carried the rejected hand window through again
// kevin-hq "2026-11-13 estate review/24-pr953-review.md":
//   F1  the morning report called an episode no card will ever reach "not raised yet"
//   F3  "blocked since" restarted when a new check joined a block that was still there
//   F4  the crossed-record guard read only the Full record, not the Learnings and Short records
//
// Invented episode data only: no network, no Airtable, no Drive, no render.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CE = path.resolve(__dirname, '..', 'scripts', 'content-engine');
const J = (x) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

function py(body) {
  const script = String.raw`
import sys, os, io, json, tempfile, contextlib, types, subprocess, datetime as dt
sys.path.insert(0, ${JSON.stringify(CE)})
import render, watch, qa, approval, platform_copy, publish, content_report
out, err = io.StringIO(), io.StringIO(); res = None
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
${body.split('\n').map((l) => '    ' + l).join('\n')}
print(json.dumps({"res": res, "out": out.getvalue(), "err": err.getvalue()}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8', cwd: CE }));
}

// The night render on an invented recording: one caption a second, a Learnings line at 200 s (the finder hears it only
// when `line` is a real one), a sign-off at 280 s. ffprobe answers 400 s, except for the local jingle copy, which runs
// `jingle` + the 1 s trim. `mode` "stop" fails the render right after the clip is decided (the shape of an upload or
// overlay failure); "land" runs the REAL build_outputs with only ffmpeg, the overlays and the uploads stubbed.
const NIGHT = String.raw`
SEEN = {}
def night(seed, line="so the latest word I say is rest", mode="stop", jingle=7.0, resolve=2122):
    talk = ["some of the talk goes here"] * 200 + [line] + ["that you should rest more"] * 79 + ["thank you as always, see you tomorrow"] + ["[BLANK_AUDIO]"] * 3
    cues = "".join("%d\n00:%02d:%02d,000 --> 00:%02d:%02d,900\n%s\n\n" % (i + 1, i // 60, i % 60, i // 60, i % 60, t) for i, t in enumerate(talk))
    tmp = tempfile.mkdtemp(); clip = os.path.join(tmp, "VID_X.insv"); open(clip, "w").write("x")
    def transcribe(c, w):
        s = os.path.join(w, "transcript.srt"); open(s, "w").write(cues); return " ".join(talk), s
    class P:
        def __init__(self, o): self.stdout, self.returncode = o, 0
    real = subprocess.run
    local_intro = os.path.join(tmp, "intro_local.mp4")
    def probe(cmd, *a, **k):
        if os.path.basename(cmd[0]) != "ffprobe": return real(cmd, *a, **k)
        return P(str(jingle + render.INTRO_TRIM_START) if cmd[-1] == local_intro else "400")
    subprocess.run = probe
    render.transcribe = transcribe
    render.clip_role = lambda d, has: "episode"
    sys.modules["pointing"] = types.SimpleNamespace(pans_arg=lambda p: "")
    saved = []
    watch.save_ledger = lambda l: saved.append(json.loads(json.dumps(l)))
    watch.spoken_day = lambda t: 2122
    watch.resolve_episode = lambda d, s, prev_day_has_talk=False: (resolve, "test")
    if mode == "stop":
        def stop(*a, **k): raise RuntimeError("the upload failed after the clip was placed")
        render.find_pans_for = stop
    else:
        render.find_pans_for = lambda c, s: []
        render.render_masters = lambda *a, **k: {"16:9": "m169.mp4", "9:16": "m916.mp4"}
        render.thumb_lines = lambda t: ("A", "B", "fallback")
        render.title_from_transcript = lambda t: "T"
        def overlay(ov, args, what):
            if args[0] == "captions": open(args[2], "w").write(open(args[1]).read())
            else: open(args[3], "w").write("x")
        render.overlay = overlay
        render.check_captions = lambda p, w: None
        render.find_pause = lambda m, segs, end: (30.0, 31.0)
        render.media_seconds = lambda p: 400.0
        SEEN["intros"] = []
        render.insert_intro = lambda src, at, out, intro=None: SEEN["intros"].append(intro) or open(out, "w").write("x") and out
        render.podcast_audio = lambda c, out, at=0.0, resume=0.0: out
        render.intro_clip = lambda: local_intro
        render.trim = lambda src, a, b, dest: dest
        render.clean_short = lambda *a, **k: None
        render.assert_has_video = lambda p, w: None
        SEEN["workdir"] = os.path.join(tmp, "render_VID_X")
        render.horizon_for = lambda m: {}
        render.source_fps = lambda p: 30.0
        render.make_thumbnail = lambda *a, **k: ("t.png", ["A", "B"])
        render.publish_to_drive = lambda *a, **k: ("folder", {"full": "https://drive.google.com/file/d/FULLXaaaaaaa/view"})
        render.find_or_create_record = lambda *a, **k: ("rec1", "name")
        render.record_updates = lambda *a, **k: {}
        render.copy_goes_with_render = lambda d: False
        render.keep_for_next_part = lambda *a, **k: False
        watch._airtable = lambda *a, **k: {}
    led = dict({"VID_X.insv": dict({"local": clip, "date": "2026-02-19", "day": 2122, "status": "pulled"}, **seed)}, **SEEN.pop("others", {}))
    try: render.process("VID_X.insv", led, keep=True); failed = None
    except RuntimeError as ex: failed = str(ex)
    return led["VID_X.insv"], (saved[-1]["VID_X.insv"] if saved else {}), failed
`;

describe('F2: Kevin\'s time and a hand window survive a render that fails after the clip is placed', () => {
  it('BACK-TEST: a failure after placement leaves his time on the entry AND on the saved ledger, for the retry', () => {
    const r = py(`${NIGHT}
e, disk, failed = night({"lfmd_at_keep": {"full": 207.0, "master": 200.0}, "lfmd_window_keep": [150.0, 250.0]})
res = {"failed": failed, "window": e["lfmd_window"], "mem": e.get("lfmd_at_keep"), "disk": disk.get("lfmd_at_keep"), "hand": disk.get("lfmd_window_keep")}`).res;
    expect(r.failed).toContain('upload failed');
    expect(r.window).toEqual([200, 280.9]);                       // placed at his time, as before
    expect(r.mem).toEqual({ full: 207, master: 200 });            // main popped it before the render started
    expect(r.disk).toEqual({ full: 207, master: 200 });           // and the ledger run() reloads on failure held none
    expect(r.hand).toEqual([150, 250]);
  });

  it('the retry places the clip at his time again, then a render that lands uses them up', () => {
    const r = py(`${NIGHT}
seed = {"lfmd_at_keep": {"full": 207.0, "master": 200.0}, "lfmd_window_keep": [150.0, 250.0], "lfmd_window_doubted": [10.0, 40.0]}
e, disk, failed = night(seed)
retry = {k: v for k, v in e.items() if k in ("lfmd_at_keep", "lfmd_window_keep", "lfmd_window_doubted")}
e2, disk2, failed2 = night(retry, mode="land")
res = {"failed2": failed2, "status": e2["status"], "window": e2["lfmd_window"], "by": e2["lfmd_window_by"],
       "left": sorted(k for k in ("lfmd_at_keep", "lfmd_window_keep", "lfmd_window_doubted") if k in disk2)}`).res;
    expect(r.failed2).toBe(null);
    expect(r.status).toBe('rendered');
    expect(r.window).toEqual([200, 280.9]);
    expect(r.by).toBe('operator');
    expect(r.left).toEqual([]);
  });
});

describe('F4: his note times are put back by the jingle the render spliced in, not a fixed 7 s', () => {
  it('the real build_outputs measures the jingle file it splices in, shifts the captions by it, and the ledger keeps it', () => {
    const r = py(`${NIGHT}
e, disk, failed = night({}, mode="land", jingle=9.0)
caps = render.srt_segments(open(os.path.join(SEEN["workdir"], "Episode_2122_Full_Episode_YT.srt")).read())
res = {"failed": failed, "jingle": disk.get("jingle_seconds"), "cut": disk.get("intro_at"), "local": SEEN["intros"],
       "line": [a for a, b, t in caps if t == "so the latest word I say is rest"]}`).res;
    expect(r.failed).toBe(null);
    expect(r.jingle).toBe(9);              // the previous head measured the Drive mount's copy (399 here), never this file
    expect(r.cut).toBe(30);
    expect(r.local).toHaveLength(2);       // both the full episode and the clean YouTube copy get the measured file
    expect(r.local.every((x) => x.endsWith('intro_local.mp4'))).toBe(true);
    expect(r.line).toEqual([209]);         // the line at 200 s on the recording sits 9 s later in the captions
  });

  it('BACK-TEST: 2121\'s "exactly 4 minutes and 37 seconds" lands on 270 s with the 7 s jingle, and moves with a longer one', () => {
    const r = py(`
note = "Learnings from my diary is at exactly 4 minutes and 37 seconds of the main episode."
res = [render.note_learnings_at(note, {"intro_at": 25.65}),
       render.note_learnings_at(note, {"intro_at": 25.65, "jingle_seconds": 7.0}),
       render.note_learnings_at(note, {"intro_at": 25.65, "jingle_seconds": 9.0}),
       render.note_learnings_at(note, {"intro_at": 25.65, "jingle_seconds": "abc"}),
       render.note_learnings_at(note, {"intro_at": 25.65, "jingle_seconds": 0}),
       render.note_learnings_at(note, {"intro_at": 25.65, "jingle_seconds": True})]`).res;
    expect(r[0]).toEqual({ full: 277, master: 270 });   // every render before 16 Nov 2026: unchanged
    expect(r[1]).toEqual({ full: 277, master: 270 });
    expect(r[2]).toEqual({ full: 277, master: 268 });   // main put it at 270 whatever the jingle
    expect(r.slice(3)).toEqual([{ full: 277, master: 270 }, { full: 277, master: 270 }, { full: 277, master: 270 }]);
  });

  it('the receipts read the full episode on the same jingle', () => {
    const r = py(`
text = render.sent_back_receipt("Learnings from my diary is at exactly 4 minutes and 37 seconds of the main episode.")
ep = {"episode": 2121, "role": "episode", "status": "rendered", "intro_at": 25.65, "jingle_seconds": 9.0, "lfmd_window": [268.0, 341.0],
      "lfmd_window_by": "operator", "lfmd_from_note": {"full": 277.0, "master": 268.0, "window": [268.0, 341.0], "heard": "latest on my diet"}}
res = [render.concrete_receipt(text, 2121, {"a": ep}, {}), render.lfmd_receipt("Learnings from my diary is at 4:37.", (268.0, 341.0), intro_at=25.65, jingle_s=9.0)]`).res;
    expect(r[0]).toContain('now runs from 4:37 to 5:50 of the full episode');
    expect(r[1]).toContain('rebuilt from 4:37 to 5:50 of the full episode');
  });
});

describe('F6: the card\'s Learnings clip position is on the full episode\'s clock', () => {
  it('names where the clip starts on the video Kevin watches, and keeps the share measured on the recording', () => {
    const r = py(`
ep = {"lfmd_window": [270.0, 343.0], "duration": 690.0, "lfmd_window_by": "detector"}
res = [qa.lfmd_position(dict(ep, intro_at=25.65), 0, 2121)[2],
       qa.lfmd_position(dict(ep, intro_at=25.65, jingle_seconds=9.0), 0, 2121)[2],
       qa.lfmd_position(dict(ep, intro_at=25.65, lfmd_closes_talk=True, lfmd_window=[270.0, 400.0]), 0, 2121)[2],
       qa.lfmd_position(ep, 0, 2121)[2],
       qa.lfmd_position(dict(ep, intro_at="unreadable"), 0, 2121)[2]]`).res;
    expect(r[0]).toBe('starts at 4:37 of the full episode (4:30 of the 11:30 recording, 39%), placed by the clip finder on the spoken phrase');
    expect(r[1]).toMatch(/^starts at 4:39 of the full episode/);
    expect(r[2]).toMatch(/^starts at 4:37 of the full episode \(4:30 of the 6:40 talk on the recording, 67%\)/);
    // CONTROL: no jingle cut recorded, or one that cannot be read: the recording's clock, as before
    expect(r[3]).toBe('starts at 4:30 of the 11:30 episode (39%), placed by the clip finder on the spoken phrase');
    expect(r[4]).toBe(r[3]);
  });

  it('CONTROL: the verdict itself is unchanged; only the words', () => {
    const r = py(`
ep = {"lfmd_window": [75.8, 254.8], "duration": 520.8}
res = [qa.lfmd_position(dict(ep, intro_at=25.0), 0, 9)[:2], qa.lfmd_position(ep, 0, 9)[:2]]`).res;
    expect(r).toEqual([[false, true], [false, true]]);
  });
});

describe('F5: the sentence before the Learnings line never starts the clip', () => {
  const SEGS = (first, second) => `[(260.0, 265.0, "and that is the run for today"), (266.0, 270.5, ${JSON.stringify(first)}),
        (270.8, 276.0, ${JSON.stringify(second)}), (276.2, 300.0, "that I need to rest more"), (300.0, 305.0, "stay positive, see you tomorrow")]`;

  it('BACK-TEST: "...watching my diet." then "So the learnings from my diary today": the clip starts on the line', () => {
    const r = py(`res = render.place_from_note(${SEGS("I have been watching my diet.", "So the learnings from my diary today are")}, 272.0)`).res;
    expect(r).toEqual([[270.8, 305], 'So the learnings from my diary today are']);   // main started at 266.0, on the diet sentence
  });

  it('review of PR 957: the line misheard as weak words is never stepped past ("The latest from my diary." then "Diet wise...")', () => {
    const r = py(`segs = [(260.0, 265.5, "and that is the run"), (266.0, 268.4, "The latest from my diary."), (268.6, 275.0, "Diet wise I have been good."),
        (276.0, 300.0, "that I need to rest more"), (300.0, 305.0, "stay positive, see you tomorrow")]
res = render.place_from_note(segs, 267.0)`).res;
    expect(r).toEqual([[266, 305], 'The latest from my diary.']);   // the previous head started at 268.6 and lost the line
  });

  it('CONTROL: a next caption the clip finder does not read as the line never pulls the start forward', () => {
    const r = py(`res = render.place_from_note(${SEGS("I have been watching my diet.", "So the latest on my diary today is")}, 272.0)`).res;
    expect(r).toEqual([[266, 305], 'I have been watching my diet.']);   // as origin/main: no step without the finder's own reading
  });

  it('CONTROL: a closing sentence that carries "learnings" is the line itself, so it still starts the clip', () => {
    const r = py(`res = render.place_from_note(${SEGS("So the learnings from my diary.", "Diet wise I ate well")}, 272.0)`).res;
    expect(r).toEqual([[266, 305], 'So the learnings from my diary.']);
  });

  it('CONTROL: the line split over two captions with no full stop starts where it always did', () => {
    const r = py(`res = [render.place_from_note(${SEGS("So the latest on my", "diet for this day is that")}, 272.0),
       render.place_from_note(${SEGS("and the weather was fine", "So the latest on my diary today")}, 272.0)]`).res;
    expect(r[0]).toEqual([[266, 305], 'So the latest on my']);
    expect(r[1]).toEqual([[270.8, 305], 'So the latest on my diary today']);
  });
});

describe('F1: a note time the rules refuse never fails the Learnings rebuild night after night', () => {
  // the finder's line at 6:58; a "latest" in the last 10 s of the recording, after the sign-off
  const SRT = '1\n00:04:30,000 --> 00:04:40,000\nAnd that is what I am saying at the moment.\n\n' +
    '2\n00:06:58,000 --> 00:07:05,000\nSo ultimately the learnings from my diary today are that\n\n' +
    '3\n00:09:30,000 --> 00:09:40,000\nthank you as always, see you tomorrow\n\n' +
    '4\n00:09:50,000 --> 00:09:55,000\nand the latest from me is done\n';
  const REBUILD = (note) => `
tmp = tempfile.mkdtemp(); clip = os.path.join(tmp, "c.insv"); open(clip, "w").write("x")
note = ${JSON.stringify(note)}
led = {"c.insv": {"episode": 2132, "role": "episode", "status": "rendered", "local": clip, "date": "2026-02-02", "drive_id": "d",
                  "duration": 600.0, "intro_at": 27.27, "lfmd_at_keep": {"full": 300.0, "master": 293.0}, "lfmd_window_keep": [100.0, 150.0],
                  "lfmd_window_doubted": [100.0, 150.0]}}
watch.load_ledger = lambda: led; watch.save_ledger = lambda l: None
srt = os.path.join(tmp, "s.srt"); open(srt, "w").write(${JSON.stringify(SRT)})
render.transcribe = lambda c, w: ("text", srt)
render.render_masters = lambda *a, **k: {}
render.title_from_transcript = lambda t: "t"
render.build_outputs = lambda *a, **k: {"lfmd": "l", "lfmd_yt": "y", "lfmd_srt": "s"}
render.publish_to_drive = lambda *a, **k: ("f", {"lfmd": "L", "lfmd_yt": "Y", "lfmd_srt": "S"})
render.find_or_create_record = lambda *a, **k: ("rec1", "found")
watch._airtable = lambda *a, **k: {}
render.release_hold = lambda d: None
approval.load_state = lambda: {"2132": {"task": "recFAKE0000002132", "verdict": "changes", "feedback": note}}
sent = []
approval.refresh_card = lambda day, receipt=None: sent.append(open(receipt).read())
try: render.redo_lfmd(2132); died = None
except SystemExit as ex: died = str(ex)
e = led["c.insv"]
res = {"died": died, "window": e["lfmd_window"], "by": e["lfmd_window_by"], "unused": e.get("lfmd_note_unused"), "receipt": sent,
       "keeps": sorted(k for k in ("lfmd_at_keep", "lfmd_window_keep", "lfmd_window_doubted") if k in e)}`;

  it('BACK-TEST: his time inside the last 20 s (a 5 s clip) is said and dropped, and the finder\'s clip is rebuilt', () => {
    const r = py(REBUILD('Learnings from my diary is at 9 minutes and 57 seconds of the episode.')).res;
    expect(r.died).toBe(null);                                   // main: "window is 5.0 s, outside the 20 to 180 s ...", every night
    expect(r.window).toEqual([418, 580]);
    expect(r.by).toBe('detector');
    expect(r.unused.full).toBe(597);
    expect(r.unused.why).toMatch(/^window is 5\.0 s, outside the 20 to 180 s/);
    expect(r.receipt[0]).toContain('your time (9:57) gave no clip the rules allow (window is 5.0 s');
    expect(r.receipt[0]).toContain('the clip is from the clip finder');
  });

  it('CONTROL: a time on the Learnings line still places the clip there', () => {
    const r = py(REBUILD('Learnings from my diary is at 7 minutes and 6 seconds of the episode.')).res;
    expect(r.died).toBe(null);
    expect(r.window).toEqual([418, 580]);
    expect(r.by).toBe('operator');
    expect(r.unused).toBe(null);
    expect(r.keeps).toEqual([]);           // F2 leftover: the rebuild that lands uses them up, as a full render does
  });
});

describe('PR 953 review F5: a clip resolved to another episode drops the old episode\'s file links', () => {
  const OLD_OUT = { full: 'https://drive.google.com/file/d/FULL2121aaaaaa/view', thumb: 'https://drive.google.com/file/d/THUMB2121aaaaa/view' };
  it('BACK-TEST: a redo that moves the clip from 2121 to 2122 and then stops leaves 2121\'s own record clean', () => {
    const r = py(`${NIGHT}
e, disk, failed = night({"episode": 2121, "role": "episode", "outputs": ${J(OLD_OUT)}})
rec = {"Video Edited URL": ${J(OLD_OUT.full)}, "Thumbnail URL": ${J(OLD_OUT.thumb)}}
res = {"failed": failed, "episode": disk.get("episode"), "outputs": disk.get("outputs"), "crossed": qa.crossed_record(2121, rec, {"VID_X.insv": disk})}`).res;
    expect(r.failed).toContain('upload failed');
    expect(r.episode).toBe(2122);
    expect(r.outputs).toBe(null);
    expect(r.crossed).toEqual([]);         // the previous head flagged 2121's correct record as holding 2122's files
  });

  it('CONTROL: a clip that stays on its episode keeps its links until its own render replaces them', () => {
    const r = py(`${NIGHT}
e, disk, failed = night({"episode": 2122, "role": "episode", "outputs": ${J(OLD_OUT)}})
res = disk.get("outputs")`).res;
    expect(r).toEqual(OLD_OUT);
  });
});

describe('the gap PR 948 named: "in the wrong place" with no time no longer carries the rejected hand window', () => {
  it('reads the notes Kevin actually wrote: a wrong-place note doubts the window, a note about the banner does not', () => {
    const r = py(`
notes = ["Learning from my diary is still not in the right place.",
         "Learnings from my diary is wrong.",
         '"Learnings from my diary" is not correct.',
         "Need to redo the learnings for my diary as you've clipped the wrong section of the main video.",
         "Try and find the learnings from my diary again please.",
         "The title card on the learnings for my diary clips doesn't fit.",
         "The learnings from my diary videos on the title and subtitle banner are that the text doesn't fit, and it's missing words.",
         "There are learnings from my diary.",
         "Learnings from my diary is fine. The title is wrong.",
         "Learnings from my diary is wrong. It should kick in at around 4:32 of the main episode.",
         "Learnings from my diary is wrong, it should kick in at around 4:32 of the main episode.",
         "The jingle is in the wrong place.",
         "The learnings from my diary is fine but please redo the jingle.",
         "Nothing wrong with the learnings from my diary.",
         "Learnings from my diary is spot on again.",
         "Learnings from my diary is cut off too early again.",
         "The title card on the learnings clip is wrong."]
res = [render.learnings_doubted(n) for n in notes]`).res;
    // 2112's 26 Oct note gives its time in the NEXT sentence, which PR 948's M2 rule does not read, so it counts as
    // "wrong, no time": the finder decides and the hand window is the fallback. The same words in one sentence give a time.
    // The last five must never fire (review of PR 957): praise, a note about another part, the clip's end, its banner.
    expect(r).toEqual([true, true, true, true, true, false, false, false, false, true, false, false, false, false, false, false, false]);
  });

  const REDO = (note) => `
tmp = tempfile.mkdtemp()
note = ${JSON.stringify(note)}
state = {"2121": {"task": "recFAKE0000002121", "verdict": "changes", "feedback": note, "synced": "2026-10-31T09:00:00"}}
led = {"VID_A.insv": {"day": 2121, "episode": 2121, "role": "episode", "status": "rendered", "duration": 600.0, "intro_at": 25.65,
                      "lfmd_window": [276.74, 350.99], "lfmd_window_by": "operator"}}
rp = os.path.join(tmp, "r.md"); open(rp, "w").write(render.sent_back_receipt(note))
watch.save_ledger = lambda l: None
render.redo_day(2121, rp, "test", ledger=led, state=state, root=tmp, today=dt.date(2026, 10, 31), last_night=None, running=False)
e = led["VID_A.insv"]
res = {k: e.get(k) for k in ("lfmd_window_keep", "lfmd_window_doubted", "lfmd_at_keep")}`;

  it('BACK-TEST: 2121\'s 31 Oct note parks the hand window as a fallback, not as the answer', () => {
    const r = py(REDO('Learning from my diary is still not in the right place.')).res;
    expect(r).toEqual({ lfmd_window_keep: null, lfmd_window_doubted: [276.74, 350.99], lfmd_at_keep: null });   // main: kept as the answer
  });

  it('CONTROL: a note about the banner, or about something else, carries the hand window as before; a time still wins', () => {
    const banner = py(REDO("The title card on the learnings for my diary clips doesn't fit.")).res;
    const other = py(REDO('The thumbnail is the wrong frame.')).res;
    const timed = py(REDO('Learnings from my diary is wrong, it should kick in at around 4:32 of the main episode.')).res;
    expect(banner).toEqual({ lfmd_window_keep: [276.74, 350.99], lfmd_window_doubted: null, lfmd_at_keep: null });
    expect(other).toEqual({ lfmd_window_keep: [276.74, 350.99], lfmd_window_doubted: null, lfmd_at_keep: null });
    expect(timed.lfmd_at_keep).toEqual({ full: 272, master: 265 });
    expect(timed.lfmd_window_doubted).toBe(null);
  });

  it('the night: the finder decides; when it finds nothing the old window stays, so the episode never loses its clip', () => {
    const r = py(`${NIGHT}
found, _, _ = night({"lfmd_window_doubted": [150.0, 250.0]}, line="so the learnings from my diary today are that")
none, _, _ = night({"lfmd_window_doubted": [150.0, 250.0]})
res = [[found["lfmd_window"], found["lfmd_window_by"], found.get("lfmd_doubted_kept")], [none["lfmd_window"], none["lfmd_window_by"], none.get("lfmd_doubted_kept")]]`).res;
    expect(r[0]).toEqual([[200, 280.9], 'detector', null]);
    expect(r[1]).toEqual([[150, 250], 'operator', true]);
  });

  it('the receipt says plainly when the finder found no other start, and how to move the clip', () => {
    const r = py(`
text = render.sent_back_receipt("Learning from my diary is still not in the right place.")
ep = {"episode": 2121, "role": "episode", "status": "rendered", "intro_at": 25.65, "lfmd_window": [276.74, 350.99],
      "lfmd_window_by": "operator", "lfmd_doubted_kept": True}
res = render.concrete_receipt(text, 2121, {"a": ep}, {"redo_lfmd_before": {"window": [276.74, 350.99]}})`).res;
    expect(r).toContain('the clip finder found no other start, so this is the section placed by hand before; send it back with the time it starts');
    expect(r).toContain('(the same section as before)');
  });
});

describe('F3: the title rule leaves a ranking, a comparison and a countdown alone', () => {
  it('BACK-TEST: the three titles the review found mangled are left as written', () => {
    const r = py(`res = [platform_copy.title_day_first(t) for t in ("#1 Mistake Every Barefoot Runner Makes", "Day 1 vs Day 2100: What Changed",
       "3, 2, 1: Race Day Nerves", "Day 1 to Day 2100: The Long Road", "Day 1, Day 2, Day 3: Building the Habit")]`).res;
    expect(r).toEqual([null, null, null, null, null]);
  });

  it('CONTROL: a leading day label still moves to the end', () => {
    const r = py(`res = [platform_copy.title_day_first(t) for t in ("Day 2079: Running in the Rain", "Day 2079 Running in the Rain",
       "#12: Why I Run Barefoot", "Day 2100, 5 Lessons From the Run", "Episode 2100 | Rest Days")]`).res;
    expect(r).toEqual([['Day 2079', 'Running in the Rain (Day 2079)'], ['Day 2079', 'Running in the Rain (Day 2079)'],
      ['#12', 'Why I Run Barefoot (#12)'], ['Day 2100', '5 Lessons From the Run (Day 2100)'], ['Episode 2100', 'Rest Days (Episode 2100)']]);
  });
});

describe('PR 953 review F1: the morning report never says a card is on its way when nothing is moving', () => {
  it('BACK-TEST: 2156, rendered on 4 Nov with no card on 16 Nov, is named as stuck, not "not raised yet"', () => {
    const r = py(`
now = dt.datetime(2026, 11, 16, 9, 0, tzinfo=dt.timezone.utc)
# the ledger's stamps are local time; given here with London's November offset so the case reads the same in any TZ
res = [content_report.no_card_words("2026-11-04T01:12:38+00:00", now), content_report.no_card_words("2026-11-16T02:42:12+00:00", now),
       content_report.no_card_words(None, now),
       content_report.blocker_why(2156, [], {}, [], set(), set(), [], [2156], set(), no_card_at={2156: "2026-11-04T01:12:38+00:00"}, now=now)]`).res;
    expect(r[0]).toMatch(/^rendered on 4 Nov and still no card after 12 day\(s\): the card step raises one on its next run once/);
    expect(r[0]).toContain('NOT CHECKED here');
    expect(r[1]).toBe('rendered, its card is not raised yet');   // rendered last night: the card is genuinely on its way
    expect(r[2]).toBe('rendered, its card is not raised yet');   // no render time on the ledger: nothing to judge by
    expect(r[3]).toBe(r[0]);
  });
});

describe('PR 953 review F3: a block keeps its age while its first failure is still there', () => {
  const GATE = (before, failures) => `
qa.gate = lambda day, ledger: (False, [tuple(f) for f in ${JSON.stringify(failures)}], [])
qa.is_wait = lambda fs: False
platform_copy.session_leak = lambda recs: []
STATE = ${J(before)}
approval.save_state = lambda s: None
approval.output_gate(2137, {}, STATE, None)
res = STATE["2137"]["qa_blocked"]`;
  const OLD = { '2137': { qa_blocked: { at: '2026-11-16T07:16:00', since: '2026-11-12T07:16:00', reads: 48,
    failures: ['episode rendered: no long clip rendered for this day'] } } };

  it('BACK-TEST: 2137 gains the crossed-record line and stays blocked since 12 Nov, 49 reads', () => {
    const r = py(GATE(OLD, [['episode rendered', 'no long clip rendered for this day'],
      ['record holds another episode', "Video Edited URL is episode 2136's full (clip VID_x.insv). The record must be put right before any card"]])).res;
    expect(r.since).toBe('2026-11-12T07:16:00');     // main restarted it at this read
    expect(r.reads).toBe(49);
  });

  it('CONTROL: the same check with a new detail keeps the clock; every earlier check cleared starts it again', () => {
    const same = py(GATE(OLD, [['episode rendered', 'no long clip rendered for this day (read again)']])).res;
    const fresh = py(GATE(OLD, [['copy missing', 'Short Form Video has its clip but no copy yet']])).res;
    expect(same.since).toBe('2026-11-12T07:16:00');
    expect(fresh.reads).toBe(1);
    expect(fresh.since).toBe(fresh.at);
  });
});

describe('PR 953 review F4: the crossed-record guard reads the Learnings and Short records too', () => {
  const LEDGER = {
    'VID_2136.insv': { episode: 2136, role: 'episode', status: 'rendered',
      outputs: { full: 'https://drive.google.com/file/d/FULL2136aaaaaa/view', lfmd: 'https://drive.google.com/file/d/LFMD2136aaaaaa/view' } },
    'VID_2137.insv': { episode: 2137, role: 'episode', status: 'rendered',
      outputs: { full: 'https://drive.google.com/file/d/FULL2137aaaaaa/view', lfmd: 'https://drive.google.com/file/d/LFMD2137aaaaaa/view' } },
  };
  const FULL = { 'Video Edited URL': 'https://drive.google.com/file/d/FULL2137aaaaaa/view', 'Reframed Video URL': 'https://drive.google.com/file/d/LFMD2137aaaaaa/view',
    'YouTube Copy': 'SEO Title: x', 'Record Status': 'Approved for Publishing' };
  // recYOWMwJmiMQthYG's shape: "Episode 2137 Learnings from My Diary" holds 2136's Learnings clip
  const CHILD = (link) => ({ 'Video Edited URL': link, 'TikTok Copy': 'copy' });
  const RECS = (link) => ({ 'Long Form Video': { fields: FULL }, 'Learnings From My Diary': { fields: CHILD(link) }, 'Short Form Video': { fields: { 'TikTok Copy': 'copy' } } });

  it('BACK-TEST: the card for 2137 is refused while its Learnings record holds 2136\'s clip, and says which record', () => {
    const r = py(`
qa.gate = lambda day, ledger=None, files=None: (True, [], [("full episode file", "500 s")])
approval.save_state = lambda st: None
state = {}
proof = approval.output_gate(2137, ${J(LEDGER)}, state, ${J(RECS('https://drive.google.com/file/d/LFMD2136aaaaaa/view'))})
res = {"proof": proof, "blocked": state["2137"]["qa_blocked"]["failures"]}`).res;
    expect(r.proof).toBe(null);
    expect(r.blocked).toEqual(["record holds another episode: the Learnings From My Diary record's Video Edited URL is episode 2136's lfmd " +
      '(clip VID_2136.insv). The record must be put right before any card']);
  });

  it('BACK-TEST: the publisher posts nothing for an approved day whose Learnings record is crossed', () => {
    const r = py(`
state = {}
publish.load_state = lambda: state; publish.save_state = lambda st: None
publish.approved_days = lambda: [2137]; publish.held_days = lambda path=None: {}
publish.accounts = lambda brand="Runpreneur": []; publish.account_map = lambda a: {"youtube": {"id": "yt"}}
publish.bundle = lambda day: ${J(RECS('https://drive.google.com/file/d/LFMD2136aaaaaa/view'))}
watch.load_ledger = lambda: ${J(LEDGER)}; watch.gap_days = lambda: set()
publish.mode = lambda: "live"
scheduled = []
publish.schedule_stage = lambda *a, **k: scheduled.append(a[0]) or 1
publish.fill_learnings = lambda *a, **k: None
publish.run()
res = {"scheduled": scheduled, "why": (state.get("2137") or {}).get("not_published", {}).get("why")}`).res;
    expect(r.scheduled).toEqual([]);
    expect(r.why).toBe("its record holds another episode's files");
  });

  it('CONTROL: a Learnings record holding its own clip raises the card as before', () => {
    const r = py(`
qa.gate = lambda day, ledger=None, files=None: (True, [], [("full episode file", "500 s")])
approval.save_state = lambda st: None
res = approval.output_gate(2137, ${J(LEDGER)}, {}, ${J(RECS('https://drive.google.com/file/d/LFMD2137aaaaaa/view'))})`).res;
    expect(r).toEqual(['Checks the engine ran on the files (proof, not a promise):', '- full episode file: 500 s']);
  });
});

describe('the scripts still pass their own selftests', () => {
  for (const s of ['render.py', 'qa.py', 'platform_copy.py', 'content_report.py']) {
    it(s, () => {
      const out = execFileSync('python3', [s, 'selftest'], { encoding: 'utf8', cwd: CE }).trim().split('\n');
      expect(JSON.parse(out[out.length - 1]).failed).toEqual([]);
    });
  }
});
