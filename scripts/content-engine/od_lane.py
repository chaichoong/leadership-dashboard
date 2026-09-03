#!/usr/bin/env python3
"""od_lane.py — the Operations Director brand profile of the Content Engine (chain links R3b, O1-O6).

Kevin's rulings (2-3 Sep 2026): Runpreneur vlogs still publish on Runpreneur; their transcripts are
mined for the AI, agents, systems and running-a-business talk, the running stripped, and posted to the
Operations Director LinkedIn page (and the OD Facebook page once connected). One agent, two brands; the
brand is the record's Category; the publisher refuses cross-brand output. Text posts, some with a
quote card rendered from real words. One approval card per post; five land together in Monday's
08:00 digest. Test mode until Kevin writes "live": every post is a GHL planner draft.

  mine   [--limit N]      every Runpreneur Full Episode transcript not yet mined -> two-pass classifier
                          (free word gate at 3 OD words per 1,000, then the AI at score 7+) -> the bank
                          of moments with verbatim quotes. Nightly.
  draft  [--week DATE]    fill next week's five slots from the bank (pillar to slot), fall back to the
                          playbook's hot-buttons for Monday, raise a THIN card when a slot has no sourced
                          material; brief -> draft -> polish -> rules check -> one record per post, a
                          quote card for the two best quotes, two bridge posts for Kevin's profile.
                          Runs Sunday night (or any night the coming week is unfilled).
  cards                   one approval card per drafted post that has none.
  sync                    Kevin's verdicts -> the records; Changes requested = one redo; Rejected with a
                          reason = a lesson for the OD lane.
  publish                 approved posts -> GHL on the right brand at 08:00 London on their day (bridge
                          posts 12:00), drafts in test mode; statuses and links back onto the records.
  points                  this week's talking points for Kevin's runs -> talking-points.md (the huddle
                          folds it into Monday's brief).
  backtest [--limit N]    read-only: score the N most recent transcripts and print the table.
  report                  one line for the morning digest.  selftest.

State (outside the public repo): ~/knowledge-os/logs/content-engine/od-bank.json, od-lane.json.
"""
import argparse, datetime as dt, json, os, re, subprocess, sys, tempfile, urllib.parse
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import watch            # noqa: E402
import platform_copy as pc  # noqa: E402
import approval         # noqa: E402
import publish          # noqa: E402
import od_prompts as P  # noqa: E402
import od_card          # noqa: E402

LONDON = ZoneInfo("Europe/London")
BANK = os.path.join(os.path.dirname(watch.LEDGER), "od-bank.json")
STATE = os.path.join(os.path.dirname(watch.LEDGER), "od-lane.json")
POINTS = os.path.join(os.path.dirname(watch.LEDGER), "talking-points.md")
CARDS_DIR = os.path.join(os.path.dirname(watch.LEDGER), "od-cards")
BRAND, RUNPRENEUR = "Operations Director", "Runpreneur"
BUSINESS_OD = "reca9ofzhuw13ZzGE"        # Tasks -> Business "Operations Director" (verified 6 Aug 2026, CLAUDE.md)
OD_SLOT, BRIDGE_SLOT = (8, 0), (12, 0)   # London; the team's own posts went out 08:00-09:00
GATE_WORDS, AI_THRESHOLD, BANK_DAYS, MAX_MOMENTS = 3.0, 7, 60, 3
CTA_LINK = "https://api.leadconnectorhq.com/widget/booking/BcVVhAg1zLaPVEXj5ih0"   # the Operations Review Call calendar (playbook section 1); the lead magnet replaces it
CLOSING = approval.CLOSING
STATUS_DRAFTED, STATUS_QC, STATUS_APPROVED, STATUS_SCHEDULED, STATUS_PUBLISHED = "Copies in Progress", "Quality Control", "Approved for Publishing", "Publishing In Progress", "Published"
MINUTES = {"approved": 2, "minor": 5, "changes": 10, "rejected": 3}    # ESTIMATES per verdict, never presented as measured

OD_WORDS = [r"\bai\b", r"\bagents?\b", r"\bautomat\w*", r"\bsystem\w*", r"\bprocess\w*", r"\boperations?\b", r"\bdelegat\w*", r"\bworkflow\w*",
            r"\bsops?\b", r"\bbusiness(es)?\b", r"\bfounder\w*", r"\bentrepreneur\w*", r"\bclaude\b", r"\bdashboard\w*", r"\bairtable\b", r"\bprofit\w*",
            r"\bcash ?flow\b", r"\bteam\b", r"\bclients?\b", r"\bproductiv\w*", r"\bmicromanag\w*", r"\bdecision\w*", r"\bscal(e|ing)\b", r"\bhir(e|ing)\b",
            r"\bleverage\b", r"\bkpis?\b", r"\bmetrics?\b", r"\bsoftware\b", r"\btools?\b", r"\broutines?\b", r"\bfocus\w*"]
# "run" is a business word ("runs without you" is the core message), so only the RUNNING senses are stripped.
STRIP_WORDS = re.compile(r"\b(km|kilomet\w*|streak|barefoot|vibrams?|runpreneur|marathon|ultra|charit\w*|children|kids|donat\w*|strava|miles?|jog\w*|trainers|"
                         r"(?:my|today's|this morning's|the|a|each|every) (?:morning |daily |long |short |early )?run|went (?:out )?for a run|running (?:shoes|streak|club|vlog|diary)|runner)\b", re.I)
BANNED = ["amazing", "incredible", "crushing it", "smashing", "game-changer", "game changer", "unlock", "skyrocket", "revolutionis", "disruptive", "cutting-edge",
          "groundbreaking", "powerful", "delve", "harness", "tapestry", "landscape", "navigating", "journey", "in a world where", "not alone", "dive deep", "leverage"]
STOCK_OPENERS = ("in business and", "day ", "imagine ", "picture this")
US_SPELLINGS = re.compile(r"\b(realiz\w*|organiz\w*|color|favorite|center|analyz\w*|behavior|optimiz\w*|prioritiz\w*)\b", re.I)
PRICE_OK = ("£1,500", "£350", "30-day", "30 day")


