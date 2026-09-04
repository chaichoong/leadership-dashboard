#!/usr/bin/env python3
"""approval.py — R9 of the Content Engine's Runpreneur 360 lane: the approval card.

One card per finished episode, in the same queue as every other agent's work
(Tasks: Status Approval + Sent For Approval By = the Content Engine), so the
08:00 approvals digest counts it and Kevin decides on the AI Agents page.
Nothing is published by this script, ever.

  run --pending   every Full Episode record at "Copies in Progress" whose video,
                  thumbnail and copy are all in, and that has no card yet:
                  build the write-up -> create the task through the duplicate
                  gate -> submit it for approval -> record "Quality Control".
  sync            read Kevin's verdicts on open cards and write them onto the
                  episode record: Approved -> "Approved for Publishing";
                  Rejected / Changes requested -> his words into Feedback.
                  The publishing step reads "Approved for Publishing".
  card --day N    print the write-up for one episode (nothing created).
  report          one line for the morning digest.

Why the gate is called with --force: the duplicate key strips numbers as
reference noise, so "Publish Episode 2225" and "Publish Episode 2226" share a
key and the second card would fold into the first. Here the number IS the
identity, so this script does its own exact-name check (with a control) and
tells the gate to create.

State: ~/knowledge-os/logs/content-engine/approvals.json (episode -> task,
record, verdict). The repo is public; nothing about Kevin's decisions lives in it.
"""
import argparse, datetime as dt, json, os, re, subprocess, sys, tempfile, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import watch  # noqa: E402
import platform_copy as pc  # noqa: E402

REPO = os.path.dirname(os.path.dirname(HERE))
GATE = os.path.join(REPO, "scripts", "create-agent-task.py")
DISPATCH = os.path.join(REPO, "scripts", "agent-dispatch.py")
TASKS_API = "https://api.airtable.com/v0/%s/tblqB8b22hKBL4PF1" % watch.BASE
STATE = os.path.join(os.path.dirname(watch.LEDGER), "approvals.json")

AGENT_TM = "recRcy1Edas6rGaaF"          # Team Members row "AI Content Engine" (register row recNaC0N5KiTGBPNy)
BUSINESS_PERSONAL = "reclAPC2vMx2Umuzb"  # every Runpreneur task on the board sits under Personal (read 3 Sep 2026)
TF = {"name": "fldgFjGBw6bTKJFCD", "desc": "fldRGhBQViKZKtkQ6", "status": "fldx4qCw17UfrKpaN", "team": "flduCtmQGpOA4eWaj",
      "priority": "fldS21RwmwOqt71LI", "due": "fld7XP8w8kbxfETV4", "business": "fldLu1Y4GzyWcDoxr", "notes": "fldR7apBzSp3oxFxz",
      "sentBy": "fld30Yw8SWYVp049g", "outcome": "fldrHBSr6qoUfaKuZ", "feedback": "fldtI7SJI4gEohHD1", "approvedAt": "fldr4Mvf2RzKvhZhi"}
STATUS_READY, STATUS_QC, STATUS_APPROVED = "Copies in Progress", "Quality Control", "Approved for Publishing"
APPROVED = ("Approved as-is", "Approved with minor edits")
SOCIALS = "Facebook, Instagram, LinkedIn, Threads, TikTok and YouTube Shorts"
CLOSING = "**Carrying this out will involve:**"
TASK_TYPE = "Drafting"


# ---------- pure (selftested) ----------

def task_name(day, headline=""):
    return "CONTENT: Publish Episode %d of Diary of a Runpreneur%s" % (day, (" - " + headline) if headline else "")


def headline_for(day, ledger):
    """The thumbnail's two lines, if the render kept them on the ledger; otherwise nothing."""
    for e in ledger.values():
        if e.get("episode") == day and e.get("thumb_lines"):
            l1, l2 = e["thumb_lines"][0], e["thumb_lines"][1]
            return (l1 + (" / " + l2 if l2 else "")).strip()
    return ""


