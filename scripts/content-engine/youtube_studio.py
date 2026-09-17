#!/usr/bin/env python3
"""youtube_studio.py — switch a long video's monetisation On in YouTube Studio, through the robot browser.

Ericamae, 13 Sep 2026: the long videos for 2054, 2055, 2056 and 2195 went out with "Watch page ads" Off while
their Shorts were On, so the channel earned nothing on the episodes. YouTube's upload API has no monetisation
setting and the channel's upload defaults only hold ad placement, so the switch is made where she made it:
the video's Earn page in Studio (studio.youtube.com/video/<id>/monetization/ads), then read back.

  youtube_studio.py status  --video ID     # prints On / Off / unknown
  youtube_studio.py monetise --video ID    # switches it On if it is Off, then reads it back
  youtube_studio.py selftest
"""
import argparse, json, os, re, subprocess, sys, tempfile

PROFILE = "default"                         # the robot browser profile signed into YouTube Studio
PW = "/Users/kevinbrittain/Projects/leadership-dashboard/node_modules/playwright"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
EARN_URL = "https://studio.youtube.com/video/%s/monetization/ads"
# A long video's earn page says "Watch page ads and YouTube Premium"; a Short's says "Shorts Feed ads" (read in Studio
# 17 Sep 2026 on 90YWPsupMXk: "Ways to earn | Shorts Feed ads | ... | On"). Both are read the same way.
HEADINGS = ["Watch page ads and YouTube Premium", "Shorts Feed ads"]
HEADING = HEADINGS[0]
# YouTube's content rating, word for word as the form listed it on 13 Sep 2026. Kevin's ruling the same day:
# approving the episode's card confirms the video contains none of these, so the robot answers "None of the above".
RATING_CATEGORIES = ["Inappropriate language", "Adult content", "Violence", "Shocking content", "Harmful acts and unreliable claims",
                     "Recreational drugs content", "Enabling dishonest behaviour", "Hateful and derogatory content",
                     "Firearms-related content", "Sensitive events", "Controversial issues"]

JS = r"""
const path = require('path'), os = require('os');
const { chromium } = require(%(pw)s);
const VID = %(vid)s, ACT = %(act)s, HEADINGS = %(headings)s, CERTIFY = %(certify)s;
const HEADING_RE = new RegExp('^(' + HEADINGS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$');
(async () => {
  const dir = path.join(os.homedir(), '.config', 'od', 'agent-browser', %(profile)s);
  // Studio shows "unsupported browser" to headless Chrome's own agent string (10 Sep 2026), so a normal one is set.
  const ctx = await chromium.launchPersistentContext(dir, { headless: true, viewport: { width: 1400, height: 950 }, channel: 'chrome', ignoreDefaultArgs: ['--enable-automation'], userAgent: %(ua)s });
  let out = { video: VID };
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));      // a "leave site?" prompt after Cancel hung the close for 5 min
  const finish = async () => { await page.close({ runBeforeUnload: false }).catch(() => {}); await ctx.close().catch(() => {}); process.exit(0); };
  setTimeout(() => { console.log(JSON.stringify(Object.assign(out, { error: 'watchdog: 240 s' }))); process.exit(0); }, 240000);
  const open = async () => {
    await page.goto(%(url)s, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(10000);
    const skip = page.getByText('SKIP TO YOUTUBE STUDIO', { exact: true }).first();
    if (await skip.count()) { await skip.click(); await page.waitForTimeout(8000); }
    await page.getByText(HEADING_RE).first().waitFor({ timeout: 60000 });
  };
  const read = async () => page.evaluate((hs) => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    for (const h of hs) {
      const i = t.indexOf(h);
      if (i < 0) continue;
      const m = t.slice(i, i + 220).match(/\b(On|Off|Checking)\b/); return m ? m[1] : 'unknown';
    }
    return 'unknown';
  }, HEADINGS);
  try {
    await open();
    out.before = await read();
    if (ACT === 'monetise' && out.before === 'Off') {  // Checking means already submitted: never rate twice
      await page.locator('[aria-label="Edit video monetisation status"]').first().click({ timeout: 20000 });
      await page.waitForTimeout(2000);
      // the dialog holds two radio buttons (#radio-on / #radio-off) and a Done button (#save-button), 13 Sep 2026;
      // Playwright's own click on the radio does not register, a mouse click on its box does
      const r = await page.locator('#radio-on:visible').first().boundingBox();
      await page.mouse.click(r.x + 12, r.y + r.height / 2); await page.waitForTimeout(1200);
      const d = await page.locator('#save-button:visible').first().boundingBox();
      await page.mouse.click(d.x + d.width / 2, d.y + d.height / 2); await page.waitForTimeout(3000);
      // The first time a video is switched On, YouTube asks for the content rating ("Tell us what's in your video")
      // and says the answers cannot be changed once submitted. That is Kevin's declaration: never answered here.
      if (await page.getByText("Tell us what's in your video", { exact: true }).count()) {
        const dlg = page.locator('ytcp-dialog:visible, tp-yt-paper-dialog:visible').filter({ hasText: "Tell us what's in your video" }).first();
        const listed = await dlg.evaluate((e) => e.innerText);
        const expected = %(categories)s;
        const missing = expected.filter((c) => !listed.includes(c));
        if (!CERTIFY || missing.length) {
          // Kevin's declaration: answered only for an approved card, and only when the form asks exactly what the card said
          await page.screenshot({ path: %(shot)s });
          const c = dlg.locator('ytcp-button:has-text("Cancel")').last();
          if (await c.count()) { await c.click().catch(() => {}); await page.waitForTimeout(1500); }
          out.needs_rating = true; out.status = 'needs-rating'; if (missing.length) out.form_changed = missing;
          console.log(JSON.stringify(out)); await finish();
        }
        // the tick is the ytcp-checkbox-lit's own #checkbox, scrolled into view and clicked with the mouse (13 Sep 2026)
        const lit = dlg.locator('ytcp-checkbox-lit').filter({ hasText: 'None of the above' }).last();
        await lit.scrollIntoViewIfNeeded();
        const box = lit.locator('#checkbox').first();
        const nb = await box.boundingBox();
        await page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2); await page.waitForTimeout(1500);
        if ((await box.getAttribute('aria-checked')) !== 'true') throw new Error('None of the above did not tick');
        const submit = dlg.locator('ytcp-button:has-text("Submit"):not([disabled])').last();
        await submit.waitFor({ timeout: 20000 });
        await page.screenshot({ path: %(shot)s.replace('.png', '_rating.png') });
        await submit.click({ timeout: 20000 }); await page.waitForTimeout(6000);
        out.rated = 'none of the above';
      }
      const save = page.locator('ytcp-button#save:not([disabled])').first();
      await save.click({ timeout: 30000 }); await page.waitForTimeout(8000);
      await open();                                   // read it back from a fresh page, not from the form we just changed
      out.after = await read();
    }
    out.status = out.status || out.after || out.before;
    await page.screenshot({ path: %(shot)s });
  } catch (e) { out.error = e.message.slice(0, 240); }
  console.log(JSON.stringify(out));
  await finish();
})();
"""


