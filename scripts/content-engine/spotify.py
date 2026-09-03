#!/usr/bin/env python3
"""spotify.py — the podcast episode on Spotify for Creators, through the agent browser lane.

Spotify for Creators has no upload API, and Ericamae uploaded by hand (SOP: podcast). Her
episodes are VIDEO episodes of the full vlog (the episodes list shows Format: Video, 7-9 min),
so the upload is the finished full episode MP4, not a separate audio file. Kevin logged the
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


def build_plan(video_path, title, description, youtube_link, test):
    desc = description + ("\n\nWatch the full episode: " + youtube_link if youtube_link else "")
    steps = [
        {"do": "goto", "url": WIZARD},
        {"do": "wait", "ms": 8000},
        {"do": "upload", "selector": "#uploadAreaInput", "path": video_path},
        {"do": "wait", "ms": 20000},
        {"do": "fill", "selector": "input[name='title'], input[aria-label*='Title'], input[placeholder*='title' i]", "value": title},
        {"do": "fill", "selector": "textarea[name='description'], [contenteditable='true'], textarea", "value": desc},
        {"do": "click", "text": "Next"},
        {"do": "wait", "ms": 4000},
    ]
    plan = {"profile": PROFILE, "label": "Spotify for Creators: %s" % title[:60], "steps": steps,
            "submit": {"do": "click", "text": "Publish now" if not test else "Save as draft"},
            "confirm": {"selector": "text=Episode published" if not test else "text=Draft", "proof": "the episode appears in the Episodes list"},
            "mode": "test" if test else "live"}
    return plan


def write_plan(day, video_path, podcast_copy, youtube_link, test, out_dir):
    title, desc = podcast_parts(podcast_copy, day)
    plan = build_plan(video_path, title, desc, youtube_link, test)
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "spotify_plan_%d.json" % day)
    with open(path, "w") as fh: json.dump(plan, fh, indent=1)
    return path, title


def selftest():
    t, d = podcast_parts("Title: Day 2195 running off-road\nDescription: Six years in.\n\nMore.\nHashtags: #a #b", 2195)
    assert t == "Day 2195 running off-road" and d.startswith("Six years in.") and "#a #b" in d and "Title:" not in d, (t, d)
    assert podcast_parts("", 7)[0] == "Diary of a Runpreneur, Day 7"
    p = build_plan("/x/Episode_2195_Full_Episode.mp4", "T", "D", "https://youtu.be/x", True)
    assert p["steps"][2] == {"do": "upload", "selector": "#uploadAreaInput", "path": "/x/Episode_2195_Full_Episode.mp4"}
    assert p["submit"]["text"] == "Save as draft" and p["mode"] == "test" and "youtu.be/x" in p["steps"][5]["value"]
    assert build_plan("/x", "T", "D", "", False)["submit"]["text"] == "Publish now"
    assert WIZARD.endswith("/episode/wizard") and SHOW_ID in WIZARD
    print(json.dumps({"checks": 7, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--day", type=int, default=0)
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    else: raise SystemExit("usage: spotify.py selftest (plans are written by publish.py stage 2)")