# ---------- pure helpers (selftested) ----------

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
            if len(q.split()) >= 5: moments.append({"quote": q, "angle": (m.get("angle") or "").strip(), "pillar": m.get("pillar") or d.get("pillar") or "Philosophy"})
        return {"score": score, "verdict": "OD" if score >= AI_THRESHOLD else "no", "pillar": d.get("pillar") or "none",
                "posts_possible": int(d.get("posts_possible", 0) or 0), "moments": moments}
    except (ValueError, AttributeError, TypeError):
        return None


def verbatim(quote, transcript, min_ratio=0.85):
    """A quote counts if it appears in the transcript in order, allowing the small drift a model makes
    when it quotes speech (a dropped "um", a comma, "gonna" for "going to"): the best-matching window
    of the transcript must agree with the quote at 85% or better (difflib ratio on normalised words).
    An exact substring passes at once. A quote the transcript never said fails."""
    import difflib
    norm = lambda s: re.sub(r"[^a-z0-9' ]", "", re.sub(r"\s+", " ", s.lower())).strip()
    q, t = norm(quote), norm(transcript)
    if not q or not t: return False
    if q in t: return True
    qw, tw = q.split(), t.split()
    n = len(qw)
    if n > len(tw): return False
    best = 0.0
    first = qw[0]
    for i, w in enumerate(tw):
        if w != first and (i + n > len(tw) or difflib.SequenceMatcher(None, w, first).ratio() < 0.8): continue
        for span in (n, n + 1, n + 2, n - 1):
            if span < 3 or i + span > len(tw): continue
            r = difflib.SequenceMatcher(None, qw, tw[i:i + span]).ratio()
            if r > best: best = r
            if best >= min_ratio: return True
    return best >= min_ratio


def week_monday(today=None):
    """The Monday of the week to fill: next Monday when run Sat/Sun/Mon-before-08:00-fill, else this week's remaining days are past."""
    today = today or dt.datetime.now(LONDON).date()
    days_ahead = (7 - today.weekday()) % 7
    if days_ahead == 0 and today.weekday() == 0: return today          # Monday itself: this week
    return today + dt.timedelta(days=days_ahead or 7)


def slot_dates(monday):
    return [(monday + dt.timedelta(days=i), name, slot, pillar) for i, (name, slot, pillar) in enumerate(P.SLOTS)]


def pick_moment(bank, pillar, used, today=None, week_episodes=()):
    """Best unused moment for a pillar: an episode not already used this week first (one episode should
    not fill four of the five slots), then highest episode score, then newest. None = nothing sourced."""
    today = today or dt.date.today()
    cands = []
    for rid, e in bank.items():
        if e.get("verdict") != "OD": continue
        mined = dt.date.fromisoformat(e["mined"][:10])
        if (today - mined).days > BANK_DAYS: continue
        for i, m in enumerate(e.get("moments", [])):
            key = "%s#%d" % (rid, i)
            if key in used: continue
            if pillar and m.get("pillar") != pillar: continue
            cands.append((1 if e.get("episode") in week_episodes else 0, -e.get("score", 0), -e.get("episode", 0), key, rid, m))
    if not cands: return None
    cands.sort(key=lambda c: (c[0], c[1], c[2]))
    _, _, _, key, rid, m = cands[0]
    return {"key": key, "record": rid, "episode": bank[rid].get("episode"), "quote": m["quote"], "angle": m.get("angle", ""), "pillar": m.get("pillar")}


REGISTER_API = "https://api.airtable.com/v0/%s/tbl9msVjyQWslLOIZ" % watch.BASE


def register_proof_source(state, fetch=None):
    """Wednesday's Proof source when no transcript moment is a Proof moment (Kevin's decision 8, 3 Sep 2026):
    one AI Agents register row at Status Live or Built, what it does in the row's own words, rotated so the
    same agent is not the subject twice in eight weeks. No figure comes with it: the post describes the agent
    and states no number the row does not carry. Returns (source, source_line) or (None, None)."""
    fetch = fetch or (lambda: watch._airtable("GET", REGISTER_API + "?" + urllib.parse.urlencode({"filterByFormula": 'OR({Status}="Live",{Status}="Built")', "pageSize": 50})
                                             + "&fields[]=Name&fields[]=Status&fields[]=What+It+Does&fields[]=Department").get("records", []))
    rows = [r for r in fetch() if (r.get("fields", {}).get("What It Does") or "").strip()]
    if not rows: return None, None
    recent = state.setdefault("proof_rows", [])[-8:]
    rows.sort(key=lambda r: (r["id"] in recent, r["fields"].get("Status") != "Live", r["fields"].get("Name", "")))
    r = rows[0]; f = r["fields"]
    state["proof_rows"] = (recent + [r["id"]])[-8:]
    src = ("AI Agents register row %s: agent \"%s\" (Status %s, %s department), running on Kevin's own businesses. What it does, in the register's words: %s"
           % (r["id"], f.get("Name"), f.get("Status"), f.get("Department", "?"), f["What It Does"].strip()))
    return src, "AI Agents register, agent \"%s\" (Status %s): what it does, in the register's own words. No figures: none are on the row." % (f.get("Name"), f.get("Status"))


def hot_button_source(monday):
    """Monday's fallback when the bank has no Pain moment: a hot-button in the customers' own words
    (playbook section 3, verbatim from real sales calls). Rotates by week so five weeks cover the five."""
    i = (monday.isocalendar()[1]) % len(P.HOT_BUTTONS)
    a, b = P.HOT_BUTTONS[i]
    return "Playbook section 3, hot-button %d, a customer's words on a real sales call: %s. \"%s\"" % (i + 1, a, b)


TICS = re.compile(r"(?:^|(?<=[.!?]\s)|(?<=\n))(The reality is|Here's the thing|Let that sink in|The truth is)[,:]?\s+(\w)", re.M)
TIME_WORDS = re.compile(r"\b(today|this morning|yesterday|this week|tonight|just now|earlier today)\b", re.I)


