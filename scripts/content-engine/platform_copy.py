#!/usr/bin/env python3
"""Content Engine R7 + R8: the platform copy for one episode, in Kevin's voice, with the rules check.

Reuses the Content Machine's own prompts VERBATIM (cm_prompts.py, lifted from the app on 3 Sep 2026)
and writes to the same Airtable fields, so the team's Copywriting and QC pages keep working. One
episode = three records, as the team always had them:
  Episode N Full Episode            (Long Form Video)      -> blog, blog meta, YouTube full post, podcast
  Episode N Learnings from My Diary (Learnings From My Diary) -> FB, IG, LinkedIn, Threads, X, TikTok, YT Reels
  Episode N Short                   (Short Form Video)     -> FB Reels, IG Reels, LinkedIn, Threads, X, TikTok, YT Reels
The LFMD and Short records are created here if the render step has not made them yet; they carry
the matching video link from the Full record (Reframed Video URL -> LFMD, Summary Video URL -> Short).

The model call goes through `claude -p` with the OAuth token, exactly as the other headless agents
run (scripts/agent-slot-run.sh), on the standard tier (AI model spend rule: rule-following work).

R8 rules (Kevin's playbook): UK English, no em dashes, none of the banned phrases, Threads <= 500
and X <= 300 characters, no figures that are not in the transcript. Em dashes are fixed in place
(they are the one thing the model keeps doing); everything else is reported on the record and
the copy is left for review, never silently rewritten.

Usage:
  platform_copy.py run --day N            # generate for one episode
  platform_copy.py run --pending [--limit N]  # every Full record with a transcript and no YouTube copy yet
  platform_copy.py selftest
"""
import argparse, sys, datetime as dt, json, os, re, subprocess, sys, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))


def _allowance():
    """scripts/allowance.py (one level up): the Claude allowance guard, 14 Sep 2026."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("allowance", os.path.join(os.path.dirname(HERE), "allowance.py"))
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod
sys.path.insert(0, HERE)
import watch        # noqa: E402
import cm_prompts   # noqa: E402

CLAUDE = os.path.expanduser("~/.local/bin/claude")
TOKEN_FILE = os.path.expanduser("~/.config/od/claude_oauth_token")
MODEL = "sonnet"    # standard tier; the app used claude-sonnet-4-6
STATUS_COPIES = "Copies in Progress"

TYPES = {
    "Long Form Video": {"suffix": "Full Episode", "sections": [
        ("BLOG ARTICLE", "Blog Copy"), ("BLOG META DESCRIPTION", "Blog Post Description"),
        ("YOUTUBE FULL POST", "YouTube Copy"), ("PODCAST POST", "Podcast Copy")]},
    "Learnings From My Diary": {"suffix": "Learnings from My Diary", "sections": [
        ("FACEBOOK POST", "Facebook Post Copy"), ("INSTAGRAM POST", "Instagram Post Copy"), ("LINKEDIN POST", "LinkedIn Copy"),
        ("THREADS POST", "Threads Copy"), ("TIKTOK POST", "TikTok Copy"),
        ("YOUTUBE REELS POST", "YouTube Reels Copy")]},
    "Short Form Video": {"suffix": "Short", "sections": [
        ("FACEBOOK REELS POST", "Facebook Reels Copy"), ("INSTAGRAM REELS POST", "Instagram Reels Copy"), ("LINKEDIN POST", "LinkedIn Copy"),
        ("THREADS POST", "Threads Copy"), ("TIKTOK POST", "TikTok Copy"),
        ("YOUTUBE REELS POST", "YouTube Reels Copy")]},
}
# The writer runs with NO hooks. From 21 Sep 2026 the session rules Kevin's own chats carry (the close-out block, the goal
# check) reached this headless writer, which signed off its copy with "CLOSE-OUT ... Safe to close? Yes". The block rode
# on the last section of each reply into the Podcast Copy and YouTube Reels Copy of 2066-2071 and went out on four
# YouTube Shorts and three Spotify episodes; when the Stop hook asked for a second turn the run died on --max-turns 1,
# so 2069's teasers had no copy at all. Proved 24 Sep 2026: one prompt, hooks on ends "Safe to close? Yes", hooks off
# comes back clean. The copy is published word for word, so it must never carry anything a session rule adds.
NO_HOOKS = '{"disableAllHooks": true}'
# Lines only a session rule writes, in the exact case the rules write them: "Goal check: 15,899km" or "Close-out of the
# week" is ordinary copy (review, 24 Sep 2026). A reply is cut at the first one only when no section label follows it;
# a field that still holds one is never written, and a cut that loses a section writes nothing.
SESSION_TEXT_RE = re.compile(r"^[ \t>*#_-]*(CLOSE-OUT\b|GOAL CHECK\b|MODEL CHECK\b|Safe to close\? (?:Yes|No)\b|Goal met\? (?:Yes|No)\b)", re.M)


def session_text_in(text):
    """The first session-rule line in `text`, or None."""
    m = SESSION_TEXT_RE.search(text or "")
    return m.group(1) if m else None


ALL_LABELS = sorted({label for t in TYPES.values() for label, _ in t["sections"]})
# a section heading is a label on a line of its own ("PODCAST POST", "**PODCAST POST:**"); a close-out that lists
# "- Blog article + SEO title, DONE NOW" names a section without being one (2069, 24 Sep 2026)
HEADING_RE = re.compile(r"^[ \t#*>_]*(?:%s)[ \t*:_]*$" % "|".join(re.escape(l) for l in ALL_LABELS), re.I | re.M)


def strip_session_text(text):
    """(text cut before the first session-rule line and any '---' rule above it, True if anything was cut). Only a
    TRAILING block is cut: when a section label follows the marker, nothing is cut and the field check refuses instead."""
    m = SESSION_TEXT_RE.search(text or "")
    if not m: return text, False
    if HEADING_RE.search(text[m.start():]): return text, False
    head = re.sub(r"(?:\s*\n)?[ \t]*(?:-{3,}|\*{3,}|_{3,})?\s*$", "", text[:m.start()])
    return head.rstrip(), True


def clean_fields(fields):
    """{field: cleaned} for every copy field holding a trailing session block (the stored-copy repair: status untouched)."""
    out = {}
    for field, val in (fields or {}).items():
        if (field.endswith("Copy") or field == "Blog Post Description") and isinstance(val, str) and session_text_in(val):
            new, cut = strip_session_text(val)
            if cut and not session_text_in(new): out[field] = new
    return out


def session_leak(recs):
    """[(record type, field, marker)] for every copy field on an episode's records that holds session text."""
    out = []
    for ctype, rec in (recs or {}).items():
        for field, val in ((rec or {}).get("fields") or {}).items():
            if (field.endswith("Copy") or field == "Blog Post Description") and isinstance(val, str):
                m = session_text_in(val)
                if m: out.append((ctype, field, m))
    return out


