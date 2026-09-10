#!/usr/bin/env python3
"""facebook_share.py — the episode SHARED from the Runpreneur Facebook page to Kevin's own profile.

Kevin, 10 Sep 2026: "with the Facebook profile, it should just be shared from the Facebook page to the
Facebook profile." Not a new post: the page's own post, shared, so the page keeps the engagement and his
friends see it from him. Ericamae did this by hand after every episode.

GoHighLevel publishes the page post but never tells us its URL (its API still said "scheduled" with no
previewLink for posts that went out on 9 Sep 2026), so the page post is found on the page itself: the
newest reel whose caption starts with the copy we published. Then the share dialog: Share -> "Say
something about this..." -> Share now, as Kevin, to Feed, Public.

The lane's rules hold: the browser runs in the profile Kevin signed into with the Robot sign-in app, and
`commit` presses "Share now" only when the episode's approval card reads Approved.

  facebook_share.py find --day N     # the page post URL for that episode
  facebook_share.py selftest
"""
import argparse, json, os, re, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

PROFILE = "default"                       # the profile the Robot sign-in app signs into
PAGE_ID = "61594022462166"                # the Runpreneur page (facebook.com/people/Runpreneur/<id>)
PAGE_URL = "https://www.facebook.com/%s" % PAGE_ID
SHARE_BUTTON = "div[role='button'][aria-label='Share'], span[role='button'][aria-label='Share']"
SHARE_BOX = "[role='dialog'] [contenteditable='true'], [role='dialog'] [role='textbox']"
SHARE_NOW = "[role='dialog'] [aria-label='Share now'], [role='dialog'] div[role='button']:has-text('Share now')"
SHARE_MAX = 400
MATCH_WORDS = 6                           # words of the caption that identify our post


def share_text(copy, youtube_link):
    """A line of Kevin's own above the shared post: the first sentence of the copy, plus the episode link."""
    body = re.sub(r"^(?:SEO )?Title:.*\n?", "", (copy or "").strip(), flags=re.M)
    body = re.sub(r"^Description:\s*", "", body.strip(), flags=re.M)
    first = ""
    for para in re.split(r"\n\s*\n", body):
        para = re.sub(r"\s*#\w+", "", para).strip()
        if para and not para.lower().startswith("hashtags:"):
            first = para; break
    first = first[:SHARE_MAX].strip()
    if youtube_link and youtube_link not in first:
        first = (first + "\n\n" + youtube_link).strip()
    return first


def match_key(copy):
    """The first few words of the published caption: what identifies our post in the page's feed."""
    body = re.sub(r"^(?:SEO )?Title:.*\n?", "", (copy or "").strip(), flags=re.M)
    body = re.sub(r"^Description:\s*", "", body.strip(), flags=re.M)
    words = re.sub(r"\s+", " ", body).strip().split(" ")
    return " ".join(words[:MATCH_WORDS]).strip()


def build_plan(post_url, text, test):
    """Open the page's post and share it to Kevin's feed. `test` stops before the share (prepare screenshots it)."""
    steps = [
        {"do": "goto", "url": post_url},
        {"do": "wait", "for": SHARE_BUTTON, "ms": 60000},
        {"do": "click", "selector": SHARE_BUTTON},
        {"do": "wait", "for": SHARE_NOW, "ms": 30000},
    ]
    if text: steps += [{"do": "fill", "selector": SHARE_BOX, "value": text}, {"do": "wait", "ms": 3000}]
    if not test: steps.append({"do": "submit", "selector": SHARE_NOW})
    return {"profile": PROFILE, "site": "www.facebook.com", "label": "Share the page post to Kevin's profile",
            "steps": steps,
            "confirm": {"selector": "[role='dialog']", "state": "hidden", "timeoutMs": 60000,
                        "proof": "the share dialog closes once Facebook has posted it"},
            "mode": "test" if test else "live"}


def lane():
    return os.path.join(os.path.dirname(HERE), "agent-browser.js")


def signed_in():
    """The lane's own session walk (code, never a judgement of a screenshot)."""
    r = subprocess.run(["node", lane(), "session", "--site", "www.facebook.com"], capture_output=True, text=True, timeout=240)
    out = r.stdout
    try: return bool(json.loads(out[out.index("{"):]).get("signedIn"))
    except Exception: return False


def _browser(script, timeout=300):
    """Run a small Playwright script in the lane's signed-in profile and return its JSON line."""
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as fh:
        fh.write(script); path = fh.name
    try:
        r = subprocess.run(["node", path], capture_output=True, text=True, timeout=timeout)
        out = (r.stdout or "").strip()
        if "{" not in out: raise SystemExit((r.stderr or out)[-300:] or "no output from the page read")
        return json.loads(out[out.index("{"):])
    finally:
        os.remove(path)


