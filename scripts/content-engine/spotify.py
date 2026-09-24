#!/usr/bin/env python3
"""spotify.py — the podcast episode on Spotify for Creators, through the agent browser lane.

Spotify for Creators has no upload API, and Ericamae uploaded by hand (SOP: podcast). Her last
episodes were VIDEO episodes of the full vlog (the episodes list shows Format: Video, 7-9 min).
Kevin (5 Sep 2026) chose to keep it VIDEO: the identical full episode file YouTube gets, jingle
included, because Spotify plays a video episode as video or as audio and Premium listeners can
download it. PODCAST_FORMAT = "audio" would upload Ep<N>_Podcast.mp3 instead. Kevin logged the
lane's `spotify` profile in once (3 Sep 2026); this script writes the plan that
`scripts/agent-browser.js` executes: `prepare` uploads the file and fills the details, then
screenshots; `commit` presses Publish only when the episode's approval task reads Approved
(the lane's own gate). In TEST mode the plan ends at the Review step with a screenshot and
never publishes.

The wizard (creators.spotify.com/pod/show/<show>/episode/wizard) has three steps: Upload
(file input #uploadAreaInput), Details (title, description), Review (Publish). Field
selectors for Details are confirmed on the first real episode and pinned here.
"""
import argparse, json, os, re, sys, time
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

PODCAST_FORMAT = "video"          # Kevin, 5 Sep 2026: the same full episode YouTube gets, jingle and all; Spotify plays it as video or audio
SHOW_ID = "6hL5SLvsU1VDMHVaWZZ3tO"          # Runpreneur podcast (from the wizard URL, 3 Sep 2026)
WIZARD = "https://creators.spotify.com/pod/show/%s/episode/wizard" % SHOW_ID
PROFILE = "spotify"


def podcast_parts(podcast_copy, day, fallback_title=""):
    """The Podcast Copy is 'Title: ...', 'Description: ...', 'Hashtags: ...'."""
    text = (podcast_copy or "").strip()
    m = re.search(r"Title:\s*(.+)", text)
    title = (m.group(1).strip() if m else (fallback_title or "Diary of a Runpreneur, Day %d" % day))[:200]
    body = re.sub(r"^Title:.*\n?", "", text, flags=re.M)
    body = re.sub(r"^Description:\s*", "", body.strip(), flags=re.M).replace("\nHashtags:", "\n").strip()
    return title, body[:4000]


ATTACH_DIR = os.path.expanduser("~/knowledge-os/attachments/content-engine")   # the only folder the lane uploads video from
UPLOAD_WAIT_MS = 600000        # a 740 MB episode uploads in about two minutes (9 Sep 2026); ten is the lane's ceiling
NEXT_ENABLED = "button:has-text('Next'):not([disabled])"
PUBLISH_ENABLED = "button:has-text('Publish'):not([disabled])"
# Proof of a Publish: the wizard closes onto the Episodes list, whose "Rows per page" footer no episode copy carries. Every
# successful upload from 21 to 24 Sep 2026 ended on that page. The old proof, text=/published|is live|now live/, could be met
# by the episode's own copy on the Review page (review, 24 Sep 2026), and run_publish now leans on this proof.
PUBLISHED_PROOF = ':text("Rows per page")'
# Spotify's own status words, never the episode's copy. `text=Uploading` matches any element holding "uploading" in any case,
# and 2070's description says "uploading your bank statements": the wait for "Uploading" to clear found the description in the
# editor and never finished, every hour from 23 Sep 09:39 until 24 Sep 2026, each run leaving an Untitled draft (2069, whose
# copy has no such word, went out an hour before). Anything inside the description editor is ignored.
def status_text(words):
    return ':not([contenteditable="true"] *):not([contenteditable="true"]):text("%s")' % words
UPLOADING, PROCESSING, GENERATING = status_text("Uploading"), status_text("Processing"), status_text("Generating preview")
EPISODES = "https://creators.spotify.com/pod/show/%s/episodes" % SHOW_ID


