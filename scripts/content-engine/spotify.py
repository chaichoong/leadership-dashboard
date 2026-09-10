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
import argparse, json, os, re, sys
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
PUBLISHED_PROOF = "text=/published|is live|now live/i"
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
        {"do": "wait", "for": "text=Uploading", "ms": 60000},
        {"do": "fill", "selector": "input[name='title'], input[aria-label*='Title'], input[placeholder*='title' i]", "value": title},
        {"do": "fill", "selector": "textarea[name='description'], [contenteditable='true'], textarea", "value": desc},
    ]
    if thumb:   # the branded 16:9 thumbnail is what the Episodes list and the mobile app show (Kevin, 9 Sep 2026: 2054 showed a raw frame)
        steps += [{"do": "upload", "selector": THUMB_INPUT, "file": thumb}, {"do": "wait", "ms": 6000}]
    steps += [
        {"do": "wait", "gone": "text=Uploading", "ms": UPLOAD_WAIT_MS},
        {"do": "wait", "gone": "text=Processing", "ms": UPLOAD_WAIT_MS},
        {"do": "wait", "for": NEXT_ENABLED, "ms": UPLOAD_WAIT_MS},
        {"do": "click", "selector": NEXT_ENABLED},
        {"do": "wait", "ms": 6000},
        # Review: "Now" is pre-selected; Publish stays greyed out while "Generating preview" spins
        {"do": "click", "selector": "label[for='publish-date-now']"},   # the publish-date radio starts unticked and Publish refuses without it; the input itself is visually hidden (9 Sep 2026)
        {"do": "wait", "gone": "text=Generating preview", "ms": UPLOAD_WAIT_MS},
        {"do": "wait", "for": PUBLISH_ENABLED, "ms": UPLOAD_WAIT_MS},
    ]
    if not test: steps.append({"do": "submit", "selector": PUBLISH_ENABLED})
    plan = {"profile": PROFILE, "label": "Spotify for Creators: %s" % title[:60], "steps": steps,
            "confirm": {"selector": PUBLISHED_PROOF, "timeoutMs": 120000, "proof": "the wizard says the episode is published"},
            "mode": "test" if test else "live"}
    return plan


def with_day(title, day):
    """Ericamae's episodes read 'Episode 2053 - ...'; a Podcast Copy title without the day gets the same prefix."""
    return title if re.search(r"\b%d\b" % day, title) else ("Episode %d - %s" % (day, title))[:200]


def run_plan(plan_path, task_id, test, shot):
    """prepare (test: fills, screenshots, never publishes) or commit (live: the lane's own gate re-reads the
    approval). Returns the lane's JSON result; raises SystemExit with the lane's message on failure."""
    import subprocess
    lane = os.path.join(os.path.dirname(HERE), "agent-browser.js")   # scripts/agent-browser.js, not the repo root (10 Sep 2026: MODULE_NOT_FOUND on 2055)
    cmd = ["node", lane, "prepare" if test else "commit", "--plan", plan_path, "--profile", PROFILE, "--shot", shot]
    if not test: cmd += ["--task", task_id]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1500)
    out = r.stdout.strip()
    if r.returncode != 0: raise SystemExit((r.stderr.strip() or out)[-600:])
    try: return json.loads(out[out.index("{"):])
    except Exception: raise SystemExit("unreadable lane output: " + out[-300:])


def write_plan(day, video_path, podcast_copy, youtube_link, test, out_dir, thumb=""):
    title, desc = podcast_parts(podcast_copy, day)
    title = with_day(title, day)
    plan = build_plan(stage_file(video_path), title, desc, youtube_link, test, stage_file(thumb) if thumb and os.path.exists(thumb) else "")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "spotify_plan_%d.json" % day)
    with open(path, "w") as fh: json.dump(plan, fh, indent=1)
    return path, title


def verify_published(title):
    """The real proof, read from the episodes list: 'published' when the title's row says Published,
    'processing' when it still says Draft (Spotify shows a freshly published video as Draft for a few
    minutes while it processes: 9 Sep 2026, episode 2054), 'missing' otherwise. Returns (status, snippet)."""
    import subprocess
    lane = os.path.join(os.path.dirname(HERE), "agent-browser.js")   # scripts/agent-browser.js, not the repo root (10 Sep 2026: MODULE_NOT_FOUND on 2055)
    r = subprocess.run(["node", lane, "read", "--url", EPISODES, "--profile", PROFILE, "--wait", "9000"],
                       capture_output=True, text=True, timeout=180)
    out = r.stdout
    try: text = json.loads(out[out.index("{"):]).get("text") or ""
    except Exception: return "missing", "unreadable episodes page"
    return list_status(text, title)