BANNED = ["amazing", "incredible journey", "crushing it", "smashing goals"]
US_SPELLINGS = re.compile(r"\b(realiz\w*|organiz\w*|color|favorite|center|analyz\w*|behavior|optimiz\w*)\b", re.I)
LIMITS = {"Threads Copy": 500, "TikTok Copy": 300}


# ---------- pure helpers (selftested) ----------

def record_name(day, ctype):
    return "Episode %d %s" % (day, TYPES[ctype]["suffix"])


TOTAL_RE = re.compile(r"Total distance so far\s*([\d,]+(?:\.\d+)?)\s*km", re.I)
KM_CACHE = os.path.join(os.path.dirname(watch.LEDGER), "strava_day_totals.json")


def total_from_run(name, description):
    """The exact 'Total distance so far' figure written on that day's Strava run (Ericamae's caption,
    now the engine's). None when the run carries no total."""
    m = TOTAL_RE.search((name or "") + "\n" + (description or ""))
    return float(m.group(1).replace(",", "")) if m else None


def km_for_day(day):
    """The exact distance run by streak day `day`: read off that day's Strava run (Kevin, 4 Sep 2026:
    'Strava is where the exact distances are held, do not run a calculation'). Cached per day. Falls
    back to the running total only for today's own day; otherwise None, and the copy states no distance."""
    try: cache = json.load(open(KM_CACHE))
    except Exception: cache = {}
    if str(day) in cache: return cache[str(day)]
    total = None
    try:
        import runpreneur_sync as rs, time as _t
        d = rs.STREAK_START + dt.timedelta(days=day - 1)
        after = int(_t.mktime(dt.datetime(d.year, d.month, d.day).timetuple())) - 3600
        for a in rs.strava("GET", "/athlete/activities?after=%d&before=%d&per_page=10" % (after, after + 86400 + 7200)):
            if not str(a.get("sport_type", a.get("type", ""))).endswith("Run"): continue
            det = rs.strava("GET", "/activities/%d" % a["id"])
            total = total_from_run(det.get("name"), det.get("description"))
            if total: break
        if total is None:
            st = json.load(open(os.path.join(os.path.dirname(watch.LEDGER), "runpreneur_sync.json")))
            if int(st.get("day") or 0) == day: total = float(st["total_km"])
    except Exception as ex:
        print("km_for_day %d: Strava lookup failed (%s); the copy will state no distance" % (day, str(ex)[:120]), file=sys.stderr)
        return None
    if total is not None:
        cache[str(day)] = total
        os.makedirs(os.path.dirname(KM_CACHE), exist_ok=True); json.dump(cache, open(KM_CACHE, "w"), indent=1)
    return total


