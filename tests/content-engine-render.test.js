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
  it('passes its own selftest (folder naming, output names, banner title, record fields, hand-read Learnings window)', () => {
    const out = JSON.parse(execFileSync('python3', [RENDER, 'selftest'], { encoding: 'utf8', cwd: DIR }));
    expect(out.failed).toEqual([]);
    // 68 since 7 Oct 2026: the hand-read Learnings window (check_lfmd_window) and the redo list's
    // optional @start-end (redo_line) are driven in there, not grepped. The floor rises with them so
    // deleting those cases goes red instead of quietly shrinking the count.
    // 95 since 1 Nov 2026: the jingle cut Kevin gives on a sent-back card (check_cut_override,
    // cut_with_override, jingle_cut_from, set_cut) is driven in there too — findings
    // 20261018-ceo-memory-sweep-973 and 20261025-phase-3-1077, four bounces on 2100 and 2113.
    expect(out.checks).toBeGreaterThanOrEqual(95);
  });

  // 15 Oct 2026, finding 20261015-phase-3-888: day 2106 held two short recordings. Both were
  // role=teaser, both rendered, and both wrote Summary Video URL to the same episode record, so the
  // later render silently replaced the earlier one and Kevin's card carried a summary from a
  // different run. The earlier clip had been flagged "spoken day 2101 disagrees with the date
  // (2106)" and the flag changed nothing. Driven here, so the answer cannot depend on which clip
  // finishes rendering last.
  it('gives a day ONE summary, and the spoken-day flag decides it whichever teaser renders first', () => {
    const decide = (key, day, reason, ledger) => JSON.parse(execFileSync('python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(DIR)})
import render
print(json.dumps(render.summary_rival(${JSON.stringify(key)}, ${day}, ${JSON.stringify(reason)}, json.loads(sys.argv[1]))))
`, JSON.stringify(ledger)], { encoding: 'utf8', cwd: DIR }));

    const FLAG = 'spoken day 2101 disagrees with the date (2106); date used, flagged';
    const OK = 'spoken day matches the date';
    const rendered = (why, key = 'VID_002.insv') => ({ [key]: { episode: 2106, role: 'teaser', status: 'rendered', episode_reason: why } });

    // the real 2106 order: the flagged clip rendered first, the clean one came second
    expect(decide('VID_004.insv', 2106, OK, rendered(FLAG))[0]).toBe('replace');
    // the other order: the clean one is already the summary, so the flagged one is refused
    const refused = decide('VID_002.insv', 2106, FLAG, rendered(OK, 'VID_004.insv'));
    expect(refused[0]).toBe('refuse');
    expect(refused[1]).toContain('cannot replace that summary');
    expect(refused[1]).toContain("spoken day disagrees with the date");
    // two clean teasers: the first stays, and the second is named rather than silently overwriting
    expect(decide('VID_004.insv', 2106, OK, rendered(OK))[0]).toBe('refuse');
    expect(decide('VID_002.insv', 2106, OK, rendered(OK))).toEqual(['', '']);   // a re-render of the day's own summary
    // and nothing in the way of the first summary of a day, or of another day's
    expect(decide('VID_002.insv', 2106, OK, {})).toEqual(['', '']);
    expect(decide('VID_004.insv', 2107, OK, rendered(OK))).toEqual(['', '']);
  });

  it('the render step acts on that decision instead of writing the link anyway', () => {
    const src = readFileSync(RENDER, 'utf8');
    // the refusal path mirrors the episode branch's: failed, named, clip and workdir cleaned up
    expect(src).toContain('what, why = summary_rival(key, day, reason, ledger)');
    // 500, not 400 (19 Oct 2026): the refusal now also stamps render_failed, which steps the day aside in the redo
    // queue (finding 20261019-phase-3-982). A window this test can outgrow is why the assertion below exists too.
    expect(src).toMatch(/if what == "refuse":[\s\S]{0,500}return/);
    // the stamp itself, so a refusal cannot go back to holding the head of the redo queue in silence
    expect(src).toMatch(/if what == "refuse":[\s\S]{0,500}render_failed/);
  });

  // 5 Sep 2026 (finding 20260905-exceptions-462): the nightly run died inside overlays.py 'full'
  // with an ffmpeg filter error, the stderr was thrown away by stdout=DEVNULL, and the one bad clip
  // took every other clip of the night with it.
  it('refuses an empty or missing captions file by name, surfaces overlays stderr, and keeps rendering after a failed clip', () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toContain('def check_captions(path, what)');
    expect(src).toContain('check_captions(caps, "episode %s full" % day)');
    expect(src).toContain('stderr=subprocess.PIPE');
    // no overlays call may go back to swallowing its stderr
    expect(src).not.toMatch(/subprocess\.run\(\[sys\.executable, ov, "/);
    // a failed clip is recorded and the loop continues
    expect(src).toContain('ledger[k]["status"] = "failed"');
    expect(src).toMatch(/render: %d of %d clips done, %d failed/);
  });

  it("inserts Ericamae's 8 second branded intro after the sign-off line (her app's rule) and makes the podcast audio", () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toContain('INTRO_CLIP = os.path.join(EDITED_ROOT, "Vlog Intro", "runprenuer-intro_clip.mp4")');
    expect(src).toContain('def intro_window(segments, duration=None)');   // replaced intro_insert_seconds: the gap, not the caption end (10 Sep 2026)
    expect(src).toContain('insert_intro(captioned, at, paths["full"], intro)');   // the measured local jingle (PR 957 review)
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
    expect(src).toContain('at, resume = find_pause(masters["16:9"], cap_segs, srt_segments(open(srt).read())[-1][1])');  // the five-word chunks, so the jingle lands in Kevin's gap (10 Sep 2026)
    expect(src).toContain('def intro_window(segments, duration=None)');
    expect(src).toContain('def quiet_point(');
    expect(src).toContain('clip_caption_at(open(caps).read(), at)');
    expect(src).toContain('d(?:ia|ie|ai)\\w*\\b(?!\\s+of\\s+(?:a|an|the)\\b(?!\\s+day\\b))');  // the show's own name is not a Learnings section (2056 teaser, 13 Sep 2026); 'of the day' is (27 Sep 2026)
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

  it('files no output without a video stream, and can rebuild one Learnings clip on its own (5-8 Sep 2026)', () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toContain('def assert_has_video(');
    expect(src).toContain('if p.endswith(".mp4"): assert_has_video(p');
    expect(src).toContain('def redo_lfmd(day');   // takes an optional hand-read window since 7 Oct 2026
    const w = readFileSync(WATCH, 'utf8');
    expect(w).toContain('DAY_NAMED_RE');
  });

  it('never writes copy from an empty transcript: under 50 characters of speech is B-roll', () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toMatch(/MIN_TRANSCRIPT_CHARS = 50/);
    expect(src).toContain('e["status"] = "broll"');
  });

  it("works out the episode with Kevin's rule: date first, spoken day as a check, catch-up keeps the spoken day", () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toContain('spoken = watch.spoken_day(text)');
    expect(src).toContain('watch.resolve_episode(date_day, spoken, prev_day_has_talk=prev_has_talk)');
    expect(src).toContain('if teaser_for_day_before(role, spoken, date_day, ledger):');   // 2071's summary, recorded the next morning (24 Sep 2026)
    const w = readFileSync(WATCH, 'utf8');
    expect(w).toContain('"catch-up for the missed previous day"');
    expect(w).toMatch(/spoken day %d disagrees with the date/);
  });

  it("builds the LFMD from the 'Learnings from my diary' section, and the Summary from the teaser clip (Kevin, 3 Sep 2026)", () => {
    const src = readFileSync(RENDER, 'utf8');
    expect(src).toContain('d(?:ia|ie|ai)\\w*\\b(?!\\s+of\\s+(?:a|an|the)\\b(?!\\s+day\\b))');  // the show's own name is not a Learnings section (2056 teaser, 13 Sep 2026); 'of the day' is (27 Sep 2026)
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

  it('the Learnings-only rebuild never touches the 16:9 master: its branch comes before the sign-off pause search (8 Sep 2026, 2196 rebuild died on masters["16:9"])', () => {
    const r = readFileSync(path.join(DIR, 'render.py'), 'utf8');
    const branch = r.indexOf('if role == "lfmd-only":');
    const pause = r.indexOf('find_pause(masters["16:9"]');
    expect(branch).toBeGreaterThan(0);
    expect(pause).toBeGreaterThan(branch);
    expect(r.indexOf('if role == "lfmd-only":', branch + 1)).toBe(-1); // one branch, not a second copy after the full render
  });

  it("pans to what Kevin points at: speech cue + raised arm -> a planned pan in the reframer, listed on the card; the sign was proven on 2054 (9 Sep 2026)", () => {
    const pt = readFileSync(path.join(DIR, 'pointing.py'), 'utf8');
    expect(pt).toContain('yaw = -PAN_YAW if side == "right" else PAN_YAW');
    expect(pt).toContain('if not pose_available(): return []'); // no pose library, no pan, and the card says so
    expect(pt).toContain('mp.solutions.pose.Pose(static_image_mode=True'); // mediapipe 0.10 CPU solution: 1.0 aborts wanting Metal from a headless process
    const st = readFileSync(path.join(DIR, 'stab.py'), 'utf8');
    // fps is late-bound since 12 Oct 2026 (finding 20261012-phase-3-837): the rate comes from the
    // source clip, so a signature default of FPS would freeze it at import and re-break the judder.
    expect(st).toContain('def apply_pans(F_sm, pans, fps=None)');
    expect(st).toContain('ap.add_argument("--pans"');
    expect(st).toContain('if pans: cmd += ["--pans", pans]'); // slices carry it
    const r = readFileSync(path.join(DIR, 'render.py'), 'utf8');
    expect(r).toContain('pans = find_pans_for(clip, srt); e["pans"] = pans');
    expect(r).toContain('if master_complete(dest, clip) and had == (pans or ""):'); // a master without the pans is not reused
    const a = readFileSync(path.join(DIR, 'approval.py'), 'utf8');
    expect(a).toContain('def pans_for(day, ledger)');
    expect(a).toMatch(/build_card\(day, full, recs\["Learnings From My Diary"\], recs\["Short Form Video"\], headline, pans_for\(day, ledger\), proof\)/);  // pans and the output gate's proof (10 Sep 2026)
  });
});

// 18 Nov 2026, finding 20261020-agent-dispatch-1016 (with 20261020-agent-dispatch-1015, the same fix). Day 2106 holds
// long 001 (14:18:15, 428.2 s), short 002 (14:25:28), a second long 003 (14:26:34, 384.5 s) and short 004 (14:33:12).
// Kevin's 10 Oct note: the episode is 001 with its own summary 002. On 18 Oct the redo let 004, which names no day,
// replace 002, and 003 sat "failed, needs a person", which held the card for a ruling he had already given. Invented
// clip names on the real clock; the Python is driven, not grepped.
describe('finding 20261020-agent-dispatch-1016: a teaser is the summary of the long recording it follows', () => {
  const run = (body) => JSON.parse(execFileSync('python3', ['-c', `
import sys, os, json, tempfile, io, contextlib, datetime as dt
sys.path.insert(0, ${JSON.stringify(DIR)})
import render, watch
watch.save_ledger = lambda l: None
D, FLAG, NO_DAY = "2026-03-07", "spoken day 2101 disagrees with the date (2106); date used, flagged", "no spoken day, date used"
led = {"VID_A_141815_001.insv": {"date": D, "hms": "141815", "duration": 428.2, "role": "episode", "episode": 2106,
                                 "status": "rendered", "rendered": "2026-11-19T01:00:00", "episode_reason": FLAG, "day": 2106},
       "VID_A_142528_002.insv": {"date": D, "hms": "142528", "duration": 47.5, "status": "new", "day": 2106,
                                 "role": "teaser", "episode": 2106},   # as redo-day leaves a clip that had rendered
       "VID_A_142634_003.insv": {"date": D, "hms": "142634", "duration": 384.5, "role": "episode", "episode": 2106,
                                 "status": watch.SET_ASIDE, "day": 2106},
       "VID_A_143312_004.insv": {"date": D, "hms": "143312", "duration": 35.8, "status": "new", "day": 2106}}
res = None
with contextlib.redirect_stdout(io.StringIO()):
${body.split('\n').map((l) => '    ' + l).join('\n')}
print(json.dumps(res))
`], { encoding: 'utf8', cwd: DIR }));

  it('pairs each short clip with the long recording before it, by start time and length', () => {
    const r = run(`res = [render.long_recording_before(k, led) and render.long_recording_before(k, led)[0] for k in sorted(led)]`);
    // 003 also follows 001; only a SHORT clip is ever paired to one (summary_rival)
    expect(r).toEqual([null, 'VID_A_141815_001.insv', 'VID_A_141815_001.insv', 'VID_A_142634_003.insv']);
  });

  it('sets 004 aside with the refused 003, whichever teaser renders first, and 002 stays the summary', () => {
    const r = run(`
first = render.summary_rival("VID_A_143312_004.insv", 2106, NO_DAY, led)[0]
ok = render.summary_rival("VID_A_142528_002.insv", 2106, FLAG, led)
led["VID_A_142528_002.insv"].update(role="teaser", episode=2106, status="rendered", episode_reason=FLAG)
after = render.summary_rival("VID_A_143312_004.insv", 2106, NO_DAY, led)[0]
res = [first, ok, after]`);
    expect(r).toEqual(['set-aside', ['', ''], 'set-aside']);
  });

  it('004 rendered as the summary by an older night and 003 now set aside: 002 takes the summary back', () => {
    const r = run(`
led["VID_A_143312_004.insv"].update(role="teaser", episode=2106, status="rendered", episode_reason=NO_DAY)
res = render.summary_rival("VID_A_142528_002.insv", 2106, FLAG, led)[0]`);
    expect(r).toBe('replace');
  });

  it('a teaser that names no day never replaces a flagged summary, even with no camera times to pair by', () => {
    const r = run(`res = render.summary_rival("b.insv", 2106, NO_DAY, {"a.insv": {"episode": 2106, "role": "teaser", "status": "rendered", "episode_reason": FLAG}})`);
    expect(r[0]).toBe('refuse');
    expect(r[1]).toContain('names no day');
  });

  it('the card goes back when 003 and 004 are set aside, where "failed, needs a person" held it', () => {
    const r = run(`
led["VID_A_142528_002.insv"].update(role="teaser", episode=2106, status="rendered", episode_reason=FLAG)
led["VID_A_143312_004.insv"].update(role="teaser", episode=2106, status=watch.SET_ASIDE)
copy = {"YouTube Copy": "copy", "AI Last Run": "2026-11-19T02:00:00Z"}
receipt = dt.datetime(2026, 11, 18, 12, 0).timestamp()
now = render.resubmit_due(2106, led, receipt, {"verdict": "changes"}, copy)
led["VID_A_142634_003.insv"].update(status="failed", error="x", requeued="not requeued: it needs a person")
before = render.resubmit_due(2106, led, receipt, {"verdict": "changes"}, copy)
res = [now, before]`);
    expect(r[0]).toBe('');
    expect(r[1]).toContain('needs a ruling from Kevin');
  });

  it('redo-day puts a set-aside clip back to new and decides it again', () => {
    const r = run(`
tmp = tempfile.mkdtemp()
led["VID_A_143312_004.insv"].update(role="teaser", episode=2106, status=watch.SET_ASIDE, set_aside="follows 003")
state = {"2106": {"task": "recFAKE0000002106", "verdict": "changes", "feedback": "The summary is from the wrong recording."}}
rp = os.path.join(tmp, "r.md"); open(rp, "w").write("- The summary is from the wrong recording. → re-rendered\\n")
render.redo_day(2106, rp, "test", ledger=led, state=state, root=tmp, today=dt.date(2026, 11, 18), last_night=None, running=False)
res = [[led[k]["status"], led[k].get("set_aside"), led[k].get("role")] for k in ("VID_A_142634_003.insv", "VID_A_143312_004.insv")]`);
    expect(r).toEqual([['new', null, null], ['new', null, null]]);
  });
});

// Review of PR 979 (18 Nov 2026). The first cut set a teaser aside whenever the last earlier long recording of the
// date was set aside: no gap check, no episode check, and no check that the day kept a summary. A real part 2 the
// continuation check misses was set aside silently, and a recording that crossed midnight never paired.
describe('finding 20261020-agent-dispatch-1016 review: a teaser is set aside only when it is plainly the refused recording\'s', () => {
  const py = (body) => JSON.parse(execFileSync('python3', ['-c', `
import sys, os, json, io, contextlib, datetime as dt
sys.path.insert(0, ${JSON.stringify(DIR)})
import render, watch
watch.save_ledger = lambda l: None
OK, NO_DAY = "spoken day matches the date", "no spoken day, date used"
def clip(date, hms, dur, **kw): return dict({"date": date, "hms": hms, "duration": dur, "status": "new"}, **kw)
def long(date, hms, dur, ep, status="rendered"): return clip(date, hms, dur, role="episode", episode=ep, status=status)
res = None
with contextlib.redirect_stdout(io.StringIO()):
${body.split('\n').map((l) => '    ' + l).join('\n')}
print(json.dumps(res))
`], { encoding: 'utf8', cwd: DIR }));

  it('long 07:00, set-aside long 07:10, the real summary at 19:00 naming the right day: rendered, not set aside', () => {
    const r = py(`
led = {"l1": long("2026-03-07", "070000", 400.0, 2106), "l2": long("2026-03-07", "071000", 380.0, 2106, watch.SET_ASIDE),
       "t": clip("2026-03-07", "190000", 40.0), "u": clip("2026-03-07", "190200", 30.0, role="teaser", episode=2106)}
res = [render.summary_rival("t", 2106, OK, led), render.summary_rival("t", 2106, NO_DAY, led)[0]]`);
    expect(r).toEqual([['', ''], '']);
  });

  it('a teaser for day 2105 recorded the next day, after a set-aside 2106 long: never set aside', () => {
    const r = py(`
led = {"l1": long("2026-03-07", "080000", 400.0, 2106), "l2": long("2026-03-07", "081000", 380.0, 2106, watch.SET_ASIDE),
       "t": clip("2026-03-07", "081700", 40.0), "s": clip("2026-03-07", "080700", 45.0, role="teaser", episode=2106)}
res = render.summary_rival("t", 2105, "teaser for day 2105, recorded the next day (it says day 2105)", led)`);
    expect(r).toEqual(['', '']);
  });

  it("never sets aside the day's last remaining summary", () => {
    const r = py(`
led = {"c001": long("2026-03-07", "141815", 428.2, 2106), "c003": long("2026-03-07", "142634", 384.5, 2106, watch.SET_ASIDE),
       "c004": clip("2026-03-07", "143312", 35.8),
       "c002": clip("2026-03-07", "142528", 47.5, role="teaser", episode=2106, status="failed", error="ffmpeg died")}
res = render.summary_rival("c004", 2106, NO_DAY, led)`);
    expect(r).toEqual(['', '']);
  });

  it('a second long recording that names no day may be a missed part 2: held for a person and listed, as before', () => {
    const r = py(`
held, aside = {"role": "episode"}, {"role": "episode"}
render.second_long_recording(held, 2106, "c001", None)
render.second_long_recording(aside, 2106, "c001", 2102)
led = {"c001": long("2026-03-07", "141815", 428.2, 2106), "c003": dict(held, episode=2106, day=2106),
       "c002": clip("2026-03-07", "142528", 47.5, role="teaser", episode=2106, status="rendered")}
receipt = dt.datetime(2026, 3, 8).timestamp()
copy = {"YouTube Copy": "c", "AI Last Run": "2099-01-01T00:00:00Z"}
led["c001"]["rendered"] = "2099-01-01T00:00:00"
why_held = render.resubmit_due(2106, led, receipt, {"verdict": "changes"}, copy)
led["c003"] = dict(aside, episode=2106, day=2106)
why_aside = render.resubmit_due(2106, led, receipt, {"verdict": "changes"}, copy)
res = [held["status"], held.get("requeued"), bool(held.get("render_failed")), aside["status"], why_held, why_aside]`);
    expect(r.slice(0, 4)).toEqual(['failed', 'not requeued: it needs a person', true, 'set-aside']);
    expect(r[4]).toContain('needs a ruling from Kevin');
    expect(r[5]).toBe('');
  });

  it('pairs across midnight on absolute time, and the teaser takes the episode of the recording it follows', () => {
    const r = py(`
led = {"l1": long("2026-03-07", "234000", 400.0, 2106), "s": clip("2026-03-07", "234710", 40.0, role="teaser", episode=2106),
       "l2": long("2026-03-07", "235000", 300.0, 2106, watch.SET_ASIDE), "t": clip("2026-03-08", "000030", 35.0),
       "a": long("2026-03-08", "235200", 400.0, 2107), "b": clip("2026-03-09", "000110", 40.0)}
lead_b = render.long_recording_before("b", led)
day_b = render.teaser_day_from_lead("b", "teaser", None, 2108, NO_DAY, led)
day_t, why_t = render.teaser_day_from_lead("t", "teaser", None, 2107, NO_DAY, led)
named = render.teaser_day_from_lead("t", "teaser", 2107, 2107, OK, led)
res = [lead_b and lead_b[0], day_b[0], day_t, render.summary_rival("t", day_t, why_t, led)[0], named[0]]`);
    expect(r).toEqual(['a', 2107, 2106, 'set-aside', 2107]);
  });
});

// Re-review of PR 979 (18 Nov 2026): a clip that follows the set-aside recording and SAYS the right day still replaced
// the summary that follows the episode (the 18 Oct fault by another route); a second long recording naming the
// episode's own day was set aside, though a missed part 2 opens that way; and when 004 rendered before 002, 002 had no
// recorded length, so 004 became the summary. The decision now reads every clip of the day, whatever the order.
describe('finding 20261020-agent-dispatch-1016 re-review: the right summary whatever 004 says and whichever renders first', () => {
  const py = (body) => JSON.parse(execFileSync('python3', ['-c', `
import sys, os, json, io, contextlib, datetime as dt
sys.path.insert(0, ${JSON.stringify(DIR)})
import render, watch
FLAG = "spoken day 2101 disagrees with the date (2106); date used, flagged"
D = "2026-03-07"
led = {"c001": {"date": D, "hms": "141815", "duration": 428.2, "role": "episode", "episode": 2106, "status": "rendered", "day": 2106},
       "c002": {"date": D, "hms": "142528", "duration": 47.5, "role": "teaser", "episode": 2106, "status": "rendered",
                "episode_reason": FLAG, "day": 2106},
       "c003": {"date": D, "hms": "142634", "duration": 384.5, "role": "episode", "episode": 2106, "status": watch.SET_ASIDE, "day": 2106},
       "c004": {"date": D, "hms": "143312", "status": "pulled", "day": 2106}}
res = None
with contextlib.redirect_stdout(io.StringIO()):
${body.split('\n').map((l) => '    ' + l).join('\n')}
print(json.dumps(res))
`], { encoding: 'utf8', cwd: DIR }));

  it('004 saying "day 2106" after the set-aside 003 never replaces 002, which follows the episode: it is set aside', () => {
    expect(py(`res = render.summary_rival("c004", 2106, "spoken day matches the date", led)[0]`)).toBe('set-aside');
  });

  it("a second long recording naming the episode's own day is held for a person; one naming another day is set aside", () => {
    const r = py(`
same, other = {}, {}
render.second_long_recording(same, 2106, "c001", 2106)
render.second_long_recording(other, 2106, "c001", 2102)
res = [same["status"], same.get("requeued"), other["status"]]`);
    expect(r).toEqual(['failed', 'not requeued: it needs a person', 'set-aside']);
  });

  it('whichever renders first, 002 ends as the summary: set aside at once when redo-day kept its role, else taken back', () => {
    const r = py(`
kept = render.summary_rival("c004", 2106, "no spoken day, date used", dict(led, c002=dict(led["c002"], status="pulled")))[0]
led["c002"] = {"date": D, "hms": "142528", "status": "pulled", "day": 2106}   # a fresh day: 002 not yet known as a teaser
first = render.summary_rival("c004", 2106, "no spoken day, date used", led)
led["c004"].update(role="teaser", episode=2106, status="rendered", episode_reason="no spoken day, date used")
led["c002"].update(role="teaser", episode=2106, duration=47.5)
res = [kept, first, render.summary_rival("c002", 2106, FLAG, led)[0]]`);
    expect(r).toEqual(['set-aside', ['', ''], 'replace']);
  });
});

// Third review of PR 979 (18 Nov 2026): the refuse branch for a clip after the set-aside recording marked it "failed,
// needs a person", which held the card for a ruling: the very symptom 1016 removes. And an UNRENDERED clip counted as
// the day's other summary on the gap to the next clip alone, so unrendered B-roll (redo-day resets it to new) let 004
// be set aside and left the day with no summary. Only a clip in the summary role, rendered or waiting, counts now.
describe('finding 20261020-agent-dispatch-1016 third review: set aside, never held; B-roll is never the other summary', () => {
  const py = (body) => JSON.parse(execFileSync('python3', ['-c', `
import sys, os, json, io, contextlib, datetime as dt
sys.path.insert(0, ${JSON.stringify(DIR)})
import render, watch
FLAG = "spoken day 2101 disagrees with the date (2106); date used, flagged"
D = "2026-03-07"
led = {"c001": {"date": D, "hms": "141815", "duration": 428.2, "role": "episode", "episode": 2106, "status": "rendered",
                "day": 2106, "rendered": "2099-01-01T00:00:00"},
       "c002": {"date": D, "hms": "142528", "duration": 47.5, "role": "teaser", "episode": 2106, "status": "rendered",
                "episode_reason": FLAG, "day": 2106},
       "c003": {"date": D, "hms": "142634", "duration": 384.5, "role": "episode", "episode": 2106, "status": watch.SET_ASIDE, "day": 2106},
       "c004": {"date": D, "hms": "143312", "status": "pulled", "day": 2106}}
res = None
with contextlib.redirect_stdout(io.StringIO()):
${body.split('\n').map((l) => '    ' + l).join('\n')}
print(json.dumps(res))
`], { encoding: 'utf8', cwd: DIR }));

  it('004 saying "day 2106" is set aside, the card is not held, and 002 stays the summary', () => {
    const r = py(`
what, why = render.summary_rival("c004", 2106, "spoken day matches the date", led)
if what == "set-aside": render.set_aside(led["c004"], why)
led["c004"].update(role="teaser", episode=2106)
copy = {"YouTube Copy": "c", "AI Last Run": "2099-01-01T01:00:00Z"}
res = [what, led["c004"]["status"], render.resubmit_due(2106, led, dt.datetime(2026, 3, 8).timestamp(), {"verdict": "changes"}, copy),
       led["c002"]["status"]]`);
    expect(r).toEqual(['set-aside', 'set-aside', '', 'rendered']);
  });

  it("an unrendered B-roll clip in the gap after the episode is never the day's other summary", () => {
    const r = py(`
led.pop("c002")
led["cb"] = {"date": D, "hms": "142528", "status": "new", "day": 2106, "reset": "redo-day"}
res = render.summary_rival("c004", 2106, "no spoken day, date used", led)`);
    expect(r).toEqual(['', '']);
  });
});
