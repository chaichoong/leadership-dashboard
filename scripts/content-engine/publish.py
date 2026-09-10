#!/usr/bin/env python3
"""publish.py — R10 of the Content Engine's Runpreneur 360 lane: scheduling through GoHighLevel.

Only episodes Kevin APPROVED on the card (approvals.json verdict "approved", record at
"Approved for Publishing" or later) ever reach this script. Everything goes through the
GHL Social Planner on the Runpreneur sub-account, the channels the team used by hand:

  Stage 1, the night after approval: the FULL episode to YouTube (GHL youtube account,
           type video, public), scheduled for 06:00 London that morning, with the thumbnail.
  Stage 2, the night after YouTube publishes: GHL reports the video link; it goes onto the
           record and into the copy (the "[ADD YOUTUBE LINK]" line), then the SUMMARY clip
           (09:00) and the LEARNINGS clip (17:00) are scheduled to every connected social
           channel with that record's copy for the platform.
  sync:    every night, GHL post statuses -> published links onto the record's link fields;
           when every post is out the record reads "Published".

Kevin's publishing map (3 Sep 2026): the teaser and the Learnings clip go to the socials
and drive people to the full episode on YouTube. So the socials wait for the YouTube link;
without a YouTube account connected in GHL (Kevin's one click, the OAuth start URL is
printed by `youtube-link`) the approved episode holds and the digest line says so.

Media is uploaded once per file into the GHL media library (curl, key via a config file
so it never sits in the process table) and the CDN URL is cached in publishing.json.
X is not scheduled: GHL dropped it in Dec 2024. Nothing here creates a post unless the
episode is approved; `plan` prints what a run would do and creates nothing.

State: ~/knowledge-os/logs/content-engine/publishing.json (episode -> media urls, posts,
youtube link). The repo is public; keys live in ~/.config/od/.
"""
import argparse, datetime as dt, json, os, re, subprocess, sys, tempfile, urllib.error, urllib.request
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import watch  # noqa: E402
import platform_copy as pc  # noqa: E402
import approval  # noqa: E402

LONDON = ZoneInfo("Europe/London")
GHL = "https://services.leadconnectorhq.com"
FFMPEG = os.path.expanduser("~/tools/bin/ffmpeg"); FFPROBE = os.path.expanduser("~/tools/bin/ffprobe")
KEY_FILE = os.path.expanduser("~/.config/od/ghl_social_key_runpreneur")
LOC_FILE = os.path.expanduser("~/.config/od/ghl_location_id_runpreneur")
USER_FILE = os.path.expanduser("~/.config/od/ghl_user_id_kevin")
STATE = os.path.join(os.path.dirname(watch.LEDGER), "publishing.json")
EDITED_ROOT = os.path.expanduser("~/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/Shared drives/Marketing/Runpreneur/Runpreneur Edited Video")
UA = "Mozilla/5.0 od-content-engine"   # Cloudflare in front of GHL bans the default Python user agent

STATUS_APPROVED = approval.STATUS_APPROVED
STATUS_YT = "YT Publishing & SEO in Progress"
STATUS_SOCIALS = "Publishing In Progress"
STATUS_PUBLISHED = "Published"
PUBLISHABLE = (STATUS_APPROVED, STATUS_YT, STATUS_SOCIALS)
YT_SLOT, SUMMARY_SLOT, LFMD_SLOT = (6, 0), (9, 0), (17, 0)     # kept for the specs; the real times come from PLATFORM_SLOTS
STAGGER_HOURS = 6     # YouTube: a second episode the same day goes six hours later, a third twelve (catch-up, 8 Sep 2026)
STAGGER_SOCIAL_HOURS = 2
# Same-day publishing (Kevin, 8 Sep 2026): YouTube first thing, the clips later the same day when each
# platform is busiest in the UK. LinkedIn is a lunchtime and end-of-day read; Facebook and Instagram
# lunchtime and early evening; TikTok evening; Threads with Instagram.
PLATFORM_SLOTS = {"youtube": {"full": (6, 0)},
                  "linkedin": {"summary": (12, 0), "lfmd": (17, 30)}, "facebook": {"summary": (12, 30), "lfmd": (18, 0)},
                  "instagram": {"summary": (12, 30), "lfmd": (18, 0)}, "threads": {"summary": (12, 0), "lfmd": (18, 0)},
                  "tiktok": {"summary": (13, 0), "lfmd": (19, 30)}}
SOON_MINUTES = 15   # GoHighLevel refused a post 5 minutes out with "Schedule Date must be after current date" (9 Sep 2026); 15 clears its own minimum
SOCIAL_LEAD_MINUTES = 30   # a social post carries the YouTube link, so it never goes out before the video is public + this


def staggered(slot, index, hours=STAGGER_HOURS):
    """(hour, minute) for the index-th episode published the same day: 06:00, 12:00, 18:00 for YouTube."""
    return ((slot[0] + hours * index) % 24, slot[1])


def when_for(platform, clip, index, now=None, youtube_at=None):
    """The UTC ISO time a post goes out: today's slot for that platform and clip, moved along for the
    index-th episode of the day; if the slot has already passed, a few minutes from now. Same day, never
    tomorrow (Kevin, 10 Sep 2026: "YouTube in the morning and then the social media and everything else in
    the afternoon... we weren't going to do day one and day two"). A social post carries the YouTube link, so
    it is never earlier than the video going public plus SOCIAL_LEAD_MINUTES either."""
    now = now or dt.datetime.now(LONDON)
    base = PLATFORM_SLOTS.get(platform, {}).get(clip) or (SUMMARY_SLOT if clip == "summary" else LFMD_SLOT if clip == "lfmd" else YT_SLOT)
    h, m = staggered(base, index, STAGGER_HOURS if platform == "youtube" else STAGGER_SOCIAL_HOURS)
    slot = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if slot < now + dt.timedelta(minutes=SOON_MINUTES): slot = now + dt.timedelta(minutes=SOON_MINUTES)
    if platform != "youtube" and youtube_at:
        try: yt = dt.datetime.strptime(youtube_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc).astimezone(LONDON)
        except (TypeError, ValueError): yt = None
        if yt and slot < yt + dt.timedelta(minutes=SOCIAL_LEAD_MINUTES): slot = yt + dt.timedelta(minutes=SOCIAL_LEAD_MINUTES)
    return slot.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def youtube_at(entry):
    """When this episode's YouTube video goes public, from the post the engine already made."""
    for k, p in (entry.get("posts") or {}).items():
        if k.startswith("youtube|") and p.get("clip") == "full":
            return p.get("scheduled") or p.get("published_at")
    return None
PLACEHOLDER = "[ADD YOUTUBE LINK]"
MODE_FILE = os.path.expanduser("~/.config/od/content_engine_mode")   # "test" (default) or "live"; Kevin flips it


def mode():
    """TEST until Kevin says live. Test mode runs the whole chain but keeps it off the public feeds:
    YouTube goes up UNLISTED (so the link exists and the copy fills), the socials are created as
    DRAFTS in the planner for him to open and check. Live mode: public video, scheduled posts."""
    try: m = open(MODE_FILE).read().strip().lower()
    except OSError: return "test"
    return "live" if m == "live" else "test"

