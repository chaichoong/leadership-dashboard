#!/usr/bin/env python3
"""Content Engine performance read (Kevin, 8 Sep 2026: "once a month, last 30 days... a performance read... three
recommendations that become lessons"). The Chen chain's measure step: the engine publishes every day, and once a
month it reads what the numbers say and proposes what to change.

  performance.py snapshot          # weekly: GoHighLevel's rolling 7-day totals per platform -> performance.json
  performance.py run [--days 30]   # monthly: YouTube counts for every episode published in the window (public
                                   # watch pages, no login), the stored weekly platform totals, stats written onto
                                   # the episode records, ONE card in Kevin's queue with three recommendations
  performance.py sync              # Kevin's verdict on the card: approved -> the recommendations become lessons in
                                   # the agent file and the register's learning log; rejected -> his reason is kept
  performance.py selftest

Sources, so every number on the card has one:
- YouTube views and likes: the public watch page's player data (viewCount, likeCount, publishDate, lengthSeconds).
  yt-dlp is throttled after a few dozen calls (8 Sep 2026: "The page needs to be reloaded"); the page fetch is not.
- Platform totals: GoHighLevel POST /social-media-posting/statistics per connected profile. It answers for the
  last SEVEN days only, whatever dates are asked for (tested 8 Sep 2026), so `snapshot` stores each week and `run`
  sums the weeks inside the window. A month with fewer than four snapshots says so on the card.
- Episode records: the Content Machine table's own stats fields (the emoji set that "Engagements Total" sums), which
  Ericamae's process never filled (0 of 357 records on 3 Sep 2026).
State lives outside the public repo, next to the ledger: ~/knowledge-os/logs/content-engine/performance.json.
"""
import argparse, datetime as dt, importlib.util, json, os, re, statistics, subprocess, sys, tempfile, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import watch  # noqa: E402
import publish  # noqa: E402
import approval  # noqa: E402
import platform_copy as pc  # noqa: E402

STATE = os.path.join(os.path.dirname(watch.LEDGER), "performance.json")
CHANNEL = "https://www.youtube.com/@runpreneur/videos"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
YTDLP = os.path.expanduser("~/Library/Python/3.9/bin/yt-dlp")
REGISTER_ROW = "recNaC0N5KiTGBPNy"
AGENT_SLUG = "content-engine"
CARD_TYPE = "Analysis"
STAT_FIELDS = {"views": "👀 Views (YT)", "likes": "👍🏻 Likes (YT)"}   # the set "Engagements Total" sums (read 8 Sep 2026)
PLATFORMS = ("youtube", "facebook", "instagram", "linkedin", "threads", "tiktok")
GA_PROPERTY = "p553283476"     # Google Analytics "Runpreneur website", created by Kevin on 8 Sep 2026 under kevin@runpreneur.org.uk (tag G-VSEK293KRE)
AGENT_BROWSER = os.path.join(os.path.dirname(os.path.dirname(HERE)), "scripts", "agent-browser.js")
CLOSING = approval.CLOSING


# ---------- pure helpers (selftested) ----------

def parse_watch_page(html):
    """viewCount / likeCount / publishDate / lengthSeconds / title out of a YouTube watch page. None when absent."""
    out = {}
    for k in ("viewCount", "likeCount", "publishDate", "lengthSeconds", "title"):
        m = re.search(r'"%s":\s*"?([^",}]+)' % k, html)
        out[k] = m.group(1) if m else None
    for k in ("viewCount", "likeCount", "lengthSeconds"):
        try: out[k] = int(out[k]) if out[k] is not None else None
        except ValueError: out[k] = None
    return out


def episode_number(title):
    m = re.search(r"Ep\s?(\d{3,4})\b", title or "") or re.search(r"\bDay\s+(\d{3,4})\b", title or "")
    return int(m.group(1)) if m else None


def video_id(link):
    m = re.search(r"(?:v=|youtu\.be/|/shorts/)([A-Za-z0-9_-]{11})", link or "")
    return m.group(1) if m else None


def in_window(publish_date, start, end):
    d = (publish_date or "")[:10]
    return bool(d) and start.isoformat() <= d <= end.isoformat()