def strip_tics(text):
    """Remove the model's stock phrases in place and re-capitalise what follows. Deterministic, like the em-dash fix."""
    return TICS.sub(lambda m: m.group(2).upper(), text)


def bridge_check(text):
    """A bridge post is written weeks after the episode: any 'today' is false (Chen's time-sensitive rule)."""
    m = TIME_WORDS.search(text)
    return ["time word '%s' in a bridge post about an old episode" % m.group(0)] if m else []


def rules_check(text, source, slot_name, is_friday=False):
    """(fixed_text, issues). Em dashes fixed in place; everything else reported, never rewritten."""
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
    if len(first) > 140: issues.append("hook over 140 characters")
    wc = len(t.split())
    if wc < 60 or wc > 230: issues.append("%d words (60-220)" % wc)
    has_link = "http" in low or "www." in low
    has_ask = bool(re.search(r"\b(comment|dm me|message me|book a|link in|sign up|download|reply with)\b", low))
    if not is_friday and (has_link or has_ask): issues.append("ask or link on a %s (Friday only)" % slot_name)
    for fig in re.findall(r"£[\d,]+(?:\.\d+)?[MmKk]?", t):
        if not any(fig.startswith(ok) for ok in PRICE_OK) and fig not in source: issues.append("figure %s not in the source" % fig)
    for num in re.findall(r"(?<![£\w])\d[\d,]*(?:\.\d+)?%?", t):
        if num.rstrip("%") in ("90", "1", "2", "3", "10", "30") and "%" not in num: continue
        if num == "90%": continue
        if num not in source and num.rstrip("%") not in source: issues.append("number %s not in the source" % num)
    if "runpreneur" in low: issues.append("brand word Runpreneur")
    return t, sorted(set(issues))


def record_name(date, slot, hook):
    return "OD Post %s %s %s - %s" % (date.isoformat(), date.strftime("%a"), slot, hook[:60].rstrip(" .,"))


def task_name(date, slot, hook):
    return "CONTENT (OD): %s, %s: %s" % (date.strftime("%a %-d %b"), slot, hook[:70].rstrip(" .,"))


def build_card(post, mode):
    """The write-up. Kevin's rule: the ask in one line first, the work as written, where it came from,
    the checks, the closing line the queue reads."""
    date = dt.date.fromisoformat(post["date"])
    where = "the Operations Director LinkedIn page" + (" and the Operations Director Facebook page" if post.get("facebook") else "")
    ask = "Post this on %s on %s at 08:00." % (where, date.strftime("%A %-d %B"))
    if post.get("thin"):
        ask = "THIN SLOT: %s %s has no sourced material. Give me one line of context (a real number, a process you handed to an agent, a decision this week) as 'Changes requested' and I will write the post from it. Nothing is written from nothing." % (date.strftime("%A %-d %B"), post["slot"])
    parts = [ask]
    if post.get("text"): parts.append("The post, as written:\n\n" + post["text"])
    if post.get("card_url"): parts.append("Quote card (attached to the post): " + post["card_url"])
    parts.append("Where it came from:\n" + post["source_line"])
    if post.get("bridge_text"): parts.append("Bridge post for your personal profile, 12:00 the same day (Runpreneur-framed, no ask):\n\n" + post["bridge_text"])
    issues = (post.get("issues") or []) + (post.get("bridge_issues") or [])
    parts.append(("Rules check flagged: " + "; ".join(issues)) if issues else "Rules check: nothing flagged (UK English, no em dashes, no hashtags, no running words, every figure in the source, no ask before Friday).")
    if not post.get("voice_loaded"): parts.append("Note: Kevin's voice profile was not readable when this was written (Drive offline), so the post was written from the rules alone.")
    if mode == "live":
        parts.append("%s scheduling this post to %s through GoHighLevel for %s 08:00%s. Nothing else." % (CLOSING, where, date.strftime("%A"), ", and the bridge post to your LinkedIn profile at 12:00" if post.get("bridge_text") else ""))
    else:
        parts.append("%s TEST MODE: creating this post as a DRAFT in the GoHighLevel planner for %s%s, for you to open and check. Nothing reaches a public feed until you switch the engine to live." % (CLOSING, where, " (and the bridge post as a draft for your profile)" if post.get("bridge_text") else ""))
    desc = "Approve one Operations Director LinkedIn post for %s. The Content Engine mined it from %s and wrote it in the OD voice. Nothing is published until you approve." % (
        date.strftime("%A %-d %B"), ("Episode %s of your run diary" % post["episode"]) if post.get("episode") else "the playbook's named sources")
    return task_name(date, post["slot"], post.get("hook") or post["slot"]), desc, "\n\n".join(parts)


def minutes_for(outcome):
    if outcome in ("Approved as-is",): return MINUTES["approved"]
    if outcome in ("Approved with minor edits",): return MINUTES["minor"]
    if outcome == "Rejected": return MINUTES["rejected"]
    return MINUTES["changes"]


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
    """The OD lane's own lessons section of the agent file, appended to every OD Claude call."""
    try: text = open(watch.AGENT_FILE).read()
    except OSError: return ""
    m = re.search(r"^## Lessons from Kevin \(Operations Director\)\s*\n(.*?)(?=^## |\Z)", text, re.S | re.M)
    body = (m.group(1) if m else "").strip()
    return ("\n\nLessons Kevin has given the Operations Director lane (apply every one):\n" + body) if body else ""


def add_lesson(words):
    text = open(watch.AGENT_FILE).read()
    head = "## Lessons from Kevin (Operations Director)"
    line = "- (%s) %s" % (dt.date.today().isoformat(), words.strip())
    if head in text:
        text = re.sub(r"(%s\s*\n)" % re.escape(head), lambda m: m.group(1) + line + "\n", text, count=1)
    else:
        text = text.rstrip("\n") + "\n\n" + head + "\n" + line + "\n"
    with open(watch.AGENT_FILE, "w") as fh: fh.write(text)


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


