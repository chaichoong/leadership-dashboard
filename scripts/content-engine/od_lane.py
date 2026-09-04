#!/usr/bin/env python3
"""od_lane.py — the Operations Director brand profile of the Content Engine, VERSION 2 (Kevin's feedback, 4 Sep 2026).

The brief (od_prompts.BRIEF): AI agents doing 90% of a business's daily operations. Every post teaches one thing an
overwhelmed owner can use this week to hand a real job to an agent. Dan Martell's shapes, each with an infographic drawn by
code. Sources in priority order: Kevin's PLANNED recordings (a rolling brief of ten topics he records on his runs), the
BUILD LOG (what his agents actually did: register rows + merged pull requests of this repo), RESEARCH (real founder pain
from the Prospects table's harvested signals, frameworks from the brain's library), and vlog GOLD only (score 8+, about an
agent doing a job). A weekly LinkedIn newsletter on Kevin's personal profile (no API: the browser lane publishes, Kevin
pastes as the fallback). One approval card per piece; six land in Monday's 08:00 digest. Test mode until Kevin writes live.

  mine [--limit N]        transcripts not yet mined -> word gate -> AI (threshold 8, agent-related) -> bank; marks a
                          recording-brief topic recorded when the AI recognises it.
  topics                  the rolling ten-topic recording brief -> state + talking-points.md (Sun/Mon in the job).
  draft [--week DATE]     fill next week's five shapes from the sources, write each post (brief -> draft -> polish ->
                          usefulness check, one redraft -> rules check -> infographic), one record each; then the Friday
                          newsletter edition. Idempotent: a slot already drafted is left alone.
  cards                   one approval card per drafted piece without one (posts and the edition).
  sync                    Kevin's verdicts -> records; Changes requested = one redo; Rejected with a reason = OD lesson.
  publish                 approved posts -> GoHighLevel on the OD brand (page + Facebook page), 08:00 London; drafts in test.
  publish-sync            GHL statuses -> links on the records.
  newsletter-publish      approved editions due today or earlier -> the browser lane (prepare, then commit in live mode).
  backtest [--limit N]    read-only: score the N most recent transcripts.   report   selftest

State (outside the public repo): ~/knowledge-os/logs/content-engine/od-bank.json, od-lane.json, od-cards/.
Hold: ~/.config/od/content_engine_od_hold exists = draft and cards do nothing (Kevin's re-plan switch).
"""
import argparse, datetime as dt, json, os, re, subprocess, sys, tempfile, urllib.parse
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import watch                # noqa: E402
import platform_copy as pc  # noqa: E402
import approval             # noqa: E402
import publish              # noqa: E402
import od_prompts as P      # noqa: E402
import od_infographic       # noqa: E402

LONDON = ZoneInfo("Europe/London")
REPO = os.path.dirname(os.path.dirname(HERE))
BANK = os.path.join(os.path.dirname(watch.LEDGER), "od-bank.json")
STATE = os.path.join(os.path.dirname(watch.LEDGER), "od-lane.json")
POINTS = os.path.join(os.path.dirname(watch.LEDGER), "talking-points.md")
CARDS_DIR = os.path.join(os.path.dirname(watch.LEDGER), "od-cards")
HOLD_FILE = os.path.expanduser("~/.config/od/content_engine_od_hold")
BRAND = "Operations Director"
BUSINESS_OD = "reca9ofzhuw13ZzGE"        # Tasks -> Business "Operations Director" (verified 6 Aug 2026, CLAUDE.md)
OD_SLOT, NEWSLETTER_SLOT = (8, 0), (8, 0)
GATE_WORDS, AI_THRESHOLD, BANK_DAYS, MAX_MOMENTS, TOPIC_DAYS, TOPIC_COUNT = 3.0, 6, 60, 3, 21, 10
CTA_LINK = "https://api.leadconnectorhq.com/widget/booking/BcVVhAg1zLaPVEXj5ih0"   # Operations Review Call; the lead magnet replaces it
CLOSING = approval.CLOSING
STATUS_DRAFTED, STATUS_QC, STATUS_APPROVED, STATUS_SCHEDULED, STATUS_PUBLISHED = "Copies in Progress", "Quality Control", "Approved for Publishing", "Publishing In Progress", "Published"
MINUTES = {"approved": 2, "minor": 5, "changes": 10, "rejected": 3}    # ESTIMATES per verdict, never presented as measured
REGISTER_API = "https://api.airtable.com/v0/%s/tbl9msVjyQWslLOIZ" % watch.BASE
PROSPECTS_API = "https://api.airtable.com/v0/%s/tbljHVGJoKJf8acy3" % watch.BASE
FRAMEWORKS = os.path.expanduser("~/Library/CloudStorage/GoogleDrive-kevin@runpreneur.org.uk/My Drive/00 AI Context/Knowledge/frameworks-library.md")
AGENT_BROWSER = os.path.join(REPO, "scripts", "agent-browser.js")
USEFUL_MIN = 7

OD_WORDS = [r"\bai\b", r"\bagents?\b", r"\bautomat\w*", r"\bsystem\w*", r"\bprocess\w*", r"\boperations?\b", r"\bdelegat\w*", r"\bworkflow\w*",
            r"\bsops?\b", r"\bbusiness(es)?\b", r"\bfounder\w*", r"\bentrepreneur\w*", r"\bclaude\b", r"\bdashboard\w*", r"\bairtable\b", r"\bprofit\w*",
            r"\bcash ?flow\b", r"\bteam\b", r"\bclients?\b", r"\bproductiv\w*", r"\bmicromanag\w*", r"\bdecision\w*", r"\bscal(e|ing)\b", r"\bhir(e|ing)\b",
            r"\bkpis?\b", r"\bmetrics?\b", r"\bsoftware\b", r"\btools?\b", r"\broutines?\b", r"\bchecklists?\b", r"\bbots?\b"]
# "run" is a business word ("runs without you" is the core message), so only the RUNNING senses are stripped.
STRIP_WORDS = re.compile(r"\b(km|kilomet\w*|streak|barefoot|vibrams?|runpreneur|marathon|ultra|charit\w*|children|kids|donat\w*|strava|miles?|jog\w*|trainers|"
                         r"(?:my|today's|this morning's|the|a|each|every) (?:morning |daily |long |short |early )?run|went (?:out )?for a run|running (?:shoes|streak|club|vlog|diary)|runner)\b", re.I)
BANNED = ["amazing", "incredible", "crushing it", "smashing", "game-changer", "game changer", "unlock", "skyrocket", "revolutionis", "disruptive", "cutting-edge",
          "groundbreaking", "powerful", "delve", "harness", "tapestry", "landscape", "navigating", "journey", "in a world where", "not alone", "dive deep", "leverage"]
STOCK_OPENERS = ("in business and", "day ", "imagine ", "picture this")
US_SPELLINGS = re.compile(r"\b(realiz\w*|organiz\w*|color|favorite|center|analyz\w*|behavior|optimiz\w*|prioritiz\w*)\b", re.I)
PRICE_OK = ("£1,500", "£350", "30-day", "30 day")
TICS = re.compile(r"(?:^|(?<=[.!?]\s)|(?<=\n))(The reality is|Here's the thing|Let that sink in|The truth is)[,:]?\s+(\w)", re.M)
TIME_WORDS = re.compile(r"\b(today|this morning|yesterday|this week|tonight|just now|earlier today)\b", re.I)
RESEARCH_KEYS = re.compile(r"agent|\bai\b|automat|system|delegat|process|workflow|operations|routine|checklist|sop", re.I)


# ---------- pure helpers (selftested) ----------

def on_hold():
    return os.path.exists(HOLD_FILE)


def gate_density(text):
    """OD words per 1,000 words. Free, deterministic, and only a FILTER: the AI decides."""
    words = max(1, len(text.split()))
    return sum(len(re.findall(p, text, re.I)) for p in OD_WORDS) * 1000.0 / words


def parse_mine(result):
    """The AI's JSON, or None when it did not answer in the shape asked for (a non-answer is not a 'no')."""
    try:
        s = result.strip().strip("`"); s = s[s.find("{"): s.rfind("}") + 1]
        d = json.loads(s)
        score = int(d.get("score", 0)); moments = []
        for m in (d.get("moments") or [])[:MAX_MOMENTS]:
            q = (m.get("quote") or "").strip()
            if len(q.split()) >= 5: moments.append({"quote": q, "angle": (m.get("angle") or "").strip(), "pillar": m.get("pillar") or d.get("pillar") or "Method"})
        topic = d.get("topic")
        try: topic = int(topic) if topic is not None else None
        except (TypeError, ValueError): topic = None
        return {"score": score, "verdict": "OD" if score >= AI_THRESHOLD else "no", "pillar": d.get("pillar") or "none",
                "posts_possible": int(d.get("posts_possible", 0) or 0), "topic": topic, "moments": moments}
    except (ValueError, AttributeError, TypeError):
        return None


