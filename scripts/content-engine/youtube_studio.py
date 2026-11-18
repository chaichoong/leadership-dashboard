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

# Signed out (16 Oct to 18 Nov 2026): Studio sends the robot to Google's sign-in ("Verify that it's you ... sign in again"),
# or, signed into a Google account that has no channel, on to www.youtube.com. Neither page can ever show the earn heading,
# so the read stopped only at its 60 s wait, 117 videos a day, and nobody was told the robot needed a sign-in.
# One rule, run as it stands by the selftest: null while the page is Studio, else why not, and whether only a sign-in fixes
# it. Only those two pages mean signed out; a page that did not load or a consent page is a plain failed read.
WALL_JS = r"""
const signinWall = (u) => {
  let url; try { url = new URL(u); } catch (e) { return { why: 'the page did not load' }; }
  if (url.hostname === 'studio.youtube.com') return null;
  if (url.hostname === 'accounts.google.com') return { why: 'Studio sent the robot to Google sign-in (' + url.pathname + ')', signedOut: true };
  if (url.hostname === 'www.youtube.com') return { why: 'Studio sent the robot to www.youtube.com: the Google account signed in has no Studio', signedOut: true };
  return { why: 'Studio did not open (' + (url.hostname || url.protocol + ' page') + ')' };
};
"""
SIGNIN_NEEDED = "SIGN-IN NEEDED: studio.youtube.com (https://studio.youtube.com/)"

JS = r"""
const path = require('path'), os = require('os');
%(wall)s
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
  // ONE result line, ever. A read that failed printed its error, the close then hung, and the 240 s watchdog printed a
  // second line, so Python died on "Extra data" (2113, 2150 and others, Oct to Nov 2026) after four minutes each.
  let said = false;
  const say = (o) => { if (said) return; said = true; console.log(JSON.stringify(o)); };
  // the close gets 15 s, never the rest of the watchdog's four minutes: the job queue waits behind this run
  const finish = async () => { setTimeout(() => process.exit(0), %(close_ms)d); await page.close({ runBeforeUnload: false }).catch(() => {}); await ctx.close().catch(() => {}); process.exit(0); };
  setTimeout(() => { say(Object.assign(out, { error: out.error || 'watchdog: 240 s' })); process.exit(0); }, %(watchdog_ms)d);
  const open = async () => {
    await page.goto(%(url)s, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(10000);
    const skip = page.getByText('SKIP TO YOUTUBE STUDIO', { exact: true }).first();
    if (await skip.count()) { await skip.click(); await page.waitForTimeout(8000); }
    const wall = signinWall(page.url());
    if (wall) { const e = new Error((wall.signedOut ? %(signin)s + '. ' : '') + wall.why); e.signedOut = !!wall.signedOut; throw e; }
    await page.getByText(HEADING_RE).first().waitFor({ timeout: 60000 });
  };
  const read = async () => page.evaluate((hs) => {
    const t = document.body.innerText.replace(/\s+/g, ' ');
    for (const h of hs) {
      const i = t.indexOf(h);
      if (i < 0) continue;
      // "Sharing" = ads run and the revenue is shared with a copyright claimant (17 Sep 2026: KDWp5jtQllY, concert footage)
      const m = t.slice(i, i + 220).match(/\b(On|Off|Checking|Sharing)\b/); return m ? m[1] : 'unknown';
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
          say(out); await finish();
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
  } catch (e) {
    let msg = e.message, signedOut = !!e.signedOut;
    const late = signedOut ? null : signinWall(page.url());     // a redirect to sign-in that came after the 10 s wait
    if (late && late.signedOut) { msg = %(signin)s + '. ' + late.why; signedOut = true; }
    out.error = msg.slice(0, 240); if (signedOut) out.signed_out = true;
  }
  say(out);
  await finish();
})();
"""


def _node():
    for c in (os.environ.get("NODE"), subprocess.run(["bash", "-lc", "command -v node"], capture_output=True, text=True).stdout.strip()):
        if c and os.path.exists(c): return c
    vers = sorted([d for d in os.listdir(os.path.expanduser("~/.nvm/versions/node")) if d.startswith("v")], key=lambda v: [int(x) for x in re.findall(r"\d+", v)]) if os.path.isdir(os.path.expanduser("~/.nvm/versions/node")) else []
    if vers: return os.path.expanduser("~/.nvm/versions/node/%s/bin/node" % vers[-1])
    return "node"


