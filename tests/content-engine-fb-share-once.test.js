import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
// Real Chrome launches in this file. 90s, not the suite's 30s (9 Oct 2026): in the merge
// gate's throwaway tree, with the full suite running in parallel, a launch alone went past 30s
// and refused PRs all day (the first three files got this in #751; these are the rest).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// CE_DIR lets the back-test point this file at an older copy of the engine
const CE = process.env.CE_DIR || resolve(ROOT, 'scripts/content-engine');

// 2 Oct 2026, episode 2083: both page posts went up at the same moment (the day had been held, so both slots had
// passed) and both captions opened with the same six words, which is all the finder matches on. The Summary share
// took the Summary reel, then the Learnings share matched the Summary reel too and shared it a second time. Kevin's
// profile got the Summary twice and the Learnings clip never. 2056 went the same way on 22 Sep.
//
// These tests drive the real publish.share_to_facebook_profile and the real facebook_share.find_page_post, whose
// page-reading script runs in node against a stand-in for Playwright that serves a fake Facebook page. Only the
// sign-in check, the Share press, the profile check and Airtable are stubbed. Captions and ids are invented.
const FAKE_PLAYWRIGHT = String.raw`
const PAGE = JSON.parse(process.env.FAKE_FB_PAGE);
function doc(url) {
  const reel = PAGE.captions[url];
  return {
    body: { innerText: reel === undefined ? '' : reel },
    querySelectorAll: () => (reel === undefined ? PAGE.list.map(h => ({ href: h })) : []),
    documentElement: { outerHTML: '' },
  };
}
const fs = require('fs');
module.exports.chromium = { launchPersistentContext: async () => {
  let url = '';
  const page = { goto: async (u) => { url = u; if (process.env.FAKE_FB_LOG && u in PAGE.captions) fs.appendFileSync(process.env.FAKE_FB_LOG, u + '\n'); }, waitForTimeout: async () => {}, mouse: { wheel: async () => {} },
                 evaluate: async (fn, arg) => { global.document = doc(url); return fn(arg); }, url: () => url };
  return { pages: () => [page], newPage: async () => page, close: async () => {} };
} };
`;

const SUMMARY_REEL = 'https://www.facebook.com/reel/9100000000000001';
const LEARNINGS_REEL = 'https://www.facebook.com/reel/9100000000000002';
const OLDER_REEL = 'https://www.facebook.com/reel/9100000000000003';
const SUMMARY_COPY = 'Six weeks after the hill race, my calves still ache on the climbs. Day 2190.';
const LEARNINGS_COPY = 'Six weeks after the hill race, my calves taught me patience. Day 2190.';

function harness(page, scenario) {
  const tmp = mkdtempSync(join(tmpdir(), 'fb-share-once-'));
  mkdirSync(join(tmp, 'fakepw'));
  writeFileSync(join(tmp, 'fakepw', 'index.js'), FAKE_PLAYWRIGHT);
  const py = String.raw`
import sys, os, json, datetime as dt
sys.path.insert(0, ${JSON.stringify(CE)})
import publish, facebook_share, approval
TMP = ${JSON.stringify(tmp)}
facebook_share.PW = os.path.join(TMP, "fakepw")
publish.STATE = os.path.join(TMP, "publishing.json")
publish.mode = lambda: "live"
publish.save_state = lambda st: None
approval.load_state = lambda: {}
facebook_share.signed_in = lambda: True
facebook_share.verify_shared = lambda url: True
pressed = []
def run_plan(plan_path, task, test, shot):
    pressed.append(json.load(open(plan_path))["steps"][0]["url"])
facebook_share.run_plan = run_plan
COPY = {"Short Form Video": {"fields": {"Facebook Reels Copy": ${JSON.stringify(SUMMARY_COPY)}}},
        "Learnings From My Diary": {"fields": {"Facebook Post Copy": ${JSON.stringify(LEARNINGS_COPY)}}}}
publish.bundle = lambda day: COPY
at = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
post = lambda clip: {"platform": "facebook", "clip": clip, "status": "scheduled", "scheduled": at}
entry = {"posts": {"facebook|summary|p": post("summary"), "facebook|lfmd|p": post("lfmd")}, "youtube_link": "https://youtu.be/x"}
state = {"2190": entry}
SCENARIO = ${JSON.stringify(scenario)}
if SCENARIO == "stored-duplicate":
    # the Learnings share found the Summary reel and waits its turn as a catch-up ("queued" keeps the URL it found)
    entry["facebook_share"] = {"status": "shared", "post_url": ${JSON.stringify(SUMMARY_REEL)}}
    entry["facebook_share_lfmd"] = {"status": "queued", "post_url": ${JSON.stringify(SUMMARY_REEL)}}
if SCENARIO == "finder-ignores-skip":
    entry["facebook_share"] = {"status": "shared", "post_url": ${JSON.stringify(SUMMARY_REEL)}}
    facebook_share.find_page_post = lambda copy, url=None, day=None, scan=None, skip=(): ${JSON.stringify(SUMMARY_REEL)}
if SCENARIO == "other-day":
    state["2189"] = {"facebook_share": {"status": "shared", "post_url": ${JSON.stringify(OLDER_REEL)}}}
for clip in publish.FB_SHARES:
    publish.share_to_facebook_profile("2190", entry, state, clip=clip)
print(json.dumps({"pressed": pressed, "summary": entry.get("facebook_share"), "lfmd": entry.get("facebook_share_lfmd")}))
`;
  const out = execFileSync('python3', ['-c', py], {
    encoding: 'utf8', cwd: CE, env: { ...process.env, FAKE_FB_PAGE: JSON.stringify(page) }, timeout: 60000,
  });
  return JSON.parse(out.trim().split('\n').pop());
}