def verbatim(quote, transcript, min_ratio=0.85):
    """A quote counts if it appears in the transcript in order, allowing the small drift a model makes quoting speech:
    the best-matching window of the transcript must agree at 85% or better (difflib on normalised words)."""
    import difflib
    norm = lambda s: re.sub(r"[^a-z0-9' ]", "", re.sub(r"\s+", " ", s.lower())).strip()
    q, t = norm(quote), norm(transcript)
    if not q or not t: return False
    if q in t: return True
    qw, tw = q.split(), t.split(); n = len(qw)
    if n > len(tw): return False
    best = 0.0; first = qw[0]
    for i, w in enumerate(tw):
        if w != first and (i + n > len(tw) or difflib.SequenceMatcher(None, w, first).ratio() < 0.8): continue
        for span in (n, n + 1, n + 2, n - 1):
            if span < 3 or i + span > len(tw): continue
            r = difflib.SequenceMatcher(None, qw, tw[i:i + span]).ratio()
            if r > best: best = r
            if best >= min_ratio: return True
    return best >= min_ratio


def week_monday(today=None):
    """The Monday of the week to fill: this week's if today is Monday, else next Monday."""
    today = today or dt.datetime.now(LONDON).date()
    if today.weekday() == 0: return today
    return today + dt.timedelta(days=(7 - today.weekday()) % 7 or 7)


def slot_dates(monday):
    return [(monday + dt.timedelta(days=i), day, P.SHAPES[day]) for i, day in enumerate(P.SHAPES)]


def pick_moment(bank, pillar, used, today=None, week_episodes=()):
    """Best unused moment for a pillar from an episode NOT already used this week, highest score first, then newest."""
    today = today or dt.date.today()
    cands = []
    for rid, e in bank.items():
        if e.get("verdict") != "OD": continue
        if (today - dt.date.fromisoformat(e["mined"][:10])).days > BANK_DAYS: continue
        for i, m in enumerate(e.get("moments", [])):
            key = "%s#%d" % (rid, i)
            if key in used or (pillar and m.get("pillar") != pillar): continue
            if e.get("episode") in week_episodes: continue          # one episode feeds at most one post a week (Kevin: never force the vlog)
            cands.append((0, -e.get("score", 0), -e.get("episode", 0), key, rid, m))
    if not cands: return None
    cands.sort(key=lambda c: (c[0], c[1], c[2]))
    _, _, _, key, rid, m = cands[0]
    return {"key": key, "record": rid, "episode": bank[rid].get("episode"), "quote": m["quote"], "angle": m.get("angle", ""), "pillar": m.get("pillar")}


def hot_button_source(monday):
    i = (monday.isocalendar()[1]) % len(P.HOT_BUTTONS)
    a, b = P.HOT_BUTTONS[i]
    s = "Playbook section 3, hot-button %d, a customer's words on a real sales call: %s. \"%s\"" % (i + 1, a, b)
    return s, s


def framework_rows(text):
    """Rows of the Frameworks Library index that touch agents, AI, systems or delegation."""
    out = []
    for line in text.splitlines():
        if not line.startswith("| ") or line.startswith("| Framework") or line.startswith("|---"): continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4: continue
        name, author, domain, what = cells[0], cells[1], cells[2], cells[3]
        if RESEARCH_KEYS.search(domain + " " + what + " " + name): out.append({"name": name, "author": author, "domain": domain, "what": what})
    return out


def framework_source(state, text=None):
    """Tuesday's fallback: one framework from the brain's library, credited to its author, rotated."""
    if text is None:
        try: text = open(FRAMEWORKS).read()
        except OSError: return None, None
    rows = framework_rows(text)
    if not rows: return None, None
    used = state.setdefault("used_frameworks", [])
    rows.sort(key=lambda r: (r["name"] in used, r["name"]))
    r = rows[0]; state["used_frameworks"] = (used + [r["name"]])[-40:]
    src = "Frameworks Library (Kevin's brain): \"%s\" by %s (%s): %s. Apply it to handing ONE daily job to an AI agent; credit the author by name." % (r["name"], r["author"], r["domain"], r["what"])
    return src, "Frameworks Library: \"%s\" by %s, applied to handing work to an agent" % (r["name"], r["author"])


def pain_source(state, rows):
    """Monday's research fallback: a real founder's public pain signal from the Prospects table (job adverts and posts the
    prospecting agent harvested). Anonymised on purpose: no names, no companies, no towns in the post."""
    used = state.setdefault("used_pain", [])
    rows = [r for r in rows if (r.get("fields", {}).get("Pain Signal") or "").strip() and r["id"] not in used]
    if not rows: return None, None
    r = rows[0]; state["used_pain"] = (used + [r["id"]])[-60:]
    f = r["fields"]; sig = re.sub(r"\s+", " ", f["Pain Signal"].strip())[:600]
    src = ("A real founder-led UK business, found by the prospecting agent (%s): %s. NEVER name the person, the company or the town; describe the situation only."
           % (f.get("Signal Source", "public post"), sig))
    return src, "Prospects table: a real %s harvested by the prospecting agent, anonymised" % (f.get("Signal Source") or "public post")


def build_log_source(state, rows, prs):
    """Wednesday: what Kevin's agents actually did. One register row at Live or Built in its own words, plus the merged pull
    requests of the last 14 days that mention it or any agent. Numbers only if they are in these words."""
    rows = [r for r in rows if (r.get("fields", {}).get("What It Does") or "").strip()]
    if not rows: return None, None
    recent = state.setdefault("proof_rows", [])[-8:]
    rows.sort(key=lambda r: (r["id"] in recent, r["fields"].get("Status") != "Live", r["fields"].get("Name", "")))
    r = rows[0]; f = r["fields"]; state["proof_rows"] = (recent + [r["id"]])[-8:]
    name = f.get("Name", "")
    rel = [p for p in prs if re.search(re.escape(name.split()[0]), p.get("title", ""), re.I)] or [p for p in prs if re.search(r"agent|lane|engine|approval|triage|creditor|property|task manager", p.get("title", ""), re.I)]
    pr_lines = "\n".join("- merged %s: %s" % (p.get("mergedAt", "")[:10], p.get("title", "")[:140]) for p in rel[:6])
    src = ("BUILD LOG. AI Agents register row %s: agent \"%s\", Status %s, %s department, running on Kevin's own businesses. What it does, in the register's words: %s. Score metric: %s.\n"
           "Work merged into its code in the last 14 days (dated, public repository):\n%s"
           % (r["id"], name, f.get("Status"), f.get("Department", "?"), f["What It Does"].strip(), f.get("Score Metric", "not stated"), pr_lines or "- none this fortnight"))
    return src, "Build log: agent \"%s\" (register, Status %s) and %d merged pull request%s of the last 14 days" % (name, f.get("Status"), len(rel[:6]), "" if len(rel[:6]) == 1 else "s")


def strip_tics(text):
    return TICS.sub(lambda m: m.group(2).upper(), text)


def rules_check(text, source, day, is_friday=False):
    """(fixed_text, issues). Em dashes and stock phrases fixed in place; everything else reported, never rewritten."""
    t = text.replace(" — ", ". ").replace("—", ", ").replace(" – ", ", ").strip()
    issues = ["em dash replaced"] if t != text.strip() else []
    t2 = strip_tics(t)
    if t2 != t: issues.append("stock phrase removed"); t = t2
    low = t.lower()
    if STRIP_WORDS.search(t): issues.append("Runpreneur word: '%s'" % STRIP_WORDS.search(t).group(0))
    for b in BANNED:
        if b in low: issues.append("banned word '%s'" % b)
    m = US_SPELLINGS.search(t)
    if m: issues.append("US spelling '%s'" % m.group(0))
    if "#" in t: issues.append("hashtag")
    if re.search(r"[\U0001F300-\U0001FAFF☀-➿]", t): issues.append("emoji")
    first = low.split("\n")[0]
    if any(first.startswith(o) for o in STOCK_OPENERS): issues.append("stock opener")
    if first.rstrip().endswith("?"): issues.append("hook is a question")
    if len(first) > 140: issues.append("hook over 140 characters")
    wc = len(t.split())
    if wc < 80 or wc > 240: issues.append("%d words (90-220)" % wc)
    has_link = "http" in low or "www." in low
    has_ask = bool(re.search(r"\b(comment|dm me|message me|book a|link in|sign up|download|reply with)\b", low))
    if not is_friday and (has_link or has_ask): issues.append("ask or link on a %s (Friday only)" % day)
    for fig in re.findall(r"£[\d,]+(?:\.\d+)?[MmKk]?", t):
        if not any(fig.startswith(ok) for ok in PRICE_OK) and fig not in source: issues.append("figure %s not in the source" % fig)
    for num in re.findall(r"(?<![£\w])\d[\d,]*(?:\.\d+)?%?", t):
        if num == "90%" or (num.rstrip("%") in ("1", "2", "3", "4", "5", "6", "7", "10") and "%" not in num): continue
        if num not in source and num.rstrip("%") not in source: issues.append("number %s not in the source" % num)
    if "runpreneur" in low: issues.append("brand word Runpreneur")
    return t, sorted(set(issues))


def parse_usefulness(result):
    try:
        s = result.strip().strip("`"); s = s[s.find("{"): s.rfind("}") + 1]; d = json.loads(s)
        return {"score": int(d.get("score", 0)), "reasons": [str(x).replace(" — ", ", ").replace("—", ", ").replace(" – ", ", ") for x in (d.get("reasons") or [])][:4],
                "flags": {k: bool(d.get(k)) for k in ("usable_today", "about_an_agent_doing_a_job", "has_method_or_number", "hook_names_a_cost_or_contrast")}}
    except (ValueError, AttributeError, TypeError):
        return None