def summarise(videos):
    """The numbers the card and the model both see. Median, not mean: one video that takes off should not hide a
    quiet month, and Kevin wants accuracy over hype."""
    vs = [v for v in videos if v.get("views") is not None]
    if not vs: return {"count": 0}
    views = [v["views"] for v in vs]
    by = sorted(vs, key=lambda v: (-v["views"], v.get("episode") or 0))
    short = [v for v in vs if (v.get("seconds") or 0) <= 150]
    long_ = [v for v in vs if (v.get("seconds") or 0) > 150]
    return {"count": len(vs), "views_total": sum(views), "views_median": int(statistics.median(views)),
            "likes_total": sum(v.get("likes") or 0 for v in vs), "top": by[:5], "bottom": by[-5:][::-1],
            "shorts_median": int(statistics.median([v["views"] for v in short])) if short else None,
            "long_median": int(statistics.median([v["views"] for v in long_])) if long_ else None}


def weeks_in_window(snapshots, start, end):
    """Weekly GoHighLevel snapshots whose 7-day window ends inside [start, end]."""
    return [s for s in snapshots if start.isoformat() <= s["taken"][:10] <= end.isoformat()]


def platform_totals(weeks):
    tot = {}
    for w in weeks:
        for plat, t in w.get("platforms", {}).items():
            cur = tot.setdefault(plat, {"posts": 0, "impressions": 0, "likes": 0, "comments": 0, "followers": 0})
            for k in cur: cur[k] += int(t.get(k) or 0)
    return tot


def no_em_dashes(text):
    return text.replace("—", ",").replace("–", "-")


def parse_recommendations(text):
    """Three numbered lines out of the model's answer; anything else is a refusal to guess."""
    recs = [re.sub(r"^\s*\d[.)]\s*", "", l).strip() for l in text.splitlines() if re.match(r"^\s*\d[.)]\s+\S", l)]
    return recs[:3] if len(recs) >= 3 else []


def parse_ga_text(text):
    """Active users / views / new users out of the Google Analytics reports-snapshot text the robot browser reads.
    The page renders each metric as a label line followed by the number line. None when the page said nothing."""
    out = {}
    lines = [l.strip() for l in (text or "").splitlines()]
    for label, key in (("Active users", "active_users"), ("Views", "views"), ("New users", "new_users"), ("Event count", "events")):
        for i, l in enumerate(lines[:-1]):
            if l == label and re.fullmatch(r"[\d,\.]+[KM]?", lines[i + 1]):
                n = lines[i + 1]; mult = 1000 if n.endswith("K") else 1000000 if n.endswith("M") else 1
                out[key] = int(float(n.rstrip("KM").replace(",", "")) * mult); break
    return out or None


def ga_url(start, end):
    return ("https://analytics.google.com/analytics/web/#/%s/reports/reportinghub?params=_u..nav%%3Dmaui%%26_u.date00%%3D%s%%26_u.date01%%3D%s"
            % (GA_PROPERTY, start.strftime("%Y%m%d"), end.strftime("%Y%m%d")))


def ga_traffic(start, end):
    """Site traffic for the window, read off the Google Analytics page in the robot browser (the property owner's
    login; there is no API key to keep). Returns a dict or None, never raises: absence is reported on the card."""
    try:
        r = subprocess.run(["node", AGENT_BROWSER, "read", "--url", ga_url(start, end), "--wait", "20000"], capture_output=True, text=True, timeout=180)
        d = json.loads(r.stdout.strip().splitlines()[-1]) if r.returncode == 0 and r.stdout.strip() else {}
        return parse_ga_text(d.get("text", ""))
    except Exception as ex:
        print("ga: not read (%s)" % str(ex)[:100], file=sys.stderr); return None