def mine_one(rec, ask=None):
    ff = rec["fields"]; t = (ff.get("Transcription") or "")
    density = gate_density(t)
    m = re.search(r"Episode (\d+)", ff.get("Content Name", "")); episode = int(m.group(1)) if m else None
    entry = {"name": ff.get("Content Name", "")[:80], "episode": episode, "density": round(density, 1), "mined": dt.datetime.now().isoformat(timespec="seconds")}
    if density < GATE_WORDS:
        entry.update({"verdict": "no", "score": 0, "how": "word gate", "moments": []}); return entry
    text, usage, cost = (ask or pc.ask_claude)(P.MINE_SYSTEM, "TRANSCRIPT:\n" + t[:12000])
    parsed = parse_mine(text)
    if parsed is None:
        entry.update({"verdict": "unread", "score": None, "how": "AI did not answer in shape", "moments": [], "raw": text[:200]}); return entry
    kept = [x for x in parsed["moments"] if verbatim(x["quote"], t)]
    parsed["moments_dropped"] = len(parsed["moments"]) - len(kept); parsed["moments"] = kept
    entry.update(parsed); entry["how"] = "AI"; entry["cost_usd"] = cost
    return entry


def mine(limit=6, dry_run=False):
    bank = _load(BANK); recs = unmined(limit)
    if not recs: print("od mine: nothing new to mine"); return
    for rec in recs:
        e = mine_one(rec)
        print("od mine: %s -> %s (density %.1f%s%s)" % (e["name"], e["verdict"], e["density"], (", score %s" % e["score"]) if e.get("score") is not None else "",
                                                       (", %d moments" % len(e["moments"])) if e.get("moments") else ""))
        if e["verdict"] == "OD":
            note = "OD lane %s: %d moment%s banked for Operations Director posts." % (dt.date.today().isoformat(), len(e["moments"]), "" if len(e["moments"]) == 1 else "s")
            if not dry_run: watch._airtable("PATCH", watch.API + "/" + rec["id"], {"fields": {"Notes": approval.append_note(rec, note)}})
        if e["verdict"] != "unread": bank[rec["id"]] = e
    if not dry_run: _save(BANK, bank)


def backtest(limit=30):
    bank_now = _load(BANK); f = 'AND({Content Type}="Long Form Video", {Category}="Runpreneur", LEN({Transcription})>1500)'
    url = watch.API + "?" + urllib.parse.urlencode({"filterByFormula": f, "pageSize": limit, "sort[0][field]": "Date Published (YT)", "sort[0][direction]": "desc"})
    for fld in ("Content Name", "Transcription", "Category"): url += "&fields[]=" + urllib.parse.quote(fld)
    recs = watch._airtable("GET", url).get("records", [])
    print("%-52s %7s %5s %-3s %-10s %s" % ("episode", "words/1k", "score", "vd", "pillar", "moments"))
    for rec in recs:
        e = bank_now.get(rec["id"]) or mine_one(rec)
        print("%-52s %7.1f %5s %-3s %-10s %d" % (e["name"][:52], e["density"], e.get("score"), (e["verdict"] or "")[:3], e.get("pillar", ""), len(e.get("moments", []))))


# ---------- draft (O1-O4) ----------

def _claude(system, user, brand_lessons=True):
    return pc.ask_claude(system + (od_lessons() if brand_lessons else ""), user)[0]


def source_for(mom, monday, pillar, bank, state=None):
    if mom:
        return ("Episode %d of Kevin's run diary, verbatim: \"%s\" (angle: %s)" % (mom["episode"], mom["quote"], mom["angle"]),
                "Episode %d, Kevin's own words on camera: \"%s\"" % (mom["episode"], mom["quote"]))
    if pillar == "Pain":
        s = hot_button_source(monday); return s, s
    if pillar == "Proof" and state is not None:
        return register_proof_source(state)
    return None, None


def write_post(slot_name, pillar, date, source, voice):
    system = P.OD_SYSTEM + ("\n\n" + voice if voice else "")
    brief = _claude(system, P.BRIEF_PROMPT.format(slot=slot_name, pillar=pillar or "Offer", date=date.strftime("%A %-d %B %Y"), source=source))
    draft = _claude(system, P.DRAFT_PROMPT.format(brief=brief, source=source))
    polished = _claude(system, P.POLISH_PROMPT.format(draft=draft))
    if slot_name == "Offer":
        polished = polished.rstrip() + "\n\nIf your business only runs when you are in it, book a free Operations Review Call: " + CTA_LINK
    text, issues = rules_check(polished, source, slot_name, is_friday=(slot_name == "Offer"))
    hook = text.split("\n")[0].strip()
    m = re.search(r"HOOK:\s*(.+)", brief)
    return {"brief": brief, "text": text, "issues": issues, "hook": (m.group(1).strip() if m else hook)[:120]}