def stage_file(video_path):
    """The lane refuses uploads from anywhere but ATTACH_DIR, so the episode is copied (hard-linked when
    the volume allows) under its own name. Returns the staged path."""
    os.makedirs(ATTACH_DIR, exist_ok=True)
    dst = os.path.join(ATTACH_DIR, os.path.basename(video_path))
    if os.path.abspath(video_path) == os.path.abspath(dst): return dst
    if os.path.exists(dst) and os.path.getsize(dst) == os.path.getsize(video_path): return dst
    if os.path.exists(dst): os.remove(dst)
    try: os.link(video_path, dst)
    except OSError:
        import shutil; shutil.copyfile(video_path, dst)
    return dst


THUMB_INPUT = "input[type='file'][accept^='image/']#uploadAreaInput"   # the Details step's Thumbnails "Upload" (9 Sep 2026: sets at once, no crop dialog)


def build_plan(video_path, title, description, youtube_link, test, thumb=""):
    """The wizard moves to Details on its own once a file is chosen, so the copy is typed while the upload
    runs; Next stays disabled until the upload and Spotify's processing finish. Live plans end with the
    `submit` step the lane only presses after the approval reads Approved; test plans stop at Review."""
    desc = description + ("\n\nWatch the full episode: " + youtube_link if youtube_link else "")
    steps = [
        {"do": "goto", "url": WIZARD},
        {"do": "wait", "for": "#uploadAreaInput", "state": "attached", "ms": 60000},   # the input is hidden off-screen
        {"do": "upload", "selector": "#uploadAreaInput", "file": video_path},
        {"do": "wait", "for": UPLOADING, "ms": 60000},
        {"do": "fill", "selector": "input[name='title'], input[aria-label*='Title'], input[placeholder*='title' i]", "value": title},
        {"do": "fill", "selector": "textarea[name='description'], [contenteditable='true'], textarea", "value": desc},
    ]
    if thumb:   # the branded 16:9 thumbnail is what the Episodes list and the mobile app show (Kevin, 9 Sep 2026: 2054 showed a raw frame)
        steps += [{"do": "upload", "selector": THUMB_INPUT, "file": thumb}, {"do": "wait", "ms": 6000}]
    steps += [
        {"do": "wait", "gone": UPLOADING, "ms": UPLOAD_WAIT_MS},
        {"do": "wait", "gone": PROCESSING, "ms": UPLOAD_WAIT_MS},
        {"do": "wait", "for": NEXT_ENABLED, "ms": UPLOAD_WAIT_MS},
        {"do": "click", "selector": NEXT_ENABLED},
        {"do": "wait", "ms": 6000},
        # Review: "Now" is pre-selected; Publish stays greyed out while "Generating preview" spins
        {"do": "click", "selector": "label[for='publish-date-now']"},   # the publish-date radio starts unticked and Publish refuses without it; the input itself is visually hidden (9 Sep 2026)
        {"do": "wait", "gone": GENERATING, "ms": UPLOAD_WAIT_MS},
        {"do": "wait", "for": PUBLISH_ENABLED, "ms": UPLOAD_WAIT_MS},
    ]
    if not test: steps.append({"do": "submit", "selector": PUBLISH_ENABLED})
    plan = {"profile": PROFILE, "label": "Spotify for Creators: %s" % title[:60], "steps": steps,
            "confirm": {"selector": PUBLISHED_PROOF, "timeoutMs": 120000, "proof": "the wizard closed onto the Episodes list, which it does only after Publish"},
            "mode": "test" if test else "live"}
    return plan


def with_day(title, day):
    """Every title reads 'Episode N - <title>', the shape of Ericamae's last episodes (2050-2053) and ours from 2054.
    Until 17 Sep 2026 a title that already named the day kept whatever shape the model wrote, so 2057 read
    'Will to Win - Day 2057: Teachable Skill or Innate Trait?' and 2058 '... Compassion | Day 2058' (Kevin: "the titles
    in the podcast don't follow suit"). Any 'Episode/Ep/Day N' (with or without the thousands comma) at the start, the
    end, between separators or in brackets is taken out, then the prefix is added once."""
    num = r"(?:%d|%s)" % (day, "{:,}".format(day))
    tag = r"(?:episode|ep\.?|day)\s*%s(?:\s+of\s+(?:my|a|the)\s+[\w ]{0,30}?(?:streak|runpreneur|run))?" % num
    t = (title or "").strip()
    t = re.sub(r"\s*[(\[]\s*%s\s*[)\]]" % tag, "", t, flags=re.I)                          # "(Day 2195)"
    t = re.sub(r"^\s*%s\s*[-:|\u2013\u2014,]*\s*" % tag, "", t, flags=re.I)                 # "Day 2057: ..."
    t = re.sub(r"\s*[-:|\u2013\u2014,]*\s*(?:on\s+)?%s\s*$" % tag, "", t, flags=re.I)       # "... | Day 2058"
    t = re.sub(r"\s*[-|\u2013\u2014]\s*%s\s*[-:|\u2013\u2014]\s*" % tag, ": ", t, flags=re.I)  # "Will to Win - Day 2057: ..."
    t = t.strip(" -:|,\u2013\u2014") or "Diary of a Runpreneur"
    return ("Episode %d - %s" % (day, t))[:200]


