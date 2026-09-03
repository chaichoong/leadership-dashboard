#!/usr/bin/env python3
"""blog.py — the Runpreneur blog article, published through GoHighLevel's Blog API.

runpreneur.org.uk is a GoHighLevel site ("Runprenuer Blog", id YvavGIzJ2jDX8gs9CjYZ), which is
where Ericamae published every article by hand (SOP 59). The engine writes the same article
from the record's Blog Copy: the "SEO Title:" line is the title, blank-line paragraphs become
<p>, short unpunctuated lines become <h2>, the thumbnail is the header image, the category is
"Runpreneur Episodes", the author is Kevin, and the full episode link goes at the end. In TEST
mode the post is created as a DRAFT; live mode publishes it. The link written back is the
same shape as hers: https://runpreneur.org.uk/blog/b/<slug>.
"""
import datetime as dt, json, re, sys, os
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)

BLOG_ID = "YvavGIzJ2jDX8gs9CjYZ"           # "Runprenuer Blog" (GET /blogs/site/all, 3 Sep 2026)
AUTHOR_ID = "664c9f4ffb724c00fb3e5f15"     # Kevin Brittain (GET /blogs/authors)
CATEGORY_ID = "68343b9b51b930b70127261a"   # "Runpreneur Episodes" (GET /blogs/categories)
SITE = "https://runpreneur.org.uk/blog/b/"
TAGS = ["Runpreneur", "Diary of a Runpreneur"]


def blog_parts(blog_copy, day):
    """(title, html, first paragraph). Title from the 'SEO Title:' line, else a plain fallback."""
    text = (blog_copy or "").strip()
    m = re.search(r"SEO Title:\s*(.+)", text)
    title = (m.group(1).strip() if m else "Diary of a Runpreneur, Day %d" % day)[:150]
    body = re.sub(r"^SEO Title:.*\n?", "", text, flags=re.M).strip()
    paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    html, first = [], ""
    for p in paras:
        one = " ".join(p.split())
        if len(one) <= 70 and not re.search(r"[.!?:]$", one) and len(paras) > 1:
            html.append("<h2>%s</h2>" % esc(one))
        else:
            html.append("<p>%s</p>" % esc(one))
            first = first or one
    return title, "\n".join(html), first


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def slug_for(title, day):
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    s = s[:90].rstrip("-")
    if ("day-%d" % day) not in s: s += "-day-%d" % day
    return s


def build_post(loc, day, blog_copy, description, thumb_url, youtube_link, status, when=None):
    title, html, first = blog_parts(blog_copy, day)
    if youtube_link:
        html += '\n<p>Watch the full episode: <a href="%s">%s</a></p>' % (youtube_link, youtube_link)
    desc = (description or first or title).strip()[:300]
    return {"title": title, "locationId": loc, "blogId": BLOG_ID, "imageUrl": thumb_url or "", "imageAltText": title,
            "description": desc, "rawHTML": html, "status": status, "categories": [CATEGORY_ID], "tags": TAGS,
            "author": AUTHOR_ID, "urlSlug": slug_for(title, day),
            "publishedAt": (when or dt.datetime.now(dt.timezone.utc)).strftime("%Y-%m-%dT%H:%M:%S.000Z")}


def publish_blog(day, full, entry, thumb_url, youtube_link, test):
    """Create the post through GHL; returns (post id, public url). Idempotent through entry['blog']."""
    import publish
    if entry.get("blog", {}).get("id"): return entry["blog"]["id"], entry["blog"]["url"]
    _, loc, _ = publish._cfg()
    f = full["fields"]
    body = build_post(loc, day, f.get("Blog Copy"), f.get("Blog Post Description"), thumb_url, youtube_link, "DRAFT" if test else "PUBLISHED")
    if not f.get("Blog Copy"): raise SystemExit("episode %d has no Blog Copy" % day)
    exists = publish.ghl("GET", "/blogs/posts/url-slug-exists?locationId=%s&urlSlug=%s" % (loc, body["urlSlug"]))
    if (exists.get("exists") if isinstance(exists, dict) else False):
        body["urlSlug"] += "-%s" % dt.date.today().strftime("%d%m")
    r = publish.ghl("POST", "/blogs/posts", body)
    post = (r.get("data") or r)
    pid = post.get("_id") or post.get("id") or ""
    url = SITE + body["urlSlug"]
    entry["blog"] = {"id": pid, "url": url, "status": body["status"], "created": dt.datetime.now().isoformat(timespec="seconds")}
    return pid, url


def selftest():
    copy = "SEO Title: Running Off-Road at Pace (Day 2195)\n\nDay 2195. First paragraph here.\n\nSurface awareness\n\nRead the ground ahead of you. Every root.\n\nCheck the link in the comments."
    t, h, first = blog_parts(copy, 2195)
    assert t == "Running Off-Road at Pace (Day 2195)" and h.startswith("<p>Day 2195. First paragraph here.</p>") and "<h2>Surface awareness</h2>" in h and first == "Day 2195. First paragraph here.", (t, h[:80], first)
    assert blog_parts("", 7)[0] == "Diary of a Runpreneur, Day 7"
    assert slug_for("Running Off-Road at Pace (Day 2195)", 2195) == "running-off-road-at-pace-day-2195"
    assert slug_for("Kids & work: try this!", 3) == "kids-work-try-this-day-3"
    b = build_post("loc1", 2195, copy, "A short description.", "https://cdn/t.png", "https://youtu.be/x", "DRAFT")
    assert b["status"] == "DRAFT" and b["categories"] == [CATEGORY_ID] and b["author"] == AUTHOR_ID and b["blogId"] == BLOG_ID
    assert 'href="https://youtu.be/x"' in b["rawHTML"] and b["imageUrl"] == "https://cdn/t.png" and b["description"] == "A short description."
    assert "<script" not in build_post("l", 1, "SEO Title: x\n\n<script>alert(1)</script>", "", "", "", "DRAFT")["rawHTML"], "copy is escaped"
    assert b["publishedAt"].endswith("Z")
    print(json.dumps({"checks": 9, "failed": []}))


if __name__ == "__main__":
    if sys.argv[1:] == ["selftest"]: selftest()
    else: raise SystemExit("usage: blog.py selftest (publishing runs from publish.py stage 2)")