FIND_JS = """
const path = require('path'), os = require('os');
const { chromium } = require('%(pw)s');
(async () => {
  const dir = path.join(os.homedir(), '.config', 'od', 'agent-browser', '%(profile)s');
  const ctx = await chromium.launchPersistentContext(dir, { headless: true, viewport: { width: 1280, height: 1000 }, channel: 'chrome', ignoreDefaultArgs: ['--enable-automation'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(%(url)s, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(2500); }
  const key = %(key)s.toLowerCase();
  const hit = await page.evaluate((key) => {
    const links = Array.from(document.querySelectorAll('a[href*="/reel/"], a[href*="/posts/"], a[href*="/videos/"]'));
    for (const a of links) {
      let el = a, txt = '';
      for (let j = 0; j < 8 && el; j++) { el = el.parentElement; if (el) txt = el.innerText || ''; if (txt.length > 120) break; }
      if (txt.toLowerCase().replace(/\\s+/g, ' ').includes(key)) return { url: a.href, text: txt.replace(/\\s+/g, ' ').slice(0, 160) };
    }
    return null;
  }, key);
  console.log(JSON.stringify(hit ? { found: true, url: hit.url.split('?')[0], text: hit.text } : { found: false, url: page.url() }));
  await ctx.close(); process.exit(0);
})().catch(e => { console.log(JSON.stringify({ found: false, error: e.message.slice(0, 200) })); process.exit(0); });
"""

PW = "/Users/kevinbrittain/Projects/leadership-dashboard/node_modules/playwright"


def find_page_post(copy, url=None):
    """The page post carrying this episode's caption. Returns its URL, or None."""
    key = match_key(copy)
    if not key: return None
    js = FIND_JS % {"pw": PW, "profile": PROFILE, "url": json.dumps(url or PAGE_URL), "key": json.dumps(key)}
    try: r = _browser(js)
    except SystemExit as ex: print("facebook: page read failed (%s)" % str(ex)[:160], file=sys.stderr); return None
    return r.get("url") if r.get("found") else None


SHARED_JS = """
const path = require('path'), os = require('os');
const { chromium } = require('%(pw)s');
(async () => {
  const dir = path.join(os.homedir(), '.config', 'od', 'agent-browser', '%(profile)s');
  const ctx = await chromium.launchPersistentContext(dir, { headless: true, viewport: { width: 1280, height: 1000 }, channel: 'chrome', ignoreDefaultArgs: ['--enable-automation'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.facebook.com/me', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 2000); await page.waitForTimeout(2000); }
  const id = %(id)s;
  const found = await page.evaluate((id) => Array.from(document.querySelectorAll('a')).some(a => (a.href || '').includes(id)), id);
  console.log(JSON.stringify({ shared: found, url: page.url() }));
  await ctx.close(); process.exit(0);
})().catch(e => { console.log(JSON.stringify({ shared: false, error: e.message.slice(0, 200) })); process.exit(0); });
"""


def post_id(post_url):
    m = re.search(r"/(?:reel|posts|videos)/(\d+)", post_url or "")
    return m.group(1) if m else ""


def verify_shared(post_url):
    """The proof: the shared post appears on Kevin's own profile."""
    pid = post_id(post_url)
    if not pid: return False
    js = SHARED_JS % {"pw": PW, "profile": PROFILE, "id": json.dumps(pid)}
    try: return bool(_browser(js).get("shared"))
    except SystemExit: return False


def write_plan(day, post_url, copy, youtube_link, test, out_dir):
    text = share_text(copy, youtube_link)
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "facebook_share_%d.json" % day)
    with open(path, "w") as fh: json.dump(build_plan(post_url, text, test), fh, indent=1)
    return path, text


def run_plan(plan_path, task_id, test, shot):
    cmd = ["node", lane(), "prepare" if test else "commit", "--plan", plan_path, "--profile", PROFILE, "--shot", shot]
    if not test: cmd += ["--task", task_id]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    out = r.stdout.strip()
    if r.returncode != 0: raise SystemExit((r.stderr.strip() or out)[-600:])
    try: return json.loads(out[out.index("{"):])
    except Exception: raise SystemExit("unreadable lane output: " + out[-300:])


def selftest():
    copy = "Stress coping mechanisms are personal. Mine runs on three things.\n\nMore detail here.\n\n#a #b"
    assert match_key(copy) == "Stress coping mechanisms are personal. Mine"
    t = share_text(copy, "https://youtu.be/x")
    assert t.startswith("Stress coping mechanisms are personal.") and t.endswith("https://youtu.be/x") and "#a" not in t, t
    assert share_text("Description: One line.", "") == "One line."
    assert len(share_text("Description: " + "x" * 900, "")) <= SHARE_MAX
    p = build_plan("https://www.facebook.com/reel/123", t, True)
    assert p["profile"] == "default" and p["steps"][0]["url"].endswith("/reel/123") and not any(s["do"] == "submit" for s in p["steps"])
    live = build_plan("https://www.facebook.com/reel/123", t, False)
    assert live["steps"][-1] == {"do": "submit", "selector": SHARE_NOW} and live["confirm"]["state"] == "hidden"
    assert [s["do"] for s in live["steps"]][:4] == ["goto", "wait", "click", "wait"], "open the post, wait for Share, click it, wait for the dialog"
    assert post_id("https://www.facebook.com/reel/2551081102055515") == "2551081102055515" and post_id("https://x/") == ""
    assert PAGE_ID in PAGE_URL and "aria-label='Share now'" in SHARE_NOW
    print(json.dumps({"checks": 9, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--day", type=int, default=0); ap.add_argument("--copy", default="")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "session": print(json.dumps({"signedIn": signed_in()}))
    elif a.mode == "find":
        import publish
        recs = publish.bundle(a.day); copy = a.copy or ((recs.get("Short Form Video") or {}).get("fields", {}).get("Facebook Reels Copy") or "")
        print(json.dumps({"day": a.day, "key": match_key(copy), "url": find_page_post(copy)}))
    else: raise SystemExit("usage: facebook_share.py selftest | session | find --day N")