def parse_newsletter(text):
    m_t = re.search(r"TITLE:\s*(.+)", text); m_s = re.search(r"SHARE:\s*(.+)", text); m_b = re.search(r"BODY:\s*\n(.*)", text, re.S)
    if not (m_t and m_b): return None
    return {"title": m_t.group(1).strip()[:120], "share": (m_s.group(1).strip() if m_s else "")[:220], "body": m_b.group(1).strip()}


def parse_topics(result):
    try:
        s = result.strip().strip("`"); s = s[s.find("{"): s.rfind("}") + 1]; d = json.loads(s)
        out = []
        for t in d.get("topics", []):
            if not (t.get("title") or "").strip(): continue
            out.append({"title": t["title"].strip()[:80], "angle": (t.get("angle") or "").strip()[:200], "points": [str(x)[:120] for x in (t.get("points") or [])][:3],
                        "number": (t.get("number") or "none needed").strip()[:120], "feeds": (t.get("feeds") or "").strip()[:12]})
        return out
    except (ValueError, AttributeError, TypeError):
        return []


def merge_topics(existing, fresh, today=None):
    """Keep unrecorded topics younger than TOPIC_DAYS, then fill to TOPIC_COUNT from the fresh list, numbered 1..N."""
    today = today or dt.date.today()
    keep = [t for t in existing if not t.get("recorded") and (today - dt.date.fromisoformat(t["added"][:10])).days <= TOPIC_DAYS]
    titles = {t["title"].lower() for t in keep}
    for t in fresh:
        if len(keep) >= TOPIC_COUNT: break
        if t["title"].lower() in titles: continue
        keep.append({**t, "added": today.isoformat()}); titles.add(t["title"].lower())
    for i, t in enumerate(keep, 1): t["n"] = i
    return keep


def topics_text(topics):
    if not topics: return "(no topics yet)"
    return "\n".join("%d. %s: %s. Points: %s. Number to state: %s. Feeds: %s." % (t["n"], t["title"], t.get("angle", ""), "; ".join(t.get("points", [])), t.get("number", ""), t.get("feeds", "")) for t in topics)


def record_name(date, day, hook):
    return "OD Post %s %s %s - %s" % (date.isoformat(), day, P.SHAPES[day]["name"], hook[:60].rstrip(" .,"))


def task_name(date, day, hook):
    return "CONTENT (OD): %s, %s: %s" % (date.strftime("%a %-d %b"), P.SHAPES[day]["name"], hook[:70].rstrip(" .,"))


def build_card(post, mode, topics=None):
    """The write-up: the ask, the post, the picture, where it came from, the usefulness score, the checks, the closing line."""
    date = dt.date.fromisoformat(post["date"])
    where = "the Operations Director LinkedIn page" + (" and the Operations Director Facebook page" if post.get("facebook") else "")
    ask = "Post this on %s on %s at 08:00." % (where, date.strftime("%A %-d %B"))
    if post.get("thin"):
        ask = ("THIN SLOT: %s (%s) has no sourced material. Give me one line of context (a real number, a process you handed to an agent, a decision this week) "
               "as 'Changes requested' and I will write the post from it. Nothing is written from nothing." % (date.strftime("%A %-d %B"), P.SHAPES[post["day"]]["name"]))
    parts = [ask]
    if post.get("text"): parts.append("The post, as written:\n\n" + post["text"])
    if post.get("card_url"): parts.append("The picture (attached to the post): " + post["card_url"])
    if post.get("pdf_url"): parts.append("Carousel version (PDF, for a LinkedIn document post once that route is proven): " + post["pdf_url"])
    if post.get("visual") and not post.get("card_url"): parts.append("The picture: " + json.dumps(post["visual"])[:400])
    parts.append("Where it came from:\n" + (post.get("source_line") or ""))
    u = post.get("usefulness")
    if u: parts.append("Usefulness check: %d out of 10%s" % (u.get("score", 0), (". " + " ".join(u.get("reasons", [])[:2])) if u.get("reasons") else "."))
    issues = post.get("issues") or []
    fixes = [i for i in issues if i in ("em dash replaced", "stock phrase removed")]; flags = [i for i in issues if i not in fixes]
    line = "Rules check: " + ("FLAGGED for you: " + "; ".join(flags) if flags else "nothing flagged (UK English, no em dashes, no hashtags, no running words, every figure in the source, no ask before Friday)")
    if fixes: line += ". Fixed automatically: " + "; ".join(fixes) + "."
    parts.append(line)
    if not post.get("voice_loaded"): parts.append("Note: Kevin's voice profile was not readable when this was written (Drive offline), so the post was written from the rules alone.")
    if topics and post.get("day") == "Fri":
        parts.append("Your recording brief for next week's runs (say them in your own words; the transcript becomes the source):\n" + "\n".join(
            "%d. %s. %s Number to state: %s." % (t["n"], t["title"], t.get("angle", ""), t.get("number", "")) for t in topics))
    if mode == "live":
        parts.append("%s scheduling this post with its picture to %s through GoHighLevel for %s 08:00. Nothing else." % (CLOSING, where, date.strftime("%A")))
    else:
        parts.append("%s TEST MODE: creating this post with its picture as a DRAFT in the GoHighLevel planner for %s, for you to open and check. Nothing reaches a public feed until you switch the engine to live." % (CLOSING, where))
    desc = "Approve one Operations Director LinkedIn post (%s) for %s. Source: %s. Nothing is published until you approve." % (
        P.SHAPES[post["day"]]["name"], date.strftime("%A %-d %B"), (post.get("source_line") or "")[:120])
    return task_name(date, post["day"], post.get("hook") or P.SHAPES[post["day"]]["name"]), desc, "\n\n".join(parts)


def build_newsletter_card(ed, mode, topics=None):
    date = dt.date.fromisoformat(ed["date"])
    ask = "Publish edition %d of \"%s\" on your LinkedIn profile on %s at 08:00: \"%s\"." % (ed.get("n", 1), P.NEWSLETTER_NAME, date.strftime("%A %-d %B"), ed["title"])
    parts = [ask, "The edition, as written:\n\n" + ed["body"], "The share line for the post that announces it:\n" + (ed.get("share") or ""), "Where it came from:\n" + ed.get("source_line", "this week's five posts and their sources")]
    issues = ed.get("issues") or []
    parts.append(("Rules check FLAGGED for you: " + "; ".join(issues)) if issues else "Rules check: nothing flagged.")
    if topics: parts.append("Your recording brief for next week's runs:\n" + "\n".join("%d. %s. %s Number to state: %s." % (t["n"], t["title"], t.get("angle", ""), t.get("number", "")) for t in topics))
    if mode == "live":
        parts.append("%s the browser robot signing in as you (the linkedin profile you logged into once), pasting the title and body into LinkedIn's newsletter editor and pressing Publish on %s morning. LinkedIn has no API for this. If the robot cannot finish, you paste it yourself, about five minutes; the text sits on the record." % (CLOSING, date.strftime("%A")))
    else:
        parts.append("%s TEST MODE: the browser robot fills LinkedIn's newsletter editor as a DRAFT and screenshots it for you; nothing is published until you switch the engine to live." % CLOSING)
    name = "CONTENT (OD): %s, Newsletter: %s" % (date.strftime("%a %-d %b"), ed["title"][:70])
    desc = "Approve edition %d of the LinkedIn newsletter \"%s\" for %s. Nothing is published until you approve." % (ed.get("n", 1), P.NEWSLETTER_NAME, date.strftime("%A %-d %B"))
    return name, desc, "\n\n".join(parts)


def minutes_for(outcome):
    if outcome == "Approved as-is": return MINUTES["approved"]
    if outcome == "Approved with minor edits": return MINUTES["minor"]
    if outcome == "Rejected": return MINUTES["rejected"]
    return MINUTES["changes"]


def newsletter_plan(ed, test):
    """The agent-browser plan for LinkedIn's newsletter editor. Selectors are LinkedIn's article editor as of Sep 2026 and
    are confirmed on the first real edition (the Spotify lane did the same). Test mode ends at a screenshot, no publish."""
    steps = [{"do": "goto", "url": "https://www.linkedin.com/article/new/"}, {"do": "wait", "ms": 8000},
             {"do": "fill", "selector": "[data-placeholder='Title'], .article-editor__title, h1[contenteditable='true']", "value": ed["title"]},
             {"do": "fill", "selector": ".article-editor__content [contenteditable='true'], [data-placeholder*='Write here'], div[contenteditable='true'][role='textbox']", "value": ed["body"]},
             {"do": "wait", "ms": 3000}]
    return {"profile": "linkedin", "label": "LinkedIn newsletter: %s" % ed["title"][:60], "steps": steps,
            "submit": {"do": "click", "text": "Publish"}, "confirm": {"selector": "text=/Published|Your article is live|newsletters/", "proof": "the edition appears under the newsletter"},
            "mode": "test" if test else "live", "notes": "Pick the newsletter \"%s\" in the publish dialog; the share text: %s" % (P.NEWSLETTER_NAME, ed.get("share", ""))}


