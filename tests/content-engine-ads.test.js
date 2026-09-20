import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');
const CE = 'scripts/content-engine';

// Kevin, 20 Sep 2026: "on YouTube the long-form videos, the full episodes, don't have ads switched
// on, which means they're not monetised ... that money goes into Runpreneur's fundraising figure".
//
// THREE separate faults sat behind that one sentence, and the first two were invisible because
// every surface reported success.
//
// 1. MID-ROLL. The master monetisation switch WAS On, on every public video: 2,090 of 2,094 long
//    videos and all 1,291 Shorts, read off Studio's own list API on 20 Sep 2026. What was off was
//    the ad in the middle: 817 of the 888 videos over 8 minutes had `hasMidrollAds: false`, with
//    YouTube's own break point already computed and waiting on 695 of them. Mid-roll is the bulk of
//    long-form ad revenue, so the channel was earning a pre-roll per episode and nothing else. The
//    publisher only ever set the master switch, and the morning report only ever read the master
//    switch, so "content monetisation: every YouTube episode and Short On" was true and useless.
//
// 2. THE ROUTE FILTER. `monetise_long_video` selected posts with `p.get("route") == "api"`. A
//    GoHighLevel upload has no route and carries GHL's OWN post id (`6aa1688ddff4e2c4711c8b0b` on
//    episode 2054), which is not a YouTube id. Those posts were stepped over in total silence:
//    2054's episode, 2054's Short and 2195's episode were never checked once. The report used the
//    same filter, so they were invisible there too. The episode's `youtube_link` had the real id
//    all along.
//
// 3. A 200 FROM STUDIO IS NOT A WRITE. Studio's `metadata_update` endpoint needs the page's
//    BotGuard attestation. Replayed without it the call returns `200 OK` and changes nothing —
//    proved on Rs8xHbD5miQ, 20 Sep 2026: 200, then `hasMidrollAds` still false on read-back. Same
//    family as the Airtable silent-zero rule in CLAUDE.md. So every write is read back.

const PUBLISH = read(`${CE}/publish.py`);
const ADS_JS = read(`${CE}/youtube_ads.js`);
const py = (args) => execFileSync('python3', args, { cwd: resolve(ROOT, CE), encoding: 'utf8' });

describe('youtube_ads', () => {
  it('passes its own selftest', () => {
    expect(JSON.parse(py(['youtube_ads.py', 'selftest'])).failed).toEqual([]);
  });

  it('resolves a GoHighLevel upload through the episode link instead of skipping it', () => {
    // the real episode 2054 shape, straight out of publishing.json
    const out = JSON.parse(py(['-c', [
      'import sys, json; sys.path.insert(0, ".")',
      'import youtube_ads as a',
      'ent = {"youtube_link": "https://youtu.be/AT0l-Ri5ZJ0"}',
      'ghl = {"id": "6aa1688ddff4e2c4711c8b0b", "clip": "full", "route": None}',
      'api = {"id": "yGOws0WofyU", "clip": "full", "route": "api"}',
      'short = {"id": "6aa181234bdc74b45aeab6d5", "clip": "lfmd", "route": None}',
      'print(json.dumps({"ghl": a.video_id(ent, ghl), "api": a.video_id(ent, api), "short": a.video_id(ent, short)}))',
    ].join('\n')]));
    expect(out.ghl).toBe('AT0l-Ri5ZJ0');
    expect(out.api).toBe('yGOws0WofyU');
    expect(out.short).toBeNull();     // no link to resolve: reported, never assumed
  });

  it('reads every write back off Studio rather than trusting the 200', () => {
    expect(ADS_JS).toMatch(/the only proof that counts/);
    expect(ADS_JS).toMatch(/readBack\(page, todo\)/);
    // the replay reuses the attestation the UI save minted; without it the write is a no-op
    expect(ADS_JS).toMatch(/JSON\.parse\(upd\.body\)/);
    expect(ADS_JS).toMatch(/b\.encryptedVideoId = videoId/);
  });

  it('never sends anything but an 11-character video id to the browser', () => {
    expect(ADS_JS).toMatch(/MIDROLL_MIN_SECONDS = 480/);
    const out = JSON.parse(py(['-c', [
      'import sys, json; sys.path.insert(0, ".")',
      'import youtube_ads as a',
      'print(json.dumps({"empty": a.midroll([]), "bad": a.midroll(["../../etc/passwd", "short"])}))',
    ].join('\n')]));
    expect(out.empty).toEqual({});
    expect(out.bad).toEqual({});
  });
});

describe('the publisher sets mid-roll and matches posts by video id', () => {
  const monetise = PUBLISH.match(/def monetise_long_video[\s\S]*?\n(?=def )/)[0];
  const report = PUBLISH.match(/\n    # No route filter here either[\s\S]*?content posts to check once/)[0];

  it('does not filter YouTube posts by upload route', () => {
    // back-test: put `route == "api"` back into either place and this fails
    expect(monetise).not.toMatch(/route"\) == "api"/);
    expect(report).not.toMatch(/route"\) == "api"/);
  });

  it('reports an upload it cannot resolve instead of stepping over it', () => {
    expect(monetise).toMatch(/youtube_ads\.video_id\(entry, p\)/);
    expect(monetise).toMatch(/NO_VIDEO_ID/);
  });

  it('switches mid-roll on for the long episode, once it is earning', () => {
    expect(monetise).toMatch(/youtube_ads\.midroll\(\[vid\]\)/);
    expect(monetise).toMatch(/p\.get\("monetisation"\) in MONETISED/);
    expect(PUBLISH).toMatch(/MIDROLL_SETTLED = \("on", "not-eligible"\)/);
  });

  it('shows the mid-roll backlog in the morning report', () => {
    expect(report).toMatch(/mid-roll/);
  });
});

describe('both Facebook page posts reach Kevin profile', () => {
  it('configures the summary reel and the Learnings post separately', () => {
    const cfg = PUBLISH.match(/FB_SHARES = \{[\s\S]*?\n\}/)[0];
    expect(cfg).toMatch(/"summary": \{"key": "facebook_share"/);   // history stays on the original key
    expect(cfg).toMatch(/"lfmd": \{"key": "facebook_share_lfmd"/);
    expect(cfg).toMatch(/"field": "Facebook Post Copy"/);
    // the Learnings post publishes as a plain post, so a reels-only search would never find it
    expect(cfg).toMatch(/"lfmd":[^\n]*"timeline": True/);
    expect(cfg).toMatch(/"summary":[^\n]*"timeline": False/);
  });

  it('shares every configured post from sync, not just the first', () => {
    const sync = PUBLISH.match(/def sync\(\)[\s\S]*?\n(?=def )/)[0];
    expect(sync).toMatch(/for clip in FB_SHARES/);
    expect(sync).toMatch(/share_to_facebook_profile\(day, entry, state, clip=clip\)/);
  });

  it('keeps the two shares of one episode in separate plan and screenshot files', () => {
    const fb = read(`${CE}/facebook_share.py`);
    expect(fb).toMatch(/def write_plan\(day, post_url, copy, youtube_link, test, out_dir, clip="summary"\)/);
    expect(fb).toMatch(/facebook_share_%d%s\.json/);
    expect(PUBLISH).toMatch(/facebook_share_%s%s\.png/);
  });

  it('passes the facebook_share selftest', () => {
    expect(JSON.parse(py(['facebook_share.py', 'selftest'])).failed).toEqual([]);
  });
});
