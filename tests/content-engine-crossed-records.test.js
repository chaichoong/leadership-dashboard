// Crossed records (16 Nov 2026). The scan makes one Airtable record per SHOOTING day, named for the date and carrying
// the first clip's Raw File Link (watch.scan). A catch-up clip (recorded the day after, says the day before) renders
// AS the day before, found no record of that name, and render.find_or_create_record's raw-link fallback handed it the
// shooting day's record. Five renders wrote into the NEXT day's record: 2131 into 2132 (recI6qope8KqWHphG), 2136
// into 2137 (recuGpU5xtE5gNDeO), 2143 into 2144 (recfkKt2MXikkkeY6), 2156 into 2157, 2186 into 2187. Three were
// overwritten later by the right day's own render; 2137 and 2144 still hold the wrong episode's video and copy.
//
// Fixed at the cause (a render writes only to the record named for the episode it rendered) and guarded twice: the
// card is refused, and the publisher posts nothing, when a record holds files the render ledger owns for another
// episode. Also the apostrophe gap in the Learnings finder's loose route (2138). Invented data only: no network,
// no Airtable, no Drive.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CE = path.resolve(__dirname, '..', 'scripts', 'content-engine');

function py(body) {
  const script = String.raw`
import sys, os, io, json, tempfile, contextlib, urllib.parse
sys.path.insert(0, ${JSON.stringify(CE)})
import render, watch, qa, approval, publish
out, err = io.StringIO(), io.StringIO(); res = None
with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
${body.split('\n').map((l) => '    ' + l).join('\n')}
print(json.dumps({"res": res, "out": out.getvalue(), "err": err.getvalue()}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8', cwd: CE }));
}

// a fake Airtable: the shooting day's record exists and carries the catch-up clip's raw link; 2131's does not exist yet
const AIRTABLE = `
calls = []
def fake(method, url, body=None):
    q = urllib.parse.unquote(url)
    calls.append([method, q.split("filterByFormula=")[-1] if "filterByFormula=" in q else q, (body or {}).get("fields", {}).get("Content Name")])
    if method == "POST": return {"id": "recNEW2131"}
    if 'Content Name}="Episode 2131 Full Episode"' in q: return {"records": []}
    if "FIND(" in q and "RAWCLIP2131" in q: return {"records": [{"id": "recEP2132", "fields": {"Content Name": "Episode 2132 Full Episode"}}]}
    return {"records": []}
watch._airtable = fake
`;

describe('cause: a render writes only to the record of the episode it rendered', () => {
  it('BACK-TEST: the 2131 catch-up render gets a record named for 2131, never the 2132 record that carries its raw link', () => {
    const r = py(`${AIRTABLE}
import datetime as dt
rid, how = render.find_or_create_record(2131, "RAWCLIP2131", "VID_20260402_114414_00_011.insv", dt.date(2026, 4, 2))
res = {"rid": rid, "how": how, "created": [c[2] for c in calls if c[0] == "POST"], "raw_link_asked": any("FIND(" in c[1] for c in calls)}`).res;
    expect(r.rid).toBe('recNEW2131');
    expect(r.how).toBe('created');
    expect(r.created).toEqual(['Episode 2131 Full Episode']);
    expect(r.raw_link_asked).toBe(false);
  });

  it('CONTROL: an episode whose record exists by name gets that record, and the scan keeps its raw-link fallback', () => {
    const r = py(`${AIRTABLE}
watch._airtable = lambda method, url, body=None: ({"records": [{"id": "recEP2132", "fields": {}}]} if 'Episode 2132 Full Episode' in urllib.parse.unquote(url) else fake(method, url, body))
import datetime as dt
mine = render.find_or_create_record(2132, "RAWCLIP2132", "VID_x.insv", dt.date(2026, 4, 2))
watch._airtable = fake
scan = watch.find_record("RAWCLIP2131", 2131)
res = [list(mine), list(scan)]`).res;
    expect(r).toEqual([['recEP2132', 'name'], ['recEP2132', 'raw-link']]);
  });
});

const LEDGER = {
  'VID_20260414_184500_00_035.insv': { episode: 2143, role: 'episode', status: 'rendered',
    outputs: { full: 'https://drive.google.com/file/d/FULL2143aaaaaa/view', thumb: 'https://drive.google.com/file/d/THUMB2143aaaaa/view' } },
  'VID_20260415_154108_00_038.insv': { episode: 2144, role: 'teaser', status: 'rendered',
    outputs: { summary: 'https://drive.google.com/file/d/SUM2144aaaaaaa/view' } },
};
const CROSSED = { 'Video Edited URL': 'https://drive.google.com/file/d/FULL2143aaaaaa/view', 'Thumbnail URL': 'https://drive.google.com/file/d/THUMB2143aaaaa/view',
  'Summary Video URL': 'https://drive.google.com/file/d/SUM2144aaaaaaa/view', 'YouTube Copy': 'SEO Title: x', 'Record Status': 'Approved for Publishing' };
const J = (x) => `json.loads(${JSON.stringify(JSON.stringify(x))})`;

describe('guard: a record holding another episode\'s files never reaches a card or a platform', () => {
  it('names exactly which fields belong to which episode, from the render ledger', () => {
    const r = py(`res = [qa.crossed_record(2144, ${J(CROSSED)}, ${J(LEDGER)}), qa.crossed_record(2143, ${J(CROSSED)}, ${J(LEDGER)}),
       qa.crossed_record(2144, {"Video Edited URL": "https://drive.google.com/file/d/UNKNOWNaaaaaa/view"}, ${J(LEDGER)}), qa.crossed_record(2144, {}, ${J(LEDGER)})]`).res;
    expect(r[0]).toEqual(["Video Edited URL is episode 2143's full (clip VID_20260414_184500_00_035.insv)",
      "Thumbnail URL is episode 2143's thumb (clip VID_20260414_184500_00_035.insv)"]);
    expect(r[1]).toEqual(["Summary Video URL is episode 2144's summary (clip VID_20260415_154108_00_038.insv)"]);
    expect(r[2]).toEqual([]);                       // a link the ledger does not know is no evidence
    expect(r[3]).toEqual([]);
  });

  it('BACK-TEST: the card for a crossed record is refused, and the state says why', () => {
    const r = py(`
qa.gate = lambda day, ledger=None, files=None: (True, [], [("full episode file", "500 s")])
approval.save_state = lambda st: None
state = {}
recs = {"Long Form Video": {"fields": ${J(CROSSED)}}, "Learnings From My Diary": None, "Short Form Video": {"fields": {"TikTok Copy": "copy"}}}
proof = approval.output_gate(2144, ${J(LEDGER)}, state, recs)
res = {"proof": proof, "blocked": state["2144"]["qa_blocked"]["failures"]}`).res;
    expect(r.proof).toBe(null);
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0]).toMatch(/^record holds another episode: Video Edited URL is episode 2143's full/);
  });

  it('CONTROL: a record holding its own episode\'s files raises its card as before', () => {
    const own = { ...CROSSED, 'Video Edited URL': 'https://drive.google.com/file/d/FULL2144aaaaaa/view', 'Thumbnail URL': '' };
    const led = { ...LEDGER, 'VID_own.insv': { episode: 2144, role: 'episode', status: 'rendered', outputs: { full: own['Video Edited URL'] } } };
    const r = py(`
qa.gate = lambda day, ledger=None, files=None: (True, [], [("full episode file", "500 s")])
approval.save_state = lambda st: None
res = approval.output_gate(2144, ${J(led)}, {}, {"Long Form Video": {"fields": ${J(own)}}, "Learnings From My Diary": None, "Short Form Video": {"fields": {"TikTok Copy": "copy"}}})`).res;
    expect(r).toEqual(['Checks the engine ran on the files (proof, not a promise):', '- full episode file: 500 s']);
  });

  it('BACK-TEST: an approved day whose record is crossed publishes nothing, and says why', () => {
    const r = py(`
state = {}
publish.load_state = lambda: state; publish.save_state = lambda st: None
publish.approved_days = lambda: [2144]; publish.held_days = lambda path=None: {}
publish.accounts = lambda brand="Runpreneur": []; publish.account_map = lambda a: {"youtube": {"id": "yt"}}
publish.bundle = lambda day: {"Long Form Video": {"fields": ${J(CROSSED)}}, "Learnings From My Diary": None, "Short Form Video": None}
watch.load_ledger = lambda: ${J(LEDGER)}; watch.gap_days = lambda: set()
publish.mode = lambda: "live"
scheduled = []
publish.schedule_stage = lambda *a, **k: scheduled.append(a[0]) or 1
publish.fill_learnings = lambda *a, **k: None
publish.run()
res = {"scheduled": scheduled, "why": (state.get("2144") or {}).get("not_published", {}).get("why")}`).res;
    expect(r.scheduled).toEqual([]);
    expect(r.why).toBe("its record holds another episode's files");
  });
});

describe("the Learnings finder's loose route reads a word with an apostrophe (2138)", () => {
  it("BACK-TEST: \"the learning somewhere I've died for today\" is found, straight or curly apostrophe", () => {
    const r = py(`
def segs(line): return [(0, 10, "welcome back to the run")] + [(10 + i * 10, 20 + i * 10, "and that is how the day went for me") for i in range(40)] + [(420, 430, line), (430, 440, "that disappointments pass"), (500, 510, "stay positive, see you tomorrow")]
res = [render.lfmd_window(segs("so the learning somewhere I've died for today")), render.lfmd_window(segs("so the learning somewhere I\\u2019ve died for today"))]`).res;
    expect(r).toEqual([[420, 510], [420, 510]]);
  });

  it('CONTROL: lines the route already took still give the same window, and ordinary talk still gives none', () => {
    const r = py(`
def segs(line): return [(0, 10, "welcome back to the run")] + [(10 + i * 10, 20 + i * 10, "and that is how the day went for me") for i in range(40)] + [(420, 430, line), (500, 510, "stay positive, see you tomorrow")]
res = [render.lfmd_window(segs("and ultimately learning from my wife today is")), render.lfmd_window(segs("I've learned it's a long day, isn't it"))]`).res;
    expect(r).toEqual([[420, 510], null]);
  });
});

describe('the scripts still pass their own selftests', () => {
  for (const s of ['render.py', 'qa.py', 'watch.py', 'approval.py']) {
    it(s, () => {
      const out = execFileSync('python3', [s, 'selftest'], { encoding: 'utf8', cwd: CE }).trim().split('\n');
      expect(JSON.parse(out[out.length - 1]).failed).toEqual([]);
    });
  }
});
