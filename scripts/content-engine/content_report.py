#!/usr/bin/env python3
"""Content Engine: the daily publishing report (Kevin, 15 Sep 2026).

"Most importantly, I need some kind of reporting protocol so I can see what's been published each day and what's
scheduled to be published." One report, built from what the engine actually did (publishing.json, approvals.json,
the ledger, the Strava sync state), written as ONE row in Airtable. Two places read that row:

  - the Publishing page (publishing.html, Marketing in the app's sidebar): the full picture;
  - the 08:00 approvals DM (scripts/slack-automation/approvals.js): the one-line headline.

The row lives in the Estate Status table (key `content-publishing`, kind `report`), the same way loop-health does.
The Estate status tab lists `job` rows only, so this row never shows there, and estate-status.py leaves it alone.

A report that only lists arrivals cannot show a missed day, so every day of the last seven is listed, and a day with
nothing out says so in words.

Usage:
  content_report.py build            # print the report JSON (read-only)
  content_report.py write            # build and upsert the Airtable row
  content_report.py selftest
Runs at the end of the hourly publisher and the nightly render job.
"""
import argparse, datetime as dt, json, os, re, sys, urllib.parse, urllib.request
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import watch, approval, publish, runpreneur_sync  # noqa: E402

LONDON = ZoneInfo("Europe/London")
BASE = "appnqjDpqDniH3IRl"
TABLE = "tblZVrdzivyBueZVf"          # Estate Status
KEY = "content-publishing"
# Field ids mirrored from scripts/estate-status.py (ES); tests/content-report.test.js fails if they drift.
ES = {"key": "fldLO6xJqkokvVR4g", "kind": "fldfjQOn76VpgKEfZ", "label": "fldlnvvTh8l5UIih4", "status": "fldhOUiva3bqPNk1c",
      "lastRun": "flduxV3TYwp9wQX9O", "lastWorked": "fldMIx3kWMM23vDBN", "detail": "fldLRFP2nJttDVQOa",
      "payload": "fldiqs9lvyLimoR7i", "updated": "fld3q8WN5XqrER92Z"}
SECTIONS = ("YouTube episode", "YouTube Short", "Teaser clips", "Learnings clips", "Blog", "Podcast", "Facebook share")
HISTORY_DAYS = 7


def parse_utc(s):
    try: return dt.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except (TypeError, ValueError): return None


def youtube_post(entry):
    for k, p in (entry.get("posts") or {}).items():
        if k.startswith("youtube|") and p.get("clip") == "full": return p
    return None


def out_at(entry):
    """When the episode went public on YouTube, or None if it has not."""
    p = youtube_post(entry)
    if not p or p.get("status") != "published": return None
    return parse_utc(p.get("published_at") or p.get("scheduled"))


def london_day(t):
    return t.astimezone(LONDON).date()


def episode_row(day, entry):
    s = publish.section_status(entry)
    p = youtube_post(entry) or {}
    return {"day": int(day), "youtube": p.get("link") or entry.get("youtube_link") or "", "blog": (entry.get("blog") or {}).get("url", ""),
            "podcast": (entry.get("podcast") or {}).get("link", ""), "sections": s,
            "done": sum(1 for v in s.values() if v == "done"), "missing": [k for k, v in s.items() if v == "missing"],
            "pending": [k for k, v in s.items() if v == "pending"]}


def short_date(iso):
    try: d = dt.date.fromisoformat((iso or "")[:10])
    except ValueError: return ""
    return "%d %s" % (d.day, d.strftime("%b"))


def teaser_only_days(ledger, cursor, gaps, carded):
    """Days ahead of the run whose every clip is rendered and none of them is the full episode. The order rule holds
    every later day behind such a day, and no card can come for it (21 Sep 2026: 2066's full clip was on Drive under a
    name the scan cannot read, so the day looked like a teaser and nothing else)."""
    by_day = {}
    for v in ledger.values():
        d = v.get("episode") or v.get("day")
        if d: by_day.setdefault(d, []).append(v)
    return sorted(d for d, vs in by_day.items() if d > cursor and d not in gaps and d not in carded
                  and all(v.get("status") == "rendered" for v in vs) and not any(v.get("role") == "episode" for v in vs))