def is_ready(full_fields):
    """A card needs the three things Kevin judges: the video, the thumbnail and the copy."""
    f = full_fields
    return (f.get("Record Status") == STATUS_READY and bool(f.get("Video Edited URL")) and bool(f.get("Thumbnail URL"))
            and bool((f.get("YouTube Copy") or "").strip()))


def copy_block(label, fields, sections):
    lines = []
    for heading, field in sections:
        text = (fields.get(field) or "").strip()
        if text:
            lines.append("%s\n%s" % (heading.title(), text))
    return ("%s\n\n%s" % (label, "\n\n".join(lines))) if lines else "%s\nNo copy written yet." % label


def build_card(day, full, lfmd=None, short=None, headline=""):
    """The write-up. Kevin's rule: the ask in one line first, everything else after, and the
    closing 'Carrying this out will involve:' line so the queue can show what approval does."""
    f = full.get("fields", {}); lf = (lfmd or {}).get("fields", {}); sf = (short or {}).get("fields", {})
    title = ' "%s"' % headline if headline else ""
    ask = "Publish Episode %d of Diary of a Runpreneur%s: the full episode to YouTube, the Summary and the Learnings clip to %s." % (day, title, SOCIALS)
    watch_lines = ["- Full episode (16:9, captions): %s" % f.get("Video Edited URL")]
    if f.get("Reframed Video URL"): watch_lines.append("- Learnings from my diary (9:16): %s" % f["Reframed Video URL"])
    else: watch_lines.append("- Learnings from my diary: not found in this episode's transcript, so no clip")
    if f.get("Summary Video URL"): watch_lines.append("- Summary teaser (9:16): %s" % f["Summary Video URL"])
    else: watch_lines.append("- Summary teaser: no teaser clip was recorded for this day")
    watch_lines.append("- Thumbnail: %s" % f.get("Thumbnail URL"))
    where = ["- YouTube: the full episode with this thumbnail and the YouTube copy.",
             "- %s: the Summary and the Learnings clip, each with its own copy, scheduled through GoHighLevel on the Runpreneur account." % SOCIALS,
             "- Blog and podcast: the blog article and podcast copy below, once their publishers are connected."]
    copy = [copy_block("FULL EPISODE (YouTube, blog, podcast)", f, pc.TYPES["Long Form Video"]["sections"]),
            copy_block("LEARNINGS FROM MY DIARY (socials)", lf, pc.TYPES["Learnings From My Diary"]["sections"]),
            copy_block("SUMMARY (socials)", sf, pc.TYPES["Short Form Video"]["sections"])]
    review = []
    for rec in (full, lfmd, short):
        note = ((rec or {}).get("fields", {}).get("Notes") or "")
        m = re.search(r"review: (.+)", note)
        if m: review.append(m.group(1).strip())
    checks = ("Rules check flagged: " + " | ".join(review)) if review else "Rules check: nothing flagged (UK English, no em dashes, no figures that are not in the transcript)."
    closing = closing_line(publish_mode())
    out = "\n\n".join([ask, "Watch before you approve:\n" + "\n".join(watch_lines), "Where it goes if you approve:\n" + "\n".join(where),
                       "The copy, as written:\n\n" + "\n\n".join(copy), checks, closing])
    desc = ("Approve Episode %d for publishing. The Content Engine rendered the three videos, wrote the platform copy "
            "and made the thumbnail from the raw 360 clip. Nothing is published until you approve." % day)
    return task_name(day, headline), desc, out


def publish_mode():
    try:
        import publish; return publish.mode()
    except Exception: return "test"


def closing_line(m):
    if m == "live":
        return ("%s uploading the full episode to YouTube with this thumbnail and copy tomorrow at 06:00, then the day after, "
                "scheduling the Summary and Learnings clips with their copy on %s through GoHighLevel." % (CLOSING, SOCIALS))
    return ("%s TEST MODE: uploading the full episode to YouTube as UNLISTED (only people with the link can see it) with this thumbnail and copy, "
            "then creating the Summary and Learnings posts for %s as DRAFTS in the GoHighLevel planner for you to open and check. "
            "Nothing reaches a public feed until you switch the engine to live." % (CLOSING, SOCIALS))