def _script(video_id, act, shot, certify=False, pw=PW, close_ms=15000, watchdog_ms=240000):
    """The browser script for one read. `pw`, `close_ms` and `watchdog_ms` are the selftest's: a stand-in browser, short clocks."""
    return JS % {"pw": json.dumps(pw), "vid": json.dumps(video_id), "act": json.dumps(act), "headings": json.dumps(HEADINGS),
                 "profile": json.dumps(PROFILE), "ua": json.dumps(UA), "url": json.dumps(EARN_URL % video_id), "shot": json.dumps(shot),
                 "certify": "true" if certify else "false", "categories": json.dumps(RATING_CATEGORIES),
                 "wall": WALL_JS, "signin": json.dumps(SIGNIN_NEEDED), "close_ms": close_ms, "watchdog_ms": watchdog_ms}


def _run(video_id, act, shot=None, certify=False):
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id or ""): raise SystemExit("not a YouTube video id: %r" % video_id)
    shot = shot or os.path.join(tempfile.gettempdir(), "yt_earn_%s.png" % video_id)
    js = _script(video_id, act, shot, certify)
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as fh:
        fh.write(js); path = fh.name
    try:
        r = subprocess.run([_node(), path], capture_output=True, text=True, timeout=300)
    finally:
        os.remove(path)
    res = _result(r.stdout, r.stderr); res["shot"] = shot
    return res