def draft(week=None, dry_run=False):
    state = _load(STATE); bank = _load(BANK)
    monday = dt.date.fromisoformat(week) if week else week_monday()
    posts = state.setdefault("posts", {})
    used = {p["moment"] for p in posts.values() if p.get("moment")}
    week_eps = set()
    voice = P.voice_profile(); voice_loaded = bool(voice)
    made = 0
    for date, _, slot_name, pillar in slot_dates(monday):
        pid = date.isoformat()
        if pid in posts:
            if posts[pid].get("episode"): week_eps.add(posts[pid]["episode"])
            continue
        mom = pick_moment(bank, pillar, used, week_episodes=week_eps) if slot_name != "Offer" else (pick_moment(bank, None, used, week_episodes=week_eps))
        if slot_name == "Proof" and mom and mom["pillar"] != "Proof": mom = None      # Proof only from a real Proof moment
        source, source_line = source_for(mom, monday, pillar, bank, state)
        if mom: used.add(mom["key"]); week_eps.add(mom["episode"])
        post = {"date": pid, "slot": slot_name, "pillar": pillar or "Offer", "brand": BRAND, "moment": mom["key"] if mom else None,
                "episode": mom["episode"] if mom else None, "quote": mom["quote"] if mom else None, "created": dt.datetime.now().isoformat(timespec="seconds"),
                "voice_loaded": voice_loaded}
        if not source:
            post.update({"thin": True, "source_line": "Nothing sourced for this slot: the bank holds no %s moment inside %d days and the playbook names no other source for it." % (pillar or "Offer", BANK_DAYS)})
            print("od draft: %s %s -> THIN (no sourced material)" % (pid, slot_name))
        else:
            if dry_run: print("od draft: %s %s <- %s" % (pid, slot_name, source_line[:100])); continue
            w = write_post(slot_name, pillar, date, source, voice)
            post.update(w); post["source_line"] = source_line
            print("od draft: %s %s written, %d words%s" % (pid, slot_name, len(w["text"].split()), ("; flagged: " + "; ".join(w["issues"])) if w["issues"] else ""))
        posts[pid] = post; made += 1
    if dry_run: return
    # quote cards for the two strongest quoted posts of the week; bridge posts for Tue and Wed (Kevin, 3 Sep 2026)
    week_posts = [p for d, p in posts.items() if d[:10] >= monday.isoformat() and d[:10] <= (monday + dt.timedelta(days=4)).isoformat() and not p.get("thin")]
    quoted = sorted([p for p in week_posts if p.get("quote") and not p.get("card_png")], key=lambda p: -len(p["quote"]))[:2]
    os.makedirs(CARDS_DIR, exist_ok=True)
    for p in quoted:
        png = os.path.join(CARDS_DIR, "od-card-%s.png" % p["date"])
        try: od_card.render(p["quote"], png); p["card_png"] = png
        except SystemExit as ex: print("od draft: card for %s not rendered (%s)" % (p["date"], str(ex)[:120]))
    for p in week_posts:
        if p["slot"] in ("Method", "Proof") and p.get("episode") and not p.get("bridge_text"):
            txt = _claude(P.BRIDGE_SYSTEM, P.BRIDGE_PROMPT.format(episode=p["episode"], quote=p["quote"], post=p["text"]), brand_lessons=False)
            txt = strip_tics(txt.strip()); p["bridge_issues"] = bridge_check(txt)
            p["bridge_text"] = txt + "\n\n" + P.OD_PAGE_URL
    _save(STATE, state)
    for p in week_posts:
        if not p.get("record"): p["record"] = create_record(p)
    _save(STATE, state)
    print("od draft: week of %s, %d slot%s drafted" % (monday, made, "" if made == 1 else "s"))


def create_record(p):
    date = dt.date.fromisoformat(p["date"])
    fields = {"Content Name": record_name(date, p["slot"], p.get("hook") or p["slot"]), "Category": BRAND, "Content Type": "Written",
              "Record Status": STATUS_DRAFTED, "Responsible": "Content Engine (AI)", "LinkedIn Copy": p["text"], "Target Publish Date": p["date"],
              "Platforms": ["LinkedIn Post"], "AI Generated": True, "AI Feature": "Copywriting", "Model": pc.MODEL,
              "Notes": "OD lane %s: %s slot. Source: %s%s" % (dt.date.today().isoformat(), p["slot"], p["source_line"], ("; REVIEW: " + "; ".join(p["issues"])) if p.get("issues") else "")}
    r = watch._airtable("POST", watch.API, {"fields": fields, "typecast": True})
    return r["id"]


# ---------- cards (O5) ----------

def raise_cards(dry_run=False):
    state = _load(STATE); posts = state.get("posts", {}); m = publish.mode()
    today = dt.date.today().isoformat()
    for pid, p in sorted(posts.items()):
        if p.get("task") or p.get("verdict") or pid < today: continue
        if p.get("card_png") and not p.get("card_url") and not dry_run:
            try: p["card_url"] = publish.upload_media(p["card_png"], brand=BRAND)
            except SystemExit as ex: print("od cards: card upload failed for %s (%s)" % (pid, str(ex)[:120]))
        name, desc, out = build_card(p, m)
        if dry_run: print(out); print("-----"); continue
        tid = approval.existing_task(name)
        if not tid:
            fields = {approval.TF["name"]: name, approval.TF["desc"]: desc, approval.TF["status"]: "Today", approval.TF["team"]: [approval.AGENT_TM],
                      approval.TF["priority"]: "Medium", approval.TF["due"]: today, approval.TF["business"]: [BUSINESS_OD],
                      approval.TF["notes"]: "Raised by the Content Engine (Operations Director lane) %s for record %s. Created with --force: the date and slot are the identity and the duplicate key strips them." % (today, p.get("record"))}
            r = subprocess.run([sys.executable, approval.GATE, "create", "--force", "--fields-json", json.dumps(fields)], capture_output=True, text=True)
            if r.returncode != 0: raise SystemExit("od cards: task gate failed: " + (r.stderr or r.stdout)[-400:])
            tid = json.loads(r.stdout.strip().splitlines()[-1])["taskId"]
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as fh:
            fh.write(out); path = fh.name
        try:
            r = subprocess.run([sys.executable, approval.DISPATCH, "submit", tid, "--agent", approval.AGENT_TM, "--type", approval.TASK_TYPE, "--output-file", path], capture_output=True, text=True)
        finally: os.remove(path)
        if r.returncode != 0: raise SystemExit("od cards: submit failed for %s: %s" % (tid, (r.stderr or r.stdout)[-400:]))
        p["task"] = tid; p["raised"] = dt.datetime.now().isoformat(timespec="seconds")
        if p.get("record"):
            rec = watch._airtable("GET", watch.API + "/" + p["record"])
            watch._airtable("PATCH", watch.API + "/" + p["record"], {"fields": {"Record Status": STATUS_QC, "Notes": approval.append_note(rec, "Approval card %s raised %s." % (tid, today))}})
        _save(STATE, state)
        print("od cards: %s -> %s (%s)" % (pid, tid, name))