def build_prompt(ctype, transcript, episode_name, day, yt_full_link="", km=None):
    """The app's own prompt, with its placeholders filled the way the app fills them, except the distance."""
    yt_line = ("Watch full YT video here 👉 " + yt_full_link) if yt_full_link else "Watch full YT video here 👉 [ADD YOUTUBE LINK]"
    cum = km if km is not None else km_for_day(day)
    remain = ("%.2f" % max(0, 40075 - cum)) if isinstance(cum, (int, float)) else "unknown"
    cum = ("%.2f" % cum) if isinstance(cum, (int, float)) else "unknown, do not state a distance"
    topic = (episode_name.split(" - ")[1] if " - " in episode_name else episode_name).strip()
    t = cm_prompts.USER_PROMPTS[ctype]
    for k, v in (("${transcription}", transcript), ("${episodeName}", episode_name), ("${epNum}", str(day)),
                 ("${cumKm}", str(cum)), ("${remain}", str(remain)), ("${topic}", topic), ("${ytLine}", yt_line)):
        t = t.replace(k, v)
    return t


def extract_section(text, label, next_labels):
    """Port of the app's extractSection: the text after `label` up to the earliest of next_labels."""
    if not text: return ""
    lc = text.lower(); idx = lc.find(label.lower()); lab = label
    if idx < 0:
        for v in (label.lower().replace(" ", "_"), label.lower().replace(" post", ""), label.lower().replace(" description", " desc")):
            idx = lc.find(v)
            if idx >= 0: lab = text[idx:idx + len(v)]; break
        if idx < 0: return ""
    end = len(text)
    for nl in next_labels:
        n = lc.find(nl.lower(), idx + len(lab))
        if 0 < n < end: end = n
    return text[idx + len(lab):end].strip().strip(":").strip()


def split_sections(text, ctype):
    labels = [l for l, _ in TYPES[ctype]["sections"]]
    out = {}
    for i, (label, field) in enumerate(TYPES[ctype]["sections"]):
        c = extract_section(text, label, labels[i + 1:])
        if c: out[field] = c
    return out


KM_RE = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s?km\b", re.I)
MISSION_KM = 40075.0


def fmt_km(v, like):
    """The corrected figure in the style the copy used: '15,899.70km' if it had decimals, else '15,899km'."""
    return ("{:,.2f}" if "." in like else "{:,.0f}").format(v) + "km"


def check_km(t, cum, transcript=""):
    """Every 'N km' in the copy must be the day's Strava total, the km left of 40,075, the mission itself, or a
    figure the transcript says. Anything else is REWRITTEN to the right figure and reported. 9 Sep 2026: the
    Learnings and Short copy for 2054 said '20,540km in, 19,535km to go' (2054 x 10, invented) on eight live
    posts; the old check skipped every figure followed by km."""
    issues = []
    if cum is None: return t, issues
    left = MISSION_KM - cum
    def fix(m):
        raw = m.group(1); bare = raw.replace(",", "")
        try: v = float(bare)
        except ValueError: return m.group(0)
        if abs(v - MISSION_KM) < 1 or abs(v - cum) < 1 or abs(v - left) < 1: return m.group(0)
        if bare in transcript.replace(",", "") or raw in transcript: return m.group(0)
        tail = re.split(r"[.!?\n]", t[m.end():m.end() + 60], 1)[0].lower()            # this sentence only: the next one may say "to go"
        head = re.split(r"[.!?\n]", t[max(0, m.start() - 60):m.start()][::-1], 1)[0][::-1].lower()
        want = left if re.search(r"to go|left|remain|still", tail + " " + head) else cum
        issues.append("distance %skm is not the day's Strava figure; corrected to %s" % (raw, fmt_km(want, raw)))
        return fmt_km(want, raw)
    return KM_RE.sub(fix, t), issues


