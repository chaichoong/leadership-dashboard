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
  content_report.py live             # the same, with what is true NOW read in (every 10 minutes, see live_overlay)
  content_report.py stuck [--hours N]  # sent-back cards with no fix in motion, for daily-ops (exit 2: could not tell)
  content_report.py selftest
Runs at the end of the hourly publisher and the nightly render job, and every 10 minutes as `live` (launchd
content-report-live, outside the job queue, so a render holding the queue never freezes the page).
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
BOOKED_GRACE = dt.timedelta(hours=2)   # a post still 'scheduled' this long after its slot is no longer shown as coming up


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


def teaser_only_days(ledger, out, gaps, carded):
    """Days not on YouTube whose every clip is rendered and none of them is the full episode. No card can come for
    such a day (21 Sep 2026: 2066's full clip was on Drive under a name the scan cannot read, so the day looked like
    a teaser and nothing else). `out` is the days already on YouTube."""
    by_day = {}
    for v in ledger.values():
        d = v.get("episode") or v.get("day")
        if d: by_day.setdefault(d, []).append(v)
    return sorted(d for d, vs in by_day.items() if d not in out and d not in gaps and d not in carded
                  and all(v.get("status") == "rendered" for v in vs) and not any(v.get("role") == "episode" for v in vs))


NOT_RENDERED = "not rendered yet"


def blocker_why(day, sent_back, holds, waiting, qa_blocked, qa_waiting, teaser_only, no_card, failed):
    """In plain words, why a day is not going out. Every state a day can sit in is named: a reason that falls through
    to a wrong one is how 2062 hid for three days."""
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
    return NOT_RENDERED


def left_behind(ledger, approvals, out, cursor, gaps, ready, named, why, start=0, dead=()):
    """Days with footage or a card that are not out and not about to go, each with its reason (2 Oct 2026). The
    publisher no longer waits for such a day, so the stalled queue that used to give it away is gone and the report
    must name it: a day passed in silence is a day that never publishes. Listed: a day the run has gone past, and any
    day in `named` (on hold, a dead upload, or one the publisher could not publish) wherever the run is. `out` is the
    days that are on YouTube or properly booked to be. A day whose every clip is 'new' is only waiting its turn to
    render and is left out: the night takes the oldest waiting day first and tonight's plan shows it (review, 2 Oct
    2026: one approved day far ahead would list the whole backlog). A clip stuck mid-pull or mid-render is not in that
    queue, so its day is listed. A gap day fills an old hole on its own list and is not behind the run, unless its
    upload died (`dead`): the publisher never retries that, on any day. B-roll alone is not an episode."""
    days, clips = {int(d) for d in approvals if str(d).isdigit()}, {}
    for v in ledger.values():
        d = v.get("episode") or (v.get("day") if v.get("status") != "broll" else None)
        if d: days.add(d); clips.setdefault(d, []).append(v.get("status"))
    settled = ("new", "rendered", "broll")                   # waiting its turn, or already done: neither is stuck
    queued = {d for d, sts in clips.items() if "new" in sts and all(s in settled for s in sts)}
    rows = [{"day": d, "why": why(d)} for d in sorted(days)
            if d >= start and (d < cursor or d in named) and (d not in gaps or d in dead) and d not in out and d not in ready]
    for r in rows:
        if r["why"] == NOT_RENDERED and r["day"] not in queued:
            r["why"] = "not rendered: a clip sits at %s, outside the night's queue" % ", ".join(sorted({str(s) for s in clips.get(r["day"], []) if s not in settled}) or ["no status"])
    return [r for r in rows if r["why"] != NOT_RENDERED]


