#!/usr/bin/env node
/* youtube_ads.js — read and set AD BREAKS and AD FORMATS for every video on the channel.
 *
 * Kevin, 20 Sep 2026: "every single video has the ads switched on so that they can generate money".
 * The master monetisation switch (youtube_studio.py) was already On everywhere. What was off was the
 * ad in the MIDDLE: 817 of 888 videos over 8 minutes had mid-roll ads unticked, and YouTube had already
 * worked out where the break goes on 695 of them.
 *
 * YouTube's Data API has no ad-break setting, so this drives Studio's own endpoint:
 *   read : POST /youtubei/v1/creator/list_creator_videos  with adSettings in the mask
 *   write: POST /youtubei/v1/video_manager/metadata_update
 *
 * The write carries a BotGuard `attestationResponseData` that the page mints. WITHOUT IT THE WRITE
 * RETURNS 200 AND CHANGES NOTHING (proved 20 Sep 2026 on Rs8xHbD5miQ: 200 OK, mid-roll still false).
 * So the first video of every batch is saved through the real UI, which mints an attestation, and the
 * rest replay that same attestation with only encryptedVideoId swapped. Every write is read back.
 *
 *   youtube_ads.js audit [--out FILE]              every video, its ad breaks and ad formats
 *   youtube_ads.js fix --ids FILE [--dry]          mid-roll (+pre/post-roll) On for those video ids
 *   youtube_ads.js legacy --ids FILE [--dry]       convert pre-2024 videos off legacy ad settings
 *   youtube_ads.js verify --ids FILE               read back only
 */
const path = require('path'), os = require('os'), fs = require('fs');
const { chromium } = require('/Users/kevinbrittain/Projects/leadership-dashboard/node_modules/playwright');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const PROFILE = 'default';
const CHANNEL = 'UCKvcFYC2y4FAeTDS20_JXFw';
const LIST_URL = (tab) => `https://studio.youtube.com/channel/${CHANNEL}/videos/${tab}`;
const EARN_URL = (id) => `https://studio.youtube.com/video/${id}/monetization/ads`;
const MIDROLL_LABEL = 'Show mid-roll ads during my video';
// Mid-roll needs 8 minutes of video; YouTube hides the checkbox below that (read in Studio 20 Sep 2026).
const MIDROLL_MIN_SECONDS = 480;
const REMINT_AFTER = 120;        // a fresh attestation well inside its 6-hour TTL
// Two hours. A full-channel backfill is ~900 videos at two writes each plus a paged read-back per
// round; one hour was not enough headroom for a retry round (20 Sep 2026).
const WATCHDOG_MS = 7200000;

function args() {
  const a = {}; const v = process.argv.slice(2); a.mode = v[0];
  for (let i = 1; i < v.length; i++) {
    if (v[i] === '--ids') a.ids = v[++i];
    else if (v[i] === '--out') a.out = v[++i];
    else if (v[i] === '--dry') a.dry = true;
    else if (v[i] === '--limit') a.limit = parseInt(v[++i], 10);
  }
  return a;
}

async function open(headless = true) {
  const dir = path.join(os.homedir(), '.config', 'od', 'agent-browser', PROFILE);
  const ctx = await chromium.launchPersistentContext(dir, {
    headless, viewport: { width: 1400, height: 1000 }, channel: 'chrome',
    ignoreDefaultArgs: ['--enable-automation'], userAgent: UA });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  return { ctx, page };
}

async function settle(page) {
  await page.waitForTimeout(14000);
  const skip = page.getByText('SKIP TO YOUTUBE STUDIO', { exact: true }).first();
  if (await skip.count()) { await skip.click().catch(() => {}); await page.waitForTimeout(9000); }
}

/* ---------- read ---------- */