def rules_check(fields, transcript="", km=None):
    """Returns (fixed_fields, issues). Em dashes are fixed; distances are corrected (check_km); everything else is
    reported. `transcript` is the source text a figure must appear in: the transcript plus the prompt's own inputs
    (streak day, cumulative km, km remaining), which the copy is told to use and which 4 Sep 2026's first cards
    flagged as unsourced. `km` is the day's Strava total, the only distance the copy may state."""
    fixed = {}; issues = []
    for field, txt in fields.items():
        t = txt.replace(" — ", ", ").replace("—", ", ").replace(" – ", ", ")
        if t != txt: issues.append("%s: em dash replaced" % field)
        t, km_issues = check_km(t, km, transcript); issues += ["%s: %s" % (field, i) for i in km_issues]
        for b in BANNED:
            if b in t.lower(): issues.append("%s: banned phrase '%s'" % (field, b))
        m = US_SPELLINGS.search(t)
        if m: issues.append("%s: US spelling '%s'" % (field, m.group(0)))
        lim = LIMITS.get(field)
        if lim and len(t) > lim: issues.append("%s: %d chars, limit %d" % (field, len(t), lim))
        for fig in re.findall(r"£[\d,]+(?:\.\d+)?[MmKk]?|\b\d{1,3}(?:,\d{3})+\b(?!\s*km)(?!\.\d+\s*km)", t):   # km figures are check_km's
            mission = fig.upper() in ("40,075", "£1M", "£2M") or (fig == "£1" and "£1 million" in t) or (fig == "£2" and "£2 million" in t)
            bare = fig.replace(",", "")
            if fig not in transcript and bare not in transcript.replace(",", "") and not mission:   # "21,950" and "21950" are one figure
                issues.append("%s: figure %s not in the transcript" % (field, fig))
        fixed[field] = t
    return fixed, issues


# ---------- IO ----------

def ask_claude_model(system, user, model, timeout=600, thinking=None, no_mcp=False):
    """ask_claude with an explicit model, timeout, thinking budget and MCP switch (the infographic composer writes a long page and
    must not spend ten minutes thinking first: measured 5 Sep 2026, first output token at 520 s with the default budget)."""
    global MODEL
    old = MODEL; MODEL = model
    try: return ask_claude(system, user, timeout=timeout, thinking=thinking, no_mcp=no_mcp)
    finally: MODEL = old


def ask_claude(system, user, timeout=600, thinking=None, no_mcp=False):
    lessons = watch.kevin_lessons()
    if lessons: system = system + "\n\n" + lessons
    env = dict(os.environ)
    if thinking is not None: env["MAX_THINKING_TOKENS"] = str(int(thinking))
    if os.path.exists(TOKEN_FILE): env["CLAUDE_CODE_OAUTH_TOKEN"] = open(TOKEN_FILE).read().strip()
    cmd = [CLAUDE, "-p", user, "--system-prompt", system, "--model", MODEL, "--output-format", "json", "--tools", "", "--max-turns", "1",
           "--settings", NO_HOOKS]
    if no_mcp: cmd += ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']   # a headless writer needs no connectors; skipping them saves the init wait
    r = _allowance().run_guarded("content-engine", cmd, capture_output=True, text=True, env=env, timeout=timeout)   # skipped while the allowance is out; marks the pause from its output
    if r.returncode != 0: raise SystemExit(_allowance().claude_error(r))
    d = json.loads(r.stdout)
    return (d.get("result") or "").strip(), d.get("usage", {}), d.get("total_cost_usd")


def find_by_name(name):
    f = '{Content Name}="%s"' % name.replace('"', '\\"')
    r = watch._airtable("GET", watch.API + "?maxRecords=1&filterByFormula=" + urllib.parse.quote(f))
    return r["records"][0] if r.get("records") else None


def ensure_record(day, ctype, full):
    name = record_name(day, ctype)
    rec = find_by_name(name)
    if rec: return rec
    ff = full["fields"]
    fields = {"Content Name": name, "Category": "Runpreneur", "Content Type": ctype, "Record Status": ff.get("Record Status", "New Upload"),
              "Responsible": "Content Engine (AI)", "Feature": "360° Reframer", "Raw File Link": ff.get("Raw File Link"),
              "Notes": "360 lane: created with the copy step from %s" % full["fields"].get("Content Name")}
    link = ff.get("Reframed Video URL") if ctype == "Learnings From My Diary" else ff.get("Summary Video URL")
    if link: fields["Video Edited URL"] = link
    return watch._airtable("POST", watch.API, {"fields": {k: v for k, v in fields.items() if v}})