// The real finder alone, against a fake page: what it returns and how many reels it opened.
function find(page, copy, skip) {
  const tmp = mkdtempSync(join(tmpdir(), 'fb-find-'));
  mkdirSync(join(tmp, 'fakepw'));
  writeFileSync(join(tmp, 'fakepw', 'index.js'), FAKE_PLAYWRIGHT);
  const log = join(tmp, 'opened.log');
  writeFileSync(log, '');
  const py = String.raw`
import sys, os, json
sys.path.insert(0, ${JSON.stringify(CE)})
import facebook_share
facebook_share.PW = os.path.join(${JSON.stringify(tmp)}, "fakepw")
print(json.dumps({"url": facebook_share.find_page_post(${JSON.stringify(copy)}, day=2190, skip=${JSON.stringify(skip || [])})}))
`;
  const out = execFileSync('python3', ['-c', py], { encoding: 'utf8', cwd: CE, timeout: 60000,
    env: { ...process.env, FAKE_FB_PAGE: JSON.stringify(page), FAKE_FB_LOG: log } });
  const opened = execFileSync('cat', [log], { encoding: 'utf8' }).split('\n').filter(Boolean);
  return { url: JSON.parse(out.trim().split('\n').pop()).url, opened };
}

// The 2 Oct page as Facebook listed it: the Summary reel first, the Learnings reel next, both opening the same way.
const SAME_OPENING = {
  list: [SUMMARY_REEL, LEARNINGS_REEL, OLDER_REEL],
  captions: {
    [SUMMARY_REEL]: 'Runpreneur · Follow ' + SUMMARY_COPY,
    [LEARNINGS_REEL]: 'Runpreneur · Follow ' + LEARNINGS_COPY,
    [OLDER_REEL]: 'Runpreneur · Follow Rain all morning. Day 2189.',
  },
};

