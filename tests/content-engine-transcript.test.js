import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CE = resolve(ROOT, 'scripts/content-engine');

// 2 Oct 2026: render.py wrote Ep<day>_transcript.txt for EVERY clip of a day. A day has a long episode clip and a
// short teaser, the teaser renders after the episode, so the teaser's words replaced the episode's. Measured that
// day on the shared drive: 26 of the 36 stored files were teaser length (501 to 985 characters; 2081's was 542).
// qa.py reads that file to ask "did he say the diary line?", so on those days the answer was always no.
//
// Everything here drives the real render.run, render.process, render.publish_to_drive and qa.gate on a day with two
// clips. Whisper, ffmpeg, Claude, Airtable and Google Drive are stubbed; the ledger and the day folder are temp files.
const J = (x) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

const HARNESS = String.raw`
import sys, os, io, json, tempfile, contextlib, types, subprocess
sys.path.insert(0, ${JSON.stringify(CE)})
import render, watch, qa, publish, approval

DAY = 2090
EP_KEY, TE_KEY = "VID_20260219_070000_00_001.insv", "VID_20260219_081500_00_002.insv"
NAMES = render.output_names(DAY)
SECONDS = {EP_KEY: "400", TE_KEY: "40", NAMES["full"]: "400", NAMES["full_yt"]: "400", NAMES["podcast"]: "392", NAMES["summary"]: "40"}


def cues(lines):
    return "".join("%d\n00:%02d:%02d,000 --> 00:%02d:%02d,900\n%s\n\n" % (i + 1, i // 60, i % 60, i // 60, i % 60, t) for i, t in enumerate(lines))


class Probe:
    def __init__(self, out): self.stdout, self.returncode = out, 0


real_run = subprocess.run
def fake_run(cmd, *a, **k):
    if os.path.basename(cmd[0]) == "ffprobe": return Probe(SECONDS.get(os.path.basename(cmd[-1]), ""))
    return real_run(cmd, *a, **k)
subprocess.run = fake_run


def two_clip_day(ep_text, ep_captions, te_text, api=False, seed=None, ep_srt=None):
    """Render a day's long clip and its teaser through render.run. Returns the ledger, the day folder and the upload names."""
    tmp = tempfile.mkdtemp(); root = os.path.join(tmp, "edited")
    render.EDITED_ROOT = publish.EDITED_ROOT = root
    clips = {k: os.path.join(tmp, k) for k in (TE_KEY, EP_KEY)}
    for p in clips.values(): open(p, "w").write("x")
    # the teaser is listed first and is the smaller clip: run() still renders the episode first
    led = {TE_KEY: {"status": "pulled", "local": clips[TE_KEY], "date": "2026-02-19", "day": DAY, "size": 1000, "drive_id": "t"},
           EP_KEY: {"status": "pulled", "local": clips[EP_KEY], "date": "2026-02-19", "day": DAY, "size": 9000, "drive_id": "e"}}
    led[EP_KEY].update(seed or {})
    text = {EP_KEY: ep_text, TE_KEY: te_text}

    def transcribe(clip, workdir):
        t = text[os.path.basename(clip)]
        open(os.path.join(workdir, "transcript.txt"), "w").write(t)
        said = ep_srt if ep_srt and os.path.basename(clip) == EP_KEY else ["nothing here names the section"] * 3
        srt = os.path.join(workdir, "transcript.srt"); open(srt, "w").write(cues(said))
        return t, srt

    def build_outputs(masters, srt, day, title, workdir, lfmd=None, role="episode"):
        kinds = ["summary"] if role == "teaser" else ["full", "full_yt", "podcast", "full_srt"]
        paths = {k: os.path.join(workdir, NAMES[k]) for k in kinds}
        for k, p in paths.items(): open(p, "w").write(cues(ep_captions) if k == "full_srt" else "media")
        return paths

    def make_thumbnail(master, duration, text, day, workdir, lines=None):
        p = os.path.join(workdir, "Episode_%d_Thumbnail.png" % day); open(p, "wb").write(b"0" * 30000)
        return p, ("GET YOUR", "TEAM IN", "claude")

    # Google Drive is never reached: this stands in for drive_api on both routes
    uploads = []
    drive = types.ModuleType("drive_api")
    drive.KEY_FILE = clips[EP_KEY] if api else os.path.join(tmp, "no-key")     # no key = the Mac's Drive folder route
    drive.EDITED_PATH = ["Edited"]; drive.folder_id = lambda path, create=False: "folder"
    def upload(local, parent, name=None, mime="application/octet-stream"):
        uploads.append(name or os.path.basename(local)); return "id%d" % len(uploads)
    drive.upload = upload; drive.link = lambda fid: "https://drive.google.com/file/d/%s/view" % fid
    sys.modules["drive_api"] = drive
    sys.modules["pointing"] = types.SimpleNamespace(pans_arg=lambda pans: "")

    render.transcribe, render.build_outputs, render.make_thumbnail = transcribe, build_outputs, make_thumbnail
    render.render_masters = lambda clip, workdir, **k: {"16:9": "m169", "9:16": "m916"}
    render.find_pans_for = lambda clip, srt: []
    render.thumb_lines = lambda t: ("GET YOUR", "TEAM IN", "claude")
    render.horizon_for = lambda masters: {"1": 2.0, "10": 1.0}
    render.source_fps = lambda clip: 24.0
    render.find_or_create_record = lambda *a, **k: ("recTEST", "found")
    watch._airtable = lambda *a, **k: {}
    watch.drive_id = lambda p: "synced"; watch.drive_link = lambda fid: "on the Mac's Drive folder"
    watch.load_ledger = lambda: led; watch.save_ledger = lambda l: None
    approval.load_state = lambda: {}
    render.run(limit=5, keep=True)
    folder = os.path.join(root, render.hundreds_folder(DAY), str(DAY))
    return led, folder, uploads


def read(folder, name):
    p = os.path.join(folder, name)
    return open(p).read() if os.path.exists(p) else None


def gate(led):
    ok, failures, passed = qa.gate(DAY, led)
    return {"ok": ok, "failures": failures, "passed": passed}
`;