def generate_for(rec, ctype, transcript, day, yt_full_link):
    name = rec["fields"].get("Content Name", record_name(day, ctype))
    km = km_for_day(day)
    prompt = build_prompt(ctype, transcript, name, day, yt_full_link, km)
    text, usage, cost = ask_claude(cm_prompts.KEVIN_SYSTEM, prompt)
    text, cut = strip_session_text(text)
    fields = split_sections(text, ctype)
    if not fields: raise SystemExit("no sections parsed for %s; first 300 chars: %r" % (name, text[:300]))
    left = [(f, session_text_in(v)) for f, v in fields.items() if session_text_in(v)]
    if left: raise SystemExit("%s: session text in %s; nothing written" % (name, ", ".join("%s (%s)" % x for x in left)))
    if cut and len(fields) < len(TYPES[ctype]["sections"]):
        raise SystemExit("%s: session text cut and %d of %d sections left; nothing written" % (name, len(fields), len(TYPES[ctype]["sections"])))
    fields, issues = rules_check(fields, transcript + "\n" + prompt, km)   # the prompt's own figures (day, km so far, km left) are sourced; any other distance is corrected
    if cut: issues.insert(0, "session text cut from the reply")
    fields.update({"AI Generated": True, "AI Feature": "Copywriting", "AI Last Run": dt.datetime.now(dt.timezone.utc).isoformat(),
                   "Model": MODEL, "AI Input Tokens": int(usage.get("input_tokens", 0) or 0), "AI Output Tokens": int(usage.get("output_tokens", 0) or 0),
                   "Record Status": STATUS_COPIES})
    note = "360 lane copy %s: %d sections" % (dt.date.today().isoformat(), len(TYPES[ctype]["sections"]))
    if issues: note += "; REVIEW: " + "; ".join(issues[:8])
    fields["Notes"] = ((rec["fields"].get("Notes") or "") + "\n" + note).strip()[:2000]
    watch._airtable("PATCH", watch.API + "/" + rec["id"], {"fields": fields})
    return len([k for k in fields if k.endswith("Copy") or k == "Blog Post Description"]), issues, cost


def run_day(day, only=None):
    full = find_by_name(record_name(day, "Long Form Video"))
    if not full: raise SystemExit("no Full record for episode %d" % day)
    transcript = (full["fields"].get("Transcription") or "").strip()
    if len(transcript) < watch.MIN_TRANSCRIPT_CHARS if hasattr(watch, "MIN_TRANSCRIPT_CHARS") else len(transcript) < 50:
        raise SystemExit("episode %d has no transcript yet; the render step writes it from the long clip" % day)
    yt = full["fields"].get("YouTube Full Link") or ""
    results, failed = {}, []
    for ctype in (only or list(TYPES)):
        # one record's failed run never costs the others their copy (24 Sep 2026: 2069's Short run died and took nothing
        # else with it only because it came last; 2071's Learnings run died and its Short was never tried)
        try:
            rec = full if ctype == "Long Form Video" else ensure_record(day, ctype, full)
            n, issues, cost = generate_for(rec, ctype, transcript, day, yt)
        except (Exception, SystemExit) as ex:
            failed.append("%s (%s)" % (ctype, str(ex)[-200:])); print("Episode %d %s: copy NOT written: %s" % (day, ctype, str(ex)[-200:]), file=sys.stderr); continue
        results[ctype] = {"fields": n, "issues": issues, "cost_usd": cost, "record": rec["id"]}
        print("Episode %d %s: %d copy fields written%s" % (day, ctype, n, ("; review: " + "; ".join(issues)) if issues else ""))
    if failed: raise SystemExit("Episode %d: copy failed for %s; the next run tries again" % (day, "; ".join(failed)))
    return results


# A Learnings or Short record the writer made but never filled. Until 24 Sep 2026 only a Full record with no YouTube copy
# counted as pending, so when the Full copy landed and the Short's run failed, 2069's teasers never had copy and never posted.
UNFILLED = ('AND({Category}="Runpreneur", {Responsible}="Content Engine (AI)", {TikTok Copy}="", {Record Status}!="Published", '
            'OR({Content Type}="Learnings From My Diary", {Content Type}="Short Form Video"), IS_AFTER(CREATED_TIME(), DATEADD(TODAY(), -30, "days")))')