# Which clip and which copy field each channel gets. "clip" is the file kind on the edited
# folder; "record" is which of the episode's three records carries the copy. Keys are
# GHL platform names (accounts list); "types" narrows by account type.
CHANNELS = {
    "youtube":   {"types": ("profile", "business", "page"), "stage": 1, "posts": [{"clip": "full", "record": "Long Form Video", "field": "YouTube Copy", "slot": YT_SLOT, "ptype": "post"}]},
    # the Learnings clip is also a YouTube Short, published with the socials the day after the full episode (Kevin, 4 Sep 2026)
    "youtube-short": {"platform": "youtube", "types": ("profile", "business", "page"), "stage": 2, "posts": [
        {"clip": "lfmd", "record": "Learnings From My Diary", "field": "YouTube Reels Copy", "slot": LFMD_SLOT, "ptype": "post", "yt_type": "short"}]},
    "tiktok":    {"types": ("profile", "business"), "stage": 2, "posts": [
        {"clip": "summary", "record": "Short Form Video", "field": "TikTok Copy", "slot": SUMMARY_SLOT, "ptype": "post"},
        {"clip": "lfmd", "record": "Learnings From My Diary", "field": "TikTok Copy", "slot": LFMD_SLOT, "ptype": "post"}]},
    "facebook":  {"types": ("page",), "stage": 2, "posts": [
        {"clip": "summary", "record": "Short Form Video", "field": "Facebook Reels Copy", "slot": SUMMARY_SLOT, "ptype": "reel"},
        {"clip": "lfmd", "record": "Learnings From My Diary", "field": "Facebook Post Copy", "slot": LFMD_SLOT, "ptype": "post"}]},
    "instagram": {"types": ("profile", "business", "page"), "stage": 2, "posts": [
        {"clip": "summary", "record": "Short Form Video", "field": "Instagram Reels Copy", "slot": SUMMARY_SLOT, "ptype": "reel"},
        {"clip": "lfmd", "record": "Learnings From My Diary", "field": "Instagram Post Copy", "slot": LFMD_SLOT, "ptype": "reel"}]},
    "linkedin":  {"types": ("page", "profile"), "stage": 2, "posts": [
        {"clip": "summary", "record": "Short Form Video", "field": "LinkedIn Copy", "slot": SUMMARY_SLOT, "ptype": "post"},
        {"clip": "lfmd", "record": "Learnings From My Diary", "field": "LinkedIn Copy", "slot": LFMD_SLOT, "ptype": "post"}]},
    "threads":   {"types": ("profile", "business", "page"), "stage": 2, "posts": [
        {"clip": "summary", "record": "Short Form Video", "field": "Threads Copy", "slot": SUMMARY_SLOT, "ptype": "post"},
        {"clip": "lfmd", "record": "Learnings From My Diary", "field": "Threads Copy", "slot": LFMD_SLOT, "ptype": "post"}]},
}
# Where each channel's published link lands on the episode record (the team's QC page reads these).
# Both sets: the "Link of ..." fields and the fields Ericamae filled by hand, which the team's QC and
# Ready pages read (YouTube Link, TikTok Link, Facebook Post Link, Instagram Post Link, LinkedIn Link,
# Threads Link). Written on the Full record AND on the clip's own record (Short / Learnings), as she did.
LINK_FIELDS = {("youtube", "full"): ("YouTube Full Link", "Link of Youtube Video", "YouTube Link"), ("youtube", "lfmd"): ("Link of Youtube Shorts",),
               ("tiktok", "summary"): ("Link of Tiktok Video", "TikTok Link"), ("tiktok", "lfmd"): ("TikTok Link",),
               ("facebook", "summary"): ("Link of Facebook Reels", "Facebook Post Link"), ("facebook", "lfmd"): ("Link of Facebook Page Post", "Facebook Post Link"),
               ("instagram", "summary"): ("Link of Instagram Reels", "Instagram Post Link"), ("instagram", "lfmd"): ("Link of Instagram Post", "Instagram Post Link"),
               ("linkedin", "summary"): ("Link of Linkedin Post", "LinkedIn Link"), ("linkedin", "lfmd"): ("LinkedIn Link",),
               ("threads", "summary"): ("Link of Threads Post", "Threads Link"), ("threads", "lfmd"): ("Threads Link",)}
CLIP_RECORD = {"summary": "Short Form Video", "lfmd": "Learnings From My Diary", "full": "Long Form Video"}
CLIP_FILES = {"full": "Episode_%d_Full_Episode.mp4", "lfmd": "Ep%d_LFMD.mp4", "summary": "Ep%d_Summary.mp4", "thumb": "Episode_%d_Thumbnail.png",
              "podcast": "Ep%d_Podcast.mp3",
              # clean YouTube pair (no burnt-in captions) with caption files, for the direct upload route (9 Sep 2026)
              "full_yt": "Episode_%d_Full_Episode_YT.mp4", "full_srt": "Episode_%d_Full_Episode_YT.srt", "lfmd_yt": "Ep%d_LFMD_YT.mp4", "lfmd_srt": "Ep%d_LFMD_YT.srt"}
TIKTOK = {"privacyLevel": "PUBLIC_TO_EVERYONE", "promoteOtherBrand": False, "enableComment": True, "enableDuet": True, "enableStitch": True,
          "videoDisclosure": False, "promoteYourBrand": False}


# ---------- pure (selftested) ----------

def slot_iso(day_london, hm):
    """A London wall-clock slot as the UTC ISO string GHL wants."""
    local = dt.datetime(day_london.year, day_london.month, day_london.day, hm[0], hm[1], tzinfo=LONDON)
    return local.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def youtube_parts(youtube_copy, day):
    """The YouTube copy is 'SEO Title: ...', 'Description: ...', 'Hashtags: ...'. Title max 100."""
    text = (youtube_copy or "").strip()
    m = re.search(r"SEO Title:\s*(.+)", text)
    title = (m.group(1).strip() if m else "Diary of a Runpreneur, Day %d" % day)[:100]
    body = re.sub(r"^SEO Title:.*\n?", "", text).strip()
    body = re.sub(r"^Description:\s*", "", body).replace("\nHashtags:", "\n")
    return title, body.strip()


PLACEHOLDER_RE = re.compile(r"\[[A-Z][A-Z /_-]{2,}\]")   # [ADD YOUTUBE LINK], [LINK], [INSERT ...]


def placeholder_left(text):
    """Any bracketed ALL-CAPS token still in the text. Kevin, 8 Sep 2026: copy with an unfilled placeholder
    must never reach a platform, so this is checked on every post and every article before it is created."""
    m = PLACEHOLDER_RE.search(text or "")
    return m.group(0) if m else None


def with_youtube_link(copy, link):
    """Fill the placeholder line, or add the link if the copy never had one. Never leaves the placeholder in a post."""
    text = (copy or "").strip()
    if PLACEHOLDER in text: return text.replace(PLACEHOLDER, link)
    if link and link not in text: return text + "\n\nWatch the full episode: " + link
    return text


def account_map(accounts):
    """Active GHL accounts per channel, X excluded (GHL dropped it Dec 2024). Returns {platform: [account]}."""
    out = {}
    wanted = {cfg.get("platform", k): cfg["types"] for k, cfg in CHANNELS.items()}
    for a in accounts:
        p = a.get("platform")
        if p not in wanted or not a.get("active") or a.get("type") not in wanted[p]: continue
        out.setdefault(p, []).append(a)
    return out


def build_post(platform, account, spec, copy, media_url, thumb_url, schedule_iso, user_id, day, title=None, status="scheduled", privacy="public"):
    """One GHL post body: one account, that platform's copy, the clip, the slot."""
    media = {"url": media_url, "type": "video/mp4"}
    if thumb_url and spec["clip"] == "full": media["thumbnail"] = thumb_url
    body = {"accountIds": [account["id"]], "summary": copy, "media": [media], "type": spec["ptype"], "status": status,
            "userId": user_id, "createdBy": user_id, "tags": []}
    if status == "scheduled": body["scheduleDate"] = schedule_iso
    if platform == "tiktok": body["tiktokPostDetails"] = dict(TIKTOK)
    if platform == "youtube": body["youtubePostDetails"] = {"title": title or ("Diary of a Runpreneur, Day %d" % day), "privacyLevel": privacy, "type": spec.get("yt_type", "video")}
    if platform == "facebook": body["facebookPostDetails"] = {"type": spec["ptype"]}
    if platform == "instagram": body["instagramPostDetails"] = {"type": spec["ptype"], "showOnFeed": True}
    return body


def build_text_post(account, text, schedule_iso, user_id, image_url=None, status="scheduled"):
    """A text post, optionally with one image, for LinkedIn or a Facebook page. No clip, no video."""
    body = {"accountIds": [account["id"]], "summary": text, "type": "post", "status": status, "userId": user_id, "createdBy": user_id, "tags": []}
    if image_url: body["media"] = [{"url": image_url, "type": "image/png"}]
    if status == "scheduled": body["scheduleDate"] = schedule_iso
    if account.get("platform") == "facebook": body["facebookPostDetails"] = {"type": "post"}
    return body


def post_key(platform, account_id, clip):
    return "%s|%s|%s" % (platform, clip, account_id)


def stage_for(entry, youtube_connected):
    """What this episode needs next: 'youtube', 'wait-youtube-account', 'wait-youtube-link', 'socials' or 'done'."""
    posts = entry.get("posts", {})
    yt = [p for k, p in posts.items() if k.startswith("youtube|")]
    if not yt:
        return "youtube" if youtube_connected else "wait-youtube-account"
    if not entry.get("youtube_link"):
        return "wait-youtube-link"
    socials = [k for k in posts if not k.startswith("youtube|")]
    return "done" if socials else "socials"


# ---------- state + GHL ----------

def load_state():
    if os.path.exists(STATE):
        with open(STATE) as fh: return json.load(fh)
    return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as fh: json.dump(state, fh, indent=1, sort_keys=True)
    os.replace(tmp, STATE)