function py(body) {
  const script = `${HARNESS}
out, err = io.StringIO(), io.StringIO(); res = None
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
${body.split('\n').map((l) => '    ' + l).join('\n')}
print(json.dumps({"res": res, "out": out.getvalue(), "err": err.getvalue()}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }));
}

// "the latest in my diary" is his Learnings line as whisper heard it on 2056. It has no "learn" in it, so the
// near-miss guard cannot stand in for it: only the reader of the episode's own words can find it.
const EP_SAID = 'Welcome back. Today I talk about why rest days matter for every runner out there. So the latest in my diary is that you should rest more than you think. Thank you as always and see you tomorrow.';
const EP_SILENT = 'Welcome back. Today I talk about why rest days matter for every runner out there. Rest more than you think and you will run for longer. Thank you as always and see you tomorrow.';
const TEASER = 'In this episode you will hear why rest days matter and how I plan them around the running streak every single week.';
const PLAIN = Array(30).fill('just some words here now');
const SAID_CAPTIONS = ['So the latest in my', 'diary is that you should', 'rest more than you think', ...PLAIN];
const LEARNINGS = ['Learnings clip (captions)', 'Learnings clip (clean, for Shorts)', 'Learnings caption file'];

describe('the day folder keeps the episode transcript, whatever renders after it', () => {
  it('BACK-TEST: the teaser renders after the episode and does not replace its transcript', () => {
    const r = py(`
led, folder, uploads = two_clip_day(${J(EP_SAID)}, ${J(PLAIN)}, ${J(TEASER)})
res = {"roles": {k: [v.get("role"), v.get("status"), v.get("error")] for k, v in led.items()}, "files": sorted(os.listdir(folder)),
       "episode": read(folder, "Ep%d_transcript.txt" % DAY), "teaser": read(folder, "Ep%d_Summary_transcript.txt" % DAY)}`);
    expect(r.res.roles).toEqual({ 'VID_20260219_081500_00_002.insv': ['teaser', 'rendered', null], 'VID_20260219_070000_00_001.insv': ['episode', 'rendered', null] });
    expect(r.out).toContain('VID_20260219_081500_00_002.insv rendered after its episode');
    expect(r.res.episode).toBe(EP_SAID);
    expect(r.res.teaser).toBe(TEASER);
  });

  it('BACK-TEST: through the Drive API the episode transcript is uploaded once, and the teaser under its own name', () => {
    const r = py(`
led, folder, uploads = two_clip_day(${J(EP_SAID)}, ${J(PLAIN)}, ${J(TEASER)}, api=True)
res = {"uploads": uploads}`);
    const names = r.res.uploads.filter((n) => n.endsWith('.txt'));
    expect(names).toEqual(['Ep2090_transcript.txt', 'Ep2090_Summary_transcript.txt']);
    expect(r.res.uploads.indexOf('Ep2090_transcript.txt')).toBeLessThan(r.res.uploads.indexOf('Ep2090_Summary.mp4'));
  });
});

describe('a render starts the episode\'s Learnings acceptance afresh', () => {
  it('BACK-TEST: an early start accepted by hand does not survive the episode being rendered again', () => {
    const r = py(`
led, folder, uploads = two_clip_day(${J(EP_SAID)}, ${J(PLAIN)}, ${J(TEASER)}, seed={"lfmd_early_ok": [75.8, 254.8]})
res = {"status": led[EP_KEY]["status"], "accepted": led[EP_KEY].get("lfmd_early_ok", "dropped"), "closes": led[EP_KEY].get("lfmd_closes_talk", "not recorded")}`);
    expect(r.res).toEqual({ status: 'rendered', accepted: 'dropped', closes: false });      // no clip was cut, so nothing closes the talk
  });
});

describe('a render records whether the Learnings clip closes the talk', () => {
  it('BACK-TEST: the diary line near the end, then the sign-off and nothing after: recorded True with the window', () => {
    const talk = [...Array(30).fill('some of the talk goes here'), 'so the learnings from my diary today are', ...Array(25).fill('that you should rest more'), 'thank you as always', '[BLANK_AUDIO]'];
    const r = py(`
led, folder, uploads = two_clip_day(${J(EP_SAID)}, ${J(PLAIN)}, ${J(TEASER)}, ep_srt=${J(talk)})
res = {"window": list(led[EP_KEY]["lfmd_window"]), "closes": led[EP_KEY].get("lfmd_closes_talk"), "teaser": led[TE_KEY].get("lfmd_closes_talk")}`);
    expect(r.res).toEqual({ window: [30, 56.9], closes: true, teaser: false });
  });
});

describe('the output gate reads the episode, not the teaser', () => {
  it('CONTROL: no diary line anywhere and the same day passes the gate, or the refusals below prove nothing', () => {
    const r = py(`
led, folder, uploads = two_clip_day(${J(EP_SILENT)}, ${J(PLAIN)}, ${J(TEASER)})
res = gate(led)`);
    expect(r.res.failures).toEqual([]);
    expect(r.res.ok).toBe(true);
    expect(r.res.passed.find(([n]) => n === 'Learnings section')[1]).toContain('by design');
  });

  it('BACK-TEST: the episode said the diary line and no clip was cut, so the card is refused (the teaser used to hide it)', () => {
    const r = py(`
led, folder, uploads = two_clip_day(${J(EP_SAID)}, ${J(PLAIN)}, ${J(TEASER)})
res = dict(gate(led), window=led[EP_KEY].get("lfmd_window"))`);
    expect(r.res.window).toBe(null);
    expect(r.res.ok).toBe(false);
    expect(r.res.failures.map(([n]) => n)).toEqual(LEARNINGS);
    expect(r.res.failures[0][1]).toContain('diary phrase found in the transcript');
  });

  it('BACK-TEST: a day stored before the fix (the file holds the teaser) is read from the episode captions', () => {
    const r = py(`
led, folder, uploads = two_clip_day(${J(EP_SAID)}, ${J(SAID_CAPTIONS)}, ${J(TEASER)})
open(os.path.join(folder, "Ep%d_transcript.txt" % DAY), "w").write(${J(TEASER)})      # the 26 stored files, as they are
res = gate(led)`);
    expect(r.res.ok).toBe(false);
    expect(r.res.failures.map(([n]) => n)).toEqual(LEARNINGS);
    expect(r.res.failures[0][1]).toContain('diary phrase found in the captions');
  });

  it('BACK-TEST: a transcript the Drive folder does not show yet no longer reads as "he did not say it"', () => {
    const r = py(`
led, folder, uploads = two_clip_day(${J(EP_SAID)}, ${J(SAID_CAPTIONS)}, ${J(TEASER)})
os.remove(os.path.join(folder, "Ep%d_transcript.txt" % DAY))
res = gate(led)`);
    expect(r.res.ok).toBe(false);
    expect(r.res.failures[0]).toEqual(['Learnings clip (captions)', '0 s; diary phrase found in the captions']);
  });
});