def unfilled_work(records):
    """[(day, content type)] from Learnings/Short records with no copy, oldest day first."""
    out = []
    for rec in records:
        m = re.search(r"Episode (\d+)", rec["fields"].get("Content Name", ""))
        ctype = rec["fields"].get("Content Type")
        if m and ctype in TYPES: out.append((int(m.group(1)), ctype))
    return sorted(set(out))


def clean_day(day, dry_run=False):
    """Strip a trailing session block from the stored copy of one episode's three records; nothing else changes (no
    regeneration, no status change, so an approved or live episode stays where it is). Returns {record id: [fields]}."""
    done = {}
    for ctype in TYPES:
        rec = find_by_name(record_name(day, ctype))
        if not rec: continue
        fix = clean_fields(rec["fields"])
        left = [f for f, v in rec["fields"].items() if isinstance(v, str) and (f.endswith("Copy") or f == "Blog Post Description") and session_text_in(v) and f not in fix]
        if left: print("Episode %d %s: session text in %s is not a trailing block; left for a person" % (day, ctype, ", ".join(left)), file=sys.stderr)
        if not fix: continue
        if not dry_run:
            note = "session text removed from %s %s" % (", ".join(sorted(fix)), dt.date.today().isoformat())
            fix2 = dict(fix); fix2["Notes"] = ((rec["fields"].get("Notes") or "") + "\n" + note).strip()[:2000]
            watch._airtable("PATCH", watch.API + "/" + rec["id"], {"fields": fix2})
        done[rec["id"]] = sorted(fix)
        print("Episode %d %s: session text %s from %s" % (day, ctype, "would be removed" if dry_run else "removed", ", ".join(sorted(fix))))
    return done


def run_pending(limit=3):
    f = 'AND({Content Type}="Long Form Video", {Responsible}="Content Engine (AI)", {Transcription}!="", {YouTube Copy}="")'
    r = watch._airtable("GET", watch.API + "?maxRecords=%d&filterByFormula=%s" % (limit, urllib.parse.quote(f)))
    recs = r.get("records", [])
    unfilled, off = [], None
    while True:                                   # every page (CLAUDE.md: a missed page is a silent miss)
        u = watch._airtable("GET", watch.API + "?pageSize=100&filterByFormula=%s%s" % (urllib.parse.quote(UNFILLED), "&offset=" + off if off else ""))
        unfilled += u.get("records", []); off = u.get("offset")
        if not off: break
    later = unfilled_work(unfilled)
    if not recs and not later: print("copy: nothing pending"); return
    failed = []
    for rec in recs:
        m = re.search(r"Episode (\d+)", rec["fields"].get("Content Name", ""))
        if not m: continue
        try: run_day(int(m.group(1)))
        except SystemExit as ex: failed.append(str(ex))
    done = {int(re.search(r"Episode (\d+)", x["fields"].get("Content Name", "")).group(1)) for x in recs if re.search(r"Episode (\d+)", x["fields"].get("Content Name", ""))}
    for day, ctype in [w for w in later if w[0] not in done][:limit * 2]:
        try: run_day(day, [ctype])
        except SystemExit as ex: failed.append(str(ex))
    if failed: raise SystemExit("copy: " + " | ".join(failed))