describe('a page reel reaches Kevin\'s Facebook profile once (2083, 2 Oct 2026)', () => {
  it('two captions opening with the same six words share two different reels, not the Summary twice', () => {
    const r = harness(SAME_OPENING, 'fresh');
    expect(r.pressed).toEqual([SUMMARY_REEL, LEARNINGS_REEL]);
    expect(r.lfmd.post_url).toBe(LEARNINGS_REEL);
  });

  it('whichever reel Facebook lists first, each share gets its own clip (the longer caption match wins)', () => {
    const page = { list: [LEARNINGS_REEL, SUMMARY_REEL, OLDER_REEL], captions: SAME_OPENING.captions };
    const r = harness(page, 'fresh');
    expect(r.pressed).toEqual([SUMMARY_REEL, LEARNINGS_REEL]);
    expect([r.summary.post_url, r.lfmd.post_url]).toEqual([SUMMARY_REEL, LEARNINGS_REEL]);
  });

  it('a six-word match stops the scan two reels later when Facebook cuts every caption short', () => {
    // fourteen reels, every caption cut at "See more" before the twelfth word: the old first match, and no full scan
    const list = [...Array(14)].map((_, i) => 'https://www.facebook.com/reel/92000000000000' + String(i).padStart(2, '0'));
    const captions = Object.fromEntries(list.map((u, i) => [u, i === 1 ? 'Runpreneur Six weeks after the hill race, my… See more' : 'Runpreneur Rain all morning. Day 21' + i]));
    const r = find({ list, captions }, SUMMARY_COPY);
    expect(r.url).toBe(list[1]);
    expect(r.opened).toEqual(list.slice(0, 4));
  });

  it('captions cut at "See more" after word 8 still give each share its own reel, whichever is listed first', () => {
    // Kevin, 3 Oct 2026: fix the cut-short case too. Both reels show the shared six words plus one or two of their own.
    const page = { list: [LEARNINGS_REEL, SUMMARY_REEL, OLDER_REEL], captions: {
      [LEARNINGS_REEL]: 'Runpreneur · Follow Six weeks after the hill race, my calves taught… See more',
      [SUMMARY_REEL]: 'Runpreneur · Follow Six weeks after the hill race, my calves still… See more',
      [OLDER_REEL]: 'Runpreneur · Follow Rain all morning. Day 2189.' } };
    const r = harness(page, 'fresh');
    expect(r.pressed).toEqual([SUMMARY_REEL, LEARNINGS_REEL]);
    expect([r.summary.post_url, r.lfmd.post_url]).toEqual([SUMMARY_REEL, LEARNINGS_REEL]);
  });

  it('a true tie (both cut inside the shared words) still shares each reel once, never one twice', () => {
    const page = { list: [LEARNINGS_REEL, SUMMARY_REEL], captions: {
      [LEARNINGS_REEL]: 'Runpreneur Six weeks after the hill race,… See more',
      [SUMMARY_REEL]: 'Runpreneur Six weeks after the hill race,… See more' } };
    const r = harness(page, 'fresh');
    expect([...r.pressed].sort()).toEqual([LEARNINGS_REEL, SUMMARY_REEL].sort());
  });

  it('the "Day NNNN" fallback skips the reel already shared too', () => {
    // neither caption is on the page in the words the record holds, only the day number: 2056 on 22 Sep
    const page = { list: SAME_OPENING.list, captions: {
      [SUMMARY_REEL]: 'Runpreneur Hill legs. Day 2190 of running every day.',
      [LEARNINGS_REEL]: 'Runpreneur Patience. Day 2190 of running every day.',
      [OLDER_REEL]: 'Runpreneur Rain. Day 2189 of running every day.' } };
    const r = harness(page, 'fresh');
    expect(r.pressed).toEqual([SUMMARY_REEL, LEARNINGS_REEL]);
  });

  it('a share already holding the other share\'s reel drops it and finds its own post', () => {
    const r = harness(SAME_OPENING, 'stored-duplicate');
    expect(r.pressed).toEqual([LEARNINGS_REEL]);
    expect(r.lfmd.post_url).toBe(LEARNINGS_REEL);
  });

  it('Share is never pressed on a reel the profile already has, whatever the finder returns', () => {
    const r = harness(SAME_OPENING, 'finder-ignores-skip');
    expect(r.pressed).toEqual([]);
    expect(r.lfmd.status).toBe('page-post-not-found');
    expect(r.lfmd.post_url).toBeUndefined();
  });

  it('a reel already shared for an older day is skipped too, and the day still shares both of its own', () => {
    const page = { list: [OLDER_REEL, SUMMARY_REEL, LEARNINGS_REEL], captions: {
      [OLDER_REEL]: 'Runpreneur ' + SUMMARY_COPY,                       // an older day's reel that happens to match
      [SUMMARY_REEL]: 'Runpreneur ' + SUMMARY_COPY, [LEARNINGS_REEL]: 'Runpreneur ' + LEARNINGS_COPY } };
    const r = harness(page, 'other-day');
    expect(r.pressed).toEqual([SUMMARY_REEL, LEARNINGS_REEL]);
  });
});