def run_plan(plan_path, task_id, test, shot):
    """prepare (test: fills, screenshots, never publishes) or commit (live: the lane's own gate re-reads the
    approval). Returns the lane's JSON result; raises SystemExit with the lane's message on failure."""
    import subprocess
    cmd = ["node", lane(), "prepare" if test else "commit", "--plan", plan_path, "--profile", PROFILE, "--shot", shot]
    if not test: cmd += ["--task", task_id]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1500)
    out = r.stdout.strip()
    if r.returncode != 0: raise SystemExit(lane_error(r.stderr.strip() or out))
    try: return json.loads(out[out.index("{"):])
    except Exception: raise SystemExit("unreadable lane output: " + out[-300:])


def lane_error(err):
    """The lane's own message, not its stack: 2070's podcast failed hourly from 23 Sep 2026 and the record kept only the last
    200 characters, which were stack frames ("owser.js:472:12)"), so nobody could say why. First line, plus the step it was
    waiting on ("waiting for locator('text=Uploading') to be hidden" named the 2070 fault), kept short."""
    lines = [l.strip() for l in (err or "").splitlines() if l.strip()]
    head = (lines[0] if lines else "").replace("BROWSER ERROR: ", "")
    step = next((l.lstrip("- ") for l in lines if l.lstrip("- ").startswith("waiting for")), "")
    if step:     # name the step by its status word, not by a selector the cut would truncate (review, 24 Sep 2026)
        word = re.search(r':text\("([^"]+)"\)|text=([^\')]+)', step); state = re.search(r"to be (\w+)", step)
        step = "waiting for '%s'%s" % (next(g for g in word.groups() if g) if word else step[12:70], (" to be " + state.group(1)) if state else "")
    msg = (head[:110] + (" | " + step if step else "")) if head else (err or "")[-190:]
    return msg[:190]


def write_plan(day, video_path, podcast_copy, youtube_link, test, out_dir, thumb=""):
    title, desc = podcast_parts(podcast_copy, day)
    title = with_day(title, day)
    plan = build_plan(stage_file(video_path), title, desc, youtube_link, test, stage_file(thumb) if thumb and os.path.exists(thumb) else "")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "spotify_plan_%d.json" % day)
    with open(path, "w") as fh: json.dump(plan, fh, indent=1)
    return path, title


def lane():
    return os.path.join(os.path.dirname(HERE), "agent-browser.js")   # scripts/agent-browser.js, not the repo root


def verify_published(title, tries=3, wait=20, sleep=time.sleep):
    """The real proof, read from the episodes list: 'published' when the title's row says Published,
    'processing' while it still says Draft (Spotify shows a freshly published video as Draft for a few
    minutes), 'missing' otherwise. The list lags the upload, so it is read more than once (10 Sep 2026:
    2055 was live and the first read still said missing)."""
    import subprocess
    last = ("missing", "the episodes list was not readable")
    for n in range(max(1, tries)):
        r = subprocess.run(["node", lane(), "read", "--url", EPISODES, "--profile", PROFILE, "--wait", "9000"],
                           capture_output=True, text=True, timeout=240)
        out = r.stdout
        try: text = json.loads(out[out.index("{"):]).get("text") or ""
        except Exception: text = ""
        if text:
            last = list_status(text, title)
            if last[0] == "published": return last
            if last[0] == "missing" and list_incomplete(text):
                last = ("missing", "the episodes list was not readable in full: more episodes than the page shows")
        if n < tries - 1: sleep(wait)
    return last


LIST_PAGE_ROWS = 20


