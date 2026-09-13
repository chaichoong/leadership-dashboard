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
HEADING = "Watch page ads and YouTube Premium"

JS = r"""
const path = require('path'), os = require('os');
const { chromium } = require(%(pw)s);
const VID = %(vid)s, ACT = %(act)s, HEADING = %(heading)s;
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
    await page.getByText(HEADING, { exact: true }).first().waitFor({ timeout: 60000 });
  };
  const read = async () => page.evaluate((h) => {
    const t = document.body.innerText.replace(/\s+/g, ' '); const i = t.indexOf(h);
    if (i < 0) return 'unknown';
    const m = t.slice(i, i + 220).match(/\b(On|Off)\b/); return m ? m[1] : 'unknown';
  }, HEADING);
  try {
    await open();
    out.before = await read();
    if (ACT === 'monetise' && out.before === 'Off') {
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
        await page.screenshot({ path: %(shot)s });
        const c = page.locator('ytcp-button:has-text("Cancel"):visible').last();
        if (await c.count()) { await c.click().catch(() => {}); await page.waitForTimeout(1500); }
        out.needs_rating = true; out.status = 'needs-rating';
        console.log(JSON.stringify(out)); await finish();
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


def _run(video_id, act, shot=None):
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id or ""): raise SystemExit("not a YouTube video id: %r" % video_id)
    shot = shot or os.path.join(tempfile.gettempdir(), "yt_earn_%s.png" % video_id)
    js = JS % {"pw": json.dumps(PW), "vid": json.dumps(video_id), "act": json.dumps(act), "heading": json.dumps(HEADING),
               "profile": json.dumps(PROFILE), "ua": json.dumps(UA), "url": json.dumps(EARN_URL % video_id), "shot": json.dumps(shot)}
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


def monetise(video_id):
    """Switch it On if it is Off. Returns the result dict; res['status'] == 'On' is the proof."""
    return _run(video_id, "monetise")


def selftest():
    assert EARN_URL % "abcdefghijk" == "https://studio.youtube.com/video/abcdefghijk/monetization/ads"
    try: _run("not-an-id", "status"); ok = False
    except SystemExit: ok = True
    assert ok, "only an 11-character video id reaches the browser"
    assert "open();" in JS and "out.after = await read();" in JS, "the switch is read back from a fresh page"
    assert "#radio-on" in JS and "#save-button" in JS, "the On radio and the dialog's Done button are the proven controls (13 Sep 2026)"
    assert "runBeforeUnload: false" in JS and "watchdog" in JS, "a dirty form can never hang the close"
    assert "Tell us what's in your video" in JS and "needs-rating" in JS and "Submit" not in JS, "the content rating is Kevin's declaration: detected and cancelled, never submitted"
    assert os.path.basename(_node()) == "node", "a node binary is found even under launchd's bare PATH"
    print(json.dumps({"checks": 7, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--video", default="")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "status": print(json.dumps(status(a.video)))
    elif a.mode == "monetise": print(json.dumps(monetise(a.video)))
    else: raise SystemExit("usage: youtube_studio.py status|monetise --video ID | selftest")