def _result(stdout, stderr="", what="studio read failed"):
    """The browser's result: the FIRST whole JSON object it printed, over one line or many (youtube_ads.js indents its
    own). Before 18 Nov 2026 everything from the first "{" was parsed as one document, so a read that printed its error
    and then the watchdog's line raised "Extra data" and lost both."""
    text, dec = stdout or "", json.JSONDecoder()
    i = text.find("{")
    while i >= 0:
        try:
            res, _ = dec.raw_decode(text, i)
            if isinstance(res, dict): return res
        except ValueError:
            pass
        i = text.find("{", i + 1)
    raise SystemExit("%s: %s" % (what, (stderr or stdout or "no output")[-240:]))


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
    assert "On|Off|Checking|Sharing" in JS, "after the rating YouTube shows Checking before On (13 Sep 2026); a claimed video reads Sharing (17 Sep 2026)"
    assert "Shorts Feed ads" in HEADINGS and "HEADING_RE" in JS and "for (const h of hs)" in JS, "a Short's earn page is read too (17 Sep 2026)"
    assert "lit.locator('#checkbox')" in JS and "did not tick" in JS, "the tick is proved before Submit"
    assert "if (!CERTIFY || missing.length)" in JS, "the rating is answered only for an approved card, and only when YouTube asks exactly the listed questions"
    assert len(RATING_CATEGORIES) == 11 and "Controversial issues" in RATING_CATEGORIES
    assert os.path.basename(_node()) == "node", "a node binary is found even under launchd's bare PATH"
    # "Extra data" (2113, 2150 and others, Oct to Nov 2026): the error line, then the watchdog's line. The first is the answer.
    timeout = {"video": "abcdefghijk", "error": "locator.waitFor: Timeout 60000ms exceeded.\nCall log:\n  - waiting for getByText(/^(Watch page ads and YouTube Premium|Shorts Feed ads)$/).first() to be visible\n"}
    two = json.dumps(timeout) + "\n" + json.dumps(dict(timeout, error="watchdog: 240 s")) + "\n"
    try: json.loads(two[two.index("{"):]); old = "parsed"
    except ValueError as ex: old = str(ex)
    assert old.startswith("Extra data"), "control: the old parse raised Extra data on exactly this output (%s)" % old
    assert _result(two) == timeout, "two result lines: the first is read, and nothing raises"
    assert _result("(node:1) Warning: something\n" + json.dumps({"video": "abcdefghijk", "status": "On"}))["status"] == "On"
    assert _result(json.dumps({"abc": "on"}, indent=1) + "\n" + json.dumps({"error": "watchdog"}))["abc"] == "on", \
        "an indented result over several lines (youtube_ads.js) is read whole"
    try: _result("Error: Cannot find module 'playwright'", "boom"); ok = False
    except SystemExit: ok = True
    assert ok, "no result at all still fails loudly"
    # The browser script itself, run in node against a stand-in browser whose close never returns (the hang behind
    # "Extra data"), with short clocks. Each case: exactly ONE result line, and the process ends on the close clock.
    fake = r"""
const SCEN = process.env.FAKE_STUDIO, SIGNIN = 'https://accounts.google.com/v3/signin/confirmidentifier?continue=x';
let current = 'about:blank';
const hang = () => new Promise(() => {});
const loc = { first() { return this; }, last() { return this; }, filter() { return this; }, locator() { return this; },
  async count() { return 0; }, async click() {},
  async waitFor() { if (SCEN === 'late') current = SIGNIN; throw new Error('locator.waitFor: Timeout 60000ms exceeded.'); } };
const page = { on() {}, url: () => current, getByText: () => loc, locator: () => loc, close: hang,
  async goto(u) { current = { signin: SIGNIN, account: 'https://www.youtube.com/', consent: 'https://consent.youtube.com/m?continue=x' }[SCEN] || u; },
  async waitForTimeout() {}, async evaluate() { return 'unknown'; }, async screenshot() {} };
module.exports = { chromium: { async launchPersistentContext() { return { pages: () => [page], newPage: async () => page, close: hang }; } } };
"""
    import time as _time
    tmp = tempfile.mkdtemp(prefix="yt_studio_selftest_")
    try:
        fake_path = os.path.join(tmp, "fake_playwright.js"); script = os.path.join(tmp, "read.js")
        with open(fake_path, "w") as fh: fh.write(fake)
        with open(script, "w") as fh: fh.write(_script("abcdefghijk", "status", os.path.join(tmp, "shot.png"), pw=fake_path, close_ms=300, watchdog_ms=3000))
        seen = {}
        for scen in ("timeout", "signin", "account", "late", "consent"):
            t0 = _time.time()
            r = subprocess.run([_node(), script], capture_output=True, text=True, timeout=30, env=dict(os.environ, FAKE_STUDIO=scen))
            lines = [l for l in r.stdout.splitlines() if l.strip()]
            assert len(lines) == 1, "%s: one result line, never the watchdog's second: %r %s" % (scen, lines, r.stderr[-200:])
            assert _time.time() - t0 < 2.5, "%s: a hung close ends on its own clock, not the watchdog's" % scen
            seen[scen] = json.loads(lines[0])
        assert "Timeout" in seen["timeout"]["error"] and not seen["timeout"].get("signed_out"), seen["timeout"]
        for scen in ("signin", "account", "late"):
            assert seen[scen].get("signed_out") is True and seen[scen]["error"].startswith(SIGNIN_NEEDED), (scen, seen[scen])
        assert "Google sign-in" in seen["signin"]["error"] and "www.youtube.com" in seen["account"]["error"]
        assert not seen["consent"].get("signed_out") and "consent.youtube.com" in seen["consent"]["error"], \
            "a consent page is a failed read, not a sign-in: %s" % seen["consent"]
    finally:
        import shutil; shutil.rmtree(tmp, ignore_errors=True)
    assert "setTimeout(() => process.exit(0), 15000)" in _script("abcdefghijk", "status", "x.png") and \
        "}, 240000);" in _script("abcdefghijk", "status", "x.png"), "the real clocks: 15 s to close, 240 s watchdog"
    print(json.dumps({"checks": 21, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--video", default=""); ap.add_argument("--certify", action="store_true", help="answer the content rating 'None of the above' (approved cards only)")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "status": print(json.dumps(status(a.video)))
    elif a.mode == "monetise": print(json.dumps(monetise(a.video, certify_none=a.certify)))
    else: raise SystemExit("usage: youtube_studio.py status|monetise --video ID | selftest")
