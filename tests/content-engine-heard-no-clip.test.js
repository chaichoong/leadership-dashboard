// No Learnings hold waits for a person (16 Nov 2026, the rule PR 948 applied to the no-line case, now applied to
// main's own two holds). Until today the output gate REFUSED a card when the diary line was heard in the episode's
// transcript or captions, or something sounded like it (a near miss), but no Learnings clip had been cut, and only a
// person running `render.py redo --day N --only lfmd` could clear it. Episode 2138 sat behind that from 12 Nov,
// read 47 times, with no card.
//
// Now: one automatic retry by the pipeline (the approval run puts the day on the night's Learnings rebuild list,
// which transcribes and searches it again with today's finder and records that it did), then the card goes to Kevin
// as normal with one line at the top saying what was heard, that no clip could be cut, and where it looked.
// Everything here runs on invented episode data: no video, no network, no Airtable, no Drive, never the live lists.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CE = path.resolve(__dirname, '..', 'scripts', 'content-engine');
const J = (x) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

const HARNESS = String.raw`
import sys, os, io, json, tempfile, contextlib, types, subprocess, datetime as dt
sys.path.insert(0, ${JSON.stringify(CE)})
import render, watch, qa, approval
render.REDO_LFMD_FILE = os.path.join(tempfile.mkdtemp(), "content_engine_redo_lfmd")      # never the live list
SECONDS = {}
qa.seconds = lambda p, **k: (SECONDS.get(os.path.basename(p or ""), 0.0) if p else 0.0)
def gate_day(entry, captions, transcript="no section named today", day=2138):
    tmp = tempfile.mkdtemp()
    def mk(name, body="media", mode="w"):
        p = os.path.join(tmp, name); open(p, mode).write(body); return p
    srt = "".join("%d\n%s --> %s\n%s\n\n" % (i + 1, render.srt_ts(i * 5), render.srt_ts(i * 5 + 4), t) for i, t in enumerate(captions))
    files = {"full": mk("full.mp4"), "full_yt": mk("full_yt.mp4"), "podcast": mk("pod.mp3"), "lfmd": "", "lfmd_yt": "", "summary": "",
             "full_srt": mk("full.srt", srt), "lfmd_srt": "", "thumb": mk("t.png", b"0" * 30000, "wb"), "transcript": mk("tr.txt", transcript)}
    n = len(captions) * 5
    SECONDS.update({"full.mp4": n + 7.0, "full_yt.mp4": n + 7.0, "pod.mp3": float(n)})
    ep = dict({"episode": day, "role": "episode", "status": "rendered", "lfmd_window": None, "duration": float(n), "date": "2026-04-08"}, **entry)
    ok, failures, passed = qa.gate(day, {"VID_A.insv": ep}, files)
    return {"ok": ok, "failures": failures, "passed": passed}
`;

