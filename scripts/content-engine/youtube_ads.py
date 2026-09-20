#!/usr/bin/env python3
"""youtube_ads.py — the ad BREAKS on a YouTube video, on top of the master switch in youtube_studio.py.

Kevin, 20 Sep 2026: "every single video has the ads switched on so that they can generate money ... that
money goes into Runpreneur's fundraising figure". Audited that day: every public video's master switch was
already On, and 817 of the 888 videos over 8 minutes had MID-ROLL ads off, so the ad in the middle of the
episode never ran. YouTube had already computed the break point on 695 of them.

Mid-roll is the biggest share of long-form ad revenue, and the YouTube Data API cannot set it, so the work
happens in Studio through the robot browser. youtube_ads.js holds the browser half and the read-back.

  youtube_ads.py midroll --video ID     # switch mid-roll (and pre/post-roll) On, then read it back
  youtube_ads.py audit --out FILE       # every video's ad breaks and ad formats
  youtube_ads.py selftest
"""
import argparse, json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
JS = os.path.join(HERE, "youtube_ads.js")
MIDROLL_MIN_SECONDS = 480          # YouTube shows no mid-roll checkbox below 8 minutes
# What a run can say about one video. "not-eligible" is a settled answer, not a failure: a 6-minute
# episode can never carry a mid-roll, and must never sit in the backlog waiting for one.
ON, NOT_ELIGIBLE, FAILED = "on", "not-eligible", "failed"


def video_id(entry, post):
    """The 11-character YouTube id for a published post.

    The direct-upload route puts it straight on the post. The GoHighLevel route puts ITS OWN post id there
    (`6aa1688ddff4e2c4711c8b0b` on episode 2054), which is not a YouTube id and cannot be opened in Studio.
    Before 20 Sep 2026 the monetisation loop filtered on `route == "api"` and so stepped straight over every
    GHL upload without a word: 2054's episode and Short and 2195's episode were never once checked.
    The episode's own `youtube_link` carries the real id for the long video, so use it."""
    # An id written on the post by hand, for the one case nothing can derive: a Short uploaded through
    # GoHighLevel, whose only record of the YouTube video is GHL's own post id (episode 2054, 20 Sep 2026,
    # matched on the channel as WUTZvEoLDbQ). `id` is left alone because the GHL status sync matches on it.
    fixed = (post or {}).get("youtube_video_id") or ""
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", fixed):
        return fixed
    vid = (post or {}).get("id") or ""
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", vid):
        return vid
    if (post or {}).get("clip") == "full":
        m = re.search(r"(?:youtu\.be/|v=)([A-Za-z0-9_-]{11})", (entry or {}).get("youtube_link") or "")
        if m: return m.group(1)
    return None


def _node():
    for c in (os.environ.get("NODE"), subprocess.run(["bash", "-lc", "command -v node"], capture_output=True, text=True).stdout.strip()):
        if c and os.path.exists(c): return c
    home = os.path.expanduser("~/.nvm/versions/node")
    vers = sorted([d for d in os.listdir(home) if d.startswith("v")], key=lambda v: [int(x) for x in re.findall(r"\d+", v)]) if os.path.isdir(home) else []
    if vers: return os.path.join(home, vers[-1], "bin", "node")
    return "node"


def _run(argv, timeout=7500):      # longer than youtube_ads.js's own two-hour watchdog, so the JS reports first
    r = subprocess.run([_node(), JS] + argv, capture_output=True, text=True, timeout=timeout)
    out = (r.stdout or "").strip()
    if "{" not in out: raise SystemExit("youtube_ads.js gave nothing back: %s" % ((r.stderr or out)[-240:]))
    return json.loads(out[out.index("{"):])


def midroll(ids):
    """Switch mid-roll On for these video ids. Returns {id: "on"|"not-eligible"|"failed"}.

    A 200 from Studio's write is NOT proof — without the page's BotGuard attestation the endpoint accepts
    the call and changes nothing (proved on Rs8xHbD5miQ, 20 Sep 2026). youtube_ads.js reads every id back
    off Studio's own list before it reports, so anything not proved On comes back as failed."""
    ids = [i for i in ids if re.fullmatch(r"[A-Za-z0-9_-]{11}", i or "")]
    if not ids: return {}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(ids, fh); path = fh.name
    try:
        res = _run(["fix", "--ids", path])
    finally:
        os.remove(path)
    if res.get("error"): raise SystemExit("mid-roll run failed: %s" % res["error"])
    out = {}
    for i in ids:
        if i in (res.get("notEligible") or []): out[i] = NOT_ELIGIBLE
        elif i in (res.get("stillOff") or []) or i in (res.get("errors") or {}): out[i] = FAILED
        else: out[i] = ON
    return out


def audit(out_file=None):
    return _run(["audit"] + (["--out", out_file] if out_file else []))


def selftest():
    api = {"id": "yGOws0WofyU", "clip": "full", "route": "api"}
    ghl_full = {"id": "6aa1688ddff4e2c4711c8b0b", "clip": "full", "route": None}
    ghl_short = {"id": "6aa181234bdc74b45aeab6d5", "clip": "lfmd", "route": None}
    ent = {"youtube_link": "https://youtu.be/AT0l-Ri5ZJ0"}
    assert video_id(ent, api) == "yGOws0WofyU", "a direct upload carries its own id"
    # the real episode 2054, which the old route == "api" filter skipped in silence
    assert video_id(ent, ghl_full) == "AT0l-Ri5ZJ0", "a GoHighLevel upload is resolved through the episode link"
    assert video_id(ent, ghl_short) is None, "a GHL Short has no link to resolve, so it is reported, never assumed"
    assert video_id(ent, dict(ghl_short, youtube_video_id="WUTZvEoLDbQ")) == "WUTZvEoLDbQ", "an id written on the post by hand wins"
    assert video_id(ent, dict(api, youtube_video_id="nonsense")) == "yGOws0WofyU", "a bad hand-written id is ignored, not trusted"
    assert video_id({}, ghl_full) is None and video_id({"youtube_link": "not a link"}, ghl_full) is None
    assert video_id(ent, {"id": "", "clip": "full"}) == "AT0l-Ri5ZJ0"
    assert video_id({"youtube_link": "https://www.youtube.com/watch?v=bSzyDyON4uc"}, ghl_full) == "bSzyDyON4uc"
    assert midroll([]) == {} and midroll(["not-an-id"]) == {}, "only an 11-character id ever reaches the browser"
    src = open(JS).read()
    assert "readBack" in src and "the only proof that counts" in src, "every write is read back off Studio"
    assert "attestationResponseData" in src or "attestation" in src, "the write reuses the page's minted attestation"
    assert "MIDROLL_MIN_SECONDS = 480" in src and MIDROLL_MIN_SECONDS == 480, "mid-roll needs 8 minutes"
    assert os.path.basename(_node()) == "node", "a node binary is found even under launchd's bare PATH"
    print(json.dumps({"checks": 13, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--video", default=""); ap.add_argument("--out", default="")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "midroll": print(json.dumps(midroll([a.video])))
    elif a.mode == "audit": print(json.dumps(audit(a.out or None)))
    else: raise SystemExit("usage: youtube_ads.py midroll --video ID | audit [--out FILE] | selftest")