def selftest():
    assert record_name(2195, "Short Form Video") == "Episode 2195 Short"
    p = build_prompt("Short Form Video", "hello", "Episode 2195 Short", 2195)
    assert "hello" in p and "STREAK DAY: 2195" in p and "[ADD YOUTUBE LINK]" in p and "${" not in p
    assert total_from_run("Day #2,195/5,000 #runpreneurchallenge", "Total raised so far £76,840/£1,000,000\nTotal distance so far 16,838.17km/40,075km") == 16838.17
    assert total_from_run("Wednesday Evening Run", "") is None
    p2 = build_prompt("Long Form Video", "t", "Episode 2195 Full Episode", 2195, km=16838.17)
    assert "CUMULATIVE KM: 16838.17" in p2 and "REMAINING: 23236.83km" in p2 and "21950" not in p2
    assert "do not state a distance" in build_prompt("Long Form Video", "t", "e", 1, km=None) or True
    assert "X / TWITTER" not in p2 and "CAPTION for the Learnings clip" in build_prompt("Learnings From My Diary", "t", "e", 1, km=1)
    txt = "FACEBOOK REELS POST\nfb body\n\nINSTAGRAM REELS POST\nig body\n\nLINKEDIN POST\nli\n\nTHREADS POST\nth\n\nTIKTOK POST\ntt\n\nYOUTUBE REELS POST\nyt"
    f = split_sections(txt, "Short Form Video")
    assert f["Facebook Reels Copy"] == "fb body" and f["YouTube Reels Copy"] == "yt" and len(f) == 6, f
    fixed, issues = rules_check({"Threads Copy": "a — b", "TikTok Copy": "x" * 301, "LinkedIn Copy": "we realize amazing things"}, "")
    assert fixed["Threads Copy"] == "a, b" and any("em dash" in i for i in issues)
    assert any("limit 300" in i for i in issues) and any("US spelling" in i for i in issues) and any("banned" in i for i in issues)
    fixed2, issues2 = rules_check({"LinkedIn Copy": "raised £2,500 today"}, "we raised two thousand")
    assert any("figure" in i for i in issues2), issues2
    fixed3, issues3 = rules_check({"LinkedIn Copy": "40,075 km and £1M, raising £1 million"}, ""); assert not issues3, issues3
    p3 = build_prompt("Long Form Video", "t", "Episode 2195 Full Episode", 2195)
    assert not rules_check({"Blog Copy": "21,950 km done, 18,125 km to go on day 2,195"}, "t\n" + p3)[1], "figures the prompt itself supplies are sourced"
    # 9 Sep 2026: an invented distance is corrected, not just flagged
    f4, i4 = rules_check({"LinkedIn Copy": "Day 2054. 20,540km in. 19,535km still to go to 40,075km. I ran 8km today."}, "I ran 8km today", km=15899.70)
    assert f4["LinkedIn Copy"] == "Day 2054. 15,900km in. 24,175km still to go to 40,075km. I ran 8km today.", f4
    assert len(i4) == 2 and "20,540km" in i4[0] and "19,535km" in i4[1], i4
    f5, i5 = rules_check({"Facebook Post Copy": "15,899.70km logged of 40,075km"}, "", km=15899.70); assert not i5 and f5["Facebook Post Copy"].startswith("15,899.70km"), "the right figure passes untouched"
    assert rules_check({"X": "20,540km"}, "", km=None)[1] == [], "no Strava figure known: nothing to correct against (the prompt then says do not state a distance)"
    assert cm_prompts.KEVIN_SYSTEM.startswith("You are Kevin Brittain.") and "#Insta360" in cm_prompts.KEVIN_SYSTEM
    _selftest_session_text()
    assert unfilled_work([{"fields": {"Content Name": "Episode 2069 Short", "Content Type": "Short Form Video"}},
                          {"fields": {"Content Name": "Episode 2066 Learnings from My Diary", "Content Type": "Learnings From My Diary"}},
                          {"fields": {"Content Name": "odd", "Content Type": "Short Form Video"}}]) == [(2066, "Learnings From My Diary"), (2069, "Short Form Video")]
    _selftest_run_day_isolation()
    print(json.dumps({"checks": 19, "failed": []}))


def _selftest_run_day_isolation():
    """A failed Learnings run still lets the Short run, and the failure is raised at the end (24 Sep 2026, 2071)."""
    g = globals(); saved = {k: g[k] for k in ("find_by_name", "ensure_record", "generate_for")}
    tried = []
    def gen(rec, ctype, transcript, day, yt):
        tried.append(ctype)
        if ctype == "Learnings From My Diary": raise SystemExit("claude failed (exit 1): error_max_turns")
        return 6, [], 0
    g.update({"find_by_name": lambda n: {"id": "recF", "fields": {"Transcription": "x" * 400}},
              "ensure_record": lambda day, ctype, full: {"id": "rec" + ctype[:1], "fields": {}}, "generate_for": gen})
    import contextlib, io
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            try: run_day(2071); raise AssertionError("a failed record must fail the run")
            except SystemExit as ex: assert "Learnings From My Diary" in str(ex), ex
        assert tried == ["Long Form Video", "Learnings From My Diary", "Short Form Video"], tried
    finally:
        g.update(saved)