def verdict_patch(outcome, feedback, when):
    """What Kevin's verdict does to the episode record. Approved moves it on; anything else keeps his words."""
    stamp = (when or dt.date.today().isoformat())[:10]
    if outcome in APPROVED:
        return {"Record Status": STATUS_APPROVED, "Notes": "Approved by Kevin %s (%s)." % (stamp, outcome)}, "approved"
    words = (feedback or "").strip()
    if outcome == "Rejected":
        return {"Feedback": words or "Rejected without a reason", "Notes": "Rejected by Kevin %s: %s" % (stamp, words or "no reason given")}, "rejected"
    return {"Feedback": words or "Changes requested without a note", "Notes": "Changes requested by Kevin %s: %s" % (stamp, words or "no note")}, "changes"


# ---------- state ----------

def load_state():
    if os.path.exists(STATE):
        with open(STATE) as fh: return json.load(fh)
    return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as fh: json.dump(state, fh, indent=1, sort_keys=True)
    os.replace(tmp, STATE)


# ---------- Airtable ----------

def bundle(day):
    return {ctype: pc.find_by_name(pc.record_name(day, ctype)) for ctype in pc.TYPES}


def pending(limit):
    f = ('AND({Content Type}="Long Form Video", {Responsible}="Content Engine (AI)", {Record Status}="%s", '
         '{Video Edited URL}!="", {Thumbnail URL}!="", {YouTube Copy}!="")' % STATUS_READY)
    r = watch._airtable("GET", watch.API + "?maxRecords=%d&filterByFormula=%s" % (limit, urllib.parse.quote(f)))
    days = []
    for rec in r.get("records", []):
        m = re.search(r"Episode (\d+)", rec["fields"].get("Content Name", ""))
        if m: days.append(int(m.group(1)))
    return days


def existing_task(name):
    """Exact-name existence check, any status, WITH a control: a broken read returns zero rows and reads as
    'no task', which is how duplicates get minted. The control is the Runpreneur tasks already on the board."""
    ctl = watch._airtable("GET", TASKS_API + "?maxRecords=1&fields%5B%5D=Task+Name&filterByFormula=" + urllib.parse.quote('FIND("Runpreneur",{Task Name})'))
    if not ctl.get("records"):
        raise SystemExit("approval: task read CONTROL failed (no task on the board mentions Runpreneur); creating nothing")
    q = '{Task Name}="%s"' % name.replace('"', '\\"')
    r = watch._airtable("GET", TASKS_API + "?maxRecords=1&fields%5B%5D=Task+Name&filterByFormula=" + urllib.parse.quote(q))
    recs = r.get("records", [])
    return recs[0]["id"] if recs else None


def append_note(rec, line):
    old = (rec.get("fields", {}).get("Notes") or "").strip()
    return ((old + "\n" + line).strip())[:2000]