def list_incomplete(text):
    """The episodes page may not show every episode: a 'load more' control, or a page's worth of rows, means a title
    that is not in the text may still exist. A retry that trusts an incomplete list uploads a second copy
    (review, 15 Sep 2026), so verify_published reports the list as not readable in full instead of 'missing'."""
    return bool(re.search(r"\b(load|show) more( episodes)?\b", text, re.I))   # a row count was a stall in waiting (review, 15 Sep 2026)


def list_status(text, title):
    """The row's status word, taken as the first Published/Draft/Scheduled after the title, not the next
    word: the title is matched on its first 60 characters, so the words right after it are still the title."""
    key = title[:60]
    best = ("missing", "title not in the first page of episodes")
    for m in re.finditer(re.escape(key), text):
        after = " ".join(text[m.start():m.start() + 400].split())
        st = re.search(r"\b(Published|Draft|Scheduled)\b", after)
        if not st: continue
        if st.group(1) == "Published": return "published", after[:160]
        if st.group(1) in ("Draft", "Scheduled"): best = ("processing", after[:160])
    return best


SHOW_PAGE = "https://open.spotify.com/show/%s" % SHOW_ID
EPISODE_ID_RE = re.compile(r"/episode/([A-Za-z0-9]{22})")
_show_links = None


def embed_links():
    """{episode name: open.spotify.com link} from the show's public embed page: one HTTP read, no login, no browser.
    It lists ONLY the newest episode."""
    import urllib.request
    try:
        req = urllib.request.Request("https://open.spotify.com/embed/show/%s" % SHOW_ID, headers={"User-Agent": "Mozilla/5.0"})
        html = urllib.request.urlopen(req, timeout=30).read().decode("utf8", "ignore")
    except Exception as ex:
        print("spotify: embed page not readable (%s)" % str(ex)[:120], file=sys.stderr); return {}
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m: return {}
    out = {}
    def walk(o):
        if isinstance(o, dict):
            if str(o.get("uri", "")).startswith("spotify:episode:") and o.get("name"):
                out[str(o["name"])] = "https://open.spotify.com/episode/" + o["uri"].split(":")[-1]
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
    walk(json.loads(m.group(1)))
    return out


def show_links(run=None):
    """{episode title: link} from the full show page, read through the browser lane: the newest episodes, about six.
    21 Sep 2026: the embed page shows only the newest episode, so when two or three went out in one run the older
    ones never got a link (2062 and 2063 were read by hand). Read once per process; an empty read is not kept."""
    global _show_links
    if _show_links: return _show_links
    import subprocess
    run = run or subprocess.run
    try:
        r = run(["node", lane(), "read", "--url", SHOW_PAGE, "--profile", PROFILE, "--wait", "8000", "--links", "/episode/", "--max-text", "2000"],
                capture_output=True, text=True, timeout=240)
        out = r.stdout
        links = json.loads(out[out.index("{"):]).get("links") or []
    except Exception as ex:
        print("spotify: show page not readable (%s)" % str(ex)[:120], file=sys.stderr); return {}
    found = {}
    for l in links:
        m = EPISODE_ID_RE.search(l.get("href") or "")
        if m and l.get("text"): found.setdefault(l["text"], "https://open.spotify.com/episode/" + m.group(1))
    _show_links = found or None
    return found


def link_from(links, title):
    """The link whose name starts like the title (its first 50 characters, which carry "Episode NNNN - ")."""
    key = (title or "")[:50]
    if not key: return ""
    for name, link in (links or {}).items():
        if key in name: return link
    return ""


def public_link(title):
    """The open.spotify.com link once the episode is out: the embed page first (cheap, newest only), then the full
    show page through the browser lane when the episode is not the newest."""
    return link_from(embed_links(), title) or link_from(show_links(), title)