def build(now=None, state=None, approvals=None, ledger=None, sync_state=None, plan=None, skipped=None, holds=None, skipped_ruled=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    state = publish.load_state() if state is None else state
    approvals = approval.load_state() if approvals is None else approvals
    ledger = watch.load_ledger() if ledger is None else ledger
    sync_state = (runpreneur_sync.load_state() or {}) if sync_state is None else sync_state
    skipped = watch.skipped_names() if skipped is None else skipped
    skipped_ruled = watch.skipped_ruled() if skipped_ruled is None else skipped_ruled
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
            if p.get("status") == "scheduled" and when and when >= now - BOOKED_GRACE:
                scheduled.append({"day": int(k), "channel": publish.CHANNEL_NAMES.get((p.get("platform"), p.get("clip")), p.get("platform", "")),
                                  "when": p["scheduled"]})
    scheduled.sort(key=lambda r: (r["when"], r["day"]))

    approved = sorted(int(d) for d, a in approvals.items() if a.get("verdict") == "approved")
    waiting_cards = sorted(int(d) for d, a in approvals.items() if a.get("task") and not a.get("verdict"))
    # the publisher's own rule, fed the way publish.run feeds it (2 Oct 2026): every approved day with nothing on
    # YouTube goes, lowest first, and waits for no other day; a held day is not publishable
    on_youtube = {int(k) for k, e in episodes.items() if publish.stage_for(e, True) != "youtube"}   # a YouTube post exists, out or not
    linked = {int(k) for k, e in episodes.items() if e.get("youtube_link")}
    # an approved day the publisher tried and could not put on YouTube says why on its entry (publish.note_refusal):
    # it is named as not out, never promised as going out
    refused = {int(k): (e["not_published"].get("why") or "no reason recorded") for k, e in episodes.items()
               if isinstance(e.get("not_published"), dict) and int(k) in approved and int(k) not in on_youtube and int(k) not in holds}
    # A YouTube post with no link yet. Booked, and not more than BOOKED_GRACE past its slot, is normal: GoHighLevel
    # carries the upload and the link follows (the same window the "booked and not out yet" list above uses).
    # Anything else (creating, unconfirmed, failed, a slot long gone) is an upload that died: the publisher waits on
    # it for ever, so it is named wherever the run is (review, 2 Oct 2026).
    booked, dead = set(), set()
    for d in on_youtube - linked:
        p = youtube_post(episodes[str(d)]) or {}
        when = parse_utc(p.get("scheduled"))                 # an unreadable slot is not a booking
        (booked if p.get("status") == "scheduled" and when and when >= now - BOOKED_GRACE else dead).add(d)
    ready = [d for d in publish.ready_to_publish(state, set(approved) - set(holds)) if d not in refused]
    blocked = {d: "; ".join(a["qa_blocked"].get("failures") or [])[:200] for d, a in approvals.items() if isinstance(a, dict) and a.get("qa_blocked")}
    # A card Kevin sent back (or rejected) is neither waiting for him nor approved. Until 21 Sep 2026 it fell out of the
    # report, and 2062 held every later day for three days while the page said "No episode cards wait for you".
    sent_back = sorted(({"day": int(d), "since": short_date(a.get("synced")), "feedback": (a.get("feedback") or "").strip()[:200],
                         "rejected": a.get("verdict") == "rejected"}
                        for d, a in approvals.items() if a.get("task") and a.get("verdict") in ("changes", "rejected")
                        and not (episodes.get(str(d)) or {}).get("youtube_link")), key=lambda s: s["day"])
    teaser_only = teaser_only_days(ledger, on_youtube, gaps, {int(d) for d in approvals})
    # the render pipeline
    failed = sorted({v.get("day") for v in ledger.values() if v.get("status") == "failed" and v.get("day") and v.get("requeued")})
    retrying = sorted({v.get("day") for v in ledger.values() if v.get("status") == "failed" and v.get("day") and not v.get("requeued")})
    rendered_days = {v.get("episode") for v in ledger.values() if v.get("status") == "rendered" and v.get("role") == "episode" and v.get("episode")}   # the long clip, not a teaser
    carded = {int(d) for d in approvals}
    no_card = sorted(d for d in rendered_days if d not in carded and d not in on_youtube and d not in gaps)
    def why_not_out(d):
        if d in refused: return "the publisher could not publish it: " + refused[d]
        if d in dead:
            return "its YouTube post is %s, with no link yet" % ((youtube_post(episodes[str(d)]) or {}).get("status") or "not confirmed")
        return blocker_why(d, sent_back, holds, waiting_cards, {int(x) for x in blocked},
                           {int(x) for x, a in approvals.items() if isinstance(a, dict) and a.get("qa_waiting")},
                           teaser_only, no_card, set(failed) | set(retrying))
    behind = left_behind(ledger, approvals, linked | booked, cursor, gaps, ready, set(holds) | set(refused) | dead, why_not_out,
                         min([watch.start_day() or 0] + sorted(dead)), dead)
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
        "scheduled": scheduled[:40], "nextInOrder": ready, "leftBehind": behind, "waitingForKevin": waiting_cards, "qaBlocked": blocked,
        "sentBack": sent_back, "teaserOnly": teaser_only, "skippedNames": skipped, "skippedRuled": len(skipped_ruled or []),
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
    elif len(r["nextInOrder"]) == 1: nxt = "Today: Episode %d goes out once the publisher picks it up" % r["nextInOrder"][0]
    elif r["nextInOrder"]: nxt = "Today: Episodes %s go out once the publisher picks them up" % ", ".join(str(d) for d in r["nextInOrder"])
    else: nxt = "Today: nothing approved to publish"
    cards = len(r["waitingForKevin"])
    ask = ("%d episode card%s wait%s for you" % (cards, "" if cards == 1 else "s", "s" if cards == 1 else "")) if cards else "No episode cards wait for you"
    sent = r.get("sentBack") or []
    if sent: ask += "; " + "; ".join("Episode %d %s, not resubmitted" % (s["day"], "rejected" if s.get("rejected") else "sent back") for s in sent)
    # a day the run has gone past for any other reason is said too: nothing waits for it now, so nothing else will say it
    others = [b for b in r.get("leftBehind") or [] if b["day"] not in {s["day"] for s in sent}]
    if others: ask += "; " + "; ".join("Episode %d not out yet (%s)" % (b["day"], b["why"]) for b in others[:HEADLINE_BEHIND])
    if len(others) > HEADLINE_BEHIND: ask += "; and %d more not out yet (the Publishing page lists them)" % (len(others) - HEADLINE_BEHIND)
    return "Content: %s. %s. %s." % (out, nxt, ask)


HEADLINE_BEHIND = 4          # the 08:00 line is cut at 900 characters; the page carries the whole list
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


RENDERING = ("pulling", "rendering")          # mid-run: in motion whatever else holds
WAITING = ("new", "pulled")                   # in motion only on a day the night planner will reach


def stuck_sent_back(now=None, hours=24, approvals=None, ledger=None, episodes=None, redo_days=None, receipts=None,
                    reachable=None, why_waiting=None, last_night=None, running=None):
    """Sent-back cards nobody has set a fix in motion for after `hours` (Kevin, 27 Sep 2026: daily-ops works them).

    2072 held every later episode for two days behind a question ("can you confirm the folder that contains the raw
    footage") that only a Claude session could answer, and none looked. In motion means: a clip of the day rendering
    now; a clip waiting to render on a day the night planner will reach (a paused catch-up day never is); the day on
    the Learnings rebuild list; or a receipt waiting to go back with the card that no night has had its chance at yet
    (render.receipt_stale; review, 27 Sep 2026: a receipt whose re-render failed again, or whose card the gate refused,
    would otherwise hide the card for good, the same ownerless stall). `receipts` maps day -> when it was written. A
    waiting clip counts on its OWN recording day, the one the planner schedules: 2194's clips were recorded on 2195. A rejected card is his no, not a job, and
    a day already on YouTube holds nothing."""
    import render
    now = now or dt.datetime.now()
    approvals = approval.load_state() if approvals is None else approvals
    ledger = watch.load_ledger() if ledger is None else ledger
    episodes = publish.load_state() if episodes is None else episodes
    if redo_days is None:
        try: redo_days = {int(m.group(1)) for m in (re.match(r"\s*(\d{3,4})\b", l) for l in open(render.REDO_LFMD_FILE)) if m}
        except OSError: redo_days = set()
    if receipts is None:
        receipts = {}
        try:
            for n in os.listdir(render.RESUBMIT_DIR):
                if re.match(r"^\d+\.md$", n):
                    receipts[int(n[:-3])] = dt.datetime.fromtimestamp(os.path.getmtime(os.path.join(render.RESUBMIT_DIR, n)))
        except OSError: pass
    if last_night is None: last_night = render.last_nightly_finish()
    if running is None: running = render.render_running()      # a "rendering" clip with no render running is orphaned
    if reachable is None:
        reachable = set(watch.plan(ledger, 10 ** 6)[0])
    out = []
    for d, a in sorted(approvals.items()):
        if not (isinstance(a, dict) and a.get("task") and a.get("verdict") == "changes"): continue
        day = int(d)
        if (episodes.get(d) or {}).get("youtube_link"): continue
        try: since = dt.datetime.fromisoformat(str(a.get("synced") or ""))
        except ValueError: since = None
        waited = (now - since).total_seconds() / 3600 if since else None
        if waited is not None and waited < hours: continue
        mine = {k: v for k, v in ledger.items() if v.get("episode") == day or (v.get("day") == day and not v.get("episode"))}
        if (running and any(v.get("status") in RENDERING for v in mine.values())) or day in redo_days: continue
        if any(v.get("status") in WAITING and v.get("day") in reachable for v in mine.values()): continue
        written = receipts.get(day)
        if written is not None and not render.receipt_stale(written, now, last_night, hours): continue
        if written is not None:
            why = "a receipt has waited %d h and the card has not gone back after the night had its chance" % round((now - written).total_seconds() / 3600)
            if why_waiting: why += ": " + why_waiting(day)
        elif any(v.get("status") in RENDERING for v in mine.values()):
            why = "a clip was left mid-render by a night that did not finish, and no render is running"
        elif any(v.get("status") in WAITING for v in mine.values()):
            why = "clips wait to render, but the night never reaches day %d (a catch-up day while gap days are paused, or no room on disk)" % day
        else:
            why = "nothing in motion: no receipt, not on the Learnings rebuild list, no clip waiting"
        out.append({"day": day, "task": a["task"], "since": a.get("synced") or "", "hoursWaiting": round(waited) if waited is not None else None,
                    "why": why, "feedback": (a.get("feedback") or "").strip(),
                    "clips": [{"name": k, "status": v.get("status"), "role": v.get("role"), "seconds": v.get("duration"),
                               "path": v.get("path"), "error": v.get("error")} for k, v in sorted(mine.items())]})
    return out


def resubmit_reason(day):
    """Why a waiting receipt has not gone back, in resubmit-ready's own words."""
    import render
    try:
        full = approval.bundle(day)["Long Form Video"] or {"fields": {}}
        path = os.path.join(render.RESUBMIT_DIR, "%d.md" % day)
        return render.resubmit_due(day, watch.load_ledger(), os.path.getmtime(path), approval.load_state().get(str(day)), full["fields"]) or "due now"
    except Exception as ex:                                       # noqa: BLE001
        return "could not tell (%s)" % str(ex)[:120]


def live_overlay(state, approvals, now=None, read_post=None, read_card=None):
    """What the hourly publisher would record if it ran now, applied to COPIES of its two state files (Kevin, 29 Sep
    2026: "when I look at it, I know the actual situation and there's no lag"). The hourly job is the one that writes
    state; between its runs, and all night, and while a render holds the queue (10:15 and 11:15 lost on 29 Sep) the
    page used to show posts that had gone out as pending and a card he had approved as waiting.

    The same rules as publish.sync and approval.sync, read-only:
      - a direct YouTube upload with a slot is live once the slot passes (publish.slot_passed);
      - a GoHighLevel post past its slot is asked for its status: failed is failed, published is published, and
        'scheduled' an hour past the slot with no failure went out (GHL never flips its own social posts);
      - an open approval card reads Kevin's verdict off the task, mapped by approval.verdict_patch.
    A read that fails leaves the stored status and is listed in `errors`, never guessed. Facebook profile shares,
    Spotify links and GHL-routed YouTube uploads need the browser or the channel listing and stay with the hourly job.
    Returns (state copy, approvals copy, info)."""
    import copy
    now = now or dt.datetime.now(dt.timezone.utc)
    st, ap = copy.deepcopy(state), copy.deepcopy(approvals)
    if read_post is None:
        loc = []                                             # the GHL key is read only when a post needs asking about
        def read_post(pid):
            if not loc: loc.append(publish._cfg()[1])
            g = publish.ghl("GET", "/social-media-posting/%s/posts/%s" % (loc[0], pid))
            return (g.get("results") or g).get("post") or g
    if read_card is None:
        def read_card(task):
            return watch._airtable("GET", approval.TASKS_API + "/" + task + "?returnFieldsByFieldId=true")["fields"]
    info = {"checkedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "postsRead": 0, "postsChanged": 0, "cardsRead": 0,
            "cardsDecided": 0, "errors": [], "faults": 0}
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    for day, entry in st.items():
        if not str(day).isdigit() or not isinstance(entry, dict): continue
        for key, p in (entry.get("posts") or {}).items():
            try:
                if p.get("status") != "scheduled" or not publish.slot_passed(p, now): continue   # nothing to learn before the slot
                if p.get("route") == "api":
                    p["status"] = "published"; p.setdefault("published_at", p["scheduled"]); info["postsChanged"] += 1
                    if p.get("clip") == "full" and not entry.get("youtube_link"): entry["youtube_link"] = p.get("link")
                    continue
                if not p.get("id"): continue
                try:
                    post = read_post(p["id"]); info["postsRead"] += 1
                except (Exception, SystemExit) as ex:
                    info["errors"].append("episode %s %s %s: %s" % (day, p.get("platform"), p.get("clip"), str(ex)[:160])); continue
                got, link = post.get("status"), post.get("previewLink") or ""
                if got == "scheduled" and not link and p.get("platform") != "youtube" and publish.slot_passed(p, now, publish.GHL_SLOT_GRACE_MIN):
                    got = "published"; p.setdefault("published_at", p["scheduled"])     # sync's grace rule stamps the slot
                if got and got != p["status"]:
                    p["status"] = got; info["postsChanged"] += 1
                if got == "published" and link:
                    p["link"] = link; p.setdefault("published_at", stamp)                 # sync stamps the time it saw the link
                    if p.get("platform") == "youtube" and not entry.get("youtube_link"): entry["youtube_link"] = link
            except Exception as ex:                          # one odd record is listed, never the end of the check
                info["errors"].append("episode %s post %s: %s" % (day, key, str(ex)[:160])); info["faults"] += 1
    for day, a in ap.items():
        if not (isinstance(a, dict) and a.get("task") and not a.get("verdict")): continue
        try:
            t = read_card(a["task"]); info["cardsRead"] += 1
        except (Exception, SystemExit) as ex:
            info["errors"].append("card for episode %s: %s" % (day, str(ex)[:160])); continue
        outcome = t.get(approval.TF["outcome"])
        if isinstance(outcome, dict): outcome = outcome.get("name")
        if not outcome: continue
        _, verdict = approval.verdict_patch(outcome, t.get(approval.TF["feedback"]), t.get(approval.TF["approvedAt"]))
        a.update({"verdict": verdict, "outcome": outcome, "feedback": (t.get(approval.TF["feedback"]) or ""),
                  "synced": now.astimezone(LONDON).strftime("%Y-%m-%dT%H:%M:%S")})
        info["cardsDecided"] += 1
    return st, ap, info


def say_live_errors(report):
    """A read that failed is a line in the log; a record the check could not handle at all is a fault, printed with
    ERROR: so run-job.sh marks the run failed instead of the fault living only on the page (review round 2)."""
    lv = report.get("live") or {}
    for e in lv.get("errors") or []: print("content report (live): could not check %s" % e, file=sys.stderr)
    if lv.get("faults"): print("ERROR: content report (live): %d record(s) could not be handled; see the lines above" % lv["faults"])


def build_live(now=None, read_post=None, read_card=None):
    """The report with what is true now read in. Both writers use it (review, 29 Sep 2026): the hourly write built
    without it put an approved card back to 'waiting' until the next ten-minute check."""
    now = now or dt.datetime.now(dt.timezone.utc)
    st, ap, info = live_overlay(publish.load_state(), approval.load_state(), now, read_post, read_card)
    report = build(now, st, ap)
    report["live"] = info
    return report


PUBLISHER_STAMP = os.path.join(os.path.dirname(watch.LEDGER), "publisher_at.txt")


def stamp_publisher(report, publisher, path=None, save=True):
    """publisherAt: when the hourly publisher or the night render last wrote the report. Theirs is now, kept in a
    local file (review round 2, 29 Sep 2026: carried over from the row, a live write racing an hourly one could put
    the old time back and call a running publisher dead). The live check reads the file; a missing or unreadable
    file leaves the field out, which the page shows as not stamped yet, never as fine."""
    path = path or PUBLISHER_STAMP
    if publisher:
        report["publisherAt"] = report["asOf"]
        if save:
            with open(path + ".tmp", "w") as fh: fh.write(report["asOf"])
            os.replace(path + ".tmp", path)
        return
    try: at = open(path).read().strip()
    except OSError: at = ""
    if parse_utc(at): report["publisherAt"] = at


def write(report, dry_run=False, publisher=False, stamp_path=None):
    """Upsert the one report row. publisher=True when the hourly publisher or the night render writes it: that stamps
    publisherAt. The ten-minute check carries the last stamp over from the row, so the page can still say the
    publisher itself has stopped (review, 29 Sep 2026: a fresh live report must never hide a dead publisher)."""
    now = report["asOf"].replace("Z", ".000Z")
    status = "Worked"
    fields = {ES["key"]: KEY, ES["kind"]: "report", ES["label"]: "Content publishing", ES["status"]: status,
              ES["detail"]: report["headline"][:900], ES["payload"]: json.dumps(report, separators=(",", ":")),
              ES["lastRun"]: now, ES["lastWorked"]: now, ES["updated"]: now}
    if dry_run:
        stamp_publisher(report, publisher, stamp_path, save=False)
        fields[ES["payload"]] = json.dumps(report, separators=(",", ":"))
        return fields
    pat = open(os.path.expanduser("~/.config/od/airtable_pat")).read().strip()
    def call(method, path, body=None):
        req = urllib.request.Request("https://api.airtable.com/v0/%s/%s" % (BASE, path), method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": "Bearer " + pat, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as resp: return json.loads(resp.read().decode())
    q = urllib.parse.urlencode({"returnFieldsByFieldId": "true", "filterByFormula": '{Key}="%s"' % KEY, "pageSize": "10"})
    have = call("GET", TABLE + "?" + q).get("records", [])
    stamp_publisher(report, publisher, stamp_path)
    fields[ES["payload"]] = json.dumps(report, separators=(",", ":"))
    if have: call("PATCH", TABLE, {"records": [{"id": have[0]["id"], "fields": fields}], "typecast": True})
    else: call("POST", TABLE, {"records": [{"fields": fields}], "typecast": True})
    return fields


def _selftest_parity():
    """Parity (review, 29 Sep 2026): the live check must say what the hourly publisher would record. Runs the REAL
    publish.sync and live_overlay on the same records against the same fake GoHighLevel, and requires the same status
    for every post and the same YouTube link for every episode. Every outside call is faked: nothing reaches
    GoHighLevel, YouTube, Drive, Spotify, Facebook or Airtable, and no state file is written."""
    import copy, io, contextlib
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    at = lambda minutes: (now + dt.timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
    ghl_post = lambda plat, clip, pid, mins, status="scheduled": {"platform": plat, "clip": clip, "status": status, "id": pid, "scheduled": at(mins)}
    records = {"_cursor": 2077,
               "2074": {"youtube_link": "https://youtu.be/prXjSYKZ0YE", "posts": {
                   "youtube|full|y": {"platform": "youtube", "clip": "full", "status": "published", "route": "api", "id": "prXjSYKZ0YE",
                                      "link": "https://youtu.be/prXjSYKZ0YE", "scheduled": at(-2000), "published_at": at(-2000), "thumb": True},
                   "tiktok|lfmd|t": ghl_post("tiktok", "lfmd", "PAST_GRACE", -245),
                   "instagram|summary|i": ghl_post("instagram", "summary", "FAILED1", -155),
                   "linkedin|lfmd|l": ghl_post("linkedin", "lfmd", "READERR", -215),
                   "threads|lfmd|h": ghl_post("threads", "lfmd", "INGRACE", -20),
                   "facebook|lfmd|f": ghl_post("facebook", "lfmd", "LIVELINK", -30),
                   "tiktok|summary|x": ghl_post("tiktok", "summary", "TOMORROW", 660),
                   "facebook|summary|d": {"platform": "facebook", "clip": "summary", "status": "draft", "id": "DRAFT"}}},
               "2075": {"posts": {
                   "youtube|lfmd|y": {"platform": "youtube", "clip": "lfmd", "status": "scheduled", "route": "api", "id": "hOf30fVYwDA",
                                      "link": "https://youtu.be/hOf30fVYwDA", "scheduled": at(-35)},
                   "youtube|full|g": ghl_post("youtube", "full", "GHLYT", -60),
                   "youtube|lfmd|g": ghl_post("youtube", "lfmd", "GHLYT2", -90)}}}
    said = {"PAST_GRACE": {"status": "scheduled"}, "FAILED1": {"status": "failed", "error": "token expired"}, "INGRACE": {"status": "scheduled"},
            "LIVELINK": {"status": "published", "previewLink": "https://facebook.com/p/1"}, "TOMORROW": {"status": "scheduled"},
            "GHLYT": {"status": "published", "previewLink": "https://youtu.be/ghl"}, "GHLYT2": {"status": "scheduled"}}
    def fake_ghl(method, path, body=None, brand="Runpreneur"):
        assert method == "GET", "the parity run only ever reads"
        pid = path.rsplit("/", 1)[-1]
        if pid == "READERR": raise SystemExit("GHL GET %s -> 502: gateway" % path)
        return {"post": dict(said[pid])}
    saved_disk = {}
    fakes = {"load_state": lambda: copy.deepcopy(records), "save_state": lambda st: saved_disk.update(state=copy.deepcopy(st)),
             "_cfg": lambda brand="Runpreneur": ("k", "loc", "user"), "youtube_truth": lambda st: {}, "prune_publish_cache": lambda st, now=None, root=None: [],
             "monetise_long_video": lambda day, entry: False, "share_to_facebook_profile": lambda day, entry, st, clip="summary": False,
             "spotify_link_due": lambda pod, now=None: False, "ghl": fake_ghl, "youtube_link_from_channel": lambda *a, **k: None}
    real = {k: getattr(publish, k) for k in fakes}
    real_find, real_air = publish.pc.find_by_name, publish.watch._airtable
    try:
        for k, v in fakes.items(): setattr(publish, k, v)
        publish.pc.find_by_name = lambda name: {"id": "recF", "fields": {}}
        publish.watch._airtable = lambda *a, **k: {}
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            publish.sync()
            live, _, _ = live_overlay(copy.deepcopy(records), {}, now, read_card=lambda t: {})
    finally:
        for k, v in real.items(): setattr(publish, k, v)
        publish.pc.find_by_name, publish.watch._airtable = real_find, real_air
    synced = saved_disk.get("state") or copy.deepcopy(records)
    for day in ("2074", "2075"):
        for key in records[day]["posts"]:
            a, b = synced[day]["posts"][key].get("status"), live[day]["posts"][key].get("status")
            assert a == b, "episode %s %s: the hourly sync records %r, the live check says %r" % (day, key, a, b)
        assert synced[day].get("youtube_link") == live[day].get("youtube_link"), (day, synced[day].get("youtube_link"), live[day].get("youtube_link"))
    moved = sum(1 for d in ("2074", "2075") for k in records[d]["posts"] if records[d]["posts"][k]["status"] != synced[d]["posts"][k]["status"])
    assert moved >= 4, "control: the parity run moved %d posts; a run that moves nothing proves nothing" % moved


def selftest():
    real_holds = publish.held_days; publish.held_days = lambda path=None: {}   # the real hold file never steers the selftest
    try: _selftest_live(); _selftest()
    finally: publish.held_days = real_holds


def _selftest_live():
    """The live check (29 Sep 2026), on the three records Kevin approved at the build gate, read that night at 23:35:
    2075's YouTube Short (direct upload, slot 23:00), 2074's TikTok Learnings post (GoHighLevel, slot 19:30) and the
    2077 card he approved at 17:30. Plus a post GoHighLevel failed, a read that errors, a post inside its grace hour
    and a post not due yet. Nothing reaches GoHighLevel or Airtable; the stored state is never touched."""
    import copy
    now = dt.datetime(2026, 9, 29, 22, 35, tzinfo=dt.timezone.utc)
    yt_full = lambda link, at: {"platform": "youtube", "clip": "full", "status": "published", "route": "api", "link": link, "published_at": at, "scheduled": at}
    ghl = lambda plat, clip, pid, when, status="scheduled": {"platform": plat, "clip": clip, "status": status, "id": pid, "scheduled": when}
    state = {"_cursor": 2077,
             "2074": {"youtube_link": "https://youtu.be/prXjSYKZ0YE", "posts": {
                 "youtube|full|y": yt_full("https://youtu.be/prXjSYKZ0YE", "2026-09-28T17:00:00Z"),
                 "tiktok|lfmd|t": ghl("tiktok", "lfmd", "6abb7e802e91602dfd467eec", "2026-09-29T18:30:00Z"),
                 "instagram|summary|i": ghl("instagram", "summary", "FAILED1", "2026-09-29T20:00:00Z"),
                 "linkedin|lfmd|l": ghl("linkedin", "lfmd", "READERR", "2026-09-29T19:00:00Z")}},
             "2075": {"youtube_link": "https://youtu.be/1WdR932ntsc", "posts": {
                 "youtube|full|y": yt_full("https://youtu.be/1WdR932ntsc", "2026-09-28T10:33:51Z"),
                 "youtube|lfmd|y": {"platform": "youtube", "clip": "lfmd", "status": "scheduled", "route": "api", "id": "hOf30fVYwDA",
                                    "link": "https://youtu.be/hOf30fVYwDA", "scheduled": "2026-09-29T22:00:00Z"},
                 "threads|lfmd|h": ghl("threads", "lfmd", "INGRACE", "2026-09-29T22:15:00Z"),
                 "facebook|lfmd|f": ghl("facebook", "lfmd", "LIVELINK", "2026-09-29T22:05:00Z"),
                 "tiktok|summary|t": ghl("tiktok", "summary", "TOMORROW", "2026-09-30T10:00:00Z")}}}
    approvals = {"2077": {"task": "reccNLyc0kzOzhh4v", "record": "reclxq5r7o6ffaHLi"}, "2078": {"task": "recOPEN", "record": "recX"}}
    ghl_says = {"6abb7e802e91602dfd467eec": {"status": "scheduled"}, "FAILED1": {"status": "failed", "error": "token expired"},
                "INGRACE": {"status": "scheduled"}, "LIVELINK": {"status": "published", "previewLink": "https://facebook.com/p/1"}}
    asked = []
    def read_post(pid):
        asked.append(pid)
        if pid == "READERR": raise SystemExit("GHL GET /posts/READERR -> 502: gateway")
        return ghl_says[pid]
    cards = {"reccNLyc0kzOzhh4v": {approval.TF["outcome"]: "Approved as-is", approval.TF["approvedAt"]: "2026-09-29T16:30:51.555Z"}, "recOPEN": {}}
    before_s, before_a = copy.deepcopy(state), copy.deepcopy(approvals)
    st, ap, info = live_overlay(state, approvals, now, read_post, cards.__getitem__)
    assert state == before_s and approvals == before_a, "the stored state is never changed"
    P = lambda d, k: st[d]["posts"][k]["status"]
    assert P("2075", "youtube|lfmd|y") == "published", "2075's YouTube Short: a direct upload is live once its slot passes"
    assert P("2074", "tiktok|lfmd|t") == "published", "2074's TikTok Learnings post: 'scheduled' an hour past its slot with no failure went out"
    assert P("2074", "instagram|summary|i") == "failed", "a post GoHighLevel failed is shown failed, never out"
    assert P("2074", "linkedin|lfmd|l") == "scheduled" and any("READERR" in e or "502" in e for e in info["errors"]), "a read that fails is listed, never guessed"
    assert P("2075", "threads|lfmd|h") == "scheduled", "inside the grace hour a 'scheduled' post is not called out yet"
    assert P("2075", "facebook|lfmd|f") == "published" and st["2075"]["posts"]["facebook|lfmd|f"]["link"] == "https://facebook.com/p/1"
    assert P("2075", "tiktok|summary|t") == "scheduled" and "TOMORROW" not in asked, "a post not due yet is not asked about"
    assert "hOf30fVYwDA" not in asked, "a direct YouTube upload needs no GoHighLevel read"
    assert ap["2077"]["verdict"] == "approved" and "verdict" not in ap["2078"], "2077: approved on the card counts at once; 2078 still waits"
    assert info["postsRead"] == 4 and info["cardsRead"] == 2 and info["cardsDecided"] == 1, info
    assert publish.section_status(st["2075"])["YouTube Short"] == "done" and publish.section_status(state["2075"])["YouTube Short"] == "pending"
    rep_live, rep_old = build(now, st, ap, {}, {}, plan=[], skipped=[], holds={}), build(now, state, approvals, {}, {}, plan=[], skipped=[], holds={})
    assert rep_old["waitingForKevin"] == [2077, 2078] and rep_live["waitingForKevin"] == [2078], (rep_old["waitingForKevin"], rep_live["waitingForKevin"])
    assert publish.slot_passed({"scheduled": "2026-09-29T22:00:00Z"}, now) and not publish.slot_passed({"scheduled": "2026-09-29T22:00:00Z"}, now, 60)
    assert not publish.slot_passed({}, now)
    try: publish.slot_passed({"scheduled": "rubbish"}, now); raise AssertionError("an unreadable slot must raise, as sync always has")
    except ValueError: pass
    # more records the hourly sync treats its own way (review, 29 Sep 2026)
    odd = {"2076": {"posts": {
        "youtube|full|g": {"platform": "youtube", "clip": "full", "status": "scheduled", "id": "GHLYT", "scheduled": "2026-09-29T20:00:00Z"},
        "youtube|lfmd|g": {"platform": "youtube", "clip": "lfmd", "status": "scheduled", "id": "GHLYT2", "scheduled": "2026-09-29T20:00:00Z"},
        "facebook|summary|d": {"platform": "facebook", "clip": "summary", "status": "draft", "id": "DRAFT", "scheduled": None},
        "youtube|lfmd|n": {"platform": "youtube", "clip": "lfmd", "status": "scheduled", "route": "api", "id": "NOSLOT"},
        "threads|summary|b": {"platform": "threads", "clip": "summary", "status": "scheduled", "id": "BADSLOT", "scheduled": "not a time"}}}}
    said = {"GHLYT": {"status": "published", "previewLink": "https://youtu.be/ghl"}, "GHLYT2": {"status": "scheduled"}}
    asked.clear()
    st2, _, info2 = live_overlay(odd, {}, now, lambda pid: (asked.append(pid), said[pid])[1], cards.__getitem__)
    Q = lambda k: st2["2076"]["posts"][k]
    assert Q("youtube|full|g")["status"] == "published" and st2["2076"]["youtube_link"] == "https://youtu.be/ghl" and Q("youtube|full|g")["published_at"] == "2026-09-29T22:35:00Z", \
        "a GoHighLevel YouTube upload with its link: published when seen, as sync stamps it"
    assert Q("youtube|lfmd|g")["status"] == "scheduled", "a GoHighLevel YouTube post with no link waits for the hourly channel lookup, never the grace hour"
    assert Q("facebook|summary|d")["status"] == "draft" and "DRAFT" not in asked, "a test-mode draft never moves"
    assert Q("youtube|lfmd|n")["status"] == "scheduled", "a direct upload with no slot is left to the hourly sync (it asks YouTube)"
    assert Q("threads|summary|b")["status"] == "scheduled" and any("not a time" in e or "isoformat" in e for e in info2["errors"]), "an unreadable slot is listed, the check carries on"
    _selftest_parity()
    # publisherAt (review, 29 Sep 2026): the hourly write stamps it, the live check carries it over, nothing guesses it
    import tempfile
    sp = os.path.join(tempfile.mkdtemp(), "publisher_at.txt")
    r0 = {"asOf": "2026-09-29T22:40:00Z", "headline": "h"}; write(r0, dry_run=True, publisher=False, stamp_path=sp)
    assert "publisherAt" not in r0, "no stamp file: the field is left out, never guessed"
    stamp_publisher({"asOf": "2026-09-29T19:17:00Z"}, True, sp)                  # the 20:15 hourly run
    r1 = {"asOf": "2026-09-29T22:40:00Z", "headline": "h"}; f1 = write(r1, dry_run=True, publisher=False, stamp_path=sp)
    r2 = {"asOf": "2026-09-29T22:40:00Z", "headline": "h"}; write(r2, dry_run=True, publisher=True, stamp_path=sp)
    assert r1["publisherAt"] == "2026-09-29T19:17:00Z" and r2["publisherAt"] == "2026-09-29T22:40:00Z", (r1, r2)
    assert open(sp).read() == "2026-09-29T19:17:00Z", "a dry run never moves the stamp"
    assert json.loads(f1[ES["payload"]]) == r1, "the payload written is the report as stamped"
    open(sp, "w").write("garbage"); r4 = {"asOf": "x", "headline": "h"}; stamp_publisher(r4, False, sp); assert "publisherAt" not in r4


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
    # 2 Oct 2026, the real records: 2081 sent back on 1 Oct, 2082 and 2083 approved the next morning. Until then the
    # report read "nothing can go out; Episode 2082, 2083 wait behind day 2081". An approved day waits for no other day.
    on_yt = lambda link="l": {"youtube_link": link, "posts": {"youtube|full|y": {"platform": "youtube", "clip": "full", "status": "scheduled"}}}
    cards81 = {"2081": {"task": "rec9xni7vjiBDIyD5", "verdict": "changes", "synced": "2026-10-01T11:15:57", "feedback": "redo the learnings for my diary"},
               "2082": {"task": "rec5HLbg1dMG3JF4x", "verdict": "approved"}, "2083": {"task": "recPI2X4HAT8EAMmk", "verdict": "approved"}}
    led81 = {"a": {"episode": 2081, "role": "episode", "status": "rendered"}, "b": {"episode": 2082, "role": "episode", "status": "rendered"},
             "c": {"episode": 2083, "role": "episode", "status": "rendered"}}
    nw = build(now, {"_cursor": 2080, "2080": on_yt()}, cards81, led81, {}, plan=[], skipped=[])
    assert nw["nextInOrder"] == [2082, 2083] and nw["leftBehind"] == [], (nw["nextInOrder"], nw["leftBehind"])
    assert "Today: Episodes 2082, 2083 go out once the publisher picks them up. No episode cards wait for you; Episode 2081 sent back, not resubmitted." in nw["headline"], nw["headline"]
    assert nw["sentBack"] == [{"day": 2081, "since": "1 Oct", "feedback": "redo the learnings for my diary", "rejected": False}], nw["sentBack"]
    assert not any(k in nw for k in ("heldBehind", "blocker", "heldWhy")), "nothing is held for order any more"
    # once they are out the run has gone past 2081: it is named as left behind, with its reason, until it is on YouTube
    past = build(now, {"_cursor": 2083, "2080": on_yt(), "2082": on_yt(), "2083": on_yt()}, cards81, led81, {}, plan=[], skipped=[])
    assert past["nextInOrder"] == [] and past["leftBehind"] == [{"day": 2081, "why": "sent back on 1 Oct, not resubmitted"}], past["leftBehind"]
    back = dict(cards81, **{"2081": {"task": "rec9xni7vjiBDIyD5", "verdict": "approved"}})          # the fixed card, approved
    late = build(now, {"_cursor": 2083, "2080": on_yt(), "2082": on_yt(), "2083": on_yt()}, back, led81, {}, plan=[], skipped=[])
    assert late["nextInOrder"] == [2081] and late["leftBehind"] == [] and late["sentBack"] == [], "the late day goes when its own card is approved"
    assert "Today: Episode 2081 goes out once the publisher picks it up" in late["headline"], late["headline"]
    done = build(now, {"_cursor": 2083, "2080": on_yt(), "2081": on_yt(), "2082": on_yt(), "2083": on_yt()}, back, led81, {}, plan=[], skipped=[])
    assert done["leftBehind"] == [] and done["nextInOrder"] == [], "a day on YouTube is no longer behind"
    # a card still waiting for Kevin holds nothing: 2059 goes, 2058 stays in his list (it is ahead of the run, not behind it)
    held_state = {"_cursor": 2057}
    rh = build(now, held_state, {"2058": {"task": "t"}, "2059": {"verdict": "approved", "task": "t2"}}, {"x": {"episode": 2058}, "y": {"episode": 2059}}, {}, plan=[])
    assert rh["nextInOrder"] == [2059] and rh["waitingForKevin"] == [2058] and rh["leftBehind"] == [], rh
    assert "Today: Episode 2059 goes out once the publisher picks it up. 1 episode card waits for you." in rh["headline"], rh["headline"]
    later = build(now, held_state, {"2058": {"task": "t"}, "2059": {"verdict": "approved", "task": "t2"}, "2060": {"task": "t3", "verdict": "changes", "synced": "2026-09-15T10:00:00"}},
                  {"x": {"episode": 2058}, "y": {"episode": 2059}}, {}, plan=[], skipped=[])
    assert later["headline"].endswith("1 episode card waits for you; Episode 2060 sent back, not resubmitted."), later["headline"]
    # 2066 on 21 Sep 2026: only the teaser rendered, the full clip unseen. No card can come for it; the days after it go.
    tl = {"t": {"episode": 2059, "role": "teaser", "status": "rendered"}, "f": {"day": 2060, "status": "new"},
          "u": {"episode": 2061, "role": "teaser", "status": "rendered"}, "v": {"episode": 2061, "role": "episode", "status": "rendered"}}
    to = build(now, held_state, {"2058": {"verdict": "approved", "task": "t"}, "2060": {"verdict": "approved", "task": "t2"}}, tl, {}, plan=[], skipped=["2026/x/2059 Full-Real.insv"])
    assert to["teaserOnly"] == [2059], to["teaserOnly"]
    assert to["skippedNames"] == ["2026/x/2059 Full-Real.insv"]
    assert to["nextInOrder"] == [2058, 2060], "both approved days go; the teaser-only day between them holds neither"
    to2 = build(now, {"_cursor": 2060, "2058": on_yt(), "2060": on_yt()}, {"2058": {"verdict": "approved", "task": "t"}, "2060": {"verdict": "approved", "task": "t2"}}, tl, {}, plan=[], skipped=[])
    assert to2["teaserOnly"] == [2059] and to2["leftBehind"] == [{"day": 2059, "why": "the engine has found only its teaser, no full episode"}], \
        "a teaser-only day the run has gone past is still named: %s" % to2["leftBehind"]
    assert "Episode 2059 not out yet (the engine has found only its teaser, no full episode)" in to2["headline"], to2["headline"]
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
    # every state a day the run has gone past can sit in is named (review, 21 Sep 2026; left behind, 2 Oct 2026)
    two = {"x": {"episode": 2058}, "y": {"episode": 2059}}
    gone = {"_cursor": 2059, "2059": on_yt()}                       # 2059 is out; 2058 is the day behind it
    why58 = lambda cards, led=two, **kw: (build(now, gone, dict({"2059": {"verdict": "approved", "task": "t2"}}, **cards), led, {}, plan=[], skipped=[], **kw)["leftBehind"] or [{}])[0]
    hd = build(now, held_state, {"2058": {"verdict": "approved", "task": "t"}, "2059": {"verdict": "approved", "task": "t2"}}, two, {}, plan=[], skipped=[],
               holds={2058: "Kevin 17 Sep: reinstate the Learnings clip"})
    assert hd["nextInOrder"] == [2059], "a held day holds only itself: %s" % hd["nextInOrder"]
    assert hd["leftBehind"] == [{"day": 2058, "why": "held: Kevin 17 Sep: reinstate the Learnings clip"}], "a held day is named even while it is ahead of the run: %s" % hd["leftBehind"]
    assert "Episode 2058 not out yet (held: Kevin 17 Sep: reinstate the Learnings clip)" in hd["headline"], hd["headline"]
    rj = build(now, gone, {"2058": {"task": "t", "verdict": "rejected", "synced": "2026-09-14T10:00:00"}, "2059": {"verdict": "approved", "task": "t2"}}, two, {}, plan=[], skipped=[])
    assert rj["sentBack"][0]["rejected"] and rj["leftBehind"] == [{"day": 2058, "why": "rejected on 14 Sep, not resubmitted"}], rj["leftBehind"]
    assert rj["headline"].endswith("No episode cards wait for you; Episode 2058 rejected, not resubmitted."), rj["headline"]
    gp = build(now, {"_cursor": 2057, "2057": {"youtube_link": "l"}}, {"1841": {"task": "t", "verdict": "changes"}, "2057": {"task": "t0", "verdict": "changes"}}, {}, {}, plan=[], skipped=[])
    assert [s["day"] for s in gp["sentBack"]] == [1841], "a published day drops out of the sent-back list"
    assert why58({"2058": {"task": "t"}}) == {"day": 2058, "why": "its card waits for your approval"}
    assert why58({}, {"x": {"episode": 2058, "role": "episode", "status": "rendered"}, "y": {"episode": 2059}}) == {"day": 2058, "why": "rendered, its card is not raised yet"}
    assert why58({"2058": {"qa_waiting": {"at": "x"}}}) == {"day": 2058, "why": "its card waits for the files to be readable"}
    assert why58({"2058": {"qa_blocked": {"failures": ["no Learnings clip"]}}}) == {"day": 2058, "why": "it failed its output check"}
    assert why58({}, {"x": {"day": 2058, "status": "failed"}, "y": {"episode": 2059}}) == {"day": 2058, "why": "its render failed"}
    assert why58({}, {"x": {"day": 2058, "status": "new"}, "y": {"episode": 2059}}) == {}, "a day waiting its turn to render is the backlog, not a day left behind"
    # review, 2 Oct 2026: one approved day far ahead of the run publishes, as ruled. The backlog between is not listed day by day
    far_led = dict({"d%d" % d: {"day": d, "status": "new"} for d in range(2060, 2200)}, s={"day": 2058, "status": "failed"})
    far = build(now, {"_cursor": 2210, "2210": on_yt()}, {"2210": {"verdict": "approved", "task": "t"}}, far_led, {}, plan=[], skipped=[])
    assert far["leftBehind"] == [{"day": 2058, "why": "its render failed"}], "the backlog is not a list of 140 days: %s" % far["leftBehind"][:3]
    many = build(now, {"_cursor": 2210, "2210": on_yt()}, {"2210": {"verdict": "approved", "task": "t"}}, {"f%d" % d: {"day": d, "status": "failed"} for d in range(2060, 2070)}, {}, plan=[], skipped=[])
    assert len(many["leftBehind"]) == 10 and many["headline"].endswith("; and 6 more not out yet (the Publishing page lists them)."), many["headline"][-160:]
    assert len(many["headline"]) < 900, "the 08:00 line fits: %d" % len(many["headline"])
    # an upload that died leaves a post record with no link: the publisher waits on it for ever, so the report names it
    dead = {"posts": {"youtube|full|y": {"platform": "youtube", "clip": "full", "status": "creating"}}}
    dd = build(now, {"_cursor": 2059, "2058": dead, "2059": on_yt()}, {"2058": {"verdict": "approved", "task": "t"}, "2059": {"verdict": "approved", "task": "t2"}}, two, {}, plan=[], skipped=[])
    assert dd["nextInOrder"] == [] and dd["leftBehind"] == [{"day": 2058, "why": "its YouTube post is creating, with no link yet"}], dd["leftBehind"]
    # second review, 2 Oct 2026: a dead upload ABOVE the run is named too (nothing later may ever publish to pass it)
    da = build(now, {"_cursor": 2057, "2058": dead}, {"2058": {"verdict": "approved", "task": "t"}}, two, {}, plan=[], skipped=[])
    assert da["leftBehind"] == [{"day": 2058, "why": "its YouTube post is creating, with no link yet"}], da["leftBehind"]
    # a GoHighLevel-carried upload booked for later today has no link yet and is fine; an hour past its slot it is not
    ghl_yt = lambda when: {"posts": {"youtube|full|y": {"platform": "youtube", "clip": "full", "status": "scheduled", "id": "g", "scheduled": when}}}
    bk = build(now, {"_cursor": 2059, "2058": ghl_yt("2026-09-16T18:00:00Z"), "2059": on_yt()}, {"2058": {"verdict": "approved", "task": "t"}, "2059": {"verdict": "approved", "task": "t2"}}, two, {}, plan=[], skipped=[])
    assert bk["leftBehind"] == [], "a booked upload inside its slot is not a day left behind: %s" % bk["leftBehind"]
    lt = build(now, {"_cursor": 2059, "2058": ghl_yt("2026-09-16T04:00:00Z"), "2059": on_yt()}, {"2058": {"verdict": "approved", "task": "t"}, "2059": {"verdict": "approved", "task": "t2"}}, two, {}, plan=[], skipped=[])
    assert lt["leftBehind"] == [{"day": 2058, "why": "its YouTube post is scheduled, with no link yet"}], "three hours past its slot with no link, it is named: %s" % lt["leftBehind"]
    # a clip stuck mid-render is not in the night's queue (the plan takes 'new' only): its day is named, not dropped as backlog
    assert why58({}, {"x": {"day": 2058, "status": "rendering"}, "y": {"episode": 2059}}) == {"day": 2058, "why": "not rendered: a clip sits at rendering, outside the night's queue"}
    assert why58({}, {"x": {"day": 2058, "status": "new"}, "x2": {"day": 2058, "status": "pulled"}, "y": {"episode": 2059}}) == {"day": 2058, "why": "not rendered: a clip sits at pulled, outside the night's queue"}
    assert why58({}, {"x": {"day": 2058, "status": "new"}, "x2": {"day": 2058, "status": "rendered", "role": "teaser"}, "y": {"episode": 2059}}) == {}, "a rendered teaser beside a waiting full clip is still the queue"
    import watch as _w3; real_g3 = _w3.gap_days; _w3.gap_days = lambda path=None: {1808}
    try:
        gd = build(now, {"_cursor": 2059, "1808": dead, "2059": on_yt()}, {"1808": {"verdict": "approved", "task": "t"}, "2059": {"verdict": "approved", "task": "t2"}}, two, {}, plan=[], skipped=[])
        assert gd["leftBehind"] == [{"day": 1808, "why": "its YouTube post is creating, with no link yet"}], "a dead upload on a gap day is named too: %s" % gd["leftBehind"]
    finally: _w3.gap_days = real_g3
    # a noted day later put on hold reads as held, not as the old refusal
    hn = build(now, {"_cursor": 2057, "2058": {"not_published": {"why": "session text is in its copy", "since": "x"}}}, {"2058": {"verdict": "approved", "task": "t"}}, two, {}, plan=[], skipped=[], holds={2058: "Kevin: wait"})
    assert hn["leftBehind"] == [{"day": 2058, "why": "held: Kevin: wait"}], hn["leftBehind"]
    # an approved day the publisher tried and could not publish is never promised as going out, wherever the run is
    rf = build(now, {"_cursor": 2057, "2058": {"not_published": {"why": "session text is in its copy", "since": "x"}}},
               {"2058": {"verdict": "approved", "task": "t"}, "2059": {"verdict": "approved", "task": "t2"}}, two, {}, plan=[], skipped=[])
    assert rf["nextInOrder"] == [2059] and rf["leftBehind"] == [{"day": 2058, "why": "the publisher could not publish it: session text is in its copy"}], (rf["nextInOrder"], rf["leftBehind"])
    assert "Episode 2058 not out yet (the publisher could not publish it: session text is in its copy)" in rf["headline"], rf["headline"]
    assert why58({}, {"x": {"day": 2058, "status": "broll"}, "y": {"episode": 2059}}) == {}, "a day of B-roll only is not an episode left behind"
    assert why58({}, {"y": {"episode": 2059}}) == {}, "a day never recorded is not behind"
    import watch as _w2; real_g = _w2.gap_days; _w2.gap_days = lambda path=None: {2058}
    try: assert why58({"2058": {"task": "t"}}) == {}, "a gap day fills an old hole on its own list; it is not behind the run"
    finally: _w2.gap_days = real_g
    print(json.dumps({"checks": 90, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("mode"); ap.add_argument("--hours", type=float, default=24)
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "build": print(json.dumps(build(), indent=1))
    elif a.mode == "write":
        rep = build_live(); lift_gap_pause(rep); write(rep, publisher=True); print("content report: " + rep["headline"])
        say_live_errors(rep)
    elif a.mode == "live":
        # every 10 minutes, outside the job queue (29 Sep 2026). Read-only against the platforms and the engine's state.
        rep = build_live(); write(rep); lv = rep["live"]
        print("content report (live): %d post(s) read, %d changed, %d card(s) read, %d decided. %s"
              % (lv["postsRead"], lv["postsChanged"], lv["cardsRead"], lv["cardsDecided"], rep["headline"]))
        say_live_errors(rep)
    elif a.mode == "stuck":
        # daily-ops reads this (Kevin, 27 Sep 2026). Exit 2 when the state cannot be read: never "nothing stuck".
        try: rows = stuck_sent_back(hours=a.hours, why_waiting=resubmit_reason)
        except Exception as ex:                                   # noqa: BLE001
            print("content stuck: could not tell (%s)" % str(ex)[:200], file=sys.stderr); sys.exit(2)
        print(json.dumps({"stuck": rows}, indent=1))
    else: raise SystemExit("usage: content_report.py build | write | live | stuck [--hours N] | selftest")