def raise_card(day, dry_run=False):
    recs = bundle(day)
    full = recs["Long Form Video"]
    if not full: raise SystemExit("no Full record for episode %d" % day)
    headline = headline_for(day, watch.load_ledger())
    name, desc, out = build_card(day, full, recs["Learnings From My Diary"], recs["Short Form Video"], headline)
    state = load_state()
    if str(day) in state and state[str(day)].get("task"):
        print("episode %d already has card %s" % (day, state[str(day)]["task"])); return None
    if dry_run:
        print(out); return None
    tid = existing_task(name)
    if not tid:
        today = dt.date.today().isoformat()
        fields = {TF["name"]: name, TF["desc"]: desc, TF["status"]: "Today", TF["team"]: [AGENT_TM], TF["priority"]: "Medium",
                  TF["due"]: today, TF["business"]: [BUSINESS_PERSONAL],
                  TF["notes"]: "Raised by the Content Engine (360 lane) %s for episode record %s. Created with --force: the episode number is the identity and the duplicate key strips numbers." % (today, full["id"])}
        r = subprocess.run([sys.executable, GATE, "create", "--force", "--fields-json", json.dumps(fields)], capture_output=True, text=True)
        if r.returncode != 0: raise SystemExit("approval: task gate failed: " + (r.stderr or r.stdout)[-400:])
        tid = json.loads(r.stdout.strip().splitlines()[-1])["taskId"]
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as fh:
        fh.write(out); path = fh.name
    try:
        r = subprocess.run([sys.executable, DISPATCH, "submit", tid, "--agent", AGENT_TM, "--type", TASK_TYPE, "--output-file", path],
                           capture_output=True, text=True)
    finally:
        os.remove(path)
    if r.returncode != 0: raise SystemExit("approval: submit failed for %s: %s" % (tid, (r.stderr or r.stdout)[-400:]))
    stamp = dt.datetime.now().isoformat(timespec="seconds")
    watch._airtable("PATCH", watch.API + "/" + full["id"], {"fields": {"Record Status": STATUS_QC, "Notes": append_note(full, "Approval card %s raised %s." % (tid, stamp[:10]))}})
    state[str(day)] = {"task": tid, "record": full["id"], "raised": stamp, "name": name}
    save_state(state)
    print("episode %d -> approval card %s (%s)" % (day, tid, name))
    return tid


def refresh_card(day):
    """Rebuild the write-up from the records as they are now and re-submit it on the existing task, so a
    card in Kevin's queue shows corrected copy (4 Sep 2026: the distance figure and the X copy)."""
    state = load_state(); e = state.get(str(day))
    if not e or not e.get("task"): raise SystemExit("episode %d has no card to refresh" % day)
    recs = bundle(day); full = recs["Long Form Video"]
    name, desc, out = build_card(day, full, recs["Learnings From My Diary"], recs["Short Form Video"], headline_for(day, watch.load_ledger()))
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as fh:
        fh.write(out); path = fh.name
    try:
        r = subprocess.run([sys.executable, DISPATCH, "submit", e["task"], "--agent", AGENT_TM, "--type", TASK_TYPE, "--output-file", path], capture_output=True, text=True)
    finally:
        os.remove(path)
    if r.returncode != 0: raise SystemExit("approval: refresh failed for %s: %s" % (e["task"], (r.stderr or r.stdout)[-400:]))
    e["refreshed"] = dt.datetime.now().isoformat(timespec="seconds"); save_state(state)
    print("episode %d: card %s refreshed" % (day, e["task"]))


def sync():
    state = load_state()
    open_cards = {d: e for d, e in state.items() if e.get("task") and not e.get("verdict")}
    if not open_cards: print("approval sync: no open cards"); return
    for day, e in open_cards.items():
        t = watch._airtable("GET", TASKS_API + "/" + e["task"] + "?returnFieldsByFieldId=true")["fields"]
        outcome = t.get(TF["outcome"])
        if isinstance(outcome, dict): outcome = outcome.get("name")
        if not outcome:
            print("episode %s: card %s still waiting" % (day, e["task"])); continue
        patch, verdict = verdict_patch(outcome, t.get(TF["feedback"]), t.get(TF["approvedAt"]))
        rec = watch._airtable("GET", watch.API + "/" + e["record"])
        patch["Notes"] = append_note(rec, patch["Notes"])
        watch._airtable("PATCH", watch.API + "/" + e["record"], {"fields": patch})
        e.update({"verdict": verdict, "outcome": outcome, "feedback": (t.get(TF["feedback"]) or ""), "synced": dt.datetime.now().isoformat(timespec="seconds")})
        print("episode %s: %s (%s)" % (day, verdict, outcome))
    save_state(state)


def report():
    state = load_state()
    waiting = [d for d, e in state.items() if e.get("task") and not e.get("verdict")]
    approved = [d for d, e in state.items() if e.get("verdict") == "approved"]
    print("content approvals: %d card%s waiting for Kevin%s; %d approved and waiting for the publishing step" % (
        len(waiting), "" if len(waiting) == 1 else "s", (" (episodes " + ", ".join(sorted(waiting)) + ")") if waiting else "", len(approved)))