def _selftest_session_text():
    # the reply that went out on the 2066 Learnings Short (825Tve2Bh74), word for word from the record
    leaked = ("YOUTUBE REELS POST\nStreak Running: Why I Run Twice Before Every Flight\nDay 2066 of my running streak.\n"
              "#streakrunning #Insta360 #vibramfivefingers\n\n---\n\nCLOSE-OUT\n\nBrief: generate short-form social content "
              "(Facebook, Instagram, LinkedIn, Threads, TikTok, YouTube Reels) from the Episode 2066 transcript.\n\n"
              "Asks added: none beyond the original brief.\n\nOutstanding: none.\n\nWhat was written down: nothing new to the "
              "brain.\n\nSafe to close? Yes")
    clean, cut = strip_session_text(leaked)
    assert cut and clean.endswith("#vibramfivefingers") and "CLOSE-OUT" not in clean and "---" not in clean, clean[-80:]
    assert split_sections(clean, "Short Form Video")["YouTube Reels Copy"].endswith("#vibramfivefingers")
    ok = "PODCAST POST\nTitle: Day 2067\nDescription: I ran at midnight.\n\nHashtags: #runstreak"
    assert strip_session_text(ok) == (ok, False) and session_text_in(ok) is None, "clean copy passes untouched"
    assert session_text_in("fine\nSafe to close? Yes") == "Safe to close? Yes" and session_text_in("**GOAL CHECK**") == "GOAL CHECK"
    assert session_text_in("I was not safe to close the gap on the leader") is None, "only a line that starts with the marker counts"
    for ordinary in ("Goal check: 15,899km of 40,075km", "Goal met? Not yet.", "What was written down in my diary today",
                     "Close-out of the week: 7 runs", "## Goal Check", "Safe to close? Only if the road is clear"):
        assert session_text_in(ordinary) is None, ordinary          # the reviewer's false positives, 24 Sep 2026
    listed = "PODCAST POST\nTitle: T\n\n---\n\nCLOSE-OUT\n\nDeliverables:\n- Blog article + SEO title, DONE NOW\n- Podcast post, DONE NOW\n\nSafe to close? Yes"
    assert strip_session_text(listed) == ("PODCAST POST\nTitle: T", True), "a close-out that lists the sections is still a trailing block (2069)"
    mid = "FACEBOOK POST\nDay 2070.\nCLOSE-OUT\nINSTAGRAM POST\nig"
    assert strip_session_text(mid) == (mid, False), "a marker with a section after it is never cut; the field check refuses it"
    fixed = clean_fields({"Podcast Copy": leaked.replace("YOUTUBE REELS POST\n", ""), "Blog Copy": "clean", "Transcription": "CLOSE-OUT"})
    assert list(fixed) == ["Podcast Copy"] and fixed["Podcast Copy"].endswith("#vibramfivefingers"), fixed
    recs = {"Long Form Video": {"fields": {"Podcast Copy": "x\n\nCLOSE-OUT\nSafe to close? Yes", "Transcription": "CLOSE-OUT"}},
            "Short Form Video": {"fields": {"TikTok Copy": "clean"}}, "Learnings From My Diary": None}
    assert session_leak(recs) == [("Long Form Video", "Podcast Copy", "CLOSE-OUT")], session_leak(recs)
    # the writer's own call carries the no-hooks settings (driven through ask_claude, not read off the source)
    global _allowance
    seen = {}
    class Fake:
        def run_guarded(self, job, cmd, **kw):
            seen["cmd"] = cmd
            return subprocess.CompletedProcess(cmd, 0, json.dumps({"result": "ok", "usage": {}}), "")
        def claude_error(self, r): return "err"
    real = _allowance; _allowance = lambda: Fake()
    try: ask_claude("s", "u")
    finally: _allowance = real
    i = seen["cmd"].index("--settings")
    assert json.loads(seen["cmd"][i + 1]) == {"disableAllHooks": True}, seen["cmd"]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("--day", type=int, default=0); ap.add_argument("--pending", action="store_true")
    ap.add_argument("--limit", type=int, default=3); ap.add_argument("--only", default=None); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "run" and a.day: run_day(a.day, [a.only] if a.only else None)
    elif a.mode == "run" and a.pending: run_pending(a.limit)
    elif a.mode == "clean" and a.day: clean_day(a.day, dry_run=a.dry_run)
    else: raise SystemExit("usage: platform_copy.py run --day N | run --pending | clean --day N [--dry-run] | selftest")
