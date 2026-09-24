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
import youtube_ads  # noqa: E402

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


def is_png(path):
    try:
        with open(path, "rb") as fh: return fh.read(8) == b"\x89PNG\r\n\x1a\n"
    except OSError:
        return False


def media_for(day, entry, kinds):
    files = episode_files(day); media = entry.setdefault("media", {})
    for k in kinds:
        if media.get(k): continue
        local = fetch_readable(day, k)
        if not os.path.exists(local):
            if k in ("thumb", "podcast"): continue
            raise SystemExit("episode %d: %s is not in the edited folder (%s)" % (day, k, files[k]))
        if k == "thumb" and not is_png(local):
            # 16 Sep 2026: the Drive folder handed back its sign-in page for 2057's and 2058's thumbnails; it was uploaded
            # and became the blog's header image. A thumbnail is uploaded only when the bytes are really a PNG.
            print("episode %d: thumbnail at %s is not a PNG; not uploaded" % (day, local), file=sys.stderr); continue
        src = fit_for_upload(local)
        media[k] = upload_media(src)
        if src != local and os.path.exists(src): os.remove(src)
        print("episode %d: uploaded %s" % (day, k))
    return media


def bundle(day):
    return {ctype: pc.find_by_name(pc.record_name(day, ctype)) for ctype in pc.TYPES}


def fill_learnings(day, entry, recs, acct_map, stage, ledger, gaps, state, save):
    """A Learnings clip that exists but was never posted (1841 and 2060's rebuilds, 17 Sep 2026: an episode already
    out was "done", so a clip rebuilt afterwards never reached the socials or the YouTube Short). Stage 2 creates only
    the posts that are missing; tried at most REPLACE_ATTEMPTS times, and said each time. Called for a Published
    record as well as a publishable one (21 Sep 2026). Returns True when it scheduled."""
    s_now = section_status(entry)
    lf_missing = bool(output_link(day, "lfmd", ledger)) and "missing" in (s_now["Learnings clips"], s_now["YouTube Short"])
    # the teasers too (24 Sep 2026): 2069's Short copy was never written, so its teaser posts were never made, and a
    # Published record only ever came back here for its Learnings clip
    te_missing = bool(output_link(day, "summary", ledger)) and s_now["Teaser clips"] == "missing" \
        and bool((((recs or {}).get("Short Form Video") or {}).get("fields") or {}).get("TikTok Copy"))   # no copy: nothing to post, no attempt spent
    if not (stage == "done" and entry.get("youtube_link") and (lf_missing or te_missing) and not ahead_of_order(day, gaps, state)
            and int(entry.get("fill_attempts") or 0) < REPLACE_ATTEMPTS):
        return False
    entry["fill_attempts"] = int(entry.get("fill_attempts") or 0) + 1; save()
    n_fill = schedule_stage(day, entry, recs, acct_map, 2, False, index=0, save=save)
    print("episode %d: missing %s posts scheduled (%d), attempt %d" % (day, " and ".join(x for x, y in (("Learnings", lf_missing), ("teaser", te_missing)) if y), n_fill or 0, entry["fill_attempts"]))
    return True


def approved_days():
    st = approval.load_state()
    return sorted(int(d) for d, e in st.items() if e.get("verdict") == "approved")


def create_post(body, brand="Runpreneur"):
    _, loc, _ = _cfg(brand)
    r = ghl("POST", "/social-media-posting/%s/posts" % loc, body, brand=brand)
    post = (r.get("results") or r).get("post") or r
    return post.get("_id") or post.get("id")


def now_utc():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def definitely_not_created(ex):
    """True only when the platform answered with a refusal (HTTP 4xx): then nothing exists and the post may be
    tried again. A timeout, a dropped connection or a 5xx may have created it, so those are NEVER retried."""
    return isinstance(ex, SystemExit) and bool(re.search(r"-> 4\d\d:", str(ex)))


def schedule_stage(day, entry, recs, acct_map, stage, dry_run=False, index=0, save=None):
    """Posts one stage for one episode, AT MOST ONCE per channel (Kevin, 13 Sep 2026: 2195 went out four times).
    Each post is written to the state as 'creating' and saved BEFORE the call that creates it, then saved again
    with its id. A run that dies half way leaves 'creating' behind, and the next run never posts that channel
    again: it adopts the video it can find, or reports the post as unconfirmed for a human to check."""
    save = save or (lambda: None)
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
                have = entry.get("posts", {}).get(key)
                if have:
                    if have.get("status") in ("creating", "unconfirmed"):
                        adopted = adopt_youtube(entry, key, have) if platform == "youtube" else False
                        if not adopted:
                            have["status"] = "unconfirmed"
                            print("episode %d: %s %s was being created when a run stopped; NOT posting again (check it once)" % (day, spec["clip"], platform), file=sys.stderr)
                    continue
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
            entry.setdefault("posts", {})[key] = {"status": "creating", "platform": "youtube", "clip": spec["clip"], "account": account["name"],
                                                  "title": title or "", "started": now_utc(), "route": "api", "mode": m}
            save()
            try:
                post = youtube_direct(day, spec["clip"], title, text, when, test)
            except Exception as ex:
                if adopt_youtube(entry, key, entry["posts"][key]):
                    save(); print("episode %d: the %s upload raised (%s) but the video is on the channel; adopted it" % (day, spec["clip"], str(ex)[-120:]), file=sys.stderr)
                    continue
                entry["posts"].pop(key, None); save()   # nothing is on the channel: safe to try again next run
                # Not just SystemExit (finding 20260911-daily-ops-phase-2-523): a PermissionError reading the Drive
                # file, or youtube_api's own RuntimeError, used to escape here and end the whole run, so no other
                # episode or platform was published that hour. One clip failing is one line, not a traceback.
                why = str(ex)[-200:]
                if isinstance(ex, PermissionError):
                    why = ("macOS refused this scheduled job read access to %s. The launchd python needs Full Disk "
                           "Access for the Google Drive folder (Kevin's call), or the file must be staged locally"
                           % os.path.basename(getattr(ex, "filename", None) or "the Drive file"))
                print("episode %d: direct YouTube upload of %s FAILED (%s); GoHighLevel will carry it" % (day, spec["clip"], why), file=sys.stderr)
            else:
                entry.setdefault("posts", {})[key] = post; save()
                if spec["clip"] == "full" and not entry.get("youtube_link"): entry["youtube_link"] = post["link"]; save()
                print("episode %d [%s]: %s youtube -> channel %s %s (%s)" % (day, m.upper(), spec["clip"], post["status"], when, post["link"]))
                continue
        # Test mode: YouTube still goes up (unlisted, so the link exists) but every social post is a DRAFT.
        status = "scheduled" if (not test or platform == "youtube") else "draft"
        body = build_post(platform, account, spec, text, media[spec["clip"]], media.get("thumb"), when, user, day, title,
                          status=status, privacy="unlisted" if test else "public")
        entry.setdefault("posts", {})[key] = {"status": "creating", "platform": platform, "account": account["name"], "clip": spec["clip"], "started": now_utc(), "mode": m}
        save()
        try:
            pid = create_post(body)
        except Exception as ex:
            if definitely_not_created(ex):
                entry["posts"].pop(key, None); save()
                print("episode %d: %s %s refused by the platform (%s); will try again next run" % (day, spec["clip"], platform, str(ex)[-160:]), file=sys.stderr)
            else:
                entry["posts"][key]["status"] = "unconfirmed"; entry["posts"][key]["error"] = str(ex)[-200:]; save()
                print("episode %d: %s %s may or may not have posted (%s); NOT retrying, check it once" % (day, spec["clip"], platform, str(ex)[-160:]), file=sys.stderr)
            continue
        entry["posts"][key] = {"id": pid, "platform": platform, "account": account["name"], "clip": spec["clip"], "scheduled": when if status == "scheduled" else None,
                               "status": status, "mode": m}
        save()
        print("episode %d [%s]: %s %s -> %s %s %s (post %s)" % (day, m.upper(), spec["clip"], platform, account["name"], status, when if status == "scheduled" else "", pid))
    status = STATUS_YT if stage == 1 else STATUS_SOCIALS
    what = ("full episode to YouTube%s" % (" (UNLISTED, test mode)" if test else "")) if stage == 1 else ("Summary and Learnings clips to the socials%s" % (" as DRAFTS (test mode)" if test else ""))
    fields = {"Record Status": status}
    if stage == 1:
        yt_title = youtube_parts(ff.get("YouTube Copy"), day)[0]
        fields["Video Title"] = yt_title; fields["Target Publish Date"] = day_london.isoformat()
    fields["Notes"] = approval.append_note(full, "%s: %s." % (dt.date.today().isoformat(), what))
    try: watch._airtable("PATCH", watch.API + "/" + full["id"], {"fields": fields})
    except Exception as ex: print("episode %d: record note not written (%s); the posts are saved" % (day, str(ex)[-120:]), file=sys.stderr)
    return len(todo)


def adopt_youtube(entry, key, have):
    """A YouTube post left as 'creating': if the channel already holds a video with that title, record it and
    return True, so the retry never uploads a second copy."""
    try:
        import youtube_api
        broken = {b.get("id") for b in entry.get("broken_uploads", [])}
        ups = [u for u in youtube_api.recent_uploads() if u["id"] not in broken]   # never re-adopt a video already judged broken
        vid = youtube_api.find_upload(have.get("title") or "", ups)
    except Exception as ex:
        print("youtube: could not read the channel to check for a half-finished upload (%s)" % str(ex)[-120:], file=sys.stderr)
        return False
    if not vid: return False
    entry["posts"][key] = dict(have, id=vid, link="https://youtu.be/" + vid, status="scheduled", adopted=now_utc())
    if have.get("clip") == "full" and not entry.get("youtube_link"): entry["youtube_link"] = "https://youtu.be/" + vid
    return True


SPOTIFY_MAX_ATTEMPTS = 3