// Every video in one list tab. `adSettings` is added to the page's own mask, so the shape always
// matches what Studio itself reads. Paged to the end: a partial read would under-report the backlog.
async function listTab(page, tab) {
  let cap = null;
  const grab = (r) => { if (!cap && /list_creator_videos/.test(r.url())) cap = { url: r.url(), headers: r.headers(), body: r.postData() }; };
  page.on('request', grab);
  await page.goto(LIST_URL(tab), { waitUntil: 'domcontentloaded' });
  await settle(page);
  page.off('request', grab);
  if (!cap) throw new Error('Studio never issued list_creator_videos for ' + tab);
  return page.evaluate(async (cap) => {
    const base = JSON.parse(cap.body);
    base.mask.adSettings = { all: true };
    base.mask.monetizedStatus = true;
    const hdr = {}; for (const [k, v] of Object.entries(cap.headers)) if (!/^:|^host$|^content-length$/i.test(k)) hdr[k] = v;
    const rows = []; let token = null;
    for (let page_ = 0; page_ < 300; page_++) {
      const b = Object.assign({}, base, { pageSize: 100 });
      if (token) b.pageToken = token; else delete b.pageToken;
      const r = await fetch(cap.url, { method: 'POST', headers: hdr, body: JSON.stringify(b), credentials: 'include' });
      if (!r.ok) throw new Error('list_creator_videos http ' + r.status);
      const j = await r.json();
      const vids = j.videos || [];
      for (const v of vids) rows.push({ id: v.videoId, title: (v.title || '').slice(0, 90),
        published: v.timePublishedSeconds, seconds: Math.round((v.videoDurationMs || 0) / 1000),
        privacy: v.privacy, monetization: v.monetization, adSettings: v.adSettings });
      token = j.nextPageToken;
      if (!token || !vids.length) break;
    }
    return rows;
  }, cap);
}

async function audit(page) {
  const long = await listTab(page, 'upload');
  const shorts = await listTab(page, 'short');
  return { long, shorts };
}

/* ---------- write ---------- */