def sync():
    state = _load(STATE); posts = state.get("posts", {}); changed = False
    for pid, p in posts.items():
        if not p.get("task") or p.get("verdict"): continue
        t = watch._airtable("GET", approval.TASKS_API + "/" + p["task"] + "?returnFieldsByFieldId=true")["fields"]
        outcome = t.get(approval.TF["outcome"])
        if isinstance(outcome, dict): outcome = outcome.get("name")
        if not outcome: continue
        words = (t.get(approval.TF["feedback"]) or "").strip()
        p["outcome"] = outcome; p["feedback"] = words; p["minutes_est"] = minutes_for(outcome); changed = True
        if outcome in approval.APPROVED:
            p["verdict"] = "approved"
            if p.get("record"): watch._airtable("PATCH", watch.API + "/" + p["record"], {"fields": {"Record Status": STATUS_APPROVED}})
        elif outcome == "Rejected":
            p["verdict"] = "rejected"
            if words: add_lesson(words); p["lesson"] = True
            if p.get("record"): watch._airtable("PATCH", watch.API + "/" + p["record"], {"fields": {"Feedback": words or "Rejected without a reason"}})
        else:   # Changes requested: one redo with Kevin's words as extra source, then a fresh card
            if p.get("redone"):
                p["verdict"] = "dropped"; print("od sync: %s changes requested twice, slot dropped" % pid)
            else:
                src = (p.get("source_line") or "") + ("\nKevin's own words for this post: " + words if words else "")
                w = write_post(p["slot"], p["pillar"] if p["pillar"] != "Offer" else None, dt.date.fromisoformat(pid), src, P.voice_profile())
                p.update(w); p["thin"] = False; p["source_line"] = src; p["redone"] = True; p["task"] = None; p["outcome_first"] = outcome
                if p.get("record"): watch._airtable("PATCH", watch.API + "/" + p["record"], {"fields": {"LinkedIn Copy": w["text"], "Feedback": words, "Record Status": STATUS_DRAFTED}})
                else: p["record"] = create_record(p)
                print("od sync: %s redone from Kevin's words, new card next run" % pid)
        print("od sync: %s -> %s (%s)" % (pid, p.get("verdict") or "redo", outcome))
    if changed: _save(STATE, state)
    if not changed: print("od sync: no verdicts to read")


# ---------- publish (O6) ----------

def publish_posts(dry_run=False):
    state = _load(STATE); posts = state.get("posts", {}); m = publish.mode(); test = m == "test"
    todo = [(pid, p) for pid, p in sorted(posts.items()) if p.get("verdict") == "approved" and not p.get("ghl") and pid >= dt.date.today().isoformat()]
    if not todo: print("od publish: nothing approved and unscheduled"); return
    od_accts = publish.allowed_accounts(BRAND, "post", publish.accounts(BRAND))
    if not od_accts: raise SystemExit("od publish: no Operations Director account is connected in GoHighLevel")
    _, _, user = publish._cfg(BRAND)
    bridge_accts = None
    for pid, p in todo:
        rec = watch._airtable("GET", watch.API + "/" + p["record"]) if p.get("record") else {"fields": {"Category": BRAND}}
        publish.assert_brand(rec["fields"], BRAND)
        day = dt.date.fromisoformat(pid); when = publish.slot_iso(day, OD_SLOT)
        status = "draft" if test else "scheduled"
        if dry_run:
            for a in od_accts: print("  would %s %s -> %s (%s) at %s" % (status, pid, a["name"], a["platform"], when))
            continue
        p["ghl"] = {}
        for a in od_accts:
            body = publish.build_text_post(a, p["text"], when, user, p.get("card_url"), status=status)
            pid_ghl = publish.create_post(body, brand=BRAND)
            p["ghl"]["%s|%s" % (a["platform"], a["id"])] = {"id": pid_ghl, "status": status, "account": a["name"], "platform": a["platform"], "mode": m}
            print("od publish [%s]: %s -> %s %s %s" % (m.upper(), pid, a["name"], status, when if not test else ""))
        if p.get("bridge_text"):
            if bridge_accts is None: bridge_accts = publish.allowed_accounts(RUNPRENEUR, "bridge", publish.accounts(RUNPRENEUR))
            for a in bridge_accts:
                body = publish.build_text_post(a, p["bridge_text"], publish.slot_iso(day, BRIDGE_SLOT), user, None, status=status)
                gid = publish.create_post(body, brand=RUNPRENEUR)
                p["ghl"]["bridge|%s" % a["id"]] = {"id": gid, "status": status, "account": a["name"], "platform": "linkedin", "brand": RUNPRENEUR, "mode": m}
                print("od publish [%s]: bridge %s -> %s (%s) %s" % (m.upper(), pid, a["name"], RUNPRENEUR, status))
        if p.get("record"):
            watch._airtable("PATCH", watch.API + "/" + p["record"], {"fields": {"Record Status": STATUS_SCHEDULED, "Notes": approval.append_note(rec, "%s: %s through GoHighLevel%s." % (
                dt.date.today().isoformat(), "DRAFT in the planner (test mode)" if test else "scheduled for 08:00", " with quote card" if p.get("card_url") else ""))}})
        _save(STATE, state)


def publish_sync():
    state = _load(STATE); changed = False
    for pid, p in state.get("posts", {}).items():
        for key, g in (p.get("ghl") or {}).items():
            if g.get("status") in ("published", "draft", "failed"): continue
            brand = g.get("brand", BRAND); _, loc, _ = publish._cfg(brand)
            try: r = publish.ghl("GET", "/social-media-posting/%s/posts/%s" % (loc, g["id"]), brand=brand)
            except SystemExit as ex: print("od publish sync: cannot read %s (%s)" % (g["id"], str(ex)[:100])); continue
            post = (r.get("results") or r).get("post") or r
            st = post.get("status"); link = post.get("previewLink") or ""
            if st != g.get("status"): g["status"] = st; changed = True
            if st == "failed": g["error"] = str(post.get("error"))[:200]; print("od publish sync: %s %s FAILED: %s" % (pid, key, g["error"]))
            if st == "published" and link and p.get("record") and not key.startswith("bridge"):
                g["link"] = link
                fields = {"Record Status": STATUS_PUBLISHED, "Date Published (Other)": dt.date.today().isoformat()}
                if g["platform"] == "linkedin": fields.update({"LinkedIn Link": link, "Link of Linkedin Post": link})
                if g["platform"] == "facebook": fields.update({"Facebook Page Post Link": link, "Link of Facebook Page Post": link})
                watch._airtable("PATCH", watch.API + "/" + p["record"], {"fields": fields}); changed = True
    if changed: _save(STATE, state)