def finish_extras(day, entry, recs, test, save):
    """The blog article, the podcast audio and Spotify, once each, after the socials. Each has its own status and is
    marked BEFORE the call that publishes it, so a run that dies never repeats it (13 Sep 2026: 2195's blog went out
    four times), and a failure in one is recorded and retried next hour without touching anything else."""
    full = recs["Long Form Video"]; ff = full["fields"]; m = mode(); done = []
    if not entry.get("youtube_link"): return done
    b = entry.setdefault("blog", {})
    if not (b.get("url") or b.get("id")) and b.get("status") not in ("creating", "unconfirmed"):
        b.update({"status": "creating", "started": now_utc()}); save()
        try:
            import blog
            media = media_for(day, entry, ["thumb"])
            pid, url = blog.publish_blog(day, full, entry, media.get("thumb"), entry["youtube_link"], test)
            entry["blog"].update({"status": "DRAFT" if test else "PUBLISHED"}); save()
            done.append("blog article %s" % url)
            print("episode %d [%s]: blog %s -> %s" % (day, m.upper(), "draft" if test else "published", url))
            try: watch._airtable("PATCH", watch.API + "/" + full["id"], {"fields": {"Blog Link": url}})
            except Exception as ex: print("episode %d: Blog Link not written (%s)" % (day, str(ex)[-100:]), file=sys.stderr)
        except Exception as ex:
            if definitely_not_created(ex) or "has no Blog Copy" in str(ex) or "REFUSED" in str(ex):
                entry["blog"] = {"status": "failed", "error": str(ex)[-200:]}
            else:
                entry["blog"].update({"status": "unconfirmed", "error": str(ex)[-200:]})
            save(); print("episode %d: blog not published (%s)" % (day, str(ex)[-160:]), file=sys.stderr)
    elif b.get("status") == "failed":
        entry["blog"] = {}; save()                    # a refused article is tried again next hour
    try:
        import blog
        if blog.ensure_reading_time(entry): print("episode %d: blog reading time set (%s min)" % (day, entry["blog"]["read_time"]))
        save()
    except (Exception, SystemExit) as ex:
        print("episode %d: blog reading time not set yet (%s); tried next run" % (day, str(ex)[-120:]), file=sys.stderr)
    try:
        media = media_for(day, entry, ["podcast"])
        if media.get("podcast"): entry.setdefault("podcast", {})["audio_url"] = media["podcast"]; save()
    except (Exception, SystemExit) as ex:
        # upload_media raises SystemExit, which `except Exception` never catches: on 15 Sep 2026 1841's mp3 upload
        # killed the whole hourly run before 2057 could be reached. The mp3 is not what Spotify gets (PODCAST_FORMAT
        # is video), so a failed upload is noted on the entry and the run carries on.
        entry.setdefault("podcast", {})["audio_error"] = "%s (%s)" % (str(ex)[-160:], now_utc()); save()
        print("episode %d: podcast audio not uploaded (%s)" % (day, str(ex)[-120:]), file=sys.stderr)
    pod = entry.setdefault("podcast", {})
    if pod.get("status") == "failed" and int(pod.get("upload_attempts") or 0) >= SPOTIFY_MAX_ATTEMPTS:
        # 23-24 Sep 2026: 2070 failed hourly for a day and every attempt left an "Untitled" draft on Spotify. A person looks
        # after three; set the status back to failed (and the count to 0) to try again.
        pod.update({"status": "held", "note": "held after %d failed uploads (each leaves an Untitled draft on Spotify): %s" % (SPOTIFY_MAX_ATTEMPTS, pod.get("error", ""))}); save()
        print("episode %d: podcast HELD after %d failed Spotify uploads; a person looks before the next" % (day, SPOTIFY_MAX_ATTEMPTS), file=sys.stderr)
    if pod.get("status") in (None, "", "failed"):
        try:
            import spotify
            files = episode_files(day)
            upload = fetch_readable(day, "podcast") if spotify.PODCAST_FORMAT == "audio" else fetch_readable(day, "full")
            if not os.path.exists(upload): upload = full_from_drive(day) or upload
            thumb_local = fetch_readable(day, "thumb")
            if os.path.exists(upload) and not is_png(thumb_local):
                # every episode on Spotify carries its thumbnail (Kevin, 17 Sep 2026): no PNG, no upload; tried next run
                print("episode %d: podcast held, the thumbnail is not a readable PNG yet" % day, file=sys.stderr)
                return done
            if os.path.exists(upload):
                tried_before = os.path.exists(os.path.join(os.path.dirname(STATE), "spotify_plan_%d.json" % day))
                plan_path, ptitle = spotify.write_plan(day, upload, ff.get("Podcast Copy"), entry["youtube_link"], test, os.path.dirname(STATE), thumb=thumb_local)
                if tried_before and not test:
                    # an earlier attempt left its plan (2056 crashed mid-run on 11 Sep 2026 and its state was rebuilt
                    # without the podcast): look at Spotify before uploading, so a retry never publishes a second copy
                    seen, why = spotify.verify_published(ptitle, tries=1)
                    if seen in ("published", "processing"):
                        pod.update({"plan": plan_path, "title": ptitle, "status": seen, "note": "found on Spotify before a retry",
                                    "started": now_utc()}); save()   # starts the three days the sync asks for its link (review, 21 Sep 2026)
                        print("episode %d: already on Spotify (%s); not uploaded again" % (day, seen)); return done
                    if "not readable" in str(why):
                        # an unreadable list (signed out, blank page) is not proof of absence: wait for the next hour
                        pod.update({"status": "failed", "error": "retry held: the Spotify episodes list could not be read"}); save()
                        print("episode %d: Spotify list unreadable, podcast retry held until next run" % day, file=sys.stderr); return done
                pod.update({"plan": plan_path, "title": ptitle, "status": "uploading", "started": now_utc(),
                            "upload_attempts": int(pod.get("upload_attempts") or 0) + (0 if test else 1)}); save()
                done.append(run_spotify(day, card_task(day, full), plan_path, ptitle, test, pod)); save()
        except (Exception, SystemExit) as ex:
            pod.update({"status": "failed", "error": str(ex)[-200:]}); save()
            print("episode %d: Spotify step failed (%s); retried next run" % (day, str(ex)[-160:]), file=sys.stderr)
    elif pod.get("status") == "uploading":
        # a run died during the upload: look before trying again, so a published episode is never uploaded twice
        try:
            import spotify
            status, _ = spotify.verify_published(pod.get("title") or "", tries=1)
            pod["status"] = status if status in ("published", "processing") else "failed"; save()
        except (Exception, SystemExit) as ex:
            print("episode %d: could not check Spotify after a stopped upload (%s)" % (day, str(ex)[-120:]), file=sys.stderr)
    return done


PUBLISH_CACHE = os.path.expanduser("~/knowledge-os/logs/content-engine/publish-cache")


def readable(path, timeout=30):
    """The file really reads here, not merely listed. The Drive mount lists an upload minutes to hours before it can
    deliver the bytes, and a launchd job can be refused the folder outright (finding 20260911-daily-ops-phase-2-523)."""
    if not path or not os.path.exists(path) or os.path.getsize(path) == 0: return False
    try:
        r = subprocess.run(["head", "-c", "65536", path], capture_output=True, timeout=timeout)
        return r.returncode == 0 and len(r.stdout) > 0
    except (subprocess.TimeoutExpired, OSError):
        return False


def output_link(day, kind, ledger=None):
    ledger = ledger if ledger is not None else watch.load_ledger()
    role = "teaser" if kind == "summary" else "episode"
    for v in ledger.values():
        if v.get("episode") == day and v.get("role") == role and (v.get("outputs") or {}).get(kind):
            return v["outputs"][kind]
    return None


def fetch_readable(day, kind, ledger=None, download=None):
    """A local path to this episode's `kind` output. When the render recorded a Drive link, the file is fetched ONCE by
    the Drive API and that copy is used: the Drive FOLDER is never read by a scheduled job for these files. 16-17 Sep
    2026: the podcast copy, the thumbnail and the output gate all failed through the folder, and a quick read test is
    not enough (2057's full read its first 64 KB and then failed to copy, hourly, all day). Episodes rendered before
    the render recorded links still use the folder."""
    path = episode_files(day)[kind]
    m = re.search(r"/d/([\w-]+)", output_link(day, kind, ledger) or "")
    if not m: return path
    dest = os.path.join(PUBLISH_CACHE, str(day), os.path.basename(path))
    if not (os.path.exists(dest) and os.path.getsize(dest) > 0):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if download is None:
            import drive_api; download = drive_api.download
        download(m.group(1), dest + ".part")
        os.replace(dest + ".part", dest)                  # only a whole file gets the real name
        print("episode %d: %s fetched from Drive (%.0f MB)" % (day, kind, os.path.getsize(dest) / 1e6))
    return dest