# ---------- brands: one publisher, two brand profiles (Kevin's ruling, 2 Sep 2026) ----------
# Brand = the record's Category. Each brand has its own GHL sub-account key and an ALLOWLIST of the
# accounts it may post to; anything not listed is refused by name. Operations Director may reach
# exactly the Operations Director LinkedIn page and the Operations Director Facebook page (once Kevin
# connects it in GHL), never Kevin's profile, never a Runpreneur page, never TikTok. "bridge" is the
# Runpreneur-framed post on Kevin's own profile (Kevin, 3 Sep 2026): Runpreneur brand, profile only.
BRANDS = {
    "Runpreneur": {"key": KEY_FILE, "loc": LOC_FILE, "category": "Runpreneur",
                   "allow": {"episode": None,                                     # None = every active account CHANNELS knows
                             "bridge": [("linkedin", "profile")]}},
    "Operations Director": {"key": os.path.expanduser("~/.config/od/ghl_social_key_od"), "loc": os.path.expanduser("~/.config/od/ghl_location_id_od"),
                            "category": "Operations Director",
                            "allow": {"post": [("linkedin", "page", "Operations Director"), ("facebook", "page", "Operations Director")]}},
}


def brand_of(record_fields):
    """The brand a record belongs to, from its Category. Anything else is refused: a record with no
    brand must never reach a publisher."""
    cat = (record_fields or {}).get("Category")
    for b, cfg in BRANDS.items():
        if cfg["category"] == cat: return b
    raise SystemExit("brand guard: record Category %r is not a brand this publisher knows" % (cat,))


def allowed_accounts(brand, lane, accounts):
    """The active GHL accounts this brand may use for this lane, or a refusal. A (platform, type[, name])
    rule matches an account; an account matching no rule is never returned. Names are compared exactly:
    the OD sub-account also carries the Runpreneur page and Kevin's profile, which OD must never use."""
    rules = BRANDS[brand]["allow"].get(lane)
    if rules is None and lane in BRANDS[brand]["allow"]: return [a for a in accounts if a.get("active")]
    if rules is None: raise SystemExit("brand guard: %s has no lane %r" % (brand, lane))
    out = []
    for a in accounts:
        if not a.get("active"): continue
        for r in rules:
            if a.get("platform") == r[0] and a.get("type") == r[1] and (len(r) < 3 or a.get("name") == r[2]):
                out.append(a); break
    return out


def assert_brand(record_fields, brand):
    """Refuse a cross-brand publish with a named reason (Kevin's ruling: a test must refuse cross-brand output)."""
    got = brand_of(record_fields)
    if got != brand:
        raise SystemExit("brand guard: record %r is %s, refused by the %s publisher" % ((record_fields or {}).get("Content Name"), got, brand))
    return True


def _cfg(brand="Runpreneur"):
    b = BRANDS[brand]
    return open(b["key"]).read().strip(), open(b["loc"]).read().strip(), open(USER_FILE).read().strip()


def ghl(method, path, body=None, brand="Runpreneur"):
    key, _, _ = _cfg(brand)
    req = urllib.request.Request(GHL + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Authorization": "Bearer " + key, "Version": "2021-07-28", "Accept": "application/json",
                                          "Content-Type": "application/json", "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit("GHL %s %s -> %s: %s" % (method, path, e.code, e.read().decode()[:400]))


def accounts(brand="Runpreneur"):
    _, loc, _ = _cfg(brand)
    return ghl("GET", "/social-media-posting/%s/accounts" % loc, brand=brand)["results"]["accounts"]


def upload_media(path, brand="Runpreneur"):
    """Multipart upload through curl. The key goes in a curl config file (mode 600), never an argument."""
    key, loc, _ = _cfg(brand)
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".curlrc") as fh:
        os.chmod(fh.name, 0o600)
        fh.write('header = "Authorization: Bearer %s"\nheader = "Version: 2021-07-28"\nuser-agent = "%s"\n' % (key, UA))
        cfg = fh.name
    mime = "image/png" if path.endswith(".png") else ("audio/mpeg" if path.endswith(".mp3") else "video/mp4")
    try:
        r = subprocess.run(["curl", "-s", "-K", cfg, "-F", "file=@%s;type=%s" % (path, mime), "-F", "hosted=false", "-F", "name=" + os.path.basename(path),
                            GHL + "/medias/upload-file?altType=location&altId=" + loc], capture_output=True, text=True, timeout=1800)
    finally:
        os.remove(cfg)
    try: d = json.loads(r.stdout)
    except ValueError: raise SystemExit("media upload failed for %s: %s" % (os.path.basename(path), (r.stdout or r.stderr)[:300]))
    if not d.get("url"): raise SystemExit("media upload returned no url for %s: %s" % (os.path.basename(path), r.stdout[:300]))
    return d["url"]


def episode_files(day):
    folder = os.path.join(EDITED_ROOT, approval_hundreds(day), str(day))
    return {k: os.path.join(folder, name % day) for k, name in CLIP_FILES.items()}


def approval_hundreds(day):
    import render
    return render.hundreds_folder(day)


MEDIA_MAX_BYTES = 450 * 1024 * 1024   # 9 Sep 2026: GoHighLevel's edge answered 413 to a 740 MB episode that would have gone through a week earlier; 449 MB still goes
MEDIA_AUDIO_KBPS = 160


def fit_bitrate_kbps(size_bytes, duration_s, limit=MEDIA_MAX_BYTES, audio_kbps=MEDIA_AUDIO_KBPS, margin=0.92):
    """Video bitrate (kbps) that lands a file of `duration_s` under the upload limit with the audio track kept.
    None when the file already fits."""
    if size_bytes <= limit or duration_s <= 0: return None
    total_kbps = (limit * margin * 8 / 1000.0) / duration_s
    return max(int(total_kbps - audio_kbps), 1500)