# ---------- talking points (Kevin's ask, 3 Sep 2026) ----------

def talking_points(week=None):
    state = _load(STATE); bank = _load(BANK)
    monday = dt.date.fromisoformat(week) if week else week_monday()
    thin = [p["slot"] for d, p in state.get("posts", {}).items() if p.get("thin") and d >= monday.isoformat()]
    counts = {}
    for e in bank.values():
        for m in e.get("moments", []): counts[m.get("pillar")] = counts.get(m.get("pillar"), 0) + 1
    gaps = [pl for pl in ("Pain", "Method", "Proof", "Philosophy") if counts.get(pl, 0) < 2]
    user = ("Week of %s. Slots with no sourced material: %s. Pillars the bank is short on: %s. The bank holds %d moments in total. "
            "Wednesday's Proof slot can only use numbers Kevin states on camera about his own businesses (property portfolio, the AI agents on his dashboard, jobs no human does any more)."
            % (monday, ", ".join(thin) or "none", ", ".join(gaps) or "none", sum(counts.values())))
    text = _claude(P.TALKING_POINTS_SYSTEM, user, brand_lessons=False)
    body = "# Talking points for this week's runs (week of %s)\n\nWritten %s by the Content Engine's Operations Director lane. Say them on camera in your own words; the transcript becomes the source.\n\n%s\n" % (monday, dt.date.today().isoformat(), text.strip())
    with open(POINTS, "w") as fh: fh.write(body)
    print(body)


def report():
    state = _load(STATE); bank = _load(BANK); posts = state.get("posts", {})
    od = sum(1 for e in bank.values() if e.get("verdict") == "OD"); moments = sum(len(e.get("moments", [])) for e in bank.values() if e.get("verdict") == "OD")
    waiting = [d for d, p in posts.items() if p.get("task") and not p.get("verdict")]
    approved = [d for d, p in posts.items() if p.get("verdict") == "approved" and not p.get("ghl")]
    out = [d for d, p in posts.items() if p.get("ghl")]
    mins = [p["minutes_est"] for p in posts.values() if p.get("minutes_est")]
    print("OD content lane: bank %d episode%s / %d moments; %d card%s waiting for Kevin; %d approved and unscheduled; %d post%s in GoHighLevel (%s)%s" % (
        od, "" if od == 1 else "s", moments, len(waiting), "" if len(waiting) == 1 else "s", len(approved), len(out), "" if len(out) == 1 else "s", publish.mode().upper(),
        ("; about %.1f human minutes a post, estimated from verdicts" % (sum(mins) / len(mins))) if mins else ""))