def full_from_drive(day, work=None):
    """The full episode fetched from Drive by the API when the mounted folder does not show it (1841, 15 Sep 2026:
    the render uploaded it on 10 Sep, the mount listed Ericamae's files only, so the podcast never went out).
    Returns the local path, or None when the ledger holds no Drive link for the day."""
    import drive_api
    link = next((v["outputs"]["full"] for v in watch.load_ledger().values()
                 if v.get("episode") == day and v.get("role") == "episode" and (v.get("outputs") or {}).get("full")), None)
    m = re.search(r"/d/([\w-]+)", link or "")
    if not m: return None
    dest = os.path.join(work or watch.WORK, "Episode_%d_Full_Episode_drive.mp4" % day)   # its own name: a redo render writes the plain one
    if not os.path.exists(dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        drive_api.download(m.group(1), dest + ".part")            # resumes a stopped copy; only a whole file gets the real name
        os.replace(dest + ".part", dest)
        print("episode %d: full episode fetched from Drive for the podcast (%.0f MB)" % (day, os.path.getsize(dest) / 1e6))
    return dest


def youtube_direct_ready():
    """The API route exists once Kevin's consent token and the app's client file are on disk (10 Sep 2026)."""
    import youtube_api
    return os.path.exists(youtube_api.TOKEN_FILE) and os.path.exists(youtube_api.CLIENT_FILE)


def youtube_direct(day, clip, title, text, when, test):
    """Upload the clean render (no burnt-in captions) with its caption file and the thumbnail. Live: private now,
    public at the slot (YouTube's own scheduler). Test: unlisted at once. Returns the post record for the state."""
    import youtube_api
    path = fetch_readable(day, clip + "_yt")
    if not os.path.exists(path): path = fetch_readable(day, clip)
    srt = fetch_readable(day, clip + "_srt"); srt = srt if os.path.exists(srt) else None
    thumb = fetch_readable(day, "thumb") if clip == "full" else None
    thumb = thumb if thumb and os.path.exists(thumb) else None
    vid = youtube_api.upload(path, title or ("Diary of a Runpreneur, Day %d" % day), text, privacy="unlisted" if test else "private",
                             publish_at=None if test else when, thumbnail=None, srt=None)
    link = "https://youtu.be/" + vid
    # After the video exists, a failed thumbnail or caption call must never lose it (it used to raise out of upload()
    # with the video on the channel and no id recorded). Each is recorded, and sync retries a missing thumbnail.
    extras = {"thumb": False, "captions": False}
    if thumb:
        try: youtube_api.set_thumbnail(vid, thumb); extras["thumb"] = True
        except Exception as ex: extras["thumb_error"] = str(ex)[-200:]; print("episode %d: thumbnail not set on %s (%s); retried by sync" % (day, vid, str(ex)[-120:]), file=sys.stderr)
    if srt:
        try: youtube_api.add_captions(vid, srt); extras["captions"] = True
        except Exception as ex: extras["captions_error"] = str(ex)[-200:]; print("episode %d: captions not added on %s (%s)" % (day, vid, str(ex)[-120:]), file=sys.stderr)
    return dict({"id": vid, "platform": "youtube", "route": "api", "account": "Runpreneur", "clip": clip, "scheduled": None if test else when,
                 "status": "published" if test else "scheduled", "link": link, "mode": mode(), "file": os.path.basename(path)}, **extras)


def card_task(day, full):
    """The APPROVAL CARD's task id for this episode, which is what the browser lane checks before it presses
    Publish. Until 14 Sep 2026 this passed the Content Machine record id instead, so agent-dispatch read no
    Approval Outcome on it and every automatic Spotify publish was refused ("task ... is not approved"):
    2054 went out by hand, 2195, 2194 and 2196 all failed the same way while their cards sat Approved."""
    e = approval.load_state().get(str(day)) or {}
    tid = e.get("task")
    if not tid:
        print("episode %d: no approval card on record, so Spotify cannot prove Kevin's yes; using the episode record and expecting a refusal" % day, file=sys.stderr)
        return full["id"]
    return tid


def run_spotify(day, task_id, plan_path, title, test, pod):
    """Runs the Spotify plan through the browser lane right after the socials (9 Sep 2026, first automatic
    episode was 2054 by hand). Live: `commit`, which re-reads the approval itself, presses Publish and
    then checks the episodes list; a video shows as Draft for a few minutes while Spotify processes it,
    so 'processing' is recorded and the public link is filled in by sync. Test: `prepare` stops at Review."""
    import spotify
    shot = os.path.join(os.path.dirname(STATE), "spotify_%d_%s.png" % (day, "review" if test else "published"))
    try:
        spotify.run_plan(plan_path, task_id, test, shot)
    except Exception as ex:          # not just SystemExit: a missing node or a timeout ended whole runs (10 Sep 2026)
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


MONETISE_RECHECK_HOURS = 6
GHL_SLOT_GRACE_MIN = 60   # a GHL post still 'scheduled' this long after its slot, with no failure, went out


MONETISED = ("On", "Sharing")     # Sharing: ads run, revenue split with a copyright claimant; nothing more to switch
MIDROLL_SETTLED = ("on", "not-eligible")   # not-eligible is an answer: under 8 minutes YouTube allows no mid-roll
NO_VIDEO_ID = "no-video-id"


def _recheck_due(stamp):
    if not stamp: return True
    try: return dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(stamp.replace("Z", "+00:00")) >= dt.timedelta(hours=MONETISE_RECHECK_HOURS)
    except ValueError: return True


def monetise_long_video(day, entry):
    """EVERY YouTube upload of the episode switched to earn: the long episode's "Watch page ads" and the Short's
    "Shorts Feed ads" (Kevin, 17 Sep 2026: "all of my YouTube videos, full length and Shorts, monetised ... as standard
    for everything we publish on YouTube"; the channel's earnings go to the fundraising). Long episodes went out Off
    before 13 Sep (Ericamae). The first switch asks for YouTube's content rating, which is Kevin's declaration: answered
    only for an approved card, otherwise recorded as 'needs-rating' and listed in the morning report.

    Then the ad in the MIDDLE. Kevin, 20 Sep 2026: the master switch read On everywhere and the channel still earned
    almost nothing on the episodes, because mid-roll ads were off on 817 of the 888 videos over 8 minutes. The master
    switch alone buys a pre-roll; mid-roll is the bulk of long-form revenue, so it is set here as part of publishing,
    never as a thing to remember afterwards.

    The post is matched by its VIDEO ID, not by its upload route. The old `route == "api"` filter silently stepped
    over every GoHighLevel upload, so 2054's episode, 2054's Short and 2195's episode were never checked once."""
    posts = [p for k, p in (entry.get("posts") or {}).items()
             if k.startswith("youtube|") and p.get("clip") in ("full", "lfmd") and p.get("status") == "published"]
    changed = False
    for p in posts:
        what = "Short" if p.get("clip") == "lfmd" else "episode"
        vid = youtube_ads.video_id(entry, p)
        if not vid:
            # never skipped in silence: it shows in the morning report until the link appears or Kevin looks
            if p.get("monetisation") != NO_VIDEO_ID:
                p["monetisation"] = NO_VIDEO_ID; p["monetisation_checked"] = now_utc(); changed = True
                print("episode %s: YouTube %s has no video id to check (uploaded through GoHighLevel, no link recorded)" % (day, what), file=sys.stderr)
            continue
        if p.get("monetisation") not in MONETISED and _recheck_due(p.get("monetisation_checked")):
            import youtube_studio           # "Checking" (YouTube reviewing the rating) is re-read until it says On
            approved = (approval.load_state().get(str(day)) or {}).get("verdict") == "approved"
            res = youtube_studio.monetise(vid, certify_none=approved)   # approving the card is Kevin's content rating (13 Sep 2026)
            p["monetisation"] = res.get("status") or "unknown"; p["monetisation_checked"] = now_utc(); changed = True
            if res.get("error"): p["monetisation_error"] = res["error"][-200:]
            else: p.pop("monetisation_error", None)
            print("episode %s: YouTube %s monetisation %s" % (day, what, p["monetisation"]))
        # mid-roll only once the master switch is On: the checkbox does nothing on a video that is not earning
        if p.get("clip") == "full" and p.get("monetisation") in MONETISED \
                and p.get("midroll") not in MIDROLL_SETTLED and _recheck_due(p.get("midroll_checked")):
            res = youtube_ads.midroll([vid])
            p["midroll"] = res.get(vid) or "failed"; p["midroll_checked"] = now_utc(); changed = True
            print("episode %s: YouTube episode mid-roll ads %s" % (day, p["midroll"]))
    return changed


# The Runpreneur page gets TWO posts per episode and Kevin's profile was only ever given one of them
# (Kevin, 20 Sep 2026: "you haven't been sharing the posts from the Runpreneur Facebook page to my personal
# profile"). Nothing was wrong with the finder: share_to_facebook_profile simply only ever looked at the
# summary clip. Both posts publish as reels on the page (GoHighLevel sends the Learnings clip as a "post",
# but Facebook renders a vertical video as a reel, checked on the live page 20 Sep 2026), so both are found
# on the same /reels list. Each share keeps its own state, and the summary keeps the original key so the
# twelve shares already on record are not re-pressed.
FB_SHARES = {
    "summary": {"key": "facebook_share", "record": "Short Form Video", "field": "Facebook Reels Copy"},
    "lfmd": {"key": "facebook_share_lfmd", "record": "Learnings From My Diary", "field": "Facebook Post Copy"},
}
# Catching up is PACED. When the second share was switched on, twelve past episodes were missing their
# Learnings share; pressing all twelve in one hourly run would put twelve posts on Kevin's personal
# profile in a few minutes, which reads as a dump and costs reach on the new ones (his call, 20 Sep 2026).
# Today's episode is never held. Anything older than a day and a half waits its turn.
FB_CATCHUP_PER_DAY = 2
FB_CATCHUP_AFTER_HOURS = 36


def catchups_pressed_today(state, now=None):
    """How many CATCH-UP shares the robot has pressed today, across every episode and both clips.

    Counting every share instead was a bug that would have frozen the queue for good (found by Kevin,
    20 Sep 2026): today's episode presses two shares of its own, which filled a budget of two, so a
    catch-up could never have fired again and the ten waiting Learnings posts would have sat there
    for ever. Only a share that was itself a catch-up spends the catch-up budget."""
    today = (now or dt.datetime.now(dt.timezone.utc)).astimezone(LONDON).date()
    n = 0
    for e in state.values():
        if not isinstance(e, dict): continue
        for spec in FB_SHARES.values():
            fb = e.get(spec["key"]) or {}
            if not fb.get("catchup"): continue
            at = fb.get("shared_at")
            if not at: continue
            try:
                if dt.datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone(LONDON).date() == today: n += 1
            except ValueError: pass
    return n


def is_catchup(post, now=None):
    """A page post old enough that sharing it is catching up, not publishing today's episode."""
    mins = minutes_since(post.get("published_at") or post.get("scheduled"), now or dt.datetime.now(dt.timezone.utc))
    return mins is not None and mins > FB_CATCHUP_AFTER_HOURS * 60


def share_to_facebook_profile(day, entry, state, clip="summary"):
    """Kevin's own profile gets the PAGE's post, shared (Kevin, 10 Sep 2026: "it should just be shared from the
    Facebook page to the Facebook profile"), once that page post is live. The page post URL is read off the page
    itself, because GoHighLevel never returns one. Signed out, or the post not up yet: recorded, retried hourly."""
    import facebook_share
    spec = FB_SHARES[clip]
    fb = entry.setdefault(spec["key"], {})
    if fb.get("status") in ("shared", "reviewed", "failed"): return False      # failed is final: pressed twice, never a third time (review, 15 Sep 2026)
    if fb.get("status") == "unconfirmed" and fb.get("post_url"):
        # 15 Sep 2026: 'unconfirmed' was final, so a share the checker missed stayed missing for ever. Look again;
        # a share that is truly absent is pressed once more, and only once.
        if facebook_share.verify_shared(fb["post_url"]):
            fb["status"] = "shared"; print("episode %s: the %s profile share is there after all" % (day, clip)); return True
        if fb.get("reshared_at"):
            fb["status"] = "failed"; fb["error"] = "shared twice by the robot and still not on the profile"; return True
        fb["status"] = "page-post-not-found"; fb["reshared_at"] = now_utc()      # falls through to one more share below
        print("episode %s: the %s profile share is not on the profile; sharing once more" % (day, clip), file=sys.stderr)
    if fb.get("status") == "sharing":
        # a run died while pressing Share: check the profile before ever sharing again
        fb["status"] = "shared" if fb.get("post_url") and facebook_share.verify_shared(fb["post_url"]) else "unconfirmed"
        return True
    page = [p for k, p in (entry.get("posts") or {}).items() if p.get("platform") == "facebook" and p.get("clip") == clip]
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
    copy = ((recs.get(spec["record"]) or {}).get("fields", {}).get(spec["field"]) or "").strip()
    if pc.session_text_in(copy):
        fb["status"] = "copy-blocked"
        print("episode %s: Facebook profile share NOT made: session text in %s (remove it: platform_copy.py clean --day %s)" % (day, spec["field"], day), file=sys.stderr)
        return True
    # a catch-up looks further down the reels list: 2054, 2055, 2056 and 2195 sat beyond a week of
    # two-posts-a-day and read "not on the page yet" every run (20 Sep 2026)
    depth = facebook_share.SCAN_POSTS_CATCHUP if is_catchup(post) else facebook_share.SCAN_POSTS
    url = fb.get("post_url") or facebook_share.find_page_post(copy, day=int(day), scan=depth)
    if not url:
        fb["status"] = "page-post-not-found"
        print("episode %s: the %s page post is not on the Facebook page yet; looking again next run" % (day, clip))
        return True
    fb["post_url"] = url
    catchup = is_catchup(post)
    if catchup:
        pressed = catchups_pressed_today(state)
        if pressed >= FB_CATCHUP_PER_DAY:
            fb["status"] = "queued"      # listed as pending, never hidden; it goes out tomorrow
            print("episode %s: the %s share waits its turn (%d catch-up share(s) already today)" % (day, clip, pressed))
            return True
    fb["catchup"] = catchup              # only a catch-up spends the catch-up budget
    test = mode() == "test"
    plan_path, text = facebook_share.write_plan(int(day), url, copy, entry.get("youtube_link", ""), test, os.path.dirname(STATE), clip=clip)
    shot = os.path.join(os.path.dirname(STATE), "facebook_share_%s%s.png" % (day, "" if clip == "summary" else "_" + clip))
    task = (approval.load_state().get(str(day)) or {}).get("task", "")
    fb.update({"plan": plan_path, "text": text, "status": "sharing", "started": now_utc()})
    save_state(state)                                  # on disk BEFORE Share is pressed, so a dead run never shares twice
    try:
        facebook_share.run_plan(plan_path, task, test, shot)
    except Exception as ex:
        fb["status"] = "failed"; fb["error"] = str(ex)[-300:]
        print("episode %s: Facebook %s profile share FAILED: %s" % (day, clip, str(ex)[-200:]), file=sys.stderr)
        return True
    fb.update({"status": "reviewed" if test else "shared", "shot": shot,
               "shared_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    if not test and not facebook_share.verify_shared(url):
        fb["status"] = "unconfirmed"
        print("episode %s: pressed Share on the %s post but it is not on the profile yet" % (day, clip), file=sys.stderr)
    else:
        print("episode %s: the %s page post is shared to Kevin's profile (%s)" % (day, clip, url))
    return True


CURSOR_KEY = "_cursor"


def cursor(state):
    """The last day put on YouTube, in order. Starts one below Kevin's takeover day (2053 when start_day is 2054)."""
    if CURSOR_KEY in state: return int(state[CURSOR_KEY])
    sd = watch.start_day()
    return (sd - 1) if sd else 0


def day_was_recorded(day, ledger):
    """A clip of the day exists, rendered (its episode) or still waiting (its ledger day). 24 Sep 2026: 2071 was set back to
    new for a re-render, lost its episode number, and the order check read it, and every unrendered day after it up to
    2193, as never recorded and stepped over them all. A day with footage is held, never skipped."""
    return any(v.get("episode") == day or (v.get("day") == day and v.get("status") != "broll") for v in ledger.values())   # B-roll alone is not an episode


def next_publishable(state, ledger, approved):
    """Strict order (Kevin, 8 Sep 2026: keep the day numbers in order): only cursor+1 may go to YouTube. A day
    that was never recorded (no clip in the ledger while later days exist) is stepped over and noted; a day
    that exists but is not yet approved holds everything behind it. Returns (day or None, reason)."""
    c = cursor(state)
    later = max((v.get("episode") or 0 for v in ledger.values()), default=0)
    while True:
        nxt = c + 1
        if (state.get(str(nxt)) or {}).get("youtube_link"):
            # already live (2194-2196 went out early on 10 and 14 Sep 2026): the order steps over it, or the day after
            # it would wait for a YouTube upload that never happens again
            state[CURSOR_KEY] = nxt; c = nxt; continue
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


HOLD_FILE = os.path.expanduser("~/.config/od/content_engine_hold_days")


def held_days(path=None):
    """Approved days that must not publish yet, one day number per line with an optional reason after it (Kevin, 17 Sep
    2026: 2060 approved but its Learnings clip was missed; "reinstate that prior to publishing"). A held day holds the
    order behind it too. The Learnings rebuild removes the day when the clip exists."""
    out = {}
    try:
        for line in open(path or HOLD_FILE):
            m = re.match(r"\s*(\d{3,4})\b\s*(.*)", line)
            if m: out[int(m.group(1))] = m.group(2).strip()
    except OSError:
        pass
    return out


def ahead_of_order(day, gaps, state):
    """Every stage after YouTube waits for the order too (15 Sep 2026). 2194 and 2196 were held for order, but their
    YouTube posts had been booked before the order rule existed; GoHighLevel published them on its own, and the
    socials, blog and podcast followed because only the YouTube stage checked the cursor."""
    return day not in gaps and day > cursor(state)


def section_status(entry):
    """The seven sections of one episode (Kevin, 15 Sep 2026: "I don't want any of the sections missed"), each
    'done', 'pending' (booked, not out yet) or 'missing'. A share nobody has confirmed on the profile is not done."""
    posts = (entry.get("posts") or {}).values()
    def clips(platform_yt, clip):
        mine = [p for p in posts if (p.get("platform") == "youtube") == platform_yt and p.get("clip") == clip]
        if not mine: return "missing"
        return "done" if all(p.get("status") == "published" for p in mine) else "pending"
    pod = (entry.get("podcast") or {}).get("status")
    # BOTH page posts, not just the summary (Kevin, 20 Sep 2026). The section is only done when every
    # share is on the profile; the worst of the two decides it, so a missing Learnings share still shows.
    # Only clips the page ACTUALLY carries are counted: episode 1841 has no Learnings post, so counting
    # one would have read "Facebook share missing" on a finished episode for ever (20 Sep 2026).
    shares = [(entry.get(spec["key"]) or {}).get("status") for clip, spec in FB_SHARES.items()
              if any(p.get("platform") == "facebook" and p.get("clip") == clip for p in posts)]
    fb = "missing" if not shares else \
         ("done" if all(s == "shared" for s in shares) else
          ("pending" if any(s in ("sharing", "unconfirmed", "page-post-not-found", "signin-needed", "queued") for s in shares) else "missing"))
    return {"YouTube episode": clips(True, "full"), "YouTube Short": clips(True, "lfmd"),
            "Teaser clips": clips(False, "summary"), "Learnings clips": clips(False, "lfmd"),
            "Blog": "done" if (entry.get("blog") or {}).get("url") else ("pending" if (entry.get("blog") or {}).get("status") in ("creating", "unconfirmed") else "missing"),
            "Podcast": "done" if pod == "published" else ("pending" if pod in ("processing", "uploading") else "missing"),
            "Facebook share": fb}


def extras_done(entry):
    s = section_status(entry)
    return s["Blog"] == "done" and s["Podcast"] == "done"


def run(dry_run=False, limit=3):
    state = load_state(); days = approved_days()
    hold = held_days()
    for d in sorted(set(days) & set(hold)): print("publish: episode %d HELD, not published (%s)" % (d, hold[d] or "see content_engine_hold_days"))
    days = [d for d in days if d not in hold]
    if not days: print("publish: no approved episodes to publish"); return
    acct_map = account_map(accounts()); yt_ok = "youtube" in acct_map
    ledger = watch.load_ledger()
    done = 0; per_stage = {1: 0, 2: 0}
    save = (lambda: None) if dry_run else (lambda: save_state(state))
    gaps = watch.gap_days()   # Kevin's catch-up days (8 Sep 2026): they fill old holes, so they never wait for, or move, the cursor
    held = [d for d in days if d > cursor(state) + 1 and d not in gaps]
    if held: print("publish: held for order (behind day %d): %s" % (cursor(state) + 1, ", ".join(str(d) for d in held)))
    for day in days:
        entry = state.setdefault(str(day), {})
        recs = bundle(day)
        full = recs["Long Form Video"]
        if not full: continue
        leak = pc.session_leak(recs)
        if leak:
            # 24 Sep 2026: a session's close-out block rode on the copy of 2066-2071 onto YouTube and Spotify. The writer now
            # runs with no hooks and cuts such text; this is the last stop before anything is posted, for every stage.
            print("episode %d: NOT published: session text in %s (remove it: platform_copy.py clean --day %d)"
                  % (day, ", ".join("%s %s" % (c, f) for c, f, _ in leak), day), file=sys.stderr)
            continue
        test = mode() == "test"
        stage = stage_for(entry, yt_ok)
        if full["fields"].get("Record Status") not in PUBLISHABLE:
            # 15 Sep 2026: 2056 and 1841 were marked Published while their podcast had been refused, and this line
            # skipped Published records before the retry, so the podcast never went out. Only the extras run here.
            if full["fields"].get("Record Status") == STATUS_PUBLISHED and stage == "done" and not ahead_of_order(day, gaps, state) and not dry_run:
                # 21 Sep 2026: 1841's Learnings clip was rebuilt after its record went Published, and this branch
                # skipped the fill below, so the clip could never reach the socials or the Short. It runs here too.
                fill_learnings(day, entry, recs, acct_map, stage, ledger, gaps, state, save)
                if not extras_done(entry): finish_extras(day, entry, recs, test, save)
                save()
            continue
        if stage == "youtube" and not may_go_to_youtube(day, gaps, state, ledger, days):
            continue
        if stage != "youtube" and ahead_of_order(day, gaps, state):
            continue                                   # named once in the 'held for order' line above
        if stage == "wait-youtube-account":
            print("episode %d: approved, waiting for a YouTube account in GoHighLevel (Kevin's click: publish.py youtube-link)" % day); continue
        if stage == "wait-youtube-link":
            print("episode %d: YouTube post scheduled, waiting for it to publish before the socials go out" % day); continue
        if not dry_run: fill_learnings(day, entry, recs, acct_map, stage, ledger, gaps, state, save)
        redo = [b for b in entry.get("broken_uploads", []) if not b.get("replaced") and int(b.get("attempts") or 0) < REPLACE_ATTEMPTS]
        if redo and not dry_run and entry.get("youtube_link") and not ahead_of_order(day, gaps, state):
            for st_no in sorted({1 if b["clip"] == "full" else 2 for b in redo}):
                schedule_stage(day, entry, recs, acct_map, st_no, dry_run, index=0, save=save)
            for b in redo:
                b["attempts"] = int(b.get("attempts") or 0) + 1
                new = [q for k, q in (entry.get("posts") or {}).items() if k.startswith("youtube|") and q.get("clip") == b["clip"] and q.get("id") and q["id"] != b["id"]]
                if new: b["replaced"] = now_utc(); b["by"] = new[0]["id"]
                else: print("episode %d: replacement YouTube %s not on the channel yet (attempt %d of %d)" % (day, b["clip"], b["attempts"], REPLACE_ATTEMPTS), file=sys.stderr)
            save()
        if stage == "done":
            if not dry_run: finish_extras(day, entry, recs, test, save)     # a blog or Spotify that failed last hour
            continue
        if done >= limit: break
        st_no = 1 if stage == "youtube" else 2
        n = schedule_stage(day, entry, recs, acct_map, st_no, dry_run, index=per_stage[st_no], save=save)
        if n: per_stage[st_no] += 1
        if n and st_no == 1 and not dry_run and moves_cursor(day, gaps): state[CURSOR_KEY] = day; save()
        done += 1 if n else 0
        # Same day, not the day after (Kevin, 10 Sep 2026). The direct upload hands back the YouTube link at
        # once, so the socials, the blog, the podcast and Spotify go out this afternoon instead of tomorrow.
        if st_no == 1 and n and stage_for(entry, yt_ok) == "socials":
            if schedule_stage(day, entry, recs, acct_map, 2, dry_run, index=per_stage[2], save=save):
                per_stage[2] += 1
        if stage_for(entry, yt_ok) == "done" and not dry_run:
            finish_extras(day, entry, recs, test, save)
        save()


YTDLP = os.path.expanduser("~/Library/Python/3.9/bin/yt-dlp")
CHANNEL_URL = "https://www.youtube.com/@runpreneur/videos"
SHORTS_URL = "https://www.youtube.com/@runpreneur/shorts"
YT_GRACE_MINUTES = 20


def title_is_episode(title, day):
    """The channel title names the day: 'Episode 2054', 'Ep2054', 'Ep 2054/5000', 'Day 2,054'."""
    t = title or ""
    return bool(re.search(r"\b(?:Episode|Ep\.?)\s?%d\b" % day, t, re.I) or re.search(r"\bDay\s?%s\b" % "{:,}".format(day), t, re.I) or re.search(r"\bDay\s?%d\b" % day, t, re.I))


def youtube_link_from_channel(day, scheduled_iso, now=None, listing=None, url=CHANNEL_URL):
    """https://youtu.be/<id> for the day's video on the channel, once the slot is YT_GRACE_MINUTES past; else None.
    `url` is the Shorts tab for a Short (15 Sep 2026: 2054's Short read 'scheduled' in GoHighLevel for six days
    while it was live as WUTZvEoLDbQ, because only the full episode was ever looked up on the channel)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    try: due = dt.datetime.strptime(scheduled_iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except (TypeError, ValueError): return None
    if now < due + dt.timedelta(minutes=YT_GRACE_MINUTES): return None
    if listing is None:
        try:
            r = subprocess.run([YTDLP, "--flat-playlist", "-j", "--no-warnings", "--playlist-end", "12", url], capture_output=True, text=True, timeout=120)
            listing = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
        except Exception as ex:
            print("youtube: channel listing failed (%s)" % str(ex)[:80], file=sys.stderr); return None
    for item in listing:
        if item.get("id") and title_is_episode(item.get("title"), day): return "https://youtu.be/" + item["id"]
    return None


BROKEN_UPLOAD_MINUTES = 90
REPLACE_ATTEMPTS = 3
CACHE_KEEP_DAYS = 3
THUMB_TRIES = 6


SPOTIFY_LINK_DAYS = 3


def spotify_link_due(pod, now=None):
    """Ask Spotify's public page for the episode link this run? Until 21 Sep 2026 only a 'processing' episode was asked,
    and the publish step asks once, straight after Publish, before the public page has caught up. So an episode the
    episodes list already called 'published' kept an empty link for good: 2055 to 2196, eleven in a row, and the
    Publishing page showed no Spotify link. The public page lists only the newest episode, so the link must be read
    while the episode is newest: asked every hourly run for SPOTIFY_LINK_DAYS after the upload started, then left."""
    if not pod.get("title") or pod.get("link") or pod.get("status") not in ("processing", "published"): return False
    age = minutes_since(pod.get("started"), now)
    if age is None: return pod.get("status") == "processing"          # no start time: 'processing' keeps its old retry
    return age <= SPOTIFY_LINK_DAYS * 24 * 60                        # older than that, a newer episode has taken the page


def minutes_since(iso, now=None):
    try: t = dt.datetime.strptime((iso or "")[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc)
    except ValueError: return None
    return ((now or dt.datetime.now(dt.timezone.utc)) - t).total_seconds() / 60


def youtube_verdict(p, s, now=None):
    """What YouTube itself says about one of our API posts: 'published', 'broken', or None (leave it).
    A video public and processed is out, whatever our record says (16 Sep 2026: 2057 and 2058 were public for a day
    while the records said 'scheduled', because an interrupted upload was adopted with no publish time). A video still
    'uploaded' with no length 90 minutes after its upload began never finished arriving (2058's Short)."""
    if not s: return None
    if s.get("privacy") == "public" and s.get("upload") == "processed": return "published"
    age = minutes_since(p.get("started") or p.get("adopted"), now)
    if s.get("upload") == "uploaded" and not s.get("seconds") and age is not None and age >= BROKEN_UPLOAD_MINUTES: return "broken"
    return None


def youtube_truth(state):
    """One call for every API post that is not yet confirmed, or published without our thumbnail."""
    ids = [p.get("id") for d, e in state.items() if str(d).isdigit() and isinstance(e, dict)
           for p in (e.get("posts") or {}).values()
           if p.get("route") == "api" and p.get("id") and (p.get("status") != "published" or
               (p.get("clip") == "full" and (p.get("thumb") is False or (p.get("adopted") and "thumb" not in p))))]
    if not ids: return {}
    try:
        import youtube_api
        return youtube_api.video_states(ids)
    except (Exception, SystemExit) as ex:
        print("youtube: could not read the channel to confirm uploads (%s)" % str(ex)[-120:], file=sys.stderr); return {}


def prune_publish_cache(state, now=None, root=None):
    """A day's local copies go once all seven sections are out, or CACHE_KEEP_DAYS after its YouTube episode went out."""
    import shutil
    root = root or PUBLISH_CACHE
    if not os.path.isdir(root): return []
    gone = []
    for d in os.listdir(root):
        e = state.get(d)
        if not isinstance(e, dict): continue
        yt_full = next((p for k, p in (e.get("posts") or {}).items() if k.startswith("youtube|") and p.get("clip") == "full"), {})
        age = minutes_since(yt_full.get("published_at"), now)
        if all(v == "done" for v in section_status(e).values()) or (age is not None and age > CACHE_KEEP_DAYS * 1440):
            shutil.rmtree(os.path.join(root, d), ignore_errors=True); gone.append(d)
    return gone


def sync():
    """GHL post statuses -> links on the record; the YouTube link unlocks stage 2; all published -> Published."""
    state = load_state(); _, loc, _ = _cfg()
    yt = youtube_truth(state)
    for d in prune_publish_cache(state): print("episode %s: local publish copies removed" % d)
    for day, entry in state.items():
        if not str(day).isdigit() or not isinstance(entry, dict): continue   # _cursor, _skipped_days, held_posts live beside the episodes (9 Sep 2026: the first live cursor crashed sync)
        try:
            if monetise_long_video(day, entry): save_state(state)
        except Exception as ex:
            print("episode %s: monetisation check skipped this run (%s)" % (day, str(ex)[-160:]), file=sys.stderr)
        for clip in FB_SHARES:            # both page posts reach Kevin's profile, not just the summary (20 Sep 2026)
            try:
                if share_to_facebook_profile(day, entry, state, clip=clip): save_state(state)
            except Exception as ex:       # a page read timed out on 11 Sep 2026 and ended the whole hourly run
                print("episode %s: Facebook %s profile share skipped this run (%s)" % (day, clip, str(ex)[-160:]), file=sys.stderr)
        pod = entry.get("podcast") or {}
        if spotify_link_due(pod):
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
        changed = False; links = {}; clip_links = {}; drop = []
        for key, p in posts.items():
            if p.get("route") == "api" and p.get("clip") == "full" and p.get("status") == "published" \
                    and (p.get("thumb") is False or (p.get("adopted") and "thumb" not in p)) \
                    and (yt.get(p.get("id")) or {}).get("upload") == "processed" and int(p.get("thumb_tries") or 0) < THUMB_TRIES:
                # our thumbnail on every long video (Kevin, 17 Sep 2026: "the thumbnails haven't come through")
                p["thumb_tries"] = int(p.get("thumb_tries") or 0) + 1; changed = True
                try:
                    import youtube_api
                    png = fetch_readable(int(day), "thumb")
                    if os.path.exists(png):
                        youtube_api.set_thumbnail(p["id"], png); p["thumb"] = True
                        print("episode %s: thumbnail set on %s" % (day, p["id"]))
                except (Exception, SystemExit) as ex:
                    p["thumb_error"] = str(ex)[-200:]
                    print("episode %s: thumbnail not set on %s (%s)" % (day, p["id"], str(ex)[-120:]), file=sys.stderr)
            if p.get("status") in ("published", "draft"): continue     # a draft (test mode) never moves on its own
            if p.get("route") == "api":                                # uploaded straight to YouTube: the slot passing is the publish
                if p.get("scheduled") and dt.datetime.now(dt.timezone.utc) >= dt.datetime.fromisoformat(p["scheduled"].replace("Z", "+00:00")):
                    p["status"] = "published"; p.setdefault("published_at", p["scheduled"]); changed = True
                    for f in LINK_FIELDS.get(("youtube", p["clip"]), ()): links.setdefault(f, p["link"])
                    if p["clip"] == "full" and not entry.get("youtube_link"): entry["youtube_link"] = p["link"]
                elif not p.get("scheduled"):
                    verdict = youtube_verdict(p, yt.get(p.get("id")))
                    if verdict == "published":
                        s = yt[p["id"]]
                        p["status"] = "published"; p["published_at"] = s.get("published") or now_utc(); p["confirmed"] = "on the channel"; changed = True
                        for f in LINK_FIELDS.get(("youtube", p["clip"]), ()): links.setdefault(f, p["link"])
                        if p["clip"] == "full" and not entry.get("youtube_link"): entry["youtube_link"] = p["link"]
                        print("episode %s: YouTube %s confirmed live on the channel (%s)" % (day, p["clip"], p["link"]))
                    elif verdict == "broken":
                        # never deleted by the engine: made private (reversible) and replaced by a fresh upload
                        try:
                            import youtube_api; youtube_api.set_privacy(p["id"], "private"); hidden = True
                        except (Exception, SystemExit) as ex:
                            hidden = False; p["hide_error"] = str(ex)[-200:]; changed = True
                            print("episode %s: could not hide the broken upload %s (%s); tried again next run, NOT replaced while it is public" % (day, p["id"], str(ex)[-120:]), file=sys.stderr)
                        if hidden:
                            entry.setdefault("broken_uploads", []).append({"clip": p["clip"], "id": p["id"], "found": now_utc(), "hidden": True})
                            drop.append(key); changed = True
                            print("episode %s: YouTube %s %s never finished uploading; hidden (private) and queued for a fresh upload" % (day, p["clip"], p["id"]))
                continue
            try:
                g = ghl("GET", "/social-media-posting/%s/posts/%s" % (loc, p["id"]))
            except SystemExit as ex:
                print("episode %s: cannot read post %s (%s)" % (day, p["id"], str(ex)[:120])); continue
            post = (g.get("results") or g).get("post") or g
            st = post.get("status"); link = post.get("previewLink") or ""
            if st != p.get("status"): p["status"] = st; changed = True
            if st == "failed": p["error"] = str(post.get("error"))[:200]; print("episode %s: %s post FAILED: %s" % (day, p["platform"], p["error"]))
            if st == "scheduled" and p["platform"] == "youtube" and p["clip"] in ("full", "lfmd") and not link:
                # 9 Sep 2026: episode 2054 was live on YouTube at 15:24 and GoHighLevel never flipped its own post from
                # 'scheduled' (no error either). Twenty minutes past the slot, the channel itself is the source of truth.
                # The Short is looked up on the Shorts tab (15 Sep 2026).
                found = youtube_link_from_channel(int(day), p.get("scheduled"), url=SHORTS_URL if p["clip"] == "lfmd" else CHANNEL_URL)
                if found: st, link = "published", found; p["status"] = st; p["note"] = "link read from the channel listing; GHL never updated its post"; print("episode %s: YouTube live as %s (GHL post still says scheduled)" % (day, found))
            if st == "scheduled" and not link and p["platform"] != "youtube" and p.get("scheduled") and dt.datetime.now(dt.timezone.utc) >= \
                    dt.datetime.fromisoformat(p["scheduled"].replace("Z", "+00:00")) + dt.timedelta(minutes=GHL_SLOT_GRACE_MIN):
                # 14 Sep 2026: GoHighLevel never flips a social post from 'scheduled' (no previewLink, no publishedAt,
                # no error) — 51 posts from 9-11 Sep still read 'scheduled' three days on while the posts were live.
                # An hour past its slot with no failure recorded, the post went out; the record and the Estate status
                # board otherwise show a dash for a live post for ever. No public link is available from GHL for it.
                # YouTube is excluded: its channel lookup above keeps retrying until the video appears (review, 14 Sep 2026).
                st = "published"; p["status"] = st; p.setdefault("published_at", p["scheduled"]); changed = True
                p["note"] = "slot passed with no failure; GoHighLevel never updated its post status, no link available"
            if st == "published" and link:
                p["link"] = link; p.setdefault("published_at", dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")); changed = True
                if p["platform"] == "youtube" and not entry.get("youtube_link"): entry["youtube_link"] = link
                for f in LINK_FIELDS.get((p["platform"], p["clip"]), ()):
                    links.setdefault(f, link)                      # first account wins (the Runpreneur page before the profile)
                    clip_links.setdefault(p["clip"], {}).setdefault(f, link)
        complete = all(p.get("status") == "published" for p in posts.values()) and any(not k.startswith("youtube|") for k in posts) \
            and extras_done(entry)                         # the blog and podcast count too: 2056's record said Published with no podcast
        if links or (complete and not entry.get("record_published")):
            full = pc.find_by_name(pc.record_name(int(day), "Long Form Video"))
            fields = dict(links)
            if entry.get("youtube_link") and not full["fields"].get("Date Published (YT)"): fields["Date Published (YT)"] = dt.date.today().isoformat()
            if complete and full["fields"].get("Record Status") != STATUS_PUBLISHED:
                fields["Record Status"] = STATUS_PUBLISHED; fields["Date Published (Other)"] = dt.date.today().isoformat()
            if complete: entry["record_published"] = dt.date.today().isoformat(); changed = True
            if fields: watch._airtable("PATCH", watch.API + "/" + full["id"], {"fields": fields})
            for clip, cl in clip_links.items():
                if clip == "full": continue
                rec = pc.find_by_name(pc.record_name(int(day), CLIP_RECORD[clip]))
                if rec: watch._airtable("PATCH", watch.API + "/" + rec["id"], {"fields": {k: v for k, v in cl.items() if not k.startswith("Link of")}})
            if fields: print("episode %s: %s" % (day, ", ".join(sorted(fields))))
        for key in drop: posts.pop(key, None)
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
    sections = {d: section_status(e) for d, e in state.items() if e.get("posts")}
    complete = [d for d, s in sections.items() if all(v == "done" for v in s.values())]
    print("content publishing: %d approved episode%s not yet scheduled, %d posts scheduled, %d failed, %d of %d episodes complete (all seven sections)" % (
        len(waiting), "" if len(waiting) == 1 else "s", scheduled, failed, len(complete), len(sections)))
    gaps = ["%s: %s" % (d, ", ".join("%s %s" % (k, v) for k, v in s.items() if v != "done")) for d, s in sorted(sections.items(), key=lambda x: int(x[0])) if d not in complete]
    print("content sections not done: %s" % ("none" if not gaps else "; ".join(gaps)))
    # No route filter here either: the old one hid every GoHighLevel upload from this line as well, so the
    # report read "every YouTube episode and Short On" while three of them had never been looked at (20 Sep 2026).
    waiting = []
    for d, e in state.items():
        if not str(d).isdigit() or not isinstance(e, dict): continue
        for k, p in (e.get("posts") or {}).items():
            if not (k.startswith("youtube|") and p.get("clip") in ("full", "lfmd") and p.get("status") == "published"): continue
            what = "Short" if p["clip"] == "lfmd" else "episode"
            if p.get("monetisation") not in MONETISED:
                waiting.append("%s %s (%s)" % (d, what, p.get("monetisation") or "not checked yet"))
            elif p["clip"] == "full" and p.get("midroll") not in MIDROLL_SETTLED:
                waiting.append("%s episode mid-roll (%s)" % (d, p.get("midroll") or "not checked yet"))
    unconfirmed = ["%s %s %s" % (d, p.get("platform"), p.get("clip")) for d, e in state.items() if str(d).isdigit() and isinstance(e, dict)
                   for p in (e.get("posts") or {}).values() if p.get("status") in ("creating", "unconfirmed")]
    print("content monetisation: %s" % ("every YouTube episode and Short On" if not waiting else "NOT On yet for " + ", ".join(sorted(waiting))))
    print("content posts to check once: %s" % ("none" if not unconfirmed else ", ".join(unconfirmed)))


def youtube_link():
    key, loc, user = _cfg()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k): return None
    req = urllib.request.Request(GHL + "/social-media-posting/oauth/youtube/start?locationId=%s&userId=%s&reconnect=false" % (loc, user),
                                 headers={"Authorization": "Bearer " + key, "Version": "2021-07-28", "User-Agent": UA})
    try: r = urllib.request.build_opener(NoRedirect).open(req); print(r.headers.get("Location"))
    except urllib.error.HTTPError as e: print(e.headers.get("Location") or e.read().decode()[:300])


def _selftest_once_only():
    import contextlib
    with contextlib.redirect_stdout(sys.stderr):      # the test's own posting lines must not land in the JSON the suite reads
        return _selftest_once_only_body()


def _selftest_once_only_body():
    """A run killed half way through posting must never post a channel twice (Kevin, 13 Sep 2026). Runs the real
    schedule_stage and finish_extras against fakes: the first run is killed after two posts, the second run must
    create only the channels that were never started, the blog exactly once, and Spotify exactly once."""
    import copy as _copy, tempfile as _tf, types as _types
    g = globals(); saved = {k: g[k] for k in ("_cfg", "episode_files", "media_for", "mode", "youtube_direct_ready", "create_post", "approval", "watch", "run_spotify", "output_link", "is_png")}
    tmp = _tf.mkdtemp()
    def fake_files(day):
        out = {}
        for k, name in CLIP_FILES.items():
            path = os.path.join(tmp, name % day); open(path, "w").write("x"); out[k] = path
        return out
    class Killed(BaseException): pass          # what a SIGKILL or a lost Mac looks like to Python: nothing catches it
    calls = {"post": 0, "blog": 0, "spotify": 0}; kill_after = {"n": 2}
    def fake_create(body, brand="Runpreneur"):
        if kill_after["n"] is not None and calls["post"] >= kill_after["n"]: raise Killed()
        calls["post"] += 1; return "p%d" % calls["post"]
    state = {}
    disk = {"state": None}
    def save(): disk["state"] = _copy.deepcopy(state)
    try:
        g.update({"_cfg": lambda brand="Runpreneur": ("k", "loc", "user"), "episode_files": fake_files,
                  "output_link": lambda day, kind, ledger=None: None,       # never the real ledger or Drive in a selftest
                  "is_png": lambda path: True,                               # the fake thumbnail stands in for a real PNG
                  "media_for": lambda day, entry, kinds: {k: "https://cdn/%s" % k for k in kinds},
                  "mode": lambda: "live", "youtube_direct_ready": lambda: False, "create_post": fake_create,
                  "approval": _types.SimpleNamespace(append_note=lambda rec, line: line, load_state=lambda: {}),
                  "watch": _types.SimpleNamespace(_airtable=lambda *a, **k: {}, API="x"),
                  "run_spotify": lambda day, tid, plan, title, test, pod: (calls.__setitem__("spotify", calls["spotify"] + 1), pod.update(status="published"), "Spotify published")[2]})
        accts = {"facebook": [{"id": "fb", "name": "Runpreneur"}], "linkedin": [{"id": "lp", "name": "Runpreneur"}, {"id": "lk", "name": "Kevin Brittain"}],
                 "threads": [{"id": "th", "name": "runpreneur"}]}
        recs = {"Long Form Video": {"id": "recF", "fields": {"YouTube Copy": "Title: T\nDescription: D", "Blog Copy": "b", "Podcast Copy": "Title: P"}},
                "Short Form Video": {"id": "recS", "fields": {"Facebook Reels Copy": "fb", "LinkedIn Copy": "li", "Threads Copy": "th"}},
                "Learnings From My Diary": {"id": "recL", "fields": {"Facebook Post Copy": "fb2", "LinkedIn Copy": "li2", "Threads Copy": "th2"}}}
        entry = state.setdefault("9", {"youtube_link": "https://youtu.be/x"})
        try:
            schedule_stage(9, entry, recs, accts, 2, index=0, save=save)
            raise AssertionError("the first run should have been killed")
        except Killed:
            pass
        after_kill = disk["state"]["9"]["posts"]
        made_first = calls["post"]
        assert made_first == 2 and sum(1 for p in after_kill.values() if p.get("id")) == 2, after_kill
        creating = [k for k, p in after_kill.items() if p.get("status") == "creating"]
        assert len(creating) == 1, "the post in flight when the run died is on disk as creating: %s" % after_kill
        # second run, from what was on disk, with a working platform
        state.clear(); state.update(_copy.deepcopy(disk["state"])); entry = state["9"]; kill_after["n"] = None
        n = schedule_stage(9, entry, recs, accts, 2, index=0, save=save)
        total_channels = 2 * 4          # summary + lfmd on 4 accounts
        assert calls["post"] == total_channels - 1, "every channel posted once, the half-made one never again: %d posts" % calls["post"]
        assert entry["posts"][creating[0]]["status"] == "unconfirmed", "the half-made post is reported, not repeated"
        n2 = schedule_stage(9, entry, recs, accts, 2, index=0, save=save)
        assert n2 == 0 and calls["post"] == total_channels - 1, "a third run posts nothing"
        # extras: blog and Spotify once each, even when the run is repeated
        import blog as _blog
        bsaved = _blog.publish_blog
        # ensure_reading_time is stubbed too, and it is not decoration. The fake blog
        # marks the article PUBLISHED with a url and no read_time, which is exactly the
        # state that sends the REAL ensure_reading_time to GHL: post_id_for_slug pages
        # /blogs/posts/all over the network with the selftest's fake key. It failed
        # with a 404 and finish_extras swallowed it, so the selftest passed while
        # spending ~5s on three live HTTP calls — and failed the whole fixer gate
        # whenever the network or GHL misbehaved (finding 20260919-queue-fixer-555).
        # A selftest makes no network calls. Returning False is the honest stand-in:
        # the real call returns False whenever the reading time is not set yet.
        rtsaved = _blog.ensure_reading_time
        _blog.ensure_reading_time = lambda entry: False
        def fake_blog(day, full, e, thumb, link, test):
            calls["blog"] += 1; e["blog"] = {"id": "", "url": "https://runpreneur.org.uk/blog/b/t-day-9", "status": "PUBLISHED"}; return "", e["blog"]["url"]
        _blog.publish_blog = fake_blog
        try:
            import spotify as _sp
            wsaved = _sp.write_plan; _sp.write_plan = lambda *a, **k: ("/tmp/plan.json", "Episode 9 - P")
            try:
                for _ in range(3): finish_extras(9, entry, recs, False, save)
            finally:
                _sp.write_plan = wsaved
        finally:
            _blog.publish_blog = bsaved
        assert calls["blog"] == 1 and calls["spotify"] == 1, "blog and Spotify once each across three runs: %s" % calls
        # a run killed while the blog was being published leaves 'creating': the next run does not publish again
        e2 = {"youtube_link": "https://youtu.be/x", "blog": {"status": "creating"}, "podcast": {"status": "published"}}
        _blog.publish_blog = fake_blog
        try: finish_extras(9, e2, recs, False, lambda: None)
        finally: _blog.publish_blog = bsaved; _blog.ensure_reading_time = rtsaved
        assert calls["blog"] == 1, "a blog left creating by a killed run is never published a second time"
        assert definitely_not_created(SystemExit("GHL POST /x -> 422: bad")) and not definitely_not_created(SystemExit("GHL POST /x -> 502: gateway")) and not definitely_not_created(TimeoutError())
    finally:
        g.update(saved)
    return 1


def _selftest_fill_learnings():
    """A rebuilt Learnings clip reaches the socials and the Short once it exists, for a Published record too (21 Sep
    2026: 1841's record was Published, run() skipped it before the fill, so its rebuilt clip could never go out).
    Drives the real run() and fill_learnings against fakes; nothing reaches Airtable, Drive or GoHighLevel."""
    import types as _types, io as _io, contextlib as _cl
    g = globals()
    names = ("approved_days", "held_days", "accounts", "account_map", "load_state", "save_state", "bundle", "stage_for", "watch",
             "output_link", "schedule_stage", "finish_extras", "extras_done", "mode")
    saved = {k: g[k] for k in names}
    sched, extras = [], []
    teaser = [False, False]          # [teaser clip rendered, teaser copy written]
    def run_once(status, entry):
        state = {"_cursor": 2061, "1841": entry}
        g.update({"approved_days": lambda: [1841], "held_days": lambda path=None: {}, "accounts": lambda brand="Runpreneur": [],
                  "account_map": lambda a: {"youtube": [{"id": "yt"}]}, "load_state": lambda: state, "save_state": lambda st: None,
                  "bundle": lambda day: {"Long Form Video": {"id": "recF", "fields": {"Record Status": status}},
                                         "Short Form Video": {"fields": {"TikTok Copy": "t"}} if teaser[1] else None, "Learnings From My Diary": None},
                  "stage_for": lambda e, yt: "done", "watch": _types.SimpleNamespace(load_ledger=lambda: {}, gap_days=lambda path=None: {1841}),
                  "output_link": lambda day, kind, ledger=None: None if kind == "summary" and not teaser[0] else "https://drive/%s" % kind,
                  "schedule_stage": lambda day, e, recs, am, st_no, dry_run=False, index=0, save=None: sched.append((day, st_no)) or 2,
                  "finish_extras": lambda *a, **k: extras.append(a[0]), "extras_done": lambda e: True, "mode": lambda: "live"})
        with _cl.redirect_stdout(_io.StringIO()): run()
        return state["1841"]
    try:
        e = run_once(STATUS_PUBLISHED, {"youtube_link": "https://youtu.be/x"})
        assert sched == [(1841, 2)] and e["fill_attempts"] == 1, (sched, e)
        for _ in range(4): run_once(STATUS_PUBLISHED, e)
        assert len(sched) == REPLACE_ATTEMPTS and e["fill_attempts"] == REPLACE_ATTEMPTS, "tried at most REPLACE_ATTEMPTS times, then left"
        del sched[:]
        run_once(STATUS_APPROVED, {"youtube_link": "https://youtu.be/x"})
        assert sched == [(1841, 2)], "the publishable path fills the same way"
        del sched[:]
        run_once(STATUS_PUBLISHED, {"youtube_link": "https://youtu.be/x", "posts": {"youtube|lfmd|a": {"platform": "youtube", "clip": "lfmd", "status": "published"},
                 "facebook|lfmd|b": {"platform": "facebook", "clip": "lfmd", "status": "published"}}})
        assert sched == [], "nothing missing: nothing scheduled"
        teaser[0] = True             # 2069 (24 Sep 2026): the teaser rendered, its posts were never made, the record is Published
        run_once(STATUS_PUBLISHED, {"youtube_link": "https://youtu.be/x", "posts": {"youtube|lfmd|a": {"platform": "youtube", "clip": "lfmd", "status": "published"},
                 "facebook|lfmd|b": {"platform": "facebook", "clip": "lfmd", "status": "published"}}})
        assert sched == [], "a rendered teaser with no copy: nothing to post, no attempt spent (2069, 24 Sep 2026)"
        teaser[1] = True
        run_once(STATUS_PUBLISHED, {"youtube_link": "https://youtu.be/x", "posts": {"youtube|lfmd|a": {"platform": "youtube", "clip": "lfmd", "status": "published"},
                 "facebook|lfmd|b": {"platform": "facebook", "clip": "lfmd", "status": "published"}}})
        assert sched == [(1841, 2)], "a rendered teaser with copy and no posts is filled on a Published record"
        del sched[:]; teaser[0] = teaser[1] = False
        g["output_link"] = lambda day, kind, ledger=None: None
        assert not fill_learnings(1841, {"youtube_link": "y"}, {}, {}, "done", {}, {1841}, {"_cursor": 2061}, lambda: None), "no rebuilt clip yet: nothing to post"
        # 24 Sep 2026: copy holding a session's close-out block is never posted, on any path (the 2070 podcast was
        # being retried hourly with "CLOSE-OUT ... Safe to close? Yes" in its Spotify description)
        del sched[:]; del extras[:]
        leaked = {"Long Form Video": {"id": "recF", "fields": {"Record Status": STATUS_PUBLISHED, "Podcast Copy": "Day 2070.\n\n---\n\nCLOSE-OUT\nSafe to close? Yes"}},
                  "Short Form Video": None, "Learnings From My Diary": None}
        for status in (STATUS_PUBLISHED, STATUS_APPROVED):
            leaked["Long Form Video"]["fields"]["Record Status"] = status
            g["bundle"] = lambda day: leaked
            g["extras_done"] = lambda e: False
            with _cl.redirect_stderr(_io.StringIO()) as err, _cl.redirect_stdout(_io.StringIO()): run()
            assert sched == [] and extras == [], (status, sched, extras)
            assert "NOT published: session text in Long Form Video Podcast Copy" in err.getvalue(), err.getvalue()
    finally:
        g.update(saved)


def selftest():
    led_r = {"p1": {"day": 2071, "status": "new"}, "x": {"episode": 2196, "day": 2196, "status": "rendered"}}
    st_r = {"_cursor": 2070}
    assert next_publishable(st_r, led_r, {2196}) == (None, "day 2071 is not approved yet, so 2196 wait behind it") and st_r["_cursor"] == 2070, \
        "a day waiting to re-render is held, never stepped over (24 Sep 2026)"
    assert not day_was_recorded(2080, {"b": {"day": 2080, "status": "broll"}}), "a day of B-roll only is still stepped over"
    ent_h = {"youtube_link": "y", "blog": {"url": "u"}, "podcast": {"status": "failed", "upload_attempts": 3, "error": "Timeout"}}
    import io as _io3, contextlib as _cl3
    with _cl3.redirect_stderr(_io3.StringIO()), _cl3.redirect_stdout(_io3.StringIO()):
        finish_extras(2070, ent_h, {"Long Form Video": {"id": "recX", "fields": {}}}, False, lambda: None)
    assert ent_h["podcast"]["status"] == "held" and "Untitled draft" in ent_h["podcast"]["note"], ent_h["podcast"]
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
    # 15 Sep 2026: 2194/2196 were held for order but their socials went out, because only the YouTube stage checked it
    so = {CURSOR_KEY: 2056, "2194": {"youtube_link": "https://youtu.be/x"}}
    assert ahead_of_order(2194, gaps, so) and not ahead_of_order(2056, gaps, so) and not ahead_of_order(2055, gaps, so) and not ahead_of_order(1841, gaps, so)
    import inspect; rsrc = inspect.getsource(run)
    assert 'if stage != "youtube" and ahead_of_order(day, gaps, state)' in rsrc, "the socials, blog and podcast wait for the order too"
    assert rsrc.index("ahead_of_order(day, gaps, state)") < rsrc.index("schedule_stage("), "the order check comes before anything is booked"
    # a day already live is stepped over, or the next day waits for a YouTube upload that never happens again
    sl = {CURSOR_KEY: 2193, "2194": {"youtube_link": "https://youtu.be/a"}, "2195": {"youtube_link": "https://youtu.be/b"}}
    led2 = {k: {"episode": d} for k, d in (("a", 2193), ("b", 2194), ("c", 2195), ("e", 2196), ("d", 2197))}
    assert next_publishable(sl, led2, {2194, 2195, 2197}) == (None, "day 2196 is not approved yet, so 2197 wait behind it") and sl[CURSOR_KEY] == 2195
    # the seven sections: 2056 on 15 Sep 2026 had every post out, no podcast and no confirmed share
    e2056 = {"posts": {"youtube|full|y": {"platform": "youtube", "clip": "full", "status": "published"},
                       "youtube|lfmd|y": {"platform": "youtube", "clip": "lfmd", "status": "published"},
                       "facebook|summary|f": {"platform": "facebook", "clip": "summary", "status": "published"},
                       "facebook|lfmd|f": {"platform": "facebook", "clip": "lfmd", "status": "published"}},
             "blog": {"url": "https://runpreneur.org.uk/blog/b/x"}, "facebook_share": {"status": "page-post-not-found"}}
    s = section_status(e2056)
    assert s == {"YouTube episode": "done", "YouTube Short": "done", "Teaser clips": "done", "Learnings clips": "done", "Blog": "done",
                 "Podcast": "missing", "Facebook share": "pending"}, s
    assert not extras_done(e2056) and extras_done({**e2056, "podcast": {"status": "published"}})
    assert section_status({"posts": {"facebook|summary|f": {"platform": "facebook", "clip": "summary", "status": "scheduled"}}})["Teaser clips"] == "pending"
    assert section_status({})["Learnings clips"] == "missing", "no Learnings post at all is missing, not done (1841)"
    assert "extras_done(entry)" in rsrc and "STATUS_PUBLISHED" in rsrc, "a Published record with its podcast missing still gets the retry"
    ssrc = inspect.getsource(share_to_facebook_profile)
    assert '"unconfirmed" and fb.get("post_url")' in ssrc and 'reshared_at' in ssrc, "an unconfirmed share is re-checked and re-pressed once"
    assert '("shared", "reviewed", "failed"): return False' in ssrc, "a failed share is final, or it is pressed every other hour"
    assert 'dest + ".part"' in inspect.getsource(full_from_drive), "a stopped Drive copy must never be uploaded as the episode"
    # 16-17 Sep 2026: what YouTube says decides, not the record an interrupted upload left behind
    now = dt.datetime(2026, 9, 17, 8, 0, tzinfo=dt.timezone.utc)
    adopted = {"started": "2026-09-16T14:14:28Z", "adopted": "2026-09-16T15:39:55Z"}
    assert youtube_verdict(adopted, {"privacy": "public", "upload": "processed", "seconds": 266}, now) == "published", "public and processed is out (2058 full)"
    assert youtube_verdict(adopted, {"privacy": "public", "upload": "uploaded", "processing": "processing", "seconds": 0}, now) == "broken", "never finished arriving (2058 Short)"
    assert youtube_verdict({"started": "2026-09-17T07:30:00Z"}, {"privacy": "private", "upload": "uploaded", "seconds": 0}, now) is None, "still uploading: leave it"
    assert youtube_verdict(adopted, None, now) is None and youtube_verdict(adopted, {"privacy": "private", "upload": "processed", "seconds": 60}, now) is None
    import tempfile, shutil as _shu
    tdir = tempfile.mkdtemp(); real_files, real_cache = globals()["episode_files"], globals()["PUBLISH_CACHE"]
    good = os.path.join(tdir, "Episode_2058_Thumbnail.png"); open(good, "wb").write(b"PNG" * 100)
    globals()["episode_files"] = lambda d: {"thumb": good, "full": os.path.join(tdir, "absent_full.mp4")}
    globals()["PUBLISH_CACHE"] = os.path.join(tdir, "cache")
    try:
        fetched = []
        led = {"e": {"episode": 2058, "role": "episode", "outputs": {"full": "https://drive.google.com/file/d/1AbC_x-9/view"}}}
        assert fetch_readable(2058, "thumb", led, download=lambda fid, dest: fetched.append(fid)) == good and fetched == [], "no Drive link for this kind: the folder path"
        def dl(fid, dest): fetched.append(fid); open(dest, "wb").write(b"x" * 10)
        import io as _io, contextlib as _cl
        with _cl.redirect_stdout(_io.StringIO()): got = fetch_readable(2058, "full", led, download=dl)   # its log line must not reach the selftest JSON
        assert fetched == ["1AbC_x-9"] and got.startswith(globals()["PUBLISH_CACHE"]) and os.path.getsize(got) == 10, (fetched, got)
        assert fetch_readable(2058, "full", led, download=dl) == got and fetched == ["1AbC_x-9"], "fetched once, then the local copy"
        assert fetch_readable(2058, "full", {}, download=dl).endswith("absent_full.mp4"), "no Drive link: the caller's own check decides"
    finally:
        globals()["episode_files"], globals()["PUBLISH_CACHE"] = real_files, real_cache; _shu.rmtree(tdir)
    asrc = inspect.getsource(adopt_youtube); assert "broken_uploads" in asrc, "a video judged broken is never adopted again"
    _selftest_fill_learnings()
    rs = inspect.getsource(run); assert "REPLACE_ATTEMPTS" in rs and 'b["replaced"] = now_utc(); b["by"]' in rs, "replaced only when a new video exists, at most three tries"
    ss = inspect.getsource(sync); assert "if hidden:" in ss, "a broken video is replaced only after it is hidden"
    assert '(p.get("thumb") is False or (p.get("adopted") and "thumb" not in p))' in ss, "old videos keep their thumbnails"
    tmpc = tempfile.mkdtemp(); os.makedirs(os.path.join(tmpc, "2057")); os.makedirs(os.path.join(tmpc, "2059"))
    st_c = {"2057": {"posts": {"youtube|full|y": {"clip": "full", "status": "published", "published_at": "2026-09-10T05:00:00Z"}}},
            "2059": {"posts": {"youtube|full|y": {"clip": "full", "status": "scheduled"}}}}
    assert prune_publish_cache(st_c, now=dt.datetime(2026, 9, 17, 8, 0, tzinfo=dt.timezone.utc), root=tmpc) == ["2057"] and os.path.isdir(os.path.join(tmpc, "2059")), "old published days go, unpublished stay"
    _shu.rmtree(tmpc)
    ys2 = inspect.getsource(youtube_direct)
    assert "thumbnail=None, srt=None" in ys2 and ys2.index("youtube_api.upload(") < ys2.index("set_thumbnail(") < ys2.index("add_captions("), "the video is recorded even when the thumbnail or captions call fails"
    import tempfile as _tf
    hf = os.path.join(_tf.mkdtemp(), "hold"); open(hf, "w").write("2060 Learnings clip missed; rebuild before publishing\n# note\n2061\n")
    assert held_days(hf) == {2060: "Learnings clip missed; rebuild before publishing", 2061: ""} and held_days(hf + "x") == {}
    assert "days = [d for d in days if d not in hold]" in inspect.getsource(run), "a held day never publishes"
    fsrc = inspect.getsource(finish_extras)
    assert fsrc.index("spotify.verify_published(ptitle") < fsrc.index("run_spotify(day"), "a retried podcast looks at Spotify before it uploads"
    # 15 Sep 2026: a media upload that raises SystemExit must not end the hourly run (1841's mp3 did, hourly)
    real_media, real_files, real_drive = globals()["media_for"], globals()["episode_files"], globals()["full_from_drive"]
    real_fetch, real_run_spotify = globals()["fetch_readable"], globals()["run_spotify"]
    def boom(day, entry, kinds): raise SystemExit("media upload failed for Ep1841_Podcast.mp3: ")
    def no_browser(*a, **k): raise AssertionError("a selftest reached the Spotify browser lane")
    globals()["media_for"] = boom; globals()["episode_files"] = lambda day: {k: "/nonexistent/%s" % k for k in ("full", "podcast", "thumb")}
    globals()["full_from_drive"] = lambda day, work=None: None      # never the network in a selftest
    # 15-17 Sep 2026: this test reached the real Drive API, the attachments folder and the Spotify browser lane, and
    # left two empty "Day 1841" drafts on Spotify. Every outside call is faked here.
    globals()["fetch_readable"] = lambda day, kind, ledger=None, download=None: "/nonexistent/%s" % kind
    globals()["run_spotify"] = no_browser
    try:
        ent = {"youtube_link": "https://youtu.be/x", "blog": {"url": "https://runpreneur.org.uk/blog/b/y"}}
        out = finish_extras(1841, ent, {"Long Form Video": {"id": "recX", "fields": {}}}, True, lambda: None)
        assert out == [] and "media upload failed" in ent["podcast"]["audio_error"], ent
    finally:
        globals()["media_for"], globals()["episode_files"], globals()["full_from_drive"] = real_media, real_files, real_drive
        globals()["fetch_readable"], globals()["run_spotify"] = real_fetch, real_run_spotify
    src = inspect.getsource(sync); assert "import platform_copy" not in src, "sync must use the module-level pc: an import inside the function made pc a local and crashed every sync (10 Sep 2026, 07:15)"
    assert 'if not str(day).isdigit() or not isinstance(entry, dict): continue' in src, "sync skips the cursor and the held posts"
    assert may_go_to_youtube(2054, gaps, st, led, {1799, 2054}) and st[CURSOR_KEY] == 2053, "a gap day in the approved set does not disturb the order"
    assert not moves_cursor(1799, gaps) and moves_cursor(2054, gaps)
    assert "twitter" not in CHANNELS
    assert "YouTube Link" in LINK_FIELDS[("youtube", "full")] and "TikTok Link" in LINK_FIELDS[("tiktok", "summary")] and "Facebook Post Link" in LINK_FIELDS[("facebook", "summary")]
    assert "LinkedIn Link" in LINK_FIELDS[("linkedin", "summary")] and "Threads Link" in LINK_FIELDS[("threads", "summary")], "the fields Ericamae's pages read"
    assert CLIP_FILES["podcast"] == "Ep%d_Podcast.mp3"
    import inspect as _i3; src3 = _i3.getsource(finish_extras); assert 'run_spotify(day, card_task(day, full)' in src3, "Spotify is gated on the approval CARD, never the episode record (14 Sep 2026)"
    import inspect as _i2; src2 = _i2.getsource(schedule_stage); assert "youtube_direct_ready()" in src2 and src2.index("youtube_direct_ready()") < src2.index("create_post(body)"), "the API route is tried before GoHighLevel"
    ys = _i2.getsource(youtube_direct); assert 'fetch_readable(day, clip)' in ys and '"_srt"' in ys and 'privacy="unlisted" if test else "private"' in ys and "publish_at=None if test else when" in ys
    ss = _i2.getsource(sync); assert 'p.get("route") == "api"' in ss and 'p["status"] = "published"' in ss, "API uploads flip to published on their slot without asking GoHighLevel"
    import inspect as _i
    assert "share_to_facebook_profile(day, entry, state, clip=clip)" in _i.getsource(sync) and "signin-needed" in _i.getsource(share_to_facebook_profile), "the profile share runs from sync, on the page post, and waits for sign-in"
    # Kevin, 20 Sep 2026: the page publishes two posts a day and only the summary ever reached his profile
    assert set(FB_SHARES) == {"summary", "lfmd"} and FB_SHARES["summary"]["key"] == "facebook_share", "both page posts are shared, and the summary keeps the original state key"
    assert FB_SHARES["lfmd"]["key"] != FB_SHARES["summary"]["key"] and FB_SHARES["lfmd"]["field"] == "Facebook Post Copy", "the Learnings post has its own state and its own copy field"
    # both posts publish as reels on the page, so both are found on the same list (checked live 20 Sep 2026:
    # the page timeline exposes no post links at all, while /reels carries both a day)
    assert not any("timeline" in v for v in FB_SHARES.values()), "there is one list, and it is the reels list"
    assert set(FB_SHARES["lfmd"]) == set(FB_SHARES["summary"]) == {"key", "record", "field"}
    assert "for clip in FB_SHARES" in _i.getsource(sync), "sync shares every configured page post, not just the first"
    # catching up is paced: twelve missing Learnings shares must not land on Kevin's profile at once
    now_t = dt.datetime(2026, 9, 20, 12, 0, tzinfo=dt.timezone.utc)
    fresh = {"scheduled": "2026-09-20T09:00:00Z"}
    old_post = {"scheduled": "2026-09-11T09:00:00Z"}
    assert not is_catchup(fresh, now_t) and is_catchup(old_post, now_t), "today's episode is never held; last week's is"
    assert not is_catchup({}, now_t), "a post with no time is treated as today's, never silently deferred"
    # ONLY a catch-up spends the catch-up budget. Counting every share froze the queue: today's episode
    # presses two of its own, which filled a budget of two, so no catch-up could ever fire again.
    st = {"2060": {"facebook_share": {"shared_at": "2026-09-20T08:00:00Z", "catchup": True},
                   "facebook_share_lfmd": {"shared_at": "2026-09-20T08:30:00Z", "catchup": True}},
          "2059": {"facebook_share": {"shared_at": "2026-09-19T08:00:00Z", "catchup": True}}, "_cursor": 2061}
    assert catchups_pressed_today(st, now_t) == 2 and FB_CATCHUP_PER_DAY == 2, "both clips count toward the day's pace"
    today_own = {"2061": {"facebook_share": {"shared_at": "2026-09-20T09:00:00Z", "catchup": False},
                          "facebook_share_lfmd": {"shared_at": "2026-09-20T09:05:00Z", "catchup": False}}}
    assert catchups_pressed_today(today_own, now_t) == 0, "today's own episode never spends the catch-up budget"
    assert catchups_pressed_today({"2059": {"facebook_share": {"shared_at": "rubbish", "catchup": True}}}, now_t) == 0, "an unreadable stamp never blocks the pace"
    # an episode with no Learnings post on the page is not an episode missing a share (1841, 20 Sep 2026)
    only_summary = {"posts": {"facebook|summary|f": {"platform": "facebook", "clip": "summary", "status": "published"}},
                    "facebook_share": {"status": "shared"}, "facebook_share_lfmd": {}}
    assert section_status(only_summary)["Facebook share"] == "done", "a clip the page never carried is not counted"
    assert section_status({"posts": {}})["Facebook share"] == "missing", "no Facebook post at all is still missing"
    ssrc3 = _i.getsource(share_to_facebook_profile)
    assert 'fb["status"] = "queued"' in ssrc3 and ssrc3.index("is_catchup(post)") < ssrc3.index("run_plan"), "the pace is checked before Share is ever pressed"
    assert 'fb["catchup"] = catchup' in ssrc3, "every share records whether it was a catch-up, so the budget can be counted"
    assert "queued" in _i.getsource(section_status), "a queued share reads pending, not missing"
    assert "SCAN_POSTS_CATCHUP if is_catchup(post)" in ssrc3, "a catch-up searches further back than today's post does"

    fsrc = _i.getsource(share_to_facebook_profile); assert "find_page_post" in fsrc and "verify_shared" in fsrc, "it shares the page post and checks the profile afterwards"
    assert fsrc.index('"status": "sharing"') < fsrc.index("run_plan(") and fsrc.index("save_state(state)") < fsrc.index("run_plan("), "the share is on disk before Share is pressed"
    assert re.search(r"except Exception as ex:\s+# a page read timed out", _i.getsource(sync)), "a failing share never ends the run"
    rsrc = _i.getsource(run); assert 'stage_for(entry, yt_ok) == "socials"' in rsrc and rsrc.count("schedule_stage(") == 3 and rsrc.count("fill_learnings(") == 2 and "broken_uploads" in rsrc, "both stages run the same day, and a broken upload is replaced once"
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
    _selftest_once_only()
    import inspect as _i5; ss = _i5.getsource(sync); assert ss.index("monetise_long_video(day, entry)") < ss.index("share_to_facebook_profile(day, entry, state, clip=clip)"), "monetisation is checked every sync"
    msrc = _i5.getsource(monetise_long_video)
    # the old filter stepped over every GoHighLevel upload in silence: 2054 episode + Short and 2195 episode (20 Sep 2026)
    assert 'p.get("route") == "api"' not in msrc, "posts are matched by video id, never by upload route"
    assert "youtube_ads.video_id(entry, p)" in msrc and "NO_VIDEO_ID" in msrc, "an unresolvable upload is reported, never skipped"
    assert "youtube_ads.midroll" in msrc and "MIDROLL_SETTLED" in msrc, "mid-roll ads are set as part of publishing"
    rsrc2 = _i5.getsource(report)
    assert 'p.get("route") == "api"' not in rsrc2 and "mid-roll" in rsrc2, "the morning report shows every upload, and the mid-roll backlog"
    ms = _i5.getsource(monetise_long_video) + _i5.getsource(_recheck_due)
    assert "MONETISE_RECHECK_HOURS" in ms and "needs-rating" in ms, "a video waiting for the rating is re-checked, not hammered"
    assert _recheck_due(None) and not _recheck_due(now_utc()) and _recheck_due("rubbish"), "a missing or unreadable stamp re-checks rather than blocking for ever"
    assert 'certify_none=approved' in ms and '.get("verdict") == "approved"' in ms, "the rating is answered only for an approved card"
    rp = _i5.getsource(report); assert "content monetisation:" in rp and "content posts to check once:" in rp, "the morning report shows both"
    # 21 Sep 2026: a 'published' episode with no link is asked again, for three days, then left alone
    t0 = dt.datetime(2026, 9, 21, 12, 0, tzinfo=dt.timezone.utc)
    assert spotify_link_due({"title": "Episode 2061 - x", "status": "published", "started": "2026-09-19T05:00:00Z"}, t0), "2061's case: published, no link"
    assert spotify_link_due({"title": "t", "status": "processing"}, t0), "processing is still asked"
    assert not spotify_link_due({"title": "t", "status": "published", "started": "2026-09-19T05:00:00Z", "link": "https://open.spotify.com/episode/x"}, t0), "a link ends it"
    assert not spotify_link_due({"title": "t", "status": "published", "started": "2026-09-17T11:00:00Z"}, t0), "after three days the page no longer shows it"
    assert not spotify_link_due({"title": "t", "status": "failed", "started": "2026-09-21T05:00:00Z"}, t0) and not spotify_link_due({"status": "published"}, t0)
    assert not spotify_link_due({"title": "t", "status": "processing", "started": "2026-09-10T05:00:00Z"}, t0), "an old 'processing' episode is no longer asked every hour for good"
    assert not spotify_link_due({"title": "t", "status": "published"}, t0), "no start time and published: nothing to measure three days from"
    print(json.dumps({"checks": 54, "failed": []}))


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