def fit_for_upload(path, limit=MEDIA_MAX_BYTES):
    """The file to upload: the original when it fits, otherwise a transcode under the limit in the work folder.
    The Drive archive keeps the full-quality file; YouTube re-encodes whatever it gets anyway."""
    size = os.path.getsize(path)
    if size <= limit or not path.endswith(".mp4"): return path
    dur = float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True).stdout or 0)
    kbps = fit_bitrate_kbps(size, dur, limit)
    out = os.path.join(watch.WORK, "upload_" + os.path.basename(path))
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", path, "-c:v", "h264_videotoolbox", "-b:v", "%dk" % kbps, "-maxrate", "%dk" % int(kbps * 1.15), "-bufsize", "%dk" % (kbps * 2),
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "%dk" % MEDIA_AUDIO_KBPS, "-movflags", "+faststart", out], check=True)
    got = os.path.getsize(out)
    if got > limit: raise SystemExit("upload copy of %s is still %d MB after transcoding at %d kbps" % (os.path.basename(path), got // 1048576, kbps))
    print("publish: %s is %d MB, over the %d MB upload limit; uploading a %d MB copy at %d kbps (the Drive file is untouched)" % (os.path.basename(path), size // 1048576, limit // 1048576, got // 1048576, kbps))
    return out


def media_for(day, entry, kinds):
    files = episode_files(day); media = entry.setdefault("media", {})
    for k in kinds:
        if media.get(k): continue
        if not os.path.exists(files[k]):
            if k in ("thumb", "podcast"): continue
            raise SystemExit("episode %d: %s is not in the edited folder (%s)" % (day, k, files[k]))
        src = fit_for_upload(files[k])
        media[k] = upload_media(src)
        if src != files[k] and os.path.exists(src): os.remove(src)
        print("episode %d: uploaded %s" % (day, k))
    return media


def bundle(day):
    return {ctype: pc.find_by_name(pc.record_name(day, ctype)) for ctype in pc.TYPES}


def approved_days():
    st = approval.load_state()
    return sorted(int(d) for d, e in st.items() if e.get("verdict") == "approved")


def create_post(body, brand="Runpreneur"):
    _, loc, _ = _cfg(brand)
    r = ghl("POST", "/social-media-posting/%s/posts" % loc, body, brand=brand)
    post = (r.get("results") or r).get("post") or r
    return post.get("_id") or post.get("id")


def schedule_stage(day, entry, recs, acct_map, stage, dry_run=False, index=0):
    _, _, user = _cfg()
    full = recs["Long Form Video"]; ff = full["fields"]
    day_london = dt.datetime.now(LONDON).date()
    todo = []
    for key_name, cfg in CHANNELS.items():
        platform = cfg.get("platform", key_name)
        if cfg["stage"] != stage or platform not in acct_map: continue
        for spec in cfg["posts"]:
            if spec["clip"] != "full" and not os.path.exists(episode_files(day)[spec["clip"]]):
                continue                                   # no Learnings clip this episode (no diary section): nothing to post
            rec = recs.get(spec["record"])
            copy = ((rec or {}).get("fields", {}).get(spec["field"]) or "").strip()
            if not copy:
                print("episode %d: no %s on the %s record, %s skipped" % (day, spec["field"], spec["record"], platform)); continue
            if stage == 2:
                if not entry.get("youtube_link"): raise SystemExit("episode %d: stage 2 without a YouTube link" % day)
                copy = with_youtube_link(copy, entry["youtube_link"])
            if platform == "youtube" and spec.get("yt_type") == "short":
                first, _, rest = copy.partition("\n"); title, body_text = first.strip()[:100], rest.strip()   # the Short's title is the first line
            else:
                title, body_text = youtube_parts(copy, day) if platform == "youtube" else (None, copy)
            for account in acct_map[platform]:
                key = post_key(platform, account["id"], spec["clip"])
                if key in entry.get("posts", {}): continue
                todo.append((platform, account, spec, body_text, title, key))
    if not todo:
        print("episode %d: nothing to schedule at stage %d" % (day, stage)); return 0
    kinds = sorted({t[2]["clip"] for t in todo}) + (["thumb"] if stage == 1 else [])
    if dry_run:
        for platform, account, spec, text, title, key in todo:
            print("  would schedule %s (%s) <- %s at %s: %s" % (platform, account["name"], spec["clip"], slot_iso(day_london, spec["slot"]), text[:90].replace("\n", " ")))
        return len(todo)
    media = media_for(day, entry, kinds)
    m = mode(); test = m == "test"
    for platform, account, spec, text, title, key in todo:
        left = placeholder_left(text) or placeholder_left(title or "")
        if left:
            print("episode %d: %s %s REFUSED, placeholder %s still in the copy" % (day, spec["clip"], platform, left)); continue
        when = when_for(platform, spec["clip"], index, youtube_at=youtube_at(entry))
        if platform == "youtube" and youtube_direct_ready():
            # Straight to the channel through Google's API (Kevin, 9 Sep 2026): full quality, English, our caption
            # file attached, no burnt-in captions on the YouTube copy, link known at once. GoHighLevel is the fallback.
            try:
                post = youtube_direct(day, spec["clip"], title, text, when, test)
            except SystemExit as ex:
                print("episode %d: direct YouTube upload of %s FAILED (%s); GoHighLevel will carry it" % (day, spec["clip"], str(ex)[-200:]), file=sys.stderr)
            else:
                entry.setdefault("posts", {})[key] = post
                if spec["clip"] == "full" and not entry.get("youtube_link"): entry["youtube_link"] = post["link"]
                print("episode %d [%s]: %s youtube -> channel %s %s (%s)" % (day, m.upper(), spec["clip"], post["status"], when, post["link"]))
                continue
        # Test mode: YouTube still goes up (unlisted, so the link exists) but every social post is a DRAFT.
        status = "scheduled" if (not test or platform == "youtube") else "draft"
        body = build_post(platform, account, spec, text, media[spec["clip"]], media.get("thumb"), when, user, day, title,
                          status=status, privacy="unlisted" if test else "public")
        pid = create_post(body)
        entry.setdefault("posts", {})[key] = {"id": pid, "platform": platform, "account": account["name"], "clip": spec["clip"], "scheduled": when if status == "scheduled" else None,
                                              "status": status, "mode": m}
        print("episode %d [%s]: %s %s -> %s %s %s (post %s)" % (day, m.upper(), spec["clip"], platform, account["name"], status, when if status == "scheduled" else "", pid))
    status = STATUS_YT if stage == 1 else STATUS_SOCIALS
    what = ("full episode to YouTube%s" % (" (UNLISTED, test mode)" if test else "")) if stage == 1 else ("Summary and Learnings clips to the socials%s" % (" as DRAFTS (test mode)" if test else ""))
    fields = {"Record Status": status}
    if stage == 1:
        yt_title = youtube_parts(ff.get("YouTube Copy"), day)[0]
        fields["Video Title"] = yt_title; fields["Target Publish Date"] = day_london.isoformat()
    if stage == 2:
        # the article and the podcast audio ride with the socials: same approval, same night
        import blog
        media = media_for(day, entry, ["thumb", "podcast"])
        try:
            pid, url = blog.publish_blog(day, full, entry, media.get("thumb"), entry["youtube_link"], test)
            fields["Blog Link"] = url
            what += "; blog article %s" % ("saved as a DRAFT (test mode)" if test else "published")
            print("episode %d [%s]: blog %s -> %s (post %s)" % (day, m.upper(), "draft" if test else "published", url, pid))
        except SystemExit as ex:
            print("episode %d: blog not published (%s)" % (day, str(ex)[:160]))
        if media.get("podcast"):
            entry.setdefault("podcast", {})["audio_url"] = media["podcast"]
        # Spotify for Creators takes the full episode VIDEO (Ericamae's episodes are video episodes);
        # the browser lane runs this plan: prepare -> screenshot on the card, commit after approval.
        import spotify
        files = episode_files(day)
        upload = files["podcast"] if spotify.PODCAST_FORMAT == "audio" and os.path.exists(files["podcast"]) else files["full"]
        if os.path.exists(upload):
            plan_path, ptitle = spotify.write_plan(day, upload, ff.get("Podcast Copy"), entry["youtube_link"], test, os.path.dirname(STATE), thumb=files.get("thumb", ""))
            pod = entry.setdefault("podcast", {}); pod["plan"] = plan_path; pod["title"] = ptitle
            what += "; " + run_spotify(day, full["id"], plan_path, ptitle, test, pod)
    fields["Notes"] = approval.append_note(full, "%s: %s through GoHighLevel." % (dt.date.today().isoformat(), what))
    watch._airtable("PATCH", watch.API + "/" + full["id"], {"fields": fields})
    return len(todo)


def youtube_direct_ready():
    """The API route exists once Kevin's consent token and the app's client file are on disk (10 Sep 2026)."""
    import youtube_api
    return os.path.exists(youtube_api.TOKEN_FILE) and os.path.exists(youtube_api.CLIENT_FILE)


def youtube_direct(day, clip, title, text, when, test):
    """Upload the clean render (no burnt-in captions) with its caption file and the thumbnail. Live: private now,
    public at the slot (YouTube's own scheduler). Test: unlisted at once. Returns the post record for the state."""
    import youtube_api
    files = episode_files(day)
    path = files.get(clip + "_yt") if os.path.exists(files.get(clip + "_yt", "")) else files[clip]
    srt = files.get(clip + "_srt") if os.path.exists(files.get(clip + "_srt", "")) else None
    thumb = files.get("thumb") if os.path.exists(files.get("thumb", "")) else None
    vid = youtube_api.upload(path, title or ("Diary of a Runpreneur, Day %d" % day), text, privacy="unlisted" if test else "private",
                             publish_at=None if test else when, thumbnail=thumb, srt=srt)
    link = "https://youtu.be/" + vid
    return {"id": vid, "platform": "youtube", "route": "api", "account": "Runpreneur", "clip": clip, "scheduled": None if test else when,
            "status": "published" if test else "scheduled", "link": link, "mode": mode(), "file": os.path.basename(path), "captions": bool(srt)}


def run_spotify(day, task_id, plan_path, title, test, pod):
    """Runs the Spotify plan through the browser lane right after the socials (9 Sep 2026, first automatic
    episode was 2054 by hand). Live: `commit`, which re-reads the approval itself, presses Publish and
    then checks the episodes list; a video shows as Draft for a few minutes while Spotify processes it,
    so 'processing' is recorded and the public link is filled in by sync. Test: `prepare` stops at Review."""
    import spotify
    shot = os.path.join(os.path.dirname(STATE), "spotify_%d_%s.png" % (day, "review" if test else "published"))
    try:
        spotify.run_plan(plan_path, task_id, test, shot)
    except SystemExit as ex:
        pod["status"] = "failed"; pod["error"] = str(ex)[-300:]
        print("episode %d: Spotify upload FAILED: %s" % (day, str(ex)[-300:]), file=sys.stderr)
        return "Spotify upload FAILED (%s)" % str(ex)[-120:]
    pod["shot"] = shot
    if test:
        pod["status"] = "reviewed"; return "Spotify episode filled to the Review step (test mode, not published)"
    status, snippet = spotify.verify_published(title)
    pod["status"] = status; pod["list_snippet"] = snippet
    link = spotify.public_link(title) if status == "published" else ""
    if link: pod["link"] = link
    print("episode %d: Spotify %s%s" % (day, status, (" " + link) if link else ""))
    return "Spotify episode %s%s" % ("published" if status == "published" else "uploaded and processing", (" " + link) if link else "")


def share_to_facebook_profile(day, entry, state):
    """Kevin's own profile gets the PAGE's post, shared (Kevin, 10 Sep 2026: "it should just be shared from the
    Facebook page to the Facebook profile"), once that page post is live. The page post URL is read off the page
    itself, because GoHighLevel never returns one. Signed out, or the post not up yet: recorded, retried hourly."""
    import facebook_share
    fb = entry.setdefault("facebook_share", {})
    if fb.get("status") in ("shared", "reviewed"): return False
    page = [p for k, p in (entry.get("posts") or {}).items() if p.get("platform") == "facebook" and p.get("clip") == "summary"]
    if not page: return False
    post = page[0]
    if post.get("status") not in ("published", "scheduled"): return False
    if post.get("scheduled"):
        try:
            due = dt.datetime.fromisoformat(post["scheduled"].replace("Z", "+00:00"))
            if dt.datetime.now(dt.timezone.utc) < due + dt.timedelta(minutes=10): return False   # the page post is not out yet
        except ValueError: pass
    if not facebook_share.signed_in():
        fb["status"] = "signin-needed"
        print("episode %s: Facebook profile share waits: SIGN-IN NEEDED www.facebook.com (Robot sign-in app)" % day, file=sys.stderr)
        return True
    recs = bundle(int(day))
    copy = ((recs.get("Short Form Video") or {}).get("fields", {}).get("Facebook Reels Copy") or "").strip()
    url = fb.get("post_url") or facebook_share.find_page_post(copy)
    if not url:
        fb["status"] = "page-post-not-found"
        print("episode %s: the page post is not on the Facebook page yet; looking again next run" % day)
        return True
    fb["post_url"] = url
    test = mode() == "test"
    plan_path, text = facebook_share.write_plan(int(day), url, copy, entry.get("youtube_link", ""), test, os.path.dirname(STATE))
    shot = os.path.join(os.path.dirname(STATE), "facebook_share_%s.png" % day)
    task = (approval.load_state().get(str(day)) or {}).get("task", "")
    fb.update({"plan": plan_path, "text": text})
    try:
        facebook_share.run_plan(plan_path, task, test, shot)
    except SystemExit as ex:
        fb["status"] = "failed"; fb["error"] = str(ex)[-300:]
        print("episode %s: Facebook profile share FAILED: %s" % (day, str(ex)[-200:]), file=sys.stderr)
        return True
    fb.update({"status": "reviewed" if test else "shared", "shot": shot,
               "shared_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    if not test and not facebook_share.verify_shared(url):
        fb["status"] = "unconfirmed"
        print("episode %s: pressed Share but the post is not on the profile yet" % day, file=sys.stderr)
    else:
        print("episode %s: the page post is shared to Kevin's profile (%s)" % (day, url))
    return True


CURSOR_KEY = "_cursor"


def cursor(state):
    """The last day put on YouTube, in order. Starts one below Kevin's takeover day (2053 when start_day is 2054)."""
    if CURSOR_KEY in state: return int(state[CURSOR_KEY])
    sd = watch.start_day()
    return (sd - 1) if sd else 0


def day_was_recorded(day, ledger):
    return any(v.get("episode") == day for v in ledger.values())


def next_publishable(state, ledger, approved):
    """Strict order (Kevin, 8 Sep 2026: keep the day numbers in order): only cursor+1 may go to YouTube. A day
    that was never recorded (no clip in the ledger while later days exist) is stepped over and noted; a day
    that exists but is not yet approved holds everything behind it. Returns (day or None, reason)."""
    c = cursor(state)
    later = max((v.get("episode") or 0 for v in ledger.values()), default=0)
    while True:
        nxt = c + 1
        if nxt in approved: return nxt, "in order"
        if not day_was_recorded(nxt, ledger) and later > nxt:
            state.setdefault("_skipped_days", []).append(nxt); state[CURSOR_KEY] = nxt; c = nxt
            print("publish: day %d has no recording; stepping over it" % nxt, file=sys.stderr); continue
        return None, ("day %d is not approved yet, so %s wait behind it" % (nxt, ", ".join(str(d) for d in approved if d > nxt) or "nothing else")) if approved else "nothing approved"


def may_go_to_youtube(day, gaps, state, ledger, approved):
    """A gap day (Kevin's catch-up list) goes the moment it is approved: it fills an old hole and never queues
    behind the cursor. Every other day goes only when it is the cursor's next, in strict order."""
    if day in gaps: return True
    nxt, _ = next_publishable(state, ledger, set(approved) - set(gaps))
    return nxt == day


def moves_cursor(day, gaps):
    return day not in gaps


def run(dry_run=False, limit=3):
    state = load_state(); days = approved_days()
    if not days: print("publish: no approved episodes"); return
    acct_map = account_map(accounts()); yt_ok = "youtube" in acct_map
    ledger = watch.load_ledger()
    done = 0; per_stage = {1: 0, 2: 0}
    gaps = watch.gap_days()   # Kevin's catch-up days (8 Sep 2026): they fill old holes, so they never wait for, or move, the cursor
    held = [d for d in days if d > cursor(state) + 1 and d not in gaps]
    if held: print("publish: held for order (behind day %d): %s" % (cursor(state) + 1, ", ".join(str(d) for d in held)))
    for day in days:
        entry = state.setdefault(str(day), {})
        recs = bundle(day)
        full = recs["Long Form Video"]
        if not full or full["fields"].get("Record Status") not in PUBLISHABLE:
            continue
        stage = stage_for(entry, yt_ok)
        if stage == "youtube" and not may_go_to_youtube(day, gaps, state, ledger, days):
            continue
        if stage == "wait-youtube-account":
            print("episode %d: approved, waiting for a YouTube account in GoHighLevel (Kevin's click: publish.py youtube-link)" % day); continue
        if stage == "wait-youtube-link":
            print("episode %d: YouTube post scheduled, waiting for it to publish before the socials go out" % day); continue
        if stage == "done":
            continue
        if done >= limit: break
        st_no = 1 if stage == "youtube" else 2
        n = schedule_stage(day, entry, recs, acct_map, st_no, dry_run, index=per_stage[st_no])
        if n: per_stage[st_no] += 1
        if n and st_no == 1 and not dry_run and moves_cursor(day, gaps): state[CURSOR_KEY] = day
        done += 1 if n else 0
        if not dry_run: save_state(state)
        # Same day, not the day after (Kevin, 10 Sep 2026). The direct upload hands back the YouTube link at
        # once, so the socials, the blog, the podcast and Spotify go out this afternoon instead of tomorrow.
        if st_no == 1 and n and stage_for(entry, yt_ok) == "socials":
            if schedule_stage(day, entry, recs, acct_map, 2, dry_run, index=per_stage[2]):
                per_stage[2] += 1
                if not dry_run: save_state(state)


YTDLP = os.path.expanduser("~/Library/Python/3.9/bin/yt-dlp")
CHANNEL_URL = "https://www.youtube.com/@runpreneur/videos"
YT_GRACE_MINUTES = 20


def title_is_episode(title, day):
    """The channel title names the day: 'Episode 2054', 'Ep2054', 'Ep 2054/5000', 'Day 2,054'."""
    t = title or ""
    return bool(re.search(r"\b(?:Episode|Ep\.?)\s?%d\b" % day, t, re.I) or re.search(r"\bDay\s?%s\b" % "{:,}".format(day), t, re.I) or re.search(r"\bDay\s?%d\b" % day, t, re.I))


def youtube_link_from_channel(day, scheduled_iso, now=None, listing=None):
    """https://youtu.be/<id> for the day's video on the channel, once the slot is YT_GRACE_MINUTES past; else None."""
    now = now or dt.datetime.now(dt.timezone.utc)
    try: due = dt.datetime.strptime(scheduled_iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except (TypeError, ValueError): return None
    if now < due + dt.timedelta(minutes=YT_GRACE_MINUTES): return None
    if listing is None:
        try:
            r = subprocess.run([YTDLP, "--flat-playlist", "-j", "--no-warnings", "--playlist-end", "6", CHANNEL_URL], capture_output=True, text=True, timeout=120)
            listing = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
        except Exception as ex:
            print("youtube: channel listing failed (%s)" % str(ex)[:80], file=sys.stderr); return None
    for item in listing:
        if item.get("id") and title_is_episode(item.get("title"), day): return "https://youtu.be/" + item["id"]
    return None


def sync():
    """GHL post statuses -> links on the record; the YouTube link unlocks stage 2; all published -> Published."""
    state = load_state(); _, loc, _ = _cfg()
    for day, entry in state.items():
        if not str(day).isdigit() or not isinstance(entry, dict): continue   # _cursor, _skipped_days, held_posts live beside the episodes (9 Sep 2026: the first live cursor crashed sync)
        if share_to_facebook_profile(day, entry, state): save_state(state)
        pod = entry.get("podcast") or {}
        if pod.get("status") == "processing" and pod.get("title"):
            # the public link arrives once Spotify has processed the video (a few minutes after Publish)
            import spotify
            link = spotify.public_link(pod["title"])
            if link:
                pod["status"] = "published"; pod["link"] = link; save_state(state)
                print("episode %s: Spotify episode is live %s" % (day, link))
                try:
                    full = pc.find_by_name(pc.record_name(int(day), "Long Form Video"))
                    if full: watch._airtable("PATCH", watch.API + "/" + full["id"], {"fields": {"Notes": approval.append_note(
                        full, "%s: Spotify episode live %s" % (dt.date.today().isoformat(), link))}})
                except Exception as ex: print("episode %s: could not note the Spotify link (%s)" % (day, str(ex)[:120]))
        posts = entry.get("posts", {})
        if not posts: continue
        changed = False; links = {}; clip_links = {}
        for key, p in posts.items():
            if p.get("status") in ("published", "draft"): continue     # a draft (test mode) never moves on its own
            if p.get("route") == "api":                                # uploaded straight to YouTube: the slot passing is the publish
                if p.get("scheduled") and dt.datetime.now(dt.timezone.utc) >= dt.datetime.fromisoformat(p["scheduled"].replace("Z", "+00:00")):
                    p["status"] = "published"; p.setdefault("published_at", p["scheduled"]); changed = True
                    for f in LINK_FIELDS.get(("youtube", p["clip"]), ()): links.setdefault(f, p["link"])
                    if p["clip"] == "full" and not entry.get("youtube_link"): entry["youtube_link"] = p["link"]
                continue
            try:
                g = ghl("GET", "/social-media-posting/%s/posts/%s" % (loc, p["id"]))
            except SystemExit as ex:
                print("episode %s: cannot read post %s (%s)" % (day, p["id"], str(ex)[:120])); continue
            post = (g.get("results") or g).get("post") or g
            st = post.get("status"); link = post.get("previewLink") or ""
            if st != p.get("status"): p["status"] = st; changed = True
            if st == "failed": p["error"] = str(post.get("error"))[:200]; print("episode %s: %s post FAILED: %s" % (day, p["platform"], p["error"]))
            if st == "scheduled" and p["platform"] == "youtube" and p["clip"] == "full" and not link:
                # 9 Sep 2026: episode 2054 was live on YouTube at 15:24 and GoHighLevel never flipped its own post from
                # 'scheduled' (no error either). Twenty minutes past the slot, the channel itself is the source of truth.
                found = youtube_link_from_channel(int(day), p.get("scheduled"))
                if found: st, link = "published", found; p["status"] = st; p["note"] = "link read from the channel listing; GHL never updated its post"; print("episode %s: YouTube live as %s (GHL post still says scheduled)" % (day, found))
            if st == "published" and link:
                p["link"] = link; p.setdefault("published_at", dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")); changed = True
                if p["platform"] == "youtube" and not entry.get("youtube_link"): entry["youtube_link"] = link
                for f in LINK_FIELDS.get((p["platform"], p["clip"]), ()):
                    links.setdefault(f, link)                      # first account wins (the Runpreneur page before the profile)
                    clip_links.setdefault(p["clip"], {}).setdefault(f, link)
        if links or (changed and all(p.get("status") == "published" for p in posts.values())):
            full = pc.find_by_name(pc.record_name(int(day), "Long Form Video"))
            fields = dict(links)
            if entry.get("youtube_link") and not full["fields"].get("Date Published (YT)"): fields["Date Published (YT)"] = dt.date.today().isoformat()
            if all(p.get("status") == "published" for p in posts.values()) and len([k for k in posts if not k.startswith("youtube|")]):
                fields["Record Status"] = STATUS_PUBLISHED; fields["Date Published (Other)"] = dt.date.today().isoformat()
            watch._airtable("PATCH", watch.API + "/" + full["id"], {"fields": fields})
            for clip, cl in clip_links.items():
                if clip == "full": continue
                rec = pc.find_by_name(pc.record_name(int(day), CLIP_RECORD[clip]))
                if rec: watch._airtable("PATCH", watch.API + "/" + rec["id"], {"fields": {k: v for k, v in cl.items() if not k.startswith("Link of")}})
            print("episode %s: %s" % (day, ", ".join(sorted(fields))))
        if changed: save_state(state)


CHANNEL_NAMES = {("youtube", "full"): "YouTube full episode", ("youtube", "lfmd"): "YouTube Short",
                 ("facebook", "summary"): "Facebook page (teaser)", ("facebook", "lfmd"): "Facebook page (Learnings)",
                 ("instagram", "summary"): "Instagram (teaser)", ("instagram", "lfmd"): "Instagram (Learnings)",
                 ("threads", "summary"): "Threads (teaser)", ("threads", "lfmd"): "Threads (Learnings)",
                 ("linkedin", "summary"): "LinkedIn (teaser)", ("linkedin", "lfmd"): "LinkedIn (Learnings)",
                 ("tiktok", "summary"): "TikTok (teaser)", ("tiktok", "lfmd"): "TikTok (Learnings)"}


def published_rows(day, entry):
    """One row per destination for an episode: channel, account, state, when, link. The spine of the
    publishing report Kevin asked for (10 Sep 2026), built from what the engine actually did."""
    rows = []
    for key, p in sorted((entry.get("posts") or {}).items()):
        name = CHANNEL_NAMES.get((p.get("platform"), p.get("clip")), "%s (%s)" % (p.get("platform"), p.get("clip")))
        rows.append({"channel": name, "account": p.get("account", ""), "status": p.get("status", "?"),
                     "when": p.get("published_at") or p.get("scheduled") or "", "link": p.get("link") or "",
                     "route": p.get("route", "ghl")})
    blog = entry.get("blog") or {}
    if blog.get("url") or entry.get("blog_url"): rows.append({"channel": "Blog article", "account": "runpreneur.org.uk", "status": "published", "when": blog.get("at", ""), "link": blog.get("url") or entry.get("blog_url", ""), "route": "ghl"})
    pod = entry.get("podcast") or {}
    if pod: rows.append({"channel": "Spotify podcast", "account": "Runpreneur", "status": pod.get("status", "?"), "when": pod.get("shared_at", ""), "link": pod.get("link", ""), "route": "browser"})
    fb = entry.get("facebook_share") or {}
    if fb: rows.append({"channel": "Facebook profile (shared)", "account": "Kevin Brittain", "status": fb.get("status", "?"), "when": fb.get("shared_at", ""), "link": fb.get("post_url", ""), "route": "browser"})
    return rows


def published(day=0):
    state = load_state()
    days = [str(day)] if day else sorted([d for d in state if str(d).isdigit()], key=int)[-3:]
    for d in days:
        entry = state.get(d) or {}
        rows = published_rows(d, entry)
        print("episode %s: %d destination%s" % (d, len(rows), "" if len(rows) == 1 else "s"))
        for r in rows:
            print("  %-28s %-18s %-11s %-20s %s" % (r["channel"][:28], r["account"][:18], r["status"], r["when"], r["link"][:60]))


def report():
    days = approved_days()
    state = {k: v for k, v in load_state().items() if str(k).isdigit() and isinstance(v, dict)}   # episodes only: _cursor and held_posts live beside them
    print("content publishing mode: %s%s" % (mode().upper(), " (YouTube unlisted, socials as drafts; write 'live' to ~/.config/od/content_engine_mode to go live)" if mode() == "test" else ""))
    waiting = [d for d in days if not state.get(str(d), {}).get("posts")]
    scheduled = sum(1 for e in state.values() for p in e.get("posts", {}).values() if p.get("status") == "scheduled")
    failed = sum(1 for e in state.values() for p in e.get("posts", {}).values() if p.get("status") == "failed")
    published = [d for d, e in state.items() if e.get("posts") and all(p.get("status") == "published" for p in e["posts"].values())]
    print("content publishing: %d approved episode%s not yet scheduled, %d posts scheduled, %d failed, %d episodes fully published" % (
        len(waiting), "" if len(waiting) == 1 else "s", scheduled, failed, len(published)))


def youtube_link():
    key, loc, user = _cfg()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k): return None
    req = urllib.request.Request(GHL + "/social-media-posting/oauth/youtube/start?locationId=%s&userId=%s&reconnect=false" % (loc, user),
                                 headers={"Authorization": "Bearer " + key, "Version": "2021-07-28", "User-Agent": UA})
    try: r = urllib.request.build_opener(NoRedirect).open(req); print(r.headers.get("Location"))
    except urllib.error.HTTPError as e: print(e.headers.get("Location") or e.read().decode()[:300])


def selftest():
    assert slot_iso(dt.date(2026, 9, 4), (6, 0)) == "2026-09-04T05:00:00Z", "BST: 06:00 London is 05:00 UTC"
    assert slot_iso(dt.date(2026, 12, 4), (6, 0)) == "2026-12-04T06:00:00Z", "GMT: the same wall clock"
    t, b = youtube_parts("SEO Title: Running Off-Road at Pace (Day 2195)\n\nDescription: Day 2195 body.\n\nHashtags: #a #b", 2195)
    assert t == "Running Off-Road at Pace (Day 2195)" and b.startswith("Day 2195 body.") and "#a #b" in b and "SEO Title" not in b, (t, b)
    assert youtube_parts("", 7)[0] == "Diary of a Runpreneur, Day 7" and len(youtube_parts("SEO Title: " + "x" * 200, 1)[0]) == 100
    assert with_youtube_link("Watch full YT video here 👉 [ADD YOUTUBE LINK]\n#a", "https://youtu.be/x") == "Watch full YT video here 👉 https://youtu.be/x\n#a"
    assert with_youtube_link("no line", "https://youtu.be/x").endswith("Watch the full episode: https://youtu.be/x")
    assert placeholder_left("see [ADD YOUTUBE LINK] here") == "[ADD YOUTUBE LINK]" and placeholder_left("[LINK]") == "[LINK]"
    assert placeholder_left("fine copy [2026] #tag") is None and placeholder_left(with_youtube_link("x [ADD YOUTUBE LINK]", "https://youtu.be/a")) is None
    accts = [{"id": "fb", "platform": "facebook", "type": "page", "active": True, "name": "Runpreneur"}, {"id": "fbx", "platform": "facebook", "type": "page", "active": False, "name": "old"},
             {"id": "tw", "platform": "twitter", "type": "profile", "active": True, "name": "x"}, {"id": "li", "platform": "linkedin", "type": "page", "active": True, "name": "Runpreneur"},
             {"id": "tt", "platform": "tiktok", "type": "profile", "active": True, "name": "tt"}, {"id": "yt", "platform": "youtube", "type": "profile", "active": True, "name": "yt"}]
    am = account_map(accts)
    assert set(am) == {"facebook", "linkedin", "tiktok", "youtube"} and [a["id"] for a in am["facebook"]] == ["fb"], "expired rows and X never get a post"
    e = {}; assert stage_for(e, False) == "wait-youtube-account" and stage_for(e, True) == "youtube"
    e = {"posts": {"youtube|full|yt": {"status": "scheduled"}}}; assert stage_for(e, True) == "wait-youtube-link"
    e["youtube_link"] = "https://youtu.be/x"; assert stage_for(e, True) == "socials"
    e["posts"]["tiktok|summary|tt"] = {}; assert stage_for(e, True) == "done"
    spec = CHANNELS["youtube"]["posts"][0]
    b = build_post("youtube", accts[5], spec, "desc", "https://cdn/full.mp4", "https://cdn/t.png", "2026-09-04T05:00:00Z", "u1", 2195, "Title")
    assert b["youtubePostDetails"] == {"title": "Title", "privacyLevel": "public", "type": "video"} and b["media"][0]["thumbnail"] == "https://cdn/t.png"
    assert b["status"] == "scheduled" and b["scheduleDate"] == "2026-09-04T05:00:00Z" and b["accountIds"] == ["yt"] and b["userId"] == "u1"
    tt = build_post("tiktok", accts[4], CHANNELS["tiktok"]["posts"][0], "c", "https://cdn/s.mp4", None, "x", "u1", 1)
    assert tt["tiktokPostDetails"]["privacyLevel"] == "PUBLIC_TO_EVERYONE" and "thumbnail" not in tt["media"][0]
    fb = build_post("facebook", accts[0], CHANNELS["facebook"]["posts"][0], "c", "https://cdn/s.mp4", None, "x", "u1", 1, status="draft")
    assert fb["type"] == "reel" and fb["facebookPostDetails"] == {"type": "reel"} and "scheduleDate" not in fb
    assert all(spec["field"] in dict(pc.TYPES[spec["record"]]["sections"]).values() for c in CHANNELS.values() for spec in c["posts"]), "every copy field exists on its record type"
    sh = CHANNELS["youtube-short"]["posts"][0]; assert sh["clip"] == "lfmd" and sh["yt_type"] == "short" and CHANNELS["youtube-short"]["stage"] == 2
    bs = build_post("youtube", accts[5], sh, "desc", "https://cdn/l.mp4", None, "x", "u1", 1, "Short title"); assert bs["youtubePostDetails"]["type"] == "short"
    assert staggered((6, 0), 0) == (6, 0) and staggered((6, 0), 1) == (12, 0) and staggered((6, 0), 2) == (18, 0) and staggered((17, 0), 2) == (5, 0)
    t = dt.datetime(2026, 9, 9, 8, 30, tzinfo=LONDON)
    assert when_for("youtube", "full", 0, t) == "2026-09-09T07:45:00Z", "06:00 has passed at 08:30: fifteen minutes from now, same day"
    assert when_for("linkedin", "summary", 0, t) == "2026-09-09T11:00:00Z" and when_for("tiktok", "lfmd", 0, t) == "2026-09-09T18:30:00Z"
    assert when_for("facebook", "summary", 1, t) == "2026-09-09T13:30:00Z", "second episode of the day two hours later"
    led = {"a": {"episode": 2054}, "b": {"episode": 2056}}
    st = {}; assert next_publishable(st, led, {2054, 2056}) == (2054, "in order") or watch.start_day() != 2054
    st = {CURSOR_KEY: 2054}; assert next_publishable(st, led, {2056}) == (2056, "in order") and st["_skipped_days"] == [2055], "an unrecorded day is stepped over"
    st = {CURSOR_KEY: 2054}; assert next_publishable(st, {"a": {"episode": 2054}, "c": {"episode": 2055}, "b": {"episode": 2056}}, {2056})[0] is None, "a recorded, unapproved day holds the line"
    # Kevin's catch-up days (8 Sep 2026): a gap day publishes when approved and never moves the cursor; the continuity day still waits its turn
    led = {"a": {"episode": 2054}, "b": {"episode": 2055}, "g": {"episode": 1799}}; gaps = {1799, 1808, 1841}
    st = {CURSOR_KEY: 2053}; assert may_go_to_youtube(1799, gaps, st, led, {1799, 2055}) and not may_go_to_youtube(2055, gaps, st, led, {1799, 2055})
    import inspect; src = inspect.getsource(sync); assert "import platform_copy" not in src, "sync must use the module-level pc: an import inside the function made pc a local and crashed every sync (10 Sep 2026, 07:15)"
    assert 'if not str(day).isdigit() or not isinstance(entry, dict): continue' in src, "sync skips the cursor and the held posts"
    assert may_go_to_youtube(2054, gaps, st, led, {1799, 2054}) and st[CURSOR_KEY] == 2053, "a gap day in the approved set does not disturb the order"
    assert not moves_cursor(1799, gaps) and moves_cursor(2054, gaps)
    assert "twitter" not in CHANNELS
    assert "YouTube Link" in LINK_FIELDS[("youtube", "full")] and "TikTok Link" in LINK_FIELDS[("tiktok", "summary")] and "Facebook Post Link" in LINK_FIELDS[("facebook", "summary")]
    assert "LinkedIn Link" in LINK_FIELDS[("linkedin", "summary")] and "Threads Link" in LINK_FIELDS[("threads", "summary")], "the fields Ericamae's pages read"
    assert CLIP_FILES["podcast"] == "Ep%d_Podcast.mp3"
    import inspect as _i2; src2 = _i2.getsource(schedule_stage); assert "youtube_direct_ready()" in src2 and src2.index("youtube_direct_ready()") < src2.index("create_post(body)"), "the API route is tried before GoHighLevel"
    ys = _i2.getsource(youtube_direct); assert 'files[clip]' in ys and '"_srt"' in ys and 'privacy="unlisted" if test else "private"' in ys and "publish_at=None if test else when" in ys
    ss = _i2.getsource(sync); assert 'p.get("route") == "api"' in ss and 'p["status"] = "published"' in ss, "API uploads flip to published on their slot without asking GoHighLevel"
    import inspect as _i
    assert "share_to_facebook_profile(day, entry, state)" in _i.getsource(sync) and "signin-needed" in _i.getsource(share_to_facebook_profile), "the profile share runs from sync, on the page post, and waits for sign-in"
    fsrc = _i.getsource(share_to_facebook_profile); assert "find_page_post" in fsrc and "verify_shared" in fsrc, "it shares the page post and checks the profile afterwards"
    rsrc = _i.getsource(run); assert 'stage_for(entry, yt_ok) == "socials"' in rsrc and rsrc.count("schedule_stage(") == 2, "both stages run the same day"
    t0 = dt.datetime(2026, 9, 10, 9, 0, tzinfo=LONDON)
    assert when_for("youtube", "full", 0, now=t0) == "2026-09-10T08:15:00Z", "the 06:00 slot has passed: 15 minutes from now, same morning"
    assert when_for("linkedin", "summary", 0, now=t0) == "2026-09-10T11:00:00Z", "socials keep their afternoon slot"
    assert when_for("linkedin", "summary", 0, now=t0, youtube_at="2026-09-10T13:00:00Z") == "2026-09-10T13:30:00Z", "never before the video is public + 30 min"
    assert youtube_at({"posts": {"youtube|a|full": {"clip": "full", "scheduled": "2026-09-10T08:15:00Z"}}}) == "2026-09-10T08:15:00Z" and youtube_at({}) is None
    rows = published_rows("9", {"posts": {"youtube|a|full": {"platform": "youtube", "clip": "full", "account": "Runpreneur", "status": "published", "published_at": "2026-09-10T08:15:00Z", "link": "https://youtu.be/x", "route": "api"}},
                                "podcast": {"status": "published", "link": "https://open.spotify.com/episode/y"}, "facebook_share": {"status": "shared", "post_url": "https://www.facebook.com/reel/1"}})
    assert published_rows("9", {"posts": {"y|a|lfmd": {"platform": "youtube", "clip": "lfmd", "status": "scheduled"}}})[0]["channel"] == "YouTube Short"
    assert [r["channel"] for r in rows] == ["YouTube full episode", "Spotify podcast", "Facebook profile (shared)"] and rows[0]["when"] == "2026-09-10T08:15:00Z"
    assert title_is_episode("Coping With Stress on Day 2,054 of My Running Streak | Runpreneur Episode 2054", 2054) and title_is_episode("Why 9 out of 10 | Runpreneur Ep1857/4292", 1857)
    assert not title_is_episode("How Excitement Kills Forecasting | Runpreneur Ep2053/5000", 2054), "the day before is not this episode"
    lst = [{"id": "AT0l-Ri5ZJ0", "title": "Coping With Stress on Day 2,054 | Runpreneur Episode 2054"}, {"id": "x", "title": "Ep2053"}]
    t0 = dt.datetime(2026, 9, 9, 14, 24, 17, tzinfo=dt.timezone.utc)
    assert youtube_link_from_channel(2054, "2026-09-09T14:24:17Z", now=t0 + dt.timedelta(minutes=10), listing=lst) is None, "inside the grace period GHL gets its chance"
    assert youtube_link_from_channel(2054, "2026-09-09T14:24:17Z", now=t0 + dt.timedelta(minutes=30), listing=lst) == "https://youtu.be/AT0l-Ri5ZJ0"
    assert youtube_link_from_channel(2055, "2026-09-09T14:24:17Z", now=t0 + dt.timedelta(minutes=30), listing=lst) is None, "not on the channel yet: no link"
    assert fit_bitrate_kbps(300 * 1024 * 1024, 600) is None, "fits already"
    kb = fit_bitrate_kbps(740 * 1024 * 1024, 639.3); assert 5000 < kb < 5700, kb   # 2054: 740 MB, 10.7 min -> about 5.3 Mbps video
    assert fit_bitrate_kbps(10 ** 10, 60) == 1500 or fit_bitrate_kbps(10 ** 10, 60) > 1500, "never below the floor"
    old = MODE_FILE
    import tempfile as _tf
    globals()["MODE_FILE"] = os.path.join(_tf.gettempdir(), "od-mode-test-%d" % os.getpid())
    assert mode() == "test", "no mode file means TEST, never live by accident"
    open(MODE_FILE, "w").write("LIVE\n"); assert mode() == "live"
    open(MODE_FILE, "w").write("anything else"); assert mode() == "test"; os.remove(MODE_FILE); globals()["MODE_FILE"] = old
    u = build_post("youtube", accts[5], spec, "d", "https://cdn/f.mp4", None, "x", "u1", 1, "T", privacy="unlisted")
    assert u["youtubePostDetails"]["privacyLevel"] == "unlisted"
    # brand guard (Kevin's ruling 2 Sep 2026: a test must refuse cross-brand output)
    od_accts = [{"id": "kp", "platform": "linkedin", "type": "profile", "active": True, "name": "Kevin Brittain"},
                {"id": "odp", "platform": "linkedin", "type": "page", "active": True, "name": "Operations Director"},
                {"id": "rp", "platform": "linkedin", "type": "page", "active": True, "name": "Runpreneur"},
                {"id": "tt", "platform": "tiktok", "type": "profile", "active": True, "name": "Kevin Brittain - Runpreneur"},
                {"id": "odfb", "platform": "facebook", "type": "page", "active": False, "name": "Operations Director"}]
    assert [a["id"] for a in allowed_accounts("Operations Director", "post", od_accts)] == ["odp"], "OD posts reach the OD page only; the expired FB page waits"
    od_accts[4]["active"] = True
    assert [a["id"] for a in allowed_accounts("Operations Director", "post", od_accts)] == ["odp", "odfb"]
    assert [a["id"] for a in allowed_accounts("Runpreneur", "bridge", od_accts)] == ["kp"], "a bridge post goes to Kevin's profile only"
    assert brand_of({"Category": "Operations Director"}) == "Operations Director" and brand_of({"Category": "Runpreneur"}) == "Runpreneur"
    for bad in ({"Category": "Social Housing Group"}, {}, None):
        try: brand_of(bad); raise AssertionError("brand_of accepted %r" % (bad,))
        except SystemExit: pass
    try: assert_brand({"Category": "Runpreneur", "Content Name": "Episode 1 Full Episode"}, "Operations Director"); raise AssertionError("cross-brand accepted")
    except SystemExit as ex: assert "refused by the Operations Director publisher" in str(ex)
    try: allowed_accounts("Operations Director", "episode", od_accts); raise AssertionError("OD has no episode lane")
    except SystemExit: pass
    assert BRANDS["Operations Director"]["key"] != BRANDS["Runpreneur"]["key"], "two keys, never shared"
    tp = build_text_post(od_accts[1], "hello", "2026-09-07T07:00:00Z", "u1", "https://cdn/c.png")
    assert tp["media"] == [{"url": "https://cdn/c.png", "type": "image/png"}] and tp["type"] == "post" and tp["scheduleDate"] == "2026-09-07T07:00:00Z"
    fbp = build_text_post(od_accts[4], "hello", "x", "u1", status="draft"); assert fbp["facebookPostDetails"] == {"type": "post"} and "media" not in fbp and "scheduleDate" not in fbp
    print(json.dumps({"checks": 46, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("--day", type=int, default=0); ap.add_argument("--limit", type=int, default=3); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "run": run(dry_run=a.dry_run, limit=a.limit)
    elif a.mode == "plan":
        recs = bundle(a.day); am = account_map(accounts()); entry = load_state().get(str(a.day), {})
        print("connected:", {p: [x["name"] for x in v] for p, v in am.items()}); print("stage:", stage_for(entry, "youtube" in am))
        for stage in (1, 2):
            e2 = dict(entry); e2.setdefault("youtube_link", "https://youtu.be/PENDING")
            schedule_stage(a.day, e2, recs, am, stage, dry_run=True)
    elif a.mode == "sync": sync()
    elif a.mode == "published": published(a.day)
    elif a.mode == "report": report()
    elif a.mode == "youtube-link": youtube_link()
    else: raise SystemExit("usage: publish.py run [--dry-run] [--limit N] | plan --day N | sync | report | youtube-link | selftest")