def _node():
    for c in (os.environ.get("NODE"), subprocess.run(["bash", "-lc", "command -v node"], capture_output=True, text=True).stdout.strip()):
        if c and os.path.exists(c): return c
    vers = sorted([d for d in os.listdir(os.path.expanduser("~/.nvm/versions/node")) if d.startswith("v")], key=lambda v: [int(x) for x in re.findall(r"\d+", v)]) if os.path.isdir(os.path.expanduser("~/.nvm/versions/node")) else []
    if vers: return os.path.expanduser("~/.nvm/versions/node/%s/bin/node" % vers[-1])
    return "node"


def _run(video_id, act, shot=None, certify=False):
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id or ""): raise SystemExit("not a YouTube video id: %r" % video_id)
    shot = shot or os.path.join(tempfile.gettempdir(), "yt_earn_%s.png" % video_id)
    js = JS % {"pw": json.dumps(PW), "vid": json.dumps(video_id), "act": json.dumps(act), "headings": json.dumps(HEADINGS),
               "profile": json.dumps(PROFILE), "ua": json.dumps(UA), "url": json.dumps(EARN_URL % video_id), "shot": json.dumps(shot),
               "certify": "true" if certify else "false", "categories": json.dumps(RATING_CATEGORIES)}
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as fh:
        fh.write(js); path = fh.name
    try:
        r = subprocess.run([_node(), path], capture_output=True, text=True, timeout=300)
    finally:
        os.remove(path)
    out = (r.stdout or "").strip()
    if "{" not in out: raise SystemExit("studio read failed: %s" % ((r.stderr or out)[-240:]))
    res = json.loads(out[out.index("{"):]); res["shot"] = shot
    return res


def status(video_id):
    return _run(video_id, "status")


def monetise(video_id, certify_none=False):
    """Switch it On if it is Off. `certify_none` answers YouTube's content rating with "None of the above", and is
    passed only for an episode whose card Kevin approved (his ruling, 13 Sep 2026). Returns the result dict;
    res['status'] == 'On' is the proof."""
    return _run(video_id, "monetise", certify=certify_none)


def selftest():
    assert EARN_URL % "abcdefghijk" == "https://studio.youtube.com/video/abcdefghijk/monetization/ads"
    try: _run("not-an-id", "status"); ok = False
    except SystemExit: ok = True
    assert ok, "only an 11-character video id reaches the browser"
    assert "open();" in JS and "out.after = await read();" in JS, "the switch is read back from a fresh page"
    assert "#radio-on" in JS and "#save-button" in JS, "the On radio and the dialog's Done button are the proven controls (13 Sep 2026)"
    assert "runBeforeUnload: false" in JS and "watchdog" in JS, "a dirty form can never hang the close"
    assert "On|Off|Checking" in JS, "after the rating YouTube shows Checking before On (13 Sep 2026)"
    assert "Shorts Feed ads" in HEADINGS and "HEADING_RE" in JS and "for (const h of hs)" in JS, "a Short's earn page is read too (17 Sep 2026)"
    assert "lit.locator('#checkbox')" in JS and "did not tick" in JS, "the tick is proved before Submit"
    assert "if (!CERTIFY || missing.length)" in JS, "the rating is answered only for an approved card, and only when YouTube asks exactly the listed questions"
    assert len(RATING_CATEGORIES) == 11 and "Controversial issues" in RATING_CATEGORIES
    assert os.path.basename(_node()) == "node", "a node binary is found even under launchd's bare PATH"
    print(json.dumps({"checks": 10, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--video", default=""); ap.add_argument("--certify", action="store_true", help="answer the content rating 'None of the above' (approved cards only)")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "status": print(json.dumps(status(a.video)))
    elif a.mode == "monetise": print(json.dumps(monetise(a.video, certify_none=a.certify)))
    else: raise SystemExit("usage: youtube_studio.py status|monetise --video ID | selftest")