// 2 Oct 2026, episode 2082: no diary section, so the render made no Learnings clip and no Short, and the output gate
// said so ("no diary phrase spoken in this recording, so no clip (by design)"). The card closer counted the episode
// finished, but the Publishing page read "3 of 7 sections, missing: YouTube Short, Learnings clips".
const REPORT = String.raw`
import sys, json, datetime as dt
sys.path.insert(0, ${JSON.stringify(CE)})
import content_report, publish
now = dt.datetime(2026, 2, 21, 9, 0, tzinfo=dt.timezone.utc)
yt = {"platform": "youtube", "clip": "full", "status": "published", "link": "https://youtu.be/q", "published_at": "2026-02-20T18:00:00Z", "scheduled": "2026-02-20T18:00:00Z"}
pub = lambda plat, clip: {"platform": plat, "clip": clip, "status": "published"}
def day(lfmd_made):
    posts = {"youtube|full|y": yt, "facebook|summary|f": pub("facebook", "summary"), "instagram|summary|i": pub("instagram", "summary")}
    return {"youtube_link": "https://youtu.be/q", "posts": posts, "blog": {"url": "https://runpreneur.org.uk/blog/b/q"},
            "podcast": {"status": "published"}, "facebook_share": {"status": "shared"}}
outputs = lambda lfmd: dict({"full": "https://drive/f", "podcast": "https://drive/p"}, **({"lfmd": "https://drive/l"} if lfmd else {}))
def run(lfmd_made):
    ledger = {"e": {"status": "rendered", "episode": 2190, "role": "episode", "outputs": outputs(lfmd_made)},
              "t": {"status": "rendered", "episode": 2190, "role": "teaser", "outputs": {"summary": "https://drive/s"}}}
    r = content_report.build(now, {"_cursor": 2190, "2190": day(lfmd_made)}, {"2190": {"verdict": "approved", "task": "t"}}, ledger, {},
                             plan=[], skipped=[], holds=[], skipped_ruled=[])
    row = r["history"][1]["episodes"][0]
    return {"row": row, "headline": r["headline"], "incomplete": r["incomplete"],
            "finished": publish.episode_finished(day(lfmd_made), lambda clip: bool((outputs(lfmd_made)).get(clip) or clip == "summary"))}
unknown = content_report.build(now, {"_cursor": 2190, "2190": day(False)}, {}, {"z": {"status": "rendered", "episode": 2001, "role": "episode"}}, {},
                               plan=[], skipped=[], holds=[], skipped_ruled=[])
print(json.dumps({"none": run(False), "made": run(True), "unknown": {"row": unknown["history"][1]["episodes"][0]}}))
`;

describe('the report counts only the sections an episode has (2082, 2 Oct 2026)', () => {
  const r = JSON.parse(execFileSync('python3', ['-c', REPORT], { encoding: 'utf8', cwd: CE, timeout: 60000 }).trim().split('\n').pop());

  it('a day with no diary section reads 5 of 5, with the Learnings clip and the Short "not in this episode"', () => {
    expect(r.none.row.sections['Learnings clips']).toBe('none');
    expect(r.none.row.sections['YouTube Short']).toBe('none');
    expect([r.none.row.done, r.none.row.owed]).toEqual([5, 5]);
    expect(r.none.row.missing).toEqual([]);
    expect(r.none.headline).toContain('Episode 2190 out, 5 of 5 sections.');
    expect(r.none.incomplete).toEqual([]);
  });

  it('control: a Learnings clip that WAS made and never posted is still missing, in red, and counted', () => {
    expect(r.made.row.sections['Learnings clips']).toBe('missing');
    expect(r.made.row.sections['YouTube Short']).toBe('missing');
    expect([r.made.row.done, r.made.row.owed]).toEqual([5, 7]);
    expect(r.made.headline).toContain('Episode 2190 out, 5 of 7 sections (missing: YouTube Short, Learnings clips)');
  });

  it('an episode the render ledger knows nothing about keeps its gaps red: unknown is never hidden', () => {
    expect(r.unknown.row.sections['Learnings clips']).toBe('missing');
    expect([r.unknown.row.done, r.unknown.row.owed]).toEqual([5, 7]);
  });

  it('the card closer and the report agree: finished exactly when nothing owed is left', () => {
    expect(r.none.finished).toBe(true);
    expect(r.made.finished).toBe(false);
  });
});