def blocker_why(day, sent_back, holds, waiting, qa_blocked, qa_waiting, teaser_only, no_card, failed):
    """In plain words, why the first day in the order is not going out. Every state a day can sit in is named: a
    reason that falls through to a wrong one is how 2062 hid for three days."""
    sb = {s["day"]: s for s in sent_back}
    if day in sb:
        s = sb[day]; what = "rejected" if s.get("rejected") else "sent back"
        return ("%s on %s, not resubmitted" % (what, s["since"])) if s["since"] else "%s, not resubmitted" % what
    if day in waiting: return "its card waits for your approval"
    if day in holds: return "held" + (": " + holds[day] if holds[day] else " (content_engine_hold_days)")
    if day in qa_blocked: return "it failed its output check"
    if day in qa_waiting: return "its card waits for the files to be readable"
    if day in teaser_only: return "the engine has found only its teaser, no full episode"
    if day in no_card: return "rendered, its card is not raised yet"
    if day in failed: return "its render failed"
    return "not rendered yet"


def build(now=None, state=None, approvals=None, ledger=None, sync_state=None, plan=None, skipped=None, holds=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    state = publish.load_state() if state is None else state
    approvals = approval.load_state() if approvals is None else approvals
    ledger = watch.load_ledger() if ledger is None else ledger
    sync_state = (runpreneur_sync.load_state() or {}) if sync_state is None else sync_state
    skipped = watch.skipped_names() if skipped is None else skipped
    holds = publish.held_days() if holds is None else holds
    today = london_day(now)
    episodes = {d: e for d, e in state.items() if str(d).isdigit() and isinstance(e, dict)}
    gaps = watch.gap_days()
    cursor = publish.cursor(state)

    # every one of the last seven days, newest first, including the empty ones
    history = []
    for i in range(HISTORY_DAYS):
        d = today - dt.timedelta(days=i)
        out = sorted((episode_row(k, e) for k, e in episodes.items() if out_at(e) and london_day(out_at(e)) == d), key=lambda r: r["day"])
        history.append({"date": d.isoformat(), "episodes": out})
    clean = 0
    for i in range(1, 31):                                   # yesterday backwards, beyond the seven-day table (review, 15 Sep 2026: the table capped it at 6)
        d = today - dt.timedelta(days=i)
        if not any(out_at(e) and london_day(out_at(e)) == d and int(k) not in gaps for k, e in episodes.items()): break   # a gap day filling an old hole is not the run moving on
        clean += 1

    # what is booked and not out yet
    scheduled = []
    for k, e in episodes.items():
        for key, p in (e.get("posts") or {}).items():
            when = parse_utc(p.get("scheduled"))
            if p.get("status") == "scheduled" and when and when >= now - dt.timedelta(hours=2):
                scheduled.append({"day": int(k), "channel": publish.CHANNEL_NAMES.get((p.get("platform"), p.get("clip")), p.get("platform", "")),
                                  "when": p["scheduled"]})
    scheduled.sort(key=lambda r: (r["when"], r["day"]))

    approved = sorted(int(d) for d, a in approvals.items() if a.get("verdict") == "approved")
    waiting_cards = sorted(int(d) for d, a in approvals.items() if a.get("task") and not a.get("verdict"))
    import copy
    # the publisher's own order rule, fed the way publish.run feeds it: a held day is not publishable
    nxt, why_held = publish.next_publishable(copy.deepcopy(state), ledger, set(approved) - set(gaps) - set(holds))
    next_up = [nxt] if nxt else []
    held = [d for d in approved if d not in gaps and d > cursor and d != nxt and not (episodes.get(str(d)) or {}).get("youtube_link")]
    blocked = {d: "; ".join(a["qa_blocked"].get("failures") or [])[:200] for d, a in approvals.items() if isinstance(a, dict) and a.get("qa_blocked")}
    # A card Kevin sent back (or rejected) is neither waiting for him nor approved. Until 21 Sep 2026 it fell out of the
    # report, and 2062 held every later day for three days while the page said "No episode cards wait for you".
    sent_back = sorted(({"day": int(d), "since": short_date(a.get("synced")), "feedback": (a.get("feedback") or "").strip()[:200],
                         "rejected": a.get("verdict") == "rejected", "holdsOrder": int(d) > cursor and int(d) not in gaps}
                        for d, a in approvals.items() if a.get("task") and a.get("verdict") in ("changes", "rejected")
                        and not (episodes.get(str(d)) or {}).get("youtube_link")), key=lambda s: s["day"])
    teaser_only = teaser_only_days(ledger, cursor, gaps, {int(d) for d in approvals})
    # the render pipeline
    failed = sorted({v.get("day") for v in ledger.values() if v.get("status") == "failed" and v.get("day") and v.get("requeued")})
    retrying = sorted({v.get("day") for v in ledger.values() if v.get("status") == "failed" and v.get("day") and not v.get("requeued")})
    rendered_days = {v.get("episode") for v in ledger.values() if v.get("status") == "rendered" and v.get("role") == "episode" and v.get("episode")}   # the long clip, not a teaser
    carded = {int(d) for d in approvals}
    no_card = sorted(d for d in rendered_days if d not in carded and d > cursor and d not in gaps)
    blocker = None
    m = re.match(r"day (\d+) ", why_held or "")
    bd = int(m.group(1)) if m else None
    if bd is None and held and not nxt:
        # every approved day ahead is held, so the order rule saw nothing approved (review, 21 Sep 2026: 2060's case):
        # ask it again without the holds to find the first day in order, which is then held
        first, _ = publish.next_publishable(copy.deepcopy(state), ledger, set(approved) - set(gaps))
        bd = first if first in holds else None
    if held and not nxt and bd is not None:
        blocker = {"day": bd, "why": blocker_why(bd, sent_back, holds, waiting_cards, {int(d) for d in blocked},
                                                 {int(d) for d, a in approvals.items() if isinstance(a, dict) and a.get("qa_waiting")},
                                                 teaser_only, no_card, set(failed) | set(retrying))}
        held = [d for d in held if d != bd]                  # the day the queue waits on is not waiting behind itself
    try:
        # plan the night the way the night will: its scan puts a failed clip back first (watch.requeue_failed)
        tonight = plan if plan is not None else watch.plan(requeued_copy(ledger), nightly_slots())[0]
    except Exception as ex:                                  # a plan that cannot be read is said, never shown as empty
        tonight = None; print("report: tonight's plan could not be read (%s)" % ex, file=sys.stderr)

    recent = sorted((episode_row(k, e) for k, e in episodes.items() if out_at(e) and (today - london_day(out_at(e))).days < 14),
                    key=lambda r: -r["day"])
    incomplete = [{"day": r["day"], "missing": r["missing"], "pending": r["pending"]} for r in recent if r["missing"] or r["pending"]]

    streak_today = watch.streak_day(today)
    lp = sync_state.get("last_push") or {}
    try: strava_at = dt.datetime.fromisoformat(lp["at"]).replace(tzinfo=LONDON).astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")   # the sync stamps London wall-clock time
    except (KeyError, TypeError, ValueError): strava_at = ""
    report = {
        "asOf": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "today": today.isoformat(), "mode": publish.mode(),
        "streakDay": streak_today, "lastInOrder": cursor, "daysBehind": streak_today - cursor,
        "history": history, "cleanDaysInRow": clean, "gapDaysPaused": watch.gaps_paused(),
        "scheduled": scheduled[:40], "nextInOrder": next_up, "heldBehind": held, "heldWhy": "" if nxt else why_held, "waitingForKevin": waiting_cards, "qaBlocked": blocked,
        "sentBack": sent_back, "teaserOnly": teaser_only, "blocker": blocker, "skippedNames": skipped,
        "tonight": tonight, "failedRenders": failed, "retryTonight": retrying, "renderedNoCard": no_card, "incomplete": incomplete,
        "strava": {"lastPush": strava_at, "day": sync_state.get("day"), "lastRunKm": (sync_state.get("last_activity") or {}).get("km"),
                   "renamed": bool(lp.get("renamed"))},
    }
    report["headline"] = headline(report)
    return report


def requeued_copy(ledger):
    import copy
    led = copy.deepcopy(ledger); watch.requeue_failed(led)
    return led


def nightly_slots():
    try: return int(open(os.path.expanduser("~/.config/od/content_engine_episodes_per_night")).read().strip())
    except (OSError, ValueError): return 1


def fmt_when(iso):
    t = parse_utc(iso)
    return t.astimezone(LONDON).strftime("%H:%M") if t else "?"


def headline(r):
    """One line for the 08:00 DM. It names yesterday even when nothing went out: absence is the news."""
    y = r["history"][1] if len(r["history"]) > 1 else {"episodes": []}
    if y["episodes"]:
        out = "; ".join("Episode %d out, %d of 7 sections%s" % (e["day"], e["done"], (" (missing: " + ", ".join(e["missing"]) + ")") if e["missing"] else "")
                        for e in y["episodes"])
    else:
        out = "NOTHING went out yesterday"
    yt_today = [s for s in r["scheduled"] if s["channel"] == "YouTube full episode" and s["when"][:10] == r["today"]]
    if yt_today: nxt = "Today: " + ", ".join("Episode %d on YouTube %s" % (s["day"], fmt_when(s["when"])) for s in yt_today)
    elif r["nextInOrder"]: nxt = "Today: Episode %d goes out once the publisher picks it up" % r["nextInOrder"][0]
    elif r.get("blocker") and not r.get("heldBehind"):
        nxt = "Today: nothing can go out; day %d (%s)" % (r["blocker"]["day"], r["blocker"]["why"])
    elif r.get("heldBehind"):
        b = r.get("blocker")
        nxt = "Today: nothing can go out; Episode %s wait%s behind %s" % (
            ", ".join(str(d) for d in r["heldBehind"]), "s" if len(r["heldBehind"]) == 1 else "",
            "day %d (%s)" % (b["day"], b["why"]) if b else "an earlier day that is not approved")
    else: nxt = "Today: nothing approved to publish"
    cards = len(r["waitingForKevin"])
    ask = ("%d episode card%s wait%s for you" % (cards, "" if cards == 1 else "s", "s" if cards == 1 else "")) if cards else "No episode cards wait for you"
    others = [s for s in r.get("sentBack") or [] if not r.get("blocker") or s["day"] != r["blocker"]["day"]]
    if others: ask += "; " + "; ".join("Episode %d %s, not resubmitted" % (s["day"], "rejected" if s.get("rejected") else "sent back") for s in others)
    return "Content: %s. %s. %s." % (out, nxt, ask)


UNPAUSE_AFTER_DAYS = 7


def lift_gap_pause(report, path=None, remove=os.remove, say=print):
    """Kevin, 15 Sep 2026: the gap days come back once seven days in a row have an in-order episode out. The
    report already counts those days, so the job that writes it lifts the pause and says so. Returns True when lifted."""
    path = path or watch.GAP_PAUSE_FILE
    if report.get("cleanDaysInRow", 0) < UNPAUSE_AFTER_DAYS or not os.path.exists(path): return False
    remove(path)
    report["gapDaysPaused"] = False; report["gapDaysUnpaused"] = report["asOf"]
    say("content report: %d days in a row with an episode out; gap days are back in the night plan" % report["cleanDaysInRow"])
    return True


def write(report, dry_run=False):
    now = report["asOf"].replace("Z", ".000Z")
    status = "Worked"
    fields = {ES["key"]: KEY, ES["kind"]: "report", ES["label"]: "Content publishing", ES["status"]: status,
              ES["detail"]: report["headline"][:900], ES["payload"]: json.dumps(report, separators=(",", ":")),
              ES["lastRun"]: now, ES["lastWorked"]: now, ES["updated"]: now}
    if dry_run: return fields
    pat = open(os.path.expanduser("~/.config/od/airtable_pat")).read().strip()
    def call(method, path, body=None):
        req = urllib.request.Request("https://api.airtable.com/v0/%s/%s" % (BASE, path), method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": "Bearer " + pat, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as resp: return json.loads(resp.read().decode())
    q = urllib.parse.urlencode({"returnFieldsByFieldId": "true", "filterByFormula": '{Key}="%s"' % KEY, "pageSize": "10"})
    have = call("GET", TABLE + "?" + q).get("records", [])
    if have: call("PATCH", TABLE, {"records": [{"id": have[0]["id"], "fields": fields}], "typecast": True})
    else: call("POST", TABLE, {"records": [{"fields": fields}], "typecast": True})
    return fields


def selftest():
    real_holds = publish.held_days; publish.held_days = lambda path=None: {}   # the real hold file never steers the selftest
    try: _selftest()
    finally: publish.held_days = real_holds


def _selftest():
    now = dt.datetime(2026, 9, 16, 7, 0, tzinfo=dt.timezone.utc)          # 08:00 London, Wednesday 16 Sep
    yt = lambda link, at: {"platform": "youtube", "clip": "full", "status": "published", "link": link, "published_at": at, "scheduled": at}
    pub = lambda plat, clip: {"platform": plat, "clip": clip, "status": "published"}
    state = {"_cursor": 2057,
             "2057": {"youtube_link": "https://youtu.be/a", "posts": {"youtube|full|y": yt("https://youtu.be/a", "2026-09-15T05:00:00Z"),
                      "youtube|lfmd|y": pub("youtube", "lfmd"), "facebook|summary|f": pub("facebook", "summary"), "facebook|lfmd|f": pub("facebook", "lfmd")},
                      "blog": {"url": "https://runpreneur.org.uk/blog/b/x"}, "podcast": {"status": "published"},
                      # BOTH page posts on Kevin's profile: one share is no longer a finished episode (20 Sep 2026)
                      "facebook_share": {"status": "shared"}, "facebook_share_lfmd": {"status": "shared"}},
             "2058": {"posts": {"youtube|full|y": {"platform": "youtube", "clip": "full", "status": "scheduled", "scheduled": "2026-09-16T05:00:00Z"}}}}
    approvals = {"2057": {"verdict": "approved", "task": "t1"}, "2058": {"verdict": "approved", "task": "t2"}, "2059": {"task": "t3"}}
    ledger = {"a": {"status": "rendered", "episode": 2059, "role": "teaser"}, "b": {"status": "failed", "day": 2060, "requeued": "x"},
              "c": {"status": "failed", "day": 2061}, "d": {"status": "rendered", "episode": 2062, "role": "episode"}}
    r = build(now, state, approvals, ledger, {"day": 2298, "last_push": {"at": "2026-09-15T19:15:00"}}, plan=[2060, 2061])
    assert [h["date"] for h in r["history"]][:2] == ["2026-09-16", "2026-09-15"] and len(r["history"]) == 7, "seven days, empty ones included"
    assert r["history"][1]["episodes"][0]["day"] == 2057 and r["history"][1]["episodes"][0]["done"] == 7
    # the Learnings post is the half that was never shared before 20 Sep 2026: without it, six of seven
    import copy as _c
    one_share = _c.deepcopy(state); del one_share["2057"]["facebook_share_lfmd"]
    r1 = build(now, one_share, approvals, ledger, {"day": 2298}, plan=[])
    assert r1["history"][1]["episodes"][0]["done"] == 6, "an episode with only the summary shared is not complete"
    assert r["cleanDaysInRow"] == 1 and r["waitingForKevin"] == [2059] and r["failedRenders"] == [2060] and r["retryTonight"] == [2061]
    assert r["renderedNoCard"] == [2062], "a rendered teaser alone is not an episode waiting for its card"
    led = {"f": {"status": "failed", "day": 2057, "date": "2026-01-17", "episode": 2057, "size": 5, "error": "x"}}
    assert requeued_copy(led)["f"]["status"] == "new" and led["f"]["status"] == "failed", "tonight's plan counts the retry without touching the real ledger"
    assert r["headline"] == "Content: Episode 2057 out, 7 of 7 sections. Today: Episode 2058 on YouTube 06:00. 1 episode card waits for you.", r["headline"]
    del state["2057"]
    r2 = build(now, state, {}, {}, {}, plan=[])
    assert r2["headline"].startswith("Content: NOTHING went out yesterday."), "absence is said, never left blank"
    assert r2["cleanDaysInRow"] == 0 and all(not h["episodes"] for h in r2["history"])
    # 2058 is recorded and not approved, so approved 2059 is held behind it: never promised for today (review, 15 Sep 2026)
    held_state = {"_cursor": 2057}
    rh = build(now, held_state, {"2058": {"task": "t"}, "2059": {"verdict": "approved", "task": "t2"}}, {"x": {"episode": 2058}, "y": {"episode": 2059}}, {}, plan=[])
    assert rh["nextInOrder"] == [] and rh["heldBehind"] == [2059] and "2058" in rh["heldWhy"], rh
    assert "Episode 2059 waits behind day 2058 (its card waits for your approval)" in rh["headline"], rh["headline"]
    assert rh["blocker"] == {"day": 2058, "why": "its card waits for your approval"} and rh["sentBack"] == [] and rh["teaserOnly"] == []
    # 21 Sep 2026: 2062 was sent back, rebuilt, never resubmitted, and held every later day for three days while the page
    # said "No episode cards wait for you". A sent-back card is named, as the blocker and in its own list.
    sb = build(now, held_state, {"2058": {"task": "t", "verdict": "changes", "synced": "2026-09-14T09:57:59", "feedback": "the diary part is missing"},
                                 "2059": {"verdict": "approved", "task": "t2"}}, {"x": {"episode": 2058}, "y": {"episode": 2059}}, {}, plan=[], skipped=[])
    assert sb["waitingForKevin"] == [] and sb["sentBack"] == [{"day": 2058, "since": "14 Sep", "feedback": "the diary part is missing", "rejected": False, "holdsOrder": True}], sb["sentBack"]
    assert sb["blocker"] == {"day": 2058, "why": "sent back on 14 Sep, not resubmitted"}, sb["blocker"]
    assert "behind day 2058 (sent back on 14 Sep, not resubmitted). No episode cards wait for you." in sb["headline"], sb["headline"]
    later = build(now, held_state, {"2058": {"task": "t"}, "2059": {"verdict": "approved", "task": "t2"}, "2060": {"task": "t3", "verdict": "changes", "synced": "2026-09-15T10:00:00"}},
                  {"x": {"episode": 2058}, "y": {"episode": 2059}}, {}, plan=[], skipped=[])
    assert later["headline"].endswith("1 episode card waits for you; Episode 2060 sent back, not resubmitted."), later["headline"]
    # 2066 on 21 Sep 2026: only the teaser rendered, the full clip unseen. The day holds the order and no card can come.
    tl = {"t": {"episode": 2059, "role": "teaser", "status": "rendered"}, "f": {"day": 2060, "status": "new"},
          "u": {"episode": 2061, "role": "teaser", "status": "rendered"}, "v": {"episode": 2061, "role": "episode", "status": "rendered"}}
    to = build(now, held_state, {"2058": {"verdict": "approved", "task": "t"}, "2060": {"verdict": "approved", "task": "t2"}}, tl, {}, plan=[], skipped=["2026/x/2059 Full-Real.insv"])
    assert to["teaserOnly"] == [2059], to["teaserOnly"]
    assert to["skippedNames"] == ["2026/x/2059 Full-Real.insv"]
    assert to["nextInOrder"] == [2058], "2058 is next in order; 2059 only holds the days after it"
    to2 = build(now, {"_cursor": 2058}, {"2060": {"verdict": "approved", "task": "t2"}}, tl, {}, plan=[], skipped=[])
    assert to2["blocker"] == {"day": 2059, "why": "the engine has found only its teaser, no full episode"}, to2["blocker"]
    # a gap day filling an old hole does not count as the run moving on
    gap_only = {"1799": {"youtube_link": "l", "posts": {"youtube|full|y": yt("l", "2026-09-15T05:00:00Z")}}}
    import watch as _w; real = _w.gap_days; _w.gap_days = lambda path=None: {1799}
    try: assert build(now, gap_only, {}, {}, {}, plan=[])["cleanDaysInRow"] == 0
    finally: _w.gap_days = real
    import tempfile
    pf = os.path.join(tempfile.gettempdir(), "od-gap-pause-%d" % os.getpid()); open(pf, "w").write("x")
    quiet = lambda *a: None
    assert not lift_gap_pause({"cleanDaysInRow": 6, "asOf": "t"}, pf, say=quiet) and os.path.exists(pf), "six days in a row keeps the pause"
    assert lift_gap_pause({"cleanDaysInRow": 7, "asOf": "t"}, pf, say=quiet) and not os.path.exists(pf), "seven days lifts it"
    assert not lift_gap_pause({"cleanDaysInRow": 9, "asOf": "t"}, pf, say=quiet), "already lifted: nothing to do"
    ten = {str(2060 + i): {"youtube_link": "l", "posts": {"youtube|full|y": yt("l", "2026-09-%02dT05:00:00Z" % (6 + i))}} for i in range(10)}   # 6-15 Sep, out every day
    assert build(now, ten, {}, {}, {}, plan=[])["cleanDaysInRow"] == 10, "the count runs past the seven-day table"
    f = write(r, dry_run=True)
    assert f[ES["key"]] == KEY and f[ES["kind"]] == "report" and json.loads(f[ES["payload"]])["headline"] == r["headline"]
    # review, 21 Sep 2026: every state the first day can sit in is named, the way publish.run sees it
    two = {"x": {"episode": 2058}, "y": {"episode": 2059}}
    hd = build(now, held_state, {"2058": {"verdict": "approved", "task": "t"}, "2059": {"verdict": "approved", "task": "t2"}}, two, {}, plan=[], skipped=[],
               holds={2058: "Kevin 17 Sep: reinstate the Learnings clip"})
    assert hd["nextInOrder"] == [] and hd["blocker"] == {"day": 2058, "why": "held: Kevin 17 Sep: reinstate the Learnings clip"}, (hd["nextInOrder"], hd["blocker"])
    rj = build(now, held_state, {"2058": {"task": "t", "verdict": "rejected", "synced": "2026-09-14T10:00:00"}, "2059": {"verdict": "approved", "task": "t2"}}, two, {}, plan=[], skipped=[])
    assert rj["sentBack"][0]["rejected"] and rj["blocker"]["why"] == "rejected on 14 Sep, not resubmitted", rj["blocker"]
    gp = build(now, {"_cursor": 2057, "2057": {"youtube_link": "l"}}, {"1841": {"task": "t", "verdict": "changes"}, "2057": {"task": "t0", "verdict": "changes"}}, {}, {}, plan=[], skipped=[])
    assert [s["day"] for s in gp["sentBack"]] == [1841] and gp["sentBack"][0]["holdsOrder"] is False, "a published day drops out; an old day holds no order"
    nc = build(now, held_state, {"2059": {"verdict": "approved", "task": "t2"}}, {"x": {"episode": 2058, "role": "episode", "status": "rendered"}, "y": {"episode": 2059}}, {}, plan=[], skipped=[])
    assert nc["blocker"]["why"] == "rendered, its card is not raised yet", nc["blocker"]
    qw = build(now, held_state, {"2058": {"qa_waiting": {"at": "x"}}, "2059": {"verdict": "approved", "task": "t2"}}, two, {}, plan=[], skipped=[])
    assert qw["blocker"]["why"] == "its card waits for the files to be readable", qw["blocker"]
    # second review, 21 Sep 2026: only held days approved; a held day with a later one; a held day whose card still waits
    only = build(now, held_state, {"2058": {"verdict": "approved", "task": "t"}}, two, {}, plan=[], skipped=[], holds={2058: "reinstate the clip"})
    assert only["blocker"] == {"day": 2058, "why": "held: reinstate the clip"} and only["heldBehind"] == [], (only["blocker"], only["heldBehind"])
    assert "Today: nothing can go out; day 2058 (held: reinstate the clip)." in only["headline"], only["headline"]
    assert hd["heldBehind"] == [2059], "the day the queue waits on is not listed behind itself"
    wt = build(now, held_state, {"2058": {"task": "t"}, "2059": {"verdict": "approved", "task": "t2"}}, two, {}, plan=[], skipped=[], holds={2058: "x"})
    assert wt["blocker"]["why"] == "its card waits for your approval", wt["blocker"]
    print(json.dumps({"checks": 44, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "build": print(json.dumps(build(), indent=1))
    elif a.mode == "write":
        rep = build(); lift_gap_pause(rep); write(rep); print("content report: " + rep["headline"])
    else: raise SystemExit("usage: content_report.py build | write | selftest")
