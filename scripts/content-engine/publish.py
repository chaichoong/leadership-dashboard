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
YT_SLOT, SUMMARY_SLOT, LFMD_SLOT = (6, 0), (9, 0), (17, 0)     # London hours; the team posted around 08:00-09:00 UK
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
              "podcast": "Ep%d_Podcast.mp3"}
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


def media_for(day, entry, kinds):
    files = episode_files(day); media = entry.setdefault("media", {})
    for k in kinds:
        if media.get(k): continue
        if not os.path.exists(files[k]):
            if k in ("thumb", "podcast"): continue
            raise SystemExit("episode %d: %s is not in the edited folder (%s)" % (day, k, files[k]))
        media[k] = upload_media(files[k])
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


def schedule_stage(day, entry, recs, acct_map, stage, dry_run=False):
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
            if stage == 2: copy = with_youtube_link(copy, entry["youtube_link"])
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
        when = slot_iso(day_london, spec["slot"])
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
        if os.path.exists(files["full"]):
            plan_path, ptitle = spotify.write_plan(day, files["full"], ff.get("Podcast Copy"), entry["youtube_link"], test, os.path.dirname(STATE))
            entry.setdefault("podcast", {})["plan"] = plan_path
            what += "; Spotify plan written (%s)" % ("draft, test mode" if test else "publish")
    fields["Notes"] = approval.append_note(full, "%s: %s through GoHighLevel." % (dt.date.today().isoformat(), what))
    watch._airtable("PATCH", watch.API + "/" + full["id"], {"fields": fields})
    return len(todo)


def run(dry_run=False, limit=2):
    state = load_state(); days = approved_days()
    if not days: print("publish: no approved episodes"); return
    acct_map = account_map(accounts()); yt_ok = "youtube" in acct_map
    done = 0
    for day in days:
        entry = state.setdefault(str(day), {})
        recs = bundle(day)
        full = recs["Long Form Video"]
        if not full or full["fields"].get("Record Status") not in PUBLISHABLE:
            continue
        stage = stage_for(entry, yt_ok)
        if stage == "wait-youtube-account":
            print("episode %d: approved, waiting for a YouTube account in GoHighLevel (Kevin's click: publish.py youtube-link)" % day); continue
        if stage == "wait-youtube-link":
            print("episode %d: YouTube post scheduled, waiting for it to publish before the socials go out" % day); continue
        if stage == "done":
            continue
        if done >= limit: break
        n = schedule_stage(day, entry, recs, acct_map, 1 if stage == "youtube" else 2, dry_run)
        done += 1 if n else 0
        if not dry_run: save_state(state)


def sync():
    """GHL post statuses -> links on the record; the YouTube link unlocks stage 2; all published -> Published."""
    state = load_state(); _, loc, _ = _cfg()
    for day, entry in state.items():
        posts = entry.get("posts", {})
        if not posts: continue
        changed = False; links = {}; clip_links = {}
        for key, p in posts.items():
            if p.get("status") in ("published", "draft"): continue     # a draft (test mode) never moves on its own
            try:
                g = ghl("GET", "/social-media-posting/%s/posts/%s" % (loc, p["id"]))
            except SystemExit as ex:
                print("episode %s: cannot read post %s (%s)" % (day, p["id"], str(ex)[:120])); continue
            post = (g.get("results") or g).get("post") or g
            st = post.get("status"); link = post.get("previewLink") or ""
            if st != p.get("status"): p["status"] = st; changed = True
            if st == "failed": p["error"] = str(post.get("error"))[:200]; print("episode %s: %s post FAILED: %s" % (day, p["platform"], p["error"]))
            if st == "published" and link:
                p["link"] = link; changed = True
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


def report():
    state = load_state(); days = approved_days()
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
    assert "twitter" not in CHANNELS
    assert "YouTube Link" in LINK_FIELDS[("youtube", "full")] and "TikTok Link" in LINK_FIELDS[("tiktok", "summary")] and "Facebook Post Link" in LINK_FIELDS[("facebook", "summary")]
    assert "LinkedIn Link" in LINK_FIELDS[("linkedin", "summary")] and "Threads Link" in LINK_FIELDS[("threads", "summary")], "the fields Ericamae's pages read"
    assert CLIP_FILES["podcast"] == "Ep%d_Podcast.mp3"
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
    print(json.dumps({"checks": 34, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("--day", type=int, default=0); ap.add_argument("--limit", type=int, default=2); ap.add_argument("--dry-run", action="store_true")
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
    elif a.mode == "report": report()
    elif a.mode == "youtube-link": youtube_link()
    else: raise SystemExit("usage: publish.py run [--dry-run] [--limit N] | plan --day N | sync | report | youtube-link | selftest")