def selftest():
    full = {"id": "recF", "fields": {"Record Status": STATUS_READY, "Video Edited URL": "https://drive/full", "Thumbnail URL": "https://drive/thumb",
                                     "Reframed Video URL": "https://drive/lfmd", "Summary Video URL": "https://drive/sum",
                                     "YouTube Copy": "yt words", "Blog Copy": "blog words", "Notes": "copy written; review: Threads copy 512 chars"}}
    lfmd = {"id": "recL", "fields": {"LinkedIn Copy": "li words", "Threads Copy": "th words"}}
    short = {"id": "recS", "fields": {"Facebook Reels Copy": "fb words"}}
    assert is_ready(full["fields"]) and not is_ready({**full["fields"], "Thumbnail URL": ""}) and not is_ready({**full["fields"], "Record Status": "New Upload"})
    name, desc, out = build_card(2225, full, lfmd, short, "RECORD IT ONCE / AI WORKS FOREVER")
    assert name == 'CONTENT: Publish Episode 2225 of Diary of a Runpreneur - RECORD IT ONCE / AI WORKS FOREVER', name
    first = out.split("\n")[0]
    assert first.startswith('Publish Episode 2225 of Diary of a Runpreneur "RECORD IT ONCE / AI WORKS FOREVER": the full episode to YouTube'), first
    assert out.rstrip().split("\n")[-1].startswith(CLOSING), "must end with the closing line the queue reads"
    assert "UNLISTED" in closing_line("test") and "DRAFTS" in closing_line("test") and "06:00" in closing_line("live") and closing_line("live").startswith(CLOSING)
    for s in ("https://drive/full", "https://drive/lfmd", "https://drive/sum", "https://drive/thumb", "yt words", "blog words", "li words", "th words", "fb words",
              "Youtube Full Post", "Rules check flagged: Threads copy 512 chars", "Nothing reaches a public feed"):
        assert s in out, s
    assert "Nothing is published until you approve" in desc
    _, _, out2 = build_card(2226, {"id": "x", "fields": {"Video Edited URL": "u", "Thumbnail URL": "t", "YouTube Copy": "y"}})
    assert "no teaser clip was recorded" in out2 and "no clip" in out2 and "No copy written yet." in out2 and "nothing flagged" in out2
    assert task_name(2226) == "CONTENT: Publish Episode 2226 of Diary of a Runpreneur"
    assert headline_for(2225, {"a.insv": {"episode": 2225, "thumb_lines": ["KIDS CAN'T FIND", "WORK TRY THIS", "claude"]}}) == "KIDS CAN'T FIND / WORK TRY THIS"
    assert headline_for(2225, {"a.insv": {"episode": 2224}}) == ""
    p, v = verdict_patch("Approved as-is", "", "2026-09-04T08:10:00.000Z"); assert p["Record Status"] == STATUS_APPROVED and v == "approved" and "2026-09-04" in p["Notes"]
    p, v = verdict_patch("Rejected", "Not this one", None); assert v == "rejected" and p["Feedback"] == "Not this one" and "Record Status" not in p
    p, v = verdict_patch("Changes requested", "Shorter title", None); assert v == "changes" and p["Feedback"] == "Shorter title"
    assert TASK_TYPE == "Drafting"
    print(json.dumps({"checks": 15, "failed": []}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode"); ap.add_argument("--day", type=int, default=0); ap.add_argument("--pending", action="store_true")
    ap.add_argument("--limit", type=int, default=2); ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    if a.mode == "selftest": selftest()
    elif a.mode == "card": raise_card(a.day, dry_run=True)
    elif a.mode == "run":
        days = pending(a.limit) if a.pending else ([a.day] if a.day else [])
        if not days: print("approval: nothing ready for a card")
        for d in days: raise_card(d, dry_run=a.dry_run)
    elif a.mode == "sync": sync()
    elif a.mode == "refresh": refresh_card(a.day)
    elif a.mode == "report": report()
    else: raise SystemExit("usage: approval.py run --pending [--limit N] [--dry-run] | run --day N | card --day N | refresh --day N | sync | report | selftest")