def list_status(text, title):
    key = title[:60]; best = "missing"; snippet = "title not in the first page of episodes"
    for i in [m.start() for m in re.finditer(re.escape(key), text)]:
        after = " ".join(text[i + len(key):i + 200].split())
        status = after.split()[0] if after.split() else ""
        if status == "Published": return "published", " ".join(text[i:i + 160].split())
        if status == "Draft": best, snippet = "processing", " ".join(text[i:i + 160].split())
    return best, snippet


def public_link(title):
    """The open.spotify.com link once the episode is out: read from the show's public embed page (no login)."""
    import urllib.request
    try:
        req = urllib.request.Request("https://open.spotify.com/embed/show/%s" % SHOW_ID, headers={"User-Agent": "Mozilla/5.0"})
        html = urllib.request.urlopen(req, timeout=30).read().decode("utf8", "ignore")
    except Exception: return ""
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m: return ""
    data = json.loads(m.group(1)); key = title[:50]
    def walk(o):
        if isinstance(o, dict):
            if str(o.get("uri", "")).startswith("spotify:episode:") and key in str(o.get("name", "")): yield o["uri"]
            for v in o.values(): yield from walk(v)
        elif isinstance(o, list):
            for v in o: yield from walk(v)
    for uri in walk(data): return "https://open.spotify.com/episode/" + uri.split(":")[-1]
    return ""


def selftest():
    t, d = podcast_parts("Title: Day 2195 running off-road\nDescription: Six years in.\n\nMore.\nHashtags: #a #b", 2195)
    assert t == "Day 2195 running off-road" and d.startswith("Six years in.") and "#a #b" in d and "Title:" not in d, (t, d)
    assert podcast_parts("", 7)[0] == "Diary of a Runpreneur, Day 7"
    assert with_day("Coping With Stress", 2054) == "Episode 2054 - Coping With Stress" and with_day(t, 2195) == t
    p = build_plan("/x/Episode_2195_Full_Episode.mp4", "T", "D", "https://youtu.be/x", True)
    assert p["steps"][2] == {"do": "upload", "selector": "#uploadAreaInput", "file": "/x/Episode_2195_Full_Episode.mp4"}
    assert p["mode"] == "test" and "youtu.be/x" in p["steps"][5]["value"] and not any(s["do"] == "submit" for s in p["steps"])
    assert not any(s.get("selector") == THUMB_INPUT for s in p["steps"]), "no thumbnail step without a thumbnail"
    pt = build_plan("/x/v.mp4", "T", "D", "", True, thumb="/x/Episode_1_Thumbnail.png")
    ups = [s for s in pt["steps"] if s["do"] == "upload"]
    assert ups[0]["selector"] == "#uploadAreaInput" and ups[1] == {"do": "upload", "selector": THUMB_INPUT, "file": "/x/Episode_1_Thumbnail.png"}
    assert pt["steps"].index(ups[1]) > pt["steps"].index([s for s in pt["steps"] if s["do"] == "fill"][1]), "thumbnail after the copy, before the upload wait"
    waits = [s for s in p["steps"] if s["do"] == "wait" and (s.get("gone") or s.get("for"))]
    assert all(s["ms"] <= 600000 for s in waits) and any(s.get("gone") == "text=Uploading" for s in waits)
    live = build_plan("/x", "T", "D", "", False)
    assert live["steps"][-1]["do"] == "submit" and live["confirm"]["selector"] and live["mode"] == "live"
    assert live["steps"][-2] == {"do": "wait", "for": PUBLISH_ENABLED, "ms": UPLOAD_WAIT_MS}
    assert any(s.get("selector") == "label[for='publish-date-now']" for s in live["steps"])
    lst = "Title\n\nEpisode 9 - A\n\t\nDraft\n\t\n9/9/26\n\tVideo\t09:41\n\nEpisode 9 - A\n\t\nPublished\n\t\n9/9/26\n"
    assert list_status(lst, "Episode 9 - A")[0] == "published" and list_status(lst.split("Published")[0], "Episode 9 - A")[0] == "processing"
    assert list_status(lst, "Episode 8 - B")[0] == "missing"
    assert os.path.exists(os.path.join(os.path.dirname(HERE), "agent-browser.js")), "the browser lane path must resolve (2055 failed with MODULE_NOT_FOUND)"
    assert WIZARD.endswith("/episode/wizard") and SHOW_ID in WIZARD and PODCAST_FORMAT in ("audio", "video")
    print(json.dumps({"checks": 16, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--day", type=int, default=0)
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    else: raise SystemExit("usage: spotify.py selftest (plans are written by publish.py stage 2)")
