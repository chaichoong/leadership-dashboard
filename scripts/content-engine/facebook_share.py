#!/usr/bin/env python3
"""facebook_share.py — the episode's YouTube link on Kevin's PERSONAL Facebook profile, through the browser lane.

Kevin (9 Sep 2026, reviewing episode 2054): "Personal Facebook share missing, needs to be part of the process."
Ericamae shared every full episode from Kevin's own profile; GoHighLevel only reaches Pages, so this step
goes through the agent browser lane like Spotify. Kevin signs the lane's default profile into
www.facebook.com once via the Robot sign-in app (sites.json holds the loginUrl); `session --site
www.facebook.com` is the check, and this module hands back SIGN-IN NEEDED rather than guessing.

The plan: open facebook.com, click the "What's on your mind" composer, type the text (the YouTube copy's
first paragraph plus the link), wait for Facebook to attach the link preview, press Post. `prepare` stops
before Post with a screenshot; `commit` presses it only when the episode's approval reads Approved (the
lane's own gate) and demands proof of landing. Selectors are pinned from Facebook's current composer
(aria labels, 9 Sep 2026) and get confirmed on the first live share.
"""
import argparse, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

PROFILE = "default"                       # the profile the Robot sign-in app signs into
HOME = "https://www.facebook.com/"
COMPOSER = "[role='button']:has-text(\"What's on your mind\"), [aria-label*=\"What's on your mind\"]"
EDITOR = "[role='dialog'] [contenteditable='true'][role='textbox'], [role='dialog'] [contenteditable='true']"
POST_BUTTON = "[role='dialog'] [aria-label='Post']:not([aria-disabled='true']), [role='dialog'] div[aria-label='Post'][role='button']"
SHARE_MAX = 600


def share_text(youtube_copy, day, youtube_link):
    """First paragraph of the YouTube description (after the 'Title:' line) plus the link; never the hashtags."""
    text = (youtube_copy or "").strip()
    body = re.sub(r"^Title:.*\n?", "", text, flags=re.M)
    body = re.sub(r"^Description:\s*", "", body.strip(), flags=re.M)
    paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip() and not p.strip().startswith("#") and not p.lower().startswith("hashtags:")]
    first = paras[0] if paras else "Day %d of Diary of a Runpreneur." % day
    first = re.sub(r"\s*#\w+", "", first).strip()[:SHARE_MAX]
    return "%s\n\nFull episode: %s" % (first, youtube_link) if youtube_link else first


def build_plan(text, test):
    steps = [
        {"do": "goto", "url": HOME},
        {"do": "wait", "for": COMPOSER, "ms": 60000},
        {"do": "click", "selector": COMPOSER},
        {"do": "wait", "for": EDITOR, "ms": 30000},
        {"do": "fill", "selector": EDITOR, "value": text},
        {"do": "wait", "ms": 6000},                       # the link preview card attaches itself
    ]
    if not test: steps.append({"do": "submit", "selector": POST_BUTTON})
    return {"profile": PROFILE, "site": "www.facebook.com", "label": "Facebook profile share: %s" % text[:50], "steps": steps,
            "confirm": {"selector": "text=%s" % json.dumps(text.split("\n")[0][:60]), "timeoutMs": 60000,
                        "proof": "the new post's first line appears in the feed after the composer closes"},
            "mode": "test" if test else "live"}


def signed_in():
    """The lane's own session walk (code, never a judgement of a screenshot)."""
    import subprocess
    lane = os.path.join(os.path.dirname(HERE), "agent-browser.js")
    r = subprocess.run(["node", lane, "session", "--site", "www.facebook.com"], capture_output=True, text=True, timeout=240)
    out = r.stdout
    try: return bool(json.loads(out[out.index("{"):]).get("signedIn"))
    except Exception: return False


def write_plan(day, youtube_copy, youtube_link, test, out_dir):
    text = share_text(youtube_copy, day, youtube_link)
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "facebook_share_%d.json" % day)
    with open(path, "w") as fh: json.dump(build_plan(text, test), fh, indent=1)
    return path, text


def run_plan(plan_path, task_id, test, shot):
    import subprocess
    lane = os.path.join(os.path.dirname(HERE), "agent-browser.js")
    cmd = ["node", lane, "prepare" if test else "commit", "--plan", plan_path, "--profile", PROFILE, "--shot", shot]
    if not test: cmd += ["--task", task_id]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    out = r.stdout.strip()
    if r.returncode != 0: raise SystemExit((r.stderr.strip() or out)[-600:])
    try: return json.loads(out[out.index("{"):])
    except Exception: raise SystemExit("unreadable lane output: " + out[-300:])


def selftest():
    copy = "Title: Day 2054 Coping\nDescription: Today was one of those days.\nSecond line of the first paragraph.\n\nMore detail.\n\n#a #b\nHashtags: #c"
    t = share_text(copy, 2054, "https://youtu.be/x")
    assert t.startswith("Today was one of those days.\nSecond line") and t.endswith("Full episode: https://youtu.be/x") and "#" not in t and "Title:" not in t, t
    assert share_text("", 7, "") == "Day 7 of Diary of a Runpreneur."
    assert len(share_text("Description: " + "x" * 900, 1, "")) <= SHARE_MAX
    p = build_plan(t, True)
    assert p["profile"] == "default" and p["steps"][0]["url"] == HOME and not any(s["do"] == "submit" for s in p["steps"])
    assert p["steps"][4] == {"do": "fill", "selector": EDITOR, "value": t}
    live = build_plan(t, False)
    assert live["steps"][-1] == {"do": "submit", "selector": POST_BUTTON} and live["confirm"]["selector"].startswith("text=\"Today was")
    assert all(s.get("ms", 0) <= 600000 for s in live["steps"] if s["do"] == "wait")
    print(json.dumps({"checks": 8, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "session": print(json.dumps({"signedIn": signed_in()}))
    else: raise SystemExit("usage: facebook_share.py selftest | session (plans are written by publish.py stage 2)")