def selftest():
    assert gate_density("we built an AI agent to run the process for the business team") > 100 and gate_density("the weather was cold and my feet hurt") == 0
    assert not STRIP_WORDS.search("your business runs on you and it should run without you") and STRIP_WORDS.search("on my run this morning") and STRIP_WORDS.search("day 2,195 of the streak")
    assert parse_mine('```json\n{"score": 8, "pillar": "Method", "posts_possible": 2, "moments": [{"quote": "one two three four five six", "angle": "a", "pillar": "Method"}, {"quote": "too short", "angle": "b"}]}\n```')["moments"].__len__() == 1
    assert parse_mine('{"score": 3, "moments": []}')["verdict"] == "no" and parse_mine("I cannot help") is None
    assert verbatim("turn SOPs into AI agents", "you can now turn SOPs, into AI agents and more") and not verbatim("agents into SOPs", "turn SOPs into AI agents")
    assert verbatim("remove as much of the emotion from the process as possible", "so, um, remove as much of the emotion, from the process as possible because")
    assert verbatim("I normally look at them over a 30 day period", "and I normally look at them over a thirty, 30 day period and that's")
    assert not verbatim("we doubled revenue in six months", "we ran ten kilometres in the rain and it was cold and the wind was up")
    assert week_monday(dt.date(2026, 9, 3)) == dt.date(2026, 9, 7) and week_monday(dt.date(2026, 9, 6)) == dt.date(2026, 9, 7) and week_monday(dt.date(2026, 9, 7)) == dt.date(2026, 9, 7)
    sd = slot_dates(dt.date(2026, 9, 7)); assert [s[2] for s in sd] == ["Pain", "Method", "Proof", "Contrarian", "Offer"] and sd[4][0] == dt.date(2026, 9, 11) and sd[3][3] == "Philosophy"
    bank = {"r1": {"verdict": "OD", "score": 9, "episode": 1992, "mined": "2026-09-03T00:00:00", "moments": [{"quote": "q1 " * 4, "angle": "a", "pillar": "Method"}, {"quote": "q2 " * 4, "angle": "b", "pillar": "Pain"}]},
            "r2": {"verdict": "OD", "score": 7, "episode": 1979, "mined": "2026-09-03T00:00:00", "moments": [{"quote": "q3 " * 4, "angle": "c", "pillar": "Method"}]},
            "r3": {"verdict": "no", "score": 2, "episode": 1990, "mined": "2026-09-03T00:00:00", "moments": [{"quote": "x " * 4, "angle": "d", "pillar": "Method"}]},
            "r4": {"verdict": "OD", "score": 10, "episode": 1900, "mined": "2026-06-01T00:00:00", "moments": [{"quote": "old " * 4, "angle": "e", "pillar": "Method"}]}}
    today = dt.date(2026, 9, 5)
    m = pick_moment(bank, "Method", set(), today); assert m["key"] == "r1#0", "highest score first, never a 'no' episode, never older than %d days" % BANK_DAYS
    assert pick_moment(bank, "Method", {"r1#0"}, today)["key"] == "r2#0" and pick_moment(bank, "Proof", set(), today) is None
    assert pick_moment(bank, None, {"r1#0", "r1#1", "r2#0"}, today) is None, "the stale r4 moment is never picked"
    assert pick_moment(bank, "Method", set(), today, week_episodes={1992})["key"] == "r2#0", "an episode already used this week yields to another"
    assert pick_moment(bank, "Method", {"r2#0"}, today, week_episodes={1992})["key"] == "r1#0", "unless it is the only one left"
    rows = [{"id": "a", "fields": {"Name": "Task Manager", "Status": "Live", "What It Does": "Keeps the board small.", "Department": "Operations"}},
            {"id": "b", "fields": {"Name": "Content Engine", "Status": "Built", "What It Does": "Turns episodes into posts.", "Department": "Marketing"}},
            {"id": "c", "fields": {"Name": "Empty", "Status": "Live", "What It Does": ""}}]
    st = {}
    src, line = register_proof_source(st, fetch=lambda: rows); assert "Task Manager" in src and st["proof_rows"] == ["a"] and "No figures" in line
    src2, _ = register_proof_source(st, fetch=lambda: rows); assert "Content Engine" in src2, "rotates off the agent used last time"
    assert register_proof_source({}, fetch=lambda: []) == (None, None)
    assert "hot-button" in hot_button_source(dt.date(2026, 9, 7)) and hot_button_source(dt.date(2026, 9, 7)) != hot_button_source(dt.date(2026, 9, 14))
    good = "Your business runs on you.\n\n" + ("Every decision waits for you. " * 12) + "\nThat is the trap Operations Director exists to remove."
    t, issues = rules_check(good, "", "Pain"); assert issues == [], issues
    t, issues = rules_check("Day 2195 — we realize amazing things on my run #ai, comment below. Raised £2,500 for kids. " * 3, "", "Method")
    for want in ("em dash replaced", "US spelling", "banned word 'amazing'", "Runpreneur word", "hashtag", "stock opener", "ask or link", "figure £2,500"):
        assert any(want in i for i in issues), (want, issues)
    t, issues = rules_check(good.replace("trap", "trap. Book a call: https://x") , "", "Offer", is_friday=True); assert not any("ask or link" in i for i in issues)
    t, issues = rules_check(good + " We saved 14 hours.", "", "Pain"); assert any("number 14" in i for i in issues)
    t, issues = rules_check(good + " We saved 14 hours.", "saved 14 hours a week", "Pain"); assert issues == [], issues
    t, issues = rules_check(good + " It costs £350 a month.", "", "Pain"); assert not any("figure" in i for i in issues), "locked pricing is always allowed"
    assert record_name(dt.date(2026, 9, 7), "Pain", "Your business runs on you.") == "OD Post 2026-09-07 Mon Pain - Your business runs on you"
    assert task_name(dt.date(2026, 9, 7), "Pain", "Your business runs on you.") == "CONTENT (OD): Mon 7 Sep, Pain: Your business runs on you"
    post = {"date": "2026-09-08", "slot": "Method", "pillar": "Method", "episode": 1992, "quote": "q", "text": "Body of post", "hook": "Hook line", "issues": [],
            "source_line": "Episode 1992, Kevin's own words on camera: \"q\"", "card_url": "https://cdn/c.png", "bridge_text": "bridge words", "voice_loaded": True}
    name, desc, out = build_card(post, "test")
    assert name.startswith("CONTENT (OD): Tue 8 Sep, Method: Hook line") and out.startswith("Post this on the Operations Director LinkedIn page on Tuesday 8 September at 08:00.")
    assert out.rstrip().split("\n")[-1].startswith(CLOSING) and "DRAFT" in out and "Body of post" in out and "https://cdn/c.png" in out and "bridge words" in out and "Episode 1992" in out
    assert "Nothing is published until you approve" in desc and "Runpreneur" not in out.replace("Runpreneur-framed", ""), "an OD card never names the Runpreneur socials"
    _, _, live = build_card({**post, "facebook": True}, "live"); assert "Facebook page" in live and "08:00" in live and live.rstrip().split("\n")[-1].startswith(CLOSING)
    _, _, thin = build_card({"date": "2026-09-09", "slot": "Proof", "pillar": "Proof", "thin": True, "source_line": "Nothing sourced", "voice_loaded": True}, "test")
    assert thin.startswith("THIN SLOT") and "Nothing is written from nothing" in thin and thin.rstrip().split("\n")[-1].startswith(CLOSING)
    assert strip_tics("Plan it.\n\nThe reality is, a plan in memory is not a plan. Here's the thing: it fails.") == "Plan it.\n\nA plan in memory is not a plan. It fails."
    assert strip_tics("the reality is what it is") == "the reality is what it is", "mid-sentence use is left alone"
    t, issues = rules_check(good.replace("Every decision", "The reality is, every decision", 1), "", "Pain"); assert "stock phrase removed" in issues and "The reality is" not in t
    assert bridge_check("Episode 1971 this morning. A thought") and not bridge_check("Episode 1971. A thought")
    assert minutes_for("Approved as-is") == 2 and minutes_for("Approved with minor edits") == 5 and minutes_for("Changes requested") == 10
    assert BUSINESS_OD != approval.BUSINESS_PERSONAL and publish.BRANDS[BRAND]["category"] == BRAND
    print(json.dumps({"checks": 40, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("--limit", type=int, default=6); ap.add_argument("--week", default=None); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "mine": mine(a.limit, a.dry_run)
    elif a.mode == "backtest": backtest(a.limit)
    elif a.mode == "draft": draft(a.week, a.dry_run)
    elif a.mode == "cards": raise_cards(a.dry_run)
    elif a.mode == "sync": sync()
    elif a.mode == "publish": publish_posts(a.dry_run)
    elif a.mode == "publish-sync": publish_sync()
    elif a.mode == "points": talking_points(a.week)
    elif a.mode == "report": report()
    else: raise SystemExit("usage: od_lane.py mine|draft|cards|sync|publish|publish-sync|points|backtest|report|selftest")