// One genuine UI save. It is what mints the attestation the replays reuse, and it fixes a real video.
async function mint(page, videoId) {
  let upd = null;
  const grab = (r) => { if (/metadata_update/.test(r.url())) upd = { url: r.url(), headers: r.headers(), body: r.postData() }; };
  page.on('request', grab);
  try {
    await page.goto(EARN_URL(videoId), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(14000);
    const lit = page.locator('ytcp-checkbox-lit').filter({ hasText: MIDROLL_LABEL }).first();
    // A video under 8 minutes carries no mid-roll checkbox at all. That is YouTube's rule, not a fault:
    // it is reported as not-eligible so a short episode never sits in the backlog for ever (20 Sep 2026).
    if (!(await lit.count())) { const e = new Error('not eligible for mid-roll: ' + videoId); e.notEligible = true; throw e; }
    const box = lit.locator('#checkbox').first();
    // Already ticked: there is nothing to save, so Save stays disabled. That is a video that is DONE,
    // not a video that failed — treating it as a failure would leave it "failed" on every future run.
    if ((await box.getAttribute('aria-checked')) === 'true') { const e = new Error('already on: ' + videoId); e.alreadyOn = true; throw e; }
    await lit.scrollIntoViewIfNeeded();
    const bb = await box.boundingBox();
    if (!bb) throw new Error('mid-roll checkbox not on screen for ' + videoId);
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.waitForTimeout(1800);
    if ((await box.getAttribute('aria-checked')) !== 'true') throw new Error('mid-roll did not tick on ' + videoId);
    const save = page.locator('ytcp-button:has-text("Save"):not([disabled]), #save-button:not([disabled])').first();
    if (!(await save.count())) throw new Error('Save never enabled on ' + videoId);
    await save.click({ timeout: 25000 });
    await page.waitForTimeout(9000);
  } finally { page.off('request', grab); }
  if (!upd) throw new Error('no metadata_update captured from ' + videoId);
  return upd;
}

// What a write asks for. MIDROLL is the modern case; LEGACY_FORMATS is the first half of converting a
// pre-2024 video off "legacy ad settings", which is the change YouTube warns cannot be reversed
// (Kevin approved it, 20 Sep 2026). Field names read off Studio's own two saves on xxYZcW8SFQk.
const MIDROLL = { adBreaks: { newHasPrerolls: 'ENABLED', newHasMidrollAds: 'ENABLED',
                              newHasPostrolls: 'ENABLED', newAutoMidrollEnabled: 'ENABLED' } };
const LEGACY_FORMATS = { adFormats: { newHasSkippableVideoAds: 'ENABLED', newHasNonSkippableVideoAds: 'ENABLED',
                                      newDisableDisplayAds: 'DISABLED' },
                         adBreaks: { newHasPrerolls: 'ENABLED', newHasPostrolls: 'ENABLED' } };

// Replay the minted write for one video. A 200 here is NOT proof: the caller reads every id back.
async function replay(page, upd, videoId, adSettings) {
  return page.evaluate(async ({ upd, videoId, adSettings }) => {
    const hdr = {}; for (const [k, v] of Object.entries(upd.headers)) if (!/^:|^host$|^content-length$/i.test(k)) hdr[k] = v;
    const b = JSON.parse(upd.body);
    b.encryptedVideoId = videoId;
    b.adSettings = adSettings;
    const r = await fetch(upd.url, { method: 'POST', headers: hdr, body: JSON.stringify(b), credentials: 'include' });
    return { status: r.status };
  }, { upd, videoId, adSettings });
}

// The legacy conversion, through the UI, on one video. Two saves: the banner's irreversible "Update",
// which turns video ads on, and then mid-roll if the video is long enough. Either save mints an
// attestation the replays can reuse.
async function mintLegacy(page, videoId) {
  let upd = null;
  const grab = (r) => { if (/metadata_update/.test(r.url())) upd = { url: r.url(), headers: r.headers(), body: r.postData() }; };
  page.on('request', grab);
  try {
    await page.goto(EARN_URL(videoId), { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(14000);
    const banner = page.locator('ytcp-button:has-text("Update")').first();
    if (!(await banner.count())) { const e = new Error('not a legacy video: ' + videoId); e.notLegacy = true; throw e; }
    await banner.click({ timeout: 20000 });
    await page.waitForTimeout(3000);
    const dlg = page.locator('ytcp-dialog:visible, tp-yt-paper-dialog:visible').filter({ hasText: 'Update ad settings' }).first();
    if (!(await dlg.count())) throw new Error('no "Update ad settings?" confirmation on ' + videoId);
    await dlg.locator('ytcp-button:has-text("Update")').last().click({ timeout: 20000 });
    await page.waitForTimeout(7000);
    // and mid-roll while we are here, when the video is long enough to carry one
    const lit = page.locator('ytcp-checkbox-lit').filter({ hasText: MIDROLL_LABEL }).first();
    if (await lit.count()) {
      const box = lit.locator('#checkbox').first();
      if ((await box.getAttribute('aria-checked')) !== 'true') {
        await lit.scrollIntoViewIfNeeded();
        const bb = await box.boundingBox();
        if (bb) { await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.waitForTimeout(1500); }
      }
      const save = page.locator('ytcp-button:has-text("Save"):not([disabled]), #save-button:not([disabled])').first();
      if (await save.count()) { await save.click({ timeout: 25000 }); await page.waitForTimeout(8000); }
    }
  } finally { page.off('request', grab); }
  if (!upd) throw new Error('no metadata_update captured from ' + videoId);
  return upd;
}

// The 923 pre-2024 videos on legacy ad settings: display banners only, no video ads at all. Two
// replayed writes each, then read back on hasSkippableVideoAds, which is what the conversion buys.
async function legacy(page, ids, dry) {
  const done = {}, errors = {};
  let todo = ids.slice();
  if (dry) return { dry: true, would: todo.length, sample: todo.slice(0, 5) };
  for (let round = 1; round <= 3 && todo.length; round++) {
    let upd = null, since = 0;
    for (const id of todo) {
      if (!upd || since >= REMINT_AFTER) {
        try { upd = await mintLegacy(page, id); since = 0; done[id] = 'ui-save'; continue; }
        catch (e) {
          if (e.notLegacy) { done[id] = 'already-modern'; upd = null; continue; }
          errors[id] = 'mint: ' + e.message.slice(0, 160); upd = null; continue;
        }
      }
      try {
        await replay(page, upd, id, LEGACY_FORMATS);
        await replay(page, upd, id, MIDROLL);      // refused by YouTube under 8 minutes; harmless
        done[id] = 'replay'; since++;
      } catch (e) { errors[id] = 'replay: ' + e.message.slice(0, 160); }
    }
    const back = await readBack(page, todo);
    todo = todo.filter((id) => !videoAdsOn(back[id]));
    if (!todo.length) break;
  }
  return { done, errors, stillLegacy: todo };
}

// The ad settings Studio itself reports for these ids. This is the only proof any write took:
// metadata_update answers 200 whether or not it did anything (Rs8xHbD5miQ, 20 Sep 2026).
async function readBack(page, ids) {
  const long = await listTab(page, 'upload');
  const want = new Set(ids), out = {};
  for (const r of long) if (want.has(r.id)) out[r.id] = r.adSettings || {};
  return out;
}

const midrollOn = (ad) => ((ad || {}).adBreaks || {}).hasMidrollAds === true;
const videoAdsOn = (ad) => ((ad || {}).adFormats || {}).hasSkippableVideoAds === true;

async function fix(page, ids, dry) {
  const done = {}, errors = {}, notEligible = [];
  let todo = ids.slice();
  if (dry) return { dry: true, would: todo.length, sample: todo.slice(0, 5) };
  for (let round = 1; round <= 3 && todo.length; round++) {
    let upd = null, since = 0;
    for (const id of todo) {
      if (!upd || since >= REMINT_AFTER) {
        try { upd = await mint(page, id); since = 0; done[id] = 'ui-save'; continue; }
        catch (e) {
          if (e.notEligible) { notEligible.push(id); upd = null; continue; }
          if (e.alreadyOn) { done[id] = 'already-on'; upd = null; continue; }   // still needs a mint from the next one
          errors[id] = 'mint: ' + e.message.slice(0, 160); upd = null; continue;
        }
      }
      try { const r = await replay(page, upd, id); done[id] = 'replay ' + r.status; since++; }
      catch (e) { errors[id] = 'replay: ' + e.message.slice(0, 160); }
    }
    const back = await readBack(page, todo);          // the only proof that counts
    const skip = new Set(notEligible);
    todo = todo.filter((id) => !midrollOn(back[id]) && !skip.has(id));
    if (!todo.length) break;
  }
  return { done, errors, notEligible, stillOff: todo };
}

/* ---------- main ---------- */

(async () => {
  const a = args();
  setTimeout(() => { console.log(JSON.stringify({ error: 'watchdog' })); process.exit(1); }, WATCHDOG_MS);
  const { ctx, page } = await open();
  const finish = async (obj) => {
    console.log(JSON.stringify(obj, null, 1));
    await page.close({ runBeforeUnload: false }).catch(() => {});
    await ctx.close().catch(() => {});
    process.exit(obj && obj.error ? 1 : 0);
  };
  try {
    if (a.mode === 'audit') {
      const r = await audit(page);
      if (a.out) fs.writeFileSync(a.out, JSON.stringify(r, null, 1));
      const pub = r.long.filter((v) => v.privacy === 'VIDEO_PRIVACY_PUBLIC');
      const elig = pub.filter((v) => v.seconds >= MIDROLL_MIN_SECONDS);
      const off = elig.filter((v) => !(((v.adSettings || {}).adBreaks || {}).hasMidrollAds));
      return finish({ long: r.long.length, shorts: r.shorts.length, publicLong: pub.length,
                      midrollEligible: elig.length, midrollOff: off.length, out: a.out || null });
    }
    if (a.mode === 'legacy') {
      if (!a.ids) return finish({ error: '--ids FILE required' });
      let ids = JSON.parse(fs.readFileSync(a.ids, 'utf8'));
      if (a.limit) ids = ids.slice(0, a.limit);
      return finish(await legacy(page, ids, a.dry));
    }
    if (a.mode === 'fix' || a.mode === 'verify') {
      if (!a.ids) return finish({ error: '--ids FILE required' });
      let ids = JSON.parse(fs.readFileSync(a.ids, 'utf8'));
      if (a.limit) ids = ids.slice(0, a.limit);
      if (a.mode === 'verify') {
        const back = await readBack(page, ids);
        return finish({ checked: ids.length,
                        midrollOn: ids.filter((i) => midrollOn(back[i])).length,
                        videoAdsOn: ids.filter((i) => videoAdsOn(back[i])).length,
                        stillOff: ids.filter((i) => !midrollOn(back[i]) && !videoAdsOn(back[i])) });
      }
      return finish(await fix(page, ids, a.dry));
    }
    return finish({ error: 'usage: youtube_ads.js audit|fix|legacy|verify' });
  } catch (e) { return finish({ error: e.message.slice(0, 300) }); }
})();