def selftest():
    e = lane_error("BROWSER ERROR: TimeoutError: page.waitForSelector: Timeout 60000ms exceeded. Failure screenshot: /x.png\n    at runSteps (/r/agent-browser.js:472:12)\n    at async main (/r/agent-browser.js:996:17)")
    assert e.startswith("TimeoutError: page.waitForSelector") and "472:12" not in e and len(e) <= 190, e
    e2 = lane_error("BROWSER ERROR: page.waitForSelector: Timeout 600000ms exceeded.\nCall log:\n  - waiting for locator('text=Uploading') to be hidden\n    123 x locator resolved")
    assert "waiting for 'Uploading' to be hidden" in e2 and len(e2) <= 190, e2
    e3 = lane_error("BROWSER ERROR: page.waitForSelector: Timeout 600000ms exceeded.\nCall log:\n  - waiting for locator(':not([contenteditable=\"true\"] *):not([contenteditable=\"true\"]):text(\"Processing\")') to be hidden\n")
    assert "waiting for 'Processing' to be hidden" in e3 and len(e3) <= 190, e3
    steps = build_plan("/x.mp4", "T", "I tried uploading my statements", "", True)["steps"]
    assert not any((st.get("for") or st.get("gone") or "").startswith("text=") for st in steps if st["do"] == "wait"), "no bare text= wait: it matches the copy"
    plan_c = build_plan("/x.mp4", "T", "Now live: I published my plan", "", False)
    assert plan_c["confirm"]["selector"] == PUBLISHED_PROOF and not PUBLISHED_PROOF.startswith("text="), "the Publish proof is never a word the copy can hold"
    rows = " ".join("Episode %d - Title %d Published 9/1/26 Video 04:00" % (2000 + i, i) for i in range(25))
    assert not list_incomplete(rows) and list_incomplete("Episode 2054 x Load more") and not list_incomplete("see more of this description"), "only a load-more control means the list goes on"
    assert list_status("Episode 2054 - T Published", "Episode 2054 - T")[0] == "published" and list_status("nothing", "Episode 2054")[0] == "missing"
    t, d = podcast_parts("Title: Day 2195 running off-road\nDescription: Six years in.\n\nMore.\nHashtags: #a #b", 2195)
    assert t == "Day 2195 running off-road" and d.startswith("Six years in.") and "#a #b" in d and "Title:" not in d, (t, d)
    assert podcast_parts("", 7)[0] == "Diary of a Runpreneur, Day 7"
    assert with_day("Coping With Stress", 2054) == "Episode 2054 - Coping With Stress"
    assert with_day(t, 2195) == "Episode 2195 - running off-road", with_day(t, 2195)
    assert with_day("Will to Win - Day 2057: Teachable Skill or Innate Trait?", 2057) == "Episode 2057 - Will to Win: Teachable Skill or Innate Trait?"
    assert with_day("Bitterness After Relationship Breakdown: Reframing Resentment as Compassion | Day 2058", 2058) == "Episode 2058 - Bitterness After Relationship Breakdown: Reframing Resentment as Compassion"
    assert with_day("Off-Road Running at Pace (Day 2,195)", 2195) == "Episode 2195 - Off-Road Running at Pace"
    assert with_day("Episode 2054 - Coping With Stress", 2054) == "Episode 2054 - Coping With Stress", "an already correct title is left alone"
    assert with_day("Why 20 minutes matters", 2059) == "Episode 2059 - Why 20 minutes matters", "other numbers are not the day"
    p = build_plan("/x/Episode_2195_Full_Episode.mp4", "T", "D", "https://youtu.be/x", True)
    assert p["steps"][2] == {"do": "upload", "selector": "#uploadAreaInput", "file": "/x/Episode_2195_Full_Episode.mp4"}
    assert p["mode"] == "test" and "youtu.be/x" in p["steps"][5]["value"] and not any(s["do"] == "submit" for s in p["steps"])
    assert not any(s.get("selector") == THUMB_INPUT for s in p["steps"]), "no thumbnail step without a thumbnail"
    pt = build_plan("/x/v.mp4", "T", "D", "", True, thumb="/x/Episode_1_Thumbnail.png")
    ups = [s for s in pt["steps"] if s["do"] == "upload"]
    assert ups[0]["selector"] == "#uploadAreaInput" and ups[1] == {"do": "upload", "selector": THUMB_INPUT, "file": "/x/Episode_1_Thumbnail.png"}
    assert pt["steps"].index(ups[1]) > pt["steps"].index([s for s in pt["steps"] if s["do"] == "fill"][1]), "thumbnail after the copy, before the upload wait"
    waits = [s for s in p["steps"] if s["do"] == "wait" and (s.get("gone") or s.get("for"))]
    assert all(s["ms"] <= 600000 for s in waits) and any(s.get("gone") == UPLOADING for s in waits)
    live = build_plan("/x", "T", "D", "", False)
    assert live["steps"][-1]["do"] == "submit" and live["confirm"]["selector"] and live["mode"] == "live"
    assert live["steps"][-2] == {"do": "wait", "for": PUBLISH_ENABLED, "ms": UPLOAD_WAIT_MS}
    assert any(s.get("selector") == "label[for='publish-date-now']" for s in live["steps"])
    lst = "Title\n\nEpisode 9 - A long title that runs past sixty characters for the row\n\t\nDraft\n\t\n9/9/26\n\nEpisode 9 - A long title that runs past sixty characters for the row\n\t\nPublished\n\t\n9/9/26\n"
    long_title = "Episode 9 - A long title that runs past sixty characters for the row"
    assert list_status(lst, long_title)[0] == "published", list_status(lst, long_title)
    assert list_status(lst.split("Published")[0], long_title)[0] == "processing", "still processing while the row says Draft"
    assert list_status(lst, "Episode 8 - B")[0] == "missing"
    calls = []
    assert verify_published.__defaults__[0] >= 2, "the list lags the upload, so it is read more than once"
    assert os.path.exists(os.path.join(os.path.dirname(HERE), "agent-browser.js")), "the browser lane path must resolve (2055 failed with MODULE_NOT_FOUND)"
    assert WIZARD.endswith("/episode/wizard") and SHOW_ID in WIZARD and PODCAST_FORMAT in ("audio", "video")
    # 21 Sep 2026: three episodes in one run; the embed page showed only the newest, so the older two had no link
    global _show_links
    lane_out = json.dumps({"title": "Runpreneur", "links": [
        {"href": "https://open.spotify.com/episode/2ArPaZQIZZgvWGOky3iB77", "text": "Episode 2063 - Contingency Forecasting: Budget for What Goes Wrong"},
        {"href": "https://open.spotify.com/episode/4lpJm9VwYNClc6PLErvIJG?si=x", "text": "Episode 2062 - ADHD Entrepreneur: Match or Disaster for Business?"},
        {"href": "https://open.spotify.com/show/6hL5SLvsU1VDMHVaWZZ3tO", "text": "Runpreneur"}]})
    calls = []
    fake_run = lambda cmd, **kw: calls.append(cmd) or type("R", (), {"stdout": "lane says hi\n" + lane_out})()
    _show_links = None
    got = show_links(run=fake_run)
    assert got == {"Episode 2063 - Contingency Forecasting: Budget for What Goes Wrong": "https://open.spotify.com/episode/2ArPaZQIZZgvWGOky3iB77",
                   "Episode 2062 - ADHD Entrepreneur: Match or Disaster for Business?": "https://open.spotify.com/episode/4lpJm9VwYNClc6PLErvIJG"}, got
    assert "--links" in calls[0] and SHOW_PAGE in calls[0] and show_links(run=fake_run) == got and len(calls) == 1, "one browser read per run"
    assert link_from(got, "Episode 2062 - ADHD Entrepreneur: Match or Disaster for Business?") == "https://open.spotify.com/episode/4lpJm9VwYNClc6PLErvIJG"
    assert link_from(got, "Episode 2064 - Regaining Fitness After Injury") == "" and link_from(got, "") == ""
    real_embed, real_show = globals()["embed_links"], globals()["show_links"]
    try:
        globals()["embed_links"] = lambda: {"Episode 2064 - Regaining Fitness After Injury: the 6-week rule": "https://open.spotify.com/episode/NEWEST"}
        globals()["show_links"] = lambda run=None: got
        assert public_link("Episode 2064 - Regaining Fitness After Injury: the 6-week rule") == "https://open.spotify.com/episode/NEWEST", "the newest comes off the cheap page"
        assert public_link("Episode 2062 - ADHD Entrepreneur: Match or Disaster for Business?") == "https://open.spotify.com/episode/4lpJm9VwYNClc6PLErvIJG", "an older one off the show page"
    finally:
        globals()["embed_links"], globals()["show_links"] = real_embed, real_show
    _show_links = None
    bad = lambda cmd, **kw: type("R", (), {"stdout": "no json here"})()
    import io, contextlib
    with contextlib.redirect_stderr(io.StringIO()): assert show_links(run=bad) == {} and _show_links is None, "an unreadable page is said, never cached"
    print(json.dumps({"checks": 23, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--day", type=int, default=0)
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    else: raise SystemExit("usage: spotify.py selftest (plans are written by publish.py stage 2)")