function py(body) {
  const script = `${HARNESS}
out, err = io.StringIO(), io.StringIO(); res = None
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
${body.split('\n').map((l) => '    ' + l).join('\n')}
print(json.dumps({"res": res, "out": out.getvalue(), "err": err.getvalue()}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8', cwd: CE }));
}

const TALK = Array(50).fill('and that is how the day went for me');
// a near miss: the shape of 2138's line, which the finder cannot cut (the apostrophe breaks its loose route)
const NEAR = [...TALK, "so the learning somewhere I've died for today", 'is that disappointments pass', ...Array(10).fill('keep going'), 'stay positive and I will see you tomorrow'];
const PLAIN = [...TALK, 'stay positive and I will see you tomorrow'];

describe('a Learnings line heard with no clip: one automatic retry, then the card, never a person', () => {
  it('BACK-TEST: a near miss with no clip waits for the retry (a wait the pipeline owns), never a refusal', () => {
    const r = py(`res = gate_day({}, ${J(NEAR)})`).res;
    expect(r.ok).toBe(false);
    expect(r.failures.map(([n]) => n)).toEqual(['Learnings re-search']);
    expect(r.failures[0][1]).toContain("the captions say '...");
    expect(r.failures[0][1]).toContain('which sounds like the diary line');
    expect(r.failures[0][1]).toContain("tonight's Learnings rebuild transcribes the recording again");
  });

  it('the approval run queues that retry once on the night\'s Learnings rebuild list, and records a wait, not a block', () => {
    const r = py(`
g = gate_day({}, ${J(NEAR)})
real = qa.gate
qa.gate = lambda day, ledger=None, files=None: (g["ok"], g["failures"], g["passed"])
approval.save_state = lambda st: None
state = {"2138": {"qa_blocked": {"at": "2026-11-16T09:42:24", "failures": ["Learnings section: no clip was cut"], "since": "2026-11-12T07:16:02"}}}
try:
    proof = approval.output_gate(2138, {}, state)
    approval.output_gate(2138, {}, state)
finally:
    qa.gate = real
res = {"proof": proof, "list": open(render.REDO_LFMD_FILE).read(), "state": sorted(state["2138"])}`).res;
    expect(r.proof).toBe(null);
    expect(r.list.trim().split('\n')).toHaveLength(1);
    expect(r.list).toMatch(/^2138 auto re-search \d{4}-\d{2}-\d{2}: /);
    expect(r.state).toEqual(['qa_waiting']);          // the old qa_blocked is gone: nothing for a person to clear
  });

  it('the retry that cuts nothing records it, comes off the list and blocks nothing', () => {
    const r = py(`
tmp = tempfile.mkdtemp(); clip = os.path.join(tmp, "c.insv"); open(clip, "w").write("x")
led = {"c.insv": {"episode": 2138, "role": "episode", "status": "rendered", "local": clip, "date": "2026-04-08", "drive_id": "d", "duration": 668.0, "intro_at": 31.06}}
saved = []
watch.load_ledger = lambda: led; watch.save_ledger = lambda l: saved.append(json.loads(json.dumps(l)))
srt = os.path.join(tmp, "s.srt")
open(srt, "w").write("1\\n00:08:40,000 --> 00:08:50,000\\nso the learning somewhere I've died for today is that\\n\\n2\\n00:10:50,000 --> 00:11:00,000\\nstay positive and see you tomorrow\\n")
render.transcribe = lambda c, w: ("text", srt)
approval.load_state = lambda: {"2138": {"task": "recFAKE0000002138", "verdict": "changes", "feedback": "Please fix the title."}}
blocked = []
render.block_sent_back = lambda day, card, why, **k: blocked.append(day)
open(render.REDO_LFMD_FILE, "w").write("2138 auto re-search 2026-11-16: no clip\\n")
render.redo_requested(render.REDO_LFMD_FILE)
last = saved[-1]["c.insv"]
res = {"retried": (last.get("lfmd_retried") or {}).get("finder") == render.finder_code(), "found": (last.get("lfmd_retried") or {}).get("found"),
       "list": open(render.REDO_LFMD_FILE).read(), "blocked": blocked}`).res;
    expect(r.retried).toBe(true);
    expect(r.found).toBe(false);
    expect(r.list).toBe('');
    expect(r.blocked).toEqual([]);                    // a sent-back card is never blocked by it
  });

  it('after the retry the card goes to Kevin as normal, its line saying what was heard and where it looked', () => {
    const r = py(`
g = gate_day({"lfmd_retried": {"finder": render.finder_code(), "found": False}}, ${J(NEAR)})
res = {"ok": g["ok"], "line": [d for n, d in g["passed"] if n == "Learnings section"]}`).res;
    expect(r.ok).toBe(true);
    expect(r.line).toHaveLength(1);
    expect(r.line[0]).toMatch(/^NO LEARNINGS CLIP CUT: the captions say '\.\.\..*learning somewhere I've died for today.*', which sounds like the diary line, but the clip finder \(its exact and loose routes\) found no start it could cut, in this episode's transcript and full captions or on the automatic retry with today's finder$/);
  });

  it('the same for a diary line heard in the transcript: retry first, then the card with the line', () => {
    const r = py(`
w = gate_day({}, ${J(PLAIN)}, transcript="So the learnings from my diary today are that you should rest.")
c = gate_day({"lfmd_retried": {"finder": render.finder_code(), "found": False}}, ${J(PLAIN)}, transcript="So the learnings from my diary today are that you should rest.")
res = [[n for n, _ in w["failures"]], c["ok"], [d for n, d in c["passed"] if n == "Learnings section"][0][:87]]`).res;
    expect(r[0]).toEqual(['Learnings re-search']);
    expect(r[1]).toBe(true);
    expect(r[2]).toBe("NO LEARNINGS CLIP CUT: the episode's transcript has the diary line, but the clip finder");
  });

  it('a retry queued and never run stops holding the card after two days', () => {
    const r = py(`
render.queue_research(2138, today=dt.date.today() - dt.timedelta(days=5))
g = gate_day({}, ${J(NEAR)})
res = [g["ok"], [d for n, d in g["passed"] if n == "Learnings section"][0]]`).res;
    expect(r[0]).toBe(true);
    expect(r[1]).toMatch(/the automatic retry queued on \d{4}-\d{2}-\d{2} has not run$/);
  });

  it('a full re-render keeps the retry record, so a day sent back for anything else goes straight back to Kevin', () => {
    const r = py(`
talk = ["some of the talk goes here"] * 100 + ["so the learning somewhere I've died for today"] + ["keep going"] * 30 + ["stay positive, see you tomorrow"]
def cues(lines): return "".join("%d\\n00:%02d:%02d,000 --> 00:%02d:%02d,900\\n%s\\n\\n" % (i + 1, i // 60, i % 60, i // 60, i % 60, t) for i, t in enumerate(lines))
tmp = tempfile.mkdtemp(); clip = os.path.join(tmp, "VID_X.insv"); open(clip, "w").write("x")
def transcribe(c, w):
    s = os.path.join(w, "transcript.srt"); open(s, "w").write(cues(talk)); return " ".join(talk), s
class P:
    def __init__(self, o): self.stdout, self.returncode = o, 0
real = subprocess.run
subprocess.run = lambda cmd, *a, **k: P("140") if os.path.basename(cmd[0]) == "ffprobe" else real(cmd, *a, **k)
render.transcribe = transcribe
def stop(*a, **k): raise RuntimeError("stopped after the window was decided")
render.clip_role = lambda d, has: "episode"; render.find_pans_for = stop
sys.modules["pointing"] = types.SimpleNamespace(pans_arg=lambda p: "")
watch.save_ledger = lambda l: None; watch.spoken_day = lambda t: 2138
watch.resolve_episode = lambda d, s, prev_day_has_talk=False: (2138, "test")
retried = {"finder": render.finder_code(), "found": False, "at": "2026-11-17T02:00:00"}
led = {"VID_X.insv": {"local": clip, "date": "2026-04-08", "day": 2138, "status": "pulled", "lfmd_retried": retried}}
try: render.process("VID_X.insv", led, keep=True)
except RuntimeError: pass
e = led["VID_X.insv"]
g = gate_day({"lfmd_retried": e.get("lfmd_retried"), "lfmd_searched": e.get("lfmd_searched")}, ${J(NEAR)})
res = {"kept": e.get("lfmd_retried") == retried, "window": e.get("lfmd_window"), "ok": g["ok"]}`).res;
    expect(r.kept).toBe(true);
    expect(r.window).toBe(null);
    expect(r.ok).toBe(true);
  });

  it('the card puts that line at the top', () => {
    const r = py(`
line = "- Learnings section: NO LEARNINGS CLIP CUT: the captions say '...the learning somewhere for today...', which sounds like the diary line, but the clip finder (its exact and loose routes) found no start it could cut, in this episode's transcript and full captions or on the automatic retry with today's finder"
full = {"fields": {"Video Edited URL": "v", "Thumbnail URL": "t", "Summary Video URL": "s"}}
name, desc, card_text = approval.build_card(2138, full, proof_lines=["Checks the engine ran on the files (proof, not a promise):", line])
res = card_text.split("\\n\\n")[1]`).res;
    expect(r).toBe("CHECK BEFORE YOU APPROVE: NO LEARNINGS CLIP CUT: the captions say '...the learning somewhere for today...', which sounds like the diary line, but the clip finder (its exact and loose routes) found no start it could cut, in this episode's transcript and full captions or on the automatic retry with today's finder. If you said it, send the card back with the time it starts.");
  });

  it('CONTROL: a day with its Learnings clip gets the clip checks, never the retry', () => {
    const r = py(`
g = gate_day({"lfmd_window": [250.0, 300.0], "lfmd_window_by": "detector"}, ${J(NEAR)})
res = [n for n, _ in g["failures"]] + [n for n, _ in g["passed"] if n.startswith("Learnings")]`).res;
    expect(r).not.toContain('Learnings re-search');
    expect(r).toContain('Learnings clip (captions)');
  });
});