# ---------- state ----------

def _load(path):
    if os.path.exists(path):
        with open(path) as fh: return json.load(fh)
    return {}


def _save(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh: json.dump(data, fh, indent=1, sort_keys=True)
    os.replace(tmp, path)


def od_lessons():
    try: text = open(watch.AGENT_FILE).read()
    except OSError: return ""
    m = re.search(r"^## Lessons from Kevin \(Operations Director\)\s*\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    body = (m.group(1) if m else "").strip()
    return ("\n\nLessons Kevin has given the Operations Director lane (apply every one):\n" + body) if body else ""


def add_lesson(words):
    text = open(watch.AGENT_FILE).read(); head = "## Lessons from Kevin (Operations Director)"
    line = "- (%s) %s" % (dt.date.today().isoformat(), words.strip())
    if head in text: text = re.sub(r"(%s\s*\n)" % re.escape(head), lambda m: m.group(1) + line + "\n", text, count=1)
    else: text = text.rstrip("\n") + "\n\n" + head + "\n" + line + "\n"
    with open(watch.AGENT_FILE, "w") as fh: fh.write(text)


def _claude(system, user, brand_lessons=True):
    return pc.ask_claude(system + (od_lessons() if brand_lessons else ""), user)[0]


# ---------- mine (R3b) ----------

def unmined(limit):
    bank = _load(BANK)
    f = 'AND({Content Type}="Long Form Video", {Category}="Runpreneur", LEN({Transcription})>1500)'
    url = watch.API + "?" + urllib.parse.urlencode({"filterByFormula": f, "pageSize": 100, "sort[0][field]": "Date Published (YT)", "sort[0][direction]": "desc"})
    for fld in ("Content Name", "Transcription", "Category", "Date Published (YT)"): url += "&fields[]=" + urllib.parse.quote(fld)
    out = []; offset = None
    while True:
        r = watch._airtable("GET", url + ("&offset=" + offset if offset else ""))
        for rec in r.get("records", []):
            if rec["id"] not in bank: out.append(rec)
            if len(out) >= limit: return out
        offset = r.get("offset")
        if not offset: return out


def mine_one(rec, topics=None, ask=None):
    ff = rec["fields"]; t = (ff.get("Transcription") or "")
    density = gate_density(t)
    m = re.search(r"Episode (\d+)", ff.get("Content Name", "")); episode = int(m.group(1)) if m else None
    entry = {"name": ff.get("Content Name", "")[:80], "episode": episode, "density": round(density, 1), "mined": dt.datetime.now().isoformat(timespec="seconds")}
    if density < GATE_WORDS:
        entry.update({"verdict": "no", "score": 0, "how": "word gate", "moments": []}); return entry
    system = P.MINE_SYSTEM.replace("{topics}", topics_text(topics or []))
    text, usage, cost = (ask or pc.ask_claude)(system, "TRANSCRIPT:\n" + t[:12000])
    parsed = parse_mine(text)
    if parsed is None:
        entry.update({"verdict": "unread", "score": None, "how": "AI did not answer in shape", "moments": [], "raw": text[:200]}); return entry
    kept = [x for x in parsed["moments"] if verbatim(x["quote"], t)]
    parsed["moments_dropped"] = len(parsed["moments"]) - len(kept); parsed["moments"] = kept
    entry.update(parsed); entry["how"] = "AI"; entry["cost_usd"] = cost
    return entry


def mine(limit=6, dry_run=False):
    bank = _load(BANK); state = _load(STATE); topics = state.get("topics", [])
    recs = unmined(limit)
    if not recs: print("od mine: nothing new to mine"); return
    for rec in recs:
        e = mine_one(rec, topics)
        print("od mine: %s -> %s (density %.1f%s%s%s)" % (e["name"], e["verdict"], e["density"], (", score %s" % e["score"]) if e.get("score") is not None else "",
                                                         (", %d moments" % len(e["moments"])) if e.get("moments") else "", (", topic %s recorded" % e["topic"]) if e.get("topic") else ""))
        if e.get("topic"):
            for tp in topics:
                if tp.get("n") == e["topic"] and not tp.get("recorded"): tp["recorded"] = rec["id"]; tp["recorded_on"] = dt.date.today().isoformat()
        if e["verdict"] == "OD" and not dry_run:
            note = "OD lane %s: %d moment%s banked for Operations Director posts." % (dt.date.today().isoformat(), len(e["moments"]), "" if len(e["moments"]) == 1 else "s")
            watch._airtable("PATCH", watch.API + "/" + rec["id"], {"fields": {"Notes": approval.append_note(rec, note)}})
        if e["verdict"] != "unread": bank[rec["id"]] = e
    if not dry_run: _save(BANK, bank); _save(STATE, state)


def backtest(limit=30):
    bank_now = _load(BANK); f = 'AND({Content Type}="Long Form Video", {Category}="Runpreneur", LEN({Transcription})>1500)'
    url = watch.API + "?" + urllib.parse.urlencode({"filterByFormula": f, "pageSize": limit, "sort[0][field]": "Date Published (YT)", "sort[0][direction]": "desc"})
    for fld in ("Content Name", "Transcription", "Category"): url += "&fields[]=" + urllib.parse.quote(fld)
    recs = watch._airtable("GET", url).get("records", [])
    print("%-52s %7s %5s %-3s %-10s %s" % ("episode", "words/1k", "score", "vd", "pillar", "moments"))
    for rec in recs:
        e = bank_now.get(rec["id"]) or mine_one(rec)
        print("%-52s %7.1f %5s %-3s %-10s %d" % (e["name"][:52], e["density"], e.get("score"), (e["verdict"] or "")[:3], e.get("pillar", ""), len(e.get("moments", []))))


# ---------- sources ----------

def register_rows():
    return watch._airtable("GET", REGISTER_API + "?" + urllib.parse.urlencode({"filterByFormula": 'OR({Status}="Live",{Status}="Built")', "pageSize": 50})
                           + "&fields[]=Name&fields[]=Status&fields[]=What+It+Does&fields[]=Department&fields[]=Score+Metric").get("records", [])


def merged_prs(days=14):
    try:
        r = subprocess.run(["gh", "pr", "list", "--state", "merged", "--limit", "40", "--json", "number,title,mergedAt"], capture_output=True, text=True, cwd=REPO, timeout=60)
        prs = json.loads(r.stdout) if r.returncode == 0 else []
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return []
    cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).isoformat()
    return [p for p in prs if (p.get("mergedAt") or "") >= cutoff]


def pain_rows():
    f = '{Pain Signal}!=""'
    return watch._airtable("GET", PROSPECTS_API + "?" + urllib.parse.urlencode({"filterByFormula": f, "pageSize": 30}) + "&fields[]=Pain+Signal&fields[]=Signal+Source").get("records", [])


def source_for(day, mom, monday, state):
    """(source text for the model, source line for the card) for a slot; (None, None) means THIN."""
    if mom:
        return ("Episode %d of Kevin's run diary, verbatim: \"%s\" (angle: %s)" % (mom["episode"], mom["quote"], mom["angle"]),
                "Episode %d, Kevin's own words on camera: \"%s\"" % (mom["episode"], mom["quote"]))
    if day == "Mon":
        s = pain_source(state, pain_rows())
        return s if s[0] else hot_button_source(monday)
    if day in ("Tue", "Fri"):
        return framework_source(state)
    if day == "Wed":
        return build_log_source(state, register_rows(), merged_prs())
    if day == "Thu":
        s = build_log_source(state, register_rows(), [])
        return (s[0] + "\nDescribe the WORKFLOW this agent runs as boxes: trigger, what the agent does, where the owner approves, what goes out.", s[1]) if s[0] else (None, None)
    return None, None


# ---------- write (O2-O4) ----------

def write_post(day, date, source, voice, feedback=""):
    shape = P.SHAPES[day]
    system = P.OD_SYSTEM + ("\n\n" + voice if voice else "")
    user = P.SHAPE_PROMPT.format(day=day, shape_name=shape["name"], asks=shape["asks"], date=date.strftime("%A %-d %B %Y"), source=source, visual_fields=shape["visual_fields"])
    if feedback: user += "\n\nKEVIN'S OWN WORDS FOR THIS POST (use them): " + feedback
    draft = _claude(system, user)
    polished = _claude(system, P.POLISH_PROMPT.format(draft=draft))
    text, visual = P.split_visual(polished)
    if visual is None: text, visual = P.split_visual(draft)
    u = parse_usefulness(_claude(P.USEFULNESS_SYSTEM, "POST:\n" + text + "\n\nSOURCE:\n" + source, brand_lessons=False)) or {"score": 0, "reasons": ["judge did not answer"], "flags": {}}
    redrafted = False
    if u["score"] < USEFUL_MIN:
        user2 = user + "\n\nA previous draft scored %d out of 10 on usefulness. What was missing: %s. Fix exactly that." % (u["score"], "; ".join(u.get("reasons", [])) or "not usable today")
        draft2 = _claude(system, user2); polished2 = _claude(system, P.POLISH_PROMPT.format(draft=draft2))
        t2, v2 = P.split_visual(polished2)
        u2 = parse_usefulness(_claude(P.USEFULNESS_SYSTEM, "POST:\n" + t2 + "\n\nSOURCE:\n" + source, brand_lessons=False)) or {"score": 0, "reasons": [], "flags": {}}
        if u2["score"] >= u["score"]: text, visual, u = t2, (v2 or visual), u2
        redrafted = True
    if day == "Fri":
        text = text.rstrip() + "\n\nIf your business only runs when you are in it, book a free Operations Review Call: " + CTA_LINK
    text, issues = rules_check(text, source, day, is_friday=(day == "Fri"))
    hook = text.split("\n")[0].strip()
    try:
        if visual: od_infographic.build_html(shape["visual"], visual)
    except ValueError as ex:
        issues.append("picture spec unusable (%s)" % str(ex)[:60]); visual = None
    if u["score"] < USEFUL_MIN: issues.append("usefulness %d, under the bar of %d after a redraft" % (u["score"], USEFUL_MIN))
    return {"text": text, "visual": visual, "issues": sorted(set(issues)), "hook": hook[:120], "usefulness": u, "redrafted": redrafted, "thin": False}


def render_visual(p):
    if not p.get("visual"): return
    os.makedirs(CARDS_DIR, exist_ok=True)
    png = os.path.join(CARDS_DIR, "od-%s.png" % p["date"]); pdf = os.path.join(CARDS_DIR, "od-%s.pdf" % p["date"]) if p["day"] == "Tue" else None
    try:
        od_infographic.render(P.SHAPES[p["day"]]["visual"], p["visual"], png, pdf)
        p["card_png"] = png
        if pdf and os.path.exists(pdf): p["card_pdf"] = pdf
    except SystemExit as ex:
        p.setdefault("issues", []).append("picture not rendered"); print("od draft: picture for %s not rendered (%s)" % (p["date"], str(ex)[:120]))


def draft(week=None, dry_run=False):
    if on_hold(): print("od draft: ON HOLD (%s exists), nothing drafted" % HOLD_FILE); return
    state = _load(STATE); bank = _load(BANK)
    monday = dt.date.fromisoformat(week) if week else week_monday()
    posts = state.setdefault("posts", {})
    # a slot whose earlier post Kevin rejected (or that was dropped) and that never reached GHL is free again: the old entry is archived
    for pid in [d for d in list(posts) if monday.isoformat() <= d <= (monday + dt.timedelta(days=4)).isoformat()]:
        if posts[pid].get("verdict") in ("rejected", "dropped") and not posts[pid].get("ghl"):
            state.setdefault("archive", []).append(posts.pop(pid)); print("od draft: %s slot freed (earlier post %s)" % (pid, state["archive"][-1].get("verdict")))
    used = {p["moment"] for p in posts.values() if p.get("moment")}
    week_eps = {p["episode"] for d, p in posts.items() if p.get("episode") and monday.isoformat() <= d <= (monday + dt.timedelta(days=4)).isoformat()}
    voice = P.voice_profile(); voice_loaded = bool(voice); made = 0
    for date, day, shape in slot_dates(monday):
        pid = date.isoformat()
        if pid in posts: continue
        mom = pick_moment(bank, shape["pillar"], used, week_episodes=week_eps) if shape["pillar"] else pick_moment(bank, None, used, week_episodes=week_eps)
        if day == "Wed" and mom and mom["pillar"] != "Proof": mom = None
        source, source_line = source_for(day, mom, monday, state)
        post = {"date": pid, "day": day, "shape": shape["name"], "brand": BRAND, "moment": mom["key"] if mom else None, "episode": mom["episode"] if mom else None,
                "quote": mom["quote"] if mom else None, "created": dt.datetime.now().isoformat(timespec="seconds"), "voice_loaded": voice_loaded, "source_line": source_line}
        if mom: used.add(mom["key"]); week_eps.add(mom["episode"])
        if not source:
            post.update({"thin": True, "source_line": "Nothing sourced for this slot: no %s material in the bank inside %d days and no fallback source answered." % (shape["pillar"] or "Offer", BANK_DAYS)})
            print("od draft: %s %s -> THIN (no sourced material)" % (pid, day))
        elif dry_run:
            print("od draft: %s %s <- %s" % (pid, day, source_line[:110])); continue
        else:
            w = write_post(day, date, source, voice); post.update(w)
            render_visual(post)
            print("od draft: %s %s written, %d words, usefulness %s%s%s" % (pid, day, len(w["text"].split()), w["usefulness"]["score"], " (redrafted)" if w["redrafted"] else "",
                                                                          ("; flagged: " + "; ".join(w["issues"])) if w["issues"] else ""))
        posts[pid] = post; made += 1
        _save(STATE, state)
    if dry_run: return
    for pid, p in posts.items():
        if monday.isoformat() <= pid <= (monday + dt.timedelta(days=4)).isoformat() and not p.get("record") and p.get("text"): p["record"] = create_record(p)
    _save(STATE, state)
    draft_newsletter(state, monday, voice)
    _save(STATE, state)
    print("od draft: week of %s, %d slot%s drafted" % (monday, made, "" if made == 1 else "s"))


def create_record(p):
    date = dt.date.fromisoformat(p["date"])
    fields = {"Content Name": record_name(date, p["day"], p.get("hook") or p["shape"]), "Category": BRAND, "Content Type": "Written",
              "Record Status": STATUS_DRAFTED, "Responsible": "Content Engine (AI)", "LinkedIn Copy": p["text"], "Target Publish Date": p["date"],
              "Platforms": ["LinkedIn Post"], "AI Generated": True, "AI Feature": "Copywriting", "Model": pc.MODEL,
              "Notes": "OD lane v2 %s: %s. Source: %s%s" % (dt.date.today().isoformat(), p["shape"], p["source_line"], ("; REVIEW: " + "; ".join(p["issues"])) if p.get("issues") else "")}
    return watch._airtable("POST", watch.API, {"fields": fields, "typecast": True})["id"]


def draft_newsletter(state, monday, voice):
    eds = state.setdefault("newsletters", {}); key = monday.isoformat()
    if key in eds: return
    week = [p for d, p in sorted(state.get("posts", {}).items()) if monday.isoformat() <= d <= (monday + dt.timedelta(days=4)).isoformat() and p.get("text")]
    if len(week) < 3: print("od newsletter: fewer than three posts this week, no edition"); return
    material = "\n\n".join("%s (%s), source: %s\n%s" % (p["day"], p["shape"], p.get("source_line", ""), p["text"]) for p in week)
    theme = week[1]["hook"] if len(week) > 1 else week[0]["hook"]
    out = _claude(P.NEWSLETTER_SYSTEM + ("\n\n" + voice if voice else ""), P.NEWSLETTER_PROMPT.format(monday=monday, theme=theme, material=material, cta=CTA_LINK))
    ed = parse_newsletter(out)
    if not ed: print("od newsletter: the model did not return TITLE/SHARE/BODY"); return
    body, issues = rules_check(ed["body"], material + " " + CTA_LINK, "Fri", is_friday=True)
    issues = [i for i in issues if not i.startswith(("hook", "ask or link")) and "words" not in i]
    wc = len(body.split())
    if wc < 500 or wc > 1200: issues.append("%d words (600-1,000)" % wc)
    ed.update({"body": body, "issues": issues, "date": (monday + dt.timedelta(days=4)).isoformat(), "n": len(eds) + 1, "created": dt.datetime.now().isoformat(timespec="seconds"),
               "source_line": "This week's %d posts and their sources: %s" % (len(week), "; ".join(p.get("source_line", "")[:80] for p in week))})
    fields = {"Content Name": "OD Newsletter %s - %s" % (ed["date"], ed["title"][:60]), "Category": BRAND, "Content Type": "Written", "Record Status": STATUS_DRAFTED,
              "Responsible": "Content Engine (AI)", "Blog Copy": body, "LinkedIn Copy": ed.get("share", ""), "Target Publish Date": ed["date"], "Platforms": ["LinkedIn Post", "Blog"],
              "AI Generated": True, "AI Feature": "Copywriting", "Model": pc.MODEL, "Notes": "OD lane v2 newsletter edition %d (%s). %s" % (ed["n"], P.NEWSLETTER_NAME, ed["source_line"])}
    ed["record"] = watch._airtable("POST", watch.API, {"fields": fields, "typecast": True})["id"]
    eds[key] = ed
    print("od newsletter: edition %d drafted, %d words%s" % (ed["n"], wc, ("; flagged: " + "; ".join(issues)) if issues else ""))


# ---------- topics (the recording brief) ----------

def topics(dry_run=False):
    state = _load(STATE); bank = _load(BANK)
    counts = {}
    for e in bank.values():
        if e.get("verdict") == "OD":
            for m in e.get("moments", []): counts[m.get("pillar")] = counts.get(m.get("pillar"), 0) + 1
    thin = [p["shape"] for p in state.get("posts", {}).values() if p.get("thin") and p["date"] >= dt.date.today().isoformat()]
    prs = merged_prs(14); rows = []
    try: rows = register_rows()
    except Exception as ex: print("od topics: register unreadable (%s)" % str(ex)[:80])
    user = ("Existing topics still waiting (do not repeat them):\n%s\n\nSlots with nothing sourced: %s. Bank counts by pillar: %s.\n"
            "Agents live or built (name: what it does): %s\nMerged this fortnight: %s\n\nWrite %d NEW topics." % (
                topics_text(state.get("topics", [])), ", ".join(thin) or "none", json.dumps(counts),
                "; ".join("%s: %s" % (r["fields"].get("Name"), (r["fields"].get("What It Does") or "")[:120]) for r in rows[:12]),
                "; ".join(p.get("title", "")[:90] for p in prs[:10]) or "none", TOPIC_COUNT))
    fresh = parse_topics(_claude(P.TOPICS_SYSTEM, user, brand_lessons=False))
    merged = merge_topics(state.get("topics", []), fresh)
    body = "# Recording brief: %d topics for your runs (written %s)\n\nSay them on camera in your own words; the transcript becomes the source. A topic not recorded in %d days drops off.\n\n" % (len(merged), dt.date.today().isoformat(), TOPIC_DAYS)
    body += "\n".join("%d. %s\n   Angle: %s\n   Points: %s\n   Number to state: %s\n   Feeds: %s\n" % (t["n"], t["title"], t.get("angle", ""), "; ".join(t.get("points", [])), t.get("number", ""), t.get("feeds", "")) for t in merged)
    if dry_run: print(body); return
    state["topics"] = merged; _save(STATE, state)
    with open(POINTS, "w") as fh: fh.write(body)
    print(body)


# ---------- cards (O5) ----------

def _raise(name, desc, out, record, note_ref):
    today = dt.date.today().isoformat()
    tid = approval.existing_task(name)
    if not tid:
        fields = {approval.TF["name"]: name, approval.TF["desc"]: desc, approval.TF["status"]: "Today", approval.TF["team"]: [approval.AGENT_TM],
                  approval.TF["priority"]: "Medium", approval.TF["due"]: today, approval.TF["business"]: [BUSINESS_OD],
                  approval.TF["notes"]: "Raised by the Content Engine (Operations Director lane v2) %s for record %s. Created with --force: the date and shape are the identity and the duplicate key strips them." % (today, record)}
        r = subprocess.run([sys.executable, approval.GATE, "create", "--force", "--fields-json", json.dumps(fields)], capture_output=True, text=True)
        if r.returncode != 0: raise SystemExit("od cards: task gate failed: " + (r.stderr or r.stdout)[-400:])
        tid = json.loads(r.stdout.strip().splitlines()[-1])["taskId"]
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as fh:
        fh.write(out); path = fh.name
    try:
        r = subprocess.run([sys.executable, approval.DISPATCH, "submit", tid, "--agent", approval.AGENT_TM, "--type", approval.TASK_TYPE, "--output-file", path], capture_output=True, text=True)
    finally: os.remove(path)
    if r.returncode != 0: raise SystemExit("od cards: submit failed for %s: %s" % (tid, (r.stderr or r.stdout)[-400:]))
    if record:
        rec = watch._airtable("GET", watch.API + "/" + record)
        watch._airtable("PATCH", watch.API + "/" + record, {"fields": {"Record Status": STATUS_QC, "Notes": approval.append_note(rec, "Approval card %s raised %s." % (tid, today))}})
    return tid


def raise_cards(dry_run=False):
    if on_hold(): print("od cards: ON HOLD (%s exists), no cards raised" % HOLD_FILE); return
    state = _load(STATE); posts = state.get("posts", {}); m = publish.mode(); today = dt.date.today().isoformat(); tp = state.get("topics", [])
    for pid, p in sorted(posts.items()):
        if p.get("task") or p.get("verdict") or pid < today: continue
        if not dry_run:
            for k, attr in (("card_png", "card_url"), ("card_pdf", "pdf_url")):
                if p.get(k) and not p.get(attr):
                    try: p[attr] = publish.upload_media(p[k], brand=BRAND)
                    except SystemExit as ex: print("od cards: upload of %s failed for %s (%s)" % (k, pid, str(ex)[:120]))
        name, desc, out = build_card(p, m, tp)
        if dry_run: print(out); print("-----"); continue
        p["task"] = _raise(name, desc, out, p.get("record"), p.get("record")); p["raised"] = dt.datetime.now().isoformat(timespec="seconds")
        _save(STATE, state); print("od cards: %s -> %s (%s)" % (pid, p["task"], name))
    for key, ed in sorted(state.get("newsletters", {}).items()):
        if ed.get("task") or ed.get("verdict") or ed["date"] < today: continue
        name, desc, out = build_newsletter_card(ed, m, tp)
        if dry_run: print(out); print("-----"); continue
        ed["task"] = _raise(name, desc, out, ed.get("record"), ed.get("record")); ed["raised"] = dt.datetime.now().isoformat(timespec="seconds")
        _save(STATE, state); print("od cards: newsletter %s -> %s" % (ed["date"], ed["task"]))


def _verdict(entry, pid, kind):
    t = watch._airtable("GET", approval.TASKS_API + "/" + entry["task"] + "?returnFieldsByFieldId=true")["fields"]
    outcome = t.get(approval.TF["outcome"])
    if isinstance(outcome, dict): outcome = outcome.get("name")
    if not outcome: return False
    words = (t.get(approval.TF["feedback"]) or "").strip()
    entry["outcome"] = outcome; entry["feedback"] = words; entry["minutes_est"] = minutes_for(outcome)
    if outcome in approval.APPROVED:
        entry["verdict"] = "approved"
        if entry.get("record"): watch._airtable("PATCH", watch.API + "/" + entry["record"], {"fields": {"Record Status": STATUS_APPROVED}})
    elif outcome == "Rejected":
        entry["verdict"] = "rejected"
        if words and len(words) > 12: add_lesson(words); entry["lesson"] = True
        if entry.get("record"): watch._airtable("PATCH", watch.API + "/" + entry["record"], {"fields": {"Feedback": words or "Rejected without a reason"}})
    else:
        if entry.get("redone") or kind == "newsletter":
            entry["verdict"] = "dropped"; print("od sync: %s changes requested %s, dropped" % (pid, "twice" if kind == "post" else "on an edition; Kevin edits the record"))
        else:
            src = (entry.get("source_line") or "") + ("\nKevin's own words for this post: " + words if words else "")
            w = write_post(entry["day"], dt.date.fromisoformat(pid), src, P.voice_profile(), feedback=words)
            entry.update(w); entry["thin"] = False; entry["source_line"] = src; entry["redone"] = True; entry["task"] = None; entry["outcome_first"] = outcome
            entry.pop("card_url", None); entry.pop("pdf_url", None); render_visual(entry)
            if entry.get("record"): watch._airtable("PATCH", watch.API + "/" + entry["record"], {"fields": {"LinkedIn Copy": w["text"], "Feedback": words, "Record Status": STATUS_DRAFTED}})
            else: entry["record"] = create_record(entry)
            print("od sync: %s redone from Kevin's words, new card next run" % pid)
    print("od sync: %s -> %s (%s)" % (pid, entry.get("verdict") or "redo", outcome))
    return True


def sync():
    state = _load(STATE); changed = False
    for pid, p in state.get("posts", {}).items():
        if p.get("task") and not p.get("verdict"): changed |= _verdict(p, pid, "post")
    for key, ed in state.get("newsletters", {}).items():
        if ed.get("task") and not ed.get("verdict"): changed |= _verdict(ed, ed["date"], "newsletter")
    if changed: _save(STATE, state)
    else: print("od sync: no verdicts to read")


# ---------- publish (O6) ----------

def publish_posts(dry_run=False):
    state = _load(STATE); posts = state.get("posts", {}); m = publish.mode(); test = m == "test"
    todo = [(pid, p) for pid, p in sorted(posts.items()) if p.get("verdict") == "approved" and not p.get("ghl") and pid >= dt.date.today().isoformat()]
    if not todo: print("od publish: nothing approved and unscheduled"); return
    od_accts = publish.allowed_accounts(BRAND, "post", publish.accounts(BRAND))
    if not od_accts: raise SystemExit("od publish: no Operations Director account is connected in GoHighLevel")
    _, _, user = publish._cfg(BRAND)
    for pid, p in todo:
        rec = watch._airtable("GET", watch.API + "/" + p["record"]) if p.get("record") else {"fields": {"Category": BRAND}}
        publish.assert_brand(rec["fields"], BRAND)
        day = dt.date.fromisoformat(pid); when = publish.slot_iso(day, OD_SLOT); status = "draft" if test else "scheduled"
        if dry_run:
            for a in od_accts: print("  would %s %s -> %s (%s) at %s" % (status, pid, a["name"], a["platform"], when))
            continue
        p["ghl"] = {}
        for a in od_accts:
            gid = publish.create_post(publish.build_text_post(a, p["text"], when, user, p.get("card_url"), status=status), brand=BRAND)
            p["ghl"]["%s|%s" % (a["platform"], a["id"])] = {"id": gid, "status": status, "account": a["name"], "platform": a["platform"], "mode": m}
            print("od publish [%s]: %s -> %s %s %s" % (m.upper(), pid, a["name"], status, when if not test else ""))
        if p.get("record"):
            watch._airtable("PATCH", watch.API + "/" + p["record"], {"fields": {"Record Status": STATUS_SCHEDULED, "Thumbnail URL": p.get("card_url") or "", "Notes": approval.append_note(rec, "%s: %s through GoHighLevel%s." % (
                dt.date.today().isoformat(), "DRAFT in the planner (test mode)" if test else "scheduled for 08:00", " with picture" if p.get("card_url") else ""))}})
        _save(STATE, state)


def publish_sync():
    state = _load(STATE); changed = False
    for pid, p in state.get("posts", {}).items():
        for key, g in (p.get("ghl") or {}).items():
            if g.get("status") in ("published", "draft", "failed"): continue
            _, loc, _ = publish._cfg(BRAND)
            try: r = publish.ghl("GET", "/social-media-posting/%s/posts/%s" % (loc, g["id"]), brand=BRAND)
            except SystemExit as ex: print("od publish sync: cannot read %s (%s)" % (g["id"], str(ex)[:100])); continue
            post = (r.get("results") or r).get("post") or r
            st = post.get("status"); link = post.get("previewLink") or ""
            if st != g.get("status"): g["status"] = st; changed = True
            if st == "failed": g["error"] = str(post.get("error"))[:200]; print("od publish sync: %s %s FAILED: %s" % (pid, key, g["error"]))
            if st == "published" and link and p.get("record"):
                g["link"] = link; fields = {"Record Status": STATUS_PUBLISHED, "Date Published (Other)": dt.date.today().isoformat()}
                if g["platform"] == "linkedin": fields.update({"LinkedIn Link": link, "Link of Linkedin Post": link})
                if g["platform"] == "facebook": fields.update({"Facebook Page Post Link": link, "Link of Facebook Page Post": link})
                watch._airtable("PATCH", watch.API + "/" + p["record"], {"fields": fields}); changed = True
    if changed: _save(STATE, state)


def newsletter_publish(dry_run=False):
    """Approved editions due today or earlier -> the browser lane. prepare fills the editor (and screenshots); commit presses
    Publish only in live mode and only with the approved task. A failure leaves the text on the record for Kevin to paste."""
    state = _load(STATE); m = publish.mode(); test = m == "test"; today = dt.date.today().isoformat()
    for key, ed in sorted(state.get("newsletters", {}).items()):
        if ed.get("verdict") != "approved" or ed.get("published") or ed["date"] > today: continue
        plan = newsletter_plan(ed, test); os.makedirs(CARDS_DIR, exist_ok=True)
        ppath = os.path.join(CARDS_DIR, "newsletter_plan_%s.json" % ed["date"]); shot = os.path.join(CARDS_DIR, "newsletter_%s.png" % ed["date"])
        with open(ppath, "w") as fh: json.dump(plan, fh, indent=1)
        ed["plan"] = ppath
        if dry_run: print("would run agent-browser %s on %s" % ("prepare" if test else "commit", ppath)); continue
        cmd = ["node", AGENT_BROWSER, "prepare", "--plan", ppath, "--shot", shot] if test else ["node", AGENT_BROWSER, "commit", "--plan", ppath, "--task", ed["task"], "--shot", shot]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        ed["browser"] = {"cmd": cmd[2], "rc": r.returncode, "out": (r.stdout or r.stderr)[-500:], "when": dt.datetime.now().isoformat(timespec="seconds")}
        if r.returncode == 0 and not test:
            ed["published"] = today
            if ed.get("record"): watch._airtable("PATCH", watch.API + "/" + ed["record"], {"fields": {"Record Status": STATUS_PUBLISHED, "Date Published (Other)": today}})
            print("od newsletter: edition %s published through the browser lane" % ed["date"])
        elif r.returncode == 0:
            print("od newsletter [TEST]: edition %s filled in the editor and screenshotted (%s); nothing published" % (ed["date"], shot))
        else:
            print("od newsletter: browser lane failed for %s (%s). Kevin pastes: the text is on record %s" % (ed["date"], (r.stderr or r.stdout)[-160:], ed.get("record")))
            if ed.get("record"):
                rec = watch._airtable("GET", watch.API + "/" + ed["record"])
                watch._airtable("PATCH", watch.API + "/" + ed["record"], {"fields": {"Notes": approval.append_note(rec, "%s: browser lane could not publish; Kevin to paste the Blog Copy into LinkedIn's newsletter editor." % today)}})
        _save(STATE, state)


def report():
    state = _load(STATE); bank = _load(BANK); posts = state.get("posts", {}); eds = state.get("newsletters", {})
    od = sum(1 for e in bank.values() if e.get("verdict") == "OD"); moments = sum(len(e.get("moments", [])) for e in bank.values() if e.get("verdict") == "OD")
    waiting = [d for d, p in posts.items() if p.get("task") and not p.get("verdict")] + [e["date"] for e in eds.values() if e.get("task") and not e.get("verdict")]
    approved = [d for d, p in posts.items() if p.get("verdict") == "approved" and not p.get("ghl")]
    out = [d for d, p in posts.items() if p.get("ghl")]
    mins = [p["minutes_est"] for p in posts.values() if p.get("minutes_est")]
    tp = state.get("topics", [])
    print("OD content lane%s: bank %d episode%s / %d moments; %d topics waiting for Kevin to record; %d card%s waiting; %d approved and unscheduled; %d post%s in GoHighLevel (%s); %d newsletter edition%s%s" % (
        " (ON HOLD)" if on_hold() else "", od, "" if od == 1 else "s", moments, len([t for t in tp if not t.get("recorded")]), len(waiting), "" if len(waiting) == 1 else "s", len(approved),
        len(out), "" if len(out) == 1 else "s", publish.mode().upper(), len(eds), "" if len(eds) == 1 else "s",
        ("; about %.1f human minutes a post, estimated from verdicts" % (sum(mins) / len(mins))) if mins else ""))


def selftest():
    assert gate_density("we built an AI agent to run the process for the business team") > 100 and gate_density("the weather was cold and my feet hurt") == 0
    assert not STRIP_WORDS.search("your business runs on you and it should run without you") and STRIP_WORDS.search("on my run this morning") and STRIP_WORDS.search("day 2,195 of the streak")
    pm = parse_mine('```json\n{"score": 8, "pillar": "Method", "posts_possible": 2, "topic": "3", "moments": [{"quote": "one two three four five six", "angle": "a", "pillar": "Method"}, {"quote": "too short", "angle": "b"}]}\n```')
    assert pm["verdict"] == "OD" and pm["topic"] == 3 and len(pm["moments"]) == 1
    assert parse_mine('{"score": 5, "moments": []}')["verdict"] == "no" and parse_mine('{"score": 6, "moments": []}')["verdict"] == "OD", "threshold is 6 in v2: general agent talk counts, mindset does not"; assert parse_mine("I cannot help") is None
    assert verbatim("turn SOPs into AI agents", "you can now turn SOPs, into AI agents and more") and not verbatim("agents into SOPs", "turn SOPs into AI agents")
    assert verbatim("remove as much of the emotion from the process as possible", "so, um, remove as much of the emotion, from the process as possible because")
    assert not verbatim("we doubled revenue in six months", "we ran ten kilometres in the rain and it was cold and the wind was up")
    assert week_monday(dt.date(2026, 9, 4)) == dt.date(2026, 9, 7) and week_monday(dt.date(2026, 9, 6)) == dt.date(2026, 9, 7) and week_monday(dt.date(2026, 9, 7)) == dt.date(2026, 9, 7)
    sd = slot_dates(dt.date(2026, 9, 7)); assert [s[1] for s in sd] == ["Mon", "Tue", "Wed", "Thu", "Fri"] and sd[4][0] == dt.date(2026, 9, 11) and sd[2][2]["pillar"] == "Proof"
    bank = {"r1": {"verdict": "OD", "score": 9, "episode": 1992, "mined": "2026-09-03T00:00:00", "moments": [{"quote": "q1 " * 4, "angle": "a", "pillar": "Method"}, {"quote": "q2 " * 4, "angle": "b", "pillar": "Pain"}]},
            "r2": {"verdict": "OD", "score": 8, "episode": 1979, "mined": "2026-09-03T00:00:00", "moments": [{"quote": "q3 " * 4, "angle": "c", "pillar": "Method"}]},
            "r3": {"verdict": "no", "score": 2, "episode": 1990, "mined": "2026-09-03T00:00:00", "moments": [{"quote": "x " * 4, "angle": "d", "pillar": "Method"}]},
            "r4": {"verdict": "OD", "score": 10, "episode": 1900, "mined": "2026-06-01T00:00:00", "moments": [{"quote": "old " * 4, "angle": "e", "pillar": "Method"}]}}
    today = dt.date(2026, 9, 5)
    assert pick_moment(bank, "Method", set(), today)["key"] == "r1#0" and pick_moment(bank, "Method", {"r1#0"}, today)["key"] == "r2#0" and pick_moment(bank, "Proof", set(), today) is None
    assert pick_moment(bank, None, {"r1#0", "r1#1", "r2#0"}, today) is None and pick_moment(bank, "Method", set(), today, week_episodes={1992})["key"] == "r2#0"
    assert pick_moment(bank, "Method", set(), today, week_episodes={1992, 1979}) is None, "an episode used this week is never used twice"
    lib = "| Framework | Author / Source | Domain | What it does | Source doc |\n|---|---|---|---|---|\n| AGENT (build method) | Dan Martell | AI / Agents | Five steps to build an agent | doc |\n| Level 10 Meeting | Gino Wickman | Operations / Team | Weekly meeting structure | doc |\n| Pricing Triangle | Skok | Pricing | Value metric | doc |\n"
    rows = framework_rows(lib); assert [r["name"] for r in rows] == ["AGENT (build method)", "Level 10 Meeting"], rows
    st = {}; s1, l1 = framework_source(st, lib); assert "Dan Martell" in s1 and "credit the author" in s1; s2, _ = framework_source(st, lib); assert "Gino Wickman" in s2
    prow = [{"id": "p1", "fields": {"Pain Signal": "Hiring a part-time bookkeeper, 20 hours, Flint. Jane Whitehouse, founder.", "Signal Source": "Job Ad (Indeed)"}}]
    st2 = {}; s, l = pain_source(st2, prow); assert "NEVER name" in s and "Job Ad" in l and st2["used_pain"] == ["p1"] and pain_source(st2, prow) == (None, None)
    rrows = [{"id": "a", "fields": {"Name": "Inbound Comms Triage", "Status": "Live", "What It Does": "Sorts the inbox.", "Department": "Operations", "Score Metric": "x"}}]
    prs = [{"title": "Inbound triage: auto-reply gate", "mergedAt": "2026-09-02T10:00:00Z"}, {"title": "Unrelated CSS fix", "mergedAt": "2026-09-02T10:00:00Z"}]
    st3 = {}; s, l = build_log_source(st3, rrows, prs); assert "BUILD LOG" in s and "auto-reply gate" in s and "CSS" not in s and "1 merged pull request " in l
    assert build_log_source({}, [], prs) == (None, None)
    good = "Most owners answer every email themselves. It costs them the first hour of every day.\n\n" + "Here is how the agent takes it. " * 14 + "\nHand it the checklist. Approve, do not do."
    t, issues = rules_check(good, "", "Mon"); assert issues == [], issues
    t, issues = rules_check("Day 2195 — we realize amazing things on my run #ai, comment below. Raised £2,500 for kids. Is this you? " * 3, "", "Tue")
    for want in ("em dash replaced", "US spelling", "banned word 'amazing'", "Runpreneur word", "hashtag", "stock opener", "ask or link", "figure £2,500"):
        assert any(want in i for i in issues), (want, issues)
    t, issues = rules_check("Why do you do it all?\n" + good, "", "Mon"); assert "hook is a question" in issues
    t, issues = rules_check(good + " We saved 14 hours.", "", "Mon"); assert any("number 14" in i for i in issues)
    t, issues = rules_check(good + " We saved 14 hours.", "saved 14 hours a week", "Mon"); assert issues == [], issues
    t, issues = rules_check(good + " It costs £350 a month. Book a call: https://x", "", "Fri", is_friday=True); assert not any("figure" in i or "ask" in i for i in issues)
    assert strip_tics("Plan it.\n\nThe reality is, a plan in memory is not a plan.") == "Plan it.\n\nA plan in memory is not a plan."
    u = parse_usefulness('{"score": 8, "usable_today": true, "about_an_agent_doing_a_job": true, "has_method_or_number": true, "hook_names_a_cost_or_contrast": false, "reasons": ["hook is soft — fix it"]}')
    assert u["score"] == 8 and u["flags"]["usable_today"] and u["reasons"] == ["hook is soft, fix it"] and parse_usefulness("nope") is None, "no em dash reaches a card, even from the judge"
    nl = parse_newsletter("TITLE: Hand your inbox to an agent\nSHARE: This week: the inbox.\nBODY:\nPara one.\n\nPara two."); assert nl["title"].startswith("Hand") and nl["body"] == "Para one.\n\nPara two." and parse_newsletter("x") is None
    tp = parse_topics('{"topics": [{"title": "How the triage agent sorts my inbox", "angle": "a", "points": ["p1", "p2", "p3"], "number": "emails a day", "feeds": "Wed"}]}')
    assert len(tp) == 1 and tp[0]["feeds"] == "Wed" and parse_topics("bad") == []
    old = [{"title": "Old kept", "added": "2026-08-30", "n": 1}, {"title": "Old expired", "added": "2026-07-01", "n": 2}, {"title": "Recorded", "added": "2026-09-01", "n": 3, "recorded": "recX"}]
    fresh = [{"title": "old kept", "angle": "dup"}] + [{"title": "New %d" % i, "angle": "a"} for i in range(12)]
    merged = merge_topics(old, fresh, dt.date(2026, 9, 4)); assert len(merged) == TOPIC_COUNT and merged[0]["title"] == "Old kept" and merged[1]["title"] == "New 0" and [t["n"] for t in merged] == list(range(1, 11))
    assert "1. Old kept" in topics_text(merged) and topics_text([]) == "(no topics yet)"
    assert record_name(dt.date(2026, 9, 7), "Mon", "Most owners answer every email.") == "OD Post 2026-09-07 Mon The mistake - Most owners answer every email"
    assert task_name(dt.date(2026, 9, 8), "Tue", "Hook.") == "CONTENT (OD): Tue 8 Sep, The method: Hook"
    post = {"date": "2026-09-08", "day": "Tue", "shape": "The method", "episode": 1992, "quote": "q", "text": "Body of post", "hook": "Hook line", "issues": ["stock phrase removed"],
            "source_line": "Episode 1992, Kevin's own words on camera: \"q\"", "card_url": "https://cdn/c.png", "pdf_url": "https://cdn/c.pdf", "voice_loaded": True,
            "usefulness": {"score": 8, "reasons": ["hook is soft"]}}
    tps = [{"n": 1, "title": "Topic one", "angle": "why", "number": "none needed"}]
    name, desc, out = build_card(post, "test", tps)
    assert name.startswith("CONTENT (OD): Tue 8 Sep, The method: Hook line") and out.startswith("Post this on the Operations Director LinkedIn page on Tuesday 8 September at 08:00.")
    assert out.rstrip().split("\n")[-1].startswith(CLOSING) and "DRAFT" in out and "https://cdn/c.png" in out and "https://cdn/c.pdf" in out and "Usefulness check: 8 out of 10" in out and "Fixed automatically" in out
    assert "Topic one" not in out, "the recording brief rides on the Friday card only"
    _, _, fri = build_card({**post, "day": "Fri", "date": "2026-09-11"}, "live", tps); assert "Topic one" in fri and "08:00" in fri and fri.rstrip().split("\n")[-1].startswith(CLOSING)
    _, _, thin = build_card({"date": "2026-09-09", "day": "Wed", "shape": "The build log", "thin": True, "source_line": "Nothing sourced", "voice_loaded": True}, "test")
    assert thin.startswith("THIN SLOT") and "Nothing is written from nothing" in thin and thin.rstrip().split("\n")[-1].startswith(CLOSING)
    assert "Runpreneur" not in out and "Runpreneur" not in fri, "an OD card never names the Runpreneur socials"
    ed = {"date": "2026-09-11", "n": 1, "title": "Hand your inbox to an agent", "share": "S", "body": "B", "issues": []}
    n2, d2, o2 = build_newsletter_card(ed, "test", tps); assert n2.startswith("CONTENT (OD): Fri 11 Sep, Newsletter:") and P.NEWSLETTER_NAME in o2 and "Topic one" in o2 and o2.rstrip().split("\n")[-1].startswith(CLOSING) and "DRAFT" in o2
    _, _, o3 = build_newsletter_card(ed, "live"); assert "LinkedIn has no API" in o3 and "paste it yourself" in o3
    pl = newsletter_plan(ed, True); assert pl["profile"] == "linkedin" and pl["mode"] == "test" and pl["steps"][0]["url"].startswith("https://www.linkedin.com/article/new") and pl["submit"]["text"] == "Publish"
    assert minutes_for("Approved as-is") == 2 and minutes_for("Approved with minor edits") == 5 and minutes_for("Changes requested") == 10
    import tempfile as _tf
    globals()["HOLD_FILE"] = os.path.join(_tf.gettempdir(), "od-hold-test-%d" % os.getpid()); assert not on_hold(); open(HOLD_FILE, "w").write(""); assert on_hold(); os.remove(HOLD_FILE)
    assert BUSINESS_OD != approval.BUSINESS_PERSONAL and publish.BRANDS[BRAND]["category"] == BRAND and AI_THRESHOLD == 6
    print(json.dumps({"checks": 52, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("--limit", type=int, default=6); ap.add_argument("--week", default=None); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "mine": mine(a.limit, a.dry_run)
    elif a.mode == "backtest": backtest(a.limit)
    elif a.mode == "topics": topics(a.dry_run)
    elif a.mode == "draft": draft(a.week, a.dry_run)
    elif a.mode == "cards": raise_cards(a.dry_run)
    elif a.mode == "sync": sync()
    elif a.mode == "publish": publish_posts(a.dry_run)
    elif a.mode == "publish-sync": publish_sync()
    elif a.mode == "newsletter-publish": newsletter_publish(a.dry_run)
    elif a.mode in ("points",): topics(a.dry_run)
    elif a.mode == "report": report()
    else: raise SystemExit("usage: od_lane.py mine|topics|draft|cards|sync|publish|publish-sync|newsletter-publish|backtest|report|selftest")