def build_card(start, end, summary, totals, weeks_count, recs, note="", ga=None):
    name = "CONTENT: Performance read %s to %s (Runpreneur)" % (start.strftime("%-d %b"), end.strftime("%-d %b %Y"))
    lines = ["Performance read for the Runpreneur channels, %s to %s. Approve to turn the three recommendations into lessons the engine applies from the next episode; reject with your reason and it keeps that instead." % (start.strftime("%-d %B"), end.strftime("%-d %B %Y")), ""]
    if summary.get("count"):
        lines += ["**YouTube, %d videos published in the window (public counts, read %s)**" % (summary["count"], dt.date.today().strftime("%-d %b")),
                  "- Views: %s total, median %s a video. Likes: %s." % (f"{summary['views_total']:,}", f"{summary['views_median']:,}", f"{summary['likes_total']:,}")]
        if summary.get("shorts_median") is not None and summary.get("long_median") is not None:
            lines.append("- Median views, clips under 2.5 minutes: %s. Full episodes: %s." % (f"{summary['shorts_median']:,}", f"{summary['long_median']:,}"))
        lines.append("- Top five:")
        lines += ["  %d. %s views, Ep %s, %s" % (i + 1, f"{v['views']:,}", v.get("episode") or "?", v["title"][:80]) for i, v in enumerate(summary["top"])]
        lines.append("- Bottom five:")
        lines += ["  %d. %s views, Ep %s, %s" % (i + 1, f"{v['views']:,}", v.get("episode") or "?", v["title"][:80]) for i, v in enumerate(summary["bottom"])]
    else:
        lines.append("**YouTube:** no videos with a publish date inside the window were found on the channel.")
    lines.append("")
    if totals:
        lines.append("**Other platforms (GoHighLevel, %d weekly snapshot%s in the window)**" % (weeks_count, "" if weeks_count == 1 else "s"))
        for plat in PLATFORMS:
            t = totals.get(plat)
            if t: lines.append("- %s: %d posts, %s impressions, %d likes, %d comments, %d new followers." % (plat.capitalize(), t["posts"], f"{t['impressions']:,}", t["likes"], t["comments"], t["followers"]))
        if weeks_count < 4: lines.append("- Fewer than four weeks stored, so these are partial: the weekly snapshot started on 8 Sep 2026.")
    else:
        lines.append("**Other platforms:** no weekly GoHighLevel snapshots inside the window yet (the first is taken the Monday after 8 Sep 2026). Nothing to report, so nothing is claimed.")
    lines.append("")
    if ga:
        lines.append("**Website (Google Analytics, runpreneur.org.uk):** %s active users, %s page views, %s new users." % (
            f"{ga.get('active_users', 0):,}", f"{ga.get('views', 0):,}", f"{ga.get('new_users', 0):,}"))
    else:
        lines.append("**Website:** Google Analytics gave no figures for the window (the property started on 8 Sep 2026, or the page could not be read). Nothing is claimed.")
    lines.append("")
    lines.append("**Three recommendations (each becomes a lesson if you approve)**")
    lines += ["%d. %s" % (i + 1, r) for i, r in enumerate(recs)]
    if note: lines += ["", note]
    lines += ["", "%s writing the three recommendations into the Content Engine's lessons (the agent file and its register row) so the next episode's titles, copy and thumbnails follow them. Nothing is published or changed on any platform by this card." % CLOSING]
    return name, "\n".join(lines)


# ---------- IO ----------

def load_state():
    if os.path.exists(STATE): return json.load(open(STATE))
    return {"snapshots": [], "reads": {}}


def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    json.dump(state, open(tmp, "w"), indent=1, sort_keys=True)
    os.replace(tmp, STATE)


