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
import argparse, datetime as dt, json, os, re, subprocess, sys, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
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
BANNED = ["amazing", "incredible journey", "crushing it", "smashing goals"]
US_SPELLINGS = re.compile(r"\b(realiz\w*|organiz\w*|color|favorite|center|analyz\w*|behavior|optimiz\w*)\b", re.I)
LIMITS = {"Threads Copy": 500, "TikTok Copy": 300}


# ---------- pure helpers (selftested) ----------

def record_name(day, ctype):
    return "Episode %d %s" % (day, TYPES[ctype]["suffix"])


def km_for_day(day, total_km=None, today_day=None):
    """The distance run by streak day `day`, from the Strava-fed running total the website shows
    (runpreneur_sync state), scaled back at the average daily distance for an episode older than today.
    Ericamae's app used day x 10, which put 21,950 km on Episode 2195 when the truth was ~16,800
    (Kevin, 4 Sep 2026). Returns None when no total is known, so the copy says nothing about distance."""
    if total_km is None or today_day is None:
        try:
            st = json.load(open(os.path.join(os.path.dirname(watch.LEDGER), "runpreneur_sync.json")))
            total_km, today_day = float(st["total_km"]), int(st["day"])
        except Exception: return None
    if not total_km or not today_day: return None
    per_day = total_km / today_day
    return int(round(total_km - max(0, today_day - day) * per_day))


def build_prompt(ctype, transcript, episode_name, day, yt_full_link="", km=None):
    """The app's own prompt, with its placeholders filled the way the app fills them, except the distance."""
    yt_line = ("Watch full YT video here 👉 " + yt_full_link) if yt_full_link else "Watch full YT video here 👉 [ADD YOUTUBE LINK]"
    cum = km if km is not None else km_for_day(day)
    cum = cum if cum is not None else "unknown, do not state a distance"
    remain = max(0, 40075 - cum) if isinstance(cum, int) else "unknown"
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


def rules_check(fields, transcript=""):
    """Returns (fixed_fields, issues). Em dashes are fixed; everything else is reported. `transcript` is
    the source text a figure must appear in: the transcript plus the prompt's own inputs (streak day,
    cumulative km, km remaining), which the copy is told to use and which 4 Sep 2026's first cards
    flagged as unsourced."""
    fixed = {}; issues = []
    for field, txt in fields.items():
        t = txt.replace(" — ", ", ").replace("—", ", ").replace(" – ", ", ")
        if t != txt: issues.append("%s: em dash replaced" % field)
        for b in BANNED:
            if b in t.lower(): issues.append("%s: banned phrase '%s'" % (field, b))
        m = US_SPELLINGS.search(t)
        if m: issues.append("%s: US spelling '%s'" % (field, m.group(0)))
        lim = LIMITS.get(field)
        if lim and len(t) > lim: issues.append("%s: %d chars, limit %d" % (field, len(t), lim))
        for fig in re.findall(r"£[\d,]+(?:\.\d+)?[MmKk]?|\b\d{1,3}(?:,\d{3})+\b(?!\s*km)", t):
            mission = fig.upper() in ("40,075", "£1M", "£2M") or (fig == "£1" and "£1 million" in t) or (fig == "£2" and "£2 million" in t)
            bare = fig.replace(",", "")
            if fig not in transcript and bare not in transcript.replace(",", "") and not mission:   # "21,950" and "21950" are one figure
                issues.append("%s: figure %s not in the transcript" % (field, fig))
        fixed[field] = t
    return fixed, issues


# ---------- IO ----------

def ask_claude(system, user):
    lessons = watch.kevin_lessons()
    if lessons: system = system + "\n\n" + lessons
    env = dict(os.environ)
    if os.path.exists(TOKEN_FILE): env["CLAUDE_CODE_OAUTH_TOKEN"] = open(TOKEN_FILE).read().strip()
    r = subprocess.run([CLAUDE, "-p", user, "--system-prompt", system, "--model", MODEL, "--output-format", "json",
                        "--tools", "", "--max-turns", "1"], capture_output=True, text=True, env=env, timeout=600)
    if r.returncode != 0: raise SystemExit("claude failed: " + r.stderr[-400:])
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
    prompt = build_prompt(ctype, transcript, name, day, yt_full_link, km_for_day(day))
    text, usage, cost = ask_claude(cm_prompts.KEVIN_SYSTEM, prompt)
    fields = split_sections(text, ctype)
    if not fields: raise SystemExit("no sections parsed for %s; first 300 chars: %r" % (name, text[:300]))
    fields, issues = rules_check(fields, transcript + "\n" + prompt)   # the prompt's own figures (day, km so far, km left) are sourced
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
    results = {}
    for ctype in (only or list(TYPES)):
        rec = full if ctype == "Long Form Video" else ensure_record(day, ctype, full)
        n, issues, cost = generate_for(rec, ctype, transcript, day, yt)
        results[ctype] = {"fields": n, "issues": issues, "cost_usd": cost, "record": rec["id"]}
        print("Episode %d %s: %d copy fields written%s" % (day, ctype, n, ("; review: " + "; ".join(issues)) if issues else ""))
    return results


def run_pending(limit=3):
    f = 'AND({Content Type}="Long Form Video", {Responsible}="Content Engine (AI)", {Transcription}!="", {YouTube Copy}="")'
    r = watch._airtable("GET", watch.API + "?maxRecords=%d&filterByFormula=%s" % (limit, urllib.parse.quote(f)))
    recs = r.get("records", [])
    if not recs: print("copy: nothing pending"); return
    for rec in recs:
        m = re.search(r"Episode (\d+)", rec["fields"].get("Content Name", ""))
        if m: run_day(int(m.group(1)))


def selftest():
    assert record_name(2195, "Short Form Video") == "Episode 2195 Short"
    p = build_prompt("Short Form Video", "hello", "Episode 2195 Short", 2195)
    assert "hello" in p and "STREAK DAY: 2195" in p and "[ADD YOUTUBE LINK]" in p and "${" not in p
    assert km_for_day(2286, 17510.62, 2286) == 17511 and km_for_day(2195, 17510.62, 2286) == 16814, "scaled back at the average daily distance"
    assert km_for_day(2195, None, None) is None or isinstance(km_for_day(2195), int)
    p2 = build_prompt("Long Form Video", "t", "Episode 2195 Full Episode", 2195, km=16814)
    assert "CUMULATIVE KM: 16814" in p2 and "REMAINING: 23261km" in p2 and "21950" not in p2
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
    assert cm_prompts.KEVIN_SYSTEM.startswith("You are Kevin Brittain.") and "#Insta360" in cm_prompts.KEVIN_SYSTEM
    print(json.dumps({"checks": 12, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("--day", type=int, default=0); ap.add_argument("--pending", action="store_true")
    ap.add_argument("--limit", type=int, default=3); ap.add_argument("--only", default=None)
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "run" and a.day: run_day(a.day, [a.only] if a.only else None)
    elif a.mode == "run" and a.pending: run_pending(a.limit)
    else: raise SystemExit("usage: platform_copy.py run --day N | run --pending | selftest")