def fetch_watch(vid):
    req = urllib.request.Request("https://www.youtube.com/watch?v=" + vid, headers={"User-Agent": UA, "Accept-Language": "en-GB,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return parse_watch_page(r.read().decode("utf-8", "replace"))


def channel_listing(limit=80):
    """id + title for the newest uploads, no counts (the flat listing carries none)."""
    r = subprocess.run([YTDLP, "--flat-playlist", "-j", "--no-warnings", "--playlist-end", str(limit), CHANNEL], capture_output=True, text=True)
    out = []
    for line in r.stdout.splitlines():
        try: d = json.loads(line)
        except ValueError: continue
        if d.get("id"): out.append({"id": d["id"], "title": d.get("title") or ""})
    return out


def youtube_window(start, end, limit=80):
    """Every channel video published in the window with its counts. Stops at the first video older than the
    window once past the first page of results, so a 30-day read costs about 30 fetches."""
    vids, older = [], 0
    for item in channel_listing(limit):
        try: p = fetch_watch(item["id"])
        except Exception as ex:
            print("youtube: %s not read (%s)" % (item["id"], str(ex)[:80]), file=sys.stderr); continue
        pub = (p.get("publishDate") or "")[:10]
        if pub and pub < start.isoformat():
            older += 1
            if older >= 3: break
            continue
        if not in_window(pub, start, end): continue
        vids.append({"id": item["id"], "title": p.get("title") or item["title"], "episode": episode_number(p.get("title") or item["title"]),
                     "published": pub, "views": p.get("viewCount"), "likes": p.get("likeCount"), "seconds": p.get("lengthSeconds")})
    return vids


def ghl_snapshot():
    """GoHighLevel's 7-day totals per connected profile, one call per account. Never raises for one platform."""
    loc = publish._cfg()[1]
    plats = {}
    for a in publish.accounts():
        pid, plat = a.get("profileId"), a.get("platform")
        if not pid or not plat: continue
        try:
            r = publish.ghl("POST", "/social-media-posting/statistics?locationId=" + loc, {"profileIds": [pid]})["results"]
        except BaseException as ex:
            print("snapshot: %s not read (%s)" % (plat, str(ex)[-100:].replace("\n", " ")), file=sys.stderr); continue
        t = r.get("totals", {}); cur = plats.setdefault(plat, {"posts": 0, "impressions": 0, "likes": 0, "comments": 0, "followers": 0})
        for k in cur: cur[k] += int(t.get(k) or 0)     # two LinkedIn profiles (page + Kevin) add up
    return plats


def snapshot():
    state = load_state()
    today = dt.date.today().isoformat()
    if any(s["taken"][:10] == today for s in state["snapshots"]): print("snapshot: already taken today"); return
    plats = ghl_snapshot()
    state["snapshots"].append({"taken": dt.datetime.now().isoformat(timespec="seconds"), "days": 7, "platforms": plats})
    save_state(state)
    print("snapshot: " + ", ".join("%s %s impressions" % (p, f"{t['impressions']:,}") for p, t in sorted(plats.items())))


def write_record_stats(vids):
    """Views and likes onto the episode record the video belongs to, matched by the YouTube link on the record."""
    written = 0
    for v in vids:
        if v.get("views") is None: continue
        q = 'FIND("%s", {YouTube Link})' % v["id"]
        r = watch._airtable("GET", watch.API + "?maxRecords=1&filterByFormula=" + urllib.parse.quote(q))
        recs = r.get("records", [])
        if not recs: continue
        fields = {STAT_FIELDS["views"]: int(v["views"])}
        if v.get("likes") is not None: fields[STAT_FIELDS["likes"]] = int(v["likes"])
        watch._airtable("PATCH", watch.API + "/" + recs[0]["id"], {"fields": fields}); written += 1
    return written


SYSTEM = """You are the Content Engine's analyst for Kevin Brittain's Runpreneur channel (a daily run vlog: barefoot-style running streak, business learnings, raising money for children's charities). You read a month of numbers and propose exactly three changes to how the next month's episodes are titled, cut, described or scheduled. Rules: every recommendation must point at a number in the data you are given, and say which; never invent a figure; never recommend hype, clickbait or claims; UK English; no em dashes; no hashtags; each recommendation is one or two plain sentences an editor can act on tomorrow; do not name other creators or experts. Answer with three numbered lines and nothing else."""


def recommend(summary, totals):
    """Three recommendations on the standard tier. ask_claude adds Kevin's lessons to the system prompt itself."""
    data = {"youtube": {k: v for k, v in summary.items() if k not in ("top", "bottom")},
            "youtube_top": [{"views": v["views"], "seconds": v.get("seconds"), "title": v["title"]} for v in summary.get("top", [])],
            "youtube_bottom": [{"views": v["views"], "seconds": v.get("seconds"), "title": v["title"]} for v in summary.get("bottom", [])],
            "other_platforms": totals}
    user = "The month's data (JSON):\n%s\n\nGive the three recommendations." % json.dumps(data, indent=1)
    text, _, _ = pc.ask_claude(SYSTEM, user, timeout=300, no_mcp=True)
    recs = parse_recommendations(no_em_dashes(text))
    if not recs: raise SystemExit("performance: the model did not return three numbered recommendations; nothing raised")
    return recs


def run(days=30, dry_run=False, no_records=False):
    end = dt.date.today() - dt.timedelta(days=1)
    start = end - dt.timedelta(days=days - 1)
    state = load_state()
    key = end.isoformat()
    if state["reads"].get(key, {}).get("task") and not dry_run:
        print("performance: read to %s already has card %s" % (key, state["reads"][key]["task"])); return
    vids = youtube_window(start, end)
    summary = summarise(vids)
    weeks = weeks_in_window(state["snapshots"], start, end)
    totals = platform_totals(weeks)
    written = 0 if (dry_run or no_records) else write_record_stats(vids)
    ga = ga_traffic(start, end)
    recs = recommend(summary, dict(totals, website=ga) if ga else totals)
    note = ("Stats written onto %d episode records (the table's own views and likes fields)." % written) if written else ""
    name, out = build_card(start, end, summary, totals, len(weeks), recs, note, ga)
    if dry_run:
        print(name); print(out); return
    tid = approval.existing_task(name)
    if not tid:
        today = dt.date.today().isoformat()
        TF = approval.TF
        fields = {TF["name"]: name, TF["desc"]: out.split("\n")[0], TF["status"]: "Today", TF["team"]: [approval.AGENT_TM], TF["priority"]: "Medium",
                  TF["due"]: today, TF["business"]: [approval.BUSINESS_PERSONAL],
                  TF["notes"]: "Raised by the Content Engine performance read %s. Created with --force: the duplicate key strips the dates that make this month's read distinct." % today}
        r = subprocess.run([sys.executable, approval.GATE, "create", "--force", "--fields-json", json.dumps(fields)], capture_output=True, text=True)
        if r.returncode != 0: raise SystemExit("performance: task gate failed: " + (r.stderr or r.stdout)[-400:])
        tid = json.loads(r.stdout.strip().splitlines()[-1])["taskId"]
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as fh:
        fh.write(out); path = fh.name
    try:
        r = subprocess.run([sys.executable, approval.DISPATCH, "submit", tid, "--agent", approval.AGENT_TM, "--type", CARD_TYPE, "--output-file", path], capture_output=True, text=True)
    finally:
        os.remove(path)
    if r.returncode != 0: raise SystemExit("performance: submit failed for %s: %s" % (tid, (r.stderr or r.stdout)[-400:]))
    state["reads"][key] = {"task": tid, "name": name, "start": start.isoformat(), "raised": dt.datetime.now().isoformat(timespec="seconds"),
                           "videos": len(vids), "recommendations": recs, "written": written}
    save_state(state)
    print("performance: read %s to %s -> card %s (%d videos, %d records updated)" % (start, end, tid, len(vids), written))


def _dispatch():
    spec = importlib.util.spec_from_file_location("agent_dispatch", approval.DISPATCH)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod


def sync():
    """Kevin's verdict on an open read: approved -> each recommendation becomes a dated lesson."""
    state = load_state()
    open_reads = {k: e for k, e in state["reads"].items() if e.get("task") and not e.get("verdict")}
    if not open_reads: print("performance sync: no open reads"); return
    TF = approval.TF
    for key, e in open_reads.items():
        t = watch._airtable("GET", approval.TASKS_API + "/" + e["task"] + "?returnFieldsByFieldId=true")["fields"]
        outcome = t.get(TF["outcome"])
        if isinstance(outcome, dict): outcome = outcome.get("name")
        if not outcome: print("read %s: card %s still waiting" % (key, e["task"])); continue
        stamp = (t.get(TF["approvedAt"]) or dt.date.today().isoformat())[:10]
        if outcome in approval.APPROVED:
            d = _dispatch(); n = 0
            for rec in e.get("recommendations", []):
                line = d.lesson_line(stamp, "Performance read to %s" % key, rec)
                d.append_lesson_to_file(AGENT_SLUG, line)
                try: d.mirror_lesson_to_register(REGISTER_ROW, line)
                except Exception as ex: print("read %s: register mirror failed (%s)" % (key, str(ex)[:80]), file=sys.stderr)
                n += 1
            e.update({"verdict": "approved", "lessons_written": n})
            print("read %s: approved, %d lessons written" % (key, n))
        else:
            e.update({"verdict": "rejected", "feedback": t.get(TF["feedback"]) or ""})
            print("read %s: %s, kept Kevin's reason" % (key, outcome))
        e.update({"outcome": outcome, "synced": dt.datetime.now().isoformat(timespec="seconds")})
    save_state(state)


def selftest():
    html = '{"videoDetails":{"videoId":"abc","title":"How I Plan My Runs | Runpreneur Ep2040/5000","lengthSeconds":"383","viewCount":"10"},"likeCount":"3","publishDate":"2026-09-07T05:37:21-07:00"}'
    p = parse_watch_page(html)
    assert p["viewCount"] == 10 and p["likeCount"] == 3 and p["lengthSeconds"] == 383 and p["publishDate"].startswith("2026-09-07") and p["title"].startswith("How I Plan"), p
    assert parse_watch_page("nothing here")["viewCount"] is None
    assert episode_number("Why 9 out of 10 Fail | Runpreneur Ep1857/4292") == 1857 and episode_number("Running in the Cold Day 2036 | RP") == 2036 and episode_number("no number") is None
    assert video_id("https://www.youtube.com/watch?v=mAhs6se6jo4") == "mAhs6se6jo4" and video_id("https://youtu.be/Hlm1IiHBy0k") == "Hlm1IiHBy0k" and video_id("") is None
    s, e = dt.date(2026, 8, 9), dt.date(2026, 9, 7)
    assert in_window("2026-09-07T05:37:21-07:00", s, e) and not in_window("2026-09-08", s, e) and not in_window(None, s, e)
    vids = [{"id": "a", "title": "A | Ep2050", "episode": 2050, "views": 100, "likes": 2, "seconds": 400},
            {"id": "b", "title": "B | Ep2051", "episode": 2051, "views": 10, "likes": 0, "seconds": 60},
            {"id": "c", "title": "C | Ep2052", "episode": 2052, "views": 40, "likes": 1, "seconds": 500},
            {"id": "d", "title": "D", "episode": None, "views": None}]
    sm = summarise(vids)
    assert sm["count"] == 3 and sm["views_total"] == 150 and sm["views_median"] == 40 and sm["likes_total"] == 3, sm
    assert sm["top"][0]["id"] == "a" and sm["bottom"][0]["id"] == "b" and sm["shorts_median"] == 10 and sm["long_median"] == 70
    assert summarise([]) == {"count": 0}
    snaps = [{"taken": "2026-08-17T03:30:00", "platforms": {"tiktok": {"posts": 6, "impressions": 1930, "likes": 4, "comments": 1, "followers": 2}}},
             {"taken": "2026-08-24T03:30:00", "platforms": {"tiktok": {"posts": 5, "impressions": 70, "likes": 0, "comments": 0, "followers": 0}, "threads": {"posts": 2, "impressions": 70, "likes": 0, "comments": 0, "followers": 0}}},
             {"taken": "2026-09-09T03:30:00", "platforms": {"tiktok": {"posts": 1, "impressions": 1, "likes": 0, "comments": 0, "followers": 0}}}]
    w = weeks_in_window(snaps, s, e); assert len(w) == 2, "the snapshot after the window is left out"
    tot = platform_totals(w); assert tot["tiktok"]["impressions"] == 2000 and tot["tiktok"]["posts"] == 11 and tot["threads"]["impressions"] == 70, tot
    assert platform_totals([]) == {}
    recs = parse_recommendations("Here you go\n1. Put the number in the first three words: the top three titles all did.\n2) Keep clips under 60 s.\n3. Post the summary at 12:00.\n")
    assert len(recs) == 3 and recs[1] == "Keep clips under 60 s." and parse_recommendations("1. only one") == []
    assert no_em_dashes("a — b") == "a , b"
    name, out = build_card(s, e, sm, tot, 2, ["R1", "R2", "R3"], "note here")
    assert name == "CONTENT: Performance read 9 Aug to 7 Sep 2026 (Runpreneur)", name
    assert "Median views, clips under 2.5 minutes: 10. Full episodes: 70." in out and "Tiktok: 11 posts, 2,000 impressions" in out and "Fewer than four weeks" in out
    assert "1. R1" in out and "3. R3" in out and out.rstrip().split("\n")[-1].startswith(CLOSING) and "note here" in out and "—" not in out
    _, out2 = build_card(s, e, {"count": 0}, {}, 0, ["R1", "R2", "R3"])
    assert "no videos with a publish date inside the window" in out2 and "no weekly GoHighLevel snapshots" in out2, "absence is reported, never a zero dressed as a number"
    assert STAT_FIELDS["views"] == "👀 Views (YT)", "the field set Engagements Total sums"
    ga = parse_ga_text("Home\nActive users\n1.2K\nEvent count\n34\nNew users\n7\nViews\n2,345\nfoo")
    assert ga == {"active_users": 1200, "views": 2345, "new_users": 7, "events": 34}, ga
    assert parse_ga_text("No data received from your website yet.") is None and parse_ga_text("") is None
    assert "p553283476" in ga_url(s, e) and "date00%3D20260809" in ga_url(s, e) and "date01%3D20260907" in ga_url(s, e)
    _, out3 = build_card(s, e, sm, tot, 2, ["R1", "R2", "R3"], ga={"active_users": 12, "views": 40, "new_users": 9})
    assert "12 active users, 40 page views, 9 new users" in out3 and "gave no figures" in out, "the website line reports a number or its absence"
    print(json.dumps({"checks": 30, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("--days", type=int, default=30); ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-records", action="store_true", help="run: do not write stats onto the episode records")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "snapshot": snapshot()
    elif a.mode == "run": run(a.days, a.dry_run, a.no_records)
    elif a.mode == "sync": sync()
    else: raise SystemExit("unknown mode")
